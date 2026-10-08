//! Manual checker lifecycle and revocation reuse the real joint IPC fixture.
use super::*;
use std::{
    future::Future,
    task::{Context, Poll, Waker},
    time::Instant,
};

// Only fresh metadata loads may contend with the existing owner tick. Retry
// the same complete intent; deliberate held-lock and recorded reads stay direct.
fn prepare_with_store_retry(window: &Window, intent: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match call(window, "prepare_review_checks", Some(intent.clone())) {
            Ok(preparation) => return preparation,
            Err(error)
                if error["code"] == "busy"
                    && error["outcome"] == "rejected"
                    && error["reason"] == "plugin-store-busy" =>
            {
                assert!(Instant::now() < deadline, "{error:?}");
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("{error:?}"),
        }
    }
}

pub(super) fn rejects_revoked_manual_computation(
    app: &tauri::App<tauri::test::MockRuntime>,
    window: &Window,
    context: &Value,
    recorded_intent: &Value,
    recorded_check: &Value,
    format: &PackageApproval,
    runtime: &RuntimeApproval,
    project_path: &Path,
) {
    assert_eq!(runtime.origin, crate::runtime_bundle::bundled_origin());
    let state = app.state::<AppState>();
    let target_request = scoped(
        context,
        json!({
            "unitId": recorded_intent["unitId"], "locale": recorded_intent["locale"]
        }),
    );
    for disable_package in [true, false] {
        let action = ExecutionId::new();
        let mut intent = recorded_intent.clone();
        intent["actionId"] = json!(action);
        let preparation = prepare_with_store_retry(window, &intent);
        let slots = preparation["view"]["checkers"].as_array().unwrap();
        assert_eq!(slots.len(), 2);
        let grants = slots
            .iter()
            .map(|slot| consent(context, slot))
            .collect::<Vec<_>>();
        let start = scoped(context, json!({"check": intent, "executions": grants}));
        let (reached, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        *state.review_compute_probe.lock().unwrap() =
            Some(crate::commands::execution::review::ComputeProbe {
                action,
                reached,
                release: resume,
            });
        let mut pending = Box::pin(run_review_checks(
            app.state(),
            serde_json::from_value(start.clone()).unwrap(),
        ));
        assert!(matches!(
            pending
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        waiting.recv_timeout(Duration::from_secs(60)).unwrap();
        // The real independently granted workers have completed. Keep their
        // exact original frames before withdrawing permission during compute.
        let history_slots = slots.to_vec();
        let history_grants = grants.clone();
        let histories = state.sessions.with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            history_slots
                .iter()
                .enumerate()
                .map(|(index, slot)| {
                    let attempt = ExecutionId::parse(slot["attemptId"].as_str().unwrap()).unwrap();
                    let status = store.execution_attempt(attempt, false).unwrap();
                    assert_eq!(status.items[0].execution, ExecutionState::Succeeded);
                    let result = store
                        .execution_current_result(attempt, status.items[0].item_id)
                        .unwrap()
                        .unwrap();
                    let frame = store.execution_result(attempt, result).unwrap();
                    assert_eq!(
                        frame
                            .envelope()
                            .plugin
                            .as_ref()
                            .unwrap()
                            .authorization_id
                            .to_string(),
                        history_grants[index]["grantId"].as_str().unwrap()
                    );
                    (attempt, result, frame.bytes().to_vec())
                })
                .collect::<Vec<_>>()
        });
        if disable_package {
            package_enabled(window, &state.plugins, format, false);
        } else {
            // This is the existing application settings mutex and Store CAS,
            // retaining both packages. The Native IPC cannot revoke Node.
            state.plugins.replace_test_runtime_approvals(vec![]);
        }
        release.send(()).unwrap();
        let error = tauri::async_runtime::block_on(pending).unwrap_err();
        assert!(
            error.code == CommandErrorCode::Cancelled
                || (error.code == CommandErrorCode::DependencyConflict
                    && error.reason.as_deref() == Some("plugin-settings-changed")),
            "{error:?}"
        );
        assert_eq!(
            call(window, "read_review_target", Some(target_request.clone())).unwrap()["currentCheck"],
            *recorded_check,
            "revoked computation must not create or replace current QA"
        );
        let project = ExecutionId::parse(context["projectId"].as_str().unwrap()).unwrap();
        state.sessions.with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            for (attempt, result, bytes) in &histories {
                assert_eq!(
                    store.execution_result(*attempt, *result).unwrap().bytes(),
                    bytes.as_slice()
                );
            }
            assert!(
                store
                    .review_check_action(project, action)
                    .unwrap()
                    .is_none()
            );
        });
        // Historical replay remains receipt-first even while the package or
        // runtime is no longer approved. It creates no checker authority.
        assert_eq!(
            call(
                window,
                "prepare_review_checks",
                Some(recorded_intent.clone())
            )
            .unwrap(),
            json!({"kind":"recorded", "run":recorded_check})
        );
        assert_eq!(
            call(
                window,
                "run_review_checks",
                Some(scoped(
                    context,
                    json!({"check":recorded_intent, "executions":[]})
                ))
            )
            .unwrap(),
            *recorded_check
        );
        if disable_package {
            package_enabled(window, &state.plugins, format, true);
        } else {
            // Restore the same exact independent decision, including its
            // application origin; do not synthesize a replacement approval.
            state
                .plugins
                .replace_test_runtime_approvals(vec![runtime.clone()]);
        }
        assert!(
            call(window, "run_review_checks", Some(start)).is_err(),
            "restoring approval cannot renew the old action's grants or settings snapshot"
        );
        assert_eq!(
            call(window, "read_review_target", Some(target_request.clone())).unwrap()["currentCheck"],
            *recorded_check
        );
    }
    partial_submission(
        app,
        window,
        context,
        recorded_intent,
        recorded_check,
        project_path,
        true,
    );
    partial_submission(
        app,
        window,
        context,
        recorded_intent,
        recorded_check,
        project_path,
        false,
    );
    rejects_pre_dispatch_busy(
        app,
        window,
        context,
        recorded_intent,
        recorded_check,
        project_path,
    );
}

