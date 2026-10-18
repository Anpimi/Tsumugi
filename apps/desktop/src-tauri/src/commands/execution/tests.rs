use super::*;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod package_cleanup_process;
mod package_lifecycle;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

#[test]
fn command_error_wire_fixture_preserves_conflicts_guidance_and_diagnostics() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/commandErrors.contract.json"
    ))
    .unwrap();
    for value in fixture["errors"].as_array().unwrap() {
        let error: CommandError = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&error).unwrap(), *value);
        assert_eq!(error.field, None);
        if let Some(conflict) = error.conflict.clone() {
            let mapped = map_execution(
                ExecutionError::new(ErrorCode::DependencyConflict, "controlled-boundary")
                    .with_conflict(conflict.clone()),
                error.stage,
            );
            assert_eq!(mapped.conflict, Some(conflict));
            assert_eq!(
                mapped.recovery_guidance,
                Some(RecoveryGuidance::ReviewCurrent)
            );
            assert_eq!(mapped.outcome, CommandOutcome::Rejected);
            assert!(mapped.diagnostic_id.is_some());
        }
    }
    let mut error = CommandError::unknown(CommandStage::ExecutionAdopt);
    let diagnostic_id = error
        .diagnostic_id
        .expect("constructor reports early failures");
    error.reason = Some("private request text, file path, secret credential".into());
    error.field = Some("sensitive input".into());
    let line = error.diagnostic_line("controlled-boundary", diagnostic_id);
    assert!(line.contains(&diagnostic_id.to_string()));
    assert!(line.contains("operation=controlled-boundary"));
    assert!(!line.contains("private") && !line.contains("secret") && !line.contains("sensitive"));
    let reported = error
        .report("controlled-boundary", ExecutionId::new())
        .report("finish-boundary", ExecutionId::new());
    assert_eq!(reported.diagnostic_id, Some(diagnostic_id));
}

#[test]
fn cancellation_error_wire_distinguishes_unknown_projection_from_rejected_write() {
    let unknown = map_execution(
        ExecutionError::new(ErrorCode::OutcomeUnknown, "input-digest"),
        CommandStage::ExecutionCancel,
    );
    assert_eq!(unknown.code, CommandErrorCode::OutcomeUnknown);
    assert_eq!(unknown.stage, CommandStage::ExecutionCancel);
    assert_eq!(unknown.outcome, CommandOutcome::Unknown);
    assert!(unknown.recovery_required);
    assert_eq!(
        unknown.recovery_guidance,
        Some(RecoveryGuidance::ReconcileOriginal)
    );
    assert_eq!(unknown.reason.as_deref(), Some("input-digest"));
    assert!(unknown.item_ids.is_empty());
    assert!(unknown.conflict.is_none());
    assert!(unknown.diagnostic_id.is_some());
    let value = serde_json::to_value(&unknown).unwrap();
    assert_eq!(value["code"], json!("outcome-unknown"));
    assert_eq!(value["stage"], json!("execution-cancel"));
    assert_eq!(value["outcome"], json!("unknown"));
    assert_eq!(value["recoveryRequired"], json!(true));
    assert_eq!(value["recoveryGuidance"], json!("reconcile-original"));
    assert_eq!(value["reason"], json!("input-digest"));
    assert_eq!(
        serde_json::from_value::<CommandError>(value).unwrap(),
        unknown
    );

    let rejected = map_execution(
        ExecutionError::new(ErrorCode::Busy, "execution-storage"),
        CommandStage::ExecutionCancel,
    );
    assert_eq!(rejected.code, CommandErrorCode::Busy);
    assert_eq!(rejected.stage, CommandStage::ExecutionCancel);
    assert_eq!(rejected.outcome, CommandOutcome::Rejected);
    assert!(!rejected.recovery_required);
    assert!(rejected.recovery_guidance.is_none());
    assert_eq!(rejected.reason.as_deref(), Some("execution-storage"));
    let value = serde_json::to_value(&rejected).unwrap();
    assert_eq!(value["code"], json!("busy"));
    assert_eq!(value["stage"], json!("execution-cancel"));
    assert_eq!(value["outcome"], json!("rejected"));
    assert_eq!(value["recoveryRequired"], json!(false));
    assert!(value.get("recoveryGuidance").is_none());
    assert_eq!(
        serde_json::from_value::<CommandError>(value).unwrap(),
        rejected
    );
}

#[test]
fn execution_wire_fixture_matches_rust_types() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/executionCommands.contract.json"
    ))
    .unwrap();
    fn round_trip<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round_trip::<SessionRequest>(&fixture["session"]);
    round_trip::<ListRequest>(&fixture["list"]);
    round_trip::<RecoveryRequest>(&fixture["recover"]);
    round_trip::<ContinuationRequest>(&fixture["continuation"]);
    round_trip::<ContinuationReadRequest>(&fixture["continuationRead"]);
    round_trip::<ContinuationListRequest>(&fixture["continuationList"]);
    round_trip::<TaskViewRequest>(&fixture["taskViewRequest"]);
    round_trip::<ContinuationReceipt>(&fixture["continuationReceipt"]);
    round_trip::<ContinuationPage>(&fixture["continuations"]);
    let mut zero = fixture["continuation"].clone();
    zero["action"]["expectedCancellationRevision"] = json!("0");
    round_trip::<ContinuationRequest>(&zero);
    round_trip::<PrepareRequest>(&fixture["prepare"]);
    round_trip::<AttemptDetail>(&fixture["detail"]);
    round_trip::<RuntimeStatus>(&fixture["status"]);
    round_trip::<CommandError>(&fixture["error"]);
    round_trip::<AdoptionReceipt>(&fixture["receipt"]);
    round_trip::<AdoptionAction>(&fixture["action"]);
    round_trip::<ResultEnvelope>(&fixture["output"]);
    let result: ResultEnvelope = serde_json::from_value(fixture["output"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(ExecutionOutputView {
            result,
            source_failure: None
        })
        .unwrap(),
        fixture["output"],
    );
    round_trip::<TaskView>(&fixture["task"]);
    round_trip::<AttemptSummary>(&fixture["summary"]);
    round_trip::<RecoveryView>(&fixture["recovery"]);
    round_trip::<OutputRequest>(&fixture["outputRequest"]);
    round_trip::<CancelRequest>(&fixture["cancel"]);
    round_trip::<AdoptRequest>(&fixture["adopt"]);
    round_trip::<TaskRequest>(&fixture["taskRequest"]);
    round_trip::<AttemptRequest>(&fixture["attempt"]);
    let mut overflow = fixture["attempt"].clone();
    overflow["offset"] = json!(u64::from(u32::MAX) + 1);
    assert!(serde_json::from_value::<AttemptRequest>(overflow).is_err());
    let mut integer = fixture["task"].clone();
    integer["sequence"] = json!(9_007_199_254_740_993u64);
    assert!(serde_json::from_value::<TaskView>(integer).is_err());
    let mut unknown = fixture["detail"].clone();
    unknown["items"][0]["status"]["execution"] = json!("future-state");
    assert!(serde_json::from_value::<AttemptDetail>(unknown).is_err());
}

#[test]
fn source_failure_projection_requires_valid_public_payload_and_captured_artifact() {
    let artifacts = [sdk::CapturedTextArtifact {
        id: "captured-1".into(),
        logical_path: "manifest.json".into(),
        role: "source".into(),
        sha256: "a".repeat(64),
        utf8: "{}".into(),
    }];
    let encoded =
        |schema, value: Value| sdk::EncodedPayload::capture(schema, value.to_string()).unwrap();
    let valid = json!({"code":"unsupported-structure","artifactId":"captured-1","detail":"The Name value must be a string."});
    let payload = encoded(sdk::source_extraction_error_contract(), valid.clone());
    let projected = parse_public_source_failure(&payload, &artifacts).unwrap();
    assert_eq!(projected.detail, "The Name value must be a string.");
    assert_eq!(projected.artifact_id.as_deref(), Some("captured-1"));
    assert!(
        parse_public_source_failure(
            &encoded(sdk::source_extraction_input_contract(), valid.clone()),
            &artifacts
        )
        .is_none()
    );
    assert!(
        parse_public_source_failure(
            &encoded(
                sdk::source_extraction_error_contract(),
                json!({"code":"future","artifactId":"captured-1","detail":"x"})
            ),
            &artifacts
        )
        .is_none()
    );
    assert!(
        parse_public_source_failure(
            &encoded(
                sdk::source_extraction_error_contract(),
                json!({"code":"invalid-source","artifactId":"not-captured","detail":"x"})
            ),
            &artifacts
        )
        .is_none()
    );
    assert!(
        parse_public_source_failure(
            &encoded(
                sdk::source_extraction_error_contract(),
                json!({"code":"invalid-source","artifactId":null,"detail":""})
            ),
            &artifacts
        )
        .is_none()
    );
}

