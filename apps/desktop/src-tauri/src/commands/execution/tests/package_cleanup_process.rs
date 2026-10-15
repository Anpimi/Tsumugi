//! Actual Node dispatch, scoped uninstall IPC and old-receipt confirmation.
//! Only transport, owned marker files and the post-process owner gate are fixtures.
#![cfg(target_os = "macos")]

use super::*;
use crate::commands::plugins::{
    PluginInventoryView, PluginObjectState, PluginPackageRequest, PluginUninstallRequest,
    packages::{MutationRequest, cleanup::uninstall_plugin_package},
};
use std::{
    fs,
    future::Future,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    task::{Context, Poll, Waker},
    time::{SystemTime, UNIX_EPOCH},
};
use tsumugi_plugin_host::{
    ApprovedPackageSetting, CapturedRuntime, HostLimits, InstallError, PackageFile, PackageImage,
    PackageStore, PluginSettingsUpdate, RuntimeApproval,
    catalog::{PackageApproval, PackageCatalog, PackageOrigin},
    core::RunnerProxy,
};

use tsumugi_plugin_sdk as sdk;

mod runtime_fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/plugin-host/tests/support/runtime.rs"
    ));
}

struct OwnedDirectory {
    directory: Option<tempfile::TempDir>,
    removable: Arc<AtomicBool>,
}
impl OwnedDirectory {
    fn new() -> Self {
        Self {
            directory: Some(tempfile::tempdir().unwrap()),
            removable: Arc::new(AtomicBool::new(true)),
        }
    }
    fn path(&self) -> &Path {
        self.directory.as_ref().unwrap().path()
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        fn removable(path: &Path) -> std::io::Result<()> {
            let metadata = fs::symlink_metadata(path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
                for entry in fs::read_dir(path)? {
                    removable(&entry?.path())?;
                }
            }
            Ok(())
        }
        let directory = self.directory.take().unwrap();
        let error = if self.removable.load(Ordering::Acquire) {
            removable(directory.path())
                .err()
                .map(|error| error.to_string())
        } else {
            Some("owned execution was not confirmed drained".into())
        };
        if let Some(error) = error {
            eprintln!(
                "owned process fixture retained at {}: {error}",
                directory.path().display()
            );
            // Keep the actual worker leases if teardown could not confirm their
            // release. This is a failed check, never a successful cleanup.
            std::mem::forget(directory);
            if !std::thread::panicking() {
                panic!("owned process fixture could not be removed: {error}");
            }
        }
    }
}

