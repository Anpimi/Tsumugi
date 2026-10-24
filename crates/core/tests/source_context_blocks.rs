#![cfg(not(feature = "execution-test-host"))]
//! Adopted source evidence through normal Core, with the existing synthetic
//! SDK producer/checker. Local inspection never authorizes interpretation.
mod support;

use tsumugi_core::{
    ProjectStore, SaveContext, SourceContextBlockBasis, SourceContextBlockDescriptor,
    SourceContextBlockRead, SourceContextPage, SourceContextPageEntry, SourceContextRequest,
    SourceContextSelection,
    ai::{self, AiConfig},
    content::ContentRow,
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

fn block(target: sdk::ContentTarget, id: &str, payload: String) -> sdk::DomainBlock {
    sdk::DomainBlock {
        target,
        schema: sdk::ContractRef {
            id: id.into(),
            schema_version: 1,
            behavior_version: 1,
        },
        handling: sdk::ExtensionHandling::Required,
        payload_utf8: payload,
    }
}

fn opaque_payload() -> String {
    // Duplicate keys and large integers must survive without a JSON round trip.
    " {\"value\":9007199254740993,\"value\":2,\"code\":\"<script>&\"} \r\n".into()
}

fn with_blocks(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
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
                    text: "Known scene 👩🏽‍💻".into(),
                    origin: sdk::SourceContextFactOrigin::Extracted {
                        sources: vec![source],
                    },
                }],
            })
            .unwrap(),
        },
        block(
            sdk::ContentTarget::Snapshot,
            "example.snapshot",
            opaque_payload(),
        ),
        block(
            sdk::ContentTarget::Unit {
                id: exchange.units[0].id.clone(),
            },
            "example.fields",
            "設定 👩🏽‍💻 \" \\ \n".repeat(1000),
        ),
        block(
            sdk::ContentTarget::Occurrence {
                id: exchange.units[0].occurrences[0].id.clone(),
            },
            "other.identity",
            "x".repeat(tsumugi_core::MAX_SOURCE_CONTEXT_PAGE_BYTES + 1),
        ),
        block(
            sdk::ContentTarget::Unit {
                id: exchange.units[1].id.clone(),
            },
            "example.fields",
            "Only another unit".into(),
        ),
        block(
            sdk::ContentTarget::Occurrence {
                id: exchange.units[1].occurrences[0].id.clone(),
            },
            "other.identity",
            "Only another occurrence".into(),
        ),
    ];
    exchange
}

fn descriptors(page: &SourceContextPage) -> Vec<SourceContextBlockDescriptor> {
    page.entries
        .iter()
        .filter_map(|entry| match entry {
            SourceContextPageEntry::StoredBlock { value } => Some(value.clone()),
            _ => None,
        })
        .collect()
}

fn read(
    view: &tsumugi_core::SourceContextView,
    descriptor: SourceContextBlockDescriptor,
) -> SourceContextBlockRead {
    SourceContextBlockRead {
        basis: SourceContextBlockBasis::from(view),
        descriptor,
    }
}

#[test]
fn all_schemas_and_targets_have_exact_read_only_descriptors_without_entering_ai_capture() {
    let (directory, store, rows) = support::source_fixture_with_transform(2, with_blocks);
    let scope = request(&store, &rows[0]);
    let before = store.source_context(&scope).unwrap();
    let config = AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        source_context: SourceContextSelection {
            extracted: true,
            ..Default::default()
        },
        ..Default::default()
    };
    let preview = store
        .preview_ai(config.clone(), "zh-CN", &[scope.unit_id])
        .unwrap();
    let provider = ai::request_body(&config, &preview.items[0]).unwrap();
    let path = directory.path().join("project/project.sqlite3");
    let bytes = std::fs::read(&path).unwrap();
    let page = store.source_context_page(&scope, 0, 20).unwrap();
    assert_eq!(page.observations.known_facts, 1);
    assert_eq!(page.observations.unknown_required_blocks, 0);
    let descriptors = descriptors(&page);
    assert_eq!(
        descriptors
            .iter()
            .map(|value| value.block_index)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert!(matches!(
        descriptors[1].target,
        sdk::ContentTarget::Snapshot
    ));
    assert!(matches!(
        descriptors[2].target,
        sdk::ContentTarget::Unit { .. }
    ));
    assert!(matches!(
        descriptors[3].target,
        sdk::ContentTarget::Occurrence { .. }
    ));
    assert!(descriptors[0].in_revision_basis);
    assert!(!descriptors[1].in_revision_basis);
    assert!(descriptors[2].payload_bytes > 4096);
    assert!(descriptors[3].payload_bytes as usize > tsumugi_core::MAX_SOURCE_CONTEXT_PAGE_BYTES);
    assert!(
        serde_json::to_vec(&page).unwrap().len() <= tsumugi_core::MAX_SOURCE_CONTEXT_PAGE_BYTES
    );
    for (index, descriptor) in descriptors.iter().enumerate() {
        let detail = store
            .source_context_block(&read(&before, descriptor.clone()))
            .unwrap();
        assert_eq!(detail.basis, SourceContextBlockBasis::from(&before));
        assert_eq!(detail.descriptor, *descriptor);
        assert_eq!(detail.payload_utf8.len(), descriptor.payload_bytes as usize);
        if index == 1 {
            assert_eq!(detail.payload_utf8, opaque_payload());
        }
        if index == 3 {
            assert_eq!(
                detail.payload_utf8,
                "x".repeat(tsumugi_core::MAX_SOURCE_CONTEXT_PAGE_BYTES + 1)
            );
        }
    }
    let after = store.source_context(&scope).unwrap();
    assert_eq!(after, before);
    let after_preview = store
        .preview_ai(config.clone(), "zh-CN", &[scope.unit_id])
        .unwrap();
    assert_eq!(
        preview.items[0].source_context,
        after_preview.items[0].source_context
    );
    assert_eq!(
        provider,
        ai::request_body(&config, &after_preview.items[0]).unwrap()
    );
    assert!(
        !serde_json::to_string(&provider)
            .unwrap()
            .contains("9007199254740993")
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let retained = store
        .source_context_block(&read(&before, descriptors[1].clone()))
        .unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .source_context_block(&read(&before, descriptors[1].clone()))
            .unwrap(),
        retained
    );
}

