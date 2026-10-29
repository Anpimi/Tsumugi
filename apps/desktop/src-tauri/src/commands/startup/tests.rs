use super::*;
use serde_json::{Value, json};

#[test]
fn startup_wire_does_not_accept_paths_or_self_reported_authority() {
    for key in ["path", "paths", "directory", "window", "epoch", "sessionToken", "approved"] {
        let mut value = json!({}); value[key] = json!("/untrusted/path");
        assert!(serde_json::from_value::<StartupSelectRequest>(value).is_err());
        let mut value = json!({"dropTicket": ExecutionId::new()}); value[key] = json!("/untrusted/path");
        assert!(serde_json::from_value::<StartupDropRequest>(value).is_err());
    }
    let scope = Scope { window: "main".into(), epoch: ExecutionId::new() };
    let mut ticket = None;
    let (id, label) = native_directory::Drop::register(&mut ticket, scope.clone(), vec!["/private/native/materials".into()], Instant::now()).unwrap();
    let event = serde_json::to_value(StartupDropEvent::Ready { drop_ticket: id, folder_name: label }).unwrap();
    assert!(!event.to_string().contains("/private/native")); assert!(event.get("path").is_none());
    let changed = Scope { epoch: ExecutionId::new(), ..scope.clone() };
    assert!(native_directory::Drop::consume(&mut ticket, id, &changed, Instant::now()).is_err());
    assert!(native_directory::Drop::consume(&mut ticket, id, &Scope { window: "other".into(), ..scope.clone() }, Instant::now()).is_err());
    assert!(native_directory::Drop::consume(&mut ticket, id, &scope, Instant::now()).is_ok());
    assert!(native_directory::Drop::consume(&mut ticket, id, &scope, Instant::now()).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn cancelled_picker_retains_the_chosen_directory_but_lifecycle_and_window_changes_fence_late_results() {
    let root = tempfile::tempdir().unwrap();
    let selection = Arc::new(Selection::authorize(root.path().into()).unwrap());
    let mut owner = StartupSession::default();
    let picker = owner.begin("main".into());
    let first = owner.finish("main", picker, Some(selection.clone())).unwrap().unwrap();
    let picker = owner.begin("main".into());
    assert!(owner.finish("main", picker, None).unwrap().is_none());
    assert_eq!(owner.chosen("main", first.selection_id).unwrap().id, first.selection_id);
    let picker = owner.begin("main".into()); owner.retire();
    assert!(owner.finish("main", picker, Some(selection.clone())).is_err());
    let picker = owner.begin("main".into()); owner.clear_window("main");
    assert!(owner.finish("main", picker, Some(selection.clone())).is_err());
    let picker = owner.begin("main".into()); owner.finish("main", picker, Some(selection.clone())).unwrap();
    let project: ProjectView = serde_json::from_value(json!({"sessionToken":"created", "locator":"/synthetic/project", "reconciliationState":"settled",
        "metadata":{"projectId":ExecutionId::new(),"displayName":"Created","sourceLocale":"en","targetLocales":["fr"],"metadataRevision":"1"}})).unwrap();
    let picker = owner.begin("main".into()); owner.created(&project);
    assert!(owner.finish("main", picker, Some(selection)).is_err()); assert!(owner.handoff.is_some());
    owner.retire(); assert!(owner.handoff.is_none());
}

#[cfg(target_os = "macos")]
fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value, Value> {
    use tauri::{ipc::{CallbackFn, InvokeBody}, webview::InvokeRequest};
    tauri::test::get_ipc_response(window, InvokeRequest { cmd: command.into(), callback: CallbackFn(0), error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(), body: InvokeBody::Json(json!({"request":request})),
        headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into() })
        .map(|response| response.deserialize::<Value>().unwrap())
}

#[cfg(target_os = "macos")]
fn install_metadata_runtime(fixture: &plugins::InstalledPluginFixture) -> (PluginSourceRequest, tsumugi_plugin_host::RuntimeApproval) {
    use std::os::unix::fs::PermissionsExt;
    use tsumugi_plugin_host::{CapturedRuntime, RuntimeApproval};
    use tsumugi_plugin_sdk as sdk;
    let root = tempfile::tempdir().unwrap();
    let tool = PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").expect("source-pinned tool tree required by IPC conformance"));
    let host = BTreeMap::from([("dist/main.js".to_string(), sdk::RuntimeArtifactFile { bytes: b"throw new Error('preflight must not execute');".to_vec(), executable: false })]);
    for (relative, file) in &host {
        let path = root.path().join("host").join(relative); fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &file.bytes).unwrap(); fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let pin = crate::runtime_bundle::node_pin().unwrap();
    let descriptor = sdk::RuntimeEnvironmentDescriptor {
        protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
        platform: sdk::RuntimePlatform { operating_system: sdk::RuntimeOperatingSystem::Macos,
            architecture: if cfg!(target_arch = "aarch64") { sdk::RuntimeArchitecture::Aarch64 } else { sdk::RuntimeArchitecture::X86_64 } },
        sdk_version: "0.1.0-alpha.1".into(), process_protocol: sdk::PROCESS_PROTOCOL,
        profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1, tool_version: pin.version,
        tool: sdk::RuntimeArtifactBinding { tree_digest: pin.tool_tree_digest, entrypoint: "bin/node".into() },
        host: sdk::RuntimeArtifactBinding { tree_digest: sdk::runtime_artifact_digest(&host).unwrap(), entrypoint: "dist/main.js".into() },
    };
    let runtime = CapturedRuntime::capture_directories(&tool, &root.path().join("host"), &descriptor, || true).unwrap();
    let approval = RuntimeApproval { environment: descriptor.into(), origin: crate::runtime_bundle::bundled_origin() };
    fixture.install_runtime(&runtime, &approval); fixture.decide(true, vec![approval.clone()]);
    let mut request = fixture.request(); request.environment_digest = approval.environment.digest().unwrap(); (request, approval)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64", feature = "execution-test-host"))]
#[test]
fn registered_startup_preflight_reads_declared_materials_without_project_or_execution_and_hands_off_only_after_creation() {
    let app = crate::commands::register_commands(tauri::test::mock_builder()).invoke_handler(execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let state = app.state::<AppState>();
    let fixture = plugins::InstalledPluginFixture::with_owner(state.plugins.clone(), |_, _| {}); fixture.install();
    let (source, approval) = install_metadata_runtime(&fixture);
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let root = tempfile::tempdir().unwrap(); fs::create_dir(root.path().join("materials")).unwrap(); fs::create_dir(root.path().join("metadata")).unwrap();
    fs::write(root.path().join("materials/raw.txt"), "original 👩🏽‍💻\r\n").unwrap();
    fs::write(root.path().join("unrelated.txt"), "not declared").unwrap();
    let path = root.path().to_path_buf();
    let ticket = state.sessions.with(move |sessions| {
        let scope = Scope { window: "main".into(), epoch: sessions.startup.epoch };
        native_directory::Drop::register(&mut sessions.startup.drop, scope, vec![path], Instant::now()).unwrap().0
    });
    let selected = call(&window, "select_dropped_startup_source_directory", json!({"dropTicket":ticket})).unwrap();
    assert!(call(&window, "select_dropped_startup_source_directory", json!({"dropTicket":ticket})).is_err());
    assert!(!selected.to_string().contains(&root.path().to_string_lossy().to_string()));
    let settings = fs::read(fixture.root().join("settings.json")).unwrap();
    let read = json!({"selectionId":selected["selectionId"],"source":source});
    let incomplete = call(&window, "read_startup_source_preflight", read.clone()).unwrap();
    assert_eq!(incomplete["complete"], false); assert_eq!(incomplete["materials"][1]["byteLength"], Value::Null);
    fs::write(root.path().join("metadata/header.txt"), "companion").unwrap();
    let ready = call(&window, "read_startup_source_preflight", read.clone()).unwrap();
    assert_eq!(ready["complete"], true); assert_eq!(ready["materials"].as_array().unwrap().len(), 2);
    assert!(state.sessions.with(|sessions| sessions.active.is_none()));
    assert_eq!(fs::read(fixture.root().join("settings.json")).unwrap(), settings);
    let destination = root.path().join("new-project");
    let created = call(&window, "create_project", json!({"destination":destination,"displayName":"Prepared project","sourceLocale":"en-US","targetLocales":["fr"]})).unwrap();
    assert!(state.sessions.with(|sessions| sessions.active.as_ref().unwrap().execution.is_none()));
    assert!(call(&window, "read_startup_source_preflight", read).is_err());
    let claim = json!({"selectionId":selected["selectionId"],"source":source,"projectId":created["metadata"]["projectId"],"sessionToken":created["sessionToken"]});
    let mut forged = claim.clone(); forged["sessionToken"] = json!("another-session");
    assert!(call(&window, "claim_startup_source_directory", forged).is_err());
    fixture.decide(false, vec![approval.clone()]);
    assert!(call(&window, "claim_startup_source_directory", claim.clone()).is_err());
    assert!(state.sessions.with(|sessions| sessions.active.as_ref().unwrap().execution.is_none()));
    fixture.decide(true, vec![approval]);
    let accepted = call(&window, "claim_startup_source_directory", claim.clone()).unwrap();
    assert_eq!(accepted["selectionId"], selected["selectionId"]);
    assert_eq!(call(&window, "claim_startup_source_directory", claim.clone()).unwrap(), accepted);
    assert!(state.sessions.with(|sessions| sessions.active.as_ref().unwrap().store.content_scope().unwrap().current_snapshot.is_none()));
    fs::write(root.path().join("materials/raw.txt"), "changed after preparation").unwrap();
    assert!(call(&window, "claim_startup_source_directory", claim.clone()).is_err());
    call(&window, "close_project", json!({"sessionToken":created["sessionToken"]})).unwrap();
    assert!(state.sessions.with(|sessions| sessions.startup.handoff.is_none()));
    assert!(call(&window, "claim_startup_source_directory", claim).is_err());
}
