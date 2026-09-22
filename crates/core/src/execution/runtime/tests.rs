use super::*;
use crate::ProjectMetadata;
use serde_json::json;
use std::sync::mpsc;

struct Call {
    request: DispatchRequest,
    release: mpsc::Sender<ExecutionState>,
    finished: mpsc::Receiver<bool>,
}
struct Controlled {
    calls: mpsc::Sender<Call>,
}
impl Runner for Controlled {
    fn capability_id(&self) -> &str {
        "controlled"
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        request: DispatchRequest,
        _cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        self.calls
            .send(Call {
                request: request.clone(),
                release: release_tx,
                finished: finished_rx,
            })
            .unwrap();
        let Ok(outcome) = release_rx.recv() else {
            return Ok(());
        };
        let result = FixedResult::capture(
            ResultEnvelope {
                project_id: request.input.envelope().project_id,
                attempt_id: request.input.envelope().attempt_id,
                item_id: request.item_id,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: request.dispatch_token,
                capability_id: "controlled".into(),
                capability_version: "1".into(),
                outcome,
                output: if outcome == ExecutionState::Succeeded {
                    Some(json!("generated"))
                } else {
                    None
                },
                diagnostic: if outcome == ExecutionState::Succeeded {
                    None
                } else {
                    Some(Diagnostic {
                        code: "known-failure".into(),
                        retry_safe: outcome == ExecutionState::Failed,
                    })
                },
            },
            &request.input,
            request.dispatch_token,
        )?;
        let saved = results
            .send(result.clone())
            .and_then(|_| results.send(result));
        let _ = finished_tx.send(saved.is_ok());
        saved
    }
}
fn setup() -> (
    tempfile::TempDir,
    ProjectStore,
    ExecutionRuntime,
    mpsc::Receiver<Call>,
) {
    let temp = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(
        temp.path().join("project"),
        ProjectMetadata::create("Runtime", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    let (tx, rx) = mpsc::channel();
    runtime
        .register(Arc::new(Controlled { calls: tx }))
        .unwrap();
    (temp, store, runtime, rx)
}
fn input(store: &ProjectStore) -> FixedInput {
    let items = ["a", "b", "c"]
        .into_iter()
        .map(|id| {
            InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: id.into(),
                    locale: None,
                },
                json!(id),
                vec![],
            )
        })
        .collect();
    FixedInput::capture(
        InputEnvelope::new(
            store.metadata().unwrap().project_id(),
            "fixture",
            "controlled",
            "1",
            items,
        )
        .unwrap(),
    )
    .unwrap()
}
fn pump_until(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    mut done: impl FnMut(&ExecutionRuntime, &ProjectStore) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done(runtime, store) {
        runtime.tick(store).unwrap();
        assert!(Instant::now() < deadline, "bounded scheduler wait expired");
        std::thread::yield_now();
    }
}

#[test]
fn mixed_results_cancel_remaining_work_and_duplicate_delivery_never_adopts() {
    let (_temp, mut store, mut runtime, calls) = setup();
    let input = input(&store);
    let attempt = input.envelope().attempt_id;
    runtime.submit(&mut store, &input).unwrap();
    runtime.tick(&mut store).unwrap();
    let first = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        store
            .execution_dispatch(attempt, first.request.item_id)
            .unwrap()
            .dispatch_token,
        first.request.dispatch_token
    );
    first.release.send(ExecutionState::Succeeded).unwrap();
    assert!(first.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    let mut second = None;
    pump_until(&mut runtime, &mut store, |_, _| {
        second = calls.try_recv().ok();
        second.is_some()
    });
    let second = second.unwrap();
    second.release.send(ExecutionState::Failed).unwrap();
    assert!(
        second
            .finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
    );
    runtime
        .cancel(&mut store, input.envelope().task_id, ExecutionId::new())
        .unwrap();
    pump_until(&mut runtime, &mut store, |runtime, _| {
        !runtime.is_active(attempt)
    });
    let view = runtime.attempt(&store, attempt).unwrap();
    assert_eq!(
        (
            view.progress.succeeded,
            view.progress.failed,
            view.progress.cancelled,
            view.progress.adopted
        ),
        (1, 1, 1, 0)
    );
    assert!(calls.try_recv().is_err());
    let remaining: Vec<_> = view
        .items
        .iter()
        .filter(|item| {
            matches!(
                item.execution,
                ExecutionState::Failed | ExecutionState::CancelledBeforeDispatch
            )
        })
        .map(|item| item.item_id)
        .collect();
    let retry = input.retry(&remaining).unwrap();
    runtime.submit(&mut store, &retry).unwrap();
    assert_eq!(retry.envelope().items.len(), 2);
}

#[test]
fn runtime_restart_does_not_automatically_replay_queued_or_unknown_work() {
    let (temp, mut store, mut runtime, calls) = setup();
    let input = input(&store);
    runtime.submit(&mut store, &input).unwrap();
    runtime.tick(&mut store).unwrap();
    let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(runtime);
    drop(call);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    let (tx, rx) = mpsc::channel();
    let mut runtime = ExecutionRuntime::new(&reopened).unwrap();
    runtime
        .register(Arc::new(Controlled { calls: tx }))
        .unwrap();
    runtime.tick(&mut reopened).unwrap();
    assert!(!runtime.has_active_work(&reopened).unwrap());
    assert!(rx.try_recv().is_err());
    let view = runtime
        .attempt(&reopened, input.envelope().attempt_id)
        .unwrap();
    assert_eq!((view.progress.unknown, view.progress.queued), (1, 2));
    assert!(
        runtime
            .outcome_query(
                &reopened,
                input.envelope().attempt_id,
                view.items
                    .iter()
                    .find(|item| item.execution == ExecutionState::Unknown)
                    .unwrap()
                    .item_id
            )
            .unwrap()
            .is_some()
    );
}

