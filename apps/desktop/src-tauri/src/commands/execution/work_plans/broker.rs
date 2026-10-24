//! Installed read-only tools use the original plan, session and execution ledger.
//! Agent requests select captured units; they cannot supply payload or authority.
use super::*;
use crate::commands::plugins::{PluginPackageRequest, PluginToolRequest, PluginToolView};
use tsumugi_core::application::{AgentToolRequest, PreparedWorkPlanTool, WorkPlanToolSpec};
use tsumugi_core::execution::{ApplicationExecutionLease, ApplicationScopeBasis};
use tsumugi_plugin_host::core::ApplicationInstance;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanToolSelection {
    #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 300)))]
    pub max_invocations: u32,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 32)))]
    pub entries: Vec<WorkPlanToolSelectionEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanToolSelectionEntry {
    pub handle: ExecutionId,
    pub tool: PluginToolRequest,
    pub target: String,
    pub selections: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanToolUsage {
    pub reserved: u32,
    pub limit: u32,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentToolPrepareRequest {
        scope_id: ExecutionId,
        tool: AgentToolRequest
    }
);
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentToolStartRequest {
        scope_id: ExecutionId,
        tool: AgentToolRequest,
        #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
        input_digest: String
    }
);

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentToolAttemptRequest {
        scope_id: ExecutionId,
        tool: AgentToolRequest,
        #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
        input_digest: String,
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        offset: u32,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 100)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentToolOutputRequest {
        scope_id: ExecutionId,
        tool: AgentToolRequest,
        #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
        input_digest: String,
        item_id: ExecutionId,
        result_id: ExecutionId
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentToolView {
    pub scope_id: ExecutionId,
    pub parent_task: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub tool_handle: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub input_digest: String,
    pub scope: Vec<PlanSelectionBasis>,
}

#[derive(Clone)]
pub(super) struct ToolStart {
    request: WorkPlanAgentToolStartRequest,
    grant_id: ExecutionId,
}

/// Recovery identity for a trusted human decision, never a dispatch permit.
/// Both clocks are captured before any outside IO or uncertain commit.
#[derive(Clone)]
pub(super) struct HumanToolIntent {
    fingerprint: Vec<u8>,
    generation: ExecutionId,
    wall_deadline_ms: u64,
    deadline: Instant,
    application_leases: BTreeMap<ExecutionId, ApplicationExecutionLease>,
}

fn now_ms() -> Result<u64, CommandError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| duration.as_millis().try_into().ok())
        .ok_or_else(denied)
}