/// Keeps the original application owner alive through bounded teardown, even
/// when the journey unwinds. No PID is signalled except by its original proxy.
struct ApplicationCleanup {
    handle: Option<tauri::AppHandle<tauri::test::MockRuntime>>,
    removable: Arc<AtomicBool>,
    gates: Vec<mpsc::Sender<()>>,
    entered: Vec<PathBuf>,
    staging: PathBuf,
}
impl ApplicationCleanup {
    fn new(
        app: &tauri::App<tauri::test::MockRuntime>,
        owned: &OwnedDirectory,
        staging: &Path,
    ) -> Self {
        owned.removable.store(false, Ordering::Release);
        Self {
            handle: Some(app.handle().clone()),
            removable: owned.removable.clone(),
            gates: Vec::new(),
            entered: Vec::new(),
            staging: staging.to_path_buf(),
        }
    }
    fn gate(&mut self, release: &mpsc::Sender<()>) {
        self.gates.push(release.clone());
    }
    fn observe(&mut self, controls: &Controls) {
        self.entered.push(controls.entered.clone());
    }
    fn reclaim(&self) -> Result<(), String> {
        let handle = self.handle.as_ref().unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut core_drained = false;
        loop {
            let (sender, receiver) = mpsc::sync_channel(1);
            let response = handle
                .state::<AppState>()
                .sessions
                .lease(CommandStage::ExecutionCancel)
                .map_err(|error| format!("teardown admission: {:?}", error.code))?
                .submit(
                    "process_cleanup_test.teardown",
                    CommandStage::ExecutionCancel,
                    move |sessions| {
                        let result = (|| -> Result<(bool, bool), String> {
                            let continuation_idle = sessions
                                .package_operation
                                .as_ref()
                                .is_none_or(|operation| operation.running.strong_count() == 0);
                            let Some(active) = sessions.active.as_mut() else {
                                return Ok((true, continuation_idle));
                            };
                            let Some(host) = active.execution.as_mut() else {
                                return Ok((true, continuation_idle));
                            };
                            if !core_drained {
                                // This fixture-only shutdown uses the original Core
                                // owner inside its Session actor. It neither confirms
                                // a retained package receipt nor clears its Session
                                // package-operation hold.
                                match host.runtime.begin_quiesce(&mut active.store) {
                                    Ok(()) => {}
                                    Err(error) if error.code == ErrorCode::Busy => {}
                                    Err(error) => {
                                        return Err(format!(
                                            "teardown cancel: {:?} at {}",
                                            error.code, error.stage
                                        ));
                                    }
                                }
                                match host.runtime.finish_quiesce(&mut active.store) {
                                    Ok(()) => core_drained = true,
                                    Err(error) if error.code == ErrorCode::Busy => {}
                                    Err(error) => {
                                        return Err(format!(
                                            "teardown drain: {:?} at {}",
                                            error.code, error.stage
                                        ));
                                    }
                                }
                            }
                            Ok((core_drained, continuation_idle))
                        })();
                        let _ = sender.send(result);
                        Ok(())
                    },
                )
                .map_err(|error| format!("teardown dispatch: {:?}", error.code))?;
            let (drained, continuation_idle) = receiver
                .recv_timeout(Duration::from_secs(1))
                .map_err(|error| format!("teardown owner reply: {error}"))??;
            drop(response);
            core_drained = drained;
            if drained && continuation_idle {
                let mut exited = true;
                for path in &self.entered {
                    let bytes = match fs::read(path) {
                        Ok(bytes) => bytes,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(format!("owned PID marker: {error}")),
                    };
                    let value: Value = serde_json::from_slice(&bytes)
                        .map_err(|error| format!("owned PID marker: {error}"))?;
                    let pid = value["pid"]
                        .as_u64()
                        .and_then(|pid| u32::try_from(pid).ok())
                        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
                        .ok_or_else(|| "owned PID marker was invalid".to_string())?;
                    exited &= !child_alive(pid);
                }
                if exited
                    && fs::read_dir(&self.staging)
                        .map_err(|error| format!("owned staging inspection: {error}"))?
                        .next()
                        .is_none()
                {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err("owned children, leases or cleanup continuation did not drain within teardown limit".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for ApplicationCleanup {
    fn drop(&mut self) {
        // A disconnected receiver has already left its gate. Sending on these
        // unbounded channels cannot block the teardown thread.
        for release in self.gates.drain(..) {
            let _ = release.send(());
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.handle
                .as_ref()
                .unwrap()
                .state::<AppState>()
                .disconnect_change_events();
            self.reclaim()
        }))
        .unwrap_or_else(|_| {
            Err("owned teardown panicked before confirming resource release".into())
        });
        match outcome {
            Ok(()) => {
                self.handle
                    .as_ref()
                    .unwrap()
                    .state::<AppState>()
                    .plugins
                    .close();
                self.handle.take();
                self.removable.store(true, Ordering::Release);
            }
            Err(error) => {
                eprintln!("owned process teardown failed; retaining fixture directory: {error}");
                if !std::thread::panicking() {
                    panic!("owned process teardown failed: {error}");
                }
            }
        }
    }
}

#[derive(Clone)]
struct Controls {
    entered: PathBuf,
    release: PathBuf,
    finished: PathBuf,
    disposed: PathBuf,
}
impl Controls {
    fn new(root: &Path, label: &str) -> Self {
        Self {
            entered: root.join(format!("{label}-entered")),
            release: root.join(format!("{label}-release")),
            finished: root.join(format!("{label}-finished")),
            disposed: root.join(format!("{label}-disposed")),
        }
    }
    fn pid(&self, label: &str) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(value) = fs::read(&self.entered)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            {
                assert_eq!(value["tag"], label);
                let pid = u32::try_from(value["pid"].as_u64().unwrap()).unwrap();
                assert!(pid > 0 && pid <= i32::MAX as u32);
                return pid;
            }
            assert!(
                Instant::now() < deadline,
                "actual Node did not enter {label}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn release(&self) {
        fs::write(&self.release, b"release owned worker").unwrap();
    }
}

fn child_alive(pid: u32) -> bool {
    // Signal 0 only observes the exact PID recorded by this owned Node fixture.
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return true;
    }
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    false
}

fn image(label: &str, controls: &Controls) -> PackageImage {
    let contract = |id: &str| sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    };
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: format!("process-cleanup-{label}"),
            version: "0.1.0".into(),
        },
        permissions: vec![sdk::PermissionRequest::CapturedInput],
        components: vec![sdk::ComponentDeclaration {
            id: "worker".into(),
            scope: sdk::ComponentScope::Project,
            runtime: sdk::RuntimeKind::JavaScript,
            entrypoint: Some("worker.mjs".into()),
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 100,
                cleanup_timeout_ms: 500,
            },
        }],
        contributions: vec![sdk::ContributionDeclaration {
            id: "call".into(),
            component_id: "worker".into(),
            contribution: sdk::ContributionKind::Capability {
                declaration: sdk::CapabilityDeclaration {
                    contract: contract("example.cleanup"),
                    input_schema: contract("example.cleanup.input"),
                    output_schema: contract("example.cleanup.output"),
                    error_schema: contract("example.cleanup.error"),
                    profiles: vec![],
                    effect: sdk::EffectKind::ReadOnly,
                    permissions: vec![sdk::PermissionRequest::CapturedInput],
                    limits: sdk::CapabilityLimits {
                        max_input_bytes: 4096,
                        max_output_bytes: 4096,
                        concurrency: 1,
                        timeout_ms: 10_000,
                    },
                },
            },
        }],
    };
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([
        (
            "worker.mjs".into(),
            PackageFile {
                bytes: include_bytes!("package_cleanup_process.mjs").to_vec(),
                executable: false,
            },
        ),
        (
            "controls.json".into(),
            PackageFile {
                bytes: serde_json::to_vec(&json!({
                    "entered":controls.entered, "release":controls.release,
                    "finished":controls.finished, "disposed":controls.disposed,
                }))
                .unwrap(),
                executable: false,
            },
        ),
    ]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}