fn rejects_pre_dispatch_busy(
    app: &tauri::App<tauri::test::MockRuntime>,
    window: &Window,
    context: &Value,
    recorded_intent: &Value,
    recorded_check: &Value,
    project_path: &Path,
) {
    let state = app.state::<AppState>();
    // The preceding partial-submission fixture registered a one-shot gate.
    // Begin this independent scenario with an idle runtime whose registrations
    // will be the real captured RunnerProxy values, preserving saved receipts.
    state.sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let (host, store) = active.execution_parts().unwrap();
        host.tick(store).unwrap();
        assert!(!host.active(store).unwrap());
        assert!(host.review.jobs.is_empty());
        active.execution = None;
    });
    let connection = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
    let counts = || {
        connection.query_row(
            "SELECT (SELECT COUNT(*) FROM plugin_execution_grants), (SELECT COUNT(*) FROM execution_tasks), (SELECT COUNT(*) FROM review_checks)",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        ).unwrap()
    };
    let before = counts();
    let target = scoped(
        context,
        json!({"unitId":recorded_intent["unitId"], "locale":recorded_intent["locale"]}),
    );
    let before_check =
        call(window, "read_review_target", Some(target.clone())).unwrap()["currentCheck"].clone();
    assert!(!before_check.is_null());
    let mut last = None;
    // More than the two-job limit must remain possible when each preceding
    // failure created no durable grant or execution input.
    for _ in 0..3 {
        let action = ExecutionId::new();
        let mut intent = recorded_intent.clone();
        intent["actionId"] = json!(action);
        let preparation = prepare_with_store_retry(window, &intent);
        let slots = preparation["view"]["checkers"].as_array().unwrap();
        let grants = slots
            .iter()
            .map(|slot| consent(context, slot))
            .collect::<Vec<_>>();
        let start = scoped(context, json!({"check":intent, "executions":grants}));
        let (release, holder) = hold_settings(&state.plugins);
        let error = call(window, "run_review_checks", Some(start.clone())).unwrap_err();
        assert_eq!(error["code"], "busy", "{error}");
        assert_eq!(error["outcome"], "rejected", "{error}");
        assert_eq!(error["reason"], "plugin-store-busy", "{error}");
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            // Holding the actual manager proves that an inert rejected job
            // neither polls installed settings nor guards runtime dispatch.
            host.tick(store).unwrap();
            let job = host.review.jobs.get(&action).unwrap();
            assert!(!job.attached);
            assert!(job.terminal);
            assert!(!job.authorization_attempted);
            assert!(job.rejected_before_dispatch);
            assert!(job.slots.iter().all(|slot| slot.start.is_none()));
            for slot in &job.slots {
                let missing = store
                    .execution_input(slot.input.envelope().attempt_id)
                    .unwrap_err();
                assert_eq!(missing.code, ErrorCode::InvalidInput);
                assert_eq!(missing.stage, "execution-storage");
            }
            assert_eq!(host.review.jobs.len(), 1);
            assert!(!host.active(store).unwrap());
        });
        assert_eq!(
            counts(),
            before,
            "metadata rejection cannot grant, enqueue or adopt"
        );
        assert_eq!(
            call(window, "execution_status", Some(context.clone())).unwrap()["active"],
            false
        );
        assert_eq!(
            call(window, "prepare_review_checks", Some(intent.clone())).unwrap(),
            preparation
        );
        let mut renewed = start.clone();
        renewed["executions"][0]["grantId"] = json!(ExecutionId::new());
        let changed = call(window, "run_review_checks", Some(renewed)).unwrap_err();
        assert_eq!(changed["code"], "dependency-conflict", "{changed}");
        assert_eq!(
            call(window, "read_review_target", Some(target.clone())).unwrap()["currentCheck"],
            before_check
        );
        release.send(()).unwrap();
        holder.join().unwrap();
        last = Some((intent, preparation, start));
    }
    let (intent, preparation, start) = last.unwrap();
    assert_eq!(
        call(window, "prepare_review_checks", Some(intent.clone())).unwrap(),
        preparation
    );
    let checked = call(window, "run_review_checks", Some(start.clone())).unwrap();
    assert_eq!(checked["actionId"], intent["actionId"]);
    for (slot, grant) in preparation["view"]["checkers"]
        .as_array()
        .unwrap()
        .iter()
        .zip(start["executions"].as_array().unwrap())
    {
        let saved = connection.query_row(
            "SELECT grant_id,input_digest,expires_at_ms FROM plugin_execution_grants WHERE attempt_id=?1",
            [slot["attemptId"].as_str().unwrap()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
        ).unwrap();
        assert_eq!(saved.0, grant["grantId"].as_str().unwrap());
        assert_eq!(saved.1, grant["inputDigest"].as_str().unwrap());
        assert_eq!(saved.2.to_string(), grant["expiresAtMs"].as_str().unwrap());
    }
    assert_eq!(
        call(window, "execution_status", Some(context.clone())).unwrap()["active"],
        false
    );
    assert_eq!(
        call(window, "read_review_target", Some(target)).unwrap()["currentCheck"],
        checked
    );
    assert_eq!(
        call(
            window,
            "prepare_review_checks",
            Some(recorded_intent.clone())
        )
        .unwrap(),
        json!({"kind":"recorded", "run":recorded_check})
    );
    // Leave one explicitly rejected metadata action for the fixture's original
    // registered close_project call. It must not require quiescing active work.
    let before_close = counts();
    let mut close_intent = recorded_intent.clone();
    let close_action = ExecutionId::new();
    close_intent["actionId"] = json!(close_action);
    let close_preparation = prepare_with_store_retry(window, &close_intent);
    let close_grants = close_preparation["view"]["checkers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|slot| consent(context, slot))
        .collect::<Vec<_>>();
    let (release, holder) = hold_settings(&state.plugins);
    let close_error = call(
        window,
        "run_review_checks",
        Some(scoped(
            context,
            json!({"check":close_intent, "executions":close_grants}),
        )),
    )
    .unwrap_err();
    assert_eq!(close_error["reason"], "plugin-store-busy", "{close_error}");
    assert_eq!(close_error["outcome"], "rejected", "{close_error}");
    assert_eq!(counts(), before_close);
    assert_eq!(
        call(window, "execution_status", Some(context.clone())).unwrap()["active"],
        false
    );
    state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.tick(store).unwrap();
        assert!(
            host.review
                .jobs
                .get(&close_action)
                .unwrap()
                .rejected_before_dispatch
        );
        assert!(!host.active(store).unwrap());
    });
    release.send(()).unwrap();
    holder.join().unwrap();
}

