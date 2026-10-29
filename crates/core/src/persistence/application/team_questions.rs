//! Question state is rebuilt from the original immutable team posts.
use super::{ProjectStore, team};
use crate::{application::*, execution::*};
use rusqlite::Connection;

fn fail(code: ErrorCode, stage: &str) -> ExecutionError { ExecutionError::new(code, stage) }
fn corrupt() -> ExecutionError { fail(ErrorCode::CorruptLedger, "team-question-history") }
fn sql(_: rusqlite::Error) -> ExecutionError { fail(ErrorCode::StorageFailed, "team-questions") }
fn actor_valid(actor: &str) -> bool { !actor.trim().is_empty() && actor.len() <= 128 }

pub(super) fn check_content(write: &PublishTeamDiscussion) -> Result<(), ExecutionError> {
    if (write.kind == TeamDiscussionKind::HumanQuestion) != write.question.is_some() {
        return Err(fail(ErrorCode::InvalidInput, "team-question-content"));
    }
    let Some(event) = &write.question else { return Ok(()); };
    if write.supersedes.is_some() { return Err(fail(ErrorCode::InvalidInput, "team-question-chain")); }
    match event {
        TeamQuestionEvent::Open { options } => {
            if write.reply_to.is_some() || options.len() > MAX_TEAM_QUESTION_OPTIONS
                || options.iter().any(|choice| choice.label.trim().is_empty()
                    || choice.label.len() > MAX_TEAM_QUESTION_OPTION_BYTES)
                || options.iter().map(|choice| choice.option_id).collect::<std::collections::BTreeSet<_>>().len() != options.len()
            { return Err(fail(ErrorCode::InvalidInput, "team-question-options")); }
        }
        TeamQuestionEvent::Resolve { question_post_id, .. } | TeamQuestionEvent::Dismiss { question_post_id } => {
            if write.reply_to != Some(*question_post_id) || !write.references.is_empty() {
                return Err(fail(ErrorCode::InvalidInput, "team-question-response"));
            }
        }
    }
    Ok(())
}

pub(super) fn questions(posts: &[TeamDiscussionPost]) -> Result<Vec<TeamQuestionView>, ExecutionError> {
    let mut result: Vec<TeamQuestionView> = Vec::new();
    for post in posts {
        match &post.publication.question {
            Some(TeamQuestionEvent::Open { .. }) => result.push(TeamQuestionView {
                question: post.clone(), state: TeamQuestionState::Open, response: None,
            }),
            Some(event @ (TeamQuestionEvent::Resolve { question_post_id, .. } | TeamQuestionEvent::Dismiss { question_post_id })) => {
                let original = result.iter_mut().find(|value| value.question.publication.post_id == *question_post_id).ok_or_else(corrupt)?;
                if original.state != TeamQuestionState::Open || original.question.publication.target != post.publication.target {
                    return Err(corrupt());
                }
                if let TeamQuestionEvent::Resolve { answer: TeamQuestionAnswer::Choice { option_id }, .. } = event {
                    let Some(TeamQuestionEvent::Open { options }) = &original.question.publication.question else { return Err(corrupt()); };
                    if !options.iter().any(|option| option.option_id == *option_id && option.label == post.publication.body) { return Err(corrupt()); }
                }
                original.state = if matches!(event, TeamQuestionEvent::Resolve { .. }) { TeamQuestionState::Resolved } else { TeamQuestionState::Dismissed };
                original.response = Some(post.clone());
            }
            None => {}
        }
    }
    Ok(result)
}

