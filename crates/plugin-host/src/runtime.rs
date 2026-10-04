//! Immutable runtime bytes approved independently of any plugin or worker.
use std::{collections::BTreeMap, fmt, path::Path, sync::Arc};

use tsumugi_plugin_sdk as sdk;

use crate::{HostError, HostResult};

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
        let deadline = Instant::now() + CAPTURE_TIMEOUT;
        check(&live_read_guard, deadline)?;
        if approval.platform != current_platform()? {
            return Err(HostError::UnsupportedPlatform);
        }
        match approval.profile {
            sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1 => {}
        }
        portable_path(&approval.tool.entrypoint)?;
        portable_path(&approval.host.entrypoint)?;
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
            .get(&approval.tool.entrypoint)
            .ok_or(HostError::MissingArtifact)?;
        if !entry.executable {
            return Err(HostError::RuntimeMismatch);
        }
        let tool_digest =
            sdk::runtime_artifact_digest(&tool).map_err(|_| HostError::InvalidContract)?;
        check(&live_read_guard, deadline)?;
        if tool_digest != approval.tool.tree_digest {
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
        if !host.contains_key(&approval.host.entrypoint) {
            return Err(HostError::MissingArtifact);
        }
        let host_digest =
            sdk::runtime_artifact_digest(&host).map_err(|_| HostError::InvalidContract)?;
        check(&live_read_guard, deadline)?;
        if host_digest != approval.host.tree_digest {
            return Err(HostError::RuntimeMismatch);
        }
        let descriptor = approval.clone();
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
            sdk_version: "0.1.0-alpha.1".into(),
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
