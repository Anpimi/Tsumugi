//! Accepted Review work uses independent original runtime channels and the
//! single Core QA adoption boundary. Previews cannot grant execution authority.
use super::checkers::{CheckerEnvironment, ReviewCheckerView, capture_advisory};
use super::*;
use crate::commands::plugins::ApplicationPlugins;
use std::collections::BTreeSet;
use tsumugi_core::{
    AdvisoryReviewCheck, CapturedReviewCheckExecution, PreparedReviewCheck, ReviewCheckOrigin,
    ReviewCheckerKey,
};

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewCheckStartRequest { check: ReviewCheckRequest, executions: Vec<PluginStartRequest> }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckerPreflightView {
    pub checker: ReviewCheckerKey,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub plugin: ReviewCheckerView,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewPluginCheckView {
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub basis: String,
    pub checkers: Vec<ReviewCheckerPreflightView>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewCheckPreparation {
    Recorded { run: CheckRun },
    Plugin { view: ReviewPluginCheckView },
}

#[derive(Clone)]
struct Slot {
    key: ReviewCheckerKey,
    input: FixedInput,
    environment: CheckerEnvironment,
    start: Option<PluginStartRequest>,
}
struct Preflight {
    prepared: PreparedReviewCheck,
    request: ReviewCheckRequest,
    slots: Vec<Slot>,
    view: ReviewPluginCheckView,
}
type Reply = Box<dyn FnOnce(Result<CapturedReviewCheckExecution, CommandError>) + Send>;
struct Job {
    request: ReviewCheckRequest,
    executions: Vec<PluginStartRequest>,
    _registration: ReviewCheckRegistration,
    cancellation: Cancellation,
    plugins: Arc<ApplicationPlugins>,
    settings_revision: UnsignedDecimal,
    slots: Vec<Slot>,
    prepared: PreparedReviewCheck,
    attached: bool,
    observing: bool,
    terminal: bool,
    reply: Option<Reply>,
    cancellation_sent: bool,
    cancellation_actions: Vec<ExecutionId>,
}
impl Job {
    fn cancel_channels(
        &mut self,
        store: &mut ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<(), CommandError> {
        if self.cancellation_sent {
            return Ok(());
        }
        for (slot, action) in self.slots.iter().zip(&self.cancellation_actions) {
            if let Some(start) = &slot.start {
                runtime
                    .revoke_plugin(store, start.grant_id)
                    .map_err(map_adopt)?;
            }
            match store.execution_input(slot.input.envelope().attempt_id) {
                Ok(_) => {
                    runtime
                        .cancel(store, slot.input.envelope().task_id, *action)
                        .map_err(|error| map_execution(error, CommandStage::ExecutionCancel))?;
                }
                Err(error)
                    if error.code == ErrorCode::InvalidInput
                        && error.stage == "execution-storage" => {}
                Err(error) => return Err(map_read(error)),
            }
        }
        self.cancellation_sent = true;
        Ok(())
    }
}
#[derive(Default)]
pub(in crate::commands::execution) struct ReviewSession {
    preflight: Option<Preflight>,
    jobs: BTreeMap<ExecutionId, Job>,
}
impl ReviewSession {
    pub(in crate::commands::execution) fn active(&self) -> bool {
        self.jobs.values().any(|job| job.attached || !job.terminal)
    }
    pub(in crate::commands::execution) fn stop(&mut self) {
        self.preflight = None;
        for job in self.jobs.values() {
            job.cancellation.request();
        }
    }
    /// Withdraw the original grants before queued manual checks can dispatch.
    /// The returned snapshot guards the ordinary runtime's actual tick as well.
    pub(in crate::commands::execution) fn prepare_runtime_tick(
        &mut self,
        store: &mut ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<Option<(Arc<ApplicationPlugins>, UnsignedDecimal)>, CommandError> {
        let mut authority = None;
        for job in self.jobs.values_mut() {
            if !job.cancellation.is_requested() {
                if let Err(error) = job
                    .plugins
                    .with_environment_revision(job.settings_revision, || Ok(()))
                {
                    if matches!(
                        error.code,
                        CommandErrorCode::Busy
                            | CommandErrorCode::StorageFailed
                            | CommandErrorCode::OutcomeUnknown
                    ) {
                        return Err(error);
                    }
                    job.cancellation.request();
                }
            }
            if job.cancellation.is_requested() {
                job.cancel_channels(store, runtime)?;
            } else if job.slots.iter().any(|slot| slot.start.is_some()) {
                if authority.as_ref().is_some_and(|(plugins, revision)| {
                    *revision != job.settings_revision || !Arc::ptr_eq(plugins, &job.plugins)
                }) {
                    return Err(stale());
                }
                authority = Some((job.plugins.clone(), job.settings_revision));
            }
        }
        self.jobs
            .retain(|_, job| job.attached || !job.cancellation_sent);
        Ok(authority)
    }
    pub(in crate::commands::execution) fn tick(
        &mut self,
        store: &mut ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<(), CommandError> {
        for job in self.jobs.values_mut() {
            if job.cancellation.is_requested() && !job.cancellation_sent {
                job.cancel_channels(store, runtime)?;
            }
            if !job.observing {
                // Detached error replies do not detach their original channels
                // from authority/cancellation. Real terminal frames determine
                // whether the retained retry occupies active project work.
                job.terminal = true;
                for slot in &job.slots {
                    match store.execution_attempt(slot.input.envelope().attempt_id, false) {
                        Ok(status) => {
                            if status.items.is_empty() {
                                return Err(map_read(ExecutionError::new(
                                    ErrorCode::CorruptLedger,
                                    "review-check-item",
                                )));
                            }
                            if status.items.iter().any(|item| {
                                matches!(
                                    item.execution,
                                    ExecutionState::Queued | ExecutionState::Dispatched
                                )
                            }) {
                                job.terminal = false;
                            }
                        }
                        Err(error)
                            if error.code == ErrorCode::InvalidInput
                                && error.stage == "execution-storage" =>
                        {
                            job.terminal = false
                        }
                        Err(error) => return Err(map_read(error)),
                    }
                }
                continue;
            }
            let observed = (|| {
                if job.cancellation.is_requested() {
                    return Err(cancelled());
                }
                let mut origins = Vec::with_capacity(job.slots.len());
                for slot in &job.slots {
                    let attempt = slot.input.envelope().attempt_id;
                    let status = runtime.attempt(store, attempt).map_err(map_read)?;
                    let item = status.items.first().ok_or_else(|| {
                        map_read(ExecutionError::new(
                            ErrorCode::CorruptLedger,
                            "review-check-item",
                        ))
                    })?;
                    if matches!(
                        item.execution,
                        ExecutionState::Queued | ExecutionState::Dispatched
                    ) {
                        return Ok(None);
                    }
                    let result = store
                        .execution_current_result(attempt, item.item_id)
                        .map_err(map_read)?
                        .ok_or_else(|| CommandError::unknown(CommandStage::ExecutionAdopt))?;
                    origins.push(ReviewCheckOrigin {
                        checker: slot.key.clone(),
                        attempt_id: attempt,
                        result_id: result,
                    });
                }
                store
                    .capture_review_check_execution(job.prepared.clone(), &origins)
                    .map(Some)
                    .map_err(map_adopt)
            })();
            let result = match observed {
                Ok(None) => continue,
                Err(error)
                    if matches!(
                        error.code,
                        CommandErrorCode::Busy | CommandErrorCode::StorageFailed
                    ) =>
                {
                    return Err(error);
                }
                Ok(Some(capture)) => Ok(capture),
                Err(error) => Err(error),
            };
            job.observing = false;
            if let Some(reply) = job.reply.take() {
                reply(result);
            }
        }
        Ok(())
    }
}
fn cancelled() -> CommandError {
    map_adopt(ExecutionError::new(
        ErrorCode::Cancelled,
        "review-check-cancelled",
    ))
}
fn stale() -> CommandError {
    super::checkers::stale()
}
fn preflight_view(
    request: &ReviewCheckRequest,
    slots: &[Slot],
) -> Result<ReviewPluginCheckView, CommandError> {
    Ok(ReviewPluginCheckView {
        action_id: request.action_id,
        unit_id: request.unit_id,
        locale: request.locale.clone(),
        basis: request.expected_basis.clone(),
        checkers: slots
            .iter()
            .map(|slot| {
                Ok(ReviewCheckerPreflightView {
                    checker: slot.key.clone(),
                    attempt_id: slot.input.envelope().attempt_id,
                    input_digest: slot.input.digest().into(),
                    plugin: slot.environment.view()?,
                })
            })
            .collect::<Result<_, CommandError>>()?,
    })
}
fn capture(
    store: &ProjectStore,
    request: &ReviewCheckRequest,
    choices: &[AdvisoryReviewCheck],
) -> Result<PreparedReviewCheck, CommandError> {
    store
        .prepare_review_check(
            request.project_id,
            request.unit_id,
            &request.locale,
            &request.expected_basis,
            request.action_id,
            choices,
        )
        .map_err(map_adopt)
}
fn recorded(
    store: &ProjectStore,
    request: &ReviewCheckRequest,
) -> Result<Option<CheckRun>, CommandError> {
    let Some(run) = store
        .review_check_action(request.project_id, request.action_id)
        .map_err(map_read)?
    else {
        return Ok(None);
    };
    if run.unit_id != request.unit_id
        || run.locale != request.locale
        || run.basis != request.expected_basis
    {
        return Err(stale());
    }
    let choices = run
        .evidence
        .as_ref()
        .map(|e| e.advisory_checks.as_slice())
        .unwrap_or(&[]);
    if choices.len() != request.advisory_checks.len() {
        return Err(stale());
    }
    for (saved, selected) in choices.iter().zip(&request.advisory_checks) {
        if saved.binding.checker.provider.plugin != selected.package.plugin
            || saved.binding.checker.provider.package_digest != selected.package.package_digest
            || saved.declaration_resource_id != selected.resource_id
            || saved.environment.digest().map_err(|_| stale())? != selected.environment_digest
            || saved.rules != selected.rules
        {
            return Err(stale());
        }
    }
    capture(store, request, choices)?
        .recorded_run()
        .cloned()
        .ok_or_else(stale)
        .map(Some)
}

#[tauri::command]
pub async fn prepare_review_checks(
    state: State<'_, AppState>,
    request: ReviewCheckRequest,
) -> Result<ReviewCheckPreparation, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let prior = lease
        .run(
            "prepare_review_checks.recorded",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                if let Some(run) = recorded(store, &initial)? {
                    return Ok(Some(ReviewCheckPreparation::Recorded { run }));
                }
                host.allow_mutation()?;
                if let Some(job) = host.review.jobs.get(&initial.action_id) {
                    if job.request != initial {
                        return Err(stale());
                    }
                    let current = capture(
                        store,
                        &initial,
                        job.prepared.plan().ok_or_else(stale)?.advisory_checks(),
                    )?;
                    for slot in &job.slots {
                        current
                            .validate_execution_input(&slot.input)
                            .map_err(map_adopt)?;
                    }
                    return Ok(Some(ReviewCheckPreparation::Plugin {
                        view: preflight_view(&initial, &job.slots)?,
                    }));
                }
                if let Some(preflight) = &host.review.preflight {
                    if preflight.request == initial {
                        let current = capture(
                            store,
                            &initial,
                            preflight
                                .prepared
                                .plan()
                                .ok_or_else(stale)?
                                .advisory_checks(),
                        )?;
                        for slot in &preflight.slots {
                            current
                                .validate_execution_input(&slot.input)
                                .map_err(map_adopt)?;
                        }
                        return Ok(Some(ReviewCheckPreparation::Plugin {
                            view: preflight.view.clone(),
                        }));
                    }
                }
                Ok(None)
            },
        )
        .await?;
    if let Some(view) = prior {
        return Ok(view);
    }
    let plugins = state.plugins.clone();
    let selected = request.advisory_checks.clone();
    let choices = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            capture_advisory(&plugins, &selected)
        })
        .await?;
    let initial = request.clone();
    let prepared = lease
        .run(
            "prepare_review_checks.capture",
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
                capture(store, &initial, &choices)
            },
        )
        .await?;
    if let Some(run) = prepared.recorded_run() {
        return Ok(ReviewCheckPreparation::Recorded { run: run.clone() });
    }
    let plan = prepared.plan().ok_or_else(stale)?.clone();
    let inputs = prepared.execution_inputs().to_vec();
    let plugins = state.plugins.clone();
    let slots = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            plan.checkers()
                .iter()
                .zip(inputs)
                .map(|(checker, input)| {
                    Ok(Slot {
                        key: checker.key.clone(),
                        input,
                        environment: CheckerEnvironment::capture(
                            &plugins,
                            checker,
                            plan.binding(),
                            plan.advisory_checks(),
                        )?,
                        start: None,
                    })
                })
                .collect::<Result<Vec<_>, CommandError>>()
        })
        .await?;
    lease
        .run(
            "prepare_review_checks.finish",
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
                let current = capture(
                    store,
                    &request,
                    prepared.plan().ok_or_else(stale)?.advisory_checks(),
                )?;
                if let Some(run) = current.recorded_run() {
                    return Ok(ReviewCheckPreparation::Recorded { run: run.clone() });
                }
                for slot in &slots {
                    current
                        .validate_execution_input(&slot.input)
                        .map_err(map_adopt)?;
                }
                let view = preflight_view(&request, &slots)?;
                host.review.preflight = Some(Preflight {
                    prepared,
                    request,
                    slots,
                    view: view.clone(),
                });
                Ok(ReviewCheckPreparation::Plugin { view })
            },
        )
        .await
}

