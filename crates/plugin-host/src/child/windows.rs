//! A suspended leader is admitted to its private Job at process creation.
//! Job ownership controls lifetime; it does not restrict the user's OS access.
use std::{
    ffi::{OsStr, c_void},
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::Path,
    process::ExitStatus,
    ptr::{null, null_mut},
    time::Duration,
};

use tokio::net::windows::named_pipe::NamedPipeServer;
use windows_sys::Win32::{
    Foundation::{
        ERROR_INSUFFICIENT_BUFFER, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ,
        GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
        PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
    },
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        JobObjects::{
            CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
        },
        Threading::{
            CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateEventW, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
            GetCurrentProcessId, GetExitCodeProcess, InitializeProcThreadAttributeList,
            LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcessToken, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, ResumeThread,
            STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

use super::{ChildCommand, ChildReader, ChildWriter, OwnedChild};

pub(super) struct Process {
    process: OwnedHandle,
    thread: Option<OwnedHandle>,
    job: OwnedHandle,
    pid: u32,
    started: bool,
    leader_status: Option<ExitStatus>,
    complete: bool,
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn checked(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn handle(value: HANDLE) -> io::Result<OwnedHandle> {
    if value.is_null() || value == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // Every caller transfers a newly created, non-pseudo handle once.
        Ok(unsafe { OwnedHandle::from_raw_handle(value.cast()) })
    }
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(invalid("process arguments cannot contain NUL"));
    }
    value.push(0);
    Ok(value)
}

/// Quote one argument for the Windows C runtime without lossy Unicode conversion.
/// Quotes receive an escape, and backslashes before quotes or the closing quote
/// are doubled. Every argument is quoted, including empty arguments.
fn quote(argument: &OsStr, output: &mut Vec<u16>) -> io::Result<()> {
    output.push(b'"' as u16);
    let mut slashes = 0;
    for unit in argument.encode_wide() {
        match unit {
            0 => return Err(invalid("process arguments cannot contain NUL")),
            92 => slashes += 1,
            34 => {
                output.extend(std::iter::repeat_n(92, slashes * 2 + 1));
                output.push(34);
                slashes = 0;
            }
            other => {
                output.extend(std::iter::repeat_n(92, slashes));
                output.push(other);
                slashes = 0;
            }
        }
    }
    output.extend(std::iter::repeat_n(92, slashes * 2));
    output.push(b'"' as u16);
    Ok(())
}

fn command_line(command: &ChildCommand) -> io::Result<Vec<u16>> {
    if !Path::new(&command.program).is_absolute()
        || command.program.encode_wide().any(|unit| unit == 34)
        || command
            .directory
            .as_ref()
            .is_some_and(|directory| !directory.is_absolute())
    {
        return Err(invalid("process paths must be absolute"));
    }
    let mut output = Vec::new();
    quote(&command.program, &mut output)?;
    for argument in &command.arguments {
        output.push(b' ' as u16);
        quote(argument, &mut output)?;
    }
    output.push(0);
    if output.len() > 32_767 {
        return Err(invalid("process command line exceeds the Windows limit"));
    }
    Ok(output)
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

/// Only this process token's user can open the unnamed Job and named pipes.
/// The protected DACL prevents inheritance from broad directory/object defaults.
struct PrivateSecurity(LocalAllocation);
impl PrivateSecurity {
    fn new() -> io::Result<Self> {
        let mut token = null_mut();
        checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        let token = handle(token)?;
        let mut needed = 0;
        let initial =
            unsafe { GetTokenInformation(raw(&token), TokenUser, null_mut(), 0, &mut needed) };
        if initial != 0
            || io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
            || needed == 0
            || needed > 1024 * 1024
        {
            return Err(invalid("invalid process token user information"));
        }
        // TOKEN_USER contains pointers, so its storage must be pointer-aligned.
        let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        checked(unsafe {
            GetTokenInformation(
                raw(&token),
                TokenUser,
                storage.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        })?;
        let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
        let mut sid = null_mut();
        checked(unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) })?;
        let sid_memory = LocalAllocation(sid.cast());
        // ConvertSidToStringSidW guarantees a NUL-terminated SID string. A SID
        // has at most 15 subauthorities, comfortably within this bound.
        let length = (0..256)
            .find(|index| unsafe { *sid.add(*index) == 0 })
            .ok_or_else(|| invalid("invalid process token SID"))?;
        let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(sid, length) })
            .map_err(|_| invalid("invalid process token SID"))?;
        drop(sid_memory);
        let descriptor = wide(OsStr::new(&format!("D:P(A;;GA;;;{sid})")))?;
        let mut security = null_mut();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                SDDL_REVISION_1,
                &mut security,
                null_mut(),
            )
        })?;
        Ok(Self(LocalAllocation(security)))
    }

    fn attributes(&self, inherit: bool) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: i32::from(inherit),
        }
    }
}

