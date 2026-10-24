//! Mock-Tauri registered transport over adopted SQLite evidence. The existing
//! Core SDK fixture supplies grants/checks/adoption; it is not a real Worker or
//! a native WebView maximum-message observation.
use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod source_fixture;

fn large_block(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    // A maximum raw payload with legal escape expansion. All-C0 at this length
    // would exceed the original exchange/result budgets and is not a fixture.
    let mut payload = "\u{0001}".repeat(sdk::MAX_EXCHANGE_BYTES / 8);
    payload.push_str(&"x".repeat(sdk::MAX_EXCHANGE_BYTES - payload.len()));
    exchange.domain_blocks = vec![sdk::DomainBlock {
        target: sdk::ContentTarget::Snapshot,
        schema: sdk::ContractRef {
            id: "example.inspection".into(),
            schema_version: 1,
            behavior_version: 1,
        },
        handling: sdk::ExtensionHandling::Required,
        payload_utf8: payload,
    }];
    exchange
}

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn registered_block_read_preserves_maximum_raw_payload_and_checks_session_identity() {
    let (directory, store, rows) = source_fixture::source_fixture_with_transform(2, large_block);
    let scope = tsumugi_core::SourceContextRequest {
        project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
            .unwrap(),
        source_snapshot_id: store.content_scope().unwrap().current_snapshot.unwrap(),
        unit_id: rows[0].unit_id.unwrap(),
        source_revision_id: rows[0].source_revision_id.unwrap(),
        locale: "zh-CN".into(),
    };
    let view = store.source_context(&scope).unwrap();
    store.close().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "open_project",
        json!({"locator":directory.path().join("project")}),
    )
    .unwrap();
    let page = call(
        &window,
        "read_source_context",
        json!({
            "sessionToken":project["sessionToken"], "projectId":scope.project_id,
            "sourceSnapshotId":scope.source_snapshot_id, "unitId":scope.unit_id,
            "sourceRevisionId":scope.source_revision_id, "locale":scope.locale,
            "after":0, "limit":20
        }),
    )
    .unwrap();
    let descriptor = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "stored-block")
        .unwrap()["value"]
        .clone();
    assert_eq!(descriptor["payloadBytes"], sdk::MAX_EXCHANGE_BYTES as u64);
    assert_eq!(page["observations"]["missingBlocks"], true);
    assert_eq!(page["observations"]["unknownRequiredBlocks"], 0);
    let request = json!({
        "sessionToken":project["sessionToken"], "projectId":scope.project_id,
        "basis":tsumugi_core::SourceContextBlockBasis::from(&view), "descriptor":descriptor
    });
    let database = directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let detail = call(&window, "read_source_context_block", request.clone()).unwrap();
    let decoded: tsumugi_core::SourceContextBlockDetail =
        serde_json::from_value(detail.clone()).unwrap();
    assert_eq!(detail["basis"], request["basis"]);
    assert_eq!(detail["descriptor"], request["descriptor"]);
    assert_eq!(decoded.payload_utf8.len(), sdk::MAX_EXCHANGE_BYTES);
    assert!(
        decoded.payload_utf8.as_bytes()[..sdk::MAX_EXCHANGE_BYTES / 8]
            .iter()
            .all(|byte| *byte == 1)
    );
    assert!(
        decoded.payload_utf8.as_bytes()[sdk::MAX_EXCHANGE_BYTES / 8..]
            .iter()
            .all(|byte| *byte == b'x')
    );
    let encoded = serde_json::to_vec(&detail).unwrap();
    assert!(encoded.len() > sdk::MAX_EXCHANGE_BYTES);
    assert!(encoded.len() <= tsumugi_core::MAX_SOURCE_CONTEXT_BLOCK_DETAIL_BYTES);
    for field in ["sessionToken", "projectId"] {
        let mut foreign = request.clone();
        foreign[field] = if field == "sessionToken" {
            json!("wrong-session")
        } else {
            json!(ExecutionId::new())
        };
        assert_eq!(
            call(&window, "read_source_context_block", foreign).unwrap_err()["code"],
            "session-invalid"
        );
    }
    let mut inner_project = request.clone();
    inner_project["basis"]["scope"]["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "read_source_context_block", inner_project).unwrap_err()["reason"],
        "source-context-scope"
    );
    let mut injected = request.clone();
    injected["approved"] = json!(true);
    assert!(call(&window, "read_source_context_block", injected).is_err());
    assert_eq!(std::fs::read(database).unwrap(), before);
    call(
        &window,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    )
    .unwrap();
    let mut closed = request;
    closed["sessionToken"] = project["sessionToken"].clone();
    assert_eq!(
        call(&window, "read_source_context_block", closed).unwrap_err()["code"],
        "session-invalid"
    );
    app.state::<AppState>().plugins.close();
}
