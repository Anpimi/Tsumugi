//! Registered IPC over synthetic durable tool evidence; no plugin process or
//! Provider is launched by this read-boundary fixture.
use super::*;
use tsumugi_core::application::{AgentToolRequest, WorkPlanToolSpec};

struct NeverRunTool(WorkPlanToolSpec);
impl Runner for NeverRunTool {
    fn capability_id(&self) -> &str {
        &self.0.binding.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.0.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.0.execution.environment)
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("a result read must never launch a worker")
    }
    fn query(&self, _: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        Ok(QueryOutcome::Unavailable)
    }
}

fn finish_root(store: &mut ProjectStore, input: &FixedInput) {
    for item in &input.envelope().items {
        let dispatched = store
            .dispatch_execution_item(input.envelope().attempt_id, item.item_id)
            .unwrap();
        let envelope = input.envelope();
        store
            .save_execution_result(
                &FixedResult::capture(
                    ResultEnvelope {
                        project_id: envelope.project_id,
                        attempt_id: envelope.attempt_id,
                        item_id: item.item_id,
                        result_id: ExecutionId::new(),
                        supersedes: None,
                        dispatch_token: dispatched.dispatch_token,
                        capability_id: envelope.capability_id.clone(),
                        capability_version: envelope.capability_version.clone(),
                        plugin: None,
                        outcome: ExecutionState::Succeeded,
                        output: Some(json!({"translation":"Synthetic completed root"})),
                        diagnostic: None,
                    },
                    input,
                    dispatched.dispatch_token,
                )
                .unwrap(),
            )
            .unwrap();
    }
}

fn scope(fixture: &Fixture) -> (Value, Value) {
    let wire: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/workPlanAgentTools.contract.json"
    )))
    .unwrap();
    let selected: WorkPlanToolSpec = serde_json::from_value(wire["spec"].clone()).unwrap();
    let unit = fixture.unit;
    let (lease, handle) = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let plan = store
                .prepare_work_plan_with_tools(
                    Some(AiConfig {
                        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                        model: "synthetic".into(),
                        ..AiConfig::default()
                    }),
                    "zh-CN",
                    &[unit],
                    PlanOptions::default(),
                    Some(WorkPlanTools {
                        max_invocations: 2,
                        entries: vec![selected.clone()],
                    }),
                )
                .unwrap();
            let expires_at = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 600;
            let grant = store
                .authorize_work_plan(
                    &plan,
                    &AuthorizeWorkPlan {
                        action_id: ExecutionId::new(),
                        plan_digest: plan.digest.clone(),
                        confirmed: true,
                        effects: plan.authorization_effects().unwrap(),
                        expires_at,
                    },
                )
                .unwrap();
            host.runtime
                .register(Arc::new(NeverRunTool(selected.clone())))
                .unwrap();
            let consent = host
                .runtime
                .authorize_work_plan_tools(
                    store,
                    grant.lease,
                    expires_at * 1000,
                    Instant::now() + Duration::from_secs(600),
                    PluginConsent {
                        unsandboxed_execution: true,
                        application_execution: false,
                    },
                )
                .unwrap();
            host.work_plans
                .tool_consents
                .insert(plan.plan_id, (grant.lease, Arc::new(consent)));
            let input = FixedInput::capture(grant.input.unwrap()).unwrap();
            store.enqueue_execution(&input).unwrap();
            finish_root(store, &input);
            let root = store
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap();
            assert_eq!(root.progress.succeeded, root.progress.total);
            assert_eq!(
                store.work_plan_status(plan.plan_id).unwrap().state,
                WorkPlanState::Active
            );
            (grant.lease, selected.handle)
        });
    let opened = fixture
        .call("open_work_plan_agent_scope", json!({"lease":lease}))
        .unwrap();
    let preparing = json!({"scopeId":opened["scopeId"],"tool":{
        "taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":handle,"unitIds":[fixture.unit]
    }});
    let prepared = fixture
        .call("prepare_work_plan_agent_tool", preparing.clone())
        .unwrap();
    let mut reading = preparing;
    reading["inputDigest"] = prepared["inputDigest"].clone();
    (reading, prepared)
}

