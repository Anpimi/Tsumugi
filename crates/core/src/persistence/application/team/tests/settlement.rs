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

fn original(plan: &WorkPlan, units: &[ExecutionId]) -> PublishTeamDiscussion {
    let basis = plan.selection_basis.iter().find(|basis| basis.unit_id == units[0]).unwrap();
    PublishTeamDiscussion {
        post_id: ExecutionId::new(),
        target: TeamDiscussionTarget {
            unit_id: basis.unit_id,
            locale: plan.locale.clone(),
            source_snapshot_id: basis.source_snapshot_id,
            source_revision_id: basis.source_revision_id,
        },
        kind: TeamDiscussionKind::Note,
        body: "Keep the complete original human reason.".into(),
        references: vec![],
        reply_to: None,
        supersedes: None,
    }
}

#[test]
fn missing_publications_need_a_later_generation_and_late_writes_stay_closed() {
    for command in [WorkPlanCommand::Pause, WorkPlanCommand::Stop, WorkPlanCommand::TakeOver] {
        let (_temp, mut store, plan, scope, units) = setup();
        let write = original(&plan, &units);
        assert_eq!(store.read_human_team_publication_action(plan.project_id, &scope.lease, "local-user", &write).unwrap(), None);
        assert!(matches!(pure(&store, || store.human_team_publication_settlement(
            plan.project_id, &scope.lease, "local-user", &write,
        )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
        let closed = store.control_work_plan(&control(&plan, scope.lease.generation.get(), command)).unwrap();
        let settled = pure(&store, || store.human_team_publication_settlement(
            plan.project_id, &scope.lease, "local-user", &write,
        )).unwrap();
        assert_eq!(settled.project_id, plan.project_id);
        assert_eq!(settled.plan_id, plan.plan_id);
        assert_eq!(settled.lease, closed.lease);
        assert_eq!(settled.state, closed.state);
        assert_eq!(settled.outcome, WorkPlanRequestOutcome::FencedNotApplied);
        assert!(store.publish_human_team_discussion(&scope, "local-user", &write).is_err());
        assert_eq!(store.read_human_team_publication_action(plan.project_id, &scope.lease, "local-user", &write).unwrap(), None);

        // State alone is insufficient, even at the current stopped generation.
        assert!(matches!(pure(&store, || store.human_team_publication_settlement(
            plan.project_id, &closed.lease, "local-user", &write,
        )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
        let future = AutomationLease { generation: closed.lease.generation.next().unwrap(), ..closed.lease };
        assert!(matches!(pure(&store, || store.human_team_publication_settlement(
            plan.project_id, &future, "local-user", &write,
        )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
    }
}

#[test]
fn publication_settlement_prefers_exact_receipts_and_rejects_changed_tuples_after_revocation() {
    let (_temp, mut store, plan, scope, units) = setup();
    let write = original(&plan, &units);
    let recorded = store.publish_human_team_discussion(&scope, "local-user", &write).unwrap();
    let mut options = PlanOptions::default();
    options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV1 {});
    let other = store.prepare_work_plan(Some(config()), "zh-CN", &units, options).unwrap();
    let mut permission = consent(&other);
    permission.effects = other.authorization_effects().unwrap();
    store.authorize_work_plan(&other, &permission).unwrap();
    store.control_work_plan(&control(&plan, scope.lease.generation.get(), WorkPlanCommand::Stop)).unwrap();
    let execution_unknown_before = store.execution_unknown.swap(true, std::sync::atomic::Ordering::AcqRel);
    assert_eq!(pure(&store, || store.human_team_publication_settlement(
        plan.project_id, &scope.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Recorded { receipt: recorded.clone() });

    for changed in [
        PublishTeamDiscussion { body: "A different human reason".into(), ..write.clone() },
        PublishTeamDiscussion { target: TeamDiscussionTarget { unit_id: ExecutionId::new(), ..write.target.clone() }, ..write.clone() },
        PublishTeamDiscussion { reply_to: Some(ExecutionId::new()), ..write.clone() },
    ] {
        assert_eq!(pure(&store, || store.human_team_publication_settlement(
            plan.project_id, &scope.lease, "local-user", &changed,
        )).unwrap_err().code, ErrorCode::ResultMismatch);
    }
    assert_eq!(pure(&store, || store.human_team_publication_settlement(
        plan.project_id, &scope.lease, "another-user", &write,
    )).unwrap_err().code, ErrorCode::ResultMismatch);
    let changed_lease = AutomationLease { generation: scope.lease.generation.next().unwrap(), ..scope.lease };
    assert_eq!(pure(&store, || store.human_team_publication_settlement(
        plan.project_id, &changed_lease, "local-user", &write,
    )).unwrap_err().code, ErrorCode::ResultMismatch);
    let changed_plan = AutomationLease { plan_id: other.plan_id, ..scope.lease };
    assert_eq!(pure(&store, || store.human_team_publication_settlement(
        plan.project_id, &changed_plan, "local-user", &write,
    )).unwrap_err().code, ErrorCode::ResultMismatch);

    assert!(store.execution_unknown.load(std::sync::atomic::Ordering::Acquire));
    // Restore only the synthetic flag injected above, preserving any prior unknown.
    store.execution_unknown.store(execution_unknown_before, std::sync::atomic::Ordering::Release);
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    assert_eq!(pure(&reopened, || reopened.human_team_publication_settlement(
        plan.project_id, &scope.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Recorded { receipt: recorded });
}

#[test]
fn expiry_does_not_turn_publication_absence_into_a_fence() {
    let (_temp, store, plan, scope, units) = setup();
    let write = original(&plan, &units);
    // Model only an elapsed deadline; no durable generation has advanced.
    store.connection().unwrap().execute("UPDATE application_plans SET expires_at=1 WHERE plan_id=?1", [plan.plan_id.to_string()]).unwrap();
    store.execution_unknown.store(true, std::sync::atomic::Ordering::Release);
    assert!(matches!(pure(&store, || store.human_team_publication_settlement(
        plan.project_id, &scope.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
    assert_eq!(pure(&store, || store.human_team_publication_settlement(
        ExecutionId::new(), &scope.lease, "local-user", &write,
    )).unwrap_err().code, ErrorCode::Unauthorized);
}

#[test]
fn reopening_keeps_missing_publications_uncertain_without_restoring_a_scope() {
    let (_temp, store, plan, scope, units) = setup();
    let write = original(&plan, &units);
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory).unwrap();
    assert!(matches!(pure(&reopened, || reopened.human_team_publication_settlement(
        plan.project_id, &scope.lease, "local-user", &write,
    )).unwrap().outcome, WorkPlanRequestOutcome::Pending));
}

#[test]
fn publication_settlement_does_not_trust_a_generation_without_its_control_history() {
    let (_temp, store, plan, scope, units) = setup();
    let write = original(&plan, &units);
    store.connection().unwrap().execute("UPDATE application_plans SET generation=2 WHERE plan_id=?1", [plan.plan_id.to_string()]).unwrap();
    assert_eq!(pure(&store, || store.human_team_publication_settlement(
        plan.project_id, &scope.lease, "local-user", &write,
    )).unwrap_err().code, ErrorCode::CorruptLedger);
}
