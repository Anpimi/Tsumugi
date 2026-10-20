#![cfg(any(target_os = "macos", target_os = "linux"))]

use super::*;
use crate::commands::CreateProjectRequest;
use serde_json::{Value, json};
use std::{
    fs,
    future::Future,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::mpsc,
    task::{Context, Poll, Waker},
    time::{Duration, Instant},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

struct Fixture {
    directory: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    source: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("candidate");
        fs::create_dir(&source).unwrap();
        let candidate: PluginCandidateView = serde_json::from_str(include_str!(
            "../../../../../../test/fixtures/pluginPackage.contract.json"
        ))
        .unwrap();
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&candidate.manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            source.join("worker.mjs"),
            b"throw new Error('installation must not execute');",
        )
        .unwrap();
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        // Mock setup owns only this synthetic application directory.
        app.state::<AppState>()
            .plugins
            .configure(directory.path().join("application"))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        Self {
            directory,
            app,
            window,
            source,
        }
    }

    fn root(&self) -> PathBuf {
        self.directory.path().join("application/plugins")
    }

    fn call(&self, command: &str, request: Value) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            &self.window,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: crate::ipc_test_url().parse().unwrap(),
                body: InvokeBody::Json(json!({"request": request})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|response| response.deserialize::<Value>().unwrap())
    }

    fn inventory(&self) -> PluginInventoryView {
        serde_json::from_value(self.call("read_plugin_inventory", json!({})).unwrap()).unwrap()
    }

    fn install(&self, expected_revision: UnsignedDecimal) -> PluginInventoryView {
        let plugins = self.app.state::<AppState>().plugins.clone();
        let picker = plugins.begin_picker().unwrap();
        let candidate = plugins
            .finish_picker(picker.id, Some(self.source.clone()))
            .unwrap()
            .unwrap();
        serde_json::from_value(
            self.call(
                "install_plugin_package",
                json!(PluginInstallRequest {
                    ticket: candidate.ticket,
                    expected_revision,
                    action_id: ExecutionId::new(),
                }),
            )
            .unwrap(),
        )
        .unwrap()
    }

    fn removal(view: &PluginInventoryView) -> PluginApprovalRemovalRequest {
        let package = &view.packages[0];
        PluginApprovalRemovalRequest {
            package: PluginPackageRequest {
                plugin: package.plugin.clone(),
                package_digest: package.package_digest.clone(),
            },
            origin: package.origin.clone(),
            expected_revision: view.settings_revision,
            action_id: ExecutionId::new(),
        }
    }

    fn withdraw(&self, request: &PluginApprovalRemovalRequest) -> PluginInventoryView {
        serde_json::from_value(self.call("remove_plugin_approval", json!(request)).unwrap())
            .unwrap()
    }

    fn uninstall(view: &PluginInventoryView) -> PluginUninstallRequest {
        let package = &view.packages[0];
        PluginUninstallRequest {
            package: PluginPackageRequest {
                plugin: package.plugin.clone(),
                package_digest: package.package_digest.clone(),
            },
            origin: package.origin.clone(),
            original_install_action: package.original_install_action.clone(),
            expected_revision: view.settings_revision,
            action_id: ExecutionId::new(),
        }
    }

    fn object(&self, package: &PluginPackageRequest) -> PathBuf {
        self.root().join("objects").join(&package.package_digest)
    }

    fn assert_hold(&self, request: &MutationRequest) {
        let original = request.clone();
        self.app.state::<AppState>().sessions.with(move |sessions| {
            assert!(
                sessions
                    .package_operation
                    .as_ref()
                    .is_some_and(|operation| operation.request == original)
            );
        });
    }

    fn assert_idle(&self) {
        self.app.state::<AppState>().sessions.with(|sessions| {
            assert!(sessions.package_operation.is_none());
        });
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fn removable(path: &Path) {
            if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                for entry in fs::read_dir(path).unwrap() {
                    removable(&entry.unwrap().path());
                }
            }
        }
        removable(self.directory.path());
    }
}

