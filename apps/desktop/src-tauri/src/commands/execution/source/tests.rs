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

#[cfg(windows)]
fn wait_for_execution_idle(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = call(webview, "execution_status", context.clone()).unwrap();
        if status["active"] == false {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "execution stayed active: {status}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
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
        let source = source.clone();
        state.sessions.with(move |sessions| {
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
        })
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
            state.sessions.with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
            })
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
    wait_for_execution_idle(&view, &context);
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

#[test]
#[cfg(windows)]
fn translation_ipc_imports_candidates_edits_and_reopens() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("mod");
    std::fs::create_dir_all(source.join("i18n")).unwrap();
    std::fs::write(source.join("manifest.json"), br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#).unwrap();
    std::fs::write(
        source.join("i18n/default.json"),
        br#"{"first":"same","second":"same"}"#,
    )
    .unwrap();
    std::fs::write(
        source.join("i18n/zh.json"),
        r#"{"FIRST":"你好","second":"","missing":"same"}"#.as_bytes(),
    )
    .unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &view,
        "create_project",
        json!({
            "destination": temp.path().join("project"), "displayName":"Translation IPC",
            "sourceLocale":"en", "targetLocales":["zh-CN"]
        }),
    )
    .unwrap();
    let mut context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let selection = ExecutionId::new();
    {
        let state = app.state::<AppState>();
        let source = source.clone();
        state.sessions.with(move |sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution_parts()
                .unwrap()
                .0
                .source
                .selection = Some((
                selection,
                Arc::new(capture::Selection::authorize(source.clone()).unwrap()),
            ));
        })
    }
    let mut files = context.clone();
    files["selectionId"] = json!(selection);
    assert_eq!(
        call(&view, "list_translation_files", files).unwrap(),
        json!(["zh.json"])
    );
    let mut capture = context.clone();
    capture["selectionId"] = json!(selection);
    capture["sourceLanguage"] = json!("en");
    let source_attempt = ExecutionId::new();
    capture["attemptId"] = json!(source_attempt);
    call(&view, "start_source_import", capture).unwrap();
    let wait = |attempt: ExecutionId, expected: usize| {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            {
                let state = app.state::<AppState>();
                state.sessions.with(move |sessions| {
                    let (host, store) =
                        sessions.active.as_mut().unwrap().execution_parts().unwrap();
                    host.tick(store).unwrap();
                })
            }
            let mut request = context.clone();
            request["attemptId"] = json!(attempt);
            request["offset"] = json!(0);
            request["limit"] = json!(100);
            let detail = call(&view, "read_execution_attempt", request).unwrap();
            if detail["items"].as_array().unwrap().len() == expected
                && detail["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| item["status"]["validation"] == "valid")
            {
                return detail;
            }
            assert!(Instant::now() < deadline, "{detail}");
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    let detail = wait(source_attempt, 1);
    let source_result = detail["items"][0]["resultId"].clone();
    let mut source_preview = context.clone();
    source_preview["attemptId"] = json!(source_attempt);
    source_preview["resultId"] = source_result.clone();
    source_preview["after"] = json!(0);
    source_preview["limit"] = json!(10);
    let preview = call(&view, "read_source_preview", source_preview).unwrap();
    let source_action = ExecutionId::new();
    let mut prepare = context.clone();
    prepare["attemptId"] = json!(source_attempt);
    prepare["resultId"] = source_result;
    prepare["actionId"] = json!(source_action);
    prepare["confirmation"] = preview["confirmation"].clone();
    call(&view, "prepare_source_adoption", prepare).unwrap();
    let mut adopt = context.clone();
    adopt["actionId"] = json!(source_action);
    call(&view, "adopt_execution", adopt).unwrap();

    let mut translation = context.clone();
    translation["selectionId"] = json!(selection);
    translation["fileName"] = json!("zh.json");
    translation["targetLocale"] = json!("zh-CN");
    assert_eq!(
        call(&view, "preflight_translation", translation.clone()).unwrap()["count"],
        3
    );
    let translation_attempt = ExecutionId::new();
    translation["attemptId"] = json!(translation_attempt);
    let checked = call(&view, "preflight_translation", {
        let mut request = translation.clone();
        request.as_object_mut().unwrap().remove("attemptId");
        request
    })
    .unwrap();
    translation["expectedFileDigest"] = checked["fileDigest"].clone();
    translation["expectedSourceSnapshotId"] = checked["sourceSnapshotId"].clone();
    translation["languageConfirmed"] = json!(false);
    assert!(call(&view, "start_translation_import", translation.clone()).is_err());
    translation["languageConfirmed"] = json!(true);
    call(&view, "start_translation_import", translation.clone()).unwrap();
    assert_eq!(
        call(&view, "start_translation_import", translation).unwrap(),
        json!(translation_attempt)
    );
    wait(translation_attempt, 3);
    let mut read = context.clone();
    read["attemptId"] = json!(translation_attempt);
    read["after"] = json!(0);
    read["limit"] = json!(10);
    read["basis"] = Value::Null;
    let page = call(&view, "read_translation_preview", read.clone()).unwrap();
    assert_eq!(
        (
            page["total"].as_u64(),
            page["unique"].as_u64(),
            page["unmatched"].as_u64()
        ),
        (Some(3), Some(2), Some(1))
    );
    assert_eq!(page["rows"][0]["entry"]["nativeKey"], "FIRST");
    let import = |row: &Value, decision: &str| {
        let action_id = ExecutionId::new();
        let request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
            "attemptId":translation_attempt,"itemId":row["itemId"],"resultId":row["resultId"],"actionId":action_id,
            "confirmation":{"resultDigest":row["resultDigest"],"sourceSnapshotId":page["currentSourceSnapshotId"],
                "occurrenceId":row["occurrenceId"],"sourceRevisionId":row["sourceRevisionId"],
                "targetUnitId":row["unitId"],"expectedSelectionId":row["currentSelection"]["eventId"],"decision":decision}});
        (action_id, request)
    };
    let (_first_id, first_request) = import(&page["rows"][0], "candidate-only");
    call(&view, "prepare_translation_adoption", first_request.clone()).unwrap();
    let first_id = first_request["actionId"].clone();
    let first_receipt = call(&view, "adopt_execution", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":first_id})).unwrap();
    assert_eq!(first_receipt["changes"].as_array().unwrap().len(), 1);
    let (_second_id, second_request) = import(&page["rows"][1], "select-if-empty");
    call(
        &view,
        "prepare_translation_adoption",
        second_request.clone(),
    )
    .unwrap();
    let second_receipt = call(&view, "adopt_execution", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":second_request["actionId"]})).unwrap();
    assert_eq!(second_receipt["changes"].as_array().unwrap().len(), 2);
    let mut history = context.clone();
    history["unitId"] = page["rows"][0]["unitId"].clone();
    history["locale"] = json!("zh-CN");
    history["afterOrdinal"] = json!(0);
    history["limit"] = json!(10);
    let imported = call(&view, "read_translation_history", history.clone()).unwrap();
    assert_eq!(imported["total"], 1);
    assert_eq!(imported["current"], Value::Null);
    let mut save = context.clone();
    save["actionId"] = json!(ExecutionId::new());
    save["unitId"] = history["unitId"].clone();
    save["locale"] = json!("zh-CN");
    save["sourceRevisionId"] = page["rows"][0]["sourceRevisionId"].clone();
    save["expectedSelectionId"] = Value::Null;
    save["text"] = json!("人工编辑");
    let manual = call(&view, "save_translation_revision", save.clone()).unwrap();
    assert_eq!(
        call(&view, "save_translation_revision", save).unwrap(),
        manual
    );
    let mut select = context.clone();
    select["actionId"] = json!(ExecutionId::new());
    select["unitId"] = history["unitId"].clone();
    select["locale"] = json!("zh-CN");
    select["sourceRevisionId"] = page["rows"][0]["sourceRevisionId"].clone();
    select["expectedSelectionId"] = manual["eventId"].clone();
    select["revisionId"] = imported["rows"][0]["revisionId"].clone();
    let restored = call(&view, "select_translation_revision", select).unwrap();
    assert_eq!(restored["revisionId"], imported["rows"][0]["revisionId"]);
    wait_for_execution_idle(&view, &context);
    call(
        &view,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &view,
        "open_project",
        json!({"locator":temp.path().join("project")}),
    )
    .unwrap();
    context["sessionToken"] = reopened["sessionToken"].clone();
    history["sessionToken"] = reopened["sessionToken"].clone();
    let saved = call(&view, "read_translation_history", history).unwrap();
    assert_eq!(saved["total"], 2);
    assert_eq!(saved["current"]["revisionId"], restored["revisionId"]);
    assert_eq!(saved["rows"][0]["originKind"], "import");
}
