use super::*;

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginBuild.contract.json"
    ))
    .unwrap()
}
fn request() -> PluginBuildRequest {
    serde_json::from_value(fixture()["request"].clone()).unwrap()
}

#[test]
fn build_wire_fixture_keeps_recipe_providers_and_runtime_separate_from_authority() {
    let fixture = fixture();
    let view: PluginBuildView = serde_json::from_value(fixture["view"].clone()).unwrap();
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
        assert!(serde_json::from_value::<PluginBuildRequest>(forged).is_err());
    }
    let mut forged = fixture["request"].clone();
    forged["package"]["approved"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PluginBuildRequest>(forged).is_err());
}

#[test]
fn invalid_build_choices_do_not_provision_and_closed_or_busy_owner_refuses() {
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
        assert!(owner.capture_build(&request).is_err());
        assert!(!root.exists());
    }
    let held = owner.manager.lock().unwrap();
    assert_eq!(
        owner.capture_build(&request()).err().unwrap().code,
        CommandErrorCode::Busy
    );
    drop(held);
    owner.close();
    assert_eq!(
        owner.capture_build(&request()).err().unwrap().code,
        CommandErrorCode::Cancelled
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
    use super::*;
    use crate::commands::plugins::environment::test_support::Fixture;
    use std::{collections::BTreeMap, fs, sync::Arc};
    use tsumugi_core::execution::ExecutionId;
    use tsumugi_plugin_host::{CapturedRuntime, PackageFile, RuntimeApproval};

    fn installed(
        owner: Arc<ApplicationPlugins>,
        change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
    ) -> Fixture {
        Fixture::with_resource(
            owner,
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/build.manifest.json"
            ),
            "build-profile.json",
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/build.declaration.json"
            ),
            change,
        )
    }
    fn selected(fixture: &Fixture) -> PluginBuildRequest {
        PluginBuildRequest {
            package: fixture.request().package,
            resource_id: "build-profile".into(),
            environment_digest: request().environment_digest,
        }
    }

    #[test]
    fn build_install_enablement_and_runtime_approval_are_independent() {
        let fixture = installed(Arc::new(ApplicationPlugins::default()), |_, _| {});
        fixture.install();
        let request = selected(&fixture);
        assert_eq!(
            fixture
                .owner
                .capture_build(&request)
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
                .capture_build(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-disabled")
        );
        fixture.decide(true, vec![]);
        let settings = fs::read(fixture.root().join("settings.json")).unwrap();
        assert_eq!(
            fixture
                .owner
                .capture_build(&request)
                .err()
                .unwrap()
                .reason
                .as_deref(),
            Some("plugin-approval-mismatch")
        );
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            settings
        );
        assert_eq!(
            fixture.owner.inventory().unwrap().settings_revision.get(),
            2
        );
    }

    #[test]
    fn build_resource_refuses_wrong_contract_self_checking_executable_data_and_native_runtime() {
        for scenario in 0..6 {
            let fixture = installed(
                Arc::new(ApplicationPlugins::default()),
                |manifest, files| {
                    match scenario {
                        0 | 1 => {}
                        2 => {
                            let file = files.get_mut("build-profile.json").unwrap();
                            let mut value: serde_json::Value =
                                serde_json::from_slice(&file.bytes).unwrap();
                            value["checker"] = serde_json::json!("build");
                            file.bytes = serde_json::to_vec(&value).unwrap();
                        }
                        3 => files.get_mut("build-profile.json").unwrap().executable = true,
                        4 => {
                            let sdk::ContributionKind::Resource { schema, .. } =
                                &mut manifest.contributions[0].contribution
                            else {
                                unreachable!()
                            };
                            schema.behavior_version += 1;
                        }
                        _ => {
                            // The independent checker cannot borrow a JavaScript
                            // runtime approval when its actual component is native.
                            let mut component = manifest.components[0].clone();
                            component.id = "native-checker".into();
                            component.runtime = sdk::RuntimeKind::NativeWorker;
                            component.entrypoint = Some("checker.bin".into());
                            manifest.components.push(component);
                            manifest.contributions[2].component_id = "native-checker".into();
                            files.insert(
                                "checker.bin".into(),
                                PackageFile {
                                    bytes: b"not executed".to_vec(),
                                    executable: true,
                                },
                            );
                        }
                    }
                },
            );
            fixture.install();
            fixture.decide(true, vec![]);
            let mut request = selected(&fixture);
            if scenario == 0 {
                request.resource_id = "build".into();
            }
            if scenario == 1 {
                request.resource_id = "missing".into();
            }
            let error = fixture.owner.capture_build(&request).err().unwrap();
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
    fn build_registered_ipc_captures_installed_runtime_and_preserves_fixed_bytes_after_revocation()
    {
        use tauri::{
            Manager,
            ipc::{CallbackFn, InvokeBody},
            webview::InvokeRequest,
        };
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let fixture = installed(app.state::<AppState>().plugins.clone(), |_, _| {});
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
        let mut request = selected(&fixture);
        request.environment_digest = approval.environment.digest().unwrap();
        fixture.decide(true, vec![approval.clone()]);
        assert_eq!(
            fixture
                .owner
                .capture_build(&request)
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
        let held = fixture.owner.capture_build(&request).unwrap();
        let view = held.view().unwrap();
        assert_eq!(view.builder, held.binding.builder);
        assert_eq!(view.checker, held.binding.checker);
        assert_ne!(view.builder.provider, view.checker.provider);
        assert_eq!(
            view.builder.provider.package_digest,
            fixture.approval.package_digest
        );
        assert_eq!(&view.environment, approval.captured_environment().unwrap());
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
            cmd: "read_plugin_build".into(),
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
                .deserialize::<PluginBuildView>()
                .unwrap();
        assert_eq!(received, view);
        let mut forged = serde_json::to_value(&request).unwrap();
        forged["grantId"] = serde_json::json!(ExecutionId::new());
        assert!(tauri::test::get_ipc_response(&window, invoke(forged)).is_err());
        for scenario in 0..4 {
            let mut substituted = request.clone();
            match scenario {
                0 => substituted.package.package_digest = "f".repeat(64),
                1 => substituted.environment_digest = "f".repeat(64),
                2 => substituted.resource_id = "missing".into(),
                _ => substituted.resource_id = "build".into(),
            }
            assert!(fixture.owner.capture_build(&substituted).is_err());
        }
        // A fresh manager must reopen the installed bytes and approvals. A
        // held snapshot is not used as a fallback for a fresh request.
        // The managed Store has one exclusive owner. Release that test-owned
        // handle before verifying a genuinely reopened manager.
        fixture.owner.manager.lock().unwrap().store = None;
        let reopened = ApplicationPlugins::default();
        reopened
            .configure(fixture.directory.path().join("application"))
            .unwrap();
        assert_eq!(
            reopened.capture_build(&request).unwrap().view().unwrap(),
            view
        );
        reopened.manager.lock().unwrap().store = None;
        fixture.decide(false, vec![approval.clone()]);
        assert_eq!(
            fixture
                .owner
                .capture_build(&request)
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
                .capture_build(&request)
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
        reopened.close();
        reopened.manager.lock().unwrap().store = None;
        assert!(!fixture.directory.path().join("project").exists());
    }
}
