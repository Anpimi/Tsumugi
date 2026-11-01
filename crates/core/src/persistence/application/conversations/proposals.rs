//! Proposal revisions share the original conversation actions and project transaction.
use super::*;
use crate::{
    ai::{
        AiPreview,
        conversation_planning::{self, ConversationPlanningModelOutput},
    },
    execution::FixedInput,
};
use std::collections::{BTreeMap, BTreeSet};
pub(in crate::persistence) mod work_plans;
pub(in crate::persistence) mod knowledge;

pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    initialize_revisions(c)?;
    work_plans::initialize(c)
}
pub(in crate::persistence) fn initialize_revisions(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE application_conversation_proposals (revision_id TEXT PRIMARY KEY NOT NULL, proposal_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES application_conversations(conversation_id), revision INTEGER NOT NULL CHECK(revision>0), ordinal INTEGER NOT NULL CHECK(ordinal>0), previous_revision_id TEXT UNIQUE REFERENCES application_conversation_proposals(revision_id), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 65536), digest TEXT NOT NULL CHECK(length(digest)=64), UNIQUE(proposal_id,revision), UNIQUE(conversation_id,ordinal))")
}
pub(in crate::persistence) fn table_names() -> impl Iterator<Item = String> {
    ["application_conversation_proposals".to_string()].into_iter().chain(work_plans::table_names())
}

struct OriginEvidence {
    input: FixedInput,
    preview: ConversationPlanningPreview,
    material: Option<AiPreview>,
    origin: ConversationProposalOrigin,
    model: ConversationPlanningModelOutput,
}

fn origin_in(
    c: &Connection,
    project: ExecutionId,
    thread: ExecutionId,
    attempt: ExecutionId,
    result: ExecutionId,
) -> Result<OriginEvidence, ExecutionError> {
    owned(c, project)?;
    conversation(c, project, thread)?;
    let input = ledger::load_input(c, attempt)?;
    let settings = conversation_planning::settings(&input)?;
    let preview = conversation_planning::preview_from_input(&input)?;
    if preview.project_id != project || preview.conversation_id != thread {
        return Err(fail(
            ErrorCode::ResultMismatch,
            "conversation-proposal-origin",
        ));
    }
    for selected in &preview.selected_messages {
        if message(c, project, selected.message_id)? != *selected {
            return Err(corrupt());
        }
    }
    let result = ledger::load_result(c, &input, result)?;
    let output = conversation_planning::validate_output(&input, &result)?;
    if !matches!(
        output.model,
        ConversationPlanningModelOutput::Proposal { .. }|ConversationPlanningModelOutput::KnowledgeProposal { .. }|ConversationPlanningModelOutput::TermProposal { .. }
    ) {
        return Err(fail(
            ErrorCode::InvalidInput,
            "conversation-proposal-content",
        ));
    }
    let origin = ConversationProposalOrigin {
        attempt_id: attempt,
        result_id: result.envelope().result_id,
        input_digest: input.digest().into(),
        result_digest: result.digest().into(),
    };
    Ok(OriginEvidence {
        input,
        preview,
        material: settings.material,
        origin,
        model: output.model,
    })
}

fn content(
    value: &ConversationPlanningModelOutput,
    preview: &ConversationPlanningPreview,
) -> Result<(), ExecutionError> {
    if !matches!(value, ConversationPlanningModelOutput::Proposal { .. }|ConversationPlanningModelOutput::KnowledgeProposal { .. }|ConversationPlanningModelOutput::TermProposal { .. }) {
        return Err(fail(
            ErrorCode::InvalidInput,
            "conversation-proposal-content",
        ));
    }
    conversation_planning::validate_model(value, preview)
}

fn validate_term_revision_entries(
    value: &ConversationPlanningModelOutput,
    original: &ConversationPlanningModelOutput,
) -> Result<(), ExecutionError> {
    if let ConversationPlanningModelOutput::TermProposal { entries: original, .. } = original {
        // Proposal revisions resolve the summary and questions. A target edit
        // belongs to the explicit resource decision and its original CAS.
        if !matches!(value, ConversationPlanningModelOutput::TermProposal { entries, .. } if entries == original) {
            return Err(fail(ErrorCode::InvalidInput, "conversation-term-entries"));
        }
    }
    Ok(())
}