#[tauri::command]
pub async fn run_review_checks(
    state: State<'_, AppState>,
    request: ReviewCheckStartRequest,
) -> Result<CheckRun, CommandError> {
    if request.session_token != request.check.session_token
        || request.project_id != request.check.project_id
        || request.executions.iter().any(|execution| {
            execution.session_token != request.session_token
                || execution.project_id != request.project_id
        })
    {
        return Err(stale());
    }
    let registry = Arc::clone(&state.review_check_cancellations);
    let (cancellation, inserted) = {
        let mut checks = registry
            .lock()
            .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?;
        if let Some((session, project, cancellation)) = checks.get(&request.check.action_id) {
            if session != &request.session_token || *project != request.project_id {
                return Err(CommandError::simple(
                    CommandErrorCode::SessionInvalid,
                    CommandStage::ExecutionAdopt,
                ));
            }
            (cancellation.clone(), false)
        } else {
            let cancellation = Cancellation::default();
            checks.insert(
                request.check.action_id,
                (
                    request.session_token.clone(),
                    request.project_id,
                    cancellation.clone(),
                ),
            );
            (cancellation, true)
        }
    };
    let mut registration = inserted.then(|| ReviewCheckRegistration {
        registry,
        action: request.check.action_id,
    });
    let lease = state.sessions.lease(CommandStage::ExecutionAdopt)?;
    let initial = request.clone();
    let token = cancellation.clone();
    let job_plugins = state.plugins.clone();
    let admitted = lease.submit(
        "run_review_checks.capture",
        CommandStage::ExecutionAdopt,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionAdopt,
            )?;
            let (host, store) = active.execution_parts()?;
            if let Some(run) = recorded(store, &initial.check)? {
                return Ok(Err(run));
            }
            host.allow_mutation()?;
            if token.is_requested() {
                return Err(cancelled());
            }
            if host
                .review
                .jobs
                .get(&initial.check.action_id)
                .is_some_and(|job| job.attached)
            {
                return Err(CommandError::unknown(CommandStage::ExecutionAdopt));
            }
            if !host.review.jobs.contains_key(&initial.check.action_id)
                && host.review.jobs.len() >= 2
            {
                return Err(CommandError::simple(
                    CommandErrorCode::Busy,
                    CommandStage::ExecutionAdopt,
                ));
            }
            let (prepared, slots) =
                if let Some(job) = host.review.jobs.get(&initial.check.action_id) {
                    if job.request != initial.check || job.executions != initial.executions {
                        return Err(stale());
                    }
                    (job.prepared.clone(), job.slots.clone())
                } else {
                    let preflight = host
                        .review
                        .preflight
                        .as_ref()
                        .filter(|p| p.request == initial.check)
                        .ok_or_else(stale)?;
                    (preflight.prepared.clone(), preflight.slots.clone())
                };
            if slots.len() != initial.executions.len() {
                return Err(stale());
            }
            let current = capture(
                store,
                &initial.check,
                prepared.plan().ok_or_else(stale)?.advisory_checks(),
            )?;
            let mut identities = BTreeSet::new();
            for (slot, execution) in slots.iter().zip(&initial.executions) {
                if !execution.unsandboxed_execution {
                    return Err(map_adopt(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "plugin-consent-required",
                    )));
                }
                if execution.attempt_id != slot.input.envelope().attempt_id
                    || execution.input_digest != slot.input.digest()
                    || !identities.insert(execution.grant_id)
                    || slot.start.as_ref().is_some_and(|start| start != execution)
                {
                    return Err(stale());
                }
                current
                    .validate_execution_input(&slot.input)
                    .map_err(map_adopt)?;
            }
            let settings_revision = slots
                .first()
                .ok_or_else(stale)?
                .environment
                .settings_revision();
            if slots
                .iter()
                .any(|slot| slot.environment.settings_revision() != settings_revision)
            {
                return Err(stale());
            }
            if let Some(job) = host.review.jobs.get_mut(&initial.check.action_id) {
                job.attached = true;
            } else {
                host.review.jobs.insert(
                    initial.check.action_id,
                    Job {
                        request: initial.check.clone(),
                        executions: initial.executions.clone(),
                        _registration: registration.take().ok_or_else(stale)?,
                        cancellation: token,
                        plugins: job_plugins,
                        settings_revision,
                        slots: slots.clone(),
                        prepared: prepared.clone(),
                        attached: true,
                        observing: false,
                        terminal: false,
                        reply: None,
                        cancellation_sent: false,
                        cancellation_actions: slots.iter().map(|_| ExecutionId::new()).collect(),
                    },
                );
            }
            Ok(Ok((prepared, slots)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    let admission_plugins = plugins.clone();
    #[cfg(test)]
    let probe = {
        let mut pending = state.review_compute_probe.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|probe| probe.action == request.check.action_id)
        {
            pending.take()
        } else {
            None
        }
    };
    tauri::async_runtime::spawn(async move {
        let mut attached = false;
        let work = async {
            let (prepared, slots) = match admitted.await? {
                Ok(value) => {
                    attached = true;
                    value
                }
                Err(run) => return Ok(run),
            };
            let loaded = io
                .run(CommandStage::ExecutionAdopt, move || {
                    slots
                        .into_iter()
                        .map(|slot| {
                            let environment = slot.environment.reopen(&plugins)?;
                            let runner = if slot.start.is_none() {
                                Some(environment.clone().runner()?)
                            } else {
                                None
                            };
                            Ok((slot, environment, runner))
                        })
                        .collect::<Result<Vec<_>, CommandError>>()
                })
                .await?;
            let settings_revision = loaded.first().ok_or_else(stale)?.1.settings_revision();
            if loaded
                .iter()
                .any(|(_, environment, _)| environment.settings_revision() != settings_revision)
            {
                return Err(stale());
            }
            let commit_plugins = admission_plugins.clone();
            let (sender, mut receiver) = tauri::async_runtime::channel(1);
            let dispatch = request.clone();
            let token = cancellation.clone();
            lease
                .run(
                    "run_review_checks.dispatch",
                    CommandStage::ExecutionAdopt,
                    move |sessions| {
                        let active = authorized(
                            sessions,
                            &dispatch.session_token,
                            dispatch.project_id,
                            CommandStage::ExecutionAdopt,
                        )?;
                        let (host, store) = active.execution_parts()?;
                        host.allow_mutation()?;
                        if token.is_requested() {
                            return Err(cancelled());
                        }
                        let current = capture(
                            store,
                            &dispatch.check,
                            prepared.plan().ok_or_else(stale)?.advisory_checks(),
                        )?;
                        for ((slot, environment, runner), execution) in
                            loaded.into_iter().zip(&dispatch.executions)
                        {
                            current
                                .validate_execution_input(&slot.input)
                                .map_err(map_adopt)?;
                            admission_plugins.with_environment_revision(
                                environment.settings_revision(),
                                || {
                                    if let Some(runner) = runner {
                                        host.register_plugin(
                                            runner,
                                            slot.input
                                                .envelope()
                                                .plugin
                                                .clone()
                                                .ok_or_else(stale)?,
                                        )
                                        .map_err(map_adopt)?;
                                        host.runtime
                                            .authorize_plugin(
                                                store,
                                                execution.grant_id,
                                                &slot.input,
                                                execution.expires_at_ms.get(),
                                                PluginConsent {
                                                    unsandboxed_execution: true,
                                                },
                                            )
                                            .map_err(map_adopt)?;
                                        host.review
                                            .jobs
                                            .get_mut(&dispatch.check.action_id)
                                            .ok_or_else(stale)?
                                            .slots
                                            .iter_mut()
                                            .find(|s| s.key == slot.key)
                                            .ok_or_else(stale)?
                                            .start = Some(execution.clone());
                                        if let Some(preflight) = host
                                            .review
                                            .preflight
                                            .as_mut()
                                            .filter(|p| p.request == dispatch.check)
                                        {
                                            preflight
                                                .slots
                                                .iter_mut()
                                                .find(|s| s.key == slot.key)
                                                .ok_or_else(stale)?
                                                .start = Some(execution.clone());
                                        }
                                    }
                                    host.runtime.submit(store, &slot.input).map_err(map_adopt)?;
                                    Ok(())
                                },
                            )?;
                        }
                        let job = host
                            .review
                            .jobs
                            .get_mut(&dispatch.check.action_id)
                            .ok_or_else(stale)?;
                        job.observing = true;
                        job.reply = Some(Box::new(move |result| {
                            let _ = sender.try_send(result);
                        }));
                        Ok(())
                    },
                )
                .await?;
            let captured = receiver
                .recv()
                .await
                .ok_or_else(|| CommandError::unknown(CommandStage::ExecutionAdopt))??;
            let token = cancellation.clone();
            let computed = io
                .run(CommandStage::ExecutionAdopt, move || {
                    #[cfg(test)]
                    if let Some(probe) = probe {
                        probe.reached.send(()).unwrap();
                        probe.release.recv_timeout(Duration::from_secs(10)).unwrap();
                    }
                    captured.compute(&token).map_err(map_adopt)
                })
                .await?;
            let commit = request.clone();
            let token = cancellation.clone();
            lease
                .run(
                    "run_review_checks.commit",
                    CommandStage::ExecutionAdopt,
                    move |sessions| {
                        let active = authorized(
                            sessions,
                            &commit.session_token,
                            commit.project_id,
                            CommandStage::ExecutionAdopt,
                        )?;
                        let (host, store) = active.execution_parts()?;
                        if let Some(run) = recorded(store, &commit.check)? {
                            return Ok(run);
                        }
                        host.allow_mutation()?;
                        commit_plugins.with_environment_revision(settings_revision, || {
                            store
                                .commit_review_evidence(computed, &token)
                                .map_err(map_adopt)
                        })
                    },
                )
                .await
        }
        .await;
        if !attached {
            return work;
        }
        let stop_channels = cancellation.is_requested()
            || work
                .as_ref()
                .err()
                .is_some_and(|error| error.reason.as_deref() == Some("plugin-settings-changed"));
        let completed = work.is_ok();
        let cleanup = lease
            .run(
                "run_review_checks.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    if let Some(job) = host.review.jobs.get_mut(&request.check.action_id) {
                        let stop_channels = stop_channels || job.cancellation.is_requested();
                        job.attached = false;
                        job.observing = false;
                        job.reply = None;
                        if stop_channels && !job.cancellation_sent {
                            job.cancellation.request();
                            job.cancel_channels(store, &mut host.runtime)?;
                        }
                        if completed || job.cancellation_sent {
                            host.review.jobs.remove(&request.check.action_id);
                        }
                    }
                    Ok(())
                },
            )
            .await;
        cleanup?;
        work
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
}

#[cfg(test)]
mod tests;
