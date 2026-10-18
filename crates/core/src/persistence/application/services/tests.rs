use super::*;
use crate::ai::{AiConfig, AiOutput};
use serde_json::json;
use std::sync::{Mutex, mpsc};
mod tool_services;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}

struct Registered {
    plugin: Option<PluginExecutionBinding>,
}
impl Runner for Registered {
    fn capability_id(&self) -> &str {
        self.plugin
            .as_ref()
            .map_or(crate::ai::CAPABILITY, |binding| {
                &binding.capability.declaration.contract.id
            })
    }
    fn capability_version(&self) -> &str {
        if self.plugin.is_some() { "1:1" } else { "1" }
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        self.plugin
            .as_ref()
            .map(|binding| &binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        self.plugin.as_ref().map(|binding| &binding.environment)
    }
    fn plugin_application_scope(&self) -> Option<&ApplicationScopeBasis> {
        self.plugin
            .as_ref()
            .and_then(|binding| binding.application_scope.as_ref())
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("fixture must not perform model or component I/O")
    }
}

fn binding() -> PluginExecutionBinding {
    PluginExecutionBinding {
        component_scope: tsumugi_plugin_sdk::ComponentScope::Project,
        application_scope: None,
        capability: sdk::CapabilityBinding {
            provider: sdk::ProviderSelectionBinding {
                plugin: sdk::PluginIdentity {
                    publisher: "example".into(),
                    id: "example.generator".into(),
                    version: "0.1.0".into(),
                },
                component_id: "worker".into(),
                contribution_id: "generation".into(),
                package_digest: "a".repeat(64),
            },
            declaration: sdk::CapabilityDeclaration {
                contract: contract("example.generate"),
                input_schema: contract("example.input"),
                output_schema: contract("example.output"),
                error_schema: contract("example.error"),
                profiles: vec![],
                effect: sdk::EffectKind::External,
                permissions: vec![
                    sdk::PermissionRequest::CapturedInput,
                    sdk::PermissionRequest::ProjectService {
                        contract: sdk::generation_service_contract(),
                    },
                ],
                limits: sdk::CapabilityLimits {
                    max_input_bytes: 4096,
                    max_output_bytes: 4096,
                    concurrency: 1,
                    timeout_ms: 10000,
                },
            },
        },
        profile: None,
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
                tree_digest: "a".repeat(64),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: "b".repeat(64),
                entrypoint: "dist/main.js".into(),
            },
        }
        .into(),
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    store: ProjectStore,
    runtime: ExecutionRuntime,
    origin: WorkPlanServiceOrigin,
    dispatch: DispatchRequest,
    cancellation: Cancellation,
    settings_revocation: Cancellation,
    call: WorkPlanServiceCall,
}
impl Fixture {
    fn new() -> Self {
        Self::with_endpoint("http://127.0.0.1:9/v1/chat/completions".into())
    }
    fn with_endpoint(endpoint: String) -> Self {
        Self::with_model(endpoint, Arc::new(Registered { plugin: None }))
    }
    fn with_model(endpoint: String, model: Arc<dyn Runner>) -> Self {
        Self::with_model_scope(endpoint, model, sdk::ComponentScope::Project)
    }
    fn with_model_scope(
        endpoint: String,
        model: Arc<dyn Runner>,
        component_scope: sdk::ComponentScope,
    ) -> Self {
        let (directory, mut store, _) =
            crate::persistence::review::tests::current_release_fixture(false);
        let units = store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10,
            )
            .unwrap()
            .rows
            .into_iter()
            .map(|row| row.unit_id.unwrap())
            .collect::<Vec<_>>();
        let plan = store
            .prepare_work_plan(
                Some(AiConfig {
                    endpoint,
                    model: "synthetic-model".into(),
                    credential_env: String::new(),
                    max_requests: 2,
                    ..AiConfig::default()
                }),
                "zh-CN",
                &units,
                PlanOptions::default(),
            )
            .unwrap();
        let grant = store
            .authorize_work_plan(
                &plan,
                &AuthorizeWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_digest: plan.digest.clone(),
                    confirmed: true,
                    effects: vec![AutomationEffect::SaveCandidate],
                    expires_at: control::now().unwrap() + 600,
                },
            )
            .unwrap();
        let root = FixedInput::capture(grant.input.unwrap()).unwrap();
        store.enqueue_execution(&root).unwrap();
        let scope = store.work_plan_agent_scope(grant.lease).unwrap();
        let mut plugin = binding();
        plugin.component_scope = component_scope;
        let mut envelope = InputEnvelope::new(
            store.metadata().unwrap().project_id(),
            "fixture",
            &plugin.capability.declaration.contract.id,
            &plugin.capability_version(),
            vec![InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: "generation".into(),
                    locale: None,
                },
                json!({"captured": true}),
                vec![],
            )],
        )
        .unwrap();
        envelope.plugin = Some(plugin.clone());
        let outer = FixedInput::capture(envelope).unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime
            .register(Arc::new(Registered {
                plugin: Some(plugin.clone()),
            }))
            .unwrap();
        runtime.register(model).unwrap();
        runtime
            .authorize_plugin(
                &mut store,
                ExecutionId::new(),
                &outer,
                plugin_now_ms().unwrap() + 60000,
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
            )
            .unwrap();
        runtime.submit(&mut store, &outer).unwrap();
        let dispatch = store
            .dispatch_execution_item(
                outer.envelope().attempt_id,
                outer.envelope().items[0].item_id,
            )
            .unwrap();
        let provider = &plugin.capability.provider;
        let channel = sdk::ProviderBinding {
            plugin: provider.plugin.clone(),
            component_id: provider.component_id.clone(),
            contribution_id: provider.contribution_id.clone(),
            package_digest: provider.package_digest.clone(),
            instance_id: "fixture-channel".into(),
            activation_generation: 1,
        };
        let mut invocation = outer
            .plugin_request(dispatch.item_id, dispatch.dispatch_token, &channel)
            .unwrap();
        invocation.max_result_bytes -= 1;
        let service = sdk::ServiceBinding {
            handle_id: "generation-service".into(),
            provider_id: "example.ai-generation".into(),
            contract: sdk::generation_service_contract(),
            input_schema: sdk::generation_service_input_contract(),
            output_schema: sdk::generation_service_receipt_contract(),
            error_schema: sdk::generation_service_error_contract(),
            effect: sdk::EffectKind::External,
            project_id: invocation.context.project_id.clone(),
            scope_id: invocation.context.scope_id.clone(),
            activation_generation: 1,
            configuration_digest: "d".repeat(64),
            limits: sdk::CapabilityLimits {
                max_input_bytes: 4096,
                max_output_bytes: 4096,
                concurrency: 1,
                timeout_ms: 10000,
            },
        };
        let cancellation = Cancellation::default();
        let settings_revocation = Cancellation::default();
        let origin = store
            .capture_work_plan_service_origin(
                &scope,
                &dispatch,
                &invocation,
                &service,
                dispatch.deadline().unwrap(),
                &cancellation,
                &settings_revocation,
            )
            .unwrap();
        let generation = AgentGenerationRequest {
            task_id: ExecutionId::new(),
            attempt_id: ExecutionId::new(),
            unit_ids: vec![units[0]],
        };
        let call = WorkPlanServiceCall {
            handle_id: "generation-service".into(),
            call_id: "original-call".into(),
            input: sdk::EncodedPayload::capture(
                sdk::generation_service_input_contract(),
                serde_json::to_string(&generation).unwrap(),
            )
            .unwrap(),
        };
        Self {
            _directory: directory,
            store,
            runtime,
            origin,
            dispatch,
            cancellation,
            settings_revocation,
            call,
        }
    }
    fn prepare(&self) -> PreparedWorkPlanServiceGeneration {
        let prepared = self
            .store
            .prepare_work_plan_service_generation(&self.origin, &self.call)
            .unwrap();
        assert!(
            prepared
                .input()
                .envelope()
                .settings
                .get("agent")
                .is_some_and(serde_json::Value::is_null)
        );
        prepared
    }
    fn submit(&mut self) -> (PreparedWorkPlanServiceGeneration, WorkPlanServiceReceipt) {
        let prepared = self.prepare();
        let receipt = self
            .runtime
            .submit_work_plan_service_child(&mut self.store, &prepared)
            .unwrap();
        (prepared, receipt)
    }
    fn complete_outer(&mut self) {
        let request = &self.origin.record.invocation;
        let result = FixedResult::capture_plugin(
            &self.dispatch.input,
            self.dispatch.item_id,
            self.dispatch.dispatch_token,
            PluginResultEvidence {
                authorization_id: self.origin.record.grant_id,
                channel: request.provider.clone(),
                result: sdk::InvocationResult {
                    context: request.context.clone(),
                    provider: request.provider.clone(),
                    capability: request.capability.clone(),
                    profile: request.profile.clone(),
                    result_id: "enqueue-ack".into(),
                    outcome: sdk::InvocationOutcome::Succeeded {
                        output: sdk::EncodedPayload::capture(
                            request.output_schema.clone(),
                            "{\"queued\":true}".into(),
                        )
                        .unwrap(),
                    },
                },
            },
        )
        .unwrap();
        self.store.save_execution_result(&result).unwrap();
        self.store
            .finish_execution_attempt(self.dispatch.input.envelope().attempt_id)
            .unwrap();
        assert_eq!(
            self.store
                .execution_attempt(self.dispatch.input.envelope().attempt_id, false)
                .unwrap()
                .items[0]
                .execution,
            ExecutionState::Succeeded
        );
    }

    fn park_root(&mut self) {
        let plan = self
            .store
            .work_plan(self.origin.scope.lease.plan_id)
            .unwrap();
        let attempt = plan.execution_input().unwrap().attempt_id;
        let root = self
            .store
            .execution_input_if_present(attempt)
            .unwrap()
            .unwrap();
        for item in &root.envelope().items {
            self.store
                .dispatch_execution_item(attempt, item.item_id)
                .unwrap();
        }
    }

    fn submit_peer(&mut self) -> (PreparedWorkPlanServiceGeneration, WorkPlanServiceCall) {
        let mut plugin = binding();
        plugin.capability.provider.plugin.id = "example.independent".into();
        plugin.capability.provider.package_digest = "e".repeat(64);
        self.runtime
            .register(Arc::new(Registered {
                plugin: Some(plugin.clone()),
            }))
            .unwrap();
        let mut envelope = InputEnvelope::new(
            self.store.metadata().unwrap().project_id(),
            "fixture",
            &plugin.capability.declaration.contract.id,
            &plugin.capability_version(),
            vec![InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: "independent caller".into(),
                    locale: None,
                },
                json!({"captured":true}),
                vec![],
            )],
        )
        .unwrap();
        envelope.plugin = Some(plugin.clone());
        let outer = FixedInput::capture(envelope).unwrap();
        self.runtime
            .authorize_plugin(
                &mut self.store,
                ExecutionId::new(),
                &outer,
                plugin_now_ms().unwrap() + 60_000,
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
            )
            .unwrap();
        self.runtime.submit(&mut self.store, &outer).unwrap();
        let dispatch = self
            .store
            .dispatch_execution_item(
                outer.envelope().attempt_id,
                outer.envelope().items[0].item_id,
            )
            .unwrap();
        let selected = &plugin.capability.provider;
        let provider = sdk::ProviderBinding {
            plugin: selected.plugin.clone(),
            component_id: selected.component_id.clone(),
            contribution_id: selected.contribution_id.clone(),
            package_digest: selected.package_digest.clone(),
            instance_id: "independent-channel".into(),
            activation_generation: 1,
        };
        let invocation = outer
            .plugin_request(dispatch.item_id, dispatch.dispatch_token, &provider)
            .unwrap();
        let service = sdk::ServiceBinding {
            project_id: invocation.context.project_id.clone(),
            scope_id: invocation.context.scope_id.clone(),
            ..self.origin.record.service.clone()
        };
        let origin = self
            .store
            .capture_work_plan_service_origin(
                &self.origin.scope,
                &dispatch,
                &invocation,
                &service,
                dispatch.deadline().unwrap(),
                &Cancellation::default(),
                &Cancellation::default(),
            )
            .unwrap();
        let mut generation = self
            .call
            .validate(
                &self.origin.record.service,
                &self.origin.record.invocation.context,
            )
            .unwrap();
        generation.task_id = ExecutionId::new();
        generation.attempt_id = ExecutionId::new();
        let call = WorkPlanServiceCall {
            call_id: "independent-call".into(),
            handle_id: service.handle_id.clone(),
            input: sdk::EncodedPayload::capture(
                sdk::generation_service_input_contract(),
                serde_json::to_string(&generation).unwrap(),
            )
            .unwrap(),
        };
        let prepared = self
            .store
            .prepare_work_plan_service_generation(&origin, &call)
            .unwrap();
        self.runtime
            .submit_work_plan_service_child(&mut self.store, &prepared)
            .unwrap();
        (prepared, call)
    }
}

