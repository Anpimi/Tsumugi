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
                application_execution: false,
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
    // This known envelope belongs only to this isolated fixture. Make it
    // removable after the owned child has been reaped; the payload is one file.
    let object = install_root.join("objects").join(&expected_digest);
    std::fs::set_permissions(object, std::fs::Permissions::from_mode(0o700)).unwrap();
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
        application_execution: false,
    };
    assert_eq!(
        runtime
            .authorize_plugin(
                &mut store,
                grant,
                &input,
                expires,
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
                    application_execution: false,
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
fn timeout_stage_preserves_ready_and_invoke_expiry_in_durable_unknown_history() {
    for (mode, expected) in [
        ("wait-ready", "plugin-timeout-ready"),
        ("wait-invoke", "plugin-timeout-invoke"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store(dir.path());
        let proxy = Arc::new(
            RunnerProxy::new(
                image(mode, None),
                "proposal.call",
                runtime_fixture::approved_runtime(),
                dir.path(),
                HostLimits {
                    handshake_timeout_ms: 3000,
                    invocation_timeout_ms: 100,
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let mut envelope = input(&mut store, &proxy).envelope().clone();
        envelope.limits.timeout_ms = 30000;
        let input = FixedInput::capture(envelope).unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(proxy).unwrap();
        authorize(&runtime, &mut store, &input);
        runtime.submit(&mut store, &input).unwrap();
        finish(&mut runtime, &mut store, &input);
        let state = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        assert_eq!(state.items[0].execution, ExecutionState::Unknown);
        assert_eq!(state.items[0].validation, ValidationState::Absent);
        assert_eq!(state.items[0].adoption, AdoptionState::Unapplied);
        assert_eq!(state.items[0].diagnostic.as_deref(), Some(expected));
        assert!(!state.items[0].retry_safe);
        assert!(
            store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id
                )
                .unwrap()
                .is_none()
        );
        drop(runtime);
        store.close().unwrap();
        let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
        assert_eq!(
            reopened
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap()
                .items[0]
                .diagnostic
                .as_deref(),
            Some(expected)
        );
    }
}

#[test]
fn timeout_stage_keeps_original_deadline_and_cancellation_priority_before_launch() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store(dir.path());
    let proxy = proxy("normal", dir.path(), None);
    let mut envelope = input(&mut store, &proxy).envelope().clone();
    envelope.limits.timeout_ms = 20;
    let input = FixedInput::capture(envelope).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy.clone()).unwrap();
    authorize(&runtime, &mut store, &input);
    store.enqueue_execution(&input).unwrap();
    let dispatch = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(25));
    assert!(Instant::now() >= dispatch.deadline().unwrap());
    let (results, receiver) = result_channel();
    let error = proxy
        .run(dispatch.clone(), Cancellation::default(), results)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::OutcomeUnknown);
    assert_eq!(error.stage, "plugin-timeout-dispatch");
    assert!(receiver.try_recv().is_err());
    let cancellation = Cancellation::default();
    cancellation.request();
    let (results, _) = result_channel();
    let error = proxy.run(dispatch, cancellation, results).unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert_eq!(error.stage, "plugin-cancelled");
    assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("plugin-instance-")
    }));
}

#[test]
fn altered_installer_environment_is_rejected_before_staging() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store(dir.path());
    let proxy = proxy("normal", dir.path(), None);
    let original = input(&mut store, &proxy);
    let mut envelope = original.envelope().clone();
    let sdk::ExecutionEnvironmentDescriptor::Captured(environment) =
        &mut envelope.plugin.as_mut().unwrap().environment
    else {
        panic!("expected captured Node fixture");
    };
    environment.host.tree_digest = sdk::payload_digest("different runtime");
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
                    unsandboxed_execution: true,
                    application_execution: false
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

