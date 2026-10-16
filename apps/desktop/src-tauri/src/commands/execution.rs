use super::*;
use std::{
    collections::BTreeMap,
    sync::mpsc,
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tsumugi_core::{RecoveryPlan, TaskView, execution::*};
use tsumugi_plugin_sdk as sdk;
pub(super) mod mcp_retrieval;
mod package_lifecycle;
use package_lifecycle::{PackageControl, PackageWork, PackageWorkState, RetiredQuery};

#[cfg(all(test, target_os = "macos"))]
mod test_fixtures;

macro_rules! handlers {
    ($($extra:path),*) => { tauri::generate_handler![
        super::changes::read_project_changes, super::create_project,super::open_project,super::read_project,super::rename_project,
        super::add_target_locale,super::set_target_locales,super::close_project,
        super::mcp::read_mcp_share_session,super::mcp::prepare_mcp_share,
        super::mcp::authorize_mcp_share,super::mcp::read_mcp_share,super::mcp::revoke_mcp_share,
        super::source_hooks::read_source_maintenance_hook_session,
        super::source_hooks::read_source_maintenance_hook,
        super::source_hooks::stop_source_maintenance_hook,
        super::mcp_retrieval::read_mcp_retrieval_session,
        super::mcp_retrieval::discover_mcp_terms,
        super::mcp_retrieval::read_mcp_retrieval,
        super::mcp_retrieval::prepare_mcp_term_query,
        super::mcp_retrieval::start_mcp_term_query,
        super::mcp_retrieval::stop_mcp_retrieval,
        super::mcp_retrieval::capture_mcp_glossary,
        super::connections::read_model_connections,
        super::connections::change_model_connections,
        super::connections::read_model_connection_action,
        super::connections::resolve_model_connection,
        super::plugins::read_plugin_inventory,
        super::plugins::defaults::install_plugin_defaults,
        super::plugins::packages::select_plugin_package, super::plugins::packages::install_plugin_package,
        super::plugins::packs::select_plugin_pack, super::plugins::packs::install_plugin_pack,
        super::plugins::repositories::select_plugin_repository, super::plugins::repositories::read_plugin_repositories,
        super::plugins::repositories::refresh_plugin_repository, super::plugins::repositories::resume_plugin_repository,
        super::plugins::repositories::install_repository_packages,
        super::plugins::packages::cleanup::remove_plugin_approval, super::plugins::packages::cleanup::uninstall_plugin_package,
        super::plugins::packages::set_plugin_enabled, super::plugins::packages::read_plugin_package,
        super::plugins::packages::lookup_plugin_capability,
        super::plugins::sources::read_plugin_source, super::plugins::builds::read_plugin_build,
        super::plugins::translations::read_plugin_translation,
        super::plugins::tools::read_plugin_tool,
        super::plugins::generation::read_plugin_generation_component,
        super::plugins::reviews::text::read_plugin_text_review, super::plugins::reviews::text::read_plugin_text_reviews,
        super::plugins::runtimes::install_plugin_runtime, super::plugins::runtimes::lookup_plugin_runtime,
        super::plugins::runtimes::set_plugin_native_host_approval,
        list_execution_tasks,read_execution_task_activity,read_execution_task,read_execution_attempt,read_execution_output,
        cancel_execution_task,recover_execution,continue_execution,read_execution_continuation,read_execution_continuations,read_execution_task_view,prepare_execution_adoption,adopt_execution,
        read_execution_receipt,execution_status,quiesce_execution,create_execution_identity,
        tools::prepare_plugin_tool,tools::start_plugin_tool,tools::discard_plugin_tool_preflight,
        crate::commands::plugins::application::read_application_plugin_instance,
        crate::commands::plugins::application::stop_application_plugin_instance,
        crate::commands::plugins::application::stop_application_plugin_instances,
        crate::commands::plugins::application::resume_application_plugin_instances,
        source::plugin::select_plugin_source,source::plugin::preflight_plugin_source,source::plugin::start_plugin_source,
        source::plugin::prepare_source_check,source::plugin::start_source_check,source::plugin::finish_source_check,
        source::cancel_source_capture,source::read_source_preview,source::read_source_content,source::read_source_comparison,
        source::read_content_scope,source::read_source_context,source::prepare_source_adoption,
        source::read_source_history,source::read_source_history_content,source::read_source_lineage,
        source::estimate_source_update,source::read_source_impact,
        source::plugin_translation::read_plugin_translation_source,source::plugin_translation::select_plugin_translation,
        source::plugin_translation::list_plugin_translation_files,source::plugin_translation::preflight_plugin_translation,
        source::plugin_translation::start_plugin_translation,source::plugin_translation::prepare_translation_check,
        source::plugin_translation::start_translation_check,source::plugin_translation::finish_translation_check,
        source::plugin_translation::prepare_translation_projection,source::plugin_translation::start_translation_projection,
        source::translation::read_translation_preview,
        source::translation::prepare_translation_adoption,source::translation::read_translation_history,
        source::translation::read_translation_action,
        source::translation::save_translation_revision,source::translation::select_translation_revision,
        source::translation::decide_translation_candidate,source::translation::read_translation_candidate_action,
        resource::preview_tmx_exchange,resource::preview_tbx_exchange,resource::choose_resource_file,resource::list_resource_captures,resource::read_resource_preview,resource::decide_resource_entry,
        resource::read_correction_term_basis,resource::capture_correction_term,resource::read_correction_term_action,resource::read_resource_decision_action,
        resource::save_term,resource::read_terms,resource::read_term_history,resource::resolve_terms,
        resource::read_context_revision,resource::save_context,resource::capture_context,
        resource::decide_context_fact,resource::read_context_fact_decisions,resource::read_context_fact_action,resource::read_context_fact_history,
        resource::read_context_capture,resource::tm_suggestions,resource::resource_impacts,
        review::read_review_findings,review::read_review_finding_action,review::write_review_finding,
        review::read_review_page,review::read_review_target,review::read_review_history,review::write_review_decision,
        review::read_review_summary_page,review::read_review_editor_snapshot,review::read_review_neighbor,review::capture_review_scope,
        review::plugin::prepare_review_checks,review::plugin::run_review_checks,review::cancel_review_checks,review::waive_review_issue,review::allow_source_fallback,
        review::read_review_work,review::read_review_eligibility,
        release::read_delivery_action,release::list_releases,release::choose_delivery_folder,
        release::preview_delivery,release::export_release,release::list_deliveries,
        release::reconcile_delivery,ai::preview_ai_translation,ai::start_ai_translation,ai::read_ai_translation,ai::retry_work_plan_effect,
        release::plugin::prepare_plugin_build,release::plugin::start_plugin_build,
        release::plugin::read_saved_plugin_build,
        release::plugin::prepare_artifact_check,release::plugin::start_artifact_check,
        release::plugin::finish_artifact_check,release::plugin::cancel_plugin_build_preparation,
        release::plugin::workflow::read_artifact_check_workflow_session,
        release::plugin::workflow::prepare_artifact_check_workflow,
        release::plugin::workflow::start_artifact_check_workflow,
        release::plugin::workflow::read_artifact_check_workflow,
        release::plugin::workflow::stop_artifact_check_workflow,
        arena::preview_arena_translation,arena::start_arena_translation,arena::read_arena_translation,
        arena::create_arena_comparison,arena::read_arena_comparison,arena::list_arena_comparisons,
        arena::reveal_arena_identity,arena::save_arena_merge,
        strategy::capture_context_strategy,strategy::read_context_strategy,strategy::list_context_strategies,
        strategy::capture_strategy_suite,strategy::prepare_strategy_evaluation,strategy::start_strategy_evaluation,
        strategy::read_strategy_evaluation,strategy::list_strategy_evaluations,
        strategy::read_strategy_evaluation_start,
        strategy::save_strategy_evaluation_candidate,
        strategy::record_strategy_judgment,strategy::promote_context_strategy,strategy::withdraw_context_strategy,
        strategy::read_context_strategy_default,strategy::list_context_strategy_defaults,strategy::read_strategy_action,
        review::plugin::prepare_strategy_evaluation_checks,review::plugin::run_strategy_evaluation_checks,
        work_plans::read_maintenance_assessment,work_plans::prepare_work_plan,work_plans::authorize_work_plan,work_plans::start_work_plan,
        work_plans::generation::prepare_work_plan_generation_component,
        work_plans::generation::start_work_plan_generation_component,
        work_plans::generation::discard_work_plan_generation_component,
        work_plans::agent::open_work_plan_agent_scope,
        work_plans::agent::prepare_work_plan_agent_generation,work_plans::agent::start_work_plan_agent_generation,
        work_plans::agent::delegate_work_plan_agent_scope,
        work_plans::agent::reconcile_work_plan_agent_execution,
        work_plans::agent::read_work_plan_agent_generation_attempt,work_plans::agent::read_work_plan_agent_generation_output,
        work_plans::broker::prepare_work_plan_agent_tool,work_plans::broker::start_work_plan_agent_tool,
        work_plans::broker::read_work_plan_agent_tool_attempt,work_plans::broker::read_work_plan_agent_tool_output,
        work_plans::guidance::read_work_plan_agent_guidance,work_plans::guidance::read_work_plan_agent_skill,
        work_plans::guidance::read_work_plan_agent_resource,
        work_plans::control_work_plan,work_plans::read_work_plan_status,work_plans::read_work_plan_action,
        work_plans::read_work_protection,work_plans::set_work_protection,$($extra),*
    ] };
}
pub(super) fn handler<R: tauri::Runtime>()
-> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    #[cfg(feature = "execution-test-host")]
    {
        handlers!(
            seed_execution_fixture,
            source::select_source,
            source::select_webvtt_source,
            source::read_source_integration,
            source::read_webvtt_integration,
            source::preflight_source,
            source::start_source_import,
            source::translation::list_translation_files,
            source::translation::preflight_translation,
            source::translation::start_translation_import,
            release::start_locale_build,
            release::read_locale_build_attempt
        )
    }
    #[cfg(all(test, not(feature = "execution-test-host")))]
    {
        handlers!(
            source::select_source,
            source::select_webvtt_source,
            source::read_source_integration,
            source::read_webvtt_integration,
            source::preflight_source,
            source::start_source_import,
            source::translation::list_translation_files,
            source::translation::preflight_translation,
            source::translation::start_translation_import,
            release::start_locale_build,
            release::read_locale_build_attempt
        )
    }
    #[cfg(not(any(test, feature = "execution-test-host")))]
    {
        production_handler()
    }
}

