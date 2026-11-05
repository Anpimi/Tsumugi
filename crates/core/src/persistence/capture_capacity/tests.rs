use super::*;
use crate::{ProjectStore, persistence::legacy_fixture_rows};
use std::{path::Path, process::Command};

fn legacy_project(path: &Path) {
    std::fs::create_dir(path).unwrap();
    let connection = Connection::open(path.join("project.sqlite3")).unwrap();
    connection.pragma_update(None, "foreign_keys", false).unwrap();
    // Schema 75 changed artifact interpretation, not schema 74's SQL shape.
    // Start with the exact baseline DDL/records, never relabel current tables.
    connection
        .execute_batch(include_str!(
            "../../../tests/fixtures/sdk-v1-capture/project-v74.sql"
        ))
        .unwrap();
    connection.pragma_update(None, "user_version", 75).unwrap();
    for (table, _) in TABLES {
        connection
            .execute_batch(&format!("UPDATE {table} SET rowid=rowid+1000"))
            .unwrap();
    }
    connection.pragma_update(None, "foreign_keys", true).unwrap();
    std::fs::write(path.join(".tsumugi.lock"), b"").unwrap();
}

fn assert_shape(connection: &Connection, version: i64) {
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        version
    );
    for (table, _) in TABLES {
        let current = super::super::content::TABLES
            .iter()
            .chain(super::super::ledger::TABLES)
            .find(|(name, _)| *name == table)
            .unwrap()
            .1;
        let actual: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(actual, schema_sql(table, current, version));
    }
    assert!(
        !connection
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap()
    );
}

#[test]
fn capacity_upgrade_preserves_all_rows_rowid_gaps_and_original_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    legacy_project(&path);
    let original =
        legacy_fixture_rows(&Connection::open(path.join("project.sqlite3")).unwrap(), 75);
    ProjectStore::open(&path).unwrap().close().unwrap();
    let current = Connection::open(path.join("project.sqlite3")).unwrap();
    assert_shape(&current, 76);
    assert_eq!(legacy_fixture_rows(&current, 75), original);
    let snapshots: Vec<_> = std::fs::read_dir(&path)
        .unwrap()
        .map(|p| p.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("project.sqlite3.pre-v75-")
        })
        .collect();
    assert_eq!(snapshots.len(), 1);
    let saved = Connection::open(&snapshots[0]).unwrap();
    assert_shape(&saved, 75);
    assert_eq!(legacy_fixture_rows(&saved, 75), original);
    ProjectStore::open(&path).unwrap().close().unwrap();
}

#[test]
fn capacity_upgrade_crash_child() {
    let Some(path) = std::env::var_os("TSUMUGI_CAPACITY_PROJECT") else {
        return;
    };
    ProjectStore::open(Path::new(&path))
        .unwrap()
        .close()
        .unwrap();
}

#[test]
fn capacity_upgrade_interruption_keeps_a_complete_original_or_current_database() {
    for point in [
        "conversation-before-ddl",
        "capacity-after-source_sets",
        "capacity-after-source_files",
        "capacity-after-execution_attempts",
        "capacity-after-execution_results",
        "conversation-before-commit",
        "conversation-after-commit",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("project");
        legacy_project(&path);
        let original =
            legacy_fixture_rows(&Connection::open(path.join("project.sqlite3")).unwrap(), 75);
        let hook = temp.path().join("hook");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::capture_capacity::tests::capacity_upgrade_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_CAPACITY_PROJECT", &path)
            .env("TSUMUGI_MIGRATION_CRASH", point)
            .env("TSUMUGI_MIGRATION_HOOK", &hook)
            .output()
            .unwrap();
        assert!(!child.status.success(), "{point}");
        assert_eq!(std::fs::read_to_string(hook).unwrap(), point);
        // Opening SQLite performs normal hot-journal recovery after the child
        // process died; do not invoke another upgrade before checking atomicity.
        let connection = Connection::open(path.join("project.sqlite3")).unwrap();
        assert_shape(
            &connection,
            if point == "conversation-after-commit" {
                76
            } else {
                75
            },
        );
        assert_eq!(legacy_fixture_rows(&connection, 75), original, "{point}");
        drop(connection);
        ProjectStore::open(&path).unwrap().close().unwrap();
    }
}
