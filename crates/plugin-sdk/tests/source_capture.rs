use tsumugi_plugin_sdk::*;

fn fixture() -> (ContentExchange, SourceCaptureSummary) {
    let document = parse_exchange(include_bytes!("fixtures/webvtt.content.json")).unwrap();
    let ExchangeBody::Content(exchange) = &document.document().body else {
        panic!("content")
    };
    let counts = SourceCaptureCounts {
        items: 2,
        items_with_fields: 1,
        declared_fields: 2,
        non_empty_fields: 1,
    };
    let summary = SourceCaptureSummary {
        materials: vec![SourceCaptureMaterial {
            source: exchange.units[0].occurrences[0].source.clone(),
            properties: vec![
                SourceCaptureProperty {
                    label: "Captured label".into(),
                    values: vec!["é 👩🏽‍💻 <literal>".into()],
                },
                SourceCaptureProperty {
                    label: "Explicit absence".into(),
                    values: vec![],
                },
            ],
            counts,
            groups: vec![
                SourceCaptureGroup {
                    label: "Declared".into(),
                    counts: SourceCaptureCounts {
                        items: 1,
                        items_with_fields: 1,
                        declared_fields: 2,
                        non_empty_fields: 1,
                    },
                },
                SourceCaptureGroup {
                    label: "No declared fields".into(),
                    counts: SourceCaptureCounts {
                        items: 1,
                        items_with_fields: 0,
                        declared_fields: 0,
                        non_empty_fields: 0,
                    },
                },
            ],
        }],
    };
    (exchange.clone(), summary)
}
fn block(summary: &SourceCaptureSummary) -> DomainBlock {
    DomainBlock {
        target: ContentTarget::Snapshot,
        schema: source_capture_summary_contract(),
        handling: ExtensionHandling::Preserve,
        payload_utf8: serde_json::to_string(summary).unwrap(),
    }
}

#[test]
fn capture_summary_preserves_plain_data_and_exact_scope_in_content() {
    let (mut exchange, summary) = fixture();
    let mut block = block(&summary);
    block.payload_utf8 = format!("  {}\r\n", block.payload_utf8);
    let original = block.payload_utf8.clone();
    exchange.domain_blocks.push(block.clone());
    exchange.validate().unwrap();
    assert_eq!(
        exchange.domain_blocks.last().unwrap().payload_utf8,
        original
    );
    assert_eq!(
        parse_source_capture_summary_block(&block, &exchange.artifacts).unwrap(),
        summary
    );
    assert!(summary.materials[0].properties[1].values.is_empty());
}

#[test]
fn capture_summary_rejects_inconsistent_totals_duplicates_and_unbounded_data() {
    let (_, summary) = fixture();
    for case in 0..10 {
        let mut changed = summary.clone();
        let material = &mut changed.materials[0];
        match case {
            0 => material.counts.non_empty_fields = 3,
            1 => material.counts.items_with_fields = 0,
            2 => material.groups[0].counts.items = 2,
            3 => material.groups.push(material.groups[0].clone()),
            4 => material.properties.push(material.properties[0].clone()),
            5 => material.properties[0].label = "unsafe\nlabel".into(),
            6 => {
                material.properties[0].values = vec!["x".repeat(MAX_SOURCE_CAPTURE_TEXT_BYTES + 1)]
            }
            7 => material.properties[0].values = vec!["x".into(); MAX_SOURCE_CAPTURE_VALUES + 1],
            8 => changed.materials.push(changed.materials[0].clone()),
            9 => changed.materials.clear(),
            _ => unreachable!(),
        }
        assert!(changed.validate().is_err(), "case {case}");
    }
    let mut large = summary;
    large.materials[0].properties[0].values = vec!["x".repeat(MAX_SOURCE_CAPTURE_TEXT_BYTES); 64];
    assert_eq!(
        large.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    let encoded = serde_json::to_vec(&large).unwrap();
    assert!(encoded.len() > MAX_SOURCE_CAPTURE_SUMMARY_BYTES);
    assert_eq!(
        parse_source_capture_summary(&encoded).unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
}

#[test]
fn capture_summary_validates_each_reference_again_on_text_and_binary_inputs() {
    let (exchange, summary) = fixture();
    let mut binary = summary.clone();
    binary.materials[0].source = SourceReference {
        artifact_id: "raw".into(),
        range: SourceRange::raw_bytes(0, 4),
    };
    let artifacts = vec![
        CapturedArtifact::from_bytes(
            "raw".into(),
            "source.bin".into(),
            "source".into(),
            &[0xff, 0, 1, 2],
        )
        .unwrap(),
    ];
    binary.validate_sources(&artifacts).unwrap();
    for (original, artifacts) in [(summary, exchange.artifacts), (binary, artifacts)] {
        original.validate_sources(&artifacts).unwrap();
        for case in 0..4 {
            let mut changed = original.clone();
            let reference = &mut changed.materials[0].source;
            match case {
                0 => reference.range.end = u32::MAX,
                1 => reference.range.start = reference.range.end,
                2 => reference.artifact_id = "missing".into(),
                3 => {
                    reference.range.encoding =
                        if reference.range.encoding == SourceEncoding::RawByte {
                            SourceEncoding::Utf8Byte
                        } else {
                            SourceEncoding::RawByte
                        }
                }
                _ => unreachable!(),
            }
            assert!(changed.validate_sources(&artifacts).is_err(), "case {case}");
        }
        let mut changed = artifacts;
        match &mut changed[0] {
            CapturedArtifact::Text(a) => a.sha256 = "0".repeat(64),
            CapturedArtifact::Binary(a) => a.sha256 = "0".repeat(64),
        }
        // The summary checks positions; the complete content receiver also owns
        // artifact integrity. It must not imply standalone provenance truth.
        assert!(changed[0].validated_bytes().is_err());
    }
}

#[test]
fn capture_summary_cannot_be_required_scoped_to_a_unit_or_part_of_revision_basis() {
    let (exchange, summary) = fixture();
    for case in 0..3 {
        let mut block = block(&summary);
        match case {
            0 => {
                block.target = ContentTarget::Unit {
                    id: exchange.units[0].id.clone(),
                }
            }
            1 => block.handling = ExtensionHandling::Required,
            2 => block.schema.schema_version += 1,
            _ => unreachable!(),
        }
        assert!(parse_source_capture_summary_block(&block, &exchange.artifacts).is_err());
        if case < 2 {
            let mut content = exchange.clone();
            content.domain_blocks.push(block);
            assert!(content.validate().is_err());
        }
    }
    let mut policy = SourceRevisionPolicy {
        profile: exchange.profile.clone(),
        revision_basis: vec![],
    };
    policy.validate().unwrap();
    policy
        .revision_basis
        .push(source_capture_summary_contract());
    assert!(policy.validate().is_err());
}
