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

fn confirm_disposition<R>(
    outcome: tsumugi_core::application::WorkPlanRequestOutcome<R>,
    expected: ConversationDraftDisposition,
) -> Result<(), CommandError> {
    use tsumugi_core::application::WorkPlanRequestOutcome;
    let actual = match outcome {
        WorkPlanRequestOutcome::Recorded { .. } => ConversationDraftDisposition::Recorded,
        WorkPlanRequestOutcome::FencedNotApplied => ConversationDraftDisposition::FencedNotApplied,
        WorkPlanRequestOutcome::Pending => {
            return Err(map_error(ExecutionError::new(
                ErrorCode::OutcomeUnknown, "conversation-drafts-pending",
            )));
        }
    };
    if actual != expected {
        return Err(map_error(ExecutionError::new(
            ErrorCode::ResultMismatch, "conversation-drafts-disposition",
        )));
    }
    Ok(())
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
                if original.resolve.disposition == ConversationDraftDisposition::FencedNotApplied
                    && matches!(&original.resolve.target, ConversationDraftResolveTarget::Pending { pending }
                        if !matches!(pending, ConversationDraftPending::WorkPlanStart { .. } | ConversationDraftPending::WorkPlanControl { .. }
                            | ConversationDraftPending::TeamMessage { .. } | ConversationDraftPending::TeamPublication { .. }))
                {
                    return Err(map_error(ExecutionError::new(ErrorCode::InvalidInput, "conversation-drafts-disposition")));
                }
                let outcome = observe_conversation_target(&active.store, key, &original.resolve.target).map_err(map_error)?;
                confirm_disposition(outcome, original.resolve.disposition)
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
