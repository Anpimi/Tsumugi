use super::*;
use crate::commands::plugins::PluginPackageRequest;
use std::sync::atomic::{AtomicBool, Ordering};
use tsumugi_plugin_sdk as sdk;

fn package(name: &str) -> PluginPackageRequest {
    PluginPackageRequest {
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: name.into(),
            version: "0.1.0".into(),
        },
        package_digest: "a".repeat(64),
    }
}
fn binding(package: &PluginPackageRequest) -> PluginExecutionBinding {
    let contract = |id: &str| sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    };
    PluginExecutionBinding {
        component_scope: tsumugi_plugin_sdk::ComponentScope::Project,
        capability: sdk::CapabilityBinding {
            provider: sdk::ProviderSelectionBinding {
                plugin: package.plugin.clone(),
                component_id: "worker".into(),
                contribution_id: "call".into(),
                package_digest: package.package_digest.clone(),
            },
            declaration: sdk::CapabilityDeclaration {
                contract: contract("example.call"),
                input_schema: contract("example.input"),
                output_schema: contract("example.output"),
                error_schema: contract("example.error"),
                profiles: vec![],
                effect: sdk::EffectKind::ReadOnly,
                permissions: vec![sdk::PermissionRequest::CapturedInput],
                limits: sdk::CapabilityLimits {
                    max_input_bytes: 4096,
                    max_output_bytes: 4096,
                    concurrency: 1,
                    timeout_ms: 1000,
                },
            },
        },
        profile: None,
        environment: sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: sdk::RuntimePlatform {
                operating_system: sdk::RuntimeOperatingSystem::Macos,
                architecture: sdk::RuntimeArchitecture::Aarch64,
            },
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: "b".repeat(64),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: "c".repeat(64),
                entrypoint: "dist/main.js".into(),
            },
        }
        .into(),
    }
}
struct QueryCall {
    release: mpsc::Sender<()>,
    request: DispatchRequest,
}
struct QueryRunner {
    binding: PluginExecutionBinding,
    calls: mpsc::Sender<QueryCall>,
}
impl Runner for QueryRunner {
    fn capability_id(&self) -> &str {
        "example.call"
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.binding.environment)
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        Ok(())
    }
    fn query(&self, request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        let (release, wait) = mpsc::channel();
        self.calls
            .send(QueryCall {
                release,
                request: request.clone(),
            })
            .unwrap();
        let _ = wait.recv();
        Ok(QueryOutcome::Unavailable)
    }
}
fn plugin_input(store: &ProjectStore, binding: PluginExecutionBinding) -> FixedInput {
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "fixture",
        "example.call",
        "1:1",
        vec![InputItem::new(
            Scope {
                kind: "fixture".into(),
                id: "a".into(),
                locale: None,
            },
            json!("captured"),
            vec![],
        )],
    )
    .unwrap();
    envelope.plugin = Some(binding);
    FixedInput::capture(envelope).unwrap()
}
fn finish(app: &tauri::App<tauri::test::MockRuntime>, action: ExecutionId) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = app.state::<AppState>().sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.finish_package_cleanup(store, action)
        });
        match result {
            Ok(()) => return,
            Err(error) if error.code == CommandErrorCode::Busy => {
                assert!(Instant::now() < deadline, "package owner did not drain");
                std::thread::yield_now();
            }
            Err(error) => panic!("unexpected cleanup error: {error:?}"),
        }
    }
}

