use super::*;
use super::decision_mappings::tests::extract;
use std::{sync::atomic::Ordering, time::{SystemTime, UNIX_EPOCH}};

#[test]
fn an_exact_other_stop_permanently_fences_a_without_hiding_action_collisions() {
    let (directory, mut store, project, _) = crate::persistence::review::tests::fixture();
    let (input, result) = extract(&mut store,
        br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#,
        br#"{"hello":"Changed","plain":"Plain"}"#);
    let mut confirmation = store.source_comparison(input.envelope().attempt_id, result, 0, 100).unwrap().confirmation;
    let descriptor = store.source_maintenance_hook_session().unwrap();
    let activation = SourceMaintenanceHookActivation { policy_version: descriptor.policy_version,
        session_epoch: descriptor.session_epoch, locale: "zh-CN".into(), after: 0, limit: 100,
        expires_at_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 300_000 };
    confirmation.maintenance_hook = Some(activation.clone());
    let source = store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![result], serde_json::to_value(&confirmation).unwrap()).unwrap();
    let other_source = store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![result], serde_json::to_value(&confirmation).unwrap()).unwrap();
    let a = StopSourceMaintenanceHook { project_id: project, source_action_id: source.action_id,
        action_id: ExecutionId::new(), activation: activation.clone() };
    assert_eq!(store.source_hook_stop_request_observation(&a).unwrap(), SourceHookStopObservation::Unknown);
    let b = StopSourceMaintenanceHook { action_id: ExecutionId::new(), ..a.clone() };
    let stopped = store.stop_source_maintenance_hook(&b).unwrap();
    let SourceMaintenanceHookStopResult::Stopped { receipt } = stopped else { panic!("B was not recorded"); };
    let colliding = StopSourceMaintenanceHook { action_id: ExecutionId::new(), ..a.clone() };
    store.stop_source_maintenance_hook(&StopSourceMaintenanceHook {
        source_action_id: other_source.action_id, ..colliding.clone()
    }).unwrap();
    assert_eq!(store.stop_source_maintenance_hook(&a).unwrap_err().stage, "source-hook-stopped");
    store.execution_unknown.store(true, Ordering::Release);
    let authority = store.planning_authority_revision.load(Ordering::Acquire);
    let writes = store.connection().unwrap().total_changes();
    assert_eq!(store.source_hook_stop_request_observation(&a).unwrap(),
        SourceHookStopObservation::ConfirmedNotApplied { stopped_by_action_id: b.action_id });
    assert_eq!(store.source_hook_stop_request_observation(&b).unwrap(), SourceHookStopObservation::Recorded { receipt });
    assert_eq!(store.source_hook_stop_request_observation(&colliding).unwrap_err().code, ErrorCode::ResultMismatch);
    let mut altered = a.clone(); altered.activation.expires_at_ms += 1;
    assert_eq!(store.source_hook_stop_request_observation(&altered).unwrap_err().code, ErrorCode::ResultMismatch);
    let missing = StopSourceMaintenanceHook { source_action_id: ExecutionId::new(), ..a.clone() };
    assert_eq!(store.source_hook_stop_request_observation(&missing).unwrap(), SourceHookStopObservation::Unknown);
    assert!(store.is_reconciling());
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire), authority);
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    drop(store);
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.source_hook_stop_request_observation(&a).unwrap(),
        SourceHookStopObservation::ConfirmedNotApplied { stopped_by_action_id: b.action_id });
}
