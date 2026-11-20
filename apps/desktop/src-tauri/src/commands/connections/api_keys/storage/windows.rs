use std::{ptr::NonNull, slice, str};

use windows_sys::Win32::{
    Foundation::{ERROR_NOT_FOUND, GetLastError},
    Security::Credentials::{
        CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW,
        CredDeleteW, CredFree, CredReadW, CredWriteW,
    },
};

use super::{ErrorCode, ExecutionError, ExecutionId, fail, storage_error};

pub(super) struct Entry(Vec<u16>);

pub(super) fn with_entry<T>(
    host: ExecutionId,
    reference: ExecutionId,
    operation: impl FnOnce(&Entry) -> Result<T, ExecutionError>,
) -> Result<T, ExecutionError> {
    let target = format!("app.tsumugi.desktop.api-key/{host}/{reference}")
        .encode_utf16()
        .chain([0])
        .collect();
    operation(&Entry(target))
}

pub(super) fn validate_size(secret: &str) -> Result<(), ExecutionError> {
    if secret.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(fail(ErrorCode::InvalidInput, "api-key-windows-limit"));
    }
    Ok(())
}

struct CredentialBuffer(NonNull<CREDENTIALW>);

impl Drop for CredentialBuffer {
    fn drop(&mut self) {
        // CredReadW allocates one block for the structure and all its fields.
        unsafe { CredFree(self.0.as_ptr().cast()) };
    }
}

impl Entry {
    pub(super) fn read(&self) -> Result<Option<String>, ExecutionError> {
        let mut raw = std::ptr::null_mut();
        // The target is NUL-terminated and the output slot lives for the call.
        if unsafe { CredReadW(self.0.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) } == 0 {
            return if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(storage_error())
            };
        }
        let buffer = CredentialBuffer(NonNull::new(raw).ok_or_else(storage_error)?);
        let credential = unsafe { buffer.0.as_ref() };
        let size = credential.CredentialBlobSize as usize;
        if size == 0
            || size > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize
            || credential.CredentialBlob.is_null()
        {
            return Err(storage_error());
        }
        // The returned buffer owns the blob for the lifetime of this read.
        let bytes = unsafe { slice::from_raw_parts(credential.CredentialBlob, size) };
        str::from_utf8(bytes)
            .map(|secret| Some(secret.to_owned()))
            .map_err(|_| storage_error())
    }

    pub(super) fn write(&self, secret: &str) -> Result<(), ExecutionError> {
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: self.0.as_ptr().cast_mut(),
            CredentialBlobSize: secret.len() as u32,
            CredentialBlob: secret.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // CredWriteW takes the structure and its fields as input for this call.
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(storage_error());
        }
        Ok(())
    }

    pub(super) fn delete(&self) -> Result<(), ExecutionError> {
        // The target is NUL-terminated and names exactly this reference.
        if unsafe { CredDeleteW(self.0.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0
            || unsafe { GetLastError() } == ERROR_NOT_FOUND
        {
            return Ok(());
        }
        Err(storage_error())
    }
}
