//! Exact queries selected before the caller's independent process consent.
//! Their execution remains owned by the original WorkPlan tool boundary.
use super::*;
use std::collections::BTreeSet;
use std::sync::Mutex;
use tsumugi_core::application::{AgentToolRequest, PreparedWorkPlanTool, WorkPlanToolSpec};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanGenerationToolPreflight {
    pub query: AgentToolRequest,
    pub handle_id: String,
    pub call_id: String,
    pub input_digest: String,
    pub tool: WorkPlanToolSpec,
    pub input: sdk::EncodedPayload,
}

#[derive(Clone)]
pub(super) struct PreparedTool {
    pub prepared: Arc<PreparedWorkPlanTool>,
    pub view: WorkPlanGenerationToolPreflight,
}

pub(super) type LoadedTool = (UnsignedDecimal, Arc<RunnerProxy>, PluginExecutionBinding);

pub(super) fn prepare(
    store: &ProjectStore,
    scope: &WorkPlanAgentScope,
    request: &WorkPlanGenerationPrepareRequest,
) -> Result<Vec<PreparedTool>, CommandError> {
    if request.tool_queries.len() > sdk::MAX_PREPARED_TOOL_SERVICE_CALLS {
        return Err(limit());
    }
    let mut handles = BTreeSet::new();
    let mut identities = BTreeSet::from([
        request.attempt_id,
        ExecutionId::parse(&request.generation.task_id).map_err(map_recover)?,
        ExecutionId::parse(&request.generation.attempt_id).map_err(map_recover)?,
        scope.parent_task(),
    ]);
    request
        .tool_queries
        .iter()
        .enumerate()
        .map(|(index, query)| {
            if query.unit_ids.len() != 1
                || !request
                    .generation
                    .unit_ids
                    .contains(&query.unit_ids[0].to_string())
                || !handles.insert(query.tool_handle)
                || !identities.insert(query.task_id)
                || !identities.insert(query.attempt_id)
            {
                return Err(mismatch());
            }
            let prepared = store
                .prepare_work_plan_agent_tool(scope, query)
                .map(Arc::new)
                .map_err(map_recover)?;
            let tool = prepared.tool();
            let supported_scope = matches!(
                (&tool.execution.component_scope, &tool.execution.environment),
                (
                    sdk::ComponentScope::Project,
                    sdk::ExecutionEnvironmentDescriptor::Captured(_)
                ) | (
                    sdk::ComponentScope::Application,
                    sdk::ExecutionEnvironmentDescriptor::Captured(_)
                        | sdk::ExecutionEnvironmentDescriptor::Native(_)
                )
            );
            if !supported_scope
                || tool.binding.capability.declaration.effect != sdk::EffectKind::ReadOnly
                || tool.binding.capability.declaration.contract
                    == sdk::generation_service_contract()
                || prepared.input().envelope().items.len() != 1
            {
                return Err(denied());
            }
            let input = prepared.input();
            let item = &input.envelope().items[0];
            let payload = sdk::EncodedPayload::capture(
                tool.binding.capability.declaration.input_schema.clone(),
                serde_json::to_string(&item.payload).map_err(|_| mismatch())?,
            )
            .map_err(|_| limit())?;
            let view = WorkPlanGenerationToolPreflight {
                query: query.clone(),
                handle_id: format!("prepared-tool-{index}"),
                call_id: query.attempt_id.to_string(),
                input_digest: input.digest().into(),
                tool: tool.clone(),
                input: payload,
            };
            Ok(PreparedTool { prepared, view })
        })
        .collect()
}

pub(super) fn component_input(
    request: &WorkPlanGenerationPrepareRequest,
    declaration: &sdk::CapabilityDeclaration,
    tools: &[PreparedTool],
) -> Result<serde_json::Value, CommandError> {
    if declaration.input_schema == sdk::generation_service_input_contract() {
        if !tools.is_empty() {
            return Err(denied());
        }
        return serde_json::to_value(&request.generation).map_err(|_| mismatch());
    }
    if declaration.input_schema != sdk::generation_component_input_contract() {
        return Err(mismatch());
    }
    let input = sdk::GenerationComponentInput {
        generation: request.generation.clone(),
        prepared_tools: tools
            .iter()
            .map(|tool| sdk::PreparedToolServiceCall {
                handle_id: tool.view.handle_id.clone(),
                call_id: tool.view.call_id.clone(),
                tool_handle: tool.view.query.tool_handle.to_string(),
                input: tool.view.input.clone(),
            })
            .collect(),
    };
    input.validate().map_err(|_| limit())?;
    serde_json::to_value(input).map_err(|_| mismatch())
}

