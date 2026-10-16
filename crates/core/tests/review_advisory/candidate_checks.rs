//! Candidate-only QA uses the normal Core port and original policy receipt.
//! Synthetic SDK clients prove Core association; no model/network call occurs.
use super::*;
use sha2::{Digest, Sha256};
use tsumugi_core::{ComputedAutomaticSelection, PersistenceErrorCode, PersistenceStage};

fn compute_candidate(
    store: &mut ProjectStore,
    request: &AutomaticSelectionRequest,
    response: Response,
) -> (
    ExecutionRuntime,
    Vec<ExecutionId>,
    Vec<ReviewCheckOrigin>,
    ComputedAutomaticSelection,
) {
    let prepared = store.prepare_automatic_selection(request).unwrap();
    let check = prepared.review_check().unwrap();
    let mut runtime = joint_runtime(store, check, response);
    let (grants, origins) = execute_all(&mut runtime, store, check);
    let computed = store
        .capture_automatic_selection_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    (runtime, grants, origins, computed)
}

fn assert_check_only(receipt: &AutomaticSelectionReceipt) {
    assert_eq!(receipt.policy_version, "checked-selection-3");
    assert_eq!(receipt.policy, SelectionPolicy::CandidatesOnly);
    assert_eq!(
        receipt.candidate_basis.revision_id,
        Some(receipt.request.revision_id)
    );
    assert!(receipt.candidate_basis.selection_id.is_none());
    assert!(receipt.blocked.is_none());
    assert!(receipt.selection.is_none());
    assert!(receipt.check_run_id.is_none());
    assert_eq!(receipt.evidence.as_ref().unwrap().origins.len(), 2);
}

#[test]
fn recorded_checks_leave_protected_selection_current_qa_and_human_approval_unchanged() {
    let (_dir, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "same");
    let advisory = choice(&store, unit, false);
    let current = prepare(&store, unit, ExecutionId::new(), &[advisory.clone()]);
    let mut current_runtime = joint_runtime(&store, &current, Response::Exact);
    let (_, origins) = execute_all(&mut current_runtime, &mut store, &current);
    let computed = store
        .capture_review_check_execution(current, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    approve(&mut store, unit);
    drop(current_runtime);
    let before = store.review_target(project(&store), unit, "zh-CN").unwrap();
    assert!(
        before.selection_id.is_some()
            && before.current_check.is_some()
            && before.current_decision.is_some()
    );
    assert!(store.work_protection(unit, "zh-CN").unwrap().protected);
    let request = automatic::candidate_request_with_advisory(
        &mut store,
        unit,
        "😀same",
        SelectionPolicy::CandidatesOnly,
        &[advisory.clone()],
    );
    let (runtime, _, _, computed) = compute_candidate(&mut store, &request, Response::Finding);
    let receipt = store
        .commit_automatic_selection(computed, &Cancellation::default())
        .unwrap();
    assert_check_only(&receipt);
    assert_eq!(receipt.captured_selection_id, before.selection_id);
    assert_eq!(
        receipt.evidence.as_ref().unwrap().advisory_checks,
        [advisory]
    );
    assert!(
        receipt
            .rules
            .iter()
            .any(|rule| !rule.mandatory && !rule.findings.is_empty())
    );
    assert_eq!(
        store
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap(),
        before
    );
    assert!(
        store
            .review_check_action(request.project_id, request.action_id)
            .unwrap()
            .is_none()
    );
    // Later manual work cannot erase or be overwritten by the accepted action.
    save(&mut store, unit, "new human B");
    let manual = store
        .review_target(request.project_id, unit, "zh-CN")
        .unwrap();
    store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: request.lease.plan_id,
            expected_generation: request.lease.generation,
            command: WorkPlanCommand::Pause,
            confirmed: false,
            expires_at: None,
        })
        .unwrap();
    let replay = store
        .prepare_automatic_selection(&request)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert_eq!(
        store
            .commit_automatic_selection(replay, &Cancellation::default())
            .unwrap(),
        receipt
    );
    let mut different = request.clone();
    different.revision_id = ExecutionId::new();
    assert_eq!(
        store
            .prepare_automatic_selection(&different)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let mut fresh = request.clone();
    fresh.action_id = ExecutionId::new();
    assert_eq!(
        store.prepare_automatic_selection(&fresh).unwrap_err().code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        store
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap(),
        manual
    );
    let path = store.directory().to_owned();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    let bytes = std::fs::read(path.join("project.sqlite3")).unwrap();
    assert_eq!(
        reopened
            .automatic_selection_for_candidate(request.lease, request.revision_id)
            .unwrap(),
        Some(receipt.clone())
    );
    let replay = reopened
        .prepare_automatic_selection(&request)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert_eq!(
        reopened
            .commit_automatic_selection(replay, &Cancellation::default())
            .unwrap(),
        receipt
    );
    assert_eq!(
        reopened
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap(),
        manual
    );
    assert_eq!(
        reopened
            .work_plan_status(request.lease.plan_id)
            .unwrap()
            .state,
        WorkPlanState::Paused
    );
    assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), bytes);
}

