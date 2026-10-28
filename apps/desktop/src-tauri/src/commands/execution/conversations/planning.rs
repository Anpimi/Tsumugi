//! Session-local material preparation. A capture is not a model permission.
use super::*;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PrepareConversationPlanningRequest {
        conversation_id: ExecutionId,
        selected_message_ids: Vec<ExecutionId>,
        scope: ConversationPlanningScope,
        config: tsumugi_core::ai::AiConfig
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ValidateConversationPlanningRequest {
        preparation_id: ExecutionId
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PreparedConversationPlanning {
    pub preparation_id: ExecutionId,
    pub preview: ConversationPlanningPreview,
}

#[tauri::command]
pub async fn prepare_conversation_planning(
    state: State<'_, AppState>,
    request: PrepareConversationPlanningRequest,
) -> Result<PreparedConversationPlanning, CommandError> {
    state
        .sessions
        .run(
            "prepare_conversation_planning",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mutation()?;
                }
                let capture = active
                    .store
                    .prepare_conversation_planning(&PrepareConversationPlanning {
                        project_id: request.project_id,
                        conversation_id: request.conversation_id,
                        selected_message_ids: request.selected_message_ids,
                        scope: request.scope,
                        config: request.config,
                    })
                    .map_err(map_read)?;
                let preparation_id = ExecutionId::new();
                let view = PreparedConversationPlanning {
                    preparation_id,
                    preview: capture.preview().clone(),
                };
                // Replace only after the complete new read succeeds. Failed preparation
                // leaves the previous capture available under its original identity.
                active.conversation_planning = Some(PlanningPreparation {
                    preparation_id,
                    capture,
                });
                Ok(view)
            },
        )
        .await
}

#[tauri::command]
pub async fn validate_conversation_planning(
    state: State<'_, AppState>,
    request: ValidateConversationPlanningRequest,
) -> Result<PreparedConversationPlanning, CommandError> {
    state
        .sessions
        .run(
            "validate_conversation_planning",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mutation()?;
                }
                let prepared = active
                    .conversation_planning
                    .as_ref()
                    .filter(|prepared| prepared.preparation_id == request.preparation_id)
                    .ok_or_else(|| {
                        map_read(ExecutionError::new(
                            ErrorCode::ResultMismatch,
                            "conversation-planning-preparation",
                        ))
                    })?;
                active
                    .store
                    .validate_conversation_planning(&prepared.capture)
                    .map_err(map_read)?;
                Ok(PreparedConversationPlanning {
                    preparation_id: prepared.preparation_id,
                    preview: prepared.capture.preview().clone(),
                })
            },
        )
        .await
}