fn enqueue(fixture: &Fixture, reading: &Value) -> Value {
    let reading = reading.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let id: ExecutionId = serde_json::from_value(reading["scopeId"].clone()).unwrap();
            let scope = host.work_plans.agent_scopes[&id].clone();
            let request: AgentToolRequest =
                serde_json::from_value(reading["tool"].clone()).unwrap();
            let prepared = store
                .prepare_work_plan_agent_tool(&scope, &request)
                .unwrap();
            let consent = host.work_plans.tool_consents[&scope.lease().plan_id]
                .1
                .clone();
            host.runtime
                .submit_work_plan_tool(store, &prepared, &consent, ExecutionId::new())
                .unwrap();
            let item = prepared.input().envelope().items[0].item_id;
            let dispatched = store
                .dispatch_execution_item(request.attempt_id, item)
                .unwrap();
            let selected = &prepared.tool().binding.capability.provider;
            let channel = sdk::ProviderBinding {
                plugin: selected.plugin.clone(),
                component_id: selected.component_id.clone(),
                contribution_id: selected.contribution_id.clone(),
                package_digest: selected.package_digest.clone(),
                instance_id: ExecutionId::new().to_string(),
                activation_generation: 1,
            };
            let invocation = prepared
                .input()
                .plugin_request(item, dispatched.dispatch_token, &channel)
                .unwrap();
            let result = FixedResult::capture_plugin(
                prepared.input(),
                item,
                dispatched.dispatch_token,
                PluginResultEvidence {
                    authorization_id: dispatched.plugin_permit().unwrap().grant_id(),
                    channel: channel.clone(),
                    result: sdk::InvocationResult {
                        context: invocation.context,
                        provider: channel,
                        capability: invocation.capability,
                        profile: invocation.profile,
                        result_id: ExecutionId::new().to_string(),
                        outcome: sdk::InvocationOutcome::Succeeded {
                            output: sdk::EncodedPayload::capture(
                                invocation.output_schema,
                                "{\"results\":[{\"entries\":[]}]}".into(),
                            )
                            .unwrap(),
                        },
                    },
                },
            )
            .unwrap();
            store.save_execution_result(&result).unwrap();
            // No start acknowledgement cache or live tool consent is necessary to
            // read a real record through the still-active Agent scope.
            host.work_plans.tool_consents.clear();
            assert!(host.work_plans.tool_starts.is_empty());
            serde_json::to_value(result.envelope()).unwrap()
        })
}

fn page(reading: &Value) -> Value {
    let mut request = reading.clone();
    request["offset"] = json!(0);
    request["limit"] = json!(1);
    request
}
fn output(reading: &Value, result: &Value) -> Value {
    let mut request = reading.clone();
    request["itemId"] = result["itemId"].clone();
    request["resultId"] = result["resultId"].clone();
    request
}

#[test]
fn registered_tool_reads_use_original_enqueued_evidence_without_new_authority() {
    let fixture = Fixture::create();
    let (reading, prepared) = scope(&fixture);
    let absent = fixture
        .call("read_work_plan_agent_tool_attempt", page(&reading))
        .unwrap_err();
    assert_eq!(absent["code"], "dependency-conflict");
    assert_eq!(absent["reason"], "work-plan-tool-not-enqueued");
    let result = enqueue(&fixture, &reading);
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let observed = fixture
        .call("read_work_plan_agent_tool_attempt", page(&reading))
        .unwrap();
    assert_eq!(observed["attemptId"], prepared["attemptId"]);
    assert_eq!(observed["taskId"], prepared["taskId"]);
    assert_eq!(observed["operation"], "plugin-tool-query");
    assert_eq!(observed["progress"]["succeeded"], 1);
    assert_eq!(
        observed["items"][0]["scope"]["id"],
        fixture.unit.to_string()
    );
    assert_eq!(observed["nextOffset"], Value::Null);
    let read = output(&reading, &result);
    assert_eq!(
        fixture
            .call("read_work_plan_agent_tool_output", read.clone())
            .unwrap(),
        result
    );
    let historical = fixture
        .call(
            "read_execution_output",
            json!({"attemptId":prepared["attemptId"],"resultId":result["resultId"]}),
        )
        .unwrap();
    assert_eq!(historical, result);
    for (field, value) in [
        ("inputDigest", json!("f".repeat(64))),
        ("scopeId", json!(ExecutionId::new())),
    ] {
        let mut forged = read.clone();
        forged[field] = value;
        assert!(
            fixture
                .call("read_work_plan_agent_tool_output", forged)
                .is_err()
        );
    }
    for field in ["itemId", "resultId"] {
        let mut forged = read.clone();
        forged[field] = json!(ExecutionId::new());
        assert!(
            fixture
                .call("read_work_plan_agent_tool_output", forged)
                .is_err()
        );
    }
    for field in ["grantId", "callerId", "confirmed", "payload", "lease"] {
        let mut forged = read.clone();
        forged[field] = json!(true);
        assert!(
            fixture
                .call("read_work_plan_agent_tool_output", forged)
                .is_err()
        );
    }
    let mut wrong_session = read.clone();
    wrong_session["sessionToken"] = json!("other-session");
    assert_eq!(
        fixture
            .call("read_work_plan_agent_tool_output", wrong_session)
            .unwrap_err()["code"],
        "session-invalid"
    );
    let mut wrong_project = read.clone();
    wrong_project["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        fixture
            .call("read_work_plan_agent_tool_output", wrong_project)
            .unwrap_err()["code"],
        "session-invalid"
    );
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(fixture.bytes(), before);
}