fn hold_settings(
    plugins: &Arc<crate::commands::plugins::ApplicationPlugins>,
) -> (std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>) {
    let expected = plugins.environment_settings_revision().unwrap();
    let plugins = plugins.clone();
    let (acquired, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        plugins
            .with_environment_revision(expected, || {
                acquired.send(()).unwrap();
                resume.recv_timeout(Duration::from_secs(30)).unwrap();
                Ok(())
            })
            .unwrap();
    });
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    (release, holder)
}

struct GatedRunner {
    inner: Arc<RunnerProxy>,
    reached: std::sync::mpsc::Sender<(Instant, Duration)>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}
impl Runner for GatedRunner {
    fn capability_id(&self) -> &str {
        self.inner.capability_id()
    }
    fn capability_version(&self) -> &str {
        self.inner.capability_version()
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        self.inner.plugin_provider()
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        self.inner.plugin_environment()
    }
    fn concurrency_limit(&self, input: &FixedInput) -> usize {
        self.inner.concurrency_limit(input)
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        // This gate occupies a real Core dispatch, before calling RunnerProxy.
        // Its wait is strictly shorter than the captured package deadline; the
        // fixture never changes that input or claims a Node child is running.
        let wait = Duration::from_millis(u64::from(request.input.envelope().limits.timeout_ms) / 2)
            .min(Duration::from_secs(10));
        self.reached.send((Instant::now(), wait)).map_err(|_| {
            ExecutionError::new(ErrorCode::StorageFailed, "joint-check-gate-observer")
        })?;
        self.release
            .lock()
            .unwrap()
            .recv_timeout(wait)
            .map_err(|_| {
                ExecutionError::new(ErrorCode::StorageFailed, "joint-check-gate-release")
            })?;
        // Delegation remains the real immutable package/process boundary. No
        // result or invocation receipt is produced by this timing gate.
        self.inner.run(request, cancellation, results)
    }
    fn query(&self, request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        self.inner.query(request)
    }
}

