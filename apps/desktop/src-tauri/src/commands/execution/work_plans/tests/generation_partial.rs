//! Multi-item candidates and uncertain model results through the installed process.
use super::*;

fn source_units(fixture: &Fixture) -> Vec<ExecutionId> {
    let snapshot = fixture.snapshot;
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .source_content(snapshot, 0, 100)
                .unwrap()
                .rows
                .into_iter()
                .map(|row| row.unit_id.unwrap())
                .collect()
        })
}

fn wait_rows(fixture: &Fixture, attempt: &Value, count: usize) -> Value {
    let id: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let recorded = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
                host.runtime.input_if_present(store, id).unwrap().is_some()
            });
        if recorded {
            let view = fixture
                .call("read_ai_translation", json!({"attemptId":attempt}))
                .unwrap();
            let rows = view["rows"].as_array().unwrap();
            assert_eq!(rows.len(), count, "{view}");
            if rows.iter().all(|row| {
                matches!(
                    row["automation"]["phase"].as_str(),
                    Some("saved" | "failed" | "cancelled")
                )
            }) {
                // Use the persistent ledger, not its non-executing projection.
                let terminal = fixture
                    .app
                    .state::<AppState>()
                    .sessions
                    .with(move |sessions| {
                        let store = &sessions.active.as_ref().unwrap().store;
                        store
                            .execution_attempt(id, true)
                            .unwrap()
                            .items
                            .iter()
                            .all(|item| {
                                !matches!(
                                    item.execution,
                                    ExecutionState::Queued | ExecutionState::Dispatched
                                )
                            })
                    });
                if terminal {
                    return view;
                }
            }
        }
        assert!(Instant::now() < deadline, "child did not finish: {attempt}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn row(view: &Value, unit: ExecutionId) -> &Value {
    view["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["item"]["unitId"] == json!(unit))
        .unwrap()
}

fn assert_budget(view: &Value, dispatched: u32, unknown: u32, tokens: u32) {
    let budget = &view["budget"];
    assert_eq!(budget["limit"], 5);
    assert_eq!(budget["dispatched"], dispatched);
    assert_eq!(budget["unresolved"], unknown);
    assert_eq!(budget["usageUnknown"], unknown);
    assert_eq!(budget["promptTokens"], tokens.to_string());
    assert_eq!(budget["completionTokens"], tokens.to_string());
}

fn wait_idle(fixture: &Fixture) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let idle = fixture.app.state::<AppState>().sessions.with(|sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.tick(store).unwrap();
            !host.active(store).unwrap()
        });
        if idle {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owned producers or queries did not stop"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn assert_saved_same(before: &Value, after: &Value, unit: ExecutionId) {
    for field in ["itemId", "resultId", "output", "savedRevisionId"] {
        assert_eq!(row(before, unit)[field], row(after, unit)[field], "{field}");
    }
}

