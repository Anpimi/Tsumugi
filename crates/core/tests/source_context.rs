#![cfg(not(feature = "execution-test-host"))]
//! Real SQLite/source adoption with a synthetic SDK producer/checker pair.
//! These tests establish Core provenance plumbing, not domain fact accuracy.
mod support;

use tsumugi_core::{
    ProjectStore, SaveContext, SourceContextDirection, SourceContextRequest, content::ContentRow,
    execution::*,
};
use tsumugi_plugin_sdk as sdk;

fn request(store: &ProjectStore, row: &ContentRow) -> SourceContextRequest {
    SourceContextRequest {
        project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
            .unwrap(),
        source_snapshot_id: store.content_scope().unwrap().current_snapshot.unwrap(),
        unit_id: row.unit_id.unwrap(),
        source_revision_id: row.source_revision_id.unwrap(),
        locale: "zh-CN".into(),
    }
}

fn block(target: sdk::ContentTarget, facts: Vec<sdk::SourceContextFact>) -> sdk::DomainBlock {
    sdk::DomainBlock {
        target,
        schema: sdk::source_context_facts_contract(),
        handling: sdk::ExtensionHandling::Preserve,
        payload_utf8: serde_json::to_string(&sdk::SourceContextFacts { facts }).unwrap(),
    }
}

fn with_facts(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let source = exchange.units[0].occurrences[0].source.clone();
    exchange.domain_blocks = vec![
        block(
            sdk::ContentTarget::Snapshot,
            vec![sdk::SourceContextFact {
                id: "fact".into(),
                kind: sdk::SourceContextFactKind::Scene,
                text: "  scene literal 👩🏽‍💻 é  ".into(),
                origin: sdk::SourceContextFactOrigin::Extracted {
                    sources: vec![source.clone()],
                },
            }],
        ),
        block(
            sdk::ContentTarget::Unit {
                id: exchange.units[0].id.clone(),
            },
            vec![sdk::SourceContextFact {
                // IDs are unique within a block, not across targets.
                id: "fact".into(),
                kind: sdk::SourceContextFactKind::Role,
                text: "possible role".into(),
                origin: sdk::SourceContextFactOrigin::Inferred {
                    rationale: "  synthetic hypothesis, not a human decision  ".into(),
                    sources: vec![source],
                },
            }],
        ),
        block(
            sdk::ContentTarget::Occurrence {
                id: exchange.units[0].occurrences[0].id.clone(),
            },
            vec![],
        ),
        block(
            sdk::ContentTarget::Unit {
                id: exchange.units[1].id.clone(),
            },
            vec![],
        ),
    ];
    let mut unsupported = block(sdk::ContentTarget::Snapshot, vec![]);
    unsupported.schema.schema_version = 2;
    unsupported.payload_utf8 = "opaque unsupported syntax".into();
    exchange.domain_blocks.push(unsupported);
    exchange
}

#[test]
fn current_projection_preserves_origins_targets_empty_and_unsupported_versions() {
    let (directory, store, rows) = support::source_fixture_with_transform(4, with_facts);
    let request = request(&store, &rows[0]);
    let before = std::fs::read(directory.path().join("project/project.sqlite3")).unwrap();
    let view = store.source_context(&request).unwrap();
    assert_eq!(view.scope, request);
    assert_eq!(
        view.content_revision,
        store.content_scope().unwrap().revision
    );
    assert_eq!(view.source_locale, "en");
    assert_eq!(view.source_result_digest.len(), 64);
    assert_eq!(
        store
            .execution_result(view.source_attempt_id, view.source_result_id)
            .unwrap()
            .digest(),
        view.source_result_digest
    );
    assert_eq!(
        view.blocks
            .iter()
            .map(|block| block.block_index)
            .collect::<Vec<_>>(),
        [0, 1, 2, 4]
    );
    assert!(view.blocks[0].in_revision_basis);
    let extracted = &view.blocks[0].facts.as_ref().unwrap().facts[0];
    assert_eq!(extracted.text, "  scene literal 👩🏽‍💻 é  ");
    assert!(matches!(
        extracted.origin,
        sdk::SourceContextFactOrigin::Extracted { .. }
    ));
    let inferred = &view.blocks[1].facts.as_ref().unwrap().facts[0];
    assert_eq!(inferred.id, extracted.id);
    assert!(
        matches!(&inferred.origin, sdk::SourceContextFactOrigin::Inferred { rationale, .. } if rationale == "  synthetic hypothesis, not a human decision  ")
    );
    assert_eq!(
        extracted.origin.sources(),
        &[rows[0].occurrence.source.clone()]
    );
    assert!(view.blocks[2].facts.as_ref().unwrap().facts.is_empty());
    assert!(view.blocks[3].facts.is_none());
    assert!(!view.blocks[3].in_revision_basis);
    assert_eq!(view.blocks[3].schema.schema_version, 2);
    assert_eq!(
        view.occurrences[0].occurrence_id,
        rows[0].occurrence_id.unwrap()
    );
    assert_eq!(view.neighbors.len(), 1);
    assert_eq!(view.neighbors[0].unit_id, rows[1].unit_id.unwrap());
    assert_eq!(
        view.neighbors[0].source_revision_id,
        rows[1].source_revision_id.unwrap()
    );
    assert_eq!(
        view.neighbors[0].occurrence.source,
        rows[1].occurrence.source
    );
    assert_eq!(
        view.neighbors[0].adjacent_to[0].direction,
        SourceContextDirection::After
    );
    assert_eq!(store.source_context(&request).unwrap(), view);
    assert_eq!(
        std::fs::read(directory.path().join("project/project.sqlite3")).unwrap(),
        before
    );
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.source_context(&request).unwrap(), view);
}

