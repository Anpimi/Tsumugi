//! Fixed MCP authority and historical reconciliation; no external service calls.
use super::*;

struct UncalledMcp;
impl Runner for UncalledMcp {
    fn capability_id(&self) -> &str {
        MCP_TERM_QUERY_CAPABILITY
    }
    fn capability_version(&self) -> &str {
        MCP_TERM_QUERY_PROFILE
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("this fixture inspects Core MCP admission without transport")
    }
}

struct MemberFixture {
    _temp: tempfile::TempDir,
    store: ProjectStore,
    runtime: ExecutionRuntime,
    plan: WorkPlan,
    prepared: PreparedMcpTermQuery,
    scope: WorkPlanAgentScope,
    dispatch: DispatchRequest,
    consent: Option<WorkPlanToolConsent>,
}
fn mcp_tool() -> McpTermTool {
    McpTermTool {
        discovery_id: ExecutionId::new(),
        discovery_generation: 1u64.into(),
        discovery_expires_at_ms: now_ms() + 120_000,
        endpoint: "http://127.0.0.1:9/mcp".into(),
        credential_env: None,
        server_name: "Synthetic terminology".into(),
        server_version: "1".into(),
        protocol_version: "2025-11-25".into(),
        tool_name: "terms".into(),
        description: None,
        profile_version: MCP_TERM_QUERY_PROFILE.into(),
        input_schema: mcp_term_query_input_schema(),
        output_schema: mcp_term_query_output_schema(),
    }
}
fn fixture(sdk: bool) -> MemberFixture {
    fixture_with_expiry(sdk, 600)
}
fn fixture_with_expiry(sdk: bool, lease_seconds: u64) -> MemberFixture {
    let (temp, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let prepared = store
        .prepare_mcp_term_query(&McpTermQueryRequest {
            project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
                .unwrap(),
            action_id: ExecutionId::new(),
            task_id: ExecutionId::new(),
            attempt_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            query: rows[0].occurrence.text.clone(),
            expires_at_ms: now_ms() + 60_000,
            tool: mcp_tool(),
        })
        .unwrap();
    let selected = tool();
    let plan = store
        .prepare_work_plan_with_tools(
            Some(AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic-mcp-member".into(),
                credential_env: String::new(),
                ..AiConfig::default()
            }),
            "zh-CN",
            &[unit],
            PlanOptions {
                mcp_term_query: Some(McpTermQueryPolicy::FixedTermQueryV1 {
                    preview: prepared.preview().clone(),
                }),
                ..PlanOptions::default()
            },
            sdk.then(|| WorkPlanTools {
                max_invocations: 1,
                entries: vec![selected.clone()],
            }),
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
                expires_at: now_ms() / 1000 + lease_seconds,
            },
        )
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(UncalledModel)).unwrap();
    runtime.register(Arc::new(UncalledMcp)).unwrap();
    let consent = if sdk {
        runtime
            .register(Arc::new(UncalledPlugin(selected)))
            .unwrap();
        Some(
            runtime
                .authorize_work_plan_tools(
                    &store,
                    receipt.lease,
                    now_ms() + 60_000,
                    Instant::now() + Duration::from_secs(60),
                    PluginConsent {
                        unsandboxed_execution: true,
                        application_execution: false,
                    },
                    Default::default(),
                )
                .unwrap(),
        )
    } else {
        None
    };
    store
        .enqueue_execution(&FixedInput::capture(receipt.input.unwrap()).unwrap())
        .unwrap();
    let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
    let model = store
        .prepare_work_plan_agent_generation(
            &scope,
            &AgentGenerationRequest {
                task_id: ExecutionId::new(),
                attempt_id: ExecutionId::new(),
                unit_ids: vec![unit],
            },
        )
        .unwrap();
    runtime
        .submit_work_plan_agent_generation(&mut store, &model)
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            model.input().envelope().attempt_id,
            model.input().envelope().items[0].item_id,
        )
        .unwrap();
    MemberFixture {
        _temp: temp,
        store,
        runtime,
        plan,
        prepared,
        scope,
        dispatch,
        consent,
    }
}
fn capture(f: &MemberFixture) -> CapturedMemberMcpTermQuery {
    f.store
        .capture_member_mcp_term_query(&f.scope, &f.dispatch, &f.prepared)
        .unwrap()
}
fn submit(
    f: &mut MemberFixture,
    captured: &CapturedMemberMcpTermQuery,
) -> PreparedMemberMcpTermQuery {
    let sealed = f
        .store
        .prepare_member_mcp_term_query(&f.dispatch, captured, &f.prepared)
        .unwrap();
    f.runtime
        .submit_member_mcp_term_query(&mut f.store, &sealed)
        .unwrap();
    sealed
}
fn finish(f: &mut MemberFixture) -> FixedResult {
    let input = f.prepared.input().clone();
    let request = f
        .store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let result=FixedResult::capture(ResultEnvelope {
        project_id:input.envelope().project_id,attempt_id:input.envelope().attempt_id,item_id:request.item_id,
        result_id:ExecutionId::new(),supersedes:None,dispatch_token:request.dispatch_token,
        capability_id:MCP_TERM_QUERY_CAPABILITY.into(),capability_version:MCP_TERM_QUERY_PROFILE.into(),plugin:None,
        outcome:ExecutionState::Succeeded,output:Some(json!({"entries":[{"id":"term","source":f.prepared.preview().request.query,"target":"术语","reason":"Untrusted synthetic result"}]})),diagnostic:None,
    },&input,request.dispatch_token).unwrap();
    f.store.save_execution_result(&result).unwrap();
    f.store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    result
}
fn pause(f: &mut MemberFixture) {
    f.store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: f.plan.plan_id,
            expected_generation: f.scope.lease().generation,
            command: WorkPlanCommand::Pause,
            confirmed: false,
            expires_at: None,
        })
        .unwrap();
}

