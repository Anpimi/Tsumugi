//! Immutable runtime bytes approved independently of any plugin or worker.
use std::{collections::BTreeMap, fmt, path::Path, sync::Arc};

use serde::{Deserialize, Serialize};

use tsumugi_plugin_sdk as sdk;

use crate::{HostError, HostResult};

/// Build-time inspection inputs, never independently trusted approval. The
/// installer must verify the actual tool version and distribution profile.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInspectionRequest {
    pub profile: sdk::RuntimeEnvironmentProfile,
    pub tool_version: String,
    pub tool_entrypoint: String,
    pub host_entrypoint: String,
}

/// Observed metadata for prebuilt trees. This is neither source authentication
/// nor approval, installation, code execution or a Core execution grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInspection {
    pub environment: sdk::RuntimeEnvironmentDescriptor,
    pub environment_digest: String,
    pub file_count: u32,
    pub byte_count: u64,
}

/// Approved actual runtime bytes, retained independently of their source paths.
#[derive(Clone)]
pub struct CapturedRuntime {
    inner: Arc<Snapshot>,
}

struct Snapshot {
    descriptor: sdk::RuntimeEnvironmentDescriptor,
    environment_digest: String,
    tool: BTreeMap<String, sdk::RuntimeArtifactFile>,
    host: BTreeMap<String, sdk::RuntimeArtifactFile>,
}

impl fmt::Debug for CapturedRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedRuntime")
            .field("descriptor", self.descriptor())
            .field("environment_digest", &self.inner.environment_digest)
            .field("tool_files", &self.inner.tool.len())
            .field("host_files", &self.inner.host.len())
            .finish()
    }
}

impl CapturedRuntime {
    /// Fingerprint prebuilt trees through the same bounded filesystem owner as
    /// approved capture. Claimed version/profile are not discovered or trusted
    /// by this operation; distribution verification belongs to the installer.
    pub fn inspect_directories(
        tool_root: &Path,
        host_root: &Path,
        request: &RuntimeInspectionRequest,
        live_read_guard: impl Fn() -> bool,
    ) -> HostResult<RuntimeInspection> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let captured =
                platform::capture_observed(tool_root, host_root, request, None, live_read_guard)?;
            let files = captured.inner.tool.len() + captured.inner.host.len();
            let bytes: usize = captured
                .inner
                .tool
                .values()
                .chain(captured.inner.host.values())
                .map(|file| file.bytes.len())
                .sum();
            Ok(RuntimeInspection {
                environment: captured.descriptor().clone(),
                environment_digest: captured.environment_digest().into(),
                file_count: files as u32,
                byte_count: bytes as u64,
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (tool_root, host_root, request, live_read_guard);
            Err(HostError::UnsupportedPlatform)
        }
    }

