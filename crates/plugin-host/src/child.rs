//! One process lifetime owner shared by component and application-member channels.
use std::{
    ffi::{OsStr, OsString},
    io,
    path::{Path, PathBuf},
    pin::Pin,
    process::ExitStatus,
};

use tokio::io::{AsyncRead, AsyncWrite};

#[cfg(unix)]
#[path = "child/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "child/windows.rs"]
mod platform;

pub(crate) type ChildReader = Pin<Box<dyn AsyncRead + Send>>;
pub(crate) type ChildWriter = Pin<Box<dyn AsyncWrite + Send>>;

/// Captured program paths and arguments only. Environment inheritance and
/// arbitrary inherited handles are intentionally not configurable here.
pub(crate) struct ChildCommand {
    program: OsString,
    arguments: Vec<OsString>,
    directory: Option<PathBuf>,
}

impl ChildCommand {
    pub(crate) fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_owned(),
            arguments: Vec::new(),
            directory: None,
        }
    }

    pub(crate) fn arg(&mut self, argument: impl AsRef<OsStr>) -> &mut Self {
        self.arguments.push(argument.as_ref().to_owned());
        self
    }

    pub(crate) fn current_dir(&mut self, directory: impl AsRef<Path>) -> &mut Self {
        self.directory = Some(directory.as_ref().to_owned());
        self
    }
}

/// Creation transfers every process and pipe handle to this value. On Windows,
/// the leader is already in its private Job but remains suspended until `start`.
/// A returned exit status also confirms that this Job contains no live process.
/// Unix preserves its existing direct-child reap and owned process-group policy.
pub(crate) struct OwnedChild {
    process: platform::Process,
    pub(crate) stdin: Option<ChildWriter>,
    pub(crate) stdout: Option<ChildReader>,
    pub(crate) stderr: Option<ChildReader>,
}

impl OwnedChild {
    pub(crate) fn spawn(command: &ChildCommand) -> io::Result<Self> {
        platform::spawn(command)
    }

    /// The caller must first attach its retained staged-directory lease and
    /// recheck the original authorization. This does not create authority.
    pub(crate) fn start(&mut self) -> io::Result<()> {
        self.process.start()
    }

    pub(crate) fn id(&self) -> Option<u32> {
        self.process.id()
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.process.try_wait()
    }

    pub(crate) async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.process.wait().await
    }

    pub(crate) fn kill_tree(&mut self) -> io::Result<()> {
        self.process.kill_tree()
    }
}