#[test]
fn source_failure_output_keeps_generic_shape_and_rejects_cross_project_read() {
    let (_directory, _app, webview, context) = setup();
    let attempt = call(
        &webview,
        "seed_execution_fixture",
        request(
            &context,
            json!({"mode":"partial","delayMs":1,"grouped":true}),
        ),
    )
    .unwrap();
    settled(&webview, &context);
    let record = detail(&webview, &context, &attempt);
    let failed = record["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["status"]["execution"] == "failed" && item["resultId"].is_string())
        .expect("saved failed result");
    let selected = request(
        &context,
        json!({"attemptId":attempt,"resultId":failed["resultId"]}),
    );
    let output = call(&webview, "read_execution_output", selected.clone()).unwrap();
    assert_eq!(output["projectId"], context["projectId"]);
    assert_eq!(output["resultId"], failed["resultId"]);
    assert_eq!(output["itemId"], failed["status"]["itemId"]);
    assert!(output.get("sourceFailure").is_none());
    let mut foreign = selected;
    foreign["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&webview, "read_execution_output", foreign).unwrap_err()["code"],
        "session-invalid"
    );
}

#[test]
fn completed_query_retains_its_result_until_storage_accepts_it() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("query-project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Query", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut host = ExecutionHost::new(&store).unwrap();
    let input =
        test_support::input(&mut store, test_support::FixtureMode::Unknown, 0, false).unwrap();
    host.runtime.submit(&mut store, &input).unwrap();
    let attempt = input.envelope().attempt_id;
    let deadline = Instant::now() + Duration::from_secs(5);
    while host.active(&store).unwrap() {
        host.tick(&mut store).unwrap();
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    let item = input.envelope().items[0].item_id;
    let query = Arc::new(
        host.runtime
            .outcome_query(&store, attempt, item)
            .unwrap()
            .unwrap(),
    );
    let outcome = query.run().unwrap();
    let QueryOutcome::Known(ref expected) = outcome else {
        panic!("fixture query must resolve");
    };
    let expected = expected.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        sender.send(Ok(outcome)).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !thread.is_finished() {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    host.queries.push(QueryJob {
        query,
        receiver,
        thread,
        started: Instant::now(),
        pending_outcome: None,
    });
    let blocker = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(
        host.tick(&mut store).unwrap_err().code,
        CommandErrorCode::Busy
    );
    assert_eq!(host.queries.len(), 1);
    assert!(host.queries[0].pending_outcome.is_some());
    assert_eq!(
        host.begin_quiesce(&mut store).unwrap_err().code,
        CommandErrorCode::Busy
    );
    assert!(!host.quiescing);
    assert!(host.queries[0].pending_outcome.is_some());
    blocker.execute_batch("ROLLBACK").unwrap();
    host.begin_quiesce(&mut store).unwrap();
    host.runtime.finish_quiesce(&mut store).unwrap();
    assert!(host.queries.is_empty());
    assert_eq!(
        store
            .execution_result(attempt, expected.envelope().result_id)
            .unwrap()
            .bytes(),
        expected.bytes()
    );
    assert_eq!(
        store
            .execution_attempt(attempt, false)
            .unwrap()
            .items
            .iter()
            .find(|status| status.item_id == item)
            .unwrap()
            .validation,
        ValidationState::Valid
    );
}

fn call(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        webview,
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
fn setup() -> (
    tempfile::TempDir,
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
    Value,
) {
    let temp = tempfile::tempdir().unwrap();
    let app = super::super::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let view=call(&webview,"create_project",json!({"destination":temp.path().join("project"),"displayName":"Execution test","sourceLocale":"en-US","targetLocales":["zh-CN"]})).unwrap();
    let context =
        json!({"sessionToken":view["sessionToken"],"projectId":view["metadata"]["projectId"]});
    (temp, app, webview, context)
}

#[test]
fn ordinary_plugin_start_ipc_reads_all_fixed_operations_without_runtime_or_grant() {
    let (temp, app, webview, context) = setup();
    let mut original = request(&context, json!({"attemptId":ExecutionId::new(),"inputDigest":"a".repeat(64),"operation":"source-import"}));
    for operation in ["source-import", "source-semantic-check", "translation-extract", "translation-semantic-check", "locale-build", "artifact-semantic-check"] {
        original["operation"] = json!(operation);
        assert_eq!(call(&webview, "read_plugin_execution_start", original.clone()).unwrap(), Value::Null);
    }
    for (field, value) in [("projectId", json!(ExecutionId::new())), ("sessionToken", json!(ExecutionId::new())),
        ("attemptId", json!("bad")), ("inputDigest", json!("bad")), ("operation", json!("translation-import")), ("grantId", json!(ExecutionId::new()))] {
        let mut wrong = original.clone(); wrong[field] = value;
        assert!(call(&webview, "read_plugin_execution_start", wrong).is_err());
    }
    app.state::<AppState>().sessions.with(|sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(active.execution.is_none());
        assert_eq!(active.store.execution_sequence().unwrap().get(), 0);
    });
    call(&webview, "close_project", json!({"sessionToken":context["sessionToken"]})).unwrap();
    let reopened = call(&webview, "open_project", json!({"locator":temp.path().join("project")})).unwrap();
    assert!(call(&webview, "read_plugin_execution_start", original.clone()).is_err());
    original["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&webview, "read_plugin_execution_start", original).unwrap(), Value::Null);
    app.state::<AppState>().sessions.with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
}

#[test]
fn cancellation_action_ipc_reads_exact_requests_without_initializing_or_replaying_runtime() {
    let (temp, app, webview, context) = setup();
    let missing = request(&context, json!({"taskId":ExecutionId::new(),"requestId":ExecutionId::new()}));
    assert_eq!(call(&webview, "read_execution_cancellation_action", missing).unwrap(), Value::Null);
    app.state::<AppState>().sessions.with(|sessions| { assert!(sessions.active.as_ref().unwrap().execution.is_none()); });
    let attempt = call(&webview, "seed_execution_fixture", request(&context, json!({"mode":"success","delayMs":1,"grouped":false}))).unwrap();
    settled(&webview, &context);
    let detail = detail(&webview, &context, &attempt);
    let mut original = request(&context, json!({"taskId":detail["taskId"],"requestId":ExecutionId::new()}));
    assert_eq!(call(&webview, "read_execution_cancellation_action", original.clone()).unwrap(), Value::Null);
    let revision = call(&webview, "cancel_execution_task", original.clone()).unwrap();
    let expected = json!({"projectId":context["projectId"],"taskId":original["taskId"],"requestId":original["requestId"],"revision":revision});
    let later = request(&context, json!({"taskId":detail["taskId"],"requestId":ExecutionId::new()}));
    call(&webview, "cancel_execution_task", later).unwrap();
    assert_eq!(call(&webview, "read_execution_cancellation_action", original.clone()).unwrap(), expected);
    for field in ["projectId", "taskId", "sessionToken"] {
        let mut wrong = original.clone(); wrong[field] = json!(ExecutionId::new());
        assert!(call(&webview, "read_execution_cancellation_action", wrong).is_err());
    }
    app.state::<AppState>().sessions.with(|sessions| { sessions.active.as_mut().unwrap().execution_parts().unwrap().0.quiescing = true; });
    let sequence = app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()).sequence);
    assert_eq!(call(&webview, "read_execution_cancellation_action", original.clone()).unwrap(), expected);
    assert_eq!(app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()).sequence), sequence);
    app.state::<AppState>().sessions.with(|sessions| { sessions.active.as_mut().unwrap().execution_parts().unwrap().0.quiescing = false; });
    call(&webview, "close_project", json!({"sessionToken":context["sessionToken"]})).unwrap();
    let reopened = call(&webview, "open_project", json!({"locator":temp.path().join("project")})).unwrap();
    assert!(call(&webview, "read_execution_cancellation_action", original.clone()).is_err());
    original["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&webview, "read_execution_cancellation_action", original).unwrap(), expected);
}

#[test]
fn task_activity_read_is_authorized_bounded_and_does_not_initialize_execution() {
    let (_directory, app, webview, context) = setup();
    let request = |limit: u32| {
        let mut request = context.clone(); request["limit"] = json!(limit); request
    };
    let page = call(&webview, "read_execution_task_activity", request(12)).unwrap();
    assert_eq!(page, json!({"total":"0","active":"0","attention":"0","saved":"0","rows":[]}));
    let missing = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":ExecutionId::new(),"unitId":ExecutionId::new(),"actionId":ExecutionId::new(),"resultIds":[ExecutionId::new()]});
    assert_eq!(call(&webview, "read_execution_adoption_action", missing).unwrap(), Value::Null);
    app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.as_ref().unwrap().execution.is_none());
    });
    assert!(call(&webview, "read_execution_task_activity", request(0)).is_err());
    assert!(call(&webview, "read_execution_task_activity", request(21)).is_err());
    let mut alien = request(12); alien["projectId"] = json!(ExecutionId::new());
    assert!(call(&webview, "read_execution_task_activity", alien).is_err());
    let mut stale = request(12); stale["sessionToken"] = json!("stale-session");
    assert!(call(&webview, "read_execution_task_activity", stale).is_err());
}

