use super::*;
use crate::persistence::resources::source_context::{
    SourceContextAdjacency, SourceContextDirection, SourceContextOccurrence,
};
use tsumugi_plugin_sdk as sdk;

fn source_ref() -> sdk::SourceReference {
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
    let own_occurrence = ExecutionId::new();
    SourceContextView {
        scope: SourceContextRequest {
            project_id: ExecutionId::new(),
            source_snapshot_id: ExecutionId::new(),
            unit_id: ExecutionId::new(),
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
            source: source_ref(),
        }],
        blocks: vec![
            SourceContextBlock {
                block_index: 0,
                target: sdk::ContentTarget::Snapshot,
                schema: sdk::source_context_facts_contract(),
                handling: sdk::ExtensionHandling::Preserve,
                in_revision_basis: true,
                facts: Some(sdk::SourceContextFacts {
                    facts: vec![sdk::SourceContextFact {
                        id: "scene".into(),
                        kind: sdk::SourceContextFactKind::Scene,
                        text: "月明かり 👩🏽‍🚀".into(),
                        origin: sdk::SourceContextFactOrigin::Extracted {
                            sources: vec![source_ref()],
                        },
                    }],
                }),
            },
            SourceContextBlock {
                block_index: 1,
                target: sdk::ContentTarget::Unit {
                    id: "unit-local".into(),
                },
                schema: sdk::source_context_facts_contract(),
                handling: sdk::ExtensionHandling::Optional,
                in_revision_basis: false,
                facts: Some(sdk::SourceContextFacts { facts: vec![] }),
            },
            SourceContextBlock {
                block_index: 2,
                target: sdk::ContentTarget::Occurrence {
                    id: "occ-local".into(),
                },
                schema: sdk::ContractRef {
                    id: sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID.into(),
                    schema_version: 2,
                    behavior_version: 1,
                },
                handling: sdk::ExtensionHandling::Required,
                in_revision_basis: false,
                facts: None,
            },
        ],
        neighbors: vec![SourceContextNeighbor {
            unit_id: ExecutionId::new(),
            source_revision_id: ExecutionId::new(),
            occurrence: SourceContextOccurrence {
                occurrence_id: ExecutionId::new(),
                local_occurrence_id: "neighbor-local".into(),
                source: source_ref(),
            },
            text: "前の行".into(),
            adjacent_to: vec![SourceContextAdjacency {
                occurrence_id: own_occurrence,
                direction: SourceContextDirection::Before,
            }],
        }],
    }
}

#[test]
fn pages_keep_complete_block_order_then_neighbor_order() {
    let view = view();
    let first = page_from_view(&view, &[], 0, 2).unwrap();
    assert_eq!(first.scope, view.scope);
    assert_eq!(first.content_revision, view.content_revision);
    assert_eq!(first.source_result_digest, view.source_result_digest);
    assert_eq!(first.occurrence_count, 1);
    assert_eq!(first.after, 0);
    assert_eq!(first.next_after, Some(2));
    assert_eq!(first.total_entries, 4);
    assert_eq!(first.entries.len(), 2);
    assert_eq!(
        first.entries[0],
        SourceContextPageEntry::Block {
            value: view.blocks[0].clone()
        }
    );
    assert_eq!(
        first.entries[1],
        SourceContextPageEntry::Block {
            value: view.blocks[1].clone()
        }
    );
    let second = page_from_view(&view, &[], first.next_after.unwrap(), 2).unwrap();
    assert_eq!(second.after, 2);
    assert_eq!(second.next_after, None);
    assert_eq!(
        second.entries[0],
        SourceContextPageEntry::Block {
            value: view.blocks[2].clone()
        }
    );
    assert_eq!(
        second.entries[1],
        SourceContextPageEntry::Neighbor {
            value: view.neighbors[0].clone()
        }
    );
    assert_eq!(page_from_view(&view, &[], 4, 2).unwrap().entries.len(), 0);
    assert_eq!(
        serde_json::to_value(&first.entries[0]).unwrap()["kind"],
        "block"
    );
    assert_eq!(
        serde_json::to_value(&second.entries[1]).unwrap()["kind"],
        "neighbor"
    );
}

#[test]
fn missing_empty_and_unknown_required_are_observed_without_interpretation() {
    let mut view = view();
    let page = page_from_view(&view, &[], 0, 20).unwrap();
    assert!(!page.observations.missing_blocks);
    assert_eq!(page.observations.empty_blocks, 1);
    assert_eq!(page.observations.unknown_blocks, 1);
    assert_eq!(page.observations.unknown_required_blocks, 1);
    assert!(
        matches!(&page.entries[2], SourceContextPageEntry::Block { value } if value.facts.is_none())
    );
    view.blocks.clear();
    let missing = page_from_view(&view, &[], 0, 20).unwrap();
    assert!(missing.observations.missing_blocks);
    assert_eq!(missing.total_entries, 1);
    assert!(matches!(
        &missing.entries[0],
        SourceContextPageEntry::Neighbor { .. }
    ));
}

