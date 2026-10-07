//! Ordinary installed components delegate to the original work-plan service.
//! The cached factory is scope-neutral; each real dispatch captures its own plan.
use super::*;
use crate::commands::{
    ProjectServiceContext,
    plugins::{
        PluginGenerationComponentRequest, PluginGenerationComponentView,
        generation::GenerationComponentEnvironment,
    },
};
use tsumugi_core::{
    ProviderBudget,
    application::{
        AgentGenerationRequest, WorkPlanServiceCall, WorkPlanServiceCallIdentity,
        WorkPlanServiceReceipt,
    },
};
use tsumugi_plugin_host::{
    ChannelReceipt, HostError, ProjectServiceBroker, ProjectServiceFuture, ServiceCaller,
    core::{ProjectServiceFactory, ProjectServiceSelectionFuture},
};
use tsumugi_plugin_sdk as sdk;

const MAX_COMPONENT_ATTEMPTS: usize = 128;
const OPERATION: &str = "work-plan-generation-component";

request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanGenerationPrepareRequest {
        scope_id: ExecutionId,
        attempt_id: ExecutionId,
        component: PluginGenerationComponentRequest,
        generation: sdk::GenerationServiceInput
    }
);
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanGenerationStartRequest {
        scope_id: ExecutionId,
        attempt_id: ExecutionId,
        input_digest: String,
        grant_id: ExecutionId,
        expires_at_ms: UnsignedDecimal,
        unsandboxed_execution: bool
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanGenerationDiscardRequest {
        attempt_id: ExecutionId
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanGenerationPreflight {
    pub scope_id: ExecutionId,
    pub parent_task: ExecutionId,
    pub attempt_id: ExecutionId,
    pub task_id: ExecutionId,
    pub input_digest: String,
    pub component: PluginGenerationComponentView,
    pub generation: sdk::GenerationServiceInput,
    pub scope: Vec<PlanSelectionBasis>,
    pub budget: ProviderBudget,
}
#[derive(Clone)]
struct PreparedComponent {
    request: WorkPlanGenerationPrepareRequest,
    scope: WorkPlanAgentScope,
    input: FixedInput,
    view: WorkPlanGenerationPreflight,
}
#[derive(Clone)]
struct ComponentStart {
    request: WorkPlanGenerationStartRequest,
    prepared: Arc<PreparedComponent>,
    runtime_generation: ExecutionId,
    settings_revocation: Cancellation,
    deadline: Instant,
    // Unknown authorization never permits a second authorize call or new grant.
    authorized: bool,
    enqueue_unknown: bool,
}
#[derive(Default)]
pub(super) struct GenerationSession {
    pending: BTreeMap<ExecutionId, ExecutionId>,
    prepared: BTreeMap<ExecutionId, Arc<PreparedComponent>>,
    starts: BTreeMap<ExecutionId, ComponentStart>,
}
impl GenerationSession {
    pub(super) fn active(&self) -> bool {
        !self.pending.is_empty()
    }
    pub(super) fn stop(&mut self) {
        self.pending.clear();
        self.prepared.clear();
        self.starts.clear();
    }
    fn discard(&mut self, attempt: ExecutionId) -> bool {
        if self.starts.contains_key(&attempt) {
            return false;
        }
        self.pending.remove(&attempt);
        self.prepared.remove(&attempt);
        // Confirm absence on repeated discard, including a lost first reply or
        // owner shutdown. A started original action is never discarded here.
        true
    }
}
fn denied() -> CommandError {
    map_recover(ExecutionError::new(
        ErrorCode::Unauthorized,
        "generation-component-authority",
    ))
}
fn mismatch() -> CommandError {
    map_recover(ExecutionError::new(
        ErrorCode::ResultMismatch,
        "generation-component-identity",
    ))
}
fn limit() -> CommandError {
    map_recover(ExecutionError::new(
        ErrorCode::LimitExceeded,
        "generation-component-limit",
    ))
}
fn generation_request(
    input: &sdk::GenerationServiceInput,
) -> Result<AgentGenerationRequest, CommandError> {
    input.validate().map_err(|_| {
        CommandError::invalid_input(CommandStage::ExecutionRead, Some("generation"))
    })?;
    Ok(AgentGenerationRequest {
        task_id: ExecutionId::parse(&input.task_id).map_err(map_recover)?,
        attempt_id: ExecutionId::parse(&input.attempt_id).map_err(map_recover)?,
        unit_ids: input
            .unit_ids
            .iter()
            .map(|id| ExecutionId::parse(id).map_err(map_recover))
            .collect::<Result<_, _>>()?,
    })
}
fn component_binding(environment: &GenerationComponentEnvironment) -> PluginExecutionBinding {
    PluginExecutionBinding {
        capability: environment.captured.binding.clone(),
        profile: environment.profile.clone(),
        environment: environment.captured.runtime.environment(),
    }
}
/// Compare all consumers of the one installation owner before locking it once.
fn consent(
    host: &ExecutionHost,
    store: &ProjectStore,
    scope: &WorkPlanAgentScope,
    plugins: &Arc<ApplicationPlugins>,
    revision: UnsignedDecimal,
) -> Result<Option<CheckerConsent>, CommandError> {
    store
        .check_work_plan_agent_scope(scope)
        .map_err(map_recover)?;
    let plan = store
        .work_plan(scope.lease().plan_id)
        .map_err(map_recover)?;
    let checker = current_checker_consent(host, store, &plan, scope.lease())?;
    if checker.as_ref().is_some_and(|checker| {
        checker.settings_revision != revision || !Arc::ptr_eq(&checker.plugins, plugins)
    }) || broker::tools_revision(&plan)?.is_some_and(|tools| tools != revision)
    {
        return Err(super::super::review::checkers::stale());
    }
    if plan.tools.is_some() {
        broker::current_consent(host, store, scope)?;
    }
    Ok(checker)
}
fn build_preflight(
    store: &ProjectStore,
    request: WorkPlanGenerationPrepareRequest,
    scope: WorkPlanAgentScope,
    environment: &GenerationComponentEnvironment,
) -> Result<Arc<PreparedComponent>, CommandError> {
    let generation = generation_request(&request.generation)?;
    // This is the original read-only preparation. It validates source identities,
    // configuration, lease, sharing and ancestor budget without enqueueing a child.
    store
        .prepare_work_plan_agent_generation(&scope, &generation)
        .map_err(map_recover)?;
    let binding = component_binding(environment);
    let declaration = binding.capability.declaration.clone();
    let payload = serde_json::to_value(&request.generation).map_err(|_| mismatch())?;
    if serde_json::to_vec(&payload).map_err(|_| mismatch())?.len()
        > declaration.limits.max_input_bytes as usize
    {
        return Err(limit());
    }
    let result_bytes = declaration
        .limits
        .max_output_bytes
        .checked_mul(3)
        .and_then(|size| size.checked_add(64 * 1024))
        .filter(|size| *size as usize <= MAX_RESULT_BYTES)
        .ok_or_else(limit)?;
    let project = store
        .metadata()
        .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRead))?
        .project_id();
    let mut envelope = InputEnvelope::new(
        project,
        OPERATION,
        &declaration.contract.id,
        &binding.capability_version(),
        vec![InputItem::new(
            Scope {
                kind: OPERATION.into(),
                id: project.to_string(),
                locale: None,
            },
            payload,
            Vec::new(),
        )],
    )
    .map_err(map_recover)?;
    envelope.attempt_id = request.attempt_id;
    envelope.plugin = Some(binding);
    // The component has an ordinary grant. Only its derived AI children use the
    // existing WorkPlan lease and parent budget; the outer request has no lease.
    envelope.limits.timeout_ms = declaration.limits.timeout_ms.min(60_000);
    envelope.limits.max_result_bytes = result_bytes;
    let component = environment.view()?;
    envelope.settings = serde_json::json!({"component": component});
    let input = FixedInput::capture(envelope).map_err(map_recover)?;
    let plan = store
        .work_plan(scope.lease().plan_id)
        .map_err(map_recover)?;
    let budget = store
        .provider_budget(scope.parent_task())
        .map_err(map_recover)?
        .ok_or_else(denied)?;
    let view = WorkPlanGenerationPreflight {
        scope_id: request.scope_id,
        parent_task: scope.parent_task(),
        attempt_id: request.attempt_id,
        task_id: input.envelope().task_id,
        input_digest: input.digest().into(),
        component,
        generation: request.generation.clone(),
        scope: plan
            .selection_basis
            .into_iter()
            .filter(|basis| generation.unit_ids.contains(&basis.unit_id))
            .collect(),
        budget,
    };
    Ok(Arc::new(PreparedComponent {
        request,
        scope,
        input,
        view,
    }))
}

