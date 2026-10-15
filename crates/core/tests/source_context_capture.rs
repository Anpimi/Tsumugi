#![cfg(not(feature = "execution-test-host"))]
//! Source-context selection through the real Core SQLite and execution boundaries.
//! The SDK producer/checker is synthetic; these tests do not establish domain fact accuracy.
mod support;

use std::sync::Arc;
use tsumugi_core::{
    ProjectStore, SaveContext, SourceContextCapture, SourceContextSelection,
    ai::{
        self, AiConfig, AiRunner,
        arena::{self, ArenaConfig},
    },
    content::ContentRow,
    execution::{ErrorCode, ExecutionId, ExecutionRuntime, RecoveryPolicy},
};
use tsumugi_plugin_sdk as sdk;

fn config(selection: SourceContextSelection) -> AiConfig {
    AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        source_context: selection,
        ..Default::default()
    }
}

fn selected(capture: &SourceContextCapture) -> &tsumugi_core::SelectedSourceContext {
    match capture {
        SourceContextCapture::Selected { value } => value,
        SourceContextCapture::NotSelected => panic!("expected selected source context"),
    }
}

fn provider_content(config: &AiConfig, item: &ai::AiItem) -> serde_json::Value {
    let body = ai::request_body(config, item).unwrap();
    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap()
}

fn fact_block(target: sdk::ContentTarget, facts: Vec<sdk::SourceContextFact>) -> sdk::DomainBlock {
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
        fact_block(
            sdk::ContentTarget::Snapshot,
            vec![sdk::SourceContextFact {
                id: "local-scene-id".into(),
                kind: sdk::SourceContextFactKind::Scene,
                text: "extracted scene".into(),
                origin: sdk::SourceContextFactOrigin::Extracted {
                    sources: vec![source.clone()],
                },
            }],
        ),
        fact_block(
            sdk::ContentTarget::Unit {
                id: exchange.units[0].id.clone(),
            },
            vec![sdk::SourceContextFact {
                id: "local-role-id".into(),
                kind: sdk::SourceContextFactKind::Role,
                text: "inferred role".into(),
                origin: sdk::SourceContextFactOrigin::Inferred {
                    rationale: "synthetic rationale".into(),
                    sources: vec![source],
                },
            }],
        ),
    ];
    exchange
}

fn with_unknown_required(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let mut block = fact_block(sdk::ContentTarget::Snapshot, vec![]);
    block.schema.schema_version += 1;
    block.handling = sdk::ExtensionHandling::Required;
    block.payload_utf8 = "opaque future facts".into();
    exchange.domain_blocks.push(block);
    exchange
}

fn unit(row: &ContentRow) -> ExecutionId {
    row.unit_id.unwrap()
}

#[test]
fn default_ai_and_arena_previews_keep_source_context_off() {
    let (_directory, store, rows) = support::source_fixture_with_transform(2, with_facts);
    let ordinary = config(SourceContextSelection::default());
    let ai = store
        .preview_ai(ordinary.clone(), "zh-CN", &[unit(&rows[0])])
        .unwrap();
    assert_eq!(
        ai.items[0].source_context,
        SourceContextCapture::NotSelected
    );
    assert!(
        provider_content(&ordinary, &ai.items[0])
            .get("sourceContext")
            .is_none()
    );

    let arena = store
        .preview_arena(
            ArenaConfig {
                variants: vec![ordinary.clone(), ordinary],
                max_items: 20,
                max_requests: 40,
                concurrency: 1,
                blind: false,
                parent_attempt_id: None,
            },
            "zh-CN",
            &[unit(&rows[0])],
        )
        .unwrap();
    assert!(
        arena
            .items
            .iter()
            .all(|slot| slot.item.source_context == SourceContextCapture::NotSelected)
    );
    let input = arena
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    arena::settings(&input).unwrap();
}

#[test]
fn ai_categories_are_independent_and_provider_receives_only_selected_semantics() {
    let (_directory, store, rows) = support::source_fixture_with_transform(2, with_facts);
    let source = store
        .source_context(&tsumugi_core::SourceContextRequest {
            project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
                .unwrap(),
            source_snapshot_id: store.content_scope().unwrap().current_snapshot.unwrap(),
            unit_id: unit(&rows[0]),
            source_revision_id: rows[0].source_revision_id.unwrap(),
            locale: "zh-CN".into(),
        })
        .unwrap();
    for (selection, expected_fact, expected_neighbors) in [
        (
            SourceContextSelection {
                extracted: true,
                ..Default::default()
            },
            Some("extracted scene"),
            0,
        ),
        (
            SourceContextSelection {
                inferred: true,
                ..Default::default()
            },
            Some("inferred role"),
            0,
        ),
        (
            SourceContextSelection {
                neighbors: true,
                ..Default::default()
            },
            None,
            1,
        ),
    ] {
        let config = config(selection.clone());
        let preview = store
            .preview_ai(config.clone(), "zh-CN", &[unit(&rows[0])])
            .unwrap();
        let capture = selected(&preview.items[0].source_context);
        assert_eq!(
            capture.scope.source_snapshot_id,
            source.scope.source_snapshot_id
        );
        assert_eq!(capture.source_result_digest, source.source_result_digest);
        assert_eq!(capture.selection, selection);
        assert_eq!(capture.facts.len(), usize::from(expected_fact.is_some()));
        assert_eq!(capture.neighbors.len(), expected_neighbors);
        let prompt = provider_content(&config, &preview.items[0]);
        let projected = &prompt["sourceContext"];
        assert_eq!(
            projected["facts"].as_array().unwrap().len(),
            capture.facts.len()
        );
        assert_eq!(
            projected["neighbors"].as_array().unwrap().len(),
            expected_neighbors
        );
        if let Some(text) = expected_fact {
            assert_eq!(projected["facts"][0]["text"], text);
        }
        if selection.inferred {
            assert_eq!(
                projected["facts"][0]["origin"]["rationale"],
                "synthetic rationale"
            );
        }
        let body = prompt.to_string();
        assert!(!body.contains("local-scene-id"));
        assert!(!body.contains("local-role-id"));
        assert!(!body.contains("artifactId"));
        assert!(!body.contains("sourceResultDigest"));
        assert!(!body.contains(&source.source_result_id.to_string()));
        assert!(!body.contains(if selection.extracted {
            "inferred role"
        } else {
            "extracted scene"
        }));
    }
}

