use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

fn request(command: &str, value: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: command.to_owned(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(),
        body: InvokeBody::Json(json!({ "request": value })),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_owned(),
    }
}
fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    value: Value,
) -> Value {
    tauri::test::get_ipc_response(window, request(command, value))
        .unwrap()
        .deserialize()
        .unwrap()
}
fn reject(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    value: Value,
) -> Value {
    tauri::test::get_ipc_response(window, request(command, value)).unwrap_err()
}
fn identity() -> String {
    ExecutionId::new().to_string()
}
fn original(value: &Value) -> Value {
    let mut value = value.clone();
    value.as_object_mut().unwrap().remove("sessionToken");
    value
}
fn session(project: &Value) -> Value {
    json!({ "projectId": project["metadata"]["projectId"], "sessionToken": project["sessionToken"] })
}
fn in_session(project: &Value, fields: Value) -> Value {
    let mut value = session(project);
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    value
}
fn runtime_absent(app: &tauri::App<tauri::test::MockRuntime>, project: &Value) -> bool {
    let token = project["sessionToken"].as_str().unwrap().to_owned();
    let id = ExecutionId::parse(project["metadata"]["projectId"].as_str().unwrap()).unwrap();
    tauri::async_runtime::block_on(app.state::<AppState>().sessions.run(
        "conversation-test-runtime",
        CommandStage::ExecutionRead,
        move |sessions| {
            Ok(
                authorized(sessions, &token, id, CommandStage::ExecutionRead)?
                    .execution
                    .is_none(),
            )
        },
    ))
    .unwrap()
}

