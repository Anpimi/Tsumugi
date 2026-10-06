use super::*;

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginTranslation.contract.json"
    ))
    .unwrap()
}

#[test]
fn translation_wire_observation_cannot_supply_paths_or_execution_authority() {
    let fixture = fixture();
    let view: PluginTranslationView = serde_json::from_value(fixture["view"].clone()).unwrap();
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
        assert!(serde_json::from_value::<PluginTranslationRequest>(forged).is_err());
    }
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("application");
    let owner = ApplicationPlugins::default();
    owner.configure(root.clone()).unwrap();
    for scenario in 0..5 {
        let mut request: PluginTranslationRequest =
            serde_json::from_value(fixture["request"].clone()).unwrap();
        match scenario {
            0 => request.package.package_digest = "not-a-digest".into(),
            1 => request.environment_digest = "not-a-digest".into(),
            2 => request.package.plugin.version = "latest".into(),
            3 => request.resource_id.clear(),
            _ => request.resource_id = "x".repeat(129),
        }
        assert!(owner.capture_translation(&request).is_err());
        assert!(!root.exists());
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
    use super::*;
    use crate::commands::plugins::environment::test_support::Fixture;
    use std::{collections::BTreeMap, fs, sync::Arc};
    use tsumugi_plugin_host::PackageFile;

    fn installed_fixture(
        owner: Arc<ApplicationPlugins>,
        change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
    ) -> Fixture {
        Fixture::with_resource(
            owner,
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.manifest.json"
            ),
            "translation-profile.json",
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.declaration.json"
            ),
            change,
        )
    }
    fn request(fixture: &Fixture) -> PluginTranslationRequest {
        let source = fixture.request();
        PluginTranslationRequest {
            package: source.package,
            resource_id: "translation-profile".into(),
            environment_digest: source.environment_digest,
        }
    }

    #[test]
    fn translation_package_enablement_and_resource_do_not_replace_runtime_approval() {
        let fixture = installed_fixture(Arc::new(ApplicationPlugins::default()), |_, _| {});
        fixture.install();
        let request = request(&fixture);
        assert_eq!(
            fixture
                .owner
                .capture_translation(&request)
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
                .capture_translation(&request)
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
                .capture_translation(&request)
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
    }

    #[test]
    fn translation_resolution_refuses_nonresources_changed_checker_executable_data_and_native_worker()
     {
        for scenario in 0..4 {
            let fixture = installed_fixture(
                Arc::new(ApplicationPlugins::default()),
                |manifest, files| match scenario {
                    0 => {}
                    1 => {
                        let file = files.get_mut("translation-profile.json").unwrap();
                        let mut value: serde_json::Value =
                            serde_json::from_slice(&file.bytes).unwrap();
                        value["checker"] = serde_json::json!("extract");
                        file.bytes = serde_json::to_vec(&value).unwrap();
                    }
                    2 => {
                        files
                            .get_mut("translation-profile.json")
                            .unwrap()
                            .executable = true
                    }
                    _ => {
                        manifest.components[0].runtime = sdk::RuntimeKind::NativeWorker;
                        files.get_mut("component.mjs").unwrap().executable = true;
                    }
                },
            );
            fixture.install();
            fixture.decide(true, vec![]);
            let mut request = request(&fixture);
            if scenario == 0 {
                request.resource_id = "extract".into();
            }
            let error = fixture.owner.capture_translation(&request).err().unwrap();
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
    fn translation_registered_ipc_reads_exact_installed_environment_without_running_or_restoring_authority()
     {
        use tauri::{
            Manager,
            ipc::{CallbackFn, InvokeBody},
            webview::InvokeRequest,
        };
        use tsumugi_core::execution::ExecutionId;
        use tsumugi_plugin_host::{CapturedRuntime, RuntimeApproval};
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let fixture = installed_fixture(app.state::<AppState>().plugins.clone(), |_, _| {});
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
            environment: metadata.environment.clone().into(),
            origin: crate::runtime_bundle::bundled_origin(),
        };
        let mut request = request(&fixture);
        request.environment_digest = approval.environment.digest().unwrap();
        fixture.decide(true, vec![approval.clone()]);
        assert_eq!(
            fixture
                .owner
                .capture_translation(&request)
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
        let held = fixture.owner.capture_translation(&request).unwrap();
        let view = held.view().unwrap();
        assert_eq!(view.extractor, held.binding.extractor);
        assert_eq!(view.checker, held.binding.checker);
        assert_ne!(
            view.extractor.provider.contribution_id,
            view.checker.provider.contribution_id
        );
        assert_eq!(
            view.extractor.provider.package_digest,
            fixture.approval.package_digest
        );
        assert_eq!(&view.environment, approval.captured_environment().unwrap());
        assert_eq!(view.settings_revision.get(), 1);
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let invoke = |request: serde_json::Value| InvokeRequest {
            cmd: "read_plugin_translation".into(),
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
                .deserialize::<PluginTranslationView>()
                .unwrap();
        assert_eq!(received, view);
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            settings
        );
        let mut forged = serde_json::to_value(&request).unwrap();
        forged["grantId"] = serde_json::json!("untrusted");
        assert!(tauri::test::get_ipc_response(&window, invoke(forged)).is_err());
        for scenario in 0..3 {
            let mut substituted = request.clone();
            match scenario {
                0 => substituted.package.package_digest = "f".repeat(64),
                1 => substituted.environment_digest = "f".repeat(64),
                _ => substituted.resource_id = "missing".into(),
            }
            assert!(fixture.owner.capture_translation(&substituted).is_err());
        }
        fixture.decide(false, vec![approval.clone()]);
        assert!(
            tauri::test::get_ipc_response(&window, invoke(serde_json::to_value(&request).unwrap()))
                .is_err()
        );
        assert_eq!(
            held.view().unwrap(),
            view,
            "saved observations do not obtain fresh permission"
        );
    }
}
