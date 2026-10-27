//! Application-owned input recovery. This store cannot write project revisions,
//! authorize execution, or turn a recovered pending request into a new action.

use super::types::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tsumugi_core::{
    Locale,
    execution::{ErrorCode, ExecutionError, ExecutionId, Revision},
};

pub const MAX_DRAFT_RECORD_BYTES: usize = 256 * 1024;
pub const MAX_PROJECT_DRAFT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_DRAFT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_PROJECT_DRAFT_RECORDS: usize = 16_384;
pub const MAX_DRAFT_RECORDS: usize = 65_536;
pub const MAX_DRAFT_PAGE_SIZE: u32 = 100;
const DATABASE: &str = "drafts.sqlite3";
const APPLICATION_ID: i64 = 0x5444_5246;
const FORMAT: i64 = 2;
const LEGACY_FORMAT: i64 = 1;
const HEAD_SQL: &str = "CREATE TABLE draft_heads (project_id TEXT NOT NULL, locale TEXT NOT NULL, unit_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, source_revision_id TEXT, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=262144), PRIMARY KEY(project_id,locale,unit_id), CHECK((edit_seq IS NULL AND source_revision_id IS NULL AND has_pending=0) OR (edit_seq>=0 AND source_revision_id IS NOT NULL)))";

type Result<T> = std::result::Result<T, ExecutionError>;
fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(error: rusqlite::Error) -> ExecutionError {
    let code = match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            ErrorCode::Busy
        }
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
            ErrorCode::CorruptLedger
        }
        _ => ErrorCode::StorageFailed,
    };
    fail(code, "drafts-storage")
}

#[derive(Clone, Copy)]
struct Limits {
    project_bytes: usize,
    total_bytes: usize,
    project_records: usize,
    total_records: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            project_bytes: MAX_PROJECT_DRAFT_BYTES,
            total_bytes: MAX_DRAFT_BYTES,
            project_records: MAX_PROJECT_DRAFT_RECORDS,
            total_records: MAX_DRAFT_RECORDS,
        }
    }
}

