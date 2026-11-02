use super::*;
use serde_json::{Value, json};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{
    Listener, Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::execution::*;

const WAIT: Duration = Duration::from_secs(5);
const CAPABILITY: &str = "notification-observation";

#[test]
fn change_wire_fixture_preserves_decimal_versions_and_scopes() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/projectChanges.contract.json"
    ))
    .unwrap();
    let request: ChangesRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    assert_eq!(request.after_sequence.get(), 9_007_199_254_740_992);
    let snapshot: ProjectChanges = serde_json::from_value(fixture["snapshot"].clone()).unwrap();
    assert_eq!(serde_json::to_value(snapshot).unwrap(), fixture["snapshot"]);
    let event: ChangeNotification =
        serde_json::from_value(fixture["notification"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        fixture["notification"]
    );
    let mut invalid = fixture["request"].clone();
    invalid["afterSequence"] = json!(9_007_199_254_740_992_u64);
    assert!(serde_json::from_value::<ChangesRequest>(invalid).is_err());
}

fn call(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Value {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request": request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize()
    .unwrap()
}

fn request(context: &Value, extra: Value) -> Value {
    let mut result = context.clone();
    result
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    result
}

#[derive(Debug)]
enum Release {
    Complete,
    StopAfterCancellation,
}

struct Step {
    item: ExecutionId,
    release: mpsc::SyncSender<Release>,
    finished: mpsc::Receiver<bool>,
}

impl Step {
    fn release(self, release: Release) {
        self.release.send(release).unwrap();
        assert!(self.finished.recv_timeout(WAIT).unwrap());
    }
}

struct SteppedRunner(mpsc::SyncSender<Step>);

impl Runner for SteppedRunner {
    fn capability_id(&self) -> &str {
        CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }

    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let (release, next) = mpsc::sync_channel(1);
        let (finished, observed) = mpsc::sync_channel(1);
        self.0
            .send(Step {
                item: request.item_id,
                release,
                finished: observed,
            })
            .map_err(|_| ExecutionError::new(ErrorCode::Cancelled, "observation-fixture"))?;
        match next.recv_timeout(WAIT) {
            Ok(Release::Complete) => {
                let result = FixedResult::capture(
                    ResultEnvelope {
                        plugin: None,
                        project_id: request.input.envelope().project_id,
                        attempt_id: request.input.envelope().attempt_id,
                        item_id: request.item_id,
                        result_id: ExecutionId::new(),
                        supersedes: None,
                        dispatch_token: request.dispatch_token,
                        capability_id: CAPABILITY.into(),
                        capability_version: "1".into(),
                        outcome: ExecutionState::Succeeded,
                        output: Some(json!("completed local item")),
                        diagnostic: None,
                    },
                    &request.input,
                    request.dispatch_token,
                )?;
                results.send(result)?;
                let _ = finished.send(true);
            }
            Ok(Release::StopAfterCancellation) => {
                let _ = finished.send(cancellation.is_requested());
                // No result is fabricated for the already dispatched item.
            }
            Err(_) => {
                return Err(ExecutionError::new(
                    ErrorCode::Cancelled,
                    "observation-barrier",
                ));
            }
        }
        Ok(())
    }
}

fn publish(
    state: &AppState,
    mut notifications: Notifications,
    sink: ChangeSink,
    release_progress: bool,
) -> Notifications {
    state.sessions.with(move |sessions| {
        if release_progress {
            notifications.last_progress = Instant::now() - Duration::from_millis(250);
        }
        notifications.publish(sessions, &sink);
        notifications
    })
}

fn receive_progress(
    received: &mpsc::Receiver<Value>,
    context: &Value,
    epoch: &Value,
    target: &Value,
) -> Vec<Value> {
    let deadline = Instant::now() + WAIT;
    let mut events: Vec<Value> = Vec::new();
    loop {
        let event = received
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("actual dispatch ticker did not publish current execution progress");
        assert_eq!(event["projectId"], context["projectId"]);
        assert_eq!(event["sessionToken"], context["sessionToken"]);
        assert_eq!(event["epoch"], *epoch);
        assert_eq!(event["kind"], "progress");
        assert_eq!(event["scopes"], json!(["execution"]));
        assert!(serde_json::to_vec(&event).unwrap().len() < 1024);
        let after: Revision = serde_json::from_value(event["afterSequence"].clone()).unwrap();
        let sequence: Revision = serde_json::from_value(event["sequence"].clone()).unwrap();
        assert!(sequence > after);
        if let Some(previous) = events.last() {
            assert_eq!(event["afterSequence"], previous["sequence"]);
        }
        let current = event["sequence"] == *target;
        events.push(event);
        assert!(
            events.len() <= 12,
            "progress hints exceeded the bounded fixture work"
        );
        if current {
            return events;
        }
    }
}