fn partial_submission(
    app: &tauri::App<tauri::test::MockRuntime>,
    window: &Window,
    context: &Value,
    recorded_intent: &Value,
    recorded_check: &Value,
    project_path: &Path,
    cancel: bool,
) {
    let state = app.state::<AppState>();
    // Reuse the installed packages and adopted project. Only an idle original
    // runtime is replaced so a real RunnerProxy can be registered behind a gate.
    state.sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let (host, store) = active.execution_parts().unwrap();
        host.tick(store).unwrap();
        assert!(!host.active(store).unwrap());
        active.execution = None;
    });
    let mut intent = recorded_intent.clone();
    let action = ExecutionId::new();
    intent["actionId"] = json!(action);
    let preparation = prepare_with_store_retry(window, &intent);
    let slots = preparation["view"]["checkers"].as_array().unwrap();
    let grants = slots
        .iter()
        .map(|slot| consent(context, slot))
        .collect::<Vec<_>>();
    let start = scoped(context, json!({"check":intent,"executions":grants}));
    let (reached, waiting) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let inputs = state.sessions.with(move |sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let slots = &host.review.preflight.as_ref().unwrap().slots;
        let format = &slots[0];
        let binding = format.environment.binding().unwrap();
        host.runtime
            .register(Arc::new(GatedRunner {
                inner: format.environment.clone().runner().unwrap(),
                reached,
                release: std::sync::Mutex::new(resume),
            }))
            .unwrap();
        host.plugin_registrations.push(binding);
        slots
            .iter()
            .map(|slot| slot.input.clone())
            .collect::<Vec<_>>()
    });
    let connection = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
    connection.execute_batch(&format!(
        "CREATE TRIGGER reject_joint_second_check BEFORE INSERT ON execution_tasks WHEN NEW.task_id='{}' BEGIN SELECT RAISE(ABORT, 'synthetic second-slot enqueue failure'); END;",
        inputs[1].envelope().task_id,
    )).unwrap();
    // Keep the real IPC boundary, but do not hide the dispatch signal behind
    // its synchronous response wait. Both accesses use the original project
    // owner; the command thread owns only its cloned window and request.
    let command_window: Window = window.clone();
    let command_start = start.clone();
    let (completed, completion) = std::sync::mpsc::sync_channel(1);
    let command = std::thread::spawn(move || {
        let response = call(&command_window, "run_review_checks", Some(command_start));
        completed.send(response).unwrap();
    });
    let (entered, gate_wait) = waiting.recv_timeout(Duration::from_secs(10)).unwrap();
    let first_attempt = inputs[0].envelope().attempt_id;
    let first_timeout = inputs[0].envelope().limits.timeout_ms;
    state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let first = host.runtime.attempt(store, first_attempt).unwrap();
        assert_eq!(
            first.items[0].execution,
            ExecutionState::Dispatched,
            "first dispatch before IPC response: elapsed={:?}, timeout_ms={first_timeout}, status={first:?}",
            entered.elapsed(),
        );
        assert!(host.runtime.is_active(first_attempt));
        assert!(entered.elapsed() < gate_wait, "dispatch observation missed the bounded gate");
    });
    let error = completion.recv_timeout(gate_wait).unwrap().unwrap_err();
    command.join().unwrap();
    assert_eq!(error["code"], "storage-failed", "{error}");
    let rows = || {
        let mut statement = connection.prepare(
            "SELECT grant_id,attempt_id,input_digest,expires_at_ms,revoked FROM plugin_execution_grants WHERE grant_id IN (?1,?2) ORDER BY grant_id"
        ).unwrap();
        statement
            .query_map(
                [
                    grants[0]["grantId"].as_str().unwrap(),
                    grants[1]["grantId"].as_str().unwrap(),
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    let original_grants = rows();
    let original_grant_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM plugin_execution_grants", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(original_grants.len(), 2);
    assert!(original_grants.iter().all(|row| row.4 == 0));
    let observed_inputs = inputs.clone();
    state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let job = host.review.jobs.get(&action).unwrap();
        assert!(!job.attached);
        assert!(job.authorization_attempted);
        assert!(!job.rejected_before_dispatch);
        assert_eq!(job.slots[0].input.bytes(), observed_inputs[0].bytes());
        let first = host
            .runtime
            .attempt(store, observed_inputs[0].envelope().attempt_id)
            .unwrap();
        assert_eq!(
            first.items[0].execution,
            ExecutionState::Dispatched,
            "detached partial dispatch: elapsed={:?}, timeout_ms={first_timeout}, status={first:?}",
            entered.elapsed(),
        );
        assert!(
            host.runtime
                .is_active(observed_inputs[0].envelope().attempt_id)
        );
        assert!(
            entered.elapsed() < gate_wait,
            "detached response missed the bounded gate"
        );
        assert!(
            store
                .execution_input(observed_inputs[1].envelope().attempt_id)
                .is_err()
        );
    });
    let target = scoped(
        context,
        json!({"unitId":intent["unitId"],"locale":intent["locale"]}),
    );
    connection
        .execute_batch("DROP TRIGGER reject_joint_second_check")
        .unwrap();
    if cancel {
        assert_eq!(
            call(
                window,
                "cancel_review_checks",
                Some(scoped(context, json!({"actionId":action})))
            )
            .unwrap(),
            true,
            "a detached storage error must retain the original action's cancel entry"
        );
        let first_attempt = inputs[0].envelope().attempt_id;
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            // Withdraw the admitted grants while this original dispatch is
            // still active; release the timing gate before further IPC reads.
            assert!(host.runtime.is_active(first_attempt));
            assert!(
                entered.elapsed() < gate_wait,
                "cancellation missed the bounded gate"
            );
            host.begin_quiesce(store).unwrap();
            assert!(!host.review.jobs.contains_key(&action));
            assert!(
                store.execution_attempt(first_attempt, false).unwrap().items[0]
                    .cancellation_requested
            );
        });
        release.send(()).unwrap();
        call(window, "quiesce_execution", Some(context.clone())).unwrap();
        let revoked = rows();
        for (old, now) in original_grants.iter().zip(&revoked) {
            assert_eq!(
                (&old.0, &old.1, &old.2, old.3),
                (&now.0, &now.1, &now.2, now.3)
            );
            assert_eq!(now.4, 1);
        }
        assert_eq!(
            call(
                window,
                "cancel_review_checks",
                Some(scoped(context, json!({"actionId":action})))
            )
            .unwrap(),
            false
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        while call(window, "execution_status", Some(context.clone())).unwrap()["active"] == true {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            call(window, "read_review_target", Some(target)).unwrap()["currentCheck"],
            *recorded_check
        );
    } else {
        release.send(()).unwrap();
        let first_result = completed_result(window, context, slots[0]["attemptId"].clone());
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.tick(store).unwrap();
            let job = host.review.jobs.get(&action).unwrap();
            assert!(job.authorization_attempted);
            assert!(
                !job.terminal,
                "a granted but missing second input remains recoverable work"
            );
            assert!(host.review.active());
        });
        assert_eq!(
            call(window, "read_review_target", Some(target.clone())).unwrap()["currentCheck"],
            *recorded_check,
            "a completed first slot and missing second slot cannot create QA"
        );
        // A different preview cannot replace an accepted action's recovery IDs.
        let mut other = intent.clone();
        other["actionId"] = json!(ExecutionId::new());
        prepare_with_store_retry(window, &other);
        assert_eq!(
            call(window, "prepare_review_checks", Some(intent.clone())).unwrap(),
            preparation
        );
        let mut renewed = start.clone();
        renewed["executions"][1]["grantId"] = json!(ExecutionId::new());
        assert!(call(window, "run_review_checks", Some(renewed)).is_err());
        let checked = call(window, "run_review_checks", Some(start)).unwrap();
        assert_eq!(checked["actionId"], intent["actionId"]);
        assert_eq!(
            rows(),
            original_grants,
            "reattachment must not renew or add a grant"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM plugin_execution_grants", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            original_grant_count
        );
        let run: CheckRun = serde_json::from_value(checked.clone()).unwrap();
        let origins = run.evidence.as_ref().unwrap().origins.clone();
        assert_eq!(origins.len(), 2);
        assert_eq!(
            origins[0].result_id.to_string(),
            first_result.as_str().unwrap()
        );
        let saved_inputs = inputs.clone();
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(!host.review.jobs.contains_key(&action));
            for (input, origin) in saved_inputs.iter().zip(&origins) {
                assert_eq!(origin.attempt_id, input.envelope().attempt_id);
                assert_eq!(
                    store.execution_input(origin.attempt_id).unwrap().bytes(),
                    input.bytes()
                );
            }
        });
        assert_eq!(
            call(
                window,
                "cancel_review_checks",
                Some(scoped(context, json!({"actionId":action})))
            )
            .unwrap(),
            false
        );
        assert_eq!(
            call(window, "read_review_target", Some(target)).unwrap()["currentCheck"],
            checked
        );
    }
}

fn package_enabled(
    window: &Window,
    plugins: &crate::commands::plugins::ApplicationPlugins,
    approval: &PackageApproval,
    enabled: bool,
) {
    let expected = plugins.environment_settings_revision().unwrap();
    call(
        window,
        "set_plugin_enabled",
        Some(json!({
            "package":{"plugin":approval.plugin, "packageDigest":approval.package_digest},
            "enabled":enabled, "expectedRevision":expected, "actionId":ExecutionId::new()
        })),
    )
    .unwrap();
}
