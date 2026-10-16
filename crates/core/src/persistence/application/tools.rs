//! Tool proposals inherit a captured plan; no producer can construct authority.
use super::{ProjectStore, control};
use crate::{application::*, execution::*};
use rusqlite::{Connection, OptionalExtension, params};
use std::time::{Duration, Instant};

pub const WORK_PLAN_TOOL_OPERATION: &str = "plugin-tool-query";
fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    fail(ErrorCode::StorageFailed, "work-plan-tool-storage")
}

fn derive(
    plan: &WorkPlan,
    scope: &WorkPlanAgentScope,
    request: &AgentToolRequest,
) -> Result<PreparedWorkPlanTool, ExecutionError> {
    super::agents::validate_scope_basis(plan, scope)?;
    let original = plan.fixed_input()?;
    let selected = request
        .unit_ids
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if selected.is_empty()
        || selected.len() > 100
        || selected.len() != request.unit_ids.len()
        || request.task_id == scope.parent_task
        || request.attempt_id == original.envelope().attempt_id
        || selected.iter().any(|id| {
            !plan
                .selection_basis
                .iter()
                .any(|basis| basis.unit_id == *id)
        })
    {
        return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-scope"));
    }
    if scope.delegation.as_ref().is_some_and(|subset| {
        selected.iter().any(|id| !subset.unit_ids.contains(id))
            || !subset.tool_handles.contains(&request.tool_handle)
    }) {
        return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-scope"));
    }
    let tool = plan
        .tools
        .as_ref()
        .and_then(|tools| {
            tools
                .entries
                .iter()
                .find(|tool| tool.handle == request.tool_handle)
        })
        .ok_or_else(|| fail(ErrorCode::Unauthorized, "work-plan-tool-handle"))?
        .clone();
    let query = tool
        .binding
        .declaration
        .query
        .as_ref()
        .ok_or_else(|| fail(ErrorCode::InvalidInput, "work-plan-tool-query"))?;
    let capability = &tool.binding.capability.declaration;
    let binding = tool.execution.clone();
    let mut envelope = original.envelope().clone();
    envelope.task_id = request.task_id;
    envelope.attempt_id = request.attempt_id;
    envelope.operation = WORK_PLAN_TOOL_OPERATION.into();
    envelope.capability_id = capability.contract.id.clone();
    envelope.capability_version = binding.capability_version();
    envelope.automation = Some(scope.lease);
    envelope.plugin = Some(binding);
    envelope
        .items
        .retain(|item| selected.iter().any(|id| item.scope.id == id.to_string()));
    for item in &mut envelope.items {
        let source = crate::ai::item_payload(&original, item.item_id)?;
        item.payload = query
            .prepare_payload(
                &source.source_text,
                &tool.target,
                &tool.selections,
                capability.limits.max_input_bytes,
            )
            .map_err(|_| fail(ErrorCode::InvalidInput, "work-plan-tool-payload"))?;
    }
    let ids = envelope
        .items
        .iter()
        .map(|item| item.item_id)
        .collect::<std::collections::BTreeSet<_>>();
    envelope
        .units
        .retain(|unit| unit.item_ids.iter().all(|id| ids.contains(id)));
    envelope.limits.timeout_ms = envelope
        .limits
        .timeout_ms
        .min(capability.limits.timeout_ms)
        .min(60_000);
    let result_bytes = capability
        .limits
        .max_output_bytes
        .checked_mul(8)
        .and_then(|n| n.checked_add(16 * 1024))
        .ok_or_else(|| fail(ErrorCode::LimitExceeded, "work-plan-tool-result"))?;
    envelope.limits.max_result_bytes = envelope.limits.max_result_bytes.min(result_bytes);
    envelope.settings = serde_json::json!({"tool": {
        "settingsRevision": tool.settings_revision, "resourceId": tool.resource_id,
        "binding": tool.binding, "packageOrigin": tool.package_origin,
        "componentScope": tool.execution.component_scope, "environment": tool.execution.environment, "environmentDigest": tool.execution.environment.digest().map_err(|_| fail(ErrorCode::InvalidInput, "work-plan-tool-environment"))?,
        "runtimeOrigin": tool.runtime_origin
    }, "query": {"target": tool.target, "selections": tool.selections}, "toolHandle": tool.handle, "agent": scope.execution_binding()});
    let input = FixedInput::capture(envelope)?;
    Ok(PreparedWorkPlanTool {
        scope: scope.clone(),
        request: request.clone(),
        input,
        tool,
    })
}

