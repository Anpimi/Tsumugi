use super::super::secure_storage::{IdentityError, InstallationIdentity};
use super::*;

pub(super) struct KeychainStorage {
    installation: InstallationIdentity,
}
impl KeychainStorage {
    pub(super) fn new(directory: &Path) -> Self {
        Self {
            installation: InstallationIdentity::new(directory, "api-keys.lock"),
        }
    }
    #[cfg(target_os = "macos")]
    fn host(&self, create: bool) -> Result<Option<ExecutionId>, ExecutionError> {
        self.installation.host(create).map_err(|error| match error {
            IdentityError::Busy => fail(ErrorCode::Busy, "api-key-owner"),
            IdentityError::Unavailable => storage_error(),
        })
    }
    #[cfg(target_os = "macos")]
    fn entry(host: ExecutionId, reference: ExecutionId) -> Result<keyring::Entry, ExecutionError> {
        keyring::Entry::new(
            "app.tsumugi.desktop.api-key",
            &format!("{host}/{reference}"),
        )
        .map_err(|_| storage_error())
    }
    #[cfg(target_os = "macos")]
    fn load(entry: &keyring::Entry) -> Result<Option<String>, ExecutionError> {
        match entry.get_secret() {
            Ok(bytes) if bytes.len() <= MAX_KEY_BYTES => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| storage_error()),
            Err(keyring::Error::NoEntry) => Ok(None),
            _ => Err(storage_error()),
        }
    }
}
impl CredentialStorage for KeychainStorage {
    fn supported(&self) -> bool {
        cfg!(target_os = "macos")
    }
    fn read(&self, reference: ExecutionId) -> Result<Option<String>, ExecutionError> {
        #[cfg(target_os = "macos")]
        {
            let Some(host) = self.host(false)? else {
                return Ok(None);
            };
            super::super::secure_storage::noninteractive(storage_error, || {
                Self::load(&Self::entry(host, reference)?)
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = reference;
            Err(fail(ErrorCode::Unauthorized, "api-key-platform"))
        }
    }
    fn create(&self, reference: ExecutionId, secret: &str) -> Result<(), ExecutionError> {
        if !valid_key(secret) {
            return Err(fail(ErrorCode::InvalidInput, "api-key-value"));
        }
        #[cfg(target_os = "macos")]
        {
            let host = self.host(true)?.ok_or_else(storage_error)?;
            super::super::secure_storage::noninteractive(storage_error, || {
                let entry = Self::entry(host, reference)?;
                match Self::load(&entry)? {
                    Some(saved) if saved == secret => Ok(()),
                    Some(_) => Err(fail(
                        ErrorCode::DependencyConflict,
                        "api-key-reference-changed",
                    )),
                    None => entry
                        .set_secret(secret.as_bytes())
                        .map_err(|_| storage_error()),
                }
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = reference;
            Err(fail(ErrorCode::Unauthorized, "api-key-platform"))
        }
    }
    fn delete(&self, reference: ExecutionId) -> Result<(), ExecutionError> {
        #[cfg(target_os = "macos")]
        {
            let Some(host) = self.host(false)? else {
                return Ok(());
            };
            super::super::secure_storage::noninteractive(storage_error, || {
                match Self::entry(host, reference)?.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err(storage_error()),
                }
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = reference;
            Err(fail(ErrorCode::Unauthorized, "api-key-platform"))
        }
    }
}