pub(super) fn capture_human_intent(
    host: &mut ExecutionHost,
    plan: &WorkPlan,
    action: ExecutionId,
    root_expires_at: u64,
    request: &impl Serialize,
    applications: &[ApplicationScopeBasis],
    confirmed: bool,
    plugins: &ApplicationPlugins,
) -> Result<(), CommandError> {
    capture_intent(host, plan, action, root_expires_at, None, request, applications, confirmed, plugins)
}
pub(super) fn capture_recovery_intent(
    host: &mut ExecutionHost,
    plan: &WorkPlan,
    action: ExecutionId,
    root_expires_at: u64,
    original_deadline: Instant,
    request: &impl Serialize,
    applications: &[ApplicationScopeBasis],
    confirmed: bool,
    plugins: &ApplicationPlugins,
) -> Result<(), CommandError> {
    capture_intent(host, plan, action, root_expires_at, Some(original_deadline), request, applications, confirmed, plugins)
}
fn capture_intent(
    host: &mut ExecutionHost,
    plan: &WorkPlan,
    action: ExecutionId,
    root_expires_at: u64,
    original_deadline: Option<Instant>,
    request: &impl Serialize,
    applications: &[ApplicationScopeBasis],
    confirmed: bool,
    plugins: &ApplicationPlugins,
) -> Result<(), CommandError> {
    if plan.tools.is_none() {
        return Ok(());
    }
    let fingerprint = serde_json::to_vec(request).map_err(|_| stale())?;
    if let Some(intent) = host.work_plans.tool_intents.get(&action) {
        return if intent.fingerprint == fingerprint
            && intent.generation == host.runtime.generation()
            && application_leases_match(plan, &intent.application_leases)
        {
            Ok(())
        } else {
            Err(stale())
        };
    }
    if host.work_plans.tool_intents.len() >= 300 {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::LimitExceeded,
            "work-plan-tool-intents",
        )));
    }
    let now = now_ms()?;
    let wall_deadline_ms = root_expires_at
        .checked_mul(1000)
        .ok_or_else(denied)?
        .min(now.checked_add(600_000).ok_or_else(denied)?);
    let duration = wall_deadline_ms
        .checked_sub(now)
        .filter(|duration| *duration > 0)
        .ok_or_else(denied)?;
    let deadline = Instant::now()
        .checked_add(Duration::from_millis(duration))
        .ok_or_else(denied)?;
    let deadline = original_deadline.map_or(deadline, |original| original.min(deadline));
    if Instant::now() >= deadline { return Err(denied()); }
    let selected = application_selection(plan)?;
    check_application_selection(&selected, applications)?;
    if !selected.is_empty() && !confirmed {
        return Err(denied());
    }
    // Freeze the human clock before the first independently authorized lifetime
    // can become uncertain. Missing leases on replay never recapture that clock.
    host.work_plans.tool_intents.insert(
        action,
        HumanToolIntent {
            fingerprint,
            generation: host.runtime.generation(),
            wall_deadline_ms,
            deadline,
            application_leases: BTreeMap::new(),
        },
    );
    let application_leases = if selected.is_empty() {
        BTreeMap::new()
    } else {
        let revision = tools_revision(plan)?.ok_or_else(stale)?;
        plugins.with_environment_authority(revision, |settings| {
            let mut leases = BTreeMap::new();
            for tool in plan
                .tools
                .as_ref()
                .ok_or_else(stale)?
                .entries
                .iter()
                .filter(|tool| {
                    tool.execution.component_scope
                        == tsumugi_plugin_sdk::ComponentScope::Application
                })
            {
                let instance = plugins.work_plan_tool_instance(tool)?;
                let lease = plugins.authorize_application_tool(
                    &instance,
                    action,
                    true,
                    settings.clone(),
                )?;
                if !lease.matches_binding(&tool.execution) {
                    return Err(denied());
                }
                leases.insert(tool.handle, lease);
            }
            Ok(leases)
        })?
    };
    host.work_plans
        .tool_intents
        .get_mut(&action)
        .ok_or_else(denied)?
        .application_leases = application_leases;
    Ok(())
}

impl HumanToolIntent {
    fn expiry(&self) -> Result<u64, CommandError> {
        let remaining: u64 = self
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .and_then(|duration| duration.as_millis().try_into().ok())
            .ok_or_else(denied)?;
        let now = now_ms()?;
        // A wall-clock rollback cannot make Core's later monotonic capture
        // extend the original human deadline. Rounding only shortens it.
        let expiry = self
            .wall_deadline_ms
            .min(now.checked_add(remaining).ok_or_else(denied)?);
        if expiry <= now {
            return Err(denied());
        }
        Ok(expiry)
    }
}

fn stale() -> CommandError {
    map_recover(ExecutionError::new(
        ErrorCode::DependencyConflict,
        "work-plan-tool-preview",
    ))
}

fn denied() -> CommandError {
    map_recover(ExecutionError::new(
        ErrorCode::Unauthorized,
        "plugin-consent-required",
    ))
}

