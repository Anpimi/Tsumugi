//! Registered plan orchestration consumes a synthetic saved result, then runs
//! the installed independent checkers. No model or HTTP producer is invoked.
use super::*;

fn seed_validated_candidate_result(fixture: &Fixture, grant: &Value, text: &str) {
    let action: ExecutionId = serde_json::from_value(grant["actionId"].clone()).unwrap();
    let unit = fixture.unit;
    let text = text.to_owned();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &mut sessions.active.as_mut().unwrap().store;
            let receipt = store.work_plan_receipt(action).unwrap().unwrap();
            let input = FixedInput::capture(receipt.input.unwrap()).unwrap();
            assert_eq!(input.envelope().automation, Some(receipt.lease));
            store.enqueue_execution(&input).unwrap();
            let attempt = input.envelope().attempt_id;
            let item = input
                .envelope()
                .items
                .iter()
                .find(|item| item.scope.id == unit.to_string())
                .unwrap();
            let dispatch = store
                .dispatch_execution_item(attempt, item.item_id)
                .unwrap();
            let result = FixedResult::capture(
                ResultEnvelope {
                    project_id: input.envelope().project_id,
                    attempt_id: attempt,
                    item_id: item.item_id,
                    result_id: ExecutionId::new(),
                    supersedes: None,
                    dispatch_token: dispatch.dispatch_token,
                    capability_id: tsumugi_core::ai::CAPABILITY.into(),
                    capability_version: "1".into(),
                    plugin: None,
                    outcome: ExecutionState::Succeeded,
                    output: Some(
                        serde_json::to_value(tsumugi_core::ai::AiOutput {
                            unit_id: unit,
                            target_locale: "zh-CN".into(),
                            text,
                            usage: None,
                            requests: 1,
                            usage_incomplete: true,
                        })
                        .unwrap(),
                    ),
                    diagnostic: None,
                },
                &input,
                dispatch.dispatch_token,
            )
            .unwrap();
            store.save_execution_result(&result).unwrap();
            store
                .validate_execution_result(attempt, result.envelope().result_id)
                .unwrap();
            assert!(
                store
                    .saved_ai_candidate(attempt, item.item_id)
                    .unwrap()
                    .is_none()
            );
        });
}

