use super::*;
use tsumugi_core::application::{AskHumanQuestion, TeamDiscussionPolicy, TeamExecutionLimits,
    TeamExecutionMember, TeamExecutionPolicy, TeamQuestionPolicy, TeamWorkKind};
use tsumugi_core::execution::{Cancellation, ResultSender, Runner};

struct QuestionFixtureRunner;
impl Runner for QuestionFixtureRunner {
    fn capability_id(&self) -> &str { tsumugi_core::ai::team::CAPABILITY }
    fn capability_version(&self) -> &str { "1" }
    fn run(&self, _: DispatchRequest, _: Cancellation, _: ResultSender) -> Result<(), ExecutionError> {
        panic!("the registered question fixture must not run a producer")
    }
}

#[test]
fn registered_team_question_can_be_answered_after_stop_without_initializing_host() {
    let mut fixture = Fixture::create();
    fixture.reopen();
    let unit = fixture.unit;
    let (plan, lease, question) = fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        let store = &mut active.store;
        let mut queue = ExecutionRuntime::new(store).unwrap();
        queue.register(std::sync::Arc::new(QuestionFixtureRunner)).unwrap();
        let config = AiConfig { endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
            model: "synthetic-question".into(), credential_env: String::new(), max_requests: 8,
            concurrency: 1, ..Default::default() };
        let member = TeamExecutionMember { member_id: ExecutionId::new(), role_version_id: ExecutionId::new(),
            display_name: "Translator".into(), role: "Translate this entry and ask for the human decision.".into(),
            config: AiConfig { max_requests: 1, ..config.clone() }, unit_ids: vec![unit], tool_handles: vec![],
            kinds: vec![TeamWorkKind::Translation] };
        let mut options = PlanOptions::default();
        options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV1 {});
        options.team_questions = Some(TeamQuestionPolicy::CurrentPlanV1 {});
        options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 { initial_member_id: member.member_id,
            initial_unit_id: unit, members: vec![member], limits: TeamExecutionLimits {
                max_activations: 8, max_concurrency: 1, max_no_progress: 8 } });
        let plan = store.prepare_work_plan(Some(config), "zh-CN", &[unit], options).unwrap();
        let action_id = ExecutionId::new();
        let receipt = store.authorize_work_plan(&plan, &AuthorizeWorkPlan { action_id,
            plan_digest: plan.digest.clone(), confirmed: true, effects: plan.authorization_effects().unwrap(),
            expires_at: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() + 600 }).unwrap();
        let prepared = store.prepare_team_root(receipt.lease, action_id).unwrap();
        queue.submit_team_work(store, &prepared).unwrap();
        let dispatch = store.dispatch_execution_item(prepared.receipt().attempt_id,
            prepared.input().envelope().items[0].item_id).unwrap();
        let author = store.capture_team_work_author(&dispatch).unwrap();
        let question = store.ask_human_question(&author, &AskHumanQuestion { post_id: ExecutionId::new(),
            target: author.target().clone(), body: "Which voice should this entry use?".into(), options: vec![], references: vec![] }).unwrap();
        (plan, receipt.lease, question)
    });
    let original = fixture.call("read_work_plan_team_question", json!({"planId":plan.plan_id,
        "questionPostId":question.publication.post_id})).unwrap();
    assert_eq!(original["state"], "open");
    assert_eq!(original["question"], json!(question));
    let page = fixture.call("read_work_plan_team_questions", json!({"planId":plan.plan_id,"after":null,"limit":16})).unwrap();
    assert_eq!(page["questions"], json!([original]));
    let plan_id = plan.plan_id;
    fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        active.store.control_work_plan(&ControlWorkPlan { action_id: ExecutionId::new(), plan_id,
            expected_generation: lease.generation, command: WorkPlanCommand::Stop, confirmed: false, expires_at: None }).unwrap();
        assert!(active.execution.is_none());
    });
    let response = json!({"planId":plan.plan_id,"response":{"postId":ExecutionId::new(),
        "questionPostId":question.publication.post_id,"response":{"kind":"text","body":"Keep the formal voice and preserve {name}."}}});
    let saved = fixture.call("respond_work_plan_team_question", response.clone()).unwrap();
    assert_eq!(saved["author"], json!({"kind":"local-human","actor":"local-user"}));
    assert_eq!(saved["publication"]["question"]["kind"], "resolve");
    let settled = fixture.call("read_work_plan_team_question_response_settlement", response).unwrap();
    assert_eq!(settled["outcome"]["kind"], "recorded");
    assert_eq!(settled["outcome"]["receipt"], saved);
    let resolved = fixture.call("read_work_plan_team_question", json!({"planId":plan.plan_id,
        "questionPostId":question.publication.post_id})).unwrap();
    assert_eq!(resolved["state"], "resolved");
    assert_eq!(resolved["response"], saved);
    fixture.app.state::<AppState>().sessions.with(|sessions| assert!(sessions.active.as_ref().unwrap().execution.is_none()));
}
