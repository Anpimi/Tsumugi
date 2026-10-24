//! Registered trusted-user IPC uses the real project ledger and synthetic
//! dispatches. No model, plugin process, or external provider is contacted.
use super::*;
use tsumugi_core::application::{
    AgentGenerationRequest, PublishTeamDiscussion, TeamDiscussionKind, TeamDiscussionPolicy,
    TeamDiscussionTarget, TeamMemberRoleWrite,
};

struct Scenario {
    fixture: Fixture,
    plan: WorkPlan,
    lease: AutomationLease,
}

#[test]
fn shared_team_discussion_fixture_round_trips_through_registered_ipc_types() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/teamDiscussionCommands.contract.json"
    ))
    .unwrap();
    macro_rules! round_trip {
        ($group:literal, $key:literal, $ty:ty) => {{
            let value = fixture[$group][$key].clone();
            let decoded: $ty = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), value, "{}", $key);
        }};
    }
    round_trip!("requests", "history", team::WorkPlanTeamHistoryRequest);
    round_trip!("requests", "post", team::WorkPlanTeamPostRequest);
    round_trip!("requests", "publish", team::WorkPlanTeamPublishRequest);
    round_trip!(
        "requests",
        "publicationAction",
        team::WorkPlanTeamPublicationActionRequest
    );
    round_trip!(
        "responses",
        "history",
        tsumugi_core::application::TeamHistoryPage
    );
    round_trip!(
        "responses",
        "historyNext",
        tsumugi_core::application::TeamHistoryPage
    );
    round_trip!(
        "responses",
        "post",
        tsumugi_core::application::TeamDiscussionPost
    );
    round_trip!(
        "responses",
        "published",
        tsumugi_core::application::TeamDiscussionPost
    );
    round_trip!(
        "responses",
        "publicationAction",
        Option<tsumugi_core::application::TeamDiscussionPost>
    );
    let absent: Option<tsumugi_core::application::TeamDiscussionPost> =
        serde_json::from_value(Value::Null).unwrap();
    assert_eq!(serde_json::to_value(absent).unwrap(), Value::Null);
}

fn complete(store: &mut ProjectStore, request: &DispatchRequest) {
    let input = &request.input;
    let envelope = input.envelope();
    let item = tsumugi_core::ai::item_payload(input, request.item_id).unwrap();
    let result = FixedResult::capture(ResultEnvelope {
        project_id: envelope.project_id, attempt_id: envelope.attempt_id,
        item_id: request.item_id, result_id: ExecutionId::new(), supersedes: None,
        dispatch_token: request.dispatch_token, capability_id: envelope.capability_id.clone(),
        capability_version: envelope.capability_version.clone(), plugin: None,
        outcome: ExecutionState::Succeeded,
        output: Some(json!({"unitId":item.unit_id,"targetLocale":item.target_locale,
            "text":"Synthetic retained candidate","usage":null,"requests":1,"usageIncomplete":false})),
        diagnostic: None,
    }, input, request.dispatch_token).unwrap();
    store.save_execution_result(&result).unwrap();
}

fn dispatch(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    scope: &WorkPlanAgentScope,
    unit: ExecutionId,
) -> DispatchRequest {
    let prepared = store
        .prepare_work_plan_agent_generation(
            scope,
            &AgentGenerationRequest {
                task_id: ExecutionId::new(),
                attempt_id: ExecutionId::new(),
                unit_ids: vec![unit],
            },
        )
        .unwrap();
    runtime
        .submit_work_plan_agent_generation(store, &prepared)
        .unwrap();
    store
        .dispatch_execution_item(
            prepared.envelope().attempt_id,
            prepared.envelope().items[0].item_id,
        )
        .unwrap()
}

