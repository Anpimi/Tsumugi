//! Descriptor-relative macOS reads; never resolve a user-controlled symlink.
use super::*;
use std::{
    ffi::{CStr, CString},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Identity(pub u64, pub u64);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Stamp(Identity, u64, i64, i64, i64, i64);

// These two OS-owned aliases are the paths returned by macOS temporary-directory
// APIs. Arbitrary symlinks in selected paths remain forbidden.
pub fn system_path(path: &Path) -> PathBuf {
    for alias in ["/var", "/tmp"] {
        if let Ok(rest) = path.strip_prefix(alias) {
            return Path::new("/private").join(&alias[1..]).join(rest);
        }
    }
    path.to_path_buf()
}
fn denied() -> ExecutionError {
    error(ErrorCode::Unauthorized, "unauthorized-selection")
}
pub fn name(value: &std::ffi::OsStr) -> Result<CString, ExecutionError> {
    CString::new(value.as_bytes()).map_err(|_| denied())
}
pub fn identity(file: &File) -> Result<Identity, ExecutionError> {
    let m = file.metadata().map_err(io)?;
    Ok(Identity(m.dev(), m.ino()))
}
pub fn stamp(file: &File) -> Result<Stamp, ExecutionError> {
    let m = file.metadata().map_err(io)?;
    Ok(Stamp(
        Identity(m.dev(), m.ino()),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
pub fn final_path(file: &File) -> Result<PathBuf, ExecutionError> {
    let mut bytes = [0u8; libc::PATH_MAX as usize];
    // F_GETPATH writes a NUL-terminated path into a PATH_MAX-sized buffer.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, bytes.as_mut_ptr()) } == -1 {
        return Err(denied());
    }
    let value = CStr::from_bytes_until_nul(&bytes).map_err(|_| denied())?;
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(value.to_bytes())))
}
pub fn open_child(
    parent: &File,
    child: &std::ffi::OsStr,
    directory: bool,
) -> Result<File, ExecutionError> {
    let child = name(child)?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // The parent and C string live for the call; success transfers fd ownership.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), child.as_ptr(), flags) };
    if fd == -1 {
        let cause = std::io::Error::last_os_error();
        return Err(if cause.raw_os_error() == Some(libc::ELOOP) {
            denied()
        } else {
            io(cause)
        });
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let m = file.metadata().map_err(io)?;
    if (directory && !m.is_dir()) || (!directory && !m.is_file()) {
        return Err(denied());
    }
    Ok(file)
}
pub fn open(path: &Path, directory: bool) -> Result<File, ExecutionError> {
    if !path.is_absolute() {
        return Err(denied());
    }
    let path = system_path(path);
    let mut file = File::open("/").map_err(io)?;
    let mut parts = path.components().peekable();
    while let Some(component) = parts.next() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(name) => {
                file = open_child(&file, name, parts.peek().is_some() || directory)?;
            }
            _ => return Err(denied()),
        }
    }
    Ok(file)
}
pub fn verify_file(file: &File, path: &Path, before: Stamp) -> Result<(), ExecutionError> {
    if stamp(file)? != before
        || final_path(file)? != path
        || identity(&open(path, false)?)? != identity(file)?
    {
        return Err(error(ErrorCode::DependencyConflict, "source-changed"));
    }
    Ok(())
}
