use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

const SMAPI: &[u8] = include_bytes!("fixtures/smapi.manifest.json");
const WEBVTT: &[u8] = include_bytes!("fixtures/webvtt.manifest.json");
const COMBINED: &[u8] = include_bytes!("fixtures/combined.manifest.json");

fn raw(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}
fn parse(value: &Value) -> Result<ValidatedManifest, ContractError> {
    parse_manifest(&serde_json::to_vec(value).unwrap())
}
fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn error(value: &Value, expected: ContractErrorCode) {
    let actual = parse(value).unwrap_err();
    assert_eq!(actual.code, expected, "{actual}");
}

#[test]
fn domain_matrices_and_single_package_multiple_contributions_roundtrip() {
    for (fixture, count, profile) in [
        (SMAPI, 7, "smapi-i18n-flat"),
        (WEBVTT, 6, "webvtt-captions"),
    ] {
        let manifest = parse_manifest(fixture).unwrap();
        assert_eq!(manifest.manifest().contributions.len(), count);
        assert_eq!(manifest.manifest().components.len(), 1);
        let names: Vec<_> = manifest
            .manifest()
            .contributions
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        for required in [
            "detect",
            "extract-source",
            "match-source",
            "validate-content",
            "build",
            "validate-artifact",
        ] {
            assert!(names.contains(&required));
            manifest
                .capability(
                    required,
                    &contract(&format!("example.content.{required}")),
                    Some(&contract(profile)),
                )
                .unwrap();
        }
        assert_eq!(names.contains(&"import-translations"), count == 7);
        assert_eq!(
            raw(fixture),
            serde_json::to_value(manifest.manifest()).unwrap()
        );
    }
    let combined = parse_manifest(COMBINED).unwrap();
    assert_eq!(combined.manifest().components.len(), 3);
    assert_eq!(combined.manifest().contributions.len(), 4);
    assert_eq!(
        combined.manifest().components[1].dependencies[0].required,
        false
    );
    assert_eq!(
        combined.manifest().components[2].dependencies[0].required,
        true
    );
    assert_eq!(
        raw(COMBINED),
        serde_json::to_value(combined.manifest()).unwrap()
    );
}

#[test]
fn unknown_fields_duplicate_json_fields_and_bad_enum_values_are_rejected() {
    let mut value = raw(SMAPI);
    value["answer"] = json!("yes");
    error(&value, ContractErrorCode::InvalidSchema);
    value = raw(SMAPI);
    value["contributions"][0]["contribution"]["declaration"]["authorizesWrites"] = json!(true);
    error(&value, ContractErrorCode::InvalidSchema);
    value = raw(SMAPI);
    value["components"][0]["scope"] = json!("global-project");
    error(&value, ContractErrorCode::InvalidSchema);
    value = raw(SMAPI);
    value["contributions"][0]["contribution"]["declaration"]["effect"] = json!("approve");
    error(&value, ContractErrorCode::InvalidSchema);
    let text = String::from_utf8(SMAPI.to_vec()).unwrap().replacen(
        "\"protocolVersion\": 1",
        "\"protocolVersion\": 1, \"protocolVersion\": 1",
        1,
    );
    assert_eq!(
        parse_manifest(text.as_bytes()).unwrap_err().code,
        ContractErrorCode::InvalidSchema
    );
}

