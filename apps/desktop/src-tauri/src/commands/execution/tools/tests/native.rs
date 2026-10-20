//! Actual SDK Native worker through the registered manual Tool IPC boundary.
use super::*;
use crate::commands::plugins::InstalledPluginFixture;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_plugin_host::{
    CapturedNativeRuntime,
    catalog::{PackageApproval, PackageOrigin},
};

#[path = "../../../../../../../../crates/plugin-host/tests/support/native.rs"]
mod native_fixture;

type Window = tauri::WebviewWindow<tauri::test::MockRuntime>;

fn call(window: &Window, command: &str, request: Value) -> Result<Value, Value> {
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

fn scoped(context: &Value, fields: Value) -> Value {
    let mut value = context.clone();
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    value
}

fn consent(context: &Value, preflight: &Value, lifetime: bool) -> Value {
    scoped(
        context,
        json!({
            "attemptId":preflight["attemptId"], "inputDigest":preflight["inputDigest"],
            "grantId":ExecutionId::new(), "unsandboxedExecution":true, "applicationExecution":lifetime,
            "expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+600_000).to_string()
        }),
    )
}

fn result(window: &Window, context: &Value, attempt: &Value) -> Value {
    let until = Instant::now() + Duration::from_secs(45);
    loop {
        let detail = call(
            window,
            "read_execution_attempt",
            scoped(context, json!({"attemptId":attempt,"offset":0,"limit":100})),
        )
        .unwrap();
        let items = detail["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "one original input: {detail}");
        let item = &items[0];
        if item["resultId"].is_string() {
            assert_eq!(
                item["status"]["execution"], "succeeded",
                "actual Native worker: {detail}"
            );
            assert_eq!(item["status"]["adoption"], "unapplied");
            return call(
                window,
                "read_execution_output",
                scoped(
                    context,
                    json!({"attemptId":attempt,"resultId":item["resultId"]}),
                ),
            )
            .unwrap();
        }
        assert!(
            Instant::now() < until,
            "actual Native worker did not finish: {detail}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn close(window: &Window, context: &Value) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        match call(
            window,
            "close_project",
            json!({"sessionToken":context["sessionToken"]}),
        ) {
            Ok(view) => {
                assert_eq!(view["closed"], true);
                return;
            }
            Err(error) => {
                assert_eq!(error["code"], "busy", "{error}");
                assert!(Instant::now() < until, "project close stayed busy: {error}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[test]
fn real_native_application_tool_ipc_keeps_host_approval_lifetime_and_project_grants_separate() {
    eprintln!("native-tool-ipc: independently approved package and Native Host");
    let temporary = tempfile::tempdir().unwrap();
    let image = native_fixture::application_image();
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: image.package_digest().into(),
        origin: PackageOrigin {
            source_id: "synthetic-native-tool".into(),
            publisher_id: "explicit-test-approval".into(),
        },
    };
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    let fixture =
        InstalledPluginFixture::from_image(state.plugins.clone(), image, approval.clone());
    fixture.install();
    fixture.decide(true, vec![]);
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let inventory = call(&window, "read_plugin_inventory", json!({})).unwrap();
    assert_eq!(inventory["runtimes"], json!([]));
    let host = CapturedNativeRuntime::inspect_current().unwrap();
    assert_eq!(inventory["nativeHostOffer"]["environment"], json!(host));
    assert_eq!(inventory["nativeHostOffer"]["availability"], "available");
    let tool = json!({"package":{"plugin":approval.plugin,"packageDigest":approval.package_digest},
        "resourceId":"echo-tool","environmentDigest":host.digest().unwrap()});
    assert!(
        call(&window, "read_plugin_tool", tool.clone()).is_err(),
        "package approval cannot approve the Native Host"
    );
    let approved = call(
        &window,
        "set_plugin_native_host_approval",
        json!({
            "environmentDigest":host.digest().unwrap(),"approved":true,
            "expectedRevision":inventory["settingsRevision"],"actionId":ExecutionId::new()
        }),
    )
    .unwrap();
    assert_eq!(
        approved["runtimes"],
        json!([]),
        "Native Host approval does not install a Node runtime"
    );
    let view = call(&window, "read_plugin_tool", tool.clone()).unwrap();
    assert_eq!(view["componentScope"], "application");
    assert_eq!(view["environment"], json!(host));
    let first_path = temporary.path().join("first");
    let first = call(
        &window,
        "create_project",
        json!({"destination":first_path,
        "displayName":"Native first","sourceLocale":"en","targetLocales":["zh-CN"]}),
    )
    .unwrap();
    let first_context =
        json!({"sessionToken":first["sessionToken"],"projectId":first["metadata"]["projectId"]});
    let mut payload = view["binding"]["declaration"]["query"]["inputTemplate"].clone();
    payload["rows"][0]["text"] = json!("A 原始输入 👩🏽‍💻 e\u{301}");
    payload["rows"][0]["selected"] = json!(["term"]);
    let first_prepare = scoped(
        &first_context,
        json!({"tool":tool,"attemptId":ExecutionId::new(),"payloads":[payload]}),
    );
    let first_preflight = call(&window, "prepare_plugin_tool", first_prepare.clone()).unwrap();
    assert_eq!(first_preflight["items"][0]["payload"], payload);
    let basis = first_preflight["applicationScope"].clone();
    assert!(basis.is_object());
    assert_eq!(
        first_preflight["applicationCapabilities"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        first_preflight["applicationCapabilities"][0]["contributionId"],
        "echo"
    );
    assert_eq!(
        call(
            &window,
            "read_application_plugin_instance",
            json!({"basis":basis})
        )
        .unwrap()["state"],
        "reserved"
    );
    let without_lifetime = consent(&first_context, &first_preflight, false);
    assert!(
        call(&window, "start_plugin_tool", without_lifetime).is_err(),
        "Host approval cannot authorize instance lifetime"
    );
    assert_eq!(
        call(
            &window,
            "read_application_plugin_instance",
            json!({"basis":basis})
        )
        .unwrap()["state"],
        "reserved"
    );
    let unqueued_attempt: ExecutionId =
        serde_json::from_value(first_preflight["attemptId"].clone()).unwrap();
    state.sessions.with(move |sessions| {
        let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(store.execution_input(unqueued_attempt).is_err());
    });
    eprintln!("native-tool-ipc: first independently consented project call");
    let first_start = consent(&first_context, &first_preflight, true);
    let original_read = scoped(&first_context,json!({"attemptId":first_preflight["attemptId"],"inputDigest":first_preflight["inputDigest"],"operation":"plugin-tool-query"}));
    assert_eq!(call(&window,"read_plugin_execution_start",original_read.clone()).unwrap(),Value::Null);
    let first_attempt = call(&window, "start_plugin_tool", first_start.clone()).unwrap();
    let first_result = result(&window, &first_context, &first_attempt);
    let original_proof=call(&window,"read_plugin_execution_start",original_read.clone()).unwrap();
    assert_eq!(original_proof["projectId"],first_context["projectId"]);
    assert_eq!(original_proof["attemptId"],first_attempt);
    assert_eq!(original_proof["inputDigest"],first_preflight["inputDigest"]);
    let channel = first_result["plugin"]["channel"].clone();
    assert_eq!(channel["instanceId"], basis["instanceId"]);
    assert_eq!(
        channel["activationGeneration"],
        basis["activationGeneration"]
    );
    assert_eq!(channel["contributionId"], "echo");
    assert_eq!(
        first_result["plugin"]["authorizationId"],
        first_start["grantId"]
    );
    assert_eq!(
        first_result["plugin"]["result"]["context"]["projectId"],
        first_context["projectId"]
    );
    assert_eq!(
        first_result["plugin"]["result"]["context"]["scopeId"],
        basis["instanceId"]
    );
    assert_eq!(first_result["output"]["rows"], payload["rows"]);
    let pid = first_result["output"]["workerPid"].as_u64().unwrap();
    assert!(pid > 0);
    assert_eq!(first_result["output"]["invocationCount"], 1);
    assert_eq!(
        call(&window, "start_plugin_tool", first_start.clone()).unwrap(),
        first_attempt
    );

    close(&window, &first_context);
    assert_eq!(
        call(
            &window,
            "read_application_plugin_instance",
            json!({"basis":basis})
        )
        .unwrap()["state"],
        "active"
    );
    let second = call(
        &window,
        "create_project",
        json!({"destination":temporary.path().join("second"),
        "displayName":"Native second","sourceLocale":"en","targetLocales":["zh-CN"]}),
    )
    .unwrap();
    let second_context =
        json!({"sessionToken":second["sessionToken"],"projectId":second["metadata"]["projectId"]});
    payload["rows"][0]["text"] = json!("B has its own input and consent");
    let second_prepare = scoped(
        &second_context,
        json!({"tool":tool,"attemptId":ExecutionId::new(),"payloads":[payload]}),
    );
    let second_preflight = call(&window, "prepare_plugin_tool", second_prepare).unwrap();
    assert_eq!(second_preflight["applicationScope"], basis);
    let forged = scoped(
        &second_context,
        json!({
            "attemptId":first_start["attemptId"],"inputDigest":first_start["inputDigest"],
            "grantId":first_start["grantId"],"unsandboxedExecution":true,"applicationExecution":true,
            "expiresAtMs":first_start["expiresAtMs"]
        }),
    );
    assert!(
        call(&window, "start_plugin_tool", forged).is_err(),
        "another project cannot replay the first grant"
    );
    let second_start = consent(&second_context, &second_preflight, false);
    eprintln!("native-tool-ipc: second project uses the same actual worker and a new grant");
    let second_attempt = call(&window, "start_plugin_tool", second_start.clone()).unwrap();
    let second_result = result(&window, &second_context, &second_attempt);
    assert_eq!(second_result["plugin"]["channel"], channel);
    assert_eq!(
        second_result["plugin"]["authorizationId"],
        second_start["grantId"]
    );
    assert_ne!(second_start["grantId"], first_start["grantId"]);
    assert_eq!(
        second_result["plugin"]["result"]["context"]["projectId"],
        second_context["projectId"]
    );
    assert_eq!(second_result["output"]["rows"], payload["rows"]);
    assert_eq!(second_result["output"]["workerPid"].as_u64(), Some(pid));
    assert_eq!(
        second_result["output"]["invocationCount"], 2,
        "historical start replay cannot invoke again"
    );

    let stop = json!({"basis":basis,"actionId":ExecutionId::new()});
    eprintln!("native-tool-ipc: exact stop drains before historical ACK and reopen");
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let status = call(&window, "stop_application_plugin_instance", stop.clone()).unwrap();
        assert_eq!(status["basis"], basis);
        if status["state"] == "stopped" {
            break;
        }
        assert_eq!(status["state"], "stopping");
        assert!(
            Instant::now() < until,
            "Native instance did not drain: {status}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        call(&window, "start_plugin_tool", second_start.clone()).unwrap(),
        second_attempt
    );
    assert_eq!(
        result(&window, &second_context, &second_attempt),
        second_result
    );
    let mut renewed = second_start.clone();
    renewed["grantId"] = json!(ExecutionId::new());
    assert!(call(&window, "start_plugin_tool", renewed).is_err());
    assert_eq!(
        call(
            &window,
            "read_application_plugin_instance",
            json!({"basis":basis})
        )
        .unwrap()["state"],
        "stopped"
    );
    close(&window, &second_context);

    let reopened = call(&window, "open_project", json!({"locator":first_path})).unwrap();
    let reopened_context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    assert!(call(&window,"read_plugin_execution_start",original_read.clone()).is_err());
    let historical_read=scoped(&original_read,reopened_context.clone());
    assert_eq!(call(&window,"read_plugin_execution_start",historical_read).unwrap(),original_proof);
    state.sessions.with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    assert_eq!(call(&window,"read_application_plugin_instance",json!({"basis":basis})).unwrap()["state"],"stopped");

    assert_eq!(
        result(&window, &reopened_context, &first_attempt),
        first_result
    );
    let historical = scoped(&first_start, reopened_context.clone());
    assert_eq!(
        call(&window, "start_plugin_tool", historical).unwrap(),
        first_attempt
    );
    assert_eq!(
        call(&window, "stop_application_plugin_instance", stop).unwrap()["state"],
        "stopped"
    );
    state.sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(!host.runtime.has_active_work(store).unwrap());
        assert!(host.plugin_registrations.is_empty());
        assert!(host.tools.prepared.is_none() && host.tools.last_start.is_none());
    });
    close(&window, &reopened_context);
    eprintln!("native-tool-ipc: completed with stopped instance and immutable history");
}
