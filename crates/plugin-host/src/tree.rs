//! One bounded descriptor-relative tree capture owner for packages and runtimes.
use crate::{HostError, HostResult};
use std::{collections::BTreeMap, path::Path, time::Duration};
use tsumugi_plugin_sdk::RuntimeArtifactFile;

pub(crate) struct TreeLimits {
    pub max_files: usize,
    pub max_bytes: usize,
    pub max_directories: usize,
    pub max_depth: usize,
    pub timeout: Duration,
    pub special_file_limit: Option<(&'static str, usize)>,
}

pub(crate) struct CapturedTree {
    pub files: BTreeMap<String, RuntimeArtifactFile>,
    /// Directory paths, including the empty root, from the same verified scans.
    pub directories: Vec<String>,
}

pub(crate) fn capture_tree(
    root: &Path,
    limits: &TreeLimits,
    authorized: impl Fn() -> bool,
) -> HostResult<BTreeMap<String, RuntimeArtifactFile>> {
    capture_tree_with_layout(root, limits, authorized).map(|tree| tree.files)
}

pub(crate) fn capture_tree_with_layout(
    root: &Path,
    limits: &TreeLimits,
    authorized: impl Fn() -> bool,
) -> HostResult<CapturedTree> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        platform::capture(root, limits, authorized)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (root, limits, authorized);
        Err(HostError::UnsupportedPlatform)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    use super::*;
    use crate::filesystem::{directory_names, open_directory, open_entry};
    use crate::package::portable_path;
    use sha2::{Digest, Sha256};
    use std::{
        ffi::OsStr,
        fs::{File, Metadata},
        io::Read,
        os::unix::fs::MetadataExt,
        time::Instant,
    };

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
        files: BTreeMap<String, RuntimeArtifactFile>,
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
        limits: &TreeLimits,
        guard: &Guard<F>,
    ) -> HostResult<()> {
        guard.check()?;
        snapshot.directory_count += 1;
        if depth > limits.max_depth || snapshot.directory_count > limits.max_directories {
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
        for name in directory_names(
            directory,
            || guard.check(),
            limits.max_files.saturating_add(limits.max_directories),
        )? {
            guard.check()?;
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            portable_path(&path)?;
            if limits
                .special_file_limit
                .is_some_and(|(name, _)| path.eq_ignore_ascii_case(name) && path != name)
            {
                return Err(HostError::PackagePath);
            }
            // Inspect the actual held child without following a link. The file
            // descriptor supplies the type, not a preceding path stat.
            let child = open_entry(directory, OsStr::new(&name))?;
            let info = metadata(&child)?;
            if info.is_dir() {
                if limits
                    .special_file_limit
                    .is_some_and(|(name, _)| path == name)
                {
                    return Err(HostError::PackagePath);
                }
                walk(
                    &child,
                    &path,
                    depth + 1,
                    snapshot,
                    capture_bytes,
                    limits,
                    guard,
                )?;
                continue;
            }
            if !info.is_file() || info.nlink() != 1 {
                return Err(HostError::PackagePath);
            }
            snapshot.file_count += 1;
            if snapshot.file_count > limits.max_files {
                return Err(HostError::PackageLimit);
            }
            let remaining = limits.max_bytes.saturating_sub(snapshot.bytes);
            let limit = limits
                .special_file_limit
                .filter(|(name, _)| path == *name)
                .map_or(remaining, |(_, limit)| remaining.min(limit));
            if info.len() > limit as u64 {
                return Err(HostError::PackageLimit);
            }
            let stamp = Stamp::from(&info);
            let mut reader = child;
            let mut bytes = Vec::new();
            if capture_bytes {
                bytes
                    .try_reserve_exact(info.len() as usize)
                    .map_err(|_| HostError::PackageLimit)?;
            }
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
                snapshot.files.insert(
                    path,
                    RuntimeArtifactFile {
                        bytes,
                        executable: info.mode() & 0o111 != 0,
                    },
                );
            }
        }
        unchanged(directory, &stamp)
    }

    pub(super) fn capture<F: Fn() -> bool>(
        root: &Path,
        limits: &TreeLimits,
        authorized: F,
    ) -> HostResult<CapturedTree> {
        let guard = Guard {
            authorized,
            deadline: Instant::now()
                .checked_add(limits.timeout)
                .ok_or(HostError::InvalidLimits)?,
        };
        guard.check()?;
        let (root, held) = open_directory(root)?;
        let before = Stamp::from(&metadata(&held)?);
        let mut snapshot = Snapshot::default();
        walk(&held, "", 0, &mut snapshot, true, limits, &guard)?;
        let mut observed = Snapshot::default();
        // Reopening from the selected absolute path detects replacement of the
        // root or any ancestor. Every file is reread with O_NOFOLLOW.
        let (_, reopened) = open_directory(&root)?;
        if Stamp::from(&metadata(&reopened)?) != before {
            return Err(HostError::PackageChanged);
        }
        walk(&reopened, "", 0, &mut observed, false, limits, &guard)?;
        if snapshot.entries != observed.entries {
            return Err(HostError::PackageChanged);
        }
        unchanged(&held, &before)?;
        guard.check()?;
        let directories = snapshot
            .entries
            .into_iter()
            .filter_map(|(path, entry)| entry.digest.is_none().then_some(path))
            .collect();
        Ok(CapturedTree {
            files: snapshot.files,
            directories,
        })
    }
}