fn capture_evidence(
    c: &Connection,
    r: &CaptureConversationProposal,
) -> Result<OriginEvidence, ExecutionError> {
    let evidence = origin_in(
        c,
        r.project_id,
        r.conversation_id,
        r.attempt_id,
        r.result_id,
    )?;
    let state: (Option<String>,String,String) = c.query_row("SELECT current_result_id,execution,validation FROM execution_items WHERE attempt_id=?1 AND item_id=?2", params![r.attempt_id.to_string(),evidence.input.envelope().items[0].item_id.to_string()], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(sql)?;
    if state
        != (
            Some(r.result_id.to_string()),
            "succeeded".into(),
            "valid".into(),
        )
    {
        return Err(fail(
            ErrorCode::OutputInvalid,
            "conversation-proposal-origin",
        ));
    }
    Ok(evidence)
}

fn raw_revision(
    c: &Connection,
    id: ExecutionId,
) -> Result<ConversationProposalRevision, ExecutionError> {
    let row: Option<(String, String, i64, i64, Option<String>, Vec<u8>, String)> = c.query_row(
        "SELECT proposal_id,conversation_id,revision,ordinal,previous_revision_id,record,digest FROM application_conversation_proposals WHERE revision_id=?1",
        [id.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
    ).optional().map_err(sql)?;
    let (proposal, thread, revision, ordinal, previous, bytes, digest) =
        row.ok_or_else(|| fail(ErrorCode::Unauthorized, "conversation-proposal-identity"))?;
    let value: ConversationProposalRevision = decode(&bytes, &digest)?;
    if value.revision_id != id
        || value.proposal_id.to_string() != proposal
        || value.conversation_id.to_string() != thread
        || revision <= 0
        || ordinal <= 0
        || value.revision.get() != revision as u64
        || value.ordinal.get() != ordinal as u64
        || value.previous_revision_id.map(|id| id.to_string()) != previous
        || (revision == 1) != value.previous_revision_id.is_none()
    {
        return Err(corrupt());
    }
    Ok(value)
}

pub(super) fn revision_in(
    c: &Connection,
    project: ExecutionId,
    thread: ExecutionId,
    proposal: ExecutionId,
    id: ExecutionId,
) -> Result<ConversationProposalRevision, ExecutionError> {
    let value = raw_revision(c, id)?;
    if value.project_id != project
        || value.conversation_id != thread
        || value.proposal_id != proposal
    {
        return Err(fail(
            ErrorCode::ResultMismatch,
            "conversation-proposal-identity",
        ));
    }
    let evidence = origin_in(
        c,
        project,
        thread,
        value.origin.attempt_id,
        value.origin.result_id,
    )?;
    if evidence.origin != value.origin
        || content(&value.content, &evidence.preview).is_err()
        || validate_term_revision_entries(&value.content, &evidence.model).is_err()
    {
        return Err(corrupt());
    }
    if let Some(previous) = value.previous_revision_id {
        let previous = raw_revision(c, previous)?;
        if previous.project_id != project
            || previous.conversation_id != thread
            || previous.proposal_id != proposal
            || previous.origin != value.origin
            || previous.revision.get().checked_add(1) != Some(value.revision.get())
            || previous.ordinal >= value.ordinal
        {
            return Err(corrupt());
        }
    } else if value.content != evidence.model {
        return Err(corrupt());
    }
    Ok(value)
}

fn head(c: &Connection, proposal: ExecutionId) -> Result<Option<ExecutionId>, ExecutionError> {
    c.query_row("SELECT revision_id FROM application_conversation_proposals WHERE proposal_id=?1 ORDER BY revision DESC LIMIT 1", [proposal.to_string()], |r|r.get::<_,String>(0))
        .optional().map_err(sql)?.map(|id|ExecutionId::parse(&id).map_err(|_|corrupt())).transpose()
}

/// Historical ledger evidence, with an optional check of the original saving action.
/// Reading this does not grant a new model call or resource mutation.
pub(in crate::persistence) fn term_evidence_in(
    c: &Connection,
    source: &ConversationProposalRef,
    action_id: Option<ExecutionId>,
) -> Result<(ConversationProposalRevision, ConversationPlanningPreview, bool), ExecutionError> {
    let revision = revision_in(c, source.project_id, source.conversation_id, source.proposal_id, source.revision_id)?;
    let ConversationPlanningModelOutput::TermProposal { questions, .. } = &revision.content else {
        return Err(fail(ErrorCode::InvalidInput, "conversation-term-kind"));
    };
    let evidence = origin_in(c, source.project_id, source.conversation_id, revision.origin.attempt_id, revision.origin.result_id)?;
    if let Some(action_id) = action_id {
        let row: (Vec<u8>, String, Vec<u8>, String) = c.query_row(
            "SELECT request,request_digest,receipt,receipt_digest FROM application_conversation_actions WHERE action_id=?1",
            [action_id.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql)?;
        let action: Action = decode(&row.0, &row.1)?;
        let receipt: Receipt = decode(&row.2, &row.3)?;
        let matches = match action {
            Action::CaptureProposal { request } => request.action_id == action_id
                && request.project_id == source.project_id && request.conversation_id == source.conversation_id
                && request.proposal_id == source.proposal_id && request.revision_id == source.revision_id
                && request.attempt_id == revision.origin.attempt_id && request.result_id == revision.origin.result_id
                && revision.previous_revision_id.is_none(),
            Action::ReviseProposal { request } => request.action_id == action_id
                && request.project_id == source.project_id && request.conversation_id == source.conversation_id
                && request.proposal_id == source.proposal_id && request.revision_id == source.revision_id
                && Some(request.expected_revision_id) == revision.previous_revision_id && request.content == revision.content,
            _ => false,
        };
        if !matches || !matches!(receipt, Receipt::Proposal { receipt } if receipt == revision) { return Err(corrupt()); }
    }
    let source_current = match knowledge::source_current(c, &evidence) {
        Ok(()) => true,
        Err(error) if error.code == ErrorCode::DependencyConflict => false,
        Err(error) => return Err(error),
    };
    let current = questions.is_empty() && head(c, source.proposal_id)? == Some(source.revision_id) && source_current;
    Ok((revision, evidence.preview, current))
}

fn save_revision(
    c: &Connection,
    value: &ConversationProposalRevision,
) -> Result<(), ExecutionError> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM application_conversation_proposals WHERE revision_id=?1)",
            [value.revision_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if exists {
        return Err(fail(
            ErrorCode::ResultMismatch,
            "conversation-proposal-identity",
        ));
    }
    let bytes = codec::encode(value, MAX_RECORD)?;
    c.execute(
        "INSERT INTO application_conversation_proposals VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            value.revision_id.to_string(),
            value.proposal_id.to_string(),
            value.conversation_id.to_string(),
            value.revision.get() as i64,
            value.ordinal.get() as i64,
            value.previous_revision_id.map(|id| id.to_string()),
            bytes,
            codec::digest(&bytes)
        ],
    )
    .map_err(sql)?;
    Ok(())
}

fn next_ordinal(c: &Connection, thread: ExecutionId) -> Result<Revision, ExecutionError> {
    let next: i64 = c.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM application_conversation_proposals WHERE conversation_id=?1", [thread.to_string()], |r|r.get(0)).map_err(sql)?;
    Revision::new(u64::try_from(next).map_err(|_| corrupt())?)
}

pub(super) fn validate(
    c: &Connection,
    recorded: &BTreeSet<ExecutionId>,
) -> Result<(), ExecutionError> {
    let project = ExecutionId::parse(
        &read_metadata_from(c)
            .map_err(|_| corrupt())?
            .project_id()
            .to_string(),
    )
    .map_err(|_| corrupt())?;
    let ids = c.prepare("SELECT revision_id FROM application_conversation_proposals ORDER BY conversation_id,ordinal").map_err(sql)?
        .query_map([], |r|r.get::<_,String>(0)).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
    let mut revisions = BTreeSet::new();
    let mut ordinals = BTreeMap::<ExecutionId, u64>::new();
    let mut heads = BTreeMap::<ExecutionId, ExecutionId>::new();
    for id in ids {
        let id = ExecutionId::parse(&id).map_err(|_| corrupt())?;
        let raw = raw_revision(c, id)?;
        let value = revision_in(c, project, raw.conversation_id, raw.proposal_id, id)?;
        if matches!(value.content, ConversationPlanningModelOutput::TermProposal { .. }) {
            let captured: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM resource_captures WHERE capture_id=?1 AND project_id=?2 AND capture_kind='conversation')",
                params![id.to_string(), project.to_string()], |r| r.get(0)).map_err(sql)?;
            if !captured { return Err(corrupt()); }
        }
        let ordinal = ordinals.entry(value.conversation_id).or_default();
        *ordinal += 1;
        if value.ordinal.get() != *ordinal
            || heads.insert(value.proposal_id, id) != value.previous_revision_id
            || !revisions.insert(id)
        {
            return Err(corrupt());
        }
    }
    if &revisions != recorded {
        return Err(corrupt());
    }
    Ok(())
}

