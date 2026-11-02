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
    store.save_translation_revision(&SaveTranslationRevision { reuse_origin: None,
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

#[test]
fn registered_delivery_record_reads_exact_redacted_history_without_destination_authority() {
    let temp = tempfile::tempdir().unwrap();
    let project_path = temp.path().join("project");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let project = call(&view, "create_project", json!({"destination":project_path,
        "displayName":"Delivery record history","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let session = project["sessionToken"].clone();
    let project_id = project["metadata"]["projectId"].clone();
    let (pending, unknown) = app.state::<AppState>().sessions.with(|sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        let (_, release, _) = seed(&mut active.store);
        let pending = active.store.begin_delivery(ExecutionId::new(), release, "/synthetic/unselected/first", false).unwrap();
        let second = active.store.begin_delivery(ExecutionId::new(), release, "/synthetic/unselected/second", false).unwrap();
        let files = second.files.into_iter().map(|mut file| { file.state = DeliveryFileState::Unknown; file }).collect();
        let unknown = active.store.finish_delivery(second.action_id, files).unwrap();
        (pending, unknown)
    });
    let observer = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
    let data_version = || observer.pragma_query_value::<i64, _>(None, "data_version", |row| row.get(0)).unwrap();
    let before = data_version();
    let request = |delivery: &DeliveryView| json!({"sessionToken":session,"projectId":project_id,
        "releaseId":delivery.release_id,"deliveryId":delivery.delivery_id,"actionId":delivery.action_id});
    let record = |delivery: &DeliveryView| json!({"releaseId":delivery.release_id,"deliveryId":delivery.delivery_id,
        "actionId":delivery.action_id,"state":delivery.state,"files":delivery.files,"createdAt":delivery.created_at});
    // The older pending action must not be replaced by a newer delivery for its release.
    for original in [&pending, &unknown] {
        let result = call(&view, "read_delivery_record", request(original)).unwrap();
        assert_eq!(result, record(original));
        let decoded: DeliveryRecordView = serde_json::from_value(result.clone()).unwrap();
        assert_eq!(decoded.delivery_id, original.delivery_id);
        assert_eq!(result.as_object().unwrap().len(), 6);
        let text = serde_json::to_string(&result).unwrap();
        assert!(!text.contains("directory") && !text.contains("selection") && !text.contains("permit")
            && !text.contains("/synthetic/unselected/"));
    }
    for field in ["releaseId", "deliveryId"] {
        let mut wrong = request(&pending); wrong[field] = json!(ExecutionId::new());
        assert!(call(&view, "read_delivery_record", wrong).is_err(), "{field}");
    }
    let mut wrong_action = request(&pending); wrong_action["actionId"] = json!(unknown.action_id);
    assert!(call(&view, "read_delivery_record", wrong_action).is_err());
    let mut wrong_project = request(&pending); wrong_project["projectId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_delivery_record", wrong_project).is_err());
    let mut stale = request(&pending); stale["sessionToken"] = json!("retired-session");
    assert_eq!(call(&view, "read_delivery_record", stale).unwrap_err()["code"], "session-invalid");
    let mut missing = request(&pending); missing["actionId"] = json!(ExecutionId::new());
    assert_eq!(call(&view, "read_delivery_record", missing).unwrap(), Value::Null);
    let lookup = json!({"sessionToken":session,"projectId":project_id,
        "actionId":pending.action_id,"selectionId":ExecutionId::new()});
    assert_eq!(call(&view, "read_delivery_action", lookup.clone()).unwrap_err()["code"], "session-invalid");
    assert_eq!(data_version(), before);
    let original_pending = pending.clone();
    let original_unknown = unknown.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(active.execution.is_none());
        assert!(!active.store.is_reconciling());
        assert_eq!(active.store.delivery_by_action(original_pending.action_id).unwrap().as_ref(), Some(&original_pending));
        assert_eq!(active.store.delivery_by_action(original_unknown.action_id).unwrap().as_ref(), Some(&original_unknown));
    });
    call(&view, "close_project", json!({"sessionToken":session})).unwrap();
    let reopened = call(&view, "open_project", json!({"locator":project_path})).unwrap();
    for original in [&pending, &unknown] {
        let mut reopened_request = request(original); reopened_request["sessionToken"] = reopened["sessionToken"].clone();
        assert_eq!(call(&view, "read_delivery_record", reopened_request).unwrap(), record(original));
    }
    let mut reopened_lookup = lookup; reopened_lookup["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_delivery_action", reopened_lookup).unwrap_err()["code"], "session-invalid");
    app.state::<AppState>().sessions.with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
}

