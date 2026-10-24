use super::*;

fn guidance(author: &CapturedTeamAuthor, recipient: &TeamExecutionMember) -> SendHumanTeamMessage {
    SendHumanTeamMessage {
        message_id: ExecutionId::new(),
        recipient_member_id: recipient.member_id,
        expected_recipient_role_version_id: recipient.role_version_id,
        target: author.target().clone(),
        body: "Preserve the human decision and explain any remaining disagreement.".into(),
    }
}

fn page(plan: &WorkPlan) -> ReadTeamExecution {
    ReadTeamExecution {
        project_id: plan.project_id,
        plan_id: plan.plan_id,
        after_work: None,
        after_message: None,
        limit: MAX_TEAM_PAGE,
    }
}

fn capture(
    request: &DispatchRequest,
    view: &CapturedTeamWorkView,
) -> ai::provider::ProviderRequestCapture {
    let settings = ai::team::settings(&request.input).unwrap();
    let mut body = serde_json::json!({"model":settings.config.model,"stream":true,"messages":[{"role":"user","content":view.utf8()}]});
    body[&settings.config.token_field] = settings.config.max_output_tokens.into();
    ai::provider::ProviderRequestCapture {
        body: body.to_string(),
        team_view: None,
        team_work_view: Some(view.view().clone()),
    }
}

