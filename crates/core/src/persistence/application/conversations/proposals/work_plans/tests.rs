use super::super::tests::{completed, model, revise};
use super::*;
use crate::{
    application::*,
    persistence::{
        DATABASE_FILENAME, SCHEMA_VERSION,
        application::tests::{config, consent, fixture},
    },
};
use std::{
    process::Command,
    sync::{Arc, Barrier, atomic::Ordering},
    time::Duration,
};

fn setup() -> (
    tempfile::TempDir,
    ProjectStore,
    CaptureConversationProposal,
    PreparedConversationProposalWorkPlan,
    AuthorizeConversationProposalWorkPlan,
) {
    let (temp, mut store, units) = fixture();
    let capture = completed(&mut store, &units[..1], model(units[0]), true);
    let revision = store.capture_conversation_proposal(&capture).unwrap();
    let reference = ConversationProposalRef {
        project_id: capture.project_id,
        conversation_id: capture.conversation_id,
        proposal_id: capture.proposal_id,
        revision_id: revision.revision_id,
    };
    let prepared = prepare(&store, &reference);
    let request = authorization(&store, &prepared);
    (temp, store, capture, prepared, request)
}
fn prepare(
    store: &ProjectStore,
    reference: &ConversationProposalRef,
) -> PreparedConversationProposalWorkPlan {
    let revision = store
        .read_conversation_proposal(
            reference.project_id,
            reference.conversation_id,
            reference.proposal_id,
            Some(reference.revision_id),
        )
        .unwrap();
    let ConversationPlanningModelOutput::Proposal {
        unit_ids, options, ..
    } = revision.content
    else {
        panic!()
    };
    // A later human WorkPlan preview chooses its own finite execution budget.
    let plan = store
        .prepare_work_plan(
            Some(crate::ai::AiConfig {
                max_requests: 3,
                ..config()
            }),
            "zh-CN",
            &unit_ids,
            options,
        )
        .unwrap();
    store
        .capture_conversation_proposal_work_plan(reference, plan)
        .unwrap()
}
fn authorization(
    store: &ProjectStore,
    prepared: &PreparedConversationProposalWorkPlan,
) -> AuthorizeConversationProposalWorkPlan {
    let plan = prepared.plan();
    let inner = consent(plan);
    AuthorizeConversationProposalWorkPlan {
        action_id: inner.action_id,
        proposal: prepared.proposal().clone(),
        plan_id: plan.plan_id,
        plan_digest: plan.digest.clone(),
        confirmed: true,
        effects: plan.authorization_effects().unwrap(),
        expires_at: inner.expires_at.into(),
        checker_executions: store
            .work_plan_review_checkers(plan)
            .unwrap()
            .into_iter()
            .map(|checker| checker.key)
            .collect(),
        tool_execution: false,
        application_tool_executions: vec![],
    }
}
fn count(c: &Connection, table: &str) -> i64 {
    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn confirmed_link_is_atomic_small_exact_and_uses_original_authority() {
    let (_temp, mut store, _capture, prepared, r) = setup();
    let before = store.connection().unwrap().total_changes();
    let before_attempts = count(store.connection().unwrap(), "execution_attempts");
    store
        .validate_conversation_proposal_work_plan(&prepared)
        .unwrap();
    assert_eq!(store.connection().unwrap().total_changes(), before);
    assert_eq!(count(store.connection().unwrap(), "application_plans"), 0);
    let link = store
        .authorize_conversation_proposal_work_plan(&prepared, &r)
        .unwrap();
    assert_eq!(link.plan_id, r.plan_id);
    assert_eq!(link.revision_id, r.proposal.revision_id);
    assert_eq!(link.ordinal.get(), 1);
    let receipt = store.work_plan_receipt(r.action_id).unwrap().unwrap();
    assert_eq!(receipt.lease.plan_id, link.plan_id);
    assert_eq!(store.work_plan(link.plan_id).unwrap(), *prepared.plan());
    let execution = crate::ai::settings(&prepared.plan().fixed_input().unwrap()).unwrap();
    assert_eq!(execution.config.max_requests, 3);
    let counts = (
        count(store.connection().unwrap(), "application_plans"),
        count(store.connection().unwrap(), "application_actions"),
        count(
            store.connection().unwrap(),
            "application_conversation_work_plans",
        ),
    );
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &r)
            .unwrap(),
        link
    );
    assert_eq!(counts, (1, 1, 1));
    assert_eq!(
        count(store.connection().unwrap(), "execution_attempts"),
        before_attempts,
        "confirmation does not enqueue"
    );
    assert!(
        store
            .is_conversation_proposal_work_plan(r.proposal.project_id, link.plan_id)
            .unwrap()
    );
    assert_eq!(
        store
            .authorize_work_plan(prepared.plan(), &inner(&r))
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut other = r.clone();
    other.action_id = ExecutionId::new();
    assert!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &other)
            .is_err()
    );
    let raw: Vec<u8> = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT receipt FROM application_conversation_actions WHERE action_id=?1",
            [r.action_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(raw.len() < 4096);
    assert!(!String::from_utf8(raw).unwrap().contains("\"input\""));
    assert_eq!(
        store
            .read_conversation_proposal_work_plan(
                r.proposal.project_id,
                r.proposal.conversation_id,
                r.plan_id
            )
            .unwrap(),
        link
    );
}

