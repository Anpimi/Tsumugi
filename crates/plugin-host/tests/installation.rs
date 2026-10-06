#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

use tsumugi_plugin_host::{
    HostError, InstallError, InstallReceipt, InstalledObjectState, MAX_INSTALLED_PACKAGES,
    PackageFile, PackageImage, PackageStore,
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

#[test]
fn provision_creates_private_suffix_reopens_and_preserves_store_lock() {
    let owned = OwnedRoot::new();
    let anchor = owned.directory.path();
    mode(anchor, 0o755);
    let suffix = ["application", "plugins"];
    let path = anchor.join("application/plugins");
    let mut store = PackageStore::provision(anchor, &suffix, || true).unwrap();
    assert_eq!(
        fs::metadata(anchor).unwrap().permissions().mode() & 0o7777,
        0o755
    );
    for directory in [anchor.join("application"), path.clone()] {
        assert_eq!(
            fs::metadata(directory).unwrap().permissions().mode() & 0o7777,
            0o700
        );
    }
    assert_eq!(fs::read_dir(path.join("objects")).unwrap().count(), 0);
    assert_eq!(fs::read_dir(path.join("runtimes")).unwrap().count(), 0);
    assert_eq!(
        PackageStore::provision(anchor, &suffix, || true).unwrap_err(),
        InstallError::Busy
    );
    let (catalog, approval) = fixture("provisioned", "1.0.0", "stable", origin());
    assert!(!catalog.is_enabled(&approval.plugin).unwrap());
    let registered = catalog.registered(&approval.plugin).unwrap();
    let receipt = store.install(ACTION, registered, || true).unwrap();
    drop(store);
    let store = PackageStore::provision(anchor, &suffix, || true).unwrap();
    assert_eq!(store.load(&approval, || true).unwrap().receipt(), &receipt);
    assert!(!catalog.is_enabled(&approval.plugin).unwrap());
}

#[test]
fn provision_rejects_invalid_suffix_before_any_directory_write() {
    let temporary = tempfile::tempdir().unwrap();
    let long_name = "a".repeat(129);
    for suffix in [
        vec![],
        vec!["valid", ".."],
        vec!["."],
        vec![""],
        vec![" leading"],
        vec!["child/escape"],
        vec!["child\\escape"],
        vec!["line\nbreak"],
        vec![long_name.as_str()],
        vec!["a"; 9],
    ] {
        assert_eq!(
            PackageStore::provision(temporary.path(), &suffix, || true).unwrap_err(),
            InstallError::InvalidRoot,
            "{suffix:?}"
        );
        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 0);
    }
}

#[test]
fn provision_preserves_existing_wrong_permissions_and_rejects_writable_anchor() {
    for bad_index in [0, 1] {
        let temporary = tempfile::tempdir().unwrap();
        let app = temporary.path().join("application");
        let plugins = app.join("plugins");
        fs::create_dir(&app).unwrap();
        fs::create_dir(&plugins).unwrap();
        mode(&app, 0o700);
        mode(&plugins, 0o700);
        let changed = if bad_index == 0 { &app } else { &plugins };
        mode(changed, 0o755);
        let sentinel = changed.join("preserved");
        fs::write(&sentinel, b"user-owned bytes").unwrap();
        assert_eq!(
            PackageStore::provision(temporary.path(), &["application", "plugins"], || true)
                .unwrap_err(),
            InstallError::InvalidRoot
        );
        assert_eq!(
            fs::metadata(changed).unwrap().permissions().mode() & 0o7777,
            0o755
        );
        assert_eq!(fs::read(sentinel).unwrap(), b"user-owned bytes");
        assert!(!plugins.join(".lock").exists());
    }
    let temporary = tempfile::tempdir().unwrap();
    mode(temporary.path(), 0o777);
    assert_eq!(
        PackageStore::provision(temporary.path(), &["plugins"], || true).unwrap_err(),
        InstallError::InvalidRoot
    );
    assert!(!temporary.path().join("plugins").exists());
    assert_eq!(
        fs::metadata(temporary.path()).unwrap().permissions().mode() & 0o7777,
        0o777
    );
}

