use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

const INPUT: &[u8] = include_bytes!("fixtures/source-extraction.input.json");
const ERROR: &[u8] = include_bytes!("fixtures/source-extraction.error.json");
const CONTENT: &[u8] = include_bytes!("fixtures/webvtt.content.json");

fn content(bytes: &[u8]) -> ContentExchange {
    let document = parse_exchange(bytes).unwrap();
    let ExchangeBody::Content(content) = &document.document().body else {
        panic!("expected content fixture")
    };
    content.clone()
}
fn input() -> SourceExtractionInput {
    parse_source_extraction_input(INPUT).unwrap()
}

#[test]
fn public_contracts_have_one_exact_schema_and_behavior_identity() {
    for (reference, id) in [
        (
            source_extraction_input_contract(),
            "tsumugi.source-extraction-input",
        ),
        (content_exchange_contract(), "tsumugi.content-exchange"),
        (
            source_extraction_error_contract(),
            "tsumugi.source-extraction-error",
        ),
    ] {
        assert_eq!(reference.id, id);
        assert_eq!(
            reference.schema_version,
            if id == CONTENT_EXCHANGE_SCHEMA_ID {
                2
            } else {
                1
            }
        );
        assert_eq!(reference.behavior_version, 1);
    }
    assert_ne!(source_extraction_input_contract(), input().profile);
}

#[test]
fn source_fixture_preserves_original_unicode_and_line_endings() {
    let input = input();
    let exchange = content(CONTENT);
    validate_source_extraction(&input, &exchange).unwrap();
    assert!(input.artifacts[0].utf8.contains("👩🏽‍💻 é\r\n"));
    assert_eq!(
        input.artifacts[0].sha256,
        payload_digest(&input.artifacts[0].utf8)
    );
    assert_eq!(
        parse_source_extraction_input(&serde_json::to_vec(&input).unwrap()).unwrap(),
        input
    );
    assert_eq!(
        serde_json::to_value(input).unwrap(),
        serde_json::from_slice::<Value>(INPUT).unwrap()
    );
}

#[test]
fn source_material_rejects_invalid_capture_metadata_and_bounds() {
    for case in 0..12 {
        let mut input = input();
        match case {
            0 => input.profile.schema_version = 0,
            1 => input.source_set_id.clear(),
            2 => input.source_language = "not a language".into(),
            3 => input.artifacts.clear(),
            4 => input.artifacts.push(input.artifacts[0].clone()),
            5 => input.artifacts[0].id.clear(),
            6 => input.artifacts[0].logical_path = "../source.vtt".into(),
            7 => input.artifacts[0].role = "invalid role".into(),
            8 => input.artifacts[0].sha256 = "0".repeat(64),
            9 => {
                input.artifacts[0].utf8 = "x".repeat(MAX_EXCHANGE_BYTES + 1);
                input.artifacts[0].sha256 = payload_digest(&input.artifacts[0].utf8);
            }
            10 => {
                input.artifacts = (0..=MAX_CONTENT_ITEMS)
                    .map(|index| CapturedTextArtifact {
                        id: format!("artifact-{index}"),
                        logical_path: format!("capture-{index}.txt"),
                        role: "source".into(),
                        sha256: payload_digest(""),
                        utf8: String::new(),
                    })
                    .collect();
            }
            _ => {
                let mut second = input.artifacts[0].clone();
                second.id = "different-artifact".into();
                input.artifacts.push(second); // duplicate logical path
            }
        }
        assert!(input.validate().is_err(), "case {case}");
    }
}

