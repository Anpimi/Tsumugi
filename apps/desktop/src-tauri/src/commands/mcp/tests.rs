use super::*;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::{content, execution::*};

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
    .map(|r| r.deserialize().unwrap())
}
struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    _directory: tempfile::TempDir,
    project: Value,
    context: Value,
    unit: ExecutionId,
    revision: ExecutionId,
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
        let project = call(
            &window,
            "create_project",
            json!({"destination":directory.path().join("project"),
            "displayName":"Synthetic disclosure", "sourceLocale":"en", "targetLocales":["zh-CN"]}),
        )
        .unwrap();
        let context = json!({"sessionToken":project["sessionToken"], "projectId":project["metadata"]["projectId"]});
        let (unit, revision) = app.state::<AppState>().sessions.with(|s| {
            let store = &mut s.active.as_mut().unwrap().store;
            let bytes = serde_json::to_vec(&json!({"entry":"Copper 👩🏽‍💻"})).unwrap();
            let source = content::SourceBundle::capture(
                include_bytes!(
                    "../../../../../../crates/core/tests/fixtures/stardew-lookup/manifest.json"
                ),
                &bytes,
                "en",
            )
            .unwrap();
            let input = source
                .fixed_input(store.metadata().unwrap().project_id())
                .unwrap();
            let mut runtime = ExecutionRuntime::new(store).unwrap();
            runtime
                .register_read_only(Arc::new(content::SourceRunner))
                .unwrap();
            runtime.submit(store, &input).unwrap();
            let until = Instant::now() + Duration::from_secs(10);
            let result = loop {
                runtime.tick(store).unwrap();
                if let Some(result) = store
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id,
                    )
                    .unwrap()
                {
                    break result;
                }
                assert!(Instant::now() < until);
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
            let row = store.source_content(snapshot, 0, 1).unwrap().rows.remove(0);
            (row.unit_id.unwrap(), row.source_revision_id.unwrap())
        });
        Self {
            app,
            window,
            _directory: directory,
            project,
            context,
            unit,
            revision,
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
    fn prepare(&self) -> Value {
        self.prepare_flags(false, false)
    }
    fn prepare_flags(&self, terms: bool, context: bool) -> Value {
        let session = call(&self.window, "read_mcp_share_session", self.context.clone()).unwrap();
        let preparation = json!({"identity":{"ownerId":session["ownerId"],"generation":session["nextGeneration"],"shareId":ExecutionId::new()},
            "recipientLabel":"Synthetic independent recipient", "selection":{"projectId":self.context["projectId"],"unitId":self.unit,
                "locale":"zh-CN","shareTerms":terms,"shareContext":context}});
        call(
            &self.window,
            "prepare_mcp_share",
            self.request(json!({"preparation":preparation})),
        )
        .unwrap()
    }
    fn authorize(&self, prepared: &Value, seconds: u32) -> Value {
        let authorization = json!({"identity":prepared["preparation"]["identity"], "actionId":ExecutionId::new(),
            "previewDigest":prepared["preview"]["digest"], "validForSeconds":seconds, "confirmed":true});
        call(
            &self.window,
            "authorize_mcp_share",
            self.request(json!({"authorization":authorization})),
        )
        .unwrap()
    }
    fn view(&self, id: &Value, auth: &Value) -> Value {
        call(
            &self.window,
            "read_mcp_share",
            self.request(json!({"identity":id,"authorization":auth})),
        )
        .unwrap()
    }
    fn revoke(&self, id: &Value) -> Value {
        call(
            &self.window,
            "revoke_mcp_share",
            self.request(json!({"identity":id,"actionId":ExecutionId::new()})),
        )
        .unwrap()
    }
    fn drained(&self, id: &Value, auth: &Value) {
        let until = Instant::now() + Duration::from_secs(8);
        loop {
            let view = self.view(id, auth);
            if view["admissionClosed"] == true && view["callbacksDrained"] == true {
                assert_eq!(view["phase"], "closed");
                return;
            }
            assert!(Instant::now() < until, "disclosure did not drain");
            std::thread::sleep(Duration::from_millis(5));
        }
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
    fn no_execution_host(&self) {
        self.app.state::<AppState>().sessions.with(|s| {
            assert!(
                s.active.as_ref().unwrap().execution.is_none(),
                "sharing created an execution host"
            )
        });
    }
}
fn port(authorized: &Value) -> u16 {
    authorized["configuration"]["args"][2]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}
fn credential(authorized: &Value) -> &str {
    authorized["configuration"]["env"]["TSUMUGI_MCP_PAIRING"]
        .as_str()
        .unwrap()
}
fn paired(authorized: &Value, secret: &str) -> std::io::Result<BufReader<TcpStream>> {
    let mut socket = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port(authorized)))?;
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    writeln!(socket, "{}", json!({"version":1,"credential":secret}))?;
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if line != "OK\n" {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(reader)
}
fn rpc(reader: &mut BufReader<TcpStream>, value: Value) -> Value {
    writeln!(reader.get_mut(), "{value}").unwrap();
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}
fn initialize(reader: &mut BufReader<TcpStream>) {
    let result = rpc(
        reader,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Untrusted client label","version":"1"}}}),
    );
    assert!(result["result"]["capabilities"]["tools"].is_object());
    writeln!(
        reader.get_mut(),
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .unwrap();
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn mcp_share_registered_fixed_snapshot_pairing_and_exact_revoke() {
    let f = Fixture::new();
    let sequence = f.sequence();
    let prepared = f.prepare();
    f.no_execution_host();
    assert_eq!(prepared["preview"]["payload"]["terms"], Value::Null);
    assert_eq!(prepared["preview"]["payload"]["manualContext"], Value::Null);
    let authorized = f.authorize(&prepared, 300);
    let id = &authorized["view"]["identity"];
    let auth = &authorized["view"]["authorization"];
    let mut unpaired =
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port(&authorized))).unwrap();
    unpaired
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    writeln!(unpaired, "{}", json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"Synthetic independent recipient","version":"1"}}}})).unwrap();
    let mut unauthenticated = String::new();
    let _ = unpaired.read_to_string(&mut unauthenticated);
    assert!(
        unauthenticated.is_empty(),
        "clientInfo bypassed independent pairing"
    );
    // Wrong credentials never consume the one valid pairing.
    assert!(paired(&authorized, "incorrect-independent-credential").is_err());
    let mut socket = paired(&authorized, credential(&authorized)).unwrap();
    initialize(&mut socket);
    let replay = call(
        &f.window,
        "authorize_mcp_share",
        f.request(json!({"authorization":auth})),
    )
    .unwrap();
    assert!(credential(&replay) == credential(&authorized));
    assert_eq!(
        replay["view"]["expiresAtMs"],
        authorized["view"]["expiresAtMs"]
    );
    f.no_execution_host();
    assert_eq!(f.sequence(), sequence);
    // Later saved edits do not expand or replace the accepted fixed disclosure.
    call(&f.window, "save_translation_revision", f.request(json!({"actionId":ExecutionId::new(),"unitId":f.unit,
        "locale":"zh-CN","sourceRevisionId":f.revision,"expectedSelectionId":null,"text":"Later saved translation"}))).unwrap();
    let sequence_after_manual_edit = f.sequence();
    assert!(sequence_after_manual_edit >= sequence);
    let entry = rpc(
        &mut socket,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tsumugi_read_entry","arguments":{}}}),
    );
    assert_eq!(
        entry["result"]["structuredContent"]["source"]["text"],
        "Copper 👩🏽‍💻"
    );
    assert!(entry["result"]["structuredContent"]["translation"].is_null());
    assert!(
        entry["result"]["structuredContent"]
            .get("projectId")
            .is_none()
    );
    let terms = rpc(
        &mut socket,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tsumugi_read_terms","arguments":{}}}),
    );
    assert_eq!(terms["result"]["isError"], true);
    let forbidden = rpc(
        &mut socket,
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"tsumugi_read_entry","arguments":{"unitId":ExecutionId::new()}}}),
    );
    assert!(forbidden.get("error").is_some());
    f.revoke(id);
    f.drained(id, auth);
    assert!(
        call(
            &f.window,
            "authorize_mcp_share",
            f.request(json!({"authorization":auth}))
        )
        .is_err()
    );
    assert!(paired(&authorized, credential(&authorized)).is_err());
    assert_eq!(f.sequence(), sequence_after_manual_edit);
    // Status never contains the credential/configuration or source payload.
    let view = f.view(id, auth);
    assert!(view.get("configuration").is_none());
    assert!(view.get("preview").is_none());
}