#[test]
fn terminal_checker_failures_and_unknowns_are_recorded_without_selection_or_fabricated_results() {
    for (response, invocation, status) in [
        (Response::Failed, ReviewInvocationOutcome::Failed, "failed"),
        (
            Response::Unknown,
            ReviewInvocationOutcome::Unknown,
            "unknown",
        ),
        (
            Response::Unavailable,
            ReviewInvocationOutcome::Succeeded,
            "unavailable",
        ),
    ] {
        let (_dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        let advisory = choice(&store, unit, false);
        let request = automatic::candidate_request_with_advisory(
            &mut store,
            unit,
            "same",
            SelectionPolicy::CandidatesOnly,
            &[advisory.clone()],
        );
        let (runtime, _, _, computed) = compute_candidate(&mut store, &request, response);
        let receipt = store
            .commit_automatic_selection(computed, &Cancellation::default())
            .unwrap();
        assert_check_only(&receipt);
        let evidence = receipt.evidence.as_ref().unwrap();
        assert_eq!(
            evidence
                .origins
                .iter()
                .find(|o| o.checker == advisory.checker().key)
                .unwrap()
                .outcome,
            invocation
        );
        assert_eq!(
            receipt.rules.iter().find(|r| !r.mandatory).unwrap().status,
            status
        );
        if invocation != ReviewInvocationOutcome::Succeeded {
            assert!(!evidence.results.iter().any(|r| r.key.implementation
                == sdk::CheckImplementation::Plugin {
                    provider: advisory.binding.checker.provider.clone()
                }));
        }
        let target = store
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap();
        assert!(target.selection_id.is_none() && target.revision_id.is_none());
        assert!(target.current_check.is_none() && target.current_decision.is_none());
        let path = store.directory().to_owned();
        store.pause_active_work_plans().unwrap();
        drop(runtime);
        store.close().unwrap();
        let mut reopened = ProjectStore::open(path).unwrap();
        assert_eq!(
            reopened
                .automatic_selection_receipt(request.action_id)
                .unwrap(),
            Some(receipt.clone())
        );
        let replay = reopened
            .prepare_automatic_selection(&request)
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        assert_eq!(
            reopened
                .commit_automatic_selection(replay, &Cancellation::default())
                .unwrap(),
            receipt
        );
        let mut fresh = request.clone();
        fresh.action_id = ExecutionId::new();
        assert_eq!(
            reopened
                .prepare_automatic_selection(&fresh)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
    }
}

#[test]
fn every_original_checker_grant_and_cancellation_are_rechecked_before_candidate_receipt_commit() {
    for (index, cancel) in [(0, false), (1, false), (0, true), (1, true)] {
        let (_dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        let advisory = choice(&store, unit, false);
        let request = automatic::candidate_request_with_advisory(
            &mut store,
            unit,
            "same",
            SelectionPolicy::CandidatesOnly,
            &[advisory],
        );
        let (mut runtime, grants, origins, computed) =
            compute_candidate(&mut store, &request, Response::Exact);
        if cancel {
            let input = store.execution_input(origins[index].attempt_id).unwrap();
            runtime
                .cancel(&mut store, input.envelope().task_id, ExecutionId::new())
                .unwrap();
        } else {
            runtime.revoke_plugin(&mut store, grants[index]).unwrap();
        }
        assert!(
            store
                .commit_automatic_selection(computed, &Cancellation::default())
                .is_err()
        );
        assert!(
            store
                .automatic_selection_receipt(request.action_id)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .translation_history(request.project_id, unit, "zh-CN", 0, 10)
                .unwrap()
                .rows
                .iter()
                .any(|r| r.revision_id == request.revision_id)
        );
        assert!(
            store
                .review_target(request.project_id, unit, "zh-CN")
                .unwrap()
                .current_check
                .is_none()
        );
    }
}

#[test]
fn unfinished_checks_refuse_changed_plan_basis_resources_and_protection() {
    for mode in [
        "pause",
        "stop",
        "take-over",
        "continue",
        "manual",
        "resources",
        "protection",
        "reopen",
    ] {
        let (_dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        let advisory = choice(&store, unit, false);
        let request = automatic::candidate_request_with_advisory(
            &mut store,
            unit,
            "same",
            SelectionPolicy::CandidatesOnly,
            &[advisory],
        );
        for foreign in ["project", "locale", "unit", "candidate"] {
            let mut wrong = request.clone();
            match foreign {
                "project" => wrong.project_id = ExecutionId::new(),
                "locale" => wrong.locale = "ja".into(),
                "unit" => wrong.unit_id = rows[1].unit_id.unwrap(),
                _ => wrong.revision_id = ExecutionId::new(),
            }
            assert_eq!(
                store.prepare_automatic_selection(&wrong).unwrap_err().code,
                ErrorCode::Unauthorized,
                "{foreign}"
            );
        }
        let (runtime, _, _, computed) = compute_candidate(&mut store, &request, Response::Exact);
        match mode {
            "manual" => save(&mut store, unit, "new manual B"),
            "resources" => {
                let target = store
                    .review_target(request.project_id, unit, "zh-CN")
                    .unwrap();
                store
                    .save_context(&tsumugi_core::SaveContext {
                        project_id: request.project_id,
                        action_id: ExecutionId::new(),
                        unit_id: unit,
                        locale: "zh-CN".into(),
                        source_revision_id: target.source_revision_id,
                        text: "New interpretation".into(),
                        expected_revision_id: None,
                        reason: "Synthetic currentness change".into(),
                    })
                    .unwrap();
            }
            "protection" => {
                let target = store
                    .review_target(request.project_id, unit, "zh-CN")
                    .unwrap();
                store
                    .set_work_protection(&SetWorkProtection {
                        action_id: ExecutionId::new(),
                        project_id: request.project_id,
                        unit_id: unit,
                        locale: "zh-CN".into(),
                        source_revision_id: target.source_revision_id,
                        selection_id: target.selection_id,
                        expected_revision: store.work_protection(unit, "zh-CN").unwrap().revision,
                        protected: true,
                        confirmed_release: false,
                    })
                    .unwrap();
            }
            "reopen" => {
                let path = store.directory().to_owned();
                store.close().unwrap();
                store = ProjectStore::open(path).unwrap();
            }
            _ => {
                let state = store
                    .control_work_plan(&ControlWorkPlan {
                        action_id: ExecutionId::new(),
                        plan_id: request.lease.plan_id,
                        expected_generation: request.lease.generation,
                        command: match mode {
                            "stop" => WorkPlanCommand::Stop,
                            "take-over" => WorkPlanCommand::TakeOver,
                            _ => WorkPlanCommand::Pause,
                        },
                        confirmed: false,
                        expires_at: None,
                    })
                    .unwrap();
                if mode == "continue" {
                    let expiry = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs()
                        + 600;
                    store
                        .control_work_plan(&ControlWorkPlan {
                            action_id: ExecutionId::new(),
                            plan_id: request.lease.plan_id,
                            expected_generation: state.lease.generation,
                            command: WorkPlanCommand::Continue,
                            confirmed: true,
                            expires_at: Some(expiry),
                        })
                        .unwrap();
                }
            }
        }
        let error = store
            .commit_automatic_selection(computed, &Cancellation::default())
            .unwrap_err();
        assert_eq!(
            error.code,
            if matches!(mode, "manual" | "resources" | "protection") {
                ErrorCode::DependencyConflict
            } else if mode == "reopen" {
                ErrorCode::Unauthorized
            } else {
                ErrorCode::Cancelled
            },
            "{mode}: {error:?}"
        );
        assert!(
            store
                .automatic_selection_receipt(request.action_id)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .translation_history(request.project_id, unit, "zh-CN", 0, 10)
                .unwrap()
                .rows
                .iter()
                .any(|r| r.revision_id == request.revision_id)
        );
        assert!(
            store
                .review_target(request.project_id, unit, "zh-CN")
                .unwrap()
                .current_check
                .is_none()
        );
        drop(runtime);
    }
}

#[test]
fn check_only_receipt_shape_and_original_qa_frames_are_strict_on_reopen() {
    for alteration in [
        "selection-basis",
        "blocked",
        "check-run",
        "evidence",
        "origin",
        "requirement",
        "candidate",
    ] {
        let (_dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        let advisory = choice(&store, unit, false);
        let request = automatic::candidate_request_with_advisory(
            &mut store,
            unit,
            "same",
            SelectionPolicy::CandidatesOnly,
            &[advisory],
        );
        let (runtime, _, _, computed) = compute_candidate(&mut store, &request, Response::Exact);
        let receipt = store
            .commit_automatic_selection(computed, &Cancellation::default())
            .unwrap();
        let path = store.directory().to_owned();
        drop(runtime);
        store.close().unwrap();
        let mut value = serde_json::to_value(receipt).unwrap();
        match alteration {
            "selection-basis" => {
                value["candidateBasis"]["selectionId"] = serde_json::json!(ExecutionId::new())
            }
            "blocked" => value["blocked"] = serde_json::json!("protected"),
            "check-run" => value["checkRunId"] = serde_json::json!(ExecutionId::new()),
            "evidence" => value["evidence"] = serde_json::Value::Null,
            "origin" => {
                value["evidence"]["origins"][1]["resultDigest"] = serde_json::json!("f".repeat(64))
            }
            "requirement" => {
                value["evidence"]["requiredChecks"]["requirements"][0]["mandatory"] =
                    serde_json::json!(false)
            }
            _ => value["candidateBasis"]["revisionId"] = serde_json::json!(ExecutionId::new()),
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        let database = path.join("project.sqlite3");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute("UPDATE application_selection_actions SET receipt=?1,receipt_digest=?2 WHERE action_id=?3", rusqlite::params![bytes, format!("{:x}", Sha256::digest(&bytes)), request.action_id.to_string()]).unwrap();
        drop(connection);
        let before = std::fs::read(&database).unwrap();
        let error = ProjectStore::open(&path)
            .err()
            .unwrap_or_else(|| panic!("open accepted {alteration}"));
        assert_eq!(
            error.code(),
            PersistenceErrorCode::CorruptProject,
            "{alteration}"
        );
        assert_eq!(error.stage(), PersistenceStage::Open, "{alteration}");
        assert_eq!(std::fs::read(database).unwrap(), before, "{alteration}");
    }
}