#[test]
fn registered_tool_reads_revoke_with_control_and_reopen_but_human_history_remains() {
    let mut fixture = Fixture::create();
    let (reading, prepared) = scope(&fixture);
    let result = enqueue(&fixture, &reading);
    let read = output(&reading, &result);
    let scope_id: ExecutionId = serde_json::from_value(reading["scopeId"].clone()).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_mut().unwrap();
            let scope =
                active.execution.as_ref().unwrap().work_plans.agent_scopes[&scope_id].clone();
            active
                .store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: scope.lease().plan_id,
                    expected_generation: scope.lease().generation,
                    command: WorkPlanCommand::Stop,
                    confirmed: false,
                    expires_at: None,
                })
                .unwrap();
        });
    assert_eq!(
        fixture
            .call("read_work_plan_agent_tool_attempt", page(&reading))
            .unwrap_err()["code"],
        "cancelled"
    );
    assert_eq!(
        fixture
            .call("read_work_plan_agent_tool_output", read.clone())
            .unwrap_err()["code"],
        "cancelled"
    );
    assert_eq!(
        fixture
            .call(
                "read_execution_output",
                json!({"attemptId":prepared["attemptId"],"resultId":result["resultId"]})
            )
            .unwrap(),
        result
    );
    let old_context = fixture.context.clone();
    fixture.reopen();
    assert_eq!(
        call(
            &fixture.webview,
            "read_work_plan_agent_tool_output",
            request(&old_context, read.clone())
        )
        .unwrap_err()["code"],
        "session-invalid"
    );
    let before = fixture.bytes();
    assert!(
        fixture
            .call("read_work_plan_agent_tool_attempt", page(&reading))
            .is_err()
    );
    assert!(
        fixture
            .call("read_work_plan_agent_tool_output", read.clone())
            .is_err()
    );
    assert_eq!(
        fixture
            .call(
                "read_execution_output",
                json!({"attemptId":prepared["attemptId"],"resultId":result["resultId"]})
            )
            .unwrap(),
        result
    );
    assert_eq!(fixture.bytes(), before);
}

#[test]
fn registered_tool_reads_never_create_an_execution_host_for_a_missing_scope() {
    let fixture = ProjectFixture::create("en-US");
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.as_ref().unwrap().execution.is_none());
    });
    let request = request(
        &fixture.context,
        json!({
            "scopeId":ExecutionId::new(),"tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":ExecutionId::new(),"unitIds":[ExecutionId::new()]},
            "inputDigest":"a".repeat(64),"offset":0,"limit":1
        }),
    );
    assert_eq!(
        call(
            &fixture.webview,
            "read_work_plan_agent_tool_attempt",
            request
        )
        .unwrap_err()["code"],
        "permission-denied"
    );
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.as_ref().unwrap().execution.is_none());
    });
}

#[test]
fn tool_read_owner_rechecks_scope_after_an_earlier_accepted_close() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let fixture = Fixture::create();
    let (reading, _) = scope(&fixture);
    enqueue(&fixture, &reading);
    let state = fixture.app.state::<AppState>();
    let held = state.sessions.pause();
    let mut closing = Box::pin(crate::commands::close_project(
        state.clone(),
        crate::commands::CloseProjectRequest {
            session_token: fixture.context["sessionToken"].as_str().unwrap().into(),
        },
    ));
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(closing.as_mut().poll(&mut context), Poll::Pending));
    let request = serde_json::from_value(request(&fixture.context, page(&reading))).unwrap();
    let mut reading = Box::pin(broker::read_work_plan_agent_tool_attempt(
        state.clone(),
        request,
    ));
    assert!(matches!(reading.as_mut().poll(&mut context), Poll::Pending));
    drop(held);
    tauri::async_runtime::block_on(closing).unwrap();
    let denied = tauri::async_runtime::block_on(reading).unwrap_err();
    assert_eq!(denied.code, CommandErrorCode::SessionInvalid);
    state
        .sessions
        .with(|sessions| assert!(sessions.active.is_none()));
}
