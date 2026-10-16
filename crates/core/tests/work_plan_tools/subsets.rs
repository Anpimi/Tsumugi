use super::*;

fn child(f: &Fixture, unit: ExecutionId, handles: Vec<ExecutionId>) -> WorkPlanAgentScope {
    f.store
        .delegate_work_plan_agent_scope(
            &f.scope,
            &AgentDelegationRequest {
                delegation_id: ExecutionId::new(),
                unit_ids: vec![unit],
                tool_handles: handles,
            },
        )
        .unwrap()
}
fn generation(unit: ExecutionId) -> AgentGenerationRequest {
    AgentGenerationRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        unit_ids: vec![unit],
    }
}
fn model_result(dispatch: &DispatchRequest, outcome: ExecutionState) -> FixedResult {
    let e = dispatch.input.envelope();
    let item = tsumugi_core::ai::item_payload(&dispatch.input, dispatch.item_id).unwrap();
    let output = json!({"unitId":item.unit_id,"targetLocale":item.target_locale,"text":"","usage":null,"requests":1,"usageIncomplete":false});
    FixedResult::capture(
        ResultEnvelope {
            project_id: e.project_id,
            attempt_id: e.attempt_id,
            item_id: dispatch.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: dispatch.dispatch_token,
            capability_id: e.capability_id.clone(),
            capability_version: e.capability_version.clone(),
            plugin: None,
            outcome,
            output: (outcome == ExecutionState::Succeeded).then_some(output),
            diagnostic: (outcome == ExecutionState::Failed).then(|| Diagnostic {
                code: "synthetic-failure".into(),
                retry_safe: false,
            }),
        },
        &dispatch.input,
        dispatch.dispatch_token,
    )
    .unwrap()
}

