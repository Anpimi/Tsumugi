use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn image(
    change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
) -> PackageImage {
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/text-review.manifest.json"
    ))
    .unwrap();
    let mut files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('metadata capture must not execute a component');"
                    .to_vec(),
                executable: false,
            },
        ),
        (
            "review/text.json".into(),
            PackageFile {
                bytes: include_bytes!(
                    "../../plugin-sdk/tests/fixtures/text-review.declaration.json"
                )
                .to_vec(),
                executable: false,
            },
        ),
        (
            "resources/terms.json".into(),
            PackageFile {
                bytes: include_bytes!("../../plugin-sdk/tests/fixtures/text-review.resource.json")
                    .to_vec(),
                executable: false,
            },
        ),
    ]);
    change(&mut manifest, &mut files);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}

fn input(image: &PackageImage) -> sdk::TextReviewCheckInput {
    let mut input = sdk::parse_text_review_input(include_bytes!(
        "../../plugin-sdk/tests/fixtures/text-review.input.json"
    ))
    .unwrap();
    let binding = image
        .text_review_declaration("text-review-profile")
        .unwrap();
    for requirement in &mut input.requirements {
        requirement.key.implementation = sdk::CheckImplementation::Plugin {
            provider: binding.checker.provider.clone(),
        };
    }
    input
}

#[test]
fn text_review_metadata_captures_exact_same_package_resources_without_running_code() {
    let image = image(|_, _| {});
    let binding = image
        .text_review_declaration("text-review-profile")
        .unwrap();
    assert_eq!(
        binding.checker.provider.package_digest,
        image.package_digest()
    );
    assert_eq!(binding.checker.provider.plugin.id, "text-support");
    let input = input(&image);
    assert_eq!(
        image
            .text_review_resource_pins("text-review-profile")
            .unwrap(),
        input.resources
    );
    assert_eq!(
        image
            .validate_text_review_input("text-review-profile", &input)
            .unwrap(),
        binding
    );
    for id in ["missing", "text-review-check", "terms"] {
        assert_eq!(
            image.text_review_declaration(id),
            Err(HostError::InvalidContract)
        );
    }
    assert_eq!(
        image.review_declaration("text-review-profile"),
        Err(HostError::InvalidContract)
    );
}

#[test]
fn text_review_metadata_refuses_wrong_contract_executable_support_and_write_effect() {
    for case in 0..5 {
        let image = image(|manifest, files| match case {
            0 => {
                let entry = manifest
                    .contributions
                    .iter_mut()
                    .find(|entry| entry.id == "text-review-profile")
                    .unwrap();
                let sdk::ContributionKind::Resource { schema, .. } = &mut entry.contribution else {
                    unreachable!()
                };
                schema.behavior_version += 1;
            }
            1 => files.get_mut("review/text.json").unwrap().executable = true,
            2 => files.get_mut("resources/terms.json").unwrap().executable = true,
            3 => {
                let entry = manifest
                    .contributions
                    .iter_mut()
                    .find(|entry| entry.id == "text-review-check")
                    .unwrap();
                let sdk::ContributionKind::Capability { declaration } = &mut entry.contribution
                else {
                    unreachable!()
                };
                declaration.effect = sdk::EffectKind::Proposal;
            }
            _ => {
                let bytes = &mut files.get_mut("review/text.json").unwrap().bytes;
                let mut value: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                value["supportingResources"] = serde_json::json!(["text-review-check"]);
                *bytes = serde_json::to_vec(&value).unwrap();
            }
        });
        assert_eq!(
            image.text_review_declaration("text-review-profile"),
            Err(HostError::InvalidContract),
            "case {case}"
        );
        assert_eq!(
            image.text_review_resource_pins("text-review-profile"),
            Err(HostError::InvalidContract),
            "case {case}"
        );
    }
}

#[test]
fn text_review_input_pin_refuses_claimed_hash_and_prior_package_after_actual_bytes_change() {
    let original = image(|_, _| {});
    let input = input(&original);
    let mut claimed = input.clone();
    claimed.resources[0].sha256 = "a".repeat(64);
    assert_eq!(
        original.validate_text_review_input("text-review-profile", &claimed),
        Err(HostError::InvalidContract)
    );
    let changed = image(|_, files| {
        files
            .get_mut("resources/terms.json")
            .unwrap()
            .bytes
            .push(b' ');
    });
    assert_ne!(original.package_digest(), changed.package_digest());
    assert_eq!(
        changed.validate_text_review_input("text-review-profile", &input),
        Err(HostError::InvalidContract)
    );
    let mut rebound = input.clone();
    let binding = changed
        .text_review_declaration("text-review-profile")
        .unwrap();
    for requirement in &mut rebound.requirements {
        requirement.key.implementation = sdk::CheckImplementation::Plugin {
            provider: binding.checker.provider.clone(),
        };
    }
    assert_eq!(
        changed.validate_text_review_input("text-review-profile", &rebound),
        Err(HostError::InvalidContract)
    );
    rebound.resources = changed
        .text_review_resource_pins("text-review-profile")
        .unwrap();
    changed
        .validate_text_review_input("text-review-profile", &rebound)
        .unwrap();
    original
        .validate_text_review_input("text-review-profile", &input)
        .unwrap();
}
