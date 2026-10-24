//! Agent provenance is captured by Core, alongside the original input and ledger.
use super::{ProjectStore, control};
use crate::{application::*, execution::*};
use rusqlite::Connection;

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}

pub(in crate::persistence) fn binding(
    input: &FixedInput,
) -> Result<Option<WorkPlanAgentExecutionBinding>, ExecutionError> {
    if input.envelope().operation != crate::ai::OPERATION {
        return Ok(None);
    }
    Ok(crate::ai::settings(input)?.agent)
}

pub(super) fn validate_scope_basis(
    plan: &WorkPlan,
    scope: &WorkPlanAgentScope,
) -> Result<(), ExecutionError> {
    let root = plan.execution_input()?;
    if scope.project_id != root.project_id
        || scope.parent_task != root.task_id
        || scope.lease.plan_id != plan.plan_id
        || scope.lease.generation.get() == 0
    {
        return Err(fail(ErrorCode::Unauthorized, "work-plan-agent-scope"));
    }
    if let Some(subset) = &scope.delegation {
        let units = subset
            .unit_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let tools = subset
            .tool_handles
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if subset.parent_scope_id == scope.caller_id
            || units.is_empty()
            || units.len() > 100
            || units.len() != subset.unit_ids.len()
            || tools.len() > 32
            || tools.len() != subset.tool_handles.len()
            || !subset.unit_ids.windows(2).all(|pair| pair[0] < pair[1])
            || !subset.tool_handles.windows(2).all(|pair| pair[0] < pair[1])
            || units.iter().any(|id| {
                !plan
                    .selection_basis
                    .iter()
                    .any(|basis| basis.unit_id == *id)
            })
            || tools.iter().any(|id| {
                !plan
                    .tools
                    .as_ref()
                    .is_some_and(|allowed| allowed.entries.iter().any(|tool| tool.handle == *id))
            })
        {
            return Err(fail(ErrorCode::Unauthorized, "work-plan-agent-subset"));
        }
    }
    codec::encode(&scope.execution_binding(), MAX_AGENT_DELEGATION_BYTES)?;
    Ok(())
}

pub(super) fn scope_from_binding(
    project: ExecutionId,
    binding: &WorkPlanAgentExecutionBinding,
) -> WorkPlanAgentScope {
    WorkPlanAgentScope {
        project_id: project,
        lease: binding.lease,
        parent_task: binding.root_task,
        store_epoch: String::new(),
        caller_id: binding.caller_id,
        delegation: binding.delegation.clone(),
    }
}

pub(in crate::persistence) fn check_prepared(
    c: &Connection,
    prepared: &PreparedWorkPlanAgentGeneration,
) -> Result<(), ExecutionError> {
    control::check_scope_in(c, &prepared.scope)?;
    let plan = control::load(c, prepared.scope.lease.plan_id)?.plan;
    let expected = control::derive_agent_generation(&plan, &prepared.scope, &prepared.request)?;
    if expected.bytes() != prepared.input.bytes() {
        return Err(fail(ErrorCode::ResultMismatch, "work-plan-agent-input"));
    }
    control::check_enqueue(c, &prepared.input, Some(prepared.scope.parent_task))
}

