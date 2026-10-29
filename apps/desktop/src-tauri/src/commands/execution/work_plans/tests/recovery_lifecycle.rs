//! Recovery request settlement and Host drainage need no live member service.
use super::*;
use recovery::{
    RecoveryPreparation, WorkPlanTeamRecoveryPrepareOriginal,
    WorkPlanTeamRecoverySettlementOriginal,
};
use tsumugi_core::application::{PrepareTeamRecovery, TeamHumanWork, TeamWorkKind};

fn pending_preparation() -> (Fixture, WorkPlanTeamRecoveryPrepareOriginal, PackageWork) {
    let fixture = Fixture::create();
    let unit = fixture.unit;
    let (original, work) = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let config = AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic-undispatched-recovery".into(),
                credential_env: String::new(),
                max_requests: 4,
                max_retries: 0,
                concurrency: 1,
                ..AiConfig::default()
            };
            let member = ExecutionId::new();
            let mut options = serde_json::to_value(PlanOptions::default()).unwrap();
            options["teamDiscussions"] = json!({"profile":"current-plan-2"});
            options["teamExecution"] = json!({"profile":"bounded-team-1",
            "initialMemberId":member,"initialUnitId":unit,
            "members":[{"memberId":member,"roleVersionId":ExecutionId::new(),
                "displayName":"Synthetic member","role":"Only captured work.",
                "config":config,"unitIds":[unit],"toolHandles":[],"kinds":["translation"]}],
            "limits":{"maxActivations":4,"maxConcurrency":1,"maxNoProgress":4}});
            let plan = store
                .prepare_work_plan(
                    Some(config),
                    "zh-CN",
                    &[unit],
                    serde_json::from_value(options).unwrap(),
                )
                .unwrap();
            let authorization = AuthorizeWorkPlan {
                action_id: ExecutionId::new(),
                plan_digest: plan.digest.clone(),
                confirmed: true,
                effects: plan.authorization_effects().unwrap(),
                expires_at: expiry().parse().unwrap(),
            };
            let receipt = store.authorize_work_plan(&plan, &authorization).unwrap();
            let root = store
                .prepare_team_start(receipt.lease, authorization.action_id)
                .unwrap();
            host.runtime.submit_team_work(store, &root).unwrap();
            store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: plan.plan_id,
                    expected_generation: receipt.lease.generation,
                    command: WorkPlanCommand::Pause,
                    confirmed: false,
                    expires_at: None,
                })
                .unwrap();
            host.runtime.tick(store).unwrap();
            let state = store
                .read_team_recovery_state(plan.project_id, plan.plan_id)
                .unwrap();
            assert_eq!(state.budget.dispatched, 0);
            let basis = &plan.selection_basis[0];
            let original = WorkPlanTeamRecoveryPrepareOriginal {
                project_id: plan.project_id,
                preparation_id: ExecutionId::new(),
                recovery: PrepareTeamRecovery {
                    project_id: plan.project_id,
                    plan_id: plan.plan_id,
                    expected_lease: state.lease,
                    expected_effective_version: state.effective_version,
                    members: plan
                        .options
                        .team_execution
                        .as_ref()
                        .unwrap()
                        .members()
                        .to_vec(),
                    work: TeamHumanWork {
                        work_id: ExecutionId::new(),
                        member_id: member,
                        kind: TeamWorkKind::Translation,
                        instructions: "Preserve the original unknown preparation.".into(),
                        post_ids: vec![],
                        prior_work: state.unresolved_work,
                        target: tsumugi_core::application::TeamDiscussionTarget {
                            unit_id: basis.unit_id,
                            locale: plan.locale.clone(),
                            source_snapshot_id: basis.source_snapshot_id,
                            source_revision_id: basis.source_revision_id,
                        },
                    },
                },
            };
            let work = host.begin_plan_work(plan.plan_id, Vec::new()).unwrap();
            host.work_plans.recovery = Some(RecoveryPreparation::new(
                original.preparation_id,
                original.recovery.clone(),
                Cancellation::default(),
            ));
            (original, work)
        });
    (fixture, original, work)
}

#[test]
fn registered_recovery_preparation_closure_waits_for_original_callbacks() {
    let (fixture, original, work) = pending_preparation();
    let request = serde_json::to_value(&original).unwrap();
    let before = fixture.bytes();
    let observed = fixture
        .call("read_work_plan_team_recovery_preparation", request.clone())
        .unwrap();
    assert_eq!(observed["request"], request);
    assert_eq!(observed["outcome"]["kind"], "pending");
    assert_eq!(observed["hostCallbacksDrained"], false);
    assert_eq!(fixture.bytes(), before);
    let closing = fixture
        .call("close_work_plan_team_recovery_preparation", request.clone())
        .unwrap();
    assert_eq!(closing["outcome"]["kind"], "draining");
    assert_eq!(closing["lease"], json!(original.recovery.expected_lease));
    drop(work);
    let closed = fixture
        .call("close_work_plan_team_recovery_preparation", request.clone())
        .unwrap();
    assert_eq!(closed["outcome"]["kind"], "closed");
    assert_eq!(closed["hostCallbacksDrained"], true);
    assert_eq!(
        closed["lease"],
        json!(original.recovery.expected_lease),
        "local closure is not a permanent generation fence"
    );
    let replay = fixture
        .call("prepare_work_plan_team_recovery", request.clone())
        .unwrap_err();
    assert_eq!(replay["code"], "dependency-conflict");
    assert_eq!(
        fixture
            .call("read_work_plan_team_recovery_preparation", request)
            .unwrap()["outcome"]["kind"],
        "closed"
    );
    assert_eq!(fixture.bytes(), before);
}

