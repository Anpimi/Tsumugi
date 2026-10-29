use super::*;

fn files(store: &ProjectStore) -> std::collections::BTreeMap<std::ffi::OsString, Vec<u8>> {
    std::fs::read_dir(store.directory())
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_file())
        .map(|entry| (entry.file_name(), std::fs::read(entry.path()).unwrap()))
        .collect()
}

fn pure<T>(store: &ProjectStore, read: impl FnOnce() -> T) -> T {
    let before = files(store);
    let changes = store.connection().unwrap().total_changes();
    let reconciling = store.is_reconciling();
    let authority = store
        .planning_authority_revision
        .load(std::sync::atomic::Ordering::Acquire);
    let value = read();
    assert_eq!(files(store), before);
    assert_eq!(store.connection().unwrap().total_changes(), changes);
    assert_eq!(store.is_reconciling(), reconciling);
    assert_eq!(
        store.planning_authority_revision.load(std::sync::atomic::Ordering::Acquire),
        authority
    );
    value
}

fn revoke(store: &mut ProjectStore, plan: &WorkPlan, lease: AutomationLease, command: WorkPlanCommand) -> WorkPlanReceipt {
    store.control_work_plan(&ControlWorkPlan {
        action_id: ExecutionId::new(),
        plan_id: plan.plan_id,
        expected_generation: lease.generation,
        command,
        confirmed: false,
        expires_at: None,
    }).unwrap()
}

#[test]
fn missing_messages_need_a_later_generation_and_late_submissions_are_rejected() {
    for command in [WorkPlanCommand::Pause, WorkPlanCommand::Stop, WorkPlanCommand::TakeOver] {
        let (_temp, mut store, plan, receipt, _prepared, _request, author, members) = setup(12);
        let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
        let write = guidance(&author, &members[0]);
        assert_eq!(store.read_human_team_message_action(plan.project_id, &receipt.lease, "local-user", &write).unwrap(), None);
        assert!(matches!(pure(&store, || store.human_team_message_settlement(
            plan.project_id, &receipt.lease, "local-user", &write,
        )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
        let closed = revoke(&mut store, &plan, receipt.lease, command);
        let settled = pure(&store, || store.human_team_message_settlement(
            plan.project_id, &receipt.lease, "local-user", &write,
        )).unwrap();
        assert_eq!(settled.lease, closed.lease);
        assert_eq!(settled.state, closed.state);
        assert_eq!(settled.outcome, WorkPlanRequestOutcome::FencedNotApplied);
        assert!(store.send_human_team_message(&scope, "local-user", &write).is_err());
        assert_eq!(store.read_human_team_message_action(plan.project_id, &receipt.lease, "local-user", &write).unwrap(), None);
        assert!(matches!(pure(&store, || store.human_team_message_settlement(
            plan.project_id, &closed.lease, "local-user", &write,
        )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
        let future = AutomationLease { generation: closed.lease.generation.next().unwrap(), ..closed.lease };
        assert!(matches!(pure(&store, || store.human_team_message_settlement(
            plan.project_id, &future, "local-user", &write,
        )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
    }
}

#[test]
fn message_settlement_prefers_recorded_identity_and_keeps_wrong_tuples_as_conflicts() {
    let (_temp, mut store, plan, receipt, _prepared, _request, author, members) = setup(12);
    let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
    let write = guidance(&author, &members[0]);
    let accepted = store.send_human_team_message(&scope, "local-user", &write).unwrap();
    let other = store.prepare_work_plan(Some(config()), "zh-CN", &members[0].unit_ids, PlanOptions::default()).unwrap();
    store.authorize_work_plan(&other, &consent(&other)).unwrap();
    revoke(&mut store, &plan, receipt.lease, WorkPlanCommand::Stop);
    let execution_unknown_before = store.execution_unknown.swap(true, std::sync::atomic::Ordering::AcqRel);
    assert_eq!(pure(&store, || store.human_team_message_settlement(
        plan.project_id, &receipt.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Recorded { receipt: accepted.clone() });
    for changed in [
        SendHumanTeamMessage { body: "A different original body".into(), ..write.clone() },
        SendHumanTeamMessage { recipient_member_id: members[1].member_id, ..write.clone() },
        SendHumanTeamMessage { expected_recipient_role_version_id: ExecutionId::new(), ..write.clone() },
        SendHumanTeamMessage { target: TeamDiscussionTarget { source_revision_id: ExecutionId::new(), ..write.target.clone() }, ..write.clone() },
    ] {
        assert_eq!(pure(&store, || store.human_team_message_settlement(
            plan.project_id, &receipt.lease, "local-user", &changed,
        )).unwrap_err().code, ErrorCode::ResultMismatch);
    }
    assert_eq!(pure(&store, || store.human_team_message_settlement(
        plan.project_id, &receipt.lease, "another-user", &write,
    )).unwrap_err().code, ErrorCode::ResultMismatch);
    let wrong_lease = AutomationLease { generation: receipt.lease.generation.next().unwrap(), ..receipt.lease };
    assert_eq!(pure(&store, || store.human_team_message_settlement(
        plan.project_id, &wrong_lease, "local-user", &write,
    )).unwrap_err().code, ErrorCode::ResultMismatch);
    let wrong_plan = AutomationLease { plan_id: other.plan_id, ..receipt.lease };
    assert_eq!(pure(&store, || store.human_team_message_settlement(
        plan.project_id, &wrong_plan, "local-user", &write,
    )).unwrap_err().code, ErrorCode::ResultMismatch);

    assert!(store.execution_unknown.load(std::sync::atomic::Ordering::Acquire));
    // Restore only the synthetic flag injected above, preserving any prior unknown.
    store.execution_unknown.store(execution_unknown_before, std::sync::atomic::Ordering::Release);
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    assert_eq!(pure(&reopened, || reopened.human_team_message_settlement(
        plan.project_id, &receipt.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Recorded { receipt: accepted });
}

#[test]
fn expiry_does_not_prove_a_missing_message_was_never_applied() {
    let (_temp, store, plan, receipt, _prepared, _request, author, members) = setup(12);
    let write = guidance(&author, &members[0]);
    // Expiry is an observation, not the durable generation fence.
    store.connection().unwrap().execute("UPDATE application_plans SET expires_at=1 WHERE plan_id=?1", [plan.plan_id.to_string()]).unwrap();
    store.execution_unknown.store(true, std::sync::atomic::Ordering::Release);
    assert!(matches!(pure(&store, || store.human_team_message_settlement(
        plan.project_id, &receipt.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
    assert_eq!(pure(&store, || store.human_team_message_settlement(
        ExecutionId::new(), &receipt.lease, "local-user", &write,
    )).unwrap_err().code, ErrorCode::Unauthorized);
}

#[test]
fn reopening_does_not_prove_a_missing_message_was_never_applied() {
    let (_temp, store, plan, receipt, _prepared, _request, author, members) = setup(12);
    let write = guidance(&author, &members[0]);
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    assert!(matches!(pure(&reopened, || reopened.human_team_message_settlement(
        plan.project_id, &receipt.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
}

#[test]
fn message_settlement_audits_the_control_history_before_proving_absence() {
    let (_temp, store, plan, receipt, _prepared, _request, author, members) = setup(12);
    let write = guidance(&author, &members[0]);
    store.connection().unwrap().execute("UPDATE application_plans SET generation=2 WHERE plan_id=?1", [plan.plan_id.to_string()]).unwrap();
    assert_eq!(pure(&store, || store.human_team_message_settlement(
        plan.project_id, &receipt.lease, "local-user", &write,
    )).unwrap_err().code, ErrorCode::CorruptLedger);
}
