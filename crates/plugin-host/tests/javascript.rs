#![cfg(all(unix, feature = "javascript-conformance"))]
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk::*;
#[path = "support/runtime.rs"]
mod runtime_fixture;
fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn image(mode: &str) -> PackageImage {
    image_with_observer(mode, None)
}
fn image_with_observer(mode: &str, observer: Option<&std::path::Path>) -> PackageImage {
    scoped_image(mode, observer, ComponentScope::Project)
}
fn scoped_image(
    mode: &str,
    observer: Option<&std::path::Path>,
    scope: ComponentScope,
) -> PackageImage {
    scoped_image_with(mode, observer, scope, |_| {})
}
fn scoped_image_with(
    mode: &str,
    observer: Option<&std::path::Path>,
    scope: ComponentScope,
    mutate: impl FnOnce(&mut PluginManifest),
) -> PackageImage {
    let mut manifest = PluginManifest {
        protocol_version: MANIFEST_PROTOCOL,
        plugin: PluginIdentity {
            publisher: "example".into(),
            id: "example.query".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![PermissionRequest::CapturedInput],
        components: vec![ComponentDeclaration {
            id: "query".into(),
            scope,
            runtime: RuntimeKind::JavaScript,
            entrypoint: Some("component.mjs".into()),
            dependencies: vec![],
            exit: ExitRequirements {
                stop_timeout_ms: 300,
                cleanup_timeout_ms: 500,
            },
        }],
        contributions: vec![ContributionDeclaration {
            id: "query.call".into(),
            component_id: "query".into(),
            contribution: ContributionKind::Capability {
                declaration: CapabilityDeclaration {
                    contract: contract("example.query"),
                    input_schema: contract("example.input"),
                    output_schema: contract("example.output"),
                    error_schema: contract("example.error"),
                    profiles: vec![],
                    effect: EffectKind::ReadOnly,
                    permissions: vec![PermissionRequest::CapturedInput],
                    limits: CapabilityLimits {
                        max_input_bytes: 1024 * 1024,
                        max_output_bytes: 65536,
                        concurrency: 1,
                        timeout_ms: 1000,
                    },
                },
            },
        }],
    };
    if matches!(mode, "roster" | "roster-half-fail") {
        let mut second = manifest.contributions[0].clone();
        second.id = "check.call".into();
        let ContributionKind::Capability { declaration } = &mut second.contribution else {
            unreachable!()
        };
        declaration.contract = contract("example.check");
        declaration.input_schema = contract("example.check-input");
        declaration.output_schema = contract("example.check-output");
        declaration.limits.max_output_bytes = 32768;
        manifest.contributions.push(second);
    }
    mutate(&mut manifest);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let mut files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: include_bytes!("support/javascript-component.mjs").to_vec(),
                executable: false,
            },
        ),
        (
            "behavior.txt".into(),
            PackageFile {
                bytes: mode.as_bytes().to_vec(),
                executable: false,
            },
        ),
    ]);
    if let Some(observer) = observer {
        files.insert(
            "observer.txt".into(),
            PackageFile {
                bytes: observer.as_os_str().as_encoded_bytes().to_vec(),
                executable: false,
            },
        );
    }
    let expected = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &expected).unwrap()
}
fn options() -> LaunchOptions {
    LaunchOptions {
        scope: tsumugi_plugin_host::SessionScope::Bound(ScopeBinding {
            project_id: "project-a".into(),
            scope_id: "scope-a".into(),
        }),
        allow_unsandboxed_execution: true,
        limits: HostLimits {
            handshake_timeout_ms: 2000,
            invocation_timeout_ms: 1000,
            stop_timeout_ms: 300,
            cleanup_timeout_ms: 500,
            max_stderr_bytes: 1024,
            ..Default::default()
        },
    }
}
fn request(session: &ProcessSession, dispatch: &str, text: &str) -> InvocationRequest {
    let input = EncodedPayload::capture(contract("example.input"), text.into()).unwrap();
    InvocationRequest {
        context: InvocationContext {
            project_id: "project-a".into(),
            scope_id: "scope-a".into(),
            operation_id: "operation-a".into(),
            attempt_id: "attempt-a".into(),
            item_id: "item-a".into(),
            dispatch_id: dispatch.into(),
            input_digest: input.sha256.clone(),
            scope_digest: payload_digest("scope"),
            environment_digest: session.environment_digest().unwrap().into(),
            configuration_digest: payload_digest("configuration"),
        },
        provider: session.channel().provider("query.call").unwrap(),
        capability: contract("example.query"),
        profile: None,
        input,
        output_schema: contract("example.output"),
        error_schema: contract("example.error"),
        max_result_bytes: 65536,
    }
}
async fn launch(mode: &str, parent: &std::path::Path) -> ProcessSession {
    ProcessSession::launch(
        &image(mode),
        "query.call",
        parent,
        &launcher(),
        options(),
        || true,
    )
    .await
    .unwrap()
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn launcher() -> RuntimeLauncher {
    RuntimeLauncher::JavaScript {
        runtime: runtime_fixture::approved_runtime(),
    }
}

#[test]
fn javascript_sdk_calls_keep_identity_unicode_and_independent_lifetimes() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let mut a = launch("normal", dir.path()).await;
        let mut b = launch("normal", dir.path()).await;
        assert_ne!(a.channel().child_pid, b.channel().child_pid);
        assert_ne!(
            a.channel().instance.instance_id,
            b.channel().instance.instance_id
        );
        a.heartbeat().await.unwrap();
        assert!(a.close().await.cooperative_acknowledgement);
        let r = request(&b, "dispatch-b", "\u{feff}你好 👩🏽‍💻\r\n");
        let result = b.invoke(&r, || false, || true).await.unwrap();
        assert_eq!(result.channel().provider, r.provider);
        let InvocationOutcome::Succeeded { output } = &result.result().outcome else {
            panic!()
        };
        assert_eq!(output.utf8, "answer:\u{feff}你好 👩🏽‍💻\r\n");
        for index in 0..8 {
            let next = request(&b, &format!("serial-{index}"), "next");
            assert_eq!(
                b.invoke(&next, || false, || true)
                    .await
                    .unwrap()
                    .result()
                    .context
                    .dispatch_id,
                next.context.dispatch_id
            );
        }
        b.heartbeat().await.unwrap();
        assert_eq!(
            b.invoke(&r, || false, || true).await.unwrap_err(),
            HostError::RequestMismatch
        );
        let closed = b.close().await;
        assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        for mode in ["failed", "unknown"] {
            let mut s = launch(mode, dir.path()).await;
            let r = request(&s, mode, "error detail");
            let result = s.invoke(&r, || false, || true).await.unwrap();
            match &result.result().outcome {
                InvocationOutcome::Failed { error } if mode == "failed" => {
                    assert_eq!(error.schema, r.error_schema)
                }
                InvocationOutcome::Unknown { error } if mode == "unknown" => {
                    assert_eq!(error.schema, r.error_schema)
                }
                _ => panic!("wrong outcome"),
            }
            assert!(s.close().await.cooperative_acknowledgement);
        }
    });
}
#[test]
fn javascript_activation_failure_cleans_partial_registration_before_exit() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let observer = tempfile::tempdir().unwrap();
        let marker = observer.path().join("cleanup.txt");
        let result = ProcessSession::launch(
            &image_with_observer("half-fail", Some(&marker)),
            "query.call",
            dir.path(),
            &launcher(),
            options(),
            || true,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "cleaned");
        for mode in ["double-register", "activation-hang"] {
            assert!(
                ProcessSession::launch(
                    &image(mode),
                    "query.call",
                    dir.path(),
                    &launcher(),
                    options(),
                    || true
                )
                .await
                .is_err(),
                "{mode}"
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}
#[test]
fn javascript_handler_failures_revoke_the_channel() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        for mode in ["oversize", "invalid-output", "throw", "late-register"] {
            let mut s = launch(mode, dir.path()).await;
            assert!(
                s.invoke(&request(&s, mode, "input"), || false, || true)
                    .await
                    .is_err(),
                "{mode}"
            );
            assert!(!s.is_accepting());
            assert!(s.termination_receipt().unwrap().direct_child_reaped);
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}
#[test]
fn javascript_cancellation_authority_loss_and_uncooperative_handlers_are_bounded() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        for mode in ["late", "hang", "spin"] {
            let mut s = launch(mode, dir.path()).await;
            let start = std::time::Instant::now();
            let cancel = Arc::new(AtomicBool::new(false));
            let changed = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                changed.store(true, Ordering::SeqCst);
            });
            assert_eq!(
                s.invoke(
                    &request(&s, mode, "input"),
                    || cancel.load(Ordering::SeqCst),
                    || true
                )
                .await
                .unwrap_err(),
                HostError::Cancelled
            );
            assert!(start.elapsed() < Duration::from_secs(2));
            assert!(s.termination_receipt().unwrap().direct_child_reaped);
        }
        let mut s = launch("late", dir.path()).await;
        let start = std::time::Instant::now();
        assert_eq!(
            s.invoke(
                &request(&s, "revoked", "input"),
                || false,
                || start.elapsed() < Duration::from_millis(30)
            )
            .await
            .unwrap_err(),
            HostError::AuthorityRevoked
        );
        assert!(s.termination_receipt().unwrap().direct_child_reaped);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}
