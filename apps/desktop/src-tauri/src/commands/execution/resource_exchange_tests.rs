use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

const TBX: &str = include_str!("../../../../test/fixtures/tbx-exchange-plain.tbx");

const TMX: &str = include_str!("../../../../test/fixtures/tmx-exchange-plain.tmx");

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":body})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|result| result.deserialize::<Value>().unwrap())
}

fn project() -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
    tempfile::TempDir,
    Value,
) {
    let root = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({"destination":root.path().join("project"),
        "displayName":"Exchange preview", "sourceLocale":"en", "targetLocales":["zh-CN"]}),
    )
    .unwrap();
    (app, window, root, project)
}

fn request(project: &Value) -> TmxPreviewRequest {
    serde_json::from_value(json!({"sessionToken":project["sessionToken"],
        "projectId":project["metadata"]["projectId"], "locale":"zh-CN"}))
    .unwrap()
}

fn scope(
    app: &tauri::App<tauri::test::MockRuntime>,
    request: TmxPreviewRequest,
) -> (String, String) {
    tauri::async_runtime::block_on(app.state::<AppState>().sessions.run(
        "test.tmx.scope",
        CommandStage::ExecutionRead,
        move |sessions| tmx_scope(sessions, &request),
    ))
    .unwrap()
}

fn finish(
    app: &tauri::App<tauri::test::MockRuntime>,
    request: TmxPreviewRequest,
    scope: (String, String),
    result: Result<Option<(String, TmxExchangePreview)>, CommandError>,
) -> Result<Option<TmxFilePreview>, CommandError> {
    tauri::async_runtime::block_on(app.state::<AppState>().sessions.run(
        "test.tmx.finish",
        CommandStage::ExecutionRead,
        move |sessions| finish_tmx_preview(sessions, request, scope, result),
    ))
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn tmx_selected_file_preview_cancel_and_failure_do_not_write_project_facts() {
    let (app, window, root, project) = project();
    let req = request(&project);
    let scope = scope(&app, req.clone());
    let path = root.path().join("memory.tmx");
    std::fs::write(&path, TMX).unwrap();
    let database = root.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let selected = read_tmx_preview(&path, &scope).unwrap();
    assert_eq!(selected.0, "memory.tmx");
    let view = finish(&app, req.clone(), scope.clone(), Ok(Some(selected)))
        .unwrap()
        .unwrap();
    assert_eq!(view.project_id, req.project_id);
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/resourceCommands.contract.json"
    ))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&view.preview).unwrap(),
        fixture["responses"]["tmxPreview"]["preview"]
    );
    assert_eq!(
        view.preview.rows[0].source_text.as_deref(),
        Some("Hello 👩🏽‍💻 é")
    );
    assert_eq!(
        view.preview.rows[0].target_text.as_deref(),
        Some("你好 👩🏽‍💻 é")
    );
    assert_eq!(
        serde_json::to_value(&view.preview.license).unwrap(),
        "unknown"
    );
    assert!(
        finish(&app, req.clone(), scope.clone(), Ok(None))
            .unwrap()
            .is_none()
    );
    std::fs::write(&path, b"<tmx>").unwrap();
    assert!(
        finish(
            &app,
            req.clone(),
            scope,
            read_tmx_preview(&path, &("en".into(), "zh-CN".into())).map(Some)
        )
        .is_err()
    );
    assert_eq!(std::fs::read(&database).unwrap(), before);
    let context = json!({"sessionToken":req.session_token,"projectId":req.project_id});
    assert_eq!(call(&window,"list_resource_captures",json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"limit":100})).unwrap(),json!([]));
    assert_eq!(call(&window,"read_terms",json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"locale":"zh-CN","afterTermId":null,"limit":100})).unwrap(),json!([]));
}

#[test]
fn tmx_finish_rechecks_original_session_and_project_language_scope() {
    let (app, window, root, project) = project();
    let req = request(&project);
    let initial = scope(&app, req.clone());
    call(
        &window,
        "set_target_locales",
        json!({"sessionToken":req.session_token,
        "expectedRevision":project["metadata"]["metadataRevision"],"targetLocales":["de"]}),
    )
    .unwrap();
    let database = root.path().join("project/project.sqlite3");
    let changed = std::fs::read(&database).unwrap();
    let failure = finish(&app, req.clone(), initial.clone(), Ok(None)).unwrap_err();
    assert_eq!(failure.reason.as_deref(), Some("tmx-project-scope"));
    assert_eq!(std::fs::read(&database).unwrap(), changed);
    call(
        &window,
        "close_project",
        json!({"sessionToken":req.session_token}),
    )
    .unwrap();
    let failure = finish(&app, req, initial, Ok(None)).unwrap_err();
    assert_eq!(failure.code, CommandErrorCode::SessionInvalid);
}

