//! Pure original-request checks shared by journal resolution and inbox reads.
use super::*;
use tsumugi_core::application::WorkPlanRequestOutcome;

fn without_receipt<R>(outcome: WorkPlanRequestOutcome<R>) -> WorkPlanRequestOutcome<()> {
    match outcome {
        WorkPlanRequestOutcome::Recorded { .. } => WorkPlanRequestOutcome::Recorded { receipt: () },
        WorkPlanRequestOutcome::FencedNotApplied => WorkPlanRequestOutcome::FencedNotApplied,
        WorkPlanRequestOutcome::Pending => WorkPlanRequestOutcome::Pending,
    }
}

pub(in crate::commands) fn observe_conversation_target(
    store: &ProjectStore,
    key: &ConversationDraftKey,
    target: &ConversationDraftResolveTarget,
) -> Result<WorkPlanRequestOutcome<()>, ExecutionError> {
    if let ConversationDraftResolveTarget::Revocation { revocation } = target {
        let request = &revocation.request;
        if request.project_id != key.project_id {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "conversation-drafts-revocation",
            ));
        }
        store.read_conversation_proposal_work_plan(
            key.project_id,
            key.conversation_id,
            request.plan_id,
        )?;
        let proof = store.work_plan_control_settlement(
            request.project_id,
            &tsumugi_core::application::ControlWorkPlan {
                action_id: request.action_id,
                plan_id: request.plan_id,
                expected_generation: request.expected_generation,
                command: request.command.into(),
                confirmed: false,
                expires_at: None,
            },
        )?;
        return Ok(without_receipt(proof.outcome));
    }
    let ConversationDraftResolveTarget::Pending { pending } = target else {
        unreachable!("revocation handled above");
    };
    let recorded = match pending {
        ConversationDraftPending::Create { request, .. }
            if request.project_id == key.project_id
                && request.conversation_id == key.conversation_id =>
        {
            store
                .project_conversation_create_receipt(request)?
                .is_some()
        }
        ConversationDraftPending::Append { request, .. }
            if request.project_id == key.project_id
                && request.conversation_id == key.conversation_id =>
        {
            store
                .project_conversation_message_receipt(request)?
                .is_some()
        }
        ConversationDraftPending::Planning { request, .. }
            if request.project_id == key.project_id
                && request.conversation_id == key.conversation_id =>
        {
            store.conversation_planning_receipt(request)?.is_some()
        }
        ConversationDraftPending::ProposalCapture { request, .. }
            if request.project_id == key.project_id
                && request.conversation_id == key.conversation_id =>
        {
            store
                .conversation_proposal_capture_receipt(request)?
                .is_some()
        }
        ConversationDraftPending::ProposalRevision { request, .. }
            if request.project_id == key.project_id
                && request.conversation_id == key.conversation_id =>
        {
            store
                .conversation_proposal_revision_receipt(request)?
                .is_some()
        }
        ConversationDraftPending::ProposalWorkPlan { request, .. }
            if request.proposal.project_id == key.project_id
                && request.proposal.conversation_id == key.conversation_id =>
        {
            store
                .conversation_proposal_work_plan_receipt(request)?
                .is_some()
        }
        ConversationDraftPending::WorkPlanStart {
            conversation_id,
            request,
            expected_attempt_id,
            ..
        } if request.project_id == key.project_id && *conversation_id == key.conversation_id => {
            store.read_conversation_proposal_work_plan(
                key.project_id,
                key.conversation_id,
                request.plan_id,
            )?;
            let proof = store.work_plan_start_settlement(
                request.project_id,
                request.plan_id,
                request.action_id,
                request.expected_generation,
                *expected_attempt_id,
            )?;
            return Ok(without_receipt(proof.outcome));
        }
        ConversationDraftPending::WorkPlanControl {
            conversation_id,
            request,
            ..
        } if request.project_id == key.project_id && *conversation_id == key.conversation_id => {
            store.read_conversation_proposal_work_plan(
                key.project_id,
                key.conversation_id,
                request.plan_id,
            )?;
            // Core records this transition projection. Host checker and tool
            // inputs stay in the local journal and never reinstall consent.
            let proof = store.work_plan_control_settlement(
                request.project_id,
                &tsumugi_core::application::ControlWorkPlan {
                    action_id: request.action_id,
                    plan_id: request.plan_id,
                    expected_generation: request.expected_generation,
                    command: request.command,
                    confirmed: request.confirmed,
                    expires_at: request
                        .expires_at
                        .map(tsumugi_core::execution::UnsignedDecimal::get),
                },
            )?;
            return Ok(without_receipt(proof.outcome));
        }
        ConversationDraftPending::TeamMessage { conversation_id, request, .. }
            if request.project_id == key.project_id && *conversation_id == key.conversation_id =>
        {
            store.read_conversation_proposal_work_plan(key.project_id, key.conversation_id, request.lease.plan_id)?;
            let proof = store.human_team_message_settlement(
                request.project_id, &request.lease,
                crate::commands::execution::work_plans::team::LOCAL_ACTOR, &request.message,
            )?;
            return Ok(without_receipt(proof.outcome));
        }
        ConversationDraftPending::TeamPublication { conversation_id, request, .. }
            if request.project_id == key.project_id && *conversation_id == key.conversation_id =>
        {
            store.read_conversation_proposal_work_plan(key.project_id, key.conversation_id, request.lease.plan_id)?;
            let proof = store.human_team_publication_settlement(
                request.project_id, &request.lease,
                crate::commands::execution::work_plans::team::LOCAL_ACTOR, &request.publication,
            )?;
            return Ok(without_receipt(proof.outcome));
        }
        ConversationDraftPending::TeamRecovery { conversation_id, request, authorization, .. }
            if request.project_id == key.project_id && *conversation_id == key.conversation_id =>
        {
            store.read_conversation_proposal_work_plan(key.project_id, key.conversation_id, request.recovery.plan_id)?;
            if let Some(authorization) = authorization {
                let proof = crate::commands::execution::work_plans::recovery::observe_settlement(store, request, authorization)?;
                return Ok(without_receipt(proof.outcome));
            }
            let state = store.read_team_recovery_state(request.project_id, request.recovery.plan_id)?;
            return Ok(if state.lease.generation > request.recovery.expected_lease.generation {
                WorkPlanRequestOutcome::FencedNotApplied
            } else {
                WorkPlanRequestOutcome::Pending
            });
        }
        _ => {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "conversation-drafts-pending",
            ));
        }
    };
    Ok(if recorded {
        WorkPlanRequestOutcome::Recorded { receipt: () }
    } else {
        WorkPlanRequestOutcome::Pending
    })
}