fn execution_counts(state: &AppState) -> (u64, Vec<i64>) {
    state.sessions.with(|sessions| {
        let active = sessions.active.as_ref().unwrap();
        let connection = rusqlite::Connection::open_with_flags(
            active.locator.join("project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let counts = [
            "execution_tasks",
            "execution_attempts",
            "execution_cancellations",
            "plugin_execution_grants",
            "execution_provider_requests",
            "execution_budgets",
        ]
        .into_iter()
        .map(|table| {
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
        .collect();
        (active.store.execution_sequence().unwrap().get(), counts)
    })
}

#[test]
fn execution_progress_and_cancel_converge_after_lost_hints_without_restarting_work() {
    let directory = tempfile::tempdir().unwrap();
    let app = super::super::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let (events, received) = mpsc::sync_channel(32);
    let listener = app.listen_any("project-changed", move |event| {
        events
            .try_send(serde_json::from_str::<Value>(event.payload()).unwrap())
            .unwrap();
    });
    let state = app.state::<AppState>();
    // MockRuntime does not run the application's setup/event loop. Attach the
    // same notification sink that native setup installs before creating a session.
    state.connect_change_events(app.handle().clone());
    let created = call(
        &webview,
        "create_project",
        json!({
            "destination": directory.path().join("project"), "displayName": "Progress observation",
            "sourceLocale": "en-US", "targetLocales": ["zh-CN"]
        }),
    );
    let context = json!({"sessionToken": created["sessionToken"],
        "projectId": created["metadata"]["projectId"]});
    let initial_event = received.recv_timeout(WAIT).unwrap();
    assert_eq!(initial_event["kind"], "resync");
    assert_eq!(initial_event["scopes"], json!(["project"]));
    let changes_request = request(&context, json!({"afterSequence": "0"}));
    let initial = call(&webview, "read_project_changes", changes_request.clone());
    assert_eq!(initial["sequence"], "0");
    assert_eq!(initial["progressSequence"], "0");

    // A second instance tests the production coalescing algorithm with a closed
    // time gate. The application's real dispatch ticker is observed separately.
    let (hints, gated_hints) = mpsc::sync_channel(2);
    let sink: ChangeSink = Arc::new(move |hint| {
        assert!(
            hints.try_send(hint).is_ok(),
            "coalesced hint channel overflowed"
        );
    });
    let mut notifications = publish(&state, Notifications::default(), sink.clone(), false);
    assert!(matches!(
        gated_hints.recv_timeout(WAIT).unwrap().kind,
        NotificationKind::Resync
    ));
    notifications.last_progress = Instant::now() + Duration::from_secs(60);

    let (steps, calls) = mpsc::sync_channel(1);
    let input = state.sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let items = (0..12)
            .map(|index| {
                InputItem::new(
                    Scope {
                        kind: "fixture".into(),
                        id: format!("item-{index}"),
                        locale: None,
                    },
                    json!(index),
                    vec![],
                )
            })
            .collect();
        let input = FixedInput::capture(
            InputEnvelope::new(
                active.store.metadata().unwrap().project_id(),
                "notification-fixture",
                CAPABILITY,
                "1",
                items,
            )
            .unwrap(),
        )
        .unwrap();
        active
            .submit_observation_fixture(&input, Arc::new(SteppedRunner(steps)))
            .unwrap();
        input
    });
    let attempt = input.envelope().attempt_id;
    let task = input.envelope().task_id;
    let detail_request = request(
        &context,
        json!({"attemptId": attempt, "offset": 0, "limit": 100}),
    );
    let mut step = calls.recv_timeout(WAIT).unwrap();
    for completed in 1..=4 {
        step.release(Release::Complete);
        // The next dispatch is the deterministic witness that the previous
        // result has reached the real Core ledger through the Host ticker.
        step = calls.recv_timeout(WAIT).unwrap();
        let detail = call(&webview, "read_execution_attempt", detail_request.clone());
        assert_eq!(detail["progress"]["succeeded"], completed);
        notifications = publish(&state, notifications, sink.clone(), false);
        assert!(gated_hints.try_recv().is_err());
    }
    let observed = call(&webview, "read_project_changes", changes_request.clone());
    let first_events = receive_progress(
        &received,
        &context,
        &initial["epoch"],
        &observed["progressSequence"],
    );
    assert_eq!(observed["sequence"], "0");
    assert!(observed["progressSequence"] != initial["progressSequence"]);

    // Drop the transport during real result commits and the actual cancel IPC.
    state.disconnect_change_events();
    state.sessions.with(|_| ());
    assert!(received.try_recv().is_err());
    for completed in 5..=8 {
        step.release(Release::Complete);
        step = calls.recv_timeout(WAIT).unwrap();
        assert_eq!(
            call(&webview, "read_execution_attempt", detail_request.clone())["progress"]["succeeded"],
            completed
        );
        notifications = publish(&state, notifications, sink.clone(), false);
        assert!(gated_hints.try_recv().is_err());
    }
    let held_item = step.item;
    assert_eq!(
        call(
            &webview,
            "cancel_execution_task",
            request(
                &context,
                json!({
                    "taskId": task, "requestId": ExecutionId::new()
                })
            )
        ),
        "1"
    );
    let cancelled = call(
        &webview,
        "read_execution_task_view",
        request(&context, json!({"taskId": task})),
    );
    assert_eq!(cancelled["cancellationRevision"], "1");
    let cancelling = call(&webview, "read_execution_attempt", detail_request.clone());
    assert_eq!(cancelling["progress"]["cancelled"], 3);
    let held = cancelling["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["status"]["itemId"] == json!(held_item))
        .unwrap();
    assert_eq!(held["status"]["cancellationRequested"], true);
    notifications = publish(&state, notifications, sink.clone(), false);
    assert!(gated_hints.try_recv().is_err());
    assert!(received.try_recv().is_err());
    step.release(Release::StopAfterCancellation);

    let deadline = Instant::now() + WAIT;
    let settled = loop {
        let snapshot = call(&webview, "read_project_changes", changes_request.clone());
        assert_eq!(snapshot["runtime"]["error"], Value::Null);
        if snapshot["runtime"]["active"] == false {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "cancelled worker did not settle");
        std::thread::yield_now();
    };
    let final_detail = call(&webview, "read_execution_attempt", detail_request.clone());
    assert_eq!(final_detail["progress"]["succeeded"], 8);
    assert_eq!(final_detail["progress"]["cancelled"], 3);
    assert_eq!(final_detail["progress"]["unknown"], 1);
    assert_eq!(settled["epoch"], initial["epoch"]);
    assert_eq!(settled["sequence"], "0");
    assert_eq!(settled["scopes"], json!([]));
    assert_eq!(settled["runtime"]["queryCount"], 0);

    // Many committed progress/control writes collapse to exactly one latest
    // hint when the gate opens; repeated reads/publications create no new work.
    let before_observing = execution_counts(&state);
    assert_eq!(before_observing.1, [1, 1, 1, 0, 0, 0]);
    notifications = publish(&state, notifications, sink.clone(), true);
    let hint = gated_hints.recv_timeout(WAIT).unwrap();
    assert!(matches!(hint.kind, NotificationKind::Progress));
    assert_eq!(hint.after_sequence.get(), 0);
    assert_eq!(
        serde_json::to_value(hint.sequence).unwrap(),
        settled["progressSequence"]
    );
    assert_eq!(hint.scopes, [ChangeScope::Execution]);
    assert!(serde_json::to_vec(&hint).unwrap().len() < 1024);
    let _notifications = publish(&state, notifications, sink, true);
    assert!(gated_hints.try_recv().is_err());

    state.connect_change_events(app.handle().clone());
    let final_events = receive_progress(
        &received,
        &context,
        &initial["epoch"],
        &settled["progressSequence"],
    );
    assert_eq!(final_events.len(), 1);
    assert_eq!(
        final_events[0]["afterSequence"],
        observed["progressSequence"]
    );
    assert!(first_events.len() + final_events.len() <= 9);
    assert_eq!(
        call(&webview, "read_project_changes", changes_request),
        settled
    );
    assert_eq!(
        call(&webview, "read_execution_attempt", detail_request),
        final_detail
    );
    assert_eq!(
        call(
            &webview,
            "read_execution_task_view",
            request(&context, json!({"taskId": task}))
        ),
        cancelled
    );
    assert_eq!(execution_counts(&state), before_observing);
    assert!(calls.try_recv().is_err());
    state.disconnect_change_events();
    app.unlisten(listener);
    call(
        &webview,
        "close_project",
        json!({"sessionToken": context["sessionToken"]}),
    );
}
