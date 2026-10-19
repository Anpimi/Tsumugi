//! The production member factory, Core HTTP/budget owner and an actual SDK
//! query process share one synthetic project. No external model is contacted.
use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::mpsc,
};

#[derive(Clone, Copy)]
enum Mode {
    Complete,
    HttpStall,
    ToolStall,
}

fn configure_member(setup: &Setup) {
    let source = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_MEMBER_ARTIFACT")
            .expect("explicit built member artifact required"),
    );
    let resources = setup.fixture.directory.path().join("resources");
    let target = resources.join("member-runtime");
    fn copy(source: &Path, target: &Path) {
        let metadata = fs::symlink_metadata(source).unwrap();
        assert!(
            !metadata.file_type().is_symlink(),
            "artifact fixture must be link-free"
        );
        if metadata.is_dir() {
            fs::create_dir_all(target).unwrap();
            for entry in fs::read_dir(source).unwrap() {
                let entry = entry.unwrap();
                copy(&entry.path(), &target.join(entry.file_name()));
            }
        } else {
            assert!(metadata.is_file());
            fs::copy(source, target).unwrap();
        }
    }
    copy(&source, &target);
    setup
        .fixture
        .app
        .state::<AppState>()
        .plugins
        .configure_member_bundle(Some(resources))
        .unwrap();
}
fn request(socket: &mut TcpStream) -> (String, Value) {
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut part = [0; 4096];
    let end = loop {
        let n = socket.read(&mut part).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&part[..n]);
        assert!(bytes.len() < 131072);
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = std::str::from_utf8(&bytes[..end]).unwrap();
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(!headers.to_ascii_lowercase().contains("authorization:"));
    let length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|n| n.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    while bytes.len() < end + length {
        let n = socket.read(&mut part).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&part[..n]);
    }
    let raw = String::from_utf8(bytes[end..end + length].to_vec()).unwrap();
    let body = serde_json::from_str(&raw).unwrap();
    (raw, body)
}
fn respond(socket: &mut TcpStream, kind: &str, body: &str) {
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
}
fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                socket.set_nonblocking(false).unwrap();
                return socket;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "bounded loopback request did not arrive"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("{error}"),
        }
    }
}
fn member_pid(staging: &Path) -> u32 {
    let children = std::process::Command::new("/usr/bin/pgrep")
        .args(["-P", &std::process::id().to_string()])
        .output()
        .unwrap();
    assert!(
        children.status.success(),
        "owned test children must be inspectable"
    );
    let children = String::from_utf8(children.stdout)
        .unwrap()
        .split_whitespace()
        .map(|pid| pid.parse::<u32>().unwrap().to_string())
        .collect::<Vec<_>>()
        .join(",");
    let output = std::process::Command::new("/bin/ps")
        .args(["-ww", "-o", "pid=,args=", "-p", &children])
        .output()
        .unwrap();
    assert!(output.status.success());
    let paths = staging.to_str().unwrap();
    let matches = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter(|line| line.contains(paths) && line.contains("worker.mjs"))
        .map(|line| {
            line.split_whitespace()
                .next()
                .unwrap()
                .parse::<u32>()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        matches.len(),
        1,
        "exact member child under this fixture required"
    );
    matches[0]
}
fn provider(
    setup: &Setup,
    mode: Mode,
) -> (
    AiConfig,
    mpsc::Receiver<u32>,
    std::thread::JoinHandle<(Vec<String>, bool)>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let config = AiConfig {
        endpoint: format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        ),
        model: "synthetic-member".into(),
        credential_env: String::new(),
        max_requests: 3,
        timeout_seconds: 30,
        ..AiConfig::default()
    };
    let staging = setup._installation.0.path().join("application");
    let (started, observed) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let mut calls = Vec::new();
        let mut root = accept(&listener);
        let (raw, body) = request(&mut root);
        calls.push(raw);
        assert_eq!(body["stream"], false);
        let item: Value =
            serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
        let root_output=json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":"root candidate"}).to_string();
        respond(&mut root,"application/json",&json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":root_output}}],
            "usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string());
        drop(root);
        let mut first = accept(&listener);
        let (raw, body) = request(&mut first);
        calls.push(raw);
        assert_eq!(body["stream"], true);
        let pid = member_pid(&staging);
        assert_ne!(pid, std::process::id());
        if matches!(mode, Mode::HttpStall) {
            write!(first,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nB\r\n: waiting\n\n\r\n").unwrap();
            first.flush().unwrap();
            started.send(pid).unwrap();
            let mut byte = [0];
            let closed = first.read(&mut byte).unwrap() == 0;
            return (calls, closed);
        }
        started.send(pid).unwrap();
        let name = body["tools"][0]["function"]["name"].as_str().unwrap();
        let arguments = json!({"unitId":item["unitId"]}).to_string();
        let tool = json!({"id":"synthetic-tool-turn","object":"chat.completion.chunk","created":1,"model":"synthetic-member",
            "choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"lookup-source","type":"function","function":{"name":name,"arguments":arguments}}]},"finish_reason":null}]});
        let finish = json!({"id":"synthetic-tool-turn","object":"chat.completion.chunk","created":1,"model":"synthetic-member",
            "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":2}});
        respond(
            &mut first,
            "text/event-stream",
            &format!("data: {tool}\n\ndata: {finish}\n\ndata: [DONE]\n\n"),
        );
        drop(first);
        if matches!(mode, Mode::ToolStall) {
            return (calls, false);
        }
        let mut second = accept(&listener);
        let (raw, body) = request(&mut second);
        calls.push(raw);
        let tools = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["role"] == "tool")
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["tool_call_id"], "lookup-source");
        assert!(tools[0]["content"].as_str().unwrap().contains("Hello"));
        let output=json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":"Pi used the controlled query"}).to_string();
        let text = json!({"id":"synthetic-final-turn","object":"chat.completion.chunk","created":1,"model":"synthetic-member",
            "choices":[{"index":0,"delta":{"role":"assistant","content":output},"finish_reason":null}]});
        let finish = json!({"id":"synthetic-final-turn","object":"chat.completion.chunk","created":1,"model":"synthetic-member",
            "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        // Missing usage stays unknown rather than using normalized Pi zeros.
        respond(
            &mut second,
            "text/event-stream",
            &format!("data: {text}\n\ndata: {finish}\n\ndata: [DONE]\n\n"),
        );
        (calls, false)
    });
    (config, observed, thread)
}
fn start(setup: &Setup, grant: &Value) -> (Value, Value) {
    let scope = setup
        .fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[setup.fixture.unit]});
    let preflight = setup
        .fixture
        .call(
            "prepare_work_plan_agent_generation",
            json!({"scopeId":scope["scopeId"],"generation":generation}),
        )
        .unwrap();
    setup.fixture.call("start_work_plan_agent_generation",json!({"scopeId":scope["scopeId"],"generation":generation,"inputDigest":preflight["inputDigest"]})).unwrap();
    (scope, generation)
}
fn absent(pid: u32) {
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success(),
        "owned child was not reaped"
    );
}
fn query_entered(setup: &Setup) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(text) =
            fs::read_to_string(setup.fixture.directory.path().join("query-observer.jsonl"))
        {
            if let Some(row) = text
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|row| row["stage"] == "entered")
            {
                return row["pid"].as_u64().unwrap().try_into().unwrap();
            }
        }
        assert!(
            Instant::now() < deadline,
            "actual query process was not entered"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn tool_attempts(setup: &Setup) -> Vec<String> {
    let connection =
        rusqlite::Connection::open(setup.fixture.project_path.join("project.sqlite3")).unwrap();
    let mut statement = connection
        .prepare("SELECT attempt_id FROM application_executions WHERE kind='tool'")
        .unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn pi_member_real_process_core_transport_original_query_and_unknown_usage_reopen() {
    let setup = Setup::new(false);
    configure_member(&setup);
    let (config, node, provider) = provider(&setup, Mode::Complete);
    let (_plan, grant) = setup.start_plan(config);
    let (scope, generation) = start(&setup, &grant);
    let node = node.recv_timeout(Duration::from_secs(60)).unwrap();
    let terminal = setup.wait_terminal(&generation["attemptId"]);
    assert_eq!(
        terminal["items"][0]["status"]["execution"], "succeeded",
        "{terminal}"
    );
    absent(node);
    let query = query_entered(&setup);
    assert_ne!(query, node);
    assert_ne!(query, std::process::id());
    absent(query);
    let output=setup.fixture.call("read_execution_output",json!({"attemptId":generation["attemptId"],"resultId":terminal["items"][0]["resultId"]})).unwrap();
    assert_eq!(output["output"]["text"], "Pi used the controlled query");
    assert_eq!(output["output"]["requests"], 2);
    assert_eq!(output["output"]["usageIncomplete"], true);
    assert_eq!(
        output["output"]["usage"],
        json!({"promptTokens":10,"completionTokens":2})
    );
    let (calls, _) = provider.join().unwrap();
    assert_eq!(calls.len(), 3);
    let attempt = generation["attemptId"].as_str().unwrap();
    let connection =
        rusqlite::Connection::open(setup.fixture.project_path.join("project.sqlite3")).unwrap();
    let mut statement=connection.prepare("SELECT capture,usage,state FROM execution_provider_requests WHERE attempt_id=?1 ORDER BY rowid").unwrap();
    let requests = statement
        .query_map([attempt], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Option<Vec<u8>>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(requests.len(), 2);
    for (index, (capture, _, state)) in requests.iter().enumerate() {
        let capture: Value = serde_json::from_slice(capture).unwrap();
        assert_eq!(capture["body"], calls[index + 1]);
        assert_eq!(state, "response");
    }
    assert!(requests[0].1.is_some());
    assert!(requests[1].1.is_none());
    drop(statement);
    drop(connection);
    let tools = tool_attempts(&setup);
    assert_eq!(tools.len(), 1);
    let tool = setup.wait_terminal(&json!(tools[0]));
    assert_eq!(tool["items"][0]["status"]["execution"], "succeeded");
    setup.fixture.call("close_project", json!({})).unwrap();
    let reopened = ProjectStore::open(&setup.fixture.project_path).unwrap();
    let root: ExecutionId = serde_json::from_value(scope["parentTask"].clone()).unwrap();
    let budget = reopened.provider_budget(root).unwrap().unwrap();
    assert_eq!(
        (budget.dispatched, budget.unresolved, budget.usage_unknown),
        (3, 0, 1)
    );
    assert_eq!(
        (
            budget.prompt_tokens.as_str(),
            budget.completion_tokens.as_str()
        ),
        ("11", "3")
    );
    assert_eq!(
        reopened
            .execution_attempt(
                serde_json::from_value(generation["attemptId"].clone()).unwrap(),
                false
            )
            .unwrap()
            .progress
            .succeeded,
        1
    );
}

#[test]
fn pi_member_cancel_during_physical_request_closes_socket_and_reaps_member() {
    let setup = Setup::new(false);
    configure_member(&setup);
    let (config, node, provider) = provider(&setup, Mode::HttpStall);
    let (_plan, grant) = setup.start_plan(config);
    let (scope, generation) = start(&setup, &grant);
    let node = node.recv_timeout(Duration::from_secs(60)).unwrap();
    setup
        .fixture
        .call(
            "cancel_execution_task",
            json!({"taskId":generation["taskId"],"requestId":ExecutionId::new()}),
        )
        .unwrap();
    let terminal = setup.wait_terminal(&generation["attemptId"]);
    assert_ne!(terminal["items"][0]["status"]["execution"], "succeeded");
    absent(node);
    let (calls, closed) = provider.join().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(closed, "Core must close actual pending SSE on cancellation");
    assert!(tool_attempts(&setup).is_empty());
    let task: ExecutionId = serde_json::from_value(scope["parentTask"].clone()).unwrap();
    let budget = setup
        .fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .provider_budget(task)
                .unwrap()
                .unwrap()
        });
    assert_eq!(
        (budget.dispatched, budget.unresolved, budget.usage_unknown),
        (2, 1, 1)
    );
}

#[test]
fn pi_member_pause_revokes_original_scope_during_physical_request() {
    let setup = Setup::new(false);
    configure_member(&setup);
    let (config, node, provider) = provider(&setup, Mode::HttpStall);
    let (plan, grant) = setup.start_plan(config);
    let (scope, generation) = start(&setup, &grant);
    let node = node.recv_timeout(Duration::from_secs(60)).unwrap();
    let receipt = setup
        .fixture
        .call(
            "control_work_plan",
            json!({
                "actionId":ExecutionId::new(),"planId":plan["planId"],
                "expectedGeneration":grant["lease"]["generation"],"command":"pause",
                "confirmed":false,"checkerExecutions":[],"toolExecution":false,
                "applicationToolExecutions":[],"expiresAt":null
            }),
        )
        .unwrap();
    assert_ne!(receipt["lease"], grant["lease"]);
    let terminal = setup.wait_terminal(&generation["attemptId"]);
    assert_ne!(terminal["items"][0]["status"]["execution"], "succeeded");
    absent(node);
    let (calls, closed) = provider.join().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(
        closed,
        "revoked scope must close the original pending HTTP socket"
    );
    assert!(tool_attempts(&setup).is_empty());
    let denied = setup.fixture.call(
        "prepare_work_plan_agent_generation",
        json!({
            "scopeId":scope["scopeId"],"generation":generation
        }),
    );
    assert!(
        denied.is_err(),
        "pause must revoke the original Agent scope"
    );
}

#[test]
fn pi_member_cancel_during_actual_query_reaps_both_owned_processes() {
    let setup = Setup::new(true);
    configure_member(&setup);
    let (config, node, provider) = provider(&setup, Mode::ToolStall);
    let (_plan, grant) = setup.start_plan(config);
    let (_, generation) = start(&setup, &grant);
    let node = node.recv_timeout(Duration::from_secs(60)).unwrap();
    let query = query_entered(&setup);
    assert_ne!(node, query);
    setup
        .fixture
        .call(
            "cancel_execution_task",
            json!({"taskId":generation["taskId"],"requestId":ExecutionId::new()}),
        )
        .unwrap();
    let terminal = setup.wait_terminal(&generation["attemptId"]);
    assert_ne!(terminal["items"][0]["status"]["execution"], "succeeded");
    let attempts = tool_attempts(&setup);
    assert_eq!(attempts.len(), 1);
    let child = setup.wait_terminal(&json!(attempts[0]));
    assert_ne!(child["items"][0]["status"]["execution"], "succeeded");
    assert!(child["items"][0]["resultId"].is_null());
    absent(node);
    absent(query);
    assert_eq!(provider.join().unwrap().0.len(), 2);
}
