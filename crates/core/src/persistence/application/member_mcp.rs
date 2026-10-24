//! A fixed MCP leaf reuses the original queue and query action. Its sharing
//! witness belongs to the actual model dispatch, not to transport liveness.
use super::{ProjectStore, control, guidance};
use crate::{ai, application::*, execution::*};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

fn err(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    err(ErrorCode::StorageFailed, "member-mcp-ledger")
}
fn denied() -> ExecutionError {
    err(ErrorCode::Unauthorized, "member-mcp-scope")
}

fn association(captured: &CapturedMemberMcpTermQuery) -> MemberMcpTermQueryAssociation {
    MemberMcpTermQueryAssociation {
        lease: captured.scope.lease,
        root_task: captured.scope.parent_task,
        caller_id: captured.scope.caller_id,
        model_attempt: captured.model_attempt,
        model_input_digest: captured.model_input_digest.clone(),
        model_item: captured.model_item,
        dispatch_token: captured.dispatch_token,
    }
}
fn scope_for(input: &FixedInput, a: &MemberMcpTermQueryAssociation) -> WorkPlanAgentScope {
    WorkPlanAgentScope {
        project_id: input.envelope().project_id,
        lease: a.lease,
        parent_task: a.root_task,
        store_epoch: String::new(),
        caller_id: a.caller_id,
        delegation: None,
    }
}
fn plan_in(
    c: &Connection,
    input: &FixedInput,
    a: &MemberMcpTermQueryAssociation,
) -> Result<control::StoredPlan, ExecutionError> {
    let stored = control::load(c, a.lease.plan_id)?;
    let preview = stored
        .plan
        .options
        .mcp_term_query
        .as_ref()
        .ok_or_else(denied)?
        .preview();
    if stored.plan.options.team_execution.is_some()
        || stored.plan.selection_basis.len() != 1
        || stored.plan.execution_input()?.task_id != a.root_task
        || input.envelope().automation.is_some()
        || input.envelope().plugin.is_some()
        || input.envelope().task_id == a.root_task
        || input.envelope().project_id != stored.plan.project_id
        || super::super::mcp::preview_for_input(input)? != *preview
    {
        return Err(denied());
    }
    Ok(stored)
}

/// Counts retain every accepted generation and classify from the actual fixed
/// operation. Full historical validation separately checks each typed binding.
pub(super) fn counts(
    c: &Connection,
    plan: ExecutionId,
    exclude: Option<ExecutionId>,
) -> Result<(u32, u32), ExecutionError> {
    let mut statement = c.prepare("SELECT t.operation,COUNT(i.item_id) FROM application_executions x JOIN execution_attempts a USING(attempt_id) JOIN execution_tasks t USING(task_id) JOIN execution_items i USING(attempt_id) WHERE x.plan_id=?1 AND x.kind='tool' AND (?2 IS NULL OR x.attempt_id<>?2) GROUP BY t.operation").map_err(sql)?;
    let mut sdk = 0u32;
    let mut mcp = 0u32;
    for row in statement
        .query_map(
            params![plan.to_string(), exclude.map(|id| id.to_string())],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)),
        )
        .map_err(sql)?
    {
        let (operation, count) = row.map_err(sql)?;
        match operation.as_str() {
            "plugin-tool-query" => sdk = sdk.checked_add(count).ok_or_else(denied)?,
            MCP_TERM_QUERY_OPERATION => mcp = mcp.checked_add(count).ok_or_else(denied)?,
            _ => return Err(err(ErrorCode::CorruptLedger, "work-plan-tool-kind")),
        }
    }
    Ok((sdk, mcp))
}
fn limits(
    c: &Connection,
    plan: &WorkPlan,
    exclude: Option<ExecutionId>,
) -> Result<(), ExecutionError> {
    let (sdk, mcp) = counts(c, plan.plan_id, exclude)?;
    if sdk > plan.tools.as_ref().map_or(0, |t| t.max_invocations)
        || mcp > u32::from(plan.options.mcp_term_query.is_some())
    {
        return Err(err(ErrorCode::LimitExceeded, "work-plan-tool-invocations"));
    }
    Ok(())
}