#[test]
fn agent_subset_generation_tool_and_guidance_use_the_same_exact_leaf() {
    let mut first = tool();
    let mut second = first.clone();
    first.handle = ExecutionId::new();
    second.handle = ExecutionId::new();
    let mut f = fixture_with_tool_runners(
        2,
        vec![first.clone(), second.clone()],
        vec![Arc::new(UncalledPlugin(first.clone()))],
    );
    let a = child(&f, f.units[0], vec![first.handle]);
    let b = child(&f, f.units[1], vec![second.handle]);
    assert_ne!(a.caller_id(), b.caller_id());
    assert_eq!(a.parent_task(), f.scope.parent_task());
    assert_eq!(a.lease(), f.scope.lease());
    for (scope, allowed) in [(&a, &first), (&b, &second)] {
        let capture = f.store.capture_work_plan_agent_guidance(scope).unwrap();
        assert_eq!(capture.tools(), &[allowed.clone()]);
        assert!(
            f.store
                .check_work_plan_agent_guidance(&f.scope, &capture)
                .is_err()
        );
        assert!(
            f.store
                .delegate_work_plan_agent_scope(
                    scope,
                    &AgentDelegationRequest {
                        delegation_id: ExecutionId::new(),
                        unit_ids: vec![f.units[0]],
                        tool_handles: vec![],
                    }
                )
                .is_err()
        );
    }
    let generating = generation(f.units[0]);
    let prepared = f
        .store
        .prepare_work_plan_agent_generation(&a, &generating)
        .unwrap();
    assert_eq!(
        f.store
            .read_work_plan_agent_generation_attempt(
                &a,
                &generating,
                prepared.digest(),
                false,
                0,
                1
            )
            .unwrap_err()
            .stage,
        "work-plan-agent-not-enqueued"
    );
    f.runtime
        .submit_work_plan_agent_generation(&mut f.store, &prepared)
        .unwrap();
    let queued = f
        .store
        .read_work_plan_agent_generation_attempt(&a, &generating, prepared.digest(), false, 0, 1)
        .unwrap();
    assert_eq!(queued.progress.total, 1);
    assert_eq!(queued.items[0].status.execution, ExecutionState::Queued);
    let dispatched = f
        .store
        .dispatch_execution_item(generating.attempt_id, queued.items[0].status.item_id)
        .unwrap();
    let running = f
        .store
        .read_work_plan_agent_generation_attempt(&a, &generating, prepared.digest(), true, 0, 1)
        .unwrap();
    assert_eq!(
        running.items[0].status.execution,
        ExecutionState::Dispatched
    );
    let result = model_result(&dispatched, ExecutionState::Succeeded);
    f.store.save_execution_result(&result).unwrap();
    let before = counts(&f.store);
    let sequence = f.store.execution_sequence().unwrap();
    let budget = f.store.provider_budget(a.parent_task()).unwrap().unwrap();
    let output = f
        .store
        .read_work_plan_agent_generation_output(
            &a,
            &generating,
            prepared.digest(),
            dispatched.item_id,
            result.envelope().result_id,
        )
        .unwrap();
    assert_eq!(output.bytes(), result.bytes());
    assert_eq!(output.envelope().output.as_ref().unwrap()["text"], "");
    tsumugi_core::ai::validate_output(prepared.input(), &output).unwrap();
    for wrong in [&f.scope, &b] {
        assert!(
            f.store
                .read_work_plan_agent_generation_attempt(
                    wrong,
                    &generating,
                    prepared.digest(),
                    false,
                    0,
                    1
                )
                .is_err()
        );
        assert!(
            f.store
                .read_work_plan_agent_generation_output(
                    wrong,
                    &generating,
                    prepared.digest(),
                    dispatched.item_id,
                    result.envelope().result_id
                )
                .is_err()
        );
    }
    for (offset, limit) in [(0, 0), (0, 101), (2, 1)] {
        assert!(
            f.store
                .read_work_plan_agent_generation_attempt(
                    &a,
                    &generating,
                    prepared.digest(),
                    false,
                    offset,
                    limit
                )
                .is_err()
        );
    }
    assert!(
        f.store
            .read_work_plan_agent_generation_output(
                &a,
                &generating,
                prepared.digest(),
                dispatched.item_id,
                ExecutionId::new()
            )
            .is_err()
    );
    assert!(
        f.store
            .read_work_plan_agent_generation_output(
                &a,
                &generating,
                prepared.digest(),
                ExecutionId::new(),
                result.envelope().result_id
            )
            .is_err()
    );
    assert_eq!(counts(&f.store), before);
    assert_eq!(f.store.execution_sequence().unwrap(), sequence);
    assert_eq!(
        f.store.provider_budget(a.parent_task()).unwrap().unwrap(),
        budget
    );
    let querying = AgentToolRequest {
        tool_handle: first.handle,
        ..request(&f, vec![f.units[0]])
    };
    let tool_prepared = f.store.prepare_work_plan_agent_tool(&a, &querying).unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &tool_prepared, &f.consent, ExecutionId::new())
        .unwrap();
    let dispatch = f
        .store
        .dispatch_execution_item(
            querying.attempt_id,
            tool_prepared.input().envelope().items[0].item_id,
        )
        .unwrap();
    let result = successful_plugin_result(&dispatch);
    f.store.save_execution_result(&result).unwrap();
    f.store
        .read_work_plan_agent_tool_output(
            &a,
            &querying,
            tool_prepared.input().digest(),
            dispatch.item_id,
            result.envelope().result_id,
        )
        .unwrap();
    for wrong in [&f.scope, &b] {
        assert!(
            f.store
                .read_work_plan_agent_tool_attempt(
                    wrong,
                    &querying,
                    tool_prepared.input().digest(),
                    false,
                    0,
                    1
                )
                .is_err()
        );
    }
    let mut outside = querying.clone();
    outside.tool_handle = second.handle;
    assert!(f.store.prepare_work_plan_agent_tool(&a, &outside).is_err());
    outside = querying.clone();
    outside.unit_ids = vec![f.units[1]];
    assert!(f.store.prepare_work_plan_agent_tool(&a, &outside).is_err());
    assert!(
        f.store
            .prepare_work_plan_agent_generation(&a, &generation(f.units[1]))
            .is_err()
    );
    let path = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .execution_result(generating.attempt_id, output.envelope().result_id)
            .unwrap()
            .bytes(),
        output.bytes()
    );
    assert_eq!(
        reopened
            .execution_result(querying.attempt_id, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
    assert!(
        reopened
            .read_work_plan_agent_tool_attempt(
                &a,
                &querying,
                tool_prepared.input().digest(),
                false,
                0,
                1
            )
            .is_err()
    );
}

#[test]
fn agent_subset_generation_raw_admission_and_authority_edits_are_rejected() {
    let mut f = fixture(2);
    let a = child(&f, f.units[0], vec![]);
    let request = generation(f.units[0]);
    let prepared = f
        .store
        .prepare_work_plan_agent_generation(&a, &request)
        .unwrap();
    let before = counts(&f.store);
    assert_eq!(
        f.runtime
            .submit_child(&mut f.store, prepared.input(), a.parent_task())
            .unwrap_err()
            .stage,
        "work-plan-agent-admission"
    );
    assert!(f.runtime.submit(&mut f.store, prepared.input()).is_err());
    for (key, value) in [
        ("model", json!("another-model")),
        ("shareTerms", json!(true)),
        ("shareContext", json!(true)),
    ] {
        let mut envelope = prepared.envelope().clone();
        envelope.settings["config"][key] = value;
        let changed = FixedInput::capture(envelope).unwrap();
        assert!(
            f.runtime
                .submit_child(&mut f.store, &changed, a.parent_task())
                .is_err()
        );
    }
    let mut copied = prepared.envelope().clone();
    copied.settings["agent"]["callerId"] = json!(f.scope.caller_id());
    assert!(
        f.runtime
            .submit_child(
                &mut f.store,
                &FixedInput::capture(copied).unwrap(),
                a.parent_task()
            )
            .is_err()
    );
    assert_eq!(counts(&f.store), before);
    for units in [
        vec![],
        vec![f.units[0], f.units[0]],
        vec![ExecutionId::new()],
    ] {
        assert!(
            f.store
                .delegate_work_plan_agent_scope(
                    &f.scope,
                    &AgentDelegationRequest {
                        delegation_id: ExecutionId::new(),
                        unit_ids: units,
                        tool_handles: vec![],
                    }
                )
                .is_err()
        );
    }
    assert!(
        f.store
            .delegate_work_plan_agent_scope(
                &f.scope,
                &AgentDelegationRequest {
                    delegation_id: ExecutionId::new(),
                    unit_ids: vec![f.units[0]],
                    tool_handles: vec![ExecutionId::new()],
                }
            )
            .is_err()
    );
    let other = fixture(2);
    assert!(
        other
            .store
            .prepare_work_plan_agent_generation(&a, &request)
            .is_err()
    );
}

#[test]
fn agent_subset_tool_reservations_remain_shared_across_siblings() {
    let mut f = fixture(2);
    let handle = f.plan.tools.as_ref().unwrap().entries[0].handle;
    let a = child(&f, f.units[0], vec![handle]);
    let b = child(&f, f.units[1], vec![handle]);
    for scope in [&a, &b] {
        let unit = scope.delegation().unwrap().unit_ids[0];
        let p = f
            .store
            .prepare_work_plan_agent_tool(scope, &request(&f, vec![unit]))
            .unwrap();
        f.runtime
            .submit_work_plan_tool(&mut f.store, &p, &f.consent, ExecutionId::new())
            .unwrap();
    }
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        2
    );
    let another = child(&f, f.units[0], vec![handle]);
    let p = f
        .store
        .prepare_work_plan_agent_tool(&another, &request(&f, vec![f.units[0]]))
        .unwrap();
    assert_eq!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &p, &f.consent, ExecutionId::new())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
}