#[test]
fn old_prepared_version_and_unresolved_or_changed_mapping_cannot_authorize() {
    let (_temp, mut store, capture, prepared, r) = setup();
    let unit = prepared.plan().selection_basis[0].unit_id;
    let mut questions = revise(&capture, capture.revision_id, unit);
    if let ConversationPlanningModelOutput::Proposal { questions, .. } = &mut questions.content {
        questions.push("Which audience?".into());
    }
    let next = store.revise_conversation_proposal(&questions).unwrap();
    assert_eq!(
        store
            .validate_conversation_proposal_work_plan(&prepared)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &r)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    let reference = ConversationProposalRef {
        revision_id: next.revision_id,
        ..r.proposal.clone()
    };
    assert_eq!(
        store
            .capture_conversation_proposal_work_plan(&reference, prepared.plan().clone())
            .unwrap_err()
            .stage,
        "conversation-proposal-questions"
    );
    let resolved = store
        .revise_conversation_proposal(&revise(&capture, next.revision_id, unit))
        .unwrap();
    let reference = ConversationProposalRef {
        revision_id: resolved.revision_id,
        ..reference
    };
    let mut wrong = prepared.plan().options.clone();
    wrong.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV1 {});
    let different = store
        .prepare_work_plan(Some(config()), "zh-CN", &[unit], wrong)
        .unwrap();
    assert_eq!(
        store
            .capture_conversation_proposal_work_plan(&reference, different)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let now = prepare(&store, &reference);
    let accepted = authorization(&store, &now);
    store
        .authorize_conversation_proposal_work_plan(&now, &accepted)
        .unwrap();
    assert_eq!(count(store.connection().unwrap(), "application_plans"), 1);
}

#[test]
fn every_confirmation_field_is_exact_and_related_material_is_checked_at_commit() {
    let (_temp, mut store, _capture, prepared, r) = setup();
    let mut no = r.clone();
    no.confirmed = false;
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &no)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut tools = r.clone();
    tools.tool_execution = true;
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &tools)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut application = r.clone();
    application
        .application_tool_executions
        .push(crate::execution::ApplicationScopeBasis {
            instance_id: ExecutionId::new(),
            activation_generation: 1,
        });
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &application)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut effects = r.clone();
    effects.effects.clear();
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &effects)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let metadata = store.metadata().unwrap();
    store
        .rename(metadata.metadata_revision(), "Unrelated name")
        .unwrap();
    store
        .validate_conversation_proposal_work_plan(&prepared)
        .unwrap();
    let unit = prepared.plan().selection_basis[0].unit_id;
    crate::persistence::review::tests::translate(
        &mut store,
        r.proposal.project_id,
        unit,
        "zh-CN",
        "Human changed this entry",
    );
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &r)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(count(store.connection().unwrap(), "application_plans"), 0);
}

