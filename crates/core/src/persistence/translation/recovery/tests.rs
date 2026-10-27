use super::super::tests::project_with_source;
use super::*;
use crate::execution::{ExecutionId, Revision};
use std::{
    process::{Command, Stdio},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

fn save_request(store: &ProjectStore, row: &crate::content::ContentRow) -> SaveTranslationRevision {
    SaveTranslationRevision {
        project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string())
            .unwrap(),
        action_id: ExecutionId::new(),
        unit_id: row.unit_id.unwrap(),
        locale: "zh-CN".into(),
        source_revision_id: row.source_revision_id.unwrap(),
        expected_selection_id: None,
        text: "Original A 👩🏽‍💻e\u{301}".into(),
    }
}

#[derive(Debug, Eq, PartialEq)]
struct BusinessState {
    revisions: i64,
    selections: i64,
    protection_revision: i64,
    protected: i64,
    protection_actions: i64,
    review_decisions: i64,
    review_checks: i64,
    review_waivers: i64,
    review_fallbacks: i64,
}

fn business_state(store: &ProjectStore) -> BusinessState {
    store
        .connection()
        .unwrap()
        .query_row(
            "SELECT
            (SELECT COUNT(*) FROM translation_revisions),
            (SELECT COUNT(*) FROM translation_selections),
            (SELECT COALESCE(SUM(revision),0) FROM application_protections),
            (SELECT COALESCE(SUM(protected),0) FROM application_protections),
            (SELECT COUNT(*) FROM application_protection_actions),
            (SELECT COUNT(*) FROM review_decisions),
            (SELECT COUNT(*) FROM review_checks),
            (SELECT COUNT(*) FROM review_waivers),
            (SELECT COUNT(*) FROM review_fallbacks)",
            [],
            |row| {
                Ok(BusinessState {
                    revisions: row.get(0)?,
                    selections: row.get(1)?,
                    protection_revision: row.get(2)?,
                    protected: row.get(3)?,
                    protection_actions: row.get(4)?,
                    review_decisions: row.get(5)?,
                    review_checks: row.get(6)?,
                    review_waivers: row.get(7)?,
                    review_fallbacks: row.get(8)?,
                })
            },
        )
        .unwrap()
}

#[test]
fn absent_recovery_stays_pending_and_only_explicit_read_reconciles_commit_uncertainty() {
    let (_temp, mut store, rows) = project_with_source();
    let request = save_request(&store, &rows[0]);
    let before = business_state(&store);
    let clock = store.changes_since(Revision::new(0).unwrap());
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(
        store.save_translation_edit(&request).unwrap_err().code,
        ErrorCode::OutcomeUnknown
    );
    assert!(store.is_reconciling());

    let recovery = store.recover_translation_save(&request).unwrap();
    assert_eq!(
        recovery,
        TranslationSaveRecovery {
            request: request.clone(),
            outcome: TranslationActionOutcome::Pending {
                replay: TranslationActionReplay::ExplicitSameRequest
            },
        }
    );
    assert!(!store.is_reconciling());
    assert_eq!(
        store.translation_save_receipt_by_request(&request).unwrap(),
        None
    );
    assert_eq!(business_state(&store), before);
    assert_eq!(store.changes_since(clock.sequence).sequence, clock.sequence);

    // Execution-ledger validation cannot settle an unrelated metadata change.
    let metadata = store.metadata().unwrap();
    store.pending = Some(crate::persistence::PendingChange {
        previous: metadata.clone(),
        intended: metadata,
    });
    assert_eq!(
        store.recover_translation_save(&request).unwrap().outcome,
        TranslationActionOutcome::Pending {
            replay: TranslationActionReplay::Blocked
        }
    );
    let selection = SelectTranslationRevision {
        project_id: request.project_id,
        action_id: ExecutionId::new(),
        unit_id: request.unit_id,
        locale: request.locale.clone(),
        source_revision_id: request.source_revision_id,
        expected_selection_id: None,
        revision_id: ExecutionId::new(),
    };
    assert_eq!(
        store
            .recover_translation_selection(&selection)
            .unwrap()
            .outcome,
        TranslationActionOutcome::Pending {
            replay: TranslationActionReplay::Blocked
        }
    );
    assert!(store.is_reconciling());
    assert_eq!(
        store.save_translation_edit(&request).unwrap_err().code,
        ErrorCode::OutcomeUnknown
    );
    assert_eq!(business_state(&store), before);
    store.pending = None;
    assert_eq!(
        store
            .recover_translation_selection(&selection)
            .unwrap()
            .outcome,
        TranslationActionOutcome::Pending {
            replay: TranslationActionReplay::ExplicitSameRequest
        }
    );
}

