use super::*;
use crate::ai::{AiConfig, AiOutput};
use serde_json::json;

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
                        contract: contract("example.ai-generation"),
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
    call: WorkPlanServiceCall,
}
impl Fixture {
    fn new() -> Self {
        Self::with_endpoint("http://127.0.0.1:9/v1/chat/completions".into())
    }
    fn with_endpoint(endpoint: String) -> Self {
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
        let plugin = binding();
        let mut envelope = InputEnvelope::new(
            root.envelope().project_id,
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
        runtime
            .register(Arc::new(Registered { plugin: None }))
            .unwrap();
        runtime
            .authorize_plugin(
                &mut store,
                ExecutionId::new(),
                &outer,
                plugin_now_ms().unwrap() + 60000,
                PluginConsent {
                    unsandboxed_execution: true,
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
            contract: contract("example.ai-generation"),
            input_schema: contract("example.ai-generation-input"),
            output_schema: contract("example.ai-generation-receipt"),
            error_schema: contract("example.ai-generation-error"),
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
        let origin = store
            .capture_work_plan_service_origin(
                &scope,
                &dispatch,
                &invocation,
                &service,
                dispatch.deadline().unwrap(),
                &cancellation,
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
                contract("example.ai-generation-input"),
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
            call,
        }
    }
    fn prepare(&self) -> PreparedWorkPlanServiceGeneration {
        self.store
            .prepare_work_plan_service_generation(&self.origin, &self.call)
            .unwrap()
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
                &fixture.cancellation
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
                &fixture.cancellation
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
        )
        .unwrap();
    assert_eq!(extended.deadline(), fixture.dispatch.deadline().unwrap());
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
                &fixture.cancellation
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
                &fixture.cancellation
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
                &fixture.cancellation
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
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
                &Cancellation::default()
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
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let mut fixture = Fixture::with_endpoint(endpoint);
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
        fixture.origin.revocation().request();
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
