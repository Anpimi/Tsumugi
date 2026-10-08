//! Actual source, two independent QA workers and tools share one installed owner.
use super::*;
use crate::commands::execution::test_fixtures::{
    OwnedDirectory, approved_runtime, provision_packages, selected_package,
};
use std::{collections::BTreeSet, path::Path, time::UNIX_EPOCH};
use tsumugi_core::{
    application::{AutomaticSelectionBlock, AutomaticSelectionReceipt, SelectionPolicy},
    content::{SourceBundle, SourceReviewBinding, SourceSettings},
};
use tsumugi_plugin_host::{
    HostLimits, RuntimeApproval,
    catalog::{PackageApproval, PackageOrigin},
    core::RunnerProxy,
};

#[path = "generation_unavailable.rs"]
mod unavailable;

fn ipc(window: &MockWebview, command: &str, fields: Option<Value>) -> Result<Value, Value> {
    call(
        window,
        command,
        fields.expect("a scoped source request is required"),
    )
}
fn completed_result(window: &MockWebview, context: &Value, attempt: Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = ipc(
            window,
            "read_execution_attempt",
            Some(request(
                context,
                json!({"attemptId":attempt,"offset":0,"limit":100}),
            )),
        )
        .unwrap();
        let items = detail["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "one captured source/check item required");
        match items[0]["status"]["execution"].as_str().unwrap() {
            "succeeded" => return items[0]["resultId"].clone(),
            "queued" | "dispatched" => {}
            _ => panic!("actual source/check worker did not succeed: {detail}"),
        }
        assert!(
            Instant::now() < deadline,
            "actual source/check worker deadline: {detail}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn declared_fixture(
    application: &Path,
    format_approval: &PackageApproval,
    environment_digest: &str,
    source_binding: &sdk::SourceImportBinding,
) -> Fixture {
    let ProjectFixture {
        directory,
        app,
        webview: window,
        context,
    } = ProjectFixture::create("en");
    let state = app.state::<AppState>();
    state.plugins.configure(application.to_owned()).unwrap();
    let source_choice = crate::commands::plugins::PluginSourceRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: format_approval.plugin.clone(),
            package_digest: format_approval.package_digest.clone(),
        },
        resource_id: "source-profile".into(),
        environment_digest: environment_digest.to_owned(),
    };
    let source = state.plugins.capture_source(&source_choice).unwrap();
    assert_eq!(&source.binding, source_binding);
    let extractor = Arc::new(
        RunnerProxy::new(
            source.package.image().clone(),
            &source.binding.declaration.extractor,
            source.runtime.clone(),
            source.staging_parent.clone(),
            HostLimits::default(),
        )
        .unwrap(),
    );
    let producer = extractor
        .execution_binding(Some(source.binding.declaration.profile.clone()))
        .unwrap();
    let checker = PluginExecutionBinding {
        capability: source.binding.checker.clone(),
        profile: Some(source.binding.declaration.profile.clone()),
        environment: source.runtime.environment(),
    };
    let source_text = "👩🏽‍💻 é sound premises";
    let raw_source = format!("WEBVTT\n\nCue\n00:01.000 --> 00:02.000\n{source_text}\n\n");
    // Source setup uses the ordinary capture/runtime APIs and an actual Node
    // extractor. The independent proof and adoption use registered IPC below.
    let source_attempt = state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let input =
            SourceBundle::capture_declared(&source.binding, vec![raw_source.into_bytes()], "en")
                .unwrap()
                .fixed_plugin_input(
                    store.metadata().unwrap().project_id(),
                    producer.clone(),
                    SourceSettings {
                        revision_policy: source.binding.declaration.revision_policy.clone(),
                        checker: Some(checker),
                        semantic_rules: source.binding.declaration.semantic_rules.clone(),
                        review: Some(
                            SourceReviewBinding::capture(
                                &source.binding.review,
                                &producer.environment,
                            )
                            .unwrap(),
                        ),
                    },
                )
                .unwrap();
        host.register_plugin(extractor, producer).unwrap();
        assert_eq!(
            host.runtime.submit(store, &input).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        host.runtime
            .authorize_plugin(
                store,
                ExecutionId::new(),
                &input,
                (SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    + 600_000) as u64,
                PluginConsent {
                    unsandboxed_execution: true,
                },
            )
            .unwrap();
        host.runtime.submit(store, &input).unwrap();
        input.envelope().attempt_id
    });
    let source_result = completed_result(&window, &context, json!(source_attempt));
    let preview = ipc(
        &window,
        "read_source_preview",
        Some(request(
            &context,
            json!({"attemptId":source_attempt,"resultId":source_result,"after":0,"limit":10}),
        )),
    )
    .unwrap();
    assert_eq!(preview["rows"][0]["occurrence"]["text"], source_text);
    let mut adoption = request(
        &context,
        json!({"attemptId":source_attempt,"resultId":source_result,
        "actionId":ExecutionId::new(),"confirmation":preview["confirmation"]}),
    );
    ipc(&window, "prepare_source_adoption", Some(adoption.clone())).unwrap();
    assert!(
        ipc(
            &window,
            "adopt_execution",
            Some(request(&context, json!({"actionId":adoption["actionId"]})))
        )
        .is_err(),
        "producer output alone is not independent source proof"
    );
    let source_check = ipc(&window, "prepare_source_check", Some(request(&context, json!({
        "sourceAttemptId":source_attempt,"sourceResultId":source_result,"attemptId":ExecutionId::new(),"source":source_choice
    })))).unwrap();
    let source_check_start = request(
        &context,
        json!({
            "attemptId":source_check["attemptId"],"inputDigest":source_check["inputDigest"],
            "grantId":ExecutionId::new(),"unsandboxedExecution":true,
            "expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+600_000).to_string()
        }),
    );
    let checked_source = ipc(&window, "start_source_check", Some(source_check_start)).unwrap();
    let checked_source_result = completed_result(&window, &context, checked_source.clone());
    ipc(
        &window,
        "finish_source_check",
        Some(request(
            &context,
            json!({"attemptId":checked_source,"resultId":checked_source_result}),
        )),
    )
    .unwrap();
    adoption["actionId"] = json!(ExecutionId::new());
    ipc(&window, "prepare_source_adoption", Some(adoption.clone())).unwrap();
    let source_action = request(&context, json!({"actionId":adoption["actionId"]}));
    let _source_receipt = ipc(&window, "adopt_execution", Some(source_action.clone())).unwrap();

    let (unit, source_revision, snapshot) = state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        let rows = store.source_content(snapshot, 0, 10).unwrap().rows;
        assert_eq!(rows.len(), 1);
        (
            rows[0].unit_id.unwrap(),
            rows[0].source_revision_id.unwrap(),
            snapshot,
        )
    });
    drop(state);
    Fixture {
        directory,
        app,
        webview: window,
        context,
        unit,
        source_revision,
        snapshot,
    }
}

