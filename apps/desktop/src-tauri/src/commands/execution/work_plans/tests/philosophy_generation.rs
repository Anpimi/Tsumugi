//! The independently packaged service client reaches the original production
//! generation adapter; its deterministic siblings retain their own permissions.
use super::*;
use crate::commands::execution::test_fixtures::{
    OwnedDirectory, approved_runtime, provision_packages, selected_package,
};
use std::time::UNIX_EPOCH;
use tsumugi_core::application::{WorkPlanServiceCall, WorkPlanServiceCallIdentity};
use tsumugi_plugin_host::{PackageImage, RuntimeApproval};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildOutcome {
    Saved,
    Disconnected,
    Cancelled,
}

fn installed_fixture() -> (OwnedDirectory, Fixture, PackageImage, Value, String) {
    let installation = OwnedDirectory(tempfile::tempdir().unwrap());
    let (format, format_approval) = selected_package(
        "TSUMUGI_TEST_PLUGIN_PACKAGE",
        "TSUMUGI_TEST_PLUGIN_DIGEST",
        "webvtt",
    );
    let (knowledge, knowledge_approval) = selected_package(
        "TSUMUGI_TEST_GENERATION_PACKAGE",
        "TSUMUGI_TEST_GENERATION_DIGEST",
        "philosophy",
    );
    let generation = sdk::bind_capability(
        knowledge.manifest(),
        "generation-delegate",
        knowledge.package_digest(),
    )
    .unwrap();
    assert_eq!(generation.provider.component_id, "generation");
    assert_eq!(
        generation.declaration.contract.id,
        "org.tsumugi.examples.philosophy-generation-delegate"
    );
    assert!(generation.declaration.profiles.is_empty());
    let source = format.source_import("source-profile").unwrap();
    let runtime = approved_runtime();
    let approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let environment = approval.environment.digest().unwrap();
    provision_packages(
        installation.0.path(),
        &[
            (format, format_approval.clone()),
            (knowledge.clone(), knowledge_approval.clone()),
        ],
        &runtime,
        &approval,
    );
    let fixture = checks::declared_fixture(
        &installation.0.path().join("application"),
        &format_approval,
        &environment,
        &source,
    );
    let component =
        json!({"provider":generation.provider,"profile":null,"environmentDigest":environment});
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let observed = call(
        &fixture.webview,
        "read_plugin_generation_component",
        component.clone(),
    )
    .unwrap();
    assert_eq!(observed["binding"], json!(generation));
    assert_eq!(observed["componentScope"], "attempt");
    assert!(observed["profile"].is_null());
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    (installation, fixture, knowledge, component, environment)
}

