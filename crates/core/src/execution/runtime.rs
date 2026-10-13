use super::*;
use crate::{AttemptView, ProjectStore};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, OnceLock,
        mpsc::{Receiver, TryRecvError},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
mod package_quiesce;
pub(crate) use package_quiesce::PackageKey;
pub use package_quiesce::PackageQuiescence;
use package_quiesce::{PackageControl, PackageQueries, QueryGate, RetiredWorker, RunnerEntry};

type RunnerKey = (String, String, Option<String>, Option<String>);
fn runner_key(
    capability: &str,
    version: &str,
    provider: Option<&tsumugi_plugin_sdk::ProviderSelectionBinding>,
    environment: Option<&tsumugi_plugin_sdk::ExecutionEnvironmentDescriptor>,
) -> Result<RunnerKey, ExecutionError> {
    label(capability)?;
    label(version)?;
    let (provider, environment) = match (provider, environment) {
        (None, None) => (None, None),
        (Some(provider), Some(environment)) => (
            Some(super::plugin::provider_key(provider)?),
            Some(super::plugin::environment_key(environment)?),
        ),
        _ => {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "runner-registration",
            ));
        }
    };
    Ok((capability.into(), version.into(), provider, environment))
}
fn input_key(input: &FixedInput) -> Result<RunnerKey, ExecutionError> {
    let e = input.envelope();
    runner_key(
        &e.capability_id,
        &e.capability_version,
        e.plugin.as_ref().map(|p| &p.capability.provider),
        e.plugin.as_ref().map(|p| &p.environment),
    )
}
const CONCURRENCY: usize = 2;
// Preserve one maximum legal fixed-input batch while bounding concurrent tasks.
const MAX_QUEUED_ITEMS: usize = MAX_ITEMS;
const MAX_QUEUED_ATTEMPTS: usize = 128;

// Persist bounded owner-controlled categories, never arbitrary producer text.
fn runner_failure(error: &ExecutionError) -> &'static str {
    match error.stage.as_str() {
        "plugin-crashed" => "plugin-crashed",
        "plugin-timeout" => "plugin-timeout",
        "plugin-cleanup" => "plugin-cleanup",
        _ => match error.code {
            ErrorCode::Cancelled => "runner-cancelled",
            ErrorCode::Unauthorized => "runner-authority",
            ErrorCode::ResultMismatch
            | ErrorCode::OutputInvalid
            | ErrorCode::LimitExceeded
            | ErrorCode::InvalidInput => "runner-protocol",
            _ => "runner-failed",
        },
    }
}

fn persist_result(store: &mut ProjectStore, result: &FixedResult) -> Result<(), ExecutionError> {
    store.save_execution_result(result)?;
    let envelope = result.envelope();
    // Historical same-identity delivery is an allowed no-op. Only the current
    // result can advance validation; never replace a newer corrected result.
    if envelope.plugin.is_none()
        && envelope.outcome == ExecutionState::Succeeded
        && store.execution_current_result(envelope.attempt_id, envelope.item_id)?
            == Some(envelope.result_id)
    {
        store.validate_execution_result(envelope.attempt_id, envelope.result_id)?;
    }
    Ok(())
}

struct Worker {
    request: DispatchRequest,
    budget_events: Receiver<crate::ai::provider::BudgetEvent>,
    cancellation: Cancellation,
    receiver: Receiver<FixedResult>,
    thread: JoinHandle<Result<(), ExecutionError>>,
    completion: Arc<OnceLock<Option<&'static str>>>,
    started: Instant,
    cancellation_started: Option<Instant>,
    pending_result: Option<FixedResult>,
    stop_reason: Option<&'static str>,
}

