use super::*;
use crate::persistence::resources::source_context::{
    SourceContextAdjacency, SourceContextBlock, SourceContextOccurrence,
};

fn reference() -> sdk::SourceReference {
    sdk::SourceReference {
        artifact_id: "source".into(),
        range: sdk::TextRange {
            encoding: sdk::TextEncoding::Utf8Byte,
            start: 0,
            end: 4,
        },
    }
}

fn view() -> SourceContextView {
    let unit = ExecutionId::new();
    let own_occurrence = ExecutionId::new();
    let neighbor_occurrence = ExecutionId::new();
    SourceContextView {
        scope: SourceContextRequest {
            project_id: ExecutionId::new(),
            source_snapshot_id: ExecutionId::new(),
            unit_id: unit,
            source_revision_id: ExecutionId::new(),
            locale: "zh-CN".into(),
        },
        content_revision: Revision::new(7).unwrap(),
        source_attempt_id: ExecutionId::new(),
        source_result_id: ExecutionId::new(),
        source_result_digest: "a".repeat(64),
        source_locale: "en".into(),
        local_unit_id: "unit-local".into(),
        occurrences: vec![SourceContextOccurrence {
            occurrence_id: own_occurrence,
            local_occurrence_id: "occ-local".into(),
            source: reference(),
        }],
        blocks: vec![SourceContextBlock {
            block_index: 4,
            target: sdk::ContentTarget::Occurrence {
                id: "occ-local".into(),
            },
            schema: sdk::source_context_facts_contract(),
            handling: sdk::ExtensionHandling::Preserve,
            in_revision_basis: true,
            facts: Some(sdk::SourceContextFacts {
                facts: vec![
                    sdk::SourceContextFact {
                        id: "speaker".into(),
                        kind: sdk::SourceContextFactKind::Speaker,
                        text: "Mira 👩🏽‍🚀".into(),
                        origin: sdk::SourceContextFactOrigin::Extracted {
                            sources: vec![reference()],
                        },
                    },
                    sdk::SourceContextFact {
                        id: "role".into(),
                        kind: sdk::SourceContextFactKind::Role,
                        text: "captain".into(),
                        origin: sdk::SourceContextFactOrigin::Inferred {
                            rationale: "the dialogue addresses the captain".into(),
                            sources: vec![reference()],
                        },
                    },
                ],
            }),
        }],
        neighbors: vec![SourceContextNeighbor {
            unit_id: ExecutionId::new(),
            source_revision_id: ExecutionId::new(),
            occurrence: SourceContextOccurrence {
                occurrence_id: neighbor_occurrence,
                local_occurrence_id: "neighbor-local".into(),
                source: reference(),
            },
            text: "先ほどの台詞".into(),
            adjacent_to: vec![SourceContextAdjacency {
                occurrence_id: own_occurrence,
                direction: SourceContextDirection::Before,
            }],
        }],
    }
}

fn all() -> SourceContextSelection {
    SourceContextSelection {
        extracted: true,
        inferred: true,
        neighbors: true,
        ..Default::default()
    }
}

fn selected(capture: &SourceContextCapture) -> &SelectedSourceContext {
    match capture {
        SourceContextCapture::Selected { value } => value,
        _ => panic!("expected selected capture"),
    }
}

fn selected_mut(capture: &mut SourceContextCapture) -> &mut SelectedSourceContext {
    match capture {
        SourceContextCapture::Selected { value } => value,
        _ => panic!("expected selected capture"),
    }
}

#[test]
fn budget_must_fit_the_exact_empty_selected_container() {
    let mut source = view();
    source.blocks.clear();
    source.neighbors.clear();
    let mut selection = SourceContextSelection {
        extracted: true,
        ..Default::default()
    };
    let minimum = encoded_len(&SelectedItems {
        facts: &[],
        neighbors: &[],
    })
    .unwrap() as u32;
    assert_eq!(minimum, MIN_SELECTED_BYTES);
    for budget in [0, 1, minimum - 1] {
        selection.max_bytes = budget;
        let failure = selection.validate().unwrap_err();
        assert_eq!(failure.code, ErrorCode::LimitExceeded);
        assert_eq!(failure.stage, "source-context-budget");
    }
    selection.max_bytes = minimum;
    let capture = select_source_context(&source, &selection).unwrap();
    assert!(selected(&capture).facts.is_empty());
    assert!(selected(&capture).observations.missing_blocks);
}

