//! Session-local material preparation. A capture is not a model permission.
use super::*;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PrepareConversationPlanningRequest {
        conversation_id: ExecutionId,
        selected_message_ids: Vec<ExecutionId>,
        scope: ConversationPlanningScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        purpose: Option<ConversationPlanningPurpose>,
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
    pub preview_digest: String,
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
                        purpose: request.purpose,
                        config: request.config,
                    })
                    .map_err(map_read)?;
                let preparation_id = ExecutionId::new();
                let view = PreparedConversationPlanning {
                    preparation_id,
                    preview_digest: capture.preview_digest().map_err(map_read)?,
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
                    preview_digest: prepared.capture.preview_digest().map_err(map_read)?,
                    preview: prepared.capture.preview().clone(),
                })
            },
        )
        .await
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    StartConversationPlanningRequest {
        preparation_id: ExecutionId,
        conversation_id: ExecutionId,
        consent: ConversationPlanningConsent
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    RecoverConversationPlanningRequest {
        conversation_id: ExecutionId,
        consent: ConversationPlanningConsent
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadConversationPlanningRequest {
        conversation_id: ExecutionId,
        attempt_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadConversationPlanningAttemptsRequest {
        conversation_id: ExecutionId,
        after: Revision,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 50)))]
        limit: u32
    }
);

#[tauri::command]
pub async fn read_conversation_planning_attempts(
    state: State<'_, AppState>,
    request: ReadConversationPlanningAttemptsRequest,
) -> Result<ConversationPlanningAttemptPage, CommandError> {
    state
        .sessions
        .run(
            "read_conversation_planning_attempts",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active.store.conversation_planning_attempts(
                    request.project_id,
                    request.conversation_id,
                    request.after,
                    request.limit,
                ).map_err(map_read)
            },
        )
        .await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningOutputView {
    pub model: tsumugi_core::ai::conversation_planning::ConversationPlanningModelOutput,
    pub usage: Option<ai_wire::AiUsageView>,
    pub requests: u32,
    pub usage_incomplete: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningView {
    pub receipt: ConversationPlanningReceipt,
    pub preview: ConversationPlanningPreview,
    pub detail: AttemptDetail,
    pub budget: Option<tsumugi_core::ProviderBudget>,
    pub result_id: Option<ExecutionId>,
    pub output: Option<ConversationPlanningOutputView>,
}

#[tauri::command]
pub async fn start_conversation_planning(
    state: State<'_, AppState>,
    request: StartConversationPlanningRequest,
) -> Result<ConversationPlanningReceipt, CommandError> {
    let connections = crate::commands::connections::captured_store(&state);
    state
        .sessions
        .run(
            "start_conversation_planning",
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
                        "conversation-planning-session",
                    )));
                }
                let original = ReadConversationPlanningAction {
                    project_id: request.project_id,
                    conversation_id: request.conversation_id,
                    consent: request.consent.clone(),
                };
                // A recorded start is history even after expiry or stopping. Do not
                // recreate a runtime or permission merely to return its receipt.
                if let Some(receipt) = active
                    .store
                    .conversation_planning_receipt(&original)
                    .map_err(map_recover)?
                {
                    return Ok(receipt);
                }
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mutation()?;
                }
                let capture = active
                    .conversation_planning
                    .as_ref()
                    .filter(|prepared| {
                        prepared.preparation_id == request.preparation_id
                            && prepared.capture.preview().conversation_id == request.conversation_id
                    })
                    .ok_or_else(|| {
                        map_recover(ExecutionError::new(
                            ErrorCode::ResultMismatch,
                            "conversation-planning-preparation",
                        ))
                    })?
                    .capture
                    .clone();
                crate::commands::connections::verify_configs(
                    connections.as_ref(),
                    std::slice::from_ref(&capture.preview().config),
                )?;
                let prepared = active
                    .store
                    .authorize_conversation_planning(&capture, &request.consent)
                    .map_err(map_recover)?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                host.runtime
                    .submit_conversation_planning(store, &prepared)
                    .map_err(map_recover)
            },
        )
        .await
}

#[tauri::command]
pub async fn recover_conversation_planning(
    state: State<'_, AppState>,
    request: RecoverConversationPlanningRequest,
) -> Result<ConversationPlanningRecovery, CommandError> {
    state
        .sessions
        .run(
            "recover_conversation_planning",
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
                    .recover_conversation_planning(&ReadConversationPlanningAction {
                        project_id: request.project_id,
                        conversation_id: request.conversation_id,
                        consent: request.consent,
                    })
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_conversation_planning(
    state: State<'_, AppState>,
    request: ReadConversationPlanningRequest,
) -> Result<Option<ConversationPlanningView>, CommandError> {
    state
        .sessions
        .run(
            "read_conversation_planning",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let Some(input) = active
                    .store
                    .execution_input_if_present(request.attempt_id)
                    .map_err(map_read)?
                else {
                    return Ok(None);
                };
                let preview = tsumugi_core::ai::conversation_planning::preview_from_input(&input)
                    .map_err(map_read)?;
                if preview.project_id != request.project_id
                    || preview.conversation_id != request.conversation_id
                {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "conversation-planning-history",
                    )));
                }
                let consent = tsumugi_core::ai::conversation_planning::consent_from_input(&input)
                    .map_err(map_read)?;
                let receipt = active
                    .store
                    .conversation_planning_receipt(&ReadConversationPlanningAction {
                        project_id: request.project_id,
                        conversation_id: request.conversation_id,
                        consent,
                    })
                    .map_err(map_read)?
                    .ok_or_else(|| {
                        map_read(ExecutionError::new(
                            ErrorCode::CorruptLedger,
                            "conversation-planning-history",
                        ))
                    })?;
                let running = active
                    .execution
                    .as_ref()
                    .is_some_and(|host| host.runtime.is_active(request.attempt_id));
                let detail = active
                    .store
                    .execution_attempt_detail(request.attempt_id, running, 0, 1)
                    .map_err(map_read)?;
                let result_id = active
                    .store
                    .execution_current_result(request.attempt_id, receipt.consent.action_id)
                    .map_err(map_read)?;
                let output = match result_id {
                    Some(id) => {
                        let result = active
                            .store
                            .execution_result(request.attempt_id, id)
                            .map_err(map_read)?;
                        if result.envelope().outcome == ExecutionState::Succeeded
                            && detail.items.first().is_some_and(|item| {
                                item.status.validation == ValidationState::Valid
                            })
                        {
                            let output = tsumugi_core::ai::conversation_planning::validate_output(
                                &input, &result,
                            )
                            .map_err(map_read)?;
                            Some(ConversationPlanningOutputView {
                                model: output.model,
                                usage: output.usage.map(Into::into),
                                requests: output.requests,
                                usage_incomplete: output.usage_incomplete,
                            })
                        } else {
                            None
                        }
                    }
                    None => None,
                };
                let budget = active
                    .store
                    .provider_budget(receipt.consent.task_id)
                    .map_err(map_read)?;
                let view = ConversationPlanningView {
                    receipt,
                    preview,
                    detail,
                    budget,
                    result_id,
                    output,
                };
                if serde_json::to_vec(&view)
                    .map_err(|_| {
                        map_read(ExecutionError::new(
                            ErrorCode::CorruptLedger,
                            "conversation-planning-view",
                        ))
                    })?
                    .len()
                    > MAX_CONVERSATION_PLANNING_PREVIEW_BYTES
                {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::LimitExceeded,
                        "conversation-planning-view",
                    )));
                }
                Ok(Some(view))
            },
        )
        .await
}
