//! Accepted Review work owns its continuation through real runtime execution,
//! outside-actor computation and the original Core QA adoption boundary.
use super::*;
use crate::commands::plugins::reviews::PluginReviewView;
use tsumugi_core::{CapturedReviewCheckExecution, PreparedReviewCheck};
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewCheckStartRequest {
        check: ReviewCheckRequest,
        execution: PluginStartRequest
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewPluginCheckView {
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub basis: String,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub plugin: PluginReviewView,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewCheckPreparation {
    Recorded { run: CheckRun },
    Plugin { view: ReviewPluginCheckView },
}

struct Preflight {
    prepared: PreparedReviewCheck,
    request: ReviewCheckRequest,
    input: FixedInput,
    view: ReviewPluginCheckView,
    start: Option<PluginStartRequest>,
}
type Reply = Box<dyn FnOnce(Result<CapturedReviewCheckExecution, CommandError>) + Send>;
struct Job {
    cancellation: Cancellation,
    input: FixedInput,
    prepared: Option<PreparedReviewCheck>,
    reply: Option<Reply>,
    cancellation_sent: bool,
    cancellation_action: ExecutionId,
}

#[derive(Default)]
pub(in crate::commands::execution) struct ReviewSession {
    preflight: Option<Preflight>,
    jobs: BTreeMap<ExecutionId, Job>,
}
impl ReviewSession {
    pub(in crate::commands::execution) fn active(&self) -> bool {
        !self.jobs.is_empty()
    }
    pub(in crate::commands::execution) fn stop(&mut self) {
        self.preflight = None;
        for job in self.jobs.values() {
            job.cancellation.request();
        }
    }
    pub(in crate::commands::execution) fn tick(
        &mut self,
        store: &mut ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<(), CommandError> {
        for job in self.jobs.values_mut() {
            if job.prepared.is_none() {
                continue;
            }
            if job.cancellation.is_requested() && !job.cancellation_sent {
                runtime
                    .cancel(store, job.input.envelope().task_id, job.cancellation_action)
                    .map_err(|error| map_execution(error, CommandStage::ExecutionCancel))?;
                job.cancellation_sent = true;
            }
            let attempt = job.input.envelope().attempt_id;
            let status = match runtime.attempt(store, attempt) {
                Ok(status) => status,
                Err(error)
                    if matches!(
                        error.code,
                        ErrorCode::Busy | ErrorCode::StorageFailed | ErrorCode::OutcomeUnknown
                    ) =>
                {
                    return Err(map_read(error));
                }
                Err(error) => {
                    job.prepared = None;
                    if let Some(reply) = job.reply.take() {
                        reply(Err(map_read(error)));
                    }
                    continue;
                }
            };
            let Some(item) = status.items.first() else {
                job.prepared = None;
                if let Some(reply) = job.reply.take() {
                    reply(Err(map_read(ExecutionError::new(
                        ErrorCode::CorruptLedger,
                        "review-check-item",
                    ))));
                }
                continue;
            };
            let result = match item.execution {
                ExecutionState::Queued | ExecutionState::Dispatched
                    if !job.cancellation.is_requested() =>
                {
                    continue;
                }
                _ if job.cancellation.is_requested() => Err(cancelled()),
                ExecutionState::Succeeded => {
                    let prepared = job.prepared.take().expect("pending capture");
                    store
                        .execution_current_result(attempt, item.item_id)
                        .and_then(|result| {
                            result.ok_or_else(|| {
                                ExecutionError::new(ErrorCode::CorruptLedger, "review-check-result")
                            })
                        })
                        .and_then(|result| {
                            store.capture_review_check_execution(prepared, attempt, result)
                        })
                        .map_err(map_adopt)
                }
                ExecutionState::Unknown => Err(CommandError::unknown(CommandStage::ExecutionAdopt)),
                _ => Err(map_adopt(ExecutionError::new(
                    ErrorCode::OutputInvalid,
                    "review-check-execution",
                ))),
            };
            job.prepared = None;
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
    map_adopt(ExecutionError::new(
        ErrorCode::DependencyConflict,
        "review-check-preflight",
    ))
}
fn capture(
    store: &ProjectStore,
    request: &ReviewCheckRequest,
) -> Result<PreparedReviewCheck, CommandError> {
    store
        .prepare_review_check(
            request.project_id,
            request.unit_id,
            &request.locale,
            &request.expected_basis,
            request.action_id,
        )
        .map_err(map_adopt)
}

#[tauri::command]
pub async fn prepare_review_checks(
    state: State<'_, AppState>,
    request: ReviewCheckRequest,
) -> Result<ReviewCheckPreparation, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let captured = lease.submit(
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
            let prepared = capture(store, &initial)?;
            if let Some(run) = prepared.recorded_run() {
                return Ok(Err(ReviewCheckPreparation::Recorded { run: run.clone() }));
            }
            if let Some(prior) = &host.review.preflight {
                if prior.request == initial {
                    prepared
                        .validate_domain_execution_input(&prior.input)
                        .map_err(map_adopt)?;
                    return Ok(Err(ReviewCheckPreparation::Plugin {
                        view: prior.view.clone(),
                    }));
                }
            }
            let binding = prepared.plan().ok_or_else(stale)?.binding().clone();
            let input = prepared
                .domain_execution_input(ExecutionId::new())
                .map_err(map_adopt)?;
            Ok(Ok((prepared, input, binding)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (prepared, input, binding) = match captured.await? {
            Ok(value) => value,
            Err(view) => return Ok(view),
        };
        let plugin = io
            .run(CommandStage::ExecutionRead, move || {
                plugins.capture_review(&binding)?.view()
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
                    let current = capture(store, &request)?;
                    if let Some(run) = current.recorded_run() {
                        return Ok(ReviewCheckPreparation::Recorded { run: run.clone() });
                    }
                    current
                        .validate_domain_execution_input(&input)
                        .map_err(map_adopt)?;
                    let view = ReviewPluginCheckView {
                        action_id: request.action_id,
                        unit_id: request.unit_id,
                        locale: request.locale.clone(),
                        basis: request.expected_basis.clone(),
                        attempt_id: input.envelope().attempt_id,
                        input_digest: input.digest().into(),
                        plugin,
                    };
                    host.review.preflight = Some(Preflight {
                        prepared,
                        request,
                        input,
                        view: view.clone(),
                        start: None,
                    });
                    Ok(ReviewCheckPreparation::Plugin { view })
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn run_review_checks(
    state: State<'_, AppState>,
    request: ReviewCheckStartRequest,
) -> Result<CheckRun, CommandError> {
    if request.session_token != request.check.session_token
        || request.session_token != request.execution.session_token
        || request.project_id != request.check.project_id
        || request.project_id != request.execution.project_id
    {
        return Err(stale());
    }
    let cancellation = Cancellation::default();
    let registry = Arc::clone(&state.review_check_cancellations);
    {
        let mut checks = registry
            .lock()
            .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?;
        if let Some((session, project, _)) = checks.get(&request.check.action_id) {
            if session != &request.session_token || *project != request.project_id {
                return Err(CommandError::simple(
                    CommandErrorCode::SessionInvalid,
                    CommandStage::ExecutionAdopt,
                ));
            }
            // This invocation has not rejected the original accepted action.
            // Keep its request/grant until the original continuation settles.
            return Err(CommandError::unknown(CommandStage::ExecutionAdopt));
        }
        checks.insert(
            request.check.action_id,
            (
                request.session_token.clone(),
                request.project_id,
                cancellation.clone(),
            ),
        );
    }
    let registration = ReviewCheckRegistration {
        registry,
        action: request.check.action_id,
    };
    let lease = state.sessions.lease(CommandStage::ExecutionAdopt)?;
    let initial = request.clone();
    let token = cancellation.clone();
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
            let prepared = capture(store, &initial.check)?;
            if let Some(run) = prepared.recorded_run() {
                return Ok(Err(run.clone()));
            }
            host.allow_mutation()?;
            if token.is_requested() {
                return Err(cancelled());
            }
            if !initial.execution.unsandboxed_execution {
                return Err(map_adopt(ExecutionError::new(
                    ErrorCode::Unauthorized,
                    "plugin-consent-required",
                )));
            }
            if host.review.jobs.len() >= 2 {
                return Err(CommandError::simple(
                    CommandErrorCode::Busy,
                    CommandStage::ExecutionAdopt,
                ));
            }
            let preflight = host
                .review
                .preflight
                .as_ref()
                .filter(|preflight| {
                    preflight.request == initial.check
                        && preflight.input.envelope().attempt_id == initial.execution.attempt_id
                        && preflight.input.digest() == initial.execution.input_digest
                })
                .ok_or_else(stale)?;
            if preflight
                .start
                .as_ref()
                .is_some_and(|start| start != &initial.execution)
            {
                return Err(stale());
            }
            prepared
                .validate_domain_execution_input(&preflight.input)
                .map_err(map_adopt)?;
            // Preserve the preflight CAS across uncertain enqueue/commit retries.
            // Recapturing its expected prior check could overwrite newer QA.
            let prepared = preflight.prepared.clone();
            let input = preflight.input.clone();
            let started = preflight.start.is_some();
            let binding = prepared.plan().ok_or_else(stale)?.binding().clone();
            host.review.jobs.insert(
                initial.check.action_id,
                Job {
                    cancellation: token,
                    input: input.clone(),
                    prepared: None,
                    reply: None,
                    cancellation_sent: false,
                    cancellation_action: ExecutionId::new(),
                },
            );
            Ok(Ok((prepared, input, binding, started)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
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
        let _registration = registration;
        let work = async {
            let (prepared, input, binding, started) = match admitted.await? {
                Ok(value) => value,
                Err(run) => return Ok(run),
            };
            let loaded = if started {
                None
            } else {
                Some(
                    io.run(CommandStage::ExecutionAdopt, move || {
                        let environment = plugins.capture_review(&binding)?;
                        RunnerProxy::new(
                            environment.package.image().clone(),
                            &environment.binding.declaration.checker,
                            environment.runtime.clone(),
                            environment.staging_parent.clone(),
                            HostLimits::default(),
                        )
                        .map(Arc::new)
                        .map_err(map_adopt)
                    })
                    .await?,
                )
            };
            let (sender, mut receiver) = tauri::async_runtime::channel(1);
            let dispatch_request = request.clone();
            let dispatched_token = cancellation.clone();
            lease
                .run(
                    "run_review_checks.dispatch",
                    CommandStage::ExecutionAdopt,
                    move |sessions| {
                        let active = authorized(
                            sessions,
                            &dispatch_request.session_token,
                            dispatch_request.project_id,
                            CommandStage::ExecutionAdopt,
                        )?;
                        let (host, store) = active.execution_parts()?;
                        host.allow_mutation()?;
                        if dispatched_token.is_requested() {
                            return Err(cancelled());
                        }
                        // Recapture before granting execution, after installed-store IO.
                        capture(store, &dispatch_request.check)?
                            .validate_domain_execution_input(&input)
                            .map_err(map_adopt)?;
                        if let Some(runner) = loaded {
                            host.register_plugin(
                                runner,
                                input.envelope().plugin.clone().ok_or_else(stale)?,
                            )
                            .map_err(map_adopt)?;
                            host.runtime
                                .authorize_plugin(
                                    store,
                                    dispatch_request.execution.grant_id,
                                    &input,
                                    dispatch_request.execution.expires_at_ms.get(),
                                    PluginConsent {
                                        unsandboxed_execution: true,
                                    },
                                )
                                .map_err(map_adopt)?;
                            if let Some(preflight) = &mut host.review.preflight {
                                if preflight.request == dispatch_request.check {
                                    preflight.start = Some(dispatch_request.execution.clone());
                                }
                            }
                        }
                        // Exact replay submits the original channel; it cannot renew its grant.
                        host.runtime.submit(store, &input).map_err(map_adopt)?;
                        let job = host
                            .review
                            .jobs
                            .get_mut(&dispatch_request.check.action_id)
                            .ok_or_else(stale)?;
                        job.prepared = Some(prepared);
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
            let commit_request = request.clone();
            let token = cancellation.clone();
            lease
                .run(
                    "run_review_checks.commit",
                    CommandStage::ExecutionAdopt,
                    move |sessions| {
                        let active = authorized(
                            sessions,
                            &commit_request.session_token,
                            commit_request.project_id,
                            CommandStage::ExecutionAdopt,
                        )?;
                        let (host, store) = active.execution_parts()?;
                        host.allow_mutation()?;
                        store
                            .commit_review_evidence(computed, &token)
                            .map_err(map_adopt)
                    },
                )
                .await
        }
        .await;
        // The same reserved lease guarantees cleanup after any accepted failure.
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
                    let (host, _) = active.execution_parts()?;
                    if let Some(job) = host.review.jobs.remove(&request.check.action_id) {
                        job.cancellation.request();
                    }
                    Ok(())
                },
            )
            .await;
        match work {
            Ok(run) => {
                cleanup?;
                Ok(run)
            }
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
}

#[cfg(test)]
mod tests;