#[test]
fn tmx_ipc_rejects_foreign_scope_and_forged_file_authority_before_picker() {
    let (_app, window, root, project) = project();
    let req = serde_json::to_value(request(&project)).unwrap();
    let database = root.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    for field in ["sessionToken", "projectId"] {
        let mut foreign = req.clone();
        foreign[field] = if field == "sessionToken" {
            json!("foreign-session")
        } else {
            json!(ExecutionId::new())
        };
        assert_eq!(
            call(&window, "preview_tmx_exchange", foreign).unwrap_err()["code"],
            "session-invalid"
        );
    }
    let mut foreign = req.clone();
    foreign["locale"] = json!("zh-cn");
    assert_eq!(
        call(&window, "preview_tmx_exchange", foreign).unwrap_err()["reason"],
        "tmx-project-scope"
    );
    for field in ["path", "approved", "sourceLocale"] {
        let mut forged = req.clone();
        forged[field] = json!("forged");
        assert!(call(&window, "preview_tmx_exchange", forged).is_err());
    }
    assert_eq!(std::fs::read(database).unwrap(), before);
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn tmx_read_uses_exact_extension_size_and_existing_safe_file_boundary() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("memory.tmx");
    std::fs::write(&path, TMX).unwrap();
    assert_eq!(
        source::capture::read_tmx_file(&path).unwrap(),
        TMX.as_bytes()
    );
    assert!(source::capture::read_resource_file(&path).is_err());
    assert!(source::capture::read_tmx_file(std::path::Path::new("memory.tmx")).is_err());
    std::fs::write(&path, vec![b' '; tsumugi_core::MAX_TMX_INPUT_BYTES + 1]).unwrap();
    assert_eq!(
        source::capture::read_tmx_file(&path).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    #[cfg(target_os = "macos")]
    {
        std::fs::remove_file(&path).unwrap();
        let outside = root.path().join("other.tmx");
        std::fs::write(&outside, TMX).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert_eq!(
            source::capture::read_tmx_file(&path).unwrap_err().code,
            ErrorCode::Unauthorized
        );
    }
}

fn tbx_request(project: &Value) -> TbxPreviewRequest {
    serde_json::from_value(serde_json::to_value(request(project)).unwrap()).unwrap()
}
fn tbx_test_scope(
    app: &tauri::App<tauri::test::MockRuntime>,
    request: TbxPreviewRequest,
) -> (String, String) {
    tauri::async_runtime::block_on(app.state::<AppState>().sessions.run(
        "test.tbx.scope",
        CommandStage::ExecutionRead,
        move |sessions| tbx_scope(sessions, &request),
    ))
    .unwrap()
}
fn tbx_test_finish(
    app: &tauri::App<tauri::test::MockRuntime>,
    request: TbxPreviewRequest,
    scope: (String, String),
    result: Result<Option<(String, TbxExchangePreview)>, CommandError>,
) -> Result<Option<TbxFilePreview>, CommandError> {
    tauri::async_runtime::block_on(app.state::<AppState>().sessions.run(
        "test.tbx.finish",
        CommandStage::ExecutionRead,
        move |sessions| finish_tbx_preview(sessions, request, scope, result),
    ))
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn tbx_selected_file_preview_cancel_and_failure_do_not_write_project_facts() {
    let (app, window, root, project) = project();
    let request = tbx_request(&project);
    let scope = tbx_test_scope(&app, request.clone());
    let path = root.path().join("terms.tbx");
    std::fs::write(&path, TBX).unwrap();
    let database = root.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let selected = read_tbx_preview(&path, &scope).unwrap();
    assert_eq!(selected.0, "terms.tbx");
    let view = tbx_test_finish(&app, request.clone(), scope.clone(), Ok(Some(selected)))
        .unwrap()
        .unwrap();
    assert_eq!(view.project_id, request.project_id);
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/resourceCommands.contract.json"
    ))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&view.preview).unwrap(),
        fixture["responses"]["tbxPreview"]["preview"]
    );
    assert_eq!(view.preview.profile, "tbx-basic-dca-subset-preview");
    assert_eq!(
        serde_json::to_value(&view.preview.license).unwrap(),
        "unknown"
    );
    assert_eq!(view.preview.document_locale, "en");
    assert_eq!(view.preview.rows.len(), 1);
    let row = &view.preview.rows[0];
    assert_eq!(row.source_terms[0].text.as_deref(), Some("Hello 👩🏽‍💻 é"));
    assert_eq!(row.target_terms[0].text.as_deref(), Some("你好 👩🏽‍💻 é"));
    assert_eq!(row.source_terms[0].sources, vec!["Synthetic term source"]);
    assert_eq!(row.source_terms[0].usage_statuses, vec!["preferred"]);
    assert!(
        view.preview
            .losses
            .iter()
            .any(|entry| entry.kind == tsumugi_core::TbxLossKind::SchemaHint && entry.count == 2)
    );
    assert!(
        tbx_test_finish(&app, request.clone(), scope.clone(), Ok(None))
            .unwrap()
            .is_none()
    );
    std::fs::write(&path, b"<tbx>").unwrap();
    assert!(
        tbx_test_finish(
            &app,
            request.clone(),
            scope.clone(),
            read_tbx_preview(&path, &scope).map(Some)
        )
        .is_err()
    );
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert_eq!(
        call(
            &window,
            "list_resource_captures",
            json!({"sessionToken":request.session_token,"projectId":request.project_id,"limit":100})
        )
        .unwrap(),
        json!([])
    );
    assert_eq!(call(&window,"read_terms",json!({"sessionToken":request.session_token,"projectId":request.project_id,"locale":"zh-CN","afterTermId":null,"limit":100})).unwrap(),json!([]));
}

