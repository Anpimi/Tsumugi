use super::*;
use crate::persistence::content::decision_mappings::tests::{plugin_fixture, save_plugin_result, PluginFixture};
use std::sync::atomic::Ordering;
use tsumugi_plugin_sdk as sdk;

fn producer(fixture: &mut PluginFixture) -> (FixedInput, FixedResult) {
    let original = fixture.store.execution_result(fixture.input.envelope().attempt_id, fixture.result).unwrap();
    let output = crate::content::validate_output(&fixture.input, &original).unwrap().exchange;
    let mut envelope = fixture.input.envelope().clone();
    envelope.task_id = ExecutionId::new();
    envelope.attempt_id = ExecutionId::new();
    let input = FixedInput::capture(envelope).unwrap();
    let (_, result) = save_plugin_result(&mut fixture.store, fixture.generation, &input,
        serde_json::to_value(output).unwrap());
    (input, result)
}

fn changed_producer(fixture: &mut PluginFixture) -> (FixedInput, ExecutionId) {
    let original = fixture.store.execution_result(fixture.input.envelope().attempt_id, fixture.result).unwrap();
    let mut output = crate::content::validate_output(&fixture.input, &original).unwrap().exchange;
    let mut source: sdk::SourceExtractionInput = serde_json::from_value(fixture.input.envelope().items[0].payload.clone()).unwrap();
    assert_eq!(source.artifacts.len(), 1);
    let artifact = &mut source.artifacts[0];
    let original_id = artifact.id.clone();
    let original_length = artifact.utf8.len() as u32;
    let mut material: serde_json::Value = serde_json::from_str(&artifact.utf8).unwrap();
    assert_eq!(material["canonical"], "CaseKey");
    material["canonical"] = serde_json::json!("RenamedCase");
    artifact.utf8 = serde_json::to_string(&material).unwrap();
    artifact.sha256 = codec::digest(artifact.utf8.as_bytes());
    artifact.id = ExecutionId::new().to_string();
    let artifact_id = artifact.id.clone();
    let length = artifact.utf8.len() as u32;
    source.source_set_id = ExecutionId::new().to_string();
    output.source_set_id = source.source_set_id.clone();
    output.artifacts = source.artifacts.clone();
    for occurrence in output.units.iter_mut().flat_map(|unit| &mut unit.occurrences) {
        assert_eq!(occurrence.source.artifact_id, original_id);
        assert_eq!((occurrence.source.range.start, occurrence.source.range.end), (0, original_length));
        occurrence.source.artifact_id = artifact_id.clone();
        occurrence.source.range.end = length;
    }
    // A changed proposal alone is insufficient for source adoption. Its
    // captured material and all proposal references describe the real rename.
    let mut envelope = fixture.input.envelope().clone();
    envelope.task_id = ExecutionId::new();
    envelope.attempt_id = ExecutionId::new();
    envelope.items[0].scope.id = source.source_set_id.clone();
    envelope.items[0].payload = serde_json::to_value(source).unwrap();
    let input = FixedInput::capture(envelope).unwrap();
    let (_, result) = save_plugin_result(&mut fixture.store, fixture.generation, &input,
        serde_json::to_value(output).unwrap());
    (input, result.envelope().result_id)
}

fn check(store: &mut ProjectStore, generation: ExecutionId, input: &FixedInput,
    result: ExecutionId, valid: bool) -> (ExecutionId, PreparedSourceValidation) {
    let capture = store.capture_source_validation(input.envelope().attempt_id, result).unwrap();
    let checker = capture.check_input().clone();
    let payload: sdk::SourceExtractionCheckInput = serde_json::from_value(checker.envelope().items[0].payload.clone()).unwrap();
    let checks = payload.requirements.into_iter().map(|required| sdk::CheckResult {
        key: required.key, input_digest: required.input_digest, scope_digest: required.scope_digest,
        covered_targets: required.targets, outcome: sdk::CheckOutcome::Completed { findings: vec![] },
    }).collect::<Vec<_>>();
    let output = if valid { serde_json::to_value(checks).unwrap() }
        else { serde_json::json!({"invalid": "check report"}) };
    let (grant, result) = save_plugin_result(store, generation, &checker, output);
    (grant, capture.prepare(result).unwrap())
}

fn ids(prepared: &PreparedSourceValidation) -> (ExecutionId, ExecutionId) {
    (prepared.capture.check_input.envelope().attempt_id, prepared.check_result.envelope().result_id)
}