#[test]
fn fixed_member_mcp_policy_is_explicit_strict_single_scope_and_not_manual_consent() {
    assert!(
        serde_json::to_value(PlanOptions::default())
            .unwrap()
            .get("mcpTermQuery")
            .is_none()
    );
    let f = fixture(false);
    assert!(f.plan.tools.is_none());
    assert!(
        f.plan
            .authorization_effects()
            .unwrap()
            .contains(&AutomationEffect::QueryTools)
    );
    assert_eq!(
        f.store.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (0, 1)
    );
    let mut wire = serde_json::to_value(f.plan.options.mcp_term_query.as_ref().unwrap()).unwrap();
    wire["query"] = json!("model supplied query");
    assert!(serde_json::from_value::<McpTermQueryPolicy>(wire).is_err());
    assert!(
        serde_json::from_value::<LookupCapturedTerms>(
            json!({"unitId":f.prepared.preview().request.unit_id,"query":"extra"})
        )
        .is_err()
    );
    let mut options = f.plan.options.clone();
    for stage in &mut options.stages {
        stage.mode = StageMode::Manual;
    }
    assert!(options.validate().is_err());
    let mut multiple = f.plan.clone();
    multiple
        .selection_basis
        .push(multiple.selection_basis[0].clone());
    assert_eq!(
        multiple.validate().unwrap_err().stage,
        "work-plan-mcp-scope"
    );
    let consent = McpTermQueryConsent {
        action_id: f.prepared.preview().request.action_id,
        input_digest: f.prepared.input().digest().into(),
        expires_at_ms: f.prepared.preview().request.expires_at_ms,
        share_query: true,
    };
    let permit = f
        .store
        .authorize_mcp_term_query(&f.prepared, &consent)
        .unwrap();
    assert!(
        f.store
            .capture_member_mcp_term_query(&f.scope, &f.dispatch, &f.prepared)
            .is_err()
    );
    permit.revoke();
}

