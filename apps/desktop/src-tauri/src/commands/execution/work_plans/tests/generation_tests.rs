use super::*;
use tsumugi_plugin_sdk as sdk;

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[path = "generation_controls.rs"]
mod controls;

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[path = "generation_partial.rs"]
mod partial;

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[path = "generation_checks.rs"]
mod checks;

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[path = "generation_settings_race.rs"]
mod settings_race;

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
struct ComponentAction {
    scope: Value,
    preparing: Value,
    generation: Value,
    outer: ExecutionId,
    preflight: Value,
    starting: Value,
}

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn start_component_for_units(
    fixture: &Fixture,
    component: Value,
    grant: &Value,
    units: &[ExecutionId],
) -> ComponentAction {
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let generation =
        json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":units});
    let outer = ExecutionId::new();
    let preparing = json!({"scopeId":scope["scopeId"],"attemptId":outer,"component":component,"generation":generation});
    let prepared = fixture
        .call("prepare_work_plan_generation_component", preparing.clone())
        .unwrap();
    let starting = json!({"scopeId":scope["scopeId"],"attemptId":outer,"inputDigest":prepared["inputDigest"],"grantId":ExecutionId::new(),
        "expiresAtMs":(SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()+60_000).to_string(),"unsandboxedExecution":true});
    assert_eq!(
        fixture
            .call("start_work_plan_generation_component", starting.clone())
            .unwrap(),
        json!(outer)
    );
    ComponentAction {
        scope,
        preparing,
        generation,
        outer,
        preflight: prepared,
        starting,
    }
}

type ServiceResponses = Arc<std::sync::Mutex<Vec<sdk::ServiceResponse>>>;
struct ObservedFactory {
    original: Arc<dyn tsumugi_plugin_host::core::ProjectServiceFactory>,
    responses: ServiceResponses,
}
struct ObservedBroker {
    original: Arc<dyn tsumugi_plugin_host::ProjectServiceBroker>,
    responses: ServiceResponses,
}
impl tsumugi_plugin_host::core::ProjectServiceFactory for ObservedFactory {
    fn capture(
        &self,
        request: DispatchRequest,
        permit: PluginPermit,
        cancellation: Cancellation,
    ) -> tsumugi_plugin_host::core::ProjectServiceSelectionFuture {
        let original = self.original.capture(request, permit, cancellation);
        let responses = self.responses.clone();
        Box::pin(async move {
            Ok(Arc::new(ObservedBroker {
                original: original.await?,
                responses,
            })
                as Arc<dyn tsumugi_plugin_host::ProjectServiceBroker>)
        })
    }
}
impl tsumugi_plugin_host::ProjectServiceBroker for ObservedBroker {
    fn bindings(&self) -> &[sdk::ServiceBinding] {
        self.original.bindings()
    }
    fn is_current(&self, binding: &sdk::ServiceBinding) -> bool {
        self.original.is_current(binding)
    }
    fn call<'a>(
        &'a self,
        caller: tsumugi_plugin_host::ServiceCaller,
        binding: sdk::ServiceBinding,
        request: sdk::ServiceRequest,
    ) -> tsumugi_plugin_host::ProjectServiceFuture<'a> {
        Box::pin(async move {
            let response = self.original.call(caller, binding, request).await?;
            self.responses.lock().unwrap().push(response.clone());
            Ok(response)
        })
    }
    fn release_channel(&self, channel: &tsumugi_plugin_host::ChannelReceipt) {
        self.original.release_channel(channel);
    }
}

fn generation_package() -> tsumugi_plugin_host::PackageImage {
    generation_package_observed(None)
}
fn generation_package_observed(
    observer: Option<&std::path::Path>,
) -> tsumugi_plugin_host::PackageImage {
    generation_package_with_timeout(observer, 10_000)
}

