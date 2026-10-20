//! Candidate transport admission reuses the original package image and digest.
use super::*;
use std::time::{Duration, Instant};

impl PackageImage {
    /// Capture an already read, bounded uncompressed candidate tar. Member
    /// modes supply explicit executable flags on every platform. Nothing is
    /// extracted or executed; the digest must be approved independently.
    pub fn capture_archive(
        bytes: &[u8],
        expected_digest: &str,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        Self::read_archive(bytes, Some(expected_digest), authorized)
    }

    /// Fingerprint an untrusted candidate transport without granting trust,
    /// installation, publisher authentication or execution permission.
    pub fn inspect_archive(
        bytes: &[u8],
        authorized: impl Fn() -> bool,
    ) -> HostResult<PackageInspection> {
        Self::read_archive(bytes, None, authorized).map(|image| image.inspection())
    }

    fn read_archive(
        bytes: &[u8],
        expected: Option<&str>,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let check = || {
            if !authorized() {
                Err(HostError::AuthorityRevoked)
            } else if Instant::now() >= deadline {
                Err(HostError::Timeout)
            } else {
                Ok(())
            }
        };
        let mut files = crate::candidate_archive::capture_files(bytes, &check)?;
        let manifest = files
            .remove("manifest.json")
            .ok_or(HostError::MissingArtifact)?;
        check()?;
        let digest;
        let expected = match expected {
            Some(expected) => expected,
            None => {
                digest = Self::digest(&manifest.bytes, &files)?;
                &digest
            }
        };
        let image = Self::capture(manifest.bytes, files, expected)?;
        check()?;
        Ok(image)
    }
}
