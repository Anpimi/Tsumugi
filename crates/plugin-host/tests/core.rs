#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{
    ProjectMetadata, ProjectStore,
    execution::{
        test_support::{self, FixtureMode, SampleHandler},
        *,
    },
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn image(mode: &str, observer: Option<&Path>) -> PackageImage {
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: "example.core".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![sdk::PermissionRequest::CapturedInput],
        components: vec![sdk::ComponentDeclaration {
            id: "proposal".into(),
            scope: sdk::ComponentScope::Project,
            runtime: sdk::RuntimeKind::JavaScript,
            entrypoint: Some("component.mjs".into()),
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 300,
                cleanup_timeout_ms: 500,
            },
        }],
        contributions: vec![sdk::ContributionDeclaration {
            id: "proposal.call".into(),
            component_id: "proposal".into(),
            contribution: sdk::ContributionKind::Capability {
                declaration: sdk::CapabilityDeclaration {
                    contract: contract("example.proposal"),
                    input_schema: contract("example.input"),
                    output_schema: contract("example.output"),
                    error_schema: contract("example.error"),
                    profiles: vec![],
                    effect: sdk::EffectKind::ReadOnly,
                    permissions: vec![sdk::PermissionRequest::CapturedInput],
                    limits: sdk::CapabilityLimits {
                        max_input_bytes: 65536,
                        max_output_bytes: 65536,
                        concurrency: 1,
                        timeout_ms: 2000,
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
                bytes: include_bytes!("support/core-component.mjs").to_vec(),
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
fn proxy(mode: &str, parent: &Path, observer: Option<&Path>) -> Arc<RunnerProxy> {
    Arc::new(
        RunnerProxy::new(
            image(mode, observer),
            "proposal.call",
            sdk::payload_digest("verified runtime"),
            RuntimeLauncher::JavaScript {
                approved_node: std::env::var_os("TSUMUGI_TEST_NODE")
                    .expect("actual Node path required")
                    .into(),
                approved_bootstrap: std::env::var_os("TSUMUGI_TEST_JS_HOST_BOOTSTRAP")
                    .expect("actual built bootstrap required")
                    .into(),
            },
            parent.to_path_buf(),
            HostLimits {
                invocation_timeout_ms: 2000,
                ..Default::default()
            },
        )
        .unwrap(),
    )
}
fn store(dir: &Path) -> ProjectStore {
    let metadata = ProjectMetadata::create("Synthetic plugin", "en", ["zh-CN"]).unwrap();
    ProjectStore::create(dir.join("project"), metadata).unwrap()
}
fn input(store: &mut ProjectStore, proxy: &RunnerProxy) -> FixedInput {
    let original = test_support::input(store, FixtureMode::Success, 0, false).unwrap();
    let mut e = original.envelope().clone();
    e.items.retain(|item| item.payload["index"] == 0);
    e.units = vec![AdoptionUnit::new(vec![e.items[0].item_id])];
    e.capability_id = proxy.capability_id().into();
    e.capability_version = proxy.capability_version().into();
    e.plugin = Some(proxy.execution_binding(None).unwrap());
    FixedInput::capture(e).unwrap()
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
            },
        )
        .unwrap();
    grant
}
fn finish(runtime: &mut ExecutionRuntime, store: &mut ProjectStore, input: &FixedInput) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(input.envelope().attempt_id)
            && store
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap()
                .items
                .iter()
                .all(|i| {
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
            "Core process completion deadline"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
struct Validator {
    owner: std::thread::ThreadId,
    reject: bool,
}
impl ResultValidator for Validator {
    fn operation(&self) -> &str {
        "sample-update"
    }
    fn validate(&self, input: &FixedInput, result: &FixedResult) -> Result<(), ExecutionError> {
        assert_ne!(
            self.owner,
            std::thread::current().id(),
            "semantic validation must run off the project thread"
        );
        let output = result.envelope().output.as_ref().unwrap();
        if self.reject
            || output["text"] != "Updated sample"
            || output["itemIndex"] != input.item(result.envelope().item_id)?.payload["index"]
        {
            return Err(ExecutionError::new(
                ErrorCode::OutputInvalid,
                "independent-proposal-check",
            ));
        }
        Ok(())
    }
}
fn validator(reject: bool) -> Arc<Validator> {
    Arc::new(Validator {
        owner: std::thread::current().id(),
        reject,
    })
}
fn action(store: &mut ProjectStore, input: &FixedInput) -> AdoptionAction {
    let result = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            json!({}),
        )
        .unwrap()
}

#[test]
fn actual_process_selection_provenance_validation_and_explicit_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store(dir.path());
    let selected = proxy("normal", dir.path(), None);
    let other = proxy("invalid", dir.path(), None);
    let input = input(&mut store, &selected);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(other).unwrap();
    runtime.register(selected).unwrap();
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
    assert_eq!(state.items[0].validation, ValidationState::Valid);
    assert_eq!(state.items[0].adoption, AdoptionState::Unapplied);
    let action = action(&mut store, &input);
    let result = store
        .execution_result(action.attempt_id, action.result_ids[0])
        .unwrap();
    let evidence = result.envelope().plugin.as_ref().unwrap();
    assert_eq!(evidence.authorization_id, grant);
    assert_eq!(
        evidence.channel.selection(),
        input
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .capability
            .provider
    );
    let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
        panic!("actual process output required")
    };
    assert_eq!(
        output.utf8,
        "{\r\n  \"text\":\"Updated sample\", \"itemIndex\":0\r\n}"
    );
    let mut forged = result.envelope().clone();
    forged.result_id = ExecutionId::new();
    forged.plugin.as_mut().unwrap().authorization_id = ExecutionId::new();
    let forged = FixedResult::capture(forged, &input, result.envelope().dispatch_token).unwrap();
    assert_eq!(
        store.save_execution_result(&forged).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert!(!store.save_execution_result(&result).unwrap());
    let prepared = store
        .capture_execution_adoption(&action)
        .unwrap()
        .prepare(&SampleHandler)
        .unwrap();
    let receipt = store.commit_execution_adoption(prepared).unwrap();
    assert_eq!(receipt.changes.len(), 1);
    runtime.revoke_plugin(&mut store, grant).unwrap();
    assert_eq!(
        store.adopt_execution(&action, &SampleHandler).unwrap(),
        receipt
    );
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .execution_result(action.attempt_id, action.result_ids[0])
            .unwrap()
            .bytes(),
        result.bytes()
    );
    assert_eq!(
        reopened
            .adoption_receipt(action.action_id)
            .unwrap()
            .unwrap(),
        receipt
    );
}

#[test]
fn missing_validator_stays_pending_and_checked_preparation_cannot_outlive_grant() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store(dir.path());
    let proxy = proxy("normal", dir.path(), None);
    let input = input(&mut store, &proxy);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    let grant = authorize(&runtime, &mut store, &input);
    runtime.submit(&mut store, &input).unwrap();
    finish(&mut runtime, &mut store, &input);
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Pending
    );
    let action = action(&mut store, &input);
    assert!(store.capture_execution_adoption(&action).is_err());
    assert_eq!(
        store
            .validate_execution_result(action.attempt_id, action.result_ids[0])
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let capture = store
        .capture_result_validation(action.attempt_id, action.result_ids[0])
        .unwrap();
    let selected_validator = validator(false);
    let prepared = std::thread::spawn(move || capture.prepare(selected_validator.as_ref()).unwrap())
        .join()
        .unwrap();
    store.commit_result_validation(prepared).unwrap();
    let prepared = store
        .capture_execution_adoption(&action)
        .unwrap()
        .prepare(&SampleHandler)
        .unwrap();
    let capture = store
        .capture_result_validation(action.attempt_id, action.result_ids[0])
        .unwrap();
    let rejecting = validator(true);
    let revalidation = std::thread::spawn(move || capture.prepare(rejecting.as_ref()).unwrap())
        .join()
        .unwrap();
    runtime.revoke_plugin(&mut store, grant).unwrap();
    assert_eq!(
        store
            .commit_result_validation(revalidation)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store.commit_execution_adoption(prepared).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
}

#[test]
fn semantically_wrong_or_duplicate_json_output_never_becomes_adoptable() {
    for mode in ["invalid", "duplicate"] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store(dir.path());
        let proxy = proxy(mode, dir.path(), None);
        let input = input(&mut store, &proxy);
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(proxy).unwrap();
        runtime.register_validator(validator(false)).unwrap();
        authorize(&runtime, &mut store, &input);
        runtime.submit(&mut store, &input).unwrap();
        finish(&mut runtime, &mut store, &input);
        let state = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        assert_eq!(
            state.items[0].validation,
            if mode == "invalid" {
                ValidationState::Invalid
            } else {
                ValidationState::Absent
            }
        );
        assert_eq!(state.items[0].adoption, AdoptionState::Unapplied);
    }
}

#[test]
fn live_revocation_cancel_and_store_close_discard_late_process_output() {
    for mode in ["revoke", "cancel", "close"] {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("entered");
        let mut store = store(dir.path());
        let proxy = proxy("late", dir.path(), Some(&marker));
        let input = input(&mut store, &proxy);
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(proxy).unwrap();
        runtime.register_validator(validator(false)).unwrap();
        let grant = authorize(&runtime, &mut store, &input);
        runtime.submit(&mut store, &input).unwrap();
        runtime.tick(&mut store).unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        while !marker.is_file() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        if mode == "close" {
            store.close().unwrap();
            std::thread::sleep(Duration::from_millis(600));
            drop(runtime);
            let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
            assert!(
                reopened
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id
                    )
                    .unwrap()
                    .is_none()
            );
        } else {
            if mode == "cancel" {
                store
                    .cancel_execution(input.envelope().task_id, ExecutionId::new())
                    .unwrap();
            } else {
                runtime.revoke_plugin(&mut store, grant).unwrap();
            }
            finish(&mut runtime, &mut store, &input);
            assert!(
                store
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id
                    )
                    .unwrap()
                    .is_none()
            );
        }
    }
}

