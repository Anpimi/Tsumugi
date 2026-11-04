#![cfg(feature = "legacy-desktop-domain")]

use rusqlite::{Connection, types::Value};
use std::collections::BTreeMap;
use tsumugi_core::{ProjectStore, execution::ExecutionId};

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
