//! Durable project metadata storage for the M01 runtime.
//!
//! The module deliberately owns the SQLite connection and the project lock.
//! UI code and future command DTOs must go through this boundary rather than
//! writing project files directly.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, params};

use crate::{ChangeOutcome, MetadataError, ProjectId, ProjectMetadata};

const DATABASE_FILENAME: &str = "project.sqlite3";
const LOCK_FILENAME: &str = ".tsumugi.lock";
const APPLICATION_ID: i64 = 0x5453_4D47;
const SCHEMA_VERSION: i64 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_millis(1_000);

const CREATE_METADATA_TABLE: &str = "\
    CREATE TABLE project_metadata (\
        row_id INTEGER PRIMARY KEY CHECK (row_id = 1),\
        project_id TEXT NOT NULL,\
        display_name TEXT NOT NULL,\
        source_locale TEXT NOT NULL,\
        target_locales_json TEXT NOT NULL,\
        metadata_revision INTEGER NOT NULL CHECK (metadata_revision > 0)\
    )";

/// Stable semantic categories later translated by the Tauri command layer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PersistenceErrorCode {
    InvalidInput,
    DestinationConflict,
    MissingProject,
    PermissionDenied,
    UnsupportedSchema,
    CorruptProject,
    StaleRevision,
    SessionInvalid,
    ProjectInUse,
    Busy,
    StorageFailed,
    OutcomeUnknown,
}

/// Operation boundary at which a persistence result was produced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PersistenceStage {
    Create,
    Open,
    Read,
    Write,
    Commit,
    Reconcile,
    Close,
    Ownership,
}

/// A bounded failure that can be surfaced without exposing SQLite or OS text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PersistenceError {
    InvalidInput {
        error: MetadataError,
        stage: PersistenceStage,
    },
    DestinationConflict {
        stage: PersistenceStage,
    },
    MissingProject {
        stage: PersistenceStage,
    },
    PermissionDenied {
        stage: PersistenceStage,
    },
    UnsupportedSchema {
        found_version: i64,
        stage: PersistenceStage,
    },
    CorruptProject {
        stage: PersistenceStage,
    },
    StaleRevision {
        current_revision: u64,
        stage: PersistenceStage,
    },
    SessionInvalid {
        stage: PersistenceStage,
    },
    ProjectInUse {
        stage: PersistenceStage,
    },
    Busy {
        stage: PersistenceStage,
    },
    StorageFailed {
        stage: PersistenceStage,
    },
    OutcomeUnknown {
        stage: PersistenceStage,
    },
}

impl PersistenceError {
    pub const fn code(&self) -> PersistenceErrorCode {
        match self {
            Self::InvalidInput { .. } => PersistenceErrorCode::InvalidInput,
            Self::DestinationConflict { .. } => PersistenceErrorCode::DestinationConflict,
            Self::MissingProject { .. } => PersistenceErrorCode::MissingProject,
            Self::PermissionDenied { .. } => PersistenceErrorCode::PermissionDenied,
            Self::UnsupportedSchema { .. } => PersistenceErrorCode::UnsupportedSchema,
            Self::CorruptProject { .. } => PersistenceErrorCode::CorruptProject,
            Self::StaleRevision { .. } => PersistenceErrorCode::StaleRevision,
            Self::SessionInvalid { .. } => PersistenceErrorCode::SessionInvalid,
            Self::ProjectInUse { .. } => PersistenceErrorCode::ProjectInUse,
            Self::Busy { .. } => PersistenceErrorCode::Busy,
            Self::StorageFailed { .. } => PersistenceErrorCode::StorageFailed,
            Self::OutcomeUnknown { .. } => PersistenceErrorCode::OutcomeUnknown,
        }
    }

    pub const fn stage(&self) -> PersistenceStage {
        match self {
            Self::InvalidInput { stage, .. }
            | Self::DestinationConflict { stage }
            | Self::MissingProject { stage }
            | Self::PermissionDenied { stage }
            | Self::UnsupportedSchema { stage, .. }
            | Self::CorruptProject { stage }
            | Self::StaleRevision { stage, .. }
            | Self::SessionInvalid { stage }
            | Self::ProjectInUse { stage }
            | Self::Busy { stage }
            | Self::StorageFailed { stage }
            | Self::OutcomeUnknown { stage } => *stage,
        }
    }

