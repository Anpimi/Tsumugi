use super::*;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::content;

const SOURCE: &str = "Copper 👩🏽‍💻 e\u{301}";

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

struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    directory: tempfile::TempDir,
    context: Value,
    after: Value,
    basis_request: Value,
    capture: Value,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .invoke_handler(crate::commands::execution::production_handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let project = call(&window, "create_project", json!({
            "destination":directory.path().join("project"), "displayName":"Synthetic correction",
            "sourceLocale":"en", "targetLocales":["zh-CN"]
        })).unwrap();
        let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
        // Seed synthetic adopted source through the existing Core source owner.
        // No plugin process, provider, external file selection or model is used.
        let (unit, source_revision) = app.state::<AppState>().sessions.with(|sessions| {
            let store = &mut sessions.active.as_mut().unwrap().store;
            let bytes = serde_json::to_vec(&json!({"entry": SOURCE})).unwrap();
            let bundle = content::SourceBundle::capture(
                include_bytes!(
                    "../../../../../../crates/core/tests/fixtures/stardew-lookup/manifest.json"
                ),
                &bytes,
                "en",
            )
            .unwrap();
            let input = bundle
                .fixed_input(store.metadata().unwrap().project_id())
                .unwrap();
            let mut runtime = ExecutionRuntime::new(store).unwrap();
            runtime
                .register_read_only(Arc::new(content::SourceRunner))
                .unwrap();
            runtime.submit(store, &input).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let result = loop {
                runtime.tick(store).unwrap();
                if let Some(result) = store
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id,
                    )
                    .unwrap()
                {
                    break result;
                }
                assert!(Instant::now() < deadline, "synthetic source did not finish");
                std::thread::sleep(Duration::from_millis(2));
            };
            let preview = store
                .source_preview(input.envelope().attempt_id, result, 0, 1)
                .unwrap();
            let action = store
                .prepare_adoption_with_id(
                    ExecutionId::new(),
                    input.envelope().attempt_id,
                    input.envelope().units[0].unit_id,
                    vec![result],
                    serde_json::to_value(preview.confirmation).unwrap(),
                )
                .unwrap();
            store
                .adopt_execution(&action, &content::SourceAdoptionHandler)
                .unwrap();
            let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
            let row = store.source_content(snapshot, 0, 1).unwrap().rows.remove(0);
            (row.unit_id.unwrap(), row.source_revision_id.unwrap())
        });
        let mut save = context.clone();
        save["actionId"] = json!(ExecutionId::new());
        save["unitId"] = json!(unit);
        save["locale"] = json!("zh-CN");
        save["sourceRevisionId"] = json!(source_revision);
        save["expectedSelectionId"] = Value::Null;
        save["text"] = json!("旧铜块 👩🏽‍💻 e\u{301}");
        let before = call(&window, "save_translation_revision", save.clone()).unwrap();
        save["actionId"] = json!(ExecutionId::new());
        save["expectedSelectionId"] = before["selection"]["eventId"].clone();
        save["text"] = json!("铜锭 👩🏽‍💻 e\u{301}");
        let after = call(&window, "save_translation_revision", save).unwrap();
        let mut basis_request = context.clone();
        basis_request["unitId"] = json!(unit);
        basis_request["locale"] = json!("zh-CN");
        basis_request["afterSelectionId"] = after["selection"]["eventId"].clone();
        let evidence = call(&window, "read_correction_term_basis", basis_request.clone()).unwrap();
        assert_eq!(evidence["sourceText"], SOURCE);
        assert_eq!(evidence["beforeText"], before["revision"]["text"]);
        assert_eq!(evidence["afterText"], after["revision"]["text"]);
        assert_eq!(
            evidence["basis"]["before"]["revisionId"],
            before["revision"]["revisionId"]
        );
        assert_eq!(
            evidence["basis"]["before"]["selectionId"],
            before["selection"]["eventId"]
        );
        assert_eq!(
            evidence["basis"]["after"]["revisionId"],
            after["revision"]["revisionId"]
        );
        assert_eq!(
            evidence["basis"]["after"]["selectionId"],
            after["selection"]["eventId"]
        );
        let mut capture = context.clone();
        capture["capture"] = json!({"actionId":ExecutionId::new(), "basis":evidence["basis"],
            "source":"Copper", "target":"铜锭", "protected":false, "reason":"Synthetic exact local correction"});
        Self {
            app,
            window,
            directory,
            context,
            after,
            basis_request,
            capture,
        }
    }
    fn action(&self, action: &Value) -> Value {
        let mut request = self.context.clone();
        request["actionId"] = action.clone();
        request
    }
    fn terms(&self) -> Value {
        let mut request = self.context.clone();
        request["locale"] = json!("zh-CN");
        request["afterTermId"] = Value::Null;
        request["limit"] = json!(100);
        call(&self.window, "read_terms", request).unwrap()
    }
}

