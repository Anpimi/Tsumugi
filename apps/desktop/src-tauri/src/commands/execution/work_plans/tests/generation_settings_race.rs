//! A successful installed capture cannot carry an old settings epoch through
//! the later session finish, even if the package is enabled again meanwhile.
use super::*;
use crate::commands::execution::work_plans::generation::{CapturePhase, CaptureProbe};

struct ReleaseGate(Option<mpsc::Sender<()>>);
impl ReleaseGate {
    fn release(&mut self) {
        self.0.take().unwrap().send(()).unwrap();
    }
}
impl Drop for ReleaseGate {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}

fn arm_capture(
    fixture: &Fixture,
    phase: CapturePhase,
    attempt: ExecutionId,
) -> (mpsc::Receiver<UnsignedDecimal>, ReleaseGate) {
    let (reached, captured) = mpsc::channel();
    let (release, waiting) = mpsc::channel();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.work_plans.generation.arm_capture_probe(
                phase,
                attempt,
                CaptureProbe::new(reached, waiting),
            );
        });
    (captured, ReleaseGate(Some(release)))
}

fn attempt_state(fixture: &Fixture, attempt: ExecutionId) -> (bool, bool, bool) {
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.work_plans.generation.test_attempt_state(attempt)
        })
}

fn ipc_in_thread(
    fixture: &Fixture,
    command: &'static str,
    payload: Value,
) -> std::thread::JoinHandle<Result<Value, Value>> {
    let webview = fixture.webview.clone();
    let scoped = request(&fixture.context, payload);
    std::thread::spawn(move || call(&webview, command, scoped))
}

fn project_effect_counts(fixture: &Fixture) -> (i64, i64, i64, i64) {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count = |table| {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    };
    (
        count("execution_attempts"),
        count("plugin_execution_grants"),
        count("application_service_calls"),
        count("translation_selections"),
    )
}

fn capture_then_change_settings(phase: CapturePhase) {
    let fixture = Fixture::create();
    let (component, _installed, _runtime_approval) = install_generation(&fixture);
    let (mut config, provider) = local_provider_sequence_with_accept_timeout(
        vec!["original root candidate"],
        None,
        None,
        Duration::from_secs(30),
    );
    // Only the root HTTP response is needed: the original parent must still
    // have one authorized request available to detect an illicit child dispatch.
    config.max_requests = 2;
    let (plan, grant) = fixture.start_candidates(config);
    let original = fixture.wait_saved(&plan["attemptId"]);
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    assert_eq!(original["budget"]["dispatched"], 1);
    assert_eq!(original["budget"]["limit"], 2);
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let outer = ExecutionId::new();
    let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]});
    let preparing = json!({"scopeId":scope["scopeId"],"attemptId":outer,"component":component,"generation":generation});
    let preflight = if phase == CapturePhase::Start {
        Some(
            fixture
                .call("prepare_work_plan_generation_component", preparing.clone())
                .unwrap(),
        )
    } else {
        None
    };
    let starting = preflight.as_ref().map(|preflight| {
        json!({"scopeId":scope["scopeId"],"attemptId":outer,"inputDigest":preflight["inputDigest"],
            "grantId":ExecutionId::new(),"expiresAtMs":(SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()+60_000).to_string(),
            "unsandboxedExecution":true})
    });
    let (captured, mut gate) = arm_capture(&fixture, phase, outer);
    let pending = match &starting {
        Some(starting) => ipc_in_thread(
            &fixture,
            "start_work_plan_generation_component",
            starting.clone(),
        ),
        None => ipc_in_thread(
            &fixture,
            "prepare_work_plan_generation_component",
            preparing.clone(),
        ),
    };

    let revision = captured
        .recv_timeout(Duration::from_secs(10))
        .expect("the installed component must be captured before session finish");
    let plugins = fixture.app.state::<AppState>().plugins.clone();
    assert_eq!(revision, plugins.environment_settings_revision().unwrap());
    assert_eq!(
        attempt_state(&fixture, outer),
        (true, preflight.is_some(), false),
        "the exact attempt must remain pending while its captured result is held"
    );
    let original_epoch = plugins.with_environment_authority(revision, Ok).unwrap();
    assert!(!original_epoch.is_requested());
    let package = json!({"plugin":component["provider"]["plugin"],"packageDigest":component["provider"]["packageDigest"]});
    let disabled = call(
        &fixture.webview,
        "set_plugin_enabled",
        json!({"package":package,"enabled":false,"expectedRevision":revision,"actionId":ExecutionId::new()}),
    )
    .unwrap();
    assert_eq!(
        disabled["settingsRevision"],
        (revision.get() + 1).to_string()
    );
    assert!(original_epoch.is_requested());
    let enabled = call(
        &fixture.webview,
        "set_plugin_enabled",
        json!({"package":package,"enabled":true,"expectedRevision":disabled["settingsRevision"],"actionId":ExecutionId::new()}),
    )
    .unwrap();
    assert_eq!(
        enabled["settingsRevision"],
        (revision.get() + 2).to_string()
    );
    assert!(original_epoch.is_requested(), "the old epoch cannot revive");
    assert_eq!(
        attempt_state(&fixture, outer),
        (true, preflight.is_some(), false)
    );
    let before = fixture.bytes();
    let counts = project_effect_counts(&fixture);
    gate.release();
    let error = pending.join().unwrap().unwrap_err();
    assert_eq!(error["code"], "dependency-conflict", "{error}");
    assert_eq!(error["reason"], "plugin-settings-changed", "{error}");
    assert_eq!(
        attempt_state(&fixture, outer),
        (false, preflight.is_some(), false),
        "the original finish must clear its pending ticket without promotion"
    );
    assert_eq!(fixture.bytes(), before);
    assert_eq!(project_effect_counts(&fixture), counts);
    assert_eq!(
        fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]})
            )
            .unwrap(),
        original,
        "the saved candidate and original budget must be retained"
    );
    assert_eq!(
        fixture
            .call(
                "read_work_plan_action",
                json!({"actionId":grant["actionId"]})
            )
            .unwrap(),
        grant,
        "settings restoration cannot rewrite the original plan grant"
    );
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(
                host.runtime
                    .input_if_present(store, outer)
                    .unwrap()
                    .is_none()
            );
        });
    if let (Some(preflight), Some(starting)) = (preflight, starting) {
        assert_eq!(
            fixture
                .call("prepare_work_plan_generation_component", preparing)
                .unwrap(),
            preflight,
            "the original prepared acknowledgement is historical read-only data"
        );
        let retry = fixture
            .call("start_work_plan_generation_component", starting)
            .unwrap_err();
        assert_eq!(retry["code"], "result-mismatch", "{retry}");
        assert_eq!(retry["reason"], "generation-component-identity", "{retry}");
        assert_eq!(project_effect_counts(&fixture), counts);
        assert_eq!(fixture.bytes(), before);
    }
}

#[test]
fn prepared_capture_cannot_finish_after_settings_disable_and_restore() {
    capture_then_change_settings(CapturePhase::Prepare);
}

#[test]
fn starting_capture_cannot_authorize_after_settings_disable_and_restore() {
    capture_then_change_settings(CapturePhase::Start);
}
