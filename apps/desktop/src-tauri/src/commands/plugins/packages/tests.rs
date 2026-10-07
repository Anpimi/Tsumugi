use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::Arc};

struct Fixture {
    directory: tempfile::TempDir,
    owner: Arc<ApplicationPlugins>,
    source: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let owner = Arc::new(ApplicationPlugins::default());
        owner
            .configure(directory.path().join("application"))
            .unwrap();
        let source = directory.path().join("candidate");
        fs::create_dir(&source).unwrap();
        let fixture: PluginCandidateView = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/pluginPackage.contract.json"
        ))
        .unwrap();
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&fixture.manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            source.join("worker.mjs"),
            b"throw new Error('installation must not execute');",
        )
        .unwrap();
        Self {
            directory,
            owner,
            source,
        }
    }
    fn root(&self) -> PathBuf {
        self.directory.path().join("application/plugins")
    }
    fn select(&self) -> PluginCandidateView {
        let lease = self.owner.begin_picker().unwrap();
        self.owner
            .finish_picker(lease.id, Some(self.source.clone()))
            .unwrap()
            .unwrap()
    }
    fn install(&self) -> (PluginInstallRequest, PluginInventoryView) {
        let selected = self.select();
        let request = PluginInstallRequest {
            ticket: selected.ticket,
            expected_revision: 0.into(),
            action_id: ExecutionId::new(),
        };
        let view = self.owner.install_package(request.clone()).unwrap();
        (request, view)
    }
    fn provider(view: &PluginInventoryView) -> sdk::ProviderSelectionBinding {
        sdk::ProviderSelectionBinding {
            plugin: view.packages[0].plugin.clone(),
            package_digest: view.packages[0].package_digest.clone(),
            component_id: "worker".into(),
            contribution_id: "query".into(),
        }
    }
    fn enable(view: &PluginInventoryView, enabled: bool) -> PluginEnableRequest {
        PluginEnableRequest {
            package: PluginPackageRequest {
                plugin: view.package_decisions[0].plugin.clone(),
                package_digest: view.package_decisions[0].package_digest.clone(),
            },
            enabled,
            expected_revision: view.settings_revision,
            action_id: ExecutionId::new(),
        }
    }
    fn rewrite_settings(&self, bytes: &[u8]) {
        let path = self.root().join("settings.json");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fn removable(path: &Path) {
            if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                for child in fs::read_dir(path).unwrap() {
                    removable(&child.unwrap().path());
                }
            }
        }
        removable(self.directory.path());
    }
}

#[test]
fn local_selection_has_no_installation_or_approval_and_rejects_late_picker() {
    let fixture = Fixture::new();
    let old = fixture.owner.begin_picker().unwrap();
    assert_eq!(
        fixture.owner.begin_picker().err().unwrap().code,
        CommandErrorCode::Busy
    );
    let old_id = old.id;
    drop(old);
    let new = fixture.owner.begin_picker().unwrap();
    assert_eq!(
        fixture
            .owner
            .finish_picker(old_id, Some(fixture.source.clone()))
            .unwrap_err()
            .code,
        CommandErrorCode::Cancelled
    );
    assert!(fixture.owner.finish_picker(new.id, None).unwrap().is_none());
    let candidate = fixture.select();
    assert_eq!(candidate.manifest.plugin.id, "local-tools");
    assert_eq!(candidate.file_count, 2);
    assert!(!fixture.root().exists());
}