fn spec(
    view: PluginToolView,
    selected: &WorkPlanToolSelectionEntry,
    application: Option<&Arc<ApplicationInstance>>,
) -> Result<WorkPlanToolSpec, CommandError> {
    Ok(WorkPlanToolSpec {
        handle: selected.handle,
        binding: view.binding.clone(),
        execution: PluginExecutionBinding {
            capability: view.binding.capability.clone(),
            component_scope: view.component_scope,
            application_scope: application.map(|instance| instance.basis().clone()),
            profile: view.binding.declaration.profile.clone(),
            environment: view.environment,
        },
        application_capabilities: application
            .map_or_else(Vec::new, |instance| instance.capabilities()),
        resource_id: view.resource_id,
        settings_revision: view.settings_revision,
        package_origin: serde_json::to_value(view.package_origin).map_err(|_| stale())?,
        runtime_origin: serde_json::to_value(view.runtime_origin).map_err(|_| stale())?,
        target: selected.target.clone(),
        selections: selected.selections.clone(),
    })
}

pub(super) fn capture_selection(
    plugins: &ApplicationPlugins,
    selected: Option<&WorkPlanToolSelection>,
) -> Result<Option<WorkPlanTools>, CommandError> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    if !(1..=300).contains(&selected.max_invocations)
        || selected.entries.is_empty()
        || selected.entries.len() > 32
        || selected
            .entries
            .iter()
            .map(|tool| tool.handle)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != selected.entries.len()
    {
        return Err(map_read(ExecutionError::new(
            ErrorCode::InvalidInput,
            "work-plan-tools",
        )));
    }
    let entries = selected
        .entries
        .iter()
        .map(|tool| {
            let environment = plugins.capture_tool(&tool.tool)?;
            let application = plugins.reserve_application_tool(&environment)?;
            spec(environment.view()?, tool, application.as_ref())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let tools = WorkPlanTools {
        max_invocations: selected.max_invocations,
        entries,
    };
    tools.validate().map_err(map_read)?;
    if tools
        .entries
        .iter()
        .any(|tool| tool.settings_revision != tools.entries[0].settings_revision)
    {
        return Err(stale());
    }
    Ok(Some(tools))
}
pub(super) fn recapture_tools(plugins: &ApplicationPlugins, plan: &WorkPlan) -> Result<(), CommandError> {
    for tool in plan.tools.iter().flat_map(|tools| &tools.entries) {
        let environment = plugins.capture_tool(&selector(tool))?;
        let application = if tool.execution.component_scope == tsumugi_plugin_sdk::ComponentScope::Application {
            Some(plugins.work_plan_tool_instance(tool)?)
        } else { None };
        let observed = spec(environment.view()?, &WorkPlanToolSelectionEntry {
            handle: tool.handle, tool: selector(tool), target: tool.target.clone(), selections: tool.selections.clone(),
        }, application.as_ref())?;
        if observed != *tool { return Err(stale()); }
    }
    Ok(())
}

pub(super) fn tools_revision(plan: &WorkPlan) -> Result<Option<UnsignedDecimal>, CommandError> {
    let Some(tools) = &plan.tools else {
        return Ok(None);
    };
    tools.validate().map_err(map_recover)?;
    let revision = tools.entries[0].settings_revision;
    if tools
        .entries
        .iter()
        .any(|tool| tool.settings_revision != revision)
    {
        return Err(stale());
    }
    Ok(Some(revision))
}

pub(super) fn with_tools_revision<T>(
    plugins: &ApplicationPlugins,
    plan: &WorkPlan,
    operation: impl FnOnce() -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    match tools_revision(plan)? {
        Some(revision) => plugins.with_environment_revision(revision, operation),
        None => operation(),
    }
}

fn application_selection(
    plan: &WorkPlan,
) -> Result<BTreeMap<ExecutionId, ApplicationScopeBasis>, CommandError> {
    let mut applications = BTreeMap::new();
    for tool in plan
        .tools
        .iter()
        .flat_map(|tools| &tools.entries)
        .filter(|tool| {
            tool.execution.component_scope == tsumugi_plugin_sdk::ComponentScope::Application
        })
    {
        let basis = tool
            .execution
            .application_scope
            .as_ref()
            .ok_or_else(stale)?;
        if applications
            .insert(basis.instance_id, basis.clone())
            .is_some_and(|old| old != *basis)
        {
            return Err(stale());
        }
    }
    Ok(applications)
}

fn check_application_selection(
    expected: &BTreeMap<ExecutionId, ApplicationScopeBasis>,
    selected: &[ApplicationScopeBasis],
) -> Result<(), CommandError> {
    let mut captured = BTreeMap::new();
    for basis in selected {
        if captured.insert(basis.instance_id, basis.clone()).is_some() {
            return Err(stale());
        }
    }
    if &captured != expected {
        return Err(denied());
    }
    Ok(())
}

fn application_leases_match(
    plan: &WorkPlan,
    leases: &BTreeMap<ExecutionId, ApplicationExecutionLease>,
) -> bool {
    let tools: Vec<_> = plan
        .tools
        .iter()
        .flat_map(|tools| &tools.entries)
        .filter(|tool| {
            tool.execution.component_scope == tsumugi_plugin_sdk::ComponentScope::Application
        })
        .collect();
    tools.len() == leases.len()
        && tools.into_iter().all(|tool| {
            leases
                .get(&tool.handle)
                .is_some_and(|lease| lease.matches_binding(&tool.execution))
        })
}

pub(super) fn check_application_request(
    plan: &WorkPlan,
    applications: &[ApplicationScopeBasis],
) -> Result<(), CommandError> {
    check_application_selection(&application_selection(plan)?, applications)
}

pub(super) fn require_consent(
    plan: &WorkPlan,
    confirmed: bool,
    effects: Option<&[AutomationEffect]>,
    applications: &[ApplicationScopeBasis],
) -> Result<(), CommandError> {
    check_application_request(plan, applications)?;
    if plan.tools.is_some()
        && (!confirmed
            || effects.is_some_and(|effects| !effects.contains(&AutomationEffect::QueryTools)))
    {
        return Err(denied());
    }
    if plan.tools.is_none() && confirmed {
        return Err(stale());
    }
    Ok(())
}

pub(super) fn save_consent(
    host: &mut ExecutionHost,
    store: &ProjectStore,
    plan: &WorkPlan,
    receipt: &WorkPlanReceipt,
) -> Result<(), CommandError> {
    if plan.tools.is_none() {
        return Ok(());
    }
    if host
        .work_plans
        .tool_consents
        .get(&plan.plan_id)
        .is_some_and(|(lease, _)| *lease == receipt.lease)
    {
        return Ok(());
    }
    let intent = host
        .work_plans
        .tool_intents
        .get(&receipt.action_id)
        .ok_or_else(denied)?;
    if intent.generation != host.runtime.generation() {
        return Err(denied());
    }
    let expires_at_ms = intent.expiry()?;
    let deadline = intent.deadline;
    let status = store
        .work_plan_status(plan.plan_id)
        .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?;
    if status.lease != receipt.lease || status.state != WorkPlanState::Active {
        return Err(CommandError::unknown(CommandStage::ExecutionRecover));
    }
    let consent = host
        .runtime
        .authorize_work_plan_tools(
            store,
            receipt.lease,
            expires_at_ms.min(status.expires_at.checked_mul(1000).ok_or_else(denied)?),
            deadline,
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: !intent.application_leases.is_empty(),
            },
            intent.application_leases.clone(),
        )
        .map_err(map_recover)?;
    host.work_plans
        .tool_consents
        .insert(plan.plan_id, (receipt.lease, Arc::new(consent)));
    Ok(())
}

