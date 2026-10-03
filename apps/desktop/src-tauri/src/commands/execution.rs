use super::*;
use std::{
    collections::BTreeMap,
    sync::mpsc,
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tsumugi_core::{RecoveryPlan, TaskView, execution::*};

macro_rules! handlers {
    ($($extra:path),*) => { tauri::generate_handler![
        super::create_project,super::open_project,super::read_project,super::rename_project,
        super::add_target_locale,super::set_target_locales,super::close_project,
        list_execution_tasks,read_execution_task,read_execution_attempt,read_execution_output,
        cancel_execution_task,recover_execution,prepare_execution_adoption,adopt_execution,
        read_execution_receipt,execution_status,quiesce_execution,create_execution_identity,
        source::select_source,source::select_webvtt_source,source::read_webvtt_integration,source::preflight_source,source::start_source_import,
        source::cancel_source_capture,source::read_source_preview,source::read_source_content,source::read_source_comparison,
        source::read_content_scope,source::prepare_source_adoption,source::read_source_integration,
        source::read_source_history,source::read_source_history_content,source::read_source_lineage,
        source::estimate_source_update,source::read_source_impact,
        source::translation::list_translation_files,source::translation::preflight_translation,
        source::translation::start_translation_import,source::translation::read_translation_preview,
        source::translation::prepare_translation_adoption,source::translation::read_translation_history,
        source::translation::read_translation_action,
        source::translation::save_translation_revision,source::translation::select_translation_revision,
        resource::choose_resource_file,resource::list_resource_captures,resource::read_resource_preview,resource::decide_resource_entry,
        resource::save_term,resource::read_terms,resource::read_term_history,resource::resolve_terms,
        resource::read_context_revision,resource::save_context,resource::capture_context,
        resource::read_context_capture,resource::tm_suggestions,resource::resource_impacts,
        review::read_review_page,review::read_review_target,review::read_review_history,review::write_review_decision,
        review::read_review_summary_page,review::read_review_editor_snapshot,review::read_review_neighbor,review::capture_review_scope,
        review::run_review_checks,review::cancel_review_checks,review::waive_review_issue,review::allow_source_fallback,
        review::read_review_work,review::read_review_eligibility,
        release::start_locale_build,release::list_releases,release::choose_delivery_folder,
        release::preview_delivery,release::export_release,release::list_deliveries,
        release::reconcile_delivery,ai::preview_ai_translation,ai::start_ai_translation,ai::read_ai_translation,
        arena::preview_arena_translation,arena::start_arena_translation,arena::read_arena_translation,
        arena::create_arena_comparison,arena::read_arena_comparison,arena::list_arena_comparisons,
        arena::reveal_arena_identity,arena::save_arena_merge,$($extra),*
    ] };
}
pub(super) fn handler<R: tauri::Runtime>()
-> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    #[cfg(feature = "execution-test-host")]
    {
        handlers!(seed_execution_fixture)
    }
    #[cfg(not(feature = "execution-test-host"))]
    {
        handlers!()
    }
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
    retired_queries: Vec<JoinHandle<()>>,
    quiescing: bool,
    last_error: Option<CommandError>,
    source: source::SourceSession,
    release: release::ReleaseSession,
    ai: ai::AiSession,
    arena: arena::ArenaSession,
}
struct QueryJob {
    query: Arc<OutcomeQuery>,
    receiver: mpsc::Receiver<Result<QueryOutcome, ExecutionError>>,
    thread: JoinHandle<()>,
    started: Instant,
    pending_outcome: Option<QueryOutcome>,
}
impl ExecutionHost {
    fn new(store: &ProjectStore) -> Result<Self, CommandError> {
        #[allow(unused_mut)]
        let mut host = Self {
            runtime: ExecutionRuntime::new(store).map_err(map_read)?,
            handlers: BTreeMap::new(),
            queries: Vec::new(),
            retired_queries: Vec::new(),
            quiescing: false,
            last_error: None,
            source: source::SourceSession::default(),
            release: release::ReleaseSession::default(),
            ai: ai::AiSession::default(),
            arena: arena::ArenaSession::default(),
        };
        host.runtime
            .register(Arc::new(tsumugi_core::content::SourceRunner))
            .map_err(map_read)?;
        host.runtime
            .register(Arc::new(tsumugi_core::content::TranslationRunner))
            .map_err(map_read)?;
        host.runtime
            .register(Arc::new(tsumugi_core::content::BuildRunner))
            .map_err(map_read)?;
        host.runtime
            .register(Arc::new(tsumugi_core::content::WebvttSourceRunner))
            .map_err(map_read)?;
        host.runtime
            .register(Arc::new(tsumugi_core::content::WebvttBuildRunner))
            .map_err(map_read)?;
        host.runtime
            .register(Arc::new(tsumugi_core::ai::AiRunner::default()))
            .map_err(map_read)?;
        host.handlers.insert(
            tsumugi_core::ai::OPERATION.into(),
            Arc::new(tsumugi_core::AiAdoptionHandler),
        );
        host.runtime
            .register(Arc::new(tsumugi_core::ai::arena::ArenaRunner::default()))
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
                .register(Arc::new(test_support::ControlledRunner))
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
            || self.source.is_active()
            || !self.queries.is_empty()
            || self.runtime.has_active_work(store).map_err(map_read)?)
    }
    fn tick(&mut self, store: &mut ProjectStore) -> Result<(), CommandError> {
        self.poll_queries(store)?;
        self.runtime.tick(store).map_err(map_read)
    }
    fn poll_queries(&mut self, store: &mut ProjectStore) -> Result<(), CommandError> {
        self.retired_queries.retain(|thread| !thread.is_finished());
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
                self.retired_queries.push(job.thread);
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
                    self.retired_queries.push(job.thread);
                    return Err(map_recover(error));
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    let job = self.queries.remove(index);
                    self.retired_queries.push(job.thread);
                    return Err(CommandError::unknown(CommandStage::ExecutionRecover));
                }
                Err(mpsc::TryRecvError::Empty) if expired => {
                    let job = self.queries.remove(index);
                    self.retired_queries.push(job.thread);
                    return Err(CommandError::unknown(CommandStage::ExecutionRecover));
                }
                Err(mpsc::TryRecvError::Empty) => index += 1,
            }
        }
        Ok(())
    }
    fn begin_quiesce(&mut self, store: &mut ProjectStore) -> Result<(), CommandError> {
        // Persist already received evidence before revoking late callbacks.
        // Storage failure retains the session and pending evidence for retry.
        self.poll_queries(store)?;
        self.quiescing = true;
        self.source.stop();
        self.release.stop();
        for job in self.queries.drain(..) {
            self.retired_queries.push(job.thread);
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
}
impl ActiveSession {
    fn execution_parts(&mut self) -> Result<(&mut ExecutionHost, &mut ProjectStore), CommandError> {
        if self.execution.is_none() {
            self.execution = Some(ExecutionHost::new(&self.store)?);
        }
        Ok((
            self.execution.as_mut().expect("initialized"),
            &mut self.store,
        ))
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

fn map_execution(error: ExecutionError, stage: CommandStage) -> CommandError {
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
    mapped
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
    ($name:ident { $($field:ident : $kind:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Deserialize, Serialize)]
        #[serde(rename_all="camelCase", deny_unknown_fields)]
        pub struct $name { pub session_token:String, pub project_id:ExecutionId, $(pub $field:$kind,)* }
    }
}
mod ai;
mod arena;
mod release;
mod resource;
mod review;
#[cfg(test)]
pub(super) use review::ComputeProbe;
mod source;
request!(SessionRequest {});
request!(ListRequest {
    after: Revision,
    limit: u32
});
request!(TaskRequest {
    task_id: ExecutionId,
    after: Revision,
    limit: u32
});
request!(AttemptRequest {
    attempt_id: ExecutionId,
    offset: u32,
    limit: u32
});
request!(OutputRequest {
    attempt_id: ExecutionId,
    result_id: ExecutionId
});
request!(CancelRequest {
    task_id: ExecutionId,
    request_id: ExecutionId
});
request!(RecoveryRequest { attempt_id:ExecutionId, unit_id:ExecutionId, action:RecoveryAction, item_ids:Vec<ExecutionId> });
request!(PrepareRequest { attempt_id:ExecutionId, unit_id:ExecutionId, action_id:ExecutionId, result_ids:Vec<ExecutionId> });
request!(AdoptRequest {
    action_id: ExecutionId
});

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
pub struct RuntimeStatus {
    pub active: bool,
    pub quiescing: bool,
    pub query_count: u32,
    pub error: Option<CommandError>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptSummary {
    pub attempt_id: ExecutionId,
    pub sequence: Revision,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemView {
    pub status: ItemStatus,
    pub scope: Scope,
    pub result_id: Option<ExecutionId>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptDetail {
    pub attempt_id: ExecutionId,
    pub task_id: ExecutionId,
    pub operation: String,
    pub progress: Progress,
    pub items: Vec<ItemView>,
    pub recovery: RecoveryPlan,
    pub next_offset: Option<u32>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryView {
    pub attempt_id: ExecutionId,
    pub query_started: bool,
}

fn authorized<'a>(
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
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                Ok(RuntimeStatus {
                    active: host.active(store)?,
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
    let view = host.runtime.attempt(store, attempt_id).map_err(map_read)?;
    let input = store.execution_input(attempt_id).map_err(map_read)?;
    let total = view.items.len();
    if offset as usize > total {
        return Err(CommandError::invalid_input(
            CommandStage::ExecutionRead,
            Some("offset"),
        ));
    }
    let items = view
        .items
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|status| {
            Ok(ItemView {
                scope: input.item(status.item_id).map_err(map_read)?.scope.clone(),
                result_id: store
                    .execution_current_result(attempt_id, status.item_id)
                    .map_err(map_read)?,
                status,
            })
        })
        .collect::<Result<Vec<_>, CommandError>>()?;
    let mut recovery = store
        .execution_recovery(attempt_id, host.runtime.is_active(attempt_id))
        .map_err(map_read)?;
    // A unit can span pages. Return it on each page containing a member so its
    // full scope remains explicit before an action is requested.
    recovery.units.retain(|unit| {
        items
            .iter()
            .any(|item| unit.item_ids.contains(&item.status.item_id))
    });
    if view.operation == tsumugi_core::ai::OPERATION {
        for unit in &mut recovery.units {
            unit.actions.retain(|a| {
                !matches!(
                    a,
                    RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure
                )
            });
        }
    }
    let end = offset + items.len() as u32;
    Ok(AttemptDetail {
        attempt_id: view.attempt_id,
        task_id: view.task_id,
        operation: view.operation,
        progress: view.progress,
        items,
        recovery,
        next_offset: ((end as usize) < total).then_some(end),
    })
}
#[tauri::command]
pub async fn read_execution_output(
    state: State<'_, AppState>,
    request: OutputRequest,
) -> Result<ResultEnvelope, CommandError> {
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
                active
                    .store
                    .execution_result(request.attempt_id, request.result_id)
                    .map(|result| result.envelope().clone())
                    .map_err(map_read)
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
                        response.attempt_id = host
                            .runtime
                            .resume(store, request.attempt_id, &selected)
                            .map_err(map_recover)?
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
                    test_support::source_fixture_hook(store, "adopt-after").map_err(map_adopt)?;
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
                match host.runtime.finish_quiesce(store) {
                    Ok(()) => host.quiescing = false,
                    Err(error) if error.code == ErrorCode::Busy => {}
                    Err(error) => return Err(map_execution(error, CommandStage::ExecutionQuiesce)),
                }
                Ok(RuntimeStatus {
                    active: host.active(store)?,
                    quiescing: host.quiescing,
                    query_count: 0,
                    error: host.last_error.clone(),
                })
            },
        )
        .await
}

#[cfg(all(test, feature = "execution-test-host"))]
mod tests;
