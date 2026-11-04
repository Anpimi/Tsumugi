#![cfg(feature = "legacy-desktop-domain")]

use rusqlite::{Connection, types::Value};
use std::collections::BTreeMap;
use tsumugi_core::{ProjectStore, execution::ExecutionId};

fn old_backup(path: &std::path::Path) -> BTreeMap<String, Vec<Vec<Value>>> {
    let connection = Connection::open(path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", false)
        .unwrap();
    connection
        .execute_batch(include_str!("fixtures/sdk-v1-capture/project-v74.sql"))
        .unwrap();
    records(&connection)
}

#[test]
fn supported_old_backup_restores_upgrades_and_edits_without_changing_the_original() {
    let temp = tempfile::tempdir().unwrap();
    let backup = temp.path().join("original-v74.backup");
    let original = old_backup(&backup);
    let original_bytes = std::fs::read(&backup).unwrap();
    let restored_path = temp.path().join("restored");
    ProjectStore::restore_backup(&backup, &restored_path).unwrap();
    let restored_database = Connection::open(restored_path.join("project.sqlite3")).unwrap();
    assert_eq!(
        restored_database
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        75
    );
    assert_eq!(records(&restored_database), original);
    drop(restored_database);
    let snapshots: Vec<_> = std::fs::read_dir(&restored_path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("project.sqlite3.pre-v74-")
        })
        .collect();
    assert_eq!(snapshots.len(), 1);
    let snapshot = Connection::open(&snapshots[0]).unwrap();
    assert_eq!(
        snapshot
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        74
    );
    assert_eq!(records(&snapshot), original);
    drop(snapshot);
    let mut restored = ProjectStore::open(&restored_path).unwrap();
    let instance = restored
        .restored_instance()
        .expect("restored drafts use their own instance");
    let metadata = restored.metadata().unwrap();
    restored
        .rename(metadata.metadata_revision(), "Edited restored backup")
        .unwrap();
    restored.close().unwrap();
    let reopened = ProjectStore::open(&restored_path).unwrap();
    assert_eq!(reopened.restored_instance(), Some(instance));
    assert_eq!(
        reopened.metadata().unwrap().project_id(),
        metadata.project_id()
    );
    assert_eq!(
        reopened.metadata().unwrap().display_name(),
        "Edited restored backup"
    );
    reopened.close().unwrap();
    assert_eq!(std::fs::read(&backup).unwrap(), original_bytes);
    assert_eq!(records(&Connection::open(&backup).unwrap()), original);
}

#[test]
fn old_backup_restore_refuses_corruption_unsupported_versions_and_existing_targets() {
    use tsumugi_core::PersistenceErrorCode;
    let temp = tempfile::tempdir().unwrap();
    for version in [60, 76] {
        let backup = temp.path().join(format!("unsupported-{version}.backup"));
        old_backup(&backup);
        Connection::open(&backup)
            .unwrap()
            .pragma_update(None, "user_version", version)
            .unwrap();
        let bytes = std::fs::read(&backup).unwrap();
        let destination = temp.path().join(format!("refused-{version}"));
        assert_eq!(
            ProjectStore::restore_backup(&backup, &destination)
                .unwrap_err()
                .code(),
            PersistenceErrorCode::UnsupportedSchema
        );
        assert!(!destination.exists());
        assert_eq!(std::fs::read(backup).unwrap(), bytes);
    }
    let corrupt = temp.path().join("corrupt-v74.backup");
    old_backup(&corrupt);
    Connection::open(&corrupt)
        .unwrap()
        .execute("UPDATE source_files SET bytes=x'00'", [])
        .unwrap();
    let original = std::fs::read(&corrupt).unwrap();
    let destination = temp.path().join("corrupt-restored");
    assert_eq!(
        ProjectStore::restore_backup(&corrupt, &destination)
            .unwrap_err()
            .code(),
        PersistenceErrorCode::CorruptProject
    );
    assert!(!destination.exists());
    assert_eq!(std::fs::read(corrupt).unwrap(), original);
    let valid = temp.path().join("valid-v74.backup");
    old_backup(&valid);
    let existing = temp.path().join("existing");
    std::fs::create_dir(&existing).unwrap();
    std::fs::write(existing.join("keep.txt"), b"keep existing content").unwrap();
    assert_eq!(
        ProjectStore::restore_backup(&valid, &existing)
            .unwrap_err()
            .code(),
        PersistenceErrorCode::DestinationConflict
    );
    assert_eq!(
        std::fs::read(existing.join("keep.txt")).unwrap(),
        b"keep existing content"
    );
    assert!(!existing.join("project.sqlite3").exists());
}

fn records(connection: &Connection) -> BTreeMap<String, Vec<Vec<Value>>> {
    let tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, Value>(column))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (table, rows)
        })
        .collect()
}

#[test]
fn actual_schema_74_project_upgrades_without_rewriting_captures_or_human_work() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", false)
        .unwrap();
    // This is the complete old DDL and records emitted by unmodified baseline
    // Core, not a current database relabeled with an older user_version.
    connection
        .execute_batch(include_str!("fixtures/sdk-v1-capture/project-v74.sql"))
        .unwrap();
    let original = records(&connection);
    drop(connection);
    std::fs::write(temp.path().join(".tsumugi.lock"), b"").unwrap();
    let fixture: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixtures/sdk-v1-capture/project-v74.json")).unwrap();
    let id = |field: &str| ExecutionId::parse(fixture[field].as_str().unwrap()).unwrap();
    let store = ProjectStore::open(temp.path()).unwrap();
    let input = store.execution_input(id("attemptId")).unwrap();
    assert_eq!(input.digest(), fixture["inputDigest"]);
    let result = store
        .execution_result(id("attemptId"), id("resultId"))
        .unwrap();
    assert_eq!(result.digest(), fixture["resultDigest"]);
    let bundle = store.source_bundle(id("snapshotId")).unwrap();
    assert_eq!(
        bundle.files[1].text().unwrap(),
        "{\"title\":\"Original 👩🏽‍💻 é\",\"description\":\"Keep original\"}\r\n"
    );
    let history = store
        .translation_history(id("projectId"), id("unitId"), "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(history.rows[0].text, "已保留的人工译文");
    store.close().unwrap();
    let upgraded = Connection::open(&path).unwrap();
    assert_eq!(
        upgraded
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        75
    );
    assert_eq!(records(&upgraded), original);
    let snapshots: Vec<_> = std::fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("project.sqlite3.pre-v74-")
        })
        .collect();
    assert_eq!(snapshots.len(), 1);
    let backup = Connection::open(&snapshots[0]).unwrap();
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        74
    );
    assert_eq!(records(&backup), original);
    drop(upgraded);
    let reopened = ProjectStore::open(temp.path()).unwrap();
    assert_eq!(reopened.source_bundle(id("snapshotId")).unwrap(), bundle);
    assert_eq!(
        reopened.execution_input(id("attemptId")).unwrap().bytes(),
        input.bytes()
    );
    reopened.close().unwrap();
    assert_eq!(
        std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_str().unwrap().ends_with(".backup"))
            .count(),
        1
    );
}
