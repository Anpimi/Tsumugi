#![cfg(all(unix, feature = "conformance-worker"))]
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
    image_with_scope(mode, observer, ComponentScope::Project)
}
fn image_with_scope(
    mode: &str,
    observer: Option<&std::path::Path>,
    scope: ComponentScope,
) -> PackageImage {
    let manifest = PluginManifest {
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
            runtime: RuntimeKind::NativeWorker,
            entrypoint: Some("bin/worker".into()),
            dependencies: if matches!(mode, "requires-service" | "optional-service") {
                vec![CapabilityDependency {
                    contract: contract("example.service"),
                    required: mode == "requires-service",
                    selection: ProviderSelection::Single,
                }]
            } else {
                vec![]
            },
            exit: ExitRequirements {
                stop_timeout_ms: 100,
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
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let mut files = BTreeMap::from([
        (
            "bin/worker".into(),
            PackageFile {
                bytes: std::fs::read(env!("CARGO_BIN_EXE_tsumugi-process-conformance-worker"))
                    .unwrap(),
                executable: true,
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
        scope: ScopeBinding {
            project_id: "project-a".into(),
            scope_id: "scope-a".into(),
        },
        allow_unsandboxed_execution: true,
        limits: HostLimits {
            handshake_timeout_ms: 1000,
            invocation_timeout_ms: 1000,
            stop_timeout_ms: 100,
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
            environment_digest: payload_digest("environment"),
            configuration_digest: payload_digest("configuration"),
        },
        provider: session.channel().provider,
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
        &RuntimeLauncher::Native,
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

#[test]
fn attempt_channels_bind_project_and_attempt_and_cleanup_only_the_owned_instance() {
    runtime().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let image = image_with_scope("normal", None, ComponentScope::Attempt);
        let mut a_options = options();
        a_options.scope.scope_id = "attempt-a".into();
        let mut b_options = options();
        b_options.scope.scope_id = "attempt-b".into();
        let mut a = ProcessSession::launch(
            &image,
            "query.call",
            directory.path(),
            &RuntimeLauncher::Native,
            a_options,
            || true,
        )
        .await
        .unwrap();
        let mut b = ProcessSession::launch(
            &image,
            "query.call",
            directory.path(),
            &RuntimeLauncher::Native,
            b_options,
            || true,
        )
        .await
        .unwrap();
        let mut a_request = request(&a, "dispatch-a", "first");
        a_request.context.scope_id = "attempt-a".into();
        a.invoke(&a_request, || false, || true).await.unwrap();
        let mut wrong_attempt = request(&b, "wrong-attempt", "second");
        wrong_attempt.context.scope_id = "attempt-b".into();
        assert_eq!(
            b.invoke(&wrong_attempt, || false, || true)
                .await
                .unwrap_err(),
            HostError::RequestMismatch
        );
        let mut b_request = wrong_attempt.clone();
        b_request.context.attempt_id = "attempt-b".into();
        let mut wrong_project = b_request.clone();
        wrong_project.context.project_id = "project-b".into();
        assert_eq!(
            b.invoke(&wrong_project, || false, || true)
                .await
                .unwrap_err(),
            HostError::RequestMismatch
        );
        assert_ne!(
            a.channel().provider.instance_id,
            b.channel().provider.instance_id
        );
        assert!(a.close().await.direct_child_reaped);
        assert!(a.close().await.direct_child_reaped);
        drop(a);
        let received = b.invoke(&b_request, || false, || true).await.unwrap();
        assert_eq!(received.result().context.attempt_id, "attempt-b");
        assert_eq!(received.result().context.scope_id, "attempt-b");
        assert!(b.close().await.direct_child_reaped);
        assert_eq!(
            b.invoke(&b_request, || false, || true).await.unwrap_err(),
            HostError::Closed
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    });
}

#[test]
fn attempt_channels_retain_the_original_guard_and_reject_cancelled_or_revoked_late_results() {
    runtime().block_on(async {
        for cancel in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let observer = directory.path().join("invoked");
            let image = image_with_scope("late-result", Some(&observer), ComponentScope::Attempt);
            let original = Arc::new(AtomicBool::new(true));
            let cancelled = Arc::new(AtomicBool::new(false));
            let guard = original.clone();
            let mut configured = options();
            configured.scope.scope_id = "attempt-a".into();
            let mut session = ProcessSession::launch(
                &image,
                "query.call",
                directory.path(),
                &RuntimeLauncher::Native,
                configured,
                move || guard.load(Ordering::Acquire),
            )
            .await
            .unwrap();
            let mut invocation = request(&session, "dispatch-a", "late");
            invocation.context.scope_id = "attempt-a".into();
            let revoke = original.clone();
            let cancellation = cancelled.clone();
            let pending = tokio::spawn(async move {
                let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
                while !observer.exists() {
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "worker never received the invocation"
                    );
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                if cancel {
                    cancellation.store(true, Ordering::Release);
                } else {
                    revoke.store(false, Ordering::Release);
                }
            });
            // A different callback cannot replace the original admission guard.
            assert_eq!(
                session
                    .invoke(&invocation, || cancelled.load(Ordering::Acquire), || true)
                    .await
                    .unwrap_err(),
                if cancel {
                    HostError::Cancelled
                } else {
                    HostError::AuthorityRevoked
                }
            );
            pending.await.unwrap();
            original.store(true, Ordering::Release);
            cancelled.store(false, Ordering::Release);
            assert!(!session.is_accepting());
            assert_eq!(
                session
                    .invoke(&invocation, || false, || true)
                    .await
                    .unwrap_err(),
                HostError::Closed
            );
            assert!(session.close().await.direct_child_reaped);
            assert_eq!(
                std::fs::read(directory.path().join("invoked")).unwrap(),
                b"invoked"
            );
            std::fs::remove_file(directory.path().join("invoked")).unwrap();
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
    });
}

#[test]
fn unsupported_scopes_and_required_attempt_services_refuse_launch_without_staging() {
    runtime().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        for (scope, mode, expected) in [
            (
                ComponentScope::Application,
                "normal",
                HostError::UnsupportedRuntime,
            ),
            (
                ComponentScope::Attempt,
                "requires-service",
                HostError::DependencyUnavailable,
            ),
        ] {
            let result = ProcessSession::launch(
                &image_with_scope(mode, None, scope),
                "query.call",
                directory.path(),
                &RuntimeLauncher::Native,
                options(),
                || true,
            )
            .await;
            assert!(matches!(result, Err(error) if error == expected));
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
        let mut configured = options();
        configured.scope.scope_id = "attempt-a".into();
        let mut session = ProcessSession::launch(
            &image_with_scope("optional-service", None, ComponentScope::Attempt),
            "query.call",
            directory.path(),
            &RuntimeLauncher::Native,
            configured,
            || true,
        )
        .await
        .unwrap();
        let mut invocation = request(&session, "dispatch-a", "optional dependency absent");
        invocation.context.scope_id = "attempt-a".into();
        session
            .invoke(&invocation, || false, || true)
            .await
            .unwrap();
        assert!(session.close().await.direct_child_reaped);
    });
}
#[test]
fn actual_process_channel_and_heartbeat_keep_exact_utf8_and_empty_environment() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let mut s = launch("assert-env", dir.path()).await;
        use std::os::unix::fs::PermissionsExt;
        let instance = std::fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            instance.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(s.channel().child_pid > 0);
        s.heartbeat().await.unwrap();
        let r = request(&s, "dispatch-a", "\u{feff}你好 👩🏽‍💻\r\n");
        let result = s.invoke(&r, || false, || true).await.unwrap();
        assert_eq!(result.channel().provider, r.provider);
        let InvocationOutcome::Succeeded { output } = &result.result().outcome else {
            panic!()
        };
        assert_eq!(output.utf8, "answer:\u{feff}你好 👩🏽‍💻\r\n");
        assert_eq!(
            s.invoke(&r, || false, || true).await.unwrap_err(),
            HostError::RequestMismatch
        );
        let close = s.close().await;
        assert!(close.cooperative_acknowledgement);
        assert!(close.direct_child_reaped);
        assert!(!s.is_accepting());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}
#[test]
fn actual_result_frame_budget_does_not_replace_the_declared_raw_output_limit() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        for (index, (text, allowed)) in [
            ("small".to_owned(), true),
            ("x".repeat(65536 - "answer:".len()), true),
            ("x".repeat(65537 - "answer:".len()), false),
        ]
        .into_iter()
        .enumerate()
        {
            let mut session = launch("normal", dir.path()).await;
            let mut input = request(&session, &format!("budget-{index}"), &text);
            input.max_result_bytes = 128 * 1024;
            let received = session.invoke(&input, || false, || true).await;
            if allowed {
                let received = received.unwrap();
                let InvocationOutcome::Succeeded { output } = &received.result().outcome else {
                    panic!("Expected successful result");
                };
                assert_eq!(output.utf8, format!("answer:{text}"));
                assert!(output.utf8.len() <= 65536);
                let encoded = ProcessFrame::new(ProcessBody::Result(received.result().clone()))
                    .encode()
                    .unwrap();
                assert!(encoded.len() <= input.max_result_bytes as usize);
            } else {
                assert_eq!(received.unwrap_err(), HostError::OutputLimit);
                assert!(!session.is_accepting());
                assert!(session.termination_receipt().unwrap().direct_child_reaped);
            }
            assert!(session.close().await.direct_child_reaped);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    });
}

#[test]
fn original_result_frame_bytes_include_json_whitespace_in_the_invocation_budget() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        for (mode, allowed) in [("padded-result", true), ("oversized-padded-result", false)] {
            let mut session = launch(mode, dir.path()).await;
            let input = request(&session, mode, "small");
            let received = session.invoke(&input, || false, || true).await;
            if allowed {
                let received = received.unwrap();
                let InvocationOutcome::Succeeded { output } = &received.result().outcome else {
                    panic!("Expected successful result");
                };
                assert_eq!(output.utf8, "answer:small");
                assert!(session.is_accepting());
            } else {
                assert_eq!(received.unwrap_err(), HostError::OutputLimit);
                assert!(!session.is_accepting());
                assert!(session.termination_receipt().unwrap().direct_child_reaped);
            }
            assert!(session.close().await.direct_child_reaped);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    });
}