#[test]
fn candidates_only_records_actual_checker_findings_without_selecting_or_establishing_current_qa() {
    let installation = OwnedDirectory(tempfile::tempdir().unwrap());
    let (format, format_approval) = selected_package(
        "TSUMUGI_TEST_PLUGIN_PACKAGE",
        "TSUMUGI_TEST_PLUGIN_DIGEST",
        "webvtt",
    );
    let (knowledge, knowledge_approval) = selected_package(
        "TSUMUGI_TEST_KNOWLEDGE_PACKAGE",
        "TSUMUGI_TEST_KNOWLEDGE_DIGEST",
        "philosophy",
    );
    let source_binding = format.source_import("source-profile").unwrap();
    let text_binding = knowledge.text_review_declaration("text-review").unwrap();
    let pins = knowledge.text_review_resource_pins("text-review").unwrap();
    let soundness = text_binding
        .declaration
        .rules
        .iter()
        .find(|rule| rule.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
    let runtime = approved_runtime();
    let approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let digest = approval.environment.digest().unwrap();
    provision_packages(
        installation.0.path(),
        &[
            (format, format_approval.clone()),
            (knowledge, knowledge_approval.clone()),
        ],
        &runtime,
        &approval,
    );
    drop(runtime);
    let mut fixture = declared_fixture(
        &installation.0.path().join("application"),
        &format_approval,
        &digest,
        &source_binding,
    );
    let advisory = json!({"package":{"plugin":knowledge_approval.plugin,"packageDigest":knowledge_approval.package_digest},"resourceId":"text-review","environmentDigest":digest,"rules":[soundness]});
    let mut options = PlanOptions::default();
    assert_eq!(options.selection_policy, SelectionPolicy::CandidatesOnly);
    options
        .stages
        .iter_mut()
        .find(|stage| stage.stage == WorkStage::Checks)
        .unwrap()
        .mode = StageMode::Assisted;
    let target_request = json!({"unitId":fixture.unit,"locale":"zh-CN"});
    let history_request = json!({"unitId":fixture.unit,"locale":"zh-CN","offset":0,"limit":50});
    let target_before = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    let history_before = fixture
        .call("read_review_history", history_request.clone())
        .unwrap();
    let plan = fixture.call("prepare_work_plan", json!({
        "config":AiConfig { endpoint:"http://127.0.0.1:9/v1/chat/completions".into(),model:"synthetic-saved-candidate".into(),credential_env:String::new(),..AiConfig::default() },
        "locale":"zh-CN","unitIds":[fixture.unit],"options":options,"advisoryChecks":[advisory],"toolSelection":null
    })).unwrap();
    let keys = checker_keys(&plan);
    assert_eq!(keys.len(), 2);
    let authorization = json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":keys,"toolExecution":false,"applicationToolExecutions":[],"effects":["save-candidate","run-checks"],"expiresAt":expiry()});
    let before = fixture.bytes();
    for missing in [json!([]), json!([keys[0]]), json!([keys[1]])] {
        let mut rejected = authorization.clone();
        rejected["actionId"] = json!(ExecutionId::new());
        rejected["checkerExecutions"] = missing;
        assert!(fixture.call("authorize_work_plan", rejected).is_err());
    }
    assert_eq!(fixture.bytes(), before);
    let grant = fixture
        .call("authorize_work_plan", authorization.clone())
        .unwrap();
    // Both an invalid target payload and the missing preferred term must remain
    // visible in candidate evidence rather than becoming a selection block.
    seed_validated_candidate_result(&fixture, &grant, "<b>👩🏽‍💻 é 前提</b>");
    let untracked = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(untracked["rows"][0]["automation"]["phase"], "cancelled");
    assert!(untracked["rows"][0]["automation"]["receipt"].is_null());
    assert!(untracked["rows"][0]["savedRevisionId"].is_null());
    fixture.call("start_work_plan", json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap();
    let view = wait_checked(&fixture, &plan["attemptId"]);
    assert_eq!(view["rows"][0]["automation"]["phase"], "checked", "{view}");
    let receipt = assert_evidence(
        &fixture,
        &view,
        &keys,
        None,
        &source_binding,
        &text_binding,
        &pins,
        &soundness,
    );
    assert_eq!(receipt.policy, SelectionPolicy::CandidatesOnly);
    assert_eq!(receipt.policy_version, "checked-selection-3");
    assert!(receipt.candidate_basis.selection_id.is_none());
    assert!(
        receipt.selection.is_none() && receipt.check_run_id.is_none() && receipt.blocked.is_none()
    );
    assert!(receipt.rules.iter().any(|rule| {
        rule.mandatory
            && rule.status == "findings"
            && rule
                .findings
                .iter()
                .any(|finding| finding.code == "invalid-payload")
    }));
    assert!(
        receipt
            .rules
            .iter()
            .any(|rule| !rule.mandatory && rule.key.rule == soundness && rule.status == "findings")
    );
    assert_eq!(
        fixture
            .call("read_review_target", target_request.clone())
            .unwrap(),
        target_before
    );
    assert_eq!(
        fixture
            .call("read_review_history", history_request.clone())
            .unwrap(),
        history_before
    );
    let original = view["rows"][0]["automation"].clone();
    let row = view["rows"][0].clone();
    let unit = fixture.unit;
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let project =
                ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
            let history = store
                .translation_history(project, unit, "zh-CN", 0, 100)
                .unwrap();
            assert_eq!(history.rows.len(), 1);
            assert!(history.current.is_none());
            assert_eq!(json!(history.rows[0].revision_id), row["savedRevisionId"]);
        });
    unavailable::settled(&fixture);
    fixture.reopen();
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let reopened = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(reopened["rows"][0]["automation"], original);
    assert_eq!(
        fixture.call("read_review_target", target_request).unwrap(),
        target_before
    );
    assert_eq!(
        fixture
            .call("read_review_history", history_request)
            .unwrap(),
        history_before
    );
    assert_eq!(
        fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap()["state"],
        "paused"
    );
    assert!(
        fixture
            .call(
                "retry_work_plan_effect",
                json!({"attemptId":plan["attemptId"],"itemId":reopened["rows"][0]["itemId"]})
            )
            .is_err()
    );
    assert_eq!(
        fixture.call("authorize_work_plan", authorization).unwrap(),
        grant
    );
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(fixture.bytes(), before);
}
