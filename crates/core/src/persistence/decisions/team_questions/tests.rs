use super::*;
use crate::{application::*, execution::RecoveryPolicy, persistence::review::tests::current_release_fixture};
use rusqlite::params;

fn fixture(enabled: bool) -> (tempfile::TempDir, ProjectStore, WorkPlan, WorkPlanReceipt, CapturedTeamAuthor) {
    let (directory, mut store, _) = current_release_fixture(false);
    let units = store.source_content(store.content_scope().unwrap().current_snapshot.unwrap(), 0, 10).unwrap()
        .rows.into_iter().map(|row| row.unit_id.unwrap()).collect::<Vec<_>>();
    let root = crate::ai::AiConfig { endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-question".into(), credential_env: String::new(), share_context: true,
        max_requests: 20, concurrency: 1, ..crate::ai::AiConfig::default() };
    let member = TeamExecutionMember { member_id: ExecutionId::new(), role_version_id: ExecutionId::new(),
        display_name: "Translator".into(), role: "Translate and ask for the original human decision.".into(),
        config: crate::ai::AiConfig { max_requests: 1, ..root.clone() }, unit_ids: units.clone(),
        tool_handles: vec![], kinds: vec![TeamWorkKind::Translation] };
    let mut options = PlanOptions::default();
    options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV2 {});
    options.team_questions = enabled.then_some(TeamQuestionPolicy::CurrentPlanV1 {});
    options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 { initial_member_id: member.member_id,
        initial_unit_id: units[0], members: vec![member], limits: TeamExecutionLimits {
            max_activations: 12, max_concurrency: 1, max_no_progress: 12 } });
    let plan = store.prepare_work_plan(Some(root), "zh-CN", &units, options).unwrap();
    let action = ExecutionId::new();
    let receipt = store.authorize_work_plan(&plan, &AuthorizeWorkPlan { action_id: action,
        plan_digest: plan.digest.clone(), confirmed: true, effects: plan.authorization_effects().unwrap(),
        expires_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 600 }).unwrap();
    let prepared = store.prepare_team_root(receipt.lease, action).unwrap();
    store.enqueue_team_work(&prepared, RecoveryPolicy::ExternalUnknown).unwrap();
    let dispatch = store.dispatch_execution_item(prepared.receipt().attempt_id,
        prepared.input().envelope().items[0].item_id).unwrap();
    let author = store.capture_team_work_author(&dispatch).unwrap();
    (directory, store, plan, receipt, author)
}
fn ask(author: &CapturedTeamAuthor) -> AskHumanQuestion {
    AskHumanQuestion { post_id: ExecutionId::new(), target: author.target().clone(),
        body: "Should the original {name} remain formal?".into(), options: vec![], references: vec![] }
}
fn read(store: &ProjectStore, project: ExecutionId) -> DecisionPage {
    store.decision_page(project, &DecisionQuery { locale: None, sources: vec![DecisionSource::AgentQuestion] },
        None, 100, |_| false).unwrap()
}

