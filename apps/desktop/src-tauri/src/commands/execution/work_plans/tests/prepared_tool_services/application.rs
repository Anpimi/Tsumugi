//! Actual application instances remain independent from each work-plan grant.
use super::*;

#[path = "../../../../../../../../../crates/plugin-host/tests/support/native.rs"]
mod native_fixture;

fn setup(native: bool, pending: bool, no_ready: bool) -> Setup {
    let fixture = Fixture::create();
    let observer = fixture.directory.path().join("query-observer.jsonl");
    if native {
        let (manifest, mut files) = native_fixture::application_package();
        let mut manifest: sdk::PluginManifest = serde_json::from_slice(&manifest).unwrap();
        let sdk::ContributionKind::Capability { declaration } =
            &mut manifest.contributions[0].contribution
        else {
            unreachable!()
        };
        declaration.limits.timeout_ms = 60_000;
        if pending {
            let mut declaration: Value = serde_json::from_slice(&files["tool.json"].bytes).unwrap();
            declaration["query"]["inputTemplate"]["cancelObserver"] = json!(observer);
            files.insert(
                "tool.json".into(),
                file(&serde_json::to_vec(&declaration).unwrap()),
            );
        }
        Setup::with_query(fixture, image(manifest, files), "echo-tool")
    } else {
        let (mut manifest, mut files) = query_package_parts(&observer, pending);
        manifest.components[0].scope = sdk::ComponentScope::Application;
        let mut sibling = manifest.contributions[0].clone();
        sibling.id = "query-side".into();
        manifest.contributions.push(sibling);
        // Use the same declared activation budget as the real-call fixture.
        // The Host's original handshake timeout must reach the missing Ready,
        // rather than timing out earlier while capturing/staging the runtime.
        files.insert(
            "observer.json".into(),
            file(
                &serde_json::to_vec(&json!({"path":observer,"pending":pending,"noReady":no_ready}))
                    .unwrap(),
            ),
        );
        files.insert("component.mjs".into(), file(br#"
import {readFile, appendFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(new URL('./observer.json',import.meta.url),'utf8'));
const observe=stage=>appendFile(config.path,JSON.stringify({stage,pid:process.pid})+'\n');
export default {async activate(api) {
  let calls=0;
  for(const member of api.contributions) api.register(member.id,async input=>{
    const value=JSON.parse(input.utf8); calls+=1;
    await observe('entered');
    if(config.pending) await new Promise(()=>{});
    return {kind:'succeeded',utf8:JSON.stringify({workerPid:process.pid,invocationCount:calls,queriedText:value.rows[0].text,
      results:[{entries:[{value:value.rows[0].text,note:value.target}]}]})};
  });
  await observe('registered');
  if(config.noReady) await new Promise(()=>{});
  api.onDispose(()=>observe('disposed'));
}};
"#));
        Setup::with_query(fixture, image(manifest, files), "query-tool")
    }
}

fn basis(plan: &Value) -> Value {
    let tool = &plan["tools"]["entries"][0];
    assert_eq!(tool["execution"]["componentScope"], "application");
    assert!(tool["execution"]["applicationScope"].is_object());
    tool["execution"]["applicationScope"].clone()
}

fn output(setup: &Setup, attempt: &Value, application: &Value) -> (Value, Value) {
    let detail = setup.wait_terminal(attempt);
    assert_eq!(
        detail["items"][0]["status"]["execution"], "succeeded",
        "{detail}"
    );
    let value = setup
        .fixture
        .call(
            "read_execution_output",
            json!({"attemptId":attempt,"resultId":detail["items"][0]["resultId"]}),
        )
        .unwrap();
    let evidence: PluginResultEvidence = serde_json::from_value(value["plugin"].clone()).unwrap();
    assert_eq!(
        evidence.result.context.project_id,
        setup.fixture.context["projectId"].as_str().unwrap()
    );
    assert_eq!(
        evidence.result.context.scope_id,
        application["instanceId"].as_str().unwrap()
    );
    assert_eq!(
        evidence.channel.selection(),
        setup.query.capability.provider
    );
    let payload = serde_json::from_str(
        value["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    (value, payload)
}

fn instance_state(setup: &Setup, application: &Value) -> Value {
    call(
        &setup.fixture.webview,
        "read_application_plugin_instance",
        json!({"basis":application}),
    )
    .unwrap()
}

fn stop_instance(setup: &Setup, application: &Value) {
    let stop = json!({"actionId":ExecutionId::new(),"basis":application});
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let view = call(
            &setup.fixture.webview,
            "stop_application_plugin_instance",
            stop.clone(),
        )
        .unwrap();
        if view["state"] == "stopped" {
            break;
        }
        assert_eq!(view["state"], "stopping");
        assert!(
            Instant::now() < deadline,
            "shared instance did not actually drain: {view}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn second_project(setup: &mut Setup) {
    setup.fixture.call("close_project", json!({})).unwrap();
    let path = setup.fixture.directory.path().join("second-project");
    let created = call(
        &setup.fixture.webview,
        "create_project",
        json!({"destination":path,"displayName":"Second tool project",
        "sourceLocale":"en-US","targetLocales":["zh-CN"]}),
    )
    .unwrap();
    setup.fixture.context = json!({"sessionToken":created["sessionToken"],"projectId":created["metadata"]["projectId"]});
    setup.fixture.project_path = path;
    let (unit, source_revision, snapshot) =
        Fixture::capture_source(&setup.fixture.app, br#"{"first":"Second"}"#.to_vec());
    setup.fixture.unit = unit;
    setup.fixture.source_revision = source_revision;
    setup.fixture.snapshot = snapshot;
}

fn reject_missing_or_substituted_lifetime_consent(setup: &Setup, plan: &Value) {
    let application = basis(plan);
    assert_eq!(instance_state(setup, &application)["state"], "reserved");
    let mut wrong = application.clone();
    wrong["activationGeneration"] = json!(2);
    for selected in [json!([]), json!([application, application]), json!([wrong])] {
        let action = ExecutionId::new();
        assert!(setup.fixture.call("authorize_work_plan", json!({
            "planId":plan["planId"],"digest":plan["digest"],"actionId":action,
            "confirmed":true,"checkerExecutions":checker_keys(plan),"toolExecution":true,
            "applicationToolExecutions":selected,"effects":["save-candidate","query-tools"],"expiresAt":expiry()
        })).is_err());
        assert!(
            setup
                .fixture
                .call("read_work_plan_action", json!({"actionId":action}))
                .unwrap()
                .is_null()
        );
        assert_eq!(instance_state(setup, &application)["state"], "reserved");
    }
    assert!(setup.fixture.call("authorize_work_plan", json!({
        "planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),
        "confirmed":false,"checkerExecutions":checker_keys(plan),"toolExecution":true,
        "applicationToolExecutions":[application],"effects":["save-candidate","query-tools"],"expiresAt":expiry()
    })).is_err());
    assert_eq!(instance_state(setup, &application)["state"], "reserved");
}

fn normal(native: bool) {
    let mut setup = setup(native, false, false);
    let (config, provider) = local_provider_sequence_with_accept_timeout(
        vec!["first root", "first component"],
        None,
        None,
        Duration::from_secs(120),
    );
    let plan = setup.prepare_plan(config);
    if !native {
        reject_missing_or_substituted_lifetime_consent(&setup, &plan);
    }
    let grant = setup.start_prepared_plan(&plan);
    let application = basis(&plan);
    assert_eq!(
        plan["tools"]["entries"][0]["applicationCapabilities"]
            .as_array()
            .unwrap()
            .len(),
        if native { 1 } else { 2 }
    );
    assert_eq!(instance_state(&setup, &application)["state"], "active");
    if !native {
        assert!(
            !setup
                .fixture
                .directory
                .path()
                .join("query-observer.jsonl")
                .exists(),
            "lifetime consent alone does not launch B"
        );
    }
    let (request, preflight, query) = setup.prepare(&grant);
    let start = setup.start(&request, &preflight);
    let outer = setup.wait_terminal(&request["attemptId"]);
    assert_eq!(
        outer["items"][0]["status"]["execution"], "succeeded",
        "{outer}"
    );
    let saved = setup
        .fixture
        .wait_saved(&request["generation"]["attemptId"]);
    assert_eq!(saved["rows"][0]["output"]["text"], "first component");
    let (first_output, first) = output(&setup, &query["attemptId"], &application);
    assert_eq!(first["invocationCount"], 1);
    assert_eq!(
        if native {
            &first["rows"][0]["text"]
        } else {
            &first["queriedText"]
        },
        "Hello"
    );
    assert_ne!(first_output["plugin"]["authorizationId"], start["grantId"]);
    let pid = first["workerPid"].as_u64().unwrap();
    provider.join().unwrap();

    let tool = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":setup.tool_selection["entries"][0]["handle"],"unitIds":[setup.fixture.unit]});
    let prepared = setup
        .fixture
        .call(
            "prepare_work_plan_agent_tool",
            json!({"scopeId":request["scopeId"],"tool":tool}),
        )
        .unwrap();
    setup
        .fixture
        .call(
            "start_work_plan_agent_tool",
            json!({"scopeId":request["scopeId"],"tool":tool,"inputDigest":prepared["inputDigest"]}),
        )
        .unwrap();
    let (manual_output, manual) = output(&setup, &tool["attemptId"], &application);
    assert_eq!(manual["workerPid"], json!(pid));
    assert_eq!(manual["invocationCount"], 2);
    assert_ne!(
        manual_output["plugin"]["authorizationId"],
        first_output["plugin"]["authorizationId"]
    );
    let first_project = setup.fixture.context["projectId"].clone();
    second_project(&mut setup);
    assert_ne!(setup.fixture.context["projectId"], first_project);
    assert_eq!(
        instance_state(&setup, &application)["state"],
        "active",
        "project close preserves the independent application lifetime"
    );

    let (config, provider) = local_provider_sequence_with_accept_timeout(
        vec!["second root", "second component"],
        None,
        None,
        Duration::from_secs(120),
    );
    let (plan, grant) = setup.start_plan(config);
    assert_eq!(
        basis(&plan),
        application,
        "a second project reuses the exact original application activation"
    );
    let (request, preflight, query) = setup.prepare(&grant);
    let second_start = setup.start(&request, &preflight);
    let outer = setup.wait_terminal(&request["attemptId"]);
    assert_eq!(
        outer["items"][0]["status"]["execution"], "succeeded",
        "{outer}"
    );
    let saved = setup
        .fixture
        .wait_saved(&request["generation"]["attemptId"]);
    assert_eq!(saved["rows"][0]["output"]["text"], "second component");
    let (second_output, second) = output(&setup, &query["attemptId"], &application);
    assert_eq!(second["workerPid"], json!(pid));
    assert_eq!(second["invocationCount"], 3);
    assert_eq!(
        if native {
            &second["rows"][0]["text"]
        } else {
            &second["queriedText"]
        },
        "Second"
    );
    assert_ne!(
        second_output["plugin"]["authorizationId"],
        first_output["plugin"]["authorizationId"]
    );
    provider.join().unwrap();
    stop_instance(&setup, &application);
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success()
    );
    let next = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":setup.tool_selection["entries"][0]["handle"],"unitIds":[setup.fixture.unit]});
    let preview = setup
        .fixture
        .call(
            "prepare_work_plan_agent_tool",
            json!({"scopeId":request["scopeId"],"tool":next}),
        )
        .unwrap();
    let count = setup.fixture.attempt_count();
    assert!(
        setup
            .fixture
            .call(
                "start_work_plan_agent_tool",
                json!({
                    "scopeId":request["scopeId"],"tool":next,"inputDigest":preview["inputDigest"]
                })
            )
            .is_err(),
        "an old read-only preview cannot replace a stopped application lease"
    );
    assert_eq!(setup.fixture.attempt_count(), count);
    assert_eq!(instance_state(&setup, &application)["state"], "stopped");
    setup.fixture.call("control_work_plan",json!({"planId":plan["planId"],"actionId":ExecutionId::new(),
        "expectedGeneration":grant["lease"]["generation"],"command":"stop","confirmed":false,
        "checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"expiresAt":null})).unwrap();
    setup.fixture.call("close_project", json!({})).unwrap();
    let reopened = call(
        &setup.fixture.webview,
        "open_project",
        json!({"locator":setup.fixture.project_path}),
    )
    .unwrap();
    setup.fixture.context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    // The original output envelope owns its result identity; do not infer it
    // from the query's new preparation or create a replacement grant on reopen.
    let saved = setup
        .fixture
        .call(
            "read_execution_attempt",
            json!({"attemptId":query["attemptId"],"offset":0,"limit":100}),
        )
        .unwrap();
    let reread = setup
        .fixture
        .call(
            "read_execution_output",
            json!({"attemptId":query["attemptId"],"resultId":saved["items"][0]["resultId"]}),
        )
        .unwrap();
    assert_eq!(reread, second_output);
    assert_eq!(
        setup
            .fixture
            .call(
                "read_work_plan_action",
                json!({"actionId":grant["actionId"]})
            )
            .unwrap()["actionId"],
        grant["actionId"]
    );
    assert!(
        setup
            .fixture
            .call("start_work_plan_generation_component", second_start)
            .is_err()
    );
}

#[test]
fn prepared_application_tool_services_js_roster_cross_projects_and_manual_agent_keep_original_instance()
 {
    normal(false);
}

#[test]
fn prepared_application_tool_services_native_singleton_cross_projects_and_manual_agent_keep_original_instance()
 {
    normal(true);
}

fn cancel(native: bool) {
    let setup = setup(native, true, false);
    let (mut config, provider) = local_provider("root candidate");
    config.max_requests = 2;
    let (plan, grant) = setup.start_plan(config);
    provider.join().unwrap();
    let application = basis(&plan);
    let (request, preflight, query) = setup.prepare(&grant);
    setup.start(&request, &preflight);
    let observer = setup.fixture.directory.path().join("query-observer.jsonl");
    let deadline = Instant::now() + Duration::from_secs(60);
    let pid = loop {
        if let Ok(text) = fs::read_to_string(&observer) {
            if native {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    break value["workerPid"].as_u64().unwrap();
                }
            } else if let Some(value) = text
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|value| value["stage"] == "entered")
            {
                break value["pid"].as_u64().unwrap();
            }
        }
        assert!(
            Instant::now() < deadline,
            "the actual application tool never entered"
        );
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
    let query = setup.wait_terminal(&query["attemptId"]);
    assert_ne!(outer["items"][0]["status"]["execution"], "succeeded");
    assert_ne!(query["items"][0]["status"]["execution"], "succeeded");
    assert!(query["items"][0]["resultId"].is_null());
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let state = instance_state(&setup, &application);
        if state["state"] == "stopped" {
            break;
        }
        assert!(
            Instant::now() < until,
            "cancellation did not retire and reap the original shared instance: {state}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn prepared_application_tool_services_js_caller_cancel_retires_the_exact_shared_instance() {
    cancel(false);
}

#[test]
fn prepared_application_tool_services_native_caller_cancel_retires_the_exact_shared_instance() {
    cancel(true);
}

#[test]
fn prepared_application_tool_services_missing_ready_never_launches_caller_and_reaps_failed_dependency()
 {
    let setup = setup(false, false, true);
    let (mut config, provider) = local_provider("root candidate");
    config.max_requests = 2;
    let (plan, grant) = setup.start_plan(config);
    provider.join().unwrap();
    let application = basis(&plan);
    let (request, preflight, _query) = setup.prepare(&grant);
    let before = setup.fixture.attempt_count();
    let start = json!({"scopeId":request["scopeId"],"attemptId":request["attemptId"],"inputDigest":preflight["inputDigest"],
        "grantId":ExecutionId::new(),"expiresAtMs":(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis()+120_000).to_string(),"unsandboxedExecution":true});
    assert!(
        setup
            .fixture
            .call("start_work_plan_generation_component", start)
            .is_err()
    );
    assert_eq!(
        setup.fixture.attempt_count(),
        before,
        "A must not enqueue before required B is actually Ready"
    );
    assert!(
        !setup
            .fixture
            .directory
            .path()
            .join("caller-observer.jsonl")
            .exists()
    );
    stop_instance(&setup, &application);
    let observations =
        fs::read_to_string(setup.fixture.directory.path().join("query-observer.jsonl")).unwrap();
    let registered = observations
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["stage"] == "registered")
        .unwrap();
    let pid = registered["pid"].as_u64().unwrap();
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success()
    );
}