#[test]
fn javascript_close_waits_for_cleanup_and_does_not_ack_failed_or_stuck_cleanup() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let observer = tempfile::tempdir().unwrap();
        let marker = observer.path().join("cleanup.txt");
        let mut s = ProcessSession::launch(
            &image_with_observer("observe-cleanup", Some(&marker)),
            "query.call",
            dir.path(),
            &launcher(),
            options(),
            || true,
        )
        .await
        .unwrap();
        assert!(s.close().await.cooperative_acknowledgement);
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "cleaned");
        for mode in ["cleanup-hang", "cleanup-fail"] {
            let mut s = launch(mode, dir.path()).await;
            let start = std::time::Instant::now();
            let receipt = s.close().await;
            assert!(!receipt.cooperative_acknowledgement, "{mode}");
            assert!(receipt.direct_child_reaped);
            assert!(start.elapsed() < Duration::from_secs(2));
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}

#[test]
fn runtime_materialization_rechecks_authority_before_writing_or_starting_node() {
    runtime().block_on(async {
        let staging = tempfile::tempdir().unwrap();
        let observer = tempfile::tempdir().unwrap();
        let marker = observer.path().join("cleanup.txt");
        let parent = staging.path().to_owned();
        let launcher = launcher();
        let result = ProcessSession::launch(
            &image_with_observer("half-fail", Some(&marker)),
            "query.call",
            staging.path(),
            &launcher,
            options(),
            move || {
                // Revoke as soon as the real runtime file is created. The next
                // chunk must observe this before a partly written tool can run.
                !std::fs::read_dir(&parent)
                    .unwrap()
                    .any(|entry| entry.unwrap().path().join("runtime/tool/bin/node").exists())
            },
        )
        .await;
        assert!(matches!(result, Err(HostError::AuthorityRevoked)));
        assert!(!marker.exists(), "component never activated");
        assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
    });
}

