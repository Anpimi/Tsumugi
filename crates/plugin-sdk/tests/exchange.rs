use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

const SMAPI: &[u8] = include_bytes!("fixtures/smapi.content.json");
const WEBVTT: &[u8] = include_bytes!("fixtures/webvtt.content.json");
const REQUEST: &[u8] = include_bytes!("fixtures/invocation.request.json");
const RESULT: &[u8] = include_bytes!("fixtures/invocation.result.json");
fn raw(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}
fn encoded(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn content(bytes: &[u8]) -> ContentExchange {
    let parsed = parse_exchange(bytes).unwrap();
    let ExchangeBody::Content(value) = &parsed.document().body else {
        panic!()
    };
    value.clone()
}
fn request() -> InvocationRequest {
    let parsed = parse_exchange(REQUEST).unwrap();
    let ExchangeBody::Request(value) = &parsed.document().body else {
        panic!()
    };
    value.clone()
}
fn range(encoding: TextEncoding, start: u32, end: u32) -> TextRange {
    TextRange {
        encoding,
        start,
        end,
    }
}
fn requirement(plugin: bool) -> CheckRequirement {
    CheckRequirement {
        key: CheckKey {
            rule: contract(if plugin {
                "example.domain.structure"
            } else {
                "core.input.integrity"
            }),
            implementation: if plugin {
                CheckImplementation::Plugin {
                    provider: request().provider,
                }
            } else {
                CheckImplementation::Core {
                    validator: contract("core.validator"),
                }
            },
        },
        input_digest: "b".repeat(64),
        scope_digest: "c".repeat(64),
        targets: vec!["unit-a".into(), "unit-b".into()],
        mandatory: true,
        waivable: false,
        not_applicable: None,
    }
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
fn two_domain_content_frames_preserve_raw_artifacts_and_explicit_order() {
    for (fixture, units, artifacts) in [(SMAPI, 2, 2), (WEBVTT, 1, 1)] {
        let parsed = parse_exchange(fixture).unwrap();
        let bytes = serde_json::to_vec(parsed.document()).unwrap();
        assert_eq!(raw(fixture), raw(&bytes));
        let original = content(fixture);
        assert_eq!(original.units.len(), units);
        assert_eq!(original.artifacts.len(), artifacts);
        verify_content_preservation(&original, &content(&bytes), &[]).unwrap();
    }
    assert!(content(SMAPI).artifacts[1].utf8.starts_with('\u{feff}'));
    assert!(content(WEBVTT).artifacts[0].utf8.contains("\r\n"));
}

#[test]
fn unknown_required_blocks_are_readable_but_interpretation_and_loss_are_rejected() {
    let original = content(WEBVTT);
    assert_eq!(
        original.require_supported_extensions(&[]).unwrap_err().code,
        ContractErrorCode::UnsupportedExtension
    );
    let required = original
        .domain_blocks
        .iter()
        .filter(|b| b.handling == ExtensionHandling::Required)
        .map(|b| b.schema.clone())
        .collect::<Vec<_>>();
    original.require_supported_extensions(&required).unwrap();
    let mut wrong = required.clone();
    wrong[0].behavior_version += 1;
    assert!(original.require_supported_extensions(&wrong).is_err());
    let mut edited = original.clone();
    edited.units[0].text = "普通编辑 👩🏽‍💻".into();
    verify_content_preservation(&original, &edited, &[]).unwrap();
    edited.domain_blocks.pop();
    assert_eq!(
        verify_content_preservation(&original, &edited, &required)
            .unwrap_err()
            .code,
        ContractErrorCode::ResultMismatch
    );
    edited = original.clone();
    edited
        .domain_blocks
        .last_mut()
        .unwrap()
        .payload_utf8
        .push(' ');
    assert!(verify_content_preservation(&original, &edited, &required).is_err());
    edited = original.clone();
    edited.artifacts[0].utf8.push(' ');
    edited.artifacts[0].sha256 = payload_digest(&edited.artifacts[0].utf8);
    assert!(verify_content_preservation(&original, &edited, &required).is_err());
    // Optional interpretation is not a license to discard an unknown payload.
    let mut optional = original.clone();
    optional.domain_blocks.last_mut().unwrap().handling = ExtensionHandling::Optional;
    let mut lost = optional.clone();
    lost.domain_blocks.pop();
    assert!(verify_content_preservation(&optional, &lost, &required).is_err());
}

#[test]
fn malformed_source_references_paths_order_and_domain_owners_are_rejected() {
    for case in 0..9 {
        let mut value = raw(WEBVTT);
        let data = &mut value["body"]["data"];
        match case {
            0 => data["artifacts"][0]["logicalPath"] = json!("../source.vtt"),
            1 => data["units"][0]["occurrences"][0]["source"]["artifactId"] = json!("outside"),
            2 => data["units"][0]["occurrences"][0]["source"]["range"]["end"] = json!(10000),
            3 => data["order"] = json!([]),
            4 => data["order"] = json!(["occurrence-0", "occurrence-0"]),
            5 => data["domainBlocks"][0]["target"]["id"] = json!("outside"),
            6 => data["units"][0]["text"] = json!("x".repeat(MAX_TEXT_BYTES + 1)),
            7 => data["domainBlocks"][0]["schema"]["schemaVersion"] = json!(0),
            _ => data["artifacts"][0]["sha256"] = json!("e".repeat(64)),
        }
        assert!(parse_exchange(&encoded(&value)).is_err(), "case {case}");
    }
    let mut valid = content(WEBVTT);
    valid.units[0].text = "x".repeat(MAX_TEXT_BYTES);
    valid.validate().unwrap();
}

#[test]
fn fixed_segmentation_rejects_schema_valid_outside_units_and_changed_revisions() {
    let original = content(SMAPI);
    verify_fixed_content_scope(&original, &original, &[]).unwrap();
    for case in 0..4 {
        let mut proposed = original.clone();
        match case {
            0 => proposed.units[0].id = "outside-unit".into(),
            1 => proposed.units[0].source_revision_id = "another-revision".into(),
            2 => proposed.order.reverse(),
            _ => {
                proposed.units[0].occurrences[0]
                    .native_identity
                    .as_mut()
                    .unwrap()
                    .value = "another-key".into()
            }
        }
        proposed.validate().unwrap(); // well formed and self consistent, but outside this captured operation.
        assert_eq!(
            verify_fixed_content_scope(&original, &proposed, &[])
                .unwrap_err()
                .code,
            ContractErrorCode::ResultMismatch
        );
    }
}

#[test]
fn independent_unicode_oracles_and_graphemes_do_not_mix_coordinate_spaces() {
    let oracle: Value =
        serde_json::from_slice(include_bytes!("fixtures/source-unicode.contract.json")).unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let text = case["raw"].as_str().unwrap();
        for row in case["rows"].as_array().unwrap() {
            for (bytes, utf16) in [
                ("keyByteRange", "keyUtf16Range"),
                ("valueByteRange", "valueUtf16Range"),
            ] {
                let from = range(
                    TextEncoding::Utf8Byte,
                    row["occurrence"][bytes][0].as_u64().unwrap() as u32,
                    row["occurrence"][bytes][1].as_u64().unwrap() as u32,
                );
                let expected = range(
                    TextEncoding::Utf16,
                    row[utf16][0].as_u64().unwrap() as u32,
                    row[utf16][1].as_u64().unwrap() as u32,
                );
                assert_eq!(
                    convert_text_range(text, from, TextEncoding::Utf16).unwrap(),
                    expected
                );
                assert_eq!(
                    convert_text_range(text, expected, TextEncoding::Utf8Byte).unwrap(),
                    from
                );
            }
        }
    }
    let text = "A👩🏽‍💻e\u{301}\r\nZ";
    assert_eq!(
        convert_text_range(
            text,
            range(TextEncoding::Grapheme, 1, 2),
            TextEncoding::Utf8Byte
        )
        .unwrap(),
        range(TextEncoding::Utf8Byte, 1, 16)
    );
    assert_eq!(
        convert_text_range(
            text,
            range(TextEncoding::Grapheme, 1, 2),
            TextEncoding::Utf16
        )
        .unwrap(),
        range(TextEncoding::Utf16, 1, 8)
    );
    assert_eq!(
        convert_text_range(
            text,
            range(TextEncoding::Utf16, 8, 10),
            TextEncoding::Grapheme
        )
        .unwrap(),
        range(TextEncoding::Grapheme, 2, 3)
    );
    assert_eq!(
        convert_text_range(
            text,
            range(TextEncoding::Utf8Byte, 19, 21),
            TextEncoding::Grapheme
        )
        .unwrap(),
        range(TextEncoding::Grapheme, 3, 4)
    );
    assert_eq!(
        convert_text_range(
            text,
            range(TextEncoding::Grapheme, 5, 5),
            TextEncoding::Utf16
        )
        .unwrap(),
        range(TextEncoding::Utf16, 13, 13)
    );
    for bad in [
        range(TextEncoding::Utf8Byte, 2, 5),
        range(TextEncoding::Utf16, 2, 8),
        range(TextEncoding::Grapheme, 6, 6),
        range(TextEncoding::Utf8Byte, 5, 1),
    ] {
        assert_eq!(
            convert_text_range(text, bad, TextEncoding::Utf8Byte)
                .unwrap_err()
                .code,
            ContractErrorCode::InvalidRange
        );
    }
    assert!(
        convert_text_range(
            text,
            range(TextEncoding::Utf8Byte, 16, 17),
            TextEncoding::Grapheme
        )
        .is_err()
    );
    assert_eq!(
        convert_text_range("", range(TextEncoding::Grapheme, 0, 0), TextEncoding::Utf16).unwrap(),
        range(TextEncoding::Utf16, 0, 0)
    );
}

#[test]
fn result_correlation_uses_captured_request_and_independent_actual_channel() {
    let expected = request();
    receive_invocation_result(RESULT, &expected, &expected.provider).unwrap();
    for field in [
        "projectId",
        "operationId",
        "attemptId",
        "itemId",
        "dispatchId",
        "scopeId",
    ] {
        let mut result = raw(RESULT);
        result["body"]["data"]["context"][field] = json!("another");
        assert_eq!(
            receive_invocation_result(&encoded(&result), &expected, &expected.provider)
                .unwrap_err()
                .code,
            ContractErrorCode::ResultMismatch
        );
    }
    for field in [
        "inputDigest",
        "scopeDigest",
        "environmentDigest",
        "configurationDigest",
    ] {
        let mut result = raw(RESULT);
        result["body"]["data"]["context"][field] = json!("e".repeat(64));
        assert!(
            receive_invocation_result(&encoded(&result), &expected, &expected.provider).is_err()
        );
    }
    for field in ["componentId", "contributionId", "instanceId"] {
        let mut channel = expected.provider.clone();
        match field {
            "componentId" => channel.component_id = "another".into(),
            "contributionId" => channel.contribution_id = "another".into(),
            _ => channel.instance_id = "another".into(),
        }
        assert!(receive_invocation_result(RESULT, &expected, &channel).is_err());
    }
    let mut channel = expected.provider.clone();
    channel.activation_generation += 1;
    assert!(receive_invocation_result(RESULT, &expected, &channel).is_err());
    channel = expected.provider.clone();
    channel.package_digest = "e".repeat(64);
    assert!(receive_invocation_result(RESULT, &expected, &channel).is_err());
    let mut result = raw(RESULT);
    result["body"]["data"]["profile"]["behaviorVersion"] = json!(2);
    assert!(receive_invocation_result(&encoded(&result), &expected, &expected.provider).is_err());
    result = raw(RESULT);
    result["body"]["data"]["outcome"]["output"]["schema"]["behaviorVersion"] = json!(2);
    assert_eq!(
        receive_invocation_result(&encoded(&result), &expected, &expected.provider)
            .unwrap_err()
            .code,
        ContractErrorCode::IncompatibleContract
    );
}

#[test]
fn strict_envelopes_preserve_unknown_payload_bytes_but_reject_bad_frames_and_limits() {
    let expected = request();
    for case in 0..4 {
        let mut value = raw(RESULT);
        match case {
            0 => value["unrecognized"] = json!(true),
            1 => value["body"]["data"]["context"]["unrecognized"] = json!(true),
            2 => value["body"]["data"]["outcome"]["output"]["utf8"] = json!("changed"),
            _ => value["protocolVersion"] = json!(2),
        }
        assert!(
            receive_invocation_result(&encoded(&value), &expected, &expected.provider).is_err()
        );
    }
    let duplicate = String::from_utf8(RESULT.to_vec()).unwrap().replace(
        "\"resultId\": \"result-a\"",
        "\"resultId\": \"a\", \"resultId\": \"b\"",
    );
    assert_eq!(
        parse_exchange(duplicate.as_bytes()).unwrap_err().code,
        ContractErrorCode::InvalidSchema
    );
    let mut exact = expected.clone();
    exact.max_result_bytes = RESULT.len() as u32;
    receive_invocation_result(RESULT, &exact, &exact.provider).unwrap();
    exact.max_result_bytes -= 1;
    assert_eq!(
        receive_invocation_result(RESULT, &exact, &exact.provider)
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
    assert!(parse_exchange(&vec![b' '; MAX_EXCHANGE_BYTES + 1]).is_err());
    let opaque = "{\"future\": 1, \"future\": 2}\r\n";
    let payload = EncodedPayload::capture(contract("example.opaque"), opaque.into()).unwrap();
    assert_eq!(payload.utf8, opaque); // opaque bytes do not claim a valid domain JSON schema.
}

#[test]
fn captured_union_keeps_core_rules_and_domain_cannot_replace_or_weaken_them() {
    let core = requirement(false);
    let domain = requirement(true);
    let fixed = capture_required_checks(
        contract("balanced.policy"),
        vec![core.clone()],
        vec![domain.clone()],
    )
    .unwrap();
    assert_eq!(fixed.set().requirements, vec![core.clone(), domain.clone()]);
    assert!(
        capture_required_checks(contract("balanced.policy"), vec![], vec![domain.clone()]).is_err()
    );
    let mut weakened = core.clone();
    weakened.mandatory = false;
    assert!(
        capture_required_checks(
            contract("balanced.policy"),
            vec![weakened],
            vec![domain.clone()]
        )
        .is_err()
    );
    assert!(
        capture_required_checks(
            contract("balanced.policy"),
            vec![core.clone()],
            vec![core.clone()]
        )
        .is_err()
    );
    assert!(
        capture_required_checks(
            contract("balanced.policy"),
            vec![core.clone(), core.clone()],
            vec![domain]
        )
        .is_err()
    );
    let mut response_set = fixed.set().clone();
    response_set.requirements.clear();
    assert_eq!(fixed.set().requirements.len(), 2);
    assert!(!fixed.evaluate(&[]).unwrap().complete);
}

#[test]
fn exact_check_identity_basis_coverage_and_allowed_na_prevent_empty_success() {
    let core = requirement(false);
    let mut domain = requirement(true);
    let allowed = NotApplicableBasis {
        code: "explicit.source-fallback".into(),
        basis_digest: "d".repeat(64),
    };
    domain.not_applicable = Some(allowed.clone());
    let fixed = capture_required_checks(
        contract("balanced.policy"),
        vec![core.clone()],
        vec![domain.clone()],
    )
    .unwrap();
    let first = completed(&core);
    let second = completed(&domain);
    assert!(
        !fixed
            .evaluate(std::slice::from_ref(&first))
            .unwrap()
            .complete
    );
    assert!(
        fixed
            .evaluate(&[second.clone(), first.clone()])
            .unwrap()
            .complete
    );
    for case in 0..6 {
        let mut bad = second.clone();
        match case {
            0 => bad.key.rule.behavior_version += 1,
            1 => bad.input_digest = "e".repeat(64),
            2 => bad.scope_digest = "e".repeat(64),
            3 => {
                bad.covered_targets.pop();
            }
            4 => bad.covered_targets.push("outside".into()),
            _ => bad.covered_targets.push("unit-a".into()),
        }
        assert_eq!(
            fixed.evaluate(&[first.clone(), bad]).unwrap_err().code,
            if case == 5 {
                ContractErrorCode::DuplicateIdentity
            } else {
                ContractErrorCode::InvalidCoverage
            }
        );
    }
    assert!(
        fixed
            .evaluate(&[first.clone(), second.clone(), second.clone()])
            .is_err()
    );
    let mut na = second.clone();
    na.outcome = CheckOutcome::NotApplicable {
        basis: allowed.clone(),
    };
    assert!(
        fixed
            .evaluate(&[first.clone(), na.clone()])
            .unwrap()
            .complete
    );
    if let CheckOutcome::NotApplicable { basis } = &mut na.outcome {
        basis.basis_digest = "e".repeat(64);
    }
    assert!(fixed.evaluate(&[first.clone(), na]).is_err());
    let mut illegal = first.clone();
    illegal.outcome = CheckOutcome::NotApplicable { basis: allowed };
    assert!(fixed.evaluate(&[illegal, second]).is_err());
}

#[test]
fn coverage_distinguishes_findings_from_missing_failed_cancelled_and_unavailable() {
    let core = requirement(false);
    let domain = requirement(true);
    let fixed = capture_required_checks(
        contract("balanced.policy"),
        vec![core.clone()],
        vec![domain.clone()],
    )
    .unwrap();
    let first = completed(&core);
    let mut second = completed(&domain);
    second.outcome = CheckOutcome::Completed {
        findings: vec![CheckFinding {
            code: "example.blocking-structure".into(),
            target: "unit-a".into(),
            severity: FindingSeverity::Error,
        }],
    };
    let report = fixed.evaluate(&[first.clone(), second.clone()]).unwrap();
    assert!(report.complete); // coverage includes a blocking finding, not a passing release.
    assert!(
        matches!(&report.entries[1].1,CoverageState::Completed { findings } if findings.len() == 1)
    );
    for outcome in [
        CheckOutcome::Failed,
        CheckOutcome::Cancelled,
        CheckOutcome::Unavailable,
    ] {
        second.outcome = outcome;
        assert!(
            !fixed
                .evaluate(&[first.clone(), second.clone()])
                .unwrap()
                .complete
        );
    }
    assert!(matches!(
        fixed.evaluate(&[first]).unwrap().entries[1].1,
        CoverageState::Missing
    ));
}
