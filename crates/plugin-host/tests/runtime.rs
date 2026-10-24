#![cfg(all(
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "aarch64", target_arch = "x86_64")
))]

use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    os::unix::{fs::PermissionsExt, fs::symlink},
    path::{Path, PathBuf},
};

use tsumugi_plugin_host::{CapturedRuntime, HostError};
use tsumugi_plugin_sdk as sdk;

struct Fixture {
    _temporary: tempfile::TempDir,
    tool_root: PathBuf,
    host_root: PathBuf,
    tool: BTreeMap<String, sdk::RuntimeArtifactFile>,
    host: BTreeMap<String, sdk::RuntimeArtifactFile>,
    approval: sdk::RuntimeEnvironmentDescriptor,
}

fn file(bytes: &[u8], executable: bool) -> sdk::RuntimeArtifactFile {
    sdk::RuntimeArtifactFile {
        bytes: bytes.to_vec(),
        executable,
    }
}

fn write_tree(root: &Path, files: &BTreeMap<String, sdk::RuntimeArtifactFile>) {
    fs::create_dir(root).unwrap();
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
    for (name, file) in files {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &file.bytes).unwrap();
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
        )
        .unwrap();
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
        let tool_root = temporary.path().join("tool");
        let host_root = temporary.path().join("host");
        let tool = BTreeMap::from([
            // These bytes must never be executed by a capture operation.
            (
                "bin/node".into(),
                file(b"deliberately not a Node program\0\xff", true),
            ),
            ("LICENSE".into(), file(b"synthetic tool license\n", false)),
        ]);
        let host = BTreeMap::from([
            (
                "dist/main.js".into(),
                file(b"throw new Error('capture must not run');\n", false),
            ),
            ("package.json".into(), file(br#"{"type":"module"}"#, false)),
            (
                "node_modules/example/index.js".into(),
                file(b"export const marker = 'first';\n", false),
            ),
            (
                "node_modules/example/package.json".into(),
                file(br#"{"type":"module","main":"index.js"}"#, false),
            ),
        ]);
        write_tree(&tool_root, &tool);
        write_tree(&host_root, &host);
        let approval = sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: platform(),
            // Independent fixture metadata uses the SDK release, not the Host's
            // workspace package version. It proves no actual Node distribution.
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: sdk::runtime_artifact_digest(&tool).unwrap(),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: sdk::runtime_artifact_digest(&host).unwrap(),
                entrypoint: "dist/main.js".into(),
            },
        };
        Self {
            _temporary: temporary,
            tool_root,
            host_root,
            tool,
            host,
            approval,
        }
    }

    fn capture(&self) -> Result<CapturedRuntime, HostError> {
        CapturedRuntime::capture_directories(
            &self.tool_root,
            &self.host_root,
            &self.approval,
            || true,
        )
    }

    fn rejects(&self, approval: &sdk::RuntimeEnvironmentDescriptor, expected: HostError) {
        assert!(matches!(
            CapturedRuntime::capture_directories(&self.tool_root, &self.host_root, approval, || true),
            Err(actual) if actual == expected
        ));
    }
}

#[test]
fn captures_actual_trees_and_derives_the_approved_environment_digest() {
    let fixture = Fixture::new();
    let captured = fixture.capture().unwrap();
    assert_eq!(captured.descriptor(), &fixture.approval);
    assert_eq!(
        captured.environment_digest(),
        fixture.approval.digest().unwrap()
    );
    assert_eq!(
        captured.clone().environment_digest(),
        captured.environment_digest()
    );
    assert_eq!(
        fs::read(fixture.tool_root.join("bin/node")).unwrap(),
        fixture.tool["bin/node"].bytes
    );
}

#[test]
fn rejects_wrong_independent_tree_digests_and_invalid_descriptors() {
    let fixture = Fixture::new();
    for tool in [true, false] {
        let mut approval = fixture.approval.clone();
        if tool {
            approval.tool.tree_digest = "0".repeat(64);
        } else {
            approval.host.tree_digest = "0".repeat(64);
        }
        fixture.rejects(&approval, HostError::RuntimeMismatch);
    }
    let mut invalid = vec![fixture.approval.clone(); 5];
    invalid[0].protocol_version += 1;
    invalid[1].process_protocol += 1;
    invalid[2].sdk_version = "0.0.0".into();
    invalid[3].host.tree_digest = "A".repeat(64);
    invalid[4].tool.entrypoint = "../node".into();
    for approval in invalid {
        fixture.rejects(&approval, HostError::InvalidContract);
    }
}

#[test]
fn rejects_platform_or_architecture_mismatch_before_capture() {
    let fixture = Fixture::new();
    let mut approval = fixture.approval.clone();
    approval.platform.operating_system = match approval.platform.operating_system {
        sdk::RuntimeOperatingSystem::Macos => sdk::RuntimeOperatingSystem::Linux,
        sdk::RuntimeOperatingSystem::Linux | sdk::RuntimeOperatingSystem::Windows => {
            sdk::RuntimeOperatingSystem::Macos
        }
    };
    fixture.rejects(&approval, HostError::UnsupportedPlatform);
    let mut approval = fixture.approval.clone();
    approval.platform.architecture = match approval.platform.architecture {
        sdk::RuntimeArchitecture::Aarch64 => sdk::RuntimeArchitecture::X86_64,
        sdk::RuntimeArchitecture::X86_64 => sdk::RuntimeArchitecture::Aarch64,
    };
    fixture.rejects(&approval, HostError::UnsupportedPlatform);
}