#[test]
fn agent_subset_controls_reopen_and_new_callers_do_not_restore_result_authority() {
    for command in [
        WorkPlanCommand::Pause,
        WorkPlanCommand::Stop,
        WorkPlanCommand::TakeOver,
    ] {
        let mut f = fixture(2);
        let a = child(&f, f.units[0], vec![]);
        let request = generation(f.units[0]);
        let p = f
            .store
            .prepare_work_plan_agent_generation(&a, &request)
            .unwrap();
        f.runtime
            .submit_work_plan_agent_generation(&mut f.store, &p)
            .unwrap();
        let dispatch = f
            .store
            .dispatch_execution_item(request.attempt_id, p.envelope().items[0].item_id)
            .unwrap();
        let result = model_result(&dispatch, ExecutionState::Failed);
        f.store.save_execution_result(&result).unwrap();
        assert_eq!(
            f.store
                .read_work_plan_agent_generation_attempt(&a, &request, p.digest(), false, 0, 1)
                .unwrap()
                .progress
                .failed,
            1
        );
        f.store.control_work_plan(&control(&f, command)).unwrap();
        assert!(
            f.store
                .read_work_plan_agent_generation_attempt(&a, &request, p.digest(), false, 0, 1)
                .is_err()
        );
        assert!(
            f.runtime
                .submit_work_plan_agent_generation(&mut f.store, &p)
                .is_err()
        );
        if command == WorkPlanCommand::Pause {
            let receipt = f
                .store
                .control_work_plan(&control(&f, WorkPlanCommand::Continue))
                .unwrap();
            let root = f.store.work_plan_agent_scope(receipt.lease).unwrap();
            let fresh = f
                .store
                .delegate_work_plan_agent_scope(
                    &root,
                    &AgentDelegationRequest {
                        delegation_id: ExecutionId::new(),
                        unit_ids: vec![f.units[0]],
                        tool_handles: vec![],
                    },
                )
                .unwrap();
            assert!(
                f.store
                    .read_work_plan_agent_generation_attempt(
                        &fresh,
                        &request,
                        p.digest(),
                        false,
                        0,
                        1
                    )
                    .is_err()
            );
        }
        let path = f.store.directory().to_owned();
        drop(f.runtime);
        drop(f.store);
        let reopened = ProjectStore::open(path).unwrap();
        assert_eq!(
            reopened
                .read_work_plan_agent_generation_attempt(&a, &request, p.digest(), false, 0, 1)
                .unwrap_err()
                .stage,
            "work-plan-agent-session"
        );
        assert_eq!(
            reopened
                .execution_result(request.attempt_id, result.envelope().result_id)
                .unwrap()
                .bytes(),
            result.bytes()
        );
        let mut reopened = reopened;
        let mut runtime = ExecutionRuntime::new(&reopened).unwrap();
        assert_eq!(
            runtime
                .submit_work_plan_agent_generation(&mut reopened, &p)
                .unwrap_err()
                .stage,
            "work-plan-agent-session"
        );
    }
}

