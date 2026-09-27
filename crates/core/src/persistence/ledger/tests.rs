use super::*;
use crate::{
    PersistenceErrorCode, ProjectMetadata,
    content::{SourceAdoptionHandler, SourceBundle, SourceRunner},
    execution::{ExecutionRuntime, ExecutionState},
};
use serde_json::json;
use std::{
    path::Path,
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

struct TestSchema;
impl TestSchema {
    fn enable() -> Self {
        TEST_SCHEMA.with(|flag| flag.set(true));
        Self
    }
}
impl Drop for TestSchema {
    fn drop(&mut self) {
        TEST_SCHEMA.with(|flag| flag.set(false));
    }
}

fn store(path: &Path) -> ProjectStore {
    ProjectStore::create(
        path,
        ProjectMetadata::create("Execution fixture", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap()
}
fn fixture_input(store: &ProjectStore, grouped: bool) -> FixedInput {
    let items = ["a", "b", "c"]
        .into_iter()
        .map(|id| {
            InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: id.into(),
                    locale: Some("zh-CN".into()),
                },
                json!({"text":id}),
                vec![Dependency {
                    kind: "fixture".into(),
                    id: id.into(),
                    expected_revision: Revision::new(1).unwrap(),
                }],
            )
        })
        .collect();
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "fixture",
        "controlled",
        "1",
        items,
    )
    .unwrap();
    if grouped {
        envelope.units = vec![AdoptionUnit::new(
            envelope.items.iter().map(|item| item.item_id).collect(),
        )];
    }
    FixedInput::capture(envelope).unwrap()
}
fn install_targets(store: &ProjectStore) {
    store.execution_connection().unwrap().execute_batch("CREATE TABLE fixture_targets(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL); INSERT INTO fixture_targets VALUES ('a',1,'original'),('b',1,'original'),('c',1,'original');").unwrap();
}
fn produce(store: &mut ProjectStore, input: &FixedInput, item: ExecutionId) -> FixedResult {
    let request = store
        .dispatch_execution_item(input.envelope().attempt_id, item)
        .unwrap();
    FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: item,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: "controlled".into(),
            capability_version: "1".into(),
            outcome: ExecutionState::Succeeded,
            output: Some(json!({"text":"applied"})),
            diagnostic: None,
        },
        input,
        request.dispatch_token,
    )
    .unwrap()
}
fn action(store: &mut ProjectStore, input: &FixedInput, results: &[FixedResult]) -> AdoptionAction {
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|unit| unit.item_ids.contains(&results[0].envelope().item_id))
        .unwrap();
    store
        .prepare_adoption(
            input.envelope().attempt_id,
            unit.unit_id,
            results
                .iter()
                .map(|result| result.envelope().result_id)
                .collect(),
            serde_json::Value::Null,
        )
        .unwrap()
}
struct Handler;
impl AdoptionHandler for Handler {
    fn operation(&self) -> &str {
        "fixture"
    }
    fn apply(
        &self,
        tx: &AdoptionTransaction<'_>,
        input: &FixedInput,
        _action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<Vec<ChangeReference>, ExecutionError> {
        let mut changes = Vec::new();
        for result in results {
            let item = input.item(result.envelope().item_id)?;
            let expected = item.dependencies[0].expected_revision;
            let current: i64 = tx.query_row(
                "SELECT revision FROM fixture_targets WHERE id=?1",
                [&item.scope.id],
                |r| r.get(0),
            )?;
            if current != expected.get() as i64 {
                return Err(error(ErrorCode::DependencyConflict, "fixture"));
            }
            tx.execute(
                "UPDATE fixture_targets SET revision=revision+1,value='applied' WHERE id=?1",
                [&item.scope.id],
            )?;
            changes.push(ChangeReference {
                kind: "fixture".into(),
                id: item.scope.id.clone(),
                revision: expected.next()?,
            });
        }
        Ok(changes)
    }
}

#[test]
fn durable_inputs_results_and_reads_preserve_metadata_and_do_not_regenerate() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("project");
    let mut store = store(&path);
    let metadata = store.metadata().unwrap();
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    assert!(store.save_execution_result(&result).unwrap());
    assert!(!store.save_execution_result(&result).unwrap());
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap()
            .items
            .iter()
            .find(|item| item.item_id == result.envelope().item_id)
            .unwrap()
            .validation,
        ValidationState::Pending
    );
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    let before = std::fs::read(path.join(super::super::DATABASE_FILENAME)).unwrap();
    assert_eq!(
        reopened
            .execution_input(input.envelope().attempt_id)
            .unwrap()
            .bytes(),
        input.bytes()
    );
    assert_eq!(
        reopened
            .execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
    assert_eq!(
        reopened
            .execution_tasks(Revision::new(0).unwrap(), 50)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(reopened.metadata().unwrap(), metadata);
    assert_eq!(
        std::fs::read(path.join(super::super::DATABASE_FILENAME)).unwrap(),
        before
    );
    reopened
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let view = reopened
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(view.progress.succeeded, 1);
    assert_eq!(view.progress.adopted, 0);
}

#[test]
fn wrong_project_duplicate_evidence_and_cancelled_dispatch_are_rejected() {
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    let input = fixture_input(&store, false);
    let mut alien = input.envelope().clone();
    alien.project_id = ExecutionId::new();
    assert_eq!(
        store
            .enqueue_execution(&FixedInput::capture(alien).unwrap())
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    let mut changed = result.envelope().clone();
    changed.output = Some(json!("different"));
    let changed = FixedResult::capture(changed, &input, result.envelope().dispatch_token).unwrap();
    assert_eq!(
        store.save_execution_result(&changed).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    let cancel = ExecutionId::new();
    let revision = store
        .cancel_execution(input.envelope().task_id, cancel)
        .unwrap();
    assert_eq!(
        store
            .cancel_execution(input.envelope().task_id, cancel)
            .unwrap(),
        revision
    );
    assert_eq!(
        store
            .dispatch_execution_item(
                input.envelope().attempt_id,
                input.envelope().items[1].item_id
            )
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .progress
            .cancelled,
        2
    );
    assert_eq!(
        store
            .execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
}

#[test]
fn receipt_and_target_change_are_atomic_and_duplicates_return_original_receipt() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("project");
    let mut store = store(&path);
    install_targets(&store);
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let action = action(&mut store, &input, &[result.clone()]);
    let first = store.adopt_execution(&action, &Handler).unwrap();
    store
        .cancel_execution(input.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert_eq!(store.adopt_execution(&action, &Handler).unwrap(), first);
    let id = input
        .item(result.envelope().item_id)
        .unwrap()
        .scope
        .id
        .clone();
    let current: i64 = store
        .execution_connection()
        .unwrap()
        .query_row(
            "SELECT revision FROM fixture_targets WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, 2);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.adoption_receipt(action.action_id).unwrap(),
        Some(first.clone())
    );
    assert_eq!(reopened.adopt_execution(&action, &Handler).unwrap(), first);
    reopened
        .execution_connection()
        .unwrap()
        .execute("UPDATE execution_results SET digest=?1", ["0".repeat(64)])
        .unwrap();
    assert_eq!(reopened.adopt_execution(&action, &Handler).unwrap(), first);
    let mut spoof = action;
    spoof.parameters = json!("changed");
    assert_eq!(
        reopened.adopt_execution(&spoof, &Handler).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
}

#[test]
fn consistency_units_rollback_all_changes_but_unrelated_edits_do_not_conflict() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    install_targets(&store);
    let input = fixture_input(&store, true);
    store.enqueue_execution(&input).unwrap();
    let mut results = Vec::new();
    for item in &input.envelope().items {
        let result = produce(&mut store, &input, item.item_id);
        store.save_execution_result(&result).unwrap();
        store
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        results.push(result);
    }
    let action = action(&mut store, &input, &results);
    let last = &input.envelope().items.last().unwrap().scope.id;
    store
        .execution_connection()
        .unwrap()
        .execute("UPDATE fixture_targets SET revision=2 WHERE id=?1", [last])
        .unwrap();
    assert_eq!(
        store.adopt_execution(&action, &Handler).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
    assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
    let applied: i64 = store
        .execution_connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM fixture_targets WHERE value='applied'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(applied, 0);
    store
        .execution_connection()
        .unwrap()
        .execute("UPDATE fixture_targets SET revision=1 WHERE id=?1", [last])
        .unwrap();
    store.rename(1, "Unrelated metadata").unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &Handler)
            .unwrap()
            .changes
            .len(),
        3
    );
}

#[test]
fn cancellation_wins_before_commit_and_explicit_new_action_can_use_preserved_result() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    install_targets(&store);
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let old = action(&mut store, &input, &[result.clone()]);
    store
        .cancel_execution(input.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert_eq!(
        store.adopt_execution(&old, &Handler).unwrap_err().code,
        ErrorCode::Cancelled
    );
    assert!(store.adoption_receipt(old.action_id).unwrap().is_none());
    let renewed = action(&mut store, &input, &[result]);
    assert_ne!(renewed.action_id, old.action_id);
    store.adopt_execution(&renewed, &Handler).unwrap();
}

#[test]
fn removed_scope_or_target_cannot_be_resurrected_and_unknown_work_is_not_retried() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    install_targets(&store);
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let prepared = action(&mut store, &input, &[result]);
    store.set_target_locales(1, &["ja".into()]).unwrap();
    assert_eq!(
        store.adopt_execution(&prepared, &Handler).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    store.set_target_locales(2, &["zh-CN".into()]).unwrap();
    let id = &input.envelope().items[0].scope.id;
    store
        .execution_connection()
        .unwrap()
        .execute("DELETE FROM fixture_targets WHERE id=?1", [id])
        .unwrap();
    assert_eq!(
        store.adopt_execution(&prepared, &Handler).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
    let pending = input.envelope().items[1].item_id;
    store
        .dispatch_execution_item(input.envelope().attempt_id, pending)
        .unwrap();
    store
        .finish_execution_attempt(input.envelope().attempt_id)
        .unwrap();
    let retry = input.retry(&[pending]).unwrap();
    assert_eq!(
        store.enqueue_execution(&retry).unwrap_err().code,
        ErrorCode::Unauthorized
    );
}

#[test]
fn versions_and_corrupt_inputs_are_rejected_without_rebuilding_and_bad_output_is_visible() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("project");
    let mut store = store(&path);
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    store.close().unwrap();
    let database = path.join(super::super::DATABASE_FILENAME);
    for version in [1, 99] {
        let connection = Connection::open(&database).unwrap();
        connection
            .pragma_update(None, "user_version", version)
            .unwrap();
        drop(connection);
        let before = std::fs::read(&database).unwrap();
        assert_eq!(
            ProjectStore::open(&path).unwrap_err().code(),
            PersistenceErrorCode::UnsupportedSchema
        );
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }
    let connection = Connection::open(&database).unwrap();
    connection
        .pragma_update(None, "user_version", crate::persistence::SCHEMA_VERSION)
        .unwrap();
    connection
        .execute("UPDATE execution_results SET digest=?1", ["0".repeat(64)])
        .unwrap();
    drop(connection);
    let mut reopened = ProjectStore::open(&path).unwrap();
    let view = reopened
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(
        view.items
            .iter()
            .find(|item| item.item_id == result.envelope().item_id)
            .unwrap()
            .validation,
        ValidationState::Invalid
    );
    assert!(
        reopened
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .is_err()
    );
    reopened.close().unwrap();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute("UPDATE execution_attempts SET digest=?1", ["0".repeat(64)])
        .unwrap();
    drop(connection);
    assert_eq!(
        ProjectStore::open(&path).unwrap_err().code(),
        PersistenceErrorCode::CorruptProject
    );
}

#[test]
fn schema_v3_result_limit_upgrade_preserves_results_and_relations() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("project");
    let mut store = store(&path);
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let item = input.envelope().items[0].item_id;
    let result = produce(&mut store, &input, item);
    let result_bytes = result.bytes().to_vec();
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();

    let source_bundle = SourceBundle::capture(
        br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
        br#"{"greeting":"Hello"}"#,
        "en-US",
    )
    .unwrap();
    let source_input = source_bundle
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
    runtime.register(Arc::new(SourceRunner)).unwrap();
    runtime.submit(&mut store, &source_input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        runtime.tick(&mut store).unwrap();
        let status = store
            .execution_attempt(source_input.envelope().attempt_id, true)
            .unwrap();
        if status.items[0].execution == ExecutionState::Succeeded {
            break;
        }
        assert!(Instant::now() < deadline, "source runner did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
    let source_result_id = store
        .execution_current_result(
            source_input.envelope().attempt_id,
            source_input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let source_result = store
        .execution_result(source_input.envelope().attempt_id, source_result_id)
        .unwrap();
    store
        .validate_execution_result(source_input.envelope().attempt_id, source_result_id)
        .unwrap();
    let preview = store
        .source_preview(source_input.envelope().attempt_id, source_result_id, 0, 50)
        .unwrap();
    let source_action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            source_input.envelope().attempt_id,
            source_input.envelope().units[0].unit_id,
            vec![source_result_id],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    let source_receipt = store
        .adopt_execution(&source_action, &SourceAdoptionHandler)
        .unwrap();
    let source_result_bytes = source_result.bytes().to_vec();
    store.close().unwrap();

    let database = path.join(super::super::DATABASE_FILENAME);
    let mut connection = Connection::open(&database).unwrap();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    transaction
        .pragma_update(None, "defer_foreign_keys", true)
        .unwrap();
    transaction
        .execute_batch(
            "CREATE TEMP TABLE execution_results_copy AS SELECT * FROM main.execution_results;
             DROP TABLE main.execution_results;",
        )
        .unwrap();
    transaction
        .execute_batch(super::EXECUTION_RESULTS_TABLE_V3)
        .unwrap();
    transaction
        .execute_batch(
            "INSERT INTO main.execution_results SELECT * FROM temp.execution_results_copy;
             DROP TABLE temp.execution_results_copy;",
        )
        .unwrap();
    transaction
        .execute_batch("DROP TABLE translation_selections; DROP TABLE translation_revisions;")
        .unwrap();
    transaction
        .pragma_update(None, "user_version", 3i64)
        .unwrap();
    transaction.commit().unwrap();
    drop(connection);

    let reopened = ProjectStore::open(&path).unwrap();
    let persisted = reopened
        .execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(persisted.bytes(), result_bytes);
    assert_eq!(
        reopened
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Valid
    );
    assert_eq!(
        reopened
            .execution_result(source_input.envelope().attempt_id, source_result_id)
            .unwrap()
            .bytes(),
        source_result_bytes
    );
    let snapshot = reopened.content_scope().unwrap().current_snapshot.unwrap();
    assert_eq!(
        reopened.source_content(snapshot, 0, 50).unwrap().rows.len(),
        1
    );
    assert_eq!(
        reopened.adoption_receipt(source_action.action_id).unwrap(),
        Some(source_receipt)
    );
    let version: i64 = reopened
        .execution_connection()
        .unwrap()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::persistence::SCHEMA_VERSION);
    let violations: i64 = reopened
        .execution_connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
    let result_references: i64 = reopened
        .execution_connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('source_snapshots') WHERE \"table\"='execution_results'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(result_references, 1);
}

#[test]
fn storage_failure_does_not_leave_a_partial_attempt_and_readability_is_preserved() {
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    let input = fixture_input(&store, false);
    store
        .execution_connection()
        .unwrap()
        .pragma_update(None, "query_only", true)
        .unwrap();
    assert_eq!(
        store.enqueue_execution(&input).unwrap_err().code,
        ErrorCode::StorageFailed
    );
    assert!(
        store
            .execution_tasks(Revision::new(0).unwrap(), 50)
            .unwrap()
            .is_empty()
    );
    store
        .execution_connection()
        .unwrap()
        .pragma_update(None, "query_only", false)
        .unwrap();
    store.enqueue_execution(&input).unwrap();
    let selected = input.envelope().items[0].item_id;
    let retry = input.retry(&[selected]).unwrap();
    store.enqueue_execution(&retry).unwrap();
    assert!(
        store
            .dispatch_execution_item(input.envelope().attempt_id, selected)
            .is_err()
    );
    let duplicate = input.retry(&[selected]).unwrap();
    assert_eq!(
        store.enqueue_execution(&duplicate).unwrap_err().code,
        ErrorCode::Unauthorized
    );
}

#[test]
fn corrupt_retry_projection_cannot_authorize_replaying_an_unsafe_failure() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("project");
    let mut store = store(&path);
    let input = fixture_input(&store, false);
    let item = input.envelope().items[0].item_id;
    store.enqueue_execution(&input).unwrap();
    let produced = produce(&mut store, &input, item);
    let mut failed = produced.envelope().clone();
    failed.outcome = ExecutionState::Failed;
    failed.output = None;
    failed.diagnostic = Some(Diagnostic {
        code: "not-safe-to-replay".into(),
        retry_safe: false,
    });
    let failed = FixedResult::capture(failed, &input, produced.envelope().dispatch_token).unwrap();
    store.save_execution_result(&failed).unwrap();
    store.close().unwrap();
    let connection = Connection::open(path.join(super::super::DATABASE_FILENAME)).unwrap();
    connection
        .execute(
            "UPDATE execution_items SET retry_safe=1 WHERE item_id=?1",
            [item.to_string()],
        )
        .unwrap();
    drop(connection);
    let mut reopened = ProjectStore::open(&path).unwrap();
    let view = reopened
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(
        view.items
            .iter()
            .find(|status| status.item_id == item)
            .unwrap()
            .validation,
        ValidationState::Invalid
    );
    let recovery = reopened
        .execution_recovery(input.envelope().attempt_id, false)
        .unwrap();
    assert!(
        recovery
            .units
            .iter()
            .all(|unit| !unit.actions.contains(&RecoveryAction::RetrySafeFailure))
    );
    assert!(
        reopened
            .execution_retry_input(input.envelope().attempt_id, &[item])
            .is_err()
    );
    assert!(
        reopened
            .enqueue_execution(&input.retry(&[item]).unwrap())
            .is_err()
    );
    assert_eq!(
        reopened
            .execution_result(input.envelope().attempt_id, failed.envelope().result_id)
            .unwrap()
            .bytes(),
        failed.bytes()
    );
}

#[test]
fn execution_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_EXECUTION_PROJECT") else {
        return;
    };
    let _schema = TestSchema::enable();
    let mut store = ProjectStore::open(&path).unwrap();
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    if std::env::var("TSUMUGI_EXECUTION_CRASH").as_deref() == Ok("after-runner-call") {
        struct InterruptedRunner;
        impl Runner for InterruptedRunner {
            fn capability_id(&self) -> &str {
                "controlled"
            }
            fn capability_version(&self) -> &str {
                "1"
            }
            fn run(
                &self,
                _: DispatchRequest,
                _: Cancellation,
                _: ResultSender,
            ) -> Result<(), ExecutionError> {
                crash_hook("after-runner-call");
                unreachable!()
            }
        }
        let request = store
            .dispatch_execution_item(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap();
        let (sender, _receiver) = result_channel();
        InterruptedRunner
            .run(request, Cancellation::default(), sender)
            .unwrap();
    }
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let action = action(&mut store, &input, &[result]);
    store.adopt_execution(&action, &Handler).unwrap();
    store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[1].item_id,
        )
        .unwrap();
    crash_hook("partially-committed-batch");
    panic!("configured crash boundary was not reached");
}

#[test]
fn grouped_retry_reuses_successes_and_adopts_the_whole_unit_after_reopen() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("project");
    let mut store = store(&path);
    install_targets(&store);
    let input = fixture_input(&store, true);
    store.enqueue_execution(&input).unwrap();
    let mut successful = Vec::new();
    for item in &input.envelope().items[..2] {
        let result = produce(&mut store, &input, item.item_id);
        store.save_execution_result(&result).unwrap();
        store
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        successful.push(result);
    }
    let failed = input.envelope().items[2].item_id;
    let request = store
        .dispatch_execution_item(input.envelope().attempt_id, failed)
        .unwrap();
    let failure = FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: failed,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: "controlled".into(),
            capability_version: "1".into(),
            outcome: ExecutionState::Failed,
            output: None,
            diagnostic: Some(Diagnostic {
                code: "temporary".into(),
                retry_safe: true,
            }),
        },
        &input,
        request.dispatch_token,
    )
    .unwrap();
    store.save_execution_result(&failure).unwrap();
    let plan = store
        .execution_recovery(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(
        plan.units[0].actions,
        vec![RecoveryAction::RetrySafeFailure]
    );
    assert_eq!(plan.units[0].remaining_item_ids, vec![failed]);
    let retry = store
        .execution_retry_input(input.envelope().attempt_id, &[failed])
        .unwrap();
    assert_eq!(retry.envelope().reused_results.len(), 2);
    store.enqueue_execution(&retry).unwrap();
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    let view = reopened
        .execution_attempt(retry.envelope().attempt_id, false)
        .unwrap();
    assert_eq!((view.progress.succeeded, view.progress.queued), (2, 1));
    for result in &successful {
        assert!(
            reopened
                .dispatch_execution_item(retry.envelope().attempt_id, result.envelope().item_id)
                .is_err()
        );
        assert_eq!(
            reopened
                .execution_result(retry.envelope().attempt_id, result.envelope().result_id)
                .unwrap()
                .bytes(),
            result.bytes()
        );
    }
    let last = produce(&mut reopened, &retry, failed);
    reopened.save_execution_result(&last).unwrap();
    reopened
        .validate_execution_result(retry.envelope().attempt_id, last.envelope().result_id)
        .unwrap();
    successful.push(last);
    let prepared = action(&mut reopened, &retry, &successful);
    let receipt = reopened.adopt_execution(&prepared, &Handler).unwrap();
    assert_eq!(receipt.changes.len(), 3);
    assert_eq!(
        reopened
            .execution_attempt(retry.envelope().attempt_id, false)
            .unwrap()
            .progress
            .adopted,
        3
    );
    let records: i64 = reopened
        .execution_connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM execution_results", [], |r| r.get(0))
        .unwrap();
    assert_eq!(records, 4);
    assert_eq!(
        reopened
            .execution_recovery(input.envelope().attempt_id, false)
            .unwrap()
            .units[0]
            .blocked_reason
            .as_deref(),
        Some("continued-in-new-attempt")
    );
}

