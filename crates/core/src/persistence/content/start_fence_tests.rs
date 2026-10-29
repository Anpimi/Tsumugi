use super::*;
use super::decision_mappings::tests::plugin_fixture;
use std::sync::atomic::Ordering;

fn new_input(input: &FixedInput) -> FixedInput {
    let mut envelope = input.envelope().clone();
    envelope.task_id = ExecutionId::new(); envelope.attempt_id = ExecutionId::new();
    FixedInput::capture(envelope).unwrap()
}

#[test]
fn exact_source_start_fences_cover_missing_and_unenqueued_grants_for_both_operations() {
    for checker in [false, true] {
        for existing_grant in [false, true] {
            let mut fixture = plugin_fixture();
            let input = new_input(if checker { &fixture.check_input } else { &fixture.input });
            let metadata = SourcePluginStartMetadata { task_id: input.envelope().task_id, generation: fixture.generation };
            let grant = ExecutionId::new();
            let expires = crate::execution::plugin_authority::plugin_now_ms().unwrap() + 600_000;
            let consent = PluginConsent { unsandboxed_execution: true, application_execution: false };
            if existing_grant {
                fixture.store.authorize_plugin_input(fixture.generation, grant, &input, expires, consent, None).unwrap();
            }
            let writes = fixture.store.connection().unwrap().total_changes();
            assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, input.envelope().attempt_id,
                &input.envelope().operation, input.digest(), grant, expires, true, &metadata).unwrap(), SourcePluginStartObservation::Unknown);
            assert_eq!(fixture.store.connection().unwrap().total_changes(), writes);
            if !existing_grant { fixture.store.execution_unknown.store(true, Ordering::Release); }
            assert_eq!(fixture.store.cancel_source_start_request(fixture.project, input.envelope().attempt_id,
                &input.envelope().operation, input.digest(), grant, expires, true, &metadata).unwrap(), SourcePluginStartObservation::ConfirmedNotApplied);
            assert!(!fixture.store.is_reconciling(), "only the explicit cancellation performs recovery");
            assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, input.envelope().attempt_id,
                &input.envelope().operation, input.digest(), grant, expires, true, &metadata).unwrap(), SourcePluginStartObservation::ConfirmedNotApplied);
            for operation in [OPERATION, SOURCE_CHECK_OPERATION] {
                assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, input.envelope().attempt_id,
                    operation, input.digest(), grant, expires, true, &metadata).unwrap(), SourcePluginStartObservation::ConfirmedNotApplied,
                    "an absent input has no recoverable operation; the entire attempt/grant is fenced");
            }
            assert!(expires > crate::execution::plugin_authority::plugin_now_ms().unwrap());
            assert!(fixture.store.authorize_plugin_input(fixture.generation, grant, &input, expires, consent, None).is_err(),
                "a late original authorization cannot arm a revoked grant");
            assert!(fixture.store.enqueue_read_only_execution(&input).is_err());
            let altered = SourcePluginStartMetadata { task_id: ExecutionId::new(), ..metadata.clone() };
            assert_eq!(fixture.store.cancel_source_start_request(fixture.project, input.envelope().attempt_id,
                &input.envelope().operation, input.digest(), grant, expires, true, &altered).unwrap_err().code, ErrorCode::ResultMismatch);
            assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, input.envelope().attempt_id,
                &input.envelope().operation, input.digest(), grant, expires + 1, true, &metadata).unwrap_err().code, ErrorCode::ResultMismatch);
            fixture.store.execution_unknown.store(true, Ordering::Release);
            let authority = fixture.store.planning_authority_revision.load(Ordering::Acquire);
            assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, input.envelope().attempt_id,
                &input.envelope().operation, input.digest(), grant, expires, true, &metadata).unwrap(), SourcePluginStartObservation::ConfirmedNotApplied);
            assert!(fixture.store.is_reconciling());
            assert_eq!(fixture.store.planning_authority_revision.load(Ordering::Acquire), authority);
            let path = fixture.directory.path().join("project"); drop(fixture.store);
            let mut reopened = ProjectStore::open(path).unwrap();
            assert_eq!(reopened.source_plugin_start_request_observation(fixture.project, input.envelope().attempt_id,
                &input.envelope().operation, input.digest(), grant, expires, true, &metadata).unwrap(), SourcePluginStartObservation::ConfirmedNotApplied);
            let generation = ExecutionId::new(); reopened.begin_plugin_epoch(generation).unwrap();
            assert!(reopened.authorize_plugin_input(generation, grant, &input, expires, consent, None).is_err(),
                "a new epoch cannot reinterpret the cancelled original grant");
            assert!(reopened.enqueue_read_only_execution(&input).is_err());
        }
    }
}

#[test]
fn an_enqueued_original_start_wins_before_cancellation_without_revocation() {
    let mut fixture = plugin_fixture();
    let metadata = SourcePluginStartMetadata { task_id: fixture.input.envelope().task_id, generation: fixture.generation };
    let expiry: i64 = fixture.store.connection().unwrap().query_row(
        "SELECT expires_at_ms FROM plugin_execution_grants WHERE grant_id=?1", [fixture.producer_grant.to_string()], |r| r.get(0)).unwrap();
    let writes = fixture.store.connection().unwrap().total_changes();
    let observed = fixture.store.cancel_source_start_request(fixture.project, fixture.input.envelope().attempt_id,
        OPERATION, fixture.input.digest(), fixture.producer_grant, expiry as u64, true, &metadata).unwrap();
    assert!(matches!(observed, SourcePluginStartObservation::Started { .. }));
    assert_eq!(fixture.store.source_plugin_start_request_observation(fixture.project, fixture.input.envelope().attempt_id,
        SOURCE_CHECK_OPERATION, fixture.input.digest(), fixture.producer_grant, expiry as u64, true, &metadata).unwrap_err().code,
        ErrorCode::ResultMismatch, "a stored input strictly binds its actual operation");
    assert_eq!(fixture.store.connection().unwrap().total_changes(), writes);
    assert!(!fixture.store.connection().unwrap().query_row("SELECT revoked FROM plugin_execution_grants WHERE grant_id=?1",
        [fixture.producer_grant.to_string()], |r| r.get::<_, bool>(0)).unwrap());
}
