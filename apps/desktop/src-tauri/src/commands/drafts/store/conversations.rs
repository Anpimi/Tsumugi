//! Conversation input uses the same journal file, transaction and shared quotas.
use super::*;
use std::collections::BTreeSet;
use tsumugi_core::ai::conversation_planning::ConversationPlanningModelOutput;
use tsumugi_core::application::{MAX_CONVERSATION_MESSAGE_BYTES, MAX_CONVERSATION_TITLE_BYTES};

pub(super) const LEGACY_HEAD_SQL: &str = "CREATE TABLE conversation_draft_heads (project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=262144), PRIMARY KEY(project_id,conversation_id), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))";
pub(super) const HEAD_SQL: &str = "CREATE TABLE conversation_draft_heads (project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=4456448), PRIMARY KEY(project_id,conversation_id), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))";

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    super::encode_bounded(value, MAX_CONVERSATION_DRAFT_RECORD_BYTES)
}
fn record_limit(format: i64) -> usize {
    if format == CONVERSATION_FORMAT {
        MAX_DRAFT_RECORD_BYTES
    } else {
        MAX_CONVERSATION_DRAFT_RECORD_BYTES
    }
}

fn empty(key: &ConversationDraftKey) -> ConversationDraftHead {
    ConversationDraftHead {
        key: key.clone(),
        revision: Revision::new(0).expect("zero revision"),
        writer_id: None,
        value: None,
    }
}

fn same_recovery_member(
    draft: &ConversationTeamRecoveryMemberDraft,
    member: &tsumugi_core::application::TeamExecutionMember,
) -> bool {
    draft.display_name == member.display_name
        && draft.role == member.role
        && draft.config == member.config
        && draft.unit_ids == member.unit_ids
        && draft.tool_handles == member.tool_handles.iter().map(ToString::to_string).collect::<Vec<_>>()
        && draft.kinds == member.kinds
}

fn same_recovery_input(
    draft: &ConversationTeamRecoveryDraft,
    request: &crate::commands::execution::work_plans::recovery::WorkPlanTeamRecoveryPrepareOriginal,
) -> bool {
    let recovery = &request.recovery;
    draft.members.len() == recovery.members.len()
        && draft.members.iter().zip(&recovery.members).all(|(input, member)| {
            same_recovery_member(input, member)
                && input.original.as_ref().is_none_or(|original| {
                    member.member_id == original.member_id
                        && (member.role_version_id == original.role_version_id)
                            == same_recovery_member(input, original)
                })
        })
        && draft.recipient_key.and_then(|key| draft.members.iter().position(|member| member.key == key))
            .and_then(|index| recovery.members.get(index))
            .is_some_and(|member| member.member_id == recovery.work.member_id)
        && draft.unit_id == Some(recovery.work.target.unit_id)
        && draft.kind == recovery.work.kind
        && draft.instructions == recovery.work.instructions
        && draft.post_ids == recovery.work.post_ids
        && draft.prior_work == recovery.work.prior_work
}