pub(super) fn validate_history(plan: &WorkPlan, posts: &[TeamDiscussionPost]) -> Result<(), ExecutionError> {
    for post in posts {
        check_content(&post.publication).map_err(|_| corrupt())?;
        match (&post.publication.question, &post.author) {
            (Some(TeamQuestionEvent::Open { .. }), TeamDiscussionAuthor::Member { .. })
                if plan.options.team_questions.is_some() && plan.options.team_execution.is_some() => {}
            (Some(TeamQuestionEvent::Resolve { .. } | TeamQuestionEvent::Dismiss { .. }), TeamDiscussionAuthor::LocalHuman { actor })
                if plan.options.team_questions.is_some() && actor_valid(actor) => {}
            (None, TeamDiscussionAuthor::Member { .. } | TeamDiscussionAuthor::Human { .. }) => {}
            _ => return Err(corrupt()),
        }
    }
    let open = questions(posts)?.iter().filter(|value| value.state == TeamQuestionState::Open).count();
    if posts.len() + open > TeamDiscussionLimits::current_plan().max_posts as usize { return Err(corrupt()); }
    Ok(())
}

/// Reserve one terminal post for every open question, even if normal discussion fills up.
pub(super) fn check_capacity(posts: &[TeamDiscussionPost], write: &PublishTeamDiscussion) -> Result<(), ExecutionError> {
    let current = questions(posts)?;
    let mut open = current.iter().filter(|value| value.state == TeamQuestionState::Open).count();
    match &write.question {
        Some(TeamQuestionEvent::Open { .. }) => open += 1,
        Some(TeamQuestionEvent::Resolve { question_post_id, .. } | TeamQuestionEvent::Dismiss { question_post_id }) => {
            if !current.iter().any(|value| value.question.publication.post_id == *question_post_id && value.state == TeamQuestionState::Open) {
                return Err(fail(ErrorCode::DependencyConflict, "team-question-closed"));
            }
            open -= 1;
        }
        None => {}
    }
    if posts.len() + 1 + open > TeamDiscussionLimits::current_plan().max_posts as usize {
        return Err(fail(ErrorCode::LimitExceeded, "team-question-capacity"));
    }
    Ok(())
}

pub(super) fn required(posts: &[TeamDiscussionPost]) -> std::collections::BTreeSet<ExecutionId> {
    // Retaining both the question and its explicit human disposition keeps the
    // next request from seeing an answer without the original question.
    posts.iter().filter(|post| post.publication.question.is_some()).map(|post| post.publication.post_id).collect()
}

pub(super) fn visible(plan: &WorkPlan, post: &TeamDiscussionPost) -> bool {
    post.publication.question.is_none() || plan.options.team_questions.is_some()
}

