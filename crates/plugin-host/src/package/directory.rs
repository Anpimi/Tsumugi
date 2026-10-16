//! Capture an explicitly selected local package without executing its contents.
use super::*;

/// A fingerprint of a prebuilt candidate, without captured executable bytes,
/// publisher authentication, approval, installation or execution authority.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInspection {
    pub plugin: PluginIdentity,
    pub package_digest: String,
    pub manifest_sha256: String,
    /// Includes manifest.json, unlike the image's separate file collection.
    pub file_count: u32,
    pub byte_count: u64,
}

impl PackageImage {
    /// Inspect a prebuilt candidate using the same bounded descriptor-relative
    /// capture as approved loading. The resulting fingerprint must be verified
    /// or explicitly approved separately; it is never an installation receipt.
    /// No component or installation script is run.
    pub fn inspect_directory(
        root: &Path,
        authorized: impl Fn() -> bool,
    ) -> HostResult<PackageInspection> {
        let image = Self::read_directory(root, None, authorized)?;
        Ok(image.inspection())
    }

    /// Describe this already captured image without touching its former source.
    pub fn inspection(&self) -> PackageInspection {
        PackageInspection {
            plugin: self.manifest().manifest().plugin.clone(),
            package_digest: self.digest.clone(),
            manifest_sha256: format!("{:x}", Sha256::digest(&self.manifest_bytes)),
            file_count: (self.files.len() + 1) as u32,
            byte_count: self.manifest_bytes.len() as u64
                + self
                    .files
                    .values()
                    .map(|file| file.bytes.len() as u64)
                    .sum::<u64>(),
        }
    }

    /// Read a prebuilt local directory through held directory descriptors. The
    /// caller supplies the independently approved digest and a live read guard;
    /// source selection/trust and execution consent are separate decisions.
    ///
    /// macOS and Linux reject links, special files, hard-linked files, aliases,
    /// oversized trees and observed changes. Two complete descriptor-relative
    /// scans must agree before immutable bytes are returned. No archive or
    /// installation script is executed. This synchronous IO belongs on a
    /// blocking worker, never the project thread or async executor.
    pub fn capture_directory(
        root: &Path,
        expected_digest: &str,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        Self::read_directory(root, Some(expected_digest), authorized)
    }

    fn read_directory(
        root: &Path,
        expected_digest: Option<&str>,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            use crate::tree::{TreeLimits, capture_tree};
            use std::time::{Duration, Instant};
            let start = Instant::now();
            let timeout = Duration::from_secs(10);
            let limits = TreeLimits {
                max_files: MAX_FILES + 1,
                max_bytes: MAX_PACKAGE_BYTES,
                max_directories: MAX_DIRECTORIES,
                max_depth: MAX_DEPTH,
                timeout,
                special_file_limit: Some(("manifest.json", MAX_MANIFEST_BYTES)),
            };
            let mut files = capture_tree(root, &limits, &authorized)?;
            let manifest = files
                .remove("manifest.json")
                .ok_or(HostError::MissingArtifact)?;
            let digest;
            let expected_digest = match expected_digest {
                Some(approved) => approved,
                None => {
                    digest = Self::digest(&manifest.bytes, &files)?;
                    &digest
                }
            };
            let image = Self::capture(manifest.bytes, files, expected_digest)?;
            if !authorized() {
                return Err(HostError::AuthorityRevoked);
            }
            if start.elapsed() >= timeout {
                return Err(HostError::Timeout);
            }
            Ok(image)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (root, expected_digest, authorized);
            Err(HostError::UnsupportedPlatform)
        }
    }
}
