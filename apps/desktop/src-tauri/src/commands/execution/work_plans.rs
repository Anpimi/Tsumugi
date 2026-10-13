//! Work-plan commands share the ordinary project session and runtime.
pub(crate) mod agent;
pub(crate) mod broker;
pub(crate) mod generation;
use super::review::checkers::{CheckerEnvironment, ReviewCheckerView, capture_advisory};
use super::{ai_wire::AiPreviewView, *};
use crate::commands::{
    dispatch::BlockingExecutor,
    plugins::{ApplicationPlugins, reviews::PluginTextReviewSelection},
};
use tsumugi_core::content::SourceReviewBinding;
use tsumugi_core::{AdvisoryReviewCheck, ReviewChecker, ReviewCheckerKey};
use tsumugi_core::{
    ai::{self, AiConfig, AiPreview},
    application::{
        AuthorizeWorkPlan, AutomationEffect, AutomationLease, ControlWorkPlan, PlanOptions,
        PlanSelectionBasis, SetWorkProtection, WorkPlan, WorkPlanAgentScope, WorkPlanCommand,
        WorkPlanReceipt, WorkPlanState, WorkPlanStatus, WorkPlanToolConsent, WorkPlanTools,
        WorkProtection,
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
    pub(super) fn stop(&mut self) {
        self.prepared = None;
        self.generation.stop();
        self.environments.clear();
        self.checker_consents.clear();
        self.agent_scopes.clear();
        self.tool_consents.clear();
        self.tool_starts.clear();
        self.tool_intents.clear();
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
        tool_selection: Option<broker::WorkPlanToolSelection>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAuthorizeRequest {
        plan_id: ExecutionId,
        digest: String,
        action_id: ExecutionId,
        confirmed: bool,
        checker_executions: Vec<ReviewCheckerKey>,
        tool_execution: bool,
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
pub struct WorkPlanView {
    pub plan_id: ExecutionId,
    pub digest: String,
    pub locale: String,
    pub options: PlanOptions,
    pub scope: Vec<PlanSelectionBasis>,
    pub preview: Option<AiPreviewView>,
    pub attempt_id: Option<ExecutionId>,
    pub checkers: Vec<WorkPlanCheckerView>,
    pub tools: Option<WorkPlanTools>,
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
            scope: plan.selection_basis.clone(),
            preview,
            attempt_id: plan.input.as_ref().map(|input| input.attempt_id),
            checkers: Vec::new(),
            tools: plan.tools.clone(),
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

#[tauri::command]
pub async fn prepare_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanPrepareRequest,
) -> Result<WorkPlanView, CommandError> {
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
                host.begin_package_work(
                    initial
                        .advisory_checks
                        .iter()
                        .map(|choice| choice.package.clone())
                        .collect(),
                )
            },
        )
        .await?;
    let accepted_work = selected_work.clone();
    let advisory = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            accepted_work.check()?;
            capture_advisory(&plugins, &selections)
        })
        .await?;
    let mut initial = request.clone();
    initial.options.advisory_checks = advisory;
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
            let plan = store
                .prepare_work_plan(
                    initial.config,
                    &initial.locale,
                    &initial.unit_ids,
                    initial.options,
                )
                .map_err(map_read)?;
            let source = store.work_plan_review_binding(&plan).map_err(map_read)?;
            let checkers = store.work_plan_review_checkers(&plan).map_err(map_read)?;
            let work = host.begin_package_work(
                checkers
                    .iter()
                    .map(|checker| package_lifecycle::binding_package(&checker.binding))
                    .collect(),
            )?;
            Ok((plan, source, checkers, work, host.runtime.generation()))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (plan, source, checkers, work, generation) = captured.await?;
        let selected = request.tool_selection.clone();
        let current_plugins = plugins.clone();
        let tools = io
            .clone()
            .run(CommandStage::ExecutionRead, move || {
                broker::capture_selection(&current_plugins, selected.as_ref())
            })
            .await?;
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
                        store
                            .prepare_work_plan_with_tools(
                                request.config.clone(),
                                &request.locale,
                                &request.unit_ids,
                                plan.options.clone(),
                                tools,
                            )
                            .map_err(map_read)?
                    } else {
                        plan
                    };
                    with_plan_environment_revision(&plugins, &plan, checker_revision, || {
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
                    })
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
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let captured_plugins = state.plugins.clone();
    let initial = request.clone();
    let captured = lease.submit(
        "authorize_work_plan.capture",
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
                broker::require_consent(&plan, initial.tool_execution, Some(&initial.effects))?;
                broker::capture_human_intent(
                    host,
                    &plan,
                    initial.action_id,
                    initial.expires_at.get(),
                    &initial,
                )?;
                let environments =
                    consent_environments(host, store, &plan, &initial.checker_executions)?;
                let work = host.begin_package_work(
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
                let plan = store.work_plan(request.plan_id).map_err(map_recover)?;
                let checker = current_checker_consent(host, store, &plan, receipt.lease)?;
                let checker_revision = checker.as_ref().map(|consent| consent.settings_revision);
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
                let (host, store) = active.execution_parts()?;
                broker::restore_consent(host, store, &plan, &receipt, &initial, &captured_plugins)?;
                return Ok(Err(WorkPlanReceiptView::from(receipt)));
            }
            if initial.command != WorkPlanCommand::Continue {
                return Ok(Ok((None, Vec::new(), None, None)));
            }
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let plan = store.work_plan(initial.plan_id).map_err(map_recover)?;
            broker::require_consent(&plan, initial.tool_execution, None)?;
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
                broker::capture_human_intent(host, &plan, initial.action_id, expiry, &initial)?;
            }
            let environments =
                consent_environments(host, store, &plan, &initial.checker_executions)?;
            let work = host.begin_package_work(
                environments
                    .iter()
                    .map(|(_, checker)| package_lifecycle::binding_package(&checker.binding))
                    .collect(),
            )?;
            Ok(Ok((
                Some(plan),
                environments,
                Some(work),
                Some(host.runtime.generation()),
            )))
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
            checker_runners(io, plugins.clone(), environment, work.clone()).await?;
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
                    if let Some(work) = &work {
                        work.check()?;
                    }
                    let finish = || {
                        if let Some(generation) = generation {
                            let (host, _) = active.execution_parts()?;
                            host.allow_mutation()?;
                            if host.runtime.generation() != generation {
                                return Err(map_recover(ExecutionError::new(
                                    ErrorCode::Unauthorized,
                                    "work-plan-session",
                                )));
                            }
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
                        if let Some(plan) = &plan {
                            let (host, store) = active.execution_parts()?;
                            broker::save_consent(host, store, plan, &receipt).map_err(|_| {
                                CommandError::unknown(CommandStage::ExecutionCancel)
                            })?;
                        } else if let Some(host) = active.execution.as_mut() {
                            host.work_plans.tool_consents.remove(&request.plan_id);
                        }
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
                    match &plan {
                        Some(plan) => with_plan_environment_revision(
                            &plugins,
                            plan,
                            settings_revision,
                            finish,
                        ),
                        None => finish(),
                    }
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
            let work = host.begin_package_work(
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
                    if let Some(tools) = &plan.tools {
                        view.tool_invocations = Some(broker::WorkPlanToolUsage {
                            reserved: store
                                .work_plan_tool_invocations(plan.plan_id)
                                .map_err(map_read)?,
                            limit: tools.max_invocations,
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
    mod broker_tests;
    mod generation_tests;
    mod settings;
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
        round_trip!("requests", "authorize", WorkPlanAuthorizeRequest);
        round_trip!("requests", "start", WorkPlanStartRequest);
        round_trip!("requests", "control", WorkPlanControlRequest);
        round_trip!("requests", "status", WorkPlanStatusRequest);
        round_trip!("requests", "action", WorkPlanActionRequest);
        round_trip!("requests", "protectionRead", WorkProtectionReadRequest);
        round_trip!("requests", "protectionSet", WorkProtectionSetRequest);
        round_trip!("responses", "plan", WorkPlanView);
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
            fixture["toolView"],
            crate::commands::plugins::PluginToolView
        );
        round_trip!(fixture["spec"], tsumugi_core::application::WorkPlanToolSpec);
    }

    type MockWebview = tauri::WebviewWindow<tauri::test::MockRuntime>;

    struct Fixture {
        directory: tempfile::TempDir,
        app: tauri::App<tauri::test::MockRuntime>,
        webview: MockWebview,
        context: Value,
        unit: ExecutionId,
        source_revision: ExecutionId,
        snapshot: ExecutionId,
    }

    fn call(webview: &MockWebview, command: &str, request: Value) -> Result<Value, Value> {
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
            let (unit, source_revision, snapshot) = app.state::<AppState>().sessions.with(move |sessions| {
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
            });
            Self {
                directory,
                app,
                webview,
                context,
                unit,
                source_revision,
                snapshot,
            }
        }

        fn call(&self, command: &str, extra: Value) -> Result<Value, Value> {
            call(&self.webview, command, request(&self.context, extra))
        }

        fn bytes(&self) -> Vec<u8> {
            std::fs::read(self.directory.path().join("project/project.sqlite3")).unwrap()
        }

        fn attempt_count(&self) -> i64 {
            let connection = rusqlite::Connection::open_with_flags(
                self.directory.path().join("project/project.sqlite3"),
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
                let Some(text) = response_text(ordinal, &item) else {
                    last = item;
                    continue;
                };
                let output = json!({"unitId":item["unitId"], "targetLocale":item["targetLocale"], "text":text});
                let response = json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":output.to_string()}}], "usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                    response.len(),
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
            let grant = self.call("authorize_work_plan", json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"effects":effects,"expiresAt":expiry()})).unwrap();
            assert_eq!(self.call("start_work_plan", json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap(), plan["attemptId"]);
            plan
        }
        fn wait_effect(&self, plan: &Value) -> Value {
            let deadline = Instant::now() + Duration::from_secs(5);
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
            let plan = self.call("prepare_work_plan", json!({
                "config":config,"locale":"zh-CN","unitIds":units,"options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null
            })).unwrap();
            let grant = self.call("authorize_work_plan", json!({
                "planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),
                "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"effects":["save-candidate"],"expiresAt":expiry()
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
            let deadline = Instant::now() + Duration::from_secs(5);
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
    fn agent_generation_uses_original_runtime_candidates_and_cumulative_budget() {
        let fixture = Fixture::create();
        let (config, provider) = local_provider_sequence(vec!["根候选", "子候选"], None);
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
        let second = fixture.wait_saved(&generation["attemptId"]);
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
        let exhausted =
            fixture.wait_effect(&json!({"attemptId":exhausted_request["generation"]["attemptId"]}));
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
                assert_eq!(child.envelope().settings, root.envelope().settings);
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
            "expectedGeneration":grant["lease"]["generation"],"command":"pause","confirmed":false,"checkerExecutions":[],"toolExecution":false
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
                    "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"expiresAt":expiry()
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
    fn agent_generation_reuses_independent_checks_and_original_selection_service() {
        let fixture = Fixture::create();
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
        let second = fixture.wait_effect(&json!({"attemptId":request["generation"]["attemptId"]}));
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
        assert_eq!(receipt["policyVersion"], "checked-selection-2");
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
            "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"expiresAt":expiry()});
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
            "confirmed":false,"checkerExecutions":[],"toolExecution":false,"expiresAt":null}),
            )
            .unwrap();
        let third = fixture
            .call(
                "control_work_plan",
                json!({"planId":plan["planId"],
            "actionId":ExecutionId::new(),"expectedGeneration":paused["lease"]["generation"],
            "command":"continue","confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"expiresAt":expiry()}),
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
        fixture.call("control_work_plan", json!({"actionId":ExecutionId::new(),"planId":plan["planId"],"expectedGeneration":"1","command":"pause","confirmed":false,"checkerExecutions":[],"toolExecution":false,"expiresAt":null})).unwrap();
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
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false, "effects":["save-candidate"], "expiresAt":expiry(),
            "semanticAnswer":"yes"
        })).is_err());
        assert!(fixture.call("authorize_work_plan", json!({
            "planId":prepared["planId"], "digest":prepared["digest"], "actionId":ExecutionId::new(),
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false, "effects":["save-candidate"], "expiresAt":expiry()
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
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false, "effects":["save-candidate"], "expiresAt":expiry()
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
        let paused = fixture
            .call(
                "control_work_plan",
                json!({
                    "planId":prepared["planId"], "actionId":ExecutionId::new(),
                    "expectedGeneration":receipt["lease"]["generation"], "command":"pause",
                    "confirmed":false, "checkerExecutions":[],"toolExecution":false, "expiresAt":null
                }),
            )
            .unwrap();
        assert_eq!(paused["state"], "paused");
        assert!(fixture.call("start_work_plan", start).is_err());
        let resume = json!({
            "planId":prepared["planId"], "actionId":ExecutionId::new(),
            "expectedGeneration":paused["lease"]["generation"], "command":"continue",
            "confirmed":true, "checkerExecutions":checker_keys(&prepared),"toolExecution":false, "expiresAt":expiry()
        });
        let resumed = fixture.call("control_work_plan", resume.clone()).unwrap();
        assert_eq!(resumed["state"], "active");
        assert!(resumed["parentTask"].is_string());
        assert_ne!(resumed["attemptId"], prepared["attemptId"]);
        assert_eq!(fixture.attempt_count(), count + 1);
        assert_eq!(fixture.call("control_work_plan", resume).unwrap(), resumed);
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
                    "confirmed":false, "checkerExecutions":[],"toolExecution":false, "expiresAt":null
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