#[test]
fn agent_subset_generation_history_refuses_replaced_or_missing_witness() {
    for missing in [false, true] {
        let mut f = fixture(1);
        let a = child(&f, f.units[0], vec![]);
        let request = generation(f.units[0]);
        let p = f
            .store
            .prepare_work_plan_agent_generation(&a, &request)
            .unwrap();
        f.runtime
            .submit_work_plan_agent_generation(&mut f.store, &p)
            .unwrap();
        let path = f.store.directory().to_owned();
        drop(f.runtime);
        drop(f.store);
        let db = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        let mut witness = p.envelope().settings["agent"].clone();
        if missing {
            witness.as_object_mut().unwrap().remove("delegation");
        } else {
            witness["delegation"]["parentScopeId"] = json!(ExecutionId::new());
        }
        db.execute(
            "UPDATE application_executions SET delegation=?2 WHERE attempt_id=?1",
            rusqlite::params![
                request.attempt_id.to_string(),
                serde_json::to_vec(&witness).unwrap()
            ],
        )
        .unwrap();
        drop(db);
        assert!(ProjectStore::open(path).is_err());
    }
}

#[test]
fn agent_subset_expiry_and_tool_history_never_restore_a_child_scope() {
    let mut f = fixture(1);
    let handle = f.plan.tools.as_ref().unwrap().entries[0].handle;
    let a = child(&f, f.units[0], vec![handle]);
    let query = request(&f, vec![f.units[0]]);
    let p = f.store.prepare_work_plan_agent_tool(&a, &query).unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &p, &f.consent, ExecutionId::new())
        .unwrap();
    let db = rusqlite::Connection::open(f.store.directory().join("project.sqlite3")).unwrap();
    let original: i64 = db
        .query_row(
            "SELECT expires_at FROM application_plans WHERE plan_id=?1",
            [f.plan.plan_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE application_plans SET expires_at=1 WHERE plan_id=?1",
        [f.plan.plan_id.to_string()],
    )
    .unwrap();
    assert!(f.store.capture_work_plan_agent_guidance(&a).is_err());
    assert!(
        f.store
            .prepare_work_plan_agent_generation(&a, &generation(f.units[0]))
            .is_err()
    );
    assert!(
        f.store
            .read_work_plan_agent_tool_attempt(&a, &query, p.input().digest(), false, 0, 1)
            .is_err()
    );
    db.execute(
        "UPDATE application_plans SET expires_at=?2 WHERE plan_id=?1",
        rusqlite::params![f.plan.plan_id.to_string(), original],
    )
    .unwrap();
    let mut witness: serde_json::Value = serde_json::from_slice(
        &db.query_row::<Vec<u8>, _, _>(
            "SELECT delegation FROM application_executions WHERE attempt_id=?1",
            [query.attempt_id.to_string()],
            |r| r.get(0),
        )
        .unwrap(),
    )
    .unwrap();
    witness["delegation"]["parentScopeId"] = json!(ExecutionId::new());
    for table in ["application_executions", "plugin_execution_grants"] {
        db.execute(
            &format!("UPDATE {table} SET delegation=?2 WHERE attempt_id=?1"),
            rusqlite::params![
                query.attempt_id.to_string(),
                serde_json::to_vec(&witness).unwrap()
            ],
        )
        .unwrap();
    }
    assert!(
        f.store
            .read_work_plan_agent_tool_attempt(&a, &query, p.input().digest(), false, 0, 1)
            .is_err()
    );
    drop(db);
    let path = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    assert!(ProjectStore::open(path).is_err());
}

