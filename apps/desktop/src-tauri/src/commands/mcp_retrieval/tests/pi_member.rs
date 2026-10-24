//! Actual Pi, the existing MCP SDK, original ledger and loopback-only services.
use super::*;
use std::{net::TcpStream, sync::mpsc};
use tsumugi_core::execution::ErrorCode as ExecutionErrorCode;
use tsumugi_core::{ai::AiConfig, application::PlanOptions};

struct PreservedFixture(Option<Fixture>);
impl PreservedFixture {
    fn new() -> Self {
        Self(Some(Fixture::new()))
    }
}
impl std::ops::Deref for PreservedFixture {
    type Target = Fixture;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}
impl Drop for PreservedFixture {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Some(fixture) = self.0.take()
        {
            let path = fixture.directory.keep();
            eprintln!("retained synthetic Pi MCP evidence at {}", path.display());
        }
    }
}

struct Cleanup<'a>(&'a Fixture);
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            let state = self.0.app.state::<AppState>();
            let token = tauri::async_runtime::block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    state.sessions.run(
                        "pi_mcp.cleanup",
                        CommandStage::ExecutionCancel,
                        |sessions| Ok(sessions.active.as_ref().map(|active| active.token.clone())),
                    ),
                )
                .await
            });
            let token = match token {
                Ok(Ok(Some(token))) => token,
                Ok(Ok(None)) => return,
                _ => {
                    // The fixture owner may already have stopped on the first
                    // failure. Do not turn it into a destructor double panic.
                    state.sessions.close_external_disclosures();
                    eprintln!("Pi MCP cleanup owner unavailable; drain remains unconfirmed");
                    return;
                }
            };
            if call(
                &self.0.window,
                "close_project",
                json!({"sessionToken":token}),
            )
            .is_ok()
            {
                return;
            }
            if Instant::now() >= until {
                assert!(
                    std::thread::panicking(),
                    "original member session did not drain"
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

struct Peer(TcpListener);
struct Http {
    socket: TcpStream,
    raw: String,
    body: Value,
}
impl Peer {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        Self(listener)
    }
    fn config(&self) -> AiConfig {
        AiConfig {
            endpoint: format!(
                "http://{}/v1/chat/completions",
                self.0.local_addr().unwrap()
            ),
            model: "synthetic-pi-mcp".into(),
            credential_env: String::new(),
            max_requests: 5,
            timeout_seconds: 45,
            ..AiConfig::default()
        }
    }
    fn next(&self) -> Http {
        let until = Instant::now() + Duration::from_secs(60);
        let mut socket = loop {
            match self.0.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until, "expected physical model request");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("{error}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut part = [0u8; 4096];
        let end = loop {
            let n = socket.read(&mut part).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&part[..n]);
            assert!(bytes.len() <= 131072);
            if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
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
                    .map(|value| value.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        assert!(length <= 32768);
        while bytes.len() < end + length {
            let n = socket.read(&mut part).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&part[..n]);
        }
        let raw = String::from_utf8(bytes[end..end + length].to_vec()).unwrap();
        let body = serde_json::from_str(&raw).unwrap();
        Http { socket, raw, body }
    }
    fn empty(&self) {
        assert!(
            matches!(self.0.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }
}
impl Http {
    fn respond(mut self, kind: &str, body: String) {
        write!(self.socket, "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    }
    fn root(self, unit: ExecutionId) {
        assert_eq!(self.body["stream"], false);
        let output = json!({"unitId":unit,"targetLocale":"zh-CN","text":"Original root candidate"})
            .to_string();
        self.respond("application/json", json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":output}}],
            "usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string());
    }
    fn tool(self, id: &str, unit: ExecutionId) {
        assert_eq!(self.body["stream"], true);
        let chunks = [
            json!({"id":"synthetic-pi-mcp","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":"lookup_captured_terms","arguments":json!({"unitId":unit}).to_string()}}]},"finish_reason":null}]}),
            json!({"id":"synthetic-pi-mcp","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
            json!({"id":"synthetic-pi-mcp","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
        ];
        self.respond(
            "text/event-stream",
            chunks
                .into_iter()
                .map(|chunk| format!("data: {chunk}\n\n"))
                .collect::<String>()
                + "data: [DONE]\n\n",
        );
    }
    fn finish(self, unit: ExecutionId) {
        let output = json!({"unitId":unit,"targetLocale":"zh-CN","text":"Pi used the captured MCP suggestion"}).to_string();
        let chunks = [
            json!({"id":"synthetic-pi-mcp","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":output},"finish_reason":null}]}),
            json!({"id":"synthetic-pi-mcp","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
            json!({"id":"synthetic-pi-mcp","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
        ];
        self.respond(
            "text/event-stream",
            chunks
                .into_iter()
                .map(|chunk| format!("data: {chunk}\n\n"))
                .collect::<String>()
                + "data: [DONE]\n\n",
        );
    }
}

impl Fixture {
    fn ipc(&self, name: &str, body: Value) -> Value {
        call(&self.window, name, self.request(body)).unwrap()
    }
    fn member_plan(&self, preview: &Value, peer: &Peer) -> (Value, Value) {
        let mut options = serde_json::to_value(PlanOptions::default()).unwrap();
        options["mcpTermQuery"] = json!({"profile":"fixed-term-query-1","preview":preview});
        let plan = self.ipc(
            "prepare_work_plan",
            json!({"config":peer.config(),"locale":"zh-CN","unitIds":[self.unit],
            "options":options,"advisoryChecks":[],"toolSelection":null,"maintenance":null}),
        );
        let grant = self.ipc("authorize_work_plan", json!({"planId":plan["planId"],"digest":plan["digest"],
            "actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":[],"toolExecution":false,
            "applicationToolExecutions":[],"effects":["save-candidate","query-tools"],
            "expiresAt":(now_ms().unwrap()/1000+90).to_string()}));
        self.ipc(
            "start_work_plan",
            json!({"planId":plan["planId"],"actionId":grant["actionId"],
            "expectedGeneration":grant["lease"]["generation"]}),
        );
        peer.next().root(self.unit);
        self.terminal(&grant["attemptId"]);
        self.saved_effect(&grant["attemptId"]);
        (plan, grant)
    }
    fn start_member(&self, grant: &Value) -> Value {
        let scope = self.ipc(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        );
        let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[self.unit]});
        let prepared = self.ipc(
            "prepare_work_plan_agent_generation",
            json!({"scopeId":scope["scopeId"],"generation":generation}),
        );
        self.ipc(
            "start_work_plan_agent_generation",
            json!({"scopeId":scope["scopeId"],"generation":generation,
            "inputDigest":prepared["inputDigest"]}),
        );
        generation
    }
    fn terminal(&self, attempt: &Value) -> Value {
        let id: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            let view = self.ipc(
                "read_execution_attempt",
                json!({"attemptId":attempt,"offset":0,"limit":100}),
            );
            let terminal = view["items"].as_array().unwrap().iter().all(|item| {
                !matches!(
                    item["status"]["execution"].as_str(),
                    Some("queued" | "dispatched")
                )
            });
            let drained = self.app.state::<AppState>().sessions.with(move |sessions| {
                !execution::mcp_retrieval::owned(sessions.active.as_ref().unwrap(), id)
            });
            if terminal && drained {
                return view;
            }
            assert!(
                Instant::now() < until,
                "original work did not terminate and drain: {view}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn captures(&self, attempt: &Value) -> Vec<Value> {
        let connection = rusqlite::Connection::open_with_flags(
            self.directory.path().join("project/project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut query = connection.prepare("SELECT state,capture FROM execution_provider_requests WHERE attempt_id=?1 ORDER BY rowid").unwrap();
        query
            .query_map([attempt.as_str().unwrap()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?))
            })
            .unwrap()
            .map(|row| {
                let (state, bytes) = row.unwrap();
                // A legacy request can have a settled report without a member
                // capture. Preserve its row, state and actual SQL NULL.
                let capture = bytes.map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap());
                json!({"state":state,"capture":capture})
            })
            .collect()
    }
    fn saved_effect(&self, attempt: &Value) -> Value {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            let view = self.ipc("read_ai_translation", json!({"attemptId":attempt}));
            let row = &view["rows"][0];
            let phase = row["automation"]["phase"].as_str();
            if phase == Some("saved") && !row["savedRevisionId"].is_null() {
                return view;
            }
            let diagnostic = json!({
                "status":view["detail"]["items"][0]["status"],
                "phase":row["automation"]["phase"],
                "error":row["automation"]["error"],
                "physicalRequests":self.captures(attempt).len(),
            });
            assert!(
                !matches!(phase, Some("failed" | "cancelled" | "blocked")),
                "candidate effect did not save: {diagnostic}"
            );
            assert!(
                Instant::now() < until,
                "candidate effect did not settle: {diagnostic}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

struct HeldRunner {
    entered: mpsc::SyncSender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}
impl Runner for HeldRunner {
    fn capability_id(&self) -> &str {
        "synthetic-mcp-ordinary"
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        self.entered.send(()).unwrap();
        let (lock, ready) = &*self.release;
        let mut released = lock.lock().unwrap();
        while !*released && !cancellation.is_requested() {
            released = ready
                .wait_timeout(released, Duration::from_millis(20))
                .unwrap()
                .0;
        }
        if cancellation.is_requested() {
            return Err(ExecutionError::new(
                ExecutionErrorCode::Cancelled,
                "synthetic-held",
            ));
        }
        results.send(FixedResult::capture(
            ResultEnvelope {
                plugin: None,
                project_id: request.input.envelope().project_id,
                attempt_id: request.input.envelope().attempt_id,
                item_id: request.item_id,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: request.dispatch_token,
                capability_id: self.capability_id().into(),
                capability_version: self.capability_version().into(),
                outcome: ExecutionState::Succeeded,
                output: Some(json!({"released":true})),
                diagnostic: None,
            },
            &request.input,
            request.dispatch_token,
        )?)
    }
}
struct Held {
    attempt: ExecutionId,
    release: Arc<(Mutex<bool>, Condvar)>,
}
impl Drop for Held {
    fn drop(&mut self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
}
fn hold_shared(fixture: &Fixture) -> Held {
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered, receiving) = mpsc::sync_channel(1);
    let runner = Arc::new(HeldRunner {
        entered,
        release: release.clone(),
    });
    let attempt = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_mut().unwrap();
            let store = &active.store;
            let bundle = content::SourceBundle::capture(
                include_bytes!(
                    "../../../../../../../crates/core/tests/fixtures/stardew-lookup/manifest.json"
                ),
                &serde_json::to_vec(&json!({"entry":"Copper synthetic source"})).unwrap(),
                "en",
            )
            .unwrap();
            let mut input = bundle
                .fixed_input(store.metadata().unwrap().project_id())
                .unwrap()
                .envelope()
                .clone();
            input.operation = "synthetic-mcp-ordinary".into();
            input.capability_id = runner.capability_id().into();
            input.capability_version = runner.capability_version().into();
            input.limits.timeout_ms = 60000;
            let input = FixedInput::capture(input).unwrap();
            execution::mcp_retrieval::submit_read_only_for_test(active, runner, &input).unwrap();
            input.envelope().attempt_id
        });
    receiving.recv_timeout(Duration::from_secs(10)).unwrap();
    Held { attempt, release }
}

#[test]
fn pi_mcp_fixed_query_runs_in_dependency_reserve_and_rereads_one_original_success() {
    let _runtime;
    let fixture = PreservedFixture::new();
    _runtime = execution::test_fixtures::provision_member_runtime(
        &fixture.app.state::<AppState>().plugins,
        &fixture.directory.path().join("member-resources"),
    );
    let _cleanup = Cleanup(&fixture);
    let server = Server::new(Mode::Hold);
    let discovery = fixture.discovery(&server.endpoint);
    let prepared = fixture.prepare(&discovery);
    let peer = Peer::new();
    let (plan, grant) = fixture.member_plan(&prepared["preview"], &peer);
    assert_eq!(server.calls.load(Ordering::Acquire), 0);
    assert!(
        call(
            &fixture.window,
            "start_mcp_term_query",
            fixture.request(json!({"identity":discovery["identity"],
        "consent":Fixture::consent(&prepared)}))
        )
        .is_err()
    );
    let held = hold_shared(&fixture);
    let generation = fixture.start_member(&grant);
    let first = peer.next();
    assert!(first.raw.contains("lookup_captured_terms"));
    assert!(!first.raw.contains("credentialEnv"));
    assert!(!first.raw.contains(&server.endpoint));
    first.tool("first-lookup", fixture.unit);
    server.wait_call();
    let member_attempt: ExecutionId =
        serde_json::from_value(generation["attemptId"].clone()).unwrap();
    let query_attempt: ExecutionId =
        serde_json::from_value(prepared["query"]["attemptId"].clone()).unwrap();
    let ordinary_attempt = held.attempt;
    let active = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_ref().unwrap();
            [ordinary_attempt, member_attempt, query_attempt]
                .map(|attempt| execution::mcp_retrieval::active_for_test(active, attempt))
        });
    assert_eq!(
        active, [true; 3],
        "all three real producers must be active before the MCP reply"
    );
    server.release();
    let second = peer.next();
    let messages = second.body["messages"].as_array().unwrap();
    let reply = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    assert_eq!(reply["tool_call_id"], "first-lookup");
    let shared: Value = serde_json::from_str(reply["content"].as_str().unwrap()).unwrap();
    assert_eq!(shared["kind"], "untrusted-mcp-terms");
    assert_eq!(shared["attemptId"], prepared["query"]["attemptId"]);
    assert_eq!(shared["inputDigest"], prepared["preview"]["inputDigest"]);
    assert_eq!(shared["output"]["entries"][0]["target"], "铜");
    assert!(!second.raw.contains("credentialEnv"));
    assert!(!second.raw.contains("outputSchema"));
    assert!(!second.raw.contains(&server.endpoint));
    assert_eq!(
        fixture.captures(&generation["attemptId"])[1]["capture"]["body"],
        second.raw
    );
    // Reading the original retrieval view consumes no member sharing proof.
    fixture.wait(&discovery, |view| view["callbacksDrained"] == true);
    second.tool("same-query-again", fixture.unit);
    let third = peer.next();
    let replies: Vec<_> = third.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["content"], replies[1]["content"]);
    third.finish(fixture.unit);
    let terminal = fixture.terminal(&generation["attemptId"]);
    assert_eq!(
        terminal["items"][0]["status"]["execution"], "succeeded",
        "{terminal}"
    );
    let saved = fixture.saved_effect(&generation["attemptId"]);
    assert!(!saved["rows"][0]["savedRevisionId"].is_null());
    let captures = fixture.captures(&generation["attemptId"]);
    assert_eq!(captures.len(), 3);
    assert!(captures.iter().all(|row| !row["capture"].is_null()),
        "all three actual member requests must retain their original captures");
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
    let status = fixture.ipc("read_work_plan_status", json!({"planId":plan["planId"]}));
    assert_eq!(status["toolInvocations"], json!({"reserved":1,"limit":1}));
    let result = fixture.result(&prepared["query"]);
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    assert_eq!(shared["resultId"], json!(result.envelope().result_id));
    assert_eq!(shared["resultDigest"], result.digest());
    let generation_id: ExecutionId =
        serde_json::from_value(generation["attemptId"].clone()).unwrap();
    let root_attempt: ExecutionId = serde_json::from_value(grant["attemptId"].clone()).unwrap();
    let (candidate, budget) = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let input = store.execution_input(generation_id).unwrap();
            let candidate = store
                .saved_ai_candidate(generation_id, input.envelope().items[0].item_id)
                .unwrap();
            let root = store.execution_input(root_attempt).unwrap();
            let budget = store
                .provider_budget(root.envelope().task_id)
                .unwrap()
                .unwrap();
            (candidate, budget)
        });
    assert!(
        candidate.is_some(),
        "saved effect must resolve through the original candidate owner: {terminal}"
    );
    assert_eq!(
        budget.dispatched, 4,
        "MCP and the ordinary held producer are not model requests"
    );
    drop(held);
    fixture.terminal(&json!(ordinary_attempt));
    call(
        &fixture.window,
        "close_project",
        json!({"sessionToken":fixture.context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &fixture.window,
        "open_project",
        json!({"locator":fixture.directory.path().join("project")}),
    )
    .unwrap();
    let expected_digest = result.digest().to_owned();
    let (no_host, reopened_digest) =
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let active = sessions.active.as_ref().unwrap();
                (
                    active.execution.is_none(),
                    active
                        .store
                        .execution_result(query_attempt, result.envelope().result_id)
                        .unwrap()
                        .digest()
                        .to_owned(),
                )
            });
    assert!(no_host);
    assert_eq!(reopened_digest, expected_digest);
    assert!(!reopened["sessionToken"].is_null());
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
}