#[test]
fn conversation_ipc_preserves_original_actions_across_quiescing_and_reopen() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("project");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({ "destination": destination, "displayName": "Conversation IPC", "sourceLocale": "en", "targetLocales": ["zh-CN"] }),
    );
    let create = in_session(
        &project,
        json!({ "actionId": identity(), "conversationId": identity(), "title": null }),
    );
    let mut missing_title = create.clone();
    missing_title.as_object_mut().unwrap().remove("title");
    assert!(!reject(&window, "create_project_conversation", missing_title).is_null());
    let first = call(&window, "create_project_conversation", create.clone());
    assert_eq!(first["title"], Value::Null);
    assert_eq!(first["ordinal"], "1");
    assert_eq!(
        call(&window, "create_project_conversation", create.clone()),
        first
    );
    let second = call(
        &window,
        "create_project_conversation",
        in_session(
            &project,
            json!({ "actionId": identity(), "conversationId": identity(), "title": "第二个线程 é" }),
        ),
    );
    assert_eq!(second["ordinal"], "2");
    let listed = call(
        &window,
        "list_project_conversations",
        in_session(&project, json!({ "after": null, "limit": 1 })),
    );
    assert_eq!(listed["rows"], json!([first]));
    assert_eq!(listed["nextAfter"], "1");
    let tail = call(
        &window,
        "list_project_conversations",
        in_session(
            &project,
            json!({ "after": listed["nextAfter"], "limit": 1 }),
        ),
    );
    assert_eq!(tail["rows"], json!([second]));
    assert_eq!(tail["nextAfter"], Value::Null);
    let body = "  Keep {name} — é 👩🏽‍💻\r\nالعربية עברית\n  ";
    let append = in_session(
        &project,
        json!({ "actionId": identity(), "conversationId": create["conversationId"], "messageId": identity(), "body": body }),
    );
    let sent = call(
        &window,
        "append_project_conversation_message",
        append.clone(),
    );
    assert_eq!(sent["body"], body);
    assert_eq!(sent["author"], "human");
    assert_eq!(sent["ordinal"], "1");
    assert_eq!(
        call(
            &window,
            "append_project_conversation_message",
            append.clone()
        ),
        sent
    );
    let recovered = call(
        &window,
        "recover_project_conversation_message",
        append.clone(),
    );
    assert_eq!(recovered["request"], original(&append));
    assert_eq!(
        recovered["outcome"],
        json!({ "kind": "recorded", "receipt": sent })
    );
    let mut changed = append.clone();
    changed["body"] = json!("Changed request");
    assert_eq!(
        call(
            &window,
            "recover_project_conversation_message",
            changed.clone()
        )["outcome"],
        json!({ "kind": "mismatch" })
    );
    assert!(reject(&window, "append_project_conversation_message", changed).is_object());
    let mut wrong = append.clone();
    wrong["sessionToken"] = json!("wrong-session");
    assert_eq!(
        reject(&window, "recover_project_conversation_message", wrong)["code"],
        "session-invalid"
    );
    let mut foreign = create.clone();
    foreign["projectId"] = json!(identity());
    assert_eq!(
        reject(&window, "recover_project_conversation_create", foreign)["code"],
        "session-invalid"
    );
    let mut spoofed = append.clone();
    spoofed["author"] = json!("assistant");
    assert!(!reject(&window, "append_project_conversation_message", spoofed).is_null());
    let unknown = in_session(
        &project,
        json!({ "actionId": identity(), "conversationId": create["conversationId"], "messageId": identity(), "body": "Not submitted" }),
    );
    assert_eq!(
        call(
            &window,
            "recover_project_conversation_message",
            unknown.clone()
        )["outcome"],
        json!({ "kind": "pending", "replay": "explicit-same-request" })
    );
    assert!(runtime_absent(&app, &project));
    let changes = call(
        &window,
        "read_project_changes",
        in_session(&project, json!({ "afterSequence": "0" })),
    );
    assert_eq!(changes["sequence"], "3");
    assert_eq!(changes["progressSequence"], "0");
    assert_eq!(changes["scopes"], json!(["project"]));
    let byte_order_mark = in_session(
        &project,
        json!({ "actionId": identity(), "conversationId": create["conversationId"], "messageId": identity(), "body": "\u{feff}" }),
    );
    assert_eq!(
        call(
            &window,
            "append_project_conversation_message",
            byte_order_mark
        )["body"],
        "\u{feff}"
    );

    // An empty runtime finishes quiescing immediately. Retain an owned cleanup
    // thread to exercise the real stopping boundary without dispatching work.
    let (release, blocked) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let _ = blocked.recv();
    });
    app.state::<AppState>().sessions.with(move |sessions| {
        let host = sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0;
        host.retired_queries
            .push(super::super::RetiredQuery::from_test_thread(
                ExecutionId::new(),
                thread,
            ));
    });
    assert_eq!(
        call(&window, "quiesce_execution", session(&project))["quiescing"],
        true
    );
    assert_eq!(
        call(&window, "create_project_conversation", create.clone()),
        first
    );
    assert_eq!(
        call(
            &window,
            "append_project_conversation_message",
            append.clone()
        ),
        sent
    );
    assert_eq!(
        call(
            &window,
            "recover_project_conversation_message",
            unknown.clone()
        )["outcome"],
        json!({ "kind": "pending", "replay": "blocked" })
    );
    assert!(reject(&window, "append_project_conversation_message", unknown).is_object());
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while call(&window, "quiesce_execution", session(&project))["quiescing"] == true {
        assert!(
            std::time::Instant::now() < deadline,
            "Owned cleanup did not settle"
        );
        std::thread::yield_now();
    }
    assert_eq!(
        call(
            &window,
            "close_project",
            json!({ "sessionToken": project["sessionToken"] })
        )["closed"],
        true
    );
    let reopened = call(&window, "open_project", json!({ "locator": destination }));
    assert_ne!(reopened["sessionToken"], project["sessionToken"]);
    assert_eq!(
        reject(
            &window,
            "recover_project_conversation_message",
            append.clone()
        )["code"],
        "session-invalid"
    );
    let mut original_create = create.clone();
    original_create["sessionToken"] = reopened["sessionToken"].clone();
    let mut original_append = append;
    original_append["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(
            &window,
            "recover_project_conversation_create",
            original_create
        )["outcome"],
        json!({ "kind": "recorded", "receipt": first })
    );
    assert_eq!(
        call(
            &window,
            "recover_project_conversation_message",
            original_append
        )["outcome"],
        json!({ "kind": "recorded", "receipt": sent })
    );
    assert!(runtime_absent(&app, &reopened));
    call(
        &window,
        "close_project",
        json!({ "sessionToken": reopened["sessionToken"] }),
    );
}