#[tauri::command]
pub async fn prepare_work_plan_generation_component(
    state: State<'_, AppState>,
    request: WorkPlanGenerationPrepareRequest,
) -> Result<WorkPlanGenerationPreflight, CommandError> {
    let generation = generation_request(&request.generation)?;
    if request.attempt_id == generation.attempt_id {
        return Err(mismatch());
    }
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "prepare_work_plan_generation_component.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let scope = agent::scope(host, store, initial.scope_id)?;
            let generation = &mut host.work_plans.generation;
            if let Some(prepared) = generation.prepared.get(&initial.attempt_id) {
                if prepared.request != initial || prepared.scope != scope {
                    return Err(mismatch());
                }
                return Ok((None, Some(prepared.view.clone())));
            }
            if generation.starts.contains_key(&initial.attempt_id) {
                return Err(mismatch());
            }
            if generation.pending.contains_key(&initial.attempt_id) {
                return Err(CommandError::simple(
                    CommandErrorCode::Busy,
                    CommandStage::ExecutionRead,
                ));
            }
            if generation.prepared.len() + generation.pending.len() >= MAX_COMPONENT_ATTEMPTS {
                return Err(limit());
            }
            let ticket = ExecutionId::new();
            generation.pending.insert(initial.attempt_id, ticket);
            Ok((Some((ticket, scope)), None))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (pending, existing) = admitted.await?;
        if let Some(view) = existing {
            return Ok(view);
        }
        let (ticket, captured_scope) = pending.ok_or_else(mismatch)?;
        let component = request.component.clone();
        let capture_plugins = plugins.clone();
        let loaded = io
            .run(CommandStage::ExecutionRead, move || {
                capture_plugins.capture_generation_component(&component)
            })
            .await;
        lease
            .run(
                "prepare_work_plan_generation_component.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    host.allow_mutation()?;
                    if host.work_plans.generation.pending.get(&request.attempt_id) != Some(&ticket)
                    {
                        return Err(mismatch());
                    }
                    host.work_plans
                        .generation
                        .pending
                        .remove(&request.attempt_id);
                    if agent::scope(host, store, request.scope_id)? != captured_scope {
                        return Err(denied());
                    }
                    let environment = loaded?;
                    consent(
                        host,
                        store,
                        &captured_scope,
                        &plugins,
                        environment.captured.settings_revision,
                    )?;
                    plugins.with_environment_revision(
                        environment.captured.settings_revision,
                        || {
                            let prepared =
                                build_preflight(store, request, captured_scope, &environment)?;
                            let view = prepared.view.clone();
                            host.work_plans
                                .generation
                                .prepared
                                .insert(view.attempt_id, prepared);
                            Ok(view)
                        },
                    )
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

fn start_deadline(expires_at_ms: u64) -> Result<Instant, CommandError> {
    let now: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|value| value.as_millis().try_into().ok())
        .ok_or_else(denied)?;
    let duration = expires_at_ms
        .checked_sub(now)
        .filter(|duration| *duration > 0 && *duration <= 600_000)
        .ok_or_else(denied)?;
    Instant::now()
        .checked_add(Duration::from_millis(duration))
        .ok_or_else(denied)
}
#[tauri::command]
pub async fn start_work_plan_generation_component(
    state: State<'_, AppState>,
    request: WorkPlanGenerationStartRequest,
) -> Result<ExecutionId, CommandError> {
    if !request.unsandboxed_execution {
        return Err(denied());
    }
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "start_work_plan_generation_component.begin",
        CommandStage::ExecutionRecover,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRecover,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let prior = host
                .work_plans
                .generation
                .starts
                .get(&initial.attempt_id)
                .cloned();
            if let Some(start) = &prior {
                if start.request != initial {
                    return Err(mismatch());
                }
                if let Some(input) = host
                    .runtime
                    .input_if_present(store, initial.attempt_id)
                    .map_err(map_recover)?
                {
                    if input.bytes() != start.prepared.input.bytes() {
                        return Err(mismatch());
                    }
                    // A historical acknowledgement restores no execution or scope.
                    return Ok(None);
                }
                // Uncertain starts only reconcile. They do not replay authorization,
                // substitute a grant or reconstruct a deadline from the wall clock.
                if !start.authorized || start.enqueue_unknown {
                    return Err(CommandError::unknown(CommandStage::ExecutionRecover));
                }
                if start.runtime_generation != host.runtime.generation()
                    || start.settings_revocation.is_requested()
                    || Instant::now() >= start.deadline
                {
                    return Err(denied());
                }
            }
            let scope = agent::scope(host, store, initial.scope_id)?;
            let prepared = host
                .work_plans
                .generation
                .prepared
                .get(&initial.attempt_id)
                .cloned()
                .ok_or_else(mismatch)?;
            if prepared.scope != scope || prepared.input.digest() != initial.input_digest {
                return Err(mismatch());
            }
            if prior.is_none() && host.work_plans.generation.starts.len() >= MAX_COMPONENT_ATTEMPTS
            {
                return Err(limit());
            }
            if host
                .work_plans
                .generation
                .pending
                .contains_key(&initial.attempt_id)
            {
                return Err(CommandError::simple(
                    CommandErrorCode::Busy,
                    CommandStage::ExecutionRecover,
                ));
            }
            let deadline = match prior {
                Some(start) => start.deadline,
                None => start_deadline(initial.expires_at_ms.get())?,
            };
            let ticket = ExecutionId::new();
            host.work_plans
                .generation
                .pending
                .insert(initial.attempt_id, ticket);
            Ok(Some((ticket, prepared, deadline)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let Some((ticket, prepared, deadline)) = admitted.await? else {
            return Ok(request.attempt_id);
        };
        let fixed = prepared.clone();
        let capture_plugins = plugins.clone();
        let loaded = io
            .run(CommandStage::ExecutionRecover, move || {
                let environment =
                    capture_plugins.capture_generation_component(&fixed.request.component)?;
                if environment.view()? != fixed.view.component
                    || fixed.input.envelope().plugin.as_ref()
                        != Some(&component_binding(&environment))
                {
                    return Err(mismatch());
                }
                let runner = RunnerProxy::new(
                    environment.captured.package.image().clone(),
                    &environment.captured.binding.provider.contribution_id,
                    environment.captured.runtime.clone(),
                    environment.captured.staging_parent.clone(),
                    HostLimits::default(),
                )
                .map(Arc::new)
                .map_err(map_recover)?;
                Ok((environment, runner))
            })
            .await;
        lease
            .run(
                "start_work_plan_generation_component.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRecover,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    host.allow_mutation()?;
                    if host.work_plans.generation.pending.get(&request.attempt_id) != Some(&ticket)
                    {
                        return Err(mismatch());
                    }
                    host.work_plans
                        .generation
                        .pending
                        .remove(&request.attempt_id);
                    let (environment, runner) = loaded?;
                    let scope = agent::scope(host, store, request.scope_id)?;
                    if scope != prepared.scope || Instant::now() >= deadline {
                        return Err(denied());
                    }
                    consent(
                        host,
                        store,
                        &scope,
                        &plugins,
                        environment.captured.settings_revision,
                    )?;
                    plugins.with_environment_authority(
                        environment.captured.settings_revision,
                        |settings_revocation| {
                            host.register_plugin(runner, component_binding(&environment))
                                .map_err(map_recover)?;
                            if let Some(original) =
                                host.work_plans.generation.starts.get(&request.attempt_id)
                            {
                                if original.request != request
                                    || !original.authorized
                                    || original.enqueue_unknown
                                    || original.runtime_generation != host.runtime.generation()
                                    || original.settings_revocation.is_requested()
                                    || original.deadline != deadline
                                {
                                    return Err(denied());
                                }
                                // Reuse the original grant and one-way signal. The
                                // freshly checked settings do not renew either.
                            } else {
                                host.work_plans.generation.starts.insert(
                                    request.attempt_id,
                                    ComponentStart {
                                        request: request.clone(),
                                        prepared: prepared.clone(),
                                        runtime_generation: host.runtime.generation(),
                                        settings_revocation,
                                        deadline,
                                        authorized: false,
                                        enqueue_unknown: false,
                                    },
                                );
                                let authorized = host.runtime.authorize_plugin(
                                    store,
                                    request.grant_id,
                                    &prepared.input,
                                    request.expires_at_ms.get(),
                                    PluginConsent {
                                        unsandboxed_execution: request.unsandboxed_execution,
                                    },
                                );
                                if let Err(error) = authorized {
                                    if error.code != ErrorCode::OutcomeUnknown {
                                        host.work_plans
                                            .generation
                                            .starts
                                            .remove(&request.attempt_id);
                                    }
                                    return Err(map_recover(error));
                                }
                                host.work_plans
                                    .generation
                                    .starts
                                    .get_mut(&request.attempt_id)
                                    .expect("original start")
                                    .authorized = true;
                            }
                            if let Err(error) = host.runtime.submit(store, &prepared.input) {
                                host.work_plans
                                    .generation
                                    .starts
                                    .get_mut(&request.attempt_id)
                                    .expect("original start")
                                    .enqueue_unknown = error.code == ErrorCode::OutcomeUnknown;
                                return Err(map_recover(error));
                            }
                            Ok(request.attempt_id)
                        },
                    )
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}
#[tauri::command]
pub async fn discard_work_plan_generation_component(
    state: State<'_, AppState>,
    request: WorkPlanGenerationDiscardRequest,
) -> Result<bool, CommandError> {
    state
        .sessions
        .run(
            "discard_work_plan_generation_component",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, _) = active.execution_parts()?;
                Ok(host.work_plans.generation.discard(request.attempt_id))
            },
        )
        .await
}

/// No plan, permit, sender or persistent queue lease is cached in this factory.
#[derive(Clone)]
pub(in crate::commands::execution) struct GenerationFactory {
    context: ProjectServiceContext,
    token: String,
    runtime_generation: ExecutionId,
    project: ExecutionId,
}
impl GenerationFactory {
    pub(in crate::commands::execution) fn new(
        context: ProjectServiceContext,
        token: String,
        runtime_generation: ExecutionId,
        project: ExecutionId,
    ) -> Self {
        Self {
            context,
            token,
            runtime_generation,
            project,
        }
    }
    fn original<'a>(
        &self,
        sessions: &'a mut SessionManager,
    ) -> Result<(&'a mut ExecutionHost, &'a mut ProjectStore), CommandError> {
        let active = authorized(
            sessions,
            &self.token,
            self.project,
            CommandStage::ExecutionRecover,
        )?;
        // An old worker must not lazily create a new host after close/reopen.
        let host = active.execution.as_mut().ok_or_else(denied)?;
        host.allow_mutation()?;
        if host.runtime.generation() != self.runtime_generation {
            return Err(denied());
        }
        Ok((host, &mut active.store))
    }
    fn capture_broker(
        &self,
        sessions: &mut SessionManager,
        dispatch: DispatchRequest,
        permit: PluginPermit,
        cancellation: Cancellation,
    ) -> Result<Arc<dyn ProjectServiceBroker>, CommandError> {
        let (host, store) = self.original(sessions)?;
        let start = host
            .work_plans
            .generation
            .starts
            .get(&dispatch.input.envelope().attempt_id)
            .cloned()
            .ok_or_else(denied)?;
        let scope = agent::scope(host, store, start.request.scope_id)?;
        if scope != start.prepared.scope
            || start.prepared.input.bytes() != dispatch.input.bytes()
            || start.runtime_generation != self.runtime_generation
            || !start.authorized
            || permit.grant_id() != start.request.grant_id
            || !permit.matches(&dispatch.input)
            || !permit.is_authorized()
            || permit.is_work_plan_tool()
            || cancellation.is_requested()
            || start.settings_revocation.is_requested()
            || Instant::now() >= start.deadline
            || dispatch.plugin_permit().is_none_or(|actual| {
                actual.grant_id() != permit.grant_id() || !actual.matches(&dispatch.input)
            })
        {
            return Err(denied());
        }
        let revision = start.prepared.view.component.settings_revision;
        consent(host, store, &scope, &self.context.plugins, revision)?;
        self.context
            .plugins
            .with_environment_revision(revision, || {
                let plan = store
                    .work_plan(scope.lease().plan_id)
                    .map_err(map_recover)?;
                let deadline = dispatch.deadline().ok_or_else(denied)?.min(start.deadline);
                let remaining: u32 = deadline
                    .checked_duration_since(Instant::now())
                    .filter(|value| !value.is_zero())
                    .and_then(|value| value.as_millis().try_into().ok())
                    .filter(|value: &u32| *value > 0)
                    .ok_or_else(denied)?;
                let service = sdk::ServiceBinding {
                    handle_id: "work-plan-generation".into(),
                    provider_id: "tsumugi.core".into(),
                    contract: sdk::generation_service_contract(),
                    input_schema: sdk::generation_service_input_contract(),
                    output_schema: sdk::generation_service_receipt_contract(),
                    error_schema: sdk::generation_service_error_contract(),
                    effect: sdk::EffectKind::External,
                    project_id: self.project.to_string(),
                    scope_id: self.project.to_string(),
                    activation_generation: scope
                        .lease()
                        .generation
                        .get()
                        .try_into()
                        .map_err(|_| limit())?,
                    configuration_digest: plan.digest.clone(),
                    limits: sdk::CapabilityLimits {
                        timeout_ms: remaining.min(60_000),
                        max_input_bytes: sdk::MAX_GENERATION_SERVICE_INPUT_BYTES as u32,
                        max_output_bytes: sdk::MAX_GENERATION_SERVICE_RECEIPT_BYTES as u32,
                        concurrency: 1,
                    },
                };
                sdk::validate_generation_service_binding(&service).map_err(|_| mismatch())?;
                Ok(Arc::new(GenerationBroker {
                    factory: self.clone(),
                    start,
                    scope,
                    dispatch,
                    permit,
                    cancellation,
                    deadline,
                    bindings: vec![service],
                }) as Arc<dyn ProjectServiceBroker>)
            })
    }
}
impl ProjectServiceFactory for GenerationFactory {
    fn capture(
        &self,
        request: DispatchRequest,
        permit: PluginPermit,
        cancellation: Cancellation,
    ) -> ProjectServiceSelectionFuture {
        let factory = self.clone();
        let callback = self.context.callback.clone();
        Box::pin(async move {
            let admitted = callback
                .submit(
                    "generation-service.capture",
                    CommandStage::ExecutionRead,
                    move |sessions| factory.capture_broker(sessions, request, permit, cancellation),
                )
                .map_err(core_error)?;
            admitted.await.map_err(core_error)
        })
    }
}
#[derive(Clone)]
struct GenerationBroker {
    factory: GenerationFactory,
    start: ComponentStart,
    scope: WorkPlanAgentScope,
    dispatch: DispatchRequest,
    permit: PluginPermit,
    cancellation: Cancellation,
    deadline: Instant,
    bindings: Vec<sdk::ServiceBinding>,
}
fn core_error(error: CommandError) -> ExecutionError {
    let code = match error.code {
        CommandErrorCode::Busy => ErrorCode::Busy,
        CommandErrorCode::StorageFailed => ErrorCode::StorageFailed,
        CommandErrorCode::OutcomeUnknown => ErrorCode::OutcomeUnknown,
        CommandErrorCode::LimitExceeded => ErrorCode::LimitExceeded,
        CommandErrorCode::Cancelled => ErrorCode::Cancelled,
        CommandErrorCode::InvalidInput => ErrorCode::InvalidInput,
        CommandErrorCode::ResultMismatch => ErrorCode::ResultMismatch,
        _ => ErrorCode::Unauthorized,
    };
    ExecutionError::new(code, "generation-service")
}
fn service_error(error: CommandError) -> sdk::InvocationOutcome {
    use sdk::GenerationServiceErrorCode as Code;
    let code = match error.code {
        CommandErrorCode::InvalidInput | CommandErrorCode::OutputInvalid => Code::InvalidInput,
        CommandErrorCode::Busy => Code::Busy,
        CommandErrorCode::StorageFailed => Code::StorageFailed,
        CommandErrorCode::OutcomeUnknown => Code::OutcomeUnknown,
        CommandErrorCode::LimitExceeded => Code::LimitExceeded,
        CommandErrorCode::Cancelled => Code::Cancelled,
        CommandErrorCode::StaleRevision
        | CommandErrorCode::ResultMismatch
        | CommandErrorCode::DependencyConflict => Code::Conflict,
        _ => Code::PermissionDenied,
    };
    let payload = sdk::EncodedPayload::capture(
        sdk::generation_service_error_contract(),
        serde_json::to_string(&sdk::GenerationServiceError { code }).expect("finite service error"),
    )
    .expect("bounded service error");
    if code == Code::OutcomeUnknown {
        sdk::InvocationOutcome::Unknown { error: payload }
    } else {
        sdk::InvocationOutcome::Failed { error: payload }
    }
}
fn receipt(receipt: WorkPlanServiceReceipt) -> Result<sdk::InvocationOutcome, CommandError> {
    let value = sdk::GenerationServiceReceipt {
        task_id: receipt.task_id.to_string(),
        attempt_id: receipt.attempt_id.to_string(),
        input_digest: receipt.input_digest,
    };
    value.validate().map_err(|_| mismatch())?;
    Ok(sdk::InvocationOutcome::Succeeded {
        output: sdk::EncodedPayload::capture(
            sdk::generation_service_receipt_contract(),
            serde_json::to_string(&value).map_err(|_| mismatch())?,
        )
        .map_err(|_| mismatch())?,
    })
}
fn reconciled_receipt(
    observed: Result<Option<WorkPlanServiceReceipt>, ExecutionError>,
    original: ExecutionError,
) -> Result<sdk::InvocationOutcome, CommandError> {
    match observed {
        Ok(Some(accepted)) => receipt(accepted),
        Ok(None) => Err(map_recover(original)),
        Err(mut error) => {
            // This read follows an accepted-or-unknown enqueue. A missing ACK
            // cannot establish definite failure, even when storage is damaged.
            error.code = ErrorCode::OutcomeUnknown;
            Err(map_recover(error))
        }
    }
}
impl GenerationBroker {
    fn live(&self) -> bool {
        self.permit.is_authorized()
            && !self.cancellation.is_requested()
            && !self.start.settings_revocation.is_requested()
            && Instant::now() < self.deadline
    }
    fn enqueue(
        &self,
        sessions: &mut SessionManager,
        caller: &ServiceCaller,
        request: &sdk::ServiceRequest,
    ) -> Result<sdk::InvocationOutcome, CommandError> {
        let (host, store) = self.factory.original(sessions)?;
        request
            .validate_against(&self.bindings[0], caller.context())
            .map_err(|_| mismatch())?;
        let proposed =
            sdk::parse_generation_service_input(request.input.utf8.as_bytes()).map_err(|_| {
                CommandError::invalid_input(CommandStage::ExecutionRecover, Some("generation"))
            })?;
        // The human preflight fixed the child identities and source subset in
        // this ordinary caller's input. A component cannot substitute a broader
        // proposal merely because the encompassing WorkPlan has more scope.
        if proposed != self.start.prepared.request.generation {
            return Err(mismatch());
        }
        let invocation = caller.invocation();
        let mut expected = self
            .dispatch
            .input
            .plugin_request(
                self.dispatch.item_id,
                self.dispatch.dispatch_token,
                &invocation.provider,
            )
            .map_err(map_recover)?;
        // The SDK context identifies the encoded item payload. Reconstruct its
        // complete request from the original Core input, allowing only the
        // existing Host narrowing of the result frame limit.
        if invocation.max_result_bytes == 0
            || invocation.max_result_bytes > expected.max_result_bytes
        {
            return Err(denied());
        }
        expected.max_result_bytes = invocation.max_result_bytes;
        if invocation != &expected {
            return Err(denied());
        }
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
        // The original durable bytes answer a duplicate even after its child is
        // terminal. Reading this ACK never creates fresh effect tracking.
        if let Some(accepted) = store
            .work_plan_service_receipt(&identity, &call)
            .map_err(map_recover)?
        {
            return receipt(accepted);
        }
        if !self.live() || agent::scope(host, store, self.start.request.scope_id)? != self.scope {
            return Err(denied());
        }
        let revision = self.start.prepared.view.component.settings_revision;
        let checker = consent(
            host,
            store,
            &self.scope,
            &self.factory.context.plugins,
            revision,
        )?;
        self.factory
            .context
            .plugins
            .with_environment_revision(revision, || {
                if !self.live() {
                    return Err(denied());
                }
                let origin = store
                    .capture_work_plan_service_origin(
                        &self.scope,
                        &self.dispatch,
                        caller.invocation(),
                        &self.bindings[0],
                        caller.deadline().min(self.deadline),
                        &self.cancellation,
                        &self.start.settings_revocation,
                    )
                    .map_err(map_recover)?;
                if origin.identity(&call).map_err(map_recover)? != identity {
                    return Err(mismatch());
                }
                let prepared = store
                    .prepare_work_plan_service_generation(&origin, &call)
                    .map_err(map_recover)?;
                let tracking = host
                    .ai
                    .prepare_service_tracking(store, &prepared, checker)
                    .map_err(map_recover)?;
                match host
                    .runtime
                    .submit_work_plan_service_child(store, &prepared)
                {
                    Ok(accepted) => {
                        tracking.commit();
                        receipt(accepted)
                    }
                    Err(error) if error.code == ErrorCode::OutcomeUnknown => {
                        // Preserve original actions and authorization while reconciling
                        // an uncertain transaction; never re-prepare or reauthorize.
                        tracking.commit();
                        reconciled_receipt(store.work_plan_service_receipt(&identity, &call), error)
                    }
                    Err(error) => Err(map_recover(error)),
                }
            })
    }
}
impl ProjectServiceBroker for GenerationBroker {
    fn bindings(&self) -> &[sdk::ServiceBinding] {
        &self.bindings
    }
    fn is_current(&self, binding: &sdk::ServiceBinding) -> bool {
        self.bindings.contains(binding) && self.live()
    }
    fn call<'a>(
        &'a self,
        caller: ServiceCaller,
        binding: sdk::ServiceBinding,
        request: sdk::ServiceRequest,
    ) -> ProjectServiceFuture<'a> {
        let broker = self.clone();
        let callback = self.factory.context.callback.clone();
        Box::pin(async move {
            if !broker.bindings.contains(&binding)
                || request
                    .validate_against(&binding, caller.context())
                    .is_err()
            {
                return Err(HostError::InvalidContract);
            }
            let result = match callback.submit(
                "generation-service.enqueue",
                CommandStage::ExecutionRecover,
                {
                    let request = request.clone();
                    move |sessions| broker.enqueue(sessions, &caller, &request)
                },
            ) {
                Ok(admitted) => admitted.await,
                Err(error) => Err(error),
            };
            let outcome = match result {
                Ok(outcome) => outcome,
                Err(error) => service_error(error),
            };
            let response = sdk::ServiceResponse {
                call_id: request.call_id.clone(),
                handle_id: request.handle_id.clone(),
                context: request.context.clone(),
                outcome,
            };
            response
                .validate_against(&request, &binding)
                .map_err(|_| HostError::InvalidContract)?;
            Ok(response)
        })
    }
    fn release_channel(&self, _channel: &ChannelReceipt) {
        // Process closure releases no durable child's original caller association.
        // The original AI owner releases each child after execution AND effects.
    }
}

