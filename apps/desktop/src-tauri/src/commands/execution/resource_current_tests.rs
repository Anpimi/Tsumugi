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
fn registered_current_term_reads_the_exact_pointer_beyond_a_list_page_without_writes() {
    let (directory, mut store, _) = fixture::source_fixture();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    for index in 0..101 {
        store.save_term(&SaveTerm { project_id: project, action_id: ExecutionId::new(), term_id: None,
            locale: "zh-CN".into(), source: format!("Synthetic term {index}"), aliases: vec![],
            target: format!("合成术语 {index} 👩🏽‍💻"), protected: false, scope_unit_id: None,
            expected_revision_id: None, reason: "Synthetic manual terminology".into() }).unwrap();
    }
    let first = store.list_terms(project, "zh-CN", None, 100).unwrap();
    let last = store.list_terms(project, "zh-CN", Some(&first.last().unwrap().term_id), 100).unwrap().remove(0);
    let original = store.current_term_revision(project, &last.term_id).unwrap().unwrap();
    assert_eq!(original, last);
    let saved = store.save_term(&SaveTerm { project_id: project, action_id: ExecutionId::new(),
        term_id: Some(last.term_id.clone()), locale: "zh-CN".into(), source: last.source,
        aliases: vec![], target: "A newer saved translation".into(), protected: true, scope_unit_id: None,
        expected_revision_id: Some(last.revision_id), reason: "A newer human change".into() }).unwrap();
    let history = store.term_history(project, &saved.term_id, 0, 1).unwrap();
    assert_ne!(history[0].revision_id, saved.revision_id, "the first history row is not the current basis");
    assert!(store.current_term_revision(ExecutionId::new(), &saved.term_id).is_err());
    assert!(store.current_term_revision(project, "").is_err());
    store.close().unwrap();

    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let request = json!({"sessionToken": opened["sessionToken"], "projectId": project, "termId": saved.term_id});
    let before = app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap())
    });
    let read = call(&window, "read_term_current", request.clone()).unwrap();
    assert_eq!(read, serde_json::to_value(&saved).unwrap());
    assert_eq!(call(&window, "read_term_current", request.clone()).unwrap(), read);
    let after = app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap())
    });
    assert_eq!(serde_json::to_value(before).unwrap(), serde_json::to_value(after).unwrap(), "reading must not change project facts");
    let mut missing = request.clone(); missing["termId"] = json!("missing-synthetic-term");
    assert_eq!(call(&window, "read_term_current", missing).unwrap(), Value::Null);
    for (field, value) in [("sessionToken", json!("retired-session")), ("projectId", json!(ExecutionId::new())), ("termId", json!(""))] {
        let mut wrong = request.clone(); wrong[field] = value;
        assert!(call(&window, "read_term_current", wrong).is_err(), "{field}");
    }
    call(&window, "close_project", json!({"sessionToken": opened["sessionToken"], "projectId": project})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let mut again = request; again["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&window, "read_term_current", again).unwrap(), read);
}
