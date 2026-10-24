//! Pure history uses the original broker, grants and execution records.
use super::*;

struct UncalledTeam;
impl Runner for UncalledTeam {
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
        panic!("history never invokes a member")
    }
}
fn setup() -> (
    Fixture,
    PreparedTeamWork,
    CapturedTeamAuthor,
    CapturedTeamAuthor,
) {
    let (fixture, root, author, other, _) = setup_with_guidance(None);
    (fixture, root, author, other)
}
pub(super) fn setup_with_guidance(
    guidance: Option<ToolGuidancePolicy>,
) -> (
    Fixture,
    PreparedTeamWork,
    CapturedTeamAuthor,
    CapturedTeamAuthor,
    DispatchRequest,
) {
    let (temp, mut store, rows) = support::source_fixture();
    let units: Vec<_> = rows.iter().map(|row| row.unit_id.unwrap()).collect();
    let selected = tool();
    let config = AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "captured-team-model".into(),
        credential_env: String::new(),
        concurrency: 2,
        ..AiConfig::default()
    };
    let member = TeamExecutionMember {
        member_id: ExecutionId::new(),
        role_version_id: ExecutionId::new(),
        display_name: "Original member".into(),
        role: "Use only captured tools.".into(),
        config: config.clone(),
        unit_ids: units.clone(),
        tool_handles: vec![selected.handle],
        kinds: vec![TeamWorkKind::Translation, TeamWorkKind::Evidence],
    };
    let other = TeamExecutionMember {
        member_id: ExecutionId::new(),
        role_version_id: ExecutionId::new(),
        display_name: "Other member".into(),
        ..member.clone()
    };
    let mut options = PlanOptions::default();
    options.tool_guidance = guidance;
    options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV1 {});
    options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 {
        initial_member_id: member.member_id,
        initial_unit_id: units[0],
        members: vec![member, other.clone()],
        limits: TeamExecutionLimits {
            max_activations: 12,
            max_concurrency: 2,
            max_no_progress: 8,
        },
    });
    let plan = store
        .prepare_work_plan_with_tools(
            Some(config),
            "zh-CN",
            &units,
            options,
            Some(WorkPlanTools {
                max_invocations: 40,
                entries: vec![selected.clone()],
            }),
        )
        .unwrap();
    let permission = AuthorizeWorkPlan {
        action_id: ExecutionId::new(),
        plan_digest: plan.digest.clone(),
        confirmed: true,
        effects: plan.authorization_effects().unwrap(),
        expires_at: now_ms() / 1000 + 600,
    };
    let receipt = store.authorize_work_plan(&plan, &permission).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(UncalledTeam)).unwrap();
    runtime
        .register(Arc::new(UncalledPlugin(selected)))
        .unwrap();
    let consent = runtime
        .authorize_work_plan_tools(
            &store,
            receipt.lease,
            now_ms() + 60_000,
            Instant::now() + Duration::from_secs(60),
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: false,
            },
            Default::default(),
        )
        .unwrap();
    let root = store
        .prepare_team_root(receipt.lease, permission.action_id)
        .unwrap();
    runtime.submit_team_work(&mut store, &root).unwrap();
    let dispatched = store
        .dispatch_execution_item(
            root.receipt().attempt_id,
            root.input().envelope().items[0].item_id,
        )
        .unwrap();
    let author = store.capture_team_work_author(&dispatched).unwrap();
    let root_dispatch = dispatched;
    let child = store
        .prepare_team_work(
            &author,
            &RequestTeamWork {
                intent_id: ExecutionId::new(),
                recipient_member_id: other.member_id,
                target: author.target().clone(),
                kind: TeamWorkKind::Evidence,
                instructions: "Independent captured work.".into(),
                post_ids: vec![],
                cause_message_id: None,
            },
        )
        .unwrap();
    runtime.submit_team_work(&mut store, &child).unwrap();
    let dispatched = store
        .dispatch_execution_item(
            child.receipt().attempt_id,
            child.input().envelope().items[0].item_id,
        )
        .unwrap();
    let other = store.capture_team_work_author(&dispatched).unwrap();
    let f = Fixture {
        _temp: temp,
        store,
        runtime,
        plan,
        lease: receipt.lease,
        scope: author.scope().clone(),
        consent,
        units,
    };
    (f, root, author, other, root_dispatch)
}
fn enqueue(f: &mut Fixture, author: &CapturedTeamAuthor) -> PreparedWorkPlanTool {
    let write = AgentToolRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        tool_handle: f.plan.tools.as_ref().unwrap().entries[0].handle,
        unit_ids: vec![author.target().unit_id],
    };
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(author.scope(), &write)
        .unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, ExecutionId::new())
        .unwrap();
    prepared
}
fn reference(work: &PreparedTeamWork) -> TeamWorkReference {
    TeamWorkReference {
        task_id: work.receipt().task_id,
        attempt_id: work.receipt().attempt_id,
        input_digest: work.receipt().input_digest.clone(),
    }
}
fn read(f: &Fixture, work: &PreparedTeamWork, limit: u32) -> ReadTeamWorkTools {
    ReadTeamWorkTools {
        project_id: f.plan.project_id,
        plan_id: f.plan.plan_id,
        work: reference(work),
        after: None,
        limit,
    }
}
#[test]
fn team_tool_history_filters_original_work_before_paging_and_survives_revocation_source_change_and_reopen()
 {
    let (mut f, root, author, other) = setup();
    for _ in 0..17 {
        enqueue(&mut f, &other);
    }
    let saved = enqueue(&mut f, &author);
    let request = f
        .store
        .dispatch_execution_item(
            saved.input().envelope().attempt_id,
            saved.input().envelope().items[0].item_id,
        )
        .unwrap();
    let result = successful_plugin_result(&request);
    f.store.save_execution_result(&result).unwrap();
    let unknown = enqueue(&mut f, &author);
    let request = f
        .store
        .dispatch_execution_item(
            unknown.input().envelope().attempt_id,
            unknown.input().envelope().items[0].item_id,
        )
        .unwrap();
    f.store
        .note_execution_unknown(
            request.input.envelope().attempt_id,
            request.item_id,
            "original-tool-unknown",
        )
        .unwrap();
    // Another caller between matches must not consume a page position.
    enqueue(&mut f, &other);
    let queued = enqueue(&mut f, &author);
    let request = read(&f, &root, 1);
    let before = f.store.execution_sequence().unwrap();
    let invocations = f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap();
    let budget = f.store.provider_budget(root.receipt().task_id).unwrap();
    let first = f.store.read_team_work_tools(&request).unwrap();
    assert_eq!(first.work, reference(&root));
    assert_eq!(first.project_id, f.plan.project_id);
    assert_eq!(first.plan_id, f.plan.plan_id);
    assert_eq!(first.attempts.len(), 1);
    let entry = &first.attempts[0];
    assert_eq!(
        entry.reference.attempt_id,
        saved.input().envelope().attempt_id
    );
    assert_eq!(entry.reference.task_id, saved.input().envelope().task_id);
    assert_eq!(entry.reference.input_digest, saved.input().digest());
    assert_eq!(entry.stored_result_items, 1);
    assert_eq!(entry.progress.succeeded, 1);
    assert_eq!(
        entry.name,
        f.plan.tools.as_ref().unwrap().entries[0]
            .binding
            .declaration
            .title
    );
    assert_eq!(entry.unit_ids, vec![author.target().unit_id]);
    let second = f
        .store
        .read_team_work_tools(&ReadTeamWorkTools {
            after: first.next_after,
            ..request.clone()
        })
        .unwrap();
    assert_eq!(
        second.attempts[0].reference.attempt_id,
        unknown.input().envelope().attempt_id
    );
    assert_eq!(second.attempts[0].stored_result_items, 0);
    assert_eq!(second.attempts[0].progress.unknown, 1);
    assert!(second.attempts[0].sequence > entry.sequence);
    let third = f
        .store
        .read_team_work_tools(&ReadTeamWorkTools {
            after: second.next_after,
            ..request.clone()
        })
        .unwrap();
    assert_eq!(
        third.attempts[0].reference.attempt_id,
        queued.input().envelope().attempt_id
    );
    assert!(third.next_after.is_none());
    assert_eq!(f.store.execution_sequence().unwrap(), before);
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        invocations
    );
    assert_eq!(
        f.store.provider_budget(root.receipt().task_id).unwrap(),
        budget
    );
    f.store
        .control_work_plan(&control(&f, WorkPlanCommand::Pause))
        .unwrap();
    assert_eq!(f.store.read_team_work_tools(&request).unwrap(), first);
    f.store
        .control_work_plan(&control(&f, WorkPlanCommand::Stop))
        .unwrap();
    let old_source = f.store.content_scope().unwrap().current_snapshot;
    let adoption = prepare_source_reimport(&mut f);
    f.store
        .adopt_execution(&adoption, &tsumugi_core::content::SourceAdoptionHandler)
        .unwrap();
    assert_ne!(
        f.store.content_scope().unwrap().current_snapshot,
        old_source
    );
    assert_eq!(f.store.read_team_work_tools(&request).unwrap(), first);
    let directory = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(reopened.read_team_work_tools(&request).unwrap(), first);
    let full = reopened
        .read_team_work_tools(&ReadTeamWorkTools {
            limit: 16,
            ..request
        })
        .unwrap();
    assert_eq!(full.attempts.len(), 3);
    assert_eq!(full.attempts[1].progress.unknown, 1);
    assert_eq!(full.attempts[1].stored_result_items, 0);
    assert!(serde_json::to_vec(&full).unwrap().len() <= MAX_TEAM_PAGE_BYTES);
}

