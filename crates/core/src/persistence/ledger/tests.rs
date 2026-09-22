use super::*;
use crate::{PersistenceErrorCode, ProjectMetadata};
use serde_json::json;
use std::{path::Path, process::Command};

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
    connection.pragma_update(None, "user_version", 2).unwrap();
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
fn execution_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_EXECUTION_PROJECT") else {
        return;
    };
    let _schema = TestSchema::enable();
    let mut store = ProjectStore::open(&path).unwrap();
    let input = fixture_input(&store, false);
    store.enqueue_execution(&input).unwrap();
    let result = produce(&mut store, &input, input.envelope().items[0].item_id);
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let action = action(&mut store, &input, &[result]);
    store.adopt_execution(&action, &Handler).unwrap();
    panic!("configured crash boundary was not reached");
}

#[test]
fn subprocess_crash_boundaries_preserve_outputs_and_atomic_adoption() {
    let _schema = TestSchema::enable();
    for point in [
        "after-enqueue",
        "after-dispatch-intent",
        "after-output",
        "after-validation",
        "before-adoption-commit",
        "after-adoption-commit",
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
        if point == "after-adoption-commit" {
            assert_eq!((applied, receipts), (1, 1));
            assert_eq!(view.progress.adopted, 1);
        } else {
            assert_eq!((applied, receipts), (0, 0));
        }
        if point == "after-enqueue" {
            assert_eq!(view.progress.queued, 3);
        } else if point == "after-dispatch-intent" {
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
    }
}
