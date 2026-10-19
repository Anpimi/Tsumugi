use super::*;
use serde_json::{Value, json};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod native;

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
    round::<PluginToolStartRequest>(&fixture["start"]);
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
    for property in [
        "provider",
        "grantId",
        "origin",
        "environment",
        "componentScope",
    ] {
        let mut forged = fixture["request"].clone();
        forged[property] = json!(true);
        assert!(serde_json::from_value::<PluginToolRequest>(forged).is_err());
    }
    let mut missing_roster = fixture["preflight"].clone();
    missing_roster
        .as_object_mut()
        .unwrap()
        .remove("applicationCapabilities");
    assert!(serde_json::from_value::<PluginToolPreflight>(missing_roster).is_err());
    let mut missing_application = fixture["preflight"].clone();
    missing_application
        .as_object_mut()
        .unwrap()
        .remove("applicationScope");
    assert!(serde_json::from_value::<PluginToolPreflight>(missing_application).is_err());
    let mut missing_consent = fixture["start"].clone();
    missing_consent
        .as_object_mut()
        .unwrap()
        .remove("applicationExecution");
    assert!(serde_json::from_value::<PluginToolStartRequest>(missing_consent).is_err());
    let mut missing_scope = fixture["view"].clone();
    missing_scope
        .as_object_mut()
        .unwrap()
        .remove("componentScope");
    assert!(serde_json::from_value::<PluginToolView>(missing_scope).is_err());
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
    real_scoped_tool_ipc(tsumugi_plugin_sdk::ComponentScope::Project);
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn real_attempt_tool_ipc_captures_scope_and_reuses_only_original_authority() {
    real_scoped_tool_ipc(tsumugi_plugin_sdk::ComponentScope::Attempt);
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn real_application_tool_ipc_keeps_instance_lifetime_and_project_grants_independent() {
    real_scoped_tool_ipc(tsumugi_plugin_sdk::ComponentScope::Application);
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn real_scoped_tool_ipc(component_scope: tsumugi_plugin_sdk::ComponentScope) {
    let application = component_scope == tsumugi_plugin_sdk::ComponentScope::Application;
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
        request["applicationExecution"] = json!(view["applicationScope"].is_object());
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
    fn close(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, context: &Value) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            match call(
                window,
                "close_project",
                json!({"sessionToken":context["sessionToken"]}),
            ) {
                Ok(value) => {
                    assert_eq!(value["closed"], true);
                    break;
                }
                Err(error) => {
                    assert_eq!(error["code"], "busy", "{error}");
                    assert!(Instant::now() < until);
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }
    fn reopen_original_start(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>, state: &AppState,
        path: &std::path::Path, original: &Value, proof: &Value,
    ) {
        let opened = call(window, "open_project", json!({"locator":path})).unwrap();
        assert!(call(window, "read_plugin_execution_start", original.clone()).is_err());
        let mut request = original.clone(); request["sessionToken"] = opened["sessionToken"].clone();
        assert_eq!(call(window, "read_plugin_execution_start", request).unwrap(), *proof);
        state.sessions.with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
        close(window, &json!({"sessionToken":opened["sessionToken"]}));
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
    let digest = std::env::var("TSUMUGI_TEST_KNOWLEDGE_DIGEST")
        .expect("independent package digest required");
    let image = PackageImage::capture_directory(&path, &digest, || true).unwrap();
    let image = if component_scope != tsumugi_plugin_sdk::ComponentScope::Project {
        fn files(
            root: &std::path::Path,
            directory: &std::path::Path,
            collected: &mut std::collections::BTreeMap<String, tsumugi_plugin_host::PackageFile>,
        ) {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                assert!(!kind.is_symlink());
                if kind.is_dir() {
                    files(root, &entry.path(), collected);
                } else {
                    assert!(kind.is_file());
                    let relative = entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_owned();
                    if relative == "manifest.json" {
                        continue;
                    }
                    use std::os::unix::fs::PermissionsExt;
                    collected.insert(
                        relative,
                        tsumugi_plugin_host::PackageFile {
                            bytes: fs::read(entry.path()).unwrap(),
                            executable: entry.metadata().unwrap().permissions().mode() & 0o111 != 0,
                        },
                    );
                }
            }
        }
        let mut captured = std::collections::BTreeMap::new();
        files(&path, &path, &mut captured);
        assert_eq!(
            PackageImage::digest(&fs::read(path.join("manifest.json")).unwrap(), &captured)
                .unwrap(),
            digest
        );
        let mut manifest = image.manifest().manifest().clone();
        let selected = image
            .capability_tool("agent-query-tool")
            .unwrap()
            .capability
            .provider;
        for component in &mut manifest.components {
            if component.runtime != tsumugi_plugin_sdk::RuntimeKind::Data
                && (!application || component.id == selected.component_id)
            {
                component.scope = component_scope;
            }
        }
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = PackageImage::digest(&bytes, &captured).unwrap();
        let adapted = PackageImage::capture(bytes, captured, &digest).unwrap();
        adapted
    } else {
        image
    };
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: image.package_digest().into(),
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
        view["componentScope"],
        match component_scope {
            tsumugi_plugin_sdk::ComponentScope::Project => "project",
            tsumugi_plugin_sdk::ComponentScope::Attempt => "attempt",
            tsumugi_plugin_sdk::ComponentScope::Application => "application",
        }
    );
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
    if application {
        let basis = current["applicationScope"].clone();
        assert_eq!(
            call(
                &window,
                "read_application_plugin_instance",
                json!({"basis":basis})
            )
            .unwrap()["state"],
            "reserved"
        );
        let mut without_lifetime = start.clone();
        without_lifetime["applicationExecution"] = json!(false);
        assert!(call(&window, "start_plugin_tool", without_lifetime).is_err());
        let current_attempt = serde_json::from_value(current["attemptId"].clone()).unwrap();
        state.sessions.with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(store.execution_input(current_attempt).is_err());
        });
    }
    let proof_request = json!({"projectId":context["projectId"],"sessionToken":context["sessionToken"],
        "attemptId":current["attemptId"],"inputDigest":current["inputDigest"],"operation":"plugin-tool-query"});
    assert_eq!(call(&window,"read_plugin_execution_start",proof_request.clone()).unwrap(),Value::Null);
    let attempt = call(&window, "start_plugin_tool", start.clone()).unwrap();
    assert_eq!(
        call(&window, "start_plugin_tool", start.clone()).unwrap(),
        attempt
    );
    let single = results(&window, &context, &attempt, 1);
    let proof = call(&window,"read_plugin_execution_start",proof_request.clone()).unwrap();
    let saved_attempt: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
    let expected_project = context["projectId"].clone(); let expected_digest = current["inputDigest"].clone();
    let expected_proof = state.sessions.with(move |sessions| {
        let input = sessions.active.as_ref().unwrap().store.execution_input(saved_attempt).unwrap();
        assert_eq!(input.envelope().plugin.as_ref().unwrap().application_scope.is_some(),application);
        json!({"projectId":expected_project,"taskId":input.envelope().task_id,"attemptId":saved_attempt,
            "inputDigest":expected_digest,"operation":"plugin-tool-query"})
    });
    assert_eq!(proof,expected_proof);
    for (field,value) in [("inputDigest",json!("0".repeat(64))),("operation",json!("source-import")),("projectId",json!(ExecutionId::new()))] {
        let mut wrong = proof_request.clone();wrong[field]=value;
        assert!(call(&window,"read_plugin_execution_start",wrong).is_err());
    }
    state.sessions.with(|sessions| { sessions.active.as_mut().unwrap().execution_parts().unwrap().0.quiescing=true; });
    assert_eq!(call(&window,"read_plugin_execution_start",proof_request.clone()).unwrap(),proof);
    state.sessions.with(|sessions| { sessions.active.as_mut().unwrap().execution_parts().unwrap().0.quiescing=false; });

    assert_eq!(single[0]["outcome"], "succeeded");
    assert_eq!(single[0]["plugin"]["authorizationId"], start["grantId"]);
    assert_eq!(
        single[0]["plugin"]["result"]["context"]["scopeId"],
        match component_scope {
            tsumugi_plugin_sdk::ComponentScope::Attempt => attempt.clone(),
            tsumugi_plugin_sdk::ComponentScope::Application =>
                current["applicationScope"]["instanceId"].clone(),
            tsumugi_plugin_sdk::ComponentScope::Project => context["projectId"].clone(),
        }
    );
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
    assert_eq!(call(&window,"read_plugin_execution_start",proof_request.clone()).unwrap(),proof);
    let mut renewed = start.clone();
    renewed["grantId"] = json!(ExecutionId::new());
    assert!(call(&window, "start_plugin_tool", renewed).is_err());
    let mut empty = query.clone();
    empty["queries"][0]["text"] = json!("soundtrack");
    let mut wrong = query.clone();
    wrong["resource"]["revision"] = json!("substituted");
    prepare["attemptId"] = json!(ExecutionId::new());
    prepare["payloads"] = json!([query, empty, wrong]);
    let batch = call(&window, "prepare_plugin_tool", prepare.clone()).unwrap();
    let start = consent(&context, &batch);
    let batch_attempt = call(&window, "start_plugin_tool", start.clone()).unwrap();
    let batch_results = results(&window, &context, &batch_attempt, 3);
    if application {
        assert_eq!(current["applicationScope"], batch["applicationScope"]);
        assert!(
            batch_results
                .iter()
                .all(|result| result["plugin"]["channel"] == single[0]["plugin"]["channel"])
        );
    }
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
    if application {
        // Closing a project retires only its per-project authority, not the
        // separately consented application instance or its exact identity.
        let basis = batch["applicationScope"].clone();
        close(&window, &context);
        assert_eq!(
            call(
                &window,
                "read_application_plugin_instance",
                json!({"basis":basis})
            )
            .unwrap()["state"],
            "active"
        );
        let second = call(&window, "create_project", json!({"destination":temporary.path().join("second"), "displayName":"Independent second project", "sourceLocale":"en", "targetLocales":["zh-CN"]})).unwrap();
        let second_context = json!({"sessionToken":second["sessionToken"],"projectId":second["metadata"]["projectId"]});
        let mut second_prepare = second_context.clone();
        second_prepare["tool"] = json!(tool);
        second_prepare["attemptId"] = json!(ExecutionId::new());
        second_prepare["payloads"] = json!([batch["items"][0]["payload"]]);
        let second_preflight =
            call(&window, "prepare_plugin_tool", second_prepare.clone()).unwrap();
        assert_eq!(second_preflight["applicationScope"], basis);
        let mut second_start = consent(&second_context, &second_preflight);
        second_start["applicationExecution"] = json!(false); // existing lease only; new project consent remains mandatory
        let mut wrong_project = start.clone();
        wrong_project["sessionToken"] = second_context["sessionToken"].clone();
        wrong_project["projectId"] = second_context["projectId"].clone();
        assert!(call(&window, "start_plugin_tool", wrong_project).is_err());
        let second_attempt = call(&window, "start_plugin_tool", second_start.clone()).unwrap();
        let second_results = results(&window, &second_context, &second_attempt, 1);
        assert_eq!(
            second_results[0]["plugin"]["channel"],
            single[0]["plugin"]["channel"]
        );
        assert_eq!(
            second_results[0]["plugin"]["authorizationId"],
            second_start["grantId"]
        );
        assert_ne!(second_start["grantId"], start["grantId"]);
        assert_eq!(
            second_results[0]["plugin"]["result"]["context"]["projectId"],
            second_context["projectId"]
        );
        assert_eq!(
            second_results[0]["plugin"]["result"]["context"]["scopeId"],
            basis["instanceId"]
        );
        let stop = json!({"actionId":ExecutionId::new(),"basis":basis});
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let stopped = call(&window, "stop_application_plugin_instance", stop.clone()).unwrap();
            if stopped["state"] == "stopped" {
                break;
            }
            assert_eq!(stopped["state"], "stopping");
            assert!(Instant::now() < until, "original activation was not reaped");
            std::thread::sleep(Duration::from_millis(20));
        }
        // Exact historical ACK is data only. It never restarts the old process.
        assert_eq!(
            call(&window, "start_plugin_tool", second_start.clone()).unwrap(),
            second_attempt
        );
        assert_eq!(
            call(
                &window,
                "read_application_plugin_instance",
                json!({"basis":basis})
            )
            .unwrap()["state"],
            "stopped"
        );
        second_prepare["attemptId"] = json!(ExecutionId::new());
        let replacement = call(&window, "prepare_plugin_tool", second_prepare).unwrap();
        assert_ne!(replacement["applicationScope"], basis);
        let fresh_basis = replacement["applicationScope"].clone();
        assert_eq!(
            call(&window, "stop_application_plugin_instance", stop).unwrap()["state"],
            "stopped"
        );
        assert_eq!(
            call(
                &window,
                "read_application_plugin_instance",
                json!({"basis":fresh_basis})
            )
            .unwrap()["state"],
            "reserved"
        );
        let mut no_new_lease = consent(&second_context, &replacement);
        no_new_lease["applicationExecution"] = json!(false);
        assert!(call(&window, "start_plugin_tool", no_new_lease).is_err());
        let shutdown = json!({"actionId":ExecutionId::new()});
        assert_eq!(
            call(
                &window,
                "stop_application_plugin_instances",
                shutdown.clone()
            )
            .unwrap()["state"],
            "stopped"
        );
        assert_eq!(
            call(
                &window,
                "stop_application_plugin_instances",
                shutdown.clone()
            )
            .unwrap()["actionId"],
            shutdown["actionId"]
        );
        assert!(
            call(
                &window,
                "stop_application_plugin_instances",
                json!({"actionId":ExecutionId::new()})
            )
            .is_err()
        );
        assert!(
            call(&window, "prepare_plugin_tool", {
                let mut denied = second_context.clone();
                denied["tool"] = json!(tool);
                denied["attemptId"] = json!(ExecutionId::new());
                denied["payloads"] = json!([batch["items"][0]["payload"]]);
                denied
            })
            .is_err()
        );
        assert_eq!(
            call(
                &window,
                "resume_application_plugin_instances",
                shutdown.clone()
            )
            .unwrap()["state"],
            "resumed"
        );
        let mut after_resume = second_context.clone();
        after_resume["tool"] = json!(tool);
        after_resume["attemptId"] = json!(ExecutionId::new());
        after_resume["payloads"] = json!([batch["items"][0]["payload"]]);
        let restored_preflight =
            call(&window, "prepare_plugin_tool", after_resume.clone()).unwrap();
        let restored_basis = restored_preflight["applicationScope"].clone();
        assert_ne!(restored_basis, fresh_basis);
        let restored_start = consent(&second_context, &restored_preflight);
        let restored_attempt = call(&window, "start_plugin_tool", restored_start).unwrap();
        let restored_results = results(&window, &second_context, &restored_attempt, 1);
        assert_ne!(
            restored_results[0]["plugin"]["channel"]["instanceId"],
            single[0]["plugin"]["channel"]["instanceId"]
        );
        assert_eq!(
            call(
                &window,
                "stop_application_plugin_instances",
                shutdown.clone()
            )
            .unwrap()["state"],
            "resumed"
        );
        assert_eq!(
            call(
                &window,
                "read_application_plugin_instance",
                json!({"basis":restored_basis})
            )
            .unwrap()["state"],
            "active"
        );
        let next_shutdown = json!({"actionId":ExecutionId::new()});
        assert_eq!(
            call(
                &window,
                "stop_application_plugin_instances",
                next_shutdown.clone()
            )
            .unwrap()["state"],
            "stopped"
        );
        assert_eq!(
            call(&window, "resume_application_plugin_instances", shutdown).unwrap()["state"],
            "resumed"
        );
        after_resume["attemptId"] = json!(ExecutionId::new());
        assert!(
            call(&window, "prepare_plugin_tool", after_resume).is_err(),
            "old resume cannot clear the newer exit fence"
        );
        fixture.decide(false, vec![runtime_approval]);
        assert_eq!(
            results(&window, &second_context, &second_attempt, 1),
            second_results
        );
        let before_history = state.sessions.with(|sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(!host.runtime.has_active_work(store).unwrap());
            (
                host.plugin_registrations.clone(),
                host.tools.last_start.clone(),
            )
        });
        for (field, value) in [
            ("applicationExecution", json!(true)),
            ("grantId", json!(ExecutionId::new())),
            ("expiresAtMs", json!("1")),
            ("inputDigest", json!("f".repeat(64))),
            ("unsandboxedExecution", json!(false)),
        ] {
            let mut changed = second_start.clone();
            changed[field] = value;
            assert!(call(&window, "start_plugin_tool", changed).is_err());
        }
        assert_eq!(
            call(&window, "start_plugin_tool", second_start.clone()).unwrap(),
            second_attempt
        );
        assert_eq!(
            results(&window, &second_context, &second_attempt, 1),
            second_results
        );
        assert_eq!(
            call(
                &window,
                "read_application_plugin_instance",
                json!({"basis":restored_basis})
            )
            .unwrap()["state"],
            "stopped"
        );
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(!host.runtime.has_active_work(store).unwrap());
            assert!(host.plugin_registrations == before_history.0);
            assert!(
                host.tools.last_start == before_history.1,
                "historical ACK does not replace current admission or resurrect its lease"
            );
        });
        close(&window, &second_context);
        reopen_original_start(&window,&state,&temporary.path().join("project"),&proof_request,&proof);
        return;
    }
    prepare["attemptId"] = json!(ExecutionId::new());
    let unqueued = call(&window, "prepare_plugin_tool", prepare).unwrap();
    let unqueued_start = consent(&context, &unqueued);
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
    assert_eq!(
        call(&window, "start_plugin_tool", start).unwrap(),
        batch_attempt
    );
    assert!(call(&window, "start_plugin_tool", unqueued_start).is_err());
    state.sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(!host.runtime.has_active_work(store).unwrap());
        assert!(host.tools.prepared.is_none() && host.tools.last_start.is_none());
    });
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    reopen_original_start(&window,&state,&temporary.path().join("project"),&proof_request,&proof);
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn real_application_roster_tool_ipc_shares_one_instance_without_sharing_project_grants() {
    use crate::commands::plugins::InstalledPluginFixture;
    use std::{
        collections::BTreeMap,
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    use tsumugi_plugin_host::{
        CapturedRuntime, PackageFile, PackageImage, RuntimeApproval,
        catalog::{PackageApproval, PackageOrigin},
    };
    use tsumugi_plugin_sdk as sdk;
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
    fn output(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        context: &Value,
        attempt: &Value,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let mut request = context.clone();
            request["attemptId"] = attempt.clone();
            request["offset"] = json!(0);
            request["limit"] = json!(10);
            let detail = call(window, "read_execution_attempt", request).unwrap();
            if let Some(id) = detail["items"][0]["resultId"].as_str() {
                let mut request = context.clone();
                request["attemptId"] = attempt.clone();
                request["resultId"] = json!(id);
                return call(window, "read_execution_output", request).unwrap();
            }
            assert!(
                Instant::now() < deadline,
                "synthetic roster Tool did not finish: {detail}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let reference = |id: &str| sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    };
    let mut manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: "application-roster".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![sdk::PermissionRequest::CapturedInput],
        components: vec![sdk::ComponentDeclaration {
            id: "shared".into(),
            scope: sdk::ComponentScope::Application,
            runtime: sdk::RuntimeKind::JavaScript,
            entrypoint: Some("component.mjs".into()),
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 1000,
                cleanup_timeout_ms: 1000,
            },
        }],
        contributions: vec![],
    };
    let mut files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: include_bytes!(
                    "../../../../../../../crates/plugin-host/tests/support/javascript-component.mjs"
                )
                .to_vec(),
                executable: false,
            },
        ),
        (
            "behavior.txt".into(),
            PackageFile {
                bytes: b"roster".to_vec(),
                executable: false,
            },
        ),
    ]);
    for id in ["alpha", "beta"] {
        manifest.contributions.push(sdk::ContributionDeclaration {
            id: id.into(),
            component_id: "shared".into(),
            contribution: sdk::ContributionKind::Capability {
                declaration: sdk::CapabilityDeclaration {
                    contract: reference(&format!("example.{id}")),
                    input_schema: reference("example.input"),
                    output_schema: reference("example.output"),
                    error_schema: reference("example.error"),
                    profiles: vec![],
                    effect: sdk::EffectKind::ReadOnly,
                    permissions: vec![sdk::PermissionRequest::CapturedInput],
                    limits: sdk::CapabilityLimits {
                        max_input_bytes: 4096,
                        max_output_bytes: 4096,
                        concurrency: 1,
                        timeout_ms: 5000,
                    },
                },
            },
        });
        let declaration = sdk::CapabilityToolDeclaration {
            name: format!("{id}_tool"),
            title: format!("Synthetic {id} tool"),
            description: "Read one explicitly captured synthetic input".into(),
            capability_id: id.into(),
            profile: None,
            supporting_resources: vec![],
            skill: None,
            query: None,
        };
        files.insert(
            format!("{id}.json"),
            PackageFile {
                bytes: serde_json::to_vec(&declaration).unwrap(),
                executable: false,
            },
        );
        manifest.contributions.push(sdk::ContributionDeclaration {
            id: format!("{id}-tool"),
            component_id: "shared".into(),
            contribution: sdk::ContributionKind::Resource {
                schema: sdk::tool_declaration_contract(),
                path: format!("{id}.json"),
            },
        });
    }
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    let image = PackageImage::capture(manifest, files, &digest).unwrap();
    let descriptor: sdk::RuntimeEnvironmentDescriptor = serde_json::from_slice(
        &fs::read(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL")
                .expect("explicit Process3 runtime approval required"),
        )
        .unwrap(),
    )
    .unwrap();
    let runtime = CapturedRuntime::capture_directories(
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").expect("explicit runtime tool required"),
        ),
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").expect("explicit Process3 Host required"),
        ),
        &descriptor,
        || true,
    )
    .unwrap();
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "synthetic-roster-source".into(),
            publisher_id: "synthetic-roster-publisher".into(),
        },
    };
    let runtime_approval = RuntimeApproval {
        environment: descriptor.into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    let fixture =
        InstalledPluginFixture::from_image(state.plugins.clone(), image, approval.clone());
    fixture.install();
    fixture.install_runtime(&runtime, &runtime_approval);
    fixture.decide(true, vec![runtime_approval.clone()]);
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let mut contexts: Vec<Value> = Vec::new();
    let mut starts: Vec<Value> = Vec::new();
    let mut saved: Vec<Value> = Vec::new();
    let mut basis = Value::Null;
    for (ordinal, id) in ["alpha", "beta"].into_iter().enumerate() {
        let project=call(&window,"create_project",json!({"destination":temporary.path().join(id),"displayName":format!("Synthetic {id}"),"sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
        let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
        let tool = json!({"package":{"plugin":approval.plugin,"packageDigest":approval.package_digest},"resourceId":format!("{id}-tool"),"environmentDigest":runtime_approval.environment.digest().unwrap()});
        let mut prepare = context.clone();
        prepare["attemptId"] = json!(ExecutionId::new());
        prepare["tool"] = tool;
        prepare["payloads"] = json!([{ "text":id }]);
        let preflight = call(&window, "prepare_plugin_tool", prepare).unwrap();
        assert_eq!(
            preflight["applicationCapabilities"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        if ordinal == 0 {
            basis = preflight["applicationScope"].clone();
        } else {
            assert_eq!(preflight["applicationScope"], basis);
        }
        let mut start = context.clone();
        start["attemptId"] = preflight["attemptId"].clone();
        start["inputDigest"] = preflight["inputDigest"].clone();
        start["grantId"] = json!(ExecutionId::new());
        start["expiresAtMs"] = json!(
            (SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                + 60_000)
                .to_string()
        );
        start["unsandboxedExecution"] = json!(true);
        start["applicationExecution"] = json!(ordinal == 0);
        if ordinal == 1 {
            let mut foreign = starts[0].clone();
            foreign["sessionToken"] = context["sessionToken"].clone();
            foreign["projectId"] = context["projectId"].clone();
            assert!(call(&window, "start_plugin_tool", foreign).is_err());
        }
        let attempt = call(&window, "start_plugin_tool", start.clone()).unwrap();
        let result = output(&window, &context, &attempt);
        assert_eq!(result["plugin"]["authorizationId"], start["grantId"]);
        assert_eq!(result["plugin"]["channel"]["contributionId"], id);
        assert_eq!(
            result["plugin"]["channel"]["instanceId"],
            basis["instanceId"]
        );
        let payload: Value = serde_json::from_str(
            result["plugin"]["result"]["outcome"]["output"]["utf8"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["member"], id);
        assert_eq!(payload["ordinal"], ordinal + 1);
        contexts.push(context.clone());
        starts.push(start);
        saved.push(result);
        if ordinal == 0 {
            call(&window, "quiesce_execution", context.clone()).unwrap();
            call(
                &window,
                "close_project",
                json!({"sessionToken":context["sessionToken"]}),
            )
            .unwrap();
        }
    }
    assert_ne!(starts[0]["grantId"], starts[1]["grantId"]);
    assert_eq!(
        saved[0]["plugin"]["channel"]["instanceId"],
        saved[1]["plugin"]["channel"]["instanceId"]
    );
    let stop = json!({"actionId":ExecutionId::new(),"basis":basis});
    call(&window, "stop_application_plugin_instance", stop.clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let value = call(
            &window,
            "read_application_plugin_instance",
            json!({"basis":basis}),
        )
        .unwrap();
        if value["state"] == "stopped" {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        call(&window, "start_plugin_tool", starts[1].clone()).unwrap(),
        starts[1]["attemptId"]
    );
    assert_eq!(
        output(&window, &contexts[1], &starts[1]["attemptId"]),
        saved[1]
    );
    assert_eq!(
        call(&window, "stop_application_plugin_instance", stop).unwrap()["basis"],
        basis
    );
    call(&window, "quiesce_execution", contexts[1].clone()).unwrap();
    call(
        &window,
        "close_project",
        json!({"sessionToken":contexts[1]["sessionToken"]}),
    )
    .unwrap();
}