    /// Capture two prebuilt, link-free trees on a blocking worker. The expected
    /// descriptor must come from independently trusted installer metadata. That
    /// installer verifies the Node version and its system-library-only profile;
    /// this API neither authenticates a publisher nor inspects or freezes the OS.
    /// Arbitrary Homebrew installations are not approved by naming this profile.
    ///
    /// Capture executes no files, package scripts or network requests and grants
    /// no execution permission. Logical paths, executable flags and every file's
    /// bytes must reproduce both approved tree digests before a snapshot exists.
    /// The two trees share a 256 MiB / 2048 file budget and a 60 second observed
    /// deadline; individual filesystem calls cannot be interrupted by that clock.
    pub fn capture_directories(
        tool_root: &Path,
        host_root: &Path,
        approval: &sdk::RuntimeEnvironmentDescriptor,
        live_read_guard: impl Fn() -> bool,
    ) -> HostResult<Self> {
        approval
            .validate()
            .map_err(|_| HostError::InvalidContract)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            platform::capture(tool_root, host_root, approval, live_read_guard)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (tool_root, host_root, live_read_guard);
            Err(HostError::UnsupportedPlatform)
        }
    }

    pub fn descriptor(&self) -> &sdk::RuntimeEnvironmentDescriptor {
        &self.inner.descriptor
    }

    pub fn environment_digest(&self) -> &str {
        &self.inner.environment_digest
    }

    pub(crate) fn tool_files(&self) -> &BTreeMap<String, sdk::RuntimeArtifactFile> {
        &self.inner.tool
    }

    pub(crate) fn host_files(&self) -> &BTreeMap<String, sdk::RuntimeArtifactFile> {
        &self.inner.host
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    use super::*;
    use crate::{
        package::portable_path,
        tree::{TreeLimits, capture_tree},
    };
    use std::time::{Duration, Instant};

    const CAPTURE_TIMEOUT: Duration = Duration::from_secs(60);

    pub(super) fn current_platform() -> HostResult<sdk::RuntimePlatform> {
        let operating_system = if cfg!(target_os = "macos") {
            sdk::RuntimeOperatingSystem::Macos
        } else {
            sdk::RuntimeOperatingSystem::Linux
        };
        let architecture = if cfg!(target_arch = "aarch64") {
            sdk::RuntimeArchitecture::Aarch64
        } else if cfg!(target_arch = "x86_64") {
            sdk::RuntimeArchitecture::X86_64
        } else {
            return Err(HostError::UnsupportedPlatform);
        };
        Ok(sdk::RuntimePlatform {
            operating_system,
            architecture,
        })
    }

    fn check(guard: &impl Fn() -> bool, deadline: Instant) -> HostResult<Duration> {
        if !guard() {
            return Err(HostError::AuthorityRevoked);
        }
        deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(HostError::Timeout)
    }

    fn limits(max_files: usize, max_bytes: usize, timeout: Duration) -> TreeLimits {
        TreeLimits {
            max_files,
            max_bytes,
            max_directories: 1024,
            max_depth: 32,
            timeout,
            special_file_limit: None,
        }
    }

    pub(super) fn capture(
        tool_root: &Path,
        host_root: &Path,
        approval: &sdk::RuntimeEnvironmentDescriptor,
        live_read_guard: impl Fn() -> bool,
    ) -> HostResult<CapturedRuntime> {
        capture_observed(
            tool_root,
            host_root,
            &RuntimeInspectionRequest {
                profile: approval.profile,
                tool_version: approval.tool_version.clone(),
                tool_entrypoint: approval.tool.entrypoint.clone(),
                host_entrypoint: approval.host.entrypoint.clone(),
            },
            Some(approval),
            live_read_guard,
        )
    }

    pub(super) fn capture_observed(
        tool_root: &Path,
        host_root: &Path,
        request: &RuntimeInspectionRequest,
        expected: Option<&sdk::RuntimeEnvironmentDescriptor>,
        live_read_guard: impl Fn() -> bool,
    ) -> HostResult<CapturedRuntime> {
        let deadline = Instant::now() + CAPTURE_TIMEOUT;
        check(&live_read_guard, deadline)?;
        let current_platform = current_platform()?;
        if expected.is_some_and(|approval| approval.platform != current_platform) {
            return Err(HostError::UnsupportedPlatform);
        }
        match request.profile {
            sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1 => {}
        }
        if request.tool_version.is_empty() || request.tool_version.len() > 128 {
            return Err(HostError::InvalidContract);
        }
        portable_path(&request.tool_entrypoint)?;
        portable_path(&request.host_entrypoint)?;
        let tool = capture_tree(
            tool_root,
            &limits(
                sdk::MAX_RUNTIME_ARTIFACT_FILES,
                sdk::MAX_RUNTIME_ARTIFACT_BYTES,
                check(&live_read_guard, deadline)?,
            ),
            &live_read_guard,
        )?;
        check(&live_read_guard, deadline)?;
        let entry = tool
            .get(&request.tool_entrypoint)
            .ok_or(HostError::MissingArtifact)?;
        if !entry.executable {
            return Err(HostError::RuntimeMismatch);
        }
        let tool_digest =
            sdk::runtime_artifact_digest(&tool).map_err(|_| HostError::InvalidContract)?;
        check(&live_read_guard, deadline)?;
        if expected.is_some_and(|approval| tool_digest != approval.tool.tree_digest) {
            return Err(HostError::RuntimeMismatch);
        }
        let remaining_files = sdk::MAX_RUNTIME_ARTIFACT_FILES
            .checked_sub(tool.len())
            .filter(|remaining| *remaining > 0)
            .ok_or(HostError::PackageLimit)?;
        let tool_bytes = tool.values().try_fold(0usize, |total, file| {
            total
                .checked_add(file.bytes.len())
                .ok_or(HostError::PackageLimit)
        })?;
        let remaining_bytes = sdk::MAX_RUNTIME_ARTIFACT_BYTES
            .checked_sub(tool_bytes)
            .ok_or(HostError::PackageLimit)?;
        let host = capture_tree(
            host_root,
            &limits(
                remaining_files,
                remaining_bytes,
                check(&live_read_guard, deadline)?,
            ),
            &live_read_guard,
        )?;
        check(&live_read_guard, deadline)?;
        if !host.contains_key(&request.host_entrypoint) {
            return Err(HostError::MissingArtifact);
        }
        let host_digest =
            sdk::runtime_artifact_digest(&host).map_err(|_| HostError::InvalidContract)?;
        check(&live_read_guard, deadline)?;
        if expected.is_some_and(|approval| host_digest != approval.host.tree_digest) {
            return Err(HostError::RuntimeMismatch);
        }
        let descriptor = sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: current_platform,
            sdk_version: sdk::SDK_VERSION.into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: request.profile,
            tool_version: request.tool_version.clone(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: tool_digest,
                entrypoint: request.tool_entrypoint.clone(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: host_digest,
                entrypoint: request.host_entrypoint.clone(),
            },
        };
        if expected.is_some_and(|approval| &descriptor != approval) {
            return Err(HostError::RuntimeMismatch);
        }
        let environment_digest = descriptor
            .digest()
            .map_err(|_| HostError::InvalidContract)?;
        check(&live_read_guard, deadline)?;
        Ok(CapturedRuntime {
            inner: Arc::new(Snapshot {
                descriptor,
                environment_digest,
                tool,
                host,
            }),
        })
    }
}

