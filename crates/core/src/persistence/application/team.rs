//! Same-plan collaboration facts use the original authority and short transactions.
use super::{ProjectStore, agents, control};
use crate::application::team::MAX_TEAM_REFERENCES;
use crate::{
    application::*,
    execution::{codec, *},
};
use rusqlite::{Connection, OptionalExtension, params};

const MAX_RECORD_BYTES: usize = 32 * 1024;
const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;
const MAX_HISTORY_POSTS: u32 = 16;
const TABLES: &[(&str, &str)] = &[
    (
        "application_team_members",
        "CREATE TABLE application_team_members (member_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_plans(plan_id), task_id TEXT UNIQUE REFERENCES execution_tasks(task_id), UNIQUE(plan_id,member_id))",
    ),
    (
        "application_team_roles",
        "CREATE TABLE application_team_roles (version_id TEXT PRIMARY KEY NOT NULL, member_id TEXT NOT NULL REFERENCES application_team_members(member_id), ordinal INTEGER NOT NULL CHECK(ordinal>0 AND ordinal<=16), predecessor TEXT UNIQUE REFERENCES application_team_roles(version_id), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 32768), digest TEXT NOT NULL CHECK(length(digest)=64), UNIQUE(member_id,ordinal), UNIQUE(member_id,version_id))",
    ),
    (
        "application_team_posts",
        "CREATE TABLE application_team_posts (post_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_plans(plan_id), sequence INTEGER NOT NULL CHECK(sequence>0 AND sequence<=128), reply_to TEXT REFERENCES application_team_posts(post_id), supersedes TEXT UNIQUE REFERENCES application_team_posts(post_id), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 32768), digest TEXT NOT NULL CHECK(length(digest)=64), UNIQUE(plan_id,sequence))",
    ),
];

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    fail(ErrorCode::StorageFailed, "team-storage")
}
fn corrupt() -> ExecutionError {
    fail(ErrorCode::CorruptLedger, "team-facts")
}
fn denied() -> ExecutionError {
    fail(ErrorCode::Unauthorized, "team-scope")
}
fn conflict() -> ExecutionError {
    fail(ErrorCode::DependencyConflict, "team-basis")
}

