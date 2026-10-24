use super::*;
use rmcp::model::*;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{
        Condvar,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::{content, execution::*};
// The currently prepared built-in member distribution is macOS arm64. These
// scenarios use its actual approved bytes, not a synthetic member executor.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[path = "tests/pi_member.rs"]
mod pi_member;

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
    .map(|v| v.deserialize().unwrap())
}

#[derive(Clone, Copy, Debug)]
enum Mode {
    Success,
    Eof,
    Invalid,
    IsError,
    Hold,
    HugeFrame,
    Flood,
    Redirect,
    ModelOversize,
}
struct Server {
    endpoint: String,
    calls: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<Value>>>,
    released: Arc<(Mutex<bool>, Condvar)>,
    stopped: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let released = Arc::new((Mutex::new(false), Condvar::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let (count, seen, gate, end, location) = (
            calls.clone(),
            requests.clone(),
            released.clone(),
            stopped.clone(),
            endpoint.clone(),
        );
        let thread = std::thread::spawn(move || {
            while !end.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        socket
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        socket
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut reader = BufReader::new(socket.try_clone().unwrap());
                        let mut line = String::new();
                        if reader.read_line(&mut line).is_err() {
                            continue;
                        }
                        let method = line.split_whitespace().next().unwrap_or("").to_owned();
                        let mut length = 0usize;
                        let mut header_bytes = line.len();
                        loop {
                            line.clear();
                            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                                break;
                            }
                            header_bytes += line.len();
                            assert!(header_bytes < 32768);
                            if let Some((name, value)) = line.split_once(':') {
                                if name.eq_ignore_ascii_case("content-length") {
                                    length = value.trim().parse().unwrap();
                                }
                            }
                        }
                        assert!(length <= 128 * 1024);
                        let mut body = vec![0; length];
                        if reader.read_exact(&mut body).is_err() {
                            continue;
                        }
                        if method != "POST" {
                            let _ = socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            continue;
                        }
                        // The fixture parses and constructs the official SDK's
                        // protocol types; production never uses a JSON wrapper.
                        let message: ClientJsonRpcMessage = serde_json::from_slice(&body).unwrap();
                        seen.lock()
                            .unwrap()
                            .push(serde_json::to_value(&message).unwrap());
                        let JsonRpcMessage::Request(request) = message else {
                            continue;
                        };
                        if matches!(mode, Mode::Redirect) {
                            let _ = write!(
                                socket,
                                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            );
                            continue;
                        }
                        let result = match request.request {
                            ClientRequest::DiscoverRequest(_) => ServerResult::DiscoverResult(
                                DiscoverResult::new(
                                    vec![ProtocolVersion::LATEST],
                                    ServerCapabilities::builder().enable_tools().build(),
                                )
                                .with_server_info(
                                    Implementation::new("synthetic-terminology", "1"),
                                ),
                            ),
                            ClientRequest::ListToolsRequest(_) => {
                                let input =
                                    tsumugi_core::application::mcp_term_query_input_schema()
                                        .as_object()
                                        .unwrap()
                                        .clone();
                                let mut tool = Tool::new(
                                    "lookup_terms",
                                    "Synthetic literal terminology lookup",
                                    input,
                                );
                                tool.output_schema = Some(Arc::new(
                                    tsumugi_core::application::mcp_term_query_output_schema()
                                        .as_object()
                                        .unwrap()
                                        .clone(),
                                ));
                                ServerResult::ListToolsResult(ListToolsResult::with_all_items(
                                    vec![tool],
                                ))
                            }
                            ClientRequest::CallToolRequest(_) => {
                                count.fetch_add(1, Ordering::AcqRel);
                                if matches!(mode, Mode::Eof) {
                                    continue;
                                }
                                if matches!(mode, Mode::Hold) {
                                    let (lock, ready) = &*gate;
                                    let open = lock.lock().unwrap();
                                    let (open, wait) = ready
                                        .wait_timeout_while(open, Duration::from_secs(10), |v| !*v)
                                        .unwrap();
                                    assert!(
                                        *open || end.load(Ordering::Acquire),
                                        "test did not release accepted call: {wait:?}"
                                    );
                                }
                                let output = if matches!(mode, Mode::ModelOversize) {
                                    json!({"entries":[
                                        {"id":"a","source":"Copper","target":"x".repeat(16384),"reason":"Large valid proposal"},
                                        {"id":"b","source":"Copper","target":"y".repeat(16384),"reason":"Large valid proposal"}
                                    ]})
                                } else if matches!(mode, Mode::Invalid) {
                                    json!({"entries":[],"uri":"file:///untrusted"})
                                } else {
                                    json!({"entries":[{"id":"copper","source":"Copper","target":"铜","reason":"Synthetic external suggestion"}]})
                                };
                                ServerResult::CallToolResult(if matches!(mode, Mode::IsError) {
                                    CallToolResult::error(vec![])
                                } else {
                                    CallToolResult::structured(output)
                                })
                            }
                            _ => {
                                panic!("unexpected external capability");
                            }
                        };
                        let message: ServerJsonRpcMessage =
                            JsonRpcMessage::response(result, request.id);
                        let mut encoded = serde_json::to_vec(&message).unwrap();
                        if matches!(mode, Mode::HugeFrame) {
                            encoded.splice(0..0, std::iter::repeat_n(b' ', 128 * 1024));
                        }
                        if matches!(mode, Mode::Flood) {
                            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                            // Ignored SSE comments still consume the connection
                            // byte budget before the official parser sees them.
                            let comment = format!(":{}\n\n", "x".repeat(8190));
                            for _ in 0..80 {
                                if socket.write_all(comment.as_bytes()).is_err() {
                                    break;
                                }
                            }
                        } else {
                            let _ = write!(
                                socket,
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                encoded.len()
                            );
                            let _ = socket.write_all(&encoded);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("synthetic listener failed: {error}"),
                }
            }
        });
        Self {
            endpoint,
            calls,
            requests,
            released,
            stopped,
            thread: Some(thread),
        }
    }
    fn release(&self) {
        *self.released.0.lock().unwrap() = true;
        self.released.1.notify_all();
    }
    fn wait_call(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.calls.load(Ordering::Acquire) == 0 {
            assert!(Instant::now() < deadline, "call never reached server");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.release();
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    directory: tempfile::TempDir,
    context: Value,
    unit: ExecutionId,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .invoke_handler(execution::production_handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let project = call(&window, "create_project", json!({"destination":directory.path().join("project"),"displayName":"Synthetic MCP retrieval","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
        let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
        let unit = app.state::<AppState>().sessions.with(|sessions| {
            let store = &mut sessions.active.as_mut().unwrap().store;
            let bundle = content::SourceBundle::capture(
                include_bytes!(
                    "../../../../../../crates/core/tests/fixtures/stardew-lookup/manifest.json"
                ),
                &serde_json::to_vec(&json!({"entry":"Copper synthetic source"})).unwrap(),
                "en",
            )
            .unwrap();
            let input = bundle
                .fixed_input(store.metadata().unwrap().project_id())
                .unwrap();
            let mut runtime = ExecutionRuntime::new(store).unwrap();
            runtime
                .register_read_only(Arc::new(content::SourceRunner))
                .unwrap();
            runtime.submit(store, &input).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let result = loop {
                runtime.tick(store).unwrap();
                if let Some(id) = store
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id,
                    )
                    .unwrap()
                {
                    break id;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(2));
            };
            let preview = store
                .source_preview(input.envelope().attempt_id, result, 0, 1)
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
                .adopt_execution(&action, &content::SourceAdoptionHandler)
                .unwrap();
            let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
            store.source_content(snapshot, 0, 1).unwrap().rows[0]
                .unit_id
                .unwrap()
        });
        Self {
            app,
            window,
            directory,
            context,
            unit,
        }
    }
    fn request(&self, body: Value) -> Value {
        let mut request = self.context.clone();
        request
            .as_object_mut()
            .unwrap()
            .extend(body.as_object().unwrap().clone());
        request
    }
    fn sequence(&self) -> Revision {
        self.app.state::<AppState>().sessions.with(|s| {
            s.active
                .as_ref()
                .unwrap()
                .store
                .execution_sequence()
                .unwrap()
        })
    }
    fn no_host(&self) {
        self.app
            .state::<AppState>()
            .sessions
            .with(|s| assert!(s.active.as_ref().unwrap().execution.is_none()));
    }
    fn discovery(&self, endpoint: &str) -> Value {
        let session = call(
            &self.window,
            "read_mcp_retrieval_session",
            self.context.clone(),
        )
        .unwrap();
        json!({"identity":{"generation":session["nextGeneration"],"actionId":ExecutionId::new()},"endpoint":endpoint,"credentialEnv":null,"expiresAtMs":now_ms().unwrap()+120000,"allowDiscovery":true})
    }
    fn read(&self, discovery: &Value) -> Value {
        call(
            &self.window,
            "read_mcp_retrieval",
            self.request(json!({"identity":discovery["identity"]})),
        )
        .unwrap()
    }
    fn wait(&self, discovery: &Value, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let view = self.read(discovery);
            if predicate(&view) {
                return view;
            }
            assert!(
                Instant::now() < deadline,
                "MCP retrieval did not settle: {view}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn discover(&self, discovery: &Value) -> Value {
        call(
            &self.window,
            "discover_mcp_terms",
            self.request(json!({"discovery":discovery})),
        )
        .unwrap();
        self.wait(discovery, |view| view["phase"] != "discovering")
    }
    fn prepare(&self, discovery: &Value) -> Value {
        let ready = self.discover(discovery);
        assert_eq!(ready["phase"], "ready");
        assert_eq!(ready["tools"].as_array().unwrap().len(), 1);
        let query = json!({"projectId":self.context["projectId"],"actionId":ExecutionId::new(),"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitId":self.unit,"locale":"zh-CN","query":"Copper","expiresAtMs":discovery["expiresAtMs"],"tool":ready["tools"][0]});
        call(
            &self.window,
            "prepare_mcp_term_query",
            self.request(json!({"identity":discovery["identity"],"query":query})),
        )
        .unwrap()
    }
    fn consent(prepared: &Value) -> Value {
        json!({"actionId":prepared["query"]["actionId"],"inputDigest":prepared["preview"]["inputDigest"],"expiresAtMs":prepared["query"]["expiresAtMs"],"shareQuery":true})
    }
    fn start(&self, discovery: &Value, consent: &Value) -> Value {
        call(
            &self.window,
            "start_mcp_term_query",
            self.request(json!({"identity":discovery["identity"],"consent":consent})),
        )
        .unwrap()
    }
    fn result(&self, task: &Value) -> FixedResult {
        let attempt = ExecutionId::parse(task["attemptId"].as_str().unwrap()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let result = self.app.state::<AppState>().sessions.with(move |s| {
                let store = &s.active.as_ref().unwrap().store;
                let input = store.execution_input(attempt).unwrap();
                store
                    .execution_current_result(attempt, input.envelope().items[0].item_id)
                    .unwrap()
                    .map(|id| store.execution_result(attempt, id).unwrap())
            });
            if let Some(result) = result {
                return result;
            }
            assert!(Instant::now() < deadline, "query never produced a result");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn stop(&self, discovery: &Value) -> Value {
        let stop = json!({"identity":discovery["identity"],"actionId":ExecutionId::new(),"discovery":discovery});
        let receipt = call(
            &self.window,
            "stop_mcp_retrieval",
            self.request(json!({"stop":stop})),
        )
        .unwrap();
        assert_eq!(receipt["request"], stop);
        assert_eq!(receipt["view"]["stop"], stop);
        assert_eq!(receipt["view"]["admissionClosed"], true);
        receipt
    }
}

#[test]
fn mcp_retrieval_local_reads_and_stop_before_discovery_do_not_create_runtime_or_network() {
    let f = Fixture::new();
    let server = Server::new(Mode::Success);
    let sequence = f.sequence();
    let discovery = f.discovery(&server.endpoint);
    f.no_host();
    let mut invalid = discovery.clone();
    invalid["allowDiscovery"] = json!(false);
    assert!(
        call(
            &f.window,
            "discover_mcp_terms",
            f.request(json!({"discovery":invalid}))
        )
        .is_err()
    );
    let stop = f.stop(&discovery);
    assert_eq!(stop["view"]["callbacksDrained"], true);
    let late = call(
        &f.window,
        "discover_mcp_terms",
        f.request(json!({"discovery":discovery})),
    )
    .unwrap();
    assert_eq!(late["admissionClosed"], true);
    let mut changed = discovery.clone();
    changed["endpoint"] = json!("http://127.0.0.1:1/changed");
    assert!(
        call(
            &f.window,
            "discover_mcp_terms",
            f.request(json!({"discovery":changed}))
        )
        .is_err()
    );
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(f.sequence(), sequence);
    f.no_host();
    let mut foreign = f.request(json!({"identity":discovery["identity"]}));
    foreign["projectId"] = json!(ExecutionId::new());
    assert!(call(&f.window, "read_mcp_retrieval", foreign).is_err());
}

#[test]
fn mcp_retrieval_http_query_uses_original_ledger_capture_and_manual_adoption() {
    let f = Fixture::new();
    let server = Server::new(Mode::Success);
    let sequence = f.sequence();
    let discovery = f.discovery(&server.endpoint);
    let prepared = f.prepare(&discovery);
    f.no_host();
    assert_eq!(f.sequence(), sequence);
    let consent = Fixture::consent(&prepared);
    let mut denied = consent.clone();
    denied["shareQuery"] = json!(false);
    assert!(
        call(
            &f.window,
            "start_mcp_term_query",
            f.request(json!({"identity":discovery["identity"],"consent":denied}))
        )
        .is_err()
    );
    f.no_host();
    let started = f.start(&discovery, &consent);
    assert_eq!(started["phase"], "enqueued");
    assert_eq!(started["consent"], consent);
    let result = f.result(&started["task"]);
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    assert!(result.envelope().plugin.is_none());
    assert_eq!(f.start(&discovery, &consent)["task"], started["task"]);
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
    let requests = server.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["method"], "server/discover");
    assert_eq!(requests[1]["method"], "tools/list");
    assert_eq!(requests[2]["method"], "tools/call");
    assert_eq!(
        requests[2]["params"]["arguments"],
        json!({"query":"Copper","sourceLocale":"en","targetLocale":"zh-CN"})
    );
    let capture_request = f.request(json!({"actionId":ExecutionId::new(),"attemptId":started["task"]["attemptId"],"resultId":result.envelope().result_id}));
    let captured = call(&f.window, "capture_mcp_glossary", capture_request.clone()).unwrap();
    let preview = call(
        &f.window,
        "read_resource_preview",
        f.request(json!({"captureId":captured["capture"]["captureId"]})),
    )
    .unwrap();
    assert_eq!(preview["mcp"]["current"], true);
    assert_eq!(preview["capture"]["origin"]["kind"], "mcp");
    assert_eq!(
        call(
            &f.window,
            "read_terms",
            f.request(json!({"locale":"zh-CN","afterTermId":null,"limit":100}))
        )
        .unwrap(),
        json!([])
    );
    let decision = json!({"projectId":f.context["projectId"],"actionId":ExecutionId::new(),"captureId":captured["capture"]["captureId"],"entryId":"copper","expectedRevisionId":null,"decision":"adopt"});
    let adopted = call(
        &f.window,
        "decide_resource_entry",
        f.request(json!({"decision":decision})),
    )
    .unwrap();
    assert_eq!(adopted["revision"]["target"], "铜");
    assert_eq!(adopted["revision"]["originKind"], "external");
    f.stop(&discovery);
    f.wait(&discovery, |v| v["callbacksDrained"] == true);
    // Both recent and older accepted starts are data-only acknowledgements.
    for _ in 0..2 {
        let next = f.discovery(&server.endpoint);
        let ready = f.discover(&next);
        assert_eq!(ready["phase"], "ready");
        f.stop(&next);
        f.wait(&next, |v| v["callbacksDrained"] == true);
    }
    let old = f.start(&discovery, &consent);
    assert_eq!(old["task"], started["task"]);
    assert_eq!(old["discovery"], discovery);
    assert_eq!(old["admissionClosed"], true);
    assert_eq!(old["callbacksDrained"], false);
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
    let mut wrong = consent.clone();
    wrong["expiresAtMs"] = json!(1);
    assert!(
        call(
            &f.window,
            "start_mcp_term_query",
            f.request(json!({"identity":discovery["identity"],"consent":wrong}))
        )
        .is_err()
    );
    call(
        &f.window,
        "close_project",
        json!({"sessionToken":f.context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &f.window,
        "open_project",
        json!({"locator":f.directory.path().join("project")}),
    )
    .unwrap();
    let context =
        json!({"sessionToken":reopened["sessionToken"],"projectId":f.context["projectId"]});
    assert!(
        call(
            &f.window,
            "read_mcp_retrieval",
            f.request(json!({"identity":discovery["identity"]}))
        )
        .is_err()
    );
    let mut old_identity = context.clone();
    old_identity["identity"] = discovery["identity"].clone();
    assert!(call(&f.window, "read_mcp_retrieval", old_identity).is_err());
    let session = call(&f.window, "read_mcp_retrieval_session", context.clone()).unwrap();
    assert!(session["current"].is_null());
    let mut historical = capture_request;
    historical["sessionToken"] = context["sessionToken"].clone();
    assert_eq!(
        call(&f.window, "capture_mcp_glossary", historical).unwrap(),
        captured
    );
    f.no_host();
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
}

#[test]
fn mcp_retrieval_post_dispatch_eof_is_unknown_and_terminal_rejections_do_not_recall() {
    for (mode, expected) in [
        (Mode::Eof, ExecutionState::Unknown),
        (Mode::Invalid, ExecutionState::Failed),
        (Mode::IsError, ExecutionState::Failed),
    ] {
        let f = Fixture::new();
        let server = Server::new(mode);
        let discovery = f.discovery(&server.endpoint);
        let prepared = f.prepare(&discovery);
        let consent = Fixture::consent(&prepared);
        let started = f.start(&discovery, &consent);
        let result = f.result(&started["task"]);
        assert_eq!(result.envelope().outcome, expected);
        assert!(result.envelope().output.is_none());
        assert!(!result.envelope().diagnostic.as_ref().unwrap().retry_safe);
        assert_eq!(f.start(&discovery, &consent)["task"], started["task"]);
        assert_eq!(server.calls.load(Ordering::Acquire), 1);
        f.stop(&discovery);
        f.wait(&discovery, |v| v["callbacksDrained"] == true);
    }
}

#[test]
fn mcp_retrieval_stop_discards_late_http_success_and_preserves_unknown_attempt() {
    let f = Fixture::new();
    let server = Server::new(Mode::Hold);
    let discovery = f.discovery(&server.endpoint);
    let prepared = f.prepare(&discovery);
    let consent = Fixture::consent(&prepared);
    let started = f.start(&discovery, &consent);
    server.wait_call();
    let stop = f.stop(&discovery);
    assert_eq!(stop["view"]["task"], started["task"]);
    server.release();
    let result = f.result(&started["task"]);
    assert_eq!(result.envelope().outcome, ExecutionState::Unknown);
    assert!(result.envelope().output.is_none());
    f.wait(&discovery, |v| v["callbacksDrained"] == true);
    assert_eq!(f.start(&discovery, &consent)["task"], started["task"]);
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
}

#[test]
fn mcp_retrieval_stop_after_prepare_prevents_query_admission_without_creating_runtime() {
    let f = Fixture::new();
    let server = Server::new(Mode::Success);
    let sequence = f.sequence();
    let discovery = f.discovery(&server.endpoint);
    let prepared = f.prepare(&discovery);
    let mut changed = prepared["query"].clone();
    changed["tool"]["discoveryExpiresAtMs"] = json!(1);
    assert!(
        call(
            &f.window,
            "prepare_mcp_term_query",
            f.request(json!({"identity":discovery["identity"],"query":changed}))
        )
        .is_err()
    );
    f.stop(&discovery);
    f.wait(&discovery, |v| v["callbacksDrained"] == true);
    assert!(
        call(
            &f.window,
            "start_mcp_term_query",
            f.request(
                json!({"identity":discovery["identity"],"consent":Fixture::consent(&prepared)})
            )
        )
        .is_err()
    );
    assert_eq!(server.calls.load(Ordering::Acquire), 0);
    assert_eq!(f.sequence(), sequence);
    f.no_host();
}

#[test]
fn mcp_retrieval_queued_cancel_reaps_exact_call_and_allows_a_new_query() {
    let f = Fixture::new();
    let server = Server::new(Mode::Success);
    let discovery = f.discovery(&server.endpoint);
    let prepared = f.prepare(&discovery);
    let consent: McpTermQueryConsent = serde_json::from_value(Fixture::consent(&prepared)).unwrap();
    let identity: McpRetrievalIdentity =
        serde_json::from_value(discovery["identity"].clone()).unwrap();
    // Keep original enqueue and cancellation in one actor operation, before a
    // runtime tick can dispatch. This controls the real queued state without
    // adding a test-only scheduler or transport hook.
    let task = f.app.state::<AppState>().sessions.with(move |s| {
        let active = s.active.as_mut().unwrap();
        let intent = s.mcp_retrieval.current.as_mut().unwrap();
        assert_eq!(intent.view.identity, identity);
        let prepared = intent.prepared.as_ref().unwrap().clone();
        let permit = active
            .store
            .authorize_mcp_term_query(&prepared, &consent)
            .unwrap();
        let call = execution::mcp_retrieval::Call::new(
            prepared,
            permit.clone(),
            intent.connection.as_ref().unwrap().clone(),
        );
        let task = execution::mcp_retrieval::start(active, call).unwrap();
        intent.permit = Some(permit);
        intent.view.consent = Some(consent);
        intent.view.task = Some(task.clone());
        intent.view.phase = McpRetrievalPhase::Enqueued;
        assert_eq!(
            active
                .store
                .execution_attempt(task.attempt_id, true)
                .unwrap()
                .items[0]
                .execution,
            ExecutionState::Queued
        );
        assert!(!intent.view(active).callbacks_drained);
        // No worker exists yet: commit the same original cancellation ledger
        // fact, then let the production Host tick retire its exact queued Call.
        active
            .store
            .cancel_execution(task.task_id, ExecutionId::new())
            .unwrap();
        task
    });
    f.stop(&discovery);
    f.wait(&discovery, |v| v["callbacksDrained"] == true);
    assert_eq!(server.calls.load(Ordering::Acquire), 0);
    let next = f.discovery(&server.endpoint);
    let prepared = f.prepare(&next);
    let next_task = f.start(&next, &Fixture::consent(&prepared));
    let result = f.result(&next_task["task"]);
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    assert_ne!(next_task["task"]["attemptId"], json!(task.attempt_id));
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
    f.stop(&next);
    f.wait(&next, |v| v["callbacksDrained"] == true);
}

#[test]
fn mcp_retrieval_http_cumulative_and_frame_limits_and_redirect_do_not_create_runtime() {
    for mode in [Mode::HugeFrame, Mode::Flood, Mode::Redirect] {
        let f = Fixture::new();
        let server = Server::new(mode);
        let sequence = f.sequence();
        let discovery = f.discovery(&server.endpoint);
        let view = f.discover(&discovery);
        assert!(matches!(
            view["phase"].as_str(),
            Some("unknown" | "failed" | "closed")
        ));
        assert_eq!(view["admissionClosed"], true);
        f.wait(&discovery, |v| v["callbacksDrained"] == true);
        assert_eq!(server.calls.load(Ordering::Acquire), 0);
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "mode={mode:?}, view={view}"
        );
        assert_eq!(f.sequence(), sequence);
        f.no_host();
    }
}

#[test]
fn mcp_retrieval_executor_shutdown_rejects_late_transport_registration() {
    let shutdown = Shutdown::default();
    shutdown.close();
    let control = transport::Control::new(Instant::now() + Duration::from_secs(10));
    assert_eq!(
        shutdown.install(&control).unwrap_err().code,
        CommandErrorCode::SessionInvalid
    );
    assert!(control.closed());
    assert!(control.drained());
    let owner = Retrievals::default();
    let shutdown = owner.shutdown.clone();
    let control = transport::Control::new(Instant::now() + Duration::from_secs(10));
    shutdown.install(&control).unwrap();
    drop(owner);
    assert!(control.closed());
    let late = transport::Control::new(Instant::now() + Duration::from_secs(10));
    assert!(shutdown.install(&late).is_err());
    assert!(late.closed());
}

#[test]
fn mcp_retrieval_strict_wire_requires_nullable_credential_and_rejects_free_paths() {
    let value = json!({"identity":{"generation":"1","actionId":ExecutionId::new()},"endpoint":"https://example.invalid/mcp","credentialEnv":null,"expiresAtMs":1,"allowDiscovery":true});
    let mut missing = value.clone();
    missing.as_object_mut().unwrap().remove("credentialEnv");
    assert!(serde_json::from_value::<McpRetrievalDiscovery>(missing).is_err());
    let mut extra = value.clone();
    extra["command"] = json!("unapproved-program");
    assert!(serde_json::from_value::<McpRetrievalDiscovery>(extra).is_err());
    assert_eq!(
        serde_json::to_value(
            serde_json::from_value::<McpRetrievalDiscovery>(value.clone()).unwrap()
        )
        .unwrap(),
        value
    );
    for endpoint in [
        "http://localhost/mcp",
        "https://example.invalid/mcp?token=secret",
        "https://user:secret@example.invalid/mcp",
        "https://example.invalid/mcp#secret",
    ] {
        assert!(transport::endpoint(endpoint).is_err());
    }
    for reference in [
        "OPENAI_API_KEY",
        "TSUMUGI_MCP_CLIENT_",
        "TSUMUGI_MCP_CLIENT_invalid",
    ] {
        assert!(transport::credential(&Some(reference.into())).is_err());
    }
}
