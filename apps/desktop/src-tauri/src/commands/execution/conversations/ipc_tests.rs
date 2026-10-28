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

fn journal_before_action(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    project: &Value,
    mut pending: Value,
) -> Value {
    let source = if pending["kind"] == "proposal-work-plan" {
        &pending["request"]["proposal"]
    } else {
        &pending["request"]
    };
    let key = json!({"projectId":source["projectId"],"conversationId":source["conversationId"]});
    let before = call(
        window,
        "read_local_conversation_draft",
        json!({"sessionToken":project["sessionToken"],"key":key}),
    );
    assert!(before["value"].is_null() || before["value"]["pending"].is_null());
    let seq = before["value"]["editSeq"]
        .as_str()
        .unwrap_or("0")
        .parse::<u64>()
        .unwrap()
        + 1;
    pending["submittedSeq"] = json!(seq.to_string());
    let mut write = json!({"key":key,"expectedRevision":before["revision"],"writerId":identity(),"value":{"text":"Input retained before the action","editSeq":seq.to_string(),"pending":pending}});
    let saved = call(
        window,
        "write_local_conversation_draft",
        json!({"sessionToken":project["sessionToken"],"write":write}),
    );
    write["expectedRevision"] = saved["revision"].clone();
    write["value"]["pending"] = Value::Null;
    write["value"]["editSeq"] = json!((seq + 1).to_string());
    write["value"]["text"] = json!("Newer B retained after the action");
    let resolve =
        json!({"sessionToken":project["sessionToken"],"resolve":{"write":write,"pending":pending}});
    assert!(
        !reject(window, "resolve_local_conversation_draft", resolve.clone()).is_null(),
        "missing original receipt cannot resolve the journal"
    );
    resolve
}

fn journal_after_action(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    resolve: &Value,
) -> Value {
    let saved = call(window, "resolve_local_conversation_draft", resolve.clone());
    assert_eq!(
        saved["value"]["text"],
        resolve["resolve"]["write"]["value"]["text"]
    );
    assert!(saved["value"]["pending"].is_null());
    assert_eq!(
        call(window, "resolve_local_conversation_draft", resolve.clone()),
        saved
    );
    saved
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
        Self::with_content(
            json!({"kind":"reply","summary":"先确认要处理哪些条目。","questions":[]}),
        )
    }
    fn with_content(content: Value) -> Self {
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
                let response=json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":content.to_string()}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}).to_string();
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
    let discover = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"after":"0","limit":50}),
    );
    let before_discovery = planning_clock(&app, &project);
    let empty = call(
        &window,
        "read_conversation_planning_attempts",
        discover.clone(),
    );
    assert_eq!(empty["rows"], json!([]));
    assert_eq!(empty["nextAfter"], Value::Null);
    assert_eq!(planning_clock(&app, &project), before_discovery);
    assert!(runtime_absent(&app, &project));
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
    let discovered = call(
        &window,
        "read_conversation_planning_attempts",
        discover.clone(),
    );
    assert_eq!(discovered["rows"].as_array().unwrap().len(), 1);
    assert_eq!(discovered["rows"][0]["attemptId"], action);
    assert_eq!(discovered["rows"][0]["taskId"], task);
    assert_eq!(discovered["nextAfter"], Value::Null);
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
    let before_discovery = planning_clock(&app, &reopened);
    assert_eq!(
        call(
            &window,
            "read_conversation_planning_attempts",
            in_session(
                &reopened,
                json!({"conversationId":thread["conversationId"],"after":"0","limit":50}),
            )
        ),
        discovered,
    );
    assert_eq!(planning_clock(&app, &reopened), before_discovery);
    assert!(runtime_absent(&app, &reopened));
    assert_eq!(provider.count(), 1);
    assert_eq!(
        reject(&window, "read_conversation_planning_attempts", discover)["code"],
        "session-invalid"
    );
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