#[cfg(all(
    test,
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "aarch64", target_arch = "x86_64")
))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn inspection_fixture() -> (tempfile::TempDir, RuntimeInspectionRequest) {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir(temporary.path().join("tool")).unwrap();
        fs::create_dir(temporary.path().join("host")).unwrap();
        // Invalid program bytes ensure these checks cannot establish execution
        // or authenticate the version claimed in the inspection request.
        fs::write(temporary.path().join("tool/node"), b"not a program").unwrap();
        fs::set_permissions(
            temporary.path().join("tool/node"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::write(temporary.path().join("tool/LICENSE"), b"tool license").unwrap();
        fs::write(temporary.path().join("host/main.js"), b"host bytes").unwrap();
        fs::write(temporary.path().join("host/LICENSE"), b"host license").unwrap();
        (
            temporary,
            RuntimeInspectionRequest {
                profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
                tool_version: "26.10.0".into(),
                tool_entrypoint: "node".into(),
                host_entrypoint: "main.js".into(),
            },
        )
    }

    #[test]
    fn inspection_uses_complete_tree_owner_and_approved_capture_still_refuses_drift() {
        let (temporary, request) = inspection_fixture();
        let tool = temporary.path().join("tool");
        let host = temporary.path().join("host");
        let observed =
            CapturedRuntime::inspect_directories(&tool, &host, &request, || true).unwrap();
        assert_eq!(observed.file_count, 4);
        assert_eq!(observed.byte_count, 47);
        assert_eq!(observed.environment.sdk_version, sdk::SDK_VERSION);
        assert_eq!(
            observed.environment_digest,
            observed.environment.digest().unwrap()
        );
        let captured =
            CapturedRuntime::capture_directories(&tool, &host, &observed.environment, || true)
                .unwrap();
        assert_eq!(captured.environment_digest(), observed.environment_digest);
        fs::write(host.join("LICENSE"), b"changed host license").unwrap();
        let changed =
            CapturedRuntime::inspect_directories(&tool, &host, &request, || true).unwrap();
        assert_ne!(observed.environment_digest, changed.environment_digest);
        assert_ne!(
            observed.environment.host.tree_digest,
            changed.environment.host.tree_digest
        );
        assert_eq!(observed.environment.tool, changed.environment.tool);
        assert_eq!(
            CapturedRuntime::capture_directories(&tool, &host, &observed.environment, || true)
                .unwrap_err(),
            HostError::RuntimeMismatch
        );
        assert_eq!(captured.host_files()["LICENSE"].bytes, b"host license");
    }

    #[test]
    fn inspection_records_claims_without_authenticating_them() {
        let (temporary, mut request) = inspection_fixture();
        let tool = temporary.path().join("tool");
        let host = temporary.path().join("host");
        let first = CapturedRuntime::inspect_directories(&tool, &host, &request, || true).unwrap();
        request.tool_version = "26.11.0".into();
        let second = CapturedRuntime::inspect_directories(&tool, &host, &request, || true).unwrap();
        assert_eq!(first.environment.tool, second.environment.tool);
        assert_ne!(first.environment_digest, second.environment_digest);
        assert_eq!(second.environment.tool_version, "26.11.0");
    }

    #[test]
    fn inspection_refuses_links_non_executable_entrypoints_and_revoked_reads() {
        let (temporary, request) = inspection_fixture();
        let tool = temporary.path().join("tool");
        let host = temporary.path().join("host");
        assert_eq!(
            CapturedRuntime::inspect_directories(&tool, &host, &request, || false).unwrap_err(),
            HostError::AuthorityRevoked
        );
        fs::set_permissions(tool.join("node"), fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            CapturedRuntime::inspect_directories(&tool, &host, &request, || true).unwrap_err(),
            HostError::RuntimeMismatch
        );
        fs::set_permissions(tool.join("node"), fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink("main.js", host.join("alias.js")).unwrap();
        assert_eq!(
            CapturedRuntime::inspect_directories(&tool, &host, &request, || true).unwrap_err(),
            HostError::PackagePath
        );
    }

    #[test]
    fn retained_bytes_survive_source_rewrites_and_removal() {
        let temporary = tempfile::tempdir().unwrap();
        let tool_root = temporary.path().join("tool");
        let host_root = temporary.path().join("host");
        fs::create_dir(&tool_root).unwrap();
        fs::create_dir(&host_root).unwrap();
        // Deliberately invalid program bytes make this a capture-only fixture.
        let tool = BTreeMap::from([(
            "node".into(),
            sdk::RuntimeArtifactFile {
                bytes: b"captured tool bytes".to_vec(),
                executable: true,
            },
        )]);
        let host = BTreeMap::from([(
            "main.js".into(),
            sdk::RuntimeArtifactFile {
                bytes: b"captured host bytes".to_vec(),
                executable: false,
            },
        )]);
        fs::write(tool_root.join("node"), &tool["node"].bytes).unwrap();
        fs::set_permissions(tool_root.join("node"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(host_root.join("main.js"), &host["main.js"].bytes).unwrap();
        let approval = sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: platform::current_platform().unwrap(),
            sdk_version: sdk::SDK_VERSION.into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: sdk::runtime_artifact_digest(&tool).unwrap(),
                entrypoint: "node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: sdk::runtime_artifact_digest(&host).unwrap(),
                entrypoint: "main.js".into(),
            },
        };
        let captured =
            CapturedRuntime::capture_directories(&tool_root, &host_root, &approval, || true)
                .unwrap();
        let cloned = captured.clone();
        fs::write(tool_root.join("node"), b"replaced tool").unwrap();
        fs::write(host_root.join("main.js"), b"replaced host").unwrap();
        drop(temporary);
        assert_eq!(
            captured.tool_files()["node"].bytes.as_slice(),
            b"captured tool bytes"
        );
        assert!(captured.tool_files()["node"].executable);
        assert_eq!(
            cloned.host_files()["main.js"].bytes.as_slice(),
            b"captured host bytes"
        );
        assert_eq!(cloned.descriptor(), &approval);
        assert_eq!(cloned.environment_digest(), approval.digest().unwrap());
    }
}
