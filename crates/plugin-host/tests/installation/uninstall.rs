use super::*;

const REMOVE: &str = "00000000-0000-4000-8000-000000000003";
const REINSTALL: &str = "00000000-0000-4000-8000-000000000004";

#[test]
fn uninstall_preserves_other_packages_original_captures_and_settings() {
    let root = OwnedRoot::new();
    let (a, approval_a) = basic();
    let (b, approval_b) = fixture("second.resource", "1.0.0", "second bytes", origin());
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let installed_a = install(&mut store, &a, &approval_a, ACTION).unwrap();
    let installed_b = install(&mut store, &b, &approval_b, OTHER_ACTION).unwrap();
    let captured = store.load(&approval_a, || true).unwrap();
    let settings = store
        .update_settings(0, REINSTALL, &settings_update(&approval_b, true), || true)
        .unwrap();
    let settings_bytes = fs::read(root.root.join("settings.json")).unwrap();
    let receipt = store.uninstall(1, REMOVE, &approval_a, || true).unwrap();
    assert_eq!(serde_json::to_value(&receipt).unwrap()["formatVersion"], 2);
    assert_eq!(receipt.installation().format_version(), 2);
    assert_eq!(receipt.action_id(), REMOVE);
    assert_eq!(receipt.settings_revision(), 1);
    assert_eq!(receipt.installation(), &installed_a);
    assert!(!root.object(&approval_a).exists());
    assert_eq!(
        store.load(&approval_a, || true).unwrap_err(),
        InstallError::MissingPackage
    );
    assert_eq!(
        store.load(&approval_b, || true).unwrap().receipt(),
        &installed_b
    );
    assert_eq!(store.inventory(|| true).unwrap().packages.len(), 1);
    assert_eq!(store.settings(|| true).unwrap(), settings);
    assert_eq!(
        fs::read(root.root.join("settings.json")).unwrap(),
        settings_bytes
    );
    assert_eq!(
        captured
            .image()
            .resource_bytes("resource", &contract("example.resource"))
            .unwrap(),
        b"original bytes"
    );
    assert_eq!(
        archive_payload::members(
            &root
                .root
                .join("uninstalls")
                .join(REMOVE)
                .join("object/package.tar")
        )["data/marker.txt"]
            .bytes,
        b"original bytes"
    );
    drop(store);
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let records = store.uninstallations(|| true).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].receipt, receipt);
    assert_eq!(records[0].state, InstalledObjectState::Sealed);
    assert_eq!(
        store.uninstall(1, REMOVE, &approval_a, || true).unwrap(),
        receipt
    );
    assert_eq!(store.settings(|| true).unwrap(), settings);
}

#[test]
fn uninstall_refuses_approved_disabled_or_enabled_packages_without_writing() {
    for enabled in [false, true] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let saved = store
            .update_settings(
                0,
                OTHER_ACTION,
                &settings_update(&approval, enabled),
                || true,
            )
            .unwrap();
        assert_eq!(
            store.uninstall(1, REMOVE, &approval, || true).unwrap_err(),
            InstallError::Busy
        );
        assert!(root.object(&approval).is_dir());
        assert!(!root.root.join("uninstalls").exists());
        assert_eq!(store.settings(|| true).unwrap(), saved);
        assert!(root.candidates().is_empty());
    }
}

#[test]
fn uninstall_refuses_stale_identity_action_and_revocation_before_intent() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    assert_eq!(
        store.uninstall(1, REMOVE, &approval, || true).unwrap_err(),
        InstallError::RevisionConflict
    );
    assert_eq!(
        store.uninstall(0, ACTION, &approval, || true).unwrap_err(),
        InstallError::ActionConflict
    );
    let mut wrong = approval.clone();
    wrong.origin.source_id = "other-source".into();
    assert_eq!(
        store.uninstall(0, REMOVE, &wrong, || true).unwrap_err(),
        InstallError::ApprovalMismatch
    );
    assert_eq!(
        store.uninstall(0, REMOVE, &approval, || false).unwrap_err(),
        InstallError::AuthorityRevoked
    );
    assert!(!root.root.join("uninstalls").exists());
    assert!(root.candidates().is_empty());
    assert_eq!(
        store
            .load(&approval, || true)
            .unwrap()
            .receipt()
            .action_id(),
        ACTION
    );
}