fn variant_runtime_source(
    label: &str,
) -> (
    CapturedRuntime,
    sdk::RuntimeEnvironmentDescriptor,
    tempfile::TempDir,
) {
    fn copy_tree(
        source: &Path,
        destination: &Path,
        files: &mut BTreeMap<String, sdk::RuntimeArtifactFile>,
        prefix: &str,
    ) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir(destination).unwrap();
        std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o700)).unwrap();
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
    let approval_source =
        std::path::PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL").unwrap());
    let mut descriptor: sdk::RuntimeEnvironmentDescriptor =
        serde_json::from_slice(&std::fs::read(approval_source).unwrap()).unwrap();
    let host_source =
        std::path::PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").unwrap());
    let tool_source =
        std::path::PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").unwrap());
    let temporary = tempfile::tempdir().unwrap();
    let host = temporary.path().join("host");
    let mut files = BTreeMap::new();
    copy_tree(&host_source, &host, &mut files, "");
    let entry = files.get_mut(&descriptor.host.entrypoint).unwrap();
    let mut bytes = format!("globalThis.__environmentLabel = {label:?}; globalThis.__environmentHost = import.meta.url;\n").into_bytes();
    bytes.extend_from_slice(&entry.bytes);
    entry.bytes = bytes;
    std::fs::write(host.join(&descriptor.host.entrypoint), &entry.bytes).unwrap();
    descriptor.host.tree_digest = sdk::runtime_artifact_digest(&files).unwrap();
    let captured =
        CapturedRuntime::capture_directories(&tool_source, &host, &descriptor, || true).unwrap();
    (captured, descriptor, temporary)
}

fn variant_runtime(label: &str) -> (CapturedRuntime, sdk::RuntimeEnvironmentDescriptor) {
    let (captured, descriptor, temporary) = variant_runtime_source(label);
    // Reopening this original path would fail. The captured Host must survive
    // both a later source rewrite and deletion of the entire source tree.
    std::fs::write(
        temporary
            .path()
            .join("host")
            .join(&descriptor.host.entrypoint),
        b"throw new Error('changed original Host');",
    )
    .unwrap();
    drop(temporary);
    (captured, descriptor)
}

// Only isolated fixture directories are made removable after releasing their
// store and reaping every owned child; this is not a package-store operation.
fn make_removable_installation_fixture(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::symlink_metadata(path).unwrap();
    assert!(!metadata.file_type().is_symlink());
    if metadata.is_dir() {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        for entry in std::fs::read_dir(path).unwrap() {
            make_removable_installation_fixture(&entry.unwrap().path());
        }
    } else {
        assert!(metadata.is_file());
    }
}

