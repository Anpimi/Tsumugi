use super::*;
use crate::ProjectMetadata;
use serde_json::json;
use std::sync::mpsc;
use tsumugi_plugin_sdk as sdk;

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
                plugin: None,
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
        .register_read_only(Arc::new(Controlled { calls: tx }))
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
        .register_read_only(Arc::new(Controlled { calls: tx }))
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
    let cancellation_id = ExecutionId::new();
    runtime
        .cancel(&mut store, fixed.envelope().task_id, cancellation_id)
        .unwrap();
    let selected = fixed.envelope().items[0].item_id;
    let attempt = runtime
        .resume(&mut store, fixed.envelope().attempt_id, &[selected])
        .unwrap();
    runtime.tick(&mut store).unwrap();
    let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(call.request.input.envelope().attempt_id, attempt);
    assert_eq!(call.request.item_id, selected);
    runtime
        .cancel(&mut store, fixed.envelope().task_id, cancellation_id)
        .unwrap();
    assert!(!runtime.workers[0].cancellation.is_requested());
    assert!(runtime.workers[0].cancellation_started.is_none());
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

#[test]
fn received_output_survives_a_temporary_database_write_lock() {
    let (temp, mut store, mut runtime, calls) = setup();
    let fixed = input(&store);
    runtime.submit(&mut store, &fixed).unwrap();
    runtime.tick(&mut store).unwrap();
    let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    call.release.send(ExecutionState::Succeeded).unwrap();
    assert!(call.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    // The fixture delivers twice; leave exactly one copy for the scheduler.
    let expected = runtime.workers[0].receiver.try_recv().unwrap();
    let blocker = rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(runtime.tick(&mut store).unwrap_err().code, ErrorCode::Busy);
    assert_eq!(
        runtime.workers[0].pending_result.as_ref().unwrap().bytes(),
        expected.bytes()
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    runtime.tick(&mut store).unwrap();
    let saved = store
        .execution_result(fixed.envelope().attempt_id, expected.envelope().result_id)
        .unwrap();
    assert_eq!(saved.bytes(), expected.bytes());
    let status = runtime
        .attempt(&store, fixed.envelope().attempt_id)
        .unwrap();
    assert_eq!(status.progress.succeeded, 1);
    assert_eq!(
        status
            .items
            .iter()
            .find(|item| item.item_id == call.request.item_id)
            .unwrap()
            .validation,
        ValidationState::Valid
    );
}

#[test]
fn timeout_persistence_failure_preserves_worker_ownership_and_concurrency() {
    let (temp, mut store, mut runtime, calls) = setup();
    for _ in 0..3 {
        let fixed = input(&store);
        runtime.submit(&mut store, &fixed).unwrap();
    }
    runtime.tick(&mut store).unwrap();
    let first = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    let second = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    let blocker = rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(
        runtime
            .tick_at(&mut store, Instant::now() + Duration::from_secs(61))
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    assert_eq!(runtime.workers.len(), 2);
    assert!(runtime.workers[0].cancellation.is_requested());
    assert!(calls.try_recv().is_err());
    blocker.execute_batch("ROLLBACK").unwrap();
    runtime
        .tick_at(&mut store, Instant::now() + Duration::from_secs(61))
        .unwrap();
    assert!(runtime.workers.is_empty());
    assert_eq!(runtime.retired.len(), 2);
    assert!(calls.try_recv().is_err());
    for call in [first, second] {
        call.release.send(ExecutionState::Succeeded).unwrap();
        assert!(!call.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    }
}

#[test]
fn historical_duplicate_does_not_replace_a_correction_or_block_worker_shutdown() {
    struct Correcting;
    impl Runner for Correcting {
        fn capability_id(&self) -> &str {
            "correcting"
        }
        fn capability_version(&self) -> &str {
            "1"
        }
        fn run(
            &self,
            request: DispatchRequest,
            _: Cancellation,
            results: ResultSender,
        ) -> Result<(), ExecutionError> {
            let first = FixedResult::capture(
                ResultEnvelope {
                    plugin: None,
                    project_id: request.input.envelope().project_id,
                    attempt_id: request.input.envelope().attempt_id,
                    item_id: request.item_id,
                    result_id: ExecutionId::new(),
                    supersedes: None,
                    dispatch_token: request.dispatch_token,
                    capability_id: "correcting".into(),
                    capability_version: "1".into(),
                    outcome: ExecutionState::Succeeded,
                    output: Some(json!("original")),
                    diagnostic: None,
                },
                &request.input,
                request.dispatch_token,
            )?;
            let mut corrected = first.envelope().clone();
            corrected.result_id = ExecutionId::new();
            corrected.supersedes = Some(first.envelope().result_id);
            corrected.output = Some(json!("corrected"));
            let corrected =
                FixedResult::capture(corrected, &request.input, request.dispatch_token)?;
            results.send(first.clone())?;
            results.send(corrected)?;
            results.send(first)
        }
    }
    let (_temp, mut store, mut runtime, _calls) = setup();
    runtime.register_read_only(Arc::new(Correcting)).unwrap();
    let mut draft = input(&store).envelope().clone();
    draft.capability_id = "correcting".into();
    let fixed = FixedInput::capture(draft).unwrap();
    runtime.submit(&mut store, &fixed).unwrap();
    pump_until(&mut runtime, &mut store, |runtime, store| {
        !runtime.has_active_work(store).unwrap()
    });
    let view = runtime
        .attempt(&store, fixed.envelope().attempt_id)
        .unwrap();
    assert_eq!(view.progress.succeeded, 3);
    for item in view.items {
        assert_eq!(item.validation, ValidationState::Valid);
        let result_id = store
            .execution_current_result(fixed.envelope().attempt_id, item.item_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            store
                .execution_result(fixed.envelope().attempt_id, result_id)
                .unwrap()
                .envelope()
                .output,
            Some(json!("corrected"))
        );
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
}

#[test]
fn runtime_fair_queue_rotates_tasks_and_rejects_excess_before_enqueue() {
    let (_temp, mut store, mut runtime, calls) = setup();
    let first = input(&store);
    let second = input(&store);
    let third = input(&store);
    for input in [&first, &second, &third] {
        runtime.submit(&mut store, input).unwrap();
    }
    runtime.tick(&mut store).unwrap();
    let a = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    let b = calls.recv_timeout(Duration::from_secs(5)).unwrap();
    let active = std::collections::BTreeSet::from([
        a.request.input.envelope().task_id,
        b.request.input.envelope().task_id,
    ]);
    assert_eq!(
        active,
        std::collections::BTreeSet::from([first.envelope().task_id, second.envelope().task_id])
    );
    a.release.send(ExecutionState::Succeeded).unwrap();
    b.release.send(ExecutionState::Succeeded).unwrap();
    assert!(a.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    assert!(b.finished.recv_timeout(Duration::from_secs(5)).unwrap());
    let mut next = None;
    pump_until(&mut runtime, &mut store, |_, _| {
        next = calls.try_recv().ok();
        next.is_some()
    });
    let next = next.unwrap();
    assert_eq!(
        next.request.input.envelope().task_id,
        third.envelope().task_id
    );
    drop(next);
    runtime.begin_quiesce(&mut store).unwrap();
    let mut fresh = ExecutionRuntime::new(&store).unwrap();
    fresh
        .register_read_only(Arc::new(Controlled {
            calls: mpsc::channel().0,
        }))
        .unwrap();
    for _ in 0..128 {
        let queued = input(&store);
        fresh.submit(&mut store, &queued).unwrap();
    }
    let rejected = input(&store);
    assert_eq!(
        fresh.submit(&mut store, &rejected).unwrap_err().stage,
        "execution-queue"
    );
    assert!(
        store
            .execution_input(rejected.envelope().attempt_id)
            .is_err()
    );
}

#[test]
fn runtime_effect_policy_is_host_owned_and_not_operation_name_based() {
    let (_temp, mut store, _, _) = setup();
    let mut envelope = input(&store).envelope().clone();
    envelope.operation = "external-fixture".into();
    let input = FixedInput::capture(envelope).unwrap();
    let mut external = ExecutionRuntime::new(&store).unwrap();
    external
        .register(Arc::new(Controlled {
            calls: mpsc::channel().0,
        }))
        .unwrap();
    external.submit(&mut store, &input).unwrap();
    assert!(
        store
            .execution_recovery(input.envelope().attempt_id, false)
            .unwrap()
            .units
            .iter()
            .all(|u| !u.actions.contains(&RecoveryAction::ResumeUndispatched))
    );
    assert!(
        external
            .resume(
                &mut store,
                input.envelope().attempt_id,
                &[input.envelope().items[0].item_id]
            )
            .is_err()
    );
    assert_eq!(
        store.enqueue_read_only_execution(&input).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
}

fn plugin_binding(host_digest: &str) -> PluginExecutionBinding {
    let contract = |id: &str| sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    };
    PluginExecutionBinding {
        capability: sdk::CapabilityBinding {
            provider: sdk::ProviderSelectionBinding {
                plugin: sdk::PluginIdentity {
                    publisher: "example".into(),
                    id: "example.plugin".into(),
                    version: "0.1.0".into(),
                },
                component_id: "worker".into(),
                contribution_id: "call".into(),
                package_digest: "a".repeat(64),
            },
            declaration: sdk::CapabilityDeclaration {
                contract: contract("example.call"),
                input_schema: contract("example.input"),
                output_schema: contract("example.output"),
                error_schema: contract("example.error"),
                profiles: vec![],
                effect: sdk::EffectKind::ReadOnly,
                permissions: vec![sdk::PermissionRequest::CapturedInput],
                limits: sdk::CapabilityLimits {
                    max_input_bytes: 4096,
                    max_output_bytes: 4096,
                    concurrency: 1,
                    timeout_ms: 1000,
                },
            },
        },
        profile: None,
        environment: sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: sdk::RuntimePlatform {
                operating_system: sdk::RuntimeOperatingSystem::Macos,
                architecture: sdk::RuntimeArchitecture::Aarch64,
            },
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: "a".repeat(64),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: host_digest.repeat(64),
                entrypoint: "dist/main.js".into(),
            },
        },
    }
}

fn plugin_input(store: &ProjectStore, binding: PluginExecutionBinding) -> FixedInput {
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "fixture",
        &binding.capability.declaration.contract.id,
        &binding.capability_version(),
        vec![InputItem::new(
            Scope {
                kind: "fixture".into(),
                id: "a".into(),
                locale: None,
            },
            json!("captured"),
            vec![],
        )],
    )
    .unwrap();
    envelope.plugin = Some(binding);
    FixedInput::capture(envelope).unwrap()
}

struct PluginCall {
    request: DispatchRequest,
    environment_digest: String,
    query: bool,
}
struct SelectedPlugin {
    provider: Option<sdk::ProviderSelectionBinding>,
    environment: Option<sdk::RuntimeEnvironmentDescriptor>,
    calls: mpsc::Sender<PluginCall>,
}
impl SelectedPlugin {
    fn new(binding: &PluginExecutionBinding, calls: mpsc::Sender<PluginCall>) -> Self {
        Self {
            provider: Some(binding.capability.provider.clone()),
            environment: Some(binding.environment.clone()),
            calls,
        }
    }
    fn record(&self, request: &DispatchRequest, query: bool) {
        self.calls
            .send(PluginCall {
                request: request.clone(),
                environment_digest: self.environment.as_ref().unwrap().digest().unwrap(),
                query,
            })
            .unwrap();
    }
}
impl Runner for SelectedPlugin {
    fn capability_id(&self) -> &str {
        "example.call"
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        self.provider.as_ref()
    }
    fn plugin_environment(&self) -> Option<&sdk::RuntimeEnvironmentDescriptor> {
        self.environment.as_ref()
    }
    fn run(
        &self,
        request: DispatchRequest,
        _cancellation: Cancellation,
        _results: ResultSender,
    ) -> Result<(), ExecutionError> {
        self.record(&request, false);
        // A missing outcome exercises the real scheduler's Unknown/query path.
        Ok(())
    }
    fn query(&self, request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        self.record(request, true);
        Ok(QueryOutcome::Unavailable)
    }
}

fn authorize(runtime: &ExecutionRuntime, store: &mut ProjectStore, input: &FixedInput) {
    runtime
        .authorize_plugin(
            store,
            ExecutionId::new(),
            input,
            plugin_authority::plugin_now_ms().unwrap() + 60_000,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
}

#[test]
fn same_plugin_provider_retains_both_environments_and_their_host_policies() {
    let (_temp, mut store, mut runtime, _) = setup();
    let (tx, calls) = mpsc::channel();
    let binding_a = plugin_binding("b");
    let binding_b = plugin_binding("c");
    assert_eq!(binding_a.capability, binding_b.capability);
    let input_a = plugin_input(&store, binding_a.clone());
    let input_b = plugin_input(&store, binding_b.clone());
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&binding_a, tx.clone())))
        .unwrap();
    authorize(&runtime, &mut store, &input_a);
    runtime.submit(&mut store, &input_a).unwrap();
    // Registering a later environment cannot replace an already queued choice.
    runtime
        .register(Arc::new(SelectedPlugin::new(&binding_b, tx.clone())))
        .unwrap();
    authorize(&runtime, &mut store, &input_b);
    runtime.submit(&mut store, &input_b).unwrap();
    assert_eq!(
        store
            .execution_recovery_policy(input_a.envelope().attempt_id)
            .unwrap(),
        RecoveryPolicy::ReadOnly
    );
    assert_eq!(
        store
            .execution_recovery_policy(input_b.envelope().attempt_id)
            .unwrap(),
        RecoveryPolicy::ExternalUnknown
    );
    let unregistered = plugin_input(&store, plugin_binding("d"));
    assert_eq!(
        runtime
            .authorize_plugin(
                &mut store,
                ExecutionId::new(),
                &unregistered,
                plugin_authority::plugin_now_ms().unwrap() + 60_000,
                PluginConsent {
                    unsandboxed_execution: true,
                },
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        runtime.submit(&mut store, &unregistered).unwrap_err().stage,
        "capability"
    );
    assert!(store.plugin_permit(&unregistered).is_err());
    assert!(
        store
            .execution_input(unregistered.envelope().attempt_id)
            .is_err()
    );
    pump_until(&mut runtime, &mut store, |runtime, store| {
        [input_a.envelope().attempt_id, input_b.envelope().attempt_id]
            .into_iter()
            .all(|attempt| {
                !runtime.is_active(attempt)
                    && store
                        .execution_attempt(attempt, true)
                        .unwrap()
                        .progress
                        .unknown
                        == 1
            })
    });
    let observed: BTreeMap<_, _> = (0..2)
        .map(|_| {
            let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(!call.query);
            assert!(
                call.request
                    .plugin_permit()
                    .unwrap()
                    .matches(&call.request.input)
            );
            (call.request.input.envelope().attempt_id, call)
        })
        .collect();
    for fixed in [&input_a, &input_b] {
        let binding = fixed.envelope().plugin.as_ref().unwrap();
        let call = &observed[&fixed.envelope().attempt_id];
        assert_eq!(
            call.environment_digest,
            binding.environment_digest().unwrap()
        );
        assert_eq!(call.request.input.bytes(), fixed.bytes());
        let query = runtime
            .outcome_query(
                &store,
                fixed.envelope().attempt_id,
                fixed.envelope().items[0].item_id,
            )
            .unwrap()
            .unwrap();
        assert!(matches!(query.run().unwrap(), QueryOutcome::Unavailable));
        let call = calls.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(call.query);
        assert_eq!(
            call.request.input.envelope().attempt_id,
            fixed.envelope().attempt_id
        );
        assert_eq!(
            call.environment_digest,
            binding.environment_digest().unwrap()
        );
    }
    assert!(calls.try_recv().is_err());
}

#[test]
fn registration_rejects_unpaired_or_invalid_plugin_environment_choices() {
    let (_temp, _store, mut runtime, _) = setup();
    let binding = plugin_binding("b");
    let (tx, _calls) = mpsc::channel();
    let mut missing_environment = SelectedPlugin::new(&binding, tx.clone());
    missing_environment.environment = None;
    let mut missing_provider = SelectedPlugin::new(&binding, tx.clone());
    missing_provider.provider = None;
    for runner in [missing_environment, missing_provider] {
        assert_eq!(
            runtime.register(Arc::new(runner)).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
    let mut bad_protocol = binding.clone();
    bad_protocol.environment.process_protocol += 1;
    let mut bad_path = binding.clone();
    bad_path.environment.host.entrypoint = "../outside.js".into();
    for bad in [bad_protocol, bad_path] {
        assert!(bad.environment_digest().is_err());
        assert_eq!(bad.validate().unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(
            runtime
                .register(Arc::new(SelectedPlugin::new(&bad, tx.clone())))
                .unwrap_err()
                .stage,
            "plugin-environment"
        );
    }
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&binding, tx.clone())))
        .unwrap();
    assert_eq!(
        runtime
            .register(Arc::new(SelectedPlugin::new(&binding, tx)))
            .unwrap_err()
            .stage,
        "runner-registration"
    );
}

#[test]
fn plugin_environment_restore_retry_and_current_store_reopen_remain_exact() {
    let (temp, mut store, mut runtime, _) = setup();
    let binding = plugin_binding("b");
    let fixed = plugin_input(&store, binding.clone());
    let mut changed = fixed.envelope().clone();
    changed.plugin.as_mut().unwrap().environment = plugin_binding("c").environment;
    assert_ne!(
        FixedInput::capture(changed).unwrap().digest(),
        fixed.digest()
    );
    let restored = FixedInput::restore(fixed.bytes(), fixed.digest()).unwrap();
    assert_eq!(restored.bytes(), fixed.bytes());
    assert_eq!(restored.envelope().plugin.as_ref().unwrap(), &binding);
    let item = fixed.envelope().items[0].item_id;
    let retry = fixed.retry(&[item]).unwrap();
    assert_eq!(retry.envelope().plugin.as_ref().unwrap(), &binding);
    let provider = &binding.capability.provider;
    let channel = sdk::ProviderBinding {
        plugin: provider.plugin.clone(),
        component_id: provider.component_id.clone(),
        contribution_id: provider.contribution_id.clone(),
        package_digest: provider.package_digest.clone(),
        instance_id: "fixture-instance".into(),
        activation_generation: 1,
    };
    assert_eq!(
        fixed
            .plugin_request(item, ExecutionId::new(), &channel)
            .unwrap()
            .context
            .environment_digest,
        binding.environment.digest().unwrap()
    );
    let encoded: serde_json::Value = serde_json::from_slice(fixed.bytes()).unwrap();
    assert!(encoded["plugin"].get("environment").is_some());
    assert!(encoded["plugin"].get("environmentDigest").is_none());
    let mut missing = encoded.clone();
    missing["plugin"]
        .as_object_mut()
        .unwrap()
        .remove("environment");
    let mut legacy = missing.clone();
    legacy["plugin"]["environmentDigest"] = json!(binding.environment_digest().unwrap());
    let mut conflicting = encoded.clone();
    conflicting["plugin"]["environmentDigest"] = json!("d".repeat(64));
    let mut invalid = encoded;
    invalid["plugin"]["environment"]["protocolVersion"] =
        json!(sdk::RUNTIME_ENVIRONMENT_PROTOCOL + 1);
    for value in [missing, legacy, conflicting, invalid] {
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(FixedInput::restore(&bytes, &codec::digest(&bytes)).is_err());
    }
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&binding, mpsc::channel().0)))
        .unwrap();
    authorize(&runtime, &mut store, &fixed);
    runtime.submit(&mut store, &fixed).unwrap();
    drop(runtime);
    store.close().unwrap();
    let path = temp.path().join("project");
    let reopened = ProjectStore::open(&path).unwrap();
    let loaded = reopened
        .execution_input(fixed.envelope().attempt_id)
        .unwrap();
    assert_eq!(loaded.bytes(), fixed.bytes());
    assert_eq!(loaded.envelope().plugin.as_ref().unwrap(), &binding);
    assert!(reopened.plugin_permit(&loaded).is_err());
    reopened.close().unwrap();
}
