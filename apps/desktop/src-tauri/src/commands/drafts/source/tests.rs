use super::*;
use super::super::tests::{call, source_fixture};
use serde_json::{json, Value};
use tauri::Manager;
use tsumugi_core::execution::Revision;

fn revision(value: u64) -> Revision { Revision::new(value).unwrap() }

fn source_value(pending: SourceDraftPending) -> SourceDraftValue {
    SourceDraftValue {
        edit_seq: revision(2), mapping_seq: revision(2), domain: "Newer mapping B".into(),
        source: None, source_language: "en-US".into(), declared: true,
        selection_label: Some("Newer selection B".into()), updating: false,
        attempt_id: None, check_attempt_id: None, capture_request: None, check_prepare_request: None,
        comparison_ref: None, lineage: vec![], actor: "Synthetic editor".into(), filter: String::new(),
        applied_filter: String::new(), manual_ordinal: None, historical_query: String::new(),
        preview_after: 0, comparison_after: 0, historical_search: None, receipt_ref: None,
        picker_uncertain: false, hook: SourceDraftHook { locale: "zh-CN".into(), enabled_intent: false, source_action_id: None },
        pending: Some(pending), hook_stop: None,
    }
}

#[test]
fn registered_source_recovery_observes_expired_capture_and_preserves_newer_input() {
    let (directory, core, _) = source_fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    core.close().unwrap();
    let application = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.state::<AppState>().local_drafts.set(DraftStore::at(application.path().join("drafts")).unwrap()).ok().unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let path = directory.path().join("project");
    let opened = call(&window, "open_project", json!({"locator": path})).unwrap();
    let token = opened["sessionToken"].clone();
    let key = SourceDraftKey { project_id: project };
    let capture = SourceDraftCaptureRequest { project_id: project, selection_id: ExecutionId::new(),
        source_language: "en-US".into(), attempt_id: ExecutionId::new() };
    let pending = SourceDraftPending::Capture { request: capture.clone(), submitted_seq: revision(1), submitted_mapping_seq: revision(1) };
    let target = SourceDraftResolveTarget::Primary { pending: pending.clone() };
    let reference = SourceDraftPreparationRef::Capture { request: capture };
    let read = json!({"sessionToken": token, "key": key});
    let observe = json!({"sessionToken": token, "key": key, "target": target});
    let preparation = json!({"sessionToken": token, "key": key, "reference": reference});
    let before = app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().store.changes_since(revision(0)));
    assert!(app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().execution.is_none()));
    assert_eq!(call(&window, "read_local_source_draft", read.clone()).unwrap()["revision"], "0");
    assert!(!application.path().join("drafts").exists());
    let observed = call(&window, "observe_local_source_action", observe.clone()).unwrap();
    assert_eq!(observed["target"], serde_json::to_value(&target).unwrap());
    assert_eq!(observed["observation"], json!({"kind": "preparation-expired"}));
    let prepared = call(&window, "read_local_source_preparation", preparation.clone()).unwrap();
    assert_eq!(prepared["reference"], serde_json::to_value(&reference).unwrap());
    assert_eq!(prepared["observation"], json!({"kind": "preparation-expired"}));
    assert!(!application.path().join("drafts").exists());
    for (command, original) in [("observe_local_source_action", &observe), ("read_local_source_preparation", &preparation)] {
        let mut wrong = original.clone(); wrong["sessionToken"] = json!("retired-session");
        assert!(call(&window, command, wrong).is_err());
        let mut wrong = original.clone(); wrong["key"]["projectId"] = json!(ExecutionId::new());
        assert!(call(&window, command, wrong).is_err());
        let mut wrong = original.clone();
        if command == "observe_local_source_action" { wrong["target"]["pending"]["request"]["projectId"] = json!(ExecutionId::new()); }
        else { wrong["reference"]["request"]["projectId"] = json!(ExecutionId::new()); }
        assert!(call(&window, command, wrong).is_err());
    }
    let writer = ExecutionId::new();
    let value = source_value(pending);
    let write = SourceDraftWrite { key: key.clone(), expected_revision: revision(0), writer_id: writer, value: value.clone() };
    let written = call(&window, "write_local_source_draft", json!({"sessionToken": token, "write": write})).unwrap();
    assert_eq!(call(&window, "read_local_source_draft", read.clone()).unwrap(), written);
    assert!(call(&window, "clear_local_source_draft", json!({"sessionToken": token, "clear": {"key": key, "expectedRevision": written["revision"]}})).is_err());
    let mut next = value.clone(); next.edit_seq = revision(3); next.pending = None;
    let mut clearing = write.clone(); clearing.expected_revision = serde_json::from_value(written["revision"].clone()).unwrap(); clearing.value = next;
    assert!(call(&window, "write_local_source_draft", json!({"sessionToken": token, "write": clearing})).is_err());
    let mut resolve = SourceDraftResolve { write: clearing, target: target.clone(), disposition: SourceDraftDisposition::Recorded };
    let error = call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve": resolve})).unwrap_err();
    assert_eq!(error["code"], "result-mismatch");
    assert_eq!(call(&window, "read_local_source_draft", read.clone()).unwrap(), written);
    resolve.disposition = SourceDraftDisposition::PreparationExpired;
    let mut stale = resolve.clone(); stale.write.expected_revision = revision(0);
    assert!(call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve": stale})).is_err());
    let mut wrong_target = resolve.clone();
    if let SourceDraftResolveTarget::Primary { pending: SourceDraftPending::Capture { request, .. } } = &mut wrong_target.target {
        request.attempt_id = ExecutionId::new();
    }
    assert!(call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve": wrong_target})).is_err());
    assert_eq!(call(&window, "read_local_source_draft", read.clone()).unwrap(), written);
    let resolved = call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve": resolve})).unwrap();
    assert_eq!(resolved["value"]["domain"], "Newer mapping B");
    assert_eq!(resolved["value"]["selectionLabel"], "Newer selection B");
    assert_eq!(resolved["value"]["mappingSeq"], "2");
    assert_eq!(resolved["value"]["pending"], Value::Null);
    assert!(app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().execution.is_none()));
    let after = app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().store.changes_since(revision(0)));
    assert_eq!(serde_json::to_value(before).unwrap(), serde_json::to_value(after).unwrap());
    call(&window, "close_project", json!({"sessionToken": token, "projectId": project})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator": path})).unwrap();
    assert!(call(&window, "read_local_source_draft", read).is_err());
    assert_eq!(call(&window, "read_local_source_draft", json!({"sessionToken": reopened["sessionToken"], "key": key})).unwrap(), resolved);
    assert!(app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().execution.is_none()));
}

