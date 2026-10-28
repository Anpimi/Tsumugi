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
