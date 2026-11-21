//! Read process identity and exit state for this test's staged workers.
use std::{
    ffi::OsString,
    io,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            QueryFullProcessImageNameW, WaitForSingleObject,
        },
    },
};

fn own(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // These APIs return a new, closeable handle on success.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn image(pid: u32) -> io::Result<PathBuf> {
    let process = own(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut executable = vec![0u16; 32_768];
    let mut length = executable.len() as u32;
    let read = unsafe {
        QueryFullProcessImageNameW(
            process.as_raw_handle(),
            0,
            executable.as_mut_ptr(),
            &mut length,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    let path = PathBuf::from(OsString::from_wide(&executable[..length as usize]));
    path.canonicalize()
}

pub(super) fn member_pid(staging: &Path) -> u32 {
    let staging = staging.canonicalize().unwrap();
    let snapshot = own(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }).unwrap();
    let mut row = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut available = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut row) };
    let mut members = Vec::new();
    while available != 0 {
        if row.th32ParentProcessID == std::process::id()
            && let Ok(executable) = image(row.th32ProcessID)
            && executable.starts_with(&staging)
            && executable
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"))
            && let Some(stage) = executable.ancestors().nth(4)
            && stage.join("package/worker.mjs").is_file()
        {
            members.push(row.th32ProcessID);
        }
        available = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut row) };
    }
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(ERROR_NO_MORE_FILES as i32)
    );
    let [member] = members.as_slice() else {
        panic!("expected one owned Pi worker, observed {}", members.len());
    };
    *member
}

pub(super) fn assert_exited(pid: u32) {
    match own(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) }) {
        Ok(process) => assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
            WAIT_OBJECT_0,
            "the owned worker {pid} must have exited"
        ),
        Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {}
        Err(error) => panic!("could not verify exit of the owned worker {pid}: {error}"),
    }
}