impl ProjectStore {
    pub fn capture_conversation_proposal(
        &self,
        r: &CaptureConversationProposal,
    ) -> Result<ConversationProposalRevision, ExecutionError> {
        let mut tx = self.execution_write_scoped(ChangeScope::Project)?;
        owned(&tx, r.project_id)?;
        let request = Action::CaptureProposal { request: r.clone() };
        if let Some(Receipt::Proposal { receipt }) = original(&tx, &request)? {
            return Ok(receipt);
        }
        if head(&tx, r.proposal_id)?.is_some() {
            return Err(fail(
                ErrorCode::ResultMismatch,
                "conversation-proposal-identity",
            ));
        }
        let evidence = capture_evidence(&tx, r)?;
        if !matches!(evidence.model,ConversationPlanningModelOutput::KnowledgeProposal{..}|ConversationPlanningModelOutput::TermProposal{..}) {
            planning::validate_material_in(self, &tx, &evidence.preview, &evidence.material)?;
        }
        let receipt = ConversationProposalRevision {
            project_id: r.project_id,
            conversation_id: r.conversation_id,
            proposal_id: r.proposal_id,
            revision_id: r.revision_id,
            revision: Revision::new(1)?,
            ordinal: next_ordinal(&tx, r.conversation_id)?,
            previous_revision_id: None,
            origin: evidence.origin,
            content: evidence.model,
        };
        save_revision(&tx, &receipt)?;
        crate::persistence::resources::capture_conversation_terms_in(&tx, &receipt, r.action_id)?;
        if matches!(receipt.content, ConversationPlanningModelOutput::TermProposal { .. }) {
            tx.observer.add_scope(ChangeScope::Resources);
        }
        record(
            &tx,
            &request,
            &Receipt::Proposal {
                receipt: receipt.clone(),
            },
        )?;
        ledger::commit(tx)?;
        Ok(receipt)
    }