#[test]
fn captured_environment_mismatch_is_refused_before_component_execution() {
    runtime().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let mut session = launch("normal", directory.path()).await;
        let mut invocation = request(&session, "wrong-environment", "input");
        invocation.context.environment_digest = payload_digest("another environment");
        assert_eq!(
            session
                .invoke(&invocation, || false, || true)
                .await
                .unwrap_err(),
            HostError::RequestMismatch
        );
        session
            .invoke(
                &request(&session, "correct-environment", "input"),
                || false,
                || true,
            )
            .await
            .unwrap();
        assert!(session.close().await.direct_child_reaped);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    });
}

#[test]
fn application_channel_keeps_instance_basis_and_each_project_principal_explicit() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let basis = uuid::Uuid::new_v4().to_string();
        let image = scoped_image("normal", None, ComponentScope::Application);
        let mut options = options();
        options.scope = SessionScope::Application {
            instance_id: basis.clone(),
            activation_generation: 7,
        };
        options.limits.max_invocations = 2;
        // Project aliases cannot opt an Application manifest into execution.
        assert!(
            ProcessSession::launch(
                &image,
                "query.call",
                dir.path(),
                &launcher(),
                self::options(),
                || true
            )
            .await
            .is_err()
        );
        let mut session = ProcessSession::launch(
            &image,
            "query.call",
            dir.path(),
            &launcher(),
            options,
            || true,
        )
        .await
        .unwrap();
        assert_eq!(session.channel().instance.instance_id, basis);
        assert_eq!(session.channel().instance.activation_generation, 7);
        let pid = session.channel().child_pid;
        for (project, dispatch) in [("project-a", "dispatch-a"), ("project-b", "dispatch-b")] {
            let mut call = request(&session, dispatch, project);
            call.context.project_id = project.into();
            call.context.scope_id = basis.clone();
            let received = session.invoke(&call, || false, || true).await.unwrap();
            assert_eq!(received.channel().child_pid, pid);
            assert_eq!(
                received.invocation_scope(),
                &ScopeBinding {
                    project_id: project.into(),
                    scope_id: basis.clone()
                }
            );
            assert_eq!(received.result().context, call.context);
            assert_eq!(received.result().provider, call.provider);
        }
        // The session-wide budget is shared by the complete activation. It
        // cannot be refreshed by changing projects or replaying a request.
        let mut exhausted = request(&session, "dispatch-c", "third");
        exhausted.context.scope_id = basis;
        assert!(session.invoke(&exhausted, || false, || true).await.is_err());
        assert_eq!(session.channel().child_pid, pid);
        assert!(session.close().await.direct_child_reaped);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}

