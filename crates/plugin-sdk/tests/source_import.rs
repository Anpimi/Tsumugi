use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;
fn declaration() -> SourceImportDeclaration {
    parse_source_import_declaration(include_bytes!("fixtures/source-import.declaration.json"))
        .unwrap()
}
fn review() -> ReviewDeclaration {
    parse_review_declaration(include_bytes!("fixtures/source-import.review.json")).unwrap()
}
fn manifest() -> PluginManifest {
    serde_json::from_slice(include_bytes!("fixtures/source-import.manifest.json")).unwrap()
}

fn selectable() -> SourceImportDeclaration {
    let mut value = declaration();
    value.materials.clear();
    value.file_sets = Some(vec![
        SourceFileSetDeclaration {
            id: "plugin".into(),
            display_name: "Plugin file".into(),
            role: "source".into(),
            encoding: SourceMaterialEncoding::Binary,
            extensions: vec!["esp".into(), "esm".into(), "esl".into()],
            min_files: 1,
            max_files: 1,
            max_bytes: 262144,
        },
        SourceFileSetDeclaration {
            id: "tables".into(),
            display_name: "Companion tables".into(),
            role: "companion".into(),
            encoding: SourceMaterialEncoding::Binary,
            extensions: vec!["strings".into(), "dlstrings".into(), "ilstrings".into()],
            min_files: 0,
            max_files: 3,
            max_bytes: 131072,
        },
    ]);
    value
}
fn selected(id: &str, paths: &[&str]) -> SourceFileSetSelection {
    SourceFileSetSelection {
        id: id.into(),
        logical_paths: paths.iter().map(|path| (*path).into()).collect(),
    }
}

#[test]
fn file_sets_resolve_explicit_names_roles_and_encodings_without_discovery() {
    let declaration = selectable();
    declaration.validate().unwrap();
    let resolved = declaration
        .resolve_materials(&[
            selected(
                "tables",
                &[
                    "Strings/Chosen_english.STRINGS",
                    "Strings/Chosen_english.DLSTRINGS",
                ],
            ),
            selected("plugin", &["Chosen.ESP"]),
        ])
        .unwrap();
    assert_eq!(
        resolved
            .iter()
            .map(|material| (material.logical_path.as_str(), material.role.as_str()))
            .collect::<Vec<_>>(),
        [
            ("Chosen.ESP", "source"),
            ("Strings/Chosen_english.STRINGS", "companion"),
            ("Strings/Chosen_english.DLSTRINGS", "companion")
        ]
    );
    assert!(
        resolved
            .iter()
            .all(|material| material.encoding == SourceMaterialEncoding::Binary)
    );
    assert_eq!(
        declaration
            .resolve_materials(&[selected("plugin", &["Other.esl"])])
            .unwrap()
            .len(),
        1
    );
    assert!(declaration.resolve_materials(&[]).is_err());
    declaration
        .bind(&manifest().validate().unwrap(), &"a".repeat(64), &review())
        .unwrap();
}

#[test]
fn file_set_selections_refuse_unknown_duplicate_unsafe_and_excess_files() {
    let declaration = selectable();
    for paths in [
        vec!["../Chosen.esp"],
        vec!["/Chosen.esp"],
        vec!["Chosen.exe"],
        vec![".esp"],
        vec!["dir\\Chosen.esp"],
        vec!["Chosen.esp", "Other.esm"],
    ] {
        assert!(
            declaration
                .resolve_materials(&[selected("plugin", &paths)])
                .is_err(),
            "{paths:?}"
        );
    }
    let good = selected("plugin", &["Chosen.esp"]);
    for selections in [
        vec![good.clone(), good.clone()],
        vec![good.clone(), selected("unknown", &["extra.strings"])],
        vec![
            good.clone(),
            selected("tables", &["a.strings", "A.STRINGS"]),
        ],
        vec![
            good,
            selected("tables", &["a.strings", "a.strings/nested.strings"]),
        ],
    ] {
        assert!(declaration.resolve_materials(&selections).is_err());
    }
    let mut with_fixed = selectable();
    with_fixed.materials = vec![SourceMaterialDeclaration {
        logical_path: "chosen.esp".into(),
        role: "companion".into(),
        max_bytes: 16,
        encoding: SourceMaterialEncoding::Binary,
    }];
    assert!(
        with_fixed
            .resolve_materials(&[selected("plugin", &["CHOSEN.ESP"])])
            .is_err()
    );
}