#[test]
fn separate_instances_and_old_cleanup_do_not_remove_another_process() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let mut a = launch("normal", dir.path()).await;
        let mut b = launch("normal", dir.path()).await;
        assert_ne!(
            a.channel().provider.instance_id,
            b.channel().provider.instance_id
        );
        assert_ne!(a.channel().child_pid, b.channel().child_pid);
        assert!(a.close().await.direct_child_reaped);
        assert!(a.close().await.direct_child_reaped);
        let r = request(&b, "dispatch-b", "rose");
        b.invoke(&r, || false, || true).await.unwrap();
        assert!(b.close().await.direct_child_reaped);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}
#[test]
fn rejected_handshakes_leave_no_half_active_directory() {
    runtime().block_on(async {
    for (mode,expected) in [("wrong-handshake",HostError::HandshakeMismatch),("wrong-protocol",HostError::InvalidFrame),("crash-handshake",HostError::Crashed)] {
        let dir=tempfile::tempdir().unwrap();assert!(matches!(ProcessSession::launch(&image(mode),"query.call",dir.path(),&RuntimeLauncher::Native,options(),||true).await,Err(e) if e==expected));assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(),0);
    }
});
}
#[test]
fn invalid_channel_scope_direction_length_and_crash_revoke_the_process() {
    runtime().block_on(async {
        for (mode, expected) in [
            ("wrong-result", HostError::ResultMismatch),
            ("wrong-scope", HostError::ResultMismatch),
            ("wrong-direction", HostError::UnexpectedFrame),
            ("oversized-header", HostError::OutputLimit),
            ("duplicate-fields", HostError::InvalidFrame),
            ("truncated", HostError::Crashed),
            ("crash-result", HostError::Crashed),
            ("stderr-flood", HostError::OutputLimit),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let mut s = launch(mode, dir.path()).await;
            let r = request(&s, "dispatch-a", "rose");
            assert_eq!(
                s.invoke(&r, || false, || true).await.unwrap_err(),
                expected,
                "{mode}"
            );
            assert!(!s.is_accepting());
            assert!(s.termination_receipt().unwrap().direct_child_reaped);
            assert_eq!(
                s.invoke(&r, || false, || true).await.unwrap_err(),
                HostError::Closed
            );
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    });
}
#[test]
fn wrong_request_is_rejected_before_dispatch_without_harming_another_scope() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let mut s = launch("normal", dir.path()).await;
        let r = request(&s, "dispatch-a", "rose");
        let mut wrong = r.clone();
        wrong.context.project_id = "other-project".into();
        assert_eq!(
            s.invoke(&wrong, || false, || true).await.unwrap_err(),
            HostError::RequestMismatch
        );
        wrong = r.clone();
        wrong.provider.package_digest = payload_digest("forged-package");
        assert_eq!(
            s.invoke(&wrong, || false, || true).await.unwrap_err(),
            HostError::RequestMismatch
        );
        s.invoke(&r, || false, || true).await.unwrap();
        s.close().await;
    });
}
#[test]
fn timeouts_bound_a_worker_that_stops_reading_or_returning_results() {
    runtime().block_on(async {
        for mode in ["no-read", "no-result"] {
            let dir = tempfile::tempdir().unwrap();
            let mut opt = options();
            opt.limits.invocation_timeout_ms = 100;
            let mut s = ProcessSession::launch(
                &image(mode),
                "query.call",
                dir.path(),
                &RuntimeLauncher::Native,
                opt,
                || true,
            )
            .await
            .unwrap();
            let r = request(&s, "dispatch-a", &"x".repeat(256 * 1024));
            let started = tokio::time::Instant::now();
            assert_eq!(
                s.invoke(&r, || false, || true).await.unwrap_err(),
                HostError::Timeout
            );
            assert!(started.elapsed() < Duration::from_secs(2));
            assert!(!s.is_accepting());
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    });
}
#[test]
fn cancellation_and_live_authority_revoke_before_a_late_result_can_be_received() {
    runtime().block_on(async {
        for revoke_authority in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut s = launch("late-result", dir.path()).await;
            let flag = Arc::new(AtomicBool::new(false));
            let changed = flag.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                changed.store(true, Ordering::Release);
            });
            let r = request(&s, "dispatch-a", "rose");
            assert_eq!(
                s.invoke(
                    &r,
                    || !revoke_authority && flag.load(Ordering::Acquire),
                    || !revoke_authority || !flag.load(Ordering::Acquire)
                )
                .await
                .unwrap_err(),
                if revoke_authority {
                    HostError::AuthorityRevoked
                } else {
                    HostError::Cancelled
                }
            );
            assert!(!s.is_accepting());
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    });
}
#[test]
fn uncooperative_close_is_attributed_and_direct_child_is_reaped() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let mut s = launch("no-close", dir.path()).await;
        let started = tokio::time::Instant::now();
        let closed = s.close().await;
        assert!(!closed.cooperative_acknowledgement);
        assert!(closed.direct_child_reaped);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!s.is_accepting());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}
