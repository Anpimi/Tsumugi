//! Registered admission and ledger reads use synthetic data; no model is run.
use super::*;

fn complete_generation(store: &mut ProjectStore, input: &FixedInput) -> Vec<Value> {
    input
        .envelope()
        .items
        .iter()
        .map(|item| {
            let envelope = input.envelope();
            let dispatch = store
                .dispatch_execution_item(envelope.attempt_id, item.item_id)
                .unwrap();
            let payload = tsumugi_core::ai::item_payload(input, item.item_id).unwrap();
            let result = FixedResult::capture(
                ResultEnvelope {
                    project_id: envelope.project_id,
                    attempt_id: envelope.attempt_id,
                    item_id: item.item_id,
                    result_id: ExecutionId::new(),
                    supersedes: None,
                    dispatch_token: dispatch.dispatch_token,
                    capability_id: envelope.capability_id.clone(),
                    capability_version: envelope.capability_version.clone(),
                    plugin: None,
                    outcome: ExecutionState::Succeeded,
                    output: Some(json!({
                        "unitId":payload.unit_id,"targetLocale":payload.target_locale,
                        "text":"Synthetic candidate","usage":null,"requests":1,"usageIncomplete":false
                    })),
                    diagnostic: None,
                },
                input,
                dispatch.dispatch_token,
            )
            .unwrap();
            store.save_execution_result(&result).unwrap();
            serde_json::to_value(result.envelope()).unwrap()
        })
        .collect()
}

fn opened(f: &Fixture) -> Value {
    let lease = f.app.state::<AppState>().sessions.with(|sessions| {
        let active = sessions.active.as_mut().unwrap();
        let store = &mut active.store;
        let units = store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                100,
            )
            .unwrap()
            .rows
            .into_iter()
            .map(|row| row.unit_id.unwrap())
            .collect::<Vec<_>>();
        let plan = store
            .prepare_work_plan(
                Some(AiConfig {
                    endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                    model: "synthetic".into(),
                    ..AiConfig::default()
                }),
                "zh-CN",
                &units,
                PlanOptions::default(),
            )
            .unwrap();
        let receipt = store
            .authorize_work_plan(
                &plan,
                &AuthorizeWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_digest: plan.digest.clone(),
                    confirmed: true,
                    effects: plan.authorization_effects().unwrap(),
                    expires_at: SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap()
                        .as_secs()
                        + 600,
                },
            )
            .unwrap();
        let input = FixedInput::capture(receipt.input.unwrap()).unwrap();
        store.enqueue_execution(&input).unwrap();
        // Complete this synthetic root before the session clock can dispatch it.
        // Completing the root does not terminate its original active lease.
        complete_generation(store, &input);
        let root = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        assert_eq!(root.progress.succeeded, root.progress.total);
        assert_eq!(
            store.work_plan_status(receipt.lease.plan_id).unwrap().state,
            WorkPlanState::Active
        );
        receipt.lease
    });
    f.call("open_work_plan_agent_scope", json!({"lease":lease}))
        .unwrap()
}
fn proposal(root: &Value, units: Value) -> Value {
    json!({"scopeId":root["scopeId"],"delegation":{"delegationId":ExecutionId::new(),"unitIds":units,"toolHandles":[]}})
}
fn generation(child: &Value) -> Value {
    json!({"scopeId":child["scopeId"],"generation":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),
        "unitIds":child["delegation"]["unitIds"]}})
}
fn page(reading: &Value) -> Value {
    let mut value = reading.clone();
    value["offset"] = json!(0);
    value["limit"] = json!(1);
    value
}