#[test]
fn package_queries_drain_independently_and_installation_handoff_keeps_session_fenced() {
    let (_temp, app, webview, context) = setup();
    let a = package("example.target");
    let b = package("example.independent");
    let (calls_tx, calls) = mpsc::channel();
    let ca = a.clone();
    let cb = b.clone();
    let (action, generation, attempts) = app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let mut attempts = Vec::new();
        for package in [&ca, &cb] {
            let binding = binding(package);
            host.runtime
                .register_read_only(Arc::new(QueryRunner {
                    binding: binding.clone(),
                    calls: calls_tx.clone(),
                }))
                .unwrap();
            host.plugin_registrations.push(binding.clone());
            let input = plugin_input(store, binding);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            host.runtime
                .authorize_plugin(
                    store,
                    ExecutionId::new(),
                    &input,
                    now + 60_000,
                    PluginConsent {
                        unsandboxed_execution: true,
                    },
                )
                .unwrap();
            host.runtime.submit(store, &input).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while store
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap()
                .progress
                .unknown
                != 1
            {
                host.runtime.tick(store).unwrap();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            let query = loop {
                match host.runtime.outcome_query(
                    store,
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                ) {
                    Ok(Some(query)) => break Arc::new(query),
                    Err(error) if error.code == ErrorCode::Busy => {
                        host.runtime.tick(store).unwrap();
                        assert!(Instant::now() < deadline, "producer did not release");
                        std::thread::yield_now();
                    }
                    Ok(None) => panic!("unknown result has no query"),
                    Err(error) => panic!("unexpected query capture error: {error:?}"),
                }
            };
            let worker = query.clone();
            let (sender, receiver) = mpsc::channel();
            let thread = std::thread::spawn(move || {
                let _ = sender.send(worker.run());
            });
            host.queries.push(QueryJob {
                query,
                receiver,
                thread,
                started: Instant::now(),
                pending_outcome: None,
            });
            attempts.push(input.envelope().attempt_id);
        }
        (ExecutionId::new(), host.runtime.generation(), attempts)
    });
    let entered: Vec<_> = (0..2)
        .map(|_| calls.recv_timeout(Duration::from_secs(5)).unwrap())
        .collect();
    let mut by_attempt: BTreeMap<_, _> = entered
        .into_iter()
        .map(|call| (call.request.input.envelope().attempt_id, call))
        .collect();
    let target = by_attempt.remove(&attempts[0]).unwrap();
    let independent = by_attempt.remove(&attempts[1]).unwrap();
    let selected = a.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.begin_package_cleanup(store, action, selected).unwrap();
        assert_eq!(
            host.finish_package_cleanup(store, action).unwrap_err().code,
            CommandErrorCode::Busy
        );
        assert_eq!(host.queries.len(), 1);
        assert_eq!(host.retired_queries.len(), 1);
        assert!(
            host.queries[0]
                .query
                .request
                .plugin_permit()
                .unwrap()
                .is_authorized()
        );
        assert_eq!(host.runtime.generation(), generation);
    });
    assert!(!target.request.plugin_permit().unwrap().is_authorized());
    assert!(independent.request.plugin_permit().unwrap().is_authorized());
    assert_eq!(
        call(&webview, "quiesce_execution", context.clone()).unwrap_err()["code"],
        "busy"
    );
    target.release.send(()).unwrap();
    finish(&app, action); // Independent query is deliberately still held.
    let ca = a.clone();
    let cb = b.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(host.active(store).unwrap());
        assert_eq!(host.runtime.generation(), generation);
        assert!(host.allow_package(&ca).is_err());
        assert!(host.allow_package(&cb).is_ok());
        assert_eq!(host.plugin_registrations.len(), 1);
        assert_eq!(
            host.plugin_registrations[0].capability.provider.plugin,
            cb.plugin
        );
        assert_eq!(
            host.begin_quiesce(store).unwrap_err().code,
            CommandErrorCode::Busy
        );
        host.complete_package_cleanup(action).unwrap();
        let fresh = host.begin_package_work(vec![ca.clone()]).unwrap();
        host.begin_package_cleanup(store, action, ca).unwrap(); // Original completed receipt is inert.
        fresh.check().unwrap();
        assert_eq!(host.runtime.generation(), generation);
    });
    independent.release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&webview, "execution_status", context.clone()).unwrap()["active"] == true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    call(
        &webview,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
}

