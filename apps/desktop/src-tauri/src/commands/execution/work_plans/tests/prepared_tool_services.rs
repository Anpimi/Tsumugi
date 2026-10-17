//! Actual caller and query workers use independent grants in the original ledger.
use super::*;
use crate::commands::execution::test_fixtures::{
    OwnedDirectory, approved_runtime, provision_packages,
};
use std::{fs, path::Path};
use tsumugi_plugin_host::{
    PackageFile, PackageImage, RuntimeApproval,
    catalog::{PackageApproval, PackageOrigin},
};

fn image(manifest: sdk::PluginManifest, files: BTreeMap<String, PackageFile>) -> PackageImage {
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}
fn file(bytes: &[u8]) -> PackageFile {
    PackageFile {
        executable: false,
        bytes: bytes.to_vec(),
    }
}
fn query_package(observer: &Path, pending: bool) -> PackageImage {
    let (manifest, files) = query_package_parts(observer, pending);
    image(manifest, files)
}
fn query_package_parts(
    observer: &Path,
    pending: bool,
) -> (sdk::PluginManifest, BTreeMap<String, PackageFile>) {
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/plugin-sdk/tests/fixtures/tool.manifest.json"
    )))
    .unwrap();
    if let sdk::ContributionKind::Capability { declaration } =
        &mut manifest.contributions[0].contribution
    {
        declaration.limits.timeout_ms = 60_000;
    }
    let worker = br#"
