//! Explicit installed knowledge choices through ordinary and scoped Agent IPC.
use super::*;

#[path = "multi_reference_delivery.rs"]
mod multi_reference_delivery;

fn consent(preflight: &Value) -> Value {
    json!({
        "attemptId":preflight["attemptId"],"inputDigest":preflight["inputDigest"],
        "grantId":ExecutionId::new(),"unsandboxedExecution":true,
        "expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+120_000).to_string()
    })
}

fn output(fixture: &Fixture, attempt: &Value, result: &Value) -> Value {
    fixture
        .call(
            "read_execution_output",
            json!({"attemptId":attempt,"resultId":result}),
        )
        .unwrap()
}

fn batch_outputs(fixture: &Fixture, attempt: &Value, items: &[Value]) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = fixture
            .call(
                "read_execution_attempt",
                json!({"attemptId":attempt,"offset":0,"limit":10}),
            )
            .unwrap();
        let rows = detail["items"].as_array().unwrap();
        assert_eq!(rows.len(), items.len());
        for row in rows {
            assert!(
                matches!(
                    row["status"]["execution"].as_str(),
                    Some("queued" | "dispatched" | "succeeded")
                ),
                "{detail}"
            );
            assert_eq!(row["status"]["adoption"], "unapplied");
        }
        if rows
            .iter()
            .all(|row| row["status"]["execution"] == "succeeded")
        {
            return items
                .iter()
                .map(|item| {
                    let row = rows
                        .iter()
                        .find(|row| row["status"]["itemId"] == *item)
                        .expect("original batch item identity");
                    output(fixture, attempt, &row["resultId"])
                })
                .collect();
        }
        assert!(
            Instant::now() < deadline,
            "actual batch query did not settle: {detail}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_reference(
    output: &Value,
    binding: &sdk::CapabilityToolBinding,
    payload: &Value,
    preferred: Option<&str>,
) -> Value {
    assert_eq!(output["outcome"], "succeeded");
    let evidence: tsumugi_core::execution::PluginResultEvidence =
        serde_json::from_value(output["plugin"].clone()).unwrap();
    assert_eq!(evidence.channel.selection(), binding.capability.provider);
    let reference: Value = serde_json::from_str(
        output["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reference["basis"]["resource"], payload["resource"]);
    let mut entries = &reference;
    for part in &binding
        .declaration
        .query
        .as_ref()
        .unwrap()
        .output
        .entries_path
    {
        entries = match part {
            sdk::ToolQueryPathPart::Key(key) => &entries[key],
            sdk::ToolQueryPathPart::Index(index) => &entries[*index as usize],
        };
    }
    let entries = entries.as_array().unwrap();
    match preferred {
        Some(preferred) => {
            assert_eq!(entries.len(), 1, "only the explicitly selected concept");
            assert_eq!(entries[0]["preferredTarget"], preferred);
        }
        None => assert!(
            entries.is_empty(),
            "substring alone is not the declared lexical match"
        ),
    }
    reference
}

#[test]
fn installed_conflicting_knowledge_choices_share_manual_batch_and_agent_queries() {
    // Each order owns a new Store/project. No earlier installation, model,
    // consent or query result can provide this iteration's evidence.
    for reverse in [false, true] {
        shared_knowledge_in_order(reverse);
    }
}

fn shared_knowledge_in_order(reverse: bool) {
    let installation = OwnedDirectory(tempfile::tempdir().unwrap());
    let (format, format_approval) = selected_package(
        "TSUMUGI_TEST_PLUGIN_PACKAGE",
        "TSUMUGI_TEST_PLUGIN_DIGEST",
        "webvtt",
    );
    let (first, first_approval) = selected_package(
        "TSUMUGI_TEST_KNOWLEDGE_PACKAGE",
        "TSUMUGI_TEST_KNOWLEDGE_DIGEST",
        "philosophy",
    );
    let (second, second_approval) = selected_package(
        "TSUMUGI_TEST_SECOND_KNOWLEDGE_PACKAGE",
        "TSUMUGI_TEST_SECOND_KNOWLEDGE_DIGEST",
        "philosophy-alternative",
    );
    let source_binding = format.source_import("source-profile").unwrap();
    let first_binding = first.capability_tool("agent-query-tool").unwrap();
    let second_binding = second.capability_tool("agent-query-tool").unwrap();
    assert_ne!(
        first_binding.capability.provider,
        second_binding.capability.provider
    );
    assert_eq!(
        first_binding.capability.declaration.contract,
        second_binding.capability.declaration.contract
    );
    let runtime = approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let environment = runtime_approval.environment.digest().unwrap();
    let mut packages = vec![
        (first, first_approval.clone()),
        (second, second_approval.clone()),
    ];
    if reverse {
        packages.reverse();
    }
    packages.push((format, format_approval.clone()));
    provision_packages(
        installation.0.path(),
        &packages,
        &runtime,
        &runtime_approval,
    );
    drop(runtime);
    let mut fixture = declared_fixture(
        &installation.0.path().join("application"),
        &format_approval,
        &environment,
        &source_binding,
    );
    let choices = [
        (first_approval, first_binding, "可靠性"),
        (second_approval, second_binding, "健全性"),
    ];
    let source = "👩🏽‍💻 é sound premises";
    let mut selected = Vec::new();
    let mut references = Vec::new();
    let mut manual_history = Vec::new();
    for (approval, binding, preferred) in &choices {
        let tool = json!({"package":{"plugin":approval.plugin,"packageDigest":approval.package_digest},"resourceId":"agent-query-tool","environmentDigest":environment});
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        let observed = call(&fixture.webview, "read_plugin_tool", tool.clone()).unwrap();
        assert_eq!(observed["binding"], json!(binding));
        let query = binding.declaration.query.as_ref().unwrap();
        let payloads: Vec<_> = [source, "👩🏽‍💻 é soundtrack\n"]
            .iter()
            .map(|text| {
                query
                    .prepare_payload(
                        text,
                        "zh-CN",
                        &["soundness".into()],
                        binding.capability.declaration.limits.max_input_bytes,
                    )
                    .unwrap()
            })
            .collect();
        let prepared = fixture
            .call(
                "prepare_plugin_tool",
                json!({"attemptId":ExecutionId::new(),"tool":tool,"payloads":payloads}),
            )
            .unwrap();
        assert_eq!(prepared["tool"], observed);
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        // FixedInput normalizes items by their UUID. Recover each original
        // literal through its exact captured identity, never array position.
        let captured = prepared["items"].as_array().unwrap();
        assert_eq!(captured.len(), payloads.len());
        let items: Vec<_> = payloads
            .iter()
            .map(|payload| {
                let matching: Vec<_> = captured
                    .iter()
                    .filter(|item| item["payload"] == *payload)
                    .collect();
                assert_eq!(matching.len(), 1, "one exact captured item per literal");
                matching[0]["itemId"].clone()
            })
            .collect();
        assert_ne!(items[0], items[1]);
        let start = consent(&prepared);
        let attempt = fixture.call("start_plugin_tool", start.clone()).unwrap();
        let outputs = batch_outputs(&fixture, &attempt, &items);
        for result in &outputs {
            assert_eq!(result["plugin"]["authorizationId"], start["grantId"]);
        }
        references.push(assert_reference(
            &outputs[0],
            binding,
            &payloads[0],
            Some(preferred),
        ));
        assert_reference(&outputs[1], binding, &payloads[1], None);
        let id: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
        let original_payloads = payloads.clone();
        let original_items: Vec<ExecutionId> = items
            .iter()
            .map(|item| serde_json::from_value(item.clone()).unwrap())
            .collect();
        let original_binding = binding.capability.clone();
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let input = sessions
                    .active
                    .as_ref()
                    .unwrap()
                    .store
                    .execution_input(id)
                    .unwrap();
                assert!(input.envelope().automation.is_none());
                assert!(input.envelope().settings.get("callerId").is_none());
                assert!(input.envelope().settings.get("agent").is_none());
                assert_eq!(
                    input.envelope().plugin.as_ref().unwrap().capability,
                    original_binding
                );
                assert_eq!(input.envelope().items.len(), original_payloads.len());
                for (item, payload) in original_items.iter().zip(&original_payloads) {
                    assert_eq!(input.item(*item).unwrap().payload, *payload);
                }
            });
        manual_history.push((attempt, items, outputs));
        selected.push((ExecutionId::new(), tool, payloads[0].clone()));
    }
    assert_ne!(references[0], references[1]);
    let entries: Vec<_> = selected.iter().map(|(handle, tool, _)| json!({"handle":handle,"tool":tool,"target":"zh-CN","selections":["soundness"]})).collect();
    // Package verification precedes dispatch. Start the synthetic provider's
    // accept deadline at the explicit dispatch gate, as in the joint fixture.
    let (setup, setup_wait) = mpsc::channel();
    let (config, provider) = local_provider_sequence_at_request(
        vec!["👩🏽‍💻 é 人工参考未采纳"],
        None,
        Some(setup_wait),
        Duration::from_secs(30),
        Duration::from_secs(3),
    );
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let plan = fixture.call("prepare_work_plan", json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit],"options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":{"maxInvocations":2,"entries":entries}})).unwrap();
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(plan["tools"]["entries"].as_array().unwrap().len(), 2);
    for (i, (_, binding, _)) in choices.iter().enumerate() {
        assert_eq!(plan["tools"]["entries"][i]["binding"], json!(binding));
    }
    let grant = fixture.call("authorize_work_plan", json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":checker_keys(&plan),"toolExecution":true,"effects":["save-candidate","query-tools"],"expiresAt":expiry()})).unwrap();
    setup.send(()).unwrap();
    fixture.call("start_work_plan", json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap();
    let saved = fixture.wait_saved(&plan["attemptId"]);
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    let budget = saved["budget"].clone();
    assert_eq!(budget["dispatched"], 1);
    assert_eq!(budget["limit"], 1);
    let target_request = json!({"unitId":fixture.unit,"locale":"zh-CN"});
    let target = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    let mut agent_history = Vec::new();
    for (i, (handle, _, payload)) in selected.iter().enumerate() {
        let tool = json!({"scopeId":scope["scopeId"],"tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":handle,"unitIds":[fixture.unit]}});
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        let prepared = fixture
            .call("prepare_work_plan_agent_tool", tool.clone())
            .unwrap();
        assert_eq!(prepared["toolHandle"], json!(handle));
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        let mut start = tool;
        start["inputDigest"] = prepared["inputDigest"].clone();
        let attempt = fixture
            .call("start_work_plan_agent_tool", start.clone())
            .unwrap();
        let result = completed_result(&fixture.webview, &fixture.context, attempt.clone());
        let output = output(&fixture, &attempt, &result);
        assert_eq!(
            fixture
                .call(
                    "read_execution_attempt",
                    json!({"attemptId":attempt,"offset":0,"limit":10})
                )
                .unwrap()["items"][0]["status"]["adoption"],
            "unapplied"
        );
        assert!(
            manual_history
                .iter()
                .flat_map(|(_, _, outputs)| outputs)
                .all(|manual| manual["plugin"]["authorizationId"]
                    != output["plugin"]["authorizationId"])
        );
        assert_eq!(
            assert_reference(&output, &choices[i].1, payload, Some(choices[i].2)),
            references[i]
        );
        let id: ExecutionId = serde_json::from_value(attempt.clone()).unwrap();
        let original_payload = payload.clone();
        let original_binding = choices[i].1.capability.clone();
        let caller = scope["scopeId"].clone();
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let input = sessions
                    .active
                    .as_ref()
                    .unwrap()
                    .store
                    .execution_input(id)
                    .unwrap();
                assert!(input.envelope().automation.is_some());
                assert_eq!(input.envelope().settings["agent"]["callerId"], caller);
                assert_eq!(
                    input.envelope().plugin.as_ref().unwrap().capability,
                    original_binding
                );
                assert_eq!(input.envelope().items.len(), 1);
                assert_eq!(input.envelope().items[0].payload, original_payload);
            });
        assert_eq!(
            fixture
                .call("start_work_plan_agent_tool", start.clone())
                .unwrap(),
            attempt
        );
        assert_eq!(
            fixture
                .call("read_work_plan_status", json!({"planId":plan["planId"]}))
                .unwrap()["toolInvocations"],
            json!({"reserved":i+1,"limit":2})
        );
        agent_history.push((attempt, result, output, start));
    }
    let overflow = json!({"scopeId":scope["scopeId"],"tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":selected[0].0,"unitIds":[fixture.unit]}});
    let prepared = fixture
        .call("prepare_work_plan_agent_tool", overflow.clone())
        .unwrap();
    let mut overflow = overflow;
    overflow["inputDigest"] = prepared["inputDigest"].clone();
    let count = fixture.attempt_count();
    assert_eq!(
        fixture
            .call("start_work_plan_agent_tool", overflow)
            .unwrap_err()["code"],
        "limit-exceeded"
    );
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(
        fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]})
            )
            .unwrap()["budget"],
        budget
    );
    assert_eq!(
        fixture
            .call("read_review_target", target_request.clone())
            .unwrap(),
        target
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
    unavailable::settled(&fixture);
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    unavailable::disable(&fixture, &selected[1].1["package"]);
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    let denied = fixture
        .call(
            "prepare_plugin_tool",
            json!({"attemptId":ExecutionId::new(),"tool":selected[1].1,"payloads":[selected[1].2]}),
        )
        .unwrap_err();
    assert_eq!(denied["code"], "permission-denied");
    assert_eq!(denied["reason"], "plugin-disabled");
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    let available = fixture
        .call(
            "prepare_plugin_tool",
            json!({"attemptId":ExecutionId::new(),"tool":selected[0].1,"payloads":[selected[0].2]}),
        )
        .unwrap();
    let started = fixture
        .call("start_plugin_tool", consent(&available))
        .unwrap();
    let result = completed_result(&fixture.webview, &fixture.context, started.clone());
    assert_eq!(
        assert_reference(
            &output(&fixture, &started, &result),
            &choices[0].1,
            &selected[0].2,
            Some(choices[0].2)
        ),
        references[0]
    );
    unavailable::settled(&fixture);
    fixture.reopen();
    for (attempt, items, outputs) in manual_history {
        assert_eq!(batch_outputs(&fixture, &attempt, &items), outputs);
    }
    for (attempt, result, original, start) in agent_history {
        assert_eq!(output(&fixture, &attempt, &result), original);
        assert!(fixture.call("start_work_plan_agent_tool", start).is_err());
    }
    assert_eq!(
        fixture.call("read_review_target", target_request).unwrap(),
        target
    );
    assert_eq!(
        fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]})
            )
            .unwrap()["budget"],
        budget
    );
    assert_eq!(
        fixture
            .call("read_work_plan_status", json!({"planId":plan["planId"]}))
            .unwrap()["toolInvocations"],
        json!({"reserved":2,"limit":2})
    );
}