pub(super) fn production_handler<R: tauri::Runtime>()
-> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    handlers!()
}

#[cfg(feature = "execution-test-host")]
pub(super) fn initialize_test_host(state: &AppState) -> Result<(), CommandError> {
    let args: Vec<String> = std::env::args().collect();
    let Some(index) = args.iter().position(|arg| arg == "--fixture-directory") else {
        return Ok(());
    };
    let destination = args
        .get(index + 1)
        .ok_or_else(|| CommandError::invalid_input(CommandStage::Create, Some("destination")))?;
    let mode = args
        .iter()
        .position(|arg| arg == "--fixture-mode")
        .and_then(|index| args.get(index + 1).map(String::as_str))
        .unwrap_or("partial");
    let mode = match mode {
        "success" => test_support::FixtureMode::Success,
        "partial" => test_support::FixtureMode::Partial,
        "hold" => test_support::FixtureMode::Hold,
        "unknown" => test_support::FixtureMode::Unknown,
        _ => {
            return Err(CommandError::invalid_input(
                CommandStage::Create,
                Some("mode"),
            ));
        }
    };
    let destination = destination.clone();
    state.sessions.with(move |sessions| {
        let view = sessions.create(CreateProjectRequest {
            destination: destination.clone(),
            display_name: "Execution test project".into(),
            source_locale: "en-US".into(),
            target_locales: vec!["zh-CN".into()],
        })?;
        let active = sessions.active_mut(&view.session_token, CommandStage::ExecutionRecover)?;
        let (host, store) = active.execution_parts()?;
        let input = test_support::input(
            store,
            mode,
            1500,
            args.iter().any(|arg| arg == "--fixture-grouped"),
        )
        .map_err(map_recover)?;
        host.runtime.submit(store, &input).map_err(map_recover)
    })
}