#[test]
fn mcp_share_lost_prepare_authorize_stop_and_session_isolation() {
    let f = Fixture::new();
    let session = call(&f.window, "read_mcp_share_session", f.context.clone()).unwrap();
    let identity = json!({"ownerId":session["ownerId"],"generation":session["nextGeneration"],"shareId":ExecutionId::new()});
    // A stop arriving before preparation permanently consumes that generation.
    let stop = f.revoke(&identity);
    assert_eq!(stop["callbacksDrained"], true);
    let late = json!({"identity":identity,"recipientLabel":"Late recipient","selection":{"projectId":f.context["projectId"],
        "unitId":f.unit,"locale":"zh-CN","shareTerms":false,"shareContext":false}});
    assert!(
        call(
            &f.window,
            "prepare_mcp_share",
            f.request(json!({"preparation":late}))
        )
        .is_err()
    );
    let prepared = f.prepare();
    let id = &prepared["preparation"]["identity"];
    let original = json!({"identity":id,"actionId":ExecutionId::new(),"previewDigest":prepared["preview"]["digest"],"validForSeconds":300,"confirmed":true});
    assert!(f.view(id, &original)["authorization"].is_null());
    let mut wrong_identity = original.clone();
    wrong_identity["identity"]["shareId"] = json!(ExecutionId::new());
    assert!(
        call(
            &f.window,
            "read_mcp_share",
            f.request(json!({"identity":id,"authorization":wrong_identity}))
        )
        .is_err()
    );
    let accepted = call(
        &f.window,
        "authorize_mcp_share",
        f.request(json!({"authorization":original})),
    )
    .unwrap();
    assert_eq!(f.view(id, &original)["authorization"], original);
    let mut changed = original.clone();
    changed["validForSeconds"] = json!(600);
    assert!(
        call(
            &f.window,
            "authorize_mcp_share",
            f.request(json!({"authorization":changed}))
        )
        .is_err()
    );
    f.revoke(id);
    f.drained(id, &original);
    call(
        &f.window,
        "close_project",
        json!({"sessionToken":f.context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &f.window,
        "open_project",
        json!({"locator":f.project["locator"]}),
    )
    .unwrap();
    let new_context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"],"identity":id,"authorization":original});
    assert!(call(&f.window, "read_mcp_share", new_context).is_err());
    let b = call(
        &f.window,
        "create_project",
        json!({"destination":f._directory.path().join("second"),"displayName":"Synthetic B",
        "sourceLocale":"en","targetLocales":["zh-CN"]}),
    )
    .unwrap();
    assert!(
        call(
            &f.window,
            "read_mcp_share",
            json!({"sessionToken":b["sessionToken"],"projectId":b["metadata"]["projectId"],
        "identity":id,"authorization":null})
        )
        .is_err()
    );
    let session_b = call(
        &f.window,
        "read_mcp_share_session",
        json!({"sessionToken":b["sessionToken"],"projectId":b["metadata"]["projectId"]}),
    )
    .unwrap();
    assert!(session_b["current"].is_null());
    assert!(paired(&accepted, credential(&accepted)).is_err());
}

#[test]
fn mcp_share_failed_prepare_has_exact_closed_observation() {
    let f = Fixture::new();
    let session = call(&f.window, "read_mcp_share_session", f.context.clone()).unwrap();
    let preparation = json!({"identity":{"ownerId":session["ownerId"],"generation":session["nextGeneration"],"shareId":ExecutionId::new()},
        "recipientLabel":"Synthetic", "selection":{"projectId":f.context["projectId"],"unitId":ExecutionId::new(),"locale":"zh-CN","shareTerms":false,"shareContext":false}});
    assert!(
        call(
            &f.window,
            "prepare_mcp_share",
            f.request(json!({"preparation":preparation}))
        )
        .is_err()
    );
    let view = f.view(&preparation["identity"], &Value::Null);
    assert_eq!(view["admissionClosed"], true);
    assert_eq!(view["callbacksDrained"], true);
    assert!(view["error"].is_object());
    assert_eq!(view["preparation"], preparation);
}

#[test]
fn mcp_share_read_limits_empty_optin_and_disconnect_do_not_restore_pairing() {
    let f = Fixture::new();
    let prepared = f.prepare_flags(true, false);
    let sequence = f.sequence();
    let authorized = f.authorize(&prepared, 300);
    let id = &authorized["view"]["identity"];
    let auth = &authorized["view"]["authorization"];
    let mut socket = paired(&authorized, credential(&authorized)).unwrap();
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientInfo":{"name":"Untrusted current client","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}});
    let discovery = rpc(
        &mut socket,
        json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":meta}}),
    );
    assert!(
        discovery["result"]["supportedVersions"]
            .as_array()
            .unwrap()
            .contains(&json!("2026-07-28"))
    );
    let catalog = rpc(
        &mut socket,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":meta}}),
    );
    assert_eq!(catalog["result"]["tools"].as_array().unwrap().len(), 3);
    assert!(
        paired(&authorized, credential(&authorized)).is_err(),
        "a second authenticated connection was accepted"
    );
    for n in 0..100 {
        let value = rpc(
            &mut socket,
            json!({"jsonrpc":"2.0","id":n+3,"method":"tools/call","params":{"_meta":meta,"name":"tsumugi_read_terms","arguments":{}}}),
        );
        assert_eq!(value["result"]["isError"], false);
        assert_eq!(value["result"]["structuredContent"]["terms"], json!([]));
    }
    writeln!(socket.get_mut(), "{}", json!({"jsonrpc":"2.0","id":103,"method":"tools/call","params":{"_meta":meta,"name":"tsumugi_read_entry","arguments":{}}})).unwrap();
    let mut late = String::new();
    match socket.read_to_string(&mut late) {
        Ok(_) => {}
        Err(error) => assert!(matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
        )),
    }
    assert!(
        late.is_empty(),
        "read beyond the finite allowance produced a payload"
    );
    f.drained(id, auth);
    assert_eq!(f.sequence(), sequence);
    f.no_execution_host();
    assert!(paired(&authorized, credential(&authorized)).is_err());
    // A later, independently approved generation gets its own credential; an
    // ordinary disconnect permanently closes that generation too.
    let next = f.prepare();
    let next_auth = f.authorize(&next, 300);
    let mut next_socket = paired(&next_auth, credential(&next_auth)).unwrap();
    initialize(&mut next_socket);
    drop(next_socket);
    f.drained(
        &next_auth["view"]["identity"],
        &next_auth["view"]["authorization"],
    );
    assert!(paired(&next_auth, credential(&next_auth)).is_err());
    assert!(f.view(id, auth)["admissionClosed"] == true);
}

