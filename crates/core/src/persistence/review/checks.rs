//! Capture and commit adapters for database-independent review computation.
use super::*;
use crate::review::{CheckInput, check_rules, interrupted_rules};

#[derive(Debug)]
struct Capture {
    project_id: ExecutionId,
    action_id: ExecutionId,
    request_digest: String,
    target: ReviewTarget,
    terms: resources::TermResolution,
}

/// An immutable, store-created input. Callers cannot substitute its scope or basis.
#[derive(Debug)]
pub struct PreparedReviewCheck {
    state: PreparedState,
}

#[derive(Debug)]
enum PreparedState {
    Pending(Capture),
    Recorded {
        project_id: ExecutionId,
        request_digest: String,
        run: CheckRun,
    },
}

/// Computation carries its original authority; it cannot be deserialized from IPC.
#[derive(Debug)]
pub struct ComputedReviewCheck {
    prepared: PreparedReviewCheck,
    rules: Vec<CheckRuleResult>,
}

impl PreparedReviewCheck {
    /// Runs with owned values only, without holding a connection or transaction.
    pub fn compute(self, cancellation: &Cancellation) -> ComputedReviewCheck {
        let rules = match &self.state {
            PreparedState::Recorded { .. } => Vec::new(),
            PreparedState::Pending(_) if cancellation.is_requested() => {
                interrupted_rules("cancelled", "Cancelled before completion")
            }
            PreparedState::Pending(capture) => {
                #[cfg(test)]
                CHECK_BARRIER.with(|barrier| {
                    if let Some((reached, release)) = barrier.borrow_mut().take() {
                        reached.send(()).unwrap();
                        release
                            .recv_timeout(std::time::Duration::from_secs(5))
                            .unwrap();
                    }
                });
                let input = CheckInput {
                    unit_id: capture.target.unit_id,
                    locale: capture.target.locale.clone(),
                    source_text: capture.target.source_text.clone(),
                    translation_text: capture.target.translation_text.clone(),
                };
                #[cfg(test)]
                let injected = CHECK_FAIL.with(|flag| flag.get());
                #[cfg(not(test))]
                let injected = false;
                if injected {
                    interrupted_rules("failed", "review-check-injected-failure")
                } else {
                    check_rules(&input, &capture.terms)
                        .unwrap_or_else(|error| interrupted_rules("failed", &error.stage))
                }
            }
        };
        ComputedReviewCheck {
            prepared: self,
            rules,
        }
    }
}

