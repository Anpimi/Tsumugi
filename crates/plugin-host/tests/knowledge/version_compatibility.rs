#![cfg(all(unix, feature = "javascript-conformance"))]

#[path = "../support/official.rs"]
mod official;
#[path = "../support/owned_temporary.rs"]
mod owned_temporary;
#[path = "../support/runtime.rs"]
mod runtime_fixture;

use official::contract;
use owned_temporary::OwnedTemporary;
use std::{cell::Cell, path::PathBuf};
use tsumugi_plugin_host::{CapturedRuntime, HostError, PackageImage, catalog::*};
use tsumugi_plugin_sdk as sdk;

fn upgrade(root: &std::path::Path, variant: &str, version: &str) -> PackageImage {
    let source = PathBuf::from(
        std::env::var_os(format!("TSUMUGI_TEST_{}_PACKAGE", variant.to_uppercase()))
            .expect("explicit controlled upgrade package required"),
    );
    let digest = std::env::var(format!("TSUMUGI_TEST_{}_DIGEST", variant.to_uppercase()))
        .expect("exact controlled upgrade digest required");
    let image = official::installed_from(root, &source, &digest, "philosophy");
    assert_eq!(image.manifest().manifest().plugin.version, version);
    image
}

fn catalog(images: &[&PackageImage]) -> PackageCatalog {
    let mut catalog = PackageCatalog::new();
    for image in images {
        let plugin = image.manifest().manifest().plugin.clone();
        catalog
            .register(
                (*image).clone(),
                PackageApproval {
                    plugin: plugin.clone(),
                    package_digest: image.package_digest().into(),
                    origin: PackageOrigin {
                        source_id: "explicit-official-test".into(),
                        publisher_id: "reviewed-public-source".into(),
                    },
                },
            )
            .unwrap();
        catalog.set_enabled(&plugin, true).unwrap();
    }
    catalog
}

fn choice(image: &PackageImage) -> sdk::ProviderKey {
    sdk::ProviderKey {
        plugin: image.manifest().manifest().plugin.clone(),
        contribution_id: "query".into(),
    }
}

async fn query(image: &PackageImage, staging: &std::path::Path, text: &str) -> serde_json::Value {
    let tool = image.capability_tool("agent-query-tool").unwrap();
    let mut input = tool
        .declaration
        .query
        .as_ref()
        .unwrap()
        .input_template
        .clone();
    input["queries"][0]["text"] = text.into();
    input["queries"][0]["conceptIds"] = serde_json::json!(["soundness"]);
    let mut session = official::launch(image, "query", staging).await;
    // Valid JSON and positive version numbers still cannot cross the actual
    // captured channel's independent capability/profile/data identities.
    for axis in ["contract", "profile", "input", "output"] {
        let mut wrong = official::request_for(&session, &tool.capability, axis, &input);
        match axis {
            "contract" => wrong.capability.behavior_version += 1,
            "profile" => wrong.profile.as_mut().unwrap().behavior_version += 1,
            "input" => wrong.input.schema.schema_version += 1,
            "output" => wrong.output_schema.schema_version += 1,
            _ => unreachable!(),
        }
        wrong.validate().unwrap();
        assert_eq!(
            session.invoke(&wrong, || false, || true).await.unwrap_err(),
            HostError::RequestMismatch
        );
        assert!(session.is_accepting());
    }
    let output = official::success_payload(
        official::invoke(
            &mut session,
            &tool.capability,
            "exact-compatible-query",
            &input,
        )
        .await,
    );
    assert_eq!(output.schema, tool.capability.declaration.output_schema);
    let output: serde_json::Value = serde_json::from_str(&output.utf8).unwrap();
    assert_eq!(output["basis"]["resource"], input["resource"]);
    assert_eq!(
        output["basis"]["querySha256"],
        sdk::payload_digest(&input.to_string())
    );
    assert!(output["basis"]["coverage"].is_string());
    assert_eq!(output["results"][0]["id"], input["queries"][0]["id"]);
    assert!(output["results"][0]["entries"].is_array());
    for entry in output["results"][0]["entries"].as_array().unwrap() {
        assert!(entry["conceptId"].is_string());
        assert!(entry["preferredTarget"].is_string());
        assert!(entry["note"].is_string());
    }
    official::close_and_reap(&mut session).await;
    output
}

