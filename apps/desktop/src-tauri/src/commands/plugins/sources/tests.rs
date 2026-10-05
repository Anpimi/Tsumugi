use super::*;

fn request() -> PluginSourceRequest {
    serde_json::from_value(fixture()["request"].clone()).unwrap()
}
fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginSource.contract.json"
    ))
    .unwrap()
}

#[test]
fn source_wire_fixture_and_request_keep_snapshot_separate_from_authority() {
    let fixture = fixture();
    let view: PluginSourceView = serde_json::from_value(fixture["view"].clone()).unwrap();
    assert_eq!(serde_json::to_value(view).unwrap(), fixture["view"]);
    for key in [
        "directory",
        "origin",
        "environment",
        "approved",
        "grantId",
        "allowUnsandboxedExecution",
    ] {
        let mut forged = fixture["request"].clone();
        forged[key] = serde_json::json!(true);
        assert!(serde_json::from_value::<PluginSourceRequest>(forged).is_err());
    }
    let mut forged = fixture["request"].clone();
    forged["package"]["approved"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PluginSourceRequest>(forged).is_err());
}

#[test]
fn invalid_source_choices_do_not_provision_or_obtain_current_authority() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("application");
    let owner = ApplicationPlugins::default();
    owner.configure(root.clone()).unwrap();
    for scenario in 0..5 {
        let mut request = request();
        match scenario {
            0 => request.package.package_digest = "not-a-digest".into(),
            1 => request.environment_digest = "not-a-digest".into(),
            2 => request.package.plugin.version = "latest".into(),
            3 => request.resource_id.clear(),
            _ => request.resource_id = "x".repeat(129),
        }
        assert!(owner.capture_source(&request).is_err());
        assert!(!root.exists());
    }
    let held = owner.manager.lock().unwrap();
    assert_eq!(
        owner.capture_source(&request()).err().unwrap().code,
        CommandErrorCode::Busy
    );
    drop(held);
    owner.close();
    assert_eq!(
        owner.capture_source(&request()).err().unwrap().code,
        CommandErrorCode::Cancelled
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
    use super::*;
    use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path, sync::Arc};
    use tsumugi_core::execution::ExecutionId;
    use tsumugi_plugin_host::{
        ApprovedPackageSetting, PackageFile, PackageImage, PluginSettingsUpdate, RuntimeApproval,
        catalog::{PackageApproval, PackageCatalog},
    };

    struct Fixture {
        directory: tempfile::TempDir,
        owner: Arc<ApplicationPlugins>,
        image: PackageImage,
        approval: PackageApproval,
    }
    impl Fixture {
        fn new(
            change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
        ) -> Self {
            Self::with_owner(Arc::new(ApplicationPlugins::default()), change)
        }
        fn with_owner(
            owner: Arc<ApplicationPlugins>,
            change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
        ) -> Self {
            let directory = tempfile::tempdir().unwrap();
            owner
                .configure(directory.path().join("application"))
                .unwrap();
            let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/source-import.manifest.json"
            ))
            .unwrap();
            let mut files = BTreeMap::from([
                ("component.mjs".into(), PackageFile { bytes: b"throw new Error('source metadata must not execute');".to_vec(), executable: false }),
                ("source-profile.json".into(), PackageFile { bytes: include_bytes!(
                    "../../../../../../../crates/plugin-sdk/tests/fixtures/source-import.declaration.json"
                ).to_vec(), executable: false }),
            ]);
            change(&mut manifest, &mut files);
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let digest = PackageImage::digest(&bytes, &files).unwrap();
            let image = PackageImage::capture(bytes, files, &digest).unwrap();
            let approval = PackageApproval {
                plugin: manifest.plugin,
                package_digest: digest,
                origin: PackageOrigin {
                    source_id: "manual-local".into(),
                    publisher_id: "user-approved".into(),
                },
            };
            Self {
                directory,
                owner,
                image,
                approval,
            }
        }
        fn root(&self) -> PathBuf {
            self.directory.path().join("application/plugins")
        }
        fn request(&self) -> PluginSourceRequest {
            PluginSourceRequest {
                package: PluginPackageRequest {
                    plugin: self.approval.plugin.clone(),
                    package_digest: self.approval.package_digest.clone(),
                },
                resource_id: "source-profile".into(),
                environment_digest: request().environment_digest,
            }
        }
        fn install(&self) {
            let mut catalog = PackageCatalog::new();
            catalog
                .register(self.image.clone(), self.approval.clone())
                .unwrap();
            let mut manager = self.owner.try_manager().unwrap();
            self.owner.provision(&mut manager).unwrap();
            manager
                .store
                .as_mut()
                .unwrap()
                .install(
                    &ExecutionId::new().to_string(),
                    catalog.registered(&self.approval.plugin).unwrap(),
                    || true,
                )
                .unwrap();
        }
        fn decide(&self, enabled: bool, runtimes: Vec<RuntimeApproval>) {
            let mut manager = self.owner.try_manager().unwrap();
            self.owner.provision(&mut manager).unwrap();
            let store = manager.store.as_mut().unwrap();
            let revision = store.settings(|| true).unwrap().revision();
            store
                .update_settings(
                    revision,
                    &ExecutionId::new().to_string(),
                    &PluginSettingsUpdate {
                        packages: vec![ApprovedPackageSetting {
                            approval: self.approval.clone(),
                            enabled,
                        }],
                        runtimes,
                    },
                    || true,
                )
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.owner.close();
            self.owner.manager.lock().unwrap().store = None;
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
    fn source_install_receipt_enablement_and_resource_do_not_replace_runtime_approval() {
        let fixture = Fixture::new(|_, _| {});
        fixture.install();
        let request = fixture.request();
        assert_eq!(
            fixture
                .owner
                .capture_source(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-approval-mismatch")
        );
        fixture.decide(false, vec![]);
        assert_eq!(
            fixture
                .owner
                .capture_source(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-disabled")
        );
        fixture.decide(true, vec![]);
        let before = fs::read(fixture.root().join("settings.json")).unwrap();
        assert_eq!(
            fixture
                .owner
                .capture_source(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-approval-mismatch")
        );
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            before
        );
        assert_eq!(
            fixture.owner.inventory().unwrap().settings_revision.get(),
            2
        );
    }

    #[test]
    fn source_resolution_rejects_nonresources_changed_policy_executable_data_and_native_components()
    {
        for scenario in 0..4 {
            let fixture = Fixture::new(|manifest, files| match scenario {
                0 => {}
                1 => {
                    let file = files.get_mut("source-profile.json").unwrap();
                    let mut value: serde_json::Value = serde_json::from_slice(&file.bytes).unwrap();
                    value["checker"] = serde_json::json!("extract");
                    file.bytes = serde_json::to_vec(&value).unwrap();
                }
                2 => files.get_mut("source-profile.json").unwrap().executable = true,
                _ => {
                    manifest.components[0].runtime = sdk::RuntimeKind::NativeWorker;
                    files.get_mut("component.mjs").unwrap().executable = true;
                }
            });
            fixture.install();
            fixture.decide(true, vec![]);
            let mut request = fixture.request();
            if scenario == 0 {
                request.resource_id = "extract".into();
            }
            let error = fixture.owner.capture_source(&request).err().unwrap();
            assert_ne!(error.reason.as_deref(), Some("plugin-approval-mismatch"));
            assert!(matches!(
                error.code,
                CommandErrorCode::OutputInvalid | CommandErrorCode::InvalidInput
            ));
        }
    }

    #[cfg(all(
        feature = "bundled-runtime",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn source_registered_ipc_captures_actual_installed_runtime_and_refuses_fresh_substitution() {
        use crate::runtime_bundle;
        use tauri::{
            Manager,
            ipc::{CallbackFn, InvokeBody},
            webview::InvokeRequest,
        };
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let fixture = Fixture::with_owner(app.state::<AppState>().plugins.clone(), |_, _| {});
        fixture.install();
        let metadata: crate::runtime_bundle::BundledRuntimeMetadata =
            serde_json::from_str(runtimes::BUILT_RUNTIME.unwrap()).unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/javascript-runtime");
        let runtime = CapturedRuntime::capture_directories(
            &root.join("tool"),
            &root.join("host"),
            &metadata.environment,
            || true,
        )
        .unwrap();
        let approval = RuntimeApproval {
            environment: metadata.environment.clone(),
            origin: runtime_bundle::bundled_origin(),
        };
        let mut request = fixture.request();
        request.environment_digest = approval.environment.digest().unwrap();
        fixture.decide(true, vec![approval.clone()]);
        // Explicit approval without installed bytes is still insufficient.
        assert_eq!(
            fixture
                .owner
                .capture_source(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-runtime-missing")
        );
        {
            let mut manager = fixture.owner.try_manager().unwrap();
            manager
                .store
                .as_mut()
                .unwrap()
                .install_runtime(&ExecutionId::new().to_string(), &runtime, &approval, || {
                    true
                })
                .unwrap();
        }
        drop(runtime);
        let settings = fs::read(fixture.root().join("settings.json")).unwrap();
        let held = fixture.owner.capture_source(&request).unwrap();
        let view = held.view().unwrap();
        assert_eq!(view.extractor, held.binding.extractor);
        assert_eq!(view.checker, held.binding.checker);
        assert_eq!(
            view.extractor.provider.package_digest,
            fixture.approval.package_digest
        );
        assert_eq!(view.environment, approval.environment);
        assert_eq!(view.settings_revision.get(), 1);
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            settings
        );
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let invoke = |request: serde_json::Value| InvokeRequest {
            cmd: "read_plugin_source".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(serde_json::json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        };
        let received =
            tauri::test::get_ipc_response(&window, invoke(serde_json::to_value(&request).unwrap()))
                .unwrap()
                .deserialize::<PluginSourceView>()
                .unwrap();
        assert_eq!(received, view);
        let mut forged = serde_json::to_value(&request).unwrap();
        forged["approved"] = serde_json::json!(true);
        assert!(tauri::test::get_ipc_response(&window, invoke(forged)).is_err());
        for scenario in 0..3 {
            let mut substituted = request.clone();
            match scenario {
                0 => substituted.package.package_digest = "f".repeat(64),
                1 => substituted.environment_digest = "f".repeat(64),
                _ => substituted.resource_id = "missing".into(),
            }
            assert!(fixture.owner.capture_source(&substituted).is_err());
        }
        fixture.decide(false, vec![approval.clone()]);
        assert_eq!(
            fixture
                .owner
                .capture_source(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-disabled")
        );
        assert_eq!(held.view().unwrap(), view);
        fixture.decide(true, vec![]);
        assert_eq!(
            fixture
                .owner
                .capture_source(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-approval-mismatch")
        );
        assert_eq!(held.view().unwrap(), view);
        assert_eq!(
            fixture.owner.inventory().unwrap().settings_revision.get(),
            3
        );
        assert!(!fixture.directory.path().join("project").exists());
    }
}
