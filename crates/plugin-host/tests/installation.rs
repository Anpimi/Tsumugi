#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

use tsumugi_plugin_host::{
    HostError, InstallError, InstallReceipt, MAX_INSTALLED_PACKAGES, PackageFile, PackageImage,
    PackageStore,
    catalog::{PackageApproval, PackageCatalog, PackageOrigin},
};
use tsumugi_plugin_sdk as sdk;

const ACTION: &str = "00000000-0000-4000-8000-000000000001";
const OTHER_ACTION: &str = "00000000-0000-4000-8000-000000000002";
const WORKER_BYTES: &[u8] = b"throw new Error('installation must not execute this component');";
const HELPER_BYTES: &[u8] = b"synthetic executable bytes";

struct OwnedRoot {
    directory: tempfile::TempDir,
    root: PathBuf,
}

impl OwnedRoot {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("store");
        fs::create_dir(&root).unwrap();
        mode(&root, 0o700);
        Self { directory, root }
    }
    fn object(&self, approval: &PackageApproval) -> PathBuf {
        self.root.join("objects").join(&approval.package_digest)
    }
    fn candidates(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".candidate-")
            })
            .collect()
    }
}

impl Drop for OwnedRoot {
    fn drop(&mut self) {
        // Only this isolated fixture tree is made removable. Links are never
        // traversed; production objects are not garbage-collected by the API.
        fn prepare(path: &Path) {
            if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
                if let Ok(entries) = fs::read_dir(path) {
                    for entry in entries.flatten() {
                        prepare(&entry.path());
                    }
                }
            }
        }
        prepare(self.directory.path());
    }
}

fn mode(path: &Path, value: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(value)).unwrap();
}
fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn origin() -> PackageOrigin {
    PackageOrigin {
        source_id: "approved-registry".into(),
        publisher_id: "approved-key".into(),
    }
}
fn fixture(
    id: &str,
    version: &str,
    marker: &str,
    origin: PackageOrigin,
) -> (PackageCatalog, PackageApproval) {
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: id.into(),
            version: version.into(),
        },
        permissions: vec![],
        components: vec![sdk::ComponentDeclaration {
            id: "worker".into(),
            scope: sdk::ComponentScope::Project,
            runtime: sdk::RuntimeKind::JavaScript,
            entrypoint: Some("worker.mjs".into()),
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 100,
                cleanup_timeout_ms: 100,
            },
        }],
        contributions: vec![sdk::ContributionDeclaration {
            id: "resource".into(),
            component_id: "worker".into(),
            contribution: sdk::ContributionKind::Resource {
                schema: contract("example.resource"),
                path: "data/marker.txt".into(),
            },
        }],
    };
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([
        (
            "worker.mjs".into(),
            PackageFile {
                bytes: WORKER_BYTES.to_vec(),
                executable: false,
            },
        ),
        (
            "data/marker.txt".into(),
            PackageFile {
                bytes: marker.as_bytes().to_vec(),
                executable: false,
            },
        ),
        (
            "tools/helper".into(),
            PackageFile {
                bytes: HELPER_BYTES.to_vec(),
                executable: true,
            },
        ),
    ]);
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    let image = PackageImage::capture(bytes, files, &digest).unwrap();
    let approval = PackageApproval {
        plugin: manifest.plugin,
        package_digest: digest,
        origin,
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    (catalog, approval)
}
fn basic() -> (PackageCatalog, PackageApproval) {
    fixture("example.resource", "0.1.0", "original bytes", origin())
}
fn install(
    store: &mut PackageStore,
    catalog: &PackageCatalog,
    approval: &PackageApproval,
    action: &str,
) -> Result<InstallReceipt, InstallError> {
    store.install(
        action,
        catalog.registered(&approval.plugin).unwrap(),
        || true,
    )
}
fn replace_receipt(path: &Path, bytes: &[u8]) {
    mode(path, 0o600);
    fs::write(path, bytes).unwrap();
    mode(path, 0o400);
}

