use rusqlite::Connection;
use std::fs;
use tsumugi_core::{PersistenceError, PersistenceStage, ProjectStore};

#[test]
fn old_project_and_backup_are_refused_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("old-project");
    fs::create_dir(&project).unwrap();
    let database = project.join("project.sqlite3");
    let lock = project.join(".tsumugi.lock");
    fs::write(&lock, b"").unwrap();

    // The fixture contains a real schema 74 database with committed work.
    let connection = Connection::open(&database).unwrap();
    connection.pragma_update(None, "foreign_keys", false).unwrap();
    connection
        .execute_batch(include_str!("fixtures/sdk-v1-capture/project-v74.sql"))
        .unwrap();
    drop(connection);
    let original = fs::read(&database).unwrap();

    let destination = temp.path().join("refused-restore");
    assert_eq!(
        ProjectStore::restore_backup(&database, &destination).unwrap_err(),
        PersistenceError::UnsupportedSchema {
            found_version: 74,
            stage: PersistenceStage::Create,
        }
    );
    assert!(!destination.exists());
    assert_eq!(
        ProjectStore::open(&project).unwrap_err(),
        PersistenceError::UnsupportedSchema {
            found_version: 74,
            stage: PersistenceStage::Open,
        }
    );
    assert_eq!(fs::read(&database).unwrap(), original);
    assert_eq!(fs::read(&lock).unwrap(), b"");
    assert_eq!(fs::read_dir(&project).unwrap().count(), 2);
}