pub(super) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, statement) in TABLES {
        c.execute_batch(statement)?;
    }
    Ok(())
}
pub(super) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| name.to_string())
}
fn policy(plan: &WorkPlan) -> Result<TeamDiscussionPolicy, ExecutionError> {
    plan.options.team_discussions.ok_or_else(denied)
}
fn live_plan(c: &Connection, scope: &WorkPlanAgentScope) -> Result<WorkPlan, ExecutionError> {
    control::check_scope_in(c, scope)?;
    let stored = control::load(c, scope.lease.plan_id)?;
    let effective = super::recovery::plan_in(c, scope.lease.plan_id, scope.lease.generation)?;
    policy(&effective)?;
    if !stored
        .effects
        .contains(&AutomationEffect::PublishDiscussion)
    {
        return Err(denied());
    }
    super::super::translation::check_target(c, stored.plan.project_id, &stored.plan.locale)?;
    let current = super::super::content::scope(c)?.current_snapshot;
    if stored
        .plan
        .selection_basis
        .iter()
        .any(|basis| Some(basis.source_snapshot_id) != current)
    {
        return Err(conflict());
    }
    Ok(effective)
}
fn check_target(
    plan: &WorkPlan,
    scope: &WorkPlanAgentScope,
    target: &TeamDiscussionTarget,
) -> Result<(), ExecutionError> {
    if target.locale != plan.locale
        || !plan.selection_basis.iter().any(|basis| {
            basis.unit_id == target.unit_id
                && basis.source_snapshot_id == target.source_snapshot_id
                && basis.source_revision_id == target.source_revision_id
        })
        || scope
            .delegation
            .as_ref()
            .is_some_and(|subset| !subset.unit_ids.contains(&target.unit_id))
    {
        return Err(denied());
    }
    Ok(())
}
pub(super) fn target(
    input: &FixedInput,
    item: ExecutionId,
) -> Result<TeamDiscussionTarget, ExecutionError> {
    let item = crate::ai::item_payload(input, item)?;
    Ok(TeamDiscussionTarget {
        unit_id: item.unit_id,
        locale: item.target_locale,
        source_snapshot_id: item.source_snapshot_id,
        source_revision_id: item.source_revision_id,
    })
}
pub(super) fn load_role(
    c: &Connection,
    version: ExecutionId,
) -> Result<TeamMemberRole, ExecutionError> {
    let row: (String,i64,Option<String>,Vec<u8>,String) = c.query_row(
        "SELECT member_id,ordinal,predecessor,record,digest FROM application_team_roles WHERE version_id=?1",
        [version.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(sql)?;
    let role: TeamMemberRole = codec::decode(&row.3, MAX_RECORD_BYTES)?;
    if role.request.role_version_id != version
        || role.request.member_id.to_string() != row.0
        || role.version.get() as i64 != row.1
        || role
            .request
            .expected_role_version_id
            .map(|id| id.to_string())
            != row.2
        || codec::digest(&row.3) != row.4
        || role.request.display_name.trim().is_empty()
        || role.request.display_name.len() > 128
        || role.request.role.trim().is_empty()
        || role.request.role.len() > TeamDiscussionLimits::current_plan().max_post_bytes as usize
    {
        return Err(corrupt());
    }
    Ok(role)
}
fn latest_role(
    c: &Connection,
    member: ExecutionId,
) -> Result<Option<TeamMemberRole>, ExecutionError> {
    let id: Option<String> = c.query_row("SELECT version_id FROM application_team_roles WHERE member_id=?1 ORDER BY ordinal DESC LIMIT 1",
        [member.to_string()],|r|r.get(0)).optional().map_err(sql)?;
    id.map(|id| load_role(c, ExecutionId::parse(&id)?))
        .transpose()
}
fn role_at_generation(
    c: &Connection,
    member: ExecutionId,
    generation: Revision,
) -> Result<Option<TeamMemberRole>, ExecutionError> {
    let mut query = c
        .prepare("SELECT version_id FROM application_team_roles WHERE member_id=?1 ORDER BY ordinal DESC")
        .map_err(sql)?;
    for id in query
        .query_map([member.to_string()], |row| row.get::<_, String>(0))
        .map_err(sql)?
    {
        let role = load_role(c, ExecutionId::parse(&id.map_err(sql)?)?)?;
        if role.generation <= generation {
            return Ok(Some(role));
        }
    }
    Ok(None)
}
fn register(
    c: &Connection,
    scope: &WorkPlanAgentScope,
    write: &TeamMemberRoleWrite,
) -> Result<TeamMemberRole, ExecutionError> {
    let plan = live_plan(c, scope)?;
    if plan.options.team_execution.is_some() {
        return Err(denied());
    }
    if write.display_name.trim().is_empty()
        || write.display_name.len() > 128
        || write.role.trim().is_empty()
        || write.role.len() > TeamDiscussionLimits::current_plan().max_post_bytes as usize
    {
        return Err(fail(ErrorCode::InvalidInput, "team-role"));
    }
    let found: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM application_team_roles WHERE version_id=?1)",
            [write.role_version_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if found {
        let saved = load_role(c, write.role_version_id)?;
        return if saved.plan_id == plan.plan_id && saved.request == *write {
            Ok(saved)
        } else {
            Err(fail(ErrorCode::ResultMismatch, "team-role-id"))
        };
    }
    let existing: Option<String> = c
        .query_row(
            "SELECT plan_id FROM application_team_members WHERE member_id=?1",
            [write.member_id.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    if existing
        .as_deref()
        .is_some_and(|id| id != plan.plan_id.to_string())
    {
        return Err(denied());
    }
    let prior = latest_role(c, write.member_id)?;
    if prior.as_ref().map(|role| role.request.role_version_id) != write.expected_role_version_id {
        return Err(conflict());
    }
    let ordinal = prior.as_ref().map_or(1, |role| role.version.get() + 1);
    if ordinal > TeamDiscussionLimits::current_plan().max_role_versions_per_member as u64 {
        return Err(fail(ErrorCode::LimitExceeded, "team-roles"));
    }
    if prior
        .as_ref()
        .is_some_and(|role| role.generation >= scope.lease.generation)
    {
        return Err(conflict());
    }
    if prior.is_some() {
        // A terminal execution has already fixed this generation's role too.
        let used: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM application_team_members m JOIN execution_attempts a ON a.task_id=m.task_id JOIN application_executions x USING(attempt_id) WHERE m.member_id=?1 AND x.plan_id=?2 AND x.generation=?3 AND x.kind='model')",
            params![write.member_id.to_string(), plan.plan_id.to_string(), scope.lease.generation.get() as i64],
            |r|r.get(0),
        ).map_err(sql)?;
        if used {
            return Err(conflict());
        }
    }
    if existing.is_none() {
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM application_team_members WHERE plan_id=?1",
                [plan.plan_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if count >= TeamDiscussionLimits::current_plan().max_members as i64 {
            return Err(fail(ErrorCode::LimitExceeded, "team-members"));
        }
        c.execute(
            "INSERT INTO application_team_members(member_id,plan_id) VALUES(?1,?2)",
            params![write.member_id.to_string(), plan.plan_id.to_string()],
        )
        .map_err(sql)?;
    }
    let role = TeamMemberRole {
        plan_id: plan.plan_id,
        version: Revision::new(ordinal)?,
        generation: scope.lease.generation,
        request: write.clone(),
        config: crate::ai::settings(&FixedInput::capture(plan.execution_input()?.clone())?)?.config,
    };
    let bytes = codec::encode(&role, MAX_RECORD_BYTES)?;
    c.execute(
        "INSERT INTO application_team_roles VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            write.role_version_id.to_string(),
            write.member_id.to_string(),
            ordinal as i64,
            write.expected_role_version_id.map(|id| id.to_string()),
            bytes,
            codec::digest(&bytes)
        ],
    )
    .map_err(sql)?;
    Ok(role)
}

pub(super) fn author_history(
    c: &Connection,
    author: &TeamMemberAuthor,
) -> Result<(WorkPlan, TeamMemberRole, TeamDiscussionTarget), ExecutionError> {
    let input = super::super::ledger::load_input(c, author.attempt_id)?;
    if input.envelope().operation == crate::ai::team::OPERATION {
        return super::coordination::author_history(c, author, &input);
    }
    agents::validate_model_input(c, &input)?;
    if agents::binding(&input)?.as_ref() != Some(&author.binding) {
        return Err(corrupt());
    }
    let plan = control::load(c, author.binding.lease.plan_id)?.plan;
    policy(&plan)?;
    let role = load_role(c, author.role_version_id)?;
    let member: (String, Option<String>) = c
        .query_row(
            "SELECT plan_id,task_id FROM application_team_members WHERE member_id=?1",
            [author.member_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    let token: Option<String> = c
        .query_row(
            "SELECT dispatch_token FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
            params![author.attempt_id.to_string(), author.item_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let target = target(&input, author.item_id)?;
    let scope = agents::scope_from_binding(input.envelope().project_id, &author.binding);
    check_target(&plan, &scope, &target)?;
    if role.request.member_id != author.member_id
        || role.plan_id != plan.plan_id
        || role.generation > author.binding.lease.generation
        || member.0 != plan.plan_id.to_string()
        || member.1.as_deref() != Some(input.envelope().task_id.to_string().as_str())
        || token.as_deref() != Some(author.dispatch_token.to_string().as_str())
        || role.config != crate::ai::settings(&input)?.config
        || role_at_generation(c, author.member_id, author.binding.lease.generation)?
            .as_ref()
            .map(|role| role.request.role_version_id)
            != Some(author.role_version_id)
    {
        return Err(corrupt());
    }
    Ok((plan, role, target))
}
pub(super) fn author_live(
    c: &Connection,
    scope: &WorkPlanAgentScope,
    author: &TeamMemberAuthor,
) -> Result<(), ExecutionError> {
    live_plan(c, scope)?;
    if author.binding != scope.execution_binding() {
        return Err(denied());
    }
    author_history(c, author)?;
    if latest_role(c, author.member_id)?
        .as_ref()
        .map(|role| role.request.role_version_id)
        != Some(author.role_version_id)
    {
        return Err(conflict());
    }
    let execution: String = c
        .query_row(
            "SELECT execution FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
            params![author.attempt_id.to_string(), author.item_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if execution != "dispatched" {
        return Err(fail(ErrorCode::Cancelled, "team-dispatch"));
    }
    let input = super::super::ledger::load_input(c, author.attempt_id)?;
    control::check_input(c, &input)?;
    let captured: i64 = c
        .query_row(
            "SELECT cancellation_revision FROM execution_attempts WHERE attempt_id=?1",
            [author.attempt_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if super::super::ledger::cancel_revision(c, input.envelope().task_id)?.get() > captured as u64 {
        return Err(fail(ErrorCode::Cancelled, "team-dispatch"));
    }
    Ok(())
}

fn capture_author(
    c: &Connection,
    scope: &WorkPlanAgentScope,
    member: ExecutionId,
    version: ExecutionId,
    attempt: ExecutionId,
    item: ExecutionId,
) -> Result<CapturedTeamAuthor, ExecutionError> {
    let plan = live_plan(c, scope)?;
    let input = super::super::ledger::load_input(c, attempt)?;
    let binding = if input.envelope().operation == crate::ai::team::OPERATION {
        Some(crate::ai::team::settings(&input)?.binding.scope().clone())
    } else {
        agents::binding(&input)?
    };
    if binding.as_ref() != Some(&scope.execution_binding()) {
        return Err(denied());
    }
    let assigned: (String, Option<String>) = c
        .query_row(
            "SELECT plan_id,task_id FROM application_team_members WHERE member_id=?1",
            [member.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    if assigned.0 != plan.plan_id.to_string()
        || assigned
            .1
            .as_deref()
            .is_some_and(|task| task != input.envelope().task_id.to_string())
    {
        return Err(denied());
    }
    if assigned.1.is_none() && input.envelope().operation != crate::ai::team::OPERATION {
        c.execute(
            "UPDATE application_team_members SET task_id=?2 WHERE member_id=?1 AND task_id IS NULL",
            params![member.to_string(), input.envelope().task_id.to_string()],
        )
        .map_err(sql)?;
    }
    let token: String = c
        .query_row(
            "SELECT dispatch_token FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
            params![attempt.to_string(), item.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let author = TeamMemberAuthor {
        member_id: member,
        role_version_id: version,
        attempt_id: attempt,
        item_id: item,
        dispatch_token: ExecutionId::parse(&token)?,
        binding: scope.execution_binding(),
    };
    author_live(c, scope, &author)?;
    let (_, role, target) = author_history(c, &author)?;
    Ok(CapturedTeamAuthor {
        scope: scope.clone(),
        author,
        role,
        target,
    })
}

fn translation_reference(
    c: &Connection,
    plan: &WorkPlan,
    target: &TeamDiscussionTarget,
    revision_id: ExecutionId,
) -> Result<crate::TranslationRevision, ExecutionError> {
    let revision = super::super::translation::revision_in(c, plan.project_id, revision_id)?;
    if revision.unit_id != target.unit_id
        || revision.locale != target.locale
        || revision.source_snapshot_id != target.source_snapshot_id
        || revision.source_revision_id != target.source_revision_id
    {
        return Err(denied());
    }
    Ok(revision)
}

pub(super) fn check_references(
    c: &Connection,
    plan: &WorkPlan,
    target: &TeamDiscussionTarget,
    references: &[TeamArtifactReference],
) -> Result<(), ExecutionError> {
    if references.len() > MAX_TEAM_REFERENCES {
        return Err(fail(ErrorCode::LimitExceeded, "team-references"));
    }
    let mut unique = std::collections::BTreeSet::new();
    for reference in references {
        if !unique.insert(codec::encode(reference, MAX_RECORD_BYTES)?) {
            return Err(fail(ErrorCode::InvalidInput, "team-reference"));
        }
        match reference {
            TeamArtifactReference::TranslationRevision { revision_id } => {
                translation_reference(c, plan, target, *revision_id)?;
            }
            TeamArtifactReference::SourceResult {
                snapshot_id,
                attempt_id,
                result_id,
            } => {
                if *snapshot_id != target.source_snapshot_id {
                    return Err(denied());
                }
                super::super::content::check_result_reference(
                    c,
                    plan.project_id,
                    *snapshot_id,
                    *attempt_id,
                    *result_id,
                    target.unit_id,
                    target.source_revision_id,
                )?;
            }
        }
    }
    Ok(())
}
pub(super) fn post(
    c: &Connection,
    id: ExecutionId,
) -> Result<Option<TeamDiscussionPost>, ExecutionError> {
    let row:Option<(String,i64,Option<String>,Option<String>,Vec<u8>,String)>=c.query_row("SELECT plan_id,sequence,reply_to,supersedes,record,digest FROM application_team_posts WHERE post_id=?1",[id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(sql)?;
    row.map(|row| {
        let value: TeamDiscussionPost = codec::decode(&row.4, MAX_RECORD_BYTES)?;
        if value.publication.post_id != id
            || value.plan_id.to_string() != row.0
            || value.sequence.get() as i64 != row.1
            || value.publication.reply_to.map(|id| id.to_string()) != row.2
            || value.publication.supersedes.map(|id| id.to_string()) != row.3
            || codec::digest(&row.4) != row.5
        {
            return Err(corrupt());
        }
        Ok(value)
    })
    .transpose()
}
pub(super) fn all_posts(
    c: &Connection,
    plan: ExecutionId,
) -> Result<Vec<TeamDiscussionPost>, ExecutionError> {
    let mut query = c
        .prepare("SELECT post_id FROM application_team_posts WHERE plan_id=?1 ORDER BY sequence")
        .map_err(sql)?;
    let ids = query
        .query_map([plan.to_string()], |r| r.get::<_, String>(0))
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    ids.into_iter()
        .map(|id| post(c, ExecutionId::parse(&id)?)?.ok_or_else(corrupt))
        .collect()
}
fn same_author(left: &TeamDiscussionAuthor, right: &TeamDiscussionAuthor) -> bool {
    match (left, right) {
        (
            TeamDiscussionAuthor::Member { author: a },
            TeamDiscussionAuthor::Member { author: b },
        ) => a.member_id == b.member_id,
        (
            TeamDiscussionAuthor::Human { actor: a, .. },
            TeamDiscussionAuthor::Human { actor: b, .. },
        ) => a == b,
        _ => false,
    }
}
/// Only an explicit resolution at the current chain tip releases its objections.
fn required_posts(posts: &[TeamDiscussionPost]) -> std::collections::BTreeSet<ExecutionId> {
    posts
        .iter()
        .filter(|post| {
            if !matches!(
                post.publication.kind,
                TeamDiscussionKind::Challenge | TeamDiscussionKind::Rejection
            ) {
                return false;
            }
            let mut tip = *post;
            while let Some(next) = posts
                .iter()
                .find(|next| next.publication.supersedes == Some(tip.publication.post_id))
            {
                tip = next;
            }
            tip.publication.kind != TeamDiscussionKind::Resolution
        })
        .map(|post| post.publication.post_id)
        .collect()
}
fn check_content(write: &PublishTeamDiscussion) -> Result<(), ExecutionError> {
    if write.body.trim().is_empty() {
        return Err(fail(ErrorCode::InvalidInput, "team-body"));
    }
    if write.body.len() > TeamDiscussionLimits::current_plan().max_post_bytes as usize {
        return Err(fail(ErrorCode::LimitExceeded, "team-body"));
    }
    if write.reply_to == Some(write.post_id) || write.supersedes == Some(write.post_id) {
        return Err(conflict());
    }
    Ok(())
}
fn publish(
    c: &Connection,
    scope: &WorkPlanAgentScope,
    author: TeamDiscussionAuthor,
    write: &PublishTeamDiscussion,
) -> Result<TeamDiscussionPost, ExecutionError> {
    let plan = live_plan(c, scope)?;
    check_content(write)?;
    check_target(&plan, scope, &write.target)?;
    check_references(c, &plan, &write.target, &write.references)?;
    if let Some(saved) = post(c, write.post_id)? {
        return if saved.plan_id == plan.plan_id
            && saved.author == author
            && saved.publication == *write
        {
            Ok(saved)
        } else {
            Err(fail(ErrorCode::ResultMismatch, "team-post-id"))
        };
    }
    let previous = all_posts(c, plan.plan_id)?;
    if previous.len() >= TeamDiscussionLimits::current_plan().max_posts as usize {
        return Err(fail(ErrorCode::LimitExceeded, "team-posts"));
    }
    for predecessor in [write.reply_to, write.supersedes].into_iter().flatten() {
        let parent = post(c, predecessor)?.ok_or_else(conflict)?;
        if parent.plan_id != plan.plan_id || parent.publication.target != write.target {
            return Err(denied());
        }
        if write.supersedes == Some(predecessor)
            && (!same_author(&author, &parent.author)
                || previous
                    .iter()
                    .any(|p| p.publication.supersedes == Some(predecessor)))
        {
            return Err(conflict());
        }
    }
    let value = TeamDiscussionPost {
        plan_id: plan.plan_id,
        sequence: Revision::new(previous.len() as u64 + 1)?,
        author,
        publication: write.clone(),
    };
    let bytes = codec::encode(&value, MAX_RECORD_BYTES)?;
    c.execute(
        "INSERT INTO application_team_posts VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            write.post_id.to_string(),
            plan.plan_id.to_string(),
            value.sequence.get() as i64,
            write.reply_to.map(|id| id.to_string()),
            write.supersedes.map(|id| id.to_string()),
            bytes,
            codec::digest(&bytes)
        ],
    )
    .map_err(sql)?;
    Ok(value)
}

pub(super) fn artifact_in(
    c: &Connection,
    plan: &WorkPlan,
    target: &TeamDiscussionTarget,
    reference: &TeamArtifactReference,
    native_key: &str,
) -> Result<TeamArtifactBody, ExecutionError> {
    Ok(match reference {
        TeamArtifactReference::TranslationRevision { revision_id } => {
            let revision = translation_reference(c, &plan, &target, *revision_id)?;
            TeamArtifactBody::TranslationRevision {
                revision_id: *revision_id,
                text: revision.text,
            }
        }
        TeamArtifactReference::SourceResult {
            snapshot_id,
            attempt_id,
            result_id,
        } => {
            if *snapshot_id != target.source_snapshot_id {
                return Err(denied());
            }
            let source = super::super::resources::SourceContextReader::historical_in(
                c,
                &crate::SourceContextRequest {
                    project_id: plan.project_id,
                    source_snapshot_id: *snapshot_id,
                    unit_id: target.unit_id,
                    source_revision_id: target.source_revision_id,
                    locale: target.locale.clone(),
                },
            )?;
            let row = source.source_for_result_reference(
                *attempt_id,
                *result_id,
                target.unit_id,
                target.source_revision_id,
            )?;
            if row.occurrence.key != native_key {
                return Err(conflict());
            }
            TeamArtifactBody::SourceResult {
                snapshot_id: *snapshot_id,
                attempt_id: *attempt_id,
                result_id: *result_id,
                occurrence_id: row.occurrence_id.ok_or_else(corrupt)?,
                native_key: row.occurrence.key.clone(),
                text: row.occurrence.text.clone(),
            }
        }
    })
}

impl ProjectStore {
    pub fn register_team_member(
        &mut self,
        scope: &WorkPlanAgentScope,
        write: &TeamMemberRoleWrite,
    ) -> Result<TeamMemberRole, ExecutionError> {
        let tx = self.execution_write()?;
        self.check_work_plan_agent_scope(scope)?;
        let value = register(&tx, scope, write)?;
        super::super::ledger::commit(tx)?;
        Ok(value)
    }
    pub fn capture_team_author(
        &mut self,
        scope: &WorkPlanAgentScope,
        member: ExecutionId,
        version: ExecutionId,
        attempt: ExecutionId,
        item: ExecutionId,
    ) -> Result<CapturedTeamAuthor, ExecutionError> {
        let tx = self.execution_write()?;
        self.check_work_plan_agent_scope(scope)?;
        let value = capture_author(&tx, scope, member, version, attempt, item)?;
        super::super::ledger::commit(tx)?;
        Ok(value)
    }
    /// Reuse an application's member identity by original task, including retries.
    pub fn capture_team_execution_author(
        &mut self,
        scope: &WorkPlanAgentScope,
        request: &DispatchRequest,
    ) -> Result<CapturedTeamAuthor, ExecutionError> {
        request.check_service_dispatch()?;
        let tx = self.execution_write()?;
        self.check_work_plan_agent_scope(scope)?;
        let plan = live_plan(&tx, scope)?;
        let input = super::super::ledger::load_input(&tx, request.input.envelope().attempt_id)?;
        if input.bytes() != request.input.bytes()
            || agents::binding(&input)?.as_ref() != Some(&scope.execution_binding())
        {
            return Err(denied());
        }
        let member: Option<String> = tx
            .query_row(
                "SELECT member_id FROM application_team_members WHERE plan_id=?1 AND task_id=?2",
                params![
                    plan.plan_id.to_string(),
                    input.envelope().task_id.to_string()
                ],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        let (member, version) = if let Some(member) = member {
            let member = ExecutionId::parse(&member)?;
            (
                member,
                latest_role(&tx, member)?
                    .ok_or_else(corrupt)?
                    .request
                    .role_version_id,
            )
        } else {
            let write = TeamMemberRoleWrite {
                member_id: ExecutionId::new(),
                role_version_id: ExecutionId::new(),
                expected_role_version_id: None,
                display_name: "Translation member".into(),
                role: "Translate and discuss only the original authorized work item.".into(),
            };
            let role = register(&tx, scope, &write)?;
            (write.member_id, role.request.role_version_id)
        };
        let value = capture_author(
            &tx,
            scope,
            member,
            version,
            input.envelope().attempt_id,
            request.item_id,
        )?;
        if value.author.dispatch_token != request.dispatch_token {
            return Err(denied());
        }
        super::super::ledger::commit(tx)?;
        Ok(value)
    }
    pub fn publish_team_discussion(
        &mut self,
        author: &CapturedTeamAuthor,
        write: &PublishTeamDiscussion,
    ) -> Result<TeamDiscussionPost, ExecutionError> {
        let tx = self.execution_write()?;
        self.check_work_plan_agent_scope(&author.scope)?;
        author_live(&tx, &author.scope, &author.author)?;
        if write.target != author.target {
            return Err(denied());
        }
        let value = publish(
            &tx,
            &author.scope,
            TeamDiscussionAuthor::Member {
                author: author.author.clone(),
            },
            write,
        )?;
        super::super::ledger::commit(tx)?;
        Ok(value)
    }
    /// Trusted human entry point; model publication arguments cannot select it.
    pub fn publish_human_team_discussion(
        &mut self,
        scope: &WorkPlanAgentScope,
        actor: &str,
        write: &PublishTeamDiscussion,
    ) -> Result<TeamDiscussionPost, ExecutionError> {
        if scope.delegation.is_some() || actor.trim().is_empty() || actor.len() > 128 {
            return Err(denied());
        }
        let tx = self.execution_write()?;
        self.check_work_plan_agent_scope(scope)?;
        let value = publish(
            &tx,
            scope,
            TeamDiscussionAuthor::Human {
                actor: actor.into(),
                binding: scope.execution_binding(),
            },
            write,
        )?;
        super::super::ledger::commit(tx)?;
        Ok(value)
    }
    /// Local human history never provides an Agent scope or a sharing permit.
    pub fn read_team_history(
        &self,
        request: &ReadTeamHistory,
    ) -> Result<TeamHistoryPage, ExecutionError> {
        if !(1..=MAX_HISTORY_POSTS).contains(&request.limit) {
            return Err(fail(ErrorCode::InvalidInput, "team-history-page"));
        }
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            let plan = historical_plan(c, request.project_id, request.plan_id)?;
            let history = history_in(c, &plan)?;
            let after = request.after.map_or(0, |after| after.get());
            let mut visible = history
                .posts
                .into_iter()
                .filter(|post| post.sequence.get() > after);
            let posts = visible
                .by_ref()
                .take(request.limit as usize)
                .collect::<Vec<_>>();
            let next_after = visible
                .next()
                .and_then(|_| posts.last().map(|post| post.sequence));
            let mut author_roles = std::collections::BTreeMap::new();
            for post in &posts {
                if let TeamDiscussionAuthor::Member { author } = &post.author {
                    author_roles.entry(author.role_version_id).or_insert(
                        history
                            .roles
                            .get(&author.role_version_id)
                            .ok_or_else(corrupt)?
                            .clone(),
                    );
                }
            }
            let page = TeamHistoryPage {
                plan_id: plan.plan_id,
                members: history.members,
                author_roles: author_roles.into_values().collect(),
                posts,
                next_after,
            };
            codec::encode(&page, MAX_HISTORY_BYTES)?;
            Ok(page)
        })
    }
    pub fn read_team_history_post(
        &self,
        project: ExecutionId,
        plan: ExecutionId,
        id: ExecutionId,
    ) -> Result<TeamDiscussionPost, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            let plan = historical_plan(c, project, plan)?;
            history_in(c, &plan)?
                .posts
                .into_iter()
                .find(|post| post.publication.post_id == id)
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "team-post"))
        })
    }
    /// Confirm an original human action after a lost acknowledgement without replaying it.
    pub fn read_human_team_publication_action(
        &self,
        project: ExecutionId,
        lease: &AutomationLease,
        actor: &str,
        publication: &PublishTeamDiscussion,
    ) -> Result<Option<TeamDiscussionPost>, ExecutionError> {
        if actor.trim().is_empty() || actor.len() > 128 || lease.generation.get() == 0 {
            return Err(fail(ErrorCode::InvalidInput, "team-human-action"));
        }
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        let found = super::super::review::read_snapshot(c, |c| {
            let plan = historical_plan(c, project, lease.plan_id)?;
            let history = history_in(c, &plan)?;
            let Some(post) = post(c, publication.post_id)? else {
                return Ok(None);
            };
            let matches = match &post.author {
                TeamDiscussionAuthor::Human {
                    actor: saved,
                    binding,
                } => saved == actor && binding.lease == *lease && binding.delegation.is_none(),
                TeamDiscussionAuthor::Member { .. } => false,
            };
            if post.plan_id != plan.plan_id || post.publication != *publication || !matches {
                return Err(fail(ErrorCode::ResultMismatch, "team-human-action"));
            }
            if !history.posts.contains(&post) {
                return Err(corrupt());
            }
            Ok(Some(post))
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
    }
    pub fn read_team_discussion(
        &self,
        scope: &WorkPlanAgentScope,
        id: ExecutionId,
    ) -> Result<TeamDiscussionPost, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            self.check_work_plan_agent_scope(scope)?;
            let plan = live_plan(c, scope)?;
            let value = post(c, id)?.ok_or_else(|| fail(ErrorCode::InvalidInput, "team-post"))?;
            if value.plan_id != plan.plan_id {
                return Err(denied());
            }
            check_target(&plan, scope, &value.publication.target)?;
            check_references(
                c,
                &plan,
                &value.publication.target,
                &value.publication.references,
            )?;
            Ok(value)
        })
    }
    /// Read one cited body under the current member's explicitly shared profile.
    pub fn read_team_artifact(
        &self,
        author: &CapturedTeamAuthor,
        request: &ReadTeamArtifact,
    ) -> Result<TeamArtifactRead, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            self.check_work_plan_agent_scope(&author.scope)?;
            author_live(c, &author.scope, &author.author)?;
            let plan = live_plan(c, &author.scope)?;
            let policy = policy(&plan)?;
            if !matches!(policy, TeamDiscussionPolicy::CurrentPlanV2 {}) {
                return Err(denied());
            }
            let published = post(c, request.post_id)?
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "team-post"))?;
            if published.plan_id != plan.plan_id || published.publication.target != author.target {
                return Err(denied());
            }
            check_target(&plan, &author.scope, &published.publication.target)?;
            let reference = published
                .publication
                .references
                .get(request.reference_index as usize)
                .ok_or_else(|| fail(ErrorCode::InvalidInput, "team-reference-index"))?;
            let input = super::super::ledger::load_input(c, author.author.attempt_id)?;
            let item = crate::ai::item_payload(&input, author.author.item_id)?;
            let artifact = artifact_in(c, &plan, &author.target, reference, &item.native_key)?;
            let read = TeamArtifactRead {
                kind: TeamArtifactReadKind::UntrustedTeamArtifact,
                post_id: request.post_id,
                reference_index: request.reference_index,
                target: author.target.clone(),
                artifact,
            };
            codec::encode(
                &read,
                TeamDiscussionLimits::for_policy(policy).max_artifact_bytes as usize,
            )?;
            Ok(read)
        })
    }
    pub fn capture_team_discussion_view(
        &self,
        author: &CapturedTeamAuthor,
    ) -> Result<CapturedTeamDiscussionView, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            self.check_work_plan_agent_scope(&author.scope)?;
            author_live(c, &author.scope, &author.author)?;
            let plan = live_plan(c, &author.scope)?;
            let posts = all_posts(c, plan.plan_id)?;
            let through_sequence = Revision::new(posts.last().map_or(0, |p| p.sequence.get()))?;
            let visible: Vec<_> = posts
                .into_iter()
                .filter(|p| p.publication.target == author.target)
                .collect();
            let required = required_posts(&visible);
            let limits = TeamDiscussionLimits::current_plan();
            let mut view = TeamDiscussionView {
                kind: TeamDiscussionViewKind::UntrustedTeamDiscussions,
                view_id: ExecutionId::new(),
                plan_id: plan.plan_id,
                policy: policy(&plan)?,
                author: author.author.clone(),
                role: author.role.clone(),
                target: author.target.clone(),
                through_sequence,
                posts: Vec::new(),
                folded: Vec::new(),
                omitted: 0,
            };
            for p in &visible {
                if required.contains(&p.publication.post_id) {
                    view.posts.push(p.clone());
                } else {
                    view.folded.push(TeamDiscussionPostReference {
                        post_id: p.publication.post_id,
                        sequence: p.sequence,
                    });
                }
            }
            if view.posts.len() > limits.max_view_posts as usize
                || codec::encode(&view, limits.max_view_bytes as usize).is_err()
            {
                return Err(fail(ErrorCode::LimitExceeded, "team-view-material"));
            }
            for p in visible
                .iter()
                .rev()
                .filter(|p| !required.contains(&p.publication.post_id))
            {
                if view.posts.len() == limits.max_view_posts as usize {
                    break;
                }
                let mut candidate = view.clone();
                candidate
                    .folded
                    .retain(|r| r.post_id != p.publication.post_id);
                candidate.posts.push(p.clone());
                candidate.posts.sort_by_key(|p| p.sequence);
                if codec::encode(&candidate, limits.max_view_bytes as usize).is_ok() {
                    view = candidate;
                }
            }
            validate_view(c, &view)?;
            let utf8 = String::from_utf8(codec::encode(&view, limits.max_view_bytes as usize)?)
                .map_err(|_| corrupt())?;
            Ok(CapturedTeamDiscussionView {
                scope: author.scope.clone(),
                view,
                utf8,
            })
        })
    }
    pub fn validate_team_discussion_view_current(
        &self,
        captured: &CapturedTeamDiscussionView,
    ) -> Result<(), ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| {
            self.check_work_plan_agent_scope(&captured.scope)?;
            author_live(c, &captured.scope, &captured.view.author)?;
            validate_view(c, &captured.view)?;
            if codec::encode(
                &captured.view,
                TeamDiscussionLimits::current_plan().max_view_bytes as usize,
            )? != captured.utf8.as_bytes()
            {
                return Err(corrupt());
            }
            Ok(())
        })
    }
}

