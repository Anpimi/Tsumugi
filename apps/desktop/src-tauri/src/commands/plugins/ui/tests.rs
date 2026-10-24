use super::*;
use serde_json::{Value, json};

#[test]
fn ui_wire_round_trips_exact_package_identity_and_refuses_caller_authority() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginUi.contract.json"
    ))
    .unwrap();
    let request: PluginUiRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    let view: PluginUiView = serde_json::from_value(fixture["view"].clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), fixture["request"]);
    assert_eq!(serde_json::to_value(&view).unwrap(), fixture["view"]);
    assert_eq!(view.settings_revision.get(), u64::MAX);
    assert_eq!(view.binding.capability.provider.plugin, view.package.plugin);
    assert_eq!(
        view.binding.capability.provider.package_digest,
        view.package.package_digest
    );
    assert_eq!(
        view.binding.capability.provider.component_id,
        view.component_id
    );
    for key in [
        "directory",
        "origin",
        "environmentDigest",
        "approved",
        "grantId",
        "resourceId",
        "slot",
    ] {
        let mut forged = fixture["request"].clone();
        forged[key] = true.into();
        assert!(
            serde_json::from_value::<PluginUiRequest>(forged).is_err(),
            "{key}"
        );
    }
    let mut forged = fixture["request"].clone();
    forged["package"]["approved"] = true.into();
    assert!(serde_json::from_value::<PluginUiRequest>(forged).is_err());
}