fn generation_package_with_timeout(
    observer: Option<&std::path::Path>,
    timeout_ms: u32,
) -> tsumugi_plugin_host::PackageImage {
    use tsumugi_plugin_host::{PackageFile, PackageImage};
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/pluginGenerationComponent.contract.json"
    ))
    .unwrap();
    let capability: sdk::CapabilityBinding =
        serde_json::from_value(fixture["view"]["binding"].clone()).unwrap();
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: capability.provider.plugin.clone(),
        permissions: capability.declaration.permissions.clone(),
        components: vec![sdk::ComponentDeclaration {
            id: capability.provider.component_id.clone(),
            scope: sdk::ComponentScope::Project,
            runtime: sdk::RuntimeKind::JavaScript,
            entrypoint: Some("component.mjs".into()),
            dependencies: vec![sdk::CapabilityDependency {
                contract: sdk::generation_service_contract(),
                required: true,
                selection: sdk::ProviderSelection::Single,
            }],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 300,
                cleanup_timeout_ms: 500,
            },
        }],
        contributions: vec![sdk::ContributionDeclaration {
            id: capability.provider.contribution_id,
            component_id: capability.provider.component_id,
            contribution: sdk::ContributionKind::Capability {
                declaration: sdk::CapabilityDeclaration {
                    limits: sdk::CapabilityLimits {
                        timeout_ms,
                        ..capability.declaration.limits
                    },
                    ..capability.declaration
                },
            },
        }],
    };
    let mut files = BTreeMap::from([("component.mjs".into(), PackageFile { executable: false, bytes: br#"
import {readFile, writeFile} from 'node:fs/promises';
let observer;
try { observer = await readFile(new URL('./observer.txt', import.meta.url), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const observe = async stage => { if (observer) await writeFile(observer, stage); };
export default { async activate(api) {
  if (api.services.length !== 1) throw new Error('Missing original generation service');
  api.register(async (input, metadata) => {
    await observe('calling');
    const response = await metadata.services.call(api.services[0].handleId, input.utf8, 'generation-call');
    const payload = response.outcome.kind === 'succeeded' ? response.outcome.output : response.outcome.error;
    await observe('returning-' + response.outcome.kind);
    return {kind: response.outcome.kind, utf8: payload.utf8};
  });
  api.onDispose(() => observe('disposed'));
} };
"#.to_vec() })]);
    if let Some(observer) = observer {
        files.insert(
            "observer.txt".into(),
            PackageFile {
                executable: false,
                bytes: observer.to_str().unwrap().as_bytes().to_vec(),
            },
        );
    }
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn install_generation(
    fixture: &Fixture,
) -> (
    Value,
    crate::commands::plugins::InstalledPluginFixture,
    tsumugi_plugin_host::RuntimeApproval,
) {
    use crate::commands::plugins::InstalledPluginFixture;
    use std::{fs, path::PathBuf};
    use tsumugi_plugin_host::{
        CapturedRuntime, RuntimeApproval,
        catalog::{PackageApproval, PackageOrigin},
    };
    let image = generation_package_observed(Some(
        &fixture.directory.path().join("component-observer.txt"),
    ));
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: image.package_digest().into(),
        origin: PackageOrigin {
            source_id: "synthetic-generation-source".into(),
            publisher_id: "synthetic-generation-publisher".into(),
        },
    };
    let descriptor: sdk::RuntimeEnvironmentDescriptor = serde_json::from_slice(
        &fs::read(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL")
                .expect("independent captured runtime required"),
        )
        .unwrap(),
    )
    .unwrap();
    let runtime = CapturedRuntime::capture_directories(
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL")
                .expect("explicit actual runtime tool required"),
        ),
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").expect("explicit actual Host required"),
        ),
        &descriptor,
        || true,
    )
    .unwrap();
    let runtime_approval = RuntimeApproval {
        environment: descriptor.into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let installed = InstalledPluginFixture::from_image(
        fixture.app.state::<AppState>().plugins.clone(),
        image.clone(),
        approval,
    );
    installed.install();
    installed.install_runtime(&runtime, &runtime_approval);
    installed.decide(true, vec![runtime_approval.clone()]);
    let binding = sdk::bind_capability(
        image.manifest(),
        &image.manifest().manifest().contributions[0].id,
        image.package_digest(),
    )
    .unwrap();
    (
        json!({"provider":binding.provider,"profile":binding.declaration.profiles.first(),"environmentDigest":runtime_approval.environment.digest().unwrap()}),
        installed,
        runtime_approval,
    )
}

#[cfg(all(
    feature = "execution-test-host",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn generation_component_real_ipc_process_factory_preserves_two_original_plans_and_budgets() {
    let fixture = Fixture::create();
    let (component, _installed, _approval) = install_generation(&fixture);
    let responses: ServiceResponses = Arc::default();
    let captured = responses.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.service_factory = Some(Arc::new(ObservedFactory {
                original: host.service_factory.clone().unwrap(),
                responses: captured,
            }));
        });
    let mut completed = Vec::new();
    for texts in [
        vec!["original root one", "component child one"],
        vec!["original root two", "component child two"],
    ] {
        let child_text = texts[1];
        let (config, provider) =
            local_provider_sequence_with_accept_timeout(texts, None, None, Duration::from_secs(30));
        let (plan, grant) = fixture.start_candidates(config);
        fixture.wait_saved(&plan["attemptId"]);
        let scope = fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]}),
            )
            .unwrap();
        let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]});
        let outer = ExecutionId::new();
        let preparing = json!({"scopeId":scope["scopeId"],"attemptId":outer,"component":component,"generation":generation});
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        let preflight = fixture
            .call("prepare_work_plan_generation_component", preparing.clone())
            .unwrap();
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(preflight["parentTask"], scope["parentTask"]);
        assert_eq!(preflight["generation"], generation);
        let mut unused = preparing.clone();
        unused["attemptId"] = json!(ExecutionId::new());
        unused["generation"]["taskId"] = json!(ExecutionId::new());
        unused["generation"]["attemptId"] = json!(ExecutionId::new());
        fixture
            .call("prepare_work_plan_generation_component", unused.clone())
            .unwrap();
        let discarding = json!({"attemptId":unused["attemptId"]});
        for _ in 0..2 {
            assert_eq!(
                fixture
                    .call("discard_work_plan_generation_component", discarding.clone())
                    .unwrap(),
                json!(true)
            );
        }
        let outer_task: ExecutionId = serde_json::from_value(preflight["taskId"].clone()).unwrap();
        assert_ne!(preflight["taskId"], generation["taskId"]);
        assert_ne!(preflight["taskId"], scope["parentTask"]);
        for task in [preflight["taskId"].clone(), generation["taskId"].clone()] {
            assert_eq!(
                fixture
                    .call(
                        "read_execution_task",
                        json!({"taskId":task,"after":"0","limit":100})
                    )
                    .unwrap(),
                json!([])
            );
        }
        assert_eq!(
            fixture
                .call("prepare_work_plan_generation_component", preparing.clone())
                .unwrap(),
            preflight
        );
        let mut changed = preparing;
        changed["generation"]["attemptId"] = json!(ExecutionId::new());
        assert!(
            fixture
                .call("prepare_work_plan_generation_component", changed)
                .is_err()
        );
        let starting = json!({"scopeId":scope["scopeId"],"attemptId":outer,"inputDigest":preflight["inputDigest"],"grantId":ExecutionId::new(),
            "expiresAtMs":(SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()+60_000).to_string(),"unsandboxedExecution":true});
        let mut rejected = starting.clone();
        rejected["unsandboxedExecution"] = json!(false);
        assert!(
            fixture
                .call("start_work_plan_generation_component", rejected)
                .is_err()
        );
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(
            fixture
                .call("start_work_plan_generation_component", starting.clone())
                .unwrap(),
            json!(outer)
        );
        let outer_records = fixture
            .call(
                "read_execution_task",
                json!({"taskId":outer_task,"after":"0","limit":100}),
            )
            .unwrap();
        assert_eq!(outer_records[0]["attemptId"], json!(outer));
        // The Host first activates the actual installed process, then enqueues
        // the child. Its absence during that interval is not an AI read error.
        let child_id: ExecutionId =
            serde_json::from_value(generation["attemptId"].clone()).unwrap();
        let enqueue_deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let enqueued = fixture
                .app
                .state::<AppState>()
                .sessions
                .with(move |sessions| {
                    let (host, store) =
                        sessions.active.as_mut().unwrap().execution_parts().unwrap();
                    if host
                        .runtime
                        .input_if_present(store, child_id)
                        .unwrap()
                        .is_some()
                    {
                        return true;
                    }
                    let outer_view = store.execution_attempt(outer, true).unwrap();
                    if outer_view.items.iter().any(|item| {
                        matches!(
                            item.execution,
                            ExecutionState::Failed
                                | ExecutionState::CancelledBeforeDispatch
                                | ExecutionState::Unknown
                        )
                    }) {
                        panic!("Component ended without its child: {outer_view:?}");
                    }
                    false
                });
            if enqueued {
                break;
            }
            assert!(
                Instant::now() < enqueue_deadline,
                "actual component did not enqueue child"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = fixture.wait_saved(&generation["attemptId"]);
        assert_eq!(output["rows"][0]["output"]["text"], child_text);
        assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
        let budget = fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]}),
            )
            .unwrap()["budget"]
            .clone();
        assert_eq!(budget["dispatched"], 2);
        let outer_id = outer;
        let child: ExecutionId = serde_json::from_value(generation["attemptId"].clone()).unwrap();
        let root: ExecutionId = serde_json::from_value(plan["attemptId"].clone()).unwrap();
        let outer_deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let (settled, detail) =
                fixture
                    .app
                    .state::<AppState>()
                    .sessions
                    .with(move |sessions| {
                        let (host, store) =
                            sessions.active.as_mut().unwrap().execution_parts().unwrap();
                        host.tick(store).unwrap();
                        let detail = store.execution_attempt(outer_id, true).unwrap();
                        (
                            !host.runtime.has_unsettled_attempt(store, outer_id).unwrap(),
                            detail,
                        )
                    });
            assert!(
                !detail.items.iter().any(|item| matches!(
                    item.execution,
                    ExecutionState::Failed
                        | ExecutionState::CancelledBeforeDispatch
                        | ExecutionState::Unknown
                )),
                "Component did not complete: {detail:?}; actual service replies: {:?}; component phase: {:?}",
                responses.lock().unwrap(),
                std::fs::read_to_string(fixture.directory.path().join("component-observer.txt"))
            );
            if settled {
                break;
            }
            assert!(
                Instant::now() < outer_deadline,
                "actual outer producer did not settle"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                let outer_input = store.execution_input(outer_id).unwrap();
                assert!(outer_input.envelope().plugin.is_some());
                assert!(outer_input.envelope().automation.is_none());
                let child_input = store.execution_input(child).unwrap();
                let root_input = store.execution_input(root).unwrap();
                assert!(child_input.envelope().plugin.is_none());
                assert_eq!(
                    child_input.envelope().automation,
                    root_input.envelope().automation
                );
                host.tick(store).unwrap();
                assert_eq!(
                    host.plugin_registrations
                        .iter()
                        .filter(|binding| binding.capability.declaration.input_schema
                            == sdk::generation_service_input_contract())
                        .count(),
                    1
                );
            });
        let completed_child = fixture.wait_saved(&generation["attemptId"]);
        assert_eq!(completed_child["rows"][0]["output"]["text"], child_text);
        assert_eq!(completed_child["rows"][0]["automation"]["phase"], "saved");
        let saved = fixture.bytes();
        assert_eq!(
            fixture
                .call("start_work_plan_generation_component", starting.clone())
                .unwrap(),
            json!(outer)
        );
        assert_eq!(fixture.bytes(), saved);
        assert_eq!(fixture.attempt_count(), count + 2);
        let mut replaced = starting;
        replaced["grantId"] = json!(ExecutionId::new());
        assert!(
            fixture
                .call("start_work_plan_generation_component", replaced)
                .is_err()
        );
        assert!(
            !fixture
                .call(
                    "discard_work_plan_generation_component",
                    json!({"attemptId":outer})
                )
                .unwrap()
                .as_bool()
                .unwrap()
        );
        completed.push((outer, generation, preflight));
    }
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM application_service_calls",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    for (outer, generation, _) in completed {
        let association: (String,String) = connection.query_row("SELECT outer_attempt, child_attempt FROM application_service_calls WHERE outer_attempt=?1", [outer.to_string()], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(
            association,
            (
                outer.to_string(),
                generation["attemptId"].as_str().unwrap().into()
            )
        );
    }
}