#[test]
fn retired_query_blocks_session_close_and_generation_rotation_until_thread_exit() {
    let (_directory, app, webview, context) = setup();
    let (release, generation, attempt, before) =
        app.state::<AppState>().sessions.with(|sessions| {
            let active = sessions.active.as_mut().unwrap();
            let (host, store) = active.execution_parts().unwrap();
            let input =
                test_support::input(store, test_support::FixtureMode::Unknown, 0, false).unwrap();
            host.runtime.submit(store, &input).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while host.runtime.has_active_work(store).unwrap() {
                host.runtime.tick(store).unwrap();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            let attempt = input.envelope().attempt_id;
            let query = Arc::new(
                host.runtime
                    .outcome_query(store, attempt, input.envelope().items[0].item_id)
                    .unwrap()
                    .unwrap(),
            );
            let (release, wait) = mpsc::sync_channel(1);
            let (sender, receiver) = mpsc::channel();
            let held = query.clone();
            let thread = std::thread::spawn(move || {
                if wait.recv().is_ok() {
                    // The real query owns its original runner, never the project store.
                    let _ = sender.send(held.run());
                }
            });
            host.queries.push(QueryJob {
                query,
                receiver,
                thread,
                started: Instant::now() - Duration::from_secs(61),
                pending_outcome: None,
            });
            assert_eq!(
                host.poll_queries(store).unwrap_err().code,
                CommandErrorCode::OutcomeUnknown
            );
            assert!(host.queries.is_empty());
            assert_eq!(host.retired_queries.len(), 1);
            (
                release,
                host.runtime.generation(),
                attempt,
                store.execution_attempt(attempt, false).unwrap(),
            )
        });
    assert_eq!(
        call(&webview, "execution_status", context.clone()).unwrap()["active"],
        true
    );
    assert_eq!(
        call(
            &webview,
            "close_project",
            json!({"sessionToken":context["sessionToken"]})
        )
        .unwrap_err()["code"],
        "busy"
    );
    assert_eq!(call(&webview, "rename_project", json!({"sessionToken":context["sessionToken"],"expectedRevision":"1","displayName":"Moved","directoryName":"moved"})).unwrap_err()["code"], "busy");
    let status = call(&webview, "quiesce_execution", context.clone()).unwrap();
    assert_eq!(status["active"], true);
    assert_eq!(status["quiescing"], true);
    assert_eq!(
        call(
            &webview,
            "seed_execution_fixture",
            request(
                &context,
                json!({"mode":"unknown","delayMs":0,"grouped":false})
            )
        )
        .unwrap_err()["code"],
        "busy"
    );
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert_eq!(
            active.execution.as_ref().unwrap().runtime.generation(),
            generation
        );
        assert_eq!(
            serde_json::to_value(active.store.execution_attempt(attempt, false).unwrap()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    });
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&webview, "execution_status", context.clone()).unwrap()["active"] == true {
        assert!(
            Instant::now() < deadline,
            "original query thread did not drain"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let host = active.execution.as_ref().unwrap();
        assert_ne!(host.runtime.generation(), generation);
        assert!(host.retired_queries.is_empty());
        assert!(!host.quiescing);
        assert_eq!(
            active
                .store
                .execution_attempt(attempt, false)
                .unwrap()
                .progress
                .succeeded,
            0
        );
    });
    // New explicit work is admitted only after real cleanup; it gains no old result.
    call(
        &webview,
        "seed_execution_fixture",
        request(
            &context,
            json!({"mode":"unknown","delayMs":0,"grouped":false}),
        ),
    )
    .unwrap();
    settled(&webview, &context);
    call(
        &webview,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
}

fn call_when_ready(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match call(webview, command, request.clone()) {
            Err(e) if e["code"] == "busy" && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10))
            }
            result => return result,
        }
    }
}

#[test]
fn release_recovery_lookups_are_authorized_and_absence_is_a_read_only_result() {
    let (_directory, _app, webview, context) = setup();
    let before = call(&webview, "execution_status", context.clone()).unwrap();
    let build = request(
        &context,
        json!({"attemptId":ExecutionId::new(),"choices":[{"locale":"zh-CN","fileName":"i18n/zh.json"}],"expectedEligibilityBasis":"a".repeat(64)}),
    );
    assert_eq!(
        call(&webview, "read_locale_build_attempt", build.clone()).unwrap(),
        Value::Null
    );
    let mut stale = build;
    stale["sessionToken"] = json!("inactive-session");
    assert_eq!(
        call(&webview, "read_locale_build_attempt", stale).unwrap_err()["code"],
        "session-invalid"
    );
    let missing_selection = request(
        &context,
        json!({"actionId":ExecutionId::new(),"selectionId":ExecutionId::new()}),
    );
    assert_eq!(
        call(&webview, "read_delivery_action", missing_selection).unwrap_err()["code"],
        "session-invalid"
    );
    assert_eq!(call(&webview, "execution_status", context).unwrap(), before);
}

