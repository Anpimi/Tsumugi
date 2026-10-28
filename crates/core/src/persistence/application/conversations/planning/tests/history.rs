use super::*;
use crate::{
    execution::{ExecutionRuntime, ExecutionState, FixedInput, FixedResult, ResultEnvelope},
    persistence::{DATABASE_FILENAME, SCHEMA_VERSION},
};
use std::{collections::BTreeMap, process::Command};

fn submit(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    request: &PrepareConversationPlanning,
) -> PreparedConversationPlanning {
    let capture = store.prepare_conversation_planning(request).unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    runtime
        .submit_conversation_planning(store, &prepared)
        .unwrap();
    prepared
}

fn complete(store: &mut ProjectStore, prepared: &PreparedConversationPlanning, success: bool) {
    let input = prepared.input();
    let attempt = input.envelope().attempt_id;
    let dispatch = store.dispatch_execution_item(attempt, attempt).unwrap();
    let result = FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: attempt,
            item_id: attempt,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: dispatch.dispatch_token,
            capability_id: conversation_planning::CAPABILITY.into(),
            capability_version: "1".into(),
            plugin: None,
            outcome: if success { ExecutionState::Succeeded } else { ExecutionState::Failed },
            output: success.then(|| serde_json::json!({
                "model":{"kind":"reply","summary":"An explanation without proposal capture","questions":[]},
                "usage":null,"requests":1,"usageIncomplete":true
            })),
            diagnostic: (!success).then(|| crate::execution::Diagnostic { code: "synthetic-planning-failure".into(), retry_safe: false }),
        },
        input,
        dispatch.dispatch_token,
    ).unwrap();
    store.save_execution_result(&result).unwrap();
    if success {
        store
            .validate_execution_result(attempt, result.envelope().result_id)
            .unwrap();
    }
}

