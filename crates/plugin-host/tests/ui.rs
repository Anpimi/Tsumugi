use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn manifest() -> sdk::PluginManifest {
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/tool.manifest.json"
    ))
    .unwrap();
    manifest.contributions[3].component_id = "worker".into();
    manifest.contributions.push(sdk::ContributionDeclaration {
        id: "query-panel".into(),
        component_id: "worker".into(),
        contribution: sdk::ContributionKind::Ui {
            slot: "reference-query".into(),
            schema: sdk::tool_declaration_contract(),
        },
    });
    manifest
}

fn files() -> BTreeMap<String, PackageFile> {
    [
        (
            "component.mjs",
            b"throw new Error('a UI read must not execute');".as_slice(),
        ),
        (
            "tool.json",
            include_bytes!("../../plugin-sdk/tests/fixtures/tool.query.json").as_slice(),
        ),
        ("terms.bin", &[0, 255, 1]),
        (
            "guidance.md",
            b"Untrusted guidance grants no tools.".as_slice(),
        ),
    ]
    .into_iter()
    .map(|(path, bytes)| {
        (
            path.into(),
            PackageFile {
                bytes: bytes.to_vec(),
                executable: false,
            },
        )
    })
    .collect()
}

fn capture(manifest: sdk::PluginManifest, files: BTreeMap<String, PackageFile>) -> PackageImage {
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}

#[test]
fn reference_query_ui_binds_the_unique_same_component_resource_without_execution() {
    let image = capture(manifest(), files());
    let selected = image.reference_query_ui("query-panel").unwrap();
    assert_eq!(selected.component_id, "worker");
    assert_eq!(selected.ui_id, "query-panel");
    assert_eq!(selected.slot, "reference-query");
    assert_eq!(selected.resource_id, "query-tool");
    assert_eq!(
        selected.binding,
        image.capability_tool("query-tool").unwrap()
    );
    assert_eq!(
        selected.binding.capability.provider.package_digest,
        image.package_digest()
    );
    assert!(selected.binding.declaration.query.is_some());
    for id in ["missing", "query", "query-tool"] {
        assert_eq!(
            image.reference_query_ui(id),
            Err(HostError::InvalidContract)
        );
    }
}

#[test]
fn reference_query_ui_refuses_ambiguous_missing_foreign_and_unsupported_declarations() {
    for scenario in 0..9 {
        let mut manifest = manifest();
        match scenario {
            0 => manifest
                .contributions
                .retain(|value| value.id != "query-tool"),
            1 => {
                let mut duplicate = manifest.contributions[3].clone();
                duplicate.id = "second-query-tool".into();
                manifest.contributions.push(duplicate);
            }
            2 => manifest.contributions[3].component_id = "reference".into(),
            3 | 4 => {
                let sdk::ContributionKind::Ui { schema, .. } =
                    &mut manifest.contributions[4].contribution
                else {
                    unreachable!()
                };
                if scenario == 3 {
                    schema.schema_version += 1;
                } else {
                    schema.behavior_version += 1;
                }
            }
            5 => {
                let sdk::ContributionKind::Ui { slot, .. } =
                    &mut manifest.contributions[4].contribution
                else {
                    unreachable!()
                };
                *slot = "arbitrary-dom".into();
            }
            6 => {
                let mut duplicate = manifest.contributions[4].clone();
                duplicate.id = "duplicate-panel".into();
                manifest.contributions.push(duplicate);
            }
            7 => {
                let sdk::ContributionKind::Resource { schema, .. } =
                    &mut manifest.contributions[3].contribution
                else {
                    unreachable!()
                };
                schema.behavior_version += 1;
            }
            _ => {
                let mut other = manifest.components[0].clone();
                other.id = "other-worker".into();
                manifest.components.push(other);
                manifest.contributions[0].component_id = "other-worker".into();
            }
        }
        assert_eq!(
            capture(manifest, files()).reference_query_ui("query-panel"),
            Err(HostError::InvalidContract),
            "scenario {scenario}"
        );
    }
}

#[test]
fn reference_query_ui_reuses_strict_tool_payload_validation_and_requires_a_query() {
    for scenario in 0..4 {
        let mut files = files();
        match scenario {
            0 => {
                files.get_mut("tool.json").unwrap().bytes =
                    include_bytes!("../../plugin-sdk/tests/fixtures/tool.declaration.json").to_vec()
            }
            1 => files.get_mut("tool.json").unwrap().executable = true,
            2 => files.get_mut("tool.json").unwrap().bytes = b"{\"grant\":true}".to_vec(),
            _ => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&files["tool.json"].bytes).unwrap();
                value["query"]["inputSchema"]["behaviorVersion"] = 2.into();
                files.get_mut("tool.json").unwrap().bytes = serde_json::to_vec(&value).unwrap();
            }
        }
        assert_eq!(
            capture(manifest(), files).reference_query_ui("query-panel"),
            Err(HostError::InvalidContract),
            "scenario {scenario}"
        );
    }
}

#[test]
fn reference_query_ui_keeps_equal_names_in_separate_package_bindings() {
    let original = capture(manifest(), files());
    let selected = original.reference_query_ui("query-panel").unwrap();
    let mut other_manifest = manifest();
    other_manifest.plugin.publisher = "another-publisher".into();
    let other = capture(other_manifest, files());
    let other_selected = other.reference_query_ui("query-panel").unwrap();
    assert_eq!(selected.ui_id, other_selected.ui_id);
    assert_ne!(
        selected.binding.capability.provider,
        other_selected.binding.capability.provider
    );
    assert_eq!(
        original.reference_query_ui("query-panel").unwrap(),
        selected
    );
}
