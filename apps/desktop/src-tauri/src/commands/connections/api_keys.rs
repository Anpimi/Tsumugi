//! Immutable Keychain references share the original connection CAS and receipt.
//! Secret input is consumed here, never included in a Core request or response.
use super::*;
use std::sync::{Arc, Mutex};
use tsumugi_core::{ai::provider::ApiKeyCredentials, model_connections::ModelConnectionEdit};
mod storage;
const MAX_KEY_BYTES: usize = 8192;

// Deliberately no Debug: command input must not become a diagnostic payload.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApiKeySaveRequest {
    pub change: ModelConnectionChange,
    pub secret: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApiKeyReferenceRequest {
    pub reference: ExecutionId,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApiKeyHistoryRequest {
    pub profile_id: ExecutionId,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ApiKeyAvailability {
    Available,
    Missing,
    UnsupportedPlatform,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApiKeyStatus {
    pub reference: ExecutionId,
    pub availability: ApiKeyAvailability,
}

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn storage_error() -> ExecutionError {
    fail(ErrorCode::StorageFailed, "api-key-secure-storage")
}
fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_KEY_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
trait CredentialStorage: Send + Sync {
    fn supported(&self) -> bool;
    fn read(&self, reference: ExecutionId) -> Result<Option<String>, ExecutionError>;
    fn create(&self, reference: ExecutionId, secret: &str) -> Result<(), ExecutionError>;
    fn delete(&self, reference: ExecutionId) -> Result<(), ExecutionError>;
}
pub(in crate::commands) struct ApiKeys {
    storage: Box<dyn CredentialStorage>,
    operations: Mutex<()>,
}
impl ApiKeys {
    pub(super) fn new(directory: &Path) -> Self {
        Self {
            storage: Box::new(storage::KeychainStorage::new(directory)),
            operations: Mutex::new(()),
        }
    }
    fn status(&self, reference: ExecutionId) -> Result<ApiKeyStatus, ExecutionError> {
        let availability = if !self.storage.supported() {
            ApiKeyAvailability::UnsupportedPlatform
        } else {
            match self.storage.read(reference)? {
                Some(key) if valid_key(&key) => ApiKeyAvailability::Available,
                Some(_) => return Err(storage_error()),
                None => ApiKeyAvailability::Missing,
            }
        };
        Ok(ApiKeyStatus {
            reference,
            availability,
        })
    }
    pub(super) fn change_plain(
        &self,
        store: &ModelConnectionStore,
        change: &ModelConnectionChange,
    ) -> Result<ModelConnectionReceipt, ExecutionError> {
        let _operation = self.operations.lock().map_err(|_| storage_error())?;
        store.check_change(change)?;
        if store.action(change.action_id)?.is_some() {
            return store.change(change);
        }
        if let ModelConnectionEdit::Save {
            profile_id,
            connection,
            ..
        } = &change.edit
        {
            if let Some(reference) = connection.credential_reference {
                let unchanged = store.snapshot()?.profiles.iter().any(|profile| {
                    profile.id == *profile_id
                        && profile.connection.credential_reference == Some(reference)
                });
                if !unchanged {
                    self.api_key(reference)?;
                }
            }
        }
        store.change(change)
    }
    fn discard_absent(
        &self,
        store: &ModelConnectionStore,
        change: &ModelConnectionChange,
    ) -> Result<Option<ModelConnectionReceipt>, ExecutionError> {
        let _operation = self.operations.lock().map_err(|_| storage_error())?;
        let ModelConnectionEdit::Save { connection, .. } = &change.edit else {
            return Err(fail(ErrorCode::InvalidInput, "api-key-connection"));
        };
        if connection.credential_reference != Some(change.action_id) {
            return Err(fail(ErrorCode::InvalidInput, "api-key-connection"));
        }
        if let Some(receipt) = store.check_action(change)? {
            return Ok(Some(receipt));
        }
        if store.snapshot()?.store_id != change.expected.store_id {
            return Err(fail(ErrorCode::OutcomeUnknown, "api-key-store-changed"));
        }
        self.storage.delete(change.action_id)?;
        Ok(None)
    }
    fn change(
        &self,
        store: &ModelConnectionStore,
        change: &ModelConnectionChange,
        secret: Option<&str>,
    ) -> Result<ModelConnectionReceipt, ExecutionError> {
        let _operation = self.operations.lock().map_err(|_| storage_error())?;
        let ModelConnectionEdit::Save { connection, .. } = &change.edit else {
            return Err(fail(ErrorCode::InvalidInput, "api-key-connection"));
        };
        if connection.credential_reference != Some(change.action_id)
            || !connection.credential_env.is_empty()
            || connection.chatgpt_account.is_some()
            || secret.is_some_and(|key| !valid_key(key))
        {
            return Err(fail(ErrorCode::InvalidInput, "api-key-connection"));
        }
        store.check_change(change)?;
        // Exact receipts are authoritative even after the key was removed. A
        // retry never recreates or replaces a completed action's credential.
        if store.action(change.action_id)?.is_some() {
            return store.change(change);
        }
        if !self.storage.supported() {
            return Err(fail(ErrorCode::Unauthorized, "api-key-platform"));
        }
        if let Some(secret) = secret {
            self.storage.create(change.action_id, secret)?;
        } else {
            self.api_key(change.action_id)?;
        }
        // A racing settings change is rejected by the original Core CAS. Keep
        // the isolated key reference for explicit recovery; never assume an
        // unacknowledged commit failed and delete its key.
        store.change(change)
    }
}
impl ApiKeyCredentials for ApiKeys {
    fn api_key(&self, reference: ExecutionId) -> Result<String, ExecutionError> {
        self.storage
            .read(reference)?
            .filter(|key| valid_key(key))
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "ai-api-key-unavailable"))
    }
}
fn owner(state: &AppState) -> Result<Arc<ApiKeys>, CommandError> {
    state.api_keys.get().cloned().ok_or_else(unavailable)
}
#[tauri::command]
pub async fn save_model_connection_key(
    state: State<'_, AppState>,
    request: ApiKeySaveRequest,
) -> Result<ModelConnectionReceipt, CommandError> {
    let owner = owner(&state)?;
    let store = store(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            owner
                .change(&store, &request.change, Some(&request.secret))
                .map_err(map_error)
        })
        .await
}
#[tauri::command]
pub async fn resume_model_connection_key(
    state: State<'_, AppState>,
    request: ModelConnectionChange,
) -> Result<ModelConnectionReceipt, CommandError> {
    let owner = owner(&state)?;
    let store = store(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            owner.change(&store, &request, None).map_err(map_error)
        })
        .await
}
#[tauri::command]
pub async fn discard_model_connection_key(
    state: State<'_, AppState>,
    request: ModelConnectionChange,
) -> Result<Option<ModelConnectionReceipt>, CommandError> {
    let owner = owner(&state)?;
    let store = store(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            owner.discard_absent(&store, &request).map_err(map_error)
        })
        .await
}
#[tauri::command]
pub async fn read_model_connection_key(
    state: State<'_, AppState>,
    request: ApiKeyReferenceRequest,
) -> Result<ApiKeyStatus, CommandError> {
    let owner = owner(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            owner.status(request.reference).map_err(map_error)
        })
        .await
}
#[tauri::command]
pub async fn read_model_connection_keys(
    state: State<'_, AppState>,
    request: ApiKeyHistoryRequest,
) -> Result<Vec<ApiKeyStatus>, CommandError> {
    let owner = owner(&state)?;
    let store = store(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            store
                .credential_references(request.profile_id)
                .map_err(map_error)?
                .into_iter()
                .map(|reference| owner.status(reference).map_err(map_error))
                .collect()
        })
        .await
}
#[tauri::command]
pub async fn remove_model_connection_key(
    state: State<'_, AppState>,
    request: ApiKeyReferenceRequest,
) -> Result<ApiKeyStatus, CommandError> {
    let owner = owner(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            let _operation = owner
                .operations
                .lock()
                .map_err(|_| map_error(storage_error()))?;
            owner.storage.delete(request.reference).map_err(map_error)?;
            owner.status(request.reference).map_err(map_error)
        })
        .await
}

#[cfg(test)]
mod tests;