fn validate_view(c: &Connection, view: &TeamDiscussionView) -> Result<(), ExecutionError> {
    let (plan, role, target) = author_history(c, &view.author)?;
    if view.plan_id != plan.plan_id
        || view.policy != policy(&plan)?
        || view.role != role
        || view.target != target
        || view.omitted != 0
    {
        return Err(corrupt());
    }
    let limits = TeamDiscussionLimits::current_plan();
    if view.posts.len() > limits.max_view_posts as usize
        || view.through_sequence.get() > limits.max_posts as u64
    {
        return Err(corrupt());
    }
    codec::encode(view, limits.max_view_bytes as usize)?;
    if !view.posts.windows(2).all(|w| w[0].sequence < w[1].sequence)
        || !view
            .folded
            .windows(2)
            .all(|w| w[0].sequence < w[1].sequence)
    {
        return Err(corrupt());
    }
    let known = all_posts(c, plan.plan_id)?;
    if view.through_sequence.get() > known.last().map_or(0, |p| p.sequence.get()) {
        return Err(corrupt());
    }
    let visible: Vec<_> = known
        .iter()
        .filter(|p| p.sequence <= view.through_sequence && p.publication.target == view.target)
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    let required = required_posts(&visible.iter().map(|p| (*p).clone()).collect::<Vec<_>>());
    for p in &view.posts {
        if !seen.insert(p.publication.post_id) || !visible.contains(&p) {
            return Err(corrupt());
        }
        check_references(c, &plan, &p.publication.target, &p.publication.references)?;
    }
    for r in &view.folded {
        let p = visible
            .iter()
            .find(|p| p.publication.post_id == r.post_id && p.sequence == r.sequence)
            .ok_or_else(corrupt)?;
        if !seen.insert(r.post_id) || required.contains(&r.post_id) {
            return Err(corrupt());
        }
        check_references(c, &plan, &p.publication.target, &p.publication.references)?;
    }
    if seen.len() != visible.len() {
        return Err(corrupt());
    }
    Ok(())
}

