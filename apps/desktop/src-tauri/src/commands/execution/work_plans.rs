//! Work-plan commands share the ordinary project session and runtime.
pub(crate) mod agent;
pub(crate) mod broker;
pub(crate) mod coordination;
pub(crate) mod recovery;
pub(crate) mod generation;
pub(crate) mod guidance;
pub(crate) mod member;
pub(crate) mod team;
use super::review::checkers::{CheckerEnvironment, ReviewCheckerView, capture_advisory};
use super::{ai_wire::AiPreviewView, *};
use crate::commands::{
    connections,
    dispatch::BlockingExecutor,
    plugins::{ApplicationPlugins, reviews::PluginTextReviewSelection},
};
use tsumugi_core::content::SourceReviewBinding;
use tsumugi_core::{AdvisoryReviewCheck, ReviewChecker, ReviewCheckerKey};
use tsumugi_core::{
    ai::{self, AiConfig, AiPreview},
    application::{
        AuthorizeWorkPlan, AutomationEffect, AutomationLease, ControlWorkPlan,
        MaintenanceAssessment, MaintenancePlanBasis, PlanOptions, PlanSelectionBasis,
        SetWorkProtection, WorkPlan, WorkPlanAgentScope, WorkPlanCommand, WorkPlanReceipt,
        WorkPlanState, WorkPlanStatus, WorkPlanToolConsent, WorkPlanTools, WorkProtection,
    },
};
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};

#[derive(Default)]
pub(super) struct WorkPlanSession {
    prepared: Option<WorkPlan>,
    generation: generation::GenerationSession,
    environments: BTreeMap<ExecutionId, (String, Vec<CheckerEnvironment>)>,
    checker_consents: BTreeMap<ExecutionId, CheckerConsent>,
    agent_scopes: BTreeMap<ExecutionId, WorkPlanAgentScope>,
    tool_consents: BTreeMap<ExecutionId, (AutomationLease, Arc<WorkPlanToolConsent>)>,
    tool_starts: BTreeMap<ExecutionId, broker::ToolStart>,
    tool_intents: BTreeMap<ExecutionId, broker::HumanToolIntent>,
    recovery: Option<recovery::RecoveryPreparation>,
    #[cfg(test)]
    recovery_authorize_probe: Option<generation::CaptureProbe>,
    #[cfg(test)]
    tool_reply_probes: BTreeMap<ExecutionId, member::ToolReplyProbe>,
    #[cfg(test)]
    member_guidance_probes: BTreeMap<ExecutionId, member::GuidanceReadProbe>,
}
impl WorkPlanSession {
    pub(super) fn stop_package(
        &mut self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) {
        let affected: Vec<_> = self
            .environments
            .iter()
            .filter(|(_, (_, environments))| {
                environments.iter().any(|environment| {
                    environment.key().is_ok_and(|key| {
                        package_lifecycle::provider_package(&key.provider) == *package
                    })
                })
            })
            .map(|(id, _)| *id)
            .collect();
        if self
            .prepared
            .as_ref()
            .is_some_and(|plan| affected.contains(&plan.plan_id))
        {
            self.prepared = None;
        }
        for id in affected {
            self.environments.remove(&id);
        }
        self.checker_consents.retain(|_, consent| {
            !consent
                .bindings
                .iter()
                .any(|checker| package_lifecycle::binding_package(&checker.binding) == *package)
        });
    }
    pub(super) fn generation_preparation_active(&self) -> bool {
        self.generation.active()
    }
    pub(super) fn plan_generation_preparation_active(&self, plan: ExecutionId) -> bool {
        self.generation.plan_active(plan)
    }
    pub(super) fn stop(&mut self) {
        self.clear_recovery();
        self.prepared = None;
        self.generation.stop();
        self.environments.clear();
        self.checker_consents.clear();
        self.agent_scopes.clear();
        self.tool_consents.clear();
        self.tool_starts.clear();
        self.tool_intents.clear();
    }
    fn clear_recovery(&mut self) {
        if let Some(preparation) = self.recovery.take() {
            preparation.stop.request();
        }
    }
}

#[derive(Clone)]
pub(super) struct CheckerConsent {
    pub lease: AutomationLease,
    pub bindings: Vec<ReviewChecker>,
    pub expires_at_ms: u64,
    pub settings_revision: UnsignedDecimal,
    pub plugins: Arc<ApplicationPlugins>,
}
impl CheckerConsent {
    pub(super) fn with_current_environment<T>(
        &self,
        operation: impl FnOnce() -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        self.plugins
            .with_environment_revision(self.settings_revision, operation)
    }
}

fn current_checker_consent(
    host: &ExecutionHost,
    store: &ProjectStore,
    plan: &WorkPlan,
    lease: AutomationLease,
) -> Result<Option<CheckerConsent>, CommandError> {
    let checker = host
        .work_plans
        .checker_consents
        .get(&plan.plan_id)
        .filter(|consent| consent.lease == lease)
        .cloned();
    let bindings = store.work_plan_review_checkers(plan).map_err(map_recover)?;
    if checker
        .as_ref()
        .map_or(!bindings.is_empty(), |consent| consent.bindings != bindings)
    {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::Unauthorized,
            "plugin-consent-required",
        )));
    }
    Ok(checker)
}

/// The two approvals share one settings owner. Compare both captured revisions
/// before taking its guard once; nesting its guards would lock the same manager.
fn with_plan_environment_revision<T>(
    plugins: &ApplicationPlugins,
    plan: &WorkPlan,
    checker_revision: Option<UnsignedDecimal>,
    operation: impl FnOnce() -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let Some(checker_revision) = checker_revision else {
        return broker::with_tools_revision(plugins, plan, operation);
    };
    if broker::tools_revision(plan)?.is_some_and(|revision| revision != checker_revision) {
        return Err(super::review::checkers::stale());
    }
    plugins.with_environment_revision(checker_revision, operation)
}

fn checker_environment_revision(
    environments: &[CheckerEnvironment],
) -> Result<Option<UnsignedDecimal>, CommandError> {
    let revision = environments
        .first()
        .map(CheckerEnvironment::settings_revision);
    if environments
        .iter()
        .any(|environment| Some(environment.settings_revision()) != revision)
    {
        return Err(super::review::checkers::stale());
    }
    Ok(revision)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanCheckerView {
    Ready {
        checker: ReviewCheckerKey,
        plugin: ReviewCheckerView,
    },
    Unavailable {
        checker: ReviewCheckerKey,
        error: CommandError,
    },
}

async fn load_checkers(
    io: BlockingExecutor,
    plugins: Arc<ApplicationPlugins>,
    source: Option<SourceReviewBinding>,
    checkers: Vec<ReviewChecker>,
    advisory: Vec<AdvisoryReviewCheck>,
    cached: Option<Vec<CheckerEnvironment>>,
    work: package_lifecycle::PackageWork,
) -> Result<(Vec<CheckerEnvironment>, Vec<WorkPlanCheckerView>), CommandError> {
    io.run(CommandStage::ExecutionRead, move || {
        work.check()?;
        let mut environments = Vec::new();
        let mut views = Vec::new();
        for checker in checkers {
            let loaded = (|| {
                if let Some(environment) = cached.as_ref().and_then(|cache| {
                    cache
                        .iter()
                        .find(|environment| environment.key().ok().as_ref() == Some(&checker.key))
                }) {
                    if plugins.environment_settings_revision()? == environment.settings_revision() {
                        return Ok(environment.clone());
                    }
                }
                let source = source.as_ref().ok_or_else(super::review::checkers::stale)?;
                CheckerEnvironment::capture(&plugins, &checker, source, &advisory)
            })();
            match loaded.and_then(|environment| environment.view().map(|view| (environment, view)))
            {
                Ok((environment, plugin)) => {
                    environments.push(environment);
                    views.push(WorkPlanCheckerView::Ready {
                        checker: checker.key,
                        plugin,
                    });
                }
                Err(error) => views.push(WorkPlanCheckerView::Unavailable {
                    checker: checker.key,
                    error,
                }),
            }
        }
        Ok((environments, views))
    })
    .await
}

fn consent_environments(
    host: &ExecutionHost,
    store: &ProjectStore,
    plan: &WorkPlan,
    confirmed: &[ReviewCheckerKey],
) -> Result<Vec<(CheckerEnvironment, ReviewChecker)>, CommandError> {
    let bindings = store.work_plan_review_checkers(plan).map_err(map_recover)?;
    let keys: Vec<_> = bindings.iter().map(|checker| checker.key.clone()).collect();
    if confirmed != keys {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::Unauthorized,
            "plugin-consent-required",
        )));
    }
    if bindings.is_empty() {
        return Ok(Vec::new());
    }
    let environments = host
        .work_plans
        .environments
        .get(&plan.plan_id)
        .filter(|(digest, _)| digest == &plan.digest)
        .ok_or_else(super::review::checkers::stale)?;
    bindings
        .into_iter()
        .map(|checker| {
            let environment = environments
                .1
                .iter()
                .find(|environment| environment.key().ok().as_ref() == Some(&checker.key))
                .ok_or_else(super::review::checkers::stale)?;
            if environment.binding()? != checker.binding {
                return Err(super::review::checkers::stale());
            }
            Ok((environment.clone(), checker))
        })
        .collect()
}

async fn checker_runners(
    io: BlockingExecutor,
    plugins: Arc<ApplicationPlugins>,
    environments: Vec<(CheckerEnvironment, ReviewChecker)>,
    work: Option<PackageWork>,
) -> Result<
    (
        Option<UnsignedDecimal>,
        Vec<(Arc<RunnerProxy>, ReviewChecker)>,
    ),
    CommandError,