fn counts(c: &Connection) -> Vec<i64> {
    ["execution_attempts", "execution_results", "plugin_execution_grants", "execution_actions"]
        .into_iter().map(|table| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()).collect()
}

fn current(c: &Connection, input: &FixedInput, result: ExecutionId) -> (Option<(ExecutionId, bool)>, String) {
    (head_in(c, result).unwrap(), c.query_row("SELECT validation FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
        params![input.envelope().attempt_id.to_string(), input.envelope().items[0].item_id.to_string()], |r| r.get(0)).unwrap())
}

#[test]
fn recovered_publication_uses_persisted_frames_after_reopen_without_restoring_execution_authority() {
    let mut fixture = plugin_fixture();
    let (input, result) = producer(&mut fixture);
    let (_, checked) = check(&mut fixture.store, fixture.generation, &input, result.envelope().result_id, true);
    let (attempt, checker_result) = ids(&checked);
    let path = fixture.directory.path().join("project");
    // Expired historical execution permission remains attribution, never an
    // execution permit. The original normal commit still needs live authority.
    fixture.store.connection().unwrap().execute("UPDATE plugin_execution_grants SET expires_at_ms=1 WHERE attempt_id IN (?1,?2)",
        params![input.envelope().attempt_id.to_string(), attempt.to_string()]).unwrap();
    drop(fixture.store);
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert!(reopened.commit_source_validation(checked.clone()).is_err());
    assert_eq!(reopened.source_check_finish_request_observation(fixture.project, attempt, checker_result).unwrap(), None);
    assert!(reopened.capture_source_validation_publication(ExecutionId::new(), attempt, checker_result).is_err());
    assert!(reopened.capture_source_validation_publication(fixture.project, input.envelope().attempt_id, result.envelope().result_id).is_err());
    reopened.execution_unknown.store(true, Ordering::Release);
    let authority = reopened.planning_authority_revision.load(Ordering::Acquire);
    let writes = reopened.connection().unwrap().total_changes();
    let original_counts = counts(reopened.connection().unwrap());
    let capture = reopened.capture_source_validation_publication(fixture.project, attempt, checker_result).unwrap();
    let prepared = capture.prepare().unwrap();
    assert!(reopened.is_reconciling());
    assert_eq!(reopened.planning_authority_revision.load(Ordering::Acquire), authority);
    assert_eq!(reopened.connection().unwrap().total_changes(), writes);
    reopened.commit_source_validation_publication(prepared).unwrap();
    assert_eq!(reopened.source_check_finish_request_observation(fixture.project, attempt, checker_result).unwrap(), Some(true));
    assert_eq!(current(reopened.connection().unwrap(), &input, result.envelope().result_id),
        (Some((checker_result, true)), "valid".into()));
    assert_eq!(counts(reopened.connection().unwrap()), original_counts,
        "publication creates no attempts, results, execution grants, or adoption actions");
    assert!(reopened.check_plugin_input(&input).is_err(), "publication never re-arms the original execution grant");
    drop(reopened);
    let mut reopened = ProjectStore::open(path).unwrap();
    let prepared = reopened.capture_source_validation_publication(fixture.project, attempt, checker_result).unwrap().prepare().unwrap();
    let writes = reopened.connection().unwrap().total_changes();
    reopened.commit_source_validation_publication(prepared).unwrap();
    assert_eq!(reopened.connection().unwrap().total_changes(), writes, "a recorded result is receipt-first");
}

