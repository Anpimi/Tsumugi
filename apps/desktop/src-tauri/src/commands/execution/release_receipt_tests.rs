//! Release recovery through actual command registration and synthetic local data.
use super::*;
use serde_json::{Value, json};
use tauri::{Manager, ipc::{CallbackFn, InvokeBody}, webview::InvokeRequest};
use std::time::{Duration, Instant};

fn call(view: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(view, InvokeRequest {
        cmd: command.into(), callback: CallbackFn(0), error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(), body: InvokeBody::Json(json!({"request":request})),
        headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
    }).map(|value| value.deserialize().unwrap())
}
fn run(store: &mut ProjectStore, runtime: &mut ExecutionRuntime, input: &FixedInput) -> ExecutionId {
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(store).unwrap();
        if let Some(result) = store.execution_current_result(input.envelope().attempt_id, input.envelope().items[0].item_id).unwrap() {
            if !runtime.has_active_work(store).unwrap() { return result; }
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn seed(store: &mut ProjectStore) -> (Value, ExecutionId, Value) {
    use tsumugi_core::{content::*, *};
    let metadata = store.metadata().unwrap();
    let project = ExecutionId::parse(&metadata.project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.register_read_only(Arc::new(BuildRunner)).unwrap();
    let input = SourceBundle::capture(
        br#"{"UniqueID":"Release.Receipt","Name":"Receipt","Version":"1.0.0","EntryDll":"Receipt.dll"}"#,
        br#"{"hello":"Hello"}"#, "en",
    ).unwrap().fixed_input(metadata.project_id()).unwrap();
    let result = run(store, &mut runtime, &input);
    let preview = store.source_preview(input.envelope().attempt_id, result, 0, 10).unwrap();
    let action = store.prepare_adoption_with_id(ExecutionId::new(), input.envelope().attempt_id,
        input.envelope().units[0].unit_id, vec![result], serde_json::to_value(preview.confirmation).unwrap()).unwrap();
    store.adopt_execution(&action, &SourceAdoptionHandler).unwrap();
    let unit = store.review_page(project, "zh-CN", 0, 10).unwrap().rows.remove(0).unit_id;
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store.save_translation_revision(&SaveTranslationRevision {
        project_id: project, action_id: ExecutionId::new(), unit_id: unit, locale: "zh-CN".into(),
        source_revision_id: target.source_revision_id, expected_selection_id: None, text: "你好".into(),
    }).unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store.run_review_checks(project, unit, "zh-CN", &target.basis, ExecutionId::new()).unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store.write_review(&ReviewWrite { project_id: project, action_id: ExecutionId::new(), unit_id: unit,
        locale: "zh-CN".into(), expected_basis: target.basis, expected_decision_id: None,
        actor: "Synthetic reviewer".into(), kind: ReviewDecisionKind::Approve, reason: String::new(),
    }).unwrap();
    let basis = store.review_eligibility(project, &["zh-CN".into()]).unwrap().basis;
    let attempt = ExecutionId::new();
    let choices = vec![BuildLocaleChoice { locale: "zh-CN".into(), file_name: "i18n/zh.json".into() }];
    let input = store.prepare_locale_build(project, attempt, &choices, &basis).unwrap();
    let result = run(store, &mut runtime, &input);
    store.validate_execution_result(attempt, result).unwrap();
    let action = store.prepare_adoption_with_id(ExecutionId::new(), attempt, input.envelope().units[0].unit_id, vec![result], Value::Null).unwrap();
    let adoption = store.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap();
    let release = ExecutionId::parse(&adoption.changes[0].id).unwrap();
    let receipt = store.locale_build_start_receipt(project, attempt, &choices, &basis).unwrap().unwrap();
    (json!({"projectId":project,"attemptId":attempt,"choices":choices,"expectedEligibilityBasis":basis}), release, serde_json::to_value(receipt).unwrap())
}

#[test]
fn registered_release_receipts_preserve_history_authorization_and_runtime_independence() {
    let temp = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let project = call(&view, "create_project", json!({"destination":temp.path().join("project"),"displayName":"Release receipts","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let session = project["sessionToken"].clone();
    let project_id = project["metadata"]["projectId"].clone();
    let (mut build, release, receipt) = app.state::<AppState>().sessions.with(|sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        seed(&mut active.store)
    });
    build["sessionToken"] = session.clone();
    assert_eq!(call(&view, "read_locale_build_attempt", build.clone()).unwrap(), receipt);
    let mut absent = build.clone(); absent["attemptId"] = json!(ExecutionId::new());
    assert_eq!(call(&view, "read_locale_build_attempt", absent).unwrap(), Value::Null);
    let mut wrong = build.clone(); wrong["choices"][0]["fileName"] = json!("i18n/other.json");
    assert!(call(&view, "read_locale_build_attempt", wrong).is_err());
    let mut wrong = build.clone(); wrong["projectId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_locale_build_attempt", wrong).is_err());
    let mut wrong = build.clone(); wrong["sessionToken"] = json!("retired-session");
    assert_eq!(call(&view, "read_locale_build_attempt", wrong).unwrap_err()["code"], "session-invalid");
    let action = ExecutionId::new(); let selection = ExecutionId::new();
    let lookup = json!({"sessionToken":session,"projectId":project_id,"actionId":action,"selectionId":selection});
    assert_eq!(call(&view, "read_delivery_action", lookup.clone()).unwrap_err()["code"], "session-invalid");
    let export = temp.path().join("export"); fs::create_dir(&export).unwrap();
    let sentinel = export.join("untouched.txt"); fs::write(&sentinel, b"unchanged").unwrap();
    let directory = export.clone();
    let expected = app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        let revision = active.store.metadata().unwrap().metadata_revision();
        active.store.set_target_locales(revision, &["fr-FR".into()]).unwrap();
        let (host, store) = active.execution_parts().unwrap();
        let authority = source::capture::Selection::authorize(directory).unwrap();
        // Persist the same descriptor-resolved root as the production export boundary.
        let root = authority.destination_root().unwrap().to_string_lossy().into_owned();
        host.release.selection = Some((selection, Arc::new(authority)));
        host.quiescing = true;
        serde_json::to_value(store.begin_delivery(action, release, &root, false).unwrap()).unwrap()
    });
    assert_eq!(call(&view, "read_locale_build_attempt", build.clone()).unwrap(), receipt);
    assert_eq!(call(&view, "read_delivery_action", lookup.clone()).unwrap(), expected);
    let mut missing = lookup.clone(); missing["actionId"] = json!(ExecutionId::new());
    assert_eq!(call(&view, "read_delivery_action", missing).unwrap(), Value::Null);
    let mut wrong = lookup.clone(); wrong["selectionId"] = json!(ExecutionId::new());
    assert_eq!(call(&view, "read_delivery_action", wrong).unwrap_err()["code"], "session-invalid");
    let mut wrong = lookup.clone(); wrong["sessionToken"] = json!("retired-session");
    assert_eq!(call(&view, "read_delivery_action", wrong).unwrap_err()["code"], "session-invalid");
    let other = temp.path().join("other"); fs::create_dir(&other).unwrap();
    app.state::<AppState>().sessions.with(move |sessions| {
        let host = sessions.active.as_mut().unwrap().execution.as_mut().unwrap();
        assert!(host.quiescing);
        host.release.selection = Some((selection, Arc::new(source::capture::Selection::authorize(other).unwrap())));
    });
    assert_eq!(call(&view, "read_delivery_action", lookup.clone()).unwrap_err()["code"], "permission-denied");
    assert_eq!(fs::read(&sentinel).unwrap(), b"unchanged");
    assert_eq!(fs::read_dir(&export).unwrap().count(), 1);
    assert_eq!(call(&view, "close_project", json!({"sessionToken":session})).unwrap_err()["code"], "busy");
    // End this synthetic quiescing projection before exercising the normal close/reopen path.
    app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_mut().unwrap().execution.as_mut().unwrap().quiescing = false;
    });
    call(&view, "close_project", json!({"sessionToken":session})).unwrap();
    let reopened = call(&view, "open_project", json!({"locator":temp.path().join("project")})).unwrap();
    let mut new_build = build; new_build["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_locale_build_attempt", new_build).unwrap(), receipt);
    let mut new_lookup = lookup; new_lookup["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_delivery_action", new_lookup).unwrap_err()["code"], "session-invalid");
    app.state::<AppState>().sessions.with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
}
