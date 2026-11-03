use super::*;
use super::super::secure_storage::{IdentityError, InstallationIdentity};
#[cfg(target_os = "macos")]
use super::super::secure_storage::noninteractive;

const MAX_VAULT_BYTES: usize = 1024 * 1024;

pub(super) trait CredentialStorage: Send + Sync {
    fn load(&self) -> Result<Vault, ExecutionError>;
    fn save(&self, vault: &Vault) -> Result<(), ExecutionError>;
}

pub(super) struct KeychainStorage { installation: InstallationIdentity }
impl KeychainStorage {
    pub(super) fn new(directory: &Path) -> Self {
        Self { installation: InstallationIdentity::new(directory, "chatgpt-accounts.lock") }
    }
    fn host(&self) -> Result<ExecutionId, ExecutionError> {
        self.installation.host(true).map_err(|error| match error {
            IdentityError::Busy => failure(ErrorCode::Busy, "chatgpt-account-owner"),
            IdentityError::Unavailable => storage_error(),
        })?.ok_or_else(storage_error)
    }
    #[cfg(target_os = "macos")]
    fn entry(&self, host: ExecutionId) -> Result<keyring::Entry, ExecutionError> {
        keyring::Entry::new("app.tsumugi.desktop.chatgpt", &host.to_string()).map_err(|_| storage_error())
    }
}

impl CredentialStorage for KeychainStorage {
    fn load(&self) -> Result<Vault, ExecutionError> {
        #[cfg(target_os = "macos")]
        {
            let host = self.host()?;
            let bytes = noninteractive(storage_error, || match self.entry(host)?.get_secret() {
                Ok(bytes) => Ok(Some(bytes)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(storage_error()),
            })?;
            let Some(bytes) = bytes else {
                return Ok(Vault::empty(host));
            };
            if bytes.len() > MAX_VAULT_BYTES {
                return Err(storage_error());
            }
            let vault: Vault = serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
            validate(&vault, host)?;
            Ok(vault)
        }
        #[cfg(not(target_os = "macos"))]
        {
            // An unsupported platform must not silently use keyring's mock
            // backend or persist a plaintext replacement.
            Err(storage_error())
        }
    }

    fn save(&self, vault: &Vault) -> Result<(), ExecutionError> {
        #[cfg(target_os = "macos")]
        {
            let host = self.host()?;
            validate(vault, host)?;
            let bytes = serde_json::to_vec(vault).map_err(|_| storage_error())?;
            if bytes.len() > MAX_VAULT_BYTES {
                return Err(storage_error());
            }
            // A single Keychain item replaces the complete document in one
            // secure-store operation, including every rotating token field.
            noninteractive(storage_error, || {
                self.entry(host)?
                    .set_secret(&bytes)
                    .map_err(|_| storage_error())
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = vault;
            Err(storage_error())
        }
    }
}

fn validate(vault: &Vault, host: ExecutionId) -> Result<(), ExecutionError> {
    if vault.version != 1 || vault.host != host || vault.registrations.len() > MAX_REGISTRATIONS {
        return Err(storage_error());
    }
    let mut registrations = std::collections::BTreeSet::new();
    let mut clients = std::collections::BTreeSet::new();
    let mut accounts = std::collections::BTreeSet::new();
    for record in &vault.registrations {
        if !registrations.insert(record.id)
            || !clients.insert(record.client_id.as_str())
            || !oauth::valid_client_id(&record.client_id)
            || !bounded_text(&record.subject, 1024)
            || !bounded_text(&record.label, 384)
        {
            return Err(storage_error());
        }
        if let Some(credentials) = &record.credentials {
            if !accounts.insert(credentials.account)
                || !oauth::valid_token(&credentials.access_token)
                || !oauth::valid_token(&credentials.refresh_token)
                || !oauth::valid_token(&credentials.id_token)
                || !bounded_text(&credentials.nonce, 256)
                || !oauth::has_inference_scopes(&credentials.scopes)
                || credentials.scopes.len() > 32
                || credentials
                    .scopes
                    .iter()
                    .any(|scope| !bounded_text(scope, 256))
                || credentials.expires_at == 0
                || credentials
                    .earliest_refresh_at
                    .is_some_and(|at| at > credentials.expires_at)
            {
                return Err(storage_error());
            }
        }
    }
    if vault
        .active
        .is_some_and(|account| !accounts.contains(&account))
    {
        return Err(storage_error());
    }
    Ok(())
}

pub(super) fn bounded_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

#[cfg(test)]
pub(super) fn validate_fixture(vault: &Vault) -> Result<(), ExecutionError> {
    validate(vault, vault.host)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use security_framework::os::macos::keychain::SecKeychain;

    #[test]
    fn secure_storage_policy_disallows_ui_and_restores_success_and_failure() {
        let before = SecKeychain::user_interaction_allowed().unwrap();
        assert_eq!(
            noninteractive(storage_error, || {
                assert!(!SecKeychain::user_interaction_allowed().unwrap());
                Ok(7)
            })
            .unwrap(),
            7
        );
        assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), before);
        let error = noninteractive::<()>(storage_error, || {
            assert!(!SecKeychain::user_interaction_allowed().unwrap());
            Err(storage_error())
        })
        .unwrap_err();
        assert_eq!(error.stage, "chatgpt-secure-storage");
        assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), before);
        let outer = before.then(|| SecKeychain::disable_user_interaction().unwrap());
        noninteractive(storage_error, || Ok(())).unwrap();
        assert!(!SecKeychain::user_interaction_allowed().unwrap());
        drop(outer);
        assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), before);
    }
}
