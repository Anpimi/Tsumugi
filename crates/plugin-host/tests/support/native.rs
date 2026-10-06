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
        .expect("build the public native-worker example and supply its exact path");
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
