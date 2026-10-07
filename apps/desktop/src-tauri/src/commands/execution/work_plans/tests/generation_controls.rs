//! Original controls and installed settings after the actual component closes.
use super::*;

fn start_component(fixture: &Fixture, component: Value, grant: &Value) -> ComponentAction {
    start_component_for_units(fixture, component, grant, &[fixture.unit])
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

#[test]
fn generation_component_prepared_before_settings_withdrawal_needs_a_new_human_action() {
    for disable_package in [true, false] {
        let mut fixture = Fixture::create();
        let (component, _installed, runtime_approval) = install_generation(&fixture);
        let (config, provider) = local_provider_sequence_at_request(
            vec!["original root candidate", "explicit restored child"],
            None,
            None,
            Duration::from_secs(90),
            Duration::from_secs(1),
        );
        let (plan, grant) = fixture.start_candidates(config);
        let root = fixture.wait_saved(&plan["attemptId"]);
        let scope = fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]}),
            )
            .unwrap();
        let outer = ExecutionId::new();
        let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]});
        let preparing = json!({"scopeId":scope["scopeId"],"attemptId":outer,"component":component,"generation":generation});
        let preflight = fixture
            .call("prepare_work_plan_generation_component", preparing.clone())
            .unwrap();
        let starting = json!({"scopeId":scope["scopeId"],"attemptId":outer,"inputDigest":preflight["inputDigest"],
            "grantId":ExecutionId::new(),"expiresAtMs":(SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()+60_000).to_string(),"unsandboxedExecution":true});
        let plugins = fixture.app.state::<AppState>().plugins.clone();
        let revision = plugins.environment_settings_revision().unwrap();
        assert_eq!(preflight["component"]["settingsRevision"], json!(revision));
        let original_epoch = plugins.with_environment_authority(revision, Ok).unwrap();
        assert!(!original_epoch.is_requested());
        let package = json!({"plugin":component["provider"]["plugin"],"packageDigest":component["provider"]["packageDigest"]});
        if disable_package {
            call(
                &fixture.webview,
                "set_plugin_enabled",
                json!({"package":package,"enabled":false,
                "expectedRevision":revision,"actionId":ExecutionId::new()}),
            )
            .unwrap();
        } else {
            // Native runtime approval IPC does not edit a captured Node identity.
            // This test uses the same Store CAS and original revocation boundary.
            plugins.replace_test_runtime_approvals(vec![]);
        }
        assert!(original_epoch.is_requested());
        let withdrawn_revision = plugins.environment_settings_revision().unwrap();
        assert_eq!(withdrawn_revision.get(), revision.get() + 1);
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        let before_root = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]}),
            )
            .unwrap();
        assert_eq!(before_root["budget"]["dispatched"], 1);
        assert_eq!(
            fixture
                .call("prepare_work_plan_generation_component", preparing.clone())
                .unwrap(),
            preflight
        );
        assert!(
            fixture
                .call("start_work_plan_generation_component", starting.clone())
                .is_err()
        );
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(
            fixture
                .call(
                    "read_ai_translation",
                    json!({"attemptId":plan["attemptId"]})
                )
                .unwrap(),
            before_root
        );
        assert!(
            !fixture
                .directory
                .path()
                .join("component-observer.txt")
                .exists()
        );
        if disable_package {
            call(
                &fixture.webview,
                "set_plugin_enabled",
                json!({"package":package,"enabled":true,
                "expectedRevision":withdrawn_revision,"actionId":ExecutionId::new()}),
            )
            .unwrap();
        } else {
            plugins.replace_test_runtime_approvals(vec![runtime_approval]);
        }
        let restored_revision = plugins.environment_settings_revision().unwrap();
        assert_eq!(restored_revision.get(), revision.get() + 2);
        assert!(
            original_epoch.is_requested(),
            "restoration cannot revive the old epoch"
        );
        let restored_epoch = plugins
            .with_environment_authority(restored_revision, Ok)
            .unwrap();
        assert!(!restored_epoch.is_requested());
        let before = fixture.bytes();
        assert_eq!(
            fixture
                .call("prepare_work_plan_generation_component", preparing.clone())
                .unwrap(),
            preflight
        );
        let error = fixture
            .call("start_work_plan_generation_component", starting.clone())
            .unwrap_err();
        assert_eq!(error["code"], "result-mismatch");
        assert_eq!(error["reason"], "generation-component-identity");
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(
            fixture
                .call(
                    "read_ai_translation",
                    json!({"attemptId":plan["attemptId"]})
                )
                .unwrap(),
            before_root
        );
        let original_attempt = outer;
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                assert!(
                    host.runtime
                        .input_if_present(store, original_attempt)
                        .unwrap()
                        .is_none()
                );
            });
        assert_eq!(
            fixture
                .call(
                    "discard_work_plan_generation_component",
                    json!({"attemptId":outer}),
                )
                .unwrap(),
            true
        );
        // A separate explicit action captures the restored revision and requests
        // an ordinary component grant. The original parent budget is unchanged.
        let fresh = start_component(&fixture, component, &grant);
        assert_ne!(fresh.outer, outer);
        assert_ne!(fresh.generation["attemptId"], generation["attemptId"]);
        assert_ne!(fresh.generation["taskId"], generation["taskId"]);
        assert_ne!(fresh.starting["grantId"], starting["grantId"]);
        assert_eq!(
            fresh.preflight["component"]["settingsRevision"],
            json!(restored_revision)
        );
        assert_eq!(fresh.preflight["parentTask"], preflight["parentTask"]);
        // The enqueue acknowledgement precedes actual process activation and
        // child creation. The non-null AI detail API is read only afterwards.
        let child_id: ExecutionId =
            serde_json::from_value(fresh.generation["attemptId"].clone()).unwrap();
        let fresh_outer = fresh.outer;
        let enqueue_deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let enqueued = fixture
                .app
                .state::<AppState>()
                .sessions
                .with(move |sessions| {
                    let (host, store) =
                        sessions.active.as_mut().unwrap().execution_parts().unwrap();
                    host.tick(store).unwrap();
                    if host
                        .runtime
                        .input_if_present(store, child_id)
                        .unwrap()
                        .is_some()
                    {
                        return true;
                    }
                    let outer = store.execution_attempt(fresh_outer, true).unwrap();
                    assert!(
                        !outer.items.iter().any(|item| matches!(
                            item.execution,
                            ExecutionState::Failed
                                | ExecutionState::CancelledBeforeDispatch
                                | ExecutionState::Unknown
                        )),
                        "component ended without its child: {outer:?}"
                    );
                    false
                });
            if enqueued {
                break;
            }
            assert!(
                Instant::now() < enqueue_deadline,
                "actual component did not enqueue child"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let child = fixture.wait_saved(&fresh.generation["attemptId"]);
        assert_eq!(
            child["rows"][0]["output"]["text"],
            "explicit restored child"
        );
        assert_eq!(child["budget"]["dispatched"], 2);
        assert_eq!(child["budget"]["limit"], 2);
        wait_outer_closed(&fixture, &fresh);
        assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
        let connection = rusqlite::Connection::open_with_flags(
            fixture.directory.path().join("project/project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let original_grants: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM plugin_execution_grants WHERE attempt_id=?1 OR grant_id=?2",
                [
                    outer.to_string(),
                    starting["grantId"].as_str().unwrap().to_owned(),
                ],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original_grants, 0);
        let association: (String, String) = connection
            .query_row(
                "SELECT outer_attempt, child_attempt FROM application_service_calls",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            association,
            (
                fresh.outer.to_string(),
                fresh.generation["attemptId"].as_str().unwrap().into()
            )
        );
        drop(connection);
        let historical_root = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]}),
            )
            .unwrap();
        assert_eq!(
            historical_root["rows"][0]["savedRevisionId"],
            root["rows"][0]["savedRevisionId"]
        );
        fixture.reopen();
        assert_eq!(
            fixture
                .call(
                    "read_ai_translation",
                    json!({"attemptId":fresh.generation["attemptId"]})
                )
                .unwrap()["rows"][0]["savedRevisionId"],
            child["rows"][0]["savedRevisionId"]
        );
        assert!(
            fixture
                .call("start_work_plan_generation_component", starting)
                .is_err()
        );
        assert!(
            fixture
                .call("start_work_plan_generation_component", fresh.starting)
                .is_err()
        );
        assert_eq!(
            fixture
                .call(
                    "read_ai_translation",
                    json!({"attemptId":fresh.generation["attemptId"]})
                )
                .unwrap()["budget"],
            child["budget"]
        );
    }
}