#[test]
fn concurrency_is_bounded_and_quiesce_revokes_late_writes() {
    let (temp, mut store, mut runtime, calls) = setup();
    let mut inputs = Vec::new();
    for _ in 0..3 {
        let mut draft = input(&store).envelope().clone();
        draft.limits.cancel_wait_ms = 0;
        let fixed = FixedInput::capture(draft).unwrap();
        runtime.submit(&mut store, &fixed).unwrap();
        inputs.push(fixed);
    }
    runtime.tick(&mut store).unwrap();
    let first = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    let second = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    runtime.tick(&mut store).unwrap();
    assert!(calls.try_recv().is_err());
    assert_eq!(runtime.workers.len(), 2);
    let generation = runtime.generation();
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    assert_ne!(generation, runtime.generation());
    assert!(!runtime.has_active_work(&store).unwrap());
    store.close().unwrap();
    first.release.send(ExecutionState::Succeeded).unwrap();
    second.release.send(ExecutionState::Succeeded).unwrap();
    assert!(!first.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    assert!(
        !second
            .finished
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
    );
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    let adopted: u32 = inputs
        .iter()
        .map(|input| {
            reopened
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap()
                .progress
                .adopted
        })
        .sum();
    assert_eq!(adopted, 0);
    assert!(inputs.iter().all(|input| {
        reopened
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .progress
            .succeeded
            == 0
    }));
}

#[test]
fn late_output_before_quiesce_deadline_is_preserved_unapplied() {
    let (_temp, mut store, mut runtime, calls) = setup();
    let fixed = input(&store);
    runtime.submit(&mut store, &fixed).unwrap();
    runtime.tick(&mut store).unwrap();
    let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    runtime
        .cancel(&mut store, fixed.envelope().task_id, ExecutionId::new())
        .unwrap();
    call.release.send(ExecutionState::Succeeded).unwrap();
    assert!(call.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    pump_until(&mut runtime, &mut store, |runtime, _| {
        !runtime.is_active(fixed.envelope().attempt_id)
    });
    let view = runtime
        .attempt(&store, fixed.envelope().attempt_id)
        .unwrap();
    assert_eq!(
        (
            view.progress.succeeded,
            view.progress.cancelled,
            view.progress.adopted
        ),
        (1, 2, 0)
    );
    assert!(view.items.iter().all(|item| item.cancellation_requested));
}

#[test]
fn timed_out_producer_remains_unknown_and_holds_its_concurrency_slot() {
    let (_temp, mut store, mut runtime, calls) = setup();
    let fixed = input(&store);
    runtime.submit(&mut store, &fixed).unwrap();
    runtime.tick(&mut store).unwrap();
    let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    runtime
        .tick_at(&mut store, Instant::now() + Duration::from_secs(61))
        .unwrap();
    assert_eq!(runtime.retired.len(), 1);
    assert!(!runtime.is_active(fixed.envelope().attempt_id));
    let view = runtime
        .attempt(&store, fixed.envelope().attempt_id)
        .unwrap();
    assert_eq!((view.progress.unknown, view.progress.queued), (1, 2));
    runtime.tick(&mut store).unwrap();
    assert!(calls.try_recv().is_err());
    let query = runtime
        .outcome_query(&store, fixed.envelope().attempt_id, call.request.item_id)
        .unwrap()
        .unwrap();
    assert!(matches!(query.run().unwrap(), QueryOutcome::Unavailable));
    call.release.send(ExecutionState::Succeeded).unwrap();
    assert!(!call.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    assert_eq!(
        runtime
            .apply_query_outcome(&mut store, &query, QueryOutcome::Unavailable)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        runtime
            .attempt(&store, fixed.envelope().attempt_id)
            .unwrap()
            .progress
            .unknown,
        1
    );
}

#[test]
fn explicit_resume_dispatches_only_eligible_remaining_work() {
    let (_temp, mut store, mut runtime, calls) = setup();
    let fixed = input(&store);
    runtime.submit(&mut store, &fixed).unwrap();
    runtime
        .cancel(&mut store, fixed.envelope().task_id, ExecutionId::new())
        .unwrap();
    let selected = fixed.envelope().items[0].item_id;
    let attempt = runtime
        .resume(&mut store, fixed.envelope().attempt_id, &[selected])
        .unwrap();
    runtime.tick(&mut store).unwrap();
    let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(call.request.input.envelope().attempt_id, attempt);
    assert_eq!(call.request.item_id, selected);
    call.release.send(ExecutionState::Succeeded).unwrap();
    assert!(call.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    pump_until(&mut runtime, &mut store, |runtime, _| {
        !runtime.is_active(attempt)
    });
    assert!(calls.try_recv().is_err());
    assert_eq!(
        runtime.attempt(&store, attempt).unwrap().progress.succeeded,
        1
    );
}
