use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

fn legacy_input() -> TranslationExtractionInput {
    parse_translation_extraction_input(include_bytes!("fixtures/translation-extraction.input.json"))
        .unwrap()
}
fn declaration() -> TranslationImportDeclaration {
    let mut value = parse_translation_import_declaration(include_bytes!(
        "fixtures/translation-import.declaration.json"
    ))
    .unwrap();
    value.material = None;
    value.file_sets = Some(vec![
        SourceFileSetDeclaration {
            id: "translated-plugin".into(),
            display_name: "Translated plugin".into(),
            role: "translation".into(),
            encoding: SourceMaterialEncoding::Binary,
            extensions: vec!["esp".into()],
            min_files: 1,
            max_files: 1,
            max_bytes: MAX_EXCHANGE_BYTES as u32,
        },
        SourceFileSetDeclaration {
            id: "translated-tables".into(),
            display_name: "Translated companion tables".into(),
            role: "strings".into(),
            encoding: SourceMaterialEncoding::Binary,
            extensions: vec!["strings".into()],
            min_files: 0,
            max_files: 3,
            max_bytes: MAX_EXCHANGE_BYTES as u32,
        },
    ]);
    value.max_total_bytes = Some(MAX_EXCHANGE_BYTES as u32);
    value
}
fn manifest() -> PluginManifest {
    let mut manifest: PluginManifest =
        serde_json::from_slice(include_bytes!("fixtures/translation-import.manifest.json"))
            .unwrap();
    manifest.permissions.push(PermissionRequest::Process {
        program: "bin/format".into(),
    });
    for item in &mut manifest.contributions {
        if let ContributionKind::Capability { declaration } = &mut item.contribution {
            declaration.input_schema.schema_version = 3;
            if item.id == "extract" {
                declaration.output_schema.schema_version = 3;
            }
            declaration.permissions.push(PermissionRequest::Process {
                program: "bin/format".into(),
            });
        }
    }
    manifest
}
fn binding() -> TranslationImportBinding {
    declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64))
        .unwrap()
}
fn input() -> TranslationExtractionInput {
    let mut input = legacy_input();
    input.artifacts = vec![
        CapturedArtifact::from_bytes(
            "plugin".into(),
            "Example.esp".into(),
            "translation".into(),
            &[0, 255, 1],
        )
        .unwrap(),
        CapturedArtifact::from_bytes(
            "table".into(),
            "Strings/Example_english.STRINGS".into(),
            "strings".into(),
            &[2, 0, 3],
        )
        .unwrap(),
    ];
    input.paired_source = Some(TranslationPairSource {
        source_language: "en-US".into(),
        artifacts: vec![
            CapturedArtifact::from_bytes(
                "original".into(),
                "Example.esp".into(),
                "source".into(),
                &[0, 255, 0],
            )
            .unwrap(),
        ],
    });
    input
}

#[test]
fn paired_capture_resolves_multiple_binary_files_with_one_measured_budget() {
    let binding = binding();
    let input = input();
    binding.validate_input(&input).unwrap();
    let raw = serde_json::to_vec(&input).unwrap();
    assert_eq!(
        parse_paired_translation_extraction_input(&raw).unwrap(),
        input
    );
    assert!(parse_translation_extraction_input(&raw).is_err());
    let selections = vec![
        SourceFileSetSelection {
            id: "translated-plugin".into(),
            logical_paths: vec!["Example.esp".into()],
        },
        SourceFileSetSelection {
            id: "translated-tables".into(),
            logical_paths: vec!["Strings/Example_english.STRINGS".into()],
        },
    ];
    binding
        .declaration
        .validate_paired_capture_sizes(&selections, &[MAX_EXCHANGE_BYTES - 1, 1])
        .unwrap();
    assert!(
        binding
            .declaration
            .validate_paired_capture_sizes(&selections, &[MAX_EXCHANGE_BYTES, 1])
            .is_err()
    );
    assert!(binding.declaration.resolve_paired_materials(&[]).is_err());
    let mut aliases = selections;
    aliases[1].logical_paths = vec!["Example.esp/Other.strings".into()];
    assert!(
        binding
            .declaration
            .resolve_paired_materials(&aliases)
            .is_err()
    );
}

