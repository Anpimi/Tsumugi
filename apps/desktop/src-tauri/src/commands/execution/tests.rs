use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

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
    round_trip::<PrepareRequest>(&fixture["prepare"]);
    round_trip::<AttemptDetail>(&fixture["detail"]);
    round_trip::<RuntimeStatus>(&fixture["status"]);
    round_trip::<CommandError>(&fixture["error"]);
    round_trip::<AdoptionReceipt>(&fixture["receipt"]);
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
            url: "http://tauri.localhost".parse().unwrap(),
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
    start_clock(&app.state::<AppState>());
    let webview =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let view=call(&webview,"create_project",json!({"destination":temp.path().join("project"),"displayName":"Execution test","sourceLocale":"en-US","targetLocales":["zh-CN"]})).unwrap();
    let context =
        json!({"sessionToken":view["sessionToken"],"projectId":view["metadata"]["projectId"]});
    (temp, app, webview, context)
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
        let status = call(webview, "execution_status", context.clone()).unwrap();
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
    call(
        webview,
        "read_execution_attempt",
        request(context, json!({"attemptId":attempt,"offset":0,"limit":100})),
    )
    .unwrap()
}
#[test]
fn invoke_recovers_grouped_partial_work_and_receipt_survives_reopen() {
    let (temp, _app, webview, context) = setup();
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
    let resumed=call(&webview,"recover_execution",request(&context,json!({"attemptId":attempt,"unitId":unit["unitId"],"action":"retry-safe-failure","itemIds":unit["remainingItemIds"]}))).unwrap();
    settled(&webview, &context);
    let after = detail(&webview, &context, &resumed["attemptId"]);
    assert_eq!(after["progress"]["succeeded"], 3);
    assert_eq!(after["progress"]["adopted"], 0);
    let unit = &after["recovery"]["units"][0];
    let prepare = request(
        &context,
        json!({"attemptId":resumed["attemptId"],"unitId":unit["unitId"],"actionId":ExecutionId::new(),"resultIds":unit["resultIds"]}),
    );
    let first = call(&webview, "prepare_execution_adoption", prepare.clone()).unwrap();
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
        call(&webview, "prepare_execution_adoption", prepare.clone()).unwrap(),
        first
    );
    let apply = request(&context, json!({"actionId":first["actionId"]}));
    assert_eq!(
        call(&webview, "adopt_execution", apply).unwrap_err()["code"],
        "cancelled"
    );
    let mut renewed = prepare;
    renewed["actionId"] = json!(ExecutionId::new());
    let action = call(&webview, "prepare_execution_adoption", renewed).unwrap();
    let apply = request(&context, json!({"actionId":action["actionId"]}));
    let receipt = call(&webview, "adopt_execution", apply.clone()).unwrap();
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 3);
    assert_eq!(call(&webview, "adopt_execution", apply).unwrap(), receipt);
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