pub(super) struct ExecutionHost {
    runtime: ExecutionRuntime,
    handlers: BTreeMap<String, Arc<dyn AdoptionHandler>>,
    queries: Vec<QueryJob>,
    retired_queries: Vec<RetiredQuery>,
    package_controls: BTreeMap<ExecutionId, PackageControl>,
    package_work: Vec<std::sync::Weak<PackageWorkState>>,
    quiescing: bool,
    last_error: Option<CommandError>,
    source: source::SourceSession,
    release: release::ReleaseSession,
    ai: ai::AiSession,
    review: review::ReviewSession,
    arena: arena::ArenaSession,
    strategy: strategy::StrategySession,
    work_plans: work_plans::WorkPlanSession,
    tools: tools::ToolSession,
    mcp_runner: Arc<mcp_retrieval::McpRunner>,
    plugin_registrations: Vec<PluginExecutionBinding>,
    service_factory: Option<Arc<dyn tsumugi_plugin_host::core::ProjectServiceFactory>>,
}
struct QueryJob {
    query: Arc<OutcomeQuery>,
    receiver: mpsc::Receiver<Result<QueryOutcome, ExecutionError>>,
    thread: JoinHandle<()>,
    started: Instant,
    pending_outcome: Option<QueryOutcome>,
}
impl ExecutionHost {
    pub(super) fn allow_mcp_capture(&self) -> Result<(), CommandError> {
        self.allow_mutation()
    }
    pub(super) fn is_quiescing(&self) -> bool {
        self.quiescing
    }
    fn new(store: &ProjectStore) -> Result<Self, CommandError> {
        #[allow(unused_mut)]
        let mut host = Self {
            runtime: ExecutionRuntime::new(store).map_err(map_read)?,
            handlers: BTreeMap::new(),
            queries: Vec::new(),
            retired_queries: Vec::new(),
            package_controls: BTreeMap::new(),
            package_work: Vec::new(),
            quiescing: false,
            last_error: None,
            source: source::SourceSession::default(),
            release: release::ReleaseSession::default(),
            ai: ai::AiSession::default(),
            review: review::ReviewSession::default(),
            arena: arena::ArenaSession::default(),
            strategy: strategy::StrategySession::default(),
            work_plans: work_plans::WorkPlanSession::default(),
            tools: tools::ToolSession::default(),
            mcp_runner: Arc::default(),
            plugin_registrations: Vec::new(),
            service_factory: None,
        };
        host.runtime
            .register(host.mcp_runner.clone())
            .map_err(map_read)?;
        host.handlers.insert(
            tsumugi_core::application::MCP_TERM_QUERY_OPERATION.into(),
            Arc::new(tsumugi_core::McpTermQueryAdoptionHandler),
        );
        #[cfg(any(test, feature = "execution-test-host"))]
        host.runtime
            .register_read_only(Arc::new(tsumugi_core::content::SourceRunner))
            .map_err(map_read)?;
        #[cfg(any(test, feature = "execution-test-host"))]
        host.runtime
            .register_read_only(Arc::new(tsumugi_core::content::TranslationRunner))
            .map_err(map_read)?;
        host.runtime
            .register_read_only(Arc::new(tsumugi_core::content::TranslationProjectionRunner))
            .map_err(map_read)?;
        #[cfg(any(test, feature = "execution-test-host"))]
        host.runtime
            .register_read_only(Arc::new(tsumugi_core::content::BuildRunner))
            .map_err(map_read)?;
        #[cfg(any(test, feature = "execution-test-host"))]
        host.runtime
            .register_read_only(Arc::new(tsumugi_core::content::WebvttSourceRunner))
            .map_err(map_read)?;
        #[cfg(any(test, feature = "execution-test-host"))]
        host.runtime
            .register_read_only(Arc::new(tsumugi_core::content::WebvttBuildRunner))
            .map_err(map_read)?;
        let provider_service = Arc::new(tsumugi_core::ai::provider::ProviderService::default());
        host.runtime
            .register_with_policy(
                Arc::new(tsumugi_core::ai::AiRunner::with_service(
                    provider_service.clone(),
                )),
                tsumugi_core::execution::RecoveryPolicy::ExternalUnknown,
            )
            .map_err(map_read)?;
        host.handlers.insert(
            tsumugi_core::ai::OPERATION.into(),
            Arc::new(tsumugi_core::AiAdoptionHandler),
        );
        host.runtime
            .register_with_policy(
                Arc::new(tsumugi_core::ai::arena::ArenaRunner::with_service(
                    provider_service,
                )),
                tsumugi_core::execution::RecoveryPolicy::ExternalUnknown,
            )
            .map_err(map_read)?;
        host.handlers.insert(
            tsumugi_core::ai::arena::OPERATION.into(),
            Arc::new(tsumugi_core::ArenaAdoptionHandler),
        );
        host.handlers.insert(
            tsumugi_core::content::OPERATION.into(),
            Arc::new(tsumugi_core::content::SourceAdoptionHandler),
        );
        host.handlers.insert(
            tsumugi_core::content::TRANSLATION_OPERATION.into(),
            Arc::new(tsumugi_core::TranslationAdoptionHandler),
        );
        host.handlers.insert(
            tsumugi_core::content::BUILD_OPERATION.into(),
            Arc::new(tsumugi_core::ReleaseAdoptionHandler),
        );
        #[cfg(feature = "execution-test-host")]
        {
            host.runtime
                .register_read_only(Arc::new(test_support::ControlledRunner))
                .map_err(map_read)?;
            host.handlers.insert(
                "sample-update".into(),
                Arc::new(test_support::SampleHandler),
            );
        }
        Ok(host)
    }
    fn active(&self, store: &ProjectStore) -> Result<bool, CommandError> {
        Ok(self.quiescing
            || self.package_lifecycle_active()
            || self.package_work_active()
            || self.source.is_active()
            || self.release.is_active()
            || self.ai.active()
            || self.review.active()
            || self.tools.active()
            || self.work_plans.generation_preparation_active()
            || !self.queries.is_empty()
            || !self.retired_queries.is_empty()
            || self.runtime.has_active_work(store).map_err(map_read)?)
    }
    fn finish_quiesce(&mut self, store: &mut ProjectStore) -> Result<(), ExecutionError> {
        if self.package_lifecycle_active() {
            return Err(ExecutionError::new(
                ErrorCode::Busy,
                "package-lifecycle-active",
            ));
        }
        if self.package_work_active() {
            return Err(ExecutionError::new(
                ErrorCode::Busy,
                "package-work-draining",
            ));
        }
        if self.release.delivery_is_active() {
            return Err(ExecutionError::new(ErrorCode::Busy, "delivery-active"));
        }
        if self.release.plugin.is_active() {
            return Err(ExecutionError::new(
                ErrorCode::Busy,
                "artifact-workflow-draining",
            ));
        }
        if self.review.active() {
            return Err(ExecutionError::new(ErrorCode::Busy, "review-check-active"));
        }
        if self.ai.active() {
            return Err(ExecutionError::new(ErrorCode::Busy, "work-effect-active"));
        }
        // Retiring a query revokes its reply path, not its runner/file lifetime.
        // Never rotate the runtime or permit project close while it still runs.
        if !self.retired_queries.is_empty() {
            return Err(ExecutionError::new(
                ErrorCode::Busy,
                "outcome-query-draining",
            ));
        }
        self.runtime.finish_quiesce(store)?;
        self.package_controls.clear();
        self.quiescing = false;
        Ok(())
    }
    fn tick(&mut self, store: &mut ProjectStore) -> Result<(), CommandError> {
        self.poll_queries(store)?;
        release::plugin::workflow::tick(self, store)?;
        self.mcp_runner
            .reap(store, &self.runtime)
            .map_err(map_read)?;
        let workflow_authority = release::plugin::workflow::prepare_runtime_tick(self, store)?;
        let review_authority = self.review.prepare_runtime_tick(store, &mut self.runtime)?;
        self.review.tick(store, &mut self.runtime)?;
        let checker_consent = self.ai.prepare_runtime_tick(store, &mut self.runtime)?;
        let mut dispatch = || self.runtime.tick(store).map_err(map_read);
        if let (
            Some((workflow_plugins, workflow_revision)),
            Some((review_plugins, review_revision)),
        ) = (&workflow_authority, &review_authority)
        {
            if workflow_revision != review_revision
                || !Arc::ptr_eq(workflow_plugins, review_plugins)
            {
                return Err(review::checkers::stale());
            }
        }
        match (workflow_authority.or(review_authority), checker_consent) {
            (Some((plugins, revision)), consent) => {
                if consent.as_ref().is_some_and(|consent| {
                    consent.settings_revision != revision
                        || !Arc::ptr_eq(&consent.plugins, &plugins)
                }) {
                    return Err(review::checkers::stale());
                }
                plugins.with_environment_revision(revision, dispatch)?;
            }
            (None, Some(consent)) => consent.with_current_environment(dispatch)?,
            (None, None) => dispatch()?,
        }
        release::plugin::workflow::tick(self, store)?;
        self.ai.tick(store, &mut self.runtime);
        self.ai
            .release_terminal_service_origins(store, &mut self.runtime)
            .map_err(map_recover)?;
        if self.quiescing {
            match self.finish_quiesce(store) {
                Ok(()) => {}
                Err(error) if error.code == ErrorCode::Busy => {}
                Err(error) => return Err(map_recover(error)),
            }
        }
        Ok(())
    }
    fn poll_queries(&mut self, store: &mut ProjectStore) -> Result<(), CommandError> {
        let mut remaining = Vec::new();
        for query in self.retired_queries.drain(..) {
            if query.thread.is_finished() {
                // Join completes the thread's cleanup; dropping a finished
                // handle alone would detach its final lifetime boundary.
                let _ = query.thread.join();
            } else {
                remaining.push(query);
            }
        }
        self.retired_queries = remaining;
        let mut index = 0;
        while index < self.queries.len() {
            if let Some(outcome) = self.queries[index].pending_outcome.as_ref() {
                let result = self.runtime.apply_query_outcome(
                    store,
                    &self.queries[index].query,
                    outcome.clone(),
                );
                if let Err(error) = &result {
                    if matches!(
                        error.code,
                        ErrorCode::Busy | ErrorCode::StorageFailed | ErrorCode::OutcomeUnknown
                    ) {
                        // Retain the same evidence across storage reconciliation.
                        return Err(map_recover(error.clone()));
                    }
                }
                let job = self.queries.remove(index);
                self.retired_queries.push(RetiredQuery::new(job));
                result.map_err(map_recover)?;
                continue;
            }
            let result = self.queries[index].receiver.try_recv();
            let expired = self.queries[index].started.elapsed() >= Duration::from_secs(60);
            match result {
                Ok(Ok(outcome)) => {
                    self.queries[index].pending_outcome = Some(outcome);
                }
                Ok(Err(error)) => {
                    let job = self.queries.remove(index);
                    self.retired_queries.push(RetiredQuery::new(job));
                    return Err(map_recover(error));
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    let job = self.queries.remove(index);
                    self.retired_queries.push(RetiredQuery::new(job));
                    return Err(CommandError::unknown(CommandStage::ExecutionRecover));
                }
                Err(mpsc::TryRecvError::Empty) if expired => {
                    let job = self.queries.remove(index);
                    self.retired_queries.push(RetiredQuery::new(job));
                    return Err(CommandError::unknown(CommandStage::ExecutionRecover));
                }
                Err(mpsc::TryRecvError::Empty) => index += 1,
            }
        }
        Ok(())
    }
    fn begin_quiesce(&mut self, store: &mut ProjectStore) -> Result<(), CommandError> {
        if self.package_lifecycle_active() {
            return Err(map_recover(ExecutionError::new(
                ErrorCode::Busy,
                "package-lifecycle-active",
            )));
        }
        // Persist already received evidence before revoking late callbacks.
        // Storage failure retains the session and pending evidence for retry.
        self.poll_queries(store)?;
        self.quiescing = true;
        for work in self
            .package_work
            .iter()
            .filter_map(std::sync::Weak::upgrade)
        {
            work.stop();
        }
        self.source.stop();
        self.tools.stop();
        self.review.stop();
        self.strategy.stop();
        self.ai.stop();
        self.work_plans.stop();
        self.release.stop();
        // Per-slot revocation requires the still-owned live runtime generation.
        // Drain admitted checker grants before Core withdraws the whole epoch.
        self.review.prepare_runtime_tick(store, &mut self.runtime)?;
        self.ai.prepare_runtime_tick(store, &mut self.runtime)?;
        for job in self.queries.drain(..) {
            self.retired_queries.push(RetiredQuery::new(job));
        }
        match self.runtime.begin_quiesce(store) {
            Ok(()) => Ok(()),
            Err(error) if error.code == ErrorCode::Busy => Ok(()),
            Err(error) => Err(map_execution(error, CommandStage::ExecutionQuiesce)),
        }
    }
    fn allow_mutation(&self) -> Result<(), CommandError> {
        if self.quiescing {
            Err(CommandError::simple(
                CommandErrorCode::Busy,
                CommandStage::ExecutionRecover,
            ))
        } else {
            Ok(())
        }
    }
    fn register_plugin(
        &mut self,
        runner: Arc<tsumugi_plugin_host::core::RunnerProxy>,
        binding: PluginExecutionBinding,
    ) -> Result<(), ExecutionError> {
        self.allow_package(&package_lifecycle::binding_package(&binding))?;
        // One capability/environment registration serves request profiles.
        // Core validates each fixed request's profile independently.
        if self.plugin_registrations.iter().any(|previous| {
            previous.capability == binding.capability
                && previous.environment == binding.environment
                && previous.application_scope == binding.application_scope
        }) {
            return Ok(());
        }
        if self.plugin_registrations.len() >= 128 {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "plugin-registration-limit",
            ));
        }
        let runner = if binding.capability.declaration.permissions.iter().any(|permission| {
            matches!(permission, tsumugi_plugin_sdk::PermissionRequest::ProjectService { contract }
                if *contract == tsumugi_plugin_sdk::generation_service_contract())
        }) {
            let factory = self.service_factory.as_ref().ok_or_else(|| {
                ExecutionError::new(ErrorCode::Unauthorized, "project-service-session")
            })?;
            Arc::new((*runner).clone().with_service_factory(factory.clone()))
        } else {
            runner
        };
        self.runtime.register(runner)?;
        self.plugin_registrations.push(binding);
        Ok(())
    }
}
impl SessionManager {
    pub(super) fn begin_plugin_cleanup(
        &mut self,
        action: ExecutionId,
        package: plugins::PluginPackageRequest,
    ) -> Result<(), CommandError> {
        if let Some(context) = &self.services {
            context
                .plugins
                .begin_application_cleanup(action, &package)?;
        }
        if let Some(active) = self.active.as_mut() {
            let (host, store) = active.execution_parts()?;
            host.begin_package_cleanup(store, action, package)?;
        }
        Ok(())
    }
    pub(super) fn finish_plugin_cleanup(
        &mut self,
        action: ExecutionId,
    ) -> Result<(), CommandError> {
        if let Some(context) = &self.services {
            context.plugins.finish_application_cleanup(action)?;
        }
        if let Some(active) = self.active.as_mut() {
            let (host, store) = active.execution_parts()?;
            host.finish_package_cleanup(store, action)?;
        }
        Ok(())
    }
    pub(super) fn complete_plugin_cleanup(
        &mut self,
        action: ExecutionId,
        package: &plugins::PluginPackageRequest,
    ) -> Result<(), CommandError> {
        if let Some(context) = &self.services {
            context
                .plugins
                .complete_application_cleanup(action, package)?;
        }
        if let Some(host) = self
            .active
            .as_mut()
            .and_then(|active| active.execution.as_mut())
        {
            host.complete_package_cleanup_if_present(action, package)?;
        }
        Ok(())
    }
}

