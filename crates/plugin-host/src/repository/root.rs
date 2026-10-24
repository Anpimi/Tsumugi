//! A separately selected root file is captured, never implicitly trusted.
use super::*;
use tough::schema::{Role, Root, Signed};

/// Unapproved bytes from an independently selected root file. Self-consistent
/// metadata and a fingerprint do not prove who supplied a root or enroll it.
/// The application's explicit trust decision must bind these exact bytes.
#[derive(Clone)]
pub struct CapturedRepositoryRoot {
    bytes: Arc<[u8]>,
    fingerprint: String,
    signed_payload_fingerprint: String,
    version: u64,
}

impl fmt::Debug for CapturedRepositoryRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedRepositoryRoot")
            .field("fingerprint", &self.fingerprint)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

impl CapturedRepositoryRoot {
    /// Bounded synchronous IO on a blocking worker. Held descriptors, two full
    /// reads, stable metadata, and reopening the selected parent reject links,
    /// special/hard-linked files and observed replacement. No repository folder
    /// is consulted and no signature or update trust is granted.
    pub fn capture_file(path: &Path, authorized: impl Fn() -> bool) -> RepositoryResult<Self> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let bytes = platform::capture(path, &authorized)?;
            Self::decode(bytes, &authorized)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (path, authorized);
            Err(RepositoryError::Capture(HostError::UnsupportedPlatform))
        }
    }

    /// Reconstruct an unapproved file capture from the existing pending-action
    /// owner's frozen bytes and original fingerprint. This is not root trust.
    pub fn restore_bytes(
        bytes: Vec<u8>,
        expected_fingerprint: &str,
        authorized: impl Fn() -> bool,
    ) -> RepositoryResult<Self> {
        sdk::validate_package_digest(expected_fingerprint)
            .map_err(|_| RepositoryError::TrustedRootMismatch)?;
        let restored = Self::decode(bytes, &authorized)?;
        if restored.fingerprint != expected_fingerprint {
            return Err(RepositoryError::TrustedRootMismatch);
        }
        Ok(restored)
    }

    fn decode(bytes: Vec<u8>, authorized: impl Fn() -> bool) -> RepositoryResult<Self> {
        if !authorized() {
            return Err(RepositoryError::AuthorityRevoked);
        }
        if bytes.is_empty() || bytes.len() > MAX_REPOSITORY_ROOT_BYTES {
            return Err(RepositoryError::LimitExceeded);
        }
        let root: Signed<Root> =
            serde_json::from_slice(&bytes).map_err(|_| RepositoryError::TrustedRootMismatch)?;
        let payload = root
            .signed
            .canonical_form()
            .map_err(|_| RepositoryError::TrustedRootMismatch)?;
        let captured = Self {
            fingerprint: format!("{:x}", Sha256::digest(&bytes)),
            signed_payload_fingerprint: format!("{:x}", Sha256::digest(&payload)),
            version: root.signed.version.get(),
            bytes: bytes.into(),
        };
        if !authorized() {
            return Err(RepositoryError::AuthorityRevoked);
        }
        Ok(captured)
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// SHA-256 of the complete exact file, including its signature list.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Canonical signed-payload fingerprint, insensitive to JSON formatting.
    /// The exact-file fingerprint still binds an explicit enrollment decision.
    pub fn signed_payload_fingerprint(&self) -> &str {
        &self.signed_payload_fingerprint
    }

    pub fn version(&self) -> u64 {
        self.version
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    use super::*;
    use crate::filesystem::{open_directory, open_entry};
    use std::{fs::File, io::Read, os::unix::fs::MetadataExt};

    #[derive(PartialEq, Eq)]
    struct Stamp {
        device: u64,
        inode: u64,
        mode: u32,
        links: u64,
        length: u64,
        modified: (i64, i64),
        changed: (i64, i64),
    }

    impl Stamp {
        fn read(file: &File) -> RepositoryResult<Self> {
            let metadata = file
                .metadata()
                .map_err(|_| RepositoryError::Capture(HostError::CaptureFailed))?;
            Ok(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                mode: metadata.mode(),
                links: metadata.nlink(),
                length: metadata.len(),
                modified: (metadata.mtime(), metadata.mtime_nsec()),
                changed: (metadata.ctime(), metadata.ctime_nsec()),
            })
        }
    }

    fn check(authorized: &impl Fn() -> bool, deadline: Instant) -> RepositoryResult<()> {
        if !authorized() {
            Err(RepositoryError::AuthorityRevoked)
        } else if Instant::now() >= deadline {
            Err(RepositoryError::Timeout)
        } else {
            Ok(())
        }
    }

    fn read(
        mut file: File,
        authorized: &impl Fn() -> bool,
        deadline: Instant,
    ) -> RepositoryResult<(Vec<u8>, Stamp)> {
        check(authorized, deadline)?;
        let metadata = file
            .metadata()
            .map_err(|_| RepositoryError::Capture(HostError::CaptureFailed))?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(RepositoryError::Capture(HostError::PackagePath));
        }
        if metadata.len() == 0 || metadata.len() > MAX_REPOSITORY_ROOT_BYTES as u64 {
            return Err(RepositoryError::LimitExceeded);
        }
        let before = Stamp::read(&file)?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(metadata.len() as usize)
            .map_err(|_| RepositoryError::LimitExceeded)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            check(authorized, deadline)?;
            let count = file
                .read(&mut buffer)
                .map_err(|_| RepositoryError::Capture(HostError::CaptureFailed))?;
            if count == 0 {
                break;
            }
            if bytes.len() + count > MAX_REPOSITORY_ROOT_BYTES {
                return Err(RepositoryError::LimitExceeded);
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        if Stamp::read(&file)? != before || bytes.len() as u64 != before.length {
            return Err(RepositoryError::Capture(HostError::PackageChanged));
        }
        check(authorized, deadline)?;
        Ok((bytes, before))
    }

    pub(super) fn capture(
        path: &Path,
        authorized: &impl Fn() -> bool,
    ) -> RepositoryResult<Vec<u8>> {
        let deadline = Instant::now() + REPOSITORY_TIMEOUT;
        check(authorized, deadline)?;
        let name = path
            .file_name()
            .ok_or(RepositoryError::Capture(HostError::PackagePath))?;
        let parent = path
            .parent()
            .ok_or(RepositoryError::Capture(HostError::PackagePath))?;
        let (parent_path, held_parent) = open_directory(parent)?;
        let parent_stamp = Stamp::read(&held_parent)?;
        let (bytes, before) = read(open_entry(&held_parent, name)?, authorized, deadline)?;
        let (_, reopened_parent) = open_directory(&parent_path)?;
        if Stamp::read(&reopened_parent)? != parent_stamp {
            return Err(RepositoryError::Capture(HostError::PackageChanged));
        }
        let (observed_bytes, observed) =
            read(open_entry(&reopened_parent, name)?, authorized, deadline)?;
        if before != observed
            || bytes != observed_bytes
            || Stamp::read(&held_parent)? != parent_stamp
        {
            return Err(RepositoryError::Capture(HostError::PackageChanged));
        }
        check(authorized, deadline)?;
        Ok(bytes)
    }
}