pub(super) fn recapture(
    plugins: &ApplicationPlugins,
    tools: &[PreparedTool],
    revision: UnsignedDecimal,
) -> Result<Vec<LoadedTool>, CommandError> {
    tools
        .iter()
        .map(|tool| {
            let loaded = broker::load_runner(plugins, &tool.prepared)?;
            if loaded.0 != revision {
                return Err(super::super::super::review::checkers::stale());
            }
            Ok(loaded)
        })
        .collect()
}

pub(super) fn check_prepared(
    store: &ProjectStore,
    scope: &WorkPlanAgentScope,
    request: &WorkPlanGenerationPrepareRequest,
    expected: &[PreparedTool],
) -> Result<(), CommandError> {
    let current = prepare(store, scope, request)?;
    if current.len() != expected.len()
        || current.iter().zip(expected).any(|(current, expected)| {
            current.prepared.input().bytes() != expected.prepared.input().bytes()
        })
    {
        return Err(mismatch());
    }
    Ok(())
}

pub(super) fn bindings(
    prepared: &[PreparedTool],
    project: ExecutionId,
    caller_scope: &str,
    generation: u32,
    remaining_ms: u32,
) -> Result<Vec<sdk::ServiceBinding>, CommandError> {
    prepared
        .iter()
        .map(|tool| {
            let declaration = &tool.view.tool.binding.capability.declaration;
            let mut limits = declaration.limits.clone();
            limits.timeout_ms = limits.timeout_ms.min(remaining_ms).min(60_000);
            limits.concurrency = 1;
            let binding = sdk::ServiceBinding {
                handle_id: tool.view.handle_id.clone(),
                provider_id: format!("prepared-tool.{}", tool.view.query.tool_handle),
                contract: declaration.contract.clone(),
                input_schema: declaration.input_schema.clone(),
                output_schema: declaration.output_schema.clone(),
                error_schema: declaration.error_schema.clone(),
                effect: sdk::EffectKind::ReadOnly,
                project_id: project.to_string(),
                scope_id: caller_scope.into(),
                activation_generation: generation,
                configuration_digest: tool.view.input_digest.clone(),
                limits,
            };
            binding.validate().map_err(|_| mismatch())?;
            Ok(binding)
        })
        .collect()
}

pub(super) fn selected_bindings(
    input: &FixedInput,
    scope: &WorkPlanAgentScope,
    configuration_digest: &str,
    tools: &[PreparedTool],
    remaining_ms: u32,
) -> Result<Vec<sdk::ServiceBinding>, CommandError> {
    let envelope = input.envelope();
    let generation = scope
        .lease()
        .generation
        .get()
        .try_into()
        .map_err(|_| limit())?;
    let caller_scope = envelope
        .plugin
        .as_ref()
        .ok_or_else(denied)?
        .scope_id(envelope.project_id, envelope.attempt_id)
        .map_err(map_recover)?;
    let original = sdk::ServiceBinding {
        handle_id: "work-plan-generation".into(),
        provider_id: "tsumugi.core".into(),
        contract: sdk::generation_service_contract(),
        input_schema: sdk::generation_service_input_contract(),
        output_schema: sdk::generation_service_receipt_contract(),
        error_schema: sdk::generation_service_error_contract(),
        effect: sdk::EffectKind::External,
        project_id: envelope.project_id.to_string(),
        scope_id: caller_scope.clone(),
        activation_generation: generation,
        configuration_digest: configuration_digest.into(),
        limits: sdk::CapabilityLimits {
            timeout_ms: remaining_ms.min(60_000),
            max_input_bytes: sdk::MAX_GENERATION_SERVICE_INPUT_BYTES as u32,
            max_output_bytes: sdk::MAX_GENERATION_SERVICE_RECEIPT_BYTES as u32,
            concurrency: 1,
        },
    };
    sdk::validate_generation_service_binding(&original).map_err(|_| mismatch())?;
    let mut selected = vec![original];
    selected.extend(bindings(
        tools,
        envelope.project_id,
        &caller_scope,
        generation,
        remaining_ms,
    )?);
    sdk::validate_service_bindings(&selected).map_err(|_| mismatch())?;
    Ok(selected)
}

#[derive(Default)]
pub(super) struct ToolLifecycle {
    closed: Cancellation,
    calls: Mutex<Vec<ToolCall>>,
}
struct ToolCall {
    channel: ChannelReceipt,
    revoke: Cancellation,
    task: ExecutionId,
    attempt: ExecutionId,
    cancel_id: ExecutionId,
}

impl GenerationBroker {
    fn selected_tool(&self, request: &sdk::ServiceRequest) -> Result<&PreparedTool, CommandError> {
        let tool = self
            .start
            .prepared
            .tools
            .iter()
            .find(|tool| tool.view.handle_id == request.handle_id)
            .ok_or_else(mismatch)?;
        if request.call_id != tool.view.call_id || request.input != tool.view.input {
            return Err(mismatch());
        }
        Ok(tool)
    }

