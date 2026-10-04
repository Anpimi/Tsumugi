//! Capture an explicitly selected local package without executing its contents.
use super::*;

impl PackageImage {
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