    pub const fn current_revision(&self) -> Option<u64> {
        match self {
            Self::StaleRevision {
                current_revision, ..
            } => Some(*current_revision),
            _ => None,
        }
    }

    pub const fn found_schema_version(&self) -> Option<i64> {
        match self {
            Self::UnsupportedSchema { found_version, .. } => Some(*found_version),
            _ => None,
        }
    }
}

/// Result of resolving an acknowledgement that may have been lost.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Reconciliation {
    Settled(ProjectMetadata),
    Committed(ProjectMetadata),
    Previous(ProjectMetadata),
    StillUnknown,
}

/// Test-only save-boundary faults. Production code never injects one.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageFault {
    BeforeCommit,
    AfterCommitBeforeAcknowledgement,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CrashPoint {
    BeforeCommit,
    AfterCommitBeforeAcknowledgement,
}

#[derive(Clone, Debug)]
struct PendingChange {
    previous: ProjectMetadata,
    intended: ProjectMetadata,
}

/// An owned, writable project session backed by SQLite and an OS file lock.
#[derive(Debug)]
pub struct ProjectStore {
    directory: PathBuf,
    connection: Option<Connection>,
    lock: Option<File>,
    pending: Option<PendingChange>,
    #[cfg(test)]
    fault: Option<StorageFault>,
    #[cfg(test)]
    crash: Option<CrashPoint>,
}

impl ProjectStore {
    /// Create a new project directory and durably initialize its metadata.
    pub fn create<P: AsRef<Path>>(
        directory: P,
        metadata: ProjectMetadata,
    ) -> Result<Self, PersistenceError> {
        let directory = directory.as_ref().to_path_buf();
        validate_revision_for_storage(&metadata, PersistenceStage::Create)?;

        fs::create_dir(&directory).map_err(|error| map_create_io(error))?;

        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.join(LOCK_FILENAME))
            .map_err(|error| map_io(error, PersistenceStage::Ownership))?;
        acquire_lock(&lock)?;

        let database_path = directory.join(DATABASE_FILENAME);
        let connection = Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;

        configure_new_connection(&connection)?;
        initialize_schema(&connection, &metadata)?;