/// Only the trusted Host chooses this absolute application-data directory.
/// Each operation owns its snapshot or IMMEDIATE compare-and-swap transaction.
#[derive(Clone)]
pub struct DraftStore {
    directory: PathBuf,
    limits: Limits,
}
impl DraftStore {
    pub fn at(directory: impl Into<PathBuf>) -> Result<Self> {
        let directory = directory.into();
        if !directory.is_absolute()
            || directory
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err(fail(ErrorCode::InvalidInput, "drafts-directory"));
        }
        Ok(Self {
            directory,
            limits: Limits::default(),
        })
    }

    pub fn read(&self, key: &DraftKey) -> Result<DraftHead> {
        validate_key(key)?;
        let Some(mut connection) = self.existing(false)? else {
            return Ok(empty_head(key));
        };
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        let format = verify_schema(&tx)?;
        read_head(&tx, key, format)
    }

    pub fn list(
        &self,
        project_id: ExecutionId,
        after: Option<&DraftKey>,
        limit: u32,
    ) -> Result<DraftPage> {
        if limit == 0 || limit > MAX_DRAFT_PAGE_SIZE {
            return Err(fail(ErrorCode::InvalidInput, "drafts-page"));
        }
        if let Some(key) = after {
            validate_key(key)?;
            if key.project_id != project_id {
                return Err(fail(ErrorCode::InvalidInput, "drafts-page"));
            }
        }
        let Some(mut connection) = self.existing(false)? else {
            return Ok(DraftPage {
                items: Vec::new(),
                next: None,
            });
        };
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        let format = verify_schema(&tx)?;
        // Scan tombstones as well: filtering on summary columns could hide a
        // real pending request if those columns no longer match its payload.
        let mut statement = tx.prepare("SELECT locale,unit_id,revision,edit_seq,source_revision_id,has_pending,CASE WHEN length(payload)<=?5 THEN payload END FROM draft_heads WHERE project_id=?1 AND (?2 IS NULL OR (locale,unit_id)>(?2,?3)) ORDER BY locale,unit_id LIMIT ?4").map_err(sql)?;
        let rows = statement
            .query_map(
                params![
                    project_id.to_string(),
                    after.map(|key| key.locale.as_str()),
                    after.map(|key| key.unit_id.to_string()),
                    i64::from(limit) + 1,
                    MAX_DRAFT_RECORD_BYTES as i64,
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        stored_head_row(row, 2)?,
                    ))
                },
            )
            .map_err(sql)?;
        let mut items = Vec::new();
        let mut last_key = None;
        let mut has_more = false;
        for (index, row) in rows.enumerate() {
            let (locale, unit, stored) = row.map_err(sql)?;
            let key = DraftKey {
                project_id,
                unit_id: stored_id(&unit)?,
                locale,
            };
            let head = decode_head(&key, stored, format)?;
            if index == limit as usize {
                has_more = true;
                break;
            }
            last_key = Some(key.clone());
            if let Some(value) = head.value {
                items.push(DraftSummary {
                    key,
                    revision: head.revision,
                    edit_seq: value.edit_seq,
                    source_revision_id: value.basis.source_revision_id,
                    has_pending: value.pending.is_some(),
                });
            }
        }
        // An empty page can still have a continuation when its scanned heads
        // were tombstones. Only `next == None` means enumeration is complete.
        let next = if has_more { last_key } else { None };
        Ok(DraftPage { items, next })
    }

    pub fn write(&self, request: &DraftWrite) -> Result<DraftHead> {
        validate_key(&request.key)?;
        validate_value(&request.key, &request.value)?;
        self.mutate(&request.key, |before| apply_write(before, request))
    }

    pub fn clear(&self, request: &DraftClear) -> Result<DraftHead> {
        validate_key(&request.key)?;
        self.mutate(&request.key, |before| {
            if before.revision != request.expected_revision {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-revision"));
            }
            if before
                .value
                .as_ref()
                .is_some_and(|value| value.pending.is_some())
            {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
            }
            if before.value.is_none() && before.revision.get() > 0 {
                return Ok(before.clone());
            }
            Ok(DraftHead {
                key: request.key.clone(),
                revision: next_revision(before.revision)?,
                writer_id: None,
                value: None,
            })
        })
    }

    fn directory_path(&self) -> Result<Option<PathBuf>> {
        match fs::symlink_metadata(&self.directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            _ => return Err(fail(ErrorCode::StorageFailed, "drafts-directory")),
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            let metadata = fs::symlink_metadata(&self.directory)
                .map_err(|_| fail(ErrorCode::StorageFailed, "drafts-directory"))?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(fail(ErrorCode::StorageFailed, "drafts-directory"));
            }
        }
        // Platform aliases in trusted ancestors are allowed; the selected
        // directory and all database files themselves must never be links.
        fs::canonicalize(&self.directory)
            .map(Some)
            .map_err(|_| fail(ErrorCode::StorageFailed, "drafts-directory"))
    }

    fn existing(&self, write: bool) -> Result<Option<Connection>> {
        let Some(directory) = self.directory_path()? else {
            return Ok(None);
        };
        let path = directory.join(DATABASE);
        let exists = check_file(&path)?;
        for suffix in ["-journal", "-wal", "-shm"] {
            if check_file(&directory.join(format!("{DATABASE}{suffix}")))? && !exists {
                return Err(fail(ErrorCode::StorageFailed, "drafts-file"));
            }
        }
        if !exists {
            return Ok(None);
        }
        // Existing-file reads may need SQLite to roll back an interrupted
        // transaction. No CREATE flag is used and no draft mutation is issued.
        let mode = OpenFlags::SQLITE_OPEN_READ_WRITE;
        let connection = Connection::open_with_flags(
            path,
            mode | OpenFlags::SQLITE_OPEN_NOFOLLOW | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sql)?;
        configure(&connection, write)?;
        Ok(Some(connection))
    }

    fn mutate(
        &self,
        key: &DraftKey,
        apply: impl Fn(&DraftHead) -> Result<DraftHead>,
    ) -> Result<DraftHead> {
        if let Some(mut connection) = self.existing(true)? {
            return mutate_existing(&mut connection, key, &apply, self.limits);
        }
        let after = apply(&empty_head(key))?;
        if after.revision.get() == 0 {
            return Ok(after);
        }
        let payload = encode(&after)?;
        check_quota(0, 0, 0, 0, 0, payload.len(), true, self.limits)?;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&self.directory)
            .map_err(|_| fail(ErrorCode::StorageFailed, "drafts-directory"))?;
        let directory = self
            .directory_path()?
            .ok_or_else(|| fail(ErrorCode::StorageFailed, "drafts-directory"))?;
        let temporary = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|_| fail(ErrorCode::StorageFailed, "drafts-create"))?;
        let mut connection = Connection::open_with_flags(
            temporary.path(),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sql)?;
        configure(&connection, true)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        tx.execute_batch(HEAD_SQL).map_err(sql)?;
        tx.pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(sql)?;
        tx.pragma_update(None, "user_version", FORMAT)
            .map_err(sql)?;
        persist_head(&tx, &after, &payload)?;
        test_hook("initialize-before-commit", Some(&tx));
        tx.commit()
            .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
        test_hook("initialize-after-commit", None);
        drop(connection);
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| fail(ErrorCode::StorageFailed, "drafts-create"))?;
        test_hook("initialize-before-publish", None);
        match temporary.persist_noclobber(directory.join(DATABASE)) {
            Ok(file) => {
                file.sync_all()
                    .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-publish"))?;
                sync_directory(&directory)?;
                test_hook("initialize-after-publish", None);
                Ok(after)
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                drop(error);
                let mut connection = self
                    .existing(true)?
                    .ok_or_else(|| fail(ErrorCode::OutcomeUnknown, "drafts-publish"))?;
                mutate_existing(&mut connection, key, &apply, self.limits)
            }
            Err(_) => Err(fail(ErrorCode::OutcomeUnknown, "drafts-publish")),
        }
    }
}

