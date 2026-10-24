use std::{path::PathBuf, sync::OnceLock};
use tsumugi_plugin_host::CapturedRuntime;
use tsumugi_plugin_sdk::RuntimeEnvironmentDescriptor;

/// The conformance runner prepares and independently hashes a vetted tool
/// distribution and a clean, built Host artifact. No PATH/module fallback.
pub fn approved_runtime() -> CapturedRuntime {
    static CAPTURED: OnceLock<CapturedRuntime> = OnceLock::new();
    CAPTURED
        .get_or_init(|| {
            let tool = PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").expect("approved tool tree required"),
            );
            let host = PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST")
                    .expect("clean built Host tree required"),
            );
            let approval = PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL")
                    .expect("independent runtime approval required"),
            );
            let descriptor: RuntimeEnvironmentDescriptor =
                serde_json::from_slice(&std::fs::read(approval).unwrap()).unwrap();
            CapturedRuntime::capture_directories(&tool, &host, &descriptor, || true).unwrap()
        })
        .clone()
}
