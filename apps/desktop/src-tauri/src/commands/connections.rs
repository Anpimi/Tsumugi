//! Application-scoped non-secret connection facts. The trusted setup supplies
//! the directory; IPC cannot choose a path or read an environment credential.
use super::{AppState, CommandError, CommandErrorCode, CommandStage};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;
use tsumugi_core::{
    ai::AiConnection,
    execution::{ErrorCode, ExecutionError, ExecutionId},
    model_connections::{
        ModelConnectionBasis, ModelConnectionChange, ModelConnectionReceipt,
        ModelConnectionReference, ModelConnectionSnapshot, ModelConnectionStore,
    },
};

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
        .map_err(|_| unavailable())
}
fn unavailable() -> CommandError {
    CommandError::simple(
        CommandErrorCode::StorageFailed,
        CommandStage::ModelConnections,
    )
}
fn store(state: &AppState) -> Result<ModelConnectionStore, CommandError> {
    state
        .model_connections
        .get()
        .cloned()
        .ok_or_else(unavailable)
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
