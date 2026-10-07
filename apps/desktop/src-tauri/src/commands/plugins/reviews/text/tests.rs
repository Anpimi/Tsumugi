use super::*;
use crate::commands::plugins::environment::test_support::Fixture;
use std::{collections::BTreeMap, fs, sync::Arc};
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    ApprovedPackageSetting, CapturedNativeRuntime, PackageFile, PluginSettingsUpdate,
    RuntimeApproval, catalog::PackageCatalog,
};

fn fixture(native: bool, plugin_id: &str, duplicate_declaration: bool) -> Fixture {
    Fixture::with_resource(
        Arc::new(ApplicationPlugins::default()),
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../crates/plugin-sdk/tests/fixtures/text-review.manifest.json"
        )),
        "review/text.json",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../crates/plugin-sdk/tests/fixtures/text-review.declaration.json"
        )),
        |manifest, files: &mut BTreeMap<String, PackageFile>| {
            manifest.plugin.id = plugin_id.into();
            files.insert(
                "resources/terms.json".into(),
                PackageFile {
                    bytes: include_bytes!(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/../../../crates/plugin-sdk/tests/fixtures/text-review.resource.json"
                    ))
                    .to_vec(),
                    executable: false,
                },
            );
            if native {
                manifest.components[0].runtime = sdk::RuntimeKind::NativeWorker;
                files.get_mut("component.mjs").unwrap().executable = true;
            }
            if duplicate_declaration {
                let mut resource = manifest.contributions[0].clone();
                resource.id = "second-profile".into();
                manifest.contributions.push(resource);
            }
        },
    )
}

fn runtime_approval() -> RuntimeApproval {
    RuntimeApproval {
        environment: CapturedNativeRuntime::inspect_current().unwrap().into(),
        origin: runtimes::native_host_origin(),
    }
}

fn selection(fixture: &Fixture, approval: &RuntimeApproval) -> PluginTextReviewSelection {
    let binding = fixture
        .image
        .text_review_declaration("text-review-profile")
        .unwrap();
    PluginTextReviewSelection {
        package: PluginPackageRequest {
            plugin: fixture.approval.plugin.clone(),
            package_digest: fixture.approval.package_digest.clone(),
        },
        resource_id: "text-review-profile".into(),
        environment_digest: approval.environment.digest().unwrap(),
        rules: vec![binding.declaration.rules[0].rule.clone()],
    }
}

#[test]
fn explicit_subset_captures_real_pins_and_reopens_without_mutating_settings() {
    let fixture = fixture(true, "text-support", true);
    fixture.install();
    let approval = runtime_approval();
    fixture.decide(true, vec![approval.clone()]);
    let mut selected = selection(&fixture, &approval);
    // Identical declarations remain separate exact Resource selectors.
    selected.resource_id = "second-profile".into();
    let before = fs::read(fixture.root().join("settings.json")).unwrap();
    let environment = fixture.owner.capture_text_review(&selected).unwrap();
    assert_eq!(environment.rules, selected.rules);
    assert_eq!(
        environment.resource_pins,
        fixture
            .image
            .text_review_resource_pins("second-profile")
            .unwrap()
    );
    let captured = environment.advisory_check().unwrap();
    assert_eq!(captured.declaration_resource_id, "second-profile");
    assert_eq!(
        fixture
            .owner
            .capture_captured_text_review(&captured)
            .unwrap()
            .advisory_check()
            .unwrap(),
        captured
    );
    let discovered = fixture.owner.text_review_list().unwrap();
    assert_eq!(discovered.entries.len(), 2);
    for entry in discovered.entries {
        let PluginTextReviewAvailability::Ready { view } = entry.availability else {
            panic!("expected ready declaration")
        };
        assert_eq!(view.resource_id, entry.resource_id);
        assert_eq!(view.rules.len(), 2);
        assert_eq!(view.binding.declaration.rules[0].title, "Preferred form");
    }
    assert_eq!(
        fs::read(fixture.root().join("settings.json")).unwrap(),
        before
    );
    // The fixture entrypoint throws if executed; this test only inspects bytes.
}

