#![cfg(unix)]
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk::*;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn binding(provider: &str, handle: &str) -> ServiceBinding {
    ServiceBinding {
        handle_id: handle.into(),
        provider_id: provider.into(),
        contract: contract("example.service"),
        input_schema: contract("example.service-input"),
        output_schema: contract("example.service-output"),
        error_schema: contract("example.service-error"),
        effect: EffectKind::ReadOnly,
        project_id: "project-a".into(),
        scope_id: "scope-a".into(),
        activation_generation: 3,
        configuration_digest: payload_digest("service configuration"),
        limits: CapabilityLimits {
            max_input_bytes: 1024,
            max_output_bytes: 1024,
            concurrency: 1,
            timeout_ms: 1000,
        },
    }
}
fn image(
    mode: &str,
    required: bool,
    selection: ProviderSelection,
    permission: bool,
    effect: EffectKind,
) -> PackageImage {
    image_with_observer(mode, required, selection, permission, effect, None)
}
fn image_with_observer(
    mode: &str,
    required: bool,
    selection: ProviderSelection,
    permission: bool,
    effect: EffectKind,
    observer: Option<&std::path::Path>,
) -> PackageImage {
    scoped_image(
        mode,
        required,
        selection,
        permission,
        effect,
        observer,
        ComponentScope::Project,
    )
}
fn scoped_image(
    mode: &str,
    required: bool,
    selection: ProviderSelection,
    permission: bool,
    effect: EffectKind,
    observer: Option<&std::path::Path>,
    scope: ComponentScope,
) -> PackageImage {
    let mut permissions = vec![PermissionRequest::CapturedInput];
    if permission {
        permissions.push(PermissionRequest::ProjectService {
            contract: contract("example.service"),
        });
    }
    let manifest = PluginManifest {
        protocol_version: MANIFEST_PROTOCOL,
        plugin: PluginIdentity {
            publisher: "example".into(),
            id: "example.service-client".into(),
            version: "0.1.0".into(),
        },
        permissions: permissions.clone(),
        components: vec![ComponentDeclaration {
            id: "client".into(),
            scope,
            runtime: RuntimeKind::JavaScript,
            entrypoint: Some("component.mjs".into()),
            dependencies: vec![CapabilityDependency {
                contract: contract("example.service"),
                required,
                selection,
            }],
            exit: ExitRequirements {
                stop_timeout_ms: 300,
                cleanup_timeout_ms: 500,
            },
        }],
        contributions: vec![ContributionDeclaration {
            id: "client.call".into(),
            component_id: "client".into(),
            contribution: ContributionKind::Capability {
                declaration: CapabilityDeclaration {
                    contract: contract("example.client"),
                    input_schema: contract("example.client-input"),
                    output_schema: contract("example.client-output"),
                    error_schema: contract("example.client-error"),
                    profiles: vec![],
                    effect,
                    permissions,
                    limits: CapabilityLimits {
                        max_input_bytes: 1024,
                        max_output_bytes: 65536,
                        concurrency: 1,
                        timeout_ms: if mode == "calls-limit" { 10000 } else { 1000 },
                    },
                },
            },
        }],
    };
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let mut files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: include_bytes!("support/service-component.mjs").to_vec(),
                executable: false,
            },
        ),
        (
            "behavior.txt".into(),
            PackageFile {
                bytes: mode.as_bytes().to_vec(),
                executable: false,
            },
        ),
    ]);
    if let Some(observer) = observer {
        files.insert(
            "observer.txt".into(),
            PackageFile {
                bytes: observer.as_os_str().as_encoded_bytes().to_vec(),
                executable: false,
            },
        );
    }
    let expected = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &expected).unwrap()
}
fn options() -> LaunchOptions {
    LaunchOptions {
        scope: tsumugi_plugin_host::SessionScope::Bound(ScopeBinding {
            project_id: "project-a".into(),
            scope_id: "scope-a".into(),
        }),
        allow_unsandboxed_execution: true,
        limits: HostLimits {
            handshake_timeout_ms: 2000,
            invocation_timeout_ms: 1000,
            stop_timeout_ms: 300,
            cleanup_timeout_ms: 500,
            ..Default::default()
        },
    }
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
struct Broker {
    bindings: Vec<ServiceBinding>,
    current: AtomicBool,
    delay_ms: u64,
    response_mode: &'static str,
    seen: Mutex<Vec<(ServiceCaller, ServiceRequest)>>,
    entered: tokio::sync::Notify,
    released: AtomicUsize,
}
impl Broker {
    fn new(bindings: Vec<ServiceBinding>, delay_ms: u64, response_mode: &'static str) -> Arc<Self> {
        Arc::new(Self {
            bindings,
            current: AtomicBool::new(true),
            delay_ms,
            response_mode,
            seen: Mutex::new(vec![]),
            entered: tokio::sync::Notify::new(),
            released: AtomicUsize::new(0),
        })
    }
}
impl ProjectServiceBroker for Broker {
    fn bindings(&self) -> &[ServiceBinding] {
        &self.bindings
    }
    fn is_current(&self, binding: &ServiceBinding) -> bool {
        self.current.load(Ordering::Acquire) && self.bindings.contains(binding)
    }
    fn call<'a>(
        &'a self,
        caller: ServiceCaller,
        binding: ServiceBinding,
        request: ServiceRequest,
    ) -> ProjectServiceFuture<'a> {
        self.seen.lock().unwrap().push((caller, request.clone()));
        self.entered.notify_one();
        Box::pin(async move {
            if self.delay_ms != 0 {
                tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            }
            let schema = if matches!(self.response_mode, "failed" | "unknown") {
                binding.error_schema
            } else {
                binding.output_schema
            };
            let text = if self.response_mode == "frame-limit" {
                "x".repeat(4000)
            } else if self.response_mode == "total-limit" {
                "x".repeat(2000)
            } else if self.response_mode == "oversize" {
                "x".repeat(binding.limits.max_output_bytes as usize + 1)
            } else {
                format!("{}:{}", binding.provider_id, request.input.utf8)
            };
            let payload = EncodedPayload::capture(schema, text).unwrap();
            let outcome = match self.response_mode {
                "failed" => InvocationOutcome::Failed { error: payload },
                "unknown" => InvocationOutcome::Unknown { error: payload },
                _ => InvocationOutcome::Succeeded { output: payload },
            };
            let mut response = ServiceResponse {
                call_id: request.call_id,
                handle_id: request.handle_id,
                context: request.context,
                outcome,
            };
            match self.response_mode {
                "forged-call" => response.call_id = "forged-call".into(),
                "forged-handle" => response.handle_id = "forged-handle".into(),
                "forged-context" => {
                    response.context.input_digest = payload_digest("forged original input")
                }
                "forged-schema" => {
                    if let InvocationOutcome::Succeeded { output } = &mut response.outcome {
                        output.schema.behavior_version = 2;
                    }
                }
                _ => {}
            }
            Ok(response)
        })
    }
    fn release_channel(&self, _channel: &ChannelReceipt) {
        self.released.fetch_add(1, Ordering::AcqRel);
    }
}

