use super::*;
use std::time::Duration;

fn query_tool() -> WorkPlanToolSpec {
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../../../../../plugin-sdk/tests/fixtures/tool.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_tool_declaration(include_bytes!(
        "../../../../../../plugin-sdk/tests/fixtures/tool.query.json"
    ))
    .unwrap();
    let binding = declaration.bind(&manifest, &"b".repeat(64)).unwrap();
    let mut execution = super::binding();
    execution.capability = binding.capability.clone();
    execution.profile = binding.declaration.profile.clone();
    WorkPlanToolSpec {
        handle: ExecutionId::new(),
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

struct ToolFixture {
    _directory: tempfile::TempDir,
    store: ProjectStore,
    runtime: ExecutionRuntime,
    origin: WorkPlanServiceOrigin,
    prepared: PreparedWorkPlanTool,
    consent: WorkPlanToolConsent,
    call: WorkPlanServiceCall,
    dispatch: DispatchRequest,
    cancellation: Cancellation,
    settings: Cancellation,
    grant: ExecutionId,
}
impl ToolFixture {
    fn new() -> Self {
        Self::with_runner(|tool| {
            Arc::new(Registered {
                plugin: Some(tool.execution.clone()),
            })
        })
    }
    fn with_runner(runner: impl FnOnce(&WorkPlanToolSpec) -> Arc<dyn Runner>) -> Self {
        let (directory, mut store, _) =
            crate::persistence::review::tests::current_release_fixture(false);
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
        let tool = query_tool();
        let plan = store
            .prepare_work_plan_with_tools(
                Some(AiConfig {
                    endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                    model: "synthetic-model".into(),
                    credential_env: String::new(),
                    ..AiConfig::default()
                }),
                "zh-CN",
                &[unit],
                PlanOptions::default(),
                Some(WorkPlanTools {
                    max_invocations: 2,
                    entries: vec![tool.clone()],
                }),
            )
            .unwrap();
        let authorization = store
            .authorize_work_plan(
                &plan,
                &AuthorizeWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_digest: plan.digest.clone(),
                    confirmed: true,
                    effects: plan.authorization_effects().unwrap(),
                    expires_at: control::now().unwrap() + 600,
                },
            )
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(runner(&tool)).unwrap();
        runtime
            .register(Arc::new(Registered { plugin: None }))
            .unwrap();
        let consent = runtime
            .authorize_work_plan_tools(
                &store,
                authorization.lease,
                plugin_now_ms().unwrap() + 60_000,
                Instant::now() + Duration::from_secs(60),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
            )
            .unwrap();
        let root = FixedInput::capture(authorization.input.unwrap()).unwrap();
        store.enqueue_execution(&root).unwrap();
        let scope = store.work_plan_agent_scope(authorization.lease).unwrap();
        let prepared = store
            .prepare_work_plan_agent_tool(
                &scope,
                &AgentToolRequest {
                    task_id: ExecutionId::new(),
                    attempt_id: ExecutionId::new(),
                    tool_handle: tool.handle,
                    unit_ids: vec![unit],
                },
            )
            .unwrap();
        let payload = sdk::EncodedPayload::capture(
            tool.binding.capability.declaration.input_schema.clone(),
            serde_json::to_string(&prepared.input.envelope().items[0].payload).unwrap(),
        )
        .unwrap();
        let call = WorkPlanServiceCall {
            handle_id: "prepared-tool-0".into(),
            call_id: prepared.input.envelope().attempt_id.to_string(),
            input: payload,
        };
        let wrapper = sdk::GenerationComponentInput {
            generation: sdk::GenerationServiceInput {
                task_id: ExecutionId::new().to_string(),
                attempt_id: ExecutionId::new().to_string(),
                unit_ids: vec![unit.to_string()],
            },
            prepared_tools: vec![sdk::PreparedToolServiceCall {
                handle_id: call.handle_id.clone(),
                call_id: call.call_id.clone(),
                tool_handle: tool.handle.to_string(),
                input: call.input.clone(),
            }],
        };
        let mut plugin = super::binding();
        plugin.capability.declaration.input_schema = sdk::generation_component_input_contract();
        plugin.capability.declaration.output_schema = sdk::generation_service_receipt_contract();
        plugin.capability.declaration.error_schema = sdk::generation_service_error_contract();
        plugin.capability.declaration.limits.max_output_bytes =
            sdk::MAX_GENERATION_SERVICE_RECEIPT_BYTES as u32;
        plugin
            .capability
            .declaration
            .permissions
            .push(sdk::PermissionRequest::ProjectService {
                contract: tool.binding.capability.declaration.contract.clone(),
            });
        runtime
            .register(Arc::new(Registered {
                plugin: Some(plugin.clone()),
            }))
            .unwrap();
        let mut envelope = InputEnvelope::new(
            store.metadata().unwrap().project_id(),
            "fixture",
            &plugin.capability.declaration.contract.id,
            &plugin.capability_version(),
            vec![InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: "generation-component".into(),
                    locale: None,
                },
                serde_json::to_value(&wrapper).unwrap(),
                vec![],
            )],
        )
        .unwrap();
        envelope.plugin = Some(plugin.clone());
        envelope.limits.max_result_bytes =
            64 * 1024 + 3 * sdk::MAX_GENERATION_SERVICE_RECEIPT_BYTES as u32;
        let outer = FixedInput::capture(envelope).unwrap();
        runtime
            .authorize_plugin(
                &mut store,
                ExecutionId::new(),
                &outer,
                plugin_now_ms().unwrap() + 60_000,
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
        let selected = &plugin.capability.provider;
        let channel = sdk::ProviderBinding {
            plugin: selected.plugin.clone(),
            component_id: selected.component_id.clone(),
            contribution_id: selected.contribution_id.clone(),
            package_digest: selected.package_digest.clone(),
            instance_id: "generator-channel".into(),
            activation_generation: 1,
        };
        let invocation = outer
            .plugin_request(dispatch.item_id, dispatch.dispatch_token, &channel)
            .unwrap();
        let declaration = &tool.binding.capability.declaration;
        let mut limits = declaration.limits.clone();
        limits.concurrency = 1;
        limits.timeout_ms -= 1;
        let service = sdk::ServiceBinding {
            handle_id: call.handle_id.clone(),
            provider_id: format!("prepared-tool.{}", tool.handle),
            contract: declaration.contract.clone(),
            input_schema: declaration.input_schema.clone(),
            output_schema: declaration.output_schema.clone(),
            error_schema: declaration.error_schema.clone(),
            effect: sdk::EffectKind::ReadOnly,
            project_id: invocation.context.project_id.clone(),
            scope_id: invocation.context.scope_id.clone(),
            activation_generation: authorization.lease.generation.get() as u32,
            configuration_digest: prepared.input.digest().into(),
            limits,
        };
        let cancellation = Cancellation::default();
        let settings = Cancellation::default();
        let origin = store
            .capture_work_plan_tool_service_origin(
                &scope,
                &dispatch,
                &invocation,
                &service,
                dispatch.deadline().unwrap(),
                &cancellation,
                &settings,
            )
            .unwrap();
        // Park the model root so a runtime tick only starts the query worker.
        for item in &root.envelope().items {
            store
                .dispatch_execution_item(root.envelope().attempt_id, item.item_id)
                .unwrap();
        }
        Self {
            _directory: directory,
            store,
            runtime,
            origin,
            prepared,
            consent,
            call,
            dispatch,
            cancellation,
            settings,
            grant: ExecutionId::new(),
        }
    }
    fn prepare(&self) -> PreparedWorkPlanServiceTool {
        self.store
            .prepare_work_plan_service_tool(&self.origin, &self.call, &self.prepared)
            .unwrap()
    }
    fn submit(&mut self) -> (PreparedWorkPlanServiceTool, WorkPlanToolServiceReceipt) {
        let prepared = self.prepare();
        let receipt = self
            .runtime
            .submit_work_plan_service_tool(&mut self.store, &prepared, &self.consent, self.grant)
            .unwrap();
        (prepared, receipt)
    }
    fn counts(&self) -> (i64, i64, i64) {
        self.store.connection().unwrap().query_row(
            "SELECT (SELECT COUNT(*) FROM plugin_execution_grants),(SELECT COUNT(*) FROM execution_attempts),(SELECT COUNT(*) FROM application_service_calls)",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap()
    }
}

#[test]
fn tool_service_uses_original_tool_delegation_and_independent_grant_atomically() {
    let mut f = ToolFixture::new();
    let before = f.counts();
    assert_eq!(
        f.origin.record.invocation.max_result_bytes,
        32 * 1024 + 2 * sdk::MAX_GENERATION_SERVICE_RECEIPT_BYTES as u32
    );
    let prepared = f.prepare();
    f.store
        .check_prepared_work_plan_service_tool(&prepared)
        .unwrap();
    assert_eq!(f.counts(), before);
    let (_, receipt) = f.submit();
    assert_eq!(receipt.grant_id, f.grant);
    assert_eq!(receipt.origin_grant_id, f.origin.record.grant_id);
    assert_ne!(receipt.origin_grant_id, receipt.grant_id);
    assert_eq!(f.counts(), (before.0 + 1, before.1 + 1, before.2 + 1));
    assert_eq!(receipt.input_digest, f.prepared.input.digest());
    assert_eq!(
        f.store
            .work_plan_tool_invocations(f.origin.scope.lease.plan_id)
            .unwrap(),
        1
    );
    assert!(
        f.store
            .work_plan_service_receipt(&receipt.identity, &f.call)
            .is_err()
    );
    let dispatch = f
        .store
        .dispatch_execution_item(
            receipt.attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap();
    assert_eq!(
        dispatch.plugin_permit().unwrap().grant_id(),
        receipt.grant_id
    );
    assert!(dispatch.plugin_permit().unwrap().is_work_plan_tool());
    dispatch.check_service_dispatch().unwrap();
    assert_eq!(
        dispatch.originating_service_package().unwrap().0,
        &f.origin.record.invocation.provider.plugin
    );
    let after = f.counts();
    assert_eq!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &f.consent, f.grant)
            .unwrap(),
        receipt
    );
    assert_eq!(f.counts(), after);
    assert_eq!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &f.consent, ExecutionId::new())
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
}

