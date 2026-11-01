//! Registered IPC and the real Core ledger, with synthetic completed work only.
use super::*;
use tsumugi_core::ai::semantic_review::{
    AiSemanticReviewFinding, AiSemanticReviewRule, AiSemanticReviewRuleResult,
};
use tsumugi_core::application::*;
use tsumugi_core::execution::{Cancellation, ResultSender, Runner};

struct FindingFixtureRunner;
impl Runner for FindingFixtureRunner {
    fn capability_id(&self) -> &str {
        tsumugi_core::ai::team::CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("the finding fixture must never dispatch a producer")
    }
}

fn complete(
    store: &mut ProjectStore,
    request: &DispatchRequest,
    outcome: TeamWorkOutcome,
) -> ExecutionId {
    let envelope = request.input.envelope();
    let output = FixedResult::capture(
        ResultEnvelope {
            project_id: envelope.project_id,
            attempt_id: envelope.attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: envelope.capability_id.clone(),
            capability_version: envelope.capability_version.clone(),
            plugin: None,
            outcome: ExecutionState::Succeeded,
            output: Some(json!(TeamWorkOutput {
                outcome,
                usage: None,
                requests: 1,
                usage_incomplete: true
            })),
            diagnostic: None,
        },
        &request.input,
        request.dispatch_token,
    )
    .unwrap();
    store.save_execution_result(&output).unwrap();
    store
        .validate_execution_result(envelope.attempt_id, output.envelope().result_id)
        .unwrap();
    output.envelope().result_id
}

