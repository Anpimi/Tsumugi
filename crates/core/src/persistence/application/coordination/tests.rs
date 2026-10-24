use super::*;
use crate::persistence::application::tests::{config, consent, fixture};

mod human_guidance;

fn setup(
    no_progress: u32,
) -> (
    tempfile::TempDir,
    ProjectStore,
    WorkPlan,
    WorkPlanReceipt,
    PreparedTeamWork,
    DispatchRequest,
    CapturedTeamAuthor,
    Vec<TeamExecutionMember>,
) {
    setup_with_budget(no_progress, 20)
}
fn setup_with_budget(
    no_progress: u32,
    root_limit: u32,
) -> (
    tempfile::TempDir,
    ProjectStore,
    WorkPlan,
    WorkPlanReceipt,
    PreparedTeamWork,
    DispatchRequest,
    CapturedTeamAuthor,
    Vec<TeamExecutionMember>,
) {
    let (temp, mut store, units) = fixture();
    let mut root = config();
    root.max_requests = root_limit;
    root.concurrency = 2;
    let mut a = root.clone();
    a.max_requests = 1;
    a.share_terms = false;
    a.share_context = false;
    let mut b = a.clone();
    b.max_requests = 4.min(root_limit);
    b.endpoint = "http://127.0.0.1:21902/v1/chat/completions".into();
    b.model = "independent-review".into();
    let members = vec![
        TeamExecutionMember {
            member_id: ExecutionId::new(),
            role_version_id: ExecutionId::new(),
            display_name: "Translator".into(),
            role: "Translate, request review, and retain original reasons.".into(),
            config: a,
            unit_ids: units.clone(),
            tool_handles: vec![],
            kinds: vec![TeamWorkKind::Translation],
        },
        TeamExecutionMember {
            member_id: ExecutionId::new(),
            role_version_id: ExecutionId::new(),
            display_name: "Reviewer".into(),
            role: "Review the exact published proposal and cite reasons.".into(),
            config: b,
            unit_ids: units.clone(),
            tool_handles: vec![],
            kinds: vec![TeamWorkKind::Review, TeamWorkKind::Evidence],
        },
    ];
    let mut options = PlanOptions::default();
    options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV2 {});
    options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 {
        initial_member_id: members[0].member_id,
        initial_unit_id: units[0],
        members: members.clone(),
        limits: TeamExecutionLimits {
            max_activations: 12.min(root_limit),
            max_concurrency: 2,
            max_no_progress: no_progress,
        },
    });
    let plan = store
        .prepare_work_plan(Some(root), "zh-CN", &units, options)
        .unwrap();
    let mut permission = consent(&plan);
    permission.effects = plan.authorization_effects().unwrap();
    let receipt = store.authorize_work_plan(&plan, &permission).unwrap();
    let prepared = store
        .prepare_team_root(receipt.lease, permission.action_id)
        .unwrap();
    assert_eq!(prepared.input().envelope().operation, ai::team::OPERATION);
    assert_eq!(prepared.input().envelope().items.len(), 1);
    assert!(
        store
            .provider_budget(plan.execution_input().unwrap().task_id)
            .unwrap()
            .is_none()
    );
    store
        .enqueue_team_work(&prepared, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    let request = store
        .dispatch_execution_item(
            prepared.receipt().attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap();
    let author = store.capture_team_work_author(&request).unwrap();
    (
        temp, store, plan, receipt, prepared, request, author, members,
    )
}
fn work_request(author: &CapturedTeamAuthor, recipient: ExecutionId) -> RequestTeamWork {
    RequestTeamWork {
        intent_id: ExecutionId::new(),
        recipient_member_id: recipient,
        target: author.target().clone(),
        kind: TeamWorkKind::Review,
        instructions: "Review the original proposal without changing any human decision.".into(),
        post_ids: vec![],
        cause_message_id: None,
    }
}
fn reserve(
    store: &mut ProjectStore,
    request: &DispatchRequest,
    author: &CapturedTeamAuthor,
) -> Result<ExecutionId, ExecutionError> {
    let view = store.capture_team_work_view(author)?;
    let settings = ai::team::settings(&request.input)?;
    let mut body = serde_json::json!({"model":settings.config.model,"stream":true,"messages":[{"role":"user","content":view.utf8()}]});
    body[&settings.config.token_field] = settings.config.max_output_tokens.into();
    let capture = ai::provider::ProviderRequestCapture {
        body: body.to_string(),
        team_view: None,
        team_work_view: Some(view.view().clone()),
    };
    let id = ExecutionId::new();
    let limit = if settings.binding.is_root() {
        settings.root_request_limit
    } else {
        settings.config.max_requests
    };
    store.reserve_provider_request_capture(request, id, limit, Some(&capture))?;
    Ok(id)
}
fn result(request: &DispatchRequest, outcome: TeamWorkOutcome) -> FixedResult {
    let output = TeamWorkOutput {
        outcome,
        usage: None,
        requests: 1,
        usage_incomplete: true,
    };
    FixedResult::capture(
        ResultEnvelope {
            project_id: request.input.envelope().project_id,
            attempt_id: request.input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: request.input.envelope().capability_id.clone(),
            capability_version: "1".into(),
            plugin: None,
            outcome: ExecutionState::Succeeded,
            output: Some(serde_json::to_value(output).unwrap()),
            diagnostic: None,
        },
        &request.input,
        request.dispatch_token,
    )
    .unwrap()
}

#[test]
fn team_coordination_root_budget_parent_and_consumption_are_original_facts() {
    let (_temp, mut store, plan, _receipt, prepared, root, author, members) = setup(3);
    let preview = plan.team_member_previews().unwrap();
    assert_eq!(preview.len(), 2);
    assert_eq!(preview[1].preview.config, members[1].config);
    assert!(preview[0].preview.items[0].terms.is_empty());
    assert_eq!(
        store
            .provider_budget(prepared.receipt().task_id)
            .unwrap()
            .unwrap()
            .limit,
        20
    );
    assert!(ai::settings(&root.input).is_err());
    let message = store
        .send_team_message(
            &author,
            &SendTeamMessage {
                message_id: ExecutionId::new(),
                recipient_member_id: members[1].member_id,
                target: author.target().clone(),
                body: "Preserve the entire original reason 👩🏽‍💻.".into(),
                post_ids: vec![],
                cause_message_id: None,
            },
        )
        .unwrap();
    let read = ReadTeamExecution {
        project_id: plan.project_id,
        plan_id: plan.plan_id,
        after_work: None,
        after_message: None,
        limit: 16,
    };
    assert!(
        store
            .read_team_execution(&read)
            .unwrap()
            .consumptions
            .is_empty()
    );
    let work = work_request(&author, members[1].member_id);
    let child = store.prepare_team_work(&author, &work).unwrap();
    validate_provider_parent_in(store.connection().unwrap(), child.input(), &root.input).unwrap();
    let mut altered = child.input().envelope().clone();
    altered.settings["config"]["endpoint"] = "http://127.0.0.1:21903/v1/chat/completions".into();
    let altered = FixedInput::capture(altered).unwrap();
    assert!(
        validate_provider_parent_in(store.connection().unwrap(), &altered, &root.input).is_err()
    );
    let mut altered = child.input().envelope().clone();
    altered.items[0].payload["sourceText"] = "unprepared source".into();
    let altered = FixedInput::capture(altered).unwrap();
    assert!(
        validate_provider_parent_in(store.connection().unwrap(), &altered, &root.input).is_err()
    );
    assert_eq!(
        store.enqueue_execution(child.input()).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    store
        .enqueue_team_work(&child, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    assert_eq!(
        store.prepare_team_work(&author, &work).unwrap().receipt(),
        child.receipt()
    );
    let mut changed = work.clone();
    changed.instructions.push('!');
    assert_eq!(
        store.prepare_team_work(&author, &changed).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    let child_request = store
        .dispatch_execution_item(
            child.receipt().attempt_id,
            child.input().envelope().items[0].item_id,
        )
        .unwrap();
    let reviewer = store.capture_team_work_author(&child_request).unwrap();
    let root_request_id = reserve(&mut store, &root, &author).unwrap();
    assert_eq!(
        reserve(&mut store, &root, &author).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    let child_request_id = reserve(&mut store, &child_request, &reviewer).unwrap();
    assert_ne!(root_request_id, child_request_id);
    let page = store.read_team_execution(&read).unwrap();
    assert_eq!(page.budget.as_ref().unwrap().limit, 20);
    assert_eq!(page.budget.as_ref().unwrap().dispatched, 2);
    assert_eq!(page.budget.as_ref().unwrap().unresolved, 2);
    assert_eq!(
        page.consumptions,
        vec![TeamMessageConsumption {
            message_id: message.message_id,
            task_id: child.receipt().task_id,
            provider_request_id: child_request_id
        }]
    );
    let captured = store.capture_team_work_view(&reviewer).unwrap();
    assert!(captured.view().messages.is_empty());
    let mut capture=ai::provider::ProviderRequestCapture{body:serde_json::json!({"model":members[1].config.model,"stream":true,"max_tokens":members[1].config.max_output_tokens,"messages":[{"role":"user","content":"missing frozen view"}]}).to_string(),team_view:None,team_work_view:Some(captured.view().clone())};
    assert!(
        store
            .reserve_provider_request_capture(
                &child_request,
                ExecutionId::new(),
                members[1].config.max_requests,
                Some(&capture)
            )
            .is_err()
    );
    capture.team_view = Some(captured.view().discussion.clone());
    assert!(
        store
            .reserve_provider_request_capture(
                &child_request,
                ExecutionId::new(),
                members[1].config.max_requests,
                Some(&capture)
            )
            .is_err()
    );
    assert!(
        store
            .prepare_work_plan_agent_generation(
                author.scope(),
                &AgentGenerationRequest {
                    task_id: ExecutionId::new(),
                    attempt_id: ExecutionId::new(),
                    unit_ids: vec![author.target().unit_id]
                }
            )
            .is_err()
    );
    assert!(
        store
            .delegate_work_plan_agent_scope(
                author.scope(),
                &AgentDelegationRequest {
                    delegation_id: ExecutionId::new(),
                    unit_ids: vec![author.target().unit_id],
                    tool_handles: vec![]
                }
            )
            .is_err()
    );
}

#[test]
fn team_coordination_typed_waiting_no_progress_and_paused_history_do_not_restore_authority() {
    let (_temp, mut store, plan, receipt, _prepared, request, author, members) = setup(1);
    let work = work_request(&author, members[1].member_id);
    let child = store.prepare_team_work(&author, &work).unwrap();
    store
        .enqueue_team_work(&child, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    reserve(&mut store, &request, &author).unwrap();
    let seed = ai::team::TeamWorkSeed::capture(&request).unwrap();
    let waiting = serde_json::to_string(&TeamWorkOutcome::Waiting {
        requested_intent_ids: vec![work.intent_id],
    })
    .unwrap();
    assert!(seed.validate_output(&waiting, None, 0, true).is_err());
    assert!(
        seed.validate_output(
            &waiting,
            Some(ai::Usage {
                prompt_tokens: 0,
                completion_tokens: u64::from(seed.config().max_output_tokens) + 1,
                cache_read_tokens: None,
                cache_write_tokens: None,
                reasoning_tokens: None,
            }),
            1,
            false
        )
        .is_err()
    );
    let unrelated = result(
        &request,
        TeamWorkOutcome::Waiting {
            requested_intent_ids: vec![ExecutionId::new()],
        },
    );
    assert!(validate_result(store.connection().unwrap(), &request.input, &unrelated).is_err());
    let output = result(
        &request,
        TeamWorkOutcome::Waiting {
            requested_intent_ids: vec![work.intent_id],
        },
    );
    store.save_execution_result(&output).unwrap();
    store
        .validate_execution_result(output.envelope().attempt_id, output.envelope().result_id)
        .unwrap();
    let read = ReadTeamExecution {
        project_id: plan.project_id,
        plan_id: plan.plan_id,
        after_work: None,
        after_message: None,
        limit: 16,
    };
    let page = store.read_team_execution(&read).unwrap();
    assert_eq!(page.stop_reason, Some(TeamStopReason::NoProgress));
    assert!(page.works.iter().all(|w| w.candidate_revision_id.is_none()));
    assert!(
        store
            .dispatch_execution_item(
                child.receipt().attempt_id,
                child.input().envelope().items[0].item_id
            )
            .is_err()
    );
    let paused = store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: plan.plan_id,
            expected_generation: receipt.lease.generation,
            command: WorkPlanCommand::Pause,
            confirmed: false,
            expires_at: None,
        })
        .unwrap();
    let error = store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: plan.plan_id,
            expected_generation: paused.lease.generation,
            command: WorkPlanCommand::Continue,
            confirmed: true,
            expires_at: Some(consent(&plan).expires_at),
        })
        .unwrap_err();
    assert_eq!(error.stage, "team-continue-requires-new-plan");
    assert!(store.capture_team_work_view(&author).is_err());
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    assert_eq!(
        reopened.team_work_receipt(work.intent_id).unwrap(),
        Some(child.receipt().clone())
    );
    assert!(reopened.check_team_work_author(&author).is_err());
    assert_eq!(reopened.read_team_execution(&read).unwrap().works.len(), 2);
}

#[test]
fn team_coordination_inbox_filters_target_before_material_cap() {
    let (_temp, mut store, plan, _receipt, _prepared, _root, translator, members) = setup(3);
    let other_basis = plan
        .selection_basis
        .iter()
        .find(|basis| basis.unit_id != translator.target().unit_id)
        .unwrap();
    let other_target = TeamDiscussionTarget {
        unit_id: other_basis.unit_id,
        locale: plan.locale.clone(),
        source_snapshot_id: other_basis.source_snapshot_id,
        source_revision_id: other_basis.source_revision_id,
    };
    let mut work = work_request(&translator, members[1].member_id);
    work.target = other_target.clone();
    let child = store.prepare_team_work(&translator, &work).unwrap();
    store
        .enqueue_team_work(&child, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    let request = store
        .dispatch_execution_item(
            child.receipt().attempt_id,
            child.input().envelope().items[0].item_id,
        )
        .unwrap();
    let reviewer = store.capture_team_work_author(&request).unwrap();
    assert_eq!(reviewer.target(), &other_target);
    for _ in 0..17 {
        store
            .send_team_message(
                &reviewer,
                &SendTeamMessage {
                    message_id: ExecutionId::new(),
                    recipient_member_id: members[0].member_id,
                    target: other_target.clone(),
                    body: "This message belongs to the other authorized item.".into(),
                    post_ids: vec![],
                    cause_message_id: None,
                },
            )
            .unwrap();
    }
    let relevant = store
        .send_team_message(
            &reviewer,
            &SendTeamMessage {
                message_id: ExecutionId::new(),
                recipient_member_id: members[0].member_id,
                target: translator.target().clone(),
                body: "The original item has a complete, separately addressed message.".into(),
                post_ids: vec![],
                cause_message_id: None,
            },
        )
        .unwrap();
    let captured = store.capture_team_work_view(&translator).unwrap();
    assert_eq!(captured.view().messages, vec![relevant]);
    assert_eq!(captured.view().discussion.target, *translator.target());

    // A recipient must also be allowed to receive the sender's current item.
    let mut restricted = plan.clone();
    let Some(TeamExecutionPolicy::BoundedTeamV1 { members, .. }) =
        restricted.options.team_execution.as_mut()
    else {
        unreachable!()
    };
    members[0]
        .unit_ids
        .retain(|unit| *unit != other_target.unit_id);
    let recipient = members[0].member_id;
    assert!(
        routing_target(
            &restricted,
            reviewer.author(),
            reviewer.target(),
            recipient,
            translator.target(),
        )
        .is_err()
    );
    assert!(
        store
            .read_team_execution(&ReadTeamExecution {
                project_id: plan.project_id,
                plan_id: plan.plan_id,
                after_work: None,
                after_message: None,
                limit: 16,
            })
            .unwrap()
            .consumptions
            .is_empty()
    );
}

#[test]
fn team_coordination_invalid_output_and_exhausted_budget_preserve_history() {
    let (_temp, mut store, plan, receipt, _prepared, root, author, members) =
        setup_with_budget(1, 3);
    let work = work_request(&author, members[1].member_id);
    let child = store.prepare_team_work(&author, &work).unwrap();
    store
        .enqueue_team_work(&child, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    let child_request = store
        .dispatch_execution_item(
            child.receipt().attempt_id,
            child.input().envelope().items[0].item_id,
        )
        .unwrap();
    let reviewer = store.capture_team_work_author(&child_request).unwrap();
    reserve(&mut store, &child_request, &reviewer).unwrap();
    reserve(&mut store, &child_request, &reviewer).unwrap();
    let invalid = result(
        &child_request,
        TeamWorkOutcome::Review {
            reviewed: TeamReviewBasis::Post {
                post_id: ExecutionId::new(),
            },
            post_ids: vec![ExecutionId::new()],
            verdict: TeamReviewVerdict::Revise,
        },
    );
    let mut envelope = invalid.envelope().clone();
    envelope.output.as_mut().unwrap()["requests"] = 2.into();
    let invalid =
        FixedResult::capture(envelope, &child_request.input, child_request.dispatch_token).unwrap();
    assert!(ai::team::validate_output(&child_request.input, &invalid).is_ok());
    store.save_execution_result(&invalid).unwrap();
    assert!(
        store
            .validate_execution_result(invalid.envelope().attempt_id, invalid.envelope().result_id)
            .is_err()
    );
    let read = ReadTeamExecution {
        project_id: plan.project_id,
        plan_id: plan.plan_id,
        after_work: None,
        after_message: None,
        limit: 16,
    };
    let page = store.read_team_execution(&read).unwrap();
    assert_eq!(page.stop_reason, None);
    let rejected = &page.works[1];
    assert_eq!(rejected.execution, ExecutionState::Succeeded);
    assert_eq!(rejected.validation, ValidationState::Invalid);
    assert!(rejected.output.is_none());
    assert!(rejected.candidate_revision_id.is_none());

    reserve(&mut store, &root, &author).unwrap();
    store.check_team_work_author(&author).unwrap();
    let new_work = work_request(&author, members[1].member_id);
    assert_eq!(
        store
            .prepare_team_work(&author, &new_work)
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let final_result = result(
        &root,
        TeamWorkOutcome::Translation {
            unit_id: author.target().unit_id,
            target_locale: author.target().locale.clone(),
            text: "A complete translation from the final authorized request.".into(),
        },
    );
    store.save_execution_result(&final_result).unwrap();
    store
        .validate_execution_result(
            final_result.envelope().attempt_id,
            final_result.envelope().result_id,
        )
        .unwrap();
    let page = store.read_team_execution(&read).unwrap();
    assert_eq!(page.stop_reason, Some(TeamStopReason::BudgetExhausted));
    assert_eq!(page.budget.as_ref().unwrap().dispatched, 3);
    assert_eq!(page.budget.as_ref().unwrap().unresolved, 3);
    assert_eq!(page.works[0].validation, ValidationState::Valid);
    assert!(page.works[0].output.is_some());
    assert!(
        page.works
            .iter()
            .all(|work| work.candidate_revision_id.is_none())
    );
    store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: plan.plan_id,
            expected_generation: receipt.lease.generation,
            command: WorkPlanCommand::Pause,
            confirmed: false,
            expires_at: None,
        })
        .unwrap();
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    let page = reopened.read_team_execution(&read).unwrap();
    assert_eq!(page.works[1].validation, ValidationState::Invalid);
    assert!(page.works[1].output.is_none());
    assert_eq!(
        reopened
            .execution_result(child.receipt().attempt_id, invalid.envelope().result_id)
            .unwrap()
            .bytes(),
        invalid.bytes()
    );
    assert!(reopened.check_team_work_author(&author).is_err());

    let (_temp, mut store, plan, _receipt, _prepared, request, author, _members) = setup(3);
    let invalid = result(
        &request,
        TeamWorkOutcome::Translation {
            unit_id: author.target().unit_id,
            target_locale: author.target().locale.clone(),
            text: String::new(),
        },
    );
    let mut envelope = invalid.envelope().clone();
    envelope.output.as_mut().unwrap()["requests"] = 0.into();
    let invalid = FixedResult::capture(envelope, &request.input, request.dispatch_token).unwrap();
    store.save_execution_result(&invalid).unwrap();
    assert!(
        store
            .validate_execution_result(invalid.envelope().attempt_id, invalid.envelope().result_id)
            .is_err()
    );
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    let page = reopened
        .read_team_execution(&ReadTeamExecution {
            project_id: plan.project_id,
            plan_id: plan.plan_id,
            after_work: None,
            after_message: None,
            limit: 16,
        })
        .unwrap();
    assert_eq!(page.works[0].validation, ValidationState::Invalid);
    assert!(page.works[0].output.is_none());
    assert!(page.works[0].candidate_revision_id.is_none());
    assert_eq!(
        reopened
            .execution_result(
                request.input.envelope().attempt_id,
                invalid.envelope().result_id
            )
            .unwrap()
            .bytes(),
        invalid.bytes()
    );
}

#[test]
fn team_coordination_new_text_and_reference_ids_do_not_reset_unconfirmed_completions() {
    let dispatch = |store: &mut ProjectStore, author: &CapturedTeamAuthor, recipient, kind| {
        let mut request = work_request(author, recipient);
        request.kind = kind;
        let prepared = store.prepare_team_work(author, &request).unwrap();
        store
            .enqueue_team_work(&prepared, RecoveryPolicy::ExternalUnknown)
            .unwrap();
        let request = store
            .dispatch_execution_item(
                prepared.receipt().attempt_id,
                prepared.input().envelope().items[0].item_id,
            )
            .unwrap();
        let captured = store.capture_team_work_author(&request).unwrap();
        (request, captured)
    };
    let finish = |store: &mut ProjectStore,
                  request: &DispatchRequest,
                  author: &CapturedTeamAuthor,
                  outcome| {
        reserve(store, request, author).unwrap();
        let output = result(request, outcome);
        store.save_execution_result(&output).unwrap();
        store
            .validate_execution_result(output.envelope().attempt_id, output.envelope().result_id)
            .unwrap();
    };
    let (_temp, mut store, plan, _receipt, _prepared, root, translator, members) = setup(2);
    let (_review, reviewer) = dispatch(
        &mut store,
        &translator,
        members[1].member_id,
        TeamWorkKind::Review,
    );
    let mut request = work_request(&reviewer, members[0].member_id);
    request.kind = TeamWorkKind::Translation;
    let revision = store.prepare_team_work(&reviewer, &request).unwrap();
    store
        .enqueue_team_work(&revision, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    finish(
        &mut store,
        &root,
        &translator,
        TeamWorkOutcome::Translation {
            unit_id: translator.target().unit_id,
            target_locale: translator.target().locale.clone(),
            text: "A candidate".into(),
        },
    );
    assert_eq!(
        stop_reason(store.connection().unwrap(), &plan).unwrap(),
        None
    );
    let request = store
        .dispatch_execution_item(
            revision.receipt().attempt_id,
            revision.input().envelope().items[0].item_id,
        )
        .unwrap();
    let reviser = store.capture_team_work_author(&request).unwrap();
    finish(
        &mut store,
        &request,
        &reviser,
        TeamWorkOutcome::Translation {
            unit_id: reviser.target().unit_id,
            target_locale: reviser.target().locale.clone(),
            text: "A candidate.".into(),
        },
    );
    assert_eq!(
        stop_reason(store.connection().unwrap(), &plan).unwrap(),
        Some(TeamStopReason::NoProgress)
    );
    let failure = store.check_team_work_author(&reviewer).unwrap_err();
    assert_eq!(failure.code, ErrorCode::Cancelled);
    assert_eq!(failure.stage, "team-stopped");

    let (_temp, mut store, plan, _receipt, _prepared, _root, translator, members) = setup(2);
    let mut revisions = Vec::new();
    for _ in 0..2 {
        let current = store
            .translation_history(
                plan.project_id,
                translator.target().unit_id,
                &translator.target().locale,
                0,
                1,
            )
            .unwrap()
            .current;
        revisions.push(
            store
                .save_translation_revision(&crate::SaveTranslationRevision {
                    project_id: plan.project_id,
                    action_id: ExecutionId::new(),
                    unit_id: translator.target().unit_id,
                    locale: translator.target().locale.clone(),
                    source_revision_id: translator.target().source_revision_id,
                    expected_selection_id: current.map(|selection| selection.event_id),
                    text: "The same original evidence body.".into(),
                })
                .unwrap()
                .revision_id,
        );
    }
    assert_ne!(revisions[0], revisions[1]);
    for (index, revision_id) in revisions.into_iter().enumerate() {
        let (request, author) = dispatch(
            &mut store,
            &translator,
            members[1].member_id,
            TeamWorkKind::Evidence,
        );
        let publication = store
            .publish_team_discussion(
                &author,
                &PublishTeamDiscussion {
                    post_id: ExecutionId::new(),
                    target: author.target().clone(),
                    kind: TeamDiscussionKind::Note,
                    body: "The cited original body has been checked.".into(),
                    references: vec![TeamArtifactReference::TranslationRevision { revision_id }],
                    reply_to: None,
                    supersedes: None,
                },
            )
            .unwrap();
        finish(
            &mut store,
            &request,
            &author,
            TeamWorkOutcome::Evidence {
                post_ids: vec![publication.publication.post_id],
            },
        );
        assert_eq!(
            stop_reason(store.connection().unwrap(), &plan).unwrap(),
            (index == 1).then_some(TeamStopReason::NoProgress)
        );
    }
    assert!(
        store
            .prepare_team_work(
                &translator,
                &work_request(&translator, members[1].member_id)
            )
            .is_err()
    );
}
