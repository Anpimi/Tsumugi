//! Actual Core plugin grants and bounded conformance execution.
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tsumugi_core::{ProjectStore, execution::*};

pub fn authorize(
    runtime: &ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> ExecutionId {
    authorize_for(
        runtime,
        store,
        input,
        Duration::from_millis(u64::from(input.envelope().limits.timeout_ms)) + Duration::from_secs(60),
    )
}

pub fn authorize_for(
    runtime: &ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
    lifetime: Duration,
) -> ExecutionId {
    let grant = ExecutionId::new();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + u64::try_from(lifetime.as_millis()).unwrap();
    runtime
        .authorize_plugin(
            store,
            grant,
            input,
            expires,
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: false,
            },
        )
        .unwrap();
    grant
}
pub fn execute(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> FixedResult {
    assert_eq!(input.envelope().items.len(), 1);
    execute_all(runtime, store, input).remove(0)
}

pub fn execute_all(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> Vec<FixedResult> {
    runtime.submit(store, input).unwrap();
    // The captured timeout applies to one physical dispatch. A projection has
    // many independent items; bound the test attempt separately.
    let attempt_budget = Duration::from_millis(u64::from(input.envelope().limits.timeout_ms))
        + Duration::from_millis((input.envelope().items.len() as u64).saturating_sub(1) * 20)
        + Duration::from_secs(10);
    let deadline = Instant::now() + attempt_budget.min(Duration::from_secs(1800));
    let attempt = input.envelope().attempt_id;
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(attempt)
            && !store.queued_execution_attempts(Revision::new(0).unwrap()).unwrap().contains(&attempt)
        {
            return input
                .envelope()
                .items
                .iter()
                .map(|item| {
                    let id = store
                        .execution_current_result(input.envelope().attempt_id, item.item_id)
                        .unwrap()
                        .unwrap_or_else(|| {
                            let view = store.execution_attempt(attempt, false).unwrap();
                            let status = view.items.iter().find(|status| status.item_id == item.item_id);
                            panic!(
                                "captured execution ended without a result: item={status:?} progress={:?}",
                                view.progress,
                            )
                        });
                    let result = store
                        .execution_result(input.envelope().attempt_id, id)
                        .unwrap();
                    assert_eq!(
                        result.envelope().outcome,
                        ExecutionState::Succeeded,
                        "actual captured execution failed: capability={} provider={:?} diagnostic={:?}",
                        input.envelope().capability_id,
                        input.envelope().plugin.as_ref().map(|p| &p.capability.provider),
                        result.envelope().diagnostic
                    );
                    if let Some(binding) = &input.envelope().plugin {
                        let evidence = result.envelope().plugin.as_ref().unwrap();
                        assert_eq!(evidence.result.context.scope_id,
                            binding.scope_id(input.envelope().project_id, input.envelope().attempt_id).unwrap());
                    }
                    result
                })
                .collect();
        }
        assert!(
            Instant::now() < deadline,
            "actual source worker completion deadline"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