> {
    io.run(CommandStage::ExecutionRecover, move || {
        if let Some(work) = &work {
            work.check()?;
        }
        let mut revision = None;
        let runners = environments
            .into_iter()
            .map(|(environment, checker)| {
                let current = environment.reopen(&plugins)?;
                if current.binding()? != checker.binding {
                    return Err(super::review::checkers::stale());
                }
                if revision.is_some_and(|revision| revision != current.settings_revision()) {
                    return Err(super::review::checkers::stale());
                }
                revision = Some(current.settings_revision());
                Ok((current.runner()?, checker))
            })
            .collect::<Result<Vec<_>, CommandError>>()?;
        Ok((revision, runners))
    })
    .await
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanPrepareRequest {
        config: Option<AiConfig>,
        locale: String,
        unit_ids: Vec<ExecutionId>,
        options: PlanOptions,
        advisory_checks: Vec<PluginTextReviewSelection>,
        tool_selection: Option<broker::WorkPlanToolSelection>,
        #[serde(deserialize_with = "tsumugi_core::application::required_maintenance")]
        #[cfg_attr(feature = "wire-schema", schemars(schema_with = "tsumugi_core::application::maintenance_schema"))]
        maintenance: Option<MaintenancePlanBasis>
    }
);

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    MaintenanceAssessmentRequest {
        snapshot_id: ExecutionId,
        locale: String,
        after: u32,
        limit: u32
    }
);
#[tauri::command]
pub async fn read_maintenance_assessment(
    state: State<'_, AppState>,
    request: MaintenanceAssessmentRequest,
) -> Result<MaintenanceAssessment, CommandError> {
    state
        .sessions
        .run(
            "read_maintenance_assessment",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .maintenance_assessment(
                    request.project_id,
                    request.snapshot_id,
                    &request.locale,
                    request.after,
                    request.limit,
                )
                .map_err(map_read)
            },
        )
        .await
}
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAuthorizeRequest {
        plan_id: ExecutionId,
        digest: String,
        action_id: ExecutionId,
        confirmed: bool,
        checker_executions: Vec<ReviewCheckerKey>,
        tool_execution: bool,
        #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
        application_tool_executions: Vec<tsumugi_core::execution::ApplicationScopeBasis>,
        effects: Vec<AutomationEffect>,
        expires_at: UnsignedDecimal
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanStartRequest {
        plan_id: ExecutionId,
        action_id: ExecutionId,
        expected_generation: Revision
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanControlRequest {
        action_id: ExecutionId,
        plan_id: ExecutionId,
        expected_generation: Revision,
        command: WorkPlanCommand,
        confirmed: bool,
        checker_executions: Vec<ReviewCheckerKey>,
        tool_execution: bool,
        #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
        application_tool_executions: Vec<tsumugi_core::execution::ApplicationScopeBasis>,
        expires_at: Option<UnsignedDecimal>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanStatusRequest {
        plan_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanActionRequest {
        action_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkProtectionReadRequest {
        unit_id: ExecutionId,
        locale: String
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkProtectionSetRequest {
        action_id: ExecutionId,
        unit_id: ExecutionId,
        locale: String,
        source_revision_id: ExecutionId,
        selection_id: Option<ExecutionId>,
        expected_revision: Revision,
        protected: bool,
        confirmed_release: bool
    }
);

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamMemberPreviewView {
    pub member_id: ExecutionId,
    pub preview: AiPreviewView,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanView {
    pub plan_id: ExecutionId,
    pub digest: String,
    pub locale: String,
    pub options: PlanOptions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_discussion_limits: Option<tsumugi_core::application::TeamDiscussionLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_previews: Option<Vec<TeamMemberPreviewView>>,
    pub scope: Vec<PlanSelectionBasis>,
    pub preview: Option<AiPreviewView>,
    pub attempt_id: Option<ExecutionId>,
    pub checkers: Vec<WorkPlanCheckerView>,
    pub tools: Option<WorkPlanTools>,
    #[serde(deserialize_with = "tsumugi_core::application::required_maintenance")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "tsumugi_core::application::maintenance_schema")
    )]
    pub maintenance: Option<MaintenancePlanBasis>,
}

impl TryFrom<&WorkPlan> for WorkPlanView {
    type Error = ExecutionError;

    fn try_from(plan: &WorkPlan) -> Result<Self, Self::Error> {
        plan.validate()?;
        let preview = if plan.input.is_some() {
            let input = plan.fixed_input()?;
            let settings = ai::settings(&input)?;
            let items = input
                .envelope()
                .items
                .iter()
                .map(|item| ai::item_payload(&input, item.item_id))
                .collect::<Result<Vec<_>, _>>()?;
            let digest = ai::preview_digest(&settings.config, &items)?;
            Some(AiPreviewView::from(AiPreview {
                config: settings.config,
                recipe: settings.recipe,
                items,
                digest,
            }))
        } else {
            None
        };
        Ok(Self {
            plan_id: plan.plan_id,
            digest: plan.digest.clone(),
            locale: plan.locale.clone(),
            options: plan.options.clone(),
            team_discussion_limits: plan
                .options
                .team_discussions
                .as_ref()
                .map(|policy| tsumugi_core::application::TeamDiscussionLimits::for_policy(*policy)),
            member_previews: if plan.options.team_execution.is_some() {
                Some(plan.team_member_previews()?.into_iter().map(|member| TeamMemberPreviewView {
                    member_id: member.member_id, preview: member.preview.into(),
                }).collect())
            } else { None },
            scope: plan.selection_basis.clone(),
            preview,
            attempt_id: plan.input.as_ref().map(|input| input.attempt_id),
            checkers: Vec::new(),
            tools: plan.tools.clone(),
            maintenance: plan.maintenance.clone(),
        })
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanReceiptView {
    pub action_id: ExecutionId,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub attempt_id: Option<ExecutionId>,
    pub parent_task: Option<ExecutionId>,
}

impl From<WorkPlanReceipt> for WorkPlanReceiptView {
    fn from(receipt: WorkPlanReceipt) -> Self {
        Self {
            action_id: receipt.action_id,
            lease: receipt.lease,
            state: receipt.state,
            attempt_id: receipt.input.as_ref().map(|input| input.attempt_id),
            parent_task: receipt.parent_task,
        }
    }
}

/// Only the persisted Core transition; Host-local execution consent is independent.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum WorkPlanRecordedAction {
    #[serde(rename_all = "camelCase")]
    Authorize { plan_id:ExecutionId, action_id:ExecutionId, digest:String, confirmed:bool,
        effects:Vec<AutomationEffect>, expires_at:UnsignedDecimal },
    #[serde(rename_all = "camelCase")]
    Control { plan_id:ExecutionId, action_id:ExecutionId, expected_generation:Revision,
        command:WorkPlanCommand, confirmed:bool, expires_at:Option<UnsignedDecimal> },
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanActionReadView {
    pub project_id:ExecutionId,
    pub request:WorkPlanRecordedAction,
    pub receipt:WorkPlanReceiptView,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanStatusView {
    pub plan: WorkPlanView,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub effects: Vec<AutomationEffect>,
    pub expires_at: UnsignedDecimal,
    pub tool_invocations: Option<broker::WorkPlanToolUsage>,
}

impl WorkPlanStatusView {
    fn capture(plan: &WorkPlan, status: WorkPlanStatus) -> Result<Self, ExecutionError> {
        Ok(Self {
            plan: plan.try_into()?,
            lease: status.lease,
            state: status.state,
            effects: status.effects,
            expires_at: status.expires_at.into(),
            tool_invocations: None,
        })
    }
}

fn verify_plan_connections(
    connections_store: Option<&tsumugi_core::model_connections::ModelConnectionStore>,
    plan: &WorkPlan,
) -> Result<(), CommandError> {
    if plan.input.is_some() {
        let input = plan.fixed_input().map_err(map_read)?;
        let config = ai::settings(&input).map_err(map_read)?.config;
        connections::verify_configs(connections_store, std::slice::from_ref(&config))?;
    }
    if let Some(policy) = &plan.options.team_execution {
        let configs: Vec<_> = policy.members().iter().map(|member| member.config.clone()).collect();
        connections::verify_configs(connections_store, &configs)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanPrepareRequest,
) -> Result<WorkPlanView, CommandError> {
    let connection_store = connections::captured_store(&state);
    let initial_connections = connection_store.clone();
    if !request.options.advisory_checks.is_empty() {
        return Err(super::review::checkers::stale());
    }
    let plugins = state.plugins.clone();
    let selections = request.advisory_checks.clone();
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let selected_work = lease
        .run(
            "prepare_work_plan.advisory_capture",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, _) = active.execution_parts()?;
                host.allow_mutation()?;
                host.work_plans.clear_recovery();
                host.begin_package_work(
                    initial
                        .advisory_checks
                        .iter()
                        .map(|choice| choice.package.clone())
                        .chain(initial.tool_selection.iter().flat_map(|selection| {
                            selection.entries.iter().map(|choice| choice.tool.package.clone())
                        }))
                        .collect(),
                )
            },
        )
        .await?;
    let accepted_work = selected_work.clone();
    let selected = request.tool_selection.clone();
    let (advisory, tools) = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            accepted_work.check()?;
            let advisory = capture_advisory(&plugins, &selections)?;
            let tools = broker::capture_selection(&plugins, selected.as_ref())?;
            Ok((advisory, tools))
        })
        .await?;
    let mut initial = request.clone();
    initial.options.advisory_checks = advisory;
    let captured_tools = tools.clone();
    let captured = lease.submit(
        "prepare_work_plan.capture",
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
            selected_work.check()?;
            if let Some(config) = &initial.config {
                connections::verify_configs(
                    initial_connections.as_ref(),
                    std::slice::from_ref(config),
                )?;
            }
            if let Some(policy) = &initial.options.team_execution {
                let configs: Vec<_> = policy.members().iter().map(|member| member.config.clone()).collect();
                connections::verify_configs(initial_connections.as_ref(), &configs)?;
            }
            let plan = match initial.maintenance {
                Some(basis) => store.prepare_maintenance_work_plan(
                    initial.config,
                    &initial.locale,
                    &initial.unit_ids,
                    initial.options,
                    captured_tools,
                    basis,
                ),
                None => store.prepare_work_plan_with_tools(
                    initial.config,
                    &initial.locale,
                    &initial.unit_ids,
                    initial.options,
                    captured_tools,
                ),
            }
            .map_err(map_read)?;
            let source = store.work_plan_review_binding(&plan).map_err(map_read)?;
            let checkers = store.work_plan_review_checkers(&plan).map_err(map_read)?;
            let work = host.begin_package_work(
                checkers
                    .iter()
                    .map(|checker| package_lifecycle::binding_package(&checker.binding))
                    .chain(plan.tools.iter().flat_map(|tools| {
                        tools.entries.iter().map(|tool| {
                            package_lifecycle::binding_package(&tool.execution)
                        })
                    }))
                    .collect(),
            )?;
            Ok((plan, source, checkers, work, host.runtime.generation()))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (plan, source, checkers, work, generation) = captured.await?;
        let (environments, views) = load_checkers(
            io,
            plugins.clone(),
            source,
            checkers,
            plan.options.advisory_checks.clone(),
            None,
            work.clone(),
        )
        .await?;
        let checker_revision = checker_environment_revision(&environments)?;
        lease
            .run(
                "prepare_work_plan.finish",
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
                    work.check()?;
                    if host.runtime.generation() != generation {
                        return Err(map_read(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "work-plan-session",
                        )));
                    }
                    store.verify_work_plan(&plan).map_err(map_read)?;
                    let plan = if tools.is_some() {
                        match request.maintenance.clone() {
                            Some(basis) => store.prepare_maintenance_work_plan(
                                request.config.clone(),
                                &request.locale,
                                &request.unit_ids,
                                plan.options.clone(),
                                tools,
                                basis,
                            ),
                            None => store.prepare_work_plan_with_tools(
                                request.config.clone(),
                                &request.locale,
                                &request.unit_ids,
                                plan.options.clone(),
                                tools,
                            ),
                        }
                        .map_err(map_read)?
                    } else {
                        plan
                    };
                    let binding_plan = plan.clone();
                    let view = with_plan_environment_revision(&plugins, &plan, checker_revision, || {
                        verify_plan_connections(connection_store.as_ref(), &plan)?;
                        let mut view = WorkPlanView::try_from(&plan).map_err(map_read)?;
                        view.checkers = views;
                        if !environments.is_empty() {
                            if host.work_plans.environments.len() >= 8 {
                                host.work_plans.environments.clear();
                            }
                            host.work_plans
                                .environments
                                .insert(plan.plan_id, (plan.digest.clone(), environments));
                        } else {
                            host.work_plans.environments.remove(&plan.plan_id);
                        }
                        host.work_plans.prepared = Some(plan.clone());
                        Ok(view)
                    })?;
                    sessions.mcp_retrieval.bind_plan(
                        &request.session_token, request.project_id, &binding_plan,
                    )?;
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn authorize_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanAuthorizeRequest,
) -> Result<WorkPlanReceiptView, CommandError> {
    let connection_store = connections::captured_store(&state);
    let initial_connections = connection_store.clone();
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let captured_plugins = state.plugins.clone();
    let initial = request.clone();
    let captured = lease.submit(
        "authorize_work_plan.capture",
        CommandStage::ExecutionRecover,
        move |sessions| {
            let claim = {
                let active = authorized(sessions, &initial.session_token, initial.project_id,
                    CommandStage::ExecutionRecover)?;
                if active.store.work_plan_receipt(initial.action_id).map_err(map_recover)?.is_some() {
                    None
                } else {
                    active.execution.as_ref().and_then(|host| host.work_plans.prepared.as_ref())
                        .filter(|plan| plan.plan_id == initial.plan_id && plan.digest == initial.digest)
                        .cloned()
                }
            };
            if let Some(plan) = &claim {
                sessions.mcp_retrieval.claim_plan(&initial.session_token, initial.project_id, plan)?;
            }
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRecover,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            if let Some(receipt) = store
                .work_plan_receipt(initial.action_id)
                .map_err(map_recover)?
            {
                if receipt.lease.plan_id != initial.plan_id {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "work-plan-action",
                    )));
                }
                let plan = store
                    .work_plan(receipt.lease.plan_id)
                    .map_err(map_recover)?;
                broker::check_application_request(&plan, &initial.application_tool_executions)?;
                let receipt = store
                    .authorize_work_plan(
                        &plan,
                        &AuthorizeWorkPlan {
                            action_id: initial.action_id,
                            plan_digest: initial.digest.clone(),
                            confirmed: initial.confirmed,
                            effects: initial.effects.clone(),
                            expires_at: initial.expires_at.get(),
                        },
                    )
                    .map_err(map_recover)?;
                broker::restore_consent(host, store, &plan, &receipt, &initial, &captured_plugins)?;
                return Ok(Err(WorkPlanReceiptView::from(receipt)));
            }
            let prepared = host
                .work_plans
                .prepared
                .as_ref()
                .filter(|plan| plan.plan_id == initial.plan_id && plan.digest == initial.digest)
                .cloned();
            if let Some(plan) = prepared {
                verify_plan_connections(initial_connections.as_ref(), &plan)?;
                broker::require_consent(
                    &plan,
                    initial.tool_execution,
                    Some(&initial.effects),
                    &initial.application_tool_executions,
                )?;
                if !initial.application_tool_executions.is_empty() {
                    store.verify_work_plan(&plan).map_err(map_recover)?;
                }
                broker::capture_human_intent(
                    host,
                    &plan,
                    initial.action_id,
                    initial.expires_at.get(),
                    &initial,
                    &initial.application_tool_executions,
                    initial.confirmed,
                    &captured_plugins,
                )?;
                let environments =
                    consent_environments(host, store, &plan, &initial.checker_executions)?;
                let work = host.begin_plan_work(
                    plan.plan_id,
                    environments
                        .iter()
                        .map(|(_, checker)| package_lifecycle::binding_package(&checker.binding))
                        .collect(),
                )?;
                Ok(Ok((plan, environments, work, host.runtime.generation())))
            } else {
                // Read-only replay returns historical authority without recreating local consent.
                let receipt = store
                    .work_plan_receipt(initial.action_id)
                    .map_err(map_recover)?
                    .filter(|receipt| receipt.lease.plan_id == initial.plan_id)
                    .ok_or_else(|| {
                        map_recover(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "work-plan-preview",
                        ))
                    })?;
                let plan = store
                    .work_plan(receipt.lease.plan_id)
                    .map_err(map_recover)?;
                broker::check_application_request(&plan, &initial.application_tool_executions)?;
                let receipt = store
                    .authorize_work_plan(
                        &plan,
                        &AuthorizeWorkPlan {
                            action_id: initial.action_id,
                            plan_digest: initial.digest,
                            confirmed: initial.confirmed,
                            effects: initial.effects,
                            expires_at: initial.expires_at.get(),
                        },
                    )
                    .map_err(map_recover)?;
                Ok(Err(WorkPlanReceiptView::from(receipt)))
            }
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (plan, environment, work, generation) = match captured.await? {
            Ok(value) => value,
            Err(receipt) => return Ok(receipt),
        };
        let (settings_revision, runners) =
            checker_runners(io, plugins.clone(), environment, Some(work.clone())).await?;
        lease
            .run(
                "authorize_work_plan.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let accepted = authorized(sessions, &request.session_token, request.project_id,
                        CommandStage::ExecutionRecover)?.store.work_plan_receipt(request.action_id)
                        .map_err(map_recover)?.is_some();
                    if !accepted {
                        sessions.mcp_retrieval.claim_plan(
                            &request.session_token, request.project_id, &plan,
                        )?;
                    }
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRecover,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    host.allow_mutation()?;
                    work.check()?;
                    if host.runtime.generation() != generation {
                        return Err(map_recover(ExecutionError::new(
                            ErrorCode::Unauthorized,
                            "work-plan-session",
                        )));
                    }
                    let finish = || {
                        store.verify_work_plan(&plan).map_err(map_recover)?;
                        if store
                            .work_plan_receipt(request.action_id)
                            .map_err(map_recover)?
                            .is_none()
                        {
                            verify_plan_connections(connection_store.as_ref(), &plan)?;
                        }
                        let mut bindings = Vec::new();
                        for (runner, checker) in runners {
                            host.register_plugin(runner, checker.binding.clone())
                                .map_err(map_recover)?;
                            bindings.push(checker);
                        }
                        let receipt = store
                            .authorize_work_plan(
                                &plan,
                                &AuthorizeWorkPlan {
                                    action_id: request.action_id,
                                    plan_digest: request.digest,
                                    confirmed: request.confirmed,
                                    effects: request.effects,
                                    expires_at: request.expires_at.get(),
                                },
                            )
                            .map_err(map_recover)?;
                        broker::save_consent(host, store, &plan, &receipt)
                            .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?;
                        if !bindings.is_empty() {
                            let status = store.work_plan_status(plan.plan_id).map_err(|_| {
                                CommandError::unknown(CommandStage::ExecutionRecover)
                            })?;
                            if status.lease == receipt.lease
                                && status.state == WorkPlanState::Active
                                && status.expires_at == request.expires_at.get()
                            {
                                host.work_plans.checker_consents.insert(
                                    plan.plan_id,
                                    CheckerConsent {
                                        lease: receipt.lease,
                                        bindings,
                                        expires_at_ms: status.expires_at.saturating_mul(1000),
                                        settings_revision: settings_revision
                                            .expect("checker snapshot"),
                                        plugins: plugins.clone(),
                                    },
                                );
                            }
                        }
                        Ok(receipt.into())
                    };
                    with_plan_environment_revision(&plugins, &plan, settings_revision, finish)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}

#[tauri::command]
pub async fn read_work_plan_start_action(
    state: State<'_, AppState>, request: WorkPlanStartRequest,
) -> Result<Option<tsumugi_core::application::WorkPlanStartReceipt>, CommandError> {
    state.sessions.run("read_work_plan_start_action", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?
            .store.work_plan_start_action_read(request.project_id, request.plan_id, request.action_id, request.expected_generation)
            .map_err(map_read)
    }).await
}
#[tauri::command]
pub async fn start_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanStartRequest,
) -> Result<ExecutionId, CommandError> {
    let plugins = state.plugins.clone();
    state
        .sessions
        .run(
            "start_work_plan",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                // Exact acknowledgement is separate from admitting a new work.
                // It remains readable after its original Host or grant is gone.
                if let Some(receipt) = active.store.work_plan_receipt(request.action_id).map_err(map_recover)? {
                    if let Some(input) = receipt.input.filter(|input| input.operation == ai::team::OPERATION) {
                        let fixed = FixedInput::capture(input).map_err(map_read)?;
                        if matches!(ai::team::settings(&fixed).map_err(map_read)?.binding,
                            tsumugi_core::application::TeamWorkBinding::Root { .. }
                            | tsumugi_core::application::TeamWorkBinding::HumanContinuation { .. }) {
                            if let Some(start) = active.store.work_plan_start_action_read(
                                request.project_id, request.plan_id, request.action_id, request.expected_generation,
                            ).map_err(map_read)? {
                                return Ok(start.attempt_id);
                            }
                        }
                    }
                }
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let receipt = store
                    .work_plan_receipt(request.action_id)
                    .map_err(map_recover)?
                    .ok_or_else(|| {
                        map_recover(ExecutionError::new(
                            ErrorCode::Unauthorized,
                            "work-plan-authorization",
                        ))
                    })?;
                let status = store
                    .work_plan_status(request.plan_id)
                    .map_err(map_recover)?;
                if receipt.lease.plan_id != request.plan_id
                    || receipt.lease.generation != request.expected_generation
                    || receipt.lease != status.lease
                    || receipt.cancellation_revision != status.cancellation_revision
                    || receipt.state != WorkPlanState::Active
                    || status.state != WorkPlanState::Active
                {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "work-plan-generation",
                    )));
                }
                let plan = store.work_plan(request.plan_id).map_err(map_recover)?;
                let checker = current_checker_consent(host, store, &plan, receipt.lease)?;
                let checker_revision = checker.as_ref().map(|consent| consent.settings_revision);
                if plan.options.team_execution.is_some() {
                    let prepared = store.prepare_team_start(receipt.lease, request.action_id)
                        .map_err(map_recover)?;
                    let recovery_revision = recovery::start_revision(host, &prepared, request.action_id)?;
                    if recovery_revision.zip(checker_revision).is_some_and(|(recovery, checker)| recovery != checker) {
                        return Err(super::review::checkers::stale());
                    }
                    let start = || {
                        let accepted = host.runtime.submit_team_work(store, &prepared)
                            .map_err(map_recover)?;
                        host.ai.track(store, prepared.input(), checker).map_err(map_recover)?;
                        Ok(accepted.attempt_id)
                    };
                    return with_plan_environment_revision(&plugins, &plan, recovery_revision.or(checker_revision), start);
                }
                let envelope = receipt.input.ok_or_else(|| {
                    map_recover(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "work-plan-manual",
                    ))
                })?;
                if envelope.automation != Some(receipt.lease)
                    || envelope.project_id != request.project_id
                {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::CorruptLedger,
                        "work-plan-receipt",
                    )));
                }
                // These IDs and settings are from the durable receipt. Capturing
                // their fixed bytes never previews work or allocates new identities.
                let input = FixedInput::capture(envelope).map_err(map_recover)?;
                match store.execution_input(input.envelope().attempt_id) {
                    Ok(existing) => {
                        if existing.bytes() != input.bytes() {
                            return Err(map_recover(ExecutionError::new(
                                ErrorCode::ResultMismatch,
                                "work-plan-start",
                            )));
                        }
                        store
                            .check_work_plan_input(&existing)
                            .map_err(map_recover)?;
                    }
                    Err(error)
                        if error.code == ErrorCode::InvalidInput
                            && error.stage == "execution-storage" => {}
                    Err(error) => return Err(map_recover(error)),
                }
                let start = || {
                    if let Some(parent) = receipt.parent_task {
                        host.runtime
                            .submit_child(store, &input, parent)
                            .map_err(map_recover)?;
                    } else {
                        host.runtime.submit(store, &input).map_err(map_recover)?;
                    }
                    host.ai.track(store, &input, checker).map_err(map_recover)?;
                    Ok(input.envelope().attempt_id)
                };
                with_plan_environment_revision(&plugins, &plan, checker_revision, start)
            },
        )
        .await
}

#[tauri::command]
pub async fn control_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanControlRequest,
) -> Result<WorkPlanReceiptView, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionCancel)?;
    if request.command != WorkPlanCommand::Continue {
        let plugins = state.plugins.clone();
        return lease
            .submit_review_control(
                "control_work_plan",
                request.session_token.clone(),
                request.project_id,
                move |sessions| {
                    if !request.application_tool_executions.is_empty() {
                        return Err(map_recover(ExecutionError::new(
                            ErrorCode::InvalidInput,
                            "work-plan-application-consent",
                        )));
                    }
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionCancel,
                    )?;
                    let recorded = active
                        .store
                        .work_plan_receipt(request.action_id)
                        .map_err(map_recover)?
                        .is_some();
                    let receipt = active
                        .store
                        .control_work_plan(&ControlWorkPlan {
                            action_id: request.action_id,
                            plan_id: request.plan_id,
                            expected_generation: request.expected_generation,
                            command: request.command,
                            confirmed: request.confirmed,
                            expires_at: request.expires_at.map(UnsignedDecimal::get),
                        })
                        .map_err(|error| map_execution(error, CommandStage::ExecutionCancel))?;
                    if recorded {
                        let plan = active
                            .store
                            .work_plan(receipt.lease.plan_id)
                            .map_err(map_recover)?;
                        let (host, store) = active.execution_parts()?;
                        broker::restore_consent(host, store, &plan, &receipt, &request, &plugins)?;
                    } else if let Some(host) = active.execution.as_mut() {
                        host.work_plans.tool_consents.remove(&request.plan_id);
                    }
                    // The receipt has committed in the original Core owner.
                    // This stops retrieval admission; it does not claim drain.
                    if !recorded {
                        sessions.mcp_retrieval.stop_plan(
                            &request.session_token,
                            request.project_id,
                            request.plan_id,
                        );
                    }
                    Ok(receipt.into())
                },
            )?
            .await;
    }
    let captured_plugins = state.plugins.clone();
    let initial = request.clone();
    let captured = lease.submit(
        "control_work_plan.capture",
        CommandStage::ExecutionCancel,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionCancel,
            )?;
            if active
                .store
                .work_plan_receipt(initial.action_id)
                .map_err(map_recover)?
                .is_some()
            {
                let receipt = active
                    .store
                    .control_work_plan(&ControlWorkPlan {
                        action_id: initial.action_id,
                        plan_id: initial.plan_id,
                        expected_generation: initial.expected_generation,
                        command: initial.command,
                        confirmed: initial.confirmed,
                        expires_at: initial.expires_at.map(UnsignedDecimal::get),
                    })
                    .map_err(|error| map_execution(error, CommandStage::ExecutionCancel))?;
                let plan = active
                    .store
                    .work_plan(receipt.lease.plan_id)
                    .map_err(map_recover)?;
                broker::check_application_request(&plan, &initial.application_tool_executions)?;
                let (host, store) = active.execution_parts()?;
                broker::restore_consent(host, store, &plan, &receipt, &initial, &captured_plugins)?;
                return Ok(Err(WorkPlanReceiptView::from(receipt)));
            }
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let plan = store.work_plan(initial.plan_id).map_err(map_recover)?;
            broker::require_consent(
                &plan,
                initial.tool_execution,
                None,
                &initial.application_tool_executions,
            )?;
            if !initial.application_tool_executions.is_empty() {
                store.verify_work_plan(&plan).map_err(map_recover)?;
            }
            if plan.tools.is_some() {
                let expiry = initial
                    .expires_at
                    .ok_or_else(|| {
                        map_recover(ExecutionError::new(
                            ErrorCode::InvalidInput,
                            "work-plan-expiry",
                        ))
                    })?
                    .get();
                broker::capture_human_intent(
                    host,
                    &plan,
                    initial.action_id,
                    expiry,
                    &initial,
                    &initial.application_tool_executions,
                    initial.confirmed,
                    &captured_plugins,
                )?;
            }
            let environments =
                consent_environments(host, store, &plan, &initial.checker_executions)?;
            let work = host.begin_plan_work(
                plan.plan_id,
                environments
                    .iter()
                    .map(|(_, checker)| package_lifecycle::binding_package(&checker.binding))
                    .collect(),
            )?;
            Ok(Ok((plan, environments, work, host.runtime.generation())))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (plan, environment, work, generation) = match captured.await? {
            Ok(environment) => environment,
            Err(receipt) => return Ok(receipt),
        };
        let (settings_revision, runners) =
            checker_runners(io, plugins.clone(), environment, Some(work.clone())).await?;
        lease
            .run(
                "control_work_plan.finish",
                CommandStage::ExecutionCancel,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionCancel,
                    )?;
                    work.check()?;
                    let finish = || {
                        let (host, _) = active.execution_parts()?;
                        host.allow_mutation()?;
                        if host.runtime.generation() != generation {
                            return Err(map_recover(ExecutionError::new(
                                ErrorCode::Unauthorized,
                                "work-plan-session",
                            )));
                        }
                        let mut bindings = Vec::new();
                        for (runner, checker) in runners {
                            let (host, _) = active.execution_parts()?;
                            host.allow_mutation()?;
                            host.register_plugin(runner, checker.binding.clone())
                                .map_err(map_recover)?;
                            bindings.push(checker);
                        }
                        let receipt = active
                            .store
                            .control_work_plan(&ControlWorkPlan {
                                action_id: request.action_id,
                                plan_id: request.plan_id,
                                expected_generation: request.expected_generation,
                                command: request.command,
                                confirmed: request.confirmed,
                                expires_at: request.expires_at.map(UnsignedDecimal::get),
                            })
                            .map_err(|error| map_execution(error, CommandStage::ExecutionCancel))?;
                        let (host, store) = active.execution_parts()?;
                        broker::save_consent(host, store, &plan, &receipt)
                            .map_err(|_| CommandError::unknown(CommandStage::ExecutionCancel))?;
                        if !bindings.is_empty() {
                            let (host, store) = active.execution_parts()?;
                            let status = store.work_plan_status(request.plan_id).map_err(|_| {
                                CommandError::unknown(CommandStage::ExecutionCancel)
                            })?;
                            if status.lease == receipt.lease
                                && status.state == WorkPlanState::Active
                            {
                                host.work_plans.checker_consents.insert(
                                    request.plan_id,
                                    CheckerConsent {
                                        lease: receipt.lease,
                                        bindings,
                                        expires_at_ms: status.expires_at.saturating_mul(1000),
                                        settings_revision: settings_revision
                                            .expect("checker snapshot"),
                                        plugins: plugins.clone(),
                                    },
                                );
                            }
                        }
                        Ok(receipt.into())
                    };
                    with_plan_environment_revision(&plugins, &plan, settings_revision, finish)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionCancel))?
}