fn write_fixture_object(
    root: &OwnedRoot,
    catalog: &PackageCatalog,
    approval: &PackageApproval,
    action: &str,
    marker: &str,
) {
    let package = catalog.registered(&approval.plugin).unwrap();
    let object = root.object(approval);
    fs::create_dir(&object).unwrap();
    let directory = object.join("package");
    fs::create_dir(&directory).unwrap();
    for child in ["data", "tools"] {
        fs::create_dir(directory.join(child)).unwrap();
    }
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec(package.image().manifest().manifest()).unwrap(),
    )
    .unwrap();
    fs::write(directory.join("worker.mjs"), WORKER_BYTES).unwrap();
    fs::write(directory.join("data/marker.txt"), marker.as_bytes()).unwrap();
    fs::write(directory.join("tools/helper"), HELPER_BYTES).unwrap();
    fs::write(
        object.join("receipt.json"),
        serde_json::to_vec(&serde_json::json!({
            "formatVersion": 1, "actionId": action, "plugin": approval.plugin,
            "packageDigest": approval.package_digest, "origin": approval.origin,
        }))
        .unwrap(),
    )
    .unwrap();
    for child in ["manifest.json", "worker.mjs", "data/marker.txt"] {
        mode(&directory.join(child), 0o400);
    }
    mode(&directory.join("tools/helper"), 0o500);
    for child in ["data", "tools"] {
        mode(&directory.join(child), 0o500);
    }
    mode(&directory, 0o500);
    mode(&object.join("receipt.json"), 0o400);
    mode(&object, 0o500);
}

