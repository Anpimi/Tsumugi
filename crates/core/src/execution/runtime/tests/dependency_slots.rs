//! Real broker grants share bounded execution slots with their waiting parents.
use super::*;
use crate::application::*;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

const ORDINARY: &str = "dependency-slot-ordinary";

#[derive(Default)]
struct Running {
    current: AtomicUsize,
    peak: AtomicUsize,
    releases: Mutex<Vec<mpsc::Sender<()>>>,
}
struct RunningCall(Arc<Running>);
impl Drop for RunningCall {
    fn drop(&mut self) {
        self.0.current.fetch_sub(1, Ordering::AcqRel);
    }
}
struct HeldCall {
    request: DispatchRequest,
    cancellation: Cancellation,
    release: mpsc::Sender<()>,
}
struct Holding {
    capability: String,
    binding: Option<PluginExecutionBinding>,
    calls: mpsc::Sender<HeldCall>,
    running: Arc<Running>,
}
impl Runner for Holding {
    fn capability_id(&self) -> &str {
        &self.capability
    }
    fn capability_version(&self) -> &str {
        if self.binding.is_some() { "1:1" } else { "1" }
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        self.binding
            .as_ref()
            .map(|binding| &binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        self.binding.as_ref().map(|binding| &binding.environment)
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        let current = self.running.current.fetch_add(1, Ordering::AcqRel) + 1;
        self.running.peak.fetch_max(current, Ordering::AcqRel);
        let _running = RunningCall(self.running.clone());
        let (release, held) = mpsc::channel();
        self.running.releases.lock().unwrap().push(release.clone());
        self.calls
            .send(HeldCall {
                request,
                cancellation,
                release,
            })
            .unwrap();
        // Deliberately uncooperative until the test releases the real producer.
        // Cancellation alone must never return its allocated scheduler slot.
        let _ = held.recv_timeout(Duration::from_secs(30));
        Err(ExecutionError::new(
            ErrorCode::Cancelled,
            "synthetic-release",
        ))
    }
}

fn selected_tool() -> WorkPlanToolSpec {
    let manifest = sdk::parse_manifest(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../plugin-sdk/tests/fixtures/tool.manifest.json"
    )))
    .unwrap();
    let binding = sdk::parse_tool_declaration(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../plugin-sdk/tests/fixtures/tool.query.json"
    )))
    .unwrap()
    .bind(&manifest, &"a".repeat(64))
    .unwrap();
    let mut execution = plugin_binding("b");
    execution.capability = binding.capability.clone();
    execution.profile = binding.declaration.profile.clone();
    WorkPlanToolSpec {
        handle: ExecutionId::new(),
        application_capabilities: vec![],
        binding,
        resource_id: "query-tool".into(),
        settings_revision: 1u64.into(),
        package_origin: json!({"sourceId":"synthetic","publisherId":"example"}),
        runtime_origin: json!({"sourceId":"synthetic","publisherId":"example"}),
        target: "zh-CN".into(),
        selections: vec!["term".into()],
        execution,
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    store: ProjectStore,
    runtime: ExecutionRuntime,
    scope: WorkPlanAgentScope,
    consent: WorkPlanToolConsent,
    tool: WorkPlanToolSpec,
    unit: ExecutionId,
    models: mpsc::Receiver<HeldCall>,
    tools: mpsc::Receiver<HeldCall>,
    ordinary: mpsc::Receiver<HeldCall>,
    running: Arc<Running>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(
            temp.path().join("project"),
            ProjectMetadata::create("Dependency slots", "en", ["zh-CN"]).unwrap(),
        )
        .unwrap();
        crate::content::tests::adopt_shared_source_fixture(&mut store);
        let unit = store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10,
            )
            .unwrap()
            .rows[0]
            .unit_id
            .unwrap();
        let tool = selected_tool();
        let plan = store
            .prepare_work_plan_with_tools(
                Some(crate::ai::AiConfig {
                    endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                    model: "synthetic-scheduler".into(),
                    credential_env: String::new(),
                    concurrency: 2,
                    ..crate::ai::AiConfig::default()
                }),
                "zh-CN",
                &[unit],
                PlanOptions::default(),
                Some(WorkPlanTools {
                    max_invocations: 8,
                    entries: vec![tool.clone()],
                }),
            )
            .unwrap();
        let now = plugin_authority::plugin_now_ms().unwrap();
        let receipt = store
            .authorize_work_plan(
                &plan,
                &AuthorizeWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_digest: plan.digest.clone(),
                    confirmed: true,
                    effects: plan.authorization_effects().unwrap(),
                    expires_at: now / 1000 + 600,
                },
            )
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        let running = Arc::new(Running::default());
        let (models, model_calls) = mpsc::channel();
        let (tools, tool_calls) = mpsc::channel();
        let (ordinary, ordinary_calls) = mpsc::channel();
        for (capability, binding, calls) in [
            (crate::ai::CAPABILITY.to_owned(), None, models),
            (
                tool.binding.capability.declaration.contract.id.clone(),
                Some(tool.execution.clone()),
                tools,
            ),
            (ORDINARY.to_owned(), None, ordinary),
        ] {
            runtime
                .register(Arc::new(Holding {
                    capability,
                    binding,
                    calls,
                    running: running.clone(),
                }))
                .unwrap();
        }
        let consent = runtime
            .authorize_work_plan_tools(
                &store,
                receipt.lease,
                now + 60_000,
                Instant::now() + Duration::from_secs(60),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
                Default::default(),
            )
            .unwrap();
        let root = FixedInput::capture(receipt.input.unwrap()).unwrap();
        runtime.submit(&mut store, &root).unwrap();
        let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
        let child = store
            .prepare_work_plan_agent_generation(
                &scope,
                &AgentGenerationRequest {
                    task_id: ExecutionId::new(),
                    attempt_id: ExecutionId::new(),
                    unit_ids: vec![unit],
                },
            )
            .unwrap();
        runtime
            .submit_work_plan_agent_generation(&mut store, &child)
            .unwrap();
        let mut fixture = Self {
            _temp: temp,
            store,
            runtime,
            scope,
            consent,
            tool,
            unit,
            models: model_calls,
            tools: tool_calls,
            ordinary: ordinary_calls,
            running,
        };
        fixture.tick();
        let first = fixture.models.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = fixture.models.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(
            first.request.input.envelope().attempt_id,
            second.request.input.envelope().attempt_id
        );
        assert!(
            fixture
                .runtime
                .has_owned_attempt_work(root.envelope().attempt_id)
        );
        assert!(
            fixture
                .runtime
                .has_owned_attempt_work(child.input().envelope().attempt_id)
        );
        assert_eq!(fixture.runtime.workers.len(), 2);
        assert_eq!(fixture.running.current.load(Ordering::Acquire), 2);
        fixture
    }
    fn tick(&mut self) {
        self.runtime.tick(&mut self.store).unwrap();
    }
    fn prepare_tool(&self) -> PreparedWorkPlanTool {
        self.store
            .prepare_work_plan_agent_tool(
                &self.scope,
                &AgentToolRequest {
                    task_id: ExecutionId::new(),
                    attempt_id: ExecutionId::new(),
                    tool_handle: self.tool.handle,
                    unit_ids: vec![self.unit],
                },
            )
            .unwrap()
    }
    fn enqueue_tool(&mut self) -> PreparedWorkPlanTool {
        let prepared = self.prepare_tool();
        self.runtime
            .submit_work_plan_tool(
                &mut self.store,
                &prepared,
                &self.consent,
                ExecutionId::new(),
            )
            .unwrap();
        prepared
    }
    fn ordinary_input(&self) -> FixedInput {
        FixedInput::capture(
            InputEnvelope::new(
                self.store.metadata().unwrap().project_id(),
                "fixture",
                ORDINARY,
                "1",
                vec![InputItem::new(
                    Scope {
                        kind: "fixture".into(),
                        id: ExecutionId::new().to_string(),
                        locale: None,
                    },
                    json!("captured"),
                    vec![],
                )],
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn sequence(&self, input: &FixedInput) -> Revision {
        self.store
            .execution_attempt_page(input.envelope().task_id, Revision::new(0).unwrap(), 1)
            .unwrap()[0]
            .1
    }
    fn assert_queued(&self, input: &FixedInput) {
        let view = self
            .store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        let item = &view.items[0];
        assert_eq!(item.execution, ExecutionState::Queued);
        assert!(
            self.store
                .execution_current_result(input.envelope().attempt_id, item.item_id)
                .unwrap()
                .is_none()
        );
        assert!(
            self.store
                .execution_dispatch(input.envelope().attempt_id, item.item_id)
                .is_err()
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // No new job is admitted while the test's original held threads drain.
        self.runtime.accepting = false;
        for release in self.running.releases.lock().unwrap().iter() {
            let _ = release.send(());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.runtime.workers.is_empty() || !self.runtime.retired.is_empty() {
            if self.runtime.tick(&mut self.store).is_err() || Instant::now() >= deadline {
                if !std::thread::panicking() {
                    panic!("original controlled producers did not drain");
                }
                break;
            }
            std::thread::yield_now();
        }
    }
}

#[test]
fn dependency_slots_full_shared_pool_admits_only_proven_tools_with_total_bound() {
    let mut f = Fixture::new();
    let ordinary = f.ordinary_input();
    f.runtime.submit(&mut f.store, &ordinary).unwrap();
    let direct = plugin_input(&f.store, f.tool.execution.clone());
    f.runtime
        .authorize_plugin(
            &mut f.store,
            ExecutionId::new(),
            &direct,
            plugin_authority::plugin_now_ms().unwrap() + 60_000,
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: false,
            },
        )
        .unwrap();
    f.runtime.submit(&mut f.store, &direct).unwrap();
    assert!(
        f.store
            .plugin_permit(&direct)
            .unwrap()
            .delegation()
            .is_none()
    );
    let first = f.enqueue_tool();
    let second = f.enqueue_tool();
    f.tick();
    let entered = f.tools.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        entered.request.input.envelope().attempt_id,
        first.input().envelope().attempt_id
    );
    assert!(entered.request.plugin_permit().unwrap().is_work_plan_tool());
    for _ in 0..4 {
        f.tick();
    }
    f.assert_queued(&ordinary);
    f.assert_queued(&direct);
    f.assert_queued(second.input());
    assert!(f.ordinary.try_recv().is_err());
    assert!(f.tools.try_recv().is_err());
    assert_eq!(f.runtime.workers.len(), 3);
    assert_eq!(f.running.current.load(Ordering::Acquire), 3);
    assert_eq!(f.running.peak.load(Ordering::Acquire), 3);
    assert_eq!(
        f.store
            .work_plan_tool_invocations(f.scope.lease().plan_id)
            .unwrap(),
        2
    );
}

#[test]
fn dependency_slots_retired_reserve_is_owned_until_its_original_thread_is_joined() {
    let mut f = Fixture::new();
    let first = f.enqueue_tool();
    f.tick();
    let entered = f.tools.recv_timeout(Duration::from_secs(5)).unwrap();
    let attempt = first.input().envelope().attempt_id;
    f.runtime
        .cancel(
            &mut f.store,
            first.input().envelope().task_id,
            ExecutionId::new(),
        )
        .unwrap();
    assert!(entered.cancellation.is_requested());
    f.runtime
        .tick_at(
            &mut f.store,
            Instant::now()
                + Duration::from_millis(
                    u64::from(first.input().envelope().limits.cancel_wait_ms) + 1,
                ),
        )
        .unwrap();
    assert!(!f.runtime.is_active(attempt));
    assert!(f.runtime.has_owned_attempt_work(attempt));
    assert_eq!(f.runtime.retired.len(), 1);
    let second = f.enqueue_tool();
    for _ in 0..4 {
        f.tick();
    }
    f.assert_queued(second.input());
    assert!(f.tools.try_recv().is_err());
    assert_eq!(f.runtime.workers.len() + f.runtime.retired.len(), 3);
    assert_eq!(f.running.current.load(Ordering::Acquire), 3);
    entered.release.send(()).unwrap();
    pump_until(&mut f.runtime, &mut f.store, |runtime, _| {
        !runtime.has_owned_attempt_work(attempt)
    });
    let next = f.tools.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        next.request.input.envelope().attempt_id,
        second.input().envelope().attempt_id
    );
    assert!(f.runtime.retired.is_empty());
    assert_eq!(f.running.peak.load(Ordering::Acquire), 3);
    assert_eq!(
        f.store
            .work_plan_tool_invocations(f.scope.lease().plan_id)
            .unwrap(),
        2
    );
}

#[test]
fn dependency_slots_scan_past_blocked_prefix_and_bound_tail_plus_wrap() {
    let mut f = Fixture::new();
    let mut prefix = Vec::new();
    // Trusted Store enqueue constructs a durable queue beyond one scheduler
    // page. Runtime submissions still reject a fresh attempt at the old cap.
    for _ in 0..128 {
        let ordinary = f.ordinary_input();
        f.store.enqueue_execution(&ordinary).unwrap();
        prefix.push(ordinary);
    }
    let rejected = f.ordinary_input();
    assert_eq!(
        f.runtime.submit(&mut f.store, &rejected).unwrap_err().stage,
        "execution-queue"
    );
    let prepared = f.prepare_tool();
    assert_eq!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, ExecutionId::new(),)
            .unwrap_err()
            .stage,
        "execution-queue"
    );
    // Preserve the real proposal, consent, epoch and atomic grant owner; no
    // SQL inserts or sequence/grant mutations fabricate dependency authority.
    f.store
        .enqueue_work_plan_tool(
            &prepared,
            &f.consent,
            ExecutionId::new(),
            f.runtime.generation(),
            RecoveryPolicy::ExternalUnknown,
        )
        .unwrap();
    let mut tail = Vec::new();
    for _ in 0..129 {
        let ordinary = f.ordinary_input();
        f.store.enqueue_execution(&ordinary).unwrap();
        tail.push(ordinary);
    }
    f.runtime.scheduling_cursor = None;
    f.runtime.dependency_scan_cursor = None;
    f.tick();
    f.assert_queued(prepared.input());
    assert!(f.tools.try_recv().is_err());
    assert_eq!(
        serde_json::to_value(f.runtime.dependency_scan_cursor).unwrap(),
        json!(f.sequence(&prefix[127]))
    );
    f.tick();
    let entered = f.tools.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        entered.request.input.envelope().attempt_id,
        prepared.input().envelope().attempt_id
    );
    entered.release.send(()).unwrap();
    // Await the real join without spending further scheduler scan windows.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !f
        .runtime
        .workers
        .iter()
        .find(|worker| {
            worker.request.input.envelope().attempt_id == prepared.input().envelope().attempt_id
        })
        .unwrap()
        .thread
        .is_finished()
    {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    f.tick();
    assert_eq!(
        serde_json::to_value(f.runtime.dependency_scan_cursor).unwrap(),
        json!(f.sequence(&tail[127]))
    );
    f.tick();
    // One tail row plus exactly 127 prefix rows consumes the same 128-row
    // budget, rather than reading/inspecting two independent full pages.
    assert_eq!(
        serde_json::to_value(f.runtime.dependency_scan_cursor).unwrap(),
        json!(f.sequence(&prefix[126]))
    );
    assert!(f.ordinary.try_recv().is_err());
    assert_eq!(f.running.peak.load(Ordering::Acquire), 3);

    let mut claimed = f.ordinary_input().envelope().clone();
    claimed.settings = json!({"caller":"work-plan-agent","operation":"plugin-tool-query","toolHandle":f.tool.handle});
    let claimed = FixedInput::capture(claimed).unwrap();
    assert!(!f.store.is_work_plan_tool_dependency(&claimed).unwrap());
    let mut forged = claimed.envelope().clone();
    forged.operation = "plugin-tool-query".into();
    assert!(
        !f.store
            .is_work_plan_tool_dependency(&FixedInput::capture(forged).unwrap())
            .unwrap()
    );
    f.store.enqueue_execution(&claimed).unwrap();
    for _ in 0..4 {
        f.tick();
    }
    f.assert_queued(&claimed);
    assert!(f.ordinary.try_recv().is_err());
    drop(f);

    let mut f = Fixture::new();
    let mut blocked = Vec::new();
    for _ in 0..128 {
        let mut ordinary = f.ordinary_input().envelope().clone();
        ordinary.capability_id = "unregistered-dependency-slot".into();
        let ordinary = FixedInput::capture(ordinary).unwrap();
        f.store.enqueue_execution(&ordinary).unwrap();
        blocked.push(ordinary);
    }
    let prepared = f.prepare_tool();
    f.store
        .enqueue_work_plan_tool(
            &prepared,
            &f.consent,
            ExecutionId::new(),
            f.runtime.generation(),
            RecoveryPolicy::ExternalUnknown,
        )
        .unwrap();
    f.tick();
    f.assert_queued(prepared.input());
    assert!(f.tools.try_recv().is_err());
    let dependency_cursor = Some(f.sequence(&blocked[127]));
    assert_eq!(f.runtime.dependency_scan_cursor, dependency_cursor);
    for release in f.running.releases.lock().unwrap().iter() {
        release.send(()).unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while f
        .runtime
        .workers
        .iter()
        .any(|worker| !worker.thread.is_finished())
    {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    f.tick();
    // Shared scans retain the independent dependency frontier, while ordinary
    // blocked attempts still advance their own bounded sequence cursor.
    assert_eq!(f.runtime.dependency_scan_cursor, dependency_cursor);
    assert_eq!(f.runtime.scheduling_cursor, Some(f.sequence(&blocked[127])));
    f.assert_queued(prepared.input());
    assert!(f.tools.try_recv().is_err());
    f.tick();
    let entered = f.tools.recv_timeout(Duration::from_secs(5)).unwrap();
    let worker = f
        .runtime
        .workers
        .iter()
        .find(|worker| {
            worker.request.input.envelope().attempt_id
                == entered.request.input.envelope().attempt_id
        })
        .unwrap();
    assert_eq!(worker.slot, ProducerSlot::Shared);
    assert_eq!(f.runtime.dependency_scan_cursor, dependency_cursor);
}
