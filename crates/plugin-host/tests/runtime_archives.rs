//! Public read-only archive capture, independently of filesystem installation.
#![cfg(all(
    any(target_os = "macos", target_os = "linux", windows),
    any(target_arch = "aarch64", target_arch = "x86_64")
))]

use std::{
    cell::Cell,
    collections::BTreeMap,
    io::{self, Cursor, Read, Seek, SeekFrom},
};
use tsumugi_plugin_host::{CapturedRuntime, HostError};
use tsumugi_plugin_sdk as sdk;

fn archive(files: &BTreeMap<String, sdk::RuntimeArtifactFile>) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, file) in files {
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_mode(if file.executable { 0o755 } else { 0o644 });
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(file.bytes.len() as u64);
        header.set_cksum();
        builder
            .append_data(&mut header, path, file.bytes.as_slice())
            .unwrap();
    }
    builder.into_inner().unwrap()
}

struct ObservedReader<'a> {
    calls: &'a Cell<usize>,
}
impl Read for ObservedReader<'_> {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        self.calls.set(self.calls.get() + 1);
        Ok(0)
    }
}
impl Seek for ObservedReader<'_> {
    fn seek(&mut self, _: SeekFrom) -> io::Result<u64> {
        self.calls.set(self.calls.get() + 1);
        Ok(0)
    }
}

#[test]
fn public_archive_capture_preserves_approval_and_rejects_other_platform_before_io() {
    let tool = BTreeMap::from([
        (
            "payload/launcher".into(),
            sdk::RuntimeArtifactFile {
                bytes: vec![0, 255, 1],
                executable: true,
            },
        ),
        (
            "license.exe".into(),
            sdk::RuntimeArtifactFile {
                bytes: b"synthetic license\n".to_vec(),
                executable: false,
            },
        ),
    ]);
    let host = BTreeMap::from([(
        "bootstrap/main.js".into(),
        sdk::RuntimeArtifactFile {
            bytes: b"synthetic data, never executed".to_vec(),
            executable: false,
        },
    )]);
    let operating_system = if cfg!(target_os = "macos") {
        sdk::RuntimeOperatingSystem::Macos
    } else if cfg!(target_os = "linux") {
        sdk::RuntimeOperatingSystem::Linux
    } else {
        sdk::RuntimeOperatingSystem::Windows
    };
    let approval = sdk::RuntimeEnvironmentDescriptor {
        protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
        platform: sdk::RuntimePlatform {
            operating_system,
            architecture: if cfg!(target_arch = "aarch64") {
                sdk::RuntimeArchitecture::Aarch64
            } else {
                sdk::RuntimeArchitecture::X86_64
            },
        },
        sdk_version: sdk::SDK_VERSION.into(),
        process_protocol: sdk::PROCESS_PROTOCOL,
        profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
        tool_version: "26.10.0".into(),
        tool: sdk::RuntimeArtifactBinding {
            tree_digest: sdk::runtime_artifact_digest(&tool).unwrap(),
            entrypoint: "payload/launcher".into(),
        },
        host: sdk::RuntimeArtifactBinding {
            tree_digest: sdk::runtime_artifact_digest(&host).unwrap(),
            entrypoint: "bootstrap/main.js".into(),
        },
    };
    let captured = CapturedRuntime::capture_archives(
        &mut Cursor::new(archive(&tool)),
        &mut Cursor::new(archive(&host)),
        &approval,
        || true,
    )
    .unwrap();
    assert_eq!(captured.descriptor(), &approval);
    assert_eq!(captured.environment_digest(), approval.digest().unwrap());

    let mut wrong = approval;
    wrong.platform.operating_system = match operating_system {
        sdk::RuntimeOperatingSystem::Windows => sdk::RuntimeOperatingSystem::Linux,
        sdk::RuntimeOperatingSystem::Macos | sdk::RuntimeOperatingSystem::Linux => {
            sdk::RuntimeOperatingSystem::Windows
        }
    };
    let calls = Cell::new(0);
    assert_eq!(
        CapturedRuntime::capture_archives(
            &mut ObservedReader { calls: &calls },
            &mut ObservedReader { calls: &calls },
            &wrong,
            || true,
        )
        .unwrap_err(),
        HostError::UnsupportedPlatform
    );
    assert_eq!(calls.get(), 0);
}