#[test]
fn attempt_channels_do_not_borrow_even_a_matching_optional_project_service() {
    runtime().block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let image = scoped_image(
            "normal",
            false,
            ProviderSelection::Single,
            true,
            EffectKind::ReadOnly,
            None,
            ComponentScope::Attempt,
        );
        let mut offered = binding("provider-a", "handle-a");
        offered.scope_id = "attempt-a".into();
        let broker = Broker::new(vec![offered], 0, "normal");
        let mut configured = options();
        let SessionScope::Bound(scope) = &mut configured.scope else {
            panic!("expected project/attempt scope")
        };
        scope.scope_id = "attempt-a".into();
        let result = ProcessSession::launch_with_services(
            &image,
            "client.call",
            directory.path(),
            &RuntimeLauncher::Native,
            configured,
            broker.clone(),
            || true,
        )
        .await;
        assert!(matches!(result, Err(HostError::DependencyUnavailable)));
        assert!(broker.seen.lock().unwrap().is_empty());
        assert_eq!(broker.released.load(Ordering::Acquire), 0);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    });
}

#[test]
fn dependency_resolution_rejects_missing_extra_scope_permission_version_and_effect_before_staging()
{
    runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let required = image(
            "normal",
            true,
            ProviderSelection::Single,
            true,
            EffectKind::ReadOnly,
        );
        let error = ProcessSession::launch(
            &required,
            "client.call",
            dir.path(),
            &RuntimeLauncher::Native,
            options(),
            || true,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error, HostError::DependencyUnavailable);
        let mut cases = vec![];
        for mutation in ["project", "scope", "version", "extra", "effect"] {
            let mut service = binding("provider-a", "handle-a");
            match mutation {
                "project" => service.project_id = "other-project".into(),
                "scope" => service.scope_id = "other-scope".into(),
                "version" => service.contract.behavior_version = 2,
                "extra" => service.contract = contract("example.undeclared"),
                "effect" => service.effect = EffectKind::Proposal,
                _ => unreachable!(),
            }
            cases.push((
                required.clone(),
                vec![service],
                HostError::DependencyUnavailable,
            ));
        }
        cases.push((
            image(
                "normal",
                true,
                ProviderSelection::Single,
                false,
                EffectKind::ReadOnly,
            ),
            vec![binding("provider-a", "handle-a")],
            HostError::DependencyUnavailable,
        ));
        cases.push((
            required.clone(),
            vec![
                binding("provider-a", "handle-a"),
                binding("provider-b", "handle-b"),
            ],
            HostError::DependencyUnavailable,
        ));
        cases.push((
            required.clone(),
            vec![binding("provider-a", "same"), binding("provider-b", "same")],
            HostError::InvalidContract,
        ));
        cases.push((
            required.clone(),
            vec![
                binding("provider-a", "handle-a"),
                binding("provider-a", "handle-b"),
            ],
            HostError::InvalidContract,
        ));
        let mut concurrent = binding("provider-a", "handle-a");
        concurrent.limits.concurrency = 2;
        cases.push((
            required.clone(),
            vec![concurrent],
            HostError::InvalidContract,
        ));
        cases.push((
            required.clone(),
            (0..=MAX_SERVICE_BINDINGS)
                .map(|index| binding(&format!("provider-{index}"), &format!("handle-{index}")))
                .collect(),
            HostError::InvalidContract,
        ));
        let mut external = binding("provider-a", "handle-a");
        external.effect = EffectKind::External;
        cases.push((
            image(
                "normal",
                true,
                ProviderSelection::Single,
                true,
                EffectKind::Proposal,
            ),
            vec![external],
            HostError::DependencyUnavailable,
        ));
        for (image, bindings, expected) in cases {
            let broker = Broker::new(bindings, 0, "normal");
            let error = ProcessSession::launch_with_services(
                &image,
                "client.call",
                dir.path(),
                &RuntimeLauncher::Native,
                options(),
                broker.clone(),
                || true,
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error, expected);
            assert!(broker.seen.lock().unwrap().is_empty());
            assert_eq!(broker.released.load(Ordering::Acquire), 0);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
        let optional = image(
            "normal",
            false,
            ProviderSelection::Single,
            true,
            EffectKind::ReadOnly,
        );
        assert_eq!(
            ProcessSession::launch(
                &optional,
                "client.call",
                dir.path(),
                &RuntimeLauncher::Native,
                options(),
                || true
            )
            .await
            .err()
            .unwrap(),
            HostError::UnsupportedRuntime
        );
        let revoked = Broker::new(vec![binding("provider-a", "handle-a")], 0, "normal");
        revoked.current.store(false, Ordering::Release);
        assert_eq!(
            ProcessSession::launch_with_services(
                &required,
                "client.call",
                dir.path(),
                &RuntimeLauncher::Native,
                options(),
                revoked,
                || true
            )
            .await
            .err()
            .unwrap(),
            HostError::AuthorityRevoked
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    });
}

