//! Shared real-package Store and captured-runtime pairing harness.
use serde_json::Value;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};
use tsumugi_plugin_host::{catalog::*, *};
use tsumugi_plugin_sdk::*;
#[path = "runtime.rs"]
mod runtime_fixture;

pub fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}

pub fn installed(temporary: &std::path::Path, expected_plugin_id: &str) -> PackageImage {
    let source = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
            .expect("explicit prebuilt official package required"),
    );
    let expected = std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST")
        .expect("independently approved official package digest required");
    installed_from(temporary, &source, &expected, expected_plugin_id)
}

pub fn installed_from(
    temporary: &std::path::Path,
    source: &std::path::Path,
    expected: &str,
    expected_plugin_id: &str,
) -> PackageImage {
    let image = PackageImage::capture_directory(&source, &expected, || true).unwrap();
    let plugin = image.manifest().manifest().plugin.clone();
    assert_eq!(plugin.id, expected_plugin_id);
    let approval = PackageApproval {
        plugin: plugin.clone(),
        package_digest: expected.into(),
        origin: PackageOrigin {
            source_id: "explicit-official-test".into(),
            publisher_id: "reviewed-public-source".into(),
        },
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    let root = temporary.join("packages");
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    {
        let mut store = PackageStore::open_existing(&root).unwrap();
        store
            .install(
                "00000000-0000-4000-8000-000000000031",
                catalog.registered(&plugin).unwrap(),
                || true,
            )
            .unwrap();
    }
    drop(catalog);
    let store = PackageStore::open_existing(&root).unwrap();
    let installed = store.load(&approval, || true).unwrap();
    assert_eq!(
        installed.receipt().package_digest(),
        approval.package_digest
    );
    installed.image().clone()
}

pub async fn launch(
    image: &PackageImage,
    contribution: &str,
    temporary: &std::path::Path,
) -> ProcessSession {
    ProcessSession::launch(
        image,
        contribution,
        temporary,
        &RuntimeLauncher::JavaScript {
            runtime: runtime_fixture::approved_runtime(),
        },
        LaunchOptions {
            scope: tsumugi_plugin_host::SessionScope::Bound(ScopeBinding {
                project_id: "synthetic-project".into(),
                scope_id: "synthetic-project".into(),
            }),
            allow_unsandboxed_execution: true,
            limits: HostLimits::default(),
        },
        || true,
    )
    .await
    .unwrap()
}

pub fn request_for(
    session: &ProcessSession,
    binding: &CapabilityBinding,
    dispatch: &str,
    value: &Value,
) -> InvocationRequest {
    // Actual child identity comes from the Host, independently of request data.
    let channel = session.channel();
    assert_eq!(
        channel
            .provider(&binding.provider.contribution_id)
            .unwrap()
            .selection(),
        binding.provider
    );
    assert!(channel.child_pid > 0);
    assert_eq!(binding.declaration.profiles.len(), 1);
    let input =
        EncodedPayload::capture(binding.declaration.input_schema.clone(), value.to_string())
            .unwrap();
    InvocationRequest {
        context: InvocationContext {
            project_id: "synthetic-project".into(),
            scope_id: "synthetic-project".into(),
            operation_id: "synthetic-operation".into(),
            attempt_id: "synthetic-attempt".into(),
            item_id: "synthetic-item".into(),
            dispatch_id: dispatch.into(),
            input_digest: input.sha256.clone(),
            scope_digest: payload_digest("captured-scope"),
            environment_digest: session.environment_digest().unwrap().into(),
            configuration_digest: payload_digest("captured-configuration"),
        },
        provider: channel
            .provider(&binding.provider.contribution_id)
            .unwrap()
            .clone(),
        capability: binding.declaration.contract.clone(),
        profile: Some(
            binding
                .declaration
                .profiles
                .first()
                .expect("one selected profile required")
                .clone(),
        ),
        input,
        output_schema: binding.declaration.output_schema.clone(),
        error_schema: binding.declaration.error_schema.clone(),
        max_result_bytes: MAX_EXCHANGE_BYTES as u32,
    }
}

pub async fn invoke_received(
    session: &mut ProcessSession,
    binding: &CapabilityBinding,
    dispatch: &str,
    value: &Value,
) -> ReceivedResult {
    let channel = session.channel();
    let request = request_for(session, binding, dispatch, value);
    let received = session.invoke(&request, || false, || true).await.unwrap();
    assert_eq!(
        received.channel().provider,
        channel.provider(&binding.provider.contribution_id).unwrap()
    );
    assert_eq!(received.channel().child_pid, channel.child_pid);
    assert_eq!(received.channel().scope, channel.scope);
    assert_eq!(
        received.result().provider,
        channel.provider(&binding.provider.contribution_id).unwrap()
    );
    assert_eq!(received.result().context, request.context);
    received
}

pub async fn invoke(
    session: &mut ProcessSession,
    binding: &CapabilityBinding,
    dispatch: &str,
    value: &Value,
) -> InvocationOutcome {
    invoke_received(session, binding, dispatch, value)
        .await
        .result()
        .outcome
        .clone()
}

pub fn success_payload(outcome: InvocationOutcome) -> EncodedPayload {
    let InvocationOutcome::Succeeded { output } = outcome else {
        panic!("expected real plugin success: {outcome:?}");
    };
    assert_eq!(output.sha256, payload_digest(&output.utf8));
    output
}

pub async fn close_and_reap(session: &mut ProcessSession) {
    let closed = session.close().await;
    assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
    assert_eq!(session.termination_receipt(), Some(&closed));
    assert!(!session.is_accepting());
}
