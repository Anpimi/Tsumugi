//! A proposal uses the original WorkPlan preparation and authorization pipeline.
use super::super::*;
use crate::commands::execution::work_plans::{
    self, WorkPlanAuthorizeRequest, WorkPlanPrepareRequest, WorkPlanReceiptView, WorkPlanView,
};
use tsumugi_core::application::{
    AuthorizeConversationProposalWorkPlan, ConversationProposalRef,
    ConversationProposalWorkPlanLink, ConversationProposalWorkPlanPage,
    ConversationProposalWorkPlanRecovery,
};

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PrepareConversationProposalWorkPlanRequest {
        proposal: ConversationProposalRef,
        config: Option<tsumugi_core::ai::AiConfig>,
        advisory_checks: Vec<crate::commands::plugins::reviews::PluginTextReviewSelection>,
        tool_selection: Option<work_plans::broker::WorkPlanToolSelection>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AuthorizeConversationProposalWorkPlanRequest {
        authorization: AuthorizeConversationProposalWorkPlan
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadConversationProposalWorkPlanRequest {
        conversation_id: ExecutionId,
        plan_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadConversationProposalWorkPlansRequest {
        conversation_id: ExecutionId,
        after: Option<Revision>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 50)))]
        limit: u32
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalWorkPlanView {
    pub proposal: ConversationProposalRef,
    pub plan: WorkPlanView,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalWorkPlanReceiptView {
    pub link: ConversationProposalWorkPlanLink,
    pub receipt: WorkPlanReceiptView,
}

#[tauri::command]
pub async fn prepare_conversation_proposal_work_plan(
    state: State<'_, AppState>,
    request: PrepareConversationProposalWorkPlanRequest,
) -> Result<ConversationProposalWorkPlanView, CommandError> {
    let source = request.clone();
    let prepared = state.sessions.run(
        "prepare_conversation_proposal_work_plan.source", CommandStage::ExecutionRead, move |sessions| {
            let active = authorized(sessions, &source.session_token, source.project_id, CommandStage::ExecutionRead)?;
            if source.project_id != source.proposal.project_id {
                return Err(map_read(ExecutionError::new(ErrorCode::Unauthorized, "conversation-proposal-project")));
            }
            let revision = active.store.validate_conversation_proposal(source.project_id, source.proposal.conversation_id, source.proposal.proposal_id, source.proposal.revision_id).map_err(map_read)?;
            let tsumugi_core::ai::conversation_planning::ConversationPlanningModelOutput::Proposal { unit_ids, options, questions, .. } = revision.content else {
                return Err(map_read(ExecutionError::new(ErrorCode::InvalidInput, "conversation-proposal-content")));
            };
            if !questions.is_empty() {
                return Err(map_read(ExecutionError::new(ErrorCode::DependencyConflict, "conversation-proposal-questions")));
            }
            let input = active.store.execution_input(revision.origin.attempt_id).map_err(map_read)?;
            let preview = tsumugi_core::ai::conversation_planning::preview_from_input(&input).map_err(map_read)?;
            let tsumugi_core::application::ConversationPlanningScope::Units { locale, .. } = preview.scope else {
                return Err(map_read(ExecutionError::new(ErrorCode::InvalidInput, "conversation-proposal-scope")));
            };
            Ok(WorkPlanPrepareRequest {
                project_id: source.project_id, session_token: source.session_token,
                config: source.config, locale, unit_ids, options,
                advisory_checks: source.advisory_checks, tool_selection: source.tool_selection, maintenance: None,
            })
        }
    ).await?;
    let reference = request.proposal;
    let plan =
        work_plans::prepare_work_plan_with_proposal(state, prepared, Some(reference.clone()))
            .await?;
    Ok(ConversationProposalWorkPlanView {
        proposal: reference,
        plan,
    })
}

#[tauri::command]
pub async fn authorize_conversation_proposal_work_plan(
    state: State<'_, AppState>,
    request: AuthorizeConversationProposalWorkPlanRequest,
) -> Result<ConversationProposalWorkPlanReceiptView, CommandError> {
    let authorization = request.authorization;
    if request.project_id != authorization.proposal.project_id {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::Unauthorized,
            "conversation-proposal-project",
        )));
    }
    let inner = WorkPlanAuthorizeRequest {
        project_id: request.project_id,
        session_token: request.session_token,
        plan_id: authorization.plan_id,
        digest: authorization.plan_digest.clone(),
        action_id: authorization.action_id,
        confirmed: authorization.confirmed,
        checker_executions: authorization.checker_executions.clone(),
        tool_execution: authorization.tool_execution,
        application_tool_executions: authorization.application_tool_executions.clone(),
        effects: authorization.effects.clone(),
        expires_at: authorization.expires_at,
    };
    let (receipt, link) =
        work_plans::authorize_work_plan_with_proposal(state, inner, Some(authorization)).await?;
    let link = link.ok_or_else(|| {
        map_recover(ExecutionError::new(
            ErrorCode::CorruptLedger,
            "conversation-proposal-work-plan-receipt",
        ))
    })?;
    Ok(ConversationProposalWorkPlanReceiptView { link, receipt })
}

#[tauri::command]
pub async fn recover_conversation_proposal_work_plan(
    state: State<'_, AppState>,
    request: AuthorizeConversationProposalWorkPlanRequest,
) -> Result<ConversationProposalWorkPlanRecovery, CommandError> {
    state
        .sessions
        .run(
            "recover_conversation_proposal_work_plan",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                if request.project_id != request.authorization.proposal.project_id {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "conversation-proposal-project",
                    )));
                }
                active
                    .store
                    .recover_conversation_proposal_work_plan(&request.authorization)
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_conversation_proposal_work_plan(
    state: State<'_, AppState>,
    request: ReadConversationProposalWorkPlanRequest,
) -> Result<ConversationProposalWorkPlanLink, CommandError> {
    state
        .sessions
        .run(
            "read_conversation_proposal_work_plan",
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
                    .read_conversation_proposal_work_plan(
                        request.project_id,
                        request.conversation_id,
                        request.plan_id,
                    )
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_conversation_proposal_work_plans(
    state: State<'_, AppState>,
    request: ReadConversationProposalWorkPlansRequest,
) -> Result<ConversationProposalWorkPlanPage, CommandError> {
    state
        .sessions
        .run(
            "read_conversation_proposal_work_plans",
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
                    .read_conversation_proposal_work_plans(
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
