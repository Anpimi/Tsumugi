use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

const SMAPI: &[u8] = include_bytes!("fixtures/smapi.manifest.json");
const COMBINED: &[u8] = include_bytes!("fixtures/combined.manifest.json");

fn binding() -> CapabilityBinding {
    bind_capability(
        &parse_manifest(SMAPI).unwrap(),
        "extract-source",
        &"a".repeat(64),
    )
    .unwrap()
}

#[test]
fn binding_captures_the_exact_declaration_and_its_actual_owner() {
    let manifest = parse_manifest(COMBINED).unwrap();
    let before = serde_json::to_value(manifest.manifest()).unwrap();
    let captured = bind_capability(&manifest, "analyze", &"b".repeat(64)).unwrap();
    let contribution = &manifest.manifest().contributions[3];
    let ContributionKind::Capability { declaration } = &contribution.contribution else {
        panic!("fixture capability");
    };
    assert_eq!(captured.provider.plugin, manifest.manifest().plugin);
    assert_eq!(captured.provider.component_id, "ai-helper");
    assert_eq!(captured.provider.contribution_id, contribution.id);
    assert_eq!(captured.provider.package_digest, "b".repeat(64));
    assert_eq!(captured.declaration, *declaration);
    captured.validate().unwrap();
    assert_eq!(before, serde_json::to_value(manifest.manifest()).unwrap());

    // The fixed snapshot does not alias the manifest's declaration or identity.
    let mut edited = captured;
    edited.provider.plugin.id = "another-plugin".into();
    edited.declaration.limits.max_input_bytes = 1;
    assert_ne!(edited.provider.plugin, manifest.manifest().plugin);
    assert_ne!(edited.declaration, *declaration);
    assert_eq!(before, serde_json::to_value(manifest.manifest()).unwrap());
}

#[test]
fn providers_of_the_same_contract_retain_independent_package_identity() {
    let first_manifest = parse_manifest(SMAPI).unwrap();
    let mut second_manifest = first_manifest.manifest().clone();
    second_manifest.plugin.id = "another-format-provider".into();
    let second_manifest = second_manifest.validate().unwrap();
    let first = bind_capability(&first_manifest, "extract-source", &"a".repeat(64)).unwrap();
    let second = bind_capability(&second_manifest, "extract-source", &"b".repeat(64)).unwrap();
    assert_eq!(first.declaration, second.declaration);
    assert_ne!(first.provider, second.provider);
    assert_ne!(first, second);

    // A changed artifact remains a different fixed choice even when its claimed
    // plugin identity and capability contract have not changed.
    let changed_package =
        bind_capability(&first_manifest, "extract-source", &"c".repeat(64)).unwrap();
    assert_eq!(first.provider.plugin, changed_package.provider.plugin);
    assert_ne!(first.provider, changed_package.provider);
}

#[test]
fn binding_rejects_invalid_digests_missing_ids_and_non_capability_contributions() {
    let manifest = parse_manifest(COMBINED).unwrap();
    for digest in [
        String::new(),
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
    ] {
        let error = bind_capability(&manifest, "analyze", &digest).unwrap_err();
        assert_eq!(error.code, ContractErrorCode::InvalidDeclaration);
        assert_eq!(error.field, "binding.packageDigest");
    }
    for id in ["missing", "terms", "guide", "reference-panel"] {
        assert_eq!(
            bind_capability(&manifest, id, &"a".repeat(64))
                .unwrap_err()
                .code,
            ContractErrorCode::IncompatibleContract,
            "{id}"
        );
    }
    for id in ["", "../analyze", "Analyze", "analyze\n"] {
        assert_eq!(
            bind_capability(&manifest, id, &"a".repeat(64))
                .unwrap_err()
                .code,
            ContractErrorCode::InvalidDeclaration,
            "{id:?}"
        );
    }
}

#[test]
fn standalone_binding_validation_reuses_identity_permission_path_and_capability_rules() {
    let original = binding();
    let original_json = serde_json::to_value(&original).unwrap();
    for (field, replacement) in [
        ("componentId", json!("../worker")),
        ("contributionId", json!("Bad-Id")),
        ("packageDigest", json!("not-a-digest")),
        (
            "plugin",
            json!({"publisher":"Bad", "id":"valid", "version":"0.1.0"}),
        ),
        (
            "plugin",
            json!({"publisher":"valid", "id":"valid", "version":"not-semver"}),
        ),
    ] {
        let mut value = original_json.clone();
        value["provider"][field] = replacement;
        let invalid: CapabilityBinding = serde_json::from_value(value).unwrap();
        assert_eq!(
            invalid.validate().unwrap_err().code,
            ContractErrorCode::InvalidDeclaration,
            "{field}"
        );
    }

    let mut invalid = original.clone();
    invalid.declaration.permissions = vec![PermissionRequest::Process {
        program: "../outside-worker".into(),
    }];
    assert_eq!(
        invalid.validate().unwrap_err().code,
        ContractErrorCode::InvalidPath
    );
    invalid = original.clone();
    invalid.declaration.permissions = vec![PermissionRequest::CapturedInput; 2];
    assert_eq!(
        invalid.validate().unwrap_err().code,
        ContractErrorCode::DuplicateIdentity
    );
    invalid = original.clone();
    invalid.declaration.input_schema.behavior_version = 0;
    assert_eq!(
        invalid.validate().unwrap_err().code,
        ContractErrorCode::InvalidDeclaration
    );
    invalid = original;
    invalid.declaration.limits.max_output_bytes = 0;
    assert_eq!(
        invalid.validate().unwrap_err().code,
        ContractErrorCode::InvalidDeclaration
    );
}

#[test]
fn actual_channel_selection_excludes_instance_and_activation_generation() {
    let first: ProviderBinding =
        serde_json::from_slice(include_bytes!("fixtures/invocation.channel.json")).unwrap();
    let mut second = first.clone();
    second.instance_id = "instance-b".into();
    second.activation_generation = 2;
    assert_ne!(first, second);
    assert_eq!(first.selection(), second.selection());
    let selected = first.selection();
    selected.validate().unwrap();
    assert_eq!(
        serde_json::to_value(&selected).unwrap(),
        json!({
            "plugin": first.plugin,
            "componentId": first.component_id,
            "contributionId": first.contribution_id,
            "packageDigest": first.package_digest,
        })
    );
    second.package_digest = "b".repeat(64);
    assert_ne!(selected, second.selection());
}

#[test]
fn binding_wire_shapes_roundtrip_and_reject_unknown_or_duplicate_fields() {
    let binding = binding();
    let json = serde_json::to_vec(&binding).unwrap();
    assert_eq!(
        serde_json::from_slice::<CapabilityBinding>(&json).unwrap(),
        binding
    );
    for field in ["instanceId", "activationGeneration", "grant"] {
        let mut value = serde_json::to_value(&binding.provider).unwrap();
        value[field] = json!("unexpected");
        assert!(serde_json::from_value::<ProviderSelectionBinding>(value).is_err());
    }
    let mut value = serde_json::to_value(&binding).unwrap();
    value["grant"] = Value::Null;
    assert!(serde_json::from_value::<CapabilityBinding>(value).is_err());
    let selected = serde_json::to_string(&binding.provider).unwrap();
    let duplicate = selected.replacen('{', "{\"componentId\":\"other-worker\",", 1);
    assert!(serde_json::from_str::<ProviderSelectionBinding>(&duplicate).is_err());
}