/// Historical identity is independent of current authority and store epoch.
pub(in crate::persistence) fn validate_model_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    if input.envelope().operation == crate::ai::team::OPERATION {
        return super::coordination::validate_model_input(c, input);
    }
    let Some(lease) = input.envelope().automation else {
        return Ok(());
    };
    let plan = control::load(c, lease.plan_id)?.plan;
    let row: (String, Option<Vec<u8>>, String, String, i64) = c.query_row(
        "SELECT kind,delegation,root_task,plan_id,generation FROM application_executions WHERE attempt_id=?1",
        [input.envelope().attempt_id.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).map_err(|_| fail(ErrorCode::CorruptLedger, "work-plan-agent-association"))?;
    let agent = binding(input)?;
    let expected = agent
        .as_ref()
        .map(|value| codec::encode(value, MAX_AGENT_DELEGATION_BYTES))
        .transpose()?;
    if row.0 != "model"
        || row.1 != expected
        || row.2 != plan.execution_input()?.task_id.to_string()
        || row.3 != lease.plan_id.to_string()
        || row.4 != lease.generation.get() as i64
    {
        return Err(fail(
            ErrorCode::CorruptLedger,
            "work-plan-agent-association",
        ));
    }
    if let Some(agent) = agent {
        let scope = scope_from_binding(input.envelope().project_id, &agent);
        validate_scope_basis(&plan, &scope)?;
        let request = generation_request(input)?;
        if agent.lease != lease
            || control::derive_agent_generation(&plan, &scope, &request)?.bytes() != input.bytes()
        {
            return Err(fail(ErrorCode::CorruptLedger, "work-plan-agent-input"));
        }
        let parent: Option<String> = c
            .query_row(
                "SELECT parent_id FROM execution_budgets WHERE task_id=?1",
                [input.envelope().task_id.to_string()],
                |r| r.get(0),
            )
            .map_err(|_| fail(ErrorCode::CorruptLedger, "work-plan-budget-owner"))?;
        if parent.as_deref() != Some(agent.root_task.to_string().as_str()) {
            return Err(fail(ErrorCode::CorruptLedger, "work-plan-budget-owner"));
        }
    }
    Ok(())
}

fn generation_request(input: &FixedInput) -> Result<AgentGenerationRequest, ExecutionError> {
    Ok(AgentGenerationRequest {
        task_id: input.envelope().task_id,
        attempt_id: input.envelope().attempt_id,
        unit_ids: input
            .envelope()
            .items
            .iter()
            .map(|item| ExecutionId::parse(&item.scope.id))
            .collect::<Result<_, _>>()?,
    })
}

