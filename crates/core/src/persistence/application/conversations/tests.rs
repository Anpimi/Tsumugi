use super::*;
use crate::{ProjectMetadata, application::*, execution::FixedInput};
use std::{
    collections::BTreeMap,
    process::Command,
    sync::{Arc, Barrier, atomic::Ordering},
    time::Duration,
};
use tempfile::TempDir;

fn fixture() -> (TempDir, ProjectStore, CreateProjectConversation) {
    let temp = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(
        temp.path().join("project"),
        ProjectMetadata::create("Conversations", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    (
        temp,
        store,
        CreateProjectConversation {
            project_id: project,
            action_id: ExecutionId::new(),
            conversation_id: ExecutionId::new(),
            title: Some("Original title".into()),
        },
    )
}
fn append(r: &CreateProjectConversation, text: &str) -> AppendProjectConversationMessage {
    AppendProjectConversationMessage {
        project_id: r.project_id,
        action_id: ExecutionId::new(),
        conversation_id: r.conversation_id,
        message_id: ExecutionId::new(),
        body: text.into(),
    }
}
fn version(c: &Connection) -> i64 {
    c.pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}
fn legacy_rows(c: &Connection) -> BTreeMap<String, Vec<Vec<rusqlite::types::Value>>> {
    let names=c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'application_conversation%' ORDER BY name").unwrap()
        .query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut q = c
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let columns = q.column_count();
            let rows = q
                .query_map([], |r| {
                    (0..columns)
                        .map(|index| r.get(index))
                        .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}
fn make_legacy(path: &std::path::Path) {
    let c = Connection::open(path.join(super::super::super::DATABASE_FILENAME)).unwrap();
    for name in [
        "application_conversation_planning_attempts",
        "application_conversation_work_plans",
        "application_conversation_proposals",
        "application_conversation_actions",
        "application_conversation_messages",
        "application_conversations",
    ] {
        c.execute_batch(&format!("DROP TABLE {name}")).unwrap();
    }
    c.pragma_update(None, "user_version", 61).unwrap();
}

#[test]
fn original_actions_are_durable_exact_and_independent_of_work_plans() {
    let (_temp, store, create) = fixture();
    let before = legacy_rows(store.connection().unwrap());
    let pending = store.recover_project_conversation_create(&create).unwrap();
    assert_eq!(
        pending.outcome,
        ConversationActionOutcome::Pending {
            replay: ConversationActionReplay::ExplicitSameRequest
        }
    );
    let first = store.create_project_conversation(&create).unwrap();
    assert_eq!(first.ordinal.get(), 1);
    assert_eq!(store.create_project_conversation(&create).unwrap(), first);
    let message = append(&create, "  Message A\r\ne\u{301} 👩🏽‍💻 {{name}}  ");
    let saved = store.append_project_conversation_message(&message).unwrap();
    assert_eq!(saved.body, message.body);
    assert_eq!(saved.author, ConversationAuthor::Human);
    assert_eq!(
        store.append_project_conversation_message(&message).unwrap(),
        saved
    );
    let next = store
        .append_project_conversation_message(&append(&create, "B"))
        .unwrap();
    assert_eq!(next.ordinal.get(), 2);
    let mut changed = create.clone();
    changed.title = Some("Different".into());
    assert_eq!(
        store
            .create_project_conversation(&changed)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    assert_eq!(
        store
            .recover_project_conversation_create(&changed)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Mismatch {}
    );
    let mut changed_message = message.clone();
    changed_message.body.push('!');
    assert_eq!(
        store
            .recover_project_conversation_message(&changed_message)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Mismatch {}
    );
    let different_action = AppendProjectConversationMessage {
        action_id: ExecutionId::new(),
        ..message.clone()
    };
    assert_eq!(
        store
            .append_project_conversation_message(&different_action)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let cross_action = AppendProjectConversationMessage {
        action_id: create.action_id,
        ..append(&create, "Do not reuse create identity")
    };
    assert_eq!(
        store
            .recover_project_conversation_message(&cross_action)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Mismatch {}
    );
    assert_eq!(legacy_rows(store.connection().unwrap()), before);
    let changes = store.changes.snapshot(Revision::new(0).unwrap());
    assert_eq!(changes.scopes, [ChangeScope::Project]);
    assert_eq!(changes.progress_sequence.get(), 0);
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .recover_project_conversation_create(&create)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Recorded { receipt: first }
    );
    assert_eq!(
        reopened
            .recover_project_conversation_message(&message)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Recorded { receipt: saved }
    );
    assert_eq!(
        reopened
            .read_project_conversation_messages(create.project_id, create.conversation_id, None, 50)
            .unwrap()
            .rows
            .len(),
        2
    );
    assert_eq!(legacy_rows(reopened.connection().unwrap()), before);
}

#[test]
fn concurrent_original_writers_commit_one_conversation_and_message() {
    let (temp, store, create) = fixture();
    let path = store.directory().to_path_buf();
    // An independent SQLite connection exercises the transaction's duplicate
    // check. Normal application access still has a single project owner.
    let mut second = ProjectStore::create(
        temp.path().join("second-owner-fixture"),
        store.metadata().unwrap(),
    )
    .unwrap();
    second.connection =
        Some(Connection::open(path.join(super::super::super::DATABASE_FILENAME)).unwrap());
    second
        .connection
        .as_ref()
        .unwrap()
        .busy_timeout(Duration::from_secs(2))
        .unwrap();
    second
        .connection
        .as_ref()
        .unwrap()
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let message = append(&create, "Original concurrent message");
    let run = |store: ProjectStore,
               barrier: Arc<Barrier>,
               create: CreateProjectConversation,
               message: AppendProjectConversationMessage| {
        std::thread::spawn(move || {
            barrier.wait();
            let first = store.create_project_conversation(&create).unwrap();
            let saved = store.append_project_conversation_message(&message).unwrap();
            store.close().unwrap();
            (first, saved)
        })
    };
    let a = run(store, barrier.clone(), create.clone(), message.clone());
    let b = run(second, barrier, create.clone(), message.clone());
    assert_eq!(a.join().unwrap(), b.join().unwrap());
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .list_project_conversations(create.project_id, None, 50)
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_eq!(
        reopened
            .read_project_conversation_messages(create.project_id, create.conversation_id, None, 50)
            .unwrap()
            .rows
            .len(),
        1
    );
}

#[test]
fn byte_bounded_pages_return_complete_ordered_prefixes_without_truncating_text() {
    let (_temp, store, create) = fixture();
    store.create_project_conversation(&create).unwrap();
    let text = format!("x{}", "\0".repeat(MAX_CONVERSATION_MESSAGE_BYTES - 1));
    let mut all = Vec::new();
    for _ in 0..12 {
        all.push(
            store
                .append_project_conversation_message(&append(&create, &text))
                .unwrap(),
        );
    }
    let first = store
        .read_project_conversation_messages(create.project_id, create.conversation_id, None, 50)
        .unwrap();
    assert!(!first.rows.is_empty() && first.rows.len() < 12);
    assert!(first.next_after.is_some());
    assert!(codec::encode(&first, MAX_CONVERSATION_PAGE_BYTES).is_ok());
    let mut seen = first.rows;
    let mut after = first.next_after;
    while let Some(cursor) = after {
        let page = store
            .read_project_conversation_messages(
                create.project_id,
                create.conversation_id,
                Some(cursor),
                50,
            )
            .unwrap();
        assert!(codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES).is_ok());
        after = page.next_after;
        seen.extend(page.rows);
    }
    assert_eq!(seen, all);
    assert!(seen.iter().all(|row| row.body == text));
    let next = CreateProjectConversation {
        action_id: ExecutionId::new(),
        conversation_id: ExecutionId::new(),
        title: None,
        ..create.clone()
    };
    store.create_project_conversation(&next).unwrap();
    let page = store
        .list_project_conversations(create.project_id, None, 1)
        .unwrap();
    assert_eq!(page.rows[0].conversation_id, create.conversation_id);
    let page = store
        .list_project_conversations(create.project_id, page.next_after, 1)
        .unwrap();
    assert_eq!(page.rows[0].conversation_id, next.conversation_id);
    assert_eq!(page.next_after, None);
}

#[test]
fn invalid_inputs_and_wrong_projects_do_not_read_or_write_other_records() {
    let (_temp, store, create) = fixture();
    store.create_project_conversation(&create).unwrap();
    for text in [
        " \r\n\t".into(),
        "x".repeat(MAX_CONVERSATION_MESSAGE_BYTES + 1),
    ] {
        assert_eq!(
            store
                .append_project_conversation_message(&append(&create, &text))
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    assert_eq!(
        store
            .create_project_conversation(&CreateProjectConversation {
                action_id: ExecutionId::new(),
                conversation_id: ExecutionId::new(),
                title: Some("界".repeat(43)),
                ..create.clone()
            })
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    let wrong = CreateProjectConversation {
        project_id: ExecutionId::new(),
        ..create.clone()
    };
    assert_eq!(
        store
            .recover_project_conversation_create(&wrong)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .read_project_conversation(wrong.project_id, create.conversation_id)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    for limit in [0, 51] {
        assert_eq!(
            store
                .list_project_conversations(create.project_id, None, limit)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    assert!(
        store
            .read_project_conversation_messages(create.project_id, create.conversation_id, None, 50)
            .unwrap()
            .rows
            .is_empty()
    );
}

#[test]
fn uncertain_commit_requires_verified_explicit_recovery_before_same_request_replay() {
    let (_temp, store, create) = fixture();
    store.create_project_conversation(&create).unwrap();
    let reader = Connection::open(
        store
            .directory()
            .join(super::super::super::DATABASE_FILENAME),
    )
    .unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM application_conversations;")
        .unwrap();
    store
        .connection()
        .unwrap()
        .busy_timeout(Duration::from_millis(20))
        .unwrap();
    let original = append(&create, "Original message under a blocked commit");
    assert_eq!(
        store
            .append_project_conversation_message(&original)
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    assert!(store.is_reconciling());
    assert_eq!(
        store.create_project_conversation(&create).unwrap_err().code,
        ErrorCode::OutcomeUnknown
    );
    assert!(
        store
            .project_conversation_create_receipt(&create)
            .unwrap()
            .is_some()
    );
    assert!(store.is_reconciling());
    let mismatch = CreateProjectConversation {
        title: None,
        ..create.clone()
    };
    assert_eq!(
        store
            .recover_project_conversation_create(&mismatch)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Mismatch {}
    );
    assert!(store.is_reconciling());
    reader.execute_batch("ROLLBACK").unwrap();
    let recovery = store
        .recover_project_conversation_message(&original)
        .unwrap();
    assert_eq!(
        recovery.outcome,
        ConversationActionOutcome::Pending {
            replay: ConversationActionReplay::ExplicitSameRequest
        }
    );
    assert!(!store.is_reconciling());
    let receipt = store
        .append_project_conversation_message(&original)
        .unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(
        store
            .recover_project_conversation_message(&original)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Recorded { receipt }
    );
    assert!(!store.is_reconciling());
    assert_eq!(
        store
            .read_project_conversation_messages(create.project_id, create.conversation_id, None, 50)
            .unwrap()
            .rows
            .len(),
        1
    );
}

#[test]
fn corrupt_original_action_never_clears_unknown_or_returns_an_absent_result() {
    let (_temp, store, create) = fixture();
    store.create_project_conversation(&create).unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE application_conversation_actions SET receipt_digest=?1 WHERE action_id=?2",
            params!["0".repeat(64), create.action_id.to_string()],
        )
        .unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(
        store
            .recover_project_conversation_create(&create)
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
    assert!(store.is_reconciling());
}

#[test]
fn conversation_migration_child() {
    let Ok(path) = std::env::var("TSUMUGI_CONVERSATION_MIGRATION_PROJECT") else {
        return;
    };
    let _ = ProjectStore::open(path).unwrap();
    panic!("migration did not reach its crash hook");
}

#[test]
fn migration_interruptions_preserve_all_original_plan_team_and_receipt_rows() {
    use crate::persistence::application::tests::{config, consent, fixture as work_fixture};
    for point in [
        "conversation-before-ddl",
        "conversation-after-ddl",
        "conversation-before-commit",
        "conversation-after-commit",
    ] {
        let (temp, mut store, units) = work_fixture();
        let mut options = PlanOptions::default();
        options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV1 {});
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, options)
            .unwrap();
        let mut permission = consent(&plan);
        permission.effects = plan.authorization_effects().unwrap();
        let grant = store.authorize_work_plan(&plan, &permission).unwrap();
        store
            .enqueue_execution(&FixedInput::capture(grant.input.clone().unwrap()).unwrap())
            .unwrap();
        let scope = store.work_plan_agent_scope(grant.lease).unwrap();
        let basis = &plan.selection_basis[0];
        let post = PublishTeamDiscussion {
            post_id: ExecutionId::new(),
            target: TeamDiscussionTarget {
                unit_id: basis.unit_id,
                locale: plan.locale.clone(),
                source_snapshot_id: basis.source_snapshot_id,
                source_revision_id: basis.source_revision_id,
            },
            kind: TeamDiscussionKind::Note,
            body: "Original retained team discussion 👩🏽‍💻".into(),
            references: vec![],
            reply_to: None,
            supersedes: None,
        };
        let saved = store
            .publish_human_team_discussion(&scope, "local-user", &post)
            .unwrap();
        let before = legacy_rows(store.connection().unwrap());
        let path = store.directory().to_path_buf();
        store.close().unwrap();
        make_legacy(&path);
        let marker = temp.path().join("migration-hook");
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::application::conversations::tests::conversation_migration_child",
                "--nocapture",
            ])
            .env("TSUMUGI_CONVERSATION_MIGRATION_PROJECT", &path)
            .env("TSUMUGI_MIGRATION_CRASH", point)
            .env("TSUMUGI_MIGRATION_HOOK", &marker)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "crash child unexpectedly succeeded"
        );
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            point,
            "the actual migration hook must run"
        );
        let raw = Connection::open(path.join(super::super::super::DATABASE_FILENAME)).unwrap();
        assert_eq!(
            version(&raw),
            if point == "conversation-after-commit" {
                crate::persistence::SCHEMA_VERSION
            } else {
                61
            }
        );
        assert_eq!(legacy_rows(&raw), before);
        drop(raw);
        let reopened = ProjectStore::open(&path).unwrap();
        assert_eq!(version(reopened.connection().unwrap()), crate::persistence::SCHEMA_VERSION);
        assert_eq!(legacy_rows(reopened.connection().unwrap()), before);
        assert_eq!(reopened.work_plan(plan.plan_id).unwrap(), plan);
        assert_eq!(
            reopened
                .work_plan_receipt(permission.action_id)
                .unwrap()
                .unwrap(),
            grant
        );
        assert_eq!(
            reopened
                .read_team_history_post(plan.project_id, plan.plan_id, saved.publication.post_id)
                .unwrap(),
            saved
        );
    }
}

#[test]
fn invalid_legacy_shape_is_rejected_before_additive_migration_writes() {
    let (_temp, store, _) = fixture();
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    make_legacy(&path);
    let raw = Connection::open(path.join(super::super::super::DATABASE_FILENAME)).unwrap();
    raw.execute_batch("CREATE TABLE unexpected_state(value TEXT)")
        .unwrap();
    drop(raw);
    assert!(ProjectStore::open(&path).is_err());
    let raw = Connection::open(path.join(super::super::super::DATABASE_FILENAME)).unwrap();
    assert_eq!(version(&raw), 61);
    let count: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'application_conversation%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}
