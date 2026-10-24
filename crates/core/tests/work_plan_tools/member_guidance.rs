//! Model sharing uses the original dispatch and explicit plan consent.
use super::*;

fn options() -> PlanOptions {
    PlanOptions {
        tool_guidance: Some(ToolGuidancePolicy::DeclaredToolsV1 {}),
        ..PlanOptions::default()
    }
}
fn config() -> AiConfig {
    AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "captured-guidance-model".into(),
        credential_env: String::new(),
        ..AiConfig::default()
    }
}
fn shared_fixture(config: AiConfig) -> Fixture {
    let first = tool();
    let mut second = first.clone();
    second.handle = ExecutionId::new();
    fixture_with_options(
        4,
        vec![first.clone(), second],
        vec![Arc::new(UncalledPlugin(first))],
        Default::default(),
        options(),
        config,
    )
}
fn dispatch(f: &mut Fixture, scope: &WorkPlanAgentScope) -> DispatchRequest {
    let request = AgentGenerationRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        unit_ids: vec![f.units[0]],
    };
    let prepared = f
        .store
        .prepare_work_plan_agent_generation(scope, &request)
        .unwrap();
    f.runtime
        .submit_work_plan_agent_generation(&mut f.store, &prepared)
        .unwrap();
    f.store
        .dispatch_execution_item(
            request.attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap()
}

fn recovery_preserves_policy(f: &mut Fixture, author: &CapturedTeamAuthor) {
    f.store
        .control_work_plan(&control(f, WorkPlanCommand::Pause))
        .unwrap();
    let state = f
        .store
        .read_team_recovery_state(f.plan.project_id, f.plan.plan_id)
        .unwrap();
    let members = f
        .plan
        .options
        .team_execution
        .as_ref()
        .unwrap()
        .members()
        .to_vec();
    let request = PrepareTeamRecovery {
        project_id: f.plan.project_id,
        plan_id: f.plan.plan_id,
        expected_lease: state.lease,
        expected_effective_version: state.effective_version,
        work: TeamHumanWork {
            work_id: ExecutionId::new(),
            member_id: members[0].member_id,
            target: author.target().clone(),
            kind: TeamWorkKind::Evidence,
            instructions: "Read only the newly approved member scope.".into(),
            post_ids: vec![],
            prior_work: state.unresolved_work,
        },
        members,
    };
    let capture = f.runtime.prepare_team_recovery(&f.store, &request).unwrap();
    assert_eq!(
        capture.plan().options.tool_guidance,
        f.plan.options.tool_guidance
    );
    let mut changed = serde_json::to_value(&request).unwrap();
    changed["toolGuidance"] = json!({"profile":"declared-tools-1"});
    assert!(serde_json::from_value::<PrepareTeamRecovery>(changed).is_err());
}

#[test]
fn member_tool_guidance_policy_is_strict_captured_and_not_implied_by_query_tools() {
    assert_eq!(
        serde_json::to_value(ToolGuidancePolicy::DeclaredToolsV1 {}).unwrap(),
        json!({"profile":"declared-tools-1"})
    );
    for value in [
        json!({"profile":"unknown"}),
        json!({"profile":"declared-tools-1","share":true}),
    ] {
        assert!(serde_json::from_value::<ToolGuidancePolicy>(value).is_err());
    }
    assert!(
        serde_json::to_value(PlanOptions::default())
            .unwrap()
            .get("toolGuidance")
            .is_none()
    );
    let mut old = fixture(2);
    let scope = old.scope.clone();
    let request = dispatch(&mut old, &scope);
    old.store.capture_work_plan_agent_guidance(&scope).unwrap();
    assert_eq!(
        old.store
            .capture_member_tool_guidance(&scope, &request)
            .unwrap_err()
            .stage,
        "member-guidance-sharing"
    );
    assert_eq!(
        old.store
            .prepare_work_plan(Some(config()), "zh-CN", &old.units, options())
            .unwrap_err()
            .stage,
        "work-plan-guidance-tools"
    );
    let mut manual = options();
    for stage in &mut manual.stages {
        stage.mode = StageMode::Manual;
    }
    assert!(manual.validate().is_err());
    let enabled = shared_fixture(config());
    enabled.plan.validate().unwrap();
    let mut changed = enabled.plan.clone();
    changed.options.tool_guidance = None;
    assert_eq!(changed.validate().unwrap_err().stage, "work-plan-basis");
    let mut missing_tools = enabled.plan.clone();
    missing_tools.tools = None;
    assert_eq!(
        missing_tools.validate().unwrap_err().stage,
        "work-plan-guidance-tools"
    );
    let directory = enabled.store.directory().to_owned();
    enabled.store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(
        reopened
            .work_plan(enabled.plan.plan_id)
            .unwrap()
            .options
            .tool_guidance,
        Some(ToolGuidancePolicy::DeclaredToolsV1 {})
    );
}

