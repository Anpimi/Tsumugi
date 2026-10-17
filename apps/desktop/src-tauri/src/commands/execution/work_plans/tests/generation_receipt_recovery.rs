//! A lost service receipt preserves the original child and never renews authority.
use super::*;
use tsumugi_core::application::{
    WorkPlanServiceCall, WorkPlanServiceCallIdentity, WorkPlanServiceReceipt,
};

#[derive(Clone, Debug)]
struct ReceiptDelivery {
    caller: tsumugi_plugin_host::ServiceCaller,
    binding: sdk::ServiceBinding,
    request: sdk::ServiceRequest,
    accepted: sdk::ServiceResponse,
    delivered: sdk::ServiceResponse,
}
type Deliveries = Arc<std::sync::Mutex<Vec<ReceiptDelivery>>>;

struct LostReceiptFactory {
    original: Arc<dyn tsumugi_plugin_host::core::ProjectServiceFactory>,
    deliveries: Deliveries,
}
struct LostReceiptBroker {
    original: Arc<dyn tsumugi_plugin_host::ProjectServiceBroker>,
    deliveries: Deliveries,
}
impl tsumugi_plugin_host::core::ProjectServiceFactory for LostReceiptFactory {
    fn capture(
        &self,
        request: DispatchRequest,
        permit: PluginPermit,
        cancellation: Cancellation,
    ) -> tsumugi_plugin_host::core::ProjectServiceSelectionFuture {
        let original = self.original.capture(request, permit, cancellation);
        let deliveries = self.deliveries.clone();
        Box::pin(async move {
            Ok(Arc::new(LostReceiptBroker {
                original: original.await?,
                deliveries,
            })
                as Arc<dyn tsumugi_plugin_host::ProjectServiceBroker>)
        })
    }
}
impl tsumugi_plugin_host::ProjectServiceBroker for LostReceiptBroker {
    fn bindings(&self) -> &[sdk::ServiceBinding] {
        self.original.bindings()
    }
    fn is_current(&self, binding: &sdk::ServiceBinding) -> bool {
        self.original.is_current(binding)
    }
    fn call<'a>(
        &'a self,
        caller: tsumugi_plugin_host::ServiceCaller,
        binding: sdk::ServiceBinding,
        request: sdk::ServiceRequest,
    ) -> tsumugi_plugin_host::ProjectServiceFuture<'a> {
        Box::pin(async move {
            let accepted = self
                .original
                .call(caller.clone(), binding.clone(), request.clone())
                .await?;
            accepted.validate_against(&request, &binding).unwrap();
            assert!(
                matches!(&accepted.outcome, sdk::InvocationOutcome::Succeeded { .. }),
                "the fault must follow a real successful broker receipt: {accepted:?}"
            );
            // This is a one-shot caller receipt fault, not an outer Start ACK
            // loss or an OS disconnect. The original enqueue and ledger stand.
            let error = sdk::EncodedPayload::capture(
                sdk::generation_service_error_contract(),
                serde_json::to_string(&sdk::GenerationServiceError {
                    code: sdk::GenerationServiceErrorCode::OutcomeUnknown,
                })
                .unwrap(),
            )
            .unwrap();
            let delivered = sdk::ServiceResponse {
                outcome: sdk::InvocationOutcome::Unknown { error },
                ..accepted.clone()
            };
            delivered.validate_against(&request, &binding).unwrap();
            let mut deliveries = self.deliveries.lock().unwrap();
            assert!(
                deliveries.is_empty(),
                "the original Node caller must call only once"
            );
            deliveries.push(ReceiptDelivery {
                caller,
                binding,
                request,
                accepted,
                delivered: delivered.clone(),
            });
            Ok(delivered)
        })
    }
    fn release_channel(&self, channel: &tsumugi_plugin_host::ChannelReceipt) {
        self.original.release_channel(channel);
    }
}