impl ProjectStore {
    /// Read only this live Agent scope's exact, durably enqueued tool child.
    pub fn read_work_plan_agent_tool_attempt(
        &self,
        scope: &WorkPlanAgentScope,
        request: &AgentToolRequest,
        input_digest: &str,
        active: bool,
        offset: u32,
        limit: u32,
    ) -> Result<AttemptDetail, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-tool-read"))?;
        super::super::review::read_snapshot(connection, |connection| {
            let input = self.tool_read_input(connection, scope, request, input_digest)?;
            let page = self.execution_attempt_detail(request.attempt_id, active, offset, limit)?;
            for item in &page.items {
                if let Some(result_id) = item.result_id {
                    let result = super::super::ledger::load_result(connection, &input, result_id)?;
                    if result.envelope().item_id != item.status.item_id {
                        return Err(fail(ErrorCode::CorruptLedger, "work-plan-tool-result"));
                    }
                }
            }
            Ok(page)
        })
    }

    pub fn read_work_plan_agent_tool_output(
        &self,
        scope: &WorkPlanAgentScope,
        request: &AgentToolRequest,
        input_digest: &str,
        item_id: ExecutionId,
        result_id: ExecutionId,
    ) -> Result<FixedResult, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-tool-read"))?;
        super::super::review::read_snapshot(connection, |connection| {
            let input = self.tool_read_input(connection, scope, request, input_digest)?;
            input.item(item_id)?;
            let result = super::super::ledger::load_result(connection, &input, result_id)?;
            if result.envelope().item_id != item_id {
                return Err(fail(ErrorCode::ResultMismatch, "work-plan-tool-result"));
            }
            Ok(result)
        })
    }

    fn tool_read_input(
        &self,
        connection: &Connection,
        scope: &WorkPlanAgentScope,
        request: &AgentToolRequest,
        input_digest: &str,
    ) -> Result<FixedInput, ExecutionError> {
        self.check_work_plan_agent_scope(scope)?;
        let stored = control::load(connection, scope.lease.plan_id)?;
        // The immutable plan derives identity. Current source/adoption state and
        // execution consent are deliberately not prerequisites for reading it.
        let expected = derive(&stored.plan, scope, request)?;
        if expected.input.digest() != input_digest {
            return Err(fail(ErrorCode::ResultMismatch, "work-plan-tool-input"));
        }
        let input = self
            .execution_input_if_present(request.attempt_id)?
            .ok_or_else(|| fail(ErrorCode::DependencyConflict, "work-plan-tool-not-enqueued"))?;
        if input.bytes() != expected.input.bytes() {
            return Err(fail(ErrorCode::ResultMismatch, "work-plan-tool-input"));
        }
        let delegation = WorkPlanToolDelegation {
            lease: scope.lease,
            root_task: scope.parent_task,
            tool_handle: request.tool_handle,
            caller: "work-plan-agent".into(),
            caller_id: scope.caller_id,
            delegation: scope.delegation.clone(),
        };
        super::super::plugin_execution::validate_tool_read_in(connection, &input, &delegation)?;
        Ok(input)
    }

    /// Conservative accepted-item reservations, including every control generation.
    pub fn work_plan_tool_invocations(&self, plan_id: ExecutionId) -> Result<u32, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-tool-read"))?;
        control::load(c, plan_id)?;
        c.query_row("SELECT COUNT(*) FROM execution_items i JOIN application_executions x USING(attempt_id) WHERE x.plan_id=?1 AND x.kind='tool'", [plan_id.to_string()], |row| row.get(0)).map_err(sql)
    }

    pub(crate) fn check_work_plan_tool_consent(
        &self,
        scope: &WorkPlanAgentScope,
        consent: &WorkPlanToolConsent,
    ) -> Result<(), ExecutionError> {
        self.check_work_plan_agent_scope(scope)?;
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-tool-read"))?;
        let stored = control::load(c, scope.lease.plan_id)?;
        if !consent.matches_scope(scope)
            || Instant::now() >= consent.deadline
            || crate::execution::plugin_authority::plugin_now_ms()? >= consent.expires_at_ms
            || stored
                .plan
                .tools
                .as_ref()
                .map(WorkPlanTools::digest)
                .transpose()?
                .as_ref()
                != Some(&consent.tools_digest)
        {
            return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-consent"));
        }
        Ok(())
    }

    pub fn prepare_work_plan_agent_tool(
        &self,
        scope: &WorkPlanAgentScope,
        request: &AgentToolRequest,
    ) -> Result<PreparedWorkPlanTool, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-tool-read"))?;
        super::super::review::read_snapshot(c, |_| {
            self.check_work_plan_agent_scope(scope)?;
            let stored = control::load(c, scope.lease.plan_id)?;
            self.verify_work_plan(&stored.plan)?;
            derive(&stored.plan, scope, request)
        })
    }

    pub(crate) fn capture_work_plan_tool_consent(
        &self,
        lease: AutomationLease,
        runtime_generation: ExecutionId,
        expires_at_ms: u64,
        human_deadline: Instant,
        consent: PluginConsent,
    ) -> Result<WorkPlanToolConsent, ExecutionError> {
        let monotonic_now = Instant::now();
        let human_remaining = human_deadline
            .checked_duration_since(monotonic_now)
            .filter(|remaining| {
                !remaining.is_zero() && *remaining <= Duration::from_millis(600_000)
            })
            .ok_or_else(|| fail(ErrorCode::InvalidInput, "work-plan-tool-consent-expiry"))?;
        let now = crate::execution::plugin_authority::plugin_now_ms()?;
        let duration = expires_at_ms
            .checked_sub(now)
            .filter(|remaining| *remaining > 0 && *remaining <= 600_000)
            .ok_or_else(|| fail(ErrorCode::InvalidInput, "work-plan-tool-consent-expiry"))?;
        // Retain the human entry's original monotonic deadline even if the wall
        // clock moves backwards between that entry and this capture.
        let deadline = monotonic_now
            .checked_add(Duration::from_millis(duration).min(human_remaining))
            .ok_or_else(|| fail(ErrorCode::InvalidInput, "work-plan-tool-consent-expiry"))?;
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-tool-read"))?;
        let stored = control::load(c, lease.plan_id)?;
        if !consent.unsandboxed_execution
            || stored.lease != lease
            || stored.state != WorkPlanState::Active
            || !stored.effects.contains(&AutomationEffect::QueryTools)
            || expires_at_ms
                > stored
                    .expires_at
                    .checked_mul(1000)
                    .ok_or_else(|| fail(ErrorCode::InvalidInput, "work-plan-expiry"))?
        {
            return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-consent"));
        }
        let root = stored.plan.execution_input()?;
        let tools = stored
            .plan
            .tools
            .as_ref()
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "work-plan-tools"))?;
        Ok(WorkPlanToolConsent {
            project_id: root.project_id,
            lease,
            parent_task: root.task_id,
            store_epoch: self.changes.snapshot(Revision::new(0)?).epoch,
            tools_digest: tools.digest()?,
            runtime_generation,
            expires_at_ms,
            deadline,
        })
    }

    pub(crate) fn check_work_plan_tool_proposal(
        &self,
        prepared: &PreparedWorkPlanTool,
        consent: &WorkPlanToolConsent,
        generation: ExecutionId,
    ) -> Result<(), ExecutionError> {
        self.check_work_plan_agent_scope(&prepared.scope)?;
        if !consent.matches_scope(&prepared.scope)
            || generation != consent.runtime_generation
            || Instant::now() >= consent.deadline
            || crate::execution::plugin_authority::plugin_now_ms()? >= consent.expires_at_ms
        {
            return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-consent"));
        }
        let fresh = self.prepare_work_plan_agent_tool(&prepared.scope, &prepared.request)?;
        if fresh.input.digest() != prepared.input.digest() || fresh.tool != prepared.tool {
            return Err(fail(ErrorCode::ResultMismatch, "work-plan-tool-input"));
        }
        Ok(())
    }
}