fn with_unknown_facts(exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let mut exchange = with_blocks(exchange);
    let mut unknown = block(
        sdk::ContentTarget::Snapshot,
        sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID,
        "Uninterpreted future syntax \" <script>".into(),
    );
    unknown.schema.schema_version = 2;
    exchange.domain_blocks.push(unknown);
    exchange
}

#[test]
fn unknown_required_facts_remain_inspectable_but_selection_still_refuses_interpretation() {
    let (_directory, store, rows) = support::source_fixture_with_transform(2, with_unknown_facts);
    let scope = request(&store, &rows[0]);
    let view = store.source_context(&scope).unwrap();
    let page = store.source_context_page(&scope, 0, 20).unwrap();
    assert_eq!(page.observations.unknown_required_blocks, 1);
    let descriptor = descriptors(&page)
        .into_iter()
        .find(|value| value.schema.schema_version == 2)
        .unwrap();
    let detail = store
        .source_context_block(&read(&view, descriptor))
        .unwrap();
    assert_eq!(
        detail.payload_utf8,
        "Uninterpreted future syntax \" <script>"
    );
    let selection = SourceContextSelection {
        extracted: true,
        ..Default::default()
    };
    assert!(tsumugi_core::select_source_context(&view, &selection).is_err());
    assert_eq!(store.source_context(&scope).unwrap(), view);
}

