use super::*;
use serde_json::{Value, json};

#[test]
fn tool_wire_keeps_selection_fixed_queries_and_consent_separate() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginToolWorkflow.contract.json"
    ))
    .unwrap();
    fn round<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round::<PluginToolRequest>(&fixture["request"]);
    round::<PluginToolView>(&fixture["view"]);
    round::<PluginToolPrepareRequest>(&fixture["prepare"]);
    round::<PluginToolPreflight>(&fixture["preflight"]);
    round::<PluginStartRequest>(&fixture["start"]);
    round::<PluginToolDiscardRequest>(&fixture["discard"]);
    for property in [
        "directory",
        "origin",
        "environment",
        "approved",
        "grantId",
        "parentAttemptId",
    ] {
        let mut forged = fixture["prepare"].clone();
        forged[property] = json!(true);
        assert!(serde_json::from_value::<PluginToolPrepareRequest>(forged).is_err());
    }
    for property in ["provider", "grantId", "origin", "environment"] {
        let mut forged = fixture["request"].clone();
        forged[property] = json!(true);
        assert!(serde_json::from_value::<PluginToolRequest>(forged).is_err());
    }
}

#[test]
fn tool_pending_preparation_is_exclusive_and_stop_revokes_its_ticket() {
    let mut session = ToolSession::default();
    let attempt = ExecutionId::new();
    let ticket = session.begin(attempt).unwrap();
    assert!(session.active());
    assert_eq!(
        session.begin(attempt).unwrap_err().code,
        CommandErrorCode::Busy
    );
    assert_eq!(session.pending, Some((ticket, attempt)));
    assert!(!session.discard(ExecutionId::new()));
    assert_eq!(session.pending, Some((ticket, attempt)));
    assert!(session.discard(attempt));
    assert!(!session.active());
    assert_ne!(session.begin(attempt).unwrap(), ticket);
    session.stop();
    assert!(!session.active());
    assert!(session.prepared.is_none() && session.last_start.is_none());
    assert_ne!(session.begin(attempt).unwrap(), ticket);
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn real_tool_ipc_captures_single_and_batch_inputs_and_reuses_original_authority() {
    use crate::commands::plugins::InstalledPluginFixture;
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
        CapturedRuntime, PackageImage, RuntimeApproval,
        catalog::{PackageApproval, PackageOrigin},
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
    fn consent(context: &Value, view: &Value) -> Value {
        let mut request = context.clone();
        request["attemptId"] = view["attemptId"].clone();
        request["inputDigest"] = view["inputDigest"].clone();
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
    fn results(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        context: &Value,
        attempt: &Value,
        count: usize,
    ) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let mut read = context.clone();
            read["attemptId"] = attempt.clone();
            read["offset"] = json!(0);
            read["limit"] = json!(100);
            let detail = call(window, "read_execution_attempt", read).unwrap();
            let items = detail["items"].as_array().unwrap();
            if items.len() == count && items.iter().all(|item| item["resultId"].is_string()) {
                return items
                    .iter()
                    .map(|item| {
                        assert_eq!(item["status"]["adoption"], "unapplied");
                        let mut read = context.clone();
                        read["attemptId"] = attempt.clone();
                        read["resultId"] = item["resultId"].clone();
                        call(window, "read_execution_output", read).unwrap()
                    })
                    .collect();
            }
            assert!(
                Instant::now() < deadline,
                "actual query worker did not finish: {detail}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let path = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_KNOWLEDGE_PACKAGE")
            .expect("explicit captured package required"),
    );
    let digest =
        std::env::var("TSUMUGI_TEST_KNOWLEDGE_DIGEST").expect("independent package digest required");
    let image = PackageImage::capture_directory(&path, &digest, || true).unwrap();
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "synthetic-manual-source".into(),
            publisher_id: "synthetic-manual-publisher".into(),
        },
    };
    let descriptor: tsumugi_plugin_sdk::RuntimeEnvironmentDescriptor = serde_json::from_slice(
        &fs::read(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL")
                .expect("independent runtime descriptor required"),
        )
        .unwrap(),
    )
    .unwrap();
    let runtime = CapturedRuntime::capture_directories(
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").expect("explicit runtime tool required"),
        ),
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").expect("explicit runtime Host required"),
        ),
        &descriptor,
        || true,
    )
    .unwrap();
    let runtime_approval = RuntimeApproval {
        environment: descriptor.into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let resource = image
        .resource_bytes(
            "terminology",
            &tsumugi_plugin_sdk::ContractRef {
                id: "org.tsumugi.examples.terminology-resource".into(),
                schema_version: 1,
                behavior_version: 1,
            },
        )
        .unwrap();
    let body: Value = serde_json::from_slice(resource).unwrap();
    let pin = json!({"id":body["id"], "revision":body["revision"], "sha256":tsumugi_plugin_sdk::payload_digest(std::str::from_utf8(resource).unwrap())});
    let query = json!({"resource":pin, "sourceLanguage":"en", "targetLanguage":"zh-CN",
        "queries":[{"id":"u-1", "text":"👩🏽‍💻 e\u{301} sound premises", "conceptIds":["soundness","premise"]}]});
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    let fixture =
        InstalledPluginFixture::from_image(state.plugins.clone(), image.clone(), approval.clone());
    fixture.install();
    fixture.install_runtime(&runtime, &runtime_approval);
    fixture.decide(true, vec![runtime_approval.clone()]);
    drop(runtime);
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(&window, "create_project", json!({"destination":temporary.path().join("project"),"displayName":"Independent tool fixture","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let mut terms = context.clone();
    terms["locale"] = json!("zh-CN");
    terms["afterTermId"] = Value::Null;
    terms["limit"] = json!(100);
    let original_terms = call(&window, "read_terms", terms.clone()).unwrap();
    let tool = PluginToolRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: approval.plugin.clone(),
            package_digest: approval.package_digest.clone(),
        },
        resource_id: "agent-query-tool".into(),
        environment_digest: runtime_approval.environment.digest().unwrap(),
    };
    let view = call(&window, "read_plugin_tool", json!(tool)).unwrap();
    assert_eq!(
        view["binding"],
        json!(image.capability_tool("agent-query-tool").unwrap())
    );
    assert_eq!(view["settingsRevision"], "1");
    let mut unknown = tool.clone();
    unknown.resource_id = "missing-tool".into();
    assert!(call(&window, "read_plugin_tool", json!(unknown)).is_err());
    let mut prepare = context.clone();
    prepare["tool"] = json!(tool);
    prepare["attemptId"] = json!(ExecutionId::new());
    prepare["payloads"] = json!([query]);
    // Accepted preparation owns its continuation even if IPC stops waiting.
    let mut waiting = Box::pin(prepare_plugin_tool(
        app.state(),
        serde_json::from_value(prepare.clone()).unwrap(),
    ));
    assert!(matches!(
        waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(waiting);
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        if state.sessions.with(|sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution_parts()
                .unwrap()
                .0
                .tools
                .prepared
                .is_some()
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "accepted tool preparation lost its continuation"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let preflight = call(&window, "prepare_plugin_tool", prepare.clone()).unwrap();
    assert_eq!(
        call(&window, "prepare_plugin_tool", prepare.clone()).unwrap(),
        preflight
    );
    assert_eq!(preflight["items"][0]["payload"], query);
    state.sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(!host.tools.active());
        assert!(host.plugin_registrations.is_empty());
        let attempt = host
            .tools
            .prepared
            .as_ref()
            .unwrap()
            .input
            .envelope()
            .attempt_id;
        assert!(store.execution_input(attempt).is_err());
        assert!(!host.handlers.contains_key(OPERATION));
    });
    let original = consent(&context, &preflight);
    let mut modified = prepare.clone();
    modified["payloads"][0]["queries"][0]["text"] = json!("changed input");
    assert!(call(&window, "prepare_plugin_tool", modified).is_err());
    let mut too_big = prepare.clone();
    too_big["attemptId"] = json!(ExecutionId::new());
    too_big["payloads"] = json!(["x".repeat(65_536)]);
    assert!(call(&window, "prepare_plugin_tool", too_big).is_err());
    assert_eq!(
        call(&window, "prepare_plugin_tool", prepare.clone()).unwrap(),
        preflight
    );
    for (field, value) in [
        ("unsandboxedExecution", json!(false)),
        ("inputDigest", json!("f".repeat(64))),
        ("expiresAtMs", json!("1")),
    ] {
        let mut rejected = original.clone();
        rejected[field] = value;
        assert!(call(&window, "start_plugin_tool", rejected).is_err());
    }
    fixture.decide(false, vec![runtime_approval.clone()]);
    assert!(call(&window, "start_plugin_tool", original.clone()).is_err());
    fixture.decide(true, vec![runtime_approval.clone()]);
    // Re-enabling cannot silently refresh the old settings capture or consent.
    assert!(call(&window, "start_plugin_tool", original).is_err());
    prepare["attemptId"] = json!(ExecutionId::new());
    let current = call(&window, "prepare_plugin_tool", prepare.clone()).unwrap();
    assert_eq!(current["tool"]["settingsRevision"], "3");
    let start = consent(&context, &current);
    let attempt = call(&window, "start_plugin_tool", start.clone()).unwrap();
    assert_eq!(
        call(&window, "start_plugin_tool", start.clone()).unwrap(),
        attempt
    );
    let single = results(&window, &context, &attempt, 1);
    assert_eq!(single[0]["outcome"], "succeeded");
    assert_eq!(single[0]["plugin"]["authorizationId"], start["grantId"]);
    let output: Value = serde_json::from_str(
        single[0]["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(output["basis"]["resource"], pin);
    assert_eq!(
        output["results"][0]["entries"][0]["preferredTarget"],
        "可靠性"
    );
    let unit = state.sessions.with({
        let attempt: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
        move |sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .execution_input(attempt)
                .unwrap()
                .envelope()
                .units[0]
                .unit_id
        }
    });
    let mut adoption = context.clone();
    adoption["attemptId"] = attempt.clone();
    adoption["unitId"] = json!(unit);
    adoption["actionId"] = json!(ExecutionId::new());
    adoption["resultIds"] = json!([single[0]["resultId"]]);
    // Preparation records a proposal in the ledger. The actual mutation
    // boundary still requires a registered adoption handler for its operation.
    let action = call(&window, "prepare_execution_adoption", adoption.clone()).unwrap();
    assert_eq!(action["operation"], OPERATION);
    let mut apply = context.clone();
    apply["actionId"] = adoption["actionId"].clone();
    assert_eq!(
        call(&window, "adopt_execution", apply.clone()).unwrap_err()["code"],
        "permission-denied"
    );
    assert_eq!(
        call(&window, "read_execution_receipt", apply).unwrap(),
        Value::Null
    );
    let mut discard = context.clone();
    discard["attemptId"] = attempt.clone();
    assert_eq!(
        call(&window, "discard_plugin_tool_preflight", discard.clone()).unwrap(),
        json!(true)
    );
    assert_eq!(
        call(&window, "discard_plugin_tool_preflight", discard).unwrap(),
        json!(false)
    );
    assert_eq!(
        call(&window, "start_plugin_tool", start.clone()).unwrap(),
        attempt
    );
    let mut renewed = start.clone();
    renewed["grantId"] = json!(ExecutionId::new());
    assert!(call(&window, "start_plugin_tool", renewed).is_err());
    let mut empty = query.clone();
    empty["queries"][0]["text"] = json!("soundtrack");
    let mut wrong = query.clone();
    wrong["resource"]["revision"] = json!("substituted");
    prepare["attemptId"] = json!(ExecutionId::new());
    prepare["payloads"] = json!([query, empty, wrong]);
    let batch = call(&window, "prepare_plugin_tool", prepare).unwrap();
    let start = consent(&context, &batch);
    let batch_attempt = call(&window, "start_plugin_tool", start.clone()).unwrap();
    let batch_results = results(&window, &context, &batch_attempt, 3);
    assert_eq!(
        batch_results
            .iter()
            .filter(|result| result["outcome"] == "succeeded")
            .count(),
        2
    );
    assert_eq!(
        batch_results
            .iter()
            .filter(|result| result["outcome"] == "failed")
            .count(),
        1
    );
    for result in &batch_results {
        assert_eq!(result["plugin"]["authorizationId"], start["grantId"]);
        assert_eq!(
            result["plugin"]["channel"]["packageDigest"],
            approval.package_digest
        );
    }
    assert!(batch_results.iter().any(|result| {
        result["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .is_some_and(|raw| {
                let value: Value = serde_json::from_str(raw).unwrap();
                value["results"][0]["entries"] == json!([])
            })
    }));
    let failed = batch_results
        .iter()
        .find(|result| result["outcome"] == "failed")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            failed["plugin"]["result"]["outcome"]["error"]["utf8"]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        json!({"code":"resource-mismatch"})
    );
    // Historical output is readable after disabling a provider. No new grant
    // or resource adoption is needed to read its original captured evidence.
    fixture.decide(false, vec![runtime_approval]);
    assert_eq!(results(&window, &context, &attempt, 1), single);
    assert_eq!(call(&window, "read_terms", terms).unwrap(), original_terms);
    let mut list = context.clone();
    list["after"] = json!("0");
    list["limit"] = json!(50);
    assert_eq!(
        call(&window, "list_execution_tasks", list)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    state.sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(!host.runtime.has_active_work(store).unwrap());
        assert!(!host.handlers.contains_key(OPERATION));
    });
    call(&window, "quiesce_execution", context.clone()).unwrap();
    state.sessions.with(|sessions| {
        let host = sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0;
        assert!(host.tools.prepared.is_none() && host.tools.last_start.is_none());
    });
    assert!(call(&window, "start_plugin_tool", start).is_err());
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
}