#[test]
fn agent_subset_human_reconciliation_proves_ended_absence_without_restoring_execution() {
    let mut f = fixture(2);
    let handle = f.plan.tools.as_ref().unwrap().entries[0].handle;
    let a = child(&f, f.units[0], vec![handle]);
    let p = f
        .store
        .prepare_work_plan_agent_generation(&a, &generation(f.units[0]))
        .unwrap();
    let absent = WorkPlanAgentExecutionIdentity {
        lease: a.lease(),
        task_id: p.envelope().task_id,
        attempt_id: p.envelope().attempt_id,
        input_digest: p.digest().into(),
    };
    assert_eq!(
        f.store
            .reconcile_work_plan_agent_execution(&absent)
            .unwrap()
            .outcome,
        WorkPlanAgentReconciliationOutcome::Active
    );
    let accepted = f
        .store
        .prepare_work_plan_agent_generation(&a, &generation(f.units[0]))
        .unwrap();
    f.runtime
        .submit_work_plan_agent_generation(&mut f.store, &accepted)
        .unwrap();
    let accepted = WorkPlanAgentExecutionIdentity {
        lease: a.lease(),
        task_id: accepted.envelope().task_id,
        attempt_id: accepted.envelope().attempt_id,
        input_digest: accepted.digest().into(),
    };
    let query = request(&f, vec![f.units[0]]);
    let tool = f.store.prepare_work_plan_agent_tool(&a, &query).unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &tool, &f.consent, ExecutionId::new())
        .unwrap();
    let tool = WorkPlanAgentExecutionIdentity {
        lease: a.lease(),
        task_id: query.task_id,
        attempt_id: query.attempt_id,
        input_digest: tool.input().digest().into(),
    };
    for identity in [&accepted, &tool] {
        assert_eq!(
            f.store
                .reconcile_work_plan_agent_execution(identity)
                .unwrap()
                .outcome,
            WorkPlanAgentReconciliationOutcome::Enqueued
        );
    }
    f.store
        .control_work_plan(&control(&f, WorkPlanCommand::Stop))
        .unwrap();
    let before = counts(&f.store);
    let sequence = f.store.execution_sequence().unwrap();
    let budget = f.store.provider_budget(a.parent_task()).unwrap();
    let receipt = f
        .store
        .reconcile_work_plan_agent_execution(&absent)
        .unwrap();
    assert_eq!(receipt.identity, absent);
    assert_eq!(
        receipt.outcome,
        WorkPlanAgentReconciliationOutcome::NotEnqueued
    );
    for identity in [&accepted, &tool] {
        assert_eq!(
            f.store
                .reconcile_work_plan_agent_execution(identity)
                .unwrap()
                .outcome,
            WorkPlanAgentReconciliationOutcome::Enqueued
        );
        let mut wrong = identity.clone();
        wrong.input_digest = "f".repeat(64);
        assert!(f.store.reconcile_work_plan_agent_execution(&wrong).is_err());
        wrong = identity.clone();
        wrong.task_id = ExecutionId::new();
        assert!(f.store.reconcile_work_plan_agent_execution(&wrong).is_err());
    }
    let root = f
        .store
        .execution_input(f.plan.execution_input().unwrap().attempt_id)
        .unwrap();
    assert!(
        f.store
            .reconcile_work_plan_agent_execution(&WorkPlanAgentExecutionIdentity {
                lease: a.lease(),
                task_id: root.envelope().task_id,
                attempt_id: root.envelope().attempt_id,
                input_digest: root.digest().into()
            })
            .is_err()
    );
    let mut future = absent.clone();
    future.lease.generation = Revision::new(100).unwrap();
    assert!(
        f.store
            .reconcile_work_plan_agent_execution(&future)
            .is_err()
    );
    let mut occupied = absent.clone();
    occupied.task_id = accepted.task_id;
    assert!(
        f.store
            .reconcile_work_plan_agent_execution(&occupied)
            .is_err()
    );
    assert_eq!(counts(&f.store), before);
    assert_eq!(f.store.execution_sequence().unwrap(), sequence);
    assert_eq!(f.store.provider_budget(a.parent_task()).unwrap(), budget);
    let path = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let store = ProjectStore::open(path).unwrap();
    assert_eq!(
        store.reconcile_work_plan_agent_execution(&absent).unwrap(),
        receipt
    );
    assert_eq!(
        store
            .reconcile_work_plan_agent_execution(&tool)
            .unwrap()
            .outcome,
        WorkPlanAgentReconciliationOutcome::Enqueued
    );
}

