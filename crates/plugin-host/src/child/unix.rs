use std::{io, process::ExitStatus};

use tokio::process::{Child, Command};

use super::{ChildCommand, ChildReader, ChildWriter, OwnedChild};

pub(super) struct Process {
    child: Child,
}

pub(super) fn spawn(command: &ChildCommand) -> io::Result<OwnedChild> {
    use std::{os::unix::process::CommandExt, process::Stdio};

    let mut spawning = Command::new(&command.program);
    spawning.args(&command.arguments);
    if let Some(directory) = &command.directory {
        spawning.current_dir(directory);
    }
    spawning
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    spawning.as_std_mut().process_group(0);
    let mut child = spawning.spawn()?;
    // No fallible operation follows creation: the caller can immediately attach
    // this owner to its staged-directory lease before its next await.
    let stdin = child.stdin.take().map(|pipe| Box::pin(pipe) as ChildWriter);
    let stdout = child
        .stdout
        .take()
        .map(|pipe| Box::pin(pipe) as ChildReader);
    let stderr = child
        .stderr
        .take()
        .map(|pipe| Box::pin(pipe) as ChildReader);
    Ok(OwnedChild {
        process: Process { child },
        stdin,
        stdout,
        stderr,
    })
}

impl Process {
    pub(super) fn start(&mut self) -> io::Result<()> {
        Ok(())
    }

    pub(super) fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub(super) async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }

    pub(super) fn kill_tree(&mut self) -> io::Result<()> {
        // Tokio clears id after reaping. Never signal a numeric process group
        // that may already have been reused by an unrelated process.
        let Some(pid) = self.child.id() else {
            return Ok(());
        };
        let group_error = if unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } == 0 {
            None
        } else {
            let error = io::Error::last_os_error();
            (error.raw_os_error() != Some(libc::ESRCH)).then_some(error)
        };
        // Attempt the direct child even when the group signal failed.
        let direct = self.child.start_kill();
        match group_error {
            Some(error) => Err(error),
            None => direct,
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.kill_tree();
    }
}
