//! Windows implementation of the installation store's held-object operations.
use super::{InstallError, InstallResult};
pub(super) use crate::filesystem::Identity;
use crate::{filesystem, windows_security::PrivateSecurity};
use std::{
    ffi::OsStr,
    fs::{File, TryLockError},
    io,
    path::Path,
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_IO_DEVICE, ERROR_NOT_READY,
        ERROR_TOO_MANY_OPEN_FILES, ERROR_WRITE_FAULT,
    },
    Storage::FileSystem::{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_WRITE_DATA},
};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    observed: filesystem::CaptureStamp,
    pub(super) length: u64,
}

impl Stamp {
    pub(super) fn read(file: &File) -> InstallResult<Self> {
        let observed = filesystem::CaptureStamp::read(file)?;
        Ok(Self {
            length: observed.length,
            observed,
        })
    }
}

pub(super) fn private(file: &File, directory: bool, mode: u32) -> InstallResult<()> {
    if Stamp::read(file)?.observed.is_directory != directory
        || !PrivateSecurity::matches(file, Some(mode)).map_err(|_| InstallError::Io)?
    {
        return Err(InstallError::CorruptStore);
    }
    Ok(())
}

fn flush_handle(file: &File) -> InstallResult<File> {
    filesystem::reopen_held(file, FILE_WRITE_DATA).map_err(|_| InstallError::Io)
}

pub(super) fn sync(file: &File) -> InstallResult<()> {
    match file.sync_all() {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            flush_handle(file)?.sync_all().map_err(|_| InstallError::Io)
        }
        Err(_) => Err(InstallError::Io),
    }
}

pub(super) fn sync_sealed(_files: &[&File], namespace: &File) -> InstallResult<()> {
    // Sealing flushes each object's bytes and permissions through a retained
    // write handle. A reopened sealed entry can only be read. Flush the
    // writable NTFS namespace that commits the binding, including on retry.
    sync(namespace)
}

pub(super) fn chmod(file: &File, mode: u32) -> InstallResult<()> {
    let previous = permission_mode(file)?;
    if previous == mode {
        return Ok(());
    }
    if mode == 0o400 || mode == 0o500 {
        // Flush while the object is writable and hold the same write handle
        // through the ACL transition. The ACL never needs to be relaxed to
        // confirm an already sealed receipt.
        let writer = flush_handle(file)?;
        writer.sync_all().map_err(|_| InstallError::Io)?;
        filesystem::set_mode(file, mode).map_err(|_| InstallError::Io)?;
        if writer.sync_all().is_err() {
            filesystem::set_mode(file, previous).map_err(|_| InstallError::UnknownCommit)?;
            return Err(InstallError::Io);
        }
    } else {
        filesystem::set_mode(file, mode).map_err(|_| InstallError::Io)?;
    }
    Ok(())
}

pub(super) fn mkdir(parent: &File, child: &OsStr) -> InstallResult<File> {
    filesystem::create_directory(parent, child).map_err(|_| InstallError::Io)?;
    let file = filesystem::open_child(parent, child, true)?;
    private(&file, true, 0o700)?;
    Ok(file)
}

pub(super) fn new_file(parent: &File, child: &OsStr) -> InstallResult<File> {
    let file = filesystem::create_file(parent, child).map_err(|_| InstallError::Io)?;
    private(&file, false, 0o600)?;
    Ok(file)
}

pub(super) fn permission_mode(file: &File) -> InstallResult<u32> {
    let modes = if Stamp::read(file)?.observed.is_directory {
        [0o700, 0o500]
    } else {
        [0o400, 0o600]
    };
    for mode in modes {
        if PrivateSecurity::matches(file, Some(mode)).map_err(|_| InstallError::Io)? {
            return Ok(mode);
        }
    }
    Err(InstallError::CorruptStore)
}

pub(super) fn check_provision_directory(file: &File, anchor: bool) -> InstallResult<()> {
    if !anchor {
        return private(file, true, 0o700).map_err(|_| InstallError::InvalidRoot);
    }
    if !Stamp::read(file)?.observed.is_directory
        || !PrivateSecurity::store_anchor(file).map_err(|_| InstallError::InvalidRoot)?
    {
        return Err(InstallError::InvalidRoot);
    }
    Ok(())
}

pub(super) fn validate_local_volume(path: &Path, file: &File) -> InstallResult<()> {
    if !filesystem::local_ntfs(path, file).map_err(|_| InstallError::InvalidRoot)? {
        return Err(InstallError::InvalidRoot);
    }
    Ok(())
}

pub(super) fn lock_exclusive(file: File) -> InstallResult<File> {
    let lock = filesystem::reopen_held(&file, FILE_GENERIC_READ | FILE_GENERIC_WRITE)
        .map_err(|_| InstallError::Io)?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(TryLockError::WouldBlock) => Err(InstallError::Busy),
        Err(TryLockError::Error(_)) => Err(InstallError::Io),
    }
}

pub(super) fn settings_read_error(error: io::Error) -> InstallError {
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_IO_DEVICE | ERROR_TOO_MANY_OPEN_FILES | ERROR_NOT_READY) => InstallError::Io,
        _ => InstallError::CorruptSettings,
    }
}

fn rename_error(error: io::Error) -> InstallError {
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS) => InstallError::ActionConflict,
        Some(ERROR_IO_DEVICE | ERROR_WRITE_FAULT | ERROR_NOT_READY) => InstallError::UnknownCommit,
        _ if error.kind() == io::ErrorKind::InvalidData => InstallError::StoreChanged,
        _ => InstallError::Io,
    }
}

pub(super) fn replace_file(
    parent: &File,
    source: &OsStr,
    destination: &OsStr,
    expected: Identity,
) -> InstallResult<()> {
    filesystem::rename_recorded_child(parent, source, expected, parent, destination, true)
        .map_err(rename_error)
}

pub(super) fn promote(
    source_parent: &File,
    source: &OsStr,
    destination_parent: &File,
    destination: &OsStr,
    expected: Identity,
) -> InstallResult<()> {
    filesystem::rename_recorded_child(
        source_parent,
        source,
        expected,
        destination_parent,
        destination,
        false,
    )
    .map_err(rename_error)
}