impl ProjectStore {
    pub fn prepare_review_check(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        expected_basis: &str,
        action_id: ExecutionId,
    ) -> Result<PreparedReviewCheck, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        let request_digest = digest(&(project_id, unit_id, locale, expected_basis, action_id))?;
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?;
        if !connection.is_autocommit() {
            return Err(failure(ErrorCode::DependencyConflict, "review-transaction"));
        }
        queries::read_snapshot(connection, |connection| {
            if let Some((run, prior_digest)) = check_by_action(connection, project_id, action_id)? {
                return if prior_digest == request_digest {
                    Ok(PreparedReviewCheck {
                        state: PreparedState::Recorded {
                            project_id,
                            request_digest,
                            run,
                        },
                    })
                } else {
                    Err(failure(ErrorCode::ResultMismatch, "review-check-action"))
                };
            }
            let target = target_in(connection, project_id, unit_id, locale)?;
            if target.basis != expected_basis {
                return Err(failure(ErrorCode::DependencyConflict, "review-current")
                    .with_conflict(ConflictEvidence::ReviewBasis {
                        expected: expected_basis.to_owned(),
                        current: target.basis,
                    }));
            }
            let terms = resources::resolve_terms_in(connection, project_id, unit_id, locale)?;
            Ok(PreparedReviewCheck {
                state: PreparedState::Pending(Capture {
                    project_id,
                    action_id,
                    request_digest,
                    target,
                    terms,
                }),
            })
        })
    }

    pub fn commit_review_check(
        &mut self,
        computed: ComputedReviewCheck,
        cancellation: &Cancellation,
    ) -> Result<CheckRun, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        let capture = match computed.prepared.state {
            PreparedState::Pending(capture) => capture,
            PreparedState::Recorded {
                project_id,
                request_digest,
                run,
            } => {
                let recorded = check_by_action(
                    self.connection()
                        .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?,
                    project_id,
                    run.action_id,
                )?;
                return match recorded {
                    Some((current, digest)) if current == run && digest == request_digest => {
                        Ok(current)
                    }
                    _ => Err(failure(ErrorCode::ResultMismatch, "review-check-receipt")),
                };
            }
        };
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let commit_observer = change_clock.observe(&transaction, super::super::ChangeScope::Review);
        if let Some((run, prior_digest)) =
            check_by_action(&transaction, capture.project_id, capture.action_id)?
        {
            return if prior_digest == capture.request_digest {
                Ok(run)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-check-action"))
            };
        }
        let target = target_in(
            &transaction,
            capture.project_id,
            capture.target.unit_id,
            &capture.target.locale,
        )?;
        if target.basis != capture.target.basis {
            return Err(
                failure(ErrorCode::DependencyConflict, "review-current").with_conflict(
                    ConflictEvidence::ReviewBasis {
                        expected: capture.target.basis.clone(),
                        current: target.basis,
                    },
                ),
            );
        }
        if target.current_check.as_ref().map(|run| run.run_id)
            != capture.target.current_check.as_ref().map(|run| run.run_id)
        {
            return Err(
                failure(ErrorCode::DependencyConflict, "review-check-current").with_conflict(
                    ConflictEvidence::ReviewCheck {
                        expected: capture.target.current_check.as_ref().map(|run| run.run_id),
                        current: target.current_check.as_ref().map(|run| run.run_id),
                    },
                ),
            );
        }
        let mut rules = computed.rules;
        if cancellation.is_requested() {
            rules = interrupted_rules("cancelled", "Cancelled before completion");
        }
        let mut rules_json = serde_json::to_string(&rules)
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-check-encode"))?;
        if rules_json.len() > 65_536 {
            rules_json = serde_json::to_string(&interrupted_rules("failed", "limit-exceeded"))
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-check-encode"))?;
        }
        let basis_json = serde_json::to_string(&target.basis_evidence)
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-basis"))?;
        if cancellation.is_requested() {
            rules_json = serde_json::to_string(&interrupted_rules(
                "cancelled",
                "Cancelled before completion",
            ))
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-check-encode"))?;
        }
        transaction.execute(
            "INSERT INTO review_checks
             (run_id,action_id,project_id,unit_id,locale,basis,basis_json,validator_version,rules_json,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![ExecutionId::new().to_string(), capture.action_id.to_string(),
                capture.project_id.to_string(), target.unit_id.to_string(), target.locale,
                target.basis, basis_json, CHECK_VERSION, rules_json, capture.request_digest],
        ).map_err(sql)?;
        commit_observer.commit(transaction).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-check-commit")
        })?;
        check_by_action(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?,
            capture.project_id,
            capture.action_id,
        )?
        .map(|item| item.0)
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-check-receipt"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, translate};
    use super::*;
    use crate::SaveTerm;

    #[test]
    fn computation_releases_sqlite_and_commit_preserves_unrelated_updates() {
        let (directory, mut store, project, units) = fixture();
        translate(&mut store, project, units[0], "zh-CN", "你好 {{name}}");
        let basis = store
            .review_target(project, units[0], "zh-CN")
            .unwrap()
            .basis;
        let path = directory.path().join("project/project.sqlite3");
        let (reached, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        CHECK_BARRIER.with(|barrier| *barrier.borrow_mut() = Some((reached, resume)));
        let writer = std::thread::spawn(move || {
            waiting
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            let mut connection = Connection::open(path).unwrap();
            connection
                .busy_timeout(std::time::Duration::from_millis(100))
                .unwrap();
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            transaction.execute("UPDATE project_metadata SET display_name='Concurrent display name' WHERE row_id=1", []).unwrap();
            transaction.commit().unwrap();
            release.send(()).unwrap();
        });
        let run = store
            .run_review_checks(project, units[0], "zh-CN", &basis, ExecutionId::new())
            .unwrap();
        writer.join().unwrap();
        assert_eq!(run.outcome, ReviewCheckOutcome::Completed);
        assert!(run.rules.iter().all(|rule| rule.status == "passed"));
        assert_eq!(
            store.metadata().unwrap().display_name(),
            "Concurrent display name"
        );
    }

    #[test]
    fn commit_rejects_changed_terms_and_selection_without_writing_a_receipt() {
        for change_terms in [true, false] {
            let (_directory, mut store, project, units) = fixture();
            let unit = units[0];
            translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
            let basis = store.review_target(project, unit, "zh-CN").unwrap().basis;
            let action = ExecutionId::new();
            let prepared = store
                .prepare_review_check(project, unit, "zh-CN", &basis, action)
                .unwrap();
            let computed = prepared.compute(&Cancellation::default());
            if change_terms {
                store
                    .save_term(&SaveTerm {
                        project_id: project,
                        action_id: ExecutionId::new(),
                        term_id: None,
                        locale: "zh-CN".into(),
                        source: "Hello".into(),
                        aliases: vec![],
                        target: "问候".into(),
                        protected: true,
                        scope_unit_id: Some(unit),
                        expected_revision_id: None,
                        reason: "A newer applicable terminology decision".into(),
                    })
                    .unwrap();
            } else {
                translate(&mut store, project, unit, "zh-CN", "新人工译文 {{name}}");
            }
            assert_eq!(
                store
                    .commit_review_check(computed, &Cancellation::default())
                    .unwrap_err()
                    .code,
                ErrorCode::DependencyConflict
            );
            assert!(
                check_by_action(store.connection().unwrap(), project, action)
                    .unwrap()
                    .is_none()
            );
            let current = store.review_target(project, unit, "zh-CN").unwrap();
            assert!(current.current_check.is_none());
            if !change_terms {
                assert_eq!(
                    current.translation_text.as_deref(),
                    Some("新人工译文 {{name}}")
                );
            }
        }
    }

    #[test]
    fn cancellation_and_duplicate_captures_keep_one_durable_action_result() {
        let (_directory, mut store, project, units) = fixture();
        let unit = units[0];
        let basis = store.review_target(project, unit, "zh-CN").unwrap().basis;
        let action = ExecutionId::new();
        let first = store
            .prepare_review_check(project, unit, "zh-CN", &basis, action)
            .unwrap();
        let second = store
            .prepare_review_check(project, unit, "zh-CN", &basis, action)
            .unwrap();
        let signal = Cancellation::default();
        let computed = first.compute(&signal);
        signal.request();
        let cancelled = store.commit_review_check(computed, &signal).unwrap();
        assert_eq!(cancelled.outcome, ReviewCheckOutcome::Cancelled);
        translate(&mut store, project, unit, "zh-CN", "新译文 {{name}}");
        let replayed = store
            .commit_review_check(
                second.compute(&Cancellation::default()),
                &Cancellation::default(),
            )
            .unwrap();
        assert_eq!(replayed, cancelled);
        assert_eq!(
            store
                .review_history(project, unit, "zh-CN", 0, 10)
                .unwrap()
                .checks
                .len(),
            1
        );
        assert_eq!(
            store
                .prepare_review_check(project, unit, "fr-FR", &basis, action)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        let replay = store
            .prepare_review_check(project, unit, "zh-CN", &basis, action)
            .unwrap();
        let (_other_directory, mut other_store, _, _) = fixture();
        assert_eq!(
            other_store
                .commit_review_check(
                    replay.compute(&Cancellation::default()),
                    &Cancellation::default()
                )
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
    }

    #[test]
    fn a_late_check_cannot_replace_newer_evidence_for_the_same_basis() {
        let (_directory, mut store, project, units) = fixture();
        let unit = units[0];
        let basis = store.review_target(project, unit, "zh-CN").unwrap().basis;
        let late_action = ExecutionId::new();
        let late = store
            .prepare_review_check(project, unit, "zh-CN", &basis, late_action)
            .unwrap();
        let current = store
            .run_review_checks(project, unit, "zh-CN", &basis, ExecutionId::new())
            .unwrap();
        let signal = Cancellation::default();
        signal.request();
        let error = store
            .commit_review_check(late.compute(&signal), &signal)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict);
        assert_eq!(error.stage, "review-check-current");
        assert!(
            check_by_action(store.connection().unwrap(), project, late_action)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_check,
            Some(current)
        );
    }
}
