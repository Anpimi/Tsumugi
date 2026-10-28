use super::*;
use crate::{
    application::*,
    execution::{
        Cancellation, DispatchRequest, ExecutionRuntime, ExecutionState, FixedResult,
        ResultEnvelope, ResultSender, Runner,
    },
    persistence::{
        DATABASE_FILENAME, SCHEMA_VERSION,
        application::tests::{consent, fixture},
    },
};
use std::{
    collections::BTreeMap,
    process::Command,
    sync::{Arc, Barrier, atomic::Ordering},
    time::Duration,
};

struct NeverRun(&'static str);
impl Runner for NeverRun {
    fn capability_id(&self) -> &str {
        conversation_planning::CAPABILITY
    }
    fn capability_version(&self) -> &str {
        self.0
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("proposal fixture must not dispatch a producer")
    }
}
pub(super) fn model(unit: ExecutionId) -> ConversationPlanningModelOutput {
    ConversationPlanningModelOutput::Proposal {
        summary: "  Translate these entries 👩🏽‍💻  ".into(),
        unit_ids: vec![unit],
        options: PlanOptions::default(),
        questions: vec![],
    }
}
pub(super) fn completed(
    store: &mut ProjectStore,
    units: &[ExecutionId],
    output: ConversationPlanningModelOutput,
    validated: bool,
) -> CaptureConversationProposal {
    completed_profile(store,units,output,validated,None)
}
pub(super) fn completed_profile(store:&mut ProjectStore,units:&[ExecutionId],output:ConversationPlanningModelOutput,validated:bool,purpose:Option<ConversationPlanningPurpose>)->CaptureConversationProposal {
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let thread = ExecutionId::new();
    store
        .create_project_conversation(&CreateProjectConversation {
            project_id: project,
            action_id: ExecutionId::new(),
            conversation_id: thread,
            title: None,
        })
        .unwrap();
    let message = ExecutionId::new();
    store
        .append_project_conversation_message(&AppendProjectConversationMessage {
            project_id: project,
            action_id: ExecutionId::new(),
            conversation_id: thread,
            message_id: message,
            body: "  Please plan {{name}}  ".into(),
        })
        .unwrap();
    let capture = store
        .prepare_conversation_planning(&PrepareConversationPlanning {
            purpose,
            project_id: project,
            conversation_id: thread,
            selected_message_ids: vec![message],
            scope: ConversationPlanningScope::Units {
                locale: "zh-CN".into(),
                unit_ids: units.to_vec(),
            },
            config: crate::ai::AiConfig {
                max_requests: 1,
                max_retries: 0,
                concurrency: 1,
                ..crate::persistence::application::tests::config()
            },
        })
        .unwrap();
    let attempt = ExecutionId::new();
    let prepared = store
        .authorize_conversation_planning(
            &capture,
            &ConversationPlanningConsent {
                action_id: attempt,
                task_id: ExecutionId::new(),
                attempt_id: attempt,
                preview_digest: capture.preview_digest().unwrap(),
                expires_at_ms: (crate::execution::plugin_authority::plugin_now_ms().unwrap()
                    + 30_000)
                    .into(),
                share_messages: true,
                share_units: true,
            },
        )
        .unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register(Arc::new(NeverRun(conversation_planning::profile(purpose).0))).unwrap();
    runtime
        .submit_conversation_planning(store, &prepared)
        .unwrap();
    let dispatch = store.dispatch_execution_item(attempt, attempt).unwrap();
    let result=FixedResult::capture(ResultEnvelope {
        project_id:project,attempt_id:attempt,item_id:attempt,result_id:ExecutionId::new(),supersedes:None,
        dispatch_token:dispatch.dispatch_token,capability_id:conversation_planning::CAPABILITY.into(),capability_version:conversation_planning::profile(purpose).0.into(),plugin:None,
        outcome:ExecutionState::Succeeded,output:Some(serde_json::json!({"model":output,"usage":null,"requests":1,"usageIncomplete":true})),diagnostic:None,
    },prepared.input(),dispatch.dispatch_token).unwrap();
    store.save_execution_result(&result).unwrap();
    if validated {
        store
            .validate_execution_result(attempt, result.envelope().result_id)
            .unwrap();
    }
    CaptureConversationProposal {
        project_id: project,
        conversation_id: thread,
        action_id: ExecutionId::new(),
        proposal_id: ExecutionId::new(),
        revision_id: ExecutionId::new(),
        attempt_id: attempt,
        result_id: result.envelope().result_id,
    }
}
pub(super) fn revise(
    r: &CaptureConversationProposal,
    expected: ExecutionId,
    unit: ExecutionId,
) -> ReviseConversationProposal {
    ReviseConversationProposal {
        project_id: r.project_id,
        conversation_id: r.conversation_id,
        action_id: ExecutionId::new(),
        proposal_id: r.proposal_id,
        revision_id: ExecutionId::new(),
        expected_revision_id: expected,
        content: model(unit),
    }
}
fn rows(c: &Connection, version: i64) -> BTreeMap<String, Vec<Vec<rusqlite::types::Value>>> {
    let names=c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    names
        .into_iter()
        .filter(|name| {
            if version == 61 {
                !name.starts_with("application_conversation")
            } else {
                name != "application_conversation_proposals" && name != "application_conversation_work_plans"
                    && name != "application_conversation_planning_attempts"
            }
        })
        .map(|name| {
            let mut q = c
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let count = q.column_count();
            let values = q
                .query_map([], |r| {
                    (0..count)
                        .map(|i| r.get(i))
                        .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (name, values)
        })
        .collect()
}

#[test]
fn proposal_versions_bind_original_result_and_recover_without_authority() {
    let (_temp, mut store, units) = fixture();
    let r = completed(&mut store, &units[..1], model(units[0]), true);
    let before = rows(store.connection().unwrap(), 61);
    let first = store.capture_conversation_proposal(&r).unwrap();
    assert_eq!(first.revision.get(), 1);
    assert_eq!(first.ordinal.get(), 1);
    assert_eq!(first.content, model(units[0]));
    assert_eq!(store.capture_conversation_proposal(&r).unwrap(), first);
    let mut edit = revise(&r, first.revision_id, units[0]);
    if let ConversationPlanningModelOutput::Proposal {
        summary, questions, ..
    } = &mut edit.content
    {
        *summary = "  User revised purpose e\u{301}  ".into();
        questions.push("Which wording should we use?".into());
    }
    let second = store.revise_conversation_proposal(&edit).unwrap();
    assert_eq!(second.revision.get(), 2);
    assert_eq!(second.previous_revision_id, Some(first.revision_id));
    assert_eq!(second.origin, first.origin);
    assert_eq!(store.capture_conversation_proposal(&r).unwrap(), first);
    assert_eq!(store.revise_conversation_proposal(&edit).unwrap(), second);
    assert_eq!(
        store
            .validate_conversation_proposal(
                r.project_id,
                r.conversation_id,
                r.proposal_id,
                first.revision_id
            )
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    let stale = revise(&r, first.revision_id, units[0]);
    assert_eq!(
        store
            .revise_conversation_proposal(&stale)
            .unwrap_err()
            .stage,
        "conversation-proposal-head"
    );
    let mut mismatch = edit.clone();
    mismatch.content = model(units[0]);
    assert!(matches!(
        store
            .recover_conversation_proposal_revision(&mismatch)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Mismatch {}
    ));
    let writes = store.connection().unwrap().total_changes();
    let permits = store.conversation_planning_permits.len();
    assert_eq!(
        store
            .validate_conversation_proposal(
                r.project_id,
                r.conversation_id,
                r.proposal_id,
                second.revision_id
            )
            .unwrap(),
        second
    );
    assert_eq!(
        store
            .read_conversation_proposal(r.project_id, r.conversation_id, r.proposal_id, None)
            .unwrap(),
        second
    );
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    assert_eq!(store.conversation_planning_permits.len(), permits);
    assert_eq!(rows(store.connection().unwrap(), 61), before);
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    assert!(reopened.conversation_planning_permits.is_empty());
    assert_eq!(
        reopened
            .read_conversation_proposal(
                r.project_id,
                r.conversation_id,
                r.proposal_id,
                Some(first.revision_id)
            )
            .unwrap(),
        first
    );
    assert!(
        matches!(reopened.recover_conversation_proposal_capture(&r).unwrap().outcome,ConversationActionOutcome::Recorded { receipt } if receipt==first)
    );
    assert!(
        matches!(reopened.recover_conversation_proposal_revision(&edit).unwrap().outcome,ConversationActionOutcome::Recorded { receipt } if receipt==second)
    );
    reopened
        .validate_conversation_proposal(
            r.project_id,
            r.conversation_id,
            r.proposal_id,
            second.revision_id,
        )
        .unwrap();
    assert!(reopened.conversation_planning_permits.is_empty());
    assert_eq!(rows(reopened.connection().unwrap(), 61), before);
    let mut json = serde_json::to_value(first).unwrap();
    json.as_object_mut().unwrap().remove("previousRevisionId");
    assert!(serde_json::from_value::<ConversationProposalRevision>(json).is_err());
}

#[test]
fn proposal_rejects_fabricated_unvalidated_reply_and_out_of_scope_origins() {
    let (_temp, mut store, units) = fixture();
    let pending = completed(&mut store, &units[..1], model(units[0]), false);
    assert_eq!(
        store
            .capture_conversation_proposal(&pending)
            .unwrap_err()
            .code,
        ErrorCode::OutputInvalid
    );
    let reply = completed(
        &mut store,
        &units[..1],
        ConversationPlanningModelOutput::Reply {
            summary: "An explanation".into(),
            questions: vec![],
        },
        true,
    );
    assert_eq!(
        store
            .capture_conversation_proposal(&reply)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    let r = completed(&mut store, &units[..1], model(units[0]), true);
    let wrong = CaptureConversationProposal {
        result_id: reply.result_id,
        ..r.clone()
    };
    assert!(store.capture_conversation_proposal(&wrong).is_err());
    let cross = CaptureConversationProposal {
        conversation_id: reply.conversation_id,
        ..r.clone()
    };
    assert_eq!(
        store
            .capture_conversation_proposal(&cross)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let first = store.capture_conversation_proposal(&r).unwrap();
    let mut edit = revise(&r, first.revision_id, ExecutionId::new());
    assert_eq!(
        store.revise_conversation_proposal(&edit).unwrap_err().code,
        ErrorCode::OutputInvalid
    );
    edit.content = ConversationPlanningModelOutput::Reply {
        summary: "No plan".into(),
        questions: vec![],
    };
    assert_eq!(
        store.revise_conversation_proposal(&edit).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        store
            .read_conversation_proposal_revisions(r.project_id, r.conversation_id, None, 50)
            .unwrap()
            .rows
            .len(),
        1
    );
}

#[test]
fn proposal_currentness_tracks_material_and_protection_but_keeps_history() {
    let (_temp, mut store, units) = fixture();
    let r = completed(&mut store, &units[..1], model(units[0]), true);
    let first = store.capture_conversation_proposal(&r).unwrap();
    let metadata = store.metadata().unwrap();
    store
        .rename(metadata.metadata_revision(), "Unrelated project rename")
        .unwrap();
    store
        .append_project_conversation_message(&AppendProjectConversationMessage {
            project_id: r.project_id,
            action_id: ExecutionId::new(),
            conversation_id: r.conversation_id,
            message_id: ExecutionId::new(),
            body: "Unselected later message".into(),
        })
        .unwrap();
    if units.len() > 1 {
        crate::persistence::review::tests::translate(
            &mut store,
            r.project_id,
            units[1],
            "zh-CN",
            "Unrelated translation",
        );
    }
    store
        .validate_conversation_proposal(
            r.project_id,
            r.conversation_id,
            r.proposal_id,
            first.revision_id,
        )
        .unwrap();
    crate::persistence::review::tests::translate(
        &mut store,
        r.project_id,
        units[0],
        "zh-CN",
        "New human work",
    );
    assert_eq!(
        store
            .validate_conversation_proposal(
                r.project_id,
                r.conversation_id,
                r.proposal_id,
                first.revision_id
            )
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(
        store
            .revise_conversation_proposal(&revise(&r, first.revision_id, units[0]))
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(store.capture_conversation_proposal(&r).unwrap(), first);
    assert_eq!(
        store
            .read_conversation_proposal(r.project_id, r.conversation_id, r.proposal_id, None)
            .unwrap(),
        first
    );
    let next = completed(&mut store, &units[..1], model(units[0]), true);
    let protected = store.capture_conversation_proposal(&next).unwrap();
    let mut edit = revise(&next, protected.revision_id, units[0]);
    if let ConversationPlanningModelOutput::Proposal { options, .. } = &mut edit.content {
        options.selection_policy = SelectionPolicy::ReplaceCapturedSelection;
        options.stages.push(StageChoice {
            stage: WorkStage::Checks,
            mode: StageMode::Assisted,
        });
        // Replace the existing manual checks stage, preserving the original option contract.
        options.stages.retain(|choice| {
            choice.stage != WorkStage::Checks || choice.mode == StageMode::Assisted
        });
    }
    assert_eq!(
        store.revise_conversation_proposal(&edit).unwrap_err().code,
        ErrorCode::OutputInvalid
    );
}

#[test]
fn proposal_unknown_recovery_validates_history_before_reconciliation() {
    let (_temp, mut store, units) = fixture();
    let r = completed(&mut store, &units[..1], model(units[0]), true);
    let first = store.capture_conversation_proposal(&r).unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    let mut mismatch = r.clone();
    mismatch.proposal_id = ExecutionId::new();
    assert!(matches!(
        store
            .recover_conversation_proposal_capture(&mismatch)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Mismatch {}
    ));
    assert!(store.is_reconciling());
    let bad = CaptureConversationProposal {
        action_id: ExecutionId::new(),
        result_id: ExecutionId::new(),
        ..r.clone()
    };
    assert!(store.recover_conversation_proposal_capture(&bad).is_err());
    assert!(store.is_reconciling());
    assert!(
        matches!(store.recover_conversation_proposal_capture(&r).unwrap().outcome,ConversationActionOutcome::Recorded { receipt } if receipt==first)
    );
    assert!(!store.is_reconciling());
    let edit = revise(&r, first.revision_id, units[0]);
    let reader = Connection::open(store.directory().join(DATABASE_FILENAME)).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM application_conversation_proposals;")
        .unwrap();
    store
        .connection()
        .unwrap()
        .busy_timeout(Duration::from_millis(20))
        .unwrap();
    assert_eq!(
        store.revise_conversation_proposal(&edit).unwrap_err().code,
        ErrorCode::OutcomeUnknown
    );
    assert!(store.is_reconciling());
    reader.execute_batch("ROLLBACK").unwrap();
    assert!(matches!(
        store
            .recover_conversation_proposal_revision(&edit)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Pending {
            replay: ConversationActionReplay::ExplicitSameRequest
        }
    ));
    let second = store.revise_conversation_proposal(&edit).unwrap();
    let c = store.connection().unwrap();
    c.execute(
        "UPDATE application_conversation_proposals SET digest=?2 WHERE revision_id=?1",
        params![second.revision_id.to_string(), "0".repeat(64)],
    )
    .unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    assert!(store.recover_conversation_proposal_capture(&r).is_err());
    assert!(store.is_reconciling());
}

#[test]
fn proposal_feed_is_complete_byte_bounded_and_ordered() {
    let (_temp, mut store, units) = fixture();
    let r = completed(&mut store, &units[..1], model(units[0]), true);
    let mut all = vec![store.capture_conversation_proposal(&r).unwrap()];
    for _ in 0..12 {
        let mut edit = revise(&r, all.last().unwrap().revision_id, units[0]);
        if let ConversationPlanningModelOutput::Proposal {
            summary, questions, ..
        } = &mut edit.content
        {
            *summary = "界".repeat(2600);
            *questions = (0..8).map(|_| "x".repeat(2048)).collect();
        }
        all.push(store.revise_conversation_proposal(&edit).unwrap());
    }
    let mut seen = vec![];
    let mut after = None;
    loop {
        let page = store
            .read_conversation_proposal_revisions(r.project_id, r.conversation_id, after, 50)
            .unwrap();
        assert!(codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES).is_ok());
        assert!(!page.rows.is_empty());
        after = page.next_after;
        seen.extend(page.rows);
        if after.is_none() {
            break;
        }
    }
    assert_eq!(seen, all);
    for limit in [0, 51] {
        assert_eq!(
            store
                .read_conversation_proposal_revisions(r.project_id, r.conversation_id, None, limit)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
}

#[test]
fn proposal_concurrent_revision_cas_commits_one_successor() {
    let (temp, mut store, units) = fixture();
    let r = completed(&mut store, &units[..1], model(units[0]), true);
    let first = store.capture_conversation_proposal(&r).unwrap();
    let path = store.directory().to_path_buf();
    let mut second =
        ProjectStore::create(temp.path().join("second-owner"), store.metadata().unwrap()).unwrap();
    second.connection = Some(Connection::open(path.join(DATABASE_FILENAME)).unwrap());
    // The production Store registers the ledger's chunk reader on every open.
    // This isolated second connection must use that same storage reader.
    ledger::register_input_reader(second.connection().unwrap()).unwrap();
    second
        .connection()
        .unwrap()
        .busy_timeout(Duration::from_secs(2))
        .unwrap();
    second
        .connection()
        .unwrap()
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let run = |store: ProjectStore, barrier: Arc<Barrier>, edit: ReviseConversationProposal| {
        std::thread::spawn(move || {
            barrier.wait();
            let value = store.revise_conversation_proposal(&edit);
            store.close().unwrap();
            value
        })
    };
    let a = run(
        store,
        barrier.clone(),
        revise(&r, first.revision_id, units[0]),
    );
    let b = run(second, barrier, revise(&r, first.revision_id, units[0]));
    let results = [a.join().unwrap(), b.join().unwrap()];
    assert_eq!(results.iter().filter(|v| v.is_ok()).count(), 1);
    assert_eq!(
        results.iter().find_map(|v| v.as_ref().err()).unwrap().code,
        ErrorCode::DependencyConflict,
        "unexpected concurrent outcomes: {results:?}"
    );
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .read_conversation_proposal_revisions(r.project_id, r.conversation_id, None, 50)
            .unwrap()
            .rows
            .len(),
        2
    );
}

#[test]
fn proposal_migration_child() {
    let Ok(path) = std::env::var("TSUMUGI_PROPOSAL_MIGRATION_PROJECT") else {
        return;
    };
    ProjectStore::open(path).unwrap();
    panic!("migration did not reach its crash hook");
}

#[test]
fn proposal_migration_preserves_supported_history_across_abort_boundaries() {
    for version in [61, 62] {
        for point in [
            "conversation-before-ddl",
            "conversation-after-ddl",
            "conversation-before-commit",
            "conversation-after-commit",
        ] {
            let (temp, mut store, units) = fixture();
            let mut options = PlanOptions::default();
            options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV1 {});
            let plan = store
                .prepare_work_plan(
                    Some(crate::persistence::application::tests::config()),
                    "zh-CN",
                    &units,
                    options,
                )
                .unwrap();
            let mut authorization = consent(&plan);
            authorization.effects = plan.authorization_effects().unwrap();
            let receipt = store.authorize_work_plan(&plan, &authorization).unwrap();
            store
                .enqueue_execution(&FixedInput::capture(receipt.input.clone().unwrap()).unwrap())
                .unwrap();
            let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
            let basis = &plan.selection_basis[0];
            let discussion = store
                .publish_human_team_discussion(
                    &scope,
                    "local-user",
                    &PublishTeamDiscussion {
                        post_id: ExecutionId::new(),
                        target: TeamDiscussionTarget {
                            unit_id: basis.unit_id,
                            locale: plan.locale.clone(),
                            source_snapshot_id: basis.source_snapshot_id,
                            source_revision_id: basis.source_revision_id,
                        },
                        kind: TeamDiscussionKind::Note,
                        body: "Retained original discussion 👩🏽‍💻".into(),
                        references: vec![],
                        reply_to: None,
                        supersedes: None,
                    },
                )
                .unwrap();
            let thread = if version == 62 {
                Some(completed(&mut store, &units[..1], model(units[0]), true))
            } else {
                None
            };
            let before = rows(store.connection().unwrap(), version);
            let path = store.directory().to_path_buf();
            store.close().unwrap();
            let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
            c.execute_batch("DROP TABLE application_conversation_planning_attempts; DROP TABLE application_conversation_work_plans; DROP TABLE application_conversation_proposals")
                .unwrap();
            if version == 61 {
                c.execute_batch("DROP TABLE application_conversation_actions; DROP TABLE application_conversation_messages; DROP TABLE application_conversations;").unwrap();
            }
            c.pragma_update(None, "user_version", version).unwrap();
            drop(c);
            let marker = temp.path().join("migration-marker");
            let output=Command::new(std::env::current_exe().unwrap()).args(["--exact","persistence::application::conversations::proposals::tests::proposal_migration_child","--nocapture"])
            .env("TSUMUGI_PROPOSAL_MIGRATION_PROJECT",&path).env("TSUMUGI_MIGRATION_CRASH",point).env("TSUMUGI_MIGRATION_HOOK",&marker).output().unwrap();
            assert!(!output.status.success());
            assert_eq!(std::fs::read_to_string(marker).unwrap(), point);
            let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
            let found: i64 = c
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .unwrap();
            assert_eq!(
                found,
                if point == "conversation-after-commit" {
                    SCHEMA_VERSION
                } else {
                    version
                }
            );
            assert_eq!(rows(&c, version), before);
            drop(c);
            let reopened = ProjectStore::open(path).unwrap();
            assert_eq!(rows(reopened.connection().unwrap(), version), before);
            assert_eq!(reopened.work_plan(plan.plan_id).unwrap(), plan);
            assert_eq!(
                reopened.work_plan_receipt(authorization.action_id).unwrap(),
                Some(receipt)
            );
            assert_eq!(
                reopened
                    .read_team_history_post(
                        plan.project_id,
                        plan.plan_id,
                        discussion.publication.post_id
                    )
                    .unwrap(),
                discussion
            );
            if let Some(thread) = thread {
                reopened
                    .read_project_conversation(thread.project_id, thread.conversation_id)
                    .unwrap();
            }
        }
    }
}
