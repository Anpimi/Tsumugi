use super::*;
use crate::persistence::application::tests::{config, consent, fixture};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

struct Dormant;
impl Runner for Dormant {
    fn capability_id(&self) -> &str {
        ai::team::CAPABILITY
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
        Err(ExecutionError::new(
            ErrorCode::OutputInvalid,
            "fixture-not-dispatched",
        ))
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    store: ProjectStore,
    runtime: ExecutionRuntime,
    plan: WorkPlan,
    receipt: WorkPlanReceipt,
    root: PreparedTeamWork,
    members: Vec<TeamExecutionMember>,
}
fn setup() -> Fixture {
    setup_with_runner(Arc::new(Dormant))
}
fn setup_with_runner(runner: Arc<dyn Runner>) -> Fixture {
    setup_with_expiry(runner, 600)
}
fn setup_with_expiry(runner: Arc<dyn Runner>, seconds: u64) -> Fixture {
    let (temp, mut store, units) = fixture();
    let mut root = config();
    root.max_requests = 20;
    root.concurrency = 2;
    let mut member = root.clone();
    member.max_requests = 2;
    member.share_context = false;
    let members = vec![
        TeamExecutionMember {
            member_id: ExecutionId::new(),
            role_version_id: ExecutionId::new(),
            display_name: "Translator".into(),
            role: "Translate within the captured scope.".into(),
            config: member.clone(),
            unit_ids: units.clone(),
            tool_handles: vec![],
            kinds: vec![TeamWorkKind::Translation],
        },
        TeamExecutionMember {
            member_id: ExecutionId::new(),
            role_version_id: ExecutionId::new(),
            display_name: "Reviewer".into(),
            role: "Review exact original evidence.".into(),
            config: member,
            unit_ids: units.clone(),
            tool_handles: vec![],
            kinds: vec![TeamWorkKind::Review, TeamWorkKind::Evidence],
        },
    ];
    let mut options = PlanOptions::default();
    options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV2 {});
    options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 {
        initial_member_id: members[0].member_id,
        initial_unit_id: units[0],
        members: members.clone(),
        limits: TeamExecutionLimits {
            max_activations: 12,
            max_concurrency: 2,
            max_no_progress: 8,
        },
    });
    let plan = store
        .prepare_work_plan(Some(root), "zh-CN", &units, options)
        .unwrap();
    let mut permission = consent(&plan);
    permission.effects = plan.authorization_effects().unwrap();
    permission.expires_at = control::now().unwrap() + seconds;
    let receipt = store.authorize_work_plan(&plan, &permission).unwrap();
    let prepared = store
        .prepare_team_root(receipt.lease, permission.action_id)
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(runner).unwrap();
    runtime.submit_team_work(&mut store, &prepared).unwrap();
    Fixture {
        _temp: temp,
        store,
        runtime,
        plan,
        receipt,
        root: prepared,
        members,
    }
}
fn dispatch(f: &mut Fixture, work: &PreparedTeamWork) -> (DispatchRequest, CapturedTeamAuthor) {
    let request = f
        .store
        .dispatch_execution_item(
            work.receipt().attempt_id,
            work.input().envelope().items[0].item_id,
        )
        .unwrap();
    let author = f.store.capture_team_work_author(&request).unwrap();
    (request, author)
}
fn reserve(f: &mut Fixture, request: &DispatchRequest, author: &CapturedTeamAuthor) {
    let view = f.store.capture_team_work_view(author).unwrap();
    let settings = ai::team::settings(&request.input).unwrap();
    let mut body = serde_json::json!({"model":settings.config.model,"stream":true,"messages":[{"role":"user","content":view.utf8()}]});
    body[&settings.config.token_field] = settings.config.max_output_tokens.into();
    let capture = ai::provider::ProviderRequestCapture {
        body: body.to_string(),
        team_view: None,
        team_work_view: Some(view.view().clone()),
    };
    f.store
        .reserve_provider_request_capture(
            request,
            ExecutionId::new(),
            if settings.binding.is_root() {
                settings.root_request_limit
            } else {
                settings.config.max_requests
            },
            Some(&capture),
        )
        .unwrap();
}
fn finish(f: &mut Fixture, request: &DispatchRequest, outcome: TeamWorkOutcome) {
    let result = FixedResult::capture(
        ResultEnvelope {
            project_id: request.input.envelope().project_id,
            attempt_id: request.input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: ai::team::CAPABILITY.into(),
            capability_version: "1".into(),
            plugin: None,
            outcome: ExecutionState::Succeeded,
            output: Some(
                serde_json::to_value(TeamWorkOutput {
                    outcome,
                    usage: None,
                    requests: 1,
                    usage_incomplete: true,
                })
                .unwrap(),
            ),
            diagnostic: None,
        },
        &request.input,
        request.dispatch_token,
    )
    .unwrap();
    f.store.save_execution_result(&result).unwrap();
    f.store
        .validate_execution_result(
            request.input.envelope().attempt_id,
            result.envelope().result_id,
        )
        .unwrap();
}
fn control(f: &mut Fixture, command: WorkPlanCommand) -> WorkPlanReceipt {
    let current = f.store.work_plan_status(f.plan.plan_id).unwrap();
    f.store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: f.plan.plan_id,
            expected_generation: current.lease.generation,
            command,
            confirmed: false,
            expires_at: None,
        })
        .unwrap()
}
fn recovery(
    f: &Fixture,
    members: Vec<TeamExecutionMember>,
    target: TeamDiscussionTarget,
) -> PrepareTeamRecovery {
    let state = f
        .store
        .read_team_recovery_state(f.plan.project_id, f.plan.plan_id)
        .unwrap();
    PrepareTeamRecovery {
        project_id: f.plan.project_id,
        plan_id: f.plan.plan_id,
        expected_lease: state.lease,
        expected_effective_version: state.effective_version,
        members: members.clone(),
        work: TeamHumanWork {
            work_id: ExecutionId::new(),
            member_id: members[0].member_id,
            target,
            kind: TeamWorkKind::Evidence,
            instructions:
                "Inspect the explicitly shared original evidence, retaining unresolved outcomes."
                    .into(),
            post_ids: vec![],
            prior_work: state.unresolved_work,
        },
    }
}
fn authorization(prepared: &PreparedTeamRecovery) -> AuthorizeTeamRecovery {
    AuthorizeTeamRecovery {
        action_id: ExecutionId::new(),
        digest: prepared.preview().digest.clone(),
        confirmed: true,
        effects: prepared.plan().authorization_effects().unwrap(),
    }
}
fn publication(f: &mut Fixture, author: &CapturedTeamAuthor) -> TeamDiscussionPost {
    let source = f
        .store
        .source_content(author.target().source_snapshot_id, 0, 100)
        .unwrap();
    f.store
        .publish_team_discussion(
            author,
            &PublishTeamDiscussion {
                post_id: ExecutionId::new(),
                target: author.target().clone(),
                kind: TeamDiscussionKind::Note,
                body: "Retain the exact source occurrence when requesting evidence.".into(),
                references: vec![TeamArtifactReference::SourceResult {
                    snapshot_id: author.target().source_snapshot_id,
                    attempt_id: source.attempt_id,
                    result_id: source.result_id,
                }],
                reply_to: None,
                supersedes: None,
            },
        )
        .unwrap()
}
fn read(f: &Fixture) -> TeamExecutionView {
    f.store
        .read_team_execution(&ReadTeamExecution {
            project_id: f.plan.project_id,
            plan_id: f.plan.plan_id,
            after_work: None,
            after_message: None,
            limit: 16,
        })
        .unwrap()
}