impl Scenario {
    fn new(enabled: bool) -> Self {
        let fixture = Fixture::create();
        fixture
            .call(
                "save_translation_revision",
                json!({"actionId":ExecutionId::new(),
            "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
            "expectedSelectionId":null,"text":"Human selected translation"}),
            )
            .unwrap();
        let unit = fixture.unit;
        let (plan, lease) = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &mut sessions.active.as_mut().unwrap().store;
                let mut options = PlanOptions::default();
                options.team_discussions =
                    enabled.then_some(TeamDiscussionPolicy::CurrentPlanV1 {});
                let plan = store
                    .prepare_work_plan(
                        Some(AiConfig {
                            endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                            model: "synthetic-history".into(),
                            credential_env: String::new(),
                            ..AiConfig::default()
                        }),
                        "zh-CN",
                        &[unit],
                        options,
                    )
                    .unwrap();
                let receipt = store
                    .authorize_work_plan(
                        &plan,
                        &AuthorizeWorkPlan {
                            action_id: ExecutionId::new(),
                            plan_digest: plan.digest.clone(),
                            confirmed: true,
                            effects: plan.authorization_effects().unwrap(),
                            expires_at: SystemTime::now()
                                .duration_since(SystemTime::UNIX_EPOCH)
                                .unwrap()
                                .as_secs()
                                + 300,
                        },
                    )
                    .unwrap();
                let input = FixedInput::capture(receipt.input.unwrap()).unwrap();
                store.enqueue_execution(&input).unwrap();
                let root = store
                    .dispatch_execution_item(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id,
                    )
                    .unwrap();
                // Finish in the session callback before the normal clock can dispatch.
                complete(store, &root);
                (plan, receipt.lease)
            });
        Self {
            fixture,
            plan,
            lease,
        }
    }

    fn target(&self) -> TeamDiscussionTarget {
        TeamDiscussionTarget {
            unit_id: self.fixture.unit,
            locale: "zh-CN".into(),
            source_snapshot_id: self.fixture.snapshot,
            source_revision_id: self.fixture.source_revision,
        }
    }

    fn publication(&self, body: &str) -> Value {
        json!({"lease":self.lease,"publication":{"postId":ExecutionId::new(),"target":self.target(),
            "kind":"note","body":body,"references":[],"replyTo":null,"supersedes":null}})
    }

    fn page(&self, after: Value, limit: u32) -> Value {
        self.fixture
            .call(
                "read_work_plan_team_history",
                json!({"planId":self.plan.plan_id,
            "after":after,"limit":limit}),
            )
            .unwrap()
    }

    fn observations(&self) -> Value {
        let project = self.plan.project_id;
        let unit = self.fixture.unit;
        let root = self.plan.execution_input().unwrap().task_id;
        self.fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                json!({"history":store.translation_history(project,unit,"zh-CN",0,100).unwrap(),
                "protection":store.work_protection(unit,"zh-CN").unwrap(),
                "budget":store.provider_budget(root).unwrap()})
            })
    }
}

fn registry_size(fixture: &Fixture) -> Option<usize> {
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        sessions
            .active
            .as_ref()
            .unwrap()
            .execution
            .as_ref()
            .map(|host| host.work_plans.agent_scopes.len())
    })
}