#[test]
fn team_human_messages_bind_original_scope_limits_and_stopped_history() {
    let (_temp, mut store, plan, receipt, prepared, _request, author, members) = setup(12);
    let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
    let limits = TeamMessageLimits::current_team();
    let initial_budget = store.provider_budget(prepared.receipt().task_id).unwrap();
    let mut write = guidance(&author, &members[0]);
    assert_eq!(
        store
            .read_human_team_message_action(plan.project_id, &receipt.lease, "local-user", &write)
            .unwrap(),
        None,
    );
    for key in [
        "actor",
        "human",
        "callerId",
        "lease",
        "postIds",
        "causeMessageId",
    ] {
        let mut input = serde_json::to_value(&write).unwrap();
        input[key] = serde_json::Value::Null;
        assert!(serde_json::from_value::<SendHumanTeamMessage>(input).is_err());
    }
    let mut oversized = write.clone();
    oversized.body = "界".repeat((limits.max_body_bytes as usize / 3) + 1);
    assert!(oversized.body.len() > limits.max_body_bytes as usize);
    assert!(
        store
            .send_human_team_message(&scope, "local-user", &oversized)
            .is_err()
    );
    let mut empty = write.clone();
    empty.body = " \n\t".into();
    assert!(
        store
            .send_human_team_message(&scope, "local-user", &empty)
            .is_err()
    );
    let mut wrong = write.clone();
    wrong.expected_recipient_role_version_id = ExecutionId::new();
    assert!(
        store
            .send_human_team_message(&scope, "local-user", &wrong)
            .is_err()
    );
    wrong = write.clone();
    wrong.recipient_member_id = ExecutionId::new();
    assert!(
        store
            .send_human_team_message(&scope, "local-user", &wrong)
            .is_err()
    );
    for target in [
        TeamDiscussionTarget {
            unit_id: ExecutionId::new(),
            ..write.target.clone()
        },
        TeamDiscussionTarget {
            locale: "de-DE".into(),
            ..write.target.clone()
        },
        TeamDiscussionTarget {
            source_snapshot_id: ExecutionId::new(),
            ..write.target.clone()
        },
        TeamDiscussionTarget {
            source_revision_id: ExecutionId::new(),
            ..write.target.clone()
        },
    ] {
        wrong = write.clone();
        wrong.target = target;
        assert!(
            store
                .send_human_team_message(&scope, "local-user", &wrong)
                .is_err()
        );
    }
    assert!(
        store
            .send_human_team_message(author.scope(), "local-user", &write)
            .is_err()
    );

    // A legitimate ordinary grant cannot acquire the team's message effect.
    let ordinary = store
        .prepare_work_plan(
            Some(config()),
            "zh-CN",
            &members[0].unit_ids,
            PlanOptions::default(),
        )
        .unwrap();
    let ordinary_receipt = store
        .authorize_work_plan(&ordinary, &consent(&ordinary))
        .unwrap();
    store
        .enqueue_execution(&FixedInput::capture(ordinary_receipt.input.unwrap()).unwrap())
        .unwrap();
    let ordinary_scope = store.work_plan_agent_scope(ordinary_receipt.lease).unwrap();
    assert!(
        store
            .send_human_team_message(&ordinary_scope, "local-user", &write)
            .is_err()
    );

    write.body = "界".repeat(limits.max_body_bytes as usize / 3);
    write
        .body
        .push_str(&"x".repeat(limits.max_body_bytes as usize - write.body.len()));
    assert_eq!(write.body.len(), limits.max_body_bytes as usize);
    let accepted = store
        .send_human_team_message(&scope, "local-user", &write)
        .unwrap();
    assert_eq!(
        accepted.sender,
        TeamDiscussionAuthor::Human {
            actor: "local-user".into(),
            binding: scope.execution_binding(),
        }
    );
    assert!(accepted.post_ids.is_empty());
    assert_eq!(accepted.cause_message_id, None);
    assert_eq!(accepted.sender.binding(), &scope.execution_binding());
    assert_eq!(
        store
            .send_human_team_message(&scope, "local-user", &write)
            .unwrap(),
        accepted
    );
    for changed in [
        SendHumanTeamMessage {
            body: format!("{}!", write.body),
            ..write.clone()
        },
        SendHumanTeamMessage {
            expected_recipient_role_version_id: ExecutionId::new(),
            ..write.clone()
        },
        SendHumanTeamMessage {
            recipient_member_id: members[1].member_id,
            ..write.clone()
        },
    ] {
        assert_eq!(
            store
                .read_human_team_message_action(
                    plan.project_id,
                    &receipt.lease,
                    "local-user",
                    &changed
                )
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
    }
    assert_eq!(
        store
            .read_human_team_message_action(plan.project_id, &receipt.lease, "another-user", &write)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    assert!(
        store
            .read_human_team_message_action(
                ExecutionId::new(),
                &receipt.lease,
                "local-user",
                &write
            )
            .is_err()
    );
    let wrong_lease = AutomationLease {
        generation: Revision::new(receipt.lease.generation.get() + 1).unwrap(),
        ..receipt.lease
    };
    assert_eq!(
        store
            .read_human_team_message_action(plan.project_id, &wrong_lease, "local-user", &write)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let other_plan_lease = AutomationLease {
        plan_id: ordinary.plan_id,
        ..receipt.lease
    };
    assert_eq!(
        store
            .read_human_team_message_action(
                plan.project_id,
                &other_plan_lease,
                "local-user",
                &write
            )
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );

    for index in 1..limits.max_messages {
        let mut next = guidance(&author, &members[0]);
        if index < 4 {
            next.body = write.body.clone();
        }
        store
            .send_human_team_message(&scope, "local-user", &next)
            .unwrap();
        if index == 3 {
            // Four individually valid bodies exceed the complete request-view cap.
            assert_eq!(
                store.capture_team_work_view(&author).unwrap_err().code,
                ErrorCode::LimitExceeded
            );
        }
    }
    assert_eq!(
        store
            .send_human_team_message(&scope, "local-user", &guidance(&author, &members[0]))
            .unwrap_err()
            .stage,
        "team-messages"
    );
    assert_eq!(
        store.capture_team_work_view(&author).unwrap_err().stage,
        "team-request-material"
    );
    let read = page(&plan);
    let visible = store.read_team_execution(&read).unwrap();
    assert_eq!(visible.message_limits, limits);
    assert_eq!(visible.messages.len(), MAX_TEAM_PAGE as usize);
    assert_eq!(visible.messages[0], accepted);
    assert!(visible.consumptions.is_empty());
    assert_eq!(visible.works.len(), 1);
    assert_eq!(
        store.provider_budget(prepared.receipt().task_id).unwrap(),
        initial_budget
    );
    assert_eq!(
        store
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM application_team_messages WHERE plan_id=?1",
                [plan.plan_id.to_string()],
                |r| r.get::<_, u32>(0),
            )
            .unwrap(),
        limits.max_messages
    );

    crate::persistence::review::tests::adopt_source(
        &mut store,
        br#"{"replacement":"Changed source"}"#,
    );
    let error = store
        .send_human_team_message(&scope, "local-user", &guidance(&author, &members[0]))
        .unwrap_err();
    assert_eq!(error.stage, "team-basis");
    assert_eq!(
        store
            .read_human_team_message_action(plan.project_id, &receipt.lease, "local-user", &write)
            .unwrap(),
        Some(accepted.clone())
    );
    store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: plan.plan_id,
            expected_generation: receipt.lease.generation,
            command: WorkPlanCommand::Stop,
            confirmed: false,
            expires_at: None,
        })
        .unwrap();
    assert_eq!(
        store
            .send_human_team_message(&scope, "local-user", &write)
            .unwrap(),
        accepted
    );
    assert!(
        store
            .send_human_team_message(&scope, "local-user", &guidance(&author, &members[0]))
            .is_err()
    );
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&directory).unwrap();
    let before = reopened.connection().unwrap().total_changes();
    assert_eq!(
        reopened
            .read_human_team_message_action(plan.project_id, &receipt.lease, "local-user", &write)
            .unwrap(),
        Some(accepted.clone())
    );
    assert_eq!(
        reopened
            .send_human_team_message(&scope, "local-user", &write)
            .unwrap(),
        accepted
    );
    assert_eq!(
        reopened.read_team_execution(&read).unwrap().messages[0],
        accepted
    );
    let missing = guidance(&author, &members[0]);
    assert_eq!(
        reopened
            .read_human_team_message_action(plan.project_id, &receipt.lease, "local-user", &missing)
            .unwrap(),
        None
    );
    assert_eq!(reopened.connection().unwrap().total_changes(), before);
    assert!(
        reopened
            .send_human_team_message(&scope, "local-user", &missing)
            .is_err()
    );
    assert_eq!(
        reopened
            .provider_budget(prepared.receipt().task_id)
            .unwrap(),
        initial_budget
    );
}