#[test]
fn conversation_ipc_pages_complete_messages_within_the_encoded_byte_limit() {
    let temporary = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({ "destination": temporary.path().join("project"), "displayName": "Bounded conversation IPC", "sourceLocale": "en", "targetLocales": ["zh-CN"] }),
    );
    let create = in_session(
        &project,
        json!({ "actionId": identity(), "conversationId": identity(), "title": "Long messages" }),
    );
    call(&window, "create_project_conversation", create.clone());
    let body = format!("{{name}} é 👩🏽‍💻\n{}", "\"\\\u{0001}".repeat(2600));
    assert!(body.len() <= MAX_CONVERSATION_MESSAGE_BYTES);
    let mut expected = Vec::new();
    for _ in 0..40 {
        let append = in_session(
            &project,
            json!({ "actionId": identity(), "conversationId": create["conversationId"], "messageId": identity(), "body": body }),
        );
        expected.push(call(&window, "append_project_conversation_message", append));
    }
    let mut after = Value::Null;
    let mut observed = Vec::new();
    let mut pages = 0;
    loop {
        let page = call(
            &window,
            "read_project_conversation_messages",
            in_session(
                &project,
                json!({ "conversationId": create["conversationId"], "after": after, "limit": 50 }),
            ),
        );
        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_CONVERSATION_PAGE_BYTES);
        let rows = page["rows"].as_array().unwrap();
        assert!(!rows.is_empty());
        assert!(
            rows.iter()
                .all(|row| row["body"] == body && row["author"] == "human")
        );
        observed.extend(rows.iter().cloned());
        pages += 1;
        assert!(pages <= 10);
        after = page["nextAfter"].clone();
        if after.is_null() {
            break;
        }
        assert_eq!(after, rows.last().unwrap()["ordinal"]);
    }
    assert!(pages > 1);
    assert_eq!(observed, expected);
    assert!(runtime_absent(&app, &project));
    assert!(
        reject(
            &window,
            "read_project_conversation_messages",
            in_session(
                &project,
                json!({ "conversationId": create["conversationId"], "after": null, "limit": 0 })
            )
        )
        .is_object()
    );
    call(
        &window,
        "close_project",
        json!({ "sessionToken": project["sessionToken"] }),
    );
}

fn planning_clock(
    app: &tauri::App<tauri::test::MockRuntime>,
    project: &Value,
) -> (String, u64, u64) {
    let token = project["sessionToken"].as_str().unwrap().to_owned();
    let id = ExecutionId::parse(project["metadata"]["projectId"].as_str().unwrap()).unwrap();
    tauri::async_runtime::block_on(app.state::<AppState>().sessions.run(
        "planning-test-clock",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(sessions, &token, id, CommandStage::ExecutionRead)?;
            let changes = active.store.changes_since(Revision::new(0).unwrap());
            Ok((
                changes.epoch,
                changes.sequence.get(),
                changes.progress_sequence.get(),
            ))
        },
    ))
    .unwrap()
}

