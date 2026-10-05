//! Actual Core plugin grants and bounded conformance execution.
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tsumugi_core::{ProjectStore, execution::*};

pub fn authorize(
    runtime: &ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> ExecutionId {
    let grant = ExecutionId::new();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 180_000;
    runtime
        .authorize_plugin(
            store,
            grant,
            input,
            expires,
            PluginConsent {
                unsandboxed_execution: true,
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
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(input.envelope().attempt_id) {
            return input
                .envelope()
                .items
                .iter()
                .map(|item| {
                    let id = store
                        .execution_current_result(input.envelope().attempt_id, item.item_id)
                        .unwrap()
                        .unwrap();
                    let result = store
                        .execution_result(input.envelope().attempt_id, id)
                        .unwrap();
                    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
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
