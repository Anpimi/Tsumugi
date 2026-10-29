//! Original journal requests are observed, never resolved or replayed here.
use super::*;
use crate::commands::drafts::{
    self, ConversationDraftPending, ConversationDraftResolveTarget, DraftPending, PendingActionRef,
    PendingJournalKey, PendingJournalSlot, PendingSnapshot,
    ResourceDraftPending, ResourceDraftResolveTarget, ResourceDraftDisposition,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use tsumugi_core::application::WorkPlanRequestOutcome;
use tsumugi_core::{
    DecisionAction, DecisionClientAction, DecisionClientActivity, DecisionCoverageReason,
    DecisionEvidence, DecisionItem, DecisionJournalKey, DecisionJournalSlot, DecisionLocalBasis,
    DecisionLocalObservation, DecisionLocalOutcome, DecisionLocalProjection,
    DecisionLocalRequestKind, DecisionLocalRequestRef, DecisionSource, DecisionState,
    DecisionTarget,
};

fn failure(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}

pub(super) fn validate_activity(
    activity: Option<&[DecisionClientActivity]>,
) -> Result<(), ExecutionError> {
    let Some(activity) = activity else {
        return Ok(());
    };
    if activity.len() > 64
        || activity
            .iter()
            .map(|owner| owner.actions.len())
            .sum::<usize>()
            > 1_000
    {
        return Err(failure(ErrorCode::LimitExceeded, "decision-activity"));
    }
    let mut owners = BTreeSet::new();
    let mut actions = BTreeSet::new();
    for owner in activity {
        if !owners.insert(owner.owner_id) {
            return Err(failure(ErrorCode::InvalidInput, "decision-activity"));
        }
        for action in &owner.actions {
            if !actions.insert(action.action_id) {
                return Err(failure(ErrorCode::InvalidInput, "decision-activity"));
            }
            if let DecisionJournalKey::Translation { locale, .. } = &action.key {
                if action.slot != DecisionJournalSlot::Primary
                    || !tsumugi_core::Locale::parse(locale)
                        .is_ok_and(|parsed| parsed.as_str() == locale)
                {
                    return Err(failure(ErrorCode::InvalidInput, "decision-activity"));
                }
            }
            if matches!(action.key,DecisionJournalKey::Resource)
                && !matches!(action.slot,DecisionJournalSlot::Primary|DecisionJournalSlot::ResourceFact)
                || matches!(action.key,DecisionJournalKey::Conversation{..})
                    && action.slot==DecisionJournalSlot::ResourceFact {
                return Err(failure(ErrorCode::InvalidInput,"decision-activity"));
            }
        }
    }
    Ok(())
}

fn reference(
    row: &PendingActionRef,
    project: ExecutionId,
) -> Result<DecisionLocalRequestRef, ExecutionError> {
    let key = match &row.key {
        PendingJournalKey::Translation(key) if key.project_id == project => {
            DecisionJournalKey::Translation {
                unit_id: key.unit_id,
                locale: key.locale.clone(),
            }
        }
        PendingJournalKey::Conversation(key) if key.project_id == project => {
            DecisionJournalKey::Conversation {
                conversation_id: key.conversation_id,
            }
        }
        PendingJournalKey::Resource(key) if key.project_id==project=>DecisionJournalKey::Resource,
        _ => {
            return Err(failure(
                ErrorCode::CorruptLedger,
                "decision-journal-project",
            ));
        }
    };
    let request_kind = match &row.slot {
        PendingJournalSlot::Translation(DraftPending::Save { .. }) => {
            DecisionLocalRequestKind::Save
        }
        PendingJournalSlot::Translation(DraftPending::Selection { .. }) => {
            DecisionLocalRequestKind::Selection
        }
        PendingJournalSlot::Translation(DraftPending::Merge { .. }) => {
            DecisionLocalRequestKind::Merge
        }
        PendingJournalSlot::Conversation(pending) => match pending {
            ConversationDraftPending::Create { .. } => DecisionLocalRequestKind::Create,
            ConversationDraftPending::Append { .. } => DecisionLocalRequestKind::Append,
            ConversationDraftPending::Planning { .. } => DecisionLocalRequestKind::Planning,
            ConversationDraftPending::ProposalCapture { .. } => {
                DecisionLocalRequestKind::ProposalCapture
            }
            ConversationDraftPending::ProposalRevision { .. } => {
                DecisionLocalRequestKind::ProposalRevision
            }
            ConversationDraftPending::ProposalWorkPlan { .. } => {
                DecisionLocalRequestKind::ProposalWorkPlan
            }
            ConversationDraftPending::WorkPlanStart { .. } => {
                DecisionLocalRequestKind::WorkPlanStart
            }
            ConversationDraftPending::WorkPlanControl { .. } => {
                DecisionLocalRequestKind::WorkPlanControl
            }
        },
        PendingJournalSlot::Revocation(_) => DecisionLocalRequestKind::WorkPlanControl,
        PendingJournalSlot::Resource(p)=>match p {
            ResourceDraftPending::TypedContextSave{..}=>DecisionLocalRequestKind::ResourceTypedContextSave,
            ResourceDraftPending::TypedContextWithdraw{..}=>DecisionLocalRequestKind::ResourceTypedContextWithdraw,
            ResourceDraftPending::KnowledgeDecision{..}=>DecisionLocalRequestKind::ResourceKnowledgeDecision,
            ResourceDraftPending::Correction{..}=>DecisionLocalRequestKind::ResourceCorrection,
            ResourceDraftPending::Term{..}=>DecisionLocalRequestKind::ResourceTerm,
            ResourceDraftPending::Context{..}=>DecisionLocalRequestKind::ResourceContext,
            ResourceDraftPending::Decision{..}=>DecisionLocalRequestKind::ResourceDecision,
            ResourceDraftPending::Capture{..}=>DecisionLocalRequestKind::ResourceCapture,
        },
        PendingJournalSlot::ResourceFact(_)=>DecisionLocalRequestKind::ResourceFact,
    };
    let slot = if matches!(row.slot, PendingJournalSlot::Revocation(_)) {
        DecisionJournalSlot::Revocation
    } else if matches!(row.slot,PendingJournalSlot::ResourceFact(_)){
        DecisionJournalSlot::ResourceFact
    } else {
        DecisionJournalSlot::Primary
    };
    Ok(DecisionLocalRequestRef {
        action: DecisionClientAction {
            key,
            slot,
            action_id: row.slot.action_id(),
            submitted_seq: row.slot.submitted_seq(),
        },
        request_kind,
    })
}

fn observe(
    store: &ProjectStore,
    row: &PendingActionRef,
) -> Result<DecisionLocalOutcome, ExecutionError> {
    let recorded = match (&row.key, &row.slot) {
        (
            PendingJournalKey::Translation(_),
            PendingJournalSlot::Translation(DraftPending::Save { request, .. }),
        ) => store
            .translation_save_request_observation(request)?
            .is_some(),
        (
            PendingJournalKey::Translation(_),
            PendingJournalSlot::Translation(DraftPending::Selection { request, .. }),
        ) => store
            .translation_selection_request_observation(request)?
            .is_some(),
        (
            PendingJournalKey::Translation(_),
            PendingJournalSlot::Translation(DraftPending::Merge { request, merge, .. }),
        ) => store
            .arena_merge_request_observation(request, merge)?
            .is_some(),
        (PendingJournalKey::Conversation(key), slot) => {
            let target = match slot {
                PendingJournalSlot::Conversation(pending) => {
                    ConversationDraftResolveTarget::Pending {
                        pending: pending.clone(),
                    }
                }
                PendingJournalSlot::Revocation(revocation) => {
                    ConversationDraftResolveTarget::Revocation {
                        revocation: revocation.clone(),
                    }
                }
                _ => return Err(failure(ErrorCode::CorruptLedger, "decision-journal-slot")),
            };
            return Ok(
                match drafts::observe_conversation_target(store, key, &target)? {
                    WorkPlanRequestOutcome::Recorded { .. } => DecisionLocalOutcome::Recorded,
                    WorkPlanRequestOutcome::FencedNotApplied => {
                        DecisionLocalOutcome::FencedNotApplied
                    }
                    WorkPlanRequestOutcome::Pending => DecisionLocalOutcome::ReceiptAbsent,
                },
            );
        }
        (PendingJournalKey::Resource(key),slot)=>{
            let target=match slot{
                PendingJournalSlot::Resource(pending)=>ResourceDraftResolveTarget::Primary{pending:pending.clone()},
                PendingJournalSlot::ResourceFact(pending)=>ResourceDraftResolveTarget::Fact{pending:pending.clone()},
                _=>return Err(failure(ErrorCode::CorruptLedger,"decision-journal-slot")),
            };
            return Ok(match drafts::observe_resource_target(store,key,&target)?{
                Some(ResourceDraftDisposition::Recorded)=>DecisionLocalOutcome::Recorded,
                Some(ResourceDraftDisposition::ConfirmedNotApplied)=>DecisionLocalOutcome::FencedNotApplied,
                None=>DecisionLocalOutcome::ReceiptAbsent,
            });
        }
        _ => return Err(failure(ErrorCode::CorruptLedger, "decision-journal-slot")),
    };
    Ok(if recorded {
        DecisionLocalOutcome::Recorded
    } else {
        DecisionLocalOutcome::ReceiptAbsent
    })
}

fn targets(row: &PendingActionRef) -> Vec<DecisionTarget> {
    let mut result = match &row.key {
        PendingJournalKey::Translation(key) => vec![DecisionTarget::Entry {
            unit_id: key.unit_id,
        }],
        PendingJournalKey::Conversation(key) => vec![DecisionTarget::Conversation {
            conversation_id: key.conversation_id,
        }],
        PendingJournalKey::Resource(_)=>vec![DecisionTarget::Project],
    };
    let plan = match &row.slot {
        PendingJournalSlot::Conversation(ConversationDraftPending::WorkPlanStart {
            request,
            ..
        }) => Some(request.plan_id),
        PendingJournalSlot::Conversation(ConversationDraftPending::WorkPlanControl {
            request,
            ..
        }) => Some(request.plan_id),
        PendingJournalSlot::Revocation(slot) => Some(slot.request.plan_id),
        _ => None,
    };
    if let Some(plan_id) = plan {
        result.push(DecisionTarget::Plan { plan_id });
    }
    result
}

pub(super) fn project(
    store: &ProjectStore,
    project: ExecutionId,
    snapshot: PendingSnapshot,
    activity: Option<Vec<DecisionClientActivity>>,
) -> Result<DecisionLocalProjection, ExecutionError> {
    validate_activity(activity.as_deref())?;
    let mut complete = snapshot.complete;
    let mut reason = (!complete).then_some(DecisionCoverageReason::SourceLimit);
    let mut error_code = None;
    let mut observations = Vec::new();
    let mut items = Vec::new();
    for row in snapshot.rows {
        let reference = reference(&row, project)?;
        let (mut outcome, code) = match observe(store, &row) {
            Ok(outcome) => (outcome, None),
            Err(error) => {
                complete = false;
                reason = Some(DecisionCoverageReason::SourceUnavailable);
                error_code = Some(error.code);
                (
                    if matches!(
                        error.code,
                        ErrorCode::ResultMismatch
                            | ErrorCode::CorruptLedger
                            | ErrorCode::InvalidInput
                            | ErrorCode::Unauthorized
                    ) {
                        DecisionLocalOutcome::Mismatch
                    } else {
                        DecisionLocalOutcome::Unavailable
                    },
                    Some(error.code),
                )
            }
        };
        let mut actionable = matches!(
            outcome,
            DecisionLocalOutcome::Mismatch | DecisionLocalOutcome::Unavailable
        );
        if outcome == DecisionLocalOutcome::ReceiptAbsent {
            if let Some(activity) = &activity {
                if activity
                    .iter()
                    .flat_map(|owner| &owner.actions)
                    .any(|action| action == &reference.action)
                {
                    outcome = DecisionLocalOutcome::InFlight;
                } else {
                    actionable = true;
                }
            } else {
                complete = false;
                if reason.is_none() {
                    reason = Some(DecisionCoverageReason::LifecycleUnavailable);
                }
            }
        }
        if actionable {
            let identity = match &reference.action.key {
                DecisionJournalKey::Translation { unit_id, locale } => {
                    format!("translation:{unit_id}:{locale}")
                }
                DecisionJournalKey::Conversation { conversation_id } => {
                    format!("conversation:{conversation_id}")
                }
                DecisionJournalKey::Resource=>"resource".into(),
            };
            let slot = match reference.action.slot {
                DecisionJournalSlot::Revocation=>"revocation",
                DecisionJournalSlot::ResourceFact=>"resource-fact",
                DecisionJournalSlot::Primary=>"primary",
            };
            let bytes = serde_json::to_vec(&(
                &snapshot.basis,
                &reference,
                row.head_revision,
                row.writer_id,
                outcome,
                code,
            ))
            .map_err(|_| failure(ErrorCode::InvalidInput, "decision-local-basis"))?;
            let basis = format!("{:x}", Sha256::digest(bytes));
            items.push(DecisionItem {
                decision_id: format!(
                    "local-action-recovery:{project}:{identity}:{slot}:{}",
                    reference.action.action_id
                ),
                source: DecisionSource::LocalActionRecovery,
                state: if matches!(
                    outcome,
                    DecisionLocalOutcome::Mismatch | DecisionLocalOutcome::Unavailable
                ) {
                    DecisionState::Stale
                } else {
                    DecisionState::AwaitingRecheck
                },
                locale: match &reference.action.key {
                    DecisionJournalKey::Translation { locale, .. } => Some(locale.clone()),
                    _ => None,
                },
                targets: targets(&row),
                targets_complete: true,
                basis,
                source_action_id: Some(reference.action.action_id),
                action: DecisionAction::InspectLocalRequest {
                    reference: reference.clone(),
                },
                evidence: Some(DecisionEvidence::LocalRequest {
                    outcome,
                    error_code: code,
                }),
            });
        }
        observations.push(DecisionLocalObservation {
            reference,
            head_revision: row.head_revision,
            writer_id: row.writer_id,
            outcome,
            error_code: code,
        });
    }
    Ok(DecisionLocalProjection {
        items,
        complete,
        reason,
        error_code,
        basis: DecisionLocalBasis {
            journal_basis: snapshot.basis,
            journal_complete: snapshot.complete,
            activity,
            observations,
        },
    })
}