#[test]
fn close_and_reopen_retains_actual_bytes_origin_flags_and_original_receipt() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    assert!(!catalog.is_enabled(&approval.plugin).unwrap());
    let receipt = {
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap()
    };
    assert_eq!(receipt.format_version(), 1);
    assert_eq!(receipt.action_id(), ACTION);
    assert_eq!(receipt.plugin(), &approval.plugin);
    assert_eq!(receipt.origin(), &approval.origin);
    assert_eq!(receipt.package_digest(), approval.package_digest);
    let object = root.object(&approval);
    assert_eq!(
        fs::metadata(&object).unwrap().permissions().mode() & 0o777,
        0o500
    );
    assert_eq!(
        fs::metadata(object.join("receipt.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o400
    );
    assert_eq!(
        fs::metadata(object.join("package/tools/helper"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o500
    );
    assert_eq!(
        fs::read(object.join("package/data/marker.txt")).unwrap(),
        b"original bytes"
    );
    let store = PackageStore::open_existing(&root.root).unwrap();
    let loaded = store.load(&approval, || true).unwrap();
    assert_eq!(loaded.receipt(), &receipt);
    assert_eq!(loaded.image().package_digest(), approval.package_digest);
    let mut new_catalog = PackageCatalog::new();
    new_catalog
        .register(loaded.image().clone(), approval.clone())
        .unwrap();
    assert!(!new_catalog.is_enabled(&approval.plugin).unwrap());
    assert!(!catalog.is_enabled(&approval.plugin).unwrap());
    assert!(root.candidates().is_empty());
}

#[test]
fn action_identity_and_source_conflicts_preserve_the_original_object() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let original = install(&mut store, &catalog, &approval, ACTION).unwrap();
    assert_eq!(
        install(&mut store, &catalog, &approval, ACTION).unwrap(),
        original
    );
    assert_eq!(
        install(&mut store, &catalog, &approval, OTHER_ACTION).unwrap_err(),
        InstallError::ActionConflict
    );
    let (changed, changed_approval) =
        fixture("example.resource", "0.1.0", "different bytes", origin());
    assert_eq!(
        install(&mut store, &changed, &changed_approval, ACTION).unwrap_err(),
        InstallError::ActionConflict
    );
    assert_eq!(
        install(&mut store, &changed, &changed_approval, OTHER_ACTION).unwrap_err(),
        InstallError::IdentityConflict
    );
    let (other, other_approval) = fixture("example.other", "0.1.0", "other", origin());
    assert_eq!(
        install(&mut store, &other, &other_approval, ACTION).unwrap_err(),
        InstallError::ActionConflict
    );
    let mut other_source = origin();
    other_source.source_id = "other-registry".into();
    let (foreign, foreign_approval) =
        fixture("example.resource", "0.2.0", "new version", other_source);
    assert_eq!(
        install(&mut store, &foreign, &foreign_approval, OTHER_ACTION).unwrap_err(),
        InstallError::SourceConflict
    );
    let mut other_publisher = origin();
    other_publisher.publisher_id = "other-key".into();
    let (foreign, foreign_approval) =
        fixture("example.resource", "0.2.0", "new version", other_publisher);
    assert_eq!(
        install(&mut store, &foreign, &foreign_approval, OTHER_ACTION).unwrap_err(),
        InstallError::PublisherConflict
    );
    assert_eq!(store.load(&approval, || true).unwrap().receipt(), &original);
    assert_eq!(fs::read_dir(root.root.join("objects")).unwrap().count(), 1);
}

#[test]
fn same_source_versions_coexist_and_loading_never_selects_a_newer_version() {
    let root = OwnedRoot::new();
    let (old, old_approval) = basic();
    let (new, new_approval) = fixture("example.resource", "0.2.0", "new bytes", origin());
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let old_receipt = install(&mut store, &old, &old_approval, ACTION).unwrap();
    let new_receipt = install(&mut store, &new, &new_approval, OTHER_ACTION).unwrap();
    assert_eq!(
        store.load(&old_approval, || true).unwrap().receipt(),
        &old_receipt
    );
    assert_eq!(
        store.load(&new_approval, || true).unwrap().receipt(),
        &new_receipt
    );
    assert_ne!(old_receipt.package_digest(), new_receipt.package_digest());
}

#[test]
fn load_compares_independent_approval_before_returning_captured_bytes() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    assert_eq!(
        store.load(&approval, || true).unwrap_err(),
        InstallError::MissingPackage
    );
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    let mut changed = approval.clone();
    changed.plugin.version = "0.2.0".into();
    assert_eq!(
        store.load(&changed, || true).unwrap_err(),
        InstallError::ApprovalMismatch
    );
    let mut changed = approval.clone();
    changed.origin.source_id = "unapproved-registry".into();
    assert_eq!(
        store.load(&changed, || true).unwrap_err(),
        InstallError::ApprovalMismatch
    );
    let mut changed = approval.clone();
    changed.package_digest = "../objects".into();
    assert_eq!(
        store.load(&changed, || true).unwrap_err(),
        InstallError::ApprovalMismatch
    );
    assert_eq!(
        store.load(&approval, || false).unwrap_err(),
        InstallError::AuthorityRevoked
    );
}

#[test]
fn action_ids_are_canonical_non_nil_uuids_and_rejection_creates_no_candidate() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    for action in [
        "",
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000",
        "00000000000040008000000000000001",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    ] {
        assert_eq!(
            install(&mut store, &catalog, &approval, action).unwrap_err(),
            InstallError::InvalidAction
        );
    }
    assert!(root.candidates().is_empty());
    assert_eq!(fs::read_dir(root.root.join("objects")).unwrap().count(), 0);
}

#[test]
fn changed_cached_bytes_are_rejected_and_a_previous_capture_stays_immutable() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    let prior = store.load(&approval, || true).unwrap();
    let marker = root.object(&approval).join("package/data/marker.txt");
    mode(&marker, 0o600);
    fs::write(&marker, b"tampered bytes").unwrap();
    mode(&marker, 0o400);
    assert_eq!(
        store.load(&approval, || true).unwrap_err(),
        InstallError::Host(HostError::PackageMismatch)
    );
    assert_eq!(
        install(&mut store, &catalog, &approval, ACTION).unwrap_err(),
        InstallError::Host(HostError::PackageMismatch)
    );
    assert_eq!(prior.image().package_digest(), approval.package_digest);
    assert_eq!(prior.receipt().action_id(), ACTION);
    assert!(root.object(&approval).exists());
}

