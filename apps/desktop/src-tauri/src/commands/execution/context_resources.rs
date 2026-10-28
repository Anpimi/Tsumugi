//! Human knowledge uses the existing resource mutation and session boundaries.
use super::*;
use tsumugi_core::{ContextResourceActionRead, ContextResourceKind, ContextResourcePage,
    ContextResourceResolution, ContextResourceRevision, ContextResourceRecovery, ContextResourceAction,
    SaveContextResource, WithdrawContextResource};

#[cfg(test)]
#[path = "context_resource_tests.rs"]
mod tests;

request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceSaveRequest { resource: SaveContextResource });
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceWithdrawRequest { resource: WithdrawContextResource });
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceCurrentRequest { context_id: ExecutionId });
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceListRequest { locale: String, kind: Option<ContextResourceKind>, offset: u32, limit: u32, basis: Option<String> });
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceHistoryRequest { context_id: ExecutionId, offset: u32, limit: u32, basis: Option<String> });
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceActionRequest { action_id: ExecutionId });
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceRecoveryRequest { action: ContextResourceAction });
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextResourceResolveRequest { scope: tsumugi_core::SourceContextRequest });

#[tauri::command]
pub async fn save_context_resource(state: State<'_, AppState>, request: ContextResourceSaveRequest) -> Result<ContextResourceRevision, CommandError> {
    state.sessions.run("save_context_resource", CommandStage::ExecutionAdopt, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionAdopt)?;
        if request.resource.project_id != request.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "context-resource-project"), CommandStage::ExecutionAdopt));
        }
        let (host, store) = active.execution_parts()?;
        host.allow_mutation()?;
        store.save_context_resource(&request.resource).map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
    }).await
}

#[tauri::command]
pub async fn withdraw_context_resource(state: State<'_, AppState>, request: ContextResourceWithdrawRequest) -> Result<ContextResourceRevision, CommandError> {
    state.sessions.run("withdraw_context_resource", CommandStage::ExecutionAdopt, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionAdopt)?;
        if request.resource.project_id != request.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "context-resource-project"), CommandStage::ExecutionAdopt));
        }
        let (host, store) = active.execution_parts()?;
        host.allow_mutation()?;
        store.withdraw_context_resource(&request.resource).map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
    }).await
}

#[tauri::command]
pub async fn read_context_resource_current(state: State<'_, AppState>, request: ContextResourceCurrentRequest) -> Result<Option<ContextResourceRevision>, CommandError> {
    state.sessions.run("read_context_resource_current", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?.store
            .current_context_resource(request.project_id, request.context_id)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn read_context_resource_page(state: State<'_, AppState>, request: ContextResourceListRequest) -> Result<ContextResourcePage, CommandError> {
    state.sessions.run("read_context_resource_page", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?.store
            .list_context_resources(request.project_id, &request.locale, request.kind, request.offset, request.limit, request.basis.as_deref())
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn read_context_resource_history(state: State<'_, AppState>, request: ContextResourceHistoryRequest) -> Result<ContextResourcePage, CommandError> {
    state.sessions.run("read_context_resource_history", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?.store
            .context_resource_history(request.project_id, request.context_id, request.offset, request.limit, request.basis.as_deref())
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn read_context_resource_action(state: State<'_, AppState>, request: ContextResourceActionRequest) -> Result<Option<ContextResourceActionRead>, CommandError> {
    state.sessions.run("read_context_resource_action", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?.store
            .context_resource_action(request.project_id, request.action_id)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn reconcile_context_resource_action(state: State<'_, AppState>, request: ContextResourceRecoveryRequest) -> Result<ContextResourceRecovery, CommandError> {
    state.sessions.run("reconcile_context_resource_action", CommandStage::ExecutionAdopt, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionAdopt)?;
        let project = match &request.action { ContextResourceAction::Save(value) => value.project_id,
            ContextResourceAction::Withdraw(value) => value.project_id,
            ContextResourceAction::ProposalAdoption(value) => value.proposal.project_id };
        if project != request.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "context-resource-project"), CommandStage::ExecutionAdopt));
        }
        active.store.recover_context_resource_action(&request.action)
            .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
    }).await
}

#[tauri::command]
pub async fn resolve_context_resources(state: State<'_, AppState>, request: ContextResourceResolveRequest) -> Result<ContextResourceResolution, CommandError> {
    state.sessions.run("resolve_context_resources", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.scope.project_id != request.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "context-resource-project"), CommandStage::ExecutionRead));
        }
        active.store.resolve_context_resources(&request.scope).map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}