    fn enqueue_tool(
        &self,
        sessions: &mut SessionManager,
        caller: &ServiceCaller,
        binding: &sdk::ServiceBinding,
        request: &sdk::ServiceRequest,
        deadline: Instant,
    ) -> Result<(), CommandError> {
        let (host, store) = self.factory.original(sessions)?;
        let selected = self.selected_tool(request)?;
        request
            .validate_against(binding, caller.context())
            .map_err(|_| mismatch())?;
        let call = WorkPlanServiceCall {
            handle_id: request.handle_id.clone(),
            call_id: request.call_id.clone(),
            input: request.input.clone(),
        };
        let identity = WorkPlanServiceCallIdentity {
            outer_attempt_id: self.dispatch.input.envelope().attempt_id,
            outer_item_id: self.dispatch.item_id,
            outer_dispatch_id: self.dispatch.dispatch_token,
            handle_id: call.handle_id.clone(),
            call_id: call.call_id.clone(),
        };
        let grant = *self
            .start
            .tool_grants
            .get(&selected.view.query.attempt_id)
            .ok_or_else(denied)?;
        // A lost acknowledgement observes the same child and independent grant.
        // It cannot create a replacement identity or renew either authorization.
        if let Some(receipt) = store
            .work_plan_tool_service_receipt(&identity, &call)
            .map_err(map_recover)?
        {
            if receipt.grant_id != grant || receipt.input_digest != selected.view.input_digest {
                return Err(mismatch());
            }
            return Ok(());
        }
        if !self.live()
            || self.tool_lifecycle.closed.is_requested()
            || agent::scope(host, store, self.start.request.scope_id)? != self.scope
        {
            return Err(denied());
        }
        let revision = self.start.prepared.view.component.settings_revision;
        consent(
            host,
            store,
            &self.scope,
            &self.factory.context.plugins,
            revision,
        )?;
        let tool_consent = broker::current_consent(host, store, &self.scope)?;
        self.factory
            .context
            .plugins
            .with_environment_revision(revision, || {
                let origin = store
                    .capture_work_plan_tool_service_origin(
                        &self.scope,
                        &self.dispatch,
                        caller.invocation(),
                        binding,
                        deadline,
                        &self.cancellation,
                        &self.start.settings_revocation,
                    )
                    .map_err(map_recover)?;
                let prepared = store
                    .prepare_work_plan_service_tool(&origin, &call, &selected.prepared)
                    .map_err(map_recover)?;
                if prepared.identity().map_err(map_recover)? != identity {
                    return Err(mismatch());
                }
                let mut active = self.tool_lifecycle.calls.lock().map_err(|_| denied())?;
                if self.tool_lifecycle.closed.is_requested() || !self.live() {
                    origin.revocation().request();
                    return Err(denied());
                }
                active.push(ToolCall {
                    channel: caller.channel().clone(),
                    revoke: origin.revocation(),
                    task: selected.view.query.task_id,
                    attempt: selected.view.query.attempt_id,
                    cancel_id: ExecutionId::new(),
                });
                drop(active);
                match host.runtime.submit_work_plan_service_tool(
                    store,
                    &prepared,
                    &tool_consent,
                    grant,
                ) {
                    Ok(receipt)
                        if receipt.grant_id == grant
                            && receipt.input_digest == selected.view.input_digest =>
                    {
                        Ok(())
                    }
                    Ok(_) => Err(mismatch()),
                    Err(error) if error.code == ErrorCode::OutcomeUnknown => {
                        match store.work_plan_tool_service_receipt(&identity, &call) {
                            Ok(Some(receipt))
                                if receipt.grant_id == grant
                                    && receipt.input_digest == selected.view.input_digest =>
                            {
                                Ok(())
                            }
                            _ => Err(CommandError::unknown(CommandStage::ExecutionRecover)),
                        }
                    }
                    Err(error) => Err(map_recover(error)),
                }
            })
    }

