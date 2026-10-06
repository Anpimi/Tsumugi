use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;
fn image(
    mutator: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
) -> PackageImage {
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/source-import.manifest.json"
    ))
    .unwrap();
    let mut files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('metadata capture must not execute this');".to_vec(),
                executable: false,
            },
        ),
        (
            "source-profile.json".into(),
            PackageFile {
                bytes: include_bytes!(
                    "../../plugin-sdk/tests/fixtures/source-import.declaration.json"
                )
                .to_vec(),
                executable: false,
            },
        ),
    ]);
    files.insert(
        "review-profile.json".into(),
        PackageFile {
            bytes: include_bytes!("../../plugin-sdk/tests/fixtures/source-import.review.json")
                .to_vec(),
            executable: false,
        },
    );
    mutator(&mut manifest, &mut files);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}
#[test]
fn source_import_resource_resolves_exact_captured_bytes_and_providers() {
    let captured = image(|_, _| {});
    let binding = captured.source_import("source-profile").unwrap();
    assert_eq!(
        binding.extractor.provider.package_digest,
        captured.package_digest()
    );
    assert_eq!(
        binding.checker.provider.package_digest,
        captured.package_digest()
    );
    assert_eq!(
        binding.review.checker.provider.package_digest,
        captured.package_digest()
    );
    assert_eq!(binding.declaration.review_resource, "review-profile");
    assert_eq!(
        binding.declaration.materials[0].logical_path,
        "materials/raw.txt"
    );
    assert_eq!(
        captured.source_import("missing"),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        captured.source_import("extract"),
        Err(HostError::InvalidContract)
    );
}

#[test]
fn source_import_reads_only_the_referenced_immutable_review_resource() {
    for scenario in 0..4 {
        let captured = image(|_, files| {
            let file = files
                .get_mut(if scenario == 0 {
                    "source-profile.json"
                } else {
                    "review-profile.json"
                })
                .unwrap();
            if scenario == 3 {
                file.executable = true;
                return;
            }
            let mut value: serde_json::Value = serde_json::from_slice(&file.bytes).unwrap();
            match scenario {
                0 => value["reviewResource"] = serde_json::json!("extract"),
                1 => value["profile"]["behaviorVersion"] = serde_json::json!(2),
                _ => value["rules"] = serde_json::json!([]),
            }
            file.bytes = serde_json::to_vec(&value).unwrap();
        });
        assert_eq!(
            captured.source_import("source-profile"),
            Err(HostError::InvalidContract)
        );
    }
}
#[test]
fn source_import_resource_refuses_wrong_schema_executable_bytes_and_changed_policy() {
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
            1 => files.get_mut("source-profile.json").unwrap().executable = true,
            _ => {
                let file = files.get_mut("source-profile.json").unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&file.bytes).unwrap();
                value["checker"] = serde_json::json!("extract");
                file.bytes = serde_json::to_vec(&value).unwrap();
            }
        });
        assert_eq!(
            captured.source_import("source-profile"),
            Err(HostError::InvalidContract)
        );
    }
}
