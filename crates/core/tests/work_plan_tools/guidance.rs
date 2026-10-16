use super::*;

fn budget(f: &Fixture) -> serde_json::Value {
    serde_json::to_value(f.store.provider_budget(f.scope.parent_task()).unwrap()).unwrap()
}

#[test]
fn tool_guidance_reads_original_tools_without_inputs_grants_or_budget_mutations() {
    let f = fixture(2);
    let before = std::fs::read(f.store.directory().join("project.sqlite3")).unwrap();
    let previous_counts = counts(&f.store);
    let previous_budget = budget(&f);
    let capture = f.store.capture_work_plan_agent_guidance(&f.scope).unwrap();
    assert_eq!(capture.tools(), f.plan.tools.as_ref().unwrap().entries);
    let original = &f.plan.tools.as_ref().unwrap().entries[0];
    assert_eq!(capture.tool(original.handle).unwrap(), original);
    assert!(original.binding.declaration.skill.is_some());
    assert!(!original.binding.resources.is_empty());
    f.store
        .check_work_plan_agent_guidance(&f.scope, &capture)
        .unwrap();
    assert_eq!(counts(&f.store), previous_counts);
    assert_eq!(budget(&f), previous_budget);
    assert_eq!(
        std::fs::read(f.store.directory().join("project.sqlite3")).unwrap(),
        before
    );
    assert!(
        !f.runtime
            .is_active(f.plan.execution_input().unwrap().attempt_id)
    );
}

#[test]
fn tool_guidance_witness_is_exact_to_caller_project_and_original_members() {
    let f = fixture(2);
    let captured = f.store.capture_work_plan_agent_guidance(&f.scope).unwrap();
    assert_eq!(
        captured.tool(ExecutionId::new()).unwrap_err().stage,
        "work-plan-guidance-member"
    );
    let other_caller = f.store.work_plan_agent_scope(f.lease).unwrap();
    assert_ne!(f.scope.caller_id(), other_caller.caller_id());
    assert_eq!(
        f.store
            .check_work_plan_agent_guidance(&other_caller, &captured)
            .unwrap_err()
            .stage,
        "work-plan-guidance-scope"
    );
    let other = fixture(2);
    assert!(
        other
            .store
            .check_work_plan_agent_guidance(&f.scope, &captured)
            .is_err()
    );
    let own = f
        .store
        .capture_work_plan_agent_guidance(&other_caller)
        .unwrap();
    assert_eq!(own.tools(), captured.tools());
    f.store
        .check_work_plan_agent_guidance(&other_caller, &own)
        .unwrap();
    // Caller-owned metadata is not the captured witness and cannot rewrite it.
    let mut displayed = captured.tools()[0].clone();
    displayed.binding.declaration.skill = Some("other-guidance".into());
    displayed.binding.resources.clear();
    assert_ne!(displayed, *captured.tool(displayed.handle).unwrap());
    f.store
        .check_work_plan_agent_guidance(&f.scope, &captured)
        .unwrap();
}

#[test]
fn tool_guidance_requires_query_tools_even_with_an_active_generation_scope() {
    let mut f = fixture(1);
    let plan = f
        .store
        .prepare_work_plan(
            Some(AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic".into(),
                ..AiConfig::default()
            }),
            "zh-CN",
            &f.units,
            PlanOptions::default(),
        )
        .unwrap();
    let grant = f
        .store
        .authorize_work_plan(
            &plan,
            &AuthorizeWorkPlan {
                action_id: ExecutionId::new(),
                plan_digest: plan.digest.clone(),
                confirmed: true,
                effects: plan.authorization_effects().unwrap(),
                expires_at: now_ms() / 1000 + 600,
            },
        )
        .unwrap();
    f.store
        .enqueue_execution(&FixedInput::capture(grant.input.unwrap()).unwrap())
        .unwrap();
    let scope = f.store.work_plan_agent_scope(grant.lease).unwrap();
    assert_eq!(
        f.store
            .capture_work_plan_agent_guidance(&scope)
            .unwrap_err()
            .stage,
        "work-plan-guidance-scope"
    );
}

#[test]
fn tool_guidance_old_scope_cannot_survive_controls_expiry_or_project_reopen() {
    for command in [
        WorkPlanCommand::Pause,
        WorkPlanCommand::Stop,
        WorkPlanCommand::TakeOver,
    ] {
        let mut f = fixture(1);
        let captured = f.store.capture_work_plan_agent_guidance(&f.scope).unwrap();
        f.store.control_work_plan(&control(&f, command)).unwrap();
        assert_eq!(
            f.store
                .capture_work_plan_agent_guidance(&f.scope)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert!(
            f.store
                .check_work_plan_agent_guidance(&f.scope, &captured)
                .is_err()
        );
        if command == WorkPlanCommand::Pause {
            let continued = f
                .store
                .control_work_plan(&control(&f, WorkPlanCommand::Continue))
                .unwrap();
            let current = f.store.work_plan_agent_scope(continued.lease).unwrap();
            assert!(
                f.store
                    .check_work_plan_agent_guidance(&current, &captured)
                    .is_err()
            );
            assert_eq!(
                f.store
                    .capture_work_plan_agent_guidance(&current)
                    .unwrap()
                    .tools(),
                captured.tools()
            );
        }
    }
    let f = fixture(1);
    let captured = f.store.capture_work_plan_agent_guidance(&f.scope).unwrap();
    let db = rusqlite::Connection::open(f.store.directory().join("project.sqlite3")).unwrap();
    db.execute(
        "UPDATE application_plans SET expires_at=1 WHERE plan_id=?1",
        [f.plan.plan_id.to_string()],
    )
    .unwrap();
    assert_eq!(
        f.store
            .check_work_plan_agent_guidance(&f.scope, &captured)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    drop(db);
    let f = fixture(1);
    let captured = f.store.capture_work_plan_agent_guidance(&f.scope).unwrap();
    let directory = f.store.directory().to_owned();
    f.store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(
        reopened
            .check_work_plan_agent_guidance(&f.scope, &captured)
            .unwrap_err()
            .stage,
        "work-plan-agent-session"
    );
}
