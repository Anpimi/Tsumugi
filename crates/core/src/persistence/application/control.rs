//! Durable authority is checked inside the existing execution transaction.
use super::super::ledger;
use super::*;
use crate::{
    application::*,
    execution::{FixedInput, InputEnvelope, MAX_INPUT_BYTES, Revision, codec},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

const TABLES: &[(&str, &str)] = &[
    super::services::TABLE,
    (
        "application_plans",
        "CREATE TABLE application_plans (plan_id TEXT PRIMARY KEY NOT NULL, plan BLOB NOT NULL CHECK(length(plan) BETWEEN 1 AND 1048576), digest TEXT NOT NULL CHECK(length(digest)=64), generation INTEGER NOT NULL CHECK(generation>0), state TEXT NOT NULL CHECK(state IN ('active','paused','stopped','taken-over')), effects BLOB NOT NULL CHECK(length(effects) BETWEEN 1 AND 1024), expires_at INTEGER NOT NULL CHECK(expires_at>0), cancellation_revision INTEGER NOT NULL CHECK(cancellation_revision>=0))",
    ),
    (
        "application_actions",
        "CREATE TABLE application_actions (action_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_plans(plan_id), request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 1048576), request_digest TEXT NOT NULL CHECK(length(request_digest)=64), receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 1048576), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64))",
    ),
    (
        "application_executions",
        "CREATE TABLE application_executions (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_attempts(attempt_id), plan_id TEXT NOT NULL REFERENCES application_plans(plan_id), generation INTEGER NOT NULL CHECK(generation>0), kind TEXT NOT NULL CHECK(kind IN ('model','tool')), delegation BLOB CHECK(delegation IS NULL OR length(delegation) BETWEEN 1 AND 4096), root_task TEXT NOT NULL REFERENCES execution_tasks(task_id), CHECK((kind='model' AND delegation IS NULL) OR (kind='tool' AND delegation IS NOT NULL)))",
    ),
    (
        "application_protections",
        "CREATE TABLE application_protections (unit_id TEXT NOT NULL REFERENCES source_units(unit_id), locale TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), protected INTEGER NOT NULL CHECK(protected IN (0,1)), PRIMARY KEY(unit_id,locale))",
    ),
    (
        "application_protection_actions",
        "CREATE TABLE application_protection_actions (action_id TEXT PRIMARY KEY NOT NULL, request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 1048576), digest TEXT NOT NULL CHECK(length(digest)=64), receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 1048576), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64))",
    ),
    (
        "application_selection_actions",
        "CREATE TABLE application_selection_actions (action_id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_plans(plan_id), revision_id TEXT NOT NULL REFERENCES translation_revisions(revision_id), selection_id TEXT REFERENCES translation_selections(event_id), request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 1048576), request_digest TEXT NOT NULL CHECK(length(request_digest)=64), receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 1048576), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64))",
    ),
];
pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        c.execute_batch(sql)?;
    }
    Ok(())
}
pub(in crate::persistence) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| name.to_string())
}
fn err(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    err(ErrorCode::StorageFailed, "work-plan-storage")
}
pub(super) fn now() -> Result<u64, ExecutionError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-clock"))
}
fn expiry(value: u64) -> Result<(), ExecutionError> {
    let current = now()?;
    if value <= current || value > current.saturating_add(86_400) || value > i64::MAX as u64 {
        return Err(err(ErrorCode::InvalidInput, "work-plan-expiry"));
    }
    Ok(())
}
fn encode_state(state: WorkPlanState) -> &'static str {
    match state {
        WorkPlanState::Active => "active",
        WorkPlanState::Paused => "paused",
        WorkPlanState::Stopped => "stopped",
        WorkPlanState::TakenOver => "taken-over",
    }
}
fn decode_state(state: &str) -> Result<WorkPlanState, ExecutionError> {
    match state {
        "active" => Ok(WorkPlanState::Active),
        "paused" => Ok(WorkPlanState::Paused),
        "stopped" => Ok(WorkPlanState::Stopped),
        "taken-over" => Ok(WorkPlanState::TakenOver),
        _ => Err(err(ErrorCode::CorruptLedger, "work-plan-state")),
    }
}
pub(super) struct StoredPlan {
    pub(super) plan: WorkPlan,
    pub(super) lease: AutomationLease,
    pub(super) state: WorkPlanState,
    pub(super) expires_at: u64,
    pub(super) effects: Vec<AutomationEffect>,
    cancellation_revision: Revision,
}
pub(super) fn load(c: &Connection, id: ExecutionId) -> Result<StoredPlan, ExecutionError> {
    let (bytes, digest, generation, state, effects, expires, cancellation): (Vec<u8>, String, i64, String, Vec<u8>, i64, i64) =
        c.query_row("SELECT plan,digest,generation,state,effects,expires_at,cancellation_revision FROM application_plans WHERE plan_id=?1", [id.to_string()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).map_err(sql)?;
    let plan: WorkPlan = codec::decode(&bytes, MAX_INPUT_BYTES)?;
    plan.validate()?;
    let effects: Vec<AutomationEffect> = codec::decode(&effects, 1024)?;
    if plan.plan_id != id
        || plan.digest != digest
        || generation <= 0
        || expires <= 0
        || cancellation < 0
        || plan.authorization_effects().ok().as_ref() != Some(&effects)
    {
        return Err(err(ErrorCode::CorruptLedger, "work-plan-authority"));
    }
    if cancellation as u64
        > super::super::ledger::cancel_revision(c, plan.execution_input()?.task_id)?.get()
    {
        return Err(err(
            ErrorCode::CorruptLedger,
            "work-plan-cancellation-baseline",
        ));
    }
    Ok(StoredPlan {
        plan,
        lease: AutomationLease {
            plan_id: id,
            generation: Revision::new(generation as u64)?,
        },
        state: decode_state(&state)?,
        expires_at: expires as u64,
        effects,
        cancellation_revision: Revision::new(cancellation as u64)?,
    })
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Authorize {
        plan_id: ExecutionId,
        request: AuthorizeWorkPlan,
    },
    Control {
        request: ControlWorkPlan,
    },
}
impl Request {
    fn action(&self) -> ExecutionId {
        match self {
            Self::Authorize { request, .. } => request.action_id,
            Self::Control { request } => request.action_id,
        }
    }
    fn plan(&self) -> ExecutionId {
        match self {
            Self::Authorize { plan_id, .. } => *plan_id,
            Self::Control { request } => request.plan_id,
        }
    }
}
fn existing(c: &Connection, request: &Request) -> Result<Option<WorkPlanReceipt>, ExecutionError> {
    let row: Option<(Vec<u8>, String, Vec<u8>, String)> = c.query_row(
        "SELECT request,request_digest,receipt,receipt_digest FROM application_actions WHERE action_id=?1", [request.action().to_string()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
    let Some((old, digest, bytes, receipt_digest)) = row else {
        return Ok(None);
    };
    let expected = codec::encode(request, MAX_INPUT_BYTES)?;
    if old != expected || digest != codec::digest(&expected) {
        return Err(err(ErrorCode::ResultMismatch, "work-plan-action"));
    }
    if receipt_digest != codec::digest(&bytes) {
        return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt"));
    }
    let receipt: WorkPlanReceipt = codec::decode(&bytes, MAX_INPUT_BYTES)?;
    if receipt.action_id != request.action() || receipt.lease.plan_id != request.plan() {
        return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt"));
    }
    Ok(Some(receipt))
}
fn save(
    c: &Connection,
    request: &Request,
    receipt: &WorkPlanReceipt,
) -> Result<(), ExecutionError> {
    let req = codec::encode(request, MAX_INPUT_BYTES)?;
    let bytes = codec::encode(receipt, MAX_INPUT_BYTES)?;
    c.execute(
        "INSERT INTO application_actions VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            request.action().to_string(),
            request.plan().to_string(),
            req,
            codec::digest(&req),
            bytes,
            codec::digest(&bytes)
        ],
    )
    .map_err(sql)?;
    Ok(())
}
fn active(c: &Connection, input: &FixedInput) -> Result<Option<StoredPlan>, ExecutionError> {
    let Some(lease) = input.envelope().automation else {
        return Ok(None);
    };
    let stored = load(c, lease.plan_id)?;
    if lease != stored.lease || stored.state != WorkPlanState::Active || stored.expires_at <= now()?
    {
        return Err(err(ErrorCode::Cancelled, "work-plan-control"));
    }
    super::maintenance::check_protection(c, &stored.plan)?;
    Ok(Some(stored))
}
/// Only a renewed grant can acknowledge cancellation of its original budget
/// owner. Cancellation of a child, or a later root cancellation, stays binding.
pub(in crate::persistence) fn allows_cancelled_ancestor(
    c: &Connection,
    input: &FixedInput,
    task: ExecutionId,
) -> Result<bool, ExecutionError> {
    let revision = super::super::ledger::cancel_revision(c, task)?;
    if revision.get() == 0 {
        return Ok(true);
    }
    let Some(stored) = active(c, input)? else {
        return Ok(false);
    };
    Ok(task == stored.plan.execution_input()?.task_id && revision <= stored.cancellation_revision)
}
/// Generic cancellation of an automated root also revokes its plan in the
/// same ledger transaction. A new adoption identity cannot bypass the stop.
pub(in crate::persistence) fn stop_execution_plan_in(
    c: &Connection,
    task: ExecutionId,
    action_id: ExecutionId,
) -> Result<bool, ExecutionError> {
    let id: Option<String> = c.query_row(
        "SELECT p.plan_id FROM application_executions p JOIN execution_attempts a USING(attempt_id) WHERE a.task_id=?1 LIMIT 1",
        [task.to_string()], |r| r.get(0),
    ).optional().map_err(sql)?;
    let Some(id) = id else {
        return Ok(false);
    };
    let stored = load(c, ExecutionId::parse(&id)?)?;
    if task != stored.plan.execution_input()?.task_id || stored.state == WorkPlanState::Stopped {
        return Ok(false);
    }
    let control = ControlWorkPlan {
        action_id,
        plan_id: stored.plan.plan_id,
        expected_generation: stored.lease.generation,
        command: WorkPlanCommand::Stop,
        confirmed: false,
        expires_at: None,
    };
    let request = Request::Control { request: control };
    if existing(c, &request)?.is_some() {
        return Ok(false);
    }
    let lease = AutomationLease {
        plan_id: stored.plan.plan_id,
        generation: stored.lease.generation.next()?,
    };
    c.execute(
        "UPDATE application_plans SET generation=?2,state='stopped' WHERE plan_id=?1",
        params![lease.plan_id.to_string(), lease.generation.get() as i64],
    )
    .map_err(sql)?;
    c.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic='work-plan-control' WHERE execution='queued' AND attempt_id IN (SELECT attempt_id FROM application_executions WHERE plan_id=?1 AND generation<?2)",
        params![lease.plan_id.to_string(), lease.generation.get() as i64]).map_err(sql)?;
    save(
        c,
        &request,
        &WorkPlanReceipt {
            cancellation_revision: stored.cancellation_revision,
            action_id,
            lease,
            state: WorkPlanState::Stopped,
            input: None,
            parent_task: None,
        },
    )?;
    Ok(true)
}
fn matches_scope(input: &InputEnvelope, root: &InputEnvelope) -> bool {
    input.project_id == root.project_id
        && input.operation == root.operation
        && input.capability_id == root.capability_id
        && input.capability_version == root.capability_version
        && input.settings == root.settings
        && input.limits == root.limits
        && input.previous_attempt_id.is_none()
        && input.reused_results.is_empty()
        && !input.items.is_empty()
        && input.items.iter().all(|item| {
            root.items.iter().any(|allowed| {
                item.scope == allowed.scope
                    && item.payload == allowed.payload
                    && item.dependencies == allowed.dependencies
            })
        })
}
fn latest_input(c: &Connection, task: ExecutionId) -> Result<FixedInput, ExecutionError> {
    let (attempt, stored) = c.query_row(&format!(
        "SELECT a.attempt_id,{} FROM execution_attempts a WHERE a.task_id=?1 ORDER BY a.sequence DESC LIMIT 1",
        ledger::input_columns_sql()), [task.to_string()], |r| Ok((r.get::<_, String>(0)?, ledger::StoredInputRow::from_row(r, 1)?))).map_err(sql)?;
    stored.restore(
        ExecutionId::parse(&attempt)
            .map_err(|_| err(ErrorCode::CorruptLedger, "work-plan-parent"))?,
    )
}
pub(in crate::persistence) fn check_enqueue(
    c: &Connection,
    input: &FixedInput,
    parent: Option<ExecutionId>,
) -> Result<(), ExecutionError> {
    let stored = active(c, input)?;
    if let Some(parent) = parent {
        let parent_input = latest_input(c, parent)?;
        if let Some(parent_lease) = parent_input.envelope().automation {
            if input.envelope().automation.map(|l| l.plan_id) != Some(parent_lease.plan_id) {
                return Err(err(ErrorCode::Unauthorized, "work-plan-parent"));
            }
        } else if stored.is_some() {
            return Err(err(ErrorCode::Unauthorized, "work-plan-parent"));
        }
    }
    let Some(stored) = stored else { return Ok(()) };
    if !matches_scope(input.envelope(), stored.plan.execution_input()?) {
        return Err(err(ErrorCode::Unauthorized, "work-plan-scope"));
    }
    if let Some(parent) = parent {
        let ancestor: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM execution_budget_ancestry WHERE task_id=?1 AND ancestor_id=?2)",
            params![parent.to_string(), stored.plan.execution_input()?.task_id.to_string()], |r|r.get(0)).map_err(sql)?;
        if !ancestor || input.envelope().task_id == stored.plan.execution_input()?.task_id {
            return Err(err(ErrorCode::Unauthorized, "work-plan-budget-owner"));
        }
        // A new generation may start only at the original budget anchor. An old
        // child cannot silently create another branch after a human stop.
        if parent != stored.plan.execution_input()?.task_id {
            if latest_input(c, parent)?.envelope().automation != Some(stored.lease) {
                return Err(err(ErrorCode::Cancelled, "work-plan-parent-generation"));
            }
        }
    } else {
        let mut expected = stored.plan.execution_input()?.clone();
        expected.automation = input.envelope().automation;
        if input.envelope() != &expected {
            return Err(err(ErrorCode::Unauthorized, "work-plan-root"));
        }
    }
    Ok(())
}
pub(in crate::persistence) fn record_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    if let Some(lease) = input.envelope().automation {
        c.execute(
            "INSERT INTO application_executions VALUES (?1,?2,?3,'model',NULL,?4)",
            params![
                input.envelope().attempt_id.to_string(),
                lease.plan_id.to_string(),
                lease.generation.get() as i64,
                load(c, lease.plan_id)?
                    .plan
                    .execution_input()?
                    .task_id
                    .to_string()
            ],
        )
        .map_err(sql)?;
    }
    Ok(())
}
pub(in crate::persistence) fn check_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    if let Some(lease) = input.envelope().automation {
        super::maintenance::check_protection(c, &load(c, lease.plan_id)?.plan)?;
    }
    if input.envelope().plugin.is_some() && input.envelope().automation.is_some() {
        let bytes: Option<Vec<u8>> = c
            .query_row(
                "SELECT delegation FROM application_executions WHERE attempt_id=?1 AND kind='tool'",
                [input.envelope().attempt_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        let bytes =
            bytes.ok_or_else(|| err(ErrorCode::Unauthorized, "work-plan-tool-association"))?;
        let delegation: WorkPlanToolDelegation = codec::decode(&bytes, 4096)?;
        return super::tools::check_tool_delegation(c, input, &delegation);
    }
    let association: Option<(String, i64)> = c
        .query_row(
            "SELECT plan_id,generation FROM application_executions WHERE attempt_id=?1",
            [input.envelope().attempt_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    match (input.envelope().automation, association) {
        (None, None) => Ok(()),
        (Some(lease), Some((id, generation)))
            if id == lease.plan_id.to_string() && generation == lease.generation.get() as i64 =>
        {
            let stored = active(c, input)?.unwrap();
            if !matches_scope(input.envelope(), stored.plan.execution_input()?)
                || !stored.effects.contains(&AutomationEffect::SaveCandidate)
            {
                return Err(err(ErrorCode::Unauthorized, "work-plan-scope"));
            }
            Ok(())
        }
        _ => Err(err(ErrorCode::CorruptLedger, "work-plan-execution")),
    }
}
pub(super) fn protection(
    c: &Connection,
    unit: ExecutionId,
    locale: &str,
) -> Result<WorkProtection, ExecutionError> {
    let row: Option<(i64, bool)> = c
        .query_row(
            "SELECT revision,protected FROM application_protections WHERE unit_id=?1 AND locale=?2",
            params![unit.to_string(), locale],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    let (revision, protected) = row.unwrap_or((0, false));
    Ok(WorkProtection {
        unit_id: unit,
        locale: locale.into(),
        revision: Revision::new(revision as u64)?,
        protected,
    })
}
pub(in crate::persistence) fn protect_manual_in(
    c: &Connection,
    unit: ExecutionId,
    locale: &str,
) -> Result<(), ExecutionError> {
    let next = protection(c, unit, locale)?.revision.next()?;
    c.execute("INSERT INTO application_protections VALUES (?1,?2,?3,1) ON CONFLICT(unit_id,locale) DO UPDATE SET revision=excluded.revision,protected=1",params![unit.to_string(),locale,next.get() as i64]).map_err(sql)?;
    Ok(())
}
impl ProjectStore {
    pub fn work_protection(
        &self,
        unit: ExecutionId,
        locale: &str,
    ) -> Result<WorkProtection, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-protection-read"))?;
        let parsed = crate::Locale::parse(locale)
            .map_err(|_| err(ErrorCode::InvalidInput, "work-protection-locale"))?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM source_units u JOIN project_metadata p ON u.project_id=p.project_id WHERE u.unit_id=?1)", [unit.to_string()], |r| r.get(0)).map_err(sql)?;
        if parsed.as_str() != locale || !exists {
            return Err(err(ErrorCode::Unauthorized, "work-protection-scope"));
        }
        protection(c, unit, locale)
    }
    pub fn set_work_protection(
        &mut self,
        request: &SetWorkProtection,
    ) -> Result<WorkProtection, ExecutionError> {
        let mut tx = self.execution_write()?;
        let bytes = codec::encode(request, MAX_INPUT_BYTES)?;
        let old: Option<(Vec<u8>,String,Vec<u8>,String)>=tx.query_row("SELECT request,digest,receipt,receipt_digest FROM application_protection_actions WHERE action_id=?1",[request.action_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
        if let Some((saved, digest, receipt, receipt_digest)) = old {
            if saved != bytes || digest != codec::digest(&bytes) {
                return Err(err(ErrorCode::ResultMismatch, "work-protection-action"));
            }
            if receipt_digest != codec::digest(&receipt) {
                return Err(err(ErrorCode::CorruptLedger, "work-protection-receipt"));
            }
            return codec::decode(&receipt, MAX_INPUT_BYTES);
        }
        if !request.protected && !request.confirmed_release {
            return Err(err(ErrorCode::Unauthorized, "work-protection-release"));
        }
        super::super::translation::check_protection_basis(&tx, request)?;
        let current = protection(&tx, request.unit_id, &request.locale)?;
        if current.revision != request.expected_revision {
            return Err(err(
                ErrorCode::DependencyConflict,
                "work-protection-revision",
            ));
        }
        let receipt = WorkProtection {
            unit_id: request.unit_id,
            locale: request.locale.clone(),
            revision: current.revision.next()?,
            protected: request.protected,
        };
        tx.execute("INSERT INTO application_protections VALUES (?1,?2,?3,?4) ON CONFLICT(unit_id,locale) DO UPDATE SET revision=excluded.revision,protected=excluded.protected",params![request.unit_id.to_string(),request.locale,receipt.revision.get() as i64,receipt.protected]).map_err(sql)?;
        let result = codec::encode(&receipt, MAX_INPUT_BYTES)?;
        tx.execute(
            "INSERT INTO application_protection_actions VALUES (?1,?2,?3,?4,?5)",
            params![
                request.action_id.to_string(),
                bytes,
                codec::digest(&bytes),
                result,
                codec::digest(&result)
            ],
        )
        .map_err(sql)?;
        tx.observer
            .add_scope(super::super::ChangeScope::Translation);
        super::super::ledger::commit(tx)?;
        Ok(receipt)
    }
}
impl ProjectStore {
    /// Open a bounded application handle only after the original task's durable
    /// budget exists. This reads authority; it cannot issue or renew a grant.
    pub fn work_plan_agent_scope(
        &self,
        lease: AutomationLease,
    ) -> Result<WorkPlanAgentScope, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        super::super::review::read_snapshot(c, |_| {
            let stored = load(c, lease.plan_id)?;
            let root = stored.plan.execution_input()?;
            let scope = WorkPlanAgentScope {
                project_id: root.project_id,
                lease,
                parent_task: root.task_id,
                store_epoch: self.changes.snapshot(Revision::new(0)?).epoch,
                caller_id: ExecutionId::new(),
            };
            self.check_work_plan_agent_scope(&scope)?;
            Ok(scope)
        })
    }

    pub fn check_work_plan_agent_scope(
        &self,
        scope: &WorkPlanAgentScope,
    ) -> Result<(), ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        if scope.store_epoch != self.changes.snapshot(Revision::new(0)?).epoch {
            return Err(err(ErrorCode::Unauthorized, "work-plan-agent-session"));
        }
        let stored = load(c, scope.lease.plan_id)?;
        if stored.lease != scope.lease
            || stored.state != WorkPlanState::Active
            || stored.expires_at <= now()?
        {
            return Err(err(ErrorCode::Cancelled, "work-plan-control"));
        }
        let root = stored.plan.execution_input()?;
        if root.project_id != scope.project_id
            || root.task_id != scope.parent_task
            || !stored.effects.contains(&AutomationEffect::SaveCandidate)
        {
            return Err(err(ErrorCode::Unauthorized, "work-plan-agent-scope"));
        }
        let registered: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM execution_budgets WHERE task_id=?1)",
                [scope.parent_task.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if !registered {
            return Err(err(ErrorCode::Unauthorized, "work-plan-budget-owner"));
        }
        Ok(())
    }

    /// Derive exact child bytes in one read snapshot. The caller selects only
    /// captured units; original configuration, sharing, evidence and limits stay
    /// fixed. Enqueue and HTTP dispatch still check the durable control lease.
    pub fn prepare_work_plan_agent_generation(
        &self,
        scope: &WorkPlanAgentScope,
        request: &AgentGenerationRequest,
    ) -> Result<FixedInput, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        super::super::review::read_snapshot(c, |_| {
            self.check_work_plan_agent_scope(scope)?;
            let stored = load(c, scope.lease.plan_id)?;
            let input = derive_agent_generation(&stored.plan, scope, request)?;
            self.verify_work_plan(&stored.plan)?;
            check_enqueue(c, &input, Some(scope.parent_task))?;
            Ok(input)
        })
    }

    pub fn check_work_plan_input(&self, input: &FixedInput) -> Result<(), ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        check_input(c, input)?;
        super::services::check_input(c, input, &self.plugin_authority)
    }
    pub fn work_plan(&self, plan_id: ExecutionId) -> Result<WorkPlan, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        Ok(load(c, plan_id)?.plan)
    }
    pub fn work_plan_receipt(
        &self,
        action_id: ExecutionId,
    ) -> Result<Option<WorkPlanReceipt>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        let row: Option<(Vec<u8>, String)> = c
            .query_row(
                "SELECT receipt,receipt_digest FROM application_actions WHERE action_id=?1",
                [action_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        row.map(|(bytes, digest)| {
            if codec::digest(&bytes) != digest {
                return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt"));
            }
            let receipt: WorkPlanReceipt = codec::decode(&bytes, MAX_INPUT_BYTES)?;
            if receipt.action_id != action_id {
                return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt"));
            }
            Ok(receipt)
        })
        .transpose()
    }
    /// Pause grants before closing their session. Continuing requires renewed
    /// consent; no budget reservation or exposure is changed here.
    pub fn pause_active_work_plans(&mut self) -> Result<(), ExecutionError> {
        let plans = {
            let c = self
                .connection()
                .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
            let mut statement = c
                .prepare("SELECT plan_id,generation FROM application_plans WHERE state='active'")
                .map_err(sql)?;
            statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql)?
        };
        for (id, generation) in plans {
            self.control_work_plan(&ControlWorkPlan {
                action_id: ExecutionId::new(),
                plan_id: ExecutionId::parse(&id)?,
                expected_generation: Revision::new(generation as u64)?,
                command: WorkPlanCommand::Pause,
                confirmed: false,
                expires_at: None,
            })?;
        }
        Ok(())
    }
    pub fn work_plan_status(&self, plan_id: ExecutionId) -> Result<WorkPlanStatus, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        let stored = load(c, plan_id)?;
        Ok(WorkPlanStatus {
            cancellation_revision: stored.cancellation_revision,
            lease: stored.lease,
            state: stored.state,
            effects: stored.effects,
            expires_at: stored.expires_at,
        })
    }
    pub fn authorize_work_plan(
        &mut self,
        plan: &WorkPlan,
        authorization: &AuthorizeWorkPlan,
    ) -> Result<WorkPlanReceipt, ExecutionError> {
        plan.validate()?;
        if authorization.plan_digest != plan.digest {
            return Err(err(ErrorCode::ResultMismatch, "work-plan-digest"));
        }
        let request = Request::Authorize {
            plan_id: plan.plan_id,
            request: authorization.clone(),
        };
        let mut tx = self.execution_write()?;
        if let Some(receipt) = existing(&tx, &request)? {
            return Ok(receipt);
        }
        if !authorization.confirmed
            || authorization.plan_digest != plan.digest
            || plan.authorization_effects().ok().as_ref() != Some(&authorization.effects)
        {
            return Err(err(ErrorCode::Unauthorized, "work-plan-consent"));
        }
        expiry(authorization.expires_at)?;
        self.verify_work_plan(plan)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM application_plans WHERE plan_id=?1)",
                [plan.plan_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if exists {
            return Err(err(ErrorCode::ResultMismatch, "work-plan-identity"));
        }
        let bytes = codec::encode(plan, MAX_INPUT_BYTES)?;
        let effects = codec::encode(&authorization.effects, 1024)?;
        tx.execute(
            "INSERT INTO application_plans VALUES (?1,?2,?3,1,'active',?4,?5,0)",
            params![
                plan.plan_id.to_string(),
                bytes,
                plan.digest,
                effects,
                authorization.expires_at as i64
            ],
        )
        .map_err(sql)?;
        let lease = AutomationLease {
            plan_id: plan.plan_id,
            generation: Revision::new(1)?,
        };
        let mut input = plan.execution_input()?.clone();
        input.automation = Some(lease);
        let receipt = WorkPlanReceipt {
            cancellation_revision: Revision::new(0)?,
            action_id: authorization.action_id,
            lease,
            state: WorkPlanState::Active,
            input: Some(input),
            parent_task: None,
        };
        save(&tx, &request, &receipt)?;
        tx.observer.add_scope(super::super::ChangeScope::Project);
        super::super::ledger::commit(tx)?;
        Ok(receipt)
    }
    pub fn control_work_plan(
        &mut self,
        control: &ControlWorkPlan,
    ) -> Result<WorkPlanReceipt, ExecutionError> {
        let request = Request::Control {
            request: control.clone(),
        };
        let authority = self.plugin_authority.clone();
        let mut tx = self.execution_write()?;
        if let Some(receipt) = existing(&tx, &request)? {
            return Ok(receipt);
        }
        let stored = load(&tx, control.plan_id)?;
        if stored.lease.generation != control.expected_generation {
            return Err(err(ErrorCode::DependencyConflict, "work-plan-generation"));
        }
        let state = match control.command {
            WorkPlanCommand::Pause => WorkPlanState::Paused,
            WorkPlanCommand::Stop => WorkPlanState::Stopped,
            WorkPlanCommand::TakeOver => WorkPlanState::TakenOver,
            WorkPlanCommand::Continue => WorkPlanState::Active,
        };
        let mut expires = stored.expires_at;
        let mut cancellation_revision = stored.cancellation_revision;
        let lease = AutomationLease {
            plan_id: control.plan_id,
            generation: stored.lease.generation.next()?,
        };
        let (input, parent_task) = if control.command == WorkPlanCommand::Continue {
            if !control.confirmed || stored.state == WorkPlanState::Active {
                return Err(err(ErrorCode::Unauthorized, "work-plan-continue-consent"));
            }
            expires = control
                .expires_at
                .ok_or_else(|| err(ErrorCode::InvalidInput, "work-plan-expiry"))?;
            expiry(expires)?;
            self.verify_work_plan(&stored.plan)?;
            cancellation_revision =
                super::super::ledger::cancel_revision(&tx, stored.plan.execution_input()?.task_id)?;
            let anchor: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_budgets WHERE task_id=?1)",
                    [stored.plan.execution_input()?.task_id.to_string()],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            let mut input = stored.plan.execution_input()?.clone();
            input.automation = Some(lease);
            let parent = if anchor {
                input.task_id = ExecutionId::new();
                input.attempt_id = ExecutionId::new();
                Some(stored.plan.execution_input()?.task_id)
            } else {
                None
            };
            (Some(input), parent)
        } else {
            if control.expires_at.is_some() {
                return Err(err(ErrorCode::InvalidInput, "work-plan-control-expiry"));
            }
            (None, None)
        };
        tx.execute(
            "UPDATE application_plans SET generation=?2,state=?3,expires_at=?4,cancellation_revision=?5 WHERE plan_id=?1",
            params![
                control.plan_id.to_string(),
                lease.generation.get() as i64,
                encode_state(state),
                expires as i64,
                cancellation_revision.get() as i64
            ],
        )
        .map_err(sql)?;
        revoke_tools_in(&tx, &authority, control.plan_id, lease.generation)?;
        tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic='work-plan-control' WHERE execution='queued' AND attempt_id IN (SELECT attempt_id FROM application_executions WHERE plan_id=?1 AND generation<?2)",params![control.plan_id.to_string(),lease.generation.get() as i64]).map_err(sql)?;
        let receipt = WorkPlanReceipt {
            cancellation_revision,
            action_id: control.action_id,
            lease,
            state,
            input,
            parent_task,
        };
        save(&tx, &request, &receipt)?;
        tx.observer.add_scope(super::super::ChangeScope::Project);
        super::super::ledger::commit(tx)?;
        Ok(receipt)
    }
}
fn validate_receipt(
    request: &Request,
    receipt: &WorkPlanReceipt,
    stored: &StoredPlan,
) -> Result<(), ExecutionError> {
    let valid = match request {
        Request::Authorize { request, .. } => {
            request.confirmed
                && request.plan_digest == stored.plan.digest
                && request.effects == stored.effects
                && request.expires_at > 0
                && request.expires_at <= i64::MAX as u64
                && receipt.cancellation_revision.get() == 0
                && receipt.lease.generation.get() == 1
                && receipt.state == WorkPlanState::Active
                && receipt.input.is_some()
                && receipt.parent_task.is_none()
        }
        Request::Control { request } => {
            let state = match request.command {
                WorkPlanCommand::Pause => WorkPlanState::Paused,
                WorkPlanCommand::Stop => WorkPlanState::Stopped,
                WorkPlanCommand::TakeOver => WorkPlanState::TakenOver,
                WorkPlanCommand::Continue => WorkPlanState::Active,
            };
            receipt.lease.generation == request.expected_generation.next()?
                && receipt.state == state
                && if request.command == WorkPlanCommand::Continue {
                    request.confirmed
                        && request
                            .expires_at
                            .is_some_and(|value| value > 0 && value <= i64::MAX as u64)
                        && receipt.input.is_some()
                } else {
                    request.expires_at.is_none()
                        && receipt.input.is_none()
                        && receipt.parent_task.is_none()
                }
        }
    };
    if !valid {
        return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt-authority"));
    }
    if let Some(input) = &receipt.input {
        let fixed = FixedInput::capture(input.clone())?;
        if fixed.envelope() != input
            || input.automation != Some(receipt.lease)
            || !matches_scope(input, stored.plan.execution_input()?)
        {
            return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt-input"));
        }
        if let Some(parent) = receipt.parent_task {
            if parent != stored.plan.execution_input()?.task_id
                || input.task_id == parent
                || input.attempt_id == stored.plan.execution_input()?.attempt_id
            {
                return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt-parent"));
            }
        } else {
            let mut expected = stored.plan.execution_input()?.clone();
            expected.automation = Some(receipt.lease);
            if input != &expected {
                return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt-root"));
            }
        }
    }
    Ok(())
}
fn validate_history(c: &Connection, stored: &StoredPlan) -> Result<(), ExecutionError> {
    let mut statement = c
        .prepare("SELECT request,receipt FROM application_actions WHERE plan_id=?1")
        .map_err(sql)?;
    let mut history = std::collections::BTreeMap::new();
    for row in statement
        .query_map([stored.plan.plan_id.to_string()], |r| {
            Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .map_err(sql)?
    {
        let (request, receipt) = row.map_err(sql)?;
        let request: Request = codec::decode(&request, MAX_INPUT_BYTES)?;
        let receipt: WorkPlanReceipt = codec::decode(&receipt, MAX_INPUT_BYTES)?;
        validate_receipt(&request, &receipt, stored)?;
        if history
            .insert(receipt.lease.generation.get(), (request, receipt))
            .is_some()
        {
            return Err(err(
                ErrorCode::CorruptLedger,
                "work-plan-generation-history",
            ));
        }
    }
    let mut previous_state = None;
    let mut expires = 0;
    let mut cancellation = Revision::new(0)?;
    let mut expected = 1;
    for (generation, (request, receipt)) in &history {
        if *generation != expected {
            return Err(err(
                ErrorCode::CorruptLedger,
                "work-plan-generation-history",
            ));
        }
        match request {
            Request::Authorize { request, .. } if *generation == 1 => {
                expires = request.expires_at;
            }
            Request::Control { request } if *generation > 1 => {
                if request.command == WorkPlanCommand::Continue {
                    if previous_state == Some(WorkPlanState::Active) {
                        return Err(err(
                            ErrorCode::CorruptLedger,
                            "work-plan-generation-history",
                        ));
                    }
                    if receipt.cancellation_revision < cancellation {
                        return Err(err(
                            ErrorCode::CorruptLedger,
                            "work-plan-cancellation-history",
                        ));
                    }
                    cancellation = receipt.cancellation_revision;
                    expires = request.expires_at.unwrap();
                }
            }
            _ => {
                return Err(err(
                    ErrorCode::CorruptLedger,
                    "work-plan-generation-history",
                ));
            }
        }
        if receipt.cancellation_revision != cancellation {
            return Err(err(
                ErrorCode::CorruptLedger,
                "work-plan-cancellation-history",
            ));
        }
        previous_state = Some(receipt.state);
        expected += 1;
    }
    if expected - 1 != stored.lease.generation.get()
        || previous_state != Some(stored.state)
        || expires != stored.expires_at
        || cancellation != stored.cancellation_revision
    {
        return Err(err(ErrorCode::CorruptLedger, "work-plan-current-authority"));
    }
    Ok(())
}
pub(in crate::persistence) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    for (name, expected) in TABLES {
        let actual: String = c
            .query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })
            .map_err(sql)?;
        if actual != *expected {
            return Err(err(ErrorCode::CorruptLedger, "work-plan-schema"));
        }
    }
    let mut plans = c
        .prepare("SELECT plan_id FROM application_plans")
        .map_err(sql)?;
    for row in plans
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql)?
    {
        let stored = load(c, ExecutionId::parse(&row.map_err(sql)?)?)?;
        let project = super::super::read_metadata_from(c)
            .map_err(|_| err(ErrorCode::CorruptLedger, "work-plan-project"))?;
        if stored.plan.project_id.to_string() != project.project_id().to_string() {
            return Err(err(ErrorCode::CorruptLedger, "work-plan-project"));
        }
        validate_history(c, &stored)?;
    }
    let mut actions = c.prepare("SELECT action_id,plan_id,request,request_digest,receipt,receipt_digest FROM application_actions").map_err(sql)?;
    for row in actions
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Vec<u8>>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(sql)?
    {
        let (id, plan, request, digest, bytes, receipt_digest) = row.map_err(sql)?;
        let request: Request = codec::decode(&request, MAX_INPUT_BYTES)?;
        let receipt: WorkPlanReceipt = codec::decode(&bytes, MAX_INPUT_BYTES)?;
        if request.action().to_string() != id
            || request.plan().to_string() != plan
            || digest != codec::digest(&codec::encode(&request, MAX_INPUT_BYTES)?)
            || receipt_digest != codec::digest(&bytes)
            || receipt.action_id != request.action()
            || receipt.lease.plan_id != request.plan()
            || receipt.lease.generation.get() == 0
            || receipt.lease.generation > load(c, request.plan())?.lease.generation
        {
            return Err(err(ErrorCode::CorruptLedger, "work-plan-receipt"));
        }
        validate_receipt(&request, &receipt, &load(c, request.plan())?)?;
    }
    let mut attempts=c.prepare(&format!("SELECT a.attempt_id,x.plan_id,x.generation,{} FROM execution_attempts a LEFT JOIN application_executions x USING(attempt_id)", ledger::input_columns_sql())).map_err(sql)?;
    for row in attempts
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                ledger::StoredInputRow::from_row(r, 3)?,
            ))
        })
        .map_err(sql)?
    {
        let (attempt, plan, generation, stored_input) = row.map_err(sql)?;
        let input = stored_input.restore(
            ExecutionId::parse(&attempt)
                .map_err(|_| err(ErrorCode::CorruptLedger, "work-plan-execution"))?,
        )?;
        match (input.envelope().automation, plan, generation) {
            (None, None, None) => {}
            (Some(lease), Some(id), Some(generation))
                if lease.plan_id.to_string() == id
                    && lease.generation.get() as i64 == generation =>
            {
                let stored = load(c, lease.plan_id)?;
                let (kind, delegation, root): (String, Option<Vec<u8>>, String) = c.query_row("SELECT kind,delegation,root_task FROM application_executions WHERE attempt_id=?1", [&attempt], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(sql)?;
                let valid_scope = if kind == "tool" {
                    let bytes = delegation.ok_or_else(|| {
                        err(ErrorCode::CorruptLedger, "work-plan-tool-association")
                    })?;
                    let delegation: WorkPlanToolDelegation = codec::decode(&bytes, 4096)?;
                    super::tools::validate_tool_input(c, &input, &delegation)?;
                    true
                } else {
                    kind == "model"
                        && delegation.is_none()
                        && matches_scope(input.envelope(), stored.plan.execution_input()?)
                };
                if generation == 0
                    || generation as u64 > stored.lease.generation.get()
                    || root != stored.plan.execution_input()?.task_id.to_string()
                    || !valid_scope
                {
                    return Err(err(ErrorCode::CorruptLedger, "work-plan-execution"));
                }
            }
            _ => return Err(err(ErrorCode::CorruptLedger, "work-plan-execution")),
        }
    }
    let mut unreconciled_releases = std::collections::BTreeSet::new();
    let mut protections = c
        .prepare("SELECT unit_id,locale,revision,protected FROM application_protections")
        .map_err(sql)?;
    for row in protections
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })
        .map_err(sql)?
    {
        let (unit, locale, revision, protected) = row.map_err(sql)?;
        ExecutionId::parse(&unit)?;
        crate::Locale::parse(&locale)
            .map_err(|_| err(ErrorCode::CorruptLedger, "work-protection-locale"))?;
        if revision <= 0 {
            return Err(err(ErrorCode::CorruptLedger, "work-protection-revision"));
        }
        if !protected {
            unreconciled_releases.insert((unit, locale, revision as u64));
        }
    }
    let mut actions=c.prepare("SELECT action_id,request,digest,receipt,receipt_digest FROM application_protection_actions").map_err(sql)?;
    for row in actions
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(sql)?
    {
        let (id, bytes, digest, result, result_digest) = row.map_err(sql)?;
        let request: SetWorkProtection = codec::decode(&bytes, MAX_INPUT_BYTES)?;
        let receipt: WorkProtection = codec::decode(&result, MAX_INPUT_BYTES)?;
        let current = protection(c, request.unit_id, &request.locale)?;
        let project = super::super::read_metadata_from(c)
            .map_err(|_| err(ErrorCode::CorruptLedger, "work-protection-project"))?;
        if request.action_id.to_string() != id
            || request.project_id.to_string() != project.project_id().to_string()
            || digest != codec::digest(&bytes)
            || result_digest != codec::digest(&result)
            || request.unit_id != receipt.unit_id
            || request.locale != receipt.locale
            || request.protected != receipt.protected
            || receipt.revision != request.expected_revision.next()?
            || receipt.revision > current.revision
            || (receipt.revision == current.revision && receipt.protected != current.protected)
            || (!request.protected && !request.confirmed_release)
        {
            return Err(err(ErrorCode::CorruptLedger, "work-protection-receipt"));
        }
        if !receipt.protected {
            unreconciled_releases.remove(&(
                receipt.unit_id.to_string(),
                receipt.locale,
                receipt.revision.get(),
            ));
        }
    }
    if !unreconciled_releases.is_empty() {
        return Err(err(
            ErrorCode::CorruptLedger,
            "work-protection-release-evidence",
        ));
    }
    super::selection::validate(c)?;
    super::services::validate(c)?;
    Ok(())
}