#[test]
fn unicode_page_budget_counts_whole_json_frame_and_never_splits_a_block() {
    let mut view = view();
    view.blocks.clear();
    view.neighbors.clear();
    for block_index in 0..4u32 {
        let facts = sdk::SourceContextFacts {
            facts: (0..18)
                .map(|index| sdk::SourceContextFact {
                    id: format!("fact-{index}"),
                    kind: sdk::SourceContextFactKind::Note,
                    text: "界".repeat(1000),
                    origin: sdk::SourceContextFactOrigin::Extracted {
                        sources: vec![source_ref()],
                    },
                })
                .collect(),
        };
        facts.validate().unwrap();
        view.blocks.push(SourceContextBlock {
            block_index,
            target: sdk::ContentTarget::Snapshot,
            schema: sdk::source_context_facts_contract(),
            handling: sdk::ExtensionHandling::Preserve,
            in_revision_basis: true,
            facts: Some(facts),
        });
    }
    let first = page_from_view(&view, &[], 0, 20).unwrap();
    assert_eq!(first.entries.len(), 2);
    assert_eq!(first.next_after, Some(2));
    let bytes = serde_json::to_vec(&first).unwrap();
    assert!(bytes.len() <= MAX_SOURCE_CONTEXT_PAGE_BYTES);
    let mut with_next = first.clone();
    with_next.entries.push(SourceContextPageEntry::Block {
        value: view.blocks[2].clone(),
    });
    with_next.next_after = Some(3);
    assert!(serde_json::to_vec(&with_next).unwrap().len() > MAX_SOURCE_CONTEXT_PAGE_BYTES);
    let second = page_from_view(&view, &[], 2, 20).unwrap();
    assert_eq!(second.entries.len(), 2);
    assert_eq!(second.next_after, None);
    assert!(
        matches!(&second.entries[0], SourceContextPageEntry::Block { value } if value.facts.as_ref().unwrap().facts.len() == 18)
    );
}

#[test]
fn invalid_offsets_limits_and_unrepresentable_header_fail_explicitly() {
    let view = view();
    for (after, limit) in [(5, 1), (0, 0), (0, 21)] {
        let error = page_from_view(&view, &[], after, limit).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.stage, "source-context-page");
    }
    let mut huge_header = view;
    huge_header.local_unit_id = "x".repeat(MAX_SOURCE_CONTEXT_PAGE_BYTES);
    let error = page_from_view(&huge_header, &[], 0, 1).unwrap_err();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "source-context-page-budget");
}

#[test]
fn stored_descriptors_page_in_original_index_order_without_changing_fact_observations() {
    let view = view();
    let descriptors = (0..3)
        .map(|block_index| SourceContextBlockDescriptor {
            block_index,
            target: sdk::ContentTarget::Snapshot,
            schema: sdk::ContractRef {
                id: "different.opaque".into(),
                schema_version: 7,
                behavior_version: 3,
            },
            handling: sdk::ExtensionHandling::Required,
            in_revision_basis: false,
            payload_bytes: sdk::MAX_EXCHANGE_BYTES as u32,
        })
        .collect::<Vec<_>>();
    let ordinary = page_from_view(&view, &[], 0, 20).unwrap();
    let first = page_from_view(&view, &descriptors, 0, 4).unwrap();
    assert_eq!(first.observations, ordinary.observations);
    assert_eq!(first.total_entries, 7);
    assert_eq!(first.next_after, Some(4));
    assert_eq!(
        first.entries[3],
        SourceContextPageEntry::StoredBlock {
            value: descriptors[0].clone()
        }
    );
    let second = page_from_view(&view, &descriptors, 4, 4).unwrap();
    assert_eq!(second.next_after, None);
    assert_eq!(
        second.entries[0],
        SourceContextPageEntry::StoredBlock {
            value: descriptors[1].clone()
        }
    );
    assert_eq!(
        second.entries[1],
        SourceContextPageEntry::StoredBlock {
            value: descriptors[2].clone()
        }
    );
    assert!(matches!(
        second.entries[2],
        SourceContextPageEntry::Neighbor { .. }
    ));
    assert!(codec::encode(&second, MAX_SOURCE_CONTEXT_PAGE_BYTES).is_ok());
}
