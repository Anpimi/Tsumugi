//! Registered IPC coverage uses only synthetic Core data and MockRuntime.
use super::*;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::{
    content::{SourceAdoptionHandler, SourceBundle, SourceRunner},
    execution::{ExecutionRuntime, ExecutionState},
    *,
};

fn call(
    view: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        view,
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
    .map(|value| value.deserialize().unwrap())
}
fn seed(store: &mut ProjectStore) -> Vec<(&'static str, &'static str, Value, Value)> {
    let metadata_project = store.metadata().unwrap().project_id();
    let project = ExecutionId::parse(&metadata_project.to_string()).unwrap();
    let input=SourceBundle::capture(br#"{"UniqueID":"Receipt.Test","Name":"Receipt","Version":"1.0.0","EntryDll":"Receipt.dll"}"#,
        br#"{"hello":"Hello {{name}}","plain":"Plain"}"#,"en").unwrap().fixed_input(metadata_project).unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = loop {
        runtime.tick(store).unwrap();
        if store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap()
            .items[0]
            .execution
            == ExecutionState::Succeeded
        {
            break store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    };
    let preview = store
        .source_preview(input.envelope().attempt_id, result, 0, 50)
        .unwrap();
    let adoption = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&adoption, &SourceAdoptionHandler)
        .unwrap();
    let targets = store.review_page(project, "zh-CN", 0, 10).unwrap().rows;
    let target = targets.iter().find(|t| t.native_key == "hello").unwrap();
    let unit = target.unit_id;
    let source = target.source_revision_id;
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: source,
            expected_selection_id: None,
            text: "你好 {{name}}".into(),
        })
        .unwrap();
    let term = SaveTerm {
        project_id: project,
        action_id: ExecutionId::new(),
        term_id: None,
        locale: "zh-CN".into(),
        source: "Hello".into(),
        aliases: vec![],
        target: "欢迎".into(),
        protected: true,
        scope_unit_id: Some(unit),
        expected_revision_id: None,
        reason: "Fixture".into(),
    };
    let term_result = store.save_term(&term).unwrap();
    let context = SaveContext {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        source_revision_id: source,
        expected_revision_id: None,
        text: "Fixture context".into(),
        reason: "Fixture".into(),
    };
    let context_result = store.save_context(&context).unwrap();
    let capture = CaptureContext {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        source_revision_id: source,
        budget_bytes: 16384,
    };
    let capture_result = store.capture_context(&capture).unwrap();
    let glossary=store.capture_glossary(project,ExecutionId::new(),br#"{"format":"tsumugi-glossary-v1","resourceId":"receipt","revision":"1","license":"MIT","sourceLocale":"en","targetLocale":"zh-CN","entries":[{"id":"other","source":"Other","aliases":[],"target":"Other translation","protected":false,"nativeKey":null,"reason":"Fixture"}]}"#).unwrap();
    let old_capture = glossary.clone();
    assert!(matches!(&old_capture.origin,
        tsumugi_core::GlossaryCaptureOrigin::File { resource_id, revision, license }
        if resource_id == "receipt" && revision == "1" && license == "MIT"));
    let old_preview = store.glossary_preview(project, glossary.capture_id).unwrap();
    assert_eq!(old_preview.capture, old_capture);
    let file = ResourceDecision {
        project_id: project,
        action_id: ExecutionId::new(),
        capture_id: glossary.capture_id,
        entry_id: "other".into(),
        expected_revision_id: None,
        decision: ResourceDecisionKind::Adopt,
    };
    let file_result = store.decide_glossary_entry(&file).unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let qa = ReviewCheckActionRequest {
        advisory_checks: Vec::new(),
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        expected_basis: target.basis.clone(),
    };
    let qa_result = store
        .run_review_checks(project, unit, "zh-CN", &target.basis, qa.action_id)
        .unwrap();
    let decision = ReviewWrite {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        expected_basis: target.basis.clone(),
        expected_decision_id: None,
        actor: "Fixture reviewer".into(),
        kind: ReviewDecisionKind::Approve,
        reason: "Fixture reason".into(),
    };
    let decision_result = store.write_review(&decision).unwrap();
    let issue = qa_result
        .rules
        .iter()
        .flat_map(|rule| &rule.findings)
        .find(|finding| finding.waivable)
        .unwrap();
    let waiver = WaiverWrite {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        expected_basis: target.basis,
        issue_id: issue.issue_id.clone(),
        grant: true,
        expected_waiver_id: None,
        actor: "Fixture reviewer".into(),
        reason: "Fixture waiver".into(),
    };
    let waiver_result = store.waive_review_issue(&waiver).unwrap();
    let plain = targets.iter().find(|t| t.native_key == "plain").unwrap();
    store
        .run_review_checks(
            project,
            plain.unit_id,
            "zh-CN",
            &plain.basis,
            ExecutionId::new(),
        )
        .unwrap();
    let fallback = FallbackWrite {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: plain.unit_id,
        locale: "zh-CN".into(),
        expected_basis: plain.basis.clone(),
        allow: true,
        expected_fallback_id: None,
        actor: "Fixture reviewer".into(),
        reason: "Fixture fallback".into(),
    };
    let fallback_result = store.allow_source_fallback(&fallback).unwrap();
    vec![
        (
            "read_term_save_action",
            "term",
            json!(term),
            json!(term_result),
        ),
        (
            "read_context_save_action",
            "context",
            json!(context),
            json!(context_result),
        ),
        (
            "read_context_capture_action",
            "capture",
            json!(capture),
            json!(capture_result),
        ),
        (
            "read_resource_decision_action",
            "decision",
            json!(file),
            json!(file_result),
        ),
        (
            "read_review_decision_action",
            "decision",
            json!(decision),
            json!(decision_result),
        ),
        (
            "read_review_waiver_action",
            "waiver",
            json!(waiver),
            json!(waiver_result),
        ),
        (
            "read_review_fallback_action",
            "fallback",
            json!(fallback),
            json!(fallback_result),
        ),
        ("read_review_check_action", "",
            json!(qa),
            json!(qa_result)),
    ]
}
#[test]
fn registered_review_resource_action_reads_are_exact_authorized_and_runtime_independent() {
    let temp = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project=call(&view,"create_project",json!({"destination":temp.path().join("project"),"displayName":"Receipt reads","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let session = project["sessionToken"].clone();
    let project_id = project["metadata"]["projectId"].clone();
    let originals = app
        .state::<AppState>()
        .sessions
        .with(|sessions| seed(&mut sessions.active.as_mut().unwrap().store));
    app.state::<AppState>()
        .sessions
        .with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    for (command, field, original, receipt) in &originals {
        let mut request = json!({"sessionToken":session,"projectId":project_id});
        if field.is_empty() {
            for (key, value) in original.as_object().unwrap() {
                request[key] = value.clone();
            }
        } else {
            request[*field] = original.clone();
        }
        assert_eq!(
            call(&view, command, request).unwrap(),
            json!({"request":original,"receipt":receipt}),
            "{command} before runtime initialization"
        );
    }
    app.state::<AppState>()
        .sessions
        .with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    let before = app.state::<AppState>().sessions.with(|sessions| {
        let active = sessions.active.as_mut().unwrap();
        let sequence = active
            .store
            .changes_since(tsumugi_core::execution::Revision::new(0).unwrap())
            .sequence;
        active.execution_parts().unwrap().0.quiescing = true;
        sequence
    });
    for (command, field, original, receipt) in originals {
        let mut request = json!({"sessionToken":session,"projectId":project_id});
        if field.is_empty() {
            for (key, value) in original.as_object().unwrap() {
                request[key] = value.clone();
            }
        } else {
            request[field] = original.clone();
        }
        assert_eq!(
            call(&view, command, request.clone()).unwrap(),
            json!({"request":original,"receipt":receipt}),
            "{command}"
        );
        let mut missing = request.clone();
        if field.is_empty() {
            missing["actionId"] = json!(ExecutionId::new());
        } else {
            missing[field]["actionId"] = json!(ExecutionId::new());
        }
        assert!(
            call(&view, command, missing).unwrap().is_null(),
            "{command}"
        );
        let mut mismatch = request.clone();
        if field.is_empty() {
            mismatch["locale"] = json!("fr-FR");
        } else if field == "term" {
            mismatch[field]["source"] = json!("Different");
        } else if field == "context" {
            mismatch[field]["text"] = json!("Different");
        } else if field == "capture" {
            mismatch[field]["budgetBytes"] = json!(64);
        } else {
            mismatch[field]["projectId"] = json!(ExecutionId::new());
        }
        assert!(call(&view, command, mismatch).is_err(), "{command}");
        let mut unauthorized = request.clone();
        unauthorized["sessionToken"] = json!("inactive");
        assert!(call(&view, command, unauthorized).is_err(), "{command}");
        let mut unknown = request;
        unknown["approved"] = json!(true);
        assert!(call(&view, command, unknown).is_err(), "{command}");
    }
    let after = app.state::<AppState>().sessions.with(|sessions| {
        sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .changes_since(tsumugi_core::execution::Revision::new(0).unwrap())
            .sequence
    });
    assert_eq!(before, after);
}
