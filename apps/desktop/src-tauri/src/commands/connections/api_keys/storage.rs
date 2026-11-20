use super::*;

#[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
use super::super::secure_storage::{IdentityError, InstallationIdentity};

#[cfg(target_os = "macos")]
#[path = "storage/macos.rs"]
mod native;
#[cfg(all(windows, target_arch = "x86_64"))]
#[path = "storage/windows.rs"]
mod native;

pub(super) fn validate_key(secret: &str) -> Result<(), ExecutionError> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    native::validate_size(secret)?;
    if !valid_key(secret) {
        return Err(fail(ErrorCode::InvalidInput, "api-key-value"));
    }
    Ok(())
}

pub(super) struct SystemStorage {
    #[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
    installation: InstallationIdentity,
}

impl SystemStorage {
    pub(super) fn new(_directory: &Path) -> Self {
        Self {
            #[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
            installation: InstallationIdentity::new(_directory, "api-keys.lock"),
        }
    }

    #[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
    fn host(&self, create: bool) -> Result<Option<ExecutionId>, ExecutionError> {
        self.installation.host(create).map_err(|error| match error {
            IdentityError::Busy => fail(ErrorCode::Busy, "api-key-owner"),
            IdentityError::Unavailable => storage_error(),
        })
    }
}

#[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
impl CredentialStorage for SystemStorage {
    fn supported(&self) -> bool {
        true
    }

    fn read(&self, reference: ExecutionId) -> Result<Option<String>, ExecutionError> {
        let Some(host) = self.host(false)? else {
            return Ok(None);
        };
        native::with_entry(host, reference, |entry| entry.read())
    }

    fn create(&self, reference: ExecutionId, secret: &str) -> Result<(), ExecutionError> {
        validate_key(secret)?;

        let host = self.host(true)?.ok_or_else(storage_error)?;
        native::with_entry(host, reference, |entry| match entry.read()? {
            Some(saved) if saved == secret => Ok(()),
            Some(_) => Err(fail(
                ErrorCode::DependencyConflict,
                "api-key-reference-changed",
            )),
            None => entry.write(secret),
        })
    }

    fn delete(&self, reference: ExecutionId) -> Result<(), ExecutionError> {
        let Some(host) = self.host(false)? else {
            return Ok(());
        };
        native::with_entry(host, reference, |entry| entry.delete())
    }
}

#[cfg(not(any(target_os = "macos", all(windows, target_arch = "x86_64"))))]
impl CredentialStorage for SystemStorage {
    fn supported(&self) -> bool {
        false
    }

    fn read(&self, _reference: ExecutionId) -> Result<Option<String>, ExecutionError> {
        Err(fail(ErrorCode::Unauthorized, "api-key-platform"))
    }

    fn create(&self, _reference: ExecutionId, secret: &str) -> Result<(), ExecutionError> {
        validate_key(secret)?;
        Err(fail(ErrorCode::Unauthorized, "api-key-platform"))
    }

    fn delete(&self, _reference: ExecutionId) -> Result<(), ExecutionError> {
        Err(fail(ErrorCode::Unauthorized, "api-key-platform"))
    }
}
