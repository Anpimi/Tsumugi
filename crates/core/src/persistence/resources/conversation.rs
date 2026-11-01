//! Immutable conversation proposals reuse resource captures and human decisions.
use super::*;
use crate::ai::conversation_planning::ConversationPlanningModelOutput;
use crate::application::{
    ConversationPlanningScope, ConversationProposalOrigin, ConversationProposalRef,
    ConversationProposalRevision, ConversationTermEntry, ConversationTermPreview,
};
use crate::persistence::application::conversations::proposals::term_evidence_in;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapturedConversationTerms {
    pub action_id: ExecutionId,
    pub proposal: ConversationProposalRef,
    pub model_origin: ConversationProposalOrigin,
}

fn proposal_ref(revision: &ConversationProposalRevision) -> ConversationProposalRef {
    ConversationProposalRef {
        project_id: revision.project_id,
        conversation_id: revision.conversation_id,
        proposal_id: revision.proposal_id,
        revision_id: revision.revision_id,
    }
}

pub(in crate::persistence) fn capture_in(
    c: &Connection,
    revision: &ConversationProposalRevision,
    action_id: ExecutionId,
) -> Result<(), ExecutionError> {
    if !matches!(
        revision.content,
        ConversationPlanningModelOutput::TermProposal { .. }
    ) {
        return Ok(());
    }
    let captured = CapturedConversationTerms {
        action_id,
        proposal: proposal_ref(revision),
        model_origin: revision.origin.clone(),
    };
    let (saved, preview, _) = term_evidence_in(c, &captured.proposal, None)?;
    if saved != *revision {
        return Err(failure(
            ErrorCode::CorruptLedger,
            "conversation-term-capture",
        ));
    }
    let ConversationPlanningScope::Units { locale, .. } = preview.scope else {
        return Err(failure(ErrorCode::InvalidInput, "conversation-term-scope"));
    };
    // A saved historical proposal is an observation. Current-source checks belong
    // to adoption and must not prevent saving the original result for comparison.
    let metadata = super::super::read_metadata_from(c)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "conversation-term-project"))?;
    let bytes = codec::encode(&captured, MAX_RESOURCE_BYTES)?;
    let digest = codec::digest(&bytes);
    c.execute("INSERT INTO resource_captures(capture_id,project_id,capture_kind,correction_key,resource_id,resource_revision,source_locale,target_locale,license,digest,bytes,action_id,request_digest) VALUES(?1,?2,'conversation',NULL,NULL,NULL,?3,?4,NULL,?5,?6,?7,?5)",
        params![revision.revision_id.to_string(),revision.project_id.to_string(),metadata.source_locale().as_str(),locale,digest,bytes,action_id.to_string()]).map_err(sql)?;
    Ok(())
}

pub(super) fn evidence(
    c: &Connection,
    captured: &CapturedConversationTerms,
) -> Result<(ConversationProposalRevision, String, bool), ExecutionError> {
    let (revision, preview, current) =
        term_evidence_in(c, &captured.proposal, Some(captured.action_id))?;
    let ConversationPlanningScope::Units { locale, .. } = preview.scope else {
        return Err(failure(ErrorCode::CorruptLedger, "conversation-term-scope"));
    };
    if revision.origin != captured.model_origin {
        return Err(failure(
            ErrorCode::CorruptLedger,
            "conversation-term-origin",
        ));
    }
    Ok((revision, locale, current))
}

fn entries(revision: &ConversationProposalRevision) -> &[ConversationTermEntry] {
    match &revision.content {
        ConversationPlanningModelOutput::TermProposal { entries, .. } => entries,
        _ => unreachable!("evidence validates the proposal kind"),
    }
}
fn entry<'a>(
    revision: &'a ConversationProposalRevision,
    id: &str,
) -> Result<&'a ConversationTermEntry, ExecutionError> {
    let index = id
        .parse::<usize>()
        .ok()
        .filter(|index| index.to_string() == id)
        .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-entry"))?;
    entries(revision)
        .get(index)
        .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-entry"))
}
fn term_id(captured: &CapturedConversationTerms, entry_id: &str) -> String {
    format!("conversation:{}:{entry_id}", captured.proposal.proposal_id)
}
fn glossary_entry(index: usize, value: &ConversationTermEntry) -> GlossaryEntry {
    GlossaryEntry {
        id: index.to_string(),
        source: value.source.clone(),
        aliases: value.aliases.clone(),
        target: value.target.clone(),
        protected: value.protected,
        native_key: None,
        reason: value.reason.clone(),
    }
}

