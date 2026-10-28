//! Local conversation input has no project mutation or execution authority.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftReadRequest {
    pub session_token: String,
    pub key: ConversationDraftKey,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftWriteRequest {
    pub session_token: String,
    pub write: ConversationDraftWrite,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftResolveRequest {
    pub session_token: String,
    pub resolve: ConversationDraftResolve,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftClearRequest {
    pub session_token: String,
    pub clear: ConversationDraftClear,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftListRequest {
    pub session_token: String,
    pub project_id: ExecutionId,
    pub after: Option<ConversationDraftKey>,
    pub limit: u32,
}

async fn journal<T: Send + 'static>(
    state: &AppState,
    token: String,
    project: ExecutionId,
    operation: impl FnOnce(DraftStore) -> Result<T, ExecutionError> + Send + 'static,
) -> Result<T, CommandError> {
    // A not-yet-created thread is an explicit local input identity. Project
    // ownership is required; no fabricated translation target is involved.
    authorize(state, token.clone(), project, None).await?;
    let drafts = store(state)?;
    let result = state
        .io
        .run(CommandStage::DraftStorage, move || {
            operation(drafts).map_err(map_error)
        })
        .await?;
    authorize(state, token, project, None).await?;
    Ok(result)
}

#[tauri::command]
pub async fn read_local_conversation_draft(
    state: State<'_, AppState>,
    request: ConversationDraftReadRequest,
) -> Result<ConversationDraftHead, CommandError> {
    journal(
        &state,
        request.session_token,
        request.key.project_id,
        move |drafts| drafts.read_conversation(&request.key),
    )
    .await
}
#[tauri::command]
pub async fn write_local_conversation_draft(
    state: State<'_, AppState>,
    request: ConversationDraftWriteRequest,
) -> Result<ConversationDraftHead, CommandError> {
    journal(
        &state,
        request.session_token,
        request.write.key.project_id,
        move |drafts| drafts.write_conversation(&request.write),
    )
    .await
}
#[tauri::command]
pub async fn clear_local_conversation_draft(
    state: State<'_, AppState>,
    request: ConversationDraftClearRequest,
) -> Result<ConversationDraftHead, CommandError> {
    journal(
        &state,
        request.session_token,
        request.clear.key.project_id,
        move |drafts| drafts.clear_conversation(&request.clear),
    )
    .await
}
#[tauri::command]
pub async fn list_local_conversation_drafts(
    state: State<'_, AppState>,
    request: ConversationDraftListRequest,
) -> Result<ConversationDraftPage, CommandError> {
    journal(
        &state,
        request.session_token,
        request.project_id,
        move |drafts| {
            drafts.list_conversations(request.project_id, request.after.as_ref(), request.limit)
        },
    )
    .await
}
#[tauri::command]
pub async fn resolve_local_conversation_draft(
    state: State<'_, AppState>,
    request: ConversationDraftResolveRequest,
) -> Result<ConversationDraftHead, CommandError> {
    let original = request.clone();
    state
        .sessions
        .run(
            "local_conversation_drafts.resolve",
            CommandStage::DraftStorage,
            move |sessions| {
                let key = &original.resolve.write.key;
                let active = super::super::execution::authorized(
                    sessions,
                    &original.session_token,
                    key.project_id,
                    CommandStage::DraftStorage,
                )?;
                let recorded = match &original.resolve.pending {
                    ConversationDraftPending::Create { request, .. }
                        if request.project_id == key.project_id
                            && request.conversation_id == key.conversation_id =>
                    {
                        active
                            .store
                            .project_conversation_create_receipt(request)
                            .map_err(map_error)?
                            .is_some()
                    }
                    ConversationDraftPending::Append { request, .. }
                        if request.project_id == key.project_id
                            && request.conversation_id == key.conversation_id =>
                    {
                        active
                            .store
                            .project_conversation_message_receipt(request)
                            .map_err(map_error)?
                            .is_some()
                    }
                    ConversationDraftPending::Planning { request, .. }
                        if request.project_id == key.project_id
                            && request.conversation_id == key.conversation_id =>
                    {
                        active
                            .store
                            .conversation_planning_receipt(request)
                            .map_err(map_error)?
                            .is_some()
                    }
                    ConversationDraftPending::ProposalCapture { request, .. }
                        if request.project_id == key.project_id
                            && request.conversation_id == key.conversation_id =>
                    {
                        active
                            .store
                            .conversation_proposal_capture_receipt(request)
                            .map_err(map_error)?
                            .is_some()
                    }
                    ConversationDraftPending::ProposalRevision { request, .. }
                        if request.project_id == key.project_id
                            && request.conversation_id == key.conversation_id =>
                    {
                        active
                            .store
                            .conversation_proposal_revision_receipt(request)
                            .map_err(map_error)?
                            .is_some()
                    }
                    ConversationDraftPending::ProposalWorkPlan { request, .. }
                        if request.proposal.project_id == key.project_id
                            && request.proposal.conversation_id == key.conversation_id =>
                    {
                        active
                            .store
                            .conversation_proposal_work_plan_receipt(request)
                            .map_err(map_error)?
                            .is_some()
                    }
                    _ => {
                        return Err(map_error(ExecutionError::new(
                            ErrorCode::InvalidInput,
                            "conversation-drafts-pending",
                        )));
                    }
                };
                if !recorded {
                    return Err(map_error(ExecutionError::new(
                        ErrorCode::OutcomeUnknown,
                        "conversation-drafts-pending",
                    )));
                }
                Ok(())
            },
        )
        .await?;
    journal(
        &state,
        request.session_token,
        request.resolve.write.key.project_id,
        move |drafts| drafts.resolve_conversation(&request.resolve),
    )
    .await
}

#[cfg(test)]
mod tests;
