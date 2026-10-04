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
            platform::capture(root, expected_digest, authorized)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (root, expected_digest, authorized);
            Err(HostError::UnsupportedPlatform)
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    use super::*;
    use crate::filesystem::{directory_names, open_directory, open_entry};
    use std::{
        ffi::OsStr,
        fs::{File, Metadata},
        io::Read,
        os::unix::fs::MetadataExt,
        time::{Duration, Instant},
    };

    const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Stamp {
        device: u64,
        inode: u64,
        mode: u32,
        links: u64,
        length: u64,
        modified: (i64, i64),
        changed: (i64, i64),
    }
    impl From<&Metadata> for Stamp {
        fn from(value: &Metadata) -> Self {
            Self {
                device: value.dev(),
                inode: value.ino(),
                mode: value.mode(),
                links: value.nlink(),
                length: value.len(),
                modified: (value.mtime(), value.mtime_nsec()),
                changed: (value.ctime(), value.ctime_nsec()),
            }
        }
    }
    #[derive(Debug, PartialEq, Eq)]
    struct Entry {
        stamp: Stamp,
        // Directories have no content digest; their complete name sets are
        // checked by comparing both scans' complete entry maps.
        digest: Option<[u8; 32]>,
    }
    #[derive(Default)]
    struct Snapshot {
        entries: BTreeMap<String, Entry>,
        files: BTreeMap<String, PackageFile>,
        manifest: Option<Vec<u8>>,
        bytes: usize,
        file_count: usize,
        directory_count: usize,
    }
    struct Guard<F> {
        authorized: F,
        deadline: Instant,
    }
    impl<F: Fn() -> bool> Guard<F> {
        fn check(&self) -> HostResult<()> {
            if !(self.authorized)() {
                Err(HostError::AuthorityRevoked)
            } else if Instant::now() >= self.deadline {
                Err(HostError::Timeout)
            } else {
                Ok(())
            }
        }
    }

    fn metadata(file: &File) -> HostResult<Metadata> {
        file.metadata().map_err(|_| HostError::CaptureFailed)
    }
    fn unchanged(file: &File, stamp: &Stamp) -> HostResult<()> {
        if Stamp::from(&metadata(file)?) != *stamp {
            return Err(HostError::PackageChanged);
        }
        Ok(())
    }
    fn walk<F: Fn() -> bool>(
        directory: &File,
        prefix: &str,
        depth: usize,
        snapshot: &mut Snapshot,
        capture_bytes: bool,
        guard: &Guard<F>,
    ) -> HostResult<()> {
        guard.check()?;
        snapshot.directory_count += 1;
        if depth > MAX_DEPTH || snapshot.directory_count > MAX_DIRECTORIES {
            return Err(HostError::PackageLimit);
        }
        let stamp = Stamp::from(&metadata(directory)?);
        snapshot.entries.insert(
            prefix.to_owned(),
            Entry {
                stamp: stamp.clone(),
                digest: None,
            },
        );
        for name in directory_names(directory, || guard.check(), MAX_FILES + MAX_DIRECTORIES + 1)? {
            guard.check()?;
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            portable_path(&path)?;
            if path.eq_ignore_ascii_case("manifest.json") && path != "manifest.json" {
                return Err(HostError::PackagePath);
            }
            // Inspect the actual held child without following a link. The file
            // descriptor supplies the type, not a preceding path stat.
            let child = open_entry(directory, OsStr::new(&name))?;
            let info = metadata(&child)?;
            if info.is_dir() {
                if path == "manifest.json" {
                    return Err(HostError::PackagePath);
                }
                walk(&child, &path, depth + 1, snapshot, capture_bytes, guard)?;
                continue;
            }
            if !info.is_file() || info.nlink() != 1 {
                return Err(HostError::PackagePath);
            }
            snapshot.file_count += 1;
            if snapshot.file_count > MAX_FILES + 1 {
                return Err(HostError::PackageLimit);
            }
            let manifest = path == "manifest.json";
            let remaining = MAX_PACKAGE_BYTES.saturating_sub(snapshot.bytes);
            let limit = if manifest {
                remaining.min(MAX_MANIFEST_BYTES)
            } else {
                remaining
            };
            if info.len() > limit as u64 {
                return Err(HostError::PackageLimit);
            }
            let stamp = Stamp::from(&info);
            let mut reader = child;
            let mut bytes = Vec::new();
            let mut hash = Sha256::new();
            let mut read = 0usize;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                guard.check()?;
                let count = reader
                    .read(&mut buffer)
                    .map_err(|_| HostError::CaptureFailed)?;
                if count == 0 {
                    break;
                }
                read = read.checked_add(count).ok_or(HostError::PackageLimit)?;
                if read > limit {
                    return Err(HostError::PackageLimit);
                }
                hash.update(&buffer[..count]);
                if capture_bytes {
                    bytes.extend_from_slice(&buffer[..count]);
                }
            }
            unchanged(&reader, &stamp)?;
            if read as u64 != info.len() {
                return Err(HostError::PackageChanged);
            }
            snapshot.bytes += read;
            snapshot.entries.insert(
                path.clone(),
                Entry {
                    stamp,
                    digest: Some(hash.finalize().into()),
                },
            );
            if capture_bytes {
                if manifest {
                    snapshot.manifest = Some(bytes);
                } else {
                    snapshot.files.insert(
                        path,
                        PackageFile {
                            bytes,
                            executable: info.mode() & 0o111 != 0,
                        },
                    );
                }
            }
        }
        unchanged(directory, &stamp)
    }

    pub(super) fn capture<F: Fn() -> bool>(
        root: &Path,
        expected_digest: &str,
        authorized: F,
    ) -> HostResult<PackageImage> {
        let guard = Guard {
            authorized,
            deadline: Instant::now() + CAPTURE_TIMEOUT,
        };
        guard.check()?;
        let (root, held) = open_directory(root)?;
        let before = Stamp::from(&metadata(&held)?);
        let mut snapshot = Snapshot::default();
        walk(&held, "", 0, &mut snapshot, true, &guard)?;
        let mut observed = Snapshot::default();
        // Reopening from the selected absolute path detects replacement of the
        // root or any ancestor. Every file is reread with O_NOFOLLOW.
        let (_, reopened) = open_directory(&root)?;
        if Stamp::from(&metadata(&reopened)?) != before {
            return Err(HostError::PackageChanged);
        }
        walk(&reopened, "", 0, &mut observed, false, &guard)?;
        if snapshot.entries != observed.entries {
            return Err(HostError::PackageChanged);
        }
        unchanged(&held, &before)?;
        let image = PackageImage::capture(
            snapshot.manifest.ok_or(HostError::MissingArtifact)?,
            snapshot.files,
            expected_digest,
        )?;
        guard.check()?;
        Ok(image)
    }
}