#[test]
fn recovered_a_records_history_atomically_without_replacing_current_b_or_its_validity() {
    let mut fixture = plugin_fixture();
    let (_, a) = check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, true);
    let (_, b) = check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, false);
    let (a_attempt, a_result) = ids(&a);
    let (_, b_result) = ids(&b);
    fixture.store.commit_source_validation(b).unwrap();
    let path = fixture.directory.path().join("project");
    drop(fixture.store);
    let mut reopened = ProjectStore::open(&path).unwrap();
    let capture = reopened.capture_source_validation_publication(fixture.project, a_attempt, a_result).unwrap();
    reopened.connection().unwrap().execute_batch("CREATE TEMP TRIGGER fail_recovered_proof BEFORE INSERT ON source_validation_history
        BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END;").unwrap();
    assert_eq!(reopened.commit_source_validation_publication(capture.clone().prepare().unwrap()).unwrap_err().code, ErrorCode::StorageFailed);
    assert_eq!(reopened.source_check_finish_request_observation(fixture.project, a_attempt, a_result).unwrap(), None);
    assert_eq!(current(reopened.connection().unwrap(), &fixture.input, fixture.result), (Some((b_result, false)), "invalid".into()));
    reopened.connection().unwrap().execute_batch("DROP TRIGGER fail_recovered_proof").unwrap();
    reopened.commit_source_validation_publication(capture.prepare().unwrap()).unwrap();
    assert_eq!(reopened.source_check_finish_request_observation(fixture.project, a_attempt, a_result).unwrap(), Some(true));
    assert_eq!(current(reopened.connection().unwrap(), &fixture.input, fixture.result), (Some((b_result, false)), "invalid".into()));
    assert!(load_qualified_source(reopened.connection().unwrap(), fixture.input.envelope().attempt_id, fixture.result).is_err(),
        "A's newly recorded valid history cannot qualify the producer using B's current negative proof");
    reopened.commit_source_validation(a).unwrap();
    assert_eq!(current(reopened.connection().unwrap(), &fixture.input, fixture.result), (Some((b_result, false)), "invalid".into()));
    drop(reopened);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(reopened.source_check_finish_request_observation(fixture.project, a_attempt, a_result).unwrap(), Some(true));
    assert_eq!(current(reopened.connection().unwrap(), &fixture.input, fixture.result), (Some((b_result, false)), "invalid".into()));
}

#[test]
fn recovered_publication_rechecks_cancellation_revocation_and_both_current_results() {
    for checker in [false, true] {
        for change in ["cancel", "revoke", "result"] {
            let mut fixture = plugin_fixture();
            let (checker_grant, a) = check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, true);
            let (attempt, result) = ids(&a);
            let captured = fixture.store.capture_source_validation_publication(fixture.project, attempt, result).unwrap();
            let input = if checker { a.capture.check_input.clone() } else { fixture.input.clone() };
            match change {
                "cancel" => { fixture.store.cancel_execution(input.envelope().task_id, ExecutionId::new()).unwrap(); }
                "revoke" => { fixture.store.revoke_plugin_grant(fixture.generation,
                    if checker { checker_grant } else { fixture.producer_grant }).unwrap(); }
                _ => {
                    let original = if checker { a.check_result.clone() }
                        else { fixture.store.execution_result(input.envelope().attempt_id, fixture.result).unwrap() };
                    let mut envelope = original.envelope().clone();
                    envelope.result_id = ExecutionId::new();
                    envelope.supersedes = Some(original.envelope().result_id);
                    let replacement = FixedResult::capture(envelope, &input, original.envelope().dispatch_token).unwrap();
                    fixture.store.save_execution_result(&replacement).unwrap();
                }
            }
            let before = current(fixture.store.connection().unwrap(), &fixture.input, fixture.result);
            let error = fixture.store.commit_source_validation_publication(captured.prepare().unwrap()).unwrap_err();
            assert_eq!(error.code, match change {
                "cancel" => ErrorCode::Cancelled, "revoke" => ErrorCode::Unauthorized,
                _ => ErrorCode::DependencyConflict,
            }, "{change}, checker={checker}");
            let expected_stage = match change {
                "cancel" => "source-publication-cancelled", "revoke" => "source-publication-revoked",
                _ => "source-publication-current-result",
            };
            assert_eq!(error.stage, expected_stage);
            assert!(fixture.store.commit_source_validation(a).is_err(),
                "the original live commit cannot publish past the same admission boundary");
            fixture.store.execution_unknown.store(true, Ordering::Release);
            let authority = fixture.store.planning_authority_revision.load(Ordering::Acquire);
            let writes = fixture.store.connection().unwrap().total_changes();
            let observed = fixture.store.capture_source_validation_publication(fixture.project, attempt, result).err().unwrap();
            assert_eq!(observed.stage, expected_stage);
            assert!(fixture.store.is_reconciling());
            assert_eq!(fixture.store.planning_authority_revision.load(Ordering::Acquire), authority);
            assert_eq!(fixture.store.connection().unwrap().total_changes(), writes);
            assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, attempt, result).unwrap(), None);
            assert_eq!(current(fixture.store.connection().unwrap(), &fixture.input, fixture.result), before);
            if change != "result" {
                let path = fixture.directory.path().join("project");
                drop(fixture.store);
                let reopened = ProjectStore::open(path).unwrap();
                assert_eq!(reopened.capture_source_validation_publication(fixture.project, attempt, result).err().unwrap().stage, expected_stage,
                    "the negative proof survives reopening without granting any execution authority");
                // Already published B is receipt-first, even when its producer
                // was subsequently cancelled or its historical grant revoked.
                let b_attempt = fixture.check_input.envelope().attempt_id;
                let b_result = reopened.execution_current_result(b_attempt, fixture.check_input.envelope().items[0].item_id).unwrap().unwrap();
                assert_eq!(reopened.source_check_finish_request_observation(fixture.project, b_attempt, b_result).unwrap(), Some(true));
                assert!(reopened.capture_source_validation_publication(fixture.project, b_attempt, b_result).is_ok());
            }
        }
    }
    let mut fixture = plugin_fixture();
    let (_, a) = check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, true);
    let (attempt, result) = ids(&a);
    fixture.store.connection().unwrap().execute("UPDATE execution_attempts SET cancellation_revision=1 WHERE attempt_id=?1",
        [attempt.to_string()]).unwrap();
    let error = fixture.store.capture_source_validation_publication(fixture.project, attempt, result).err().unwrap();
    assert_eq!((error.code, error.stage.as_str()), (ErrorCode::CorruptLedger, "source-publication-cancellation-basis"),
        "a damaged captured counter is not proof of a persistent cancellation");
}

