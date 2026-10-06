#![cfg(all(unix, feature = "javascript-conformance"))]
//! Actual independently packaged review components; no domain source import.
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk::*;
#[path = "support/official.rs"]
mod package_fixture;
use package_fixture::*;

fn source_input(profile: ContractRef, caption: bool) -> SourceExtractionInput {
    let files = if caption {
        vec![(
            "source",
            "source.vtt",
            "source",
            "\u{feff}WEBVTT\r\n\r\nCue\r\n00:01.000 --> 00:02.000\r\nOriginal é 👩🏽‍💻\r\n\r\n",
        )]
    } else {
        vec![
            (
                "manifest",
                "manifest.json",
                "companion",
                "{\"UniqueID\":\"Example.Mod\",\"Name\":\"Test\",\"Version\":\"1.0.0\",\"EntryDll\":\"Test.dll\"}",
            ),
            (
                "default",
                "i18n/default.json",
                "source",
                "\u{feff}{\r\n\"first\":\"Hi {{name}} {{name}} é 👩🏽‍💻\"\r\n}\r\n",
            ),
        ]
    };
    SourceExtractionInput {
        profile,
        source_set_id: "synthetic-source".into(),
        source_language: "en".into(),
        artifacts: files
            .into_iter()
            .map(|(id, path, role, utf8)| CapturedTextArtifact {
                id: id.into(),
                logical_path: path.into(),
                role: role.into(),
                sha256: payload_digest(utf8),
                utf8: utf8.into(),
            })
            .collect(),
    }
}
fn check_input(
    source: ContentExchange,
    binding: &ReviewBinding,
    text: Option<&str>,
) -> ReviewCheckInput {
    let unit = &source.units[0];
    let selected = ReviewSelection {
        unit_id: unit.id.clone(),
        source_revision_id: unit.source_revision_id.clone(),
        translation_text: text.map(str::to_owned),
    };
    let input_digest = payload_digest(&serde_json::to_string(&(&source, &selected)).unwrap());
    let scope_digest = payload_digest(&selected.unit_id);
    let requirements = binding
        .declaration
        .rules
        .iter()
        .map(|rule| CheckRequirement {
            key: CheckKey {
                rule: rule.rule.clone(),
                implementation: CheckImplementation::Plugin {
                    provider: binding.checker.provider.clone(),
                },
            },
            input_digest: input_digest.clone(),
            scope_digest: scope_digest.clone(),
            targets: vec![selected.unit_id.clone()],
            mandatory: true,
            waivable: false,
            not_applicable: (rule.requires_translation && text.is_none()).then(|| {
                NotApplicableBasis {
                    code: MISSING_REVIEW_TRANSLATION.into(),
                    basis_digest: payload_digest("captured-missing-text"),
                }
            }),
        })
        .collect();
    ReviewCheckInput {
        source,
        target_language: "zh-CN".into(),
        selections: vec![selected],
        requirements,
    }
}
fn results(received: ReceivedResult, input: &ReviewCheckInput) -> Vec<CheckResult> {
    let CheckImplementation::Plugin { provider } = &input.requirements[0].key.implementation else {
        panic!("plugin checker required")
    };
    assert_eq!(received.channel().provider.selection(), *provider);
    let payload = success_payload(received.result().outcome.clone());
    assert_eq!(payload.schema, check_results_contract());
    let results = parse_check_results(payload.utf8.as_bytes()).unwrap();
    assert_eq!(results.len(), input.requirements.len());
    for (result, requirement) in results.iter().zip(&input.requirements) {
        assert_eq!(result.key, requirement.key);
        assert_eq!(result.input_digest, requirement.input_digest);
        assert_eq!(result.scope_digest, requirement.scope_digest);
        assert_eq!(result.covered_targets, requirement.targets);
    }
    // This Core-tagged result represents only the SDK input validation actually
    // run above. It is a conformance fixture, not project approval/eligibility.
    let mut structure = input.requirements[0].clone();
    structure.key = CheckKey {
        rule: contract("conformance.review-structure"),
        implementation: CheckImplementation::Core {
            validator: contract("conformance.review-structure"),
        },
    };
    structure.not_applicable = None;
    let fixed = capture_required_checks(
        contract("conformance.review-policy"),
        vec![structure.clone()],
        input.requirements.clone(),
    )
    .unwrap();
    let mut combined = results.clone();
    combined.push(CheckResult {
        key: structure.key,
        input_digest: structure.input_digest,
        scope_digest: structure.scope_digest,
        covered_targets: structure.targets,
        outcome: CheckOutcome::Completed { findings: vec![] },
    });
    assert!(fixed.evaluate(&combined).unwrap().complete);
    assert!(!fixed.evaluate(&results).unwrap().complete); // The plugin cannot supply the Core member.
    results
}
async fn paired_review(plugin: &str, caption: bool) {
    let temporary = tempfile::tempdir().unwrap();
    let image = installed(temporary.path(), plugin);
    let source = image.source_import("source-profile").unwrap();
    let binding = image.review_declaration("review-profile").unwrap();
    assert_eq!(binding.declaration.profile, source.declaration.profile);
    let captured = source_input(source.declaration.profile.clone(), caption);
    captured.validate().unwrap();
    let mut extractor = launch(&image, "extract-source", temporary.path()).await;
    let extracted = success_payload(
        invoke(
            &mut extractor,
            &source.extractor,
            "extract-review-source",
            &serde_json::to_value(&captured).unwrap(),
        )
        .await,
    );
    let original = parse_content_exchange(extracted.utf8.as_bytes()).unwrap();
    validate_source_extraction(&captured, &original).unwrap();
    assert_eq!(original.artifacts, captured.artifacts);
    close_and_reap(&mut extractor).await;
    let mut checker = launch(&image, "review-check", temporary.path()).await;
    let valid_text = if caption {
        "译文 é 👩🏽‍💻\n第二行"
    } else {
        "你好 {{name}} {{name}} é 👩🏽‍💻"
    };
    for (dispatch, text, expected) in [
        ("review-good", Some(valid_text), None),
        (
            "review-bad",
            Some(if caption { "a\n\nb" } else { "你好 {{name}}" }),
            Some(if caption {
                "invalid-payload"
            } else {
                "marker-mismatch"
            }),
        ),
    ] {
        let input = check_input(original.clone(), &binding, text);
        binding.validate_input(&input).unwrap();
        let received = invoke_received(
            &mut checker,
            &binding.checker,
            dispatch,
            &serde_json::to_value(&input).unwrap(),
        )
        .await;
        let output = results(received, &input);
        let findings: Vec<_> = output
            .iter()
            .flat_map(|result| match &result.outcome {
                CheckOutcome::Completed { findings } => findings.clone(),
                _ => panic!("present valid syntax must complete"),
            })
            .collect();
        assert_eq!(
            findings,
            expected
                .map(|code| CheckFinding {
                    code: code.into(),
                    target: input.selections[0].unit_id.clone(),
                    severity: FindingSeverity::Error
                })
                .into_iter()
                .collect::<Vec<_>>()
        );
        assert_eq!(input.source, original);
    }
    let missing = check_input(original.clone(), &binding, None);
    binding.validate_input(&missing).unwrap();
    let received = invoke_received(
        &mut checker,
        &binding.checker,
        "review-missing",
        &serde_json::to_value(&missing).unwrap(),
    )
    .await;
    let output = results(received, &missing);
    for (result, requirement) in output.iter().zip(&missing.requirements) {
        if let Some(basis) = &requirement.not_applicable {
            assert_eq!(
                result.outcome,
                CheckOutcome::NotApplicable {
                    basis: basis.clone()
                }
            );
        } else {
            assert_eq!(result.outcome, CheckOutcome::Completed { findings: vec![] });
        }
    }
    let mut wrong = check_input(original, &binding, Some(valid_text));
    wrong.requirements[0].key.rule.behavior_version += 1;
    assert!(binding.validate_input(&wrong).is_err());
    // Deliberately bypass the trusted binding for this negative worker probe.
    // The actual component must still refuse a lookalike rule version.
    let InvocationOutcome::Failed { error } = invoke(
        &mut checker,
        &binding.checker,
        "review-wrong-rule",
        &serde_json::to_value(&wrong).unwrap(),
    )
    .await
    else {
        panic!("wrong rule version cannot succeed")
    };
    assert_eq!(error.schema, review_check_error_contract());
    assert_eq!(
        parse_review_check_error(error.utf8.as_bytes())
            .unwrap()
            .code,
        ReviewCheckErrorCode::InvalidInput
    );
    close_and_reap(&mut checker).await;
}

#[test]
fn smapi_review_component_uses_installed_package_and_fixed_captured_runtime() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(paired_review("stardew-smapi", false));
}
#[test]
fn webvtt_review_component_uses_installed_package_and_fixed_captured_runtime() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(paired_review("webvtt", true));
}
