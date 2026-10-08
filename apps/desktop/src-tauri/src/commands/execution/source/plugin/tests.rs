use super::*;
use serde_json::{Value, json};

#[test]
fn source_workflow_wire_binds_each_consent_to_a_fixed_attempt() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/pluginSourceWorkflow.contract.json"
    ))
    .unwrap();
    fn round<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round::<PluginSourceSelectRequest>(&fixture["select"]);
    round::<PluginSourceSelection>(&fixture["selection"]);
    round::<PluginCaptureRequest>(&fixture["capture"]);
    round::<PluginSourcePreflight>(&fixture["preflight"]);
    round::<PluginStartRequest>(&fixture["start"]);
    round::<SourceCheckPrepareRequest>(&fixture["prepareCheck"]);
    round::<SourceCheckReview>(&fixture["checkReview"]);
    round::<SourceCheckFinishRequest>(&fixture["finishCheck"]);
    for property in ["directory", "environment", "approved", "renewGrant"] {
        let mut forged = fixture["start"].clone();
        forged[property] = json!(true);
        assert!(serde_json::from_value::<PluginStartRequest>(forged).is_err());
    }
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn real_source_ipc_requires_two_grants_and_commits_only_checked_captured_bytes() {
    use std::{
        fs,
        future::Future,
        path::PathBuf,
        task::{Context, Poll, Waker},
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    use tsumugi_plugin_host::{
        ApprovedPackageSetting, CapturedRuntime, PackageImage, PackageStore, PluginSettingsUpdate,
        RuntimeApproval,
        catalog::{PackageApproval, PackageCatalog, PackageOrigin},
    };
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
    fn result(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        context: &Value,
        attempt: &Value,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let mut read = context.clone();
            read["attemptId"] = attempt.clone();
            read["offset"] = json!(0);
            read["limit"] = json!(100);
            let detail = call(window, "read_execution_attempt", read).unwrap();
            if detail["items"][0]["status"]["execution"] == "succeeded" {
                return detail["items"][0]["resultId"].clone();
            }
            assert!(
                Instant::now() < deadline,
                "actual worker did not complete: {detail}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn consent(context: &Value, checker: &Value) -> Value {
        let mut request = context.clone();
        request["attemptId"] = checker["attemptId"].clone();
        request["inputDigest"] = checker["inputDigest"].clone();
        request["grantId"] = json!(ExecutionId::new());
        request["unsandboxedExecution"] = json!(true);
        request["expiresAtMs"] = json!(
            (SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                + 600_000)
                .to_string()
        );
        request
    }
    fn consents(context: &Value, view: &Value) -> Vec<Value> {
        view["checkers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|checker| consent(context, checker))
            .collect()
    }
    let temporary = tempfile::tempdir().unwrap();
    // All package/runtime inputs are explicit artifacts. The fixture has no
    // private checkout dependency, network, user project or paid model call.
    let selected = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
            .expect("explicit independent package required"),
    );
    let digest =
        std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST").expect("explicit package digest required");
    let image = PackageImage::capture_directory(&selected, &digest, || true).unwrap();
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "synthetic-manual-source".into(),
            publisher_id: "synthetic-manual-publisher".into(),
        },
    };
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/javascript-runtime");
    let inspection: Value =
        serde_json::from_slice(&fs::read(resources.join("inspection.json")).unwrap()).unwrap();
    let descriptor = serde_json::from_value(inspection["environment"].clone()).unwrap();
    let runtime = CapturedRuntime::capture_directories(
        &resources.join("tool"),
        &resources.join("host"),
        &descriptor,
        || true,
    )
    .unwrap();
    let runtime_approval = RuntimeApproval {
        environment: descriptor.into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    let mut installation =
        PackageStore::provision(temporary.path(), &["application", "plugins"], || true).unwrap();
    installation
        .install(
            &ExecutionId::new().to_string(),
            catalog.registered(&approval.plugin).unwrap(),
            || true,
        )
        .unwrap();
    installation
        .install_runtime(
            &ExecutionId::new().to_string(),
            &runtime,
            &runtime_approval,
            || true,
        )
        .unwrap();
    installation
        .update_settings(
            0,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: vec![ApprovedPackageSetting {
                    approval: approval.clone(),
                    enabled: true,
                }],
                runtimes: vec![runtime_approval.clone()],
            },
            || true,
        )
        .unwrap();
    drop(installation);
    drop(runtime);
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    state
        .plugins
        .configure(temporary.path().join("application"))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(&window, "create_project", json!({"destination":temporary.path().join("project"),"displayName":"Independent source fixture","sourceLocale":"en-US","targetLocales":["zh-CN"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let source_choice = PluginSourceRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: approval.plugin.clone(),
            package_digest: approval.package_digest.clone(),
        },
        resource_id: "source-profile".into(),
        environment_digest: runtime_approval.environment.digest().unwrap(),
    };
    let source = temporary.path().join("captions");
    fs::create_dir(&source).unwrap();
    let original = "WEBVTT\n\nCue\n00:00:01.000 --> 00:00:02.000\nCaptured 👩🏽‍💻\n\n";
    fs::write(source.join("source.vtt"), original).unwrap();
    let selection = ExecutionId::new();
    let fixed_choice = source_choice.clone();
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
            Arc::new(capture::Selection::authorize(source).unwrap()),
        ));
        host.source.plugin.choice = Some((selection, fixed_choice));
    });
    let mut capture_request = context.clone();
    capture_request["selectionId"] = json!(selection);
    capture_request["sourceLanguage"] = json!("en-US");
    capture_request["attemptId"] = json!(ExecutionId::new());
    // Drop the invoking future after admission. Its accepted continuation must
    // finish and retain the same review rather than strand SourceSession.job.
    let typed = serde_json::from_value(capture_request.clone()).unwrap();
    let mut waiting = Box::pin(preflight_plugin_source(app.state(), typed));
    assert!(matches!(
        waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(waiting);
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if state.sessions.with(|sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution_parts()
                .unwrap()
                .0
                .source
                .plugin
                .review
                .is_some()
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "accepted native capture lost its completion"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let preflight = call(&window, "preflight_plugin_source", capture_request.clone()).unwrap();
    assert_eq!(
        call(&window, "preflight_plugin_source", capture_request).unwrap(),
        preflight
    );
    assert_eq!(preflight["files"][0]["byteLength"], original.len());
    assert!(
        !temporary
            .path()
            .join("application")
            .read_dir()
            .unwrap()
            .any(|child| child
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("plugin-instance-"))
    );
    fs::write(
        temporary.path().join("captions/source.vtt"),
        "Changed after fixed review",
    )
    .unwrap();
    for command in ["preflight_source", "start_source_import"] {
        let error = call(&window, command, json!({})).unwrap_err();
        assert!(
            error
                .as_str()
                .is_some_and(|text| text.contains("not found")),
            "legacy source command was registered: {error}"
        );
    }
    // Installation approval does not grant execution. Disabling the exact
    // installed package after capture must reject a new producer dispatch.
    let disabled = call(&window, "set_plugin_enabled", json!({"package":source_choice.package,"enabled":false,"expectedRevision":"1","actionId":ExecutionId::new()})).unwrap();
    let start_request = consent(&context, &preflight);
    assert!(call(&window, "start_plugin_source", start_request.clone()).is_err());
    call(&window, "set_plugin_enabled", json!({"package":source_choice.package,"enabled":true,"expectedRevision":disabled["settingsRevision"],"actionId":ExecutionId::new()})).unwrap();
    let mut expired = start_request.clone();
    expired["expiresAtMs"] = json!("1");
    assert!(call(&window, "start_plugin_source", expired).is_err());
    let mut rejected = start_request.clone();
    rejected["unsandboxedExecution"] = json!(false);
    assert!(call(&window, "start_plugin_source", rejected).is_err());
    let mut substituted = start_request.clone();
    substituted["inputDigest"] = json!("f".repeat(64));
    assert!(call(&window, "start_plugin_source", substituted).is_err());
    let started = call(&window, "start_plugin_source", start_request.clone()).unwrap();
    assert_eq!(
        call(&window, "start_plugin_source", start_request).unwrap(),
        started
    );
    let source_result = result(&window, &context, &started);
    let mut preview_request = context.clone();
    preview_request["attemptId"] = started.clone();
    preview_request["resultId"] = source_result.clone();
    preview_request["after"] = json!(0);
    preview_request["limit"] = json!(50);
    let preview = call(&window, "read_source_preview", preview_request).unwrap();
    assert_eq!(preview["rows"][0]["occurrence"]["text"], "Captured 👩🏽‍💻");
    let mut adoption = context.clone();
    adoption["attemptId"] = started.clone();
    adoption["resultId"] = source_result.clone();
    adoption["actionId"] = json!(ExecutionId::new());
    adoption["confirmation"] = preview["confirmation"].clone();
    // A proposal is readable while pending, but cannot be adopted.
    call(&window, "prepare_source_adoption", adoption.clone()).unwrap();
    assert!(call(&window, "adopt_execution", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":adoption["actionId"]})).is_err());
    let mut check_prepare = context.clone();
    check_prepare["sourceAttemptId"] = started;
    check_prepare["sourceResultId"] = source_result;
    check_prepare["attemptId"] = json!(ExecutionId::new());
    check_prepare["source"] = serde_json::to_value(source_choice).unwrap();
    let mut reused = check_prepare.clone();
    reused["attemptId"] = preflight["attemptId"].clone();
    assert!(call(&window, "prepare_source_check", reused).is_err());
    let mut wrong_environment = check_prepare.clone();
    wrong_environment["source"]["environmentDigest"] = json!("f".repeat(64));
    assert!(call(&window, "prepare_source_check", wrong_environment).is_err());
    let check_review = call(&window, "prepare_source_check", check_prepare.clone()).unwrap();
    assert_eq!(
        call(&window, "prepare_source_check", check_prepare).unwrap(),
        check_review
    );
    let check_request = consent(&context, &check_review);
    let mut missing = check_request.clone();
    missing["unsandboxedExecution"] = json!(false);
    assert!(call(&window, "start_source_check", missing).is_err());
    let checked = call(&window, "start_source_check", check_request).unwrap();
    let check_result = result(&window, &context, &checked);
    let finish = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":checked,"resultId":check_result});
    call(&window, "finish_source_check", finish.clone()).unwrap();
    call(&window, "finish_source_check", finish).unwrap();
    adoption["actionId"] = json!(ExecutionId::new());
    call(&window, "prepare_source_adoption", adoption.clone()).unwrap();
    let action = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":adoption["actionId"]});
    let receipt = call(&window, "adopt_execution", action.clone()).unwrap();
    assert_eq!(call(&window, "adopt_execution", action).unwrap(), receipt);
    assert!(
        call(&window, "read_content_scope", context.clone()).unwrap()["currentSnapshot"]
            .is_string()
    );
    // Review executes the separately consented adopted checker through the
    // production command handler, with the original Core/domain policy union.
    let page = call(&window, "read_review_page", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"locale":"zh-CN","afterOrdinal":0,"limit":50})).unwrap();
    let unit = page["rows"][0]["unitId"].clone();
    let target_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"unitId":unit,"locale":"zh-CN"});
    let target = call(&window, "read_review_target", target_request.clone()).unwrap();
    let intent = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"unitId":unit,"locale":"zh-CN","expectedBasis":target["basis"],"actionId":ExecutionId::new(),"advisoryChecks":[]});
    let review = call(&window, "prepare_review_checks", intent.clone()).unwrap();
    assert_eq!(review["kind"], "plugin");
    assert_eq!(
        call(&window, "prepare_review_checks", intent.clone()).unwrap(),
        review
    );
    let review_start = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"check":intent,"executions":consents(&context, &review["view"])});
    let mut denied = review_start.clone();
    denied["executions"][0]["unsandboxedExecution"] = json!(false);
    assert_eq!(
        call(&window, "run_review_checks", denied).unwrap_err()["code"],
        "permission-denied"
    );
    let mut substituted = review_start.clone();
    substituted["executions"][0]["inputDigest"] = json!("f".repeat(64));
    assert!(call(&window, "run_review_checks", substituted).is_err());
    let mut expired = review_start.clone();
    expired["executions"][0]["expiresAtMs"] = json!("1");
    let expired_error = call(&window, "run_review_checks", expired).unwrap_err();
    assert_eq!(expired_error["code"], "invalid-input");
    assert_eq!(expired_error["reason"], "plugin-grant-expiry");
    app.state::<AppState>().sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(
            !host.active(store).unwrap(),
            "invalid consent must not retain active work"
        );
    });
    assert!(
        call(&window, "read_review_target", target_request.clone()).unwrap()["currentCheck"]
            .is_null()
    );
    // Accepted work survives the webview waiter, as source preparation does.
    let mut pending_review = Box::pin(
        crate::commands::execution::review::plugin::run_review_checks(
            app.state(),
            serde_json::from_value(review_start.clone()).unwrap(),
        ),
    );
    assert!(matches!(
        pending_review
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(pending_review);
    let deadline = Instant::now() + Duration::from_secs(30);
    let checked = loop {
        let current = call(&window, "read_review_target", target_request.clone()).unwrap();
        if !current["currentCheck"].is_null() {
            break current["currentCheck"].clone();
        }
        assert!(
            Instant::now() < deadline,
            "accepted Review continuation lost its result"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(checked["actionId"], intent["actionId"]);
    assert_eq!(checked["outcome"], "completed");
    assert!(
        !checked["evidence"]["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&window, "run_review_checks", review_start.clone()).unwrap(),
        checked
    );
    assert_eq!(
        call(&window, "prepare_review_checks", intent.clone()).unwrap(),
        json!({"kind":"recorded","run":checked})
    );
    // Cancellation during owned computation cannot replace the durable QA.
    let action = ExecutionId::new();
    let mut cancellation_intent = intent.clone();
    cancellation_intent["actionId"] = json!(action);
    let next = call(
        &window,
        "prepare_review_checks",
        cancellation_intent.clone(),
    )
    .unwrap();
    let cancellation_start = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"check":cancellation_intent,"executions":consents(&context, &next["view"])});
    let (reached, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    *state.review_compute_probe.lock().unwrap() =
        Some(crate::commands::execution::review::ComputeProbe {
            action,
            reached,
            release: resume,
        });
    let mut cancelled_review = Box::pin(
        crate::commands::execution::review::plugin::run_review_checks(
            app.state(),
            serde_json::from_value(cancellation_start.clone()).unwrap(),
        ),
    );
    assert!(matches!(
        cancelled_review
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    waiting.recv_timeout(Duration::from_secs(60)).unwrap();
    assert_eq!(call(&window, "cancel_review_checks", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":action})).unwrap(), json!(true));
    assert_eq!(
        call(&window, "run_review_checks", cancellation_start).unwrap_err()["outcome"],
        "unknown"
    );
    release.send(()).unwrap();
    let error = tauri::async_runtime::block_on(cancelled_review).unwrap_err();
    assert_eq!(error.code, CommandErrorCode::Cancelled);
    assert_eq!(
        call(&window, "read_review_target", target_request.clone()).unwrap()["currentCheck"],
        checked
    );
    // The project stays owned while pure computation is pending. Explicit stop
    // revokes it, drains the continuation and keeps the preceding durable check.
    let action = ExecutionId::new();
    let mut stop_intent = intent.clone();
    stop_intent["actionId"] = json!(action);
    let next = call(&window, "prepare_review_checks", stop_intent.clone()).unwrap();
    let stop_start = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"check":stop_intent,"executions":consents(&context, &next["view"])});
    let (reached, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    *state.review_compute_probe.lock().unwrap() =
        Some(crate::commands::execution::review::ComputeProbe {
            action,
            reached,
            release: resume,
        });
    let mut stopped = Box::pin(
        crate::commands::execution::review::plugin::run_review_checks(
            app.state(),
            serde_json::from_value(stop_start).unwrap(),
        ),
    );
    assert!(matches!(
        stopped
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    waiting.recv_timeout(Duration::from_secs(60)).unwrap();
    assert_eq!(
        call(
            &window,
            "close_project",
            json!({"sessionToken":context["sessionToken"]})
        )
        .unwrap_err()["code"],
        "busy"
    );
    call(&window, "quiesce_execution", context.clone()).unwrap();
    release.send(()).unwrap();
    assert!(tauri::async_runtime::block_on(stopped).is_err());
    let deadline = Instant::now() + Duration::from_secs(30);
    while call(&window, "execution_status", context.clone()).unwrap()["active"] == true {
        assert!(
            Instant::now() < deadline,
            "Review did not drain after project stop"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        call(&window, "read_review_target", target_request.clone()).unwrap()["currentCheck"],
        checked
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &window,
        "open_project",
        json!({"locator":temporary.path().join("project")}),
    )
    .unwrap();
    assert!(
        call(
            &window,
            "read_content_scope",
            json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]})
        )
        .unwrap()["currentSnapshot"]
            .is_string()
    );
    let mut reopened_intent = intent.clone();
    reopened_intent["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(&window, "prepare_review_checks", reopened_intent).unwrap(),
        json!({"kind":"recorded","run":checked})
    );
    // AI output is a controlled ledger fixture; the selected Review worker is
    // still the actual installed WebVTT package through the production commands.
    // No model request or external network is made by this acceptance path.
    fn candidate(state: &AppState, authorization: &Value, text: &str) {
        let action: ExecutionId =
            serde_json::from_value(authorization["actionId"].clone()).unwrap();
        let text = text.to_owned();
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let receipt = store.work_plan_receipt(action).unwrap().unwrap();
            let input = FixedInput::capture(receipt.input.unwrap()).unwrap();
            if let Some(parent) = receipt.parent_task {
                host.runtime.submit_child(store, &input, parent).unwrap();
            } else {
                host.runtime.submit(store, &input).unwrap();
            }
            let item = &input.envelope().items[0];
            let payload = tsumugi_core::ai::item_payload(&input, item.item_id).unwrap();
            let dispatch = store
                .dispatch_execution_item(input.envelope().attempt_id, item.item_id)
                .unwrap();
            let result = tsumugi_core::execution::FixedResult::capture(
                tsumugi_core::execution::ResultEnvelope {
                    plugin: None,
                    project_id: input.envelope().project_id,
                    attempt_id: input.envelope().attempt_id,
                    item_id: item.item_id,
                    result_id: ExecutionId::new(),
                    supersedes: None,
                    dispatch_token: dispatch.dispatch_token,
                    capability_id: tsumugi_core::ai::CAPABILITY.into(),
                    capability_version: "1".into(),
                    outcome: ExecutionState::Succeeded,
                    output: Some(
                        serde_json::to_value(tsumugi_core::ai::AiOutput {
                            unit_id: payload.unit_id,
                            target_locale: payload.target_locale,
                            text,
                            usage: None,
                            requests: 1,
                            usage_incomplete: true,
                        })
                        .unwrap(),
                    ),
                    diagnostic: None,
                },
                &input,
                dispatch.dispatch_token,
            )
            .unwrap();
            store.save_execution_result(&result).unwrap();
            store
                .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
                .unwrap();
        });
    }
    let context = json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]});
    let target_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"unitId":unit,"locale":"zh-CN"});
    let mut options = tsumugi_core::application::PlanOptions::default();
    options.selection_policy = tsumugi_core::application::SelectionPolicy::MissingOnly;
    options
        .stages
        .iter_mut()
        .find(|stage| stage.stage == tsumugi_core::application::WorkStage::Checks)
        .unwrap()
        .mode = tsumugi_core::application::StageMode::Assisted;
    let config = tsumugi_core::ai::AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-ledger-only".into(),
        credential_env: String::new(),
        ..Default::default()
    };
    let prepared_plan = call(&window, "prepare_work_plan", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"config":config,"locale":"zh-CN","unitIds":[unit],"options":options,"advisoryChecks":[]})).unwrap();
    assert_eq!(prepared_plan["checkers"][0]["kind"], "ready");
    let checker_key = prepared_plan["checkers"][0]["checker"].clone();
    assert_eq!(checker_key, review["view"]["checkers"][0]["checker"]);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let authorization = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":prepared_plan["planId"],"digest":prepared_plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":[checker_key],"effects":["save-candidate","run-checks","select-missing"],"expiresAt":(now+600).to_string()});
    let mut denied = authorization.clone();
    denied["checkerExecutions"] = json!([]);
    assert_eq!(
        call(&window, "authorize_work_plan", denied).unwrap_err()["code"],
        "permission-denied"
    );
    assert!(call(&window, "read_work_plan_action", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":authorization["actionId"]})).unwrap().is_null());
    let authorized_plan = call(&window, "authorize_work_plan", authorization.clone()).unwrap();
    candidate(&state, &authorized_plan, "已捕获 👩🏽‍💻");
    let start = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":prepared_plan["planId"],"actionId":authorization["actionId"],"expectedGeneration":authorized_plan["lease"]["generation"]});
    let typed = serde_json::from_value(start.clone()).unwrap();
    let mut lost = Box::pin(crate::commands::execution::work_plans::start_work_plan(
        app.state(),
        typed,
    ));
    assert!(matches!(
        lost.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(lost);
    let deadline = Instant::now() + Duration::from_secs(30);
    let selected = loop {
        let view = call(&window, "read_ai_translation", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":authorized_plan["attemptId"]})).unwrap();
        let effect = &view["rows"][0]["automation"];
        if effect["phase"] == "selected" {
            break effect["receipt"].clone();
        }
        assert!(
            !matches!(
                effect["phase"].as_str(),
                Some("failed" | "blocked" | "cancelled")
            ),
            "AI effect: {effect}"
        );
        assert!(
            Instant::now() < deadline,
            "actual AI Review checker did not finish: {view}"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(selected["evidence"].is_object());
    assert!(selected["checkRunId"].is_string());
    let saved_target = call(&window, "read_review_target", target_request.clone()).unwrap();
    assert!(saved_target["currentDecision"].is_null());
    assert_eq!(
        saved_target["currentCheck"]["runId"],
        selected["checkRunId"]
    );
    assert_eq!(
        call(&window, "start_work_plan", start).unwrap(),
        authorized_plan["attemptId"]
    );

    options.selection_policy = tsumugi_core::application::SelectionPolicy::ReplaceCapturedSelection;
    let replacement = call(&window, "prepare_work_plan", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"config":config,"locale":"zh-CN","unitIds":[unit],"options":options,"advisoryChecks":[]})).unwrap();
    let replacement_checker_key = replacement["checkers"][0]["checker"].clone();
    let replacement_auth = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":replacement["planId"],"digest":replacement["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":[replacement_checker_key],"effects":["save-candidate","run-checks","replace-captured-selection"],"expiresAt":(now+600).to_string()});
    let replacement_receipt = call(&window, "authorize_work_plan", replacement_auth).unwrap();
    let replacement_attempt: ExecutionId =
        serde_json::from_value(replacement_receipt["attemptId"].clone()).unwrap();
    let (reached, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .ai
            .pause_check_computation(crate::commands::execution::review::ComputeProbe {
                action: replacement_attempt,
                reached,
                release: resume,
            });
    });
    candidate(&state, &replacement_receipt, "新的译文 👩🏽‍💻");
    call(&window, "start_work_plan", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":replacement["planId"],"actionId":replacement_receipt["actionId"],"expectedGeneration":replacement_receipt["lease"]["generation"]})).unwrap();
    waiting.recv_timeout(Duration::from_secs(30)).unwrap();
    assert!(
        call(
            &window,
            "close_project",
            json!({"sessionToken":context["sessionToken"]})
        )
        .is_err()
    );
    let paused = call(&window, "control_work_plan", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":replacement["planId"],"actionId":ExecutionId::new(),"expectedGeneration":replacement_receipt["lease"]["generation"],"command":"pause","confirmed":false,"checkerExecutions":[],"expiresAt":null})).unwrap();
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while state.sessions.with(|sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .ai
            .active()
    }) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        call(&window, "read_review_target", target_request.clone()).unwrap(),
        saved_target
    );
    // A changed installed-settings revision invalidates cached preflight metadata.
    // Disabled checkers remain unavailable while history and paused authority survive.
    let set_enabled = |enabled, expected_revision| {
        tauri::async_runtime::block_on(crate::commands::plugins::packages::set_plugin_enabled(
            app.state(),
            crate::commands::plugins::PluginEnableRequest {
                package: crate::commands::plugins::PluginPackageRequest {
                    plugin: approval.plugin.clone(),
                    package_digest: approval.package_digest.clone(),
                },
                enabled,
                expected_revision,
                action_id: ExecutionId::new(),
            },
        ))
        .unwrap()
    };
    let disabled = set_enabled(
        false,
        serde_json::from_value(
            replacement["checkers"][0]["plugin"]["plugin"]["settingsRevision"].clone(),
        )
        .unwrap(),
    );
    let unavailable = call(&window, "read_work_plan_status", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":replacement["planId"]})).unwrap();
    assert_eq!(unavailable["plan"]["checkers"][0]["kind"], "unavailable");
    assert_eq!(unavailable["state"], "paused");
    assert_eq!(unavailable["lease"], paused["lease"]);
    let enabled = set_enabled(true, disabled.settings_revision);
    let available = call(&window, "read_work_plan_status", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":replacement["planId"]})).unwrap();
    assert_eq!(available["plan"]["checkers"][0]["kind"], "ready");
    assert_eq!(
        available["plan"]["checkers"][0]["plugin"]["plugin"]["settingsRevision"],
        enabled.settings_revision.get().to_string()
    );
    let continuation = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":replacement["planId"],"actionId":ExecutionId::new(),"expectedGeneration":paused["lease"]["generation"],"command":"continue","confirmed":true,"checkerExecutions":[replacement["checkers"][0]["checker"]],"expiresAt":(now+600).to_string()});
    let mut denied = continuation.clone();
    denied["checkerExecutions"] = json!([]);
    assert_eq!(
        call(&window, "control_work_plan", denied).unwrap_err()["code"],
        "permission-denied"
    );
    let continued = call(&window, "control_work_plan", continuation).unwrap();
    let continued_attempt: ExecutionId =
        serde_json::from_value(continued["attemptId"].clone()).unwrap();
    let (reached, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .ai
            .pause_check_computation(crate::commands::execution::review::ComputeProbe {
                action: continued_attempt,
                reached,
                release: resume,
            });
    });
    candidate(&state, &continued, "再次译文 👩🏽‍💻");
    call(&window, "start_work_plan", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"planId":replacement["planId"],"actionId":continued["actionId"],"expectedGeneration":continued["lease"]["generation"]})).unwrap();
    waiting.recv_timeout(Duration::from_secs(30)).unwrap();
    call(&window, "quiesce_execution", context.clone()).unwrap();
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while call(&window, "execution_status", context.clone()).unwrap()["active"] == true {
        assert!(
            Instant::now() < deadline,
            "AI computation did not drain on project stop"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        call(&window, "read_review_target", target_request.clone()).unwrap(),
        saved_target
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &window,
        "open_project",
        json!({"locator":temporary.path().join("project")}),
    )
    .unwrap();
    let historic = call(&window, "read_ai_translation", json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"],"attemptId":authorized_plan["attemptId"]})).unwrap();
    assert_eq!(historic["rows"][0]["automation"]["receipt"], selected);
    let mut original_authorization = authorization.clone();
    original_authorization["sessionToken"] = reopened["sessionToken"].clone();
    let mut wrong_plan = original_authorization.clone();
    wrong_plan["planId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "authorize_work_plan", wrong_plan).unwrap_err()["reason"],
        "work-plan-action"
    );
    assert_eq!(
        call(&window, "authorize_work_plan", original_authorization).unwrap(),
        authorized_plan
    );
    assert!(call(&window, "start_work_plan", json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"],"planId":prepared_plan["planId"],"actionId":authorization["actionId"],"expectedGeneration":authorized_plan["lease"]["generation"]})).is_err());
    // Owned process stages were reaped. Only synthetic fixture directories are
    // made removable; no user application directory is changed.
    state.plugins.close();
    drop(state);
    drop(app);
    fn removable(path: &std::path::Path) {
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
            for child in fs::read_dir(path).unwrap() {
                removable(&child.unwrap().path());
            }
        }
    }
    removable(temporary.path());
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod native;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod missing_package;

#[cfg(all(
    feature = "bundled-plugins",
    target_os = "macos",
    target_arch = "aarch64"
))]
mod bundled;
