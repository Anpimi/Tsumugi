//! Outstanding member questions are projections of their immutable post owner.
use super::*;
use crate::application::{ReadTeamQuestions, TeamDiscussionAuthor, TeamQuestionState};
use rusqlite::OptionalExtension;

fn identity(raw: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&raw).map_err(|_| failure(ErrorCode::CorruptLedger, "decision-team-question-identity"))
}

/// Inspect every bounded plan, including old plans without question consent.
/// Filtering an unverified JSON flag could hide a damaged original record.
fn plans_in(c: &Connection) -> Result<(Vec<ExecutionId>, bool), ExecutionError> {
    let mut statement = c.prepare("SELECT plan_id FROM application_plans ORDER BY plan_id LIMIT ?1")
        .map_err(super::super::ledger::sql_error)?;
    let mut plans = statement.query_map([(SOURCE_LIMIT + 1) as i64], |row| row.get::<_, String>(0))
        .map_err(super::super::ledger::sql_error)?
        .map(|row| identity(row.map_err(super::super::ledger::sql_error)?))
        .collect::<Result<Vec<_>, _>>()?;
    let complete = plans.len() <= SOURCE_LIMIT;
    plans.truncate(SOURCE_LIMIT);
    Ok((plans, complete))
}

fn conversation(store: &ProjectStore, c: &Connection, project: ExecutionId, plan: ExecutionId)
    -> Result<Option<ExecutionId>, ExecutionError> {
    let thread = c.query_row("SELECT conversation_id FROM application_conversation_work_plans WHERE plan_id=?1",
        [plan.to_string()], |row| row.get::<_, String>(0)).optional().map_err(super::super::ledger::sql_error)?;
    let Some(thread) = thread else { return Ok(None); };
    let thread = identity(thread)?;
    // Only the canonical association reader can establish this navigation link.
    let link = store.read_conversation_proposal_work_plan(project, thread, plan)?;
    Ok(Some(link.conversation_id))
}

pub(super) fn project(store: &ProjectStore, c: &Connection, project: ExecutionId, locale: Option<&str>)
    -> Result<SourceProjection, ExecutionError> {
    let (plans, complete) = plans_in(c)?;
    let mut items = Vec::new();
    for plan in plans {
        let mut after = None;
        let mut thread = None;
        loop {
            let page = store.read_team_questions(&ReadTeamQuestions { project_id: project, plan_id: plan, after, limit: 16 })?;
            for view in page.questions {
                if view.state != TeamQuestionState::Open
                    || locale.is_some_and(|locale| locale != view.question.publication.target.locale) { continue; }
                if items.len() == SOURCE_LIMIT { return Ok(SourceProjection { items, complete: false }); }
                let question = &view.question;
                let TeamDiscussionAuthor::Member { author } = &question.author else {
                    return Err(failure(ErrorCode::CorruptLedger, "decision-team-question-author"));
                };
                let thread = match thread {
                    Some(value) => value,
                    None => { let value = conversation(store, c, project, plan)?; thread = Some(value); value }
                };
                let mut targets = vec![DecisionTarget::Plan { plan_id: plan },
                    DecisionTarget::Entry { unit_id: question.publication.target.unit_id }];
                if let Some(conversation_id) = thread { targets.push(DecisionTarget::Conversation { conversation_id }); }
                // Hash the full verified original without duplicating its large
                // human-facing body in the lightweight decision observation.
                let basis = codec::digest(&codec::encode(&(project, &view), crate::execution::MAX_INPUT_BYTES)?);
                items.push(DecisionItem {
                    decision_id: format!("agent-question:team:{plan}:{}", question.publication.post_id),
                    source: DecisionSource::AgentQuestion, state: DecisionState::Pending,
                    locale: Some(question.publication.target.locale.clone()), targets, targets_complete: true,
                    basis, source_action_id: Some(question.publication.post_id),
                    action: DecisionAction::AnswerTeamQuestion { plan_id: plan, question_post_id: question.publication.post_id },
                    evidence: Some(DecisionEvidence::TeamQuestion { member_id: author.member_id, role_version_id: author.role_version_id }),
                });
            }
            match page.next_after {
                Some(next) if after.is_none_or(|previous| next > previous) => after = Some(next),
                Some(_) => return Err(failure(ErrorCode::CorruptLedger, "decision-team-question-page")),
                None => break,
            }
        }
    }
    Ok(SourceProjection { items, complete })
}

#[cfg(test)]
mod tests;