#[test]
fn provision_rejects_anchor_and_suffix_links_and_regular_files() {
    for at_anchor in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let selected = temporary.path().join("selected");
        let target = temporary.path().join("target");
        fs::create_dir(&target).unwrap();
        mode(&target, 0o700);
        fs::write(target.join("preserved"), b"original").unwrap();
        if at_anchor {
            symlink(&target, &selected).unwrap();
        } else {
            fs::create_dir(&selected).unwrap();
            mode(&selected, 0o700);
            symlink(&target, selected.join("plugins")).unwrap();
        }
        assert_eq!(
            PackageStore::provision(&selected, &["plugins"], || true).unwrap_err(),
            InstallError::InvalidRoot
        );
        assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
        assert_eq!(fs::read(target.join("preserved")).unwrap(), b"original");
    }
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("plugins"), b"existing file").unwrap();
    assert_eq!(
        PackageStore::provision(temporary.path(), &["plugins"], || true).unwrap_err(),
        InstallError::InvalidRoot
    );
    assert_eq!(
        fs::read(temporary.path().join("plugins")).unwrap(),
        b"existing file"
    );
}

#[test]
fn provision_revocation_leaves_no_store_and_same_suffix_can_resume() {
    let temporary = tempfile::tempdir().unwrap();
    assert_eq!(
        PackageStore::provision(temporary.path(), &["application", "plugins"], || false)
            .unwrap_err(),
        InstallError::AuthorityRevoked
    );
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 0);
    let app = temporary.path().join("application");
    assert_eq!(
        PackageStore::provision(temporary.path(), &["application", "plugins"], || !app
            .exists())
        .unwrap_err(),
        InstallError::AuthorityRevoked
    );
    assert!(app.is_dir());
    assert!(!app.join("plugins").exists());
    let store =
        PackageStore::provision(temporary.path(), &["application", "plugins"], || true).unwrap();
    drop(store);
    assert!(app.join("plugins/objects").is_dir());
}

#[test]
fn provision_detects_anchor_suffix_and_initialized_root_replacement() {
    for point in ["anchor", "suffix", "root"] {
        let temporary = tempfile::tempdir().unwrap();
        let anchor = temporary.path().join("anchor");
        fs::create_dir(&anchor).unwrap();
        mode(&anchor, 0o700);
        let app = anchor.join("application");
        let root = app.join("plugins");
        let replaced = Cell::new(false);
        let selected = match point {
            "anchor" => anchor.clone(),
            "suffix" => app.clone(),
            "root" => root.clone(),
            _ => unreachable!(),
        };
        let held = temporary.path().join("original-held");
        let result = PackageStore::provision(&anchor, &["application", "plugins"], || {
            let reached = if point == "root" {
                root.join(".lock").exists()
            } else {
                app.exists()
            };
            if reached && !replaced.replace(true) {
                fs::rename(&selected, &held).unwrap();
                fs::create_dir(&selected).unwrap();
                mode(&selected, 0o700);
                fs::write(selected.join("preserved"), b"replacement bytes").unwrap();
            }
            true
        });
        assert_eq!(result.unwrap_err(), InstallError::StoreChanged, "{point}");
        assert!(replaced.get());
        assert_eq!(
            fs::read(selected.join("preserved")).unwrap(),
            b"replacement bytes"
        );
        assert_eq!(fs::read_dir(&selected).unwrap().count(), 1);
        assert!(held.is_dir());
    }
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
    let inventory = store.inventory(|| true).unwrap();
    assert!(inventory.runtimes.is_empty());
    let mut expected = vec![old_receipt, new_receipt];
    expected.sort_by(|a, b| a.package_digest().cmp(b.package_digest()));
    assert_eq!(
        inventory
            .packages
            .iter()
            .map(|p| p.receipt.clone())
            .collect::<Vec<_>>(),
        expected
    );
    assert!(
        inventory
            .packages
            .iter()
            .all(|p| p.state == InstalledObjectState::Sealed)
    );
    assert!(!old.is_enabled(&old_approval.plugin).unwrap());
    assert!(!new.is_enabled(&new_approval.plugin).unwrap());
    drop(store);
    assert_eq!(
        PackageStore::open_existing(&root.root)
            .unwrap()
            .inventory(|| true)
            .unwrap(),
        inventory
    );
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
    let inventory = store.inventory(|| true).unwrap();
    assert_eq!(inventory.packages.len(), 1);
    assert_eq!(inventory.packages[0].state, InstalledObjectState::Sealed);
    assert_eq!(&inventory.packages[0].receipt, prior.receipt());
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
            store.inventory(|| true).unwrap_err(),
            InstallError::CorruptReceipt,
            "{kind}"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
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
        if change_identity {
            assert_eq!(
                store.inventory(|| true).unwrap_err(),
                InstallError::CorruptReceipt
            );
        } else {
            // Observation of a legal origin is not authentication or approval.
            assert_eq!(
                store.inventory(|| true).unwrap().packages[0]
                    .receipt
                    .origin()
                    .source_id,
                "other-registry"
            );
        }
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
        assert!(store.inventory(|| true).is_err(), "{kind}");
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
    let inventory = store.inventory(|| true).unwrap();
    assert!(inventory.packages.is_empty() && inventory.runtimes.is_empty());
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
    let pending_receipt = fs::read(object.join("receipt.json")).unwrap();
    let inventory = store.inventory(|| true).unwrap();
    assert_eq!(inventory.packages.len(), 1);
    assert_eq!(
        inventory.packages[0].state,
        InstalledObjectState::RecoveryRequired
    );
    assert_eq!(inventory.packages[0].receipt.action_id(), ACTION);
    assert_eq!(
        fs::read(object.join("receipt.json")).unwrap(),
        pending_receipt
    );
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
        store.inventory(|| true).unwrap_err(),
        InstallError::LimitExceeded
    );
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
    let inventory = store.inventory(|| true).unwrap();
    assert_eq!(inventory.packages.len(), MAX_INSTALLED_PACKAGES);
    assert!(inventory.runtimes.is_empty());
    assert!(
        inventory
            .packages
            .windows(2)
            .all(|pair| pair[0].receipt.package_digest() < pair[1].receipt.package_digest())
    );
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

