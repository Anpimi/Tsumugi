use crate::{CapturedRuntime, HostError, HostResult, staging::StagedDirectory};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tsumugi_plugin_sdk::*;

const MAX_FILES: usize = 256;
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) const MAX_DIRECTORIES: usize = 256;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) const MAX_DEPTH: usize = 16;

mod directory;
pub(crate) mod installation;

pub(crate) fn portable_path(path: &str) -> HostResult<()> {
    validate_package_path(path).map_err(|_| HostError::PackagePath)?;
    // Avoid aliases and reserved device names across supported filesystems.
    if !path.is_ascii()
        || path.split('/').any(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            part.ends_with(['.', ' '])
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
    {
        return Err(HostError::PackagePath);
    }
    Ok(())
}

pub use tsumugi_plugin_sdk::RuntimeArtifactFile as PackageFile;

/// Immutable captured bytes, checked against the digest supplied by a trusted
/// catalog/installer. This API does not authenticate a publisher or read an
/// arbitrary source directory, archive, symlink or project path.
#[derive(Clone)]
pub struct PackageImage {
    manifest_bytes: Arc<[u8]>,
    manifest: Arc<ValidatedManifest>,
    files: Arc<BTreeMap<String, PackageFile>>,
    digest: String,
}
impl PackageImage {
    /// Digest of ordered, length-delimited manifest/path/content bytes and file
    /// executable flags. Computing a digest is not authorization to execute.
    pub fn digest(manifest: &[u8], files: &BTreeMap<String, PackageFile>) -> HostResult<String> {
        if manifest.len() > MAX_MANIFEST_BYTES || files.is_empty() || files.len() > MAX_FILES {
            return Err(HostError::PackageLimit);
        }
        let mut size = manifest.len();
        let mut names = Vec::new();
        let mut hash = Sha256::new();
        hash.update(b"tsumugi-captured-package-v1\0");
        hash.update((manifest.len() as u64).to_be_bytes());
        hash.update(manifest);
        for (path, file) in files {
            portable_path(path)?;
            let folded = path.to_ascii_lowercase();
            if folded == "manifest.json"
                || folded.starts_with("manifest.json/")
                || names.iter().any(|n: &String| {
                    n == &folded
                        || n.starts_with(&(folded.clone() + "/"))
                        || folded.starts_with(&(n.clone() + "/"))
                })
            {
                return Err(HostError::PackagePath);
            }
            names.push(folded);
            size = size
                .checked_add(file.bytes.len())
                .ok_or(HostError::PackageLimit)?;
            if size > MAX_PACKAGE_BYTES {
                return Err(HostError::PackageLimit);
            }
            hash.update((path.len() as u64).to_be_bytes());
            hash.update(path.as_bytes());
            hash.update([u8::from(file.executable)]);
            hash.update((file.bytes.len() as u64).to_be_bytes());
            hash.update(&file.bytes);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    pub fn capture(
        manifest_bytes: Vec<u8>,
        files: BTreeMap<String, PackageFile>,
        expected_digest: &str,
    ) -> HostResult<Self> {
        let digest = Self::digest(&manifest_bytes, &files)?;
        if digest != expected_digest {
            return Err(HostError::PackageMismatch);
        }
        let manifest = parse_manifest(&manifest_bytes).map_err(|_| HostError::InvalidContract)?;
        for component in &manifest.manifest().components {
            if let Some(path) = &component.entrypoint {
                let file = files.get(path).ok_or(HostError::MissingArtifact)?;
                if component.runtime == RuntimeKind::NativeWorker && !file.executable {
                    return Err(HostError::MissingArtifact);
                }
            }
        }
        for contribution in &manifest.manifest().contributions {
            if let ContributionKind::Resource { path, .. } | ContributionKind::Skill { path } =
                &contribution.contribution
            {
                if !files.contains_key(path) {
                    return Err(HostError::MissingArtifact);
                }
            }
        }
        Ok(Self {
            manifest_bytes: manifest_bytes.into(),
            manifest: Arc::new(manifest),
            files: Arc::new(files),
            digest,
        })
    }
    pub fn package_digest(&self) -> &str {
        &self.digest
    }
    pub fn manifest(&self) -> &ValidatedManifest {
        &self.manifest
    }
    pub(crate) fn stage(
        &self,
        staging_parent: &Path,
        runtime: Option<&CapturedRuntime>,
        authorized: impl Fn() -> bool,
    ) -> HostResult<StagedDirectory> {
        crate::staging::materialize(
            staging_parent,
            &self.manifest_bytes,
            &self.files,
            runtime,
            authorized,
        )
    }
}