#[test]
fn registered_uninstall_requires_separate_approval_action_and_old_receipt_preserves_reinstall() {
    let fixture = Fixture::new();
    let installed = fixture.install(0.into());
    assert_eq!(installed.settings_revision.get(), 1);
    assert!(!installed.package_decisions[0].enabled);
    let approved = Fixture::uninstall(&installed);
    let object = fixture.object(&approved.package);
    let original_archive = fs::read(object.join("package.tar")).unwrap();
    let rejected = fixture
        .call("uninstall_plugin_package", json!(&approved))
        .unwrap_err();
    assert_eq!(rejected["code"], "busy");
    assert_eq!(rejected["recoveryRequired"], false);
    assert_eq!(fixture.inventory(), installed);
    assert_eq!(
        fs::read(object.join("package.tar")).unwrap(),
        original_archive
    );
    fixture.assert_idle();

    let withdrawal = Fixture::removal(&installed);
    let withdrawn = fixture.withdraw(&withdrawal);
    assert_eq!(withdrawn.settings_revision.get(), 2);
    assert_eq!(
        withdrawn.last_settings_action,
        Some(withdrawal.action_id.to_string())
    );
    assert!(withdrawn.package_decisions.is_empty());
    assert_eq!(withdrawn.packages, installed.packages);
    assert!(withdrawn.uninstallations.is_empty());
    assert_eq!(
        fs::read(object.join("package.tar")).unwrap(),
        original_archive
    );

    let removal = Fixture::uninstall(&withdrawn);
    assert_ne!(removal.action_id, withdrawal.action_id);
    let removed: PluginInventoryView = serde_json::from_value(
        fixture
            .call("uninstall_plugin_package", json!(&removal))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(removed.settings_revision, withdrawn.settings_revision);
    assert_eq!(removed.last_settings_action, withdrawn.last_settings_action);
    assert!(removed.packages.is_empty());
    assert_eq!(removed.uninstallations.len(), 1);
    assert_eq!(
        removed.uninstallations[0].action_id,
        removal.action_id.to_string()
    );
    assert_eq!(
        removed.uninstallations[0].settings_revision,
        removal.expected_revision
    );
    assert_eq!(
        removed.uninstallations[0].installation,
        installed.packages[0]
    );
    assert_eq!(removed.uninstallations[0].state, PluginObjectState::Sealed);
    assert!(!object.exists());
    fixture.assert_idle();

    let reinstalled = fixture.install(removed.settings_revision);
    assert_ne!(
        reinstalled.packages[0].original_install_action,
        removal.original_install_action
    );
    assert_eq!(
        fs::read(object.join("package.tar")).unwrap(),
        original_archive
    );
    fixture
        .call(
            "create_project",
            json!({
                "destination": fixture.directory.path().join("project"),
                "displayName": "Uninstall receipt test",
                "sourceLocale": "en-US",
                "targetLocales": ["zh-CN"],
            }),
        )
        .unwrap();
    // The old action has no control in this newly opened project. A fresh stop
    // would initialize its ExecutionHost, even without dispatching a worker.
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.as_ref().unwrap().execution.is_none());
    });
    let retired_archive = fixture
        .root()
        .join("uninstalls")
        .join(removal.action_id.to_string())
        .join("object/package.tar");
    let mut changed_archive = original_archive.clone();
    let worker_bytes = fs::read(fixture.source.join("worker.mjs")).unwrap();
    let body_offsets: Vec<_> = changed_archive
        .windows(worker_bytes.len())
        .enumerate()
        .filter_map(|(offset, bytes)| (bytes == worker_bytes.as_slice()).then_some(offset))
        .collect();
    assert_eq!(body_offsets.len(), 1);
    // Change only the uniquely identified fixture body; headers, padding and
    // archive termination remain valid for metadata-only observation.
    changed_archive[body_offsets[0]] ^= 1;
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&retired_archive, &changed_archive).unwrap();
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o400)).unwrap();
    // Ordinary inventory still observes a sealed wrapper. The selected original
    // action must verify its retained bytes before reporting confirmed success.
    assert_eq!(fixture.inventory(), reinstalled);
    let unconfirmed = fixture
        .call("uninstall_plugin_package", json!(&removal))
        .unwrap_err();
    assert_eq!(unconfirmed["outcome"], "rejected");
    assert_eq!(unconfirmed["recoveryRequired"], true);
    assert_eq!(unconfirmed["recoveryGuidance"], "reconcile-original");
    fixture.assert_hold(&MutationRequest::Uninstall(removal.clone()));
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.as_ref().unwrap().execution.is_none());
    });
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&retired_archive, &original_archive).unwrap();
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o400)).unwrap();
    let replayed: PluginInventoryView = serde_json::from_value(
        fixture
            .call("uninstall_plugin_package", json!(&removal))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(replayed, reinstalled);
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.as_ref().unwrap().execution.is_none());
        assert!(sessions.package_operation.is_none());
    });
    assert_eq!(
        fs::read(object.join("package.tar")).unwrap(),
        original_archive
    );
    // A fully handed-off old intent can be replaced after rejected byte
    // verification. Its mere retained metadata is not a live cleanup fence.
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&retired_archive, &changed_archive).unwrap();
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o400)).unwrap();
    let rejected = fixture
        .call("uninstall_plugin_package", json!(&removal))
        .unwrap_err();
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["recoveryRequired"], false);
    fixture.assert_idle();
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&retired_archive, &original_archive).unwrap();
    fs::set_permissions(&retired_archive, fs::Permissions::from_mode(0o400)).unwrap();
}

