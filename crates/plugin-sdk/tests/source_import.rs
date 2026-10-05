use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;
fn declaration() -> SourceImportDeclaration {
    parse_source_import_declaration(include_bytes!("fixtures/source-import.declaration.json"))
        .unwrap()
}
fn manifest() -> PluginManifest {
    serde_json::from_slice(include_bytes!("fixtures/source-import.manifest.json")).unwrap()
}
#[test]
fn source_import_binds_both_providers_without_execution_authority() {
    let binding = declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64))
        .unwrap();
    assert_eq!(binding.extractor.provider.contribution_id, "extract");
    assert_eq!(binding.checker.provider.contribution_id, "source-check");
    assert_eq!(binding.extractor.provider.package_digest, "a".repeat(64));
    assert_eq!(
        binding.checker.provider.plugin,
        binding.extractor.provider.plugin
    );
    binding.validate().unwrap();
    let mut forged = binding.clone();
    forged.checker.provider.package_digest = "b".repeat(64);
    assert!(forged.validate().is_err());
    forged = binding;
    forged.extractor.provider.contribution_id = "other".into();
    assert!(forged.validate().is_err());
}
#[test]
fn source_import_rejects_wrong_contract_profile_permission_and_checker_effect() {
    for change in 0..5 {
        let mut m = manifest();
        let ContributionKind::Capability { declaration: d } = &mut m.contributions[2].contribution
        else {
            unreachable!()
        };
        match change {
            0 => d.input_schema.schema_version += 1,
            1 => d.output_schema = content_exchange_contract(),
            2 => d.profiles[0].behavior_version += 1,
            3 => {
                d.permissions.push(PermissionRequest::StagedOutput);
                m.permissions.push(PermissionRequest::StagedOutput);
            }
            _ => d.effect = EffectKind::Proposal,
        }
        assert!(
            declaration()
                .bind(&m.validate().unwrap(), &"a".repeat(64))
                .is_err(),
            "case {change}"
        );
    }
    let mut d = declaration();
    d.checker = d.extractor.clone();
    assert!(d.validate().is_err());
}
#[test]
fn source_import_paths_are_fixed_bounded_unique_and_nonoverlapping() {
    for path in [
        "../raw.txt",
        "/raw.txt",
        "materials\\raw.txt",
        "materials//raw.txt",
        "a:b",
        "materials/./raw.txt",
    ] {
        let mut d = declaration();
        d.materials[0].logical_path = path.into();
        assert!(d.validate().is_err(), "{path}");
    }
    for path in ["MATERIALS/RAW.txt", "materials/raw.txt/child", "materials"] {
        let mut d = declaration();
        d.materials[1].logical_path = path.into();
        assert!(d.validate().is_err(), "{path}");
    }
    let mut d = declaration();
    d.materials[0].max_bytes = 0;
    assert!(d.validate().is_err());
    d.materials[0].max_bytes = MAX_EXCHANGE_BYTES as u32;
    assert!(d.validate().is_err());
    d = declaration();
    d.materials.clear();
    assert!(d.validate().is_err());
}
#[test]
fn source_import_requires_fixed_nonempty_check_and_revision_policy() {
    let mut d = declaration();
    d.semantic_rules.clear();
    assert!(d.validate().is_err());
    d = declaration();
    d.semantic_rules.push(d.semantic_rules[0].clone());
    assert!(d.validate().is_err());
    d = declaration();
    d.revision_policy.profile.schema_version += 1;
    assert!(d.validate().is_err());
    d = declaration();
    d.display_name = "\nInvisible".into();
    assert!(d.validate().is_err());
}
#[test]
fn source_import_strict_parser_rejects_duplicates_unknown_fields_and_large_input() {
    let bytes = include_str!("fixtures/source-import.declaration.json");
    assert!(
        parse_source_import_declaration(
            bytes
                .replace(
                    "\"extractor\": \"extract\"",
                    "\"extractor\": \"extract\", \"extractor\": \"source-check\""
                )
                .as_bytes()
        )
        .is_err()
    );
    let mut v: Value = serde_json::from_str(bytes).unwrap();
    v["authority"] = json!(true);
    assert!(parse_source_import_declaration(&serde_json::to_vec(&v).unwrap()).is_err());
    assert!(
        parse_source_import_declaration(&vec![b' '; MAX_SOURCE_IMPORT_DECLARATION_BYTES + 1])
            .is_err()
    );
}
#[cfg(feature = "schema")]
#[test]
fn source_import_generated_schema_is_current() {
    let actual: Value = serde_json::from_slice(include_bytes!(
        "../schemas/source-import-declaration.schema.json"
    ))
    .unwrap();
    assert_eq!(
        actual,
        serde_json::to_value(source_import_declaration_schema()).unwrap()
    );
}