#[test]
fn agent_subset_registered_creation_is_exact_idempotent_leaf_and_bounded() {
    let f = Fixture::create_with_source(br#"{"first":"Hello","second":"World"}"#);
    let root = opened(&f);
    let request = proposal(&root, json!([f.unit]));
    let before = f.bytes();
    let attempts = f.attempt_count();
    let child = f
        .call("delegate_work_plan_agent_scope", request.clone())
        .unwrap();
    assert_ne!(child["scopeId"], root["scopeId"]);
    assert_eq!(child["delegation"]["parentScopeId"], root["scopeId"]);
    assert_eq!(child["parentTask"], root["parentTask"]);
    assert_eq!(child["lease"], root["lease"]);
    assert_eq!(child["budget"], root["budget"]);
    assert_eq!(
        f.call("delegate_work_plan_agent_scope", request.clone())
            .unwrap(),
        child
    );
    assert_eq!(
        f.call("open_work_plan_agent_scope", json!({"lease":root["lease"]}))
            .unwrap(),
        root
    );
    assert!(
        f.call(
            "delegate_work_plan_agent_scope",
            proposal(&child, json!([f.unit]))
        )
        .is_err()
    );
    let mut changed = request.clone();
    changed["delegation"]["toolHandles"] = json!([ExecutionId::new()]);
    assert!(f.call("delegate_work_plan_agent_scope", changed).is_err());
    let other = root["scope"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["unitId"] != json!(f.unit))
        .unwrap()["unitId"]
        .clone();
    let mut changed = request.clone();
    changed["delegation"]["unitIds"] = json!([other]);
    assert_eq!(
        f.call("delegate_work_plan_agent_scope", changed)
            .unwrap_err()["code"],
        "result-mismatch"
    );
    for field in ["projectId", "sessionToken"] {
        let mut bad = request.clone();
        bad[field] = json!(ExecutionId::new());
        assert!(f.call("delegate_work_plan_agent_scope", bad).is_err());
    }
    // The original registry's 128 entries include the root and every child.
    for _ in 0..126 {
        f.call(
            "delegate_work_plan_agent_scope",
            proposal(&root, json!([f.unit])),
        )
        .unwrap();
    }
    assert_eq!(
        f.call(
            "delegate_work_plan_agent_scope",
            proposal(&root, json!([f.unit]))
        )
        .unwrap_err()["code"],
        "limit-exceeded"
    );
    assert_eq!(
        f.call("delegate_work_plan_agent_scope", request).unwrap(),
        child
    );
    assert_eq!(f.bytes(), before);
    assert_eq!(f.attempt_count(), attempts);
}

#[test]
fn agent_subset_registered_generation_results_require_the_original_child() {
    let f = Fixture::create_with_source(br#"{"first":"Hello","second":"World"}"#);
    let root = opened(&f);
    let ids = root["scope"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["unitId"].clone())
        .collect::<Vec<_>>();
    let child = f
        .call(
            "delegate_work_plan_agent_scope",
            proposal(&root, json!(ids)),
        )
        .unwrap();
    let sibling = f
        .call(
            "delegate_work_plan_agent_scope",
            proposal(&root, json!([f.unit])),
        )
        .unwrap();
    let mut reading = generation(&child);
    let prepared = f
        .call("prepare_work_plan_agent_generation", reading.clone())
        .unwrap();
    reading["inputDigest"] = prepared["inputDigest"].clone();
    assert_eq!(
        f.call("read_work_plan_agent_generation_attempt", page(&reading))
            .unwrap_err()["reason"],
        "work-plan-agent-not-enqueued"
    );
    let observed = reading.clone();
    let (queued, result) = f.app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let scope_id: ExecutionId = serde_json::from_value(observed["scopeId"].clone()).unwrap();
        let scope = host.work_plans.agent_scopes[&scope_id].clone();
        let request: tsumugi_core::application::AgentGenerationRequest =
            serde_json::from_value(observed["generation"].clone()).unwrap();
        let prepared = store
            .prepare_work_plan_agent_generation(&scope, &request)
            .unwrap();
        assert_eq!(prepared.digest(), observed["inputDigest"].as_str().unwrap());
        // Seed durable evidence through the sealed admission in one owner turn,
        // as in the tool-read fixture. No background Provider can win dispatch
        // or leave another queued item writing during the read-only assertions.
        host.runtime
            .submit_work_plan_agent_generation(store, &prepared)
            .unwrap();
        let queued = store
            .read_work_plan_agent_generation_attempt(
                &scope,
                &request,
                prepared.digest(),
                false,
                0,
                1,
            )
            .unwrap();
        let results = complete_generation(store, prepared.input());
        (serde_json::to_value(queued).unwrap(), results[0].clone())
    });
    assert_eq!(queued["progress"]["total"], 2);
    assert_eq!(queued["progress"]["queued"], 2);
    assert_eq!(queued["nextOffset"], 1);
    let completed = f
        .call("read_work_plan_agent_generation_attempt", page(&reading))
        .unwrap();
    assert_eq!(completed["progress"]["total"], 2);
    assert_eq!(completed["progress"]["succeeded"], 2);
    assert_eq!(completed["items"][0]["resultId"], result["resultId"]);
    assert_eq!(completed["nextOffset"], 1);
    let before = f.bytes();
    let attempts = f.attempt_count();
    let mut output = reading.clone();
    output["itemId"] = result["itemId"].clone();
    output["resultId"] = result["resultId"].clone();
    assert_eq!(
        f.call("read_work_plan_agent_generation_output", output.clone())
            .unwrap(),
        result
    );
    for wrong in [&root, &sibling] {
        let mut bad = output.clone();
        bad["scopeId"] = wrong["scopeId"].clone();
        assert!(
            f.call("read_work_plan_agent_generation_output", bad)
                .is_err()
        );
    }
    for field in ["itemId", "resultId", "projectId", "sessionToken"] {
        let mut bad = output.clone();
        bad[field] = json!(ExecutionId::new());
        assert!(
            f.call("read_work_plan_agent_generation_output", bad)
                .is_err()
        );
    }
    let mut second = page(&reading);
    second["offset"] = json!(1);
    assert_eq!(
        f.call("read_work_plan_agent_generation_attempt", second)
            .unwrap()["nextOffset"],
        Value::Null
    );
    assert_eq!(f.bytes(), before);
    assert_eq!(f.attempt_count(), attempts);
    let plan = child["lease"]["planId"].clone();
    f.call("control_work_plan", json!({"actionId":ExecutionId::new(),"planId":plan,
        "expectedGeneration":child["lease"]["generation"],"command":"stop","confirmed":false,"expiresAt":null,
        "checkerExecutions":[],"toolExecution":false})).unwrap();
    assert!(
        f.call("read_work_plan_agent_generation_attempt", page(&reading))
            .is_err()
    );
    assert!(
        f.call("read_work_plan_agent_generation_output", output)
            .is_err()
    );
}

