//! Application-owned non-secret connection facts, separate from project data
//! and plugin/runtime permissions. The trusted host supplies the storage root.
//! Reads never initialize storage or read credentials. Saved defaults do not
//! authorize requests and cannot modify already captured execution settings.

use crate::{
    ai::AiConnection,
    execution::{ErrorCode, ExecutionError, ExecutionId, UnsignedDecimal, codec},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub const MAX_CONNECTION_PROFILES: usize = 64;
const MAX_DOCUMENT_BYTES: usize = 256 * 1024;
const DATABASE: &str = "model-connections.sqlite3";
const APPLICATION_ID: i64 = 0x544D_434E;
const FORMAT: i64 = 1;
const STATE_SQL: &str = "CREATE TABLE connection_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload BLOB NOT NULL, digest TEXT NOT NULL)";
const ACTION_SQL: &str = "CREATE TABLE connection_actions (action_id TEXT PRIMARY KEY NOT NULL, request_digest TEXT NOT NULL, payload BLOB NOT NULL, digest TEXT NOT NULL)";

type Result<T> = std::result::Result<T, ExecutionError>;
fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(error: rusqlite::Error) -> ExecutionError {
    let mut failure = crate::persistence::ledger::sql_error(error);
    failure.stage = "model-connections-storage".into();
    failure
}

fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    codec::encode(value, MAX_DOCUMENT_BYTES)
}
fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(codec::digest(&encoded(value)?))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ModelConnectionProfile {
    pub id: ExecutionId,
    pub revision: UnsignedDecimal,
    pub name: String,
    pub connection: AiConnection,
    pub archived: bool,
}