fn history(fixture: &Fixture) -> Value {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut counts = serde_json::Map::new();
    for table in [
        "execution_attempts",
        "translation_revisions",
        "translation_selections",
        "review_checks",
        "review_decisions",
        "application_selection_actions",
        "application_service_calls",
    ] {
        let count = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        counts.insert(table.into(), json!(count));
    }
    let mut statement = connection.prepare(
        "SELECT outer_attempt,outer_item,outer_dispatch,handle_id,call_id,child_attempt,grant_id,origin,origin_digest,call,call_digest FROM application_service_calls ORDER BY child_attempt"
    ).unwrap();
    let calls: Vec<Value> = statement.query_map([], |row| {
        Ok(json!({"outerAttempt":row.get::<_, String>(0)?, "outerItem":row.get::<_, String>(1)?,
            "outerDispatch":row.get::<_, String>(2)?, "handleId":row.get::<_, String>(3)?,
            "callId":row.get::<_, String>(4)?, "childAttempt":row.get::<_, String>(5)?,
            "grantId":row.get::<_, String>(6)?, "origin":row.get::<_, Vec<u8>>(7)?,
            "originDigest":row.get::<_, String>(8)?, "call":row.get::<_, Vec<u8>>(9)?,
            "callDigest":row.get::<_, String>(10)?}))
    }).unwrap().collect::<Result<_, _>>().unwrap();
    let mut statement = connection.prepare(
        "SELECT grant_id,task_id,attempt_id,input_digest,generation,expires_at_ms FROM plugin_execution_grants ORDER BY grant_id"
    ).unwrap();
    let grants: Vec<Value> = statement.query_map([], |row| {
        Ok(json!({"grantId":row.get::<_, String>(0)?, "taskId":row.get::<_, String>(1)?,
            "attemptId":row.get::<_, String>(2)?, "inputDigest":row.get::<_, String>(3)?,
            "generation":row.get::<_, String>(4)?, "expiresAtMs":row.get::<_, i64>(5)?.to_string()}))
    }).unwrap().collect::<Result<_, _>>().unwrap();
    json!({"counts":counts,"calls":calls,"grants":grants})
}

fn original_action(fixture: &Fixture, action: &Value) -> (Vec<u8>, String, Vec<u8>, String) {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    connection.query_row(
        "SELECT request,request_digest,receipt,receipt_digest FROM application_actions WHERE action_id=?1",
        [action.as_str().unwrap()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).unwrap()
}

fn saved_same(before: &Value, after: &Value) {
    for field in ["itemId", "resultId", "output", "savedRevisionId"] {
        assert_eq!(before["rows"][0][field], after["rows"][0][field], "{field}");
    }
    assert_eq!(
        before["rows"][0]["automation"]["receipt"],
        after["rows"][0]["automation"]["receipt"]
    );
    assert_eq!(before["budget"], after["budget"]);
}

fn read_receipt(
    fixture: &Fixture,
    identity: &WorkPlanServiceCallIdentity,
    call: &WorkPlanServiceCall,
) -> WorkPlanServiceReceipt {
    let identity = identity.clone();
    let call = call.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let receipt = store
                .work_plan_service_receipt(&identity, &call)
                .unwrap()
                .unwrap();
            let mut wrong = call.clone();
            wrong.call_id.push_str("-different");
            let error = store
                .work_plan_service_receipt(&identity, &wrong)
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::ResultMismatch);
            receipt
        })
}

fn fixed_inputs(fixture: &Fixture, attempts: &[ExecutionId]) -> Vec<Vec<u8>> {
    let attempts = attempts.to_vec();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            attempts
                .iter()
                .map(|attempt| store.execution_input(*attempt).unwrap().bytes().to_vec())
                .collect()
        })
}