#[test]
fn arena_slots_capture_separate_policies_and_fixed_input_keeps_each_slot() {
    let (_directory, store, rows) = support::source_fixture_with_transform(2, with_facts);
    let extracted = config(SourceContextSelection {
        extracted: true,
        ..Default::default()
    });
    let inferred_neighbors = config(SourceContextSelection {
        inferred: true,
        neighbors: true,
        ..Default::default()
    });
    let preview = store
        .preview_arena(
            ArenaConfig {
                variants: vec![extracted.clone(), inferred_neighbors.clone()],
                max_items: 20,
                max_requests: 40,
                concurrency: 1,
                blind: false,
                parent_attempt_id: None,
            },
            "zh-CN",
            &[unit(&rows[0])],
        )
        .unwrap();
    let first = selected(&preview.items[0].item.source_context);
    let second = selected(&preview.items[1].item.source_context);
    assert_eq!((first.facts.len(), first.neighbors.len()), (1, 0));
    assert_eq!((second.facts.len(), second.neighbors.len()), (1, 1));
    assert_eq!(
        provider_content(&extracted, &preview.items[0].item)["sourceContext"]["facts"][0]["text"],
        "extracted scene"
    );
    assert_eq!(
        provider_content(&inferred_neighbors, &preview.items[1].item)["sourceContext"]["facts"][0]
            ["text"],
        "inferred role"
    );
    let input = preview
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    arena::settings(&input).unwrap();
    for (slot, raw) in input.envelope().items.iter().enumerate() {
        let item = arena::item_payload(&input, raw.item_id).unwrap();
        assert_eq!(item.slot, slot);
        assert_eq!(
            item.item.source_context,
            preview.items[slot].item.source_context
        );
    }
}

#[test]
fn accepted_ai_input_reopens_with_original_capture_after_manual_context_changes() {
    let (directory, mut store, rows) = support::source_fixture_with_transform(2, with_facts);
    let mut config = config(SourceContextSelection {
        extracted: true,
        inferred: true,
        ..Default::default()
    });
    config.share_context = true;
    let preview = store
        .preview_ai(config.clone(), "zh-CN", &[unit(&rows[0])])
        .unwrap();
    let input = preview
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let original_bytes = input.bytes().to_vec();
    let original_body = provider_content(&config, &preview.items[0]);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register_with_policy(
            Arc::new(AiRunner::default()),
            RecoveryPolicy::ExternalUnknown,
        )
        .unwrap();
    runtime.submit(&mut store, &input).unwrap();
    let project_id =
        ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    store
        .save_context(&SaveContext {
            project_id,
            action_id: ExecutionId::new(),
            unit_id: unit(&rows[0]),
            locale: "zh-CN".into(),
            source_revision_id: rows[0].source_revision_id.unwrap(),
            expected_revision_id: None,
            text: "new human context".into(),
            reason: "synthetic update".into(),
        })
        .unwrap();
    let next = store
        .preview_ai(config.clone(), "zh-CN", &[unit(&rows[0])])
        .unwrap();
    assert_eq!(
        next.items[0].context.as_ref().unwrap().text,
        "new human context"
    );
    assert_ne!(next.digest, preview.digest);
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    let accepted = reopened
        .execution_input(input.envelope().attempt_id)
        .unwrap();
    assert_eq!(accepted.bytes(), original_bytes);
    let item = ai::item_payload(&accepted, accepted.envelope().items[0].item_id).unwrap();
    assert_eq!(item.source_context, preview.items[0].source_context);
    assert!(item.context.is_none());
    assert_eq!(provider_content(&config, &item), original_body);
}

#[test]
fn missing_facts_remain_visible_and_unknown_required_facts_block_fact_selection() {
    let (_directory, store, rows) = support::source_fixture();
    let facts = config(SourceContextSelection {
        extracted: true,
        ..Default::default()
    });
    let preview = store.preview_ai(facts, "zh-CN", &[unit(&rows[0])]).unwrap();
    let capture = selected(&preview.items[0].source_context);
    assert!(capture.observations.missing_blocks);
    assert!(capture.facts.is_empty());
    assert_eq!(capture.observations.empty_blocks, 0);

    let (_directory, store, rows) =
        support::source_fixture_with_transform(2, with_unknown_required);
    let failure = store
        .preview_ai(
            config(SourceContextSelection {
                inferred: true,
                ..Default::default()
            }),
            "zh-CN",
            &[unit(&rows[0])],
        )
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::DependencyConflict);
    assert_eq!(failure.stage, "source-context-interpreter");
    let neighbors = config(SourceContextSelection {
        neighbors: true,
        ..Default::default()
    });
    let allowed = store
        .preview_ai(neighbors, "zh-CN", &[unit(&rows[0])])
        .unwrap();
    let capture = selected(&allowed.items[0].source_context);
    assert_eq!(capture.observations.unknown_required_blocks, 1);
    assert_eq!(capture.neighbors.len(), 1);
}