#[test]
fn agent_subset_registered_missing_host_and_accepted_close_cannot_create_read_authority() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let empty = ProjectFixture::create("en-US");
    let empty_before =
        std::fs::read(empty.directory.path().join("project/project.sqlite3")).unwrap();
    let unknown = json!({"scopeId":ExecutionId::new(),"generation":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[ExecutionId::new()]},
        "inputDigest":"a".repeat(64),"offset":0,"limit":1});
    assert!(
        call(
            &empty.webview,
            "read_work_plan_agent_generation_attempt",
            request(&empty.context, unknown.clone())
        )
        .is_err()
    );
    let mut output = unknown;
    output.as_object_mut().unwrap().remove("offset");
    output.as_object_mut().unwrap().remove("limit");
    output["itemId"] = json!(ExecutionId::new());
    output["resultId"] = json!(ExecutionId::new());
    assert!(
        call(
            &empty.webview,
            "read_work_plan_agent_generation_output",
            request(&empty.context, output)
        )
        .is_err()
    );
    assert!(call(&empty.webview, "delegate_work_plan_agent_scope", request(&empty.context, json!({"scopeId":ExecutionId::new(),
        "delegation":{"delegationId":ExecutionId::new(),"unitIds":[ExecutionId::new()],"toolHandles":[]}}))).is_err());
    empty
        .app
        .state::<AppState>()
        .sessions
        .with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    assert_eq!(
        std::fs::read(empty.directory.path().join("project/project.sqlite3")).unwrap(),
        empty_before
    );
    let f = Fixture::create();
    let root = opened(&f);
    let child = f
        .call(
            "delegate_work_plan_agent_scope",
            proposal(&root, json!([f.unit])),
        )
        .unwrap();
    let preparing = generation(&child);
    let prepared = f
        .call("prepare_work_plan_agent_generation", preparing.clone())
        .unwrap();
    let mut reading = preparing;
    reading["inputDigest"] = prepared["inputDigest"].clone();
    let state = f.app.state::<AppState>();
    let held = state.sessions.pause();
    let mut closing = Box::pin(crate::commands::close_project(
        state.clone(),
        crate::commands::CloseProjectRequest {
            session_token: f.context["sessionToken"].as_str().unwrap().into(),
        },
    ));
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(closing.as_mut().poll(&mut context), Poll::Pending));
    let mut reading = Box::pin(agent::read_work_plan_agent_generation_attempt(
        state.clone(),
        serde_json::from_value(request(&f.context, page(&reading))).unwrap(),
    ));
    assert!(matches!(reading.as_mut().poll(&mut context), Poll::Pending));
    drop(held);
    tauri::async_runtime::block_on(closing).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(reading).unwrap_err().code,
        CommandErrorCode::SessionInvalid
    );
}