#[test]
fn inventory_rejects_invalid_manifest_identity_origin_and_oversized_metadata_without_repair() {
    for damage in [
        "manifest-unknown",
        "manifest-duplicate",
        "manifest-identity",
        "manifest-oversized",
        "origin",
        "bytes",
    ] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let object = root.object(&approval);
        let path = if damage == "origin" {
            object.join("receipt.json")
        } else {
            object.join("package/manifest.json")
        };
        let original = fs::read(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
        let expected = match damage {
            "manifest-unknown" => {
                value["executionAllowed"] = true.into();
                replace_receipt(&path, &serde_json::to_vec(&value).unwrap());
                InstallError::CorruptStore
            }
            "manifest-duplicate" => {
                let mut bytes = b"{\"protocolVersion\":1,".to_vec();
                bytes.extend_from_slice(&original[1..]);
                replace_receipt(&path, &bytes);
                InstallError::CorruptStore
            }
            "manifest-identity" => {
                value["plugin"]["id"] = "example.other".into();
                replace_receipt(&path, &serde_json::to_vec(&value).unwrap());
                InstallError::CorruptReceipt
            }
            "manifest-oversized" => {
                replace_receipt(&path, &vec![b' '; sdk::MAX_MANIFEST_BYTES + 1]);
                InstallError::CorruptStore
            }
            "origin" => {
                value["origin"]["sourceId"] = "invalid origin".into();
                replace_receipt(&path, &serde_json::to_vec(&value).unwrap());
                InstallError::CorruptReceipt
            }
            "bytes" => {
                let marker = object.join("package/data/marker.txt");
                mode(&marker, 0o600);
                fs::OpenOptions::new()
                    .write(true)
                    .open(&marker)
                    .unwrap()
                    .set_len(64 * 1024 * 1024 + 1)
                    .unwrap();
                mode(&marker, 0o400);
                InstallError::CorruptStore
            }
            _ => unreachable!(),
        };
        let before = fs::read(&path).unwrap();
        assert_eq!(store.inventory(|| true).unwrap_err(), expected, "{damage}");
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(root.candidates().is_empty());
        assert_eq!(
            fs::metadata(&object).unwrap().permissions().mode() & 0o777,
            0o500
        );
    }
}

#[test]
fn inventory_rejects_existing_collection_conflicts_without_admitting_or_removing_objects() {
    for conflict in ["action", "identity", "source", "publisher"] {
        let root = OwnedRoot::new();
        let store = PackageStore::open_existing(&root.root).unwrap();
        let (first, first_approval) = basic();
        write_fixture_object(&root, &first, &first_approval, ACTION, "original bytes");
        let mut second_origin = origin();
        match conflict {
            "source" => second_origin.source_id = "other-registry".into(),
            "publisher" => second_origin.publisher_id = "other-key".into(),
            _ => (),
        }
        let version = if conflict == "identity" {
            "0.1.0"
        } else {
            "0.2.0"
        };
        let (second, second_approval) = fixture(
            "example.resource",
            version,
            "different bytes",
            second_origin,
        );
        let action = if conflict == "action" {
            ACTION
        } else {
            OTHER_ACTION
        };
        write_fixture_object(&root, &second, &second_approval, action, "different bytes");
        assert_eq!(
            store.inventory(|| true).unwrap_err(),
            InstallError::CorruptStore,
            "{conflict}"
        );
        assert_eq!(fs::read_dir(root.root.join("objects")).unwrap().count(), 2);
        assert!(root.object(&first_approval).join("receipt.json").exists());
        assert!(root.object(&second_approval).join("receipt.json").exists());
        assert!(root.candidates().is_empty());
        assert!(!first.is_enabled(&first_approval.plugin).unwrap());
        assert!(!second.is_enabled(&second_approval.plugin).unwrap());
    }
}