fn recovery_authorization_append(old: &ConversationDraftPending, new: &ConversationDraftPending) -> bool {
    matches!((old, new), (
        ConversationDraftPending::TeamRecovery { conversation_id, request, authorization: None, submitted_seq },
        ConversationDraftPending::TeamRecovery { conversation_id: next_conversation, request: next_request,
            authorization: Some(_), submitted_seq: next_seq },
    ) if conversation_id == next_conversation && request == next_request && submitted_seq == next_seq)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn recovery_authorization_matches(
    request: &crate::commands::execution::work_plans::recovery::WorkPlanTeamRecoveryPrepareOriginal,
    authorization: &crate::commands::execution::work_plans::recovery::WorkPlanTeamRecoverySettlementOriginal,
) -> bool {
    authorization.project_id == request.project_id
        && authorization.preparation_id == request.preparation_id
        && authorization.plan_id == request.recovery.plan_id
        && authorization.base_lease == request.recovery.expected_lease
        && authorization.recovery.confirmed
        && valid_digest(&authorization.recovery.digest)
}

fn valid_recovery_record(key: &ConversationDraftKey, plan: ExecutionId, record: &ConversationTeamRecoveryRecorded) -> bool {
    let request = &record.request;
    let receipt = &record.receipt;
    recovery_authorization_matches(request, &record.authorization)
        && request.project_id == key.project_id
        && request.recovery.project_id == key.project_id
        && request.recovery.plan_id == plan
        && request.recovery.expected_lease.plan_id == plan
        && request.recovery.expected_lease.generation.get() > 0
        && request.recovery.expected_effective_version.lease.plan_id == plan
        && receipt.base_lease == record.authorization.base_lease
        && receipt.action_id == record.authorization.recovery.action_id
        && receipt.effective_version.action_id == receipt.action_id
        && receipt.effective_version.digest == record.authorization.recovery.digest
        && receipt.effective_version.lease.plan_id == plan
        && receipt.base_lease.generation.get().checked_add(1) == Some(receipt.effective_version.lease.generation.get())
        && receipt.work_id == request.recovery.work.work_id
        && valid_digest(&receipt.input_digest)
}

fn question_input_matches(draft: &ConversationTeamQuestionDraft, response: &tsumugi_core::application::TeamQuestionResponse) -> bool {
    use tsumugi_core::application::TeamQuestionResponse;
    match response {
        TeamQuestionResponse::Text { body } => draft.mode == ConversationTeamQuestionMode::Text && draft.body == *body,
        TeamQuestionResponse::Choice { option_id } => draft.mode == ConversationTeamQuestionMode::Choice && draft.option_id == Some(*option_id),
        TeamQuestionResponse::Dismiss { reason } => draft.dismiss_reason == *reason,
    }
}

fn validate_question_request(
    request: &crate::commands::execution::work_plans::questions::TeamQuestionResponseOriginal,
    question: &tsumugi_core::application::TeamDiscussionPost,
) -> Result<()> {
    use tsumugi_core::application::{TeamDiscussionAuthor, TeamDiscussionKind, TeamQuestionEvent, TeamQuestionResponse};
    if question.plan_id != request.plan_id || question.publication.post_id != request.response.question_post_id
        || request.response.post_id == request.response.question_post_id
        || question.publication.kind != TeamDiscussionKind::HumanQuestion
        || !matches!(question.author, TeamDiscussionAuthor::Member { .. })
        || !matches!(question.publication.question, Some(TeamQuestionEvent::Open { .. }))
        || question.publication.reply_to.is_some() || question.publication.supersedes.is_some()
    { return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-team-question")); }
    let body = match &request.response.response {
        TeamQuestionResponse::Text { body } => body,
        TeamQuestionResponse::Dismiss { reason } => reason,
        TeamQuestionResponse::Choice { option_id } => {
            let Some(TeamQuestionEvent::Open { options }) = &question.publication.question else { unreachable!() };
            &options.iter().find(|option| option.option_id == *option_id)
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "conversation-drafts-team-question"))?.label
        }
    };
    if body.trim().is_empty() || body.len() > tsumugi_core::application::TeamDiscussionLimits::current_plan().max_post_bytes as usize {
        return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-team-question"));
    }
    super::encode_bounded(&(request, question), tsumugi_core::execution::MAX_INPUT_BYTES)?;
    Ok(())
}

