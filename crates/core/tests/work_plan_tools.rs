//! Broker authority and ledger evidence; the separate Host test executes the worker.
mod support;
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{ProjectStore, ai::AiConfig, application::*, execution::*};
use tsumugi_plugin_sdk as sdk;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn tool() -> WorkPlanToolSpec {
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../plugin-sdk/tests/fixtures/tool.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_tool_declaration(include_bytes!(
        "../../plugin-sdk/tests/fixtures/tool.query.json"
    ))
    .unwrap();
    let binding = declaration.bind(&manifest, &"a".repeat(64)).unwrap();
    WorkPlanToolSpec {
        handle: ExecutionId::new(),
        binding,
        resource_id: "query-tool".into(),
        settings_revision: 1u64.into(),
        package_origin: json!({"sourceId":"synthetic","publisherId":"example"}),
        runtime_origin: json!({"sourceId":"synthetic","publisherId":"example"}),
        target: "zh-CN".into(),
        selections: vec!["term".into()],
        environment: sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: sdk::RuntimePlatform {
                operating_system: sdk::RuntimeOperatingSystem::Macos,
                architecture: sdk::RuntimeArchitecture::Aarch64,
            },
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: "b".repeat(64),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: "c".repeat(64),
                entrypoint: "dist/main.js".into(),
            },
        }
        .into(),
    }
}
struct UncalledPlugin(WorkPlanToolSpec);
struct UncalledModel;
impl Runner for UncalledModel {
    fn capability_id(&self) -> &str {
        tsumugi_core::ai::CAPABILITY
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
        panic!("no Provider is invoked by the broker test")
    }
    fn query(&self, _: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        Ok(QueryOutcome::Unavailable)
    }
}
impl Runner for UncalledPlugin {
    fn capability_id(&self) -> &str {
        &self.0.binding.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.0.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.0.environment)
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("this test inspects the dispatch boundary")
    }
    fn query(&self, _: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        Ok(QueryOutcome::Unavailable)
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    store: ProjectStore,
    runtime: ExecutionRuntime,
    plan: WorkPlan,
    lease: AutomationLease,
    scope: WorkPlanAgentScope,
    consent: WorkPlanToolConsent,
    units: Vec<ExecutionId>,
}
fn fixture(limit: u32) -> Fixture {
    fixture_with_runner(limit, |tool| Arc::new(UncalledPlugin(tool)))
}
fn fixture_with_runner(
    limit: u32,
    runner: impl FnOnce(WorkPlanToolSpec) -> Arc<dyn Runner>,
) -> Fixture {
    let (temp, mut store, rows) = support::source_fixture();
    let units = rows
        .iter()
        .map(|row| row.unit_id.unwrap())
        .collect::<Vec<_>>();
    let tool = tool();
    let plan = store
        .prepare_work_plan_with_tools(
            Some(AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic".into(),
                ..AiConfig::default()
            }),
            "zh-CN",
            &units,
            PlanOptions::default(),
            Some(WorkPlanTools {
                max_invocations: limit,
                entries: vec![tool.clone()],
            }),
        )
        .unwrap();
    let grant = store
        .authorize_work_plan(
            &plan,
            &AuthorizeWorkPlan {
                action_id: ExecutionId::new(),
                plan_digest: plan.digest.clone(),
                confirmed: true,
                effects: plan.authorization_effects().unwrap(),
                expires_at: now_ms() / 1000 + 600,
            },
        )
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(runner(tool)).unwrap();
    runtime.register(Arc::new(UncalledModel)).unwrap();
    assert!(store.work_plan_agent_scope(grant.lease).is_err());
    let consent = runtime
        .authorize_work_plan_tools(
            &store,
            grant.lease,
            now_ms() + 60_000,
            std::time::Instant::now() + std::time::Duration::from_secs(60),
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    store
        .enqueue_execution(&FixedInput::capture(grant.input.unwrap()).unwrap())
        .unwrap();
    let scope = store.work_plan_agent_scope(grant.lease).unwrap();
    Fixture {
        _temp: temp,
        store,
        runtime,
        plan,
        lease: grant.lease,
        scope,
        consent,
        units,
    }
}
fn request(fixture: &Fixture, units: Vec<ExecutionId>) -> AgentToolRequest {
    AgentToolRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        tool_handle: fixture.plan.tools.as_ref().unwrap().entries[0].handle,
        unit_ids: units,
    }
}
fn counts(store: &ProjectStore) -> (u32, u32) {
    let connection = rusqlite::Connection::open(store.directory().join("project.sqlite3")).unwrap();
    connection.query_row("SELECT (SELECT COUNT(*) FROM plugin_execution_grants),(SELECT COUNT(*) FROM execution_attempts)", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
}
fn control(fixture: &Fixture, command: WorkPlanCommand) -> ControlWorkPlan {
    ControlWorkPlan {
        action_id: ExecutionId::new(),
        plan_id: fixture.plan.plan_id,
        expected_generation: fixture
            .store
            .work_plan_status(fixture.plan.plan_id)
            .unwrap()
            .lease
            .generation,
        command,
        confirmed: command == WorkPlanCommand::Continue,
        expires_at: (command == WorkPlanCommand::Continue).then_some(now_ms() / 1000 + 600),
    }
}

fn successful_plugin_result(request: &DispatchRequest) -> FixedResult {
    let selected = &request
        .input
        .envelope()
        .plugin
        .as_ref()
        .unwrap()
        .capability
        .provider;
    let channel = sdk::ProviderBinding {
        plugin: selected.plugin.clone(),
        component_id: selected.component_id.clone(),
        contribution_id: selected.contribution_id.clone(),
        package_digest: selected.package_digest.clone(),
        instance_id: ExecutionId::new().to_string(),
        activation_generation: 1,
    };
    let invocation = request
        .input
        .plugin_request(request.item_id, request.dispatch_token, &channel)
        .unwrap();
    FixedResult::capture_plugin(
        &request.input,
        request.item_id,
        request.dispatch_token,
        PluginResultEvidence {
            authorization_id: request.plugin_permit().unwrap().grant_id(),
            channel: channel.clone(),
            result: sdk::InvocationResult {
                context: invocation.context,
                provider: channel,
                capability: invocation.capability,
                profile: invocation.profile,
                result_id: ExecutionId::new().to_string(),
                outcome: sdk::InvocationOutcome::Succeeded {
                    output: sdk::EncodedPayload::capture(
                        invocation.output_schema,
                        r#"{"matches":[]}"#.into(),
                    )
                    .unwrap(),
                },
            },
        },
    )
    .unwrap()
}

struct ControlledPlugin {
    tool: UncalledPlugin,
    started: std::sync::mpsc::Sender<DispatchRequest>,
    wait_for_cancel: bool,
}
impl Runner for ControlledPlugin {
    fn capability_id(&self) -> &str {
        self.tool.capability_id()
    }
    fn capability_version(&self) -> &str {
        self.tool.capability_version()
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        self.tool.plugin_provider()
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        self.tool.plugin_environment()
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        self.started.send(request.clone()).unwrap();
        if request.input.envelope().automation.is_none() || !self.wait_for_cancel {
            return results.send(successful_plugin_result(&request));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cancellation.is_requested() {
            assert!(
                Instant::now() < deadline,
                "controlled child cancellation deadline"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        Err(ExecutionError::new(
            ErrorCode::Cancelled,
            "synthetic-cancelled",
        ))
    }
    fn query(&self, _: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        Ok(QueryOutcome::Unavailable)
    }
}

fn prepare_source_reimport(f: &mut Fixture) -> AdoptionAction {
    // Use the same runtime epoch so this exercises source currentness rather
    // than runtime replacement. Each adoption creates a new captured snapshot.
    support::register_source_runners(&mut f.runtime);
    let original = f
        .store
        .source_content(
            f.store.content_scope().unwrap().current_snapshot.unwrap(),
            0,
            100,
        )
        .unwrap()
        .rows
        .into_iter()
        .find(|row| row.unit_id == Some(f.units[0]))
        .unwrap();
    let input = support::source_input_with_texts(&f.store, &["changed", "same"]);
    let (_, result) = support::execute(&mut f.runtime, &mut f.store, &input);
    let capture = f
        .store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let (_, checked) = support::execute(&mut f.runtime, &mut f.store, capture.check_input());
    f.store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let mut preview = f
        .store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap();
    // Changed source text requires an explicit, reviewed identity continuation.
    // A matching native key alone must not silently transfer unit authority.
    preview.confirmation.actor = Some("Synthetic maintainer".into());
    preview
        .confirmation
        .lineage
        .push(tsumugi_core::content::LineageChoice {
            new_ordinal: 0,
            old_occurrence_id: original.occurrence_id.unwrap(),
            decision: tsumugi_core::content::LineageDecision::Continue,
            reason: "Reviewed changed source against the original captured unit".into(),
        });
    f.store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap()
}

#[test]
fn consent_preserves_original_monotonic_deadline_and_rejects_scope_expansion() {
    let f = fixture(2);
    for deadline in [Instant::now(), Instant::now() + Duration::from_secs(601)] {
        assert_eq!(
            f.runtime
                .authorize_work_plan_tools(
                    &f.store,
                    f.lease,
                    now_ms() + 60_000,
                    deadline,
                    PluginConsent {
                        unsandboxed_execution: true
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    for expires in [now_ms(), now_ms() + 601_000] {
        assert_eq!(
            f.runtime
                .authorize_work_plan_tools(
                    &f.store,
                    f.lease,
                    expires,
                    Instant::now() + Duration::from_secs(60),
                    PluginConsent {
                        unsandboxed_execution: true
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    let consent = f
        .runtime
        .authorize_work_plan_tools(
            &f.store,
            f.lease,
            now_ms() + 60_000,
            Instant::now() + Duration::from_millis(100),
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    f.runtime
        .check_work_plan_tool_consent(&f.store, &f.scope, &consent)
        .unwrap();
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(
        f.runtime
            .check_work_plan_tool_consent(&f.store, &f.scope, &consent)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let before = counts(&f.store);
    for proposal in [
        AgentToolRequest {
            tool_handle: ExecutionId::new(),
            ..request(&f, vec![f.units[0]])
        },
        request(&f, vec![ExecutionId::new()]),
        request(&f, vec![f.units[0], f.units[0]]),
        AgentToolRequest {
            task_id: f.scope.parent_task(),
            ..request(&f, vec![f.units[0]])
        },
    ] {
        assert_eq!(
            f.store
                .prepare_work_plan_agent_tool(&f.scope, &proposal)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
    }
    assert_eq!(counts(&f.store), before);
}

#[test]
fn stale_queued_and_running_tool_children_retire_without_stalling_other_plugins() {
    for running in [false, true] {
        let (started, observed) = std::sync::mpsc::channel();
        let mut f = fixture_with_runner(2, |tool| {
            Arc::new(ControlledPlugin {
                tool: UncalledPlugin(tool),
                started,
                wait_for_cancel: true,
            })
        });
        // Keep the model root queued authority, without invoking a Provider.
        let root = f.plan.fixed_input().unwrap();
        for item in &root.envelope().items {
            f.store
                .dispatch_execution_item(root.envelope().attempt_id, item.item_id)
                .unwrap();
        }
        let before = f.store.content_scope().unwrap().current_snapshot;
        let before_target = f
            .store
            .review_target(f.scope.project_id(), f.units[0], "zh-CN")
            .unwrap();
        assert_eq!(before_target.source_text, "same");
        let adoption = prepare_source_reimport(&mut f);
        let proposal = f
            .store
            .prepare_work_plan_agent_tool(&f.scope, &request(&f, vec![f.units[0]]))
            .unwrap();
        f.runtime
            .submit_work_plan_tool(&mut f.store, &proposal, &f.consent, ExecutionId::new())
            .unwrap();
        let permit = if running {
            f.runtime.tick(&mut f.store).unwrap();
            Some(
                observed
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap()
                    .plugin_permit()
                    .unwrap()
                    .clone(),
            )
        } else {
            None
        };
        f.store
            .adopt_execution(&adoption, &tsumugi_core::content::SourceAdoptionHandler)
            .unwrap();
        assert_ne!(f.store.content_scope().unwrap().current_snapshot, before);
        let after_target = f
            .store
            .review_target(f.scope.project_id(), f.units[0], "zh-CN")
            .unwrap();
        assert_eq!(after_target.unit_id, before_target.unit_id);
        assert_ne!(
            after_target.source_revision_id,
            before_target.source_revision_id
        );
        assert_eq!(after_target.source_text, "changed");
        assert_eq!(
            proposal.input().envelope().items[0].payload["rows"][0]["text"],
            "same"
        );
        f.runtime.tick(&mut f.store).unwrap();
        if let Some(permit) = permit {
            assert!(!permit.is_authorized());
        }
        let attempt = proposal.input().envelope().attempt_id;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            f.runtime.tick(&mut f.store).unwrap();
            if !f.runtime.is_active(attempt) {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let state = f.store.execution_attempt(attempt, false).unwrap().items[0].execution;
        assert_eq!(
            state,
            if running {
                ExecutionState::Unknown
            } else {
                ExecutionState::CancelledBeforeDispatch
            }
        );
        assert_eq!(
            f.store.work_plan_status(f.plan.plan_id).unwrap().state,
            WorkPlanState::Active
        );
        // A human query retains its separate grant and completes in the same pump.
        let mut human = proposal.input().envelope().clone();
        human.task_id = ExecutionId::new();
        human.attempt_id = ExecutionId::new();
        human.automation = None;
        let human = FixedInput::capture(human).unwrap();
        let (_, result) = support::execute(&mut f.runtime, &mut f.store, &human);
        assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
        assert_eq!(
            f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
            1
        );
    }
}

#[test]
fn completed_query_tools_release_live_slots_without_refunding_plan_reservations() {
    let (started, observed) = std::sync::mpsc::channel();
    let mut f = fixture_with_runner(130, |tool| {
        Arc::new(ControlledPlugin {
            tool: UncalledPlugin(tool),
            started,
            wait_for_cancel: false,
        })
    });
    let root = f.plan.fixed_input().unwrap();
    for item in &root.envelope().items {
        f.store
            .dispatch_execution_item(root.envelope().attempt_id, item.item_id)
            .unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    for expected in 1..=129 {
        let request = request(&f, vec![f.units[0]]);
        let proposal = f
            .store
            .prepare_work_plan_agent_tool(&f.scope, &request)
            .unwrap();
        f.runtime
            .submit_work_plan_tool(&mut f.store, &proposal, &f.consent, ExecutionId::new())
            .unwrap();
        let result = loop {
            f.runtime.tick(&mut f.store).unwrap();
            if !f.runtime.is_active(request.attempt_id) {
                if let Some(result) = f
                    .store
                    .execution_current_result(
                        request.attempt_id,
                        proposal.input().envelope().items[0].item_id,
                    )
                    .unwrap()
                {
                    break f
                        .store
                        .execution_result(request.attempt_id, result)
                        .unwrap();
                }
            }
            assert!(
                Instant::now() < deadline,
                "sequential tool completion deadline"
            );
            std::thread::sleep(Duration::from_millis(1));
        };
        assert!(
            !observed
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .plugin_permit()
                .unwrap()
                .is_authorized()
        );
        assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
        assert!(!f.store.save_execution_result(&result).unwrap());
        assert_eq!(
            f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
            expected
        );
    }
}

#[test]
fn historical_plugin_results_bind_original_grant_even_after_revocation() {
    for delegated in [false, true] {
        let mut f = fixture(2);
        let proposal = f
            .store
            .prepare_work_plan_agent_tool(&f.scope, &request(&f, vec![f.units[0]]))
            .unwrap();
        let grant = ExecutionId::new();
        let input = if delegated {
            f.runtime
                .submit_work_plan_tool(&mut f.store, &proposal, &f.consent, grant)
                .unwrap();
            proposal.input().clone()
        } else {
            let mut input = proposal.input().envelope().clone();
            input.automation = None;
            let input = FixedInput::capture(input).unwrap();
            f.runtime
                .authorize_plugin(
                    &mut f.store,
                    grant,
                    &input,
                    now_ms() + 60_000,
                    PluginConsent {
                        unsandboxed_execution: true,
                    },
                )
                .unwrap();
            f.runtime.submit(&mut f.store, &input).unwrap();
            input
        };
        let dispatch = f
            .store
            .dispatch_execution_item(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap();
        let result = successful_plugin_result(&dispatch);
        f.store.save_execution_result(&result).unwrap();
        f.runtime.revoke_plugin(&mut f.store, grant).unwrap();
        assert_eq!(
            f.store
                .execution_result(input.envelope().attempt_id, result.envelope().result_id)
                .unwrap()
                .bytes(),
            result.bytes()
        );
        let path = f.store.directory().to_owned();
        let mut tampered = result.envelope().clone();
        tampered.plugin.as_mut().unwrap().authorization_id = ExecutionId::new();
        let tampered = FixedResult::capture(tampered, &input, dispatch.dispatch_token).unwrap();
        let db = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        db.execute(
            "UPDATE execution_results SET bytes=?1,digest=?2 WHERE result_id=?3",
            rusqlite::params![
                tampered.bytes(),
                tampered.digest(),
                tampered.envelope().result_id.to_string()
            ],
        )
        .unwrap();
        drop(db);
        assert_eq!(
            f.store
                .execution_result(input.envelope().attempt_id, result.envelope().result_id)
                .unwrap_err()
                .code,
            ErrorCode::CorruptLedger
        );
        drop(f.runtime);
        drop(f.store);
        assert!(matches!(
            ProjectStore::open(path),
            Err(tsumugi_core::PersistenceError::CorruptProject { .. })
        ));
    }
}

#[test]
fn delegated_tool_derives_source_and_requires_independent_process_consent() {
    let mut f = fixture(2);
    let request = request(&f, vec![f.units[0]]);
    let before = counts(&f.store);
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request)
        .unwrap();
    assert_eq!(counts(&f.store), before);
    assert_eq!(
        prepared.input().envelope().items[0].payload["rows"][0]["text"],
        "same"
    );
    assert_eq!(
        prepared.input().envelope().settings["callerId"],
        json!(f.scope.caller_id())
    );
    assert_eq!(
        f.runtime
            .authorize_work_plan_tools(
                &f.store,
                f.lease,
                now_ms() + 60_000,
                std::time::Instant::now() + std::time::Duration::from_secs(60),
                PluginConsent {
                    unsandboxed_execution: false
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        f.runtime
            .authorize_plugin(
                &mut f.store,
                ExecutionId::new(),
                prepared.input(),
                now_ms() + 60_000,
                PluginConsent {
                    unsandboxed_execution: true
                }
            )
            .is_err()
    );
    assert!(
        f.runtime
            .submit_child(&mut f.store, prepared.input(), f.scope.parent_task())
            .is_err()
    );
    assert!(f.runtime.submit(&mut f.store, prepared.input()).is_err());
    let grant_id = ExecutionId::new();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant_id)
        .unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant_id)
        .unwrap();
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        1
    );
    assert!(f.store.provider_budget(request.task_id).unwrap().is_none());
    assert_eq!(
        f.store
            .provider_budget(f.scope.parent_task())
            .unwrap()
            .unwrap()
            .dispatched,
        0
    );
    let item = prepared.input().envelope().items[0].item_id;
    let dispatch = f
        .store
        .dispatch_execution_item(request.attempt_id, item)
        .unwrap();
    let permit = dispatch.plugin_permit().unwrap();
    assert_eq!(permit.originating_caller_id(), Some(f.scope.caller_id()));
    assert_eq!(permit.parent_task(), Some(f.scope.parent_task()));
    assert!(permit.is_work_plan_tool() && permit.is_authorized());
    let pause = control(&f, WorkPlanCommand::Pause);
    f.store.control_work_plan(&pause).unwrap();
    assert!(!permit.is_authorized());
    assert!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant_id)
            .is_err()
    );
}

#[test]
fn delegated_enqueue_rolls_back_grant_when_attempt_identity_conflicts() {
    let mut f = fixture(2);
    let collision = FixedInput::capture(
        InputEnvelope::new(
            f.store.metadata().unwrap().project_id(),
            "collision",
            "fixture",
            "1",
            vec![InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: "collision".into(),
                    locale: None,
                },
                json!({}),
                vec![],
            )],
        )
        .unwrap(),
    )
    .unwrap();
    f.store.enqueue_execution(&collision).unwrap();
    let mut request = request(&f, vec![f.units[0]]);
    request.task_id = collision.envelope().task_id;
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request)
        .unwrap();
    let before = counts(&f.store);
    assert_eq!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, ExecutionId::new())
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    assert_eq!(counts(&f.store), before);
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        0
    );
}

#[test]
fn all_tool_items_share_original_limit_across_continue_and_root_cancellation() {
    let mut f = fixture(2);
    let first = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request(&f, vec![f.units[0]]))
        .unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &first, &f.consent, ExecutionId::new())
        .unwrap();
    let pause = control(&f, WorkPlanCommand::Pause);
    f.store.control_work_plan(&pause).unwrap();
    let continuation = control(&f, WorkPlanCommand::Continue);
    let continued = f.store.control_work_plan(&continuation).unwrap();
    f.runtime
        .submit_child(
            &mut f.store,
            &FixedInput::capture(continued.input.clone().unwrap()).unwrap(),
            continued.parent_task.unwrap(),
        )
        .unwrap();
    let scope = f.store.work_plan_agent_scope(continued.lease).unwrap();
    assert!(
        f.runtime
            .check_work_plan_tool_consent(&f.store, &scope, &f.consent)
            .is_err()
    );
    let consent = f
        .runtime
        .authorize_work_plan_tools(
            &f.store,
            continued.lease,
            now_ms() + 60_000,
            std::time::Instant::now() + std::time::Duration::from_secs(60),
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    let second = f
        .store
        .prepare_work_plan_agent_tool(&scope, &request(&f, vec![f.units[1]]))
        .unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &second, &consent, ExecutionId::new())
        .unwrap();
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        2
    );
    let third = f
        .store
        .prepare_work_plan_agent_tool(&scope, &request(&f, vec![f.units[0]]))
        .unwrap();
    assert_eq!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &third, &consent, ExecutionId::new())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let input = second.input();
    let dispatch = f
        .store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let permit = dispatch.plugin_permit().unwrap();
    f.store
        .cancel_execution(scope.parent_task(), ExecutionId::new())
        .unwrap();
    assert!(!permit.is_authorized());
    assert_eq!(
        f.store.work_plan_status(f.plan.plan_id).unwrap().state,
        WorkPlanState::Stopped
    );
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        2
    );
}

#[test]
fn multi_unit_tool_reservations_are_atomic_and_root_cancel_reaches_queued_children() {
    let mut f = fixture(1);
    let multi = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request(&f, f.units.clone()))
        .unwrap();
    let before = counts(&f.store);
    assert_eq!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &multi, &f.consent, ExecutionId::new())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(counts(&f.store), before);
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        0
    );
    let mut f = fixture(2);
    let multi = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request(&f, f.units.clone()))
        .unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &multi, &f.consent, ExecutionId::new())
        .unwrap();
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        2
    );
    f.store
        .cancel_execution(f.scope.parent_task(), ExecutionId::new())
        .unwrap();
    let state = f
        .store
        .execution_attempt(multi.input().envelope().attempt_id, false)
        .unwrap();
    assert!(
        state
            .items
            .iter()
            .all(|item| item.execution == ExecutionState::CancelledBeforeDispatch)
    );
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        2
    );
}

