//! Held-parent-relative Windows IO for owned materialization and cleanup.
//! Logical executable flags belong to the captured input, never NTFS metadata.
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs::File,
    io,
    mem::{offset_of, size_of},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr::{null, null_mut},
};

use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NAMES_INFORMATION, FILE_NON_DIRECTORY_FILE,
            FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, FileNamesInformation,
            NtCreateFile, NtQueryDirectoryFile,
        },
    },
    Win32::{
        Foundation::{
            ERROR_FILE_NOT_FOUND, HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE,
            OBJ_DONT_REPARSE, RtlNtStatusToDosError, STATUS_NO_MORE_FILES, UNICODE_STRING,
        },
        Storage::FileSystem::{
            CreateFileW, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_ID_INFO,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
            FILE_TYPE_DISK, FileAttributeTagInfo, FileDispositionInfo, FileIdInfo,
            FileStandardInfo, GetFileInformationByHandleEx, GetFileType, OPEN_EXISTING, ReOpenFile,
            SetFileInformationByHandle,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use crate::{
    HostError, HostResult, package_profile::portable_path, windows_security::PrivateSecurity,
};

pub(crate) type Identity = (u64, [u8; 16]);

struct Entry {
    identity: Identity,
    directory: bool,
    length: u64,
}

fn raw(file: &File) -> HANDLE {
    file.as_raw_handle().cast()
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn checked(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn file(handle: HANDLE) -> io::Result<File> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // Each caller transfers one newly opened, synchronous file handle.
        Ok(unsafe { File::from_raw_handle(handle.cast()) })
    }
}

fn information<T: Default>(file: &File, class: i32) -> io::Result<T> {
    let mut value = T::default();
    // Callers pair each information class with its exact Windows structure.
    checked(unsafe {
        GetFileInformationByHandleEx(
            raw(file),
            class,
            (&mut value as *mut T).cast(),
            size_of::<T>() as u32,
        )
    })?;
    Ok(value)
}

fn entry(file: &File) -> io::Result<Entry> {
    if unsafe { GetFileType(raw(file)) } != FILE_TYPE_DISK {
        return Err(invalid("expected a disk file or directory"));
    }
    let attributes: FILE_ATTRIBUTE_TAG_INFO = information(file, FileAttributeTagInfo)?;
    let standard: FILE_STANDARD_INFO = information(file, FileStandardInfo)?;
    if attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || standard.DeletePending
        || standard.EndOfFile < 0
        || standard.Directory != (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0)
        || (!standard.Directory && standard.NumberOfLinks != 1)
    {
        return Err(invalid("unsafe file-system entry"));
    }
    let id: FILE_ID_INFO = information(file, FileIdInfo)?;
    Ok(Entry {
        identity: (id.VolumeSerialNumber, id.FileId.Identifier),
        directory: standard.Directory,
        length: standard.EndOfFile as u64,
    })
}

pub(crate) fn identity(file: &File) -> HostResult<Identity> {
    entry(file)
        .map(|entry| entry.identity)
        .map_err(|_| HostError::CaptureFailed)
}

fn child_name(name: &OsStr) -> io::Result<Vec<u16>> {
    let value: Vec<_> = name.encode_wide().collect();
    if value.is_empty()
        || value == [46]
        || value == [46, 46]
        || value
            .iter()
            .any(|unit| *unit < 32 || matches!(*unit, 34 | 42 | 47 | 58 | 60 | 62 | 63 | 92 | 124))
        || value.last().is_some_and(|unit| matches!(*unit, 32 | 46))
        || value.len() > (u16::MAX as usize) / 2
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid child name",
        ));
    }
    let stem = value.split(|unit| *unit == 46).next().unwrap();
    let stem: Vec<_> = stem
        .iter()
        .map(|unit| match unit {
            97..=122 => unit - 32,
            _ => *unit,
        })
        .collect();
    if [b"CON".as_slice(), b"PRN", b"AUX", b"NUL"]
        .iter()
        .any(|device| {
            stem.iter()
                .copied()
                .eq(device.iter().map(|unit| *unit as u16))
        })
        || (stem.len() == 4
            && matches!(stem[3], 49..=57)
            && [b"COM".as_slice(), b"LPT"].iter().any(|prefix| {
                stem[..3]
                    .iter()
                    .copied()
                    .eq(prefix.iter().map(|unit| *unit as u16))
            }))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "reserved child name",
        ));
    }
    Ok(value)
}