#[test]
fn recorded_recovery_preserves_historical_basis_and_reopens_without_business_writes() {
    let (temp, mut store, rows) = project_with_source();
    let request = save_request(&store, &rows[0]);
    let receipt = store.save_translation_edit(&request).unwrap();
    let newer = SaveTranslationRevision {
        action_id: ExecutionId::new(),
        expected_selection_id: Some(receipt.selection.event_id),
        text: "Newer B".into(),
        ..request.clone()
    };
    let newer_receipt = store.save_translation_edit(&newer).unwrap();
    let selection = SelectTranslationRevision {
        project_id: request.project_id,
        action_id: ExecutionId::new(),
        unit_id: request.unit_id,
        locale: request.locale.clone(),
        source_revision_id: request.source_revision_id,
        expected_selection_id: Some(newer_receipt.selection.event_id),
        revision_id: receipt.revision.revision_id,
    };
    let selected = store.select_translation_revision(&selection).unwrap();
    let revision = store.metadata().unwrap().metadata_revision();
    store.set_target_locales(revision, &["ja".into()]).unwrap();
    let before = business_state(&store);
    let clock = store.changes_since(Revision::new(0).unwrap());
    let expected_save = TranslationSaveRecovery {
        request: request.clone(),
        outcome: TranslationActionOutcome::Recorded {
            receipt: receipt.clone(),
        },
    };
    let expected_selection = TranslationSelectionRecovery {
        request: selection.clone(),
        outcome: TranslationActionOutcome::Recorded { receipt: selected },
    };
    assert_eq!(
        store.recover_translation_save(&request).unwrap(),
        expected_save
    );
    assert_eq!(
        store.recover_translation_selection(&selection).unwrap(),
        expected_selection
    );
    assert_eq!(business_state(&store), before);
    assert_eq!(store.changes_since(clock.sequence).sequence, clock.sequence);
    assert_eq!(before.revisions, 2);
    assert_eq!(before.selections, 3);
    assert_eq!(before.review_decisions, 0);
    assert_eq!(before.review_checks, 0);
    store.close().unwrap();

    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(
        reopened.recover_translation_save(&request).unwrap(),
        expected_save
    );
    assert_eq!(
        reopened.recover_translation_selection(&selection).unwrap(),
        expected_selection
    );
    assert_eq!(
        reopened
            .translation_save_receipt_by_request(&request)
            .unwrap(),
        Some(receipt)
    );
    assert_eq!(business_state(&reopened), before);
    assert_eq!(
        reopened
            .changes_since(Revision::new(0).unwrap())
            .sequence
            .get(),
        0
    );
}

