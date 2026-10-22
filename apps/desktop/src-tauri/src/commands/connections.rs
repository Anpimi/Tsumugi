//! Application-scoped non-secret connection facts. The trusted setup supplies
//! the directory; IPC cannot choose a path or read an environment credential.
use super::{AppState, CommandError, CommandErrorCode, CommandStage};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;
use tsumugi_core::{
    ai::{AiConfig, AiConnection},
    execution::{ErrorCode, ExecutionError, ExecutionId},
    model_connections::{
        ModelConnectionBasis, ModelConnectionChange, ModelConnectionReceipt,
        ModelConnectionReference, ModelConnectionSnapshot, ModelConnectionStore,
    },
};
pub(super) mod chatgpt;
use chatgpt::{ChatGptAccountStatus, ChatGptLoginView, ChatGptModelCatalog};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptBeginRequest {
    pub registration: Option<ExecutionId>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptSessionRequest {
    pub session_id: ExecutionId,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptAccountRequest {
    pub account: ExecutionId,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConnectionSnapshotRequest {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConnectionActionRequest {
    pub action_id: ExecutionId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConnectionResolveRequest {
    pub reference: ModelConnectionReference,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConnectionReadView {
    pub snapshot: ModelConnectionSnapshot,
    pub basis: ModelConnectionBasis,
    pub references: Vec<ModelConnectionReference>,
}
impl ConnectionReadView {
    fn new(snapshot: ModelConnectionSnapshot) -> Result<Self, CommandError> {
        // Core computes the basis and references from one read snapshot; clients
        // retain these facts instead of implementing a second digest codec.
        let basis = snapshot.basis().map_err(map_error)?;
        let references = snapshot
            .profiles
            .iter()
            .filter(|p| !p.archived)
            .map(|p| snapshot.reference(p.id).map_err(map_error))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            snapshot,
            basis,
            references,
        })
    }
}

pub(super) fn configure(
    state: &AppState,
    application_directory: &Path,
) -> Result<(), CommandError> {
    let store = ModelConnectionStore::at(application_directory.join("model-connections"))
        .map_err(map_error)?;
    state
        .model_connections
        .set(store)
        .map_err(|_| unavailable())?;
    state.chatgpt_accounts.set(std::sync::Arc::new(
        chatgpt::ChatGptAccounts::new(application_directory).map_err(map_error)?,
    )).map_err(|_| unavailable())
}
fn accounts(state: &AppState) -> Result<std::sync::Arc<chatgpt::ChatGptAccounts>, CommandError> {
    state.chatgpt_accounts.get().cloned().ok_or_else(unavailable)
}

#[tauri::command]
pub async fn read_chatgpt_account(
    state: State<'_, AppState>, request: ConnectionSnapshotRequest,
) -> Result<ChatGptAccountStatus, CommandError> {
    let _ = request;
    let accounts = accounts(&state)?;
    state.io.run(CommandStage::ModelConnections, move || accounts.status().map_err(map_error)).await
}
#[tauri::command]
pub async fn begin_chatgpt_login(
    state: State<'_, AppState>, request: ChatGptBeginRequest,
) -> Result<ChatGptLoginView, CommandError> {
    let accounts = accounts(&state)?;
    state.io.run(CommandStage::ModelConnections, move || {
        let login = accounts.begin(request.registration).map_err(map_error)?;
        if let Err(error) = open_chatgpt_authorization(&login.authorization_url) {
            let _ = accounts.cancel(login.id);
            return Err(map_error(error));
        }
        Ok(login)
    }).await
}
#[tauri::command]
pub async fn cancel_chatgpt_login(
    state: State<'_, AppState>, request: ChatGptSessionRequest,
) -> Result<ChatGptAccountStatus, CommandError> {
    let accounts = accounts(&state)?;
    state.io.run(CommandStage::ModelConnections, move || accounts.cancel(request.session_id).map_err(map_error)).await
}
#[tauri::command]
pub async fn logout_chatgpt_account(
    state: State<'_, AppState>, request: ChatGptAccountRequest,
) -> Result<ChatGptAccountStatus, CommandError> {
    let accounts = accounts(&state)?;
    state.io.run(CommandStage::ModelConnections, move || accounts.logout(request.account).map_err(map_error)).await
}
#[tauri::command]
pub async fn read_chatgpt_models(
    state: State<'_, AppState>, request: ChatGptAccountRequest,
) -> Result<ChatGptModelCatalog, CommandError> {
    let accounts = accounts(&state)?;
    state.io.run(CommandStage::ModelConnections, move || accounts.models(request.account).map_err(map_error)).await
}
fn open_chatgpt_authorization(value: &str) -> Result<(), ExecutionError> {
    let invalid = || ExecutionError::new(ErrorCode::InvalidInput, "chatgpt-login-browser");
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "https" || url.host_str() != Some("auth.openai.com")
        || url.port().is_some() || url.path() != "/api/accounts/authorize"
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || url.query_pairs().any(|(key, _)| key == "id_token_hint") {
        return Err(invalid());
    }
    #[cfg(target_os = "macos")]
    {
        let mut child = std::process::Command::new("/usr/bin/open").arg(value)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()).spawn().map_err(|_| invalid())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(invalid()) },
                Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
                _ => { let _ = child.kill(); let _ = child.wait(); return Err(invalid()); }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    Err(ExecutionError::new(ErrorCode::Unauthorized, "chatgpt-platform"))
}
fn unavailable() -> CommandError {
    CommandError::simple(
        CommandErrorCode::StorageFailed,
        CommandStage::ModelConnections,
    )
}
fn store(state: &AppState) -> Result<ModelConnectionStore, CommandError> {
    captured_store(state).ok_or_else(unavailable)
}
pub(super) fn captured_store(state: &AppState) -> Option<ModelConnectionStore> {
    state.model_connections.get().cloned()
}
/// Fresh admission checks execute inside the existing accepted project-storage
/// command. Recovery of a persisted action never re-resolves mutable defaults.
pub(super) fn verify_configs(
    store: Option<&ModelConnectionStore>,
    configs: &[AiConfig],
) -> Result<(), CommandError> {
    if configs.iter().all(|config| config.connection_profile.is_none()) {
        return Ok(());
    }
    store.ok_or_else(unavailable)?.verify_configs(configs).map_err(map_error)
}
fn map_error(error: ExecutionError) -> CommandError {
    let code = error.code;
    let unsupported = error.stage == "model-connections-version";
    let mut mapped = super::execution::map_execution(error, CommandStage::ModelConnections);
    // This database is not a project. Retain the shared finite error mapping
    // and report connection-store corruption/unsupported format in its scope.
    if code == ErrorCode::CorruptLedger {
        mapped.code = CommandErrorCode::StorageFailed;
    }
    if unsupported {
        mapped.code = CommandErrorCode::UnsupportedSchema;
    }
    mapped
}

#[tauri::command]
pub async fn read_model_connections(
    state: State<'_, AppState>,
    request: ConnectionSnapshotRequest,
) -> Result<ConnectionReadView, CommandError> {
    let _ = request;
    let store = store(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            ConnectionReadView::new(store.snapshot().map_err(map_error)?)
        })
        .await
}
#[tauri::command]
pub async fn change_model_connections(
    state: State<'_, AppState>,
    request: ModelConnectionChange,
) -> Result<ModelConnectionReceipt, CommandError> {
    let store = store(&state)?;
    // Bounded admission and accepted work lifetime reuse the existing executor.
    // The Core transaction checks the original action and complete read basis.
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            store.change(&request).map_err(map_error)
        })
        .await
}
#[tauri::command]
pub async fn read_model_connection_action(
    state: State<'_, AppState>,
    request: ConnectionActionRequest,
) -> Result<Option<ModelConnectionReceipt>, CommandError> {
    let store = store(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            store.action(request.action_id).map_err(map_error)
        })
        .await
}
#[tauri::command]
pub async fn resolve_model_connection(
    state: State<'_, AppState>,
    request: ConnectionResolveRequest,
) -> Result<AiConnection, CommandError> {
    let store = store(&state)?;
    state
        .io
        .run(CommandStage::ModelConnections, move || {
            store.resolve(&request.reference).map_err(map_error)
        })
        .await
}

#[cfg(test)]
mod tests;
