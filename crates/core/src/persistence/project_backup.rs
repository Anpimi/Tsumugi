//! Committed project snapshots, independent of the desktop draft and execution owners.

use super::*;
use crate::execution::ExecutionId;
use std::io::{Read, Write};

const RESTORED_PREFIX: &str = "tsumugi-restored-v1:";

impl ProjectStore {
    /// Save a standalone current-schema database to a new file. The desktop
    /// owner also checks work in progress that has not reached SQLite yet.
    pub fn backup_to(&self, destination: &Path) -> Result<(), PersistenceError> {
        let stage = PersistenceStage::Write;
        if self.is_reconciling() {
            return Err(PersistenceError::OutcomeUnknown { stage });
        }
        let snapshot = self
            .connection()?
            .unchecked_transaction()
            .map_err(|error| map_sqlite(error, stage))?;
        require_idle(&snapshot, stage)?;
        let parent = parent_directory(destination);
        let temporary = capture(&snapshot, parent, SCHEMA_VERSION, stage)?;
        validate_current_snapshot(&temporary, parent, stage)?;
        snapshot
            .commit()
            .map_err(|error| map_sqlite(error, stage))?;
        publish(temporary, destination, stage)?;
        sync_directory(parent, stage)
    }

    /// Restore a current-schema backup into a new directory. The project lock
    /// file is published only after the restored database passes normal validation.
    pub fn restore_backup(backup: &Path, destination: &Path) -> Result<(), PersistenceError> {
        let stage = PersistenceStage::Create;
        let source = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| map_sqlite(error, stage))?;
        fs::create_dir(destination).map_err(map_create_io)?;
        let result = (|| {
            let database = capture(&source, destination, SCHEMA_VERSION, stage)?;
            validate_current_snapshot(&database, destination, stage)?;
            let mut lock = tempfile::NamedTempFile::new_in(destination)
                .map_err(|error| map_io(error, stage))?;
            write!(lock, "{RESTORED_PREFIX}{}", ExecutionId::new())
                .map_err(|error| map_io(error, stage))?;
            publish(database, &destination.join(DATABASE_FILENAME), stage)?;
            sync_directory(destination, stage)?;
            publish(lock, &destination.join(LOCK_FILENAME), stage)?;
            sync_directory(destination, stage)?;
            sync_directory(parent_directory(destination), stage)
        })();
        if result.is_err() {
            // Only remove the directory if it is still empty.
            let _ = fs::remove_dir(destination);
        }
        result
    }
}

pub(super) fn read_restored_instance(
    lock: &mut File,
) -> Result<Option<ExecutionId>, PersistenceError> {
    let stage = PersistenceStage::Ownership;
    let mut marker = Vec::new();
    lock.take((RESTORED_PREFIX.len() + 37) as u64)
        .read_to_end(&mut marker)
        .map_err(|error| map_io(error, stage))?;
    if marker.is_empty() {
        return Ok(None);
    }
    let id = std::str::from_utf8(&marker)
        .ok()
        .and_then(|marker| marker.strip_prefix(RESTORED_PREFIX))
        .and_then(|id| {
            ExecutionId::parse(id)
                .ok()
                .filter(|parsed| parsed.to_string() == id)
        })
        .ok_or(PersistenceError::CorruptProject { stage })?;
    Ok(Some(id))
}

fn validate_current_snapshot(
    database: &tempfile::NamedTempFile,
    directory: &Path,
    stage: PersistenceStage,
) -> Result<(), PersistenceError> {
    // capture has already required the current schema, so this is only the
    // normal read-only validation branch and cannot run a migration.
    let mut validation =
        Connection::open_with_flags(database.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| map_sqlite(error, stage))?;
    validate_existing_connection(&mut validation, directory)?;
    require_idle(&validation, stage)
}

fn require_idle(connection: &Connection, stage: PersistenceStage) -> Result<(), PersistenceError> {
    let (active, unresolved): (bool, bool) = connection
        .query_row(
            "SELECT
            EXISTS(SELECT 1 FROM execution_items WHERE execution IN ('queued','dispatched'))
              OR EXISTS(SELECT 1 FROM release_deliveries WHERE state='pending'),
            EXISTS(SELECT 1 FROM execution_items i JOIN execution_effects e USING(attempt_id)
                WHERE i.execution='unknown' AND e.policy<>'read-only')
              OR EXISTS(SELECT 1 FROM execution_provider_requests WHERE state='unknown')
              OR EXISTS(SELECT 1 FROM release_deliveries WHERE state='unknown')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| map_sqlite(error, stage))?;
    if unresolved {
        return Err(PersistenceError::OutcomeUnknown { stage });
    }
    if active {
        return Err(PersistenceError::Busy { stage });
    }
    Ok(())
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

pub(super) fn write_schema_snapshot(
    connection: &Connection,
    directory: &Path,
    version: i64,
) -> Result<(), PersistenceError> {
    let stage = PersistenceStage::UpgradeSnapshot;
    let temporary = capture(connection, directory, version, stage)?;
    let path = directory.join(format!(
        "{DATABASE_FILENAME}.pre-v{version}-{}.backup",
        uuid::Uuid::new_v4()
    ));
    publish(temporary, &path, stage)?;
    sync_directory(directory, stage)
}

fn capture(
    connection: &Connection,
    directory: &Path,
    version: i64,
    stage: PersistenceStage,
) -> Result<tempfile::NamedTempFile, PersistenceError> {
    let temporary = tempfile::Builder::new()
        .prefix(".project-snapshot-")
        .tempfile_in(directory)
        .map_err(|error| map_io(error, stage))?;
    connection
        .backup(rusqlite::MAIN_DB, temporary.path(), None)
        .map_err(|error| map_sqlite(error, stage))?;
    let backup = Connection::open_with_flags(temporary.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| map_sqlite(error, stage))?;
    let application_id: i64 = backup
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|error| map_sqlite(error, stage))?;
    if application_id != APPLICATION_ID {
        return Err(PersistenceError::CorruptProject { stage });
    }
    let found_version: i64 = backup
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| map_sqlite(error, stage))?;
    if found_version != version {
        return Err(PersistenceError::UnsupportedSchema {
            found_version,
            stage,
        });
    }
    let check: String = backup
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| map_sqlite(error, stage))?;
    if check != "ok" {
        return Err(PersistenceError::CorruptProject { stage });
    }
    Ok(temporary)
}

fn publish(
    temporary: tempfile::NamedTempFile,
    destination: &Path,
    stage: PersistenceStage,
) -> Result<(), PersistenceError> {
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| map_io(error, stage))?;
    temporary.persist_noclobber(destination).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            PersistenceError::DestinationConflict { stage }
        } else {
            map_io(error.error, stage)
        }
    })?;
    Ok(())
}

fn sync_directory(path: &Path, stage: PersistenceStage) -> Result<(), PersistenceError> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| PersistenceError::OutcomeUnknown { stage })?;
    #[cfg(not(unix))]
    let _ = (path, stage);
    Ok(())
}