#[test]
fn strict_source_receivers_reject_unknown_duplicate_and_invalid_utf8_fields() {
    let mut unknown = serde_json::from_slice::<Value>(INPUT).unwrap();
    unknown["projectRevision"] = json!(1);
    assert_eq!(
        parse_source_extraction_input(&serde_json::to_vec(&unknown).unwrap())
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );
    let duplicate = String::from_utf8(INPUT.to_vec()).unwrap().replacen(
        "\"sourceSetId\": \"source-set\"",
        "\"sourceSetId\": \"source-set\", \"sourceSetId\": \"other-set\"",
        1,
    );
    assert!(parse_source_extraction_input(duplicate.as_bytes()).is_err());
    assert!(parse_source_extraction_input(b"{\xff}").is_err());
    assert_eq!(
        parse_source_extraction_input(&vec![b' '; MAX_EXCHANGE_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
}

#[test]
fn extraction_rejects_other_valid_material_and_recomputed_digests() {
    let input = input();
    for case in 0..9 {
        let mut exchange = content(CONTENT);
        match case {
            0 => exchange.profile.behavior_version += 1,
            1 => exchange.source_set_id = "another-set".into(),
            2 => exchange.source_language = "zh-CN".into(),
            3 => exchange.artifacts[0].logical_path = "another.vtt".into(),
            4 => exchange.artifacts[0].role = "companion".into(),
            5 => {
                exchange.artifacts[0].id = "another-artifact".into();
                exchange.units[0].occurrences[0].source.artifact_id = "another-artifact".into();
                exchange.units[0].occurrences[0]
                    .native_identity
                    .as_mut()
                    .unwrap()
                    .display
                    .source
                    .as_mut()
                    .unwrap()
                    .artifact_id = "another-artifact".into();
            }
            6 => {
                exchange.artifacts[0].utf8.push('\n');
                exchange.artifacts[0].sha256 = payload_digest(&exchange.artifacts[0].utf8);
            }
            7 => {
                exchange.artifacts[0].utf8.insert(0, '\u{feff}');
                exchange.artifacts[0].sha256 = payload_digest(&exchange.artifacts[0].utf8);
                exchange.units[0].occurrences[0].source.range.start += 3;
                exchange.units[0].occurrences[0].source.range.end += 3;
            }
            _ => exchange.artifacts.push(CapturedTextArtifact {
                id: "extra-artifact".into(),
                logical_path: "extra.txt".into(),
                role: "companion".into(),
                sha256: payload_digest("extra"),
                utf8: "extra".into(),
            }),
        }
        exchange.validate().unwrap();
        assert_eq!(
            validate_source_extraction(&input, &exchange)
                .unwrap_err()
                .code,
            ContractErrorCode::ResultMismatch,
            "case {case}"
        );
    }
    let mut outside = content(CONTENT);
    outside.units[0].occurrences[0].source.artifact_id = "uncaptured".into();
    assert!(validate_source_extraction(&input, &outside).is_err());
}

#[test]
fn material_set_order_is_independent_of_explicit_occurrence_order() {
    let mut exchange = content(include_bytes!("fixtures/smapi.content.json"));
    let input = SourceExtractionInput {
        profile: exchange.profile.clone(),
        source_set_id: exchange.source_set_id.clone(),
        source_language: exchange.source_language.clone(),
        artifacts: exchange.artifacts.clone(),
    };
    exchange.artifacts.reverse();
    validate_source_extraction(&input, &exchange).unwrap();
    exchange.artifacts.pop();
    assert!(validate_source_extraction(&input, &exchange).is_err());
}

#[test]
fn generic_extraction_check_does_not_interpret_domains_or_allocate_revisions() {
    let input = input();
    let mut exchange = content(CONTENT);
    exchange.units[0].source_revision_id = "operation-local-reference".into();
    exchange.units[0].text = "A domain interpreter must validate this proposal.".into();
    exchange.units[0].occurrences[0]
        .native_identity
        .as_mut()
        .unwrap()
        .value = "canonical-match".into();
    exchange.domain_blocks[0].payload_utf8 = "Opaque domain evidence, not interpreted JSON.".into();
    validate_source_extraction(&input, &exchange).unwrap();
    assert_eq!(
        exchange.units[0].source_revision_id,
        "operation-local-reference"
    );
}

#[test]
fn public_errors_are_finite_strict_and_byte_bounded() {
    let error = parse_source_extraction_error(ERROR).unwrap();
    assert_eq!(error.code, SourceExtractionErrorCode::UnsupportedStructure);
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        serde_json::from_slice::<Value>(ERROR).unwrap()
    );
    for code in [
        SourceExtractionErrorCode::InvalidInput,
        SourceExtractionErrorCode::UnsupportedProfile,
        SourceExtractionErrorCode::InvalidSource,
        SourceExtractionErrorCode::UnsupportedStructure,
        SourceExtractionErrorCode::LimitExceeded,
        SourceExtractionErrorCode::Cancelled,
    ] {
        let mut value = error.clone();
        value.code = code;
        parse_source_extraction_error(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    for case in 0..6 {
        let mut value = serde_json::to_value(&error).unwrap();
        match case {
            0 => value["code"] = json!("arbitrary-new-error"),
            1 => value["path"] = json!("unexpected field"),
            2 => value["artifactId"] = json!(""),
            3 => value["detail"] = json!(""),
            4 => value["detail"] = json!("contains\0nul"),
            _ => {
                value["detail"] =
                    json!("😀".repeat(MAX_SOURCE_EXTRACTION_ERROR_DETAIL_BYTES / 4 + 1))
            }
        }
        assert!(parse_source_extraction_error(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    assert_eq!(
        parse_source_extraction_error(&vec![b' '; MAX_SOURCE_EXTRACTION_ERROR_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
}

fn semantic_input() -> SourceExtractionCheckInput {
    let document = parse_exchange(include_bytes!("fixtures/checks.set.json")).unwrap();
    let ExchangeBody::CheckSet(set) = &document.document().body else {
        panic!()
    };
    let mut requirement = set
        .requirements
        .iter()
        .find(|r| matches!(r.key.implementation, CheckImplementation::Plugin { .. }))
        .unwrap()
        .clone();
    requirement.targets = vec!["source-set".into()];
    SourceExtractionCheckInput {
        source: input(),
        proposal: content(CONTENT),
        requirements: vec![requirement],
    }
}

#[test]
fn semantic_request_keeps_fixed_selection_and_requires_complete_nonwaivable_scope() {
    let captured = semantic_input();
    assert_eq!(
        parse_source_extraction_check_input(&serde_json::to_vec(&captured).unwrap()).unwrap(),
        captured
    );
    for case in 0..8 {
        let mut request = captured.clone();
        match case {
            0 => request.requirements.clear(),
            1 => request.requirements.push(request.requirements[0].clone()),
            2 => request.requirements[0].mandatory = false,
            3 => request.requirements[0].waivable = true,
            4 => request.requirements[0].targets = vec!["other-set".into()],
            5 => {
                request.requirements[0].not_applicable = Some(NotApplicableBasis {
                    code: "skip".into(),
                    basis_digest: "a".repeat(64),
                })
            }
            6 => {
                request.requirements[0].key.implementation = CheckImplementation::Core {
                    validator: source_extraction_input_contract(),
                }
            }
            _ => request.proposal.source_language = "zh-CN".into(),
        }
        assert!(request.validate().is_err(), "case {case}");
    }
    let mut value = serde_json::to_value(&captured).unwrap();
    value["requirements"][0]["key"]["implementation"]["provider"]["activeInstance"] =
        json!("untrusted-channel");
    assert!(parse_source_extraction_check_input(&serde_json::to_vec(&value).unwrap()).is_err());
    // Coverage does not turn a completed check with a blocker into approval.
    let r = &captured.requirements[0];
    let results = vec![CheckResult {
        key: r.key.clone(),
        input_digest: r.input_digest.clone(),
        scope_digest: r.scope_digest.clone(),
        covered_targets: r.targets.clone(),
        outcome: CheckOutcome::Completed {
            findings: vec![CheckFinding {
                code: "source-mismatch".into(),
                target: "source-set".into(),
                severity: FindingSeverity::Error,
            }],
        },
    }];
    assert_eq!(
        parse_check_results(&serde_json::to_vec(&results).unwrap()).unwrap(),
        results
    );
}

#[test]
fn display_evidence_is_required_and_all_ranges_reference_captured_unicode_boundaries() {
    let c = content(CONTENT);
    let raw = serde_json::to_vec(&c).unwrap();
    assert_eq!(parse_content_exchange(&raw).unwrap(), c);
    for case in 0..6 {
        let mut value = serde_json::to_value(&c).unwrap();
        let identity = &mut value["units"][0]["occurrences"][0]["nativeIdentity"];
        match case {
            0 => {
                identity.as_object_mut().unwrap().remove("display");
            }
            1 => {
                identity["display"]
                    .as_object_mut()
                    .unwrap()
                    .remove("source");
            }
            2 => identity["display"]["value"] = json!(""),
            3 => identity["display"]["source"]["artifactId"] = json!("uncaptured"),
            4 => identity["display"]["source"]["range"]["start"] = json!(49), // middle of Chinese UTF-8
            _ => identity["value"] = json!("contains\0nul"),
        }
        assert!(
            parse_content_exchange(&serde_json::to_vec(&value).unwrap()).is_err(),
            "case {case}"
        );
    }
    let duplicate = String::from_utf8(raw).unwrap().replacen(
        "\"sourceSetId\":\"source-set\"",
        "\"sourceSetId\":\"source-set\",\"sourceSetId\":\"other\"",
        1,
    );
    assert!(parse_content_exchange(duplicate.as_bytes()).is_err());
}

#[test]
fn revision_policy_is_unique_versioned_capture_and_does_not_interpret_payloads() {
    let c = content(CONTENT);
    let mut policy = SourceRevisionPolicy {
        profile: c.profile.clone(),
        revision_basis: vec![c.domain_blocks[0].schema.clone()],
    };
    policy.validate().unwrap();
    policy.revision_basis.push(policy.revision_basis[0].clone());
    assert!(policy.validate().is_err());
    policy.revision_basis.clear();
    policy.validate().unwrap(); // profiles whose text alone defines the revision
    policy.profile.schema_version = 0;
    assert!(policy.validate().is_err());
}

#[test]
fn combined_check_budget_is_distinct_from_each_captured_content_budget() {
    let mut request = semantic_input();
    request.source.artifacts[0].utf8 = "x".repeat(900_000);
    request.source.artifacts[0].sha256 = payload_digest(&request.source.artifacts[0].utf8);
    request.proposal.artifacts = request.source.artifacts.clone();
    request.proposal.domain_blocks[0].payload_utf8 = "x".repeat(900_000);
    let bytes = serde_json::to_vec(&request).unwrap();
    assert!(bytes.len() > MAX_EXCHANGE_BYTES && bytes.len() < MAX_INVOCATION_PAYLOAD_BYTES);
    parse_source_extraction_check_input(&bytes).unwrap();
    request.proposal.domain_blocks[0]
        .payload_utf8
        .push_str(&"x".repeat(400_000));
    assert_eq!(
        request.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    assert_eq!(
        parse_source_extraction_check_input(&vec![b' '; MAX_INVOCATION_PAYLOAD_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
}

#[cfg(feature = "schema")]
#[test]
fn generated_type_catalog_includes_content_source_and_text_contracts() {
    let schema = serde_json::to_value(source_extraction_types_schema()).unwrap();
    for definition in [
        "SourceExtractionInput",
        "SourceExtractionError",
        "SourceExtractionErrorCode",
        "ContentExchange",
        "ContractRef",
        "CapturedTextArtifact",
        "ContentUnit",
        "ContentOccurrence",
        "SourceReference",
        "NativeIdentityEvidence",
        "NativeIdentityDisplay",
        "SourceRevisionPolicy",
        "SourceExtractionCheckInput",
        "CheckRequirement",
        "CheckResult",
        "ProviderSelectionBinding",
        "ProtectedFragment",
        "ContentRelation",
        "DomainBlock",
        "ContentTarget",
        "ExtensionHandling",
        "TextRange",
        "TextEncoding",
    ] {
        assert!(schema["$defs"].get(definition).is_some(), "{definition}");
    }
    assert_eq!(
        schema["$defs"]["SourceExtractionInput"]["additionalProperties"],
        false
    );
    assert_eq!(
        schema["$defs"]["SourceExtractionError"]["additionalProperties"],
        false
    );
}
