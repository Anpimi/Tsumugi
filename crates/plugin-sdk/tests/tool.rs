use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

fn declaration() -> CapabilityToolDeclaration {
    parse_tool_declaration(include_bytes!("fixtures/tool.declaration.json")).unwrap()
}
fn manifest() -> PluginManifest {
    serde_json::from_slice(include_bytes!("fixtures/tool.manifest.json")).unwrap()
}
fn binding() -> CapabilityToolBinding {
    declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64))
        .unwrap()
}
fn capability(manifest: &mut PluginManifest) -> &mut CapabilityDeclaration {
    let ContributionKind::Capability { declaration } = &mut manifest.contributions[0].contribution
    else {
        unreachable!()
    };
    declaration
}

#[test]
fn tool_binds_the_original_capability_resource_schema_skill_and_package_identity() {
    let manifest = manifest().validate().unwrap();
    let selected = declaration().bind(&manifest, &"a".repeat(64)).unwrap();
    assert_eq!(
        selected.capability,
        bind_capability(&manifest, "query", &"a".repeat(64)).unwrap()
    );
    assert_eq!(selected.capability.provider.component_id, "worker");
    assert_eq!(
        selected.resources,
        vec![ToolResourceBinding {
            contribution_id: "terms".into(),
            schema: ContractRef {
                id: "example.terms".into(),
                schema_version: 1,
                behavior_version: 1
            },
        }]
    );
    assert_eq!(selected.declaration.skill.as_deref(), Some("guidance"));
    let original = serde_json::to_value(manifest.manifest()).unwrap();
    let mut reversed: PluginManifest = serde_json::from_value(original.clone()).unwrap();
    reversed.contributions.reverse();
    assert_eq!(
        selected,
        declaration()
            .bind(&reversed.validate().unwrap(), &"a".repeat(64))
            .unwrap()
    );
    assert_eq!(serde_json::to_value(manifest.manifest()).unwrap(), original);
}

#[test]
fn tool_requires_an_explicit_exact_profile_and_never_infers_behavior_from_schema() {
    for change in 0..4 {
        let mut declaration = declaration();
        match change {
            0 => declaration.profile = None,
            1 => declaration.profile.as_mut().unwrap().id = "example.other".into(),
            2 => declaration.profile.as_mut().unwrap().schema_version += 1,
            _ => declaration.profile.as_mut().unwrap().behavior_version += 1,
        }
        assert!(
            declaration
                .bind(&manifest().validate().unwrap(), &"a".repeat(64))
                .is_err(),
            "case {change}"
        );
    }
    let mut manifest = manifest();
    capability(&mut manifest).profiles.clear();
    let manifest = manifest.validate().unwrap();
    assert!(declaration().bind(&manifest, &"a".repeat(64)).is_err());
    let mut declaration = declaration();
    declaration.profile = None;
    declaration.bind(&manifest, &"a".repeat(64)).unwrap();
}

#[test]
fn tool_refuses_writes_network_process_and_other_uncaptured_permissions() {
    for effect in ["proposal", "external"] {
        let mut value = serde_json::to_value(manifest()).unwrap();
        value["contributions"][0]["contribution"]["declaration"]["effect"] = json!(effect);
        let manifest: PluginManifest = serde_json::from_value(value).unwrap();
        assert!(
            declaration()
                .bind(&manifest.validate().unwrap(), &"a".repeat(64))
                .is_err()
        );
    }
    for permission in [
        json!({"kind":"network", "destination":"https://example.test"}),
        json!({"kind":"process", "program":"worker"}),
        json!({"kind":"staged-output"}),
        json!({"kind":"project-service", "contract":{"id":"example.service", "schemaVersion":1, "behaviorVersion":1}}),
    ] {
        let mut value = serde_json::to_value(manifest()).unwrap();
        value["permissions"]
            .as_array_mut()
            .unwrap()
            .push(permission.clone());
        value["contributions"][0]["contribution"]["declaration"]["permissions"]
            .as_array_mut()
            .unwrap()
            .push(permission);
        let manifest: PluginManifest = serde_json::from_value(value).unwrap();
        assert!(
            declaration()
                .bind(&manifest.validate().unwrap(), &"a".repeat(64))
                .is_err()
        );
    }
    let mut manifest = manifest();
    capability(&mut manifest).permissions.clear();
    declaration()
        .bind(&manifest.validate().unwrap(), &"a".repeat(64))
        .unwrap();
}