    fn tool_outcome(
        &self,
        sessions: &mut SessionManager,
        request: &sdk::ServiceRequest,
    ) -> Result<Option<sdk::InvocationOutcome>, CommandError> {
        if !self.live() || self.tool_lifecycle.closed.is_requested() {
            return Err(denied());
        }
        let selected = self.selected_tool(request)?;
        let (host, store) = self.factory.original(sessions)?;
        if agent::scope(host, store, self.start.request.scope_id)? != self.scope {
            return Err(denied());
        }
        let input = selected.prepared.input();
        let attempt = input.envelope().attempt_id;
        let item = input.envelope().items[0].item_id;
        if host.runtime.has_owned_attempt_work(attempt) {
            return Ok(None);
        }
        if let Some(result_id) = store
            .execution_current_result(attempt, item)
            .map_err(map_recover)?
        {
            let result = store
                .read_work_plan_agent_tool_output(
                    &self.scope,
                    &selected.view.query,
                    &selected.view.input_digest,
                    item,
                    result_id,
                )
                .map_err(map_recover)?;
            let evidence = result.envelope().plugin.as_ref().ok_or_else(mismatch)?;
            if evidence.authorization_id
                != *self.start.tool_grants.get(&attempt).ok_or_else(denied)?
            {
                return Err(mismatch());
            }
            return Ok(Some(evidence.result.outcome.clone()));
        }
        let view = store
            .execution_attempt(attempt, false)
            .map_err(map_recover)?;
        if view.items.iter().all(|item| {
            !matches!(
                item.execution,
                ExecutionState::Queued | ExecutionState::Dispatched
            )
        }) {
            // Transport/authorization failure has no provider-owned error payload.
            // Never invent one under the selected tool's error schema.
            return Err(denied());
        }
        Ok(None)
    }

    pub(super) fn call_tool<'a>(
        &'a self,
        caller: ServiceCaller,
        binding: sdk::ServiceBinding,
        request: sdk::ServiceRequest,
    ) -> ProjectServiceFuture<'a> {
        let broker = self.clone();
        let callback = self.factory.context.callback.clone();
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(binding.limits.timeout_ms.into()))
            .unwrap_or(self.deadline)
            .min(caller.deadline())
            .min(self.deadline);
        Box::pin(async move {
            if !broker.bindings.contains(&binding)
                || request
                    .validate_against(&binding, caller.context())
                    .is_err()
                || broker.selected_tool(&request).is_err()
            {
                return Err(HostError::InvalidContract);
            }
            let current = broker.clone();
            let selected = binding.clone();
            let call = request.clone();
            callback
                .submit(
                    "generation-tool-service.enqueue",
                    CommandStage::ExecutionRecover,
                    move |sessions| {
                        current.enqueue_tool(sessions, &caller, &selected, &call, deadline)
                    },
                )
                .map_err(|_| HostError::AuthorityRevoked)?
                .await
                .map_err(|_| HostError::AuthorityRevoked)?;
            // Only a bounded read-only tool is awaited here. Model work retains
            // the original enqueue/receipt generation service path.
            loop {
                if Instant::now() >= deadline {
                    return Err(HostError::Timeout);
                }
                if !broker.live() || broker.tool_lifecycle.closed.is_requested() {
                    return Err(HostError::AuthorityRevoked);
                }
                let current = broker.clone();
                let call = request.clone();
                let outcome = callback
                    .submit(
                        "generation-tool-service.read",
                        CommandStage::ExecutionRead,
                        move |sessions| current.tool_outcome(sessions, &call),
                    )
                    .map_err(|_| HostError::AuthorityRevoked)?
                    .await
                    .map_err(|_| HostError::AuthorityRevoked)?;
                if let Some(outcome) = outcome {
                    let response = sdk::ServiceResponse {
                        call_id: request.call_id.clone(),
                        handle_id: request.handle_id.clone(),
                        context: request.context.clone(),
                        outcome,
                    };
                    response
                        .validate_against(&request, &binding)
                        .map_err(|_| HostError::ResultMismatch)?;
                    return Ok(response);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
    }

    pub(super) fn release_tools(&self, channel: &ChannelReceipt) {
        self.tool_lifecycle.closed.request();
        let Ok(calls) = self.tool_lifecycle.calls.lock() else {
            return;
        };
        let stops = calls
            .iter()
            .filter(|call| {
                call.channel.provider == channel.provider
                    && call.channel.scope == channel.scope
                    && call.channel.child_pid == channel.child_pid
            })
            .map(|call| {
                call.revoke.request();
                (call.task, call.attempt, call.cancel_id)
            })
            .collect::<Vec<_>>();
        drop(calls);
        if stops.is_empty() {
            return;
        }
        let factory = self.factory.clone();
        // This short owner callback requests cancellation. The original Runtime
        // retains each association until its real producer is terminal/reaped.
        let _ = self.factory.context.callback.submit(
            "generation-tool-service.release",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let (host, store) = factory.original(sessions)?;
                for (task, attempt, cancel_id) in stops {
                    if host.runtime.has_owned_attempt_work(attempt)
                        || store
                            .execution_attempt(attempt, false)
                            .map_err(map_recover)?
                            .items
                            .iter()
                            .any(|item| {
                                matches!(
                                    item.execution,
                                    ExecutionState::Queued | ExecutionState::Dispatched
                                )
                            })
                    {
                        host.runtime
                            .cancel(store, task, cancel_id)
                            .map_err(map_recover)?;
                    }
                }
                Ok(())
            },
        );
    }
}