fn open_at(
    parent: &File,
    name: &OsStr,
    directory: Option<bool>,
    create: bool,
    delete: bool,
) -> io::Result<File> {
    if !entry(parent)?.directory {
        return Err(invalid("expected a held parent directory"));
    }
    let mut name = child_name(name)?;
    let string = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let security = create
        .then(|| {
            PrivateSecurity::for_mode(if directory == Some(true) {
                0o700
            } else {
                0o600
            })
        })
        .transpose()?;
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: raw(parent),
        ObjectName: &string,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: security
            .as_ref()
            .map_or(null(), |value| value.pointer().cast()),
        SecurityQualityOfService: null(),
    };
    let access = FILE_GENERIC_READ
        | if create { FILE_GENERIC_WRITE } else { 0 }
        | if delete { DELETE } else { 0 };
    let kind = match directory {
        Some(true) => FILE_DIRECTORY_FILE,
        Some(false) => FILE_NON_DIRECTORY_FILE,
        None => 0,
    };
    let mut handle = null_mut();
    let mut status = IO_STATUS_BLOCK::default();
    // Synchronous IO keeps the name, attributes and status storage alive through
    // completion. No intermediate path lookup can follow an unheld ancestor.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status,
            null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | if delete { 0 } else { FILE_SHARE_DELETE },
            if create { FILE_CREATE } else { FILE_OPEN },
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | kind,
            null(),
            0,
        )
    };
    if result < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    let file = file(handle)?;
    let observed = entry(&file)?;
    if directory.is_some_and(|expected| expected != observed.directory) {
        return Err(invalid("file-system entry kind changed"));
    }
    Ok(file)
}

pub(crate) fn create_directory(parent: &File, name: &OsStr) -> io::Result<()> {
    open_at(parent, name, Some(true), true, false).map(|_| ())
}

pub(crate) fn create_file(parent: &File, name: &OsStr) -> io::Result<File> {
    open_at(parent, name, Some(false), true, false)
}

pub(crate) fn set_mode(file: &File, mode: u32) -> io::Result<()> {
    let _ = entry(file)?;
    PrivateSecurity::for_mode(mode)?.apply_to(file)
}