#[cfg(all(unix, feature = "javascript-conformance"))]
#[path = "support/runtime.rs"]
mod runtime_fixture;

#[cfg(all(unix, feature = "javascript-conformance"))]
mod javascript {
    use super::*;
    fn launcher() -> RuntimeLauncher {
        RuntimeLauncher::JavaScript {
            runtime: runtime_fixture::approved_runtime(),
        }
    }
    fn request(session: &ProcessSession, dispatch: &str) -> InvocationRequest {
        let input =
            EncodedPayload::capture(contract("example.client-input"), "original:你好 👩🏽‍💻".into())
                .unwrap();
        InvocationRequest {
            context: InvocationContext {
                project_id: "project-a".into(),
                scope_id: "scope-a".into(),
                operation_id: "operation-a".into(),
                attempt_id: "attempt-a".into(),
                item_id: "item-a".into(),
                dispatch_id: dispatch.into(),
                input_digest: input.sha256.clone(),
                scope_digest: payload_digest("scope"),
                environment_digest: session.environment_digest().unwrap().into(),
                configuration_digest: payload_digest("configuration"),
            },
            provider: session.channel().provider("client.call").unwrap(),
            capability: contract("example.client"),
            profile: None,
            input,
            output_schema: contract("example.client-output"),
            error_schema: contract("example.client-error"),
            max_result_bytes: 65536,
        }
    }
    async fn launch(
        mode: &str,
        parent: &std::path::Path,
        broker: Arc<Broker>,
        selection: ProviderSelection,
        options: LaunchOptions,
    ) -> ProcessSession {
        ProcessSession::launch_with_services(
            &image(mode, true, selection, true, EffectKind::ReadOnly),
            "client.call",
            parent,
            &launcher(),
            options,
            broker,
            || true,
        )
        .await
        .unwrap()
    }
    #[test]
    fn attempt_generation_service_transport_refuses_foreign_scopes_before_staging() {
        runtime().block_on(async {
            let base = scoped_image(
                "normal",
                true,
                ProviderSelection::Single,
                true,
                EffectKind::External,
                None,
                ComponentScope::Attempt,
            );
            let mut manifest = base.manifest().manifest().clone();
            manifest.permissions[1] = PermissionRequest::ProjectService {
                contract: generation_service_contract(),
            };
            manifest.components[0].dependencies[0].contract = generation_service_contract();
            let ContributionKind::Capability { declaration } =
                &mut manifest.contributions[0].contribution
            else {
                unreachable!()
            };
            declaration.permissions = manifest.permissions.clone();
            declaration.input_schema = generation_service_input_contract();
            declaration.output_schema = generation_service_receipt_contract();
            declaration.error_schema = generation_service_error_contract();
            let files = BTreeMap::from([
                (
                    "component.mjs".into(),
                    PackageFile {
                        bytes: include_bytes!("support/service-component.mjs").to_vec(),
                        executable: false,
                    },
                ),
                (
                    "behavior.txt".into(),
                    PackageFile {
                        bytes: b"normal".to_vec(),
                        executable: false,
                    },
                ),
            ]);
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let digest = PackageImage::digest(&bytes, &files).unwrap();
            let image = PackageImage::capture(bytes, files, &digest).unwrap();
            let mut service = binding("tsumugi.core", "generation");
            service.scope_id = "attempt-a".into();
            service.contract = generation_service_contract();
            service.input_schema = generation_service_input_contract();
            service.output_schema = generation_service_receipt_contract();
            service.error_schema = generation_service_error_contract();
            service.effect = EffectKind::External;
            let mut configured = options();
            let SessionScope::Bound(scope) = &mut configured.scope else {
                panic!("expected project/attempt scope")
            };
            scope.scope_id = "attempt-a".into();
            for mutation in [
                "missing",
                "project-scope",
                "other-attempt",
                "other-project",
                "other-contract",
            ] {
                let dir = tempfile::tempdir().unwrap();
                let mut selected = service.clone();
                match mutation {
                    "project-scope" => selected.scope_id = "project-a".into(),
                    "other-attempt" => selected.scope_id = "attempt-b".into(),
                    "other-project" => selected.project_id = "project-b".into(),
                    "other-contract" => selected.contract = contract("example.service"),
                    _ => {}
                }
                let broker = Broker::new(
                    if mutation == "missing" {
                        vec![]
                    } else {
                        vec![selected]
                    },
                    0,
                    "normal",
                );
                let error = ProcessSession::launch_with_services(
                    &image,
                    "client.call",
                    dir.path(),
                    &launcher(),
                    configured.clone(),
                    broker.clone(),
                    || true,
                )
                .await
                .err()
                .unwrap();
                assert_eq!(error, HostError::DependencyUnavailable, "{mutation}");
                assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
                assert!(broker.seen.lock().unwrap().is_empty());
            }
            let dir = tempfile::tempdir().unwrap();
            let broker = Broker::new(vec![service], 0, "normal");
            let mut session = ProcessSession::launch_with_services(
                &image,
                "client.call",
                dir.path(),
                &launcher(),
                configured,
                broker.clone(),
                || true,
            )
            .await
            .unwrap();
            let mut invocation = request(&session, "dispatch-a");
            invocation.context.scope_id = "attempt-a".into();
            invocation.input.schema = generation_service_input_contract();
            invocation.output_schema = generation_service_receipt_contract();
            invocation.error_schema = generation_service_error_contract();
            let result = session
                .invoke(&invocation, || false, || true)
                .await
                .unwrap();
            assert_eq!(result.result().context.scope_id, "attempt-a");
            let seen = broker.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(
                seen[0].0.channel().provider,
                session.channel().provider("client.call").unwrap()
            );
            assert_eq!(seen[0].0.channel().scope, session.channel().scope);
            assert_eq!(seen[0].0.context(), &invocation.context);
            drop(seen);
            session.close().await;
            assert_eq!(broker.released.load(Ordering::Acquire), 1);
        });
    }

