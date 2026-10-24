use super::*;
use tsumugi_core::{
    ReviewFindingDisposition, ReviewFindingWrite,
    ai::{AiConfig, semantic_review::*},
};

/// A trusted typed fixture isolates Review projection from Provider transport,
/// which is exercised by the normal-Core localhost semantic-review tests.
struct ModelReview;
impl Runner for ModelReview {
    fn capability_id(&self) -> &str {
        CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        request: DispatchRequest,
        _: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        let preview = preview_from_input(&request.input)?;
        let source = &preview.items[0].source;
        let output = AiSemanticReviewOutput {
            unit_id: source.unit_id,
            target_locale: source.target_locale.clone(),
            rules: vec![AiSemanticReviewRuleResult {
                rule: AiSemanticReviewRule::Meaning,
                findings: vec![AiSemanticReviewFinding {
                    code: "semantic-concern".into(),
                    detail: "A synthetic advisory concern".into(),
                    severity: sdk::FindingSeverity::Warning,
                    location: None,
                    suggestion: None,
                }],
            }],
            usage: None,
            requests: 1,
            usage_incomplete: true,
        };
        sender.send(FixedResult::capture(
            ResultEnvelope {
                plugin: None,
                project_id: request.input.envelope().project_id,
                attempt_id: request.input.envelope().attempt_id,
                item_id: request.item_id,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: request.dispatch_token,
                capability_id: CAPABILITY.into(),
                capability_version: "1".into(),
                outcome: ExecutionState::Succeeded,
                output: Some(serde_json::to_value(output).unwrap()),
                diagnostic: None,
            },
            &request.input,
            request.dispatch_token,
        )?)
    }
}
#[test]
fn semantic_and_plugin_findings_keep_independent_current_runs_dispositions_and_qa_policy() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "😀same");
    let p = project(&store);
    let selected = choice(&store, unit, false);
    let prepared = prepare(
        &store,
        unit,
        ExecutionId::new(),
        std::slice::from_ref(&selected),
    );
    let mut qa_runtime = joint_runtime(&store, &prepared, Response::Finding);
    let (_, origins) = execute_all(&mut qa_runtime, &mut store, &prepared);
    let computed = store
        .capture_review_check_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let qa = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    let before = store.review_findings(p, unit, "zh-CN", 0, 10).unwrap();
    assert_eq!(before.findings.len(), 1);
    let qa_issue = before.findings[0].finding.issue_id.clone();
    let request = ReviewFindingWrite {
        project_id: p,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        expected_basis: qa.basis.clone(),
        run_id: qa.run_id,
        issue_id: qa_issue,
        expected_decision_id: None,
        disposition: ReviewFindingDisposition::Rejected,
        actor: "Synthetic reviewer".into(),
        reason: "Known plugin false positive".into(),
    };
    let qa_decision = store.write_review_finding(&request).unwrap();
    let qualification = store.review_eligibility(p, &["zh-CN".into()]).unwrap();
    let config = AiConfig {
        endpoint: "https://example.invalid/v1/chat/completions".into(),
        model: "synthetic-review".into(),
        credential_env: String::new(),
        ..Default::default()
    };
    let semantic = store
        .prepare_ai_semantic_review(
            config,
            &[AiSemanticReviewTarget {
                unit_id: unit,
                locale: "zh-CN".into(),
            }],
            &[AiSemanticReviewRule::Meaning],
        )
        .unwrap();
    let input = semantic.input();
    let attempt = input.envelope().attempt_id;
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register_with_policy(Arc::new(ModelReview), RecoveryPolicy::ExternalUnknown)
        .unwrap();
    runtime.submit(&mut store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(&mut store).unwrap();
        let progress = runtime.attempt(&store, attempt).unwrap().progress;
        if progress.queued == 0 && progress.running == 0 {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let result = store
        .execution_current_result(attempt, input.envelope().items[0].item_id)
        .unwrap()
        .unwrap();
    let action = store
        .prepare_adoption(
            attempt,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::Value::Null,
        )
        .unwrap();
    store
        .adopt_execution(&action, &AiSemanticReviewAdoptionHandler)
        .unwrap();
    let ai = store
        .read_ai_semantic_review(p, unit, "zh-CN")
        .unwrap()
        .unwrap();
    let combined = store.review_findings(p, unit, "zh-CN", 0, 10).unwrap();
    assert_eq!(
        (combined.run_id, combined.semantic_run_id),
        (Some(qa.run_id), Some(ai.run_id))
    );
    assert_eq!(combined.findings.len(), 2);
    let plugin = combined
        .findings
        .iter()
        .find(|f| f.purpose == ReviewRunPurpose::Qa)
        .unwrap();
    assert_eq!(plugin.run_id, qa.run_id);
    assert_eq!(plugin.decision.as_ref(), Some(&qa_decision));
    assert!(plugin.ai_origin.is_none());
    let semantic = combined
        .findings
        .iter()
        .find(|f| f.purpose == ReviewRunPurpose::AiSemantic)
        .unwrap();
    assert_eq!(semantic.run_id, ai.run_id);
    assert_eq!(semantic.ai_origin.as_ref(), Some(&ai.evidence));
    let mut disposition = request.clone();
    disposition.action_id = ExecutionId::new();
    disposition.issue_id = semantic.finding.issue_id.clone();
    assert_eq!(
        store.write_review_finding(&disposition).unwrap_err().code,
        ErrorCode::Unauthorized,
        "an AI issue cannot borrow the current QA run"
    );
    disposition.run_id = ai.run_id;
    let ai_decision = store.write_review_finding(&disposition).unwrap();
    assert_eq!(ai_decision.purpose, ReviewRunPurpose::AiSemantic);
    assert_eq!(
        store.review_target(p, unit, "zh-CN").unwrap().current_check,
        Some(qa.clone())
    );
    assert_eq!(
        store.review_eligibility(p, &["zh-CN".into()]).unwrap(),
        qualification
    );
    assert!(qa.evidence.as_ref().unwrap().required_checks.requirements.iter().all(|r|!matches!(&r.key.implementation,sdk::CheckImplementation::Core {validator} if validator.id=="tsumugi.ai-semantic-review")));
    let prepared = prepare(&store, unit, ExecutionId::new(), &[selected]);
    let mut qa_runtime = joint_runtime(&store, &prepared, Response::Finding);
    let (_, origins) = execute_all(&mut qa_runtime, &mut store, &prepared);
    let computed = store
        .capture_review_check_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let next_qa = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    let view = store.review_findings(p, unit, "zh-CN", 0, 10).unwrap();
    assert_eq!(
        (view.run_id, view.semantic_run_id),
        (Some(next_qa.run_id), Some(ai.run_id))
    );
    assert_eq!(
        view.findings
            .iter()
            .find(|f| f.purpose == ReviewRunPurpose::AiSemantic)
            .unwrap()
            .decision
            .as_ref(),
        Some(&ai_decision)
    );
}