#[test]
fn registered_source_start_cancellation_checks_the_saved_target_before_closing_original_admission() {
    let (directory, core, _) = source_fixture::source_fixture();
    let input = source_fixture::source_input(&core);
    let generation = tsumugi_core::execution::ExecutionRuntime::new(&core).unwrap().generation();
    let project = input.envelope().project_id;
    let start = SourceDraftStartRequest { project_id: project, attempt_id: input.envelope().attempt_id,
        input_digest: input.digest().into(), grant_id: ExecutionId::new(), expires_at_ms: 123_u64.into(), unsandboxed_execution: true,
        start_metadata: tsumugi_core::content::SourcePluginStartMetadata { task_id: input.envelope().task_id, generation } };
    core.close().unwrap();
    let application = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.state::<AppState>().local_drafts.set(DraftStore::at(application.path().join("drafts")).unwrap()).ok().unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let path = directory.path().join("project");
    let opened = call(&window, "open_project", json!({"locator": path})).unwrap();
    let token = opened["sessionToken"].clone();
    let pending = SourceDraftPending::Start { request: start, submitted_seq: revision(1), submitted_mapping_seq: revision(1) };
    let target = SourceDraftResolveTarget::Primary { pending: pending.clone() };
    let key = SourceDraftKey { project_id: project };
    let observe = json!({"sessionToken": token, "key": key, "target": target});
    assert_eq!(call(&window, "observe_local_source_action", observe.clone()).unwrap()["observation"], json!({"kind":"pending"}));
    let value = source_value(pending);
    let written = call(&window, "write_local_source_draft", json!({"sessionToken": token, "write": {
        "key": key, "expectedRevision":"0", "writerId":ExecutionId::new(), "value":value }})).unwrap();
    let mut after = value.clone(); after.edit_seq = revision(3); after.pending = None;
    let resolve = SourceDraftResolve { write: SourceDraftWrite { key: key.clone(),
        expected_revision: serde_json::from_value(written["revision"].clone()).unwrap(), writer_id: ExecutionId::new(), value: after },
        target, disposition: SourceDraftDisposition::ConfirmedNotApplied };
    let mut stale = resolve.clone(); stale.write.expected_revision = revision(0);
    assert!(call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve":stale})).is_err());
    let mut changed = resolve.clone(); changed.write.value.actor = "Would overwrite newer B".into();
    assert!(call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve":changed})).is_err());
    let mut unrelated = resolve.clone();
    if let SourceDraftResolveTarget::Primary { pending: SourceDraftPending::Start { request, .. } } = &mut unrelated.target {
        request.start_metadata.task_id = ExecutionId::new();
    }
    assert!(call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve":unrelated})).is_err());
    assert_eq!(call(&window, "observe_local_source_action", observe.clone()).unwrap()["observation"], json!({"kind":"pending"}));
    let settled = call(&window, "resolve_local_source_draft", json!({"sessionToken": token, "resolve":resolve})).unwrap();
    assert_eq!(settled["value"]["pending"], Value::Null);
    assert_eq!(settled["value"]["actor"], value.actor);
    assert_eq!(settled["value"]["selectionLabel"], json!(value.selection_label));
    assert_eq!(call(&window, "observe_local_source_action", observe.clone()).unwrap()["observation"], json!({"kind":"confirmed-not-applied"}));
    assert!(app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().execution.is_none()));
    call(&window, "close_project", json!({"sessionToken":token,"projectId":project})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator":path})).unwrap();
    let mut observe_after_reopen = observe; observe_after_reopen["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&window, "observe_local_source_action", observe_after_reopen).unwrap()["observation"], json!({"kind":"confirmed-not-applied"}));
    assert_eq!(call(&window, "read_local_source_draft", json!({"sessionToken":reopened["sessionToken"],"key":key})).unwrap(), settled);
}

#[test]
fn registered_source_finish_recovers_persisted_outputs_without_initializing_an_execution_host() {
    for cancelled in [false, true] {
    let (directory, mut core, _) = source_fixture::source_fixture();
    let input = source_fixture::source_input(&core);
    let project = input.envelope().project_id;
    let mut runtime = source_fixture::source_runtime(&core);
    let (_, result) = source_fixture::execute(&mut runtime, &mut core, &input);
    let capture = core.capture_source_validation(input.envelope().attempt_id, result.envelope().result_id).unwrap();
    let check_input = capture.check_input().clone();
    let (_, checked) = source_fixture::execute(&mut runtime, &mut core, &check_input);
    let request = SourceDraftCheckFinishRequest { project_id: project, attempt_id: check_input.envelope().attempt_id,
        result_id: checked.envelope().result_id };
    assert_eq!(core.source_check_finish_request_observation(project, request.attempt_id, request.result_id).unwrap(), None);
    if cancelled { core.cancel_execution(check_input.envelope().task_id, ExecutionId::new()).unwrap(); }
    drop(runtime); core.close().unwrap();
    let application = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.state::<AppState>().local_drafts.set(DraftStore::at(application.path().join("drafts")).unwrap()).ok().unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let path = directory.path().join("project");
    let opened = call(&window, "open_project", json!({"locator":path})).unwrap();
    let token = opened["sessionToken"].clone();
    let pending = SourceDraftPending::FinishCheck { request: request.clone(), submitted_seq: revision(1), submitted_mapping_seq: revision(1) };
    let key = SourceDraftKey { project_id: project };
    let target = SourceDraftResolveTarget::Primary { pending: pending.clone() };
    let observe = json!({"sessionToken":token,"key":key,"target":target});
    assert_eq!(call(&window, "observe_local_source_action", observe.clone()).unwrap()["observation"],
        json!({"kind":if cancelled { "confirmed-not-applied" } else { "pending" }}));
    let value = source_value(pending);
    let written = call(&window, "write_local_source_draft", json!({"sessionToken":token,"write":{
        "key":key,"expectedRevision":"0","writerId":ExecutionId::new(),"value":value}})).unwrap();
    let finish = call(&window, "finish_source_check", json!({"sessionToken":token,"projectId":project,"attemptId":request.attempt_id,"resultId":request.result_id}));
    if cancelled { assert!(finish.is_err()); } else { finish.unwrap(); }
    assert!(app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().execution.is_none()));
    assert_eq!(call(&window, "observe_local_source_action", observe).unwrap()["observation"],
        if cancelled { json!({"kind":"confirmed-not-applied"}) } else { json!({"kind":"check-finished","valid":true}) });
    let mut after = value.clone(); after.edit_seq = revision(3); after.pending = None;
    let resolve = SourceDraftResolve { write: SourceDraftWrite { key: key.clone(), expected_revision: serde_json::from_value(written["revision"].clone()).unwrap(),
        writer_id: ExecutionId::new(), value: after }, target,
        disposition: if cancelled { SourceDraftDisposition::ConfirmedNotApplied } else { SourceDraftDisposition::Recorded } };
    let settled = call(&window, "resolve_local_source_draft", json!({"sessionToken":token,"resolve":resolve})).unwrap();
    assert_eq!(settled["value"]["pending"], Value::Null); assert_eq!(settled["value"]["actor"], value.actor);
    assert!(app.state::<AppState>().sessions.with(|s| s.active.as_ref().unwrap().execution.is_none()));
    }
}
