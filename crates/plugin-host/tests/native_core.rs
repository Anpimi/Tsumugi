#![cfg(all(unix, feature = "core-adapter"))]
//! Actual SDK-only native executable through the normal Core port/ledger. Run
//! this test as an external consumer with Core features=[] as well as in-host.
//! Echo is synthetic transport evidence, not extraction/check/build acceptance.
use serde_json::json;
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{ProjectMetadata, ProjectStore, execution::*};
use tsumugi_plugin_host::{CapturedNativeRuntime, HostLimits, PackageImage, core::RunnerProxy};
use tsumugi_plugin_sdk as sdk;
#[path = "support/native.rs"]
mod native;

fn proxy(stage: &Path) -> Arc<RunnerProxy> {
    let description = CapturedNativeRuntime::inspect_current().unwrap();
    Arc::new(
        RunnerProxy::new(
            native::image(),
            "echo",
            CapturedNativeRuntime::capture(&description).unwrap(),
            stage,
            HostLimits::default(),
        )
        .unwrap(),
    )
}
fn store(root: &Path) -> ProjectStore {
    ProjectStore::create(
        root.join("project"),
        ProjectMetadata::create("Synthetic native", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap()
}
fn input(store: &ProjectStore, proxy: &RunnerProxy) -> FixedInput {
    let item = InputItem::new(
        Scope {
            kind: "synthetic".into(),
            id: "echo".into(),
            locale: None,
        },
        json!({"text":"\u{feff}中文\r\n👩🏽‍💻 e\u{301}","empty":"","literal":"{not a domain parse}"}),
        vec![],
    );
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "native-echo",
        proxy.capability_id(),
        proxy.capability_version(),
        vec![item],
    )
    .unwrap();
    envelope.plugin = Some(proxy.execution_binding(None).unwrap());
    FixedInput::capture(envelope).unwrap()
}
fn expiry() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000
}
fn authorize(
    runtime: &ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> ExecutionId {
    let grant = ExecutionId::new();
    runtime
        .authorize_plugin(
            store,
            grant,
            input,
            expiry(),
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: false,
            },
        )
        .unwrap();
    grant
}
fn finish(runtime: &mut ExecutionRuntime, store: &mut ProjectStore, input: &FixedInput) {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        runtime.tick(store).unwrap();
        let state = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        if !runtime.is_active(input.envelope().attempt_id)
            && state.items.iter().all(|i| {
                !matches!(
                    i.execution,
                    ExecutionState::Queued | ExecutionState::Dispatched
                )
            })
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "native Core completion deadline: {state:?}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
struct EchoValidator {
    owner: std::thread::ThreadId,
    reject: bool,
}
impl ResultValidator for EchoValidator {
    fn operation(&self) -> &str {
        "native-echo"
    }
    fn validate(&self, input: &FixedInput, result: &FixedResult) -> Result<(), ExecutionError> {
        assert_ne!(self.owner, std::thread::current().id());
        let expected = &input.item(result.envelope().item_id)?.payload;
        let evidence = result
            .envelope()
            .plugin
            .as_ref()
            .ok_or_else(|| ExecutionError::new(ErrorCode::OutputInvalid, "echo-evidence"))?;
        let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
            return Err(ExecutionError::new(
                ErrorCode::OutputInvalid,
                "echo-outcome",
            ));
        };
        if self.reject
            || result.envelope().output.as_ref() != Some(expected)
            || output.utf8 != serde_json::to_string(expected).unwrap()
        {
            return Err(ExecutionError::new(
                ErrorCode::OutputInvalid,
                "independent-echo-check",
            ));
        }
        Ok(())
    }
}
fn validator(reject: bool) -> Arc<EchoValidator> {
    Arc::new(EchoValidator {
        owner: std::thread::current().id(),
        reject,
    })
}

