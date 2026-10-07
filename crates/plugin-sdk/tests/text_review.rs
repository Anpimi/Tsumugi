use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

fn declaration() -> TextReviewDeclaration {
    parse_text_review_declaration(include_bytes!("fixtures/text-review.declaration.json")).unwrap()
}
fn manifest() -> PluginManifest {
    serde_json::from_slice(include_bytes!("fixtures/text-review.manifest.json")).unwrap()
}
fn binding() -> TextReviewBinding {
    declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64))
        .unwrap()
}
fn input() -> TextReviewCheckInput {
    parse_text_review_input(include_bytes!("fixtures/text-review.input.json")).unwrap()
}
fn report() -> TextReviewCheckReport {
    parse_text_review_report(include_bytes!("fixtures/text-review.report.json")).unwrap()
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
fn text_review_keeps_explicit_subset_exact_resource_and_original_unicode() {
    let original = input();
    let binding = binding();
    binding.validate_input(&original).unwrap();
    binding.validate_report(&original, &report()).unwrap();
    assert_eq!(binding.declaration.rules.len(), 2);
    assert_eq!(original.requirements.len(), 1);
    assert_eq!(
        original.resources[0].sha256,
        payload_digest(include_str!("fixtures/text-review.resource.json"))
    );
    assert_eq!(
        parse_text_review_input(&serde_json::to_vec(&original).unwrap()).unwrap(),
        original
    );
    assert_eq!(
        parse_text_review_declaration(&serde_json::to_vec(&declaration()).unwrap()).unwrap(),
        declaration()
    );
    assert_eq!(
        parse_text_review_report(&serde_json::to_vec(&report()).unwrap()).unwrap(),
        report()
    );
    assert!(original.selections[0].source_text.contains("e\u{301}"));
    assert!(
        original.selections[0]
            .translation_text
            .as_ref()
            .unwrap()
            .contains("👩🏽‍💻")
    );
    assert_eq!(text_review_declaration_contract().behavior_version, 1);
    assert_eq!(text_review_input_contract().schema_version, 1);
    assert_eq!(
        text_review_report_contract().id,
        "tsumugi.text-review-report"
    );
}

#[test]
fn text_review_accepts_reordered_explicit_rules_without_selecting_undeclared_rules() {
    let mut input = input();
    let mut other = input.requirements[0].clone();
    other.key.rule = declaration().rules[1].rule.clone();
    input.requirements.insert(0, other);
    binding().validate_input(&input).unwrap();
    let mut report = report();
    report.results.push(completed(&input.requirements[0]));
    report.validate_against(&input).unwrap();
    input.requirements[0].key.rule.id = "example.not-declared".into();
    assert!(binding().validate_input(&input).is_err());
}

#[test]
fn text_review_rejects_mandatory_waivable_core_foreign_or_ambiguous_inputs() {
    for case in 0..12 {
        let mut input = input();
        match case {
            0 => input.requirements.clear(),
            1 => input.requirements[0].mandatory = true,
            2 => input.requirements[0].waivable = true,
            3 => {
                input.requirements[0].key.implementation = CheckImplementation::Core {
                    validator: review_check_input_contract(),
                }
            }
            4 => input.requirements[0].targets = vec!["foreign-unit".into()],
            5 => input.selections.push(input.selections[0].clone()),
            6 => input.requirements.push(input.requirements[0].clone()),
            7 => input.requirements[0].input_digest = "not-a-digest".into(),
            8 => input.requirements[0].scope_digest = "not-a-digest".into(),
            9 => input.source_language = "../en".into(),
            10 => input.target_language = "../zh-CN".into(),
            _ => {
                let mut other = input.requirements[0].clone();
                other.key.rule = declaration().rules[1].rule.clone();
                let CheckImplementation::Plugin { provider } = &mut other.key.implementation else {
                    unreachable!()
                };
                provider.package_digest = "d".repeat(64);
                input.requirements.push(other);
            }
        }
        assert!(input.validate().is_err(), "case {case}");
    }
    for case in 0..3 {
        let mut input = input();
        match case {
            0 => input.profile.behavior_version += 1,
            1 => input.requirements[0].key.rule.behavior_version += 1,
            _ => {
                let CheckImplementation::Plugin { provider } =
                    &mut input.requirements[0].key.implementation
                else {
                    unreachable!()
                };
                provider.plugin.id = "other-checker".into();
            }
        }
        input.validate().unwrap();
        assert!(binding().validate_input(&input).is_err(), "case {case}");
    }
}

#[test]
fn text_review_binds_resources_to_declared_same_package_contributions() {
    for case in 0..6 {
        let mut input = input();
        match case {
            0 => input.resources.clear(),
            1 => input.resources[0].contribution_id = "undeclared".into(),
            2 => input.resources[0].schema.behavior_version += 1,
            3 => input.resources[0].sha256 = "invalid".into(),
            4 => input.resources.push(input.resources[0].clone()),
            _ => {
                let mut extra = input.resources[0].clone();
                extra.contribution_id = "extra".into();
                input.resources.push(extra);
            }
        }
        assert!(binding().validate_input(&input).is_err(), "case {case}");
    }
    // A syntactically valid digest is not proof of the actual Resource bytes.
    let mut claimed = input();
    claimed.resources[0].sha256 = "d".repeat(64);
    binding().validate_input(&claimed).unwrap();
    for case in 0..2 {
        let mut manifest = manifest();
        if case == 0 {
            manifest.contributions.remove(1);
        } else {
            manifest.contributions[1].contribution = ContributionKind::Skill {
                path: "terms.md".into(),
            };
        }
        assert!(
            declaration()
                .bind(&manifest.validate().unwrap(), &"a".repeat(64))
                .is_err()
        );
    }
}

#[test]
fn text_review_declaration_refuses_changed_capability_effects_and_permissions() {
    for case in 0..7 {
        let mut manifest = manifest();
        let ContributionKind::Capability {
            declaration: capability,
        } = &mut manifest.contributions[2].contribution
        else {
            unreachable!()
        };
        match case {
            0 => capability.input_schema.behavior_version += 1,
            1 => capability.output_schema = check_results_contract(),
            2 => capability.error_schema = source_extraction_error_contract(),
            3 => capability.profiles.clear(),
            4 => capability.effect = EffectKind::Proposal,
            5 => capability.permissions.clear(),
            _ => {
                capability.permissions.push(PermissionRequest::StagedOutput);
                manifest.permissions.push(PermissionRequest::StagedOutput);
            }
        }
        let actual = manifest.validate().unwrap();
        assert!(
            declaration().bind(&actual, &"a".repeat(64)).is_err(),
            "case {case}"
        );
    }
    for case in 0..6 {
        let mut declaration = declaration();
        match case {
            0 => declaration.rules.clear(),
            1 => declaration.rules.push(declaration.rules[0].clone()),
            2 => declaration.supporting_resources.push("terms".into()),
            3 => declaration.rules[0].title.clear(),
            4 => declaration.rules[0].description = "\0".into(),
            _ => declaration.rules[0].description = "x".repeat(MAX_REVIEW_ERROR_DETAIL_BYTES + 1),
        }
        assert!(declaration.validate().is_err(), "case {case}");
    }
}

#[test]
fn text_review_missing_translation_na_requires_captured_scope_and_declared_permission() {
    let mut input = input();
    input.selections[0].translation_text = None;
    input.requirements[0].not_applicable = Some(NotApplicableBasis {
        code: MISSING_REVIEW_TRANSLATION.into(),
        basis_digest: "d".repeat(64),
    });
    binding().validate_input(&input).unwrap();
    let mut report = report();
    report.diagnostics.clear();
    report.results[0].outcome = CheckOutcome::NotApplicable {
        basis: input.requirements[0].not_applicable.clone().unwrap(),
    };
    binding().validate_report(&input, &report).unwrap();
    if let CheckOutcome::NotApplicable { basis } = &mut report.results[0].outcome {
        basis.basis_digest = "e".repeat(64);
    }
    assert!(report.validate_against(&input).is_err());
    let mut source_only = input.clone();
    source_only.requirements[0].key.rule = declaration().rules[1].rule.clone();
    source_only.validate().unwrap();
    assert!(binding().validate_input(&source_only).is_err());
    for text in [Some(String::new()), Some("selected".into())] {
        input.selections[0].translation_text = text;
        assert!(input.validate().is_err());
    }
    input.selections[0].translation_text = None;
    input.requirements[0].not_applicable.as_mut().unwrap().code = "guessed-irrelevant".into();
    assert!(input.validate().is_err());
}

#[test]
fn text_review_missing_empty_and_mixed_text_stay_distinct() {
    for text in [None, Some(String::new())] {
        let mut input = input();
        input.selections[0].translation_text = text.clone();
        binding().validate_input(&input).unwrap();
        assert_eq!(
            parse_text_review_input(&serde_json::to_vec(&input).unwrap())
                .unwrap()
                .selections[0]
                .translation_text,
            text
        );
    }
    let mut input = input();
    input.selections[0].translation_text = None;
    let mut selected = input.selections[0].clone();
    selected.unit_id = "unit-1".into();
    selected.translation_text = Some(String::new());
    input.selections.push(selected);
    input.requirements[0].targets.push("unit-1".into());
    binding().validate_input(&input).unwrap();
    input.requirements[0].not_applicable = Some(NotApplicableBasis {
        code: MISSING_REVIEW_TRANSLATION.into(),
        basis_digest: "d".repeat(64),
    });
    assert!(input.validate().is_err());
}

#[test]
fn text_review_report_requires_every_selected_rule_and_exact_result_basis() {
    for case in 0..9 {
        let mut report = report();
        report.diagnostics.clear();
        match case {
            0 => report.results.clear(),
            1 => report.results.push(report.results[0].clone()),
            2 => report.results[0].key.rule = declaration().rules[1].rule.clone(),
            3 => report.results[0].input_digest = "d".repeat(64),
            4 => report.results[0].scope_digest = "d".repeat(64),
            5 => report.results[0].covered_targets = vec!["other-unit".into()],
            6 => {
                let CheckImplementation::Plugin { provider } =
                    &mut report.results[0].key.implementation
                else {
                    unreachable!()
                };
                provider.package_digest = "d".repeat(64);
            }
            7 => {
                report.results[0].key.implementation = CheckImplementation::Core {
                    validator: review_check_input_contract(),
                }
            }
            _ => {
                report.results[0].outcome = CheckOutcome::NotApplicable {
                    basis: NotApplicableBasis {
                        code: MISSING_REVIEW_TRANSLATION.into(),
                        basis_digest: "d".repeat(64),
                    },
                }
            }
        }
        assert!(report.validate_against(&input()).is_err(), "case {case}");
    }
    let mut full_input = input();
    let mut extra = full_input.requirements[0].clone();
    extra.key.rule = declaration().rules[1].rule.clone();
    full_input.requirements.push(extra);
    assert!(report().validate_against(&full_input).is_err());
    for outcome in [
        CheckOutcome::Failed,
        CheckOutcome::Cancelled,
        CheckOutcome::Unavailable,
    ] {
        let mut report = report();
        report.diagnostics.clear();
        report.results[0].outcome = outcome;
        report.validate_against(&input()).unwrap();
    }
}

#[test]
fn text_review_diagnostics_cannot_invent_findings_or_resource_entries() {
    for case in 0..8 {
        let mut report = report();
        match case {
            0 => report.diagnostics[0].code = "invented-finding".into(),
            1 => report.diagnostics[0].target = "other-unit".into(),
            2 => report.diagnostics[0].key.rule = declaration().rules[1].rule.clone(),
            3 => report.diagnostics.push(report.diagnostics[0].clone()),
            4 => report.results[0].outcome = CheckOutcome::Failed,
            5 => {
                report.diagnostics[0]
                    .resource_entry
                    .as_mut()
                    .unwrap()
                    .contribution_id = "foreign-resource".into()
            }
            6 => report.diagnostics[0].detail = Some("\0".into()),
            _ => report.diagnostics[0].suggestion = Some("x".repeat(MAX_TEXT_BYTES + 1)),
        }
        assert!(report.validate_against(&input()).is_err(), "case {case}");
    }
}

#[test]
fn text_review_ranges_use_the_captured_field_and_exact_scalar_boundaries() {
    let input = input();
    let mut report = report();
    for (field, text) in [
        (
            TextReviewField::Source,
            input.selections[0].source_text.as_str(),
        ),
        (
            TextReviewField::Translation,
            input.selections[0]
                .translation_text
                .as_ref()
                .unwrap()
                .as_str(),
        ),
    ] {
        for encoding in [
            TextEncoding::Utf8Byte,
            TextEncoding::Utf16,
            TextEncoding::Grapheme,
        ] {
            let range = convert_text_range(
                text,
                TextRange {
                    encoding: TextEncoding::Utf8Byte,
                    start: 0,
                    end: text.len() as u32,
                },
                encoding,
            )
            .unwrap();
            report.diagnostics[0].location = Some(TextReviewLocation { field, range });
            report.validate_against(&input).unwrap();
        }
    }
    for range in [
        TextRange {
            encoding: TextEncoding::Utf16,
            start: 1,
            end: 2,
        },
        TextRange {
            encoding: TextEncoding::Utf8Byte,
            start: 1,
            end: 4,
        },
        TextRange {
            encoding: TextEncoding::Utf16,
            start: 0,
            end: 14,
        },
        TextRange {
            encoding: TextEncoding::Grapheme,
            start: 0,
            end: 100,
        },
        TextRange {
            encoding: TextEncoding::Utf16,
            start: 2,
            end: 0,
        },
    ] {
        report.diagnostics[0].location = Some(TextReviewLocation {
            field: TextReviewField::Translation,
            range,
        });
        assert!(report.validate_against(&input).is_err());
    }
    report.diagnostics[0].location = Some(TextReviewLocation {
        field: TextReviewField::Translation,
        range: TextRange {
            encoding: TextEncoding::Utf16,
            start: 0,
            end: 0,
        },
    });
    let mut missing = input.clone();
    missing.selections[0].translation_text = None;
    assert!(report.validate_against(&missing).is_err());
    missing.selections[0].translation_text = Some(String::new());
    report.validate_against(&missing).unwrap();
}

#[test]
fn text_review_limits_count_escaped_encoding_and_actual_capability_limits() {
    let mut large = input();
    large.selections[0].source_text = "é".repeat(MAX_TEXT_BYTES / 2 + 1);
    assert_eq!(
        large.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    let mut large = input();
    large.selections = (0..50)
        .map(|index| TextReviewSelection {
            unit_id: format!("unit-{index}"),
            source_revision_id: format!("revision-{index}"),
            source_text: "\0".repeat(MAX_TEXT_BYTES),
            translation_text: None,
        })
        .collect();
    large.requirements[0].targets = large.selections.iter().map(|s| s.unit_id.clone()).collect();
    assert_eq!(
        large.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    let mut limited = binding();
    limited.checker.declaration.limits.max_input_bytes = 1;
    assert!(limited.validate_input(&input()).is_err());
    let mut limited = binding();
    limited.checker.declaration.limits.max_output_bytes = 1;
    assert!(limited.validate_report(&input(), &report()).is_err());
    let mut large = report();
    let template = large.diagnostics[0].clone();
    large.diagnostics = (0..100)
        .map(|index| TextReviewDiagnostic {
            code: format!("finding-{index}"),
            detail: Some("\u{1}".repeat(MAX_REVIEW_ERROR_DETAIL_BYTES)),
            ..template.clone()
        })
        .collect();
    large.results[0].outcome = CheckOutcome::Completed {
        findings: large
            .diagnostics
            .iter()
            .map(|diagnostic| CheckFinding {
                code: diagnostic.code.clone(),
                target: diagnostic.target.clone(),
                severity: FindingSeverity::Warning,
            })
            .collect(),
    };
    assert_eq!(
        large.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    assert_eq!(
        parse_text_review_input(&vec![b' '; MAX_INVOCATION_PAYLOAD_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
    assert_eq!(
        parse_text_review_report(&vec![b' '; MAX_EXCHANGE_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
}

#[test]
fn text_review_strict_schema_refuses_unrecognized_fields_and_mandatory_disposition() {
    for fixture in [
        include_bytes!("fixtures/text-review.declaration.json").as_slice(),
        include_bytes!("fixtures/text-review.input.json").as_slice(),
        include_bytes!("fixtures/text-review.report.json").as_slice(),
    ] {
        let mut value: Value = serde_json::from_slice(fixture).unwrap();
        value["authority"] = json!("approved");
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(parse_text_review_declaration(&bytes).is_err());
        assert!(parse_text_review_input(&bytes).is_err());
        assert!(parse_text_review_report(&bytes).is_err());
    }
    let mut value = serde_json::to_value(declaration()).unwrap();
    value["disposition"] = json!("mandatory");
    assert!(parse_text_review_declaration(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn advisory_text_reports_never_replace_required_format_coverage() {
    let format_input =
        parse_review_check_input(include_bytes!("fixtures/review.input.json")).unwrap();
    let format_declaration =
        parse_review_declaration(include_bytes!("fixtures/review.declaration.json")).unwrap();
    let format_manifest = parse_manifest(include_bytes!("fixtures/review.manifest.json")).unwrap();
    let format_binding = format_declaration
        .bind(&format_manifest, &"a".repeat(64))
        .unwrap();
    format_binding.validate_input(&format_input).unwrap();
    let mut weakened = format_input.clone();
    weakened.requirements[0].mandatory = false;
    assert!(format_binding.validate_input(&weakened).is_err());
    let mut core = format_input.requirements[0].clone();
    core.key = CheckKey {
        rule: review_check_input_contract(),
        implementation: CheckImplementation::Core {
            validator: review_check_input_contract(),
        },
    };
    let mut domain = format_input.requirements.clone();
    domain.extend(input().requirements);
    let fixed =
        capture_required_checks(review_check_input_contract(), vec![core.clone()], domain).unwrap();
    let mut results = vec![completed(&core)];
    results.extend(format_input.requirements.iter().map(completed));
    results.extend(report().results);
    assert!(fixed.evaluate(&results).unwrap().complete);
    results.retain(|r| r.key != format_input.requirements[0].key);
    assert!(!fixed.evaluate(&results).unwrap().complete);
    results.push(completed(&format_input.requirements[0]));
    results.retain(|r| r.key != input().requirements[0].key);
    assert!(fixed.evaluate(&results).unwrap().complete);
    // The advisory union may be complete without that provider, but an empty
    // successful text report cannot pretend the explicitly requested work ran.
    assert!(
        TextReviewCheckReport {
            results: vec![],
            diagnostics: vec![]
        }
        .validate_against(&input())
        .is_err()
    );
}

#[cfg(feature = "schema")]
#[test]
fn text_review_generated_schemas_are_current() {
    for (bytes, schema) in [
        (
            include_bytes!("../schemas/text-review-declaration.schema.json").as_slice(),
            text_review_declaration_schema(),
        ),
        (
            include_bytes!("../schemas/text-review-input.schema.json").as_slice(),
            text_review_input_schema(),
        ),
        (
            include_bytes!("../schemas/text-review-report.schema.json").as_slice(),
            text_review_report_schema(),
        ),
        (
            include_bytes!("../schemas/text-review-types.schema.json").as_slice(),
            text_review_types_schema(),
        ),
    ] {
        let actual: Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(actual, serde_json::to_value(schema).unwrap());
    }
}