fn optional(parent: &File, name: &OsStr, directory: bool) -> io::Result<Option<File>> {
    match open_at(parent, name, Some(directory), false, false) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn open_optional_file(parent: &File, name: &OsStr) -> io::Result<Option<File>> {
    optional(parent, name, false)
}

pub(crate) fn open_optional_directory(parent: &File, name: &OsStr) -> io::Result<Option<File>> {
    optional(parent, name, true)
}

pub(crate) fn open_entry(parent: &File, name: &OsStr) -> HostResult<File> {
    open_at(parent, name, None, false, false).map_err(|_| HostError::PackagePath)
}

pub(crate) fn open_child(parent: &File, name: &OsStr, directory: bool) -> HostResult<File> {
    open_at(parent, name, Some(directory), false, false).map_err(|_| HostError::PackagePath)
}

pub(crate) fn open_directory(path: &Path) -> HostResult<(PathBuf, File)> {
    let mut parts = path.components();
    let drive = match parts.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) if drive.is_ascii_alphabetic() => {
                drive
            }
            _ => return Err(HostError::PackagePath),
        },
        _ => return Err(HostError::PackagePath),
    };
    if !matches!(parts.next(), Some(Component::RootDir)) {
        return Err(HostError::PackagePath);
    }
    let root: Vec<_> = format!(r"\\?\{}:\", drive as char)
        .encode_utf16()
        .chain([0])
        .collect();
    let mut held = file(unsafe {
        CreateFileW(
            root.as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    })
    .map_err(|_| HostError::CaptureFailed)?;
    if !entry(&held).map_err(|_| HostError::PackagePath)?.directory {
        return Err(HostError::PackagePath);
    }
    let mut count = 0;
    for part in parts {
        let Component::Normal(name) = part else {
            return Err(HostError::PackagePath);
        };
        count += 1;
        if count > 128 {
            return Err(HostError::PackagePath);
        }
        held = open_child(&held, name, true)?;
    }
    if count == 0 {
        return Err(HostError::PackagePath);
    }
    Ok((path.to_owned(), held))
}

pub(crate) fn verify_private_directory(file: &File, expected: Identity) -> HostResult<()> {
    let observed = entry(file).map_err(|_| HostError::StageFailed)?;
    if !observed.directory
        || observed.identity != expected
        || !PrivateSecurity::matches(file, Some(0o700)).map_err(|_| HostError::StageFailed)?
    {
        return Err(HostError::StageFailed);
    }
    Ok(())
}

pub(crate) fn verify_owned_file(
    file: &File,
    expected: Identity,
    mode: Option<u32>,
) -> HostResult<u64> {
    let observed = entry(file).map_err(|_| HostError::StageFailed)?;
    if observed.directory
        || observed.identity != expected
        || !PrivateSecurity::matches(file, mode).map_err(|_| HostError::StageFailed)?
    {
        return Err(HostError::StageFailed);
    }
    Ok(observed.length)
}

pub(crate) fn remove_recorded_child(
    parent: &File,
    name: &OsStr,
    directory: bool,
    expected: Identity,
) -> io::Result<()> {
    // This handle requests DELETE while denying FILE_SHARE_DELETE: successful
    // opening locks this exact object against namespace replacement until the
    // identity check and handle-relative disposition have both completed.
    let held = open_at(parent, name, Some(directory), false, true)?;
    if entry(&held)?.identity != expected {
        return Err(invalid("owned file-system identity changed"));
    }
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    checked(unsafe {
        SetFileInformationByHandle(
            raw(&held),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    })
}

fn record(buffer: &[u8], position: usize) -> io::Result<(String, Option<usize>)> {
    const HEADER: usize = offset_of!(FILE_NAMES_INFORMATION, FileName);
    let data = buffer
        .get(position..)
        .ok_or_else(|| invalid("invalid directory record"))?;
    if data.len() < HEADER {
        return Err(invalid("truncated directory record"));
    }
    let next = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    let length = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    let end = HEADER
        .checked_add(length)
        .ok_or_else(|| invalid("invalid directory name length"))?;
    if length == 0
        || length % 2 != 0
        || end > data.len()
        || (next != 0 && (next < end || next % 4 != 0 || next > data.len()))
        || (next == 0 && data.len() - end > 7)
    {
        return Err(invalid("invalid directory record bounds"));
    }
    let units: Vec<_> = data[HEADER..end]
        .chunks_exact(2)
        .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
        .collect();
    let name = String::from_utf16(&units).map_err(|_| invalid("directory name is not Unicode"))?;
    Ok((name, (next != 0).then(|| position + next)))
}

pub(crate) fn directory_names(
    directory: &File,
    check: impl Fn() -> HostResult<()>,
    max_entries: usize,
) -> HostResult<Vec<String>> {
    check()?;
    let observed = entry(directory).map_err(|_| HostError::CaptureFailed)?;
    if !observed.directory {
        return Err(HostError::PackagePath);
    }
    // ReOpenFile addresses the held object, not a path, and creates an
    // independent synchronous directory cursor instead of duplicating one.
    let reader = file(unsafe {
        ReOpenFile(
            raw(directory),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_FLAG_BACKUP_SEMANTICS,
        )
    })
    .map_err(|_| HostError::CaptureFailed)?;
    if identity(&reader)? != observed.identity {
        return Err(HostError::PackageChanged);
    }
    let mut storage = vec![0u64; 8192];
    let capacity = std::mem::size_of_val(storage.as_slice());
    let mut result = Vec::new();
    let mut folded = BTreeSet::new();
    let mut restart = true;
    loop {
        check()?;
        let mut status = IO_STATUS_BLOCK::default();
        let returned = unsafe {
            NtQueryDirectoryFile(
                raw(&reader),
                null_mut(),
                None,
                null(),
                &mut status,
                storage.as_mut_ptr().cast(),
                capacity as u32,
                FileNamesInformation,
                false,
                null(),
                restart,
            )
        };
        restart = false;
        if returned == STATUS_NO_MORE_FILES {
            break;
        }
        if returned != 0 || status.Information == 0 || status.Information > capacity {
            return Err(HostError::CaptureFailed);
        }
        // Only the bytes the kernel marked valid may supply record lengths.
        let bytes = unsafe {
            std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), status.Information)
        };
        let mut position = 0;
        loop {
            check()?;
            let (name, next) = record(bytes, position).map_err(|_| HostError::CaptureFailed)?;
            if name != "." && name != ".." {
                portable_path(&name)?;
                if !folded.insert(name.to_ascii_lowercase()) {
                    return Err(HostError::PackagePath);
                }
                result.push(name);
                if result.len() > max_entries {
                    return Err(HostError::PackageLimit);
                }
            }
            match next {
                Some(next) => position = next,
                None => break,
            }
        }
    }
    check()?;
    result.sort();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        fs,
        io::{Read, Write},
        os::windows::fs::symlink_dir,
    };
    use tempfile::TempDir;

    fn fixture() -> (TempDir, File, File) {
        let temporary = tempfile::tempdir().unwrap();
        let (_, parent) = open_directory(temporary.path()).unwrap();
        create_directory(&parent, OsStr::new("owned")).unwrap();
        let owned = open_child(&parent, OsStr::new("owned"), true).unwrap();
        (temporary, parent, owned)
    }

    #[test]
    fn creates_private_files_and_directories_and_validates_exact_modes() {
        let (_temporary, _parent, owned) = fixture();
        let directory_id = identity(&owned).unwrap();
        verify_private_directory(&owned, directory_id).unwrap();
        let mut data = create_file(&owned, OsStr::new("data.bin")).unwrap();
        data.write_all(b"owned contents").unwrap();
        data.sync_all().unwrap();
        let id = identity(&data).unwrap();
        assert_eq!(verify_owned_file(&data, id, Some(0o600)).unwrap(), 14);
        set_mode(&data, 0o400).unwrap();
        verify_owned_file(&data, id, Some(0o400)).unwrap();
        assert!(verify_owned_file(&data, id, Some(0o500)).is_err());
        set_mode(&data, 0o500).unwrap();
        verify_owned_file(&data, id, Some(0o500)).unwrap();
        assert!(verify_owned_file(&data, id, Some(0o400)).is_err());
        set_mode(&data, 0o400).unwrap();
        set_mode(&data, 0o600).unwrap();
        assert!(verify_owned_file(&data, id, Some(0o400)).is_err());
        verify_owned_file(&data, id, None).unwrap();
        assert!(set_mode(&data, 0o777).is_err());
        assert!(verify_owned_file(&owned, directory_id, None).is_err());
        assert!(verify_private_directory(&data, id).is_err());
    }

    #[test]
    fn only_missing_entries_are_optional_and_create_never_replaces() {
        let (_temporary, _parent, owned) = fixture();
        assert!(
            open_optional_file(&owned, OsStr::new("missing"))
                .unwrap()
                .is_none()
        );
        assert!(
            open_optional_directory(&owned, OsStr::new("missing"))
                .unwrap()
                .is_none()
        );
        create_directory(&owned, OsStr::new("directory")).unwrap();
        assert!(open_optional_file(&owned, OsStr::new("directory")).is_err());
        let mut original = create_file(&owned, OsStr::new("data.bin")).unwrap();
        original.write_all(b"original").unwrap();
        assert!(create_file(&owned, OsStr::new("data.bin")).is_err());
        assert!(create_directory(&owned, OsStr::new("directory")).is_err());
        let mut contents = String::new();
        open_optional_file(&owned, OsStr::new("data.bin"))
            .unwrap()
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert_eq!(contents, "original");
        assert!(open_optional_directory(&owned, OsStr::new("data.bin")).is_err());
        for name in [
            "../escape",
            "..",
            ".",
            "file:stream",
            "NUL",
            "COM1.txt",
            "trailing.",
        ] {
            assert!(open_optional_file(&owned, OsStr::new(name)).is_err());
            assert!(create_file(&owned, OsStr::new(name)).is_err());
        }
    }

    #[test]
    fn enumeration_has_independent_cursors_limits_and_live_cancellation() {
        let (_temporary, _parent, owned) = fixture();
        create_file(&owned, OsStr::new("z.txt")).unwrap();
        create_file(&owned, OsStr::new("a.txt")).unwrap();
        assert_eq!(
            directory_names(&owned, || Ok(()), 2).unwrap(),
            ["a.txt", "z.txt"]
        );
        assert_eq!(
            directory_names(&owned, || Ok(()), 2).unwrap(),
            ["a.txt", "z.txt"]
        );
        assert_eq!(
            directory_names(&owned, || Ok(()), 1),
            Err(HostError::PackageLimit)
        );
        let checks = Cell::new(0);
        assert_eq!(
            directory_names(
                &owned,
                || {
                    checks.set(checks.get() + 1);
                    if checks.get() >= 3 {
                        Err(HostError::AuthorityRevoked)
                    } else {
                        Ok(())
                    }
                },
                2
            ),
            Err(HostError::AuthorityRevoked)
        );
        assert!(checks.get() >= 3);
    }

    #[test]
    fn cleanup_deletes_recorded_objects_but_retains_replacements_and_nonempty_directories() {
        let (temporary, _parent, owned) = fixture();
        let file = create_file(&owned, OsStr::new("original")).unwrap();
        let original_id = identity(&file).unwrap();
        let root = temporary.path().join("owned");
        fs::rename(root.join("original"), root.join("moved")).unwrap();
        let replacement = create_file(&owned, OsStr::new("original")).unwrap();
        assert!(remove_recorded_child(&owned, OsStr::new("original"), false, original_id).is_err());
        assert!(root.join("original").exists());
        assert!(root.join("moved").exists());
        drop(file);
        let replacement_id = identity(&replacement).unwrap();
        remove_recorded_child(&owned, OsStr::new("original"), false, replacement_id).unwrap();
        drop(replacement);
        assert!(!root.join("original").exists());
        create_directory(&owned, OsStr::new("nonempty")).unwrap();
        let directory = open_child(&owned, OsStr::new("nonempty"), true).unwrap();
        let directory_id = identity(&directory).unwrap();
        create_file(&directory, OsStr::new("unknown")).unwrap();
        assert!(remove_recorded_child(&owned, OsStr::new("nonempty"), true, directory_id).is_err());
        assert!(root.join("nonempty/unknown").exists());
    }

    #[test]
    fn hard_links_are_rejected_by_open_verification_and_cleanup() {
        let (temporary, _parent, owned) = fixture();
        let file = create_file(&owned, OsStr::new("original")).unwrap();
        let id = identity(&file).unwrap();
        let root = temporary.path().join("owned");
        fs::hard_link(root.join("original"), root.join("alias")).unwrap();
        assert!(open_entry(&owned, OsStr::new("original")).is_err());
        assert!(verify_owned_file(&file, id, None).is_err());
        assert!(remove_recorded_child(&owned, OsStr::new("original"), false, id).is_err());
        assert!(root.join("alias").exists());
        assert!(root.join("original").exists());
    }

    #[test]
    fn selected_paths_reject_relative_device_and_parent_components() {
        for path in [
            r"relative\directory",
            r"C:relative",
            r"\\server\share\directory",
            r"\\.\pipe\name",
            r"C:\a\..\b",
        ] {
            assert!(matches!(
                open_directory(Path::new(path)),
                Err(HostError::PackagePath)
            ));
        }
        let temporary = tempfile::tempdir().unwrap();
        let unicode = temporary.path().join("資料");
        fs::create_dir(&unicode).unwrap();
        open_directory(&unicode).unwrap();
    }

    #[test]
    #[ignore = "requires Windows symbolic-link privilege or developer mode"]
    fn rejects_reparse_entries_and_selected_reparse_ancestors() {
        let (temporary, _parent, owned) = fixture();
        let target = temporary.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = temporary.path().join("owned/link");
        symlink_dir(&target, &link).unwrap();
        assert!(open_entry(&owned, OsStr::new("link")).is_err());
        assert!(open_optional_directory(&owned, OsStr::new("link")).is_err());
        assert!(open_directory(&link).is_err());
    }

    fn name_record(name: &[u16], next: u32) -> Vec<u8> {
        let mut bytes = next.to_le_bytes().to_vec();
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&((name.len() * 2) as u32).to_le_bytes());
        for unit in name {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn directory_record_parser_rejects_invalid_kernel_lengths_and_offsets() {
        let valid = name_record(&[97], 0);
        assert_eq!(record(&valid, 0).unwrap(), ("a".into(), None));
        assert!(record(&valid[..11], 0).is_err());
        assert!(record(&name_record(&[0xd800], 0), 0).is_err());
        for offset in [1, 4, 15, 1024] {
            assert!(record(&name_record(&[97], offset), 0).is_err());
        }
        let mut odd = valid.clone();
        odd[8..12].copy_from_slice(&1u32.to_le_bytes());
        assert!(record(&odd, 0).is_err());
        let mut excess = valid.clone();
        excess.extend_from_slice(&[0; 8]);
        assert!(record(&excess, 0).is_err());
        let mut first = name_record(&[97], 16);
        first.extend_from_slice(&[0; 2]);
        first.extend_from_slice(&name_record(&[98], 0));
        assert_eq!(record(&first, 0).unwrap(), ("a".into(), Some(16)));
        assert_eq!(record(&first, 16).unwrap(), ("b".into(), None));
    }
}
