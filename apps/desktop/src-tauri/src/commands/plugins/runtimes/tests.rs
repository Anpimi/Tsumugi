use super::*;

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
