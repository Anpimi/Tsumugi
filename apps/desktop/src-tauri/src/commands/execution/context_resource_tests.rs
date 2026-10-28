use super::*;
use serde_json::{Value, json};
use tauri::{Manager, ipc::{CallbackFn, InvokeBody}, webview::InvokeRequest};
#[allow(dead_code)]
#[path = "../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;

fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(window, InvokeRequest {
        cmd: command.into(), callback: CallbackFn(0), error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(), body: InvokeBody::Json(json!({"request": request})),
        headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
    }).map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn registered_context_resources_preserve_scope_cas_recovery_and_reopen_authority() {
    let (directory, store, rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let basis = store.content_scope().unwrap();
    let scope = tsumugi_core::SourceContextRequest { project_id: project,
        source_snapshot_id: basis.current_snapshot.unwrap(), unit_id: rows[0].unit_id.unwrap(),
        source_revision_id: rows[0].source_revision_id.unwrap(), locale: "zh-CN".into() };
    store.close().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let session = json!({"sessionToken": opened["sessionToken"], "projectId": project});
    let request = |fields: Value| { let mut value = session.clone(); value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone()); value };
    let mut originals = vec![];
    for kind in ["character", "style", "background"] {
        let resource = json!({"projectId": project, "actionId": ExecutionId::new(), "kind": kind,
            "sourceBasis": basis, "locale": "zh-CN", "scope": {"kind": "project"},
            "name": format!("Synthetic {kind} 👩🏽‍💻"), "text": "Keep {{name}} — é", "actor": "Human reviewer", "reason": "Reviewed source"});
        let save = request(json!({"resource": resource}));
        let saved = call(&window, "save_context_resource", save.clone()).unwrap();
        assert_eq!(call(&window, "save_context_resource", save.clone()).unwrap(), saved);
        assert_eq!(saved["subjectId"], saved["contextId"]);
        originals.push((resource, saved));
    }
    let (original, saved) = &originals[0];
    let current = request(json!({"contextId": saved["contextId"]}));
    assert_eq!(call(&window, "read_context_resource_current", current.clone()).unwrap(), *saved);
    let action = request(json!({"actionId": original["actionId"]}));
    let found = call(&window, "read_context_resource_action", action.clone()).unwrap();
    let canonical: SaveContextResource = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(found["request"], serde_json::to_value(ContextResourceAction::Save(canonical)).unwrap());
    assert_eq!(found["receipt"], *saved);
    let list = request(json!({"locale": "zh-CN", "kind": null, "offset": 0, "limit": 1, "basis": null}));
    let first = call(&window, "read_context_resource_page", list.clone()).unwrap();
    assert_eq!(first["nextOffset"], 1);
    let mut next = list.clone(); next["offset"] = json!(1); next["basis"] = first["basis"].clone();
    assert_eq!(call(&window, "read_context_resource_page", next.clone()).unwrap()["rows"].as_array().unwrap().len(), 1);
    let before = app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store
        .changes_since(tsumugi_core::execution::Revision::new(0).unwrap()));
    let resolve = request(json!({"scope": scope}));
    assert_eq!(call(&window, "resolve_context_resources", resolve.clone()).unwrap()["entries"].as_array().unwrap().len(), 3);
    call(&window, "read_context_resource_action", action).unwrap();
    call(&window, "read_context_resource_page", list).unwrap();
    let after = app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store
        .changes_since(tsumugi_core::execution::Revision::new(0).unwrap()));
    assert_eq!(serde_json::to_value(before).unwrap(), serde_json::to_value(after).unwrap());

    let mut edit = original.clone(); edit["actionId"] = json!(ExecutionId::new()); edit["contextId"] = saved["contextId"].clone();
    assert!(call(&window, "save_context_resource", request(json!({"resource": edit}))).is_err());
    edit["expectedRevisionId"] = saved["revisionId"].clone(); edit["text"] = json!("A newer scoped description");
    let updated = call(&window, "save_context_resource", request(json!({"resource": edit}))).unwrap();
    assert!(call(&window, "read_context_resource_page", next).is_err(), "a changed revision invalidates the page basis");
    let stop = json!({"projectId": project, "actionId": ExecutionId::new(), "contextId": saved["contextId"],
        "expectedRevisionId": updated["revisionId"], "actor": "Human reviewer", "reason": "Stop this scope"});
    let stopped = call(&window, "withdraw_context_resource", request(json!({"resource": stop}))).unwrap();
    assert_eq!(stopped["withdrawn"], true);
    let resolution = call(&window, "resolve_context_resources", resolve.clone()).unwrap();
    assert!(resolution["entries"].as_array().unwrap().iter().any(|entry| entry["revision"]["contextId"] == saved["contextId"] && entry["status"] == "withdrawn"));
    let history = call(&window, "read_context_resource_history", request(json!({"contextId": saved["contextId"], "offset": 0, "limit": 10, "basis": null}))).unwrap();
    assert_eq!(history["rows"].as_array().unwrap().len(), 3);
    let recovery = request(json!({"action": {"kind": "save", "request": original}}));
    let recovered = call(&window, "reconcile_context_resource_action", recovery.clone()).unwrap();
    assert_eq!(recovered["status"], "recorded"); assert_eq!(recovered["receipt"], *saved);
    let mut forged = recovery.clone(); forged["action"]["request"]["reason"] = json!("Changed after submission");
    assert!(call(&window, "reconcile_context_resource_action", forged).is_err());
    let mut missing = recovery.clone(); missing["action"]["request"]["actionId"] = json!(ExecutionId::new());
    let absent = call(&window, "reconcile_context_resource_action", missing).unwrap();
    assert_eq!(absent["status"], "retry-allowed"); assert!(absent["receipt"].is_null());
    for (command, mut wrong, field) in [
        ("read_context_resource_current", current.clone(), "sessionToken"),
        ("read_context_resource_current", current.clone(), "projectId"),
    ] {
        wrong[field] = if field == "sessionToken" { json!("retired-session") } else { json!(ExecutionId::new()) };
        assert!(call(&window, command, wrong).is_err());
    }
    let mut wrong = request(json!({"resource": original})); wrong["resource"]["projectId"] = json!(ExecutionId::new());
    assert!(call(&window, "save_context_resource", wrong).is_err());
    let mut wrong = recovery; wrong["action"]["request"]["projectId"] = json!(ExecutionId::new());
    assert!(call(&window, "reconcile_context_resource_action", wrong).is_err());
    let mut wrong = resolve; wrong["scope"]["projectId"] = json!(ExecutionId::new());
    assert!(call(&window, "resolve_context_resources", wrong).is_err());
    call(&window, "close_project", session.clone()).unwrap();
    let reopened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let mut read_again = current; read_again["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&window, "read_context_resource_current", read_again).unwrap(), stopped);
}