fn check_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(fail(ErrorCode::StorageFailed, "drafts-file"));
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
                use windows_sys::Win32::Storage::FileSystem::{
                    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
                    FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle,
                };
                let file = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(path)
                    .map_err(|_| fail(ErrorCode::StorageFailed, "drafts-file"))?;
                let mut info = BY_HANDLE_FILE_INFORMATION::default();
                // The borrowed handle remains live while Windows fills the
                // fixed-size file information structure.
                if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
                    || info.nNumberOfLinks != 1
                    || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                {
                    return Err(fail(ErrorCode::StorageFailed, "drafts-file"));
                }
            }
            Ok(true)
        }
        _ => Err(fail(ErrorCode::StorageFailed, "drafts-file")),
    }
}

fn configure(connection: &Connection, write: bool) -> Result<()> {
    connection.busy_timeout(Duration::ZERO).map_err(sql)?;
    let mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(sql)?;
    if mode != "delete" {
        return Err(fail(ErrorCode::InvalidInput, "drafts-journal"));
    }
    if write {
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(sql)?;
        #[cfg(test)]
        SQLITE_PAGE_LIMIT.with(|limit| {
            if limit.get() {
                let pages: i64 = connection
                    .pragma_query_value(None, "page_count", |row| row.get(0))
                    .map_err(sql)?;
                connection
                    .pragma_update(None, "max_page_count", pages)
                    .map_err(sql)?;
            }
            Ok::<_, ExecutionError>(())
        })?;
    } else {
        connection
            .pragma_update(None, "query_only", true)
            .map_err(sql)?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-publish"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn verify_schema(connection: &Connection) -> Result<i64> {
    let application: i64 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(sql)?;
    let format: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sql)?;
    if application != APPLICATION_ID || !matches!(format, LEGACY_FORMAT | FORMAT) {
        return Err(fail(ErrorCode::InvalidInput, "drafts-schema-version"));
    }
    let mut statement = connection
        .prepare(
            "SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .map_err(sql)?;
    let schema = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    if schema != vec![("draft_heads".into(), "table".into(), HEAD_SQL.into())] {
        return Err(fail(ErrorCode::CorruptLedger, "drafts-schema"));
    }
    Ok(format)
}

fn validate_key(key: &DraftKey) -> Result<()> {
    let locale =
        Locale::parse(&key.locale).map_err(|_| fail(ErrorCode::InvalidInput, "drafts-key"))?;
    if locale.as_str() != key.locale {
        return Err(fail(ErrorCode::InvalidInput, "drafts-key"));
    }
    Ok(())
}

fn validate_value(key: &DraftKey, value: &DraftValue) -> Result<()> {
    let basis = &value.basis;
    if basis.selection_id.is_some() != basis.revision_id.is_some()
        || basis.selection_id.is_some() != basis.text.is_some()
    {
        return Err(fail(ErrorCode::InvalidInput, "drafts-basis"));
    }
    if let Some(origin) = &value.merge {
        validate_merge(&origin.contributors, &origin.expected_basis)?;
    }
    let Some(pending) = &value.pending else {
        return Ok(());
    };
    let (project, unit, locale, source, selection, submitted) = match pending {
        DraftPending::Save {
            request,
            submitted_seq,
        } => {
            if value.merge.is_some() {
                return Err(fail(ErrorCode::InvalidInput, "drafts-merge-pending"));
            }
            (
                request.project_id,
                request.unit_id,
                &request.locale,
                request.source_revision_id,
                request.expected_selection_id,
                submitted_seq,
            )
        }
        DraftPending::Selection {
            request,
            submitted_seq,
            ..
        } => {
            if value.merge.is_some() {
                return Err(fail(ErrorCode::InvalidInput, "drafts-merge-pending"));
            }
            (
                request.project_id,
                request.unit_id,
                &request.locale,
                request.source_revision_id,
                request.expected_selection_id,
                submitted_seq,
            )
        }
        DraftPending::Merge {
            request,
            merge,
            submitted_seq,
        } => {
            validate_merge(&merge.contributors, &merge.expected_basis)?;
            let origin = value
                .merge
                .as_ref()
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "drafts-merge-pending"))?;
            if origin.contributors != merge.contributors
                || origin.expected_basis != merge.expected_basis
                || *submitted_seq == value.edit_seq && request.text != value.text
            {
                return Err(fail(ErrorCode::InvalidInput, "drafts-merge-pending"));
            }
            (
                request.project_id,
                request.unit_id,
                &request.locale,
                request.source_revision_id,
                request.expected_selection_id,
                submitted_seq,
            )
        }
    };
    if project != key.project_id
        || unit != key.unit_id
        || locale != &key.locale
        || source != basis.source_revision_id
        || selection != basis.selection_id
        || *submitted > value.edit_seq
    {
        return Err(fail(ErrorCode::InvalidInput, "drafts-pending"));
    }
    Ok(())
}