#[test]
fn pi_mcp_pause_discards_late_success_drains_original_call_and_does_not_send_a_followup() {
    let _runtime;
    let fixture = PreservedFixture::new();
    _runtime = execution::test_fixtures::provision_member_runtime(
        &fixture.app.state::<AppState>().plugins,
        &fixture.directory.path().join("member-resources"),
    );
    let _cleanup = Cleanup(&fixture);
    let server = Server::new(Mode::Hold);
    let discovery = fixture.discovery(&server.endpoint);
    let prepared = fixture.prepare(&discovery);
    let peer = Peer::new();
    let (plan, grant) = fixture.member_plan(&prepared["preview"], &peer);
    let generation = fixture.start_member(&grant);
    peer.next().tool("held-query", fixture.unit);
    server.wait_call();
    fixture.ipc(
        "control_work_plan",
        json!({"planId":plan["planId"],"expectedGeneration":grant["lease"]["generation"],
        "actionId":ExecutionId::new(),"command":"pause","confirmed":true,"checkerExecutions":[],
        "toolExecution":false,"applicationToolExecutions":[],"expiresAt":null}),
    );
    server.release();
    fixture.terminal(&generation["attemptId"]);
    let result = fixture.result(&prepared["query"]);
    assert_eq!(result.envelope().outcome, ExecutionState::Unknown);
    assert!(result.envelope().output.is_none());
    fixture.wait(&discovery, |view| view["callbacksDrained"] == true);
    let captures = fixture.captures(&generation["attemptId"]);
    assert_eq!(captures.len(), 1);
    assert!(!captures[0]["capture"].is_null());
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
    peer.empty();
    let generation_id: ExecutionId =
        serde_json::from_value(generation["attemptId"].clone()).unwrap();
    let root_attempt: ExecutionId = serde_json::from_value(grant["attemptId"].clone()).unwrap();
    let (candidate, budget) = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let input = store.execution_input(generation_id).unwrap();
            let candidate = store
                .saved_ai_candidate(generation_id, input.envelope().items[0].item_id)
                .unwrap();
            let root = store.execution_input(root_attempt).unwrap();
            let budget = store
                .provider_budget(root.envelope().task_id)
                .unwrap()
                .unwrap();
            (candidate, budget)
        });
    assert!(candidate.is_none());
    assert_eq!(budget.dispatched, 2);
}