#[test]
fn receipt_decoding_rejects_unknown_duplicate_and_invalid_version_or_action_fields() {
    for kind in [
        "unknown",
        "duplicate",
        "version",
        "nil-action",
        "nested-unknown",
    ] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let path = root.object(&approval).join("receipt.json");
        let original = fs::read(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
        let bytes = match kind {
            "unknown" => {
                value["unexpected"] = true.into();
                serde_json::to_vec(&value).unwrap()
            }
            "duplicate" => {
                let mut bytes = b"{\"formatVersion\":1,".to_vec();
                bytes.extend_from_slice(&original[1..]);
                bytes
            }
            "version" => {
                value["formatVersion"] = 2.into();
                serde_json::to_vec(&value).unwrap()
            }
            "nil-action" => {
                value["actionId"] = "00000000-0000-0000-0000-000000000000".into();
                serde_json::to_vec(&value).unwrap()
            }
            "nested-unknown" => {
                value["origin"]["credential"] = "synthetic".into();
                serde_json::to_vec(&value).unwrap()
            }
            _ => unreachable!(),
        };
        replace_receipt(&path, &bytes);
        assert_eq!(
            store.load(&approval, || true).unwrap_err(),
            InstallError::CorruptReceipt,
            "{kind}"
        );
        assert_eq!(
            install(&mut store, &catalog, &approval, ACTION).unwrap_err(),
            InstallError::CorruptReceipt,
            "{kind}"
        );
        assert!(root.object(&approval).exists());
    }
}

#[test]
fn structurally_valid_receipt_identity_or_origin_changes_cannot_impersonate_approval() {
    for change_identity in [true, false] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let path = root.object(&approval).join("receipt.json");
        let mut receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if change_identity {
            receipt["plugin"]["id"] = "example.impersonator".into();
        } else {
            receipt["origin"]["sourceId"] = "other-registry".into();
        }
        replace_receipt(&path, &serde_json::to_vec(&receipt).unwrap());
        assert_eq!(
            store.load(&approval, || true).unwrap_err(),
            InstallError::ApprovalMismatch
        );
        let error = install(&mut store, &catalog, &approval, ACTION).unwrap_err();
        if change_identity {
            assert_eq!(
                error,
                InstallError::Catalog(tsumugi_plugin_host::catalog::CatalogError::IdentityMismatch)
            );
        } else {
            assert_eq!(error, InstallError::ActionConflict);
        }
        assert!(root.object(&approval).exists());
    }
}

#[test]
fn cached_links_and_writable_metadata_cannot_pass_digest_verification() {
    for kind in ["symlink", "hardlink", "writable-file", "writable-directory"] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let data = root.object(&approval).join("package/data");
        let marker = data.join("marker.txt");
        match kind {
            "symlink" => {
                let target = root.directory.path().join("outside.txt");
                fs::write(&target, b"original bytes").unwrap();
                mode(&data, 0o700);
                fs::remove_file(&marker).unwrap();
                symlink(&target, &marker).unwrap();
                mode(&data, 0o500);
            }
            "hardlink" => {
                fs::hard_link(&marker, root.directory.path().join("alias.txt")).unwrap();
            }
            "writable-file" => mode(&marker, 0o600),
            "writable-directory" => mode(&data, 0o700),
            _ => unreachable!(),
        }
        let error = store.load(&approval, || true).unwrap_err();
        assert!(
            matches!(
                error,
                InstallError::CorruptStore | InstallError::Host(HostError::PackagePath)
            ),
            "{kind}: {error:?}"
        );
        assert!(root.object(&approval).exists());
    }
}