#[test]
fn uninstall_retry_never_removes_a_new_installation_of_the_same_bytes() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    let removed = store.uninstall(0, REMOVE, &approval, || true).unwrap();
    for action in [ACTION, REMOVE] {
        assert_eq!(
            install(&mut store, &catalog, &approval, action).unwrap_err(),
            InstallError::ActionConflict
        );
    }
    let newer = install(&mut store, &catalog, &approval, REINSTALL).unwrap();
    store
        .update_settings(0, OTHER_ACTION, &settings_update(&approval, true), || true)
        .unwrap();
    assert_eq!(
        store.uninstall(0, REMOVE, &approval, || true).unwrap(),
        removed
    );
    assert_eq!(store.load(&approval, || true).unwrap().receipt(), &newer);
    assert!(store.settings(|| true).unwrap().packages()[0].enabled);
}

#[test]
fn uninstall_revocation_after_move_retains_original_action_and_cache() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    let moved = root.root.join("uninstalls").join(REMOVE).join("object");
    assert_eq!(
        store
            .uninstall(0, REMOVE, &approval, || !moved.exists())
            .unwrap_err(),
        InstallError::UnknownCommit
    );
    assert!(moved.is_dir());
    assert!(!root.object(&approval).exists());
    assert_eq!(
        store.uninstallations(|| true).unwrap()[0].state,
        InstalledObjectState::RecoveryRequired
    );
    assert_eq!(
        store.load(&approval, || true).unwrap_err(),
        InstallError::RecoveryRequired
    );
    let recovered = store.uninstall(0, REMOVE, &approval, || true).unwrap();
    assert_eq!(recovered.installation().action_id(), ACTION);
    assert_eq!(
        store.uninstallations(|| true).unwrap()[0].state,
        InstalledObjectState::Sealed
    );
}

#[test]
fn uninstall_observed_namespace_replacement_preserves_external_content() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    let changed = Cell::new(false);
    let namespace = root.root.join("uninstalls");
    let saved = root.root.join("original-uninstalls");
    let error = store
        .uninstall(0, REMOVE, &approval, || {
            if !changed.get() && namespace.join(REMOVE).exists() {
                changed.set(true);
                fs::rename(&namespace, &saved).unwrap();
                fs::create_dir(&namespace).unwrap();
                mode(&namespace, 0o700);
                fs::write(namespace.join("external"), b"preserve unknown owner").unwrap();
            }
            true
        })
        .unwrap_err();
    assert_eq!(error, InstallError::UnknownCommit);
    assert!(changed.get());
    assert_eq!(
        fs::read(namespace.join("external")).unwrap(),
        b"preserve unknown owner"
    );
    assert!(root.object(&approval).is_dir());
    assert!(saved.join(REMOVE).join("receipt.json").is_file());
}

#[test]
fn uninstall_rejects_links_and_changed_retired_bytes_without_overwriting() {
    for damage in [
        "namespace-link",
        "resource",
        "receipt",
        "receipt-version",
        "installation-version",
    ] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        if damage == "namespace-link" {
            let target = root.root.join("external");
            fs::create_dir(&target).unwrap();
            fs::write(target.join("sentinel"), b"external bytes").unwrap();
            symlink(&target, root.root.join("uninstalls")).unwrap();
            assert_eq!(
                store.uninstall(0, REMOVE, &approval, || true).unwrap_err(),
                InstallError::CorruptStore
            );
            assert_eq!(
                fs::read(target.join("sentinel")).unwrap(),
                b"external bytes"
            );
            assert!(root.object(&approval).is_dir());
        } else {
            store.uninstall(0, REMOVE, &approval, || true).unwrap();
            let tx = root.root.join("uninstalls").join(REMOVE);
            let path = if damage == "resource" {
                tx.join("object/package.tar")
            } else {
                tx.join("receipt.json")
            };
            if damage == "resource" {
                archive_payload::replace_member(
                    &path,
                    "data/marker.txt",
                    b"changed immutable bytes",
                );
            } else if matches!(damage, "receipt-version" | "installation-version") {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                if damage == "receipt-version" {
                    value["formatVersion"] = 1.into();
                } else {
                    value["installation"]["formatVersion"] = 1.into();
                }
                replace_receipt(&path, &serde_json::to_vec(&value).unwrap());
            } else {
                replace_receipt(&path, b"changed immutable bytes");
            }
            let before = fs::read(&path).unwrap();
            assert!(store.uninstall(0, REMOVE, &approval, || true).is_err());
            assert_eq!(fs::read(path).unwrap(), before);
        }
    }
}