#[test]
fn conversation_planning_ipc_keeps_one_readonly_capture_in_its_original_session() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("project");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({"destination": destination, "displayName":"Planning IPC", "sourceLocale":"en", "targetLocales":["zh-CN"]}),
    );
    let thread = call(
        &window,
        "create_project_conversation",
        in_session(
            &project,
            json!({"actionId":identity(),"conversationId":identity(),"title":null}),
        ),
    );
    let body = "  先解释 e\u{301} 👩🏽‍💻\r\n保留 {{name}}  ";
    let message = call(
        &window,
        "append_project_conversation_message",
        in_session(
            &project,
            json!({"actionId":identity(),"conversationId":thread["conversationId"],"messageId":identity(),"body":body}),
        ),
    );
    let config = tsumugi_core::ai::AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-planning".into(),
        credential_env: String::new(),
        max_requests: 1,
        ..Default::default()
    };
    let preparation = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"selectedMessageIds":[message["messageId"]],"scope":{"kind":"conversation-only"},"config":config}),
    );
    let before_changes = planning_clock(&app, &project);
    let before_bytes = std::fs::read(destination.join("project.sqlite3")).unwrap();
    let prepared = call(
        &window,
        "prepare_conversation_planning",
        preparation.clone(),
    );
    assert_eq!(prepared["preview"]["selectedMessages"], json!([message]));
    assert_eq!(prepared["preview"]["brief"]["messages"], 1);
    assert_eq!(prepared["preview"]["brief"]["units"], 0);
    assert_eq!(prepared["preview"]["units"], json!([]));
    let input: Value =
        serde_json::from_str(prepared["preview"]["input"].as_str().unwrap()).unwrap();
    assert_eq!(input["messages"], json!([{"author":"human","body":body}]));
    assert!(input.get("config").is_none());
    let validation = in_session(&project, json!({"preparationId":prepared["preparationId"]}));
    assert_eq!(
        call(
            &window,
            "validate_conversation_planning",
            validation.clone()
        ),
        prepared
    );
    let mut wrong = validation.clone();
    wrong["preparationId"] = json!(identity());
    assert!(!reject(&window, "validate_conversation_planning", wrong).is_null());
    let mut wrong = preparation.clone();
    wrong["projectId"] = json!(identity());
    assert_eq!(
        reject(&window, "prepare_conversation_planning", wrong)["code"],
        "session-invalid"
    );
    let mut wrong = preparation.clone();
    wrong["config"]["maxRequests"] = json!(2);
    assert!(!reject(&window, "prepare_conversation_planning", wrong).is_null());
    // A failed B preparation does not discard the already prepared A.
    assert_eq!(
        call(
            &window,
            "validate_conversation_planning",
            validation.clone()
        ),
        prepared
    );
    let mut spoofed = validation.clone();
    spoofed["preview"] = prepared["preview"].clone();
    assert!(!reject(&window, "validate_conversation_planning", spoofed).is_null());
    assert_eq!(
        std::fs::read(destination.join("project.sqlite3")).unwrap(),
        before_bytes
    );
    assert_eq!(planning_clock(&app, &project), before_changes);
    assert!(runtime_absent(&app, &project));

    // Replacing a local capture gives B a new identity; A is never refreshed.
    let mut next = preparation;
    next["config"]["model"] = json!("another-synthetic-model");
    let second = call(&window, "prepare_conversation_planning", next);
    assert_ne!(second["preparationId"], prepared["preparationId"]);
    assert!(
        !reject(
            &window,
            "validate_conversation_planning",
            validation.clone()
        )
        .is_null()
    );
    assert_eq!(
        second["preview"]["config"]["model"],
        "another-synthetic-model"
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    );
    let reopened = call(&window, "open_project", json!({"locator":destination}));
    let mut old = in_session(&reopened, json!({"preparationId":second["preparationId"]}));
    assert!(!reject(&window, "validate_conversation_planning", old.clone()).is_null());
    old["sessionToken"] = project["sessionToken"].clone();
    assert_eq!(
        reject(&window, "validate_conversation_planning", old)["code"],
        "session-invalid"
    );
    assert!(runtime_absent(&app, &reopened));
    call(
        &window,
        "close_project",
        json!({"sessionToken":reopened["sessionToken"]}),
    );
}

struct PlanningProvider {
    endpoint: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl PlanningProvider {
    fn new() -> Self {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::{
                Arc, Mutex,
                atomic::{AtomicBool, Ordering},
            },
            time::{Duration, Instant},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !stopping.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "planning provider did not stop");
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("planning provider accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                let header = loop {
                    let length = stream.read(&mut buffer).unwrap();
                    assert!(length > 0);
                    bytes.extend_from_slice(&buffer[..length]);
                    assert!(bytes.len() <= 96 * 1024);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = std::str::from_utf8(&bytes[..header]).unwrap();
                assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
                assert!(!headers.to_ascii_lowercase().contains("authorization:"));
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    })
                    .unwrap();
                assert!(length <= 64 * 1024);
                while bytes.len() < header + length {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    assert!(bytes.len() <= 96 * 1024);
                }
                let value = serde_json::from_slice(&bytes[header..header + length]).unwrap();
                {
                    let mut all = records.lock().unwrap();
                    assert!(all.is_empty(), "unexpected repeated planning request");
                    all.push(value);
                }
                let response=json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":json!({"kind":"reply","summary":"先确认要处理哪些条目。","questions":[]}).to_string()}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
        });
        Self {
            endpoint,
            stop,
            requests,
            worker: Some(worker),
        }
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
impl Drop for PlanningProvider {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        if let Some(worker) = self.worker.take() {
            if std::thread::panicking() {
                let _ = worker.join();
            } else {
                worker.join().unwrap();
            }
        }
    }
}