    fn assert_terminated(session: &ProcessSession, broker: &Broker) {
        assert!(!session.is_accepting());
        assert!(session.termination_receipt().unwrap().direct_child_reaped);
        assert_eq!(broker.released.load(Ordering::Acquire), 1);
    }

    #[test]
    fn actual_js_service_transport_retains_original_identity_and_independent_provider_results() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            for outcome in ["normal", "failed", "unknown"] {
                let broker = Broker::new(
                    vec![
                        binding("provider-b", "handle-b"),
                        binding("provider-a", "handle-a"),
                    ],
                    0,
                    outcome,
                );
                let mut session = launch(
                    "normal",
                    dir.path(),
                    broker.clone(),
                    ProviderSelection::CollectIndependent,
                    options(),
                )
                .await;
                let invocation = request(&session, "dispatch-a");
                let started = std::time::Instant::now();
                let received = session
                    .invoke(&invocation, || false, || true)
                    .await
                    .unwrap();
                let returned = std::time::Instant::now();
                assert_eq!(received.channel().provider, invocation.provider);
                let InvocationOutcome::Succeeded { output } = &received.result().outcome else {
                    panic!("outer invocation failed")
                };
                assert_eq!(
                    output.utf8,
                    "provider-a:service:你好 👩🏽‍💻|provider-b:service:你好 👩🏽‍💻:original:你好 👩🏽‍💻"
                );
                let seen = broker.seen.lock().unwrap();
                assert_eq!(seen.len(), 2);
                assert_eq!(seen[0].0.deadline(), seen[1].0.deadline());
                for (caller, call) in seen.iter() {
                    assert!(caller.deadline() > started);
                    assert!(caller.deadline() <= returned + Duration::from_millis(1000));
                    assert_eq!(caller.invocation(), &invocation);
                    assert_eq!(caller.context(), &invocation.context);
                    assert_eq!(caller.channel().provider, invocation.provider);
                    assert_eq!(caller.channel().child_pid, session.channel().child_pid);
                    assert_eq!(call.context, invocation.context);
                    assert_ne!(call.input.sha256, invocation.context.input_digest);
                }
                drop(seen);
                let closed = session.close().await;
                assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
                assert_eq!(broker.released.load(Ordering::Acquire), 1);
                drop(session);
                assert_eq!(broker.released.load(Ordering::Acquire), 1);
            }
            let mut optional = ProcessSession::launch(
                &image(
                    "optional-empty",
                    false,
                    ProviderSelection::Single,
                    true,
                    EffectKind::ReadOnly,
                ),
                "client.call",
                dir.path(),
                &launcher(),
                options(),
                || true,
            )
            .await
            .unwrap();
            let invocation = request(&optional, "optional-dispatch");
            let received = optional
                .invoke(&invocation, || false, || true)
                .await
                .unwrap();
            let InvocationOutcome::Succeeded { output } = &received.result().outcome else {
                panic!("optional integration failed")
            };
            assert_eq!(output.utf8, "optional-none:original:你好 👩🏽‍💻");
            assert!(optional.close().await.direct_child_reaped);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        });
    }

    #[test]
    fn actual_js_channel_rejects_service_spoofs_duplicates_and_wrong_direction() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            for (mode, expected, calls) in [
                ("raw-project", HostError::RequestMismatch, 0),
                ("raw-scope", HostError::RequestMismatch, 0),
                ("raw-dispatch", HostError::RequestMismatch, 0),
                ("raw-input-context", HostError::RequestMismatch, 0),
                ("raw-handle", HostError::RequestMismatch, 0),
                ("raw-schema", HostError::RequestMismatch, 0),
                ("raw-digest", HostError::InvalidFrame, 0),
                ("raw-input-limit", HostError::RequestMismatch, 0),
                ("raw-provider", HostError::InvalidFrame, 0),
                ("raw-direction", HostError::UnexpectedFrame, 0),
                ("raw-burst", HostError::UnexpectedFrame, 1),
                ("duplicate", HostError::RequestMismatch, 1),
            ] {
                let broker = Broker::new(vec![binding("provider-a", "handle-a")], 20, "normal");
                let mut session = launch(
                    mode,
                    dir.path(),
                    broker.clone(),
                    ProviderSelection::Single,
                    options(),
                )
                .await;
                let invocation = request(&session, "dispatch-a");
                assert_eq!(
                    session
                        .invoke(&invocation, || false, || true)
                        .await
                        .unwrap_err(),
                    expected,
                    "{mode}"
                );
                assert_eq!(broker.seen.lock().unwrap().len(), calls, "{mode}");
                assert_terminated(&session, &broker);
            }
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        });
    }

    #[test]
    fn actual_js_channel_rejects_forged_or_oversize_broker_responses() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            for mode in [
                "forged-call",
                "forged-handle",
                "forged-context",
                "forged-schema",
                "oversize",
            ] {
                let broker = Broker::new(vec![binding("provider-a", "handle-a")], 0, mode);
                let mut session = launch(
                    "normal",
                    dir.path(),
                    broker.clone(),
                    ProviderSelection::Single,
                    options(),
                )
                .await;
                let invocation = request(&session, "dispatch-a");
                assert_eq!(
                    session
                        .invoke(&invocation, || false, || true)
                        .await
                        .unwrap_err(),
                    HostError::ResultMismatch,
                    "{mode}"
                );
                assert_terminated(&session, &broker);
            }
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        });
    }

    #[test]
    fn service_responses_enforce_encoded_frame_and_aggregate_output_bounds() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            for (mode, component_mode, raw_limit, total_limit, expected_calls) in [
                ("frame-limit", "normal", 8000, 16384, 1),
                ("total-limit", "sequence", 2000, 8192, 3),
            ] {
                let mut selected = binding("provider-a", "handle-a");
                selected.limits.max_output_bytes = raw_limit;
                let broker = Broker::new(vec![selected], 0, mode);
                let mut constrained = options();
                constrained.limits.max_frame_bytes = 4096;
                constrained.limits.max_session_output_bytes = total_limit;
                let mut session = launch(
                    component_mode,
                    dir.path(),
                    broker.clone(),
                    ProviderSelection::Single,
                    constrained,
                )
                .await;
                let mut invocation = request(&session, "dispatch-a");
                invocation.max_result_bytes = 4096;
                assert_eq!(
                    session
                        .invoke(&invocation, || false, || true)
                        .await
                        .unwrap_err(),
                    HostError::OutputLimit
                );
                assert_eq!(broker.seen.lock().unwrap().len(), expected_calls);
                assert_terminated(&session, &broker);
            }
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        });
    }

    #[test]
    fn pending_service_callback_observes_cancellation_authority_and_binding_revocation() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            for mode in ["cancel", "authority", "binding"] {
                let broker = Broker::new(vec![binding("provider-a", "handle-a")], 500, "normal");
                let cancelled = Arc::new(AtomicBool::new(false));
                let authorized = Arc::new(AtomicBool::new(true));
                let mut session = launch(
                    "normal",
                    dir.path(),
                    broker.clone(),
                    ProviderSelection::Single,
                    options(),
                )
                .await;
                let revoke_broker = broker.clone();
                let revoke_cancelled = cancelled.clone();
                let revoke_authorized = authorized.clone();
                let revoke = tokio::spawn(async move {
                    revoke_broker.entered.notified().await;
                    match mode {
                        "cancel" => revoke_cancelled.store(true, Ordering::Release),
                        "authority" => revoke_authorized.store(false, Ordering::Release),
                        "binding" => revoke_broker.current.store(false, Ordering::Release),
                        _ => unreachable!(),
                    }
                });
                let invocation = request(&session, "dispatch-a");
                let started = tokio::time::Instant::now();
                let error = session
                    .invoke(
                        &invocation,
                        || cancelled.load(Ordering::Acquire),
                        || authorized.load(Ordering::Acquire),
                    )
                    .await
                    .unwrap_err();
                revoke.await.unwrap();
                assert_eq!(
                    error,
                    if mode == "cancel" {
                        HostError::Cancelled
                    } else {
                        HostError::AuthorityRevoked
                    }
                );
                assert!(started.elapsed() < Duration::from_millis(400));
                assert_terminated(&session, &broker);
            }
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        });
    }

    #[test]
    fn selected_service_lifetime_revokes_activation_idle_and_after_response_channels() {
        runtime().block_on(async {
            let staging = tempfile::tempdir().unwrap();
            let observation = tempfile::tempdir().unwrap();
            let broker = Broker::new(vec![binding("provider-a", "handle-a")], 0, "normal");
            let mut idle = launch(
                "normal",
                staging.path(),
                broker.clone(),
                ProviderSelection::Single,
                options(),
            )
            .await;
            broker.current.store(false, Ordering::Release);
            assert!(!idle.is_accepting());
            let invocation = request(&idle, "idle-dispatch");
            assert_eq!(
                idle.invoke(&invocation, || false, || true)
                    .await
                    .unwrap_err(),
                HostError::AuthorityRevoked
            );
            assert!(broker.seen.lock().unwrap().is_empty());
            assert_terminated(&idle, &broker);

            for (mode, marker) in [
                ("activation-pause", "activating"),
                ("after-service", "service-received"),
            ] {
                let broker = Broker::new(vec![binding("provider-a", "handle-a")], 0, "normal");
                let observer = observation.path().join(mode);
                let image = image_with_observer(
                    mode,
                    true,
                    ProviderSelection::Single,
                    true,
                    EffectKind::ReadOnly,
                    Some(&observer),
                );
                let revoke_broker = broker.clone();
                let revoke = tokio::spawn(async move {
                    tokio::time::timeout(Duration::from_secs(2), async {
                        loop {
                            if std::fs::read_to_string(&observer).ok().as_deref() == Some(marker) {
                                revoke_broker.current.store(false, Ordering::Release);
                                return;
                            }
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    })
                    .await
                    .unwrap();
                });
                let launched = ProcessSession::launch_with_services(
                    &image,
                    "client.call",
                    staging.path(),
                    &launcher(),
                    options(),
                    broker.clone(),
                    || true,
                )
                .await;
                if mode == "activation-pause" {
                    assert_eq!(launched.err().unwrap(), HostError::AuthorityRevoked);
                    assert!(broker.seen.lock().unwrap().is_empty());
                    assert_eq!(broker.released.load(Ordering::Acquire), 1);
                } else {
                    let mut session = launched.unwrap();
                    let invocation = request(&session, "after-service-dispatch");
                    assert_eq!(
                        session
                            .invoke(&invocation, || false, || true)
                            .await
                            .unwrap_err(),
                        HostError::AuthorityRevoked
                    );
                    assert_eq!(broker.seen.lock().unwrap().len(), 1);
                    assert_terminated(&session, &broker);
                }
                revoke.await.unwrap();
            }
            assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
        });
    }

    #[test]
    fn service_callbacks_share_outer_absolute_deadline_and_late_calls_revoke_channel() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let broker = Broker::new(vec![binding("provider-a", "handle-a")], 60, "normal");
            let mut limits = options();
            limits.limits.invocation_timeout_ms = 150;
            let mut session = launch(
                "sequence",
                dir.path(),
                broker.clone(),
                ProviderSelection::Single,
                limits,
            )
            .await;
            let invocation = request(&session, "dispatch-a");
            let started = tokio::time::Instant::now();
            assert_eq!(
                session
                    .invoke(&invocation, || false, || true)
                    .await
                    .unwrap_err(),
                HostError::Timeout
            );
            assert!(started.elapsed() < Duration::from_millis(350));
            assert!(broker.seen.lock().unwrap().len() >= 2);
            assert_terminated(&session, &broker);
            let broker = Broker::new(vec![binding("provider-a", "handle-a")], 0, "normal");
            let mut session = launch(
                "late",
                dir.path(),
                broker.clone(),
                ProviderSelection::Single,
                options(),
            )
            .await;
            session
                .invoke(&request(&session, "dispatch-first"), || false, || true)
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let next = request(&session, "dispatch-next");
            assert_eq!(
                session.invoke(&next, || false, || true).await.unwrap_err(),
                HostError::UnexpectedFrame
            );
            assert_terminated(&session, &broker);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        });
    }

    #[test]
    fn host_service_call_budget_rejects_the_129th_call_without_invoking_broker() {
        runtime().block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let broker = Broker::new(vec![binding("provider-a", "handle-a")], 0, "normal");
            let mut budget = options();
            budget.limits.invocation_timeout_ms = 10000;
            let mut session = launch(
                "calls-limit",
                dir.path(),
                broker.clone(),
                ProviderSelection::Single,
                budget,
            )
            .await;
            let invocation = request(&session, "dispatch-a");
            assert_eq!(
                session
                    .invoke(&invocation, || false, || true)
                    .await
                    .unwrap_err(),
                HostError::OutputLimit
            );
            assert_eq!(broker.seen.lock().unwrap().len(), MAX_SERVICE_CALLS);
            assert_terminated(&session, &broker);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        });
    }
}