fn pipe(security: &PrivateSecurity, input: bool) -> io::Result<(NamedPipeServer, OwnedHandle)> {
    let name = wide(OsStr::new(&format!(
        r"\\.\pipe\tsumugi-process-{}",
        uuid::Uuid::new_v4()
    )))?;
    let parent_attributes = security.attributes(false);
    let server = handle(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            if input {
                PIPE_ACCESS_OUTBOUND
            } else {
                PIPE_ACCESS_INBOUND
            } | FILE_FLAG_OVERLAPPED
                | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            64 * 1024,
            64 * 1024,
            0,
            &parent_attributes,
        )
    })?;
    let child_attributes = security.attributes(true);
    let child = handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            if input { GENERIC_READ } else { GENERIC_WRITE },
            0,
            &child_attributes,
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    })?;
    let event = handle(unsafe { CreateEventW(null(), 1, 0, null()) })?;
    let mut overlapped = OVERLAPPED {
        hEvent: raw(&event),
        ..Default::default()
    };
    if unsafe { ConnectNamedPipe(raw(&server), &mut overlapped) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
            // The local client is already open; no pending connection is
            // expected. Complete cancellation before its OVERLAPPED goes away.
            unsafe { CancelIoEx(raw(&server), &overlapped) };
            let mut transferred = 0;
            unsafe { GetOverlappedResult(raw(&server), &overlapped, &mut transferred, 1) };
            return Err(error);
        }
        if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
            return Err(error);
        }
    }
    let mut client_pid = 0;
    checked(unsafe { GetNamedPipeClientProcessId(raw(&server), &mut client_pid) })?;
    if client_pid != unsafe { GetCurrentProcessId() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "process pipe client identity changed",
        ));
    }
    // Tokio consumes this sole handle owner even if IO registration fails.
    let parent = unsafe { NamedPipeServer::from_raw_handle(server.into_raw_handle()) }?;
    Ok((parent, child))
}