#[test]
fn reopening_preserves_reservations_and_never_recreates_old_tool_authority() {
    let mut f = fixture(2);
    let request = request(&f, vec![f.units[0]]);
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request)
        .unwrap();
    let grant_id = ExecutionId::new();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant_id)
        .unwrap();
    let path = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let mut store = ProjectStore::open(path).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(UncalledPlugin(tool()))).unwrap();
    let scope = store.work_plan_agent_scope(f.lease).unwrap();
    assert_ne!(scope.caller_id(), f.scope.caller_id());
    assert!(
        runtime
            .check_work_plan_tool_consent(&store, &scope, &f.consent)
            .is_err()
    );
    assert!(
        runtime
            .submit_work_plan_tool(&mut store, &prepared, &f.consent, grant_id)
            .is_err()
    );
    assert_eq!(store.work_plan_tool_invocations(f.plan.plan_id).unwrap(), 1);
    assert_eq!(
        store
            .dispatch_execution_item(
                request.attempt_id,
                prepared.input().envelope().items[0].item_id
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(store.work_plan_tool_invocations(f.plan.plan_id).unwrap(), 1);
}

#[test]
fn unknown_tool_dispatch_keeps_original_reservation_and_cannot_replay() {
    let mut f = fixture(1);
    let request = request(&f, vec![f.units[0]]);
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request)
        .unwrap();
    let grant_id = ExecutionId::new();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant_id)
        .unwrap();
    let item = prepared.input().envelope().items[0].item_id;
    f.store
        .dispatch_execution_item(request.attempt_id, item)
        .unwrap();
    f.store
        .note_execution_unknown(request.attempt_id, item, "synthetic-channel-loss")
        .unwrap();
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        1
    );
    assert!(
        f.runtime
            .resume(&mut f.store, request.attempt_id, &[item])
            .is_err()
    );
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant_id)
        .unwrap();
    assert_eq!(
        f.store
            .execution_attempt(request.attempt_id, false)
            .unwrap()
            .items[0]
            .execution,
        ExecutionState::Unknown
    );
    assert_eq!(
        f.store
            .dispatch_execution_item(request.attempt_id, item)
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    let extra = AgentToolRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        ..request
    };
    let extra = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &extra)
        .unwrap();
    assert_eq!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &extra, &f.consent, ExecutionId::new())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
}

