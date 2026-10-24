//! Candidate transport admission reuses the original package image and digest.
use super::*;
use std::{
    io::{Read, Seek},
    time::{Duration, Instant},
};

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

    /// Encode a deterministic candidate transport from this immutable image.
    /// This preserves package identity, not the original transport's bytes or
    /// publisher provenance, and does not write files or grant any permission.
    pub fn encode_archive(&self, authorized: impl Fn() -> bool) -> HostResult<Vec<u8>> {
        crate::candidate_archive::encode_files(&self.manifest_bytes, &self.files, guard(authorized))
    }

    fn read_archive(
        bytes: &[u8],
        expected: Option<&str>,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        let check = guard(authorized);
        let files = crate::candidate_archive::capture_files(bytes, &check)?;
        Self::from_archive_files(files, expected, check)
    }

    pub(crate) fn read_archive_reader(
        reader: &mut (impl Read + Seek),
        expected: Option<&str>,
        authorized: impl Fn() -> bool,
    ) -> HostResult<Self> {
        let check = guard(authorized);
        let files = crate::candidate_archive::capture_reader(
            reader,
            crate::candidate_archive::Profile::Package,
            &check,
        )?;
        Self::from_archive_files(files, expected, check)
    }

    fn from_archive_files(
        mut files: BTreeMap<String, PackageFile>,
        expected: Option<&str>,
        check: impl Fn() -> HostResult<()>,
    ) -> HostResult<Self> {
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

fn guard(authorized: impl Fn() -> bool) -> impl Fn() -> HostResult<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    move || {
        if !authorized() {
            Err(HostError::AuthorityRevoked)
        } else if Instant::now() >= deadline {
            Err(HostError::Timeout)
        } else {
            Ok(())
        }
    }
}
