use super::*;
use crate::execution::RecoveryPolicy;
use crate::persistence::application::tests::{config, consent, fixture};

fn control(plan: &WorkPlan, generation: u64, command: WorkPlanCommand) -> ControlWorkPlan {
    ControlWorkPlan {
        action_id: ExecutionId::new(),
        plan_id: plan.plan_id,
        expected_generation: Revision::new(generation).unwrap(),
        command,
        confirmed: command == WorkPlanCommand::Continue,
        expires_at: (command == WorkPlanCommand::Continue).then(|| consent(plan).expires_at),
    }
}

fn files(store: &ProjectStore) -> BTreeMap<std::ffi::OsString, Vec<u8>> {
    std::fs::read_dir(store.directory())
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_file())
        .map(|entry| (entry.file_name(), std::fs::read(entry.path()).unwrap()))
        .collect()
}

fn pure_read(store: &ProjectStore, plan: &WorkPlan) -> WorkPlanRunView {
    let before = files(store);
    let changes = store.connection().unwrap().total_changes();
    let reconciling = store.is_reconciling();
    let value = store
        .read_work_plan_run(plan.project_id, plan.plan_id)
        .unwrap();
    assert_eq!(files(store), before);
    assert_eq!(store.connection().unwrap().total_changes(), changes);
    assert_eq!(store.is_reconciling(), reconciling);
    value
}

#[test]
fn run_view_tracks_started_generations_and_original_cumulative_budget_without_writes() {
    let (_directory, mut store, units) = fixture();
    let plan = store
        .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
        .unwrap();
    let authorization = consent(&plan);
    let receipt = store.authorize_work_plan(&plan, &authorization).unwrap();
    let input = FixedInput::capture(receipt.input.clone().unwrap()).unwrap();
    let root = input.envelope().task_id;
    let initial = pure_read(&store, &plan);
    assert_eq!(initial.plan_digest, plan.digest);
    assert_eq!(initial.budget_root_task_id, Some(root));
    assert!(initial.last_start.is_none() && initial.budget.is_none());
    store.enqueue_execution(&input).unwrap();
    let dispatch = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    store
        .reserve_provider_request(&dispatch, ExecutionId::new(), config().max_requests)
        .unwrap();
    let started = pure_read(&store, &plan);
    assert_eq!(
        started.last_start.as_ref().unwrap().action_id,
        authorization.action_id
    );
    assert_eq!(
        started.last_start.as_ref().unwrap().attempt_id,
        input.envelope().attempt_id
    );
    assert_eq!(started.budget.as_ref().unwrap().dispatched, 1);
    store
        .control_work_plan(&control(&plan, 1, WorkPlanCommand::Pause))
        .unwrap();
    let paused = pure_read(&store, &plan);
    assert_eq!(paused.state, WorkPlanState::Paused);
    assert_eq!(paused.last_start, started.last_start);
    let continuing = control(&plan, 2, WorkPlanCommand::Continue);
    let continued = store.control_work_plan(&continuing).unwrap();
    assert_eq!(continued.parent_task, Some(root));
    let child = FixedInput::capture(continued.input.unwrap()).unwrap();
    assert_ne!(child.envelope().attempt_id, input.envelope().attempt_id);
    assert_ne!(child.envelope().task_id, root);
    let unstarted = pure_read(&store, &plan);
    assert_eq!(unstarted.lease.generation.get(), 3);
    assert_eq!(unstarted.last_start, started.last_start);
    assert_eq!(unstarted.budget.as_ref().unwrap().dispatched, 1);
    store
        .enqueue_execution_with_policy(&child, RecoveryPolicy::ExternalUnknown, Some(root))
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            child.envelope().attempt_id,
            child.envelope().items[0].item_id,
        )
        .unwrap();
    store
        .reserve_provider_request(&dispatch, ExecutionId::new(), config().max_requests)
        .unwrap();
    let latest = pure_read(&store, &plan);
    let last = latest.last_start.as_ref().unwrap();
    assert_eq!(last.action_id, continuing.action_id);
    assert_eq!(last.expected_generation.get(), 3);
    assert_eq!(last.task_id, child.envelope().task_id);
    assert_eq!(last.attempt_id, child.envelope().attempt_id);
    assert_eq!(latest.budget_root_task_id, Some(root));
    assert_eq!(latest.budget.as_ref().unwrap().dispatched, 2);
    assert_eq!(
        store
            .provider_budget(child.envelope().task_id)
            .unwrap()
            .unwrap()
            .dispatched,
        1
    );
    store
        .control_work_plan(&control(&plan, 3, WorkPlanCommand::Stop))
        .unwrap();
    store
        .execution_unknown
        .store(true, std::sync::atomic::Ordering::Release);
    let stopped = pure_read(&store, &plan);
    assert_eq!(stopped.state, WorkPlanState::Stopped);
    assert_eq!(stopped.last_start, latest.last_start);
    assert!(
        store.is_reconciling(),
        "history reads do not reconcile uncertain business execution"
    );
    store
        .execution_unknown
        .store(false, std::sync::atomic::Ordering::Release);
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(pure_read(&reopened, &plan), stopped);
}