#[test]
fn registered_export_rechecks_damaged_saved_artifacts_before_any_delivery_effect() {
    for missing in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let project_path = temp.path().join("project");
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
        let project = call(&view, "create_project", json!({"destination":project_path,
            "displayName":"Artifact export boundary","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
        let release = app.state::<AppState>().sessions.with(|sessions| {
            seed(&mut sessions.active.as_mut().unwrap().store).1
        });
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        let sentinel = destination.join("untouched.txt");
        fs::write(&sentinel, b"Keep the original destination").unwrap();
        let authority = Arc::new(source::capture::Selection::authorize(destination.clone()).unwrap());
        let selection = ExecutionId::new();
        app.state::<AppState>().sessions.with(move |sessions| {
            sessions.active.as_mut().unwrap().execution_parts().unwrap().0.release.selection = Some((selection, authority));
        });
        let request = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"],
            "releaseId":release,"selectionId":selection});
        let preview = call(&view, "preview_delivery", request.clone()).unwrap();
        assert_eq!(preview["files"].as_array().unwrap().len(), 1);
        assert_eq!(preview["files"][0]["state"], "absent");
        let observer = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
        let changed = if missing {
            observer.execute("DELETE FROM release_artifacts WHERE release_id=?1", [release.to_string()]).unwrap()
        } else {
            observer.execute("UPDATE release_artifacts SET bytes=?2 WHERE release_id=?1",
                rusqlite::params![release.to_string(), b"Damaged after preview".as_slice()]).unwrap()
        };
        assert_eq!(changed, 1, "the saved artifact must actually be damaged");
        let version = observer.pragma_query_value::<i64, _>(None, "data_version", |row| row.get(0)).unwrap();
        let action = ExecutionId::new();
        let mut export = request.clone();
        export["actionId"] = json!(action);
        export["previewId"] = preview["previewId"].clone();
        export["overwriteConflicts"] = json!(false);
        let error = call(&view, "export_release", export).unwrap_err();
        assert_eq!(error["code"], "corrupt-project");
        assert_eq!(error["stage"], "execution-adopt");
        assert_eq!(error["reason"], "release-artifacts");
        assert_eq!(error["recoveryRequired"], false);
        assert_eq!(call(&view, "read_delivery_action", json!({"sessionToken":project["sessionToken"],
            "projectId":project["metadata"]["projectId"],"actionId":action,"selectionId":selection})).unwrap(), Value::Null);
        assert_eq!(observer.query_row("SELECT COUNT(*) FROM release_deliveries", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(observer.pragma_query_value::<i64, _>(None, "data_version", |row| row.get(0)).unwrap(), version,
            "rejection cannot create a delivery, repair the artifact or start another build");
        assert_eq!(fs::read(&sentinel).unwrap(), b"Keep the original destination");
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 1);
        assert!(!destination.join("i18n").exists());
        app.state::<AppState>().sessions.with(|sessions| {
            let active = sessions.active.as_ref().unwrap();
            assert!(!active.store.is_reconciling());
            assert!(active.execution.as_ref().unwrap().release.delivery.is_none());
        });
    }
}

#[test]
fn reconcile_dropped_caller_recovers_through_registered_reads_without_rewriting_files() {
    use std::{future::Future, task::{Context, Poll, Waker}};
    let temp = tempfile::tempdir().unwrap();
    let project_path = temp.path().join("project");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let project = call(&view, "create_project", json!({"destination":project_path,
        "displayName":"Reconcile continuation","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let destination = temp.path().join("destination");
    fs::create_dir(&destination).unwrap();
    let authority = Arc::new(source::capture::Selection::authorize(destination.clone()).unwrap());
    let root = authority.destination_root().unwrap().to_string_lossy().into_owned();
    let selection = ExecutionId::new();
    let action = ExecutionId::new();
    let (pending, artifact, bytes) = app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let (_, release, _) = seed(&mut active.store);
        let (artifact, bytes) = active.store.release_artifact(release, "zh-CN").unwrap();
        let pending = active.store.begin_delivery(action, release, &root, false).unwrap();
        active.execution_parts().unwrap().0.release.selection = Some((selection, authority));
        (pending, artifact, bytes)
    });
    // Model an external write whose completion was not recorded in the pending action.
    let target = destination.join(&artifact.file_name);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, &bytes).unwrap();
    let modified = fs::metadata(&target).unwrap().modified().unwrap();
    let request = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"],
        "actionId":action,"selectionId":selection});
    let observer = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
    let counts = || observer.query_row("SELECT (SELECT COUNT(*) FROM release_records),
        (SELECT COUNT(*) FROM release_deliveries),(SELECT COUNT(*) FROM execution_attempts)", [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))).unwrap();
    let original_counts = counts();
    assert_eq!(original_counts.1, 1);
    // Pause the owner before polling the real Host future directly. Its queued
    // submission is accepted, but capture and file observation cannot start yet.
    // Only the subsequent reads and terminal reconcile use registered IPC.
    let held = app.state::<AppState>().sessions.pause();
    let mut waiting = Box::pin(reconcile_delivery(app.state(), serde_json::from_value(request.clone()).unwrap()));
    assert!(matches!(waiting.as_mut().poll(&mut Context::from_waker(Waker::noop())), Poll::Pending));
    drop(waiting);
    drop(held);
    let deadline = Instant::now() + Duration::from_secs(10);
    let completed = loop {
        let value = call(&view, "read_delivery_action", request.clone()).unwrap();
        if value["state"] == "succeeded" { break value; }
        assert_eq!(value["state"], "pending");
        assert!(Instant::now() < deadline, "accepted reconciliation lost its continuation: {value}");
        std::thread::sleep(Duration::from_millis(5));
    };
    let mut expected = pending;
    expected.state = DeliveryState::Succeeded;
    for file in &mut expected.files {
        file.state = DeliveryFileState::Succeeded;
        file.actual_sha256 = Some(file.expected_sha256.clone());
    }
    assert_eq!(completed, serde_json::to_value(&expected).unwrap());
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), modified);
    assert_eq!(counts(), original_counts, "recovery cannot create another delivery, release or build");
    let version = observer.pragma_query_value::<i64, _>(None, "data_version", |row| row.get(0)).unwrap();
    assert_eq!(call(&view, "reconcile_delivery", request.clone()).unwrap(), completed);
    assert_eq!(call(&view, "read_delivery_action", request).unwrap(), completed);
    assert_eq!(observer.pragma_query_value::<i64, _>(None, "data_version", |row| row.get(0)).unwrap(), version,
        "a terminal reconciliation returns its original receipt without another mutation");
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), modified);
    let history = call(&view, "list_deliveries", json!({"sessionToken":project["sessionToken"],
        "projectId":project["metadata"]["projectId"],"releaseId":expected.release_id})).unwrap();
    assert_eq!(history, json!([completed]));
    app.state::<AppState>().sessions.with(|sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(!active.store.is_reconciling());
        assert!(active.execution.as_ref().unwrap().release.delivery.is_none());
    });
}

