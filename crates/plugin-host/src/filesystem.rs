//! Shared descriptor-relative IO for capture, installation and staging.
use std::{
    collections::BTreeSet,
    ffi::{CStr, CString, OsStr},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path, PathBuf},
};

use crate::{HostError, HostResult, package::portable_path};

pub(crate) fn identity(file: &File) -> HostResult<(u64, u64)> {
    let metadata = file.metadata().map_err(|_| HostError::CaptureFailed)?;
    Ok((metadata.dev(), metadata.ino()))
}

fn child_name(name: &OsStr) -> io::Result<CString> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.contains(&b'/') || bytes == b"." || bytes == b".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid child name",
        ));
    }
    CString::new(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid child name"))
}

pub(crate) fn create_directory(parent: &File, name: &OsStr) -> io::Result<()> {
    let name = child_name(name)?;
    // mkdirat never replaces an existing entry. The caller opens and checks
    // its new directory before relying on its ownership or final permissions.
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn create_file(parent: &File, name: &OsStr) -> io::Result<File> {
    let name = child_name(name)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR
                | libc::O_CREAT
                | libc::O_EXCL
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | libc::O_NOCTTY,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

pub(crate) fn set_mode(file: &File, mode: u32) -> io::Result<()> {
    if unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn remove_child(parent: &File, name: &OsStr, directory: bool) -> io::Result<()> {
    let name = child_name(name)?;
    let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn open_readonly(parent: &File, name: &OsStr) -> io::Result<File> {
    let name =
        CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    // The parent and C string remain live. Success transfers fd ownership.
    // NONBLOCK and NOCTTY keep rejected special files from waiting or taking
    // ownership of a terminal before their actual type can be checked.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

/// Only ENOENT is absence. Unsafe entries and other IO failures are errors.
pub(crate) fn open_optional_file(parent: &File, name: &OsStr) -> io::Result<Option<File>> {
    child_name(name)?;
    let file = match open_readonly(parent, name) {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(Some(file))
}

/// Atomic namespace replacement under one held application-owned directory.
/// The caller checks the old entry and its candidate immediately beforehand.
pub(crate) fn replace_file(parent: &File, source: &OsStr, destination: &OsStr) -> io::Result<()> {
    let source = child_name(source)?;
    let destination = child_name(destination)?;
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            source.as_ptr(),
            parent.as_raw_fd(),
            destination.as_ptr(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn open_entry(parent: &File, name: &OsStr) -> HostResult<File> {
    let file = open_readonly(parent, name).map_err(|_| HostError::PackagePath)?;
    let metadata = file.metadata().map_err(|_| HostError::CaptureFailed)?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err(HostError::PackagePath);
    }
    Ok(file)
}

pub(crate) fn open_child(parent: &File, name: &OsStr, directory: bool) -> HostResult<File> {
    let file = open_entry(parent, name)?;
    let metadata = file.metadata().map_err(|_| HostError::CaptureFailed)?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(HostError::PackagePath);
    }
    Ok(file)
}

pub(crate) fn open_directory(path: &Path) -> HostResult<(PathBuf, File)> {
    if !path.is_absolute() {
        return Err(HostError::PackagePath);
    }
    let mut path = path.to_owned();
    // Map only OS-owned macOS temporary-directory aliases. Arbitrary caller
    // links are never canonicalized into approved paths.
    #[cfg(target_os = "macos")]
    for alias in ["/var", "/tmp"] {
        if let Ok(rest) = path.strip_prefix(alias) {
            path = Path::new("/private").join(&alias[1..]).join(rest);
            break;
        }
    }
    let mut file = File::open("/").map_err(|_| HostError::CaptureFailed)?;
    let mut count = 0;
    for part in path.components() {
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
    Ok((path, file))
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

pub(crate) fn directory_names(
    directory: &File,
    check: impl Fn() -> HostResult<()>,
    max_entries: usize,
) -> HostResult<Vec<String>> {
    // A fresh description leaves the held root's directory cursor untouched.
    let descriptor = open_child(directory, OsStr::new("."), true)?.into_raw_fd();
    let stream = unsafe { libc::fdopendir(descriptor) };
    if stream.is_null() {
        unsafe { libc::close(descriptor) };
        return Err(HostError::CaptureFailed);
    }
    let stream = DirectoryStream(stream);
    let mut result = Vec::new();
    let mut folded = BTreeSet::new();
    loop {
        check()?;
        // POSIX distinguishes EOF from error by errno. The returned entry
        // remains valid until the next readdir on this owned stream.
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
        if result.len() > max_entries {
            return Err(HostError::PackageLimit);
        }
    }
    result.sort();
    Ok(result)
}