#[test]
fn correction_term_ipc_captures_saved_manual_evidence_and_reconciles_original_receipts() {
    let fixture = Fixture::new();
    let window = &fixture.window;
    let database = fixture.directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let status = call(window, "execution_status", fixture.context.clone()).unwrap();
    let evidence = call(
        window,
        "read_correction_term_basis",
        fixture.basis_request.clone(),
    )
    .unwrap();
    assert_eq!(evidence["current"], true);
    assert_eq!(fixture.terms(), json!([]));
    assert_eq!(
        call(
            window,
            "read_correction_term_action",
            fixture.action(&fixture.capture["capture"]["actionId"])
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert_eq!(
        call(window, "execution_status", fixture.context.clone()).unwrap(),
        status
    );

    let receipt = call(window, "capture_correction_term", fixture.capture.clone()).unwrap();
    assert_eq!(receipt["request"], fixture.capture["capture"]);
    assert_eq!(receipt["capture"]["count"], 1);
    assert_eq!(receipt["capture"]["origin"]["kind"], "correction");
    assert_eq!(receipt["capture"]["origin"]["basis"], evidence["basis"]);
    assert!(receipt["capture"].get("resourceId").is_none());
    assert!(receipt["capture"].get("license").is_none());
    assert_eq!(
        fixture.terms(),
        json!([]),
        "capturing feedback cannot create an adopted term"
    );
    assert_eq!(
        call(window, "capture_correction_term", fixture.capture.clone()).unwrap(),
        receipt
    );
    assert_eq!(
        call(
            window,
            "read_correction_term_action",
            fixture.action(&receipt["request"]["actionId"])
        )
        .unwrap(),
        receipt
    );
    let mut changed = fixture.capture.clone();
    changed["capture"]["reason"] = json!("Changed original intent");
    let rejected = call(window, "capture_correction_term", changed).unwrap_err();
    assert_eq!(rejected["code"], "result-mismatch");
    assert_eq!(rejected["reason"], "resource-action");

    let mut read = fixture.context.clone();
    read["captureId"] = receipt["capture"]["captureId"].clone();
    let preview = call(window, "read_resource_preview", read.clone()).unwrap();
    assert_eq!(preview["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        preview["rows"][0]["scopeUnitId"],
        evidence["basis"]["unitId"]
    );
    assert_eq!(preview["correction"]["evidence"], evidence);
    assert_eq!(preview["correction"]["decision"], Value::Null);
    let mut decision = fixture.context.clone();
    decision["decision"] = json!({"projectId":fixture.context["projectId"],"actionId":ExecutionId::new(),
        "captureId":receipt["capture"]["captureId"],"entryId":preview["rows"][0]["entry"]["id"],
        "expectedRevisionId":null,"decision":"adopt"});
    let accepted = call(window, "decide_resource_entry", decision.clone()).unwrap();
    assert_eq!(accepted["request"], decision["decision"]);
    assert_eq!(accepted["revision"]["originKind"], "manual");
    assert_eq!(
        accepted["revision"]["captureId"],
        receipt["capture"]["captureId"]
    );
    assert_eq!(accepted["revision"]["externalEntryId"], Value::Null);
    assert_eq!(
        accepted["revision"]["scopeUnitId"],
        evidence["basis"]["unitId"]
    );
    assert_eq!(fixture.terms().as_array().unwrap().len(), 1);
    assert_eq!(
        call(
            window,
            "read_resource_decision_action",
            fixture.action(&decision["decision"]["actionId"])
        )
        .unwrap(),
        accepted
    );
    assert_eq!(
        call(window, "decide_resource_entry", decision.clone()).unwrap(),
        accepted
    );
    let mut conflicting = decision.clone();
    conflicting["decision"]["actionId"] = json!(ExecutionId::new());
    let rejected = call(window, "decide_resource_entry", conflicting.clone()).unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["stage"], "execution-adopt");
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["reason"], "resource-current");
    assert_eq!(
        call(
            window,
            "read_resource_decision_action",
            fixture.action(&conflicting["decision"]["actionId"])
        )
        .unwrap(),
        Value::Null
    );
    let mut changed = decision;
    changed["decision"]["decision"] = json!("ignore");
    assert!(call(window, "decide_resource_entry", changed).is_err());

    let mut save = fixture.context.clone();
    save["actionId"] = json!(ExecutionId::new());
    save["unitId"] = evidence["basis"]["unitId"].clone();
    save["locale"] = json!("zh-CN");
    save["sourceRevisionId"] = evidence["basis"]["sourceRevisionId"].clone();
    save["expectedSelectionId"] = fixture.after["selection"]["eventId"].clone();
    save["text"] = json!("A later saved correction");
    call(window, "save_translation_revision", save).unwrap();
    let stale = call(
        window,
        "read_correction_term_basis",
        fixture.basis_request.clone(),
    )
    .unwrap();
    assert_eq!(stale["current"], false);
    assert_eq!(stale["basis"], evidence["basis"]);
    assert_eq!(
        call(window, "capture_correction_term", fixture.capture.clone()).unwrap(),
        receipt
    );
    assert_eq!(
        call(window, "read_resource_preview", read).unwrap()["correction"]["decision"],
        accepted
    );
    call(window, "quiesce_execution", fixture.context.clone()).unwrap();
    let quiesced = call(window, "execution_status", fixture.context.clone()).unwrap();
    assert_eq!(quiesced["active"], false);
    assert_eq!(quiesced["quiescing"], false);
    assert_eq!(
        call(
            window,
            "read_correction_term_action",
            fixture.action(&receipt["request"]["actionId"])
        )
        .unwrap(),
        receipt
    );
    assert_eq!(
        call(
            window,
            "read_resource_decision_action",
            fixture.action(&accepted["actionId"])
        )
        .unwrap(),
        accepted
    );
    let mut fresh = fixture.capture.clone();
    fresh["capture"]["actionId"] = json!(ExecutionId::new());
    let rejected = call(window, "capture_correction_term", fresh.clone()).unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["stage"], "execution-adopt");
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["reason"], "correction-stale");
    assert_eq!(
        call(
            window,
            "read_correction_term_action",
            fixture.action(&fresh["capture"]["actionId"])
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(fixture.terms().as_array().unwrap().len(), 1);
    assert_eq!(
        call(window, "execution_status", fixture.context.clone()).unwrap(),
        quiesced
    );
}

#[test]
fn correction_term_registered_ipc_rejects_foreign_or_forged_inputs_and_late_sessions() {
    let fixture = Fixture::new();
    let window = &fixture.window;
    let action = fixture.action(&json!(ExecutionId::new()));
    let originals = [
        ("read_correction_term_basis", &fixture.basis_request),
        ("capture_correction_term", &fixture.capture),
        ("read_correction_term_action", &action),
        ("read_resource_decision_action", &action),
    ];
    let database = fixture.directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    for (command, original) in originals {
        for field in ["sessionToken", "projectId"] {
            let mut foreign = original.clone();
            foreign[field] = if field == "sessionToken" {
                json!("inactive-session")
            } else {
                json!(ExecutionId::new())
            };
            assert_eq!(
                call(window, command, foreign).unwrap_err()["code"],
                "session-invalid"
            );
        }
        let mut forged = original.clone();
        forged["approved"] = json!(true);
        assert!(call(window, command, forged).is_err());
    }
    let mut foreign = fixture.capture.clone();
    foreign["capture"]["basis"]["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(window, "capture_correction_term", foreign).unwrap_err()["reason"],
        "correction-term-project"
    );
    let mut foreign_decision = fixture.context.clone();
    foreign_decision["decision"] = json!({"projectId":ExecutionId::new(),"actionId":ExecutionId::new(),
        "captureId":ExecutionId::new(),"entryId":"term","expectedRevisionId":null,"decision":"adopt"});
    assert_eq!(
        call(window, "decide_resource_entry", foreign_decision).unwrap_err()["reason"],
        "resource-decision-project"
    );
    for field in [
        "sourceText",
        "beforeText",
        "afterText",
        "fileName",
        "license",
    ] {
        let mut forged = fixture.capture.clone();
        forged["capture"][field] = json!("Client-supplied source authority");
        assert!(call(window, "capture_correction_term", forged).is_err());
    }
    let mut missing = fixture.capture.clone();
    missing["capture"]["basis"]
        .as_object_mut()
        .unwrap()
        .remove("after");
    assert!(call(window, "capture_correction_term", missing).is_err());
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert_eq!(fixture.terms(), json!([]));
    call(
        window,
        "close_project",
        json!({"sessionToken":fixture.context["sessionToken"]}),
    )
    .unwrap();
    call(
        window,
        "open_project",
        json!({"locator":fixture.directory.path().join("project")}),
    )
    .unwrap();
    for (command, original) in originals {
        assert_eq!(
            call(window, command, original.clone()).unwrap_err()["code"],
            "session-invalid"
        );
    }
    assert_eq!(std::fs::read(database).unwrap(), before);
}

#[test]
fn correction_capture_accepted_before_a_lost_reply_retains_its_original_receipt() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let fixture = Fixture::new();
    let state = fixture.app.state::<AppState>();
    let held = state.sessions.pause();
    let request: CorrectionCaptureRequest =
        serde_json::from_value(fixture.capture.clone()).unwrap();
    let mut accepted = Box::pin(capture_correction_term(fixture.app.state(), request));
    assert!(matches!(
        accepted
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(accepted);
    drop(held);
    state.sessions.with(|_| ());
    let receipt = call(
        &fixture.window,
        "read_correction_term_action",
        fixture.action(&fixture.capture["capture"]["actionId"]),
    )
    .unwrap();
    assert_eq!(receipt["request"], fixture.capture["capture"]);
    assert_eq!(
        call(
            &fixture.window,
            "capture_correction_term",
            fixture.capture.clone()
        )
        .unwrap(),
        receipt
    );
    assert_eq!(fixture.terms(), json!([]));
}

#[test]
fn correction_capture_rechecks_the_original_session_after_an_accepted_project_close() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let fixture = Fixture::new();
    let state = fixture.app.state::<AppState>();
    let held = state.sessions.pause();
    let close: CloseProjectRequest =
        serde_json::from_value(json!({"sessionToken":fixture.context["sessionToken"]})).unwrap();
    let closed = state
        .sessions
        .callback()
        .submit(
            "test.close-before-correction",
            CommandStage::Close,
            move |sessions| sessions.close(close),
        )
        .unwrap();
    // Both jobs are admitted, in this order, before the project owner resumes.
    // Admission alone cannot authorize the later correction against a closed session.
    let request: CorrectionCaptureRequest =
        serde_json::from_value(fixture.capture.clone()).unwrap();
    let mut late = Box::pin(capture_correction_term(fixture.app.state(), request));
    assert!(matches!(
        late.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(held);
    tauri::async_runtime::block_on(closed).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(late).unwrap_err().code,
        CommandErrorCode::SessionInvalid
    );
    let reopened = call(
        &fixture.window,
        "open_project",
        json!({"locator":fixture.directory.path().join("project")}),
    )
    .unwrap();
    let receipt = call(&fixture.window, "read_correction_term_action", json!({"sessionToken":reopened["sessionToken"],
        "projectId":reopened["metadata"]["projectId"],"actionId":fixture.capture["capture"]["actionId"]})).unwrap();
    assert_eq!(receipt, Value::Null);
}