#[cfg(test)]
mod outcome_tests {
    use super::*;

    #[test]
    fn accepted_child_ack_read_errors_stay_unknown_on_the_service_wire() {
        for observed in [
            Ok(None),
            Err(ExecutionError::new(
                ErrorCode::StorageFailed,
                "service-call-storage",
            )),
            Err(ExecutionError::new(
                ErrorCode::CorruptLedger,
                "service-call-integrity",
            )),
        ] {
            let original = ExecutionError::new(ErrorCode::OutcomeUnknown, "service-child-receipt");
            let error = reconciled_receipt(observed, original).unwrap_err();
            assert_eq!(error.code, CommandErrorCode::OutcomeUnknown);
            let sdk::InvocationOutcome::Unknown { error } = service_error(error) else {
                panic!("Accepted or unknown children cannot report definite enqueue failure");
            };
            let decoded = sdk::parse_generation_service_error(error.utf8.as_bytes()).unwrap();
            assert_eq!(
                decoded.code,
                sdk::GenerationServiceErrorCode::OutcomeUnknown
            );
        }
        assert!(matches!(
            service_error(map_recover(ExecutionError::new(
                ErrorCode::StorageFailed,
                "before-enqueue"
            ))),
            sdk::InvocationOutcome::Failed { .. }
        ));
    }
}
