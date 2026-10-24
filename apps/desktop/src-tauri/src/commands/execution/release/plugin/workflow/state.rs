use super::*;
use crate::commands::{dispatch::BlockingExecutor, plugins::ApplicationPlugins};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::SystemTime;
#[cfg(test)]
mod tests;

pub(super) struct Intent {
    pub view: ArtifactCheckWorkflowView,
    captures: Vec<ArtifactValidationCapture>,
    deadlines: BTreeMap<ExecutionId, Instant>,
    io: BlockingExecutor,
    plugins: Arc<ApplicationPlugins>,
    active: Option<usize>,
    allow_current_proof: bool,
    cancel_actions: BTreeMap<ExecutionId, ExecutionId>,
}
pub(super) struct Retired {
    pub identity: ArtifactCheckWorkflowIdentity,
    pub view: Option<ArtifactCheckWorkflowView>,
}
enum Output {
    Prepared(
        Vec<ArtifactValidationCapture>,
        Vec<ArtifactCheckWorkflowStepView>,
    ),
    Runners(Vec<(Arc<RunnerProxy>, PluginExecutionBinding)>),
    Proof(
        PreparedArtifactValidation,
        SavedArtifactCheckProof,
        ExecutionState,
    ),
}
#[derive(Clone, Copy)]
enum JobKind {
    Prepare,
    Launch(usize),
    Proof(usize),
}
struct Job {
    receiver: Receiver<Result<Output, CommandError>>,
    kind: JobKind,
    work: PackageWork,
}
pub(in crate::commands::execution) struct WorkflowSession {
    pub(super) owner: ExecutionId,
    pub(super) consumed: Revision,
    pub(super) current: Option<Intent>,
    pub(super) retired: Option<Retired>,
    job: Option<Job>,
}
impl Default for WorkflowSession {
    fn default() -> Self {
        Self {
            owner: ExecutionId::new(),
            consumed: Revision::new(0).expect("initial revision"),
            current: None,
            retired: None,
            job: None,
        }
    }
}
fn failure(code: ErrorCode, stage: &'static str) -> CommandError {
    map_recover(ExecutionError::new(code, stage))
}
fn spawn(
    io: BlockingExecutor,
    stage: CommandStage,
    work: impl FnOnce() -> Result<Output, CommandError> + Send + 'static,
) -> Receiver<Result<Output, CommandError>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    // The accepted IO task owns no Store/session. The receiver retains its
    // exact slot until this completed IO outcome is observed by the owner.
    tauri::async_runtime::spawn(async move {
        let output = io.run(stage, work).await;
        let _ = sender.send(output);
    });
    receiver
}
impl WorkflowSession {
    pub(super) fn next(&self) -> Result<Revision, CommandError> {
        self.consumed.next().map_err(map_read)
    }
    pub(in crate::commands::execution) fn busy(&self) -> bool {
        self.job.is_some()
            || self
                .current
                .as_ref()
                .is_some_and(|i| !i.view.admission_closed || !i.view.callbacks_drained)
    }
    pub(super) fn validate_identity(
        &self,
        identity: &ArtifactCheckWorkflowIdentity,
    ) -> Result<(), CommandError> {
        if identity.owner_id != self.owner || identity.generation.get() == 0 {
            return Err(failure(ErrorCode::Unauthorized, "artifact-workflow-owner"));
        }
        Ok(())
    }
    pub(super) fn existing(
        &self,
        p: &ArtifactCheckWorkflowPreparation,
    ) -> Result<Option<ArtifactCheckWorkflowView>, CommandError> {
        self.validate_identity(&p.identity)?;
        let view = self
            .current
            .as_ref()
            .map(|i| &i.view)
            .filter(|v| v.preparation.identity == p.identity)
            .or_else(|| {
                self.retired
                    .as_ref()
                    .and_then(|r| r.view.as_ref())
                    .filter(|v| v.preparation.identity == p.identity)
            });
        if let Some(view) = view {
            if view.preparation != *p {
                return Err(failure(
                    ErrorCode::ResultMismatch,
                    "artifact-workflow-request",
                ));
            }
            return Ok(Some(view.clone()));
        }
        Ok(None)
    }
    pub(super) fn retire_if_drained(&mut self) {
        if self
            .current
            .as_ref()
            .is_some_and(|i| i.view.admission_closed && i.view.callbacks_drained)
            && self.job.is_none()
        {
            let intent = self.current.take().expect("observed intent");
            self.retired = Some(Retired {
                identity: intent.view.preparation.identity.clone(),
                view: Some(intent.view),
            });
        }
    }
    pub(in crate::commands::execution) fn close(&mut self, allow_current_proof: bool) {
        if let Some(intent) = &mut self.current {
            intent.allow_current_proof &= allow_current_proof;
            intent.view.admission_closed = true;
            intent.view.phase = ArtifactCheckWorkflowPhase::Stopped;
            for step in &mut intent.view.steps {
                if matches!(
                    step.phase,
                    ArtifactCheckWorkflowStepPhase::Prepared
                        | ArtifactCheckWorkflowStepPhase::Waiting
                ) {
                    step.phase = ArtifactCheckWorkflowStepPhase::NotStarted;
                }
            }
        }
    }
    pub(in crate::commands::execution) fn stop_package(
        &mut self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) {
        if self
            .current
            .as_ref()
            .is_some_and(|i| i.view.preparation.build.package == *package)
        {
            self.close(false);
        }
    }
    pub(super) fn refresh(
        &mut self,
        store: &ProjectStore,
        runtime: &ExecutionRuntime,
    ) -> Result<(), CommandError> {
        if let Some(intent) = &mut self.current {
            let owned = if let Some(index) = intent.active {
                let step = &intent.view.steps[index].step;
                let present = runtime
                    .input_if_present(store, step.attempt_id)
                    .map_err(map_read)?;
                if present.is_some() {
                    intent.view.current_task = Some(ArtifactCheckWorkflowTask {
                        task_id: step.task_id,
                        attempt_id: step.attempt_id,
                    });
                }
                let queued = present
                    .map(|_| store.execution_attempt(step.attempt_id, true))
                    .transpose()
                    .map_err(map_read)?
                    .is_some_and(|a| {
                        a.items.iter().any(|i| {
                            matches!(
                                i.execution,
                                ExecutionState::Queued | ExecutionState::Dispatched
                            )
                        })
                    });
                runtime.has_owned_attempt_work(step.attempt_id) || queued
            } else {
                false
            };
            intent.view.callbacks_drained = self.job.is_none() && !owned;
            if intent.view.callbacks_drained {
                intent.view.current_task = None;
            }
        }
        Ok(())
    }
    pub(super) fn begin(
        &mut self,
        preparation: ArtifactCheckWorkflowPreparation,
        captures: Vec<ResultValidationCapture>,
        io: BlockingExecutor,
        plugins: Arc<ApplicationPlugins>,
        work: PackageWork,
    ) -> Result<ArtifactCheckWorkflowView, CommandError> {
        self.validate_identity(&preparation.identity)?;
        self.retire_if_drained();
        if self.busy() {
            return Err(failure(ErrorCode::Busy, "artifact-workflow-active"));
        }
        if preparation.identity.generation != self.next()? {
            return Err(failure(
                ErrorCode::Unauthorized,
                "artifact-workflow-generation",
            ));
        }
        self.consumed = preparation.identity.generation;
        let view = ArtifactCheckWorkflowView {
            preparation: preparation.clone(),
            materialization_digest: None,
            phase: ArtifactCheckWorkflowPhase::Preparing,
            start: None,
            steps: vec![],
            admission_closed: false,
            callbacks_drained: false,
            current_task: None,
            error: None,
        };
        let selected = preparation.build.clone();
        let checked_work = work.clone();
        let captured_plugins = plugins.clone();
        let receiver = spawn(io.clone(), CommandStage::ExecutionRead, move || {
            checked_work.check()?;
            let environment = captured_plugins.capture_build(&selected)?;
            // The build plan owns the user's language order. Input frames are
            // normalized by generated item IDs and do not define workflow order.
            let original = captures
                .first()
                .ok_or_else(|| failure(ErrorCode::InvalidInput, "artifact-workflow-order"))?;
            let order: BTreeMap<_, _> = ReleasePlan::from_input(original.input())
                .map_err(map_read)?
                .choices()
                .into_iter()
                .enumerate()
                .map(|(ordinal, choice)| (choice.locale, ordinal))
                .collect();
            let mut captures = captures
                .into_iter()
                .map(|capture| {
                    let item = capture
                        .input()
                        .item(capture.result().envelope().item_id)
                        .map_err(map_read)?;
                    let ordinal = item
                        .scope
                        .locale
                        .as_ref()
                        .and_then(|locale| order.get(locale))
                        .copied()
                        .ok_or_else(|| {
                            failure(ErrorCode::ResultMismatch, "artifact-workflow-order")
                        })?;
                    Ok((ordinal, capture))
                })
                .collect::<Result<Vec<_>, CommandError>>()?;
            captures.sort_by_key(|(ordinal, _)| *ordinal);
            let mut materialized = Vec::new();
            let mut views = Vec::new();
            for (ordinal, capture) in captures {
                checked_work.check()?;
                matches_build(capture.input(), &environment)?;
                let result = capture.result();
                let producer_attempt_id = capture.input().envelope().attempt_id;
                let producer_input_digest = capture.input().digest().to_owned();
                let build_item_id = result.envelope().item_id;
                let build_result_id = result.envelope().result_id;
                let build_result_digest = result.digest().to_owned();
                let captured = capture
                    .prepare_artifact_check(ExecutionId::new())
                    .map_err(map_read)?;
                let input = captured.check_input();
                let payload: sdk::ArtifactCheckInput = serde_json::from_value(
                    input.envelope().items[0].payload.clone(),
                )
                .map_err(|_| failure(ErrorCode::OutputInvalid, "artifact-workflow-payload"))?;
                let step = ArtifactCheckWorkflowStepIdentity {
                    locale: payload.input.target_language.clone(),
                    build_item_id,
                    build_result_id,
                    producer_attempt_id,
                    producer_input_digest,
                    task_id: input.envelope().task_id,
                    attempt_id: input.envelope().attempt_id,
                    input_digest: input.digest().into(),
                };
                let review = ArtifactCheckReview {
                    attempt_id: step.attempt_id,
                    input_digest: step.input_digest.clone(),
                    build_attempt_id: producer_attempt_id,
                    build_result_id,
                    locale: step.locale.clone(),
                    artifacts: payload
                        .output
                        .artifacts
                        .into_iter()
                        .map(|a| CheckedArtifact {
                            id: a.id,
                            role: a.role,
                            logical_path: a.logical_path,
                            byte_length: a.utf8.len() as u32,
                            sha256: a.sha256,
                        })
                        .collect(),
                    requirements: payload.requirements,
                    build: environment.view()?,
                };
                views.push(ArtifactCheckWorkflowStepView {
                    ordinal: ordinal as u32,
                    step,
                    build_result_digest,
                    review,
                    selected: false,
                    phase: ArtifactCheckWorkflowStepPhase::Prepared,
                    proof: None,
                    error: None,
                });
                materialized.push(captured);
            }
            checked_work.check()?;
            Ok(Output::Prepared(materialized, views))
        });
        self.job = Some(Job {
            receiver,
            kind: JobKind::Prepare,
            work,
        });
        self.current = Some(Intent {
            view: view.clone(),
            captures: vec![],
            deadlines: BTreeMap::new(),
            io,
            plugins,
            active: None,
            allow_current_proof: true,
            cancel_actions: BTreeMap::new(),
        });
        Ok(view)
    }