#[test]
fn registered_uninstall_recovers_original_store_intent_and_rejects_substituted_hold_identity() {
    let fixture = Fixture::new();
    let installed = fixture.install(0.into());
    let withdrawn = fixture.withdraw(&Fixture::removal(&installed));
    let request = Fixture::uninstall(&withdrawn);
    let intent = MutationRequest::Uninstall(request.clone());
    let original = intent.clone();
    let operation_claim = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (new_hold, claim) = sessions.begin_package_operation(original).unwrap();
            assert!(new_hold);
            claim
        });
    let plugins = fixture.app.state::<AppState>().plugins.clone();
    let claim = plugins.begin_cleanup(&intent).unwrap();
    assert!(!claim.durable_complete);
    let object = fixture.object(&request.package);
    let journal = fixture
        .root()
        .join("uninstalls")
        .join(request.action_id.to_string());
    {
        let mut manager = plugins.manager.lock().unwrap();
        let store = manager.store.as_mut().unwrap();
        // Revoke this accepted Store owner's lifetime immediately after its
        // original intent is promoted. This exercises the public Store guard,
        // not the dependency crate's private test-only fault injection.
        assert_eq!(
            store
                .uninstall(
                    request.expected_revision.get(),
                    &request.action_id.to_string(),
                    &intent.cleanup_approval().unwrap(),
                    || !journal.exists(),
                )
                .unwrap_err(),
            InstallError::UnknownCommit,
        );
        let records = store.uninstallations(|| true).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].state, InstalledObjectState::RecoveryRequired);
        assert!(removal_matches(&request, &records[0].receipt));
    }
    assert!(object.exists());
    assert_eq!(
        fixture
            .call("uninstall_plugin_package", json!(&request))
            .unwrap_err()["code"],
        "busy",
    );
    assert!(claim.running.load(Ordering::Acquire));
    fixture.assert_hold(&intent);
    drop(claim);
    drop(operation_claim);

    let mut changed_origin = request.clone();
    changed_origin.origin.publisher_id = "another-approved-source".into();
    let mut changed_install = request.clone();
    changed_install.original_install_action = ExecutionId::new().to_string();
    let mut changed_revision = request.clone();
    changed_revision.expected_revision = (request.expected_revision.get() + 1).into();
    for changed in [changed_origin, changed_install, changed_revision] {
        assert!(
            fixture
                .call("uninstall_plugin_package", json!(changed))
                .is_err()
        );
        fixture.assert_hold(&intent);
        let manager = plugins.manager.lock().unwrap();
        assert!(manager.pending.as_ref().unwrap().request == intent);
        assert_eq!(
            manager
                .store
                .as_ref()
                .unwrap()
                .uninstallations(|| true)
                .unwrap()[0]
                .state,
            InstalledObjectState::RecoveryRequired
        );
        assert!(object.exists());
    }
    let recovered: PluginInventoryView = serde_json::from_value(
        fixture
            .call("uninstall_plugin_package", json!(&request))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(recovered.settings_revision, withdrawn.settings_revision);
    assert_eq!(
        recovered.last_settings_action,
        withdrawn.last_settings_action
    );
    assert!(recovered.packages.is_empty());
    assert_eq!(recovered.uninstallations.len(), 1);
    assert_eq!(
        recovered.uninstallations[0].action_id,
        request.action_id.to_string()
    );
    assert_eq!(
        recovered.uninstallations[0]
            .installation
            .original_install_action,
        request.original_install_action
    );
    assert_eq!(
        recovered.uninstallations[0].state,
        PluginObjectState::Sealed
    );
    assert!(!object.exists());
    fixture.assert_idle();
    let manager = plugins.manager.lock().unwrap();
    let pending = manager.pending.as_ref().unwrap();
    assert!(pending.request == intent);
    assert!(pending.complete && pending.handoff_complete);
    assert!(!pending.unknown && !pending.running.load(Ordering::Acquire));
}