#[test]
fn member_tool_guidance_is_exact_to_dispatch_and_delegated_tools_without_mutation() {
    let mut f = shared_fixture(config());
    let allowed = f.plan.tools.as_ref().unwrap().entries[0].clone();
    let other = f.plan.tools.as_ref().unwrap().entries[1].clone();
    let scope = f
        .store
        .delegate_work_plan_agent_scope(
            &f.scope,
            &AgentDelegationRequest {
                delegation_id: ExecutionId::new(),
                unit_ids: vec![f.units[0]],
                tool_handles: vec![allowed.handle],
            },
        )
        .unwrap();
    let request = dispatch(&mut f, &scope);
    let before = std::fs::read(f.store.directory().join("project.sqlite3")).unwrap();
    let sequence = f.store.execution_sequence().unwrap();
    let count = counts(&f.store);
    let budget = f.store.provider_budget(scope.parent_task()).unwrap();
    let captured = f
        .store
        .capture_member_tool_guidance(&scope, &request)
        .unwrap();
    assert_eq!(captured.tools(), &[allowed.clone()]);
    assert_eq!(captured.tool(allowed.handle).unwrap(), &allowed);
    assert!(captured.tool(other.handle).is_err());
    f.store
        .check_member_tool_guidance(&request.clone(), &captured)
        .unwrap();
    assert!(
        f.store
            .capture_member_tool_guidance(&f.scope, &request)
            .is_err()
    );
    let other_caller = f.store.work_plan_agent_scope(f.lease).unwrap();
    assert!(
        f.store
            .capture_member_tool_guidance(&other_caller, &request)
            .is_err()
    );
    let mut wrong = request.clone();
    wrong.dispatch_token = ExecutionId::new();
    assert!(
        f.store
            .capture_member_tool_guidance(&scope, &wrong)
            .is_err()
    );
    assert!(
        f.store
            .check_member_tool_guidance(&wrong, &captured)
            .is_err()
    );
    let mut wrong = request.clone();
    wrong.item_id = ExecutionId::new();
    assert!(
        f.store
            .capture_member_tool_guidance(&scope, &wrong)
            .is_err()
    );
    let mut changed = request.input.envelope().clone();
    changed.settings["config"]["model"] = "unapproved-model".into();
    let mut wrong = request.clone();
    wrong.input = FixedInput::capture(changed).unwrap();
    assert!(
        f.store
            .capture_member_tool_guidance(&scope, &wrong)
            .is_err()
    );
    assert!(
        f.store
            .check_member_tool_guidance(&wrong, &captured)
            .is_err()
    );
    let historical = f
        .store
        .execution_dispatch(request.input.envelope().attempt_id, request.item_id)
        .unwrap();
    assert_eq!(historical.deadline(), None);
    assert_eq!(
        f.store
            .capture_member_tool_guidance(&scope, &historical)
            .unwrap_err()
            .stage,
        "member-guidance-deadline"
    );
    assert!(
        f.store
            .check_member_tool_guidance(&historical, &captured)
            .is_err()
    );
    assert_eq!(counts(&f.store), count);
    assert_eq!(f.store.execution_sequence().unwrap(), sequence);
    assert_eq!(
        f.store.provider_budget(scope.parent_task()).unwrap(),
        budget
    );
    assert_eq!(
        std::fs::read(f.store.directory().join("project.sqlite3")).unwrap(),
        before
    );
    f.store
        .note_execution_unknown(
            request.input.envelope().attempt_id,
            request.item_id,
            "member-unavailable",
        )
        .unwrap();
    assert_eq!(
        f.store
            .check_member_tool_guidance(&request, &captured)
            .unwrap_err()
            .stage,
        "member-guidance-dispatch"
    );
}