    pub(super) fn start(
        &mut self,
        start: &ArtifactCheckWorkflowStart,
    ) -> Result<ArtifactCheckWorkflowView, CommandError> {
        self.validate_identity(&start.identity)?;
        let intent = self
            .current
            .as_mut()
            .filter(|i| i.view.preparation.identity == start.identity);
        let Some(intent) = intent else {
            if let Some(view) = self
                .retired
                .as_ref()
                .and_then(|r| r.view.as_ref())
                .filter(|v| v.preparation.identity == start.identity)
            {
                if view.start.as_ref() == Some(start) {
                    return Ok(view.clone());
                }
                return Err(failure(
                    ErrorCode::ResultMismatch,
                    "artifact-workflow-start",
                ));
            }
            return Err(failure(
                ErrorCode::Unauthorized,
                "artifact-workflow-generation",
            ));
        };
        if let Some(original) = &intent.view.start {
            return if original == start {
                Ok(intent.view.clone())
            } else {
                Err(failure(
                    ErrorCode::ResultMismatch,
                    "artifact-workflow-start",
                ))
            };
        }
        if intent.view.admission_closed
            || intent.view.phase != ArtifactCheckWorkflowPhase::Prepared
            || intent.view.materialization_digest.as_ref() != Some(&start.materialization_digest)
            || start.consents.is_empty()
            || start.consents.len() > intent.view.steps.len()
        {
            return Err(failure(ErrorCode::Unauthorized, "artifact-workflow-start"));
        }
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| failure(ErrorCode::InvalidInput, "artifact-workflow-clock"))?
            .as_millis();
        let now = Instant::now();
        let mut seen = std::collections::BTreeSet::new();
        let mut grants = std::collections::BTreeSet::new();
        let mut deadlines = BTreeMap::new();
        for consent in &start.consents {
            if !consent.unsandboxed_execution
                || !grants.insert(consent.grant_id)
                || !seen.insert(consent.step.attempt_id)
                || !intent.view.steps.iter().any(|s| s.step == consent.step)
                || consent.expires_at_ms.get() as u128 <= now_ms
                || consent.expires_at_ms.get() > i64::MAX as u64
            {
                return Err(failure(
                    ErrorCode::Unauthorized,
                    "artifact-workflow-consent",
                ));
            }
            let remaining =
                (consent.expires_at_ms.get() as u128 - now_ms).min(u64::MAX as u128) as u64;
            let deadline = now
                .checked_add(Duration::from_millis(remaining))
                .ok_or_else(|| failure(ErrorCode::InvalidInput, "artifact-workflow-deadline"))?;
            deadlines.insert(consent.step.attempt_id, deadline);
        }
        for step in &mut intent.view.steps {
            step.selected = seen.contains(&step.step.attempt_id);
            step.phase = if step.selected {
                ArtifactCheckWorkflowStepPhase::Waiting
            } else {
                ArtifactCheckWorkflowStepPhase::NotSelected
            };
        }
        intent.deadlines = deadlines;
        intent.view.start = Some(start.clone());
        intent.view.phase = ArtifactCheckWorkflowPhase::Running;
        Ok(intent.view.clone())
    }

    fn pause(&mut self, index: Option<usize>, error: CommandError) {
        if let Some(intent) = &mut self.current {
            intent.view.admission_closed = true;
            if intent.view.phase != ArtifactCheckWorkflowPhase::Stopped {
                intent.view.phase = ArtifactCheckWorkflowPhase::Paused;
            }
            intent.view.error = Some(error.clone());
            if let Some(index) = index {
                let step = &mut intent.view.steps[index];
                step.error = Some(error.clone());
                if step.phase != ArtifactCheckWorkflowStepPhase::Proved {
                    step.phase = match error.code {
                        CommandErrorCode::OutcomeUnknown => ArtifactCheckWorkflowStepPhase::Unknown,
                        CommandErrorCode::Cancelled => ArtifactCheckWorkflowStepPhase::Cancelled,
                        _ => ArtifactCheckWorkflowStepPhase::Failed,
                    };
                }
            }
            for step in &mut intent.view.steps {
                if step.phase == ArtifactCheckWorkflowStepPhase::Waiting {
                    step.phase = ArtifactCheckWorkflowStepPhase::NotStarted;
                }
            }
        }
    }

    pub(super) fn tick(
        &mut self,
        host: &mut ExecutionHost,
        store: &mut ProjectStore,
    ) -> Result<(), CommandError> {
        let result = self.tick_inner(host, store);
        if let Err(error) = &result {
            self.pause(None, error.clone());
        }
        result
    }
    pub(super) fn prepare_runtime_tick(
        &mut self,
        store: &mut ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<Option<(Arc<ApplicationPlugins>, UnsignedDecimal)>, CommandError> {
        let Some(intent) = &mut self.current else {
            return Ok(None);
        };
        let Some(index) = intent.active else {
            return Ok(None);
        };
        let step = &intent.view.steps[index];
        if !matches!(
            step.phase,
            ArtifactCheckWorkflowStepPhase::Enqueued | ArtifactCheckWorkflowStepPhase::Recording
        ) && !runtime.has_owned_attempt_work(step.step.attempt_id)
        {
            return Ok(None);
        }
        let plugins = intent.plugins.clone();
        let revision = step.review.build.settings_revision;
        if let Err(error) = plugins.with_environment_revision(revision, || Ok(())) {
            if matches!(
                error.code,
                CommandErrorCode::Busy
                    | CommandErrorCode::StorageFailed
                    | CommandErrorCode::OutcomeUnknown
            ) {
                return Err(error);
            }
            intent.allow_current_proof = false;
            intent.view.admission_closed = true;
            let consent = intent
                .view
                .start
                .as_ref()
                .expect("accepted start")
                .consents
                .iter()
                .find(|c| c.step == step.step)
                .expect("accepted member");
            runtime
                .revoke_plugin(store, consent.grant_id)
                .map_err(map_recover)?;
            if runtime
                .input_if_present(store, step.step.attempt_id)
                .map_err(map_read)?
                .is_some()
            {
                let action = *intent
                    .cancel_actions
                    .entry(step.step.attempt_id)
                    .or_insert_with(ExecutionId::new);
                runtime
                    .cancel(store, step.step.task_id, action)
                    .map_err(map_recover)?;
            }
            self.pause(Some(index), error);
            return Ok(None);
        }
        Ok(Some((plugins, revision)))
    }
    fn tick_inner(
        &mut self,
        host: &mut ExecutionHost,
        store: &mut ProjectStore,
    ) -> Result<(), CommandError> {
        if host.quiescing {
            self.close(false);
        }
        let outcome = if let Some(job) = &self.job {
            match job.receiver.try_recv() {
                Ok(output) => Some(output),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => {
                    Some(Err(CommandError::unknown(CommandStage::ExecutionRecover)))
                }
            }
        } else {
            None
        };
        if let Some(outcome) = outcome {
            let job = self.job.take().expect("observed job");
            let index = match job.kind {
                JobKind::Prepare => None,
                JobKind::Launch(i) | JobKind::Proof(i) => Some(i),
            };
            let allowed = self.current.as_ref().is_some_and(|intent| match job.kind {
                JobKind::Proof(_) => intent.allow_current_proof && !host.quiescing,
                _ => !intent.view.admission_closed && !host.quiescing,
            });
            if allowed {
                let outcome = job.work.check().and_then(|_| outcome);
                match outcome {
                    Ok(Output::Prepared(captures, views)) => {
                        let intent = self.current.as_mut().expect("owned preparation");
                        let bytes = serde_json::to_vec(&(intent.view.preparation.clone(), &views))
                            .map_err(|_| {
                                failure(ErrorCode::InvalidInput, "artifact-workflow-digest")
                            })?;
                        intent.view.materialization_digest =
                            Some(tsumugi_core::content::artifact_digest(&bytes));
                        intent.view.steps = views;
                        intent.captures = captures;
                        intent.view.phase = ArtifactCheckWorkflowPhase::Prepared;
                    }
                    Ok(Output::Runners(runners)) => {
                        let index = index.expect("launch index");
                        let (input, consent, plugins, revision, deadline) = {
                            let intent = self.current.as_ref().expect("owned launch");
                            let step = &intent.view.steps[index];
                            let consent = intent
                                .view
                                .start
                                .as_ref()
                                .expect("accepted start")
                                .consents
                                .iter()
                                .find(|c| c.step == step.step)
                                .expect("accepted member")
                                .clone();
                            (
                                intent.captures[index].check_input().clone(),
                                consent,
                                intent.plugins.clone(),
                                step.review.build.settings_revision,
                                intent.deadlines[&step.step.attempt_id],
                            )
                        };
                        let enqueued = plugins.with_environment_revision(revision, || {
                            host.allow_mutation()?;
                            job.work.check()?;
                            if Instant::now() >= deadline {
                                return Err(failure(
                                    ErrorCode::Unauthorized,
                                    "artifact-workflow-expired",
                                ));
                            }
                            let intent = self.current.as_ref().expect("owned launch");
                            let p = &intent.view.preparation;
                            let current = store
                                .capture_artifact_check_workflow(
                                    input.envelope().project_id,
                                    p.build_attempt_id,
                                    &p.build_input_digest,
                                    &p.build_results,
                                )
                                .map_err(map_recover)?;
                            if current.len() != intent.view.steps.len()
                                || current.iter().any(|capture| {
                                    intent
                                        .view
                                        .steps
                                        .iter()
                                        .find(|step| {
                                            step.step.build_item_id
                                                == capture.result().envelope().item_id
                                        })
                                        .is_none_or(|step| {
                                            capture.input().envelope().attempt_id
                                                != step.step.producer_attempt_id
                                                || capture.input().digest()
                                                    != step.step.producer_input_digest
                                                || capture.result().envelope().result_id
                                                    != step.step.build_result_id
                                                || capture.result().digest()
                                                    != step.build_result_digest
                                        })
                                })
                            {
                                return Err(failure(
                                    ErrorCode::DependencyConflict,
                                    "artifact-workflow-producer",
                                ));
                            }
                            for (runner, binding) in runners {
                                host.register_plugin(runner, binding).map_err(map_recover)?;
                            }
                            host.runtime
                                .authorize_plugin_with_deadline(
                                    store,
                                    consent.grant_id,
                                    &input,
                                    consent.expires_at_ms.get(),
                                    PluginConsent {
                                        unsandboxed_execution: true,
                                        application_execution: false,
                                    },
                                    deadline,
                                )
                                .map_err(map_recover)?;
                            // Once this call is attempted, no tick or repeated Start
                            // may authorize or submit it a second time.
                            host.runtime.submit(store, &input).map_err(map_recover)
                        });
                        let intent = self.current.as_mut().expect("owned launch");
                        intent.view.steps[index].phase = ArtifactCheckWorkflowStepPhase::Enqueued;
                        if host
                            .runtime
                            .input_if_present(store, input.envelope().attempt_id)
                            .map_err(map_read)?
                            .is_some()
                        {
                            intent.view.current_task = Some(ArtifactCheckWorkflowTask {
                                task_id: input.envelope().task_id,
                                attempt_id: input.envelope().attempt_id,
                            });
                        }
                        if let Err(error) = enqueued {
                            self.pause(Some(index), error);
                        }
                    }
                    Ok(Output::Proof(prepared, proof, execution)) => {
                        let index = index.expect("proof index");
                        let intent = self.current.as_ref().expect("owned proof");
                        let revision = intent.view.steps[index].review.build.settings_revision;
                        let plugins = intent.plugins.clone();
                        match plugins.with_environment_revision(revision, || {
                            job.work.check()?;
                            store
                                .commit_artifact_validation(prepared)
                                .map_err(map_adopt)
                        }) {
                            Ok(()) => {
                                let valid = proof.valid;
                                let step =
                                    &mut self.current.as_mut().expect("owned proof").view.steps
                                        [index];
                                step.phase = if valid {
                                    ArtifactCheckWorkflowStepPhase::Proved
                                } else if execution == ExecutionState::Unknown {
                                    ArtifactCheckWorkflowStepPhase::Unknown
                                } else {
                                    ArtifactCheckWorkflowStepPhase::Failed
                                };
                                step.proof = Some(proof);
                                if !valid {
                                    self.pause(
                                        Some(index),
                                        failure(
                                            if execution == ExecutionState::Unknown {
                                                ErrorCode::OutcomeUnknown
                                            } else {
                                                ErrorCode::OutputInvalid
                                            },
                                            "artifact-workflow-checks",
                                        ),
                                    );
                                }
                            }
                            Err(error) => self.pause(Some(index), error),
                        }
                    }
                    Err(error) => {
                        self.pause(index, error);
                        if matches!(job.kind, JobKind::Prepare) {
                            self.current.as_mut().expect("owned preparation").view.phase =
                                ArtifactCheckWorkflowPhase::Failed;
                        }
                    }
                }
            }
        }
        self.refresh(store, &host.runtime)?;
        self.advance(host, store)?;
        self.refresh(store, &host.runtime)?;
        self.retire_if_drained();
        Ok(())
    }

    fn advance(
        &mut self,
        host: &mut ExecutionHost,
        store: &mut ProjectStore,
    ) -> Result<(), CommandError> {
        if self.job.is_some() {
            return Ok(());
        }
        let Some(intent) = &self.current else {
            return Ok(());
        };
        if let Some(index) = intent.active {
            let phase = intent.view.steps[index].phase;
            if phase == ArtifactCheckWorkflowStepPhase::Enqueued
                && intent.allow_current_proof
                && !host.quiescing
            {
                let input = intent.captures[index].check_input();
                let view = match host.runtime.attempt(store, input.envelope().attempt_id) {
                    Ok(view) => view,
                    Err(error) => {
                        self.pause(Some(index), map_read(error));
                        return Ok(());
                    }
                };
                let status = &view.items[0];
                match status.execution {
                    ExecutionState::Queued | ExecutionState::Dispatched => return Ok(()),
                    ExecutionState::Succeeded
                    | ExecutionState::Failed
                    | ExecutionState::Unknown
                        if !status.cancellation_requested =>
                    {
                        let Some(result_id) = store
                            .execution_current_result(input.envelope().attempt_id, status.item_id)
                            .map_err(map_read)?
                        else {
                            self.pause(
                                Some(index),
                                failure(ErrorCode::OutcomeUnknown, "artifact-workflow-result"),
                            );
                            return Ok(());
                        };
                        let result = store
                            .execution_result(input.envelope().attempt_id, result_id)
                            .map_err(map_read)?;
                        let captured = intent.captures[index].clone();
                        let io = intent.io.clone();
                        let package = intent.view.preparation.build.package.clone();
                        let work = host.begin_package_work(vec![package])?;
                        let check_work = work.clone();
                        let receiver = spawn(io, CommandStage::ExecutionAdopt, move || {
                            check_work.check()?;
                            let input = captured.check_input().clone();
                            let prepared = captured.prepare(result.clone()).map_err(map_adopt)?;
                            let checks = match result
                                .envelope()
                                .plugin
                                .as_ref()
                                .map(|p| &p.result.outcome)
                            {
                                Some(sdk::InvocationOutcome::Succeeded { output }) => {
                                    match sdk::parse_check_results(output.utf8.as_bytes()) {
                                        Ok(checks) => Some(checks),
                                        Err(_) if !prepared.valid() => None,
                                        Err(_) => {
                                            return Err(failure(
                                                ErrorCode::CorruptLedger,
                                                "artifact-workflow-report",
                                            ));
                                        }
                                    }
                                }
                                _ if !prepared.valid() => None,
                                _ => {
                                    return Err(failure(
                                        ErrorCode::CorruptLedger,
                                        "artifact-workflow-report",
                                    ));
                                }
                            };
                            let proof = SavedArtifactCheckProof {
                                checker_attempt_id: input.envelope().attempt_id,
                                checker_input_digest: input.digest().into(),
                                checker_result_id: result.envelope().result_id,
                                checker_result_digest: result.digest().into(),
                                checker: input.envelope().plugin.clone().expect("captured checker"),
                                valid: prepared.valid(),
                                checks,
                            };
                            check_work.check()?;
                            Ok(Output::Proof(prepared, proof, result.envelope().outcome))
                        });
                        self.job = Some(Job {
                            receiver,
                            kind: JobKind::Proof(index),
                            work,
                        });
                        self.current.as_mut().expect("owned step").view.steps[index].phase =
                            ArtifactCheckWorkflowStepPhase::Recording;
                        return Ok(());
                    }
                    _ => {
                        let code = if status.cancellation_requested
                            || status.execution == ExecutionState::CancelledBeforeDispatch
                        {
                            ErrorCode::Cancelled
                        } else if status.execution == ExecutionState::Unknown {
                            ErrorCode::OutcomeUnknown
                        } else {
                            ErrorCode::OutputInvalid
                        };
                        self.pause(Some(index), failure(code, "artifact-workflow-outcome"));
                        return Ok(());
                    }
                }
            }
            if !intent.view.callbacks_drained {
                return Ok(());
            }
            self.current.as_mut().expect("owned step").active = None;
        }
        let intent = self.current.as_ref().expect("retained intent");
        if intent.view.admission_closed || intent.view.phase != ArtifactCheckWorkflowPhase::Running
        {
            return Ok(());
        }
        let Some(index) = intent
            .view
            .steps
            .iter()
            .position(|s| s.phase == ArtifactCheckWorkflowStepPhase::Waiting)
        else {
            let intent = self.current.as_mut().expect("owned completed intent");
            intent.view.phase = ArtifactCheckWorkflowPhase::Completed;
            intent.view.admission_closed = true;
            intent.view.current_task = None;
            return Ok(());
        };
        let input = intent.captures[index].check_input().clone();
        let expected = intent.view.steps[index].review.build.clone();
        let selected = intent.view.preparation.build.clone();
        let plugins = intent.plugins.clone();
        let io = intent.io.clone();
        let work = match host.begin_package_work(vec![selected.package.clone()]) {
            Ok(work) => work,
            Err(error) => {
                self.pause(Some(index), error);
                return Ok(());
            }
        };
        let checked_work = work.clone();
        let receiver = spawn(io, CommandStage::ExecutionRecover, move || {
            checked_work.check()?;
            let environment = plugins.capture_build(&selected)?;
            if environment.view()? != expected
                || input.envelope().plugin.as_ref() != Some(&binding(&environment, true)?)
            {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "artifact-workflow-environment",
                ));
            }
            let mut runners = Vec::new();
            for (id, checker) in [
                (&environment.binding.declaration.builder, false),
                (&environment.binding.declaration.checker, true),
            ] {
                let runner = RunnerProxy::new(
                    environment.package.image().clone(),
                    id,
                    environment.runtime.clone(),
                    environment.staging_parent.clone(),
                    HostLimits::default(),
                )
                .map_err(map_recover)?;
                runners.push((Arc::new(runner), binding(&environment, checker)?));
            }
            checked_work.check()?;
            Ok(Output::Runners(runners))
        });
        self.job = Some(Job {
            receiver,
            kind: JobKind::Launch(index),
            work,
        });
        let intent = self.current.as_mut().expect("owned launch");
        intent.active = Some(index);
        intent.view.current_task = None;
        intent.view.callbacks_drained = false;
        Ok(())
    }
}
