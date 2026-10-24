use super::*;
use serde_json::{Value, json};
use std::{
    sync::{Condvar, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::{content, execution::*};

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|r| r.deserialize().unwrap())
}
fn source(store: &mut ProjectStore) -> (ExecutionId, ExecutionId, SourceConfirmation) {
    // A later adoption must contain an actual source change, rather than only
    // new execution identities for the same already adopted source bytes.
    let revision = store.content_scope().unwrap().revision.get();
    let bytes =
        serde_json::to_vec(&json!({"entry":format!("Copper 👩🏽‍💻 revision {revision}")})).unwrap();
    let source = content::SourceBundle::capture(
        include_bytes!("../../../../../../crates/core/tests/fixtures/stardew-lookup/manifest.json"),
        &bytes,
        "en",
    )
    .unwrap();
    let input = source
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime
        .register_read_only(Arc::new(content::SourceRunner))
        .unwrap();
    runtime.submit(store, &input).unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let result = loop {
        runtime.tick(store).unwrap();
        if let Some(id) = store
            .execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap()
        {
            break id;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(2));
    };
    let preview = store
        .source_preview(input.envelope().attempt_id, result, 0, 100)
        .unwrap();
    (input.envelope().attempt_id, result, preview.confirmation)
}
struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    directory: tempfile::TempDir,
    project: Value,
    context: Value,
    request: Value,
    activation: Value,
}
struct Gate {
    reached: mpsc::Receiver<()>,
    release: Option<mpsc::SyncSender<()>>,
}
impl Gate {
    fn entered(&self) {
        self.reached
            .recv_timeout(Duration::from_secs(5))
            .expect("hook did not enter original IO executor");
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .invoke_handler(execution::production_handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let project = call(
            &window,
            "create_project",
            json!({"destination":directory.path().join("project"),"displayName":"Synthetic hook",
            "sourceLocale":"en","targetLocales":["zh-CN"]}),
        )
        .unwrap();
        let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
        let (attempt, result, confirmation) = app
            .state::<AppState>()
            .sessions
            .with(|s| source(&mut s.active.as_mut().unwrap().store));
        let descriptor = call(
            &window,
            "read_source_maintenance_hook_session",
            context.clone(),
        )
        .unwrap();
        let activation = json!({"policyVersion":descriptor["policyVersion"],"sessionEpoch":descriptor["sessionEpoch"],"locale":"zh-CN","after":0,"limit":100,
            "expiresAtMs":u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()+300_000});
        let mut request = context.clone();
        request["attemptId"] = json!(attempt);
        request["resultId"] = json!(result);
        request["actionId"] = json!(ExecutionId::new());
        request["confirmation"] = serde_json::to_value(confirmation).unwrap();
        request["confirmation"]["maintenanceHook"] = activation.clone();
        Self {
            app,
            window,
            directory,
            project,
            context,
            request,
            activation,
        }
    }
    fn body(&self, body: Value) -> Value {
        let mut value = self.context.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(body.as_object().unwrap().clone());
        value
    }
    fn prepare(&self) -> Value {
        call(
            &self.window,
            "prepare_source_adoption",
            self.request.clone(),
        )
        .unwrap()
    }
    fn adopt(&self) -> Value {
        call(
            &self.window,
            "adopt_execution",
            self.body(json!({"actionId":self.request["actionId"]})),
        )
        .unwrap()
    }
    fn read(&self) -> Value {
        call(
            &self.window,
            "read_source_maintenance_hook",
            self.body(json!({"sourceActionId":self.request["actionId"]})),
        )
        .unwrap()
    }
    fn stop_request(&self) -> Value {
        json!({"projectId":self.context["projectId"],"sourceActionId":self.request["actionId"],"actionId":ExecutionId::new(),"activation":self.activation})
    }
    fn stop(&self, request: &Value) -> Value {
        call(
            &self.window,
            "stop_source_maintenance_hook",
            self.body(json!({"stop":request})),
        )
        .unwrap()
    }
    fn sequence(&self) -> Revision {
        self.app.state::<AppState>().sessions.with(|s| {
            s.active
                .as_ref()
                .unwrap()
                .store
                .execution_sequence()
                .unwrap()
        })
    }
    fn source_scope(&self) -> content::ContentScope {
        serde_json::from_value(
            call(&self.window, "read_content_scope", self.context.clone()).unwrap(),
        )
        .unwrap()
    }
    fn wait(&self, phase: &str) -> Value {
        let until = Instant::now() + Duration::from_secs(8);
        loop {
            let view = self.read();
            if view["view"]["phase"] == phase && view["callbacksDrained"] == true {
                return view;
            }
            assert!(Instant::now() < until, "hook did not settle: {view}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn hold(&self) -> Gate {
        let action = serde_json::from_value(self.request["actionId"].clone()).unwrap();
        let (entered, reached) = mpsc::sync_channel(1);
        let (release, wait) = mpsc::sync_channel(1);
        self.app.state::<AppState>().sessions.with(move |s| {
            s.source_hooks.probe = Some(ComputeProbe {
                action,
                reached: entered,
                release: wait,
            });
        });
        Gate {
            reached,
            release: Some(release),
        }
    }
}

#[test]
fn source_maintenance_hook_registered_postcommit_notice_is_once_and_source_ack_is_unchanged() {
    let f = Fixture::new();
    f.prepare();
    let gate = f.hold();
    let receipt = f.adopt();
    gate.entered();
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["changes"][0]["kind"], "source-snapshot");
    let running = f.read();
    assert_eq!(running["state"], "adopted");
    assert_eq!(running["view"]["phase"], "running");
    assert_eq!(running["callbacksDrained"], false);
    assert_eq!(
        running["view"]["cause"]["sourceActionId"],
        f.request["actionId"]
    );
    let sequence = f.sequence();
    assert_eq!(f.adopt(), receipt);
    assert_eq!(f.sequence(), sequence);
    drop(gate);
    let observed = f.wait("observed");
    let assessment = &observed["view"]["outcome"]["assessment"];
    assert_eq!(
        assessment["sourceSnapshotId"],
        observed["view"]["cause"]["sourceSnapshotId"]
    );
    assert_eq!(assessment["locale"], "zh-CN");
    assert_eq!(assessment["after"], 0);
    assert_eq!(assessment["limit"], 100);
    assert_eq!(assessment["rows"].as_array().unwrap().len(), 1);
    assert_eq!(assessment["rows"][0]["suggested"], "repair");
    let final_sequence = f.sequence();
    for _ in 0..4 {
        assert_eq!(f.read()["view"]["outcome"], observed["view"]["outcome"]);
    }
    assert_eq!(f.sequence(), final_sequence);
    assert_eq!(f.adopt(), receipt);
}

#[test]
fn source_maintenance_hook_stop_not_known_is_not_a_tombstone_and_prepared_stop_blocks_late_adopt() {
    let f = Fixture::new();
    let request = f.stop_request();
    let absent = f.stop(&request);
    assert_eq!(absent["result"]["kind"], "not-known");
    assert_eq!(f.read()["state"], "action-not-known");
    f.prepare();
    let prepared = f.read();
    assert_eq!(prepared["state"], "prepared");
    assert_eq!(prepared["view"]["admissionClosed"], false);
    let stopped = f.stop(&request);
    assert_eq!(stopped["result"]["kind"], "stopped");
    assert_eq!(stopped["callbacksDrained"], true);
    assert_eq!(f.stop(&request), stopped);
    let before = f.sequence();
    let source_before = f.source_scope();
    let receipt = f.adopt();
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["changes"][0]["kind"], "source-snapshot");
    let source_after = f.source_scope();
    assert_eq!(
        source_after.revision,
        source_before.revision.next().unwrap()
    );
    assert_eq!(
        receipt["changes"][0]["revision"],
        json!(source_after.revision)
    );
    let snapshot: ExecutionId =
        serde_json::from_value(receipt["changes"][0]["id"].clone()).unwrap();
    assert_eq!(source_after.current_snapshot, Some(snapshot));
    let view = f.wait("stopped");
    assert_eq!(view["state"], "adopted");
    assert!(view["view"]["outcome"].is_null());
    assert_eq!(
        view["view"]["cause"]["contentRevision"],
        receipt["changes"][0]["revision"]
    );
    assert_eq!(f.adopt(), receipt);
    assert_eq!(f.source_scope(), source_after);
    assert_eq!(f.sequence(), before);
    let mut changed = request.clone();
    changed["activation"]["locale"] = json!("fr");
    assert!(
        call(
            &f.window,
            "stop_source_maintenance_hook",
            f.body(json!({"stop":changed}))
        )
        .is_err()
    );
}

#[test]
fn source_maintenance_hook_stop_and_close_wait_for_original_io_and_do_not_publish_late_assessment()
{
    let f = Fixture::new();
    f.prepare();
    let gate = f.hold();
    let receipt = f.adopt();
    gate.entered();
    let request = f.stop_request();
    let stopped = f.stop(&request);
    assert_eq!(stopped["callbacksDrained"], false);
    assert_eq!(f.read()["view"]["phase"], "stopped");
    let close = call(
        &f.window,
        "close_project",
        json!({"sessionToken":f.context["sessionToken"]}),
    )
    .unwrap_err();
    assert_eq!(close["code"], "busy");
    assert_eq!(f.adopt(), receipt);
    drop(gate);
    let view = f.wait("stopped");
    assert!(view["view"]["outcome"]["assessment"].is_null());
    assert_eq!(view["view"]["outcome"]["phase"], "stopped");
    call(
        &f.window,
        "close_project",
        json!({"sessionToken":f.context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &f.window,
        "open_project",
        json!({"locator":f.project["locator"]}),
    )
    .unwrap();
    let old=call(&f.window,"read_source_maintenance_hook",json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"],"sourceActionId":f.request["actionId"]})).unwrap();
    assert_eq!(old["view"]["outcome"], view["view"]["outcome"]);
    assert_eq!(old["callbacksDrained"], true);
    assert!(
        call(
            &f.window,
            "read_source_maintenance_hook",
            f.body(json!({"sourceActionId":f.request["actionId"]}))
        )
        .is_err()
    );
}

#[test]
fn source_maintenance_hook_control_saturation_finishes_once_without_io_and_allows_a_new_cause() {
    let mut f = Fixture::new();
    f.prepare();
    let gate = f.hold();
    let controls: Vec<_> = (0..4)
        .map(|_| {
            f.app
                .state::<AppState>()
                .sessions
                .lease(CommandStage::ExecutionCancel)
                .unwrap()
        })
        .collect();
    assert_eq!(
        f.app
            .state::<AppState>()
            .sessions
            .lease(CommandStage::ExecutionCancel)
            .err()
            .unwrap()
            .code,
        CommandErrorCode::Busy
    );
    let receipt = f.adopt();
    let failed = f.wait("failed");
    assert_eq!(failed["view"]["admissionClosed"], true);
    assert_eq!(failed["view"]["outcome"]["error"]["code"], "busy");
    assert_eq!(
        failed["view"]["outcome"]["error"]["stage"],
        "source-hook-admission"
    );
    assert!(failed["view"]["outcome"]["assessment"].is_null());
    assert!(failed["error"].is_null());
    assert_eq!(gate.reached.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 1);
    let original_request = f.request.clone();
    let sequence = f.sequence();
    drop(controls);
    for _ in 0..3 {
        assert_eq!(f.read()["view"]["outcome"], failed["view"]["outcome"]);
        assert_eq!(f.adopt(), receipt);
    }
    assert_eq!(f.sequence(), sequence);
    assert_eq!(gate.reached.try_recv(), Err(mpsc::TryRecvError::Empty));
    f.app.state::<AppState>().sessions.with(|s| {
        assert!(
            s.active
                .as_ref()
                .unwrap()
                .store
                .next_source_maintenance_hook()
                .unwrap()
                .is_none()
        );
    });
    drop(gate);

    let (attempt, result, confirmation) = f
        .app
        .state::<AppState>()
        .sessions
        .with(|s| source(&mut s.active.as_mut().unwrap().store));
    f.request["actionId"] = json!(ExecutionId::new());
    f.request["attemptId"] = json!(attempt);
    f.request["resultId"] = json!(result);
    f.request["confirmation"] = serde_json::to_value(confirmation).unwrap();
    f.request["confirmation"]["maintenanceHook"] = f.activation.clone();
    f.prepare();
    let gate = f.hold();
    f.adopt();
    gate.entered();
    let running = f.read();
    assert_eq!(running["view"]["phase"], "running");
    assert_eq!(running["callbacksDrained"], false);
    drop(gate);
    let observed = f.wait("observed");
    assert_ne!(
        observed["view"]["outcome"]["runId"],
        failed["view"]["outcome"]["runId"]
    );
    let historical = call(
        &f.window,
        "read_source_maintenance_hook",
        f.body(json!({"sourceActionId":original_request["actionId"]})),
    )
    .unwrap();
    assert_eq!(historical["view"]["outcome"], failed["view"]["outcome"]);
    assert_eq!(historical["callbacksDrained"], true);
}

#[test]
fn source_maintenance_hook_shutdown_blocks_a_late_source_cause_before_claim() {
    let f = Fixture::new();
    f.prepare();
    let gate = f.hold();
    // The same close signal is set by SessionExecutor Drop. Keep the executor
    // alive here so its still-available control capacity cannot mask the guard.
    f.app
        .state::<AppState>()
        .sessions
        .with(|s| s.source_hooks.shutdown.close());
    let receipt = f.adopt();
    let sequence = f.sequence();
    let pending = f.read();
    assert_eq!(pending["view"]["phase"], "pending");
    assert!(pending["view"]["outcome"].is_null());
    assert_eq!(pending["callbacksDrained"], true);
    let source: ExecutionId = serde_json::from_value(f.request["actionId"].clone()).unwrap();
    f.app.state::<AppState>().sessions.with(move |s| {
        assert_eq!(
            s.active
                .as_ref()
                .unwrap()
                .store
                .next_source_maintenance_hook()
                .unwrap(),
            Some(source)
        );
        assert!(s.source_hooks.slot.as_ref().unwrap().live.strong_count() == 0);
    });
    assert_eq!(gate.reached.try_recv(), Err(mpsc::TryRecvError::Empty));
    assert_eq!(f.adopt(), receipt);
    assert_eq!(f.sequence(), sequence);
    assert_eq!(f.stop(&f.stop_request())["result"]["kind"], "stopped");
    assert_eq!(f.read()["view"]["phase"], "stopped");
}

#[test]
fn source_maintenance_hook_original_io_saturation_records_failed_notice_without_rolling_back_source()
 {
    let f = Fixture::new();
    f.prepare();
    let io = f.app.state::<AppState>().io.clone();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered, ready) = mpsc::sync_channel(4);
    let mut workers = Vec::new();
    for _ in 0..4 {
        let io = io.clone();
        let release = release.clone();
        let entered = entered.clone();
        workers.push(tauri::async_runtime::spawn(async move {
            io.run(CommandStage::ExecutionRead, move || {
                entered.send(()).unwrap();
                let (lock, ready) = &*release;
                let value = lock.lock().unwrap();
                let (value, _) = ready
                    .wait_timeout_while(value, Duration::from_secs(10), |v| !*v)
                    .unwrap();
                assert!(*value, "test did not release original IO slots");
                Ok(())
            })
            .await
        }));
    }
    for _ in 0..4 {
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    let receipt = f.adopt();
    let failed = f.wait("failed");
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    for worker in workers {
        tauri::async_runtime::block_on(worker).unwrap().unwrap();
    }
    assert_eq!(failed["view"]["outcome"]["error"]["code"], "busy");
    assert!(failed["view"]["outcome"]["assessment"].is_null());
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 1);
    assert_eq!(f.adopt(), receipt);
    let sequence = f.sequence();
    for _ in 0..3 {
        assert_eq!(f.read()["view"]["phase"], "failed");
    }
    assert_eq!(f.sequence(), sequence);
}

#[test]
fn source_maintenance_hook_change_clock_drains_without_events_or_execution_host() {
    let f = Fixture::new();
    let prepared = f.prepare();
    f.app.state::<AppState>().sessions.set_change_sink(None);
    let action: AdoptionAction = serde_json::from_value(prepared).unwrap();
    f.app.state::<AppState>().sessions.with(move |s| {
        let active = s.active.as_mut().unwrap();
        drop(active.execution.take());
        let receipt = active
            .store
            .adopt_execution(&action, &content::SourceAdoptionHandler)
            .unwrap();
        assert_eq!(receipt.changes.len(), 1);
    });
    f.wait("observed");
    f.app.state::<AppState>().sessions.with(|s| {
        assert!(
            s.active.as_ref().unwrap().execution.is_none(),
            "observer created an execution host"
        )
    });
    let mut wrong = f.body(json!({"sourceActionId":f.request["actionId"]}));
    wrong["projectId"] = json!(ExecutionId::new());
    assert!(call(&f.window, "read_source_maintenance_hook", wrong).is_err());
    let mut wrong = f.body(json!({"sourceActionId":f.request["actionId"]}));
    wrong["sessionToken"] = json!("other-session");
    assert!(call(&f.window, "read_source_maintenance_hook", wrong).is_err());
}

#[test]
fn source_maintenance_hook_quiesce_reports_original_live_completion_until_drained() {
    let f = Fixture::new();
    f.prepare();
    let gate = f.hold();
    f.adopt();
    gate.entered();
    let quiesced = call(&f.window, "quiesce_execution", f.context.clone()).unwrap();
    assert_eq!(quiesced["active"], true);
    assert_eq!(quiesced["quiescing"], true);
    assert_eq!(f.read()["view"]["phase"], "stopped");
    assert_eq!(f.read()["callbacksDrained"], false);
    let status = call(&f.window, "execution_status", f.context.clone()).unwrap();
    assert_eq!(status["active"], true);
    drop(gate);
    let stopped = f.wait("stopped");
    assert!(stopped["view"]["outcome"]["assessment"].is_null());
    let status = call(&f.window, "execution_status", f.context.clone()).unwrap();
    assert_eq!(status["active"], false);
}

#[test]
fn source_maintenance_hook_blocking_panic_records_failure_without_changing_source_receipt() {
    let f = Fixture::new();
    f.prepare();
    let mut gate = f.hold();
    let receipt = f.adopt();
    gate.entered();
    // Disconnect this test-owned compute observer. Its intentional panic occurs
    // only inside the existing blocking executor, whose accepted failure must
    // still finish the original opaque claim.
    drop(gate.release.take());
    let failed = f.wait("failed");
    assert_eq!(failed["view"]["outcome"]["error"]["code"], "storage-failed");
    assert_eq!(f.adopt(), receipt);
    assert!(failed["view"]["outcome"]["assessment"].is_null());
}

#[test]
fn source_maintenance_hook_executor_drop_cancels_accepted_io_and_releases_original_store() {
    let directory = tempfile::tempdir().unwrap();
    let locator = directory.path().join("project");
    let executor = dispatch::SessionExecutor::default();
    let destination = locator.to_string_lossy().into_owned();
    executor.with(move |s| {
        s.create(CreateProjectRequest {
            destination,
            display_name: "Synthetic drop".into(),
            source_locale: "en".into(),
            target_locales: vec!["zh-CN".into()],
        })
        .unwrap()
    });
    let (entered, reached) = mpsc::sync_channel(1);
    let (release, wait) = mpsc::sync_channel(1);
    let source_action = executor.with(move |s| {
        let active = s.active.as_mut().unwrap();
        let (attempt, result, mut confirmation) = source(&mut active.store);
        let descriptor = active.store.source_maintenance_hook_session().unwrap();
        let activation = SourceMaintenanceHookActivation {
            policy_version: descriptor.policy_version,
            session_epoch: descriptor.session_epoch,
            locale: "zh-CN".into(),
            after: 0,
            limit: 100,
            expires_at_ms: u64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap()
                + 300_000,
        };
        confirmation.maintenance_hook = Some(activation.clone());
        let input = active.store.execution_input(attempt).unwrap();
        let id = ExecutionId::new();
        let action = active
            .store
            .prepare_adoption_with_id(
                id,
                attempt,
                input.envelope().units[0].unit_id,
                vec![result],
                serde_json::to_value(confirmation).unwrap(),
            )
            .unwrap();
        s.source_hooks
            .prepared(active.token.clone(), id, activation);
        s.source_hooks.probe = Some(ComputeProbe {
            action: id,
            reached: entered,
            release: wait,
        });
        active
            .store
            .adopt_execution(&action, &content::SourceAdoptionHandler)
            .unwrap();
        id
    });
    reached.recv_timeout(Duration::from_secs(5)).unwrap();
    let shutdown = executor.with(|s| s.source_hooks.shutdown.clone());
    let callback = executor.callback();
    drop(executor);
    assert!(shutdown.closed.load(std::sync::atomic::Ordering::Acquire));
    assert!(
        shutdown
            .running
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_requested()
    );
    assert!(
        callback
            .submit("after-drop", CommandStage::ExecutionRead, |_| Ok(()))
            .is_err()
    );
    assert!(
        matches!(
            ProjectStore::open(&locator),
            Err(tsumugi_core::PersistenceError::ProjectInUse { .. })
        ),
        "accepted continuation did not retain the original store until drain"
    );
    release.send(()).unwrap();
    let until = Instant::now() + Duration::from_secs(8);
    let store = loop {
        match ProjectStore::open(&locator) {
            Ok(store) => break store,
            Err(tsumugi_core::PersistenceError::ProjectInUse { .. }) => {
                assert!(
                    Instant::now() < until,
                    "accepted observer did not release original store"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("reopen failed after observer drain: {error:?}"),
        }
    };
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let read = store
        .source_maintenance_hook(project, source_action)
        .unwrap();
    let view = read.view.unwrap();
    assert_eq!(view.phase, SourceMaintenanceHookPhase::Stopped);
    assert!(view.outcome.unwrap().assessment.is_none());
}

#[test]
fn source_maintenance_hook_disabled_source_and_strict_read_contract_remain_distinct() {
    let mut f = Fixture::new();
    f.request["confirmation"]["maintenanceHook"] = Value::Null;
    let action = f.prepare();
    assert!(action["parameters"]["maintenanceHook"].is_null());
    let known = f.read();
    assert_eq!(known["state"], "not-enabled");
    assert!(known["view"].is_null());
    let before = f.sequence();
    let source_before = f.source_scope();
    let receipt = f.adopt();
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["changes"][0]["kind"], "source-snapshot");
    let source_after = f.source_scope();
    assert_eq!(
        source_after.revision,
        source_before.revision.next().unwrap()
    );
    assert_eq!(
        receipt["changes"][0]["revision"],
        json!(source_after.revision)
    );
    let snapshot: ExecutionId =
        serde_json::from_value(receipt["changes"][0]["id"].clone()).unwrap();
    assert_eq!(source_after.current_snapshot, Some(snapshot));
    let read = f.read();
    assert_eq!(read["state"], "not-enabled");
    assert!(read["view"].is_null());
    assert_eq!(read["callbacksDrained"], true);
    assert_eq!(f.adopt(), receipt);
    assert_eq!(f.source_scope(), source_after);
    assert_eq!(f.sequence(), before);
    let parsed: SourceMaintenanceHookObservation = serde_json::from_value(read.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), read);
    for key in ["view", "error", "state"] {
        let mut omitted = read.clone();
        omitted.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<SourceMaintenanceHookObservation>(omitted).is_err());
    }
    let mut wrong = f.body(json!({"sourceActionId":f.request["actionId"]}));
    wrong["path"] = json!("not-a-selector");
    assert!(call(&f.window, "read_source_maintenance_hook", wrong).is_err());
    let mut stop = f.stop_request();
    stop["projectId"] = json!(ExecutionId::new());
    assert!(
        call(
            &f.window,
            "stop_source_maintenance_hook",
            f.body(json!({"stop":stop}))
        )
        .is_err()
    );
}

#[test]
fn source_maintenance_hook_old_action_ack_and_stop_do_not_replace_or_cancel_new_observer() {
    let mut f = Fixture::new();
    let old_action = f.prepare();
    let old_request = f.request.clone();
    let old_stop = f.stop_request();
    f.adopt();
    f.wait("observed");
    let (attempt, result, confirmation) = f
        .app
        .state::<AppState>()
        .sessions
        .with(|s| source(&mut s.active.as_mut().unwrap().store));
    f.request["actionId"] = json!(ExecutionId::new());
    f.request["attemptId"] = json!(attempt);
    f.request["resultId"] = json!(result);
    f.request["confirmation"] = serde_json::to_value(confirmation).unwrap();
    f.request["confirmation"]["maintenanceHook"] = f.activation.clone();
    f.prepare();
    let gate = f.hold();
    f.adopt();
    gate.entered();
    assert_eq!(
        call(&f.window, "prepare_source_adoption", old_request).unwrap(),
        old_action
    );
    let old = f.stop(&old_stop);
    assert_eq!(old["result"]["kind"], "stopped");
    assert_eq!(old["callbacksDrained"], true);
    let current = f.read();
    assert_eq!(current["view"]["phase"], "running");
    assert_eq!(current["callbacksDrained"], false);
    assert_eq!(current["sourceActionId"], f.request["actionId"]);
    drop(gate);
    assert!(f.wait("observed")["view"]["outcome"]["assessment"].is_object());
}