        Ok(Self {
            directory,
            connection: Some(connection),
            lock: Some(lock),
            pending: None,
            #[cfg(test)]
            fault: None,
            #[cfg(test)]
            crash: None,
        })
    }

    /// Open an existing project without creating or repairing any files.
    pub fn open<P: AsRef<Path>>(directory: P) -> Result<Self, PersistenceError> {
        let directory = directory.as_ref().to_path_buf();
        if !directory.is_dir() {
            return Err(PersistenceError::MissingProject {
                stage: PersistenceStage::Open,
            });
        }

        let database_path = directory.join(DATABASE_FILENAME);
        if !database_path.is_file() {
            return Err(PersistenceError::MissingProject {
                stage: PersistenceStage::Open,
            });
        }

        let lock_path = directory.join(LOCK_FILENAME);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    PersistenceError::CorruptProject {
                        stage: PersistenceStage::Open,
                    }
                } else {
                    map_io(error, PersistenceStage::Ownership)
                }
            })?;
        acquire_lock(&lock)?;

        let connection =
            Connection::open_with_flags(&database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
        validate_existing_connection(&connection)?;
        let _ = read_metadata_from(&connection)?;

        Ok(Self {
            directory,
            connection: Some(connection),
            lock: Some(lock),
            pending: None,
            #[cfg(test)]
            fault: None,
            #[cfg(test)]
            crash: None,
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn metadata(&self) -> Result<ProjectMetadata, PersistenceError> {
        if self.pending.is_some() {
            return Err(PersistenceError::OutcomeUnknown {
                stage: PersistenceStage::Read,
            });
        }
        let connection = self.connection()?;
        read_metadata_from(connection)
    }

    pub fn rename(
        &mut self,
        expected_revision: u64,
        display_name: &str,
    ) -> Result<crate::MetadataChange, PersistenceError> {
        self.apply_change(expected_revision, |metadata| {
            metadata.rename(expected_revision, display_name)
        })
    }

    pub fn add_target_locale(
        &mut self,
        expected_revision: u64,
        locale: &str,
    ) -> Result<crate::MetadataChange, PersistenceError> {
        self.apply_change(expected_revision, |metadata| {
            metadata.add_target_locale(expected_revision, locale)
        })
    }

    pub fn set_target_locales(
        &mut self,
        expected_revision: u64,
        locales: &[String],
    ) -> Result<crate::MetadataChange, PersistenceError> {
        self.apply_change(expected_revision, |metadata| {
            metadata.set_target_locales(expected_revision, locales)
        })
    }

    pub fn is_reconciling(&self) -> bool {
        self.pending.is_some()
    }

    /// Re-read durable state and resolve an acknowledgement lost at commit.
    pub fn reconcile(&mut self) -> Result<Reconciliation, PersistenceError> {
        let connection = self.connection()?;
        let current =
            read_metadata_from(connection).map_err(|_| PersistenceError::OutcomeUnknown {
                stage: PersistenceStage::Reconcile,
            })?;

        let Some(pending) = self.pending.take() else {
            return Ok(Reconciliation::Settled(current));
        };

        if current == pending.intended {
            return Ok(Reconciliation::Committed(current));
        }
        if current == pending.previous {
            return Ok(Reconciliation::Previous(current));
        }

        self.pending = Some(pending);
        Ok(Reconciliation::StillUnknown)
    }

    /// Release the database connection and ownership marker lock.
    pub fn close(mut self) -> Result<(), PersistenceError> {
        if self.pending.is_some() {
            return Err(PersistenceError::OutcomeUnknown {
                stage: PersistenceStage::Close,
            });
        }
        self.connection.take();
        self.lock.take();
        Ok(())
    }

    fn apply_change<F>(
        &mut self,
        expected_revision: u64,
        transition: F,
    ) -> Result<crate::MetadataChange, PersistenceError>
    where
        F: FnOnce(&ProjectMetadata) -> Result<crate::MetadataChange, MetadataError>,
    {
        if self.pending.is_some() {
            return Err(PersistenceError::OutcomeUnknown {
                stage: PersistenceStage::Reconcile,
            });
        }

        #[cfg(test)]
        let fault = self.fault;
        #[cfg(test)]
        let crash = self.crash;

        let connection = self.connection_mut()?;
        let transaction = connection
            .transaction()
            .map_err(|error| map_sqlite(error, PersistenceStage::Write))?;
        let previous = read_metadata_from(&transaction)?;
        let change = transition(&previous)
            .map_err(|error| map_metadata_error(error, PersistenceStage::Write))?;

        if change.outcome() == ChangeOutcome::Unchanged {
            drop(transaction);
            return Ok(change);
        }

        if previous.metadata_revision() != expected_revision {
            return Err(PersistenceError::StaleRevision {
                current_revision: previous.metadata_revision(),
                stage: PersistenceStage::Write,
            });
        }

        write_metadata(&transaction, change.metadata())?;

        #[cfg(test)]
        if crash == Some(CrashPoint::BeforeCommit) {
            record_crash_hook("before-commit");
            std::process::abort();
        }

        #[cfg(test)]
        if fault == Some(StorageFault::BeforeCommit) {
            drop(transaction);
            self.fault = None;
            return Err(PersistenceError::StorageFailed {
                stage: PersistenceStage::Commit,
            });
        }

        let commit_result = transaction.commit();
        if let Err(error) = commit_result {
            let intended = change.metadata().clone();
            self.pending = Some(PendingChange { previous, intended });
            return Err(map_commit_error(error));
        }

        #[cfg(test)]
        if crash == Some(CrashPoint::AfterCommitBeforeAcknowledgement) {
            record_crash_hook("after-commit-before-acknowledgement");
            std::process::abort();
        }

        #[cfg(test)]
        if fault == Some(StorageFault::AfterCommitBeforeAcknowledgement) {
            self.fault = None;
            self.pending = Some(PendingChange {
                previous,
                intended: change.metadata().clone(),
            });
            return Err(PersistenceError::OutcomeUnknown {
                stage: PersistenceStage::Commit,
            });
        }

        Ok(change)
    }

    fn connection(&self) -> Result<&Connection, PersistenceError> {
        self.connection
            .as_ref()
            .ok_or(PersistenceError::SessionInvalid {
                stage: PersistenceStage::Read,
            })
    }

    fn connection_mut(&mut self) -> Result<&mut Connection, PersistenceError> {
        self.connection
            .as_mut()
            .ok_or(PersistenceError::SessionInvalid {
                stage: PersistenceStage::Write,
            })
    }

    #[cfg(test)]
    fn inject_fault(&mut self, fault: StorageFault) {
        self.fault = Some(fault);
    }

    #[cfg(test)]
    fn inject_crash(&mut self, crash: CrashPoint) {
        self.crash = Some(crash);
    }
}

impl Drop for ProjectStore {
    fn drop(&mut self) {
        self.connection.take();
        self.lock.take();
    }
}

fn validate_revision_for_storage(
    metadata: &ProjectMetadata,
    stage: PersistenceStage,
) -> Result<(), PersistenceError> {
    if metadata.metadata_revision() == 0 || metadata.metadata_revision() > i64::MAX as u64 {
        return Err(PersistenceError::InvalidInput {
            error: MetadataError::RevisionOverflow,
            stage,
        });
    }
    Ok(())
}

fn initialize_schema(
    connection: &Connection,
    metadata: &ProjectMetadata,
) -> Result<(), PersistenceError> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    transaction
        .execute(CREATE_METADATA_TABLE, [])
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    insert_metadata(&transaction, metadata)?;
    transaction
        .commit()
        .map_err(|error| map_commit_error(error))?;
    Ok(())
}

fn insert_metadata(
    connection: &Connection,
    metadata: &ProjectMetadata,
) -> Result<(), PersistenceError> {
    let target_locales_json = encode_target_locales(metadata)?;
    connection
        .execute(
            "INSERT INTO project_metadata (row_id, project_id, display_name, source_locale, target_locales_json, metadata_revision) VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            params![
                metadata.project_id().to_string(),
                metadata.display_name(),
                metadata.source_locale().as_str(),
                target_locales_json,
                metadata.metadata_revision() as i64,
            ],
        )
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    Ok(())
}

