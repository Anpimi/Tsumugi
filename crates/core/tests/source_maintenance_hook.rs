#![cfg(not(feature = "execution-test-host"))]
//! Synthetic Source facts; no external process, provider or real project data.
mod support;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tsumugi_core::{content::*, execution::*, *};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn project(s: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&s.metadata().unwrap().project_id().to_string()).unwrap()
}
fn activation(s: &ProjectStore) -> SourceMaintenanceHookActivation {
    let session = s.source_maintenance_hook_session().unwrap();
    SourceMaintenanceHookActivation {
        policy_version: session.policy_version,
        session_epoch: session.session_epoch,
        locale: "zh-CN".into(),
        after: 0,
        limit: 100,
        expires_at_ms: now() + 300_000,
    }
}
fn verified(
    s: &mut ProjectStore,
    count: usize,
) -> (
    ExecutionRuntime,
    FixedInput,
    FixedResult,
    SourceConfirmation,
) {
    let mut runtime = support::source_runtime(s);
    let input = support::source_input_with_texts(s, &vec!["same"; count]);
    let (_, result) = support::execute(&mut runtime, s, &input);
    let check = s
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let (_, checked) = support::execute(&mut runtime, s, check.check_input());
    s.commit_source_validation(check.prepare(checked).unwrap())
        .unwrap();
    let confirmation = s
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            100,
        )
        .unwrap()
        .confirmation;
    (runtime, input, result, confirmation)
}
fn create() -> (tempfile::TempDir, ProjectStore) {
    let d = tempfile::tempdir().unwrap();
    let s = ProjectStore::create(
        d.path().join("project"),
        ProjectMetadata::create("Observation", "en", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    (d, s)
}
struct PreparedSource {
    action: AdoptionAction,
    _runtime: ExecutionRuntime,
}
impl std::ops::Deref for PreparedSource {
    type Target = AdoptionAction;
    fn deref(&self) -> &AdoptionAction {
        &self.action
    }
}
fn prepare(s: &mut ProjectStore, count: usize) -> PreparedSource {
    let (runtime, i, r, mut c) = verified(s, count);
    c.maintenance_hook = Some(activation(s));
    let action = s
        .prepare_adoption_with_id(
            ExecutionId::new(),
            i.envelope().attempt_id,
            i.envelope().units[0].unit_id,
            vec![r.envelope().result_id],
            serde_json::to_value(c).unwrap(),
        )
        .unwrap();
    PreparedSource {
        action,
        _runtime: runtime,
    }
}
fn stop_request(s: &ProjectStore, a: &AdoptionAction) -> StopSourceMaintenanceHook {
    StopSourceMaintenanceHook {
        project_id: project(s),
        source_action_id: a.action_id,
        action_id: ExecutionId::new(),
        activation: serde_json::from_value::<SourceConfirmation>(a.parameters.clone())
            .unwrap()
            .maintenance_hook
            .unwrap(),
    }
}
fn finish(s: &mut ProjectStore, a: &AdoptionAction) -> SourceMaintenanceHookOutcome {
    let claim = s
        .claim_source_maintenance_hook(project(s), a.action_id, ExecutionId::new())
        .unwrap()
        .unwrap();
    let captured = s.capture_source_maintenance_hook(claim).unwrap();
    s.finish_source_maintenance_hook(captured.evaluate())
        .unwrap()
}

#[test]
fn source_commit_and_single_observation_preserve_exact_cause_window_and_history() {
    let (_d, mut s) = create();
    let a = prepare(&mut s, 101);
    let p = project(&s);
    assert_eq!(
        s.source_maintenance_hook(p, a.action_id).unwrap().state,
        SourceMaintenanceHookReadState::Prepared
    );
    let receipt = s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
    assert_eq!(receipt.changes.len(), 1);
    assert_eq!(receipt.changes[0].kind, "source-snapshot");
    let out = finish(&mut s, &a);
    assert_eq!(out.phase, SourceMaintenanceHookPhase::Observed);
    let assessment = out.assessment.as_ref().unwrap();
    assert_eq!(assessment.rows.len(), 100);
    assert_eq!(assessment.next_ordinal, Some(100));
    assert_eq!(
        assessment,
        &s.maintenance_assessment(p, out.cause.source_snapshot_id, "zh-CN", 0, 100)
            .unwrap()
    );
    assert_eq!(out.cause.source_action_id, a.action_id);
    assert_eq!(out.cause.attempt_id, a.attempt_id);
    assert!(
        s.claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        s.adopt_execution(&a, &SourceAdoptionHandler).unwrap(),
        receipt
    );
    assert_eq!(
        s.source_maintenance_hook(p, a.action_id)
            .unwrap()
            .view
            .unwrap()
            .outcome,
        Some(out.clone())
    );
    let path = s.directory().to_path_buf();
    s.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .source_maintenance_hook(p, a.action_id)
            .unwrap()
            .view
            .unwrap()
            .outcome,
        Some(out)
    );
    assert!(reopened.next_source_maintenance_hook().unwrap().is_none());
}

#[test]
fn stop_before_late_adoption_is_durable_exact_and_never_changes_source_receipt() {
    let (_d, mut s) = create();
    let a = prepare(&mut s, 2);
    let p = project(&s);
    let request = stop_request(&s, &a);
    let stopped = s.stop_source_maintenance_hook(&request).unwrap();
    assert!(matches!(
        stopped,
        SourceMaintenanceHookStopResult::Stopped { .. }
    ));
    assert_eq!(s.stop_source_maintenance_hook(&request).unwrap(), stopped);
    let mut changed = request.clone();
    changed.activation.locale = "fr-FR".into();
    assert_eq!(
        s.stop_source_maintenance_hook(&changed).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    let receipt = s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
    assert_eq!(receipt.changes.len(), 1);
    assert!(
        s.claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
            .unwrap()
            .is_none()
    );
    let path = s.directory().to_path_buf();
    s.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened.stop_source_maintenance_hook(&request).unwrap(),
        stopped
    );
    assert_eq!(
        reopened
            .source_maintenance_hook(p, a.action_id)
            .unwrap()
            .view
            .unwrap()
            .phase,
        SourceMaintenanceHookPhase::Stopped
    );
}

#[test]
fn unaccepted_source_action_is_explicitly_not_known_and_no_stop_fact_is_fabricated() {
    let (_d, mut s) = create();
    let request = StopSourceMaintenanceHook {
        project_id: project(&s),
        source_action_id: ExecutionId::new(),
        action_id: ExecutionId::new(),
        activation: activation(&s),
    };
    assert_eq!(
        s.source_maintenance_hook(project(&s), request.source_action_id)
            .unwrap()
            .state,
        SourceMaintenanceHookReadState::ActionNotKnown
    );
    assert_eq!(
        s.stop_source_maintenance_hook(&request).unwrap(),
        SourceMaintenanceHookStopResult::NotKnown
    );
}

#[test]
fn malformed_activation_rolls_back_preparation_and_source_is_unchanged() {
    let (_d, mut s) = create();
    let (_runtime, i, r, mut c) = verified(&mut s, 2);
    let original = s.content_scope().unwrap();
    for variant in 0..5 {
        let mut hook = activation(&s);
        match variant {
            0 => hook.limit = 101,
            1 => hook.after = 1,
            2 => hook.locale = "de-DE".into(),
            3 => hook.session_epoch = ExecutionId::new().to_string(),
            _ => hook.expires_at_ms = now() + 700_000,
        }
        c.maintenance_hook = Some(hook);
        let action = ExecutionId::new();
        assert!(
            s.prepare_adoption_with_id(
                action,
                i.envelope().attempt_id,
                i.envelope().units[0].unit_id,
                vec![r.envelope().result_id],
                serde_json::to_value(&c).unwrap()
            )
            .is_err()
        );
        assert_eq!(
            s.source_maintenance_hook(project(&s), action)
                .unwrap()
                .state,
            SourceMaintenanceHookReadState::ActionNotKnown
        );
        assert_eq!(s.content_scope().unwrap(), original);
    }
    let mut missing = serde_json::to_value(c).unwrap();
    missing.as_object_mut().unwrap().remove("maintenanceHook");
    assert!(serde_json::from_value::<SourceConfirmation>(missing).is_err());
}

#[test]
fn original_failed_observation_is_saved_without_undoing_source_or_reclaiming() {
    let (_d, mut s) = create();
    let a = prepare(&mut s, 2);
    let receipt = s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
    let p = project(&s);
    let claim = s
        .claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
        .unwrap()
        .unwrap();
    let failed = claim.failed(ExecutionError::new(
        ErrorCode::Busy,
        "synthetic-io-saturation",
    ));
    let out = s.finish_source_maintenance_hook(failed).unwrap();
    assert_eq!(out.phase, SourceMaintenanceHookPhase::Failed);
    assert!(out.assessment.is_none());
    assert_eq!(s.adoption_receipt(a.action_id).unwrap(), Some(receipt));
    assert!(
        s.claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
            .unwrap()
            .is_none()
    );
}

#[test]
fn late_result_after_stop_cannot_publish_and_original_claim_finishes_once() {
    let (_d, mut s) = create();
    let a = prepare(&mut s, 2);
    s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
    let p = project(&s);
    let claim = s
        .claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
        .unwrap()
        .unwrap();
    let computed = s.capture_source_maintenance_hook(claim).unwrap().evaluate();
    s.stop_source_maintenance_hook(&stop_request(&s, &a))
        .unwrap();
    let outcome = s.finish_source_maintenance_hook(computed).unwrap();
    assert_eq!(outcome.phase, SourceMaintenanceHookPhase::Stopped);
    assert!(outcome.assessment.is_none());
    assert!(
        s.claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_new_source_supersedes_only_unfinished_observation_and_preserves_completed_history() {
    for completed in [false, true] {
        let (_d, mut s) = create();
        let a = prepare(&mut s, 2);
        s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
        let p = project(&s);
        let claim = s
            .claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
            .unwrap()
            .unwrap();
        let computed = s.capture_source_maintenance_hook(claim).unwrap().evaluate();
        let mut original = None;
        if completed {
            original = Some(s.finish_source_maintenance_hook(computed.clone()).unwrap());
        }
        // The second source adds an entry, rather than replaying unchanged input.
        let b = prepare(&mut s, 3);
        s.adopt_execution(&b, &SourceAdoptionHandler).unwrap();
        if !completed {
            assert_eq!(
                s.claim_source_maintenance_hook(p, b.action_id, ExecutionId::new())
                    .unwrap_err()
                    .code,
                ErrorCode::Busy
            );
        }
        let outcome = s.finish_source_maintenance_hook(computed).unwrap();
        if let Some(original) = original {
            assert_eq!(outcome, original);
            assert_eq!(
                s.source_maintenance_hook(p, a.action_id)
                    .unwrap()
                    .view
                    .unwrap()
                    .phase,
                SourceMaintenanceHookPhase::Observed
            );
        } else {
            assert_eq!(outcome.phase, SourceMaintenanceHookPhase::Superseded);
            assert!(outcome.assessment.is_none());
        }
        assert_ne!(
            s.content_scope().unwrap().current_snapshot,
            Some(outcome.cause.source_snapshot_id)
        );
    }
}

#[test]
fn reopen_does_not_restore_prepared_pending_or_claimed_observation_authority() {
    for claimed in [false, true] {
        let (_d, mut s) = create();
        let a = prepare(&mut s, 2);
        let p = project(&s);
        s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
        let old = if claimed {
            Some(
                s.claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
                    .unwrap()
                    .unwrap(),
            )
        } else {
            None
        };
        let path = s.directory().to_path_buf();
        s.close().unwrap();
        let mut s = ProjectStore::open(path).unwrap();
        let view = s
            .source_maintenance_hook(p, a.action_id)
            .unwrap()
            .view
            .unwrap();
        assert_eq!(
            view.phase,
            if claimed {
                SourceMaintenanceHookPhase::Unknown
            } else {
                SourceMaintenanceHookPhase::Interrupted
            }
        );
        assert!(s.next_source_maintenance_hook().unwrap().is_none());
        assert!(
            s.claim_source_maintenance_hook(p, a.action_id, ExecutionId::new())
                .unwrap()
                .is_none()
        );
        if let Some(old) = old {
            assert!(
                s.finish_source_maintenance_hook(
                    old.failed(ExecutionError::new(ErrorCode::Busy, "old-store"))
                )
                .is_err()
            );
        }
    }
}

#[test]
fn reopen_rejects_missing_activation_and_damaged_outcome_even_without_external_consumers() {
    for remove_activation in [false, true] {
        let (_d, mut s) = create();
        let a = prepare(&mut s, 2);
        s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
        finish(&mut s, &a);
        let path = s.directory().to_path_buf();
        s.close().unwrap();
        let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        if remove_activation {
            c.execute("DELETE FROM source_maintenance_hooks", [])
                .unwrap();
        } else {
            c.execute(
                "UPDATE source_maintenance_hook_actions SET receipt_digest=?1 WHERE kind='outcome'",
                ["0".repeat(64)],
            )
            .unwrap();
        }
        drop(c);
        assert!(ProjectStore::open(path).is_err());
    }
}

#[test]
fn reopen_rejects_nonterminal_or_error_mismatched_outcome_even_with_updated_digests() {
    for variant in 0..3 {
        let (_d, mut s) = create();
        let a = prepare(&mut s, 2);
        s.adopt_execution(&a, &SourceAdoptionHandler).unwrap();
        finish(&mut s, &a);
        let path = s.directory().to_path_buf();
        s.close().unwrap();
        let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        let bytes: Vec<u8> = c
            .query_row(
                "SELECT receipt FROM source_maintenance_hook_actions WHERE kind='outcome'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        match variant {
            0 => {
                value["phase"] = "running".into();
                value["assessment"] = serde_json::Value::Null;
            }
            1 => {
                value["error"] = serde_json::to_value(ExecutionError::new(
                    ErrorCode::Busy,
                    "synthetic-invalid-outcome",
                ))
                .unwrap();
            }
            _ => {
                value["phase"] = "failed".into();
                value["assessment"] = serde_json::Value::Null;
            }
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        c.execute("UPDATE source_maintenance_hook_actions SET request=?1,receipt=?1,request_digest=?2,receipt_digest=?2 WHERE kind='outcome'",rusqlite::params![bytes,digest]).unwrap();
        drop(c);
        assert!(ProjectStore::open(path).is_err());
    }
}

#[test]
fn resource_capture_byte_limit_records_failure_without_truncating_or_undoing_source() {
    let (_directory, mut store) = create();
    let action = prepare(&mut store, 2);
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let project_id = project(&store);
    let mut prior: Option<TermRevision> = None;
    // Each legitimate resource revision fits its own field limit; the complete
    // historical capture exceeds its independent 4 MiB aggregate budget.
    for index in 0..160 {
        prior = Some(
            store
                .save_term(&SaveTerm {
                    project_id,
                    action_id: ExecutionId::new(),
                    term_id: prior.as_ref().map(|term| term.term_id.clone()),
                    locale: "zh-CN".into(),
                    source: "same".into(),
                    aliases: Vec::new(),
                    target: format!("{index:04} {}", "x".repeat(16_000)),
                    protected: false,
                    scope_unit_id: None,
                    expected_revision_id: prior.as_ref().map(|term| term.revision_id),
                    reason: "Synthetic capture byte boundary".into(),
                })
                .unwrap(),
        );
    }
    let claim = store
        .claim_source_maintenance_hook(project_id, action.action_id, ExecutionId::new())
        .unwrap()
        .unwrap();
    let computed = store
        .capture_source_maintenance_hook(claim)
        .unwrap()
        .evaluate();
    let outcome = store.finish_source_maintenance_hook(computed).unwrap();
    assert_eq!(outcome.phase, SourceMaintenanceHookPhase::Failed);
    assert!(outcome.assessment.is_none());
    let error = outcome.error.unwrap();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "impact-capture-bytes");
    assert_eq!(
        store.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
    assert!(
        store
            .claim_source_maintenance_hook(project_id, action.action_id, ExecutionId::new())
            .unwrap()
            .is_none()
    );
}