pub(super) fn preview(
    c: &Connection,
    capture: GlossaryCapture,
    captured: CapturedConversationTerms,
) -> Result<ResourcePreview, ExecutionError> {
    let (revision, _, current) = evidence(c, &captured)?;
    let mut rows = Vec::with_capacity(entries(&revision).len());
    for (index, e) in entries(&revision).iter().enumerate() {
        let old = current_term(
            c,
            revision.project_id,
            &term_id(&captured, &index.to_string()),
        )?;
        let kind = match &old {
            None => ResourceChangeKind::Added,
            Some(v) if v.origin_kind == TermOrigin::Manual => ResourceChangeKind::Override,
            Some(v)
                if v.source == e.source
                    && v.aliases == e.aliases
                    && v.target == e.target
                    && v.protected == e.protected
                    && v.scope_unit_id == Some(e.unit_id)
                    && v.reason == e.reason
                    && !v.removed =>
            {
                ResourceChangeKind::Unchanged
            }
            _ => ResourceChangeKind::Edited,
        };
        rows.push(ResourcePreviewRow {
            entry: glossary_entry(index, e),
            kind,
            current: old,
            scope_unit_id: Some(e.unit_id),
        });
    }
    Ok(ResourcePreview {
        capture,
        rows,
        removed: vec![],
        correction: None,
        mcp: None,
        conversation: Some(ConversationTermPreview {
            proposal: captured.proposal,
            model_origin: captured.model_origin,
            current,
        }),
    })
}

pub(super) fn check_decision_admission(
    c: &Connection,
    request: &ResourceDecision,
    captured: &CapturedConversationTerms,
) -> Result<Option<TermRevision>, ExecutionError> {
    let (revision, _, current) = evidence(c, captured)?;
    entry(&revision, &request.entry_id)?;
    let old = current_term(c, request.project_id, &term_id(captured, &request.entry_id))?;
    check_term_revision(old.as_ref(), request.expected_revision_id)?;
    if matches!(
        request.decision,
        ResourceDecisionKind::Keep | ResourceDecisionKind::Ignore
    ) {
        return Ok(old);
    }
    if !current {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "conversation-term-stale",
        ));
    }
    if old
        .as_ref()
        .is_some_and(|v| v.origin_kind == TermOrigin::Manual)
        && request.decision != ResourceDecisionKind::Override
    {
        return Err(failure(ErrorCode::DependencyConflict, "resource-override"));
    }
    Ok(old)
}

pub(super) fn decide(
    c: &Connection,
    request: &ResourceDecision,
    captured: &CapturedConversationTerms,
    request_digest: &str,
) -> Result<Option<TermRevision>, ExecutionError> {
    let old = check_decision_admission(c, request, captured)?;
    if matches!(
        request.decision,
        ResourceDecisionKind::Keep | ResourceDecisionKind::Ignore
    ) {
        return Ok(old);
    }
    let (proposal, locale, _) = evidence(c, captured)?;
    let incoming = entry(&proposal, &request.entry_id)?;
    let revision = insert_term(
        c,
        request.project_id,
        &term_id(captured, &request.entry_id),
        &locale,
        &incoming.source,
        &incoming.aliases,
        request.edited_target.as_deref().unwrap_or(&incoming.target),
        incoming.protected,
        Some(incoming.unit_id),
        &incoming.reason,
        "external",
        Some(request.capture_id),
        Some(&request.entry_id),
        request.expected_revision_id,
        false,
        request.action_id,
        request_digest,
    )?;
    write_change(
        c,
        request.project_id,
        "term",
        &locale,
        Some(incoming.unit_id),
        old.as_ref().and_then(|v| v.scope_unit_id),
        Some(&incoming.source),
        old.as_ref().map(|v| v.source.as_str()),
        request.expected_revision_id,
        revision.revision_id,
        request.action_id,
    )?;
    Ok(Some(revision))
}