fn validate_merge(contributors: &[ExecutionId], basis: &str) -> Result<()> {
    if !(2..=4).contains(&contributors.len())
        || contributors
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != contributors.len()
        || basis.len() != 64
        || !basis
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(fail(ErrorCode::InvalidInput, "drafts-merge"));
    }
    Ok(())
}

fn empty_head(key: &DraftKey) -> DraftHead {
    DraftHead {
        key: key.clone(),
        revision: Revision::new(0).expect("zero revision"),
        writer_id: None,
        value: None,
    }
}

fn next_revision(before: Revision) -> Result<Revision> {
    before
        .next()
        .map_err(|_| fail(ErrorCode::LimitExceeded, "drafts-revision"))
}

fn apply_write(before: &DraftHead, request: &DraftWrite) -> Result<DraftHead> {
    // Only the exact current writer/value can recover an acknowledgement. An
    // old A request cannot succeed after B, even if it reuses the writer ID.
    if request.expected_revision <= before.revision
        && before.writer_id == Some(request.writer_id)
        && before.value.as_ref() == Some(&request.value)
    {
        return Ok(before.clone());
    }
    if before.revision != request.expected_revision {
        return Err(fail(ErrorCode::DependencyConflict, "drafts-revision"));
    }
    if before.writer_id == Some(request.writer_id)
        && before
            .value
            .as_ref()
            .is_some_and(|old| old.edit_seq > request.value.edit_seq)
    {
        return Err(fail(ErrorCode::DependencyConflict, "drafts-edit-sequence"));
    }
    Ok(DraftHead {
        key: request.key.clone(),
        revision: next_revision(before.revision)?,
        writer_id: Some(request.writer_id),
        value: Some(request.value.clone()),
    })
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_DRAFT_RECORD_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("draft record limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut bytes = Bounded(Vec::new());
    serde_json::to_writer(&mut bytes, value)
        .map_err(|_| fail(ErrorCode::LimitExceeded, "drafts-record-size"))?;
    Ok(bytes.0)
}

fn stored_id(value: &str) -> Result<ExecutionId> {
    ExecutionId::parse(value).map_err(|_| fail(ErrorCode::CorruptLedger, "drafts-record"))
}
fn stored_revision(value: i64) -> Result<Revision> {
    u64::try_from(value)
        .ok()
        .and_then(|value| Revision::new(value).ok())
        .ok_or_else(|| fail(ErrorCode::CorruptLedger, "drafts-record"))
}

struct StoredHead {
    revision: i64,
    edit_seq: Option<i64>,
    source: Option<String>,
    pending: i64,
    payload: Option<Vec<u8>>,
}

fn stored_head_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<StoredHead> {
    Ok(StoredHead {
        revision: row.get(offset)?,
        edit_seq: row.get(offset + 1)?,
        source: row.get(offset + 2)?,
        pending: row.get(offset + 3)?,
        payload: row.get(offset + 4)?,
    })
}

fn read_head(connection: &Connection, key: &DraftKey, format: i64) -> Result<DraftHead> {
    let row = connection.query_row("SELECT revision,edit_seq,source_revision_id,has_pending,CASE WHEN length(payload)<=?4 THEN payload END FROM draft_heads WHERE project_id=?1 AND locale=?2 AND unit_id=?3", params![key.project_id.to_string(), key.locale, key.unit_id.to_string(), MAX_DRAFT_RECORD_BYTES as i64], |row| stored_head_row(row, 0)).optional().map_err(sql)?;
    let Some(stored) = row else {
        return Ok(empty_head(key));
    };
    decode_head(key, stored, format)
}

fn decode_head(key: &DraftKey, stored: StoredHead, format: i64) -> Result<DraftHead> {
    let StoredHead {
        revision,
        edit_seq: seq,
        source,
        pending,
        payload,
    } = stored;
    let bytes = payload.ok_or_else(|| fail(ErrorCode::CorruptLedger, "drafts-record"))?;
    let head: DraftHead = serde_json::from_slice(&bytes)
        .map_err(|_| fail(ErrorCode::CorruptLedger, "drafts-record"))?;
    let value = head.value.as_ref();
    if validate_key(key).is_err()
        || head.key != *key
        || revision <= 0
        || head.revision != stored_revision(revision)?
        || head.writer_id.is_some() != value.is_some()
        || seq != value.map(|value| value.edit_seq.get() as i64)
        || source != value.map(|value| value.basis.source_revision_id.to_string())
        || pending != i64::from(value.is_some_and(|value| value.pending.is_some()))
        || value.is_some_and(|value| validate_value(key, value).is_err())
        || format == LEGACY_FORMAT
            && value.is_some_and(|value| {
                value.merge.is_some() || matches!(value.pending, Some(DraftPending::Merge { .. }))
            })
        || encode(&head).map_err(|_| fail(ErrorCode::CorruptLedger, "drafts-record"))? != bytes
    {
        return Err(fail(ErrorCode::CorruptLedger, "drafts-record"));
    }
    Ok(head)
}

fn persist_head(connection: &Connection, head: &DraftHead, payload: &[u8]) -> Result<()> {
    let value = head.value.as_ref();
    connection.execute("INSERT INTO draft_heads VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(project_id,locale,unit_id) DO UPDATE SET revision=excluded.revision,edit_seq=excluded.edit_seq,source_revision_id=excluded.source_revision_id,has_pending=excluded.has_pending,payload=excluded.payload", params![head.key.project_id.to_string(), head.key.locale, head.key.unit_id.to_string(), head.revision.get() as i64, value.map(|value| value.edit_seq.get() as i64), value.map(|value| value.basis.source_revision_id.to_string()), i64::from(value.is_some_and(|value| value.pending.is_some())), payload]).map_err(sql)?;
    Ok(())
}

fn check_quota(
    project_bytes: usize,
    total_bytes: usize,
    project_records: usize,
    total_records: usize,
    old_bytes: usize,
    new_bytes: usize,
    insert: bool,
    limits: Limits,
) -> Result<()> {
    let project = project_bytes
        .checked_sub(old_bytes)
        .and_then(|n| n.checked_add(new_bytes));
    let total = total_bytes
        .checked_sub(old_bytes)
        .and_then(|n| n.checked_add(new_bytes));
    if project.is_none_or(|n| n > limits.project_bytes)
        || total.is_none_or(|n| n > limits.total_bytes)
        || project_records.saturating_add(usize::from(insert)) > limits.project_records
        || total_records.saturating_add(usize::from(insert)) > limits.total_records
    {
        return Err(fail(ErrorCode::LimitExceeded, "drafts-capacity"));
    }
    Ok(())
}

fn mutate_existing(
    connection: &mut Connection,
    key: &DraftKey,
    apply: &impl Fn(&DraftHead) -> Result<DraftHead>,
    limits: Limits,
) -> Result<DraftHead> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    let format = verify_schema(&tx)?;
    let before = read_head(&tx, key, format)?;
    let after = apply(&before)?;
    if before == after {
        if format == LEGACY_FORMAT {
            tx.pragma_update(None, "user_version", FORMAT)
                .map_err(sql)?;
            tx.commit()
                .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
        }
        return Ok(before);
    }
    let payload = encode(&after)?;
    let (total_bytes, total_records, project_bytes, project_records): (i64,i64,i64,i64) = tx.query_row("SELECT COALESCE(SUM(length(payload)),0),COUNT(*),COALESCE(SUM(CASE WHEN project_id=?1 THEN length(payload) ELSE 0 END),0),COALESCE(SUM(CASE WHEN project_id=?1 THEN 1 ELSE 0 END),0) FROM draft_heads", [key.project_id.to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(sql)?;
    let old_bytes = if before.revision.get() == 0 {
        0
    } else {
        encode(&before)?.len()
    };
    check_quota(
        project_bytes as usize,
        total_bytes as usize,
        project_records as usize,
        total_records as usize,
        old_bytes,
        payload.len(),
        before.revision.get() == 0,
        limits,
    )?;
    persist_head(&tx, &after, &payload)?;
    if format == LEGACY_FORMAT {
        tx.pragma_update(None, "user_version", FORMAT)
            .map_err(sql)?;
    }
    test_hook("write-before-commit", Some(&tx));
    tx.commit()
        .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
    test_hook("write-after-commit", None);
    Ok(after)
}

#[cfg(not(test))]
fn test_hook(_: &str, _: Option<&Connection>) {}
#[cfg(test)]
thread_local! {
    static SQLITE_PAGE_LIMIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn test_hook(stage: &str, connection: Option<&Connection>) {
    if std::env::var("TSUMUGI_DRAFT_STORE_CRASH_STAGE").as_deref() == Ok(stage)
        && std::env::var_os("TSUMUGI_DRAFT_STORE_CRASH_CHILD").is_some()
    {
        if let Some(connection) = connection {
            connection.cache_flush().expect("crash fixture cache flush");
        }
        std::process::exit(91);
    }
}

#[cfg(test)]
mod tests;