#[test]
fn mismatched_complete_requests_and_foreign_scope_do_not_release_uncertainty() {
    let (_temp, mut store, rows) = project_with_source();
    let request = save_request(&store, &rows[0]);
    let receipt = store.save_translation_edit(&request).unwrap();
    let selection = SelectTranslationRevision {
        project_id: request.project_id,
        action_id: ExecutionId::new(),
        unit_id: request.unit_id,
        locale: request.locale.clone(),
        source_revision_id: request.source_revision_id,
        expected_selection_id: Some(receipt.selection.event_id),
        revision_id: receipt.revision.revision_id,
    };
    store.select_translation_revision(&selection).unwrap();
    let before = business_state(&store);
    store.execution_unknown.store(true, Ordering::Release);
    for changed in [
        SaveTranslationRevision {
            text: "Different".into(),
            ..request.clone()
        },
        SaveTranslationRevision {
            source_revision_id: ExecutionId::new(),
            ..request.clone()
        },
        SaveTranslationRevision {
            expected_selection_id: Some(receipt.selection.event_id),
            ..request.clone()
        },
        SaveTranslationRevision {
            locale: "ja".into(),
            ..request.clone()
        },
        SaveTranslationRevision {
            unit_id: rows[1].unit_id.unwrap(),
            ..request.clone()
        },
        SaveTranslationRevision {
            action_id: selection.action_id,
            ..request.clone()
        },
    ] {
        assert_eq!(
            store.recover_translation_save(&changed).unwrap(),
            TranslationSaveRecovery {
                request: changed.clone(),
                outcome: TranslationActionOutcome::Mismatch {},
            }
        );
        assert!(store.is_reconciling());
        assert_eq!(
            store
                .translation_save_receipt_by_request(&changed)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
    }
    for changed in [
        SelectTranslationRevision {
            revision_id: ExecutionId::new(),
            ..selection.clone()
        },
        SelectTranslationRevision {
            source_revision_id: ExecutionId::new(),
            ..selection.clone()
        },
        SelectTranslationRevision {
            expected_selection_id: None,
            ..selection.clone()
        },
        SelectTranslationRevision {
            locale: "ja".into(),
            ..selection.clone()
        },
        SelectTranslationRevision {
            unit_id: rows[1].unit_id.unwrap(),
            ..selection.clone()
        },
        SelectTranslationRevision {
            action_id: request.action_id,
            ..selection.clone()
        },
    ] {
        assert_eq!(
            store.recover_translation_selection(&changed).unwrap(),
            TranslationSelectionRecovery {
                request: changed,
                outcome: TranslationActionOutcome::Mismatch {},
            }
        );
        assert!(store.is_reconciling());
    }
    assert_eq!(
        store
            .recover_translation_save(&SaveTranslationRevision {
                project_id: ExecutionId::new(),
                ..request.clone()
            })
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .recover_translation_selection(&SelectTranslationRevision {
                project_id: ExecutionId::new(),
                ..selection.clone()
            })
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(store.is_reconciling());
    assert_eq!(business_state(&store), before);
    assert!(matches!(
        store.recover_translation_save(&request).unwrap().outcome,
        TranslationActionOutcome::Recorded { .. }
    ));
    assert!(!store.is_reconciling());
}

#[test]
fn corrupt_receipts_and_failed_reconciliation_are_errors_instead_of_recorded_or_pending() {
    let (_temp, mut store, rows) = project_with_source();
    let request = save_request(&store, &rows[0]);
    let receipt = store.save_translation_edit(&request).unwrap();
    let selection = SelectTranslationRevision {
        project_id: request.project_id,
        action_id: ExecutionId::new(),
        unit_id: request.unit_id,
        locale: request.locale.clone(),
        source_revision_id: request.source_revision_id,
        expected_selection_id: Some(receipt.selection.event_id),
        revision_id: receipt.revision.revision_id,
    };
    let selected = store.select_translation_revision(&selection).unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE translation_revisions SET text='damaged' WHERE revision_id=?1",
            [receipt.revision.revision_id.to_string()],
        )
        .unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(
        store.recover_translation_save(&request).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
    assert!(store.is_reconciling());
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE translation_revisions SET text=?1 WHERE revision_id=?2",
            rusqlite::params![request.text, receipt.revision.revision_id.to_string()],
        )
        .unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE translation_selections SET previous_event_id=event_id WHERE event_id=?1",
            [selected.event_id.to_string()],
        )
        .unwrap();
    store.execution_unknown.store(false, Ordering::Release);
    assert_eq!(
        store
            .recover_translation_selection(&selection)
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
    // A missing receipt must not hide an invalid ledger discovered during the
    // explicit reconciliation that follows the lookup.
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(
        store
            .recover_translation_save(&SaveTranslationRevision {
                action_id: ExecutionId::new(),
                ..request
            })
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
    assert!(store.is_reconciling());
}

#[test]
fn recovery_wire_contract_is_tagged_exact_and_does_not_invent_absence_or_external_outcomes() {
    let (_temp, store, rows) = project_with_source();
    let request = save_request(&store, &rows[0]);
    let recovery = store.recover_translation_save(&request).unwrap();
    let value = serde_json::to_value(&recovery).unwrap();
    assert_eq!(value["request"], serde_json::to_value(&request).unwrap());
    assert_eq!(
        value["outcome"],
        serde_json::json!({"kind":"pending","replay":"explicit-same-request"})
    );
    assert_eq!(
        serde_json::from_value::<TranslationSaveRecovery>(value.clone()).unwrap(),
        recovery
    );
    for invalid in [
        serde_json::json!({"kind":"confirmed-not-applied"}),
        serde_json::json!({"kind":"external-unknown"}),
        serde_json::json!({"kind":"pending","replay":"automatic"}),
        serde_json::json!({"kind":"recorded"}),
        serde_json::json!({"kind":"mismatch","receipt":null}),
    ] {
        let mut invalid_value = value.clone();
        invalid_value["outcome"] = invalid;
        assert!(serde_json::from_value::<TranslationSaveRecovery>(invalid_value).is_err());
    }
    let mut unknown = value;
    unknown["request"]["sessionToken"] = serde_json::json!("not-business-authority");
    assert!(serde_json::from_value::<TranslationSaveRecovery>(unknown).is_err());
}

#[test]
#[ignore = "isolated subprocess selected by the manual save crash-boundary test"]
fn manual_save_crash_child() {
    let project = std::env::var("TSUMUGI_MANUAL_SAVE_PROJECT")
        .expect("manual save crash helper requires its isolated project");
    let request: SaveTranslationRevision = serde_json::from_slice(
        &std::fs::read(std::env::var("TSUMUGI_MANUAL_SAVE_REQUEST").unwrap()).unwrap(),
    )
    .unwrap();
    let mut store = ProjectStore::open(project).unwrap();
    store.save_translation_edit(&request).unwrap();
    panic!("manual save crash hook did not abort");
}

#[test]
fn manual_save_recovery_reopens_across_process_commit_boundaries() {
    for point in ["before-manual-save-commit", "after-manual-save-commit"] {
        let (temp, store, rows) = project_with_source();
        let request = save_request(&store, &rows[0]);
        let project = temp.path().join("project");
        let request_file = temp.path().join("request.json");
        std::fs::write(&request_file, serde_json::to_vec(&request).unwrap()).unwrap();
        store.close().unwrap();
        let hook = temp.path().join("crash-hook");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::translation::recovery::tests::manual_save_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("TSUMUGI_MANUAL_SAVE_PROJECT", &project)
            .env("TSUMUGI_MANUAL_SAVE_REQUEST", &request_file)
            .env("TSUMUGI_MIGRATION_CRASH", point)
            .env("TSUMUGI_MIGRATION_HOOK", &hook)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let timed_out = loop {
            if child.try_wait().unwrap().is_some() {
                break false;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                break true;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let output = child.wait_with_output().unwrap();
        let diagnostics = format!(
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !timed_out,
            "owned manual save crash helper timed out: {diagnostics}"
        );
        assert!(
            !output.status.success(),
            "crash helper returned success: {diagnostics}"
        );
        assert_eq!(
            std::fs::read_to_string(&hook).unwrap_or_default(),
            point,
            "{diagnostics}"
        );

        let mut reopened = ProjectStore::open(&project).unwrap();
        let before = business_state(&reopened);
        let recovery = reopened.recover_translation_save(&request).unwrap();
        if point == "before-manual-save-commit" {
            assert_eq!(
                recovery.outcome,
                TranslationActionOutcome::Pending {
                    replay: TranslationActionReplay::ExplicitSameRequest,
                }
            );
            assert_eq!(
                before,
                BusinessState {
                    revisions: 0,
                    selections: 0,
                    protection_revision: 0,
                    protected: 0,
                    protection_actions: 0,
                    review_decisions: 0,
                    review_checks: 0,
                    review_waivers: 0,
                    review_fallbacks: 0,
                }
            );
        } else {
            let TranslationActionOutcome::Recorded { receipt } = recovery.outcome else {
                panic!("committed manual save was not recorded");
            };
            assert_eq!(receipt.action_id, request.action_id);
            assert_eq!(receipt.revision.text, request.text);
            assert_eq!(receipt.basis.selection_id, receipt.selection.event_id);
        }
        assert_eq!(business_state(&reopened), before);
        assert_eq!(
            reopened
                .changes_since(Revision::new(0).unwrap())
                .sequence
                .get(),
            0
        );

        // Only the explicit replay below may commit an absent original action.
        let receipt = reopened.save_translation_edit(&request).unwrap();
        assert_eq!(reopened.save_translation_edit(&request).unwrap(), receipt);
        let after = business_state(&reopened);
        assert_eq!(
            after,
            BusinessState {
                revisions: 1,
                selections: 1,
                protection_revision: 1,
                protected: 1,
                protection_actions: 0,
                review_decisions: 0,
                review_checks: 0,
                review_waivers: 0,
                review_fallbacks: 0,
            }
        );
        let expected = TranslationSaveRecovery {
            request: request.clone(),
            outcome: TranslationActionOutcome::Recorded { receipt },
        };
        assert_eq!(
            reopened.recover_translation_save(&request).unwrap(),
            expected
        );
        assert_eq!(business_state(&reopened), after);
        reopened.close().unwrap();
        let reopened_again = ProjectStore::open(project).unwrap();
        assert_eq!(
            reopened_again.recover_translation_save(&request).unwrap(),
            expected
        );
        assert_eq!(business_state(&reopened_again), after);
    }
}
