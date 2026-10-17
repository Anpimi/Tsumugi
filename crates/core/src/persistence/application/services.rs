//! Component generation delegates to the original work-plan ledger and budget.
//! Channel receipts preserve provenance; only the original live grant can execute.
use super::{ProjectStore, control};
use crate::execution::plugin_authority::{
    PackageKey, PluginAuthority, ServiceOriginGuard, plugin_now_ms,
};
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
    fn validate_request(
        &self,
        binding: &sdk::ServiceBinding,
        context: &sdk::InvocationContext,
    ) -> Result<(), ExecutionError> {
        sdk::ServiceRequest {
            call_id: self.call_id.clone(),
            handle_id: self.handle_id.clone(),
            context: context.clone(),
            input: self.input.clone(),
        }
        .validate_against(binding, context)
        .map_err(|_| fail(ErrorCode::InvalidInput, "service-call-input"))
    }
    fn validate(
        &self,
        binding: &sdk::ServiceBinding,
        context: &sdk::InvocationContext,
    ) -> Result<AgentGenerationRequest, ExecutionError> {
        self.validate_request(binding, context)?;
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

/// A query acknowledgement is separate from the generation service receipt.
/// Both grants identify original persisted facts, never renewable authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanToolServiceReceipt {
    pub identity: WorkPlanServiceCallIdentity,
    pub origin_grant_id: ExecutionId,
    pub grant_id: ExecutionId,
    pub lease: AutomationLease,
    pub parent_task: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ServiceKind {
    Generation,
    PluginTool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginRecord {
    kind: ServiceKind,
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
        match self.record.kind {
            ServiceKind::Generation => {
                call.validate(&self.record.service, &self.record.invocation.context)?;
            }
            ServiceKind::PluginTool => {
                call.validate_request(&self.record.service, &self.record.invocation.context)?;
            }
        }
        Ok(WorkPlanServiceCallIdentity {
            outer_attempt_id: ExecutionId::parse(&self.record.invocation.context.attempt_id)?,
            outer_item_id: ExecutionId::parse(&self.record.invocation.context.item_id)?,
            outer_dispatch_id: ExecutionId::parse(&self.record.invocation.context.dispatch_id)?,
            handle_id: call.handle_id.clone(),
            call_id: call.call_id.clone(),
        })
    }
}

/// One immutable, single-unit tool proposal associated with its original caller.
/// Only the existing tool consent and enqueue transaction can admit this input.
#[derive(Clone, Debug)]
pub struct PreparedWorkPlanServiceTool {
    pub(crate) origin: WorkPlanServiceOrigin,
    pub(crate) call: WorkPlanServiceCall,
    pub(crate) prepared: PreparedWorkPlanTool,
}
impl PreparedWorkPlanServiceTool {
    pub fn input(&self) -> &FixedInput {
        self.prepared.input()
    }
    pub fn tool(&self) -> &WorkPlanToolSpec {
        self.prepared.tool()
    }
    pub fn identity(&self) -> Result<WorkPlanServiceCallIdentity, ExecutionError> {
        self.origin.identity(&self.call)
    }
    pub fn original_caller_package(&self) -> (&sdk::PluginIdentity, &str) {
        let package = self.origin.guard.permit.original_package();
        (package.plugin(), package.digest())
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
    /// Read-only ownership from the original sealed dispatch, not a live grant.
    pub fn original_caller_package(&self) -> (&sdk::PluginIdentity, &str) {
        let package = self.origin.guard.permit.original_package();
        (package.plugin(), package.digest())
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
    check_origin_permission(&outer, record)?;
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
    validate_origin(c, &record)?;
    let input = super::super::ledger::load_input(c, ExecutionId::parse(&child)?)?;
    let plan = control::load(c, record.lease.plan_id)?.plan;
    if grant_id != record.grant_id.to_string()
        || identity.outer_attempt_id.to_string() != record.invocation.context.attempt_id
        || identity.outer_item_id.to_string() != record.invocation.context.item_id
        || identity.outer_dispatch_id.to_string() != record.invocation.context.dispatch_id
        || identity.handle_id != call.handle_id
        || identity.call_id != call.call_id
    {
        return Err(corrupt());
    }
    if record.kind == ServiceKind::PluginTool {
        let bytes: Vec<u8> = c
            .query_row(
                "SELECT delegation FROM application_executions WHERE attempt_id=?1 AND kind='tool'",
                [&child],
                |row| row.get(0),
            )
            .map_err(sql)?;
        let delegation: WorkPlanToolDelegation = codec::decode(&bytes, MAX_AGENT_DELEGATION_BYTES)?;
        if delegation.lease != record.lease
            || delegation.root_task != record.parent_task
            || delegation.caller_id != record.caller_id
            || delegation.delegation.is_some()
        {
            return Err(corrupt());
        }
        super::tools::validate_tool_input(c, &input, &delegation)?;
        let prepared = super::tools::derive(
            &plan,
            &historical_scope(&record),
            &AgentToolRequest {
                task_id: input.envelope().task_id,
                attempt_id: input.envelope().attempt_id,
                tool_handle: delegation.tool_handle,
                unit_ids: input
                    .envelope()
                    .items
                    .iter()
                    .map(|item| ExecutionId::parse(&item.scope.id))
                    .collect::<Result<_, _>>()?,
            },
        )?;
        check_tool_call(&record, &call, &prepared)?;
        return Ok(Some((input, record, call, origin_digest)));
    }
    let generation = call.validate(&record.service, &record.invocation.context)?;
    if input.bytes() != derive_historical(&plan, &record, &generation)?.bytes() {
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

fn project_javascript(binding: &PluginExecutionBinding) -> bool {
    binding.component_scope == sdk::ComponentScope::Project
        && binding.application_scope.is_none()
        && matches!(
            &binding.environment,
            sdk::ExecutionEnvironmentDescriptor::Captured(_)
        )
}

fn supported_prepared_tool(binding: &PluginExecutionBinding) -> bool {
    project_javascript(binding)
        || (binding.component_scope == sdk::ComponentScope::Application
            && binding.application_scope.is_some()
            && binding.validate().is_ok())
}

fn check_origin_permission(
    outer: &FixedInput,
    record: &OriginRecord,
) -> Result<(), ExecutionError> {
    if record.kind == ServiceKind::Generation {
        return check_permission(outer, &record.service);
    }
    let binding = outer.envelope().plugin.as_ref().ok_or_else(corrupt)?;
    let capability = &binding.capability.declaration;
    if !project_javascript(binding)
        || capability.effect != sdk::EffectKind::External
        || record.service.effect != sdk::EffectKind::ReadOnly
        || capability.input_schema != sdk::generation_component_input_contract()
        || capability.output_schema != sdk::generation_service_receipt_contract()
        || capability.error_schema != sdk::generation_service_error_contract()
        || !capability.permissions.iter().any(|permission| matches!(permission,
            sdk::PermissionRequest::ProjectService { contract } if contract == &record.service.contract))
    {
        return Err(fail(ErrorCode::Unauthorized, "service-tool-permission"));
    }
    sdk::parse_generation_component_input(record.invocation.input.utf8.as_bytes())
        .map_err(|_| fail(ErrorCode::InvalidInput, "service-component-input"))?;
    Ok(())
}

fn check_tool_call(
    record: &OriginRecord,
    call: &WorkPlanServiceCall,
    prepared: &PreparedWorkPlanTool,
) -> Result<(), ExecutionError> {
    if record.kind != ServiceKind::PluginTool {
        return Err(fail(ErrorCode::Unauthorized, "service-tool-kind"));
    }
    call.validate_request(&record.service, &record.invocation.context)?;
    let binding = prepared
        .input
        .envelope()
        .plugin
        .as_ref()
        .ok_or_else(corrupt)?;
    let declaration = &binding.capability.declaration;
    let service = &record.service;
    let component = sdk::parse_generation_component_input(record.invocation.input.utf8.as_bytes())
        .map_err(|_| fail(ErrorCode::InvalidInput, "service-component-input"))?;
    let frozen = component
        .prepared_tools
        .iter()
        .find(|tool| tool.handle_id == call.handle_id && tool.call_id == call.call_id)
        .ok_or_else(|| fail(ErrorCode::Unauthorized, "service-tool-selection"))?;
    if !supported_prepared_tool(binding)
        || declaration.effect != sdk::EffectKind::ReadOnly
        || service.contract != declaration.contract
        || service.input_schema != declaration.input_schema
        || service.output_schema != declaration.output_schema
        || service.error_schema != declaration.error_schema
        || service.limits.max_input_bytes != declaration.limits.max_input_bytes
        || service.limits.max_output_bytes != declaration.limits.max_output_bytes
        || service.limits.concurrency != 1
        || service.limits.concurrency > declaration.limits.concurrency
        || service.limits.timeout_ms == 0
        || service.limits.timeout_ms > declaration.limits.timeout_ms
        || service.configuration_digest != prepared.input.digest()
        || service.activation_generation as u64 != record.lease.generation.get()
        || service.provider_id != format!("prepared-tool.{}", prepared.tool.handle)
        || call.call_id != prepared.input.envelope().attempt_id.to_string()
        || prepared.scope.project_id != record.project_id
        || prepared.scope.lease != record.lease
        || prepared.scope.parent_task != record.parent_task
        || prepared.scope.caller_id != record.caller_id
        || prepared.scope.delegation.is_some()
        || prepared.request.unit_ids.len() != 1
        || prepared.input.envelope().items.len() != 1
        || !component
            .generation
            .unit_ids
            .contains(&prepared.request.unit_ids[0].to_string())
        || frozen.tool_handle != prepared.tool.handle.to_string()
        || frozen.input != call.input
    {
        return Err(fail(ErrorCode::ResultMismatch, "service-tool-input"));
    }
    let payload = sdk::EncodedPayload::capture(
        declaration.input_schema.clone(),
        String::from_utf8(codec::encode(
            &prepared.input.envelope().items[0].payload,
            declaration.limits.max_input_bytes as usize,
        )?)
        .map_err(|_| fail(ErrorCode::InvalidInput, "service-tool-input"))?,
    )
    .map_err(|_| fail(ErrorCode::InvalidInput, "service-tool-input"))?;
    if payload != call.input {
        return Err(fail(ErrorCode::ResultMismatch, "service-tool-input"));
    }
    Ok(())
}

fn historical_scope(origin: &OriginRecord) -> WorkPlanAgentScope {
    WorkPlanAgentScope {
        project_id: origin.project_id,
        lease: origin.lease,
        parent_task: origin.parent_task,
        caller_id: origin.caller_id,
        store_epoch: String::new(),
        delegation: None,
    }
}

fn derive_historical(
    plan: &WorkPlan,
    origin: &OriginRecord,
    request: &AgentGenerationRequest,
) -> Result<FixedInput, ExecutionError> {
    let scope = historical_scope(origin);
    if plan.execution_input()?.task_id != origin.parent_task
        || plan.execution_input()?.project_id != origin.project_id
    {
        return Err(corrupt());
    }
    control::derive_service_generation(plan, &scope, request)
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
    /// Resolve immutable service provenance for package shutdown. Revoked or
    /// historical calls remain attributable without regaining execution rights.
    pub(crate) fn work_plan_service_package(
        &self,
        input: &FixedInput,
    ) -> Result<Option<PackageKey>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        super::super::review::read_snapshot(c, |_| {
            let original = load_input_origin(c, input)?;
            let retained = self
                .plugin_authority
                .retained_service_origin(input.envelope().attempt_id)?;
            match original {
                None if retained.is_some() => Err(corrupt()),
                None => Ok(None),
                Some((origin, digest)) => {
                    let package = PackageKey::from_package(
                        &origin.invocation.provider.plugin,
                        &origin.invocation.provider.package_digest,
                    );
                    if retained.as_ref().is_some_and(|guard| {
                        guard.digest != digest || guard.permit.original_package() != &package
                    }) {
                        return Err(corrupt());
                    }
                    Ok(Some(package))
                }
            }
        })
    }

    /// A read-only query retains the original live guard, never reconstructing
    /// it from a durable service receipt after release or process reopen.
    pub(crate) fn work_plan_service_query_origin(
        &self,
        input: &FixedInput,
    ) -> Result<Option<Arc<ServiceOriginGuard>>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        super::super::review::read_snapshot(c, |_| {
            let original = load_input_origin(c, input)?;
            let guard = self
                .plugin_authority
                .service_origin(input.envelope().attempt_id)?;
            match original {
                None if guard.is_some() => Err(corrupt()),
                None => Ok(None),
                Some((origin, digest)) => {
                    let guard = guard
                        .ok_or_else(|| fail(ErrorCode::Unauthorized, "service-origin-query"))?;
                    if guard.digest != digest
                        || guard.permit.original_package()
                            != &PackageKey::from_package(
                                &origin.invocation.provider.plugin,
                                &origin.invocation.provider.package_digest,
                            )
                    {
                        return Err(corrupt());
                    }
                    Ok(Some(guard))
                }
            }
        })
    }

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
        self.capture_service_origin(
            scope,
            dispatch,
            invocation,
            service,
            host_deadline,
            cancellation,
            settings_revocation,
            ServiceKind::Generation,
        )
    }

    /// Capture the caller of a previously prepared read-only tool. This does
    /// not grant the tool process consent or create an execution attempt.
    pub fn capture_work_plan_tool_service_origin(
        &self,
        scope: &WorkPlanAgentScope,
        dispatch: &DispatchRequest,
        invocation: &sdk::InvocationRequest,
        service: &sdk::ServiceBinding,
        host_deadline: Instant,
        cancellation: &Cancellation,
        settings_revocation: &Cancellation,
    ) -> Result<WorkPlanServiceOrigin, ExecutionError> {
        self.capture_service_origin(
            scope,
            dispatch,
            invocation,
            service,
            host_deadline,
            cancellation,
            settings_revocation,
            ServiceKind::PluginTool,
        )
    }

    fn capture_service_origin(
        &self,
        scope: &WorkPlanAgentScope,
        dispatch: &DispatchRequest,
        invocation: &sdk::InvocationRequest,
        service: &sdk::ServiceBinding,
        host_deadline: Instant,
        cancellation: &Cancellation,
        settings_revocation: &Cancellation,
        kind: ServiceKind,
    ) -> Result<WorkPlanServiceOrigin, ExecutionError> {
        self.check_work_plan_agent_scope(scope)?;
        if scope.delegation().is_some() {
            return Err(fail(ErrorCode::Unauthorized, "service-agent-subset"));
        }
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
        if kind == ServiceKind::Generation {
            check_permission(&dispatch.input, service)?;
            sdk::validate_generation_service_binding(service)
                .map_err(|_| fail(ErrorCode::InvalidInput, "service-generation-contract"))?;
        }
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
            kind,
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
                retain_until_terminal: kind == ServiceKind::PluginTool,
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
        if origin.record.kind != ServiceKind::Generation {
            return Err(fail(ErrorCode::Unauthorized, "service-generation-kind"));
        }
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
            self.check_work_plan_agent_scope(&origin.scope)?;
            let plan = control::load(c, origin.scope.lease.plan_id)?.plan;
            self.verify_work_plan(&plan)?;
            let input = control::derive_service_generation(&plan, &origin.scope, &generation)?;
            control::check_enqueue(c, &input, Some(origin.scope.parent_task()))?;
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
                    if original != *call || origin.kind != ServiceKind::Generation {
                        return Err(fail(ErrorCode::ResultMismatch, "service-call-identity"));
                    }
                    Ok(receipt(identity.clone(), &input, &origin))
                })
                .transpose()
        })
    }

    pub fn prepare_work_plan_service_tool(
        &self,
        origin: &WorkPlanServiceOrigin,
        call: &WorkPlanServiceCall,
        prepared: &PreparedWorkPlanTool,
    ) -> Result<PreparedWorkPlanServiceTool, ExecutionError> {
        check_tool_call(&origin.record, call, prepared)?;
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        super::super::review::read_snapshot(c, |_| {
            if let Some((input, record, original, _)) = load_call(c, &origin.identity(call)?)? {
                if record != origin.record
                    || original != *call
                    || input.bytes() != prepared.input.bytes()
                {
                    return Err(fail(ErrorCode::ResultMismatch, "service-call-identity"));
                }
            } else {
                check_origin(c, origin, &self.plugin_authority)?;
                self.check_work_plan_agent_scope(&prepared.scope)?;
                let fresh =
                    self.prepare_work_plan_agent_tool(&prepared.scope, &prepared.request)?;
                if fresh.input.bytes() != prepared.input.bytes() || fresh.tool != prepared.tool {
                    return Err(fail(ErrorCode::ResultMismatch, "service-tool-input"));
                }
            }
            Ok(PreparedWorkPlanServiceTool {
                origin: origin.clone(),
                call: call.clone(),
                prepared: prepared.clone(),
            })
        })
    }

    /// A historical query ACK never restores either independent process grant.
    pub fn work_plan_tool_service_receipt(
        &self,
        identity: &WorkPlanServiceCallIdentity,
        call: &WorkPlanServiceCall,
    ) -> Result<Option<WorkPlanToolServiceReceipt>, ExecutionError> {
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
                    if original != *call || origin.kind != ServiceKind::PluginTool {
                        return Err(fail(ErrorCode::ResultMismatch, "service-call-identity"));
                    }
                    let grant: String = c
                        .query_row(
                            "SELECT grant_id FROM plugin_execution_grants WHERE attempt_id=?1",
                            [input.envelope().attempt_id.to_string()],
                            |row| row.get(0),
                        )
                        .map_err(sql)?;
                    Ok(WorkPlanToolServiceReceipt {
                        identity: identity.clone(),
                        origin_grant_id: origin.grant_id,
                        grant_id: ExecutionId::parse(&grant)?,
                        lease: origin.lease,
                        parent_task: origin.parent_task,
                        task_id: input.envelope().task_id,
                        attempt_id: input.envelope().attempt_id,
                        input_digest: input.digest().into(),
                    })
                })
                .transpose()
        })
    }

    pub fn check_prepared_work_plan_service_tool(
        &self,
        prepared: &PreparedWorkPlanServiceTool,
    ) -> Result<(), ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        super::super::review::read_snapshot(c, |_| {
            check_prepared_tool(c, prepared, &self.plugin_authority)?;
            if self
                .execution_input_if_present(prepared.input().envelope().attempt_id)?
                .is_some()
            {
                return Err(fail(ErrorCode::Unauthorized, "service-child-enqueued"));
            }
            self.check_work_plan_agent_scope(&prepared.prepared.scope)
        })
    }

    pub(crate) fn release_terminal_tool_service_origin(
        &mut self,
        input: &FixedInput,
    ) -> Result<(), ExecutionError> {
        if self
            .plugin_authority
            .retained_service_origin(input.envelope().attempt_id)?
            .is_none()
        {
            return Ok(());
        }
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
        if load_input_origin(c, input)?
            .is_some_and(|(origin, _)| origin.kind == ServiceKind::PluginTool)
        {
            if self
                .execution_attempt(input.envelope().attempt_id, false)?
                .items
                .iter()
                .any(|item| {
                    matches!(
                        item.execution,
                        ExecutionState::Queued | ExecutionState::Dispatched
                    )
                })
            {
                return Ok(());
            }
            let (grant, generation): (String, String) = c
                .query_row(
                    "SELECT grant_id,generation FROM plugin_execution_grants WHERE attempt_id=?1",
                    [input.envelope().attempt_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(sql)?;
            self.revoke_plugin_grant(
                ExecutionId::parse(&generation)?,
                ExecutionId::parse(&grant)?,
            )?;
            self.plugin_authority
                .release_service_origin(input.envelope().attempt_id)?;
        }
        Ok(())
    }

    /// Call after the child execution and its authorized effects are terminal.
    /// Channel closure alone is not a terminal state for a durable child.
    pub fn release_work_plan_service_origin(
        &self,
        attempt: ExecutionId,
    ) -> Result<(), ExecutionError> {
        if let Some(input) = self.execution_input_if_present(attempt)? {
            let c = self
                .connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "service-call-storage"))?;
            if load_input_origin(c, &input)?
                .is_some_and(|(record, _)| record.kind == ServiceKind::PluginTool)
            {
                return Err(fail(ErrorCode::Unauthorized, "service-tool-lifecycle"));
            }
        }
        self.plugin_authority.release_service_origin(attempt)
    }
}

