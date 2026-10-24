//! Team facts link to the original execution, Provider and candidate ledgers.
use super::{ProjectStore, agents, control, recovery, team};
use crate::{ai, application::*, execution::*};
use rusqlite::{Connection, OptionalExtension, params};

const MAX_RECORD: usize = 65536;
const MAX_MESSAGE_RECORD: usize = 32768;
const TABLES: &[(&str, &str)] = &[
    (
        "application_team_work",
        "CREATE TABLE application_team_work (intent_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_plans(plan_id), sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 300), member_id TEXT NOT NULL REFERENCES application_team_members(member_id), role_version TEXT NOT NULL REFERENCES application_team_roles(version_id), task_id TEXT NOT NULL UNIQUE REFERENCES execution_tasks(task_id), attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(attempt_id), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 65536), digest TEXT NOT NULL CHECK(length(digest)=64), deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>0), UNIQUE(plan_id,sequence))",
    ),
    (
        "application_team_messages",
        "CREATE TABLE application_team_messages (message_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_plans(plan_id), sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 256), recipient TEXT NOT NULL REFERENCES application_team_members(member_id), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 32768), digest TEXT NOT NULL CHECK(length(digest)=64), UNIQUE(plan_id,sequence))",
    ),
    (
        "application_team_consumptions",
        "CREATE TABLE application_team_consumptions (message_id TEXT PRIMARY KEY NOT NULL REFERENCES application_team_messages(message_id), task_id TEXT NOT NULL REFERENCES execution_tasks(task_id), request_id TEXT NOT NULL REFERENCES execution_provider_requests(request_id))",
    ),
];
fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    fail(ErrorCode::StorageFailed, "team-coordination-storage")
}
fn denied() -> ExecutionError {
    fail(ErrorCode::Unauthorized, "team-work-scope")
}
fn corrupt() -> ExecutionError {
    fail(ErrorCode::CorruptLedger, "team-work-facts")
}
fn mismatch() -> ExecutionError {
    fail(ErrorCode::ResultMismatch, "team-work-identity")
}
pub(super) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        c.execute_batch(sql)?;
    }
    Ok(())
}
pub(super) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| name.to_string())
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkRecord {
    receipt: TeamWorkReceipt,
    author: Option<TeamMemberAuthor>,
    request: Option<RequestTeamWork>,
}
fn work(c: &Connection, intent: ExecutionId) -> Result<Option<WorkRecord>, ExecutionError> {
    let row:Option<(Vec<u8>,String,String,String,String,String)>=c.query_row("SELECT record,digest,task_id,attempt_id,member_id,role_version FROM application_team_work WHERE intent_id=?1",[intent.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(sql)?;
    row.map(|row| {
        let value: WorkRecord = codec::decode(&row.0, MAX_RECORD)?;
        if codec::digest(&row.0) != row.1
            || value.receipt.intent_id != intent
            || value.receipt.task_id.to_string() != row.2
            || value.receipt.attempt_id.to_string() != row.3
            || value.receipt.member_id.to_string() != row.4
            || value.receipt.role_version_id.to_string() != row.5
        {
            return Err(corrupt());
        }
        Ok(value)
    })
    .transpose()
}
fn by_attempt(c: &Connection, attempt: ExecutionId) -> Result<WorkRecord, ExecutionError> {
    let id: String = c
        .query_row(
            "SELECT intent_id FROM application_team_work WHERE attempt_id=?1",
            [attempt.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    work(c, ExecutionId::parse(&id)?)?.ok_or_else(corrupt)
}
fn member<'a>(
    plan: &'a WorkPlan,
    id: ExecutionId,
) -> Result<&'a TeamExecutionMember, ExecutionError> {
    plan.options
        .team_execution
        .as_ref()
        .and_then(|p| p.members().iter().find(|m| m.member_id == id))
        .ok_or_else(denied)
}
pub(super) fn scope_for(
    plan: &WorkPlan,
    lease: AutomationLease,
    member: &TeamExecutionMember,
    caller: ExecutionId,
    parent: ExecutionId,
) -> WorkPlanAgentExecutionBinding {
    let mut units = member.unit_ids.clone();
    units.sort();
    let mut tools = member.tool_handles.clone();
    tools.sort();
    WorkPlanAgentExecutionBinding {
        lease,
        root_task: plan
            .execution_input()
            .expect("validated executable plan")
            .task_id,
        caller_id: caller,
        delegation: Some(WorkPlanAgentSubset {
            delegation_id: caller,
            parent_scope_id: parent,
            unit_ids: units,
            tool_handles: tools,
        }),
    }
}
pub(super) fn derive(
    plan: &WorkPlan,
    template: &FixedInput,
    lease: AutomationLease,
    member_id: ExecutionId,
    unit: ExecutionId,
    task: ExecutionId,
    attempt: ExecutionId,
    binding: TeamWorkBinding,
    request: Option<&RequestTeamWork>,
) -> Result<FixedInput, ExecutionError> {
    let selected = member(plan, member_id)?;
    let item = plan
        .team_inputs
        .iter()
        .find(|i| i.member_id == member_id)
        .and_then(|i| i.items.iter().find(|i| i.unit_id == unit))
        .ok_or_else(denied)?;
    let mut e = template.envelope().clone();
    e.task_id = task;
    e.attempt_id = attempt;
    e.automation = Some(lease);
    e.operation = ai::team::OPERATION.into();
    e.capability_id = ai::team::CAPABILITY.into();
    e.items.retain(|i| i.scope.id == unit.to_string());
    if e.items.len() != 1 {
        return Err(denied());
    }
    e.items[0].payload = serde_json::to_value(item).map_err(|_| corrupt())?;
    e.units.retain(|u| u.item_ids.contains(&e.items[0].item_id));
    let root = ai::settings(template)?;
    e.settings = serde_json::to_value(ai::team::TeamWorkSettings {
        config: selected.config.clone(),
        root_request_limit: root.config.max_requests,
        binding,
        kind: request.map_or(TeamWorkKind::Translation, |r| r.kind),
        instructions: request.map_or_else(|| selected.role.clone(), |r| r.instructions.clone()),
        post_ids: request.map_or_else(Vec::new, |r| r.post_ids.clone()),
        cause_message_id: request.and_then(|r| r.cause_message_id),
    })
    .map_err(|_| corrupt())?;
    FixedInput::capture(e)
}
pub(super) fn root_input(
    plan: &WorkPlan,
    lease: AutomationLease,
) -> Result<FixedInput, ExecutionError> {
    let policy = plan.options.team_execution.as_ref().ok_or_else(denied)?;
    let selected = member(plan, policy.initial_member_id())?;
    let root = plan.execution_input()?;
    if lease.generation.get() != 1 {
        return Err(corrupt());
    }
    let caller = ExecutionId::new();
    let parent = ExecutionId::new();
    let binding = TeamWorkBinding::Root {
        member_id: selected.member_id,
        role_version_id: selected.role_version_id,
        scope: scope_for(plan, lease, selected, caller, parent),
    };
    derive(
        plan,
        &plan.fixed_input()?,
        lease,
        selected.member_id,
        policy.initial_unit_id(),
        root.task_id,
        root.attempt_id,
        binding,
        None,
    )
}
fn validate_input_basis(c: &Connection, input: &FixedInput) -> Result<WorkPlan, ExecutionError> {
    let s = ai::team::settings(input)?;
    let plan = recovery::plan_in(
        c,
        s.binding.scope().lease.plan_id,
        s.binding.scope().lease.generation,
    )?;
    let selected = member(&plan, s.binding.member_id())?;
    let root = plan.execution_input()?;
    let template = control::load(c, plan.plan_id)?.plan.fixed_input()?;
    if s.binding.role_version_id() != selected.role_version_id
        || s.config != selected.config
        || s.root_request_limit != ai::settings(&template)?.config.max_requests
    {
        return Err(corrupt());
    }
    let scope = agents::scope_from_binding(plan.project_id, s.binding.scope());
    agents::validate_scope_basis(&plan, &scope)?;
    let subset = s.binding.scope().delegation.as_ref().ok_or_else(corrupt)?;
    let mut units = selected.unit_ids.clone();
    units.sort();
    let mut tools = selected.tool_handles.clone();
    tools.sort();
    if subset.unit_ids != units
        || subset.tool_handles != tools
        || s.binding.scope().root_task != root.task_id
        || !selected.kinds.contains(&s.kind)
    {
        return Err(corrupt());
    }
    let target = ai::item_payload(input, input.envelope().items[0].item_id)?;
    let saved = match &s.binding {
        TeamWorkBinding::Root { .. } => None,
        TeamWorkBinding::Child { intent_id, .. }
        | TeamWorkBinding::HumanContinuation {
            work_id: intent_id, ..
        } => Some(RequestTeamWork {
            intent_id: *intent_id,
            recipient_member_id: selected.member_id,
            target: TeamDiscussionTarget {
                unit_id: target.unit_id,
                locale: target.target_locale.clone(),
                source_snapshot_id: target.source_snapshot_id,
                source_revision_id: target.source_revision_id,
            },
            kind: s.kind,
            instructions: s.instructions.clone(),
            post_ids: s.post_ids.clone(),
            cause_message_id: s.cause_message_id,
        }),
    };
    if s.binding.is_root()
        && (input.envelope().task_id != root.task_id
            || input.envelope().attempt_id != root.attempt_id
            || target.unit_id
                != plan
                    .options
                    .team_execution
                    .as_ref()
                    .unwrap()
                    .initial_unit_id()
            || s.kind != TeamWorkKind::Translation)
    {
        return Err(corrupt());
    }
    let expected = derive(
        &plan,
        &template,
        s.binding.scope().lease,
        selected.member_id,
        target.unit_id,
        input.envelope().task_id,
        input.envelope().attempt_id,
        s.binding.clone(),
        saved.as_ref(),
    )?;
    if expected.bytes() != input.bytes() {
        return Err(corrupt());
    }
    Ok(plan)
}
pub(super) fn validate_root_receipt(
    plan: &WorkPlan,
    lease: AutomationLease,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    let s = ai::team::settings(input)?;
    let policy = plan.options.team_execution.as_ref().ok_or_else(denied)?;
    if !s.binding.is_root()
        || s.binding.scope().lease != lease
        || s.binding.member_id() != policy.initial_member_id()
        || input.envelope().task_id != plan.execution_input()?.task_id
        || input.envelope().attempt_id != plan.execution_input()?.attempt_id
    {
        return Err(corrupt());
    }
    let expected = derive(
        plan,
        &plan.fixed_input()?,
        lease,
        s.binding.member_id(),
        policy.initial_unit_id(),
        input.envelope().task_id,
        input.envelope().attempt_id,
        s.binding.clone(),
        None,
    )?;
    if expected.bytes() != input.bytes() {
        return Err(corrupt());
    }
    Ok(())
}
pub(crate) fn validate_model_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    let plan = validate_input_basis(c, input)?;
    let record = by_attempt(c, input.envelope().attempt_id)?;
    let association:(String,Option<Vec<u8>>,String,i64)=c.query_row("SELECT kind,delegation,root_task,generation FROM application_executions WHERE attempt_id=?1",[input.envelope().attempt_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql)?;
    let binding = ai::team::settings(input)?.binding;
    if association.0 != "model"
        || association.1 != Some(codec::encode(binding.scope(), MAX_AGENT_DELEGATION_BYTES)?)
        || association.2 != binding.scope().root_task.to_string()
        || association.3 != binding.scope().lease.generation.get() as i64
    {
        return Err(corrupt());
    }
    if record.receipt.plan_id != plan.plan_id || record.receipt.input_digest != input.digest() {
        return Err(corrupt());
    }
    let s = ai::team::settings(input)?;
    if let TeamWorkBinding::HumanContinuation { work_id, .. } = s.binding {
        let (capture, receipt) =
            recovery::capture_at(c, plan.plan_id, s.binding.scope().lease.generation)?
                .ok_or_else(corrupt)?;
        if receipt.lease != s.binding.scope().lease
            || work_id != capture.preview.work.work_id
            || FixedInput::capture(capture.input)?.bytes() != input.bytes()
            || record.receipt.intent_id != work_id
            || record.author.is_some()
            || record.request.is_some()
        {
            return Err(corrupt());
        }
    }
    if record.receipt.member_id != s.binding.member_id()
        || record.receipt.role_version_id != s.binding.role_version_id()
        || record.receipt.task_id != input.envelope().task_id
        || record.receipt.attempt_id != input.envelope().attempt_id
    {
        return Err(corrupt());
    }
    if let TeamWorkBinding::Child { intent_id, .. } = s.binding {
        let target = team::target(input, input.envelope().items[0].item_id)?;
        let expected = RequestTeamWork {
            intent_id,
            recipient_member_id: record.receipt.member_id,
            target,
            kind: s.kind,
            instructions: s.instructions,
            post_ids: s.post_ids,
            cause_message_id: s.cause_message_id,
        };
        if record.receipt.intent_id != intent_id
            || record.request.as_ref() != Some(&expected)
            || record.author.is_none()
        {
            return Err(corrupt());
        }
    }
    Ok(())
}
pub(crate) fn check_input(c: &Connection, input: &FixedInput) -> Result<(), ExecutionError> {
    let plan = validate_input_basis(c, input)?;
    let s = ai::team::settings(input)?;
    control::check_scope_in(
        c,
        &agents::scope_from_binding(plan.project_id, s.binding.scope()),
    )?;
    let target = ai::item_payload(input, input.envelope().items[0].item_id)?;
    let source = super::super::content::scope(c).map_err(|_| corrupt())?;
    if source.current_snapshot != Some(target.source_snapshot_id) {
        return Err(denied());
    }
    if matches!(
        stop_reason(c, &plan)?,
        Some(
            TeamStopReason::NoProgress
                | TeamStopReason::Expired
                | TeamStopReason::NeedsReconciliation
        )
    ) {
        return Err(fail(ErrorCode::Cancelled, "team-stopped"));
    }
    // A full budget closes new admission, while its last admitted request may finish.
    Ok(())
}
pub(crate) fn check_enqueue(
    c: &Connection,
    input: &FixedInput,
    parent: Option<ExecutionId>,
) -> Result<(), ExecutionError> {
    let plan = validate_input_basis(c, input)?;
    let s = ai::team::settings(input)?;
    let stored = control::load(c, plan.plan_id)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| denied())?
        .as_secs();
    if stored.lease != s.binding.scope().lease
        || stored.state != WorkPlanState::Active
        || stored.expires_at <= now
        || parent
            != if s.binding.is_root() {
                None
            } else {
                Some(s.binding.scope().root_task)
            }
    {
        return Err(denied());
    }
    if !s.binding.is_root() {
        control::check_scope_in(
            c,
            &agents::scope_from_binding(plan.project_id, s.binding.scope()),
        )?;
    }
    Ok(())
}

pub(crate) fn validate_provider_parent_history_in(
    c: &Connection,
    input: &FixedInput,
    parent: &FixedInput,
) -> Result<(), ExecutionError> {
    let plan = validate_input_basis(c, input)?;
    let s = ai::team::settings(input)?;
    if s.binding.is_root()
        || s.binding.scope().root_task != parent.envelope().task_id
        || parent.envelope().task_id != plan.execution_input()?.task_id
        || parent.envelope().operation != ai::team::OPERATION
        || !ai::team::settings(parent)?.binding.is_root()
        || s.config.max_requests > s.root_request_limit
        || s.root_request_limit != ai::team::settings(parent)?.root_request_limit
    {
        return Err(denied());
    }
    Ok(())
}
pub(crate) fn validate_provider_parent_in(
    c: &Connection,
    input: &FixedInput,
    parent: &FixedInput,
) -> Result<(), ExecutionError> {
    validate_provider_parent_history_in(c, input, parent)?;
    check_enqueue(c, input, Some(parent.envelope().task_id))
}
pub(super) fn author_history(
    c: &Connection,
    author: &TeamMemberAuthor,
    input: &FixedInput,
) -> Result<(WorkPlan, TeamMemberRole, TeamDiscussionTarget), ExecutionError> {
    validate_model_input(c, input)?;
    let s = ai::team::settings(input)?;
    let plan = recovery::plan_in(
        c,
        s.binding.scope().lease.plan_id,
        s.binding.scope().lease.generation,
    )?;
    let role = team::load_role(c, author.role_version_id)?;
    let selected = member(&plan, author.member_id)?;
    if role.request.display_name != selected.display_name
        || role.request.role != selected.role
        || role.request.role_version_id != selected.role_version_id
    {
        return Err(corrupt());
    }
    let token: String = c
        .query_row(
            "SELECT dispatch_token FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
            params![author.attempt_id.to_string(), author.item_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if author.binding != *s.binding.scope()
        || author.member_id != s.binding.member_id()
        || author.role_version_id != s.binding.role_version_id()
        || author.attempt_id != input.envelope().attempt_id
        || token != author.dispatch_token.to_string()
        || role.request.member_id != author.member_id
        || role.config != s.config
    {
        return Err(corrupt());
    }
    Ok((plan, role, team::target(input, author.item_id)?))
}

impl ProjectStore {
    pub(crate) fn team_runtime_identity(
        &self,
        input: &FixedInput,
    ) -> Result<(ExecutionId, ExecutionId, u32, u64), ExecutionError> {
        runtime_identity(self.connection().map_err(|_| denied())?, input)
    }
    pub fn prepare_team_root(
        &self,
        lease: AutomationLease,
        authorization_action: ExecutionId,
    ) -> Result<PreparedTeamWork, ExecutionError> {
        let receipt = self
            .work_plan_receipt(authorization_action)?
            .ok_or_else(denied)?;
        if receipt.lease != lease || receipt.state != WorkPlanState::Active {
            return Err(denied());
        }
        let input = FixedInput::capture(receipt.input.ok_or_else(denied)?)?;
        let s = ai::team::settings(&input)?;
        if !s.binding.is_root() {
            return Err(denied());
        }
        let plan = self.work_plan(lease.plan_id)?;
        self.verify_work_plan(&plan)?;
        let status = self.work_plan_status(lease.plan_id)?;
        if status.lease != lease || status.state != WorkPlanState::Active {
            return Err(denied());
        }
        Ok(PreparedTeamWork {
            scope: None,
            author: None,
            request: None,
            receipt: TeamWorkReceipt {
                intent_id: authorization_action,
                plan_id: lease.plan_id,
                member_id: s.binding.member_id(),
                role_version_id: s.binding.role_version_id(),
                task_id: input.envelope().task_id,
                attempt_id: input.envelope().attempt_id,
                input_digest: input.digest().into(),
            },
            input,
            authorization_action: Some(authorization_action),
        })
    }
    pub fn prepare_team_work(
        &self,
        author: &CapturedTeamAuthor,
        request: &RequestTeamWork,
    ) -> Result<PreparedTeamWork, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        super::super::review::read_snapshot(c, |c| {
            self.check_team_work_author(author)?;
            if let Some(prior) = work(c, request.intent_id)? {
                if prior.author.as_ref() != Some(author.author())
                    || prior.request.as_ref() != Some(request)
                {
                    return Err(mismatch());
                }
                return Ok(PreparedTeamWork {
                    scope: Some(author.scope.clone()),
                    author: Some(author.author.clone()),
                    request: Some(request.clone()),
                    input: super::super::ledger::load_input(c, prior.receipt.attempt_id)?,
                    receipt: prior.receipt,
                    authorization_action: None,
                });
            }
            let plan = recovery::plan_in(
                c,
                author.author.binding.lease.plan_id,
                author.author.binding.lease.generation,
            )?;
            validate_request(c, &plan, author, request)?;
            if let Some(reason) = stop_reason(c, &plan)? {
                return Err(fail(
                    if reason == TeamStopReason::NeedsReconciliation {
                        ErrorCode::OutcomeUnknown
                    } else {
                        ErrorCode::LimitExceeded
                    },
                    "team-stopped",
                ));
            }
            let selected = member(&plan, request.recipient_member_id)?;
            let task = ExecutionId::new();
            let attempt = ExecutionId::new();
            let root_record =
                super::super::ledger::load_input(c, plan.execution_input()?.attempt_id)?;
            let root_s = ai::team::settings(&root_record)?;
            let scope = scope_for(
                &plan,
                author.author.binding.lease,
                selected,
                ExecutionId::new(),
                root_s.binding.scope().caller_id,
            );
            let binding = TeamWorkBinding::Child {
                intent_id: request.intent_id,
                member_id: selected.member_id,
                role_version_id: selected.role_version_id,
                scope,
            };
            let input = derive(
                &plan,
                &control::load(c, plan.plan_id)?.plan.fixed_input()?,
                author.author.binding.lease,
                selected.member_id,
                request.target.unit_id,
                task,
                attempt,
                binding,
                Some(request),
            )?;
            Ok(PreparedTeamWork {
                scope: Some(author.scope.clone()),
                author: Some(author.author.clone()),
                request: Some(request.clone()),
                receipt: TeamWorkReceipt {
                    intent_id: request.intent_id,
                    plan_id: plan.plan_id,
                    member_id: selected.member_id,
                    role_version_id: selected.role_version_id,
                    task_id: task,
                    attempt_id: attempt,
                    input_digest: input.digest().into(),
                },
                input,
                authorization_action: None,
            })
        })
    }
    pub fn team_work_receipt(
        &self,
        intent: ExecutionId,
    ) -> Result<Option<TeamWorkReceipt>, ExecutionError> {
        Ok(work(self.connection().map_err(|_| denied())?, intent)?.map(|r| r.receipt))
    }
    pub fn capture_team_work_author(
        &mut self,
        request: &DispatchRequest,
    ) -> Result<CapturedTeamAuthor, ExecutionError> {
        request.check_service_dispatch()?;
        let s = ai::team::settings(&request.input)?;
        let scope = WorkPlanAgentScope {
            project_id: request.input.envelope().project_id,
            lease: s.binding.scope().lease,
            parent_task: s.binding.scope().root_task,
            store_epoch: self.changes.snapshot(Revision::new(0)?).epoch,
            caller_id: s.binding.scope().caller_id,
            delegation: s.binding.scope().delegation.clone(),
        };
        self.capture_team_author(
            &scope,
            s.binding.member_id(),
            s.binding.role_version_id(),
            request.input.envelope().attempt_id,
            request.item_id,
        )
    }
    pub fn check_team_work_author(
        &self,
        author: &CapturedTeamAuthor,
    ) -> Result<(), ExecutionError> {
        self.check_work_plan_agent_scope(&author.scope)?;
        let c = self.connection().map_err(|_| denied())?;
        team::author_live(c, &author.scope, &author.author)?;
        let input = super::super::ledger::load_input(c, author.author.attempt_id)?;
        check_input(c, &input)
    }
}

fn validate_request(
    c: &Connection,
    plan: &WorkPlan,
    author: &CapturedTeamAuthor,
    request: &RequestTeamWork,
) -> Result<(), ExecutionError> {
    let selected = member(plan, request.recipient_member_id)?;
    routing_target(
        plan,
        &author.author,
        &author.target,
        request.recipient_member_id,
        &request.target,
    )?;
    if !selected.kinds.contains(&request.kind)
        || request.instructions.trim().is_empty()
        || request.instructions.len() > 8192
        || request.post_ids.len() > MAX_TEAM_REFERENCES
    {
        return Err(denied());
    }
    for id in &request.post_ids {
        let post = team::post(c, *id)?.ok_or_else(denied)?;
        if post.plan_id != plan.plan_id || post.publication.target != request.target {
            return Err(denied());
        }
    }
    if let Some(id) = request.cause_message_id {
        let message = message(c, id)?.ok_or_else(denied)?;
        if message.plan_id != plan.plan_id
            || message.recipient_member_id != author.author.member_id
            || message.sender.binding().lease != author.author.binding.lease
            || message.target != request.target
        {
            return Err(denied());
        }
    }
    Ok(())
}
fn routing_target(
    plan: &WorkPlan,
    author: &TeamMemberAuthor,
    origin: &TeamDiscussionTarget,
    recipient: ExecutionId,
    target: &TeamDiscussionTarget,
) -> Result<(), ExecutionError> {
    let sender = member(plan, author.member_id)?;
    let recipient = member(plan, recipient)?;
    if target.locale != plan.locale
        || !sender.unit_ids.contains(&target.unit_id)
        || !recipient.unit_ids.contains(&target.unit_id)
        || !recipient.unit_ids.contains(&origin.unit_id)
        || !plan.selection_basis.iter().any(|b| {
            b.unit_id == target.unit_id
                && b.source_snapshot_id == target.source_snapshot_id
                && b.source_revision_id == target.source_revision_id
        })
    {
        return Err(denied());
    }
    Ok(())
}

pub(crate) fn check_prepared(
    c: &Connection,
    prepared: &PreparedTeamWork,
) -> Result<(), ExecutionError> {
    if let Some(prior) = work(c, prepared.receipt.intent_id)? {
        if prior.receipt == prepared.receipt
            && prior.author == prepared.author
            && prior.request == prepared.request
        {
            return Ok(());
        }
        return Err(mismatch());
    }
    let plan = recovery::plan_in(
        c,
        prepared.receipt.plan_id,
        prepared
            .input
            .envelope()
            .automation
            .ok_or_else(denied)?
            .generation,
    )?;
    if let Some(author) = &prepared.author {
        let scope = prepared.scope.as_ref().ok_or_else(denied)?;
        team::author_live(c, scope, author)?;
        let captured = CapturedTeamAuthor {
            scope: scope.clone(),
            author: author.clone(),
            role: team::load_role(c, author.role_version_id)?,
            target: team::target(
                &super::super::ledger::load_input(c, author.attempt_id)?,
                author.item_id,
            )?,
        };
        validate_request(
            c,
            &plan,
            &captured,
            prepared.request.as_ref().ok_or_else(denied)?,
        )?;
    } else {
        let action = prepared.authorization_action.ok_or_else(denied)?;
        let row: (Vec<u8>, String) = c
            .query_row(
                "SELECT receipt,receipt_digest FROM application_actions WHERE action_id=?1",
                [action.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql)?;
        if codec::digest(&row.0) != row.1 {
            return Err(corrupt());
        }
        let r: WorkPlanReceipt = codec::decode(&row.0, MAX_INPUT_BYTES)?;
        if r.input.as_ref() != Some(prepared.input.envelope())
            || r.lease != prepared.input.envelope().automation.ok_or_else(denied)?
        {
            return Err(denied());
        }
    }
    if let Some(reason) = stop_reason(c, &plan)? {
        return Err(fail(
            if reason == TeamStopReason::NeedsReconciliation {
                ErrorCode::OutcomeUnknown
            } else {
                ErrorCode::LimitExceeded
            },
            "team-stopped",
        ));
    }
    Ok(())
}
pub(crate) fn record_work(
    c: &Connection,
    prepared: &PreparedTeamWork,
) -> Result<(), ExecutionError> {
    let plan = recovery::plan_in(
        c,
        prepared.receipt.plan_id,
        prepared
            .input
            .envelope()
            .automation
            .ok_or_else(denied)?
            .generation,
    )?;
    let s = ai::team::settings(prepared.input())?;
    if s.binding.is_root() {
        for m in plan
            .options
            .team_execution
            .as_ref()
            .ok_or_else(denied)?
            .members()
        {
            c.execute("INSERT INTO application_team_members(member_id,plan_id,task_id) VALUES(?1,?2,NULL)",params![m.member_id.to_string(),plan.plan_id.to_string()]).map_err(sql)?;
            let role = TeamMemberRole {
                plan_id: plan.plan_id,
                version: Revision::new(1)?,
                generation: s.binding.scope().lease.generation,
                request: TeamMemberRoleWrite {
                    member_id: m.member_id,
                    role_version_id: m.role_version_id,
                    expected_role_version_id: None,
                    display_name: m.display_name.clone(),
                    role: m.role.clone(),
                },
                config: m.config.clone(),
            };
            let bytes = codec::encode(&role, 32768)?;
            c.execute(
                "INSERT INTO application_team_roles VALUES(?1,?2,1,NULL,?3,?4)",
                params![
                    m.role_version_id.to_string(),
                    m.member_id.to_string(),
                    bytes,
                    codec::digest(&bytes)
                ],
            )
            .map_err(sql)?;
        }
    }
    let record = WorkRecord {
        receipt: prepared.receipt.clone(),
        author: prepared.author.clone(),
        request: prepared.request.clone(),
    };
    let bytes = codec::encode(&record, MAX_RECORD)?;
    let deadline: i64 = if s.binding.is_root() {
        (control::load(c, plan.plan_id)?.expires_at * 1000)
            .try_into()
            .map_err(|_| corrupt())?
    } else {
        c.query_row(
            "SELECT deadline_at_ms FROM application_team_work WHERE task_id=?1",
            [s.binding.scope().root_task.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?
    };
    c.execute("INSERT INTO application_team_work VALUES(?1,?2,(SELECT COALESCE(MAX(sequence),0)+1 FROM application_team_work WHERE plan_id=?2),?3,?4,?5,?6,?7,?8,?9)",params![record.receipt.intent_id.to_string(),plan.plan_id.to_string(),record.receipt.member_id.to_string(),record.receipt.role_version_id.to_string(),record.receipt.task_id.to_string(),record.receipt.attempt_id.to_string(),bytes,codec::digest(&bytes),deadline]).map_err(sql)?;
    Ok(())
}

fn message(c: &Connection, id: ExecutionId) -> Result<Option<TeamMessage>, ExecutionError> {
    let row:Option<(Vec<u8>,String,String,i64,String)>=c.query_row("SELECT record,digest,plan_id,sequence,recipient FROM application_team_messages WHERE message_id=?1",[id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(sql)?;
    row.map(|r| {
        let value: TeamMessage = codec::decode(&r.0, MAX_MESSAGE_RECORD)?;
        if codec::digest(&r.0) != r.1
            || value.message_id != id
            || value.plan_id.to_string() != r.2
            || value.sequence.get() != u64::try_from(r.3).map_err(|_| corrupt())?
            || value.recipient_member_id.to_string() != r.4
        {
            return Err(corrupt());
        }
        Ok(value)
    })
    .transpose()
}

fn check_message_content(
    c: &Connection,
    plan: &WorkPlan,
    target: &TeamDiscussionTarget,
    body: &str,
    post_ids: &[ExecutionId],
) -> Result<(), ExecutionError> {
    if body.trim().is_empty()
        || body.len() > TeamMessageLimits::current_team().max_body_bytes as usize
        || post_ids.len() > MAX_TEAM_REFERENCES
    {
        return Err(denied());
    }
    for id in post_ids {
        let post = team::post(c, *id)?.ok_or_else(denied)?;
        if post.plan_id != plan.plan_id || post.publication.target != *target {
            return Err(denied());
        }
    }
    Ok(())
}

fn check_message_cause(
    c: &Connection,
    author: &TeamMemberAuthor,
    target: &TeamDiscussionTarget,
    cause: Option<ExecutionId>,
    before: Option<Revision>,
) -> Result<(), ExecutionError> {
    if let Some(id) = cause {
        let prior = message(c, id)?.ok_or_else(denied)?;
        if prior.plan_id != author.binding.lease.plan_id
            || prior.target != *target
            || prior.recipient_member_id != author.member_id
            || prior.sender.binding().lease != author.binding.lease
            || before.is_some_and(|sequence| prior.sequence >= sequence)
        {
            return Err(denied());
        }
    }
    Ok(())
}

/// Validate immutable provenance without asking whether the old grant is live.
fn message_history(c: &Connection, value: &TeamMessage) -> Result<(), ExecutionError> {
    let binding = value.sender.binding();
    let plan = recovery::plan_in(c, value.plan_id, binding.lease.generation)?;
    if binding.lease.plan_id != plan.plan_id
        || plan.options.team_discussions.is_none()
        || !control::load(c, plan.plan_id)?
            .effects
            .contains(&AutomationEffect::SendTeamMessage)
    {
        return Err(corrupt());
    }
    let recipient = member(&plan, value.recipient_member_id)?;
    if recipient.role_version_id != value.recipient_role_version_id {
        return Err(corrupt());
    }
    match &value.sender {
        TeamDiscussionAuthor::Member { author } => {
            let input = super::super::ledger::load_input(c, author.attempt_id)?;
            author_history(c, author, &input)?;
            routing_target(
                &plan,
                author,
                &team::target(&input, author.item_id)?,
                value.recipient_member_id,
                &value.target,
            )?;
            check_message_cause(
                c,
                author,
                &value.target,
                value.cause_message_id,
                Some(value.sequence),
            )?;
        }
        TeamDiscussionAuthor::Human { actor, binding } => {
            team::human_author_history(c, &plan, actor, binding)?;
            team::check_target(
                &plan,
                &agents::scope_from_binding(plan.project_id, binding),
                &value.target,
            )?;
            if !recipient.unit_ids.contains(&value.target.unit_id)
                || !value.post_ids.is_empty()
                || value.cause_message_id.is_some()
            {
                return Err(corrupt());
            }
        }
    }
    check_message_content(c, &plan, &value.target, &value.body, &value.post_ids)
}

fn human_message_action_in(
    c: &Connection,
    project: ExecutionId,
    lease: &AutomationLease,
    actor: &str,
    write: &SendHumanTeamMessage,
) -> Result<Option<TeamMessage>, ExecutionError> {
    if actor.trim().is_empty() || actor.len() > 128 || lease.generation.get() == 0 {
        return Err(fail(ErrorCode::InvalidInput, "team-human-message"));
    }
    team::historical_plan(c, project, lease.plan_id)?;
    let Some(prior) = message(c, write.message_id)? else {
        return Ok(None);
    };
    if prior.plan_id != lease.plan_id
        || !matches!(&prior.sender, TeamDiscussionAuthor::Human { actor: saved, binding }
            if saved == actor && binding.lease == *lease && binding.delegation.is_none())
        || prior.recipient_member_id != write.recipient_member_id
        || prior.recipient_role_version_id != write.expected_recipient_role_version_id
        || prior.target != write.target
        || prior.body != write.body
        || !prior.post_ids.is_empty()
        || prior.cause_message_id.is_some()
    {
        return Err(mismatch());
    }
    message_history(c, &prior)?;
    Ok(Some(prior))
}

fn record_message(
    c: &Connection,
    plan: &WorkPlan,
    sender: TeamDiscussionAuthor,
    write: &SendTeamMessage,
) -> Result<TeamMessage, ExecutionError> {
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM application_team_messages WHERE plan_id=?1",
            [plan.plan_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let count = u64::try_from(count).map_err(|_| corrupt())?;
    if count >= u64::from(TeamMessageLimits::current_team().max_messages) {
        return Err(fail(ErrorCode::LimitExceeded, "team-messages"));
    }
    let value = TeamMessage {
        message_id: write.message_id,
        sequence: Revision::new(count + 1)?,
        plan_id: plan.plan_id,
        sender,
        recipient_member_id: write.recipient_member_id,
        recipient_role_version_id: member(plan, write.recipient_member_id)?.role_version_id,
        target: write.target.clone(),
        body: write.body.clone(),
        post_ids: write.post_ids.clone(),
        cause_message_id: write.cause_message_id,
    };
    let bytes = codec::encode(&value, MAX_MESSAGE_RECORD)?;
    c.execute(
        "INSERT INTO application_team_messages VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            value.message_id.to_string(),
            plan.plan_id.to_string(),
            value.sequence.get() as i64,
            value.recipient_member_id.to_string(),
            bytes,
            codec::digest(&bytes)
        ],
    )
    .map_err(sql)?;
    Ok(value)
}
impl ProjectStore {
    /// Confirm the exact original human message without reopening execution authority.
    pub fn read_human_team_message_action(
        &self,
        project: ExecutionId,
        lease: &AutomationLease,
        actor: &str,
        write: &SendHumanTeamMessage,
    ) -> Result<Option<TeamMessage>, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        super::super::review::read_snapshot(c, |c| {
            human_message_action_in(c, project, lease, actor, write)
        })
    }

    /// Trusted human entry point; member tool arguments cannot select this author.
    pub fn send_human_team_message(
        &mut self,
        scope: &WorkPlanAgentScope,
        actor: &str,
        write: &SendHumanTeamMessage,
    ) -> Result<TeamMessage, ExecutionError> {
        if scope.delegation.is_some() {
            return Err(denied());
        }
        if let Some(prior) =
            self.read_human_team_message_action(scope.project_id, &scope.lease, actor, write)?
        {
            return Ok(prior);
        }
        let tx = self.execution_write()?;
        // Another connection may have accepted the original identity before this transaction.
        if let Some(prior) =
            human_message_action_in(&tx, scope.project_id, &scope.lease, actor, write)?
        {
            super::super::ledger::commit(tx)?;
            return Ok(prior);
        }
        self.check_work_plan_agent_scope(scope)?;
        let plan = team::live_plan(&tx, scope)?;
        let stored = control::load(&tx, plan.plan_id)?;
        let recipient = member(&plan, write.recipient_member_id)?;
        if !stored.effects.contains(&AutomationEffect::SendTeamMessage)
            || recipient.role_version_id != write.expected_recipient_role_version_id
            || !recipient.unit_ids.contains(&write.target.unit_id)
        {
            return Err(denied());
        }
        if let Some(
            reason @ (TeamStopReason::NoProgress
            | TeamStopReason::Expired
            | TeamStopReason::NeedsReconciliation
            | TeamStopReason::BudgetExhausted),
        ) = stop_reason(&tx, &plan)?
        {
            return Err(fail(
                ErrorCode::Cancelled,
                match reason {
                    TeamStopReason::BudgetExhausted => "team-guidance-budget-exhausted",
                    _ => "team-stopped",
                },
            ));
        }
        team::check_target(&plan, scope, &write.target)?;
        check_message_content(&tx, &plan, &write.target, &write.body, &[])?;
        let value = record_message(
            &tx,
            &plan,
            TeamDiscussionAuthor::Human {
                actor: actor.into(),
                binding: scope.execution_binding(),
            },
            &SendTeamMessage {
                message_id: write.message_id,
                recipient_member_id: write.recipient_member_id,
                target: write.target.clone(),
                body: write.body.clone(),
                post_ids: vec![],
                cause_message_id: None,
            },
        )?;
        super::super::ledger::commit(tx)?;
        Ok(value)
    }

    pub fn send_team_message(
        &mut self,
        author: &CapturedTeamAuthor,
        write: &SendTeamMessage,
    ) -> Result<TeamMessage, ExecutionError> {
        let tx = self.execution_write()?;
        self.check_team_work_author(author)?;
        let plan = recovery::plan_in(
            &tx,
            author.author.binding.lease.plan_id,
            author.author.binding.lease.generation,
        )?;
        routing_target(
            &plan,
            &author.author,
            &author.target,
            write.recipient_member_id,
            &write.target,
        )?;
        check_message_content(&tx, &plan, &write.target, &write.body, &write.post_ids)?;
        check_message_cause(
            &tx,
            &author.author,
            &write.target,
            write.cause_message_id,
            None,
        )?;
        if let Some(prior) = message(&tx, write.message_id)? {
            if prior.sender
                == (TeamDiscussionAuthor::Member {
                    author: author.author.clone(),
                })
                && prior.recipient_member_id == write.recipient_member_id
                && prior.target == write.target
                && prior.body == write.body
                && prior.post_ids == write.post_ids
                && prior.cause_message_id == write.cause_message_id
            {
                super::super::ledger::commit(tx)?;
                return Ok(prior);
            }
            return Err(mismatch());
        }
        let value = record_message(
            &tx,
            &plan,
            TeamDiscussionAuthor::Member {
                author: author.author.clone(),
            },
            write,
        )?;
        super::super::ledger::commit(tx)?;
        Ok(value)
    }
    pub fn capture_team_work_view(
        &self,
        author: &CapturedTeamAuthor,
    ) -> Result<CapturedTeamWorkView, ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        super::super::review::read_snapshot(c, |c| {
            self.check_team_work_author(author)?;
            let record = by_attempt(c, author.author.attempt_id)?;
            let discussion = self.capture_team_discussion_view(author)?.view().clone();
            let mut query=c.prepare("SELECT message_id FROM application_team_messages m WHERE plan_id=?1 AND recipient=?2 AND NOT EXISTS(SELECT 1 FROM application_team_consumptions x WHERE x.message_id=m.message_id) ORDER BY sequence LIMIT 256").map_err(sql)?;
            let mut messages = Vec::new();
            for id in query
                .query_map(
                    params![
                        record.receipt.plan_id.to_string(),
                        author.author.member_id.to_string()
                    ],
                    |r| r.get::<_, String>(0),
                )
                .map_err(sql)?
            {
                let value =
                    message(c, ExecutionId::parse(&id.map_err(sql)?)?)?.ok_or_else(corrupt)?;
                if value.target == author.target
                    && value.sender.binding().lease == author.author.binding.lease
                {
                    message_history(c, &value)?;
                    messages.push(value);
                }
            }
            if messages.len() > TeamMessageLimits::current_team().max_request_messages as usize {
                return Err(fail(ErrorCode::LimitExceeded, "team-request-material"));
            }
            let view = TeamWorkRequestView {
                kind: TeamWorkViewKind::UntrustedTeamWork,
                view_id: ExecutionId::new(),
                work: record.receipt,
                author: author.author.clone(),
                discussion,
                messages,
                recipients: recipients(&recovery::plan_in(
                    c,
                    author.author.binding.lease.plan_id,
                    author.author.binding.lease.generation,
                )?)?,
            };
            let bytes = codec::encode(
                &view,
                TeamMessageLimits::current_team().max_request_bytes as usize,
            )?;
            let utf8 = String::from_utf8(bytes).map_err(|_| corrupt())?;
            Ok(CapturedTeamWorkView { view, utf8 })
        })
    }
}

pub(crate) fn validate_provider_view_history_in(
    c: &Connection,
    input: &FixedInput,
    item_id: ExecutionId,
    view: Option<&TeamWorkRequestView>,
) -> Result<(), ExecutionError> {
    if input.envelope().operation != ai::team::OPERATION {
        return if view.is_none() {
            Ok(())
        } else {
            Err(denied())
        };
    }
    let view = view.ok_or_else(denied)?;
    validate_model_input(c, input)?;
    let record = by_attempt(c, input.envelope().attempt_id)?;
    if view.work != record.receipt
        || view.author.attempt_id != input.envelope().attempt_id
        || view.author.item_id != item_id
        || view.author.member_id != record.receipt.member_id
        || view.discussion.author != view.author
    {
        return Err(corrupt());
    }
    if view.recipients
        != recipients(&recovery::plan_in(
            c,
            record.receipt.plan_id,
            view.author.binding.lease.generation,
        )?)?
    {
        return Err(corrupt());
    }
    team::author_history(c, &view.author)?;
    team::validate_team_provider_view_history_in(c, input, item_id, Some(&view.discussion))?;
    for value in &view.messages {
        if message(c, value.message_id)?.as_ref() != Some(value)
            || value.plan_id != record.receipt.plan_id
            || value.recipient_member_id != view.author.member_id
            || value.recipient_role_version_id != view.author.role_version_id
            || value.sender.binding().lease != view.author.binding.lease
            || value.target != view.discussion.target
        {
            return Err(corrupt());
        }
        message_history(c, value)?;
    }
    Ok(())
}
pub(crate) fn validate_provider_view_in(
    c: &Connection,
    request: &DispatchRequest,
    view: Option<&TeamWorkRequestView>,
) -> Result<(), ExecutionError> {
    validate_provider_view_history_in(c, &request.input, request.item_id, view)?;
    if let Some(view) = view {
        if view.author.dispatch_token != request.dispatch_token {
            return Err(denied());
        }
        check_input(c, &request.input)?;
        team::author_live(
            c,
            &agents::scope_from_binding(request.input.envelope().project_id, &view.author.binding),
            &view.author,
        )?;
    }
    Ok(())
}
pub(crate) fn record_consumptions_in(
    c: &Connection,
    request: &DispatchRequest,
    request_id: ExecutionId,
    view: &TeamWorkRequestView,
) -> Result<(), ExecutionError> {
    validate_provider_view_in(c, request, Some(view))?;
    for message in &view.messages {
        c.execute(
            "INSERT OR IGNORE INTO application_team_consumptions VALUES(?1,?2,?3)",
            params![
                message.message_id.to_string(),
                request.input.envelope().task_id.to_string(),
                request_id.to_string()
            ],
        )
        .map_err(sql)?;
    }
    Ok(())
}

/// Cumulative work admissions and valid completions share the work ledger owner.
pub(super) fn counts(c: &Connection, plan: ExecutionId) -> Result<(u32, u32), ExecutionError> {
    c.query_row(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN i.execution='succeeded' AND i.validation='valid' THEN 1 ELSE 0 END),0) FROM application_team_work w JOIN execution_items i USING(attempt_id) WHERE w.plan_id=?1",
        [plan.to_string()], |r| Ok((r.get(0)?,r.get(1)?)),
    ).map_err(sql)
}

fn stop_reason(c: &Connection, plan: &WorkPlan) -> Result<Option<TeamStopReason>, ExecutionError> {
    let policy = plan.options.team_execution.as_ref().ok_or_else(denied)?;
    let (n, unconfirmed) = counts(c, plan.plan_id)?;
    let mut unknown=c.prepare("SELECT w.attempt_id FROM application_team_work w JOIN execution_items i USING(attempt_id) WHERE w.plan_id=?1 AND i.execution='unknown'").map_err(sql)?;
    for id in unknown
        .query_map([plan.plan_id.to_string()], |r| r.get::<_, String>(0))
        .map_err(sql)?
    {
        if !recovery::acknowledged_unknown(c, plan.plan_id, ExecutionId::parse(&id.map_err(sql)?)?)?
        {
            return Ok(Some(TeamStopReason::NeedsReconciliation));
        }
    }

    let deadline: Option<i64> = c
        .query_row(
            "SELECT MIN(deadline_at_ms) FROM application_team_work WHERE plan_id=?1",
            [plan.plan_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let deadline = deadline
        .map(u64::try_from)
        .transpose()
        .map_err(|_| corrupt())?;
    if deadline.is_some_and(|d| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(true, |now| now.as_millis() >= d.into())
    }) {
        return Ok(Some(TeamStopReason::Expired));
    }
    if super::super::ledger::provider::provider_budget_in(c, plan.execution_input()?.task_id)?
        .is_some_and(|budget| budget.dispatched.saturating_add(budget.legacy_held) >= budget.limit)
    {
        return Ok(Some(TeamStopReason::BudgetExhausted));
    }
    if unconfirmed >= policy.limits().max_no_progress {
        return Ok(Some(TeamStopReason::NoProgress));
    }
    if n >= policy.limits().max_activations {
        return Ok(Some(TeamStopReason::ActivationLimit));
    }
    Ok(None)
}

fn recipients(plan: &WorkPlan) -> Result<Vec<TeamWorkRecipient>, ExecutionError> {
    Ok(plan
        .options
        .team_execution
        .as_ref()
        .ok_or_else(denied)?
        .members()
        .iter()
        .map(|m| TeamWorkRecipient {
            member_id: m.member_id,
            display_name: m.display_name.clone(),
            role: m.role.clone(),
            unit_ids: m.unit_ids.clone(),
            kinds: m.kinds.clone(),
        })
        .collect())
}

pub(crate) fn validate_result(
    c: &Connection,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    let value = ai::team::validate_output(input, result)?;
    let s = ai::team::settings(input)?;
    let target = team::target(input, result.envelope().item_id)?;
    let author = TeamMemberAuthor {
        member_id: s.binding.member_id(),
        role_version_id: s.binding.role_version_id(),
        attempt_id: input.envelope().attempt_id,
        item_id: result.envelope().item_id,
        dispatch_token: result.envelope().dispatch_token,
        binding: s.binding.scope().clone(),
    };
    author_history(c, &author, input)?;
    let check_post = |id: ExecutionId, own: bool| -> Result<TeamDiscussionPost, ExecutionError> {
        let post = team::post(c, id)?.ok_or_else(denied)?;
        if post.plan_id != s.binding.scope().lease.plan_id
            || post.publication.target != target
            || own
                && post.author
                    != (TeamDiscussionAuthor::Member {
                        author: author.clone(),
                    })
        {
            return Err(denied());
        }
        Ok(post)
    };
    match value.outcome {
        TeamWorkOutcome::Translation { .. } => {}
        TeamWorkOutcome::Review {
            reviewed, post_ids, ..
        } => {
            for id in post_ids {
                check_post(id, true)?;
            }
            match reviewed {
                TeamReviewBasis::Post { post_id } => {
                    check_post(post_id, false)?;
                }
                TeamReviewBasis::Artifact { reference } => {
                    let plan = recovery::plan_in(
                        c,
                        s.binding.scope().lease.plan_id,
                        s.binding.scope().lease.generation,
                    )?;
                    team::check_references(c, &plan, &target, &[reference])?;
                }
            }
        }
        TeamWorkOutcome::Evidence { post_ids } => {
            for id in post_ids {
                if check_post(id, true)?.publication.references.is_empty() {
                    return Err(denied());
                }
            }
        }
        TeamWorkOutcome::Waiting {
            requested_intent_ids,
        } => {
            let mut seen = std::collections::BTreeSet::new();
            for id in requested_intent_ids {
                let record = work(c, id)?.ok_or_else(denied)?;
                if !seen.insert(id) || record.author.as_ref() != Some(&author) {
                    return Err(denied());
                }
            }
        }
    }
    Ok(())
}

impl ProjectStore {
    pub fn read_team_execution(
        &self,
        request: &ReadTeamExecution,
    ) -> Result<TeamExecutionView, ExecutionError> {
        if !(1..=MAX_TEAM_PAGE).contains(&request.limit) {
            return Err(fail(ErrorCode::InvalidInput, "team-page"));
        }
        let c = self.connection().map_err(|_| denied())?;
        super::super::review::read_snapshot(c, |c| {
            let status = control::load(c, request.plan_id)?;
            let plan = recovery::plan_in(c, request.plan_id, status.lease.generation)?;
            if plan.project_id != request.project_id
                || self
                    .metadata()
                    .map_err(|_| corrupt())?
                    .project_id()
                    .to_string()
                    != request.project_id.to_string()
            {
                return Err(denied());
            }
            let policy = plan.options.team_execution.as_ref().ok_or_else(denied)?;
            let mut members = Vec::new();
            for m in policy.members() {
                let exists: bool = c
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM application_team_roles WHERE version_id=?1)",
                        [m.role_version_id.to_string()],
                        |r| r.get(0),
                    )
                    .map_err(sql)?;
                if exists {
                    members.push(team::load_role(c, m.role_version_id)?);
                }
            }
            let mut q=c.prepare("SELECT intent_id,sequence FROM application_team_work WHERE plan_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3").map_err(sql)?;
            let ids = q
                .query_map(
                    params![
                        plan.plan_id.to_string(),
                        request.after_work.map_or(0, |r| r.get()) as i64,
                        request.limit + 1
                    ],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                )
                .map_err(sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql)?;
            let more = ids.len() > request.limit as usize;
            let mut works = Vec::new();
            for (id, sequence) in ids.into_iter().take(request.limit as usize) {
                let record = work(c, ExecutionId::parse(&id)?)?.ok_or_else(corrupt)?;
                let input = super::super::ledger::load_input(c, record.receipt.attempt_id)?;
                let (state,validation,result):(String,String,Option<String>)=c.query_row("SELECT execution,validation,current_result_id FROM execution_items WHERE attempt_id=?1",[record.receipt.attempt_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
                let execution: ExecutionState =
                    serde_json::from_value(serde_json::Value::String(state))
                        .map_err(|_| corrupt())?;
                let validation: ValidationState =
                    serde_json::from_value(serde_json::Value::String(validation))
                        .map_err(|_| corrupt())?;
                let output = if execution == ExecutionState::Succeeded
                    && validation == ValidationState::Valid
                {
                    let result = super::super::ledger::load_result(
                        c,
                        &input,
                        ExecutionId::parse(&result.ok_or_else(corrupt)?)?,
                    )?;
                    Some(ai::team::validate_output(&input, &result)?)
                } else {
                    None
                };
                let candidate_revision_id = if output
                    .as_ref()
                    .is_some_and(|o| matches!(o.outcome, TeamWorkOutcome::Translation { .. }))
                {
                    self.saved_ai_candidate(
                        record.receipt.attempt_id,
                        input.envelope().items[0].item_id,
                    )?
                } else {
                    None
                };
                let binding = ai::team::settings(&input)?.binding;
                let origin = if let TeamWorkBinding::HumanContinuation { .. } = binding {
                    let (capture, receipt) =
                        recovery::capture_at(c, plan.plan_id, binding.scope().lease.generation)?
                            .ok_or_else(corrupt)?;
                    TeamWorkOrigin::HumanContinuation {
                        action_id: receipt.action_id,
                        work: capture.preview.work,
                    }
                } else if record.author.is_some() {
                    TeamWorkOrigin::Member {}
                } else {
                    TeamWorkOrigin::Start {
                        action_id: record.receipt.intent_id,
                    }
                };
                works.push(TeamWorkView {
                    origin,
                    candidate_revision_id,
                    sequence: Revision::new(u64::try_from(sequence).map_err(|_| corrupt())?)?,
                    target: team::target(&input, input.envelope().items[0].item_id)?,
                    receipt: record.receipt,
                    author: record.author,
                    request: record.request,
                    execution,
                    validation,
                    output,
                });
            }
            let next_work_after = more.then(|| works.last().unwrap().sequence);
            let mut q=c.prepare("SELECT message_id FROM application_team_messages WHERE plan_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3").map_err(sql)?;
            let ids = q
                .query_map(
                    params![
                        plan.plan_id.to_string(),
                        request.after_message.map_or(0, |r| r.get()) as i64,
                        request.limit + 1
                    ],
                    |r| r.get::<_, String>(0),
                )
                .map_err(sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql)?;
            let more = ids.len() > request.limit as usize;
            let mut messages = Vec::new();
            let mut consumptions = Vec::new();
            for id in ids.into_iter().take(request.limit as usize) {
                let value = message(c, ExecutionId::parse(&id)?)?.ok_or_else(corrupt)?;
                message_history(c, &value)?;
                let row:Option<(String,String)>=c.query_row("SELECT task_id,request_id FROM application_team_consumptions WHERE message_id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
                if let Some((task, request)) = row {
                    consumptions.push(TeamMessageConsumption {
                        message_id: value.message_id,
                        task_id: ExecutionId::parse(&task)?,
                        provider_request_id: ExecutionId::parse(&request)?,
                    });
                }
                messages.push(value);
            }
            let next_message_after = more.then(|| messages.last().unwrap().sequence);
            let mut role_ids = std::collections::BTreeSet::new();
            for work in &works {
                role_ids.insert(work.receipt.role_version_id);
                if let Some(author) = &work.author {
                    role_ids.insert(author.role_version_id);
                }
            }
            for message in &messages {
                if let TeamDiscussionAuthor::Member { author } = &message.sender {
                    role_ids.insert(author.role_version_id);
                }
                role_ids.insert(message.recipient_role_version_id);
            }
            let role_versions = role_ids
                .into_iter()
                .map(|id| team::load_role(c, id))
                .collect::<Result<Vec<_>, _>>()?;
            let value = TeamExecutionView {
                message_limits: TeamMessageLimits::current_team(),
                effective_version: recovery::effective_version(
                    c,
                    plan.plan_id,
                    status.lease.generation,
                )?,
                roster: policy.members().to_vec(),
                retired_member_ids: recovery::retired(c, &plan)?,
                role_versions,
                plan_id: plan.plan_id,
                members,
                works,
                messages,
                consumptions,
                budget: self.provider_budget(plan.execution_input()?.task_id)?,
                stop_reason: stop_reason(c, &plan)?,
                next_work_after,
                next_message_after,
            };
            codec::encode(&value, MAX_TEAM_PAGE_BYTES)?;
            Ok(value)
        })
    }
}

pub(crate) fn runtime_identity(
    c: &Connection,
    input: &FixedInput,
) -> Result<(ExecutionId, ExecutionId, u32, u64), ExecutionError> {
    let s = ai::team::settings(input)?;
    let plan = recovery::plan_in(
        c,
        s.binding.scope().lease.plan_id,
        s.binding.scope().lease.generation,
    )?;
    let deadline: i64 = c
        .query_row(
            "SELECT MIN(deadline_at_ms) FROM application_team_work WHERE plan_id=?1",
            [plan.plan_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let deadline = u64::try_from(deadline).map_err(|_| corrupt())?;
    Ok((
        plan.plan_id,
        s.binding.member_id(),
        plan.options
            .team_execution
            .as_ref()
            .ok_or_else(denied)?
            .limits()
            .max_concurrency,
        deadline,
    ))
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
    let mut q=c.prepare("SELECT intent_id,plan_id,sequence,deadline_at_ms FROM application_team_work ORDER BY plan_id,sequence").map_err(sql)?;
    let mut last: Option<(String, u64, u64)> = None;
    for row in q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(sql)?
    {
        let (id, plan_id, seq, deadline) = row.map_err(sql)?;
        let seq = u64::try_from(seq).map_err(|_| corrupt())?;
        let deadline = u64::try_from(deadline).map_err(|_| corrupt())?;
        let record = work(c, ExecutionId::parse(&id)?)?.ok_or_else(corrupt)?;
        if record.receipt.plan_id.to_string() != plan_id
            || last
                .as_ref()
                .filter(|l| l.0 == plan_id)
                .map_or(seq != 1, |l| seq != l.1 + 1 || deadline != l.2)
        {
            return Err(corrupt());
        }
        let input = super::super::ledger::load_input(c, record.receipt.attempt_id)?;
        validate_model_input(c, &input)?;
        let s = ai::team::settings(&input)?;
        if s.binding.member_id() != record.receipt.member_id
            || s.binding.role_version_id() != record.receipt.role_version_id
        {
            return Err(corrupt());
        }
        if let Some(author) = &record.author {
            let author_input = super::super::ledger::load_input(c, author.attempt_id)?;
            author_history(c, author, &author_input)?;
            let target = team::target(&author_input, author.item_id)?;
            let request = record.request.as_ref().ok_or_else(corrupt)?;
            routing_target(
                &recovery::plan_in(c, record.receipt.plan_id, author.binding.lease.generation)?,
                author,
                &target,
                request.recipient_member_id,
                &request.target,
            )?;
        } else if record.request.is_some()
            || !(s.binding.is_root()
                || matches!(s.binding, TeamWorkBinding::HumanContinuation { .. }))
        {
            return Err(corrupt());
        }
        let (result, validation): (Option<String>, String) = c
            .query_row(
                "SELECT current_result_id,validation FROM execution_items WHERE attempt_id=?1",
                [record.receipt.attempt_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql)?;
        if let Some(id) = result {
            let result = super::super::ledger::load_result(c, &input, ExecutionId::parse(&id)?)?;
            if result.envelope().outcome == ExecutionState::Succeeded && validation == "valid" {
                validate_result(c, &input, &result)?;
            }
        }
        last = Some((plan_id, seq, deadline));
    }
    let mut q = c
        .prepare("SELECT message_id FROM application_team_messages ORDER BY plan_id,sequence")
        .map_err(sql)?;
    for id in q.query_map([], |r| r.get::<_, String>(0)).map_err(sql)? {
        let value = message(c, ExecutionId::parse(&id.map_err(sql)?)?)?.ok_or_else(corrupt)?;
        message_history(c, &value)?;
    }
    let mut q=c.prepare("SELECT x.message_id,x.task_id,x.request_id,p.capture FROM application_team_consumptions x JOIN execution_provider_requests p ON p.request_id=x.request_id").map_err(sql)?;
    for row in q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(sql)?
    {
        let (id, task, request, bytes) = row.map_err(sql)?;
        let value = message(c, ExecutionId::parse(&id)?)?.ok_or_else(corrupt)?;
        let capture: ai::provider::ProviderRequestCapture = codec::decode(&bytes, 131072)?;
        let view = capture.team_work_view.ok_or_else(corrupt)?;
        if view.work.task_id.to_string()!=task || !view.messages.contains(&value) || !c.query_row("SELECT EXISTS(SELECT 1 FROM execution_provider_requests WHERE request_id=?1 AND task_id=?2)",params![request,task],|r|r.get::<_,bool>(0)).map_err(sql)? {return Err(corrupt());}
    }
    Ok(())
}

#[cfg(test)]
mod tests;
