#![cfg(all(
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "aarch64", target_arch = "x86_64")
))]

use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

use tsumugi_plugin_host::{
    CapturedRuntime, InstallError, MAX_INSTALLED_RUNTIMES, PackageFile, PackageImage, PackageStore,
    RuntimeApproval, RuntimeInstallReceipt,
    catalog::{PackageApproval, PackageCatalog, PackageOrigin},
};
use tsumugi_plugin_sdk as sdk;

const ACTION: &str = "00000000-0000-4000-8000-000000000001";
const OTHER_ACTION: &str = "00000000-0000-4000-8000-000000000002";

struct Fixture {
    temporary: tempfile::TempDir,
    root: PathBuf,
    tool: PathBuf,
    host: PathBuf,
    approval: RuntimeApproval,
    runtime: CapturedRuntime,
}

fn mode(path: &Path, value: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(value)).unwrap();
}
fn file(bytes: &[u8], executable: bool) -> sdk::RuntimeArtifactFile {
    sdk::RuntimeArtifactFile {
        bytes: bytes.to_vec(),
        executable,
    }
}
fn write_tree(root: &Path, files: &BTreeMap<String, sdk::RuntimeArtifactFile>) {
    fs::create_dir(root).unwrap();
    mode(root, 0o700);
    for (name, file) in files {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &file.bytes).unwrap();
        mode(&path, if file.executable { 0o700 } else { 0o600 });
    }
}
fn origin() -> PackageOrigin {
    PackageOrigin {
        source_id: "approved-registry".into(),
        publisher_id: "approved-key".into(),
    }
}
fn platform() -> sdk::RuntimePlatform {
    sdk::RuntimePlatform {
        operating_system: if cfg!(target_os = "macos") {
            sdk::RuntimeOperatingSystem::Macos
        } else {
            sdk::RuntimeOperatingSystem::Linux
        },
        architecture: if cfg!(target_arch = "aarch64") {
            sdk::RuntimeArchitecture::Aarch64
        } else {
            sdk::RuntimeArchitecture::X86_64
        },
    }
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("store");
        fs::create_dir(&root).unwrap();
        mode(&root, 0o700);
        let tool = temporary.path().join("tool");
        let host = temporary.path().join("host");
        let tool_files = BTreeMap::from([
            // Capture-only fixtures provide no evidence of a real Node tool.
            (
                "bin/node".into(),
                file(b"synthetic non-program\0\xff", true),
            ),
            ("LICENSE".into(), file(b"synthetic license", false)),
        ]);
        let host_files = BTreeMap::from([
            (
                "dist/main.js".into(),
                file(b"throw new Error('must never execute');\n", false),
            ),
            (
                "node_modules/example/index.js".into(),
                file(b"export const marker = 'A';\n", false),
            ),
        ]);
        write_tree(&tool, &tool_files);
        write_tree(&host, &host_files);
        let environment = sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: platform(),
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: sdk::runtime_artifact_digest(&tool_files).unwrap(),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: sdk::runtime_artifact_digest(&host_files).unwrap(),
                entrypoint: "dist/main.js".into(),
            },
        };
        let runtime =
            CapturedRuntime::capture_directories(&tool, &host, &environment, || true).unwrap();
        Self {
            temporary,
            root,
            tool,
            host,
            approval: RuntimeApproval {
                environment,
                origin: origin(),
            },
            runtime,
        }
    }
    fn object(&self) -> PathBuf {
        self.root
            .join("runtimes")
            .join(self.runtime.environment_digest())
    }
    fn receipt_path(&self) -> PathBuf {
        self.object().join("receipt.json")
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
impl Drop for Fixture {
    fn drop(&mut self) {
        fn prepare(path: &Path) {
            if fs::symlink_metadata(path).is_ok_and(|info| info.is_dir()) {
                mode(path, 0o700);
                for entry in fs::read_dir(path).unwrap() {
                    prepare(&entry.unwrap().path());
                }
            }
        }
        prepare(self.temporary.path());
    }
}

fn package() -> (PackageCatalog, PackageApproval) {
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: "example.resource".into(),
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
                schema: sdk::ContractRef {
                    id: "example.resource".into(),
                    schema_version: 1,
                    behavior_version: 1,
                },
                path: "resource.json".into(),
            },
        }],
    };
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([(
        "resource.json".into(),
        PackageFile {
            bytes: b"{}".to_vec(),
            executable: false,
        },
    )]);
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    let image = PackageImage::capture(bytes, files, &digest).unwrap();
    let approval = PackageApproval {
        plugin: manifest.plugin,
        package_digest: digest,
        origin: origin(),
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    (catalog, approval)
}

