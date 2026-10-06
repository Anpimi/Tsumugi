use super::*;
use std::sync::Arc;

#[test]
fn plugin_inventory_timeout_is_a_read_budget_failure_not_corrupt_metadata() {
    let error = map_store_error(InstallError::Host(HostError::Timeout));
    assert_eq!(error.code, CommandErrorCode::LimitExceeded);
    assert_eq!(error.reason.as_deref(), Some("plugin-read-timeout"));
    assert_eq!(error.outcome, super::super::CommandOutcome::Rejected);
}

#[test]
fn plugin_inventory_wire_fixture_retains_zero_maximum_and_metadata_separation() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/pluginInventory.contract.json"
    ))
    .unwrap();
    for key in ["empty", "rich"] {
        let view: PluginInventoryView = serde_json::from_value(fixture[key].clone()).unwrap();
        assert_eq!(serde_json::to_value(&view).unwrap(), fixture[key]);
        assert_eq!(
            view.settings_revision.get(),
            if key == "empty" { 0 } else { u64::MAX }
        );
        if key == "rich" {
            assert_ne!(view.packages[0].plugin, view.package_decisions[0].plugin);
            assert_eq!(view.runtimes[0].state, PluginObjectState::RecoveryRequired);
        }
    }
}

#[test]
fn plugin_inventory_request_rejects_caller_directories_and_authority() {
    assert!(serde_json::from_str::<PluginInventoryRequest>("{}").is_ok());
    for input in [
        r#"{"directory":"/somewhere"}"#,
        r#"{"approved":true}"#,
        r#"{"sessionToken":"old"}"#,
    ] {
        assert!(serde_json::from_str::<PluginInventoryRequest>(input).is_err());
    }
}

#[test]
fn unconfigured_or_closed_plugin_owner_refuses_without_io() {
    let owner = ApplicationPlugins::default();
    let error = owner.inventory().unwrap_err();
    assert_eq!(error.code, CommandErrorCode::PermissionDenied);
    assert_eq!(
        error.reason.as_deref(),
        Some("plugin-directory-unavailable")
    );
    owner.close();
    assert_eq!(
        owner.inventory().unwrap_err().code,
        CommandErrorCode::Cancelled
    );
}

#[test]
fn application_drop_revokes_shared_read_guards_without_waiting_for_io() {
    let state = AppState::default();
    let owner = state.plugins.clone();
    let held = owner.manager.lock().unwrap();
    drop(state);
    assert!(!owner.open.load(Ordering::Acquire));
    drop(held);
    assert_eq!(
        owner.inventory().unwrap_err().code,
        CommandErrorCode::Cancelled
    );
}

