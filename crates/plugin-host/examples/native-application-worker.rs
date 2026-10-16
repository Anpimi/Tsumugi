//! Synthetic SDK client for Native Application lifecycle conformance. It owns
//! no project authority and speaks only through the existing SDK facade.
use tsumugi_plugin_sdk::{
    EncodedPayload, NativeCapabilityOutput, NativeComponent, NativeInvocationMetadata,
    serve_native_component,
};

#[derive(Default)]
struct Reference {
    calls: u64,
}
impl NativeComponent for Reference {
    fn invoke(
        &mut self,
        input: &EncodedPayload,
        metadata: &NativeInvocationMetadata,
    ) -> NativeCapabilityOutput {
        let Ok(serde_json::Value::Object(mut value)) = serde_json::from_str(&input.utf8) else {
            return NativeCapabilityOutput::Failed(
                "{\"reason\":\"fixture-object-required\"}".into(),
            );
        };
        self.calls += 1;
        if let Some(observer) = value
            .get("cancelObserver")
            .and_then(serde_json::Value::as_str)
        {
            use std::{
                fs::OpenOptions,
                io::Write,
                path::Path,
                time::{Duration, Instant},
            };
            // This fixture's sole optional side effect is an explicitly supplied
            // synthetic observation, created without replacing any prior file.
            if !Path::new(observer).is_absolute() {
                return NativeCapabilityOutput::Failed(
                    "{\"reason\":\"absolute-observer-required\"}".into(),
                );
            }
            let observation = (|| -> std::io::Result<()> {
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(observer)?;
                file.write_all(
                    serde_json::json!({"phase":"entered","workerPid":std::process::id()})
                        .to_string()
                        .as_bytes(),
                )?;
                file.flush()
            })();
            if observation.is_err() {
                return NativeCapabilityOutput::Failed(
                    "{\"reason\":\"observer-unavailable\"}".into(),
                );
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while !metadata.cancellation.is_cancelled() {
                if Instant::now() >= deadline {
                    return NativeCapabilityOutput::Failed(
                        "{\"reason\":\"cancel-not-observed\"}".into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            return NativeCapabilityOutput::Unknown("{\"reason\":\"cancelled-fixture\"}".into());
        }
        // These are actual observations made by this child, not caller claims.
        value.insert("workerPid".into(), serde_json::json!(std::process::id()));
        value.insert("invocationCount".into(), serde_json::json!(self.calls));
        NativeCapabilityOutput::Succeeded(serde_json::Value::Object(value).to_string())
    }
}
fn main() {
    if let Err(error) = serve_native_component(Reference::default()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