#[test]
fn planning_history_pages_seek_one_thread_and_preserve_complete_small_locators() {
    let (_temp, mut store, project, units) = fixture();
    let mut first = request(&store, project, &units[..1]);
    first.scope = ConversationPlanningScope::ConversationOnly {};
    // A large frozen message belongs in readPlanning details, never the locator page.
    first.selected_message_ids = vec![append(
        &store,
        project,
        first.conversation_id,
        &"文".repeat(2_500),
    )];
    let mut second = request(&store, project, &units[..1]);
    second.scope = ConversationPlanningScope::ConversationOnly {};
    let mut runtime = planning_runtime(&store);
    let mut expected = Vec::new();
    for index in 0..53 {
        let prepared = submit(
            &mut store,
            &mut runtime,
            if index % 20 == 0 { &second } else { &first },
        );
        if index % 20 != 0 {
            expected.push(prepared.consent().attempt_id);
        }
    }
    // Exactly fifty first-thread rows fill the first page. A later append must
    // remain discoverable from its original cursor without reusing a UI feed.
    let page = readonly(&store, || {
        store.conversation_planning_attempts(
            project,
            first.conversation_id,
            Revision::new(0).unwrap(),
            50,
        )
    })
    .unwrap();
    assert_eq!(
        page.rows
            .iter()
            .map(|row| row.attempt_id)
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(page.rows.len(), 50);
    assert_eq!(page.next_after, None);
    let cursor = page.rows.last().unwrap().sequence;
    let next = submit(&mut store, &mut runtime, &first);
    let tail = readonly(&store, || {
        store.conversation_planning_attempts(project, first.conversation_id, cursor, 1)
    })
    .unwrap();
    assert_eq!(tail.rows[0].attempt_id, next.consent().attempt_id);
    assert_eq!(tail.rows[0].task_id, next.consent().task_id);
    assert_eq!(tail.next_after, None);
    let paged = readonly(&store, || {
        store.conversation_planning_attempts(
            project,
            first.conversation_id,
            Revision::new(0).unwrap(),
            50,
        )
    })
    .unwrap();
    assert_eq!(paged.rows, page.rows);
    assert_eq!(paged.next_after, Some(cursor));
    assert!(serde_json::to_vec(&paged).unwrap().len() <= MAX_CONVERSATION_PAGE_BYTES);
    let json = serde_json::to_value(&paged).unwrap();
    assert_eq!(json["rows"][0].as_object().unwrap().len(), 3);
    assert!(json["rows"][0].get("preview").is_none());
    let plan = store.connection().unwrap().prepare(
        "EXPLAIN QUERY PLAN SELECT attempt_id,sequence FROM application_conversation_planning_attempts WHERE conversation_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3",
    ).unwrap().query_map(params![first.conversation_id.to_string(), 0, 51], |row| row.get::<_, String>(3))
        .unwrap().collect::<Result<Vec<_>, _>>().unwrap().join(" ");
    assert!(
        plan.contains("SEARCH") && plan.contains("conversation_id=? AND sequence>?"),
        "{plan}"
    );
    assert!(!plan.contains("SCAN"), "{plan}");
    for limit in [0, 51] {
        assert_eq!(
            readonly(&store, || store.conversation_planning_attempts(
                project,
                first.conversation_id,
                Revision::new(0).unwrap(),
                limit,
            ))
            .unwrap_err()
            .code,
            ErrorCode::InvalidInput
        );
    }
    assert_eq!(
        readonly(&store, || store.conversation_planning_attempts(
            ExecutionId::new(),
            first.conversation_id,
            Revision::new(0).unwrap(),
            50,
        ))
        .unwrap_err()
        .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .conversation_planning_attempts(
                project,
                second.conversation_id,
                Revision::new(0).unwrap(),
                50,
            )
            .unwrap()
            .rows
            .len(),
        3
    );
}

#[test]
fn planning_history_reopens_reply_failure_and_queued_attempts_without_authority_or_writes() {
    let (_temp, mut store, project, units) = fixture();
    let mut request = request(&store, project, &units[..1]);
    request.scope = ConversationPlanningScope::ConversationOnly {};
    let mut runtime = planning_runtime(&store);
    let reply = submit(&mut store, &mut runtime, &request);
    complete(&mut store, &reply, true);
    let failed = submit(&mut store, &mut runtime, &request);
    complete(&mut store, &failed, false);
    let queued = submit(&mut store, &mut runtime, &request);
    let expected = [
        reply.consent().attempt_id,
        failed.consent().attempt_id,
        queued.consent().attempt_id,
    ];
    let path = store.directory().to_path_buf();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    assert!(reopened.conversation_planning_permits.is_empty());
    reopened.execution_unknown.store(true, Ordering::Release);
    let page = readonly(&reopened, || {
        reopened.conversation_planning_attempts(
            project,
            request.conversation_id,
            Revision::new(0).unwrap(),
            50,
        )
    })
    .unwrap();
    assert_eq!(
        page.rows
            .iter()
            .map(|row| row.attempt_id)
            .collect::<Vec<_>>(),
        expected
    );
    assert!(reopened.is_reconciling());
    assert!(reopened.conversation_planning_permits.is_empty());
    assert_eq!(
        reopened
            .provider_budget(queued.consent().task_id)
            .unwrap()
            .unwrap()
            .dispatched,
        0
    );
    reopened.execution_unknown.store(false, Ordering::Release);
    assert_eq!(
        reopened
            .dispatch_execution_item(expected[2], expected[2])
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
}

#[test]
fn planning_history_rejects_forged_sequence_parent_and_missing_locator_on_open() {
    let (_temp, mut store, project, units) = fixture();
    let request = request(&store, project, &units[..1]);
    let other = super::request(&store, project, &units[..1]);
    let mut runtime = planning_runtime(&store);
    let prepared = submit(&mut store, &mut runtime, &request);
    let attempt = prepared.consent().attempt_id;
    let row = store
        .conversation_planning_attempts(
            project,
            request.conversation_id,
            Revision::new(0).unwrap(),
            1,
        )
        .unwrap()
        .rows
        .remove(0);
    store.connection().unwrap().execute(
        "UPDATE application_conversation_planning_attempts SET sequence=sequence+1000 WHERE attempt_id=?1", [attempt.to_string()],
    ).unwrap();
    assert_eq!(
        readonly(&store, || store.conversation_planning_attempts(
            project,
            request.conversation_id,
            Revision::new(0).unwrap(),
            50
        ))
        .unwrap_err()
        .code,
        ErrorCode::CorruptLedger
    );
    store.connection().unwrap().execute(
        "UPDATE application_conversation_planning_attempts SET sequence=?2,conversation_id=?3 WHERE attempt_id=?1",
        params![attempt.to_string(), row.sequence.get() as i64, other.conversation_id.to_string()],
    ).unwrap();
    assert_eq!(
        readonly(&store, || store.conversation_planning_attempts(
            project,
            other.conversation_id,
            Revision::new(0).unwrap(),
            50
        ))
        .unwrap_err()
        .code,
        ErrorCode::CorruptLedger
    );
    store
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM application_conversation_planning_attempts WHERE attempt_id=?1",
            [attempt.to_string()],
        )
        .unwrap();
    let path = store.directory().to_path_buf();
    drop(runtime);
    store.close().unwrap();
    assert!(ProjectStore::open(path).is_err());
}

#[test]
fn failed_planning_locator_insert_rolls_back_the_original_attempt_and_budget() {
    let (_temp, mut store, project, units) = fixture();
    let request = request(&store, project, &units[..1]);
    let capture = store.prepare_conversation_planning(&request).unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    let before = old_rows(store.connection().unwrap(), SCHEMA_VERSION);
    store.connection().unwrap().execute_batch("CREATE TRIGGER reject_planning_locator BEFORE INSERT ON application_conversation_planning_attempts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    assert!(
        runtime
            .submit_conversation_planning(&mut store, &prepared)
            .is_err()
    );
    assert_eq!(
        old_rows(store.connection().unwrap(), SCHEMA_VERSION),
        before
    );
    assert!(
        store
            .execution_input_if_present(prepared.consent().attempt_id)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .provider_budget(prepared.consent().task_id)
            .unwrap()
            .is_none()
    );
}

fn old_rows(c: &Connection, version: i64) -> BTreeMap<String, Vec<Vec<rusqlite::types::Value>>> {
    let names = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    names
        .into_iter()
        .filter(|name| {
            name != "application_conversation_planning_attempts"
                && !(version < 64 && name == "application_conversation_work_plans")
                && !(version < 63 && name == "application_conversation_proposals")
                && !(version == 61 && name.starts_with("application_conversation"))
        })
        .map(|name| {
            let mut q = c
                .prepare(&format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                .unwrap();
            let columns = q.column_count();
            let rows = q
                .query_map([], |row| {
                    (0..columns)
                        .map(|index| row.get(index))
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
fn planning_history_migration_child() {
    let Ok(path) = std::env::var("TSUMUGI_PLANNING_HISTORY_MIGRATION_PROJECT") else {
        return;
    };
    ProjectStore::open(path).unwrap();
    panic!("migration did not reach its crash hook");
}

#[test]
fn planning_history_migration_preserves_all_supported_rows_and_backfills_every_attempt_at_abort_boundaries()
 {
    for version in [61, 62, 63, 64] {
        for point in [
            "conversation-before-ddl",
            "conversation-after-ddl",
            "conversation-before-commit",
            "conversation-after-commit",
        ] {
            let (temp, mut store, project, units) = fixture();
            let mut options = PlanOptions::default();
            options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV1 {});
            let plan = store
                .prepare_work_plan(Some(config()), "zh-CN", &units[..1], options)
                .unwrap();
            let mut consent = crate::persistence::application::tests::consent(&plan);
            consent.effects = plan.authorization_effects().unwrap();
            let grant = store.authorize_work_plan(&plan, &consent).unwrap();
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
                        body: "Original discussion survives history indexing".into(),
                        references: vec![],
                        reply_to: None,
                        supersedes: None,
                    },
                )
                .unwrap();
            let expected = if version >= 62 {
                let mut request = request(&store, project, &units[..1]);
                request.scope = ConversationPlanningScope::ConversationOnly {};
                let mut runtime = planning_runtime(&store);
                let reply = submit(&mut store, &mut runtime, &request);
                complete(&mut store, &reply, true);
                let failed = submit(&mut store, &mut runtime, &request);
                complete(&mut store, &failed, false);
                let _queued = submit(&mut store, &mut runtime, &request);
                let page = store
                    .conversation_planning_attempts(
                        project,
                        request.conversation_id,
                        Revision::new(0).unwrap(),
                        50,
                    )
                    .unwrap();
                drop(runtime);
                Some(page)
            } else {
                None
            };
            let before = old_rows(store.connection().unwrap(), version);
            let path = store.directory().to_path_buf();
            store.close().unwrap();
            let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
            c.execute_batch("DROP TABLE application_conversation_planning_attempts")
                .unwrap();
            if version < 64 {
                c.execute_batch("DROP TABLE application_conversation_work_plans")
                    .unwrap();
            }
            if version < 63 {
                c.execute_batch("DROP TABLE application_conversation_proposals")
                    .unwrap();
            }
            if version == 61 {
                c.execute_batch("DROP TABLE application_conversation_actions; DROP TABLE application_conversation_messages; DROP TABLE application_conversations").unwrap();
            }
            c.pragma_update(None, "user_version", version).unwrap();
            drop(c);
            let marker = temp.path().join("history-migration-marker");
            let child = Command::new(std::env::current_exe().unwrap()).args(["--exact", "persistence::application::conversations::planning::tests::history::planning_history_migration_child", "--nocapture"])
                .env("TSUMUGI_PLANNING_HISTORY_MIGRATION_PROJECT", &path).env("TSUMUGI_MIGRATION_CRASH", point).env("TSUMUGI_MIGRATION_HOOK", &marker).output().unwrap();
            assert!(!child.status.success());
            assert_eq!(fs::read_to_string(marker).unwrap(), point);
            let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
            assert_eq!(
                c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .unwrap(),
                if point == "conversation-after-commit" {
                    SCHEMA_VERSION
                } else {
                    version
                }
            );
            assert_eq!(old_rows(&c, version), before);
            drop(c);
            let reopened = ProjectStore::open(path).unwrap();
            assert_eq!(old_rows(reopened.connection().unwrap(), version), before);
            assert_eq!(reopened.work_plan(plan.plan_id).unwrap(), plan);
            assert_eq!(
                reopened.work_plan_receipt(consent.action_id).unwrap(),
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
            if let Some(expected) = &expected {
                assert_eq!(
                    readonly(&reopened, || reopened.conversation_planning_attempts(
                        project,
                        expected.conversation_id,
                        Revision::new(0).unwrap(),
                        50
                    ))
                    .unwrap(),
                    *expected
                );
            }
        }
    }
}
