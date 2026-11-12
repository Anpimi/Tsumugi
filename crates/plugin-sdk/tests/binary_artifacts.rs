use serde_json::json;
use tsumugi_plugin_sdk::*;

fn binary(bytes: &[u8]) -> CapturedArtifact {
    CapturedArtifact::from_bytes(
        "source-artifact".into(),
        "FormatProbe.esp".into(),
        "source".into(),
        bytes,
    )
    .unwrap()
}
fn profile() -> ContractRef {
    ContractRef {
        id: "example.binary-format".into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn source() -> SourceExtractionInput {
    SourceExtractionInput {
        profile: profile(),
        source_set_id: "source-set".into(),
        source_language: "en-US".into(),
        artifacts: vec![binary(&[0, 255, 128, 10])],
    }
}
fn content(input: &SourceExtractionInput) -> ContentExchange {
    ContentExchange {
        profile: input.profile.clone(),
        source_set_id: input.source_set_id.clone(),
        source_language: input.source_language.clone(),
        artifacts: input.artifacts.clone(),
        units: vec![ContentUnit {
            id: "unit-1".into(),
            source_revision_id: "revision-1".into(),
            text: "Decoded title — 星".into(),
            occurrences: vec![ContentOccurrence {
                id: "occurrence-1".into(),
                source: SourceReference {
                    artifact_id: "source-artifact".into(),
                    range: SourceRange::raw_bytes(1, 3),
                },
                native_identity: Some(NativeIdentityEvidence {
                    namespace: "example.record-field".into(),
                    value: "record-1/FULL".into(),
                    policy: profile(),
                    display: NativeIdentityDisplay {
                        value: "Record title".into(),
                        source: None,
                    },
                }),
            }],
            protected_fragments: vec![],
        }],
        order: vec!["occurrence-1".into()],
        relations: vec![],
        domain_blocks: vec![],
    }
}

#[test]
fn source_ranges_stay_bound_to_each_material_and_recheck_later_validation_calls() {
    let mut input = source();
    let mut companion = binary(&[0xff; 16]);
    let CapturedArtifact::Binary(ref mut companion_data) = companion else {
        unreachable!()
    };
    companion_data.id = "companion".into();
    companion_data.logical_path = "Strings/FormatProbe_English.STRINGS".into();
    input.artifacts.push(companion);
    let mut proposal = content(&input);
    let companion_source = SourceReference {
        artifact_id: "companion".into(),
        range: SourceRange::raw_bytes(0, 16),
    };
    proposal.units[0].occurrences[0]
        .native_identity
        .as_mut()
        .unwrap()
        .display
        .source = Some(companion_source.clone());
    let mut facts = SourceContextFacts {
        facts: vec![SourceContextFact {
            id: "captured-label".into(),
            kind: SourceContextFactKind::Note,
            text: "Captured record label".into(),
            origin: SourceContextFactOrigin::Extracted {
                sources: vec![
                    proposal.units[0].occurrences[0].source.clone(),
                    companion_source,
                ],
            },
        }],
    };
    proposal.domain_blocks.push(DomainBlock {
        target: ContentTarget::Snapshot,
        schema: source_context_facts_contract(),
        handling: ExtensionHandling::Required,
        payload_utf8: serde_json::to_string(&facts).unwrap(),
    });
    proposal.validate().unwrap();
    facts.validate_sources(&proposal.artifacts).unwrap();

    proposal.units[0].occurrences[0].source.range.end = 5;
    assert_eq!(
        proposal.validate().unwrap_err().code,
        ContractErrorCode::InvalidRange
    );
    proposal.units[0].occurrences[0].source.range.end = 3;
    let SourceContextFactOrigin::Extracted { ref mut sources } = facts.facts[0].origin else {
        unreachable!()
    };
    sources[1].range.end = 17;
    proposal.domain_blocks[0].payload_utf8 = serde_json::to_string(&facts).unwrap();
    assert_eq!(
        proposal.validate().unwrap_err().code,
        ContractErrorCode::InvalidRange
    );

    let SourceContextFactOrigin::Extracted { ref mut sources } = facts.facts[0].origin else {
        unreachable!()
    };
    sources[1].range.end = 16;
    proposal.domain_blocks[0].payload_utf8 = serde_json::to_string(&facts).unwrap();
    proposal.artifacts[1] = CapturedArtifact::from_bytes(
        "companion".into(),
        "Strings/FormatProbe_English.STRINGS".into(),
        "source".into(),
        &[0xff; 8],
    )
    .unwrap();
    assert_eq!(
        proposal.validate().unwrap_err().code,
        ContractErrorCode::InvalidRange
    );
    assert_eq!(
        facts
            .validate_sources(&proposal.artifacts)
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidRange
    );
}

#[test]
fn maximum_raw_binary_survives_source_content_checker_and_artifact_receivers() {
    let mut input = source();
    input.artifacts = vec![binary(&vec![0xff; MAX_MATERIAL_BYTES])];
    let proposal = content(&input);
    validate_source_extraction(&input, &proposal).unwrap();
    // Reuse one serialization buffer across the large receivers.
    let mut encoded = Vec::with_capacity(MAX_SOURCE_EXTRACTION_INPUT_BYTES + 1);
    serde_json::to_writer(&mut encoded, &input).unwrap();
    assert!(encoded.len() > MAX_INVOCATION_PAYLOAD_BYTES);
    encoded.resize(MAX_SOURCE_EXTRACTION_INPUT_BYTES, b' ');
    assert_eq!(parse_source_extraction_input(&encoded).unwrap(), input);
    encoded.push(b' ');
    assert_eq!(
        parse_source_extraction_input(&encoded).unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    encoded.clear();
    serde_json::to_writer(&mut encoded, &proposal).unwrap();
    assert_eq!(parse_content_exchange(&encoded).unwrap(), proposal);

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
    requirement.targets = vec![input.source_set_id.clone()];
    let check = SourceExtractionCheckInput {
        source: input.clone(),
        proposal,
        requirements: vec![requirement],
    };
    encoded.clear();
    serde_json::to_writer(&mut encoded, &check).unwrap();
    assert!(encoded.len() > 2 * MAX_MATERIAL_BYTES);
    assert!(encoded.len() < MAX_MATERIAL_INVOCATION_BYTES);
    assert_eq!(
        parse_source_extraction_check_input(&encoded).unwrap(),
        check
    );

    let output = ArtifactSet {
        profile: input.profile,
        source_set_id: input.source_set_id,
        target_language: "zh-CN".into(),
        artifacts: input.artifacts,
    };
    encoded.clear();
    serde_json::to_writer(&mut encoded, &output).unwrap();
    assert!(encoded.len() > MAX_INVOCATION_PAYLOAD_BYTES);
    encoded.resize(MAX_ARTIFACT_SET_BYTES, b' ');
    assert_eq!(parse_artifact_set(&encoded).unwrap(), output);
    encoded.push(b' ');
    assert_eq!(
        parse_artifact_set(&encoded).unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    drop(encoded);

    // Share the immutable binary allocation while checking the actual decoded
    // aggregate limit, independently of the per-file and encoded ceilings.
    let mut aggregate = source();
    aggregate.artifacts = output.artifacts;
    let mut second = aggregate.artifacts[0].clone();
    let CapturedArtifact::Binary(value) = &mut second else { panic!() };
    value.id = "second-artifact".into();
    value.logical_path = "Second.esp".into();
    aggregate.artifacts.push(second);
    assert_eq!(2 * MAX_MATERIAL_BYTES, MAX_MATERIAL_SET_BYTES);
    aggregate.validate().unwrap();
    aggregate.artifacts.push(CapturedArtifact::from_bytes(
        "extra-artifact".into(), "Extra.bin".into(), "source".into(), &[0],
    ).unwrap());
    let error = aggregate.validate().unwrap_err();
    assert_eq!(error.code, ContractErrorCode::LimitExceeded);
    assert_eq!(error.field, "content.artifacts");
}

#[test]
fn binary_transport_preserves_original_bytes_and_rejects_ambiguous_shapes() {
    let artifact = binary(&[0, 255, 128, 10]);
    assert_eq!(
        artifact.validated_bytes().unwrap().as_ref(),
        [0, 255, 128, 10]
    );
    let value = serde_json::to_value(&artifact).unwrap();
    assert_eq!(value["base64"], "AP+ACg==");
    assert!(value.get("utf8").is_none());
    assert_eq!(
        serde_json::from_value::<CapturedArtifact>(value.clone()).unwrap(),
        artifact
    );
    let captured: CapturedArtifactData =
        serde_json::from_slice(&serde_json::to_vec(&artifact.data()).unwrap()).unwrap();
    assert_eq!(captured.bytes().unwrap().as_ref(), [0, 255, 128, 10]);
    assert_eq!(
        captured.into_artifact(
            artifact.id().into(),
            artifact.logical_path().into(),
            artifact.role().into(),
            artifact.sha256().into()
        ),
        artifact
    );
    for (field, extra) in [
        ("utf8", json!("text")),
        ("utf8", json!(null)),
        ("unexpected", json!(true)),
        ("base64", json!(null)),
    ] {
        let mut invalid = value.clone();
        invalid[field] = extra;
        assert!(
            serde_json::from_value::<CapturedArtifact>(invalid).is_err(),
            "{field}"
        );
    }
    let empty = binary(&[]);
    assert!(empty.validated_bytes().unwrap().is_empty());
    for encoded in ["AP+ACg", "AP+ACg===", "AP+ACg==\n", "AP+ACg--", "AB=="] {
        let mut invalid = value.clone();
        invalid["base64"] = json!(encoded);
        let invalid: CapturedArtifact = serde_json::from_value(invalid).unwrap();
        assert!(invalid.validated_bytes().is_err(), "{encoded}");
    }
    let mut corrupt = value;
    corrupt["base64"] = json!("AP+ACw==");
    assert_eq!(
        serde_json::from_value::<CapturedArtifact>(corrupt)
            .unwrap()
            .validated_bytes()
            .unwrap_err()
            .code,
        ContractErrorCode::ResultMismatch
    );
}

#[test]
fn raw_source_ranges_are_separate_from_unicode_unit_ranges() {
    let artifact = binary(&[0, 255, 128, 10]);
    assert_eq!(
        SourceRange::raw_bytes(1, 3).byte_range(&artifact).unwrap(),
        [1, 3]
    );
    for range in [
        SourceRange::raw_bytes(3, 2),
        SourceRange::raw_bytes(0, 5),
        TextRange {
            encoding: TextEncoding::Utf8Byte,
            start: 1,
            end: 3,
        }
        .into(),
    ] {
        assert_eq!(
            range.byte_range(&artifact).unwrap_err().code,
            ContractErrorCode::InvalidRange
        );
    }
    let text: CapturedArtifact = CapturedTextArtifact {
        id: "text".into(),
        logical_path: "text.txt".into(),
        role: "source".into(),
        sha256: payload_digest("星"),
        utf8: "星".into(),
    }
    .into();
    assert!(SourceRange::raw_bytes(0, 3).byte_range(&text).is_err());
    assert!(
        SourceRange::from(TextRange {
            encoding: TextEncoding::Utf8Byte,
            start: 1,
            end: 2
        })
        .byte_range(&text)
        .is_err()
    );
    assert_eq!(
        SourceRange::from(TextRange {
            encoding: TextEncoding::Utf16,
            start: 0,
            end: 1
        })
        .byte_range(&text)
        .unwrap(),
        [0, 3]
    );
    assert!(
        serde_json::from_value::<TextRange>(json!({"encoding":"raw-byte", "start":0, "end":1}))
            .is_err()
    );
}

#[test]
fn extraction_matches_the_complete_binary_capture_and_original_byte_positions() {
    let source = source();
    let exchange = content(&source);
    validate_source_extraction(&source, &exchange).unwrap();
    assert_eq!(
        parse_source_extraction_input(&serde_json::to_vec(&source).unwrap()).unwrap(),
        source
    );
    let mut changed = exchange.clone();
    changed.artifacts[0] = binary(&[0, 255, 128, 11]);
    assert!(validate_source_extraction(&source, &changed).is_err());
    changed = exchange.clone();
    changed.units[0].occurrences[0].source.range.end = 5;
    assert!(validate_source_extraction(&source, &changed).is_err());
    let mut text = exchange;
    text.units[0].protected_fragments.push(ProtectedFragment {
        kind: profile(),
        range: TextRange {
            encoding: TextEncoding::Utf8Byte,
            start: 1,
            end: 2,
        },
    });
    text.validate().unwrap();
}

#[test]
fn build_limits_and_artifact_digests_describe_decoded_output_bytes() {
    let source = source();
    let mut input = BuildInput {
        source: content(&source),
        targets: vec![BuildTarget {
            unit_id: "unit-1".into(),
            source_revision_id: "revision-1".into(),
            text: "译文".into(),
        }],
        target_language: "zh-CN".into(),
        configuration: vec![],
        output_paths: vec!["FormatProbe.esp".into()],
        output_limits: BuildOutputLimits {
            max_artifacts: 1,
            max_total_bytes: 4,
        },
    };
    let output = ArtifactSet {
        profile: profile(),
        source_set_id: "source-set".into(),
        target_language: "zh-CN".into(),
        artifacts: vec![binary(&[0, 255, 128, 10])],
    };
    validate_build_artifacts(&input, &output).unwrap();
    assert_eq!(
        parse_artifact_set(&serde_json::to_vec(&output).unwrap()).unwrap(),
        output
    );
    input.output_limits.max_total_bytes = 3;
    assert_eq!(
        validate_build_artifacts(&input, &output).unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
}

#[test]
fn binary_input_is_bounded_before_decoding_or_emitting_a_capture() {
    assert!(
        CapturedArtifact::from_bytes(
            "id".into(),
            "file.bin".into(),
            "source".into(),
            &vec![0; MAX_MATERIAL_BYTES + 1]
        )
        .is_err()
    );
    let mut artifact = binary(&[]);
    let CapturedArtifact::Binary(value) = &mut artifact else { panic!() };
    value.base64 = "A".repeat(MAX_MATERIAL_BYTES.div_ceil(3) * 4 + 4).into();
    let error = artifact.bytes().unwrap_err();
    assert_eq!(error.code, ContractErrorCode::LimitExceeded);
    assert_eq!(error.field, "content.artifacts.base64");
    drop(artifact);
    let mut source = source();
    let text = "\0".repeat(MAX_SOURCE_EXTRACTION_INPUT_BYTES / 6);
    assert!(text.len() < MAX_MATERIAL_BYTES);
    source.artifacts[0] = CapturedTextArtifact {
        id: "source-artifact".into(), logical_path: "escaped.txt".into(), role: "source".into(),
        sha256: artifact_bytes_digest(text.as_bytes()), utf8: text,
    }.into();
    // Each NUL needs six JSON bytes. Raw bytes fit, but metadata pushes the
    // complete source input past its independent encoded ceiling.
    assert_eq!(
        source.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
}