fn wait_checked(fixture: &Fixture, attempt: &Value) -> Value {
    let id: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let present = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
                host.runtime.input_if_present(store, id).unwrap().is_some()
            });
        if present {
            let view = fixture
                .call("read_ai_translation", json!({"attemptId":attempt}))
                .unwrap();
            if matches!(
                view["rows"][0]["automation"]["phase"].as_str(),
                Some("selected" | "blocked" | "failed" | "cancelled")
            ) {
                return view;
            }
            assert!(
                Instant::now() < deadline,
                "actual candidate/checkers did not finish: {view}"
            );
        }
        assert!(
            Instant::now() < deadline,
            "actual child was not recorded: {attempt}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_evidence(
    fixture: &Fixture,
    view: &Value,
    keys: &[Value],
    outer_grant: Option<&Value>,
    source: &sdk::SourceImportBinding,
    advisory: &sdk::TextReviewBinding,
    pins: &[sdk::TextReviewResourcePin],
    soundness: &sdk::ContractRef,
) -> AutomaticSelectionReceipt {
    let receipt: AutomaticSelectionReceipt =
        serde_json::from_value(view["rows"][0]["automation"]["receipt"].clone()).unwrap();
    assert_eq!(
        json!(receipt.request.revision_id),
        view["rows"][0]["savedRevisionId"]
    );
    assert_eq!(
        receipt.candidate_basis.revision_id,
        Some(receipt.request.revision_id)
    );
    let evidence = receipt.evidence.as_ref().unwrap();
    assert_eq!(evidence.origins.len(), 2);
    assert_eq!(
        evidence
            .origins
            .iter()
            .map(|o| json!(o.checker))
            .collect::<Vec<_>>(),
        keys
    );
    assert_eq!(
        evidence.source_binding.declaration,
        source.review.declaration
    );
    assert_eq!(evidence.advisory_checks.len(), 1);
    assert_eq!(evidence.advisory_checks[0].binding, *advisory);
    assert_eq!(evidence.advisory_checks[0].resource_pins, pins);
    assert_eq!(evidence.advisory_checks[0].rules, vec![soundness.clone()]);
    let mut attempts = BTreeSet::new();
    let mut grants = BTreeSet::new();
    let mut instances = BTreeSet::new();
    for origin in &evidence.origins {
        assert_eq!(
            origin.outcome,
            tsumugi_core::ReviewInvocationOutcome::Succeeded
        );
        assert!(attempts.insert(origin.attempt_id));
        let output = fixture
            .call(
                "read_execution_output",
                json!({"attemptId":origin.attempt_id,"resultId":origin.result_id}),
            )
            .unwrap();
        assert_eq!(output["outcome"], "succeeded");
        assert!(
            grants.insert(
                output["plugin"]["authorizationId"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            )
        );
        assert!(
            instances.insert(
                output["plugin"]["channel"]["instanceId"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            )
        );
        if let Some(outer_grant) = outer_grant {
            assert_ne!(&output["plugin"]["authorizationId"], outer_grant);
        }
    }
    let durable = receipt.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let evidence = durable.evidence.as_ref().unwrap();
            for origin in &evidence.origins {
                let input = store.execution_input(origin.attempt_id).unwrap();
                let result = store
                    .execution_result(origin.attempt_id, origin.result_id)
                    .unwrap();
                assert_eq!(input.digest(), origin.input_digest);
                assert_eq!(result.digest(), origin.result_digest);
                let envelope = result.envelope();
                assert_eq!(envelope.outcome, ExecutionState::Succeeded);
                let plugin = envelope.plugin.as_ref().unwrap();
                assert_eq!(plugin.channel.selection(), origin.checker.provider);
                assert!(plugin.channel.activation_generation > 0);
                assert_eq!(
                    plugin.result.context,
                    input
                        .plugin_request(envelope.item_id, envelope.dispatch_token, &plugin.channel)
                        .unwrap()
                        .context
                );
                let settings = &input.envelope().settings;
                assert_eq!(settings["actionId"], json!(durable.request.action_id));
                assert_eq!(settings["unitId"], json!(durable.request.unit_id));
                assert_eq!(settings["checkerKey"], json!(origin.checker));
                assert_eq!(settings["qaBasis"], evidence.qa_basis);
                assert_eq!(settings["requiredChecks"], json!(evidence.required_checks));
                assert_eq!(settings["sourceBinding"], json!(evidence.source_binding));
                assert_eq!(settings["advisoryChecks"], json!(evidence.advisory_checks));
            }
        });
    receipt
}