impl ActiveSession {
    pub(super) fn execution_status_view(&mut self) -> Result<RuntimeStatus, CommandError> {
        let (host, store) = self.execution_parts()?;
        Ok(RuntimeStatus {
            active: host.active(store)?,
            quiescing: host.quiescing,
            query_count: host.queries.len() as u32,
            error: host.last_error.clone(),
        })
    }
    fn execution_parts(&mut self) -> Result<(&mut ExecutionHost, &mut ProjectStore), CommandError> {
        if self.execution.is_none() {
            let mut host = ExecutionHost::new(&self.store)?;
            if let Some(context) = &self.services {
                host.service_factory =
                    Some(Arc::new(work_plans::generation::GenerationFactory::new(
                        context.clone(),
                        self.token.clone(),
                        host.runtime.generation(),
                        ExecutionId::parse(
                            &self
                                .store
                                .metadata()
                                .map_err(|error| {
                                    map_persistence_error(error, CommandStage::ExecutionRead)
                                })?
                                .project_id()
                                .to_string(),
                        )
                        .map_err(map_read)?,
                    )));
            }
            self.execution = Some(host);
        }
        Ok((
            self.execution.as_mut().expect("initialized"),
            &mut self.store,
        ))
    }
    pub(super) fn pause_idle_automation(
        &mut self,
        stage: CommandStage,
    ) -> Result<(), CommandError> {
        self.ensure_execution_idle(stage)?;
        self.store
            .pause_active_work_plans()
            .map_err(|error| map_execution(error, stage))
    }
    pub(super) fn ensure_execution_idle(&self, stage: CommandStage) -> Result<(), CommandError> {
        if let Some(host) = &self.execution {
            if host.active(&self.store)? {
                return Err(CommandError::simple(CommandErrorCode::Busy, stage));
            }
        }
        Ok(())
    }
}