#[test]
#[ignore = "invoked by the delivery ACK-loss parent in a separate process"]
fn delivery_reply_interruption_child() {
    use tauri::ipc::InvokeResponse;
    let root = std::path::PathBuf::from(std::env::var_os("TSUMUGI_DELIVERY_REPLY_TEST_ROOT").unwrap());
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let project = call(&view, "create_project", json!({"destination":root.join("project"),
        "displayName":"Interrupted delivery reply","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let destination = root.join("destination");
    fs::create_dir(&destination).unwrap();
    let selection = ExecutionId::new();
    let release = app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let release = seed(&mut active.store).1;
        active.execution_parts().unwrap().0.release.selection = Some((selection,
            Arc::new(source::capture::Selection::authorize(destination).unwrap())));
        release
    });
    let scope = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"],
        "releaseId":release,"selectionId":selection});
    let preview = call(&view, "preview_delivery", scope.clone()).unwrap();
    let mut request = scope;
    request["actionId"] = json!(ExecutionId::new());
    request["previewId"] = preview["previewId"].clone();
    request["overwriteConflicts"] = json!(false);
    fs::write(root.join("original-request.json"), serde_json::to_vec(&request).unwrap()).unwrap();
    // Interrupt the actual registered command's responder after its durable
    // result, before a waiting IPC caller could receive an acknowledgement.
    // The mock transport is not a native WebView transport test.
    view.as_ref().clone().on_message(InvokeRequest {
        cmd: "export_release".into(), callback: CallbackFn(0), error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(), body: InvokeBody::Json(json!({"request":request})),
        headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
    }, Box::new(move |_, _, response, _, _| {
        let InvokeResponse::Ok(body) = response else { panic!("export did not reach a successful reply"); };
        let receipt: Value = body.deserialize().unwrap();
        assert_eq!(receipt["state"], "succeeded");
        fs::write(root.join("intercepted-reply.json"), serde_json::to_vec(&receipt).unwrap()).unwrap();
        std::process::exit(91);
    }));
    std::thread::park_timeout(Duration::from_secs(20));
    panic!("registered export responder did not reach the interruption point");
}

