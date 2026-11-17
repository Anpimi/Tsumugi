use super::*;
use std::{sync::{Arc, atomic::Ordering}, time::{Duration, Instant}};

#[test]
fn comparison_counts_shared_identity_candidates_without_materializing_every_edge() {
    let fixture = super::decision_mappings::tests::plugin_fixture();
    let snapshot = fixture.store.content_scope().unwrap().current_snapshot.unwrap();
    let template = fixture.store.source_content(snapshot, 0, 1).unwrap().rows.remove(0);
    let old: Vec<_> = (0..2048).map(|ordinal| {
        let mut row = template.clone();
        row.occurrence_id = Some(ExecutionId::new());
        row.occurrence.ordinal = ordinal;
        row.occurrence.operation_occurrence_id = format!("shared-{ordinal}");
        row
    }).collect();
    let new: Vec<_> = old.iter().map(|row| row.occurrence.clone()).collect();
    let mut visited = 0;
    let counts = visit_comparison(&old, &new, |_, prior, next, candidates| {
        assert_eq!(candidates.len(), old.len());
        assert_eq!(prior.unwrap().occurrence.ordinal, 0);
        assert_eq!(next.unwrap().ordinal, visited);
        visited += 1;
    });
    assert_eq!(visited, 2048);
    assert_eq!(counts.unchanged, 1);
    assert_eq!(counts.moved, 2047);
    assert_eq!(counts.mapping_review_required(), 0);
}

#[test]
fn source_pages_recheck_off_page_mappings_after_local_and_external_writes() {
    for external in [false, true] {
        let fixture = super::decision_mappings::tests::plugin_fixture();
        let snapshot = fixture.store.content_scope().unwrap().current_snapshot.unwrap();
        let first = fixture.store.source_content(snapshot, 0, 1).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.next_ordinal, Some(1));
        assert_eq!(fixture.store.source_content(snapshot, 1, 1).unwrap().rows[0].occurrence.ordinal, 1);
        let writer = external.then(|| Connection::open(fixture.store.directory().join("project.sqlite3")).unwrap());
        let connection = writer.as_ref().unwrap_or_else(|| fixture.store.connection().unwrap());
        connection.execute("UPDATE source_occurrences SET native_key='Altered outside the requested page' WHERE snapshot_id=?1 AND ordinal=2",
            [snapshot.to_string()]).unwrap();
        assert_eq!(fixture.store.source_content(snapshot, 0, 1).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(fixture.store.source_history_content(snapshot, "Original A", 0, 1).unwrap_err().code, ErrorCode::CorruptLedger);
    }
}

#[test]
fn source_preview_rechecks_checker_frames_after_local_and_external_writes() {
    for external in [false, true] {
        let fixture = super::decision_mappings::tests::plugin_fixture();
        let attempt = fixture.input.envelope().attempt_id;
        let first = fixture.store.source_preview(attempt, fixture.result, 0, 1).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(fixture.store.source_preview(attempt, fixture.result, 1, 1).unwrap().rows[0].occurrence.ordinal, 1);
        let writer = external.then(|| Connection::open(fixture.store.directory().join("project.sqlite3")).unwrap());
        let connection = writer.as_ref().unwrap_or_else(|| fixture.store.connection().unwrap());
        connection.execute("UPDATE execution_results SET digest=?2 WHERE result_id=(SELECT checker_result_id FROM plugin_validation_links WHERE producer_result_id=?1)",
            params![fixture.result.to_string(), "0".repeat(64)]).unwrap();
        assert_eq!(fixture.store.source_preview(attempt, fixture.result, 0, 1).unwrap_err().code, ErrorCode::CorruptLedger);
    }
}

#[test]
fn cached_structural_preview_does_not_qualify_a_source_without_its_checker() {
    let fixture = super::decision_mappings::tests::plugin_fixture();
    let attempt = fixture.input.envelope().attempt_id;
    let connection = fixture.store.connection().unwrap();
    connection.execute("DELETE FROM plugin_validation_links WHERE producer_result_id=?1", [fixture.result.to_string()]).unwrap();
    connection.execute("UPDATE execution_items SET validation='pending' WHERE attempt_id=?1", [attempt.to_string()]).unwrap();
    let first = fixture.store.source_preview(attempt, fixture.result, 0, 1).unwrap();
    let second = fixture.store.source_preview(attempt, fixture.result, 1, 1).unwrap();
    assert_eq!((first.total, second.total), (3, 3));
    assert_eq!(second.rows[0].occurrence.ordinal, 1);
    assert!(super::super::review::read_snapshot(connection, |connection| {
        load_qualified_source(connection, attempt, fixture.result)
    }).is_err(), "a shared structural projection cannot replace a mandatory semantic proof");
    assert_eq!(fixture.store.source_preview(attempt, fixture.result, 0, 1).unwrap(), first);
    connection.execute("UPDATE source_files SET digest=?1", ["0".repeat(64)]).unwrap();
    assert!(fixture.store.source_preview(attempt, fixture.result, 0, 1).is_err());
}