#[test]
fn duplicate_old_output_cannot_be_admitted_into_a_new_dispatch() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let mut s = launch("duplicate-result", dir.path()).await;
        let r = request(&s, "dispatch-a", "rose");
        s.invoke(&r, || false, || true).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let next = request(&s, "dispatch-b", "rose");
        assert_eq!(
            s.invoke(&next, || false, || true).await.unwrap_err(),
            HostError::UnexpectedFrame
        );
        assert!(!s.is_accepting());
    });
}
#[test]
fn package_capture_checks_digest_path_alias_and_execution_authorization() {
    runtime().block_on(async {
        let manifest = b"{}";
        let files = BTreeMap::from([(
            "../escape".into(),
            PackageFile {
                bytes: vec![],
                executable: false,
            },
        )]);
        assert_eq!(
            PackageImage::digest(manifest, &files).unwrap_err(),
            HostError::PackagePath
        );
        let files = BTreeMap::from([
            (
                "data/a".into(),
                PackageFile {
                    bytes: vec![],
                    executable: false,
                },
            ),
            (
                "Data/A".into(),
                PackageFile {
                    bytes: vec![],
                    executable: false,
                },
            ),
        ]);
        assert_eq!(
            PackageImage::digest(manifest, &files).unwrap_err(),
            HostError::PackagePath
        );
        let files = BTreeMap::from([
            (
                "data".into(),
                PackageFile {
                    bytes: vec![],
                    executable: false,
                },
            ),
            (
                "data/a".into(),
                PackageFile {
                    bytes: vec![],
                    executable: false,
                },
            ),
        ]);
        assert_eq!(
            PackageImage::digest(manifest, &files).unwrap_err(),
            HostError::PackagePath
        );
        let files = BTreeMap::from([(
            "data".into(),
            PackageFile {
                bytes: vec![1],
                executable: false,
            },
        )]);
        assert!(matches!(
            PackageImage::capture(manifest.to_vec(), files, "wrong"),
            Err(HostError::PackageMismatch)
        ));
        let dir = tempfile::tempdir().unwrap();
        let mut opt = options();
        opt.allow_unsandboxed_execution = false;
        assert!(matches!(
            ProcessSession::launch(
                &image("normal"),
                "query.call",
                dir.path(),
                &RuntimeLauncher::Native,
                opt,
                || true,
            )
            .await,
            Err(HostError::ExecutionNotAuthorized)
        ));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}

#[test]
fn live_authority_can_revoke_a_handshake_before_any_capability_activates() {
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let flag = Arc::new(AtomicBool::new(true));
        let changed = flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            changed.store(false, Ordering::Release);
        });
        let result = ProcessSession::launch(
            &image("no-handshake"),
            "query.call",
            dir.path(),
            &RuntimeLauncher::Native,
            options(),
            move || flag.load(Ordering::Acquire),
        )
        .await;
        assert!(matches!(result, Err(HostError::AuthorityRevoked)));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}

#[test]
fn authority_expiring_during_materialization_prevents_even_worker_startup() {
    runtime().block_on(async {
        let stage = tempfile::tempdir().unwrap();
        let observation = tempfile::tempdir().unwrap();
        let marker = observation.path().join("started");
        let package = image_with_observer("startup-marker", Some(&marker));
        let stage_path = stage.path().to_owned();
        let result = ProcessSession::launch(
            &package,
            "query.call",
            stage.path(),
            &RuntimeLauncher::Native,
            options(),
            move || {
                if std::fs::read_dir(&stage_path).unwrap().next().is_some() {
                    // If the host had already spawned, its independent process has
                    // time to expose the unauthorized startup through the marker.
                    std::thread::sleep(Duration::from_millis(100));
                    false
                } else {
                    true
                }
            },
        )
        .await;
        assert!(matches!(result, Err(HostError::AuthorityRevoked)));
        assert!(!marker.exists());
        assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    });
}