#[test]
fn member_tool_guidance_cannot_renew_deadline_or_survive_revocation_and_reopen() {
    let mut short = config();
    short.timeout_seconds = 1;
    let mut f = shared_fixture(short);
    let scope = f.scope.clone();
    let request = dispatch(&mut f, &scope);
    let deadline = request.deadline().unwrap();
    let captured = f
        .store
        .capture_member_tool_guidance(&scope, &request)
        .unwrap();
    std::thread::sleep(
        deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
    );
    for original in [request.clone(), request] {
        assert_eq!(original.deadline(), Some(deadline));
        assert_eq!(
            f.store
                .check_member_tool_guidance(&original, &captured)
                .unwrap_err()
                .stage,
            "member-guidance-deadline"
        );
        assert!(
            f.store
                .capture_member_tool_guidance(&scope, &original)
                .is_err()
        );
    }
    for command in [
        WorkPlanCommand::Pause,
        WorkPlanCommand::Stop,
        WorkPlanCommand::TakeOver,
    ] {
        let mut f = shared_fixture(config());
        let scope = f.scope.clone();
        let request = dispatch(&mut f, &scope);
        let captured = f
            .store
            .capture_member_tool_guidance(&scope, &request)
            .unwrap();
        f.store.control_work_plan(&control(&f, command)).unwrap();
        assert!(
            f.store
                .capture_member_tool_guidance(&scope, &request)
                .is_err()
        );
        assert!(
            f.store
                .check_member_tool_guidance(&request, &captured)
                .is_err()
        );
    }
    let mut f = shared_fixture(config());
    let scope = f.scope.clone();
    let request = dispatch(&mut f, &scope);
    let captured = f
        .store
        .capture_member_tool_guidance(&scope, &request)
        .unwrap();
    let directory = f.store.directory().to_owned();
    f.store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(
        reopened
            .check_member_tool_guidance(&request, &captured)
            .unwrap_err()
            .stage,
        "work-plan-agent-session"
    );
}

#[test]
fn member_tool_guidance_binds_real_team_work_and_rejects_other_members_or_fixed_root() {
    let (mut f, _, author, other, request) =
        super::team_history::setup_with_guidance(Some(ToolGuidancePolicy::DeclaredToolsV1 {}));
    let captured = f
        .store
        .capture_member_tool_guidance(author.scope(), &request)
        .unwrap();
    f.store
        .check_member_tool_guidance(&request, &captured)
        .unwrap();
    assert_eq!(captured.tools().len(), 1);
    assert!(
        f.store
            .capture_member_tool_guidance(other.scope(), &request)
            .is_err()
    );
    recovery_preserves_policy(&mut f, &author);
    let (mut f, _, author, _, request) = super::team_history::setup_with_guidance(None);
    f.store
        .capture_work_plan_agent_guidance(author.scope())
        .unwrap();
    assert_eq!(
        f.store
            .capture_member_tool_guidance(author.scope(), &request)
            .unwrap_err()
            .stage,
        "member-guidance-sharing"
    );
    recovery_preserves_policy(&mut f, &author);
    let mut f = shared_fixture(config());
    let input = f.plan.execution_input().unwrap();
    let request = f
        .store
        .dispatch_execution_item(input.attempt_id, input.items[0].item_id)
        .unwrap();
    assert!(
        f.store
            .capture_member_tool_guidance(&f.scope, &request)
            .is_err()
    );
}