pub(super) fn restore_consent(
    host: &mut ExecutionHost,
    store: &ProjectStore,
    plan: &WorkPlan,
    receipt: &WorkPlanReceipt,
    request: &impl Serialize,
    plugins: &ApplicationPlugins,
) -> Result<(), CommandError> {
    let Some(intent) = host.work_plans.tool_intents.get(&receipt.action_id) else {
        return Ok(());
    };
    if serde_json::to_vec(request).map_err(|_| stale())? != intent.fingerprint {
        return Err(stale());
    }
    let status = store.work_plan_status(plan.plan_id).map_err(map_recover)?;
    if intent.generation != host.runtime.generation()
        || intent.expiry().is_err()
        || status.lease != receipt.lease
        || status.state != WorkPlanState::Active
        || !application_leases_match(plan, &intent.application_leases)
    {
        return Ok(());
    }
    let checker = match current_checker_consent(host, store, plan, receipt.lease) {
        Ok(checker) => checker,
        // A historical acknowledgement never recreates missing checker consent.
        Err(error) if error.reason.as_deref() == Some("plugin-consent-required") => return Ok(()),
        Err(error) => return Err(error),
    };
    let checker_revision = checker.as_ref().map(|consent| consent.settings_revision);
    let restore = with_plan_environment_revision(plugins, plan, checker_revision, || {
        save_consent(host, store, plan, receipt)
            .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))
    });
    match restore {
        // Preserve the historical acknowledgement while withdrawing authority
        // whose captured settings have changed. No grant is recreated.
        Err(error) if error.code == CommandErrorCode::DependencyConflict => Ok(()),
        result => result,
    }
}

