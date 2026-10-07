//! Original controls and installed settings after the actual component closes.
use super::*;

struct ComponentAction {
    scope: Value,
    preparing: Value,
    generation: Value,
    outer: ExecutionId,
}

fn start_component(fixture: &Fixture, component: Value, grant: &Value) -> ComponentAction {
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]});
    let outer = ExecutionId::new();
    let preparing = json!({"scopeId":scope["scopeId"],"attemptId":outer,"component":component,"generation":generation});
    let prepared = fixture
        .call("prepare_work_plan_generation_component", preparing.clone())
        .unwrap();
    let starting = json!({"scopeId":scope["scopeId"],"attemptId":outer,"inputDigest":prepared["inputDigest"],"grantId":ExecutionId::new(),
        "expiresAtMs":(SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()+60_000).to_string(),"unsandboxedExecution":true});
    assert_eq!(
        fixture
            .call("start_work_plan_generation_component", starting)
            .unwrap(),
        json!(outer)
    );
    ComponentAction {
        scope,
        preparing,
        generation,
        outer,
    }
}

fn wait_outer_closed(fixture: &Fixture, action: &ComponentAction) {
    let outer = action.outer;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (settled, detail) = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
                let detail = store.execution_attempt(outer, true).unwrap();
                (
                    !host.runtime.has_unsettled_attempt(store, outer).unwrap(),
                    detail,
                )
            });
        assert!(
            !detail.items.iter().any(|item| matches!(
                item.execution,
                ExecutionState::Failed
                    | ExecutionState::CancelledBeforeDispatch
                    | ExecutionState::Unknown
            )),
            "{detail:?}"
        );
        if settled {
            assert!(
                detail
                    .items
                    .iter()
                    .all(|item| item.execution == ExecutionState::Succeeded)
            );
            assert_eq!(
                std::fs::read_to_string(fixture.directory.path().join("component-observer.txt"))
                    .unwrap(),
                "disposed"
            );
            return;
        }
        assert!(
            Instant::now() < deadline,
            "component did not close: {detail:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_child_failed(fixture: &Fixture, action: &ComponentAction) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let view = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":action.generation["attemptId"]}),
            )
            .unwrap();
        if matches!(
            view["rows"][0]["automation"]["phase"].as_str(),
            Some("failed" | "cancelled")
        ) {
            return view;
        }
        assert!(
            Instant::now() < deadline,
            "revoked child did not stop: {view}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn assert_preserved(
    fixture: &Fixture,
    plan: &Value,
    root: &Value,
    action: &ComponentAction,
    child: &Value,
) {
    assert!(child["rows"][0]["savedRevisionId"].is_null(), "{child}");
    assert!(
        child["rows"][0]["automation"]["receipt"].is_null(),
        "{child}"
    );
    assert_eq!(child["rows"][0]["automation"]["retryable"], false);
    assert_eq!(
        child["budget"]["dispatched"], 2,
        "cancelled dispatch is not refunded"
    );
    let historical = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        historical["rows"][0]["savedRevisionId"],
        root["rows"][0]["savedRevisionId"]
    );
    assert_eq!(historical["budget"]["dispatched"], 2);
    assert!(fixture.call("retry_work_plan_effect", json!({"attemptId":action.generation["attemptId"],"itemId":child["rows"][0]["itemId"]})).is_err());
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    for (table, expected) in [
        ("translation_revisions", 1),
        ("translation_selections", 0),
        ("application_service_calls", 1),
    ] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            expected,
            "{table}"
        );
    }
    let original: (String, String) = connection
        .query_row(
            "SELECT outer_attempt, child_attempt FROM application_service_calls",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        original,
        (
            action.outer.to_string(),
            action.generation["attemptId"].as_str().unwrap().into()
        )
    );
}