#[test]
fn ai_preview_start_and_saved_read_enforce_scope_consent_and_identity() {
    let (temp, app, webview, context) = setup();
    let units = {
        let state = app.state::<AppState>();
        let context = context.clone();
        state.sessions.with(move |sessions| {
        let active = authorized(
            sessions,
            context["sessionToken"].as_str().unwrap(),
            serde_json::from_value(context["projectId"].clone()).unwrap(),
            CommandStage::ExecutionRead,
        )
        .unwrap();
        let (host, store) = active.execution_parts().unwrap();
        let bundle=tsumugi_core::content::SourceBundle::capture(br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,br#"{"first":"Hello"}"#,"en-US").unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        host.runtime.submit(store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while host.active(store).unwrap() {
            host.tick(store).unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = store
            .execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap()
            .unwrap();
        let preview = store
            .source_preview(input.envelope().attempt_id, result, 0, 10)
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
            .adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler)
            .unwrap();
        store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10,
            )
            .unwrap()
            .rows
            .iter()
            .map(|r| r.unit_id.unwrap())
            .collect::<Vec<_>>()
        })
    };
    let config = tsumugi_core::ai::AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "test-model".into(),
        credential_env: "TSUMUGI_NONEXISTENT_AI_ACCEPTANCE_CREDENTIAL".into(),
        ..Default::default()
    };
    let database = rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    let before = database
        .query_row("SELECT COUNT(*) FROM execution_attempts", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    let prepared = call(
        &webview,
        "preview_ai_translation",
        request(
            &context,
            json!({"config":config,"locale":"zh-CN","unitIds":units}),
        ),
    )
    .unwrap();
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM execution_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    let start = json!({"attemptId":prepared["attemptId"],"digest":prepared["preview"]["digest"],"confirmed":true});
    assert_eq!(call(&webview,"start_ai_translation",request(&context,json!({"attemptId":prepared["attemptId"],"digest":prepared["preview"]["digest"],"confirmed":false}))).unwrap_err()["reason"],"ai-consent");
    assert!(
        call(
            &webview,
            "start_ai_translation",
            request(
                &context,
                json!({"attemptId":prepared["attemptId"],"digest":"wrong","confirmed":true})
            )
        )
        .is_err()
    );
    let mut stale = context.clone();
    stale["sessionToken"] = "stale".into();
    assert!(
        call(
            &webview,
            "start_ai_translation",
            request(&stale, start.clone())
        )
        .is_err()
    );
    let mut foreign = context.clone();
    foreign["projectId"] = ExecutionId::new().to_string().into();
    assert!(
        call(
            &webview,
            "start_ai_translation",
            request(&foreign, start.clone())
        )
        .is_err()
    );
    assert_eq!(
        call(
            &webview,
            "start_ai_translation",
            request(&context, start.clone())
        )
        .unwrap(),
        prepared["attemptId"]
    );
    assert_eq!(
        call(&webview, "start_ai_translation", request(&context, start)).unwrap(),
        prepared["attemptId"]
    );
    settled(&webview, &context);
    let saved = call(
        &webview,
        "read_ai_translation",
        request(&context, json!({"attemptId":prepared["attemptId"]})),
    )
    .unwrap();
    assert_eq!(saved["budget"]["limit"], 20);
    assert_eq!(saved["budget"]["dispatched"], 0);
    assert_eq!(saved["detail"]["progress"]["failed"], 1);
    assert_eq!(
        saved["detail"]["items"][0]["status"]["diagnostic"],
        "ai-credential"
    );
    assert!(!saved.to_string().contains("resume-undispatched"));
    assert!(!saved.to_string().contains("retry-safe-failure"));
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM execution_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before + 1
    );
}

#[test]
fn arena_ipc_preview_checks_all_variants_current_resources_consent_and_redaction() {
    let call = call_when_ready;
    let (temp, app, webview, context) = setup();
    let project: ExecutionId = serde_json::from_value(context["projectId"].clone()).unwrap();
    let (unit, source) = {
        let state = app.state::<AppState>();
        let context = context.clone();
        state.sessions.with(move |sessions| {
        let active = authorized(
            sessions,
            context["sessionToken"].as_str().unwrap(),
            project,
            CommandStage::ExecutionRead,
        )
        .unwrap();
        let (host, store) = active.execution_parts().unwrap();
        let bundle = tsumugi_core::content::SourceBundle::capture(br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
            br#"{"first":"Hello {name}"}"#, "en-US").unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        host.runtime.submit(store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while host.active(store).unwrap() {
            host.tick(store).unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = store
            .execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap()
            .unwrap();
        let preview = store
            .source_preview(input.envelope().attempt_id, result, 0, 10)
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
            .adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler)
            .unwrap();
        let row = store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10,
            )
            .unwrap()
            .rows
            .remove(0);
        (row.unit_id.unwrap(), row.source_revision_id.unwrap())
        })
    };
    let a = tsumugi_core::ai::AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "first-model-private-to-blind-view".into(),
        credential_env: "TSUMUGI_NONEXISTENT_AI_ACCEPTANCE_CREDENTIAL".into(),
        share_context: true,
        ..Default::default()
    };
    let mut config = tsumugi_core::ai::arena::ArenaConfig {
        variants: vec![a.clone(), a],
        max_items: 20,
        max_requests: 40,
        concurrency: 1,
        blind: true,
        parent_attempt_id: None,
    };
    let database = rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    let counts = || {
        [
            "execution_attempts",
            "translation_revisions",
            "translation_selections",
            "arena_comparisons",
            "arena_entries",
        ]
        .map(|table| {
            database
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
        })
    };
    let before = counts();
    let first = call(
        &webview,
        "preview_arena_translation",
        request(
            &context,
            json!({"config":config,"locale":"zh-CN","unitIds":[unit]}),
        ),
    )
    .unwrap();
    assert_eq!(counts(), before); // No credential was read: that variable is absent.
    config.variants[1].model = "second-model-private-to-blind-view".into();
    let second = call(
        &webview,
        "preview_arena_translation",
        request(
            &context,
            json!({"config":config,"locale":"zh-CN","unitIds":[unit]}),
        ),
    )
    .unwrap();
    assert_ne!(first["preview"]["digest"], second["preview"]["digest"]);
    let start = |p: &Value, confirmed: bool| {
        request(
            &context,
            json!({"attemptId":p["attemptId"],"digest":p["preview"]["digest"],"confirmed":confirmed}),
        )
    };
    assert!(call(&webview, "start_arena_translation", start(&first, true)).is_err());
    assert_eq!(
        call(&webview, "start_arena_translation", start(&second, false)).unwrap_err()["reason"],
        "arena-consent"
    );
    let mut forged = start(&second, true);
    forged["digest"] = "wrong".into();
    assert!(call(&webview, "start_arena_translation", forged).is_err());
    let mut stale = start(&second, true);
    stale["sessionToken"] = "stale".into();
    assert!(call(&webview, "start_arena_translation", stale).is_err());
    let mut foreign = start(&second, true);
    foreign["projectId"] = ExecutionId::new().to_string().into();
    assert!(call(&webview, "start_arena_translation", foreign).is_err());
    {
        let state = app.state::<AppState>();
        let context = context.clone();
        state.sessions.with(move |sessions| {
            let active = authorized(
                sessions,
                context["sessionToken"].as_str().unwrap(),
                project,
                CommandStage::ExecutionRead,
            )
            .unwrap();
            active
                .store
                .save_context(&tsumugi_core::SaveContext {
                    project_id: project,
                    action_id: ExecutionId::new(),
                    unit_id: unit,
                    locale: "zh-CN".into(),
                    source_revision_id: source,
                    expected_revision_id: None,
                    reason: "Synthetic change".into(),
                    text: "Updated context".into(),
                })
                .unwrap();
        })
    }
    assert_eq!(
        call(&webview, "start_arena_translation", start(&second, true)).unwrap_err()["reason"],
        "arena-preview"
    );
    assert_eq!(counts(), before);
    let prepared = call(
        &webview,
        "preview_arena_translation",
        request(
            &context,
            json!({"config":config,"locale":"zh-CN","unitIds":[unit]}),
        ),
    )
    .unwrap();
    assert_eq!(
        call(&webview, "start_arena_translation", start(&prepared, true)).unwrap(),
        prepared["attemptId"]
    );
    assert_eq!(
        call(&webview, "start_arena_translation", start(&prepared, true)).unwrap(),
        prepared["attemptId"]
    );
    settled(&webview, &context);
    let read = || {
        call(
            &webview,
            "read_arena_translation",
            request(&context, json!({"attemptId":prepared["attemptId"]})),
        )
        .unwrap()
    };
    let view = read();
    assert_eq!(view["detail"]["progress"]["failed"], 2);
    assert!(view["variants"].is_null());
    assert_eq!(view["rows"].as_array().unwrap().len(), 2);
    assert!(!view.to_string().contains("private-to-blind-view"));
    assert!(!view.to_string().contains("resume-undispatched"));
    call(
        &webview,
        "reveal_arena_identity",
        request(
            &context,
            json!({"comparisonId":prepared["attemptId"],"actionId":ExecutionId::new()}),
        ),
    )
    .unwrap();
    let revealed = read();
    assert_eq!(revealed["revealed"], true);
    assert_eq!(revealed["variants"].as_array().unwrap().len(), 2);
    assert_eq!(view["rows"], revealed["rows"]);
    let mut expected = before;
    expected[0] += 1;
    assert_eq!(counts(), expected);
}

