//! Knowledge decisions are original conversation actions; context remains the
//! only writable knowledge authority. Model output contains no destination IDs.
use super::*;
use crate::persistence::resources;
use crate::{
    ContextResourceAction, ContextResourceRevision, ContextResourceScope, SaveContextResource,
};

pub(super) fn source_current(
    c: &Connection,
    evidence: &OriginEvidence,
) -> Result<(), ExecutionError> {
    let scope = crate::persistence::content::scope(c)?;
    let ConversationPlanningScope::Units { locale, unit_ids } = &evidence.preview.scope else {
        return Err(fail(ErrorCode::DependencyConflict, "knowledge-source"));
    };
    let metadata = read_metadata_from(c).map_err(|_| corrupt())?;
    if !metadata
        .target_locales()
        .iter()
        .any(|l| l.as_str() == locale)
    {
        return Err(fail(ErrorCode::DependencyConflict, "knowledge-locale"));
    }
    for unit in unit_ids {
        let basis = evidence
            .preview
            .units
            .iter()
            .find(|b| b.unit_id == *unit)
            .ok_or_else(corrupt)?;
        if scope.current_snapshot != Some(basis.source_snapshot_id) {
            return Err(fail(ErrorCode::DependencyConflict, "knowledge-source"));
        }
        let matches:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_occurrences WHERE snapshot_id=?1 AND unit_id=?2 AND revision_id=?3)",params![basis.source_snapshot_id.to_string(),unit.to_string(),basis.source_revision_id.to_string()],|r|r.get(0)).map_err(sql)?;
        if !matches {
            return Err(fail(ErrorCode::DependencyConflict, "knowledge-source"));
        }
    }
    Ok(())
}

fn entry_in(
    c: &Connection,
    source: &ConversationProposalRef,
    index: u32,
) -> Result<
    (
        ConversationProposalRevision,
        ConversationKnowledgeEntry,
        OriginEvidence,
    ),
    ExecutionError,
> {
    let revision = revision_in(
        c,
        source.project_id,
        source.conversation_id,
        source.proposal_id,
        source.revision_id,
    )?;
    let ConversationPlanningModelOutput::KnowledgeProposal { entries, .. } = &revision.content
    else {
        return Err(fail(ErrorCode::InvalidInput, "knowledge-proposal-kind"));
    };
    let entry = entries
        .get(index as usize)
        .cloned()
        .ok_or_else(|| fail(ErrorCode::InvalidInput, "knowledge-proposal-entry"))?;
    let evidence = origin_in(
        c,
        source.project_id,
        source.conversation_id,
        revision.origin.attempt_id,
        revision.origin.result_id,
    )?;
    Ok((revision, entry, evidence))
}

fn preview_in(
    c: &Connection,
    r: &PrepareConversationKnowledgeAdoption,
) -> Result<ConversationKnowledgeAdoptionPreview, ExecutionError> {
    let (revision, entry, evidence) = entry_in(c, &r.proposal, r.entry_index)?;
    if head(c, r.proposal.proposal_id)? != Some(r.proposal.revision_id) {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "conversation-proposal-head",
        ));
    }
    let ConversationPlanningModelOutput::KnowledgeProposal { questions, .. } = &revision.content
    else {
        return Err(corrupt());
    };
    if !questions.is_empty() {
        return Err(fail(
            ErrorCode::Unauthorized,
            "knowledge-proposal-questions",
        ));
    }
    source_current(c, &evidence)?;
    if decision_action(c, &r.proposal, r.entry_index)?.is_some() {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "knowledge-proposal-decided",
        ));
    }
    let ConversationPlanningScope::Units { locale, .. } = &evidence.preview.scope else {
        return Err(corrupt());
    };
    resources::check_context_resource_scope(c, r.proposal.project_id, &r.scope)?;
    let current = r
        .context_id
        .map(|id| resources::current_context_resource_in(c, r.proposal.project_id, id))
        .transpose()?
        .flatten();
    if r.context_id.is_some() && current.is_none() {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "context-resource-current",
        ));
    }
    if current.as_ref().is_some_and(|v| {
        v.kind != entry.kind
            || v.locale != *locale
            || r.subject_id.is_some_and(|id| id != v.subject_id)
    }) {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "context-resource-identity",
        ));
    }
    let subject = r
        .subject_id
        .map(|id| resources::current_context_resource_in(c, r.proposal.project_id, id))
        .transpose()?
        .flatten();
    if r.subject_id.is_some()
        && subject.as_ref().is_none_or(|s| {
            s.context_id != s.subject_id || s.kind != entry.kind || s.locale != *locale
        })
    {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "context-resource-subject",
        ));
    }
    let source_basis = crate::persistence::content::scope(c)?;
    let requires_wider_confirmation =
        !matches!(&r.scope,ContextResourceScope::Unit{unit_id} if entry.unit_ids.contains(unit_id));
    let subject_basis = subject
        .as_ref()
        .map(|v| (v.context_id, v.subject_id, v.kind, v.locale.as_str()));
    let basis = codec::digest(&codec::encode(
        &(
            &r.proposal,
            r.entry_index,
            &entry,
            &current,
            &r.scope,
            &source_basis,
            subject_basis,
        ),
        MAX_RECORD,
    )?);
    Ok(ConversationKnowledgeAdoptionPreview {
        proposal: r.proposal.clone(),
        entry_index: r.entry_index,
        entry,
        current,
        subject,
        scope: r.scope.clone(),
        source_basis,
        basis,
        requires_wider_confirmation,
    })
}

