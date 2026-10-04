//! Current-schema storage and saved-release invariants, using real local producers.
use super::*;
use crate::{
    ReleaseAdoptionHandler,
    execution::{AdoptionAction, ErrorCode, ExecutionId},
};
use rusqlite::types::Value;
use std::{
    collections::BTreeMap,
    process::{Command, Stdio},
    time::Instant,
};

fn facts(connection: &Connection) -> BTreeMap<String, Vec<Vec<Value>>> {
    let tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap().query_map([], |r| r.get::<_, String>(0)).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let columns = connection
                .prepare(&format!("SELECT * FROM {table}"))
                .unwrap()
                .column_count();
            let order = (1..=columns)
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let rows = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
                .unwrap()
                .query_map([], |row| {
                    (0..columns)
                        .map(|n| row.get::<_, Value>(n))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (table, rows)
        })
        .collect()
}

fn release(store: &mut ProjectStore, action: &AdoptionAction) -> ExecutionId {
    let receipt = store
        .adopt_execution(action, &ReleaseAdoptionHandler)
        .unwrap();
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}

fn assert_current(store: &ProjectStore) {
    let c = store.connection().unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert_eq!(
        c.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
    assert_eq!(
        c.pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(
        !c.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap()
    );
}

#[test]
fn current_sqlite_full_keeps_release_adoption_atomic_and_retry_idempotent() {
    let (_temp, mut store, action) = review::tests::current_release_fixture(true);
    let path = store.directory().to_path_buf();
    let c = store.connection().unwrap();
    c.execute_batch("VACUUM").unwrap();
    let original = facts(c);
    let pages: i64 = c
        .pragma_query_value(None, "page_count", |r| r.get(0))
        .unwrap();
    c.pragma_update(None, "max_page_count", pages).unwrap();
    // This is SQLite's actual page-limit error, not a mocked disk failure.
    assert!(
        matches!(c.execute_batch("CREATE TABLE full_probe (id INTEGER)"),
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DiskFull)
    );
    assert_eq!(
        store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap_err()
            .code,
        ErrorCode::StorageFailed
    );
    assert!(store.connection().unwrap().is_autocommit());
    assert_eq!(facts(store.connection().unwrap()), original);
    assert!(
        ledger::read_receipt(store.connection().unwrap(), action.action_id)
            .unwrap()
            .is_none()
    );
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_current(&reopened);
    assert_eq!(facts(reopened.connection().unwrap()), original);
    // Remove the isolated test limit before the explicit retry.
    reopened
        .connection()
        .unwrap()
        .pragma_update(None, "max_page_count", 4_294_967_294i64)
        .unwrap();
    let id = release(&mut reopened, &action);
    let committed = facts(reopened.connection().unwrap());
    let bytes = reopened.release_artifact(id, "zh-CN").unwrap().1;
    assert!(bytes.len() > 8192);
    assert_eq!(release(&mut reopened, &action), id);
    assert_eq!(facts(reopened.connection().unwrap()), committed);
    reopened.close().unwrap();
    let final_store = ProjectStore::open(&path).unwrap();
    assert_eq!(final_store.release_artifact(id, "zh-CN").unwrap().1, bytes);
}

#[test]
fn current_release_adoption_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_CURRENT_RELEASE_PROJECT") else {
        return;
    };
    let action: AdoptionAction =
        serde_json::from_slice(&fs::read(Path::new(&path).join("action.json")).unwrap()).unwrap();
    let mut store = ProjectStore::open(&path).unwrap();
    store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    panic!("configured adoption boundary did not terminate");
}