pub(super) fn current_consent(
    host: &ExecutionHost,
    store: &ProjectStore,
    scope: &WorkPlanAgentScope,
) -> Result<Arc<WorkPlanToolConsent>, CommandError> {
    let consent = host
        .work_plans
        .tool_consents
        .get(&scope.lease().plan_id)
        .filter(|(lease, _)| *lease == scope.lease())
        .map(|(_, consent)| consent.clone())
        .ok_or_else(denied)?;
    host.runtime
        .check_work_plan_tool_consent(store, scope, &consent)
        .map_err(map_recover)?;
    Ok(consent)
}

fn selector(tool: &WorkPlanToolSpec) -> PluginToolRequest {
    PluginToolRequest {
        package: PluginPackageRequest {
            plugin: tool.binding.capability.provider.plugin.clone(),
            package_digest: tool.binding.capability.provider.package_digest.clone(),
        },
        resource_id: tool.resource_id.clone(),
        environment_digest: tool
            .execution
            .environment
            .digest()
            .expect("validated captured environment"),
    }
}

pub(super) fn load_runner(
    plugins: &ApplicationPlugins,
    prepared: &PreparedWorkPlanTool,
) -> Result<(UnsignedDecimal, Arc<RunnerProxy>, PluginExecutionBinding), CommandError> {
    let expected = prepared.tool();
    let selected = WorkPlanToolSelectionEntry {
        handle: expected.handle,
        tool: selector(expected),
        target: expected.target.clone(),
        selections: expected.selections.clone(),
    };
    let environment = plugins.capture_tool(&selected.tool)?;
    let application =
        if expected.execution.component_scope == tsumugi_plugin_sdk::ComponentScope::Application {
            Some(plugins.work_plan_tool_instance(expected)?)
        } else {
            None
        };
    if spec(environment.view()?, &selected, application.as_ref())? != *expected {
        return Err(stale());
    }
    let proxy = match application {
        Some(instance) => instance
            .runner(&environment.binding.capability.provider.contribution_id)
            .map_err(map_recover)?,
        None => RunnerProxy::new(
            environment.package.image().clone(),
            &environment.binding.declaration.capability_id,
            environment.runtime,
            environment.staging_parent,
            HostLimits::default(),
        )
        .map(Arc::new)
        .map_err(map_recover)?,
    };
    let binding = proxy
        .execution_binding(expected.binding.declaration.profile.clone())
        .map_err(map_recover)?;
    if prepared.input().envelope().plugin.as_ref() != Some(&binding) {
        return Err(stale());
    }
    Ok((expected.settings_revision, proxy, binding))
}