#[test]
fn context_resource_wire_fixture_matches_actual_rust_requests_and_responses() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../test/fixtures/contextResources.contract.json")).unwrap();
    macro_rules! round_trip { ($group:literal, $key:literal, $kind:ty) => {
        let value: $kind = serde_json::from_value(fixture[$group][$key].clone()).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(), fixture[$group][$key], $key);
    }; }
    round_trip!("requests", "save", ContextResourceSaveRequest);
    round_trip!("requests", "withdraw", ContextResourceWithdrawRequest);
    round_trip!("requests", "current", ContextResourceCurrentRequest);
    round_trip!("requests", "page", ContextResourceListRequest);
    round_trip!("requests", "history", ContextResourceHistoryRequest);
    round_trip!("requests", "action", ContextResourceActionRequest);
    round_trip!("requests", "recovery", ContextResourceRecoveryRequest);
    round_trip!("requests", "resolve", ContextResourceResolveRequest);
    round_trip!("responses", "saved", ContextResourceRevision);
    round_trip!("responses", "withdrawn", ContextResourceRevision);
    round_trip!("responses", "current", Option<ContextResourceRevision>);
    round_trip!("responses", "page", ContextResourcePage);
    round_trip!("responses", "history", ContextResourcePage);
    round_trip!("responses", "action", Option<ContextResourceActionRead>);
    round_trip!("responses", "recovery", ContextResourceRecovery);
    round_trip!("responses", "resolution", ContextResourceResolution);
    let mut wrong = fixture["requests"]["save"].clone(); wrong["resource"]["scope"]["scopeId"] = json!("ephemeral-query-scope");
    assert!(serde_json::from_value::<ContextResourceSaveRequest>(wrong).is_err());
}
