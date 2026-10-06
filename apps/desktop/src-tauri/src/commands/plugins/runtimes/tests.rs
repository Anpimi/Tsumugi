use super::*;

#[test]
fn native_host_request_refuses_caller_descriptors_paths_origins_and_grants() {
    let request = PluginNativeHostApprovalRequest {
        environment_digest: "a".repeat(64),
        approved: true,
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(
        serde_json::from_value::<PluginNativeHostApprovalRequest>(value.clone()).unwrap(),
        request
    );
    for field in [
        "directory",
        "origin",
        "environment",
        "grantId",
        "allowUnsandboxedExecution",
    ] {
        let mut forged = value.clone();
        forged[field] = serde_json::json!(true);
        assert!(serde_json::from_value::<PluginNativeHostApprovalRequest>(forged).is_err());
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn native_request(revision: u64, approved: bool) -> PluginNativeHostApprovalRequest {
    let PluginNativeHostOfferView::Available {
        environment,
        environment_digest,
        origin,
    } = native_host_offer()
    else {
        panic!("This actual test Host must have an inspectable native identity");
    };
    assert_eq!(environment.digest().unwrap(), environment_digest);
    assert_eq!(origin, PluginOriginView::from(&native_host_origin()));
    PluginNativeHostApprovalRequest {
        environment_digest,
        approved,
        expected_revision: revision.into(),
        action_id: ExecutionId::new(),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn native_host_observation_approval_reopen_and_original_revoke_have_no_runtime_tree() {
    let directory = tempfile::tempdir().unwrap();
    let app_data = directory.path().join("application");
    let owner = ApplicationPlugins::default();
    owner.configure(app_data.clone()).unwrap();
    let before = owner.inventory().unwrap();
    assert_eq!(before.settings_revision.get(), 0);
    assert!(before.runtime_decisions.is_empty() && before.runtimes.is_empty());
    assert!(!app_data.join("plugins/settings.json").exists());
    let request = native_request(0, true);
    let approved = owner.set_native_host_approval(request.clone()).unwrap();
    assert_eq!(approved.settings_revision.get(), 1);
    assert_eq!(
        approved.last_settings_action,
        Some(request.action_id.to_string())
    );
    assert_eq!(approved.runtime_decisions.len(), 1);
    assert_eq!(
        approved.runtime_decisions[0].environment_digest,
        request.environment_digest
    );
    assert!(approved.runtimes.is_empty() && approved.packages.is_empty());
    assert_eq!(owner.set_native_host_approval(request).unwrap(), approved);
    let runtimes = app_data.join("plugins/runtimes");
    assert!(!runtimes.exists() || std::fs::read_dir(runtimes).unwrap().count() == 0);
    let bytes = std::fs::read(app_data.join("plugins/settings.json")).unwrap();
    drop(owner);
    let reopened = ApplicationPlugins::default();
    reopened.configure(app_data.clone()).unwrap();
    assert_eq!(reopened.inventory().unwrap(), approved);
    assert_eq!(
        std::fs::read(app_data.join("plugins/settings.json")).unwrap(),
        bytes
    );
    let revoke = native_request(1, false);
    let revoked = reopened.set_native_host_approval(revoke.clone()).unwrap();
    assert_eq!(revoked.settings_revision.get(), 2);
    assert_eq!(
        revoked.last_settings_action,
        Some(revoke.action_id.to_string())
    );
    assert!(revoked.runtime_decisions.is_empty() && revoked.runtimes.is_empty());
    assert_eq!(reopened.set_native_host_approval(revoke).unwrap(), revoked);
    drop(reopened);
    let reopened = ApplicationPlugins::default();
    reopened.configure(app_data).unwrap();
    assert_eq!(reopened.inventory().unwrap(), revoked);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn native_host_mutation_rejects_wrong_identity_stale_revision_and_closed_owner() {
    let directory = tempfile::tempdir().unwrap();
    let app_data = directory.path().join("application");
    let owner = ApplicationPlugins::default();
    owner.configure(app_data.clone()).unwrap();
    let mut forged = native_request(0, true);
    forged.environment_digest = "f".repeat(64);
    assert_eq!(
        owner
            .set_native_host_approval(forged)
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-approval-mismatch")
    );
    assert!(!app_data.join("plugins/settings.json").exists());
    owner
        .set_native_host_approval(native_request(0, true))
        .unwrap();
    let bytes = std::fs::read(app_data.join("plugins/settings.json")).unwrap();
    assert_eq!(
        owner
            .set_native_host_approval(native_request(0, false))
            .unwrap_err()
            .code,
        CommandErrorCode::StaleRevision
    );
    assert_eq!(
        std::fs::read(app_data.join("plugins/settings.json")).unwrap(),
        bytes
    );
    assert!(
        capture_native_approval(&native_request(1, true).environment_digest, || false).is_err()
    );
    owner.close();
    assert_eq!(
        owner
            .set_native_host_approval(native_request(1, false))
            .unwrap_err()
            .code,
        CommandErrorCode::Cancelled
    );
    assert_eq!(
        std::fs::read(app_data.join("plugins/settings.json")).unwrap(),
        bytes
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn obsolete_native_approval_can_be_revoked_without_changing_node_decisions() {
    let directory = tempfile::tempdir().unwrap();
    let app_data = directory.path().join("application");
    let owner = ApplicationPlugins::default();
    owner.configure(app_data.clone()).unwrap();
    owner.inventory().unwrap();
    let node: PluginRuntimeOfferView = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginRuntime.contract.json"
    ))
    .unwrap();
    let node_approval = RuntimeApproval {
        environment: node.environment.into(),
        origin: PackageOrigin {
            source_id: node.origin.source_id,
            publisher_id: node.origin.publisher_id,
        },
    };
    let mut obsolete = CapturedNativeRuntime::inspect_current().unwrap();
    obsolete.host_version = "0.1.0-alpha.2".into();
    let obsolete_digest = obsolete.digest().unwrap();
    let update = tsumugi_plugin_host::PluginSettingsUpdate {
        packages: vec![],
        runtimes: vec![
            node_approval.clone(),
            RuntimeApproval {
                environment: obsolete.into(),
                origin: native_host_origin(),
            },
        ],
    };
    owner
        .manager
        .lock()
        .unwrap()
        .store
        .as_mut()
        .unwrap()
        .update_settings(0, &ExecutionId::new().to_string(), &update, || true)
        .unwrap();
    let request = PluginNativeHostApprovalRequest {
        environment_digest: obsolete_digest.clone(),
        approved: true,
        expected_revision: 1.into(),
        action_id: ExecutionId::new(),
    };
    assert_eq!(
        owner
            .set_native_host_approval(request.clone())
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-approval-mismatch")
    );
    let bytes = std::fs::read(app_data.join("plugins/settings.json")).unwrap();
    let mut node_revoke = request.clone();
    node_revoke.approved = false;
    node_revoke.environment_digest = node_approval.environment.digest().unwrap();
    assert!(owner.set_native_host_approval(node_revoke).is_err());
    assert_eq!(
        std::fs::read(app_data.join("plugins/settings.json")).unwrap(),
        bytes
    );
    let mut revoke = request;
    revoke.approved = false;
    let view = owner.set_native_host_approval(revoke).unwrap();
    assert_eq!(view.settings_revision.get(), 2);
    assert_eq!(view.runtime_decisions.len(), 1);
    assert_eq!(
        view.runtime_decisions[0].environment,
        node_approval.environment
    );
    assert!(view.runtimes.is_empty());
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn tauri_native_host_approval_uses_registered_mutation_and_original_action() {
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    let directory = tempfile::tempdir().unwrap();
    let app_data = directory.path().join("application");
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.state::<AppState>()
        .plugins
        .configure(app_data.clone())
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let request = native_request(0, true);
    let invoke = |body| InvokeRequest {
        cmd: "set_plugin_native_host_approval".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.into(),
    };
    let response =
        tauri::test::get_ipc_response(&window, invoke(serde_json::json!({"request":request})))
            .unwrap()
            .deserialize::<PluginInventoryView>()
            .unwrap();
    assert_eq!(response.settings_revision.get(), 1);
    assert_eq!(
        response.last_settings_action,
        Some(request.action_id.to_string())
    );
    assert_eq!(
        response.runtime_decisions[0].environment_digest,
        request.environment_digest
    );
    assert!(response.runtimes.is_empty());
    let repeated =
        tauri::test::get_ipc_response(&window, invoke(serde_json::json!({"request":request})))
            .unwrap()
            .deserialize::<PluginInventoryView>()
            .unwrap();
    assert_eq!(repeated, response);
    let bytes = std::fs::read(app_data.join("plugins/settings.json")).unwrap();
    let mut forged = serde_json::to_value(&request).unwrap();
    forged["environment"] = serde_json::json!({"profile":"native-application-host-v1"});
    assert!(
        tauri::test::get_ipc_response(&window, invoke(serde_json::json!({"request":forged})))
            .is_err()
    );
    assert_eq!(
        std::fs::read(app_data.join("plugins/settings.json")).unwrap(),
        bytes
    );
}

#[test]
fn runtime_request_accepts_only_exact_identity_and_original_action() {
    let request = PluginRuntimeInstallRequest {
        id: runtime_bundle::BUNDLE_ID.into(),
        environment_digest: "a".repeat(64),
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let value = serde_json::to_value(&request).unwrap();
    for field in [
        "directory",
        "origin",
        "environment",
        "approved",
        "allowUnsandboxedExecution",
    ] {
        let mut forged = value.clone();
        forged[field] = serde_json::json!(true);
        assert!(serde_json::from_value::<PluginRuntimeInstallRequest>(forged).is_err());
    }
}

#[test]
fn runtime_source_pin_and_system_version_are_strict() {
    assert_eq!(runtime_bundle::system_version("13.5"), Some((13, 5, 0)));
    assert_eq!(runtime_bundle::system_version("27.2.1"), Some((27, 2, 1)));
    for malformed in [
        "13",
        "13.",
        "13.5.1.0",
        "13.5-beta",
        " 13.5",
        "65536.0",
        "13..5",
    ] {
        assert!(runtime_bundle::system_version(malformed).is_none());
    }
    let offer: PluginRuntimeOfferView = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/pluginRuntime.contract.json"
    ))
    .unwrap();
    let pin = runtime_bundle::node_pin().unwrap();
    assert!(runtime_bundle::supported_tool(&offer.environment, &pin));
    let mut changed = offer.environment.clone();
    changed.tool.tree_digest = "f".repeat(64);
    assert!(!runtime_bundle::supported_tool(&changed, &pin));
    changed = offer.environment.clone();
    changed.platform.architecture = sdk::RuntimeArchitecture::X86_64;
    assert_eq!(
        availability(&changed, "13.5"),
        RuntimeAvailability::UnsupportedPlatform
    );
}

#[cfg(not(feature = "bundled-runtime"))]
#[test]
fn runtime_free_build_has_no_offer_or_implicit_path_fallback() {
    let owner = ApplicationPlugins::default();
    owner
        .configure_bundle(Some(PathBuf::from("/arbitrary")))
        .unwrap();
    assert!(owner.manager.lock().unwrap().bundle.is_none());
    let request = PluginRuntimeInstallRequest {
        id: runtime_bundle::BUNDLE_ID.into(),
        environment_digest: "a".repeat(64),
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    assert_eq!(
        capture_offer(&owner.manager.lock().unwrap(), &request, || true)
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-runtime-unavailable")
    );
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn bundled_runtime_real_files_require_independent_approval_and_survive_reopen() {
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};
    fn removable(path: &Path) {
        if fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
            for child in fs::read_dir(path).unwrap() {
                removable(&child.unwrap().path());
            }
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let app_data = directory.path().join("application");
    let metadata: BundledRuntimeMetadata = serde_json::from_str(BUILT_RUNTIME.unwrap()).unwrap();
    metadata.validate().unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/javascript-runtime");
    let owner = ApplicationPlugins::default();
    owner.configure(app_data.clone()).unwrap();
    owner.manager.lock().unwrap().bundle = Some(Bundle {
        metadata: metadata.clone(),
        root: Some(directory.path().join("absent")),
    });
    assert_eq!(
        owner.inventory().unwrap().runtime_offers[0].availability,
        RuntimeAvailability::ResourcesUnavailable
    );
    owner.manager.lock().unwrap().bundle = Some(Bundle {
        metadata: metadata.clone(),
        root: Some(root),
    });
    let before = owner.inventory().unwrap();
    assert!(before.runtime_decisions.is_empty() && before.runtimes.is_empty());
    let offer = before.runtime_offers[0].clone();
    assert_eq!(offer.availability, RuntimeAvailability::Available);
    assert_eq!(
        owner
            .lookup_runtime(&offer.environment_digest)
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-approval-mismatch")
    );
    let mut request = PluginRuntimeInstallRequest {
        id: offer.id,
        environment_digest: offer.environment_digest.clone(),
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    request.environment_digest = "f".repeat(64);
    assert!(owner.install_runtime(request.clone()).is_err());
    assert_eq!(owner.inventory().unwrap().settings_revision.get(), 0);
    request.environment_digest = offer.environment_digest.clone();
    let installed = owner.install_runtime(request.clone()).unwrap();
    assert_eq!(installed.settings_revision.get(), 1);
    assert_eq!(installed.runtimes.len(), 1);
    assert_eq!(
        installed.runtime_decisions[0].environment_digest,
        offer.environment_digest
    );
    assert!(installed.package_decisions.is_empty());
    assert_eq!(owner.install_runtime(request).unwrap(), installed);
    owner.manager.lock().unwrap().bundle = None;
    let loaded = owner.lookup_runtime(&offer.environment_digest).unwrap();
    assert_eq!(loaded.descriptor(), &metadata.environment);
    drop(loaded);
    drop(owner);
    let reopened = ApplicationPlugins::default();
    reopened.configure(app_data.clone()).unwrap();
    assert_eq!(
        reopened
            .lookup_runtime(&offer.environment_digest)
            .unwrap()
            .descriptor(),
        &metadata.environment
    );
    let host_entry = app_data
        .join("plugins/runtimes")
        .join(&offer.environment_digest)
        .join("host/dist/main.js");
    let original = fs::read(&host_entry).unwrap();
    fs::set_permissions(&host_entry, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&host_entry, b"throw new Error('altered stored Host');").unwrap();
    fs::set_permissions(&host_entry, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(reopened.lookup_runtime(&offer.environment_digest).is_err());
    fs::set_permissions(&host_entry, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&host_entry, original).unwrap();
    fs::set_permissions(&host_entry, fs::Permissions::from_mode(0o400)).unwrap();
    let settings_path = app_data.join("plugins/settings.json");
    let mut settings: serde_json::Value =
        serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
    settings["runtimes"] = serde_json::json!([]);
    fs::set_permissions(&settings_path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&settings_path, serde_json::to_vec(&settings).unwrap()).unwrap();
    fs::set_permissions(&settings_path, fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(
        reopened
            .lookup_runtime(&offer.environment_digest)
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-approval-mismatch")
    );
    drop(reopened);
    removable(directory.path());
}