#[test]
fn approved_runtime_installation_reopens_and_runs_without_acquisition_paths() {
    use std::os::unix::fs::PermissionsExt;
    use tsumugi_plugin_host::catalog::PackageOrigin;

    let directory = tempfile::tempdir().unwrap();
    let staging = std::fs::canonicalize(directory.path())
        .unwrap()
        .join("instances");
    let install_root = directory.path().join("managed-runtime");
    for root in [&staging, &install_root] {
        std::fs::create_dir(root).unwrap();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    // This descriptor is computed from the trusted Host fixture before capture,
    // independently of the installation receipt. The official tool stays read-only.
    let (captured, descriptor, acquisition) = variant_runtime_source("installed");
    let approval = RuntimeApproval {
        environment: descriptor.into(),
        origin: PackageOrigin {
            source_id: "explicit-offline-runtime-test".into(),
            publisher_id: "reviewed-runtime-source".into(),
        },
    };
    let expected_digest = approval.environment.digest().unwrap();
    let action_id = "00000000-0000-4000-8000-000000000002";
    let receipt = {
        let mut packages = PackageStore::open_existing(&install_root).unwrap();
        packages
            .install_runtime(action_id, &captured, &approval, || true)
            .unwrap()
    };
    assert_eq!(receipt.action_id(), action_id);
    assert_eq!(receipt.approval(), &approval);
    assert_eq!(receipt.environment_digest(), expected_digest);
    drop(captured);
    let original_host = acquisition.path().join("host");
    std::fs::write(
        original_host.join(&approval.captured_environment().unwrap().host.entrypoint),
        b"throw new Error('changed original Host');",
    )
    .unwrap();
    drop(acquisition);
    assert!(!original_host.exists());

    let packages = PackageStore::open_existing(&install_root).unwrap();
    // Receipt metadata cannot replace the independent live approval guard.
    assert!(matches!(
        packages.load_runtime(receipt.approval(), || false),
        Err(InstallError::AuthorityRevoked)
    ));
    let mut wrong_origin = approval.clone();
    wrong_origin.origin.source_id = "different-runtime-source".into();
    assert!(packages.load_runtime(&wrong_origin, || true).is_err());
    let mut wrong_environment = approval.clone();
    let sdk::ExecutionEnvironmentDescriptor::Captured(environment) =
        &mut wrong_environment.environment
    else {
        panic!("expected captured Node fixture");
    };
    environment.host.tree_digest = sdk::payload_digest("different runtime");
    assert!(packages.load_runtime(&wrong_environment, || true).is_err());
    let installed = packages.load_runtime(&approval, || true).unwrap();
    assert_eq!(installed.receipt(), &receipt);
    assert_eq!(
        installed.runtime().descriptor(),
        approval.captured_environment().unwrap()
    );
    assert_eq!(installed.runtime().environment_digest(), expected_digest);
    drop(packages);

    let proxy = Arc::new(
        RunnerProxy::new(
            image("environment", None),
            "proposal.call",
            installed.runtime().clone(),
            &staging,
            HostLimits::default(),
        )
        .unwrap(),
    );
    drop(installed);
    let mut store = store(directory.path());
    let input = input(&mut store, &proxy);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    runtime.register_validator(validator(false)).unwrap();
    // Loading durable bytes and registering a runner do not authorize Core.
    assert_eq!(
        runtime.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert!(store.execution_input(input.envelope().attempt_id).is_err());

    // Authorize only after the bounded installation and load have completed.
    let grant = authorize(&runtime, &mut store, &input);
    let mut wrong_envelope = input.envelope().clone();
    wrong_envelope.plugin.as_mut().unwrap().environment = wrong_environment.environment;
    let wrong_input = FixedInput::capture(wrong_envelope).unwrap();
    assert_eq!(
        runtime
            .authorize_plugin(
                &mut store,
                ExecutionId::new(),
                &wrong_input,
                expiry(),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                },
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        runtime.submit(&mut store, &wrong_input).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    runtime.submit(&mut store, &input).unwrap();
    finish(&mut runtime, &mut store, &input);
    let attempt = input.envelope().attempt_id;
    let item = input.envelope().items[0].item_id;
    let dispatch = store.execution_dispatch(attempt, item).unwrap();
    let permit = dispatch.plugin_permit().unwrap();
    assert_eq!(permit.grant_id(), grant);
    assert!(permit.matches(&input));
    assert!(!permit.matches(&wrong_input));
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
    assert_eq!(evidence.result.context.environment_digest, expected_digest);
    let output = result.envelope().output.as_ref().unwrap();
    assert_eq!(output["runtime"], "installed");
    assert_eq!(
        output["nodeVersion"],
        approval.captured_environment().unwrap().tool_version
    );
    let tool = Path::new(output["toolPath"].as_str().unwrap());
    let host_url = output["hostPath"].as_str().unwrap();
    assert!(tool.starts_with(&staging) && tool.ends_with("runtime/tool/bin/node"));
    assert!(host_url.starts_with("file://") && host_url.contains("/runtime/host/dist/main.js"));
    assert!(!tool.exists(), "reaped child's instance is reclaimed");
    let state = store.execution_attempt(attempt, false).unwrap();
    assert_eq!(state.items[0].execution, ExecutionState::Succeeded);
    assert_eq!(state.items[0].validation, ValidationState::Valid);
    assert_eq!(state.items[0].adoption, AdoptionState::Unapplied);
    drop(runtime);
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);

    make_removable_installation_fixture(&install_root);
}

#[test]
fn same_package_runs_two_fixed_node_environments_with_independent_grants() {
    use std::os::unix::fs::PermissionsExt;
    use tsumugi_plugin_host::catalog::PackageOrigin;
    let directory = tempfile::tempdir().unwrap();
    let staging = std::fs::canonicalize(directory.path())
        .unwrap()
        .join("instances");
    let install_root = directory.path().join("managed-runtimes");
    for root in [&staging, &install_root] {
        std::fs::create_dir(root).unwrap();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let (captured_a, descriptor_a) = variant_runtime("A");
    let (captured_b, descriptor_b) = variant_runtime("B");
    let origin = PackageOrigin {
        source_id: "explicit-offline-runtime-test".into(),
        publisher_id: "reviewed-runtime-source".into(),
    };
    // Both approvals precede installation and come from the independent
    // descriptor plus each actual Host tree, never from an install receipt.
    let approval_a = RuntimeApproval {
        environment: descriptor_a.into(),
        origin: origin.clone(),
    };
    let approval_b = RuntimeApproval {
        environment: descriptor_b.into(),
        origin,
    };
    let action_a = "00000000-0000-4000-8000-000000000003";
    let action_b = "00000000-0000-4000-8000-000000000004";
    {
        let mut packages = PackageStore::open_existing(&install_root).unwrap();
        let receipt_a = packages
            .install_runtime(action_a, &captured_a, &approval_a, || true)
            .unwrap();
        let receipt_b = packages
            .install_runtime(action_b, &captured_b, &approval_b, || true)
            .unwrap();
        assert_eq!(receipt_a.action_id(), action_a);
        assert_eq!(receipt_b.action_id(), action_b);
        assert_ne!(
            receipt_a.environment_digest(),
            receipt_b.environment_digest()
        );
    }
    drop(captured_a);
    drop(captured_b);
    let packages = PackageStore::open_existing(&install_root).unwrap();
    let installed_a = packages.load_runtime(&approval_a, || true).unwrap();
    let installed_b = packages.load_runtime(&approval_b, || true).unwrap();
    assert_eq!(installed_a.receipt().action_id(), action_a);
    assert_eq!(installed_b.receipt().action_id(), action_b);
    assert_eq!(
        installed_a.runtime().descriptor(),
        approval_a.captured_environment().unwrap()
    );
    assert_eq!(
        installed_b.runtime().descriptor(),
        approval_b.captured_environment().unwrap()
    );
    drop(packages);
    let package = image("environment", None);
    let a = Arc::new(
        RunnerProxy::new(
            package.clone(),
            "proposal.call",
            installed_a.runtime().clone(),
            &staging,
            HostLimits::default(),
        )
        .unwrap(),
    );
    let b = Arc::new(
        RunnerProxy::new(
            package,
            "proposal.call",
            installed_b.runtime().clone(),
            &staging,
            HostLimits::default(),
        )
        .unwrap(),
    );
    drop(installed_a);
    drop(installed_b);
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
            match &input.envelope().plugin.as_ref().unwrap().environment {
                sdk::ExecutionEnvironmentDescriptor::Captured(environment) =>
                    environment.tool_version.as_str(),
                sdk::ExecutionEnvironmentDescriptor::Native(_) =>
                    panic!("expected captured Node fixture"),
            }
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
    drop(runtime);
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    make_removable_installation_fixture(&install_root);
}

struct DispatchServiceFactory {
    selected: Arc<std::sync::Mutex<Vec<(ExecutionId, ExecutionId, ExecutionId)>>>,
    calls: Arc<std::sync::Mutex<Vec<(ExecutionId, String)>>>,
    released: Arc<std::sync::atomic::AtomicUsize>,
    pending: bool,
}
impl tsumugi_plugin_host::core::ProjectServiceFactory for DispatchServiceFactory {
    fn capture(
        &self,
        request: DispatchRequest,
        permit: PluginPermit,
        cancellation: Cancellation,
    ) -> tsumugi_plugin_host::core::ProjectServiceSelectionFuture {
        assert!(permit.matches(&request.input) && permit.is_authorized());
        self.selected.lock().unwrap().push((
            request.input.envelope().attempt_id,
            request.dispatch_token,
            permit.grant_id(),
        ));
        if self.pending {
            return Box::pin(std::future::pending());
        }
        let project = request.input.envelope().project_id.to_string();
        let binding = sdk::ServiceBinding {
            handle_id: request.input.envelope().attempt_id.to_string(),
            provider_id: "example.dispatch-service".into(),
            contract: contract("example.service"),
            input_schema: contract("example.service-input"),
            output_schema: contract("example.service-output"),
            error_schema: contract("example.service-error"),
            effect: sdk::EffectKind::ReadOnly,
            project_id: project.clone(),
            scope_id: project,
            activation_generation: 1,
            configuration_digest: request.input.digest().into(),
            limits: sdk::CapabilityLimits {
                max_input_bytes: 1024,
                max_output_bytes: 1024,
                concurrency: 1,
                timeout_ms: 500,
            },
        };
        let broker: Arc<dyn ProjectServiceBroker> = Arc::new(DispatchServiceBroker {
            bindings: vec![binding],
            request,
            permit,
            cancellation,
            calls: self.calls.clone(),
            released: self.released.clone(),
        });
        Box::pin(async move { Ok(broker) })
    }
}
struct DispatchServiceBroker {
    bindings: Vec<sdk::ServiceBinding>,
    request: DispatchRequest,
    permit: PluginPermit,
    cancellation: Cancellation,
    calls: Arc<std::sync::Mutex<Vec<(ExecutionId, String)>>>,
    released: Arc<std::sync::atomic::AtomicUsize>,
}
impl ProjectServiceBroker for DispatchServiceBroker {
    fn bindings(&self) -> &[sdk::ServiceBinding] {
        &self.bindings
    }
    fn is_current(&self, binding: &sdk::ServiceBinding) -> bool {
        self.bindings.contains(binding)
            && self.permit.matches(&self.request.input)
            && self.permit.is_authorized()
            && !self.cancellation.is_requested()
    }
    fn call<'a>(
        &'a self,
        caller: ServiceCaller,
        binding: sdk::ServiceBinding,
        request: sdk::ServiceRequest,
    ) -> ProjectServiceFuture<'a> {
        assert!(self.is_current(&binding));
        assert_eq!(
            caller.context().attempt_id,
            self.request.input.envelope().attempt_id.to_string()
        );
        assert_eq!(
            caller.context().dispatch_id,
            self.request.dispatch_token.to_string()
        );
        let expected = self
            .request
            .input
            .plugin_request(
                self.request.item_id,
                self.request.dispatch_token,
                &caller.channel().provider,
            )
            .unwrap();
        assert_eq!(caller.context().input_digest, expected.context.input_digest);
        request
            .validate_against(&binding, caller.context())
            .unwrap();
        self.calls.lock().unwrap().push((
            self.permit.grant_id(),
            caller.channel().provider.instance_id.clone(),
        ));
        Box::pin(async move {
            Ok(sdk::ServiceResponse {
                call_id: request.call_id,
                handle_id: request.handle_id,
                context: request.context,
                outcome: sdk::InvocationOutcome::Succeeded {
                    output: sdk::EncodedPayload::capture(
                        binding.output_schema,
                        self.permit.grant_id().to_string(),
                    )
                    .unwrap(),
                },
            })
        })
    }
    fn release_channel(&self, _channel: &ChannelReceipt) {
        self.released
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }
}
fn service_proxy(
    parent: &Path,
    factory: Arc<DispatchServiceFactory>,
    timeout_ms: u32,
) -> Arc<RunnerProxy> {
    let (bytes, mut files) = package("normal", None);
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(&bytes).unwrap();
    let permission = sdk::PermissionRequest::ProjectService {
        contract: contract("example.service"),
    };
    manifest.permissions.push(permission.clone());
    manifest.components[0]
        .dependencies
        .push(sdk::CapabilityDependency {
            contract: contract("example.service"),
            required: true,
            selection: sdk::ProviderSelection::Single,
        });
    if let sdk::ContributionKind::Capability { declaration } =
        &mut manifest.contributions[0].contribution
    {
        declaration.permissions.push(permission);
    }
    files.get_mut("component.mjs").unwrap().bytes =
        include_bytes!("support/core-service-component.mjs").to_vec();
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    Arc::new(
        RunnerProxy::new(
            PackageImage::capture(bytes, files, &digest).unwrap(),
            "proposal.call",
            runtime_fixture::approved_runtime(),
            parent,
            HostLimits {
                handshake_timeout_ms: timeout_ms,
                invocation_timeout_ms: 2000,
                ..Default::default()
            },
        )
        .unwrap()
        .with_service_factory(factory),
    )
}

#[test]
fn cached_proxy_captures_services_for_each_actual_dispatch_and_grant() {
    let temp = tempfile::tempdir().unwrap();
    let factory = Arc::new(DispatchServiceFactory {
        selected: Arc::default(),
        calls: Arc::default(),
        released: Arc::default(),
        pending: false,
    });
    let proxy = service_proxy(temp.path(), factory.clone(), 3000);
    let mut store = store(temp.path());
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy.clone()).unwrap();
    let mut expected = vec![];
    for _ in 0..2 {
        let input = input(&mut store, &proxy);
        let grant = authorize(&runtime, &mut store, &input);
        expected.push((input.envelope().attempt_id, grant));
        runtime.submit(&mut store, &input).unwrap();
        finish(&mut runtime, &mut store, &input);
        let attempt = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        assert_eq!(attempt.items[0].execution, ExecutionState::Succeeded);
        let output = store
            .execution_result(
                input.envelope().attempt_id,
                store
                    .execution_current_result(input.envelope().attempt_id, attempt.items[0].item_id)
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
        let sdk::InvocationOutcome::Succeeded { output } =
            &output.envelope().plugin.as_ref().unwrap().result.outcome
        else {
            panic!("successful service output")
        };
        let parsed: serde_json::Value = serde_json::from_str(&output.utf8).unwrap();
        assert_eq!(parsed["grant"], grant.to_string());
    }
    let selected = factory.selected.lock().unwrap();
    assert_eq!(selected.len(), 2);
    assert_eq!((selected[0].0, selected[0].2), expected[0]);
    assert_eq!((selected[1].0, selected[1].2), expected[1]);
    assert_ne!(selected[0].1, selected[1].1);
    let calls = factory.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, expected[0].1);
    assert_eq!(calls[1].0, expected[1].1);
    assert_ne!(calls[0].1, calls[1].1);
    assert_eq!(
        factory.released.load(std::sync::atomic::Ordering::Acquire),
        2
    );
}