pub(in crate::persistence) fn check_prepared(
    c: &Connection,
    prepared: &PreparedWorkPlanServiceGeneration,
    authority: &PluginAuthority,
) -> Result<(), ExecutionError> {
    if prepared.origin.record.kind != ServiceKind::Generation {
        return Err(fail(ErrorCode::Unauthorized, "service-generation-kind"));
    }
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

pub(in crate::persistence) fn check_prepared_tool(
    c: &Connection,
    prepared: &PreparedWorkPlanServiceTool,
    authority: &PluginAuthority,
) -> Result<(), ExecutionError> {
    check_origin(c, &prepared.origin, authority)?;
    check_tool_call(&prepared.origin.record, &prepared.call, &prepared.prepared)?;
    let plan = control::load(c, prepared.origin.record.lease.plan_id)?.plan;
    let expected =
        super::tools::derive(&plan, &prepared.prepared.scope, &prepared.prepared.request)?;
    if expected.input.bytes() != prepared.input().bytes() || expected.tool != prepared.prepared.tool
    {
        return Err(fail(ErrorCode::ResultMismatch, "service-tool-input"));
    }
    Ok(())
}

pub(in crate::persistence) fn record_call(
    c: &Connection,
    prepared: &PreparedWorkPlanServiceGeneration,
) -> Result<(), ExecutionError> {
    record_call_in(c, &prepared.origin, &prepared.call, &prepared.input)
}

pub(in crate::persistence) fn record_tool_call(
    c: &Connection,
    prepared: &PreparedWorkPlanServiceTool,
) -> Result<(), ExecutionError> {
    record_call_in(c, &prepared.origin, &prepared.call, prepared.input())
}

fn record_call_in(
    c: &Connection,
    original: &WorkPlanServiceOrigin,
    request: &WorkPlanServiceCall,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    let identity = original.identity(request)?;
    let origin = codec::encode(&original.record, MAX_INPUT_BYTES)?;
    let call = codec::encode(request, MAX_INPUT_BYTES)?;
    c.execute(
        "INSERT INTO application_service_calls VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            input.envelope().attempt_id.to_string(),
            identity.outer_attempt_id.to_string(),
            identity.outer_item_id.to_string(),
            identity.outer_dispatch_id.to_string(),
            original.record.grant_id.to_string(),
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

pub(in crate::persistence) fn activate_tool(
    authority: &PluginAuthority,
    prepared: &PreparedWorkPlanServiceTool,
) -> Result<(), ExecutionError> {
    authority.register_service_origin(
        prepared.input().envelope().attempt_id,
        prepared.origin.guard.clone(),
    )
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
    let Some((origin, digest)) = load_input_origin(c, input)? else {
        return Ok(());
    };
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

fn load_input_origin(
    c: &Connection,
    input: &FixedInput,
) -> Result<Option<(OriginRecord, String)>, ExecutionError> {
    let identity: Option<WorkPlanServiceCallIdentity> = c.query_row(
        "SELECT s.outer_attempt,s.outer_item,s.outer_dispatch,s.handle_id,s.call_id FROM application_service_calls s JOIN execution_attempts a ON a.attempt_id=s.child_attempt WHERE a.task_id=?1",
        [input.envelope().task_id.to_string()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
    ).optional().map_err(sql)?.map(|(attempt, item, dispatch, handle_id, call_id)| Ok::<_, ExecutionError>(WorkPlanServiceCallIdentity {
        outer_attempt_id: ExecutionId::parse(&attempt)?, outer_item_id: ExecutionId::parse(&item)?,
        outer_dispatch_id: ExecutionId::parse(&dispatch)?, handle_id, call_id,
    })).transpose()?;
    let Some(identity) = identity else {
        return Ok(None);
    };
    let (stored_input, origin, _, digest) = load_call(c, &identity)?.ok_or_else(corrupt)?;
    if input.envelope().attempt_id != stored_input.envelope().attempt_id {
        return Err(fail(ErrorCode::Unauthorized, "service-child-retry"));
    }
    if input.bytes() != stored_input.bytes() {
        return Err(corrupt());
    }
    Ok(Some((origin, digest)))
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