#[test]
fn process_exit_before_delivery_ack_reopens_the_original_receipt_without_reexporting() {
    use std::process::{Command, Stdio};
    let temporary = tempfile::tempdir().unwrap();
    // Rust test names omit the crate prefix present in module_path!().
    let module = module_path!().split_once("::").unwrap().1;
    let helper = format!("{module}::delivery_reply_interruption_child");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &helper,
            "--ignored", "--test-threads=1", "--nocapture"])
        .env("TSUMUGI_DELIVERY_REPLY_TEST_ROOT", temporary.path())
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if child.try_wait().unwrap().is_some() { break; }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!("delivery child timed out: {}", String::from_utf8_lossy(&output.stderr));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(91), "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    eprintln!("delivery responder child exited 91 before acknowledgement; reopening the persisted action");
    let original: Value = serde_json::from_slice(&fs::read(temporary.path().join("original-request.json")).unwrap()).unwrap();
    let expected: Value = serde_json::from_slice(&fs::read(temporary.path().join("intercepted-reply.json")).unwrap()).unwrap();
    let target = temporary.path().join("destination/i18n/zh.json");
    let bytes = fs::read(&target).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), json!({"hello":"你好"}));
    let modified = fs::metadata(&target).unwrap().modified().unwrap();
    let project_path = temporary.path().join("project");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let project = call(&view, "open_project", json!({"locator":project_path})).unwrap();
    let observer = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
    let version = || observer.pragma_query_value::<i64, _>(None, "data_version", |row| row.get(0)).unwrap();
    let counts = || observer.query_row("SELECT (SELECT COUNT(*) FROM release_records),
        (SELECT COUNT(*) FROM release_deliveries),(SELECT COUNT(*) FROM execution_attempts)", [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))).unwrap();
    let before = (version(), counts());
    let record_request = json!({"sessionToken":project["sessionToken"],"projectId":original["projectId"],
        "releaseId":original["releaseId"],"deliveryId":expected["deliveryId"],"actionId":original["actionId"]});
    let record = call(&view, "read_delivery_record", record_request.clone()).unwrap();
    assert_eq!(record["deliveryId"], expected["deliveryId"]);
    assert_eq!(record["state"], "succeeded");
    assert_eq!(record["files"], expected["files"]);
    assert_eq!(call(&view, "read_delivery_record", record_request).unwrap(), record);
    app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.as_ref().unwrap().execution.is_none());
    });
    assert_eq!((version(), counts()), before, "history reads must not create a runtime or mutate the project");
    let destination = temporary.path().join("destination");
    let selection = ExecutionId::new();
    app.state::<AppState>().sessions.with(move |sessions| {
        sessions.active.as_mut().unwrap().execution_parts().unwrap().0.release.selection = Some((selection,
            Arc::new(source::capture::Selection::authorize(destination).unwrap())));
    });
    let lookup = json!({"sessionToken":project["sessionToken"],"projectId":original["projectId"],
        "actionId":original["actionId"],"selectionId":selection});
    assert_eq!(call(&view, "read_delivery_action", lookup.clone()).unwrap(), expected);
    assert_eq!(call(&view, "reconcile_delivery", lookup).unwrap(), expected);
    assert_eq!((version(), counts()), before, "terminal reconciliation cannot make another release, delivery or attempt");
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), modified);
}
