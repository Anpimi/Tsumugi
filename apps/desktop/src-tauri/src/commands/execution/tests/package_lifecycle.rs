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
