//! Guidance observes the original tool grant without preparing an input.
//! Model sharing additionally checks its actual dispatch; package IO stays in Host.
use super::{ProjectStore, control};
use crate::{ai, application::*, execution::*};
use rusqlite::{Connection, OptionalExtension, params};

fn denied() -> ExecutionError {
    ExecutionError::new(ErrorCode::Unauthorized, "work-plan-guidance-scope")
}
fn storage(_: rusqlite::Error) -> ExecutionError {
    ExecutionError::new(ErrorCode::StorageFailed, "work-plan-guidance-read")
}

fn capture_in(
    store: &ProjectStore,
    connection: &Connection,
    scope: &WorkPlanAgentScope,
) -> Result<(CapturedWorkPlanToolGuidance, Option<ToolGuidancePolicy>), ExecutionError> {
    store.check_work_plan_agent_scope(scope)?;
    let stored = control::load(connection, scope.lease.plan_id)?;
    if !stored.effects.contains(&AutomationEffect::QueryTools) {
        return Err(denied());
    }
    let policy = stored.plan.options.tool_guidance;
    let tools = stored.plan.tools.ok_or_else(denied)?;
    Ok((
        CapturedWorkPlanToolGuidance {
            scope: scope.clone(),
            tools: tools
                .entries
                .into_iter()
                .filter(|tool| {
                    scope
                        .delegation
                        .as_ref()
                        .is_none_or(|subset| subset.tool_handles.contains(&tool.handle))
                })
                .collect(),
        },
        policy,
    ))
}

fn deadline(request: &DispatchRequest) -> Result<std::time::Instant, ExecutionError> {
    request.check_service_dispatch()?;
    let deadline = request
        .deadline()
        .ok_or_else(|| ExecutionError::new(ErrorCode::Unauthorized, "member-guidance-deadline"))?;
    if std::time::Instant::now() >= deadline {
        return Err(ExecutionError::new(
            ErrorCode::Cancelled,
            "member-guidance-deadline",
        ));
    }
    Ok(deadline)
}

fn check_dispatch_in(
    connection: &Connection,
    scope: &WorkPlanAgentScope,
    request: &DispatchRequest,
) -> Result<(), ExecutionError> {
    let input = &request.input;
    let binding = match input.envelope().operation.as_str() {
        ai::OPERATION => ai::settings(input)?.agent.ok_or_else(denied)?,
        ai::team::OPERATION => ai::team::settings(input)?.binding.scope().clone(),
        _ => return Err(denied()),
    };
    if binding != scope.execution_binding() {
        return Err(denied());
    }
    let original = super::super::ledger::load_input(connection, input.envelope().attempt_id)?;
    if original.bytes() != input.bytes() {
        return Err(ExecutionError::new(
            ErrorCode::Unauthorized,
            "member-guidance-dispatch",
        ));
    }
    input.item(request.item_id)?;
    let state: Option<(String, Option<String>, i64)> = connection
        .query_row(
            "SELECT i.execution,i.dispatch_token,a.cancellation_revision FROM execution_items i JOIN execution_attempts a ON a.attempt_id=i.attempt_id WHERE i.attempt_id=?1 AND i.item_id=?2",
            params![input.envelope().attempt_id.to_string(), request.item_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(storage)?;
    let Some((state, token, cancellation)) = state else {
        return Err(denied());
    };
    if state != "dispatched" || token != Some(request.dispatch_token.to_string()) {
        return Err(ExecutionError::new(
            ErrorCode::Unauthorized,
            "member-guidance-dispatch",
        ));
    }
    let cancellation = u64::try_from(cancellation)
        .map_err(|_| ExecutionError::new(ErrorCode::CorruptLedger, "member-guidance-dispatch"))?;
    if super::super::ledger::cancel_revision(connection, input.envelope().task_id)?.get()
        != cancellation
    {
        return Err(ExecutionError::new(
            ErrorCode::Cancelled,
            "member-guidance-dispatch",
        ));
    }
    control::check_input(connection, input)
}

impl ProjectStore {
    pub fn capture_work_plan_agent_guidance(
        &self,
        scope: &WorkPlanAgentScope,
    ) -> Result<CapturedWorkPlanToolGuidance, ExecutionError> {
        let connection = self.connection().map_err(|_| {
            ExecutionError::new(ErrorCode::StorageFailed, "work-plan-guidance-read")
        })?;
        super::super::review::read_snapshot(connection, |_| {
            Ok(capture_in(self, connection, scope)?.0)
        })
    }

    /// Recheck after bounded package IO. A different caller, even under the same
    /// lease, cannot reuse this observation as its own scope witness.
    pub fn check_work_plan_agent_guidance(
        &self,
        scope: &WorkPlanAgentScope,
        captured: &CapturedWorkPlanToolGuidance,
    ) -> Result<(), ExecutionError> {
        if *scope != captured.scope {
            return Err(denied());
        }
        let current = self.capture_work_plan_agent_guidance(scope)?;
        if current.tools != captured.tools {
            return Err(denied());
        }
        Ok(())
    }

    /// Capture only the original member's explicitly shared, declared guidance.
    /// This is a read and does not reserve a Provider request or authorize a tool.
    pub fn capture_member_tool_guidance(
        &self,
        scope: &WorkPlanAgentScope,
        request: &DispatchRequest,
    ) -> Result<CapturedMemberToolGuidance, ExecutionError> {
        let original_deadline = deadline(request)?;
        let connection = self.connection().map_err(|_| {
            ExecutionError::new(ErrorCode::StorageFailed, "work-plan-guidance-read")
        })?;
        super::super::review::read_snapshot(connection, |_| {
            let (guidance, policy) = capture_in(self, connection, scope)?;
            if policy.is_none() {
                return Err(ExecutionError::new(
                    ErrorCode::Unauthorized,
                    "member-guidance-sharing",
                ));
            }
            check_dispatch_in(connection, scope, request)?;
            deadline(request)?;
            Ok(CapturedMemberToolGuidance {
                guidance,
                attempt_id: request.input.envelope().attempt_id,
                input_digest: request.input.digest().into(),
                item_id: request.item_id,
                dispatch_token: request.dispatch_token,
                deadline: original_deadline,
            })
        })
    }

    /// Recheck the same observation after package IO, without renewing its limit.
    pub fn check_member_tool_guidance(
        &self,
        request: &DispatchRequest,
        captured: &CapturedMemberToolGuidance,
    ) -> Result<(), ExecutionError> {
        if request.input.envelope().attempt_id != captured.attempt_id
            || request.input.digest() != captured.input_digest
            || request.item_id != captured.item_id
            || request.dispatch_token != captured.dispatch_token
            || deadline(request)? != captured.deadline
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "member-guidance-dispatch",
            ));
        }
        let current = self.capture_member_tool_guidance(&captured.guidance.scope, request)?;
        if current.tools() != captured.tools() {
            return Err(denied());
        }
        Ok(())
    }
}