#[test]
fn invalid_ui_requests_are_refused_before_provisioning() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("application");
    let owner = ApplicationPlugins::default();
    owner.configure(root.clone()).unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginUi.contract.json"
    ))
    .unwrap();
    for scenario in 0..5 {
        let mut request: PluginUiRequest =
            serde_json::from_value(fixture["request"].clone()).unwrap();
        match scenario {
            0 => request.package.package_digest = "not-a-digest".into(),
            1 => request.package.plugin.version = "latest".into(),
            2 => request.ui_id.clear(),
            3 => request.ui_id = "x".repeat(129),
            _ => request.ui_id = "../query-panel".into(),
        }
        assert!(owner.read_ui(&request).is_err());
        assert!(!root.exists());
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod installed {
    use super::*;
    use crate::commands::plugins::environment::test_support::Fixture;
    use std::{fs, sync::Arc};
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    use tsumugi_core::execution::ExecutionId;
    use tsumugi_plugin_host::{
        ApprovedPackageSetting, PackageImage, PluginSettingsUpdate,
        catalog::{PackageApproval, PackageCatalog},
    };

    fn fixture(owner: Arc<ApplicationPlugins>) -> Fixture {
        Fixture::with_resource(
            owner,
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/tool.manifest.json"
            ),
            "tool.json",
            include_bytes!("../../../../../../../crates/plugin-sdk/tests/fixtures/tool.query.json"),
            |manifest, files| {
                manifest.contributions[3].component_id = "worker".into();
                manifest.contributions.push(sdk::ContributionDeclaration {
                    id: "query-panel".into(),
                    component_id: "worker".into(),
                    contribution: sdk::ContributionKind::Ui {
                        slot: "reference-query".into(),
                        schema: sdk::tool_declaration_contract(),
                    },
                });
                for (path, bytes) in [
                    ("terms.bin", b"terms".as_slice()),
                    (
                        "guidance.md",
                        b"Untrusted guidance grants no tools.".as_slice(),
                    ),
                ] {
                    files.insert(
                        path.into(),
                        tsumugi_plugin_host::PackageFile {
                            bytes: bytes.to_vec(),
                            executable: false,
                        },
                    );
                }
            },
        )
    }
    fn request(fixture: &Fixture) -> PluginUiRequest {
        PluginUiRequest {
            package: PluginPackageRequest {
                plugin: fixture.approval.plugin.clone(),
                package_digest: fixture.approval.package_digest.clone(),
            },
            ui_id: "query-panel".into(),
        }
    }
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
        .map(|response| response.deserialize::<Value>().unwrap())
    }

    #[test]
    fn installed_ui_requires_current_approval_and_enablement_but_no_runtime_or_execution() {
        let fixture = fixture(Arc::new(ApplicationPlugins::default()));
        fixture.install();
        let request = request(&fixture);
        assert!(
            fixture.owner.read_ui(&request).is_err(),
            "installation is not approval"
        );
        fixture.decide(false, vec![]);
        assert_eq!(
            fixture
                .owner
                .read_ui(&request)
                .unwrap_err()
                .reason
                .as_deref(),
            Some("plugin-disabled")
        );
        fixture.decide(true, vec![]);
        let before = fs::read(fixture.root().join("settings.json")).unwrap();
        let view = fixture.owner.read_ui(&request).unwrap();
        assert_eq!(view.package, request.package);
        assert_eq!(view.ui_id, request.ui_id);
        assert_eq!(view.component_id, "worker");
        assert_eq!(view.resource_id, "query-tool");
        assert_eq!(view.slot, "reference-query");
        assert_eq!(view.settings_revision.get(), 2);
        assert_eq!(
            view.binding,
            fixture.image.capability_tool("query-tool").unwrap()
        );
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            before
        );
        assert!(fixture.owner.inventory().unwrap().runtimes.is_empty());
        fixture.owner.manager.lock().unwrap().store = None;
        assert_eq!(
            fixture.owner.read_ui(&request).unwrap(),
            view,
            "reopen retains the exact package binding without activating code"
        );
        fixture.decide(false, vec![]);
        assert!(
            fixture
                .owner
                .with_environment_revision(view.settings_revision, || Ok(()))
                .is_err()
        );
        assert!(fixture.owner.read_ui(&request).is_err());
    }

    #[test]
    fn installed_ui_refuses_wrong_package_component_and_source_substitution() {
        let fixture = fixture(Arc::new(ApplicationPlugins::default()));
        fixture.install();
        fixture.decide(true, vec![]);
        let original = request(&fixture);
        for scenario in 0..4 {
            let mut request = original.clone();
            match scenario {
                0 => request.package.package_digest = "b".repeat(64),
                1 => request.package.plugin.publisher = "another-publisher".into(),
                2 => request.package.plugin.version = "0.2.0".into(),
                _ => request.ui_id = "query-tool".into(),
            }
            assert!(
                fixture.owner.read_ui(&request).is_err(),
                "scenario {scenario}"
            );
        }
        let mut manager = fixture.owner.manager.lock().unwrap();
        let store = manager.store.as_mut().unwrap();
        let mut foreign = fixture.approval.clone();
        foreign.origin.source_id = "another-source".into();
        let revision = store.settings(|| true).unwrap().revision();
        assert!(
            store
                .update_settings(
                    revision,
                    &ExecutionId::new().to_string(),
                    &PluginSettingsUpdate {
                        packages: vec![ApprovedPackageSetting {
                            approval: foreign,
                            enabled: true
                        }],
                        runtimes: vec![],
                    },
                    || true
                )
                .is_err()
        );
        drop(manager);
        assert_eq!(
            fixture.owner.read_ui(&original).unwrap().package,
            original.package
        );
    }

    #[test]
    fn registered_ui_ipc_uninstalls_only_the_original_package_and_preserves_the_other_binding() {
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .invoke_handler(crate::commands::execution::production_handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let state = app.state::<AppState>();
        let fixture = fixture(state.plugins.clone());
        fixture.install();
        let mut manifest = fixture.image.manifest().manifest().clone();
        manifest.plugin.id = "second-reference".into();
        let mut files = std::collections::BTreeMap::new();
        for contribution in &manifest.contributions {
            match &contribution.contribution {
                sdk::ContributionKind::Resource { path, schema } => {
                    files.insert(
                        path.clone(),
                        tsumugi_plugin_host::PackageFile {
                            bytes: fixture
                                .image
                                .resource_bytes(&contribution.id, schema)
                                .unwrap()
                                .to_vec(),
                            executable: false,
                        },
                    );
                }
                sdk::ContributionKind::Skill { path } => {
                    files.insert(
                        path.clone(),
                        tsumugi_plugin_host::PackageFile {
                            bytes: fixture
                                .image
                                .skill_bytes(&contribution.id)
                                .unwrap()
                                .to_vec(),
                            executable: false,
                        },
                    );
                }
                _ => {}
            }
        }
        files.insert(
            "component.mjs".into(),
            tsumugi_plugin_host::PackageFile {
                bytes: b"throw new Error('inspection must not execute');".to_vec(),
                executable: false,
            },
        );
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = PackageImage::digest(&bytes, &files).unwrap();
        let image = PackageImage::capture(bytes, files, &digest).unwrap();
        let second = PackageApproval {
            plugin: manifest.plugin,
            package_digest: digest,
            origin: fixture.approval.origin.clone(),
        };
        {
            let mut catalog = PackageCatalog::new();
            catalog.register(image, second.clone()).unwrap();
            let mut manager = state.plugins.manager.lock().unwrap();
            let store = manager.store.as_mut().unwrap();
            store
                .install(
                    &ExecutionId::new().to_string(),
                    catalog.registered(&second.plugin).unwrap(),
                    || true,
                )
                .unwrap();
            let revision = store.settings(|| true).unwrap().revision();
            store
                .update_settings(
                    revision,
                    &ExecutionId::new().to_string(),
                    &PluginSettingsUpdate {
                        packages: [fixture.approval.clone(), second.clone()]
                            .into_iter()
                            .map(|approval| ApprovedPackageSetting {
                                approval,
                                enabled: true,
                            })
                            .collect(),
                        runtimes: vec![],
                    },
                    || true,
                )
                .unwrap();
        }
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let original = request(&fixture);
        let second_request = PluginUiRequest {
            package: PluginPackageRequest {
                plugin: second.plugin,
                package_digest: second.package_digest,
            },
            ui_id: "query-panel".into(),
        };
        let first = call(&window, "read_plugin_ui", json!(original)).unwrap();
        let other = call(&window, "read_plugin_ui", json!(second_request)).unwrap();
        assert_ne!(
            first["binding"]["capability"]["provider"],
            other["binding"]["capability"]["provider"]
        );
        let inventory = state.plugins.inventory().unwrap();
        let installed = inventory
            .packages
            .iter()
            .find(|entry| entry.plugin == fixture.approval.plugin)
            .unwrap();
        let withdrawal = PluginApprovalRemovalRequest {
            package: original.package.clone(),
            origin: installed.origin.clone(),
            expected_revision: inventory.settings_revision,
            action_id: ExecutionId::new(),
        };
        let withdrawn: PluginInventoryView = serde_json::from_value(
            call(&window, "remove_plugin_approval", json!(withdrawal)).unwrap(),
        )
        .unwrap();
        assert!(call(&window, "read_plugin_ui", json!(original)).is_err());
        let removal = PluginUninstallRequest {
            package: original.package.clone(),
            origin: installed.origin.clone(),
            original_install_action: installed.original_install_action.clone(),
            expected_revision: withdrawn.settings_revision,
            action_id: ExecutionId::new(),
        };
        call(&window, "uninstall_plugin_package", json!(removal)).unwrap();
        assert!(call(&window, "read_plugin_ui", json!(original)).is_err());
        let retained = call(&window, "read_plugin_ui", json!(second_request)).unwrap();
        assert_eq!(retained["binding"], other["binding"]);
        assert_eq!(retained["package"], other["package"]);
        assert_ne!(retained["settingsRevision"], other["settingsRevision"]);
        drop(window);
        drop(state);
        drop(fixture);
        drop(app);
    }
}