fn write_metadata(
    connection: &Connection,
    metadata: &ProjectMetadata,
) -> Result<(), PersistenceError> {
    let target_locales_json = encode_target_locales(metadata)?;
    let rows = connection
        .execute(
            "UPDATE project_metadata SET project_id = ?1, display_name = ?2, source_locale = ?3, target_locales_json = ?4, metadata_revision = ?5 WHERE row_id = 1",
            params![
                metadata.project_id().to_string(),
                metadata.display_name(),
                metadata.source_locale().as_str(),
                target_locales_json,
                metadata.metadata_revision() as i64,
            ],
        )
        .map_err(|error| map_sqlite(error, PersistenceStage::Write))?;
    if rows != 1 {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Write,
        });
    }
    Ok(())
}

fn read_metadata_from(connection: &Connection) -> Result<ProjectMetadata, PersistenceError> {
    let row_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM project_metadata", [], |row| {
            row.get(0)
        })
        .map_err(|error| map_sqlite(error, PersistenceStage::Read))?;
    if row_count != 1 {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Read,
        });
    }

    let (project_id, display_name, source_locale, target_locales_json, metadata_revision): (
        String,
        String,
        String,
        String,
        i64,
    ) = connection
        .query_row(
            "SELECT project_id, display_name, source_locale, target_locales_json, metadata_revision FROM project_metadata WHERE row_id = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|error| map_sqlite(error, PersistenceStage::Read))?;

    let project_id =
        ProjectId::parse(&project_id).map_err(|_| PersistenceError::CorruptProject {
            stage: PersistenceStage::Read,
        })?;
    if project_id.as_uuid().get_version_num() != 4 {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Read,
        });
    }
    let metadata_revision =
        u64::try_from(metadata_revision).map_err(|_| PersistenceError::CorruptProject {
            stage: PersistenceStage::Read,
        })?;
    let raw_target_locales: Vec<String> =
        serde_json::from_str(&target_locales_json).map_err(|_| {
            PersistenceError::CorruptProject {
                stage: PersistenceStage::Read,
            }
        })?;
    let metadata = ProjectMetadata::from_persisted(
        project_id,
        &display_name,
        &source_locale,
        &raw_target_locales,
        metadata_revision,
    )
    .map_err(|_| PersistenceError::CorruptProject {
        stage: PersistenceStage::Read,
    })?;

    if metadata.project_id().to_string() != project_id.to_string()
        || metadata.display_name() != display_name
        || metadata.source_locale().as_str() != source_locale
        || metadata
            .target_locales()
            .iter()
            .map(|locale| locale.as_str())
            .eq(raw_target_locales.iter().map(String::as_str))
            == false
    {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Read,
        });
    }

    Ok(metadata)
}