/// The clock only holds the session during bounded polling. Producers and
/// outcome queries own no store, session, or application handle.
pub(super) fn tick_sessions(sessions: &mut SessionManager) {
    if let Some(active) = sessions.active.as_mut() {
        if !active.store.is_reconciling() {
            if let Some(host) = active.execution.as_mut() {
                if let Err(error) = host.tick(&mut active.store) {
                    host.last_error = Some(error);
                }
            }
        }
    }
}

pub(super) fn map_execution(error: ExecutionError, stage: CommandStage) -> CommandError {
    let code = match error.code {
        ErrorCode::InvalidInput => CommandErrorCode::InvalidInput,
        ErrorCode::LimitExceeded => CommandErrorCode::LimitExceeded,
        ErrorCode::ResultMismatch => CommandErrorCode::ResultMismatch,
        ErrorCode::OutputInvalid => CommandErrorCode::OutputInvalid,
        ErrorCode::DependencyConflict => CommandErrorCode::DependencyConflict,
        ErrorCode::Cancelled => CommandErrorCode::Cancelled,
        ErrorCode::OutcomeUnknown => CommandErrorCode::OutcomeUnknown,
        ErrorCode::Unauthorized => CommandErrorCode::PermissionDenied,
        ErrorCode::Busy => CommandErrorCode::Busy,
        ErrorCode::StorageFailed => CommandErrorCode::StorageFailed,
        ErrorCode::CorruptLedger => CommandErrorCode::CorruptProject,
    };
    let mut mapped = CommandError::simple(code, stage);
    mapped.recovery_required = code == CommandErrorCode::OutcomeUnknown;
    mapped.reason = Some(error.stage);
    mapped.item_ids = error.item_ids;
    mapped.conflict = error.conflict;
    mapped.report("execution", ExecutionId::new())
}
fn map_read(error: ExecutionError) -> CommandError {
    map_execution(error, CommandStage::ExecutionRead)
}
fn map_recover(error: ExecutionError) -> CommandError {
    map_execution(error, CommandStage::ExecutionRecover)
}
fn map_adopt(error: ExecutionError) -> CommandError {
    map_execution(error, CommandStage::ExecutionAdopt)
}

