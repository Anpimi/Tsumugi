use super::*;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

const MAX_VAULT_BYTES: usize = 1024 * 1024;

pub(super) trait CredentialStorage: Send + Sync {
    fn load(&self) -> Result<Vault, ExecutionError>;
    fn save(&self, vault: &Vault) -> Result<(), ExecutionError>;
}

struct InstallationLease {
    // Kept open and exclusively locked until the owner is dropped. A second
    // process cannot refresh a rotating credential for this installation.
    _file: File,
    host: ExecutionId,
}

pub(super) struct KeychainStorage {
    directory: PathBuf,
    installation: Mutex<Option<InstallationLease>>,
}

impl KeychainStorage {
    pub(super) fn new(directory: &Path) -> Self {
        Self { directory: directory.into(), installation: Mutex::new(None) }
    }

    fn host(&self) -> Result<ExecutionId, ExecutionError> {
        let mut installation = self.installation.lock().map_err(|_| storage_error())?;
        if let Some(lease) = installation.as_ref() { return Ok(lease.host); }
        std::fs::create_dir_all(&self.directory).map_err(|_| storage_error())?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(self.directory.join("chatgpt-accounts.lock"))
            .map_err(|_| storage_error())?;
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => failure(ErrorCode::Busy, "chatgpt-account-owner"),
            std::fs::TryLockError::Error(_) => storage_error(),
        })?;
        // This file contains only a random, non-secret installation identity.
        // Credentials are never written to it or to any application data file.
        let mut raw = String::new();
        (&mut file).take(65).read_to_string(&mut raw).map_err(|_| storage_error())?;
        let host = if raw.is_empty() {
            let host = ExecutionId::new();
            file.seek(SeekFrom::Start(0)).map_err(|_| storage_error())?;
            file.write_all(host.to_string().as_bytes()).map_err(|_| storage_error())?;
            file.sync_all().map_err(|_| storage_error())?;
            host
        } else {
            ExecutionId::parse(&raw).map_err(|_| storage_error())?
        };
        *installation = Some(InstallationLease { _file: file, host });
        Ok(host)
    }

    #[cfg(target_os = "macos")]
    fn entry(&self, host: ExecutionId) -> Result<keyring::Entry, ExecutionError> {
        keyring::Entry::new("app.tsumugi.desktop.chatgpt", &host.to_string())
            .map_err(|_| storage_error())
    }
}

impl CredentialStorage for KeychainStorage {
    fn load(&self) -> Result<Vault, ExecutionError> {
        #[cfg(target_os = "macos")]
        {
            let host = self.host()?;
            let bytes = match self.entry(host)?.get_secret() {
                Ok(bytes) => bytes,
                Err(keyring::Error::NoEntry) => return Ok(Vault::empty(host)),
                Err(_) => return Err(storage_error()),
            };
            if bytes.len() > MAX_VAULT_BYTES { return Err(storage_error()); }
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
            if bytes.len() > MAX_VAULT_BYTES { return Err(storage_error()); }
            // A single Keychain item replaces the complete document in one
            // secure-store operation, including every rotating token field.
            self.entry(host)?.set_secret(&bytes).map_err(|_| storage_error())
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
        if !registrations.insert(record.id) || !clients.insert(record.client_id.as_str()) ||
            !oauth::valid_client_id(&record.client_id) || !bounded_text(&record.subject, 1024) ||
            !bounded_text(&record.label, 384)
        { return Err(storage_error()); }
        if let Some(credentials) = &record.credentials {
            if !accounts.insert(credentials.account) ||
                !oauth::valid_token(&credentials.access_token) ||
                !oauth::valid_token(&credentials.refresh_token) ||
                !oauth::valid_token(&credentials.id_token) ||
                !bounded_text(&credentials.nonce, 256) ||
                !oauth::has_inference_scopes(&credentials.scopes) ||
                credentials.scopes.len() > 32 || credentials.scopes.iter().any(|scope| !bounded_text(scope, 256)) ||
                credentials.expires_at == 0 ||
                credentials.earliest_refresh_at.is_some_and(|at| at > credentials.expires_at)
            { return Err(storage_error()); }
        }
    }
    if vault.active.is_some_and(|account| !accounts.contains(&account)) { return Err(storage_error()); }
    Ok(())
}

pub(super) fn bounded_text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

#[cfg(test)]
pub(super) fn validate_fixture(vault: &Vault) -> Result<(), ExecutionError> { validate(vault, vault.host) }