#[test]
fn tbx_finish_rechecks_original_session_and_project_language_scope() {
    let (app, window, root, project) = project();
    let request = tbx_request(&project);
    let scope = tbx_test_scope(&app, request.clone());
    call(&window,"set_target_locales",json!({"sessionToken":request.session_token,"expectedRevision":project["metadata"]["metadataRevision"],"targetLocales":["de"]})).unwrap();
    let database = root.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    assert_eq!(
        tbx_test_finish(&app, request.clone(), scope.clone(), Ok(None))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("tbx-project-scope")
    );
    assert_eq!(std::fs::read(&database).unwrap(), before);
    call(
        &window,
        "close_project",
        json!({"sessionToken":request.session_token}),
    )
    .unwrap();
    assert_eq!(
        tbx_test_finish(&app, request, scope, Ok(None))
            .unwrap_err()
            .code,
        CommandErrorCode::SessionInvalid
    );
}

#[test]
fn tbx_ipc_rejects_foreign_scope_and_forged_file_or_schema_authority_before_picker() {
    let (_app, window, root, project) = project();
    let request = serde_json::to_value(tbx_request(&project)).unwrap();
    let database = root.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    for field in ["sessionToken", "projectId"] {
        let mut foreign = request.clone();
        foreign[field] = if field == "sessionToken" {
            json!("foreign-session")
        } else {
            json!(ExecutionId::new())
        };
        assert_eq!(
            call(&window, "preview_tbx_exchange", foreign).unwrap_err()["code"],
            "session-invalid"
        );
    }
    let mut foreign = request.clone();
    foreign["locale"] = json!("zh-cn");
    assert_eq!(
        call(&window, "preview_tbx_exchange", foreign).unwrap_err()["reason"],
        "tbx-project-scope"
    );
    for field in ["path", "approved", "sourceLocale", "schemaHref", "format"] {
        let mut forged = request.clone();
        forged[field] = json!("forged");
        assert!(call(&window, "preview_tbx_exchange", forged).is_err());
    }
    assert_eq!(std::fs::read(database).unwrap(), before);
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn tbx_read_uses_exact_extension_size_and_existing_safe_file_boundary() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("terms.tbx");
    std::fs::write(&path, TBX).unwrap();
    assert_eq!(
        source::capture::read_tbx_file(&path).unwrap(),
        TBX.as_bytes()
    );
    assert!(source::capture::read_tmx_file(&path).is_err());
    assert!(source::capture::read_resource_file(&path).is_err());
    assert!(source::capture::read_tbx_file(std::path::Path::new("terms.tbx")).is_err());
    std::fs::write(&path, vec![b' '; tsumugi_core::MAX_TBX_INPUT_BYTES + 1]).unwrap();
    assert_eq!(
        source::capture::read_tbx_file(&path).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    #[cfg(target_os = "macos")]
    {
        std::fs::remove_file(&path).unwrap();
        let outside = root.path().join("other.tbx");
        std::fs::write(&outside, TBX).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert_eq!(
            source::capture::read_tbx_file(&path).unwrap_err().code,
            ErrorCode::Unauthorized
        );
    }
}