#[test]
fn tool_refuses_foreign_missing_or_wrong_kind_capability_resource_and_skill() {
    for change in 0..6 {
        let mut declaration = declaration();
        match change {
            0 => declaration.capability_id = "missing".into(),
            1 => declaration.capability_id = "terms".into(),
            2 => declaration.supporting_resources = vec!["missing".into()],
            3 => declaration.supporting_resources = vec!["query".into()],
            4 => declaration.skill = Some("missing".into()),
            _ => declaration.skill = Some("terms".into()),
        }
        assert!(
            declaration
                .bind(&manifest().validate().unwrap(), &"a".repeat(64))
                .is_err(),
            "case {change}"
        );
    }
    assert!(
        declaration()
            .bind(&manifest().validate().unwrap(), "not-a-digest")
            .is_err()
    );
}

#[test]
fn tool_roundtrips_unicode_and_refuses_unknown_duplicate_unbounded_guidance() {
    let mut original = declaration();
    original.title = "术语查询 👩🏽‍💻".into();
    original.description = "Preserve e\u{301} and 日本語.\nGuidance grants no tools.".into();
    assert_eq!(
        parse_tool_declaration(&serde_json::to_vec(&original).unwrap()).unwrap(),
        original
    );
    for change in 0..8 {
        let mut invalid = original.clone();
        match change {
            0 => invalid.title = " ".into(),
            1 => invalid.title = "é".repeat(129),
            2 => invalid.description = "a\u{0}b".into(),
            3 => invalid.description = "é".repeat(2049),
            4 => invalid.name = "../outside".into(),
            5 => invalid.supporting_resources = vec!["terms".into(); 2],
            6 => {
                invalid.supporting_resources = (0..=MAX_TOOL_RESOURCES)
                    .map(|i| format!("resource-{i}"))
                    .collect()
            }
            _ => invalid.skill = Some("../outside".into()),
        }
        assert!(
            parse_tool_declaration(&serde_json::to_vec(&invalid).unwrap()).is_err(),
            "case {change}"
        );
    }
    let mut value = serde_json::to_value(&original).unwrap();
    value["grant"] = Value::Null;
    assert!(parse_tool_declaration(&serde_json::to_vec(&value).unwrap()).is_err());
    let duplicate =
        serde_json::to_string(&original)
            .unwrap()
            .replacen('{', "{\"capabilityId\":\"other\",", 1);
    assert!(parse_tool_declaration(duplicate.as_bytes()).is_err());
    assert_eq!(
        parse_tool_declaration(&vec![b' '; MAX_TOOL_DECLARATION_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
}

#[test]
fn binding_validation_refuses_changed_target_profile_resources_and_schema_versions() {
    for change in 0..6 {
        let mut binding = binding();
        match change {
            0 => binding.capability.provider.contribution_id = "other".into(),
            1 => {
                binding
                    .declaration
                    .profile
                    .as_mut()
                    .unwrap()
                    .behavior_version += 1
            }
            2 => binding.resources.clear(),
            3 => binding.resources[0].contribution_id = "other".into(),
            4 => binding.resources[0].schema.behavior_version = 0,
            _ => binding.capability.declaration.limits.max_input_bytes = 0,
        }
        assert!(binding.validate().is_err(), "case {change}");
    }
    let original = binding();
    assert_eq!(
        serde_json::from_slice::<CapabilityToolBinding>(&serde_json::to_vec(&original).unwrap())
            .unwrap(),
        original
    );
    let mut claim = original.clone();
    claim.capability.provider.package_digest = "b".repeat(64);
    claim.validate().unwrap(); // Valid syntax cannot authenticate caller-supplied claims.
    assert_ne!(
        claim,
        declaration()
            .bind(&manifest().validate().unwrap(), &"a".repeat(64))
            .unwrap()
    );
}

#[test]
fn identical_tool_names_preserve_explicit_provider_and_package_choices() {
    let a = binding();
    let mut second = manifest();
    second.plugin.id = "other-reference".into();
    let b = declaration()
        .bind(&second.validate().unwrap(), &"b".repeat(64))
        .unwrap();
    assert_eq!(a.declaration.name, b.declaration.name);
    assert_ne!(a.capability.provider, b.capability.provider);
    assert_eq!(a.capability.declaration, b.capability.declaration);
}

#[cfg(feature = "schema")]
#[test]
fn generated_tool_schemas_match_the_rust_contract_owner() {
    for (bytes, schema) in [
        (
            include_bytes!("../schemas/tool-declaration.schema.json").as_slice(),
            tool_declaration_schema(),
        ),
        (
            include_bytes!("../schemas/tool-types.schema.json").as_slice(),
            tool_types_schema(),
        ),
    ] {
        let actual: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(actual, serde_json::to_value(schema).unwrap());
    }
}