#[test]
fn grant_identity_expiry_epoch_and_reopen_never_renew_execution() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store(dir.path());
    let proxy = proxy("normal", dir.path(), None);
    let input = input(&mut store, &proxy);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy.clone()).unwrap();
    let grant = ExecutionId::new();
    let expires = expiry();
    let consent = PluginConsent {
        unsandboxed_execution: true,
    };
    assert_eq!(
        runtime
            .authorize_plugin(
                &mut store,
                grant,
                &input,
                expires,
                PluginConsent {
                    unsandboxed_execution: false
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        runtime
            .authorize_plugin(&mut store, grant, &input, 1, consent)
            .is_err()
    );
    runtime
        .authorize_plugin(&mut store, grant, &input, expires, consent)
        .unwrap();
    runtime
        .authorize_plugin(&mut store, grant, &input, expires, consent)
        .unwrap();
    assert!(
        runtime
            .authorize_plugin(&mut store, grant, &input, expires + 1, consent)
            .is_err()
    );
    runtime.submit(&mut store, &input).unwrap();
    let mut replacement = ExecutionRuntime::new(&store).unwrap();
    replacement.register(proxy.clone()).unwrap();
    assert!(runtime.submit(&mut store, &input).is_err());
    drop(runtime);
    assert_eq!(
        replacement.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    drop(replacement);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    let mut runtime = ExecutionRuntime::new(&reopened).unwrap();
    runtime.register(proxy).unwrap();
    assert!(
        runtime
            .authorize_plugin(&mut reopened, grant, &input, expires, consent)
            .is_err()
    );
    runtime.tick(&mut reopened).unwrap();
    assert!(
        reopened
            .execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn expired_or_revoked_queued_grant_never_stages_a_process() {
    for expired in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store(dir.path());
        let proxy = proxy("normal", dir.path(), None);
        let input = input(&mut store, &proxy);
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(proxy).unwrap();
        let grant = ExecutionId::new();
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + if expired { 50 } else { 60_000 };
        runtime
            .authorize_plugin(
                &mut store,
                grant,
                &input,
                deadline,
                PluginConsent {
                    unsandboxed_execution: true,
                },
            )
            .unwrap();
        runtime.submit(&mut store, &input).unwrap();
        if expired {
            std::thread::sleep(Duration::from_millis(70));
        } else {
            runtime.revoke_plugin(&mut store, grant).unwrap();
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
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("plugin-instance-")
        }));
        assert!(
            store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id
                )
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn old_runtime_cannot_dispatch_or_quiesce_new_generation_work() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store(dir.path());
    let proxy = proxy("normal", dir.path(), None);
    let input = input(&mut store, &proxy);
    let mut old = ExecutionRuntime::new(&store).unwrap();
    old.register(proxy.clone()).unwrap();
    let mut fresh = ExecutionRuntime::new(&store).unwrap();
    fresh.register(proxy).unwrap();
    fresh.register_validator(validator(false)).unwrap();
    authorize(&fresh, &mut store, &input);
    fresh.submit(&mut store, &input).unwrap();
    old.tick(&mut store).unwrap();
    assert!(!old.is_active(input.envelope().attempt_id));
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .execution,
        ExecutionState::Queued
    );
    assert_eq!(
        old.begin_quiesce(&mut store).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    drop(old);
    finish(&mut fresh, &mut store, &input);
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Valid
    );
}

#[test]
fn smaller_transport_runs_small_proposals_and_enforces_its_own_budget() {
    for mode in ["normal", "oversize"] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store(dir.path());
        let proxy = Arc::new(
            RunnerProxy::new(
                image(mode, None),
                "proposal.call",
                sdk::payload_digest("verified runtime"),
                RuntimeLauncher::JavaScript {
                    approved_node: std::env::var_os("TSUMUGI_TEST_NODE").unwrap().into(),
                    approved_bootstrap: std::env::var_os("TSUMUGI_TEST_JS_HOST_BOOTSTRAP")
                        .unwrap()
                        .into(),
                },
                dir.path().to_path_buf(),
                HostLimits {
                    max_frame_bytes: 16 * 1024,
                    invocation_timeout_ms: 2000,
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let input = input(&mut store, &proxy);
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(proxy).unwrap();
        runtime.register_validator(validator(false)).unwrap();
        authorize(&runtime, &mut store, &input);
        runtime.submit(&mut store, &input).unwrap();
        finish(&mut runtime, &mut store, &input);
        let state = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        assert_eq!(
            state.items[0].validation,
            if mode == "normal" {
                ValidationState::Valid
            } else {
                ValidationState::Absent
            }
        );
    }
}

#[test]
fn failed_unknown_and_crashed_processes_keep_distinct_nonpassing_evidence() {
    for mode in ["failed", "unknown", "crash"] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store(dir.path());
        let proxy = proxy(mode, dir.path(), None);
        let input = input(&mut store, &proxy);
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(proxy).unwrap();
        authorize(&runtime, &mut store, &input);
        runtime.submit(&mut store, &input).unwrap();
        finish(&mut runtime, &mut store, &input);
        let state = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        assert_eq!(
            state.items[0].execution,
            if mode == "failed" {
                ExecutionState::Failed
            } else {
                ExecutionState::Unknown
            }
        );
        assert_eq!(state.items[0].validation, ValidationState::Absent);
        assert!(!state.items[0].retry_safe);
        if mode == "crash" {
            assert_eq!(state.items[0].diagnostic.as_deref(), Some("plugin-crashed"));
            assert!(
                store
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id
                    )
                    .unwrap()
                    .is_none()
            );
        } else {
            let result_id = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
            let result = store
                .execution_result(input.envelope().attempt_id, result_id)
                .unwrap();
            let outcome = &result.envelope().plugin.as_ref().unwrap().result.outcome;
            let error = match outcome {
                sdk::InvocationOutcome::Failed { error }
                | sdk::InvocationOutcome::Unknown { error } => error,
                _ => panic!("nonpassing SDK evidence"),
            };
            assert_eq!(error.utf8, "{\r\n\"reason\":\"synthetic\"\r\n}");
            if mode == "unknown" {
                let query = runtime
                    .outcome_query(
                        &store,
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id,
                    )
                    .unwrap()
                    .unwrap();
                assert!(matches!(query.run().unwrap(), QueryOutcome::Unavailable));
            }
        }
    }
}

#[test]
fn altered_installer_environment_is_rejected_before_staging() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store(dir.path());
    let proxy = proxy("normal", dir.path(), None);
    let original = input(&mut store, &proxy);
    let mut envelope = original.envelope().clone();
    envelope.plugin.as_mut().unwrap().environment_digest = sdk::payload_digest("different runtime");
    let input = FixedInput::capture(envelope).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    authorize(&runtime, &mut store, &input);
    runtime.submit(&mut store, &input).unwrap();
    finish(&mut runtime, &mut store, &input);
    assert!(
        store
            .execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id
            )
            .unwrap()
            .is_none()
    );
    assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("plugin-instance-")
    }));
}