/// Session-owned scheduler. `tick` only performs bounded polling and short store
/// transactions. Workers cannot retain the store after the session closes.
pub struct ExecutionRuntime {
    generation: ExecutionId,
    initial_sequence: Revision,
    runners: BTreeMap<RunnerKey, RunnerEntry>,
    validators: BTreeMap<String, Arc<dyn ResultValidator>>,
    plugin_epoch: Arc<plugin_authority::PluginEpoch>,
    policies: BTreeMap<RunnerKey, RecoveryPolicy>,
    scheduling_cursor: Option<ExecutionId>,
    workers: Vec<Worker>,
    retired: Vec<RetiredWorker>,
    package_controls: BTreeMap<ExecutionId, PackageControl>,
    accepting: bool,
}
impl ExecutionRuntime {
    pub fn new(store: &ProjectStore) -> Result<Self, ExecutionError> {
        let generation = ExecutionId::new();
        let plugin_epoch = store.begin_plugin_epoch(generation)?;
        Ok(Self {
            generation,
            plugin_epoch,
            validators: BTreeMap::new(),
            initial_sequence: store.execution_sequence()?,
            runners: BTreeMap::new(),
            policies: BTreeMap::new(),
            scheduling_cursor: None,
            workers: Vec::new(),
            retired: Vec::new(),
            package_controls: BTreeMap::new(),
            accepting: true,
        })
    }
    pub fn generation(&self) -> ExecutionId {
        self.plugin_epoch.generation()
    }
    fn retire_completed_tool(
        &self,
        store: &mut ProjectStore,
        request: &DispatchRequest,
    ) -> Result<(), ExecutionError> {
        let attempt = request.input.envelope().attempt_id;
        let Some(permit) = request
            .plugin_permit
            .as_ref()
            .filter(|permit| permit.is_work_plan_tool() && permit.is_authorized())
        else {
            return Ok(());
        };
        if self.is_active(attempt) || self.retired.iter().any(|worker| worker.attempt == attempt) {
            return Ok(());
        }
        if store
            .execution_attempt(attempt, false)?
            .items
            .iter()
            .any(|item| {
                matches!(
                    item.execution,
                    ExecutionState::Queued | ExecutionState::Dispatched
                )
            })
        {
            return Ok(());
        }
        // Query tools cannot adopt output. Once every child item is durable and
        // its producer has ended, retain provenance but release the live slot.
        self.revoke_plugin(store, permit.grant_id())
    }
    pub fn register(&mut self, runner: Arc<dyn Runner>) -> Result<(), ExecutionError> {
        self.register_with_policy(runner, RecoveryPolicy::ExternalUnknown)
    }
    /// Register a Core producer whose host-reviewed execution has no external effects.
    pub fn register_read_only(&mut self, runner: Arc<dyn Runner>) -> Result<(), ExecutionError> {
        self.register_with_policy(runner, RecoveryPolicy::ReadOnly)
    }
    /// Host-verified effect policy. Producers cannot set it through fixed input or results.
    pub fn register_with_policy(
        &mut self,
        runner: Arc<dyn Runner>,
        policy: RecoveryPolicy,
    ) -> Result<(), ExecutionError> {
        if self.package_stopped(runner.plugin_provider()) {
            return Err(ExecutionError::new(ErrorCode::Busy, "package-quiescing"));
        }
        let key = runner_key(
            runner.capability_id(),
            runner.capability_version(),
            runner.plugin_provider(),
            runner.plugin_environment(),
        )?;
        if self.runners.contains_key(&key) {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "runner-registration",
            ));
        }
        self.policies.insert(key.clone(), policy);
        self.runners.insert(key, RunnerEntry::new(runner));
        Ok(())
    }
    pub fn register_validator(
        &mut self,
        validator: Arc<dyn ResultValidator>,
    ) -> Result<(), ExecutionError> {
        label(validator.operation())?;
        if self.validators.contains_key(validator.operation()) {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "validator-registration",
            ));
        }
        self.validators
            .insert(validator.operation().into(), validator);
        Ok(())
    }
    pub fn authorize_plugin(
        &self,
        store: &mut ProjectStore,
        grant_id: ExecutionId,
        input: &FixedInput,
        expires_at_ms: u64,
        consent: PluginConsent,
    ) -> Result<(), ExecutionError> {
        if !self.accepting
            || !self.plugin_epoch.is_active()
            || self.input_package_stopped(input)
            || !self.runners.contains_key(&input_key(input)?)
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "plugin-runtime",
            ));
        }
        store.authorize_plugin_input(self.generation, grant_id, input, expires_at_ms, consent)
    }
    /// Trusted human entry only: capture independent process consent now, even
    /// before the model root is queued. Later calls cannot extend its deadline.
    pub fn authorize_work_plan_tools(
        &self,
        store: &ProjectStore,
        lease: crate::application::AutomationLease,
        expires_at_ms: u64,
        deadline: Instant,
        consent: PluginConsent,
    ) -> Result<crate::application::WorkPlanToolConsent, ExecutionError> {
        if !self.accepting || !self.plugin_epoch.is_active() {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "plugin-runtime",
            ));
        }
        store.check_plugin_epoch_owner(&self.plugin_epoch)?;
        store.capture_work_plan_tool_consent(
            lease,
            self.generation,
            expires_at_ms,
            deadline,
            consent,
        )
    }

    pub fn submit_work_plan_tool(
        &mut self,
        store: &mut ProjectStore,
        prepared: &crate::application::PreparedWorkPlanTool,
        consent: &crate::application::WorkPlanToolConsent,
        grant_id: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let input = prepared.input();
        if !self.accepting
            || !self.plugin_epoch.is_active()
            || self.input_package_stopped(input)
            || !self.runners.contains_key(&input_key(input)?)
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "plugin-runtime",
            ));
        }
        if store
            .execution_input_if_present(input.envelope().attempt_id)?
            .is_none()
            && (store.queued_execution_item_count(self.initial_sequence)?
                + input.envelope().items.len()
                > MAX_QUEUED_ITEMS
                || store
                    .queued_execution_attempts(self.initial_sequence)?
                    .len()
                    >= MAX_QUEUED_ATTEMPTS)
        {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "execution-queue",
            ));
        }
        store.enqueue_work_plan_tool(
            prepared,
            consent,
            grant_id,
            self.generation,
            self.policies[&input_key(input)?],
        )
    }

    pub fn check_work_plan_tool_consent(
        &self,
        store: &ProjectStore,
        scope: &crate::application::WorkPlanAgentScope,
        consent: &crate::application::WorkPlanToolConsent,
    ) -> Result<(), ExecutionError> {
        if !self.accepting
            || !self.plugin_epoch.is_active()
            || self.generation != consent.runtime_generation
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "plugin-runtime",
            ));
        }
        store.check_work_plan_tool_consent(scope, consent)
    }

    pub fn revoke_plugin(
        &self,
        store: &mut ProjectStore,
        grant_id: ExecutionId,
    ) -> Result<(), ExecutionError> {
        store.revoke_plugin_grant(self.generation, grant_id)
    }
    pub fn submit(
        &mut self,
        store: &mut ProjectStore,
        input: &FixedInput,
    ) -> Result<(), ExecutionError> {
        self.submit_with_parent(store, input, None)
    }
    /// Child requests inherit parent scope, cancellation and every ancestor budget.
    pub fn submit_child(
        &mut self,
        store: &mut ProjectStore,
        input: &FixedInput,
        parent: ExecutionId,
    ) -> Result<(), ExecutionError> {
        self.submit_with_parent(store, input, Some(parent))
    }
    /// A component proposal uses the same queue and ancestor budget, with its
    /// original caller recorded atomically alongside the child attempt.
    pub fn submit_work_plan_service_child(
        &mut self,
        store: &mut ProjectStore,
        prepared: &crate::application::PreparedWorkPlanServiceGeneration,
    ) -> Result<crate::application::WorkPlanServiceReceipt, ExecutionError> {
        let identity = prepared.identity()?;
        if let Some(receipt) = store.work_plan_service_receipt(&identity, &prepared.call)? {
            if receipt.input_digest != prepared.input().digest() {
                return Err(ExecutionError::new(
                    ErrorCode::ResultMismatch,
                    "service-child-identity",
                ));
            }
            // A historical ACK is data only, even after stop, expiry or reopen.
            return Ok(receipt);
        }
        self.submit_with_origin(
            store,
            prepared.input(),
            Some(prepared.parent_task()),
            Some(prepared),
        )?;
        store
            .work_plan_service_receipt(&identity, &prepared.call)
            .map_err(|mut error| {
                // Enqueue and activation already succeeded. Failure to read
                // their ACK cannot retract the accepted child or its tracking.
                error.code = ErrorCode::OutcomeUnknown;
                error
            })?
            .ok_or_else(|| ExecutionError::new(ErrorCode::OutcomeUnknown, "service-child-receipt"))
    }
    fn submit_with_parent(
        &mut self,
        store: &mut ProjectStore,
        input: &FixedInput,
        parent: Option<ExecutionId>,
    ) -> Result<(), ExecutionError> {
        self.submit_with_origin(store, input, parent, None)
    }
    fn submit_with_origin(
        &mut self,
        store: &mut ProjectStore,
        input: &FixedInput,
        parent: Option<ExecutionId>,
        service: Option<&crate::application::PreparedWorkPlanServiceGeneration>,
    ) -> Result<(), ExecutionError> {
        if let Some(prepared) = service {
            let (plugin, digest) = prepared.original_caller_package();
            if self.original_package_stopped(Some(&PackageKey {
                plugin: plugin.clone(),
                digest: digest.into(),
            })) {
                return Err(ExecutionError::new(ErrorCode::Busy, "package-quiescing"));
            }
        }
        let policy = self.submission_policy(store, input, parent)?;
        if let Some(prepared) = service {
            store.enqueue_work_plan_service_generation(prepared, policy)
        } else {
            store.enqueue_execution_with_policy(input, policy, parent)
        }
    }
    fn submission_policy(
        &self,
        store: &ProjectStore,
        input: &FixedInput,
        parent: Option<ExecutionId>,
    ) -> Result<RecoveryPolicy, ExecutionError> {
        if !self.accepting || self.stored_input_package_stopped(store, input)? {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        if input.envelope().plugin.is_some() && (!self.plugin_epoch.is_active() || parent.is_some())
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "plugin-runtime",
            ));
        }
        if !self.runners.contains_key(&input_key(input)?) {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "capability"));
        }
        if store
            .execution_input_if_present(input.envelope().attempt_id)?
            .is_none()
            && (store.queued_execution_item_count(self.initial_sequence)?
                + input.envelope().items.len()
                > MAX_QUEUED_ITEMS
                || store
                    .queued_execution_attempts(self.initial_sequence)?
                    .len()
                    >= MAX_QUEUED_ATTEMPTS)
        {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "execution-queue",
            ));
        }
        self.policies
            .get(&input_key(input)?)
            .copied()
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "capability"))
    }
    pub fn is_active(&self, attempt: ExecutionId) -> bool {
        self.workers
            .iter()
            .any(|worker| worker.request.input.envelope().attempt_id == attempt)
    }
    /// Read the original ledger's explicit presence result without granting or
    /// restoring execution authority. Storage errors remain errors.
    pub fn input_if_present(
        &self,
        store: &ProjectStore,
        attempt: ExecutionId,
    ) -> Result<Option<FixedInput>, ExecutionError> {
        store.execution_input_if_present(attempt)
    }

    /// An ended channel or an idle scheduler does not settle an attempt. Retired
    /// producers and unresolved outcomes retain their original association.
    pub fn has_unsettled_attempt(
        &self,
        store: &ProjectStore,
        attempt: ExecutionId,
    ) -> Result<bool, ExecutionError> {
        if self.is_active(attempt) || self.retired.iter().any(|worker| worker.attempt == attempt) {
            return Ok(true);
        }
        if self.input_if_present(store, attempt)?.is_none() {
            return Ok(false);
        }
        // Preserve the ledger's actual Dispatched state. A nonexecuting view
        // projects it to Unknown for recovery presentation instead.
        Ok(store
            .execution_attempt(attempt, true)?
            .items
            .iter()
            .any(|item| {
                matches!(
                    item.execution,
                    ExecutionState::Queued | ExecutionState::Dispatched | ExecutionState::Unknown
                )
            }))
    }
    /// Exact replay returns durable evidence before consulting live controls.
    /// It does not schedule historical queued work after a process reopens.
    pub fn resume(
        &mut self,
        store: &mut ProjectStore,
        action: &ContinuationAction,
    ) -> Result<ContinuationReceipt, ExecutionError> {
        let action = action.canonical()?;
        if let Some(receipt) = store.execution_continuation(action.action_id)? {
            return if receipt.action == action {
                Ok(receipt)
            } else {
                Err(ExecutionError::new(
                    ErrorCode::ResultMismatch,
                    "continuation-identity",
                ))
            };
        }
        if self.is_active(action.source_attempt_id)
            || self
                .retired
                .iter()
                .any(|worker| worker.attempt == action.source_attempt_id)
        {
            return Err(ExecutionError::new(ErrorCode::Busy, "still-running"));
        }
        let plan = store.execution_recovery(action.source_attempt_id, false)?;
        let unit = plan
            .units
            .iter()
            .find(|unit| unit.unit_id == action.unit_id)
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "continuation-unit"))?;
        let mut remaining = unit.remaining_item_ids.clone();
        remaining.sort();
        if remaining != action.item_ids || !unit.actions.contains(&action.kind.recovery_action()) {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "continuation-eligibility",
            ));
        }
        let input = store.execution_retry_input(action.source_attempt_id, &action.item_ids)?;
        if !store
            .execution_recovery_policy(action.source_attempt_id)?
            .allows_replay()
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "external-new-consent",
            ));
        }
        let policy = self.submission_policy(store, &input, None)?;
        store.enqueue_continuation(&action, &input, policy)
    }
    pub fn apply_query_outcome(
        &self,
        store: &mut ProjectStore,
        query: &OutcomeQuery,
        outcome: QueryOutcome,
    ) -> Result<bool, ExecutionError> {
        if !self.accepting
            || self.generation != query.generation
            || query.queries.stopped(query.package_queries.as_deref())
            || self.stored_input_package_stopped(store, &query.request.input)?
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "session-generation",
            ));
        }
        query.request.check_service_dispatch()?;
        match outcome {
            QueryOutcome::Known(result) => {
                let envelope = result.envelope();
                if envelope.attempt_id != query.request.input.envelope().attempt_id
                    || envelope.item_id != query.request.item_id
                    || envelope.dispatch_token != query.request.dispatch_token
                {
                    return Err(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "query-result",
                    ));
                }
                persist_result(store, &result)?;
                Ok(true)
            }
            QueryOutcome::Pending | QueryOutcome::Unavailable => Ok(false),
        }
    }
    pub fn has_active_work(&self, store: &ProjectStore) -> Result<bool, ExecutionError> {
        Ok(!self.workers.is_empty()
            || !self.retired.is_empty()
            || self
                .package_controls
                .values()
                .any(|control| !control.complete)
            || self.runners.values().any(|entry| entry.queries.active())
            || !store
                .queued_execution_attempts(self.initial_sequence)?
                .is_empty())
    }
    pub fn attempt(
        &self,
        store: &ProjectStore,
        attempt: ExecutionId,
    ) -> Result<AttemptView, ExecutionError> {
        store.execution_attempt(attempt, self.is_active(attempt))
    }

    pub fn tick(&mut self, store: &mut ProjectStore) -> Result<(), ExecutionError> {
        self.tick_at(store, Instant::now())
    }
    fn tick_at(&mut self, store: &mut ProjectStore, now: Instant) -> Result<(), ExecutionError> {
        let mut remaining = Vec::new();
        for worker in self.retired.drain(..) {
            if worker.thread.is_finished() {
                let _ = worker.thread.join();
            } else {
                remaining.push(worker);
            }
        }
        self.retired = remaining;
        let mut index = 0;
        while index < self.workers.len() {
            let worker = &mut self.workers[index];
            let attempt = worker.request.input.envelope().attempt_id;
            let item = worker.request.item_id;
            if let Err(error) = store
                .check_work_plan_input(&worker.request.input)
                .and_then(|_| store.check_plugin_input(&worker.request.input))
            {
                if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Unauthorized) {
                    if worker.cancellation_started.is_none()
                        && worker
                            .request
                            .plugin_permit
                            .as_ref()
                            .is_some_and(PluginPermit::is_work_plan_tool)
                    {
                        // Retire only this broker child. Root/model control and
                        // unrelated human plugin grants keep their own lifecycle.
                        store.cancel_execution(
                            worker.request.input.envelope().task_id,
                            ExecutionId::new(),
                        )?;
                    }
                    worker.cancellation.request();
                    worker.cancellation_started.get_or_insert(now);
                } else {
                    return Err(error);
                }
            }
            // Persist dispatch reservations before acknowledging the worker. A lost
            // acknowledgement leaves an unknown reservation, never free budget.
            for _ in 0..2 {
                let event = match worker.budget_events.try_recv() {
                    Ok(event) => event,
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                };
                match event {
                    crate::ai::provider::BudgetEvent::Reserve { id, limit, reply } => {
                        let outcome = if self.accepting && !worker.cancellation.is_requested() {
                            store.reserve_provider_request(&worker.request, id, limit)
                        } else {
                            Err(ExecutionError::new(ErrorCode::Cancelled, "ai-cancelled"))
                        };
                        let _ = reply.send(outcome);
                    }
                    crate::ai::provider::BudgetEvent::Settle { id, usage, reply } => {
                        let outcome = store.settle_provider_request(&worker.request, id, usage);
                        let _ = reply.send(outcome);
                    }
                }
            }
            let finished_before_drain = worker.thread.is_finished();
            let mut drained = false;
            // A producer may refill the channel; do not let it monopolize the session.
            for _ in 0..8 {
                if worker.stop_reason.is_some() {
                    break;
                }
                if worker.pending_result.is_none() {
                    match worker.receiver.try_recv() {
                        Ok(result) => worker.pending_result = Some(result),
                        Err(TryRecvError::Empty | TryRecvError::Disconnected) => {
                            drained = true;
                            break;
                        }
                    }
                }
                if let Some(result) = worker.pending_result.as_ref() {
                    if result.envelope().item_id != item || result.envelope().attempt_id != attempt
                    {
                        worker.stop_reason = Some("result-association");
                        break;
                    }
                    match persist_result(store, result) {
                        Ok(()) => {}
                        Err(error)
                            if matches!(
                                error.code,
                                ErrorCode::ResultMismatch
                                    | ErrorCode::OutputInvalid
                                    | ErrorCode::LimitExceeded
                                    | ErrorCode::InvalidInput
                                    | ErrorCode::Unauthorized
                                    | ErrorCode::Cancelled
                            ) =>
                        {
                            worker.stop_reason = Some("result-protocol");
                            break;
                        }
                        Err(error) => return Err(error),
                    }
                }
                // Storage failures leave this bounded message owned by the worker.
                // Re-delivery after reconciliation uses the same immutable identity.
                worker.pending_result = None;
            }
            let worker = &mut self.workers[index];
            let timed_out = now.saturating_duration_since(worker.started)
                >= Duration::from_millis(worker.request.input.envelope().limits.timeout_ms as u64);
            let cancelled_wait = worker.cancellation_started.is_some_and(|started| {
                now.saturating_duration_since(started)
                    >= Duration::from_millis(
                        worker.request.input.envelope().limits.cancel_wait_ms as u64,
                    )
            });
            if timed_out || cancelled_wait || worker.stop_reason.is_some() {
                worker.cancellation.request();
                let reason = *worker.stop_reason.get_or_insert(if timed_out {
                    "runner-timeout"
                } else {
                    "runner-stopped"
                });
                store.note_execution_unknown(attempt, item, reason)?;
                let worker = self.workers.remove(index);
                // Dropping the receiver revokes the only path back to this store.
                self.retired.push(RetiredWorker::new(worker));
                continue;
            }
            if finished_before_drain && drained {
                // Keep the worker until its final durable transition succeeds.
                let reason = match worker.completion.get() {
                    Some(Some(reason)) => *reason,
                    Some(None) => "result-missing",
                    None => "runner-panicked",
                };
                store.note_execution_unknown(attempt, item, reason)?;
                let worker = self.workers.remove(index);
                let _ = worker.thread.join();
                self.retire_completed_tool(store, &worker.request)?;
                continue;
            }
            index += 1;
        }
        if !self.accepting {
            return Ok(());
        }
        let mut queued = store.queued_execution_attempts(self.initial_sequence)?;
        if let Some(cursor) = self.scheduling_cursor {
            if let Some(index) = queued.iter().position(|id| *id == cursor) {
                let len = queued.len();
                queued.rotate_left((index + 1) % len);
            }
        }
        for attempt in queued {
            // Retired uncooperative producers still consume a concurrency slot.
            if self.workers.len() + self.retired.len() >= CONCURRENCY {
                break;
            }
            if self.retired.iter().any(|worker| worker.attempt == attempt) {
                continue;
            }
            let input = store.execution_input_cached(attempt)?;
            if self.stored_input_package_stopped(store, &input)? {
                continue;
            }
            if input.envelope().plugin.is_some() && !self.plugin_epoch.is_active() {
                continue;
            }
            let Some(entry) = self.runners.get(&input_key(&input)?).cloned() else {
                continue;
            };
            let runner = entry.runner;
            if self
                .workers
                .iter()
                .filter(|worker| worker.request.input.envelope().attempt_id == attempt)
                .count()
                >= runner.concurrency_limit(&input).clamp(1, CONCURRENCY)
            {
                continue;
            }
            let Some(item) = store.next_queued_execution_item(attempt)? else {
                continue;
            };
            let mut request = match store.dispatch_execution_item(attempt, item) {
                Ok(request) => request,
                Err(error)
                    if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Unauthorized) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            };
            let (budget, budget_events) = crate::ai::provider::budget_channel();
            request.provider = Some(budget);
            self.scheduling_cursor = Some(attempt);
            let cancellation = Cancellation::default();
            let signal = cancellation.clone();
            let task = request.clone();
            let (sender, receiver) = result_channel();
            let sender = if input.envelope().plugin.is_some() {
                match self.validators.get(&input.envelope().operation) {
                    Some(validator) => sender.with_validator(input.clone(), validator.clone()),
                    None => sender,
                }
            } else {
                sender
            };
            let completion = Arc::new(OnceLock::new());
            let completed = completion.clone();
            let thread = std::thread::Builder::new()
                .name("execution-worker".into())
                .spawn(move || {
                    let outcome = runner.run(task, signal, sender);
                    let _ = completed.set(outcome.as_ref().err().map(runner_failure));
                    outcome
                });
            match thread {
                Ok(thread) => self.workers.push(Worker {
                    request,
                    budget_events,
                    cancellation,
                    receiver,
                    thread,
                    completion,
                    started: now,
                    cancellation_started: None,
                    pending_result: None,
                    stop_reason: None,
                }),
                Err(_) => {
                    store.note_execution_unknown(attempt, item, "runner-start-failed")?;
                    return Err(ExecutionError::new(
                        ErrorCode::StorageFailed,
                        "runner-start",
                    ));
                }
            }
        }
        Ok(())
    }
    pub fn cancel(
        &mut self,
        store: &mut ProjectStore,
        task: ExecutionId,
        request: ExecutionId,
    ) -> Result<Revision, ExecutionError> {
        let revision = store.cancel_execution(task, request)?;
        for worker in &mut self.workers {
            if store
                .execution_attempt(worker.request.input.envelope().attempt_id, true)
                .map_err(|mut error| {
                    // Cancellation is already durable; a failed projection cannot
                    // reject it or confirm that running workers received a signal.
                    error.code = ErrorCode::OutcomeUnknown;
                    error
                })?
                .items
                .iter()
                .any(|item| item.cancellation_requested)
            {
                worker.cancellation.request();
                worker.cancellation_started.get_or_insert_with(Instant::now);
            }
        }
        Ok(revision)
    }
    pub fn outcome_query(
        &self,
        store: &ProjectStore,
        attempt: ExecutionId,
        item: ExecutionId,
    ) -> Result<Option<OutcomeQuery>, ExecutionError> {
        // The returned operation owns no store and can run outside the session
        // lock. The host rechecks generation before persisting its outcome.
        if !self.accepting || self.is_active(attempt) {
            return Err(ExecutionError::new(ErrorCode::Busy, "still-running"));
        }
        let plan = store.execution_recovery(attempt, false)?;
        if !plan.units.iter().any(|unit| {
            unit.actions.contains(&RecoveryAction::QueryOutcome)
                && unit.remaining_item_ids.contains(&item)
        }) {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "query-eligibility",
            ));
        }
        let mut request = store.execution_dispatch(attempt, item)?;
        request.service_origin = store.work_plan_service_query_origin(&request.input)?;
        if self.stored_input_package_stopped(store, &request.input)? {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "package-quiescing",
            ));
        }
        if request.input.envelope().plugin.is_some() && !self.plugin_epoch.is_active() {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "plugin-runtime",
            ));
        }
        let Some(runner) = self.runners.get(&input_key(&request.input)?) else {
            return Ok(None);
        };
        let package = Self::stored_input_package(store, &request.input)?;
        let package_queries = runner.queries.capture_package(package.as_ref())?;
        Ok(Some(OutcomeQuery {
            request,
            runner: runner.runner.clone(),
            queries: runner.queries.clone(),
            package_queries,
            generation: self.generation,
        }))
    }
    pub fn begin_quiesce(&mut self, store: &mut ProjectStore) -> Result<(), ExecutionError> {
        store.check_plugin_epoch_owner(&self.plugin_epoch)?;
        self.plugin_epoch.revoke();
        self.accepting = false;
        for entry in self.runners.values() {
            entry.queries.stop();
        }
        // Revoking the generation covers idle grants as well as queued/running
        // automation. Pausing never resets or refunds its original budget.
        store.pause_active_work_plans()?;
        let mut tasks = BTreeSet::new();
        for worker in &mut self.workers {
            if worker.cancellation_started.is_none() {
                if worker.request.input.envelope().automation.is_some() {
                    worker.cancellation.request();
                    worker.cancellation_started = Some(Instant::now());
                } else {
                    tasks.insert(worker.request.input.envelope().task_id);
                }
            }
        }
        // One bounded window per call; the host retries while quiescing.
        for attempt in store.queued_execution_attempts(self.initial_sequence)? {
            let input = store.execution_input(attempt)?;
            if input.envelope().automation.is_none() {
                tasks.insert(input.envelope().task_id);
            }
        }
        for task in tasks {
            self.cancel(store, task, ExecutionId::new())?;
        }
        if !store
            .queued_execution_attempts(self.initial_sequence)?
            .is_empty()
        {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        Ok(())
    }
    pub fn finish_quiesce(&mut self, store: &mut ProjectStore) -> Result<(), ExecutionError> {
        if self.accepting {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        self.begin_quiesce(store)?;
        if self.workers.iter().any(|worker| {
            !worker.thread.is_finished()
                && worker.cancellation_started.is_some_and(|start| {
                    start.elapsed()
                        < Duration::from_millis(
                            worker.request.input.envelope().limits.cancel_wait_ms as u64,
                        )
                })
        }) {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        self.tick(store)?;
        // Expiring cancellation revokes delivery, but does not stop a producer's
        // thread or release its captured runner. Keep the original generation
        // stopped until polling has joined every owned producer.
        if !self.workers.is_empty()
            || !self.retired.is_empty()
            || self.runners.values().any(|entry| entry.queries.active())
        {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        let generation = ExecutionId::new();
        self.plugin_epoch = store.rotate_plugin_epoch(&self.plugin_epoch, generation)?;
        self.generation = generation;
        self.package_controls.clear();
        for entry in self.runners.values_mut() {
            entry.queries = Arc::default();
        }
        // The stop request is complete. New work still requires an explicit
        // operation; a failed project switch may leave this session open.
        self.accepting = true;
        Ok(())
    }
}
impl Drop for ExecutionRuntime {
    fn drop(&mut self) {
        self.plugin_epoch.revoke();
        for entry in self.runners.values() {
            entry.queries.stop();
        }
        for worker in &self.workers {
            worker.cancellation.request();
        }
    }
}

pub struct OutcomeQuery {
    pub request: DispatchRequest,
    pub generation: ExecutionId,
    runner: Arc<dyn Runner>,
    queries: Arc<QueryGate>,
    package_queries: Option<Arc<PackageQueries>>,
}

#[cfg(test)]
mod tests;
