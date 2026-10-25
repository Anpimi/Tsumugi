use super::*;
use crate::ai::AiConfig;

fn prepare(
    store: &ProjectStore,
    units: &[ExecutionId],
    root: AiConfig,
    configs: [AiConfig; 2],
) -> Result<WorkPlan, ExecutionError> {
    let members = configs
        .into_iter()
        .enumerate()
        .map(|(i, config)| TeamExecutionMember {
            member_id: ExecutionId::new(),
            role_version_id: ExecutionId::new(),
            display_name: format!("Member {i}"),
            role: "Work within the captured scope.".into(),
            config,
            unit_ids: units.to_vec(),
            tool_handles: vec![],
            kinds: vec![TeamWorkKind::Translation, TeamWorkKind::Review],
        })
        .collect::<Vec<_>>();
    let mut options = PlanOptions::default();
    let max_activations = root.max_requests.min(6);
    options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV2 {});
    options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 {
        initial_member_id: members[0].member_id,
        initial_unit_id: units[0],
        members,
        limits: TeamExecutionLimits {
            max_activations,
            max_concurrency: 1,
            max_no_progress: 1,
        },
    });
    store.prepare_work_plan(Some(root), "zh-CN", units, options)
}

#[test]
fn team_work_budget_captures_member_rounds_retries_and_the_existing_item_ceiling() {
    for (root_limit, a, b, expected) in [
        (20, (1, 60, 0), (4, 20, 1), 208_000),
        (3, (1, 60, 0), (3, 60, 0), 198_000),
        (20, (1, 1, 0), (2, 5, 0), 22_000),
        (300, (1, 60, 0), (300, 120, 2), 600_000),
    ] {
        let (_temp, store, units) = fixture();
        let mut root = config();
        root.max_requests = root_limit;
        let configs = [a, b].map(|(requests, seconds, retries)| {
            let mut member = root.clone();
            member.max_requests = requests;
            member.timeout_seconds = seconds;
            member.max_retries = retries;
            member
        });
        let direct = store
            .preview_ai(root.clone(), "zh-CN", &units)
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        assert_eq!(direct.envelope().limits.timeout_ms, 66_000);
        let plan = prepare(&store, &units, root, configs).unwrap();
        assert_eq!(plan.execution_input().unwrap().limits.timeout_ms, expected);
        assert_ne!(
            plan.execution_input().unwrap().limits,
            direct.envelope().limits
        );
        plan.validate().unwrap();
    }
}

#[test]
fn team_work_budget_keeps_root_request_admission_and_derived_limits() {
    let (_temp, store, plan, _receipt, root, _request, author, members) = setup(3);
    assert_eq!(plan.execution_input().unwrap().limits.timeout_ms, 264_000);
    assert_eq!(
        root.input().envelope().limits,
        plan.execution_input().unwrap().limits
    );
    let child = store
        .prepare_team_work(&author, &work_request(&author, members[1].member_id))
        .unwrap();
    assert_eq!(
        child.input().envelope().limits,
        root.input().envelope().limits
    );
    let units = plan
        .selection_basis
        .iter()
        .map(|b| b.unit_id)
        .collect::<Vec<_>>();
    let mut root_config = config();
    root_config.max_requests = 2;
    let mut over_limit = root_config.clone();
    over_limit.max_requests = 3;
    assert_eq!(
        prepare(
            &store,
            &units,
            root_config.clone(),
            [root_config, over_limit]
        )
        .unwrap_err()
        .stage,
        "team-policy"
    );
}

#[test]
fn team_work_budget_keeps_historical_single_request_limits_valid_on_reopen() {
    let (_temp, mut store, units) = fixture();
    let root_config = config();
    let mut member = root_config.clone();
    member.max_requests = 4;
    let mut plan = prepare(&store, &units, root_config, [member.clone(), member]).unwrap();
    assert_eq!(plan.execution_input().unwrap().limits.timeout_ms, 264_000);
    // Reproduce the formerly captured plan, including its original digest.
    // This builder refreshes identity without invoking new team capture policy.
    plan.input.as_mut().unwrap().limits.timeout_ms = 66_000;
    let plan = plan.with_tools(None).unwrap();
    let original = plan.fixed_input().unwrap();
    let mut permission = consent(&plan);
    permission.effects = plan.authorization_effects().unwrap();
    let receipt = store.authorize_work_plan(&plan, &permission).unwrap();
    let root = store
        .prepare_team_root(receipt.lease, permission.action_id)
        .unwrap();
    store
        .enqueue_team_work(&root, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            root.receipt().attempt_id,
            root.input().envelope().items[0].item_id,
        )
        .unwrap();
    let author = store.capture_team_work_author(&dispatch).unwrap();
    let child = store
        .prepare_team_work(
            &author,
            &work_request(
                &author,
                plan.options.team_execution.as_ref().unwrap().members()[1].member_id,
            ),
        )
        .unwrap();
    store
        .enqueue_team_work(&child, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    assert_eq!(root.input().envelope().limits.timeout_ms, 66_000);
    assert_eq!(child.input().envelope().limits.timeout_ms, 66_000);
    let directory = store.directory().to_owned();
    store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    let saved = reopened.work_plan(plan.plan_id).unwrap();
    assert_eq!(saved.fixed_input().unwrap().bytes(), original.bytes());
    assert_eq!(
        reopened
            .execution_input(root.receipt().attempt_id)
            .unwrap()
            .bytes(),
        root.input().bytes()
    );
    assert_eq!(
        reopened
            .execution_input(child.receipt().attempt_id)
            .unwrap()
            .bytes(),
        child.input().bytes()
    );
}
