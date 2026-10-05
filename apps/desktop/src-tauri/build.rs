#[allow(dead_code)]
mod runtime_bundle;

fn prepare_metadata() -> Result<(), Box<dyn std::error::Error>> {
    use std::{env, path::PathBuf};
    use tsumugi_plugin_host::{CapturedRuntime, RuntimeInspectionRequest};
    use tsumugi_plugin_sdk as sdk;
    println!("cargo:rerun-if-changed=runtime_bundle.rs");
    println!(
        "cargo:rerun-if-changed=../../../runtimes/javascript-host/scripts/node-distribution.macos-aarch64.json"
    );
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_BUNDLED_RUNTIME");
    let metadata = if env::var_os("CARGO_FEATURE_BUNDLED_RUNTIME").is_some() {
        if env::var("TARGET")? != "aarch64-apple-darwin"
            || env::var("HOST")? != "aarch64-apple-darwin"
        {
            return Err(
                "bundled runtime requires an aarch64-apple-darwin target and builder".into(),
            );
        }
        let root =
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("manifest directory missing")?)
                .join("resources/javascript-runtime");
        println!("cargo:rerun-if-changed=resources/javascript-runtime");
        let pin = runtime_bundle::node_pin()?;
        let observed = CapturedRuntime::inspect_directories(
            &root.join("tool"),
            &root.join("host"),
            &RuntimeInspectionRequest {
                profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
                tool_version: pin.version.clone(),
                tool_entrypoint: "bin/node".into(),
                host_entrypoint: "dist/main.js".into(),
            },
            || true,
        )?;
        // The independent complete tool pin includes the binary, license and
        // executable flags. Selected inspection JSON never approves itself.
        if !runtime_bundle::supported_tool(&observed.environment, &pin) {
            return Err("prepared tool differs from source-owned Node artifact pin".into());
        }
        let metadata = runtime_bundle::BundledRuntimeMetadata {
            format_version: 1,
            id: runtime_bundle::BUNDLE_ID.into(),
            environment: observed.environment,
            origin: runtime_bundle::bundled_origin(),
            minimum_system_version: pin.minimum_system_version,
            file_count: observed.file_count,
            byte_count: observed.byte_count,
        };
        metadata.validate()?;
        Some(serde_json::to_string(&metadata)?)
    } else {
        None
    };
    let output = PathBuf::from(env::var_os("OUT_DIR").ok_or("build output missing")?)
        .join("bundled-runtime.rs");
    let value = metadata.map_or("None".into(), |json| format!("Some({json:?})"));
    std::fs::write(
        output,
        format!("pub const BUILT_RUNTIME: Option<&str> = {value};\n"),
    )?;
    Ok(())
}

fn main() {
    prepare_metadata().expect("could not verify prepared runtime bundle");
    tauri_build::build()
}
