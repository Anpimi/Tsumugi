//! Captured application code, independent of the Core member executor.
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use tsumugi_plugin_sdk::RuntimeArtifactFile;

use crate::{
    HostError, HostResult,
    package::portable_path,
    tree::{TreeLimits, capture_tree},
};

const MAX_ARTIFACT_BYTES: usize = 32 * 1024 * 1024;

/// A build manifest supplied independently by the trusted application owner.
/// Matching it establishes the captured format, not publisher authenticity or
/// permission to execute the directory being captured.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberArtifactManifest {
    pub format: String,
    pub version: u32,
    pub protocol_version: u32,
    pub entrypoint: String,
}
impl MemberArtifactManifest {
    pub(crate) fn validate(&self) -> HostResult<()> {
        if self.format != "tsumugi-member-runtime"
            || self.version != 1
            || self.protocol_version == 0
        {
            return Err(HostError::InvalidContract);
        }
        portable_path(&self.entrypoint)?;
        if self.entrypoint == "manifest.json" || !self.entrypoint.ends_with(".mjs") {
            return Err(HostError::PackagePath);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct CapturedMemberArtifact {
    manifest: Arc<MemberArtifactManifest>,
    manifest_bytes: Arc<[u8]>,
    files: Arc<BTreeMap<String, RuntimeArtifactFile>>,
}
impl CapturedMemberArtifact {
    /// Capture a link-free, bounded application artifact on a blocking worker.
    /// The caller supplies the independently expected protocol. Its executor
    /// must separately refuse protocols it does not implement before launch.
    /// This operation executes no code and grants no runtime permission.
    pub fn capture_directory(
        root: &Path,
        expected_manifest: &MemberArtifactManifest,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        expected_manifest.validate()?;
        let mut files = capture_tree(
            root,
            &TreeLimits {
                max_files: 256,
                max_bytes: MAX_ARTIFACT_BYTES,
                max_directories: 256,
                max_depth: 16,
                timeout: Duration::from_secs(30),
                special_file_limit: Some(("manifest.json", 4096)),
            },
            &authorized,
        )?;
        let manifest = files
            .remove("manifest.json")
            .ok_or(HostError::MissingArtifact)?;
        if manifest.executable {
            return Err(HostError::InvalidContract);
        }
        let observed: MemberArtifactManifest =
            serde_json::from_slice(&manifest.bytes).map_err(|_| HostError::InvalidContract)?;
        observed.validate()?;
        if &observed != expected_manifest {
            return Err(HostError::PackageMismatch);
        }
        let entry = files
            .get(&observed.entrypoint)
            .ok_or(HostError::MissingArtifact)?;
        if entry.bytes.is_empty() || entry.executable {
            return Err(HostError::InvalidContract);
        }
        if !authorized() {
            return Err(HostError::AuthorityRevoked);
        }
        Ok(Self {
            manifest: Arc::new(observed),
            manifest_bytes: manifest.bytes.into(),
            files: Arc::new(files),
        })
    }

    pub fn manifest(&self) -> &MemberArtifactManifest {
        &self.manifest
    }

    pub(crate) fn manifest_bytes(&self) -> &[u8] {
        &self.manifest_bytes
    }

    pub(crate) fn files(&self) -> &BTreeMap<String, RuntimeArtifactFile> {
        &self.files
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_manifest_validates_format_and_module_entry() {
        let mut manifest = MemberArtifactManifest {
            format: "tsumugi-member-runtime".into(),
            version: 1,
            protocol_version: 1,
            entrypoint: "worker.mjs".into(),
        };
        manifest.validate().unwrap();
        manifest.protocol_version = 0;
        assert_eq!(manifest.validate(), Err(HostError::InvalidContract));
        manifest.protocol_version = 1;
        manifest.entrypoint = "../worker.mjs".into();
        assert_eq!(manifest.validate(), Err(HostError::PackagePath));
        manifest.entrypoint = "manifest.json".into();
        assert_eq!(manifest.validate(), Err(HostError::PackagePath));
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn capture_requires_the_independent_protocol_and_complete_entry() {
        let root = tempfile::tempdir().unwrap();
        let manifest = MemberArtifactManifest {
            format: "tsumugi-member-runtime".into(),
            version: 1,
            protocol_version: 2,
            entrypoint: "worker.mjs".into(),
        };
        std::fs::write(
            root.path().join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            CapturedMemberArtifact::capture_directory(root.path(), &manifest, || true),
            Err(HostError::MissingArtifact)
        ));
        std::fs::write(root.path().join("worker.mjs"), b"export {};").unwrap();
        let mut wrong = manifest.clone();
        wrong.protocol_version = 1;
        assert!(matches!(
            CapturedMemberArtifact::capture_directory(root.path(), &wrong, || true),
            Err(HostError::PackageMismatch)
        ));
        let captured =
            CapturedMemberArtifact::capture_directory(root.path(), &manifest, || true).unwrap();
        assert_eq!(captured.manifest(), &manifest);
        std::fs::write(root.path().join("worker.mjs"), b"changed").unwrap();
        assert_eq!(captured.files()["worker.mjs"].bytes, b"export {};");
    }
}
