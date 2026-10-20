//! Installed source facts reach an actual Pi process through captured requests.
#[path = "pi/webvtt.rs"]
mod webvtt;

use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    ops::{Deref, DerefMut},
    path::PathBuf,
};
use tsumugi_core::{
    ContextFactDisposition, ContextFactWrite, SourceContextRequest, SourceContextSelection,
    SourceFactBasis, ai::AiConfig, application::PlanOptions,
};

const SOURCE: &str = "Hello 👩🏽‍💻 e\u{301}";
const NEIGHBOR: &str = "Neighbor café 🧭";
const NAME: &str = "Moonlight manifest 📝";

struct EvidenceDirectory(Option<OwnedDirectory>);
impl EvidenceDirectory {
    fn new() -> Self {
        Self(Some(OwnedDirectory(tempfile::tempdir().unwrap())))
    }
    fn path(&self) -> &Path {
        self.0.as_ref().unwrap().0.path()
    }
    fn preserve(&mut self) {
        if let Some(directory) = self.0.take() {
            eprintln!(
                "retained synthetic source-context evidence at {}",
                directory.0.path().display()
            );
            std::mem::forget(directory);
        }
    }
}
impl Drop for EvidenceDirectory {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.preserve();
        }
    }
}

struct Installed {
    app: tauri::App<tauri::test::MockRuntime>,
    window: Window,
    directory: EvidenceDirectory,
    context: Value,
    source_choice: PluginSourceRequest,
    source_directory: PathBuf,
    manifest: String,
}
struct Fixture(Option<Installed>);
impl Deref for Fixture {
    type Target = Installed;
    fn deref(&self) -> &Installed {
        self.0.as_ref().unwrap()
    }
}
impl DerefMut for Fixture {
    fn deref_mut(&mut self) -> &mut Installed {
        self.0.as_mut().unwrap()
    }
}
impl Fixture {
    fn new() -> Self {
        let mut fixture = Self::from_package(
            "TSUMUGI_TEST_SMAPI_PACKAGE",
            "TSUMUGI_TEST_SMAPI_DIGEST",
            "stardew-smapi",
        );
        fixture.manifest = format!(
            "{{\"UniqueID\":\"Example.PiContext\",\"Description\":\"雪\",\"Name\":\"{NAME}\",\"Version\":\"1.0.0\",\"EntryDll\":\"Context.dll\"}}"
        );
        std::fs::create_dir_all(fixture.source_directory.join("i18n")).unwrap();
        std::fs::write(
            fixture.source_directory.join("manifest.json"),
            &fixture.manifest,
        )
        .unwrap();
        std::fs::write(
            fixture.source_directory.join("i18n/default.json"),
            serde_json::to_vec(&json!({"greeting":SOURCE,"neighbor":NEIGHBOR})).unwrap(),
        )
        .unwrap();
        fixture.adopt_current_source();
        fixture
    }
    fn for_webvtt(raw: &str) -> Self {
        let fixture = Self::from_package(
            "TSUMUGI_TEST_WEBVTT_PACKAGE",
            "TSUMUGI_TEST_WEBVTT_DIGEST",
            "webvtt",
        );
        std::fs::create_dir_all(&fixture.source_directory).unwrap();
        std::fs::write(fixture.source_directory.join("source.vtt"), raw).unwrap();
        fixture.adopt_current_source();
        fixture
    }
    fn from_package(package_env: &str, digest_env: &str, plugin: &str) -> Self {
        let directory = EvidenceDirectory::new();
        let root = directory.path();
        let (package, approval) = selected_package(package_env, digest_env, plugin);
        let runtime = approved_runtime();
        let runtime_approval = RuntimeApproval {
            environment: runtime.descriptor().clone().into(),
            origin: crate::runtime_bundle::bundled_origin(),
        };
        let environment_digest = runtime_approval.environment.digest().unwrap();
        provision_packages(
            root,
            &[(package, approval.clone())],
            &runtime,
            &runtime_approval,
        );
        drop(runtime);
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .invoke_handler(crate::commands::execution::production_handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.state::<AppState>()
            .plugins
            .configure(root.join("application"))
            .unwrap();
        crate::commands::execution::test_fixtures::configure_member_resources(
            &app.state::<AppState>().plugins,
            &root.join("member-resources"),
        );
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let source_directory = root.join("mod");
        let mut fixture = Self(Some(Installed {
            app,
            window,
            directory,
            context: Value::Null,
            source_choice: PluginSourceRequest {
                package: crate::commands::plugins::PluginPackageRequest {
                    plugin: approval.plugin,
                    package_digest: approval.package_digest,
                },
                resource_id: "source-profile".into(),
                environment_digest,
            },
            source_directory,
            manifest: String::new(),
        }));
        let project = call(
            &fixture.window,
            "create_project",
            json!({"destination":fixture.directory.path().join("project"),
                "displayName":"Installed source facts and Pi", "sourceLocale":"en-US",
                "targetLocales":["zh-CN"]}),
        )
        .unwrap();
        fixture.context = json!({"sessionToken":project["sessionToken"],
            "projectId":project["metadata"]["projectId"]});
        fixture
    }
    fn adopt_current_source(&self) {
        let (attempt, result, preview) = self.checked_source();
        adopt(
            &self.window,
            &self.context,
            &attempt,
            &result,
            preview["confirmation"].clone(),
        );
    }
    fn ipc(&self, command: &str, fields: Value) -> Result<Value, Value> {
        call(&self.window, command, scoped(&self.context, fields))
    }
    fn checked_source(&self) -> (Value, Value, Value) {
        checked_proposal(
            &self.app,
            &self.window,
            &self.context,
            &self.source_choice,
            &self.source_directory,
        )
    }
    fn current(&self) -> (Value, Value, Value) {
        let (scope, content) = content(&self.window, &self.context);
        let row = content["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["occurrence"]["text"] == SOURCE)
            .unwrap()
            .clone();
        let page = call(
            &self.window,
            "read_source_context",
            context_request(&self.context, &scope, &row),
        )
        .unwrap();
        (scope, row, page)
    }
    fn default_config(&self, peer: &Peer) -> AiConfig {
        AiConfig {
            endpoint: format!(
                "http://{}/v1/chat/completions",
                peer.0.local_addr().unwrap()
            ),
            model: "synthetic-source-context-pi".into(),
            credential_env: String::new(),
            max_requests: 2,
            timeout_seconds: 30,
            ..AiConfig::default()
        }
    }
    fn config(&self, peer: &Peer, extracted: bool, manual: bool) -> AiConfig {
        AiConfig {
            share_context: manual,
            source_context: SourceContextSelection {
                extracted,
                neighbors: extracted,
                ..Default::default()
            },
            ..self.default_config(peer)
        }
    }
    fn prepare_config(&self, config: AiConfig) -> Value {
        let (_, row, _) = self.current();
        self.ipc(
            "prepare_work_plan",
            json!({"config":config,
            "locale":"zh-CN","unitIds":[row["unitId"]],"options":PlanOptions::default(),
            "advisoryChecks":[],"toolSelection":null,"maintenance":null}),
        )
        .unwrap()
    }
    fn prepare(&self, peer: &Peer, extracted: bool, manual: bool) -> Value {
        self.prepare_config(self.config(peer, extracted, manual))
    }
    fn authorization(&self, plan: &Value) -> Value {
        json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),
            "confirmed":true,"checkerExecutions":[],"toolExecution":false,
            "applicationToolExecutions":[],"effects":["save-candidate"],
            "expiresAt":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()+90).to_string()})
    }
    fn start(&self, peer: &Peer, plan: &Value) -> (Value, Value, Value, Http) {
        let grant = self
            .ipc("authorize_work_plan", self.authorization(plan))
            .unwrap();
        self.ipc(
            "start_work_plan",
            json!({"planId":plan["planId"],"actionId":grant["actionId"],
            "expectedGeneration":grant["lease"]["generation"]}),
        )
        .unwrap();
        let root = peer.next();
        assert_eq!(root.body["stream"], false);
        let shared = root.shared();
        assert_eq!(shared["sourceText"], SOURCE);
        root.finish("Original root candidate");
        self.terminal(&grant["attemptId"]);
        self.saved_candidate(&grant["attemptId"]);
        let scope = self
            .ipc(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]}),
            )
            .unwrap();
        let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),
            "unitIds":[shared["unitId"]]});
        let prepared = self
            .ipc(
                "prepare_work_plan_agent_generation",
                json!({"scopeId":scope["scopeId"],"generation":generation}),
            )
            .unwrap();
        let started = self
            .ipc(
                "start_work_plan_agent_generation",
                json!({"scopeId":scope["scopeId"],
            "generation":generation,"inputDigest":prepared["inputDigest"]}),
            )
            .unwrap();
        assert_eq!(started, generation["attemptId"]);
        let member = peer.next();
        assert_eq!(
            member.body["stream"], true,
            "the second request must come from Pi"
        );
        assert_eq!(member.shared(), shared);
        assert!(
            member
                .body
                .get("tools")
                .is_none_or(|tools| tools.as_array().is_some_and(Vec::is_empty))
        );
        (scope, generation, shared, member)
    }
    fn terminal(&self, attempt: &Value) {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let view = self
                .ipc(
                    "read_execution_attempt",
                    json!({"attemptId":attempt,"offset":0,"limit":100}),
                )
                .unwrap();
            let items = view["items"].as_array().unwrap();
            if items
                .iter()
                .all(|item| item["status"]["execution"] == "succeeded")
            {
                return;
            }
            assert!(
                items.iter().all(|item| matches!(
                    item["status"]["execution"].as_str(),
                    Some("queued" | "dispatched" | "succeeded")
                )),
                "physical source-context work failed: {view}"
            );
            assert!(
                Instant::now() < until,
                "source-context work did not finish: {view}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn captures(&self, attempt: &Value) -> Vec<Value> {
        let project = self.directory.path().join("project/project.sqlite3");
        let attempt = attempt.as_str().unwrap().to_owned();
        // Serialize the rollback-journal observation with this project's owner.
        self.app.state::<AppState>().sessions.with(move |_| {
            let connection = rusqlite::Connection::open_with_flags(project,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let mut query = connection.prepare("SELECT request_id,capture FROM execution_provider_requests WHERE attempt_id=?1 ORDER BY rowid").unwrap();
            query.query_map([attempt], |row| Ok((row.get::<_,String>(0)?, row.get::<_,Vec<u8>>(1)?))).unwrap()
                .map(|row| { let (id, bytes) = row.unwrap();
                    json!({"requestId":id,"capture":serde_json::from_slice::<Value>(&bytes).unwrap()}) })
                .collect()
        })
    }
    fn saved_candidate(&self, attempt: &Value) {
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            let view = self
                .ipc("read_ai_translation", json!({"attemptId":attempt}))
                .unwrap();
            let row = &view["rows"][0];
            if row["automation"]["phase"] == "saved" && !row["savedRevisionId"].is_null() {
                return;
            }
            assert!(
                !matches!(
                    row["automation"]["phase"].as_str(),
                    Some("failed" | "cancelled" | "blocked")
                ),
                "original candidate effect failed: {view}"
            );
            assert!(
                Instant::now() < until,
                "original candidate effect did not settle: {view}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn capture(&self, generation: &Value, http: &Http) -> Value {
        let rows = self.captures(&generation["attemptId"]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["capture"]["body"], http.raw);
        rows[0].clone()
    }
    fn replace_fact(&self, scope: &Value, row: &Value) -> Value {
        let scope: SourceContextRequest =
            serde_json::from_value(json!({"projectId":self.context["projectId"],
            "sourceSnapshotId":scope["currentSnapshot"],"unitId":row["unitId"],
            "sourceRevisionId":row["sourceRevisionId"],"locale":"zh-CN"}))
            .unwrap();
        let basis = self.app.state::<AppState>().sessions.with(move |sessions| {
            let view = sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .source_context(&scope)
                .unwrap();
            let block = view
                .blocks
                .iter()
                .find(|block| {
                    block
                        .facts
                        .as_ref()
                        .is_some_and(|facts| facts.facts.iter().any(|fact| fact.text == NAME))
                })
                .unwrap();
            SourceFactBasis::from_view(&view, block.block_index, 0).unwrap()
        });
        let decision = ContextFactWrite {
            action_id: ExecutionId::new(),
            basis,
            expected_decision_id: None,
            disposition: ContextFactDisposition::Replace {
                text: "Reviewed manual note 🧑🏽‍🚀".into(),
            },
            actor: "Synthetic context reviewer".into(),
            reason: "A deliberate local correction".into(),
        };
        let saved = self
            .ipc("decide_context_fact", json!({"decision":decision}))
            .unwrap();
        assert_eq!(saved["request"], serde_json::to_value(&decision).unwrap());
        saved
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.app.state::<AppState>().sessions.with(|sessions| {
                    let Some(active) = sessions.active.as_mut() else {
                        return Ok(true);
                    };
                    let Some(host) = active.execution.as_mut() else {
                        return Ok(true);
                    };
                    if !host.quiescing {
                        host.begin_quiesce(&mut active.store)?;
                    }
                    host.tick(&mut active.store)?;
                    if host.quiescing {
                        return Ok::<_, CommandError>(false);
                    }
                    active.execution.take();
                    Ok(true)
                })
            }));
            if matches!(result, Ok(Ok(true))) {
                return;
            }
            if result.is_err() || Instant::now() >= until {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut installed = self.0.take().unwrap();
        installed.directory.preserve();
        // Unconfirmed producers keep their actual owner and project together.
        std::mem::forget(installed);
        if !std::thread::panicking() {
            panic!("source-context fixture did not confirm producer drain");
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
    fn next(&self) -> Http {
        let until = Instant::now() + Duration::from_secs(30);
        let mut socket = loop {
            match self.0.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until, "expected a physical Pi request");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("loopback accept failed: {error}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
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
    fn shared(&self) -> Value {
        let messages: Vec<_> = self.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .collect();
        assert_eq!(messages.len(), 1);
        let content = &messages[0]["content"];
        let text = if let Some(text) = content.as_str() {
            text
        } else {
            let parts = content.as_array().unwrap();
            assert_eq!(parts.len(), 1);
            assert_eq!(parts[0]["type"], "text");
            parts[0]["text"].as_str().unwrap()
        };
        serde_json::from_str(text).unwrap()
    }
    fn finish(mut self, text: &str) {
        let shared = self.shared();
        let output =
            json!({"unitId":shared["unitId"],"targetLocale":"zh-CN","text":text}).to_string();
        let (kind, body) = if self.body["stream"] == false {
            ("application/json", json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":output}}],
                "usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string())
        } else {
            assert_eq!(self.body["stream"], true);
            let chunk = json!({"id":"synthetic-source-context","object":"chat.completion.chunk",
                "choices":[{"index":0,"delta":{"role":"assistant","content":output},"finish_reason":null}]});
            let end = json!({"id":"synthetic-source-context","object":"chat.completion.chunk",
                "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}});
            (
                "text/event-stream",
                format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
            )
        };
        write!(self.socket,"HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    }
}

fn source_projection(name: &str) -> Value {
    json!({"facts":[{"kind":"note","text":name,"origin":{"kind":"extracted"}}],
        "neighbors":[{"text":NEIGHBOR,"directions":["after"]}]})
}
fn assert_local(fixture: &Fixture, scope: &Value, row: &Value, page: &Value, name: &str) {
    assert_eq!(page["scope"]["unitId"], row["unitId"]);
    assert_eq!(page["scope"]["sourceSnapshotId"], scope["currentSnapshot"]);
    let (_, content) = content(&fixture.window, &fixture.context);
    let artifact = &content["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["logicalPath"] == "manifest.json")
        .unwrap()["artifactId"];
    assert_manifest_name_fact(page, &fixture.manifest, name, artifact);
    assert_eq!(neighbor(page)["text"], NEIGHBOR);
}
fn assert_private_basis_absent(http: &Http, plan: &Value, page: &Value) {
    let shared = http.shared().to_string();
    for key in [
        "sourceSnapshotId",
        "sourceRevisionId",
        "sourceAttemptId",
        "sourceResultId",
        "sourceResultDigest",
        "artifactId",
        "blockIndex",
        "factIndex",
        "inRevisionBasis",
        "payloadUtf8",
    ] {
        assert!(
            !shared.contains(&format!("\"{key}\"")),
            "local field leaked: {key}"
        );
    }
    for id in [
        plan["planId"].as_str().unwrap(),
        page["scope"]["sourceSnapshotId"].as_str().unwrap(),
        page["scope"]["sourceRevisionId"].as_str().unwrap(),
        page["sourceAttemptId"].as_str().unwrap(),
        page["sourceResultId"].as_str().unwrap(),
        page["sourceResultDigest"].as_str().unwrap(),
    ] {
        assert!(!http.raw.contains(id), "local source identity leaked");
    }
    assert!(!http.raw.contains("manifest.json"));
    assert!(!http.raw.contains("i18n/default.json"));
    assert!(!http.raw.contains("utf8-byte"));
    // A local fact ID can also be a legitimate shared kind, such as "time".
    // Check the metadata field rather than banning its value in user content.
    if let Some(facts) = http.shared()["sourceContext"]["facts"].as_array() {
        for fact in facts {
            assert!(fact.get("id").is_none(), "local fact ID field leaked");
        }
    }
    for entry in page["entries"].as_array().unwrap() {
        if entry["kind"] == "block" {
            for fact in entry["value"]["facts"]["facts"].as_array().unwrap() {
                for source in fact["origin"]["sources"].as_array().unwrap() {
                    assert!(!http.raw.contains(source["artifactId"].as_str().unwrap()));
                }
            }
        }
    }
}

#[test]
#[ignore = "requires independently captured SMAPI/runtime/member artifacts"]
fn installed_source_context_pi_requests_default_off_select_literals_and_reject_stale_source() {
    let mut fixture = Fixture::new();
    let (scope, row, page) = fixture.current();
    assert_local(&fixture, &scope, &row, &page, NAME);
    let peer = Peer::new();
    let off = fixture.prepare_config(fixture.default_config(&peer));
    assert_eq!(
        off["preview"]["config"]["sourceContext"],
        json!({"extracted":false,"inferred":false,"neighbors":false,
            "maxBytes":16384,"maxItems":128})
    );
    assert_eq!(off["preview"]["config"]["shareContext"], false);
    let (_, generation, shared, http) = fixture.start(&peer, &off);
    assert!(shared.get("sourceContext").is_none());
    assert!(shared.get("manualContextFacts").is_none());
    assert_eq!(shared["context"], Value::Null);
    assert!(!http.raw.contains(NAME));
    assert!(!http.raw.contains(NEIGHBOR));
    assert_private_basis_absent(&http, &off, &page);
    fixture.capture(&generation, &http);
    http.finish("Pi without source context");
    fixture.terminal(&generation["attemptId"]);
    fixture.saved_candidate(&generation["attemptId"]);

    let selected = fixture.prepare(&peer, true, false);
    assert_eq!(
        selected["preview"]["items"][0]["sourceContext"]["kind"],
        "selected"
    );
    let (agent, generation, shared, http) = fixture.start(&peer, &selected);
    assert_eq!(shared["sourceContext"], source_projection(NAME));
    assert_private_basis_absent(&http, &selected, &page);
    let original = fixture.capture(&generation, &http);
    http.finish("Pi with fixed source facts");
    fixture.terminal(&generation["attemptId"]);
    fixture.saved_candidate(&generation["attemptId"]);
    let stale = fixture.prepare(&peer, true, false);
    let authorization = fixture.authorization(&stale);

    let next_name = "Forest manifest 📝";
    fixture.manifest = fixture.manifest.replace(NAME, next_name);
    std::fs::write(
        fixture.source_directory.join("manifest.json"),
        &fixture.manifest,
    )
    .unwrap();
    let (attempt, result, _) = fixture.checked_source();
    let comparison = fixture
        .ipc(
            "read_source_comparison",
            json!({"attemptId":attempt,"resultId":result,
        "base":scope["currentSnapshot"],"filter":"","after":0,"limit":10}),
        )
        .unwrap();
    assert_eq!(comparison["changed"], 2);
    assert_eq!(comparison["unchanged"], 0);
    let lineage: Vec<_> = comparison["rows"].as_array().unwrap().iter().map(|change| {
        assert_eq!(change["kind"],"changed");
        json!({"newOrdinal":change["new"]["ordinal"],"oldOccurrenceId":change["old"]["occurrenceId"],
            "decision":"continue","reason":"Same native key with a changed manifest note"})
    }).collect();
    let mut confirmation = comparison["confirmation"].clone();
    confirmation["actor"] = json!("Synthetic manifest reviewer");
    confirmation["lineage"] = json!(lineage);
    adopt(
        &fixture.window,
        &fixture.context,
        &attempt,
        &result,
        confirmation,
    );
    let (next_scope, next_row, next_page) = fixture.current();
    assert_eq!(next_row["unitId"], row["unitId"]);
    assert_ne!(next_row["sourceRevisionId"], row["sourceRevisionId"]);
    assert_local(&fixture, &next_scope, &next_row, &next_page, next_name);
    let rejected = fixture
        .ipc("authorize_work_plan", authorization)
        .unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["reason"], "work-plan-evidence");
    let rejected = fixture.ipc("prepare_work_plan_agent_generation",json!({"scopeId":agent["scopeId"],
        "generation":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[row["unitId"]]}})).unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["reason"], "work-plan-evidence");
    assert_eq!(fixture.captures(&generation["attemptId"]), vec![original]);
    peer.empty();

    let fresh = fixture.prepare(&peer, true, false);
    let (_, generation, shared, http) = fixture.start(&peer, &fresh);
    assert_eq!(shared["sourceContext"], source_projection(next_name));
    assert!(!http.raw.contains(NAME));
    assert_private_basis_absent(&http, &fresh, &next_page);
    fixture.capture(&generation, &http);
    http.finish("Pi after explicit source preparation");
    fixture.terminal(&generation["attemptId"]);
    fixture.saved_candidate(&generation["attemptId"]);
    peer.empty();
}

#[test]
#[ignore = "requires independently captured SMAPI/runtime/member artifacts"]
fn installed_source_context_pi_manual_share_off_keeps_corrections_without_raw_fallback() {
    let fixture = Fixture::new();
    let (scope, row, page) = fixture.current();
    assert_local(&fixture, &scope, &row, &page, NAME);
    let decision = fixture.replace_fact(&scope, &row);
    let context_request = json!({"context":{"projectId":fixture.context["projectId"],"actionId":ExecutionId::new(),
        "unitId":row["unitId"],"locale":"zh-CN","sourceRevisionId":row["sourceRevisionId"],
        "expectedRevisionId":null,"text":"Private human context 🧶","reason":"A separate manual context revision"}});
    let manual = fixture
        .ipc("save_context", context_request.clone())
        .unwrap();
    let peer = Peer::new();
    let on = fixture.prepare(&peer, true, true);
    let (_, generation, shared, http) = fixture.start(&peer, &on);
    assert_eq!(shared["context"], "Private human context 🧶");
    assert_eq!(
        shared["manualContextFacts"],
        json!([{"kind":"note","text":"Reviewed manual note 🧑🏽‍🚀","origin":"manual"}])
    );
    assert_eq!(
        shared["sourceContext"],
        json!({"facts":[],"neighbors":[{"text":NEIGHBOR,"directions":["after"]}]})
    );
    assert!(!http.raw.contains(NAME));
    assert_private_basis_absent(&http, &on, &page);
    let original = fixture.capture(&generation, &http);
    http.finish("Pi with explicitly shared human context");
    fixture.terminal(&generation["attemptId"]);
    fixture.saved_candidate(&generation["attemptId"]);

    let off = fixture.prepare(&peer, true, false);
    let (_, generation_off, shared, http) = fixture.start(&peer, &off);
    assert_eq!(shared["context"], Value::Null);
    assert!(shared.get("manualContextFacts").is_none());
    assert_eq!(
        shared["sourceContext"],
        json!({"facts":[],"neighbors":[{"text":NEIGHBOR,"directions":["after"]}]})
    );
    for text in [NAME, "Reviewed manual note 🧑🏽‍🚀", "Private human context 🧶"] {
        assert!(
            !http.raw.contains(text),
            "unshared or replaced context leaked"
        );
    }
    assert_private_basis_absent(&http, &off, &page);
    assert!(
        !http
            .raw
            .contains(decision["request"]["actionId"].as_str().unwrap())
    );
    assert!(!http.raw.contains(manual["revisionId"].as_str().unwrap()));
    fixture.capture(&generation_off, &http);
    http.finish("Pi after manual sharing was disabled");
    fixture.terminal(&generation_off["attemptId"]);
    fixture.saved_candidate(&generation_off["attemptId"]);
    assert_eq!(fixture.captures(&generation["attemptId"]), vec![original]);
    assert_eq!(
        fixture
            .ipc(
                "read_context_revision",
                json!({"unitId":row["unitId"],"locale":"zh-CN"})
            )
            .unwrap(),
        manual
    );
    assert_eq!(
        fixture
            .ipc(
                "read_context_fact_action",
                json!({"actionId":decision["request"]["actionId"]})
            )
            .unwrap(),
        decision
    );
    let (after_scope, after_row, after_page) = fixture.current();
    assert_eq!(after_scope, scope);
    assert_eq!(after_row, row);
    assert_eq!(
        after_page, page,
        "sharing must not rewrite raw source observations"
    );
    peer.empty();
}

#[test]
#[ignore = "requires independently captured SMAPI/runtime/member artifacts"]
fn installed_source_context_pi_inflight_source_change_keeps_request_and_rejects_late_candidate() {
    let mut fixture = Fixture::new();
    let (scope, row, page) = fixture.current();
    let peer = Peer::new();
    let config = AiConfig {
        timeout_seconds: 60,
        ..fixture.config(&peer, true, false)
    };
    let plan = fixture.prepare_config(config);
    let (agent, generation, shared, http) = fixture.start(&peer, &plan);
    assert_eq!(shared["sourceContext"], source_projection(NAME));
    assert_private_basis_absent(&http, &plan, &page);
    let original = fixture.capture(&generation, &http);
    let before = fixture
        .ipc(
            "read_ai_translation",
            json!({"attemptId":generation["attemptId"]}),
        )
        .unwrap();
    assert!(before["rows"][0]["output"].is_null());
    assert!(before["rows"][0]["savedRevisionId"].is_null());

    // The complete physical Pi request is the synchronization barrier. Do not
    // answer it until S2 and the newer human choice have actually committed.
    let next_name = "In-flight forest manifest 📝";
    fixture.manifest = fixture.manifest.replace(NAME, next_name);
    std::fs::write(
        fixture.source_directory.join("manifest.json"),
        &fixture.manifest,
    )
    .unwrap();
    let (attempt, result, _) = fixture.checked_source();
    let comparison = fixture
        .ipc(
            "read_source_comparison",
            json!({"attemptId":attempt,"resultId":result,
        "base":scope["currentSnapshot"],"filter":"","after":0,"limit":10}),
        )
        .unwrap();
    assert_eq!(comparison["changed"], 2);
    assert_eq!(comparison["unchanged"], 0);
    let lineage: Vec<_> = comparison["rows"].as_array().unwrap().iter().map(|change| {
        assert_eq!(change["kind"], "changed");
        json!({"newOrdinal":change["new"]["ordinal"],"oldOccurrenceId":change["old"]["occurrenceId"],
            "decision":"continue","reason":"Keep the same native key after its manifest context changes"})
    }).collect();
    let mut confirmation = comparison["confirmation"].clone();
    confirmation["actor"] = json!("Synthetic in-flight source reviewer");
    confirmation["lineage"] = json!(lineage);
    adopt(
        &fixture.window,
        &fixture.context,
        &attempt,
        &result,
        confirmation,
    );
    let (next_scope, next_row, next_page) = fixture.current();
    assert_eq!(next_row["unitId"], row["unitId"]);
    assert_ne!(next_scope["currentSnapshot"], scope["currentSnapshot"]);
    assert_ne!(next_row["sourceRevisionId"], row["sourceRevisionId"]);
    assert_local(&fixture, &next_scope, &next_row, &next_page, next_name);
    let manual_request = json!({"actionId":ExecutionId::new(),"unitId":next_row["unitId"],"locale":"zh-CN",
        "sourceRevisionId":next_row["sourceRevisionId"],"expectedSelectionId":null,"text":"Newer human translation 🧑🏽‍🚀"});
    let manual = fixture
        .ipc("save_translation_revision", manual_request.clone())
        .unwrap();
    let history_request =
        json!({"unitId":row["unitId"],"locale":"zh-CN","afterOrdinal":"0","limit":100});
    let history = fixture
        .ipc("read_translation_history", history_request.clone())
        .unwrap();
    assert_eq!(
        history["total"], "2",
        "the original root candidate and newer human revision are retained"
    );
    assert_eq!(history["currentText"], "Newer human translation 🧑🏽‍🚀");
    assert_eq!(
        fixture.captures(&generation["attemptId"]),
        vec![original.clone()]
    );
    assert!(!http.raw.contains(next_name));
    peer.empty();

    http.finish("Late Pi response from the original source 🧶");
    fixture.terminal(&generation["attemptId"]);
    let until = Instant::now() + Duration::from_secs(15);
    let failed = loop {
        let view = fixture
            .ipc(
                "read_ai_translation",
                json!({"attemptId":generation["attemptId"]}),
            )
            .unwrap();
        if view["rows"][0]["automation"]["phase"] == "failed" {
            break view;
        }
        assert!(
            view["rows"][0]["savedRevisionId"].is_null(),
            "late source output was adopted: {view}"
        );
        assert!(
            Instant::now() < until,
            "stale automatic adoption did not settle: {view}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let late = &failed["rows"][0];
    assert_eq!(
        late["output"]["text"],
        "Late Pi response from the original source 🧶"
    );
    assert!(late["savedRevisionId"].is_null());
    assert_eq!(late["automation"]["error"]["code"], "dependency-conflict");
    assert_eq!(late["automation"]["error"]["reason"], "ai-source");
    assert_eq!(
        fixture
            .ipc("read_translation_history", history_request.clone())
            .unwrap(),
        history
    );
    assert_eq!(
        fixture
            .ipc("save_translation_revision", manual_request.clone())
            .unwrap(),
        manual
    );
    assert_eq!(
        fixture.captures(&generation["attemptId"]),
        vec![original.clone()]
    );
    let rejected = fixture.ipc("prepare_work_plan_agent_generation", json!({"scopeId":agent["scopeId"],
        "generation":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[row["unitId"]]}})).unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["reason"], "work-plan-evidence");
    peer.empty();

    // A saved terminal result does not establish producer drain. Use the
    // original public quiesce/status boundary before closing the project.
    fixture.ipc("quiesce_execution", json!({})).unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let status = fixture.ipc("execution_status", json!({})).unwrap();
        if status["active"] == false && status["quiescing"] == false {
            break;
        }
        assert!(
            Instant::now() < until,
            "original producers did not drain: {status}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
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
    fixture.context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    assert_eq!(
        fixture
            .ipc("read_translation_history", history_request)
            .unwrap(),
        history
    );
    assert_eq!(
        fixture
            .ipc("save_translation_revision", manual_request)
            .unwrap(),
        manual
    );
    assert_eq!(fixture.captures(&generation["attemptId"]), vec![original]);
    let retained = fixture
        .ipc(
            "read_ai_translation",
            json!({"attemptId":generation["attemptId"]}),
        )
        .unwrap();
    assert_eq!(retained["rows"][0]["output"], late["output"]);
    assert_eq!(retained["rows"][0]["resultId"], late["resultId"]);
    assert!(retained["rows"][0]["savedRevisionId"].is_null());
    peer.empty();
}