#[test]
fn accepted_io_guard_survives_waiter_loss_and_cannot_publish_after_package_stop() {
    let (_temp, app, webview, context) = setup();
    let a = package("example.target");
    let ca = a.clone();
    let work = app.state::<AppState>().sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .begin_package_work(vec![ca])
            .unwrap()
    });
    let io = app.state::<AppState>().io.clone();
    let (entered, seen) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let published = Arc::new(AtomicBool::new(false));
    let observation = published.clone();
    let waiter = tauri::async_runtime::spawn(async move {
        io.run(CommandStage::ExecutionRead, move || {
            work.check()?;
            entered.send(()).unwrap();
            let _ = wait.recv();
            work.check()?;
            observation.store(true, Ordering::Release);
            Ok(())
        })
        .await
    });
    seen.recv_timeout(Duration::from_secs(5)).unwrap();
    waiter.abort(); // Only the IPC-side wait is gone; accepted blocking IO remains owned.
    let action = ExecutionId::new();
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.begin_package_cleanup(store, action, a).unwrap();
        assert_eq!(
            host.finish_package_cleanup(store, action).unwrap_err().code,
            CommandErrorCode::Busy
        );
        assert!(host.package_work_active());
    });
    assert_eq!(
        call(
            &webview,
            "close_project",
            json!({"sessionToken":context["sessionToken"]})
        )
        .unwrap_err()["code"],
        "busy"
    );
    release.send(()).unwrap();
    finish(&app, action);
    assert!(!published.load(Ordering::Acquire));
    app.state::<AppState>().sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .complete_package_cleanup(action)
            .unwrap()
    });
    call(
        &webview,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
}