pub(in crate::persistence) fn check_prepared_tool(
    c: &Connection,
    prepared: &PreparedWorkPlanTool,
    consent: &WorkPlanToolConsent,
) -> Result<WorkPlanToolDelegation, ExecutionError> {
    let stored = control::load(c, prepared.scope.lease.plan_id)?;
    let tools = stored
        .plan
        .tools
        .as_ref()
        .ok_or_else(|| fail(ErrorCode::Unauthorized, "work-plan-tools"))?;
    if tools.digest()? != consent.tools_digest
        || !consent.matches_scope(&prepared.scope)
        || stored.lease != consent.lease
        || stored.state != WorkPlanState::Active
        || stored.expires_at.saturating_mul(1000) < consent.expires_at_ms
        || Instant::now() >= consent.deadline
        || crate::execution::plugin_authority::plugin_now_ms()? >= consent.expires_at_ms
        || !stored.effects.contains(&AutomationEffect::QueryTools)
    {
        return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-consent"));
    }
    let expected = derive(&stored.plan, &prepared.scope, &prepared.request)?;
    if expected.input.digest() != prepared.input.digest() {
        return Err(fail(ErrorCode::ResultMismatch, "work-plan-tool-input"));
    }
    let root = stored.plan.execution_input()?.task_id;
    if root != prepared.scope.parent_task
        || !control::allows_cancelled_ancestor(c, &prepared.input, root)?
    {
        return Err(fail(ErrorCode::Cancelled, "work-plan-tool-root"));
    }
    let root_exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_budgets WHERE task_id=?1)",
            [root.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if !root_exists {
        return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-budget-owner"));
    }
    check_source(c, &stored.plan, &prepared.input)?;
    let occupied: u32 = c.query_row("SELECT COUNT(*) FROM execution_items i JOIN application_executions x USING(attempt_id) WHERE x.plan_id=?1 AND x.kind='tool' AND x.attempt_id<>?2", params![stored.plan.plan_id.to_string(), prepared.input.envelope().attempt_id.to_string()], |row| row.get(0)).map_err(sql)?;
    if occupied.saturating_add(prepared.input.envelope().items.len() as u32) > tools.max_invocations
    {
        return Err(fail(ErrorCode::LimitExceeded, "work-plan-tool-invocations"));
    }
    Ok(WorkPlanToolDelegation {
        lease: prepared.scope.lease,
        root_task: root,
        tool_handle: prepared.request.tool_handle,
        caller: "work-plan-agent".into(),
        caller_id: prepared.scope.caller_id,
        delegation: prepared.scope.delegation.clone(),
    })
}