#[test]
fn conversation_proposal_ipc_versions_authorization_and_candidate_history_use_original_owners() {
    let temporary = tempfile::tempdir().unwrap();
    let destination = temporary.path().join("project");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.state::<AppState>()
        .local_drafts
        .set(
            crate::commands::drafts::DraftStore::at(temporary.path().join("local-drafts")).unwrap(),
        )
        .ok()
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({"destination":destination,"displayName":"Proposal IPC","sourceLocale":"en","targetLocales":["zh-CN"]}),
    );
    let unit = app.state::<AppState>().sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let source = tsumugi_core::content::SourceBundle::capture(
            br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
            br#"{"first":"Keep {{name}}"}"#, "en").unwrap();
        let input = source.fixed_input(store.metadata().unwrap().project_id()).unwrap();
        host.runtime.submit(store, &input).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while host.active(store).unwrap() {
            host.tick(store).unwrap();
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        let result = store.execution_current_result(input.envelope().attempt_id, input.envelope().items[0].item_id).unwrap().unwrap();
        let preview = store.source_preview(input.envelope().attempt_id, result, 0, 1).unwrap();
        let action = store.prepare_adoption_with_id(ExecutionId::new(), input.envelope().attempt_id, input.envelope().units[0].unit_id,
            vec![result], serde_json::to_value(preview.confirmation).unwrap()).unwrap();
        store.adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler).unwrap();
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        store.source_content(snapshot, 0, 1).unwrap().rows.remove(0).unit_id.unwrap()
    });
    let content = json!({"kind":"proposal","summary":"先为这一条生成候选译文。","unitIds":[unit],"options":tsumugi_core::application::PlanOptions::default(),"questions":[]});
    let provider = PlanningProvider::with_content(content.clone());
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
            json!({"actionId":identity(),"conversationId":thread["conversationId"],"messageId":identity(),"body":"为这一条准备候选，保留 {{name}}。"}),
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
            json!({"conversationId":thread["conversationId"],"selectedMessageIds":[message["messageId"]],"scope":{"kind":"units","locale":"zh-CN","unitIds":[unit]},"config":config}),
        ),
    );
    assert_eq!(provider.count(), 0);
    let attempt = identity();
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 60_000;
    let start = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"preparationId":prepared["preparationId"],"consent":{"actionId":attempt,"attemptId":attempt,"taskId":identity(),"previewDigest":prepared["previewDigest"],"expiresAtMs":expires.to_string(),"shareMessages":true,"shareUnits":true}}),
    );
    let mut action = original(&start);
    action.as_object_mut().unwrap().remove("preparationId");
    let planning_journal = journal_before_action(
        &window,
        &project,
        json!({"kind":"planning","request":action,"preparationId":prepared["preparationId"]}),
    );
    call(&window, "start_conversation_planning", start);
    journal_after_action(&window, &planning_journal);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let view = loop {
        let view = call(
            &window,
            "read_conversation_planning",
            in_session(
                &project,
                json!({"conversationId":thread["conversationId"],"attemptId":attempt}),
            ),
        );
        if view["output"].is_object() {
            break view;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "planning result did not finish: {view}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(view["output"]["model"], content);
    let capture = in_session(
        &project,
        json!({"actionId":identity(),"conversationId":thread["conversationId"],"proposalId":identity(),"revisionId":identity(),"attemptId":attempt,"resultId":view["resultId"]}),
    );
    let pending = call(
        &window,
        "recover_conversation_proposal_capture",
        capture.clone(),
    );
    assert_eq!(pending["request"], original(&capture));
    assert_eq!(
        pending["outcome"],
        json!({"kind":"pending","replay":"explicit-same-request"})
    );
    let mut injected = capture.clone();
    injected["content"] = content.clone();
    assert!(!reject(&window, "capture_conversation_proposal", injected).is_null());
    let capture_journal = journal_before_action(
        &window,
        &project,
        json!({"kind":"proposal-capture","request":original(&capture)}),
    );
    let first = call(&window, "capture_conversation_proposal", capture.clone());
    journal_after_action(&window, &capture_journal);
    assert_eq!(first["content"], content);
    assert_eq!(first["revision"], "1");
    assert_eq!(first["ordinal"], "1");
    assert!(first["previousRevisionId"].is_null());
    assert_eq!(first["origin"]["attemptId"], json!(attempt));
    assert_eq!(
        call(&window, "capture_conversation_proposal", capture.clone()),
        first
    );
    let read = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"proposalId":first["proposalId"],"revisionId":null}),
    );
    assert_eq!(
        call(&window, "read_conversation_proposal", read.clone()),
        first
    );
    let mut edited = content.clone();
    edited["summary"] = json!("  只保留候选 é 👩🏽‍💻\r\n保留 {{name}}  ");
    let revise = in_session(
        &project,
        json!({"actionId":identity(),"conversationId":thread["conversationId"],"proposalId":first["proposalId"],"revisionId":identity(),"expectedRevisionId":first["revisionId"],"content":edited}),
    );
    let revision_journal = journal_before_action(
        &window,
        &project,
        json!({"kind":"proposal-revision","request":original(&revise)}),
    );
    let second = call(&window, "revise_conversation_proposal", revise.clone());
    journal_after_action(&window, &revision_journal);
    assert_eq!(second["content"], edited);
    assert_eq!(second["origin"], first["origin"]);
    assert_eq!(second["revision"], "2");
    assert_eq!(second["previousRevisionId"], first["revisionId"]);
    assert_eq!(
        call(&window, "revise_conversation_proposal", revise.clone()),
        second
    );
    assert_eq!(
        call(&window, "capture_conversation_proposal", capture.clone()),
        first
    );
    assert_eq!(
        call(&window, "read_conversation_proposal", read.clone()),
        second
    );
    let mut old = read.clone();
    old["revisionId"] = first["revisionId"].clone();
    assert_eq!(
        call(&window, "read_conversation_proposal", old.clone()),
        first
    );
    assert!(!reject(&window, "validate_conversation_proposal", old).is_null());
    let mut valid = read.clone();
    valid["revisionId"] = second["revisionId"].clone();
    assert_eq!(
        call(&window, "validate_conversation_proposal", valid.clone()),
        second
    );
    let mut conflict = revise.clone();
    conflict["actionId"] = json!(identity());
    conflict["revisionId"] = json!(identity());
    assert!(!reject(&window, "revise_conversation_proposal", conflict).is_null());
    let feed = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"after":null,"limit":1}),
    );
    let page = call(
        &window,
        "read_conversation_proposal_revisions",
        feed.clone(),
    );
    assert_eq!(page["rows"], json!([first]));
    assert_eq!(page["nextAfter"], first["ordinal"]);
    let mut next = feed;
    next["after"] = page["nextAfter"].clone();
    let page = call(&window, "read_conversation_proposal_revisions", next);
    assert_eq!(page["rows"], json!([second]));
    assert!(page["nextAfter"].is_null());
    let mut mismatch = revise.clone();
    mismatch["content"]["summary"] = json!("Different request");
    assert_eq!(
        call(&window, "recover_conversation_proposal_revision", mismatch)["outcome"],
        json!({"kind":"mismatch"})
    );
    let mut foreign = read.clone();
    foreign["conversationId"] = json!(identity());
    assert!(!reject(&window, "read_conversation_proposal", foreign).is_null());
    call(
        &window,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    );
    let reopened = call(&window, "open_project", json!({"locator":destination}));
    let mut history = read.clone();
    history["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&window, "read_conversation_proposal", history), second);
    let mut recover = revise;
    recover["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(
            &window,
            "recover_conversation_proposal_revision",
            recover.clone()
        )["outcome"],
        json!({"kind":"recorded","receipt":second})
    );
    valid["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(&window, "validate_conversation_proposal", valid),
        second
    );
    assert!(runtime_absent(&app, &reopened));
    recover["actionId"] = json!(identity());
    recover["revisionId"] = json!(identity());
    recover["expectedRevisionId"] = second["revisionId"].clone();
    recover["content"]["summary"] = json!("重开后调整这份建议。");
    let latest = call(&window, "revise_conversation_proposal", recover);
    assert_eq!(latest["revision"], "3");
    assert!(runtime_absent(&app, &reopened));
    assert_eq!(provider.count(), 1);
    assert_eq!(
        reject(&window, "read_conversation_proposal", read)["code"],
        "session-invalid"
    );
    let current = proposal_work_plan_flow(&app, &window, &reopened, &latest, unit, &destination);
    call(
        &window,
        "close_project",
        json!({"sessionToken":current["sessionToken"]}),
    );
}