#[test]
fn registered_team_history_retains_author_roles_and_human_publications_are_advisory() {
    let mut scenario = Scenario::new(true);
    let unit = scenario.fixture.unit;
    let lease = scenario.lease;
    let (old_posts, old_roles, current_role, lease) = scenario
        .fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let scope = store.work_plan_agent_scope(lease).unwrap();
            let mut posts = Vec::new();
            let mut roles = Vec::new();
            for name in ["Translator", "Reviewer"] {
                let role = store
                    .register_team_member(
                        &scope,
                        &TeamMemberRoleWrite {
                            member_id: ExecutionId::new(),
                            role_version_id: ExecutionId::new(),
                            expected_role_version_id: None,
                            display_name: name.into(),
                            role: format!("Original {name} role"),
                        },
                    )
                    .unwrap();
                let request = dispatch(&mut host.runtime, store, &scope, unit);
                let author = store
                    .capture_team_author(
                        &scope,
                        role.request.member_id,
                        role.request.role_version_id,
                        request.input.envelope().attempt_id,
                        request.item_id,
                    )
                    .unwrap();
                posts.push(
                    store
                        .publish_team_discussion(
                            &author,
                            &PublishTeamDiscussion {
                                post_id: ExecutionId::new(),
                                target: author.target().clone(),
                                kind: TeamDiscussionKind::Challenge,
                                body: format!("Original {name} reasoning"),
                                references: vec![],
                                reply_to: None,
                                supersedes: None,
                            },
                        )
                        .unwrap(),
                );
                complete(store, &request);
                roles.push(role);
            }
            let paused = store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: lease.plan_id,
                    expected_generation: lease.generation,
                    command: WorkPlanCommand::Pause,
                    confirmed: false,
                    expires_at: None,
                })
                .unwrap();
            let continued = store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: lease.plan_id,
                    expected_generation: paused.lease.generation,
                    command: WorkPlanCommand::Continue,
                    confirmed: true,
                    expires_at: Some(
                        SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_secs()
                            + 300,
                    ),
                })
                .unwrap();
            let scope = store.work_plan_agent_scope(continued.lease).unwrap();
            let mut changed = roles[0].request.clone();
            changed.role_version_id = ExecutionId::new();
            changed.expected_role_version_id = Some(roles[0].request.role_version_id);
            changed.role = "Updated role for later work".into();
            let current = store.register_team_member(&scope, &changed).unwrap();
            (posts, roles, current, continued.lease)
        });
    scenario.lease = lease;
    let first = scenario.page(Value::Null, 1);
    assert_eq!(first["planId"], json!(scenario.plan.plan_id));
    assert_eq!(first["posts"], json!([old_posts[0]]));
    assert_eq!(first["authorRoles"], json!([old_roles[0]]));
    assert_eq!(first["members"].as_array().unwrap().len(), 2);
    assert!(
        first["members"]
            .as_array()
            .unwrap()
            .contains(&json!(current_role))
    );
    assert_eq!(first["nextAfter"], json!(old_posts[0].sequence));
    let second = scenario.page(first["nextAfter"].clone(), 1);
    assert_eq!(second["posts"], json!([old_posts[1]]));
    assert_eq!(second["authorRoles"], json!([old_roles[1]]));
    assert!(second["nextAfter"].is_null());
    assert_eq!(
        scenario
            .fixture
            .call(
                "read_work_plan_team_post",
                json!({"planId":scenario.plan.plan_id,
        "postId":old_posts[0].publication.post_id})
            )
            .unwrap(),
        json!(old_posts[0])
    );
    let opened = scenario
        .fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":scenario.lease}),
        )
        .unwrap();
    let count = registry_size(&scenario.fixture).expect("opening a root scope installs its Host");
    assert!(count > 0);
    let before = scenario.observations();
    let mut publication = scenario.publication("Human reply preserves both original objections.");
    publication["publication"]["replyTo"] = json!(old_posts[0].publication.post_id);
    assert!(
        scenario
            .fixture
            .call(
                "read_work_plan_team_publication_action",
                publication.clone()
            )
            .unwrap()
            .is_null()
    );
    let post = scenario
        .fixture
        .call("publish_work_plan_team_discussion", publication.clone())
        .unwrap();
    assert_eq!(post["publication"], publication["publication"]);
    assert_eq!(post["author"]["kind"], "human");
    assert_eq!(post["author"]["actor"], "local-user");
    assert_eq!(post["author"]["binding"]["callerId"], opened["scopeId"]);
    assert_eq!(post["author"]["binding"]["lease"], json!(scenario.lease));
    assert_eq!(
        scenario
            .fixture
            .call("publish_work_plan_team_discussion", publication.clone())
            .unwrap(),
        post
    );
    assert_eq!(
        scenario
            .fixture
            .call("read_work_plan_team_publication_action", publication)
            .unwrap(),
        post
    );
    assert_eq!(registry_size(&scenario.fixture), Some(count));
    assert_eq!(scenario.observations(), before);
    let lease = scenario.lease;
    let view = scenario
        .fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let scope = store.work_plan_agent_scope(lease).unwrap();
            let request = dispatch(&mut host.runtime, store, &scope, unit);
            let author = store
                .capture_team_execution_author(&scope, &request)
                .unwrap();
            let view = store
                .capture_team_discussion_view(&author)
                .unwrap()
                .view()
                .clone();
            complete(store, &request);
            view
        });
    assert!(json!(view.posts).as_array().unwrap().contains(&post));
    assert_eq!(
        scenario.observations()["history"]["current"],
        before["history"]["current"]
    );
    assert_eq!(scenario.observations()["protection"], before["protection"]);
    assert_eq!(scenario.observations()["budget"], before["budget"]);
}

