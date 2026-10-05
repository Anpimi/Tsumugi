use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;
fn input() -> TranslationExtractionInput {
    parse_translation_extraction_input(include_bytes!("fixtures/translation-extraction.input.json"))
        .unwrap()
}
fn proposal() -> TranslationExchange {
    parse_translation_exchange(include_bytes!("fixtures/translation.exchange.json")).unwrap()
}
fn declaration() -> TranslationImportDeclaration {
    parse_translation_import_declaration(include_bytes!(
        "fixtures/translation-import.declaration.json"
    ))
    .unwrap()
}
fn binding() -> TranslationImportBinding {
    declaration()
        .bind(
            &parse_manifest(include_bytes!("fixtures/translation-import.manifest.json")).unwrap(),
            &"a".repeat(64),
        )
        .unwrap()
}
fn check() -> TranslationExtractionCheckInput {
    let b = binding();
    let input = input();
    TranslationExtractionCheckInput {
        requirements: vec![CheckRequirement {
            key: CheckKey {
                rule: b.declaration.semantic_rules[0].clone(),
                implementation: CheckImplementation::Plugin {
                    provider: b.checker.provider,
                },
            },
            input_digest: payload_digest("fixed raw input"),
            scope_digest: payload_digest("fixed raw proposal"),
            targets: vec![input.import_id.clone()],
            mandatory: true,
            waivable: false,
            not_applicable: None,
        }],
        input,
        proposal: proposal(),
    }
}
#[test]
fn translation_carries_fixed_evidence_and_original_unicode_references_without_project_ids() {
    let input = input();
    let output = proposal();
    validate_translation_extraction(&input, &output).unwrap();
    let artifact = &input.artifacts[0];
    for entry in &output.entries {
        for (reference, expected) in [
            (&entry.source, entry.text.as_str()),
            (
                entry.native_identity.display.source.as_ref().unwrap(),
                entry.native_identity.display.value.as_str(),
            ),
        ] {
            assert_eq!(reference.range.encoding, TextEncoding::Utf8Byte);
            let range = reference.range;
            assert_eq!(
                serde_json::from_slice::<String>(
                    &artifact.utf8.as_bytes()[range.start as usize..range.end as usize]
                )
                .unwrap(),
                expected
            );
        }
    }
    assert_eq!(output.declared_language, "zh");
    assert_eq!(output.target_language, "zh-CN");
    assert_eq!(output.entries[1].text, "");
    let mut empty = output.clone();
    empty.entries.clear();
    empty.order.clear();
    // Complete file decoding is a domain conclusion, never guessed by SDK.
    validate_translation_extraction(&input, &empty).unwrap();
    let mut forged = output;
    forged.entries[0].text = "structurally valid forged text".into();
    validate_translation_extraction(&input, &forged).unwrap();
    let mut raw = serde_json::to_value(&forged).unwrap();
    raw["entries"][0]["unitId"] = json!("authoritative-unit");
    assert!(parse_translation_exchange(&serde_json::to_vec(&raw).unwrap()).is_err());
}
#[test]
fn translation_association_refuses_changed_scope_and_rehashed_replacement_material() {
    let input = input();
    for mutation in 0..7 {
        let mut out = proposal();
        match mutation {
            0 => out.source_snapshot_id = "different-source".into(),
            1 => out.source_set_id = "different-set".into(),
            2 => out.import_id = "different-import".into(),
            3 => out.target_language = "ja".into(),
            4 => {
                out.native_scope.namespace = "different".into();
                for entry in &mut out.entries {
                    entry.native_identity.namespace = "different".into();
                }
            }
            5 => {
                out.artifacts[0].utf8.push(' ');
                out.artifacts[0].sha256 = payload_digest(&out.artifacts[0].utf8);
            }
            _ => out.profile.behavior_version += 1,
        }
        out.validate().unwrap();
        assert!(
            validate_translation_extraction(&input, &out).is_err(),
            "case {mutation}"
        );
    }
}
#[test]
fn translation_structure_refuses_coverage_identity_range_hash_and_unknown_fields() {
    for mutation in 0..7 {
        let mut out = proposal();
        match mutation {
            0 => out.order.pop().map(|_| ()).unwrap(),
            1 => out.order[1] = out.order[0].clone(),
            2 => out.entries[1].id = out.entries[0].id.clone(),
            3 => out.entries[0].source.artifact_id = "absent".into(),
            4 => out.entries[0].source.range.end = u32::MAX,
            5 => out.entries[0].native_identity.policy.behavior_version += 1,
            _ => out.artifacts[0].sha256 = "0".repeat(64),
        }
        assert!(out.validate().is_err(), "case {mutation}");
    }
    let input = input();
    let raw = serde_json::to_string(&input).unwrap();
    let duplicate = raw.replacen(
        "\"importId\":\"import-1\"",
        "\"importId\":\"other\",\"importId\":\"import-1\"",
        1,
    );
    assert_ne!(raw, duplicate);
    assert!(parse_translation_extraction_input(duplicate.as_bytes()).is_err());
    let mut value: Value = serde_json::from_str(&raw).unwrap();
    value["grant"] = json!(true);
    assert!(parse_translation_extraction_input(&serde_json::to_vec(&value).unwrap()).is_err());
    value.as_object_mut().unwrap().remove("grant");
    value["languageEvidence"] = json!("inferred");
    assert!(parse_translation_extraction_input(&serde_json::to_vec(&value).unwrap()).is_err());
}
#[test]
fn translation_limits_are_complete_byte_and_entry_limits() {
    let mut out = proposal();
    out.entries[0].text = "é".repeat(MAX_TEXT_BYTES / 2);
    out.validate().unwrap();
    out.entries[0].text.push('x');
    assert!(out.validate().is_err());
    let entry = proposal().entries[0].clone();
    out.entries.clear();
    out.order.clear();
    for i in 0..MAX_CONTENT_ITEMS {
        let mut row = entry.clone();
        row.id = format!("entry-{i}");
        out.order.push(row.id.clone());
        out.entries.push(row);
    }
    out.validate().unwrap();
    let mut extra = entry;
    extra.id = "extra".into();
    out.order.push(extra.id.clone());
    out.entries.push(extra);
    assert!(out.validate().is_err());
    assert!(parse_translation_extraction_input(&vec![b' '; MAX_EXCHANGE_BYTES + 1]).is_err());
    assert!(
        parse_translation_extraction_check_input(&vec![b' '; MAX_INVOCATION_PAYLOAD_BYTES + 1])
            .is_err()
    );
    let mut too_large = input();
    too_large.artifacts[0].utf8 = "x".repeat(MAX_EXCHANGE_BYTES);
    too_large.artifacts[0].sha256 = payload_digest(&too_large.artifacts[0].utf8);
    assert!(too_large.validate().is_err()); // Exact bytes plus mandatory metadata.
}
#[test]
fn translation_requires_complete_independent_nonwaivable_plugin_coverage() {
    let original = check();
    original.validate().unwrap();
    for mutation in 0..6 {
        let mut captured = original.clone();
        match mutation {
            0 => captured.requirements.clear(),
            1 => captured.requirements[0].waivable = true,
            2 => captured.requirements[0].mandatory = false,
            3 => captured.requirements[0].targets = vec!["other".into()],
            4 => captured.requirements.push(captured.requirements[0].clone()),
            _ => {
                captured.requirements[0].key.implementation = CheckImplementation::Core {
                    validator: captured.requirements[0].key.rule.clone(),
                }
            }
        }
        assert!(captured.validate().is_err(), "case {mutation}");
    }
}
#[test]
fn translation_resource_binds_exact_providers_and_bounds_single_material() {
    let original = binding();
    original.validate_input(&input()).unwrap();
    let mut forged = original.clone();
    forged.checker.provider.package_digest = "b".repeat(64);
    assert!(forged.validate().is_err());
    for path in [
        "elsewhere/zh.json",
        "i18n/deep/zh.json",
        "i18n/zh.vtt",
        "i18n/.json",
        "i18n/CON.json",
        "i18n/../zh.json",
    ] {
        let mut captured = input();
        captured.artifacts[0].logical_path = path.into();
        assert!(original.validate_input(&captured).is_err(), "{path}");
    }
    let mut max = input();
    max.artifacts[0].utf8 = "x".repeat(131072);
    max.artifacts[0].sha256 = payload_digest(&max.artifacts[0].utf8);
    original.validate_input(&max).unwrap();
    max.artifacts[0].utf8.push('x');
    max.artifacts[0].sha256 = payload_digest(&max.artifacts[0].utf8);
    assert!(original.validate_input(&max).is_err());
    for change in 0..5 {
        let mut manifest: PluginManifest =
            serde_json::from_slice(include_bytes!("fixtures/translation-import.manifest.json"))
                .unwrap();
        let ContributionKind::Capability { declaration: d } =
            &mut manifest.contributions[2].contribution
        else {
            unreachable!()
        };
        match change {
            0 => d.input_schema.schema_version += 1,
            1 => d.output_schema = translation_exchange_contract(),
            2 => d.profiles[0].behavior_version += 1,
            3 => {
                d.permissions.push(PermissionRequest::StagedOutput);
                manifest.permissions.push(PermissionRequest::StagedOutput);
            }
            _ => d.effect = EffectKind::Proposal,
        }
        assert!(
            declaration()
                .bind(&manifest.validate().unwrap(), &"a".repeat(64))
                .is_err()
        );
    }
}