#[test]
fn one_revision_can_create_multiple_explicit_independent_plans_and_feed() {
    let (_temp, mut store, capture, prepared, r) = setup();
    let first = store
        .authorize_conversation_proposal_work_plan(&prepared, &r)
        .unwrap();
    let other = prepare(&store, &r.proposal);
    let confirmation = authorization(&store, &other);
    let second = store
        .authorize_conversation_proposal_work_plan(&other, &confirmation)
        .unwrap();
    assert_eq!(first.revision_id, second.revision_id);
    assert_ne!(first.plan_id, second.plan_id);
    let a = store.work_plan_receipt(r.action_id).unwrap().unwrap();
    let b = store
        .work_plan_receipt(confirmation.action_id)
        .unwrap()
        .unwrap();
    assert_ne!(a.input.unwrap().task_id, b.input.unwrap().task_id);
    let page = store
        .read_conversation_proposal_work_plans(
            r.proposal.project_id,
            r.proposal.conversation_id,
            None,
            1,
        )
        .unwrap();
    assert_eq!(page.rows, vec![first.clone()]);
    assert_eq!(page.next_after, Some(first.ordinal));
    let page = store
        .read_conversation_proposal_work_plans(
            r.proposal.project_id,
            r.proposal.conversation_id,
            page.next_after,
            50,
        )
        .unwrap();
    assert_eq!(page.rows, vec![second]);
    assert!(page.next_after.is_none());
    let unit = prepared.plan().selection_basis[0].unit_id;
    store
        .revise_conversation_proposal(&revise(&capture, capture.revision_id, unit))
        .unwrap();
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &r)
            .unwrap(),
        first
    );
    assert_eq!(
        store.work_plan_status(first.plan_id).unwrap().state,
        WorkPlanState::Active
    );
}