#[test]
fn disabled_is_explicit_and_has_no_empty_evidence() {
    let source = view();
    let selection = SourceContextSelection::default();
    let capture = select_source_context(&source, &selection).unwrap();
    assert_eq!(capture, SourceContextCapture::NotSelected);
    assert_eq!(
        serde_json::to_string(&capture).unwrap(),
        r#"{"kind":"not-selected"}"#
    );
    capture.validate_against(&selection, &source.scope).unwrap();
    assert!(capture.provider_projection().is_none());
    assert!(capture.validate_against(&all(), &source.scope).is_err());
}

#[test]
fn captured_facts_keep_original_target_origin_and_basis_while_provider_sees_only_semantics() {
    let source = view();
    let capture = select_source_context(&source, &all()).unwrap();
    let value = selected(&capture);
    assert_eq!(value.scope, source.scope);
    assert_eq!(value.content_revision, source.content_revision);
    assert_eq!(value.source_attempt_id, source.source_attempt_id);
    assert_eq!(value.source_result_id, source.source_result_id);
    assert_eq!(value.source_result_digest, source.source_result_digest);
    assert_eq!(value.facts.len(), 2);
    assert_eq!(value.facts[0].block_index, 4);
    assert_eq!(value.facts[0].fact_index, 0);
    assert_eq!(value.facts[0].target, source.blocks[0].target);
    assert_eq!(
        value.facts[0].fact,
        source.blocks[0].facts.as_ref().unwrap().facts[0]
    );
    assert_eq!(value.neighbors, source.neighbors);
    let projected = capture.provider_projection().unwrap();
    assert_eq!(projected.facts.len(), 2);
    assert_eq!(
        projected.neighbors[0].directions,
        vec![SourceContextDirection::Before]
    );
    assert_eq!(projected.neighbors[0].text, "先ほどの台詞");
    assert!(matches!(
        projected.facts[1].origin,
        SourceContextProviderOrigin::Inferred { .. }
    ));
    let json = serde_json::to_string(&projected).unwrap();
    assert!(!json.contains("artifactId"));
    assert!(!json.contains("occurrenceId"));
    assert!(!json.contains("sourceRevisionId"));
    assert!(!json.contains("occ-local"));
    assert!(!json.contains("sourceResultDigest"));
}

#[test]
fn provider_deduplicates_neighbor_directions_in_before_after_order() {
    let mut source = view();
    let second = ExecutionId::new();
    let third = ExecutionId::new();
    for (id, local) in [(second, "second"), (third, "third")] {
        source.occurrences.push(SourceContextOccurrence {
            occurrence_id: id,
            local_occurrence_id: local.into(),
            source: reference(),
        });
    }
    source.neighbors[0]
        .adjacent_to
        .push(SourceContextAdjacency {
            occurrence_id: second,
            direction: SourceContextDirection::After,
        });
    source.neighbors[0]
        .adjacent_to
        .push(SourceContextAdjacency {
            occurrence_id: third,
            direction: SourceContextDirection::Before,
        });
    let capture = select_source_context(&source, &all()).unwrap();
    assert_eq!(selected(&capture).neighbors[0], source.neighbors[0]);
    assert_eq!(
        capture.provider_projection().unwrap().neighbors[0].directions,
        vec![
            SourceContextDirection::Before,
            SourceContextDirection::After
        ]
    );
}

