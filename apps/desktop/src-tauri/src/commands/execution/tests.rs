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
    let webview =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let view=call(&webview,"create_project",json!({"destination":temp.path().join("project"),"displayName":"Execution test","sourceLocale":"en-US","targetLocales":["zh-CN"]})).unwrap();
    let context =
        json!({"sessionToken":view["sessionToken"],"projectId":view["metadata"]["projectId"]});
    (temp, app, webview, context)
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
    assert_eq!(call(&webview,"start_ai_translation",request(&context,json!({"attemptId":prepared["attemptId"],"digest":prepared["preview"]["digest"],"confirmed":false}))).unwrap_err()["field"],"ai-consent");
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
        call(&webview, "start_arena_translation", start(&second, false)).unwrap_err()["field"],
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
        call(&webview, "start_arena_translation", start(&second, true)).unwrap_err()["field"],
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
    let mut check = Box::pin(review::run_review_checks(
        app.state::<AppState>(),
        review::ReviewCheckRequest {
            session_token: session_token.clone(),
            project_id,
            unit_id: ExecutionId::new(),
            locale: "zh-CN".into(),
            expected_basis: "stale-fixture".into(),
            action_id,
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
    let action = call_when_ready(&webview, "prepare_execution_adoption", renewed).unwrap();
    let apply = request(&context, json!({"actionId":action["actionId"]}));
    let receipt = call_when_ready(&webview, "adopt_execution", apply.clone()).unwrap();
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 3);
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