#[test]
fn tool_service_does_not_borrow_caller_grant_or_replace_original_consent() {
    let mut f = ToolFixture::new();
    let before = f.counts();
    let prepared = f.prepare();
    assert!(f.runtime.submit(&mut f.store, prepared.input()).is_err());
    assert!(
        f.runtime
            .authorize_plugin(
                &mut f.store,
                f.grant,
                prepared.input(),
                plugin_now_ms().unwrap() + 10_000,
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                }
            )
            .is_err()
    );
    let mut absent = f.consent.clone();
    absent.runtime_generation = ExecutionId::new();
    assert!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &absent, f.grant)
            .is_err()
    );
    let mut expired = f.consent.clone();
    expired.deadline = Instant::now() - Duration::from_millis(1);
    assert!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &expired, f.grant)
            .is_err()
    );
    assert_eq!(f.counts(), before);
    f.store.connection().unwrap().execute_batch("CREATE TEMP TRIGGER reject_tool_service BEFORE INSERT ON application_service_calls BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &f.consent, f.grant)
            .is_err()
    );
    assert_eq!(f.counts(), before);
    assert!(f.store.check_plugin_input(prepared.input()).is_err());
}

#[test]
fn tool_service_rejects_changed_call_provider_scope_schema_and_unprepared_input() {
    let f = ToolFixture::new();
    let before = f.counts();
    for variant in 0..13 {
        let mut origin = f.origin.clone();
        let mut call = f.call.clone();
        let mut prepared = f.prepared.clone();
        match variant {
            0 => {
                call.input = sdk::EncodedPayload::capture(
                    call.input.schema.clone(),
                    "{\"query\":\"forged\"}".into(),
                )
                .unwrap()
            }
            1 => call.call_id = ExecutionId::new().to_string(),
            2 => origin.record.service.output_schema = contract("example.forged-output"),
            3 => origin.record.service.effect = sdk::EffectKind::External,
            4 => prepared.tool.handle = ExecutionId::new(),
            5 => prepared.scope.caller_id = ExecutionId::new(),
            6 => origin.record.service.configuration_digest = "e".repeat(64),
            7 => origin.record.service.provider_id = "unselected-provider".into(),
            8 => {
                let mut input = prepared.input.envelope().clone();
                input
                    .plugin
                    .as_mut()
                    .unwrap()
                    .capability
                    .provider
                    .package_digest = "c".repeat(64);
                prepared.input = FixedInput::capture(input).unwrap();
                origin.record.service.configuration_digest = prepared.input.digest().into();
            }
            9 => prepared.request.unit_ids.push(prepared.request.unit_ids[0]),
            10 => {
                let mut wrapper = sdk::parse_generation_component_input(
                    origin.record.invocation.input.utf8.as_bytes(),
                )
                .unwrap();
                wrapper.generation.unit_ids = vec![ExecutionId::new().to_string()];
                origin.record.invocation.input = sdk::EncodedPayload::capture(
                    sdk::generation_component_input_contract(),
                    serde_json::to_string(&wrapper).unwrap(),
                )
                .unwrap();
            }
            11 => {
                origin.record.service.limits.timeout_ms = prepared
                    .tool
                    .binding
                    .capability
                    .declaration
                    .limits
                    .timeout_ms
                    + 1
            }
            _ => origin.record.service.limits.max_output_bytes += 1,
        }
        assert!(
            f.store
                .prepare_work_plan_service_tool(&origin, &call, &prepared)
                .is_err(),
            "variant {variant}"
        );
    }
    assert_eq!(f.counts(), before);
    assert!(
        f.store
            .prepare_work_plan_service_generation(&f.origin, &f.call)
            .is_err()
    );
}