#[test]
fn store_requires_existing_private_writable_root_and_an_unlinked_private_lock() {
    let root = OwnedRoot::new();
    assert_eq!(
        PackageStore::open_existing(&root.root.join("missing")).unwrap_err(),
        InstallError::InvalidRoot
    );
    for permissions in [0o750, 0o777, 0o500] {
        mode(&root.root, permissions);
        assert_eq!(
            PackageStore::open_existing(&root.root).unwrap_err(),
            InstallError::InvalidRoot
        );
    }
    mode(&root.root, 0o700);
    let alias = root.directory.path().join("root-alias");
    symlink(&root.root, &alias).unwrap();
    assert_eq!(
        PackageStore::open_existing(&alias).unwrap_err(),
        InstallError::InvalidRoot
    );
    let target = root.directory.path().join("lock-target");
    fs::write(&target, b"").unwrap();
    mode(&target, 0o600);
    symlink(&target, root.root.join(".lock")).unwrap();
    assert_eq!(
        PackageStore::open_existing(&root.root).unwrap_err(),
        InstallError::InvalidRoot
    );
    fs::remove_file(root.root.join(".lock")).unwrap();
    fs::hard_link(&target, root.root.join(".lock")).unwrap();
    assert_eq!(
        PackageStore::open_existing(&root.root).unwrap_err(),
        InstallError::InvalidRoot
    );
    assert!(target.exists());
}

#[test]
fn an_existing_objects_symlink_is_rejected_and_its_target_is_preserved() {
    let root = OwnedRoot::new();
    let target = root.directory.path().join("unrelated");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("marker.txt"), b"unrelated bytes").unwrap();
    symlink(&target, root.root.join("objects")).unwrap();
    assert_eq!(
        PackageStore::open_existing(&root.root).unwrap_err(),
        InstallError::CorruptStore
    );
    assert_eq!(
        fs::read(target.join("marker.txt")).unwrap(),
        b"unrelated bytes"
    );
}

#[test]
fn operating_system_lock_serializes_store_owners_until_close() {
    let root = OwnedRoot::new();
    let first = PackageStore::open_existing(&root.root).unwrap();
    assert_eq!(
        PackageStore::open_existing(&root.root).unwrap_err(),
        InstallError::Busy
    );
    drop(first);
    let second = PackageStore::open_existing(&root.root).unwrap();
    assert_eq!(
        PackageStore::open_existing(&root.root).unwrap_err(),
        InstallError::Busy
    );
    drop(second);
    assert!(PackageStore::open_existing(&root.root).is_ok());
}

#[test]
fn interrupted_and_unknown_candidates_are_retained_and_never_loaded_or_cleaned() {
    let root = OwnedRoot::new();
    let unknown = root.root.join(".candidate-unknown");
    fs::write(&unknown, b"unrelated interrupted data").unwrap();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let package = catalog.registered(&approval.plugin).unwrap();
    assert_eq!(
        store
            .install(ACTION, package, || root.candidates().len() == 1)
            .unwrap_err(),
        InstallError::AuthorityRevoked
    );
    assert_eq!(root.candidates().len(), 2);
    assert_eq!(
        store.load(&approval, || true).unwrap_err(),
        InstallError::MissingPackage
    );
    install(&mut store, &catalog, &approval, ACTION).unwrap();
    assert_eq!(root.candidates().len(), 2);
    assert_eq!(fs::read(&unknown).unwrap(), b"unrelated interrupted data");
    assert!(store.load(&approval, || true).is_ok());
}