#[test]
fn explicit_open_questions_survive_stop_and_disappear_only_after_their_own_terminal_post() {
    let (_directory, mut store, plan, receipt, author) = fixture(true);
    let first = ask(&author);
    let second = ask(&author);
    store.ask_human_question(&author, &first).unwrap();
    store.ask_human_question(&author, &second).unwrap();
    store.publish_team_discussion(&author, &PublishTeamDiscussion { post_id: ExecutionId::new(),
        target: author.target().clone(), kind: TeamDiscussionKind::Challenge, body: "An ordinary challenge?".into(),
        references: vec![], reply_to: None, supersedes: None, question: None }).unwrap();
    let before = store.connection().unwrap().total_changes();
    let page = read(&store, plan.project_id);
    assert_eq!((page.known_count, page.total), (2, Some(2)));
    assert_eq!(page.coverage[0].state, DecisionCoverageState::Complete);
    assert_eq!(store.connection().unwrap().total_changes(), before);
    let item = page.items.iter().find(|item| item.source_action_id == Some(first.post_id)).unwrap();
    assert_eq!(item.action, DecisionAction::AnswerTeamQuestion { plan_id: plan.plan_id, question_post_id: first.post_id });
    assert_eq!(item.evidence, Some(DecisionEvidence::TeamQuestion { member_id: author.author().member_id,
        role_version_id: author.author().role_version_id }));
    assert_eq!(item.targets, vec![DecisionTarget::Plan { plan_id: plan.plan_id },
        DecisionTarget::Entry { unit_id: first.target.unit_id }]);
    store.control_work_plan(&ControlWorkPlan { action_id: ExecutionId::new(), plan_id: plan.plan_id,
        expected_generation: receipt.lease.generation, command: WorkPlanCommand::Stop, confirmed: false, expires_at: None }).unwrap();
    assert_eq!(read(&store, plan.project_id).known_count, 2);
    let control_count: i64 = store.connection().unwrap().query_row("SELECT COUNT(*) FROM application_actions", [], |row| row.get(0)).unwrap();
    store.respond_team_question(plan.project_id, plan.plan_id, "local-user", &RespondTeamQuestion {
        post_id: ExecutionId::new(), question_post_id: first.post_id,
        response: TeamQuestionResponse::Text { body: "Keep the formal voice.".into() } }).unwrap();
    let remaining = read(&store, plan.project_id);
    assert_eq!((remaining.known_count, remaining.total), (1, Some(1)));
    assert_eq!(remaining.items[0].source_action_id, Some(second.post_id));
    store.respond_team_question(plan.project_id, plan.plan_id, "local-user", &RespondTeamQuestion {
        post_id: ExecutionId::new(), question_post_id: second.post_id,
        response: TeamQuestionResponse::Dismiss { reason: "No further answer needed.".into() } }).unwrap();
    assert_eq!(read(&store, plan.project_id).total, Some(0));
    let after: i64 = store.connection().unwrap().query_row("SELECT COUNT(*) FROM application_actions", [], |row| row.get(0)).unwrap();
    assert_eq!(after, control_count);
    let path = store.directory().to_path_buf(); store.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(read(&reopened, plan.project_id).total, Some(0));
}

#[test]
fn old_plan_without_question_consent_is_still_verified_before_reporting_zero() {
    let (_directory, store, plan, _receipt, _author) = fixture(false);
    assert_eq!(read(&store, plan.project_id).total, Some(0));
    store.connection().unwrap().execute("UPDATE application_plans SET plan=?1 WHERE plan_id=?2",
        params![b"{}".as_slice(), plan.plan_id.to_string()]).unwrap();
    let page = read(&store, plan.project_id);
    assert_eq!(page.total, None);
    assert_eq!(page.coverage[0].state, DecisionCoverageState::Partial);
    assert_eq!(page.coverage[0].reason, Some(DecisionCoverageReason::SourceUnavailable));
    assert_eq!(page.coverage[0].error_code, Some(ErrorCode::CorruptLedger));
}

#[test]
fn bounded_plan_enumeration_counts_every_plan_and_detects_the_overflow_row() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE application_plans (plan_id TEXT PRIMARY KEY)").unwrap();
    for _ in 0..SOURCE_LIMIT {
        c.execute("INSERT INTO application_plans VALUES(?1)", [ExecutionId::new().to_string()]).unwrap();
    }
    let (plans, complete) = plans_in(&c).unwrap(); assert_eq!(plans.len(), SOURCE_LIMIT); assert!(complete);
    c.execute("INSERT INTO application_plans VALUES(?1)", [ExecutionId::new().to_string()]).unwrap();
    let (plans, complete) = plans_in(&c).unwrap(); assert_eq!(plans.len(), SOURCE_LIMIT); assert!(!complete);
}