#[test]
fn details_reject_substituted_scope_basis_descriptor_and_other_units_blocks() {
    let (directory, store, rows) = support::source_fixture_with_transform(2, with_blocks);
    let scope = request(&store, &rows[0]);
    let view = store.source_context(&scope).unwrap();
    let page = store.source_context_page(&scope, 0, 20).unwrap();
    let original = read(&view, descriptors(&page)[2].clone());
    let path = directory.path().join("project/project.sqlite3");
    let bytes = std::fs::read(&path).unwrap();
    for scenario in 0..17 {
        let mut forged = original.clone();
        match scenario {
            0 => forged.basis.scope.project_id = ExecutionId::new(),
            1 => forged.basis.scope.source_snapshot_id = ExecutionId::new(),
            2 => forged.basis.scope.unit_id = rows[1].unit_id.unwrap(),
            3 => forged.basis.scope.source_revision_id = ExecutionId::new(),
            4 => forged.basis.scope.locale = "fr".into(),
            5 => {
                forged.basis.content_revision =
                    Revision::new(view.content_revision.get() + 1).unwrap()
            }
            6 => forged.basis.source_attempt_id = ExecutionId::new(),
            7 => forged.basis.source_result_id = ExecutionId::new(),
            8 => forged.basis.source_result_digest = "0".repeat(64),
            9 => forged.basis.source_locale = "fr".into(),
            10 => forged.basis.local_unit_id = "another".into(),
            11 => forged.descriptor.block_index = u32::MAX,
            12 => forged.descriptor.target = sdk::ContentTarget::Snapshot,
            13 => forged.descriptor.schema.behavior_version += 1,
            14 => forged.descriptor.handling = sdk::ExtensionHandling::Optional,
            15 => forged.descriptor.in_revision_basis = !forged.descriptor.in_revision_basis,
            _ => forged.descriptor.payload_bytes += 1,
        }
        assert!(
            store.source_context_block(&forged).is_err(),
            "scenario {scenario}"
        );
    }
    let other = store.source_context(&request(&store, &rows[1])).unwrap();
    let cross_unit = SourceContextBlockRead {
        basis: SourceContextBlockBasis::from(&other),
        ..original.clone()
    };
    assert_eq!(
        store.source_context_block(&cross_unit).unwrap_err().stage,
        "source-context-block-descriptor"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert!(store.source_context_block(&original).is_ok());
}

#[test]
fn unrelated_manual_context_does_not_expire_the_original_source_content_basis() {
    let (_directory, mut store, rows) = support::source_fixture_with_transform(2, with_blocks);
    let scope = request(&store, &rows[0]);
    let view = store.source_context(&scope).unwrap();
    let page = store.source_context_page(&scope, 0, 20).unwrap();
    let original = read(&view, descriptors(&page)[1].clone());
    let detail = store.source_context_block(&original).unwrap();
    store
        .save_context(&SaveContext {
            project_id: scope.project_id,
            action_id: ExecutionId::new(),
            unit_id: scope.unit_id,
            locale: scope.locale,
            source_revision_id: scope.source_revision_id,
            expected_revision_id: None,
            text: "human-only context".into(),
            reason: "separate owner".into(),
        })
        .unwrap();
    assert_eq!(store.source_context_block(&original).unwrap(), detail);
}

#[test]
fn a_warm_detail_rechecks_source_mapping_semantic_proof_and_result_bytes() {
    for scenario in 0..3 {
        let (directory, store, rows) = support::source_fixture_with_transform(2, with_blocks);
        let scope = request(&store, &rows[0]);
        let view = store.source_context(&scope).unwrap();
        let page = store.source_context_page(&scope, 0, 20).unwrap();
        let original = read(&view, descriptors(&page)[1].clone());
        store.source_context_block(&original).unwrap();
        let path = directory.path().join("project/project.sqlite3");
        let db = rusqlite::Connection::open(&path).unwrap();
        match scenario {
            0 => {
                db.execute("UPDATE source_occurrences SET local_unit_id='substituted' WHERE occurrence_id=?1", [rows[0].occurrence_id.unwrap().to_string()]).unwrap();
            }
            1 => {
                db.execute(
                    "UPDATE plugin_validation_links SET valid=0 WHERE producer_result_id=?1",
                    [view.source_result_id.to_string()],
                )
                .unwrap();
            }
            _ => {
                let mut bytes: Vec<u8> = db
                    .query_row(
                        "SELECT bytes FROM execution_results WHERE result_id=?1",
                        [view.source_result_id.to_string()],
                        |row| row.get(0),
                    )
                    .unwrap();
                bytes.push(b' ');
                db.execute(
                    "UPDATE execution_results SET bytes=?1 WHERE result_id=?2",
                    rusqlite::params![bytes, view.source_result_id.to_string()],
                )
                .unwrap();
            }
        }
        drop(db);
        let bytes = std::fs::read(&path).unwrap();
        assert!(
            store.source_context_block(&original).is_err(),
            "scenario {scenario}"
        );
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

fn maximum_payload(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    let mut payload = "\u{0001}".repeat(sdk::MAX_EXCHANGE_BYTES / 8);
    payload.push_str(&"x".repeat(sdk::MAX_EXCHANGE_BYTES - payload.len()));
    exchange.domain_blocks = vec![block(
        sdk::ContentTarget::Snapshot,
        "example.large",
        payload,
    )];
    exchange
}

#[test]
fn maximum_legal_payload_with_expanding_json_escapes_is_returned_complete() {
    let (_directory, store, rows) = support::source_fixture_with_transform(2, maximum_payload);
    let scope = request(&store, &rows[0]);
    let view = store.source_context(&scope).unwrap();
    let page = store.source_context_page(&scope, 0, 20).unwrap();
    assert!(page.observations.missing_blocks);
    let descriptor = descriptors(&page).remove(0);
    assert_eq!(descriptor.payload_bytes as usize, sdk::MAX_EXCHANGE_BYTES);
    let detail = store
        .source_context_block(&read(&view, descriptor))
        .unwrap();
    assert_eq!(detail.payload_utf8.len(), sdk::MAX_EXCHANGE_BYTES);
    assert!(
        detail.payload_utf8.as_bytes()[..sdk::MAX_EXCHANGE_BYTES / 8]
            .iter()
            .all(|byte| *byte == 1)
    );
    assert!(
        detail.payload_utf8.as_bytes()[sdk::MAX_EXCHANGE_BYTES / 8..]
            .iter()
            .all(|byte| *byte == b'x')
    );
    let encoded = serde_json::to_vec(&detail).unwrap();
    assert!(encoded.len() > sdk::MAX_EXCHANGE_BYTES);
    assert!(encoded.len() <= tsumugi_core::MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES);
    assert_eq!(
        serde_json::from_slice::<tsumugi_core::SourceContextBlockDetail>(&encoded).unwrap(),
        detail
    );
}
