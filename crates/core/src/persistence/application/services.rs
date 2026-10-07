//! Component generation delegates to the original work-plan ledger and budget.
//! Channel receipts preserve provenance; only the original live grant can execute.
use super::{ProjectStore, control};
use crate::execution::plugin_authority::{PluginAuthority, ServiceOriginGuard, plugin_now_ms};
use crate::{application::*, execution::*};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};
use tsumugi_plugin_sdk as sdk;

pub(super) const TABLE: (&str, &str) = (
    "application_service_calls",
    "CREATE TABLE application_service_calls (child_attempt TEXT PRIMARY KEY NOT NULL REFERENCES execution_attempts(attempt_id), outer_attempt TEXT NOT NULL REFERENCES execution_attempts(attempt_id), outer_item TEXT NOT NULL, outer_dispatch TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES plugin_execution_grants(grant_id), handle_id TEXT NOT NULL CHECK(length(handle_id) BETWEEN 1 AND 128), call_id TEXT NOT NULL CHECK(length(call_id) BETWEEN 1 AND 128), origin BLOB NOT NULL CHECK(length(origin) BETWEEN 1 AND 4194304), origin_digest TEXT NOT NULL CHECK(length(origin_digest)=64), call BLOB NOT NULL CHECK(length(call) BETWEEN 1 AND 4194304), call_digest TEXT NOT NULL CHECK(length(call_digest)=64), UNIQUE(outer_attempt,outer_item,outer_dispatch,handle_id,call_id))",
);

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    fail(ErrorCode::StorageFailed, "service-call-storage")
}
fn corrupt() -> ExecutionError {
    fail(ErrorCode::CorruptLedger, "service-call-association")
}

/// Reconciliation identifies the original invocation and call, not a new attempt.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanServiceCallIdentity {
    pub outer_attempt_id: ExecutionId,
    pub outer_item_id: ExecutionId,
    pub outer_dispatch_id: ExecutionId,
    pub handle_id: String,
    pub call_id: String,
}

