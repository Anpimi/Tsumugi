use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn image(
    mutator: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
) -> PackageImage {
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/review.manifest.json"
    ))
    .unwrap();
    let mut files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('metadata inspection must not execute this');".to_vec(),
                executable: false,
            },
        ),
        (
            "review-profile.json".into(),
            PackageFile {
                bytes: include_bytes!("../../plugin-sdk/tests/fixtures/review.declaration.json")
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
fn review_resource_uses_immutable_bytes_exact_provider_and_third_named_package() {
    let image = image(|_, _| {});
    let binding = image.review_declaration("review-profile").unwrap();
    assert_eq!(
        binding.checker.provider.package_digest,
        image.package_digest()
    );
    assert_eq!(binding.checker.provider.plugin.id, "third-format");
    assert_eq!(binding.checker.provider.contribution_id, "review-check");
    assert_eq!(binding.declaration.rules.len(), 2);
    for id in ["missing", "review-check"] {
        assert_eq!(
            image.review_declaration(id),
            Err(HostError::InvalidContract)
        );
    }
    assert_eq!(
        image.source_import("review-profile"),
        Err(HostError::InvalidContract)
    );
}
#[test]
fn review_resource_refuses_wrong_schema_executable_policy_and_capability_mismatch() {
    for change in 0..5 {
        let image = image(|manifest, files| match change {
            0 => {
                let sdk::ContributionKind::Resource { schema, .. } =
                    &mut manifest.contributions[0].contribution
                else {
                    unreachable!()
                };
                schema.behavior_version += 1;
            }
            1 => files.get_mut("review-profile.json").unwrap().executable = true,
            2 => {
                let file = files.get_mut("review-profile.json").unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&file.bytes).unwrap();
                value["rules"] = serde_json::json!([]);
                file.bytes = serde_json::to_vec(&value).unwrap();
            }
            3 => {
                let sdk::ContributionKind::Capability { declaration } =
                    &mut manifest.contributions[1].contribution
                else {
                    unreachable!()
                };
                declaration.effect = sdk::EffectKind::Proposal;
            }
            _ => {
                let file = files.get_mut("review-profile.json").unwrap();
                file.bytes = br#"{"profile":{"id":"example.plain-text","schemaVersion":1,"behaviorVersion":1},"checker":"other","rules":[]}"#.to_vec();
            }
        });
        assert_eq!(
            image.review_declaration("review-profile"),
            Err(HostError::InvalidContract),
            "case {change}"
        );
    }
}
