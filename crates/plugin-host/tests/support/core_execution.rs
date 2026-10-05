//! Actual Core plugin grants and bounded single-item conformance execution.
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
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(input.envelope().attempt_id) {
            if let Some(id) = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
            {
                let result = store
                    .execution_result(input.envelope().attempt_id, id)
                    .unwrap();
                assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
                return result;
            }
        }
        assert!(
            Instant::now() < deadline,
            "actual source worker completion deadline"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
