//! Reuse of fully verified immutable frames, never execution authority.
//! A proof is created only inside a pinned READ snapshot. SQLite preupdate
//! notifications irreversibly invalidate it before any dependent row changes;
//! external commits and schema changes are checked at each use.
use super::{ExecutionError, FixedInput, FixedResult, MAX_FIXED_INPUT_BYTES, sql_error};
use crate::execution::{Cancellation, ErrorCode};
use rusqlite::{Connection, TransactionState, hooks::PreUpdateCase, params};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

const MAX_CONNECTIONS: usize = 32;
const MAX_ROWS: usize = 4 * MAX_FIXED_INPUT_BYTES.div_ceil(super::input_storage::CHUNK_BYTES) + 16;
const MAX_WATCHES: usize = 2 * MAX_ROWS;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Table {
    Attempt,
    Result,
    Chunk,
}
impl Table {
    fn named(name: &str) -> Option<Self> {
        match name {
            "execution_attempts" => Some(Self::Attempt),
            "execution_results" => Some(Self::Result),
            "execution_input_chunks" => Some(Self::Chunk),
            _ => None,
        }
    }
}
type Row = (Table, i64);
#[derive(Default)]
struct Observer {
    rows: BTreeMap<Row, Vec<Weak<AtomicBool>>>,
    release_evidence: u64,
    source_page: Option<SourcePageWatch>,
    review_reader: Option<Weak<Cancellation>>,
}

struct SourcePageWatch {
    attempt: String,
    valid: Weak<AtomicBool>,
}

impl SourcePageWatch {
    fn survives(&self, table: &str, case: &PreUpdateCase) -> bool {
        match (table, case) {
            (_, PreUpdateCase::Unknown) => false,
            ("release_records" | "release_artifacts" | "release_deliveries", _) => true,
            ("adoption_receipts", PreUpdateCase::Insert(row)) => {
                // A new receipt for the source attempt could change which
                // receipt validates the snapshot. Release saves use their own attempt.
                row.get_new_column_value(1)
                    .ok()
                    .and_then(|value| value.as_str().ok())
                    .is_some_and(|attempt| attempt != self.attempt)
            }
            ("execution_items", PreUpdateCase::Update {
                old_value_accessor: old,
                new_value_accessor: new,
            }) => {
                // Release adoption changes only the adoption state of its item.
                old.get_old_column_value(0)
                    .ok()
                    .and_then(|value| value.as_str().ok())
                    .is_some_and(|attempt| attempt != self.attempt)
                    && old.get_column_count() == 9
                    && new.get_column_count() == 9
                    && (0..9).filter(|&column| column != 4).all(|column| {
                        match (old.get_old_column_value(column), new.get_new_column_value(column)) {
                            (Ok(before), Ok(after)) => before == after,
                            _ => false,
                        }
                    })
            }
            _ => false,
        }
    }
}

impl Observer {
    fn invalidate(&mut self, row: Row) {
        if let Some(tokens) = self.rows.remove(&row) {
            for token in tokens.into_iter().filter_map(|token| token.upgrade()) {
                token.store(false, Ordering::Release);
            }
        }
    }
    fn prune(&mut self) {
        self.rows.retain(|_, tokens| {
            tokens.retain(|token| {
                token
                    .upgrade()
                    .is_some_and(|token| token.load(Ordering::Acquire))
            });
            !tokens.is_empty()
        });
    }
}
type State = Mutex<Observer>;
fn registry() -> &'static Mutex<BTreeMap<String, Weak<State>>> {
    static STATES: OnceLock<Mutex<BTreeMap<String, Weak<State>>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

pub(super) fn register(connection: &Connection, identity: &str) -> rusqlite::Result<()> {
    let state = Arc::new(Mutex::new(Observer::default()));
    let mut states = registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    states.retain(|_, state| state.strong_count() != 0);
    // This is an optimization bound, not a project/connection admission limit.
    // An evicted registry entry falls back to full verification on new reads.
    if states.len() >= MAX_CONNECTIONS {
        states.pop_first();
    }
    states.insert(identity.into(), Arc::downgrade(&state));
    drop(states);
    connection.preupdate_hook(Some(
        move |_, database: &str, table: &str, case: &PreUpdateCase| {
            let mut observer = state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if observer.source_page.as_ref().is_some_and(|watch| {
                database != "main" || !watch.survives(table, case)
            }) && let Some(token) = observer.source_page.take().and_then(|watch| watch.valid.upgrade())
            {
                token.store(false, Ordering::Release);
            }
            if database != "main" {
                return;
            }
            if let Some(read) = observer.review_reader.as_ref().and_then(Weak::upgrade) {
                // DELETE journaling requires readers to yield before the writer
                // needs its exclusive commit lock.
                read.request();
            }
            if super::super::release::invalidates_evidence(table, case) {
                observer.release_evidence += 1;
            }
            let Some(table) = Table::named(table) else { return; };
            match case {
                PreUpdateCase::Insert(value) => {
                    observer.invalidate((table, value.get_new_row_id()))
                }
                PreUpdateCase::Delete(value) => {
                    observer.invalidate((table, value.get_old_row_id()))
                }
                PreUpdateCase::Update {
                    old_value_accessor,
                    new_value_accessor,
                } => {
                    observer.invalidate((table, old_value_accessor.get_old_row_id()));
                    observer.invalidate((table, new_value_accessor.get_new_row_id()));
                }
                PreUpdateCase::Unknown => {
                    for tokens in observer.rows.values() {
                        for token in tokens.iter().filter_map(Weak::upgrade) {
                            token.store(false, Ordering::Release);
                        }
                    }
                    observer.rows.clear();
                }
            }
        },
    ))
}