#[test]
fn generation_component_actual_joint_checks_and_tool_consent_preserve_original_selection_and_budgets()
 {
    let installation = OwnedDirectory(tempfile::tempdir().unwrap());
    let (format, format_approval) = selected_package(
        "TSUMUGI_TEST_PLUGIN_PACKAGE",
        "TSUMUGI_TEST_PLUGIN_DIGEST",
        "webvtt",
    );
    let (knowledge, knowledge_approval) = selected_package(
        "TSUMUGI_TEST_KNOWLEDGE_PACKAGE",
        "TSUMUGI_TEST_KNOWLEDGE_DIGEST",
        "philosophy",
    );
    let source_binding = format.source_import("source-profile").unwrap();
    let text_binding = knowledge.text_review_declaration("text-review").unwrap();
    let pins = knowledge.text_review_resource_pins("text-review").unwrap();
    let soundness = text_binding
        .declaration
        .rules
        .iter()
        .find(|r| r.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
    let tool_binding = knowledge.capability_tool("agent-query-tool").unwrap();
    let query = tool_binding.declaration.query.as_ref().unwrap();
    // This package declares its bounded QA deadline before hashing/installation;
    // no running channel, original human deadline or model timeout is renewed.
    let generation_image = generation_package_with_timeout(None, 60_000);
    let generation_approval = PackageApproval {
        plugin: generation_image.manifest().manifest().plugin.clone(),
        package_digest: generation_image.package_digest().into(),
        origin: PackageOrigin {
            source_id: "synthetic-generation-source".into(),
            publisher_id: "synthetic-generation-publisher".into(),
        },
    };
    let generation_binding = sdk::bind_capability(
        generation_image.manifest(),
        &generation_image.manifest().manifest().contributions[0].id,
        generation_image.package_digest(),
    )
    .unwrap();
    let runtime = approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let environment_digest = runtime_approval.environment.digest().unwrap();
    provision_packages(
        installation.0.path(),
        &[
            (format, format_approval.clone()),
            (knowledge.clone(), knowledge_approval.clone()),
            (generation_image, generation_approval),
        ],
        &runtime,
        &runtime_approval,
    );
    drop(runtime);
    let mut fixture = declared_fixture(
        &installation.0.path().join("application"),
        &format_approval,
        &environment_digest,
        &source_binding,
    );
    let component = json!({"provider":generation_binding.provider,"profile":generation_binding.declaration.profiles.first(),"environmentDigest":environment_digest});
    let knowledge_package = json!({"plugin":knowledge_approval.plugin,"packageDigest":knowledge_approval.package_digest});
    let advisory = json!({"package":knowledge_package,"resourceId":"text-review","environmentDigest":environment_digest,"rules":[soundness]});
    let tool_handle = ExecutionId::new();
    let tool_selection = json!({"maxInvocations":1,"entries":[{"handle":tool_handle,"tool":{"package":knowledge_package,"resourceId":"agent-query-tool","environmentDigest":environment_digest},"target":"zh-CN","selections":["soundness"]}]});
    let (setup, setup_wait) = mpsc::channel();
    let (config, provider) = local_provider_sequence_at_request(
        vec!["👩🏽‍💻 é 根可靠性", "👩🏽‍💻 é 前提", "<b>👩🏽‍💻 é 坏格式</b>"],
        None,
        Some(setup_wait),
        Duration::from_secs(90),
        Duration::from_secs(1),
    );
    let mut options = PlanOptions {
        selection_policy: SelectionPolicy::ReplaceCapturedSelection,
        ..Default::default()
    };
    options
        .stages
        .iter_mut()
        .find(|stage| stage.stage == WorkStage::Checks)
        .unwrap()
        .mode = StageMode::Assisted;
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let plan = fixture.call("prepare_work_plan", json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit],"options":options,"advisoryChecks":[advisory],"toolSelection":tool_selection})).unwrap();
    let keys = checker_keys(&plan);
    assert_eq!(keys.len(), 2);
    assert_eq!(plan["tools"]["entries"][0]["binding"], json!(tool_binding));
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    let authorization = json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":keys,"toolExecution":true,"effects":["save-candidate","run-checks","replace-captured-selection","query-tools"],"expiresAt":expiry()});
    for wrong in [
        json!([]),
        json!([keys[0]]),
        json!([keys[1]]),
        json!([keys[0], keys[0]]),
    ] {
        let mut rejected = authorization.clone();
        rejected["actionId"] = json!(ExecutionId::new());
        rejected["checkerExecutions"] = wrong;
        assert!(fixture.call("authorize_work_plan", rejected).is_err());
    }
    let mut rejected = authorization.clone();
    rejected["actionId"] = json!(ExecutionId::new());
    rejected["toolExecution"] = json!(false);
    assert!(fixture.call("authorize_work_plan", rejected).is_err());
    let mut rejected = authorization.clone();
    rejected["actionId"] = json!(ExecutionId::new());
    rejected["effects"] = json!(["save-candidate", "run-checks", "replace-captured-selection"]);
    assert!(fixture.call("authorize_work_plan", rejected).is_err());
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    let grant = fixture
        .call("authorize_work_plan", authorization.clone())
        .unwrap();
    let plan_id: ExecutionId = serde_json::from_value(plan["planId"].clone()).unwrap();
    let plugins = fixture.app.state::<AppState>().plugins.clone();
    let revision = plan["tools"]["entries"][0]["settingsRevision"].clone();
    let original_tool = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let host = sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap();
            let checker = host.work_plans.checker_consents.get(&plan_id).unwrap();
            assert!(Arc::ptr_eq(&checker.plugins, &plugins));
            assert_eq!(json!(checker.settings_revision), revision);
            host.work_plans
                .tool_consents
                .get(&plan_id)
                .unwrap()
                .1
                .clone()
        });
    setup.send(()).unwrap();
    fixture.call("start_work_plan", json!({"planId":plan_id,"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap();
    let root = wait_checked(&fixture, &plan["attemptId"]);
    assert_eq!(root["rows"][0]["automation"]["phase"], "selected", "{root}");
    let root_receipt = assert_evidence(
        &fixture,
        &root,
        &keys,
        None,
        &source_binding,
        &text_binding,
        &pins,
        &soundness,
    );
    assert!(
        root_receipt
            .rules
            .iter()
            .all(|r| matches!(r.status.as_str(), "passed" | "not-applicable"))
    );
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]});
    let outer = ExecutionId::new();
    let preparing = json!({"scopeId":scope["scopeId"],"attemptId":outer,"component":component,"generation":generation});
    let preflight = fixture
        .call("prepare_work_plan_generation_component", preparing.clone())
        .unwrap();
    assert_eq!(
        preflight["component"]["settingsRevision"],
        plan["tools"]["entries"][0]["settingsRevision"]
    );
    let starting = json!({"scopeId":scope["scopeId"],"attemptId":outer,"inputDigest":preflight["inputDigest"],"grantId":ExecutionId::new(),"expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+60_000).to_string(),"unsandboxedExecution":true});
    // Fault injection represents a missing original in-memory consent, not an
    // installation-settings mutation. Restore the same object, expiry and Arc.
    for remove_tool in [false, true] {
        let held = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let plans = &mut sessions
                    .active
                    .as_mut()
                    .unwrap()
                    .execution
                    .as_mut()
                    .unwrap()
                    .work_plans;
                if remove_tool {
                    (None, plans.tool_consents.remove(&plan_id))
                } else {
                    (plans.checker_consents.remove(&plan_id), None)
                }
            });
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        assert_eq!(
            fixture
                .call("prepare_work_plan_generation_component", preparing.clone())
                .unwrap(),
            preflight,
            "the original read-only preflight acknowledgement is not renewed consent"
        );
        let mut fresh = preparing.clone();
        fresh["attemptId"] = json!(ExecutionId::new());
        fresh["generation"]["taskId"] = json!(ExecutionId::new());
        fresh["generation"]["attemptId"] = json!(ExecutionId::new());
        assert!(
            fixture
                .call("prepare_work_plan_generation_component", fresh)
                .is_err()
        );
        assert!(
            fixture
                .call("start_work_plan_generation_component", starting.clone())
                .is_err()
        );
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let plans = &mut sessions
                    .active
                    .as_mut()
                    .unwrap()
                    .execution
                    .as_mut()
                    .unwrap()
                    .work_plans;
                if let Some(checker) = held.0 {
                    plans.checker_consents.insert(plan_id, checker);
                }
                if let Some(tool) = held.1 {
                    plans.tool_consents.insert(plan_id, tool);
                }
            });
    }
    assert_eq!(
        fixture
            .call("start_work_plan_generation_component", starting.clone())
            .unwrap(),
        json!(outer)
    );
    let child = wait_checked(&fixture, &generation["attemptId"]);
    assert_eq!(
        child["rows"][0]["automation"]["phase"], "selected",
        "{child}"
    );
    let selected = assert_evidence(
        &fixture,
        &child,
        &keys,
        Some(&starting["grantId"]),
        &source_binding,
        &text_binding,
        &pins,
        &soundness,
    );
    assert_eq!(json!(selected.request.lease), grant["lease"]);
    let advisory_rule = selected
        .rules
        .iter()
        .find(|r| r.key.rule == soundness)
        .unwrap();
    assert!(!advisory_rule.mandatory);
    assert_eq!(advisory_rule.status, "findings");
    assert_eq!(advisory_rule.findings[0].code, "preferred-term-missing");
    assert_eq!(advisory_rule.findings[0].severity, "warning");
    assert!(!advisory_rule.findings[0].waivable);
    assert!(selected.blocked.is_none());
    let target_request = json!({"unitId":fixture.unit,"locale":"zh-CN"});
    let prior_target = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    assert_eq!(
        prior_target["revisionId"],
        json!(selected.request.revision_id)
    );
    assert_eq!(
        prior_target["selectionId"],
        json!(selected.selection.as_ref().unwrap().event_id)
    );
    assert_eq!(
        prior_target["currentCheck"]["runId"],
        json!(selected.check_run_id.unwrap())
    );
    assert_eq!(prior_target["currentCheck"]["rules"], json!(selected.rules));
    assert_eq!(
        prior_target["currentCheck"]["evidence"],
        json!(selected.evidence)
    );
    assert_eq!(
        prior_target["currentCheck"]["basisEvidence"],
        json!(selected.candidate_basis)
    );
    let prior_history = fixture
        .call(
            "read_review_history",
            json!({"unitId":fixture.unit,"locale":"zh-CN","offset":0,"limit":10}),
        )
        .unwrap();
    assert_eq!(
        prior_history["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["runId"] == json!(selected.check_run_id.unwrap()))
            .unwrap(),
        &prior_target["currentCheck"]
    );
    let bad_action = start_component_for_units(&fixture, component, &grant, &[fixture.unit]);
    let bad = wait_checked(&fixture, &bad_action.generation["attemptId"]);
    assert_eq!(bad["rows"][0]["automation"]["phase"], "blocked", "{bad}");
    let blocked = assert_evidence(
        &fixture,
        &bad,
        &keys,
        Some(&bad_action.starting["grantId"]),
        &source_binding,
        &text_binding,
        &pins,
        &soundness,
    );
    assert_eq!(blocked.blocked, Some(AutomaticSelectionBlock::Checks));
    assert!(blocked.selection.is_none() && blocked.check_run_id.is_none());
    assert!(
        blocked
            .rules
            .iter()
            .any(|r| r.mandatory && r.findings.iter().any(|f| f.code == "invalid-payload"))
    );
    assert_eq!(
        fixture
            .call("read_review_target", target_request.clone())
            .unwrap(),
        prior_target
    );
    assert_eq!(
        fixture
            .call(
                "read_review_history",
                json!({"unitId":fixture.unit,"locale":"zh-CN","offset":0,"limit":10})
            )
            .unwrap(),
        prior_history
    );
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    assert_eq!(bad["budget"]["dispatched"], 3);
    assert_eq!(bad["budget"]["limit"], 3);
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan_id}))
        .unwrap();
    assert_eq!(status["toolInvocations"], json!({"reserved":0,"limit":1}));
    let tool = json!({"scopeId":scope["scopeId"],"tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":tool_handle,"unitIds":[fixture.unit]}});
    let tool_preflight = fixture
        .call("prepare_work_plan_agent_tool", tool.clone())
        .unwrap();
    let mut tool_start = tool.clone();
    tool_start["inputDigest"] = tool_preflight["inputDigest"].clone();
    let tool_attempt = fixture
        .call("start_work_plan_agent_tool", tool_start.clone())
        .unwrap();
    let tool_result = completed_result(&fixture.webview, &fixture.context, tool_attempt.clone());
    let tool_output = fixture
        .call(
            "read_execution_output",
            json!({"attemptId":tool_attempt,"resultId":tool_result}),
        )
        .unwrap();
    assert_eq!(tool_output["outcome"], "succeeded");
    assert_eq!(
        fixture
            .call(
                "read_execution_attempt",
                json!({"attemptId":tool_attempt,"offset":0,"limit":10})
            )
            .unwrap()["items"][0]["status"]["adoption"],
        "unapplied"
    );
    assert_eq!(
        fixture
            .call("read_review_target", target_request.clone())
            .unwrap(),
        prior_target
    );
    assert_eq!(
        fixture
            .call(
                "read_terms",
                json!({"locale":"zh-CN","afterTermId":null,"limit":10})
            )
            .unwrap(),
        json!([])
    );
    assert_eq!(
        fixture
            .call("start_work_plan_agent_tool", tool_start.clone())
            .unwrap(),
        tool_attempt
    );
    let expected_payload = query
        .prepare_payload(
            "👩🏽‍💻 é sound premises",
            "zh-CN",
            &["soundness".into()],
            tool_binding.capability.declaration.limits.max_input_bytes,
        )
        .unwrap();
    let id: ExecutionId = serde_json::from_value(tool_attempt).unwrap();
    let caller = scope["scopeId"].clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let host = sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap();
            assert!(Arc::ptr_eq(
                &original_tool,
                &host.work_plans.tool_consents.get(&plan_id).unwrap().1
            ));
            let input = sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .execution_input(id)
                .unwrap();
            assert_eq!(input.envelope().operation, "plugin-tool-query");
            assert_eq!(input.envelope().items[0].payload, expected_payload);
            assert_eq!(input.envelope().settings["callerId"], caller);
            assert!(input.envelope().automation.is_some());
        });
    assert_eq!(
        fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":bad_action.generation["attemptId"]})
            )
            .unwrap()["budget"],
        bad["budget"]
    );
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan_id}))
        .unwrap();
    assert_eq!(status["toolInvocations"], json!({"reserved":1,"limit":1}));
    let mut overflow = tool;
    overflow["tool"]["taskId"] = json!(ExecutionId::new());
    overflow["tool"]["attemptId"] = json!(ExecutionId::new());
    let overflow_preflight = fixture
        .call("prepare_work_plan_agent_tool", overflow.clone())
        .unwrap();
    overflow["inputDigest"] = overflow_preflight["inputDigest"].clone();
    let count = fixture.attempt_count();
    assert_eq!(
        fixture
            .call("start_work_plan_agent_tool", overflow)
            .unwrap_err()["code"],
        "limit-exceeded"
    );
    assert_eq!(fixture.attempt_count(), count);
    // A terminal, settled original plan can close; reopening only reads the
    // selected/advisory and blocked/mandatory evidence, without renewing consent.
    let deadline = Instant::now() + Duration::from_secs(15);
    while fixture.call("execution_status", json!({})).unwrap()["active"] == true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    fixture.reopen();
    for (attempt, receipt) in [
        (&generation["attemptId"], &selected),
        (&bad_action.generation["attemptId"], &blocked),
    ] {
        let restored = fixture
            .call("read_ai_translation", json!({"attemptId":attempt}))
            .unwrap();
        assert_eq!(restored["rows"][0]["automation"]["receipt"], json!(receipt));
    }
    assert_eq!(
        fixture.call("read_review_target", target_request).unwrap(),
        prior_target
    );
    assert!(
        fixture
            .call("start_work_plan_generation_component", starting)
            .is_err()
    );
    assert!(
        fixture
            .call("start_work_plan_agent_tool", tool_start)
            .is_err()
    );
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan_id}))
        .unwrap();
    assert_eq!(status["toolInvocations"], json!({"reserved":1,"limit":1}));
    drop(fixture);
    drop(installation);
}