fn revoke_tools_in(
    c: &Connection,
    authority: &crate::execution::plugin_authority::PluginAuthority,
    plan: ExecutionId,
    generation: Revision,
) -> Result<(), ExecutionError> {
    let mut statement = c.prepare("SELECT a.task_id FROM application_executions x JOIN execution_attempts a USING(attempt_id) WHERE x.plan_id=?1 AND x.kind='tool' AND x.generation<?2").map_err(sql)?;
    let tasks = statement
        .query_map(params![plan.to_string(), generation.get() as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    for task in tasks {
        authority.revoke_task(ExecutionId::parse(&task)?)?;
    }
    c.execute("UPDATE plugin_execution_grants SET revoked=1 WHERE attempt_id IN (SELECT attempt_id FROM application_executions WHERE plan_id=?1 AND kind='tool' AND generation<?2)", params![plan.to_string(), generation.get() as i64]).map_err(sql)?;
    Ok(())
}

pub(super) fn derive_agent_generation(
    plan: &WorkPlan,
    scope: &WorkPlanAgentScope,
    request: &AgentGenerationRequest,
) -> Result<FixedInput, ExecutionError> {
    let original = plan.fixed_input()?;
    if request.unit_ids.len() > tsumugi_plugin_sdk::MAX_GENERATION_SERVICE_UNITS {
        return Err(err(ErrorCode::LimitExceeded, "work-plan-agent-items"));
    }
    let selected = request
        .unit_ids
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if selected.is_empty()
        || selected.len() != request.unit_ids.len()
        || selected.len() > original.envelope().items.len()
        || request.task_id == scope.parent_task
        || request.attempt_id == original.envelope().attempt_id
        || selected
            .iter()
            .any(|id| !plan.selection_basis.iter().any(|b| b.unit_id == *id))
    {
        return Err(err(ErrorCode::Unauthorized, "work-plan-agent-scope"));
    }
    let mut envelope = original.envelope().clone();
    envelope.task_id = request.task_id;
    envelope.attempt_id = request.attempt_id;
    envelope.automation = Some(scope.lease);
    let scopes = selected
        .iter()
        .map(ToString::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    envelope
        .items
        .retain(|item| scopes.contains(&item.scope.id));
    let item_ids = envelope
        .items
        .iter()
        .map(|item| item.item_id)
        .collect::<std::collections::BTreeSet<_>>();
    envelope
        .units
        .retain(|unit| unit.item_ids.iter().all(|id| item_ids.contains(id)));
    let input = FixedInput::capture(envelope)?;
    Ok(input)
}
