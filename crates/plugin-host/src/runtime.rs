//! Immutable runtime bytes approved independently of any plugin or worker.
#[path = "runtime/member_artifact.rs"]
mod member_artifact;
pub use member_artifact::{CapturedMemberArtifact, MemberArtifactManifest};

use std::{
    collections::BTreeMap,
    fmt,
    io::{Read, Seek},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use tsumugi_plugin_sdk as sdk;

use crate::{HostError, HostResult};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(60);

fn check(guard: &impl Fn() -> bool, deadline: Instant) -> HostResult<Duration> {
    if !guard() {
        return Err(HostError::AuthorityRevoked);
    }
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(HostError::Timeout)
}

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

    /// Encode each immutable artifact with its captured executable flags. The
    /// transport bytes do not replace either approved tree digest.
    pub(crate) fn encode_archives(
        &self,
        authorized: impl Fn() -> bool,
    ) -> HostResult<(Vec<u8>, Vec<u8>)> {
        let deadline = Instant::now() + CAPTURE_TIMEOUT;
        let live_check = || check(&authorized, deadline).map(|_| ());
        let tool = crate::candidate_archive::encode_runtime_files(self.tool_files(), &live_check)?;
        let host = crate::candidate_archive::encode_runtime_files(self.host_files(), &live_check)?;
        live_check()?;
        Ok((tool, host))
    }

    /// Capture complete held archives using an independently approved runtime
    /// descriptor. Reading archives neither authenticates nor executes a tool.
    pub(crate) fn capture_archives(
        tool: &mut (impl Read + Seek),
        host: &mut (impl Read + Seek),
        approval: &sdk::RuntimeEnvironmentDescriptor,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        approval
            .validate()
            .map_err(|_| HostError::InvalidContract)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            platform::capture_archives(tool, host, approval, authorized)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (tool, host, authorized);
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
        let live_check = || check(&live_read_guard, deadline).map(|_| ());
        capture_sources(
            request,
            expected,
            &live_check,
            || {
                capture_tree(
                    tool_root,
                    &limits(
                        sdk::MAX_RUNTIME_ARTIFACT_FILES,
                        sdk::MAX_RUNTIME_ARTIFACT_BYTES,
                        check(&live_read_guard, deadline)?,
                    ),
                    &live_read_guard,
                )
            },
            |remaining_files, remaining_bytes| {
                capture_tree(
                    host_root,
                    &limits(
                        remaining_files,
                        remaining_bytes,
                        check(&live_read_guard, deadline)?,
                    ),
                    &live_read_guard,
                )
            },
        )
    }

    pub(super) fn capture_archives(
        tool: &mut (impl Read + Seek),
        host: &mut (impl Read + Seek),
        approval: &sdk::RuntimeEnvironmentDescriptor,
        authorized: impl Fn() -> bool,
    ) -> HostResult<CapturedRuntime> {
        let deadline = Instant::now() + CAPTURE_TIMEOUT;
        let live_check = || check(&authorized, deadline).map(|_| ());
        capture_sources(
            &RuntimeInspectionRequest {
                profile: approval.profile,
                tool_version: approval.tool_version.clone(),
                tool_entrypoint: approval.tool.entrypoint.clone(),
                host_entrypoint: approval.host.entrypoint.clone(),
            },
            Some(approval),
            &live_check,
            || {
                crate::candidate_archive::capture_reader(
                    tool,
                    crate::candidate_archive::Profile::Runtime,
                    &live_check,
                )
            },
            |remaining_files, remaining_bytes| {
                crate::candidate_archive::capture_runtime_reader(
                    host,
                    remaining_files,
                    remaining_bytes,
                    &live_check,
                )
            },
        )
    }

    // Both sources first enforce their own namespace/metadata profile. This
    // owner alone validates entrypoints, shared budgets and the complete
    // descriptor before the maps become an immutable runtime snapshot.
    fn capture_sources(
        request: &RuntimeInspectionRequest,
        expected: Option<&sdk::RuntimeEnvironmentDescriptor>,
        check: &impl Fn() -> HostResult<()>,
        capture_tool: impl FnOnce() -> HostResult<BTreeMap<String, sdk::RuntimeArtifactFile>>,
        capture_host: impl FnOnce(
            usize,
            usize,
        ) -> HostResult<BTreeMap<String, sdk::RuntimeArtifactFile>>,
    ) -> HostResult<CapturedRuntime> {
        check()?;
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
        let tool = capture_tool()?;
        check()?;
        let entry = tool
            .get(&request.tool_entrypoint)
            .ok_or(HostError::MissingArtifact)?;
        if !entry.executable {
            return Err(HostError::RuntimeMismatch);
        }
        let tool_digest =
            sdk::runtime_artifact_digest(&tool).map_err(|_| HostError::InvalidContract)?;
        check()?;
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
        let host = capture_host(remaining_files, remaining_bytes)?;
        check()?;
        let host_bytes = host.values().try_fold(0usize, |total, file| {
            total
                .checked_add(file.bytes.len())
                .ok_or(HostError::PackageLimit)
        })?;
        if host.len() > remaining_files || host_bytes > remaining_bytes {
            return Err(HostError::PackageLimit);
        }
        if !host.contains_key(&request.host_entrypoint) {
            return Err(HostError::MissingArtifact);
        }
        let host_digest =
            sdk::runtime_artifact_digest(&host).map_err(|_| HostError::InvalidContract)?;
        check()?;
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
        check()?;
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
    use std::{
        fs,
        io::{Cursor, SeekFrom},
        os::unix::fs::PermissionsExt,
    };

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

    fn archive_fixture() -> (
        BTreeMap<String, sdk::RuntimeArtifactFile>,
        BTreeMap<String, sdk::RuntimeArtifactFile>,
        sdk::RuntimeEnvironmentDescriptor,
    ) {
        let tool = BTreeMap::from([
            (
                "node".into(),
                sdk::RuntimeArtifactFile {
                    bytes: vec![0, 255, 13, 10],
                    executable: true,
                },
            ),
            (
                "data.exe".into(),
                sdk::RuntimeArtifactFile {
                    bytes: b"data".to_vec(),
                    executable: false,
                },
            ),
        ]);
        let host = BTreeMap::from([
            (
                "main.js".into(),
                sdk::RuntimeArtifactFile {
                    bytes: b"host bytes".to_vec(),
                    executable: false,
                },
            ),
            (
                "manifest.json".into(),
                sdk::RuntimeArtifactFile {
                    bytes: b"ordinary runtime file".to_vec(),
                    executable: true,
                },
            ),
        ]);
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
        (tool, host, approval)
    }

    #[test]
    fn complete_runtime_archives_round_trip_flags_bytes_and_independent_descriptor() {
        let (tool, host, approval) = archive_fixture();
        let tool_bytes = crate::candidate_archive::encode_runtime_files(&tool, || Ok(())).unwrap();
        let host_bytes = crate::candidate_archive::encode_runtime_files(&host, || Ok(())).unwrap();
        let runtime = CapturedRuntime::capture_archives(
            &mut Cursor::new(&tool_bytes),
            &mut Cursor::new(&host_bytes),
            &approval,
            || true,
        )
        .unwrap();
        assert_eq!(runtime.descriptor(), &approval);
        assert_eq!(runtime.environment_digest(), approval.digest().unwrap());
        assert_eq!(runtime.tool_files()["node"].bytes, tool["node"].bytes);
        assert!(!runtime.tool_files()["data.exe"].executable);
        assert!(runtime.host_files()["manifest.json"].executable);
        assert_eq!(
            runtime.encode_archives(|| true).unwrap(),
            (tool_bytes.clone(), host_bytes.clone())
        );

        let mut changed_host = host;
        changed_host.get_mut("main.js").unwrap().executable = true;
        let changed =
            crate::candidate_archive::encode_runtime_files(&changed_host, || Ok(())).unwrap();
        assert_eq!(
            CapturedRuntime::capture_archives(
                &mut Cursor::new(&tool_bytes),
                &mut Cursor::new(changed),
                &approval,
                || true,
            )
            .unwrap_err(),
            HostError::RuntimeMismatch,
        );
        let mut wrong = approval.clone();
        wrong.host.tree_digest = "0".repeat(64);
        assert_eq!(
            CapturedRuntime::capture_archives(
                &mut Cursor::new(&tool_bytes),
                &mut Cursor::new(&host_bytes),
                &wrong,
                || true,
            )
            .unwrap_err(),
            HostError::RuntimeMismatch,
        );
        assert_eq!(
            runtime.encode_archives(|| false).unwrap_err(),
            HostError::AuthorityRevoked
        );
        assert_eq!(
            CapturedRuntime::capture_archives(
                &mut Cursor::new(&tool_bytes),
                &mut Cursor::new(&host_bytes),
                &approval,
                || false,
            )
            .unwrap_err(),
            HostError::AuthorityRevoked,
        );
        assert!(
            CapturedRuntime::capture_archives(
                &mut Cursor::new(&tool_bytes),
                &mut Cursor::new(&host_bytes[..host_bytes.len() - 512]),
                &approval,
                || true,
            )
            .is_err()
        );
    }

    #[test]
    fn runtime_archive_artifacts_share_the_original_file_budget() {
        let (mut tool, host, mut approval) = archive_fixture();
        for ordinal in tool.len()..sdk::MAX_RUNTIME_ARTIFACT_FILES {
            tool.insert(
                format!("extra-{ordinal}"),
                sdk::RuntimeArtifactFile {
                    bytes: vec![],
                    executable: false,
                },
            );
        }
        approval.tool.tree_digest = sdk::runtime_artifact_digest(&tool).unwrap();
        let tool = crate::candidate_archive::encode_runtime_files(&tool, || Ok(())).unwrap();
        let mut host =
            Cursor::new(crate::candidate_archive::encode_runtime_files(&host, || Ok(())).unwrap());
        assert_eq!(
            CapturedRuntime::capture_archives(&mut Cursor::new(tool), &mut host, &approval, || {
                true
            })
            .unwrap_err(),
            HostError::PackageLimit,
        );
        assert_eq!(
            host.position(),
            0,
            "no host read after tool consumed the shared file budget"
        );
    }

    struct DeclaredArchive {
        header: tar::Header,
        body_length: u64,
        position: u64,
        body_read: bool,
    }

    impl DeclaredArchive {
        fn new(body_length: u64) -> Self {
            let mut header = tar::Header::new_ustar();
            header.set_path("main.js").unwrap();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_size(body_length);
            header.set_cksum();
            Self {
                header,
                body_length,
                position: 0,
                body_read: false,
            }
        }

        fn length(&self) -> u64 {
            512 + self.body_length.div_ceil(512) * 512 + 1024
        }
    }

    impl Read for DeclaredArchive {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            let count =
                (self.length().saturating_sub(self.position)).min(output.len() as u64) as usize;
            let end = self.position + count as u64;
            if count != 0 && self.position < 512 + self.body_length && end > 512 {
                self.body_read = true;
                return Err(std::io::Error::other("over-budget body was read"));
            }
            output[..count].fill(0);
            if self.position < 512 {
                let header_count = count.min((512 - self.position) as usize);
                output[..header_count].copy_from_slice(
                    &self.header.as_bytes()
                        [self.position as usize..self.position as usize + header_count],
                );
            }
            self.position = end;
            Ok(count)
        }
    }

    impl Seek for DeclaredArchive {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            let position = match position {
                SeekFrom::Start(position) => i128::from(position),
                SeekFrom::End(offset) => i128::from(self.length()) + i128::from(offset),
                SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
            };
            self.position = u64::try_from(position).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid archive offset")
            })?;
            Ok(self.position)
        }
    }

    #[test]
    fn runtime_archive_combined_byte_limit_rejects_before_allocating_or_reading_host_body() {
        let (tool, _, approval) = archive_fixture();
        let tool = crate::candidate_archive::encode_runtime_files(&tool, || Ok(())).unwrap();
        // The declared host alone fits its artifact profile, but the captured
        // tool has already consumed bytes from the shared snapshot allowance.
        let mut host = DeclaredArchive::new(sdk::MAX_RUNTIME_ARTIFACT_BYTES as u64);
        assert_eq!(
            CapturedRuntime::capture_archives(&mut Cursor::new(tool), &mut host, &approval, || {
                true
            })
            .unwrap_err(),
            HostError::PackageLimit,
        );
        assert!(!host.body_read);
    }
}