fn proposal_work_plan_flow(
    app: &tauri::App<tauri::test::MockRuntime>,
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    project: &Value,
    revision: &Value,
    unit: ExecutionId,
    destination: &std::path::Path,
) -> Value {
    let provider = PlanningProvider::with_content(
        json!({"unitId":unit,"targetLocale":"zh-CN","text":"保留 {{name}} 的候选译文。"}),
    );
    let config = tsumugi_core::ai::AiConfig {
        endpoint: provider.endpoint.clone(),
        model: "synthetic-translation".into(),
        credential_env: String::new(),
        max_requests: 1,
        ..Default::default()
    };
    let reference = json!({"projectId":project["metadata"]["projectId"],"conversationId":revision["conversationId"],"proposalId":revision["proposalId"],"revisionId":revision["revisionId"]});
    let prepare = in_session(
        project,
        json!({"proposal":reference,"config":config,"advisoryChecks":[],"toolSelection":null}),
    );
    let old = call(
        window,
        "prepare_conversation_proposal_work_plan",
        prepare.clone(),
    );
    assert_eq!(old["proposal"], reference);
    assert_eq!(old["plan"]["preview"]["config"], json!(config));
    assert_eq!(provider.count(), 0);
    let mut edit = revision["content"].clone();
    edit["summary"] = json!("保留候选，交给人工决定。");
    let revised = call(
        window,
        "revise_conversation_proposal",
        in_session(
            project,
            json!({"actionId":identity(),"conversationId":revision["conversationId"],"proposalId":revision["proposalId"],"revisionId":identity(),"expectedRevisionId":revision["revisionId"],"content":edit}),
        ),
    );
    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let old_authorization = json!({"actionId":identity(),"proposal":reference,"planId":old["plan"]["planId"],"planDigest":old["plan"]["digest"],"confirmed":true,"effects":["save-candidate"],"expiresAt":expiry.to_string(),"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]});
    assert!(
        !reject(
            window,
            "authorize_conversation_proposal_work_plan",
            in_session(project, json!({"authorization":old_authorization}))
        )
        .is_null()
    );
    assert_eq!(provider.count(), 0);
    let mut prepare = prepare;
    prepare["proposal"]["revisionId"] = revised["revisionId"].clone();
    let prepared = call(window, "prepare_conversation_proposal_work_plan", prepare);
    let authorization = json!({"actionId":identity(),"proposal":prepared["proposal"],"planId":prepared["plan"]["planId"],"planDigest":prepared["plan"]["digest"],"confirmed":true,"effects":["save-candidate"],"expiresAt":expiry.to_string(),"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]});
    let approve = in_session(project, json!({"authorization":authorization}));
    let generic = in_session(
        project,
        json!({"actionId":authorization["actionId"],"planId":authorization["planId"],"digest":authorization["planDigest"],"confirmed":true,"effects":authorization["effects"],"expiresAt":authorization["expiresAt"],"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]}),
    );
    assert!(!reject(window, "authorize_work_plan", generic.clone()).is_null());
    let mut denied = approve.clone();
    denied["authorization"]["confirmed"] = false.into();
    assert!(!reject(window, "authorize_conversation_proposal_work_plan", denied).is_null());
    assert_eq!(provider.count(), 0);
    let authorization_journal = journal_before_action(
        window,
        project,
        json!({"kind":"proposal-work-plan","request":authorization}),
    );
    let accepted = call(
        window,
        "authorize_conversation_proposal_work_plan",
        approve.clone(),
    );
    let journal_receipt = journal_after_action(window, &authorization_journal);
    assert_eq!(accepted["link"]["revisionId"], revised["revisionId"]);
    assert_eq!(accepted["link"]["planId"], prepared["plan"]["planId"]);
    assert_eq!(accepted["receipt"]["actionId"], authorization["actionId"]);
    assert_eq!(
        call(
            window,
            "authorize_conversation_proposal_work_plan",
            approve.clone()
        ),
        accepted
    );
    assert_eq!(provider.count(), 0);
    let page = call(
        window,
        "read_conversation_proposal_work_plans",
        in_session(
            project,
            json!({"conversationId":revision["conversationId"],"after":null,"limit":50}),
        ),
    );
    assert_eq!(page["rows"], json!([accepted["link"]]));
    let attempt = call(
        window,
        "start_work_plan",
        in_session(
            project,
            json!({"planId":authorization["planId"],"actionId":authorization["actionId"],"expectedGeneration":accepted["receipt"]["lease"]["generation"]}),
        ),
    );
    assert_eq!(attempt, accepted["receipt"]["attemptId"]);
    let candidate_read = in_session(
        project,
        json!({"locale":"zh-CN","sourceSnapshotId":prepared["plan"]["scope"][0]["sourceSnapshotId"],"scopeId":null,"unitIds":[unit],"state":"available","afterOrdinal":null,"readVersion":null}),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let candidates = loop {
        let candidates = call(
            window,
            "read_translation_candidate_slice",
            candidate_read.clone(),
        );
        if candidates["rows"][0]["revisions"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
        {
            break candidates;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "authorized work did not save its candidate: {candidates}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    let candidate = &candidates["rows"][0]["revisions"][0];
    assert_eq!(candidate["text"], "保留 {{name}} 的候选译文。");
    assert!(candidates["rows"][0]["target"]["selectionId"].is_null());
    let effect = call(
        window,
        "read_ai_candidate_effect",
        in_session(
            project,
            json!({"unitId":unit,"locale":"zh-CN","revisionId":candidate["revisionId"]}),
        ),
    );
    assert_eq!(effect["planId"], authorization["planId"]);
    assert_eq!(effect["attemptId"], attempt);
    assert_eq!(provider.count(), 1);
    let project_id =
        ExecutionId::parse(project["metadata"]["projectId"].as_str().unwrap()).unwrap();
    let idle_deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        let token = project["sessionToken"].as_str().unwrap().to_owned();
        let idle = tauri::async_runtime::block_on(app.state::<AppState>().sessions.run(
            "proposal-test-original-drain",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(sessions, &token, project_id, CommandStage::ExecutionRead)?;
                match active.execution.as_ref() {
                    Some(host) => host.active(&active.store).map(|active| !active),
                    None => Ok(true),
                }
            },
        ))
        .unwrap();
        if idle {
            break;
        }
        assert!(
            std::time::Instant::now() < idle_deadline,
            "original WorkPlan did not drain after saving its candidate"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    call(
        window,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    );
    let reopened = call(window, "open_project", json!({"locator":destination}));
    let mut repeated = approve;
    repeated["sessionToken"] = reopened["sessionToken"].clone();
    assert!(runtime_absent(app, &reopened));
    let mut recovered_journal = authorization_journal;
    recovered_journal["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        journal_after_action(window, &recovered_journal),
        journal_receipt
    );
    assert!(runtime_absent(app, &reopened));
    assert_eq!(
        call(
            window,
            "authorize_conversation_proposal_work_plan",
            repeated.clone()
        ),
        accepted
    );
    assert!(runtime_absent(app, &reopened));
    let recovered = call(
        window,
        "recover_conversation_proposal_work_plan",
        repeated.clone(),
    );
    assert_eq!(recovered["request"], authorization);
    assert_eq!(
        recovered["outcome"],
        json!({"kind":"recorded","receipt":accepted["link"]})
    );
    let link = call(
        window,
        "read_conversation_proposal_work_plan",
        in_session(
            &reopened,
            json!({"conversationId":revision["conversationId"],"planId":authorization["planId"]}),
        ),
    );
    assert_eq!(link, accepted["link"]);
    let mut wrong = repeated.clone();
    wrong["authorization"]["toolExecution"] = true.into();
    assert_eq!(
        call(window, "recover_conversation_proposal_work_plan", wrong)["outcome"],
        json!({"kind":"mismatch"})
    );
    let mut missing = repeated;
    missing["authorization"]["actionId"] = json!(identity());
    missing["authorization"]["planId"] = json!(identity());
    assert_eq!(
        call(
            window,
            "recover_conversation_proposal_work_plan",
            missing.clone()
        )["outcome"],
        json!({"kind":"pending","replay":"blocked"})
    );
    assert!(!reject(window, "authorize_conversation_proposal_work_plan", missing).is_null());
    let mut generic = generic;
    generic["sessionToken"] = reopened["sessionToken"].clone();
    assert!(!reject(window, "authorize_work_plan", generic).is_null());
    assert!(runtime_absent(app, &reopened));
    assert_eq!(provider.count(), 1);
    reopened
}