#[test]
fn actual_query_behavior_upgrade_keeps_types_but_requires_its_own_contract() {
    let original_root = OwnedTemporary::new();
    let upgrade_root = OwnedTemporary::new();
    let staging = OwnedTemporary::new();
    let original = official::installed(original_root.path(), "philosophy");
    let upgraded = upgrade(upgrade_root.path(), "behavior", "0.1.0-alpha.2");
    let old = original.capability_tool("agent-query-tool").unwrap();
    let new = upgraded.capability_tool("agent-query-tool").unwrap();
    assert_eq!(old.capability.declaration.contract.behavior_version, 1);
    assert_eq!(new.capability.declaration.contract.behavior_version, 2);
    assert_eq!(old.capability.declaration.contract.schema_version, 1);
    assert_eq!(new.capability.declaration.contract.schema_version, 1);
    assert_eq!(
        old.capability.declaration.input_schema,
        new.capability.declaration.input_schema
    );
    assert_eq!(
        old.capability.declaration.output_schema,
        new.capability.declaration.output_schema
    );
    assert_eq!(old.declaration.profile, new.declaration.profile);
    assert_eq!(old.declaration.query, new.declaration.query);
    for images in [[&original, &upgraded], [&upgraded, &original]] {
        let catalog = catalog(&images);
        for (current, other, binding) in
            [(&original, &upgraded, &old), (&upgraded, &original, &new)]
        {
            let selected = catalog
                .resolve(
                    &binding.capability.declaration.contract,
                    binding.declaration.profile.as_ref(),
                    sdk::ProviderSelection::Single,
                    &[],
                )
                .unwrap();
            assert_eq!(selected.len(), 1);
            assert_eq!(
                selected[0].binding().provider.plugin,
                choice(current).plugin
            );
            assert_eq!(
                catalog
                    .resolve(
                        &binding.capability.declaration.contract,
                        binding.declaration.profile.as_ref(),
                        sdk::ProviderSelection::Single,
                        &[choice(other)]
                    )
                    .unwrap_err(),
                CatalogError::NoCompatibleProvider
            );
        }
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            // Independent literal oracle: v1 uses Unicode word boundaries;
            // the controlled v2 intentionally uses case-sensitive substrings.
            let before = query(&original, staging.path(), "👩🏽‍💻 é soundtrack").await;
            let after = query(&upgraded, staging.path(), "👩🏽‍💻 é soundtrack").await;
            assert_eq!(before["results"][0]["entries"], serde_json::json!([]));
            assert_eq!(after["results"][0]["entries"].as_array().unwrap().len(), 1);
            assert_eq!(after["results"][0]["entries"][0]["conceptId"], "soundness");
            assert_eq!(
                after["results"][0]["entries"][0]["preferredTarget"],
                "可靠性"
            );
            assert_ne!(before["basis"]["coverage"], after["basis"]["coverage"]);
        });
}

#[test]
fn actual_profile_and_combined_schema_upgrades_do_not_follow_package_semver() {
    let original_root = OwnedTemporary::new();
    let profile_root = OwnedTemporary::new();
    let schema_root = OwnedTemporary::new();
    let staging = OwnedTemporary::new();
    let original = official::installed(original_root.path(), "philosophy");
    let profile = upgrade(profile_root.path(), "profile", "0.1.0-alpha.3");
    let schema = upgrade(schema_root.path(), "schema", "0.1.0-alpha.4");
    let original_tool = original.capability_tool("agent-query-tool").unwrap();
    let profile_tool = profile.capability_tool("agent-query-tool").unwrap();
    let schema_tool = schema.capability_tool("agent-query-tool").unwrap();
    assert_eq!(
        profile_tool.capability.declaration.contract,
        original_tool.capability.declaration.contract
    );
    assert_eq!(
        profile_tool.capability.declaration.input_schema,
        original_tool.capability.declaration.input_schema
    );
    assert_eq!(
        profile_tool
            .declaration
            .profile
            .as_ref()
            .unwrap()
            .behavior_version,
        2
    );
    assert_eq!(
        schema_tool.declaration.profile,
        original_tool.declaration.profile
    );
    assert_eq!(
        schema_tool.capability.declaration.contract.behavior_version,
        1
    );
    assert_eq!(
        schema_tool.capability.declaration.contract.schema_version,
        2
    );
    assert_eq!(
        schema_tool
            .capability
            .declaration
            .input_schema
            .schema_version,
        2
    );
    assert_eq!(
        schema_tool
            .capability
            .declaration
            .output_schema
            .schema_version,
        2
    );
    let resource = contract("org.tsumugi.examples.terminology-resource");
    assert_eq!(
        original.resource_bytes("terminology", &resource).unwrap(),
        profile.resource_bytes("terminology", &resource).unwrap()
    );
    assert_eq!(
        schema.resource_bytes("terminology", &resource),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        original.resource_bytes("terminology", &resource).unwrap(),
        schema
            .resource_bytes(
                "terminology",
                &sdk::ContractRef {
                    schema_version: 2,
                    ..resource
                }
            )
            .unwrap()
    );
    for images in [
        [&original, &profile, &schema],
        [&schema, &profile, &original],
    ] {
        let catalog = catalog(&images);
        for (image, binding) in [
            (&original, &original_tool),
            (&profile, &profile_tool),
            (&schema, &schema_tool),
        ] {
            let selected = catalog
                .resolve(
                    &binding.capability.declaration.contract,
                    binding.declaration.profile.as_ref(),
                    sdk::ProviderSelection::Single,
                    &[],
                )
                .unwrap();
            assert_eq!(selected.len(), 1);
            assert_eq!(selected[0].binding().provider.plugin, choice(image).plugin);
        }
        for image in [&profile, &schema] {
            assert_eq!(
                catalog
                    .resolve(
                        &original_tool.capability.declaration.contract,
                        original_tool.declaration.profile.as_ref(),
                        sdk::ProviderSelection::Single,
                        &[choice(image)]
                    )
                    .unwrap_err(),
                CatalogError::NoCompatibleProvider
            );
        }
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for image in [&original, &profile, &schema] {
                let output = query(image, staging.path(), "👩🏽‍💻 é sound premises").await;
                assert_eq!(output["results"][0]["entries"].as_array().unwrap().len(), 1);
                assert_eq!(
                    output["results"][0]["entries"][0]["preferredTarget"],
                    "可靠性"
                );
            }
        });
}