#[test]
fn unstarted_authorizations_reusing_a_root_attempt_do_not_hide_the_later_exact_start() {
    let (_directory, mut store, units) = fixture();
    let plan = store
        .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
        .unwrap();
    let original = store.authorize_work_plan(&plan, &consent(&plan)).unwrap();
    store
        .control_work_plan(&control(&plan, 1, WorkPlanCommand::Pause))
        .unwrap();
    let request = control(&plan, 2, WorkPlanCommand::Continue);
    let resumed = store.control_work_plan(&request).unwrap();
    assert_eq!(
        original.input.as_ref().unwrap().attempt_id,
        resumed.input.as_ref().unwrap().attempt_id
    );
    assert_eq!(
        original.input.as_ref().unwrap().task_id,
        resumed.input.as_ref().unwrap().task_id
    );
    assert!(pure_read(&store, &plan).last_start.is_none());
    let input = FixedInput::capture(resumed.input.unwrap()).unwrap();
    store.enqueue_execution(&input).unwrap();
    let view = pure_read(&store, &plan);
    assert_eq!(
        view.last_start.as_ref().unwrap().action_id,
        request.action_id
    );
    assert_eq!(
        view.last_start.as_ref().unwrap().expected_generation.get(),
        3
    );
    assert_eq!(
        view.last_start.as_ref().unwrap().attempt_id,
        input.envelope().attempt_id
    );
    assert_eq!(view.budget.as_ref().unwrap().dispatched, 0);
}

#[test]
fn run_view_rejects_foreign_projects_and_corrupt_action_or_execution_mapping() {
    let (_directory, mut store, units) = fixture();
    let plan = store
        .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
        .unwrap();
    let authorization = consent(&plan);
    let receipt = store.authorize_work_plan(&plan, &authorization).unwrap();
    let input = FixedInput::capture(receipt.input.unwrap()).unwrap();
    store.enqueue_execution(&input).unwrap();
    store.control_work_plan(&control(&plan, 1, WorkPlanCommand::Pause)).unwrap();
    let other = store
        .prepare_work_plan(Some(config()), "zh-CN", &units, PlanOptions::default())
        .unwrap();
    let other_receipt = store.authorize_work_plan(&other, &consent(&other)).unwrap();
    let other_input = FixedInput::capture(other_receipt.input.unwrap()).unwrap();
    store.enqueue_execution(&other_input).unwrap();
    let before = files(&store);
    assert_eq!(
        store
            .read_work_plan_run(ExecutionId::new(), plan.plan_id)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(files(&store), before);
    let c = store.connection().unwrap();
    for (column, wrong, original) in [
        (
            "plan_id",
            other.plan_id.to_string(),
            plan.plan_id.to_string(),
        ),
        ("generation", "2".into(), "1".into()),
        (
            "root_task",
            other_input.envelope().task_id.to_string(),
            input.envelope().task_id.to_string(),
        ),
    ] {
        c.execute(
            &format!("UPDATE application_executions SET {column}=?2 WHERE attempt_id=?1"),
            params![input.envelope().attempt_id.to_string(), wrong],
        )
        .unwrap();
        let before = files(&store);
        assert_eq!(
            store
                .read_work_plan_run(plan.project_id, plan.plan_id)
                .unwrap_err()
                .code,
            ErrorCode::CorruptLedger
        );
        assert_eq!(files(&store), before);
        c.execute(
            &format!("UPDATE application_executions SET {column}=?2 WHERE attempt_id=?1"),
            params![input.envelope().attempt_id.to_string(), original],
        )
        .unwrap();
    }
    let digest: String = c
        .query_row(
            "SELECT receipt_digest FROM application_actions WHERE action_id=?1",
            [authorization.action_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    c.execute(
        "UPDATE application_actions SET receipt_digest=?2 WHERE action_id=?1",
        params![authorization.action_id.to_string(), "0".repeat(64)],
    )
    .unwrap();
    let before = files(&store);
    assert_eq!(
        store
            .read_work_plan_run(plan.project_id, plan.plan_id)
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
    assert_eq!(files(&store), before);
    c.execute(
        "UPDATE application_actions SET receipt_digest=?2 WHERE action_id=?1",
        params![authorization.action_id.to_string(), digest],
    )
    .unwrap();
    assert_eq!(
        pure_read(&store, &plan).last_start.unwrap().action_id,
        authorization.action_id
    );
}