import {readFile, appendFile} from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('./observer.json', import.meta.url), 'utf8'));
const observe = stage => appendFile(config.path, JSON.stringify({stage,pid:process.pid})+'\n');
export default {activate(api) {
  api.register('query', async input => {
    const value = JSON.parse(input.utf8);
    await observe('entered');
    if(config.pending) await new Promise(()=>{});
    return {kind:'succeeded',utf8:JSON.stringify({results:[{entries:[{value:value.rows[0].text,note:value.target}]}]})};
  });
  api.onDispose(()=>observe('disposed'));
}};
"#;
    (
        manifest,
        BTreeMap::from([
            ("component.mjs".into(), file(worker)),
            ("terms.bin".into(), file(b"immutable reference")),
            ("guidance.md".into(), file(b"Query only; do not adopt.")),
            (
                "tool.json".into(),
                file(include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../crates/plugin-sdk/tests/fixtures/tool.query.json"
                ))),
            ),
            (
                "observer.json".into(),
                file(&serde_json::to_vec(&json!({"path":observer,"pending":pending})).unwrap()),
            ),
        ]),
    )
}
fn caller_package(query: &sdk::CapabilityToolBinding, observer: &Path) -> PackageImage {
    let mut manifest = generation_package_with_timeout(None, 60_000)
        .manifest()
        .manifest()
        .clone();
    let permission = sdk::PermissionRequest::ProjectService {
        contract: query.capability.declaration.contract.clone(),
    };
    manifest.permissions.push(permission.clone());
    manifest.components[0]
        .dependencies
        .push(sdk::CapabilityDependency {
            contract: query.capability.declaration.contract.clone(),
            required: true,
            selection: sdk::ProviderSelection::Single,
        });
    if let sdk::ContributionKind::Capability { declaration } =
        &mut manifest.contributions[0].contribution
    {
        declaration.input_schema = sdk::generation_component_input_contract();
        declaration.limits.max_input_bytes = sdk::MAX_GENERATION_COMPONENT_INPUT_BYTES as u32;
        declaration.permissions.push(permission);
    }
    image(manifest, BTreeMap::from([
        ("observer.txt".into(), file(observer.to_str().unwrap().as_bytes())),
        ("component.mjs".into(), file(br#"
import {readFile, appendFile} from 'node:fs/promises';
const path = await readFile(new URL('./observer.txt', import.meta.url), 'utf8');
export default {activate(api) {
  api.register(api.contributions[0].id, async (input, metadata) => {
    const value = JSON.parse(input.utf8);
    for(const query of value.preparedTools) {
      const response = await metadata.services.call(query.handleId, query.input.utf8, query.callId);
      if(response.outcome.kind!=='succeeded') throw new Error('Query did not succeed');
      await appendFile(path, JSON.stringify({stage:'query-result',pid:process.pid,response})+'\n');
    }
    const generation = api.services.find(service=>service.contract.id==='tsumugi.work-plan-generation');
    const response = await metadata.services.call(generation.handleId, JSON.stringify(value.generation), 'generation-call');
    const payload=response.outcome.kind==='succeeded'?response.outcome.output:response.outcome.error;
    return {kind:response.outcome.kind,utf8:payload.utf8};
  });
  api.onDispose(()=>appendFile(path, JSON.stringify({stage:'disposed',pid:process.pid})+'\n'));
}};
"#)),
    ]))
}

struct Setup {
    fixture: Fixture,
    _installation: OwnedDirectory,
    component: Value,
    tool_selection: Value,
    query: sdk::CapabilityToolBinding,
}
impl Setup {
    fn new(pending: bool) -> Self {
        let fixture = Fixture::create();
        let query_image = query_package(
            &fixture.directory.path().join("query-observer.jsonl"),
            pending,
        );
        Self::with_query(fixture, query_image, "query-tool")
    }
    fn with_query(fixture: Fixture, query_image: PackageImage, resource_id: &str) -> Self {
        let query = query_image.capability_tool(resource_id).unwrap();
        let caller = caller_package(
            &query,
            &fixture.directory.path().join("caller-observer.jsonl"),
        );
        let runtime = approved_runtime();
        let approval = RuntimeApproval {
            environment: runtime.descriptor().clone().into(),
            origin: crate::runtime_bundle::bundled_origin(),
        };
        let installation = OwnedDirectory(tempfile::tempdir().unwrap());
        let mut packages = Vec::new();
        for package in [&query_image, &caller] {
            packages.push((
                package.clone(),
                PackageApproval {
                    plugin: package.manifest().manifest().plugin.clone(),
                    package_digest: package.package_digest().into(),
                    origin: PackageOrigin {
                        source_id: "synthetic-service-source".into(),
                        publisher_id: "synthetic-service-publisher".into(),
                    },
                },
            ));
        }
        provision_packages(installation.0.path(), &packages, &runtime, &approval);
        fixture
            .app
            .state::<AppState>()
            .plugins
            .configure(installation.0.path().join("application"))
            .unwrap();
        let environment = approval.environment.digest().unwrap();
        let tool_environment =
            if query_image.manifest().manifest().components[0].runtime
                == sdk::RuntimeKind::NativeWorker
            {
                let host = tsumugi_plugin_host::CapturedNativeRuntime::inspect_current().unwrap();
                let inventory = call(&fixture.webview, "read_plugin_inventory", json!({})).unwrap();
                call(&fixture.webview, "set_plugin_native_host_approval", json!({
                "environmentDigest":host.digest().unwrap(),"approved":true,
                "expectedRevision":inventory["settingsRevision"],"actionId":ExecutionId::new()
            })).unwrap();
                host.digest().unwrap()
            } else {
                environment.clone()
            };
        let capability = sdk::bind_capability(
            caller.manifest(),
            &caller.manifest().manifest().contributions[0].id,
            caller.package_digest(),
        )
        .unwrap();
        let component = json!({"provider":capability.provider,"profile":capability.declaration.profiles.first(),"environmentDigest":environment});
        let tool_selection = json!({"maxInvocations":2,"entries":[{"handle":ExecutionId::new(),
            "tool":{"package":{"plugin":query.capability.provider.plugin,"packageDigest":query.capability.provider.package_digest},
                "resourceId":resource_id,"environmentDigest":tool_environment},"target":"zh-CN","selections":["term"]}]});
        Self {
            fixture,
            _installation: installation,
            component,
            tool_selection,
            query,
        }
    }
    fn start_plan(&self, config: AiConfig) -> (Value, Value) {
        let plan = self.prepare_plan(config);
        let grant = self.start_prepared_plan(&plan);
        (plan, grant)
    }
    fn prepare_plan(&self, config: AiConfig) -> Value {
        self.fixture.call("prepare_work_plan",json!({"config":config,"locale":"zh-CN",
            "unitIds":[self.fixture.unit],"options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":self.tool_selection})).unwrap()
    }
    fn start_prepared_plan(&self, plan: &Value) -> Value {
        let mut application_executions: Vec<Value> = Vec::new();
        for tool in plan["tools"]["entries"].as_array().unwrap() {
            let basis = &tool["execution"]["applicationScope"];
            if !basis.is_null() && !application_executions.contains(basis) {
                application_executions.push(basis.clone());
            }
        }
        let grant = self.fixture.call("authorize_work_plan",json!({"planId":plan["planId"],"digest":plan["digest"],
            "actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":true,"applicationToolExecutions":application_executions,
            "effects":["save-candidate","query-tools"],"expiresAt":expiry()})).unwrap();
        self.fixture
            .call(
                "start_work_plan",
                json!({"planId":plan["planId"],"actionId":grant["actionId"],
            "expectedGeneration":grant["lease"]["generation"]}),
            )
            .unwrap();
        self.fixture.wait_saved(&plan["attemptId"]);
        grant
    }
    fn prepare(&self, grant: &Value) -> (Value, Value, Value) {
        let control_before = self
            .fixture
            .call(
                "read_work_plan_status",
                json!({"planId":grant["lease"]["planId"]}),
            )
            .unwrap();
        let before_now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let scope = self
            .fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]}),
            )
            .unwrap();
        let query = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),
            "toolHandle":self.tool_selection["entries"][0]["handle"],"unitIds":[self.fixture.unit]});
        let request = json!({"scopeId":scope["scopeId"],"attemptId":ExecutionId::new(),"component":self.component,
            "generation":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[self.fixture.unit]},"toolQueries":[query]});
        let before = self.fixture.attempt_count();
        let preflight = self.fixture.call("prepare_work_plan_generation_component", request.clone()).unwrap_or_else(|error| {
            let control_after = self.fixture.call("read_work_plan_status", json!({"planId":grant["lease"]["planId"]})).unwrap();
            panic!("component prepare rejected: {error}; before=({},{},{},{before_now}); after=({},{},{},{})",
                control_before["state"],control_before["lease"],control_before["expiresAt"],
                control_after["state"],control_after["lease"],control_after["expiresAt"],
                SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs());
        });
        assert_eq!(
            self.fixture.attempt_count(),
            before,
            "preparation enqueues neither worker"
        );
        assert_eq!(preflight["preparedTools"][0]["query"], query);
        (request, preflight, query)
    }
    fn start(&self, request: &Value, preflight: &Value) -> Value {
        let start = json!({"scopeId":request["scopeId"],"attemptId":request["attemptId"],"inputDigest":preflight["inputDigest"],
            "grantId":ExecutionId::new(),"expiresAtMs":(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis()+120_000).to_string(),
            "unsandboxedExecution":true});
        if let Err(error) = self
            .fixture
            .call("start_work_plan_generation_component", start.clone())
        {
            let scope_id: ExecutionId =
                serde_json::from_value(preflight["scopeId"].clone()).unwrap();
            let control = self
                .fixture
                .app
                .state::<AppState>()
                .sessions
                .with(move |sessions| {
                    let active = sessions.active.as_mut().unwrap();
                    let host = active.execution.as_ref().unwrap();
                    let scope = host.work_plans.agent_scopes.get(&scope_id).unwrap();
                    let status = active
                        .store
                        .work_plan_status(scope.lease().plan_id)
                        .unwrap();
                    (
                        status.state,
                        status.lease,
                        status.expires_at,
                        SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_secs(),
                    )
                });
            panic!(
                "component start rejected: {error}; original control (state,lease,expiry,now)={control:?}"
            );
        }
        start
    }
    fn wait_terminal(&self, attempt: &Value) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let view = self
                .fixture
                .call(
                    "read_execution_attempt",
                    json!({"attemptId":attempt,"offset":0,"limit":100}),
                )
                .unwrap();
            let items = view["items"].as_array().unwrap();
            if !items.is_empty()
                && items.iter().all(|item| {
                    !matches!(
                        item["status"]["execution"].as_str(),
                        Some("queued" | "dispatched")
                    )
                })
            {
                let id: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
                let drained = self
                    .fixture
                    .app
                    .state::<AppState>()
                    .sessions
                    .with(move |sessions| {
                        !sessions
                            .active
                            .as_mut()
                            .unwrap()
                            .execution
                            .as_mut()
                            .unwrap()
                            .runtime
                            .has_owned_attempt_work(id)
                    });
                if drained {
                    return view;
                }
            }
            assert!(
                Instant::now() < deadline,
                "actual caller/query did not drain: {view}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[path = "prepared_tool_services/application.rs"]
mod application;

#[test]
fn prepared_tool_services_real_workers_keep_independent_grants_original_receipts_and_reopen() {
    let mut setup = Setup::new(false);
    let (config, provider) = local_provider_sequence_with_accept_timeout(
        vec!["root candidate", "component candidate"],
        None,
        None,
        Duration::from_secs(120),
    );
    let (plan, grant) = setup.start_plan(config);
    let (request, preflight, query) = setup.prepare(&grant);
    let payload: Value = serde_json::from_str(
        preflight["preparedTools"][0]["input"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["rows"][0]["text"], "Hello");
    let start = setup.start(&request, &preflight);
    let outer = setup.wait_terminal(&request["attemptId"]);
    assert_eq!(
        outer["items"][0]["status"]["execution"], "succeeded",
        "{outer}"
    );
    let child = setup.wait_terminal(&query["attemptId"]);
    assert_eq!(
        child["items"][0]["status"]["execution"], "succeeded",
        "{child}"
    );
    let output = setup
        .fixture
        .call(
            "read_execution_output",
            json!({"attemptId":query["attemptId"],"resultId":child["items"][0]["resultId"]}),
        )
        .unwrap();
    let evidence: PluginResultEvidence = serde_json::from_value(output["plugin"].clone()).unwrap();
    assert_eq!(
        evidence.channel.selection(),
        setup.query.capability.provider
    );
    assert_ne!(json!(evidence.authorization_id), start["grantId"]);
    assert_eq!(
        output["plugin"]["result"]["outcome"]["output"]["schema"],
        json!(setup.query.capability.declaration.output_schema)
    );
    let returned: Value = serde_json::from_str(
        output["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(returned["results"][0]["entries"][0]["value"], "Hello");
    let observed =
        fs::read_to_string(setup.fixture.directory.path().join("caller-observer.jsonl")).unwrap();
    let observed: Value = observed
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["stage"] == "query-result")
        .unwrap();
    assert_eq!(
        observed["response"]["outcome"],
        json!(evidence.result.outcome)
    );
    let entered =
        fs::read_to_string(setup.fixture.directory.path().join("query-observer.jsonl")).unwrap();
    let entered: Value = entered
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["stage"] == "entered")
        .unwrap();
    assert_ne!(
        observed["pid"], entered["pid"],
        "caller and query execute in separate actual processes"
    );
    let caller_output = setup
        .fixture
        .call(
            "read_execution_output",
            json!({"attemptId":request["attemptId"],"resultId":outer["items"][0]["resultId"]}),
        )
        .unwrap();
    let original: sdk::InvocationContext =
        serde_json::from_value(caller_output["plugin"]["result"]["context"].clone()).unwrap();
    let identity = tsumugi_core::application::WorkPlanServiceCallIdentity {
        outer_attempt_id: ExecutionId::parse(&original.attempt_id).unwrap(),
        outer_item_id: ExecutionId::parse(&original.item_id).unwrap(),
        outer_dispatch_id: ExecutionId::parse(&original.dispatch_id).unwrap(),
        handle_id: preflight["preparedTools"][0]["handleId"]
            .as_str()
            .unwrap()
            .into(),
        call_id: preflight["preparedTools"][0]["callId"]
            .as_str()
            .unwrap()
            .into(),
    };
    let service_call = tsumugi_core::application::WorkPlanServiceCall {
        handle_id: identity.handle_id.clone(),
        call_id: identity.call_id.clone(),
        input: serde_json::from_value(preflight["preparedTools"][0]["input"].clone()).unwrap(),
    };
    let original_grant: ExecutionId = serde_json::from_value(start["grantId"].clone()).unwrap();
    let expected = setup.fixture.app.state::<AppState>().sessions.with({
        let identity = identity.clone();
        let service_call = service_call.clone();
        move |sessions| {
            let active = sessions.active.as_mut().unwrap();
            let receipt = active
                .store
                .work_plan_tool_service_receipt(&identity, &service_call)
                .unwrap()
                .unwrap();
            assert_eq!(receipt.grant_id, evidence.authorization_id);
            assert_eq!(receipt.origin_grant_id, original_grant);
            receipt
        }
    });
    let saved = setup
        .fixture
        .wait_saved(&request["generation"]["attemptId"]);
    assert_eq!(saved["rows"][0]["output"]["text"], "component candidate");
    provider.join().unwrap();
    assert_eq!(
        setup
            .fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap()["toolInvocations"],
        json!({"reserved":1,"limit":2})
    );
    assert_eq!(
        setup
            .fixture
            .call("start_work_plan_generation_component", start.clone())
            .unwrap(),
        request["attemptId"]
    );
    let count = setup.fixture.attempt_count();
    setup
        .fixture
        .app
        .state::<AppState>()
        .sessions
        .with(|sessions| {
            sessions.active.take();
        });
    let reopened = call(
        &setup.fixture.webview,
        "open_project",
        json!({"locator":setup.fixture.directory.path().join("project")}),
    )
    .unwrap();
    setup.fixture.context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    setup
        .fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            assert_eq!(
                store
                    .work_plan_tool_service_receipt(&identity, &service_call)
                    .unwrap(),
                Some(expected)
            );
        });
    assert_eq!(setup.fixture.attempt_count(), count);
    assert!(
        setup
            .fixture
            .call("start_work_plan_generation_component", start)
            .is_err(),
        "history cannot restore live start authority"
    );
}