#[test]
fn revocation_after_promotion_reports_unknown_commit_and_original_action_can_recover() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let object = root.object(&approval);
    assert_eq!(
        store
            .install(
                ACTION,
                catalog.registered(&approval.plugin).unwrap(),
                || !object.exists()
            )
            .unwrap_err(),
        InstallError::UnknownCommit
    );
    assert!(object.join("receipt.json").exists());
    assert!(root.candidates().is_empty());
    assert_eq!(
        fs::metadata(&object).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        store.load(&approval, || true).unwrap_err(),
        InstallError::RecoveryRequired
    );
    assert_eq!(
        install(&mut store, &catalog, &approval, OTHER_ACTION).unwrap_err(),
        InstallError::ActionConflict
    );
    let (other, other_approval) = fixture("example.other", "0.1.0", "other package", origin());
    assert_eq!(
        install(&mut store, &other, &other_approval, OTHER_ACTION).unwrap_err(),
        InstallError::RecoveryRequired
    );
    assert_eq!(
        install(&mut store, &other, &other_approval, ACTION).unwrap_err(),
        InstallError::ActionConflict
    );
    assert!(!root.object(&other_approval).exists());
    assert_eq!(
        fs::metadata(&object).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(root.candidates().is_empty());
    drop(store);
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    assert_eq!(
        store.load(&approval, || true).unwrap_err(),
        InstallError::RecoveryRequired
    );
    let recovered = install(&mut store, &catalog, &approval, ACTION).unwrap();
    assert_eq!(recovered.action_id(), ACTION);
    assert_eq!(
        fs::metadata(&object).unwrap().permissions().mode() & 0o777,
        0o500
    );
    assert_eq!(
        store.load(&approval, || true).unwrap().receipt(),
        &recovered
    );
    assert_eq!(
        install(&mut store, &catalog, &approval, OTHER_ACTION).unwrap_err(),
        InstallError::ActionConflict
    );
}

#[test]
fn root_or_lock_replacement_before_promotion_stops_writes_without_cleaning_files() {
    for replace_root in [true, false] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        let changed = Cell::new(false);
        let result = store.install(
            ACTION,
            catalog.registered(&approval.plugin).unwrap(),
            || {
                if !changed.get() && !root.candidates().is_empty() {
                    changed.set(true);
                    if replace_root {
                        fs::rename(&root.root, root.directory.path().join("old-store")).unwrap();
                        fs::create_dir(&root.root).unwrap();
                        mode(&root.root, 0o700);
                    } else {
                        fs::rename(root.root.join(".lock"), root.root.join(".old-lock")).unwrap();
                        fs::write(root.root.join(".lock"), b"").unwrap();
                        mode(&root.root.join(".lock"), 0o600);
                    }
                }
                true
            },
        );
        assert_eq!(result.unwrap_err(), InstallError::StoreChanged);
        assert!(changed.get());
        assert!(!root.object(&approval).exists());
        if replace_root {
            assert!(root.directory.path().join("old-store").exists());
        } else {
            assert!(root.root.join(".old-lock").exists());
            assert_eq!(root.candidates().len(), 1);
        }
    }
}