#[test]
fn inventory_observed_replacement_and_revocation_preserve_every_tree() {
    for changed in ["root", "objects", "object", "revoked"] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let path = match changed {
            "root" => root.root.clone(),
            "objects" => root.root.join("objects"),
            _ => root.object(&approval),
        };
        let moved = root.directory.path().join("retained");
        let observed = Cell::new(false);
        let error = store
            .inventory(|| {
                if changed == "revoked" {
                    return false;
                }
                if !observed.replace(true) {
                    mode(&path, 0o700);
                    fs::rename(&path, &moved).unwrap();
                    fs::create_dir(&path).unwrap();
                    mode(&path, if changed == "object" { 0o500 } else { 0o700 });
                    fs::write(moved.join("preserved.txt"), b"fixture retained").unwrap();
                    if changed == "object" {
                        mode(&moved, 0o500);
                    }
                }
                true
            })
            .unwrap_err();
        if changed == "revoked" {
            assert_eq!(error, InstallError::AuthorityRevoked);
            assert!(root.object(&approval).join("receipt.json").exists());
        } else {
            assert!(
                matches!(
                    error,
                    InstallError::StoreChanged | InstallError::CorruptStore
                ),
                "{changed}: {error:?}"
            );
            assert!(path.is_dir());
            assert_eq!(
                fs::read(moved.join("preserved.txt")).unwrap(),
                b"fixture retained"
            );
        }
    }
}

#[test]
fn inventory_rejects_manifest_changes_during_its_second_metadata_walk() {
    for replacement in [false, true] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let path = root.object(&approval).join("package/manifest.json");
        let original = fs::read(&path).unwrap();
        let calls = Cell::new(0usize);
        store
            .inventory(|| {
                calls.set(calls.get() + 1);
                true
            })
            .unwrap();
        // This fixture has two identical bounded tree walks around the manifest
        // read. Derive a point well inside the second walk from the same scan,
        // without fixing the number of guard checks in the implementation.
        let change_at = calls.get() * 2 / 3;
        calls.set(0);
        let changed = Cell::new(false);
        let retained = root.directory.path().join("retained-manifest.json");
        let error = store
            .inventory(|| {
                calls.set(calls.get() + 1);
                if calls.get() == change_at {
                    changed.set(true);
                    if replacement {
                        mode(path.parent().unwrap(), 0o700);
                        fs::rename(&path, &retained).unwrap();
                        fs::write(&path, &original).unwrap();
                        mode(&path, 0o400);
                        mode(path.parent().unwrap(), 0o500);
                    } else {
                        // Even semantically identical bytes are an observed write,
                        // and must not be confused with the captured manifest.
                        replace_receipt(&path, &original);
                    }
                }
                true
            })
            .unwrap_err();
        assert!(changed.get());
        assert_eq!(
            error,
            InstallError::StoreChanged,
            "replacement={replacement}"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        if replacement {
            assert_eq!(fs::read(&retained).unwrap(), original);
        }
        assert!(root.candidates().is_empty());
    }
}

#[test]
fn inventory_rejects_namespace_insertion_at_the_final_live_check() {
    for namespace in ["objects", "runtimes"] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let calls = Cell::new(0usize);
        store
            .inventory(|| {
                calls.set(calls.get() + 1);
                true
            })
            .unwrap();
        let final_check = calls.get();
        calls.set(0);
        let inserted = root.root.join(namespace).join("0".repeat(64));
        let error = store
            .inventory(|| {
                calls.set(calls.get() + 1);
                if calls.get() == final_check {
                    fs::create_dir(&inserted).unwrap();
                    fs::write(inserted.join("preserved.txt"), b"concurrent fixture").unwrap();
                }
                true
            })
            .unwrap_err();
        assert_eq!(error, InstallError::StoreChanged, "{namespace}");
        assert_eq!(
            fs::read(inserted.join("preserved.txt")).unwrap(),
            b"concurrent fixture"
        );
        assert!(root.object(&approval).join("receipt.json").exists());
        assert!(root.candidates().is_empty());
    }
}

