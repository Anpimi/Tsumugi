use super::*;
#[test]
fn source_wire_fixture_matches_rust_types() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/sourceCommands.contract.json"
    ))
    .unwrap();
    fn round_trip<T: serde::de::DeserializeOwned + Serialize>(value: &serde_json::Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round_trip::<SessionRequest>(&fixture["session"]);
    round_trip::<SourceSelection>(&fixture["selection"]);
    round_trip::<CaptureRequest>(&fixture["capture"]);
    round_trip::<StartRequest>(&fixture["start"]);
    round_trip::<PreviewRequest>(&fixture["preview"]);
    round_trip::<ContentRequest>(&fixture["content"]);
    round_trip::<SourceAdoptRequest>(&fixture["prepare"]);
    round_trip::<ContentPage>(&fixture["page"]);
    let mut unknown = fixture["prepare"].clone();
    unknown["confirmation"]["requiredExtension"] = serde_json::json!("unknown/v1");
    assert!(serde_json::from_value::<SourceAdoptRequest>(unknown).is_err());
}
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

fn call(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(json!({"request":body})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|r| r.deserialize::<Value>().unwrap())
}

#[test]
#[cfg(windows)]
fn production_source_ipc_captures_previews_commits_and_reopens() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("mod");
    std::fs::create_dir_all(source.join("i18n")).unwrap();
    std::fs::write(
        source.join("manifest.json"),
        include_bytes!(
            "../../../../../../../crates/core/tests/fixtures/stardew-lookup/manifest.json"
        ),
    )
    .unwrap();
    std::fs::write(
        source.join("i18n/default.json"),
        include_bytes!(
            "../../../../../../../crates/core/tests/fixtures/stardew-lookup/i18n/default.json"
        ),
    )
    .unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(&view,"create_project",json!({"destination":temp.path().join("project"),"displayName":"Import fixture","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let mut wrong = context.clone();
    wrong["projectId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_content_scope", wrong).is_err());
    let selection = ExecutionId::new();
    // The test grants a real native directory handle instead of opening a UI picker.
    // No path-grant IPC command is registered in either product configuration.
    {
        let state = app.state::<AppState>();
        let mut sessions = state.sessions.lock().unwrap();
        let host = sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0;
        host.source.selection = Some((
            selection,
            Arc::new(capture::Selection::authorize(source.clone()).unwrap()),
        ));
    }
    let mut capture = context.clone();
    capture["selectionId"] = json!(selection);
    capture["sourceLanguage"] = json!("en");
    let mut stale = capture.clone();
    stale["selectionId"] = json!(ExecutionId::new());
    assert!(call(&view, "preflight_source", stale).is_err());
    let mut language = capture.clone();
    language["sourceLanguage"] = json!("zh-CN");
    assert!(call(&view, "preflight_source", language).is_err());
    let mut arbitrary = capture.clone();
    arbitrary["path"] = json!(source);
    assert!(call(&view, "preflight_source", arbitrary).is_err());
    assert_eq!(
        call(&view, "preflight_source", capture.clone()).unwrap()["count"],
        532
    );
    assert_eq!(
        call(&view, "read_content_scope", context.clone()).unwrap()["revision"],
        "1"
    );
    assert_eq!(
        call(&view, "list_execution_tasks", {
            let mut r = context.clone();
            r["after"] = json!("0");
            r["limit"] = json!(50);
            r
        })
        .unwrap(),
        json!([])
    );
    let attempt = ExecutionId::new();
    capture["attemptId"] = json!(attempt);
    assert_eq!(
        call(&view, "start_source_import", capture.clone()).unwrap(),
        json!(attempt)
    );
    assert_eq!(
        call(&view, "start_source_import", capture).unwrap(),
        json!(attempt)
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let detail = loop {
        {
            let state = app.state::<AppState>();
            let mut sessions = state.sessions.lock().unwrap();
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.tick(store).unwrap();
        }
        let mut r = context.clone();
        r["attemptId"] = json!(attempt);
        r["offset"] = json!(0);
        r["limit"] = json!(1);
        let detail = call(&view, "read_execution_attempt", r).unwrap();
        if detail["items"][0]["status"]["validation"] == "valid" {
            break detail;
        }
        assert!(Instant::now() < deadline, "{detail}");
        std::thread::sleep(Duration::from_millis(1));
    };
    call(&view, "cancel_source_capture", context.clone()).unwrap();
    std::fs::remove_file(source.join("i18n/default.json")).unwrap();
    let mut request = context.clone();
    request["attemptId"] = json!(attempt);
    request["resultId"] = detail["items"][0]["resultId"].clone();
    request["after"] = json!(0);
    request["limit"] = json!(100);
    let preview = call(&view, "read_source_preview", request.clone()).unwrap();
    assert_eq!(preview["total"], 532);
    assert_eq!(preview["rows"].as_array().unwrap().len(), 100);
    assert_eq!(
        call(&view, "read_source_preview", request).unwrap(),
        preview
    );
    assert_eq!(
        call(&view, "read_content_scope", context.clone()).unwrap()["currentSnapshot"],
        Value::Null
    );
    let action = ExecutionId::new();
    let mut prepare = context.clone();
    prepare["attemptId"] = json!(attempt);
    prepare["resultId"] = preview["resultId"].clone();
    prepare["actionId"] = json!(action);
    prepare["confirmation"] = preview["confirmation"].clone();
    call(&view, "prepare_source_adoption", prepare).unwrap();
    let mut adopt = context.clone();
    adopt["actionId"] = json!(action);
    let receipt = call(&view, "adopt_execution", adopt.clone()).unwrap();
    assert_eq!(
        call(&view, "read_execution_receipt", adopt.clone()).unwrap(),
        receipt
    );
    assert_eq!(call(&view, "adopt_execution", adopt).unwrap(), receipt);
    let snapshot = receipt["changes"][0]["id"].clone();
    let mut read = context.clone();
    read["snapshotId"] = snapshot.clone();
    read["after"] = json!(0);
    read["limit"] = json!(100);
    let content = call(&view, "read_source_content", read.clone()).unwrap();
    assert_eq!(content["total"], 532);
    call(
        &view,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &view,
        "open_project",
        json!({"locator":temp.path().join("project")}),
    )
    .unwrap();
    assert!(call(&view, "read_source_content", read.clone()).is_err());
    read["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_source_content", read).unwrap(), content);
    call(
        &view,
        "close_project",
        json!({"sessionToken":reopened["sessionToken"]}),
    )
    .unwrap();
}