fn encode_target_locales(metadata: &ProjectMetadata) -> Result<String, PersistenceError> {
    serde_json::to_string(
        &metadata
            .target_locales()
            .iter()
            .map(|locale| locale.as_str())
            .collect::<Vec<_>>(),
    )
    .map_err(|_| PersistenceError::StorageFailed {
        stage: PersistenceStage::Write,
    })
}

fn configure_new_connection(connection: &Connection) -> Result<(), PersistenceError> {
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| map_sqlite(error, PersistenceStage::Create))?;
    Ok(())
}

fn validate_existing_connection(connection: &Connection) -> Result<(), PersistenceError> {
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
    let application_id: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
    if application_id != APPLICATION_ID {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Open,
        });
    }
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
    if user_version != SCHEMA_VERSION {
        return Err(PersistenceError::UnsupportedSchema {
            found_version: user_version,
            stage: PersistenceStage::Open,
        });
    }
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
    if !journal_mode.eq_ignore_ascii_case("delete") {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Open,
        });
    }
    let synchronous: i64 = connection
        .query_row("PRAGMA synchronous", [], |row| row.get(0))
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
    if synchronous != 2 {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Open,
        });
    }
    validate_schema_shape(connection)?;
    Ok(())
}

fn validate_schema_shape(connection: &Connection) -> Result<(), PersistenceError> {
    let table_names: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?
        .query_map([], |row| row.get(0))
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?
        .collect::<Result<_, _>>()
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
    if table_names != [String::from("project_metadata")] {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Open,
        });
    }

    let column_names: Vec<String> = connection
        .prepare("PRAGMA table_info(project_metadata)")
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?
        .query_map([], |row| row.get(1))
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?
        .collect::<Result<_, _>>()
        .map_err(|error| map_sqlite(error, PersistenceStage::Open))?;
    if column_names
        != [
            String::from("row_id"),
            String::from("project_id"),
            String::from("display_name"),
            String::from("source_locale"),
            String::from("target_locales_json"),
            String::from("metadata_revision"),
        ]
    {
        return Err(PersistenceError::CorruptProject {
            stage: PersistenceStage::Open,
        });
    }
    Ok(())
}

fn acquire_lock(lock: &File) -> Result<(), PersistenceError> {
    lock.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => PersistenceError::ProjectInUse {
            stage: PersistenceStage::Ownership,
        },
        std::fs::TryLockError::Error(error) => map_io(error, PersistenceStage::Ownership),
    })
}

fn map_create_io(error: io::Error) -> PersistenceError {
    match error.kind() {
        io::ErrorKind::AlreadyExists => PersistenceError::DestinationConflict {
            stage: PersistenceStage::Create,
        },
        io::ErrorKind::NotFound => PersistenceError::MissingProject {
            stage: PersistenceStage::Create,
        },
        _ => map_io(error, PersistenceStage::Create),
    }
}