#[test]
fn source_page_qualification_from_a_write_transaction_does_not_survive_rollback() {
    let fixture = super::decision_mappings::tests::plugin_fixture();
    let snapshot = fixture.store.content_scope().unwrap().current_snapshot.unwrap();
    let original = fixture.store.source_content(snapshot, 2, 1).unwrap().rows[0].occurrence.key.clone();
    let connection = fixture.store.connection().unwrap();
    connection.execute("UPDATE source_occurrences SET native_key='Committed damage' WHERE snapshot_id=?1 AND ordinal=2",
        [snapshot.to_string()]).unwrap();
    connection.execute_batch("BEGIN").unwrap();
    connection.execute("UPDATE source_occurrences SET native_key=?2 WHERE snapshot_id=?1 AND ordinal=2",
        params![snapshot.to_string(), original]).unwrap();
    assert_eq!(fixture.store.source_content(snapshot, 0, 1).unwrap().total, 3);
    let changes = connection.total_changes();
    connection.execute_batch("ROLLBACK").unwrap();
    assert_eq!(connection.total_changes(), changes, "SQLite's write counter does not reverse on rollback");
    assert_eq!(fixture.store.source_content(snapshot, 0, 1).unwrap_err().code, ErrorCode::CorruptLedger);
}

#[test]
fn source_page_qualification_is_bound_to_the_open_connection_instance() {
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    thread_local! {
        static SOURCE_QUALIFICATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }
    fn assert_cached_history(store: &ProjectStore, expected: &SourceHistory, expected_page: &ContentPage) {
        let connection = store.connection().unwrap();
        connection.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(|event| {
            if let TraceEvent::Stmt(_, sql) = event
                && sql.starts_with("SELECT project_id,set_id,attempt_id,result_id,source_language,identity_policy FROM source_snapshots")
            {
                SOURCE_QUALIFICATIONS.with(|count| count.set(count.get() + 1));
            }
        }));
        assert_eq!(&store.source_history(0, 1).unwrap(), expected);
        assert_eq!(&store.source_history_content(expected.snapshots[0].snapshot_id, "", 0, 1).unwrap(), expected_page);
        assert_eq!(SOURCE_QUALIFICATIONS.with(|count| count.replace(0)), 0,
            "history should reuse the current source qualification from open");
        connection.trace_v2(TraceEventCodes::empty(), None);
    }

    let fixture = super::decision_mappings::tests::plugin_fixture();
    let path = fixture.store.directory().to_path_buf();
    let snapshot = fixture.store.content_scope().unwrap().current_snapshot.unwrap();
    let expected = fixture.store.source_content(snapshot, 0, 1).unwrap();
    let expected_history = fixture.store.source_history(0, 1).unwrap();
    let expected_history_page = fixture.store.source_history_content(snapshot, "", 0, 1).unwrap();
    fixture.store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    let connection = reopened.connection().unwrap();
    assert_eq!(connection.total_changes(), 0);
    super::super::review::read_snapshot(connection, |connection| {
        assert!(reopened.source_pages.for_reopen(connection).is_some(),
            "the open audit seeds pagination before the first page is requested");
        Ok(())
    }).unwrap();
    assert_cached_history(&reopened, &expected_history, &expected_history_page);
    assert_eq!(reopened.source_content(snapshot, 0, 1).unwrap(), expected);
    let proof = reopened.close_with_reopen_proof().unwrap().unwrap();
    let reopened = ProjectStore::open_with_reopen_proof(&path, Some(&proof)).unwrap();
    super::super::review::read_snapshot(reopened.connection().unwrap(), |connection| {
        assert!(reopened.source_pages.for_reopen(connection).is_some(),
            "a verified reopen binds pagination to its new connection");
        Ok(())
    }).unwrap();
    assert_cached_history(&reopened, &expected_history, &expected_history_page);
    assert_eq!(reopened.source_content(snapshot, 0, 1).unwrap(), expected);
    let writer = Connection::open(path.join("project.sqlite3")).unwrap();
    writer.execute("UPDATE source_occurrences SET native_key='Damage outside this page' WHERE snapshot_id=?1 AND ordinal=2",
        [snapshot.to_string()]).unwrap();
    assert_eq!(reopened.source_history(0, 1).unwrap_err().code, ErrorCode::CorruptLedger);
    assert_eq!(reopened.source_history_content(snapshot, "", 0, 1).unwrap_err().code, ErrorCode::CorruptLedger);
    assert_eq!(reopened.source_content(snapshot, 0, 1).unwrap_err().code, ErrorCode::CorruptLedger);
    reopened.close().unwrap();
    drop(writer);
    assert!(ProjectStore::open(&path).is_err());
}