#[test]
fn missing_empty_and_unknown_versions_remain_distinct() {
    let mut source = view();
    source.blocks.clear();
    let selection = SourceContextSelection {
        extracted: true,
        ..Default::default()
    };
    let absent = select_source_context(&source, &selection).unwrap();
    assert!(selected(&absent).observations.missing_blocks);
    assert_eq!(selected(&absent).observations.empty_blocks, 0);

    source.blocks.push(SourceContextBlock {
        block_index: 3,
        target: sdk::ContentTarget::Snapshot,
        schema: sdk::source_context_facts_contract(),
        handling: sdk::ExtensionHandling::Preserve,
        in_revision_basis: false,
        facts: Some(sdk::SourceContextFacts { facts: vec![] }),
    });
    let empty = select_source_context(&source, &selection).unwrap();
    assert!(!selected(&empty).observations.missing_blocks);
    assert_eq!(selected(&empty).observations.empty_blocks, 1);

    source.blocks[0].schema.schema_version = 2;
    source.blocks[0].facts = None;
    let unknown = select_source_context(&source, &selection).unwrap();
    assert_eq!(selected(&unknown).observations.unknown_blocks, 1);
    assert_eq!(
        selected(&unknown).observations.unknown_samples[0]
            .schema
            .schema_version,
        2
    );
    source.blocks[0].handling = sdk::ExtensionHandling::Required;
    let error = select_source_context(&source, &selection).unwrap_err();
    assert_eq!(error.code, ErrorCode::DependencyConflict);
    assert_eq!(error.stage, "source-context-interpreter");
    let neighbors_only = SourceContextSelection {
        neighbors: true,
        ..Default::default()
    };
    let capture = select_source_context(&source, &neighbors_only).unwrap();
    assert_eq!(selected(&capture).observations.unknown_required_blocks, 1);
    assert!(selected(&capture).facts.is_empty());
}

#[test]
fn encoded_budget_uses_whole_unicode_json_items_and_containers() {
    let source = view();
    let mut selection = all();
    selection.neighbors = false;
    let full = select_source_context(&source, &selection).unwrap();
    let value = selected(&full);
    let exact = encoded_len(&SelectedItems {
        facts: &value.facts,
        neighbors: &[],
    })
    .unwrap();
    assert!(
        exact
            > value
                .facts
                .iter()
                .map(|fact| fact.fact.text.len())
                .sum::<usize>()
    );
    selection.max_bytes = exact as u32;
    let at_limit = select_source_context(&source, &selection).unwrap();
    assert_eq!(selected(&at_limit).facts.len(), 2);
    assert_eq!(
        encoded_len(&SelectedItems {
            facts: &selected(&at_limit).facts,
            neighbors: &selected(&at_limit).neighbors,
        })
        .unwrap(),
        exact
    );
    selection.max_bytes -= 1;
    let below_limit = select_source_context(&source, &selection).unwrap();
    assert_eq!(selected(&below_limit).facts.len(), 1);
    assert_eq!(selected(&below_limit).omissions.inferred, 1);
    assert_eq!(selected(&below_limit).omissions.byte_budget, 1);
    assert!(matches!(
        selected(&below_limit).omissions.samples.as_slice(),
        [
            SourceContextOmissionSample::Fact {
                block_index: 4,
                fact_index: 1,
                reason: SourceContextOmissionReason::ByteBudget,
            },
            SourceContextOmissionSample::Neighbor {
                reason: SourceContextOmissionReason::NotSelected,
                ..
            },
        ]
    ));
    let round_trip: SourceContextCapture =
        serde_json::from_slice(&serde_json::to_vec(&below_limit).unwrap()).unwrap();
    round_trip
        .validate_against(&selection, &source.scope)
        .unwrap();
}

#[test]
fn omission_and_unknown_samples_are_bounded_and_text_free() {
    let mut source = view();
    let base = source.blocks[0].clone();
    for index in 1..20 {
        let mut block = base.clone();
        block.block_index = 4 + index;
        for fact in &mut block.facts.as_mut().unwrap().facts {
            fact.id = format!("{}-{index}", fact.id);
        }
        source.blocks.push(block);
    }
    for index in 0..20 {
        let mut block = base.clone();
        block.block_index = 100 + index;
        block.schema.schema_version = 2;
        block.facts = None;
        source.blocks.push(block);
    }
    let selection = SourceContextSelection {
        extracted: true,
        inferred: false,
        neighbors: false,
        max_items: 1,
        ..Default::default()
    };
    let capture = select_source_context(&source, &selection).unwrap();
    let value = selected(&capture);
    assert_eq!(value.observations.unknown_blocks, 20);
    assert_eq!(value.observations.unknown_samples.len(), 8);
    assert_eq!(value.omissions.extracted, 19);
    assert_eq!(value.omissions.inferred, 20);
    assert_eq!(value.omissions.neighbors, 1);
    assert_eq!(value.omissions.not_selected, 21);
    assert_eq!(value.omissions.samples.len(), 8);
    assert_eq!(value.omissions.item_limit, 19);
    let json = serde_json::to_string(&value.omissions).unwrap();
    assert!(!json.contains("Mira"));
    assert!(!json.contains("rationale"));
    assert!(json.contains("blockIndex"));
    assert!(!json.contains("block_index"));
}