#[test]
fn legacy_file_set_declarations_keep_reserved_count_and_byte_budgets() {
    for scenario in 0..8 {
        let mut declaration = selectable();
        declaration.max_total_bytes = None;
        let sets = declaration.file_sets.as_mut().unwrap();
        match scenario {
            0 => sets[0].min_files = 0,
            1 => sets[0].max_files = 0,
            2 => sets[0].max_files = 33,
            3 => sets[0].max_bytes = MAX_EXCHANGE_BYTES as u32,
            4 => sets[0].encoding = SourceMaterialEncoding::LegacyUtf8,
            5 => sets[0].extensions = vec!["*.esp".into()],
            6 => sets[0].extensions = vec!["esp".into(), "esp".into()],
            _ => sets[1].id = sets[0].id.clone(),
        }
        assert!(declaration.validate().is_err(), "{scenario}");
    }
}

#[test]
fn fixed_v3_resources_keep_their_original_shape_and_cannot_claim_v4() {
    let bytes = include_bytes!("fixtures/source-import-v3.declaration.json");
    let contract = ContractRef {
        schema_version: 3,
        ..source_import_declaration_contract()
    };
    let old = parse_source_import_declaration_for_contract(bytes, &contract).unwrap();
    assert!(old.file_sets.is_none());
    assert_eq!(old.declaration_contract(), contract);
    assert_eq!(
        serde_json::to_value(&old).unwrap(),
        serde_json::from_slice::<Value>(bytes).unwrap()
    );
    assert!(parse_source_import_declaration(bytes).is_err());
    let mut null = serde_json::to_value(declaration()).unwrap();
    null["fileSets"] = Value::Null;
    assert!(serde_json::from_value::<SourceImportDeclaration>(null).is_err());
    let unknown = ContractRef {
        schema_version: 6,
        ..contract
    };
    assert!(parse_source_import_declaration_for_contract(bytes, &unknown).is_err());
}