fn map_io(error: io::Error, stage: PersistenceStage) -> PersistenceError {
    match error.kind() {
        io::ErrorKind::PermissionDenied => PersistenceError::PermissionDenied { stage },
        io::ErrorKind::WouldBlock => PersistenceError::ProjectInUse { stage },
        io::ErrorKind::NotFound => PersistenceError::MissingProject { stage },
        _ => PersistenceError::StorageFailed { stage },
    }
}

fn map_sqlite(error: rusqlite::Error, stage: PersistenceStage) -> PersistenceError {
    match error {
        rusqlite::Error::SqliteFailure(error, message) => {
            if error.code == rusqlite::ErrorCode::DatabaseBusy
                || error.code == rusqlite::ErrorCode::DatabaseLocked
            {
                PersistenceError::Busy { stage }
            } else if error.code == rusqlite::ErrorCode::NotADatabase
                || message.as_deref().is_some_and(|message| {
                    message.contains("no such table")
                        || message.contains("malformed")
                        || message.contains("file is not a database")
                })
            {
                PersistenceError::CorruptProject { stage }
            } else {
                PersistenceError::StorageFailed { stage }
            }
        }
        rusqlite::Error::QueryReturnedNoRows
        | rusqlite::Error::InvalidQuery
        | rusqlite::Error::FromSqlConversionFailure(_, _, _) => {
            PersistenceError::CorruptProject { stage }
        }
        _ => PersistenceError::StorageFailed { stage },
    }
}

fn map_commit_error(error: rusqlite::Error) -> PersistenceError {
    match map_sqlite(error, PersistenceStage::Commit) {
        PersistenceError::Busy { .. } => PersistenceError::OutcomeUnknown {
            stage: PersistenceStage::Commit,
        },
        _ => PersistenceError::OutcomeUnknown {
            stage: PersistenceStage::Commit,
        },
    }
}

fn map_metadata_error(error: MetadataError, stage: PersistenceStage) -> PersistenceError {
    match error {
        MetadataError::StaleRevision { current_revision } => PersistenceError::StaleRevision {
            current_revision,
            stage,
        },
        error => PersistenceError::InvalidInput { error, stage },
    }
}

