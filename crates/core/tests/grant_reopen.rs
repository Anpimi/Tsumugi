#![cfg(not(feature = "execution-test-host"))]
//! Structural grant validation across a normal Core project reopen.
mod support;

use rusqlite::{Connection, ffi, params};
use std::{
    cell::RefCell,
    ffi::{CStr, c_char, c_int, c_uint, c_void},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{
    PersistenceErrorCode, ProjectMetadata, ProjectStore,
    execution::{ExecutionId, FixedInput, InputEnvelope, InputItem, PluginConsent, Scope},
};

fn database(project: &Path) -> Connection {
    let connection = Connection::open(project.join("project.sqlite3")).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    connection
}

fn assert_corrupt_on_reopen(project: &Path) {
    assert_eq!(
        ProjectStore::open(project).unwrap_err().code(),
        PersistenceErrorCode::CorruptProject,
    );
}

fn insert_grant(connection: &Connection, attempt: ExecutionId, task: ExecutionId, digest: &str) {
    connection.execute(
        "INSERT INTO plugin_execution_grants (grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked) VALUES (?1,?2,?3,?4,?5,1,1,1)",
        params![ExecutionId::new().to_string(), attempt.to_string(), task.to_string(), digest, ExecutionId::new().to_string()],
    ).unwrap();
}

const GRANT_SCAN: &str = "SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked FROM plugin_execution_grants";

thread_local! {
    // The extension is process-global, but only this test's thread and one
    // explicitly armed open may attempt the external write.
    static SNAPSHOT_PROBE: RefCell<Option<SnapshotProbe>> = const { RefCell::new(None) };
}

#[derive(Debug, PartialEq, Eq)]
enum CommitOutcome {
    Busy,
    Committed,
    Failed(String),
}

struct SnapshotProbe {
    writer: Connection,
    attempt: String,
    wrong_digest: String,
    seen: usize,
    outcome: Option<CommitOutcome>,
    rollback_error: Option<String>,
}

impl SnapshotProbe {
    fn on_grant_scan(&mut self) {
        if self.seen != 0 {
            self.seen = self.seen.saturating_add(1);
            return;
        }
        self.seen = 1;
        if let Err(error) = self.writer.execute_batch("BEGIN IMMEDIATE") {
            self.outcome = Some(CommitOutcome::Failed(format!("begin: {error}")));
            return;
        }
        match self.writer.execute(
            "UPDATE plugin_execution_grants SET input_digest=?1 WHERE attempt_id=?2",
            params![&self.wrong_digest, &self.attempt],
        ) {
            Ok(1) => {}
            Ok(rows) => {
                self.outcome = Some(CommitOutcome::Failed(format!("update rows: {rows}")));
                self.rollback_error = self
                    .writer
                    .execute_batch("ROLLBACK")
                    .err()
                    .map(|e| e.to_string());
                return;
            }
            Err(error) => {
                self.outcome = Some(CommitOutcome::Failed(format!("update: {error}")));
                self.rollback_error = self
                    .writer
                    .execute_batch("ROLLBACK")
                    .err()
                    .map(|e| e.to_string());
                return;
            }
        }
        self.outcome = Some(match self.writer.execute_batch("COMMIT") {
            Ok(()) => CommitOutcome::Committed,
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::DatabaseBusy =>
            {
                CommitOutcome::Busy
            }
            Err(error) => CommitOutcome::Failed(format!("commit: {error}")),
        });
        if self.outcome != Some(CommitOutcome::Committed) {
            self.rollback_error = self
                .writer
                .execute_batch("ROLLBACK")
                .err()
                .map(|e| e.to_string());
        }
    }
}

unsafe extern "C" fn snapshot_trace(
    event: c_uint,
    _: *mut c_void,
    statement: *mut c_void,
    _: *mut c_void,
) -> c_int {
    if event == ffi::SQLITE_TRACE_STMT as c_uint && !statement.is_null() {
        let sql = unsafe { ffi::sqlite3_sql(statement.cast()) };
        if !sql.is_null() && unsafe { CStr::from_ptr(sql) }.to_bytes() == GRANT_SCAN.as_bytes() {
            let _ = SNAPSHOT_PROBE.try_with(|cell| {
                if let Ok(mut armed) = cell.try_borrow_mut() {
                    if let Some(probe) = armed.as_mut() {
                        probe.on_grant_scan();
                    }
                }
            });
        }
    }
    0
}

unsafe extern "C" fn install_snapshot_trace(
    connection: *mut ffi::sqlite3,
    _: *mut *mut c_char,
    _: *const ffi::sqlite3_api_routines,
) -> c_int {
    unsafe {
        ffi::sqlite3_trace_v2(
            connection,
            ffi::SQLITE_TRACE_STMT as c_uint,
            Some(snapshot_trace),
            std::ptr::null_mut(),
        )
    }
}

struct SnapshotTraceRegistration;

impl SnapshotTraceRegistration {
    fn new() -> Self {
        assert_eq!(
            unsafe { ffi::sqlite3_auto_extension(Some(install_snapshot_trace)) },
            ffi::SQLITE_OK,
        );
        Self
    }
}

impl Drop for SnapshotTraceRegistration {
    fn drop(&mut self) {
        // Do not reset another test's process-global auto extensions.
        unsafe { ffi::sqlite3_cancel_auto_extension(Some(install_snapshot_trace)) };
    }
}

#[test]
fn reopen_uses_one_snapshot_for_ledger_and_grant_associations() {
    let (directory, store, _) = support::source_fixture();
    store.close().unwrap();
    let project = directory.path().join("project");
    // Open the writer before registering the trace, so the callback is only
    // installed on Core's subsequently opened connection.
    let writer = database(&project);
    writer.busy_timeout(Duration::ZERO).unwrap();
    let (attempt, digest): (String, String) = writer
        .query_row(
            "SELECT attempt_id,input_digest FROM plugin_execution_grants LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let wrong_digest = "0".repeat(64);
    assert_ne!(digest, wrong_digest);
    let before = std::fs::read(project.join("project.sqlite3")).unwrap();
    SNAPSHOT_PROBE.with(|cell| {
        assert!(
            cell.borrow_mut()
                .replace(SnapshotProbe {
                    writer,
                    attempt,
                    wrong_digest,
                    seen: 0,
                    outcome: None,
                    rollback_error: None,
                })
                .is_none()
        );
    });
    let registration = SnapshotTraceRegistration::new();
    let reopened = ProjectStore::open(&project);
    let probe = SNAPSHOT_PROBE.with(|cell| cell.borrow_mut().take().unwrap());
    drop(registration);
    assert_eq!(
        probe.seen, 1,
        "the full grant scan must be reached exactly once"
    );
    assert_eq!(probe.outcome, Some(CommitOutcome::Busy));
    assert_eq!(
        probe.rollback_error, None,
        "the blocked writer must roll back"
    );
    reopened.unwrap().close().unwrap();
    drop(probe);
    assert_eq!(
        std::fs::read(project.join("project.sqlite3")).unwrap(),
        before
    );
}

#[test]
fn revoked_grant_still_checks_exact_input_digest_and_task() {
    let (directory, store, _) = support::source_fixture();
    store.close().unwrap();
    let project = directory.path().join("project");
    let connection = database(&project);
    let (attempt, task, digest, revoked): (String, String, String, i64) = connection
        .query_row(
            "SELECT attempt_id,task_id,input_digest,revoked FROM plugin_execution_grants LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(revoked, 1, "the source fixture revokes executed grants");
    let wrong_digest = "0".repeat(64);
    assert_ne!(digest, wrong_digest);
    connection
        .execute(
            "UPDATE plugin_execution_grants SET input_digest=?1 WHERE attempt_id=?2",
            params![wrong_digest, attempt],
        )
        .unwrap();
    assert_corrupt_on_reopen(&project);
    connection
        .execute(
            "UPDATE plugin_execution_grants SET input_digest=?1 WHERE attempt_id=?2",
            params![digest, attempt],
        )
        .unwrap();
    ProjectStore::open(&project).unwrap().close().unwrap();

    let wrong_task = ExecutionId::new().to_string();
    assert_ne!(task, wrong_task);
    connection
        .execute(
            "UPDATE plugin_execution_grants SET task_id=?1 WHERE attempt_id=?2",
            params![wrong_task, attempt],
        )
        .unwrap();
    assert_corrupt_on_reopen(&project);
}

#[test]
fn missing_grant_for_queued_plugin_input_and_orphan_grant_remain_valid() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    let mut store = ProjectStore::create(
        &project,
        ProjectMetadata::create("Grant reopen", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let input = support::source_input(&store);
    let mut runtime = support::source_runtime(&store);
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    runtime
        .authorize_plugin(
            &mut store,
            ExecutionId::new(),
            &input,
            expiry,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drop(runtime);
    store.close().unwrap();

    let connection = database(&project);
    assert_eq!(
        connection
            .execute("DELETE FROM plugin_execution_grants", [])
            .unwrap(),
        1
    );
    ProjectStore::open(&project).unwrap().close().unwrap();

    insert_grant(
        &connection,
        ExecutionId::new(),
        ExecutionId::new(),
        &"0".repeat(64),
    );
    ProjectStore::open(&project).unwrap().close().unwrap();

    connection
        .execute_batch("ALTER TABLE plugin_execution_grants ADD COLUMN extra INTEGER")
        .unwrap();
    assert_corrupt_on_reopen(&project);
}

#[test]
fn a_grant_cannot_be_attached_to_a_nonplugin_attempt() {
    let (directory, mut store, _) = support::source_fixture();
    let item = InputItem::new(
        Scope {
            kind: "fixture".into(),
            id: "plain".into(),
            locale: None,
        },
        serde_json::json!({"text":"plain"}),
        vec![],
    );
    let envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "fixture",
        "controlled",
        "1",
        vec![item],
    )
    .unwrap();
    let input = FixedInput::capture(envelope).unwrap();
    store.enqueue_read_only_execution(&input).unwrap();
    store.close().unwrap();
    let project = directory.path().join("project");
    let connection = database(&project);
    insert_grant(
        &connection,
        input.envelope().attempt_id,
        input.envelope().task_id,
        input.digest(),
    );
    assert_corrupt_on_reopen(&project);
}

#[test]
fn an_orphan_grant_cannot_borrow_a_delegated_task() {
    let (directory, store, _) = support::source_fixture();
    let project_id = store.metadata().unwrap().project_id().to_string();
    store.close().unwrap();
    let project = directory.path().join("project");
    let connection = database(&project);
    let parent = ExecutionId::new().to_string();
    let child = ExecutionId::new().to_string();
    for task in [&parent, &child] {
        connection.execute(
            "INSERT INTO execution_tasks (task_id,project_id,operation,sequence) VALUES (?1,?2,'fixture',(SELECT COALESCE(MAX(sequence),0)+1 FROM execution_tasks))",
            params![task, &project_id],
        ).unwrap();
    }
    connection
        .execute(
            "INSERT INTO execution_budgets VALUES (?1,NULL,10,0)",
            params![&parent],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO execution_budgets VALUES (?1,?2,5,0)",
            params![&child, &parent],
        )
        .unwrap();
    for (task, ancestor) in [(&parent, &parent), (&child, &child), (&child, &parent)] {
        connection
            .execute(
                "INSERT INTO execution_budget_ancestry VALUES (?1,?2)",
                params![task, ancestor],
            )
            .unwrap();
    }
    ProjectStore::open(&project).unwrap().close().unwrap();
    insert_grant(
        &connection,
        ExecutionId::new(),
        ExecutionId::parse(&child).unwrap(),
        &"0".repeat(64),
    );
    assert_corrupt_on_reopen(&project);
}