#[test]
fn tool_service_caller_revocation_cancellation_and_deadline_cannot_enqueue_or_dispatch() {
    for variant in 0..4 {
        let mut f = ToolFixture::new();
        let prepared = f.prepare();
        match variant {
            0 => f.cancellation.request(),
            1 => f.settings.request(),
            2 => {
                f.runtime
                    .revoke_plugin(&mut f.store, f.origin.record.grant_id)
                    .unwrap();
            }
            _ => {
                f.origin.guard.revoked.request();
            }
        }
        let before = f.counts();
        assert!(
            f.runtime
                .submit_work_plan_service_tool(&mut f.store, &prepared, &f.consent, f.grant)
                .is_err()
        );
        assert_eq!(f.counts(), before);
    }
    let mut f = ToolFixture::new();
    let deadline = Instant::now() + Duration::from_millis(10);
    f.origin = f
        .store
        .capture_work_plan_tool_service_origin(
            &f.origin.scope,
            &f.dispatch,
            &f.origin.record.invocation,
            &f.origin.record.service,
            deadline,
            &f.cancellation,
            &f.settings,
        )
        .unwrap();
    let prepared = f.prepare();
    std::thread::sleep(Duration::from_millis(20));
    assert!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &f.consent, f.grant)
            .is_err()
    );
    for revoke_caller in [false, true] {
        let mut f = ToolFixture::new();
        let (prepared, receipt) = f.submit();
        f.runtime
            .revoke_plugin(
                &mut f.store,
                if revoke_caller {
                    receipt.origin_grant_id
                } else {
                    receipt.grant_id
                },
            )
            .unwrap();
        assert!(
            f.store
                .dispatch_execution_item(
                    receipt.attempt_id,
                    prepared.input().envelope().items[0].item_id
                )
                .is_err()
        );
        assert_eq!(
            f.store
                .work_plan_tool_service_receipt(&receipt.identity, &f.call)
                .unwrap(),
            Some(receipt)
        );
    }
}

