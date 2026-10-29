use super::*;
use std::{sync::{Arc, atomic::Ordering}, time::{Duration, Instant}};

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