#[test]
fn duplicate_adoption_commands_compete_for_one_durable_receipt() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    install_targets(&store);
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let prepared = action(&mut store, &input, &[result]);
    let store = std::sync::Arc::new(std::sync::Mutex::new(store));
    let start = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let store = store.clone();
        let start = start.clone();
        let action = prepared.clone();
        threads.push(std::thread::spawn(move || {
            start.wait();
            store
                .lock()
                .unwrap()
                .adopt_execution(&action, &Handler)
                .unwrap()
        }));
    }
    start.wait();
    let first = threads.remove(0).join().unwrap();
    let second = threads.remove(0).join().unwrap();
    assert_eq!(first, second);
    let guard = store.lock().unwrap();
    let count: i64 = guard
        .execution_connection()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let updated: i64 = guard
        .execution_connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM fixture_targets WHERE revision=2",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(updated, 1);
}

#[test]
fn concurrent_cancel_and_adoption_have_one_transaction_order() {
    let _schema = TestSchema::enable();
    for _ in 0..8 {
        let parent = tempfile::tempdir().unwrap();
        let mut store = store(&parent.path().join("project"));
        install_targets(&store);
        let input = fixture_input(&store, false);
        store.enqueue_execution(&input).unwrap();
        let result = produce(&mut store, &input, input.envelope().items[0].item_id);
        store.save_execution_result(&result).unwrap();
        store
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let prepared = action(&mut store, &input, &[result]);
        let store = std::sync::Arc::new(std::sync::Mutex::new(store));
        let start = std::sync::Arc::new(std::sync::Barrier::new(3));
        let adopter = {
            let store = store.clone();
            let start = start.clone();
            let action = prepared.clone();
            std::thread::spawn(move || {
                start.wait();
                store.lock().unwrap().adopt_execution(&action, &Handler)
            })
        };
        let canceller = {
            let store = store.clone();
            let start = start.clone();
            let task = input.envelope().task_id;
            std::thread::spawn(move || {
                start.wait();
                store
                    .lock()
                    .unwrap()
                    .cancel_execution(task, ExecutionId::new())
                    .unwrap()
            })
        };
        start.wait();
        let adopted = adopter.join().unwrap();
        canceller.join().unwrap();
        let mut store = store.lock().unwrap();
        let receipts: i64 = store
            .execution_connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r.get(0))
            .unwrap();
        let changed: i64 = store
            .execution_connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM fixture_targets WHERE value='applied'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        match adopted {
            Ok(receipt) => {
                assert_eq!((receipts, changed), (1, 1));
                assert_eq!(store.adopt_execution(&prepared, &Handler).unwrap(), receipt);
            }
            Err(error) => {
                assert_eq!(error.code, ErrorCode::Cancelled);
                assert_eq!((receipts, changed), (0, 0));
            }
        }
        assert!(
            store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id
                )
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn subprocess_crash_boundaries_preserve_outputs_and_atomic_adoption() {
    let _schema = TestSchema::enable();
    for point in [
        "after-enqueue",
        "after-dispatch-intent",
        "after-runner-call",
        "after-output",
        "after-validation",
        "before-adoption-commit",
        "after-adoption-commit",
        "partially-committed-batch",
    ] {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("project");
        let store = store(&path);
        install_targets(&store);
        store.close().unwrap();
        let hook = parent.path().join("hook");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::ledger::tests::execution_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_EXECUTION_PROJECT", &path)
            .env("TSUMUGI_EXECUTION_CRASH", point)
            .env("TSUMUGI_EXECUTION_HOOK", &hook)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned crash helper timed out");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(!status.success());
        assert_eq!(std::fs::read_to_string(&hook).unwrap(), point);
        let reopened = ProjectStore::open(&path).unwrap();
        let task = reopened
            .execution_tasks(Revision::new(0).unwrap(), 50)
            .unwrap()
            .remove(0);
        let attempt = reopened.execution_attempt_ids(task.task_id).unwrap()[0];
        let view = reopened.execution_attempt(attempt, false).unwrap();
        let connection = reopened.execution_connection().unwrap();
        let applied: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM fixture_targets WHERE value='applied'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let receipts: i64 = connection
            .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r.get(0))
            .unwrap();
        if matches!(point, "after-adoption-commit" | "partially-committed-batch") {
            assert_eq!((applied, receipts), (1, 1));
            assert_eq!(view.progress.adopted, 1);
        } else {
            assert_eq!((applied, receipts), (0, 0));
        }
        if point == "after-enqueue" {
            assert_eq!(view.progress.queued, 3);
        } else if matches!(point, "after-dispatch-intent" | "after-runner-call") {
            assert_eq!(view.progress.unknown, 1);
        } else {
            assert_eq!(view.progress.succeeded, 1);
        }
        if point == "after-output" {
            assert_eq!(
                view.items
                    .iter()
                    .filter(|item| item.validation == ValidationState::Pending)
                    .count(),
                1
            );
        }
        if point == "partially-committed-batch" {
            assert_eq!(
                (
                    view.progress.adopted,
                    view.progress.unknown,
                    view.progress.queued
                ),
                (1, 1, 1)
            );
            let plan = reopened.execution_recovery(attempt, false).unwrap();
            assert_eq!(
                plan.units
                    .iter()
                    .filter(|u| u.actions.contains(&RecoveryAction::ViewReceipt))
                    .count(),
                1
            );
            assert_eq!(
                plan.units
                    .iter()
                    .filter(|u| u.actions.contains(&RecoveryAction::QueryOutcome))
                    .count(),
                1
            );
            assert_eq!(
                plan.units
                    .iter()
                    .filter(|u| u.actions.contains(&RecoveryAction::ResumeUndispatched))
                    .count(),
                1
            );
        }
    }
}