pub(super) fn ensure_application_ready(
    plugins: &ApplicationPlugins,
    prepared: &PreparedWorkPlanTool,
    deadline: Instant,
    cancellation: &Cancellation,
) -> Result<(), CommandError> {
    if prepared.tool().execution.component_scope != tsumugi_plugin_sdk::ComponentScope::Application
    {
        return Ok(());
    }
    let instance = plugins.work_plan_tool_instance(prepared.tool())?;
    let deadline = Instant::now()
        .checked_add(Duration::from_millis(
            prepared
                .tool()
                .binding
                .capability
                .declaration
                .limits
                .timeout_ms
                .into(),
        ))
        .ok_or_else(denied)?
        .min(deadline);
    instance
        .ensure_ready(deadline, cancellation)
        .map_err(map_recover)
}

pub(super) fn read_host(active: &ActiveSession) -> Result<&ExecutionHost, CommandError> {
    // An Agent scope exists only in its original host. Reads must not create a
    // new runtime while looking for an obsolete or invented handle.
    active.execution.as_ref().ok_or_else(|| {
        map_read(ExecutionError::new(
            ErrorCode::Unauthorized,
            "work-plan-agent-session",
        ))
    })
}

#[tauri::command]
pub async fn read_work_plan_agent_tool_attempt(
    state: State<'_, AppState>,
    request: WorkPlanAgentToolAttemptRequest,
) -> Result<AttemptDetail, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_agent_tool_attempt",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = read_host(active)?;
                let scope = agent::scope(host, &active.store, request.scope_id)?;
                active
                    .store
                    .read_work_plan_agent_tool_attempt(
                        &scope,
                        &request.tool,
                        &request.input_digest,
                        host.runtime.is_active(request.tool.attempt_id),
                        request.offset,
                        request.limit,
                    )
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_agent_tool_output(
    state: State<'_, AppState>,
    request: WorkPlanAgentToolOutputRequest,
) -> Result<ExecutionOutputView, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_agent_tool_output",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = read_host(active)?;
                let scope = agent::scope(host, &active.store, request.scope_id)?;
                let result = active
                    .store
                    .read_work_plan_agent_tool_output(
                        &scope,
                        &request.tool,
                        &request.input_digest,
                        request.item_id,
                        request.result_id,
                    )
                    .map_err(map_read)?;
                // The existing output projection is retained. A tool result is not
                // a source extractor artifact and cannot acquire that display role.
                Ok(ExecutionOutputView {
                    result: result.envelope().clone(),
                    source_failure: None,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn prepare_work_plan_agent_tool(
    state: State<'_, AppState>,
    request: WorkPlanAgentToolPrepareRequest,
) -> Result<WorkPlanAgentToolView, CommandError> {
    state
        .sessions
        .run(
            "prepare_work_plan_agent_tool",
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
                let scope = agent::scope(host, store, request.scope_id)?;
                current_consent(host, store, &scope)?;
                let prepared = store
                    .prepare_work_plan_agent_tool(&scope, &request.tool)
                    .map_err(map_recover)?;
                let plan = store
                    .work_plan(scope.lease().plan_id)
                    .map_err(map_recover)?;
                Ok(WorkPlanAgentToolView {
                    scope_id: request.scope_id,
                    parent_task: scope.parent_task(),
                    task_id: prepared.input().envelope().task_id,
                    attempt_id: prepared.input().envelope().attempt_id,
                    tool_handle: prepared.tool().handle,
                    input_digest: prepared.input().digest().into(),
                    scope: plan
                        .selection_basis
                        .into_iter()
                        .filter(|unit| request.tool.unit_ids.contains(&unit.unit_id))
                        .collect(),
                })
            },
        )
        .await
}

pub(super) type AgentToolAdmission = (
    ExecutionId,
    Arc<PreparedWorkPlanTool>,
    Arc<WorkPlanToolConsent>,
);
pub(super) type AgentToolRunner = (UnsignedDecimal, Arc<RunnerProxy>, PluginExecutionBinding);

pub(super) fn begin_agent_tool(
    sessions: &mut SessionManager,
    initial: &WorkPlanAgentToolStartRequest,
) -> Result<Option<AgentToolAdmission>, CommandError> {
    let active = authorized(
        sessions,
        &initial.session_token,
        initial.project_id,
        CommandStage::ExecutionRecover,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    let scope = agent::scope(host, store, initial.scope_id)?;
    begin_tool_in_scope(host, store, initial, &scope)
}

pub(super) fn begin_captured_agent_tool(
    sessions: &mut SessionManager,
    initial: &WorkPlanAgentToolStartRequest,
    scope: &WorkPlanAgentScope,
) -> Result<Option<AgentToolAdmission>, CommandError> {
    let active = authorized(sessions, &initial.session_token, initial.project_id,
        CommandStage::ExecutionRecover)?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    begin_tool_in_scope(host, store, initial, scope)
}

fn begin_tool_in_scope(
    host: &mut ExecutionHost,
    store: &mut ProjectStore,
    initial: &WorkPlanAgentToolStartRequest,
    scope: &WorkPlanAgentScope,
) -> Result<Option<AgentToolAdmission>, CommandError> {
    let consent = current_consent(host, store, &scope)?;
    let prepared = store
        .prepare_work_plan_agent_tool(&scope, &initial.tool)
        .map_err(map_recover)?;
    if prepared.input().digest() != initial.input_digest {
        return Err(stale());
    }
    if let Some(prior) = host.work_plans.tool_starts.get(&initial.tool.attempt_id) {
        if prior.request != *initial {
            return Err(stale());
        }
        return match store.execution_input(initial.tool.attempt_id) {
            Ok(input) if input.bytes() == prepared.input().bytes() => Ok(None),
            Ok(_) => Err(stale()),
            Err(error) if error.code == ErrorCode::InvalidInput => {
                Err(CommandError::unknown(CommandStage::ExecutionRecover))
            }
            Err(error) => Err(map_recover(error)),
        };
    }
    if host.work_plans.tool_starts.len() >= 300 {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::LimitExceeded,
            "work-plan-tool-starts",
        )));
    }
    Ok(Some((
        host.tools.begin_for_plan(initial.tool.attempt_id, Some(scope.lease().plan_id))?,
        Arc::new(prepared),
        consent,
    )))
}

