use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

fn exchange() -> ContentExchange {
    let document = parse_exchange(include_bytes!("fixtures/webvtt.content.json")).unwrap();
    let ExchangeBody::Content(value) = &document.document().body else {
        panic!("content fixture")
    };
    value.clone()
}
fn facts(source: &ContentExchange) -> SourceContextFacts {
    let unit = &source.units[0];
    SourceContextFacts {
        facts: vec![
            SourceContextFact {
                id: "literal-note".into(),
                kind: SourceContextFactKind::Note,
                text: unit.text.clone(),
                origin: SourceContextFactOrigin::Extracted {
                    sources: vec![unit.occurrences[0].source.clone()],
                },
            },
            SourceContextFact {
                id: "interpretation".into(),
                kind: SourceContextFactKind::Role,
                text: "Synthetic interpretation 👩🏽‍💻 é".into(),
                origin: SourceContextFactOrigin::Inferred {
                    rationale: "An interpretation of this captured text, not an established role."
                        .into(),
                    sources: vec![unit.occurrences[0].source.clone()],
                },
            },
        ],
    }
}
fn block(source: &ContentExchange, facts: &SourceContextFacts) -> DomainBlock {
    DomainBlock {
        target: ContentTarget::Unit {
            id: source.units[0].id.clone(),
        },
        schema: source_context_facts_contract(),
        handling: ExtensionHandling::Optional,
        payload_utf8: serde_json::to_string(facts).unwrap(),
    }
}

#[test]
fn explicit_origins_and_exact_source_bytes_survive_the_content_receiver() {
    let mut source = exchange();
    let facts = facts(&source);
    let mut block = block(&source, &facts);
    block.payload_utf8 = format!("  {}\r\n", block.payload_utf8);
    let payload = block.payload_utf8.clone();
    source.domain_blocks.push(block.clone());
    source.validate().unwrap();
    assert_eq!(source.domain_blocks.last().unwrap().payload_utf8, payload);
    assert_eq!(
        parse_source_context_block(&block, &source.artifacts).unwrap(),
        facts
    );
    assert!(matches!(
        facts.facts[1].origin,
        SourceContextFactOrigin::Inferred { .. }
    ));
    assert_eq!(source_context_facts_contract().schema_version, 1);
    assert_eq!(source_context_facts_contract().behavior_version, 1);
    assert_eq!(source_context_facts_profile().max_facts, 32);
    assert_eq!(
        parse_source_context_facts(br#"{"facts":[]}"#)
            .unwrap()
            .facts
            .len(),
        0
    );
}

#[test]
fn missing_origins_unknown_fields_and_raw_invalid_unicode_are_refused() {
    let original = serde_json::to_value(facts(&exchange())).unwrap();
    let mut mutations = Vec::new();
    let mut value = original.clone();
    value["facts"][0].as_object_mut().unwrap().remove("origin");
    mutations.push(value);
    let mut value = original.clone();
    value["facts"][0]["origin"]["kind"] = json!("manual");
    mutations.push(value);
    let mut value = original.clone();
    value["facts"][1]["origin"]
        .as_object_mut()
        .unwrap()
        .remove("rationale");
    mutations.push(value);
    let mut value = original.clone();
    value["approved"] = json!(true);
    mutations.push(value);
    let mut value = original.clone();
    value["facts"][0]["projectId"] = json!("not-a-project-grant");
    mutations.push(value);
    for value in mutations {
        assert_eq!(
            parse_source_context_facts(&serde_json::to_vec(&value).unwrap())
                .unwrap_err()
                .code,
            ContractErrorCode::InvalidSchema
        );
    }
    assert_eq!(
        parse_source_context_facts(br#"{"facts":[],"facts":[]}"#)
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );
    let bad = serde_json::to_string(&original)
        .unwrap()
        .replacen("literal-note", r"\ud800", 1);
    assert_eq!(
        parse_source_context_facts(bad.as_bytes()).unwrap_err().code,
        ContractErrorCode::InvalidSchema
    );
}

#[test]
fn fact_identity_source_coverage_and_inference_rationale_are_required() {
    let source = exchange();
    let mut value = facts(&source);
    value.facts[1].id = value.facts[0].id.clone();
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::DuplicateIdentity
    );
    let mut value = facts(&source);
    value.facts[0].origin = SourceContextFactOrigin::Extracted { sources: vec![] };
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::InvalidCoverage
    );
    let mut value = facts(&source);
    value.facts[1].origin = SourceContextFactOrigin::Inferred {
        rationale: String::new(),
        sources: vec![source.units[0].occurrences[0].source.clone()],
    };
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::InvalidDeclaration
    );
    let mut value = facts(&source);
    let reference = source.units[0].occurrences[0].source.clone();
    value.facts[0].origin = SourceContextFactOrigin::Extracted {
        sources: vec![reference.clone(), reference],
    };
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::DuplicateIdentity
    );
}