#[test]
fn lost_response_reopen_and_outer_mismatch_never_restore_or_reconcile_wrong_authority() {
    let (_temp, mut store, _capture, prepared, r) = setup();
    let link = store
        .authorize_conversation_proposal_work_plan(&prepared, &r)
        .unwrap();
    let before = store.work_plan_receipt(r.action_id).unwrap().unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    for change in 0..4 {
        let mut wrong = r.clone();
        match change {
            0 => wrong.proposal.revision_id = ExecutionId::new(),
            1 => wrong.tool_execution = true,
            2 => wrong.checker_executions.push(crate::ReviewCheckerKey {
                provider: tsumugi_plugin_sdk::ProviderSelectionBinding {
                    plugin: tsumugi_plugin_sdk::PluginIdentity {
                        publisher: "synthetic".into(),
                        id: "checker".into(),
                        version: "1.0.0".into(),
                    },
                    component_id: "checker".into(),
                    contribution_id: "checker".into(),
                    package_digest: "1".repeat(64),
                },
                profile: tsumugi_plugin_sdk::ContractRef {
                    id: "synthetic.checker".into(),
                    schema_version: 1,
                    behavior_version: 1,
                },
            }),
            _ => wrong
                .application_tool_executions
                .push(crate::execution::ApplicationScopeBasis {
                    instance_id: ExecutionId::new(),
                    activation_generation: 1,
                }),
        }
        assert!(matches!(
            store
                .recover_conversation_proposal_work_plan(&wrong)
                .unwrap()
                .outcome,
            ConversationActionOutcome::Mismatch {}
        ));
        assert!(store.is_reconciling());
    }
    assert_eq!(
        store
            .work_plan_authorization_action_read(r.proposal.project_id, r.plan_id, &inner(&r))
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(store.is_reconciling());
    assert!(
        matches!(store.recover_conversation_proposal_work_plan(&r).unwrap().outcome,ConversationActionOutcome::Recorded { receipt } if receipt==link)
    );
    assert!(!store.is_reconciling());
    let unconfirmed = prepare(&store, &r.proposal);
    let pending = authorization(&store, &unconfirmed);
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    assert!(reopened.conversation_planning_permits.is_empty());
    assert!(
        matches!(reopened.recover_conversation_proposal_work_plan(&r).unwrap().outcome,ConversationActionOutcome::Recorded { receipt } if receipt==link)
    );
    assert_eq!(
        reopened.work_plan_receipt(r.action_id).unwrap(),
        Some(before)
    );
    assert_eq!(
        reopened
            .authorize_conversation_proposal_work_plan(&prepared, &r)
            .unwrap(),
        link
    );
    assert!(matches!(
        reopened
            .recover_conversation_proposal_work_plan(&pending)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Pending {
            replay: ConversationActionReplay::Blocked
        }
    ));
    assert_eq!(
        reopened
            .authorize_conversation_proposal_work_plan(&unconfirmed, &pending)
            .unwrap_err()
            .stage,
        "conversation-proposal-session"
    );
    assert_eq!(
        reopened
            .authorize_work_plan(prepared.plan(), &inner(&r))
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(reopened.conversation_planning_permits.is_empty());
}

#[test]
fn failed_relation_insert_rolls_back_original_grant_and_uncertain_commit_is_recoverable() {
    let (_temp, mut store, _capture, prepared, r) = setup();
    store.connection().unwrap().execute_batch("CREATE TRIGGER reject_link BEFORE INSERT ON application_conversation_work_plans BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    assert!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &r)
            .is_err()
    );
    assert_eq!(count(store.connection().unwrap(), "application_plans"), 0);
    assert_eq!(count(store.connection().unwrap(), "application_actions"), 0);
    assert!(
        store
            .conversation_proposal_work_plan_receipt(&r)
            .unwrap()
            .is_none()
    );
    store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_link")
        .unwrap();
    let reader = Connection::open(store.directory().join(DATABASE_FILENAME)).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM application_plans;")
        .unwrap();
    store
        .connection()
        .unwrap()
        .busy_timeout(Duration::from_millis(20))
        .unwrap();
    assert_eq!(
        store
            .authorize_conversation_proposal_work_plan(&prepared, &r)
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    assert!(store.is_reconciling());
    reader.execute_batch("ROLLBACK").unwrap();
    assert!(matches!(
        store
            .recover_conversation_proposal_work_plan(&r)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Pending {
            replay: ConversationActionReplay::Blocked
        }
    ));
    assert!(!store.is_reconciling());
    store
        .authorize_conversation_proposal_work_plan(&prepared, &r)
        .unwrap();
    assert_eq!(count(store.connection().unwrap(), "application_plans"), 1);
}

#[test]
fn concurrent_same_confirmation_creates_one_original_plan_and_association() {
    let (temp, store, _capture, prepared, r) = setup();
    let path = store.directory().to_path_buf();
    let mut second =
        ProjectStore::create(temp.path().join("second-owner"), store.metadata().unwrap()).unwrap();
    second.connection = Some(Connection::open(path.join(DATABASE_FILENAME)).unwrap());
    second.changes = store.changes.clone();
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
    let run = |mut store: ProjectStore,
               prepared: PreparedConversationProposalWorkPlan,
               r: AuthorizeConversationProposalWorkPlan,
               barrier: Arc<Barrier>| {
        std::thread::spawn(move || {
            barrier.wait();
            let result = store.authorize_conversation_proposal_work_plan(&prepared, &r);
            store.close().unwrap();
            result
        })
    };
    let a = run(store, prepared.clone(), r.clone(), barrier.clone());
    let b = run(second, prepared, r.clone(), barrier);
    assert_eq!(a.join().unwrap().unwrap(), b.join().unwrap().unwrap());
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        count(reopened.connection().unwrap(), "application_plans"),
        1
    );
    assert_eq!(
        count(
            reopened.connection().unwrap(),
            "application_conversation_work_plans"
        ),
        1
    );
}

fn snapshot(c: &Connection, version: i64) -> BTreeMap<String, Vec<Vec<rusqlite::types::Value>>> {
    let names=c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    names
        .into_iter()
        .filter(|name| {
            name != "application_conversation_work_plans"
                && name != "application_conversation_planning_attempts"
                && !(version == 61 && name.starts_with("application_conversation"))
                && !(version == 62 && name == "application_conversation_proposals")
        })
        .map(|name| {
            let mut q = c
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let columns = q.column_count();
            let rows = q
                .query_map([], |r| {
                    (0..columns)
                        .map(|i| r.get(i))
                        .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}
#[test]
fn work_plan_migration_child() {
    let Ok(path) = std::env::var("TSUMUGI_PROPOSAL_PLAN_MIGRATION_PROJECT") else {
        return;
    };
    ProjectStore::open(path).unwrap();
    panic!("migration did not reach its crash hook");
}
#[test]
fn supported_migrations_preserve_plans_discussions_proposals_and_receipts_at_abort_boundaries() {
    for version in [61, 62, 63] {
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
                .prepare_work_plan(Some(config()), "zh-CN", &units, options)
                .unwrap();
            let mut allow = consent(&plan);
            allow.effects = plan.authorization_effects().unwrap();
            let grant = store.authorize_work_plan(&plan, &allow).unwrap();
            store
                .enqueue_execution(&FixedInput::capture(grant.input.clone().unwrap()).unwrap())
                .unwrap();
            let scope = store.work_plan_agent_scope(grant.lease).unwrap();
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
                        body: "Original discussion survives the additive bridge".into(),
                        references: vec![],
                        reply_to: None,
                        supersedes: None,
                        question: None,
                    },
                )
                .unwrap();
            let original = if version >= 62 {
                Some(completed(&mut store, &units[..1], model(units[0]), true))
            } else {
                None
            };
            if version == 63 {
                let original = original.as_ref().unwrap();
                let first = store.capture_conversation_proposal(original).unwrap();
                store
                    .revise_conversation_proposal(&revise(original, first.revision_id, units[0]))
                    .unwrap();
            }
            let before = snapshot(store.connection().unwrap(), version);
            let path = store.directory().to_path_buf();
            store.close().unwrap();
            let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
            c.execute_batch("DROP TABLE application_conversation_planning_attempts; DROP TABLE application_conversation_work_plans")
                .unwrap();
            if version < 63 {
                c.execute_batch("DROP TABLE application_conversation_proposals")
                    .unwrap();
            }
            if version == 61 {
                c.execute_batch("DROP TABLE application_conversation_actions; DROP TABLE application_conversation_messages; DROP TABLE application_conversations;").unwrap();
            }
            c.pragma_update(None, "user_version", version).unwrap();
            drop(c);
            let marker = temp.path().join("migration-marker");
            let child=Command::new(std::env::current_exe().unwrap()).args(["--exact","persistence::application::conversations::proposals::work_plans::tests::work_plan_migration_child","--nocapture"]).env("TSUMUGI_PROPOSAL_PLAN_MIGRATION_PROJECT",&path).env("TSUMUGI_MIGRATION_CRASH",point).env("TSUMUGI_MIGRATION_HOOK",&marker).output().unwrap();
            assert!(!child.status.success());
            assert_eq!(std::fs::read_to_string(marker).unwrap(), point);
            let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
            let found: i64 = c
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(
                found,
                if point == "conversation-after-commit" {
                    SCHEMA_VERSION
                } else {
                    version
                }
            );
            assert_eq!(snapshot(&c, version), before);
            drop(c);
            let reopened = ProjectStore::open(path).unwrap();
            assert_eq!(snapshot(reopened.connection().unwrap(), version), before);
            assert_eq!(reopened.work_plan(plan.plan_id).unwrap(), plan);
            assert_eq!(
                reopened.work_plan_receipt(allow.action_id).unwrap(),
                Some(grant)
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
        }
    }
}