struct Attributes {
    storage: Vec<usize>,
}
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut needed = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut needed) };
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; needed.div_ceil(size_of::<usize>())];
        checked(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut needed)
        })?;
        Ok(Self { storage })
    }

    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }

    fn handles(&mut self, attribute: u32, handles: &[HANDLE]) -> io::Result<()> {
        checked(unsafe {
            UpdateProcThreadAttribute(
                self.pointer(),
                0,
                attribute as usize,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                null_mut(),
                null(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

pub(super) fn spawn(command: &ChildCommand) -> io::Result<OwnedChild> {
    let application = wide(&command.program)?;
    let mut arguments = command_line(command)?;
    let directory = command
        .directory
        .as_ref()
        .map(|directory| wide(directory.as_os_str()))
        .transpose()?;
    let security = PrivateSecurity::new()?;
    let job_attributes = security.attributes(false);
    let job = handle(unsafe { CreateJobObjectW(&job_attributes, null()) })?;
    let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        BasicLimitInformation:
            windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_LIMIT_INFORMATION {
                // No BREAKAWAY_OK or SILENT_BREAKAWAY_OK: descendants stay owned.
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
        ..Default::default()
    };
    checked(unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    })?;
    let (stdin, child_stdin) = pipe(&security, true)?;
    let (stdout, child_stdout) = pipe(&security, false)?;
    let (stderr, child_stderr) = pipe(&security, false)?;
    let stdin = Some(Box::pin(stdin) as ChildWriter);
    let stdout = Some(Box::pin(stdout) as ChildReader);
    let stderr = Some(Box::pin(stderr) as ChildReader);
    let inherited = [raw(&child_stdin), raw(&child_stdout), raw(&child_stderr)];
    let jobs = [raw(&job)];
    let mut attributes = Attributes::new()?;
    attributes.handles(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited)?;
    attributes.handles(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes.pointer();
    let mut created = PROCESS_INFORMATION::default();
    let environment = [0u16, 0];
    checked(unsafe {
        CreateProcessW(
            application.as_ptr(),
            arguments.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            directory.as_ref().map_or(null(), |path| path.as_ptr()),
            &startup.StartupInfo,
            &mut created,
        )
    })?;
    // CreateProcessW succeeded: no subsequent operation may return an ordinary
    // error and lose the caller's opportunity to attach its stage lease.
    Ok(OwnedChild {
        process: Process {
            process: unsafe { OwnedHandle::from_raw_handle(created.hProcess.cast()) },
            thread: Some(unsafe { OwnedHandle::from_raw_handle(created.hThread.cast()) }),
            job,
            pid: created.dwProcessId,
            started: false,
            leader_status: None,
            complete: false,
        },
        stdin,
        stdout,
        stderr,
    })
}

impl Process {
    pub(super) fn start(&mut self) -> io::Result<()> {
        if self.started {
            return Ok(());
        }
        if self.complete {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "process already exited",
            ));
        }
        let mut admitted = 0;
        checked(unsafe { IsProcessInJob(raw(&self.process), raw(&self.job), &mut admitted) })?;
        if admitted == 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process Job admission failed",
            ));
        }
        let previous = unsafe { ResumeThread(raw(self.thread.as_ref().unwrap())) };
        if previous == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        if previous != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process suspension state changed",
            ));
        }
        self.started = true;
        self.thread.take();
        Ok(())
    }

    pub(super) fn id(&self) -> Option<u32> {
        (!self.complete).then_some(self.pid)
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.complete {
            return Ok(self.leader_status);
        }
        if self.leader_status.is_none() {
            match unsafe { WaitForSingleObject(raw(&self.process), 0) } {
                WAIT_TIMEOUT => return Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    checked(unsafe { GetExitCodeProcess(raw(&self.process), &mut code) })?;
                    self.leader_status = Some(ExitStatus::from_raw(code));
                }
                _ => return Err(io::Error::last_os_error()),
            }
        }
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        checked(unsafe {
            QueryInformationJobObject(
                raw(&self.job),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        })?;
        if accounting.ActiveProcesses != 0 {
            return Ok(None);
        }
        self.complete = true;
        self.thread.take();
        Ok(self.leader_status)
    }

    pub(super) async fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            // No detached blocking waiter survives cancellation of this future.
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub(super) fn kill_tree(&mut self) -> io::Result<()> {
        if self.complete {
            return Ok(());
        }
        checked(unsafe { TerminateJobObject(raw(&self.job), 1) })
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.kill_tree();
        // Closing the sole private Job handle is the final kill-on-close guard.
        // Drop does not assert that termination has already been observed.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::windows::{ffi::OsStringExt, process::CommandExt},
        path::PathBuf,
        process::Stdio,
    };
    use tokio::time::{Instant, timeout};
    use windows_sys::Win32::{
        Foundation::ERROR_ACCESS_DENIED,
        System::Threading::{
            CREATE_BREAKAWAY_FROM_JOB, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    };

    struct Fixture(String);
    impl Fixture {
        fn new() -> Self {
            Self(format!("owned-child-{}", uuid::Uuid::new_v4()))
        }

        fn path(&self, kind: &str) -> PathBuf {
            std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .join(format!(".{}-{kind}", self.0))
        }

        fn command(&self, name: &str) -> ChildCommand {
            let mut command = ChildCommand::new(std::env::current_exe().unwrap());
            for argument in fixture_arguments(name, &self.0) {
                command.arg(argument);
            }
            command
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for kind in ["entered", "descendant", "descendant-entered", "breakaway"] {
                let _ = fs::remove_file(self.path(kind));
            }
        }
    }

    fn fixture_arguments(name: &str, nonce: &str) -> Vec<String> {
        let module = module_path!().split_once("::").unwrap().1;
        vec![
            "--exact".into(),
            format!("{module}::{name}"),
            "--ignored".into(),
            "--nocapture".into(),
            // A nonmatching skip filter passes fixture data without granting
            // the process any environment inheritance or test-only spawn API.
            "--skip".into(),
            nonce.into(),
        ]
    }

    fn running_fixture() -> Fixture {
        let nonce = std::env::args()
            .find(|argument| argument.starts_with("owned-child-"))
            .expect("fixture nonce");
        Fixture(nonce)
    }

    async fn until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "fixture did not reach its expected state"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[test]
    fn quotes_empty_whitespace_quotes_and_trailing_backslashes() {
        for (input, expected) in [
            ("", "\"\""),
            ("a b", "\"a b\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
            ("a\\", "\"a\\\\\""),
        ] {
            let mut encoded = Vec::new();
            quote(OsStr::new(input), &mut encoded).unwrap();
            assert_eq!(String::from_utf16(&encoded).unwrap(), expected);
        }
        let mut encoded = Vec::new();
        assert!(quote(OsStr::new("a\0b"), &mut encoded).is_err());
        let surrogate = std::ffi::OsString::from_wide(&[0xd800]);
        let mut encoded = Vec::new();
        quote(&surrogate, &mut encoded).unwrap();
        assert_eq!(encoded, [34, 0xd800, 34]);
    }

    #[tokio::test]
    async fn admission_is_suspended_and_start_preserves_arguments_and_empty_environment() {
        let fixture = Fixture::new();
        let mut command = fixture.command("fixture_marks_and_exits");
        let argument = r#"spaces and \"quotes\" with trailing slash\"#;
        command.arg("--skip").arg(argument);
        let mut child = OwnedChild::spawn(&command).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!fixture.path("entered").exists());
        assert!(child.try_wait().unwrap().is_none());
        child.start().unwrap();
        child.start().unwrap();
        assert!(
            timeout(Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert!(child.id().is_none());
        let observed = fs::read(fixture.path("entered")).unwrap();
        let mut expected = 0u64.to_le_bytes().to_vec();
        for argument in &command.arguments {
            let encoded: Vec<_> = argument.encode_wide().collect();
            expected.extend_from_slice(&(encoded.len() as u64).to_le_bytes());
            for unit in encoded {
                expected.extend_from_slice(&unit.to_le_bytes());
            }
        }
        assert_eq!(observed, expected);
    }

    #[tokio::test]
    async fn captured_pipes_transfer_exact_bytes_in_both_directions() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let fixture = Fixture::new();
        let mut command = fixture.command("fixture_echoes_pipes");
        command.current_dir(std::env::current_exe().unwrap().parent().unwrap());
        let mut child = OwnedChild::spawn(&command).unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let mut diagnostic = child.stderr.take().unwrap();
        child.start().unwrap();
        let bytes = "\0exact 世界 👩🏽‍💻 é\r\n".as_bytes();
        timeout(Duration::from_secs(10), async {
            input.write_all(bytes).await.unwrap();
            input.flush().await.unwrap();
            drop(input);
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            tokio::try_join!(
                output.read_to_end(&mut stdout),
                diagnostic.read_to_end(&mut stderr)
            )
            .unwrap();
            assert!(child.wait().await.unwrap().success());
            // The Rust test harness prints a prefix before entering its fixture;
            // the fixture flushes this exact suffix and exits without more output.
            assert!(stdout.ends_with(bytes));
            assert_eq!(stderr, bytes);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn revoked_suspended_creation_can_be_killed_without_running_entrypoint() {
        let fixture = Fixture::new();
        let mut child = OwnedChild::spawn(&fixture.command("fixture_marks_and_exits")).unwrap();
        child.kill_tree().unwrap();
        let _ = timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!fixture.path("entered").exists());
        assert!(child.id().is_none());
        assert!(child.start().is_err());
    }

    #[tokio::test]
    async fn leader_exit_does_not_confirm_cleanup_while_a_descendant_remains() {
        let fixture = Fixture::new();
        let mut child = OwnedChild::spawn(&fixture.command("fixture_leaves_descendant")).unwrap();
        child.start().unwrap();
        until(|| {
            assert!(child.try_wait().unwrap().is_none());
            child.process.leader_status.is_some() && fixture.path("descendant-entered").exists()
        })
        .await;
        assert!(child.id().is_some());
        assert!(
            timeout(Duration::from_millis(30), child.wait())
                .await
                .is_err()
        );
        child.kill_tree().unwrap();
        assert!(
            timeout(Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert!(child.id().is_none());
    }

    #[tokio::test]
    async fn dropping_the_owner_terminates_its_live_descendant() {
        let fixture = Fixture::new();
        let mut child = OwnedChild::spawn(&fixture.command("fixture_leaves_descendant")).unwrap();
        child.start().unwrap();
        until(|| {
            fixture.path("descendant-entered").exists() && fixture.path("descendant").exists()
        })
        .await;
        let pid: u32 = fs::read_to_string(fixture.path("descendant"))
            .unwrap()
            .parse()
            .unwrap();
        let descendant = handle(unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        })
        .unwrap();
        let mut admitted = 0;
        checked(unsafe {
            IsProcessInJob(raw(&descendant), raw(&child.process.job), &mut admitted)
        })
        .unwrap();
        assert_ne!(admitted, 0);
        drop(child);
        until(|| unsafe { WaitForSingleObject(raw(&descendant), 0) } == WAIT_OBJECT_0).await;
    }

    #[tokio::test]
    async fn descendants_cannot_request_breakaway() {
        let fixture = Fixture::new();
        let mut child = OwnedChild::spawn(&fixture.command("fixture_refuses_breakaway")).unwrap();
        child.start().unwrap();
        assert!(
            timeout(Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert_eq!(fs::read(fixture.path("breakaway")).unwrap(), b"denied");
    }

    #[tokio::test]
    async fn invalid_paths_and_failed_creation_return_errors_without_a_child_owner() {
        assert!(OwnedChild::spawn(&ChildCommand::new("relative.exe")).is_err());
        let mut invalid = ChildCommand::new(std::env::current_exe().unwrap());
        invalid.arg("contains\0nul");
        assert!(OwnedChild::spawn(&invalid).is_err());
        let missing = std::env::current_exe()
            .unwrap()
            .with_file_name(format!("{}.exe", uuid::Uuid::new_v4()));
        assert!(OwnedChild::spawn(&ChildCommand::new(missing)).is_err());
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn fixture_marks_and_exits() {
        let fixture = running_fixture();
        let mut observed = (std::env::vars_os().count() as u64).to_le_bytes().to_vec();
        for argument in std::env::args_os().skip(1) {
            let encoded: Vec<_> = argument.encode_wide().collect();
            observed.extend_from_slice(&(encoded.len() as u64).to_le_bytes());
            for unit in encoded {
                observed.extend_from_slice(&unit.to_le_bytes());
            }
        }
        fs::write(fixture.path("entered"), observed).unwrap();
        // The parent owns removal after it has observed this process's exit.
        std::mem::forget(fixture);
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn fixture_echoes_pipes() {
        use std::io::{Read, Write};
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(30));
            std::process::exit(124);
        });
        let mut bytes = Vec::new();
        std::io::stdin().read_to_end(&mut bytes).unwrap();
        std::io::stdout().write_all(&bytes).unwrap();
        std::io::stdout().flush().unwrap();
        std::io::stderr().write_all(&bytes).unwrap();
        std::io::stderr().flush().unwrap();
        std::process::exit(0);
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn fixture_sleeps() {
        let fixture = running_fixture();
        fs::write(fixture.path("descendant-entered"), b"running").unwrap();
        // Also bound a failed test's fixture lifetime if the ownership invariant
        // under test is broken, rather than leaving an endless stray process.
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn fixture_leaves_descendant() {
        let fixture = running_fixture();
        let descendant = std::process::Command::new(std::env::current_exe().unwrap())
            .args(fixture_arguments("fixture_sleeps", &fixture.0))
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        fs::write(fixture.path("descendant"), descendant.id().to_string()).unwrap();
        std::mem::forget(fixture);
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn fixture_refuses_breakaway() {
        let fixture = running_fixture();
        let outcome = std::process::Command::new(std::env::current_exe().unwrap())
            .args(fixture_arguments("fixture_marks_and_exits", &fixture.0))
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
            .spawn();
        let error = match outcome {
            Err(error) => error,
            Ok(mut escaped) => {
                let _ = escaped.kill();
                let _ = escaped.wait();
                panic!("Job permitted a breakaway descendant");
            }
        };
        assert_eq!(error.raw_os_error(), Some(ERROR_ACCESS_DENIED as i32));
        fs::write(fixture.path("breakaway"), b"denied").unwrap();
        std::mem::forget(fixture);
    }
}