fn validate_pending(
    key: &ConversationDraftKey,
    pending: &ConversationDraftPending,
    seq: Revision,
    message_seq: Revision,
    text: &str,
    team_drafts: &[ConversationTeamDraft],
) -> Result<()> {
    let (project, thread, submitted) = match pending {
        ConversationDraftPending::TeamQuestionResponse { conversation_id, request, question, submitted_seq } => {
            validate_question_request(request, question)?;
            let draft = team_drafts.iter().find(|draft| draft.plan_id == request.plan_id)
                .and_then(|draft| draft.questions.iter().find(|draft| draft.question_post_id == request.response.question_post_id))
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "conversation-drafts-team-question"))?;
            if *submitted_seq > draft.edit_seq || *submitted_seq == draft.edit_seq && !question_input_matches(draft, &request.response.response) {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-team-question"));
            }
            (request.project_id, *conversation_id, *submitted_seq)
        }
        ConversationDraftPending::Create {
            request,
            submitted_seq,
        } => {
            if request.title.as_ref().is_some_and(|title| {
                title.trim().is_empty() || title.len() > MAX_CONVERSATION_TITLE_BYTES
            }) {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-title"));
            }
            (request.project_id, request.conversation_id, *submitted_seq)
        }
        ConversationDraftPending::Append {
            request,
            submitted_seq,
        } => {
            if request.body.trim().is_empty()
                || request.body.len() > MAX_CONVERSATION_MESSAGE_BYTES
                || *submitted_seq > message_seq
                || *submitted_seq == message_seq && request.body != text
            {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-message"));
            }
            (request.project_id, request.conversation_id, *submitted_seq)
        }
        ConversationDraftPending::Planning {
            request,
            submitted_seq,
            ..
        } => {
            if request.consent.action_id != request.consent.attempt_id {
                return Err(fail(
                    ErrorCode::InvalidInput,
                    "conversation-drafts-planning",
                ));
            }
            (request.project_id, request.conversation_id, *submitted_seq)
        }
        ConversationDraftPending::ProposalCapture {
            request,
            submitted_seq,
        } => (request.project_id, request.conversation_id, *submitted_seq),
        ConversationDraftPending::ProposalRevision {
            request,
            submitted_seq,
        } => (request.project_id, request.conversation_id, *submitted_seq),
        ConversationDraftPending::ProposalWorkPlan {
            request,
            submitted_seq,
        } => {
            super::encode_bounded(request, tsumugi_core::execution::MAX_INPUT_BYTES)?;
            (
                request.proposal.project_id,
                request.proposal.conversation_id,
                *submitted_seq,
            )
        }
        ConversationDraftPending::WorkPlanStart {
            conversation_id,
            request,
            submitted_seq,
            ..
        } => (request.project_id, *conversation_id, *submitted_seq),
        ConversationDraftPending::WorkPlanControl {
            conversation_id,
            request,
            submitted_seq,
        } => (request.project_id, *conversation_id, *submitted_seq),
        ConversationDraftPending::TeamMessage { conversation_id, request, destination, submitted_seq, .. } => {
            let draft = team_drafts.iter().find(|draft| draft.plan_id == request.lease.plan_id)
                .and_then(|draft| draft.guidance.as_ref())
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "conversation-drafts-team-message"))?;
            if request.lease.generation.get() == 0
                || destination.name.len() > 128 || destination.endpoint.len() > 2048 || destination.model.len() > 128
                || destination.role.len() > tsumugi_core::application::TeamDiscussionLimits::current_plan().max_post_bytes as usize
                || request.message.body.trim().is_empty()
                || request.message.body.len() > tsumugi_core::application::TeamMessageLimits::current_team().max_body_bytes as usize
                || *submitted_seq > draft.edit_seq
                || *submitted_seq == draft.edit_seq && (draft.body != request.message.body
                    || draft.member_id != Some(request.message.recipient_member_id)
                    || draft.unit_id != Some(request.message.target.unit_id))
            {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-team-message"));
            }
            super::encode_bounded(request, tsumugi_core::execution::MAX_INPUT_BYTES)?;
            (request.project_id, *conversation_id, *submitted_seq)
        }
        ConversationDraftPending::TeamPublication { conversation_id, request, submitted_seq, .. } => {
            let draft = team_drafts.iter().find(|draft| draft.plan_id == request.lease.plan_id)
                .and_then(|draft| draft.publication.as_ref())
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "conversation-drafts-team-publication"))?;
            if request.lease.generation.get() == 0
                || request.publication.body.trim().is_empty()
                || request.publication.body.len() > tsumugi_core::application::TeamDiscussionLimits::current_plan().max_post_bytes as usize
                || *submitted_seq > draft.edit_seq
                || *submitted_seq == draft.edit_seq && (draft.body != request.publication.body
                    || draft.unit_id != Some(request.publication.target.unit_id)
                    || draft.reply_to != request.publication.reply_to)
            {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-team-publication"));
            }
            super::encode_bounded(request, tsumugi_core::execution::MAX_INPUT_BYTES)?;
            (request.project_id, *conversation_id, *submitted_seq)
        }
        ConversationDraftPending::TeamRecovery { conversation_id, request, authorization, submitted_seq } => {
            let recovery = &request.recovery;
            let draft = team_drafts.iter().find(|draft| draft.plan_id == recovery.plan_id)
                .and_then(|draft| draft.recovery.as_ref())
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "conversation-drafts-team-recovery"))?;
            if request.project_id != recovery.project_id
                || recovery.expected_lease.plan_id != recovery.plan_id
                || recovery.expected_lease.generation.get() == 0
                || recovery.expected_effective_version.lease.plan_id != recovery.plan_id
                || *submitted_seq > draft.edit_seq
                || *submitted_seq == draft.edit_seq && !same_recovery_input(draft, request)
                || authorization.as_ref().is_some_and(|authorization| !recovery_authorization_matches(request, authorization))
            {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-team-recovery"));
            }
            super::encode_bounded(request, tsumugi_core::execution::MAX_INPUT_BYTES)?;
            (request.project_id, *conversation_id, *submitted_seq)
        }
    };
    if project != key.project_id || thread != key.conversation_id || submitted > seq {
        return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-pending"));
    }
    Ok(())
}
fn validate_value(key: &ConversationDraftKey, value: &ConversationDraftValue) -> Result<()> {
    let message_seq = value.message_edit_seq.unwrap_or(value.edit_seq);
    if message_seq > value.edit_seq {
        return Err(fail(
            ErrorCode::InvalidInput,
            "conversation-drafts-message-sequence",
        ));
    }
    if value.team_drafts.len() > 32 {
        return Err(fail(ErrorCode::LimitExceeded, "conversation-drafts-team-limit"));
    }
    let mut plans = BTreeSet::new();
    for draft in &value.team_drafts {
        if draft.questions.len() > 32 { return Err(fail(ErrorCode::LimitExceeded, "conversation-drafts-team-question-limit")); }
        let mut questions = BTreeSet::new();
        if !plans.insert(draft.plan_id)
            || !valid_digest(&draft.plan_digest)
            || draft.questions.iter().any(|question| question.edit_seq > value.edit_seq || !questions.insert(question.question_post_id))
            || draft.guidance.as_ref().is_some_and(|input| input.edit_seq > value.edit_seq)
            || draft.publication.as_ref().is_some_and(|input| input.edit_seq > value.edit_seq)
            || draft.recovery.as_ref().is_some_and(|input| {
                let mut keys = BTreeSet::new();
                input.edit_seq > value.edit_seq
                    || input.members.iter().any(|member| member.key >= input.next_key || !keys.insert(member.key))
            })
            || draft.recovery_recorded.as_ref().is_some_and(|record| !valid_recovery_record(key, draft.plan_id, record))
        {
            return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-team"));
        }
    }
    let mut proposals = BTreeSet::new();
    for draft in &value.proposal_edits {
        if !proposals.insert(draft.proposal_id)
            || draft.edit_seq > value.edit_seq
            || !matches!(
                draft.content,
                ConversationPlanningModelOutput::Proposal { .. }
                    | ConversationPlanningModelOutput::KnowledgeProposal { .. }
                    | ConversationPlanningModelOutput::TermProposal { .. }
            )
        {
            return Err(fail(
                ErrorCode::InvalidInput,
                "conversation-drafts-proposal",
            ));
        }
        if let Some(ConversationDraftPending::ProposalRevision {
            request,
            submitted_seq,
        }) = &value.pending
            && draft.proposal_id == request.proposal_id
            && draft.edit_seq == *submitted_seq
            && (draft.expected_revision_id != request.expected_revision_id
                || draft.content != request.content)
        {
            return Err(fail(
                ErrorCode::InvalidInput,
                "conversation-drafts-proposal-pending",
            ));
        }
    }
    if let Some(pending) = &value.pending {
        validate_pending(key, pending, value.edit_seq, message_seq, &value.text, &value.team_drafts)?;
    }
    if value.revocations.len() > 32 {
        return Err(fail(ErrorCode::LimitExceeded, "conversation-drafts-revocations"));
    }
    let mut actions = BTreeSet::new();
    for revocation in &value.revocations {
        validate_revocation(key, revocation, value.edit_seq)?;
        if !actions.insert(revocation.request.action_id)
            || value.pending.as_ref().is_some_and(|pending| {
                pending_action(pending) == revocation.request.action_id
            })
        {
            return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-revocations"));
        }
    }
    Ok(())
}
fn pending_action(pending: &ConversationDraftPending) -> ExecutionId {
    match pending {
        ConversationDraftPending::TeamQuestionResponse { request, .. } => request.response.post_id,
        ConversationDraftPending::Create { request, .. } => request.action_id,
        ConversationDraftPending::Append { request, .. } => request.action_id,
        ConversationDraftPending::Planning { request, .. } => request.consent.action_id,
        ConversationDraftPending::ProposalCapture { request, .. } => request.action_id,
        ConversationDraftPending::ProposalRevision { request, .. } => request.action_id,
        ConversationDraftPending::ProposalWorkPlan { request, .. } => request.action_id,
        ConversationDraftPending::WorkPlanStart { request, .. } => request.action_id,
        ConversationDraftPending::WorkPlanControl { request, .. } => request.action_id,
        ConversationDraftPending::TeamMessage { request, .. } => request.message.message_id,
        ConversationDraftPending::TeamPublication { request, .. } => request.publication.post_id,
        ConversationDraftPending::TeamRecovery { request, authorization, .. } => authorization.as_ref()
            .map_or(request.preparation_id, |authorization| authorization.recovery.action_id),
    }
}
fn validate_revocation(
    key: &ConversationDraftKey,
    revocation: &ConversationDraftRevocation,
    seq: Revision,
) -> Result<()> {
    if revocation.request.project_id != key.project_id
        || revocation.request.expected_generation.get() == 0
        || revocation.submitted_seq > seq
    {
        return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-revocation"));
    }
    Ok(())
}
fn has_pending(value: &ConversationDraftValue) -> bool {
    value.pending.is_some() || !value.revocations.is_empty()
}
fn same_write(before: &ConversationDraftHead, r: &ConversationDraftWrite) -> bool {
    r.expected_revision <= before.revision
        && before.writer_id == Some(r.writer_id)
        && before.value.as_ref() == Some(&r.value)
}
fn apply_write(
    before: &ConversationDraftHead,
    r: &ConversationDraftWrite,
    resolve: Option<(&ConversationDraftResolveTarget, ConversationDraftDisposition)>,
) -> Result<ConversationDraftHead> {
    if same_write(before, r) {
        return Ok(before.clone());
    }
    if before.revision != r.expected_revision {
        return Err(fail(ErrorCode::DependencyConflict, "drafts-revision"));
    }
    if before
        .value
        .as_ref()
        .is_some_and(|old| r.value.edit_seq <= old.edit_seq)
    {
        return Err(fail(ErrorCode::DependencyConflict, "drafts-edit-sequence"));
    }
    let old = before.value.as_ref();
    match resolve {
        Some((ConversationDraftResolveTarget::Pending { pending }, disposition))
            if r.value.pending.is_none()
                && old.and_then(|value| value.pending.as_ref()) == Some(pending)
                && old.is_some_and(|value| value.revocations == r.value.revocations) =>
        {
            let previous = old.ok_or_else(|| fail(ErrorCode::DependencyConflict, "drafts-pending"))?;
            if matches!(pending, ConversationDraftPending::TeamMessage { .. } | ConversationDraftPending::TeamPublication { .. }
                | ConversationDraftPending::TeamRecovery { .. } | ConversationDraftPending::TeamQuestionResponse { .. }) {
                let mut expected = previous.clone();
                expected.pending = None;
                expected.edit_seq = r.value.edit_seq;
                // Making the implicit composer sequence explicit preserves its
                // original meaning while this resolution advances the total.
                if previous.message_edit_seq.is_none() && r.value.message_edit_seq == Some(previous.edit_seq) {
                    expected.message_edit_seq = Some(previous.edit_seq);
                }
                if disposition == ConversationDraftDisposition::Recorded {
                    match pending {
                        ConversationDraftPending::TeamMessage { request, submitted_seq, .. } => {
                            let draft = expected.team_drafts.iter_mut().find(|draft| draft.plan_id == request.lease.plan_id)
                                .and_then(|draft| draft.guidance.as_mut())
                                .ok_or_else(|| fail(ErrorCode::DependencyConflict, "drafts-pending"))?;
                            if draft.edit_seq == *submitted_seq { draft.body.clear(); draft.edit_seq = r.value.edit_seq; }
                        }
                        ConversationDraftPending::TeamPublication { request, submitted_seq, .. } => {
                            let draft = expected.team_drafts.iter_mut().find(|draft| draft.plan_id == request.lease.plan_id)
                                .and_then(|draft| draft.publication.as_mut())
                                .ok_or_else(|| fail(ErrorCode::DependencyConflict, "drafts-pending"))?;
                            if draft.edit_seq == *submitted_seq { draft.body.clear(); draft.edit_seq = r.value.edit_seq; }
                        }
                        ConversationDraftPending::TeamQuestionResponse { request, submitted_seq, .. } => {
                            let draft = expected.team_drafts.iter_mut().find(|draft| draft.plan_id == request.plan_id)
                                .ok_or_else(|| fail(ErrorCode::DependencyConflict, "drafts-pending"))?;
                            draft.questions.retain(|draft| draft.question_post_id != request.response.question_post_id || draft.edit_seq != *submitted_seq);
                        }
                        ConversationDraftPending::TeamRecovery { .. } => (),
                        _ => unreachable!("team pending selected above"),
                    }
                }
                if expected != r.value { return Err(fail(ErrorCode::DependencyConflict, "drafts-pending")); }
            } else if previous.team_drafts != r.value.team_drafts {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
            }
        }
        Some((ConversationDraftResolveTarget::Revocation { revocation }, _)) => {
            let old = old.ok_or_else(|| fail(ErrorCode::DependencyConflict, "drafts-pending"))?;
            let Some(index) = old.revocations.iter().position(|slot| {
                slot.request.plan_id == revocation.request.plan_id
                    && slot.request.action_id == revocation.request.action_id
            }) else {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
            };
            let mut expected = old.clone();
            if expected.revocations.remove(index) != *revocation {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
            }
            expected.edit_seq = r.value.edit_seq;
            if expected != r.value {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
            }
        }
        Some(_) => return Err(fail(ErrorCode::DependencyConflict, "drafts-pending")),
        None if old.and_then(|value| value.pending.as_ref())
            .is_some_and(|pending| r.value.pending.as_ref().is_none_or(|next| {
                next != pending && !recovery_authorization_append(pending, next)
            })) =>
        {
            return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
        }
        None if old.is_some_and(|value| !r.value.revocations.starts_with(&value.revocations)) => {
            return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
        }
        None if old.and_then(|value| value.pending.as_ref()).is_none()
            && matches!(r.value.pending, Some(ConversationDraftPending::TeamRecovery { authorization: Some(_), .. })) => {
            return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
        }
        None => (),
    }
    Ok(ConversationDraftHead {
        key: r.key.clone(),
        revision: next_revision(before.revision)?,
        writer_id: Some(r.writer_id),
        value: Some(r.value.clone()),
    })
}

