#![cfg(not(feature = "execution-test-host"))]
//! Normal Core, real grants/runtime/SQLite and a synthetic SDK checker.
//! This does not attest installed workers or a domain parser.
mod support;

use rusqlite::{Connection, ffi};
use std::{
    cell::{Cell, RefCell},
    ffi::{CStr, c_char, c_int, c_uint, c_void},
    time::Instant,
};
use tsumugi_core::{
    ProjectStore, ReviewDecisionKind, ReviewWrite, SaveTranslationRevision,
    execution::{Cancellation, ErrorCode, ExecutionId},
};

thread_local! {
    static STATEMENTS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
    static FRAME_ROWS: RefCell<usize> = const { RefCell::new(0) };
    static FRAME_GATE: RefCell<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> = const { RefCell::new(None) };
    static MEASURED_CONNECTION: Cell<*mut ffi::sqlite3> = const { Cell::new(std::ptr::null_mut()) };
    static REOPEN_PROFILE: RefCell<Option<ReopenProfile>> = const { RefCell::new(None) };
    static SETUP_PROFILE: RefCell<Option<SetupProfile>> = const { RefCell::new(None) };
}

#[derive(Default)]
struct SetupProfile {
    ordinal: usize,
    phase: &'static str,
    returned_input_frames: usize,
    returned_input_bytes: u64,
    source_mapping_rows: usize,
}

impl SetupProfile {
    fn row(&mut self, sql: &str, statement: *mut ffi::sqlite3_stmt) {
        if let Some(bytes) = returned_input_bytes(sql, statement) {
            self.returned_input_frames += 1;
            self.returned_input_bytes += bytes;
        }
        // This is snapshot_rows' complete occurrence/projection validation
        // query, not a COUNT or a selected-unit target lookup.
        if sql.contains(
            "FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id",
        ) && sql.contains("JOIN source_identity i ON i.occurrence_id=o.occurrence_id")
            && sql.contains("WHERE o.snapshot_id=?1 ORDER BY o.ordinal")
        {
            self.source_mapping_rows += 1;
        }
    }
}

// These windows begin at each validation loop's first query and end at the
// next identifiable query. They include intervening validation work, so their
// elapsed times are diagnostic windows rather than exclusive CPU timings.
const REOPEN_WINDOWS: [(&str, &str, &str); 4] = [
    (
        "review-index",
        "SELECT project_id,action_id FROM review_checks WHERE purpose='qa'",
        "SELECT attempt_id FROM execution_attempts ORDER BY sequence",
    ),
    (
        "ledger-attempts",
        "SELECT attempt_id FROM execution_attempts ORDER BY sequence",
        "SELECT producer_result_id,valid FROM plugin_validation_links",
    ),
    (
        "plugin-grants",
        "SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,application_execution,revoked,delegation FROM plugin_execution_grants",
        "SELECT plan_id FROM application_plans",
    ),
    (
        "application-control",
        "SELECT plan_id FROM application_plans",
        "SELECT unit_id,locale,revision,protected FROM application_protections",
    ),
];

// Count actual returned BLOBs, including the original control scan whose input
// frame is column four. Statement counts alone cannot expose repeated decoding.
fn returned_input_bytes(sql: &str, statement: *mut ffi::sqlite3_stmt) -> Option<u64> {
    if !sql.contains("tsumugi_input_chunks(") {
        return None;
    }
    let column = if sql
        .contains("FROM execution_attempts a LEFT JOIN application_executions x USING(attempt_id)")
    {
        4
    } else if sql.contains("FROM execution_attempts a WHERE a.attempt_id=?1")
        || sql.contains("FROM wanted w JOIN execution_attempts")
    {
        1
    } else {
        return None;
    };
    (unsafe { ffi::sqlite3_column_type(statement, column) } == ffi::SQLITE_BLOB)
        .then(|| unsafe { ffi::sqlite3_column_bytes(statement, column) } as u64)
}

struct ActiveReopenWindow {
    started: Instant,
    statements: usize,
    frames: usize,
    frame_bytes: u64,
}

#[derive(Default)]
struct ReopenProfile {
    next: usize,
    active: Option<ActiveReopenWindow>,
    completed: Vec<serde_json::Value>,
}

impl ReopenProfile {
    fn statement(&mut self, sql: &str) {
        if let Some(active) = &self.active {
            if sql.trim() == REOPEN_WINDOWS[self.next].2 {
                let elapsed = active.started.elapsed();
                let active = self.active.take().unwrap();
                self.completed.push(serde_json::json!({
                    "name": REOPEN_WINDOWS[self.next].0,
                    "elapsedMs": elapsed.as_secs_f64() * 1000.0,
                    "statements": active.statements,
                    "reconstructedFrames": active.frames,
                    "reconstructedBytes": active.frame_bytes,
                }));
                self.next += 1;
            }
        }
        if self.active.is_none()
            && self.next < REOPEN_WINDOWS.len()
            && sql.trim() == REOPEN_WINDOWS[self.next].1
        {
            self.active = Some(ActiveReopenWindow {
                started: Instant::now(),
                statements: 0,
                frames: 0,
                frame_bytes: 0,
            });
        }
        if let Some(active) = &mut self.active {
            active.statements += 1;
        }
    }