pub(super) fn finish_agent_tool(
    sessions: &mut SessionManager,
    plugins: &ApplicationPlugins,
    request: WorkPlanAgentToolStartRequest,
    ticket: ExecutionId,
    prepared: Arc<PreparedWorkPlanTool>,
    consent: Arc<WorkPlanToolConsent>,
    loaded: Result<AgentToolRunner, CommandError>,
) -> Result<ExecutionId, CommandError> {
    finish_captured_agent_tool(sessions, plugins, request, ticket, prepared, consent, loaded, None)
}

pub(super) fn finish_captured_agent_tool(
    sessions: &mut SessionManager,
    plugins: &ApplicationPlugins,
    request: WorkPlanAgentToolStartRequest,
    ticket: ExecutionId,
    prepared: Arc<PreparedWorkPlanTool>,
    consent: Arc<WorkPlanToolConsent>,
    loaded: Result<AgentToolRunner, CommandError>,
    captured_scope: Option<WorkPlanAgentScope>,
) -> Result<ExecutionId, CommandError> {
    finish_captured_agent_tool_impl(sessions, plugins, request, ticket, prepared, consent,
        loaded, captured_scope, false)
}

/// Called only inside the member's already acquired settings guard. The IO
/// ticket stays untouched while admission waits outside the project owner.
pub(super) fn finish_captured_agent_tool_current(
    sessions: &mut SessionManager,
    plugins: &ApplicationPlugins,
    request: WorkPlanAgentToolStartRequest,
    ticket: ExecutionId,
    prepared: Arc<PreparedWorkPlanTool>,
    consent: Arc<WorkPlanToolConsent>,
    loaded: Result<AgentToolRunner, CommandError>,
    captured_scope: Option<WorkPlanAgentScope>,
) -> Result<ExecutionId, CommandError> {
    finish_captured_agent_tool_impl(sessions, plugins, request, ticket, prepared, consent,
        loaded, captured_scope, true)
}