#[test]
fn plugin_io_contention_is_busy_and_poisoned_metadata_is_not_empty() {
    let owner = Arc::new(ApplicationPlugins::default());
    let held = owner.manager.lock().unwrap();
    assert_eq!(owner.inventory().unwrap_err().code, CommandErrorCode::Busy);
    drop(held);
    let other = owner.clone();
    assert!(
        std::thread::spawn(move || {
            let _held = other.manager.lock().unwrap();
            panic!("controlled plugin owner failure");
        })
        .join()
        .is_err()
    );
    let error = owner.inventory().unwrap_err();
    assert_eq!(error.code, CommandErrorCode::OutputInvalid);
    assert_eq!(error.reason.as_deref(), Some("plugin-store-corrupt"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
    use super::*;
    use std::{
        collections::BTreeMap,
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        path::Path,
    };
    use tsumugi_plugin_host::{
        ApprovedPackageSetting, PackageFile, PackageImage, PluginSettingsUpdate, RuntimeApproval,
        catalog::{PackageApproval, PackageCatalog},
    };

    const ACTION: &str = "00000000-0000-4000-8000-000000000001";
    const SETTINGS_ACTION: &str = "00000000-0000-4000-8000-000000000002";
    const APPLICATION: &str = "com.tsumugi.test";

    struct Fixture(tempfile::TempDir);
    impl Fixture {
        fn new() -> Self {
            Self(tempfile::tempdir().unwrap())
        }
        fn application(&self) -> PathBuf {
            self.0.path().join(APPLICATION)
        }
        fn root(&self) -> PathBuf {
            self.application().join("plugins")
        }
        fn owner(&self) -> Arc<ApplicationPlugins> {
            let owner = Arc::new(ApplicationPlugins::default());
            owner.configure(self.application()).unwrap();
            owner
        }
        fn store(&self) -> PackageStore {
            PackageStore::provision(self.0.path(), &[APPLICATION, "plugins"], || true).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only the synthetic fixture becomes removable; links are not walked.
            fn removable(path: &Path) {
                if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                    for child in fs::read_dir(path).unwrap() {
                        removable(&child.unwrap().path());
                    }
                }
            }
            removable(self.0.path());
        }
    }
    fn origin() -> PackageOrigin {
        PackageOrigin {
            source_id: "synthetic-approved-source".into(),
            publisher_id: "synthetic-approved-key".into(),
        }
    }
    fn package() -> (PackageCatalog, PackageApproval) {
        let manifest = sdk::PluginManifest {
            protocol_version: sdk::MANIFEST_PROTOCOL,
            plugin: sdk::PluginIdentity {
                publisher: "example".into(),
                id: "inventory-only".into(),
                version: "0.1.0".into(),
            },
            permissions: vec![],
            components: vec![sdk::ComponentDeclaration {
                id: "worker".into(),
                scope: sdk::ComponentScope::Project,
                runtime: sdk::RuntimeKind::JavaScript,
                entrypoint: Some("worker.mjs".into()),
                dependencies: vec![],
                exit: sdk::ExitRequirements {
                    stop_timeout_ms: 100,
                    cleanup_timeout_ms: 100,
                },
            }],
            contributions: vec![sdk::ContributionDeclaration {
                id: "resource".into(),
                component_id: "worker".into(),
                contribution: sdk::ContributionKind::Resource {
                    schema: sdk::ContractRef {
                        id: "example.resource".into(),
                        schema_version: 1,
                        behavior_version: 1,
                    },
                    path: "marker.txt".into(),
                },
            }],
        };
        let files = BTreeMap::from([
            (
                "worker.mjs".into(),
                PackageFile {
                    bytes: b"throw new Error('inventory must not execute');".to_vec(),
                    executable: false,
                },
            ),
            (
                "marker.txt".into(),
                PackageFile {
                    bytes: b"captured data".to_vec(),
                    executable: false,
                },
            ),
        ]);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = PackageImage::digest(&bytes, &files).unwrap();
        let image = PackageImage::capture(bytes, files, &digest).unwrap();
        let approval = PackageApproval {
            plugin: manifest.plugin,
            package_digest: digest,
            origin: origin(),
        };
        let mut catalog = PackageCatalog::new();
        catalog.register(image, approval.clone()).unwrap();
        (catalog, approval)
    }
    fn environment() -> sdk::RuntimeEnvironmentDescriptor {
        sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: sdk::RuntimePlatform {
                operating_system: if cfg!(target_os = "macos") {
                    sdk::RuntimeOperatingSystem::Macos
                } else {
                    sdk::RuntimeOperatingSystem::Linux
                },
                architecture: if cfg!(target_arch = "aarch64") {
                    sdk::RuntimeArchitecture::Aarch64
                } else {
                    sdk::RuntimeArchitecture::X86_64
                },
            },
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: "a".repeat(64),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: "b".repeat(64),
                entrypoint: "dist/main.js".into(),
            },
        }
    }

    #[test]
    fn inventory_provisions_once_holds_store_lock_and_writes_no_decisions() {
        let fixture = Fixture::new();
        let owner = fixture.owner();
        assert!(!fixture.application().exists());
        let view = owner.inventory().unwrap();
        assert_eq!(view.settings_revision.get(), 0);
        let fixture_json: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/pluginInventory.contract.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(&view).unwrap(), fixture_json["empty"]);
        assert!(view.last_settings_action.is_none());
        assert!(view.packages.is_empty() && view.runtimes.is_empty());
        assert!(view.package_decisions.is_empty() && view.runtime_decisions.is_empty());
        assert!(!fixture.root().join("settings.json").exists());
        for path in [fixture.application(), fixture.root()] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o7777,
                0o700
            );
        }
        assert_eq!(owner.inventory().unwrap(), view);
        assert_eq!(
            fixture.owner().inventory().unwrap_err().code,
            CommandErrorCode::Busy
        );
        drop(owner);
        assert_eq!(fixture.owner().inventory().unwrap(), view);
    }

    #[test]
    fn installed_receipts_and_missing_artifact_approvals_remain_independent() {
        let fixture = Fixture::new();
        let (catalog, approval) = package();
        let mut store = fixture.store();
        store
            .install(
                ACTION,
                catalog.registered(&approval.plugin).unwrap(),
                || true,
            )
            .unwrap();
        drop(store);
        let owner = fixture.owner();
        let before = owner.inventory().unwrap();
        assert_eq!(before.packages.len(), 1);
        assert_eq!(before.packages[0].plugin, approval.plugin);
        assert_eq!(before.packages[0].state, PluginObjectState::Sealed);
        assert!(before.package_decisions.is_empty());
        drop(owner);
        let mut missing = approval.clone();
        missing.plugin.id = "not-installed".into();
        missing.package_digest = "c".repeat(64);
        let mut store = fixture.store();
        store
            .update_settings(
                0,
                SETTINGS_ACTION,
                &PluginSettingsUpdate {
                    packages: vec![ApprovedPackageSetting {
                        approval: missing.clone(),
                        enabled: true,
                    }],
                    runtimes: vec![RuntimeApproval {
                        environment: environment().into(),
                        origin: origin(),
                    }],
                },
                || true,
            )
            .unwrap();
        drop(store);
        let owner = fixture.owner();
        let view = owner.inventory().unwrap();
        assert_eq!(view.packages, before.packages);
        assert!(view.runtimes.is_empty());
        assert_eq!(view.settings_revision.get(), 1);
        assert_eq!(view.last_settings_action.as_deref(), Some(SETTINGS_ACTION));
        assert_eq!(view.package_decisions[0].plugin, missing.plugin);
        assert!(view.package_decisions[0].enabled);
        assert_eq!(view.runtime_decisions[0].environment, environment().into());
        assert!(!catalog.is_enabled(&approval.plugin).unwrap());
        let bytes = serde_json::to_vec(&view).unwrap();
        assert!(
            !String::from_utf8(bytes)
                .unwrap()
                .contains(fixture.0.path().to_str().unwrap())
        );
        let stored = fs::read(fixture.root().join("settings.json")).unwrap();
        assert_eq!(owner.inventory().unwrap(), view);
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            stored
        );
    }

    #[test]
    fn native_approval_projection_is_metadata_and_not_an_installed_node_runtime() {
        let fixture = Fixture::new();
        let native = RuntimeApproval {
            environment: tsumugi_plugin_host::CapturedNativeRuntime::inspect_current()
                .unwrap()
                .into(),
            origin: origin(),
        };
        let digest = native.environment.digest().unwrap();
        let mut store = fixture.store();
        store
            .update_settings(
                0,
                SETTINGS_ACTION,
                &PluginSettingsUpdate {
                    packages: vec![],
                    runtimes: vec![native.clone()],
                },
                || true,
            )
            .unwrap();
        drop(store);
        let before = fs::read(fixture.root().join("settings.json")).unwrap();
        let owner = fixture.owner();
        let view = owner.inventory().unwrap();
        assert_eq!(view.runtime_decisions.len(), 1);
        assert_eq!(view.runtime_decisions[0].environment, native.environment);
        assert_eq!(view.runtime_decisions[0].environment_digest, digest);
        assert!(view.runtimes.is_empty());
        assert!(view.packages.is_empty());
        assert_eq!(view.settings_revision.get(), 1);
        let error = owner.lookup_runtime(&digest).unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("plugin-approval-mismatch"));
        assert_eq!(owner.inventory().unwrap(), view);
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            before
        );
        let round_trip: PluginInventoryView =
            serde_json::from_slice(&serde_json::to_vec(&view).unwrap()).unwrap();
        assert_eq!(round_trip, view);
    }

    #[test]
    fn installed_runtime_projection_keeps_complete_environment_without_approval() {
        use tsumugi_plugin_host::CapturedRuntime;
        let fixture = Fixture::new();
        let tool = fixture.0.path().join("tool");
        let host = fixture.0.path().join("host");
        let tool_files = BTreeMap::from([(
            "bin/node".into(),
            sdk::RuntimeArtifactFile {
                bytes: b"synthetic non-program".to_vec(),
                executable: true,
            },
        )]);
        let host_files = BTreeMap::from([(
            "dist/main.js".into(),
            sdk::RuntimeArtifactFile {
                bytes: b"throw new Error('inventory must not execute');".to_vec(),
                executable: false,
            },
        )]);
        for (root, files) in [(&tool, &tool_files), (&host, &host_files)] {
            for (name, file) in files {
                let path = root.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, &file.bytes).unwrap();
                fs::set_permissions(
                    &path,
                    fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
                )
                .unwrap();
            }
        }
        let mut environment = environment();
        environment.tool.tree_digest = sdk::runtime_artifact_digest(&tool_files).unwrap();
        environment.host.tree_digest = sdk::runtime_artifact_digest(&host_files).unwrap();
        let runtime =
            CapturedRuntime::capture_directories(&tool, &host, &environment, || true).unwrap();
        let mut store = fixture.store();
        store
            .install_runtime(
                ACTION,
                &runtime,
                &RuntimeApproval {
                    environment: environment.clone().into(),
                    origin: origin(),
                },
                || true,
            )
            .unwrap();
        drop(store);
        let view = fixture.owner().inventory().unwrap();
        assert_eq!(
            view.runtimes,
            vec![PluginRuntimeView {
                environment_digest: environment.digest().unwrap(),
                environment,
                origin: (&origin()).into(),
                state: PluginObjectState::Sealed,
            }]
        );
        assert!(view.runtime_decisions.is_empty());
        assert_eq!(view.settings_revision.get(), 0);
        assert!(!fixture.root().join("settings.json").exists());
    }

    #[test]
    fn dropped_plugin_read_reply_keeps_accepted_blocking_work_owned() {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
            time::Duration,
        };
        let fixture = Fixture::new();
        let state = AppState::default();
        state.plugins.configure(fixture.application()).unwrap();
        let owner = state.plugins.clone();
        let (entered, started) = std::sync::mpsc::sync_channel(1);
        let (release, wait) = std::sync::mpsc::sync_channel(1);
        let (finished, terminal) = std::sync::mpsc::sync_channel(1);
        let mut future = Box::pin(state.io.run(CommandStage::Read, move || {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let view = owner.inventory()?;
            finished.send(view.clone()).unwrap();
            Ok(view)
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
        assert_eq!(
            terminal
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .settings_revision
                .get(),
            0
        );
        assert!(fixture.root().join("objects").exists());
        assert_eq!(
            state.plugins.inventory().unwrap().settings_revision.get(),
            0
        );
    }

    #[test]
    fn corrupt_settings_and_replaced_roots_are_refused_and_preserved() {
        let fixture = Fixture::new();
        let owner = fixture.owner();
        owner.inventory().unwrap();
        let file = fixture.root().join("settings.json");
        fs::write(&file, b"not approved settings").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o400)).unwrap();
        let error = owner.inventory().unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("plugin-settings-corrupt"));
        assert_eq!(fs::read(file).unwrap(), b"not approved settings");
        let old = fixture.application().join("old-plugins");
        fs::rename(fixture.root(), &old).unwrap();
        fs::create_dir(fixture.root()).unwrap();
        fs::set_permissions(fixture.root(), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            owner.inventory().unwrap_err().reason.as_deref(),
            Some("plugin-store-changed")
        );
        assert_eq!(fs::read_dir(fixture.root()).unwrap().count(), 0);
        assert_eq!(
            fs::read(old.join("settings.json")).unwrap(),
            b"not approved settings"
        );
    }

    #[test]
    fn existing_tauri_application_directory_is_an_anchor_without_permission_repair() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.application()).unwrap();
        fs::set_permissions(fixture.application(), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            fixture.owner().inventory().unwrap().settings_revision.get(),
            0
        );
        assert_eq!(
            fs::metadata(fixture.application())
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o755
        );
        assert_eq!(
            fs::metadata(fixture.root()).unwrap().permissions().mode() & 0o7777,
            0o700
        );
    }

    #[test]
    fn unsafe_application_paths_are_not_repaired_or_redirected() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.application()).unwrap();
        fs::set_permissions(fixture.application(), fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            fixture.owner().inventory().unwrap_err().code,
            CommandErrorCode::PermissionDenied
        );
        assert_eq!(
            fs::metadata(fixture.application())
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o777
        );
        assert!(!fixture.root().exists());
        let linked = fixture.0.path().join("linked-app");
        symlink(fixture.application(), &linked).unwrap();
        let owner = ApplicationPlugins::default();
        owner.configure(linked).unwrap();
        assert_eq!(
            owner.inventory().unwrap_err().code,
            CommandErrorCode::PermissionDenied
        );
        for invalid in [
            PathBuf::from("relative/application"),
            PathBuf::from("/"),
            fixture.0.path().join("../application"),
        ] {
            assert!(ApplicationPlugins::default().configure(invalid).is_err());
        }
    }

    #[test]
    fn tauri_plugin_inventory_reaches_real_store_on_blocking_executor() {
        use tauri::{
            Manager,
            ipc::{CallbackFn, InvokeBody},
            webview::InvokeRequest,
        };
        for with_native in [false, true] {
            let fixture = Fixture::new();
            let native = with_native.then(|| RuntimeApproval {
                environment: tsumugi_plugin_host::CapturedNativeRuntime::inspect_current()
                    .unwrap()
                    .into(),
                origin: origin(),
            });
            if let Some(approval) = &native {
                fixture
                    .store()
                    .update_settings(
                        0,
                        SETTINGS_ACTION,
                        &PluginSettingsUpdate {
                            packages: vec![],
                            runtimes: vec![approval.clone()],
                        },
                        || true,
                    )
                    .unwrap();
            }
            let before = fs::read(fixture.root().join("settings.json")).ok();
            let app = crate::commands::register_commands(tauri::test::mock_builder())
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            // The mock builder does not invoke native setup. Supply only this test's
            // synthetic application directory; no developer app-data is consulted.
            app.state::<AppState>()
                .plugins
                .configure(fixture.application())
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .build()
            .unwrap();
            let invoke = |body| InvokeRequest {
                cmd: "read_plugin_inventory".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: crate::ipc_test_url().parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            };
            let view =
                tauri::test::get_ipc_response(&window, invoke(serde_json::json!({"request":{}})))
                    .unwrap()
                    .deserialize::<PluginInventoryView>()
                    .unwrap();
            assert_eq!(view.settings_revision.get(), u64::from(with_native));
            if let Some(approval) = native {
                assert_eq!(view.runtime_decisions.len(), 1);
                assert_eq!(view.runtime_decisions[0].environment, approval.environment);
                assert_eq!(
                    view.runtime_decisions[0].environment_digest,
                    approval.environment.digest().unwrap()
                );
            } else {
                assert!(view.runtime_decisions.is_empty());
            }
            assert!(view.runtimes.is_empty());
            assert!(fixture.root().join("objects").is_dir());
            assert!(
                tauri::test::get_ipc_response(
                    &window,
                    invoke(serde_json::json!({"request":{"directory":"/untrusted"}}))
                )
                .is_err()
            );
            assert_eq!(fs::read(fixture.root().join("settings.json")).ok(), before);
        }
    }
}
