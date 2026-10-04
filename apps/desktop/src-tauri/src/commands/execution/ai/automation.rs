//! Authorized selection orchestration owns values and action identities, not a store.
use super::*;
use tsumugi_core::{
    ComputedAutomaticSelection,
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
}
struct Attempt {
    input: FixedInput,
    items: BTreeMap<ExecutionId, Item>,
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
    retired: Vec<JoinHandle<()>>,
}
fn phase_for(receipt: &AutomaticSelectionReceipt) -> EffectPhase {
    if receipt.blocked.is_some() {
        EffectPhase::Blocked
    } else {
        EffectPhase::Selected
    }
}
fn failure(item: &mut Item, error: ExecutionError) {
    item.view.phase = if error.code == ErrorCode::Cancelled {
        EffectPhase::Cancelled
    } else {
        EffectPhase::Failed
    };
    item.view.retryable = matches!(
        error.code,
        ErrorCode::Busy | ErrorCode::StorageFailed | ErrorCode::OutcomeUnknown
    );
    item.view.error = Some(map_adopt(error));
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
    ) -> Result<(), ExecutionError> {
        let Some(lease) = input.envelope().automation else {
            return Ok(());
        };
        store.check_work_plan_input(input)?;
        let plan = store.work_plan(lease.plan_id)?;
        if plan.options.selection_policy == SelectionPolicy::CandidatesOnly {
            return Ok(());
        }
        self.attempts
            .entry(input.envelope().attempt_id)
            .or_insert_with(|| Attempt {
                input: input.clone(),
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
            || self.attempts.values().any(|attempt| {
                attempt
                    .items
                    .values()
                    .any(|item| item.view.phase == EffectPhase::Waiting)
            })
    }
    pub(super) fn stop(&mut self) {
        for job in self.jobs.drain(..) {
            job.cancellation.request();
            self.retired.push(job.thread);
        }
        for attempt in self.attempts.values_mut() {
            for item in attempt.items.values_mut() {
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
    pub(super) fn tick(&mut self, store: &mut ProjectStore, runtime: &ExecutionRuntime) {
        self.retired.retain(|thread| !thread.is_finished());
        // Revoke before polling prepared completions; Core also rechecks commit.
        for (id, attempt) in &mut self.attempts {
            if let Err(error) = store.check_work_plan_input(&attempt.input) {
                for job in self.jobs.iter().filter(|job| job.attempt == *id) {
                    job.cancellation.request();
                }
                for item in attempt.items.values_mut() {
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
            self.retired.push(job.thread);
            let Some(item) = self
                .attempts
                .get_mut(&job.attempt)
                .and_then(|a| a.items.get_mut(&job.item))
            else {
                continue;
            };
            if job.cancellation.is_requested() {
                continue;
            }
            let result = result.and_then(|computed| match computed {
                Computed::Candidate(prepared) => {
                    commit_candidate(store, prepared, job.attempt, job.item).map(|revision| {
                        item.revision = Some(revision);
                        item.view.phase = EffectPhase::Waiting;
                    })
                }
                Computed::Selection(computed) => store
                    .commit_automatic_selection(computed, &job.cancellation)
                    .map(|receipt| {
                        item.view.phase = phase_for(&receipt);
                        item.view.receipt = Some(receipt);
                    }),
            });
            if let Err(error) = result {
                failure(item, error);
            }
        }
        for (attempt_id, attempt) in &mut self.attempts {
            if self.jobs.len() >= MAX_COMPUTATIONS {
                break;
            }
            let status = match store.execution_attempt(*attempt_id, runtime.is_active(*attempt_id))
            {
                Ok(status) => status,
                Err(error) => {
                    for item in attempt
                        .items
                        .values_mut()
                        .filter(|i| i.view.phase == EffectPhase::Waiting)
                    {
                        failure(item, error.clone());
                    }
                    continue;
                }
            };
            for (item_id, item) in &mut attempt.items {
                if self.jobs.len() >= MAX_COMPUTATIONS {
                    break;
                }
                if item.view.phase != EffectPhase::Waiting {
                    continue;
                }
                let Some(status) = status.items.iter().find(|s| s.item_id == *item_id) else {
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
                let input = &attempt.input;
                let launch = (|| {
                    let result = store
                        .execution_current_result(*attempt_id, *item_id)?
                        .ok_or_else(|| {
                            ExecutionError::new(ErrorCode::CorruptLedger, "work-effect-result")
                        })?;
                    item.revision = store.saved_ai_candidate(*attempt_id, *item_id)?;
                    let cancellation = Cancellation::default();
                    let (sender, receiver) = mpsc::sync_channel(1);
                    let thread = if let Some(revision) = item.revision {
                        let payload = tsumugi_core::ai::item_payload(input, *item_id)?;
                        let request = AutomaticSelectionRequest {
                            project_id: input.envelope().project_id,
                            action_id: item.selection_action,
                            lease: input.envelope().automation.unwrap(),
                            unit_id: payload.unit_id,
                            locale: payload.target_locale,
                            revision_id: revision,
                        };
                        // Read-only reconciliation survives historical ACKs and
                        // project reopen. A new generation never resumes this item.
                        if let Some(receipt) =
                            store.automatic_selection_for_candidate(request.lease, revision)?
                        {
                            item.view.phase = phase_for(&receipt);
                            item.view.action_id = Some(receipt.request.action_id);
                            item.view.receipt = Some(receipt);
                            return Ok(None);
                        }
                        let prepared = store.prepare_automatic_selection(&request)?;
                        item.view.phase = EffectPhase::Checking;
                        item.view.action_id = Some(item.selection_action);
                        let cancel = cancellation.clone();
                        std::thread::Builder::new()
                            .name("work-plan-check".into())
                            .spawn(move || {
                                let _ =
                                    sender.send(prepared.compute(&cancel).map(Computed::Selection));
                            })
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
                        std::thread::Builder::new()
                            .name("work-plan-candidate".into())
                            .spawn(move || {
                                let _ = sender.send(
                                    capture
                                        .prepare(&tsumugi_core::AiAdoptionHandler)
                                        .map(Computed::Candidate),
                                );
                            })
                    }
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
                })();
                match launch {
                    Ok(Some(job)) => self.jobs.push(job),
                    Ok(None) => {}
                    Err(error) => failure(item, error),
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