#[test]
fn generation_component_two_items_preserves_partial_unknown_and_original_budget_on_reopen() {
    for partial in [false, true] {
        let mut fixture = Fixture::create_with_source(br#"{"first":"Hello","second":"Goodbye"}"#);
        let units = source_units(&fixture);
        assert_eq!(units.len(), 2);
        let uncertain = units[1];
        let successful = units[0];
        let requests: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let recorded = requests.clone();
        let (mut config, provider) = local_provider_responses_at_request(
            if partial { 5 } else { 4 },
            move |ordinal, item| {
                recorded.lock().unwrap().push(item.clone());
                if ordinal < 2 {
                    Some("original root candidate")
                } else if partial && ordinal < 4 && item["unitId"] == json!(uncertain) {
                    None
                } else if ordinal == 4 {
                    Some("explicit new candidate")
                } else {
                    Some("component child candidate")
                }
            },
            None,
            None,
            Duration::from_secs(30),
            Duration::from_secs(3),
        );
        config.max_requests = 5;
        assert_eq!(config.concurrency, 1);
        assert_eq!(config.max_retries, 0);
        let (component, _installed, _approval) = install_generation(&fixture);
        let (plan, grant) = fixture.start_candidates_in_units(config, &units);
        let root = wait_rows(&fixture, &plan["attemptId"], 2);
        for unit in &units {
            assert!(row(&root, *unit)["savedRevisionId"].is_string());
        }
        assert_budget(&root, 2, 0, 2);
        let action = start_component_for_units(&fixture, component.clone(), &grant, &units);
        assert_eq!(action.preflight["parentTask"], action.scope["parentTask"]);
        assert_eq!(action.preflight["scope"], plan["scope"]);
        let child = wait_rows(&fixture, &action.generation["attemptId"], 2);
        wait_idle(&fixture);
        assert_eq!(requests.lock().unwrap().len(), 4);
        for batch in requests.lock().unwrap()[..4].chunks_exact(2) {
            let actual: std::collections::BTreeSet<_> = batch
                .iter()
                .map(|item| serde_json::from_value::<ExecutionId>(item["unitId"].clone()).unwrap())
                .collect();
            assert_eq!(actual, units.iter().copied().collect());
        }
        assert_eq!(row(&child, successful)["automation"]["phase"], "saved");
        assert!(row(&child, successful)["savedRevisionId"].is_string());
        assert_eq!(
            row(&child, successful)["output"]["text"],
            "component child candidate"
        );
        assert_budget(&child, 4, u32::from(partial), if partial { 3 } else { 4 });
        let child_id: ExecutionId =
            serde_json::from_value(action.generation["attemptId"].clone()).unwrap();
        let original_count = fixture.attempt_count();
        let mut saved_children = vec![(
            action.generation["attemptId"].clone(),
            child.clone(),
            successful,
        )];

        if partial {
            let unknown = row(&child, uncertain);
            assert!(unknown["savedRevisionId"].is_null());
            assert!(unknown["output"].is_null());
            assert_eq!(unknown["automation"]["phase"], "failed");
            assert_eq!(unknown["automation"]["retryable"], false);
            let item: ExecutionId = serde_json::from_value(unknown["itemId"].clone()).unwrap();
            let recovery_unit = fixture
                .app
                .state::<AppState>()
                .sessions
                .with(move |sessions| {
                    let (host, store) =
                        sessions.active.as_mut().unwrap().execution_parts().unwrap();
                    let raw = store.execution_attempt(child_id, true).unwrap();
                    let status = raw
                        .items
                        .iter()
                        .find(|status| status.item_id == item)
                        .unwrap();
                    assert_eq!(status.execution, ExecutionState::Unknown);
                    assert_eq!(status.diagnostic.as_deref(), Some("ai-network-unknown"));
                    let recovery = store.execution_recovery(child_id, false).unwrap();
                    let unit = recovery
                        .units
                        .iter()
                        .find(|unit| unit.item_ids.contains(&item))
                        .unwrap();
                    assert_eq!(unit.actions, vec![RecoveryAction::QueryOutcome]);
                    assert_eq!(unit.remaining_item_ids, vec![item]);
                    assert_eq!(unit.blocked_reason.as_deref(), Some("outcome-unknown"));
                    assert!(store.execution_retry_input(child_id, &[item]).is_err());
                    assert!(host.runtime.has_unsettled_attempt(store, child_id).unwrap());
                    store
                        .check_work_plan_input(&store.execution_input(child_id).unwrap())
                        .unwrap();
                    unit.unit_id
                });
            assert!(
                fixture
                    .call(
                        "retry_work_plan_effect",
                        json!({"attemptId":child_id,"itemId":item})
                    )
                    .is_err()
            );
            for _ in 0..2 {
                assert_eq!(
                    fixture
                        .call(
                            "start_work_plan_generation_component",
                            action.starting.clone()
                        )
                        .unwrap(),
                    json!(action.outer)
                );
                let queried = fixture.call("recover_execution", json!({
                    "attemptId":child_id,"unitId":recovery_unit,"action":"query-outcome","itemIds":[item]
                })).unwrap();
                assert_eq!(queried["attemptId"], json!(child_id));
                assert_eq!(queried["queryStarted"], true);
                wait_idle(&fixture);
                let reread = fixture
                    .call("read_ai_translation", json!({"attemptId":child_id}))
                    .unwrap();
                assert_saved_same(&child, &reread, successful);
                assert_budget(&reread, 4, 1, 3);
                assert_eq!(requests.lock().unwrap().len(), 4);
                assert_eq!(fixture.attempt_count(), original_count);
            }
            // This is a separate, explicit human choice with fresh identities,
            // not a replay or automatic retry of the uncertain model request.
            let next = start_component_for_units(&fixture, component.clone(), &grant, &[uncertain]);
            assert_ne!(next.outer, action.outer);
            assert_ne!(next.starting["grantId"], action.starting["grantId"]);
            assert_ne!(next.generation["taskId"], action.generation["taskId"]);
            assert_ne!(next.generation["attemptId"], action.generation["attemptId"]);
            assert_eq!(next.preflight["parentTask"], action.preflight["parentTask"]);
            assert_eq!(next.preflight["generation"]["unitIds"], json!([uncertain]));
            let newer = wait_rows(&fixture, &next.generation["attemptId"], 1);
            assert_eq!(
                row(&newer, uncertain)["output"]["text"],
                "explicit new candidate"
            );
            assert!(row(&newer, uncertain)["savedRevisionId"].is_string());
            assert_budget(&newer, 5, 1, 4);
            saved_children.push((next.generation["attemptId"].clone(), newer, uncertain));
            wait_idle(&fixture);
            assert_eq!(requests.lock().unwrap().len(), 5);
            assert_eq!(requests.lock().unwrap()[4]["unitId"], json!(uncertain));

            // Remaining budget is enforced by the original HTTP reservation,
            // even though the read-only preparation can capture this scope.
            let exhausted = start_component_for_units(&fixture, component, &grant, &[uncertain]);
            let denied = wait_rows(&fixture, &exhausted.generation["attemptId"], 1);
            assert!(row(&denied, uncertain)["savedRevisionId"].is_null());
            assert!(row(&denied, uncertain)["output"].is_null());
            assert_eq!(
                denied["detail"]["items"][0]["status"]["execution"],
                "failed"
            );
            assert_eq!(
                denied["detail"]["items"][0]["status"]["diagnostic"],
                "ai-budget"
            );
            assert_budget(&denied, 5, 1, 4);
            wait_idle(&fixture);
            assert_eq!(requests.lock().unwrap().len(), 5);
        } else {
            assert!(row(&child, uncertain)["savedRevisionId"].is_string());
            assert_eq!(row(&child, uncertain)["automation"]["phase"], "saved");
            saved_children.push((
                action.generation["attemptId"].clone(),
                child.clone(),
                uncertain,
            ));
        }
        provider.join().unwrap();
        let final_count = fixture.attempt_count();
        let final_requests = requests.lock().unwrap().len();
        let before_close = fixture
            .call("read_ai_translation", json!({"attemptId":child_id}))
            .unwrap();
        assert_saved_same(&child, &before_close, successful);
        for unit in &units {
            let historical = fixture
                .call(
                    "read_ai_translation",
                    json!({"attemptId":plan["attemptId"]}),
                )
                .unwrap();
            assert_saved_same(&root, &historical, *unit);
        }
        fixture.reopen();
        for (attempt, before, unit) in saved_children {
            let after = fixture
                .call("read_ai_translation", json!({"attemptId":attempt}))
                .unwrap();
            assert_saved_same(&before, &after, unit);
            assert_budget(&after, if partial { 5 } else { 4 }, u32::from(partial), 4);
        }
        let reopened = fixture
            .call("read_ai_translation", json!({"attemptId":child_id}))
            .unwrap();
        if partial {
            assert!(row(&reopened, uncertain)["savedRevisionId"].is_null());
            assert!(row(&reopened, uncertain)["output"].is_null());
            let item = &row(&reopened, uncertain)["itemId"];
            let raw = reopened["detail"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["status"]["itemId"] == *item)
                .unwrap();
            assert_eq!(raw["status"]["execution"], "unknown");
            let recovery = reopened["detail"]["recovery"]["units"]
                .as_array()
                .unwrap()
                .iter()
                .find(|unit| unit["itemIds"].as_array().unwrap().contains(item))
                .unwrap();
            assert_eq!(recovery["actions"], json!(["query-outcome"]));
        }
        assert!(
            fixture
                .call(
                    "open_work_plan_agent_scope",
                    json!({"lease":grant["lease"]})
                )
                .is_err()
        );
        assert!(
            fixture
                .call("start_work_plan_generation_component", action.starting)
                .is_err()
        );
        wait_idle(&fixture);
        if partial {
            let unknown_item: ExecutionId =
                serde_json::from_value(row(&reopened, uncertain)["itemId"].clone()).unwrap();
            fixture
                .app
                .state::<AppState>()
                .sessions
                .with(move |sessions| {
                    let store = &sessions.active.as_ref().unwrap().store;
                    let persisted = store.execution_attempt(child_id, true).unwrap();
                    let status = persisted
                        .items
                        .iter()
                        .find(|status| status.item_id == unknown_item)
                        .unwrap();
                    assert_eq!(status.execution, ExecutionState::Unknown);
                    assert_eq!(status.diagnostic.as_deref(), Some("ai-network-unknown"));
                });
        }
        assert_eq!(requests.lock().unwrap().len(), final_requests);
        assert_eq!(fixture.attempt_count(), final_count);
        let connection = rusqlite::Connection::open_with_flags(
            fixture.directory.path().join("project/project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        for (table, expected) in [
            ("translation_revisions", 4),
            ("translation_selections", 0),
            ("application_service_calls", if partial { 3 } else { 1 }),
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
        let association: (String, String) = connection.query_row(
            "SELECT outer_attempt, child_attempt FROM application_service_calls WHERE outer_attempt=?1",
            [action.outer.to_string()], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(
            association,
            (action.outer.to_string(), child_id.to_string())
        );
    }
}