    pub fn revise_conversation_proposal(
        &self,
        r: &ReviseConversationProposal,
    ) -> Result<ConversationProposalRevision, ExecutionError> {
        let mut tx = self.execution_write_scoped(ChangeScope::Project)?;
        owned(&tx, r.project_id)?;
        let request = Action::ReviseProposal { request: r.clone() };
        if let Some(Receipt::Proposal { receipt }) = original(&tx, &request)? {
            return Ok(receipt);
        }
        if head(&tx, r.proposal_id)? != Some(r.expected_revision_id) {
            return Err(fail(
                ErrorCode::DependencyConflict,
                "conversation-proposal-head",
            ));
        }
        let prior = revision_in(
            &tx,
            r.project_id,
            r.conversation_id,
            r.proposal_id,
            r.expected_revision_id,
        )?;
        let evidence = origin_in(
            &tx,
            r.project_id,
            r.conversation_id,
            prior.origin.attempt_id,
            prior.origin.result_id,
        )?;
        validate_term_revision_entries(&r.content, &evidence.model)?;
        content(&r.content, &evidence.preview)?;
        if !matches!(evidence.model,ConversationPlanningModelOutput::KnowledgeProposal{..}|ConversationPlanningModelOutput::TermProposal{..}) {
            planning::validate_material_in(self, &tx, &evidence.preview, &evidence.material)?;
        }
        let next = prior
            .revision
            .get()
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(corrupt)?;
        let receipt = ConversationProposalRevision {
            revision_id: r.revision_id,
            revision: Revision::new(next)?,
            ordinal: next_ordinal(&tx, r.conversation_id)?,
            previous_revision_id: Some(r.expected_revision_id),
            content: r.content.clone(),
            ..prior
        };
        save_revision(&tx, &receipt)?;
        crate::persistence::resources::capture_conversation_terms_in(&tx, &receipt, r.action_id)?;
        if matches!(receipt.content, ConversationPlanningModelOutput::TermProposal { .. }) {
            tx.observer.add_scope(ChangeScope::Resources);
        }
        record(
            &tx,
            &request,
            &Receipt::Proposal {
                receipt: receipt.clone(),
            },
        )?;
        ledger::commit(tx)?;
        Ok(receipt)
    }