#[test]
fn cancellation_preserves_committed_failed_and_undispatched_items_and_late_evidence() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    install_targets(&store);
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let a = input.envelope().items[0].item_id;
    let b = input.envelope().items[1].item_id;
    let c = input.envelope().items[2].item_id;
    let first = produce(&mut store, &input, a);
    store.save_execution_result(&first).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, first.envelope().result_id)
        .unwrap();
    let prepared = action(&mut store, &input, &[first]);
    store.adopt_execution(&prepared, &Handler).unwrap();
    let eventual = produce(&mut store, &input, b);
    let mut failed = eventual.envelope().clone();
    failed.result_id = ExecutionId::new();
    failed.outcome = ExecutionState::Failed;
    failed.output = None;
    failed.diagnostic = Some(Diagnostic {
        code: "temporary".into(),
        retry_safe: true,
    });
    let failed = FixedResult::capture(failed, &input, eventual.envelope().dispatch_token).unwrap();
    store.save_execution_result(&failed).unwrap();
    store
        .cancel_execution(input.envelope().task_id, ExecutionId::new())
        .unwrap();
    let view = store
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(
        (
            view.progress.adopted,
            view.progress.failed,
            view.progress.cancelled
        ),
        (1, 1, 1)
    );
    assert!(
        store
            .dispatch_execution_item(input.envelope().attempt_id, c)
            .is_err()
    );
    let mut late = eventual.envelope().clone();
    late.supersedes = Some(failed.envelope().result_id);
    let late = FixedResult::capture(late, &input, eventual.envelope().dispatch_token).unwrap();
    store.save_execution_result(&late).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, late.envelope().result_id)
        .unwrap();
    let view = store
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(
        (
            view.progress.adopted,
            view.progress.succeeded,
            view.progress.cancelled
        ),
        (1, 2, 1)
    );
    assert!(view.items.iter().all(|item| item.cancellation_requested));
    assert!(
        store
            .execution_retry_input(input.envelope().attempt_id, &[a])
            .is_err()
    );
    let plan = store
        .execution_recovery(input.envelope().attempt_id, false)
        .unwrap();
    assert!(
        plan.units
            .iter()
            .find(|unit| unit.item_ids.contains(&a))
            .unwrap()
            .actions
            .contains(&RecoveryAction::ViewReceipt)
    );
    assert_eq!(
        store
            .execution_connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM fixture_targets WHERE revision=2",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .execution_connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