#[test]
fn application_channel_rejects_wrong_scope_and_late_revoked_calls() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let basis = uuid::Uuid::new_v4().to_string();
        let mut options = options();
        options.scope = SessionScope::Application {
            instance_id: basis.clone(),
            activation_generation: 1,
        };
        let mut session = ProcessSession::launch(
            &scoped_image("late", None, ComponentScope::Application),
            "query.call",
            dir.path(),
            &launcher(),
            options,
            || true,
        )
        .await
        .unwrap();
        let mut call = request(&session, "wrong-scope", "captured");
        assert_eq!(
            session.invoke(&call, || false, || true).await.unwrap_err(),
            HostError::RequestMismatch
        );
        call.context.scope_id = basis;
        call.context.dispatch_id = "original-dispatch".into();
        let allowed = Arc::new(AtomicBool::new(true));
        let withdraw = allowed.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            withdraw.store(false, Ordering::Release);
        });
        assert_eq!(
            session
                .invoke(&call, || false, || allowed.load(Ordering::Acquire))
                .await
                .unwrap_err(),
            HostError::AuthorityRevoked
        );
        allowed.store(true, Ordering::Release);
        assert!(session.invoke(&call, || false, || true).await.is_err());
        assert!(session.close().await.direct_child_reaped);
    });
}

#[test]
fn application_roster_routes_exact_members_on_one_process_with_shared_limits() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let basis = uuid::Uuid::new_v4().to_string();
        let mut options = options();
        options.scope = SessionScope::Application {
            instance_id: basis.clone(),
            activation_generation: 7,
        };
        options.limits.max_invocations = 2;
        let mut session = ProcessSession::launch(
            &scoped_image("roster", None, ComponentScope::Application),
            "query.call",
            temporary.path(),
            &launcher(),
            options,
            || true,
        )
        .await
        .unwrap();
        let channel = session.channel();
        assert_eq!(channel.capabilities.len(), 2);
        assert!(channel.provider("missing.call").is_err());
        let mut first = request(&session, "roster-first", "first input");
        first.context.scope_id = basis;
        let first_result = session.invoke(&first, || false, || true).await.unwrap();
        let InvocationOutcome::Succeeded { output } = &first_result.result().outcome else {
            panic!("first member failed")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output.utf8).unwrap(),
            serde_json::json!({"member":"query.call","ordinal":1,"input":"first input"})
        );
        assert!(matches!(
            session.invoke(&first, || false, || true).await,
            Err(HostError::RequestMismatch)
        ));
        let mut second = first.clone();
        second.context.project_id = "project-b".into();
        second.context.attempt_id = "attempt-b".into();
        second.context.dispatch_id = "roster-second".into();
        second.provider = channel.provider("check.call").unwrap();
        second.capability = contract("example.check");
        second.input.schema = contract("example.check-input");
        second.output_schema = contract("example.check-output");
        for forged in [
            {
                let mut value = second.clone();
                value.provider.contribution_id = "missing.call".into();
                value
            },
            {
                let mut value = second.clone();
                value.provider.activation_generation += 1;
                value
            },
            {
                let mut value = second.clone();
                value.input.schema = contract("example.input");
                value
            },
            {
                let mut value = second.clone();
                value.provider = first.provider.clone();
                value
            },
        ] {
            assert!(matches!(
                session.invoke(&forged, || false, || true).await,
                Err(HostError::RequestMismatch)
            ));
        }
        let second_result = session.invoke(&second, || false, || true).await.unwrap();
        let InvocationOutcome::Succeeded { output } = &second_result.result().outcome else {
            panic!("second member failed")
        };
        assert_eq!(output.schema, contract("example.check-output"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output.utf8).unwrap(),
            serde_json::json!({"member":"check.call","ordinal":2,"input":"first input"})
        );
        assert_eq!(
            first_result.channel().child_pid,
            second_result.channel().child_pid
        );
        assert_eq!(
            first_result.channel().provider.instance(),
            second_result.channel().provider.instance()
        );
        assert_ne!(
            first_result.channel().provider.contribution_id,
            second_result.channel().provider.contribution_id
        );
        assert_eq!(second_result.invocation_scope().project_id, "project-b");
        let mut exhausted = first.clone();
        exhausted.context.dispatch_id = "roster-exhausted".into();
        assert!(matches!(
            session.invoke(&exhausted, || false, || true).await,
            Err(HostError::OutputLimit)
        ));
        assert_eq!(session.channel().child_pid, channel.child_pid);
        assert!(session.close().await.direct_child_reaped);
        assert!(matches!(
            session.invoke(&first, || false, || true).await,
            Err(HostError::Closed)
        ));
    });
}