#[test]
fn changed_expired_and_closed_candidates_cannot_create_approval_or_objects() {
    for scenario in ["changed", "expired", "closed"] {
        let fixture = Fixture::new();
        let selected = fixture.select();
        match scenario {
            "changed" => fs::write(fixture.source.join("worker.mjs"), b"different bytes").unwrap(),
            "expired" => {
                fixture
                    .owner
                    .manager
                    .lock()
                    .unwrap()
                    .candidate
                    .as_mut()
                    .unwrap()
                    .expires = Instant::now()
            }
            "closed" => fixture.owner.close(),
            _ => unreachable!(),
        }
        let error = fixture
            .owner
            .install_package(PluginInstallRequest {
                ticket: selected.ticket,
                expected_revision: 0.into(),
                action_id: ExecutionId::new(),
            })
            .unwrap_err();
        assert_ne!(error.code, CommandErrorCode::OutcomeUnknown);
        assert!(!fixture.root().join("settings.json").exists());
        if fixture.root().exists() {
            assert_eq!(
                fs::read_dir(fixture.root().join("objects"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }
}

#[test]
fn manual_install_is_disabled_exactly_retries_and_enabling_controls_fresh_lookup() {
    let fixture = Fixture::new();
    let (request, installed) = fixture.install();
    assert_eq!(installed.settings_revision.get(), 1);
    assert_eq!(installed.packages.len(), 1);
    assert!(!installed.package_decisions[0].enabled);
    assert_eq!(
        installed.package_decisions[0].origin.source_id,
        "manual-local"
    );
    let provider = Fixture::provider(&installed);
    assert_eq!(
        fixture
            .owner
            .lookup(&provider)
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-disabled")
    );
    let settings = fs::read(fixture.root().join("settings.json")).unwrap();
    fs::remove_dir_all(&fixture.source).unwrap();
    assert_eq!(
        fixture.owner.install_package(request.clone()).unwrap(),
        installed
    );
    assert_eq!(
        fs::read(fixture.root().join("settings.json")).unwrap(),
        settings
    );
    let enable = Fixture::enable(&installed, true);
    let enabled = fixture.owner.enable_package(enable.clone()).unwrap();
    let held = fixture.owner.lookup(&provider).unwrap();
    assert_eq!(held.binding().provider, provider);
    assert_eq!(fixture.owner.enable_package(enable).unwrap(), enabled);
    let mut substituted = provider.clone();
    substituted.package_digest = "f".repeat(64);
    assert!(fixture.owner.lookup(&substituted).is_err());
    substituted = provider.clone();
    substituted.component_id = "another-owner".into();
    assert!(fixture.owner.lookup(&substituted).is_err());
    let disabled = fixture
        .owner
        .enable_package(Fixture::enable(&enabled, false))
        .unwrap();
    assert!(!disabled.package_decisions[0].enabled);
    assert!(fixture.owner.lookup(&provider).is_err());
    assert_eq!(held.binding().provider, provider);
    assert_eq!(
        fixture.owner.install_package(request).unwrap_err().code,
        CommandErrorCode::StaleRevision
    );
}

#[test]
fn enabling_rechecks_actual_artifact_bytes_but_disabling_needs_no_valid_bytes() {
    let fixture = Fixture::new();
    let (_, installed) = fixture.install();
    let enabled = fixture
        .owner
        .enable_package(Fixture::enable(&installed, true))
        .unwrap();
    let worker = fixture
        .root()
        .join("objects")
        .join(&enabled.packages[0].package_digest)
        .join("package/worker.mjs");
    fs::set_permissions(&worker, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&worker, b"tampered").unwrap();
    fs::set_permissions(worker, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(fixture.owner.lookup(&Fixture::provider(&enabled)).is_err());
    assert!(
        fixture
            .owner
            .enable_package(Fixture::enable(&enabled, true))
            .is_err()
    );
    let disabled = fixture
        .owner
        .enable_package(Fixture::enable(&enabled, false))
        .unwrap();
    assert!(!disabled.package_decisions[0].enabled);
}

#[test]
fn completed_install_with_lost_projection_retains_unknown_until_exact_confirmation() {
    let fixture = Fixture::new();
    let (request, _) = fixture.install();
    let settings = fs::read(fixture.root().join("settings.json")).unwrap();
    fixture.rewrite_settings(b"invalid settings");
    assert_eq!(
        fixture
            .owner
            .install_package(request.clone())
            .unwrap_err()
            .code,
        CommandErrorCode::OutcomeUnknown
    );
    assert_eq!(
        fixture.owner.begin_picker().err().unwrap().code,
        CommandErrorCode::Busy
    );
    assert_eq!(
        fixture
            .owner
            .install_package(request.clone())
            .unwrap_err()
            .code,
        CommandErrorCode::OutcomeUnknown
    );
    fixture.rewrite_settings(&settings);
    let confirmed = fixture.owner.install_package(request).unwrap();
    assert_eq!(confirmed.settings_revision.get(), 1);
    assert!(fixture.owner.begin_picker().is_ok());
}

#[test]
fn unknown_install_retry_keeps_frozen_package_through_source_loss_and_read_failure() {
    let fixture = Fixture::new();
    let (request, installed) = fixture.install();
    // Model the application's retained intent after a lost durability ACK;
    // the retry below exercises the real Store original-action sync path.
    {
        let mut manager = fixture.owner.manager.lock().unwrap();
        let pending = manager.pending.as_mut().unwrap();
        pending.complete = false;
        pending.unknown = true;
        pending.packages[0].original = Some(request.action_id.to_string());
    }
    fs::remove_dir_all(&fixture.source).unwrap();
    let receipt = fixture
        .root()
        .join("objects")
        .join(&installed.packages[0].package_digest)
        .join("receipt.json");
    let receipt_bytes = fs::read(&receipt).unwrap();
    fs::set_permissions(&receipt, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&receipt, b"invalid receipt").unwrap();
    fs::set_permissions(&receipt, fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(
        fixture
            .owner
            .install_package(request.clone())
            .unwrap_err()
            .code,
        CommandErrorCode::OutcomeUnknown
    );
    assert_eq!(
        fixture.owner.begin_picker().err().unwrap().code,
        CommandErrorCode::Busy
    );
    fs::set_permissions(&receipt, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&receipt, receipt_bytes).unwrap();
    fs::set_permissions(receipt, fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(fixture.owner.install_package(request).unwrap(), installed);
    assert!(fixture.owner.begin_picker().is_ok());
}

#[test]
fn package_wire_fixture_and_requests_refuse_caller_authority() {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginPackage.contract.json"
    ))
    .unwrap();
    let view: PluginCandidateView = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(view).unwrap(), value);
    let request = serde_json::json!({"ticket":ExecutionId::new(),"expectedRevision":"0","actionId":ExecutionId::new()});
    assert!(serde_json::from_value::<PluginInstallRequest>(request.clone()).is_ok());
    for key in ["directory", "origin", "enabled", "grant"] {
        let mut malicious = request.clone();
        malicious[key] = serde_json::json!(true);
        assert!(serde_json::from_value::<PluginInstallRequest>(malicious).is_err());
    }
}

#[test]
fn fresh_manual_approval_recovers_only_the_matching_original_install_action() {
    let fixture = Fixture::new();
    let (original, installed) = fixture.install();
    let object = fixture
        .root()
        .join("objects")
        .join(&installed.packages[0].package_digest);
    fs::set_permissions(&object, fs::Permissions::from_mode(0o700)).unwrap();
    // Model reopening with no in-memory accepted intent. Receipt observations
    // alone still do not approve or repair the object.
    fixture.owner.manager.lock().unwrap().pending = None;
    assert_eq!(
        fixture.owner.inventory().unwrap().packages[0].state,
        PluginObjectState::RecoveryRequired
    );
    let candidate = fixture.select();
    let fresh = PluginInstallRequest {
        ticket: candidate.ticket,
        expected_revision: installed.settings_revision,
        action_id: ExecutionId::new(),
    };
    assert_ne!(fresh.action_id, original.action_id);
    let recovered = fixture.owner.install_package(fresh).unwrap();
    assert_eq!(recovered.packages[0].state, PluginObjectState::Sealed);
    assert_eq!(recovered.settings_revision.get(), 2);
    assert!(!recovered.package_decisions[0].enabled);
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(object.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(receipt["actionId"], original.action_id.to_string());
}

#[test]
fn accepted_install_finishes_and_can_reconcile_after_reply_is_dropped() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let fixture = Fixture::new();
    let candidate = fixture.select();
    let request = PluginInstallRequest {
        ticket: candidate.ticket,
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let state = AppState::default();
    let owner = fixture.owner.clone();
    let original = request.clone();
    let (entered, started) = std::sync::mpsc::sync_channel(1);
    let (release, wait) = std::sync::mpsc::sync_channel(1);
    let (finished, terminal) = std::sync::mpsc::sync_channel(1);
    let mut future = Box::pin(state.io.run(CommandStage::PluginInstall, move || {
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = owner.install_package(original)?;
        finished.send(result.clone()).unwrap();
        Ok(result)
    }));
    assert!(matches!(
        future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(future);
    release.send(()).unwrap();
    let installed = terminal.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(fixture.owner.install_package(request).unwrap(), installed);
}

#[test]
fn registered_package_ipc_installs_enables_and_looks_up_real_store_bytes() {
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    let fixture = Fixture::new();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let owner = &app.state::<AppState>().plugins;
    owner
        .configure(fixture.directory.path().join("application"))
        .unwrap();
    let lease = owner.begin_picker().unwrap();
    let selected = owner
        .finish_picker(lease.id, Some(fixture.source.clone()))
        .unwrap()
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let invoke = |command: &str, request: serde_json::Value| InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(),
        body: InvokeBody::Json(serde_json::json!({"request":request})),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.into(),
    };
    let request = PluginInstallRequest {
        ticket: selected.ticket,
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let installed = tauri::test::get_ipc_response(
        &window,
        invoke(
            "install_plugin_package",
            serde_json::to_value(&request).unwrap(),
        ),
    )
    .unwrap()
    .deserialize::<PluginInventoryView>()
    .unwrap();
    assert_eq!(installed.settings_revision.get(), 1);
    assert!(!installed.package_decisions[0].enabled);
    let provider = Fixture::provider(&installed);
    let lookup = serde_json::json!({"provider":provider});
    assert!(
        tauri::test::get_ipc_response(&window, invoke("lookup_plugin_capability", lookup.clone()))
            .is_err()
    );
    let enable = Fixture::enable(&installed, true);
    let enabled = tauri::test::get_ipc_response(
        &window,
        invoke("set_plugin_enabled", serde_json::to_value(enable).unwrap()),
    )
    .unwrap()
    .deserialize::<PluginInventoryView>()
    .unwrap();
    assert!(enabled.package_decisions[0].enabled);
    let binding =
        tauri::test::get_ipc_response(&window, invoke("lookup_plugin_capability", lookup))
            .unwrap()
            .deserialize::<sdk::CapabilityBinding>()
            .unwrap();
    assert_eq!(binding.provider, provider);
    let package = PluginPackageRequest {
        plugin: provider.plugin,
        package_digest: provider.package_digest,
    };
    assert!(
        tauri::test::get_ipc_response(
            &window,
            invoke(
                "read_plugin_package",
                serde_json::to_value(package).unwrap()
            )
        )
        .is_ok()
    );
    let mut untrusted = serde_json::to_value(request).unwrap();
    untrusted["origin"] = serde_json::json!("forged");
    assert!(
        tauri::test::get_ipc_response(&window, invoke("install_plugin_package", untrusted))
            .is_err()
    );
    assert_eq!(owner.inventory().unwrap().settings_revision.get(), 2);
}

#[test]
fn settings_epoch_is_revoked_before_a_failed_store_update_and_never_restored() {
    let fixture = Fixture::new();
    let (_, installed) = fixture.install();
    let original = fixture
        .owner
        .with_environment_authority(installed.settings_revision, Ok)
        .unwrap();
    let settings_bytes = fs::read(fixture.root().join("settings.json")).unwrap();
    let request = Fixture::enable(&installed, false);
    // Retain a captured settings intent, as on the ordinary same-action retry.
    // Corrupting only this synthetic Store makes its next actual update fail
    // before promotion. The old token must already have been withdrawn.
    {
        let mut manager = fixture.owner.manager.lock().unwrap();
        let settings = manager.store.as_ref().unwrap().settings(|| true).unwrap();
        manager.pending = Some(PendingMutation {
            request: MutationRequest::Enable(request.clone()),
            desired: PluginSettingsUpdate {
                packages: settings.packages().to_vec(),
                runtimes: settings.runtimes().to_vec(),
            },
            packages: vec![],
            runtime: None,
            settings_confirmed: false,
            complete: false,
            unknown: false,
        });
    }
    fixture.rewrite_settings(b"synthetic invalid settings");
    let error = fixture.owner.enable_package(request.clone()).unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("plugin-settings-corrupt"));
    assert_ne!(error.code, CommandErrorCode::OutcomeUnknown);
    assert!(
        original.is_requested(),
        "the Store failed before writing any settings"
    );
    assert_eq!(
        fs::read(fixture.root().join("settings.json")).unwrap(),
        b"synthetic invalid settings"
    );
    fixture.rewrite_settings(&settings_bytes);
    let fresh = fixture
        .owner
        .with_environment_authority(installed.settings_revision, Ok)
        .unwrap();
    assert!(
        !fresh.is_requested(),
        "fresh capture reads the unchanged actual revision"
    );
    assert!(original.is_requested());
    let result = fixture.owner.enable_package(request).unwrap();
    assert!(fresh.is_requested());
    assert_eq!(
        result.settings_revision.get(),
        installed.settings_revision.get() + 1
    );
    assert!(
        fixture
            .owner
            .with_environment_authority(installed.settings_revision, Ok)
            .is_err()
    );
    let current = fixture
        .owner
        .with_environment_authority(result.settings_revision, Ok)
        .unwrap();
    assert!(!current.is_requested());
    assert!(original.is_requested());
}

#[test]
fn settings_unknown_blocks_fresh_epoch_but_unrelated_package_unknown_does_not() {
    let fixture = Fixture::new();
    let revision = fixture.owner.environment_settings_revision().unwrap();
    let original = fixture
        .owner
        .with_environment_authority(revision, Ok)
        .unwrap();
    let (request, installed) = fixture.install();
    assert!(original.is_requested());
    let confirmed = fixture
        .owner
        .with_environment_authority(installed.settings_revision, Ok)
        .unwrap();
    // Model a lost settings durability acknowledgement. The exact retry below
    // uses the real Store's original-action confirmation without rewriting it.
    {
        let mut manager = fixture.owner.manager.lock().unwrap();
        let pending = manager.pending.as_mut().unwrap();
        pending.complete = false;
        pending.settings_confirmed = false;
        pending.unknown = true;
    }
    let mut entered = false;
    let error = fixture
        .owner
        .with_environment_authority(installed.settings_revision, |_| {
            entered = true;
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error.code, CommandErrorCode::OutcomeUnknown);
    assert_eq!(error.reason.as_deref(), Some("plugin-result-unconfirmed"));
    assert!(!entered);
    assert!(confirmed.is_requested());
    assert_eq!(
        fixture.owner.install_package(request.clone()).unwrap(),
        installed
    );
    let fresh = fixture
        .owner
        .with_environment_authority(installed.settings_revision, Ok)
        .unwrap();
    assert!(!fresh.is_requested());
    assert!(confirmed.is_requested());
    let before = fs::read(fixture.root().join("settings.json")).unwrap();
    {
        let mut manager = fixture.owner.manager.lock().unwrap();
        let pending = manager.pending.as_mut().unwrap();
        assert!(pending.settings_confirmed);
        pending.complete = false;
        pending.unknown = true;
    }
    let independent = fixture
        .owner
        .with_environment_authority(installed.settings_revision, Ok)
        .unwrap();
    assert!(!independent.is_requested());
    assert!(
        !fresh.is_requested(),
        "confirmed settings retain their one live epoch"
    );
    assert_eq!(
        fs::read(fixture.root().join("settings.json")).unwrap(),
        before
    );
    assert_eq!(fixture.owner.install_package(request).unwrap(), installed);
    assert!(
        !fresh.is_requested(),
        "reconciliation of an unrelated object does not renew settings"
    );
}