#[test]
fn absent_blocks_do_not_manufacture_facts_from_keys_or_neighbors() {
    let (_directory, store, rows) = support::source_fixture();
    let view = store.source_context(&request(&store, &rows[1])).unwrap();
    assert!(view.blocks.is_empty());
    assert_eq!(view.occurrences.len(), 1);
    assert_eq!(view.neighbors.len(), 1);
    assert_eq!(
        view.neighbors[0].adjacent_to[0].direction,
        SourceContextDirection::Before
    );
    assert_eq!(view.neighbors[0].text, rows[0].occurrence.text);
}

fn multiple_occurrences(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let repeated = exchange.units.remove(2);
    let mut occurrence = repeated.occurrences[0].clone();
    occurrence.native_identity = exchange.units[0].occurrences[0].native_identity.clone();
    exchange.domain_blocks.push(block(
        sdk::ContentTarget::Occurrence {
            id: occurrence.id.clone(),
        },
        vec![],
    ));
    exchange.units[0].occurrences.push(occurrence);
    exchange
}

#[test]
fn repeated_unit_keeps_all_occurrences_and_deduplicates_neighbor_with_both_edges() {
    let (_directory, store, rows) = support::source_fixture_with_transform(4, multiple_occurrences);
    assert_eq!(rows[0].unit_id, rows[2].unit_id);
    let view = store.source_context(&request(&store, &rows[0])).unwrap();
    assert_eq!(view.occurrences.len(), 2);
    assert_eq!(view.blocks.len(), 1);
    assert_eq!(
        view.blocks[0].target,
        sdk::ContentTarget::Occurrence {
            id: rows[2].occurrence.operation_occurrence_id.clone()
        }
    );
    assert_eq!(view.neighbors.len(), 2);
    assert_eq!(
        view.neighbors[0].occurrence.occurrence_id,
        rows[1].occurrence_id.unwrap()
    );
    assert_eq!(view.neighbors[0].adjacent_to.len(), 2);
    assert_eq!(
        view.neighbors[0].adjacent_to[0].occurrence_id,
        rows[0].occurrence_id.unwrap()
    );
    assert_eq!(
        view.neighbors[0].adjacent_to[0].direction,
        SourceContextDirection::After
    );
    assert_eq!(
        view.neighbors[0].adjacent_to[1].occurrence_id,
        rows[2].occurrence_id.unwrap()
    );
    assert_eq!(
        view.neighbors[0].adjacent_to[1].direction,
        SourceContextDirection::Before
    );
    assert_eq!(
        view.neighbors[1].occurrence.occurrence_id,
        rows[3].occurrence_id.unwrap()
    );
}

fn reverse_order(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    exchange.order.reverse();
    exchange
}

