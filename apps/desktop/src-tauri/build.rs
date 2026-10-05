#[allow(dead_code)]
mod plugin_bundle;
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

fn prepare_plugin_metadata() -> Result<(), Box<dyn std::error::Error>> {
    use std::{env, path::PathBuf};
    use tsumugi_plugin_host::PackageImage;
    println!("cargo:rerun-if-changed=plugin_bundle.rs");
    println!("cargo:rerun-if-changed=bundled-plugins.macos-aarch64.json");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_BUNDLED_PLUGINS");
    let metadata = if env::var_os("CARGO_FEATURE_BUNDLED_PLUGINS").is_some() {
        if env::var("TARGET")? != "aarch64-apple-darwin"
            || env::var("HOST")? != "aarch64-apple-darwin"
        {
            return Err(
                "bundled plugin distribution requires its selected platform builder".into(),
            );
        }
        let selection = plugin_bundle::selection()?;
        let root =
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("manifest directory missing")?)
                .join("resources/bundled-plugins");
        println!("cargo:rerun-if-changed=resources/bundled-plugins");
        let mut packages = Vec::new();
        for pin in selection.packages {
            let directory = root.join(&pin.id);
            let image = PackageImage::capture_directory(&directory, &pin.package_digest, || true)?;
            if image.manifest().manifest().plugin != pin.plugin {
                return Err("prepared plugin identity differs from source-owned pin".into());
            }
            let observed = PackageImage::inspect_directory(&directory, || true)?;
            if observed.package_digest != pin.package_digest {
                return Err("prepared plugin changed during verification".into());
            }
            packages.push(plugin_bundle::PackageMetadata {
                pin,
                manifest_sha256: observed.manifest_sha256,
                file_count: observed.file_count,
                byte_count: observed.byte_count,
            });
        }
        let metadata = plugin_bundle::BundleMetadata {
            format_version: 1,
            platform: selection.platform,
            packages,
        };
        metadata.validate()?;
        Some(serde_json::to_string(&metadata)?)
    } else {
        None
    };
    let output = PathBuf::from(env::var_os("OUT_DIR").ok_or("build output missing")?)
        .join("bundled-plugins.rs");
    let value = metadata.map_or("None".into(), |json| format!("Some({json:?})"));
    std::fs::write(
        output,
        format!("pub const BUILT_PLUGINS: Option<&str> = {value};\n"),
    )?;
    Ok(())
}

fn main() {
    prepare_metadata().expect("could not verify prepared runtime bundle");
    prepare_plugin_metadata().expect("could not verify prepared plugin bundle");
    tauri_build::build()
}