pub(in crate::persistence) fn record_tool_input(
    c: &Connection,
    input: &FixedInput,
    delegation: &WorkPlanToolDelegation,
) -> Result<(), ExecutionError> {
    c.execute(
        "INSERT INTO application_executions VALUES (?1,?2,?3,'tool',?4,?5)",
        params![
            input.envelope().attempt_id.to_string(),
            delegation.lease.plan_id.to_string(),
            delegation.lease.generation.get() as i64,
            codec::encode(delegation, MAX_AGENT_DELEGATION_BYTES)?,
            delegation.root_task.to_string()
        ],
    )
    .map_err(sql)?;
    Ok(())
}

pub(in crate::persistence) fn validate_tool_input(
    c: &Connection,
    input: &FixedInput,
    delegation: &WorkPlanToolDelegation,
) -> Result<(), ExecutionError> {
    let stored = control::load(c, delegation.lease.plan_id)?;
    let association: Option<(String, Vec<u8>, String, String, i64)> = c.query_row("SELECT kind,delegation,root_task,plan_id,generation FROM application_executions WHERE attempt_id=?1", [input.envelope().attempt_id.to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional().map_err(sql)?;
    let Some((kind, bytes, root, plan, generation)) = association else {
        return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-association"));
    };
    let saved: WorkPlanToolDelegation = codec::decode(&bytes, MAX_AGENT_DELEGATION_BYTES)?;
    if kind != "tool"
        || saved != *delegation
        || root != delegation.root_task.to_string()
        || plan != delegation.lease.plan_id.to_string()
        || generation != delegation.lease.generation.get() as i64
        || delegation.lease.generation > stored.lease.generation
        || delegation.caller != "work-plan-agent"
        || delegation.root_task != stored.plan.execution_input()?.task_id
        || input.envelope().automation != Some(delegation.lease)
        || input.envelope().task_id == delegation.root_task
        || input.envelope().previous_attempt_id.is_some()
        || !input.envelope().reused_results.is_empty()
    {
        return Err(fail(ErrorCode::Unauthorized, "work-plan-tool-association"));
    }
    let scope = WorkPlanAgentScope {
        project_id: input.envelope().project_id,
        lease: delegation.lease,
        parent_task: delegation.root_task,
        store_epoch: String::new(),
        caller_id: delegation.caller_id,
        delegation: delegation.delegation.clone(),
    };
    let request = AgentToolRequest {
        task_id: input.envelope().task_id,
        attempt_id: input.envelope().attempt_id,
        tool_handle: delegation.tool_handle,
        unit_ids: input
            .envelope()
            .items
            .iter()
            .map(|item| ExecutionId::parse(&item.scope.id))
            .collect::<Result<Vec<_>, _>>()?,
    };
    if derive(&stored.plan, &scope, &request)?.input.digest() != input.digest() {
        return Err(fail(ErrorCode::ResultMismatch, "work-plan-tool-input"));
    }
    let grant: Option<(String, String, Vec<u8>)> = c.query_row("SELECT task_id,input_digest,delegation FROM plugin_execution_grants WHERE attempt_id=?1", [input.envelope().attempt_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(sql)?;
    if grant
        .as_ref()
        .map(|(task, digest, bytes)| (task.as_str(), digest.as_str(), bytes.as_slice()))
        != Some((
            input.envelope().task_id.to_string().as_str(),
            input.digest(),
            codec::encode(delegation, MAX_AGENT_DELEGATION_BYTES)?.as_slice(),
        ))
    {
        return Err(fail(ErrorCode::CorruptLedger, "work-plan-tool-grant"));
    }
    let count: u32 = c.query_row("SELECT COUNT(*) FROM execution_items i JOIN application_executions x USING(attempt_id) WHERE x.plan_id=?1 AND x.kind='tool'", [stored.plan.plan_id.to_string()], |row| row.get(0)).map_err(sql)?;
    if count
        > stored
            .plan
            .tools
            .as_ref()
            .ok_or_else(|| fail(ErrorCode::CorruptLedger, "work-plan-tools"))?
            .max_invocations
    {
        return Err(fail(ErrorCode::CorruptLedger, "work-plan-tool-invocations"));
    }
    Ok(())
}

pub(in crate::persistence) fn check_tool_delegation(
    c: &Connection,
    input: &FixedInput,
    delegation: &WorkPlanToolDelegation,
) -> Result<(), ExecutionError> {
    validate_tool_input(c, input, delegation)?;
    let stored = control::load(c, delegation.lease.plan_id)?;
    if stored.lease != delegation.lease
        || stored.state != WorkPlanState::Active
        || stored.expires_at.saturating_mul(1000)
            <= crate::execution::plugin_authority::plugin_now_ms()?
        || !stored.effects.contains(&AutomationEffect::QueryTools)
        || !control::allows_cancelled_ancestor(c, input, delegation.root_task)?
    {
        return Err(fail(ErrorCode::Cancelled, "work-plan-tool-control"));
    }
    check_source(c, &stored.plan, input)
}

fn check_source(c: &Connection, plan: &WorkPlan, input: &FixedInput) -> Result<(), ExecutionError> {
    let units = input
        .envelope()
        .items
        .iter()
        .map(|item| ExecutionId::parse(&item.scope.id))
        .collect::<Result<Vec<_>, _>>()?;
    let current = super::super::review::targets_in(c, plan.project_id, &units, &plan.locale)
        .map_err(|error| {
            if error.code == ErrorCode::DependencyConflict {
                fail(ErrorCode::Cancelled, "work-plan-tool-source")
            } else {
                error
            }
        })?;
    if current.len() != units.len()
        || current.iter().any(|target| {
            !plan.selection_basis.iter().any(|basis| {
                basis.unit_id == target.unit_id
                    && basis.source_revision_id == target.source_revision_id
                    && basis.source_snapshot_id == target.source_snapshot_id
                    && basis.native_key == target.native_key
            })
        })
    {
        return Err(fail(ErrorCode::Cancelled, "work-plan-tool-source"));
    }
    Ok(())
}
