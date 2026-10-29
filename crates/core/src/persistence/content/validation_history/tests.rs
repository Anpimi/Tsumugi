use super::*;
use crate::persistence::content::decision_mappings::tests::{plugin_fixture, save_plugin_result};
use std::sync::atomic::Ordering;
use tsumugi_plugin_sdk as sdk;

fn another_check(store: &mut ProjectStore, generation: ExecutionId, input: &FixedInput, producer: ExecutionId, valid: bool)
    -> PreparedSourceValidation {
    let capture = store.capture_source_validation(input.envelope().attempt_id, producer).unwrap();
    let check_input = capture.check_input().clone();
    let payload: sdk::SourceExtractionCheckInput = serde_json::from_value(check_input.envelope().items[0].payload.clone()).unwrap();
    let checks = payload.requirements.into_iter().map(|required| sdk::CheckResult {
        key: required.key, input_digest: required.input_digest, scope_digest: required.scope_digest,
        covered_targets: required.targets, outcome: sdk::CheckOutcome::Completed { findings: vec![] },
    }).collect::<Vec<_>>();
    let output = if valid { serde_json::to_value(checks).unwrap() } else { serde_json::json!({"invalid": "check report"}) };
    let (_, checked) = save_plugin_result(store, generation, &check_input, output);
    capture.prepare(checked).unwrap()
}

fn current_link(c: &Connection, producer: ExecutionId) -> String {
    c.query_row("SELECT checker_result_id FROM plugin_validation_links WHERE producer_result_id=?1",
        [producer.to_string()], |r| r.get(0)).unwrap()
}

#[test]
fn finish_history_preserves_a_after_b_replaces_current_proof_and_after_reopen() {
    let mut fixture = plugin_fixture();
    let a_attempt = fixture.check_input.envelope().attempt_id;
    let a_result = fixture.store.execution_current_result(a_attempt, fixture.check_input.envelope().items[0].item_id).unwrap().unwrap();
    let source = ResultValidationCapture { input: fixture.input.clone(),
        result: fixture.store.execution_result(fixture.input.envelope().attempt_id, fixture.result).unwrap() };
    let a = SourceValidationCapture::restore(source, fixture.check_input.clone()).unwrap()
        .prepare(fixture.store.execution_result(a_attempt, a_result).unwrap()).unwrap();
    let b = another_check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, false);
    let b_attempt = b.capture.check_input.envelope().attempt_id;
    let b_result = b.check_result.envelope().result_id;
    assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, b_attempt, b_result).unwrap(), None,
        "generating a checker result does not prove publication");
    fixture.store.connection().unwrap().execute_batch(
        "CREATE TEMP TRIGGER fail_source_proof BEFORE UPDATE ON plugin_validation_links
         BEGIN SELECT RAISE(ABORT,'synthetic source publication failure'); END;",
    ).unwrap();
    assert_eq!(fixture.store.commit_source_validation(b.clone()).unwrap_err().code, ErrorCode::StorageFailed);
    fixture.store.connection().unwrap().execute_batch("DROP TRIGGER fail_source_proof").unwrap();
    assert_eq!(current_link(fixture.store.connection().unwrap(), fixture.result), a_result.to_string());
    assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, b_attempt, b_result).unwrap(), None,
        "history, current link, and producer validation roll back together");
    fixture.store.commit_source_validation(b).unwrap();
    assert_eq!(current_link(fixture.store.connection().unwrap(), fixture.result), b_result.to_string());
    fixture.store.commit_source_validation(a).unwrap();
    assert_eq!(current_link(fixture.store.connection().unwrap(), fixture.result), b_result.to_string(),
        "retry A must not replace the current B proof");
    fixture.store.execution_unknown.store(true, Ordering::Release);
    let authority = fixture.store.planning_authority_revision.load(Ordering::Acquire);
    let writes = fixture.store.connection().unwrap().total_changes();
    assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, a_attempt, a_result).unwrap(), Some(true));
    assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, b_attempt, b_result).unwrap(), Some(false));
    let expiry: i64 = fixture.store.connection().unwrap().query_row(
        "SELECT expires_at_ms FROM plugin_execution_grants WHERE grant_id=?1", [fixture.producer_grant.to_string()], |r| r.get(0)).unwrap();
    let metadata = SourcePluginStartMetadata { task_id: fixture.input.envelope().task_id, generation: fixture.generation };
    assert!(matches!(fixture.store.source_plugin_start_request_observation(fixture.project, fixture.input.envelope().attempt_id,
        OPERATION, fixture.input.digest(), fixture.producer_grant, expiry as u64, true, &metadata).unwrap(), SourcePluginStartObservation::Started { .. }));
    assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, fixture.input.envelope().attempt_id,
        OPERATION, fixture.input.digest(), ExecutionId::new(), expiry as u64, true, &metadata).unwrap_err().code, ErrorCode::ResultMismatch);
    assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, fixture.input.envelope().attempt_id,
        OPERATION, fixture.input.digest(), fixture.producer_grant, expiry as u64 + 1, true, &metadata).unwrap_err().code, ErrorCode::ResultMismatch);
    let check_expiry: i64 = fixture.store.connection().unwrap().query_row(
        "SELECT expires_at_ms FROM plugin_execution_grants WHERE grant_id=?1", [fixture.checker_grant.to_string()], |r| r.get(0)).unwrap();
    let checker_metadata = SourcePluginStartMetadata { task_id: fixture.check_input.envelope().task_id, generation: fixture.generation };
    assert!(matches!(fixture.store.source_plugin_start_request_observation(fixture.project, a_attempt, SOURCE_CHECK_OPERATION,
        fixture.check_input.digest(), fixture.checker_grant, check_expiry as u64, true, &checker_metadata).unwrap(), SourcePluginStartObservation::Started { .. }));
    assert!(fixture.store.source_check_finish_request_observation(ExecutionId::new(), a_attempt, a_result).is_err());
    assert!(fixture.store.source_check_finish_request_observation(fixture.project, a_attempt, b_result).is_err());
    assert!(fixture.store.is_reconciling());
    assert_eq!(fixture.store.planning_authority_revision.load(Ordering::Acquire), authority);
    assert_eq!(fixture.store.connection().unwrap().total_changes(), writes);
    let path = fixture.directory.path().join("project");
    drop(fixture.store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(reopened.source_check_finish_request_observation(fixture.project, a_attempt, a_result).unwrap(), Some(true));
    assert_eq!(reopened.source_check_finish_request_observation(fixture.project, b_attempt, b_result).unwrap(), Some(false));
    assert_eq!(current_link(reopened.connection().unwrap(), fixture.result), b_result.to_string());
}