#[test]
fn protocol_identity_owner_and_resource_limits_are_not_silent_defaults() {
    let mut value = raw(SMAPI);
    value["protocolVersion"] = json!(2);
    error(&value, ContractErrorCode::UnsupportedProtocol);
    value = raw(SMAPI);
    value["contributions"][0]["componentId"] = json!("missing");
    error(&value, ContractErrorCode::MissingOwner);
    value = raw(SMAPI);
    value["plugin"]["publisher"] = json!("Org.Example");
    error(&value, ContractErrorCode::InvalidDeclaration);
    for field in [
        "maxInputBytes",
        "maxOutputBytes",
        "concurrency",
        "timeoutMs",
    ] {
        value = raw(SMAPI);
        value["contributions"][0]["contribution"]["declaration"]["limits"][field] = json!(0);
        error(&value, ContractErrorCode::InvalidDeclaration);
    }
    let oversized = vec![b' '; MAX_MANIFEST_BYTES + 1];
    assert_eq!(
        parse_manifest(&oversized).unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
}

#[test]
fn package_versions_are_semver_without_implying_behavior_compatibility() {
    for invalid in ["latest", "1", "1.01.0", "1.0.0-", "v1.0.0"] {
        let mut value = raw(SMAPI);
        value["plugin"]["version"] = json!(invalid);
        error(&value, ContractErrorCode::InvalidDeclaration);
    }
    for valid in ["0.1.0-alpha.1", "1.0.0+local", "2.3.4"] {
        let mut value = raw(SMAPI);
        value["plugin"]["version"] = json!(valid);
        assert!(parse(&value).is_ok());
    }
}

#[test]
fn identities_and_requested_permissions_cannot_be_duplicated_or_expanded() {
    let mut value = raw(SMAPI);
    let component = value["components"][0].clone();
    value["components"].as_array_mut().unwrap().push(component);
    error(&value, ContractErrorCode::DuplicateIdentity);
    value = raw(SMAPI);
    let contribution = value["contributions"][0].clone();
    value["contributions"]
        .as_array_mut()
        .unwrap()
        .push(contribution);
    error(&value, ContractErrorCode::DuplicateIdentity);
    value = raw(SMAPI);
    value["contributions"][0]["contribution"]["declaration"]["permissions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"network","destination":"https://example.org/model"}));
    error(&value, ContractErrorCode::UndeclaredPermission);
    value = raw(SMAPI);
    value["permissions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"captured-input"}));
    error(&value, ContractErrorCode::DuplicateIdentity);
    // Requesting a permission remains declaration data, never an actual grant.
    value = raw(SMAPI);
    value["permissions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"network","destination":"https://example.org/model"}));
    value["contributions"][0]["contribution"]["declaration"]["permissions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"network","destination":"https://example.org/model"}));
    assert_eq!(parse(&value).unwrap().manifest().permissions.len(), 3);
}

#[test]
fn data_only_packages_do_not_smuggle_entrypoints_or_callable_components() {
    let combined = raw(COMBINED);
    let mut data = combined.clone();
    data["components"]
        .as_array_mut()
        .unwrap()
        .retain(|c| c["id"] == "knowledge-data");
    data["contributions"]
        .as_array_mut()
        .unwrap()
        .retain(|c| c["componentId"] == "knowledge-data");
    data["permissions"] = json!([]);
    assert_eq!(parse(&data).unwrap().manifest().contributions.len(), 2);
    data["components"][0]["entrypoint"] = json!("bin/hidden");
    error(&data, ContractErrorCode::InvalidDeclaration);
    let mut worker = raw(SMAPI);
    worker["components"][0]["runtime"] = json!("data");
    worker["components"][0]["entrypoint"] = Value::Null;
    error(&worker, ContractErrorCode::InvalidDeclaration);
}

#[test]
fn package_relative_references_reject_traversal_and_platform_path_forms() {
    for path in [
        "../worker",
        "/tmp/worker",
        "C:/worker",
        "bin\\worker",
        "bin//worker",
        "bin/./worker",
        "bin/../worker",
        "worker\n",
    ] {
        let mut value = raw(SMAPI);
        value["components"][0]["entrypoint"] = json!(path);
        error(&value, ContractErrorCode::InvalidPath);
        let mut resource = raw(COMBINED);
        resource["contributions"][0]["contribution"]["path"] = json!(path);
        error(&resource, ContractErrorCode::InvalidPath);
    }
}

#[test]
fn exact_schema_behavior_and_profile_identity_prevent_lookalike_compatibility() {
    let manifest = parse_manifest(SMAPI).unwrap();
    let current = contract("example.content.extract-source");
    let profile = contract("smapi-i18n-flat");
    manifest
        .capability("extract-source", &current, Some(&profile))
        .unwrap();
    for changed in [
        ContractRef {
            schema_version: 2,
            ..current.clone()
        },
        ContractRef {
            behavior_version: 2,
            ..current.clone()
        },
    ] {
        assert_eq!(
            manifest
                .capability("extract-source", &changed, Some(&profile))
                .unwrap_err()
                .code,
            ContractErrorCode::IncompatibleContract
        );
    }
    let changed_profile = ContractRef {
        behavior_version: 2,
        ..profile.clone()
    };
    assert!(
        manifest
            .capability("extract-source", &current, Some(&changed_profile))
            .is_err()
    );
    assert!(
        manifest
            .capability("extract-source", &current, None)
            .is_err()
    );
    assert!(
        manifest
            .capability(
                "extract-source",
                &current,
                Some(&contract("webvtt-captions"))
            )
            .is_err()
    );
}

#[test]
fn overlapping_providers_require_explicit_choice_and_collection_keeps_provenance() {
    let a = parse_manifest(SMAPI).unwrap();
    let mut second = raw(SMAPI);
    second["plugin"]["id"] = json!("alternative-smapi");
    let b = parse(&second).unwrap();
    let contract = contract("example.content.extract-source");
    let profile = crate::contract("smapi-i18n-flat");
    let chosen = ProviderKey {
        plugin: b.manifest().plugin.clone(),
        contribution_id: "extract-source".into(),
    };
    for catalog in [vec![a.clone(), b.clone()], vec![b.clone(), a.clone()]] {
        assert_eq!(
            resolve_declarations(
                &catalog,
                &contract,
                Some(&profile),
                ProviderSelection::Single,
                &[]
            )
            .unwrap_err()
            .code,
            ContractErrorCode::AmbiguousProvider
        );
        let found = resolve_declarations(
            &catalog,
            &contract,
            Some(&profile),
            ProviderSelection::Single,
            std::slice::from_ref(&chosen),
        )
        .unwrap();
        assert_eq!(found[0].key, chosen);
        assert_eq!(found[0].owner.scope, ComponentScope::Attempt);
    }
    let forward = vec![a.clone(), b.clone()];
    let reverse = vec![b.clone(), a.clone()];
    let keys = |catalog: &[ValidatedManifest]| {
        resolve_declarations(
            catalog,
            &contract,
            Some(&profile),
            ProviderSelection::CollectIndependent,
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|p| p.key)
        .collect::<Vec<_>>()
    };
    assert_eq!(keys(&forward), keys(&reverse));
    assert_eq!(keys(&forward).len(), 2);
    assert_eq!(
        resolve_declarations(
            &forward,
            &contract,
            Some(&profile),
            ProviderSelection::CollectIndependent,
            &[chosen.clone(), chosen]
        )
        .unwrap_err()
        .code,
        ContractErrorCode::DuplicateIdentity
    );
    assert_eq!(
        resolve_declarations(
            &[a.clone(), a],
            &contract,
            Some(&profile),
            ProviderSelection::Single,
            &[]
        )
        .unwrap_err()
        .code,
        ContractErrorCode::DuplicateIdentity
    );
}