#[test]
fn neighbors_follow_declared_order_instead_of_native_key_or_artifact_sorting() {
    let (_directory, store, rows) = support::source_fixture_with_transform(4, reverse_order);
    let view = store.source_context(&request(&store, &rows[1])).unwrap();
    assert_eq!(view.local_unit_id, "unit-item-0002");
    assert_eq!(
        view.neighbors[0].occurrence.local_occurrence_id,
        "occurrence-item-0003"
    );
    assert_eq!(
        view.neighbors[0].adjacent_to[0].direction,
        SourceContextDirection::Before
    );
    assert_eq!(
        view.neighbors[1].occurrence.local_occurrence_id,
        "occurrence-item-0001"
    );
    assert_eq!(
        view.neighbors[1].adjacent_to[0].direction,
        SourceContextDirection::After
    );
}

#[test]
fn current_scope_requires_exact_project_snapshot_unit_revision_and_target_locale_without_writes() {
    let (directory, store, rows) = support::source_fixture();
    let request = request(&store, &rows[0]);
    let before = std::fs::read(directory.path().join("project/project.sqlite3")).unwrap();
    for scenario in 0..6 {
        let mut stale = request.clone();
        match scenario {
            0 => stale.project_id = ExecutionId::new(),
            1 => stale.source_snapshot_id = ExecutionId::new(),
            2 => stale.unit_id = ExecutionId::new(),
            3 => stale.source_revision_id = ExecutionId::new(),
            4 => stale.locale = "fr".into(),
            _ => stale.locale = "zh-cn".into(),
        }
        let error = store.source_context(&stale).unwrap_err();
        assert!(
            matches!(
                error.code,
                ErrorCode::DependencyConflict | ErrorCode::Unauthorized
            ),
            "{scenario}: {error:?}"
        );
    }
    assert_eq!(
        std::fs::read(directory.path().join("project/project.sqlite3")).unwrap(),
        before
    );
    assert!(store.source_context(&request).is_ok());
}

#[test]
fn locale_is_explicit_and_manual_context_remains_a_separate_revision() {
    let (_directory, mut store, rows) = support::source_fixture_with_transform(2, with_facts);
    let request = request(&store, &rows[0]);
    let original = store.source_context(&request).unwrap();
    let mut other_locale = request.clone();
    other_locale.locale = "ja".into();
    let other = store.source_context(&other_locale).unwrap();
    assert_eq!(other.scope.locale, "ja");
    assert_eq!(original.blocks, other.blocks);
    store
        .save_context(&SaveContext {
            project_id: request.project_id,
            action_id: ExecutionId::new(),
            unit_id: request.unit_id,
            locale: request.locale.clone(),
            source_revision_id: request.source_revision_id,
            expected_revision_id: None,
            text: "human-only context".into(),
            reason: "synthetic manual note".into(),
        })
        .unwrap();
    assert_eq!(store.source_context(&request).unwrap(), original);
    assert_eq!(
        store
            .context_revision(request.project_id, request.unit_id, &request.locale)
            .unwrap()
            .unwrap()
            .text,
        "human-only context"
    );
    assert!(
        store
            .context_revision(request.project_id, request.unit_id, "ja")
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_warm_read_still_refuses_changed_mapping_result_and_semantic_proof() {
    for scenario in 0..3 {
        let (directory, store, rows) = support::source_fixture_with_transform(2, with_facts);
        let request = request(&store, &rows[0]);
        let view = store.source_context(&request).unwrap();
        let path = directory.path().join("project/project.sqlite3");
        let db = rusqlite::Connection::open(&path).unwrap();
        let changed = match scenario {
            0 => db.execute("UPDATE source_occurrences SET local_unit_id='substituted' WHERE occurrence_id=?1", [rows[0].occurrence_id.unwrap().to_string()]).unwrap(),
            1 => db.execute("UPDATE plugin_validation_links SET valid=0 WHERE producer_result_id=?1", [view.source_result_id.to_string()]).unwrap(),
            _ => {
                let mut bytes: Vec<u8> = db.query_row("SELECT bytes FROM execution_results WHERE result_id=?1", [view.source_result_id.to_string()], |row| row.get(0)).unwrap();
                bytes.push(b' ');
                db.execute("UPDATE execution_results SET bytes=?1 WHERE result_id=?2", rusqlite::params![bytes, view.source_result_id.to_string()]).unwrap()
            },
        };
        assert_eq!(changed, 1);
        drop(db);
        let before = std::fs::read(&path).unwrap();
        assert!(
            store.source_context(&request).is_err(),
            "tampering scenario {scenario}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