fn connection_observer(connection: &Connection) -> Result<Option<Arc<State>>, ExecutionError> {
    let identity: String = connection
        .query_row("SELECT tsumugi_connection_identity()", [], |row| row.get(0))
        .map_err(sql_error)?;
    Ok(registry().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&identity).and_then(Weak::upgrade))
}

pub(in crate::persistence) fn watch_review_reader(
    connection: &Connection, cancellation: Cancellation,
) -> Result<Option<Arc<Cancellation>>, ExecutionError> {
    let Some(state) = connection_observer(connection)? else { return Ok(None); };
    let mut state = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.review_reader.as_ref().and_then(Weak::upgrade).is_some() {
        return Err(ExecutionError::new(ErrorCode::Busy, "review-read-active"));
    }
    let cancellation = Arc::new(cancellation);
    state.review_reader = Some(Arc::downgrade(&cancellation));
    Ok(Some(cancellation))
}

pub(in crate::persistence) fn cancel_review_reader(connection: &Connection) {
    if let Ok(Some(state)) = connection_observer(connection)
        && let Some(read) = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .review_reader.as_ref().and_then(Weak::upgrade)
    {
        read.request();
    }
}

/// Keep the current page projection only while its checked source is unchanged.
pub(in crate::persistence) fn watch_source_page(
    connection: &Connection,
    attempt: String,
) -> Result<Option<FrameReadGuard>, ExecutionError> {
    let Some(read) = ReadObservation::begin(connection)? else { return Ok(None); };
    let Some(state) = read.state.upgrade() else { return Ok(None); };
    let valid = Arc::new(AtomicBool::new(true));
    let previous = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .source_page.replace(SourcePageWatch { attempt, valid: Arc::downgrade(&valid) });
    if let Some(token) = previous.and_then(|watch| watch.valid.upgrade()) {
        token.store(false, Ordering::Release);
    }
    Ok(Some(FrameReadGuard { stamp: read.stamp, state: read.state, valid }))
}

#[derive(Clone, PartialEq, Eq)]
#[derive(Debug)]
struct Stamp {
    connection: String,
    data: i64,
    schema: i64,
    temp_schema: i64,
}
fn stamp(connection: &Connection) -> Result<Stamp, ExecutionError> {
    Ok(Stamp {
        connection: connection
            .query_row("SELECT tsumugi_connection_identity()", [], |row| row.get(0))
            .map_err(sql_error)?,
        data: connection
            .query_row("PRAGMA main.data_version", [], |row| row.get(0))
            .map_err(sql_error)?,
        schema: connection
            .query_row("PRAGMA main.schema_version", [], |row| row.get(0))
            .map_err(sql_error)?,
        temp_schema: connection
            .query_row("PRAGMA temp.schema_version", [], |row| row.get(0))
            .map_err(sql_error)?,
    })
}
fn pin(connection: &Connection) -> Result<(), ExecutionError> {
    connection
        .query_row("SELECT count(*) FROM main.sqlite_schema", [], |_| Ok(()))
        .map_err(sql_error)
}

/// Snapshot marker for historical release evidence. The release owner checks
/// the few insert-sensitive relationships that can change independently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::persistence) struct ReleaseEvidenceStamp {
    stamp: Stamp,
    generation: u64,
}

impl ReleaseEvidenceStamp {
    pub(in crate::persistence) fn capture(connection: &Connection) -> Result<Option<Self>, ExecutionError> {
        if connection.is_autocommit() {
            return Ok(None);
        }
        pin(connection)?;
        let stamp = stamp(connection)?;
        let state = registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&stamp.connection)
            .and_then(Weak::upgrade);
        Ok(state.map(|state| {
            let generation = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
                .release_evidence;
            Self { stamp, generation }
        }))
    }
}

