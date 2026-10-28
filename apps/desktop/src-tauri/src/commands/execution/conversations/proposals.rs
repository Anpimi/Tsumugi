//! Proposal versions preserve suggestions without authorizing their execution.
use super::*;
pub(in crate::commands) mod work_plans;
pub(in crate::commands) mod knowledge;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CaptureConversationProposalRequest {
        action_id: ExecutionId,
        conversation_id: ExecutionId,
        proposal_id: ExecutionId,
        revision_id: ExecutionId,
        attempt_id: ExecutionId,
        result_id: ExecutionId
    }
);
impl CaptureConversationProposalRequest {
    fn original(&self) -> CaptureConversationProposal {
        CaptureConversationProposal {
            project_id: self.project_id,
            action_id: self.action_id,
            conversation_id: self.conversation_id,
            proposal_id: self.proposal_id,
            revision_id: self.revision_id,
            attempt_id: self.attempt_id,
            result_id: self.result_id,
        }
    }
}
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviseConversationProposalRequest {
        action_id: ExecutionId,
        conversation_id: ExecutionId,
        proposal_id: ExecutionId,
        revision_id: ExecutionId,
        expected_revision_id: ExecutionId,
        content: tsumugi_core::ai::conversation_planning::ConversationPlanningModelOutput
    }
);
impl ReviseConversationProposalRequest {
    fn original(&self) -> ReviseConversationProposal {
        ReviseConversationProposal {
            project_id: self.project_id,
            action_id: self.action_id,
            conversation_id: self.conversation_id,
            proposal_id: self.proposal_id,
            revision_id: self.revision_id,
            expected_revision_id: self.expected_revision_id,
            content: self.content.clone(),
        }
    }
}
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadConversationProposalRequest {
        conversation_id: ExecutionId,
        proposal_id: ExecutionId,
        revision_id: Option<ExecutionId>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadConversationProposalRevisionsRequest {
        conversation_id: ExecutionId,
        after: Option<Revision>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 50)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ValidateConversationProposalRequest {
        conversation_id: ExecutionId,
        proposal_id: ExecutionId,
        revision_id: ExecutionId
    }
);

#[tauri::command]
pub async fn capture_conversation_proposal(
    state: State<'_, AppState>,
    request: CaptureConversationProposalRequest,
) -> Result<ConversationProposalRevision, CommandError> {
    state
        .sessions
        .run(
            "capture_conversation_proposal",
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
                        "conversation-proposal-session",
                    )));
                }
                let original = request.original();
                if let Some(receipt) = active
                    .store
                    .conversation_proposal_capture_receipt(&original)
                    .map_err(map_recover)?
                {
                    return Ok(receipt);
                }
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mutation()?;
                }
                active
                    .store
                    .capture_conversation_proposal(&original)
                    .map_err(map_recover)
            },
        )
        .await
}

#[tauri::command]
pub async fn revise_conversation_proposal(
    state: State<'_, AppState>,
    request: ReviseConversationProposalRequest,
) -> Result<ConversationProposalRevision, CommandError> {
    state
        .sessions
        .run(
            "revise_conversation_proposal",
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
                        "conversation-proposal-session",
                    )));
                }
                let original = request.original();
                if let Some(receipt) = active
                    .store
                    .conversation_proposal_revision_receipt(&original)
                    .map_err(map_recover)?
                {
                    return Ok(receipt);
                }
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mutation()?;
                }
                active
                    .store
                    .revise_conversation_proposal(&original)
                    .map_err(map_recover)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_conversation_proposal(
    state: State<'_, AppState>,
    request: ReadConversationProposalRequest,
) -> Result<ConversationProposalRevision, CommandError> {
    state
        .sessions
        .run(
            "read_conversation_proposal",
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
                    .read_conversation_proposal(
                        request.project_id,
                        request.conversation_id,
                        request.proposal_id,
                        request.revision_id,
                    )
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_conversation_proposal_revisions(
    state: State<'_, AppState>,
    request: ReadConversationProposalRevisionsRequest,
) -> Result<ConversationProposalPage, CommandError> {
    state
        .sessions
        .run(
            "read_conversation_proposal_revisions",
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
                    .read_conversation_proposal_revisions(
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
pub async fn validate_conversation_proposal(
    state: State<'_, AppState>,
    request: ValidateConversationProposalRequest,
) -> Result<ConversationProposalRevision, CommandError> {
    state
        .sessions
        .run(
            "validate_conversation_proposal",
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
                active
                    .store
                    .validate_conversation_proposal(
                        request.project_id,
                        request.conversation_id,
                        request.proposal_id,
                        request.revision_id,
                    )
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn recover_conversation_proposal_capture(
    state: State<'_, AppState>,
    request: CaptureConversationProposalRequest,
) -> Result<ConversationProposalCaptureRecovery, CommandError> {
    state
        .sessions
        .run(
            "recover_conversation_proposal_capture",
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
                    .recover_conversation_proposal_capture(&request.original())
                    .map_err(map_read)?;
                block_replay(&mut result.outcome, active);
                Ok(result)
            },
        )
        .await
}

#[tauri::command]
pub async fn recover_conversation_proposal_revision(
    state: State<'_, AppState>,
    request: ReviseConversationProposalRequest,
) -> Result<ConversationProposalRevisionRecovery, CommandError> {
    state
        .sessions
        .run(
            "recover_conversation_proposal_revision",
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
                    .recover_conversation_proposal_revision(&request.original())
                    .map_err(map_read)?;
                block_replay(&mut result.outcome, active);
                Ok(result)
            },
        )
        .await
}