#[test]
fn uninstall_journal_limit_preserves_the_next_active_installation() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    for index in 0..MAX_INSTALLED_PACKAGES {
        let install_action = format!("00000000-0000-4000-8000-{:012}", index * 2 + 10);
        let remove_action = format!("00000000-0000-4000-8000-{:012}", index * 2 + 11);
        install(&mut store, &catalog, &approval, &install_action).unwrap();
        store
            .uninstall(0, &remove_action, &approval, || true)
            .unwrap();
    }
    let saved = install(&mut store, &catalog, &approval, ACTION).unwrap();
    assert_eq!(
        store.uninstallations(|| true).unwrap().len(),
        MAX_INSTALLED_PACKAGES
    );
    assert_eq!(
        store.uninstall(0, REMOVE, &approval, || true).unwrap_err(),
        InstallError::LimitExceeded
    );
    assert_eq!(store.load(&approval, || true).unwrap().receipt(), &saved);
    assert!(root.candidates().is_empty());
    assert!(!root.root.join("uninstalls").join(REMOVE).exists());
}

#[test]
fn uninstall_rechecks_concurrent_settings_before_persisting_intent() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    let other_root = OwnedRoot::new();
    let mut other = PackageStore::open_existing(&other_root.root).unwrap();
    let newer = other
        .update_settings(0, REINSTALL, &settings_update(&approval, true), || true)
        .unwrap();
    let bytes = serde_json::to_vec(&newer).unwrap();
    let inserted = Cell::new(false);
    let error = store
        .uninstall(0, REMOVE, &approval, || {
            if !inserted.get() && !root.candidates().is_empty() {
                inserted.set(true);
                fs::write(root.root.join("settings.json"), &bytes).unwrap();
                mode(&root.root.join("settings.json"), 0o400);
            }
            true
        })
        .unwrap_err();
    assert_eq!(error, InstallError::StoreChanged);
    assert!(inserted.get());
    assert_eq!(store.settings(|| true).unwrap(), newer);
    assert!(root.object(&approval).is_dir());
    assert!(store.uninstallations(|| true).unwrap().is_empty());
    assert_eq!(fs::read(root.root.join("settings.json")).unwrap(), bytes);
}

#[test]
fn uninstall_recovery_preserves_unrelated_newer_settings() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let (_, other_approval) = fixture("other.resource", "1.0.0", "other", origin());
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    let moved = root.root.join("uninstalls").join(REMOVE).join("object");
    assert_eq!(
        store
            .uninstall(0, REMOVE, &approval, || !moved.exists())
            .unwrap_err(),
        InstallError::UnknownCommit
    );
    let newer = store
        .update_settings(
            0,
            REINSTALL,
            &settings_update(&other_approval, false),
            || true,
        )
        .unwrap();
    let bytes = fs::read(root.root.join("settings.json")).unwrap();
    let removed = store.uninstall(0, REMOVE, &approval, || true).unwrap();
    assert_eq!(removed.settings_revision(), 0);
    assert_eq!(store.settings(|| true).unwrap(), newer);
    assert_eq!(fs::read(root.root.join("settings.json")).unwrap(), bytes);
    assert_eq!(
        store.uninstallations(|| true).unwrap()[0].state,
        InstalledObjectState::Sealed
    );
}