pub(super) struct ReadObservation {
    stamp: Stamp,
    state: Weak<State>,
}
impl ReadObservation {
    /// Call before reading/validating bytes. WRITE snapshots cannot establish
    /// new proofs: rollback and rollback-to-savepoint could restore other bytes.
    pub(super) fn begin(connection: &Connection) -> Result<Option<Self>, ExecutionError> {
        if connection.is_autocommit() {
            return Ok(None);
        }
        pin(connection)?;
        if connection
            .transaction_state(Some(rusqlite::MAIN_DB))
            .map_err(sql_error)?
            != TransactionState::Read
        {
            return Ok(None);
        }
        let stamp = stamp(connection)?;
        let state = registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&stamp.connection)
            .cloned();
        Ok(state
            .filter(|state| state.strong_count() != 0)
            .map(|state| Self { stamp, state }))
    }

    /// The caller has verified every complete frame and its stored association
    /// since begin(), in this same held snapshot. Only row identities are read
    /// here; this method does not substitute a digest for byte verification.
    pub(super) fn finish(
        self,
        connection: &Connection,
        inputs: &[&FixedInput],
        results: &[&FixedResult],
    ) -> Result<Option<FrameReadGuard>, ExecutionError> {
        let mut rows = BTreeSet::new();
        for input in inputs {
            let attempt = input.envelope().attempt_id.to_string();
            let rowid = connection
                .query_row(
                    "SELECT rowid FROM execution_attempts WHERE attempt_id=?1 AND digest=?2",
                    params![attempt, input.digest()],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            rows.insert((Table::Attempt, rowid));
            let mut statement = connection.prepare(
                "SELECT c.rowid FROM execution_attempts a, json_each(CAST(a.input AS TEXT),'$.chunks') part
                 JOIN execution_input_chunks c ON c.digest=part.value WHERE a.attempt_id=?1").map_err(sql_error)?;
            let found = statement
                .query_map([attempt], |row| row.get::<_, i64>(0))
                .map_err(sql_error)?;
            for row in found {
                rows.insert((Table::Chunk, row.map_err(sql_error)?));
                if rows.len() > MAX_ROWS {
                    return Ok(None);
                }
            }
        }
        for result in results {
            let rowid = connection.query_row("SELECT rowid FROM execution_results WHERE result_id=?1 AND attempt_id=?2 AND digest=?3",
                params![result.envelope().result_id.to_string(), result.envelope().attempt_id.to_string(), result.digest()],
                |row| row.get(0)).map_err(sql_error)?;
            rows.insert((Table::Result, rowid));
        }
        self.finish_rows(connection, rows)
    }

    fn finish_rows(
        self,
        connection: &Connection,
        rows: BTreeSet<Row>,
    ) -> Result<Option<FrameReadGuard>, ExecutionError> {
        if connection.is_autocommit()
            || connection
                .transaction_state(Some(rusqlite::MAIN_DB))
                .map_err(sql_error)?
                != TransactionState::Read
            || stamp(connection)? != self.stamp
        {
            return Ok(None);
        }
        let Some(state) = self.state.upgrade() else {
            return Ok(None);
        };
        let mut observer = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        observer.prune();
        let watches: usize = observer.rows.values().map(Vec::len).sum();
        let added = rows
            .iter()
            .filter(|row| !observer.rows.contains_key(row))
            .count();
        if observer.rows.len() + added > MAX_ROWS || watches + rows.len() > MAX_WATCHES {
            return Ok(None);
        }
        let valid = Arc::new(AtomicBool::new(true));
        for row in rows {
            observer
                .rows
                .entry(row)
                .or_default()
                .push(Arc::downgrade(&valid));
        }
        Ok(Some(FrameReadGuard {
            stamp: self.stamp,
            state: self.state,
            valid,
        }))
    }
}

#[derive(Clone, Debug)]
pub(in crate::persistence) struct FrameReadGuard {
    stamp: Stamp,
    state: Weak<State>,
    valid: Arc<AtomicBool>,
}
impl FrameReadGuard {
    /// Existing READ proofs remain usable in a writer transaction until one of
    /// their actual rows changes. Unrelated result inserts do not invalidate.
    pub(in crate::persistence) fn current(&self, connection: &Connection) -> Result<bool, ExecutionError> {
        if connection.is_autocommit()
            || !self.valid.load(Ordering::Acquire)
            || self.state.strong_count() == 0
        {
            return Ok(false);
        }
        pin(connection)?;
        Ok(stamp(connection)? == self.stamp && self.valid.load(Ordering::Acquire))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(connection: &Connection) {
        super::super::register_input_reader(connection).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE execution_results(id TEXT UNIQUE, bytes BLOB, digest TEXT);
            INSERT INTO execution_results VALUES('original',X'6F726967696E616C','unchanged')",
            )
            .unwrap();
    }
    fn observed(connection: &Connection) -> FrameReadGuard {
        connection.execute_batch("BEGIN").unwrap();
        let observation = ReadObservation::begin(connection).unwrap().unwrap();
        // Stand in for the owner's complete frame verification; these tests
        // exercise storage dependency/lifetime tracking, not frame semantics.
        let (rowid, bytes): (i64, Vec<u8>) = connection
            .query_row(
                "SELECT rowid,bytes FROM execution_results WHERE id='original'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(bytes, b"original");
        let guard = observation
            .finish_rows(connection, BTreeSet::from([(Table::Result, rowid)]))
            .unwrap()
            .unwrap();
        connection.execute_batch("COMMIT").unwrap();
        guard
    }
    fn current(connection: &Connection, guard: &FrameReadGuard) -> bool {
        connection.execute_batch("BEGIN").unwrap();
        let valid = guard.current(connection).unwrap();
        connection.execute_batch("COMMIT").unwrap();
        valid
    }
    #[test]
    fn unrelated_result_inserts_preserve_proof_but_same_length_same_digest_edits_do_not() {
        let connection = Connection::open_in_memory().unwrap();
        setup(&connection);
        let guard = observed(&connection);
        for index in 0..100 {
            connection
                .execute(
                    "INSERT INTO execution_results VALUES(?1,X'78','other')",
                    [index.to_string()],
                )
                .unwrap();
            assert!(current(&connection, &guard));
        }
        connection
            .execute(
                "UPDATE execution_results SET bytes=X'6368616E67656421' WHERE id='original'",
                [],
            )
            .unwrap();
        assert!(!current(&connection, &guard));
    }
    #[test]
    fn replacement_rowid_updates_and_truncate_deletes_invalidate() {
        for change in [
            "INSERT OR REPLACE INTO execution_results(rowid,id,bytes,digest) VALUES(42,'original',X'6368616E67656421','unchanged')",
            "INSERT OR REPLACE INTO execution_results(rowid,id,bytes,digest) VALUES(1,'original',X'6368616E67656421','unchanged')",
            "UPDATE execution_results SET rowid=42 WHERE id='original'",
            "DELETE FROM execution_results",
        ] {
            let connection = Connection::open_in_memory().unwrap();
            setup(&connection);
            let guard = observed(&connection);
            connection.execute_batch(change).unwrap();
            assert!(!current(&connection, &guard), "{change}");
        }
    }
    #[test]
    fn write_snapshots_cannot_create_proofs_and_rollback_never_revives_invalidated_proofs() {
        let connection = Connection::open_in_memory().unwrap();
        setup(&connection);
        let guard = observed(&connection);
        connection
            .execute_batch("BEGIN IMMEDIATE; SAVEPOINT change")
            .unwrap();
        assert!(ReadObservation::begin(&connection).unwrap().is_none());
        assert!(guard.current(&connection).unwrap());
        connection
            .execute_batch(
                "UPDATE execution_results SET bytes=X'6368616E67656421'; ROLLBACK TO change",
            )
            .unwrap();
        assert!(!guard.current(&connection).unwrap());
        connection.execute_batch("ROLLBACK").unwrap();
        assert!(!current(&connection, &guard));
        assert!(current(&connection, &observed(&connection)));
    }
    #[test]
    fn external_commits_schema_changes_and_new_connection_identity_expire_proofs() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let connection = Connection::open(file.path()).unwrap();
        setup(&connection);
        let guard = observed(&connection);
        let external = Connection::open(file.path()).unwrap();
        external
            .execute("UPDATE execution_results SET bytes=X'6368616E67656421'", [])
            .unwrap();
        assert!(!current(&connection, &guard));
        external
            .execute("UPDATE execution_results SET bytes=X'6F726967696E616C'", [])
            .unwrap();
        let guard = observed(&connection);
        connection
            .execute_batch("CREATE INDEX result_bytes ON execution_results(digest)")
            .unwrap();
        assert!(!current(&connection, &guard));
        let guard = observed(&connection);
        super::super::register_input_reader(&connection).unwrap();
        assert_eq!(guard.state.strong_count(), 0);
        assert!(!current(&connection, &guard));
    }
    #[test]
    fn expired_watch_tokens_are_reclaimed_and_connection_close_drops_observer() {
        let connection = Connection::open_in_memory().unwrap();
        setup(&connection);
        let guard = observed(&connection);
        let state = guard.state.clone();
        drop(guard);
        let guard = observed(&connection);
        assert_eq!(
            state
                .upgrade()
                .unwrap()
                .lock()
                .unwrap()
                .rows
                .values()
                .map(Vec::len)
                .sum::<usize>(),
            1
        );
        drop(connection);
        assert_eq!(guard.state.strong_count(), 0);
    }
}