#[test]
fn actual_resource_schema_upgrade_keeps_query_contract_and_requires_exact_resource_identity() {
    let original_root = OwnedTemporary::new();
    let data_root = OwnedTemporary::new();
    let staging = OwnedTemporary::new();
    let original = official::installed(original_root.path(), "philosophy");
    let data = upgrade(data_root.path(), "data", "0.1.0-alpha.5");
    let old = original.capability_tool("agent-query-tool").unwrap();
    let new = data.capability_tool("agent-query-tool").unwrap();
    assert_eq!(
        old.capability.declaration.contract,
        contract("org.tsumugi.examples.philosophy-query")
    );
    assert_eq!(
        old.declaration.profile,
        Some(contract("org.tsumugi.examples.philosophy-terminology"))
    );
    assert_eq!(new.capability.declaration, old.capability.declaration);
    assert_eq!(new.declaration, old.declaration);

    let old_resource = contract("org.tsumugi.examples.terminology-resource");
    let new_resource = sdk::ContractRef {
        schema_version: 2,
        ..old_resource.clone()
    };
    assert_eq!(old.resources.len(), 1);
    assert_eq!(new.resources.len(), 1);
    assert_eq!(old.resources[0].contribution_id, "terminology");
    assert_eq!(new.resources[0].contribution_id, "terminology");
    assert_eq!(old.resources[0].schema, old_resource);
    assert_eq!(new.resources[0].schema, new_resource);

    // Apart from the fixture label, the Resource schema is the only manifest
    // change. Query contract, Profile, input/output/error schemas, permissions,
    // effects, component declarations and every other contribution stay exact.
    let mut normalized = data.manifest().manifest().clone();
    normalized.plugin.version = original.manifest().manifest().plugin.version.clone();
    let resource = normalized
        .contributions
        .iter_mut()
        .find(|contribution| contribution.id == "terminology")
        .unwrap();
    let sdk::ContributionKind::Resource { schema, .. } = &mut resource.contribution else {
        panic!("terminology must remain a Resource");
    };
    assert_eq!(*schema, new_resource);
    *schema = old_resource.clone();
    assert_eq!(&normalized, original.manifest().manifest());

    let expected = r#"{
  "id": "org.tsumugi.examples.philosophy-terminology",
  "revision": "editorial-1",
  "sourceLanguage": "en",
  "authority": "unadopted-editorial-suggestion",
  "license": "MIT",
  "coverage": "This example defines its own editorial preferences for logic prose. It is not an authoritative philosophical dictionary. Explicit concept selection and human review are required.",
  "concepts": [
    {
      "id": "validity",
      "sourceForms": ["validity", "valid"],
      "note": "Use this entry when discussing an argument's validity; do not infer the intended sense from the spelling alone.",
      "targets": { "zh-CN": "有效性", "ja": "妥当性" }
    },
    {
      "id": "soundness",
      "sourceForms": ["soundness", "sound"],
      "note": "Use this entry for the selected logic sense of soundness, not sound as audio or a condition of health.",
      "targets": { "zh-CN": "可靠性", "ja": "健全性" }
    },
    {
      "id": "premise",
      "sourceForms": ["premise", "premises"],
      "note": "This project's preferred term applies to the selected argument context.",
      "targets": { "zh-CN": "前提", "ja": "前提" }
    },
    {
      "id": "inference",
      "sourceForms": ["inference", "infer"],
      "note": "Use the preferred term only within the explicitly selected reasoning context.",
      "targets": { "zh-CN": "推理", "ja": "推論" }
    }
  ]
}
"#
    .as_bytes();
    assert_eq!(
        original
            .resource_bytes("terminology", &old_resource)
            .unwrap(),
        expected
    );
    assert_eq!(
        data.resource_bytes("terminology", &old_resource),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        original.resource_bytes("terminology", &new_resource),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        data.resource_bytes("terminology", &new_resource).unwrap(),
        expected
    );

    // Resource reading and tool binding do not launch a worker. Matching query
    // declarations leave both package versions eligible, so SemVer cannot
    // choose one or grant execution on the caller's behalf.
    for images in [[&original, &data], [&data, &original]] {
        let catalog = catalog(&images);
        assert_eq!(
            catalog
                .resolve(
                    &old.capability.declaration.contract,
                    old.declaration.profile.as_ref(),
                    sdk::ProviderSelection::Single,
                    &[],
                )
                .unwrap_err(),
            CatalogError::AmbiguousProvider
        );
        for (image, binding) in [(&original, &old), (&data, &new)] {
            let selected = catalog
                .resolve(
                    &binding.capability.declaration.contract,
                    binding.declaration.profile.as_ref(),
                    sdk::ProviderSelection::Single,
                    &[choice(image)],
                )
                .unwrap();
            assert_eq!(selected.len(), 1);
            assert_eq!(selected[0].binding(), &binding.capability);
        }
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let before = query(&original, staging.path(), "👩🏽‍💻 é sound premises").await;
            let after = query(&data, staging.path(), "👩🏽‍💻 é sound premises").await;
            assert_eq!(before, after);
            assert_eq!(
                after["results"][0]["entries"],
                serde_json::json!([{
                    "conceptId": "soundness",
                    "preferredTarget": "可靠性",
                    "note": "Use this entry for the selected logic sense of soundness, not sound as audio or a condition of health."
                }])
            );
            assert_eq!(after["basis"]["resource"]["id"], "org.tsumugi.examples.philosophy-terminology");
            assert_eq!(after["basis"]["resource"]["revision"], "editorial-1");
            assert_eq!(
                after["basis"]["resource"]["sha256"],
                sdk::payload_digest(std::str::from_utf8(expected).unwrap())
            );
            assert_eq!(after["basis"]["sourceLanguage"], "en");
            assert_eq!(after["basis"]["targetLanguage"], "zh-CN");
            assert_eq!(after["basis"]["authority"], "unadopted-editorial-suggestion");
            assert_eq!(
                after["basis"]["coverage"],
                "explicit-concepts; case-sensitive Unicode word boundaries in English; literal preferred target forms"
            );
            for image in [&original, &data] {
                let output = query(image, staging.path(), "👩🏽‍💻 é soundtrack").await;
                assert_eq!(output["results"][0]["entries"], serde_json::json!([]));
            }
        });
}

