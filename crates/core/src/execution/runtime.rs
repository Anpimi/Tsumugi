use super::*;
use crate::{AttemptView, ProjectStore};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        mpsc::{Receiver, TryRecvError},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

const CONCURRENCY: usize = 2;

struct Worker {
    request: DispatchRequest,
    cancellation: Cancellation,
    receiver: Receiver<FixedResult>,
    thread: JoinHandle<Result<(), ExecutionError>>,
    started: Instant,
    cancellation_started: Option<Instant>,
}

/// Session-owned scheduler. `tick` only performs bounded polling and short store
/// transactions. Workers cannot retain the store after the session closes.
pub struct ExecutionRuntime {
    generation: ExecutionId,
    initial_sequence: Revision,
    runners: BTreeMap<(String, String), Arc<dyn Runner>>,
    workers: Vec<Worker>,
    retired: Vec<(ExecutionId, JoinHandle<Result<(), ExecutionError>>)>,
    accepting: bool,
}
impl ExecutionRuntime {
    pub fn new(store: &ProjectStore) -> Result<Self, ExecutionError> {
        Ok(Self {
            generation: ExecutionId::new(),
            initial_sequence: store.execution_sequence()?,
            runners: BTreeMap::new(),
            workers: Vec::new(),
            retired: Vec::new(),
            accepting: true,
        })
    }
    pub fn generation(&self) -> ExecutionId {
        self.generation
    }
    pub fn register(&mut self, runner: Arc<dyn Runner>) -> Result<(), ExecutionError> {
        let key = (
            runner.capability_id().to_owned(),
            runner.capability_version().to_owned(),
        );
        label(&key.0)?;
        label(&key.1)?;
        if self.runners.contains_key(&key) {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "runner-registration",
            ));
        }
        self.runners.insert(key, runner);
        Ok(())
    }
    pub fn submit(
        &mut self,
        store: &mut ProjectStore,
        input: &FixedInput,
    ) -> Result<(), ExecutionError> {
        if !self.accepting {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        if !self.runners.contains_key(&(
            input.envelope().capability_id.clone(),
            input.envelope().capability_version.clone(),
        )) {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "capability"));
        }
        store.enqueue_execution(input)
    }
    pub fn is_active(&self, attempt: ExecutionId) -> bool {
        self.workers
            .iter()
            .any(|worker| worker.request.input.envelope().attempt_id == attempt)
    }
    pub fn has_active_work(&self, store: &ProjectStore) -> Result<bool, ExecutionError> {
        Ok(!self.workers.is_empty()
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
        for (attempt, thread) in self.retired.drain(..) {
            if thread.is_finished() {
                let _ = thread.join();
            } else {
                remaining.push((attempt, thread));
            }
        }
        self.retired = remaining;
        let mut index = 0;
        while index < self.workers.len() {
            let worker = &self.workers[index];
            let attempt = worker.request.input.envelope().attempt_id;
            let item = worker.request.item_id;
            let mut protocol_error = None;
            // A producer may refill the channel; do not let it monopolize the session.
            for _ in 0..8 {
                match worker.receiver.try_recv() {
                    Ok(result) => {
                        if result.envelope().item_id != item
                            || result.envelope().attempt_id != attempt
                        {
                            protocol_error = Some("result-association");
                            break;
                        }
                        match store.save_execution_result(&result) {
                            Ok(_) => {
                                if result.envelope().outcome == ExecutionState::Succeeded {
                                    store.validate_execution_result(
                                        attempt,
                                        result.envelope().result_id,
                                    )?;
                                }
                            }
                            Err(error)
                                if matches!(
                                    error.code,
                                    ErrorCode::ResultMismatch
                                        | ErrorCode::OutputInvalid
                                        | ErrorCode::LimitExceeded
                                        | ErrorCode::InvalidInput
                                ) =>
                            {
                                protocol_error = Some("result-protocol");
                                break;
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                }
            }
            let worker = &self.workers[index];
            let timed_out = now.saturating_duration_since(worker.started)
                >= Duration::from_millis(worker.request.input.envelope().limits.timeout_ms as u64);
            let cancelled_wait = worker.cancellation_started.is_some_and(|started| {
                now.saturating_duration_since(started)
                    >= Duration::from_millis(
                        worker.request.input.envelope().limits.cancel_wait_ms as u64,
                    )
            });
            if let Some(reason) = protocol_error {
                store.note_execution_unknown(attempt, item, reason)?;
            }
            if timed_out || cancelled_wait || protocol_error.is_some() {
                let worker = self.workers.remove(index);
                worker.cancellation.request();
                store.note_execution_unknown(
                    attempt,
                    item,
                    if timed_out {
                        "runner-timeout"
                    } else {
                        "runner-stopped"
                    },
                )?;
                // Dropping the receiver revokes the only path back to this store.
                self.retired.push((attempt, worker.thread));
                continue;
            }
            if worker.thread.is_finished() {
                // Drain again after join on the next tick if up to eight results
                // were consumed while the producer was still writing.
                match worker.receiver.try_recv() {
                    Ok(result) => {
                        if result.envelope().item_id != item
                            || result.envelope().attempt_id != attempt
                        {
                            store.note_execution_unknown(attempt, item, "result-association")?;
                        } else {
                            store.save_execution_result(&result)?;
                            if result.envelope().outcome == ExecutionState::Succeeded {
                                store.validate_execution_result(
                                    attempt,
                                    result.envelope().result_id,
                                )?;
                            }
                        }
                        index += 1;
                        continue;
                    }
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => {}
                }
                let worker = self.workers.remove(index);
                let outcome = worker.thread.join();
                let reason = if matches!(outcome, Ok(Ok(()))) {
                    "result-missing"
                } else {
                    "runner-outcome-unknown"
                };
                store.note_execution_unknown(attempt, item, reason)?;
                continue;
            }
            index += 1;
        }
        if !self.accepting {
            return Ok(());
        }
        for attempt in store.queued_execution_attempts(self.initial_sequence)? {
            // Retired uncooperative producers still consume a concurrency slot.
            if self.workers.len() + self.retired.len() >= CONCURRENCY {
                break;
            }
            if self.is_active(attempt) || self.retired.iter().any(|(id, _)| *id == attempt) {
                continue;
            }
            let input = store.execution_input(attempt)?;
            let Some(runner) = self
                .runners
                .get(&(
                    input.envelope().capability_id.clone(),
                    input.envelope().capability_version.clone(),
                ))
                .cloned()
            else {
                continue;
            };
            let view = store.execution_attempt(attempt, true)?;
            let Some(item) = view.items.iter().find(|item| {
                item.execution == ExecutionState::Queued && !item.cancellation_requested
            }) else {
                continue;
            };
            let request = store.dispatch_execution_item(attempt, item.item_id)?;
            let cancellation = Cancellation::default();
            let signal = cancellation.clone();
            let task = request.clone();
            let (sender, receiver) = result_channel();
            let thread = std::thread::Builder::new()
                .name("execution-worker".into())
                .spawn(move || runner.run(task, signal, sender));
            match thread {
                Ok(thread) => self.workers.push(Worker {
                    request,
                    cancellation,
                    receiver,
                    thread,
                    started: now,
                    cancellation_started: None,
                }),
                Err(_) => {
                    store.note_execution_unknown(attempt, item.item_id, "runner-start-failed")?;
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
            if worker.request.input.envelope().task_id == task {
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
        let request = store.execution_dispatch(attempt, item)?;
        let Some(runner) = self.runners.get(&(
            request.input.envelope().capability_id.clone(),
            request.input.envelope().capability_version.clone(),
        )) else {
            return Ok(None);
        };
        Ok(Some(OutcomeQuery {
            request,
            runner: runner.clone(),
            generation: self.generation,
        }))
    }
    pub fn begin_quiesce(&mut self, store: &mut ProjectStore) -> Result<(), ExecutionError> {
        self.accepting = false;
        // Persist cancellation for queued work as well as running attempts.
        let mut tasks = BTreeSet::new();
        for worker in &self.workers {
            if worker.cancellation_started.is_none() {
                tasks.insert(worker.request.input.envelope().task_id);
            }
        }
        // One bounded window per call; the host retries while quiescing.
        for attempt in store.queued_execution_attempts(self.initial_sequence)? {
            let input = store.execution_input(attempt)?;
            tasks.insert(input.envelope().task_id);
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
        if !self.workers.is_empty() {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        self.generation = ExecutionId::new();
        Ok(())
    }
}
impl Drop for ExecutionRuntime {
    fn drop(&mut self) {
        for worker in &self.workers {
            worker.cancellation.request();
        }
    }
}

pub struct OutcomeQuery {
    pub request: DispatchRequest,
    pub generation: ExecutionId,
    runner: Arc<dyn Runner>,
}
impl OutcomeQuery {
    pub fn run(&self) -> Result<QueryOutcome, ExecutionError> {
        self.runner.query(&self.request)
    }
}

#[cfg(test)]
mod tests;