/// A persistent data identity, never a credential, execution grant or consent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ModelConnectionReference {
    pub store_id: ExecutionId,
    pub profile_id: ExecutionId,
    pub revision: UnsignedDecimal,
    pub digest: String,
}
impl ModelConnectionReference {
    pub fn validate(&self) -> Result<()> {
        if self.revision.get() == 0 || !valid_digest(&self.digest) {
            return Err(fail(ErrorCode::InvalidInput, "ai-connection-profile"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ModelConnectionSnapshot {
    pub store_id: Option<ExecutionId>,
    pub revision: UnsignedDecimal,
    pub last_action_id: Option<ExecutionId>,
    pub profiles: Vec<ModelConnectionProfile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ModelConnectionBasis {
    pub store_id: Option<ExecutionId>,
    pub revision: UnsignedDecimal,
    pub digest: String,
}

impl ModelConnectionSnapshot {
    fn empty() -> Self {
        Self {
            store_id: None,
            revision: 0.into(),
            last_action_id: None,
            profiles: vec![],
        }
    }
    pub fn basis(&self) -> Result<ModelConnectionBasis> {
        Ok(ModelConnectionBasis {
            store_id: self.store_id,
            revision: self.revision,
            digest: digest(self)?,
        })
    }
    pub fn reference(&self, id: ExecutionId) -> Result<ModelConnectionReference> {
        let profile = self
            .profiles
            .iter()
            .find(|p| p.id == id && !p.archived)
            .ok_or_else(|| {
                fail(
                    ErrorCode::DependencyConflict,
                    "model-connection-unavailable",
                )
            })?;
        Ok(ModelConnectionReference {
            store_id: self
                .store_id
                .ok_or_else(|| fail(ErrorCode::CorruptLedger, "model-connections-state"))?,
            profile_id: id,
            revision: profile.revision,
            digest: digest(profile)?,
        })
    }
    pub fn resolve(&self, reference: &ModelConnectionReference) -> Result<AiConnection> {
        reference.validate()?;
        if self.store_id != Some(reference.store_id)
            || self.reference(reference.profile_id)? != *reference
        {
            return Err(fail(ErrorCode::DependencyConflict, "model-connection-changed"));
        }
        Ok(self.profiles.iter().find(|profile| profile.id == reference.profile_id)
            .ok_or_else(|| fail(ErrorCode::CorruptLedger, "model-connections-profile"))?
            .connection.clone())
    }
    /// Verify only saved-profile provenance against this single read snapshot.
    /// Invocation validation, scope and consent keep their existing owners.
    pub fn verify_config(&self, config: &crate::ai::AiConfig) -> Result<()> {
        if let Some(reference) = &config.connection_profile {
            if self.resolve(reference)? != AiConnection::from_config(config) {
                return Err(fail(ErrorCode::InvalidInput, "ai-connection-profile"));
            }
        }
        Ok(())
    }
    fn validate(&self) -> Result<()> {
        if self.store_id.is_none()
            || self.revision.get() == 0
            || self.last_action_id.is_none()
            || self.profiles.is_empty()
            || self.profiles.len() > MAX_CONNECTION_PROFILES
        {
            return Err(fail(ErrorCode::CorruptLedger, "model-connections-state"));
        }
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        for profile in &self.profiles {
            if !ids.insert(profile.id)
                || profile.revision.get() == 0
                || profile.revision > self.revision
                || validate_name(&profile.name).is_err()
                || profile.connection.validate().is_err()
                || (!profile.archived && !names.insert(profile.name.clone()))
            {
                return Err(fail(ErrorCode::CorruptLedger, "model-connections-profile"));
            }
        }
        if self.profiles.windows(2).any(|p| p[0].id >= p[1].id) {
            return Err(fail(ErrorCode::CorruptLedger, "model-connections-order"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ModelConnectionEdit {
    Save {
        profile_id: ExecutionId,
        name: String,
        connection: AiConnection,
    },
    Archive {
        profile_id: ExecutionId,
    },
    Restore {
        profile_id: ExecutionId,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ModelConnectionChange {
    pub action_id: ExecutionId,
    pub expected: ModelConnectionBasis,
    pub edit: ModelConnectionEdit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ModelConnectionReceipt {
    pub action_id: ExecutionId,
    pub request_digest: String,
    pub snapshot: ModelConnectionSnapshot,
}

fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.chars().count() > 128 || name.chars().any(char::is_control) {
        return Err(fail(ErrorCode::InvalidInput, "model-connection-name"));
    }
    Ok(())
}
fn validate_request(change: &ModelConnectionChange) -> Result<()> {
    if !valid_digest(&change.expected.digest)
        || change.expected.store_id.is_none() != (change.expected.revision.get() == 0)
    {
        return Err(fail(ErrorCode::InvalidInput, "model-connections-basis"));
    }
    if let ModelConnectionEdit::Save {
        name, connection, ..
    } = &change.edit
    {
        validate_name(name)?;
        connection.validate()?;
    }
    Ok(())
}
fn apply(
    before: &ModelConnectionSnapshot,
    change: &ModelConnectionChange,
) -> Result<ModelConnectionSnapshot> {
    if before.basis()? != change.expected {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "model-connections-basis",
        ));
    }
    let next = before
        .revision
        .get()
        .checked_add(1)
        .ok_or_else(|| fail(ErrorCode::LimitExceeded, "model-connections-revision"))?;
    let mut after = before.clone();
    match &change.edit {
        ModelConnectionEdit::Save {
            profile_id,
            name,
            connection,
        } => {
            if let Some(profile) = after.profiles.iter_mut().find(|p| p.id == *profile_id) {
                if profile.name != *name || profile.connection != *connection {
                    profile.revision = next.into();
                }
                profile.name.clone_from(name);
                profile.connection.clone_from(connection);
            } else {
                if after.profiles.len() == MAX_CONNECTION_PROFILES {
                    return Err(fail(ErrorCode::LimitExceeded, "model-connections-capacity"));
                }
                after.profiles.push(ModelConnectionProfile {
                    id: *profile_id,
                    revision: next.into(),
                    name: name.clone(),
                    connection: connection.clone(),
                    archived: false,
                });
            }
        }
        ModelConnectionEdit::Archive { profile_id }
        | ModelConnectionEdit::Restore { profile_id } => {
            let profile = after
                .profiles
                .iter_mut()
                .find(|p| p.id == *profile_id)
                .ok_or_else(|| {
                    fail(
                        ErrorCode::DependencyConflict,
                        "model-connection-unavailable",
                    )
                })?;
            let archived = matches!(&change.edit, ModelConnectionEdit::Archive { .. });
            if profile.archived != archived {
                profile.revision = next.into();
                profile.archived = archived;
            }
        }
    }
    let mut names = BTreeSet::new();
    if after
        .profiles
        .iter()
        .any(|p| !p.archived && !names.insert(p.name.clone()))
    {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "model-connection-name-duplicate",
        ));
    }
    after.store_id = Some(before.store_id.unwrap_or_else(ExecutionId::new));
    after.revision = next.into();
    after.last_action_id = Some(change.action_id);
    after.profiles.sort_by_key(|p| p.id);
    after.validate()?;
    Ok(after)
}

/// The directory is supplied by the trusted application, never an IPC payload.
/// Each operation owns its SQLite read snapshot or IMMEDIATE write transaction.
#[derive(Clone)]
pub struct ModelConnectionStore {
    directory: PathBuf,
}
impl ModelConnectionStore {
    pub fn at(directory: impl Into<PathBuf>) -> Result<Self> {
        let directory = directory.into();
        if !directory.is_absolute()
            || directory
                .components()
                .any(|p| matches!(p, Component::ParentDir))
        {
            return Err(fail(ErrorCode::InvalidInput, "model-connections-directory"));
        }
        Ok(Self { directory })
    }
    fn directory_path(&self) -> Result<Option<PathBuf>> {
        match fs::symlink_metadata(&self.directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            _ => {
                return Err(fail(
                    ErrorCode::StorageFailed,
                    "model-connections-directory",
                ));
            }
        }
        // The trusted host root can have platform aliases in its ancestors
        // (for example /var on macOS). Resolve those after refusing a linked
        // root itself; SQLite NOFOLLOW still protects the database filename.
        fs::canonicalize(&self.directory)
            .map(Some)
            .map_err(|_| fail(ErrorCode::StorageFailed, "model-connections-directory"))
    }
    fn existing(&self, write: bool) -> Result<Option<Connection>> {
        let Some(directory) = self.directory_path()? else {
            return Ok(None);
        };
        let path = directory.join(DATABASE);
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if write && meta.nlink() != 1 {
                        return Err(fail(ErrorCode::StorageFailed, "model-connections-file"));
                    }
                }
            }
            _ => return Err(fail(ErrorCode::StorageFailed, "model-connections-file")),
        }
        let flags = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(&path, flags).map_err(sql)?;
        connection.busy_timeout(Duration::ZERO).map_err(sql)?;
        Ok(Some(connection))
    }
    pub fn snapshot(&self) -> Result<ModelConnectionSnapshot> {
        let Some(mut connection) = self.existing(false)? else {
            return Ok(ModelConnectionSnapshot::empty());
        };
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        verify_schema(&tx)?;
        read_snapshot(&tx)
    }
    pub fn action(&self, action_id: ExecutionId) -> Result<Option<ModelConnectionReceipt>> {
        let Some(mut connection) = self.existing(false)? else {
            return Ok(None);
        };
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        verify_schema(&tx)?;
        let current = read_snapshot(&tx)?;
        read_action(&tx, action_id, &current)
    }
    pub fn resolve(&self, reference: &ModelConnectionReference) -> Result<AiConnection> {
        self.snapshot()?.resolve(reference)
    }
    /// Fresh preparation/authorization checks all variants from one snapshot.
    /// Accepted work uses its captured AiConfig and does not call this method.
    /// Manual one-time connections do not touch the application store.
    pub fn verify_configs(&self, configs: &[crate::ai::AiConfig]) -> Result<()> {
        if configs.iter().all(|config| config.connection_profile.is_none()) {
            return Ok(());
        }
        let snapshot = self.snapshot()?;
        for config in configs {
            snapshot.verify_config(config)?;
        }
        Ok(())
    }
    pub fn change(&self, change: &ModelConnectionChange) -> Result<ModelConnectionReceipt> {
        validate_request(change)?;
        let request_digest = digest(change)?;
        if let Some(mut connection) = self.existing(true)? {
            return change_existing(&mut connection, change, &request_digest);
        }
        // Derive and validate all first-write content before creating a directory.
        let after = apply(&ModelConnectionSnapshot::empty(), change)?;
        fs::create_dir_all(&self.directory)
            .map_err(|_| fail(ErrorCode::StorageFailed, "model-connections-directory"))?;
        let directory = self
            .directory_path()?
            .ok_or_else(|| fail(ErrorCode::StorageFailed, "model-connections-directory"))?;
        let temporary = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|_| fail(ErrorCode::StorageFailed, "model-connections-create"))?;
        let mut connection = Connection::open_with_flags(
            temporary.path(),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sql)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        tx.execute_batch(STATE_SQL).map_err(sql)?;
        tx.execute_batch(ACTION_SQL).map_err(sql)?;
        tx.pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(sql)?;
        tx.pragma_update(None, "user_version", FORMAT)
            .map_err(sql)?;
        let receipt = ModelConnectionReceipt {
            action_id: change.action_id,
            request_digest,
            snapshot: after,
        };
        write_result(&tx, &receipt)?;
        tx.commit()
            .map_err(|_| fail(ErrorCode::OutcomeUnknown, "model-connections-commit"))?;
        drop(connection);
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| fail(ErrorCode::StorageFailed, "model-connections-create"))?;
        match temporary.persist_noclobber(directory.join(DATABASE)) {
            Ok(file) => {
                file.sync_all()
                    .map_err(|_| fail(ErrorCode::OutcomeUnknown, "model-connections-publish"))?;
                sync_directory(&directory)?;
                Ok(receipt)
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                drop(error);
                let mut current = self
                    .existing(true)?
                    .ok_or_else(|| fail(ErrorCode::OutcomeUnknown, "model-connections-publish"))?;
                change_existing(&mut current, change, &digest(change)?)
            }
            Err(_) => Err(fail(ErrorCode::OutcomeUnknown, "model-connections-publish")),
        }
    }
}

// The extra directory flush is Unix-specific; other platforms retain tempfile
// publication and SQLite/file flushing. Power-loss behavior needs platform QA.
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| fail(ErrorCode::OutcomeUnknown, "model-connections-publish"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn verify_schema(connection: &Connection) -> Result<()> {
    let application: i64 = connection
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(sql)?;
    let format: i64 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sql)?;
    if application != APPLICATION_ID || format != FORMAT {
        return Err(fail(ErrorCode::InvalidInput, "model-connections-version"));
    }
    let mut statement = connection
        .prepare(
            "SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .map_err(sql)?;
    let schema = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    if schema
        != vec![
            (
                "connection_actions".into(),
                "table".into(),
                ACTION_SQL.into(),
            ),
            ("connection_state".into(), "table".into(), STATE_SQL.into()),
        ]
    {
        return Err(fail(ErrorCode::CorruptLedger, "model-connections-schema"));
    }
    Ok(())
}
fn decode<T: for<'a> Deserialize<'a> + Serialize>(
    payload: Option<Vec<u8>>,
    expected: &str,
) -> Result<T> {
    let bytes =
        payload.ok_or_else(|| fail(ErrorCode::CorruptLedger, "model-connections-document"))?;
    if codec::digest(&bytes) != expected {
        return Err(fail(ErrorCode::CorruptLedger, "model-connections-digest"));
    }
    let value: T = codec::decode(&bytes, MAX_DOCUMENT_BYTES)
        .map_err(|_| fail(ErrorCode::CorruptLedger, "model-connections-document"))?;
    if encoded(&value)? != bytes {
        return Err(fail(
            ErrorCode::CorruptLedger,
            "model-connections-canonical",
        ));
    }
    Ok(value)
}
fn read_snapshot(connection: &Connection) -> Result<ModelConnectionSnapshot> {
    let (payload, hash): (Option<Vec<u8>>, String) = connection.query_row("SELECT CASE WHEN length(payload)<=?1 THEN payload END,digest FROM connection_state WHERE singleton=1", [MAX_DOCUMENT_BYTES as i64], |r| Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
    let snapshot: ModelConnectionSnapshot = decode(payload, &hash)?;
    snapshot.validate()?;
    Ok(snapshot)
}
fn read_action(
    connection: &Connection,
    action_id: ExecutionId,
    current: &ModelConnectionSnapshot,
) -> Result<Option<ModelConnectionReceipt>> {
    let row: Option<(String,Option<Vec<u8>>,String)> = connection.query_row("SELECT request_digest,CASE WHEN length(payload)<=?2 THEN payload END,digest FROM connection_actions WHERE action_id=?1", params![action_id.to_string(),MAX_DOCUMENT_BYTES as i64], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sql)?;
    let Some((request, payload, hash)) = row else {
        return Ok(None);
    };
    let receipt: ModelConnectionReceipt = decode(payload, &hash)?;
    receipt.snapshot.validate()?;
    if receipt.action_id != action_id
        || receipt.snapshot.last_action_id != Some(action_id)
        || receipt.request_digest != request
        || !valid_digest(&request)
        || receipt.snapshot.store_id != current.store_id
        || receipt.snapshot.revision > current.revision
    {
        return Err(fail(ErrorCode::CorruptLedger, "model-connections-action"));
    }
    Ok(Some(receipt))
}
fn write_result(connection: &Connection, receipt: &ModelConnectionReceipt) -> Result<()> {
    let state = encoded(&receipt.snapshot)?;
    let payload = encoded(receipt)?;
    connection.execute("INSERT INTO connection_state VALUES(1,?1,?2) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,digest=excluded.digest", params![state,codec::digest(&state)]).map_err(sql)?;
    connection
        .execute(
            "INSERT INTO connection_actions VALUES(?1,?2,?3,?4)",
            params![
                receipt.action_id.to_string(),
                receipt.request_digest,
                payload,
                codec::digest(&payload)
            ],
        )
        .map_err(sql)?;
    Ok(())
}
fn change_existing(
    connection: &mut Connection,
    change: &ModelConnectionChange,
    request_digest: &str,
) -> Result<ModelConnectionReceipt> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    verify_schema(&tx)?;
    let before = read_snapshot(&tx)?;
    if let Some(receipt) = read_action(&tx, change.action_id, &before)? {
        if receipt.request_digest != request_digest {
            return Err(fail(
                ErrorCode::DependencyConflict,
                "model-connections-action",
            ));
        }
        return Ok(receipt);
    }
    let after = apply(&before, change)?;
    let receipt = ModelConnectionReceipt {
        action_id: change.action_id,
        request_digest: request_digest.into(),
        snapshot: after,
    };
    write_result(&tx, &receipt)?;
    tx.commit()
        .map_err(|_| fail(ErrorCode::OutcomeUnknown, "model-connections-commit"))?;
    Ok(receipt)
}

#[cfg(test)]
mod tests;