#[test]
fn mcp_share_expiry_and_project_close_revoke_live_transport_without_execution() {
    let f = Fixture::new();
    let sequence = f.sequence();
    let prepared = f.prepare();
    let authorized = f.authorize(&prepared, 1);
    let mut socket = paired(&authorized, credential(&authorized)).unwrap();
    initialize(&mut socket);
    f.drained(
        &authorized["view"]["identity"],
        &authorized["view"]["authorization"],
    );
    assert!(paired(&authorized, credential(&authorized)).is_err());
    f.no_execution_host();
    assert_eq!(f.sequence(), sequence);
    let next = f.prepare();
    let accepted = f.authorize(&next, 300);
    let mut socket = paired(&accepted, credential(&accepted)).unwrap();
    initialize(&mut socket);
    let closed = call(
        &f.window,
        "close_project",
        json!({"sessionToken":f.context["sessionToken"]}),
    );
    if let Err(error) = closed {
        assert_eq!(error["code"], "busy");
        f.drained(
            &accepted["view"]["identity"],
            &accepted["view"]["authorization"],
        );
        call(
            &f.window,
            "close_project",
            json!({"sessionToken":f.context["sessionToken"]}),
        )
        .unwrap();
    }
    assert!(paired(&accepted, credential(&accepted)).is_err());
    assert!(
        call(
            &f.window,
            "read_mcp_share",
            f.request(json!({"identity":accepted["view"]["identity"],"authorization":null}))
        )
        .is_err()
    );
}