#[test]
fn object_enumeration_is_bounded_and_does_not_delete_excess_or_bad_objects() {
    let root = OwnedRoot::new();
    let (catalog, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    for index in 0..=MAX_INSTALLED_PACKAGES {
        fs::create_dir(root.root.join("objects").join(format!("{index:064x}"))).unwrap();
    }
    assert_eq!(
        install(&mut store, &catalog, &approval, ACTION).unwrap_err(),
        InstallError::LimitExceeded
    );
    assert_eq!(
        store.load(&approval, || true).unwrap_err(),
        InstallError::LimitExceeded
    );
    assert_eq!(
        fs::read_dir(root.root.join("objects")).unwrap().count(),
        MAX_INSTALLED_PACKAGES + 1
    );
    assert!(root.candidates().is_empty());
}

#[test]
fn a_full_valid_store_allows_original_action_retry_and_rejects_a_new_object() {
    let root = OwnedRoot::new();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let (first, first_approval) = fixture("example.resource", "0.0.0", "entry-0", origin());
    write_fixture_object(&root, &first, &first_approval, ACTION, "entry-0");
    for index in 1..MAX_INSTALLED_PACKAGES {
        let marker = format!("entry-{index}");
        let (catalog, approval) = fixture(
            "example.resource",
            &format!("0.{index}.0"),
            &marker,
            origin(),
        );
        let action = uuid::Uuid::from_u128(index as u128 + 1)
            .hyphenated()
            .to_string();
        write_fixture_object(&root, &catalog, &approval, &action, &marker);
    }
    let receipt = install(&mut store, &first, &first_approval, ACTION).unwrap();
    assert_eq!(receipt.action_id(), ACTION);
    let (next, next_approval) = fixture("example.resource", "0.128.0", "new object", origin());
    assert_eq!(
        install(&mut store, &next, &next_approval, OTHER_ACTION).unwrap_err(),
        InstallError::LimitExceeded
    );
    assert_eq!(
        fs::read_dir(root.root.join("objects")).unwrap().count(),
        MAX_INSTALLED_PACKAGES
    );
    assert!(root.candidates().is_empty());
}

#[test]
fn directory_depth_profile_agrees_across_capture_install_and_reopen() {
    for depth in [16, 17] {
        let root = OwnedRoot::new();
        let source = root.directory.path().join("selected-package");
        fs::create_dir(&source).unwrap();
        let path = format!("{}resource.json", "nested/".repeat(depth));
        let manifest = sdk::PluginManifest {
            protocol_version: sdk::MANIFEST_PROTOCOL,
            plugin: sdk::PluginIdentity {
                publisher: "example".into(),
                id: "example.deep".into(),
                version: "0.1.0".into(),
            },
            permissions: vec![],
            components: vec![sdk::ComponentDeclaration {
                id: "data".into(),
                scope: sdk::ComponentScope::Application,
                runtime: sdk::RuntimeKind::Data,
                entrypoint: None,
                dependencies: vec![],
                exit: sdk::ExitRequirements {
                    stop_timeout_ms: 100,
                    cleanup_timeout_ms: 100,
                },
            }],
            contributions: vec![sdk::ContributionDeclaration {
                id: "resource".into(),
                component_id: "data".into(),
                contribution: sdk::ContributionKind::Resource {
                    schema: contract("example.resource"),
                    path: path.clone(),
                },
            }],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let files = BTreeMap::from([(
            path.clone(),
            PackageFile {
                bytes: b"{}".to_vec(),
                executable: false,
            },
        )]);
        let digest = PackageImage::digest(&bytes, &files).unwrap();
        let approval = PackageApproval {
            plugin: manifest.plugin,
            package_digest: digest.clone(),
            origin: origin(),
        };
        fs::write(source.join("manifest.json"), &bytes).unwrap();
        let resource = source.join(&path);
        fs::create_dir_all(resource.parent().unwrap()).unwrap();
        fs::write(&resource, b"{}").unwrap();
        let captured = PackageImage::capture_directory(&source, &digest, || true);
        let image = if depth == 16 {
            captured.unwrap()
        } else {
            assert!(matches!(captured, Err(HostError::PackageLimit)));
            // In-memory capture has no directory traversal. Installation must
            // still apply the same on-disk profile before promoting its bytes.
            PackageImage::capture(bytes, files, &digest).unwrap()
        };
        let mut catalog = PackageCatalog::new();
        catalog.register(image, approval.clone()).unwrap();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        if depth == 16 {
            let receipt = install(&mut store, &catalog, &approval, ACTION).unwrap();
            drop(store);
            let reopened = PackageStore::open_existing(&root.root).unwrap();
            assert_eq!(
                reopened.load(&approval, || true).unwrap().receipt(),
                &receipt
            );
            assert_eq!(
                fs::read(root.object(&approval).join("package").join(&path)).unwrap(),
                b"{}"
            );
        } else {
            assert_eq!(
                install(&mut store, &catalog, &approval, ACTION).unwrap_err(),
                InstallError::Host(HostError::PackageLimit)
            );
            assert!(!root.object(&approval).exists());
            assert_eq!(
                store.load(&approval, || true).unwrap_err(),
                InstallError::MissingPackage
            );
        }
    }
}