#[test]
fn selection_rejects_empty_duplicate_unknown_and_different_rule_versions() {
    let fixture = fixture(true, "text-support", false);
    fixture.install();
    let approval = runtime_approval();
    fixture.decide(true, vec![approval.clone()]);
    let valid = selection(&fixture, &approval);
    let mut choices = Vec::new();
    let mut empty = valid.clone();
    empty.rules.clear();
    choices.push(empty);
    let mut duplicate = valid.clone();
    duplicate.rules.push(duplicate.rules[0].clone());
    choices.push(duplicate);
    let mut unknown = valid.clone();
    unknown.rules[0].id = "example.unknown".into();
    choices.push(unknown);
    let mut version = valid.clone();
    version.rules[0].behavior_version += 1;
    choices.push(version);
    let mut resource = valid.clone();
    resource.resource_id = "terms".into();
    choices.push(resource);
    let mut provider = valid.clone();
    provider.package.plugin.id = "another-provider".into();
    choices.push(provider);
    for choice in choices {
        assert!(fixture.owner.capture_text_review(&choice).is_err());
    }
    let captured = fixture
        .owner
        .capture_text_review(&valid)
        .unwrap()
        .advisory_check()
        .unwrap();
    let mut changed_pin = captured.clone();
    changed_pin.resource_pins[0].sha256 = "f".repeat(64);
    assert!(
        fixture
            .owner
            .capture_captured_text_review(&changed_pin)
            .is_err()
    );
    let mut changed_selector = captured;
    changed_selector.declaration_resource_id = "terms".into();
    assert!(
        fixture
            .owner
            .capture_captured_text_review(&changed_selector)
            .is_err()
    );
}

#[test]
fn discovery_retains_missing_environment_and_disabled_exact_choices() {
    let javascript = fixture(false, "text-support", false);
    javascript.install();
    javascript.decide(true, vec![]);
    let list = javascript.owner.text_review_list().unwrap();
    assert_eq!(list.entries.len(), 1);
    assert_eq!(list.entries[0].environment_digest, None);
    let PluginTextReviewAvailability::Unavailable { error } = &list.entries[0].availability else {
        panic!("expected unavailable environment")
    };
    assert_eq!(error.reason.as_deref(), Some("plugin-runtime-missing"));
    let native = fixture(true, "text-support", false);
    native.install();
    let approval = runtime_approval();
    native.decide(true, vec![approval.clone()]);
    let selected = selection(&native, &approval);
    let captured = native
        .owner
        .capture_text_review(&selected)
        .unwrap()
        .advisory_check()
        .unwrap();
    native.decide(false, vec![approval.clone()]);
    let list = native.owner.text_review_list().unwrap();
    assert_eq!(list.entries.len(), 1);
    assert_eq!(
        list.entries[0].environment_digest.as_deref(),
        Some(selected.environment_digest.as_str())
    );
    let PluginTextReviewAvailability::Unavailable { error } = &list.entries[0].availability else {
        panic!("disabled declaration must remain unavailable")
    };
    assert_eq!(error.reason.as_deref(), Some("plugin-disabled"));
    assert!(
        native
            .owner
            .capture_captured_text_review(&captured)
            .is_err()
    );
    native.decide(true, vec![]);
    assert!(
        native
            .owner
            .capture_captured_text_review(&captured)
            .is_err()
    );
}

#[test]
fn same_rule_and_profile_from_distinct_providers_are_not_folded() {
    let first = fixture(true, "first-text-support", false);
    let second = fixture(true, "second-text-support", false);
    first.install();
    let mut catalog = PackageCatalog::new();
    catalog
        .register(second.image.clone(), second.approval.clone())
        .unwrap();
    let approval = runtime_approval();
    {
        let mut manager = first.owner.try_manager().unwrap();
        first.owner.provision(&mut manager).unwrap();
        let store = manager.store.as_mut().unwrap();
        store
            .install(
                &ExecutionId::new().to_string(),
                catalog.registered(&second.approval.plugin).unwrap(),
                || true,
            )
            .unwrap();
        let settings = store.settings(|| true).unwrap();
        store
            .update_settings(
                settings.revision(),
                &ExecutionId::new().to_string(),
                &PluginSettingsUpdate {
                    packages: vec![
                        ApprovedPackageSetting {
                            approval: first.approval.clone(),
                            enabled: true,
                        },
                        ApprovedPackageSetting {
                            approval: second.approval.clone(),
                            enabled: true,
                        },
                    ],
                    runtimes: vec![approval.clone()],
                },
                || true,
            )
            .unwrap();
    }
    let list = first.owner.text_review_list().unwrap();
    assert_eq!(list.entries.len(), 2);
    let views: Vec<_> = list
        .entries
        .into_iter()
        .map(|entry| match entry.availability {
            PluginTextReviewAvailability::Ready { view } => view,
            _ => panic!("both providers should remain available"),
        })
        .collect();
    assert_eq!(
        views[0].binding.declaration.profile,
        views[1].binding.declaration.profile
    );
    assert_eq!(views[0].rules, views[1].rules);
    assert_ne!(
        views[0].binding.checker.provider,
        views[1].binding.checker.provider
    );
}

#[test]
fn text_selection_wire_rejects_unknown_fields_and_preserves_explicit_subset() {
    let fixture = fixture(true, "text-support", false);
    let value = selection(&fixture, &runtime_approval());
    let wire = serde_json::to_value(&value).unwrap();
    assert_eq!(
        serde_json::from_value::<PluginTextReviewSelection>(wire.clone()).unwrap(),
        value
    );
    let mut invalid = wire;
    invalid["grant"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PluginTextReviewSelection>(invalid).is_err());
}