fn finish_captured_agent_tool_impl(
    sessions: &mut SessionManager,
    plugins: &ApplicationPlugins,
    request: WorkPlanAgentToolStartRequest,
    ticket: ExecutionId,
    prepared: Arc<PreparedWorkPlanTool>,
    consent: Arc<WorkPlanToolConsent>,
    loaded: Result<AgentToolRunner, CommandError>,
    captured_scope: Option<WorkPlanAgentScope>,
    current_environment: bool,
) -> Result<ExecutionId, CommandError> {
    let active = super::super::tools::finish_job(
        sessions,
        &request.session_token,
        request.project_id,
        ticket,
    )?;
    let (host, store) = active.execution_parts()?;
    let scope = match captured_scope {
        Some(scope) => scope,
        None => agent::scope(host, store, request.scope_id)?,
    };
    let actual_consent = current_consent(host, store, &scope)?;
    if !Arc::ptr_eq(&consent, &actual_consent) {
        return Err(stale());
    }
    let actual = store
        .prepare_work_plan_agent_tool(&scope, &request.tool)
        .map_err(map_recover)?;
    if actual.input().bytes() != prepared.input().bytes() {
        return Err(stale());
    }
    let (revision, proxy, binding) = loaded?;
    let submit = || {
        host.register_plugin(proxy, binding).map_err(map_recover)?;
        let start = ToolStart {
            request: request.clone(),
            grant_id: ExecutionId::new(),
        };
        host.work_plans
            .tool_starts
            .insert(request.tool.attempt_id, start.clone());
        // Preserve the first identity if commit/acknowledgement is uncertain.
        // Reconciliation observes the ledger; it never submits a second call.
        if let Err(error) =
            host.runtime
                .submit_work_plan_tool(store, &actual, &consent, start.grant_id)
        {
            if error.code != ErrorCode::OutcomeUnknown {
                host.work_plans.tool_starts.remove(&request.tool.attempt_id);
            }
            return Err(map_recover(error));
        }
        Ok(request.tool.attempt_id)
    };
    if current_environment {
        submit()
    } else {
        plugins.with_environment_revision(revision, submit)
    }
}

#[tauri::command]
pub async fn start_work_plan_agent_tool(
    state: State<'_, AppState>,
    request: WorkPlanAgentToolStartRequest,
) -> Result<ExecutionId, CommandError> {
    tsumugi_plugin_sdk::validate_package_digest(&request.input_digest).map_err(|_| stale())?;
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "start_work_plan_agent_tool.begin",
        CommandStage::ExecutionRecover,
        move |sessions| begin_agent_tool(sessions, &initial),
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let Some((ticket, prepared, consent)) = admitted.await? else {
            return Ok(request.tool.attempt_id);
        };
        let captured = prepared.clone();
        let current = plugins.clone();
        let ready_deadline = consent.deadline();
        let loaded = io
            .run(CommandStage::ExecutionRecover, move || {
                let loaded = load_runner(&current, &captured)?;
                ensure_application_ready(
                    &current,
                    &captured,
                    ready_deadline,
                    &Cancellation::default(),
                )?;
                Ok(loaded)
            })
            .await;
        lease
            .run(
                "start_work_plan_agent_tool.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    finish_agent_tool(
                        sessions, &plugins, request, ticket, prepared, consent, loaded,
                    )
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}

#[cfg(test)]
mod tests;