#[test]
fn accepted_uninstall_survives_waiter_loss_and_holds_empty_session_across_initial_io() {
    let fixture = Fixture::new();
    let installed = fixture.install(0.into());
    let withdrawn = fixture.withdraw(&Fixture::removal(&installed));
    let request = Fixture::uninstall(&withdrawn);
    let intent = MutationRequest::Uninstall(request.clone());
    let state = fixture.app.state::<AppState>();
    // Freeze the original identity so its atomic claim can be observed without
    // racing the Store's nonblocking manager lock during accepted receipt IO.
    let claim = state.plugins.begin_cleanup(&intent).unwrap();
    let running = claim.running.clone();
    drop(claim);
    let (entered, entry) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let first_lease = state.sessions.lease(CommandStage::Read).unwrap();
    let first = first_lease
        .submit("uninstall_test.block", CommandStage::Read, move |_| {
            entered.send(()).unwrap();
            let _ = wait.recv();
            Ok(())
        })
        .unwrap();
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut waiter = Box::pin(uninstall_plugin_package(
        fixture.app.state(),
        request.clone(),
    ));
    assert!(matches!(
        waiter
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(waiter);

    let (observed, observation) = mpsc::channel();
    let (continue_session, waiting_session) = mpsc::channel();
    let original = intent.clone();
    let destination = fixture.directory.path().join("blocked-project");
    let project_path = destination.clone();
    let observer_lease = state.sessions.lease(CommandStage::Read).unwrap();
    let observer = observer_lease
        .submit("uninstall_test.hold", CommandStage::Read, move |sessions| {
            assert!(sessions.active.is_none());
            let operation = sessions.package_operation.as_ref().unwrap();
            assert!(operation.request == original);
            assert!(operation.running.strong_count() > 0);
            assert_eq!(
                sessions
                    .create(CreateProjectRequest {
                        destination: destination.to_str().unwrap().into(),
                        display_name: "Must remain unopened".into(),
                        source_locale: "en-US".into(),
                        target_locales: vec!["zh-CN".into()],
                    })
                    .unwrap_err()
                    .code,
                CommandErrorCode::Busy
            );
            observed.send(()).unwrap();
            let _ = waiting_session.recv();
            Ok(())
        })
        .unwrap();
    release.send(()).unwrap();
    observation.recv_timeout(Duration::from_secs(5)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !running.load(Ordering::Acquire) {
        assert!(
            Instant::now() < deadline,
            "accepted receipt IO did not retain ownership"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    {
        let manager = state.plugins.manager.lock().unwrap();
        let pending = manager.pending.as_ref().unwrap();
        assert!(pending.request == intent);
        assert!(!pending.complete && !pending.handoff_complete);
        assert!(pending.running.load(Ordering::Acquire));
        assert!(
            manager
                .store
                .as_ref()
                .unwrap()
                .uninstallations(|| true)
                .unwrap()
                .is_empty()
        );
    }
    assert!(fixture.object(&request.package).exists());
    assert!(!project_path.exists());
    continue_session.send(()).unwrap();
    while running.load(Ordering::Acquire) {
        assert!(
            Instant::now() < deadline,
            "owned uninstall continuation did not finish"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    drop(first);
    drop(observer);
    fixture.assert_idle();
    let removed = fixture.inventory();
    assert!(removed.packages.is_empty());
    assert_eq!(removed.uninstallations.len(), 1);
    assert_eq!(
        removed.uninstallations[0].action_id,
        request.action_id.to_string()
    );
    assert_eq!(removed.uninstallations[0].state, PluginObjectState::Sealed);
    let manager = state.plugins.manager.lock().unwrap();
    let pending = manager.pending.as_ref().unwrap();
    assert!(pending.complete && pending.handoff_complete);
    assert!(!pending.unknown);
}