#[test]
fn paired_binding_refuses_mixed_families_permissions_roles_and_incomplete_captures() {
    for case in 0..7 {
        let mut binding = binding();
        match case {
            0 => binding.extractor.declaration.input_schema.schema_version = 2,
            1 => binding.extractor.declaration.output_schema.schema_version = 2,
            2 => binding.checker.declaration.input_schema.schema_version = 2,
            3 => binding.checker.declaration.output_schema.schema_version = 3,
            4 => binding
                .extractor
                .declaration
                .permissions
                .push(PermissionRequest::Network {
                    destination: "example.invalid".into(),
                }),
            5 => binding.declaration.file_sets.as_mut().unwrap()[1].role = "translation".into(),
            _ => binding.declaration.max_total_bytes = None,
        }
        assert!(binding.validate().is_err(), "binding {case}");
    }
    for case in 0..6 {
        let mut input = input();
        match case {
            0 => input.paired_source = None,
            1 => input.artifacts.swap(0, 1),
            2 => {
                input.artifacts[0] = CapturedArtifact::from_bytes(
                    "wrong".into(),
                    "Example.txt".into(),
                    "translation".into(),
                    &[0],
                )
                .unwrap()
            }
            3 => {
                input.artifacts[0] = CapturedTextArtifact {
                    id: "wrong".into(),
                    logical_path: "Example.esp".into(),
                    role: "translation".into(),
                    utf8: "x".into(),
                    sha256: payload_digest("x"),
                }
                .into()
            }
            4 => input
                .artifacts
                .pop()
                .map(|_| {
                    input.artifacts.clear();
                })
                .unwrap(),
            _ => input.paired_source.as_mut().unwrap().artifacts.clear(),
        }
        assert!(binding().validate_input(&input).is_err(), "input {case}");
    }
}

#[test]
fn paired_resource_requires_its_exact_contract_and_never_rewrites_legacy_bytes() {
    let raw = include_bytes!("fixtures/translation-import.declaration.json");
    let original: Value = serde_json::from_slice(raw).unwrap();
    let legacy = parse_translation_import_declaration(raw).unwrap();
    assert_eq!(serde_json::to_value(&legacy).unwrap(), original);
    let input = legacy_input();
    assert!(
        !serde_json::to_value(input)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("pairedSource")
    );
    let paired = declaration();
    let raw = serde_json::to_vec(&paired).unwrap();
    assert_eq!(
        parse_translation_import_declaration_for_contract(
            &raw,
            &paired_translation_import_declaration_contract()
        )
        .unwrap(),
        paired
    );
    assert!(parse_translation_import_declaration(&raw).is_err());
    assert!(
        parse_translation_import_declaration_for_contract(
            &raw,
            &translation_import_declaration_contract()
        )
        .is_err()
    );
    for property in ["material", "fileSets", "maxTotalBytes"] {
        let mut value = serde_json::to_value(&paired).unwrap();
        value[property] = Value::Null;
        assert!(
            parse_paired_translation_import_declaration(&serde_json::to_vec(&value).unwrap())
                .is_err(),
            "{property}"
        );
    }
    let mut input = serde_json::to_value(legacy_input()).unwrap();
    input["pairedSource"] = Value::Null;
    assert!(
        parse_paired_translation_extraction_input(&serde_json::to_vec(&input).unwrap()).is_err()
    );
}

#[test]
fn paired_raw_material_ceilings_are_independent_of_encoded_input_allowance() {
    let mut input = input();
    input.artifacts = vec![
        CapturedArtifact::from_bytes(
            "plugin".into(),
            "Example.esp".into(),
            "translation".into(),
            &vec![0; MAX_EXCHANGE_BYTES],
        )
        .unwrap(),
    ];
    input.paired_source.as_mut().unwrap().artifacts = vec![
        CapturedArtifact::from_bytes(
            "original".into(),
            "Example.esp".into(),
            "source".into(),
            &vec![255; MAX_EXCHANGE_BYTES],
        )
        .unwrap(),
    ];
    binding().validate_input(&input).unwrap();
    let bytes = serde_json::to_vec(&input).unwrap();
    assert!(bytes.len() > MAX_EXCHANGE_BYTES && bytes.len() < MAX_PAIRED_TRANSLATION_INPUT_BYTES);
    parse_paired_translation_extraction_input(&bytes).unwrap();
    input.paired_source.as_mut().unwrap().artifacts.push(
        CapturedArtifact::from_bytes("extra".into(), "extra.esp".into(), "source".into(), &[0])
            .unwrap(),
    );
    assert!(input.validate().is_err());
}

#[cfg(feature = "schema")]
#[test]
fn paired_schemas_require_source_while_schema_two_and_resource_one_stay_frozen() {
    for (generated, frozen) in [
        (
            translation_extraction_input_schema(),
            include_str!("../schemas/translation-extraction-input.schema.json"),
        ),
        (
            translation_import_declaration_schema(),
            include_str!("../schemas/translation-import-declaration.schema.json"),
        ),
        (
            translation_extraction_check_input_schema(),
            include_str!("../schemas/translation-extraction-check-input.schema.json"),
        ),
        (
            translation_types_schema(),
            include_str!("../schemas/translation-types.schema.json"),
        ),
    ] {
        assert_eq!(
            generated.to_value(),
            serde_json::from_str::<Value>(frozen).unwrap()
        );
    }
    let input = paired_translation_extraction_input_schema().to_value();
    assert!(
        input["required"]
            .as_array()
            .unwrap()
            .contains(&json!("pairedSource"))
    );
    let check = paired_translation_extraction_check_input_schema().to_value();
    assert!(
        check["$defs"]["TranslationExtractionInput"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("pairedSource"))
    );
    let declaration = paired_translation_import_declaration_schema().to_value();
    assert!(declaration["properties"].get("material").is_none());
    assert!(
        declaration["required"]
            .as_array()
            .unwrap()
            .contains(&json!("maxTotalBytes"))
    );
}