#[test]
fn review_check_cancel_and_translation_save_do_not_block_the_command_loop() {
    let (_temp, app, _webview, context) = setup();
    let project_id: ExecutionId = serde_json::from_value(context["projectId"].clone()).unwrap();
    let session_token = context["sessionToken"].as_str().unwrap().to_owned();
    let action_id = ExecutionId::new();
    let state = app.state::<AppState>();
    let guard = state.sessions.pause();
    let mut check = Box::pin(review::run_fixture_review_checks(
        app.state::<AppState>(),
        review::ReviewCheckRequest {
            session_token: session_token.clone(),
            project_id,
            unit_id: ExecutionId::new(),
            locale: "zh-CN".into(),
            expected_basis: "stale-fixture".into(),
            action_id,
            advisory_checks: Vec::new(),
        },
    ));
    let mut poll_context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(matches!(
        std::future::Future::poll(check.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    assert_eq!(
        review::cancel_review_checks(
            app.state::<AppState>(),
            review::ReviewCancelCheckRequest {
                session_token,
                project_id,
                action_id,
            },
        )
        .unwrap(),
        true
    );
    assert!(
        state
            .review_check_cancellations
            .lock()
            .unwrap()
            .get(&action_id)
            .unwrap()
            .2
            .is_requested()
    );
    drop(guard);
    assert!(tauri::async_runtime::block_on(check).is_err());
    assert!(state.review_check_cancellations.lock().unwrap().is_empty());

    let guard = state.sessions.pause();
    let mut save = Box::pin(source::translation::save_translation_revision(
        app.state::<AppState>(),
        source::translation::TranslationSaveRequest {
            session_token: context["sessionToken"].as_str().unwrap().to_owned(),
            project_id,
            action_id: ExecutionId::new(),
            unit_id: ExecutionId::new(),
            locale: "zh-CN".into(),
            source_revision_id: ExecutionId::new(),
            expected_selection_id: None,
            text: "newer draft remains editable".into(),
        },
    ));
    assert!(matches!(
        std::future::Future::poll(save.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    drop(guard);
    assert!(tauri::async_runtime::block_on(save).is_err());
    let guard = state.sessions.pause();
    let mut merge = Box::pin(arena::save_arena_merge(
        app.state::<AppState>(),
        arena::MergeRequest {
            session_token: context["sessionToken"].as_str().unwrap().to_owned(),
            project_id,
            action_id: ExecutionId::new(),
            unit_id: ExecutionId::new(),
            locale: "zh-CN".into(),
            source_revision_id: ExecutionId::new(),
            expected_selection_id: None,
            text: "newer merge draft remains editable".into(),
            merge: tsumugi_core::MergeBasis {
                contributors: vec![ExecutionId::new(), ExecutionId::new()],
                expected_basis: "stale".into(),
            },
        },
    ));
    assert!(matches!(
        std::future::Future::poll(merge.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    drop(guard);
    assert!(tauri::async_runtime::block_on(merge).is_err());
}

#[test]
fn cancelled_review_and_accepted_translation_save_survive_close_and_reopen() {
    let (temp, app, webview, context) = setup();
    let state = app.state::<AppState>();
    let project_id: ExecutionId = serde_json::from_value(context["projectId"].clone()).unwrap();
    let session_token = context["sessionToken"].as_str().unwrap().to_owned();
    let unit = state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let bundle = tsumugi_core::content::SourceBundle::capture(
            br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
            br#"{"first":"Hello"}"#,
            "en-US",
        ).unwrap();
        let input = bundle.fixed_input(store.metadata().unwrap().project_id()).unwrap();
        host.runtime.submit(store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while host.active(store).unwrap() {
            host.tick(store).unwrap();
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        let result = store.execution_current_result(
            input.envelope().attempt_id, input.envelope().items[0].item_id,
        ).unwrap().unwrap();
        let preview = store.source_preview(input.envelope().attempt_id, result, 0, 1).unwrap();
        let action = store.prepare_adoption_with_id(
            ExecutionId::new(), input.envelope().attempt_id, input.envelope().units[0].unit_id,
            vec![result], serde_json::to_value(preview.confirmation).unwrap(),
        ).unwrap();
        store.adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler).unwrap();
        store.source_content(store.content_scope().unwrap().current_snapshot.unwrap(), 0, 1)
            .unwrap().rows.remove(0)
    });
    let first = call(
        &webview,
        "save_translation_revision",
        request(
            &context,
            json!({
                "actionId":ExecutionId::new(), "unitId":unit.unit_id, "locale":"zh-CN",
                "sourceRevisionId":unit.source_revision_id, "expectedSelectionId":null, "text":"Before QA"
            }),
        ),
    )
    .unwrap();
    let target = call(
        &webview,
        "read_review_target",
        request(
            &context,
            json!({
                "unitId":unit.unit_id, "locale":"zh-CN"
            }),
        ),
    )
    .unwrap();
    let action_id = ExecutionId::new();
    let save_action = ExecutionId::new();
    let held = state.sessions.pause();
    let mut poll_context = std::task::Context::from_waker(std::task::Waker::noop());
    let mut check = Box::pin(review::run_fixture_review_checks(app.state::<AppState>(),
        serde_json::from_value(request(&context, json!({
            "actionId":action_id, "unitId":unit.unit_id, "locale":"zh-CN", "expectedBasis":target["basis"], "advisoryChecks":[]
        }))).unwrap()));
    assert!(matches!(
        std::future::Future::poll(check.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    let save_request = request(
        &context,
        json!({
            "actionId":save_action, "unitId":unit.unit_id, "locale":"zh-CN",
            "sourceRevisionId":unit.source_revision_id, "expectedSelectionId":first["selection"]["eventId"], "text":"Accepted during QA"
        }),
    );
    let mut save = Box::pin(source::translation::save_translation_revision(
        app.state::<AppState>(),
        serde_json::from_value(save_request.clone()).unwrap(),
    ));
    assert!(matches!(
        std::future::Future::poll(save.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    let mut close = Box::pin(crate::commands::close_project(
        app.state::<AppState>(),
        CloseProjectRequest {
            session_token: session_token.clone(),
        },
    ));
    assert!(matches!(
        std::future::Future::poll(close.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    let mut reopen = Box::pin(crate::commands::open_project(
        app.state::<AppState>(),
        crate::commands::OpenProjectRequest {
            locator: temp.path().join("project").to_string_lossy().into_owned(),
        },
    ));
    assert!(matches!(
        std::future::Future::poll(reopen.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    let mut late_request = save_request.clone();
    late_request["actionId"] = json!(ExecutionId::new());
    late_request["text"] = json!("Must not reach reopened session");
    let mut late_save = Box::pin(source::translation::save_translation_revision(
        app.state::<AppState>(),
        serde_json::from_value(late_request).unwrap(),
    ));
    assert!(matches!(
        std::future::Future::poll(late_save.as_mut(), &mut poll_context),
        std::task::Poll::Pending
    ));
    assert!(
        review::cancel_review_checks(
            app.state::<AppState>(),
            review::ReviewCancelCheckRequest {
                session_token: session_token.clone(),
                project_id,
                action_id,
            }
        )
        .unwrap()
    );
    drop(held);
    let cancelled = tauri::async_runtime::block_on(check).unwrap();
    assert_eq!(
        cancelled.outcome,
        tsumugi_core::ReviewCheckOutcome::Cancelled
    );
    assert!(
        cancelled
            .rules
            .iter()
            .all(|rule| rule.status == "cancelled")
    );
    let saved = tauri::async_runtime::block_on(save).unwrap();
    assert!(tauri::async_runtime::block_on(close).unwrap().closed);
    let reopened = tauri::async_runtime::block_on(reopen).unwrap();
    assert_ne!(reopened.session_token, session_token);
    assert_eq!(
        tauri::async_runtime::block_on(late_save).unwrap_err().code,
        CommandErrorCode::SessionInvalid
    );
    assert!(state.review_check_cancellations.lock().unwrap().is_empty());
    let current = json!({"sessionToken":reopened.session_token, "projectId":project_id});
    let history = call(
        &webview,
        "read_translation_history",
        request(
            &current,
            json!({
                "unitId":unit.unit_id, "locale":"zh-CN", "afterOrdinal":"0", "limit":10
            }),
        ),
    )
    .unwrap();
    assert_eq!(history["total"], "2");
    assert_eq!(history["currentText"], "Accepted during QA");
    assert_eq!(
        history["current"]["eventId"],
        json!(saved.selection.event_id)
    );
    assert_eq!(
        call(
            &webview,
            "read_translation_action",
            request(
                &current,
                json!({
                    "unitId":unit.unit_id, "locale":"zh-CN", "actionId":save_action
                })
            )
        )
        .unwrap(),
        serde_json::to_value(&saved.selection).unwrap()
    );
    // A saved acknowledgement can be reconciled after close without duplicating its revision.
    assert_eq!(call(&webview, "save_translation_revision", request(&current, json!({
        "actionId":save_action, "unitId":unit.unit_id, "locale":"zh-CN",
        "sourceRevisionId":unit.source_revision_id, "expectedSelectionId":first["selection"]["eventId"], "text":"Accepted during QA"
    }))).unwrap(), serde_json::to_value(&saved).unwrap());
    assert_eq!(
        call(
            &webview,
            "read_translation_history",
            request(
                &current,
                json!({
                    "unitId":unit.unit_id, "locale":"zh-CN", "afterOrdinal":"0", "limit":10
                })
            )
        )
        .unwrap(),
        history
    );
    let reviews = call(
        &webview,
        "read_review_history",
        request(
            &current,
            json!({
                "unitId":unit.unit_id, "locale":"zh-CN", "offset":0, "limit":10
            }),
        ),
    )
    .unwrap();
    assert_eq!(reviews["checks"].as_array().unwrap().len(), 1);
    assert_eq!(reviews["checks"][0]["runId"], json!(cancelled.run_id));
    assert_eq!(reviews["checks"][0]["outcome"], "cancelled");
    call(
        &webview,
        "close_project",
        json!({"sessionToken":current["sessionToken"]}),
    )
    .unwrap();
}

fn request(context: &Value, extra: Value) -> Value {
    let mut request = context.clone();
    request
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    request
}
fn settled(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, context: &Value) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = match call(webview, "execution_status", context.clone()) {
            Err(e) if e["code"] == "busy" => {
                assert!(Instant::now() < deadline, "status remained busy");
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            result => result.unwrap(),
        };
        assert_eq!(status["error"], Value::Null, "{status}");
        if status["active"] == false {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "execution did not settle: {status}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn detail(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
    attempt: &Value,
) -> Value {
    call_when_ready(
        webview,
        "read_execution_attempt",
        request(context, json!({"attemptId":attempt,"offset":0,"limit":100})),
    )
    .unwrap()
}
#[test]
fn invoke_recovers_grouped_partial_work_and_receipt_survives_reopen() {
    let (temp, app, webview, context) = setup();
    let attempt = call(
        &webview,
        "seed_execution_fixture",
        request(
            &context,
            json!({"mode":"partial","delayMs":1,"grouped":true}),
        ),
    )
    .unwrap();
    settled(&webview, &context);
    let before = detail(&webview, &context, &attempt);
    assert_eq!(before["progress"]["succeeded"], 2);
    assert_eq!(before["progress"]["failed"], 1);
    let unit = &before["recovery"]["units"][0];
    for action in ["resume-undispatched", "retry-safe-failure"] {
        let anonymous = request(
            &context,
            json!({"attemptId":attempt,"unitId":unit["unitId"],"action":action,"itemIds":unit["remainingItemIds"]}),
        );
        let error = call(&webview, "recover_execution", anonymous).unwrap_err();
        assert_eq!(error["code"], "invalid-input");
        assert_eq!(error["stage"], "execution-recover");
        assert_eq!(error["reason"], "continuation-identity-required");
    }
    let task_view = call(
        &webview,
        "read_execution_task_view",
        request(&context, json!({"taskId":before["taskId"]})),
    )
    .unwrap();
    let stale_action = json!({"actionId":ExecutionId::new(),"projectId":context["projectId"],"sourceAttemptId":attempt,"unitId":unit["unitId"],"kind":"retry-safe-failure","itemIds":unit["remainingItemIds"],"expectedCancellationRevision":task_view["cancellationRevision"]});
    call(
        &webview,
        "cancel_execution_task",
        request(
            &context,
            json!({"taskId":before["taskId"],"requestId":ExecutionId::new()}),
        ),
    )
    .unwrap();
    for _ in 0..2 {
        assert_eq!(
            call(
                &webview,
                "continue_execution",
                request(&context, json!({"action":stale_action}))
            )
            .unwrap_err()["code"],
            "cancelled"
        );
        assert!(
            call(
                &webview,
                "read_execution_continuation",
                request(&context, json!({"actionId":stale_action["actionId"]}))
            )
            .unwrap()
            .is_null()
        );
    }
    let task_view = call(
        &webview,
        "read_execution_task_view",
        request(&context, json!({"taskId":before["taskId"]})),
    )
    .unwrap();
    let original_action = json!({"actionId":ExecutionId::new(),"projectId":context["projectId"],"sourceAttemptId":attempt,"unitId":unit["unitId"],"kind":"retry-safe-failure","itemIds":unit["remainingItemIds"],"expectedCancellationRevision":task_view["cancellationRevision"]});
    let continuation = request(&context, json!({"action":original_action}));
    let mut malformed = continuation.clone();
    malformed["action"]["extra"] = json!(true);
    assert!(call(&webview, "continue_execution", malformed).is_err());
    let mut cross_project = continuation.clone();
    cross_project["action"]["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&webview, "continue_execution", cross_project).unwrap_err()["code"],
        "permission-denied"
    );
    let mut wrong_session = continuation.clone();
    wrong_session["sessionToken"] = json!("stale-session");
    assert_eq!(
        call(&webview, "continue_execution", wrong_session).unwrap_err()["code"],
        "session-invalid"
    );
    let resumed = call(&webview, "continue_execution", continuation.clone()).unwrap();
    assert_eq!(
        call(&webview, "continue_execution", continuation.clone()).unwrap(),
        resumed
    );
    assert_eq!(resumed["action"], original_action);
    let lookup = request(&context, json!({"actionId":original_action["actionId"]}));
    assert_eq!(
        call(&webview, "read_execution_continuation", lookup).unwrap(),
        resumed
    );
    let page = call(
        &webview,
        "read_execution_continuations",
        request(
            &context,
            json!({"sourceAttemptId":attempt,"after":"0","limit":1}),
        ),
    )
    .unwrap();
    assert_eq!(page["receipts"], json!([resumed]));
    assert_eq!(page["next"], resumed["sequence"]);
    let end = call(
        &webview,
        "read_execution_continuations",
        request(
            &context,
            json!({"sourceAttemptId":attempt,"after":page["next"],"limit":1}),
        ),
    )
    .unwrap();
    assert_eq!(end, json!({"receipts":[],"next":null}));
    let mut different = continuation.clone();
    different["action"]["kind"] = json!("resume-undispatched");
    assert_eq!(
        call(&webview, "continue_execution", different).unwrap_err()["code"],
        "result-mismatch"
    );
    settled(&webview, &context);
    let after = detail(&webview, &context, &resumed["attemptId"]);
    assert_eq!(after["progress"]["succeeded"], 3);
    assert_eq!(after["progress"]["adopted"], 0);
    let unit = &after["recovery"]["units"][0];
    let prepare = request(
        &context,
        json!({"attemptId":resumed["attemptId"],"unitId":unit["unitId"],"actionId":ExecutionId::new(),"resultIds":unit["resultIds"]}),
    );
    assert_eq!(call(&webview, "read_execution_adoption_action", prepare.clone()).unwrap(), Value::Null);
    let first = call(&webview, "prepare_execution_adoption", prepare.clone()).unwrap();
    assert_eq!(call(&webview, "read_execution_adoption_action", prepare.clone()).unwrap(), json!({"action":first,"receipt":null}));
    call(
        &webview,
        "cancel_execution_task",
        request(
            &context,
            json!({"taskId":after["taskId"],"requestId":ExecutionId::new()}),
        ),
    )
    .unwrap();
    assert_eq!(
        call(&webview, "continue_execution", continuation.clone()).unwrap(),
        resumed
    );
    assert_eq!(
        call(&webview, "prepare_execution_adoption", prepare.clone()).unwrap(),
        first
    );
    let apply = request(&context, json!({"actionId":first["actionId"]}));
    assert_eq!(
        call(&webview, "adopt_execution", apply).unwrap_err()["code"],
        "cancelled"
    );
    assert_eq!(call(&webview, "read_execution_adoption_action", prepare.clone()).unwrap(), json!({"action":first,"receipt":null}));
    let mut renewed = prepare;
    renewed["actionId"] = json!(ExecutionId::new());
    let action = call_when_ready(&webview, "prepare_execution_adoption", renewed.clone()).unwrap();
    let apply = request(&context, json!({"actionId":action["actionId"]}));
    let receipt = call_when_ready(&webview, "adopt_execution", apply.clone()).unwrap();
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 3);
    let expected_read = json!({"action":action,"receipt":receipt});
    assert_eq!(call(&webview, "read_execution_adoption_action", renewed.clone()).unwrap(), expected_read);
    for field in ["projectId", "attemptId", "unitId", "sessionToken"] {
        let mut wrong = renewed.clone(); wrong[field] = json!(ExecutionId::new());
        assert!(call(&webview, "read_execution_adoption_action", wrong).is_err());
    }
    let mut wrong = renewed.clone(); wrong["resultIds"] = json!([ExecutionId::new()]);
    assert!(call(&webview, "read_execution_adoption_action", wrong).is_err());
    app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_mut().unwrap().execution_parts().unwrap().0.quiescing = true;
    });
    let before_read = app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()).sequence);
    assert_eq!(call(&webview, "read_execution_adoption_action", renewed.clone()).unwrap(), expected_read);
    assert_eq!(app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()).sequence), before_read);
    app.state::<AppState>().sessions.with(|sessions| { sessions.active.as_mut().unwrap().execution_parts().unwrap().0.quiescing = false; });
    assert_eq!(
        call_when_ready(&webview, "adopt_execution", apply).unwrap(),
        receipt
    );
    call(
        &webview,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let opened = call(
        &webview,
        "open_project",
        json!({"locator":temp.path().join("project")}),
    )
    .unwrap();
    assert_eq!(
        call(&webview, "execution_status", context.clone()).unwrap_err()["code"],
        "session-invalid"
    );
    let context =
        json!({"sessionToken":opened["sessionToken"],"projectId":opened["metadata"]["projectId"]});
    assert!(call(&webview, "read_execution_adoption_action", renewed.clone()).is_err());
    renewed["sessionToken"] = opened["sessionToken"].clone();
    assert_eq!(call(&webview, "read_execution_adoption_action", renewed).unwrap(), expected_read);
    assert_eq!(
        call(
            &webview,
            "continue_execution",
            request(&context, json!({"action":original_action}))
        )
        .unwrap(),
        resumed
    );
    assert_eq!(
        call(
            &webview,
            "read_execution_continuation",
            request(&context, json!({"actionId":original_action["actionId"]}))
        )
        .unwrap(),
        resumed
    );
    assert_eq!(
        call(
            &webview,
            "read_execution_receipt",
            request(&context, json!({"actionId":action["actionId"]}))
        )
        .unwrap(),
        receipt
    );
    assert_eq!(
        detail(&webview, &context, &resumed["attemptId"])["progress"]["adopted"],
        3
    );
    let connection =
        rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM fixture_targets WHERE revision=2 AND value='Updated sample'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        3
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM execution_results", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        4
    );
}

#[test]
fn invoke_continuation_history_reads_and_exact_replay_preserve_reopened_execution_inactivity() {
    let (temp, app, webview, context) = setup();
    let attempt = call(
        &webview,
        "seed_execution_fixture",
        request(
            &context,
            json!({"mode":"partial","delayMs":1,"grouped":true}),
        ),
    )
    .unwrap();
    settled(&webview, &context);
    let before = detail(&webview, &context, &attempt);
    let task_id = before["taskId"].clone();
    let unit = &before["recovery"]["units"][0];
    let task = call(
        &webview,
        "read_execution_task_view",
        request(&context, json!({"taskId":task_id})),
    )
    .unwrap();
    assert_eq!(task["cancellationRevision"], "0");
    let action = json!({"actionId":ExecutionId::new(),"projectId":context["projectId"],"sourceAttemptId":attempt,
        "unitId":unit["unitId"],"kind":"retry-safe-failure","itemIds":unit["remainingItemIds"],"expectedCancellationRevision":"0"});
    let saved = call(
        &webview,
        "continue_execution",
        request(&context, json!({"action":action})),
    )
    .unwrap();
    settled(&webview, &context);
    call(
        &webview,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let opened = call(
        &webview,
        "open_project",
        json!({"locator":temp.path().join("project")}),
    )
    .unwrap();
    let reopened =
        json!({"sessionToken":opened["sessionToken"],"projectId":opened["metadata"]["projectId"]});
    let attempts_request = request(&reopened, json!({"taskId":task_id,"after":"0","limit":100}));
    let attempts = call(&webview, "read_execution_task", attempts_request.clone()).unwrap();
    app.state::<AppState>()
        .sessions
        .with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    let exact = request(&reopened, json!({"actionId":action["actionId"]}));
    let history = request(
        &reopened,
        json!({"sourceAttemptId":attempt,"after":"0","limit":1}),
    );
    assert_eq!(
        call(&webview, "read_execution_continuation", exact.clone()).unwrap(),
        saved
    );
    assert_eq!(
        call(&webview, "read_execution_continuations", history.clone()).unwrap(),
        json!({"receipts":[saved],"next":saved["sequence"]})
    );
    assert_eq!(
        call(
            &webview,
            "continue_execution",
            request(&reopened, json!({"action":action}))
        )
        .unwrap(),
        saved
    );
    assert!(
        call(
            &webview,
            "read_execution_continuation",
            request(&reopened, json!({"actionId":ExecutionId::new()}))
        )
        .unwrap()
        .is_null()
    );
    assert_eq!(
        call(
            &webview,
            "read_execution_task_view",
            request(&reopened, json!({"taskId":task_id}))
        )
        .unwrap(),
        task
    );
    for (command, valid) in [
        ("read_execution_continuation", exact),
        ("read_execution_continuations", history),
        (
            "read_execution_task_view",
            request(&reopened, json!({"taskId":task_id})),
        ),
    ] {
        let mut wrong_session = valid.clone();
        wrong_session["sessionToken"] = context["sessionToken"].clone();
        assert_eq!(
            call(&webview, command, wrong_session).unwrap_err()["code"],
            "session-invalid"
        );
        let mut wrong_project = valid;
        wrong_project["projectId"] = json!(ExecutionId::new());
        assert_eq!(
            call(&webview, command, wrong_project).unwrap_err()["code"],
            "session-invalid"
        );
    }
    assert_eq!(
        call(&webview, "read_execution_task", attempts_request).unwrap(),
        attempts
    );
    app.state::<AppState>()
        .sessions
        .with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
}

#[test]
fn continuation_replay_uses_read_authority_before_the_host_mutation_gate() {
    let (_temp, app, webview, context) = setup();
    let attempt = call(
        &webview,
        "seed_execution_fixture",
        request(
            &context,
            json!({"mode":"partial","delayMs":1,"grouped":true}),
        ),
    )
    .unwrap();
    settled(&webview, &context);
    let before = detail(&webview, &context, &attempt);
    let unit = &before["recovery"]["units"][0];
    let task = call(
        &webview,
        "read_execution_task_view",
        request(&context, json!({"taskId":before["taskId"]})),
    )
    .unwrap();
    let action = json!({"actionId":ExecutionId::new(),"projectId":context["projectId"],"sourceAttemptId":attempt,
        "unitId":unit["unitId"],"kind":"retry-safe-failure","itemIds":unit["remainingItemIds"],"expectedCancellationRevision":task["cancellationRevision"]});
    let original = request(&context, json!({"action":action}));
    let saved = call(&webview, "continue_execution", original.clone()).unwrap();
    settled(&webview, &context);
    app.state::<AppState>().sessions.with(|sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.quiescing = true;
    });
    assert_eq!(
        call(&webview, "continue_execution", original.clone()).unwrap(),
        saved
    );
    assert_eq!(
        call(
            &webview,
            "read_execution_continuation",
            request(&context, json!({"actionId":action["actionId"]}))
        )
        .unwrap(),
        saved
    );
    let mut changed = original.clone();
    changed["action"]["expectedCancellationRevision"] = json!("9223372036854775807");
    assert_eq!(
        call(&webview, "continue_execution", changed).unwrap_err()["code"],
        "result-mismatch"
    );
    let fresh_id = ExecutionId::new();
    let mut fresh = original;
    fresh["action"]["actionId"] = json!(fresh_id);
    assert_eq!(
        call(&webview, "continue_execution", fresh).unwrap_err()["code"],
        "busy"
    );
    assert!(
        call(
            &webview,
            "read_execution_continuation",
            request(&context, json!({"actionId":fresh_id}))
        )
        .unwrap()
        .is_null()
    );
    app.state::<AppState>().sessions.with(|sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.quiescing = false;
    });
}

#[test]
fn invoke_unknown_query_and_active_session_lifecycle_are_guarded() {
    let (temp, _app, webview, context) = setup();
    let attempt = call(
        &webview,
        "seed_execution_fixture",
        request(
            &context,
            json!({"mode":"unknown","delayMs":1,"grouped":false}),
        ),
    )
    .unwrap();
    settled(&webview, &context);
    let view = detail(&webview, &context, &attempt);
    assert_eq!(view["progress"]["unknown"], 3);
    for unit in view["recovery"]["units"].as_array().unwrap() {
        call(&webview,"recover_execution",request(&context,json!({"attemptId":attempt,"unitId":unit["unitId"],"action":"query-outcome","itemIds":unit["remainingItemIds"]}))).unwrap();
        settled(&webview, &context);
    }
    assert_eq!(
        detail(&webview, &context, &attempt)["progress"]["succeeded"],
        3
    );
    let held = call(
        &webview,
        "seed_execution_fixture",
        request(&context, json!({"mode":"hold","delayMs":1,"grouped":false})),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while detail(&webview, &context, &held)["progress"]["running"] == 0 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        call(
            &webview,
            "close_project",
            json!({"sessionToken":context["sessionToken"]})
        )
        .unwrap_err()["code"],
        "busy"
    );
    assert_eq!(call(&webview,"rename_project",json!({"sessionToken":context["sessionToken"],"expectedRevision":"1","displayName":"Moved","directoryName":"moved"})).unwrap_err()["code"],"busy");
    let deadline = Instant::now() + Duration::from_secs(7);
    while call(&webview, "quiesce_execution", context.clone()).unwrap()["quiescing"] == true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        call(
            &webview,
            "open_project",
            json!({"locator":temp.path().join("missing")})
        )
        .is_err()
    );
    assert_eq!(
        call(&webview, "execution_status", context.clone()).unwrap()["active"],
        false
    );
    let view = detail(&webview, &context, &held);
    assert_eq!(view["progress"]["unknown"], 1);
    assert_eq!(view["progress"]["cancelled"], 2);
    let mut wrong = context.clone();
    wrong["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&webview, "execution_status", wrong).unwrap_err()["code"],
        "session-invalid"
    );
    let database = rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    let before: i64 = database
        .query_row("SELECT COUNT(*) FROM execution_cancellations", [], |r| {
            r.get(0)
        })
        .unwrap();
    let mut wrong = request(
        &context,
        json!({"taskId":view["taskId"],"requestId":ExecutionId::new()}),
    );
    wrong["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&webview, "cancel_execution_task", wrong).unwrap_err()["code"],
        "session-invalid"
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM execution_cancellations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    drop(database);
    call(
        &webview,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
}

#[test]
fn review_computation_allows_save_close_and_completion_after_waiter_loss() {
    for scenario in ["save", "reopen", "drop"] {
        let (temp, app, webview, context) = setup();
        let state = app.state::<AppState>();
        let project_id: ExecutionId = serde_json::from_value(context["projectId"].clone()).unwrap();
        let session_token = context["sessionToken"].as_str().unwrap().to_owned();
        let unit = state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let bundle = tsumugi_core::content::SourceBundle::capture(
            br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
            br#"{"first":"Hello"}"#,
            "en-US",
        ).unwrap();
        let input = bundle.fixed_input(store.metadata().unwrap().project_id()).unwrap();
        host.runtime.submit(store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while host.active(store).unwrap() {
            host.tick(store).unwrap();
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        let result = store.execution_current_result(
            input.envelope().attempt_id, input.envelope().items[0].item_id,
        ).unwrap().unwrap();
        let preview = store.source_preview(input.envelope().attempt_id, result, 0, 1).unwrap();
        let action = store.prepare_adoption_with_id(
            ExecutionId::new(), input.envelope().attempt_id, input.envelope().units[0].unit_id,
            vec![result], serde_json::to_value(preview.confirmation).unwrap(),
        ).unwrap();
        store.adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler).unwrap();
        store.source_content(store.content_scope().unwrap().current_snapshot.unwrap(), 0, 1)
            .unwrap().rows.remove(0)
    });

        let target = call(
            &webview,
            "read_review_target",
            request(&context, json!({"unitId":unit.unit_id,"locale":"zh-CN"})),
        )
        .unwrap();
        let action_id = ExecutionId::new();
        let (reached, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        *state.review_compute_probe.lock().unwrap() = Some(review::ComputeProbe {
            action: action_id,
            reached,
            release: resume,
        });
        let mut pending = Box::pin(review::run_fixture_review_checks(
            app.state::<AppState>(),
            serde_json::from_value(request(
                &context,
                json!({"unitId":unit.unit_id,"locale":"zh-CN",
                "expectedBasis":target["basis"],"actionId":action_id,"advisoryChecks":[]}),
            ))
            .unwrap(),
        ));
        let mut poll_context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(matches!(
            std::future::Future::poll(pending.as_mut(), &mut poll_context),
            std::task::Poll::Pending
        ));
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        // These operations complete while computation is deliberately suspended.
        let mut current_context = context.clone();
        if scenario == "save" {
            call(&webview, "save_translation_revision", request(&context, json!({
                "actionId":ExecutionId::new(),"unitId":unit.unit_id,"locale":"zh-CN",
                "sourceRevisionId":unit.source_revision_id,"expectedSelectionId":null,"text":"New human work"
            }))).unwrap();
        } else if scenario == "reopen" {
            assert!(
                tauri::async_runtime::block_on(crate::commands::close_project(
                    app.state::<AppState>(),
                    CloseProjectRequest {
                        session_token: session_token.clone()
                    }
                ))
                .unwrap()
                .closed
            );
            let reopened = tauri::async_runtime::block_on(crate::commands::open_project(
                app.state::<AppState>(),
                crate::commands::OpenProjectRequest {
                    locator: temp.path().join("project").to_string_lossy().into_owned(),
                },
            ))
            .unwrap();
            assert_ne!(session_token, reopened.session_token);
            current_context = json!({"sessionToken":reopened.session_token,"projectId":project_id});
        }
        if scenario == "drop" {
            drop(pending);
            release.send(()).unwrap();
        } else {
            release.send(()).unwrap();
            let error = tauri::async_runtime::block_on(pending).unwrap_err();
            if scenario == "save" {
                assert_eq!(error.reason.as_deref(), Some("review-current"));
            } else {
                assert_eq!(error.code, CommandErrorCode::SessionInvalid);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !state.review_check_cancellations.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        let current = call(
            &webview,
            "read_review_target",
            request(
                &current_context,
                json!({"unitId":unit.unit_id,"locale":"zh-CN"}),
            ),
        )
        .unwrap();
        if scenario == "drop" {
            assert_eq!(current["currentCheck"]["actionId"], json!(action_id));
        } else {
            assert!(current["currentCheck"].is_null());
        }
        if scenario == "save" {
            assert_eq!(current["translationText"], "New human work");
        }
    }
}