#[test]
fn current_release_process_termination_has_original_or_complete_committed_state() {
    for point in ["before-adoption-commit", "after-adoption-commit"] {
        let (temp, store, action) = review::tests::current_release_fixture(false);
        let path = store.directory().to_path_buf();
        let original = facts(store.connection().unwrap());
        fs::write(
            path.join("action.json"),
            serde_json::to_vec(&action).unwrap(),
        )
        .unwrap();
        store.close().unwrap();
        let hook = temp.path().join("hook");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::current_tests::current_release_adoption_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_CURRENT_RELEASE_PROJECT", &path)
            .env("TSUMUGI_EXECUTION_CRASH", point)
            .env("TSUMUGI_EXECUTION_HOOK", &hook)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() > end {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned adoption child timed out");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(!status.success());
        assert_eq!(fs::read_to_string(hook).unwrap(), point);
        let mut reopened = ProjectStore::open(&path).unwrap();
        assert_current(&reopened);
        let receipt =
            ledger::read_receipt(reopened.connection().unwrap(), action.action_id).unwrap();
        if point == "before-adoption-commit" {
            assert!(receipt.is_none());
            assert_eq!(facts(reopened.connection().unwrap()), original);
        } else {
            let receipt = receipt.unwrap();
            let id = ExecutionId::parse(&receipt.changes[0].id).unwrap();
            assert_eq!(reopened.release_view(id).unwrap().artifacts.len(), 1);
            assert!(!reopened.release_artifact(id, "zh-CN").unwrap().1.is_empty());
            assert_eq!(
                reopened
                    .execution_attempt(action.attempt_id, false)
                    .unwrap()
                    .progress
                    .adopted,
                1
            );
        }
        let id = release(&mut reopened, &action);
        let committed = facts(reopened.connection().unwrap());
        assert_eq!(release(&mut reopened, &action), id);
        assert_eq!(facts(reopened.connection().unwrap()), committed);
        let bytes = reopened.release_artifact(id, "zh-CN").unwrap().1;
        reopened.close().unwrap();
        assert_eq!(
            ProjectStore::open(&path)
                .unwrap()
                .release_artifact(id, "zh-CN")
                .unwrap()
                .1,
            bytes
        );
    }
}

#[test]
fn current_failed_delivery_preserves_release_receipts_and_complete_snapshot() {
    let (temp, mut store, action) = review::tests::current_release_fixture(false);
    let path = store.directory().to_path_buf();
    let id = release(&mut store, &action);
    let original_release = store.release_view(id).unwrap();
    let (artifact, bytes) = store.release_artifact(id, "zh-CN").unwrap();
    let action_id = ExecutionId::new();
    let pending = store
        .begin_delivery(action_id, id, "isolated-export", false)
        .unwrap();
    let mut failed = pending.files;
    failed[0].state = DeliveryFileState::Failed;
    let receipt = store.finish_delivery(action_id, failed).unwrap();
    assert_eq!(receipt.state, DeliveryState::Failed);
    let before_replay = facts(store.connection().unwrap());
    assert_eq!(
        store
            .begin_delivery(action_id, id, "isolated-export", false)
            .unwrap(),
        receipt
    );
    assert_eq!(facts(store.connection().unwrap()), before_replay);
    assert_eq!(
        store
            .begin_delivery(action_id, id, "changed-export", false)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    let retry = ExecutionId::new();
    let mut files = store
        .begin_delivery(retry, id, "isolated-export", false)
        .unwrap()
        .files;
    files[0].actual_sha256 = Some(artifact.sha256);
    files[0].state = DeliveryFileState::Succeeded;
    let saved = store.finish_delivery(retry, files).unwrap();
    assert_eq!(saved.state, DeliveryState::Succeeded);
    assert_eq!(store.release_view(id).unwrap(), original_release);
    assert_eq!(store.release_artifact(id, "zh-CN").unwrap().1, bytes);
    let all_facts = facts(store.connection().unwrap());
    // Exercise the existing consistent snapshot mechanism at the current schema.
    backup_before_migration(store.connection().unwrap(), temp.path(), SCHEMA_VERSION).unwrap();
    let backup_path = fs::read_dir(temp.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|x| x == "backup"))
        .unwrap();
    let backup =
        Connection::open_with_flags(backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    backup.pragma_update(None, "foreign_keys", true).unwrap();
    validate_schema_shape(&backup, false, true, true, true, true, true).unwrap();
    assert_eq!(facts(&backup), all_facts);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_current(&reopened);
    assert_eq!(reopened.release_artifact(id, "zh-CN").unwrap().1, bytes);
    assert_eq!(
        reopened
            .begin_delivery(retry, id, "isolated-export", false)
            .unwrap(),
        saved
    );
    assert_eq!(facts(reopened.connection().unwrap()), all_facts);
}

#[test]
fn current_shape_and_release_corruption_are_refused_without_reset() {
    for damage in [
        "DROP TABLE execution_effects",
        "UPDATE release_artifacts SET release_id='123e4567-e89b-42d3-a456-426614174000'",
        "DELETE FROM release_artifacts",
        "UPDATE release_artifacts SET bytes=X'7B7D'",
        "UPDATE release_records SET manifest=X'7B7D'",
    ] {
        let (_temp, mut store, action) = review::tests::current_release_fixture(false);
        let path = store.directory().to_path_buf();
        release(&mut store, &action);
        store.close().unwrap();
        let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
        // Deliberately corrupt the isolated fixture despite enforced production FKs.
        c.pragma_update(None, "foreign_keys", false).unwrap();
        c.execute_batch(damage).unwrap();
        drop(c);
        let original = fs::read(path.join(DATABASE_FILENAME)).unwrap();
        assert_eq!(
            ProjectStore::open(&path).unwrap_err().code(),
            PersistenceErrorCode::CorruptProject,
            "{damage}"
        );
        assert_eq!(fs::read(path.join(DATABASE_FILENAME)).unwrap(), original);
    }
}

#[test]
fn current_unsupported_profile_is_distinct_and_never_converted() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    ProjectStore::create(
        &path,
        ProjectMetadata::create("Profile", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap()
    .close()
    .unwrap();
    let mut c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
    c.pragma_update(None, "synchronous", "NORMAL").unwrap();
    assert_eq!(
        validate_existing_connection(&mut c, &path)
            .unwrap_err()
            .code(),
        PersistenceErrorCode::UnsupportedStorage
    );
    assert_eq!(
        c.pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    c.pragma_update(None, "journal_mode", "WAL").unwrap();
    assert_eq!(
        validate_existing_connection(&mut c, &path)
            .unwrap_err()
            .code(),
        PersistenceErrorCode::UnsupportedStorage
    );
    assert_eq!(
        c.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    let original = facts(&c);
    drop(c);
    assert_eq!(
        ProjectStore::open(&path).unwrap_err().code(),
        PersistenceErrorCode::UnsupportedStorage
    );
    let c = Connection::open(path.join(DATABASE_FILENAME)).unwrap();
    assert_eq!(facts(&c), original);
    c.pragma_update(None, "journal_mode", "DELETE").unwrap();
    c.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    drop(c);
    let error = ProjectStore::open(&path).unwrap_err();
    assert_eq!(error.code(), PersistenceErrorCode::UnsupportedSchema);
    assert_eq!(error.found_schema_version(), Some(SCHEMA_VERSION + 1));
}
