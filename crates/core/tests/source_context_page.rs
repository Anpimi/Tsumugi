#![cfg(not(feature = "execution-test-host"))]
//! Pages exercise the checked SQLite source path with a synthetic SDK producer.
mod support;

use tsumugi_core::{
    ProjectStore, SourceContextPageEntry, SourceContextRequest, content::ContentRow, execution::*,
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

fn with_page_blocks(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let source = exchange.units[0].occurrences[0].source.clone();
    exchange.domain_blocks = vec![
        sdk::DomainBlock {
            target: sdk::ContentTarget::Snapshot,
            schema: sdk::source_context_facts_contract(),
            handling: sdk::ExtensionHandling::Preserve,
            payload_utf8: serde_json::to_string(&sdk::SourceContextFacts {
                facts: vec![sdk::SourceContextFact {
                    id: "scene".into(),
                    kind: sdk::SourceContextFactKind::Scene,
                    text: "月の下 👩🏽‍🚀".into(),
                    origin: sdk::SourceContextFactOrigin::Extracted {
                        sources: vec![source],
                    },
                }],
            })
            .unwrap(),
        },
        sdk::DomainBlock {
            target: sdk::ContentTarget::Unit {
                id: exchange.units[0].id.clone(),
            },
            schema: sdk::source_context_facts_contract(),
            handling: sdk::ExtensionHandling::Optional,
            payload_utf8: serde_json::to_string(&sdk::SourceContextFacts { facts: vec![] })
                .unwrap(),
        },
        sdk::DomainBlock {
            target: sdk::ContentTarget::Occurrence {
                id: exchange.units[0].occurrences[0].id.clone(),
            },
            schema: sdk::ContractRef {
                id: sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID.into(),
                schema_version: 2,
                behavior_version: 1,
            },
            handling: sdk::ExtensionHandling::Required,
            payload_utf8: "opaque future facts".into(),
        },
    ];
    exchange
}

#[test]
fn checked_pages_preserve_whole_entries_and_remain_read_only_after_reopen() {
    let (directory, store, rows) = support::source_fixture_with_transform(4, with_page_blocks);
    let request = request(&store, &rows[0]);
    let path = directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&path).unwrap();
    let view = store.source_context(&request).unwrap();
    let first = store.source_context_page(&request, 0, 2).unwrap();
    assert_eq!(first.scope, request);
    assert_eq!(first.content_revision, view.content_revision);
    assert_eq!(first.source_attempt_id, view.source_attempt_id);
    assert_eq!(first.source_result_id, view.source_result_id);
    assert_eq!(first.source_result_digest, view.source_result_digest);
    assert_eq!(first.occurrence_count, view.occurrences.len() as u32);
    assert_eq!(first.next_after, Some(2));
    assert_eq!(first.total_entries, 7);
    assert_eq!(first.observations.known_facts, 1);
    assert_eq!(first.observations.empty_blocks, 1);
    assert_eq!(first.observations.unknown_required_blocks, 1);
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
    let second = store.source_context_page(&request, 2, 5).unwrap();
    assert_eq!(second.next_after, None);
    assert_eq!(
        second.entries[0],
        SourceContextPageEntry::Block {
            value: view.blocks[2].clone()
        }
    );
    assert_eq!(
        second.entries[4],
        SourceContextPageEntry::Neighbor {
            value: view.neighbors[0].clone()
        }
    );
    assert!(
        store
            .source_context_page(&request, 7, 2)
            .unwrap()
            .entries
            .is_empty()
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.source_context_page(&request, 0, 2).unwrap(), first);
    assert_eq!(
        reopened.source_context_page(&request, 2, 5).unwrap(),
        second
    );
}

#[test]
fn page_parameters_and_current_scope_are_checked_without_writes() {
    let (directory, store, rows) = support::source_fixture_with_transform(4, with_page_blocks);
    let request = request(&store, &rows[0]);
    let path = directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&path).unwrap();
    for (after, limit) in [(8, 1), (0, 0), (0, 21)] {
        let error = store
            .source_context_page(&request, after, limit)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.stage, "source-context-page");
    }
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
        assert!(
            store.source_context_page(&stale, 0, 2).is_err(),
            "scenario {scenario}"
        );
    }
    assert_eq!(std::fs::read(path).unwrap(), before);
}
