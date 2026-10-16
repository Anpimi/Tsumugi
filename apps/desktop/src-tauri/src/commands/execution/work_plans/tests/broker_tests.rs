use super::*;

#[test]
fn registered_agent_tool_ipc_rejects_missing_consent_and_authority_overrides() {
    let fixture = Fixture::create();
    let (config, provider) = local_provider("保留原候选");
    let (plan, grant) = fixture.start_candidates(config);
    fixture.wait_saved(&plan["attemptId"]);
    provider.join().unwrap();
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let request = json!({"scopeId":scope["scopeId"],"tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":ExecutionId::new(),"unitIds":[fixture.unit]}});
    let count = fixture.attempt_count();
    let before = fixture.bytes();
    assert_eq!(
        fixture
            .call("prepare_work_plan_agent_tool", request.clone())
            .unwrap_err()["code"],
        "permission-denied"
    );
    let mut start = request.clone();
    start["inputDigest"] = json!("a".repeat(64));
    assert!(
        fixture
            .call("start_work_plan_agent_tool", start.clone())
            .is_err()
    );
    for field in [
        "text",
        "payload",
        "callerId",
        "confirmed",
        "grantId",
        "expiresAtMs",
    ] {
        for nested in [true, false] {
            let mut forged = request.clone();
            if nested {
                forged["tool"][field] = json!(true);
            } else {
                forged[field] = json!(true);
            }
            assert!(
                fixture
                    .call("prepare_work_plan_agent_tool", forged)
                    .is_err(),
                "{field}"
            );
            let mut forged = start.clone();
            if nested {
                forged["tool"][field] = json!(true);
            } else {
                forged[field] = json!(true);
            }
            assert!(
                fixture.call("start_work_plan_agent_tool", forged).is_err(),
                "{field}"
            );
        }
    }
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(fixture.bytes(), before);
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn real_work_plan_tool_broker_uses_fixed_units_shared_budget_and_independent_consent() {
    real_work_plan_tool_broker_scoped(false)
}
#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn real_attempt_work_plan_tool_broker_keeps_child_scope_and_original_authority() {
    real_work_plan_tool_broker_scoped(true)
}
#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[path = "../../../../../../../../crates/plugin-host/tests/support/scoped_package.rs"]
mod scoped_package;
#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn real_work_plan_tool_broker_scoped(attempt_scope: bool) {
    use crate::commands::plugins::{
        InstalledPluginFixture, PluginPackageRequest, PluginToolRequest,
    };
    use std::{fs, path::PathBuf};
    use tsumugi_plugin_host::{
        CapturedRuntime, PackageImage, RuntimeApproval,
        catalog::{PackageApproval, PackageOrigin},
    };

    let mut fixture = Fixture::create();
    let image = PackageImage::capture_directory(
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
                .expect("explicit independent tool artifact required"),
        ),
        &std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST")
            .expect("independently approved package digest required"),
        || true,
    )
    .unwrap();
    let image = if attempt_scope {
        scoped_package::capture(
            &PathBuf::from(std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE").unwrap()),
            &std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST").unwrap(),
            |_| tsumugi_plugin_sdk::ComponentScope::Attempt,
        )
    } else {
        image
    };
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: image.package_digest().into(),
        origin: PackageOrigin {
            source_id: "synthetic-manual-source".into(),
            publisher_id: "synthetic-manual-publisher".into(),
        },
    };
    let descriptor: tsumugi_plugin_sdk::RuntimeEnvironmentDescriptor = serde_json::from_slice(
        &fs::read(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL")
                .expect("independently approved runtime required"),
        )
        .unwrap(),
    )
    .unwrap();
    let runtime = CapturedRuntime::capture_directories(
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL")
                .expect("explicit actual tool tree required"),
        ),
        &PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST")
                .expect("explicit actual Host tree required"),
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
        approval.clone(),
    );
    installed.install();
    installed.install_runtime(&runtime, &runtime_approval);
    installed.decide(true, vec![runtime_approval.clone()]);
    drop(runtime);
    let selector = PluginToolRequest {
        package: PluginPackageRequest {
            plugin: approval.plugin.clone(),
            package_digest: approval.package_digest.clone(),
        },
        resource_id: "agent-query-tool".into(),
        environment_digest: runtime_approval.environment.digest().unwrap(),
    };
    let binding = image.capability_tool("agent-query-tool").unwrap();
    let query = binding
        .declaration
        .query
        .as_ref()
        .expect("actual declared query form required");
    let target = query.target.options[0].value.clone();
    let selections: Vec<_> = query
        .selections
        .options
        .iter()
        .take(query.selections.min_selected as usize)
        .map(|option| option.value.clone())
        .collect();
    let handles = [ExecutionId::new(), ExecutionId::new()];
    let tools = json!({"maxInvocations":2,"entries":handles.iter().map(|handle| json!({"handle":handle,"tool":selector,"target":target,"selections":selections})).collect::<Vec<_>>()});
    let (config, dispatch, provider) = local_provider_after_setup("保留根候选");
    let preparation = json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit],"options":PlanOptions::default(),"toolSelection":tools,"advisoryChecks":[]});
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let mut forged = preparation.clone();
    forged["toolSelection"]["entries"][0]["binding"] = json!(binding);
    assert!(fixture.call("prepare_work_plan", forged).is_err());
    let plan = fixture.call("prepare_work_plan", preparation).unwrap();
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(plan["tools"]["entries"][0]["binding"], json!(binding));
    assert_eq!(
        plan["tools"]["entries"][0]["execution"]["environment"],
        json!(runtime_approval.environment)
    );
    // The root's normal one-hour authorization is independent of the tool's
    // original ten-minute human consent, including uncertain-response replay.
    let root_expiry = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let authorization = json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,
        "checkerExecutions":checker_keys(&plan),"toolExecution":true,"effects":["save-candidate","query-tools"],"expiresAt":root_expiry.to_string()});
    let mut rejected = authorization.clone();
    rejected["toolExecution"] = json!(false);
    assert!(fixture.call("authorize_work_plan", rejected).is_err());
    assert_eq!(fixture.bytes(), before);
    let grant = fixture
        .call("authorize_work_plan", authorization.clone())
        .unwrap();
    let plan_id: ExecutionId = serde_json::from_value(plan["planId"].clone()).unwrap();
    let original_consent = tool_consent(&fixture, plan_id);
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert!(original_consent.expires_at_ms() <= now_ms + 600_000);
    assert!(original_consent.expires_at_ms() < root_expiry * 1000);
    assert_eq!(
        fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap(),
        grant
    );
    assert!(Arc::ptr_eq(
        &original_consent,
        &tool_consent(&fixture, plan_id)
    ));
    // Simulate an in-memory consent acknowledgement not being retained after
    // its persisted human action. Recovery must use that original intent.
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution
                .as_mut()
                .unwrap()
                .work_plans
                .tool_consents
                .remove(&plan_id);
        });
    assert_eq!(
        fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap(),
        grant
    );
    let recovered_consent = tool_consent(&fixture, plan_id);
    assert!(recovered_consent.expires_at_ms() <= original_consent.expires_at_ms());
    let mut altered_replay = authorization.clone();
    altered_replay["toolExecution"] = json!(false);
    assert!(fixture.call("authorize_work_plan", altered_replay).is_err());
    assert!(Arc::ptr_eq(
        &recovered_consent,
        &tool_consent(&fixture, plan_id)
    ));
    assert!(
        fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]})
            )
            .is_err()
    );
    dispatch.send(()).unwrap();
    fixture.call("start_work_plan", json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap();
    fixture.wait_saved(&plan["attemptId"]);
    provider.join().unwrap();
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let proposal = |handle| json!({"scopeId":scope["scopeId"],"tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":handle,"unitIds":[fixture.unit]}});
    let prepare = proposal(handles[0]);
    let count = fixture.attempt_count();
    let before = fixture.bytes();
    let prepared = fixture
        .call("prepare_work_plan_agent_tool", prepare.clone())
        .unwrap();
    assert_eq!(
        fixture
            .call("prepare_work_plan_agent_tool", prepare.clone())
            .unwrap(),
        prepared
    );
    assert_eq!(prepared["scope"], plan["scope"]);
    assert_eq!(prepared["parentTask"], scope["parentTask"]);
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    for ids in [
        json!([]),
        json!([fixture.unit, fixture.unit]),
        json!([ExecutionId::new()]),
    ] {
        let mut rejected = prepare.clone();
        rejected["tool"]["unitIds"] = ids;
        assert!(
            fixture
                .call("prepare_work_plan_agent_tool", rejected)
                .is_err()
        );
    }
    let mut start = prepare.clone();
    start["inputDigest"] = prepared["inputDigest"].clone();
    let mut rejected = start.clone();
    rejected["inputDigest"] = json!("f".repeat(64));
    assert!(
        fixture
            .call("start_work_plan_agent_tool", rejected)
            .is_err()
    );
    let attempt = fixture
        .call("start_work_plan_agent_tool", start.clone())
        .unwrap();
    let output = wait_tool(&fixture, &attempt);
    assert_eq!(
        fixture
            .call("start_work_plan_agent_tool", start.clone())
            .unwrap(),
        attempt
    );
    assert_eq!(output["outcome"], "succeeded");
    assert_eq!(
        output["plugin"]["result"]["context"]["scopeId"],
        if attempt_scope {
            attempt.clone()
        } else {
            output["plugin"]["result"]["context"]["projectId"].clone()
        }
    );
    let actual: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
    let expected_payload = query
        .prepare_payload(
            "Hello",
            &target,
            &selections,
            binding.capability.declaration.limits.max_input_bytes,
        )
        .unwrap();
    let expected_caller = scope["scopeId"].clone();
    let expected_environment = runtime_approval.environment.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let input = store.execution_input(actual).unwrap();
            assert_eq!(input.envelope().operation, "plugin-tool-query");
            assert_eq!(input.envelope().items[0].payload, expected_payload);
            assert_eq!(
                serde_json::to_value(&input.envelope().settings["agent"]["callerId"]).unwrap(),
                expected_caller
            );
            assert_eq!(
                input.envelope().plugin.as_ref().unwrap().environment,
                expected_environment
            );
            assert!(input.envelope().automation.is_some());
            assert_eq!(
                input.envelope().plugin.as_ref().unwrap().component_scope,
                if attempt_scope {
                    tsumugi_plugin_sdk::ComponentScope::Attempt
                } else {
                    tsumugi_plugin_sdk::ComponentScope::Project
                }
            );
            assert_ne!(input.envelope().attempt_id, input.envelope().task_id);
        });
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    assert_eq!(status["toolInvocations"], json!({"reserved":1,"limit":2}));

    let next = proposal(handles[1]);
    let second = fixture
        .call("prepare_work_plan_agent_tool", next.clone())
        .unwrap();
    let mut next_start = next.clone();
    next_start["inputDigest"] = second["inputDigest"].clone();
    let second_attempt = fixture
        .call("start_work_plan_agent_tool", next_start)
        .unwrap();
    wait_tool(&fixture, &second_attempt);
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    assert_eq!(status["toolInvocations"], json!({"reserved":2,"limit":2}));
    let overflow = proposal(handles[0]);
    let preflight = fixture
        .call("prepare_work_plan_agent_tool", overflow.clone())
        .unwrap();
    let mut overflow_start = overflow;
    overflow_start["inputDigest"] = preflight["inputDigest"].clone();
    let count = fixture.attempt_count();
    assert_eq!(
        fixture
            .call("start_work_plan_agent_tool", overflow_start)
            .unwrap_err()["code"],
        "limit-exceeded"
    );
    assert_eq!(fixture.attempt_count(), count);

    let paused = fixture.call("control_work_plan", json!({"planId":plan["planId"],"actionId":ExecutionId::new(),"expectedGeneration":grant["lease"]["generation"],"command":"pause","confirmed":false,"checkerExecutions":[],"toolExecution":false,"expiresAt":null})).unwrap();
    assert!(
        fixture
            .call("prepare_work_plan_agent_tool", prepare.clone())
            .is_err()
    );
    assert!(
        fixture
            .call("start_work_plan_agent_tool", start.clone())
            .is_err()
    );
    let mut continued = json!({"planId":plan["planId"],"actionId":ExecutionId::new(),"expectedGeneration":paused["lease"]["generation"],"command":"continue","confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":false,"expiresAt":expiry()});
    assert!(
        fixture
            .call("control_work_plan", continued.clone())
            .is_err()
    );
    continued["toolExecution"] = json!(true);
    let resumed = fixture
        .call("control_work_plan", continued.clone())
        .unwrap();
    let resumed_consent = tool_consent(&fixture, plan_id);
    assert_eq!(
        fixture
            .call("control_work_plan", continued.clone())
            .unwrap(),
        resumed
    );
    assert!(Arc::ptr_eq(
        &resumed_consent,
        &tool_consent(&fixture, plan_id)
    ));
    // Reading the original human action cannot reauthorize its old lease or
    // replace the new generation's separately approved consent.
    assert_eq!(
        fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap(),
        grant
    );
    assert!(Arc::ptr_eq(
        &resumed_consent,
        &tool_consent(&fixture, plan_id)
    ));
    let fresh = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":resumed["lease"]}),
        )
        .unwrap();
    assert_ne!(fresh["scopeId"], scope["scopeId"]);
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    assert_eq!(status["toolInvocations"], json!({"reserved":2,"limit":2}));
    assert!(fixture.call("start_work_plan_agent_tool", start).is_err());
    // An exact historical receipt can be read after reopen, but not recreate consent.
    fixture.reopen();
    assert!(
        fixture
            .call(
                "prepare_work_plan_agent_tool",
                json!({"scopeId":fresh["scopeId"],"tool":next["tool"]})
            )
            .is_err()
    );
    assert_eq!(
        wait_tool(&fixture, &attempt)["plugin"]["authorizationId"],
        output["plugin"]["authorizationId"]
    );
    assert_eq!(
        fixture
            .call(
                "read_work_plan_action",
                json!({"actionId":grant["actionId"]})
            )
            .unwrap(),
        grant
    );
    assert_eq!(
        fixture.call("authorize_work_plan", authorization).unwrap(),
        grant
    );
    assert_eq!(
        fixture.call("control_work_plan", continued).unwrap(),
        resumed
    );
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        let host = sessions
            .active
            .as_ref()
            .unwrap()
            .execution
            .as_ref()
            .unwrap();
        assert!(host.work_plans.tool_consents.is_empty());
        assert!(host.work_plans.tool_intents.is_empty());
    });
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn tool_consent(fixture: &Fixture, plan: ExecutionId) -> Arc<WorkPlanToolConsent> {
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap()
                .work_plans
                .tool_consents
                .get(&plan)
                .unwrap()
                .1
                .clone()
        })
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn wait_tool(fixture: &Fixture, attempt: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let view = fixture
            .call(
                "read_execution_attempt",
                json!({"attemptId":attempt,"offset":0,"limit":100}),
            )
            .unwrap();
        if let Some(id) = view["items"][0]["resultId"].as_str() {
            assert_eq!(view["items"][0]["status"]["adoption"], "unapplied");
            return fixture
                .call(
                    "read_execution_output",
                    json!({"attemptId":attempt,"resultId":id}),
                )
                .unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "actual Tool worker did not finish: {view}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