#[cfg(test)]
fn record_crash_hook(name: &str) {
    if let Ok(path) = std::env::var("TSUMUGI_CRASH_HOOK_FILE") {
        let _ = fs::write(path, name.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Locale;
    use std::process::Command;
    use tempfile::TempDir;

    fn metadata() -> ProjectMetadata {
        ProjectMetadata::create_with_id(
            ProjectId::parse("123e4567-e89b-42d3-a456-426614174000").unwrap(),
            "Demo",
            "en-US",
            ["zh-CN"],
        )
        .unwrap()
    }

    fn temporary_directory(label: &str) -> TempDir {
        tempfile::Builder::new()
            .prefix(&format!("tsumugi-{label}-"))
            .tempdir()
            .unwrap()
    }

    fn run_crash_child(project_path: &Path, hook_path: &Path, mode: &str) {
        let executable = std::env::current_exe().unwrap();
        let output = Command::new(executable)
            .args(["--exact", "persistence::tests::crash_helper", "--nocapture"])
            .env("TSUMUGI_CRASH_PROJECT", project_path)
            .env("TSUMUGI_CRASH_HOOK_FILE", hook_path)
            .env("TSUMUGI_CRASH_MODE", mode)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "crash helper unexpectedly succeeded: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn create_open_edit_and_close_persist_real_sqlite_state() {
        let parent = temporary_directory("lifecycle");
        let project_path = parent.path().join("project");
        let mut store = ProjectStore::create(&project_path, metadata()).unwrap();

        assert_eq!(store.metadata().unwrap().metadata_revision(), 1);
        let renamed = store.rename(1, "Demo 2").unwrap();
        assert_eq!(renamed.outcome(), ChangeOutcome::Changed);
        assert_eq!(renamed.metadata().metadata_revision(), 2);
        assert_eq!(
            store
                .add_target_locale(2, "ja")
                .unwrap()
                .metadata()
                .metadata_revision(),
            3
        );
        store.close().unwrap();

        let reopened = ProjectStore::open(&project_path).unwrap();
        let current = reopened.metadata().unwrap();
        assert_eq!(current.display_name(), "Demo 2");
        assert_eq!(current.metadata_revision(), 3);
        assert_eq!(
            current
                .target_locales()
                .iter()
                .map(Locale::as_str)
                .collect::<Vec<_>>(),
            vec!["ja", "zh-CN"]
        );
        reopened.close().unwrap();
    }

    #[test]
    fn create_refuses_existing_empty_or_nonempty_destinations() {
        let parent = temporary_directory("conflict");
        let empty = parent.path().join("empty");
        fs::create_dir(&empty).unwrap();
        assert_eq!(
            ProjectStore::create(&empty, metadata()).unwrap_err().code(),
            PersistenceErrorCode::DestinationConflict
        );

        let nonempty = parent.path().join("nonempty");
        fs::create_dir(&nonempty).unwrap();
        let original = nonempty.join("keep.txt");
        fs::write(&original, b"keep").unwrap();
        assert_eq!(
            ProjectStore::create(&nonempty, metadata())
                .unwrap_err()
                .code(),
            PersistenceErrorCode::DestinationConflict
        );
        assert_eq!(fs::read(&original).unwrap(), b"keep");
    }

    #[test]
    fn open_missing_locator_or_database_does_not_create_a_project() {
        let parent = temporary_directory("missing");
        let missing = parent.path().join("missing-project");
        assert_eq!(
            ProjectStore::open(&missing).unwrap_err().code(),
            PersistenceErrorCode::MissingProject
        );

        let empty = parent.path().join("empty-project");
        fs::create_dir(&empty).unwrap();
        assert_eq!(
            ProjectStore::open(&empty).unwrap_err().code(),
            PersistenceErrorCode::MissingProject
        );
        assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    }

    #[test]
    fn ownership_lock_rejects_second_writer_and_releases_on_close() {
        let parent = temporary_directory("ownership");
        let project_path = parent.path().join("project");
        let store = ProjectStore::create(&project_path, metadata()).unwrap();
        assert_eq!(
            ProjectStore::open(&project_path).unwrap_err().code(),
            PersistenceErrorCode::ProjectInUse
        );
        store.close().unwrap();
        let reopened = ProjectStore::open(&project_path).unwrap();
        reopened.close().unwrap();
    }

    #[test]
    fn stale_and_invalid_edits_do_not_write() {
        let parent = temporary_directory("guards");
        let project_path = parent.path().join("project");
        let mut store = ProjectStore::create(&project_path, metadata()).unwrap();
        assert_eq!(
            store.rename(0, "Wrong").unwrap_err(),
            PersistenceError::StaleRevision {
                current_revision: 1,
                stage: PersistenceStage::Write,
            }
        );
        assert_eq!(
            store.rename(1, "").unwrap_err().code(),
            PersistenceErrorCode::InvalidInput
        );
        assert_eq!(store.metadata().unwrap().display_name(), "Demo");
        store.close().unwrap();
    }

    #[test]
    fn open_refuses_unsupported_schema_without_repair() {
        let parent = temporary_directory("schema");
        let project_path = parent.path().join("project");
        let store = ProjectStore::create(&project_path, metadata()).unwrap();
        store.close().unwrap();
        let database = project_path.join(DATABASE_FILENAME);
        let connection = Connection::open(&database).unwrap();
        connection
            .pragma_update(None, "user_version", 99i64)
            .unwrap();
        drop(connection);
        let before = fs::read(&database).unwrap();
        let error = ProjectStore::open(&project_path).unwrap_err();
        assert_eq!(error.code(), PersistenceErrorCode::UnsupportedSchema);
        assert_eq!(fs::read(&database).unwrap(), before);
    }

    #[test]
    fn open_refuses_corrupt_metadata_without_repair() {
        let parent = temporary_directory("corrupt");
        let project_path = parent.path().join("project");
        let store = ProjectStore::create(&project_path, metadata()).unwrap();
        store.close().unwrap();

        let database = project_path.join(DATABASE_FILENAME);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE project_metadata SET target_locales_json = ?1 WHERE row_id = 1",
                params!["[\"not a locale\"]"],
            )
            .unwrap();
        drop(connection);

        let before = fs::read(&database).unwrap();
        let error = ProjectStore::open(&project_path).unwrap_err();
        assert_eq!(error.code(), PersistenceErrorCode::CorruptProject);
        assert_eq!(fs::read(&database).unwrap(), before);
    }

    #[test]
    fn fault_before_commit_preserves_previous_and_after_commit_reconciles() {
        let parent = temporary_directory("faults");
        let project_path = parent.path().join("project");
        let mut store = ProjectStore::create(&project_path, metadata()).unwrap();

        store.inject_fault(StorageFault::BeforeCommit);
        assert_eq!(
            store.rename(1, "Before").unwrap_err().code(),
            PersistenceErrorCode::StorageFailed
        );
        assert_eq!(store.metadata().unwrap().display_name(), "Demo");

        store.inject_fault(StorageFault::AfterCommitBeforeAcknowledgement);
        assert_eq!(
            store.rename(1, "After").unwrap_err().code(),
            PersistenceErrorCode::OutcomeUnknown
        );
        assert!(store.is_reconciling());
        assert_eq!(
            store.rename(2, "Blocked").unwrap_err().code(),
            PersistenceErrorCode::OutcomeUnknown
        );
        assert_eq!(
            store.reconcile().unwrap(),
            Reconciliation::Committed(
                ProjectMetadata::from_persisted(
                    metadata().project_id(),
                    "After",
                    "en-US",
                    ["zh-CN"],
                    2,
                )
                .unwrap()
            )
        );
        store.close().unwrap();

        let reopened = ProjectStore::open(&project_path).unwrap();
        assert_eq!(reopened.metadata().unwrap().display_name(), "After");
        reopened.close().unwrap();
    }

    #[test]
    fn effective_durability_settings_are_rollback_full() {
        let parent = temporary_directory("pragma");
        let project_path = parent.path().join("project");
        let store = ProjectStore::create(&project_path, metadata()).unwrap();
        let connection = store.connection().unwrap();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "delete");
        assert_eq!(synchronous, 2);
        store.close().unwrap();
    }

    #[test]
    fn crash_helper() {
        let Ok(mode) = std::env::var("TSUMUGI_CRASH_MODE") else {
            return;
        };
        let project_path = PathBuf::from(std::env::var("TSUMUGI_CRASH_PROJECT").unwrap());
        let mut store = ProjectStore::open(project_path).unwrap();
        let crash = match mode.as_str() {
            "before-commit" => CrashPoint::BeforeCommit,
            "after-commit-before-acknowledgement" => CrashPoint::AfterCommitBeforeAcknowledgement,
            other => panic!("unknown crash mode {other}"),
        };
        store.inject_crash(crash);
        let _ = store.rename(1, "AfterCrash");
        panic!("crash helper reached return without terminating");
    }

    #[test]
    fn subprocess_termination_recovers_before_and_after_commit_boundaries() {
        let parent = temporary_directory("crash-restart");
        let project_path = parent.path().join("project");
        let store = ProjectStore::create(&project_path, metadata()).unwrap();
        store.close().unwrap();

        let before_hook = parent.path().join("before-hook.txt");
        run_crash_child(&project_path, &before_hook, "before-commit");
        assert_eq!(fs::read_to_string(&before_hook).unwrap(), "before-commit");
        let reopened = ProjectStore::open(&project_path).unwrap();
        assert_eq!(reopened.metadata().unwrap().display_name(), "Demo");
        reopened.close().unwrap();

        let after_hook = parent.path().join("after-hook.txt");
        run_crash_child(
            &project_path,
            &after_hook,
            "after-commit-before-acknowledgement",
        );
        assert_eq!(
            fs::read_to_string(&after_hook).unwrap(),
            "after-commit-before-acknowledgement"
        );
        let reopened = ProjectStore::open(&project_path).unwrap();
        let current = reopened.metadata().unwrap();
        assert_eq!(current.display_name(), "AfterCrash");
        assert_eq!(current.metadata_revision(), 2);
        reopened.close().unwrap();
    }
}