#[test]
fn captured_runtime_diagnoses_sdk_and_process_versions_independently_of_payload_types() {
    let runtime = runtime_fixture::approved_runtime();
    let descriptor = runtime.descriptor();
    assert_eq!(descriptor.sdk_version, sdk::SDK_VERSION);
    assert_eq!(descriptor.process_protocol, sdk::PROCESS_PROTOCOL);
    let tool = PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").unwrap());
    let host = PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").unwrap());
    for axis in ["sdk", "process"] {
        let mut unsupported = descriptor.clone();
        match axis {
            "sdk" => unsupported.sdk_version = "0.1.0-alpha.2".into(),
            "process" => unsupported.process_protocol = 1,
            _ => unreachable!(),
        }
        // A structurally valid description is not a compatible runtime.
        let decoded: sdk::RuntimeEnvironmentDescriptor =
            serde_json::from_slice(&serde_json::to_vec(&unsupported).unwrap()).unwrap();
        let error = decoded.validate().unwrap_err();
        assert_eq!(error.code, sdk::ContractErrorCode::UnsupportedProtocol);
        assert_eq!(error.field, "environment.protocol");
        let read_guard_called = Cell::new(false);
        assert_eq!(
            CapturedRuntime::capture_directories(&tool, &host, &decoded, || {
                read_guard_called.set(true);
                true
            })
            .unwrap_err(),
            HostError::InvalidContract
        );
        assert!(!read_guard_called.get());
    }
    assert_eq!(descriptor.sdk_version, sdk::SDK_VERSION);
    assert_eq!(descriptor.process_protocol, 3);
}