fn decision_action(
    c: &Connection,
    p: &ConversationProposalRef,
    index: u32,
) -> Result<Option<ExecutionId>, ExecutionError> {
    c.query_row("SELECT action_id FROM application_conversation_actions WHERE json_extract(CAST(request AS TEXT),'$.kind')='decide-knowledge-proposal' AND json_extract(CAST(request AS TEXT),'$.request.proposal.revisionId')=?1 AND json_extract(CAST(request AS TEXT),'$.request.entryIndex')=?2 LIMIT 1",params![p.revision_id.to_string(),index],|r|r.get::<_,String>(0)).optional().map_err(sql)?.map(|v|ExecutionId::parse(&v)).transpose()
}

pub(in crate::persistence::application::conversations) fn validate_receipt(
    c: &Connection,
    r: &DecideConversationKnowledgeProposal,
    v: &ConversationKnowledgeDecision,
) -> Result<(), ExecutionError> {
    if r.action_id != v.action_id
        || r.proposal != v.proposal
        || r.entry_index != v.entry_index
        || r.decision != v.decision
        || r.actor != v.actor
        || r.reason != v.reason
        || r.actor.trim().is_empty()
        || r.actor.len() > 512
        || r.reason.trim().is_empty()
        || r.reason.len() > 4096
        || r.actor.contains('\0')
        || r.reason.contains('\0')
    {
        return Err(corrupt());
    }
    let (_, entry, evidence) = entry_in(c, &r.proposal, r.entry_index)?;
    match (&r.decision, &r.adoption, &v.resource) {
        (ConversationKnowledgeDecisionKind::Adopt, Some(a), Some(resource)) => {
            let actual = resources::context_resource_revision_in(c, resource.revision_id)?
                .ok_or_else(corrupt)?;
            let ConversationPlanningScope::Units { locale, .. } = &evidence.preview.scope else {
                return Err(corrupt());
            };
            let origin = ContextResourceProposalOrigin {
                proposal: r.proposal.clone(),
                entry_index: r.entry_index,
                model_origin: evidence.origin,
            };
            if &actual != resource
                || resource.proposal_origin.as_ref() != Some(&origin)
                || resource.action_id != r.action_id
                || resource.project_id != r.proposal.project_id
                || resource.kind != entry.kind
                || resource.locale != *locale
                || resource.scope != a.scope
                || resource.source_basis != a.source_basis
                || resource.name != a.name
                || resource.text != a.text
                || resource.actor != r.actor
                || resource.reason != r.reason
                || resource.previous_revision_id != a.expected_revision_id
                || resource.withdrawn
                || a.context_id.is_some_and(|id| id != resource.context_id)
                || a.subject_id.is_some_and(|id| id != resource.subject_id)
            {
                return Err(corrupt());
            }
            if a.context_id.is_none()
                && a.subject_id.is_none()
                && resource.subject_id != resource.context_id
            {
                return Err(corrupt());
            }
        }
        (
            ConversationKnowledgeDecisionKind::Keep | ConversationKnowledgeDecisionKind::Reject,
            None,
            None,
        ) => {}
        _ => return Err(corrupt()),
    }
    Ok(())
}

