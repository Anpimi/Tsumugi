#![cfg(not(feature = "execution-test-host"))]
//! Core persistence and admission contracts over the original synthetic source
//! fixture. These assertions establish no real-domain or model quality claim.
mod support;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use tsumugi_core::{
    ai::{self, AiConfig, arena},
    content::ContentRow,
    execution::*,
    *,
};

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}
fn save(
    store: &mut ProjectStore,
    row: &ContentRow,
    previous: Option<ExecutionId>,
    text: &str,
) -> TranslationSaveReceipt {
    store
        .save_translation_edit(&SaveTranslationRevision {
            project_id: project(store),
            action_id: ExecutionId::new(),
            unit_id: row.unit_id.unwrap(),
            locale: "zh-CN".into(),
            source_revision_id: row.source_revision_id.unwrap(),
            expected_selection_id: previous,
            text: text.into(),
        })
        .unwrap()
}
fn candidate(
    store: &mut ProjectStore,
    row: &ContentRow,
) -> (CaptureContextStrategy, ContextStrategyCandidate) {
    let first = save(store, row, None, "Before correction");
    let after = save(
        store,
        row,
        Some(first.selection.event_id),
        "Saved manual correction",
    );
    let evidence = store
        .correction_term_basis(
            project(store),
            row.unit_id.unwrap(),
            "zh-CN",
            after.selection.event_id,
        )
        .unwrap();
    let request = CaptureContextStrategy {
        action_id: ExecutionId::new(),
        basis: evidence.basis,
        source_context: SourceContextSelection {
            neighbors: true,
            ..Default::default()
        },
        reason: "Inspect bounded source neighbors after this correction".into(),
        exceptions: "Only this project and locale; no measured quality claim".into(),
    };
    let value = store.capture_context_strategy(&request).unwrap();
    (request, value)
}
fn suite_request(
    store: &ProjectStore,
    value: &ContextStrategyCandidate,
    rows: &[ContentRow],
) -> CaptureStrategySuite {
    CaptureStrategySuite {
        action_id: ExecutionId::new(),
        project_id: project(store),
        candidate_id: value.candidate_id,
        config: AiConfig {
            endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
            model: "synthetic".into(),
            credential_env: String::new(),
            max_items: 2,
            max_requests: 4,
            ..Default::default()
        },
        calibration_unit_ids: vec![rows[0].unit_id.unwrap()],
        holdout_unit_ids: vec![rows[1].unit_id.unwrap()],
    }
}
fn evaluation(store: &mut ProjectStore, suite: &StrategySuite) -> StrategyEvaluation {
    store
        .capture_strategy_evaluation(&CaptureStrategyEvaluation {
            action_id: ExecutionId::new(),
            project_id: suite.project_id,
            candidate_id: suite.candidate_id,
            suite_id: suite.suite_id,
        })
        .unwrap()
}

#[test]
fn immutable_manual_origin_and_bounded_current_projection_survive_reopening() {
    let (dir, mut store, rows) = support::source_fixture();
    let p = project(&store);
    let (request, first) = candidate(&mut store, &rows[0]);
    assert!(first.evidence.current);
    assert!(
        store
            .read_context_strategy_default(p, "zh-CN")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .resolve_terms(p, rows[0].unit_id.unwrap(), "zh-CN")
            .unwrap()
            .entries
            .is_empty()
    );
    assert_eq!(store.capture_context_strategy(&request).unwrap(), first);
    let different = CaptureContextStrategy {
        reason: "Changed under the same action".into(),
        ..request.clone()
    };
    assert_eq!(
        store.capture_context_strategy(&different).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    for index in 0..2 {
        let next = CaptureContextStrategy {
            action_id: ExecutionId::new(),
            reason: format!("Independent explicit proposal {index}"),
            ..request.clone()
        };
        store.capture_context_strategy(&next).unwrap();
    }
    let page = store.list_context_strategies(p, "zh-CN", 0, 2).unwrap();
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.next_offset, Some(2));
    let last = store.list_context_strategies(p, "zh-CN", 2, 2).unwrap();
    assert_eq!(last.rows, vec![first.clone()]);
    assert_eq!(last.next_offset, None);
    for limit in [0, 51] {
        assert_eq!(
            store
                .list_context_strategies(p, "zh-CN", 0, limit)
                .unwrap_err()
                .stage,
            "strategy-page"
        );
    }
    save(
        &mut store,
        &rows[0],
        Some(request.basis.after.selection_id),
        "Later draft",
    );
    let historical = store.read_context_strategy(p, first.candidate_id).unwrap();
    assert!(!historical.evidence.current);
    assert_eq!(historical.digest, first.digest);
    assert_eq!(historical.evidence.basis, first.evidence.basis);
    assert_eq!(
        store
            .capture_context_strategy(&CaptureContextStrategy {
                action_id: ExecutionId::new(),
                ..request.clone()
            })
            .unwrap_err()
            .stage,
        "strategy-correction-stale"
    );
    store.close().unwrap();
    let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .read_context_strategy(p, first.candidate_id)
            .unwrap(),
        historical
    );
    assert!(
        reopened
            .list_context_strategies(p, "zh-CN", 0, 50)
            .unwrap()
            .rows
            .iter()
            .all(|row| !row.evidence.current)
    );
    assert!(
        matches!(reopened.read_strategy_action(p,request.action_id).unwrap(),Some(StrategyActionReceipt::Candidate{candidate,..}) if candidate==first)
    );
}