#[test]
#[ignore = "isolated subprocess selected by the crash-boundary regression"]
#[cfg(feature = "execution-test-host")]
fn delegated_tool_commit_crash_child() {
    let control = std::path::PathBuf::from(
        std::env::var_os("TSUMUGI_TOOL_CRASH_CONTROL").expect("isolated child control"),
    );
    let mut f = fixture(2);
    let request = request(&f, vec![f.units[0]]);
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &request)
        .unwrap();
    let grant_id = ExecutionId::new();
    std::fs::write(control.join("fixture.json"), serde_json::to_vec(&json!({
        "temporary":f._temp.path(), "project": f.store.directory(), "plan": f.plan.plan_id,
        "request": request, "grant": grant_id, "item": prepared.input().envelope().items[0].item_id,
    })).unwrap()).unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant_id)
        .unwrap();
    panic!("the commit/activation crash boundary was not reached");
}

#[test]
#[cfg(feature = "execution-test-host")]
fn crash_after_atomic_tool_commit_preserves_input_without_rearming_permission() {
    let control = tempfile::tempdir().unwrap();
    let marker = control.path().join("reached");
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "delegated_tool_commit_crash_child",
            "--test-threads=1",
        ])
        .env("TSUMUGI_TOOL_CRASH_CONTROL", control.path())
        .env("TSUMUGI_EXECUTION_CRASH", "after-tool-enqueue-commit")
        .env("TSUMUGI_EXECUTION_HOOK", &marker)
        .output()
        .unwrap();
    assert!(!child.status.success());
    assert_eq!(
        std::fs::read_to_string(marker).unwrap(),
        "after-tool-enqueue-commit"
    );
    let evidence: serde_json::Value =
        serde_json::from_slice(&std::fs::read(control.path().join("fixture.json")).unwrap())
            .unwrap();
    let project = std::path::PathBuf::from(evidence["project"].as_str().unwrap());
    let temporary = std::path::PathBuf::from(evidence["temporary"].as_str().unwrap());
    let request: AgentToolRequest = serde_json::from_value(evidence["request"].clone()).unwrap();
    let plan: ExecutionId = serde_json::from_value(evidence["plan"].clone()).unwrap();
    let grant: ExecutionId = serde_json::from_value(evidence["grant"].clone()).unwrap();
    let item: ExecutionId = serde_json::from_value(evidence["item"].clone()).unwrap();
    let mut store = ProjectStore::open(project).unwrap();
    assert_eq!(store.work_plan_tool_invocations(plan).unwrap(), 1);
    let stored = store.execution_input(request.attempt_id).unwrap();
    assert_eq!(stored.envelope().operation, "plugin-tool-query");
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    let plan = store.work_plan(plan).unwrap();
    runtime
        .register(Arc::new(UncalledPlugin(
            plan.tools.as_ref().unwrap().entries[0].clone(),
        )))
        .unwrap();
    let scope = store
        .work_plan_agent_scope(store.work_plan_status(plan.plan_id).unwrap().lease)
        .unwrap();
    let fresh_consent = runtime
        .authorize_work_plan_tools(
            &store,
            scope.lease(),
            now_ms() + 60_000,
            std::time::Instant::now() + std::time::Duration::from_secs(60),
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    let proposal = store
        .prepare_work_plan_agent_tool(&scope, &request)
        .unwrap();
    assert!(
        runtime
            .submit_work_plan_tool(&mut store, &proposal, &fresh_consent, grant)
            .is_err()
    );
    assert_eq!(
        store
            .dispatch_execution_item(request.attempt_id, item)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(store.work_plan_tool_invocations(plan.plan_id).unwrap(), 1);
    drop(runtime);
    drop(store);
    std::fs::remove_dir_all(temporary).unwrap();
}
