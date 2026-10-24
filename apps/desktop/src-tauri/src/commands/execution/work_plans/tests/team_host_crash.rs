//! A killed backend Host leaves historical facts, never reusable live authority.
use super::*;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::process::ExitStatusExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

const CONTROL_ENV: &str = "TSUMUGI_TEAM_HOST_CRASH_CONTROL";
const EVIDENCE_ENV: &str = "TSUMUGI_TEST_TEAM_HOST_CRASH_EVIDENCE";
const MAX_CONTROL_BYTES: usize = 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    configs: [AiConfig; 3],
    members: [ExecutionId; 3],
    pending: bool,
}

fn publish(control: &Path, name: &str, value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    assert!(bytes.len() <= MAX_CONTROL_BYTES);
    let pending = control.join(format!("{name}.pending"));
    fs::write(&pending, bytes).unwrap();
    fs::rename(pending, control.join(name)).unwrap();
}

fn read_marker(path: &Path) -> Option<Value> {
    match fs::read(path) {
        Ok(bytes) => {
            assert!(bytes.len() <= MAX_CONTROL_BYTES);
            Some(serde_json::from_slice(&bytes).unwrap())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("owned Host control read failed: {error}"),
    }
}

fn events_at(directory: &Path) -> Vec<Value> {
    fs::read_to_string(directory.join("query-observer.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[derive(Clone)]
struct Process {
    pid: u32,
    parent: u32,
    arguments: String,
}

fn inspect(pid: u32) -> Result<Option<Process>, String> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-o", "pid=,ppid=,args=", "-p", &pid.to_string()])
        .output()
        .map_err(|error| error.to_string())?;
    let line = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    if !output.status.success() {
        return if line.trim().is_empty() && output.stderr.is_empty() {
            Ok(None)
        } else {
            Err(format!(
                "owned process inspection failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        };
    }
    let mut words = line.split_whitespace();
    let actual = words
        .next()
        .ok_or("missing PID")?
        .parse::<u32>()
        .map_err(|error| error.to_string())?;
    let parent = words
        .next()
        .ok_or("missing parent PID")?
        .parse::<u32>()
        .map_err(|error| error.to_string())?;
    if actual != pid {
        return Err("wrong observed PID".into());
    }
    Ok(Some(Process {
        pid,
        parent,
        arguments: words.collect::<Vec<_>>().join(" "),
    }))
}

fn children(host: u32, root: &Path) -> Result<Vec<Process>, String> {
    let output = Command::new("/usr/bin/pgrep")
        .args(["-P", &host.to_string()])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return if output.status.code() == Some(1) && output.stderr.is_empty() {
            Ok(Vec::new())
        } else {
            Err(format!(
                "owned Host children must be inspectable: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        };
    }
    let mut found = Vec::new();
    for pid in String::from_utf8(output.stdout)
        .map_err(|error| error.to_string())?
        .split_whitespace()
    {
        let pid = pid.parse::<u32>().map_err(|error| error.to_string())?;
        if let Some(process) = inspect(pid)? {
            if process.parent == host && process.arguments.contains(root.to_str().unwrap()) {
                found.push(process);
            }
        }
    }
    Ok(found)
}

struct HostProcess {
    child: Child,
    control: Option<crate::commands::execution::test_fixtures::OwnedDirectory>,
    observed: BTreeMap<u32, Process>,
    eof_confirmed: bool,
    keep_evidence: bool,
}
impl HostProcess {
    fn root(&self) -> &Path {
        self.control.as_ref().unwrap().0.path()
    }
    fn marker(&mut self, name: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(value) = read_marker(&self.root().join(name)) {
                return value;
            }
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "isolated Host exited before {name}; inspect its retained logs"
            );
            assert!(
                Instant::now() < deadline,
                "isolated Host did not publish {name}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn remember_children(&mut self) {
        for process in children(self.child.id(), self.root()).expect("scoped child observation") {
            self.observed.insert(process.pid, process);
        }
    }
    fn kill(&mut self) {
        assert!(self.child.try_wait().unwrap().is_none());
        self.remember_children();
        self.child.kill().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert_eq!(status.signal(), Some(libc::SIGKILL));
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned Host must be reaped after SIGKILL"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(self.child.wait().unwrap().signal(), Some(libc::SIGKILL));
        publish(
            self.root(),
            "host-exit.json",
            &json!({"hostPid":self.child.id(),"signal":libc::SIGKILL}),
        );
    }
    fn confirm_eof_exits(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let live: Vec<_> = self
                .observed
                .keys()
                .copied()
                .filter(|pid| {
                    inspect(*pid)
                        .expect("owned EOF process observation")
                        .is_some()
                })
                .collect();
            if live.is_empty() {
                self.eof_confirmed = true;
                publish(
                    self.root(),
                    "eof-exits.json",
                    &json!({"hostPid":self.child.id(),
                    "originalWorkerPids":self.observed.keys().copied().collect::<Vec<_>>(),"allAbsent":true}),
                );
                return;
            }
            assert!(
                Instant::now() < deadline,
                "Host pipe EOF did not terminate the original owned workers: {live:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for HostProcess {
    fn drop(&mut self) {
        let mut cleanup_failed = false;
        if self.child.try_wait().ok().flatten().is_none() {
            match children(self.child.id(), self.root()) {
                Ok(processes) => {
                    for process in processes {
                        self.observed.insert(process.pid, process);
                    }
                }
                Err(_) => cleanup_failed = true,
            }
            cleanup_failed |= self.child.kill().is_err();
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.child.try_wait().ok().flatten().is_none() {
                if Instant::now() >= deadline {
                    cleanup_failed = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        // EOF assertions run before this failure-only cleanup. A forced cleanup
        // can never turn an unconfirmed EOF exit into a successful observation.
        if !self.eof_confirmed {
            eprintln!("Host crash fixture did not confirm every original worker's EOF exit");
            for original in self.observed.values() {
                match inspect(original.pid) {
                    Ok(Some(current))
                        if current.arguments == original.arguments
                            && current.arguments.contains(self.root().to_str().unwrap()) =>
                    {
                        cleanup_failed |= !Command::new("/bin/kill")
                            .args(["-KILL", &original.pid.to_string()])
                            .output()
                            .is_ok_and(|output| output.status.success());
                    }
                    Ok(Some(_)) | Err(_) => cleanup_failed = true,
                    Ok(None) => {}
                }
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let remaining = self
                    .observed
                    .keys()
                    .any(|pid| !matches!(inspect(*pid), Ok(None)));
                if !remaining {
                    break;
                }
                if Instant::now() >= deadline {
                    cleanup_failed = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        if std::thread::panicking() || !self.eof_confirmed || cleanup_failed {
            let control = self.control.take().unwrap();
            eprintln!(
                "retained owned Host crash evidence at {}",
                control.0.path().display()
            );
            std::mem::forget(control);
            if !std::thread::panicking() {
                panic!("Host crash fixture cleanup was unconfirmed");
            }
        } else if self.keep_evidence {
            let control = self.control.take().unwrap();
            eprintln!(
                "retained completed Host crash evidence at {}",
                control.0.path().display()
            );
            std::mem::forget(control);
        }
    }
}

struct ExistingSession {
    app: tauri::App<tauri::test::MockRuntime>,
    webview: MockWebview,
    context: Value,
    path: PathBuf,
}
impl ExistingSession {
    fn open(path: PathBuf) -> Self {
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let opened = call(&webview, "open_project", json!({"locator":path})).unwrap();
        Self {
            app,
            webview,
            path,
            context: json!({"sessionToken":opened["sessionToken"],
            "projectId":opened["metadata"]["projectId"]}),
        }
    }
    fn call(&self, command: &str, extra: Value) -> Result<Value, Value> {
        call(
            &self.webview,
            command,
            super::super::super::request(&self.context, extra),
        )
    }
    fn host_exists(&self) -> bool {
        self.app
            .state::<AppState>()
            .sessions
            .with(|sessions| sessions.active.as_ref().unwrap().execution.is_some())
    }
    fn capture_rows(&self, work: &Value) -> Vec<Value> {
        let path = self.path.clone();
        let attempt = work["attemptId"].as_str().unwrap().to_owned();
        self.app
            .state::<AppState>()
            .sessions
            .with(move |_| super::super::capture_rows(&path, &attempt))
    }
    fn sequence(&self) -> Value {
        self.app.state::<AppState>().sessions.with(|sessions| {
            json!(
                sessions
                    .active
                    .as_ref()
                    .unwrap()
                    .store
                    .execution_sequence()
                    .unwrap()
            )
        })
    }
}
impl Drop for ExistingSession {
    fn drop(&mut self) {
        let result = call(
            &self.webview,
            "close_project",
            json!({"sessionToken":self.context["sessionToken"]}),
        );
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

fn record_tool_waiting(
    fixture: &TeamFixture,
    control: &Path,
    plan: &Value,
    a: &Value,
    member_b: ExecutionId,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let tools = loop {
        let tools = tool_history::tool_history(fixture, plan, a);
        let count = tools["attempts"].as_array().unwrap().len();
        assert!(count <= 1);
        if count == 1 {
            break tools;
        }
        assert!(
            Instant::now() < deadline,
            "the original tool attempt was not accepted"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let execution = execution(fixture, plan);
    let b = tool_history::work_reference(
        &execution["works"]
            .as_array()
            .unwrap()
            .iter()
            .find(|work| work["receipt"]["memberId"] == json!(member_b))
            .unwrap()["receipt"],
    );
    let tool = &tools["attempts"][0]["reference"];
    let attempts: [ExecutionId; 3] =
        [a, &b, tool].map(|work| serde_json::from_value(work["attemptId"].clone()).unwrap());
    let path = fixture.project_path.clone();
    let facts = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_ref().unwrap();
            let host = active.execution.as_ref().unwrap();
            let owned = attempts.map(|attempt| host.runtime.has_owned_attempt_work(attempt));
            let running = attempts.map(|attempt| host.runtime.is_active(attempt));
            let states = attempts.map(|attempt| {
                json!(active.store.execution_attempt(attempt, host.runtime.is_active(attempt)).unwrap())
            });
            let input = active.store.execution_input(attempts[2]).unwrap();
            // This read-only connection runs on the original command lane after
            // Core calls return. It records storage facts without changing them.
            let connection = rusqlite::Connection::open_with_flags(
                path.join("project.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ).unwrap();
            let mut statement = connection.prepare(
                "SELECT attempt_id,item_id,execution,dispatch_token,current_result_id
                 FROM execution_items WHERE attempt_id IN (?1,?2,?3)
                 ORDER BY attempt_id,item_id",
            ).unwrap();
            let rows = statement.query_map(
                rusqlite::params![attempts[0].to_string(),attempts[1].to_string(),attempts[2].to_string()],
                |row| {
                    Ok(json!({"attemptId":row.get::<_,String>(0)?,"itemId":row.get::<_,String>(1)?,
                        "execution":row.get::<_,String>(2)?,"dispatchToken":row.get::<_,Option<String>>(3)?,
                        "resultId":row.get::<_,Option<String>>(4)?}))
                },
            ).unwrap().map(Result::unwrap).collect::<Vec<_>>();
            let association = connection.query_row(
                "SELECT x.plan_id,x.generation,x.kind,x.root_task,x.delegation,
                        g.grant_id,g.input_digest,g.generation,g.expires_at_ms,g.revoked,g.delegation
                 FROM application_executions x JOIN plugin_execution_grants g USING(attempt_id)
                 WHERE x.attempt_id=?1",
                [attempts[2].to_string()],
                |row| {
                    let execution_delegation: Vec<u8> = row.get(4)?;
                    let grant_delegation: Option<Vec<u8>> = row.get(10)?;
                    Ok(json!({"planId":row.get::<_,String>(0)?,"planGeneration":row.get::<_,i64>(1)?,
                        "kind":row.get::<_,String>(2)?,"rootTask":row.get::<_,String>(3)?,
                        "executionDelegation":serde_json::from_slice::<Value>(&execution_delegation).unwrap(),
                        "grantId":row.get::<_,String>(5)?,"inputDigest":row.get::<_,String>(6)?,
                        "runtimeGeneration":row.get::<_,String>(7)?,"expiresAtMs":row.get::<_,i64>(8)?,
                        "revoked":row.get::<_,bool>(9)?,"grantDelegation":grant_delegation.map(|bytes|serde_json::from_slice::<Value>(&bytes).unwrap())}))
                },
            ).unwrap();
            json!({"ownedAttempts":owned,"activeAttempts":running,"attempts":states,"rawItems":rows,
                "toolInput":input.envelope(),"toolGrantAssociation":association})
        });
    assert_eq!(facts["toolGrantAssociation"]["planId"], plan["planId"]);
    assert_eq!(
        facts["toolGrantAssociation"]["inputDigest"],
        tool["inputDigest"]
    );
    let members = concurrency::owned_member_pids(fixture);
    let captures_a = concurrency::physical_requests(fixture, a);
    let captures_b = concurrency::physical_requests(fixture, &b);
    publish(
        control,
        "waiting.json",
        &json!({"hostPid":std::process::id(),"workA":a,"workB":b,
        "tools":tools,"facts":facts,"budget":execution["budget"],"capturesA":captures_a,
        "capturesB":captures_b,"memberPids":members,"queryEvents":tool_history::query_events(fixture)}),
    );
}

#[test]
#[ignore = "isolated Host selected by the crash regressions"]
fn pi_team_host_crash_child() {
    let control = PathBuf::from(std::env::var_os(CONTROL_ENV).expect("isolated Host control"));
    let bytes = fs::read(control.join("input.json")).unwrap();
    assert!(bytes.len() <= MAX_CONTROL_BYTES);
    let input: Input = serde_json::from_slice(&bytes).unwrap();
    assert!(input.configs.iter().all(|config| config.concurrency == 2));
    assert!(
        input
            .configs
            .iter()
            .all(|config| config.credential_env.is_empty())
    );
    let (mut fixture, selection) = TeamFixture::query(input.pending);
    // The parent owns this enclosing control directory and its cleanup. Even
    // an unexpected child unwind must leave the original ledger inspectable.
    fixture.0.as_mut().unwrap().directory.disable_cleanup(true);
    fixture.1.as_mut().unwrap().0.disable_cleanup(true);
    assert!(
        fixture
            .directory
            .path()
            .starts_with(control.join("temporary"))
    );
    assert!(
        fixture
            .1
            .as_ref()
            .unwrap()
            .0
            .path()
            .starts_with(control.join("temporary"))
    );
    publish(
        &control,
        "owned.json",
        &json!({"hostPid":std::process::id(),
        "directory":fixture.directory.path(),"installation":fixture.1.as_ref().unwrap().0.path()}),
    );
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":null,"text":"Protected human choice before Host process loss"}),
        )
        .unwrap();
    let original_history = history(&fixture);
    let original_protection = protection(&fixture);
    let (plan, grant) = team_plan_with_configs(
        &fixture,
        &input.configs.each_ref(),
        &input.members,
        [&["translation"], &["review"], &["evidence"]],
        Some(&selection),
    );
    let initial = execution(&fixture, &plan);
    let a = tool_history::work_reference(&initial["works"][0]["receipt"]);
    let parent: ExecutionId = serde_json::from_value(a["attemptId"].clone()).unwrap();
    let (reached, receiver) = std::sync::mpsc::channel();
    let (_release, held) = std::sync::mpsc::channel();
    if !input.pending {
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let host = sessions
                    .active
                    .as_mut()
                    .unwrap()
                    .execution
                    .as_mut()
                    .unwrap();
                assert!(
                    host.work_plans
                        .tool_reply_probes
                        .insert(parent, member::ToolReplyProbe::new(reached, held))
                        .is_none()
                );
            });
    }
    let start = json!({"planId":plan["planId"],"actionId":grant["actionId"],
        "expectedGeneration":grant["lease"]["generation"]});
    publish(
        &control,
        "started.json",
        &json!({"hostPid":std::process::id(),"plan":plan,
        "start":start,"work":a,"unitId":fixture.unit,"sourceRevisionId":fixture.source_revision,
        "snapshot":fixture.snapshot,"history":original_history,"protection":original_protection,
        "projectId":fixture.context["projectId"],"directory":fixture.directory.path(),
        "installation":fixture.1.as_ref().unwrap().0.path()}),
    );
    record_tool_waiting(&fixture, &control, &plan, &a, input.members[1]);
    let query_pid = tool_history::query_entered(&fixture);
    let observation = if input.pending {
        None
    } else {
        Some(
            receiver
                .recv_timeout(Duration::from_secs(30))
                .expect("stored outcome before member delivery"),
        )
    };
    let execution = execution(&fixture, &plan);
    assert_eq!(execution["works"].as_array().unwrap().len(), 2);
    let b = tool_history::work_reference(
        &execution["works"]
            .as_array()
            .unwrap()
            .iter()
            .find(|work| work["receipt"]["memberId"] == json!(input.members[1]))
            .unwrap()["receipt"],
    );
    let tools = tool_history::tool_history(&fixture, &plan, &a);
    assert_eq!(tools["attempts"].as_array().unwrap().len(), 1);
    let tool = tools["attempts"][0]["reference"].clone();
    let detail = tool_history::attempt(&fixture, &tool);
    let output = if let Some(observation) = observation {
        assert_eq!(tool["taskId"], json!(observation.tool.task_id));
        assert_eq!(tool["attemptId"], json!(observation.tool.attempt_id));
        assert_eq!(
            json!(observation.tool.tool_handle),
            tools["attempts"][0]["toolHandle"]
        );
        assert_eq!(
            json!(observation.tool.unit_ids),
            tools["attempts"][0]["unitIds"]
        );
        assert_eq!(tool["inputDigest"], json!(observation.input_digest));
        assert_eq!(
            detail["items"][0]["status"]["itemId"],
            json!(observation.item_id)
        );
        assert_eq!(detail["items"][0]["resultId"], json!(observation.result_id));
        assert_eq!(tools["attempts"][0]["storedResultItems"], 1);
        assert!(
            inspect(query_pid).unwrap().is_none(),
            "stored SDK producer has already drained"
        );
        fixture
            .call(
                "read_execution_output",
                json!({"attemptId":tool["attemptId"],
            "resultId":observation.result_id}),
            )
            .unwrap()
    } else {
        assert_eq!(tools["attempts"][0]["storedResultItems"], 0);
        assert_eq!(detail["items"][0]["status"]["execution"], "dispatched");
        assert!(detail["items"][0]["resultId"].is_null());
        let process = inspect(query_pid)
            .unwrap()
            .expect("pending SDK producer remains alive");
        assert_eq!(process.parent, std::process::id());
        assert!(
            process
                .arguments
                .contains(fixture.1.as_ref().unwrap().0.path().to_str().unwrap())
        );
        assert!(process.arguments.contains("component.mjs"));
        Value::Null
    };
    let members = concurrency::owned_member_pids(&fixture);
    assert_eq!(members.len(), 2);
    assert!(!members.contains(&query_pid));
    let captures_a = concurrency::physical_requests(&fixture, &a);
    let captures_b = concurrency::physical_requests(&fixture, &b);
    assert_eq!(captures_a.len(), 2);
    assert_eq!(captures_b.len(), 1);
    assert_eq!(captures_b[0]["state"], "unknown");
    assert_eq!(execution["budget"]["dispatched"], 3);
    assert_eq!(execution["budget"]["unresolved"], 1);
    assert_eq!(execution["budget"]["usageUnknown"], 1);
    let original_state = fixture
        .call(
            "read_work_plan_team_recovery_state",
            json!({"planId":plan["planId"]}),
        )
        .unwrap();
    assert_eq!(original_state["runtime"]["originalDeadlineAvailable"], true);
    let attempt_a: ExecutionId = serde_json::from_value(a["attemptId"].clone()).unwrap();
    let attempt_b: ExecutionId = serde_json::from_value(b["attemptId"].clone()).unwrap();
    let attempt_tool: ExecutionId = serde_json::from_value(tool["attemptId"].clone()).unwrap();
    let owned = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let host = sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap();
            [attempt_a, attempt_b, attempt_tool]
                .map(|attempt| host.runtime.has_owned_attempt_work(attempt))
        });
    assert_eq!(owned, [true, true, input.pending]);
    let sequence = fixture.app.state::<AppState>().sessions.with(|sessions| {
        sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .execution_sequence()
            .unwrap()
    });
    publish(
        &control,
        "ready.json",
        &json!({"hostPid":std::process::id(),"workA":a,"workB":b,
        "tools":tools,"detail":detail,"output":output,"capturesA":captures_a,"capturesB":captures_b,
        "budget":execution["budget"],"state":original_state["state"],"ownedAttempts":owned,
        "sequence":sequence,"memberPids":members,"queryPid":query_pid,
        "events":tool_history::query_events(&fixture)}),
    );
    // The real SessionExecutor continues ticking. No owner callback, Store
    // transaction or IO worker is blocked by this test-thread rendezvous.
    std::thread::park_timeout(Duration::from_secs(30));
    panic!("the parent did not kill its isolated Host at the observed boundary");
}

fn crash(pending: bool) {
    let peers = peers();
    let input = Input {
        configs: peers.each_ref().map(|peer| peer.config.clone()),
        members: std::array::from_fn(|_| ExecutionId::new()),
        pending,
    };
    let evidence = std::env::var_os(EVIDENCE_ENV).map(PathBuf::from);
    let directory = if let Some(path) = &evidence {
        assert!(
            path.is_absolute(),
            "explicit Host evidence directory must be absolute"
        );
        fs::create_dir_all(path).unwrap();
        tempfile::Builder::new()
            .prefix(if pending { "pending-" } else { "stored-" })
            .tempdir_in(path)
            .unwrap()
    } else {
        tempfile::tempdir().unwrap()
    };
    let control = crate::commands::execution::test_fixtures::OwnedDirectory(directory);
    fs::create_dir(control.0.path().join("temporary")).unwrap();
    fs::write(
        control.0.path().join("input.json"),
        serde_json::to_vec(&input).unwrap(),
    )
    .unwrap();
    let stdout = fs::File::create(control.0.path().join("host.stdout.log")).unwrap();
    let stderr = fs::File::create(control.0.path().join("host.stderr.log")).unwrap();
    let child_test = format!(
        "{}::pi_team_host_crash_child",
        module_path!().split_once("::").unwrap().1
    );
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            &child_test,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CONTROL_ENV, control.0.path())
        .env("TMPDIR", control.0.path().join("temporary"))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .unwrap();
    let mut host = HostProcess {
        child,
        control: Some(control),
        observed: BTreeMap::new(),
        eof_confirmed: false,
        keep_evidence: evidence.is_some(),
    };
    let owned = host.marker("owned.json");
    assert_eq!(owned["hostPid"], json!(host.child.id()));
    assert_ne!(host.child.id(), std::process::id());
    let directory = PathBuf::from(owned["directory"].as_str().unwrap());
    let installation = PathBuf::from(owned["installation"].as_str().unwrap());
    assert!(directory.starts_with(host.root().join("temporary")));
    assert!(installation.starts_with(host.root().join("temporary")));
    host.remember_children();
    eprintln!(
        "isolated team Host pid={} pending={pending} stage=owned",
        host.child.id()
    );
    let started = host.marker("started.json");
    eprintln!(
        "isolated team Host pid={} pending={pending} stage=started",
        host.child.id()
    );
    assert_eq!(started["hostPid"], json!(host.child.id()));
    assert_eq!(started["directory"], owned["directory"]);
    assert_eq!(started["installation"], owned["installation"]);
    host.remember_children();
    let a0 = peers[0].accept();
    let raw_a0 = a0.raw.clone();
    let (_, view_a0) = work_view(&a0);
    assert_eq!(view_a0["author"]["memberId"], json!(input.members[0]));
    assert_eq!(
        tool_history::work_reference(&view_a0["work"]),
        started["work"]
    );
    let target = view_a0["discussion"]["target"].clone();
    a0.tool(
        "request-review",
        "request_team_work",
        request(
            ExecutionId::new(),
            input.members[1],
            &target,
            "review",
            &[],
            Value::Null,
        ),
    );
    let a1 = peers[0].accept();
    let raw_a1 = a1.raw.clone();
    let b0 = peers[1].accept();
    let raw_b0 = b0.raw.clone();
    let (_, view_b0) = work_view(&b0);
    let b = tool_result(&a1.body, "request-review");
    assert_eq!(b, view_b0["work"]);
    assert_eq!(view_b0["author"]["memberId"], json!(input.members[1]));
    host.remember_children();
    publish(
        host.root(),
        "observed-early-processes.json",
        &json!({"hostPid":host.child.id(),
        "workers":host.observed.values().map(|process|json!({"pid":process.pid,
            "parent":process.parent,"arguments":process.arguments})).collect::<Vec<_>>() }),
    );
    let handle = &started["plan"]["tools"]["entries"][0]["handle"];
    let name = format!("tool_{}", handle.as_str().unwrap().replace('-', "_"));
    publish(
        host.root(),
        "observed-http.json",
        &json!({"hostPid":host.child.id(),
        "a0":raw_a0,"a1":raw_a1,"b0":raw_b0}),
    );
    a1.tool("original-query", &name, json!({"unitId":started["unitId"]}));
    let ready = host.marker("ready.json");
    assert_eq!(ready["hostPid"], json!(host.child.id()));
    assert_eq!(ready["workA"], started["work"]);
    assert_eq!(ready["workB"], tool_history::work_reference(&b));
    assert_eq!(ready["capturesA"][0]["capture"]["body"], raw_a0);
    assert_eq!(ready["capturesA"][1]["capture"]["body"], raw_a1);
    assert_eq!(ready["capturesB"][0]["capture"]["body"], raw_b0);
    assert_eq!(ready["capturesB"][0]["capture"]["teamWorkView"], view_b0);
    assert_eq!(ready["budget"]["dispatched"], 3);
    assert_eq!(ready["budget"]["unresolved"], 1);
    assert_eq!(ready["budget"]["usageUnknown"], 1);
    assert_eq!(ready["budget"]["legacyHeld"], 0);
    assert_eq!(ready["ownedAttempts"], json!([true, true, pending]));
    let original_pids: Vec<u32> = serde_json::from_value(ready["memberPids"].clone()).unwrap();
    assert_eq!(original_pids.len(), 2);
    let query_pid: u32 = serde_json::from_value(ready["queryPid"].clone()).unwrap();
    for pid in original_pids {
        let process = inspect(pid)
            .unwrap()
            .expect("original Pi is alive before Host crash");
        assert_eq!(process.parent, host.child.id());
        assert!(process.arguments.contains(installation.to_str().unwrap()));
        assert!(process.arguments.contains("worker.mjs"));
        host.observed.insert(pid, process);
    }
    if pending {
        let process = inspect(query_pid)
            .unwrap()
            .expect("real SDK producer remains pending");
        assert_eq!(process.parent, host.child.id());
        assert!(process.arguments.contains(installation.to_str().unwrap()));
        assert!(process.arguments.contains("component.mjs"));
        host.observed.insert(query_pid, process);
    } else {
        assert!(
            inspect(query_pid).unwrap().is_none(),
            "stored SDK producer exited before Host crash"
        );
    }
    host.remember_children();
    assert_eq!(host.observed.len(), if pending { 3 } else { 2 });
    publish(
        host.root(),
        "observed-processes.json",
        &json!({"hostPid":host.child.id(),
        "sdkAlreadyDrained":!pending,"queryPid":query_pid,
        "workers":host.observed.values().map(|process|json!({"pid":process.pid,
            "parent":process.parent,"arguments":process.arguments})).collect::<Vec<_>>() }),
    );
    b0.socket.set_nonblocking(true).unwrap();
    assert!(
        matches!(b0.socket.peek(&mut [0;1]),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
    b0.socket.set_nonblocking(false).unwrap();
    host.kill();
    host.confirm_eof_exits();
    eprintln!(
        "isolated team Host pid={} pending={pending} stage=killed-and-eof-confirmed physical_http=3",
        host.child.id()
    );
    assert_eq!(
        (&b0.socket).read(&mut [0; 1]).unwrap(),
        0,
        "the original held provider connection closes with its Host"
    );
    assert_eq!(
        json!(events_at(&directory)),
        ready["events"],
        "Host loss cannot create another tool invocation or a graceful-dispose receipt"
    );
    let project = ExistingSession::open(directory.join("project"));
    assert_eq!(project.context["projectId"], started["projectId"]);
    assert!(!project.host_exists());
    let plan = &started["plan"];
    let reopened_state = project
        .call(
            "read_work_plan_team_recovery_state",
            json!({"planId":plan["planId"]}),
        )
        .unwrap();
    assert!(reopened_state["runtime"].is_null());
    assert_eq!(reopened_state["state"]["state"], "paused");
    assert_eq!(
        reopened_state["state"]["expiresAtMs"],
        ready["state"]["expiresAtMs"]
    );
    assert_eq!(
        reopened_state["state"]["effectiveVersion"],
        ready["state"]["effectiveVersion"]
    );
    assert_eq!(
        reopened_state["state"]["unresolvedWork"],
        ready["state"]["unresolvedWork"]
    );
    assert_eq!(
        reopened_state["state"]["unresolvedWork"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        reopened_state["state"]["lease"]["generation"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap(),
        ready["state"]["lease"]["generation"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            + 1
    );
    let tools = project
        .call(
            "read_work_plan_team_work_tools",
            json!({"planId":plan["planId"],
        "work":ready["workA"],"after":null,"limit":16}),
        )
        .unwrap();
    assert_eq!(tools, ready["tools"]);
    let tool = &tools["attempts"][0]["reference"];
    let task = project
        .call("read_execution_task_view", json!({"taskId":tool["taskId"]}))
        .unwrap();
    assert_eq!(task["taskId"], tool["taskId"]);
    let attempts = project
        .call(
            "read_execution_task",
            json!({"taskId":tool["taskId"],"after":"0","limit":16}),
        )
        .unwrap();
    assert_eq!(attempts.as_array().unwrap().len(), 1);
    assert_eq!(attempts[0]["attemptId"], tool["attemptId"]);
    if pending {
        assert!(ready["output"].is_null());
    } else {
        assert_eq!(
            project
                .call(
                    "read_execution_output",
                    json!({"attemptId":tool["attemptId"],
            "resultId":ready["detail"]["items"][0]["resultId"]})
                )
                .unwrap(),
            ready["output"]
        );
    }
    assert_eq!(
        project
            .call("read_work_plan_start_action", started["start"].clone())
            .unwrap()["attemptId"],
        ready["workA"]["attemptId"]
    );
    assert_eq!(
        project
            .call("start_work_plan", started["start"].clone())
            .unwrap(),
        ready["workA"]["attemptId"]
    );
    assert!(
        !project.host_exists(),
        "historical acknowledgement and outputs create no Host"
    );
    let execution = project
        .call(
            "read_work_plan_team_execution",
            json!({"planId":plan["planId"],
        "afterWork":null,"afterMessage":null,"limit":16}),
        )
        .unwrap();
    assert_eq!(execution["works"].as_array().unwrap().len(), 2);
    // Team history retains the dispatch fact. Only the ordinary Task reader
    // below projects this interrupted work as Unknown when no producer is live.
    assert!(
        execution["works"]
            .as_array()
            .unwrap()
            .iter()
            .all(|work| work["execution"] == "dispatched" && work["candidateRevisionId"].is_null())
    );
    assert_eq!(execution["budget"], ready["budget"]);
    for (work, key) in [
        (&ready["workA"], "capturesA"),
        (&ready["workB"], "capturesB"),
    ] {
        assert_eq!(
            project.capture_rows(work),
            ready[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["capture"].clone())
                .collect::<Vec<_>>()
        );
    }
    assert_eq!(project.sequence(), ready["sequence"]);
    assert_eq!(
        project
            .call(
                "read_translation_history",
                json!({"unitId":started["unitId"],"locale":"zh-CN","afterOrdinal":"0","limit":100})
            )
            .unwrap(),
        started["history"]
    );
    assert_eq!(
        project
            .call(
                "read_work_protection",
                json!({"unitId":started["unitId"],"locale":"zh-CN"})
            )
            .unwrap(),
        started["protection"]
    );
    assert!(!project.host_exists());
    let detail = project
        .call(
            "read_execution_attempt",
            json!({"attemptId":tool["attemptId"],"offset":0,"limit":100}),
        )
        .unwrap();
    assert_eq!(
        detail["items"][0]["resultId"],
        ready["detail"]["items"][0]["resultId"]
    );
    assert_eq!(
        detail["items"][0]["status"]["execution"],
        if pending { "unknown" } else { "succeeded" }
    );
    assert!(project.host_exists());
    for work in [&ready["workA"], &ready["workB"]] {
        let interrupted = project
            .call(
                "read_execution_attempt",
                json!({"attemptId":work["attemptId"],"offset":0,"limit":100}),
            )
            .unwrap();
        assert_eq!(interrupted["items"][0]["status"]["execution"], "unknown");
        assert!(interrupted["items"][0]["resultId"].is_null());
    }
    let state = project
        .call(
            "read_work_plan_team_recovery_state",
            json!({"planId":plan["planId"]}),
        )
        .unwrap();
    assert_eq!(state["state"]["state"], "paused");
    assert_eq!(state["runtime"]["originalDeadlineAvailable"], false);
    assert_eq!(state["runtime"]["producersDrained"], true);
    assert_eq!(state["state"]["budget"], ready["budget"]);
    let denied = project.call("prepare_work_plan_team_recovery",json!({"preparationId":ExecutionId::new(),
        "recovery":{"projectId":project.context["projectId"],"planId":plan["planId"],
        "expectedLease":state["state"]["lease"],"expectedEffectiveVersion":state["state"]["effectiveVersion"],
        "members":plan["options"]["teamExecution"]["members"],"work":{"workId":ExecutionId::new(),
        "memberId":input.members[0],"target":target,"kind":"translation","instructions":"Human explicitly requests another original member work.",
        "postIds":[],"priorWork":state["state"]["unresolvedWork"]}}})).unwrap_err();
    assert_eq!(denied["code"], "permission-denied");
    assert_eq!(denied["reason"], "team-recovery-live-anchor");
    assert_eq!(project.sequence(), ready["sequence"]);
    assert_eq!(
        project
            .call(
                "read_work_plan_team_work_tools",
                json!({"planId":plan["planId"],
        "work":ready["workA"],"after":null,"limit":16})
            )
            .unwrap(),
        tools
    );
    assert_eq!(json!(events_at(&directory)), ready["events"]);
    let final_execution = project
        .call(
            "read_work_plan_team_execution",
            json!({"planId":plan["planId"],
        "afterWork":null,"afterMessage":null,"limit":16}),
        )
        .unwrap();
    assert_eq!(final_execution["budget"], ready["budget"]);
    assert_eq!(final_execution["works"], execution["works"]);
    for (work, key) in [
        (&ready["workA"], "capturesA"),
        (&ready["workB"], "capturesB"),
    ] {
        assert_eq!(
            project.capture_rows(work),
            ready[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["capture"].clone())
                .collect::<Vec<_>>()
        );
    }
    assert!(
        children(std::process::id(), host.root())
            .unwrap()
            .is_empty(),
        "observation creates no replacement worker"
    );
    for peer in &peers {
        assert!(
            matches!(peer.listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
            "no model request may be replayed"
        );
    }
    publish(
        host.root(),
        "completed.json",
        &json!({"hostPid":host.child.id(),"pending":pending,
        "physicalHttp":3,"budget":final_execution["budget"],"sequence":project.sequence(),
        "originalDeadlineAvailable":state["runtime"]["originalDeadlineAvailable"],
        "storedResultItems":tools["attempts"][0]["storedResultItems"],"allAssertionsCompleted":true}),
    );
}

#[test]
fn pi_team_host_crash_preserves_stored_tool_result_and_unresolved_model_budget() {
    crash(false);
}

#[test]
fn pi_team_host_crash_preserves_missing_tool_result_without_replaying_workers() {
    crash(true);
}