#[test]
fn reopen_uses_original_complete_bytes_after_sources_are_removed() {
    let fixture = Fixture::new();
    let receipt = {
        let mut store = PackageStore::open_existing(&fixture.root).unwrap();
        let receipt = store
            .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
            .unwrap();
        assert_eq!(receipt.action_id(), ACTION);
        assert_eq!(receipt.approval(), &fixture.approval);
        assert_eq!(
            receipt.environment_digest(),
            fixture.runtime.environment_digest()
        );
        assert_eq!(
            store
                .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
                .unwrap(),
            receipt
        );
        receipt
    };
    fs::write(fixture.host.join("dist/main.js"), b"changed source").unwrap();
    fs::remove_dir_all(&fixture.tool).unwrap();
    fs::remove_dir_all(&fixture.host).unwrap();
    let store = PackageStore::open_existing(&fixture.root).unwrap();
    let loaded = store.load_runtime(&fixture.approval, || true).unwrap();
    assert_eq!(loaded.receipt(), &receipt);
    assert_eq!(loaded.runtime().descriptor(), &fixture.approval.environment);
    let (catalog, approval) = package();
    assert!(!catalog.is_enabled(&approval.plugin).unwrap());
    assert_eq!(
        fs::read(fixture.object().join("tool/bin/node")).unwrap(),
        b"synthetic non-program\0\xff"
    );
    assert_eq!(
        fs::read(fixture.object().join("host/dist/main.js")).unwrap(),
        b"throw new Error('must never execute');\n"
    );
    assert_eq!(
        fs::read(fixture.object().join("host/node_modules/example/index.js")).unwrap(),
        b"export const marker = 'A';\n"
    );
}