#[test]
#[ignore = "requires the exact independently built SDK native-worker example"]
fn native_fixed_input_live_grant_original_channel_and_history_survive_reopen() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let source = root.path().join("package-source");
    std::fs::create_dir_all(source.join("bin")).unwrap();
    let (manifest, files) = native::package();
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    std::fs::write(source.join("manifest.json"), &manifest).unwrap();
    for (path, file) in files {
        std::fs::write(source.join(&path), &file.bytes).unwrap();
        std::fs::set_permissions(
            source.join(path),
            std::fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
        )
        .unwrap();
    }
    let image = PackageImage::capture_directory(&source, &digest, || true).unwrap();
    std::fs::remove_dir_all(&source).unwrap();
    let approved = CapturedNativeRuntime::inspect_current().unwrap();
    println!(
        "native_core_identity={}",
        serde_json::json!({
            "environment": &approved, "environmentDigest": approved.digest().unwrap(),
            "packageDigest": &digest,
        })
    );
    let proxy = Arc::new(
        RunnerProxy::new(
            image,
            "echo",
            CapturedNativeRuntime::capture(&approved).unwrap(),
            stage.path(),
            HostLimits::default(),
        )
        .unwrap(),
    );
    let mut store = store(root.path());
    let input = input(&store, &proxy);
    let binding = input.envelope().plugin.as_ref().unwrap();
    assert_eq!(
        binding.environment,
        sdk::ExecutionEnvironmentDescriptor::Native(approved.clone())
    );
    assert_eq!(
        binding.environment_digest().unwrap(),
        approved.digest().unwrap()
    );
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy.clone()).unwrap();
    runtime.register_validator(validator(false)).unwrap();
    assert_eq!(
        runtime.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let grant = authorize(&runtime, &mut store, &input);
    runtime.submit(&mut store, &input).unwrap();
    finish(&mut runtime, &mut store, &input);
    let state = store
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(state.items[0].execution, ExecutionState::Succeeded);
    assert_eq!(state.items[0].validation, ValidationState::Valid);
    assert_eq!(state.items[0].adoption, AdoptionState::Unapplied);
    let id = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let result = store
        .execution_result(input.envelope().attempt_id, id)
        .unwrap();
    let evidence = result.envelope().plugin.as_ref().unwrap();
    assert_eq!(evidence.authorization_id, grant);
    assert_eq!(evidence.channel.selection(), binding.capability.provider);
    assert_eq!(evidence.result.provider, evidence.channel);
    assert_eq!(
        evidence.result.context.environment_digest,
        approved.digest().unwrap()
    );
    assert_eq!(
        evidence.result.context.dispatch_id,
        result.envelope().dispatch_token.to_string()
    );
    assert_eq!(
        evidence.result.context.project_id,
        input.envelope().project_id.to_string()
    );
    assert_eq!(
        evidence.result.context.attempt_id,
        input.envelope().attempt_id.to_string()
    );
    assert_eq!(
        evidence.result.context.item_id,
        input.envelope().items[0].item_id.to_string()
    );
    assert_eq!(
        result.envelope().output.as_ref(),
        Some(&input.envelope().items[0].payload)
    );
    assert_eq!(
        std::fs::read_dir(stage.path()).unwrap().count(),
        0,
        "owned child/stage cleanup completed before delivery"
    );
    assert!(!store.save_execution_result(&result).unwrap());
    let mut forged = result.envelope().clone();
    forged.result_id = ExecutionId::new();
    forged.plugin.as_mut().unwrap().authorization_id = ExecutionId::new();
    let forged = FixedResult::capture(forged, &input, result.envelope().dispatch_token).unwrap();
    assert_eq!(
        store.save_execution_result(&forged).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    runtime.revoke_plugin(&mut store, grant).unwrap();
    drop(runtime);
    let path = store.directory().to_owned();
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    let restored_input = reopened
        .execution_input(input.envelope().attempt_id)
        .unwrap();
    assert_eq!(restored_input.envelope(), input.envelope());
    assert_eq!(restored_input.bytes(), input.bytes());
    assert_eq!(restored_input.digest(), input.digest());
    let restored_result = reopened
        .execution_result(input.envelope().attempt_id, id)
        .unwrap();
    assert_eq!(restored_result.envelope(), result.envelope());
    assert_eq!(restored_result.bytes(), result.bytes());
    assert_eq!(restored_result.digest(), result.digest());
    let mut runtime = ExecutionRuntime::new(&reopened).unwrap();
    runtime.register(proxy).unwrap();
    assert_eq!(
        runtime.submit(&mut reopened, &input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert!(
        runtime
            .authorize_plugin(
                &mut reopened,
                grant,
                &input,
                expiry(),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                }
            )
            .is_err()
    );
}

#[test]
#[ignore = "requires the exact independently built SDK native-worker example"]
fn native_environment_is_selected_by_the_registered_host_and_never_by_input_claims() {
    let root = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let proxy = proxy(stage.path());
    let mut store = store(root.path());
    let input = input(&store, &proxy);
    let mut altered = input.envelope().clone();
    let sdk::ExecutionEnvironmentDescriptor::Native(environment) =
        &mut altered.plugin.as_mut().unwrap().environment
    else {
        panic!("native environment");
    };
    environment.host_version = "9.0.0".into();
    let wrong = FixedInput::capture(altered).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    let grant = authorize(&runtime, &mut store, &input);
    assert!(runtime.submit(&mut store, &wrong).is_err());
    assert!(
        runtime
            .authorize_plugin(
                &mut store,
                grant,
                &wrong,
                expiry(),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                }
            )
            .is_err()
    );
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    // A Native Host capture cannot be used to launch a JavaScript component.
    let (manifest, files) = native::package();
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(&manifest).unwrap();
    manifest.components[0].runtime = sdk::RuntimeKind::JavaScript;
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    let image = PackageImage::capture(bytes, files, &digest).unwrap();
    let approved = CapturedNativeRuntime::inspect_current().unwrap();
    assert!(
        RunnerProxy::new(
            image,
            "echo",
            CapturedNativeRuntime::capture(&approved).unwrap(),
            stage.path(),
            HostLimits::default()
        )
        .is_err()
    );
}

#[test]
#[ignore = "requires the exact independently built SDK native-worker example"]
fn native_authority_consent_expiry_revocation_and_cancellation_precede_dispatch() {
    for mode in ["revoke", "cancel", "expire"] {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        let proxy = proxy(stage.path());
        let mut store = store(root.path());
        let input = input(&store, &proxy);
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(proxy).unwrap();
        let grant = ExecutionId::new();
        assert_eq!(
            runtime
                .authorize_plugin(
                    &mut store,
                    grant,
                    &input,
                    expiry(),
                    PluginConsent {
                        unsandboxed_execution: false,
                        application_execution: false
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        assert!(
            runtime
                .authorize_plugin(
                    &mut store,
                    grant,
                    &input,
                    1,
                    PluginConsent {
                        unsandboxed_execution: true,
                        application_execution: false
                    }
                )
                .is_err()
        );
        let deadline = if mode == "expire" {
            expiry() - 59_800
        } else {
            expiry()
        };
        runtime
            .authorize_plugin(
                &mut store,
                grant,
                &input,
                deadline,
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
            )
            .unwrap();
        runtime.submit(&mut store, &input).unwrap();
        match mode {
            "revoke" => runtime.revoke_plugin(&mut store, grant).unwrap(),
            "cancel" => {
                store
                    .cancel_execution(input.envelope().task_id, ExecutionId::new())
                    .unwrap();
            }
            "expire" => {
                while SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    < deadline as u128
                {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            _ => unreachable!(),
        }
        runtime.tick(&mut store).unwrap();
        assert_eq!(
            store
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap()
                .items[0]
                .execution,
            ExecutionState::CancelledBeforeDispatch
        );
        assert!(
            store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id
                )
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    }
}

#[test]
#[ignore = "requires the exact independently built SDK native-worker example"]
fn native_success_does_not_bypass_independent_semantic_validation() {
    let root = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let proxy = proxy(stage.path());
    let mut store = store(root.path());
    let input = input(&store, &proxy);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    runtime.register_validator(validator(true)).unwrap();
    authorize(&runtime, &mut store, &input);
    runtime.submit(&mut store, &input).unwrap();
    finish(&mut runtime, &mut store, &input);
    let state = store
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(state.items[0].execution, ExecutionState::Succeeded);
    assert_eq!(state.items[0].validation, ValidationState::Invalid);
    assert_eq!(state.items[0].adoption, AdoptionState::Unapplied);
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
}
