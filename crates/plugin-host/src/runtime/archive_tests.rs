use super::*;
use std::{
    cell::Cell,
    io::{Cursor, SeekFrom},
};

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
        platform: current_platform().unwrap(),
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
    assert_eq!(
        serde_json::to_value(&approval.platform).unwrap(),
        serde_json::json!({
            "operatingSystem": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
        }),
    );
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
    let changed = crate::candidate_archive::encode_runtime_files(&changed_host, || Ok(())).unwrap();
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
        let count = (self.length().saturating_sub(self.position)).min(output.len() as u64) as usize;
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

#[test]
fn runtime_archive_platform_mismatch_is_refused_before_reading_either_stream() {
    let (tool, host, approval) = archive_fixture();
    let mut other_system = approval.platform.clone();
    other_system.operating_system =
        if other_system.operating_system == sdk::RuntimeOperatingSystem::Windows {
            sdk::RuntimeOperatingSystem::Linux
        } else {
            sdk::RuntimeOperatingSystem::Windows
        };
    let mut other_architecture = approval.platform.clone();
    other_architecture.architecture =
        if other_architecture.architecture == sdk::RuntimeArchitecture::Aarch64 {
            sdk::RuntimeArchitecture::X86_64
        } else {
            sdk::RuntimeArchitecture::Aarch64
        };
    let tool_bytes = crate::candidate_archive::encode_runtime_files(&tool, || Ok(())).unwrap();
    let host_bytes = crate::candidate_archive::encode_runtime_files(&host, || Ok(())).unwrap();
    for platform in [other_system, other_architecture] {
        let mut wrong = approval.clone();
        wrong.platform = platform;
        let mut tool = Cursor::new(&tool_bytes);
        let mut host = Cursor::new(&host_bytes);
        assert_eq!(
            CapturedRuntime::capture_archives(&mut tool, &mut host, &wrong, || true).unwrap_err(),
            HostError::UnsupportedPlatform,
        );
        assert_eq!((tool.position(), host.position()), (0, 0));
    }
}

#[test]
fn an_approved_digest_cannot_make_a_non_executable_tool_entrypoint_executable() {
    let (mut tool, host, mut approval) = archive_fixture();
    tool.get_mut("node").unwrap().executable = false;
    approval.tool.tree_digest = sdk::runtime_artifact_digest(&tool).unwrap();
    let tool = crate::candidate_archive::encode_runtime_files(&tool, || Ok(())).unwrap();
    let mut host =
        Cursor::new(crate::candidate_archive::encode_runtime_files(&host, || Ok(())).unwrap());
    assert_eq!(
        CapturedRuntime::capture_archives(&mut Cursor::new(tool), &mut host, &approval, || true)
            .unwrap_err(),
        HostError::RuntimeMismatch,
    );
    assert_eq!(host.position(), 0);
}

struct RevokingReader<'a> {
    cursor: Cursor<Vec<u8>>,
    authorized: &'a Cell<bool>,
    body_read: bool,
}

impl Read for RevokingReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let start = self.cursor.position();
        let count = self.cursor.read(output)?;
        // The short first member has one USTAR header. Revoke only after a
        // real body read, rather than relying on a particular guard call count.
        if start >= 512 && count != 0 {
            self.body_read = true;
            self.authorized.set(false);
        }
        Ok(count)
    }
}

impl Seek for RevokingReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.cursor.seek(position)
    }
}

#[test]
fn runtime_archive_revocation_after_a_body_read_prevents_the_snapshot() {
    let (tool, host, approval) = archive_fixture();
    let authorized = Cell::new(true);
    let mut tool = RevokingReader {
        cursor: Cursor::new(
            crate::candidate_archive::encode_runtime_files(&tool, || Ok(())).unwrap(),
        ),
        authorized: &authorized,
        body_read: false,
    };
    let mut host =
        Cursor::new(crate::candidate_archive::encode_runtime_files(&host, || Ok(())).unwrap());
    assert_eq!(
        CapturedRuntime::capture_archives(&mut tool, &mut host, &approval, || authorized.get())
            .unwrap_err(),
        HostError::AuthorityRevoked,
    );
    assert!(tool.body_read);
    assert_eq!(host.position(), 0);
}

#[cfg(windows)]
#[test]
fn windows_directory_capture_remains_unsupported_without_reading_a_directory() {
    let (_, _, approval) = archive_fixture();
    let unused = Path::new("unavailable-runtime-directory");
    assert_eq!(
        CapturedRuntime::capture_directories(unused, unused, &approval, || true).unwrap_err(),
        HostError::UnsupportedPlatform,
    );
    let request = RuntimeInspectionRequest {
        profile: approval.profile,
        tool_version: approval.tool_version,
        tool_entrypoint: approval.tool.entrypoint,
        host_entrypoint: approval.host.entrypoint,
    };
    assert_eq!(
        CapturedRuntime::inspect_directories(unused, unused, &request, || true).unwrap_err(),
        HostError::UnsupportedPlatform,
    );
}
