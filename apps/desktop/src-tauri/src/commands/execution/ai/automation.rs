//! Authorized selection orchestration owns values and action identities, not a store.
use super::*;
use tsumugi_core::{
    ComputedAutomaticSelection, PreparedAutomaticSelection, ReviewCheckOrigin, ReviewCheckerKey,
    application::{AutomaticSelectionReceipt, AutomaticSelectionRequest, SelectionPolicy},
};

const MAX_COMPUTATIONS: usize = 2;

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectPhase {
    Waiting,
    SavingCandidate,
    Checking,
    Selected,
    Blocked,
    Failed,
    Cancelled,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectView {
    pub phase: EffectPhase,
    pub action_id: Option<ExecutionId>,
    pub receipt: Option<AutomaticSelectionReceipt>,
    pub error: Option<CommandError>,
    pub retryable: bool,
}
struct Item {
    candidate_action: ExecutionId,
    selection_action: ExecutionId,
    revision: Option<ExecutionId>,
    view: EffectView,
    checker: Option<CheckerAttempt>,
}
struct CheckerChannel {
    key: ReviewCheckerKey,
    input: FixedInput,
    grant_id: ExecutionId,
    cancel_action: ExecutionId,
    cancellation_sent: bool,
    submitted: bool,
}
struct CheckerAttempt {
    prepared: PreparedAutomaticSelection,
    channels: Vec<CheckerChannel>,
    expires_at_ms: u64,
    cancellation: Cancellation,
    pending: bool,
}

struct Attempt {
    input: FixedInput,
    items: BTreeMap<ExecutionId, Item>,
    consent: Option<work_plans::CheckerConsent>,
}
enum Computed {
    Candidate(PreparedAdoption),
    Selection(ComputedAutomaticSelection),
}
struct Job {
    attempt: ExecutionId,
    item: ExecutionId,
    cancellation: Cancellation,
    receiver: mpsc::Receiver<Result<Computed, ExecutionError>>,
    thread: JoinHandle<()>,
}
#[derive(Default)]
pub(super) struct Automation {
    attempts: BTreeMap<ExecutionId, Attempt>,
    jobs: Vec<Job>,
    retired: Vec<(ExecutionId, JoinHandle<()>)>,
    #[cfg(test)]
    pub(super) compute_probe: Option<review::ComputeProbe>,
}
fn phase_for(receipt: &AutomaticSelectionReceipt) -> EffectPhase {
    if receipt.blocked.is_some() {
        EffectPhase::Blocked
    } else {
        EffectPhase::Selected
    }
}
fn failure(item: &mut Item, error: ExecutionError) {
    command_failure(item, map_adopt(error));
}
fn command_failure(item: &mut Item, error: CommandError) {
    item.view.phase = if error.code == CommandErrorCode::Cancelled {
        EffectPhase::Cancelled
    } else {
        EffectPhase::Failed
    };
    item.view.retryable = matches!(
        error.code,
        CommandErrorCode::Busy | CommandErrorCode::StorageFailed | CommandErrorCode::OutcomeUnknown
    );
    item.view.error = Some(error);
}
fn cancel_channels(
    checker: &mut CheckerAttempt,
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
) -> Result<(), ExecutionError> {
    for channel in checker
        .channels
        .iter_mut()
        .filter(|channel| channel.submitted && !channel.cancellation_sent)
    {
        // Submission can fail after its durable enqueue. Revoke the existing
        // grant even when no attempt frame was written; never invent a result.
        runtime.revoke_plugin(store, channel.grant_id)?;
        match store.execution_input(channel.input.envelope().attempt_id) {
            Ok(_) => {
                runtime.cancel(
                    store,
                    channel.input.envelope().task_id,
                    channel.cancel_action,
                )?;
            }
            Err(error)
                if error.code == ErrorCode::InvalidInput && error.stage == "execution-storage" => {}
            Err(error) => return Err(error),
        }
        channel.cancellation_sent = true;
    }
    checker.pending = false;
    Ok(())
}
pub(in crate::commands::execution) fn commit_candidate(
    store: &mut ProjectStore,
    prepared: PreparedAdoption,
    attempt: ExecutionId,
    item: ExecutionId,
) -> Result<ExecutionId, ExecutionError> {
    match store.commit_execution_adoption(prepared) {
        Ok(receipt) => {
            let change = receipt
                .changes
                .iter()
                .find(|change| change.kind == "translation-revision")
                .ok_or_else(|| {
                    ExecutionError::new(ErrorCode::CorruptLedger, "work-effect-candidate")
                })?;
            ExecutionId::parse(&change.id)
        }
        // A human-facing save of the same exact current result can win while
        // preparation runs. Read that ordinary candidate without a second write.
        // Revocation, changed inputs and uncertain commits never use this path.
        Err(error)
            if error.code == ErrorCode::ResultMismatch && error.stage == "adoption-result" =>
        {
            store.saved_ai_candidate(attempt, item)?.ok_or(error)
        }
        Err(error) => Err(error),
    }
}
impl Automation {
    fn depends_on(
        attempt: &Attempt,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) -> bool {
        package_lifecycle::matches_input(package, &attempt.input)
            || attempt.consent.as_ref().is_some_and(|consent| {
                consent
                    .bindings
                    .iter()
                    .any(|checker| package_lifecycle::binding_package(&checker.binding) == *package)
            })
            || attempt.items.values().any(|item| {
                item.checker.as_ref().is_some_and(|checker| {
                    checker
                        .channels
                        .iter()
                        .any(|channel| package_lifecycle::matches_input(package, &channel.input))
                })
            })
    }
    pub(super) fn stop_package(
        &mut self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) {
        let ids: Vec<_> = self
            .attempts
            .iter()
            .filter(|(_, attempt)| Self::depends_on(attempt, package))
            .map(|(id, _)| *id)
            .collect();
        for job in self.jobs.iter().filter(|job| ids.contains(&job.attempt)) {
            job.cancellation.request();
        }
        for id in ids {
            for item in self
                .attempts
                .get_mut(&id)
                .expect("captured attempt")
                .items
                .values_mut()
            {
                if let Some(checker) = &item.checker {
                    checker.cancellation.request();
                }
                if matches!(
                    item.view.phase,
                    EffectPhase::Waiting | EffectPhase::SavingCandidate | EffectPhase::Checking
                ) || (item.view.phase == EffectPhase::Failed
                    && item.view.retryable
                    && item.view.receipt.is_none())
                {
                    item.view.phase = EffectPhase::Cancelled;
                    item.view.retryable = false;
                }
            }
        }
    }
    pub(super) fn package_active(
        &self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) -> bool {
        let owns = |id: ExecutionId| {
            self.attempts
                .get(&id)
                .is_some_and(|attempt| Self::depends_on(attempt, package))
        };
        self.jobs.iter().any(|job| owns(job.attempt))
            || self.retired.iter().any(|(id, _)| owns(*id))
            || self
                .attempts
                .values()
                .filter(|attempt| Self::depends_on(attempt, package))
                .any(|attempt| {
                    attempt.items.values().any(|item| {
                        item.view.phase == EffectPhase::Waiting
                            || item.checker.as_ref().is_some_and(|checker| checker.pending)
                    })
                })
    }
    pub(super) fn track(
        &mut self,
        store: &ProjectStore,
        input: &FixedInput,
        consent: Option<work_plans::CheckerConsent>,
    ) -> Result<(), ExecutionError> {
        let Some(lease) = input.envelope().automation else {
            return Ok(());
        };
        store.check_work_plan_input(input)?;
        let plan = store.work_plan(lease.plan_id)?;
        if plan.options.selection_policy == SelectionPolicy::CandidatesOnly {
            return Ok(());
        }
        let bindings = store.work_plan_review_checkers(&plan)?;
        if !bindings.is_empty() {
            if consent
                .as_ref()
                .is_none_or(|consent| consent.lease != lease || consent.bindings != bindings)
            {
                return Err(ExecutionError::new(
                    ErrorCode::Unauthorized,
                    "plugin-consent-required",
                ));
            }
        }
        self.attempts
            .entry(input.envelope().attempt_id)
            .or_insert_with(|| Attempt {
                input: input.clone(),
                consent,
                items: input
                    .envelope()
                    .items
                    .iter()
                    .map(|item| {
                        (
                            item.item_id,
                            Item {
                                candidate_action: ExecutionId::new(),
                                selection_action: ExecutionId::new(),
                                revision: None,
                                checker: None,
                                view: EffectView {
                                    phase: EffectPhase::Waiting,
                                    action_id: None,
                                    receipt: None,
                                    error: None,
                                    retryable: false,
                                },
                            },
                        )
                    })
                    .collect(),
            });
        Ok(())
    }
    pub(super) fn active(&self) -> bool {
        !self.jobs.is_empty()
            || !self.retired.is_empty()
            || self.attempts.values().any(|attempt| {
                attempt.items.values().any(|item| {
                    item.view.phase == EffectPhase::Waiting
                        || item.checker.as_ref().is_some_and(|check| check.pending)
                })
            })
    }
    pub(super) fn stop(&mut self) {
        for job in &self.jobs {
            job.cancellation.request();
        }
        for attempt in self.attempts.values_mut() {
            for item in attempt.items.values_mut() {
                if let Some(checker) = &item.checker {
                    checker.cancellation.request();
                }
                if matches!(
                    item.view.phase,
                    EffectPhase::Waiting | EffectPhase::SavingCandidate | EffectPhase::Checking
                ) {
                    item.view.phase = EffectPhase::Cancelled;
                    item.view.retryable = false;
                }
            }
        }
    }
    pub(super) fn view(&self, attempt: ExecutionId, item: ExecutionId) -> Option<EffectView> {
        self.attempts
            .get(&attempt)?
            .items
            .get(&item)
            .map(|item| item.view.clone())
    }
    pub(super) fn retry(
        &mut self,
        store: &ProjectStore,
        attempt: ExecutionId,
        item: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let attempt = self
            .attempts
            .get_mut(&attempt)
            .ok_or_else(|| ExecutionError::new(ErrorCode::Unauthorized, "work-effect-session"))?;
        store.check_work_plan_input(&attempt.input)?;
        let item = attempt
            .items
            .get_mut(&item)
            .ok_or_else(|| ExecutionError::new(ErrorCode::Unauthorized, "work-effect-scope"))?;
        if !item.view.retryable {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "work-effect-retry",
            ));
        }
        // Keep both original identities. The next capture reads their durable
        // receipt before preparing any mutation, including an uncertain commit.
        item.view.phase = EffectPhase::Waiting;
        item.view.error = None;
        item.view.retryable = false;
        Ok(())
    }
    /// Check application authority before the ordinary runtime can dispatch
    /// queued checker inputs. Historical receipts do not recreate that authority.
    pub(super) fn prepare_runtime_tick(
        &mut self,
        store: &mut ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<Option<work_plans::CheckerConsent>, CommandError> {
        let mut dispatch_consent = None;
        for (id, attempt) in &mut self.attempts {
            let controlled = store
                .check_work_plan_input(&attempt.input)
                .map_err(map_adopt);
            let needs_authority = attempt.items.values().any(|item| {
                item.view.receipt.is_none()
                    && (matches!(
                        item.view.phase,
                        EffectPhase::Waiting | EffectPhase::SavingCandidate | EffectPhase::Checking
                    ) || item
                        .checker
                        .as_ref()
                        .is_some_and(|checker| !checker.cancellation.is_requested()))
            });
            let authority = if controlled.is_ok() && needs_authority {
                match &attempt.consent {
                    Some(consent) => consent.with_current_environment(|| Ok(())),
                    None => Ok(()),
                }
            } else {
                controlled
            };
            if let Err(error) = authority {
                if matches!(
                    error.code,
                    CommandErrorCode::Busy
                        | CommandErrorCode::StorageFailed
                        | CommandErrorCode::OutcomeUnknown
                ) {
                    return Err(error);
                }
                for job in self.jobs.iter().filter(|job| job.attempt == *id) {
                    job.cancellation.request();
                }
                for (item_id, item) in &mut attempt.items {
                    if item.view.receipt.is_some() {
                        continue;
                    }
                    // An uncertain selection commit can already have a durable
                    // receipt. Reconcile it before withdrawing future authority.
                    if let Some(lease) = attempt.input.envelope().automation {
                        if let Some(revision) =
                            store.saved_ai_candidate(*id, *item_id).map_err(map_adopt)?
                        {
                            if let Some(receipt) = store
                                .automatic_selection_for_candidate(lease, revision)
                                .map_err(map_adopt)?
                            {
                                item.revision = Some(revision);
                                item.view.action_id = Some(receipt.request.action_id);
                                item.view.phase = phase_for(&receipt);
                                item.view.receipt = Some(receipt);
                                item.view.error = None;
                                item.view.retryable = false;
                                continue;
                            }
                        }
                    }
                    if let Some(checker) = &item.checker {
                        checker.cancellation.request();
                    }
                    command_failure(item, error.clone());
                    item.view.retryable = false;
                }
            }
            for item in attempt.items.values_mut() {
                if let Some(checker) = &mut item.checker {
                    if checker.cancellation.is_requested() {
                        cancel_channels(checker, store, runtime).map_err(map_adopt)?;
                        if item.view.phase != EffectPhase::Failed && item.view.receipt.is_none() {
                            item.view.phase = EffectPhase::Cancelled;
                            item.view.retryable = false;
                        }
                    } else if item.view.receipt.is_none()
                        && checker
                            .channels
                            .iter()
                            .any(|channel| channel.submitted && !channel.cancellation_sent)
                    {
                        dispatch_consent = attempt.consent.clone();
                    }
                }
            }
        }
        Ok(dispatch_consent)
    }
    pub(super) fn tick(&mut self, store: &mut ProjectStore, runtime: &mut ExecutionRuntime) {
        let mut remaining = Vec::new();
        for (id, thread) in self.retired.drain(..) {
            if thread.is_finished() {
                let _ = thread.join();
            } else {
                remaining.push((id, thread));
            }
        }
        self.retired = remaining;
        // Control is checked before accepting results or dispatching another checker.
        for (id, attempt) in &mut self.attempts {
            if let Err(error) = store.check_work_plan_input(&attempt.input) {
                for job in self.jobs.iter().filter(|job| job.attempt == *id) {
                    job.cancellation.request();
                }
                for item in attempt.items.values_mut() {
                    if let Some(checker) = &item.checker {
                        checker.cancellation.request();
                    }
                    if matches!(
                        item.view.phase,
                        EffectPhase::Waiting | EffectPhase::SavingCandidate | EffectPhase::Checking
                    ) {
                        failure(item, error.clone());
                        item.view.retryable = false;
                    }
                }
            }
        }
        let mut index = 0;
        while index < self.jobs.len() {
            let result = match self.jobs[index].receiver.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Disconnected) => Some(Err(ExecutionError::new(
                    ErrorCode::StorageFailed,
                    "work-effect-worker",
                ))),
                Err(mpsc::TryRecvError::Empty) => None,
            };
            let Some(result) = result else {
                index += 1;
                continue;
            };
            let job = self.jobs.remove(index);
            self.retired.push((job.attempt, job.thread));
            let Some(attempt) = self.attempts.get_mut(&job.attempt) else {
                continue;
            };
            let consent = attempt.consent.clone();
            let Some(item) = attempt.items.get_mut(&job.item) else {
                continue;
            };
            if job.cancellation.is_requested() {
                continue;
            }
            let commit = || {
                result
                    .and_then(|computed| match computed {
                        Computed::Candidate(prepared) => {
                            commit_candidate(store, prepared, job.attempt, job.item).map(
                                |revision| {
                                    item.revision = Some(revision);
                                    item.view.phase = EffectPhase::Waiting;
                                },
                            )
                        }
                        Computed::Selection(computed) => store
                            .commit_automatic_selection(computed, &job.cancellation)
                            .map(|receipt| {
                                item.view.phase = phase_for(&receipt);
                                item.view.receipt = Some(receipt);
                            }),
                    })
                    .map_err(map_adopt)
            };
            let result = match consent {
                Some(consent) => consent.with_current_environment(commit),
                None => commit(),
            };
            if let Err(error) = result {
                command_failure(item, error);
            }
        }
        // The ordinary runtime owns native execution and its cancellation. Only
        // owned evidence leaves the project thread for Core/domain computation.
        for (attempt_id, attempt) in &mut self.attempts {
            for (item_id, item) in &mut attempt.items {
                let Some(checker) = item.checker.as_mut() else {
                    continue;
                };
                if checker.cancellation.is_requested() {
                    let cancelled = cancel_channels(checker, store, runtime);
                    if let Err(error) = cancelled {
                        failure(item, error);
                        continue;
                    }
                    checker.pending = false;
                    if item.view.phase != EffectPhase::Failed {
                        item.view.phase = EffectPhase::Cancelled;
                    }
                    item.view.retryable = false;
                    continue;
                }
                if !checker.pending {
                    continue;
                }
                let observed: Result<Option<Vec<ReviewCheckOrigin>>, ExecutionError> = (|| {
                    let mut origins = Vec::with_capacity(checker.channels.len());
                    for channel in &checker.channels {
                        let status = runtime.attempt(store, channel.input.envelope().attempt_id)?;
                        let detail = status.items.first().ok_or_else(|| {
                            ExecutionError::new(ErrorCode::CorruptLedger, "work-check-item")
                        })?;
                        if matches!(
                            detail.execution,
                            ExecutionState::Queued | ExecutionState::Dispatched
                        ) {
                            return Ok(None);
                        }
                        let result = store
                            .execution_current_result(
                                channel.input.envelope().attempt_id,
                                detail.item_id,
                            )?
                            .ok_or_else(|| {
                                ExecutionError::new(
                                    ErrorCode::OutcomeUnknown,
                                    "work-check-execution",
                                )
                            })?;
                        origins.push(ReviewCheckOrigin {
                            checker: channel.key.clone(),
                            attempt_id: channel.input.envelope().attempt_id,
                            result_id: result,
                        });
                    }
                    Ok(Some(origins))
                })(
                );
                let origins = match observed {
                    Ok(None) => continue,
                    Ok(Some(origins)) => origins,
                    Err(error)
                        if matches!(
                            error.code,
                            ErrorCode::Busy | ErrorCode::StorageFailed | ErrorCode::OutcomeUnknown
                        ) =>
                    {
                        checker.pending = false;
                        failure(item, error);
                        continue;
                    }
                    Err(error) => {
                        checker.pending = false;
                        failure(item, error);
                        continue;
                    }
                };
                if self.jobs.len() >= MAX_COMPUTATIONS {
                    continue;
                }
                checker.pending = false;
                let capture = || {
                    store
                        .capture_automatic_selection_execution(checker.prepared.clone(), &origins)
                        .map_err(map_adopt)
                };
                let captured = match &attempt.consent {
                    Some(consent) => consent.with_current_environment(capture),
                    None => capture(),
                };
                let captured = match captured {
                    Ok(captured) => captured,
                    Err(error) => {
                        command_failure(item, error);
                        continue;
                    }
                };
                let cancellation = checker.cancellation.clone();
                let cancel = cancellation.clone();
                let (sender, receiver) = mpsc::sync_channel(1);
                #[cfg(test)]
                let probe = self
                    .compute_probe
                    .take_if(|probe| probe.action == *attempt_id);
                match std::thread::Builder::new()
                    .name("work-plan-check".into())
                    .spawn(move || {
                        #[cfg(test)]
                        if let Some(probe) = probe {
                            probe.reached.send(()).unwrap();
                            probe.release.recv_timeout(Duration::from_secs(10)).unwrap();
                        }
                        let _ = sender.send(captured.compute(&cancel).map(Computed::Selection));
                    }) {
                    Ok(thread) => {
                        item.view.phase = EffectPhase::Checking;
                        item.view.error = None;
                        self.jobs.push(Job {
                            attempt: *attempt_id,
                            item: *item_id,
                            cancellation,
                            receiver,
                            thread,
                        });
                    }
                    Err(_) => failure(
                        item,
                        ExecutionError::new(ErrorCode::StorageFailed, "work-effect-worker"),
                    ),
                }
            }
        }
        let mut occupied = self.jobs.len()
            + self
                .attempts
                .values()
                .flat_map(|attempt| attempt.items.values())
                .filter(|item| item.checker.as_ref().is_some_and(|checker| checker.pending))
                .count();
        for (attempt_id, attempt) in &mut self.attempts {
            if occupied >= MAX_COMPUTATIONS {
                break;
            }
            let status = match store.execution_attempt(*attempt_id, runtime.is_active(*attempt_id))
            {
                Ok(status) => status,
                Err(error) => {
                    for item in attempt
                        .items
                        .values_mut()
                        .filter(|item| item.view.phase == EffectPhase::Waiting)
                    {
                        failure(item, error.clone());
                    }
                    continue;
                }
            };
            for (item_id, item) in &mut attempt.items {
                if occupied >= MAX_COMPUTATIONS {
                    break;
                }
                if item.view.phase != EffectPhase::Waiting {
                    continue;
                }
                let Some(status) = status
                    .items
                    .iter()
                    .find(|status| status.item_id == *item_id)
                else {
                    continue;
                };
                if status.execution != ExecutionState::Succeeded {
                    if !matches!(
                        status.execution,
                        ExecutionState::Queued | ExecutionState::Dispatched
                    ) {
                        failure(
                            item,
                            ExecutionError::new(
                                ErrorCode::OutputInvalid,
                                "work-effect-no-candidate",
                            ),
                        );
                    }
                    continue;
                }
                let consent = attempt.consent.clone();
                let mut launch = || {
                    let input = &attempt.input;
                    let result = store
                        .execution_current_result(*attempt_id, *item_id)?
                        .ok_or_else(|| {
                            ExecutionError::new(ErrorCode::CorruptLedger, "work-effect-result")
                        })?;
                    item.revision = store.saved_ai_candidate(*attempt_id, *item_id)?;
                    if let Some(revision) = item.revision {
                        let payload = tsumugi_core::ai::item_payload(input, *item_id)?;
                        let request = AutomaticSelectionRequest {
                            project_id: input.envelope().project_id,
                            action_id: item.selection_action,
                            lease: input.envelope().automation.unwrap(),
                            unit_id: payload.unit_id,
                            locale: payload.target_locale,
                            revision_id: revision,
                        };
                        if let Some(receipt) =
                            store.automatic_selection_for_candidate(request.lease, revision)?
                        {
                            item.view.phase = phase_for(&receipt);
                            item.view.action_id = Some(receipt.request.action_id);
                            item.view.receipt = Some(receipt);
                            return Ok(None);
                        }
                        let prepared = match &item.checker {
                            Some(checker) => checker.prepared.clone(),
                            None => store.prepare_automatic_selection(&request)?,
                        };
                        item.view.phase = EffectPhase::Checking;
                        item.view.action_id = Some(item.selection_action);
                        if let Some(plan) = prepared.review_check().and_then(|check| check.plan()) {
                            let consent = attempt
                                .consent
                                .as_ref()
                                .filter(|consent| {
                                    consent.lease == request.lease
                                        && consent.bindings == plan.checkers()
                                })
                                .ok_or_else(|| {
                                    ExecutionError::new(
                                        ErrorCode::Unauthorized,
                                        "plugin-consent-required",
                                    )
                                })?;
                            if item.checker.is_none() {
                                let now = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map_err(|_| {
                                        ExecutionError::new(
                                            ErrorCode::StorageFailed,
                                            "work-check-clock",
                                        )
                                    })?
                                    .as_millis();
                                let now = u64::try_from(now).map_err(|_| {
                                    ExecutionError::new(
                                        ErrorCode::StorageFailed,
                                        "work-check-clock",
                                    )
                                })?;
                                let expires_at_ms =
                                    consent.expires_at_ms.min(now.saturating_add(600_000));
                                if expires_at_ms <= now {
                                    return Err(ExecutionError::new(
                                        ErrorCode::Cancelled,
                                        "work-plan-control",
                                    ));
                                }
                                let check = prepared.review_check().unwrap();
                                let channels = check
                                    .plan()
                                    .unwrap()
                                    .checkers()
                                    .iter()
                                    .zip(check.execution_inputs())
                                    .map(|(binding, input)| CheckerChannel {
                                        key: binding.key.clone(),
                                        input: input.clone(),
                                        grant_id: ExecutionId::new(),
                                        cancel_action: ExecutionId::new(),
                                        cancellation_sent: false,
                                        submitted: false,
                                    })
                                    .collect();
                                item.checker = Some(CheckerAttempt {
                                    prepared,
                                    channels,
                                    expires_at_ms,
                                    cancellation: Cancellation::default(),
                                    pending: false,
                                });
                            }
                            let checker = item.checker.as_mut().unwrap();
                            if checker.cancellation.is_requested() {
                                return Err(ExecutionError::new(
                                    ErrorCode::Cancelled,
                                    "work-check-cancelled",
                                ));
                            }
                            for channel in &mut checker.channels {
                                // Each exact channel retains its independent grant and deadline.
                                if !channel.submitted {
                                    runtime.authorize_plugin(
                                        store,
                                        channel.grant_id,
                                        &channel.input,
                                        checker.expires_at_ms,
                                        PluginConsent {
                                            unsandboxed_execution: true,
                                        },
                                    )?;
                                    channel.submitted = true;
                                }
                                runtime.submit(store, &channel.input)?;
                            }
                            checker.pending = true;
                            return Ok(None);
                        }
                        let cancellation = Cancellation::default();
                        let cancel = cancellation.clone();
                        let (sender, receiver) = mpsc::sync_channel(1);
                        let thread = std::thread::Builder::new()
                            .name("work-plan-check".into())
                            .spawn(move || {
                                let _ =
                                    sender.send(prepared.compute(&cancel).map(Computed::Selection));
                            })
                            .map_err(|_| {
                                ExecutionError::new(ErrorCode::StorageFailed, "work-effect-worker")
                            })?;
                        Ok(Some(Job {
                            attempt: *attempt_id,
                            item: *item_id,
                            cancellation,
                            receiver,
                            thread,
                        }))
                    } else {
                        let unit = input
                            .envelope()
                            .units
                            .iter()
                            .find(|unit| unit.item_ids == [*item_id])
                            .ok_or_else(|| {
                                ExecutionError::new(ErrorCode::Unauthorized, "work-effect-unit")
                            })?;
                        let action = store.prepare_adoption_with_id(
                            item.candidate_action,
                            *attempt_id,
                            unit.unit_id,
                            vec![result],
                            serde_json::Value::Null,
                        )?;
                        let capture = store.capture_execution_adoption(&action)?;
                        item.view.phase = EffectPhase::SavingCandidate;
                        item.view.action_id = Some(item.candidate_action);
                        let cancellation = Cancellation::default();
                        let (sender, receiver) = mpsc::sync_channel(1);
                        let thread = std::thread::Builder::new()
                            .name("work-plan-candidate".into())
                            .spawn(move || {
                                let _ = sender.send(
                                    capture
                                        .prepare(&tsumugi_core::AiAdoptionHandler)
                                        .map(Computed::Candidate),
                                );
                            })
                            .map_err(|_| {
                                ExecutionError::new(ErrorCode::StorageFailed, "work-effect-worker")
                            })?;
                        Ok(Some(Job {
                            attempt: *attempt_id,
                            item: *item_id,
                            cancellation,
                            receiver,
                            thread,
                        }))
                    }
                };
                let launch = match consent {
                    Some(consent) => {
                        consent.with_current_environment(|| launch().map_err(map_adopt))
                    }
                    None => launch().map_err(map_adopt),
                };
                match launch {
                    Ok(Some(job)) => {
                        self.jobs.push(job);
                        occupied += 1;
                    }
                    Ok(None) => {
                        if item.checker.as_ref().is_some_and(|checker| checker.pending) {
                            occupied += 1;
                        }
                    }
                    Err(error) => command_failure(item, error),
                }
            }
        }
    }
}
impl Drop for Automation {
    fn drop(&mut self) {
        self.stop();
    }
}