#[test]
fn team_human_messages_freeze_consumption_budget_and_validate_causal_predecessors() {
    let (_temp, mut store, plan, receipt, prepared, root, translator, members) =
        setup_with_budget(3, 3);
    let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
    let requested = work_request(&translator, members[1].member_id);
    let child = store.prepare_team_work(&translator, &requested).unwrap();
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
    reserve(&mut store, &root, &translator).unwrap();
    let frozen = store.capture_team_work_view(&reviewer).unwrap();
    let frozen_bytes = frozen.utf8().to_owned();
    let settings = ai::team::settings(&request.input).unwrap();
    let first_request_id = ExecutionId::new();
    let first_capture = capture(&request, &frozen);
    store
        .reserve_provider_request_capture(
            &request,
            first_request_id,
            settings.config.max_requests,
            Some(&first_capture),
        )
        .unwrap();
    assert!(frozen.view().messages.is_empty());
    let write = guidance(&reviewer, &members[1]);
    let accepted = store
        .send_human_team_message(&scope, "local-user", &write)
        .unwrap();
    let mut reply = SendTeamMessage {
        message_id: ExecutionId::new(),
        recipient_member_id: members[0].member_id,
        target: reviewer.target().clone(),
        body: "Retain the human's reason for this review.".into(),
        post_ids: vec![],
        cause_message_id: Some(accepted.message_id),
    };
    assert!(store.send_team_message(&translator, &reply).is_err());
    reply.cause_message_id = Some(ExecutionId::new());
    assert!(store.send_team_message(&reviewer, &reply).is_err());
    reply.cause_message_id = Some(accepted.message_id);
    let response = store.send_team_message(&reviewer, &reply).unwrap();
    let member_as_human = SendHumanTeamMessage {
        message_id: response.message_id,
        recipient_member_id: response.recipient_member_id,
        expected_recipient_role_version_id: response.recipient_role_version_id,
        target: response.target.clone(),
        body: response.body.clone(),
    };
    assert_eq!(
        store
            .read_human_team_message_action(
                plan.project_id,
                &receipt.lease,
                "local-user",
                &member_as_human
            )
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    message_history(store.connection().unwrap(), &response).unwrap();
    let later_write = guidance(&reviewer, &members[1]);
    let later = store
        .send_human_team_message(&scope, "local-user", &later_write)
        .unwrap();
    assert!(later.sequence > response.sequence);
    let mut premature = response.clone();
    premature.cause_message_id = Some(later.message_id);
    assert!(message_history(store.connection().unwrap(), &premature).is_err());

    let mut follow = work_request(&reviewer, members[0].member_id);
    follow.kind = TeamWorkKind::Translation;
    follow.cause_message_id = Some(accepted.message_id);
    store.prepare_team_work(&reviewer, &follow).unwrap();
    let mut not_received = work_request(&translator, members[1].member_id);
    not_received.cause_message_id = Some(accepted.message_id);
    assert!(store.prepare_team_work(&translator, &not_received).is_err());
    let read = page(&plan);
    let before = store.read_team_execution(&read).unwrap();
    assert!(before.consumptions.is_empty());
    assert_eq!(before.works.len(), 2);
    assert_eq!(before.budget.as_ref().unwrap().dispatched, 2);
    assert_eq!(frozen.utf8(), frozen_bytes);
    let next = store.capture_team_work_view(&reviewer).unwrap();
    assert_eq!(next.view().messages, vec![accepted.clone(), later.clone()]);
    let capture = capture(&request, &next);
    let encoded = codec::encode(&capture, 131072).unwrap();
    assert_eq!(
        codec::decode::<ai::provider::ProviderRequestCapture>(&encoded, 131072).unwrap(),
        capture
    );
    let second_request_id = ExecutionId::new();
    store
        .reserve_provider_request_capture(
            &request,
            second_request_id,
            settings.config.max_requests,
            Some(&capture),
        )
        .unwrap();
    let after = store.read_team_execution(&read).unwrap();
    assert_eq!(after.budget.as_ref().unwrap().dispatched, 3);
    assert_eq!(after.budget.as_ref().unwrap().unresolved, 3);
    for message in [&accepted, &later] {
        assert!(after.consumptions.contains(&TeamMessageConsumption {
            message_id: message.message_id,
            task_id: child.receipt().task_id,
            provider_request_id: second_request_id,
        }));
    }
    assert!(
        after
            .consumptions
            .iter()
            .all(|value| value.provider_request_id != first_request_id)
    );
    assert!(
        store
            .capture_team_work_view(&reviewer)
            .unwrap()
            .view()
            .messages
            .is_empty()
    );
    assert_eq!(
        store
            .send_human_team_message(&scope, "local-user", &guidance(&reviewer, &members[1]))
            .unwrap_err()
            .stage,
        "team-guidance-budget-exhausted"
    );
    assert_eq!(
        store
            .send_human_team_message(&scope, "local-user", &write)
            .unwrap(),
        accepted
    );
    store.check_team_work_author(&reviewer).unwrap();
    store
        .settle_provider_request(&request, second_request_id, None)
        .unwrap();
    assert_eq!(
        store
            .provider_budget(prepared.receipt().task_id)
            .unwrap()
            .unwrap()
            .dispatched,
        3
    );
    let bytes: Vec<u8> = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT capture FROM execution_provider_requests WHERE request_id=?1",
            [first_request_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    let original: ai::provider::ProviderRequestCapture = codec::decode(&bytes, 131072).unwrap();
    assert_eq!(original, first_capture);
    assert!(original.team_work_view.unwrap().messages.is_empty());
    validate(store.connection().unwrap()).unwrap();
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    assert_eq!(
        reopened.read_team_execution(&read).unwrap().messages.len(),
        3
    );

    // Recompute the record digest so this tests causal provenance, not byte corruption.
    let bytes = codec::encode(&premature, MAX_MESSAGE_RECORD).unwrap();
    reopened
        .connection()
        .unwrap()
        .execute(
            "UPDATE application_team_messages SET record=?1,digest=?2 WHERE message_id=?3",
            params![
                bytes,
                codec::digest(&bytes),
                response.message_id.to_string()
            ],
        )
        .unwrap();
    assert!(reopened.read_team_execution(&read).is_err());
    reopened.close().unwrap();
    assert!(ProjectStore::open(&directory).is_err());
}