#[test]
fn tool_service_receipt_survives_reopen_without_live_origin_or_grant() {
    let mut f = ToolFixture::new();
    let (prepared, receipt) = f.submit();
    let before = f.counts();
    f.cancellation.request();
    let mut changed = f.call.clone();
    changed.input.utf8 = "{}".into();
    assert_eq!(
        f.store
            .work_plan_tool_service_receipt(&receipt.identity, &changed)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    assert_eq!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &f.consent, f.grant)
            .unwrap(),
        receipt
    );
    let path = f.store.directory().to_path_buf();
    drop(f.runtime);
    f.store.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    let mut runtime = ExecutionRuntime::new(&reopened).unwrap();
    assert_eq!(
        reopened
            .work_plan_tool_service_receipt(&receipt.identity, &f.call)
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        runtime
            .submit_work_plan_service_tool(&mut reopened, &prepared, &f.consent, f.grant)
            .unwrap(),
        receipt
    );
    assert!(reopened.check_plugin_input(prepared.input()).is_err());
    assert!(
        reopened
            .work_plan_service_query_origin(prepared.input())
            .is_err()
    );
    assert!(
        reopened
            .dispatch_execution_item(
                receipt.attempt_id,
                prepared.input().envelope().items[0].item_id
            )
            .is_err()
    );
    let counts: (i64, i64, i64) = reopened.connection().unwrap().query_row(
        "SELECT (SELECT COUNT(*) FROM plugin_execution_grants),(SELECT COUNT(*) FROM execution_attempts),(SELECT COUNT(*) FROM application_service_calls)",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(counts, before);
}