#[test]
fn conversation_planning_ipc_requires_explicit_permission_and_reopens_as_history() {
    let provider = PlanningProvider::new();
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("project");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({"destination":destination,"displayName":"Planning permission IPC","sourceLocale":"en","targetLocales":["zh-CN"]}),
    );
    let thread = call(
        &window,
        "create_project_conversation",
        in_session(
            &project,
            json!({"actionId":identity(),"conversationId":identity(),"title":null}),
        ),
    );
    let message = call(
        &window,
        "append_project_conversation_message",
        in_session(
            &project,
            json!({"actionId":identity(),"conversationId":thread["conversationId"],"messageId":identity(),"body":"  先解释 é 👩🏽‍💻\r\n保留 {{name}}  "}),
        ),
    );
    let config = tsumugi_core::ai::AiConfig {
        endpoint: provider.endpoint.clone(),
        model: "synthetic-planner".into(),
        credential_env: String::new(),
        max_requests: 1,
        ..Default::default()
    };
    let prepared = call(
        &window,
        "prepare_conversation_planning",
        in_session(
            &project,
            json!({"conversationId":thread["conversationId"],"selectedMessageIds":[message["messageId"]],"scope":{"kind":"conversation-only"},"config":config}),
        ),
    );
    assert_eq!(prepared["preview"]["version"], 2);
    assert!(runtime_absent(&app, &project));
    assert_eq!(provider.count(), 0);
    let action = identity();
    let task = identity();
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 60_000;
    let consent = json!({"actionId":action,"attemptId":action,"taskId":task,"previewDigest":prepared["previewDigest"],"expiresAtMs":expires.to_string(),"shareMessages":true,"shareUnits":false});
    let start = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"preparationId":prepared["preparationId"],"consent":consent}),
    );
    let recovery = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"consent":consent}),
    );
    assert_eq!(
        call(&window, "recover_conversation_planning", recovery.clone())["outcome"],
        json!({"kind":"pending","replay":"blocked"})
    );
    let mut bad = start.clone();
    bad["consent"]["shareMessages"] = false.into();
    assert!(!reject(&window, "start_conversation_planning", bad).is_null());
    let mut bad = start.clone();
    bad["consent"]["previewDigest"] = json!("0".repeat(64));
    assert!(!reject(&window, "start_conversation_planning", bad).is_null());
    assert_eq!(provider.count(), 0);
    assert!(runtime_absent(&app, &project));
    let receipt = call(&window, "start_conversation_planning", start.clone());
    assert_eq!(receipt["consent"], consent);
    assert_eq!(
        call(&window, "start_conversation_planning", start.clone()),
        receipt
    );
    let read = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"attemptId":action}),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let view = loop {
        let view = call(&window, "read_conversation_planning", read.clone());
        if view["output"].is_object() {
            break view;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "planning IPC did not finish: {view}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(view["receipt"], receipt);
    assert_eq!(view["detail"]["progress"]["succeeded"], 1);
    assert_eq!(view["detail"]["recovery"]["units"][0]["actions"], json!([]));
    assert_eq!(view["output"]["model"]["summary"], "先确认要处理哪些条目。");
    assert_eq!(view["output"]["usage"]["promptTokens"], "7");
    assert_eq!(view["budget"]["limit"], 1);
    assert_eq!(view["budget"]["dispatched"], 1);
    assert_eq!(provider.count(), 1);
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(
            requests[0]["messages"][0]["content"],
            prepared["preview"]["system"]
        );
        assert_eq!(
            requests[0]["messages"][1]["content"],
            prepared["preview"]["input"]
        );
        assert!(requests[0].get("material").is_none());
    }
    assert_eq!(
        call(&window, "recover_conversation_planning", recovery.clone())["outcome"],
        json!({"kind":"recorded","receipt":receipt})
    );
    let mut bad = recovery.clone();
    bad["consent"]["shareUnits"] = true.into();
    assert_eq!(
        call(&window, "recover_conversation_planning", bad)["outcome"],
        json!({"kind":"mismatch"})
    );
    let mut bad = read.clone();
    bad["conversationId"] = json!(identity());
    assert!(!reject(&window, "read_conversation_planning", bad).is_null());
    call(
        &window,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    );
    let reopened = call(&window, "open_project", json!({"locator":destination}));
    let history = call(
        &window,
        "read_conversation_planning",
        in_session(
            &reopened,
            json!({"conversationId":thread["conversationId"],"attemptId":action}),
        ),
    );
    assert_eq!(history["receipt"], receipt);
    assert_eq!(history["output"], view["output"]);
    assert!(runtime_absent(&app, &reopened));
    let mut repeat = start;
    repeat["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(&window, "start_conversation_planning", repeat),
        receipt
    );
    assert!(runtime_absent(&app, &reopened));
    assert_eq!(provider.count(), 1);
    assert_eq!(
        reject(&window, "read_conversation_planning", read)["code"],
        "session-invalid"
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":reopened["sessionToken"]}),
    );
}