#[test]
fn suite_owner_freezes_two_slots_and_excludes_tuning_unit_from_holdout() {
    let (_dir, mut store, rows) = support::source_fixture();
    let (_, value) = candidate(&mut store, &rows[0]);
    let request = suite_request(&store, &value, &rows);
    let mut invalid = request.clone();
    invalid.holdout_unit_ids = invalid.calibration_unit_ids.clone();
    assert_eq!(
        store.capture_strategy_suite(&invalid).unwrap_err().stage,
        "strategy-suite-scope"
    );
    invalid = request.clone();
    invalid.calibration_unit_ids = vec![rows[1].unit_id.unwrap()];
    invalid.holdout_unit_ids = vec![rows[0].unit_id.unwrap()];
    assert_eq!(
        store.capture_strategy_suite(&invalid).unwrap_err().stage,
        "strategy-suite-scope"
    );
    for flag in ["terms", "manual", "context", "reference"] {
        invalid = request.clone();
        match flag {
            "terms" => invalid.config.share_terms = true,
            "manual" => invalid.config.share_context = true,
            "context" => invalid.config.source_context.neighbors = true,
            _ => {
                invalid.config.context_strategy = Some(ContextStrategyReference {
                    project_id: request.project_id,
                    revision_id: ExecutionId::new(),
                    candidate_id: value.candidate_id,
                })
            }
        }
        assert_eq!(
            store.capture_strategy_suite(&invalid).unwrap_err().stage,
            "strategy-suite-scope",
            "{flag}"
        );
    }
    let suite = store.capture_strategy_suite(&request).unwrap();
    assert_eq!(suite.preview.items.len(), 4);
    assert_eq!(suite.units.len(), 2);
    assert_eq!(suite.preview.config.variants[0], request.config);
    let mut configured = request.config.clone();
    configured.source_context = value.source_context;
    assert_eq!(suite.preview.config.variants[1], configured);
    assert!(suite.units[1].holdout);
    assert!(!suite.units[0].holdout);
    assert_eq!(store.capture_strategy_suite(&request).unwrap(), suite);
    assert_eq!(
        store
            .capture_strategy_suite(&CaptureStrategySuite {
                holdout_unit_ids: vec![],
                ..request
            })
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
}

#[test]
fn accepted_input_is_permanent_while_new_admission_requires_current_suite() {
    let (dir, mut store, rows) = support::source_fixture();
    let (_, value) = candidate(&mut store, &rows[0]);
    let request = suite_request(&store, &value, &rows);
    let suite = store.capture_strategy_suite(&request).unwrap();
    let accepted = evaluation(&mut store, &suite);
    let prepared = evaluation(&mut store, &suite);
    let input = store
        .strategy_evaluation_input(suite.project_id, accepted.evaluation_id)
        .unwrap();
    let not_accepted = store
        .strategy_evaluation_input(suite.project_id, prepared.evaluation_id)
        .unwrap();
    let settings = arena::settings(&input).unwrap();
    assert_eq!(
        settings.strategy_evaluation.unwrap().suite_id,
        suite.suite_id
    );
    assert_eq!(settings.config, suite.preview.config);
    assert!(
        store.execution_input(accepted.attempt_id).is_err(),
        "capture grants no execution and does not enqueue"
    );
    let slots = store
        .strategy_evaluation_view(suite.project_id, accepted.evaluation_id)
        .unwrap()
        .slots;
    assert_eq!(
        slots.iter().map(|s| s.item_id).collect::<Vec<_>>(),
        input
            .envelope()
            .items
            .iter()
            .map(|i| i.item_id)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        slots.iter().map(|s| s.slot).collect::<Vec<_>>(),
        vec![0, 1, 0, 1]
    );
    assert!(slots.iter().all(|s| s.result_id.is_none()));
    store.enqueue_execution(&input).unwrap();
    save(
        &mut store,
        &rows[0],
        Some(value.evidence.basis.after.selection_id),
        "New manual correction",
    );
    assert_eq!(
        store
            .check_strategy_evaluation_current(suite.project_id, accepted.evaluation_id)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(
        store.enqueue_execution(&not_accepted).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
    store.enqueue_execution(&input).unwrap();
    assert_eq!(
        store.execution_input(accepted.attempt_id).unwrap().bytes(),
        input.bytes()
    );
    let view = store
        .strategy_evaluation_view(suite.project_id, accepted.evaluation_id)
        .unwrap();
    assert!(!view.current);
    assert!(view.checks.is_empty());
    store.close().unwrap();
    let reopened = ProjectStore::open(dir.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .execution_input(accepted.attempt_id)
            .unwrap()
            .bytes(),
        input.bytes()
    );
    assert_eq!(
        reopened
            .read_strategy_suite(suite.project_id, suite.suite_id)
            .unwrap(),
        suite
    );
    assert_eq!(
        reopened
            .list_strategy_evaluations(suite.project_id, "zh-CN", 0, 1)
            .unwrap()
            .next_offset,
        Some(1)
    );
}

#[test]
fn forged_evaluation_and_unpromoted_config_reference_fail_at_core_boundaries() {
    let (_dir, mut store, rows) = support::source_fixture();
    let (_, value) = candidate(&mut store, &rows[0]);
    let request = suite_request(&store, &value, &rows);
    let suite = store.capture_strategy_suite(&request).unwrap();
    let eval = evaluation(&mut store, &suite);
    let input = store
        .strategy_evaluation_input(suite.project_id, eval.evaluation_id)
        .unwrap();
    let mut envelope = input.envelope().clone();
    envelope.settings["strategyEvaluation"]["candidateId"] = ExecutionId::new().to_string().into();
    let forged = FixedInput::capture(envelope).unwrap();
    assert_eq!(
        store.enqueue_execution(&forged).unwrap_err().stage,
        "strategy-evaluation-input"
    );
    let reference = ContextStrategyReference {
        project_id: suite.project_id,
        revision_id: ExecutionId::new(),
        candidate_id: value.candidate_id,
    };
    let mut config = request.config.clone();
    config.source_context = value.source_context;
    config.context_strategy = Some(reference.clone());
    assert_eq!(
        store
            .preview_ai(config.clone(), "zh-CN", &[rows[0].unit_id.unwrap()])
            .unwrap_err()
            .stage,
        "strategy-missing"
    );
    config.context_strategy = None;
    let ordinary = store
        .preview_ai(config, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut envelope = ordinary.envelope().clone();
    envelope.settings["config"]["contextStrategy"] = serde_json::to_value(reference).unwrap();
    let forged = FixedInput::capture(envelope).unwrap();
    ai::settings(&forged).unwrap();
    assert_eq!(
        store.enqueue_execution(&forged).unwrap_err().stage,
        "strategy-missing"
    );
}

#[test]
fn labels_or_human_notes_cannot_replace_mandatory_original_check_proofs() {
    let (_dir, mut store, rows) = support::source_fixture();
    let (_, value) = candidate(&mut store, &rows[0]);
    let request = suite_request(&store, &value, &rows);
    let suite = store.capture_strategy_suite(&request).unwrap();
    let eval = evaluation(&mut store, &suite);
    let promotion = PromoteContextStrategy {
        action_id: ExecutionId::new(),
        project_id: suite.project_id,
        evaluation_id: eval.evaluation_id,
        expected_revision_id: None,
    };
    assert_eq!(
        store
            .promote_context_strategy(&promotion)
            .unwrap_err()
            .stage,
        "strategy-checks-incomplete"
    );
    let judgment = StrategyJudgmentRequest {
        action_id: ExecutionId::new(),
        project_id: suite.project_id,
        evaluation_id: eval.evaluation_id,
        unit_id: rows[0].unit_id.unwrap(),
        expected_judgment_id: None,
        preference: StrategyPreference::CandidatePreferred,
        notes: "Human preference does not authorize execution or bypass QA".into(),
        elapsed_seconds: None,
        modified_characters: None,
    };
    assert_eq!(
        store.record_strategy_judgment(&judgment).unwrap_err().stage,
        "strategy-holdout"
    );
    assert!(
        store
            .read_strategy_action(suite.project_id, promotion.action_id)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_context_strategy_default(suite.project_id, "zh-CN")
            .unwrap()
            .is_none()
    );
}

#[test]
fn reopening_rejects_rehashed_broken_candidate_suite_and_input_associations() {
    for scenario in ["candidate", "suite", "input", "index", "orphan"] {
        let (_dir, mut store, rows) = support::source_fixture();
        let (_, value) = candidate(&mut store, &rows[0]);
        let request = suite_request(&store, &value, &rows);
        let suite = store.capture_strategy_suite(&request).unwrap();
        let eval = evaluation(&mut store, &suite);
        let path = store.directory().to_path_buf();
        store.close().unwrap();
        let c = Connection::open(path.join("project.sqlite3")).unwrap();
        if scenario == "index" {
            c.execute(
                "UPDATE context_strategy_facts SET locale='ja' WHERE kind='candidate'",
                [],
            )
            .unwrap();
        } else if scenario == "orphan" {
            c.execute(
                "DELETE FROM context_strategy_actions WHERE action_id=?1",
                [value.candidate_id.to_string()],
            )
            .unwrap();
        } else {
            let (kind, id) = match scenario {
                "candidate" => ("candidate", value.candidate_id),
                "suite" => ("suite", suite.suite_id),
                _ => ("evaluation-input", eval.evaluation_id),
            };
            let payload: Vec<u8> = c
                .query_row(
                    "SELECT payload FROM context_strategy_facts WHERE kind=?1 AND fact_id=?2",
                    params![kind, id.to_string()],
                    |r| r.get(0),
                )
                .unwrap();
            let mut json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            match scenario {
                "candidate" => json["evidence"]["afterText"] = "forged saved correction".into(),
                "suite" => json["units"][1]["holdout"] = false.into(),
                _ => {
                    json["settings"]["strategyEvaluation"]["suiteId"] =
                        ExecutionId::new().to_string().into()
                }
            }
            let payload = serde_json::to_vec(&json).unwrap();
            let digest = format!("{:x}", Sha256::digest(&payload));
            c.execute("UPDATE context_strategy_facts SET payload=?3,digest=?4 WHERE kind=?1 AND fact_id=?2",params![kind,id.to_string(),payload,digest]).unwrap();
        }
        drop(c);
        assert_eq!(
            ProjectStore::open(path).unwrap_err().code(),
            PersistenceErrorCode::CorruptProject,
            "{scenario}"
        );
    }
}

#[test]
fn config_provenance_is_required_nullable_and_grants_no_new_scope() {
    let config = suite_request_config();
    let json = serde_json::to_value(&config).unwrap();
    assert!(json["contextStrategy"].is_null());
    let mut absent = json.clone();
    absent.as_object_mut().unwrap().remove("contextStrategy");
    assert!(serde_json::from_value::<AiConfig>(absent).is_err());
    let mut malformed = json;
    malformed["contextStrategy"] = serde_json::json!({"projectId":"invalid","revisionId":ExecutionId::new(),"candidateId":ExecutionId::new()});
    assert!(serde_json::from_value::<AiConfig>(malformed).is_err());
}
fn suite_request_config() -> AiConfig {
    AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        ..Default::default()
    }
}