fn history(c: &Connection, project: ExecutionId, plan_id: ExecutionId) -> Result<(WorkPlan, Vec<TeamDiscussionPost>), ExecutionError> {
    let plan = team::historical_plan(c, project, plan_id)
        .map_err(|error| if error.code == ErrorCode::InvalidInput { corrupt() } else { error })?;
    team::history_in(c, &plan)?;
    let posts = team::all_posts(c, plan_id)?;
    Ok((plan, posts))
}
fn question_in(posts: &[TeamDiscussionPost], id: ExecutionId) -> Result<TeamQuestionView, ExecutionError> {
    questions(posts)?.into_iter().find(|value| value.question.publication.post_id == id)
        .ok_or_else(|| fail(ErrorCode::InvalidInput, "team-question-not-found"))
}
fn ask_receipt(c: &Connection, author: &CapturedTeamAuthor, write: &PublishTeamDiscussion) -> Result<Option<TeamDiscussionPost>, ExecutionError> {
    let Some(prior) = team::post(c, write.post_id)? else { return Ok(None); };
    let (_, posts) = history(c, author.scope().project_id(), author.scope().lease().plan_id)?;
    if prior.publication != *write || prior.author != (TeamDiscussionAuthor::Member { author: author.author().clone() }) || !posts.contains(&prior) {
        return Err(fail(ErrorCode::ResultMismatch, "team-question-action"));
    }
    Ok(Some(prior))
}
fn response_publication(question: &TeamQuestionView, request: &RespondTeamQuestion) -> Result<PublishTeamDiscussion, ExecutionError> {
    let (body, event) = match &request.response {
        TeamQuestionResponse::Choice { option_id } => {
            let Some(TeamQuestionEvent::Open { options }) = &question.question.publication.question else { return Err(corrupt()); };
            let choice = options.iter().find(|choice| choice.option_id == *option_id)
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "team-question-choice"))?;
            (choice.label.clone(), TeamQuestionEvent::Resolve { question_post_id: request.question_post_id, answer: TeamQuestionAnswer::Choice { option_id: *option_id } })
        }
        TeamQuestionResponse::Text { body } => (body.clone(), TeamQuestionEvent::Resolve { question_post_id: request.question_post_id, answer: TeamQuestionAnswer::Text {} }),
        TeamQuestionResponse::Dismiss { reason } => (reason.clone(), TeamQuestionEvent::Dismiss { question_post_id: request.question_post_id }),
    };
    let publication = PublishTeamDiscussion { post_id: request.post_id, target: question.question.publication.target.clone(),
        kind: TeamDiscussionKind::HumanQuestion, body, references: vec![], reply_to: Some(request.question_post_id), supersedes: None, question: Some(event) };
    team::check_content(&publication)?;
    Ok(publication)
}
fn response_outcome(c: &Connection, project: ExecutionId, plan: ExecutionId, actor: &str,
    request: &RespondTeamQuestion) -> Result<(PublishTeamDiscussion, TeamQuestionResponseOutcome), ExecutionError> {
    if !actor_valid(actor) { return Err(fail(ErrorCode::InvalidInput, "team-question-actor")); }
    let (_, posts) = history(c, project, plan)?;
    let question = question_in(&posts, request.question_post_id)?;
    let write = response_publication(&question, request)?;
    if let Some(saved) = team::post(c, request.post_id)? {
        if saved.plan_id != plan || saved.publication != write
            || saved.author != (TeamDiscussionAuthor::LocalHuman { actor: actor.into() }) || !posts.contains(&saved) {
            return Err(fail(ErrorCode::ResultMismatch, "team-question-action"));
        }
        return Ok((write, TeamQuestionResponseOutcome::Recorded { receipt: saved }));
    }
    Ok((write, match question.response {
        Some(receipt) => TeamQuestionResponseOutcome::ClosedByOther { receipt },
        None => TeamQuestionResponseOutcome::Pending {},
    }))
}

impl ProjectStore {
    pub fn ask_human_question(&mut self, author: &CapturedTeamAuthor, request: &AskHumanQuestion) -> Result<TeamDiscussionPost, ExecutionError> {
        let write = PublishTeamDiscussion { post_id: request.post_id, target: request.target.clone(), kind: TeamDiscussionKind::HumanQuestion,
            body: request.body.clone(), references: request.references.clone(), reply_to: None, supersedes: None,
            question: Some(TeamQuestionEvent::Open { options: request.options.clone() }) };
        team::check_content(&write)?;
        let c = self.connection().map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        if let Some(prior) = super::super::review::read_snapshot(c, |c| ask_receipt(c, author, &write))? { return Ok(prior); }
        let tx = self.execution_write()?;
        if let Some(prior) = ask_receipt(&tx, author, &write)? {
            super::super::ledger::commit(tx)?;
            return Ok(prior);
        }
        self.check_team_work_author(author)?;
        let plan = team::live_plan(&tx, author.scope())?;
        if plan.options.team_questions.is_none() || write.target != *author.target() {
            return Err(fail(ErrorCode::Unauthorized, "team-questions-disabled"));
        }
        team::check_target(&plan, author.scope(), &write.target)?;
        team::check_references(&tx, &plan, &write.target, &write.references)?;
        let posts = team::all_posts(&tx, plan.plan_id)?;
        let value = team::append_post(&tx, plan.plan_id, TeamDiscussionAuthor::Member { author: author.author().clone() }, &write, &posts)?;
        super::super::ledger::commit(tx)?;
        Ok(value)
    }