#[test]
fn accepted_service_receipt_loss_recovers_exact_child_without_resending_or_renewing_on_reopen() {
    let mut fixture = Fixture::create();
    let (component, _installation, _approval) = install_generation(&fixture);
    let deliveries: Deliveries = Arc::default();
    let captured = deliveries.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.service_factory = Some(Arc::new(LostReceiptFactory {
                original: host.service_factory.clone().unwrap(),
                deliveries: captured,
            }));
        });
    let baseline = history(&fixture);
    let requests: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let recorded = requests.clone();
    let (setup, waiting) = mpsc::channel();
    let (config, provider) = local_provider_responses_at_request(
        2,
        move |ordinal, item| {
            recorded.lock().unwrap().push(item.clone());
            Some(if ordinal == 0 {
                "original root candidate"
            } else {
                "original child candidate"
            })
        },
        None,
        Some(waiting),
        Duration::from_secs(30),
        Duration::from_secs(3),
    );
    assert_eq!(config.timeout_seconds, 2);
    assert_eq!(config.max_requests, 2);
    let plan = fixture
        .call(
            "prepare_work_plan",
            json!({
                "config":config,"locale":"zh-CN","unitIds":[fixture.unit],
                "options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null
            }),
        )
        .unwrap();
    // Fix the existing fresh-plan lifetime once, before its first authorization.
    let expires_at = expiry();
    let authorization = json!({
        "planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),
        "confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"applicationToolExecutions":[],
        "effects":["save-candidate"],"expiresAt":expires_at
    });
    let grant = fixture
        .call("authorize_work_plan", authorization.clone())
        .unwrap();
    let authorization_bytes = original_action(&fixture, &grant["actionId"]);
    setup.send(()).unwrap();
    assert_eq!(fixture.call("start_work_plan", json!({
        "planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]
    })).unwrap(), plan["attemptId"]);
    let root_saved = fixture.wait_saved(&plan["attemptId"]);
    assert_eq!(
        root_saved["rows"][0]["output"]["text"],
        "original root candidate"
    );
    let action = start_component_for_units(&fixture, component, &grant, &[fixture.unit]);
    // This actual IPC ACK was delivered normally. Only the inner service reply
    // is replaced, after the broker has accepted the original child.
    let outer_task = fixture
        .call(
            "read_execution_task",
            json!({
                "taskId":action.preflight["taskId"],"after":"0","limit":100
            }),
        )
        .unwrap();
    assert_eq!(outer_task.as_array().unwrap().len(), 1);
    assert_eq!(outer_task[0]["attemptId"], json!(action.outer));
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if !deliveries.lock().unwrap().is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "actual Node caller never received the synthetic Unknown"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let delivery = deliveries.lock().unwrap()[0].clone();
    assert!(delivery.caller.channel().child_pid > 0);
    assert_eq!(
        delivery.caller.invocation().provider,
        delivery.caller.channel().provider
    );
    assert_eq!(
        json!(delivery.caller.channel().provider.selection()),
        action.preflight["component"]["binding"]["provider"]
    );
    assert_eq!(delivery.request.context, *delivery.caller.context());
    assert_eq!(delivery.request.call_id, "generation-call");
    assert_eq!(delivery.request.handle_id, delivery.binding.handle_id);
    assert_eq!(
        delivery.request.context.attempt_id,
        action.outer.to_string()
    );
    assert_eq!(
        delivery.request.context.input_digest,
        delivery.caller.invocation().input.sha256
    );
    assert_eq!(delivery.accepted.call_id, delivery.delivered.call_id);
    assert_eq!(delivery.accepted.handle_id, delivery.delivered.handle_id);
    assert_eq!(delivery.accepted.context, delivery.delivered.context);
    let proposed =
        sdk::parse_generation_service_input(delivery.request.input.utf8.as_bytes()).unwrap();
    assert_eq!(json!(proposed), action.generation);
    assert_eq!(delivery.request.input, delivery.caller.invocation().input);
    let accepted = match &delivery.accepted.outcome {
        sdk::InvocationOutcome::Succeeded { output } => {
            sdk::parse_generation_service_receipt(output.utf8.as_bytes()).unwrap()
        }
        other => panic!("broker did not accept: {other:?}"),
    };
    accepted.validate_against(&proposed).unwrap();
    let error = match &delivery.delivered.outcome {
        sdk::InvocationOutcome::Unknown { error } => {
            sdk::parse_generation_service_error(error.utf8.as_bytes()).unwrap()
        }
        other => panic!("wrong caller fault: {other:?}"),
    };
    assert_eq!(error.code, sdk::GenerationServiceErrorCode::OutcomeUnknown);
    let child_saved = fixture.wait_saved(&action.generation["attemptId"]);
    assert_eq!(
        child_saved["rows"][0]["output"]["text"],
        "original child candidate"
    );
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    let http_requests = requests.lock().unwrap().clone();
    assert_eq!(http_requests.len(), 2);
    assert_eq!(http_requests[0], http_requests[1]);
    let outer = action.outer;
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let idle = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
                let detail = store.execution_attempt(outer, true).unwrap();
                if detail
                    .items
                    .iter()
                    .all(|item| item.execution == ExecutionState::Unknown)
                {
                    assert_eq!(detail.items.len(), 1);
                    return !host.active(store).unwrap();
                }
                assert!(
                    !detail.items.iter().any(|item| matches!(
                        item.execution,
                        ExecutionState::Succeeded
                            | ExecutionState::Failed
                            | ExecutionState::CancelledBeforeDispatch
                    )),
                    "actual Node result must be Unknown: {detail:?}"
                );
                false
            });
        if idle {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "original producers did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let child_task = fixture
        .call(
            "read_execution_task",
            json!({
                "taskId":action.generation["taskId"],"after":"0","limit":100
            }),
        )
        .unwrap();
    assert_eq!(child_task.as_array().unwrap().len(), 1);
    assert_eq!(child_task[0]["attemptId"], action.generation["attemptId"]);
    let identity = WorkPlanServiceCallIdentity {
        outer_attempt_id: action.outer,
        outer_item_id: ExecutionId::parse(&delivery.request.context.item_id).unwrap(),
        outer_dispatch_id: ExecutionId::parse(&delivery.request.context.dispatch_id).unwrap(),
        handle_id: delivery.request.handle_id.clone(),
        call_id: delivery.request.call_id.clone(),
    };
    let call = WorkPlanServiceCall {
        handle_id: delivery.request.handle_id.clone(),
        call_id: delivery.request.call_id.clone(),
        input: delivery.request.input.clone(),
    };
    let saved = history(&fixture);
    assert_eq!(
        saved["counts"]["execution_attempts"],
        baseline["counts"]["execution_attempts"].as_i64().unwrap() + 3
    );
    assert_eq!(
        saved["counts"]["translation_revisions"],
        baseline["counts"]["translation_revisions"]
            .as_i64()
            .unwrap()
            + 2
    );
    for table in [
        "translation_selections",
        "review_checks",
        "review_decisions",
        "application_selection_actions",
    ] {
        assert_eq!(saved["counts"][table], baseline["counts"][table], "{table}");
    }
    assert_eq!(saved["counts"]["application_service_calls"], 1);
    let association = &saved["calls"][0];
    assert_eq!(association["outerAttempt"], json!(action.outer));
    assert_eq!(association["outerItem"], identity.outer_item_id.to_string());
    assert_eq!(
        association["outerDispatch"],
        identity.outer_dispatch_id.to_string()
    );
    assert_eq!(association["handleId"], identity.handle_id);
    assert_eq!(association["callId"], identity.call_id);
    assert_eq!(association["childAttempt"], action.generation["attemptId"]);
    assert_eq!(association["grantId"], action.starting["grantId"]);
    let stored_call: WorkPlanServiceCall = serde_json::from_value(
        serde_json::from_slice(
            &serde_json::from_value::<Vec<u8>>(association["call"].clone()).unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(stored_call, call);
    let origin: Value = serde_json::from_slice(
        &serde_json::from_value::<Vec<u8>>(association["origin"].clone()).unwrap(),
    )
    .unwrap();
    assert_eq!(origin["lease"], grant["lease"]);
    assert_eq!(origin["parentTask"], action.scope["parentTask"]);
    assert_eq!(origin["invocation"], json!(delivery.caller.invocation()));
    assert_eq!(origin["service"], json!(delivery.binding));
    assert_eq!(origin["grantId"], action.starting["grantId"]);
    assert_eq!(
        origin["grantExpiresAtMs"].as_u64().unwrap().to_string(),
        action.starting["expiresAtMs"].as_str().unwrap()
    );
    let plugin_grant = saved["grants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["grantId"] == action.starting["grantId"])
        .unwrap();
    assert_eq!(plugin_grant["attemptId"], json!(action.outer));
    assert_eq!(plugin_grant["taskId"], action.preflight["taskId"]);
    assert_eq!(plugin_grant["inputDigest"], action.starting["inputDigest"]);
    assert_eq!(plugin_grant["expiresAtMs"], action.starting["expiresAtMs"]);
    assert_eq!(origin["grantGeneration"], plugin_grant["generation"]);
    assert_eq!(
        saved["grants"].as_array().unwrap().len(),
        baseline["grants"].as_array().unwrap().len() + 1
    );
    let root_id: ExecutionId = serde_json::from_value(plan["attemptId"].clone()).unwrap();
    let child_id: ExecutionId =
        serde_json::from_value(action.generation["attemptId"].clone()).unwrap();
    let attempts = [root_id, action.outer, child_id];
    let input_bytes = fixed_inputs(&fixture, &attempts);
    let outer_id = action.outer;
    let expected_outer_digest = action.preflight["inputDigest"].as_str().unwrap().to_owned();
    let expected_child_digest = accepted.input_digest.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let root = store.execution_input(root_id).unwrap();
            let outer = store.execution_input(outer_id).unwrap();
            let child = store.execution_input(child_id).unwrap();
            assert!(outer.envelope().plugin.is_some());
            assert!(outer.envelope().automation.is_none());
            assert!(child.envelope().plugin.is_none());
            assert_eq!(child.envelope().automation, root.envelope().automation);
            assert_eq!(outer.digest(), expected_outer_digest);
            assert_eq!(child.digest(), expected_child_digest);
        });
    let before = fixture.bytes();
    let receipt = read_receipt(&fixture, &identity, &call);
    assert_eq!(receipt.identity, identity);
    assert_eq!(json!(receipt.grant_id), action.starting["grantId"]);
    assert_eq!(json!(receipt.lease), grant["lease"]);
    assert_eq!(json!(receipt.parent_task), action.scope["parentTask"]);
    assert_eq!(receipt.task_id.to_string(), accepted.task_id);
    assert_eq!(receipt.attempt_id.to_string(), accepted.attempt_id);
    assert_eq!(receipt.input_digest, accepted.input_digest);
    assert_eq!(
        fixture
            .call(
                "read_work_plan_action",
                json!({"actionId":grant["actionId"]})
            )
            .unwrap(),
        grant
    );
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
    assert_eq!(fixed_inputs(&fixture, &attempts), input_bytes);
    assert_eq!(history(&fixture), saved);
    assert_eq!(
        original_action(&fixture, &grant["actionId"]),
        authorization_bytes
    );
    assert_eq!(deliveries.lock().unwrap().len(), 1);
    assert_eq!(requests.lock().unwrap().len(), 2);
    let budget = &child_saved["budget"];
    assert_eq!(budget["limit"], 2);
    assert_eq!(budget["dispatched"], 2);
    assert_eq!(budget["unresolved"], 0);
    assert_eq!(budget["usageUnknown"], 0);
    assert_eq!(budget["promptTokens"], "2");
    assert_eq!(budget["completionTokens"], "2");
    // Budget is shared by the original plan. Read the root again after the
    // child settles, rather than compare its earlier one-request projection.
    let root_terminal = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    for field in ["itemId", "resultId", "output", "savedRevisionId"] {
        assert_eq!(
            root_saved["rows"][0][field], root_terminal["rows"][0][field],
            "{field}"
        );
    }
    assert_eq!(root_terminal["budget"], child_saved["budget"]);
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    assert_eq!(status["lease"], grant["lease"]);
    assert_eq!(status["state"], "active");
    assert_eq!(status["expiresAt"], expires_at);
    fixture.reopen();
    let reopened_bytes = fixture.bytes();
    assert_eq!(read_receipt(&fixture, &identity, &call), receipt);
    saved_same(
        &child_saved,
        &fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":action.generation["attemptId"]}),
            )
            .unwrap(),
    );
    saved_same(
        &root_terminal,
        &fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]}),
            )
            .unwrap(),
    );
    assert_eq!(
        fixture.call("authorize_work_plan", authorization).unwrap(),
        grant
    );
    assert_eq!(
        fixture
            .call(
                "read_work_plan_action",
                json!({"actionId":grant["actionId"]})
            )
            .unwrap(),
        grant
    );
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    let original_generation: u64 = grant["lease"]["generation"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        status["lease"],
        json!({"planId":plan["planId"],"generation":original_generation.checked_add(1).unwrap().to_string()})
    );
    assert_eq!(status["state"], "paused");
    assert_eq!(status["expiresAt"], expires_at);
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
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        let host = sessions
            .active
            .as_ref()
            .unwrap()
            .execution
            .as_ref()
            .unwrap();
        assert!(host.work_plans.checker_consents.is_empty());
        assert!(host.work_plans.tool_consents.is_empty());
    });
    assert_eq!(fixture.bytes(), reopened_bytes);
    assert_eq!(fixed_inputs(&fixture, &attempts), input_bytes);
    assert_eq!(
        fixture
            .call(
                "read_execution_task",
                json!({"taskId":action.preflight["taskId"],"after":"0","limit":100})
            )
            .unwrap(),
        outer_task
    );
    assert_eq!(
        fixture
            .call(
                "read_execution_task",
                json!({"taskId":action.generation["taskId"],"after":"0","limit":100})
            )
            .unwrap(),
        child_task
    );
    assert_eq!(history(&fixture), saved);
    assert_eq!(
        original_action(&fixture, &grant["actionId"]),
        authorization_bytes
    );
    assert_eq!(deliveries.lock().unwrap().len(), 1);
    assert_eq!(requests.lock().unwrap().len(), 2);
}
