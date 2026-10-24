use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

fn declaration() -> ReviewDeclaration {
    parse_review_declaration(include_bytes!("fixtures/review.declaration.json")).unwrap()
}
fn manifest() -> PluginManifest {
    serde_json::from_slice(include_bytes!("fixtures/review.manifest.json")).unwrap()
}
fn binding() -> ReviewBinding {
    declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64))
        .unwrap()
}
fn input() -> ReviewCheckInput {
    parse_review_check_input(include_bytes!("fixtures/review.input.json")).unwrap()
}
fn core_requirement(input: &ReviewCheckInput) -> CheckRequirement {
    let mut requirement = input.requirements[0].clone();
    requirement.key = CheckKey {
        rule: ContractRef {
            id: "core.required-translation".into(),
            schema_version: 1,
            behavior_version: 1,
        },
        implementation: CheckImplementation::Core {
            validator: review_check_input_contract(),
        },
    };
    requirement
}
fn completed(requirement: &CheckRequirement) -> CheckResult {
    CheckResult {
        key: requirement.key.clone(),
        input_digest: requirement.input_digest.clone(),
        scope_digest: requirement.scope_digest.clone(),
        covered_targets: requirement.targets.clone(),
        outcome: CheckOutcome::Completed { findings: vec![] },
    }
}

#[test]
fn review_roundtrip_preserves_original_evidence_unicode_and_missing_vs_empty_text() {
    let original = input();
    binding().validate_input(&original).unwrap();
    assert_eq!(binding().checker.provider.plugin.id, "third-format");
    assert_eq!(
        parse_review_check_input(&serde_json::to_vec(&original).unwrap()).unwrap(),
        original
    );
    assert!(!original.source.domain_blocks.is_empty());
    assert!(
        original.selections[0]
            .translation_text
            .as_ref()
            .unwrap()
            .contains("e\u{301}")
    );
    for text in [None, Some(String::new())] {
        let mut input = original.clone();
        input.selections[0].translation_text = text.clone();
        binding().validate_input(&input).unwrap();
        let parsed = parse_review_check_input(&serde_json::to_vec(&input).unwrap()).unwrap();
        assert_eq!(parsed.selections[0].translation_text, text);
        assert_eq!(parsed.source, original.source);
    }
}

// Pad an already valid opaque extension using actual wire encoding. Newlines
// consume two JSON bytes each without exceeding the block's raw UTF-8 budget.
fn input_with_encoded_size(
    size: usize,
    encoded_len: impl Fn(&ReviewCheckInput) -> usize,
) -> ReviewCheckInput {
    let mut value = input();
    let block = value.source.domain_blocks.last_mut().unwrap();
    assert_eq!(block.schema.id, "example.unknown.metadata");
    assert_eq!(block.handling, ExtensionHandling::Preserve);
    block.payload_utf8.push_str("🧵 e\u{301} \"\\\0\t\r\n");
    let padding = size.checked_sub(encoded_len(&value)).unwrap();
    let block = value.source.domain_blocks.last_mut().unwrap();
    block.payload_utf8.push_str(&"\n".repeat(padding / 2));
    if padding % 2 != 0 {
        block.payload_utf8.push('x');
    }
    assert!(block.payload_utf8.len() <= MAX_EXCHANGE_BYTES);
    assert_eq!(encoded_len(&value), size);
    value
}