    pub fn respond_team_question(&mut self, project: ExecutionId, plan: ExecutionId, actor: &str,
        request: &RespondTeamQuestion) -> Result<TeamDiscussionPost, ExecutionError> {
        let prior = self.team_question_response_settlement(project, plan, actor, request)?;
        if let TeamQuestionResponseOutcome::Recorded { receipt } = prior.outcome { return Ok(receipt); }
        let tx = self.execution_write()?;
        let (write, outcome) = response_outcome(&tx, project, plan, actor, request)?;
        let value = match outcome {
            TeamQuestionResponseOutcome::Recorded { receipt } => receipt,
            TeamQuestionResponseOutcome::ClosedByOther { .. } => return Err(fail(ErrorCode::DependencyConflict, "team-question-closed")),
            TeamQuestionResponseOutcome::Pending {} => {
                let posts = team::all_posts(&tx, plan)?;
                team::append_post(&tx, plan, TeamDiscussionAuthor::LocalHuman { actor: actor.into() }, &write, &posts)?
            }
        };
        super::super::ledger::commit(tx)?;
        Ok(value)
    }

    pub fn team_question_response_settlement(&self, project: ExecutionId, plan: ExecutionId, actor: &str,
        request: &RespondTeamQuestion) -> Result<TeamQuestionResponseSettlement, ExecutionError> {
        let c = self.connection().map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            let (_, outcome) = response_outcome(c, project, plan, actor, request)?;
            Ok(TeamQuestionResponseSettlement { project_id: project, plan_id: plan, request: request.clone(), outcome })
        })
    }

    pub fn read_team_question(&self, project: ExecutionId, plan: ExecutionId, question: ExecutionId) -> Result<TeamQuestionView, ExecutionError> {
        let c = self.connection().map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| { let (_, posts) = history(c, project, plan)?; question_in(&posts, question) })
    }

    pub fn read_team_questions(&self, request: &ReadTeamQuestions) -> Result<TeamQuestionsPage, ExecutionError> {
        if !(1..=16).contains(&request.limit) { return Err(fail(ErrorCode::InvalidInput, "team-question-page")); }
        let c = self.connection().map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            let (_, posts) = history(c, request.project_id, request.plan_id)?;
            let mut values = questions(&posts)?.into_iter().filter(|value| request.after.is_none_or(|after| value.question.sequence > after)).collect::<Vec<_>>();
            let more = values.len() > request.limit as usize;
            values.truncate(request.limit as usize);
            Ok(TeamQuestionsPage { plan_id: request.plan_id, next_after: more.then(|| values.last().unwrap().question.sequence), questions: values })
        })
    }
}

/// Older schemas cannot carry new question consent or typed post/author fields.
pub(super) fn validate_legacy(c: &Connection) -> Result<(), ExecutionError> {
    let mut plans = c.prepare("SELECT plan FROM application_plans").map_err(sql)?;
    for bytes in plans.query_map([], |row| row.get::<_, Vec<u8>>(0)).map_err(sql)? {
        let value: serde_json::Value = codec::decode(&bytes.map_err(sql)?, 1024 * 1024)?;
        if value.get("options").and_then(|value| value.get("teamQuestions")).is_some() { return Err(corrupt()); }
    }
    let mut posts = c.prepare("SELECT record FROM application_team_posts").map_err(sql)?;
    for bytes in posts.query_map([], |row| row.get::<_, Vec<u8>>(0)).map_err(sql)? {
        let value: serde_json::Value = codec::decode(&bytes.map_err(sql)?, 32768)?;
        if value.get("author").and_then(|value| value.get("kind")).and_then(|value| value.as_str()) == Some("local-human")
            || value.get("publication").is_some_and(|publication| publication.get("question").is_some()
                || publication.get("kind").and_then(|value| value.as_str()) == Some("human-question")) {
            return Err(corrupt());
        }
    }
    Ok(())
}