#[test]
fn mcp_share_authorization_rechecks_preview_without_silently_recapturing() {
    let f = Fixture::new();
    let prepared = f.prepare();
    call(&f.window, "save_translation_revision", f.request(json!({"actionId":ExecutionId::new(),"unitId":f.unit,
        "locale":"zh-CN","sourceRevisionId":f.revision,"expectedSelectionId":null,"text":"New saved value"}))).unwrap();
    let authorization = json!({"identity":prepared["preparation"]["identity"],"actionId":ExecutionId::new(),"previewDigest":prepared["preview"]["digest"],
        "validForSeconds":300,"confirmed":true});
    assert!(
        call(
            &f.window,
            "authorize_mcp_share",
            f.request(json!({"authorization":authorization}))
        )
        .is_err()
    );
    let view = f.view(&prepared["preparation"]["identity"], &authorization);
    assert!(view["authorization"].is_null());
    assert_eq!(view["previewDigest"], prepared["preview"]["digest"]);
    f.revoke(&prepared["preparation"]["identity"]);
}

#[test]
fn mcp_share_real_stdio_bridge_exits_after_revoke_with_stdin_open() {
    let f = Fixture::new();
    let prepared = f.prepare();
    let authorized = f.authorize(&prepared, 300);
    let binary = std::env::var_os("TSUMUGI_TEST_MCP_BRIDGE")
        .expect("set the freshly built production desktop binary; never launch the GUI");
    let mut child = OwnedChild(
        Command::new(binary)
            .args(["--mcp-stdio", "--port", &port(&authorized).to_string()])
            .env("TSUMUGI_MCP_PAIRING", credential(&authorized))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.0.stdout.take().unwrap());
    let (lines, received) = std::sync::mpsc::sync_channel(4);
    let output_thread = std::thread::spawn(move || {
        loop {
            let mut line = String::new();
            match stdout.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if lines.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    writeln!(stdin, "{}", json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25",
        "capabilities":{},"clientInfo":{"name":"Synthetic bridge recipient","version":"1"}}})).unwrap();
    let line = received
        .recv_timeout(Duration::from_secs(5))
        .expect("production bridge did not return initialize");
    let initialized: Value =
        serde_json::from_str(&line).expect("production bridge stdout must contain only MCP");
    assert_eq!(initialized["id"], 1);
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .unwrap();
    writeln!(stdin, "{}", json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tsumugi_read_entry","arguments":{}}})).unwrap();
    let line = received
        .recv_timeout(Duration::from_secs(5))
        .expect("production bridge did not return tool output");
    let result: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        result["result"]["structuredContent"]["source"]["text"],
        "Copper 👩🏽‍💻"
    );
    let id = &authorized["view"]["identity"];
    let auth = &authorized["view"]["authorization"];
    f.revoke(id);
    f.drained(id, auth);
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < until,
            "bridge retained open stdin after revoke"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // Keep this pipe open until after the independent process has exited.
    drop(stdin);
    output_thread.join().unwrap();
}