#[test]
fn review_input_encoded_boundary_preserves_unicode_escapes_and_complete_request_limit() {
    let mut value = input_with_encoded_size(MAX_INVOCATION_PAYLOAD_BYTES, |input| {
        serde_json::to_vec(input).unwrap().len()
    });
    let bytes = serde_json::to_vec(&value).unwrap();
    assert_eq!(bytes.len(), MAX_INVOCATION_PAYLOAD_BYTES);
    assert!(serde_json::to_vec(&value.source).unwrap().len() < MAX_CONTENT_EXCHANGE_BYTES);
    binding().validate_input(&value).unwrap();
    assert_eq!(parse_review_check_input(&bytes).unwrap(), value);

    value
        .source
        .domain_blocks
        .last_mut()
        .unwrap()
        .payload_utf8
        .push('x');
    let bytes = serde_json::to_vec(&value).unwrap();
    assert_eq!(bytes.len(), MAX_INVOCATION_PAYLOAD_BYTES + 1);
    value.source.validate().unwrap();
    let error = value.validate().unwrap_err();
    assert_eq!(error.code, ContractErrorCode::LimitExceeded);
    assert_eq!(error.field, "reviewCheckInput");
    assert_eq!(parse_review_check_input(&bytes).unwrap_err(), error);
}

#[test]
fn review_source_validation_keeps_encoded_boundary_and_original_first_error() {
    let mut value = input_with_encoded_size(MAX_CONTENT_EXCHANGE_BYTES, |input| {
        serde_json::to_vec(&input.source).unwrap().len()
    });
    value.source.validate().unwrap();
    assert!(serde_json::to_vec(&value).unwrap().len() > MAX_INVOCATION_PAYLOAD_BYTES);
    let outer = value.validate().unwrap_err();
    assert_eq!(outer.code, ContractErrorCode::LimitExceeded);
    assert_eq!(outer.field, "reviewCheckInput");

    value
        .source
        .domain_blocks
        .last_mut()
        .unwrap()
        .payload_utf8
        .push('x');
    assert_eq!(
        serde_json::to_vec(&value.source).unwrap().len(),
        MAX_CONTENT_EXCHANGE_BYTES + 1
    );
    let error = value.source.validate().unwrap_err();
    assert_eq!(error.code, ContractErrorCode::LimitExceeded);
    assert_eq!(error.field, "contentExchange");
    value.target_language = "invalid/language".into();
    assert_eq!(value.validate().unwrap_err(), error);

    let mut invalid = input();
    invalid.source.domain_blocks.last_mut().unwrap().target = ContentTarget::Unit {
        id: "outside-source".into(),
    };
    invalid.target_language = "invalid/language".into();
    let error = invalid.source.validate().unwrap_err();
    assert_eq!(error.code, ContractErrorCode::InvalidDeclaration);
    assert_eq!(error.field, "content.domainBlocks.target");
    assert_eq!(invalid.validate().unwrap_err(), error);
}

#[test]
fn review_rejects_changed_revision_foreign_scope_duplicate_selection_and_text_overflow() {
    for change in 0..7 {
        let mut input = input();
        match change {
            0 => input.selections.clear(),
            1 => input.selections.push(input.selections[0].clone()),
            2 => input.selections[0].unit_id = "outside-scope".into(),
            3 => input.selections[0].source_revision_id = "other-revision".into(),
            4 => input.target_language = "../zh-CN".into(),
            5 => input.selections[0].translation_text = Some("é".repeat(MAX_TEXT_BYTES / 2 + 1)),
            _ => input.requirements[0].targets = vec![input.source.units[1].id.clone()],
        }
        assert!(input.validate().is_err(), "case {change}");
    }
}

#[test]
fn review_requires_one_exact_plugin_and_nonwaivable_mandatory_scope() {
    for change in 0..8 {
        let mut input = input();
        match change {
            0 => input.requirements.clear(),
            1 => input.requirements.push(input.requirements[0].clone()),
            2 => input.requirements[0].mandatory = false,
            3 => input.requirements[0].waivable = true,
            4 => {
                input.requirements[0].key.implementation =
                    core_requirement(&input).key.implementation
            }
            5 => {
                let CheckImplementation::Plugin { provider } =
                    &mut input.requirements[0].key.implementation
                else {
                    unreachable!()
                };
                provider.package_digest = "d".repeat(64);
            }
            6 => input.requirements[0].input_digest = "invalid".into(),
            _ => input.requirements[0].scope_digest = "invalid".into(),
        }
        assert!(input.validate().is_err(), "case {change}");
    }
}

