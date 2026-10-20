//! Actual Pi reads immutable guidance through the original tool scope.
use super::*;
use tsumugi_core::application::ToolGuidancePolicy;

const SKILL_TEXT: &str = "Query only; do not adopt.";
const RESOURCE_TEXT: &str = "immutable reference";

fn root_provider() -> (AiConfig, std::thread::JoinHandle<(TcpListener, Value, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let config = AiConfig {
        endpoint: format!("http://{}/v1/chat/completions", listener.local_addr().unwrap()),
        model: "synthetic-guidance-member".into(),
        credential_env: String::new(),
        max_requests: 4,
        timeout_seconds: 30,
        ..AiConfig::default()
    };
    let root = std::thread::spawn(move || {
        let mut socket = accept(&listener);
        let (raw, body) = request(&mut socket);
        assert_eq!(body["stream"], false);
        let item: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
        let output = json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":"root candidate"}).to_string();
        respond(&mut socket, "application/json", &json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":output}}],
            "usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string());
        (listener, item, raw)
    });
    (config, root)
}

fn start_guidance_plan(setup: &Setup, config: AiConfig) -> (Value, Value) {
    let options = PlanOptions {
        tool_guidance: Some(ToolGuidancePolicy::DeclaredToolsV1 {}),
        ..PlanOptions::default()
    };
    let plan = setup.fixture.call("prepare_work_plan", json!({"config":config,"locale":"zh-CN",
        "unitIds":[setup.fixture.unit],"options":options,"advisoryChecks":[],"toolSelection":setup.tool_selection})).unwrap();
    assert_eq!(plan["options"]["toolGuidance"], json!({"profile":"declared-tools-1"}));
    let grant = setup.start_prepared_plan(&plan);
    (plan, grant)
}

fn read_call(socket: &mut TcpStream, id: &str, name: &str, arguments: Value) {
    let chunk = json!({"id":"synthetic-guidance","object":"chat.completion.chunk","created":1,"model":"synthetic-guidance-member",
        "choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},"finish_reason":null}]});
    let end = json!({"id":"synthetic-guidance","object":"chat.completion.chunk","created":1,"model":"synthetic-guidance-member",
        "choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}});
    respond(socket, "text/event-stream", &format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"));
}

fn guidance_directory(body: &Value) -> Value {
    let directories: Vec<_> = body["messages"].as_array().unwrap().iter()
        .filter(|message| message["role"] == "user")
        .filter_map(|message| serde_json::from_str::<Value>(message["content"].as_str()?).ok())
        .filter(|value| value["kind"] == "untrusted-tool-guidance-directory")
        .collect();
    assert_eq!(directories.len(), 1);
    directories.into_iter().next().unwrap()
}

fn tool_results(body: &Value) -> Vec<&Value> {
    body["messages"].as_array().unwrap().iter().filter(|message| message["role"] == "tool").collect()
}

#[test]
fn pi_member_guidance_reads_declared_text_only_after_explicit_calls_and_reopens_original_budget() {
    let setup = Setup::new(false);
    configure_member(&setup);
    let (config, root) = root_provider();
    let (plan, grant) = start_guidance_plan(&setup, config);
    let (listener, item, _) = root.join().unwrap();
    let before = setup.fixture.attempt_count();
    let (scope, generation) = start(&setup, &grant);
    let mut first = accept(&listener);
    let (first_raw, first_body) = request(&mut first);
    let pid = member_pid(&setup._installation.0.path().join("application"));
    let directory = guidance_directory(&first_body);
    let handle = plan["tools"]["entries"][0]["handle"].clone();
    assert_eq!(directory["tools"].as_array().unwrap().len(), 1);
    assert_eq!(directory["tools"][0]["toolHandle"], handle);
    assert_eq!(directory["tools"][0]["skillId"], "guidance");
    assert!(!first_raw.contains(SKILL_TEXT));
    assert!(!first_raw.contains(RESOURCE_TEXT));
    assert!(!first_raw.contains("observer.json"));
    assert!(!first_raw.contains(setup.fixture.directory.path().to_str().unwrap()));
    assert!(first_raw.contains("read_captured_tool_skill"));
    assert!(first_raw.contains("read_captured_tool_resource"));
    assert!(tool_results(&first_body).is_empty());
    read_call(&mut first, "read-skill", "read_captured_tool_skill", json!({"toolHandle":handle,"skillId":"guidance"}));
    drop(first);

    let mut second = accept(&listener);
    let (second_raw, second_body) = request(&mut second);
    assert_eq!(guidance_directory(&second_body), directory);
    let results = tool_results(&second_body);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["tool_call_id"], "read-skill");
    let skill: Value = serde_json::from_str(results[0]["content"].as_str().unwrap()).unwrap();
    assert_eq!(skill["kind"], "untrusted-tool-guidance");
    assert_eq!(skill["source"]["toolHandle"], handle);
    assert_eq!(skill["content"]["kind"], "skill");
    assert_eq!(skill["content"]["contributionId"], "guidance");
    assert_eq!(skill["content"]["text"], SKILL_TEXT);
    assert!(!second_raw.contains(RESOURCE_TEXT));
    assert!(tool_attempts(&setup).is_empty());
    read_call(&mut second, "read-reference", "read_captured_tool_resource", json!({"toolHandle":handle,"resourceId":"terms"}));
    drop(second);

    let mut third = accept(&listener);
    let (third_raw, third_body) = request(&mut third);
    assert_eq!(guidance_directory(&third_body), directory);
    let results = tool_results(&third_body);
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["tool_call_id"], "read-skill");
    assert_eq!(results[1]["tool_call_id"], "read-reference");
    let reference: Value = serde_json::from_str(results[1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(reference["source"], skill["source"]);
    assert_eq!(reference["content"]["kind"], "resource");
    assert_eq!(reference["content"]["contributionId"], "terms");
    assert_eq!(reference["content"]["schema"], plan["tools"]["entries"][0]["binding"]["resources"][0]["schema"]);
    assert_eq!(reference["content"]["text"], RESOURCE_TEXT);
    final_response(&mut third, &item, "Pi read declared guidance");
    drop(third);
    let terminal = setup.wait_terminal(&generation["attemptId"]);
    assert_eq!(terminal["items"][0]["status"]["execution"], "succeeded", "{terminal}");
    absent(pid);
    assert_eq!(setup.fixture.attempt_count(), before + 1, "reads do not create SDK tasks");
    assert!(tool_attempts(&setup).is_empty());
    assert!(!setup.fixture.directory.path().join("query-observer.jsonl").exists());

    let database = setup.fixture.project_path.join("project.sqlite3");
    let connection = rusqlite::Connection::open(&database).unwrap();
    let mut statement = connection.prepare("SELECT capture FROM execution_provider_requests WHERE attempt_id=?1 ORDER BY rowid").unwrap();
    let captures = statement.query_map([generation["attemptId"].as_str().unwrap()], |row| row.get::<_, Vec<u8>>(0)).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(captures.len(), 3);
    for (capture, raw) in captures.iter().zip([first_raw, second_raw, third_raw]) {
        let capture: Value = serde_json::from_slice(capture).unwrap();
        assert_eq!(capture["body"], raw, "original request owns actual serialized bytes");
    }
    drop(statement);
    drop(connection);
    setup.fixture.call("close_project", json!({})).unwrap();
    let reopened = ProjectStore::open(&setup.fixture.project_path).unwrap();
    let budget = reopened.provider_budget(serde_json::from_value(scope["parentTask"].clone()).unwrap()).unwrap().unwrap();
    assert_eq!((budget.dispatched, budget.unresolved, budget.usage_unknown), (4, 0, 1));
}

#[test]
fn pi_member_guidance_pause_after_package_read_denies_late_text_and_drains_owned_member() {
    let setup = Setup::new(false);
    configure_member(&setup);
    let (config, root) = root_provider();
    let (plan, grant) = start_guidance_plan(&setup, config);
    let (listener, _, _) = root.join().unwrap();
    let scope = setup.fixture.call("open_work_plan_agent_scope", json!({"lease":grant["lease"]})).unwrap();
    let parent: ExecutionId = serde_json::from_value(scope["parentTask"].clone()).unwrap();
    let (reached, observed) = mpsc::channel();
    let (release, held) = mpsc::channel();
    setup.fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let host = sessions.active.as_mut().unwrap().execution.as_mut().unwrap();
        assert!(host.work_plans.member_guidance_probes.insert(parent,
            crate::commands::execution::work_plans::member::GuidanceReadProbe::new(reached, held)).is_none());
    });
    let generation = start_in_scope(&setup, &scope);
    let mut first = accept(&listener);
    let (_, body) = request(&mut first);
    let pid = member_pid(&setup._installation.0.path().join("application"));
    let directory = guidance_directory(&body);
    let handle = directory["tools"][0]["toolHandle"].clone();
    read_call(&mut first, "blocked-read", "read_captured_tool_skill", json!({"toolHandle":handle,"skillId":"guidance"}));
    drop(first);
    observed.recv_timeout(Duration::from_secs(60)).unwrap();
    let receipt = setup.fixture.call("control_work_plan", json!({"actionId":ExecutionId::new(),"planId":plan["planId"],
        "expectedGeneration":grant["lease"]["generation"],"command":"pause","confirmed":false,
        "checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"expiresAt":null})).unwrap();
    assert_ne!(receipt["lease"], grant["lease"]);
    release.send(()).unwrap();
    let terminal = setup.wait_terminal(&generation["attemptId"]);
    assert_ne!(terminal["items"][0]["status"]["execution"], "succeeded", "{terminal}");
    absent(pid);
    assert!(matches!(listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
        "revoked text cannot cause a follow-up HTTP request");
    assert!(tool_attempts(&setup).is_empty());
    assert!(!setup.fixture.directory.path().join("query-observer.jsonl").exists());
    let connection = rusqlite::Connection::open(setup.fixture.project_path.join("project.sqlite3")).unwrap();
    let requests: u32 = connection.query_row("SELECT COUNT(*) FROM execution_provider_requests", [], |row| row.get(0)).unwrap();
    assert_eq!(requests, 2);
}
