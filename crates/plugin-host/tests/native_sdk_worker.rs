#![cfg(unix)]
//! Actual public SDK-only binary over the existing captured-package Host route.
//! This is transport/lifecycle evidence, not domain or Core adoption evidence.
use std::collections::BTreeMap;
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk::*;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn image() -> PackageImage {
    let worker = std::env::var_os("TSUMUGI_NATIVE_SDK_WORKER")
        .expect("build the public native-worker example and supply its exact path");
    let manifest = PluginManifest {
        protocol_version: MANIFEST_PROTOCOL,
        plugin: PluginIdentity {
            publisher: "example".into(),
            id: "example.native-sdk".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![PermissionRequest::CapturedInput],
        components: vec![ComponentDeclaration {
            id: "worker".into(),
            scope: ComponentScope::Project,
            runtime: RuntimeKind::NativeWorker,
            entrypoint: Some("bin/worker".into()),
            dependencies: vec![],
            exit: ExitRequirements {
                stop_timeout_ms: 500,
                cleanup_timeout_ms: 1000,
            },
        }],
        contributions: vec![ContributionDeclaration {
            id: "echo".into(),
            component_id: "worker".into(),
            contribution: ContributionKind::Capability {
                declaration: CapabilityDeclaration {
                    contract: contract("example.echo"),
                    input_schema: contract("example.text"),
                    output_schema: contract("example.text"),
                    error_schema: contract("example.error"),
                    profiles: vec![],
                    effect: EffectKind::ReadOnly,
                    permissions: vec![PermissionRequest::CapturedInput],
                    limits: CapabilityLimits {
                        max_input_bytes: 131072,
                        max_output_bytes: 131072,
                        concurrency: 1,
                        timeout_ms: 1000,
                    },
                },
            },
        }],
    };
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([(
        "bin/worker".into(),
        PackageFile {
            bytes: std::fs::read(worker).unwrap(),
            executable: true,
        },
    )]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}
fn options() -> LaunchOptions {
    LaunchOptions {
        scope: ScopeBinding {
            project_id: "project-a".into(),
            scope_id: "scope-a".into(),
        },
        allow_unsandboxed_execution: true,
        limits: HostLimits {
            handshake_timeout_ms: 3000,
            invocation_timeout_ms: 2000,
            stop_timeout_ms: 1000,
            cleanup_timeout_ms: 1000,
            ..HostLimits::default()
        },
    }
}
fn request(session: &ProcessSession, id: &str, utf8: &str) -> InvocationRequest {
    let input = EncodedPayload::capture(contract("example.text"), utf8.into()).unwrap();
    InvocationRequest {
        context: InvocationContext {
            project_id: "project-a".into(),
            operation_id: "operation-a".into(),
            attempt_id: "attempt-a".into(),
            item_id: "item-a".into(),
            dispatch_id: id.into(),
            scope_id: "scope-a".into(),
            input_digest: input.sha256.clone(),
            scope_digest: "b".repeat(64),
            environment_digest: "c".repeat(64),
            configuration_digest: "d".repeat(64),
        },
        provider: session.channel().provider,
        capability: contract("example.echo"),
        profile: None,
        input,
        output_schema: contract("example.text"),
        error_schema: contract("example.error"),
        max_result_bytes: 256 * 1024,
    }
}

#[tokio::test]
#[ignore = "requires the exact independently built SDK native-worker example"]
async fn public_sdk_binary_preserves_unicode_serial_identity_and_cooperative_cleanup() {
    let image = image();
    let staging = tempfile::tempdir().unwrap();
    let mut session = ProcessSession::launch(
        &image,
        "echo",
        staging.path(),
        &RuntimeLauncher::Native,
        options(),
        || true,
    )
    .await
    .unwrap();
    let channel = session.channel();
    assert!(channel.child_pid > 0);
    // Native transport alone has no captured Node environment. Full Native/Core
    // environment binding remains a separate owner and must not borrow Node.
    assert!(session.environment_digest().is_none());
    for (i, text) in [
        "\u{feff}中文\r\n👩🏽‍💻 e\u{301}",
        "",
        "{literal: no domain parsing}",
    ]
    .into_iter()
    .enumerate()
    {
        let request = request(&session, &format!("dispatch-{i}"), text);
        let received = session.invoke(&request, || false, || true).await.unwrap();
        assert_eq!(received.channel().provider, channel.provider);
        assert_eq!(received.channel().child_pid, channel.child_pid);
        assert_eq!(received.result().context, request.context);
        assert_eq!(received.result().result_id, request.context.dispatch_id);
        let InvocationOutcome::Succeeded { output } = &received.result().outcome else {
            panic!("success");
        };
        assert_eq!(output, &request.input);
        session.heartbeat().await.unwrap();
    }
    let receipt = session.close().await;
    assert!(receipt.cooperative_acknowledgement);
    assert!(receipt.direct_child_reaped);
    // The Host kills the owned group even after Closed, before reaping its
    // leader. That may win the natural-exit race and report a signal (None).
    assert!(receipt.exit_code.is_none_or(|code| code == 0));
    assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
}

#[tokio::test]
#[ignore = "requires the exact independently built SDK native-worker example"]
async fn actual_host_rejects_forged_identity_and_revokes_owned_channel() {
    let image = image();
    let staging = tempfile::tempdir().unwrap();
    let mut session = ProcessSession::launch(
        &image,
        "echo",
        staging.path(),
        &RuntimeLauncher::Native,
        options(),
        || true,
    )
    .await
    .unwrap();
    let mut forged = request(&session, "dispatch-forged", "captured");
    forged.provider.instance_id = "other-instance".into();
    assert!(matches!(
        session.invoke(&forged, || false, || true).await,
        Err(HostError::RequestMismatch)
    ));
    let original = request(&session, "dispatch-real", "captured");
    assert!(matches!(
        session.invoke(&original, || false, || false).await,
        Err(HostError::AuthorityRevoked)
    ));
    let receipt = session.termination_receipt().unwrap();
    assert!(receipt.direct_child_reaped);
    assert!(!session.is_accepting());
    assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
}
