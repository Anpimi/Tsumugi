//! Store-specific held-file observations, permissions and commit IO.
use super::{InstallError, InstallResult};
use crate::filesystem;
pub(super) use crate::filesystem::Identity;
use std::{
    ffi::{CString, OsStr},
    fs::{File, Metadata},
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::Path,
};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    device: u64,
    inode: u64,
    uid: u32,
    mode: u32,
    links: u64,
    pub(super) length: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Stamp {
    pub(super) fn read(file: &File) -> InstallResult<Self> {
        let value = metadata(file)?;
        Ok(Self {
            device: value.dev(),
            inode: value.ino(),
            uid: value.uid(),
            mode: value.mode(),
            links: value.nlink(),
            length: value.len(),
            modified: (value.mtime(), value.mtime_nsec()),
            changed: (value.ctime(), value.ctime_nsec()),
        })
    }
}

fn metadata(file: &File) -> InstallResult<Metadata> {
    file.metadata().map_err(|_| InstallError::Io)
}
pub(super) fn private(file: &File, directory: bool, mode: u32) -> InstallResult<()> {
    let info = metadata(file)?;
    if info.uid() != unsafe { libc::geteuid() }
        || info.mode() & 0o7777 != mode
        || (directory && !info.is_dir())
        || (!directory && (!info.is_file() || info.nlink() != 1))
    {
        return Err(InstallError::CorruptStore);
    }
    Ok(())
}
fn name(value: &OsStr) -> InstallResult<CString> {
    CString::new(value.as_bytes()).map_err(|_| InstallError::CorruptStore)
}
pub(super) fn sync(file: &File) -> InstallResult<()> {
    file.sync_all().map_err(|_| InstallError::Io)
}
pub(super) fn unchanged(file: &File, expected: &Stamp) -> InstallResult<()> {
    if Stamp::read(file)? != *expected {
        return Err(InstallError::StoreChanged);
    }
    Ok(())
}
pub(super) fn chmod(file: &File, mode: u32) -> InstallResult<()> {
    filesystem::set_mode(file, mode).map_err(|_| InstallError::Io)
}
pub(super) fn mkdir(parent: &File, child: &OsStr) -> InstallResult<File> {
    name(child)?;
    filesystem::create_directory(parent, child).map_err(|_| InstallError::Io)?;
    let file = filesystem::open_child(parent, child, true)?;
    chmod(&file, 0o700)?;
    private(&file, true, 0o700)?;
    Ok(file)
}
pub(super) fn new_file(parent: &File, child: &OsStr) -> InstallResult<File> {
    name(child)?;
    let file = filesystem::create_file(parent, child).map_err(|_| InstallError::Io)?;
    chmod(&file, 0o600)?;
    private(&file, false, 0o600)?;
    Ok(file)
}
pub(super) fn same_file(
    parent: &File,
    child: &OsStr,
    directory: bool,
    expected: Identity,
) -> InstallResult<()> {
    let reopened =
        filesystem::open_child(parent, child, directory).map_err(|_| InstallError::StoreChanged)?;
    if filesystem::identity(&reopened)? != expected {
        return Err(InstallError::StoreChanged);
    }
    Ok(())
}
pub(super) fn same_root(path: &Path, expected: Identity) -> InstallResult<()> {
    let (_, reopened) = filesystem::open_directory(path).map_err(|_| InstallError::StoreChanged)?;
    if filesystem::identity(&reopened)? != expected {
        return Err(InstallError::StoreChanged);
    }
    Ok(())
}
pub(super) fn permission_mode(file: &File) -> InstallResult<u32> {
    Ok(metadata(file)?.mode() & 0o7777)
}

pub(super) fn check_provision_directory(file: &File, anchor: bool) -> InstallResult<()> {
    let info = metadata(file)?;
    if !info.is_dir()
        || info.uid() != unsafe { libc::geteuid() }
        || (anchor && info.mode() & 0o7022 != 0)
        || (!anchor && info.mode() & 0o7777 != 0o700)
    {
        return Err(InstallError::InvalidRoot);
    }
    Ok(())
}

pub(super) fn same_volume(left: Identity, right: Identity) -> bool {
    left.0 == right.0
}

pub(super) fn lock_exclusive(file: &File) -> InstallResult<()> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error().raw_os_error();
        return Err(
            if error == Some(libc::EWOULDBLOCK) || error == Some(libc::EAGAIN) {
                InstallError::Busy
            } else {
                InstallError::Io
            },
        );
    }
    Ok(())
}

pub(super) fn settings_read_error(error: std::io::Error) -> InstallError {
    match error.raw_os_error() {
        Some(libc::EIO) | Some(libc::EMFILE) | Some(libc::ENFILE) => InstallError::Io,
        _ => InstallError::CorruptSettings,
    }
}

pub(super) fn replace_file(
    parent: &File,
    source: &OsStr,
    destination: &OsStr,
) -> InstallResult<()> {
    filesystem::replace_file(parent, source, destination).map_err(|error| {
        if error.raw_os_error() == Some(libc::EIO) {
            InstallError::UnknownCommit
        } else {
            InstallError::Io
        }
    })
}

pub(super) fn promote(
    source_parent: &File,
    source: &OsStr,
    destination_parent: &File,
    destination: &OsStr,
) -> InstallResult<()> {
    let source = name(source)?;
    let destination = name(destination)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            source_parent.as_raw_fd(),
            source.as_ptr(),
            destination_parent.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            source_parent.as_raw_fd(),
            source.as_ptr(),
            destination_parent.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::EEXIST) => InstallError::ActionConflict,
            // POSIX does not promise an unchanged namespace after EIO.
            // Retain the candidate/object and recover by the same action.
            Some(libc::EIO) => InstallError::UnknownCommit,
            _ => InstallError::Io,
        });
    }
    Ok(())
}