    fn row(&mut self, sql: &str, statement: *mut ffi::sqlite3_stmt) {
        let Some(active) = &mut self.active else {
            return;
        };
        if let Some(bytes) = returned_input_bytes(sql, statement) {
            active.frames += 1;
            active.frame_bytes += bytes;
        }
    }
}

// Only this integration-test process registers the static callback. Capture is
// thread-local and disabled outside measured reads; SQL is not expanded.
unsafe extern "C" fn trace(
    event: c_uint,
    _: *mut c_void,
    statement: *mut c_void,
    _: *mut c_void,
) -> c_int {
    if !statement.is_null() {
        let sql = unsafe { ffi::sqlite3_sql(statement.cast()) };
        if !sql.is_null() {
            let _ = STATEMENTS.try_with(|statements| {
                if let Ok(mut statements) = statements.try_borrow_mut() {
                    if let Some(captured) = statements.as_mut() {
                        let _ = MEASURED_CONNECTION.try_with(|connection| {
                            connection.set(unsafe { ffi::sqlite3_db_handle(statement.cast()) });
                        });
                        let sql = unsafe { CStr::from_ptr(sql) }.to_string_lossy();
                        if event == ffi::SQLITE_TRACE_STMT as c_uint {
                            let _ = REOPEN_PROFILE.try_with(|profile| {
                                if let Ok(mut profile) = profile.try_borrow_mut() {
                                    if let Some(profile) = profile.as_mut() {
                                        profile.statement(&sql);
                                    }
                                }
                            });
                            captured.push(sql.into_owned());
                        } else if event == ffi::SQLITE_TRACE_ROW as c_uint {
                            let _ = SETUP_PROFILE.try_with(|profile| {
                                if let Ok(mut profile) = profile.try_borrow_mut() {
                                    if let Some(profile) = profile.as_mut() {
                                        profile.row(&sql, statement.cast());
                                    }
                                }
                            });
                            let _ = REOPEN_PROFILE.try_with(|profile| {
                                if let Ok(mut profile) = profile.try_borrow_mut() {
                                    if let Some(profile) = profile.as_mut() {
                                        profile.row(&sql, statement.cast());
                                    }
                                }
                            });
                            if sql.contains("FROM wanted w JOIN execution_attempts") {
                                let _ = FRAME_ROWS.try_with(|rows| {
                                    if let Ok(mut rows) = rows.try_borrow_mut() {
                                        *rows += 1;
                                        if *rows == 2 {
                                            let _ = FRAME_GATE.try_with(|gate| {
                                                if let Ok(mut gate) = gate.try_borrow_mut() {
                                                    if let Some((entered, release)) = gate.take() {
                                                        let _ = entered.send(());
                                                        let _ = release.recv_timeout(
                                                            std::time::Duration::from_secs(5),
                                                        );
                                                    }
                                                }
                                            });
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
            });
        }
    }
    0
}

unsafe extern "C" fn install_trace(
    connection: *mut ffi::sqlite3,
    _: *mut *mut c_char,
    _: *const ffi::sqlite3_api_routines,
) -> c_int {
    unsafe {
        ffi::sqlite3_trace_v2(
            connection,
            (ffi::SQLITE_TRACE_STMT | ffi::SQLITE_TRACE_ROW) as c_uint,
            Some(trace),
            std::ptr::null_mut(),
        )
    }
}

struct TraceRegistration;
impl TraceRegistration {
    fn new() -> Self {
        assert_eq!(
            unsafe { ffi::sqlite3_auto_extension(Some(install_trace)) },
            ffi::SQLITE_OK
        );
        Self
    }
}
impl Drop for TraceRegistration {
    fn drop(&mut self) {
        // Remove only this callback, never reset somebody else's extension.
        unsafe { ffi::sqlite3_cancel_auto_extension(Some(install_trace)) };
    }
}

fn measured<T>(name: &str, read: impl FnOnce() -> T) -> (T, Vec<String>) {
    MEASURED_CONNECTION.with(|connection| connection.set(std::ptr::null_mut()));
    FRAME_ROWS.with(|rows| *rows.borrow_mut() = 0);
    STATEMENTS.with(|statements| assert!(statements.borrow_mut().replace(Vec::new()).is_none()));
    let started = Instant::now();
    let value = read();
    let elapsed = started.elapsed();
    let statements = STATEMENTS.with(|statements| statements.borrow_mut().take().unwrap());
    let setup = SETUP_PROFILE.with(|profile| profile.borrow_mut().take());
    if let Some(setup) = setup {
        println!(
            "REVIEW_SETUP_METRIC {}",
            serde_json::json!({
                "ordinal": setup.ordinal, "phase": setup.phase,
                "elapsedMs": elapsed.as_secs_f64() * 1000.0,
                "statements": statements.len(),
                "returnedInputFrames": setup.returned_input_frames,
                "returnedInputBytes": setup.returned_input_bytes,
                "sourceMappingRowsReturned": setup.source_mapping_rows,
            })
        );
    } else {
        println!(
            "REVIEW_SCOPE_METRIC {}",
            serde_json::json!({
                "name": name, "elapsedMs": elapsed.as_secs_f64() * 1000.0,
            "statements": statements.len(), "originalFrameRows": FRAME_ROWS.with(|rows| *rows.borrow()),
            })
        );
    }
    (value, statements)
}

fn setup_measured<T>(ordinal: usize, phase: &'static str, run: impl FnOnce() -> T) -> T {
    SETUP_PROFILE.with(|profile| {
        assert!(
            profile
                .borrow_mut()
                .replace(SetupProfile {
                    ordinal,
                    phase,
                    ..Default::default()
                })
                .is_none()
        );
    });
    measured(phase, run).0
}

fn query_plans(store: &ProjectStore, statements: &[String]) -> Vec<serde_json::Value> {
    let handle = MEASURED_CONNECTION.with(|connection| connection.replace(std::ptr::null_mut()));
    assert!(!handle.is_null());
    // The preceding measured call ran on this live, exclusively owned Store.
    // Its borrow keeps the owner alive for all read-only EXPLAIN statements.
    // from_handle does not own or close the connection; retain its real UDFs.
    let db = unsafe { Connection::from_handle(handle) }.unwrap();
    let path: String = db
        .query_row("PRAGMA database_list", [], |row| row.get(2))
        .unwrap();
    assert_eq!(
        std::path::Path::new(&path).canonicalize().unwrap(),
        store
            .directory()
            .join("project.sqlite3")
            .canonicalize()
            .unwrap()
    );
    let mut plans = Vec::new();
    for sql in statements {
        if !sql.starts_with("SELECT") && !sql.starts_with("WITH") {
            continue;
        }
        let mut plan = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let parameters = vec![rusqlite::types::Value::Null; plan.parameter_count()];
        let details = plan
            .query_map(rusqlite::params_from_iter(parameters), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        plans.push(serde_json::json!({"sql":sql,"plan":details}));
    }
    plans
}

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}

fn save(store: &mut ProjectStore, unit: ExecutionId, locale: &str, text: &str) {
    let target = store.review_target(project(store), unit, locale).unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project(store),
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: locale.into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id,
            text: text.into(),
        })
        .unwrap();
}

fn approve(store: &mut ProjectStore, unit: ExecutionId, locale: &str) {
    let target = store.review_target(project(store), unit, locale).unwrap();
    store
        .write_review(&ReviewWrite {
            project_id: project(store),
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: locale.into(),
            expected_basis: target.basis,
            expected_decision_id: target.current_decision.map(|decision| decision.decision_id),
            actor: "Synthetic reviewer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: "Accepted synthetic text".into(),
        })
        .unwrap();
}

fn prepare_runtime(
    store: &ProjectStore,
    unit: ExecutionId,
    locale: &str,
) -> tsumugi_core::execution::ExecutionRuntime {
    let target = store.review_target(project(store), unit, locale).unwrap();
    let prepared = store
        .prepare_review_check(
            project(store),
            unit,
            locale,
            &target.basis,
            ExecutionId::new(),
            &[],
        )
        .unwrap();
    support::review_runtime(store, &prepared)
}

#[test]
#[ignore = "bounded setup diagnostic; run explicitly under an owned process timeout"]
fn bounded_2000_source_eight_qa_setup_profiles_real_stages() {
    let _trace = TraceRegistration::new();
    // These instrumented wall times include validation and callback overhead.
    // Row counters cover recognized SQL results, not every internal decode.
    let (directory, mut store, rows) = setup_measured(0, "source-fixture", || {
        support::source_fixture_with_scope(2000, &["zh-CN"])
    });
    assert_eq!(rows.len(), 2000);
    let mut runtime = setup_measured(0, "runtime", || {
        prepare_runtime(&store, rows[0].unit_id.unwrap(), "zh-CN")
    });
    for (index, row) in rows.iter().take(8).enumerate() {
        let ordinal = index + 1;
        let unit = row.unit_id.unwrap();
        setup_measured(ordinal, "target-save", || {
            save(&mut store, unit, "zh-CN", &format!("译文 {index} 🧵"));
        });
        setup_measured(ordinal, "approve", || approve(&mut store, unit, "zh-CN"));
        let (prepared, input) = setup_measured(ordinal, "prepare", || {
            let project = project(&store);
            let target = store.review_target(project, unit, "zh-CN").unwrap();
            let prepared = store
                .prepare_review_check(
                    project,
                    unit,
                    "zh-CN",
                    &target.basis,
                    ExecutionId::new(),
                    &[],
                )
                .unwrap();
            let plan = prepared.plan().unwrap();
            assert_eq!(plan.domain_input().source.units.len(), 2000);
            assert_eq!(plan.domain_input().source.order.len(), 2000);
            let inputs = prepared.execution_inputs();
            assert_eq!(inputs.len(), 1, "format-only fixture has one checker input");
            let input = inputs[0].clone();
            (prepared, input)
        });
        let (grant, result) = setup_measured(ordinal, "execute", || {
            support::execute(&mut runtime, &mut store, &input)
        });
        let captured = setup_measured(ordinal, "capture", || {
            let checker = prepared.plan().unwrap().checkers()[0].key.clone();
            store
                .capture_review_check_execution(
                    prepared,
                    &[tsumugi_core::ReviewCheckOrigin {
                        checker,
                        attempt_id: input.envelope().attempt_id,
                        result_id: result.envelope().result_id,
                    }],
                )
                .unwrap()
        });
        let computed = setup_measured(ordinal, "compute", || {
            let computed = captured.compute(&Cancellation::default()).unwrap();
            assert!(computed.coverage().complete);
            computed
        });
        let run = setup_measured(ordinal, "commit", || {
            store
                .commit_review_evidence(computed, &Cancellation::default())
                .unwrap()
        });
        assert!(run.evidence.is_some());
        assert!(run.rules.iter().all(|rule| rule.status == "passed"));
        setup_measured(ordinal, "revoke", || {
            runtime.revoke_plugin(&mut store, grant).unwrap();
        });
    }
    let db = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    let checks: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM review_checks WHERE evidence_json IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checks, 8);
    println!(
        "REVIEW_SETUP_COMPLETE {}",
        serde_json::json!({"sourceUnits": 2000, "actualChecks": checks})
    );
}

#[test]
fn normal_reopen_streams_control_associations_without_a_second_frame_scan() {
    let _trace = TraceRegistration::new();
    let (directory, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN"]);
    let mut runtime = prepare_runtime(&store, rows[0].unit_id.unwrap(), "zh-CN");
    for row in &rows {
        let unit = row.unit_id.unwrap();
        save(&mut store, unit, "zh-CN", "译文 🧵");
        approve(&mut store, unit, "zh-CN");
        let run = support::review_check(&mut store, &mut runtime, unit, "zh-CN");
        assert!(run.evidence.is_some());
        assert!(run.rules.iter().all(|rule| rule.status == "passed"));
    }
    drop(runtime);
    store.close().unwrap();
    REOPEN_PROFILE.with(|profile| {
        assert!(
            profile
                .borrow_mut()
                .replace(ReopenProfile::default())
                .is_none()
        );
    });
    let (reopened, statements) = measured("reopen-control-streaming", || {
        ProjectStore::open(&directory.path().join("project")).unwrap()
    });
    let profile = REOPEN_PROFILE.with(|profile| profile.borrow_mut().take().unwrap());
    assert_eq!(profile.next, REOPEN_WINDOWS.len());
    assert!(profile.active.is_none());
    let ledger = profile
        .completed
        .iter()
        .find(|window| window["name"] == "ledger-attempts")
        .unwrap();
    assert!(ledger["reconstructedFrames"].as_u64().unwrap() >= 2);
    let control = profile
        .completed
        .iter()
        .find(|window| window["name"] == "application-control")
        .unwrap();
    assert_eq!(control["reconstructedFrames"], 0);
    assert_eq!(control["reconstructedBytes"], 0);
    let full_control_scan = |sql: &&String| {
        sql.contains("tsumugi_input_chunks(")
            && sql.contains(
                "FROM execution_attempts a LEFT JOIN application_executions x USING(attempt_id)",
            )
    };
    assert_eq!(statements.iter().filter(full_control_scan).count(), 0);
    println!(
        "REVIEW_SCOPE_REOPEN_WINDOWS {}",
        serde_json::json!(profile.completed)
    );
    // Ordinary reconciliation still performs its complete scan. It must not
    // inherit a witness from an earlier open or a different mutable epoch.
    REOPEN_PROFILE.with(|profile| {
        assert!(
            profile
                .borrow_mut()
                .replace(ReopenProfile {
                    next: REOPEN_WINDOWS.len() - 1,
                    ..ReopenProfile::default()
                })
                .is_none()
        );
    });
    let (_, statements) = measured("reconcile-control-complete", || {
        reopened.reconcile_execution().unwrap()
    });
    assert_eq!(statements.iter().filter(full_control_scan).count(), 1);
    let profile = REOPEN_PROFILE.with(|profile| profile.borrow_mut().take().unwrap());
    assert_eq!(profile.next, REOPEN_WINDOWS.len());
    assert!(profile.active.is_none());
    assert_eq!(profile.completed.len(), 1);
    assert_eq!(profile.completed[0]["name"], "application-control");
    assert!(
        profile.completed[0]["reconstructedFrames"]
            .as_u64()
            .unwrap()
            >= 2
    );
    assert!(profile.completed[0]["reconstructedBytes"].as_u64().unwrap() > 0);
    println!(
        "REVIEW_SCOPE_RECONCILE_CONTROL_WINDOW {}",
        serde_json::json!(profile.completed[0])
    );
}

#[test]
fn full_2000_actual_qa_scope_has_bounded_reads_and_complete_qualification() {
    let _trace = TraceRegistration::new();
    let started = Instant::now();
    let (_directory, mut store, rows) = support::source_fixture_with_scope(2000, &["zh-CN"]);
    let mut runtime = prepare_runtime(&store, rows[0].unit_id.unwrap(), "zh-CN");
    for (index, row) in rows.iter().enumerate() {
        let unit = row.unit_id.unwrap();
        save(&mut store, unit, "zh-CN", &format!("译文 {index} 🧵"));
        approve(&mut store, unit, "zh-CN");
        let run = support::review_check(&mut store, &mut runtime, unit, "zh-CN");
        assert!(run.evidence.is_some());
        assert!(run.rules.iter().all(|rule| rule.status == "passed"));
        if (index + 1) % 100 == 0 {
            println!(
                "REVIEW_SCOPE_PROGRESS {} elapsed_s={:.3}",
                index + 1,
                started.elapsed().as_secs_f64()
            );
        }
    }
    assert_full_2000_qa_scope(store, &rows, Some(runtime));
}

#[test]
#[ignore = "requires an explicitly prepared copy of a complete synthetic QA project"]
fn existing_2000_actual_qa_scope_has_bounded_reads_and_complete_qualification() {
    let _trace = TraceRegistration::new();
    // Point this at a disposable copy, never the preserved fixture. Opening
    // uses the normal project lock and validates all stored original evidence.
    let directory = std::env::var_os("TSUMUGI_TEST_REVIEW_SCOPE_PROJECT")
        .expect("set TSUMUGI_TEST_REVIEW_SCOPE_PROJECT to a prepared synthetic project copy");
    let (store, _) = measured("open-existing-2000", || {
        ProjectStore::open(std::path::PathBuf::from(directory)).unwrap()
    });
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let mut rows = Vec::with_capacity(2000);
    let mut after = 0;
    loop {
        let page = store.source_content(snapshot, after, 100).unwrap();
        assert_eq!(page.total, 2000);
        rows.extend(page.rows);
        match page.next_ordinal {
            Some(next) => {
                assert!(next > after);
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(rows.len(), 2000);
    let identities: std::collections::BTreeSet<_> =
        rows.iter().map(|row| row.unit_id.unwrap()).collect();
    assert_eq!(identities.len(), 2000);
    assert_full_2000_qa_scope(store, &rows, None);
}

fn assert_full_2000_qa_scope(
    store: ProjectStore,
    rows: &[tsumugi_core::content::ContentRow],
    runtime: Option<tsumugi_core::execution::ExecutionRuntime>,
) {
    let directory = store.directory().to_path_buf();
    let db = Connection::open(directory.join("project.sqlite3")).unwrap();
    let checks: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM review_checks WHERE evidence_json IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checks, 2000);
    let (input_bytes, largest, references): (i64, i64, i64) = db.query_row(
        "SELECT SUM(json_extract(CAST(a.input AS TEXT),'$.rawBytes')),MAX(json_extract(CAST(a.input AS TEXT),'$.rawBytes')),SUM(length(a.input)) FROM execution_attempts a JOIN execution_tasks t USING(task_id) WHERE t.operation=?1",
        [tsumugi_core::execution::REVIEW_CHECK_OPERATION], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    let chunks: i64 = db
        .query_row(
            "SELECT SUM(length(bytes)) FROM execution_input_chunks WHERE digest IN
         (SELECT part.value FROM execution_attempts a JOIN execution_tasks t USING(task_id)
          JOIN json_each(CAST(a.input AS TEXT),'$.chunks') part WHERE t.operation=?1)",
            [tsumugi_core::execution::REVIEW_CHECK_OPERATION],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        references + chunks < input_bytes / 4,
        "shared storage must reduce actual QA bytes without reducing the complete logical inputs"
    );
    println!(
        "REVIEW_SCOPE_MATERIAL {}",
        serde_json::json!({"units":2000,"actualChecks":checks,"logicalQaInputBytes":input_bytes,"largestQaInputBytes":largest,"qaReferenceBytes":references,"distinctQaChunkBytes":chunks,"sharedQaStorageBytes":references+chunks})
    );
    let project = project(&store);
    let (first, first_sql) = measured("summary-first-50", || {
        store
            .review_summary_page(project, "zh-CN", 0, 50, "", None)
            .unwrap()
    });
    let (repeat, repeat_sql) = measured("summary-repeat-50", || {
        store
            .review_summary_page(project, "zh-CN", 0, 50, "", Some(first.scope_id))
            .unwrap()
    });
    assert_eq!(first, repeat);
    let (hundred, hundred_sql) = measured("summary-repeat-100", || {
        store
            .review_summary_page(project, "zh-CN", 0, 100, "", Some(first.scope_id))
            .unwrap()
    });
    assert_eq!(
        repeat_sql.len(),
        hundred_sql.len(),
        "statement count must not grow with page size"
    );
    assert_eq!(first.total, 2000);
    assert_eq!(first.rows.len(), 50);
    assert_eq!(first.next_ordinal, Some(50));
    assert_eq!(hundred.rows.len(), 100);
    assert_eq!(first.rows, hundred.rows[..50]);
    assert!(
        hundred
            .rows
            .iter()
            .all(|row| row.current_check.is_some() && row.current_decision.is_some())
    );
    let next = store
        .review_summary_page(
            project,
            "zh-CN",
            first.next_ordinal.unwrap(),
            50,
            "",
            Some(first.scope_id),
        )
        .unwrap();
    assert_eq!(next.rows, hundred.rows[50..]);
    let tail = store
        .review_summary_page(project, "zh-CN", 1900, 100, "", Some(first.scope_id))
        .unwrap();
    assert_eq!(tail.rows.len(), 100);
    assert_eq!(tail.next_ordinal, None);
    assert_eq!(
        tail.rows.last().unwrap().unit_id,
        rows[1999].unit_id.unwrap()
    );
    let (eligible, eligibility_sql) = measured("eligibility-first-2000", || {
        store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap()
    });
    let (eligible_repeat, _) = measured("eligibility-repeat-2000", || {
        store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap()
    });
    assert_eq!(eligible, eligible_repeat);
    assert!(eligible.ready);
    assert_eq!(eligible.locales[0].checked_units, 2000);
    assert_eq!(eligible.locales[0].blocker_count, 0);
    let (work, work_sql) = measured("work-first-2000", || {
        store.review_work_page(project, "zh-CN", 0, 100).unwrap()
    });
    assert_eq!(work.total, 0);
    assert!(work.items.is_empty());
    for statements in [&repeat_sql, &hundred_sql, &eligibility_sql, &work_sql] {
        assert_eq!(
            statements
                .iter()
                .filter(|sql| sql.contains("JOIN execution_results"))
                .count(),
            1,
            "one batch validates the original QA frames"
        );
        assert!(statements.first().unwrap().starts_with("BEGIN"));
        assert_eq!(statements.last().unwrap(), "COMMIT");
    }
    println!(
        "REVIEW_SCOPE_QUERIES {}",
        serde_json::json!({"first":first_sql,"eligibility":eligibility_sql})
    );
    println!(
        "REVIEW_SCOPE_PAYLOAD {}",
        serde_json::json!({"summary50Bytes":serde_json::to_vec(&first).unwrap().len(),"summary100Bytes":serde_json::to_vec(&hundred).unwrap().len()})
    );
    drop(db);
    drop(runtime);
    store.close().unwrap();
    REOPEN_PROFILE.with(|profile| {
        assert!(
            profile
                .borrow_mut()
                .replace(ReopenProfile::default())
                .is_none()
        );
    });
    let (reopened, _) = measured("reopen-2000", || {
        ProjectStore::open(&directory).unwrap()
    });
    let profile = REOPEN_PROFILE.with(|profile| profile.borrow_mut().take().unwrap());
    assert_eq!(
        profile.next,
        REOPEN_WINDOWS.len(),
        "all reopen windows must be observed"
    );
    assert!(profile.active.is_none());
    println!(
        "REVIEW_SCOPE_REOPEN_WINDOWS {}",
        serde_json::json!(profile.completed)
    );
    for window in &profile.completed {
        if window["name"] == "ledger-attempts" {
            assert!(window["reconstructedFrames"].as_u64().unwrap() >= 2000);
            assert!(window["reconstructedBytes"].as_u64().unwrap() >= input_bytes as u64);
        } else {
            assert_eq!(window["reconstructedFrames"], 0);
            assert_eq!(window["reconstructedBytes"], 0);
        }
    }
    assert!(
        reopened
            .review_target(project, rows[1999].unit_id.unwrap(), "zh-CN")
            .unwrap()
            .current_check
            .is_some()
    );
}

#[test]
fn actual_qa_is_locale_scoped_and_keeps_original_history_after_edit_and_reopen() {
    let _trace = TraceRegistration::new();
    let (directory, mut store, rows) =
        support::source_fixture_with_scope(4, &["zh-CN", "de", "fr"]);
    let mut runtime = prepare_runtime(&store, rows[0].unit_id.unwrap(), "zh-CN");
    let mut original = Vec::new();
    for locale in ["zh-CN", "de", "fr"] {
        for row in &rows {
            let unit = row.unit_id.unwrap();
            save(&mut store, unit, locale, &format!("{locale} 🧵"));
            approve(&mut store, unit, locale);
            original.push(support::review_check(
                &mut store,
                &mut runtime,
                unit,
                locale,
            ));
        }
    }
    let project = project(&store);
    let locales = ["fr".into(), "zh-CN".into(), "de".into()];
    let (ready, statements) = measured("eligibility-three-locales", || {
        store.review_eligibility(project, &locales).unwrap()
    });
    assert_eq!(FRAME_ROWS.with(|rows| *rows.borrow()), 12);
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.starts_with("BEGIN"))
            .count(),
        1
    );
    assert_eq!(statements.first().unwrap(), "BEGIN DEFERRED");
    assert_eq!(statements.last().unwrap(), "COMMIT");
    let plans = query_plans(&store, &statements);
    println!(
        "REVIEW_SCOPE_QUERY_PLANS {}",
        serde_json::to_value(plans).unwrap()
    );
    assert!(ready.ready);
    assert!(ready.locales.iter().all(|locale| locale.checked_units == 4));
    assert_eq!(
        ready
            .locales
            .iter()
            .map(|locale| locale.locale.as_str())
            .collect::<Vec<_>>(),
        ["de", "fr", "zh-CN"]
    );
    save(&mut store, rows[0].unit_id.unwrap(), "fr", "Edited French");
    let changed = store.review_eligibility(project, &locales).unwrap();
    assert!(!changed.ready);
    assert_ne!(ready.basis, changed.basis);
    assert!(
        changed
            .locales
            .iter()
            .all(|locale| locale.ready == (locale.locale != "fr"))
    );
    let work = store.review_work_page(project, "fr", 0, 100).unwrap();
    assert_eq!(work.total, 1);
    assert_eq!(work.items[0].unit_id, rows[0].unit_id.unwrap());
    assert_eq!(
        store
            .review_eligibility_if_basis(project, &locales, &ready.basis)
            .unwrap_err()
            .stage,
        "review-eligibility-stale"
    );
    drop(runtime);
    store.close().unwrap();
    let store = ProjectStore::open(&directory.path().join("project")).unwrap();
    assert_eq!(
        store.review_eligibility(project, &locales).unwrap(),
        changed
    );
    for run in original {
        let target = store
            .review_target(project, run.unit_id, &run.locale)
            .unwrap();
        let stale = run.locale == "fr" && run.unit_id == rows[0].unit_id.unwrap();
        assert_eq!(target.current_check, (!stale).then_some(run.clone()));
        assert_eq!(target.current_decision.is_none(), stale);
        assert_eq!(
            store
                .review_history(project, run.unit_id, &run.locale, 0, 50)
                .unwrap()
                .checks,
            [run]
        );
    }
}

#[test]
fn cancellable_review_reads_discard_partial_qualification_and_keep_complete_integrity() {
    let _trace = TraceRegistration::new();
    let (directory, mut store, rows) = support::source_fixture_with_scope(4, &["zh-CN"]);
    let mut runtime = prepare_runtime(&store, rows[0].unit_id.unwrap(), "zh-CN");
    for row in &rows {
        save(&mut store, row.unit_id.unwrap(), "zh-CN", "译文");
        support::review_check(&mut store, &mut runtime, row.unit_id.unwrap(), "zh-CN");
    }
    let project = project(&store);
    let locales = ["zh-CN".to_owned()];
    let expected = store.review_eligibility(project, &locales).unwrap();
    let expected_work = store.review_work_page(project, "zh-CN", 0, 100).unwrap();
    let before = std::fs::read(directory.path().join("project/project.sqlite3")).unwrap();
    for work in [false, true] {
        let cancellation = Cancellation::default();
        let signal = cancellation.clone();
        let (entered, started) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        FRAME_GATE.with(|gate| assert!(gate.borrow_mut().replace((entered, released)).is_none()));
        let canceller = std::thread::spawn(move || {
            // SQLITE_TRACE_ROW for row two runs only after row one's complete
            // restore and saved-frame visitor returned. Do not gate setup/open.
            started
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            signal.request();
            release.send(()).unwrap();
        });
        let (error, _) = measured("cancelled-original-frame", || {
            if work {
                store
                    .review_work_page_with_cancel(project, "zh-CN", 0, 100, &cancellation)
                    .unwrap_err()
            } else {
                store
                    .review_eligibility_with_cancel(project, &locales, &cancellation)
                    .unwrap_err()
            }
        });
        canceller.join().unwrap();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.stage, "review-read-cancelled");
        assert_eq!(
            FRAME_ROWS.with(|rows| *rows.borrow()),
            2,
            "discard the projection before the remaining two real frames"
        );
        // The existing trace captures this exclusively owned live Store's handle.
        let handle = MEASURED_CONNECTION.with(|connection| connection.get());
        assert!(!handle.is_null());
        let connection = unsafe { Connection::from_handle(handle) }.unwrap();
        assert!(
            connection.is_autocommit(),
            "cancelled snapshot must be released"
        );
        drop(connection);
        assert_eq!(
            std::fs::read(directory.path().join("project/project.sqlite3")).unwrap(),
            before
        );
    }
    assert_eq!(
        store
            .review_eligibility_with_cancel(project, &locales, &Cancellation::default())
            .unwrap(),
        expected
    );
    assert_eq!(
        store
            .review_work_page_with_cancel(project, "zh-CN", 0, 100, &Cancellation::default())
            .unwrap(),
        expected_work
    );
    assert_eq!(
        store.review_eligibility(project, &locales).unwrap(),
        expected
    );
    assert_eq!(
        store.review_work_page(project, "zh-CN", 0, 100).unwrap(),
        expected_work
    );
    let db = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    let last: String = db
        .query_row(
            "SELECT json_extract(origin.value,'$.attemptId') FROM review_checks
         CROSS JOIN json_each(review_checks.evidence_json,'$.origins') AS origin
         ORDER BY json_extract(origin.value,'$.attemptId') DESC,
                  json_extract(origin.value,'$.resultId') DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        db.execute(
            "UPDATE execution_attempts SET digest=?1 WHERE attempt_id=?2",
            [&"0".repeat(64), &last]
        )
        .unwrap(),
        1
    );
    drop(db);
    for work in [false, true] {
        let error = if work {
            store
                .review_work_page_with_cancel(project, "zh-CN", 0, 100, &Cancellation::default())
                .unwrap_err()
        } else {
            store
                .review_eligibility_with_cancel(project, &locales, &Cancellation::default())
                .unwrap_err()
        };
        assert_eq!(error.code, ErrorCode::CorruptLedger);
        assert_eq!(error.stage, "input-digest");
    }
}

#[test]
fn a_corrupt_late_qa_frame_refuses_the_whole_batch_without_writes() {
    let _trace = TraceRegistration::new();
    let (directory, mut store, rows) = support::source_fixture_with_scope(4, &["zh-CN"]);
    let mut runtime = prepare_runtime(&store, rows[0].unit_id.unwrap(), "zh-CN");
    for row in &rows {
        save(&mut store, row.unit_id.unwrap(), "zh-CN", "译文");
        support::review_check(&mut store, &mut runtime, row.unit_id.unwrap(), "zh-CN");
    }
    let db = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    // The batch reader visits origins in (attemptId, resultId) order; tamper
    // with its final real frame so all preceding frames are visited first.
    let last: String = db
        .query_row(
            "SELECT json_extract(origin.value,'$.attemptId') FROM review_checks
             CROSS JOIN json_each(review_checks.evidence_json,'$.origins') AS origin
             ORDER BY json_extract(origin.value,'$.attemptId') DESC,
                      json_extract(origin.value,'$.resultId') DESC
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let updated = db
        .execute(
            "UPDATE execution_attempts SET digest=?1 WHERE attempt_id=?2",
            [&"0".repeat(64), &last],
        )
        .unwrap();
    assert_eq!(updated, 1, "corrupt exactly one existing QA frame");
    drop(db);
    let before = std::fs::read(directory.path().join("project/project.sqlite3")).unwrap();
    let project = project(&store);
    let (error, _) = measured("corrupt-original-frame", || {
        store.review_page(project, "zh-CN", 0, 100).unwrap_err()
    });
    assert_eq!(
        FRAME_ROWS.with(|rows| *rows.borrow()),
        4,
        "corruption must occur after the earlier frames were visited"
    );
    assert_eq!(error.code, ErrorCode::CorruptLedger);
    assert_eq!(error.stage, "input-digest");
    assert_eq!(
        store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap_err()
            .stage,
        "input-digest"
    );
    assert_eq!(
        store
            .review_work_page(project, "zh-CN", 0, 100)
            .unwrap_err()
            .stage,
        "input-digest"
    );
    assert_eq!(
        std::fs::read(directory.path().join("project/project.sqlite3")).unwrap(),
        before
    );
}