#[test]
fn application_roster_half_registration_never_becomes_ready_and_cleans_its_candidate() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let observer = temporary.path().join("observer");
        let staging = temporary.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        let mut options = options();
        options.scope = SessionScope::Application {
            instance_id: uuid::Uuid::new_v4().to_string(),
            activation_generation: 1,
        };
        assert!(
            ProcessSession::launch(
                &scoped_image(
                    "roster-half-fail",
                    Some(&observer),
                    ComponentScope::Application
                ),
                "query.call",
                &staging,
                &launcher(),
                options,
                || true
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&observer).unwrap(), "cleaned");
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    });
}

#[test]
fn application_roster_uses_the_selected_members_output_ceiling() {
    runtime().block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let basis = uuid::Uuid::new_v4().to_string();
        let mut launch_options = options();
        launch_options.scope = SessionScope::Application {
            instance_id: basis.clone(),
            activation_generation: 1,
        };
        let mut session = ProcessSession::launch(
            &scoped_image("roster", None, ComponentScope::Application),
            "query.call",
            temporary.path(),
            &launcher(),
            launch_options,
            || true,
        )
        .await
        .unwrap();
        // This output fits query.call's 64 KiB ceiling but exceeds the sibling's
        // 32 KiB ceiling. The common frame allowance cannot replace either one.
        let mut first = request(&session, "larger-member", &"x".repeat(40_000));
        first.context.scope_id = basis;
        assert!(session.invoke(&first, || false, || true).await.is_ok());
        let mut second = first;
        second.context.dispatch_id = "smaller-member".into();
        second.provider = session.channel().provider("check.call").unwrap();
        second.capability = contract("example.check");
        second.input.schema = contract("example.check-input");
        second.output_schema = contract("example.check-output");
        assert!(session.invoke(&second, || false, || true).await.is_err());
        assert!(!session.is_accepting());
        assert!(session.close().await.direct_child_reaped);
    });
}

#[test]
fn application_roster_refuses_an_unsupported_sibling_before_starting_code() {
    runtime().block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        for unsupported in ["external", "service", "required-dependency"] {
            let captured =
                scoped_image_with("roster", None, ComponentScope::Application, |manifest| {
                    let ContributionKind::Capability { declaration } =
                        &mut manifest.contributions[1].contribution
                    else {
                        unreachable!()
                    };
                    if unsupported == "service" {
                        let permission = PermissionRequest::ProjectService {
                            contract: contract("example.service"),
                        };
                        declaration.permissions.push(permission.clone());
                        manifest.permissions.push(permission);
                        manifest.components[0]
                            .dependencies
                            .push(CapabilityDependency {
                                contract: contract("example.service"),
                                required: false,
                                selection: ProviderSelection::Single,
                            });
                    } else if unsupported == "external" {
                        declaration.effect = EffectKind::External;
                    } else {
                        manifest.components[0]
                            .dependencies
                            .push(CapabilityDependency {
                                contract: contract("example.service"),
                                required: true,
                                selection: ProviderSelection::Single,
                            });
                    }
                });
            let mut launch_options = options();
            launch_options.scope = SessionScope::Application {
                instance_id: uuid::Uuid::new_v4().to_string(),
                activation_generation: 1,
            };
            assert!(matches!(
                ProcessSession::launch(
                    &captured,
                    "query.call",
                    temporary.path(),
                    &launcher(),
                    launch_options,
                    || true
                )
                .await,
                Err(HostError::UnsupportedRuntime)
            ));
            assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 0);
        }
    });
}
