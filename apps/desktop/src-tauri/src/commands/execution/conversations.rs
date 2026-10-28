//! Local human conversation commands do not create a model or execution scope.
use super::*;
use tsumugi_core::application::conversations::*;
pub(in crate::commands) mod planning;
#[cfg(feature = "wire-schema")]
pub(in crate::commands) use planning::{
    PrepareConversationPlanningRequest, PreparedConversationPlanning,
    ValidateConversationPlanningRequest,
};

pub(in crate::commands) struct PlanningPreparation {
    preparation_id: ExecutionId,
    capture: CapturedConversationPlanning,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CreateProjectConversationRequest {
        action_id: ExecutionId,
        conversation_id: ExecutionId,
        #[serde(deserialize_with = "required_conversation_title")]
        #[cfg_attr(feature = "wire-schema", schemars(schema_with = "conversation_title_schema"))]
        title: Option<String>
    }
);
impl CreateProjectConversationRequest {
    fn original(&self) -> CreateProjectConversation {
        CreateProjectConversation {
            project_id: self.project_id,
            action_id: self.action_id,
            conversation_id: self.conversation_id,
            title: self.title.clone(),
        }
    }
}
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ListProjectConversationsRequest {
        after: Option<Revision>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 50)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadProjectConversationRequest {
        conversation_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadProjectConversationMessagesRequest {
        conversation_id: ExecutionId,
        after: Option<Revision>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 50)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AppendProjectConversationMessageRequest {
        action_id: ExecutionId,
        conversation_id: ExecutionId,
        message_id: ExecutionId,
        body: String
    }
);
impl AppendProjectConversationMessageRequest {
    fn original(&self) -> AppendProjectConversationMessage {
        AppendProjectConversationMessage {
            project_id: self.project_id,
            action_id: self.action_id,
            conversation_id: self.conversation_id,
            message_id: self.message_id,
            body: self.body.clone(),
        }
    }
}
fn block_replay<T>(outcome: &mut ConversationActionOutcome<T>, active: &ActiveSession) {
    if active
        .execution
        .as_ref()
        .is_some_and(ExecutionHost::is_quiescing)
    {
        if let ConversationActionOutcome::Pending { replay } = outcome {
            *replay = ConversationActionReplay::Blocked;
        }
    }
}

#[tauri::command]
pub async fn create_project_conversation(
    state: State<'_, AppState>,
    request: CreateProjectConversationRequest,
) -> Result<ProjectConversation, CommandError> {
    state
        .sessions
        .run(
            "create_project_conversation",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                if active.store.is_reconciling() {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::OutcomeUnknown,
                        "conversation-session",
                    )));
                }
                if let Some(receipt) = active
                    .store
                    .project_conversation_create_receipt(&request.original())
                    .map_err(map_recover)?
                {
                    return Ok(receipt);
                }
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mutation()?;
                }
                active
                    .store
                    .create_project_conversation(&request.original())
                    .map_err(map_recover)
            },
        )
        .await
}
#[tauri::command]
pub async fn append_project_conversation_message(
    state: State<'_, AppState>,
    request: AppendProjectConversationMessageRequest,
) -> Result<ProjectConversationMessage, CommandError> {
    state
        .sessions
        .run(
            "append_project_conversation_message",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                if active.store.is_reconciling() {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::OutcomeUnknown,
                        "conversation-session",
                    )));
                }
                if let Some(receipt) = active
                    .store
                    .project_conversation_message_receipt(&request.original())
                    .map_err(map_recover)?
                {
                    return Ok(receipt);
                }
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mutation()?;
                }
                active
                    .store
                    .append_project_conversation_message(&request.original())
                    .map_err(map_recover)
            },
        )
        .await
}
#[tauri::command]
pub async fn list_project_conversations(
    state: State<'_, AppState>,
    request: ListProjectConversationsRequest,
) -> Result<ProjectConversationPage, CommandError> {
    state
        .sessions
        .run(
            "list_project_conversations",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .list_project_conversations(request.project_id, request.after, request.limit)
                    .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_project_conversation(
    state: State<'_, AppState>,
    request: ReadProjectConversationRequest,
) -> Result<ProjectConversation, CommandError> {
    state
        .sessions
        .run(
            "read_project_conversation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .read_project_conversation(request.project_id, request.conversation_id)
                    .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_project_conversation_messages(
    state: State<'_, AppState>,
    request: ReadProjectConversationMessagesRequest,
) -> Result<ProjectConversationMessagePage, CommandError> {
    state
        .sessions
        .run(
            "read_project_conversation_messages",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .read_project_conversation_messages(
                        request.project_id,
                        request.conversation_id,
                        request.after,
                        request.limit,
                    )
                    .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn recover_project_conversation_create(
    state: State<'_, AppState>,
    request: CreateProjectConversationRequest,
) -> Result<ProjectConversationCreateRecovery, CommandError> {
    state
        .sessions
        .run(
            "recover_project_conversation_create",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let mut result = active
                    .store
                    .recover_project_conversation_create(&request.original())
                    .map_err(map_read)?;
                block_replay(&mut result.outcome, active);
                Ok(result)
            },
        )
        .await
}
#[tauri::command]
pub async fn recover_project_conversation_message(
    state: State<'_, AppState>,
    request: AppendProjectConversationMessageRequest,
) -> Result<ProjectConversationMessageRecovery, CommandError> {
    state
        .sessions
        .run(
            "recover_project_conversation_message",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let mut result = active
                    .store
                    .recover_project_conversation_message(&request.original())
                    .map_err(map_read)?;
                block_replay(&mut result.outcome, active);
                Ok(result)
            },
        )
        .await
}

#[cfg(test)]
mod ipc_tests;