#[test]
fn registered_team_publication_lookup_is_historical_and_never_revives_old_authority() {
    for change_source in [false, true] {
        let mut scenario = Scenario::new(true);
        let publication =
            scenario.publication("Retained local-user evidence after an uncertain response.");
        let post = scenario
            .fixture
            .call("publish_work_plan_team_discussion", publication.clone())
            .unwrap();
        let scope = scenario
            .fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":scenario.lease}),
            )
            .unwrap();
        let generation = json!({"scopeId":scope["scopeId"],"generation":{"taskId":ExecutionId::new(),
            "attemptId":ExecutionId::new(),"unitIds":[scenario.fixture.unit]}});
        let mut wrong = publication.clone();
        wrong["projectId"] = json!(ExecutionId::new());
        assert!(
            scenario
                .fixture
                .call("publish_work_plan_team_discussion", wrong)
                .is_err()
        );
        assert!(
            scenario
                .fixture
                .call(
                    "read_work_plan_team_history",
                    json!({"planId":ExecutionId::new(),
            "after":null,"limit":16})
                )
                .is_err()
        );
        assert!(
            scenario
                .fixture
                .call(
                    "read_work_plan_team_post",
                    json!({"planId":ExecutionId::new(),
            "postId":post["publication"]["postId"]})
                )
                .is_err()
        );
        let mut wrong_plan = publication.clone();
        wrong_plan["lease"]["planId"] = json!(ExecutionId::new());
        assert!(
            scenario
                .fixture
                .call("publish_work_plan_team_discussion", wrong_plan)
                .is_err()
        );
        let mut wrong = publication.clone();
        wrong["publication"]["postId"] = json!(ExecutionId::new());
        wrong["publication"]["target"]["unitId"] = json!(ExecutionId::new());
        assert!(
            scenario
                .fixture
                .call("publish_work_plan_team_discussion", wrong)
                .is_err()
        );
        let mut collision = publication.clone();
        collision["publication"]["body"] = json!("Different body under the original stable ID");
        assert!(
            scenario
                .fixture
                .call("publish_work_plan_team_discussion", collision.clone())
                .is_err()
        );
        assert!(
            scenario
                .fixture
                .call("read_work_plan_team_publication_action", collision)
                .is_err()
        );
        let mut forged = publication.clone();
        forged["actor"] = json!("another-user");
        assert!(
            scenario
                .fixture
                .call("publish_work_plan_team_discussion", forged)
                .is_err()
        );
        let before = scenario.observations();
        if change_source {
            Fixture::capture_source(
                &scenario.fixture.app,
                br#"{"first":"Changed source"}"#.to_vec(),
            );
        } else {
            scenario
                .fixture
                .call(
                    "control_work_plan",
                    json!({"planId":scenario.plan.plan_id,
                "actionId":ExecutionId::new(),"expectedGeneration":scenario.lease.generation,
                "command":"pause","confirmed":false,"checkerExecutions":[],
                "toolExecution":false,"applicationToolExecutions":[]}),
                )
                .unwrap();
        }
        assert_eq!(scenario.page(Value::Null, 16)["posts"], json!([post]));
        assert_eq!(
            scenario
                .fixture
                .call(
                    "read_work_plan_team_publication_action",
                    publication.clone()
                )
                .unwrap(),
            post
        );
        assert!(
            scenario
                .fixture
                .call("publish_work_plan_team_discussion", publication.clone())
                .is_err()
        );
        assert!(
            scenario
                .fixture
                .call("prepare_work_plan_agent_generation", generation.clone())
                .is_err()
        );
        scenario.fixture.reopen();
        assert_eq!(registry_size(&scenario.fixture), None);
        assert_eq!(scenario.page(Value::Null, 16)["posts"], json!([post]));
        assert_eq!(
            scenario
                .fixture
                .call(
                    "read_work_plan_team_post",
                    json!({"planId":scenario.plan.plan_id,
            "postId":post["publication"]["postId"]})
                )
                .unwrap(),
            post
        );
        assert_eq!(
            scenario
                .fixture
                .call(
                    "read_work_plan_team_publication_action",
                    publication.clone()
                )
                .unwrap(),
            post
        );
        let mut absent = publication.clone();
        absent["publication"]["postId"] = json!(ExecutionId::new());
        assert!(
            scenario
                .fixture
                .call("read_work_plan_team_publication_action", absent)
                .unwrap()
                .is_null()
        );
        assert_eq!(
            registry_size(&scenario.fixture),
            None,
            "historical reads and lost-response lookup cannot install a Host or live caller"
        );
        assert!(
            scenario
                .fixture
                .call("prepare_work_plan_agent_generation", generation)
                .is_err()
        );
        assert!(
            scenario
                .fixture
                .call("publish_work_plan_team_discussion", publication)
                .is_err()
        );
        assert_eq!(scenario.observations()["budget"], before["budget"]);
        assert_eq!(
            scenario.observations()["history"]["current"],
            before["history"]["current"]
        );
    }
}

#[test]
fn registered_team_history_without_sharing_stays_empty_and_bounded() {
    let scenario = Scenario::new(false);
    let before = scenario.observations();
    let page = scenario.page(Value::Null, 16);
    assert_eq!(page["members"], json!([]));
    assert_eq!(page["authorRoles"], json!([]));
    assert_eq!(page["posts"], json!([]));
    assert!(page["nextAfter"].is_null());
    for limit in [0, 17] {
        assert!(
            scenario
                .fixture
                .call(
                    "read_work_plan_team_history",
                    json!({"planId":scenario.plan.plan_id,
            "after":null,"limit":limit})
                )
                .is_err()
        );
    }
    assert!(
        scenario
            .fixture
            .call(
                "publish_work_plan_team_discussion",
                scenario.publication("Not authorized")
            )
            .is_err()
    );
    assert_eq!(scenario.observations(), before);
}