#[test]
fn fixed_member_mcp_sealed_admission_is_one_original_leaf_and_sharing_survives_consumption() {
    let mut f = fixture(false);
    let captured = capture(&f);
    assert!(captured.deadline() <= f.dispatch.deadline().unwrap());
    let sealed = submit(&mut f, &captured);
    assert_eq!(
        sealed.prepared().input().bytes(),
        f.prepared.input().bytes()
    );
    assert!(sealed.prepared().input().envelope().automation.is_none());
    assert!(sealed.prepared().input().envelope().plugin.is_none());
    assert_eq!(
        f.store.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (1, 1)
    );
    let before = f.store.execution_sequence().unwrap();
    f.runtime
        .submit_member_mcp_term_query(&mut f.store, &sealed)
        .unwrap();
    assert_eq!(f.store.execution_sequence().unwrap(), before);
    let result = finish(&mut f);
    sealed.permit().revoke(); // Original transport Call drop consumes this authority.
    f.store
        .check_member_mcp_term_query(&f.dispatch, &captured)
        .unwrap();
    let shared = f
        .store
        .read_member_mcp_term_query_result(&f.dispatch, &captured)
        .unwrap()
        .unwrap();
    let wire = serde_json::to_value(shared).unwrap();
    assert_eq!(wire["kind"], "untrusted-mcp-terms");
    assert_eq!(wire["resultId"], json!(result.envelope().result_id));
    assert_eq!(wire["resultDigest"], result.digest());
    assert!(
        f.store
            .prepare_member_mcp_term_query(&f.dispatch, &captured, &f.prepared)
            .is_err()
    );
    assert_eq!(
        f.store.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (1, 1)
    );
}

#[test]
fn fixed_member_mcp_rejects_other_dispatch_delegation_and_pause_without_refunding() {
    let mut f = fixture(false);
    let captured = capture(&f);
    let mut other = f.dispatch.clone();
    other.dispatch_token = ExecutionId::new();
    assert!(
        f.store
            .check_member_mcp_term_query(&other, &captured)
            .is_err()
    );
    let delegated = f
        .store
        .delegate_work_plan_agent_scope(
            &f.scope,
            &AgentDelegationRequest {
                delegation_id: ExecutionId::new(),
                unit_ids: vec![f.prepared.preview().request.unit_id],
                tool_handles: vec![],
            },
        )
        .unwrap();
    assert!(
        f.store
            .capture_member_mcp_term_query(&delegated, &f.dispatch, &f.prepared)
            .is_err()
    );
    submit(&mut f, &captured);
    pause(&mut f);
    assert!(
        f.store
            .check_member_mcp_term_query(&f.dispatch, &captured)
            .is_err()
    );
    assert!(
        f.store
            .dispatch_execution_item(
                f.prepared.input().envelope().attempt_id,
                f.prepared.input().envelope().items[0].item_id
            )
            .is_err()
    );
    assert_eq!(
        f.store.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (1, 1)
    );
    assert_eq!(
        f.store
            .control_work_plan(&ControlWorkPlan {
                action_id: ExecutionId::new(),
                plan_id: f.plan.plan_id,
                expected_generation: f
                    .store
                    .work_plan_status(f.plan.plan_id)
                    .unwrap()
                    .lease
                    .generation,
                command: WorkPlanCommand::Continue,
                confirmed: true,
                expires_at: Some(now_ms() / 1000 + 600)
            })
            .unwrap_err()
            .stage,
        "mcp-continue-requires-new-plan"
    );
}

