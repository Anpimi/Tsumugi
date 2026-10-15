use super::*;

#[test]
fn defaults_request_carries_only_exact_selection_revision_and_original_action() {
    let request = PluginDefaultsInstallRequest {
        id: plugin_bundle::BUNDLE_ID.into(),
        selection_digest: "a".repeat(64),
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let value = serde_json::to_value(request).unwrap();
    for field in [
        "directory",
        "origin",
        "packages",
        "environment",
        "approved",
        "allowUnsandboxedExecution",
    ] {
        let mut forged = value.clone();
        forged[field] = serde_json::json!(true);
        assert!(serde_json::from_value::<PluginDefaultsInstallRequest>(forged).is_err());
    }
}
#[test]
fn bundled_selection_refuses_duplicates_paths_wrong_sdk_and_unpinned_provenance() {
    let selection = plugin_bundle::selection().unwrap();
    assert_eq!(
        selection
            .packages
            .iter()
            .map(|pin| pin.id.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        ["stardew-smapi", "webvtt"].into_iter().collect()
    );
    for mutation in 0..11 {
        let mut changed = selection.clone();
        match mutation {
            0 => changed.packages.push(changed.packages[0].clone()),
            1 => changed.packages[0].id = "../outside".into(),
            2 => changed.packages[0].sdk_version = "other".into(),
            3 => changed.packages[0].package_digest = "invalid".into(),
            4 => changed.packages[0].source_commit = "main".into(),
            5 => changed.packages[0].source_repository = "file:///local".into(),
            6 => changed.packages[0].archive_name = "../webvtt.tar".into(),
            7 => changed.packages[0].archive_sha256 = "invalid".into(),
            8 => changed.packages[0].sdk_artifact_sha256 = "invalid".into(),
            9 => changed.process_protocol = sdk::PROCESS_PROTOCOL - 1,
            _ => changed.packages[0].archive_name = "latest.tar".into(),
        }
        assert!(changed.validate().is_err());
    }
}
#[cfg(not(feature = "bundled-plugins"))]
#[test]
fn default_free_build_offers_no_implicit_development_path() {
    let owner = ApplicationPlugins::default();
    owner
        .configure_default_bundle(Some(PathBuf::from("/arbitrary")))
        .unwrap();
    assert!(owner.manager.lock().unwrap().defaults.is_none());
}

#[cfg(all(
    feature = "bundled-plugins",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn defaults_capture_real_independent_files_preserve_choices_and_reopen_without_workers() {
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};
    fn copy_tree(source: &Path, output: &Path) {
        fs::create_dir(output).unwrap();
        fs::set_permissions(output, fs::Permissions::from_mode(0o700)).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let source = entry.path();
            let output = output.join(entry.file_name());
            let info = fs::symlink_metadata(&source).unwrap();
            assert!(!info.is_symlink());
            if info.is_dir() {
                copy_tree(&source, &output);
            } else {
                assert!(info.is_file());
                fs::copy(source, &output).unwrap();
                fs::set_permissions(
                    output,
                    fs::Permissions::from_mode(info.permissions().mode() & 0o700),
                )
                .unwrap();
            }
        }
    }
    fn removable(path: &Path) {
        if fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
            for entry in fs::read_dir(path).unwrap() {
                removable(&entry.unwrap().path());
            }
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let resources = temporary.path().join("resources");
    fs::create_dir(&resources).unwrap();
    let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    copy_tree(
        &prepared.join("bundled-plugins"),
        &resources.join("bundled-plugins"),
    );
    fs::create_dir(resources.join("runtimes")).unwrap();
    copy_tree(
        &prepared.join("javascript-runtime"),
        &resources.join("runtimes/javascript"),
    );
    let data = temporary.path().join("application");
    let owner = ApplicationPlugins::default();
    owner.configure(data.clone()).unwrap();
    owner.configure_bundle(Some(resources.clone())).unwrap();
    owner
        .configure_default_bundle(Some(resources.clone()))
        .unwrap();
    let before = owner.inventory().unwrap();
    assert!(
        before.packages.is_empty()
            && before.runtimes.is_empty()
            && before.package_decisions.is_empty()
    );
    assert_eq!(before.settings_revision.get(), 0);
    let offer = before.defaults_offer.unwrap();
    assert_eq!(offer.availability, DefaultsAvailability::Available);
    let request = PluginDefaultsInstallRequest {
        id: offer.id.clone(),
        selection_digest: offer.selection_digest.clone(),
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let mut wrong = request.clone();
    wrong.selection_digest = "f".repeat(64);
    assert_eq!(
        owner
            .mutate(packages::MutationRequest::Defaults(wrong))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-defaults-changed")
    );
    for pin in plugin_bundle::selection().unwrap().packages {
        let component = resources
            .join("bundled-plugins")
            .join(pin.id)
            .join("components/component.mjs");
        let original = fs::read(&component).unwrap();
        fs::write(&component, b"changed bytes; no execution").unwrap();
        assert_eq!(
            owner
                .mutate(packages::MutationRequest::Defaults(request.clone()))
                .unwrap_err()
                .reason
                .as_deref(),
            Some("plugin-defaults-changed")
        );
        let refused = owner.inventory().unwrap();
        assert_eq!(refused.settings_revision.get(), 0);
        assert!(
            refused.packages.is_empty()
                && refused.runtimes.is_empty()
                && refused.package_decisions.is_empty()
        );
        fs::write(&component, original).unwrap();
    }
    let license = resources.join("runtimes/javascript/tool/LICENSE");
    let original_license = fs::read(&license).unwrap();
    fs::write(&license, b"changed runtime license").unwrap();
    assert_eq!(
        owner
            .mutate(packages::MutationRequest::Defaults(request.clone()))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("plugin-runtime-changed")
    );
    assert_eq!(owner.inventory().unwrap().settings_revision.get(), 0);
    fs::write(&license, original_license).unwrap();
    let installed = owner
        .mutate(packages::MutationRequest::Defaults(request.clone()))
        .unwrap();
    assert_eq!(installed.packages.len(), offer.packages.len());
    assert_eq!(installed.runtimes.len(), 1);
    assert!(
        installed
            .packages
            .iter()
            .all(|entry| entry.state == PluginObjectState::Sealed)
    );
    assert!(
        installed
            .package_decisions
            .iter()
            .all(|entry| entry.enabled)
    );
    assert_eq!(installed.settings_revision.get(), 1);
    assert_eq!(
        owner
            .mutate(packages::MutationRequest::Defaults(request.clone()))
            .unwrap(),
        installed
    );
    let original_actions = {
        let manager = owner.manager.lock().unwrap();
        let store = manager.store.as_ref().unwrap();
        let records = store.inventory(|| true).unwrap();
        let package_actions = records
            .packages
            .iter()
            .map(|record| {
                (
                    record.receipt.plugin().clone(),
                    record.receipt.action_id().to_owned(),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let runtime_action = records.runtimes[0].receipt.action_id().to_owned();
        assert_eq!(package_actions.len(), 2);
        assert_eq!(
            package_actions
                .values()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            2
        );
        for action in package_actions.values() {
            assert_ne!(*action, runtime_action);
            assert_ne!(*action, request.action_id.to_string());
        }
        assert_ne!(runtime_action, request.action_id.to_string());
        (package_actions, runtime_action)
    };
    for entry in &installed.packages {
        let package = PluginPackageRequest {
            plugin: entry.plugin.clone(),
            package_digest: entry.package_digest.clone(),
        };
        let source = owner
            .capture_source(&PluginSourceRequest {
                package: package.clone(),
                resource_id: "source-profile".into(),
                environment_digest: offer.runtime_environment_digest.clone(),
            })
            .unwrap()
            .view()
            .unwrap();
        assert_eq!(source.declaration.review_resource, "review-profile");
        assert_eq!(source.review.declaration.rules.len(), 2);
        assert_ne!(source.extractor, source.checker);
        let build = owner
            .capture_build(&PluginBuildRequest {
                package: package.clone(),
                resource_id: "build-profile".into(),
                environment_digest: offer.runtime_environment_digest.clone(),
            })
            .unwrap()
            .view()
            .unwrap();
        assert_eq!(build.declaration.profile, source.declaration.profile);
        assert_ne!(build.builder, build.checker);
        if entry.plugin.id == "stardew-smapi" {
            let translation = owner
                .capture_translation(&PluginTranslationRequest {
                    package,
                    resource_id: "translation-profile".into(),
                    environment_digest: offer.runtime_environment_digest.clone(),
                })
                .unwrap()
                .view()
                .unwrap();
            assert_eq!(translation.declaration.profile, source.declaration.profile);
            assert_ne!(translation.extractor, translation.checker);
        }
    }
    assert_eq!(owner.inventory().unwrap(), installed);
    let disabled = owner
        .mutate(packages::MutationRequest::Enable(PluginEnableRequest {
            package: PluginPackageRequest {
                plugin: installed.packages[0].plugin.clone(),
                package_digest: installed.packages[0].package_digest.clone(),
            },
            enabled: false,
            expected_revision: installed.settings_revision,
            action_id: ExecutionId::new(),
        }))
        .unwrap();
    let again = owner
        .mutate(packages::MutationRequest::Defaults(
            PluginDefaultsInstallRequest {
                expected_revision: disabled.settings_revision,
                action_id: ExecutionId::new(),
                ..request.clone()
            },
        ))
        .unwrap();
    assert!(
        !again
            .package_decisions
            .iter()
            .find(|decision| decision.plugin == installed.packages[0].plugin)
            .unwrap()
            .enabled
    );
    assert!(
        again
            .package_decisions
            .iter()
            .find(|decision| decision.plugin == installed.packages[1].plugin)
            .unwrap()
            .enabled
    );
    assert_eq!(again.packages.len(), 2);
    assert_eq!(again.runtimes.len(), 1);
    {
        let manager = owner.manager.lock().unwrap();
        let records = manager.store.as_ref().unwrap().inventory(|| true).unwrap();
        let actions = records
            .packages
            .iter()
            .map(|record| {
                (
                    record.receipt.plugin().clone(),
                    record.receipt.action_id().to_owned(),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(actions, original_actions.0);
        assert_eq!(records.runtimes[0].receipt.action_id(), original_actions.1);
    }
    drop(owner);
    let reopened = ApplicationPlugins::default();
    reopened.configure(data).unwrap();
    // Stored installed bytes and decisions do not depend on available offers.
    assert_eq!(
        reopened.inventory().unwrap().package_decisions,
        again.package_decisions
    );
    assert_eq!(reopened.inventory().unwrap().runtimes, again.runtimes);
    drop(reopened);
    removable(temporary.path());
}