/// Validate the mutation's causal link without calling the recursive action
/// reader. The conversation row is the sole authority for the human decision.
pub(in crate::persistence) fn validate_context_origin(
    c: &Connection,
    v: &ContextResourceRevision,
) -> Result<(), ExecutionError> {
    let Some(origin) = &v.proposal_origin else {
        return Ok(());
    };
    let action = decision_action(c, &origin.proposal, origin.entry_index)?.ok_or_else(corrupt)?;
    let row:(Vec<u8>,String,Vec<u8>,String)=c.query_row("SELECT request,request_digest,receipt,receipt_digest FROM application_conversation_actions WHERE action_id=?1",[action.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql)?;
    let request: Action = decode(&row.0, &row.1)?;
    let receipt: Receipt = decode(&row.2, &row.3)?;
    let (Action::DecideKnowledgeProposal { request }, Receipt::KnowledgeDecision { receipt }) =
        (request, receipt)
    else {
        return Err(corrupt());
    };
    let Some(resource) = receipt.resource else {
        return Err(corrupt());
    };
    if request.decision != ConversationKnowledgeDecisionKind::Adopt
        || request.proposal != origin.proposal
        || request.entry_index != origin.entry_index
        || resource.context_id != v.context_id
        || resource.proposal_origin.as_ref() != Some(origin)
    {
        return Err(corrupt());
    }
    if action == v.action_id && resource != *v {
        return Err(corrupt());
    }
    Ok(())
}

fn check_comparison(preview:&ConversationKnowledgeAdoptionPreview,a:&crate::application::ConversationKnowledgeAdoption)->Result<(),ExecutionError>{
                if preview.basis != a.comparison_basis
                    || preview.source_basis != a.source_basis
                    || preview.current.as_ref().map(|v| v.revision_id) != a.expected_revision_id
                {
                    return Err(fail(
                        ErrorCode::DependencyConflict,
                        "knowledge-proposal-comparison",
                    ));
                }
                Ok(())
}

fn check_decision_current(c:&Connection,r:&DecideConversationKnowledgeProposal)->Result<(),ExecutionError>{
        if head(c, r.proposal.proposal_id)? != Some(r.proposal.revision_id) {
            return Err(fail(
                ErrorCode::DependencyConflict,
                "conversation-proposal-head",
            ));
        }
        if decision_action(c, &r.proposal, r.entry_index)?.is_some() {
            return Err(fail(
                ErrorCode::DependencyConflict,
                "knowledge-proposal-decided",
            ));
        }
        Ok(())
}

impl ProjectStore {
    pub fn conversation_knowledge_decision_settlement_observation(&self,r:&DecideConversationKnowledgeProposal)
        ->Result<Option<ConversationKnowledgeDecision>,ExecutionError>{
        read_snapshot(self.connection().map_err(|_|fail(ErrorCode::StorageFailed,"knowledge-proposal-read"))?,|c|{
            let value=self.conversation_knowledge_decision_receipt(r)?;
            if value.is_none(){
                entry_in(c,&r.proposal,r.entry_index)?;check_decision_current(c,r)?;
                if let (ConversationKnowledgeDecisionKind::Adopt,Some(a))=(&r.decision,&r.adoption){
                    let preview=preview_in(c,&PrepareConversationKnowledgeAdoption{proposal:r.proposal.clone(),
                        entry_index:r.entry_index,context_id:a.context_id,subject_id:a.subject_id,scope:a.scope.clone()})?;
                    check_comparison(&preview,a)?;
                }
            }
            Ok(value)
        })
    }
    pub fn preview_conversation_knowledge_adoption(
        &self,
        r: &PrepareConversationKnowledgeAdoption,
    ) -> Result<ConversationKnowledgeAdoptionPreview, ExecutionError> {
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "knowledge-proposal-read"))?,
            |c| preview_in(c, r),
        )
    }
    pub fn decide_conversation_knowledge_proposal(
        &self,
        r: &DecideConversationKnowledgeProposal,
    ) -> Result<ConversationKnowledgeDecision, ExecutionError> {
        if let Some(saved) = self.conversation_knowledge_decision_receipt(r)? {
            return Ok(saved);
        }
        let mut tx = self.execution_write_scoped(ChangeScope::Project)?;
        let request = Action::DecideKnowledgeProposal { request: r.clone() };
        if let Some(Receipt::KnowledgeDecision { receipt }) = original(&tx, &request)? {
            return Ok(receipt);
        }
        let (revision, _, evidence) = entry_in(&tx, &r.proposal, r.entry_index)?;
        check_decision_current(&tx,r)?;
        if r.actor.trim().is_empty()
            || r.actor.len() > 512
            || r.reason.trim().is_empty()
            || r.reason.len() > 4096
            || r.actor.contains('\0')
            || r.reason.contains('\0')
        {
            return Err(fail(ErrorCode::InvalidInput, "knowledge-proposal-reason"));
        }
        let resource = match (&r.decision, &r.adoption) {
            (ConversationKnowledgeDecisionKind::Adopt, Some(a)) => {
                let preview = preview_in(
                    &tx,
                    &PrepareConversationKnowledgeAdoption {
                        proposal: r.proposal.clone(),
                        entry_index: r.entry_index,
                        context_id: a.context_id,
                        subject_id: a.subject_id,
                        scope: a.scope.clone(),
                    },
                )?;
                check_comparison(&preview,a)?;
                if preview.requires_wider_confirmation && !a.confirm_wider_scope {
                    return Err(fail(
                        ErrorCode::Unauthorized,
                        "knowledge-proposal-wider-scope",
                    ));
                }
                let ConversationPlanningScope::Units { locale, .. } = &evidence.preview.scope
                else {
                    return Err(corrupt());
                };
                let save = SaveContextResource {
                    project_id: r.proposal.project_id,
                    action_id: r.action_id,
                    context_id: a.context_id,
                    subject_id: a.subject_id,
                    expected_revision_id: a.expected_revision_id,
                    source_basis: a.source_basis.clone(),
                    kind: preview.entry.kind,
                    locale: locale.clone(),
                    scope: a.scope.clone(),
                    name: a.name.clone(),
                    text: a.text.clone(),
                    actor: r.actor.clone(),
                    reason: r.reason.clone(),
                };
                let causal =
                    ContextResourceAction::ProposalAdoption(ContextResourceProposalAction {
                        action_id: r.action_id,
                        proposal: r.proposal.clone(),
                        entry_index: r.entry_index,
                    });
                let origin = ContextResourceProposalOrigin {
                    proposal: r.proposal.clone(),
                    entry_index: r.entry_index,
                    model_origin: revision.origin,
                };
                tx.observer.add_scope(ChangeScope::Resources);
                Some(resources::save_context_resource_in(
                    &tx,
                    &save,
                    causal,
                    Some(origin),
                )?)
            }
            (
                ConversationKnowledgeDecisionKind::Keep | ConversationKnowledgeDecisionKind::Reject,
                None,
            ) => None,
            _ => return Err(fail(ErrorCode::InvalidInput, "knowledge-proposal-decision")),
        };
        let receipt = ConversationKnowledgeDecision {
            action_id: r.action_id,
            proposal: r.proposal.clone(),
            entry_index: r.entry_index,
            decision: r.decision,
            actor: r.actor.clone(),
            reason: r.reason.clone(),
            resource,
        };
        record(
            &tx,
            &request,
            &Receipt::KnowledgeDecision {
                receipt: receipt.clone(),
            },
        )?;
        validate_receipt(&tx, r, &receipt)?;
        ledger::commit(tx)?;
        Ok(receipt)
    }
    pub fn read_conversation_knowledge_decision(
        &self,
        p: &ConversationProposalRef,
        index: u32,
    ) -> Result<Option<ConversationKnowledgeDecision>, ExecutionError> {
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "knowledge-proposal-read"))?,
            |c| {
                entry_in(c, p, index)?;
                match decision_action(c, p, index)? {
                    Some(id) => match action(c, p.project_id, id)? {
                        Some((_, Receipt::KnowledgeDecision { receipt })) => Ok(Some(receipt)),
                        _ => Err(corrupt()),
                    },
                    None => Ok(None),
                }
            },
        )
    }
    pub fn conversation_knowledge_decision_receipt(
        &self,
        r: &DecideConversationKnowledgeProposal,
    ) -> Result<Option<ConversationKnowledgeDecision>, ExecutionError> {
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "knowledge-proposal-read"))?,
            |c| {
                owned(c, r.proposal.project_id)?;
                match original(c, &Action::DecideKnowledgeProposal { request: r.clone() })? {
                    Some(Receipt::KnowledgeDecision { receipt }) => Ok(Some(receipt)),
                    None => Ok(None),
                    _ => Err(corrupt()),
                }
            },
        )
    }
    pub fn recover_conversation_knowledge_decision(
        &self,
        r: &DecideConversationKnowledgeProposal,
    ) -> Result<ConversationKnowledgeDecisionRecovery, ExecutionError> {
        let saved = match self.conversation_knowledge_decision_receipt(r) {
            Err(e) if e.code == ErrorCode::ResultMismatch && e.stage == "conversation-action" => {
                return Ok(ConversationKnowledgeDecisionRecovery {
                    request: r.clone(),
                    outcome: ConversationActionOutcome::Mismatch {},
                });
            }
            v => v?,
        };
        if saved.is_none() {
            read_snapshot(
                self.connection()
                    .map_err(|_| fail(ErrorCode::StorageFailed, "knowledge-proposal-read"))?,
                |c| entry_in(c, &r.proposal, r.entry_index).map(|_| ()),
            )?;
        }
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(ConversationKnowledgeDecisionRecovery {
            request: r.clone(),
            outcome: match saved {
                Some(receipt) => ConversationActionOutcome::Recorded { receipt },
                None => ConversationActionOutcome::Pending {
                    replay: self.conversation_replay(),
                },
            },
        })
    }
}

#[cfg(test)]
mod tests;