#[test]
fn team_recovery_new_human_evidence_retires_initial_member_and_keeps_original_facts() {
    let mut f = setup();
    let root = f.root.clone();
    let (request, author) = dispatch(&mut f, &root);
    reserve(&mut f, &request, &author);
    let post = publication(&mut f, &author);
    let old_message = f
        .store
        .send_team_message(
            &author,
            &SendTeamMessage {
                message_id: ExecutionId::new(),
                recipient_member_id: f.members[1].member_id,
                target: author.target().clone(),
                body: "This old grant did not authorize the next recipient configuration.".into(),
                post_ids: vec![post.publication.post_id],
                cause_message_id: None,
            },
        )
        .unwrap();
    finish(
        &mut f,
        &request,
        TeamWorkOutcome::Translation {
            unit_id: author.target().unit_id,
            target_locale: "zh-CN".into(),
            text: "原始候选".into(),
        },
    );
    control(&mut f, WorkPlanCommand::Pause);
    let before = f
        .store
        .read_team_recovery_state(f.plan.project_id, f.plan.plan_id)
        .unwrap();
    let mut reviewer = f.members[1].clone();
    reviewer.role_version_id = ExecutionId::new();
    reviewer.display_name = "Independent reviewer".into();
    reviewer.config.model = "new-authorized-model".into();
    let mut newcomer = reviewer.clone();
    newcomer.member_id = ExecutionId::new();
    newcomer.role_version_id = ExecutionId::new();
    newcomer.display_name = "Evidence reader".into();
    newcomer.kinds = vec![TeamWorkKind::Evidence];
    let mut change = recovery(
        &f,
        vec![newcomer.clone(), reviewer.clone()],
        author.target().clone(),
    );
    change.work.post_ids.push(post.publication.post_id);
    let sequence = f.store.execution_sequence().unwrap();
    let prepared = f.runtime.prepare_team_recovery(&f.store, &change).unwrap();
    f.runtime.check_team_recovery(&f.store, &prepared).unwrap();
    assert_eq!(f.store.execution_sequence().unwrap(), sequence);
    assert_eq!(prepared.preview().budget, before.budget);
    assert_eq!(prepared.preview().activations, 1);
    assert_eq!(prepared.preview().unconfirmed_completions, 1);
    assert_eq!(
        prepared.preview().retired_member_ids,
        vec![f.members[0].member_id]
    );
    assert!(
        prepared
            .preview()
            .discussion_previews
            .iter()
            .filter(|v| v.target == *author.target())
            .all(|v| v.posts == vec![post.clone()] && !v.artifacts.is_empty())
    );
    let permission = authorization(&prepared);
    let receipt = f
        .runtime
        .authorize_team_recovery(&mut f.store, &prepared, &permission)
        .unwrap();
    assert_eq!(
        f.runtime
            .authorize_team_recovery(&mut f.store, &prepared, &permission)
            .unwrap(),
        receipt
    );
    assert_eq!(
        f.store
            .read_team_recovery_action(f.plan.project_id, &permission)
            .unwrap(),
        Some(receipt.clone())
    );
    let mut conflict = permission.clone();
    conflict.confirmed = false;
    assert_eq!(
        f.store
            .read_team_recovery_action(f.plan.project_id, &conflict)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    conflict.action_id = f.receipt.action_id;
    assert_eq!(
        f.store
            .read_team_recovery_action(f.plan.project_id, &conflict)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let after = f
        .store
        .read_team_recovery_state(f.plan.project_id, f.plan.plan_id)
        .unwrap();
    assert_eq!(after.root_task_id, before.root_task_id);
    assert_eq!(after.expires_at_ms, before.expires_at_ms);
    assert_eq!(after.budget, before.budget);
    assert_eq!(after.activations, before.activations);
    assert!(f.store.check_team_work_author(&author).is_err());
    let human = f
        .store
        .prepare_team_start(receipt.effective_version.lease, receipt.action_id)
        .unwrap();
    assert!(!ai::team::settings(human.input()).unwrap().binding.is_root());
    assert_eq!(
        ai::team::settings(human.input()).unwrap().kind,
        TeamWorkKind::Evidence
    );
    f.runtime.submit_team_work(&mut f.store, &human).unwrap();
    let (_, evidence_author) = dispatch(&mut f, &human);
    let input_view = f.store.capture_team_work_view(&evidence_author).unwrap();
    assert!(input_view.view().messages.is_empty());
    assert_eq!(input_view.view().discussion.posts, vec![post]);
    let child_request = RequestTeamWork {
        intent_id: ExecutionId::new(),
        recipient_member_id: reviewer.member_id,
        target: author.target().clone(),
        kind: TeamWorkKind::Review,
        instructions: "Review the newly authorized evidence work.".into(),
        post_ids: vec![],
        cause_message_id: None,
    };
    let child = f
        .store
        .prepare_team_work(&evidence_author, &child_request)
        .unwrap();
    f.runtime.submit_team_work(&mut f.store, &child).unwrap();
    let (_, review_author) = dispatch(&mut f, &child);
    assert!(
        f.store
            .capture_team_work_view(&review_author)
            .unwrap()
            .view()
            .messages
            .is_empty()
    );
    let old_cause = RequestTeamWork {
        intent_id: ExecutionId::new(),
        recipient_member_id: newcomer.member_id,
        target: author.target().clone(),
        kind: TeamWorkKind::Evidence,
        instructions: "Do not inherit an old message grant.".into(),
        post_ids: vec![],
        cause_message_id: Some(old_message.message_id),
    };
    assert!(
        f.store
            .prepare_team_work(&review_author, &old_cause)
            .is_err()
    );
    let page = read(&f);
    assert_eq!(page.roster, vec![newcomer, reviewer]);
    assert!(
        page.role_versions
            .iter()
            .any(|r| r.request.role_version_id == old_message.recipient_role_version_id)
    );
    let work = page
        .works
        .iter()
        .find(|w| w.receipt.attempt_id == human.receipt().attempt_id)
        .unwrap();
    assert!(work.author.is_none() && work.request.is_none());
    assert!(
        matches!(&work.origin,TeamWorkOrigin::HumanContinuation{action_id,work} if *action_id==receipt.action_id && *work==change.work)
    );
    f.store
        .execution_unknown
        .store(true, std::sync::atomic::Ordering::Release);
    assert_eq!(
        f.store
            .read_team_recovery_action(f.plan.project_id, &permission)
            .unwrap(),
        Some(receipt.clone())
    );
    assert!(!f.store.is_reconciling());
    let directory = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(
        reopened
            .read_team_recovery_action(change.project_id, &permission)
            .unwrap(),
        Some(receipt)
    );
    assert!(
        reopened
            .read_team_execution(&ReadTeamExecution {
                project_id: change.project_id,
                plan_id: change.plan_id,
                after_work: None,
                after_message: None,
                limit: 16
            })
            .is_ok()
    );
    let fresh = ExecutionRuntime::new(&reopened).unwrap();
    assert!(
        !fresh
            .team_recovery_state(&reopened, change.plan_id)
            .unwrap()
            .original_deadline_available
    );
}

#[test]
fn team_recovery_unknown_capture_conflicts_and_missing_live_anchor_do_not_replay() {
    let mut f = setup();
    let root = f.root.clone();
    let (request, author) = dispatch(&mut f, &root);
    reserve(&mut f, &request, &author);
    f.store
        .note_execution_unknown(
            request.input.envelope().attempt_id,
            request.item_id,
            "fixture-unknown",
        )
        .unwrap();
    control(&mut f, WorkPlanCommand::TakeOver);
    let mut members = f.members.clone();
    members.remove(0);
    let mut change = recovery(&f, members.clone(), author.target().clone());
    assert_eq!(change.work.prior_work.len(), 1);
    let mut missing = change.clone();
    missing.work.prior_work.clear();
    assert_eq!(
        f.runtime
            .prepare_team_recovery(&f.store, &missing)
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    let mut wrong = change.clone();
    wrong.work.prior_work[0].input_digest = "0".repeat(64);
    assert!(f.runtime.prepare_team_recovery(&f.store, &wrong).is_err());
    let mut stale = change.clone();
    stale.expected_lease = f.receipt.lease;
    assert!(f.runtime.prepare_team_recovery(&f.store, &stale).is_err());
    let mut expanded = change.clone();
    expanded.members[0].unit_ids.push(ExecutionId::new());
    assert!(
        f.runtime
            .prepare_team_recovery(&f.store, &expanded)
            .is_err()
    );
    let mut renamed = change.clone();
    renamed.members[0].display_name = "Changed without a new role version".into();
    assert_eq!(
        f.runtime
            .prepare_team_recovery(&f.store, &renamed)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    let mut oversized = change.clone();
    oversized.work.instructions = "界".repeat(2731);
    assert!(
        f.runtime
            .prepare_team_recovery(&f.store, &oversized)
            .is_err()
    );
    let mut cumulative = change.clone();
    for _ in 0..7 {
        let mut next = cumulative.members[0].clone();
        next.member_id = ExecutionId::new();
        next.role_version_id = ExecutionId::new();
        cumulative.members.push(next);
    }
    assert_eq!(cumulative.members.len(), 8);
    assert_eq!(
        f.runtime
            .prepare_team_recovery(&f.store, &cumulative)
            .unwrap_err()
            .stage,
        "team-members"
    );
    let mut reused = change.clone();
    reused.work.work_id = root.receipt().intent_id;
    assert_eq!(
        f.runtime
            .prepare_team_recovery(&f.store, &reused)
            .unwrap_err()
            .stage,
        "team-recovery-work"
    );
    let prepared = f.runtime.prepare_team_recovery(&f.store, &change).unwrap();
    let budget = prepared.preview().budget.clone();
    crate::persistence::review::tests::adopt_source(
        &mut f.store,
        br#"{"changed":"New source requires a new plan"}"#,
    );
    assert!(f.runtime.check_team_recovery(&f.store, &prepared).is_err());
    assert!(
        f.runtime
            .authorize_team_recovery(&mut f.store, &prepared, &authorization(&prepared))
            .is_err()
    );
    assert_eq!(
        f.store
            .provider_budget(root.receipt().task_id)
            .unwrap()
            .unwrap(),
        budget
    );
    change.work.work_id = ExecutionId::new();
    let fresh = ExecutionRuntime::new(&f.store).unwrap();
    assert_eq!(
        fresh
            .prepare_team_recovery(&f.store, &change)
            .unwrap_err()
            .stage,
        "team-recovery-live-anchor"
    );
    control(&mut f, WorkPlanCommand::Stop);
    assert!(f.runtime.prepare_team_recovery(&f.store, &change).is_err());
    let directory = f.store.directory().to_owned();
    drop(fresh);
    drop(f.runtime);
    drop(f.store);
    let reopened = ProjectStore::open(directory).unwrap();
    assert!(
        reopened
            .read_team_recovery_state(change.project_id, change.plan_id)
            .unwrap()
            .unresolved_work
            .iter()
            .any(|r| r.attempt_id == root.receipt().attempt_id)
    );
}

struct Held {
    calls: mpsc::Sender<(DispatchRequest, mpsc::Sender<()>)>,
}
impl Runner for Held {
    fn capability_id(&self) -> &str {
        ai::team::CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        request: DispatchRequest,
        _: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let result = FixedResult::capture(
            ResultEnvelope {
                project_id: request.input.envelope().project_id,
                attempt_id: request.input.envelope().attempt_id,
                item_id: request.item_id,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: request.dispatch_token,
                capability_id: ai::team::CAPABILITY.into(),
                capability_version: "1".into(),
                plugin: None,
                outcome: ExecutionState::Succeeded,
                output: Some(
                    serde_json::to_value(TeamWorkOutput {
                        outcome: TeamWorkOutcome::Translation {
                            unit_id: ai::item_payload(&request.input, request.item_id)?.unit_id,
                            target_locale: "zh-CN".into(),
                            text: "Terminal result with an owned producer".into(),
                        },
                        usage: None,
                        requests: 1,
                        usage_incomplete: true,
                    })
                    .unwrap(),
                ),
                diagnostic: None,
            },
            &request.input,
            request.dispatch_token,
        )?;
        results.send(result)?;
        let (release, wait) = mpsc::channel();
        self.calls.send((request, release)).unwrap();
        let _ = wait.recv();
        Ok(())
    }
}
#[test]
fn team_recovery_terminal_task_is_not_live_producer_drain() {
    let (calls, received) = mpsc::channel();
    let mut f = setup_with_runner(Arc::new(Held { calls }));
    f.runtime.tick(&mut f.store).unwrap();
    let (request, release) = received.recv_timeout(Duration::from_secs(3)).unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        f.runtime.tick(&mut f.store).unwrap();
        if f.store
            .execution_attempt(request.input.envelope().attempt_id, true)
            .unwrap()
            .items[0]
            .execution
            == ExecutionState::Succeeded
        {
            break;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(2));
    }
    control(&mut f, WorkPlanCommand::Pause);
    let target = team::target(&request.input, request.item_id).unwrap();
    let change = recovery(&f, vec![f.members[1].clone()], target);
    let state = f
        .runtime
        .team_recovery_state(&f.store, f.plan.plan_id)
        .unwrap();
    assert!(state.original_deadline_available && !state.producers_drained);
    assert_eq!(
        f.runtime
            .prepare_team_recovery(&f.store, &change)
            .unwrap_err()
            .stage,
        "team-recovery-producers"
    );
    release.send(()).unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    while !f
        .runtime
        .team_recovery_state(&f.store, f.plan.plan_id)
        .unwrap()
        .producers_drained
    {
        f.runtime.tick(&mut f.store).unwrap();
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(2));
    }
    f.runtime.prepare_team_recovery(&f.store, &change).unwrap();
}

struct Unrelated(mpsc::Sender<()>);
impl Runner for Unrelated {
    fn capability_id(&self) -> &str {
        "fixture-unrelated"
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
        self.0.send(()).unwrap();
        Ok(())
    }
}
#[test]
fn team_recovery_expired_queued_work_does_not_starve_unrelated_work() {
    let mut f = setup_with_expiry(Arc::new(Dormant), 1);
    let (sent, received) = mpsc::channel();
    f.runtime
        .register_read_only(Arc::new(Unrelated(sent)))
        .unwrap();
    let mut other = f.root.input().envelope().clone();
    other.task_id = ExecutionId::new();
    other.attempt_id = ExecutionId::new();
    other.automation = None;
    other.operation = "fixture-unrelated".into();
    other.capability_id = "fixture-unrelated".into();
    other.settings = serde_json::json!({});
    other.limits.timeout_ms = 60_000;
    let other = FixedInput::capture(other).unwrap();
    f.runtime.submit(&mut f.store, &other).unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    while f
        .runtime
        .team_recovery_state(&f.store, f.plan.plan_id)
        .unwrap()
        .original_deadline_available
    {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(2));
    }
    f.runtime.tick(&mut f.store).unwrap();
    received.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        f.store
            .execution_attempt(f.root.receipt().attempt_id, true)
            .unwrap()
            .items[0]
            .execution,
        ExecutionState::CancelledBeforeDispatch
    );
    assert_eq!(
        f.store.work_plan_status(f.plan.plan_id).unwrap().state,
        WorkPlanState::Stopped
    );
    assert!(
        !f.runtime
            .team_recovery_state(&f.store, f.plan.plan_id)
            .unwrap()
            .original_deadline_available
    );
}