fn completed_output(fixture: &Fixture, attempt: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = fixture
            .call(
                "read_execution_attempt",
                json!({"attemptId":attempt,"offset":0,"limit":100}),
            )
            .unwrap();
        let items = detail["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        match items[0]["status"]["execution"].as_str().unwrap() {
            "succeeded" => {
                assert_eq!(items[0]["status"]["adoption"], "unapplied");
                return fixture
                    .call(
                        "read_execution_output",
                        json!({"attemptId":attempt,"resultId":items[0]["resultId"]}),
                    )
                    .unwrap();
            }
            "queued" | "dispatched" => {}
            _ => panic!("actual package component failed: {detail}"),
        }
        assert!(
            Instant::now() < deadline,
            "actual component deadline: {detail}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn settled_child(fixture: &Fixture, attempt: &Value, outcome: ChildOutcome) -> Value {
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
            if matches!(
                view["rows"][0]["automation"]["phase"].as_str(),
                Some("saved" | "failed" | "cancelled")
            ) && !matches!(
                view["detail"]["items"][0]["status"]["execution"].as_str(),
                Some("queued" | "dispatched")
            )
                // An in-flight response may win or lose the cancellation race.
                // Observe the original owner's drained state before inspecting
                // its final output and budget; never require a late success.
                && (outcome != ChildOutcome::Cancelled
                    || fixture.call("execution_status", json!({})).unwrap()["active"] == false)
            {
                return fixture
                    .call("read_ai_translation", json!({"attemptId":attempt}))
                    .unwrap();
            }
        }
        assert!(
            Instant::now() < deadline,
            "original child did not settle: {attempt}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn consent(preflight: &Value) -> Value {
    json!({"attemptId":preflight["attemptId"],"inputDigest":preflight["inputDigest"],
        "grantId":ExecutionId::new(),"unsandboxedExecution":true,
        "expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+60_000).to_string()})
}

fn assert_original_service_association(
    fixture: &Fixture,
    action: &ComponentAction,
    component: &Value,
    output: &Value,
    root: &Value,
) -> Value {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (item, dispatch, handle, call_id, origin, call): (String, String, String, String, Vec<u8>, Vec<u8>) = connection.query_row(
        "SELECT outer_item,outer_dispatch,handle_id,call_id,origin,call FROM application_service_calls WHERE outer_attempt=?1 AND child_attempt=?2",
        [action.outer.to_string(), action.generation["attemptId"].as_str().unwrap().to_owned()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM application_service_calls",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    let origin: Value = serde_json::from_slice(&origin).unwrap();
    let call: WorkPlanServiceCall = serde_json::from_slice(&call).unwrap();
    assert_eq!(origin["grantId"], action.starting["grantId"]);
    assert_eq!(origin["outerInputDigest"], action.preflight["inputDigest"]);
    assert_eq!(
        origin["invocation"]["provider"],
        output["plugin"]["channel"]
    );
    assert_eq!(
        origin["invocation"]["provider"],
        output["plugin"]["result"]["provider"]
    );
    let provider = &origin["invocation"]["provider"];
    for field in ["plugin", "componentId", "contributionId", "packageDigest"] {
        assert_eq!(provider[field], component["provider"][field]);
    }
    assert_eq!(
        origin["invocation"]["context"]["projectId"],
        fixture.context["projectId"]
    );
    assert_eq!(
        origin["invocation"]["context"]["attemptId"],
        json!(action.outer)
    );
    assert_eq!(origin["invocation"]["context"]["itemId"], item);
    assert_eq!(origin["invocation"]["context"]["dispatchId"], dispatch);
    assert_eq!(
        origin["invocation"]["context"]["scopeId"],
        action.outer.to_string()
    );
    assert_eq!(origin["service"]["scopeId"], action.outer.to_string());
    assert_eq!(origin["service"]["projectId"], fixture.context["projectId"]);
    assert_eq!(origin["service"]["providerId"], "tsumugi.core");
    assert_eq!(
        origin["service"]["contract"],
        json!(sdk::generation_service_contract())
    );
    assert_eq!(
        output["plugin"]["authorizationId"],
        action.starting["grantId"]
    );
    let decoded = sdk::parse_generation_service_input(call.input.utf8.as_bytes()).unwrap();
    assert_eq!(json!(decoded), action.generation);
    let identity = WorkPlanServiceCallIdentity {
        outer_attempt_id: action.outer,
        outer_item_id: ExecutionId::parse(&item).unwrap(),
        outer_dispatch_id: ExecutionId::parse(&dispatch).unwrap(),
        handle_id: handle,
        call_id,
    };
    let child: ExecutionId =
        serde_json::from_value(action.generation["attemptId"].clone()).unwrap();
    let root_id: ExecutionId = serde_json::from_value(root["attemptId"].clone()).unwrap();
    let outer = action.outer;
    let outer_grant: ExecutionId =
        serde_json::from_value(action.starting["grantId"].clone()).unwrap();
    let original_input = action.preflight["inputDigest"].as_str().unwrap().to_owned();
    let receipt = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let receipt = store
                .work_plan_service_receipt(&identity, &call)
                .unwrap()
                .unwrap();
            assert_eq!(receipt.identity, identity);
            assert_eq!(receipt.attempt_id, child);
            assert_eq!(receipt.grant_id, outer_grant);
            let outer_input = store.execution_input(outer).unwrap();
            assert_eq!(outer_input.digest(), original_input);
            assert!(outer_input.envelope().automation.is_none());
            assert_eq!(
                outer_input
                    .envelope()
                    .plugin
                    .as_ref()
                    .unwrap()
                    .component_scope,
                sdk::ComponentScope::Attempt
            );
            let child_input = store.execution_input(child).unwrap();
            let root_input = store.execution_input(root_id).unwrap();
            assert!(child_input.envelope().plugin.is_none());
            assert_eq!(
                child_input.envelope().automation,
                root_input.envelope().automation
            );
            assert_eq!(receipt.input_digest, child_input.digest());
            assert_eq!(receipt.parent_task, root_input.envelope().task_id);
            receipt
        });
    let sdk::InvocationOutcome::Succeeded {
        output: acknowledged,
    } = serde_json::from_value::<sdk::InvocationResult>(output["plugin"]["result"].clone())
        .unwrap()
        .outcome
    else {
        panic!("outer result acknowledges only the accepted original child");
    };
    let acknowledged = sdk::parse_generation_service_receipt(acknowledged.utf8.as_bytes()).unwrap();
    assert_eq!(acknowledged.attempt_id, receipt.attempt_id.to_string());
    assert_eq!(acknowledged.task_id, receipt.task_id.to_string());
    assert_eq!(acknowledged.input_digest, receipt.input_digest);
    origin
}

fn ordinary_knowledge_still_executes(
    fixture: &Fixture,
    image: &PackageImage,
    environment: &str,
    outer_grant: &Value,
) {
    let package =
        json!({"plugin":image.manifest().manifest().plugin,"packageDigest":image.package_digest()});
    let binding = image.capability_tool("agent-query-tool").unwrap();
    let payload = binding
        .declaration
        .query
        .as_ref()
        .unwrap()
        .prepare_payload(
            "👩🏽‍💻 e\u{301} sound premises",
            "zh-CN",
            &["soundness".into()],
            binding.capability.declaration.limits.max_input_bytes,
        )
        .unwrap();
    let prepared = fixture.call("prepare_plugin_tool", json!({"attemptId":ExecutionId::new(),
        "tool":{"package":package,"resourceId":"agent-query-tool","environmentDigest":environment},"payloads":[payload]})).unwrap();
    let mut approval = consent(&prepared);
    approval["applicationExecution"] = json!(false);
    assert_ne!(approval["grantId"], *outer_grant);
    let attempt = fixture.call("start_plugin_tool", approval.clone()).unwrap();
    let output = completed_output(fixture, &attempt);
    assert_eq!(output["plugin"]["authorizationId"], approval["grantId"]);
    let response: Value = serde_json::from_str(
        output["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        response["results"][0]["entries"][0]["preferredTarget"],
        "可靠性"
    );
    assert_eq!(response["basis"]["resource"], payload["resource"]);
    let target_request = json!({"unitId":fixture.unit,"locale":"zh-CN"});
    let target = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    fixture
        .call(
            "save_translation_revision",
            json!({"unitId":fixture.unit,"locale":"zh-CN",
        "sourceRevisionId":target["sourceRevisionId"],"expectedSelectionId":target["selectionId"],
        "text":"👩🏽‍💻 e\u{301} 可靠性","actionId":ExecutionId::new()}),
        )
        .unwrap();
    let target = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    let review = image.text_review_declaration("text-review").unwrap();
    let soundness = review
        .declaration
        .rules
        .iter()
        .find(|rule| rule.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
    let check = json!({"unitId":fixture.unit,"locale":"zh-CN","expectedBasis":target["basis"],"actionId":ExecutionId::new(),
        "advisoryChecks":[{"package":package,"resourceId":"text-review","environmentDigest":environment,"rules":[soundness]}]});
    let prepared = fixture
        .call("prepare_review_checks", check.clone())
        .unwrap();
    assert_eq!(prepared["kind"], "plugin");
    let slots = prepared["view"]["checkers"].as_array().unwrap();
    assert_eq!(slots.len(), 2);
    let executions: Vec<_> = slots
        .iter()
        .map(|checker| request(&fixture.context, consent(checker)))
        .collect();
    let run = fixture
        .call(
            "run_review_checks",
            json!({"check":request(&fixture.context, check),"executions":executions}),
        )
        .unwrap();
    assert_eq!(run["outcome"], "completed");
    let run: tsumugi_core::CheckRun = serde_json::from_value(run).unwrap();
    let evidence = run.evidence.unwrap();
    assert_eq!(evidence.advisory_checks.len(), 1);
    assert_eq!(evidence.advisory_checks[0].binding, review);
    assert_eq!(evidence.origins.len(), 2);
    for origin in evidence.origins {
        assert_eq!(
            origin.outcome,
            tsumugi_core::ReviewInvocationOutcome::Succeeded
        );
        let output = fixture
            .call(
                "read_execution_output",
                json!({"attemptId":origin.attempt_id,"resultId":origin.result_id}),
            )
            .unwrap();
        assert_eq!(output["outcome"], "succeeded");
        assert_ne!(output["plugin"]["authorizationId"], *outer_grant);
    }
    assert!(
        fixture.call("read_review_target", target_request).unwrap()["currentCheck"].is_object()
    );
}

#[test]
fn philosophy_generation_real_package_ipc_keeps_original_child_and_durable_budget() {
    exercise(ChildOutcome::Saved);
}

#[test]
fn philosophy_generation_disconnected_backend_preserves_receipt_and_knowledge() {
    exercise(ChildOutcome::Disconnected);
}

#[test]
fn philosophy_generation_cancelled_child_preserves_consumed_budget_and_knowledge() {
    exercise(ChildOutcome::Cancelled);
}

fn exercise(outcome: ChildOutcome) {
    let (_installation, mut fixture, knowledge, component, environment) = installed_fixture();
    let (entered, waiting) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let requests: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let observed = requests.clone();
    let (mut config, provider) = local_provider_responses_at_request(
        2,
        move |ordinal, item| {
            observed.lock().unwrap().push(item.clone());
            if ordinal == 0 {
                Some("原可靠性")
            } else if outcome == ChildOutcome::Disconnected {
                None
            } else {
                Some("子可靠性")
            }
        },
        (outcome == ChildOutcome::Cancelled).then_some((1, (entered, held))),
        None,
        Duration::from_secs(30),
        Duration::from_secs(15),
    );
    if outcome == ChildOutcome::Cancelled {
        // Fix this model timeout before root authorization. The component's
        // original five-second service-origin deadline is never extended.
        config.timeout_seconds = 5;
    }
    let (plan, grant) = fixture.start_candidates(config);
    let root = fixture.wait_saved(&plan["attemptId"]);
    assert_eq!(root["budget"]["dispatched"], 1);
    let count = fixture.attempt_count();
    let action = start_component_for_units(&fixture, component.clone(), &grant, &[fixture.unit]);
    if outcome == ChildOutcome::Cancelled {
        waiting.recv_timeout(Duration::from_secs(15)).unwrap();
    }
    let outer = completed_output(&fixture, &json!(action.outer));
    assert_eq!(
        outer["outcome"], "succeeded",
        "enqueue receipt is separate from child completion"
    );
    if outcome == ChildOutcome::Cancelled {
        let controlled = fixture.call(
            "control_work_plan",
            json!({"actionId":ExecutionId::new(),"planId":plan["planId"],
            "expectedGeneration":grant["lease"]["generation"],"command":"pause","confirmed":false,
            "checkerExecutions":[],"toolExecution":false,"expiresAt":null}),
        );
        // Release the owned HTTP gate before assessing the cancellation reply.
        release.send(()).unwrap();
        assert_eq!(controlled.unwrap()["state"], "paused");
    }
    let child = settled_child(&fixture, &action.generation["attemptId"], outcome);
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert_eq!(child["budget"]["limit"], 2);
    assert_eq!(child["budget"]["dispatched"], 2);
    if outcome == ChildOutcome::Saved {
        assert_eq!(child["rows"][0]["output"]["text"], "子可靠性");
        assert!(child["rows"][0]["savedRevisionId"].is_string());
        assert_eq!(child["budget"]["unresolved"], 0);
    } else {
        assert!(child["rows"][0]["savedRevisionId"].is_null());
        assert_eq!(
            child["rows"][0]["automation"]["phase"],
            if outcome == ChildOutcome::Cancelled {
                "cancelled"
            } else {
                "failed"
            }
        );
        assert_eq!(child["rows"][0]["automation"]["retryable"], false);
        if outcome == ChildOutcome::Disconnected {
            assert!(child["rows"][0]["output"].is_null());
            assert_eq!(
                child["detail"]["items"][0]["status"]["execution"],
                "unknown"
            );
            assert_eq!(
                child["detail"]["items"][0]["status"]["diagnostic"],
                "ai-network-unknown"
            );
            assert_eq!(child["budget"]["unresolved"], 1);
            assert_eq!(child["budget"]["usageUnknown"], 1);
        } else {
            // The public cancellation contract preserves an in-flight result
            // if it completed, or its original uncertainty if it did not.
            // Neither outcome restores permission to save a candidate.
            if child["rows"][0]["output"].is_object() {
                assert_eq!(child["rows"][0]["output"]["text"], "子可靠性");
                assert_eq!(
                    child["detail"]["items"][0]["status"]["execution"],
                    "succeeded"
                );
            } else {
                assert!(child["rows"][0]["output"].is_null());
                assert_eq!(
                    child["detail"]["items"][0]["status"]["execution"],
                    "unknown"
                );
            }
            assert_eq!(
                child["detail"]["items"][0]["status"]["adoption"],
                "unapplied"
            );
            let unknown = child["budget"]["usageUnknown"].as_u64().unwrap();
            assert!(unknown <= 1, "only the child usage may be unknown: {child}");
            assert!(child["budget"]["unresolved"].as_u64().unwrap() <= 1);
            // Every reported synthetic response contributes one token of each
            // kind. Unknown usage is retained, rather than fabricated or free.
            let reported = (2 - unknown).to_string();
            assert_eq!(child["budget"]["promptTokens"], reported);
            assert_eq!(child["budget"]["completionTokens"], reported);
        }
    }
    assert_eq!(fixture.attempt_count(), count + 2);
    let origin = assert_original_service_association(&fixture, &action, &component, &outer, &plan);
    let before = fixture.bytes();
    assert_eq!(
        fixture
            .call(
                "start_work_plan_generation_component",
                action.starting.clone()
            )
            .unwrap(),
        json!(action.outer)
    );
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count + 2);
    assert_eq!(requests.lock().unwrap().len(), 2);
    let mut replacement = action.starting.clone();
    replacement["grantId"] = json!(ExecutionId::new());
    assert!(
        fixture
            .call("start_work_plan_generation_component", replacement)
            .is_err()
    );
    let original_resource = knowledge
        .resource_bytes(
            "terminology",
            &sdk::ContractRef {
                id: "org.tsumugi.examples.terminology-resource".into(),
                schema_version: 1,
                behavior_version: 1,
            },
        )
        .unwrap()
        .to_vec();
    ordinary_knowledge_still_executes(
        &fixture,
        &knowledge,
        &environment,
        &action.starting["grantId"],
    );
    assert_eq!(
        knowledge
            .resource_bytes(
                "terminology",
                &sdk::ContractRef {
                    id: "org.tsumugi.examples.terminology-resource".into(),
                    schema_version: 1,
                    behavior_version: 1,
                }
            )
            .unwrap(),
        original_resource
    );
    let root_after = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        root_after["rows"][0]["savedRevisionId"],
        root["rows"][0]["savedRevisionId"]
    );
    let historical = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":action.generation["attemptId"]}),
        )
        .unwrap();
    fixture.reopen();
    let reopened = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":action.generation["attemptId"]}),
        )
        .unwrap();
    for field in ["output", "savedRevisionId", "itemId", "resultId"] {
        assert_eq!(reopened["rows"][0][field], historical["rows"][0][field]);
    }
    assert_eq!(reopened["budget"], historical["budget"]);
    assert_eq!(
        reopened["detail"]["items"][0]["status"]["execution"],
        historical["detail"]["items"][0]["status"]["execution"]
    );
    assert!(
        fixture
            .call(
                "start_work_plan_generation_component",
                action.starting.clone()
            )
            .is_err()
    );
    assert_eq!(
        assert_original_service_association(&fixture, &action, &component, &outer, &plan),
        origin
    );
    assert_eq!(requests.lock().unwrap().len(), 2);
}