    pub fn read_conversation_proposal(
        &self,
        project: ExecutionId,
        thread: ExecutionId,
        proposal: ExecutionId,
        revision: Option<ExecutionId>,
    ) -> Result<ConversationProposalRevision, ExecutionError> {
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-proposal-read"))?,
            |c| {
                owned(c, project)?;
                conversation(c, project, thread)?;
                let id = match revision {
                    Some(id) => id,
                    None => head(c, proposal)?.ok_or_else(|| {
                        fail(ErrorCode::Unauthorized, "conversation-proposal-identity")
                    })?,
                };
                revision_in(c, project, thread, proposal, id)
            },
        )
    }

    pub fn read_conversation_proposal_revisions(
        &self,
        project: ExecutionId,
        thread: ExecutionId,
        after: Option<Revision>,
        limit: u32,
    ) -> Result<ConversationProposalPage, ExecutionError> {
        page_limit(limit)?;
        let after = i64::try_from(after.map_or(0, |v| v.get()))
            .map_err(|_| fail(ErrorCode::InvalidInput, "conversation-page"))?;
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-proposal-read"))?,
            |c| {
                owned(c, project)?;
                conversation(c, project, thread)?;
                let ids = c.prepare("SELECT revision_id,proposal_id FROM application_conversation_proposals WHERE conversation_id=?1 AND ordinal>?2 ORDER BY ordinal LIMIT ?3").map_err(sql)?
                .query_map(params![thread.to_string(),after,limit+1],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
                let mut page = ConversationProposalPage {
                    project_id: project,
                    conversation_id: thread,
                    rows: Vec::new(),
                    next_after: None,
                };
                for (index, (id, proposal)) in ids.iter().take(limit as usize).enumerate() {
                    page.rows.push(revision_in(
                        c,
                        project,
                        thread,
                        ExecutionId::parse(proposal).map_err(|_| corrupt())?,
                        ExecutionId::parse(id).map_err(|_| corrupt())?,
                    )?);
                    page.next_after = if ids.len() > index + 1 {
                        page.rows.last().map(|v| v.ordinal)
                    } else {
                        None
                    };
                    if codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES).is_err() {
                        page.rows.pop();
                        page.next_after = Some(
                            page.rows
                                .last()
                                .ok_or_else(|| {
                                    fail(ErrorCode::LimitExceeded, "conversation-page-bytes")
                                })?
                                .ordinal,
                        );
                        break;
                    }
                }
                codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES)?;
                Ok(page)
            },
        )
    }

    pub fn validate_conversation_proposal(
        &self,
        project: ExecutionId,
        thread: ExecutionId,
        proposal: ExecutionId,
        revision: ExecutionId,
    ) -> Result<ConversationProposalRevision, ExecutionError> {
        if self.is_reconciling() {
            return Err(fail(ErrorCode::OutcomeUnknown, "conversation-session"));
        }
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-proposal-read"))?,
            |c| {
                owned(c, project)?;
                let value = revision_in(c, project, thread, proposal, revision)?;
                if head(c, proposal)? != Some(revision) {
                    return Err(fail(
                        ErrorCode::DependencyConflict,
                        "conversation-proposal-head",
                    ));
                }
                let evidence = origin_in(
                    c,
                    project,
                    thread,
                    value.origin.attempt_id,
                    value.origin.result_id,
                )?;
                if matches!(value.content,ConversationPlanningModelOutput::KnowledgeProposal{..}|ConversationPlanningModelOutput::TermProposal{..}) {
                    knowledge::source_current(c,&evidence)?;
                } else {
                    planning::validate_material_in(self, c, &evidence.preview, &evidence.material)?;
                }
                Ok(value)
            },
        )
    }

    pub fn conversation_proposal_capture_receipt(
        &self,
        r: &CaptureConversationProposal,
    ) -> Result<Option<ConversationProposalRevision>, ExecutionError> {
        self.proposal_receipt(&Action::CaptureProposal { request: r.clone() })
    }
    pub fn conversation_proposal_revision_receipt(
        &self,
        r: &ReviseConversationProposal,
    ) -> Result<Option<ConversationProposalRevision>, ExecutionError> {
        self.proposal_receipt(&Action::ReviseProposal { request: r.clone() })
    }
    fn proposal_receipt(
        &self,
        request: &Action,
    ) -> Result<Option<ConversationProposalRevision>, ExecutionError> {
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-proposal-read"))?,
            |c| {
                owned(c, request.project())?;
                match original(c, request)? {
                    Some(Receipt::Proposal { receipt }) => Ok(Some(receipt)),
                    None => Ok(None),
                    _ => Err(corrupt()),
                }
            },
        )
    }
    fn recover_proposal(
        &self,
        request: &Action,
    ) -> Result<ConversationActionOutcome<ConversationProposalRevision>, ExecutionError> {
        let found = read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-proposal-read"))?,
            |c| {
                owned(c, request.project())?;
                let found = original(c, request)?;
                if found.is_none() {
                    match request {
                        Action::CaptureProposal { request } => {
                            capture_evidence(c, request)?;
                        }
                        Action::ReviseProposal { request } => {
                            let prior = revision_in(
                                c,
                                request.project_id,
                                request.conversation_id,
                                request.proposal_id,
                                request.expected_revision_id,
                            )?;
                            let evidence = origin_in(
                                c,
                                request.project_id,
                                request.conversation_id,
                                prior.origin.attempt_id,
                                prior.origin.result_id,
                            )?;
                            content(&request.content, &evidence.preview)?;
                        }
                        _ => return Err(corrupt()),
                    }
                }
                Ok(found)
            },
        );
        let found = match found {
            Err(error)
                if error.code == ErrorCode::ResultMismatch
                    && error.stage == "conversation-action" =>
            {
                return Ok(ConversationActionOutcome::Mismatch {});
            }
            value => value?,
        };
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        match found {
            Some(Receipt::Proposal { receipt }) => {
                Ok(ConversationActionOutcome::Recorded { receipt })
            }
            None => Ok(ConversationActionOutcome::Pending {
                replay: self.conversation_replay(),
            }),
            _ => Err(corrupt()),
        }
    }
    pub fn recover_conversation_proposal_capture(
        &self,
        r: &CaptureConversationProposal,
    ) -> Result<ConversationProposalCaptureRecovery, ExecutionError> {
        Ok(ConversationProposalCaptureRecovery {
            request: r.clone(),
            outcome: self.recover_proposal(&Action::CaptureProposal { request: r.clone() })?,
        })
    }
    pub fn recover_conversation_proposal_revision(
        &self,
        r: &ReviseConversationProposal,
    ) -> Result<ConversationProposalRevisionRecovery, ExecutionError> {
        Ok(ConversationProposalRevisionRecovery {
            request: r.clone(),
            outcome: self.recover_proposal(&Action::ReviseProposal { request: r.clone() })?,
        })
    }
}

#[cfg(test)]
pub(in crate::persistence) mod tests;