#[test]
fn independent_origin_and_every_descriptor_field_control_admission() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    let mut wrong = fixture.approval.clone();
    wrong.environment.tool_version = "26.10.1".into();
    assert_eq!(
        store
            .install_runtime(ACTION, &fixture.runtime, &wrong, || true)
            .unwrap_err(),
        InstallError::ApprovalMismatch
    );
    assert!(fixture.candidates().is_empty());
    let mut invalid = fixture.approval.clone();
    invalid.origin.source_id = "https://unapproved.example/?token=secret".into();
    assert!(matches!(
        store.install_runtime(ACTION, &fixture.runtime, &invalid, || true),
        Err(InstallError::Catalog(_))
    ));
    store
        .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
        .unwrap();
    assert_eq!(
        store.load_runtime(&wrong, || true).unwrap_err(),
        InstallError::MissingRuntime
    );
    for field in ["source", "publisher"] {
        let mut wrong = fixture.approval.clone();
        if field == "source" {
            wrong.origin.source_id = "other-source".into();
        } else {
            wrong.origin.publisher_id = "other-publisher".into();
        }
        assert_eq!(
            store.load_runtime(&wrong, || true).unwrap_err(),
            InstallError::ApprovalMismatch
        );
        assert_eq!(
            store
                .install_runtime(OTHER_ACTION, &fixture.runtime, &wrong, || true)
                .unwrap_err(),
            if field == "source" {
                InstallError::SourceConflict
            } else {
                InstallError::PublisherConflict
            }
        );
    }
    assert_eq!(
        store
            .install_runtime(OTHER_ACTION, &fixture.runtime, &fixture.approval, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
}

#[test]
fn distinct_environments_coexist_and_old_approval_stays_exact() {
    let fixture = Fixture::new();
    let mut approval_b = fixture.approval.clone();
    approval_b.environment.tool_version = "26.10.1".into();
    let runtime_b = CapturedRuntime::capture_directories(
        &fixture.tool,
        &fixture.host,
        &approval_b.environment,
        || true,
    )
    .unwrap();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    store
        .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
        .unwrap();
    assert_eq!(
        store
            .install_runtime(ACTION, &runtime_b, &approval_b, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    store
        .install_runtime(OTHER_ACTION, &runtime_b, &approval_b, || true)
        .unwrap();
    drop(store);
    let store = PackageStore::open_existing(&fixture.root).unwrap();
    assert_eq!(
        store
            .load_runtime(&fixture.approval, || true)
            .unwrap()
            .runtime()
            .descriptor(),
        &fixture.approval.environment
    );
    assert_eq!(
        store
            .load_runtime(&approval_b, || true)
            .unwrap()
            .runtime()
            .descriptor(),
        &approval_b.environment
    );
    assert_eq!(
        fs::read_dir(fixture.root.join("runtimes")).unwrap().count(),
        2
    );
}

#[test]
fn package_and_runtime_actions_share_one_locked_namespace() {
    for runtime_first in [false, true] {
        let fixture = Fixture::new();
        let (catalog, approval) = package();
        let registered = catalog.registered(&approval.plugin).unwrap();
        let mut store = PackageStore::open_existing(&fixture.root).unwrap();
        assert_eq!(
            PackageStore::open_existing(&fixture.root).unwrap_err(),
            InstallError::Busy
        );
        if runtime_first {
            store
                .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
                .unwrap();
            assert_eq!(
                store.install(ACTION, registered, || true).unwrap_err(),
                InstallError::ActionConflict
            );
            store.install(OTHER_ACTION, registered, || true).unwrap();
        } else {
            store.install(ACTION, registered, || true).unwrap();
            assert_eq!(
                store
                    .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
                    .unwrap_err(),
                InstallError::ActionConflict
            );
            store
                .install_runtime(OTHER_ACTION, &fixture.runtime, &fixture.approval, || true)
                .unwrap();
        }
        store.load(&approval, || true).unwrap();
        store.load_runtime(&fixture.approval, || true).unwrap();
    }
}

#[test]
fn invalid_actions_never_create_candidates() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    for action in [
        "",
        "00000000-0000-0000-0000-000000000000",
        "00000000000040008000000000000001",
        "ABCDEF00-0000-4000-8000-000000000001",
    ] {
        assert_eq!(
            store
                .install_runtime(action, &fixture.runtime, &fixture.approval, || true)
                .unwrap_err(),
            InstallError::InvalidAction
        );
    }
    assert!(fixture.candidates().is_empty());
}

#[test]
fn cached_bytes_flags_and_unsafe_entries_are_rejected_without_removal() {
    for damage in [
        "bytes",
        "exec",
        "writable",
        "symlink",
        "hardlink",
        "directory-mode",
    ] {
        let fixture = Fixture::new();
        let mut store = PackageStore::open_existing(&fixture.root).unwrap();
        store
            .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
            .unwrap();
        let path = fixture.object().join("tool/bin/node");
        match damage {
            "bytes" => {
                mode(&path, 0o700);
                fs::write(&path, b"modified cached bytes").unwrap();
                mode(&path, 0o500);
            }
            "exec" => mode(&path, 0o400),
            "writable" => mode(&path, 0o700),
            "symlink" => {
                mode(path.parent().unwrap(), 0o700);
                fs::remove_file(&path).unwrap();
                symlink(fixture.tool.join("bin/node"), &path).unwrap();
                mode(path.parent().unwrap(), 0o500);
            }
            "hardlink" => fs::hard_link(&path, fixture.temporary.path().join("alias")).unwrap(),
            "directory-mode" => mode(path.parent().unwrap(), 0o700),
            _ => unreachable!(),
        }
        assert!(
            store.load_runtime(&fixture.approval, || true).is_err(),
            "{damage}"
        );
        assert!(
            store
                .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
                .is_err(),
            "{damage}"
        );
        assert!(fixture.receipt_path().exists());
        assert!(fs::symlink_metadata(&path).is_ok());
    }
}

#[test]
fn strict_receipts_cannot_replace_independent_approval() {
    for damage in ["unknown", "duplicate", "origin", "digest", "action"] {
        let fixture = Fixture::new();
        let mut store = PackageStore::open_existing(&fixture.root).unwrap();
        let receipt = store
            .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
            .unwrap();
        let mut value = serde_json::to_value(&receipt).unwrap();
        let bytes = match damage {
            "unknown" => {
                value["executionAllowed"] = true.into();
                serde_json::to_vec(&value).unwrap()
            }
            "duplicate" => {
                let mut bytes = serde_json::to_vec(&receipt).unwrap();
                bytes.pop();
                bytes.extend_from_slice(b",\"formatVersion\":1}");
                bytes
            }
            "origin" => {
                value["approval"]["origin"]["sourceId"] = "changed-source".into();
                serde_json::to_vec(&value).unwrap()
            }
            "digest" => {
                value["environmentDigest"] = "0".repeat(64).into();
                serde_json::to_vec(&value).unwrap()
            }
            "action" => {
                value["actionId"] = "invalid-action".into();
                serde_json::to_vec(&value).unwrap()
            }
            _ => unreachable!(),
        };
        mode(&fixture.receipt_path(), 0o600);
        fs::write(fixture.receipt_path(), bytes).unwrap();
        mode(&fixture.receipt_path(), 0o400);
        assert_eq!(
            store.load_runtime(&fixture.approval, || true).unwrap_err(),
            if damage == "origin" {
                InstallError::ApprovalMismatch
            } else {
                InstallError::CorruptReceipt
            }
        );
        assert!(fixture.receipt_path().exists());
    }
}

#[test]
fn pre_promotion_revocation_preserves_only_private_candidate() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    let revoked = Cell::new(false);
    let result = store.install_runtime(ACTION, &fixture.runtime, &fixture.approval, || {
        if fixture
            .candidates()
            .iter()
            .any(|path| path.join("tool/bin/node").exists())
        {
            revoked.set(true);
        }
        !revoked.get()
    });
    assert_eq!(result.unwrap_err(), InstallError::AuthorityRevoked);
    assert!(!fixture.object().exists());
    let candidates = fixture.candidates();
    assert_eq!(candidates.len(), 1);
    let candidate = candidates[0].clone();
    assert_eq!(
        fs::metadata(&candidate).unwrap().permissions().mode() & 0o777,
        0o700
    );
    drop(store);
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    assert_eq!(
        store.load_runtime(&fixture.approval, || true).unwrap_err(),
        InstallError::MissingRuntime
    );
    store
        .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
        .unwrap();
    assert!(candidate.exists());
}

#[test]
fn revoked_promoted_runtime_requires_exact_original_action_recovery() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    assert_eq!(
        store
            .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || !fixture
                .object()
                .exists())
            .unwrap_err(),
        InstallError::UnknownCommit
    );
    assert_eq!(
        store.load_runtime(&fixture.approval, || true).unwrap_err(),
        InstallError::RecoveryRequired
    );
    assert_eq!(
        store
            .install_runtime(OTHER_ACTION, &fixture.runtime, &fixture.approval, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    let mut wrong = fixture.approval.clone();
    wrong.origin.source_id = "other-source".into();
    assert_eq!(
        store
            .install_runtime(ACTION, &fixture.runtime, &wrong, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    assert_eq!(
        fs::metadata(fixture.object()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    drop(store);
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    let receipt = store
        .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
        .unwrap();
    assert_eq!(
        store
            .load_runtime(&fixture.approval, || true)
            .unwrap()
            .receipt(),
        &receipt
    );
    assert_eq!(
        fs::metadata(fixture.object()).unwrap().permissions().mode() & 0o777,
        0o500
    );
}

#[test]
fn replaced_runtime_parent_is_rejected_and_both_trees_remain() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    let replaced = Cell::new(false);
    let parent = fixture.root.join("runtimes");
    let saved = fixture.root.join("saved-runtimes");
    assert_eq!(
        store
            .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || {
                if !replaced.replace(true) {
                    fs::rename(&parent, &saved).unwrap();
                    fs::create_dir(&parent).unwrap();
                    mode(&parent, 0o700);
                }
                true
            })
            .unwrap_err(),
        InstallError::StoreChanged
    );
    assert!(parent.exists());
    assert!(saved.exists());
    assert!(!fixture.object().exists());
}

#[test]
fn full_runtime_namespace_allows_original_action_retry_only() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    for index in 0..MAX_INSTALLED_RUNTIMES {
        let mut approval = fixture.approval.clone();
        approval.environment.tool_version = format!("26.10.{index}");
        let runtime = CapturedRuntime::capture_directories(
            &fixture.tool,
            &fixture.host,
            &approval.environment,
            || true,
        )
        .unwrap();
        let action = uuid::Uuid::from_u128(index as u128 + 1)
            .hyphenated()
            .to_string();
        store
            .install_runtime(&action, &runtime, &approval, || true)
            .unwrap();
    }
    let mut approval = fixture.approval.clone();
    approval.environment.tool_version = "26.10.0".into();
    let first = CapturedRuntime::capture_directories(
        &fixture.tool,
        &fixture.host,
        &approval.environment,
        || true,
    )
    .unwrap();
    let first_action = uuid::Uuid::from_u128(1).hyphenated().to_string();
    store
        .install_runtime(&first_action, &first, &approval, || true)
        .unwrap();
    approval.environment.tool_version = "26.10.999".into();
    let extra = CapturedRuntime::capture_directories(
        &fixture.tool,
        &fixture.host,
        &approval.environment,
        || true,
    )
    .unwrap();
    assert_eq!(
        store
            .install_runtime(OTHER_ACTION, &extra, &approval, || true)
            .unwrap_err(),
        InstallError::LimitExceeded
    );
    assert_eq!(
        fs::read_dir(fixture.root.join("runtimes")).unwrap().count(),
        MAX_INSTALLED_RUNTIMES
    );
}

#[test]
fn receipt_roundtrip_is_data_without_activation_or_authority() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    let receipt = store
        .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
        .unwrap();
    let decoded: RuntimeInstallReceipt =
        serde_json::from_slice(&fs::read(fixture.receipt_path()).unwrap()).unwrap();
    assert_eq!(decoded, receipt);
    assert_eq!(
        store.load_runtime(&fixture.approval, || false).unwrap_err(),
        InstallError::AuthorityRevoked
    );
    assert_eq!(
        fs::metadata(fixture.root.join("runtimes"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(fixture.object().join("tool"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o500
    );
    assert_eq!(
        fs::metadata(fixture.object().join("host/dist/main.js"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o400
    );
    assert_eq!(
        fs::metadata(fixture.object().join("tool/bin/node"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o500
    );
    assert!(matches!(
        store.install_runtime(OTHER_ACTION, &fixture.runtime, &fixture.approval, || false),
        Err(InstallError::AuthorityRevoked)
    ));
}

#[test]
fn unselected_runtime_index_never_approves_its_cached_bytes() {
    let fixture = Fixture::new();
    let mut approval_b = fixture.approval.clone();
    approval_b.environment.tool_version = "26.10.1".into();
    let runtime_b = CapturedRuntime::capture_directories(
        &fixture.tool,
        &fixture.host,
        &approval_b.environment,
        || true,
    )
    .unwrap();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    store
        .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
        .unwrap();
    let stored_host = fixture.object().join("host/dist/main.js");
    mode(&stored_host, 0o600);
    fs::write(
        &stored_host,
        b"unapproved bytes with valid read-only metadata",
    )
    .unwrap();
    mode(&stored_host, 0o400);
    // A's strict record participates only in conflict detection while installing
    // B. A becomes executable bytes only after a separate complete load check.
    store
        .install_runtime(OTHER_ACTION, &runtime_b, &approval_b, || true)
        .unwrap();
    store.load_runtime(&approval_b, || true).unwrap();
    assert!(store.load_runtime(&fixture.approval, || true).is_err());
    assert!(
        store
            .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
            .is_err()
    );
    assert!(fixture.receipt_path().exists());
}

#[test]
fn stored_object_replacement_during_load_is_rejected_without_deleting_replacement() {
    let fixture = Fixture::new();
    let mut store = PackageStore::open_existing(&fixture.root).unwrap();
    store
        .install_runtime(ACTION, &fixture.runtime, &fixture.approval, || true)
        .unwrap();
    let object = fixture.object();
    let moved = fixture.root.join("retained-object");
    let replaced = Cell::new(false);
    let error = store
        .load_runtime(&fixture.approval, || {
            if !replaced.get() && object.exists() {
                // A replacement at admission is retained and must never be
                // confused with the stored object's independently approved bytes.
                replaced.set(true);
                // macOS requires a writable wrapper for this cross-parent rename.
                // Restore its sealed mode after moving this fixture-owned object.
                mode(&object, 0o700);
                fs::rename(&object, &moved).unwrap();
                mode(&moved, 0o500);
                fs::create_dir(&object).unwrap();
                mode(&object, 0o500);
            }
            true
        })
        .unwrap_err();
    assert!(matches!(
        error,
        InstallError::CorruptStore | InstallError::StoreChanged | InstallError::Host(_)
    ));
    assert!(object.exists());
    assert!(moved.join("receipt.json").exists());
}
