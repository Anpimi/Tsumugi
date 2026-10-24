//! SDK-only native echo package shared by actual transport/Core tests.
use std::collections::BTreeMap;
use tsumugi_plugin_host::{PackageFile, PackageImage};
use tsumugi_plugin_sdk::*;

pub fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
pub fn package() -> (Vec<u8>, BTreeMap<String, PackageFile>) {
    let worker = std::env::var_os("TSUMUGI_NATIVE_SDK_WORKER")
        .expect("build the requested SDK-client fixture and supply its exact path");
    let manifest = PluginManifest {
        protocol_version: MANIFEST_PROTOCOL,
        plugin: PluginIdentity {
            publisher: "example".into(),
            id: "example.native-sdk".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![PermissionRequest::CapturedInput],
        components: vec![ComponentDeclaration {
            id: "worker".into(),
            scope: ComponentScope::Project,
            runtime: RuntimeKind::NativeWorker,
            entrypoint: Some("bin/worker".into()),
            dependencies: vec![],
            exit: ExitRequirements {
                stop_timeout_ms: 500,
                cleanup_timeout_ms: 1000,
            },
        }],
        contributions: vec![ContributionDeclaration {
            id: "echo".into(),
            component_id: "worker".into(),
            contribution: ContributionKind::Capability {
                declaration: CapabilityDeclaration {
                    contract: contract("example.echo"),
                    input_schema: contract("example.text"),
                    output_schema: contract("example.text"),
                    error_schema: contract("example.error"),
                    profiles: vec![],
                    effect: EffectKind::ReadOnly,
                    permissions: vec![PermissionRequest::CapturedInput],
                    limits: CapabilityLimits {
                        max_input_bytes: 131072,
                        max_output_bytes: 131072,
                        concurrency: 1,
                        timeout_ms: 1000,
                    },
                },
            },
        }],
    };
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([(
        "bin/worker".into(),
        PackageFile {
            bytes: std::fs::read(worker).unwrap(),
            executable: true,
        },
    )]);
    (manifest, files)
}
pub fn image() -> PackageImage {
    let (manifest, files) = package();
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}

/// Synthetic manual Tool around the independently built SDK client binary.
/// Only this in-memory package is Application-scoped; the original native
/// project package and public example remain unchanged.
pub fn application_package() -> (Vec<u8>, BTreeMap<String, PackageFile>) {
    let (manifest, mut files) = package();
    let mut manifest: PluginManifest = serde_json::from_slice(&manifest).unwrap();
    manifest.components[0].scope = ComponentScope::Application;
    let mut declaration: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../plugin-sdk/tests/fixtures/tool.query.json"
    ))
    .unwrap();
    declaration["name"] = serde_json::json!("native_reference");
    declaration["title"] = serde_json::json!("Native reference echo");
    declaration["capabilityId"] = serde_json::json!("echo");
    declaration["profile"] = serde_json::Value::Null;
    declaration["supportingResources"] = serde_json::json!([]);
    declaration["skill"] = serde_json::Value::Null;
    declaration["query"]["inputSchema"] = serde_json::to_value(contract("example.text")).unwrap();
    declaration["query"]["outputSchema"] = serde_json::to_value(contract("example.text")).unwrap();
    // The worker preserves the authorized object and adds its actual PID/counter.
    // Synthetic reference columns make its untrusted output usable through
    // the ordinary query UI.
    declaration["query"]["inputTemplate"]["results"] = serde_json::json!([{
        "entries":[{"value":"Synthetic native reference","note":"原始输入 👩🏽‍💻 é"}]
    }]);
    let bytes = serde_json::to_vec(&declaration).unwrap();
    let parsed = parse_tool_declaration(&bytes).unwrap();
    let validated = parse_manifest(&serde_json::to_vec(&manifest).unwrap()).unwrap();
    parsed.bind(&validated, &"a".repeat(64)).unwrap();
    manifest.contributions.push(ContributionDeclaration {
        id: "echo-tool".into(),
        component_id: "worker".into(),
        contribution: ContributionKind::Resource {
            schema: tool_declaration_contract(),
            path: "tool.json".into(),
        },
    });
    files.insert(
        "tool.json".into(),
        PackageFile {
            bytes,
            executable: false,
        },
    );
    (serde_json::to_vec(&manifest).unwrap(), files)
}

pub fn application_image() -> PackageImage {
    let (manifest, files) = application_package();
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}