#[tauri::command]
pub async fn read_work_plan_status(
    state: State<'_, AppState>,
    request: WorkPlanStatusRequest,
) -> Result<WorkPlanStatusView, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let captured = lease.submit(
        "read_work_plan_status.capture",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let plan = active.store.work_plan(initial.plan_id).map_err(map_read)?;
            let binding = active
                .store
                .work_plan_review_binding(&plan)
                .map_err(map_read)?;
            let cached = active
                .execution
                .as_ref()
                .and_then(|host| host.work_plans.environments.get(&plan.plan_id))
                .filter(|(digest, _)| digest == &plan.digest)
                .map(|(_, environment)| environment.clone());
            let checkers = active
                .store
                .work_plan_review_checkers(&plan)
                .map_err(map_read)?;
            let (host, _) = active.execution_parts()?;
            let work = host.begin_plan_work(
                plan.plan_id,
                checkers
                    .iter()
                    .map(|checker| package_lifecycle::binding_package(&checker.binding))
                    .collect(),
            )?;
            Ok((plan, binding, checkers, cached, work))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (plan, binding, checkers, cached, work) = captured.await?;
        let (environments, views) = load_checkers(
            io,
            plugins,
            binding,
            checkers,
            plan.options.advisory_checks.clone(),
            cached,
            work.clone(),
        )
        .await?;
        lease
            .run(
                "read_work_plan_status.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    work.check()?;
                    let status = store.work_plan_status(request.plan_id).map_err(map_read)?;
                    let mut view = WorkPlanStatusView::capture(&plan, status).map_err(map_read)?;
                    if plan.tools.is_some() || plan.options.mcp_term_query.is_some() {
                        let (reserved, limit) = store.work_plan_tool_usage(plan.plan_id).map_err(map_read)?;
                        view.tool_invocations = Some(broker::WorkPlanToolUsage {
                            reserved, limit,
                        });
                    }
                    view.plan.checkers = views;
                    if !environments.is_empty() {
                        if host.work_plans.environments.len() >= 8 {
                            host.work_plans.environments.clear();
                        }
                        host.work_plans
                            .environments
                            .insert(plan.plan_id, (plan.digest.clone(), environments));
                    } else {
                        host.work_plans.environments.remove(&plan.plan_id);
                    }
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn read_work_plan_authorization_action(
    state: State<'_,AppState>, request:WorkPlanAuthorizeRequest,
) -> Result<Option<WorkPlanActionReadView>,CommandError> {
    state.sessions.run("read_work_plan_authorization_action",CommandStage::ExecutionRead,move |sessions| {
        let active=authorized(sessions,&request.session_token,request.project_id,CommandStage::ExecutionRead)?;
        let receipt=active.store.work_plan_authorization_action_read(request.project_id,request.plan_id,&AuthorizeWorkPlan {
            action_id:request.action_id,plan_digest:request.digest.clone(),confirmed:request.confirmed,
            effects:request.effects.clone(),expires_at:request.expires_at.get(),
        }).map_err(map_read)?;
        Ok(receipt.map(|receipt|WorkPlanActionReadView {project_id:request.project_id,
            request:WorkPlanRecordedAction::Authorize {plan_id:request.plan_id,action_id:request.action_id,digest:request.digest,
                confirmed:request.confirmed,effects:request.effects,expires_at:request.expires_at},receipt:receipt.into()}))
    }).await
}
#[tauri::command]
pub async fn read_work_plan_control_action(
    state: State<'_,AppState>, request:WorkPlanControlRequest,
) -> Result<Option<WorkPlanActionReadView>,CommandError> {
    state.sessions.run("read_work_plan_control_action",CommandStage::ExecutionRead,move |sessions| {
        let active=authorized(sessions,&request.session_token,request.project_id,CommandStage::ExecutionRead)?;
        let receipt=active.store.work_plan_control_action_read(request.project_id,&ControlWorkPlan {
            action_id:request.action_id,plan_id:request.plan_id,expected_generation:request.expected_generation,
            command:request.command,confirmed:request.confirmed,expires_at:request.expires_at.map(UnsignedDecimal::get),
        }).map_err(map_read)?;
        Ok(receipt.map(|receipt|WorkPlanActionReadView {project_id:request.project_id,
            request:WorkPlanRecordedAction::Control {plan_id:request.plan_id,action_id:request.action_id,expected_generation:request.expected_generation,
                command:request.command,confirmed:request.confirmed,expires_at:request.expires_at},receipt:receipt.into()}))
    }).await
}

#[tauri::command]
pub async fn read_work_plan_action(
    state: State<'_, AppState>,
    request: WorkPlanActionRequest,
) -> Result<Option<WorkPlanReceiptView>, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .work_plan_receipt(request.action_id)
                    .map(|receipt| receipt.map(Into::into))
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_protection(
    state: State<'_, AppState>,
    request: WorkProtectionReadRequest,
) -> Result<WorkProtection, CommandError> {
    state
        .sessions
        .run(
            "read_work_protection",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .work_protection(request.unit_id, &request.locale)
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn set_work_protection(
    state: State<'_, AppState>,
    request: WorkProtectionSetRequest,
) -> Result<WorkProtection, CommandError> {
    state
        .sessions
        .run(
            "set_work_protection",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .set_work_protection(&SetWorkProtection {
                        action_id: request.action_id,
                        project_id: request.project_id,
                        unit_id: request.unit_id,
                        locale: request.locale,
                        source_revision_id: request.source_revision_id,
                        selection_id: request.selection_id,
                        expected_revision: request.expected_revision,
                        protected: request.protected,
                        confirmed_release: request.confirmed_release,
                    })
                    .map_err(map_adopt)
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    mod agent_subset_tests;
    mod broker_tests;
    mod generation_tests;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    mod guidance_tests;
    mod model_connection_admission;
    mod semantic_review;
    mod settings;
    mod tool_result_reads;
    mod team_history;
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    mod team_discussions;
    use super::*;
    use serde_json::{Value, json};
    use std::{net::TcpListener, time::SystemTime};
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    use tsumugi_core::application::{StageChoice, StageMode, WorkStage};

    fn checker_keys(plan: &Value) -> Vec<Value> {
        plan["checkers"]
            .as_array()
            .expect("actual checker preview required")
            .iter()
            .map(|checker| checker["checker"].clone())
            .collect()
    }

    #[test]
    fn maintenance_read_is_session_project_scoped_and_never_grants_or_starts_work() {
        let fixture = Fixture::create();
        let before = fixture.bytes();
        let attempts = fixture.attempt_count();
        let request = json!({"snapshotId":fixture.snapshot,"locale":"zh-CN","after":0,"limit":100});
        let view = fixture
            .call("read_maintenance_assessment", request.clone())
            .unwrap();
        assert_eq!(view["rows"].as_array().unwrap().len(), 1);
        assert_eq!(view["sourceSnapshotId"], json!(fixture.snapshot));
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), attempts);
        for field in ["projectId", "sessionToken"] {
            let mut invalid = request.clone();
            invalid[field] = json!(ExecutionId::new().to_string());
            assert!(
                fixture
                    .call("read_maintenance_assessment", invalid)
                    .is_err()
            );
        }
    }

    #[test]
    fn current_work_plan_wire_requires_explicit_maintenance_even_for_ordinary_plans() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/workPlanCommands.contract.json"
        ))
        .unwrap();
        let mut request = fixture["requests"]["prepare"].clone();
        request.as_object_mut().unwrap().remove("maintenance");
        assert!(serde_json::from_value::<WorkPlanPrepareRequest>(request).is_err());
        let mut plan = fixture["responses"]["plan"].clone();
        plan.as_object_mut().unwrap().remove("maintenance");
        assert!(serde_json::from_value::<WorkPlanView>(plan).is_err());
    }

    #[test]
    fn shared_work_plan_fixture_round_trips_through_serde() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/workPlanCommands.contract.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($group:literal, $key:literal, $ty:ty) => {{
                let value = fixture[$group][$key].clone();
                let decoded: $ty = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), value, "{}", $key);
            }};
        }
        round_trip!("requests", "prepare", WorkPlanPrepareRequest);
        round_trip!("requests", "discussionPrepare", WorkPlanPrepareRequest);
        round_trip!(
            "requests",
            "artifactDiscussionPrepare",
            WorkPlanPrepareRequest
        );
        round_trip!("requests", "authorize", WorkPlanAuthorizeRequest);
        round_trip!("requests", "discussionAuthorize", WorkPlanAuthorizeRequest);
        round_trip!(
            "requests",
            "artifactDiscussionAuthorize",
            WorkPlanAuthorizeRequest
        );
        round_trip!("requests", "start", WorkPlanStartRequest);
        round_trip!("requests", "control", WorkPlanControlRequest);
        round_trip!("requests", "status", WorkPlanStatusRequest);
        round_trip!("requests", "action", WorkPlanActionRequest);
        round_trip!("requests", "protectionRead", WorkProtectionReadRequest);
        round_trip!("requests", "protectionSet", WorkProtectionSetRequest);
        round_trip!("responses", "plan", WorkPlanView);
        round_trip!("responses", "discussionPlan", WorkPlanView);
        round_trip!("responses", "artifactDiscussionPlan", WorkPlanView);
        for key in ["discussionPlan", "artifactDiscussionPlan"] {
            let plan: WorkPlanView =
                serde_json::from_value(fixture["responses"][key].clone()).unwrap();
            assert_eq!(
                plan.team_discussion_limits,
                Some(tsumugi_core::application::TeamDiscussionLimits::for_policy(
                    plan.options.team_discussions.unwrap()
                ))
            );
        }
        round_trip!("responses", "receipt", WorkPlanReceiptView);
        round_trip!("responses", "control", WorkPlanReceiptView);
        round_trip!("responses", "status", WorkPlanStatusView);
        round_trip!("responses", "action", Option<WorkPlanReceiptView>);
        round_trip!("responses", "protection", WorkProtection);
        let mut invalid = fixture["requests"]["authorize"].clone();
        invalid["expiresAt"] = json!(9007199254740993u64);
        assert!(serde_json::from_value::<WorkPlanAuthorizeRequest>(invalid).is_err());
        let mut invalid = fixture["requests"]["control"].clone();
        invalid["expectedGeneration"] = json!("9223372036854775808");
        assert!(serde_json::from_value::<WorkPlanControlRequest>(invalid).is_err());
    }

    #[test]
    fn shared_work_plan_agent_tool_fixture_round_trips_through_serde() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/workPlanAgentTools.contract.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($value:expr, $ty:ty) => {{
                let value = $value.clone();
                let decoded: $ty = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), value);
            }};
        }
        round_trip!(
            fixture["requests"]["prepare"],
            broker::WorkPlanAgentToolPrepareRequest
        );
        round_trip!(
            fixture["requests"]["start"],
            broker::WorkPlanAgentToolStartRequest
        );
        round_trip!(
            fixture["responses"]["prepared"],
            broker::WorkPlanAgentToolView
        );
        round_trip!(
            fixture["requests"]["attempt"],
            broker::WorkPlanAgentToolAttemptRequest
        );
        round_trip!(
            fixture["requests"]["output"],
            broker::WorkPlanAgentToolOutputRequest
        );
        round_trip!(fixture["responses"]["attempt"], AttemptDetail);
        for field in ["callerId", "grantId", "confirmed", "payload", "lease"] {
            let mut extra = fixture["requests"]["attempt"].clone();
            extra[field] = json!(true);
            assert!(
                serde_json::from_value::<broker::WorkPlanAgentToolAttemptRequest>(extra).is_err()
            );
            let mut extra = fixture["requests"]["output"].clone();
            extra[field] = json!(true);
            assert!(
                serde_json::from_value::<broker::WorkPlanAgentToolOutputRequest>(extra).is_err()
            );
        }
        round_trip!(
            fixture["toolView"],
            crate::commands::plugins::PluginToolView
        );
        round_trip!(fixture["spec"], tsumugi_core::application::WorkPlanToolSpec);
    }

    type MockWebview = tauri::WebviewWindow<tauri::test::MockRuntime>;

    struct SaturatedIo {
        releases: Vec<mpsc::SyncSender<()>>,
        workers: Vec<std::thread::JoinHandle<()>>,
    }

    impl SaturatedIo {
        fn hold(io: &BlockingExecutor) -> Self {
            let mut held = Self {
                releases: Vec::new(),
                workers: Vec::new(),
            };
            for _ in 0..4 {
                let (entered, started) = mpsc::sync_channel(1);
                let (release, wait) = mpsc::sync_channel(1);
                held.releases.push(release);
                let io = io.clone();
                held.workers.push(std::thread::spawn(move || {
                    tauri::async_runtime::block_on(io.run(CommandStage::ExecutionRead, move || {
                        entered.send(()).unwrap();
                        wait.recv_timeout(Duration::from_secs(60)).unwrap();
                        Ok(())
                    }))
                    .unwrap();
                }));
                started.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            held.assert_full(io);
            held
        }

        fn assert_full(&self, io: &BlockingExecutor) {
            assert_eq!(
                tauri::async_runtime::block_on(io.run(CommandStage::ExecutionRead, || Ok(())))
                    .unwrap_err()
                    .code,
                CommandErrorCode::Busy
            );
        }

        fn call_once(
            &mut self,
            fixture: &Fixture,
            command: &'static str,
            extra: Value,
        ) -> Result<Value, Value> {
            let webview = fixture.webview.clone();
            let request = request(&fixture.context, extra);
            let (reply, response) = mpsc::sync_channel(1);
            // Keep the original wire boundary, without the fixture's Busy retry.
            // The guard releases all IO gates before joining this caller on failure.
            self.workers.push(std::thread::spawn(move || {
                let result = tauri::test::get_ipc_response(
                    &webview,
                    InvokeRequest {
                        cmd: command.into(),
                        callback: CallbackFn(0),
                        error: CallbackFn(1),
                        url: crate::ipc_test_url().parse().unwrap(),
                        body: InvokeBody::Json(json!({"request":request})),
                        headers: Default::default(),
                        invoke_key: tauri::test::INVOKE_KEY.into(),
                    },
                )
                .map(|response| response.deserialize::<Value>().unwrap());
                let _ = reply.send(result);
            }));
            response
                .recv_timeout(Duration::from_secs(10))
                .expect("single IPC response did not arrive while IO gates were held")
        }
    }

    impl Drop for SaturatedIo {
        fn drop(&mut self) {
            for release in self.releases.drain(..) {
                let _ = release.send(());
            }
            let mut failed = false;
            for worker in self.workers.drain(..) {
                failed |= worker.join().is_err();
            }
            if !std::thread::panicking() {
                assert!(!failed, "an owned IO or IPC fixture worker panicked");
            }
        }
    }

    struct Fixture {
        directory: tempfile::TempDir,
        project_path: std::path::PathBuf,
        app: tauri::App<tauri::test::MockRuntime>,
        webview: MockWebview,
        context: Value,
        unit: ExecutionId,
        source_revision: ExecutionId,
        snapshot: ExecutionId,
    }

    fn call(webview: &MockWebview, command: &str, mut request: Value) -> Result<Value, Value> {
        // Ordinary synthetic plans explicitly carry the current nullable field.
        if command == "prepare_work_plan" && request.get("maintenance").is_none() {
            request["maintenance"] = Value::Null;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let response = tauri::test::get_ipc_response(
                webview,
                InvokeRequest {
                    cmd: command.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: crate::ipc_test_url().parse().unwrap(),
                    body: InvokeBody::Json(json!({"request":request.clone()})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .map(|response| response.deserialize::<Value>().unwrap());
            match response {
                Err(error) if error["code"] == "busy" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                response => return response,
            }
        }
    }

    fn request(context: &Value, extra: Value) -> Value {
        let mut request = context.clone();
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        request
    }

    struct ProjectFixture {
        directory: tempfile::TempDir,
        app: tauri::App<tauri::test::MockRuntime>,
        webview: MockWebview,
        context: Value,
    }
    impl ProjectFixture {
        fn create(source_locale: &str) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let app = crate::commands::register_commands(tauri::test::mock_builder())
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let webview = tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .build()
            .unwrap();
            let view = call(
                &webview,
                "create_project",
                json!({
                    "destination":directory.path().join("project"), "displayName":"Work plan test",
                    "sourceLocale":source_locale, "targetLocales":["zh-CN"]
                }),
            )
            .unwrap();
            let context = json!({
                "sessionToken":view["sessionToken"], "projectId":view["metadata"]["projectId"]
            });
            Self {
                directory,
                app,
                webview,
                context,
            }
        }
    }

    impl Fixture {
        fn create() -> Self {
            Self::create_with_source(br#"{"first":"Hello"}"#)
        }

        fn create_with_source(source_bytes: &[u8]) -> Self {
            let source_bytes = source_bytes.to_vec();
            let ProjectFixture {
                directory,
                app,
                webview,
                context,
            } = ProjectFixture::create("en-US");
            let (unit, source_revision, snapshot) = Self::capture_source(&app, source_bytes);
            let project_path = directory.path().join("project");
            Self {
                directory,
                project_path,
                app,
                webview,
                context,
                unit,
                source_revision,
                snapshot,
            }
        }

        fn capture_source(
            app: &tauri::App<tauri::test::MockRuntime>,
            source_bytes: Vec<u8>,
        ) -> (ExecutionId, ExecutionId, ExecutionId) {
            app.state::<AppState>().sessions.with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                let source = tsumugi_core::content::SourceBundle::capture(
                    br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
                    &source_bytes,
                    "en-US",
                ).unwrap();
                let input = source.fixed_input(store.metadata().unwrap().project_id()).unwrap();
                host.runtime.submit(store, &input).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while host.active(store).unwrap() {
                    host.tick(store).unwrap();
                    assert!(Instant::now() < deadline);
                    std::thread::yield_now();
                }
                let result = store.execution_current_result(
                    input.envelope().attempt_id, input.envelope().items[0].item_id,
                ).unwrap().unwrap();
                let preview = store.source_preview(input.envelope().attempt_id, result, 0, 1).unwrap();
                let action = store.prepare_adoption_with_id(
                    ExecutionId::new(), input.envelope().attempt_id, input.envelope().units[0].unit_id,
                    vec![result], serde_json::to_value(preview.confirmation).unwrap(),
                ).unwrap();
                store.adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler).unwrap();
                let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
                let row = store.source_content(snapshot, 0, 1).unwrap().rows.remove(0);
                (row.unit_id.unwrap(), row.source_revision_id.unwrap(), snapshot)
            })
        }

        fn call(&self, command: &str, extra: Value) -> Result<Value, Value> {
            call(&self.webview, command, request(&self.context, extra))
        }

        fn bytes(&self) -> Vec<u8> {
            std::fs::read(self.project_path.join("project.sqlite3")).unwrap()
        }

        fn attempt_count(&self) -> i64 {
            let connection = rusqlite::Connection::open_with_flags(
                self.project_path.join("project.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            connection
                .query_row("SELECT COUNT(*) FROM execution_attempts", [], |row| {
                    row.get(0)
                })
                .unwrap()
        }

        fn assert_fixed_input(&self, receipt: &Value) {
            let action: ExecutionId = serde_json::from_value(receipt["actionId"].clone()).unwrap();
            self.app.state::<AppState>().sessions.with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                let durable = store.work_plan_receipt(action).unwrap().unwrap();
                let fixed = FixedInput::capture(durable.input.unwrap()).unwrap();
                assert_eq!(
                    store
                        .execution_input(fixed.envelope().attempt_id)
                        .unwrap()
                        .bytes(),
                    fixed.bytes()
                );
            });
        }

        fn reopen(&mut self) {
            call(
                &self.webview,
                "close_project",
                json!({
                    "sessionToken":self.context["sessionToken"]
                }),
            )
            .unwrap();
            let view = call(
                &self.webview,
                "open_project",
                json!({
                    "locator":self.directory.path().join("project")
                }),
            )
            .unwrap();
            self.context = json!({
                "sessionToken":view["sessionToken"], "projectId":view["metadata"]["projectId"]
            });
        }
    }

    /// A bounded, credential-free HTTP producer exercises the production runner.
    fn local_provider(text: &'static str) -> (AiConfig, JoinHandle<Value>) {
        local_provider_gate(text, None)
    }
    fn local_provider_gate(
        text: &'static str,
        gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    ) -> (AiConfig, JoinHandle<Value>) {
        local_provider_sequence(vec![text], gate)
    }
    fn local_provider_sequence(
        texts: Vec<&'static str>,
        gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    ) -> (AiConfig, JoinHandle<Value>) {
        local_provider_sequence_after_setup(texts, gate, None)
    }
    /// Acquisition can precede dispatch without consuming the HTTP accept
    /// deadline. The original model timeout and request/usage budgets remain fixed.
    fn local_provider_after_setup(
        text: &'static str,
    ) -> (AiConfig, mpsc::Sender<()>, JoinHandle<Value>) {
        let (ready, setup) = mpsc::channel();
        let (config, thread) = local_provider_sequence_after_setup(vec![text], None, Some(setup));
        (config, ready, thread)
    }
    fn local_provider_sequence_after_setup(
        texts: Vec<&'static str>,
        gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
        setup: Option<mpsc::Receiver<()>>,
    ) -> (AiConfig, JoinHandle<Value>) {
        local_provider_sequence_with_accept_timeout(texts, gate, setup, Duration::from_secs(5))
    }
    // Installed artifact hashing can precede an actual child HTTP dispatch.
    // This fixture wait does not alter the model's request timeout or budget.
    fn local_provider_sequence_with_accept_timeout(
        texts: Vec<&'static str>,
        gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
        setup: Option<mpsc::Receiver<()>>,
        accept_timeout: Duration,
    ) -> (AiConfig, JoinHandle<Value>) {
        local_provider_sequence_at_request(
            texts,
            gate.map(|channels| (0, channels)),
            setup,
            accept_timeout,
            Duration::from_secs(3),
        )
    }

    /// Hold an exact synthetic HTTP request, including a component's child,
    /// without blocking its original plan's setup request.
    fn local_provider_sequence_at_request(
        texts: Vec<&'static str>,
        gate: Option<(usize, (mpsc::Sender<()>, mpsc::Receiver<()>))>,
        setup: Option<mpsc::Receiver<()>>,
        accept_timeout: Duration,
        gate_timeout: Duration,
    ) -> (AiConfig, JoinHandle<Value>) {
        local_provider_responses_at_request(
            texts.len(),
            move |ordinal, _| Some(texts[ordinal]),
            gate,
            setup,
            accept_timeout,
            gate_timeout,
        )
    }

    /// Read the full production POST before an explicit synthetic disconnect.
    /// Unknown is produced by the actual HTTP runner, not an injected ledger state.
    fn local_provider_responses_at_request(
        request_count: usize,
        mut response_text: impl FnMut(usize, &Value) -> Option<&'static str> + Send + 'static,
        gate: Option<(usize, (mpsc::Sender<()>, mpsc::Receiver<()>))>,
        setup: Option<mpsc::Receiver<()>>,
        accept_timeout: Duration,
        gate_timeout: Duration,
    ) -> (AiConfig, JoinHandle<Value>) {
        local_provider_outputs_at_request(request_count, move |ordinal, item| {
            response_text(ordinal, item).map(|text| json!({"unitId":item["unitId"], "targetLocale":item["targetLocale"], "text":text}))
        }, gate, setup, accept_timeout, gate_timeout)
    }

    fn local_provider_outputs_at_request(
        request_count: usize,
        mut response_output: impl FnMut(usize, &Value) -> Option<Value> + Send + 'static,
        mut gate: Option<(usize, (mpsc::Sender<()>, mpsc::Receiver<()>))>,
        setup: Option<mpsc::Receiver<()>>,
        accept_timeout: Duration,
        gate_timeout: Duration,
    ) -> (AiConfig, JoinHandle<Value>) {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let config = AiConfig {
            endpoint: format!(
                "http://{}/v1/chat/completions",
                listener.local_addr().unwrap()
            ),
            model: "synthetic-work-effects".into(),
            credential_env: String::new(),
            max_requests: request_count.try_into().unwrap(),
            timeout_seconds: 2,
            ..AiConfig::default()
        };
        let thread = std::thread::spawn(move || {
            if let Some(setup) = setup {
                setup
                    .recv_timeout(Duration::from_secs(60))
                    .expect("provider setup did not reach the dispatch gate");
            }
            let mut last = Value::Null;
            for ordinal in 0..request_count {
                let deadline = Instant::now() + accept_timeout;
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "provider was never dispatched");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let end = loop {
                    let size = stream.read(&mut buffer).unwrap();
                    assert!(size > 0);
                    bytes.extend_from_slice(&buffer[..size]);
                    if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let headers = std::str::from_utf8(&bytes[..end]).unwrap();
                assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
                assert!(!headers.to_lowercase().contains("authorization:"));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse().unwrap())
                    })
                    .unwrap();
                while bytes.len() < end + length {
                    let size = stream.read(&mut buffer).unwrap();
                    assert!(size > 0);
                    bytes.extend_from_slice(&buffer[..size]);
                }
                let request: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
                let item: Value =
                    serde_json::from_str(request["messages"][1]["content"].as_str().unwrap())
                        .unwrap();
                if gate.as_ref().is_some_and(|(index, _)| *index == ordinal) {
                    let (_, (started, release)) = gate.take().unwrap();
                    started.send(()).unwrap();
                    release.recv_timeout(gate_timeout).unwrap();
                }
                let Some(output) = response_output(ordinal, &item) else {
                    last = item;
                    continue;
                };
                let (content_type, response) = match request["stream"].as_bool() {
                    Some(true) => {
                        let chunks = [
                            json!({"id":"synthetic-work-plan","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":output.to_string()},"finish_reason":null}]}),
                            json!({"id":"synthetic-work-plan","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
                            json!({"id":"synthetic-work-plan","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}),
                        ];
                        let response = chunks.into_iter()
                            .map(|chunk| format!("data: {chunk}\n\n"))
                            .collect::<String>() + "data: [DONE]\n\n";
                        ("text/event-stream", response)
                    }
                    Some(false) => (
                        "application/json",
                        json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":output.to_string()}}], "usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string(),
                    ),
                    None => panic!("synthetic provider requires the actual stream profile"),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(),
                    content_type,
                    response
                );
                last = item;
            }
            last
        });
        (config, thread)
    }

    impl Fixture {
        fn start_checked(
            &self,
            config: AiConfig,
            policy: tsumugi_core::application::SelectionPolicy,
        ) -> Value {
            let mut options = PlanOptions {
                selection_policy: policy,
                ..PlanOptions::default()
            };
            options
                .stages
                .iter_mut()
                .find(|stage| stage.stage == WorkStage::Checks)
                .unwrap()
                .mode = StageMode::Assisted;
            let plan = self.call("prepare_work_plan", json!({"config":config,"locale":"zh-CN","unitIds":[self.unit],"options":options,"advisoryChecks":[],"toolSelection":null})).unwrap();
            let effects = match policy {
                tsumugi_core::application::SelectionPolicy::MissingOnly => {
                    json!(["save-candidate", "run-checks", "select-missing"])
                }
                tsumugi_core::application::SelectionPolicy::ReplaceCapturedSelection => {
                    json!(["save-candidate", "run-checks", "replace-captured-selection"])
                }
                _ => unreachable!(),
            };
            let grant = self.call("authorize_work_plan", json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"applicationToolExecutions":[],"effects":effects,"expiresAt":expiry()})).unwrap();
            assert_eq!(self.call("start_work_plan", json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap(), plan["attemptId"]);
            plan
        }
        fn wait_effect(&self, plan: &Value) -> Value {
            self.wait_effect_for(plan, Duration::from_secs(5))
        }
        fn wait_effect_for(&self, plan: &Value, timeout: Duration) -> Value {
            let deadline = Instant::now() + timeout;
            loop {
                let view = self
                    .call(
                        "read_ai_translation",
                        json!({"attemptId":plan["attemptId"]}),
                    )
                    .unwrap();
                match view["rows"][0]["automation"]["phase"].as_str() {
                    Some("selected" | "blocked" | "failed" | "cancelled") => return view,
                    _ => {
                        assert!(Instant::now() < deadline, "{view}");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        }
    }

    impl Fixture {
        fn start_candidates(&self, config: AiConfig) -> (Value, Value) {
            self.start_candidates_in_units(config, &[self.unit])
        }

        fn start_candidates_in_units(
            &self,
            config: AiConfig,
            units: &[ExecutionId],
        ) -> (Value, Value) {
            self.start_candidates_with_tools(config, units, None)
        }

        fn start_candidates_with_tools(
            &self,
            config: AiConfig,
            units: &[ExecutionId],
            tool_selection: Option<Value>,
        ) -> (Value, Value) {
            let tool_execution = tool_selection.is_some();
            let effects = if tool_execution { json!(["save-candidate", "query-tools"]) } else { json!(["save-candidate"]) };
            let plan = self.call("prepare_work_plan", json!({
                "config":config,"locale":"zh-CN","unitIds":units,"options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":tool_selection
            })).unwrap();
            let grant = self.call("authorize_work_plan", json!({
                "planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),
                "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":tool_execution,"applicationToolExecutions":[],"effects":effects,"expiresAt":expiry()
            })).unwrap();
            assert!(
                self.call(
                    "open_work_plan_agent_scope",
                    json!({"lease":grant["lease"]})
                )
                .is_err()
            );
            assert_eq!(self.call("start_work_plan", json!({
                "planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]
            })).unwrap(), plan["attemptId"]);
            (plan, grant)
        }

        fn wait_saved(&self, attempt: &Value) -> Value {
            self.wait_saved_for(attempt, Duration::from_secs(5))
        }
        fn wait_saved_for(&self, attempt: &Value, timeout: Duration) -> Value {
            let deadline = Instant::now() + timeout;
            loop {
                let view = self
                    .call("read_ai_translation", json!({"attemptId":attempt}))
                    .unwrap();
                if view["rows"][0]["savedRevisionId"].is_string()
                    && view["rows"][0]["automation"]["phase"] == "saved"
                {
                    return view;
                }
                assert!(Instant::now() < deadline, "{view}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    // Actual Pi execution uses the currently packaged macOS arm64 Node profile.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn agent_generation_uses_original_runtime_candidates_and_cumulative_budget() {
        // The installed runtime outlives the application fixture's teardown.
        let _member_runtime;
        let fixture = Fixture::create();
        _member_runtime = crate::commands::execution::test_fixtures::provision_member_runtime(
            &fixture.app.state::<AppState>().plugins,
            &fixture.directory.path().join("member-resources"),
        );
        let (mut config, provider) = local_provider_sequence_with_accept_timeout(
            vec!["根候选", "子候选"], None, None, Duration::from_secs(30),
        );
        config.timeout_seconds = 30;
        let (plan, grant) = fixture.start_candidates(config);
        let first = fixture.wait_saved(&plan["attemptId"]);
        assert_eq!(first["rows"][0]["output"]["text"], "根候选");
        let open = json!({"lease":grant["lease"]});
        let before = fixture.bytes();
        let agent = fixture
            .call("open_work_plan_agent_scope", open.clone())
            .unwrap();
        assert_eq!(
            fixture
                .call("open_work_plan_agent_scope", open.clone())
                .unwrap(),
            agent
        );
        assert_eq!(agent["scope"], plan["scope"]);
        assert_eq!(agent["budget"]["dispatched"], 1);
        let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]});
        let request = json!({"scopeId":agent["scopeId"],"generation":generation});
        let count = fixture.attempt_count();
        let prepared = fixture
            .call("prepare_work_plan_agent_generation", request.clone())
            .unwrap();
        assert_eq!(
            fixture
                .call("prepare_work_plan_agent_generation", request.clone())
                .unwrap(),
            prepared
        );
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(prepared["parentTask"], agent["parentTask"]);
        assert_eq!(prepared["scope"], plan["scope"]);
        let mut forged = request.clone();
        forged["scopeId"] = json!(ExecutionId::new());
        assert!(
            fixture
                .call("prepare_work_plan_agent_generation", forged)
                .is_err()
        );
        for ids in [
            json!([]),
            json!([fixture.unit, fixture.unit]),
            json!([ExecutionId::new()]),
        ] {
            let mut forged = request.clone();
            forged["generation"]["unitIds"] = ids;
            assert!(
                fixture
                    .call("prepare_work_plan_agent_generation", forged)
                    .is_err()
            );
        }
        for field in [
            "confirmed",
            "effects",
            "config",
            "payload",
            "lease",
            "parentTask",
        ] {
            let mut forged = request.clone();
            forged["generation"][field] = json!(true);
            assert!(
                fixture
                    .call("prepare_work_plan_agent_generation", forged)
                    .is_err()
            );
        }
        let mut start = request.clone();
        start["inputDigest"] = prepared["inputDigest"].clone();
        let mut forged = start.clone();
        forged["inputDigest"] = json!("b".repeat(64));
        assert!(
            fixture
                .call("start_work_plan_agent_generation", forged)
                .is_err()
        );
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(
            fixture
                .call("start_work_plan_agent_generation", start.clone())
                .unwrap(),
            generation["attemptId"]
        );
        let second = fixture.wait_saved_for(&generation["attemptId"], Duration::from_secs(30));
        assert_eq!(second["rows"][0]["output"]["text"], "子候选");
        assert_ne!(
            second["rows"][0]["savedRevisionId"],
            first["rows"][0]["savedRevisionId"]
        );
        assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
        let saved = fixture.bytes();
        assert_eq!(
            fixture
                .call("start_work_plan_agent_generation", start)
                .unwrap(),
            generation["attemptId"]
        );
        assert_eq!(fixture.attempt_count(), count + 1);
        assert_eq!(fixture.bytes(), saved);
        let budget = fixture.call("open_work_plan_agent_scope", open).unwrap()["budget"].clone();
        assert_eq!(budget["limit"], 2);
        assert_eq!(budget["dispatched"], 2);
        assert_eq!(budget["unresolved"], 0);
        assert_eq!(budget["promptTokens"], "2");
        assert_eq!(budget["completionTokens"], "2");
        let exhausted_request = json!({"scopeId":agent["scopeId"],"generation":{
            "taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]
        }});
        let exhausted_prepared = fixture
            .call(
                "prepare_work_plan_agent_generation",
                exhausted_request.clone(),
            )
            .unwrap();
        let mut exhausted_start = exhausted_request.clone();
        exhausted_start["inputDigest"] = exhausted_prepared["inputDigest"].clone();
        fixture
            .call("start_work_plan_agent_generation", exhausted_start)
            .unwrap();
        let exhausted = fixture.wait_effect_for(
            &json!({"attemptId":exhausted_request["generation"]["attemptId"]}),
            Duration::from_secs(30),
        );
        assert_eq!(
            exhausted["detail"]["items"][0]["status"]["diagnostic"],
            "ai-budget"
        );
        assert!(exhausted["rows"][0]["output"].is_null());
        assert!(exhausted["rows"][0]["savedRevisionId"].is_null());
        assert_eq!(
            fixture
                .call(
                    "open_work_plan_agent_scope",
                    json!({"lease":grant["lease"]})
                )
                .unwrap()["budget"],
            budget
        );
        let parent: ExecutionId = serde_json::from_value(agent["parentTask"].clone()).unwrap();
        let attempt: ExecutionId = serde_json::from_value(generation["attemptId"].clone()).unwrap();
        let expected_binding = tsumugi_core::application::WorkPlanAgentExecutionBinding {
            lease: serde_json::from_value(agent["lease"].clone()).unwrap(),
            root_task: parent,
            caller_id: serde_json::from_value(agent["scopeId"].clone()).unwrap(),
            delegation: None,
        };
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                let root = FixedInput::capture(
                    store
                        .work_plan_receipt(
                            serde_json::from_value(grant["actionId"].clone()).unwrap(),
                        )
                        .unwrap()
                        .unwrap()
                        .input
                        .unwrap(),
                )
                .unwrap();
                let child = store.execution_input(attempt).unwrap();
                assert_eq!(child.envelope().items, root.envelope().items);
                assert!(root.envelope().settings["agent"].is_null());
                let mut expected_settings = root.envelope().settings.clone();
                expected_settings["agent"] = serde_json::to_value(expected_binding).unwrap();
                assert_eq!(child.envelope().settings, expected_settings);
                assert_eq!(child.envelope().limits, root.envelope().limits);
                assert_eq!(
                    store.provider_budget(parent).unwrap().unwrap().dispatched,
                    2
                );
                let project =
                    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
                        .unwrap();
                let history = store
                    .translation_history(project, fixture.unit, "zh-CN", 0, 100)
                    .unwrap();
                assert_eq!(history.rows.len(), 2);
                assert!(history.current.is_none());
                assert!(
                    store
                        .review_target(project, fixture.unit, "zh-CN")
                        .unwrap()
                        .current_check
                        .is_none()
                );
            });
    }

    #[test]
    fn agent_scope_cannot_resume_control_or_survive_reopen() {
        let mut fixture = Fixture::create();
        let (config, provider) = local_provider("保留候选");
        let (plan, grant) = fixture.start_candidates(config);
        fixture.wait_saved(&plan["attemptId"]);
        provider.join().unwrap();
        let agent = fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]}),
            )
            .unwrap();
        let request = json!({"scopeId":agent["scopeId"],"generation":{
            "taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]
        }});
        let prepared = fixture
            .call("prepare_work_plan_agent_generation", request.clone())
            .unwrap();
        let mut start = request.clone();
        start["inputDigest"] = prepared["inputDigest"].clone();
        let count = fixture.attempt_count();
        let paused = fixture.call("control_work_plan", json!({
            "planId":plan["planId"],"actionId":ExecutionId::new(),
            "expectedGeneration":grant["lease"]["generation"],"command":"pause","confirmed":false,"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]
        })).unwrap();
        assert!(
            fixture
                .call("prepare_work_plan_agent_generation", request.clone())
                .is_err()
        );
        assert!(
            fixture
                .call("start_work_plan_agent_generation", start.clone())
                .is_err()
        );
        let resumed = fixture
            .call(
                "control_work_plan",
                json!({
                    "planId":plan["planId"],"actionId":ExecutionId::new(),
                    "expectedGeneration":paused["lease"]["generation"],"command":"continue",
                    "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"applicationToolExecutions":[],"expiresAt":expiry()
                }),
            )
            .unwrap();
        assert!(
            fixture
                .call("start_work_plan_agent_generation", start.clone())
                .is_err()
        );
        let fresh = fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":resumed["lease"]}),
            )
            .unwrap();
        assert_ne!(fresh["scopeId"], agent["scopeId"]);
        assert_eq!(fresh["parentTask"], agent["parentTask"]);
        assert_eq!(fresh["budget"], agent["budget"]);
        assert_eq!(fixture.attempt_count(), count);
        let mut fresh_request = request.clone();
        fresh_request["scopeId"] = fresh["scopeId"].clone();
        fixture
            .call("prepare_work_plan_agent_generation", fresh_request.clone())
            .unwrap();
        fixture.reopen();
        let before = fixture.bytes();
        assert!(
            fixture
                .call("prepare_work_plan_agent_generation", fresh_request)
                .is_err()
        );
        assert!(
            fixture
                .call("start_work_plan_agent_generation", start)
                .is_err()
        );
        assert!(
            fixture
                .call(
                    "open_work_plan_agent_scope",
                    json!({"lease":resumed["lease"]})
                )
                .is_err()
        );
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(fixture.bytes(), before);
        let status = fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap();
        assert_eq!(status["state"], "paused");
        assert_eq!(
            fixture
                .call(
                    "read_ai_translation",
                    json!({"attemptId":plan["attemptId"]})
                )
                .unwrap()["budget"],
            agent["budget"]
        );
    }

    #[test]
    // Actual Pi execution uses the currently packaged macOS arm64 Node profile.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn agent_generation_reuses_independent_checks_and_original_selection_service() {
        let _member_runtime;
        let fixture = Fixture::create();
        _member_runtime = crate::commands::execution::test_fixtures::provision_member_runtime(
            &fixture.app.state::<AppState>().plugins,
            &fixture.directory.path().join("member-resources"),
        );
        let (mut config, provider) = local_provider_sequence_with_accept_timeout(
            vec!["第一稿", "第二稿"], None, None, Duration::from_secs(30),
        );
        config.timeout_seconds = 30;
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::ReplaceCapturedSelection,
        );
        let first = fixture.wait_effect(&plan);
        assert_eq!(
            first["rows"][0]["automation"]["phase"], "selected",
            "{first}"
        );
        let status = fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap();
        let agent = fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":status["lease"]}),
            )
            .unwrap();
        let mut request = json!({"scopeId":agent["scopeId"],"generation":{
            "taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]
        }});
        let prepared = fixture
            .call("prepare_work_plan_agent_generation", request.clone())
            .unwrap();
        request["inputDigest"] = prepared["inputDigest"].clone();
        fixture
            .call("start_work_plan_agent_generation", request.clone())
            .unwrap();
        let second = fixture.wait_effect_for(
            &json!({"attemptId":request["generation"]["attemptId"]}),
            Duration::from_secs(30),
        );
        assert_eq!(
            second["rows"][0]["automation"]["phase"], "selected",
            "{second}"
        );
        let receipt = &second["rows"][0]["automation"]["receipt"];
        assert_eq!(receipt["request"]["lease"], agent["lease"]);
        assert_eq!(
            receipt["request"]["revisionId"],
            second["rows"][0]["savedRevisionId"]
        );
        assert!(receipt["checkRunId"].is_string());
        assert_eq!(receipt["rules"].as_array().unwrap().len(), 4);
        assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
        assert_eq!(
            fixture
                .call(
                    "open_work_plan_agent_scope",
                    json!({"lease":status["lease"]})
                )
                .unwrap()["budget"]["dispatched"],
            2
        );
    }
    #[test]
    fn checked_worker_selects_ordinary_candidate_and_reopen_only_reads_receipt() {
        let mut fixture = Fixture::create();
        let (config, provider) = local_provider("你好");
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::MissingOnly,
        );
        let view = fixture.wait_effect(&plan);
        let row = &view["rows"][0];
        let receipt = &row["automation"]["receipt"];
        assert_eq!(row["automation"]["phase"], "selected", "{view}");
        assert_eq!(receipt["request"]["revisionId"], row["savedRevisionId"]);
        assert_eq!(receipt["request"]["lease"]["planId"], plan["planId"]);
        assert_eq!(receipt["policyVersion"], "checked-selection-3");
        assert!(receipt["checkRunId"].is_string());
        assert_eq!(receipt["rules"].as_array().unwrap().len(), 4);
        assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
        let original = row["automation"].clone();
        let expected_revision = row["savedRevisionId"].as_str().unwrap().to_owned();
        let unit = fixture.unit;
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                let history = store
                    .translation_history(
                        ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
                            .unwrap(),
                        unit,
                        "zh-CN",
                        0,
                        100,
                    )
                    .unwrap();
                assert_eq!(history.rows.len(), 1);
                assert_eq!(
                    history.current.as_ref().unwrap().revision_id.to_string(),
                    expected_revision
                );
            });
        fixture.reopen();
        let before = fixture.bytes();
        let reopened = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]}),
            )
            .unwrap();
        assert_eq!(reopened["rows"][0]["automation"], original);
        let status = fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap();
        assert_eq!(status["state"], "paused");
        assert!(
            fixture
                .call(
                    "retry_work_plan_effect",
                    json!({"attemptId":plan["attemptId"],"itemId":row["itemId"]})
                )
                .is_err()
        );
        assert_eq!(fixture.bytes(), before);
    }

    #[test]
    fn registered_work_plan_action_reads_prove_only_persisted_transitions_without_host_grants() {
        let wire:Value=serde_json::from_str(include_str!("../../../../test/fixtures/workPlanCommands.contract.json")).unwrap();
        let isolated=ProjectFixture::create("en-US");
        for (kind,command) in [("authorize","read_work_plan_authorization_action"),("control","read_work_plan_control_action")] {
            let mut body=wire["requests"][kind].clone();body["projectId"]=isolated.context["projectId"].clone();body["sessionToken"]=isolated.context["sessionToken"].clone();
            assert_eq!(call(&isolated.webview,command,body).unwrap(),Value::Null);
        }
        isolated.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
        let mut fixture=Fixture::create();let unit=fixture.unit;
        let config:AiConfig=serde_json::from_value(wire["requests"]["prepare"]["config"].clone()).unwrap();
        let facts=fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();let store=&mut active.store;
            let plan=store.prepare_work_plan(Some(config),"zh-CN",&[unit],PlanOptions::default()).unwrap();
            let expires=expiry().parse::<u64>().unwrap();
            let authorization=AuthorizeWorkPlan {action_id:ExecutionId::new(),plan_digest:plan.digest.clone(),confirmed:true,
                effects:plan.authorization_effects().unwrap(),expires_at:expires};
            let receipt=store.authorize_work_plan(&plan,&authorization).unwrap();
            let body=json!({"planId":plan.plan_id,"actionId":authorization.action_id,"digest":authorization.plan_digest,"confirmed":true,
                "effects":authorization.effects,"expiresAt":authorization.expires_at.to_string(),"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]});
            let recorded=json!({"kind":"authorize","planId":plan.plan_id,"actionId":authorization.action_id,"digest":authorization.plan_digest,
                "confirmed":true,"effects":authorization.effects,"expiresAt":authorization.expires_at.to_string()});
            let mut facts=vec![("read_work_plan_authorization_action",body,json!({"projectId":plan.project_id,"request":recorded,"receipt":WorkPlanReceiptView::from(receipt)}))];
            for (index,command) in [WorkPlanCommand::Pause,WorkPlanCommand::Continue,WorkPlanCommand::TakeOver,WorkPlanCommand::Continue,WorkPlanCommand::Stop].into_iter().enumerate() {
                let request=ControlWorkPlan {action_id:ExecutionId::new(),plan_id:plan.plan_id,expected_generation:Revision::new(index as u64+1).unwrap(),
                    command,confirmed:command==WorkPlanCommand::Continue,expires_at:(command==WorkPlanCommand::Continue).then_some(expires)};
                let receipt=store.control_work_plan(&request).unwrap();
                let body=json!({"planId":request.plan_id,"actionId":request.action_id,"expectedGeneration":request.expected_generation,"command":request.command,
                    "confirmed":request.confirmed,"expiresAt":request.expires_at.map(|value|value.to_string()),"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]});
                let recorded=json!({"kind":"control","planId":request.plan_id,"actionId":request.action_id,"expectedGeneration":request.expected_generation,
                    "command":request.command,"confirmed":request.confirmed,"expiresAt":request.expires_at.map(|value|value.to_string())});
                facts.push(("read_work_plan_control_action",body,json!({"projectId":plan.project_id,"request":recorded,"receipt":WorkPlanReceiptView::from(receipt)})));
            }
            active.execution.as_mut().unwrap().quiescing=true;facts
        });
        let count=fixture.attempt_count();let sequence=fixture.app.state::<AppState>().sessions.with(|sessions|sessions.active.as_ref().unwrap().store.execution_sequence().unwrap());
        for (command,body,expected) in &facts {
            assert_eq!(fixture.call(command,body.clone()).unwrap(),*expected);
            let mut temporary=body.clone();temporary["toolExecution"]=json!(true);
            assert_eq!(fixture.call(command,temporary).unwrap(),*expected,"proof does not attest to Host-local consent");
            for field in ["projectId","sessionToken"] {
                let mut wrong=body.clone();wrong[field]=if field=="sessionToken" {json!("old")} else {json!(ExecutionId::new())};assert!(fixture.call(command,wrong).is_err());
            }
            let mut wrong=body.clone();wrong["confirmed"]=json!(!body["confirmed"].as_bool().unwrap());assert_eq!(fixture.call(command,wrong).unwrap_err()["code"],"result-mismatch");
            let mut extra=body.clone();extra["restoreConsent"]=json!(true);assert!(fixture.call(command,extra).is_err());
            let request=&expected["request"];assert!(request.get("checkerExecutions").is_none()&&request.get("toolExecution").is_none()&&request.get("applicationToolExecutions").is_none());
        }
        assert_eq!(fixture.attempt_count(),count);
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();assert_eq!(active.store.execution_sequence().unwrap(),sequence);
            let host=active.execution.as_mut().unwrap();assert!(host.work_plans.checker_consents.is_empty()&&host.work_plans.tool_consents.is_empty()&&host.work_plans.agent_scopes.is_empty());host.quiescing=false;
        });
        Fixture::capture_source(&fixture.app,br#"{"replacement":"Changed source"}"#.to_vec());
        fixture.app.state::<AppState>().sessions.with(|sessions| {
            let store=&mut sessions.active.as_mut().unwrap().store;let revision=store.metadata().unwrap().metadata_revision();store.set_target_locales(revision,&["ja".into()]).unwrap();
        });
        let old_context=fixture.context.clone();fixture.reopen();
        for (command,body,expected) in &facts {
            assert!(call(&fixture.webview,command,request(&old_context,body.clone())).is_err());assert_eq!(fixture.call(command,body.clone()).unwrap(),*expected);
        }
        fixture.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    }

    #[test]
    fn registered_review_check_action_reads_are_scoped_pure_and_survive_reopen() {
        let isolated=ProjectFixture::create("en-US");
        let absent=json!({"actionId":ExecutionId::new(),"unitId":ExecutionId::new(),"locale":"zh-CN","expectedBasis":"none","advisoryChecks":[]});
        assert_eq!(call(&isolated.webview,"read_review_check_action",request(&isolated.context,absent)).unwrap(),Value::Null);
        isolated.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
        let mut fixture=Fixture::create_with_source(br#"{"first":"Hello"}"#);let unit=fixture.unit;
        let run=fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let store=&mut sessions.active.as_mut().unwrap().store;let project=ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
            let target=store.review_target(project,unit,"zh-CN").unwrap();
            store.run_review_checks(project,unit,"zh-CN",&target.basis,ExecutionId::new()).unwrap()
        });
        let business=json!({"projectId":fixture.context["projectId"],"actionId":run.action_id,"unitId":unit,"locale":"zh-CN","expectedBasis":run.basis,"advisoryChecks":[]});
        let mut expected=json!({"request":business,"receipt":run});
        assert_eq!(fixture.call("read_review_check_action",business.clone()).unwrap(),expected);
        for field in ["projectId","sessionToken","expectedBasis"] {
            let mut wrong=business.clone();wrong[field]=if field=="projectId" {json!(ExecutionId::new())} else {json!("wrong")};
            assert!(fixture.call("read_review_check_action",wrong).is_err());
        }
        let mut extra=business.clone();extra["executions"]=json!([]);assert!(fixture.call("read_review_check_action",extra).is_err());
        Fixture::capture_source(&fixture.app,br#"{"replacement":"Changed source"}"#.to_vec());
        let sequence=fixture.app.state::<AppState>().sessions.with(|sessions| {
            let active=sessions.active.as_mut().unwrap();let revision=active.store.metadata().unwrap().metadata_revision();active.store.set_target_locales(revision,&["ja".into()]).unwrap();
            active.execution.as_mut().unwrap().quiescing=true;active.store.execution_sequence().unwrap()
        });
        assert_eq!(fixture.call("read_review_check_action",business.clone()).unwrap(),expected);
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();assert_eq!(active.store.execution_sequence().unwrap(),sequence);active.execution.as_mut().unwrap().quiescing=false;
        });
        let old_context=fixture.context.clone();fixture.reopen();
        assert!(call(&fixture.webview,"read_review_check_action",request(&old_context,business.clone())).is_err());
        expected["request"]["projectId"]=fixture.context["projectId"].clone();
        assert_eq!(fixture.call("read_review_check_action",business).unwrap(),expected);
        fixture.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    }

    #[test]
    fn registered_review_human_action_reads_preserve_exact_requests_after_history_changes() {
        let wire:Value=serde_json::from_str(include_str!("../../../../test/fixtures/reviewCommands.contract.json")).unwrap();
        let isolated=ProjectFixture::create("en-US");
        for (kind,command) in [("decision","read_review_decision_action"),("waiver","read_review_waiver_action"),("fallback","read_review_fallback_action")] {
            let mut body=wire["requests"][kind].clone();body["projectId"]=isolated.context["projectId"].clone();body["sessionToken"]=isolated.context["sessionToken"].clone();
            body[kind]["projectId"]=isolated.context["projectId"].clone();
            assert_eq!(call(&isolated.webview,command,body).unwrap(),Value::Null);
        }
        assert_eq!(call(&isolated.webview,"read_review_finding_action",request(&isolated.context,json!({"actionId":ExecutionId::new()}))).unwrap(),Value::Null);
        isolated.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
        let mut fixture=Fixture::create_with_source(br#"{"first":"Hello {{name}}"}"#);let unit=fixture.unit;
        let target=fixture.call("read_review_target",json!({"unitId":unit,"locale":"zh-CN"})).unwrap();
        let fallback=json!({"projectId":fixture.context["projectId"],"actionId":ExecutionId::new(),"unitId":unit,"locale":"zh-CN",
            "expectedBasis":target["basis"],"allow":true,"expectedFallbackId":null,"actor":"Original reviewer","reason":"Use original source"});
        assert_eq!(fixture.call("read_review_fallback_action",json!({"fallback":fallback})).unwrap(),Value::Null);
        let fallback_receipt=fixture.call("allow_source_fallback",json!({"fallback":fallback})).unwrap();
        let mut withdrawn=fallback.clone();withdrawn["actionId"]=json!(ExecutionId::new());withdrawn["allow"]=json!(false);withdrawn["expectedFallbackId"]=fallback_receipt["fallbackId"].clone();
        fixture.call("allow_source_fallback",json!({"fallback":withdrawn})).unwrap();
        let (decision,waiver)=fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let store=&mut sessions.active.as_mut().unwrap().store;let project=ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
            let target=store.review_target(project,unit,"zh-CN").unwrap();
            store.save_translation_revision(&tsumugi_core::SaveTranslationRevision {project_id:project,action_id:ExecutionId::new(),unit_id:unit,
                locale:"zh-CN".into(),source_revision_id:target.source_revision_id,expected_selection_id:None,text:"你好 {{name}}".into()}).unwrap();
            store.save_term(&tsumugi_core::SaveTerm {project_id:project,action_id:ExecutionId::new(),term_id:None,locale:"zh-CN".into(),
                source:"Hello".into(),aliases:vec![],target:"欢迎".into(),protected:true,scope_unit_id:Some(unit),expected_revision_id:None,reason:"Preferred term".into()}).unwrap();
            let target=store.review_target(project,unit,"zh-CN").unwrap();
            let run=store.run_review_checks(project,unit,"zh-CN",&target.basis,ExecutionId::new()).unwrap();
            let issue=run.rules.iter().flat_map(|rule|&rule.findings).find(|finding|finding.code=="protected-form").unwrap().issue_id.clone();
            (json!({"projectId":project,"actionId":ExecutionId::new(),"unitId":unit,"locale":"zh-CN","expectedBasis":target.basis,
                "expectedDecisionId":null,"kind":"approve","actor":"Original reviewer","reason":"Original approval"}),
             json!({"projectId":project,"actionId":ExecutionId::new(),"unitId":unit,"locale":"zh-CN","expectedBasis":target.basis,
                "expectedWaiverId":null,"issueId":issue,"grant":true,"actor":"Original reviewer","reason":"Accept original issue"}))
        });
        let decision_receipt=fixture.call("write_review_decision",json!({"decision":decision})).unwrap();
        let waiver_receipt=fixture.call("waive_review_issue",json!({"waiver":waiver})).unwrap();
        let mut later=decision.clone();later["actionId"]=json!(ExecutionId::new());later["expectedDecisionId"]=decision_receipt["decisionId"].clone();later["kind"]=json!("request-changes");
        fixture.call("write_review_decision",json!({"decision":later})).unwrap();
        let mut revoked=waiver.clone();revoked["actionId"]=json!(ExecutionId::new());revoked["expectedWaiverId"]=waiver_receipt["waiverId"].clone();revoked["grant"]=json!(false);
        fixture.call("waive_review_issue",json!({"waiver":revoked})).unwrap();
        let facts=[("decision","read_review_decision_action",decision,decision_receipt),("waiver","read_review_waiver_action",waiver,waiver_receipt),
            ("fallback","read_review_fallback_action",fallback,fallback_receipt)];
        for (kind,command,business,receipt) in &facts {
            let mut body=json!({});body[*kind]=business.clone();
            assert_eq!(fixture.call(command,body.clone()).unwrap(),json!({"request":business,"receipt":receipt}));
            for field in ["projectId","sessionToken"] {
                let mut wrong=body.clone();wrong[field]=if field=="sessionToken" {json!("old-session")} else {json!(ExecutionId::new())};assert!(fixture.call(command,wrong).is_err());
            }
            let mut wrong=body.clone();wrong[*kind]["projectId"]=json!(ExecutionId::new());assert!(fixture.call(command,wrong).is_err());
            let mut wrong=body.clone();wrong[*kind]["reason"]=json!("Wrong original request");assert_eq!(fixture.call(command,wrong).unwrap_err()["code"],"result-mismatch");
            let mut extra=body;extra["grant"]=json!("invented");assert!(fixture.call(command,extra).is_err());
        }
        Fixture::capture_source(&fixture.app,br#"{"replacement":"Changed source"}"#.to_vec());
        let sequence=fixture.app.state::<AppState>().sessions.with(|sessions| {
            let active=sessions.active.as_mut().unwrap();let revision=active.store.metadata().unwrap().metadata_revision();active.store.set_target_locales(revision,&["ja".into()]).unwrap();
            active.execution.as_mut().unwrap().quiescing=true;active.store.execution_sequence().unwrap()
        });
        for (kind,command,business,receipt) in &facts {
            let mut body=json!({});body[*kind]=business.clone();assert_eq!(fixture.call(command,body).unwrap(),json!({"request":business,"receipt":receipt}));
        }
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();assert_eq!(active.store.execution_sequence().unwrap(),sequence);active.execution.as_mut().unwrap().quiescing=false;
        });
        let old_context=fixture.context.clone();fixture.reopen();
        for (kind,command,business,receipt) in &facts {
            let mut body=json!({});body[*kind]=business.clone();assert!(call(&fixture.webview,command,request(&old_context,body.clone())).is_err());
            assert_eq!(fixture.call(command,body).unwrap(),json!({"request":business,"receipt":receipt}));
        }
    }

    #[test]
    fn registered_arena_reveal_target_reads_distinguish_visibility_from_action_receipts() {
        let isolated=ProjectFixture::create("en-US");
        assert_eq!(call(&isolated.webview,"read_arena_reveal_target",request(&isolated.context,json!({"comparisonId":ExecutionId::new()}))).unwrap(),Value::Null);
        isolated.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
        let mut fixture=Fixture::create();let unit=fixture.unit;let source=fixture.source_revision;
        let (comparison,attempt,task)=fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let store=&mut sessions.active.as_mut().unwrap().store;
            let project=ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
            let original=tsumugi_core::SaveTranslationRevision {project_id:project,action_id:ExecutionId::new(),unit_id:unit,locale:"zh-CN".into(),
                source_revision_id:source,expected_selection_id:None,text:"First".into()};
            let first=store.save_translation_revision(&original).unwrap();
            let second=store.save_translation_revision(&tsumugi_core::SaveTranslationRevision {action_id:ExecutionId::new(),
                expected_selection_id:Some(first.event_id),text:"Second".into(),..original}).unwrap();
            let comparison=ExecutionId::new();store.create_comparison(&tsumugi_core::ComparisonRequest {project_id:project,
                action_id:comparison,unit_id:unit,locale:"zh-CN".into(),revision_ids:vec![first.revision_id,second.revision_id],blind:true}).unwrap();
            let wire:Value=serde_json::from_str(include_str!("../../../../test/fixtures/arenaCommands.contract.json")).unwrap();
            let mut config:tsumugi_core::ai::arena::ArenaConfig=serde_json::from_value(wire["requests"]["preview"]["config"].clone()).unwrap();config.blind=true;
            let input=store.preview_arena(config,"zh-CN",&[unit]).unwrap().fixed_input(store.metadata().unwrap().project_id()).unwrap();
            store.enqueue_execution(&input).unwrap();(comparison,input.envelope().attempt_id,input.envelope().task_id)
        });
        for (target,kind) in [(comparison,"comparison"),(attempt,"attempt")] {
            let read=json!({"comparisonId":target});
            let hidden=json!({"projectId":fixture.context["projectId"],"targetId":target,"targetKind":kind,"visible":false});
            assert_eq!(fixture.call("read_arena_reveal_target",read.clone()).unwrap(),hidden);
            for _ in 0..2 {assert_eq!(fixture.call("reveal_arena_identity",json!({"comparisonId":target,"actionId":ExecutionId::new()})).unwrap(),Value::Null);}
            let visible=fixture.call("read_arena_reveal_target",read.clone()).unwrap();assert_eq!(visible["visible"],true);assert_eq!(visible["targetKind"],kind);
            assert!(visible.get("actionId").is_none());
            let mut wrong=read.clone();wrong["projectId"]=json!(ExecutionId::new());assert!(fixture.call("read_arena_reveal_target",wrong).is_err());
            let mut wrong=read.clone();wrong["sessionToken"]=json!("old");assert!(fixture.call("read_arena_reveal_target",wrong).is_err());
            let mut extra=read;extra["actionId"]=json!(ExecutionId::new());assert!(fixture.call("read_arena_reveal_target",extra).is_err());
        }
        let sequence=fixture.app.state::<AppState>().sessions.with(|sessions| {
            let active=sessions.active.as_mut().unwrap();active.execution.as_mut().unwrap().quiescing=true;active.store.execution_sequence().unwrap()
        });
        for target in [comparison,attempt] {assert_eq!(fixture.call("read_arena_reveal_target",json!({"comparisonId":target})).unwrap()["visible"],true);}
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();assert_eq!(active.store.execution_sequence().unwrap(),sequence);
            assert_eq!(active.store.provider_budget(task).unwrap().unwrap().dispatched,0);
            active.store.cancel_execution(task,ExecutionId::new()).unwrap();active.execution.as_mut().unwrap().quiescing=false;
        });
        let old=request(&fixture.context,json!({"comparisonId":comparison}));fixture.reopen();
        assert!(call(&fixture.webview,"read_arena_reveal_target",old).is_err());
        for target in [comparison,attempt] {assert_eq!(fixture.call("read_arena_reveal_target",json!({"comparisonId":target})).unwrap()["visible"],true);}
    }

    #[test]
    fn registered_arena_action_reads_keep_original_creation_merge_and_selection_after_reopen() {
        let isolated=ProjectFixture::create("en-US");
        let scope=json!({"actionId":ExecutionId::new(),"unitId":ExecutionId::new(),"locale":"zh-CN"});
        let mut compare=scope.clone();compare["revisionIds"]=json!([ExecutionId::new(),ExecutionId::new()]);compare["blind"]=json!(true);
        assert!(call(&isolated.webview,"read_arena_comparison_action",request(&isolated.context,compare)).is_err());
        let mut merge=scope;merge["sourceRevisionId"]=json!(ExecutionId::new());merge["expectedSelectionId"]=Value::Null;merge["text"]=json!("Merged");
        merge["merge"]=json!({"contributors":[ExecutionId::new(),ExecutionId::new()],"expectedBasis":"none"});
        assert!(call(&isolated.webview,"read_arena_merge_action",request(&isolated.context,merge)).is_err());
        isolated.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
        let mut fixture=Fixture::create();let unit=fixture.unit;let source=fixture.source_revision;
        let (first,second)=fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let store=&mut sessions.active.as_mut().unwrap().store;
            let project=ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
            let request=tsumugi_core::SaveTranslationRevision {project_id:project,action_id:ExecutionId::new(),unit_id:unit,
                locale:"zh-CN".into(),source_revision_id:source,expected_selection_id:None,text:"First".into()};
            let first=store.save_translation_revision(&request).unwrap();
            let second=store.save_translation_revision(&tsumugi_core::SaveTranslationRevision {action_id:ExecutionId::new(),
                expected_selection_id:Some(first.event_id),text:"Second".into(),..request}).unwrap();(first,second)
        });
        let compare=json!({"actionId":ExecutionId::new(),"unitId":unit,"locale":"zh-CN","revisionIds":[first.revision_id,second.revision_id],"blind":true});
        assert_eq!(fixture.call("read_arena_comparison_action",compare.clone()).unwrap(),Value::Null);
        let view=fixture.call("create_arena_comparison",compare.clone()).unwrap();
        let mut expected=compare.clone();expected["projectId"]=fixture.context["projectId"].clone();
        assert_eq!(fixture.call("read_arena_comparison_action",compare.clone()).unwrap(),expected);
        let merge=json!({"actionId":ExecutionId::new(),"unitId":unit,"locale":"zh-CN","sourceRevisionId":source,
            "expectedSelectionId":second.event_id,"text":"Merged","merge":{"contributors":[first.revision_id,second.revision_id],"expectedBasis":view["basis"]}});
        assert_eq!(fixture.call("read_arena_merge_action",merge.clone()).unwrap(),Value::Null);
        let receipt=fixture.call("save_arena_merge",merge.clone()).unwrap();
        let mut original=merge.clone();original.as_object_mut().unwrap().remove("merge");original["projectId"]=fixture.context["projectId"].clone();
        let merged=json!({"request":original,"merge":merge["merge"],"receipt":receipt});
        assert_eq!(fixture.call("read_arena_merge_action",merge.clone()).unwrap(),merged);
        let mut wrong=compare.clone();wrong["revisionIds"]=json!([second.revision_id,first.revision_id]);assert!(fixture.call("read_arena_comparison_action",wrong).is_err());
        let mut wrong=merge.clone();wrong["text"]=json!("Different");assert!(fixture.call("read_arena_merge_action",wrong).is_err());
        for (command,value) in [("read_arena_comparison_action",compare.clone()),("read_arena_merge_action",merge.clone())] {
            let mut wrong=value.clone();wrong["projectId"]=json!(ExecutionId::new());assert!(fixture.call(command,wrong).is_err());
            let mut wrong=value;wrong["sessionToken"]=json!("old");assert!(fixture.call(command,wrong).is_err());
        }
        let sequence=fixture.app.state::<AppState>().sessions.with(|sessions| {
            let active=sessions.active.as_mut().unwrap();active.execution.as_mut().unwrap().quiescing=true;active.store.execution_sequence().unwrap()
        });
        assert_eq!(fixture.call("read_arena_comparison_action",compare.clone()).unwrap(),expected);
        assert_eq!(fixture.call("read_arena_merge_action",merge.clone()).unwrap(),merged);
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();assert_eq!(active.store.execution_sequence().unwrap(),sequence);active.execution.as_mut().unwrap().quiescing=false;
        });
        let old=request(&fixture.context,merge.clone());fixture.reopen();
        assert!(call(&fixture.webview,"read_arena_merge_action",old).is_err());
        assert_eq!(fixture.call("read_arena_comparison_action",compare).unwrap(),expected);
        assert_eq!(fixture.call("read_arena_merge_action",merge).unwrap(),merged);
    }

    #[test]
    fn registered_start_action_reads_confirm_only_enqueued_inputs_without_provider_dispatch() {
        let isolated = ProjectFixture::create("en-US");
        for (command, extra) in [
            ("read_work_plan_start_action",json!({"planId":ExecutionId::new(),"actionId":ExecutionId::new(),"expectedGeneration":"1"})),
            ("read_arena_start_action",json!({"attemptId":ExecutionId::new(),"digest":"0".repeat(64),"confirmed":true})),
        ] {
            assert_eq!(call(&isolated.webview,command,request(&isolated.context,extra)).unwrap(),Value::Null);
        }
        isolated.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));

        let mut fixture=Fixture::create();
        let wire:Value=serde_json::from_str(include_str!("../../../../test/fixtures/aiCommands.contract.json")).unwrap();
        let config:AiConfig=serde_json::from_value(wire["requests"]["preview"]["config"].clone()).unwrap();
        let unit=fixture.unit;
        let (start,arena_start,input)=fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let store=&mut sessions.active.as_mut().unwrap().store;
            let plan=store.prepare_work_plan(Some(config.clone()),"zh-CN",&[unit],PlanOptions::default()).unwrap();
            let authorization=AuthorizeWorkPlan {action_id:ExecutionId::new(),plan_digest:plan.digest.clone(),confirmed:true,
                effects:plan.authorization_effects().unwrap(),expires_at:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()+60};
            let receipt=store.authorize_work_plan(&plan,&authorization).unwrap();
            let input=FixedInput::capture(receipt.input.unwrap()).unwrap();
            let arena_wire:Value=serde_json::from_str(include_str!("../../../../test/fixtures/arenaCommands.contract.json")).unwrap();
            let arena_config:tsumugi_core::ai::arena::ArenaConfig=serde_json::from_value(arena_wire["requests"]["preview"]["config"].clone()).unwrap();
            let arena=store.preview_arena(arena_config,"zh-CN",&[unit]).unwrap();
            let fixed=arena.fixed_input(store.metadata().unwrap().project_id()).unwrap();
            store.enqueue_execution(&fixed).unwrap();
            (json!({"planId":plan.plan_id,"actionId":authorization.action_id,"expectedGeneration":receipt.lease.generation}),
                json!({"attemptId":fixed.envelope().attempt_id,"digest":arena.digest,"confirmed":true}),input)
        });
        assert_eq!(fixture.call("read_work_plan_start_action",start.clone()).unwrap(),Value::Null);
        let input_copy=input.clone();
        fixture.app.state::<AppState>().sessions.with(move |sessions|sessions.active.as_mut().unwrap().store.enqueue_execution(&input_copy).unwrap());
        let expected=json!({"projectId":fixture.context["projectId"],"planId":start["planId"],"actionId":start["actionId"],
            "expectedGeneration":start["expectedGeneration"],"attemptId":input.envelope().attempt_id,"taskId":input.envelope().task_id});
        let sequence=fixture.app.state::<AppState>().sessions.with(|sessions|sessions.active.as_ref().unwrap().store.execution_sequence().unwrap());
        assert_eq!(fixture.call("read_work_plan_start_action",start.clone()).unwrap(),expected);
        let arena_expected=fixture.call("read_arena_start_action",arena_start.clone()).unwrap();
        assert_eq!(arena_expected["attemptId"],arena_start["attemptId"]);
        assert_eq!(arena_expected["digest"],arena_start["digest"]);
        for (command, mut bad) in [("read_work_plan_start_action",start.clone()),("read_arena_start_action",arena_start.clone())] {
            bad["projectId"]=json!(ExecutionId::new());assert!(fixture.call(command,bad).is_err());
            let mut bad=if command=="read_work_plan_start_action" {start.clone()} else {arena_start.clone()};
            bad["sessionToken"]=json!("wrong-session");assert!(fixture.call(command,bad).is_err());
        }
        let mut bad=start.clone();bad["expectedGeneration"]=json!("2");assert!(fixture.call("read_work_plan_start_action",bad).is_err());
        let mut bad=arena_start.clone();bad["digest"]=json!("0".repeat(64));assert!(fixture.call("read_arena_start_action",bad).is_err());
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();
            assert_eq!(active.store.execution_sequence().unwrap(),sequence);
            assert_eq!(active.store.provider_budget(input.envelope().task_id).unwrap().unwrap().dispatched,0);
            active.execution.as_mut().unwrap().quiescing=true;
        });
        assert_eq!(fixture.call("read_work_plan_start_action",start.clone()).unwrap(),expected);
        assert_eq!(fixture.call("read_arena_start_action",arena_start.clone()).unwrap(),arena_expected);
        // End only these fixture queues through their ordinary cancellation path.
        // The manual quiescing probe above did not perform a shutdown.
        let plan_task:ExecutionId=serde_json::from_value(expected["taskId"].clone()).unwrap();
        let arena_task:ExecutionId=serde_json::from_value(arena_expected["taskId"].clone()).unwrap();
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let active=sessions.active.as_mut().unwrap();
            active.store.cancel_execution(plan_task,ExecutionId::new()).unwrap();
            active.store.cancel_execution(arena_task,ExecutionId::new()).unwrap();
            active.execution.as_mut().unwrap().quiescing=false;
        });
        assert_eq!(fixture.call("read_work_plan_start_action",start.clone()).unwrap(),expected);
        let old=request(&fixture.context,start.clone());fixture.reopen();
        assert!(call(&fixture.webview,"read_work_plan_start_action",old).is_err());
        assert_eq!(fixture.call("read_work_plan_start_action",start).unwrap(),expected);
        assert_eq!(fixture.call("read_arena_start_action",arena_start).unwrap(),arena_expected);
    }

    #[test]
    fn checked_worker_explicit_continue_after_reopen_preserves_budget_and_own_selection() {
        let mut fixture = Fixture::create();
        let (config, provider) = local_provider_sequence(vec!["第一稿", "第二稿"], None);
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::ReplaceCapturedSelection,
        );
        let first = fixture.wait_effect(&plan);
        assert_eq!(
            first["rows"][0]["automation"]["phase"], "selected",
            "{first}"
        );
        assert_eq!(first["budget"]["dispatched"], 1);
        let original = first["rows"][0]["automation"].clone();
        fixture.reopen();
        let status = fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap();
        assert_eq!(status["state"], "paused");
        let continue_request = json!({"planId":plan["planId"],"actionId":ExecutionId::new(),
            "expectedGeneration":status["lease"]["generation"],"command":"continue",
            "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"applicationToolExecutions":[],"expiresAt":expiry()});
        let resumed = fixture
            .call("control_work_plan", continue_request.clone())
            .unwrap();
        assert_eq!(resumed["state"], "active");
        assert_eq!(resumed["lease"]["generation"], "3");
        assert_ne!(resumed["attemptId"], plan["attemptId"]);
        assert!(resumed["parentTask"].is_string());
        assert_eq!(
            fixture.call("control_work_plan", continue_request).unwrap(),
            resumed
        );
        let start = json!({"planId":plan["planId"],"actionId":resumed["actionId"],"expectedGeneration":resumed["lease"]["generation"]});
        assert_eq!(
            fixture.call("start_work_plan", start.clone()).unwrap(),
            resumed["attemptId"]
        );
        assert_eq!(
            fixture.call("start_work_plan", start).unwrap(),
            resumed["attemptId"]
        );
        let second = fixture.wait_effect(&resumed);
        let row = &second["rows"][0];
        assert_eq!(row["automation"]["phase"], "selected", "{second}");
        assert_eq!(row["output"]["text"], "第二稿");
        assert_ne!(row["savedRevisionId"], first["rows"][0]["savedRevisionId"]);
        assert_eq!(
            row["automation"]["receipt"]["selection"]["previousEventId"],
            original["receipt"]["selection"]["eventId"]
        );
        assert_eq!(
            row["automation"]["receipt"]["request"]["lease"]["generation"],
            "3"
        );
        assert_eq!(second["budget"]["dispatched"], 2);
        assert_eq!(second["budget"]["limit"], 2);
        assert_eq!(second["budget"]["promptTokens"], "2");
        assert_eq!(second["budget"]["completionTokens"], "2");
        let historical = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]}),
            )
            .unwrap();
        assert_eq!(historical["rows"][0]["automation"], original);
        assert_eq!(historical["budget"], second["budget"]);
        let unit = fixture.unit;
        let expected_revision = row["savedRevisionId"].as_str().unwrap().to_owned();
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                let history = store
                    .translation_history(
                        ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
                            .unwrap(),
                        unit,
                        "zh-CN",
                        0,
                        100,
                    )
                    .unwrap();
                assert_eq!(history.rows.len(), 2);
                assert_eq!(
                    history.current.unwrap().revision_id.to_string(),
                    expected_revision
                );
                let target = store
                    .review_target(
                        ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
                            .unwrap(),
                        unit,
                        "zh-CN",
                    )
                    .unwrap();
                assert!(target.current_check.is_some());
                assert!(target.current_decision.is_none());
            });
        provider.join().unwrap();
        // The original budget is exhausted. A fresh explicit continuation does
        // not acquire another reservation, even after the provider has exited.
        let paused = fixture
            .call(
                "control_work_plan",
                json!({"planId":plan["planId"],
            "actionId":ExecutionId::new(),"expectedGeneration":"3","command":"pause",
            "confirmed":false,"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"expiresAt":null}),
            )
            .unwrap();
        let third = fixture
            .call(
                "control_work_plan",
                json!({"planId":plan["planId"],
            "actionId":ExecutionId::new(),"expectedGeneration":paused["lease"]["generation"],
            "command":"continue","confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"applicationToolExecutions":[],"expiresAt":expiry()}),
            )
            .unwrap();
        fixture
            .call(
                "start_work_plan",
                json!({"planId":plan["planId"],
            "actionId":third["actionId"],"expectedGeneration":third["lease"]["generation"]}),
            )
            .unwrap();
        let exhausted = fixture.wait_effect(&third);
        assert_eq!(exhausted["budget"]["dispatched"], 2);
        assert_eq!(exhausted["budget"], second["budget"]);
        assert!(exhausted["rows"][0]["output"].is_null());
        assert!(exhausted["rows"][0]["savedRevisionId"].is_null());
        assert!(exhausted["rows"][0]["automation"]["receipt"].is_null());
        assert_eq!(
            exhausted["detail"]["items"][0]["status"]["diagnostic"],
            "ai-budget"
        );
    }

    #[test]
    fn checked_worker_keeps_protected_candidate_with_mechanical_evidence() {
        let fixture = Fixture::create();
        fixture.call("set_work_protection", json!({"actionId":ExecutionId::new(),"unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,"selectionId":null,"expectedRevision":"0","protected":true,"confirmedRelease":false})).unwrap();
        let (config, provider) = local_provider("你好");
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::ReplaceCapturedSelection,
        );
        let view = fixture.wait_effect(&plan);
        let row = &view["rows"][0];
        assert_eq!(row["automation"]["phase"], "blocked", "{view}");
        assert_eq!(row["automation"]["receipt"]["blocked"], "protected");
        assert_eq!(
            row["automation"]["receipt"]["rules"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert!(row["savedRevisionId"].is_string());
        assert!(row["automation"]["receipt"]["selection"].is_null());
        let unit = fixture.unit;
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                let history = store
                    .translation_history(
                        ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
                            .unwrap(),
                        unit,
                        "zh-CN",
                        0,
                        100,
                    )
                    .unwrap();
                assert_eq!(history.rows.len(), 1);
                assert!(history.current.is_none());
            });
        provider.join().unwrap();
    }

    #[test]
    fn checked_worker_preserves_failed_checks_without_selecting_candidate() {
        let fixture = Fixture::create();
        let (config, provider) = local_provider("");
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::MissingOnly,
        );
        let view = fixture.wait_effect(&plan);
        let receipt = &view["rows"][0]["automation"]["receipt"];
        assert_eq!(view["rows"][0]["automation"]["phase"], "blocked", "{view}");
        assert_eq!(receipt["blocked"], "checks");
        assert!(receipt["selection"].is_null());
        assert!(
            receipt["rules"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| !rule["findings"].as_array().unwrap().is_empty())
        );
        provider.join().unwrap();
    }

    #[test]
    fn checked_worker_retries_same_action_after_known_storage_failure() {
        let fixture = Fixture::create();
        let connection =
            rusqlite::Connection::open(fixture.directory.path().join("project/project.sqlite3"))
                .unwrap();
        connection.execute_batch("CREATE TRIGGER fail_policy BEFORE INSERT ON application_selection_actions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
        let (config, provider) = local_provider("你好");
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::MissingOnly,
        );
        let failed = fixture.wait_effect(&plan);
        let row = &failed["rows"][0];
        assert_eq!(row["automation"]["phase"], "failed", "{failed}");
        assert_eq!(row["automation"]["retryable"], true);
        let action = row["automation"]["actionId"].clone();
        let revision = row["savedRevisionId"].clone();
        assert!(action.is_string() && revision.is_string());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM translation_selections", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        connection
            .execute_batch("DROP TRIGGER fail_policy")
            .unwrap();
        let request = json!({"attemptId":plan["attemptId"],"itemId":row["itemId"]});
        assert_eq!(
            fixture
                .call("retry_work_plan_effect", request.clone())
                .unwrap(),
            true
        );
        let selected = fixture.wait_effect(&plan);
        let current = &selected["rows"][0];
        assert_eq!(current["automation"]["phase"], "selected", "{selected}");
        assert_eq!(current["automation"]["actionId"], action);
        assert_eq!(current["savedRevisionId"], revision);
        assert!(fixture.call("retry_work_plan_effect", request).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM translation_revisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(selected["budget"]["dispatched"], 1);
        provider.join().unwrap();
    }

    #[test]
    fn checked_worker_pause_revokes_saving_and_retry_during_provider_wait() {
        let fixture = Fixture::create();
        let (started, waiting) = mpsc::channel();
        let (release, hold) = mpsc::channel();
        let (config, provider) = local_provider_gate("你好", Some((started, hold)));
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::MissingOnly,
        );
        waiting.recv_timeout(Duration::from_secs(3)).unwrap();
        fixture.call("control_work_plan", json!({"actionId":ExecutionId::new(),"planId":plan["planId"],"expectedGeneration":"1","command":"pause","confirmed":false,"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"expiresAt":null})).unwrap();
        release.send(()).unwrap();
        provider.join().unwrap();
        let view = fixture.wait_effect(&plan);
        assert_eq!(view["rows"][0]["automation"]["retryable"], false);
        assert!(view["rows"][0]["savedRevisionId"].is_null());
        assert!(view["rows"][0]["automation"]["receipt"].is_null());
        assert!(
            fixture
                .call(
                    "retry_work_plan_effect",
                    json!({"attemptId":plan["attemptId"],"itemId":view["rows"][0]["itemId"]})
                )
                .is_err()
        );
        let connection = rusqlite::Connection::open_with_flags(
            fixture.directory.path().join("project/project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM translation_revisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(view["budget"]["dispatched"], 1);
        let status = fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap();
        assert_eq!(status["state"], "paused");
        assert_eq!(status["lease"]["generation"], "2");
    }

    #[test]
    fn checked_worker_fresh_host_pauses_crash_surviving_grant_without_replaying_effects() {
        let mut fixture = Fixture::create();
        let (config, provider) = local_provider("你好");
        let plan = fixture.start_checked(
            config,
            tsumugi_core::application::SelectionPolicy::MissingOnly,
        );
        let selected = fixture.wait_effect(&plan);
        provider.join().unwrap();
        // Simulate losing the host without the orderly close/quiesce command.
        fixture.app.state::<AppState>().sessions.with(|sessions| {
            sessions.active.take();
        });
        let reopened = call(
            &fixture.webview,
            "open_project",
            json!({"locator":fixture.directory.path().join("project")}),
        )
        .unwrap();
        fixture.context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
        let status = fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap();
        assert_eq!(status["state"], "paused");
        assert_eq!(status["lease"]["generation"], "2");
        let before = fixture.bytes();
        let view = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]}),
            )
            .unwrap();
        assert_eq!(
            view["rows"][0]["automation"],
            selected["rows"][0]["automation"]
        );
        assert_eq!(
            view["rows"][0]["savedRevisionId"],
            selected["rows"][0]["savedRevisionId"]
        );
        assert_eq!(fixture.bytes(), before);
        assert_eq!(view["budget"]["dispatched"], 1);
    }

    #[test]
    fn checked_worker_reconciles_a_concurrent_candidate_save_without_bypassing_pause() {
        let fixture = Fixture::create();
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &mut sessions.active.as_mut().unwrap().store;
                let mut options = PlanOptions {
                    selection_policy: tsumugi_core::application::SelectionPolicy::MissingOnly,
                    ..PlanOptions::default()
                };
                options
                    .stages
                    .iter_mut()
                    .find(|stage| stage.stage == WorkStage::Checks)
                    .unwrap()
                    .mode = StageMode::Assisted;
                let plan = store
                    .prepare_work_plan(
                        Some(AiConfig {
                            endpoint: "http://127.0.0.1:9".into(),
                            model: "synthetic".into(),
                            credential_env: String::new(),
                            ..AiConfig::default()
                        }),
                        "zh-CN",
                        &[fixture.unit],
                        options,
                    )
                    .unwrap();
                let grant = store
                    .authorize_work_plan(
                        &plan,
                        &AuthorizeWorkPlan {
                            action_id: ExecutionId::new(),
                            plan_digest: plan.digest.clone(),
                            confirmed: true,
                            effects: vec![
                                AutomationEffect::SaveCandidate,
                                AutomationEffect::RunChecks,
                                AutomationEffect::SelectMissing,
                            ],
                            expires_at: expiry().parse().unwrap(),
                        },
                    )
                    .unwrap();
                let input = FixedInput::capture(grant.input.unwrap()).unwrap();
                store.enqueue_execution(&input).unwrap();
                let attempt = input.envelope().attempt_id;
                let item = input.envelope().items[0].item_id;
                let dispatch = store.dispatch_execution_item(attempt, item).unwrap();
                let result = FixedResult::capture(
                    ResultEnvelope {
                        project_id: input.envelope().project_id,
                        attempt_id: attempt,
                        item_id: item,
                        result_id: ExecutionId::new(),
                        supersedes: None,
                        dispatch_token: dispatch.dispatch_token,
                        capability_id: tsumugi_core::ai::CAPABILITY.into(),
                        capability_version: "1".into(),
                        plugin: None,
                        outcome: ExecutionState::Succeeded,
                        output: Some(
                            serde_json::to_value(tsumugi_core::ai::AiOutput {
                                unit_id: fixture.unit,
                                target_locale: "zh-CN".into(),
                                text: "Synthetic candidate".into(),
                                usage: None,
                                requests: 1,
                                usage_incomplete: true,
                            })
                            .unwrap(),
                        ),
                        diagnostic: None,
                    },
                    &input,
                    dispatch.dispatch_token,
                )
                .unwrap();
                store.save_execution_result(&result).unwrap();
                store
                    .validate_execution_result(attempt, result.envelope().result_id)
                    .unwrap();
                let recovery_unit = input.envelope().units[0].unit_id;
                let mut captures = Vec::new();
                for _ in 0..2 {
                    let action = store
                        .prepare_adoption_with_id(
                            ExecutionId::new(),
                            attempt,
                            recovery_unit,
                            vec![result.envelope().result_id],
                            Value::Null,
                        )
                        .unwrap();
                    captures.push(
                        store
                            .capture_execution_adoption(&action)
                            .unwrap()
                            .prepare(&tsumugi_core::AiAdoptionHandler)
                            .unwrap(),
                    );
                }
                let manual = store
                    .prepare_adoption_with_id(
                        ExecutionId::new(),
                        attempt,
                        recovery_unit,
                        vec![result.envelope().result_id],
                        Value::Null,
                    )
                    .unwrap();
                store
                    .adopt_execution(&manual, &tsumugi_core::AiAdoptionHandler)
                    .unwrap();
                let revision = store.saved_ai_candidate(attempt, item).unwrap().unwrap();
                assert_eq!(
                    super::super::ai::commit_candidate(store, captures.remove(0), attempt, item)
                        .unwrap(),
                    revision
                );
                store
                    .control_work_plan(&ControlWorkPlan {
                        action_id: ExecutionId::new(),
                        plan_id: plan.plan_id,
                        expected_generation: grant.lease.generation,
                        command: WorkPlanCommand::Pause,
                        confirmed: false,
                        expires_at: None,
                    })
                    .unwrap();
                assert!(
                    super::super::ai::commit_candidate(store, captures.remove(0), attempt, item)
                        .is_err()
                );
                assert_eq!(
                    store.saved_ai_candidate(attempt, item).unwrap(),
                    Some(revision)
                );
                let history = store
                    .translation_history(input.envelope().project_id, fixture.unit, "zh-CN", 0, 100)
                    .unwrap();
                assert_eq!(history.rows.len(), 1);
                assert!(history.current.is_none());
            });
    }

    fn manual_options() -> PlanOptions {
        PlanOptions {
            stages: vec![StageChoice {
                stage: WorkStage::Generation,
                mode: StageMode::Manual,
            }],
            ..PlanOptions::default()
        }
    }

    fn expiry() -> String {
        (SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 300)
            .to_string()
    }

    #[test]
    fn team_discussion_preparation_captures_limits_and_requires_the_original_effect() {
        use tsumugi_core::application::{TeamDiscussionLimits, TeamDiscussionPolicy};
        for (profile, policy) in [
            ("current-plan-1", TeamDiscussionPolicy::CurrentPlanV1 {}),
            ("current-plan-2", TeamDiscussionPolicy::CurrentPlanV2 {}),
        ] {
            let fixture = Fixture::create();
            let config = AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic-discussion-disclosure".into(),
                credential_env: String::new(),
                ..AiConfig::default()
            };
            let prepare = json!({
                "config":config,"locale":"zh-CN","unitIds":[fixture.unit],
                "options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null
            });
            let before = fixture.bytes();
            let ordinary = fixture.call("prepare_work_plan", prepare.clone()).unwrap();
            assert!(ordinary["options"].get("teamDiscussions").is_none());
            assert!(ordinary.get("teamDiscussionLimits").is_none());
            let mut enabled = prepare;
            enabled["options"]["teamDiscussions"] = json!({"profile":profile});
            let plan = fixture.call("prepare_work_plan", enabled).unwrap();
            assert_eq!(fixture.bytes(), before);
            assert_eq!(plan["preview"]["config"], ordinary["preview"]["config"]);
            assert_eq!(
                plan["teamDiscussionLimits"],
                serde_json::to_value(TeamDiscussionLimits::for_policy(policy)).unwrap()
            );
            assert_eq!(
                plan["options"]["teamDiscussions"],
                json!({"profile":profile})
            );
            let mut authorization = json!({
                "planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),
                "confirmed":true,"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],
                "effects":["save-candidate"],"expiresAt":expiry()
            });
            assert!(
                fixture
                    .call("authorize_work_plan", authorization.clone())
                    .is_err()
            );
            assert_eq!(fixture.bytes(), before);
            authorization["effects"] = json!(["save-candidate", "publish-discussion"]);
            fixture.call("authorize_work_plan", authorization).unwrap();
            let status = fixture
                .call("read_work_plan_status", json!({"planId":plan["planId"]}))
                .unwrap();
            assert_eq!(
                status["effects"],
                json!(["save-candidate", "publish-discussion"])
            );
            assert_eq!(status["plan"]["options"], plan["options"]);
            assert_eq!(
                status["plan"]["teamDiscussionLimits"],
                plan["teamDiscussionLimits"]
            );
            assert_eq!(
                status["plan"]["preview"]["config"],
                plan["preview"]["config"]
            );
        }
    }

    #[test]
    fn manual_preparation_is_read_only_and_rejects_untrusted_wire_inputs() {
        let fixture = Fixture::create();
        let before = fixture.bytes();
        let prepared = fixture.call("prepare_work_plan", json!({
            "config":null, "locale":"zh-CN", "unitIds":[fixture.unit], "options":manual_options(), "advisoryChecks":[],"toolSelection":null
        })).unwrap();
        assert_eq!(prepared["locale"], "zh-CN");
        assert_eq!(prepared["scope"][0]["unitId"], json!(fixture.unit));
        assert_eq!(
            prepared["scope"][0]["sourceSnapshotId"],
            json!(fixture.snapshot)
        );
        assert_eq!(
            prepared["scope"][0]["sourceRevisionId"],
            json!(fixture.source_revision)
        );
        assert_eq!(prepared["scope"][0]["nativeKey"], "first");
        assert!(prepared["preview"].is_null() && prepared["attemptId"].is_null());
        assert!(prepared.get("input").is_none());
        assert_eq!(fixture.bytes(), before);
        assert!(fixture.call("prepare_work_plan", json!({
            "config":null, "locale":"zh-CN", "unitIds":[fixture.unit], "options":PlanOptions::default(), "advisoryChecks":[],"toolSelection":null
        })).is_err());
        assert!(fixture.call("authorize_work_plan", json!({
            "planId":prepared["planId"], "digest":prepared["digest"], "actionId":ExecutionId::new(),
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false,"applicationToolExecutions":[], "effects":["save-candidate"], "expiresAt":expiry(),
            "semanticAnswer":"yes"
        })).is_err());
        assert!(fixture.call("authorize_work_plan", json!({
            "planId":prepared["planId"], "digest":prepared["digest"], "actionId":ExecutionId::new(),
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false,"applicationToolExecutions":[], "effects":["save-candidate"], "expiresAt":expiry()
        })).is_err());
        assert!(fixture.call("prepare_work_plan", json!({
            "config":null, "locale":"zh-CN", "unitIds":[fixture.unit], "options":manual_options(),
            "advisoryChecks":[],"toolSelection":null, "input":{}
        })).is_err());
        assert!(
            fixture
                .call(
                    "read_work_plan_action",
                    json!({
                        "sessionToken":"inactive-session", "actionId":ExecutionId::new()
                    })
                )
                .is_err()
        );
        assert!(
            fixture
                .call(
                    "read_work_protection",
                    json!({
                        "projectId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN"
                    })
                )
                .is_err()
        );
        assert_eq!(
            fixture
                .call(
                    "read_work_plan_action",
                    json!({"actionId":ExecutionId::new()})
                )
                .unwrap(),
            Value::Null
        );
        assert_eq!(fixture.bytes(), before);
        assert!(fixture.app.state::<AppState>().sessions.with(|sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap()
                .work_plans
                .prepared
                .is_some()
        }));
    }

    fn assert_control_revokes_its_lease_while_blocking_io_is_saturated(
        command: &str,
        expected_state: &str,
    ) {
        let fixture = Fixture::create();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let config = AiConfig {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            model: "synthetic-control-admission".into(),
            credential_env: String::new(),
            max_requests: 4,
            timeout_seconds: 1,
            ..AiConfig::default()
        };
        let prepared = fixture
            .call(
                "prepare_work_plan",
                json!({
                    "config":config,"locale":"zh-CN","unitIds":[fixture.unit],
                    "options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null
                }),
            )
            .unwrap();
        let authorization = fixture
            .call(
                "authorize_work_plan",
                json!({
                    "planId":prepared["planId"],"digest":prepared["digest"],
                    "actionId":ExecutionId::new(),"confirmed":true,
                    "checkerExecutions":checker_keys(&prepared),"toolExecution":false,
                    "applicationToolExecutions":[],"effects":["save-candidate"],"expiresAt":expiry()
                }),
            )
            .unwrap();
        assert_eq!(authorization["lease"]["generation"], "1");
        let attempts = fixture.attempt_count();
        let io = fixture.app.state::<AppState>().io.clone();
        let mut held = SaturatedIo::hold(&io);
        let control = json!({
            "planId":prepared["planId"],"actionId":ExecutionId::new(),
            "expectedGeneration":authorization["lease"]["generation"],"command":command,
            "confirmed":false,"checkerExecutions":[],"toolExecution":false,
            "applicationToolExecutions":[],"expiresAt":null
        });
        let receipt = held
            .call_once(&fixture, "control_work_plan", control.clone())
            .unwrap();
        assert_eq!(receipt["state"], expected_state);
        assert_eq!(receipt["lease"]["generation"], "2");
        assert_eq!(receipt["lease"]["planId"], prepared["planId"]);
        assert_eq!(receipt["actionId"], control["actionId"]);
        held.assert_full(&io);
        assert_eq!(
            held.call_once(&fixture, "control_work_plan", control.clone())
                .unwrap(),
            receipt
        );
        let recorded = held
            .call_once(&fixture, "read_work_plan_control_action", control.clone())
            .unwrap();
        assert_eq!(recorded["receipt"], receipt);
        assert_eq!(
            recorded["request"],
            json!({
                "kind":"control","planId":prepared["planId"],"actionId":control["actionId"],
                "expectedGeneration":"1","command":command,"confirmed":false,"expiresAt":null
            })
        );

        let mut stale = control.clone();
        stale["actionId"] = json!(ExecutionId::new());
        let rejected = held
            .call_once(&fixture, "control_work_plan", stale.clone())
            .unwrap_err();
        assert_eq!(rejected["code"], "dependency-conflict");
        assert_eq!(rejected["reason"], "work-plan-generation");
        assert_eq!(
            held.call_once(
                &fixture,
                "read_work_plan_action",
                json!({"actionId":stale["actionId"]})
            )
            .unwrap(),
            Value::Null
        );

        if command == "pause" {
            let resume = json!({
                "planId":prepared["planId"],"actionId":ExecutionId::new(),
                "expectedGeneration":receipt["lease"]["generation"],"command":"continue",
                "confirmed":true,"checkerExecutions":checker_keys(&prepared),"toolExecution":false,
                "applicationToolExecutions":[],"expiresAt":expiry()
            });
            let busy = held
                .call_once(&fixture, "control_work_plan", resume.clone())
                .unwrap_err();
            assert_eq!(busy["code"], "busy");
            assert_eq!(
                held.call_once(
                    &fixture,
                    "read_work_plan_action",
                    json!({"actionId":resume["actionId"]})
                )
                .unwrap(),
                Value::Null
            );
        }
        let plan_id = serde_json::from_value(prepared["planId"].clone()).unwrap();
        let (state, lease) = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let status = sessions
                    .active
                    .as_ref()
                    .unwrap()
                    .store
                    .work_plan_status(plan_id)
                    .unwrap();
                (status.state, status.lease)
            });
        assert_eq!(serde_json::to_value(state).unwrap(), expected_state);
        assert_eq!(serde_json::to_value(lease).unwrap(), receipt["lease"]);
        assert_eq!(fixture.attempt_count(), attempts);
        assert!(matches!(listener.accept(), Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock));
        held.assert_full(&io);
    }

    #[test]
    fn pause_work_plan_revokes_its_lease_while_blocking_io_is_saturated() {
        assert_control_revokes_its_lease_while_blocking_io_is_saturated("pause", "paused");
    }

    #[test]
    fn stop_work_plan_revokes_its_lease_while_blocking_io_is_saturated() {
        assert_control_revokes_its_lease_while_blocking_io_is_saturated("stop", "stopped");
    }

    #[test]
    fn take_over_work_plan_revokes_its_lease_while_blocking_io_is_saturated() {
        assert_control_revokes_its_lease_while_blocking_io_is_saturated("take-over", "taken-over");
    }

    #[test]
    fn review_control_noncontinue_receipt_commits_before_a_later_actor_job() {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        for (command, expected) in [
            ("pause", "paused"),
            ("stop", "stopped"),
            ("take-over", "taken-over"),
        ] {
            let fixture = Fixture::create();
            let config = AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic-control-yield".into(),
                credential_env: String::new(),
                ..AiConfig::default()
            };
            let plan = fixture
                .call(
                    "prepare_work_plan",
                    json!({
                        "config":config,"locale":"zh-CN","unitIds":[fixture.unit],
                        "options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null
                    }),
                )
                .unwrap();
            fixture.call("authorize_work_plan", json!({
                "planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),
                "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,
                "applicationToolExecutions":[],"effects":["save-candidate"],"expiresAt":expiry()
            })).unwrap();
            let action = json!({"planId":plan["planId"],"actionId":ExecutionId::new(),
                "expectedGeneration":"1","command":command,"confirmed":false,
                "checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"expiresAt":null});
            let state = fixture.app.state::<AppState>();
            let held = state.sessions.pause();
            let mut eligibility =
                Box::pin(crate::commands::execution::review::read_review_eligibility(
                    fixture.app.state::<AppState>(),
                    serde_json::from_value(request(&fixture.context, json!({"locales":["zh-CN"]})))
                        .unwrap(),
                ));
            let mut work = Box::pin(crate::commands::execution::review::read_review_work(
                fixture.app.state::<AppState>(),
                serde_json::from_value(request(
                    &fixture.context,
                    json!({"locale":"zh-CN","offset":0,"limit":100}),
                ))
                .unwrap(),
            ));
            let mut context = Context::from_waker(Waker::noop());
            assert!(matches!(
                eligibility.as_mut().poll(&mut context),
                Poll::Pending
            ));
            assert!(matches!(work.as_mut().poll(&mut context), Poll::Pending));
            let mut control = Box::pin(control_work_plan(
                fixture.app.state::<AppState>(),
                serde_json::from_value(request(&fixture.context, action.clone())).unwrap(),
            ));
            assert!(matches!(control.as_mut().poll(&mut context), Poll::Pending));
            let (entered, started) = std::sync::mpsc::channel();
            let (release, wait) = std::sync::mpsc::channel();
            let later = state
                .sessions
                .lease(CommandStage::ExecutionRead)
                .unwrap()
                .submit("later.owner-job", CommandStage::ExecutionRead, move |_| {
                    entered.send(()).unwrap();
                    let _ = wait.recv_timeout(Duration::from_secs(5));
                    Ok(())
                })
                .unwrap();
            drop(held);
            started.recv_timeout(Duration::from_secs(5)).unwrap();
            let Poll::Ready(Err(cancelled)) = eligibility.as_mut().poll(&mut context) else {
                panic!("the actual eligibility command must return cancellation");
            };
            assert_eq!(cancelled.code, CommandErrorCode::Cancelled);
            assert_eq!(cancelled.reason.as_deref(), Some("review-read-cancelled"));
            let Poll::Ready(Err(cancelled)) = work.as_mut().poll(&mut context) else {
                panic!("the actual work command must return cancellation");
            };
            assert_eq!(cancelled.code, CommandErrorCode::Cancelled);
            assert_eq!(cancelled.reason.as_deref(), Some("review-read-cancelled"));
            let Poll::Ready(receipt) = control.as_mut().poll(&mut context) else {
                panic!("non-Continue control must not enqueue finish behind the later job");
            };
            let receipt = serde_json::to_value(receipt.unwrap()).unwrap();
            assert_eq!(receipt["state"], expected);
            assert_eq!(receipt["lease"]["generation"], "2");
            // Read the synthetic database while the actor is still held later:
            // the acknowledgement must correspond to the committed original action.
            let db =
                rusqlite::Connection::open(fixture.project_path.join("project.sqlite3")).unwrap();
            let bytes: Vec<u8> = db
                .query_row(
                    "SELECT receipt FROM application_actions WHERE action_id=?1",
                    [action["actionId"].as_str().unwrap()],
                    |row| row.get(0),
                )
                .unwrap();
            let stored: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(stored["actionId"], receipt["actionId"]);
            assert_eq!(stored["lease"], receipt["lease"]);
            assert_eq!(stored["state"], receipt["state"]);
            drop(db);
            release.send(()).unwrap();
            tauri::async_runtime::block_on(later).unwrap();
            assert_eq!(
                fixture.call("control_work_plan", action.clone()).unwrap(),
                receipt
            );
            let mut stale = action;
            stale["actionId"] = json!(ExecutionId::new());
            let rejected = fixture
                .call("control_work_plan", stale.clone())
                .unwrap_err();
            assert_eq!(rejected["code"], "dependency-conflict");
            assert_eq!(rejected["reason"], "work-plan-generation");
            assert_eq!(
                fixture
                    .call(
                        "read_work_plan_action",
                        json!({"actionId":stale["actionId"]})
                    )
                    .unwrap(),
                Value::Null
            );
        }
    }

    #[test]
    fn authorization_start_and_controls_reconcile_fixed_receipts_across_reopen() {
        let mut fixture = Fixture::create();
        // Own the only permitted endpoint. No external provider or credentials
        // are used; a dispatched request can only reach this local listener.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = AiConfig {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            model: "synthetic".into(),
            credential_env: String::new(),
            max_requests: 4,
            timeout_seconds: 1,
            ..AiConfig::default()
        };
        let count = fixture.attempt_count();
        let before = fixture.bytes();
        let prepared = fixture.call("prepare_work_plan", json!({
            "config":config, "locale":"zh-CN", "unitIds":[fixture.unit], "options":PlanOptions::default(), "advisoryChecks":[],"toolSelection":null
        })).unwrap();
        assert!(prepared["preview"].is_object());
        assert!(prepared["preview"]["items"][0]["resourceBaseline"].is_string());
        assert_eq!(fixture.bytes(), before);
        let grant = json!({
            "planId":prepared["planId"], "digest":prepared["digest"], "actionId":ExecutionId::new(),
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false,"applicationToolExecutions":[], "effects":["save-candidate"], "expiresAt":expiry()
        });
        let mut unconfirmed = grant.clone();
        unconfirmed["confirmed"] = json!(false);
        assert!(fixture.call("authorize_work_plan", unconfirmed).is_err());
        let mut integer_expiry = grant.clone();
        integer_expiry["expiresAt"] = json!(300);
        assert!(fixture.call("authorize_work_plan", integer_expiry).is_err());
        assert_eq!(fixture.bytes(), before);
        let receipt = fixture.call("authorize_work_plan", grant.clone()).unwrap();
        assert_eq!(receipt["attemptId"], prepared["attemptId"]);
        assert!(receipt.get("input").is_none() && receipt.get("cancellationRevision").is_none());
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(
            fixture.call("authorize_work_plan", grant.clone()).unwrap(),
            receipt
        );
        let status = fixture
            .call(
                "read_work_plan_status",
                json!({"planId":prepared["planId"]}),
            )
            .unwrap();
        assert_eq!(status["plan"], prepared);
        assert_eq!(status["expiresAt"], grant["expiresAt"]);
        assert_eq!(status["effects"], json!(["save-candidate"]));
        assert!(status.get("cancellationRevision").is_none());
        let start = json!({
            "planId":prepared["planId"], "actionId":receipt["actionId"],
            "expectedGeneration":receipt["lease"]["generation"]
        });
        assert_eq!(
            fixture.call("start_work_plan", start.clone()).unwrap(),
            prepared["attemptId"]
        );
        assert_eq!(
            fixture.call("start_work_plan", start.clone()).unwrap(),
            prepared["attemptId"]
        );
        assert_eq!(fixture.attempt_count(), count + 1);
        fixture.assert_fixed_input(&receipt);
        let view = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":prepared["attemptId"]}),
            )
            .unwrap();
        assert_eq!(view["planId"], prepared["planId"]);
        assert_eq!(view["planGeneration"], receipt["lease"]["generation"]);
        let pause_request = json!({
            "planId":prepared["planId"], "actionId":ExecutionId::new(),
            "expectedGeneration":receipt["lease"]["generation"], "command":"pause",
            "confirmed":false, "checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[], "expiresAt":null
        });
        let paused = fixture
            .call("control_work_plan", pause_request.clone())
            .unwrap();
        assert_eq!(paused["state"], "paused");
        assert!(fixture.call("start_work_plan", start).is_err());
        let resume = json!({
            "planId":prepared["planId"], "actionId":ExecutionId::new(),
            "expectedGeneration":paused["lease"]["generation"], "command":"continue",
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false,"applicationToolExecutions":[], "expiresAt":expiry()
        });
        let resumed = fixture.call("control_work_plan", resume.clone()).unwrap();
        assert_eq!(resumed["state"], "active");
        assert!(resumed["parentTask"].is_string());
        assert_ne!(resumed["attemptId"], prepared["attemptId"]);
        assert_eq!(fixture.attempt_count(), count + 1);
        assert_eq!(fixture.call("control_work_plan", resume).unwrap(), resumed);
        assert_eq!(
            fixture.call("control_work_plan", pause_request).unwrap(),
            paused
        );
        let still_current = fixture
            .call(
                "read_work_plan_status",
                json!({"planId":prepared["planId"]}),
            )
            .unwrap();
        assert_eq!(still_current["state"], "active");
        assert_eq!(still_current["lease"], resumed["lease"]);
        let restart = json!({
            "planId":prepared["planId"], "actionId":resumed["actionId"],
            "expectedGeneration":resumed["lease"]["generation"]
        });
        assert_eq!(
            fixture.call("start_work_plan", restart.clone()).unwrap(),
            resumed["attemptId"]
        );
        assert_eq!(
            fixture.call("start_work_plan", restart.clone()).unwrap(),
            resumed["attemptId"]
        );
        assert_eq!(fixture.attempt_count(), count + 2);
        fixture.assert_fixed_input(&resumed);
        let taken_over = fixture
            .call(
                "control_work_plan",
                json!({
                    "planId":prepared["planId"], "actionId":ExecutionId::new(),
                    "expectedGeneration":resumed["lease"]["generation"], "command":"take-over",
                    "confirmed":false, "checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[], "expiresAt":null
                }),
            )
            .unwrap();
        assert_eq!(taken_over["state"], "taken-over");
        fixture.reopen();
        assert_eq!(
            fixture
                .call(
                    "read_work_plan_action",
                    json!({"actionId":resumed["actionId"]})
                )
                .unwrap(),
            resumed
        );
        let reopened = fixture
            .call(
                "read_work_plan_status",
                json!({"planId":prepared["planId"]}),
            )
            .unwrap();
        assert_eq!(reopened["plan"], prepared);
        assert_eq!(reopened["lease"], taken_over["lease"]);
        assert_eq!(reopened["state"], "taken-over");
        assert!(fixture.call("start_work_plan", restart).is_err());
        assert_eq!(
            fixture.call("authorize_work_plan", grant.clone()).unwrap(),
            receipt
        );
        let mut uncaptured = grant;
        uncaptured["actionId"] = json!(ExecutionId::new());
        assert!(fixture.call("authorize_work_plan", uncaptured).is_err());
        assert_eq!(fixture.attempt_count(), count + 2);
        call(
            &fixture.webview,
            "close_project",
            json!({"sessionToken":fixture.context["sessionToken"]}),
        )
        .unwrap();
    }

    #[test]
    fn protection_release_checks_current_evidence_and_preserves_new_manual_work() {
        let mut fixture = Fixture::create();
        let initial = fixture
            .call(
                "read_work_protection",
                json!({
                    "unitId":fixture.unit, "locale":"zh-CN"
                }),
            )
            .unwrap();
        assert_eq!(initial["revision"], "0");
        assert_eq!(initial["protected"], false);
        let saved = fixture.call("save_translation_revision", json!({
            "actionId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN",
            "sourceRevisionId":fixture.source_revision, "expectedSelectionId":null, "text":"Human translation"
        })).unwrap();
        let protected = fixture
            .call(
                "read_work_protection",
                json!({
                    "unitId":fixture.unit, "locale":"zh-CN"
                }),
            )
            .unwrap();
        assert_eq!(protected["protected"], true);
        let release = json!({
            "actionId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN",
            "sourceRevisionId":fixture.source_revision, "selectionId":saved["selection"]["eventId"],
            "expectedRevision":protected["revision"], "protected":false, "confirmedRelease":true
        });
        let before = fixture.bytes();
        let mut unconfirmed = release.clone();
        unconfirmed["confirmedRelease"] = json!(false);
        assert!(fixture.call("set_work_protection", unconfirmed).is_err());
        let mut stale = release.clone();
        stale["expectedRevision"] = json!("0");
        assert!(fixture.call("set_work_protection", stale).is_err());
        let mut forged = release.clone();
        forged["sourceRevisionId"] = json!(ExecutionId::new());
        assert!(fixture.call("set_work_protection", forged).is_err());
        assert_eq!(fixture.bytes(), before);
        let released = fixture
            .call("set_work_protection", release.clone())
            .unwrap();
        assert_eq!(released["protected"], false);
        fixture.call("save_translation_revision", json!({
            "actionId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN",
            "sourceRevisionId":fixture.source_revision,
            "expectedSelectionId":saved["selection"]["eventId"], "text":"Newer human translation"
        })).unwrap();
        let current = fixture
            .call(
                "read_work_protection",
                json!({
                    "unitId":fixture.unit, "locale":"zh-CN"
                }),
            )
            .unwrap();
        assert_eq!(current["protected"], true);
        assert_ne!(current["revision"], released["revision"]);
        assert_eq!(
            fixture.call("set_work_protection", release).unwrap(),
            released
        );
        fixture.reopen();
        assert_eq!(
            fixture
                .call(
                    "read_work_protection",
                    json!({
                        "unitId":fixture.unit, "locale":"zh-CN"
                    })
                )
                .unwrap(),
            current
        );
    }
}