struct HeldServiceCall {
    request: DispatchRequest,
    cancellation: Cancellation,
    release: mpsc::Sender<()>,
}
#[derive(Default)]
struct ServiceQueryObservation {
    held: Option<ExecutionId>,
    entered: Vec<ExecutionId>,
}
struct HeldServiceModel {
    calls: mpsc::Sender<HeldServiceCall>,
    held_query: Arc<Mutex<ServiceQueryObservation>>,
}
impl HeldServiceModel {
    fn hold(&self, request: DispatchRequest, cancellation: Cancellation) {
        let (release, wait) = mpsc::channel();
        self.calls
            .send(HeldServiceCall {
                request,
                cancellation,
                release,
            })
            .unwrap();
        // This owned runner deliberately ignores cancellation until released.
        // Dropping the receiver's release handle also ends a failed test's wait.
        let _ = wait.recv_timeout(std::time::Duration::from_secs(15));
    }
}
impl Runner for HeldServiceModel {
    fn capability_id(&self) -> &str {
        crate::ai::CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        self.hold(request, cancellation);
        Err(ExecutionError::new(
            ErrorCode::OutcomeUnknown,
            "held-service-model-ended",
        ))
    }
    fn query(&self, request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        let held = {
            let mut observation = self.held_query.lock().unwrap();
            let attempt = request.input.envelope().attempt_id;
            observation.entered.push(attempt);
            observation.held == Some(attempt)
        };
        if held {
            self.hold(request.clone(), Cancellation::default());
        }
        Ok(QueryOutcome::Pending)
    }
}
fn held_service_fixture() -> (
    Fixture,
    mpsc::Receiver<HeldServiceCall>,
    Arc<Mutex<ServiceQueryObservation>>,
) {
    let (calls, observed) = mpsc::channel();
    let held_query = Arc::new(Mutex::new(ServiceQueryObservation::default()));
    let mut fixture = Fixture::with_model(
        "http://127.0.0.1:9/v1/chat/completions".into(),
        Arc::new(HeldServiceModel {
            calls,
            held_query: held_query.clone(),
        }),
    );
    fixture.park_root();
    (fixture, observed, held_query)
}
fn finish_original_package(fixture: &mut Fixture, stop: &crate::execution::PackageQuiescence) {
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match fixture
            .runtime
            .finish_package_quiesce(&mut fixture.store, stop)
        {
            Ok(()) => return,
            Err(error) if error.code == ErrorCode::Busy => {
                assert!(Instant::now() < deadline, "original package did not drain");
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Err(error) => panic!("unexpected original package drain error: {error:?}"),
        }
    }
}
fn assert_held_service_child_drains(retired: bool) {
    let (mut fixture, observed, _) = held_service_fixture();
    let (prepared, receipt) = fixture.submit();
    let original_input = prepared.input().bytes().to_vec();
    let budget = fixture
        .store
        .provider_budget(receipt.parent_task)
        .unwrap()
        .unwrap();
    fixture.runtime.tick(&mut fixture.store).unwrap();
    let held = observed
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert_eq!(held.request.input.envelope().attempt_id, receipt.attempt_id);
    assert!(held.request.input.envelope().plugin.is_none());
    fixture.complete_outer();
    let selected = fixture.origin.record.invocation.provider.clone();
    let stop = fixture
        .runtime
        .begin_package_quiesce(
            &mut fixture.store,
            ExecutionId::new(),
            &selected.plugin,
            &selected.package_digest,
        )
        .unwrap();
    if retired {
        let deadline = Instant::now() + std::time::Duration::from_secs(8);
        loop {
            fixture.runtime.tick(&mut fixture.store).unwrap();
            let state = fixture
                .store
                .execution_attempt(receipt.attempt_id, false)
                .unwrap();
            if !fixture.runtime.is_active(receipt.attempt_id)
                && state.items[0].execution == ExecutionState::Unknown
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "service child did not retire after cancellation wait"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            fixture
                .runtime
                .has_unsettled_attempt(&fixture.store, receipt.attempt_id)
                .unwrap()
        );
    }
    let unfinished = fixture
        .runtime
        .finish_package_quiesce(&mut fixture.store, &stop);
    assert!(
        matches!(unfinished, Err(ref error) if error.code == ErrorCode::Busy),
        "held service child must block its original package drain: {unfinished:?}"
    );
    assert!(held.cancellation.is_requested());
    assert_eq!(
        fixture
            .runtime
            .submit_work_plan_service_child(&mut fixture.store, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(
        fixture
            .store
            .provider_budget(receipt.parent_task)
            .unwrap()
            .unwrap(),
        budget
    );
    held.release.send(()).unwrap();
    finish_original_package(&mut fixture, &stop);
    assert_eq!(
        fixture
            .store
            .work_plan_service_receipt(&receipt.identity, &fixture.call)
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        fixture
            .store
            .execution_input_if_present(receipt.attempt_id)
            .unwrap()
            .unwrap()
            .bytes(),
        original_input
    );
    assert_eq!(
        fixture
            .store
            .provider_budget(receipt.parent_task)
            .unwrap()
            .unwrap(),
        budget
    );
}

#[test]
fn package_stop_waits_for_active_service_child_before_completing() {
    assert_held_service_child_drains(false);
}

#[test]
fn package_stop_waits_for_retired_service_child_before_completing() {
    assert_held_service_child_drains(true);
}

#[test]
fn package_stop_cancels_queued_service_child_without_changing_original_receipt_or_budget() {
    let (mut fixture, observed, _) = held_service_fixture();
    let (prepared, receipt) = fixture.submit();
    fixture.complete_outer();
    let budget = fixture
        .store
        .provider_budget(receipt.parent_task)
        .unwrap()
        .unwrap();
    let selected = fixture.origin.record.invocation.provider.clone();
    let stop = fixture
        .runtime
        .begin_package_quiesce(
            &mut fixture.store,
            ExecutionId::new(),
            &selected.plugin,
            &selected.package_digest,
        )
        .unwrap();
    finish_original_package(&mut fixture, &stop);
    let state = fixture
        .store
        .execution_attempt(receipt.attempt_id, false)
        .unwrap();
    assert!(
        state.items.iter().all(
            |item| item.execution == ExecutionState::CancelledBeforeDispatch
                && item.cancellation_requested
        ),
        "queued service child must retain its original package cancellation: {state:?}"
    );
    assert!(matches!(
        observed.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert_eq!(
        fixture
            .runtime
            .submit_work_plan_service_child(&mut fixture.store, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(
        fixture
            .store
            .provider_budget(receipt.parent_task)
            .unwrap()
            .unwrap(),
        budget
    );
}

#[test]
fn package_stop_waits_for_service_outcome_query_without_stopping_shared_model_peer() {
    let (mut fixture, observed, held_query) = held_service_fixture();
    let (prepared, receipt) = fixture.submit();
    let (peer, _) = fixture.submit_peer();
    for input in [prepared.input(), peer.input()] {
        let dispatch = fixture
            .store
            .dispatch_execution_item(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap();
        fixture
            .store
            .note_execution_unknown(
                dispatch.input.envelope().attempt_id,
                dispatch.item_id,
                "original-query-outcome",
            )
            .unwrap();
    }
    fixture.complete_outer();
    held_query.lock().unwrap().held = Some(receipt.attempt_id);
    let query = fixture
        .runtime
        .outcome_query(
            &fixture.store,
            receipt.attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let peer_query = fixture
        .runtime
        .outcome_query(
            &fixture.store,
            peer.input().envelope().attempt_id,
            peer.input().envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let worker = std::thread::spawn(move || query.run());
    let held = observed
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert_eq!(held.request.input.envelope().attempt_id, receipt.attempt_id);
    let selected = fixture.origin.record.invocation.provider.clone();
    let stop = fixture
        .runtime
        .begin_package_quiesce(
            &mut fixture.store,
            ExecutionId::new(),
            &selected.plugin,
            &selected.package_digest,
        )
        .unwrap();
    assert!(matches!(peer_query.run(), Ok(QueryOutcome::Pending)));
    let unfinished = fixture
        .runtime
        .finish_package_quiesce(&mut fixture.store, &stop);
    assert!(
        matches!(unfinished, Err(ref error) if error.code == ErrorCode::Busy),
        "running service query must block only its original package: {unfinished:?}"
    );
    held.release.send(()).unwrap();
    assert!(matches!(worker.join().unwrap(), Ok(QueryOutcome::Pending)));
    finish_original_package(&mut fixture, &stop);
    assert!(matches!(peer_query.run(), Ok(QueryOutcome::Pending)));
    assert_eq!(
        fixture
            .store
            .work_plan_service_receipt(&receipt.identity, &fixture.call)
            .unwrap(),
        Some(receipt)
    );
}

#[test]
fn cached_service_outcome_query_cannot_start_after_its_original_package_stops() {
    let (mut fixture, observed, query_observation) = held_service_fixture();
    let (prepared, receipt) = fixture.submit();
    let budget = fixture
        .store
        .provider_budget(receipt.parent_task)
        .unwrap()
        .unwrap();
    let dispatch = fixture
        .store
        .dispatch_execution_item(
            receipt.attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap();
    fixture
        .store
        .note_execution_unknown(
            receipt.attempt_id,
            dispatch.item_id,
            "original-query-outcome",
        )
        .unwrap();
    let query = fixture
        .runtime
        .outcome_query(&fixture.store, receipt.attempt_id, dispatch.item_id)
        .unwrap()
        .unwrap();
    fixture.complete_outer();
    let selected = fixture.origin.record.invocation.provider.clone();
    let stop = fixture
        .runtime
        .begin_package_quiesce(
            &mut fixture.store,
            ExecutionId::new(),
            &selected.plugin,
            &selected.package_digest,
        )
        .unwrap();
    finish_original_package(&mut fixture, &stop);
    let before = query_observation.lock().unwrap().entered.clone();
    assert_eq!(
        before
            .iter()
            .filter(|attempt| **attempt == receipt.attempt_id)
            .count(),
        0
    );
    let outcome = query.run();
    let after = query_observation.lock().unwrap().entered.clone();
    assert_eq!(
        after
            .iter()
            .filter(|attempt| **attempt == receipt.attempt_id)
            .count(),
        0,
        "the stopped original query must never enter Runner.query, even before returning an error"
    );
    assert_eq!(
        after, before,
        "the captured query must not perform runner I/O before rejection"
    );
    assert!(
        outcome.is_err(),
        "the captured service query must not renew its original caller permission"
    );
    assert!(matches!(
        observed.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    assert_eq!(
        fixture
            .store
            .work_plan_service_receipt(&receipt.identity, &fixture.call)
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        fixture
            .store
            .provider_budget(receipt.parent_task)
            .unwrap()
            .unwrap(),
        budget
    );
}

#[test]
fn service_tracking_preparation_is_read_only_and_does_not_restore_enqueued_children() {
    let mut fixture = Fixture::new();
    let prepared = fixture.prepare();
    let sequence = fixture.store.execution_sequence().unwrap();
    for _ in 0..2 {
        fixture
            .store
            .check_prepared_work_plan_service_generation(&prepared)
            .unwrap();
    }
    assert_eq!(fixture.store.execution_sequence().unwrap(), sequence);
    assert!(
        fixture
            .store
            .execution_input_if_present(prepared.input().envelope().attempt_id)
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .store
            .provider_budget(prepared.input().envelope().task_id)
            .unwrap()
            .is_none()
    );
    let receipt = fixture
        .runtime
        .submit_work_plan_service_child(&mut fixture.store, &prepared)
        .unwrap();
    let sequence = fixture.store.execution_sequence().unwrap();
    let error = fixture
        .store
        .check_prepared_work_plan_service_generation(&prepared)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unauthorized);
    assert_eq!(error.stage, "service-child-enqueued");
    assert_eq!(
        fixture
            .store
            .work_plan_service_receipt(&receipt.identity, &fixture.call)
            .unwrap(),
        Some(receipt)
    );
    assert_eq!(fixture.store.execution_sequence().unwrap(), sequence);
}

#[test]
fn service_tracking_preparation_rechecks_original_revocation_before_enqueue() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare();
    fixture.settings_revocation.request();
    assert_eq!(
        fixture
            .store
            .check_prepared_work_plan_service_generation(&prepared)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        fixture
            .store
            .execution_input_if_present(prepared.input().envelope().attempt_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn committed_service_child_receipt_read_failure_retains_original_input() {
    let mut fixture = Fixture::new();
    let prepared = fixture.prepare();
    let identity = prepared.identity().unwrap();
    fixture
        .store
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TEMP TRIGGER corrupt_service_ack AFTER INSERT ON application_service_calls
             BEGIN
                 UPDATE application_service_calls SET origin=x'00'
                 WHERE child_attempt=NEW.child_attempt;
             END;",
        )
        .unwrap();
    let error = fixture
        .runtime
        .submit_work_plan_service_child(&mut fixture.store, &prepared)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::OutcomeUnknown);
    let read_error = fixture
        .store
        .work_plan_service_receipt(&identity, &fixture.call)
        .unwrap_err();
    assert_eq!(read_error.code, ErrorCode::CorruptLedger);
    assert_eq!(error.stage, read_error.stage);
    assert_eq!(error.item_ids, read_error.item_ids);
    assert_eq!(error.conflict, read_error.conflict);
    let child = prepared.input().envelope().attempt_id;
    let retained = fixture
        .runtime
        .input_if_present(&fixture.store, child)
        .unwrap()
        .unwrap();
    assert_eq!(retained.bytes(), prepared.input().bytes());
    assert!(
        fixture
            .runtime
            .has_unsettled_attempt(&fixture.store, child)
            .unwrap()
    );
    assert_eq!(
        fixture.store.execution_attempt(child, false).unwrap().items[0].execution,
        ExecutionState::Queued
    );
    let calls: i64 = fixture
        .store
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM application_service_calls WHERE child_attempt=?1",
            [child.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(calls, 1);
}

#[test]
fn service_generation_is_atomic_and_same_call_receipts_do_not_enqueue_again() {
    let mut fixture = Fixture::new();
    let prepared = fixture.prepare();
    fixture.store.connection().unwrap().execute_batch("CREATE TEMP TRIGGER reject_service BEFORE INSERT ON application_service_calls BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert_eq!(
        fixture
            .runtime
            .submit_work_plan_service_child(&mut fixture.store, &prepared)
            .unwrap_err()
            .code,
        ErrorCode::StorageFailed
    );
    assert!(
        fixture
            .store
            .execution_input_if_present(prepared.input.envelope().attempt_id)
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .store
            .provider_budget(prepared.input.envelope().task_id)
            .unwrap()
            .is_none()
    );
    fixture
        .store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_service;")
        .unwrap();
    let (_, receipt) = fixture.submit();
    fixture.complete_outer();
    assert!(fixture.dispatch.plugin_permit().unwrap().is_authorized());
    fixture
        .store
        .check_work_plan_input(prepared.input())
        .unwrap();
    let sequence = fixture.store.execution_sequence().unwrap();
    assert_eq!(
        fixture
            .runtime
            .submit_work_plan_service_child(&mut fixture.store, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(fixture.store.execution_sequence().unwrap(), sequence);
    assert_eq!(
        fixture
            .store
            .provider_budget(receipt.parent_task)
            .unwrap()
            .unwrap()
            .limit,
        2
    );
    let child = fixture
        .store
        .provider_budget(receipt.task_id)
        .unwrap()
        .unwrap();
    assert_eq!((child.limit, child.dispatched), (2, 0));
    let mut different = fixture.call.clone();
    let mut generation = different
        .validate(
            &fixture.origin.record.service,
            &fixture.origin.record.invocation.context,
        )
        .unwrap();
    generation.attempt_id = ExecutionId::new();
    different.input = sdk::EncodedPayload::capture(
        different.input.schema.clone(),
        serde_json::to_string(&generation).unwrap(),
    )
    .unwrap();
    assert_eq!(
        fixture
            .store
            .work_plan_service_receipt(&receipt.identity, &different)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    assert_eq!(
        fixture
            .store
            .prepare_work_plan_service_generation(&fixture.origin, &different)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    fixture.origin.revocation().request();
    assert_eq!(
        fixture
            .runtime
            .submit_work_plan_service_child(&mut fixture.store, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(
        fixture
            .store
            .check_work_plan_input(prepared.input())
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(fixture.store.execution_sequence().unwrap(), sequence);
}

#[test]
fn service_origin_gates_actual_http_reservations_and_candidate_adoption() {
    let mut fixture = Fixture::new();
    let (prepared, receipt) = fixture.submit();
    fixture.complete_outer();
    let input = prepared.input();
    let item = &input.envelope().items[0];
    let dispatch = fixture
        .store
        .dispatch_execution_item(receipt.attempt_id, item.item_id)
        .unwrap();
    fixture
        .store
        .reserve_provider_request(&dispatch, ExecutionId::new(), 2)
        .unwrap();
    let output = AiOutput {
        unit_id: ExecutionId::parse(&item.scope.id).unwrap(),
        target_locale: "zh-CN".into(),
        text: "synthetic candidate".into(),
        usage: None,
        requests: 1,
        usage_incomplete: true,
    };
    let result = FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: receipt.attempt_id,
            item_id: item.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: dispatch.dispatch_token,
            capability_id: input.envelope().capability_id.clone(),
            capability_version: input.envelope().capability_version.clone(),
            plugin: None,
            outcome: ExecutionState::Succeeded,
            output: Some(serde_json::to_value(output).unwrap()),
            diagnostic: None,
        },
        input,
        dispatch.dispatch_token,
    )
    .unwrap();
    fixture.store.save_execution_result(&result).unwrap();
    fixture
        .store
        .validate_execution_result(receipt.attempt_id, result.envelope().result_id)
        .unwrap();
    let action = fixture
        .store
        .prepare_adoption(
            receipt.attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::Value::Null,
        )
        .unwrap();
    fixture.store.capture_execution_adoption(&action).unwrap();
    fixture
        .runtime
        .revoke_plugin(&mut fixture.store, receipt.grant_id)
        .unwrap();
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        fixture
            .store
            .reserve_provider_request(&dispatch, ExecutionId::new(), 2)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        fixture
            .store
            .capture_execution_adoption(&action)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let budget = fixture
        .store
        .provider_budget(receipt.parent_task)
        .unwrap()
        .unwrap();
    assert_eq!((budget.dispatched, budget.unresolved), (1, 1));
    assert_eq!(
        fixture
            .store
            .work_plan_service_receipt(&receipt.identity, &fixture.call)
            .unwrap(),
        Some(receipt)
    );
}

#[test]
fn service_origin_rejects_forged_context_and_reconstructed_dispatch_deadlines() {
    let fixture = Fixture::new();
    let mut invocation = fixture.origin.record.invocation.clone();
    invocation.context.configuration_digest = "c".repeat(64);
    assert!(
        fixture
            .store
            .capture_work_plan_service_origin(
                &fixture.origin.scope,
                &fixture.dispatch,
                &invocation,
                &fixture.origin.record.service,
                fixture.origin.deadline(),
                &fixture.cancellation,
                &fixture.settings_revocation,
            )
            .is_err()
    );
    let historical = fixture
        .store
        .execution_dispatch(
            fixture.dispatch.input.envelope().attempt_id,
            fixture.dispatch.item_id,
        )
        .unwrap();
    assert!(historical.deadline().is_none());
    assert_eq!(
        fixture
            .store
            .capture_work_plan_service_origin(
                &fixture.origin.scope,
                &historical,
                &fixture.origin.record.invocation,
                &fixture.origin.record.service,
                fixture.origin.deadline(),
                &fixture.cancellation,
                &fixture.settings_revocation,
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let extended = fixture
        .store
        .capture_work_plan_service_origin(
            &fixture.origin.scope,
            &fixture.dispatch,
            &fixture.origin.record.invocation,
            &fixture.origin.record.service,
            Instant::now() + std::time::Duration::from_secs(3600),
            &fixture.cancellation,
            &fixture.settings_revocation,
        )
        .unwrap();
    assert_eq!(
        extended.deadline(),
        fixture.dispatch.deadline().unwrap().min(
            fixture
                .dispatch
                .plugin_permit()
                .unwrap()
                .original_deadline()
        )
    );
    let mut expired = fixture.dispatch.clone();
    let deadline = expired.original_deadline.as_mut().unwrap();
    deadline.instant = Instant::now() - std::time::Duration::from_millis(1);
    deadline.expires_at_ms = plugin_now_ms().unwrap() - 1;
    assert_eq!(
        fixture
            .store
            .capture_work_plan_service_origin(
                &fixture.origin.scope,
                &expired,
                &fixture.origin.record.invocation,
                &fixture.origin.record.service,
                Instant::now() + std::time::Duration::from_secs(3600),
                &fixture.cancellation,
                &fixture.settings_revocation,
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut automatic = fixture.dispatch.clone();
    let mut envelope = automatic.input.envelope().clone();
    envelope.automation = Some(fixture.origin.scope.lease());
    automatic.input = FixedInput::capture(envelope).unwrap();
    assert_eq!(
        fixture
            .store
            .capture_work_plan_service_origin(
                &fixture.origin.scope,
                &automatic,
                &fixture.origin.record.invocation,
                &fixture.origin.record.service,
                fixture.origin.deadline(),
                &fixture.cancellation,
                &fixture.settings_revocation,
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut unknown_field = fixture.call.clone();
    let mut proposal: serde_json::Value = serde_json::from_str(&unknown_field.input.utf8).unwrap();
    proposal["config"] = json!({"maxRequests": 300});
    unknown_field.input =
        sdk::EncodedPayload::capture(unknown_field.input.schema.clone(), proposal.to_string())
            .unwrap();
    assert!(
        fixture
            .store
            .prepare_work_plan_service_generation(&fixture.origin, &unknown_field)
            .is_err()
    );
    let mut wrong_service = fixture.origin.record.service.clone();
    wrong_service.contract = contract("example.ungranted");
    assert_eq!(
        fixture
            .store
            .capture_work_plan_service_origin(
                &fixture.origin.scope,
                &fixture.dispatch,
                &fixture.origin.record.invocation,
                &wrong_service,
                fixture.origin.deadline(),
                &fixture.cancellation,
                &fixture.settings_revocation,
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
}

#[test]
fn service_origin_requires_the_public_generation_schema_before_child_enqueue() {
    let fixture = Fixture::new();
    let generation =
        sdk::parse_generation_service_input(fixture.call.input.utf8.as_bytes()).unwrap();
    for change in 0..4 {
        let mut service = fixture.origin.record.service.clone();
        match change {
            0 => service.input_schema.schema_version += 1,
            1 => service.output_schema.id = "example.other-output".into(),
            2 => service.error_schema.behavior_version += 1,
            _ => service.input_schema.id = "example.opaque-generation".into(),
        }
        let error = fixture
            .store
            .capture_work_plan_service_origin(
                &fixture.origin.scope,
                &fixture.dispatch,
                &fixture.origin.record.invocation,
                &service,
                fixture.origin.deadline(),
                &fixture.cancellation,
                &fixture.settings_revocation,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.stage, "service-generation-contract");
    }
    assert!(
        fixture
            .store
            .execution_attempt_ids(ExecutionId::parse(&generation.task_id).unwrap())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn service_child_retains_original_cancellation_until_terminal_and_cannot_restore_it() {
    let mut fixture = Fixture::new();
    let (prepared, receipt) = fixture.submit();
    fixture.complete_outer();
    fixture.cancellation.request();
    assert_eq!(
        fixture
            .store
            .dispatch_execution_item(
                receipt.attempt_id,
                prepared.input.envelope().items[0].item_id
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        fixture
            .store
            .execution_attempt(receipt.attempt_id, false)
            .unwrap()
            .items[0]
            .execution,
        ExecutionState::CancelledBeforeDispatch
    );
    let path = fixture.store.directory().to_path_buf();
    let sequence = fixture.store.execution_sequence().unwrap();
    drop(fixture.runtime);
    fixture.store.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    let mut runtime = ExecutionRuntime::new(&reopened).unwrap();
    assert_eq!(
        reopened
            .work_plan_service_receipt(&receipt.identity, &fixture.call)
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        runtime
            .submit_work_plan_service_child(&mut reopened, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(reopened.execution_sequence().unwrap(), sequence);
    assert_eq!(
        reopened
            .check_work_plan_input(prepared.input())
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut retry = prepared.input().envelope().clone();
    retry.attempt_id = ExecutionId::new();
    let retry = FixedInput::capture(retry).unwrap();
    assert_eq!(
        reopened
            .enqueue_execution_with_policy(
                &retry,
                RecoveryPolicy::ExternalUnknown,
                Some(receipt.parent_task)
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        reopened
            .execution_input_if_present(retry.envelope().attempt_id)
            .unwrap()
            .is_none()
    );
    assert!(
        reopened
            .capture_work_plan_service_origin(
                &fixture.origin.scope,
                &fixture.dispatch,
                &fixture.origin.record.invocation,
                &fixture.origin.record.service,
                fixture.origin.deadline(),
                &Cancellation::default(),
                &Cancellation::default(),
            )
            .is_err()
    );
    let budget = reopened
        .provider_budget(receipt.parent_task)
        .unwrap()
        .unwrap();
    assert_eq!((budget.dispatched, budget.unresolved), (0, 0));
}

#[test]
fn service_revocation_after_reservation_prevents_the_actual_http_send() {
    revoke_after_reservation(false);
}

#[test]
fn installed_settings_revocation_after_channel_completion_prevents_actual_http_send() {
    revoke_after_reservation(true);
}

fn revoke_after_reservation(settings_changed: bool) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let mut fixture = Fixture::with_endpoint(endpoint);
    let (prepared, receipt) = fixture.submit();
    if settings_changed {
        fixture.complete_outer();
    }
    let mut dispatch = fixture
        .store
        .dispatch_execution_item(
            receipt.attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap();
    let (budget, events) = crate::ai::provider::budget_channel();
    dispatch.provider = Some(budget);
    let settings = crate::ai::settings(prepared.input()).unwrap();
    let item = crate::ai::item_payload(prepared.input(), dispatch.item_id).unwrap();
    std::thread::scope(|scope| {
        let runner = crate::ai::AiRunner::with_service(Arc::new(
            crate::ai::provider::ProviderService::default(),
        ));
        let worker_dispatch = dispatch.clone();
        let worker = scope.spawn(move || {
            runner.execute_config(
                &worker_dispatch,
                &Cancellation::default(),
                &settings.config,
                &item,
            )
        });
        let event = events
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let crate::ai::provider::BudgetEvent::Reserve { id, limit, reply } = event else {
            panic!("expected real reservation")
        };
        fixture
            .store
            .reserve_provider_request(&dispatch, id, limit)
            .unwrap();
        if settings_changed {
            fixture.settings_revocation.request();
            assert!(!fixture.cancellation.is_requested());
            assert!(!fixture.origin.revocation().is_requested());
        } else {
            fixture.origin.revocation().request();
        }
        reply.send(Ok(())).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::Unauthorized
        );
    });
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let budget = fixture
        .store
        .provider_budget(receipt.parent_task)
        .unwrap()
        .unwrap();
    assert_eq!((budget.dispatched, budget.unresolved), (1, 1));
    assert_eq!(
        fixture
            .store
            .work_plan_service_receipt(&receipt.identity, &fixture.call)
            .unwrap(),
        Some(receipt)
    );
}

#[test]
fn in_flight_http_wait_is_bounded_by_the_original_service_deadline() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let mut fixture = Fixture::with_endpoint(endpoint);
    let deadline = Instant::now() + std::time::Duration::from_millis(350);
    fixture.origin = fixture
        .store
        .capture_work_plan_service_origin(
            &fixture.origin.scope,
            &fixture.dispatch,
            &fixture.origin.record.invocation,
            &fixture.origin.record.service,
            deadline,
            &fixture.cancellation,
            &fixture.settings_revocation,
        )
        .unwrap();
    let (prepared, receipt) = fixture.submit();
    let mut dispatch = fixture
        .store
        .dispatch_execution_item(
            receipt.attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap();
    let (budget, events) = crate::ai::provider::budget_channel();
    dispatch.provider = Some(budget);
    let settings = crate::ai::settings(prepared.input()).unwrap();
    assert!(settings.config.timeout_seconds >= 1);
    let item = crate::ai::item_payload(prepared.input(), dispatch.item_id).unwrap();
    std::thread::scope(|scope| {
        let server = scope.spawn(move || {
            let limit = Instant::now() + std::time::Duration::from_secs(2);
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < limit,
                            "actual request reached synthetic server"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(error) => panic!("synthetic listener: {error}"),
                }
            };
            std::thread::sleep(std::time::Duration::from_secs(1));
            drop(stream);
        });
        let runner = crate::ai::AiRunner::with_service(Arc::new(
            crate::ai::provider::ProviderService::default(),
        ));
        let worker_dispatch = dispatch.clone();
        let started = Instant::now();
        let worker = scope.spawn(move || {
            runner.execute_config(
                &worker_dispatch,
                &Cancellation::default(),
                &settings.config,
                &item,
            )
        });
        let crate::ai::provider::BudgetEvent::Reserve { id, limit, reply } = events
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
        else {
            panic!("expected actual HTTP reservation")
        };
        fixture
            .store
            .reserve_provider_request(&dispatch, id, limit)
            .unwrap();
        reply.send(Ok(())).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::OutcomeUnknown
        );
        assert!(
            started.elapsed() < std::time::Duration::from_millis(800),
            "in-flight wait must finish before the server or original model timeout"
        );
        server.join().unwrap();
    });
    let budget = fixture
        .store
        .provider_budget(receipt.parent_task)
        .unwrap()
        .unwrap();
    assert_eq!((budget.dispatched, budget.unresolved), (1, 1));
    assert_eq!(
        fixture
            .store
            .check_work_plan_input(prepared.input())
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
}

#[test]
fn attempt_service_origin_rejects_rescoping_and_grant_substitution_and_reopens_without_authority() {
    let mut f = Fixture::with_model_scope(
        "http://127.0.0.1:9/v1/chat/completions".into(),
        Arc::new(Registered { plugin: None }),
        sdk::ComponentScope::Attempt,
    );
    let attempt = f.dispatch.input.envelope().attempt_id;
    let project = f.dispatch.input.envelope().project_id;
    assert_eq!(f.origin.record.service.scope_id, attempt.to_string());
    for mutation in 0..5 {
        let mut forged = f.origin.clone();
        match mutation {
            0 => forged.record.service.scope_id = project.to_string(),
            1 => {
                forged.record.service.scope_id = project.to_string();
                forged.record.invocation.context.scope_id = project.to_string();
            }
            2 => forged.record.grant_id = ExecutionId::new(),
            3 => forged.record.invocation.context.attempt_id = ExecutionId::new().to_string(),
            4 => forged.record.invocation.context.project_id = ExecutionId::new().to_string(),
            _ => unreachable!(),
        }
        assert!(
            f.store
                .prepare_work_plan_service_generation(&forged, &f.call)
                .is_err(),
            "mutation {mutation}"
        );
    }
    let (prepared, receipt) = f.submit();
    f.complete_outer();
    let sequence = f.store.execution_sequence().unwrap();
    assert_eq!(
        f.runtime
            .submit_work_plan_service_child(&mut f.store, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(f.store.execution_sequence().unwrap(), sequence);
    f.settings_revocation.request();
    assert!(f.store.check_work_plan_input(prepared.input()).is_err());
    // ACK reads retain the original accepted identity; they grant no new work.
    assert_eq!(
        f.store
            .work_plan_service_receipt(&receipt.identity, &f.call)
            .unwrap(),
        Some(receipt.clone())
    );
    let path = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let mut reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .work_plan_service_receipt(&receipt.identity, &f.call)
            .unwrap(),
        Some(receipt.clone())
    );
    let mut runtime = ExecutionRuntime::new(&reopened).unwrap();
    assert_eq!(
        runtime
            .submit_work_plan_service_child(&mut reopened, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(reopened.execution_sequence().unwrap(), sequence);
    assert_eq!(
        reopened
            .check_work_plan_input(prepared.input())
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let mut retry = prepared.input().envelope().clone();
    retry.attempt_id = ExecutionId::new();
    let retry = FixedInput::capture(retry).unwrap();
    assert_eq!(
        reopened
            .enqueue_execution_with_policy(
                &retry,
                RecoveryPolicy::ExternalUnknown,
                Some(receipt.parent_task)
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        reopened
            .execution_input_if_present(retry.envelope().attempt_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(reopened.execution_sequence().unwrap(), sequence);
}

#[test]
fn original_plugin_start_read_validates_exact_input_before_reconciling() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        crate::ProjectMetadata::create("Plugin start proof", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let plugin = binding();
    let owner = store.metadata().unwrap().project_id();
    let mut envelope = InputEnvelope::new(
        owner,
        "fixture",
        &plugin.capability.declaration.contract.id,
        &plugin.capability_version(),
        vec![InputItem::new(
            Scope {
                kind: "fixture".into(),
                id: "original".into(),
                locale: None,
            },
            json!({"original":true}),
            vec![],
        )],
    )
    .unwrap();
    envelope.plugin = Some(plugin);
    let input = FixedInput::capture(envelope).unwrap();
    let owner = input.envelope().project_id;
    let task = input.envelope().task_id;
    let attempt = input.envelope().attempt_id;
    let expected = PluginStartActionRead {
        project_id: owner,
        task_id: task,
        attempt_id: attempt,
        operation: "fixture".into(),
        input_digest: input.digest().into(),
    };
    store
        .execution_unknown
        .store(true, std::sync::atomic::Ordering::Release);
    assert!(
        store
            .plugin_start_action_read(ExecutionId::new(), task, attempt, "fixture", input.digest())
            .is_err()
    );
    assert!(store.is_reconciling());
    assert_eq!(
        store
            .plugin_start_action_read(owner, task, attempt, "fixture", input.digest())
            .unwrap(),
        None
    );
    assert!(!store.is_reconciling());
    assert_eq!(
        store.enqueue_execution(&input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register(Arc::new(Registered {
            plugin: input.envelope().plugin.clone(),
        }))
        .unwrap();
    runtime
        .authorize_plugin(
            &mut store,
            ExecutionId::new(),
            &input,
            plugin_now_ms().unwrap() + 60_000,
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: false,
            },
        )
        .unwrap();
    runtime.submit(&mut store, &input).unwrap();
    for (project, task, operation, digest) in [
        (
            ExecutionId::new(),
            task,
            "fixture",
            input.digest().to_owned(),
        ),
        (
            owner,
            ExecutionId::new(),
            "fixture",
            input.digest().to_owned(),
        ),
        (owner, task, "another-operation", input.digest().to_owned()),
        (owner, task, "fixture", "0".repeat(64)),
    ] {
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(
            store
                .plugin_start_action_read(project, task, attempt, operation, &digest)
                .is_err()
        );
        assert!(store.is_reconciling());
    }
    assert_eq!(
        store
            .plugin_start_action_read(owner, task, attempt, "fixture", input.digest())
            .unwrap(),
        Some(expected.clone())
    );
    assert!(!store.is_reconciling());
    store
        .execution_unknown
        .store(true, std::sync::atomic::Ordering::Release);
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE execution_attempts SET digest=?2 WHERE attempt_id=?1",
            params![attempt.to_string(), "0".repeat(64)],
        )
        .unwrap();
    assert!(
        store
            .plugin_start_action_read(owner, task, attempt, "fixture", input.digest())
            .is_err()
    );
    assert!(store.is_reconciling());
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE execution_attempts SET digest=?2 WHERE attempt_id=?1",
            params![attempt.to_string(), input.digest()],
        )
        .unwrap();
    assert_eq!(
        store
            .plugin_start_action_read(owner, task, attempt, "fixture", input.digest())
            .unwrap(),
        Some(expected.clone())
    );
    assert!(!store.is_reconciling());
    let sequence = store.execution_sequence().unwrap();
    let revision = store.metadata().unwrap().metadata_revision();
    store.set_target_locales(revision, &["ja".into()]).unwrap();
    assert_eq!(
        store
            .plugin_start_action_read(owner, task, attempt, "fixture", input.digest())
            .unwrap(),
        Some(expected.clone())
    );
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .plugin_start_action_read(owner, task, attempt, "fixture", input.digest())
            .unwrap(),
        Some(expected)
    );
    assert_eq!(reopened.execution_sequence().unwrap(), sequence);
}