#[test]
fn registered_team_findings_keep_original_result_adoption_disposition_and_read_after_reopen() {
    let mut fixture = Fixture::create();
    let selection=fixture.call("save_translation_revision",json!({"actionId":ExecutionId::new(),"unitId":fixture.unit,
        "locale":"zh-CN","sourceRevisionId":fixture.source_revision,"expectedSelectionId":null,"text":"Selected translation"})).unwrap();
    fixture.reopen();
    let unit = fixture.unit;
    let (plan, attempt, result) = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_mut().unwrap();
            assert!(active.execution.is_none());
            let store = &mut active.store;
            let mut queue = ExecutionRuntime::new(store).unwrap();
            queue
                .register(std::sync::Arc::new(FindingFixtureRunner))
                .unwrap();
            let config = AiConfig {
                endpoint: "https://example.invalid/v1/chat/completions".into(),
                model: "synthetic-team-review".into(),
                credential_env: String::new(),
                max_requests: 8,
                concurrency: 1,
                ..Default::default()
            };
            let translator = TeamExecutionMember {
                member_id: ExecutionId::new(),
                role_version_id: ExecutionId::new(),
                display_name: "Translator".into(),
                role: "Prepare a candidate and request review.".into(),
                config: AiConfig {
                    max_requests: 1,
                    ..config.clone()
                },
                unit_ids: vec![unit],
                tool_handles: vec![],
                kinds: vec![TeamWorkKind::Translation],
            };
            let reviewer = TeamExecutionMember {
                member_id: ExecutionId::new(),
                role_version_id: ExecutionId::new(),
                display_name: "Reviewer".into(),
                role: "Inspect the cited original translation.".into(),
                config: AiConfig {
                    max_requests: 1,
                    ..config.clone()
                },
                unit_ids: vec![unit],
                tool_handles: vec![],
                kinds: vec![TeamWorkKind::Review],
            };
            let mut options = PlanOptions::default();
            options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV2 {});
            options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 {
                initial_member_id: translator.member_id,
                initial_unit_id: unit,
                members: vec![translator, reviewer.clone()],
                limits: TeamExecutionLimits {
                    max_activations: 8,
                    max_concurrency: 1,
                    max_no_progress: 8,
                },
            });
            let plan = store
                .prepare_work_plan(Some(config), "zh-CN", &[unit], options)
                .unwrap();
            let action_id = ExecutionId::new();
            let receipt = store
                .authorize_work_plan(
                    &plan,
                    &AuthorizeWorkPlan {
                        action_id,
                        plan_digest: plan.digest.clone(),
                        confirmed: true,
                        effects: plan.authorization_effects().unwrap(),
                        expires_at: SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_secs()
                            + 600,
                    },
                )
                .unwrap();
            let root = store.prepare_team_root(receipt.lease, action_id).unwrap();
            queue.submit_team_work(store, &root).unwrap();
            let root = store
                .dispatch_execution_item(
                    root.receipt().attempt_id,
                    root.input().envelope().items[0].item_id,
                )
                .unwrap();
            let author = store.capture_team_work_author(&root).unwrap();
            let selected = store
                .review_target(plan.project_id, unit, "zh-CN")
                .unwrap()
                .revision_id
                .unwrap();
            let cited = store
                .publish_team_discussion(
                    &author,
                    &PublishTeamDiscussion {
                        post_id: ExecutionId::new(),
                        target: author.target().clone(),
                        kind: TeamDiscussionKind::Note,
                        body: "Review the cited selected version.".into(),
                        references: vec![TeamArtifactReference::TranslationRevision {
                            revision_id: selected,
                        }],
                        reply_to: None,
                        supersedes: None,
                        question: None,
                    },
                )
                .unwrap();
            let work = store
                .prepare_team_work(
                    &author,
                    &RequestTeamWork {
                        intent_id: ExecutionId::new(),
                        recipient_member_id: reviewer.member_id,
                        target: author.target().clone(),
                        kind: TeamWorkKind::Review,
                        instructions: "Review this exact immutable translation.".into(),
                        post_ids: vec![cited.publication.post_id],
                        cause_message_id: None,
                    },
                )
                .unwrap();
            queue.submit_team_work(store, &work).unwrap();
            let request = store
                .dispatch_execution_item(
                    work.receipt().attempt_id,
                    work.input().envelope().items[0].item_id,
                )
                .unwrap();
            let author = store.capture_team_work_author(&request).unwrap();
            let reason = store
                .publish_team_discussion(
                    &author,
                    &PublishTeamDiscussion {
                        post_id: ExecutionId::new(),
                        target: author.target().clone(),
                        kind: TeamDiscussionKind::Challenge,
                        body: "The selected translation needs a meaning check.".into(),
                        references: vec![TeamArtifactReference::TranslationRevision {
                            revision_id: selected,
                        }],
                        reply_to: None,
                        supersedes: None,
                        question: None,
                    },
                )
                .unwrap();
            let result = complete(
                store,
                &request,
                TeamWorkOutcome::Review {
                    reviewed: TeamReviewBasis::Artifact {
                        reference: TeamArtifactReference::TranslationRevision {
                            revision_id: selected,
                        },
                    },
                    post_ids: vec![reason.publication.post_id],
                    verdict: TeamReviewVerdict::Revise,
                    report: Some(TeamReviewReport {
                        summary: "A synthetic meaning concern.".into(),
                        rules: vec![
                            AiSemanticReviewRuleResult {
                                rule: AiSemanticReviewRule::Meaning,
                                findings: vec![AiSemanticReviewFinding {
                                    code: "meaning-shift".into(),
                                    detail: "Synthetic team finding".into(),
                                    severity: sdk::FindingSeverity::Warning,
                                    location: Some(sdk::TextReviewLocation {
                                        field: sdk::TextReviewField::Translation,
                                        range: sdk::TextRange {
                                            encoding: sdk::TextEncoding::Utf8Byte,
                                            start: 0,
                                            end: 8,
                                        },
                                    }),
                                    suggestion: None,
                                }],
                            },
                            AiSemanticReviewRuleResult {
                                rule: AiSemanticReviewRule::Style,
                                findings: vec![],
                            },
                        ],
                    }),
                },
            );
            complete(
                store,
                &root,
                TeamWorkOutcome::Translation {
                    unit_id: unit,
                    target_locale: "zh-CN".into(),
                    text: "Retained unselected candidate".into(),
                },
            );
            (plan, request.input.envelope().attempt_id, result)
        });
    let original = fixture
        .call("read_ai_semantic_review", json!({"attemptId":attempt}))
        .unwrap();
    assert_eq!(original["view"]["preview"]["recipe"], "team-review-1");
    assert_eq!(
        original["view"]["rows"][0]["item"]["translationRevisionId"],
        selection["revision"]["revisionId"]
    );
    assert_eq!(
        original["view"]["detail"]["items"][0]["resultId"],
        json!(result)
    );
    let unit = &original["view"]["detail"]["recovery"]["units"][0];
    let action_id = ExecutionId::new();
    let adoption_request = json!({"attemptId":attempt,"unitId":unit["unitId"],"resultIds":[result],"actionId":action_id});
    fixture
        .call("prepare_execution_adoption", adoption_request.clone())
        .unwrap();
    let receipt = fixture
        .call("adopt_execution", json!({"actionId":action_id}))
        .unwrap();
    let recorded = fixture
        .call("read_ai_semantic_review", json!({"attemptId":attempt}))
        .unwrap();
    let run = recorded["view"]["rows"][0]["run"].clone();
    assert_eq!(run["evidence"]["resultId"], json!(result));
    let findings = fixture
        .call(
            "read_review_findings",
            json!({"unitId":fixture.unit,"locale":"zh-CN","offset":0,"limit":20}),
        )
        .unwrap();
    assert!(findings["runId"].is_null());
    assert_eq!(findings["semanticRunId"], run["runId"]);
    let request = json!({"projectId":fixture.context["projectId"],"actionId":ExecutionId::new(),"unitId":fixture.unit,"locale":"zh-CN",
        "expectedBasis":findings["basis"],"runId":run["runId"],"issueId":findings["findings"][0]["finding"]["issueId"],
        "expectedDecisionId":null,"disposition":"rejected","actor":"local-user","reason":"A checked false positive"});
    let decision = fixture
        .call("write_review_finding", json!({"finding":request}))
        .unwrap();
    assert_eq!(decision["aiOrigin"], run["evidence"]);
    let location=fixture.call("read_review_diagnostic_location",json!({"unitId":fixture.unit,"locale":"zh-CN","runId":run["runId"],"diagnostic":run["diagnostics"][0]})).unwrap();
    assert_eq!(location["location"]["range"]["encoding"], "utf16");
    let page = fixture
        .call(
            "read_work_plan_team_execution",
            json!({"planId":plan.plan_id,"afterWork":null,"afterMessage":null,"limit":16}),
        )
        .unwrap();
    assert_eq!(page["works"][1]["resultId"], json!(result));
    fixture.reopen();
    assert_eq!(
        fixture
            .call("read_ai_semantic_review", json!({"attemptId":attempt}))
            .unwrap()["view"]["rows"][0]["run"],
        run
    );
    assert_eq!(
        fixture
            .call(
                "read_execution_adoption_action",
                adoption_request
            )
            .unwrap()["receipt"],
        receipt
    );
}