pub(super) fn validate_decision(
    c: &Connection,
    saved: &ResourceDecisionResult,
    captured: &CapturedConversationTerms,
) -> Result<(), ExecutionError> {
    let corrupt = || failure(ErrorCode::CorruptLedger, "conversation-term-decision");
    let (proposal, locale, _) = evidence(c, captured)?;
    let request = &saved.request;
    let incoming = entry(&proposal, &request.entry_id).map_err(|_| corrupt())?;
    let term = term_id(captured, &request.entry_id);
    let prior = request
        .expected_revision_id
        .map(|id| term_by_revision(c, request.project_id, id).and_then(|v| v.ok_or_else(corrupt)))
        .transpose()?;
    if prior
        .as_ref()
        .is_some_and(|v| v.term_id != term || v.locale != locale)
    {
        return Err(corrupt());
    }
    if matches!(
        request.decision,
        ResourceDecisionKind::Keep | ResourceDecisionKind::Ignore
    ) {
        if saved.revision != prior {
            return Err(corrupt());
        }
        return Ok(());
    }
    let value = saved.revision.as_ref().ok_or_else(corrupt)?;
    let exact: bool = c
        .query_row(
            "SELECT action_id=?2 AND request_digest=?3 AND project_id=?4 FROM term_revisions WHERE revision_id=?1",
            params![
                value.revision_id.to_string(),
                request.action_id.to_string(),
                digest(request)?,
                request.project_id.to_string()
            ],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if !exact
        || value.term_id != term
        || value.locale != locale
        || value.source != incoming.source
        || value.aliases != incoming.aliases
        || value.target != request.edited_target.as_deref().unwrap_or(&incoming.target)
        || value.protected != incoming.protected
        || value.scope_unit_id != Some(incoming.unit_id)
        || value.reason != incoming.reason
        || value.removed
        || value.origin_kind != TermOrigin::External
        || value.capture_id != Some(request.capture_id)
        || value.external_entry_id.as_deref() != Some(&request.entry_id)
        || value.previous_revision_id != request.expected_revision_id
        || (prior
            .as_ref()
            .is_some_and(|v| v.origin_kind == TermOrigin::Manual)
            && request.decision != ResourceDecisionKind::Override)
    {
        return Err(corrupt());
    }
    Ok(())
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let mut query = c.prepare("SELECT project_id,action_id FROM resource_decisions WHERE capture_id IN (SELECT capture_id FROM resource_captures WHERE capture_kind='conversation') ORDER BY rowid").map_err(sql)?;
    for row in query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(sql)?
    {
        let (project, action) = row.map_err(sql)?;
        let receipt = correction::decision_action_in(c, id(project)?, id(action)?)?
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "conversation-term-decision"))?;
        let (_, correction::CapturedGlossary::Conversation(captured)) =
            capture_by_id(c, receipt.request.project_id, receipt.request.capture_id)?
        else {
            return Err(failure(
                ErrorCode::CorruptLedger,
                "conversation-term-capture",
            ));
        };
        validate_decision(c, &receipt, &captured)?;
    }
    let orphan: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM term_revisions r JOIN resource_captures c ON c.capture_id=r.capture_id WHERE c.capture_kind='conversation' AND NOT EXISTS(SELECT 1 FROM resource_decisions d WHERE d.project_id=r.project_id AND d.capture_id=r.capture_id AND d.result_revision_id=r.revision_id AND d.action_id=r.action_id AND d.decision IN ('adopt','override')))", [], |r|r.get(0)).map_err(sql)?;
    if orphan {
        return Err(failure(
            ErrorCode::CorruptLedger,
            "conversation-term-decision",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