#[test]
fn generation_component_wire_preserves_strict_original_authority_boundaries() {
    let image = generation_package();
    let binding = sdk::bind_capability(
        image.manifest(),
        &image.manifest().manifest().contributions[0].id,
        image.package_digest(),
    )
    .unwrap();
    let prepare = json!({"sessionToken":"test-session","projectId":ExecutionId::new(),"scopeId":ExecutionId::new(),"attemptId":ExecutionId::new(),
        "component":{"provider":binding.provider,"profile":binding.declaration.profiles.first(),"environmentDigest":"b".repeat(64)},
        "generation":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[ExecutionId::new()]}});
    assert!(
        serde_json::from_value::<generation::WorkPlanGenerationPrepareRequest>(prepare.clone())
            .is_ok()
    );
    for field in [
        "grantId",
        "confirmed",
        "budget",
        "model",
        "effects",
        "parentTask",
    ] {
        let mut forged = prepare.clone();
        forged[field] = json!(true);
        assert!(
            serde_json::from_value::<generation::WorkPlanGenerationPrepareRequest>(forged).is_err()
        );
        let mut forged = prepare.clone();
        forged["generation"][field] = json!(true);
        assert!(
            serde_json::from_value::<generation::WorkPlanGenerationPrepareRequest>(forged).is_err()
        );
    }
}

#[test]
fn generation_component_shared_workflow_fixture_round_trips() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/workPlanGenerationComponent.contract.json"
    ))
    .unwrap();
    fn round<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round::<generation::WorkPlanGenerationPrepareRequest>(&fixture["prepare"]);
    round::<generation::WorkPlanGenerationStartRequest>(&fixture["start"]);
    round::<generation::WorkPlanGenerationDiscardRequest>(&fixture["discard"]);
    round::<generation::WorkPlanGenerationPreflight>(&fixture["preflight"]);
}
