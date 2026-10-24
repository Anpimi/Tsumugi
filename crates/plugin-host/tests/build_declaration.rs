use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn image(
    mutator: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
) -> PackageImage {
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/build.manifest.json"
    ))
    .unwrap();
    let mut files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('resource inspection must not execute this');".to_vec(),
                executable: false,
            },
        ),
        (
            "build-profile.json".into(),
            PackageFile {
                bytes: include_bytes!("../../plugin-sdk/tests/fixtures/build.declaration.json")
                    .to_vec(),
                executable: false,
            },
        ),
    ]);
    mutator(&mut manifest, &mut files);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}
#[test]
fn build_resource_reads_only_exact_captured_bytes_and_both_provider_owners() {
    let captured = image(|_, _| {});
    let binding = captured.build_declaration("build-profile").unwrap();
    assert_eq!(
        binding.builder.provider.package_digest,
        captured.package_digest()
    );
    assert_eq!(
        binding.checker.provider.package_digest,
        captured.package_digest()
    );
    assert_eq!(binding.declaration.output_limits.max_total_bytes, 131072);
    assert_eq!(
        captured.build_declaration("missing"),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        captured.build_declaration("build"),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        captured.source_import("build-profile"),
        Err(HostError::InvalidContract)
    );
}
#[test]
fn build_resource_refuses_wrong_schema_executable_bytes_and_self_checking() {
    for change in 0..3 {
        let captured = image(|manifest, files| match change {
            0 => {
                let sdk::ContributionKind::Resource { schema, .. } =
                    &mut manifest.contributions[0].contribution
                else {
                    unreachable!()
                };
                schema.behavior_version += 1;
            }
            1 => files.get_mut("build-profile.json").unwrap().executable = true,
            _ => {
                let file = files.get_mut("build-profile.json").unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&file.bytes).unwrap();
                value["checker"] = serde_json::json!("build");
                file.bytes = serde_json::to_vec(&value).unwrap();
            }
        });
        assert_eq!(
            captured.build_declaration("build-profile"),
            Err(HostError::InvalidContract)
        );
    }
}
