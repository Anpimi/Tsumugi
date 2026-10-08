use super::*;

struct HeldCall {
    request: DispatchRequest,
    cancellation: Cancellation,
    release: mpsc::Sender<()>,
}
struct HeldPlugin {
    binding: PluginExecutionBinding,
    calls: mpsc::Sender<HeldCall>,
    hold_run: bool,
}
impl HeldPlugin {
    fn hold(&self, request: DispatchRequest, cancellation: Cancellation) {
        let (release, wait) = mpsc::channel();
        self.calls
            .send(HeldCall {
                request,
                cancellation,
                release,
            })
            .unwrap();
        // Intentionally uncooperative until the test releases this owned call.
        let _ = wait.recv();
    }
}
impl Runner for HeldPlugin {
    fn capability_id(&self) -> &str {
        &self.binding.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.binding.environment)
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        _results: ResultSender,
    ) -> Result<(), ExecutionError> {
        if self.hold_run {
            self.hold(request, cancellation);
        }
        Ok(())
    }
    fn query(&self, request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        self.hold(request.clone(), Cancellation::default());
        Ok(QueryOutcome::Pending)
    }
}
fn other_package() -> PluginExecutionBinding {
    let mut binding = plugin_binding("b");
    // Same capability and bytes digest, but a different complete package identity.
    binding.capability.provider.plugin.id = "example.other".into();
    binding
}
fn immediate_cancel(store: &ProjectStore, binding: PluginExecutionBinding) -> FixedInput {
    let mut envelope = plugin_input(store, binding).envelope().clone();
    envelope.limits.cancel_wait_ms = 0;
    FixedInput::capture(envelope).unwrap()
}
fn finish_package(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    token: &PackageQuiescence,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match runtime.finish_package_quiesce(store, token) {
            Ok(()) => break,
            Err(error) if error.code == ErrorCode::Busy => {
                assert!(Instant::now() < deadline, "package drain did not finish");
                std::thread::yield_now();
            }
            Err(error) => panic!("unexpected package drain error: {error:?}"),
        }
    }
}
fn database(temp: &tempfile::TempDir) -> rusqlite::Connection {
    rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap()
}
fn revoked(connection: &rusqlite::Connection, input: &FixedInput) -> bool {
    connection
        .query_row(
            "SELECT revoked FROM plugin_execution_grants WHERE attempt_id=?1",
            [input.envelope().attempt_id.to_string()],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn exact_package_stop_revokes_all_environments_and_drains_without_stopping_other_packages() {
    let (temp, mut store, mut runtime, _) = setup();
    let generation = runtime.generation();
    let (held_tx, held_calls) = mpsc::channel();
    let a = plugin_binding("b");
    let a2 = plugin_binding("c");
    for binding in [&a, &a2] {
        runtime
            .register_read_only(Arc::new(HeldPlugin {
                binding: binding.clone(),
                calls: held_tx.clone(),
                hold_run: true,
            }))
            .unwrap();
    }
    let (tx, other_calls) = mpsc::channel();
    let b = other_package();
    let mut c = a.clone();
    c.capability.provider.package_digest = "d".repeat(64);
    for binding in [&b, &c] {
        runtime
            .register_read_only(Arc::new(SelectedPlugin::new(binding, tx.clone())))
            .unwrap();
    }
    let active = [
        immediate_cancel(&store, a.clone()),
        immediate_cancel(&store, a2.clone()),
    ];
    for fixed in &active {
        authorize(&runtime, &mut store, fixed);
        runtime.submit(&mut store, fixed).unwrap();
    }
    runtime.tick(&mut store).unwrap();
    let first = held_calls.recv_timeout(Duration::from_secs(5)).unwrap();
    let second = held_calls.recv_timeout(Duration::from_secs(5)).unwrap();
    let queued = immediate_cancel(&store, a.clone());
    let idle = plugin_input(&store, a.clone());
    let other = [
        plugin_input(&store, b.clone()),
        plugin_input(&store, c.clone()),
    ];
    for fixed in [&queued, &idle, &other[0], &other[1]] {
        authorize(&runtime, &mut store, fixed);
    }
    let idle_permit = store.plugin_permit(&idle).unwrap();
    let other_permits: Vec<_> = other
        .iter()
        .map(|fixed| store.plugin_permit(fixed).unwrap())
        .collect();
    runtime.submit(&mut store, &queued).unwrap();
    for fixed in &other {
        runtime.submit(&mut store, fixed).unwrap();
    }
    let action = ExecutionId::new();
    let token = runtime
        .begin_package_quiesce(
            &mut store,
            action,
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    assert!(!idle_permit.is_authorized());
    assert!(!first.request.plugin_permit().unwrap().is_authorized());
    assert!(!second.request.plugin_permit().unwrap().is_authorized());
    assert!(first.cancellation.is_requested() && second.cancellation.is_requested());
    assert!(other_permits.iter().all(PluginPermit::is_authorized));
    let connection = database(&temp);
    for fixed in [&active[0], &active[1], &queued, &idle] {
        assert!(revoked(&connection, fixed));
    }
    for fixed in &other {
        assert!(!revoked(&connection, fixed));
    }
    let revision = runtime
        .attempt(&store, active[0].envelope().attempt_id)
        .unwrap()
        .cancellation_revision;
    for _ in 0..2 {
        assert_eq!(
            runtime
                .finish_package_quiesce(&mut store, &token)
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        runtime
            .begin_package_quiesce(
                &mut store,
                action,
                &a.capability.provider.plugin,
                &a.capability.provider.package_digest,
            )
            .unwrap();
        assert_eq!(
            runtime
                .attempt(&store, active[0].envelope().attempt_id)
                .unwrap()
                .cancellation_revision,
            revision
        );
    }
    assert_eq!(runtime.generation(), generation);
    assert_eq!(runtime.retired.len(), 2);
    assert!(runtime.has_active_work(&store).unwrap());
    assert_eq!(
        runtime
            .attempt(&store, queued.envelope().attempt_id)
            .unwrap()
            .progress
            .cancelled,
        1
    );
    assert_eq!(
        runtime
            .register_read_only(Arc::new(SelectedPlugin::new(&a, tx.clone())))
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    assert_eq!(
        runtime.submit(&mut store, &idle).unwrap_err().code,
        ErrorCode::Busy
    );
    let rejected = plugin_input(&store, a.clone());
    assert!(
        runtime
            .authorize_plugin(
                &mut store,
                ExecutionId::new(),
                &rejected,
                plugin_authority::plugin_now_ms().unwrap() + 60_000,
                PluginConsent {
                    unsandboxed_execution: true
                }
            )
            .is_err()
    );
    first.release.send(()).unwrap();
    // One still-live retired target leaves room for real independent dispatch.
    pump_until(&mut runtime, &mut store, |_, store| {
        other.iter().all(|fixed| {
            store
                .execution_attempt(fixed.envelope().attempt_id, true)
                .unwrap()
                .progress
                .unknown
                == 1
        })
    });
    let observed: BTreeSet<_> = (0..2)
        .map(|_| {
            other_calls
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .request
                .input
                .envelope()
                .attempt_id
        })
        .collect();
    assert_eq!(
        observed,
        other
            .iter()
            .map(|fixed| fixed.envelope().attempt_id)
            .collect()
    );
    for fixed in &other {
        let view = runtime
            .attempt(&store, fixed.envelope().attempt_id)
            .unwrap();
        assert!(!view.items[0].cancellation_requested);
    }
    assert_eq!(
        runtime
            .finish_package_quiesce(&mut store, &token)
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    second.release.send(()).unwrap();
    finish_package(&mut runtime, &mut store, &token);
    assert_eq!(runtime.generation(), generation);
    assert!(runtime.retired.is_empty());
    for fixed in &active {
        let view = runtime
            .attempt(&store, fixed.envelope().attempt_id)
            .unwrap();
        assert_eq!((view.progress.unknown, view.progress.adopted), (1, 0));
    }
    assert!(!runtime.runners.contains_key(&input_key(&idle).unwrap()));
    assert!(
        other
            .iter()
            .all(|fixed| runtime.runners.contains_key(&input_key(fixed).unwrap()))
    );
    assert!(other_permits.iter().all(PluginPermit::is_authorized));
}

#[test]
fn busy_storage_retains_original_package_grants_after_unrelated_authorization_collects_handles() {
    let (temp, mut store, mut runtime, _) = setup();
    let (tx, _) = mpsc::channel();
    let a = plugin_binding("b");
    let b = other_package();
    for binding in [&a, &b] {
        runtime
            .register_read_only(Arc::new(SelectedPlugin::new(binding, tx.clone())))
            .unwrap();
    }
    let target = [
        plugin_input(&store, a.clone()),
        plugin_input(&store, a.clone()),
    ];
    let other = plugin_input(&store, b.clone());
    for fixed in [&target[0], &target[1], &other] {
        authorize(&runtime, &mut store, fixed);
    }
    let target_permits: Vec<_> = target
        .iter()
        .map(|fixed| store.plugin_permit(fixed).unwrap())
        .collect();
    let other_permit = store.plugin_permit(&other).unwrap();
    let blocker = database(&temp);
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let action = ExecutionId::new();
    assert_eq!(
        runtime
            .begin_package_quiesce(
                &mut store,
                action,
                &a.capability.provider.plugin,
                &a.capability.provider.package_digest
            )
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    assert!(target_permits.iter().all(|permit| !permit.is_authorized()));
    assert!(other_permit.is_authorized());
    assert!(target.iter().all(|fixed| !revoked(&blocker, fixed)));
    assert_eq!(
        runtime
            .register_read_only(Arc::new(SelectedPlugin::new(&a, tx.clone())))
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    // New independent authorization garbage-collects revoked live handles.
    let another = plugin_input(&store, b);
    authorize(&runtime, &mut store, &another);
    let token = runtime
        .begin_package_quiesce(
            &mut store,
            action,
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    assert!(target.iter().all(|fixed| revoked(&blocker, fixed)));
    assert!(!revoked(&blocker, &other) && !revoked(&blocker, &another));
    finish_package(&mut runtime, &mut store, &token);
    assert!(other_permit.is_authorized());
    assert!(runtime.has_active_work(&store).is_ok_and(|active| !active));
}

#[test]
fn active_query_drains_and_captured_callbacks_stay_closed_after_package_completion() {
    let (_temp, mut store, mut runtime, _) = setup();
    let a = plugin_binding("b");
    let (held_tx, held_calls) = mpsc::channel();
    runtime
        .register_read_only(Arc::new(HeldPlugin {
            binding: a.clone(),
            calls: held_tx,
            hold_run: false,
        }))
        .unwrap();
    let fixed = plugin_input(&store, a.clone());
    authorize(&runtime, &mut store, &fixed);
    runtime.submit(&mut store, &fixed).unwrap();
    pump_until(&mut runtime, &mut store, |runtime, store| {
        !runtime.is_active(fixed.envelope().attempt_id)
            && store
                .execution_attempt(fixed.envelope().attempt_id, true)
                .unwrap()
                .progress
                .unknown
                == 1
    });
    let query = Arc::new(
        runtime
            .outcome_query(
                &store,
                fixed.envelope().attempt_id,
                fixed.envelope().items[0].item_id,
            )
            .unwrap()
            .unwrap(),
    );
    let captured = runtime
        .outcome_query(
            &store,
            fixed.envelope().attempt_id,
            fixed.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let running = query.clone();
    let thread = std::thread::spawn(move || running.run());
    let held = held_calls.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(held.request.input.bytes(), fixed.bytes());
    let token = runtime
        .begin_package_quiesce(
            &mut store,
            ExecutionId::new(),
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    assert_eq!(captured.run().err().unwrap().code, ErrorCode::Unauthorized);
    assert_eq!(
        runtime
            .finish_package_quiesce(&mut store, &token)
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    held.release.send(()).unwrap();
    let outcome = thread.join().unwrap().unwrap();
    finish_package(&mut runtime, &mut store, &token);
    assert_eq!(query.run().err().unwrap().code, ErrorCode::Unauthorized);
    assert_eq!(
        runtime
            .apply_query_outcome(&mut store, &query, outcome)
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
fn completed_original_control_cannot_stop_or_unregister_an_explicit_reinstall() {
    let (_temp, mut store, mut runtime, _) = setup();
    let a = plugin_binding("b");
    let (tx, calls) = mpsc::channel();
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&a, tx.clone())))
        .unwrap();
    let action = ExecutionId::new();
    let old = runtime
        .begin_package_quiesce(
            &mut store,
            action,
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    finish_package(&mut runtime, &mut store, &old);
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&a, tx.clone())))
        .unwrap();
    let newer = runtime
        .begin_package_quiesce(
            &mut store,
            ExecutionId::new(),
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    runtime.finish_package_quiesce(&mut store, &old).unwrap();
    runtime
        .begin_package_quiesce(
            &mut store,
            action,
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    let denied = plugin_input(&store, a.clone());
    assert_eq!(
        runtime.submit(&mut store, &denied).unwrap_err().code,
        ErrorCode::Busy
    );
    assert!(runtime.runners.contains_key(&input_key(&denied).unwrap()));
    finish_package(&mut runtime, &mut store, &newer);
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&a, tx)))
        .unwrap();
    runtime.finish_package_quiesce(&mut store, &old).unwrap();
    runtime
        .begin_package_quiesce(
            &mut store,
            action,
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    let fresh = plugin_input(&store, a);
    authorize(&runtime, &mut store, &fresh);
    runtime.submit(&mut store, &fresh).unwrap();
    pump_until(&mut runtime, &mut store, |_, store| {
        store
            .execution_attempt(fresh.envelope().attempt_id, true)
            .unwrap()
            .progress
            .unknown
            == 1
    });
    assert_eq!(
        calls
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .request
            .input
            .bytes(),
        fresh.bytes()
    );
    assert!(store.plugin_permit(&fresh).unwrap().is_authorized());
}

#[test]
fn controls_are_bounded_owned_by_one_store_and_invalidated_by_global_rotation() {
    let (_temp, mut store, mut runtime, _) = setup();
    let (_other_temp, mut other_store, _, _) = setup();
    let a = plugin_binding("b");
    assert_eq!(
        runtime
            .begin_package_quiesce(
                &mut other_store,
                ExecutionId::new(),
                &a.capability.provider.plugin,
                &a.capability.provider.package_digest
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut first = None;
    for index in 0..128 {
        let mut plugin = a.capability.provider.plugin.clone();
        plugin.id = format!("example.package-{index}");
        let token = runtime
            .begin_package_quiesce(
                &mut store,
                ExecutionId::new(),
                &plugin,
                &a.capability.provider.package_digest,
            )
            .unwrap();
        finish_package(&mut runtime, &mut store, &token);
        first.get_or_insert(token);
    }
    assert_eq!(
        runtime
            .begin_package_quiesce(
                &mut store,
                ExecutionId::new(),
                &a.capability.provider.plugin,
                &a.capability.provider.package_digest
            )
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    assert!(runtime.has_active_work(&store).is_ok_and(|active| !active));
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    assert_eq!(
        runtime
            .finish_package_quiesce(&mut store, &first.unwrap())
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let token = runtime
        .begin_package_quiesce(
            &mut store,
            ExecutionId::new(),
            &a.capability.provider.plugin,
            &a.capability.provider.package_digest,
        )
        .unwrap();
    finish_package(&mut runtime, &mut store, &token);
}