#[test]
fn source_import_material_encoding_is_explicit_and_closed() {
    let mut declared = declaration();
    declared.materials[0].encoding = SourceMaterialEncoding::Binary;
    declared
        .bind(&manifest().validate().unwrap(), &"a".repeat(64), &review())
        .unwrap();
    let valid = serde_json::to_value(declared).unwrap();
    for encoding in [json!(null), json!("latin-1"), json!(false)] {
        let mut invalid = valid.clone();
        invalid["materials"][0]["encoding"] = encoding;
        assert!(parse_source_import_declaration(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    let mut missing = valid;
    missing["materials"][0]
        .as_object_mut()
        .unwrap()
        .remove("encoding");
    assert!(parse_source_import_declaration(&serde_json::to_vec(&missing).unwrap()).is_err());
}
#[test]
fn source_import_binds_both_providers_without_execution_authority() {
    let binding = declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64), &review())
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
                .bind(&m.validate().unwrap(), &"a".repeat(64), &review())
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
    assert!(d.validate().is_ok());
    d.max_total_bytes = None;
    assert!(d.validate().is_err());
    d = declaration();
    d.materials[0].max_bytes = MAX_EXCHANGE_BYTES as u32 + 1;
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

#[test]
fn source_import_requires_the_named_review_resource_and_exact_profile() {
    assert_eq!(source_import_declaration_contract().schema_version, 5);
    assert_eq!(source_import_declaration_contract().behavior_version, 2);
    let mut d = declaration();
    d.review_resource = "missing".into();
    assert!(
        d.bind(&manifest().validate().unwrap(), &"a".repeat(64), &review())
            .is_err()
    );
    d.review_resource = "extract".into();
    assert!(
        d.bind(&manifest().validate().unwrap(), &"a".repeat(64), &review())
            .is_err()
    );
    let mut m = manifest();
    let ContributionKind::Resource { schema, .. } =
        &mut m.contributions.last_mut().unwrap().contribution
    else {
        unreachable!()
    };
    schema.behavior_version += 1;
    assert!(
        declaration()
            .bind(&m.validate().unwrap(), &"a".repeat(64), &review())
            .is_err()
    );
    let mut substituted = review();
    substituted.profile.behavior_version += 1;
    assert!(
        declaration()
            .bind(
                &manifest().validate().unwrap(),
                &"a".repeat(64),
                &substituted
            )
            .is_err()
    );
    let mut raw = serde_json::to_value(declaration()).unwrap();
    raw.as_object_mut().unwrap().remove("reviewResource");
    assert!(parse_source_import_declaration(&serde_json::to_vec(&raw).unwrap()).is_err());
}

#[test]
fn source_review_binding_refuses_replacement_package_rules_and_checker() {
    let binding = declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64), &review())
        .unwrap();
    assert_eq!(binding.review.declaration, review());
    assert_eq!(
        binding.review.checker.provider.package_digest,
        binding.extractor.provider.package_digest
    );
    for change in 0..4 {
        let mut forged = binding.clone();
        match change {
            0 => forged.review.checker.provider.package_digest = "b".repeat(64),
            1 => forged.review.declaration.rules.clear(),
            2 => forged.review.checker.provider.contribution_id = "source-check".into(),
            _ => forged.review.declaration.profile.behavior_version += 1,
        }
        assert!(forged.validate().is_err(), "case {change}");
    }
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

#[test]
fn v5_shares_actual_capture_bytes_without_reserving_all_per_file_maxima() {
    let mut value = selectable();
    let sets = value.file_sets.as_mut().unwrap();
    sets[0].max_bytes = MAX_EXCHANGE_BYTES as u32;
    sets[1].max_bytes = MAX_EXCHANGE_BYTES as u32;
    value.validate().unwrap();
    let choices = [
        selected("plugin", &["Chosen.esp"]),
        selected("tables", &["Strings/Chosen_english.strings"]),
    ];
    assert_eq!(value.resolve_materials(&choices).unwrap().len(), 2);
    value
        .validate_capture_sizes(&choices, &[MAX_EXCHANGE_BYTES - 1, 1])
        .unwrap();
    assert_eq!(
        value
            .validate_capture_sizes(&choices, &[MAX_EXCHANGE_BYTES, 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
    assert_eq!(
        value
            .validate_capture_sizes(&choices, &[MAX_EXCHANGE_BYTES + 1, 0])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
    assert!(value.validate_capture_sizes(&choices, &[1]).is_err());
    let mut old = value.clone();
    old.max_total_bytes = None;
    assert!(old.validate().is_err());
}

#[test]
fn v5_optional_groups_still_require_one_captured_material_and_closed_byte_limits() {
    let mut value = selectable();
    value.file_sets.as_mut().unwrap()[0].min_files = 0;
    value.validate().unwrap();
    assert!(value.resolve_materials(&[]).is_err());
    assert_eq!(
        value
            .resolve_materials(&[selected("tables", &["Strings/Chosen_english.strings"])])
            .unwrap()
            .len(),
        1
    );
    for bytes in [0, MAX_EXCHANGE_BYTES as u32 + 1] {
        let mut invalid = value.clone();
        invalid.max_total_bytes = Some(bytes);
        assert!(invalid.validate().is_err());
    }
    let mut invalid = value.clone();
    invalid.file_sets = None;
    assert!(invalid.validate().is_err());
    let mut null = serde_json::to_value(&value).unwrap();
    null["maxTotalBytes"] = Value::Null;
    assert!(serde_json::from_value::<SourceImportDeclaration>(null).is_err());
}

#[test]
fn v4_recipe_shape_and_reserved_budget_remain_exact_and_do_not_claim_v5() {
    let bytes = include_bytes!("fixtures/source-import-v4.declaration.json");
    let contract = ContractRef {
        schema_version: 4,
        ..source_import_declaration_contract()
    };
    let old = parse_source_import_declaration_for_contract(bytes, &contract).unwrap();
    assert!(old.max_total_bytes.is_none());
    assert!(old.file_sets.is_some());
    assert_eq!(old.declaration_contract(), contract);
    assert_eq!(
        serde_json::to_value(old).unwrap(),
        serde_json::from_slice::<Value>(bytes).unwrap()
    );
    assert!(parse_source_import_declaration(bytes).is_err());
    assert!(
        parse_source_import_declaration_for_contract(
            include_bytes!("fixtures/source-import.declaration.json"),
            &contract
        )
        .is_err()
    );
}