pub(super) type Stored = (i64, Option<i64>, i64, Option<Vec<u8>>);
fn stored(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Stored> {
    Ok((
        row.get(offset)?,
        row.get(offset + 1)?,
        row.get(offset + 2)?,
        row.get(offset + 3)?,
    ))
}
pub(super) fn decode(key: &ConversationDraftKey, row: Stored, format: i64) -> Result<ConversationDraftHead> {
    let (revision, seq, pending, payload) = row;
    let payload =
        payload.ok_or_else(|| fail(ErrorCode::CorruptLedger, "conversation-drafts-record"))?;
    let head: ConversationDraftHead = serde_json::from_slice(&payload)
        .map_err(|_| fail(ErrorCode::CorruptLedger, "conversation-drafts-record"))?;
    let value = head.value.as_ref();
    if head.key != *key
        || revision <= 0
        || head.revision != stored_revision(revision)?
        || head.writer_id.is_some() != value.is_some()
        || seq != value.map(|value| value.edit_seq.get() as i64)
        || pending != i64::from(value.is_some_and(has_pending))
        || value.is_some_and(|value| validate_value(key, value).is_err())
        || format < PROPOSAL_FORMAT
            && value.is_some_and(|value| {
                !value.proposal_edits.is_empty() || value.message_edit_seq.is_some()
            })
        || format < RUN_FORMAT
            && value
                .and_then(|value| value.pending.as_ref())
                .is_some_and(|pending| {
                    matches!(
                        pending,
                        ConversationDraftPending::WorkPlanStart { .. }
                            | ConversationDraftPending::WorkPlanControl { .. }
                    )
                })
        || format < REVOCATION_FORMAT && value.is_some_and(|value| !value.revocations.is_empty())
        || format < TEAM_DRAFT_FORMAT && value.is_some_and(|value| !value.team_drafts.is_empty()
            || matches!(value.pending, Some(ConversationDraftPending::TeamMessage { .. } | ConversationDraftPending::TeamPublication { .. })))
        || format < TEAM_QUESTION_FORMAT && value.is_some_and(|value| value.team_drafts.iter().any(|draft| !draft.questions.is_empty())
            || matches!(value.pending, Some(ConversationDraftPending::TeamQuestionResponse { .. })))
        || format < TEAM_RECOVERY_FORMAT && value.is_some_and(|value| value.team_drafts.iter().any(|draft| draft.recovery.is_some() || draft.recovery_recorded.is_some())
            || matches!(value.pending, Some(ConversationDraftPending::TeamRecovery { .. })))
        || format < TERM_PROPOSAL_FORMAT && value.is_some_and(|value| {
            value.proposal_edits.iter().any(|draft| matches!(draft.content, ConversationPlanningModelOutput::TermProposal { .. }))
                || matches!(&value.pending, Some(ConversationDraftPending::ProposalRevision { request, .. })
                    if matches!(request.content, ConversationPlanningModelOutput::TermProposal { .. }))
        })
        || format < KNOWLEDGE_PROPOSAL_FORMAT && value.is_some_and(|value| {
            value.proposal_edits.iter().any(|draft| matches!(draft.content, ConversationPlanningModelOutput::KnowledgeProposal { .. }))
                || matches!(&value.pending, Some(ConversationDraftPending::ProposalRevision { request, .. })
                    if matches!(request.content, ConversationPlanningModelOutput::KnowledgeProposal { .. }))
        })
        || format == CONVERSATION_FORMAT
            && value
                .and_then(|value| value.pending.as_ref())
                .is_some_and(|pending| {
                    !matches!(
                        pending,
                        ConversationDraftPending::Create { .. }
                            | ConversationDraftPending::Append { .. }
                    )
                })
        || encode(&head)
            .map_err(|_| fail(ErrorCode::CorruptLedger, "conversation-drafts-record"))?
            != payload
    {
        return Err(fail(ErrorCode::CorruptLedger, "conversation-drafts-record"));
    }
    Ok(head)
}
fn read_head(
    c: &Connection,
    key: &ConversationDraftKey,
    format: i64,
) -> Result<ConversationDraftHead> {
    if format < CONVERSATION_FORMAT {
        return Ok(empty(key));
    }
    let row=c.query_row("SELECT revision,edit_seq,has_pending,CASE WHEN length(payload)<=?3 THEN payload END FROM conversation_draft_heads WHERE project_id=?1 AND conversation_id=?2",params![key.project_id.to_string(),key.conversation_id.to_string(),record_limit(format) as i64],|row|stored(row,0)).optional().map_err(sql)?;
    match row {
        Some(row) => decode(key, row, format),
        None => Ok(empty(key)),
    }
}

/// Validate every old head. Only format 3 needs its payload constraint rebuilt;
/// Formats 4 through 7 already have the current tables and limits.
pub(super) fn upgrade(c: &Connection, format: i64) -> Result<()> {
    let mut query = c.prepare("SELECT project_id,conversation_id,revision,edit_seq,has_pending,CASE WHEN length(payload)<=?1 THEN payload END FROM conversation_draft_heads ORDER BY project_id,conversation_id").map_err(sql)?;
    let rows = query
        .query_map([record_limit(format) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                stored(row, 2)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (project, thread, row) = row.map_err(sql)?;
        let key = ConversationDraftKey {
            project_id: stored_id(&project)?,
            conversation_id: stored_id(&thread)?,
        };
        decode(&key, row, format)?;
    }
    drop(query);
    if format >= ACTION_FORMAT {
        return Ok(());
    }
    c.execute_batch(
        "ALTER TABLE conversation_draft_heads RENAME TO conversation_draft_heads_legacy",
    )
    .map_err(sql)?;
    test_hook("conversation-upgrade-after-rename", Some(c));
    c.execute_batch(HEAD_SQL).map_err(sql)?;
    c.execute_batch(
        "INSERT INTO conversation_draft_heads SELECT * FROM conversation_draft_heads_legacy",
    )
    .map_err(sql)?;
    test_hook("conversation-upgrade-after-copy", Some(c));
    c.execute_batch("DROP TABLE conversation_draft_heads_legacy")
        .map_err(sql)?;
    Ok(())
}
fn persist(c: &Connection, head: &ConversationDraftHead, payload: &[u8]) -> Result<()> {
    c.execute("INSERT INTO conversation_draft_heads VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(project_id,conversation_id) DO UPDATE SET revision=excluded.revision,edit_seq=excluded.edit_seq,has_pending=excluded.has_pending,payload=excluded.payload",params![head.key.project_id.to_string(),head.key.conversation_id.to_string(),head.revision.get() as i64,head.value.as_ref().map(|value|value.edit_seq.get() as i64),i64::from(head.value.as_ref().is_some_and(has_pending)),payload]).map_err(sql)?;
    Ok(())
}
fn mutate_existing(
    c: &mut Connection,
    key: &ConversationDraftKey,
    apply: &impl Fn(&ConversationDraftHead) -> Result<ConversationDraftHead>,
    limits: Limits,
) -> Result<ConversationDraftHead> {
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    let format = verify_schema(&tx)?;
    let before = read_head(&tx, key, format)?;
    let after = apply(&before)?;
    if before == after {
        if format < FORMAT {
            upgrade_schema(&tx, format)?;
            tx.commit()
                .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
        }
        return Ok(before);
    }
    let payload = encode(&after)?;
    let (bytes, records, project_bytes, project_records) =
        journal_usage(&tx, format, key.project_id)?;
    let old = if before.revision.get() == 0 {
        0
    } else {
        encode(&before)?.len()
    };
    check_quota(
        project_bytes as usize,
        bytes as usize,
        project_records as usize,
        records as usize,
        old,
        payload.len(),
        before.revision.get() == 0,
        limits,
    )?;
    upgrade_schema(&tx, format)?;
    persist(&tx, &after, &payload)?;
    test_hook("write-before-commit", Some(&tx));
    tx.commit()
        .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
    test_hook("write-after-commit", None);
    Ok(after)
}
impl DraftStore {
    fn mutate_conversation(
        &self,
        key: &ConversationDraftKey,
        apply: impl Fn(&ConversationDraftHead) -> Result<ConversationDraftHead>,
    ) -> Result<ConversationDraftHead> {
        if let Some(mut c) = self.existing(true)? {
            return mutate_existing(&mut c, key, &apply, self.limits);
        }
        let after = apply(&empty(key))?;
        let payload = encode(&after)?;
        check_quota(0, 0, 0, 0, 0, payload.len(), true, self.limits)?;
        self.initialize_or_retry(
            |c| {
                persist(c, &after, &payload)?;
                Ok(after.clone())
            },
            |c| mutate_existing(c, key, &apply, self.limits),
        )
    }
    pub fn read_conversation(&self, key: &ConversationDraftKey) -> Result<ConversationDraftHead> {
        let Some(mut c) = self.existing(false)? else {
            return Ok(empty(key));
        };
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        let format = verify_schema(&tx)?;
        read_head(&tx, key, format)
    }
    pub fn write_conversation(&self, r: &ConversationDraftWrite) -> Result<ConversationDraftHead> {
        validate_value(&r.key, &r.value)?;
        self.mutate_conversation(&r.key, |before| apply_write(before, r, None))
    }
    /// Called only after the Host proves the requested disposition of this slot.
    pub fn resolve_conversation(
        &self,
        r: &ConversationDraftResolve,
    ) -> Result<ConversationDraftHead> {
        validate_value(&r.write.key, &r.write.value)?;
        match &r.target {
            ConversationDraftResolveTarget::Pending { pending } => {
                // The stored pending and full old input are checked by decode
                // and exact target matching below. A recorded answer may remove
                // just its submitted question input from the resulting value.
                if let ConversationDraftPending::TeamQuestionResponse { request, question, .. } = pending {
                    validate_question_request(request, question)?;
                } else {
                    validate_pending(
                        &r.write.key, pending, r.write.value.edit_seq,
                        r.write.value.message_edit_seq.unwrap_or(r.write.value.edit_seq),
                        &r.write.value.text, &r.write.value.team_drafts,
                    )?;
                }
                if r.write.value.pending.is_some()
                    || r.disposition == ConversationDraftDisposition::FencedNotApplied
                        && !matches!(pending, ConversationDraftPending::WorkPlanStart { .. }
                            | ConversationDraftPending::WorkPlanControl { .. }
                            | ConversationDraftPending::TeamMessage { .. }
                            | ConversationDraftPending::TeamPublication { .. }
                            | ConversationDraftPending::TeamRecovery { .. }
                            | ConversationDraftPending::TeamQuestionResponse { .. })
                {
                    return Err(fail(ErrorCode::InvalidInput, "drafts-pending"));
                }
            }
            ConversationDraftResolveTarget::Revocation { revocation } => {
                validate_revocation(&r.write.key, revocation, r.write.value.edit_seq)?;
                if r.write.value.revocations.iter().any(|slot| {
                    slot.request.plan_id == revocation.request.plan_id
                        && slot.request.action_id == revocation.request.action_id
                }) {
                    return Err(fail(ErrorCode::InvalidInput, "drafts-pending"));
                }
            }
        }
        self.mutate_conversation(&r.write.key, |before| {
            apply_write(before, &r.write, Some((&r.target, r.disposition)))
        })
    }
    pub fn clear_conversation(&self, r: &ConversationDraftClear) -> Result<ConversationDraftHead> {
        self.mutate_conversation(&r.key, |before| {
            if before.revision != r.expected_revision {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-revision"));
            }
            if before
                .value
                .as_ref()
                .is_some_and(has_pending)
            {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
            }
            if before.value.is_none() && before.revision.get() > 0 {
                return Ok(before.clone());
            }
            Ok(ConversationDraftHead {
                key: r.key.clone(),
                revision: next_revision(before.revision)?,
                writer_id: None,
                value: None,
            })
        })
    }
    pub fn list_conversations(
        &self,
        project: ExecutionId,
        after: Option<&ConversationDraftKey>,
        limit: u32,
    ) -> Result<ConversationDraftPage> {
        if !(1..=MAX_DRAFT_PAGE_SIZE).contains(&limit)
            || after.is_some_and(|key| key.project_id != project)
        {
            return Err(fail(ErrorCode::InvalidInput, "drafts-page"));
        }
        let Some(mut c) = self.existing(false)? else {
            return Ok(ConversationDraftPage {
                items: vec![],
                next: None,
            });
        };
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        let format = verify_schema(&tx)?;
        if format < CONVERSATION_FORMAT {
            return Ok(ConversationDraftPage {
                items: vec![],
                next: None,
            });
        }
        let mut q=tx.prepare("SELECT conversation_id,revision,edit_seq,has_pending,CASE WHEN length(payload)<=?4 THEN payload END FROM conversation_draft_heads WHERE project_id=?1 AND (?2 IS NULL OR conversation_id>?2) ORDER BY conversation_id LIMIT ?3").map_err(sql)?;
        let rows = q
            .query_map(
                params![
                    project.to_string(),
                    after.map(|key| key.conversation_id.to_string()),
                    limit + 1,
                    record_limit(format) as i64
                ],
                |row| Ok((row.get::<_, String>(0)?, stored(row, 1)?)),
            )
            .map_err(sql)?;
        let mut items = vec![];
        let mut last = None;
        let mut more = false;
        for (index, row) in rows.enumerate() {
            let (thread, row) = row.map_err(sql)?;
            let key = ConversationDraftKey {
                project_id: project,
                conversation_id: stored_id(&thread)?,
            };
            let head = decode(&key, row, format)?;
            if index == limit as usize {
                more = true;
                break;
            }
            last = Some(key.clone());
            if let Some(value) = head.value {
                items.push(ConversationDraftSummary {
                    key,
                    revision: head.revision,
                    edit_seq: value.edit_seq,
                    has_pending: has_pending(&value),
                });
            }
        }
        Ok(ConversationDraftPage {
            items,
            next: if more { last } else { None },
        })
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod recovery_tests;

#[cfg(test)]
mod question_tests;
#[cfg(test)]
mod term_tests;