pub(crate) fn validate_team_provider_view_history_in(
    c: &Connection,
    input: &FixedInput,
    item_id: ExecutionId,
    view: Option<&TeamDiscussionView>,
) -> Result<(), ExecutionError> {
    if input.envelope().operation == crate::ai::team::OPERATION && view.is_none() {
        return Ok(());
    }
    if input.envelope().operation != crate::ai::OPERATION
        && input.envelope().operation != crate::ai::team::OPERATION
    {
        return if view.is_none() {
            Ok(())
        } else {
            Err(corrupt())
        };
    }
    let binding = if input.envelope().operation == crate::ai::team::OPERATION {
        Some(crate::ai::team::settings(input)?.binding.scope().clone())
    } else {
        agents::binding(input)?
    };
    let Some(binding) = binding else {
        return if view.is_none() {
            Ok(())
        } else {
            Err(corrupt())
        };
    };
    let plan = control::load(c, binding.lease.plan_id)?.plan;
    match (plan.options.team_discussions, view) {
        (None, None) => Ok(()),
        (Some(_), Some(view)) => {
            if view.author.binding != binding
                || view.author.attempt_id != input.envelope().attempt_id
                || view.author.item_id != item_id
            {
                return Err(corrupt());
            }
            validate_view(c, view)
        }
        _ => Err(denied()),
    }
}
pub(crate) fn validate_team_provider_view_in(
    c: &Connection,
    request: &DispatchRequest,
    view: Option<&TeamDiscussionView>,
) -> Result<(), ExecutionError> {
    validate_team_provider_view_history_in(c, &request.input, request.item_id, view)?;
    if let Some(view) = view {
        if view.author.dispatch_token != request.dispatch_token {
            return Err(denied());
        }
        let scope =
            agents::scope_from_binding(request.input.envelope().project_id, &view.author.binding);
        author_live(c, &scope, &view.author)?;
    }
    Ok(())
}

struct TeamHistory {
    members: Vec<TeamMemberRole>,
    roles: std::collections::BTreeMap<ExecutionId, TeamMemberRole>,
    posts: Vec<TeamDiscussionPost>,
}

fn historical_plan(
    c: &Connection,
    project: ExecutionId,
    plan: ExecutionId,
) -> Result<WorkPlan, ExecutionError> {
    let metadata = super::super::read_metadata_from(c).map_err(|_| corrupt())?;
    if metadata.project_id().to_string() != project.to_string() {
        return Err(denied());
    }
    let stored = control::load(c, plan)?;
    if stored.plan.project_id != project {
        return Err(denied());
    }
    Ok(stored.plan)
}