#[test]
fn team_tool_history_rejects_wrong_work_and_damaged_original_associations() {
    let (mut f, root, author, other) = setup();
    let saved = enqueue(&mut f, &author);
    enqueue(&mut f, &other);
    let request = read(&f, &root, 16);
    assert_eq!(
        f.store
            .read_team_work_tools(&request)
            .unwrap()
            .attempts
            .len(),
        1
    );
    for invalid in [
        ReadTeamWorkTools {
            project_id: ExecutionId::new(),
            ..request.clone()
        },
        ReadTeamWorkTools {
            plan_id: ExecutionId::new(),
            ..request.clone()
        },
        ReadTeamWorkTools {
            work: TeamWorkReference {
                task_id: ExecutionId::new(),
                ..request.work.clone()
            },
            ..request.clone()
        },
        ReadTeamWorkTools {
            work: TeamWorkReference {
                input_digest: "0".repeat(64),
                ..request.work.clone()
            },
            ..request.clone()
        },
        ReadTeamWorkTools {
            work: TeamWorkReference {
                task_id: saved.input().envelope().task_id,
                attempt_id: saved.input().envelope().attempt_id,
                input_digest: saved.input().digest().into(),
            },
            ..request.clone()
        },
        ReadTeamWorkTools {
            limit: 0,
            ..request.clone()
        },
        ReadTeamWorkTools {
            limit: 17,
            ..request.clone()
        },
    ] {
        assert!(f.store.read_team_work_tools(&invalid).is_err());
    }
    let mut unknown = serde_json::to_value(&request).unwrap();
    unknown["callerId"] = serde_json::json!(author.scope().caller_id());
    assert!(serde_json::from_value::<ReadTeamWorkTools>(unknown).is_err());
    let connection =
        rusqlite::Connection::open(f.store.directory().join("project.sqlite3")).unwrap();
    let attempt = saved.input().envelope().attempt_id.to_string();
    let bytes: Vec<u8> = connection
        .query_row(
            "SELECT delegation FROM application_executions WHERE attempt_id=?1",
            [&attempt],
            |row| row.get(0),
        )
        .unwrap();
    let mut changed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    changed["callerId"] = json!(ExecutionId::new());
    connection
        .execute(
            "UPDATE application_executions SET delegation=?2 WHERE attempt_id=?1",
            rusqlite::params![attempt, serde_json::to_vec(&changed).unwrap()],
        )
        .unwrap();
    assert!(f.store.read_team_work_tools(&request).is_err());
    connection
        .execute(
            "UPDATE application_executions SET delegation=?2 WHERE attempt_id=?1",
            rusqlite::params![attempt, bytes],
        )
        .unwrap();
    connection
        .execute(
            "DELETE FROM plugin_execution_grants WHERE attempt_id=?1",
            [&attempt],
        )
        .unwrap();
    assert!(f.store.read_team_work_tools(&request).is_err());
}