#[test]
fn review_binding_refuses_missing_extra_wrong_version_and_self_reported_provider_rules() {
    for change in 0..6 {
        let mut input = input();
        match change {
            0 => {
                input.requirements.pop();
            }
            1 => input.requirements[0].key.rule.behavior_version += 1,
            2 => input.source.profile.schema_version += 1,
            3 => {
                for requirement in &mut input.requirements {
                    let CheckImplementation::Plugin { provider } =
                        &mut requirement.key.implementation
                    else {
                        unreachable!()
                    };
                    provider.contribution_id = "other-checker".into();
                }
            }
            4 => input.requirements[0].key.rule.id = "core.required-translation".into(),
            _ => {
                let mut extra = input.requirements[0].clone();
                extra.key.rule.id = "example.unselected-rule".into();
                input.requirements.push(extra);
            }
        }
        assert!(binding().validate_input(&input).is_err(), "case {change}");
    }
}

#[test]
fn review_n_a_requires_missing_translation_exact_basis_and_declared_dependency() {
    let mut input = input();
    let basis = NotApplicableBasis {
        code: MISSING_REVIEW_TRANSLATION.into(),
        basis_digest: "d".repeat(64),
    };
    input.requirements[1].not_applicable = Some(basis.clone());
    assert!(input.validate().is_err());
    input.selections[0].translation_text = None;
    binding().validate_input(&input).unwrap();
    let core = core_requirement(&input);
    let fixed = capture_required_checks(
        review_check_input_contract(),
        vec![core.clone()],
        input.requirements.clone(),
    )
    .unwrap();
    let mut results = vec![
        completed(&core),
        completed(&input.requirements[0]),
        completed(&input.requirements[1]),
    ];
    results[2].outcome = CheckOutcome::NotApplicable {
        basis: basis.clone(),
    };
    assert!(fixed.evaluate(&results).unwrap().complete);
    results[2].outcome = CheckOutcome::NotApplicable {
        basis: NotApplicableBasis {
            basis_digest: "e".repeat(64),
            ..basis.clone()
        },
    };
    assert!(fixed.evaluate(&results).is_err());
    input.requirements[0].not_applicable = Some(basis.clone());
    assert!(binding().validate_input(&input).is_err());
    input.requirements[0].not_applicable = None;
    let other = &input.source.units[1];
    input.selections.push(ReviewSelection {
        unit_id: other.id.clone(),
        source_revision_id: other.source_revision_id.clone(),
        translation_text: Some("selected".into()),
    });
    for requirement in &mut input.requirements {
        requirement.targets.push(other.id.clone());
    }
    assert!(input.validate().is_err());
    input.selections.pop();
    for requirement in &mut input.requirements {
        requirement.targets.pop();
    }
    input.requirements[1].not_applicable.as_mut().unwrap().code = "skip-everything".into();
    assert!(input.validate().is_err());
}

#[test]
fn captured_union_keeps_core_and_domain_missing_failed_and_wrong_version_coverage() {
    let input = input();
    let core = core_requirement(&input);
    let fixed = capture_required_checks(
        review_check_input_contract(),
        vec![core.clone()],
        input.requirements.clone(),
    )
    .unwrap();
    assert!(!fixed.evaluate(&[]).unwrap().complete);
    let mut results = vec![completed(&core)];
    assert!(!fixed.evaluate(&results).unwrap().complete);
    results.extend(input.requirements.iter().map(completed));
    assert!(fixed.evaluate(&results).unwrap().complete);
    let mut wrong = results.clone();
    wrong[1].key.rule.behavior_version += 1;
    assert!(fixed.evaluate(&wrong).is_err());
    wrong = results.clone();
    wrong.push(wrong[1].clone());
    assert!(fixed.evaluate(&wrong).is_err());
    for outcome in [
        CheckOutcome::Failed,
        CheckOutcome::Unavailable,
        CheckOutcome::Cancelled,
    ] {
        wrong = results.clone();
        wrong[1].outcome = outcome;
        assert!(!fixed.evaluate(&wrong).unwrap().complete);
    }
    assert!(!fixed.evaluate(&results[1..]).unwrap().complete);
    let mut forged = results;
    forged[1].input_digest = "e".repeat(64);
    assert!(fixed.evaluate(&forged).is_err());
}