#[test]
fn agent_subset_expiry_alone_is_not_a_definitive_absence_receipt() {
    for command in [WorkPlanCommand::Stop, WorkPlanCommand::TakeOver] {
        let mut f = fixture(1);
        let a = child(&f, f.units[0], vec![]);
        let p = f
            .store
            .prepare_work_plan_agent_generation(&a, &generation(f.units[0]))
            .unwrap();
        let identity = WorkPlanAgentExecutionIdentity {
            lease: a.lease(),
            task_id: p.envelope().task_id,
            attempt_id: p.envelope().attempt_id,
            input_digest: p.digest().into(),
        };
        let db = rusqlite::Connection::open(f.store.directory().join("project.sqlite3")).unwrap();
        db.execute(
            "UPDATE application_plans SET expires_at=1 WHERE plan_id=?1",
            [f.plan.plan_id.to_string()],
        )
        .unwrap();
        assert!(f.store.check_work_plan_agent_scope(&a).is_err());
        assert_eq!(
            f.store
                .reconcile_work_plan_agent_execution(&identity)
                .unwrap()
                .outcome,
            WorkPlanAgentReconciliationOutcome::Active
        );
        // Existing human control remains available after an active lease expires.
        f.store.control_work_plan(&control(&f, command)).unwrap();
        assert_eq!(
            f.store
                .reconcile_work_plan_agent_execution(&identity)
                .unwrap()
                .outcome,
            WorkPlanAgentReconciliationOutcome::NotEnqueued
        );
    }
}