/// Delegates all execution and evidence to the real proxy. The optional gate
/// retains only its Rust owner after the proxy has closed/reaped its child.
struct ObservedRunner {
    proxy: Arc<RunnerProxy>,
    dispatched: mpsc::Sender<DispatchRequest>,
    finished: mpsc::Sender<Option<ErrorCode>>,
    owner_exit: Mutex<Option<mpsc::Receiver<()>>>,
}
impl Runner for ObservedRunner {
    fn capability_id(&self) -> &str {
        self.proxy.capability_id()
    }
    fn capability_version(&self) -> &str {
        self.proxy.capability_version()
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        self.proxy.plugin_provider()
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        self.proxy.plugin_environment()
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let _ = self.dispatched.send(request.clone());
        let result = self.proxy.run(request, cancellation, results);
        let _ = self
            .finished
            .send(result.as_ref().err().map(|error| error.code));
        if let Some(exit) = self.owner_exit.lock().unwrap().take() {
            match exit.recv_timeout(Duration::from_secs(30)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("controlled Rust owner was not released")
                }
            }
        }
        result
    }
}

struct Started {
    input: FixedInput,
    grant: ExecutionId,
    generation: ExecutionId,
    dispatched: mpsc::Receiver<DispatchRequest>,
    finished: mpsc::Receiver<Option<ErrorCode>>,
}
fn start(
    app: &tauri::App<tauri::test::MockRuntime>,
    image: PackageImage,
    runtime: CapturedRuntime,
    staging: PathBuf,
    label: &str,
    owner_exit: Option<mpsc::Receiver<()>>,
) -> Started {
    let proxy =
        Arc::new(RunnerProxy::new(image, "call", runtime, staging, HostLimits::default()).unwrap());
    let binding = proxy.execution_binding(None).unwrap();
    let (dispatched, observed) = mpsc::channel();
    let (finished, completed) = mpsc::channel();
    let runner = Arc::new(ObservedRunner {
        proxy,
        dispatched,
        finished,
        owner_exit: Mutex::new(owner_exit),
    });
    let label = label.to_owned();
    let (input, grant, generation) = app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.allow_package(&PluginPackageRequest {
            plugin: binding.capability.provider.plugin.clone(),
            package_digest: binding.capability.provider.package_digest.clone(),
        })
        .unwrap();
        host.runtime.register(runner).unwrap();
        host.plugin_registrations.push(binding.clone());
        let mut envelope = InputEnvelope::new(
            store.metadata().unwrap().project_id(),
            "fixture",
            &binding.capability.declaration.contract.id,
            &binding.capability_version(),
            vec![InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: label.clone(),
                    locale: None,
                },
                json!({"tag":label}),
                vec![],
            )],
        )
        .unwrap();
        envelope.plugin = Some(binding);
        let input = FixedInput::capture(envelope).unwrap();
        let grant = ExecutionId::new();
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        host.runtime
            .authorize_plugin(
                store,
                grant,
                &input,
                expires,
                PluginConsent {
                    unsandboxed_execution: true,
                },
            )
            .unwrap();
        host.runtime.submit(store, &input).unwrap();
        host.runtime.tick(store).unwrap();
        (input, grant, host.runtime.generation())
    });
    Started {
        input,
        grant,
        generation,
        dispatched: observed,
        finished: completed,
    }
}