/// Reopening and trusted history reads use the same bounded historical checks.
fn history_in(c: &Connection, plan: &WorkPlan) -> Result<TeamHistory, ExecutionError> {
    let mut query=c.prepare("SELECT member_id,task_id FROM application_team_members WHERE plan_id=?1 ORDER BY member_id LIMIT 9").map_err(sql)?;
    let members = query
        .query_map([plan.plan_id.to_string()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    let posts = all_posts(c, plan.plan_id)?;
    let limits = TeamDiscussionLimits::current_plan();
    if members.len() > limits.max_members as usize || posts.len() > limits.max_posts as usize {
        return Err(corrupt());
    }
    if plan.options.team_discussions.is_none() && (!members.is_empty() || !posts.is_empty()) {
        return Err(corrupt());
    }
    let generation = control::load(c, plan.plan_id)?.lease.generation;
    let mut latest = Vec::new();
    let mut roles = std::collections::BTreeMap::new();
    for (member, task) in members {
        let member = ExecutionId::parse(&member)?;
        if let Some(task) = task {
            let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM application_executions x JOIN execution_attempts a USING(attempt_id) WHERE a.task_id=?1 AND x.plan_id=?2 AND x.kind='model')",params![task,plan.plan_id.to_string()],|r|r.get(0)).map_err(sql)?;
            if !valid {
                return Err(corrupt());
            }
        }
        let mut query = c
            .prepare(
                "SELECT version_id FROM application_team_roles WHERE member_id=?1 ORDER BY ordinal",
            )
            .map_err(sql)?;
        let ids = query
            .query_map([member.to_string()], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql)?;
        if ids.is_empty() || ids.len() > limits.max_role_versions_per_member as usize {
            return Err(corrupt());
        }
        let mut previous: Option<TeamMemberRole> = None;
        for (i, id) in ids.into_iter().enumerate() {
            let role = load_role(c, ExecutionId::parse(&id)?)?;
            let config = if plan.options.team_execution.is_some() {
                let at = super::recovery::plan_in(c, plan.plan_id, role.generation)?;
                at.options
                    .team_execution
                    .as_ref()
                    .and_then(|p| p.members().iter().find(|m| m.member_id == member))
                    .ok_or_else(corrupt)?
                    .config
                    .clone()
            } else {
                crate::ai::settings(&plan.fixed_input()?)?.config
            };

            if role.plan_id != plan.plan_id
                || role.request.member_id != member
                || role.version.get() != i as u64 + 1
                || role.generation.get() == 0
                || role.generation > generation
                || role.request.expected_role_version_id
                    != previous.as_ref().map(|p| p.request.role_version_id)
                || previous
                    .as_ref()
                    .is_some_and(|p| p.generation >= role.generation)
                || role.config != config
            {
                return Err(corrupt());
            }
            roles.insert(role.request.role_version_id, role.clone());
            previous = Some(role);
        }
        latest.push(previous.ok_or_else(corrupt)?);
    }
    for (i, p) in posts.iter().enumerate() {
        if p.sequence.get() != i as u64 + 1 {
            return Err(corrupt());
        }
        check_content(&p.publication)?;
        let binding = match &p.author {
            TeamDiscussionAuthor::Member { author } => {
                let (_, role, target) = author_history(c, author)?;
                if target != p.publication.target
                    || roles.get(&author.role_version_id) != Some(&role)
                {
                    return Err(corrupt());
                }
                &author.binding
            }
            TeamDiscussionAuthor::Human { actor, binding } => {
                if actor.trim().is_empty() || actor.len() > 128 || binding.delegation.is_some() {
                    return Err(corrupt());
                }
                let registered: bool = c
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM execution_budgets WHERE task_id=?1)",
                        [binding.root_task.to_string()],
                        |r| r.get(0),
                    )
                    .map_err(sql)?;
                if !registered {
                    return Err(corrupt());
                }
                binding
            }
        };
        if binding.lease.plan_id != plan.plan_id
            || binding.lease.generation.get() == 0
            || binding.lease.generation > generation
        {
            return Err(corrupt());
        }
        let scope = agents::scope_from_binding(plan.project_id, binding);
        agents::validate_scope_basis(plan, &scope)?;
        check_target(plan, &scope, &p.publication.target)?;
        check_references(c, plan, &p.publication.target, &p.publication.references)?;
        for id in [p.publication.reply_to, p.publication.supersedes]
            .into_iter()
            .flatten()
        {
            let predecessor = posts
                .iter()
                .find(|prior| prior.publication.post_id == id && prior.sequence < p.sequence)
                .ok_or_else(corrupt)?;
            if predecessor.publication.target != p.publication.target
                || p.publication.supersedes == Some(id)
                    && !same_author(&p.author, &predecessor.author)
            {
                return Err(corrupt());
            }
        }
    }
    Ok(TeamHistory {
        members: latest,
        roles,
        posts,
    })
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    for (name, expected) in TABLES {
        let actual: String = c
            .query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .map_err(sql)?;
        if actual != *expected {
            return Err(corrupt());
        }
    }
    let orphan:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM application_team_roles r LEFT JOIN application_team_members m USING(member_id) WHERE m.member_id IS NULL) OR EXISTS(SELECT 1 FROM application_team_members m WHERE m.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM application_executions x JOIN execution_attempts a USING(attempt_id) WHERE a.task_id=m.task_id AND x.plan_id=m.plan_id AND x.kind='model'))",[],|r|r.get(0)).map_err(sql)?;
    if orphan {
        return Err(corrupt());
    }
    let mut query=c.prepare("SELECT plan_id FROM application_team_members UNION SELECT plan_id FROM application_team_posts ORDER BY plan_id").map_err(sql)?;
    for plan in query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql)?
    {
        let plan = control::load(c, ExecutionId::parse(&plan.map_err(sql)?)?)?.plan;
        history_in(c, &plan)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::application::tests::{config, consent, fixture};

    fn setup() -> (
        tempfile::TempDir,
        ProjectStore,
        WorkPlan,
        WorkPlanAgentScope,
        Vec<ExecutionId>,
    ) {
        setup_for(TeamDiscussionPolicy::CurrentPlanV1 {})
    }
    fn setup_for(
        policy: TeamDiscussionPolicy,
    ) -> (
        tempfile::TempDir,
        ProjectStore,
        WorkPlan,
        WorkPlanAgentScope,
        Vec<ExecutionId>,
    ) {
        let (temp, mut store, units) = fixture();
        let mut options = PlanOptions::default();
        options.team_discussions = Some(policy);
        let plan = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, options)
            .unwrap();
        let mut permission = consent(&plan);
        permission.effects = plan.authorization_effects().unwrap();
        let grant = store.authorize_work_plan(&plan, &permission).unwrap();
        store
            .enqueue_execution(&FixedInput::capture(grant.input.unwrap()).unwrap())
            .unwrap();
        let scope = store.work_plan_agent_scope(grant.lease).unwrap();
        (temp, store, plan, scope, units)
    }
    fn dispatch(
        store: &mut ProjectStore,
        scope: &WorkPlanAgentScope,
        units: Vec<ExecutionId>,
    ) -> DispatchRequest {
        let prepared = store
            .prepare_work_plan_agent_generation(
                scope,
                &AgentGenerationRequest {
                    task_id: ExecutionId::new(),
                    attempt_id: ExecutionId::new(),
                    unit_ids: units,
                },
            )
            .unwrap();
        store
            .enqueue_work_plan_agent_generation(&prepared, RecoveryPolicy::ExternalUnknown)
            .unwrap();
        store
            .dispatch_execution_item(
                prepared.envelope().attempt_id,
                prepared.envelope().items[0].item_id,
            )
            .unwrap()
    }
    fn publication(author: &CapturedTeamAuthor, body: &str) -> PublishTeamDiscussion {
        PublishTeamDiscussion {
            post_id: ExecutionId::new(),
            target: author.target().clone(),
            kind: TeamDiscussionKind::Note,
            body: body.into(),
            references: vec![],
            reply_to: None,
            supersedes: None,
        }
    }
    fn control(plan: &WorkPlan, generation: u64, command: WorkPlanCommand) -> ControlWorkPlan {
        let continuing = command == WorkPlanCommand::Continue;
        ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: plan.plan_id,
            expected_generation: Revision::new(generation).unwrap(),
            command,
            confirmed: continuing,
            expires_at: continuing.then(|| consent(plan).expires_at),
        }
    }

    fn save_text(
        store: &mut ProjectStore,
        plan: &WorkPlan,
        target: &TeamDiscussionTarget,
        text: &str,
    ) -> crate::TranslationSelection {
        let current = store
            .translation_history(plan.project_id, target.unit_id, &target.locale, 0, 1)
            .unwrap()
            .current;
        store
            .save_translation_revision(&crate::SaveTranslationRevision {
                project_id: plan.project_id,
                action_id: ExecutionId::new(),
                unit_id: target.unit_id,
                locale: target.locale.clone(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: current.map(|selection| selection.event_id),
                text: text.into(),
            })
            .unwrap()
    }

    #[test]
    fn team_human_history_keeps_exact_author_roles_pages_and_read_only_action_identity() {
        let (_temp, mut store, plan, scope, units) = setup();
        let first_request = dispatch(&mut store, &scope, vec![units[0]]);
        let first = store
            .capture_team_execution_author(&scope, &first_request)
            .unwrap();
        let second_request = dispatch(&mut store, &scope, vec![units[0]]);
        let second = store
            .capture_team_execution_author(&scope, &second_request)
            .unwrap();
        let mut question = publication(
            &first,
            &"Retain this complete original reason 👩🏽‍💻. ".repeat(100),
        );
        question.kind = TeamDiscussionKind::Challenge;
        let question = store.publish_team_discussion(&first, &question).unwrap();
        let mut answer = publication(
            &second,
            "A second member explicitly replies to the original reason.",
        );
        answer.reply_to = Some(question.publication.post_id);
        let answer = store.publish_team_discussion(&second, &answer).unwrap();
        let mut human = publication(
            &first,
            "A local human explanation is still only a published suggestion.",
        );
        human.reply_to = Some(answer.publication.post_id);
        let selection = store
            .translation_history(
                plan.project_id,
                first.target.unit_id,
                &first.target.locale,
                0,
                1,
            )
            .unwrap()
            .current;
        let protection = store
            .work_protection(first.target.unit_id, &first.target.locale)
            .unwrap();
        let review = serde_json::to_value(
            store
                .review_target(plan.project_id, first.target.unit_id, &first.target.locale)
                .unwrap(),
        )
        .unwrap();
        let budget = store.provider_budget(scope.parent_task()).unwrap();
        let sequence = store.execution_sequence().unwrap();
        let published = store
            .publish_human_team_discussion(&scope, "local-user", &human)
            .unwrap();
        assert_eq!(
            store
                .publish_human_team_discussion(&scope, "local-user", &human)
                .unwrap(),
            published
        );
        let view = store.capture_team_discussion_view(&first).unwrap();
        assert!(view.view().posts.contains(&published));
        assert!(required_posts(&view.view().posts).contains(&question.publication.post_id));
        assert_eq!(
            store
                .translation_history(
                    plan.project_id,
                    first.target.unit_id,
                    &first.target.locale,
                    0,
                    1
                )
                .unwrap()
                .current,
            selection
        );
        assert_eq!(
            store
                .work_protection(first.target.unit_id, &first.target.locale)
                .unwrap(),
            protection
        );
        assert_eq!(
            serde_json::to_value(
                store
                    .review_target(plan.project_id, first.target.unit_id, &first.target.locale)
                    .unwrap()
            )
            .unwrap(),
            review
        );
        assert_eq!(store.provider_budget(scope.parent_task()).unwrap(), budget);
        assert_eq!(store.execution_sequence().unwrap(), sequence);
        let child = store
            .delegate_work_plan_agent_scope(
                &scope,
                &AgentDelegationRequest {
                    delegation_id: ExecutionId::new(),
                    unit_ids: vec![first.target.unit_id],
                    tool_handles: vec![],
                },
            )
            .unwrap();
        assert_eq!(
            store
                .publish_human_team_discussion(
                    &child,
                    "local-user",
                    &publication(&first, "A delegated member cannot use the human writer.")
                )
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        let mut outside = publication(&first, "Wrong target basis");
        outside.target.unit_id = units[1];
        assert_eq!(
            store
                .publish_human_team_discussion(&scope, "local-user", &outside)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        let paused = store
            .control_work_plan(&control(
                &plan,
                scope.lease.generation.get(),
                WorkPlanCommand::Pause,
            ))
            .unwrap();
        let resumed = store
            .control_work_plan(&control(
                &plan,
                paused.lease.generation.get(),
                WorkPlanCommand::Continue,
            ))
            .unwrap();
        let fresh = store.work_plan_agent_scope(resumed.lease).unwrap();
        let new_role = store
            .register_team_member(
                &fresh,
                &TeamMemberRoleWrite {
                    member_id: first.author.member_id,
                    role_version_id: ExecutionId::new(),
                    expected_role_version_id: Some(first.author.role_version_id),
                    display_name: "Updated role".into(),
                    role: "A later role must not relabel an earlier publication.".into(),
                },
            )
            .unwrap();
        let ordinary = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        store
            .authorize_work_plan(&ordinary, &consent(&ordinary))
            .unwrap();
        let before = std::fs::read(
            store
                .directory()
                .join(super::super::super::DATABASE_FILENAME),
        )
        .unwrap();
        let read = ReadTeamHistory {
            project_id: plan.project_id,
            plan_id: plan.plan_id,
            after: None,
            limit: 1,
        };
        let page = store.read_team_history(&read).unwrap();
        assert_eq!(page.posts, vec![question.clone()]);
        assert_eq!(page.next_after, Some(question.sequence));
        assert_eq!(page.members.len(), 2);
        assert!(page.members.contains(&new_role));
        assert_eq!(page.author_roles, vec![first.role.clone()]);
        let second_page = store
            .read_team_history(&ReadTeamHistory {
                after: page.next_after,
                ..read.clone()
            })
            .unwrap();
        assert_eq!(second_page.posts, vec![answer.clone()]);
        assert_eq!(second_page.author_roles, vec![second.role.clone()]);
        let last = store
            .read_team_history(&ReadTeamHistory {
                after: second_page.next_after,
                ..read.clone()
            })
            .unwrap();
        assert_eq!(last.posts, vec![published.clone()]);
        assert!(last.author_roles.is_empty());
        assert_eq!(last.next_after, None);
        assert_eq!(
            store
                .read_team_history_post(plan.project_id, plan.plan_id, question.publication.post_id)
                .unwrap(),
            question
        );
        assert_eq!(
            store
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "local-user",
                    &human
                )
                .unwrap(),
            Some(published)
        );
        let mut changed = human.clone();
        changed.body.push('!');
        assert_eq!(
            store
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "local-user",
                    &changed
                )
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        assert_eq!(
            store
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "other-user",
                    &human
                )
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        assert_eq!(
            store
                .read_human_team_publication_action(
                    plan.project_id,
                    &fresh.lease,
                    "local-user",
                    &human
                )
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        assert_eq!(
            store
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "local-user",
                    &question.publication
                )
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        let empty = store
            .read_team_history(&ReadTeamHistory {
                plan_id: ordinary.plan_id,
                ..read.clone()
            })
            .unwrap();
        assert!(
            empty.members.is_empty() && empty.posts.is_empty() && empty.author_roles.is_empty()
        );
        assert!(
            store
                .read_team_history(&ReadTeamHistory {
                    project_id: ExecutionId::new(),
                    ..read.clone()
                })
                .is_err()
        );
        assert!(
            store
                .read_team_history_post(plan.project_id, ordinary.plan_id, human.post_id)
                .is_err()
        );
        let wrong = AutomationLease {
            plan_id: ordinary.plan_id,
            generation: scope.lease.generation,
        };
        assert_eq!(
            store
                .read_human_team_publication_action(plan.project_id, &wrong, "local-user", &human)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        for limit in [0, 17] {
            assert!(
                store
                    .read_team_history(&ReadTeamHistory {
                        limit,
                        ..read.clone()
                    })
                    .is_err()
            );
        }
        let json = codec::encode(&page, MAX_HISTORY_BYTES).unwrap();
        assert_eq!(
            codec::decode::<TeamHistoryPage>(&json, MAX_HISTORY_BYTES).unwrap(),
            page
        );
        assert_eq!(
            std::fs::read(
                store
                    .directory()
                    .join(super::super::super::DATABASE_FILENAME)
            )
            .unwrap(),
            before
        );
        assert_eq!(store.provider_budget(scope.parent_task()).unwrap(), budget);
    }

    #[test]
    fn team_human_action_confirmation_survives_source_replacement_pause_and_reopen_without_grants()
    {
        let (_temp, mut store, plan, scope, units) =
            setup_for(TeamDiscussionPolicy::CurrentPlanV2 {});
        let request = dispatch(&mut store, &scope, vec![units[0]]);
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        let source = store
            .source_content(author.target.source_snapshot_id, 0, 100)
            .unwrap();
        let mut prior = publication(
            &author,
            "The original adopted source is the evidence for this discussion.",
        );
        prior.references = vec![TeamArtifactReference::SourceResult {
            snapshot_id: author.target.source_snapshot_id,
            attempt_id: source.attempt_id,
            result_id: source.result_id,
        }];
        store.publish_team_discussion(&author, &prior).unwrap();
        let mut human = publication(
            &author,
            "Keep this exact original publication when its acknowledgement is lost.",
        );
        human.reply_to = Some(prior.post_id);
        human.references = prior.references.clone();
        let expected = store
            .publish_human_team_discussion(&scope, "local-user", &human)
            .unwrap();
        let captured = store.capture_team_discussion_view(&author).unwrap();
        let budget = store.provider_budget(scope.parent_task()).unwrap();
        store
            .control_work_plan(&control(
                &plan,
                scope.lease.generation.get(),
                WorkPlanCommand::Pause,
            ))
            .unwrap();
        crate::persistence::review::tests::adopt_source(
            &mut store,
            br#"{"replacement":"Changed source after the original plan was paused"}"#,
        );
        assert_ne!(
            store.content_scope().unwrap().current_snapshot,
            Some(author.target.source_snapshot_id)
        );
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        let before = std::fs::read(
            store
                .directory()
                .join(super::super::super::DATABASE_FILENAME),
        )
        .unwrap();
        assert_eq!(
            store
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "local-user",
                    &human
                )
                .unwrap(),
            Some(expected.clone())
        );
        assert!(!store.is_reconciling());
        assert_eq!(
            store
                .read_team_history_post(plan.project_id, plan.plan_id, human.post_id)
                .unwrap(),
            expected
        );
        let page = store
            .read_team_history(&ReadTeamHistory {
                project_id: plan.project_id,
                plan_id: plan.plan_id,
                after: None,
                limit: 16,
            })
            .unwrap();
        assert_eq!(page.posts.len(), 2);
        assert_eq!(page.next_after, None);
        assert!(
            store
                .publish_human_team_discussion(&scope, "local-user", &human)
                .is_err()
        );
        assert!(store.read_team_discussion(&scope, human.post_id).is_err());
        assert!(
            store
                .validate_team_discussion_view_current(&captured)
                .is_err()
        );
        assert_eq!(
            std::fs::read(
                store
                    .directory()
                    .join(super::super::super::DATABASE_FILENAME)
            )
            .unwrap(),
            before
        );
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let reopened = ProjectStore::open(&directory).unwrap();
        let before = std::fs::read(directory.join(super::super::super::DATABASE_FILENAME)).unwrap();
        assert!(reopened.check_work_plan_agent_scope(&scope).is_err());
        assert_eq!(
            reopened
                .read_team_history_post(plan.project_id, plan.plan_id, human.post_id)
                .unwrap(),
            expected
        );
        assert_eq!(
            reopened
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "local-user",
                    &human
                )
                .unwrap(),
            Some(expected)
        );
        let mut absent = human.clone();
        absent.post_id = ExecutionId::new();
        assert_eq!(
            reopened
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "local-user",
                    &absent
                )
                .unwrap(),
            None
        );
        let mut conflict = human;
        conflict.target.unit_id = units[1];
        assert_eq!(
            reopened
                .read_human_team_publication_action(
                    plan.project_id,
                    &scope.lease,
                    "local-user",
                    &conflict
                )
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        assert_eq!(
            reopened.provider_budget(scope.parent_task()).unwrap(),
            budget
        );
        assert_eq!(
            reopened.work_plan_status(plan.plan_id).unwrap().state,
            WorkPlanState::Paused
        );
        assert_eq!(
            std::fs::read(directory.join(super::super::super::DATABASE_FILENAME)).unwrap(),
            before
        );
    }

    #[test]
    fn team_artifact_reads_keep_exact_versions_canonical_source_and_current_item_without_writes() {
        let (_temp, mut store, plan, scope, units) =
            setup_for(TeamDiscussionPolicy::CurrentPlanV2 {});
        let request = dispatch(&mut store, &scope, units.clone());
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        let item = crate::ai::item_payload(&request.input, request.item_id).unwrap();
        let old_text = "Original NFD e\u{301} and emoji 👩🏽‍💻";
        let old = save_text(&mut store, &plan, author.target(), old_text);
        let source = store
            .source_content(author.target.source_snapshot_id, 0, 100)
            .unwrap();
        assert!(
            source
                .rows
                .iter()
                .any(|row| row.unit_id != Some(author.target.unit_id))
        );
        let mut write = publication(
            &author,
            "These two precise immutable versions support the discussion.",
        );
        write.references = vec![
            TeamArtifactReference::TranslationRevision {
                revision_id: old.revision_id,
            },
            TeamArtifactReference::SourceResult {
                snapshot_id: author.target.source_snapshot_id,
                attempt_id: source.attempt_id,
                result_id: source.result_id,
            },
        ];
        store.publish_team_discussion(&author, &write).unwrap();
        let newest = save_text(
            &mut store,
            &plan,
            author.target(),
            "New human selection must remain selected.",
        );
        assert_ne!(newest.revision_id, old.revision_id);
        let other_item = request
            .input
            .envelope()
            .items
            .iter()
            .find(|i| i.item_id != request.item_id)
            .unwrap()
            .item_id;
        let other_request = store
            .dispatch_execution_item(request.input.envelope().attempt_id, other_item)
            .unwrap();
        let other = store
            .capture_team_execution_author(&scope, &other_request)
            .unwrap();
        let mut other_post =
            publication(&other, "A separate work item has separate cited material.");
        other_post.references = vec![write.references[1].clone()];
        store.publish_team_discussion(&other, &other_post).unwrap();
        let before = std::fs::read(
            store
                .directory()
                .join(super::super::super::DATABASE_FILENAME),
        )
        .unwrap();
        let sequence = store.execution_sequence().unwrap();
        let budget = store.provider_budget(scope.parent_task()).unwrap();
        let translated = store
            .read_team_artifact(
                &author,
                &ReadTeamArtifact {
                    post_id: write.post_id,
                    reference_index: 0,
                },
            )
            .unwrap();
        assert_eq!(translated.kind, TeamArtifactReadKind::UntrustedTeamArtifact);
        assert_eq!(
            translated.artifact,
            TeamArtifactBody::TranslationRevision {
                revision_id: old.revision_id,
                text: old_text.into()
            }
        );
        let source_read = store
            .read_team_artifact(
                &author,
                &ReadTeamArtifact {
                    post_id: write.post_id,
                    reference_index: 1,
                },
            )
            .unwrap();
        let canonical = source
            .rows
            .iter()
            .find(|row| row.unit_id == Some(author.target.unit_id))
            .unwrap();
        assert_eq!(
            source_read.artifact,
            TeamArtifactBody::SourceResult {
                snapshot_id: author.target.source_snapshot_id,
                attempt_id: source.attempt_id,
                result_id: source.result_id,
                occurrence_id: canonical.occurrence_id.unwrap(),
                native_key: item.native_key,
                text: item.source_text,
            }
        );
        let bytes = codec::encode(
            &source_read,
            TeamDiscussionLimits::for_policy(TeamDiscussionPolicy::CurrentPlanV2 {})
                .max_artifact_bytes as usize,
        )
        .unwrap();
        assert_eq!(
            codec::decode::<TeamArtifactRead>(&bytes, 32768).unwrap(),
            source_read
        );
        let json = serde_json::to_value(&source_read).unwrap();
        assert_eq!(json["artifact"].as_object().unwrap().len(), 7);
        for row in source
            .rows
            .iter()
            .filter(|row| row.unit_id != Some(author.target.unit_id))
        {
            assert!(!String::from_utf8_lossy(&bytes).contains(&row.occurrence.text));
        }
        assert_eq!(
            store
                .read_team_artifact(
                    &author,
                    &ReadTeamArtifact {
                        post_id: other_post.post_id,
                        reference_index: 0
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        assert_eq!(
            store
                .read_team_artifact(
                    &author,
                    &ReadTeamArtifact {
                        post_id: write.post_id,
                        reference_index: 2
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert!(
            store
                .read_team_artifact(
                    &author,
                    &ReadTeamArtifact {
                        post_id: ExecutionId::new(),
                        reference_index: 0
                    }
                )
                .is_err()
        );
        assert_eq!(
            store
                .translation_history(
                    plan.project_id,
                    author.target.unit_id,
                    &author.target.locale,
                    0,
                    1
                )
                .unwrap()
                .current,
            Some(newest)
        );
        assert_eq!(store.execution_sequence().unwrap(), sequence);
        assert_eq!(store.provider_budget(scope.parent_task()).unwrap(), budget);
        assert_eq!(
            std::fs::read(
                store
                    .directory()
                    .join(super::super::super::DATABASE_FILENAME)
            )
            .unwrap(),
            before
        );
    }

    #[test]
    fn team_artifact_profile_and_encoded_limit_fail_closed_for_missing_or_inactive_authority() {
        let (_old_temp, mut old_store, _old_plan, old_scope, old_units) = setup();
        let old_request = dispatch(&mut old_store, &old_scope, vec![old_units[0]]);
        let old_author = old_store
            .capture_team_execution_author(&old_scope, &old_request)
            .unwrap();
        let old_post = publication(
            &old_author,
            "A v1 publication does not grant cited-body sharing.",
        );
        old_store
            .publish_team_discussion(&old_author, &old_post)
            .unwrap();
        assert_eq!(
            old_store
                .read_team_artifact(
                    &old_author,
                    &ReadTeamArtifact {
                        post_id: old_post.post_id,
                        reference_index: 0
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        assert_eq!(
            team_discussion_tools(TeamDiscussionPolicy::CurrentPlanV1 {}).len(),
            2
        );
        assert!(
            !team_discussion_tools(TeamDiscussionPolicy::CurrentPlanV1 {})
                .iter()
                .any(|tool| tool.name == "read_team_artifact")
        );
        assert_eq!(
            team_discussion_tools(TeamDiscussionPolicy::CurrentPlanV2 {})
                .iter()
                .filter(|tool| tool.name == "read_team_artifact")
                .count(),
            1
        );
        assert_eq!(TeamDiscussionLimits::current_plan().max_artifact_bytes, 0);
        assert_eq!(
            TeamDiscussionLimits::for_policy(TeamDiscussionPolicy::CurrentPlanV2 {})
                .max_artifact_bytes,
            32768
        );
        for profile in ["current-plan-1", "current-plan-2"] {
            assert!(
                serde_json::from_value::<TeamDiscussionPolicy>(
                    serde_json::json!({"profile":profile,"maxArtifactBytes":999})
                )
                .is_err()
            );
        }
        assert!(serde_json::from_value::<ReadTeamArtifact>(serde_json::json!({"postId":old_post.post_id,"referenceIndex":0,"revisionId":ExecutionId::new()})).is_err());
        let short_plan = old_store
            .prepare_work_plan(
                Some(config()),
                "zh-CN",
                &old_units,
                PlanOptions {
                    team_discussions: Some(TeamDiscussionPolicy::CurrentPlanV2 {}),
                    ..PlanOptions::default()
                },
            )
            .unwrap();
        let mut permission = consent(&short_plan);
        permission.effects = short_plan.authorization_effects().unwrap();
        permission.expires_at = control::now().unwrap() + 2;
        let grant = old_store
            .authorize_work_plan(&short_plan, &permission)
            .unwrap();
        old_store
            .enqueue_execution(&FixedInput::capture(grant.input.unwrap()).unwrap())
            .unwrap();
        let short_scope = old_store.work_plan_agent_scope(grant.lease).unwrap();
        let short_request = dispatch(&mut old_store, &short_scope, vec![old_units[0]]);
        let short_author = old_store
            .capture_team_execution_author(&short_scope, &short_request)
            .unwrap();
        let revision = old_store
            .translation_history(
                short_plan.project_id,
                short_author.target.unit_id,
                &short_author.target.locale,
                0,
                1,
            )
            .unwrap()
            .rows[0]
            .revision_id;
        let mut short_post = publication(
            &short_author,
            "The original absolute lease must still be live.",
        );
        short_post.references = vec![TeamArtifactReference::TranslationRevision {
            revision_id: revision,
        }];
        old_store
            .publish_team_discussion(&short_author, &short_post)
            .unwrap();
        let short_read = ReadTeamArtifact {
            post_id: short_post.post_id,
            reference_index: 0,
        };
        old_store
            .read_team_artifact(&short_author, &short_read)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2100));
        assert_eq!(
            old_store
                .read_team_artifact(&short_author, &short_read)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        let (_temp, mut store, plan, scope, units) =
            setup_for(TeamDiscussionPolicy::CurrentPlanV2 {});
        let request = dispatch(&mut store, &scope, vec![units[0]]);
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        let oversized_text = "\u{0001}".repeat(6000);
        let revision = save_text(&mut store, &plan, author.target(), &oversized_text);
        let mut write = publication(
            &author,
            "A complete encoded body may exceed the artifact limit.",
        );
        write.references = vec![TeamArtifactReference::TranslationRevision {
            revision_id: revision.revision_id,
        }];
        let saved = store.publish_team_discussion(&author, &write).unwrap();
        let read = ReadTeamArtifact {
            post_id: write.post_id,
            reference_index: 0,
        };
        let before = std::fs::read(
            store
                .directory()
                .join(super::super::super::DATABASE_FILENAME),
        )
        .unwrap();
        assert!(oversized_text.len() < crate::content::MAX_TEXT_BYTES);
        assert_eq!(
            store.read_team_artifact(&author, &read).unwrap_err().code,
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            std::fs::read(
                store
                    .directory()
                    .join(super::super::super::DATABASE_FILENAME)
            )
            .unwrap(),
            before
        );
        // Inject an unavailable original reference without changing the body's typed shape.
        let mut missing = saved.clone();
        missing.publication.references = vec![TeamArtifactReference::TranslationRevision {
            revision_id: ExecutionId::new(),
        }];
        let bytes = codec::encode(&missing, MAX_RECORD_BYTES).unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE application_team_posts SET record=?2,digest=?3 WHERE post_id=?1",
                params![write.post_id.to_string(), bytes, codec::digest(&bytes)],
            )
            .unwrap();
        assert!(store.read_team_artifact(&author, &read).is_err());
        let bytes = codec::encode(&saved, MAX_RECORD_BYTES).unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE application_team_posts SET record=?2,digest=?3 WHERE post_id=?1",
                params![write.post_id.to_string(), bytes, codec::digest(&bytes)],
            )
            .unwrap();
        let mut stale_epoch = author.clone();
        stale_epoch.scope.store_epoch.push('x');
        assert_eq!(
            store
                .read_team_artifact(&stale_epoch, &read)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        store
            .control_work_plan(&control(
                &plan,
                scope.lease.generation.get(),
                WorkPlanCommand::Pause,
            ))
            .unwrap();
        assert_eq!(
            store.read_team_artifact(&author, &read).unwrap_err().code,
            ErrorCode::Cancelled
        );
    }

    #[test]
    fn team_publication_uses_original_dispatch_references_and_exact_idempotency() {
        let (_temp, mut store, plan, scope, units) = setup();
        let request = dispatch(&mut store, &scope, vec![units[0]]);
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        assert_eq!(
            store
                .capture_team_execution_author(&scope, &request)
                .unwrap()
                .author(),
            author.author()
        );
        assert_ne!(author.author.member_id, scope.caller_id());
        assert_ne!(author.author.member_id, request.input.envelope().task_id);
        let mut write = publication(&author, "Keep the original line-break evidence. 👩🏽‍💻");
        let revision = store
            .translation_history(plan.project_id, units[0], "zh-CN", 0, 100)
            .unwrap()
            .rows[0]
            .revision_id;
        let source = store
            .source_content(write.target.source_snapshot_id, 0, 1)
            .unwrap();
        write.references = vec![
            TeamArtifactReference::TranslationRevision {
                revision_id: revision,
            },
            TeamArtifactReference::SourceResult {
                snapshot_id: write.target.source_snapshot_id,
                attempt_id: source.attempt_id,
                result_id: source.result_id,
            },
        ];
        let post = store.publish_team_discussion(&author, &write).unwrap();
        assert_eq!(
            store.publish_team_discussion(&author, &write).unwrap(),
            post
        );
        let mut changed = write.clone();
        changed.body.push('!');
        assert_eq!(
            store
                .publish_team_discussion(&author, &changed)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        let mut outside = publication(&author, "Outside is not authorized");
        outside.target.unit_id = units[1];
        assert_eq!(
            store
                .publish_team_discussion(&author, &outside)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        let another_request = dispatch(&mut store, &scope, vec![units[0]]);
        let other = store
            .capture_team_execution_author(&scope, &another_request)
            .unwrap();
        let mut reply = publication(&other, "A second member challenges this evidence.");
        reply.kind = TeamDiscussionKind::Challenge;
        reply.reply_to = Some(post.publication.post_id);
        store.publish_team_discussion(&other, &reply).unwrap();
        reply.post_id = ExecutionId::new();
        reply.supersedes = Some(post.publication.post_id);
        assert_eq!(
            store
                .publish_team_discussion(&other, &reply)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
        let mut replacement = publication(&author, "Correct the previously published explanation.");
        replacement.supersedes = Some(post.publication.post_id);
        store
            .publish_team_discussion(&author, &replacement)
            .unwrap();
        replacement.post_id = ExecutionId::new();
        assert_eq!(
            store
                .publish_team_discussion(&author, &replacement)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
        assert_eq!(
            store
                .read_team_discussion(&scope, post.publication.post_id)
                .unwrap(),
            post
        );
        let subset = store
            .delegate_work_plan_agent_scope(
                &scope,
                &AgentDelegationRequest {
                    delegation_id: ExecutionId::new(),
                    unit_ids: vec![units[1]],
                    tool_handles: vec![],
                },
            )
            .unwrap();
        assert_eq!(
            store
                .read_team_discussion(&subset, post.publication.post_id)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        validate(store.connection().unwrap()).unwrap();
    }

    #[test]
    fn team_frozen_views_keep_objections_and_do_not_absorb_later_posts() {
        let (_temp, mut store, _plan, scope, units) = setup();
        let request = dispatch(&mut store, &scope, vec![units[0]]);
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        let mut objection = publication(
            &author,
            "The source context still contradicts this translation.",
        );
        objection.kind = TeamDiscussionKind::Challenge;
        store.publish_team_discussion(&author, &objection).unwrap();
        let mut note = publication(
            &author,
            "Additional evidence; the concern remains unresolved.",
        );
        note.supersedes = Some(objection.post_id);
        store.publish_team_discussion(&author, &note).unwrap();
        for i in 0..18 {
            store
                .publish_team_discussion(
                    &author,
                    &publication(&author, &format!("Independent note {i}")),
                )
                .unwrap();
        }
        let captured = store.capture_team_discussion_view(&author).unwrap();
        assert!(
            captured
                .view
                .posts
                .iter()
                .any(|p| p.publication.post_id == objection.post_id)
        );
        assert!(!captured.view.folded.is_empty());
        assert!(captured.utf8().contains("untrusted-team-discussions"));
        assert!(
            captured.utf8().len() <= TeamDiscussionLimits::current_plan().max_view_bytes as usize
        );
        let frozen = captured.utf8().to_owned();
        let later = publication(&author, "Only the next request should observe this post.");
        store.publish_team_discussion(&author, &later).unwrap();
        store
            .validate_team_discussion_view_current(&captured)
            .unwrap();
        validate_team_provider_view_in(
            store.connection().unwrap(),
            &request,
            Some(captured.view()),
        )
        .unwrap();
        assert_eq!(captured.utf8(), frozen);
        assert!(!captured.utf8().contains(&later.body));
        let next = store.capture_team_discussion_view(&author).unwrap();
        assert!(
            next.view
                .posts
                .iter()
                .any(|p| p.publication.post_id == later.post_id)
        );
        assert!(
            validate_team_provider_view_in(store.connection().unwrap(), &request, None).is_err()
        );
        let mut forged = captured.view.clone();
        let p = forged
            .posts
            .iter()
            .position(|p| p.publication.post_id == objection.post_id)
            .unwrap();
        let hidden = forged.posts.remove(p);
        forged.folded.push(TeamDiscussionPostReference {
            post_id: hidden.publication.post_id,
            sequence: hidden.sequence,
        });
        forged.folded.sort_by_key(|p| p.sequence);
        assert!(validate_view(store.connection().unwrap(), &forged).is_err());
        // A well-encoded publication with missing evidence still blocks capture.
        let saved = post(store.connection().unwrap(), note.post_id)
            .unwrap()
            .unwrap();
        let mut missing = saved.clone();
        missing.publication.references = vec![TeamArtifactReference::TranslationRevision {
            revision_id: ExecutionId::new(),
        }];
        let bytes = codec::encode(&missing, MAX_RECORD_BYTES).unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE application_team_posts SET record=?2,digest=?3 WHERE post_id=?1",
                params![note.post_id.to_string(), bytes, codec::digest(&bytes)],
            )
            .unwrap();
        assert!(store.capture_team_discussion_view(&author).is_err());
        let bytes = codec::encode(&saved, MAX_RECORD_BYTES).unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE application_team_posts SET record=?2,digest=?3 WHERE post_id=?1",
                params![note.post_id.to_string(), bytes, codec::digest(&bytes)],
            )
            .unwrap();
        let mut resolution = publication(
            &author,
            "The contradiction is resolved by the corrected evidence.",
        );
        resolution.kind = TeamDiscussionKind::Resolution;
        resolution.supersedes = Some(note.post_id);
        store.publish_team_discussion(&author, &resolution).unwrap();
        let mut resolved = store.capture_team_discussion_view(&author).unwrap().view;
        if let Some(i) = resolved
            .posts
            .iter()
            .position(|p| p.publication.post_id == objection.post_id)
        {
            let old = resolved.posts.remove(i);
            resolved.folded.push(TeamDiscussionPostReference {
                post_id: old.publication.post_id,
                sequence: old.sequence,
            });
            resolved.folded.sort_by_key(|p| p.sequence);
        }
        validate_view(store.connection().unwrap(), &resolved).unwrap();
        let mut oversized = publication(
            &author,
            &"界".repeat(TeamDiscussionLimits::current_plan().max_post_bytes as usize / 3 + 1),
        );
        assert_eq!(
            store
                .publish_team_discussion(&author, &oversized)
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        oversized.body = "x".repeat(TeamDiscussionLimits::current_plan().max_post_bytes as usize);
        oversized.kind = TeamDiscussionKind::Rejection;
        store.publish_team_discussion(&author, &oversized).unwrap();
        oversized.post_id = ExecutionId::new();
        store.publish_team_discussion(&author, &oversized).unwrap();
        assert_eq!(
            store
                .capture_team_discussion_view(&author)
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn team_history_reopens_without_restoring_scope_and_human_is_a_separate_entry() {
        let (_temp, mut store, plan, scope, units) = setup();
        let request = dispatch(&mut store, &scope, vec![units[0]]);
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        let write = publication(&author, "Original member publication.");
        let post = store.publish_team_discussion(&author, &write).unwrap();
        let view = store.capture_team_discussion_view(&author).unwrap();
        let human = store
            .publish_human_team_discussion(
                &scope,
                "Reviewer",
                &publication(&author, "A human discussion is still not an approval."),
            )
            .unwrap();
        assert!(matches!(human.author, TeamDiscussionAuthor::Human { .. }));
        let mut forged = serde_json::to_value(&write).unwrap();
        forged["author"] = serde_json::json!({"kind":"human"});
        assert!(serde_json::from_value::<PublishTeamDiscussion>(forged).is_err());
        let changed_role = TeamMemberRoleWrite {
            member_id: author.author.member_id,
            role_version_id: ExecutionId::new(),
            expected_role_version_id: Some(author.author.role_version_id),
            display_name: "Reviewer".into(),
            role: "Review the same bounded material.".into(),
        };
        assert!(store.register_team_member(&scope, &changed_role).is_err());
        let paused = store
            .control_work_plan(&control(
                &plan,
                scope.lease.generation.get(),
                WorkPlanCommand::Pause,
            ))
            .unwrap();
        assert!(
            store
                .publish_team_discussion(&author, &publication(&author, "Revoked"))
                .is_err()
        );
        assert!(store.validate_team_discussion_view_current(&view).is_err());
        validate_team_provider_view_history_in(
            store.connection().unwrap(),
            &request.input,
            request.item_id,
            Some(view.view()),
        )
        .unwrap();
        validate(store.connection().unwrap()).unwrap();
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let mut reopened = ProjectStore::open(&directory).unwrap();
        assert!(
            reopened
                .read_team_discussion(&scope, write.post_id)
                .is_err()
        );
        let continued = reopened
            .control_work_plan(&control(
                &plan,
                paused.lease.generation.get(),
                WorkPlanCommand::Continue,
            ))
            .unwrap();
        let fresh = reopened.work_plan_agent_scope(continued.lease).unwrap();
        assert_eq!(
            reopened
                .read_team_discussion(&fresh, write.post_id)
                .unwrap(),
            post
        );
        let role = reopened
            .register_team_member(&fresh, &changed_role)
            .unwrap();
        assert_eq!(role.version.get(), 2);
        assert_eq!(role.config, author.role.config);
        assert_eq!(
            reopened
                .register_team_member(&fresh, &changed_role)
                .unwrap(),
            role
        );
        let mut collision = changed_role;
        collision.role.push('!');
        assert_eq!(
            reopened
                .register_team_member(&fresh, &collision)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        validate(reopened.connection().unwrap()).unwrap();
    }

    #[test]
    fn team_roles_are_fixed_before_execution_and_history_uses_its_own_generation() {
        let (_temp, mut store, plan, original_scope, units) = setup();
        let original_request = dispatch(&mut store, &original_scope, vec![units[0]]);
        let original_author = store
            .capture_team_execution_author(&original_scope, &original_request)
            .unwrap();
        let original_post = store
            .publish_team_discussion(
                &original_author,
                &publication(
                    &original_author,
                    "The original role remains historical evidence.",
                ),
            )
            .unwrap();
        let new_member = || TeamMemberRoleWrite {
            member_id: ExecutionId::new(),
            role_version_id: ExecutionId::new(),
            expected_role_version_id: None,
            display_name: "Reviewer".into(),
            role: "Review the same authorized source evidence.".into(),
        };
        let first_b = new_member();
        let first_c = new_member();
        store
            .register_team_member(&original_scope, &first_b)
            .unwrap();
        store
            .register_team_member(&original_scope, &first_c)
            .unwrap();
        let paused = store
            .control_work_plan(&control(
                &plan,
                original_scope.lease.generation.get(),
                WorkPlanCommand::Pause,
            ))
            .unwrap();
        let resumed = store
            .control_work_plan(&control(
                &plan,
                paused.lease.generation.get(),
                WorkPlanCommand::Continue,
            ))
            .unwrap();
        let scope = store.work_plan_agent_scope(resumed.lease).unwrap();
        assert_eq!(scope.lease.generation.get(), 3);
        let second_b = TeamMemberRoleWrite {
            role_version_id: ExecutionId::new(),
            expected_role_version_id: Some(first_b.role_version_id),
            role: "Explain the reviewed evidence under the revised role.".into(),
            ..first_b.clone()
        };
        store.register_team_member(&scope, &second_b).unwrap();
        let request_b = dispatch(&mut store, &scope, vec![units[0]]);
        let author_b = store
            .capture_team_author(
                &scope,
                first_b.member_id,
                second_b.role_version_id,
                request_b.input.envelope().attempt_id,
                request_b.item_id,
            )
            .unwrap();
        let post_b = store
            .publish_team_discussion(
                &author_b,
                &publication(&author_b, "This publication used the second role."),
            )
            .unwrap();
        let captured_b = store.capture_team_discussion_view(&author_b).unwrap();
        let request_c = dispatch(&mut store, &scope, vec![units[0]]);
        let author_c = store
            .capture_team_author(
                &scope,
                first_c.member_id,
                first_c.role_version_id,
                request_c.input.envelope().attempt_id,
                request_c.item_id,
            )
            .unwrap();
        let result = FixedResult::capture(
            ResultEnvelope {
                project_id: plan.project_id,
                attempt_id: request_c.input.envelope().attempt_id,
                item_id: request_c.item_id,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: request_c.dispatch_token,
                capability_id: request_c.input.envelope().capability_id.clone(),
                capability_version: request_c.input.envelope().capability_version.clone(),
                plugin: None,
                outcome: ExecutionState::Failed,
                output: None,
                diagnostic: Some(Diagnostic {
                    code: "synthetic-failure".into(),
                    retry_safe: false,
                }),
            },
            &request_c.input,
            request_c.dispatch_token,
        )
        .unwrap();
        store.save_execution_result(&result).unwrap();
        assert_eq!(
            store
                .connection()
                .unwrap()
                .query_row(
                    "SELECT execution FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                    params![
                        author_c.author.attempt_id.to_string(),
                        author_c.author.item_id.to_string()
                    ],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "failed"
        );
        let second_c = TeamMemberRoleWrite {
            role_version_id: ExecutionId::new(),
            expected_role_version_id: Some(first_c.role_version_id),
            role: "A new role requires an unused admission generation.".into(),
            ..first_c.clone()
        };
        // Finishing the old loop does not permit a retroactive same-generation role.
        assert_eq!(
            store
                .register_team_member(&scope, &second_c)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
        let paused = store
            .control_work_plan(&control(
                &plan,
                scope.lease.generation.get(),
                WorkPlanCommand::Pause,
            ))
            .unwrap();
        let resumed = store
            .control_work_plan(&control(
                &plan,
                paused.lease.generation.get(),
                WorkPlanCommand::Continue,
            ))
            .unwrap();
        let fresh = store.work_plan_agent_scope(resumed.lease).unwrap();
        let role_c = store.register_team_member(&fresh, &second_c).unwrap();
        assert_eq!(role_c.generation.get(), 5);
        // Later roles and inactive historical leases do not invalidate earlier authors.
        author_history(store.connection().unwrap(), &author_c.author).unwrap();
        validate_team_provider_view_history_in(
            store.connection().unwrap(),
            &request_b.input,
            request_b.item_id,
            Some(captured_b.view()),
        )
        .unwrap();
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let reopened = ProjectStore::open(&directory).unwrap();
        let scope = reopened.work_plan_agent_scope(resumed.lease).unwrap();
        assert_eq!(
            reopened
                .read_team_discussion(&scope, original_post.publication.post_id)
                .unwrap(),
            original_post
        );
        assert_eq!(
            reopened
                .read_team_discussion(&scope, post_b.publication.post_id)
                .unwrap(),
            post_b
        );
        // Re-encoding a valid old role ID cannot change which role authored generation 3.
        let mut forged = post_b;
        let TeamDiscussionAuthor::Member { author } = &mut forged.author else {
            panic!("member fixture")
        };
        author.role_version_id = first_b.role_version_id;
        let bytes = codec::encode(&forged, MAX_RECORD_BYTES).unwrap();
        reopened
            .connection()
            .unwrap()
            .execute(
                "UPDATE application_team_posts SET record=?2,digest=?3 WHERE post_id=?1",
                params![
                    forged.publication.post_id.to_string(),
                    bytes,
                    codec::digest(&bytes)
                ],
            )
            .unwrap();
        reopened.close().unwrap();
        assert!(matches!(
            ProjectStore::open(&directory),
            Err(crate::PersistenceError::CorruptProject { .. })
        ));
    }

    #[test]
    fn team_current_source_adoption_closes_stale_sharing_without_erasing_history() {
        let (_temp, mut store, plan, scope, units) = setup();
        let request = dispatch(&mut store, &scope, vec![units[0]]);
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        let old_snapshot = author.target.source_snapshot_id;
        let source = store.source_content(old_snapshot, 0, 100).unwrap();
        let mut write = publication(
            &author,
            "This evidence refers to the original source snapshot.",
        );
        write.references.push(TeamArtifactReference::SourceResult {
            snapshot_id: old_snapshot,
            attempt_id: source.attempt_id,
            result_id: source.result_id,
        });
        let published = store.publish_team_discussion(&author, &write).unwrap();
        let captured = store.capture_team_discussion_view(&author).unwrap();
        let config = crate::ai::settings(&request.input).unwrap().config;
        let mut body = serde_json::json!({
            "model": config.model, "stream": true,
            "messages": [{"role":"user", "content":captured.utf8()}],
        });
        body[&config.token_field] = config.max_output_tokens.into();
        let capture = crate::ai::provider::ProviderRequestCapture {
            body: body.to_string(),
            team_view: Some(captured.view().clone()),
            team_work_view: None,
        };
        let serialized = codec::encode(&capture, 131072).unwrap();
        let restored: crate::ai::provider::ProviderRequestCapture =
            codec::decode(&serialized, 131072).unwrap();
        assert_eq!(restored, capture);
        assert!(
            captured
                .utf8()
                .starts_with("{\"kind\":\"untrusted-team-discussions\",\"viewId\":")
        );
        let mut invalid = serde_json::to_value(&capture).unwrap();
        invalid["teamView"]["kind"] = "other-data".into();
        assert!(
            codec::decode::<crate::ai::provider::ProviderRequestCapture>(
                &codec::encode(&invalid, 131072).unwrap(),
                131072,
            )
            .is_err()
        );
        // Reserve the exact capture locally; no HTTP client or model is invoked.
        store
            .reserve_provider_request_capture(
                &request,
                ExecutionId::new(),
                config.max_requests,
                Some(&capture),
            )
            .unwrap();
        let budget = store.provider_budget(scope.parent_task()).unwrap().unwrap();
        let requests: i64 = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM execution_provider_requests WHERE attempt_id=?1",
                [request.input.envelope().attempt_id.to_string()],
                |r| r.get(0),
            )
            .unwrap();

        // Exercise the original adoption owner while its old plan remains active.
        // This isolates source freshness from the separate lease-revocation guard.
        crate::persistence::review::tests::adopt_source(
            &mut store,
            br#"{"replacement":"Changed source"}"#,
        );
        let current = store.content_scope().unwrap().current_snapshot.unwrap();
        assert_ne!(current, old_snapshot);
        store.check_work_plan_agent_scope(&scope).unwrap();
        assert_eq!(
            store.work_plan_status(plan.plan_id).unwrap().state,
            WorkPlanState::Active
        );
        let stale = |error: ExecutionError| {
            assert_eq!(error.code, ErrorCode::DependencyConflict);
            assert_eq!(error.stage, "team-basis");
        };
        stale(
            store
                .publish_team_discussion(
                    &author,
                    &publication(&author, "A stale source must not be shared."),
                )
                .unwrap_err(),
        );
        stale(
            store
                .read_team_discussion(&scope, write.post_id)
                .unwrap_err(),
        );
        stale(store.capture_team_discussion_view(&author).unwrap_err());
        stale(
            store
                .validate_team_discussion_view_current(&captured)
                .unwrap_err(),
        );
        stale(
            validate_team_provider_view_in(
                store.connection().unwrap(),
                &request,
                Some(captured.view()),
            )
            .unwrap_err(),
        );
        stale(
            store
                .reserve_provider_request_capture(
                    &request,
                    ExecutionId::new(),
                    config.max_requests,
                    Some(&capture),
                )
                .unwrap_err(),
        );
        assert_eq!(
            store.provider_budget(scope.parent_task()).unwrap().unwrap(),
            budget
        );
        assert_eq!(
            store
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM execution_provider_requests WHERE attempt_id=?1",
                    [request.input.envelope().attempt_id.to_string()],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap(),
            requests
        );
        validate_team_provider_view_history_in(
            store.connection().unwrap(),
            &request.input,
            request.item_id,
            Some(captured.view()),
        )
        .unwrap();

        store
            .control_work_plan(&control(
                &plan,
                scope.lease.generation.get(),
                WorkPlanCommand::Pause,
            ))
            .unwrap();
        assert_eq!(
            store.check_work_plan_agent_scope(&scope).unwrap_err().code,
            ErrorCode::Cancelled
        );
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let reopened = ProjectStore::open(&directory).unwrap();
        assert_eq!(
            reopened.content_scope().unwrap().current_snapshot,
            Some(current)
        );
        assert!(reopened.check_work_plan_agent_scope(&scope).is_err());
        assert!(
            reopened
                .read_team_discussion(&scope, write.post_id)
                .is_err()
        );
        assert!(
            reopened
                .validate_team_discussion_view_current(&captured)
                .is_err()
        );
        // Historical facts and original source text remain readable by their owners.
        assert_eq!(
            post(reopened.connection().unwrap(), write.post_id).unwrap(),
            Some(published)
        );
        assert_eq!(
            reopened.source_content(old_snapshot, 0, 100).unwrap().rows,
            source.rows
        );
        validate_team_provider_view_history_in(
            reopened.connection().unwrap(),
            &request.input,
            request.item_id,
            Some(captured.view()),
        )
        .unwrap();
    }

    #[test]
    fn team_disabled_policy_and_corrupt_history_are_rejected_by_original_owners() {
        assert!(
            serde_json::from_value::<TeamDiscussionPolicy>(
                serde_json::json!({"profile":"current-plan-1","maxPosts":999})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<TeamDiscussionPolicy>(
                serde_json::json!({"profile":"unknown"})
            )
            .is_err()
        );
        let (_temp, mut store, plan, scope, units) = setup();
        let request = dispatch(&mut store, &scope, vec![units[0]]);
        let author = store
            .capture_team_execution_author(&scope, &request)
            .unwrap();
        let write = publication(&author, "Integrity is checked at reopen.");
        store.publish_team_discussion(&author, &write).unwrap();
        let disabled = store
            .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
            .unwrap();
        let grant = store
            .authorize_work_plan(&disabled, &consent(&disabled))
            .unwrap();
        store
            .enqueue_execution(&FixedInput::capture(grant.input.unwrap()).unwrap())
            .unwrap();
        let no_share = store.work_plan_agent_scope(grant.lease).unwrap();
        let no_share_request = dispatch(&mut store, &no_share, vec![units[0]]);
        assert!(
            store
                .capture_team_execution_author(&no_share, &no_share_request)
                .is_err()
        );
        validate_team_provider_view_in(store.connection().unwrap(), &no_share_request, None)
            .unwrap();
        assert!(
            store
                .read_team_discussion(&no_share, write.post_id)
                .is_err()
        );
        let count: i64 = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM application_team_posts WHERE plan_id=?1",
                [plan.plan_id.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let directory = store.directory().to_path_buf();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE application_team_posts SET digest=?1",
                ["0".repeat(64)],
            )
            .unwrap();
        store.close().unwrap();
        assert!(matches!(
            ProjectStore::open(&directory),
            Err(crate::PersistenceError::CorruptProject { .. })
        ));
    }
}