/// SDK payload bytes remain independent of the outer invocation input digest.
/// The generation payload is decoded as the original bounded Agent proposal.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanServiceCall {
    pub handle_id: String,
    pub call_id: String,
    pub input: sdk::EncodedPayload,
}
impl WorkPlanServiceCall {
    fn validate(
        &self,
        binding: &sdk::ServiceBinding,
        context: &sdk::InvocationContext,
    ) -> Result<AgentGenerationRequest, ExecutionError> {
        sdk::ServiceRequest {
            call_id: self.call_id.clone(),
            handle_id: self.handle_id.clone(),
            context: context.clone(),
            input: self.input.clone(),
        }
        .validate_against(binding, context)
        .map_err(|_| fail(ErrorCode::InvalidInput, "service-call-input"))?;
        sdk::validate_generation_service_binding(binding)
            .map_err(|_| fail(ErrorCode::InvalidInput, "service-generation-contract"))?;
        let generation = sdk::parse_generation_service_input(self.input.utf8.as_bytes())
            .map_err(|_| fail(ErrorCode::InvalidInput, "service-call-input"))?;
        Ok(AgentGenerationRequest {
            task_id: ExecutionId::parse(&generation.task_id)?,
            attempt_id: ExecutionId::parse(&generation.attempt_id)?,
            unit_ids: generation
                .unit_ids
                .iter()
                .map(|id| ExecutionId::parse(id))
                .collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanServiceReceipt {
    pub identity: WorkPlanServiceCallIdentity,
    pub grant_id: ExecutionId,
    pub lease: AutomationLease,
    pub parent_task: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginRecord {
    project_id: ExecutionId,
    lease: AutomationLease,
    parent_task: ExecutionId,
    caller_id: ExecutionId,
    outer_input_digest: String,
    invocation: sdk::InvocationRequest,
    service: sdk::ServiceBinding,
    grant_id: ExecutionId,
    grant_generation: ExecutionId,
    grant_expires_at_ms: u64,
    deadline_at_ms: u64,
}

/// Captured by the trusted per-dispatch adapter. It has no renewal or restore API.
#[derive(Clone, Debug)]
pub struct WorkPlanServiceOrigin {
    scope: WorkPlanAgentScope,
    record: OriginRecord,
    outer: FixedInput,
    guard: Arc<ServiceOriginGuard>,
}
impl WorkPlanServiceOrigin {
    pub fn deadline(&self) -> Instant {
        self.guard.deadline
    }
    /// The platform can revoke on an installed-settings change; revocation is one-way.
    pub fn revocation(&self) -> Cancellation {
        self.guard.revoked.clone()
    }
    pub fn identity(
        &self,
        call: &WorkPlanServiceCall,
    ) -> Result<WorkPlanServiceCallIdentity, ExecutionError> {
        call.validate(&self.record.service, &self.record.invocation.context)?;
        Ok(WorkPlanServiceCallIdentity {
            outer_attempt_id: ExecutionId::parse(&self.record.invocation.context.attempt_id)?,
            outer_item_id: ExecutionId::parse(&self.record.invocation.context.item_id)?,
            outer_dispatch_id: ExecutionId::parse(&self.record.invocation.context.dispatch_id)?,
            handle_id: call.handle_id.clone(),
            call_id: call.call_id.clone(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct PreparedWorkPlanServiceGeneration {
    pub(crate) origin: WorkPlanServiceOrigin,
    pub(crate) call: WorkPlanServiceCall,
    pub(crate) input: FixedInput,
}
impl PreparedWorkPlanServiceGeneration {
    pub fn input(&self) -> &FixedInput {
        &self.input
    }
    pub fn parent_task(&self) -> ExecutionId {
        self.origin.scope.parent_task()
    }
    pub fn identity(&self) -> Result<WorkPlanServiceCallIdentity, ExecutionError> {
        self.origin.identity(&self.call)
    }
}

fn validate_origin(c: &Connection, record: &OriginRecord) -> Result<FixedInput, ExecutionError> {
    let invocation = &record.invocation;
    invocation.validate().map_err(|_| corrupt())?;
    record.service.validate().map_err(|_| corrupt())?;
    if record.service.project_id != invocation.context.project_id
        || record.service.scope_id != invocation.context.scope_id
    {
        return Err(corrupt());
    }
    let attempt = ExecutionId::parse(&invocation.context.attempt_id)?;
    let outer = super::super::ledger::load_input(c, attempt)?;
    if outer.envelope().automation.is_some()
        || outer.envelope().plugin.is_none()
        || outer.digest() != record.outer_input_digest
        || outer.envelope().project_id != record.project_id
    {
        return Err(corrupt());
    }
    let item = ExecutionId::parse(&invocation.context.item_id)?;
    let dispatch = ExecutionId::parse(&invocation.context.dispatch_id)?;
    let mut expected = outer.plugin_request(item, dispatch, &invocation.provider)?;
    // The actual Host may narrow its complete frame limit; it cannot widen it.
    if invocation.max_result_bytes == 0 || invocation.max_result_bytes > expected.max_result_bytes {
        return Err(corrupt());
    }
    expected.max_result_bytes = invocation.max_result_bytes;
    if *invocation != expected {
        return Err(corrupt());
    }
    let token: Option<String> = c
        .query_row(
            "SELECT dispatch_token FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
            params![attempt.to_string(), item.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let grant: (String, String, String, i64, Option<Vec<u8>>) = c.query_row(
        "SELECT attempt_id,input_digest,generation,expires_at_ms,delegation FROM plugin_execution_grants WHERE grant_id=?1",
        [record.grant_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(sql)?;
    if token.as_deref() != Some(invocation.context.dispatch_id.as_str())
        || grant.0 != invocation.context.attempt_id
        || grant.1 != outer.digest()
        || grant.2 != record.grant_generation.to_string()
        || u64::try_from(grant.3).ok() != Some(record.grant_expires_at_ms)
        || grant.4.is_some()
        || record.deadline_at_ms == 0
        || record.deadline_at_ms > record.grant_expires_at_ms
    {
        return Err(corrupt());
    }
    check_permission(&outer, &record.service)?;
    Ok(outer)
}

fn check_origin(
    c: &Connection,
    origin: &WorkPlanServiceOrigin,
    authority: &PluginAuthority,
) -> Result<(), ExecutionError> {
    if !origin.guard.live() || plugin_now_ms()? >= origin.record.deadline_at_ms {
        origin.guard.revoked.request();
        return Err(fail(ErrorCode::Unauthorized, "service-origin-expired"));
    }
    let outer = validate_origin(c, &origin.record)?;
    if outer.bytes() != origin.outer.bytes() {
        return Err(corrupt());
    }
    let permit = super::super::plugin_execution::check_input_in(c, &outer, authority)?
        .ok_or_else(|| fail(ErrorCode::Unauthorized, "service-origin-grant"))?;
    if permit.grant_id() != origin.record.grant_id {
        return Err(corrupt());
    }
    Ok(())
}

fn load_call(
    c: &Connection,
    identity: &WorkPlanServiceCallIdentity,
) -> Result<Option<(FixedInput, OriginRecord, WorkPlanServiceCall, String)>, ExecutionError> {
    let row: Option<(String, Vec<u8>, String, Vec<u8>, String, String)> = c.query_row(
        "SELECT child_attempt,origin,origin_digest,call,call_digest,grant_id FROM application_service_calls WHERE outer_attempt=?1 AND outer_item=?2 AND outer_dispatch=?3 AND handle_id=?4 AND call_id=?5",
        params![identity.outer_attempt_id.to_string(), identity.outer_item_id.to_string(), identity.outer_dispatch_id.to_string(), identity.handle_id, identity.call_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).optional().map_err(sql)?;
    let Some((child, origin, origin_digest, call, call_digest, grant_id)) = row else {
        return Ok(None);
    };
    if codec::digest(&origin) != origin_digest || codec::digest(&call) != call_digest {
        return Err(corrupt());
    }
    let record: OriginRecord = codec::decode(&origin, MAX_INPUT_BYTES)?;
    let call: WorkPlanServiceCall = codec::decode(&call, MAX_INPUT_BYTES)?;
    let generation = call.validate(&record.service, &record.invocation.context)?;
    let outer = validate_origin(c, &record)?;
    check_permission(&outer, &record.service)?;
    let input = super::super::ledger::load_input(c, ExecutionId::parse(&child)?)?;
    let plan = control::load(c, record.lease.plan_id)?.plan;
    let expected = derive_historical(&plan, &record, &generation)?;
    if input.bytes() != expected.bytes()
        || grant_id != record.grant_id.to_string()
        || identity.outer_attempt_id.to_string() != record.invocation.context.attempt_id
        || identity.outer_item_id.to_string() != record.invocation.context.item_id
        || identity.outer_dispatch_id.to_string() != record.invocation.context.dispatch_id
        || identity.handle_id != call.handle_id
        || identity.call_id != call.call_id
    {
        return Err(corrupt());
    }
    let parent: Option<String> = c
        .query_row(
            "SELECT parent_id FROM execution_budgets WHERE task_id=?1",
            [input.envelope().task_id.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if parent.as_deref() != Some(record.parent_task.to_string().as_str()) {
        return Err(corrupt());
    }
    let association: (String, i64, String, Option<Vec<u8>>, String) = c.query_row(
        "SELECT plan_id,generation,kind,delegation,root_task FROM application_executions WHERE attempt_id=?1",
        [&child], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(sql)?;
    if association
        != (
            record.lease.plan_id.to_string(),
            i64::try_from(record.lease.generation.get()).map_err(|_| corrupt())?,
            "model".into(),
            None,
            record.parent_task.to_string(),
        )
    {
        return Err(corrupt());
    }
    Ok(Some((input, record, call, origin_digest)))
}

fn check_permission(
    outer: &FixedInput,
    service: &sdk::ServiceBinding,
) -> Result<(), ExecutionError> {
    let capability = &outer
        .envelope()
        .plugin
        .as_ref()
        .ok_or_else(corrupt)?
        .capability
        .declaration;
    if capability.effect != sdk::EffectKind::External || service.effect != sdk::EffectKind::External || !capability.permissions.iter().any(|permission|
        matches!(permission, sdk::PermissionRequest::ProjectService { contract } if contract == &service.contract))
    { return Err(fail(ErrorCode::Unauthorized, "service-call-permission")); }
    Ok(())
}

fn derive_historical(
    plan: &WorkPlan,
    origin: &OriginRecord,
    request: &AgentGenerationRequest,
) -> Result<FixedInput, ExecutionError> {
    let scope = WorkPlanAgentScope {
        project_id: origin.project_id,
        lease: origin.lease,
        parent_task: origin.parent_task,
        caller_id: origin.caller_id,
        store_epoch: String::new(),
    };
    if plan.execution_input()?.task_id != origin.parent_task
        || plan.execution_input()?.project_id != origin.project_id
    {
        return Err(corrupt());
    }
    control::derive_agent_generation(plan, &scope, request)
}

fn receipt(
    identity: WorkPlanServiceCallIdentity,
    input: &FixedInput,
    origin: &OriginRecord,
) -> WorkPlanServiceReceipt {
    WorkPlanServiceReceipt {
        identity,
        grant_id: origin.grant_id,
        lease: origin.lease,
        parent_task: origin.parent_task,
        task_id: input.envelope().task_id,
        attempt_id: input.envelope().attempt_id,
        input_digest: input.digest().into(),
    }
}

impl ProjectStore {
    /// Only a true dispatch can capture this origin. Outcome-query data has no
    /// absolute deadline and cannot create or renew a service authorization.
    /// The trusted installation owner supplies its original one-way revocation
    /// signal under the same revision guard as the selected service. It stays
    /// attached after channel completion; no project-thread tick is required.
    pub fn capture_work_plan_service_origin(
        &self,
        scope: &WorkPlanAgentScope,
        dispatch: &DispatchRequest,
        invocation: &sdk::InvocationRequest,
        service: &sdk::ServiceBinding,
        host_deadline: Instant,
        cancellation: &Cancellation,
        settings_revocation: &Cancellation,
    ) -> Result<WorkPlanServiceOrigin, ExecutionError> {
        self.check_work_plan_agent_scope(scope)?;
        let permit = dispatch
            .plugin_permit()
            .filter(|permit| {
                permit.matches(&dispatch.input)
                    && permit.is_authorized()
                    && !permit.is_work_plan_tool()
            })
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "service-origin-dispatch"))?;
        let original = dispatch
            .original_deadline
            .as_ref()
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "service-origin-deadline"))?;
        if dispatch.input.envelope().plugin.is_none()
            || dispatch.input.envelope().automation.is_some()
            || dispatch.input.envelope().project_id != scope.project_id()
            || invocation.context.attempt_id != dispatch.input.envelope().attempt_id.to_string()
            || invocation.context.item_id != dispatch.item_id.to_string()
            || invocation.context.dispatch_id != dispatch.dispatch_token.to_string()
        {
            return Err(fail(ErrorCode::Unauthorized, "service-origin-dispatch"));
        }
        check_permission(&dispatch.input, service)?;
        sdk::validate_generation_service_binding(service)
            .map_err(|_| fail(ErrorCode::InvalidInput, "service-generation-contract"))?;
        let deadline = original
            .instant
            .min(host_deadline)
            .min(permit.original_deadline());
        let narrowed = original
            .instant
            .saturating_duration_since(deadline)
            .as_millis();
        let narrowed = u64::try_from(narrowed)
            .map_err(|_| fail(ErrorCode::InvalidInput, "service-origin-deadline"))?;
        let record = OriginRecord {
            project_id: scope.project_id(),
            lease: scope.lease(),
            parent_task: scope.parent_task(),
            caller_id: scope.caller_id(),
            outer_input_digest: dispatch.input.digest().into(),
            invocation: invocation.clone(),
            service: service.clone(),
            grant_id: permit.grant_id(),
            grant_generation: permit.generation(),
            grant_expires_at_ms: permit.expires_at_ms(),
            deadline_at_ms: original
                .expires_at_ms
                .saturating_sub(narrowed)
                .min(permit.expires_at_ms()),
        };
        let digest = codec::digest(&codec::encode(&record, MAX_INPUT_BYTES)?);
        let origin = WorkPlanServiceOrigin {
            scope: scope.clone(),
            record,
            outer: dispatch.input.clone(),
            guard: Arc::new(ServiceOriginGuard {
                permit: permit.clone(),
                cancellation: cancellation.clone(),
                settings_revocation: settings_revocation.clone(),
                revoked: Cancellation::default(),
                deadline,
                digest,
            }),
        };
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        check_origin(c, &origin, &self.plugin_authority)?;
        Ok(origin)
    }

    pub fn prepare_work_plan_service_generation(
        &self,
        origin: &WorkPlanServiceOrigin,
        call: &WorkPlanServiceCall,
    ) -> Result<PreparedWorkPlanServiceGeneration, ExecutionError> {
        let generation =
            call.validate(&origin.record.service, &origin.record.invocation.context)?;
        check_permission(&origin.outer, &origin.record.service)?;
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        super::super::review::read_snapshot(c, |_| {
            if let Some((input, record, original_call, _)) = load_call(c, &origin.identity(call)?)?
            {
                if record != origin.record || original_call != *call {
                    return Err(fail(ErrorCode::ResultMismatch, "service-call-identity"));
                }
                return Ok(PreparedWorkPlanServiceGeneration {
                    origin: origin.clone(),
                    call: call.clone(),
                    input,
                });
            }
            check_origin(c, origin, &self.plugin_authority)?;
            let input = self.prepare_work_plan_agent_generation(&origin.scope, &generation)?;
            Ok(PreparedWorkPlanServiceGeneration {
                origin: origin.clone(),
                call: call.clone(),
                input,
            })
        })
    }

    /// Check the original sealed preparation before its first child enqueue.
    /// This performs no writes and creates no execution or effect authority.
    /// An already accepted child must be reconciled through its durable receipt;
    /// it cannot establish new session-local effect tracking from history.
    pub fn check_prepared_work_plan_service_generation(
        &self,
        prepared: &PreparedWorkPlanServiceGeneration,
    ) -> Result<(), ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        super::super::review::read_snapshot(c, |_| {
            check_prepared(c, prepared, &self.plugin_authority)?;
            if self
                .execution_input_if_present(prepared.input.envelope().attempt_id)?
                .is_some()
            {
                return Err(fail(ErrorCode::Unauthorized, "service-child-enqueued"));
            }
            Ok(())
        })
    }

    /// Read durable bytes first. A historical receipt never reactivates its grant.
    pub fn work_plan_service_receipt(
        &self,
        identity: &WorkPlanServiceCallIdentity,
        call: &WorkPlanServiceCall,
    ) -> Result<Option<WorkPlanServiceReceipt>, ExecutionError> {
        codec::encode(call, MAX_INPUT_BYTES)?;
        if call.call_id != identity.call_id || call.handle_id != identity.handle_id {
            return Err(fail(ErrorCode::ResultMismatch, "service-call-identity"));
        }
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        super::super::review::read_snapshot(c, |_| {
            load_call(c, identity)?
                .map(|(input, origin, original, _)| {
                    if original != *call {
                        return Err(fail(ErrorCode::ResultMismatch, "service-call-identity"));
                    }
                    Ok(receipt(identity.clone(), &input, &origin))
                })
                .transpose()
        })
    }

    /// Call after the child execution and its authorized effects are terminal.
    /// Channel closure alone is not a terminal state for a durable child.
    pub fn release_work_plan_service_origin(
        &self,
        attempt: ExecutionId,
    ) -> Result<(), ExecutionError> {
        self.plugin_authority.release_service_origin(attempt)
    }
}

pub(in crate::persistence) fn check_prepared(
    c: &Connection,
    prepared: &PreparedWorkPlanServiceGeneration,
    authority: &PluginAuthority,
) -> Result<(), ExecutionError> {
    check_origin(c, &prepared.origin, authority)?;
    check_permission(&prepared.origin.outer, &prepared.origin.record.service)?;
    let generation = prepared.call.validate(
        &prepared.origin.record.service,
        &prepared.origin.record.invocation.context,
    )?;
    let plan = control::load(c, prepared.origin.scope.lease().plan_id)?.plan;
    if derive_historical(&plan, &prepared.origin.record, &generation)?.bytes()
        != prepared.input.bytes()
    {
        return Err(corrupt());
    }
    control::check_enqueue(c, &prepared.input, Some(prepared.parent_task()))
}

pub(in crate::persistence) fn record_call(
    c: &Connection,
    prepared: &PreparedWorkPlanServiceGeneration,
) -> Result<(), ExecutionError> {
    let identity = prepared.identity()?;
    let origin = codec::encode(&prepared.origin.record, MAX_INPUT_BYTES)?;
    let call = codec::encode(&prepared.call, MAX_INPUT_BYTES)?;
    c.execute(
        "INSERT INTO application_service_calls VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            prepared.input.envelope().attempt_id.to_string(),
            identity.outer_attempt_id.to_string(),
            identity.outer_item_id.to_string(),
            identity.outer_dispatch_id.to_string(),
            prepared.origin.record.grant_id.to_string(),
            identity.handle_id,
            identity.call_id,
            origin,
            codec::digest(&origin),
            call,
            codec::digest(&call)
        ],
    )
    .map_err(sql)?;
    Ok(())
}

pub(in crate::persistence) fn activate(
    authority: &PluginAuthority,
    prepared: &PreparedWorkPlanServiceGeneration,
) -> Result<(), ExecutionError> {
    authority.register_service_origin(
        prepared.input.envelope().attempt_id,
        prepared.origin.guard.clone(),
    )
}

pub(in crate::persistence) fn check_input(
    c: &Connection,
    input: &FixedInput,
    authority: &PluginAuthority,
) -> Result<(), ExecutionError> {
    let identity: Option<WorkPlanServiceCallIdentity> = c.query_row(
        "SELECT s.outer_attempt,s.outer_item,s.outer_dispatch,s.handle_id,s.call_id FROM application_service_calls s JOIN execution_attempts a ON a.attempt_id=s.child_attempt WHERE a.task_id=?1",
        [input.envelope().task_id.to_string()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
    ).optional().map_err(sql)?.map(|(attempt, item, dispatch, handle_id, call_id)| Ok::<_, ExecutionError>(WorkPlanServiceCallIdentity {
        outer_attempt_id: ExecutionId::parse(&attempt)?, outer_item_id: ExecutionId::parse(&item)?,
        outer_dispatch_id: ExecutionId::parse(&dispatch)?, handle_id, call_id,
    })).transpose()?;
    let Some(identity) = identity else {
        return Ok(());
    };
    let (stored_input, origin, _, digest) = load_call(c, &identity)?.ok_or_else(corrupt)?;
    if input.envelope().attempt_id != stored_input.envelope().attempt_id {
        return Err(fail(ErrorCode::Unauthorized, "service-child-retry"));
    }
    if input.bytes() != stored_input.bytes() {
        return Err(corrupt());
    }
    authority.check_service_origin(input.envelope().attempt_id, &digest)?;
    if plugin_now_ms()? >= origin.deadline_at_ms {
        return Err(fail(ErrorCode::Unauthorized, "service-origin-expired"));
    }
    let outer = validate_origin(c, &origin)?;
    let permit = super::super::plugin_execution::check_input_in(c, &outer, authority)?
        .ok_or_else(|| fail(ErrorCode::Unauthorized, "service-origin-grant"))?;
    if permit.grant_id() != origin.grant_id {
        return Err(corrupt());
    }
    Ok(())
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let mut statement = c.prepare("SELECT outer_attempt,outer_item,outer_dispatch,handle_id,call_id FROM application_service_calls").map_err(sql)?;
    for row in statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(sql)?
    {
        let (attempt, item, dispatch, handle_id, call_id) = row.map_err(sql)?;
        let identity = WorkPlanServiceCallIdentity {
            outer_attempt_id: ExecutionId::parse(&attempt)?,
            outer_item_id: ExecutionId::parse(&item)?,
            outer_dispatch_id: ExecutionId::parse(&dispatch)?,
            handle_id,
            call_id,
        };
        load_call(c, &identity)?.ok_or_else(corrupt)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