pub(crate) fn validate_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<MemberMcpTermQueryAssociation, ExecutionError> {
    super::super::mcp::validate_query_input(c, input)?;
    let row: Option<(String,String,i64,Vec<u8>,String)> = c.query_row("SELECT kind,plan_id,generation,delegation,root_task FROM application_executions WHERE attempt_id=?1",[input.envelope().attempt_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(sql)?;
    let (kind, plan, generation, bytes, root) = row.ok_or_else(denied)?;
    let a: MemberMcpTermQueryAssociation = codec::decode(&bytes, MAX_AGENT_DELEGATION_BYTES)?;
    let stored = plan_in(c, input, &a)?;
    if kind != "tool"
        || plan != a.lease.plan_id.to_string()
        || root != a.root_task.to_string()
        || generation != a.lease.generation.get() as i64
        || a.lease.generation > stored.lease.generation
    {
        return Err(denied());
    }
    let model = super::super::ledger::load_input(c, a.model_attempt)?;
    let binding = ai::settings(&model)?.agent.ok_or_else(denied)?;
    if model.envelope().operation != ai::OPERATION
        || model.digest() != a.model_input_digest
        || binding != scope_for(input, &a).execution_binding()
        || model.item(a.model_item)?.scope.id != input.envelope().items[0].scope.id
    {
        return Err(denied());
    }
    super::agents::validate_model_input(c, &model)?;
    let token: Option<String> = c
        .query_row(
            "SELECT dispatch_token FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
            params![a.model_attempt.to_string(), a.model_item.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if token != Some(a.dispatch_token.to_string()) {
        return Err(denied());
    }
    let action: Option<(String, String)> = c
        .query_row(
            "SELECT attempt_id,input_digest FROM mcp_query_actions WHERE action_id=?1",
            [stored
                .plan
                .options
                .mcp_term_query
                .as_ref()
                .unwrap()
                .preview()
                .request
                .action_id
                .to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    if action
        != Some((
            input.envelope().attempt_id.to_string(),
            input.digest().into(),
        ))
    {
        return Err(denied());
    }
    limits(c, &stored.plan, None)?;
    Ok(a)
}

pub(crate) fn check_input(c: &Connection, input: &FixedInput) -> Result<(), ExecutionError> {
    let a = validate_input(c, input)?;
    let scope = scope_for(input, &a);
    control::check_scope_in(c, &scope)?;
    if !control::load(c, a.lease.plan_id)?
        .effects
        .contains(&AutomationEffect::QueryTools)
    {
        return Err(denied());
    }
    super::maintenance::check_protection(c, &control::load(c, a.lease.plan_id)?.plan)?;
    super::tools::check_source(c, &control::load(c, a.lease.plan_id)?.plan, input)?;
    check_model_live(c, &a)
}
fn check_model_live(
    c: &Connection,
    a: &MemberMcpTermQueryAssociation,
) -> Result<(), ExecutionError> {
    let (state,token,cancellation):(String,Option<String>,i64) = c.query_row("SELECT i.execution,i.dispatch_token,a.cancellation_revision FROM execution_items i JOIN execution_attempts a USING(attempt_id) WHERE i.attempt_id=?1 AND i.item_id=?2",params![a.model_attempt.to_string(),a.model_item.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
    let model = super::super::ledger::load_input(c, a.model_attempt)?;
    if state != "dispatched"
        || token != Some(a.dispatch_token.to_string())
        || u64::try_from(cancellation).ok()
            != Some(super::super::ledger::cancel_revision(c, model.envelope().task_id)?.get())
    {
        return Err(err(ErrorCode::Cancelled, "member-mcp-dispatch"));
    }
    control::check_input(c, &model)
}
fn check_captured(
    c: &Connection,
    captured: &CapturedMemberMcpTermQuery,
) -> Result<(), ExecutionError> {
    if !captured.prepared.store_live.load(Ordering::Acquire) || Instant::now() >= captured.deadline
    {
        return Err(err(ErrorCode::Cancelled, "member-mcp-deadline"));
    }
    let a = association(captured);
    let stored = plan_in(c, captured.prepared.input(), &a)?;
    control::check_scope_in(c, &captured.scope)?;
    if !stored.effects.contains(&AutomationEffect::QueryTools) {
        return Err(denied());
    }
    super::maintenance::check_protection(c, &stored.plan)?;
    super::super::mcp::check_preview_in(c, captured.preview())?;
    check_model_live(c, &a)
}

pub(crate) fn check_prepared(
    c: &Connection,
    sealed: &PreparedMemberMcpTermQuery,
) -> Result<(), ExecutionError> {
    check_captured(c, &sealed.captured)?;
    sealed.permit.check_input(sealed.prepared().input())?;
    let a = association(&sealed.captured);
    if sealed.prepared().member_binding.get() != Some(&a) {
        return Err(denied());
    }
    let stored = plan_in(c, sealed.prepared().input(), &a)?;
    let (_, mcp) = counts(
        c,
        stored.plan.plan_id,
        Some(sealed.prepared().input().envelope().attempt_id),
    )?;
    if mcp != 0 {
        return Err(err(ErrorCode::LimitExceeded, "work-plan-mcp-invocations"));
    }
    limits(
        c,
        &stored.plan,
        Some(sealed.prepared().input().envelope().attempt_id),
    )
}
pub(crate) fn record_input(
    c: &Connection,
    sealed: &PreparedMemberMcpTermQuery,
) -> Result<(), ExecutionError> {
    let a = association(&sealed.captured);
    c.execute(
        "INSERT INTO application_executions VALUES (?1,?2,?3,'tool',?4,?5)",
        params![
            sealed.prepared().input().envelope().attempt_id.to_string(),
            a.lease.plan_id.to_string(),
            a.lease.generation.get() as i64,
            codec::encode(&a, MAX_AGENT_DELEGATION_BYTES)?,
            a.root_task.to_string()
        ],
    )
    .map_err(sql)?;
    validate_input(c, sealed.prepared().input())?;
    Ok(())
}

impl ProjectStore {
    /// Total accepted tool reservations and the original SDK N plus fixed MCP 1.
    pub fn work_plan_tool_usage(&self, plan_id: ExecutionId) -> Result<(u32, u32), ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        let stored = control::load(c, plan_id)?;
        let (sdk, mcp) = counts(c, plan_id, None)?;
        limits(c, &stored.plan, None)?;
        Ok((
            sdk.checked_add(mcp).ok_or_else(denied)?,
            stored
                .plan
                .tools
                .as_ref()
                .map_or(0, |t| t.max_invocations)
                .checked_add(u32::from(stored.plan.options.mcp_term_query.is_some()))
                .ok_or_else(denied)?,
        ))
    }
    pub(crate) fn validate_member_mcp_term_query_admission(
        &self,
        sealed: &PreparedMemberMcpTermQuery,
    ) -> Result<(), ExecutionError> {
        let c = self.connection().map_err(|_| denied())?;
        if validate_input(c, sealed.prepared().input())? != association(&sealed.captured) {
            return Err(denied());
        }
        Ok(())
    }
    pub fn capture_member_mcp_term_query(
        &self,
        scope: &WorkPlanAgentScope,
        dispatch: &DispatchRequest,
        prepared: &PreparedMcpTermQuery,
    ) -> Result<CapturedMemberMcpTermQuery, ExecutionError> {
        self.check_work_plan_agent_scope(scope)?;
        self.check_mcp_term_query(prepared)?;
        if scope.delegation.is_some()
            || dispatch.input.envelope().operation != ai::OPERATION
            || dispatch.input.item(dispatch.item_id)?.scope.id
                != prepared.preview.request.unit_id.to_string()
            || prepared.authorization.get().is_some()
        {
            return Err(denied());
        }
        let c = self.connection().map_err(|_| denied())?;
        super::super::review::read_snapshot(c, |c| {
            guidance::check_dispatch_in(c, scope, dispatch)?;
            let stored = control::load(c, scope.lease.plan_id)?;
            let remaining = stored
                .expires_at
                .checked_mul(1000)
                .and_then(|expiry| {
                    expiry.checked_sub(crate::execution::plugin_authority::plugin_now_ms().ok()?)
                })
                .filter(|n| *n > 0)
                .ok_or_else(denied)?;
            let dispatch_deadline = guidance::deadline(dispatch)?;
            let mut captured = CapturedMemberMcpTermQuery {
                scope: scope.clone(),
                prepared: prepared.clone(),
                model_attempt: dispatch.input.envelope().attempt_id,
                model_input_digest: dispatch.input.digest().into(),
                model_item: dispatch.item_id,
                dispatch_token: dispatch.dispatch_token,
                dispatch_deadline,
                deadline: prepared
                    .deadline
                    .min(dispatch_deadline)
                    .min(Instant::now() + Duration::from_millis(remaining)),
            };
            check_captured(c, &captured)?;
            let a = association(&captured);
            if prepared.member_binding.get_or_init(|| a.clone()) != &a {
                return Err(denied());
            }
            // Lease wall time is converted once. Re-observation cannot renew
            // the original shortest monotonic ceiling after clock movement.
            captured.deadline = *prepared.member_deadline.get_or_init(|| captured.deadline);
            check_captured(c, &captured)?;
            Ok(captured)
        })
    }
    pub fn check_member_mcp_term_query(
        &self,
        dispatch: &DispatchRequest,
        captured: &CapturedMemberMcpTermQuery,
    ) -> Result<(), ExecutionError> {
        self.check_work_plan_agent_scope(&captured.scope)?;
        if dispatch.input.envelope().attempt_id != captured.model_attempt
            || dispatch.input.digest() != captured.model_input_digest
            || dispatch.item_id != captured.model_item
            || dispatch.dispatch_token != captured.dispatch_token
            || guidance::deadline(dispatch)? != captured.dispatch_deadline
        {
            return Err(denied());
        }
        let c = self.connection().map_err(|_| denied())?;
        super::super::review::read_snapshot(c, |c| {
            guidance::check_dispatch_in(c, &captured.scope, dispatch)?;
            check_captured(c, captured)
        })
    }
    pub fn prepare_member_mcp_term_query(
        &self,
        dispatch: &DispatchRequest,
        captured: &CapturedMemberMcpTermQuery,
        original: &PreparedMcpTermQuery,
    ) -> Result<PreparedMemberMcpTermQuery, ExecutionError> {
        self.check_member_mcp_term_query(dispatch, captured)?;
        self.check_mcp_term_query(original)?;
        if original.input.bytes() != captured.prepared.input.bytes()
            || original.epoch != captured.prepared.epoch
            || !Arc::ptr_eq(&original.member_binding, &captured.prepared.member_binding)
        {
            return Err(denied());
        }
        let permit = original.authorization.get_or_init(|| McpTermQueryPermit {
            epoch: original.epoch.clone(),
            input: original.input.clone(),
            deadline: captured.deadline,
            active: original.active.clone(),
            store_live: original.store_live.clone(),
            runtime: Arc::default(),
            expires_at_ms: original.preview.request.expires_at_ms,
        });
        if permit.deadline != captured.deadline {
            return Err(denied());
        }
        let sealed = PreparedMemberMcpTermQuery {
            captured: captured.clone(),
            permit: permit.clone(),
        };
        check_prepared(self.connection().map_err(|_| denied())?, &sealed)?;
        Ok(sealed)
    }
    pub fn read_member_mcp_term_query_result(
        &self,
        dispatch: &DispatchRequest,
        captured: &CapturedMemberMcpTermQuery,
    ) -> Result<Option<MemberMcpTermQueryResult>, ExecutionError> {
        self.check_member_mcp_term_query(dispatch, captured)?;
        let c = self.connection().map_err(|_| denied())?;
        let result = super::super::review::read_snapshot(c, |c| {
            let attempt = captured.preview().request.attempt_id;
            let present: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                    [attempt.to_string()],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            if !present {
                return Ok(None);
            }
            let input = super::super::ledger::load_input(c, attempt)?;
            if input.bytes() != captured.prepared.input.bytes()
                || validate_input(c, &input)? != association(captured)
            {
                return Err(denied());
            }
            let item = input.envelope().items[0].item_id;
            let (execution,validation,result):(String,String,Option<String>)=c.query_row("SELECT execution,validation,current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",params![attempt.to_string(),item.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
            if execution == "queued" || execution == "dispatched" {
                return Ok(None);
            }
            if execution == "unknown" {
                return Err(err(ErrorCode::OutcomeUnknown, "member-mcp-result"));
            }
            if execution != "succeeded" || validation != "valid" {
                return Err(err(ErrorCode::OutputInvalid, "member-mcp-result"));
            }
            let fixed = super::super::ledger::load_result(
                c,
                &input,
                ExecutionId::parse(&result.ok_or_else(denied)?)?,
            )?;
            let output = super::super::mcp::validate_query_output(&input, &fixed)?;
            Ok(Some(MemberMcpTermQueryResult::UntrustedMcpTerms {
                task_id: input.envelope().task_id,
                attempt_id: attempt,
                input_digest: input.digest().into(),
                item_id: item,
                result_id: fixed.envelope().result_id,
                result_digest: fixed.digest().into(),
                output,
            }))
        })?;
        self.check_member_mcp_term_query(dispatch, captured)?;
        Ok(result)
    }
    pub(crate) fn check_prepared_member_mcp_term_query(
        &self,
        sealed: &PreparedMemberMcpTermQuery,
    ) -> Result<(), ExecutionError> {
        self.check_work_plan_agent_scope(&sealed.captured.scope)?;
        check_prepared(self.connection().map_err(|_| denied())?, sealed)
    }
}