#[test]
fn pi_mcp_model_material_limit_preserves_the_original_larger_success() {
    let _runtime;
    let fixture = PreservedFixture::new();
    _runtime = execution::test_fixtures::provision_member_runtime(
        &fixture.app.state::<AppState>().plugins,
        &fixture.directory.path().join("member-resources"),
    );
    let _cleanup = Cleanup(&fixture);
    let server = Server::new(Mode::ModelOversize);
    let discovery = fixture.discovery(&server.endpoint);
    let prepared = fixture.prepare(&discovery);
    let peer = Peer::new();
    let (plan, grant) = fixture.member_plan(&prepared["preview"], &peer);
    let generation = fixture.start_member(&grant);
    peer.next().tool("large-valid-query", fixture.unit);
    fixture.terminal(&generation["attemptId"]);
    let result = fixture.result(&prepared["query"]);
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    let output = result.envelope().output.as_ref().unwrap();
    let bytes = serde_json::to_vec(output).unwrap();
    assert!(
        bytes.len() > 32768 && bytes.len() <= tsumugi_core::application::MAX_MCP_TERM_RESULT_BYTES
    );
    assert_eq!(
        output["entries"][0]["target"].as_str().unwrap().len(),
        16384
    );
    assert_eq!(
        output["entries"][1]["target"].as_str().unwrap().len(),
        16384
    );
    let captures = fixture.captures(&generation["attemptId"]);
    assert_eq!(captures.len(), 1);
    assert!(!captures[0]["capture"].is_null());
    fixture.wait(&discovery, |view| view["callbacksDrained"] == true);
    peer.empty();
    let status = fixture.ipc("read_work_plan_status", json!({"planId":plan["planId"]}));
    assert_eq!(status["toolInvocations"], json!({"reserved":1,"limit":1}));
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
    call(
        &fixture.window,
        "close_project",
        json!({"sessionToken":fixture.context["sessionToken"]}),
    )
    .unwrap();
    call(
        &fixture.window,
        "open_project",
        json!({"locator":fixture.directory.path().join("project")}),
    )
    .unwrap();
    let attempt: ExecutionId =
        serde_json::from_value(prepared["query"]["attemptId"].clone()).unwrap();
    let expected_digest = result.digest().to_owned();
    let (no_host, reopened_digest) =
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let active = sessions.active.as_ref().unwrap();
                (
                    active.execution.is_none(),
                    active
                        .store
                        .execution_result(attempt, result.envelope().result_id)
                        .unwrap()
                        .digest()
                        .to_owned(),
                )
            });
    assert!(no_host);
    assert_eq!(reopened_digest, expected_digest);
    assert_eq!(server.calls.load(Ordering::Acquire), 1);
}