impl ProjectStore {
    /// Human reconciliation of an uncertain enqueue. Absence becomes definitive
    /// only after irreversible control, in this same read snapshot. Wall-clock
    /// expiry alone cannot prove that a later clock rollback will not accept it.
    pub fn reconcile_work_plan_agent_execution(
        &self,
        identity: &WorkPlanAgentExecutionIdentity,
    ) -> Result<WorkPlanAgentReconciliation, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-agent-reconcile"))?;
        let found = super::super::review::read_snapshot(c, |c| {
            if identity.input_digest.len() != 64
                || !identity
                    .input_digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(fail(ErrorCode::InvalidInput, "work-plan-agent-reconcile"));
            }
            let stored = control::load(c, identity.lease.plan_id)?;
            let project = super::super::read_metadata_from(c)
                .map_err(|_| fail(ErrorCode::CorruptLedger, "project"))?
                .project_id();
            if stored.plan.project_id.to_string() != project.to_string()
                || identity.lease.generation.get() == 0
                || identity.lease.generation > stored.lease.generation
            {
                return Err(fail(ErrorCode::Unauthorized, "work-plan-agent-reconcile"));
            }
            let outcome = if let Some(input) =
                self.execution_input_if_present(identity.attempt_id)?
            {
                if input.envelope().task_id != identity.task_id
                    || input.digest() != identity.input_digest
                    || input.envelope().automation != Some(identity.lease)
                {
                    return Err(fail(ErrorCode::ResultMismatch, "work-plan-agent-reconcile"));
                }
                if input.envelope().plugin.is_some() {
                    let bytes: Vec<u8> = c.query_row("SELECT delegation FROM application_executions WHERE attempt_id=?1 AND kind='tool'",
                        [identity.attempt_id.to_string()], |row| row.get(0)).map_err(|_| fail(ErrorCode::CorruptLedger, "work-plan-tool-association"))?;
                    let delegation: WorkPlanToolDelegation =
                        codec::decode(&bytes, MAX_AGENT_DELEGATION_BYTES)?;
                    super::super::plugin_execution::validate_tool_read_in(c, &input, &delegation)?;
                } else {
                    if binding(&input)?.is_none() {
                        return Err(fail(ErrorCode::Unauthorized, "work-plan-agent-reconcile"));
                    }
                    validate_model_input(c, &input)?;
                }
                WorkPlanAgentReconciliationOutcome::Enqueued
            } else {
                let occupied: bool = c
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM execution_tasks WHERE task_id=?1)",
                        [identity.task_id.to_string()],
                        |row| row.get(0),
                    )
                    .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-agent-reconcile"))?;
                if occupied {
                    return Err(fail(ErrorCode::ResultMismatch, "work-plan-agent-reconcile"));
                }
                if stored.lease == identity.lease && stored.state == WorkPlanState::Active {
                    WorkPlanAgentReconciliationOutcome::Active
                } else {
                    WorkPlanAgentReconciliationOutcome::NotEnqueued
                }
            };
            Ok(WorkPlanAgentReconciliation {
                identity: identity.clone(),
                outcome,
            })
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
    }
    pub fn delegate_work_plan_agent_scope(
        &self,
        parent: &WorkPlanAgentScope,
        request: &AgentDelegationRequest,
    ) -> Result<WorkPlanAgentScope, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-read"))?;
        super::super::review::read_snapshot(c, |_| {
            self.check_work_plan_agent_scope(parent)?;
            if control::load(c, parent.lease.plan_id)?
                .plan
                .options
                .team_execution
                .is_some()
            {
                return Err(fail(ErrorCode::Unauthorized, "team-work-admission"));
            }
            if parent.delegation.is_some() {
                return Err(fail(ErrorCode::Unauthorized, "work-plan-agent-leaf"));
            }
            let mut subset = WorkPlanAgentSubset {
                delegation_id: request.delegation_id,
                parent_scope_id: parent.caller_id,
                unit_ids: request.unit_ids.clone(),
                tool_handles: request.tool_handles.clone(),
            };
            subset.unit_ids.sort();
            subset.tool_handles.sort();
            let mut child = parent.clone();
            child.caller_id = ExecutionId::new();
            child.delegation = Some(subset);
            validate_scope_basis(&control::load(c, parent.lease.plan_id)?.plan, &child)?;
            Ok(child)
        })
    }

    pub fn read_work_plan_agent_generation_attempt(
        &self,
        scope: &WorkPlanAgentScope,
        request: &AgentGenerationRequest,
        input_digest: &str,
        active: bool,
        offset: u32,
        limit: u32,
    ) -> Result<AttemptDetail, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-agent-read"))?;
        super::super::review::read_snapshot(c, |c| {
            let input = self.agent_read_input(c, scope, request, input_digest)?;
            let page = self.execution_attempt_detail(request.attempt_id, active, offset, limit)?;
            for item in &page.items {
                if let Some(result_id) = item.result_id {
                    let result = super::super::ledger::load_result(c, &input, result_id)?;
                    if result.envelope().item_id != item.status.item_id {
                        return Err(fail(ErrorCode::CorruptLedger, "work-plan-agent-result"));
                    }
                }
            }
            Ok(page)
        })
    }

    pub fn read_work_plan_agent_generation_output(
        &self,
        scope: &WorkPlanAgentScope,
        request: &AgentGenerationRequest,
        input_digest: &str,
        item_id: ExecutionId,
        result_id: ExecutionId,
    ) -> Result<FixedResult, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "work-plan-agent-read"))?;
        super::super::review::read_snapshot(c, |c| {
            let input = self.agent_read_input(c, scope, request, input_digest)?;
            input.item(item_id)?;
            let result = super::super::ledger::load_result(c, &input, result_id)?;
            if result.envelope().item_id != item_id {
                return Err(fail(ErrorCode::ResultMismatch, "work-plan-agent-result"));
            }
            Ok(result)
        })
    }

    fn agent_read_input(
        &self,
        c: &Connection,
        scope: &WorkPlanAgentScope,
        request: &AgentGenerationRequest,
        digest: &str,
    ) -> Result<FixedInput, ExecutionError> {
        self.check_work_plan_agent_scope(scope)?;
        let plan = control::load(c, scope.lease.plan_id)?.plan;
        let expected = control::derive_agent_generation(&plan, scope, request)?;
        if expected.digest() != digest {
            return Err(fail(ErrorCode::ResultMismatch, "work-plan-agent-input"));
        }
        let input = self
            .execution_input_if_present(request.attempt_id)?
            .ok_or_else(|| {
                fail(
                    ErrorCode::DependencyConflict,
                    "work-plan-agent-not-enqueued",
                )
            })?;
        if input.bytes() != expected.bytes() {
            return Err(fail(ErrorCode::ResultMismatch, "work-plan-agent-input"));
        }
        validate_model_input(c, &input)?;
        Ok(input)
    }
}