fn finish(store: &mut ProjectStore, input: &FixedInput) -> ExecutionId {
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(store).unwrap();
        if store.execution_attempt(input.envelope().attempt_id, true).unwrap().items[0].execution == ExecutionState::Succeeded {
            return store.execution_current_result(input.envelope().attempt_id, input.envelope().items[0].item_id).unwrap().unwrap();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn opening_rejects_a_valid_source_set_without_an_attempt() {
    let (_directory, store, _, _) = super::super::review::tests::fixture();
    let bundle = SourceBundle::capture(
        br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#,
        br#"{"orphan":"No import attempt"}"#,
        "en",
    )
    .unwrap();
    let input = bundle
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let path = store.directory().to_path_buf();
    let connection = store.connection().unwrap();
    record_input(connection, &input).unwrap();
    assert_eq!(
        read_bundle(connection, bundle.set_id).unwrap(),
        bundle.source_input()
    );
    store.close().unwrap();
    assert_eq!(
        ProjectStore::open(path).unwrap_err(),
        crate::PersistenceError::CorruptProject {
            stage: crate::PersistenceStage::Open,
        }
    );
}

#[test]
fn source_original_observations_are_pure_and_settlement_is_receipt_first() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(directory.path().join("project"),
        crate::ProjectMetadata::create("Source observations", "en", ["zh-CN"]).unwrap()).unwrap();
    let project = id(store.metadata().unwrap().project_id().to_string()).unwrap();
    let request = SourceImportStart { project_id: project, attempt_id: ExecutionId::new(),
        selection_id: ExecutionId::new(), source_language: "en".into() };
    let bundle = SourceBundle::capture(
        br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#,
        br#"{"hello":"Original"}"#, "en").unwrap();
    let input = bundle.fixed_input_for_import_start(store.metadata().unwrap().project_id(), &request).unwrap();
    let result = finish(&mut store, &input);
    let confirmation = store.source_preview(request.attempt_id, result, 0, 1).unwrap().confirmation;
    let unit = input.envelope().units[0].unit_id;
    let absent = ExecutionId::new();
    assert!(store.source_adoption_request_settlement_observation(project, request.attempt_id, absent,
        unit, result, &confirmation).unwrap().is_none(), "missing action is not a rejection");
    let action = store.prepare_adoption_with_id(ExecutionId::new(), request.attempt_id, unit,
        vec![result], serde_json::to_value(&confirmation).unwrap()).unwrap();
    let unused = store.prepare_adoption_with_id(ExecutionId::new(), request.attempt_id, unit,
        vec![result], serde_json::to_value(&confirmation).unwrap()).unwrap();
    let receipt = store.adopt_execution(&action, &SourceAdoptionHandler).unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    let authority = store.planning_authority_revision.load(Ordering::Acquire);
    let writes = store.connection().unwrap().total_changes();
    let start = store.source_import_start_request_observation(&request).unwrap().unwrap();
    assert_eq!(start.request, request);
    let observed = store.source_adoption_request_settlement_observation(project, request.attempt_id,
        action.action_id, unit, result, &confirmation).unwrap().unwrap();
    assert_eq!(observed.receipt, Some(receipt));
    let rejected = store.source_adoption_request_settlement_observation(project, request.attempt_id,
        unused.action_id, unit, result, &confirmation).unwrap_err();
    assert_eq!(rejected.code, ErrorCode::DependencyConflict);
    assert_eq!(rejected.stage, "stale-preview");
    let mut changed = confirmation.clone(); changed.actor = Some("Other original request".into());
    assert_eq!(store.source_adoption_request_observation(project, request.attempt_id, action.action_id,
        unit, result, &changed).unwrap_err().code, ErrorCode::ResultMismatch);
    let mut changed = request.clone(); changed.selection_id = ExecutionId::new();
    assert_eq!(store.source_import_start_request_observation(&changed).unwrap_err().code, ErrorCode::ResultMismatch);
    assert!(store.is_reconciling());
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire), authority);
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    store.source_adoption_action_read(project, request.attempt_id, action.action_id, unit, result, &confirmation).unwrap();
    assert!(!store.is_reconciling(), "the existing explicit recovery reader retains its boundary");
}