#[test]
fn requires_both_entrypoints_and_an_actually_executable_tool() {
    let mut fixture = Fixture::new();
    let mut approval = fixture.approval.clone();
    approval.tool.entrypoint = "bin/missing".into();
    fixture.rejects(&approval, HostError::MissingArtifact);
    let mut approval = fixture.approval.clone();
    approval.host.entrypoint = "dist/missing.js".into();
    fixture.rejects(&approval, HostError::MissingArtifact);
    fs::set_permissions(
        fixture.tool_root.join("bin/node"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fixture.rejects(&fixture.approval, HostError::RuntimeMismatch);
    fixture.tool.get_mut("bin/node").unwrap().executable = false;
    fixture.approval.tool.tree_digest = sdk::runtime_artifact_digest(&fixture.tool).unwrap();
    // A self-consistent digest cannot make a non-executable tool executable.
    fixture.rejects(&fixture.approval, HostError::RuntimeMismatch);
}

#[test]
fn source_rewrites_and_dependency_changes_cannot_rebind_a_captured_environment() {
    let mut fixture = Fixture::new();
    let original = fixture.capture().unwrap();
    let original_digest = original.environment_digest().to_owned();
    fs::write(
        fixture.host_root.join("node_modules/example/index.js"),
        b"export const marker = 'second';\n",
    )
    .unwrap();
    fixture.rejects(&fixture.approval, HostError::RuntimeMismatch);
    fixture
        .host
        .get_mut("node_modules/example/index.js")
        .unwrap()
        .bytes = b"export const marker = 'second';\n".to_vec();
    fixture.approval.host.tree_digest = sdk::runtime_artifact_digest(&fixture.host).unwrap();
    let changed_dependency = fixture.capture().unwrap();
    assert_ne!(changed_dependency.environment_digest(), original_digest);
    fs::write(fixture.tool_root.join("bin/node"), b"different tool bytes").unwrap();
    fixture.rejects(&fixture.approval, HostError::RuntimeMismatch);
    assert_eq!(original.environment_digest(), original_digest);
    assert_ne!(original.descriptor(), changed_dependency.descriptor());
}

#[test]
fn revoked_live_guards_return_no_runtime_snapshot() {
    let fixture = Fixture::new();
    assert!(matches!(
        CapturedRuntime::capture_directories(
            &fixture.tool_root,
            &fixture.host_root,
            &fixture.approval,
            || false
        ),
        Err(HostError::AuthorityRevoked)
    ));
    let checks = Cell::new(0);
    assert!(matches!(
        CapturedRuntime::capture_directories(
            &fixture.tool_root,
            &fixture.host_root,
            &fixture.approval,
            || {
                checks.set(checks.get() + 1);
                checks.get() < 12
            }
        ),
        Err(HostError::AuthorityRevoked)
    ));
    assert_eq!(checks.get(), 12);
}

#[test]
fn rejects_root_and_artifact_links_and_hardlinks() {
    let fixture = Fixture::new();
    let linked_root = fixture._temporary.path().join("linked-tool");
    symlink(&fixture.tool_root, &linked_root).unwrap();
    assert!(matches!(
        CapturedRuntime::capture_directories(
            &linked_root,
            &fixture.host_root,
            &fixture.approval,
            || true
        ),
        Err(HostError::PackagePath)
    ));
    let dependency = fixture.host_root.join("node_modules/example/index.js");
    let outside = fixture._temporary.path().join("outside.js");
    fs::rename(&dependency, &outside).unwrap();
    symlink(&outside, &dependency).unwrap();
    fixture.rejects(&fixture.approval, HostError::PackagePath);
    fs::remove_file(&dependency).unwrap();
    fs::hard_link(&outside, &dependency).unwrap();
    fixture.rejects(&fixture.approval, HostError::PackagePath);
}

#[test]
fn enforces_a_combined_tree_byte_budget_before_reading_oversized_data() {
    let fixture = Fixture::new();
    let tool_bytes: usize = fixture.tool.values().map(|file| file.bytes.len()).sum();
    let oversized = fs::OpenOptions::new()
        .write(true)
        .open(fixture.host_root.join("node_modules/example/index.js"))
        .unwrap();
    // This host file fits its independent SDK tree ceiling but exceeds the
    // remaining shared budget. Sparse length avoids allocating that fixture.
    oversized
        .set_len((sdk::MAX_RUNTIME_ARTIFACT_BYTES - tool_bytes + 1) as u64)
        .unwrap();
    fixture.rejects(&fixture.approval, HostError::PackageLimit);
}

#[test]
fn enforces_a_combined_tree_file_budget() {
    let mut fixture = Fixture::new();
    for index in fixture.tool.len()..sdk::MAX_RUNTIME_ARTIFACT_FILES {
        let path = format!("extra-{index}");
        fs::write(fixture.tool_root.join(&path), []).unwrap();
        fixture.tool.insert(path, file(&[], false));
    }
    fixture.approval.tool.tree_digest = sdk::runtime_artifact_digest(&fixture.tool).unwrap();
    // A valid tool tree at the independent SDK ceiling leaves no file slot for
    // the required Host entrypoint; the combined capture must reject it.
    fixture.rejects(&fixture.approval, HostError::PackageLimit);
}
