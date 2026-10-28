//! Human knowledge decisions share the original proposal and resource authority.
use super::*;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PreviewConversationKnowledgeAdoptionRequest { adoption: PrepareConversationKnowledgeAdoption }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ConversationKnowledgeDecisionRequest { decision: DecideConversationKnowledgeProposal }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadConversationKnowledgeDecisionRequest { proposal: ConversationProposalRef, entry_index: u32 }
);

fn check_project(actual: ExecutionId, expected: ExecutionId, stage: CommandStage) -> Result<(), CommandError> {
    if actual != expected {
        return Err(map_execution(ExecutionError::new(ErrorCode::Unauthorized, "conversation-knowledge-project"), stage));
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_conversation_knowledge_adoption(state: State<'_, AppState>, request: PreviewConversationKnowledgeAdoptionRequest) -> Result<ConversationKnowledgeAdoptionPreview, CommandError> {
    state.sessions.run("preview_conversation_knowledge_adoption", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        check_project(request.adoption.proposal.project_id, request.project_id, CommandStage::ExecutionRead)?;
        active.store.preview_conversation_knowledge_adoption(&request.adoption).map_err(map_read)
    }).await
}

#[tauri::command]
pub async fn decide_conversation_knowledge_proposal(state: State<'_, AppState>, request: ConversationKnowledgeDecisionRequest) -> Result<ConversationKnowledgeDecision, CommandError> {
    state.sessions.run("decide_conversation_knowledge_proposal", CommandStage::ExecutionAdopt, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionAdopt)?;
        check_project(request.decision.proposal.project_id, request.project_id, CommandStage::ExecutionAdopt)?;
        if let Some(receipt) = active.store.conversation_knowledge_decision_receipt(&request.decision).map_err(map_recover)? {
            return Ok(receipt);
        }
        if let Some(host) = active.execution.as_ref() { host.allow_mutation()?; }
        active.store.decide_conversation_knowledge_proposal(&request.decision)
            .map_err(|error| map_execution(error, CommandStage::ExecutionAdopt))
    }).await
}

#[tauri::command]
pub async fn read_conversation_knowledge_decision(state: State<'_, AppState>, request: ReadConversationKnowledgeDecisionRequest) -> Result<Option<ConversationKnowledgeDecision>, CommandError> {
    state.sessions.run("read_conversation_knowledge_decision", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        check_project(request.proposal.project_id, request.project_id, CommandStage::ExecutionRead)?;
        active.store.read_conversation_knowledge_decision(&request.proposal, request.entry_index).map_err(map_read)
    }).await
}

#[tauri::command]
pub async fn read_conversation_knowledge_decision_action(state: State<'_, AppState>, request: ConversationKnowledgeDecisionRequest) -> Result<Option<ConversationKnowledgeDecision>, CommandError> {
    state.sessions.run("read_conversation_knowledge_decision_action", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        check_project(request.decision.proposal.project_id, request.project_id, CommandStage::ExecutionRead)?;
        active.store.conversation_knowledge_decision_receipt(&request.decision).map_err(map_read)
    }).await
}

#[tauri::command]
pub async fn recover_conversation_knowledge_decision(state: State<'_, AppState>, request: ConversationKnowledgeDecisionRequest) -> Result<ConversationKnowledgeDecisionRecovery, CommandError> {
    state.sessions.run("recover_conversation_knowledge_decision", CommandStage::ExecutionRecover, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRecover)?;
        check_project(request.decision.proposal.project_id, request.project_id, CommandStage::ExecutionRecover)?;
        let mut recovered = active.store.recover_conversation_knowledge_decision(&request.decision).map_err(map_recover)?;
        block_replay(&mut recovered.outcome, active);
        Ok(recovered)
    }).await
}