fn old_rows(c: &Connection) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    ["execution_attempts", "execution_results", "execution_actions", "adoption_receipts", "source_sets",
        "source_files", "source_snapshots", "source_occurrences", "source_lineage", "source_lineage_evidence", "resource_changes"]
        .into_iter().map(|table| {
            let columns = if table == "resource_changes" {
                "rowid,change_id,project_id,kind,locale,scope_unit_id,old_scope_unit_id,source_phrase,old_source_phrase,old_revision_id,new_revision_id,action_id"
            } else { "rowid,*" };
            let mut statement = c.prepare(&format!("SELECT {columns} FROM {table} ORDER BY rowid")).unwrap();
            let columns = statement.column_count();
            let rows = statement.query_map([], |r| (0..columns).map(|index| r.get(index)).collect::<rusqlite::Result<Vec<_>>>())
                .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            (table.to_owned(), rows)
        }).collect()
}

#[test]
fn supported_schema69_migration_backfills_only_proven_links_and_preserves_original_rows() {
    for version in 61..=68 {
        let mut fixture = plugin_fixture();
        let a_attempt = fixture.check_input.envelope().attempt_id;
        let a_result = fixture.store.execution_current_result(a_attempt, fixture.check_input.envelope().items[0].item_id).unwrap().unwrap();
        let b = another_check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, false);
        let b_attempt = b.capture.check_input.envelope().attempt_id;
        let b_result = b.check_result.envelope().result_id;
        fixture.store.commit_source_validation(b).unwrap();
        let path = fixture.directory.path().join("project");
        drop(fixture.store);
        let mut c = Connection::open(path.join(crate::persistence::DATABASE_FILENAME)).unwrap();
        // Normal open installs the ledger's chunk reader before migration.
        // This raw connection also exercises the production proof backfill.
        crate::persistence::ledger::register_input_reader(&c).unwrap();
        c.execute_batch("DROP TABLE source_validation_history").unwrap();
        crate::persistence::content::lineage_corrections::make_legacy_schema(&c).unwrap();
        if version < 68 { crate::persistence::translation::make_legacy_memory_schema(&c).unwrap(); }
        if version < 66 { crate::persistence::resources::make_legacy_context_schema(&c).unwrap(); }
        if version < 65 { c.execute_batch("DROP TABLE application_conversation_planning_attempts").unwrap(); }
        if version < 64 { c.execute_batch("DROP TABLE application_conversation_work_plans").unwrap(); }
        if version < 63 { c.execute_batch("DROP TABLE application_conversation_proposals").unwrap(); }
        if version == 61 { c.execute_batch("DROP TABLE application_conversation_actions;DROP TABLE application_conversation_messages;DROP TABLE application_conversations").unwrap(); }
        c.pragma_update(None, "user_version", version).unwrap();
        let before = old_rows(&c);
        // The production DDL/backfill is rollback-safe inside the same transaction.
        { let tx = c.transaction().unwrap(); migrate(&tx).unwrap(); }
        assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)", [TABLE], |r| r.get::<_, bool>(0)).unwrap());
        assert_eq!(c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), version);
        assert_eq!(old_rows(&c), before);
        drop(c);
        let reopened = ProjectStore::open(&path).unwrap();
        assert_eq!(old_rows(reopened.connection().unwrap()), before);
        assert_eq!(reopened.connection().unwrap().pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), crate::persistence::SCHEMA_VERSION);
        assert_eq!(reopened.source_check_finish_request_observation(fixture.project, b_attempt, b_result).unwrap(), Some(false));
        assert_eq!(reopened.source_check_finish_request_observation(fixture.project, a_attempt, a_result).unwrap(), None,
            "schema68 did not retain proof that an overwritten link was published");
    }
}
