#![cfg(not(feature = "execution-test-host"))]
//! Normal Core, real grants/runtime/SQLite and a synthetic SDK checker.
//! This does not attest installed workers or a domain parser.
mod support;

use rusqlite::{Connection, ffi};
use std::{
    cell::RefCell,
    ffi::{CStr, c_char, c_int, c_uint, c_void},
    time::Instant,
};
use tsumugi_core::{
    ProjectStore, ReviewDecisionKind, ReviewWrite, SaveTranslationRevision,
    execution::{ErrorCode, ExecutionId},
};

thread_local! {
    static STATEMENTS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
    static FRAME_ROWS: RefCell<usize> = const { RefCell::new(0) };
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
                        let sql = unsafe { CStr::from_ptr(sql) }.to_string_lossy();
                        if event == ffi::SQLITE_TRACE_STMT as c_uint {
                            captured.push(sql.into_owned());
                        } else if event == ffi::SQLITE_TRACE_ROW as c_uint
                            && sql.contains("FROM wanted w JOIN execution_attempts")
                        {
                            let _ = FRAME_ROWS.try_with(|rows| {
                                if let Ok(mut rows) = rows.try_borrow_mut() {
                                    *rows += 1;
                                }
                            });
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
    FRAME_ROWS.with(|rows| *rows.borrow_mut() = 0);
    STATEMENTS.with(|statements| assert!(statements.borrow_mut().replace(Vec::new()).is_none()));
    let started = Instant::now();
    let value = read();
    let elapsed = started.elapsed();
    let statements = STATEMENTS.with(|statements| statements.borrow_mut().take().unwrap());
    println!(
        "REVIEW_SCOPE_METRIC {}",
        serde_json::json!({
            "name": name, "elapsedMs": elapsed.as_secs_f64() * 1000.0,
        "statements": statements.len(), "originalFrameRows": FRAME_ROWS.with(|rows| *rows.borrow()),
        })
    );
    (value, statements)
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
        )
        .unwrap();
    support::review_runtime(store, &prepared)
}

#[test]
fn full_2000_actual_qa_scope_has_bounded_reads_and_complete_qualification() {
    let _trace = TraceRegistration::new();
    let started = Instant::now();
    let (directory, mut store, rows) = support::source_fixture_with_scope(2000, &["zh-CN"]);
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
    let db = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    let checks: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM review_checks WHERE evidence_json IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(checks, 2000);
    let (input_bytes, largest): (i64, i64) = db.query_row(
        "SELECT SUM(length(a.input)),MAX(length(a.input)) FROM execution_attempts a JOIN execution_tasks t USING(task_id) WHERE t.operation=?1",
        [tsumugi_core::execution::REVIEW_CHECK_OPERATION], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    println!(
        "REVIEW_SCOPE_MATERIAL {}",
        serde_json::json!({"units":2000,"actualChecks":checks,"storedQaInputBytes":input_bytes,"largestQaInputBytes":largest})
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
    let (reopened, _) = measured("reopen-2000", || {
        ProjectStore::open(&directory.path().join("project")).unwrap()
    });
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
    let db = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    let mut plans = Vec::new();
    for sql in &statements {
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
    println!(
        "REVIEW_SCOPE_QUERY_PLANS {}",
        serde_json::to_value(plans).unwrap()
    );
    drop(db);
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
fn a_corrupt_late_qa_frame_refuses_the_whole_batch_without_writes() {
    let _trace = TraceRegistration::new();
    let (directory, mut store, rows) = support::source_fixture_with_scope(4, &["zh-CN"]);
    let mut runtime = prepare_runtime(&store, rows[0].unit_id.unwrap(), "zh-CN");
    for row in &rows {
        save(&mut store, row.unit_id.unwrap(), "zh-CN", "译文");
        support::review_check(&mut store, &mut runtime, row.unit_id.unwrap(), "zh-CN");
    }
    let db = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    let last: String = db
        .query_row(
            "SELECT MAX(json_extract(evidence_json,'$.attemptId')) FROM review_checks",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE execution_attempts SET digest=?1 WHERE attempt_id=?2",
        [&"0".repeat(64), &last],
    )
    .unwrap();
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