type GrantRecord = (String, String, String, String, String, i64, i64, i64);
fn grant_record(project: &Path, grant: ExecutionId) -> GrantRecord {
    let database = rusqlite::Connection::open_with_flags(
        project.join("project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    database.query_row("SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked FROM plugin_execution_grants WHERE grant_id=?1",
        [grant.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
            row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?))).unwrap()
}

fn current_result(
    app: &tauri::App<tauri::test::MockRuntime>,
    started: &Started,
) -> Option<FixedResult> {
    let input = started.input.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.runtime.tick(store).unwrap();
        store
            .execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap()
            .map(|result| {
                store
                    .execution_result(input.envelope().attempt_id, result)
                    .unwrap()
            })
    })
}
fn completed(app: &tauri::App<tauri::test::MockRuntime>, started: &Started) -> FixedResult {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(result) = current_result(app, started) {
            assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
            return result;
        }
        assert!(
            Instant::now() < deadline,
            "actual Node result was not durably accepted"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn inventory(window: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> PluginInventoryView {
    serde_json::from_value(call(window, "read_plugin_inventory", json!({})).unwrap()).unwrap()
}
fn app(
    application: &Path,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.state::<AppState>()
        .plugins
        .configure(application.to_path_buf())
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    (app, window)
}
fn idle(
    app: &tauri::App<tauri::test::MockRuntime>,
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(window, "execution_status", context.clone()).unwrap()["active"] == true {
        assert!(
            Instant::now() < deadline,
            "actual worker owners did not join"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        app.state::<AppState>()
            .sessions
            .with(|sessions| sessions.package_operation.is_none())
    );
}

#[test]
#[ignore = "requires independently captured JavaScript runtime artifacts"]
fn actual_node_uninstall_keeps_independent_grant_and_old_receipt_preserves_reopened_instance() {
    let owned = OwnedDirectory::new();
    let root = owned.path();
    let application = root.join("application");
    let store_root = application.join("plugins");
    let project = root.join("project");
    let staging = root.join("workers");
    fs::create_dir(&staging).unwrap();
    let a_controls = Controls::new(root, "a");
    let b_controls = Controls::new(root, "b");
    let a_image = image("a", &a_controls);
    let b_image = image("b", &b_controls);
    let runtime = runtime_fixture::approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let approvals: Vec<_> = [&a_image, &b_image]
        .into_iter()
        .map(|image| PackageApproval {
            plugin: image.manifest().manifest().plugin.clone(),
            package_digest: image.package_digest().into(),
            origin: PackageOrigin {
                source_id: "manual-local".into(),
                publisher_id: "manual-approval".into(),
            },
        })
        .collect();
    let mut catalog = PackageCatalog::new();
    catalog.register(a_image, approvals[0].clone()).unwrap();
    catalog.register(b_image, approvals[1].clone()).unwrap();
    let mut store = PackageStore::provision(root, &["application", "plugins"], || true).unwrap();
    let receipts: Vec<_> = approvals
        .iter()
        .map(|approval| {
            store
                .install(
                    &ExecutionId::new().to_string(),
                    catalog.registered(&approval.plugin).unwrap(),
                    || true,
                )
                .unwrap()
        })
        .collect();
    store
        .install_runtime(
            &ExecutionId::new().to_string(),
            &runtime,
            &runtime_approval,
            || true,
        )
        .unwrap();
    store
        .update_settings(
            0,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: approvals
                    .iter()
                    .cloned()
                    .map(|approval| ApprovedPackageSetting {
                        approval,
                        enabled: true,
                    })
                    .collect(),
                runtimes: vec![runtime_approval.clone()],
            },
            || true,
        )
        .unwrap();
    // All large runtime capture/installation happens before the live process window.
    let installed_runtime = store.load_runtime(&runtime_approval, || true).unwrap();
    let installed_a = store.load(&approvals[0], || true).unwrap().image().clone();
    let installed_b = store.load(&approvals[1], || true).unwrap().image().clone();
    let (first_app, first_window) = app(&application);
    assert_eq!(
        first_app
            .state::<AppState>()
            .plugins
            .dispose_closed_store_for_test()
            .unwrap_err()
            .code,
        CommandErrorCode::Busy
    );
    let mut first_cleanup = ApplicationCleanup::new(&first_app, &owned, &staging);
    first_cleanup.observe(&a_controls);
    first_cleanup.observe(&b_controls);
    let view = call(
        &first_window,
        "create_project",
        json!({"destination":project,
        "displayName":"Actual process cleanup", "sourceLocale":"en-US", "targetLocales":["zh-CN"]}),
    )
    .unwrap();
    let context =
        json!({"sessionToken":view["sessionToken"],"projectId":view["metadata"]["projectId"]});
    let (release_owner, owner_exit) = mpsc::channel();
    first_cleanup.gate(&release_owner);
    let a = start(
        &first_app,
        installed_a,
        installed_runtime.runtime().clone(),
        staging.clone(),
        "a",
        Some(owner_exit),
    );
    let b = start(
        &first_app,
        installed_b,
        installed_runtime.runtime().clone(),
        staging.clone(),
        "b",
        None,
    );
    let a_dispatch = a.dispatched.recv_timeout(Duration::from_secs(5)).unwrap();
    let b_dispatch = b.dispatched.recv_timeout(Duration::from_secs(5)).unwrap();
    let a_pid = a_controls.pid("a");
    let b_pid = b_controls.pid("b");
    assert_ne!(a_pid, b_pid);
    assert!(child_alive(a_pid) && child_alive(b_pid));
    assert_eq!(a.generation, b.generation);
    assert_eq!(a_dispatch.plugin_permit().unwrap().grant_id(), a.grant);
    assert_eq!(b_dispatch.plugin_permit().unwrap().grant_id(), b.grant);
    let a_grant = grant_record(&project, a.grant);
    let b_grant = grant_record(&project, b.grant);
    assert_eq!(a_grant.7, 0);
    assert_eq!(b_grant.7, 0);
    // As in the original scoped-uninstall test, the trusted Store owner withdraws
    // only A after both original execution handles were captured.
    let withdrawn = store
        .update_settings(
            1,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: vec![ApprovedPackageSetting {
                    approval: approvals[1].clone(),
                    enabled: true,
                }],
                runtimes: vec![runtime_approval.clone()],
            },
            || true,
        )
        .unwrap();
    drop(store);
    let before = inventory(&first_window);
    let a_package = PluginPackageRequest {
        plugin: approvals[0].plugin.clone(),
        package_digest: approvals[0].package_digest.clone(),
    };
    let a_object = store_root.join("objects").join(&a_package.package_digest);
    let b_object = store_root
        .join("objects")
        .join(&approvals[1].package_digest);
    let b_receipt = fs::read(b_object.join("receipt.json")).unwrap();
    let b_worker = fs::read(b_object.join("package/worker.mjs")).unwrap();
    let request = PluginUninstallRequest {
        package: a_package.clone(),
        origin: receipts[0].origin().into(),
        original_install_action: receipts[0].action_id().into(),
        expected_revision: withdrawn.revision().into(),
        action_id: ExecutionId::new(),
    };
    // Queue admission behind an owned actor operation, then discard its waiter.
    // The production cleanup continuation must still stop A and retain its hold.
    let state = first_app.state::<AppState>();
    let (entered, entrance) = mpsc::channel();
    let (continue_actor, actor_release) = mpsc::channel();
    first_cleanup.gate(&continue_actor);
    let actor = state
        .sessions
        .lease(CommandStage::Read)
        .unwrap()
        .submit(
            "process_cleanup_test.block",
            CommandStage::Read,
            move |_| {
                entered.send(()).unwrap();
                actor_release.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            },
        )
        .unwrap();
    entrance.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut waiter = Box::pin(uninstall_plugin_package(first_app.state(), request.clone()));
    assert!(matches!(
        waiter
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(waiter);
    continue_actor.send(()).unwrap();
    drop(actor);
    assert_eq!(
        a.finished.recv_timeout(Duration::from_secs(5)).unwrap(),
        Some(ErrorCode::Cancelled)
    );
    assert!(!child_alive(a_pid));
    assert!(!a_controls.finished.exists());
    // The child is already reaped. Only the explicitly controlled Rust owner is
    // held here; it is not evidence of an uncooperative child still executing.
    let original = MutationRequest::Uninstall(request.clone());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let original = original.clone();
        if state.sessions.with(move |sessions| {
            let operation = sessions.package_operation.as_ref().unwrap();
            assert!(operation.request == original);
            operation.running.strong_count() == 0
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "lost-waiter continuation did not return its Busy result"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let held = call(&first_window, "uninstall_plugin_package", json!(&request)).unwrap_err();
    assert_eq!(held["code"], "busy");
    assert_eq!(held["reason"], "package-draining");
    assert_eq!(held["outcome"], "rejected");
    assert_eq!(held["recoveryGuidance"], "reconcile-original");
    assert_eq!(held["recoveryRequired"], true);
    assert!(a_object.exists());
    assert!(
        !store_root
            .join("uninstalls")
            .join(request.action_id.to_string())
            .exists()
    );
    assert!(!a_dispatch.plugin_permit().unwrap().is_authorized());
    assert!(b_dispatch.plugin_permit().unwrap().is_authorized());
    assert!(child_alive(b_pid));
    assert_eq!(grant_record(&project, b.grant), b_grant);
    assert_eq!(inventory(&first_window), before);
    assert_eq!(
        call(&first_window, "quiesce_execution", context.clone()).unwrap_err()["code"],
        "busy"
    );
    let mut changed = request.clone();
    changed.action_id = ExecutionId::new();
    assert_eq!(
        call(&first_window, "uninstall_plugin_package", json!(changed)).unwrap_err()["code"],
        "busy"
    );
    release_owner.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let removed: PluginInventoryView = loop {
        match call(&first_window, "uninstall_plugin_package", json!(&request)) {
            Ok(view) => break serde_json::from_value(view).unwrap(),
            Err(error) if error["code"] == "busy" => {
                assert!(Instant::now() < deadline, "real target owner did not join");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("original uninstall failed: {error}"),
        }
    };
    assert!(!a_object.exists());
    assert!(child_alive(b_pid));
    assert!(!b_controls.release.exists() && !b_controls.finished.exists());
    assert_eq!(removed.settings_revision, before.settings_revision);
    assert_eq!(removed.last_settings_action, before.last_settings_action);
    assert_eq!(removed.package_decisions, before.package_decisions);
    assert_eq!(removed.runtime_decisions, before.runtime_decisions);
    assert_eq!(removed.runtimes, before.runtimes);
    assert_eq!(removed.packages.len(), 1);
    assert_eq!(
        removed.packages[0],
        *before
            .packages
            .iter()
            .find(|package| package.package_digest == approvals[1].package_digest)
            .unwrap()
    );
    assert_eq!(removed.uninstallations.len(), 1);
    let journal = &removed.uninstallations[0];
    assert_eq!(journal.action_id, request.action_id.to_string());
    assert_eq!(journal.settings_revision, request.expected_revision);
    assert_eq!(
        journal.installation.original_install_action,
        request.original_install_action
    );
    assert_eq!(journal.installation.plugin, request.package.plugin);
    assert_eq!(
        journal.installation.package_digest,
        request.package.package_digest
    );
    assert_eq!(journal.installation.origin, request.origin);
    assert_eq!(journal.state, PluginObjectState::Sealed);
    assert_eq!(fs::read(b_object.join("receipt.json")).unwrap(), b_receipt);
    assert_eq!(
        fs::read(b_object.join("package/worker.mjs")).unwrap(),
        b_worker
    );
    assert!(current_result(&first_app, &a).is_none());
    let mut revoked_a = a_grant.clone();
    revoked_a.7 = 1;
    assert_eq!(grant_record(&project, a.grant), revoked_a);
    assert_eq!(grant_record(&project, b.grant), b_grant);
    state.sessions.with(move |sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert_eq!(host.runtime.generation(), a.generation);
        assert!(
            host.allow_package(&PluginPackageRequest {
                plugin: approvals[1].plugin.clone(),
                package_digest: approvals[1].package_digest.clone()
            })
            .is_ok()
        );
    });
    // B is released only after A's exact uninstall ACK, without another grant.
    b_controls.release();
    let b_result = completed(&first_app, &b);
    assert_eq!(
        b_result
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .authorization_id,
        b.grant
    );
    assert_eq!(
        b_result
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .result
            .provider
            .plugin,
        b_dispatch
            .input
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .capability
            .provider
            .plugin
    );
    assert_eq!(
        b.finished.recv_timeout(Duration::from_secs(5)).unwrap(),
        None
    );
    assert!(!child_alive(b_pid));
    assert_eq!(grant_record(&project, b.grant), b_grant);
    let b_saved = b_result.bytes().to_vec();
    idle(&first_app, &first_window, &context);
    call(
        &first_window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    state.sessions.with(|sessions| {
        assert!(sessions.active.is_none());
        assert!(sessions.package_operation.is_none());
    });
    assert!(!child_alive(a_pid) && !child_alive(b_pid));
    assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    state.plugins.close();
    // Only the closed owner's test bridge compensates for MockRuntime's
    // missing destruction event. The next App still captures fresh authority.
    state.plugins.dispose_closed_store_for_test().unwrap();
    state.disconnect_change_events();
    drop(state);
    drop(first_cleanup);
    drop(first_window);
    drop(first_app);

    // Reopen the same Store only after its first application owner releases the
    // OS lock. This is a new application/runtime generation, not a grant refresh.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut reopened = loop {
        match PackageStore::open_existing(&store_root) {
            Ok(store) => break store,
            Err(InstallError::Busy) => {
                assert!(
                    Instant::now() < deadline,
                    "original application retained Store ownership"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("cannot reopen owned Store: {error:?}"),
        }
    };
    let new_install_action = ExecutionId::new();
    let new_receipt = reopened
        .install(
            &new_install_action.to_string(),
            catalog.registered(&request.package.plugin).unwrap(),
            || true,
        )
        .unwrap();
    assert_ne!(new_receipt.action_id(), request.original_install_action);
    let settings = reopened.settings(|| true).unwrap();
    let mut desired = PluginSettingsUpdate {
        packages: settings.packages().to_vec(),
        runtimes: settings.runtimes().to_vec(),
    };
    desired.packages.push(ApprovedPackageSetting {
        approval: PackageApproval {
            plugin: new_receipt.plugin().clone(),
            package_digest: new_receipt.package_digest().into(),
            origin: new_receipt.origin().clone(),
        },
        enabled: true,
    });
    reopened
        .update_settings(
            settings.revision(),
            &ExecutionId::new().to_string(),
            &desired,
            || true,
        )
        .unwrap();
    let new_image = reopened
        .load(&desired.packages.last().unwrap().approval, || true)
        .unwrap()
        .image()
        .clone();
    let new_runtime = reopened.load_runtime(&runtime_approval, || true).unwrap();
    drop(reopened);
    fs::remove_file(&a_controls.entered).unwrap();
    let (second_app, second_window) = app(&application);
    let mut second_cleanup = ApplicationCleanup::new(&second_app, &owned, &staging);
    second_cleanup.observe(&a_controls);
    let view = call(&second_window, "open_project", json!({"locator":project})).unwrap();
    let new_context =
        json!({"sessionToken":view["sessionToken"],"projectId":view["metadata"]["projectId"]});
    let new_before = inventory(&second_window);
    let new_receipt_bytes = fs::read(a_object.join("receipt.json")).unwrap();
    let new_worker_bytes = fs::read(a_object.join("package/worker.mjs")).unwrap();
    let new_settings_bytes = fs::read(store_root.join("settings.json")).unwrap();
    let new_a = start(
        &second_app,
        new_image,
        new_runtime.runtime().clone(),
        staging.clone(),
        "new-a",
        None,
    );
    let new_dispatch = new_a
        .dispatched
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let new_pid = a_controls.pid("new-a");
    assert_ne!(new_a.generation, b.generation);
    assert_ne!(new_a.grant, a.grant);
    assert_ne!(new_pid, a_pid);
    assert!(child_alive(new_pid));
    let new_grant = grant_record(&project, new_a.grant);
    let replayed: PluginInventoryView = serde_json::from_value(
        call(&second_window, "uninstall_plugin_package", json!(&request)).unwrap(),
    )
    .unwrap();
    assert_eq!(replayed, new_before);
    assert!(child_alive(new_pid));
    assert!(new_dispatch.plugin_permit().unwrap().is_authorized());
    assert_eq!(grant_record(&project, new_a.grant), new_grant);
    assert_eq!(
        fs::read(a_object.join("receipt.json")).unwrap(),
        new_receipt_bytes
    );
    assert_eq!(
        fs::read(a_object.join("package/worker.mjs")).unwrap(),
        new_worker_bytes
    );
    assert_eq!(
        fs::read(store_root.join("settings.json")).unwrap(),
        new_settings_bytes
    );
    let old_attempt = b.input.envelope().attempt_id;
    let old_result = b_result.envelope().result_id;
    let new_generation = new_a.generation;
    second_app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            assert!(sessions.package_operation.is_none());
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert_eq!(host.runtime.generation(), new_generation);
            assert_eq!(
                store
                    .execution_result(old_attempt, old_result)
                    .unwrap()
                    .bytes(),
                b_saved
            );
        });
    a_controls.release();
    let new_result = completed(&second_app, &new_a);
    assert_eq!(
        new_result
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .authorization_id,
        new_a.grant
    );
    assert_eq!(
        new_a.finished.recv_timeout(Duration::from_secs(5)).unwrap(),
        None
    );
    assert!(!child_alive(new_pid));
    idle(&second_app, &second_window, &new_context);
    assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    call(
        &second_window,
        "close_project",
        json!({"sessionToken":new_context["sessionToken"]}),
    )
    .unwrap();
    let state = second_app.state::<AppState>();
    state.sessions.with(|sessions| {
        assert!(sessions.active.is_none());
        assert!(sessions.package_operation.is_none());
    });
    assert!(!child_alive(new_pid));
    assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    state.plugins.close();
    state.plugins.dispose_closed_store_for_test().unwrap();
    state.disconnect_change_events();
    drop(state);
    drop(second_cleanup);
}

#[test]
#[ignore = "requires independently captured JavaScript runtime artifacts"]
fn actual_node_teardown_reaps_active_worker_before_removing_owned_directory() {
    let owned = OwnedDirectory::new();
    let staging = owned.path().join("workers");
    fs::create_dir(&staging).unwrap();
    let controls = Controls::new(owned.path(), "teardown");
    let (app, window) = app(&owned.path().join("application"));
    let mut cleanup = ApplicationCleanup::new(&app, &owned, &staging);
    cleanup.observe(&controls);
    let project = owned.path().join("project");
    let view = call(&window, "create_project", json!({"destination":project,
        "displayName":"Actual process teardown", "sourceLocale":"en-US", "targetLocales":["zh-CN"]})).unwrap();
    let (release_owner, owner_exit) = mpsc::channel();
    cleanup.gate(&release_owner);
    let worker = start(
        &app,
        image("teardown", &controls),
        runtime_fixture::approved_runtime(),
        staging.clone(),
        "teardown",
        Some(owner_exit),
    );
    let original_dispatch = worker
        .dispatched
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert_eq!(
        original_dispatch.plugin_permit().unwrap().grant_id(),
        worker.grant
    );
    assert!(original_dispatch.plugin_permit().unwrap().is_authorized());
    let original_grant = grant_record(&project, worker.grant);
    let pid = controls.pid("teardown");
    assert!(child_alive(pid));
    assert!(!controls.release.exists() && !controls.finished.exists());
    // Exercise the same Drop used while unwinding, without creating an expected
    // panic that could conceal a real failure to reclaim this active child.
    drop(cleanup);
    assert_eq!(
        worker
            .finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap(),
        Some(ErrorCode::Cancelled)
    );
    assert!(!child_alive(pid));
    assert!(!controls.finished.exists());
    assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    // Global shutdown revokes the original Epoch and rotates its generation;
    // it does not rewrite each durable per-grant revocation flag.
    assert!(!original_dispatch.plugin_permit().unwrap().is_authorized());
    assert_eq!(grant_record(&project, worker.grant), original_grant);
    let original_generation = worker.generation;
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert_ne!(host.runtime.generation(), original_generation);
    });
    call(
        &window,
        "close_project",
        json!({"sessionToken":view["sessionToken"]}),
    )
    .unwrap();
    let state = app.state::<AppState>();
    state.sessions.with(|sessions| {
        assert!(sessions.active.is_none());
        assert!(sessions.package_operation.is_none());
    });
    assert!(!child_alive(pid));
    assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
    state.plugins.dispose_closed_store_for_test().unwrap();
    drop(state);
    assert!(owned.removable.load(Ordering::Acquire));
    let path = owned.path().to_path_buf();
    drop(window);
    drop(app);
    drop(owned);
    assert!(!path.exists());
}