#[test]
fn agent_subset_registered_human_reconciliation_distinguishes_ended_absence_and_acceptance() {
    let f = Fixture::create();
    let root = opened(&f);
    let child = f
        .call(
            "delegate_work_plan_agent_scope",
            proposal(&root, json!([f.unit])),
        )
        .unwrap();
    let absent_generation = generation(&child);
    let absent = f
        .call("prepare_work_plan_agent_generation", absent_generation)
        .unwrap();
    let identity = json!({"lease":child["lease"],"taskId":absent["taskId"],"attemptId":absent["attemptId"],"inputDigest":absent["inputDigest"]});
    assert_eq!(
        f.call("reconcile_work_plan_agent_execution", identity.clone())
            .unwrap()["outcome"],
        "active"
    );
    let mut starting = generation(&child);
    let accepted = f
        .call("prepare_work_plan_agent_generation", starting.clone())
        .unwrap();
    starting["inputDigest"] = accepted["inputDigest"].clone();
    assert_eq!(
        f.call("start_work_plan_agent_generation", starting)
            .unwrap(),
        accepted["attemptId"]
    );
    let accepted = json!({"lease":child["lease"],"taskId":accepted["taskId"],"attemptId":accepted["attemptId"],"inputDigest":accepted["inputDigest"]});
    f.call("control_work_plan", json!({"actionId":ExecutionId::new(),"planId":child["lease"]["planId"],"expectedGeneration":child["lease"]["generation"],
        "command":"stop","confirmed":false,"checkerExecutions":[],"toolExecution":false,"expiresAt":null})).unwrap();
    // The human metadata query needs neither the old scope registry nor a runtime.
    f.app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_mut().unwrap().execution.take();
    });
    let before = f.bytes();
    let count = f.attempt_count();
    let receipt = f
        .call("reconcile_work_plan_agent_execution", identity.clone())
        .unwrap();
    assert_eq!(
        receipt,
        json!({"identity":identity,"outcome":"not-enqueued"})
    );
    assert_eq!(
        f.call("reconcile_work_plan_agent_execution", accepted.clone())
            .unwrap(),
        json!({"identity":accepted,"outcome":"enqueued"})
    );
    let mut wrong = accepted.clone();
    wrong["inputDigest"] = json!("f".repeat(64));
    assert_eq!(
        f.call("reconcile_work_plan_agent_execution", wrong)
            .unwrap_err()["code"],
        "result-mismatch"
    );
    for field in ["projectId", "sessionToken"] {
        let mut wrong = identity.clone();
        wrong[field] = json!(ExecutionId::new());
        assert!(
            f.call("reconcile_work_plan_agent_execution", wrong)
                .is_err()
        );
    }
    assert_eq!(f.bytes(), before);
    assert_eq!(f.attempt_count(), count);
    f.app
        .state::<AppState>()
        .sessions
        .with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
}