struct ControlledQuery {
    binding: PluginExecutionBinding,
    started: mpsc::Sender<DispatchRequest>,
    release: Cancellation,
    succeed: bool,
}
impl Runner for ControlledQuery {
    fn capability_id(&self) -> &str {
        &self.binding.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.binding.environment)
    }
    fn run(
        &self,
        request: DispatchRequest,
        _: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        self.started.send(request.clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.release.is_requested() {
            assert!(
                Instant::now() < deadline,
                "controlled query release deadline"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        if !self.succeed {
            return Err(fail(ErrorCode::Cancelled, "synthetic-query-cancelled"));
        }
        let selected = &self.binding.capability.provider;
        let channel = sdk::ProviderBinding {
            plugin: selected.plugin.clone(),
            component_id: selected.component_id.clone(),
            contribution_id: selected.contribution_id.clone(),
            package_digest: selected.package_digest.clone(),
            instance_id: "query-channel".into(),
            activation_generation: 1,
        };
        let invocation = request
            .input
            .plugin_request(request.item_id, request.dispatch_token, &channel)
            .unwrap();
        results.send(
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
                        result_id: "original-query-result".into(),
                        outcome: sdk::InvocationOutcome::Succeeded {
                            output: sdk::EncodedPayload::capture(
                                invocation.output_schema,
                                "{\"matches\":[]}".into(),
                            )
                            .unwrap(),
                        },
                    },
                },
            )
            .unwrap(),
        )
    }
}