#[test]
fn prepared_tool_services_caller_cancel_reaps_both_real_processes() {
    let setup = Setup::new(true);
    let (mut config, provider) = local_provider("root candidate");
    // The prepared caller proposes one later generation after its query. Keep
    // that original budget available even though cancellation must prevent it.
    config.max_requests = 2;
    let (_plan, grant) = setup.start_plan(config);
    provider.join().unwrap();
    let (request, preflight, query) = setup.prepare(&grant);
    setup.start(&request, &preflight);
    let observer = setup.fixture.directory.path().join("query-observer.jsonl");
    let deadline = Instant::now() + Duration::from_secs(60);
    let pid = loop {
        if let Ok(text) = fs::read_to_string(&observer) {
            if let Some(line) = text.lines().find_map(|line| {
                serde_json::from_str::<Value>(line)
                    .ok()
                    .filter(|value| value["stage"] == "entered")
            }) {
                break line["pid"].as_u64().unwrap();
            }
        }
        assert!(Instant::now() < deadline, "query worker never entered");
        std::thread::sleep(Duration::from_millis(20));
    };
    setup
        .fixture
        .call(
            "cancel_execution_task",
            json!({"taskId":preflight["taskId"],"requestId":ExecutionId::new()}),
        )
        .unwrap();
    let outer = setup.wait_terminal(&request["attemptId"]);
    let child = setup.wait_terminal(&query["attemptId"]);
    assert_ne!(outer["items"][0]["status"]["execution"], "succeeded");
    assert_ne!(child["items"][0]["status"]["execution"], "succeeded");
    assert!(
        child["items"][0]["resultId"].is_null(),
        "cancelled query cannot publish a result"
    );
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success(),
        "the owned query PID must actually be reaped"
    );
}