fn settings_update(
    approval: &PackageApproval,
    enabled: bool,
) -> tsumugi_plugin_host::PluginSettingsUpdate {
    tsumugi_plugin_host::PluginSettingsUpdate {
        packages: vec![tsumugi_plugin_host::ApprovedPackageSetting {
            approval: approval.clone(),
            enabled,
        }],
        runtimes: vec![],
    }
}

fn settings_candidates(root: &OwnedRoot) -> Vec<PathBuf> {
    fs::read_dir(&root.root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".settings-candidate-")
        })
        .collect()
}

#[test]
fn settings_are_empty_until_an_independent_decision_and_reopen_exact_disabled_versions() {
    let root = OwnedRoot::new();
    let (old, old_approval) = basic();
    let (new, new_approval) = fixture("example.resource", "0.2.0", "new bytes", origin());
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    install(&mut store, &old, &old_approval, ACTION).unwrap();
    install(&mut store, &new, &new_approval, OTHER_ACTION).unwrap();
    let empty = store.settings(|| true).unwrap();
    assert_eq!(empty.revision(), 0);
    assert_eq!(empty.action_id(), None);
    assert!(empty.packages().is_empty() && empty.runtimes().is_empty());
    assert!(!root.root.join("settings.json").exists());
    let mut update = settings_update(&new_approval, false);
    update
        .packages
        .push(tsumugi_plugin_host::ApprovedPackageSetting {
            approval: old_approval.clone(),
            enabled: true,
        });
    let saved = store.update_settings(0, ACTION, &update, || true).unwrap();
    assert_eq!(saved.revision(), 1);
    assert_eq!(saved.action_id(), Some(ACTION));
    assert_eq!(saved.packages().len(), 2);
    assert_eq!(saved.packages()[0].approval, old_approval);
    assert!(saved.packages()[0].enabled);
    assert!(!saved.packages()[1].enabled);
    assert!(!old.is_enabled(&old_approval.plugin).unwrap());
    assert!(!new.is_enabled(&new_approval.plugin).unwrap());
    assert_eq!(
        fs::metadata(root.root.join("settings.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o400
    );
    assert!(settings_candidates(&root).is_empty());
    drop(store);
    let store = PackageStore::open_existing(&root.root).unwrap();
    assert_eq!(store.settings(|| true).unwrap(), saved);
    // Settings retention itself neither captures bytes nor changes either catalog.
    assert_eq!(
        store
            .load(&old_approval, || true)
            .unwrap()
            .receipt()
            .action_id(),
        ACTION
    );
    assert!(!old.is_enabled(&old_approval.plugin).unwrap());
}

#[test]
fn settings_revision_cas_and_exact_retry_preserve_newer_decisions() {
    let root = OwnedRoot::new();
    let (_, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let enabled = settings_update(&approval, true);
    let first = store.update_settings(0, ACTION, &enabled, || true).unwrap();
    let first_bytes = fs::read(root.root.join("settings.json")).unwrap();
    assert_eq!(
        store.update_settings(0, ACTION, &enabled, || true).unwrap(),
        first
    );
    assert_eq!(
        fs::read(root.root.join("settings.json")).unwrap(),
        first_bytes
    );
    assert_eq!(
        store
            .update_settings(0, ACTION, &settings_update(&approval, false), || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    assert_eq!(
        store
            .update_settings(0, OTHER_ACTION, &enabled, || true)
            .unwrap_err(),
        InstallError::RevisionConflict
    );
    let second = store
        .update_settings(1, OTHER_ACTION, &settings_update(&approval, false), || true)
        .unwrap();
    assert_eq!(second.revision(), 2);
    assert!(!second.packages()[0].enabled);
    let second_bytes = fs::read(root.root.join("settings.json")).unwrap();
    assert_eq!(
        store
            .update_settings(0, ACTION, &enabled, || true)
            .unwrap_err(),
        InstallError::RevisionConflict
    );
    assert_eq!(store.settings(|| true).unwrap(), second);
    assert_eq!(
        fs::read(root.root.join("settings.json")).unwrap(),
        second_bytes
    );
    assert!(settings_candidates(&root).is_empty());
}

#[test]
fn settings_reject_invalid_and_conflicting_decisions_before_writing() {
    for invalid in [
        "action",
        "revision-overflow",
        "identity",
        "version",
        "digest",
        "origin",
        "duplicate",
        "changed-digest",
        "source",
        "publisher",
        "capacity",
    ] {
        let root = OwnedRoot::new();
        let (_, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        let mut update = settings_update(&approval, false);
        let mut second = approval.clone();
        match invalid {
            "identity" => update.packages[0].approval.plugin.id = "Invalid ID".into(),
            "version" => update.packages[0].approval.plugin.version = "not-semver".into(),
            "digest" => update.packages[0].approval.package_digest = "A".repeat(64),
            "origin" => update.packages[0].approval.origin.source_id = "invalid origin".into(),
            "duplicate" => update.packages.push(update.packages[0].clone()),
            "changed-digest" => {
                second.package_digest = "a".repeat(64);
                update
                    .packages
                    .push(tsumugi_plugin_host::ApprovedPackageSetting {
                        approval: second,
                        enabled: true,
                    });
            }
            "source" | "publisher" => {
                second.plugin.version = "0.2.0".into();
                if invalid == "source" {
                    second.origin.source_id = "other-source".into();
                } else {
                    second.origin.publisher_id = "other-key".into();
                }
                update
                    .packages
                    .push(tsumugi_plugin_host::ApprovedPackageSetting {
                        approval: second,
                        enabled: true,
                    });
            }
            "capacity" => {
                update.packages = vec![update.packages[0].clone(); MAX_INSTALLED_PACKAGES + 1]
            }
            _ => (),
        }
        let action = if invalid == "action" {
            "not-action"
        } else {
            ACTION
        };
        let expected = if invalid == "revision-overflow" {
            u64::MAX
        } else {
            0
        };
        assert!(
            store
                .update_settings(expected, action, &update, || true)
                .is_err(),
            "{invalid}"
        );
        assert!(!root.root.join("settings.json").exists());
        assert!(settings_candidates(&root).is_empty());
        assert_eq!(store.settings(|| true).unwrap().revision(), 0);
    }
}

#[test]
fn malformed_settings_are_preserved_and_never_rebuilt_from_installation_receipts() {
    for damage in [
        "unknown",
        "duplicate",
        "version",
        "zero-revision",
        "missing-action",
        "nested-unknown",
        "enabled-missing",
        "invalid-identity",
        "oversized",
    ] {
        let root = OwnedRoot::new();
        let (catalog, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        install(&mut store, &catalog, &approval, ACTION).unwrap();
        let update = settings_update(&approval, false);
        let settings = store.update_settings(0, ACTION, &update, || true).unwrap();
        let original = serde_json::to_vec(&settings).unwrap();
        let mut value = serde_json::to_value(&settings).unwrap();
        let bytes = match damage {
            "unknown" => {
                value["grant"] = "synthetic".into();
                serde_json::to_vec(&value).unwrap()
            }
            "duplicate" => {
                let mut data = b"{\"revision\":1,".to_vec();
                data.extend_from_slice(&original[1..]);
                data
            }
            "version" => {
                value["formatVersion"] = 99.into();
                serde_json::to_vec(&value).unwrap()
            }
            "zero-revision" => {
                value["revision"] = 0.into();
                serde_json::to_vec(&value).unwrap()
            }
            "missing-action" => {
                value.as_object_mut().unwrap().remove("actionId");
                serde_json::to_vec(&value).unwrap()
            }
            "nested-unknown" => {
                value["packages"][0]["approval"]["origin"]["credential"] = "synthetic".into();
                serde_json::to_vec(&value).unwrap()
            }
            "enabled-missing" => {
                value["packages"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("enabled");
                serde_json::to_vec(&value).unwrap()
            }
            "invalid-identity" => {
                value["packages"][0]["approval"]["plugin"]["id"] = "Invalid ID".into();
                serde_json::to_vec(&value).unwrap()
            }
            "oversized" => vec![b' '; 1024 * 1024 + 1],
            _ => unreachable!(),
        };
        let path = root.root.join("settings.json");
        replace_receipt(&path, &bytes);
        assert_eq!(
            store.settings(|| true).unwrap_err(),
            InstallError::CorruptSettings,
            "{damage}"
        );
        assert_eq!(
            store
                .update_settings(1, OTHER_ACTION, &update, || true)
                .unwrap_err(),
            InstallError::CorruptSettings,
            "{damage}"
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(store.inventory(|| true).unwrap().packages.len(), 1);
        assert!(settings_candidates(&root).is_empty());
    }
}

#[test]
fn unsafe_settings_entries_are_errors_instead_of_empty_state_and_remain_untouched() {
    for kind in [
        "symlink",
        "dangling-symlink",
        "hardlink",
        "writable",
        "directory",
        "fifo",
    ] {
        let root = OwnedRoot::new();
        let (_, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        let update = settings_update(&approval, false);
        let path = root.root.join("settings.json");
        let target = root.directory.path().join("retained-settings");
        if matches!(kind, "hardlink" | "writable") {
            store.update_settings(0, ACTION, &update, || true).unwrap();
        }
        match kind {
            "symlink" => {
                fs::write(&target, b"retained fixture").unwrap();
                symlink(&target, &path).unwrap();
            }
            "dangling-symlink" => symlink(&target, &path).unwrap(),
            "hardlink" => fs::hard_link(&path, &target).unwrap(),
            "writable" => mode(&path, 0o600),
            "directory" => fs::create_dir(&path).unwrap(),
            "fifo" => {
                use std::os::unix::ffi::OsStrExt;
                let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            }
            _ => unreachable!(),
        }
        assert!(store.settings(|| true).is_err(), "{kind}");
        assert!(
            store
                .update_settings(0, OTHER_ACTION, &update, || true)
                .is_err(),
            "{kind}"
        );
        assert!(fs::symlink_metadata(&path).is_ok());
        if kind == "symlink" {
            assert_eq!(fs::read(&target).unwrap(), b"retained fixture");
        }
        assert!(settings_candidates(&root).is_empty());
    }
}

#[test]
fn settings_pre_promotion_revocation_preserves_old_snapshot_and_private_candidate() {
    let root = OwnedRoot::new();
    let (_, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let first = store
        .update_settings(0, ACTION, &settings_update(&approval, false), || true)
        .unwrap();
    assert_eq!(
        store
            .update_settings(1, OTHER_ACTION, &settings_update(&approval, true), || {
                settings_candidates(&root).is_empty()
            })
            .unwrap_err(),
        InstallError::AuthorityRevoked
    );
    assert_eq!(store.settings(|| true).unwrap(), first);
    let candidates = settings_candidates(&root);
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        fs::metadata(&candidates[0]).unwrap().permissions().mode() & 0o7777,
        0o600
    );
    assert_eq!(
        store
            .update_settings(1, OTHER_ACTION, &settings_update(&approval, true), || true)
            .unwrap()
            .revision(),
        2
    );
    assert!(candidates[0].exists());
}

#[test]
fn settings_post_promotion_revocation_requires_exact_intent_reconciliation() {
    let root = OwnedRoot::new();
    let (_, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let enabled = settings_update(&approval, true);
    assert_eq!(
        store
            .update_settings(0, ACTION, &enabled, || !root
                .root
                .join("settings.json")
                .exists())
            .unwrap_err(),
        InstallError::UnknownCommit
    );
    let visible = store.settings(|| true).unwrap();
    assert_eq!(visible.revision(), 1);
    assert!(visible.packages()[0].enabled);
    assert_eq!(
        store
            .update_settings(0, OTHER_ACTION, &enabled, || true)
            .unwrap_err(),
        InstallError::RevisionConflict
    );
    assert_eq!(
        store
            .update_settings(0, ACTION, &settings_update(&approval, false), || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    let before = fs::read(root.root.join("settings.json")).unwrap();
    drop(store);
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    assert_eq!(
        store.update_settings(0, ACTION, &enabled, || true).unwrap(),
        visible
    );
    assert_eq!(fs::read(root.root.join("settings.json")).unwrap(), before);
    assert!(settings_candidates(&root).is_empty());
}

#[test]
fn settings_observed_replacement_during_candidate_write_is_preserved_and_rejected() {
    for target in ["settings", "candidate", "root"] {
        let root = OwnedRoot::new();
        let (_, approval) = basic();
        let mut store = PackageStore::open_existing(&root.root).unwrap();
        store
            .update_settings(0, ACTION, &settings_update(&approval, false), || true)
            .unwrap();
        let moved = root.directory.path().join("retained-entry");
        let changed = Cell::new(false);
        let error = store
            .update_settings(1, OTHER_ACTION, &settings_update(&approval, true), || {
                let candidates = settings_candidates(&root);
                if !changed.get() && !candidates.is_empty() {
                    changed.set(true);
                    let path = match target {
                        "settings" => root.root.join("settings.json"),
                        "candidate" => candidates[0].clone(),
                        _ => root.root.clone(),
                    };
                    fs::rename(&path, &moved).unwrap();
                    if target == "root" {
                        fs::create_dir(&path).unwrap();
                        mode(&path, 0o700);
                    } else {
                        fs::write(&path, b"concurrent fixture").unwrap();
                        mode(&path, 0o400);
                    }
                }
                true
            })
            .unwrap_err();
        assert!(changed.get());
        assert_eq!(error, InstallError::StoreChanged, "{target}");
        assert!(moved.exists());
        if target != "root" {
            let path = if target == "settings" {
                root.root.join("settings.json")
            } else {
                settings_candidates(&root)[0].clone()
            };
            assert_eq!(fs::read(path).unwrap(), b"concurrent fixture");
        }
    }
}

#[test]
fn settings_accepts_128_distinct_package_decisions_and_preserves_them_when_129_is_refused() {
    let root = OwnedRoot::new();
    let (_, approval) = basic();
    let mut update = tsumugi_plugin_host::PluginSettingsUpdate::default();
    for index in 0..MAX_INSTALLED_PACKAGES {
        let mut approval = approval.clone();
        approval.plugin.version = format!("0.{index}.0");
        approval.package_digest = format!("{:064x}", index + 1);
        update
            .packages
            .push(tsumugi_plugin_host::ApprovedPackageSetting {
                approval,
                enabled: false,
            });
    }
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let saved = store.update_settings(0, ACTION, &update, || true).unwrap();
    assert_eq!(saved.packages().len(), MAX_INSTALLED_PACKAGES);
    assert!(saved.packages().iter().all(|package| !package.enabled));
    let bytes = fs::read(root.root.join("settings.json")).unwrap();
    let mut excess = approval;
    excess.plugin.version = "0.128.0".into();
    update
        .packages
        .push(tsumugi_plugin_host::ApprovedPackageSetting {
            approval: excess,
            enabled: true,
        });
    assert_eq!(
        store
            .update_settings(1, OTHER_ACTION, &update, || true)
            .unwrap_err(),
        InstallError::LimitExceeded
    );
    assert_eq!(fs::read(root.root.join("settings.json")).unwrap(), bytes);
    assert_eq!(store.settings(|| true).unwrap(), saved);
    assert!(settings_candidates(&root).is_empty());
}

#[test]
fn settings_candidate_bytes_changed_after_sealing_cannot_replace_the_old_state() {
    let root = OwnedRoot::new();
    let (_, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let saved = store
        .update_settings(0, ACTION, &settings_update(&approval, false), || true)
        .unwrap();
    let changed = Cell::new(false);
    let error = store
        .update_settings(1, OTHER_ACTION, &settings_update(&approval, true), || {
            if !changed.get() {
                for path in settings_candidates(&root) {
                    if fs::metadata(&path).unwrap().permissions().mode() & 0o7777 == 0o400 {
                        changed.set(true);
                        replace_receipt(&path, b"concurrent fixture");
                    }
                }
            }
            true
        })
        .unwrap_err();
    assert!(changed.get());
    assert_eq!(error, InstallError::StoreChanged);
    assert_eq!(store.settings(|| true).unwrap(), saved);
    let candidates = settings_candidates(&root);
    assert_eq!(candidates.len(), 1);
    assert_eq!(fs::read(&candidates[0]).unwrap(), b"concurrent fixture");
}

#[test]
fn settings_candidate_changed_after_write_is_rejected_before_replacing_the_old_snapshot() {
    let root = OwnedRoot::new();
    let (_, approval) = basic();
    let mut store = PackageStore::open_existing(&root.root).unwrap();
    let old = store
        .update_settings(0, ACTION, &settings_update(&approval, false), || true)
        .unwrap();
    let old_bytes = fs::read(root.root.join("settings.json")).unwrap();
    let changed = Cell::new(false);
    let error = store
        .update_settings(1, OTHER_ACTION, &settings_update(&approval, true), || {
            if !changed.get() {
                for path in settings_candidates(&root) {
                    let info = fs::metadata(&path).unwrap();
                    if info.len() > 0 && info.permissions().mode() & 0o7777 == 0o600 {
                        changed.set(true);
                        fs::write(&path, b"concurrent fixture").unwrap();
                    }
                }
            }
            true
        })
        .unwrap_err();
    assert!(changed.get());
    assert_eq!(error, InstallError::StoreChanged);
    assert_eq!(
        fs::read(root.root.join("settings.json")).unwrap(),
        old_bytes
    );
    assert_eq!(store.settings(|| true).unwrap(), old);
    let candidates = settings_candidates(&root);
    assert_eq!(candidates.len(), 1);
    assert_eq!(fs::read(&candidates[0]).unwrap(), b"concurrent fixture");
}