#[test]
fn registered_recovery_preparation_not_found_preserves_newer_slot_and_needs_a_core_fence() {
    let (fixture, original, work) = pending_preparation();
    drop(work);
    let newer = original.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let host = sessions
                .active
                .as_mut()
                .unwrap()
                .execution
                .as_mut()
                .unwrap();
            let mut request = newer.recovery;
            request
                .work
                .instructions
                .push_str(" A newer same-id draft.");
            host.work_plans.clear_recovery();
            host.work_plans.recovery = Some(RecoveryPreparation::new(
                newer.preparation_id,
                request,
                Cancellation::default(),
            ));
        });
    let request = serde_json::to_value(&original).unwrap();
    let before = fixture.bytes();
    let missing = fixture
        .call("close_work_plan_team_recovery_preparation", request.clone())
        .unwrap();
    assert_eq!(missing["outcome"]["kind"], "pending");
    assert_eq!(missing["hostCallbacksDrained"], true);
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        assert!(
            !sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap()
                .work_plans
                .recovery
                .as_ref()
                .unwrap()
                .stop
                .is_requested()
        );
    });
    assert_eq!(fixture.bytes(), before);
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_mut().unwrap().execution.take();
    });
    assert_eq!(
        fixture
            .call("read_work_plan_team_recovery_preparation", request.clone())
            .unwrap()["outcome"]["kind"],
        "pending"
    );
    fixture.call("control_work_plan", json!({"planId":original.recovery.plan_id,
        "actionId":ExecutionId::new(),"expectedGeneration":original.recovery.expected_lease.generation,
        "command":"take-over","confirmed":false,"expiresAt":null,"checkerExecutions":[],
        "toolExecution":false,"applicationToolExecutions":[]})).unwrap();
    let fenced = fixture
        .call("read_work_plan_team_recovery_preparation", request)
        .unwrap();
    assert_eq!(fenced["outcome"]["kind"], "fenced-not-applied");
    assert_eq!(fenced["hostCallbacksDrained"], true);
}

#[test]
fn registered_recovery_authorization_settlement_is_pure_and_binds_original_choices() {
    let (fixture, original, work) = pending_preparation();
    drop(work);
    let preparation = original.clone();
    let authorization = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let prepared = host
                .runtime
                .prepare_team_recovery(store, &preparation.recovery)
                .unwrap();
            let authorization = WorkPlanTeamRecoverySettlementOriginal {
                project_id: preparation.project_id,
                preparation_id: preparation.preparation_id,
                plan_id: preparation.recovery.plan_id,
                base_lease: preparation.recovery.expected_lease,
                recovery: tsumugi_core::application::AuthorizeTeamRecovery {
                    action_id: ExecutionId::new(),
                    digest: prepared.preview().digest.clone(),
                    confirmed: true,
                    effects: prepared.plan().authorization_effects().unwrap(),
                },
                checker_executions: vec![],
                tool_execution: false,
                application_tool_executions: vec![],
            };
            host.runtime
                .authorize_team_recovery(store, &prepared, &authorization.recovery)
                .unwrap();
            authorization
        });
    let request = serde_json::to_value(&authorization).unwrap();
    let before = fixture.bytes();
    let proof = fixture
        .call("read_work_plan_team_recovery_settlement", request.clone())
        .unwrap();
    assert_eq!(proof["request"], request);
    assert_eq!(proof["settlement"]["outcome"]["kind"], "recorded");
    assert_eq!(
        proof["settlement"]["outcome"]["receipt"]["baseLease"],
        json!(original.recovery.expected_lease)
    );
    assert!(proof["request"].get("sessionToken").is_none());
    let preparation = original.clone();
    let saved = authorization.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_ref().unwrap();
            assert!(recovery::observe_settlement(&active.store, &preparation, &saved).is_ok());
            let mut changed = preparation;
            changed
                .recovery
                .work
                .instructions
                .push_str(" Another captured request.");
            assert_eq!(
                recovery::observe_settlement(&active.store, &changed, &saved)
                    .unwrap_err()
                    .code,
                ErrorCode::ResultMismatch
            );
        });
    let mut wrong = request.clone();
    wrong["toolExecution"] = json!(true);
    assert!(
        fixture
            .call("read_work_plan_team_recovery_settlement", wrong)
            .is_err()
    );
    let mut absent = request.clone();
    absent["recovery"]["actionId"] = json!(ExecutionId::new());
    assert_eq!(
        fixture
            .call("read_work_plan_team_recovery_settlement", absent)
            .unwrap()["settlement"]["outcome"]["kind"],
        "fenced-not-applied"
    );
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_mut().unwrap().execution.take();
    });
    assert_eq!(
        fixture
            .call("read_work_plan_team_recovery_settlement", request)
            .unwrap(),
        proof
    );
    assert_eq!(fixture.bytes(), before);
}
