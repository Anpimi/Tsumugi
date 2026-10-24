#![cfg(not(feature = "execution-test-host"))]
//! Bounded data plumbing with a synthetic producer/checker, not domain truth.
mod support;
use tsumugi_core::{ProjectStore, execution::*};
use tsumugi_plugin_sdk as sdk;

fn quoted_preserved_content(mut source: sdk::ContentExchange) -> sdk::ContentExchange {
    source.domain_blocks.push(sdk::DomainBlock {
        target: sdk::ContentTarget::Snapshot,
        schema: sdk::ContractRef {
            id: "example.opaque-fidelity".into(),
            schema_version: 1,
            behavior_version: 1,
        },
        handling: sdk::ExtensionHandling::Preserve,
        payload_utf8: "\"".repeat(1_400_000),
    });
    source
}

#[test]
fn large_quoted_source_uses_one_original_frame_and_checked_digest_projection_after_reopen() {
    let (directory, store, rows) =
        support::source_fixture_with_transform(2, quoted_preserved_content);
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let page = store.source_content(snapshot, 0, 10).unwrap();
    assert_eq!(page.rows, rows);
    let input = store.execution_input(page.attempt_id).unwrap();
    let result = store
        .execution_result(page.attempt_id, page.result_id)
        .unwrap();
    let sdk::InvocationOutcome::Succeeded { output } =
        &result.envelope().plugin.as_ref().unwrap().result.outcome
    else {
        panic!("successful original source frame");
    };
    assert!(output.utf8.len() > 2 * 1024 * 1024);
    assert!(output.utf8.len() < 4 * 1024 * 1024);
    let exchange = sdk::parse_content_exchange(output.utf8.as_bytes()).unwrap();
    assert_eq!(
        exchange.domain_blocks[0].payload_utf8,
        "\"".repeat(1_400_000)
    );
    let projection = serde_json::json!([output.schema, output.sha256]);
    assert_eq!(result.envelope().output.as_ref(), Some(&projection));
    assert!(serde_json::to_vec(&projection).unwrap().len() < 256);
    assert!(result.bytes().len() > 4 * 1024 * 1024);
    assert!(result.bytes().len() < 8 * 1024 * 1024);
    let mut substituted = result.envelope().clone();
    substituted.output = Some(serde_json::json!([output.schema, "0".repeat(64)]));
    assert_eq!(
        FixedResult::capture(substituted, &input, result.envelope().dispatch_token)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let mut wrong_shape = result.envelope().clone();
    let mut changed_exchange = exchange.clone();
    changed_exchange.domain_blocks[0].payload_utf8.clear();
    wrong_shape.output = Some(serde_json::to_value(changed_exchange).unwrap());
    assert_eq!(
        FixedResult::capture(wrong_shape, &input, result.envelope().dispatch_token)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let mut duplicate_projection = result.envelope().clone();
    duplicate_projection.output = Some(serde_json::to_value(&exchange).unwrap());
    assert_eq!(
        FixedResult::capture(
            duplicate_projection,
            &input,
            result.envelope().dispatch_token
        )
        .unwrap_err()
        .code,
        ErrorCode::LimitExceeded
    );
    println!(
        "sourceRawBytes={} storedResultBytes={} projectionBytes={}",
        output.utf8.len(),
        result.bytes().len(),
        serde_json::to_vec(&projection).unwrap().len()
    );
    let bytes = result.bytes().to_vec();
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .execution_result(page.attempt_id, page.result_id)
            .unwrap()
            .bytes(),
        bytes
    );
    assert_eq!(reopened.source_content(snapshot, 0, 10).unwrap().rows, rows);
}