#[test]
fn unfinished_service_selection_is_bounded_and_never_launches_a_child() {
    let temp = tempfile::tempdir().unwrap();
    let staging = temp.path().join("staging");
    std::fs::create_dir(&staging).unwrap();
    let factory = Arc::new(DispatchServiceFactory {
        selected: Arc::default(),
        calls: Arc::default(),
        released: Arc::default(),
        pending: true,
    });
    let proxy = service_proxy(&staging, factory.clone(), 40);
    let mut store = store(temp.path());
    let input = input(&mut store, &proxy);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy).unwrap();
    authorize(&runtime, &mut store, &input);
    runtime.submit(&mut store, &input).unwrap();
    finish(&mut runtime, &mut store, &input);
    let attempt = store
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(attempt.items[0].execution, ExecutionState::Unknown);
    assert_eq!(
        attempt.items[0].diagnostic.as_deref(),
        Some("plugin-timeout-selection")
    );
    assert_eq!(factory.selected.lock().unwrap().len(), 1);
    assert!(factory.calls.lock().unwrap().is_empty());
    assert_eq!(
        factory.released.load(std::sync::atomic::Ordering::Acquire),
        0
    );
    assert_eq!(std::fs::read_dir(staging).unwrap().count(), 0);
}

#[test]
fn service_selection_keeps_the_original_dispatch_deadline_without_another_core_tick() {
    let temp = tempfile::tempdir().unwrap();
    let staging = temp.path().join("staging");
    std::fs::create_dir(&staging).unwrap();
    let factory = Arc::new(DispatchServiceFactory {
        selected: Arc::default(),
        calls: Arc::default(),
        released: Arc::default(),
        pending: true,
    });
    let proxy = service_proxy(&staging, factory.clone(), 3000);
    let mut store = store(temp.path());
    let mut envelope = input(&mut store, &proxy).envelope().clone();
    envelope.limits.timeout_ms = 150;
    let input = FixedInput::capture(envelope).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy.clone()).unwrap();
    authorize(&runtime, &mut store, &input);
    runtime.submit(&mut store, &input).unwrap();
    let dispatch = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let original_deadline = dispatch.deadline().unwrap();
    let (results, _receiver) = result_channel();
    let start = Instant::now();
    let error = proxy
        .run(dispatch, Cancellation::default(), results)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::OutcomeUnknown);
    assert_eq!(error.stage, "plugin-timeout-selection");
    assert!(Instant::now() >= original_deadline);
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(factory.selected.lock().unwrap().len(), 1);
    assert!(factory.calls.lock().unwrap().is_empty());
    assert_eq!(
        factory.released.load(std::sync::atomic::Ordering::Acquire),
        0
    );
    assert_eq!(std::fs::read_dir(staging).unwrap().count(), 0);
}