#[test]
fn generation_component_closed_channel_child_obeys_pause_stop_and_takeover() {
    for (command, state) in [
        ("pause", "paused"),
        ("stop", "stopped"),
        ("take-over", "taken-over"),
    ] {
        let fixture = Fixture::create();
        let (component, _installed, _approval) = install_generation(&fixture);
        let (started, waiting) = mpsc::channel();
        let (release, hold) = mpsc::channel();
        let (mut config, provider) = local_provider_sequence_at_request(
            vec!["original saved candidate", "late child response"],
            Some((1, (started, hold))),
            None,
            Duration::from_secs(30),
            Duration::from_secs(10),
        );
        config.timeout_seconds = 10;
        let (plan, grant) = fixture.start_candidates(config);
        let root = fixture.wait_saved(&plan["attemptId"]);
        let action = start_component(&fixture, component, &grant);
        waiting.recv_timeout(Duration::from_secs(15)).unwrap();
        wait_outer_closed(&fixture, &action);
        let controlled = fixture.call("control_work_plan", json!({"actionId":ExecutionId::new(),"planId":plan["planId"],
            "expectedGeneration":grant["lease"]["generation"],"command":command,"confirmed":false,"checkerExecutions":[],"toolExecution":false,"expiresAt":null})).unwrap();
        assert_eq!(controlled["state"], state);
        assert_eq!(controlled["lease"]["generation"], "2");
        release.send(()).unwrap();
        assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
        let child = wait_child_failed(&fixture, &action);
        assert_preserved(&fixture, &plan, &root, &action, &child);
        assert!(
            fixture
                .call(
                    "open_work_plan_agent_scope",
                    json!({"lease":grant["lease"]})
                )
                .is_err()
        );
        let mut stale = action.preparing;
        stale["attemptId"] = json!(ExecutionId::new());
        stale["generation"]["taskId"] = json!(ExecutionId::new());
        stale["generation"]["attemptId"] = json!(ExecutionId::new());
        assert_eq!(stale["scopeId"], action.scope["scopeId"]);
        assert!(
            fixture
                .call("prepare_work_plan_generation_component", stale)
                .is_err()
        );
    }
}

#[test]
fn generation_component_closed_channel_child_obeys_real_disable_and_cannot_revive() {
    let fixture = Fixture::create();
    let (component, _installed, _approval) = install_generation(&fixture);
    let (started, waiting) = mpsc::channel();
    let (release, hold) = mpsc::channel();
    let (mut config, provider) = local_provider_sequence_at_request(
        vec!["original saved candidate", "late child response"],
        Some((1, (started, hold))),
        None,
        Duration::from_secs(30),
        Duration::from_secs(10),
    );
    config.timeout_seconds = 10;
    let (plan, grant) = fixture.start_candidates(config);
    let root = fixture.wait_saved(&plan["attemptId"]);
    let action = start_component(&fixture, component.clone(), &grant);
    waiting.recv_timeout(Duration::from_secs(15)).unwrap();
    wait_outer_closed(&fixture, &action);
    let plugins = fixture.app.state::<AppState>().plugins.clone();
    let revision = plugins.environment_settings_revision().unwrap();
    let package = json!({"plugin":component["provider"]["plugin"],"packageDigest":component["provider"]["packageDigest"]});
    let disabled = call(
        &fixture.webview,
        "set_plugin_enabled",
        json!({"package":package,"enabled":false,
        "expectedRevision":revision,"actionId":ExecutionId::new()}),
    )
    .unwrap();
    assert_eq!(
        disabled["settingsRevision"],
        (revision.get() + 1).to_string()
    );
    release.send(()).unwrap();
    provider.join().unwrap();
    let child = wait_child_failed(&fixture, &action);
    // The installation signal reaches Core's retained service-origin guard
    // before the Desktop checker/settings guard. That boundary reports its
    // existing Unauthorized/plugin-authority contract.
    assert_eq!(
        child["rows"][0]["automation"]["error"]["code"],
        "permission-denied"
    );
    assert_eq!(
        child["rows"][0]["automation"]["error"]["reason"],
        "plugin-authority"
    );
    assert_preserved(&fixture, &plan, &root, &action, &child);
    call(
        &fixture.webview,
        "set_plugin_enabled",
        json!({"package":package,"enabled":true,
        "expectedRevision":disabled["settingsRevision"],"actionId":ExecutionId::new()}),
    )
    .unwrap();
    let after = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":action.generation["attemptId"]}),
        )
        .unwrap();
    let mut before_effect = child["rows"][0]["automation"].clone();
    let mut after_effect = after["rows"][0]["automation"].clone();
    // map_execution reports each failed authority check with a fresh diagnostic
    // identity. The effect, permission category, original action and outcome
    // must remain identical; a log correlation ID is not execution authority.
    for effect in [&mut before_effect, &mut after_effect] {
        assert!(ExecutionId::parse(effect["error"]["diagnosticId"].as_str().unwrap()).is_ok());
        effect["error"]
            .as_object_mut()
            .unwrap()
            .remove("diagnosticId");
    }
    assert_eq!(after_effect, before_effect);
    assert_preserved(&fixture, &plan, &root, &action, &after);
    assert_eq!(
        fixture
            .call(
                "read_work_plan_action",
                json!({"actionId":grant["actionId"]})
            )
            .unwrap(),
        grant
    );
}