#[test]
fn storage_busy_keeps_original_action_fence_and_global_stop_waits_for_accepted_io() {
    let (temp, app, webview, context) = setup();
    let a = package("example.target");
    let ca = a.clone();
    // Persist a real idle permit so scoped revocation must obtain a SQLite write lock.
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let (tx, _) = mpsc::channel();
        let selected = binding(&ca);
        host.runtime
            .register_read_only(Arc::new(QueryRunner {
                binding: selected.clone(),
                calls: tx,
            }))
            .unwrap();
        let fixed = plugin_input(store, selected);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        host.runtime
            .authorize_plugin(
                store,
                ExecutionId::new(),
                &fixed,
                now + 60_000,
                PluginConsent {
                    unsandboxed_execution: true,
                },
            )
            .unwrap();
    });
    let connection =
        rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    let action = ExecutionId::new();
    let ca = a.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert_eq!(
            host.begin_package_cleanup(store, action, ca.clone())
                .unwrap_err()
                .code,
            CommandErrorCode::Busy
        );
        assert!(host.begin_package_work(vec![ca]).is_err());
        assert_eq!(
            host.complete_package_cleanup(action).unwrap_err().code,
            CommandErrorCode::Busy
        );
        assert_eq!(
            host.begin_package_cleanup(store, action, package("example.other"))
                .unwrap_err()
                .code,
            CommandErrorCode::ResultMismatch
        );
    });
    connection.execute_batch("ROLLBACK").unwrap();
    finish(&app, action);
    app.state::<AppState>().sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .complete_package_cleanup(action)
            .unwrap()
    });
    let work = app.state::<AppState>().sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .begin_package_work(vec![a])
            .unwrap()
    });
    let generation = app.state::<AppState>().sessions.with(|sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .runtime
            .generation()
    });
    assert_eq!(
        call(&webview, "quiesce_execution", context.clone()).unwrap()["quiescing"],
        true
    );
    assert!(work.check().is_err());
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert_eq!(
            host.finish_quiesce(store).unwrap_err().code,
            ErrorCode::Busy
        );
        assert_eq!(host.runtime.generation(), generation);
    });
    drop(work);
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&webview, "execution_status", context.clone()).unwrap()["active"] == true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn registered_uninstall_waits_for_original_target_query_without_stopping_independent_package() {
    use crate::commands::plugins::{
        PluginInventoryView, PluginObjectState, PluginUninstallRequest, packages::MutationRequest,
    };
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};
    use tsumugi_plugin_host::{
        ApprovedPackageSetting, PackageFile, PackageImage, PackageStore, PluginSettingsUpdate,
        catalog::{PackageApproval, PackageCatalog, PackageOrigin},
    };

    struct OwnedPackages(tempfile::TempDir);
    impl Drop for OwnedPackages {
        fn drop(&mut self) {
            fn removable(path: &Path) {
                if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                    for entry in fs::read_dir(path).unwrap() {
                        removable(&entry.unwrap().path());
                    }
                }
            }
            removable(self.0.path());
        }
    }

    let owned = OwnedPackages(tempfile::tempdir().unwrap());
    let application = owned.0.path().join("application");
    let root = application.join("plugins");
    let mut package_store =
        PackageStore::provision(owned.0.path(), &["application", "plugins"], || true).unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginPackage.contract.json"
    ))
    .unwrap();
    let mut catalog = PackageCatalog::new();
    let mut receipts = Vec::new();
    let mut approvals = Vec::new();
    for id in ["installed-target", "installed-independent"] {
        let mut manifest: sdk::PluginManifest =
            serde_json::from_value(fixture["manifest"].clone()).unwrap();
        manifest.plugin.id = id.into();
        manifest.contributions[0].id = "call".into();
        let declaration = match &mut manifest.contributions[0].contribution {
            sdk::ContributionKind::Capability { declaration } => {
                declaration.contract.id = "example.call".into();
                declaration.limits.max_input_bytes = 4096;
                declaration.clone()
            }
            _ => panic!("fixture must declare the controlled query capability"),
        };
        // Installation never executes this JavaScript. The in-flight query
        // below is a real, controlled Rust Runner, not a Node/native process.
        let files = BTreeMap::from([(
            "worker.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('controlled installation must not execute');".to_vec(),
                executable: false,
            },
        )]);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = PackageImage::digest(&bytes, &files).unwrap();
        let image = PackageImage::capture(bytes, files, &digest).unwrap();
        let approval = PackageApproval {
            plugin: manifest.plugin,
            package_digest: digest,
            origin: PackageOrigin {
                source_id: "synthetic-approved-source".into(),
                publisher_id: "synthetic-approved-key".into(),
            },
        };
        catalog.register(image, approval.clone()).unwrap();
        let receipt = package_store
            .install(
                &ExecutionId::new().to_string(),
                catalog.registered(&approval.plugin).unwrap(),
                || true,
            )
            .unwrap();
        let actual = PluginPackageRequest {
            plugin: receipt.plugin().clone(),
            package_digest: receipt.package_digest().into(),
        };
        assert_eq!(binding(&actual).capability.declaration, declaration);
        receipts.push(receipt);
        approvals.push(approval);
    }
    package_store
        .update_settings(
            0,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: approvals
                    .iter()
                    .map(|approval| ApprovedPackageSetting {
                        approval: approval.clone(),
                        enabled: true,
                    })
                    .collect(),
                runtimes: vec![],
            },
            || true,
        )
        .unwrap();
    let a = PluginPackageRequest {
        plugin: receipts[0].plugin().clone(),
        package_digest: receipts[0].package_digest().into(),
    };
    let b = PluginPackageRequest {
        plugin: receipts[1].plugin().clone(),
        package_digest: receipts[1].package_digest().into(),
    };
    assert_ne!(a.package_digest, b.package_digest);
    let a_object = root.join("objects").join(&a.package_digest);
    let b_object = root.join("objects").join(&b.package_digest);
    let independent_bytes = fs::read(b_object.join("package/worker.mjs")).unwrap();
    let (_temp, app, webview, context) = setup();
    let (calls_tx, calls) = mpsc::channel();
    let ca = a.clone();
    let cb = b.clone();
    let (generation, attempts) = app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let mut attempts = Vec::new();
        for package in [&ca, &cb] {
            let binding = binding(package);
            host.runtime
                .register_read_only(Arc::new(QueryRunner {
                    binding: binding.clone(),
                    calls: calls_tx.clone(),
                }))
                .unwrap();
            host.plugin_registrations.push(binding.clone());
            let input = plugin_input(store, binding);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            host.runtime
                .authorize_plugin(
                    store,
                    ExecutionId::new(),
                    &input,
                    now + 60_000,
                    PluginConsent {
                        unsandboxed_execution: true,
                    },
                )
                .unwrap();
            host.runtime.submit(store, &input).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while store
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap()
                .progress
                .unknown
                != 1
            {
                host.runtime.tick(store).unwrap();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            let query = loop {
                match host.runtime.outcome_query(
                    store,
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                ) {
                    Ok(Some(query)) => break Arc::new(query),
                    Err(error) if error.code == ErrorCode::Busy => {
                        host.runtime.tick(store).unwrap();
                        assert!(
                            Instant::now() < deadline,
                            "original producer did not release"
                        );
                        std::thread::yield_now();
                    }
                    Ok(None) => panic!("unknown result has no original query"),
                    Err(error) => panic!("unexpected query capture error: {error:?}"),
                }
            };
            let worker = query.clone();
            let (sender, receiver) = mpsc::channel();
            let thread = std::thread::spawn(move || {
                let _ = sender.send(worker.run());
            });
            host.queries.push(QueryJob {
                query,
                receiver,
                thread,
                started: Instant::now(),
                pending_outcome: None,
            });
            attempts.push(input.envelope().attempt_id);
        }
        (host.runtime.generation(), attempts)
    });
    let mut by_attempt: BTreeMap<_, _> = (0..2)
        .map(|_| {
            let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
            (call.request.input.envelope().attempt_id, call)
        })
        .collect();
    let target = by_attempt.remove(&attempts[0]).unwrap();
    let independent = by_attempt.remove(&attempts[1]).unwrap();
    assert!(target.request.plugin_permit().unwrap().is_authorized());
    assert!(independent.request.plugin_permit().unwrap().is_authorized());

    // The separate trusted settings owner withdraws A after these original
    // execution/query handles were captured. This test exercises uninstall's
    // drain connection, not the approval-removal command's already tested flow.
    let withdrawal = ExecutionId::new();
    let withdrawn = package_store
        .update_settings(
            1,
            &withdrawal.to_string(),
            &PluginSettingsUpdate {
                packages: vec![ApprovedPackageSetting {
                    approval: approvals[1].clone(),
                    enabled: true,
                }],
                runtimes: vec![],
            },
            || true,
        )
        .unwrap();
    drop(package_store);
    app.state::<AppState>()
        .plugins
        .configure(application)
        .unwrap();
    let before: PluginInventoryView =
        serde_json::from_value(call(&webview, "read_plugin_inventory", json!({})).unwrap())
            .unwrap();
    assert_eq!(before.packages.len(), 2);
    assert_eq!(before.settings_revision, withdrawn.revision().into());
    assert_eq!(before.last_settings_action, Some(withdrawal.to_string()));
    assert_eq!(before.package_decisions.len(), 1);
    assert_eq!(before.package_decisions[0].plugin, b.plugin);
    assert_eq!(before.package_decisions[0].package_digest, b.package_digest);
    assert!(before.package_decisions[0].enabled);
    let original_target = before
        .packages
        .iter()
        .find(|package| package.package_digest == a.package_digest)
        .unwrap()
        .clone();
    let original_independent = before
        .packages
        .iter()
        .find(|package| package.package_digest == b.package_digest)
        .unwrap()
        .clone();
    let request = PluginUninstallRequest {
        package: a.clone(),
        origin: receipts[0].origin().into(),
        original_install_action: receipts[0].action_id().into(),
        expected_revision: withdrawn.revision().into(),
        action_id: ExecutionId::new(),
    };
    assert_ne!(request.action_id, withdrawal);
    let original = MutationRequest::Uninstall(request.clone());
    let held = call(&webview, "uninstall_plugin_package", json!(&request)).unwrap_err();
    assert_eq!(held["code"], "busy");
    assert_eq!(held["reason"], "package-lifecycle-active");
    assert_eq!(held["recoveryRequired"], true);
    assert_eq!(held["recoveryGuidance"], "reconcile-original");
    assert!(a_object.exists());
    assert!(
        !root
            .join("uninstalls")
            .join(request.action_id.to_string())
            .exists()
    );
    assert!(!target.request.plugin_permit().unwrap().is_authorized());
    assert!(independent.request.plugin_permit().unwrap().is_authorized());
    let ca = a.clone();
    let cb = b.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        assert!(sessions.package_operation.as_ref().unwrap().request == original);
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert_eq!(host.runtime.generation(), generation);
        assert_eq!(host.retired_queries.len(), 1);
        assert!(!host.retired_queries[0].thread.is_finished());
        assert_eq!(host.queries.len(), 1);
        assert!(super::super::package_lifecycle::matches_input(
            &cb,
            &host.queries[0].query.request.input
        ));
        assert!(host.allow_package(&ca).is_err());
        assert!(host.allow_package(&cb).is_ok());
    });
    assert_eq!(
        call(&webview, "quiesce_execution", context.clone()).unwrap_err()["code"],
        "busy"
    );
    assert_eq!(
        call(
            &webview,
            "close_project",
            json!({"sessionToken": context["sessionToken"]})
        )
        .unwrap_err()["code"],
        "busy"
    );
    let still_installed: PluginInventoryView =
        serde_json::from_value(call(&webview, "read_plugin_inventory", json!({})).unwrap())
            .unwrap();
    assert_eq!(still_installed, before);

    target.release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let removed: PluginInventoryView = loop {
        match call(&webview, "uninstall_plugin_package", json!(&request)) {
            Ok(view) => break serde_json::from_value(view).unwrap(),
            Err(error) if error["code"] == "busy" => {
                assert!(
                    Instant::now() < deadline,
                    "original query owner did not drain"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("exact uninstall recovery failed: {error}"),
        }
    };
    assert!(!a_object.exists());
    assert!(b_object.exists());
    assert_eq!(
        fs::read(b_object.join("package/worker.mjs")).unwrap(),
        independent_bytes
    );
    assert_eq!(removed.settings_revision, before.settings_revision);
    assert_eq!(removed.last_settings_action, before.last_settings_action);
    assert_eq!(removed.package_decisions, before.package_decisions);
    assert_eq!(removed.packages.len(), 1);
    assert_eq!(removed.packages[0], original_independent);
    assert_eq!(
        removed.packages[0].original_install_action,
        receipts[1].action_id()
    );
    assert_eq!(removed.uninstallations.len(), 1);
    assert_eq!(
        removed.uninstallations[0].action_id,
        request.action_id.to_string()
    );
    assert_eq!(
        removed.uninstallations[0]
            .installation
            .original_install_action,
        request.original_install_action
    );
    assert_eq!(removed.uninstallations[0].state, PluginObjectState::Sealed);
    assert_eq!(removed.uninstallations[0].installation, original_target);
    assert_eq!(
        removed.uninstallations[0].settings_revision,
        request.expected_revision
    );
    assert!(independent.request.plugin_permit().unwrap().is_authorized());
    let cb = b.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        assert!(sessions.package_operation.is_none());
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(host.active(store).unwrap());
        assert_eq!(host.runtime.generation(), generation);
        assert!(host.retired_queries.is_empty());
        assert_eq!(host.queries.len(), 1);
        assert!(super::super::package_lifecycle::matches_input(
            &cb,
            &host.queries[0].query.request.input
        ));
        assert_eq!(host.plugin_registrations.len(), 1);
        assert_eq!(
            host.plugin_registrations[0].capability.provider.plugin,
            cb.plugin
        );
        assert!(host.allow_package(&cb).is_ok());
    });
    independent.release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while call(&webview, "execution_status", context.clone()).unwrap()["active"] == true {
        assert!(
            Instant::now() < deadline,
            "independent query owner did not join"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    call(
        &webview,
        "close_project",
        json!({"sessionToken": context["sessionToken"]}),
    )
    .unwrap();
}
