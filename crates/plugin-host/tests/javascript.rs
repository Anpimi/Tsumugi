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
            scope: ComponentScope::Project,
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
        scope: ScopeBinding {
            project_id: "project-a".into(),
            scope_id: "scope-a".into(),
        },
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
        approved_node: std::env::var_os("TSUMUGI_TEST_NODE")
            .expect("test runner must select Node")
            .into(),
        approved_bootstrap: std::env::var_os("TSUMUGI_TEST_JS_HOST_BOOTSTRAP")
            .expect("test runner must select built Host")
            .into(),
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
            a.channel().provider.instance_id,
            b.channel().provider.instance_id
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