#[test]
fn review_declaration_binds_only_read_only_exact_profile_contracts_and_captured_input() {
    for change in 0..7 {
        let mut manifest = manifest();
        let ContributionKind::Capability { declaration: d } =
            &mut manifest.contributions[1].contribution
        else {
            unreachable!()
        };
        match change {
            0 => d.input_schema.behavior_version += 1,
            1 => d.output_schema = content_exchange_contract(),
            2 => d.error_schema = source_extraction_error_contract(),
            3 => d.profiles[0].behavior_version += 1,
            4 => d.effect = EffectKind::Proposal,
            5 => {
                d.permissions.push(PermissionRequest::StagedOutput);
                manifest.permissions.push(PermissionRequest::StagedOutput);
            }
            _ => manifest.contributions[1].id = "other".into(),
        }
        assert!(
            declaration()
                .bind(&manifest.validate().unwrap(), &"a".repeat(64))
                .is_err(),
            "case {change}"
        );
    }
    let mut declaration = declaration();
    declaration.rules.clear();
    assert!(declaration.validate().is_err());
    declaration = binding().declaration;
    let mut duplicate = declaration.rules[0].clone();
    duplicate.rule.behavior_version += 1;
    declaration.rules.push(duplicate);
    assert!(declaration.validate().is_err());
}

#[test]
fn review_parsers_reject_unknown_duplicate_fields_limits_and_invalid_error_codes() {
    let raw = include_str!("fixtures/review.input.json");
    let duplicate = raw.replace(
        "\"targetLanguage\": \"zh-CN\"",
        "\"targetLanguage\": \"en-US\", \"targetLanguage\": \"zh-CN\"",
    );
    assert!(parse_review_check_input(duplicate.as_bytes()).is_err());
    let mut v: Value = serde_json::from_str(raw).unwrap();
    v["approved"] = json!(true);
    assert!(parse_review_check_input(&serde_json::to_vec(&v).unwrap()).is_err());
    assert!(parse_review_check_input(&vec![b' '; MAX_INVOCATION_PAYLOAD_BYTES + 1]).is_err());
    assert!(parse_review_declaration(&vec![b' '; MAX_REVIEW_DECLARATION_BYTES + 1]).is_err());
    let error = ReviewCheckError {
        code: ReviewCheckErrorCode::InvalidTranslation,
        unit_id: Some("unit-0".into()),
        detail: "Unsupported text structure".into(),
    };
    assert_eq!(
        parse_review_check_error(&serde_json::to_vec(&error).unwrap()).unwrap(),
        error
    );
    for detail in [
        String::new(),
        "\0".into(),
        "x".repeat(MAX_REVIEW_ERROR_DETAIL_BYTES + 1),
    ] {
        assert!(
            ReviewCheckError {
                detail,
                ..error.clone()
            }
            .validate()
            .is_err()
        );
    }
    assert!(
        parse_review_check_error(br#"{"code":"ignore","unitId":null,"detail":"Passed"}"#).is_err()
    );
}

#[cfg(feature = "schema")]
#[test]
fn review_generated_schemas_are_current() {
    for (bytes, schema) in [
        (
            include_bytes!("../schemas/review-check-input.schema.json").as_slice(),
            review_check_input_schema(),
        ),
        (
            include_bytes!("../schemas/review-declaration.schema.json").as_slice(),
            review_declaration_schema(),
        ),
        (
            include_bytes!("../schemas/review-check-error.schema.json").as_slice(),
            review_check_error_schema(),
        ),
        (
            include_bytes!("../schemas/review-types.schema.json").as_slice(),
            review_types_schema(),
        ),
    ] {
        let actual: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(actual, serde_json::to_value(schema).unwrap());
    }
}
