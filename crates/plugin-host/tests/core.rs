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
#[path = "support/runtime.rs"]
mod runtime_fixture;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn package(mode: &str, observer: Option<&Path>) -> (Vec<u8>, BTreeMap<String, PackageFile>) {
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
    (bytes, files)
}
fn image(mode: &str, observer: Option<&Path>) -> PackageImage {
    let (bytes, files) = package(mode, observer);
    let expected = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &expected).unwrap()
}
fn proxy(mode: &str, parent: &Path, observer: Option<&Path>) -> Arc<RunnerProxy> {
    Arc::new(
        RunnerProxy::new(
            image(mode, observer),
            "proposal.call",
            runtime_fixture::approved_runtime(),
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
fn approved_installation_reopens_and_runs_fixed_package_bytes_through_core() {
    use std::os::unix::fs::PermissionsExt;
    use tsumugi_plugin_host::catalog::*;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("approved-package");
    std::fs::create_dir(&root).unwrap();
    let (manifest, files) = package("normal", None);
    let expected_digest = PackageImage::digest(&manifest, &files).unwrap();
    std::fs::write(root.join("manifest.json"), &manifest).unwrap();
    for (name, file) in &files {
        let path = root.join(name);
        std::fs::write(&path, &file.bytes).unwrap();
        std::fs::set_permissions(
            &path,
            std::fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
        )
        .unwrap();
    }
    let expected_plugin = sdk::parse_manifest(&manifest)
        .unwrap()
        .manifest()
        .plugin
        .clone();
    let origin = PackageOrigin {
        source_id: "explicit-offline-test".into(),
        publisher_id: "reviewed-example-source".into(),
    };
    let captured = PackageImage::capture_directory(&root, &expected_digest, || true).unwrap();
    let mut catalog = PackageCatalog::new();
    let approval = PackageApproval {
        plugin: expected_plugin.clone(),
        package_digest: expected_digest.clone(),
        origin: origin.clone(),
    };
    catalog.register(captured, approval.clone()).unwrap();
    let install_root = temporary.path().join("managed-packages");
    std::fs::create_dir(&install_root).unwrap();
    std::fs::set_permissions(&install_root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let action_id = "00000000-0000-4000-8000-000000000001";
    {
        let mut packages = PackageStore::open_existing(&install_root).unwrap();
        let receipt = packages
            .install(
                action_id,
                catalog.registered(&expected_plugin).unwrap(),
                || true,
            )
            .unwrap();
        assert_eq!(receipt.origin(), &origin);
    }
    // A fresh owner reads the durable object rather than the source catalog.
    let packages = PackageStore::open_existing(&install_root).unwrap();
    let installed = packages.load(&approval, || true).unwrap();
    assert_eq!(installed.receipt().action_id(), action_id);
    drop(packages);
    drop(catalog);
    let mut catalog = PackageCatalog::new();
    catalog
        .register(installed.image().clone(), approval)
        .unwrap();
    assert_eq!(
        catalog
            .resolve(
                &contract("example.proposal"),
                None,
                sdk::ProviderSelection::Single,
                &[]
            )
            .unwrap_err(),
        CatalogError::DisabledPackage
    );
    catalog.set_enabled(&expected_plugin, true).unwrap();
    let resolved = catalog
        .resolve(
            &contract("example.proposal"),
            None,
            sdk::ProviderSelection::Single,
            &[sdk::ProviderKey {
                plugin: expected_plugin,
                contribution_id: "proposal.call".into(),
            }],
        )
        .unwrap()
        .remove(0);
    assert_eq!(resolved.package().origin(), &origin);
    // A later source edit is not the code in this immutable resolution. If a
    // launcher reopened the original directory, this would produce invalid data.
    std::fs::write(root.join("behavior.txt"), b"invalid").unwrap();
    assert!(matches!(
        PackageImage::capture_directory(&root, &expected_digest, || true),
        Err(HostError::PackageMismatch)
    ));
    let proxy = Arc::new(
        RunnerProxy::new(
            resolved.package().image().clone(),
            resolved.binding().provider.contribution_id.clone(),
            runtime_fixture::approved_runtime(),
            temporary.path(),
            HostLimits::default(),
        )
        .unwrap(),
    );
    let mut store = store(temporary.path());
    let input = input(&mut store, &proxy);
    assert_eq!(
        input.envelope().plugin.as_ref().unwrap().capability,
        *resolved.binding()
    );
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    runtime.register_validator(validator(false)).unwrap();
    // Enablement and source approval cannot replace the current Core permit.
    assert_eq!(
        runtime.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    authorize(&runtime, &mut store, &input);
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
    assert_eq!(
        result
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .channel
            .package_digest,
        expected_digest
    );
    assert_eq!(
        result.envelope().output,
        Some(json!({"text":"Updated sample", "itemIndex":0}))
    );
    drop(runtime);
    assert_eq!(
        std::fs::read_dir(temporary.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("plugin-instance-"))
            .count(),
        0
    );
    // These two known directories belong only to this isolated fixture. Make
    // them removable after the owned child has been reaped.
    let object = install_root.join("objects").join(&expected_digest);
    for path in [object.join("package"), object] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
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
    let prepared =
        std::thread::spawn(move || capture.prepare(selected_validator.as_ref()).unwrap())
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
                runtime_fixture::approved_runtime(),
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
    envelope
        .plugin
        .as_mut()
        .unwrap()
        .environment
        .host
        .tree_digest = sdk::payload_digest("different runtime");
    let input = FixedInput::capture(envelope).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    assert_eq!(
        runtime
            .authorize_plugin(
                &mut store,
                ExecutionId::new(),
                &input,
                expiry(),
                PluginConsent {
                    unsandboxed_execution: true
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        runtime.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    // The rejected selection never creates an attempt or result row.
    assert!(store.execution_input(input.envelope().attempt_id).is_err());
    assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("plugin-instance-")
    }));
}

fn variant_runtime(label: &str) -> CapturedRuntime {
    fn copy_tree(
        source: &Path,
        destination: &Path,
        files: &mut BTreeMap<String, sdk::RuntimeArtifactFile>,
        prefix: &str,
    ) {
        std::fs::create_dir(destination).unwrap();
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let metadata = std::fs::symlink_metadata(entry.path()).unwrap();
            assert!(
                !metadata.file_type().is_symlink(),
                "fixture requires a clean Host artifact"
            );
            let name = entry.file_name().into_string().unwrap();
            let logical = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if metadata.is_dir() {
                copy_tree(&entry.path(), &destination.join(name), files, &logical);
            } else {
                assert!(metadata.is_file());
                use std::os::unix::fs::PermissionsExt;
                let bytes = std::fs::read(entry.path()).unwrap();
                let executable = metadata.permissions().mode() & 0o111 != 0;
                std::fs::write(destination.join(&name), &bytes).unwrap();
                std::fs::set_permissions(
                    destination.join(name),
                    std::fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
                )
                .unwrap();
                files.insert(logical, sdk::RuntimeArtifactFile { bytes, executable });
            }
        }
    }
    let original = runtime_fixture::approved_runtime();
    let host_source =
        std::path::PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").unwrap());
    let tool_source =
        std::path::PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").unwrap());
    let temporary = tempfile::tempdir().unwrap();
    let host = temporary.path().join("host");
    let mut files = BTreeMap::new();
    copy_tree(&host_source, &host, &mut files, "");
    let mut descriptor = original.descriptor().clone();
    let entry = files.get_mut(&descriptor.host.entrypoint).unwrap();
    let mut bytes = format!("globalThis.__environmentLabel = {label:?}; globalThis.__environmentHost = import.meta.url;\n").into_bytes();
    bytes.extend_from_slice(&entry.bytes);
    entry.bytes = bytes;
    std::fs::write(host.join(&descriptor.host.entrypoint), &entry.bytes).unwrap();
    descriptor.host.tree_digest = sdk::runtime_artifact_digest(&files).unwrap();
    let captured =
        CapturedRuntime::capture_directories(&tool_source, &host, &descriptor, || true).unwrap();
    // Reopening this original path would fail. The captured Host must survive
    // both a later source rewrite and deletion of the entire source tree.
    std::fs::write(
        host.join(&descriptor.host.entrypoint),
        b"throw new Error('changed original Host');",
    )
    .unwrap();
    drop(temporary);
    captured
}

#[test]
fn same_package_runs_two_fixed_node_environments_with_independent_grants() {
    let directory = tempfile::tempdir().unwrap();
    let staging = std::fs::canonicalize(directory.path())
        .unwrap()
        .join("instances");
    std::fs::create_dir(&staging).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700)).unwrap();
    let package = image("environment", None);
    let a = Arc::new(
        RunnerProxy::new(
            package.clone(),
            "proposal.call",
            variant_runtime("A"),
            &staging,
            HostLimits::default(),
        )
        .unwrap(),
    );
    let b = Arc::new(
        RunnerProxy::new(
            package,
            "proposal.call",
            variant_runtime("B"),
            &staging,
            HostLimits::default(),
        )
        .unwrap(),
    );
    let mut store = store(directory.path());
    let input_a = input(&mut store, &a);
    let input_b = input(&mut store, &b);
    let binding_a = input_a.envelope().plugin.as_ref().unwrap();
    let binding_b = input_b.envelope().plugin.as_ref().unwrap();
    assert_eq!(binding_a.capability, binding_b.capability);
    assert_ne!(
        binding_a.environment_digest().unwrap(),
        binding_b.environment_digest().unwrap()
    );
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(b).unwrap();
    runtime.register(a).unwrap();
    runtime.register_validator(validator(false)).unwrap();
    let grant_a = authorize(&runtime, &mut store, &input_a);
    assert_eq!(
        runtime.submit(&mut store, &input_b).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let grant_b = authorize(&runtime, &mut store, &input_b);
    runtime.submit(&mut store, &input_a).unwrap();
    runtime.submit(&mut store, &input_b).unwrap();
    finish(&mut runtime, &mut store, &input_a);
    finish(&mut runtime, &mut store, &input_b);
    let mut channels = Vec::new();
    for (input, label, grant) in [(&input_a, "A", grant_a), (&input_b, "B", grant_b)] {
        let attempt = input.envelope().attempt_id;
        let item = input.envelope().items[0].item_id;
        let result_id = store
            .execution_current_result(attempt, item)
            .unwrap()
            .unwrap();
        let result = store.execution_result(attempt, result_id).unwrap();
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
        assert_eq!(
            evidence.result.context.environment_digest,
            input
                .envelope()
                .plugin
                .as_ref()
                .unwrap()
                .environment_digest()
                .unwrap()
        );
        let output = result.envelope().output.as_ref().unwrap();
        assert_eq!(output["runtime"], label);
        assert_eq!(
            output["nodeVersion"],
            input
                .envelope()
                .plugin
                .as_ref()
                .unwrap()
                .environment
                .tool_version
        );
        let tool = Path::new(output["toolPath"].as_str().unwrap());
        let host_url = output["hostPath"].as_str().unwrap();
        assert!(tool.starts_with(&staging) && tool.ends_with("runtime/tool/bin/node"));
        assert!(host_url.starts_with("file://") && host_url.contains("/runtime/host/dist/main.js"));
        assert!(!tool.exists(), "reaped child's instance is reclaimed");
        let state = store.execution_attempt(attempt, false).unwrap();
        assert_eq!(state.items[0].validation, ValidationState::Valid);
        assert_eq!(state.items[0].adoption, AdoptionState::Unapplied);
        channels.push(evidence.channel.instance_id.clone());
    }
    assert_ne!(channels[0], channels[1]);
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
}