fn finish_query(f: &mut ToolFixture, attempt: ExecutionId, release: &Cancellation) {
    release.request();
    let deadline = Instant::now() + Duration::from_secs(3);
    while f.runtime.has_owned_attempt_work(attempt) {
        assert!(
            Instant::now() < deadline,
            "query producer drainage deadline"
        );
        f.runtime.tick(&mut f.store).unwrap();
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn tool_service_success_keeps_query_output_separate_and_releases_only_after_terminal() {
    let (started, observed) = mpsc::channel();
    let release = Cancellation::default();
    let mut f = ToolFixture::with_runner(|tool| {
        Arc::new(ControlledQuery {
            binding: tool.execution.clone(),
            started,
            release: release.clone(),
            succeed: true,
        })
    });
    let (prepared, receipt) = f.submit();
    f.runtime.tick(&mut f.store).unwrap();
    let dispatch = observed.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(f.runtime.has_owned_attempt_work(receipt.attempt_id));
    assert!(
        f.store
            .plugin_authority
            .retained_service_origin(receipt.attempt_id)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        f.store
            .release_work_plan_service_origin(receipt.attempt_id)
            .unwrap_err()
            .stage,
        "service-tool-lifecycle"
    );
    finish_query(&mut f, receipt.attempt_id, &release);
    assert!(
        f.store
            .plugin_authority
            .retained_service_origin(receipt.attempt_id)
            .unwrap()
            .is_none()
    );
    assert!(!dispatch.plugin_permit().unwrap().is_authorized());
    let result_id = f
        .store
        .execution_current_result(receipt.attempt_id, dispatch.item_id)
        .unwrap()
        .unwrap();
    let result = f
        .store
        .execution_result(receipt.attempt_id, result_id)
        .unwrap();
    assert_eq!(result.envelope().output, Some(json!({"matches":[]})));
    assert_eq!(
        result.envelope().plugin.as_ref().unwrap().authorization_id,
        receipt.grant_id
    );
    assert_ne!(
        result.envelope().plugin.as_ref().unwrap().authorization_id,
        receipt.origin_grant_id
    );
    assert_eq!(
        f.runtime
            .submit_work_plan_service_tool(&mut f.store, &prepared, &f.consent, f.grant)
            .unwrap(),
        receipt
    );
}

#[test]
fn tool_service_package_stop_tracks_both_packages_until_the_original_query_producer_ends() {
    for caller in [false, true] {
        let (started, observed) = mpsc::channel();
        let release = Cancellation::default();
        let mut f = ToolFixture::with_runner(|tool| {
            Arc::new(ControlledQuery {
                binding: tool.execution.clone(),
                started,
                release: release.clone(),
                succeed: false,
            })
        });
        let (_, receipt) = f.submit();
        f.runtime.tick(&mut f.store).unwrap();
        let dispatch = observed.recv_timeout(Duration::from_secs(1)).unwrap();
        let provider = if caller {
            f.origin.record.invocation.provider.selection()
        } else {
            f.prepared.tool.execution.capability.provider.clone()
        };
        let stop = f
            .runtime
            .begin_package_quiesce(
                &mut f.store,
                ExecutionId::new(),
                &provider.plugin,
                &provider.package_digest,
            )
            .unwrap();
        assert_eq!(
            f.runtime
                .finish_package_quiesce(&mut f.store, &stop)
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        assert!(f.runtime.has_owned_attempt_work(receipt.attempt_id));
        assert!(
            f.store
                .plugin_authority
                .retained_service_origin(receipt.attempt_id)
                .unwrap()
                .is_some()
        );
        if caller {
            assert!(dispatch.check_service_dispatch().is_err());
        } else {
            assert!(!dispatch.plugin_permit().unwrap().is_authorized());
        }
        finish_query(&mut f, receipt.attempt_id, &release);
        f.runtime
            .finish_package_quiesce(&mut f.store, &stop)
            .unwrap();
        assert!(
            f.store
                .plugin_authority
                .retained_service_origin(receipt.attempt_id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            f.store
                .work_plan_tool_service_receipt(&receipt.identity, &f.call)
                .unwrap(),
            Some(receipt)
        );
    }
}
