//! Shared process policy and non-secret installation identity for desktop
//! credential owners. Each owner retains its own Keychain service and items.
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tsumugi_core::execution::{ExecutionError, ExecutionId};

#[cfg(target_os = "macos")]
pub(super) fn noninteractive<T>(
    failure: fn() -> ExecutionError,
    operation: impl FnOnce() -> Result<T, ExecutionError>,
) -> Result<T, ExecutionError> {
    use security_framework::os::macos::keychain::SecKeychain;
    // Keychain interaction policy is process-wide, including legacy queries.
    static OPERATIONS: Mutex<()> = Mutex::new(());
    let _operation = OPERATIONS.lock().map_err(|_| failure())?;
    let allowed = SecKeychain::user_interaction_allowed().map_err(|_| failure())?;
    let interaction = if allowed {
        Some(SecKeychain::disable_user_interaction().map_err(|_| failure())?)
    } else {
        None
    };
    let result = operation();
    drop(interaction);
    if SecKeychain::user_interaction_allowed().map_err(|_| failure())? != allowed {
        return Err(failure());
    }
    result
}

pub(super) enum IdentityError {
    Busy,
    Unavailable,
}
struct Lease {
    _file: File,
    host: ExecutionId,
}
pub(super) struct InstallationIdentity {
    directory: PathBuf,
    filename: &'static str,
    lease: Mutex<Option<Lease>>,
}
impl InstallationIdentity {
    pub(super) fn new(directory: &Path, filename: &'static str) -> Self {
        Self {
            directory: directory.into(),
            filename,
            lease: Mutex::new(None),
        }
    }
    pub(super) fn host(&self, create: bool) -> Result<Option<ExecutionId>, IdentityError> {
        let mut lease = self.lease.lock().map_err(|_| IdentityError::Unavailable)?;
        if let Some(lease) = lease.as_ref() {
            return Ok(Some(lease.host));
        }
        if create {
            std::fs::create_dir_all(&self.directory).map_err(|_| IdentityError::Unavailable)?;
        }
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(create)
            .truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(self.directory.join(self.filename)) {
            Ok(file) => file,
            Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(_) => return Err(IdentityError::Unavailable),
        };
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => IdentityError::Busy,
            std::fs::TryLockError::Error(_) => IdentityError::Unavailable,
        })?;
        // Only this opaque identity is written to disk; never a credential.
        let mut raw = String::new();
        (&mut file)
            .take(65)
            .read_to_string(&mut raw)
            .map_err(|_| IdentityError::Unavailable)?;
        let host = if raw.is_empty() && create {
            let host = ExecutionId::new();
            file.seek(SeekFrom::Start(0))
                .map_err(|_| IdentityError::Unavailable)?;
            file.write_all(host.to_string().as_bytes())
                .map_err(|_| IdentityError::Unavailable)?;
            file.sync_all().map_err(|_| IdentityError::Unavailable)?;
            host
        } else {
            ExecutionId::parse(&raw).map_err(|_| IdentityError::Unavailable)?
        };
        *lease = Some(Lease { _file: file, host });
        Ok(Some(host))
    }
}
