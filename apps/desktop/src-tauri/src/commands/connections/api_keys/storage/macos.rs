use super::{ExecutionError, ExecutionId, MAX_KEY_BYTES, storage_error};

pub(super) struct Entry(keyring::Entry);

pub(super) fn with_entry<T>(
    host: ExecutionId,
    reference: ExecutionId,
    operation: impl FnOnce(&Entry) -> Result<T, ExecutionError>,
) -> Result<T, ExecutionError> {
    super::super::super::secure_storage::noninteractive(storage_error, || {
        let entry = keyring::Entry::new(
            "app.tsumugi.desktop.api-key",
            &format!("{host}/{reference}"),
        )
        .map_err(|_| storage_error())?;
        operation(&Entry(entry))
    })
}

impl Entry {
    pub(super) fn read(&self) -> Result<Option<String>, ExecutionError> {
        match self.0.get_secret() {
            Ok(bytes) if bytes.len() <= MAX_KEY_BYTES => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| storage_error()),
            Err(keyring::Error::NoEntry) => Ok(None),
            _ => Err(storage_error()),
        }
    }

    pub(super) fn write(&self, secret: &str) -> Result<(), ExecutionError> {
        self.0
            .set_secret(secret.as_bytes())
            .map_err(|_| storage_error())
    }

    pub(super) fn delete(&self) -> Result<(), ExecutionError> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(storage_error()),
        }
    }
}