#[test]
fn fixed_member_mcp_unknown_reopen_preserves_original_action_without_new_authority() {
    let mut f = fixture(false);
    let captured = capture(&f);
    let sealed = submit(&mut f, &captured);
    let input = f.prepared.input().clone();
    let item = input.envelope().items[0].item_id;
    f.store
        .dispatch_execution_item(input.envelope().attempt_id, item)
        .unwrap();
    f.store
        .note_execution_unknown(input.envelope().attempt_id, item, "synthetic-receipt-lost")
        .unwrap();
    assert_eq!(
        f.store
            .read_member_mcp_term_query_result(&f.dispatch, &captured)
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    sealed.permit().revoke();
    pause(&mut f);
    let directory = f.store.directory().to_owned();
    f.store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(
        reopened.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (1, 1)
    );
    assert!(
        reopened
            .check_member_mcp_term_query(&f.dispatch, &captured)
            .is_err()
    );
    assert!(
        reopened
            .execution_current_result(input.envelope().attempt_id, item)
            .unwrap()
            .is_none()
    );
    let query = f.prepared.preview();
    assert!(
        reopened
            .reconcile_mcp_term_query(
                query.request.project_id,
                query.request.attempt_id,
                &McpTermQueryConsent {
                    action_id: query.request.action_id,
                    input_digest: query.input_digest.clone(),
                    expires_at_ms: query.request.expires_at_ms,
                    share_query: true
                }
            )
            .unwrap()
            .is_some()
    );
}

#[test]
fn fixed_member_mcp_does_not_consume_or_expand_sdk_invocations() {
    let mut f = fixture(true);
    let captured = capture(&f);
    submit(&mut f, &captured);
    let tool_request = AgentToolRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        tool_handle: f.plan.tools.as_ref().unwrap().entries[0].handle,
        unit_ids: vec![f.prepared.preview().request.unit_id],
    };
    let sdk = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &tool_request)
        .unwrap();
    f.runtime
        .submit_work_plan_tool(
            &mut f.store,
            &sdk,
            f.consent.as_ref().unwrap(),
            ExecutionId::new(),
        )
        .unwrap();
    assert_eq!(
        f.store.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (2, 2)
    );
    let extra = f
        .store
        .prepare_work_plan_agent_tool(
            &f.scope,
            &AgentToolRequest {
                task_id: ExecutionId::new(),
                attempt_id: ExecutionId::new(),
                ..tool_request
            },
        )
        .unwrap();
    assert_eq!(
        f.runtime
            .submit_work_plan_tool(
                &mut f.store,
                &extra,
                f.consent.as_ref().unwrap(),
                ExecutionId::new()
            )
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(
        f.store.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (2, 2)
    );
    let directory = f.store.directory().to_owned();
    pause(&mut f);
    f.store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(
        reopened.work_plan_tool_usage(f.plan.plan_id).unwrap(),
        (2, 2)
    );
}

#[test]
fn fixed_member_mcp_history_rejects_different_typed_model_item() {
    let mut f = fixture(false);
    let captured = capture(&f);
    submit(&mut f, &captured);
    finish(&mut f);
    pause(&mut f);
    let attempt = f.prepared.preview().request.attempt_id;
    let directory = f.store.directory().to_owned();
    f.store.close().unwrap();
    let c = rusqlite::Connection::open(directory.join("project.sqlite3")).unwrap();
    let bytes: Vec<u8> = c
        .query_row(
            "SELECT delegation FROM application_executions WHERE attempt_id=?1",
            [attempt.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    let mut binding: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    binding["modelItem"] = json!(ExecutionId::new());
    c.execute(
        "UPDATE application_executions SET delegation=?2 WHERE attempt_id=?1",
        rusqlite::params![attempt.to_string(), serde_json::to_vec(&binding).unwrap()],
    )
    .unwrap();
    drop(c);
    assert!(matches!(
        ProjectStore::open(directory),
        Err(tsumugi_core::PersistenceError::CorruptProject { .. })
    ));
}

#[test]
fn fixed_member_mcp_repeated_capture_keeps_the_first_shorter_lease_deadline() {
    let f = fixture_with_expiry(false, 2);
    let first = capture(&f);
    assert!(first.deadline() < f.dispatch.deadline().unwrap());
    std::thread::sleep(Duration::from_millis(3));
    let repeated = capture(&f);
    assert_eq!(repeated.deadline(), first.deadline());
}