#[test]
fn recovered_publication_freezes_current_head_and_source_scope_and_keeps_adopted_b_current() {
    let mut fixture = plugin_fixture();
    let (_, a) = check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, true);
    let (attempt, result) = ids(&a);
    let capture = fixture.store.capture_source_validation_publication(fixture.project, attempt, result).unwrap();
    let (_, c) = check(&mut fixture.store, fixture.generation, &fixture.input, fixture.result, false);
    let c_result = c.check_result.envelope().result_id;
    fixture.store.commit_source_validation(c).unwrap();
    let error = fixture.store.commit_source_validation_publication(capture.prepare().unwrap()).unwrap_err();
    assert_eq!((error.code, error.stage.as_str()), (ErrorCode::DependencyConflict, "source-publication-head-changed"));
    assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, attempt, result).unwrap(), None);
    assert_eq!(current(fixture.store.connection().unwrap(), &fixture.input, fixture.result), (Some((c_result, false)), "invalid".into()));

    let mut fixture = plugin_fixture();
    let (input, producer_result) = changed_producer(&mut fixture);
    let (_, b) = check(&mut fixture.store, fixture.generation, &input, producer_result, true);
    fixture.store.commit_source_validation(b).unwrap();
    let (_, a) = check(&mut fixture.store, fixture.generation, &input, producer_result, false);
    let (attempt, result) = ids(&a);
    let capture = fixture.store.capture_source_validation_publication(fixture.project, attempt, result).unwrap();
    let old_scope = fixture.store.content_scope().unwrap();
    let b = current(fixture.store.connection().unwrap(), &input, producer_result);
    let comparison = fixture.store.source_comparison(input.envelope().attempt_id, producer_result, 0, 100).unwrap();
    assert_eq!(comparison.counts.rename_candidate, 1);
    let action = fixture.store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![producer_result], serde_json::to_value(comparison.confirmation).unwrap()).unwrap();
    fixture.store.adopt_execution(&action, &SourceAdoptionHandler).unwrap();
    let new_scope = fixture.store.content_scope().unwrap();
    assert_ne!(old_scope, new_scope);
    let error = fixture.store.commit_source_validation_publication(capture.prepare().unwrap()).unwrap_err();
    assert_eq!((error.code, error.stage.as_str()), (ErrorCode::DependencyConflict, "source-publication-scope"));
    assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, attempt, result).unwrap(), None);
    let prepared = fixture.store.capture_source_validation_publication(fixture.project, attempt, result).unwrap().prepare().unwrap();
    fixture.store.commit_source_validation_publication(prepared).unwrap();
    assert_eq!(fixture.store.source_check_finish_request_observation(fixture.project, attempt, result).unwrap(), Some(false));
    assert_eq!(fixture.store.content_scope().unwrap(), new_scope);
    assert_eq!(current(fixture.store.connection().unwrap(), &input, producer_result), b);
    assert!(load_qualified_source(fixture.store.connection().unwrap(), input.envelope().attempt_id, producer_result).is_ok(),
        "recording A's historical failure does not revoke adopted producer B's valid current proof");
    assert_eq!(fixture.store.execution_attempt(input.envelope().attempt_id, false).unwrap().items[0].adoption, AdoptionState::Committed);
}