#[test]
fn encoded_and_utf8_budgets_do_not_truncate_or_normalize_text() {
    let source = exchange();
    let mut value = facts(&source);
    value.facts.truncate(1);
    value.facts[0].text = "🧵".repeat(MAX_SOURCE_CONTEXT_FACT_TEXT_BYTES / 4);
    value.validate().unwrap();
    value.facts[0].text.push('é');
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    let mut value = facts(&source);
    let first = value.facts[0].clone();
    value.facts = (0..MAX_SOURCE_CONTEXT_FACTS)
        .map(|index| SourceContextFact {
            id: format!("fact-{index}"),
            text: "a".repeat(MAX_SOURCE_CONTEXT_FACT_TEXT_BYTES),
            ..first.clone()
        })
        .collect();
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    let mut value = facts(&source);
    value.facts = (0..=MAX_SOURCE_CONTEXT_FACTS)
        .map(|index| SourceContextFact {
            id: format!("fact-{index}"),
            ..first.clone()
        })
        .collect();
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    assert_eq!(
        parse_source_context_facts(&vec![b' '; MAX_SOURCE_CONTEXT_FACTS_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
}

#[test]
fn captured_artifact_scope_and_unicode_coordinates_are_checked() {
    let source = exchange();
    let original = facts(&source);
    let mut value = original.clone();
    let reference = &source.units[0].occurrences[0].source;
    value.facts[0].origin = SourceContextFactOrigin::Extracted {
        sources: vec![SourceReference {
            artifact_id: "other-artifact".into(),
            ..reference.clone()
        }],
    };
    assert_eq!(
        value.validate_sources(&source.artifacts).unwrap_err().code,
        ContractErrorCode::InvalidDeclaration
    );
    let artifact = source
        .artifacts
        .iter()
        .find(|artifact| artifact.id == reference.artifact_id)
        .unwrap();
    let emoji = artifact.utf8.find('👩').unwrap() as u32;
    for range in [
        TextRange {
            encoding: TextEncoding::Utf8Byte,
            start: emoji + 1,
            end: emoji + 2,
        },
        TextRange {
            encoding: TextEncoding::Utf8Byte,
            start: 0,
            end: artifact.utf8.len() as u32 + 1,
        },
    ] {
        let mut value = original.clone();
        value.facts[0].origin = SourceContextFactOrigin::Extracted {
            sources: vec![SourceReference {
                range,
                ..reference.clone()
            }],
        };
        assert_eq!(
            value.validate_sources(&source.artifacts).unwrap_err().code,
            ContractErrorCode::InvalidRange
        );
    }
    let range = convert_text_range(&artifact.utf8, reference.range, TextEncoding::Utf16).unwrap();
    let mut value = original;
    value.facts[0].origin = SourceContextFactOrigin::Extracted {
        sources: vec![SourceReference {
            range,
            ..reference.clone()
        }],
    };
    value.validate_sources(&source.artifacts).unwrap();
}

#[test]
fn supported_context_is_validated_without_reinterpreting_unknown_domain_blocks() {
    let mut source = exchange();
    let value = facts(&source);
    let mut block = block(&source, &value);
    block.payload_utf8 = r#"{"facts":[{"origin":"implicit"}]}"#.into();
    source.domain_blocks.push(block.clone());
    assert!(source.validate().is_err());
    source.domain_blocks.pop();
    block.schema.schema_version = 2;
    block.payload_utf8 = "Unknown exact payload 👩🏽‍💻 é".into();
    source.domain_blocks.push(block.clone());
    source.validate().unwrap();
    assert_eq!(
        source.domain_blocks.last().unwrap().payload_utf8,
        block.payload_utf8
    );
    assert_eq!(
        parse_source_context_block(&block, &source.artifacts)
            .unwrap_err()
            .code,
        ContractErrorCode::UnsupportedExtension
    );
    source.domain_blocks.last_mut().unwrap().handling = ExtensionHandling::Required;
    let mut supported = source
        .domain_blocks
        .iter()
        .map(|block| block.schema.clone())
        .collect::<Vec<_>>();
    supported.pop();
    assert_eq!(
        source
            .require_supported_extensions(&supported)
            .unwrap_err()
            .code,
        ContractErrorCode::UnsupportedExtension
    );
}

#[test]
fn block_applicability_and_source_reference_count_are_bounded() {
    let mut source = exchange();
    let mut value = facts(&source);
    let reference = source.units[0].occurrences[0].source.clone();
    value.facts[0].origin = SourceContextFactOrigin::Extracted {
        sources: vec![reference; MAX_SOURCE_CONTEXT_FACT_SOURCES + 1],
    };
    assert_eq!(
        value.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    let mut block = block(&source, &facts(&source));
    block.target = ContentTarget::Unit {
        id: "not-in-this-source".into(),
    };
    source.domain_blocks.push(block);
    assert_eq!(
        source.validate().unwrap_err().code,
        ContractErrorCode::InvalidDeclaration
    );
    let value: Value =
        serde_json::from_slice(&serde_json::to_vec(&facts(&exchange())).unwrap()).unwrap();
    assert!(value.get("projectId").is_none());
    assert!(value.get("confirmed").is_none());
}