#[test]
fn long_unknown_targets_reduce_samples_without_losing_counts() {
    let mut source = view();
    source.blocks.clear();
    for index in 0..20 {
        source.blocks.push(SourceContextBlock {
            block_index: index,
            target: sdk::ContentTarget::Unit {
                id: "u".repeat(128),
            },
            schema: sdk::ContractRef {
                id: sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID.into(),
                schema_version: 2,
                behavior_version: 1,
            },
            handling: sdk::ExtensionHandling::Optional,
            in_revision_basis: false,
            facts: None,
        });
    }
    let selection = SourceContextSelection {
        neighbors: true,
        ..Default::default()
    };
    let capture = select_source_context(&source, &selection).unwrap();
    assert_eq!(selected(&capture).observations.unknown_blocks, 20);
    assert!(selected(&capture).observations.unknown_samples.len() <= 8);
    assert!(encoded_len(&selected(&capture).observations).unwrap() <= MAX_OBSERVATION_BYTES);
}

#[test]
fn tampered_capture_rejects_budget_category_duplicate_ids_and_wrong_scope() {
    let source = view();
    let selection = all();
    let base = select_source_context(&source, &selection).unwrap();
    let mut wrong_scope = source.scope.clone();
    wrong_scope.unit_id = ExecutionId::new();
    assert!(base.validate_against(&selection, &wrong_scope).is_err());

    let mut wrong_category = base.clone();
    selected_mut(&mut wrong_category).selection.inferred = false;
    assert!(
        wrong_category
            .validate_against(&selection, &source.scope)
            .is_err()
    );

    let mut duplicate = base.clone();
    let first = selected(&duplicate).facts[0].clone();
    selected_mut(&mut duplicate).facts.push(first);
    assert!(
        duplicate
            .validate_against(&selection, &source.scope)
            .is_err()
    );

    let mut duplicate_neighbor = base.clone();
    let first = selected(&duplicate_neighbor).neighbors[0].clone();
    selected_mut(&mut duplicate_neighbor).neighbors.push(first);
    assert!(
        duplicate_neighbor
            .validate_against(&selection, &source.scope)
            .is_err()
    );

    let mut oversized = base.clone();
    selected_mut(&mut oversized).facts[0].fact.text = "界".repeat(2000);
    assert!(
        oversized
            .validate_against(&selection, &source.scope)
            .is_err()
    );

    let mut unknown_required = base;
    selected_mut(&mut unknown_required)
        .observations
        .unknown_blocks = 1;
    selected_mut(&mut unknown_required)
        .observations
        .unknown_required_blocks = 1;
    let error = unknown_required
        .validate_against(&selection, &source.scope)
        .unwrap_err();
    assert_eq!(error.stage, "source-context-interpreter");
}

#[test]
fn forged_maximum_metadata_and_two_overflowed_totals_are_rejected() {
    let source = view();
    let selection = all();
    let mut capture = select_source_context(&source, &selection).unwrap();
    let value = selected_mut(&mut capture);
    value.observations.known_facts = u32::MAX;
    value.observations.neighbor_occurrences = 6;
    value.omissions.extracted = u32::MAX - 2;
    value.omissions.neighbors = 5;
    value.omissions.not_selected = u32::MAX - 1;
    value.omissions.byte_budget = 2;
    assert!(capture.validate_against(&selection, &source.scope).is_err());
}
