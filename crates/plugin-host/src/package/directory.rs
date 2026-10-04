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
    use std::{
        collections::BTreeSet,
        ffi::{CStr, CString, OsStr},
        fs::{File, Metadata},
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd, IntoRawFd},
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
        path::{Component, PathBuf},
        time::{Duration, Instant},
    };

    const MAX_DIRECTORIES: usize = 256;
    const MAX_DEPTH: usize = 16;
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

    // macOS APIs return these OS-owned aliases for temporary directories. Map
    // only those fixed aliases, without canonicalizing arbitrary user links.
    fn system_path(root: &Path) -> PathBuf {
        #[cfg(target_os = "macos")]
        for alias in ["/var", "/tmp"] {
            if let Ok(rest) = root.strip_prefix(alias) {
                return Path::new("/private").join(&alias[1..]).join(rest);
            }
        }
        root.to_owned()
    }
    fn open_child(parent: &File, name: &OsStr, directory: bool) -> HostResult<File> {
        let name = CString::new(name.as_bytes()).map_err(|_| HostError::PackagePath)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        // Success transfers ownership of the new descriptor. O_NONBLOCK keeps
        // a replaced FIFO/device from blocking before its type can be checked.
        let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(HostError::PackagePath);
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
        let metadata = file.metadata().map_err(|_| HostError::CaptureFailed)?;
        if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
            return Err(HostError::PackagePath);
        }
        Ok(file)
    }
    fn open_root(root: &Path) -> HostResult<File> {
        if !root.is_absolute() {
            return Err(HostError::PackagePath);
        }
        let mut file = File::open("/").map_err(|_| HostError::CaptureFailed)?;
        let mut count = 0;
        for part in root.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    count += 1;
                    if count > 128 {
                        return Err(HostError::PackagePath);
                    }
                    file = open_child(&file, name, true)?;
                }
                _ => return Err(HostError::PackagePath),
            }
        }
        if count == 0 {
            return Err(HostError::PackagePath);
        }
        Ok(file)
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
    struct DirectoryStream(*mut libc::DIR);
    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            // fdopendir owns the fresh descriptor until this single close.
            unsafe { libc::closedir(self.0) };
        }
    }
    fn errno() -> *mut libc::c_int {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::__error()
        }
        #[cfg(target_os = "linux")]
        unsafe {
            libc::__errno_location()
        }
    }
    fn names<F: Fn() -> bool>(directory: &File, guard: &Guard<F>) -> HostResult<Vec<String>> {
        // A fresh open description keeps readdir's cursor off the held root.
        let file = open_child(directory, OsStr::new("."), true)?;
        let descriptor = file.into_raw_fd();
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            unsafe { libc::close(descriptor) };
            return Err(HostError::CaptureFailed);
        }
        let stream = DirectoryStream(stream);
        let mut result = Vec::new();
        let mut folded = BTreeSet::new();
        loop {
            guard.check()?;
            // POSIX uses a null entry for both EOF and error, distinguished by
            // errno. readdir's result remains valid until the next call.
            unsafe { *errno() = 0 };
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                if unsafe { *errno() } != 0 {
                    return Err(HostError::CaptureFailed);
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
                .to_str()
                .map_err(|_| HostError::PackagePath)?;
            if name == "." || name == ".." {
                continue;
            }
            portable_path(name)?;
            if !folded.insert(name.to_ascii_lowercase()) {
                return Err(HostError::PackagePath);
            }
            result.push(name.to_owned());
            if result.len() > MAX_FILES + MAX_DIRECTORIES + 1 {
                return Err(HostError::PackageLimit);
            }
        }
        result.sort();
        Ok(result)
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
        for name in names(directory, guard)? {
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
            let child = {
                let name = CString::new(name.as_bytes()).map_err(|_| HostError::PackagePath)?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY
                            | libc::O_CLOEXEC
                            | libc::O_NOFOLLOW
                            | libc::O_NONBLOCK
                            | libc::O_NOCTTY,
                    )
                };
                if fd < 0 {
                    return Err(HostError::PackagePath);
                }
                unsafe { File::from_raw_fd(fd) }
            };
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
        let root = system_path(root);
        let held = open_root(&root)?;
        let before = Stamp::from(&metadata(&held)?);
        let mut snapshot = Snapshot::default();
        walk(&held, "", 0, &mut snapshot, true, &guard)?;
        let mut observed = Snapshot::default();
        // Reopening from the selected absolute path detects replacement of the
        // root or any ancestor. Every file is reread with O_NOFOLLOW.
        let reopened = open_root(&root)?;
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
