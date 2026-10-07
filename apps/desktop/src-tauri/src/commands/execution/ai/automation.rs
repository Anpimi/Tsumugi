//! Authorized selection orchestration owns values and action identities, not a store.
use super::*;
use tsumugi_core::{
    ComputedAutomaticSelection, PreparedAutomaticSelection, ReviewCheckOrigin, ReviewCheckerKey,
    application::{
        AutomaticSelectionReceipt, AutomaticSelectionRequest, PreparedWorkPlanServiceGeneration,
        SelectionPolicy,
    },
};

const MAX_COMPUTATIONS: usize = 2;

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectPhase {
    Waiting,
    SavingCandidate,
    Saved,
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
    service_origin: ServiceOriginState,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServiceOriginState {
    Untracked,
    Retained,
    Released,
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

/// Hold the original owner through a bounded enqueue. All fallible reads and
/// effect identities are prepared first; dropping this value changes no state.
/// An unknown enqueue retains the same identities for later reconciliation,
/// without claiming that a durable child exists or restoring any authority.
#[must_use = "commit only after the guarded runtime enqueue succeeds or has an unknown outcome"]
pub(in crate::commands::execution) struct PreparedTracking<'a> {
    automation: &'a mut Automation,
    pending: Option<(ExecutionId, Attempt)>,
}

impl PreparedTracking<'_> {
    pub(in crate::commands::execution) fn commit(self) {
        if let Some((id, attempt)) = self.pending {
            // The exclusive owner borrow prevents another track from inserting
            // this identity between preparation and the successful enqueue.
            self.automation.attempts.insert(id, attempt);
        }
    }
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
fn checker_channel_unsettled(
    store: &ProjectStore,
    runtime: &ExecutionRuntime,
    input: &FixedInput,
) -> Result<bool, ExecutionError> {
    let child = input.envelope().attempt_id;
    if runtime
        .input_if_present(store, child)?
        .is_some_and(|stored| stored.bytes() != input.bytes())
    {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "work-check-attempt",
        ));
    }
    // Authorization can precede a failed submit. Explicitly absent inputs have
    // no queued effects, but the Runtime still checks owned producer handles.
    runtime.has_unsettled_attempt(store, child)
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
    pub(super) fn track(
        &mut self,
        store: &ProjectStore,
        input: &FixedInput,
        consent: Option<work_plans::CheckerConsent>,
    ) -> Result<(), ExecutionError> {
        self.prepare_tracking(store, input, consent)?.commit();
        Ok(())
    }

    /// Prepare tracking for input accepted by the original execution ledger.
    /// The caller keeps the original session and settings guard throughout.
    pub(super) fn prepare_tracking<'a>(
        &'a mut self,
        store: &ProjectStore,
        input: &FixedInput,
        consent: Option<work_plans::CheckerConsent>,
    ) -> Result<PreparedTracking<'a>, ExecutionError> {
        self.prepare_tracking_with(store, input, consent, || store.check_work_plan_input(input))
    }

    /// The sealed Core proposal supplies the original service authority before
    /// its child is queued. Only an accepted or unknown original enqueue can
    /// commit these identities; a historical receipt cannot recreate tracking.
    pub(super) fn prepare_service_tracking<'a>(
        &'a mut self,
        store: &ProjectStore,
        prepared: &PreparedWorkPlanServiceGeneration,
        consent: Option<work_plans::CheckerConsent>,
    ) -> Result<PreparedTracking<'a>, ExecutionError> {
        let mut tracking = self.prepare_tracking_with(store, prepared.input(), consent, || {
            store.check_prepared_work_plan_service_generation(prepared)
        })?;
        if let Some((_, attempt)) = &mut tracking.pending {
            attempt.service_origin = ServiceOriginState::Retained;
        }
        Ok(tracking)
    }

    fn prepare_tracking_with<'a>(
        &'a mut self,
        store: &ProjectStore,
        input: &FixedInput,
        consent: Option<work_plans::CheckerConsent>,
        validate: impl FnOnce() -> Result<(), ExecutionError>,
    ) -> Result<PreparedTracking<'a>, ExecutionError> {
        let id = input.envelope().attempt_id;
        if self
            .attempts
            .get(&id)
            .is_some_and(|attempt| attempt.input.bytes() != input.bytes())
        {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "work-effect-attempt",
            ));
        }
        let Some(lease) = input.envelope().automation else {
            return Ok(PreparedTracking {
                automation: self,
                pending: None,
            });
        };
        validate()?;
        let plan = store.work_plan(lease.plan_id)?;
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
        let pending = if self.attempts.contains_key(&id) {
            // Reconciliation keeps the original consent, actions and effects.
            // In particular, it cannot replace a cancelled attempt's authority.
            None
        } else {
            Some((
                id,
                Attempt {
                    input: input.clone(),
                    consent,
                    service_origin: ServiceOriginState::Untracked,
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
                },
            ))
        };
        Ok(PreparedTracking {
            automation: self,
            pending,
        })
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
    pub(super) fn release_terminal_service_origins(
        &mut self,
        store: &ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<(), ExecutionError> {
        for (id, attempt) in &mut self.attempts {
            if attempt.service_origin != ServiceOriginState::Retained
                || self.jobs.iter().any(|job| job.attempt == *id)
                || self.retired.iter().any(|(attempt, _)| attempt == id)
            {
                continue;
            }
            let Some(input) = runtime.input_if_present(store, *id)? else {
                // An unknown enqueue may not yet have a confirmed ledger entry.
                continue;
            };
            if input.bytes() != attempt.input.bytes() {
                return Err(ExecutionError::new(
                    ErrorCode::ResultMismatch,
                    "work-effect-attempt",
                ));
            }
            if runtime.has_unsettled_attempt(store, *id)? {
                continue;
            }
            let mut settled = true;
            for item in attempt.items.values() {
                if item.view.retryable
                    || item
                        .view
                        .error
                        .as_ref()
                        .is_some_and(|error| error.code == CommandErrorCode::OutcomeUnknown)
                    || !matches!(
                        item.view.phase,
                        EffectPhase::Saved
                            | EffectPhase::Selected
                            | EffectPhase::Blocked
                            | EffectPhase::Cancelled
                            | EffectPhase::Failed
                    )
                {
                    settled = false;
                    break;
                }
                let Some(checker) = &item.checker else {
                    continue;
                };
                if checker.pending {
                    settled = false;
                    break;
                }
                for channel in checker.channels.iter().filter(|channel| channel.submitted) {
                    if checker_channel_unsettled(store, runtime, &channel.input)? {
                        settled = false;
                        break;
                    }
                }
                if !settled {
                    break;
                }
            }
            if settled {
                store.release_work_plan_service_origin(*id)?;
                attempt.service_origin = ServiceOriginState::Released;
            }
        }
        Ok(())
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
            // Released children retain their completed effect view as history.
            // Their withdrawn authority must not turn completion into failure.
            if attempt.service_origin == ServiceOriginState::Released {
                continue;
            }
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
        self.retired.retain(|(_, thread)| !thread.is_finished());
        // Control is checked before accepting results or dispatching another checker.
        for (id, attempt) in &mut self.attempts {
            if attempt.service_origin == ServiceOriginState::Released {
                continue;
            }
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
            if attempt.service_origin == ServiceOriginState::Released {
                continue;
            }
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
            if attempt.service_origin == ServiceOriginState::Released {
                continue;
            }
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
                        if store
                            .work_plan(input.envelope().automation.unwrap().plan_id)?
                            .options
                            .selection_policy
                            == SelectionPolicy::CandidatesOnly
                        {
                            // Saving is an independently authorized effect. A
                            // candidate-only plan never requests checks or selection.
                            item.view.phase = EffectPhase::Saved;
                            return Ok(None);
                        }
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

#[cfg(test)]
mod tracking_tests {
    use super::*;
    use tsumugi_core::{
        ProjectMetadata,
        application::{
            AgentGenerationRequest, AuthorizeWorkPlan, AutomationEffect, ControlWorkPlan,
            PlanOptions, WorkPlanCommand,
        },
        content::{SourceAdoptionHandler, SourceBundle, SourceRunner},
    };

    struct Fixture {
        _directory: tempfile::TempDir,
        store: ProjectStore,
        input: FixedInput,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let mut store = ProjectStore::create(
                directory.path().join("project"),
                ProjectMetadata::create("Tracking test", "en-US", ["zh-CN"]).unwrap(),
            )
            .unwrap();
            let mut runtime = ExecutionRuntime::new(&store).unwrap();
            runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
            let source = SourceBundle::capture(
                br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
                br#"{"first":"Hello"}"#,
                "en-US",
            )
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
            runtime.submit(&mut store, &source).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while runtime.has_active_work(&store).unwrap() {
                runtime.tick(&mut store).unwrap();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            let result = store
                .execution_current_result(
                    source.envelope().attempt_id,
                    source.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
            let preview = store
                .source_preview(source.envelope().attempt_id, result, 0, 1)
                .unwrap();
            let action = store
                .prepare_adoption_with_id(
                    ExecutionId::new(),
                    source.envelope().attempt_id,
                    source.envelope().units[0].unit_id,
                    vec![result],
                    serde_json::to_value(preview.confirmation).unwrap(),
                )
                .unwrap();
            store
                .adopt_execution(&action, &SourceAdoptionHandler)
                .unwrap();
            let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
            let unit = store.source_content(snapshot, 0, 1).unwrap().rows[0]
                .unit_id
                .unwrap();
            let plan = store
                .prepare_work_plan(
                    Some(AiConfig {
                        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                        model: "synthetic-model".into(),
                        credential_env: String::new(),
                        max_requests: 2,
                        ..AiConfig::default()
                    }),
                    "zh-CN",
                    &[unit],
                    PlanOptions::default(),
                )
                .unwrap();
            assert!(store.work_plan_review_checkers(&plan).unwrap().is_empty());
            let expires_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 600;
            let grant = store
                .authorize_work_plan(
                    &plan,
                    &AuthorizeWorkPlan {
                        action_id: ExecutionId::new(),
                        plan_digest: plan.digest.clone(),
                        confirmed: true,
                        effects: vec![AutomationEffect::SaveCandidate],
                        expires_at,
                    },
                )
                .unwrap();
            let input = FixedInput::capture(grant.input.unwrap()).unwrap();
            // No AI runner is registered or ticked. These tests exercise only
            // the original ledger and the in-memory tracking boundary.
            store.enqueue_execution(&input).unwrap();
            Self {
                _directory: directory,
                store,
                input,
            }
        }

        fn bytes(&self) -> Vec<u8> {
            std::fs::read(self.store.directory().join("project.sqlite3")).unwrap()
        }
    }

    #[test]
    fn abandoned_tracking_preparation_changes_neither_owner_nor_ledger() {
        let fixture = Fixture::new();
        let mut automation = Automation::default();
        let before = fixture.bytes();
        let sequence = fixture.store.execution_sequence().unwrap();
        let prepared = automation
            .prepare_tracking(&fixture.store, &fixture.input, None)
            .unwrap();
        assert!(prepared.pending.is_some());
        drop(prepared);
        assert!(automation.attempts.is_empty());
        assert!(automation.jobs.is_empty());
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.store.execution_sequence().unwrap(), sequence);
    }

    #[test]
    fn prepared_tracking_commit_requires_no_further_store_read() {
        let fixture = Fixture::new();
        let mut automation = Automation::default();
        let prepared = automation
            .prepare_tracking(&fixture.store, &fixture.input, None)
            .unwrap();
        // Prove the commit seam is memory-only; a caller must still perform its
        // real guarded enqueue successfully before invoking it.
        fixture.store.close().unwrap();
        prepared.commit();
        let attempt = &automation.attempts[&fixture.input.envelope().attempt_id];
        assert_eq!(attempt.input.bytes(), fixture.input.bytes());
        assert_eq!(attempt.items.len(), fixture.input.envelope().items.len());
        assert!(
            attempt
                .items
                .values()
                .all(|item| item.view.phase == EffectPhase::Waiting)
        );
    }

    #[test]
    fn child_tracking_commits_only_after_the_original_runtime_accepts_enqueue() {
        let mut fixture = Fixture::new();
        let scope = fixture
            .store
            .work_plan_agent_scope(fixture.input.envelope().automation.unwrap())
            .unwrap();
        let request = AgentGenerationRequest {
            task_id: ExecutionId::new(),
            attempt_id: ExecutionId::new(),
            unit_ids: fixture
                .store
                .work_plan(scope.lease().plan_id)
                .unwrap()
                .selection_basis
                .iter()
                .map(|basis| basis.unit_id)
                .collect(),
        };
        let child = fixture
            .store
            .prepare_work_plan_agent_generation(&scope, &request)
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&fixture.store).unwrap();
        let mut automation = Automation::default();
        let sequence = fixture.store.execution_sequence().unwrap();
        let prepared = automation
            .prepare_tracking_with(&fixture.store, &child, None, || {
                fixture
                    .store
                    .prepare_work_plan_agent_generation(&scope, &request)
                    .map(|_| ())
            })
            .unwrap();
        // The real runtime rejects a missing producer before its durable enqueue.
        let error = runtime
            .submit_child(&mut fixture.store, &child, scope.parent_task())
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.stage, "capability");
        drop(prepared);
        assert!(automation.attempts.is_empty());
        assert_eq!(fixture.store.execution_sequence().unwrap(), sequence);
        assert!(fixture.store.execution_input(request.attempt_id).is_err());

        runtime
            .register(Arc::new(tsumugi_core::ai::AiRunner::with_service(
                Arc::default(),
            )))
            .unwrap();
        let prepared = automation
            .prepare_tracking_with(&fixture.store, &child, None, || {
                fixture
                    .store
                    .prepare_work_plan_agent_generation(&scope, &request)
                    .map(|_| ())
            })
            .unwrap();
        let candidate_action = prepared.pending.as_ref().unwrap().1.items
            [&child.envelope().items[0].item_id]
            .candidate_action;
        runtime
            .submit_child(&mut fixture.store, &child, scope.parent_task())
            .unwrap();
        prepared.commit();
        assert_eq!(
            fixture
                .store
                .execution_input(request.attempt_id)
                .unwrap()
                .bytes(),
            child.bytes()
        );
        let attempt = &automation.attempts[&request.attempt_id];
        assert_eq!(attempt.input.bytes(), child.bytes());
        assert_eq!(
            attempt.items[&child.envelope().items[0].item_id].candidate_action,
            candidate_action
        );
        // The queued child is never ticked, so no model request can be sent.
    }

    #[test]
    fn revoked_plan_fails_preparation_without_a_tracking_slot() {
        let mut fixture = Fixture::new();
        let lease = fixture.input.envelope().automation.unwrap();
        fixture
            .store
            .control_work_plan(&ControlWorkPlan {
                action_id: ExecutionId::new(),
                plan_id: lease.plan_id,
                expected_generation: lease.generation,
                command: WorkPlanCommand::Pause,
                confirmed: false,
                expires_at: None,
            })
            .unwrap();
        let before = fixture.bytes();
        let mut automation = Automation::default();
        let error = automation
            .prepare_tracking(&fixture.store, &fixture.input, None)
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(automation.attempts.is_empty());
        assert_eq!(fixture.bytes(), before);
    }

    #[test]
    fn tracking_reconciliation_preserves_original_consent_actions_and_cancelled_effect() {
        let fixture = Fixture::new();
        let mut automation = Automation::default();
        // This plan has no checker slots. The values distinguish memory
        // retention without claiming that a checker approval was captured.
        let original = work_plans::CheckerConsent {
            lease: fixture.input.envelope().automation.unwrap(),
            bindings: Vec::new(),
            expires_at_ms: 1,
            settings_revision: UnsignedDecimal::from(0),
            plugins: Arc::default(),
        };
        automation
            .track(&fixture.store, &fixture.input, Some(original.clone()))
            .unwrap();
        let id = fixture.input.envelope().attempt_id;
        let item_id = fixture.input.envelope().items[0].item_id;
        let item = automation
            .attempts
            .get_mut(&id)
            .unwrap()
            .items
            .get_mut(&item_id)
            .unwrap();
        let candidate_action = item.candidate_action;
        let selection_action = item.selection_action;
        item.view.phase = EffectPhase::Cancelled;
        item.view.action_id = Some(candidate_action);
        let replacement = work_plans::CheckerConsent {
            expires_at_ms: 2,
            settings_revision: UnsignedDecimal::from(1),
            plugins: Arc::default(),
            ..original.clone()
        };
        automation
            .prepare_tracking(&fixture.store, &fixture.input, Some(replacement))
            .unwrap()
            .commit();
        let attempt = &automation.attempts[&id];
        let consent = attempt.consent.as_ref().unwrap();
        assert_eq!(consent.expires_at_ms, original.expires_at_ms);
        assert_eq!(consent.settings_revision, original.settings_revision);
        assert!(Arc::ptr_eq(&consent.plugins, &original.plugins));
        let item = &attempt.items[&item_id];
        assert_eq!(item.candidate_action, candidate_action);
        assert_eq!(item.selection_action, selection_action);
        assert_eq!(item.view.phase, EffectPhase::Cancelled);
        assert_eq!(item.view.action_id, Some(candidate_action));
        assert!(!item.view.retryable);

        let mut envelope = fixture.input.envelope().clone();
        envelope.items[0].payload["trackingConflict"] = serde_json::json!(true);
        let conflict = FixedInput::capture(envelope).unwrap();
        let error = automation
            .prepare_tracking(&fixture.store, &conflict, Some(original))
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::ResultMismatch);
        assert_eq!(error.stage, "work-effect-attempt");
        assert_eq!(
            automation.attempts[&id].input.bytes(),
            fixture.input.bytes()
        );
        assert_eq!(
            automation.attempts[&id].items[&item_id].candidate_action,
            candidate_action
        );
        assert_eq!(
            automation.attempts[&id].items[&item_id].selection_action,
            selection_action
        );
        assert_eq!(
            automation.attempts[&id].items[&item_id].view.phase,
            EffectPhase::Cancelled
        );
    }

    mod service_lifecycle {
        use super::*;
        use tsumugi_core::application::{WorkPlanServiceCall, WorkPlanServiceOrigin};
        use tsumugi_plugin_sdk as sdk;

        struct MetadataRunner(PluginExecutionBinding);
        impl Runner for MetadataRunner {
            fn capability_id(&self) -> &str {
                &self.0.capability.declaration.contract.id
            }
            fn capability_version(&self) -> &str {
                "1:1"
            }
            fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
                Some(&self.0.capability.provider)
            }
            fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
                Some(&self.0.environment)
            }
            fn run(
                &self,
                _: DispatchRequest,
                _: Cancellation,
                _: ResultSender,
            ) -> Result<(), ExecutionError> {
                Err(ExecutionError::new(
                    ErrorCode::Unauthorized,
                    "metadata-only-fixture",
                ))
            }
        }

        struct ServiceFixture {
            fixture: Fixture,
            runtime: ExecutionRuntime,
            origin: WorkPlanServiceOrigin,
            source_unit: ExecutionId,
        }
        impl ServiceFixture {
            fn new() -> Self {
                let mut fixture = Fixture::new();
                let scope = fixture
                    .store
                    .work_plan_agent_scope(fixture.input.envelope().automation.unwrap())
                    .unwrap();
                let source_unit = fixture
                    .store
                    .work_plan(scope.lease().plan_id)
                    .unwrap()
                    .selection_basis[0]
                    .unit_id;
                let wire: serde_json::Value = serde_json::from_str(include_str!(
                    "../../../../../test/fixtures/pluginGenerationComponent.contract.json"
                ))
                .unwrap();
                let view: crate::commands::plugins::PluginGenerationComponentView =
                    serde_json::from_value(wire["view"].clone()).unwrap();
                let binding = PluginExecutionBinding {
                    capability: view.binding,
                    profile: view.profile,
                    environment: view.environment,
                };
                let mut runtime = ExecutionRuntime::new(&fixture.store).unwrap();
                runtime
                    .register(Arc::new(MetadataRunner(binding.clone())))
                    .unwrap();
                runtime
                    .register(Arc::new(tsumugi_core::ai::AiRunner::with_service(
                        Arc::default(),
                    )))
                    .unwrap();
                let payload = sdk::GenerationServiceInput {
                    task_id: ExecutionId::new().to_string(),
                    attempt_id: ExecutionId::new().to_string(),
                    unit_ids: vec![source_unit.to_string()],
                };
                let mut envelope = InputEnvelope::new(
                    fixture.store.metadata().unwrap().project_id(),
                    "generation-component",
                    &binding.capability.declaration.contract.id,
                    &binding.capability_version(),
                    vec![InputItem::new(
                        Scope {
                            kind: "generation-component".into(),
                            id: "synthetic-generation".into(),
                            locale: None,
                        },
                        serde_json::to_value(payload).unwrap(),
                        vec![],
                    )],
                )
                .unwrap();
                envelope.plugin = Some(binding.clone());
                let outer = FixedInput::capture(envelope).unwrap();
                let expires_at = u64::try_from(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis(),
                )
                .unwrap()
                    + 60_000;
                runtime
                    .authorize_plugin(
                        &mut fixture.store,
                        ExecutionId::new(),
                        &outer,
                        expires_at,
                        PluginConsent {
                            unsandboxed_execution: true,
                        },
                    )
                    .unwrap();
                runtime.submit(&mut fixture.store, &outer).unwrap();
                let dispatch = fixture
                    .store
                    .dispatch_execution_item(
                        outer.envelope().attempt_id,
                        outer.envelope().items[0].item_id,
                    )
                    .unwrap();
                let selected = binding.capability.provider;
                let provider = sdk::ProviderBinding {
                    plugin: selected.plugin,
                    component_id: selected.component_id,
                    contribution_id: selected.contribution_id,
                    package_digest: selected.package_digest,
                    instance_id: "synthetic-channel".into(),
                    activation_generation: 1,
                };
                let invocation = outer
                    .plugin_request(dispatch.item_id, dispatch.dispatch_token, &provider)
                    .unwrap();
                let service = sdk::ServiceBinding {
                    handle_id: "generation-service".into(),
                    provider_id: "synthetic-generator".into(),
                    contract: sdk::generation_service_contract(),
                    input_schema: sdk::generation_service_input_contract(),
                    output_schema: sdk::generation_service_receipt_contract(),
                    error_schema: sdk::generation_service_error_contract(),
                    effect: sdk::EffectKind::External,
                    project_id: invocation.context.project_id.clone(),
                    scope_id: invocation.context.scope_id.clone(),
                    activation_generation: 1,
                    configuration_digest: "d".repeat(64),
                    limits: binding.capability.declaration.limits,
                };
                let origin = fixture
                    .store
                    .capture_work_plan_service_origin(
                        &scope,
                        &dispatch,
                        &invocation,
                        &service,
                        dispatch.deadline().unwrap(),
                        &Cancellation::default(),
                        &Cancellation::default(),
                    )
                    .unwrap();
                Self {
                    fixture,
                    runtime,
                    origin,
                    source_unit,
                }
            }

            fn prepare(&self, call_id: &str) -> PreparedWorkPlanServiceGeneration {
                let input = sdk::GenerationServiceInput {
                    task_id: ExecutionId::new().to_string(),
                    attempt_id: ExecutionId::new().to_string(),
                    unit_ids: vec![self.source_unit.to_string()],
                };
                self.fixture
                    .store
                    .prepare_work_plan_service_generation(
                        &self.origin,
                        &WorkPlanServiceCall {
                            handle_id: "generation-service".into(),
                            call_id: call_id.into(),
                            input: sdk::EncodedPayload::capture(
                                sdk::generation_service_input_contract(),
                                serde_json::to_string(&input).unwrap(),
                            )
                            .unwrap(),
                        },
                    )
                    .unwrap()
            }

            fn enqueue(
                &mut self,
                automation: &mut Automation,
                prepared: &PreparedWorkPlanServiceGeneration,
            ) {
                let tracking = automation
                    .prepare_service_tracking(&self.fixture.store, prepared, None)
                    .unwrap();
                self.runtime
                    .submit_work_plan_service_child(&mut self.fixture.store, prepared)
                    .unwrap();
                tracking.commit();
            }

            fn fail(&mut self, input: &FixedInput) {
                let item = input.envelope().items[0].item_id;
                let dispatch = self
                    .fixture
                    .store
                    .dispatch_execution_item(input.envelope().attempt_id, item)
                    .unwrap();
                let result = FixedResult::capture(
                    ResultEnvelope {
                        plugin: None,
                        project_id: input.envelope().project_id,
                        attempt_id: input.envelope().attempt_id,
                        item_id: item,
                        result_id: ExecutionId::new(),
                        supersedes: None,
                        dispatch_token: dispatch.dispatch_token,
                        capability_id: input.envelope().capability_id.clone(),
                        capability_version: input.envelope().capability_version.clone(),
                        outcome: ExecutionState::Failed,
                        output: None,
                        diagnostic: Some(Diagnostic {
                            code: "synthetic-known-failure".into(),
                            retry_safe: false,
                        }),
                    },
                    input,
                    dispatch.dispatch_token,
                )
                .unwrap();
                self.fixture.store.save_execution_result(&result).unwrap();
            }

            fn release(&mut self, automation: &mut Automation) -> Result<(), ExecutionError> {
                automation.release_terminal_service_origins(&self.fixture.store, &mut self.runtime)
            }
        }

        #[test]
        fn service_release_is_per_child_and_preserves_another_queued_child() {
            let mut fixture = ServiceFixture::new();
            let mut automation = Automation::default();
            let first = fixture.prepare("first-child");
            let second = fixture.prepare("second-child");
            fixture.enqueue(&mut automation, &first);
            fixture.enqueue(&mut automation, &second);
            let first_id = first.input().envelope().attempt_id;
            let second_id = second.input().envelope().attempt_id;
            fixture.fail(first.input());
            fixture.release(&mut automation).unwrap();
            assert_eq!(
                automation.attempts[&first_id].service_origin,
                ServiceOriginState::Retained,
                "effects still wait for tracking"
            );
            automation.tick(&mut fixture.fixture.store, &mut fixture.runtime);
            assert!(automation.active(), "the other child still waits");
            fixture.release(&mut automation).unwrap();
            assert_eq!(
                automation.attempts[&first_id].service_origin,
                ServiceOriginState::Released
            );
            assert_eq!(
                automation.attempts[&second_id].service_origin,
                ServiceOriginState::Retained
            );
            let item = first.input().envelope().items[0].item_id;
            let completed = serde_json::to_value(automation.view(first_id, item).unwrap()).unwrap();
            automation
                .prepare_runtime_tick(&mut fixture.fixture.store, &mut fixture.runtime)
                .unwrap();
            automation.tick(&mut fixture.fixture.store, &mut fixture.runtime);
            fixture.release(&mut automation).unwrap();
            assert_eq!(
                serde_json::to_value(automation.view(first_id, item).unwrap()).unwrap(),
                completed
            );
            assert!(
                fixture
                    .fixture
                    .store
                    .check_work_plan_input(first.input())
                    .is_err()
            );
            fixture
                .fixture
                .store
                .check_work_plan_input(second.input())
                .unwrap();
            let mut historical = Automation::default();
            assert!(
                historical
                    .prepare_service_tracking(&fixture.fixture.store, &first, None)
                    .is_err()
            );
            assert!(historical.attempts.is_empty());
        }

        #[test]
        fn service_release_keeps_unknown_execution_and_retryable_effects_when_idle() {
            let mut fixture = ServiceFixture::new();
            let mut automation = Automation::default();
            let prepared = fixture.prepare("unknown-child");
            fixture.enqueue(&mut automation, &prepared);
            let id = prepared.input().envelope().attempt_id;
            let item_id = prepared.input().envelope().items[0].item_id;
            let dispatch = fixture
                .fixture
                .store
                .dispatch_execution_item(id, item_id)
                .unwrap();
            fixture
                .fixture
                .store
                .note_execution_unknown(id, dispatch.item_id, "synthetic-unknown")
                .unwrap();
            automation.tick(&mut fixture.fixture.store, &mut fixture.runtime);
            assert!(!automation.active());
            fixture.release(&mut automation).unwrap();
            assert_eq!(
                automation.attempts[&id].service_origin,
                ServiceOriginState::Retained
            );
            fixture
                .fixture
                .store
                .check_work_plan_input(prepared.input())
                .unwrap();

            let prepared = fixture.prepare("retryable-effect");
            fixture.enqueue(&mut automation, &prepared);
            let id = prepared.input().envelope().attempt_id;
            let item_id = prepared.input().envelope().items[0].item_id;
            fixture.fail(prepared.input());
            automation.tick(&mut fixture.fixture.store, &mut fixture.runtime);
            for code in [
                CommandErrorCode::Busy,
                CommandErrorCode::StorageFailed,
                CommandErrorCode::OutcomeUnknown,
            ] {
                command_failure(
                    automation
                        .attempts
                        .get_mut(&id)
                        .unwrap()
                        .items
                        .get_mut(&item_id)
                        .unwrap(),
                    CommandError::simple(code, CommandStage::ExecutionAdopt),
                );
                assert!(!automation.active());
                fixture.release(&mut automation).unwrap();
                assert_eq!(
                    automation.attempts[&id].service_origin,
                    ServiceOriginState::Retained
                );
                fixture
                    .fixture
                    .store
                    .check_work_plan_input(prepared.input())
                    .unwrap();
            }
        }

        #[test]
        fn unknown_enqueue_tracking_keeps_original_actions_without_claiming_child_presence() {
            let mut fixture = ServiceFixture::new();
            let mut automation = Automation::default();
            let prepared = fixture.prepare("uncertain-enqueue");
            let id = prepared.input().envelope().attempt_id;
            let item_id = prepared.input().envelope().items[0].item_id;
            // Retain the prevalidated identities at an uncertain enqueue seam.
            automation
                .prepare_service_tracking(&fixture.fixture.store, &prepared, None)
                .unwrap()
                .commit();
            let action = automation.attempts[&id].items[&item_id].candidate_action;
            assert!(
                fixture
                    .runtime
                    .input_if_present(&fixture.fixture.store, id)
                    .unwrap()
                    .is_none()
            );
            fixture.release(&mut automation).unwrap();
            assert_eq!(
                automation.attempts[&id].service_origin,
                ServiceOriginState::Retained
            );
            fixture
                .runtime
                .submit_work_plan_service_child(&mut fixture.fixture.store, &prepared)
                .unwrap();
            automation
                .prepare_tracking(&fixture.fixture.store, prepared.input(), None)
                .unwrap()
                .commit();
            assert_eq!(
                automation.attempts[&id].items[&item_id].candidate_action,
                action
            );
            assert_eq!(
                automation.attempts[&id].service_origin,
                ServiceOriginState::Retained
            );
            assert!(
                automation
                    .prepare_service_tracking(&fixture.fixture.store, &prepared, None)
                    .is_err()
            );
        }
    }
}
