use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn image(
    paired: bool,
    mutate: impl FnOnce(&mut sdk::PluginManifest, &mut serde_json::Value),
) -> PackageImage {
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/translation-import.manifest.json"
    ))
    .unwrap();
    let mut declaration: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/translation-import.declaration.json"
    ))
    .unwrap();
    if paired {
        declaration.as_object_mut().unwrap().remove("material");
        declaration["fileSets"] = serde_json::json!([{
            "id":"translated", "displayName":"Translated files", "role":"translation", "encoding":"binary",
            "extensions":["esp"], "minFiles":1, "maxFiles":1, "maxBytes":2097152,
        }]);
        declaration["maxTotalBytes"] = 2097152.into();
        for entry in &mut manifest.contributions {
            match &mut entry.contribution {
                sdk::ContributionKind::Resource { schema, .. } => {
                    *schema = sdk::paired_translation_import_declaration_contract()
                }
                sdk::ContributionKind::Capability { declaration } => {
                    declaration.input_schema.schema_version = 3;
                    if entry.id == "extract" {
                        declaration.output_schema.schema_version = 3;
                    }
                }
                _ => {}
            }
        }
    }
    mutate(&mut manifest, &mut declaration);
    let files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('metadata inspection cannot execute this worker');"
                    .to_vec(),
                executable: false,
            },
        ),
        (
            "translation-profile.json".into(),
            PackageFile {
                bytes: serde_json::to_vec(&declaration).unwrap(),
                executable: false,
            },
        ),
    ]);
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}

#[test]
fn translation_resources_bind_exact_single_or_paired_bytes_without_running_components() {
    for paired in [false, true] {
        let image = image(paired, |_, _| {});
        let binding = image.translation_import("translation-profile").unwrap();
        assert_eq!(binding.declaration.is_paired(), paired);
        assert_eq!(
            binding.extractor.provider.package_digest,
            image.package_digest()
        );
        assert_eq!(
            binding.checker.provider.package_digest,
            image.package_digest()
        );
        assert_eq!(
            binding.extractor.declaration.input_schema.schema_version,
            if paired { 3 } else { 2 }
        );
    }
}

#[test]
fn translation_resource_schema_and_provider_families_cannot_be_substituted() {
    for case in 0..5 {
        let image = image(true, |manifest, declaration| {
            for entry in &mut manifest.contributions {
                match &mut entry.contribution {
                    sdk::ContributionKind::Resource { schema, .. } => match case {
                        0 => schema.schema_version = 1,
                        1 => schema.schema_version = 9,
                        2 => schema.behavior_version = 2,
                        _ => {}
                    },
                    sdk::ContributionKind::Capability { declaration } if case == 3 => {
                        declaration.input_schema.schema_version = 2
                    }
                    _ => {}
                }
            }
            if case == 4 {
                declaration["material"] = serde_json::json!({"logicalDirectory":"i18n","extension":"json","role":"translation","maxBytes":128});
            }
        });
        assert!(
            matches!(
                image.translation_import("translation-profile"),
                Err(HostError::InvalidContract)
            ),
            "case {case}"
        );
    }
}