macro_rules! request {
    ($(#[$schema:meta])* $name:ident { $($(#[$attribute:meta])* $field:ident : $kind:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(rename_all="camelCase", deny_unknown_fields)]
        $(#[$schema])*
        pub struct $name { pub session_token:String, pub project_id:ExecutionId, $($(#[$attribute])* pub $field:$kind,)* }
    }
}
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginStartRequest {
        attempt_id: ExecutionId,
        input_digest: String,
        grant_id: ExecutionId,
        expires_at_ms: UnsignedDecimal,
        unsandboxed_execution: bool
    }
);
pub(super) mod ai;
pub(super) mod ai_wire;
pub(super) mod arena;
pub(super) mod release;
pub(super) mod resource;
pub(super) mod review;
#[cfg(test)]
pub(super) use review::ComputeProbe;
pub(super) mod source;
pub(super) mod strategy;
pub(super) mod tools;
pub(super) mod work_plans;
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SessionRequest {}
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ListRequest {
        after: Revision,
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TaskActivityRequest {
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TaskRequest {
        task_id: ExecutionId,
        after: Revision,
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AttemptRequest {
        attempt_id: ExecutionId,
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        offset: u32,
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    OutputRequest {
        attempt_id: ExecutionId,
        result_id: ExecutionId
    }
);

/// Read-only display projection. The stored ResultEnvelope remains unchanged.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionOutputView {
    #[serde(flatten)]
    pub result: ResultEnvelope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_failure: Option<sdk::SourceExtractionError>,
}
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CancelRequest {
        task_id: ExecutionId,
        request_id: ExecutionId
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] RecoveryRequest { attempt_id:ExecutionId, unit_id:ExecutionId, action:RecoveryAction, item_ids:Vec<ExecutionId> });
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContinuationRequest {
        action: ContinuationAction
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContinuationReadRequest {
        action_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContinuationListRequest {
        source_attempt_id: ExecutionId,
        after: Revision,
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TaskViewRequest {
        task_id: ExecutionId
    }
);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContinuationPage {
    pub receipts: Vec<ContinuationReceipt>,
    pub next: Option<Revision>,
}

request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] PrepareRequest { attempt_id:ExecutionId, unit_id:ExecutionId, action_id:ExecutionId, result_ids:Vec<ExecutionId> });
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AdoptRequest {
        action_id: ExecutionId
    }
);

#[cfg(feature = "execution-test-host")]
request!(FixtureRequest {
    mode: test_support::FixtureMode,
    delay_ms: u32,
    grouped: bool
});
#[cfg(feature = "execution-test-host")]
#[tauri::command]
pub async fn seed_execution_fixture(
    state: State<'_, AppState>,
    request: FixtureRequest,
) -> Result<ExecutionId, CommandError> {
    state
        .sessions
        .run(
            "seed_execution_fixture",
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
                let input =
                    test_support::input(store, request.mode, request.delay_ms, request.grouped)
                        .map_err(map_recover)?;
                host.runtime.submit(store, &input).map_err(map_recover)?;
                Ok(input.envelope().attempt_id)
            },
        )
        .await
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct RuntimeStatus {
    pub active: bool,
    pub quiescing: bool,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
    pub query_count: u32,
    pub error: Option<CommandError>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AttemptSummary {
    pub attempt_id: ExecutionId,
    pub sequence: Revision,
}
pub use tsumugi_core::{AttemptDetail, ItemView};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct RecoveryView {
    pub attempt_id: ExecutionId,
    pub query_started: bool,
}

pub(super) fn authorized<'a>(
    sessions: &'a mut SessionManager,
    token: &str,
    project: ExecutionId,
    stage: CommandStage,
) -> Result<&'a mut ActiveSession, CommandError> {
    let active = sessions.active_mut(token, stage)?;
    let metadata = active
        .store
        .metadata()
        .map_err(|e| map_persistence_error(e, stage))?;
    if metadata.project_id().to_string() != project.to_string() {
        return Err(CommandError::simple(
            CommandErrorCode::SessionInvalid,
            stage,
        ));
    }
    Ok(active)
}

#[tauri::command]
pub async fn create_execution_identity(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<ExecutionId, CommandError> {
    state
        .sessions
        .run(
            "create_execution_identity",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                Ok(ExecutionId::new())
            },
        )
        .await
}

#[tauri::command]
pub async fn execution_status(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<RuntimeStatus, CommandError> {
    state
        .sessions
        .run(
            "execution_status",
            CommandStage::ExecutionRead,
            move |sessions| {
                let hook_active = sessions.source_hooks.is_active();
                let retrieval_active = sessions.mcp_retrieval.active();
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                Ok(RuntimeStatus {
                    active: host.active(store)? || hook_active || retrieval_active,
                    quiescing: host.quiescing,
                    query_count: host.queries.len() as u32,
                    error: host.last_error.clone(),
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn list_execution_tasks(
    state: State<'_, AppState>,
    request: ListRequest,
) -> Result<Vec<TaskView>, CommandError> {
    state
        .sessions
        .run(
            "list_execution_tasks",
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
                    .execution_tasks(request.after, request.limit)
                    .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_execution_task_activity(
    state: State<'_, AppState>,
    request: TaskActivityRequest,
) -> Result<tsumugi_core::TaskActivity, CommandError> {
    state
        .sessions
        .run(
            "read_execution_task_activity",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                match active.execution.as_ref() {
                    Some(host) => host.runtime.task_activity(&active.store, request.limit),
                    None => active.store.execution_task_activity(request.limit, &[]),
                }
                .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_execution_task(
    state: State<'_, AppState>,
    request: TaskRequest,
) -> Result<Vec<AttemptSummary>, CommandError> {
    state
        .sessions
        .run(
            "read_execution_task",
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
                    .execution_attempt_page(request.task_id, request.after, request.limit)
                    .map_err(map_read)
                    .map(|rows| {
                        rows.into_iter()
                            .map(|(attempt_id, sequence)| AttemptSummary {
                                attempt_id,
                                sequence,
                            })
                            .collect()
                    })
            },
        )
        .await
}
#[tauri::command]
pub async fn read_execution_attempt(
    state: State<'_, AppState>,
    request: AttemptRequest,
) -> Result<AttemptDetail, CommandError> {
    state
        .sessions
        .run(
            "read_execution_attempt",
            CommandStage::ExecutionRead,
            move |sessions| {
                if request.limit == 0 || request.limit > 100 {
                    return Err(CommandError::simple(
                        CommandErrorCode::LimitExceeded,
                        CommandStage::ExecutionRead,
                    ));
                }
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                attempt_detail(
                    host,
                    store,
                    request.attempt_id,
                    request.offset,
                    request.limit,
                )
            },
        )
        .await
}
fn attempt_detail(
    host: &ExecutionHost,
    store: &ProjectStore,
    attempt_id: ExecutionId,
    offset: u32,
    limit: u32,
) -> Result<AttemptDetail, CommandError> {
    store
        .execution_attempt_detail(
            attempt_id,
            host.runtime.is_active(attempt_id),
            offset,
            limit,
        )
        .map_err(|error| {
            if error.code == ErrorCode::InvalidInput && error.stage == "offset" {
                CommandError::invalid_input(CommandStage::ExecutionRead, Some("offset"))
            } else {
                map_read(error)
            }
        })
}

fn source_failure(
    store: &ProjectStore,
    result: &ResultEnvelope,
) -> Result<Option<sdk::SourceExtractionError>, ExecutionError> {
    let Some(evidence) = &result.plugin else {
        return Ok(None);
    };
    let sdk::InvocationOutcome::Failed { error } = &evidence.result.outcome else {
        return Ok(None);
    };
    if result.outcome != ExecutionState::Failed
        || error.schema != sdk::source_extraction_error_contract()
    {
        return Ok(None);
    }
    // A reused result belongs to its original attempt, not the request that
    // selected it. Read that immutable input to bind any reported artifact.
    let input = store.execution_input(result.attempt_id)?;
    let envelope = input.envelope();
    let Some(binding) = &envelope.plugin else {
        return Ok(None);
    };
    let [item] = envelope.items.as_slice() else {
        return Ok(None);
    };
    if item.item_id != result.item_id || binding.capability.declaration.error_schema != error.schema
    {
        return Ok(None);
    }
    let artifacts = match envelope.operation.as_str() {
        tsumugi_core::content::OPERATION
            if binding.capability.declaration.input_schema
                == sdk::source_extraction_input_contract() =>
        {
            let Ok(source) =
                serde_json::from_value::<sdk::SourceExtractionInput>(item.payload.clone())
            else {
                return Ok(None);
            };
            if source.validate().is_err() {
                return Ok(None);
            }
            source.artifacts
        }
        SOURCE_CHECK_OPERATION
            if binding.capability.declaration.input_schema
                == sdk::source_extraction_check_input_contract() =>
        {
            let Ok(check) =
                serde_json::from_value::<sdk::SourceExtractionCheckInput>(item.payload.clone())
            else {
                return Ok(None);
            };
            if check.validate().is_err() {
                return Ok(None);
            }
            check.source.artifacts
        }
        _ => return Ok(None),
    };
    Ok(parse_public_source_failure(error, &artifacts))
}

fn parse_public_source_failure(
    error: &sdk::EncodedPayload,
    artifacts: &[sdk::CapturedTextArtifact],
) -> Option<sdk::SourceExtractionError> {
    if error.schema != sdk::source_extraction_error_contract() {
        return None;
    }
    let failure = sdk::parse_source_extraction_error(error.utf8.as_bytes()).ok()?;
    if failure
        .artifact_id
        .as_ref()
        .is_some_and(|id| !artifacts.iter().any(|artifact| &artifact.id == id))
    {
        return None;
    }
    Some(failure)
}

#[tauri::command]
pub async fn read_execution_output(
    state: State<'_, AppState>,
    request: OutputRequest,
) -> Result<ExecutionOutputView, CommandError> {
    state
        .sessions
        .run(
            "read_execution_output",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let result = active
                    .store
                    .execution_result(request.attempt_id, request.result_id)
                    .map_err(map_read)?;
                let result = result.envelope().clone();
                let source_failure = source_failure(&active.store, &result).map_err(map_read)?;
                Ok(ExecutionOutputView {
                    result,
                    source_failure,
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn cancel_execution_task(
    state: State<'_, AppState>,
    request: CancelRequest,
) -> Result<Revision, CommandError> {
    state
        .sessions
        .run(
            "cancel_execution_task",
            CommandStage::ExecutionCancel,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                let (host, store) = active.execution_parts()?;
                host.runtime
                    .cancel(store, request.task_id, request.request_id)
                    .map_err(|e| map_execution(e, CommandStage::ExecutionCancel))
            },
        )
        .await
}
#[tauri::command]
pub async fn read_execution_task_view(
    state: State<'_, AppState>,
    request: TaskViewRequest,
) -> Result<TaskView, CommandError> {
    state
        .sessions
        .run(
            "read_execution_task_view",
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
                    .execution_task(request.task_id)
                    .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_execution_continuation(
    state: State<'_, AppState>,
    request: ContinuationReadRequest,
) -> Result<Option<ContinuationReceipt>, CommandError> {
    state
        .sessions
        .run(
            "read_execution_continuation",
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
                    .execution_continuation(request.action_id)
                    .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_execution_continuations(
    state: State<'_, AppState>,
    request: ContinuationListRequest,
) -> Result<ContinuationPage, CommandError> {
    state
        .sessions
        .run(
            "read_execution_continuations",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let receipts = active
                    .store
                    .execution_continuation_page(
                        request.source_attempt_id,
                        request.after,
                        request.limit,
                    )
                    .map_err(map_read)?;
                // A full page always offers a cursor; an empty final page confirms completion.
                let next = if receipts.len() == request.limit as usize {
                    receipts.last().map(|receipt| receipt.sequence)
                } else {
                    None
                };
                Ok(ContinuationPage { receipts, next })
            },
        )
        .await
}
#[tauri::command]
pub async fn continue_execution(
    state: State<'_, AppState>,
    request: ContinuationRequest,
) -> Result<ContinuationReceipt, CommandError> {
    state
        .sessions
        .run(
            "continue_execution",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                if request.action.project_id != request.project_id {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "continuation-project",
                    )));
                }
                // A historical receipt is readable even when fresh mutation is unavailable.
                // Keep session/project read authorization, without renewing run authority.
                if let Some(receipt) = active
                    .store
                    .execution_continuation(request.action.action_id)
                    .map_err(map_recover)?
                {
                    return if receipt.action == request.action.canonical().map_err(map_recover)? {
                        Ok(receipt)
                    } else {
                        Err(map_recover(ExecutionError::new(
                            ErrorCode::ResultMismatch,
                            "continuation-identity",
                        )))
                    };
                }
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                host.runtime
                    .resume(store, &request.action)
                    .map_err(map_recover)
            },
        )
        .await
}
#[tauri::command]
pub async fn recover_execution(
    state: State<'_, AppState>,
    request: RecoveryRequest,
) -> Result<RecoveryView, CommandError> {
    state
        .sessions
        .run(
            "recover_execution",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                if matches!(
                    request.action,
                    RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure
                ) {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::InvalidInput,
                        "continuation-identity-required",
                    )));
                }
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let plan = store
                    .execution_recovery(
                        request.attempt_id,
                        host.runtime.is_active(request.attempt_id),
                    )
                    .map_err(map_recover)?;
                let unit = plan
                    .units
                    .iter()
                    .find(|unit| unit.unit_id == request.unit_id)
                    .ok_or_else(|| {
                        CommandError::invalid_input(CommandStage::ExecutionRecover, Some("unitId"))
                    })?;
                let mut selected = request.item_ids.clone();
                selected.sort();
                let mut eligible = unit.remaining_item_ids.clone();
                eligible.sort();
                let matching = if request.action == RecoveryAction::QueryOutcome {
                    selected.len() == 1 && eligible.contains(&selected[0])
                } else {
                    selected == eligible
                };
                if !unit.actions.contains(&request.action) || !matching {
                    let mut error = CommandError::simple(
                        CommandErrorCode::PermissionDenied,
                        CommandStage::ExecutionRecover,
                    );
                    error.item_ids = request.item_ids;
                    error.recovery_actions = unit.actions.clone();
                    return Err(error);
                }
                let mut response = RecoveryView {
                    attempt_id: request.attempt_id,
                    query_started: false,
                };
                match request.action {
                    RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure => {
                        return Err(map_recover(ExecutionError::new(
                            ErrorCode::InvalidInput,
                            "continuation-identity-required",
                        )));
                    }
                    RecoveryAction::ValidateOutput => {
                        for item in selected {
                            let id = store
                                .execution_current_result(request.attempt_id, item)
                                .map_err(map_recover)?
                                .ok_or_else(|| {
                                    CommandError::simple(
                                        CommandErrorCode::OutputInvalid,
                                        CommandStage::ExecutionRecover,
                                    )
                                })?;
                            store
                                .validate_execution_result(request.attempt_id, id)
                                .map_err(map_recover)?;
                        }
                    }
                    RecoveryAction::QueryOutcome => {
                        if selected.len() != 1
                            || host.queries.len() + host.retired_queries.len() >= 2
                        {
                            return Err(CommandError::simple(
                                CommandErrorCode::Busy,
                                CommandStage::ExecutionRecover,
                            ));
                        }
                        if host.queries.iter().any(|job| {
                            job.query.request.input.envelope().attempt_id == request.attempt_id
                                && job.query.request.item_id == selected[0]
                        }) {
                            return Err(CommandError::simple(
                                CommandErrorCode::Busy,
                                CommandStage::ExecutionRecover,
                            ));
                        }
                        let query = host
                            .runtime
                            .outcome_query(store, request.attempt_id, selected[0])
                            .map_err(map_recover)?
                            .ok_or_else(|| CommandError::unknown(CommandStage::ExecutionRecover))?;
                        let query = Arc::new(query);
                        let worker = query.clone();
                        let (sender, receiver) = mpsc::sync_channel(1);
                        let thread = std::thread::Builder::new()
                            .name("execution-query".into())
                            .spawn(move || {
                                let _ = sender.send(worker.run());
                            })
                            .map_err(|_| {
                                CommandError::simple(
                                    CommandErrorCode::StorageFailed,
                                    CommandStage::ExecutionRecover,
                                )
                            })?;
                        host.queries.push(QueryJob {
                            query,
                            receiver,
                            thread,
                            started: Instant::now(),
                            pending_outcome: None,
                        });
                        response.query_started = true;
                    }
                    _ => {
                        return Err(CommandError::invalid_input(
                            CommandStage::ExecutionRecover,
                            Some("action"),
                        ));
                    }
                }
                host.last_error = None;
                Ok(response)
            },
        )
        .await
}
#[tauri::command]
pub async fn prepare_execution_adoption(
    state: State<'_, AppState>,
    request: PrepareRequest,
) -> Result<AdoptionAction, CommandError> {
    state
        .sessions
        .run(
            "prepare_execution_adoption",
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
                    .prepare_adoption_with_id(
                        request.action_id,
                        request.attempt_id,
                        request.unit_id,
                        request.result_ids,
                        serde_json::Value::Null,
                    )
                    .map_err(map_adopt)
            },
        )
        .await
}
#[tauri::command]
pub async fn adopt_execution(
    state: State<'_, AppState>,
    request: AdoptRequest,
) -> Result<AdoptionReceipt, CommandError> {
    state
        .sessions
        .run(
            "adopt_execution",
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
                let action = store
                    .adoption_action(request.action_id)
                    .map_err(map_adopt)?;
                if let Some(receipt) = store
                    .adoption_receipt(request.action_id)
                    .map_err(map_adopt)?
                {
                    return Ok(receipt);
                }
                let handler = host.handlers.get(&action.operation).ok_or_else(|| {
                    CommandError::simple(
                        CommandErrorCode::PermissionDenied,
                        CommandStage::ExecutionAdopt,
                    )
                })?;
                #[cfg(feature = "execution-test-host")]
                if action.operation == tsumugi_core::content::OPERATION {
                    test_support::source_fixture_hook(store, "adopt-before").map_err(map_adopt)?;
                }
                let receipt = store
                    .adopt_execution(&action, handler.as_ref())
                    .map_err(map_adopt)?;
                #[cfg(feature = "execution-test-host")]
                if action.operation == tsumugi_core::content::OPERATION {
                    // The receipt is durable: a post-commit fault cannot reject the write.
                    test_support::source_fixture_hook(store, "adopt-after")
                        .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?;
                }
                Ok(receipt)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_execution_receipt(
    state: State<'_, AppState>,
    request: AdoptRequest,
) -> Result<Option<AdoptionReceipt>, CommandError> {
    state
        .sessions
        .run(
            "read_execution_receipt",
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
                    .adoption_receipt(request.action_id)
                    .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn quiesce_execution(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<RuntimeStatus, CommandError> {
    state
        .sessions
        .run(
            "quiesce_execution",
            CommandStage::ExecutionQuiesce,
            move |sessions| {
                // Authenticate before revoking the original external recipient.
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionQuiesce,
                )?;
                sessions.mcp.close();
                sessions.mcp_retrieval.close();
                let hook_result = {
                    let active = sessions.active.as_mut().expect("authorized session");
                    sessions.source_hooks.close(&mut active.store)
                };
                let hook_active = sessions.source_hooks.is_active();
                let retrieval_active = sessions.mcp_retrieval.active();
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionQuiesce,
                )?;
                let (host, store) = active.execution_parts()?;
                if !host.quiescing {
                    host.begin_quiesce(store)?;
                }
                match host.finish_quiesce(store) {
                    Ok(()) => {}
                    Err(error) if error.code == ErrorCode::Busy => {}
                    Err(error) => return Err(map_execution(error, CommandStage::ExecutionQuiesce)),
                }
                if let Err(error) = hook_result {
                    if error.code != CommandErrorCode::Busy {
                        return Err(error);
                    }
                }
                Ok(RuntimeStatus {
                    active: host.active(store)? || hook_active || retrieval_active,
                    quiescing: host.quiescing || hook_active || retrieval_active,
                    query_count: 0,
                    error: host.last_error.clone(),
                })
            },
        )
        .await
}

#[cfg(all(test, feature = "execution-test-host"))]
mod tests;
