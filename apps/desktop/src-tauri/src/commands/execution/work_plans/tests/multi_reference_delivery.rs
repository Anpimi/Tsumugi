//! One installed-worker journey from independent references to immutable delivery.
//! MockRuntime supplies the window and destination picker only; package workers,
//! the generation broker, HTTP runner and ProjectStore mutations remain real.
use super::*;

const SOURCE: &str = "👩🏽‍💻 é sound premises";
const ROOT_TEXT: &str = "👩🏽‍💻 é 根候选可靠性";
const CHILD_TEXT: &str = "👩🏽‍💻 é 组件候选前提";
const MERGED_TEXT: &str = "👩🏽‍💻 é 人工合并可靠性与前提";

fn history(fixture: &Fixture) -> Value {
    fixture
        .call(
            "read_translation_history",
            json!({
                "unitId":fixture.unit,"locale":"zh-CN","afterOrdinal":"0","limit":100
            }),
        )
        .unwrap()
}

fn target(fixture: &Fixture) -> Value {
    fixture
        .call(
            "read_review_target",
            json!({"unitId":fixture.unit,"locale":"zh-CN"}),
        )
        .unwrap()
}

fn source(fixture: &Fixture) -> Value {
    let snapshot = fixture.snapshot;
    let unit = fixture.unit;
    let source_revision = fixture.source_revision;
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            assert_eq!(
                store.content_scope().unwrap().current_snapshot,
                Some(snapshot)
            );
            let content = store.source_content(snapshot, 0, 10).unwrap();
            assert_eq!(content.rows.len(), 1);
            assert_eq!(content.rows[0].unit_id, Some(unit));
            assert_eq!(content.rows[0].source_revision_id, Some(source_revision));
            assert_eq!(content.rows[0].occurrence.text, SOURCE);
            json!({"snapshotId":snapshot,"content":content})
        })
}

fn fixed_inputs(fixture: &Fixture, attempts: &[Value]) -> Vec<Vec<u8>> {
    let attempts: Vec<ExecutionId> = attempts
        .iter()
        .map(|attempt| serde_json::from_value(attempt.clone()).unwrap())
        .collect();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            attempts
                .iter()
                .map(|attempt| store.execution_input(*attempt).unwrap().bytes().to_vec())
                .collect()
        })
}

fn assert_candidate(fixture: &Fixture, attempt: &Value, text: &str) -> Value {
    let view = fixture
        .call("read_ai_translation", json!({"attemptId":attempt}))
        .unwrap();
    assert_eq!(view["detail"]["attemptId"], *attempt);
    assert_eq!(view["rows"].as_array().unwrap().len(), 1);
    let row = &view["rows"][0];
    assert_eq!(row["item"]["unitId"], json!(fixture.unit));
    assert_eq!(
        row["item"]["sourceRevisionId"],
        json!(fixture.source_revision)
    );
    assert_eq!(row["item"]["sourceSnapshotId"], json!(fixture.snapshot));
    assert_eq!(row["item"]["sourceText"], SOURCE);
    assert_eq!(row["output"]["text"], text);
    assert!(row["savedRevisionId"].is_string());
    let saved = history(fixture);
    let revision = saved["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|revision| revision["revisionId"] == row["savedRevisionId"])
        .expect("the candidate is an ordinary immutable translation revision");
    assert_eq!(revision["originKind"], "ai");
    assert_eq!(revision["attemptId"], *attempt);
    assert_eq!(revision["resultId"], row["resultId"]);
    assert_eq!(revision["itemId"], row["itemId"]);
    assert_eq!(revision["sourceRevisionId"], json!(fixture.source_revision));
    assert_eq!(revision["sourceSnapshotId"], json!(fixture.snapshot));
    assert_eq!(revision["text"], text);
    view
}

#[test]
fn installed_multi_reference_generation_manual_merge_and_verified_delivery_keep_original_evidence()
{
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
    let text_binding = first.text_review_declaration("text-review").unwrap();
    let soundness = text_binding
        .declaration
        .rules
        .iter()
        .find(|rule| rule.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
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
    let environment = runtime_approval.environment.digest().unwrap();
    provision_packages(
        installation.0.path(),
        &[
            (format, format_approval.clone()),
            (first, first_approval.clone()),
            (second, second_approval.clone()),
            (generation_image, generation_approval),
        ],
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
    let original_source = source(&fixture);
    assert!(history(&fixture)["current"].is_null());
    assert!(target(&fixture)["currentDecision"].is_null());

    // The two explicit option sets differ in both destination and concept.
    // Their expected lexical results come from the independent example data,
    // rather than from another invocation of the same Worker.
    let choices = [
        (
            first_approval.clone(),
            first_binding,
            "zh-CN",
            "soundness",
            "可靠性",
        ),
        (second_approval, second_binding, "ja", "premise", "前提"),
    ];
    let handles = [ExecutionId::new(), ExecutionId::new()];
    let mut selections = Vec::new();
    let mut observations = Vec::new();
    for ((approval, binding, destination, concept, _), handle) in choices.iter().zip(handles) {
        let selector = json!({"package":{"plugin":approval.plugin,"packageDigest":approval.package_digest},
            "resourceId":"agent-query-tool","environmentDigest":environment});
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        let observed = call(&fixture.webview, "read_plugin_tool", selector.clone()).unwrap();
        assert_eq!(observed["binding"], json!(binding));
        assert_eq!(observed["environmentDigest"], environment);
        assert_eq!(
            fixture.bytes(),
            before,
            "observation grants no project mutation"
        );
        assert_eq!(fixture.attempt_count(), count);
        selections.push(
            json!({"handle":handle,"tool":selector,"target":destination,"selections":[concept]}),
        );
        observations.push(observed);
    }
    let requests: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let recorded = requests.clone();
    let (setup, setup_wait) = mpsc::channel();
    let (mut config, provider) = local_provider_responses_at_request(
        2,
        move |ordinal, input| {
            recorded.lock().unwrap().push(input.clone());
            Some(if ordinal == 0 { ROOT_TEXT } else { CHILD_TEXT })
        },
        None,
        Some(setup_wait),
        Duration::from_secs(90),
        Duration::from_secs(3),
    );
    config.max_items = 1;
    config.max_requests = 2;
    config.concurrency = 1;
    config.max_retries = 0;
    config.max_output_tokens = 100;
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let plan = fixture
        .call(
            "prepare_work_plan",
            json!({
                "config":config,"locale":"zh-CN","unitIds":[fixture.unit],
                "options":PlanOptions::default(),"advisoryChecks":[],
                "toolSelection":{"maxInvocations":2,"entries":selections}
            }),
        )
        .unwrap();
    assert_eq!(
        fixture.bytes(),
        before,
        "preparation remains a pure capture"
    );
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(plan["options"]["selectionPolicy"], "candidates-only");
    assert_eq!(plan["preview"]["items"][0]["sourceText"], SOURCE);
    assert_eq!(
        plan["preview"]["items"][0]["sourceRevisionId"],
        json!(fixture.source_revision)
    );
    assert_eq!(
        plan["preview"]["items"][0]["sourceSnapshotId"],
        json!(fixture.snapshot)
    );
    assert_eq!(plan["tools"]["maxInvocations"], 2);
    assert_eq!(plan["tools"]["entries"].as_array().unwrap().len(), 2);
    for (index, selection) in selections.iter().enumerate() {
        let captured = plan["tools"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["handle"] == selection["handle"])
            .unwrap();
        assert_eq!(captured["binding"], observations[index]["binding"]);
        for field in [
            "environment",
            "packageOrigin",
            "runtimeOrigin",
            "settingsRevision",
        ] {
            assert_eq!(captured[field], observations[index][field], "{field}");
        }
        assert_eq!(captured["target"], selection["target"]);
        assert_eq!(captured["selections"], selection["selections"]);
    }
    let authorization = json!({"planId":plan["planId"],"digest":plan["digest"],
        "actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":checker_keys(&plan),
        "toolExecution":true,"effects":["save-candidate","query-tools"],"expiresAt":expiry()});
    let grant = fixture
        .call("authorize_work_plan", authorization.clone())
        .unwrap();
    assert_eq!(
        fixture.attempt_count(),
        count,
        "authorization does not enqueue work"
    );
    setup.send(()).unwrap();
    let starting = json!({"planId":plan["planId"],"actionId":grant["actionId"],
        "expectedGeneration":grant["lease"]["generation"]});
    assert_eq!(
        fixture.call("start_work_plan", starting).unwrap(),
        plan["attemptId"]
    );
    // Start materializes the exact input retained by the authorization receipt.
    fixture.assert_fixed_input(&grant);
    fixture.wait_saved(&plan["attemptId"]);

    let component = json!({"provider":generation_binding.provider,
        "profile":generation_binding.declaration.profiles.first(),"environmentDigest":environment});
    let action = start_component_for_units(&fixture, component, &grant, &[fixture.unit]);
    let outer = json!(action.outer);
    let outer_result = completed_result(&fixture.webview, &fixture.context, outer.clone());
    let component_output = output(&fixture, &outer, &outer_result);
    let component_evidence: tsumugi_core::execution::PluginResultEvidence =
        serde_json::from_value(component_output["plugin"].clone()).unwrap();
    assert_eq!(
        component_evidence.channel.selection(),
        generation_binding.provider
    );
    assert_eq!(
        component_output["plugin"]["authorizationId"],
        action.starting["grantId"]
    );
    let service_receipt: sdk::GenerationServiceReceipt = serde_json::from_str(
        component_output["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    service_receipt.validate().unwrap();
    assert_eq!(
        service_receipt.task_id,
        action.generation["taskId"].as_str().unwrap()
    );
    assert_eq!(
        service_receipt.attempt_id,
        action.generation["attemptId"].as_str().unwrap()
    );
    fixture.wait_saved(&action.generation["attemptId"]);
    let child_id: ExecutionId =
        serde_json::from_value(action.generation["attemptId"].clone()).unwrap();
    let child_input_digest = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .execution_input(child_id)
                .unwrap()
                .digest()
                .to_owned()
        });
    assert_eq!(service_receipt.input_digest, child_input_digest);
    super::super::unavailable::settled(&fixture);
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    let posted = requests.lock().unwrap().clone();
    assert_eq!(
        posted.len(),
        2,
        "one root and one component child, without automatic retry"
    );
    for request in &posted {
        assert_eq!(request["unitId"], json!(fixture.unit));
        assert_eq!(request["sourceText"], SOURCE);
        assert_eq!(request["targetLocale"], "zh-CN");
        assert_eq!(request["terms"], json!([]));
        assert!(
            request["context"].is_null(),
            "reference suggestions are not automatically shared"
        );
    }
    let root = assert_candidate(&fixture, &plan["attemptId"], ROOT_TEXT);
    let child = assert_candidate(&fixture, &action.generation["attemptId"], CHILD_TEXT);
    assert_eq!(root["rows"][0]["automation"]["phase"], "saved");
    assert_eq!(child["rows"][0]["automation"]["phase"], "saved");
    assert_ne!(
        root["rows"][0]["savedRevisionId"],
        child["rows"][0]["savedRevisionId"]
    );
    assert_eq!(child["budget"]["limit"], 2);
    assert_eq!(child["budget"]["dispatched"], 2);
    assert_eq!(child["budget"]["unresolved"], 0);
    assert_eq!(child["budget"]["usageUnknown"], 0);
    assert_eq!(child["budget"]["promptTokens"], "2");
    assert_eq!(child["budget"]["completionTokens"], "2");
    assert!(history(&fixture)["current"].is_null());
    assert!(target(&fixture)["currentDecision"].is_null());
    let scope = action.scope.clone();
    let mut attempts = vec![
        plan["attemptId"].clone(),
        outer.clone(),
        action.generation["attemptId"].clone(),
    ];
    let mut reference_records = Vec::new();
    for (index, (_, binding, destination, concept, preferred)) in choices.iter().enumerate() {
        let payload = binding
            .declaration
            .query
            .as_ref()
            .unwrap()
            .prepare_payload(
                SOURCE,
                destination,
                &[(*concept).into()],
                binding.capability.declaration.limits.max_input_bytes,
            )
            .unwrap();
        let preparing = json!({"scopeId":scope["scopeId"],"tool":{"taskId":ExecutionId::new(),
            "attemptId":ExecutionId::new(),"toolHandle":handles[index],"unitIds":[fixture.unit]}});
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        let prepared = fixture
            .call("prepare_work_plan_agent_tool", preparing.clone())
            .unwrap();
        assert_eq!(fixture.bytes(), before);
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(prepared["toolHandle"], json!(handles[index]));
        let mut starting = preparing;
        starting["inputDigest"] = prepared["inputDigest"].clone();
        let attempt = fixture
            .call("start_work_plan_agent_tool", starting.clone())
            .unwrap();
        let result = completed_result(&fixture.webview, &fixture.context, attempt.clone());
        let reference = output(&fixture, &attempt, &result);
        assert_reference(&reference, binding, &payload, Some(preferred));
        let detail = fixture
            .call(
                "read_execution_attempt",
                json!({"attemptId":attempt,"offset":0,"limit":10}),
            )
            .unwrap();
        assert_eq!(detail["taskId"], prepared["taskId"]);
        assert_eq!(detail["items"][0]["status"]["adoption"], "unapplied");
        let id = serde_json::from_value(attempt.clone()).unwrap();
        let caller = scope["scopeId"].clone();
        let capability = binding.capability.clone();
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
                assert_eq!(input.envelope().settings["callerId"], caller);
                assert_eq!(
                    input.envelope().plugin.as_ref().unwrap().capability,
                    capability
                );
                assert_eq!(input.envelope().items.len(), 1);
                assert_eq!(input.envelope().items[0].payload, payload);
            });
        super::super::unavailable::settled(&fixture);
        let before = fixture.bytes();
        let count = fixture.attempt_count();
        assert_eq!(
            fixture
                .call("start_work_plan_agent_tool", starting)
                .unwrap(),
            attempt
        );
        assert_eq!(
            fixture.bytes(),
            before,
            "same query action does not reserve another invocation"
        );
        assert_eq!(fixture.attempt_count(), count);
        attempts.push(attempt.clone());
        reference_records.push((attempt, result, reference));
    }
    assert_ne!(
        reference_records[0].2["plugin"]["authorizationId"],
        reference_records[1].2["plugin"]["authorizationId"]
    );
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    assert_eq!(status["toolInvocations"], json!({"reserved":2,"limit":2}));
    assert_eq!(
        fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]})
            )
            .unwrap()["budget"],
        child["budget"]
    );
    let exhausted = fixture.call("prepare_work_plan_agent_tool", json!({"scopeId":scope["scopeId"],
        "tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":handles[0],"unitIds":[fixture.unit]}})).unwrap();
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let rejected = fixture.call("start_work_plan_agent_tool", json!({"scopeId":scope["scopeId"],
        "tool":{"taskId":exhausted["taskId"],"attemptId":exhausted["attemptId"],"toolHandle":handles[0],"unitIds":[fixture.unit]},
        "inputDigest":exhausted["inputDigest"]})).unwrap_err();
    assert_eq!(rejected["code"], "limit-exceeded");
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert_eq!(source(&fixture), original_source);
    assert_eq!(history(&fixture)["total"], "2");
    assert!(history(&fixture)["current"].is_null());
    assert!(target(&fixture)["currentDecision"].is_null());
    assert_eq!(
        fixture
            .call(
                "read_terms",
                json!({"locale":"zh-CN","afterTermId":null,"limit":10})
            )
            .unwrap(),
        json!([])
    );
    let mut original_inputs = fixed_inputs(&fixture, &attempts);

    let contributors = json!([
        root["rows"][0]["savedRevisionId"],
        child["rows"][0]["savedRevisionId"]
    ]);
    let comparison_request = json!({"actionId":ExecutionId::new(),"unitId":fixture.unit,
        "locale":"zh-CN","revisionIds":contributors,"blind":false});
    let comparison = fixture
        .call("create_arena_comparison", comparison_request.clone())
        .unwrap();
    assert_eq!(comparison["comparisonId"], comparison_request["actionId"]);
    assert_eq!(
        comparison["sourceRevisionId"],
        json!(fixture.source_revision)
    );
    assert!(comparison["selectionId"].is_null());
    assert!(comparison["selectedRevisionId"].is_null());
    assert_eq!(
        comparison["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["revisionId"].clone())
            .collect::<Vec<_>>(),
        contributors.as_array().unwrap().clone()
    );
    let merge_request = json!({"actionId":ExecutionId::new(),"unitId":fixture.unit,"locale":"zh-CN",
        "sourceRevisionId":fixture.source_revision,"expectedSelectionId":null,"text":MERGED_TEXT,
        "merge":{"contributors":contributors,"expectedBasis":comparison["basis"]}});
    let before = fixture.bytes();
    let mut wrong_contributor = merge_request.clone();
    wrong_contributor["actionId"] = json!(ExecutionId::new());
    wrong_contributor["merge"]["contributors"][1] = json!(ExecutionId::new());
    assert!(fixture.call("save_arena_merge", wrong_contributor).is_err());
    assert_eq!(fixture.bytes(), before);
    let merge_receipt = fixture
        .call("save_arena_merge", merge_request.clone())
        .unwrap();
    assert_eq!(merge_receipt["actionId"], merge_request["actionId"]);
    assert_eq!(merge_receipt["unitId"], json!(fixture.unit));
    assert!(merge_receipt["previousEventId"].is_null());
    let merged_history = history(&fixture);
    assert_eq!(merged_history["current"], merge_receipt);
    assert_eq!(merged_history["currentText"], MERGED_TEXT);
    let merged = merged_history["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["revisionId"] == merge_receipt["revisionId"])
        .unwrap();
    assert_eq!(merged["originKind"], "manual");
    assert_eq!(merged["contributors"], contributors);
    assert_eq!(merged["sourceRevisionId"], json!(fixture.source_revision));
    assert_eq!(merged["sourceSnapshotId"], json!(fixture.snapshot));
    assert!(merged["attemptId"].is_null() && merged["resultId"].is_null());
    let merged_target = target(&fixture);
    assert_eq!(merged_target["selectionId"], merge_receipt["eventId"]);
    assert_eq!(merged_target["revisionId"], merge_receipt["revisionId"]);
    assert!(
        merged_target["currentDecision"].is_null(),
        "manual selection is not approval"
    );
    assert!(merged_target["currentCheck"].is_null());
    let lookup_merge =
        json!({"unitId":fixture.unit,"locale":"zh-CN","actionId":merge_receipt["actionId"]});
    assert_eq!(
        fixture
            .call("read_translation_action", lookup_merge.clone())
            .unwrap(),
        merge_receipt
    );
    let before = fixture.bytes();
    assert_eq!(
        fixture.call("save_arena_merge", merge_request).unwrap(),
        merge_receipt
    );
    assert_eq!(
        fixture.bytes(),
        before,
        "receipt-first replay does not create another revision"
    );

    let first_package =
        json!({"plugin":first_approval.plugin,"packageDigest":first_approval.package_digest});
    let check_request = json!({"unitId":fixture.unit,"locale":"zh-CN","expectedBasis":merged_target["basis"],
        "actionId":ExecutionId::new(),"advisoryChecks":[{"package":first_package,"resourceId":"text-review",
        "environmentDigest":environment,"rules":[soundness]}]});
    let review = fixture
        .call("prepare_review_checks", check_request.clone())
        .unwrap();
    assert_eq!(review["kind"], "plugin");
    let checkers = review["view"]["checkers"].as_array().unwrap();
    assert_eq!(
        checkers.len(),
        2,
        "independent mandatory format and advisory text Workers"
    );
    let executions: Vec<_> = checkers
        .iter()
        .map(|checker| request(&fixture.context, consent(checker)))
        .collect();
    let checked = fixture.call("run_review_checks", json!({"check":request(&fixture.context, check_request.clone()),"executions":executions})).unwrap();
    assert_eq!(checked["outcome"], "completed");
    let qa_attempts: Vec<_> = checkers
        .iter()
        .map(|checker| checker["attemptId"].clone())
        .collect();
    original_inputs.extend(fixed_inputs(&fixture, &qa_attempts));
    attempts.extend(qa_attempts);
    let checked_target = target(&fixture);
    assert_eq!(
        checked_target["currentCheck"]["actionId"],
        check_request["actionId"]
    );
    assert_eq!(
        checked_target["currentCheck"]["basis"],
        checked_target["basis"]
    );
    assert_eq!(
        checked_target["currentCheck"]["basisEvidence"]["revisionId"],
        merge_receipt["revisionId"]
    );
    assert!(
        checked_target["currentCheck"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|rule| matches!(rule["status"].as_str(), Some("passed" | "not-applicable")))
    );
    assert!(checked_target["currentDecision"].is_null());
    let decision_request = json!({"decision":{"projectId":fixture.context["projectId"],"unitId":fixture.unit,
        "locale":"zh-CN","expectedBasis":checked_target["basis"],"expectedDecisionId":null,
        "actor":"Synthetic human reviewer","kind":"approve","reason":"Explicitly reviewed manual merge",
        "actionId":ExecutionId::new()}});
    fixture
        .call("write_review_decision", decision_request.clone())
        .unwrap();
    let approved = target(&fixture);
    assert_eq!(
        approved["currentDecision"]["actionId"],
        decision_request["decision"]["actionId"]
    );
    assert_eq!(
        approved["currentDecision"]["revisionId"],
        merge_receipt["revisionId"]
    );
    assert_eq!(approved["currentDecision"]["kind"], "approve");
    let eligibility = fixture
        .call("read_review_eligibility", json!({"locales":["zh-CN"]}))
        .unwrap();
    assert_eq!(eligibility["ready"], true);

    let format_package =
        json!({"plugin":format_approval.plugin,"packageDigest":format_approval.package_digest});
    let build_choice = json!({"package":format_package,"resourceId":"build-profile","environmentDigest":environment});
    let build = fixture.call("prepare_plugin_build", json!({"attemptId":ExecutionId::new(),"build":build_choice,
        "expectedEligibilityBasis":eligibility["basis"],"choices":[{"locale":"zh-CN","outputPaths":["zh-CN.vtt"],"configuration":[]}]})).unwrap();
    let built = fixture.call("start_plugin_build", consent(&build)).unwrap();
    let build_result = completed_result(&fixture.webview, &fixture.context, built.clone());
    let detail = fixture
        .call(
            "read_execution_attempt",
            json!({"attemptId":built,"offset":0,"limit":10}),
        )
        .unwrap();
    let adoption_request = json!({"attemptId":built,"unitId":detail["recovery"]["units"][0]["unitId"],
        "resultIds":[build_result],"actionId":ExecutionId::new()});
    let adoption = fixture
        .call("prepare_execution_adoption", adoption_request)
        .unwrap();
    let release_action = json!({"actionId":adoption["actionId"]});
    assert!(
        fixture
            .call("adopt_execution", release_action.clone())
            .is_err(),
        "build output and pre-build QA are not artifact proof"
    );
    assert_eq!(fixture.call("list_releases", json!({})).unwrap(), json!([]));
    let artifact = fixture
        .call(
            "prepare_artifact_check",
            json!({"buildAttemptId":built,
        "buildResultId":build_result,"attemptId":ExecutionId::new(),"build":build_choice}),
        )
        .unwrap();
    let checker = fixture
        .call("start_artifact_check", consent(&artifact))
        .unwrap();
    let artifact_result = completed_result(&fixture.webview, &fixture.context, checker.clone());
    fixture
        .call(
            "finish_artifact_check",
            json!({"attemptId":checker,"resultId":artifact_result}),
        )
        .unwrap();
    let release_receipt = fixture
        .call("adopt_execution", release_action.clone())
        .unwrap();
    assert_eq!(release_receipt["actionId"], adoption["actionId"]);
    assert_eq!(release_receipt["attemptId"], built);
    assert_eq!(release_receipt["projectId"], fixture.context["projectId"]);
    assert_eq!(
        fixture
            .call("read_execution_receipt", release_action.clone())
            .unwrap(),
        release_receipt
    );
    let before = fixture.bytes();
    assert_eq!(
        fixture
            .call("adopt_execution", release_action.clone())
            .unwrap(),
        release_receipt
    );
    assert_eq!(fixture.bytes(), before);
    let releases = fixture.call("list_releases", json!({})).unwrap();
    assert_eq!(releases.as_array().unwrap().len(), 1);
    let release = releases[0]["releaseId"].clone();
    assert_eq!(releases[0]["attemptId"], built);
    assert_eq!(releases[0]["sourceSnapshotId"], json!(fixture.snapshot));
    assert_eq!(releases[0]["eligibilityBasis"], eligibility["basis"]);
    assert_eq!(releases[0]["policyVersion"], "balanced-1");
    assert_eq!(releases[0]["exceptions"], json!([]));
    assert_eq!(releases[0]["artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(releases[0]["artifacts"][0]["entryCount"], 1);
    let expected_bytes =
        format!("WEBVTT\n\nCue\n00:01.000 --> 00:02.000\n{MERGED_TEXT}\n\n").into_bytes();
    let release_id = serde_json::from_value(release.clone()).unwrap();
    let (saved_artifact, immutable_bytes) =
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                sessions
                    .active
                    .as_ref()
                    .unwrap()
                    .store
                    .release_artifact_by_path(release_id, "zh-CN", "zh-CN.vtt")
                    .unwrap()
            });
    assert_eq!(
        immutable_bytes, expected_bytes,
        "independent exact WebVTT bytes, including NFD and emoji"
    );
    assert_eq!(
        saved_artifact.sha256,
        releases[0]["artifacts"][0]["sha256"].as_str().unwrap()
    );
    assert_eq!(
        fixed_inputs(&fixture, &attempts),
        original_inputs,
        "later human/QA/build actions preserve original inputs"
    );
    let build_attempts = [built.clone(), checker.clone()];
    original_inputs.extend(fixed_inputs(&fixture, &build_attempts));
    attempts.extend(build_attempts);

    let destination = fixture.directory.path().join("verified-delivery");
    std::fs::create_dir(&destination).unwrap();
    let selection = ExecutionId::new();
    let held = Arc::new(
        crate::commands::execution::source::capture::Selection::authorize(destination.clone())
            .unwrap(),
    );
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution_parts()
                .unwrap()
                .0
                .release
                .select_for_test(selection, held);
        });
    let preview = fixture
        .call(
            "preview_delivery",
            json!({"releaseId":release,"selectionId":selection}),
        )
        .unwrap();
    assert_eq!(preview["releaseId"], release);
    assert_eq!(preview["files"].as_array().unwrap().len(), 1);
    assert_eq!(preview["files"][0]["state"], "absent");
    assert_eq!(preview["files"][0]["expectedSha256"], saved_artifact.sha256);
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
    let export = json!({"releaseId":release,"selectionId":selection,"previewId":preview["previewId"],
        "actionId":ExecutionId::new(),"overwriteConflicts":false});
    let delivery = fixture.call("export_release", export.clone()).unwrap();
    assert_eq!(delivery["state"], "succeeded");
    assert_eq!(delivery["actionId"], export["actionId"]);
    assert_eq!(delivery["releaseId"], release);
    assert_eq!(delivery["overwriteConflicts"], false);
    assert_eq!(fixture.call("export_release", export).unwrap(), delivery);
    assert_eq!(
        std::fs::read(destination.join("zh-CN.vtt")).unwrap(),
        expected_bytes
    );
    assert_eq!(source(&fixture), original_source);
    assert_eq!(target(&fixture), approved);
    super::super::unavailable::settled(&fixture);
    fixture.reopen();
    assert_eq!(source(&fixture), original_source);
    assert_eq!(target(&fixture), approved);
    assert_eq!(history(&fixture), merged_history);
    assert_eq!(fixed_inputs(&fixture, &attempts), original_inputs);
    assert_eq!(
        fixture
            .call("read_translation_action", lookup_merge)
            .unwrap(),
        merge_receipt
    );
    assert_eq!(
        fixture
            .call("read_execution_receipt", release_action)
            .unwrap(),
        release_receipt
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
    assert_eq!(fixture.call("list_releases", json!({})).unwrap(), releases);
    assert_eq!(
        fixture
            .call("list_deliveries", json!({"releaseId":release}))
            .unwrap(),
        json!([delivery])
    );
    let reopened_bytes = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .release_artifact_by_path(release_id, "zh-CN", "zh-CN.vtt")
                .unwrap()
                .1
        });
    assert_eq!(reopened_bytes, expected_bytes);
    assert_eq!(
        std::fs::read(destination.join("zh-CN.vtt")).unwrap(),
        expected_bytes
    );
    for (attempt, result, reference) in reference_records {
        assert_eq!(output(&fixture, &attempt, &result), reference);
        assert_eq!(
            fixture
                .call(
                    "read_execution_attempt",
                    json!({"attemptId":attempt,"offset":0,"limit":10})
                )
                .unwrap()["items"][0]["status"]["adoption"],
            "unapplied"
        );
    }
    for (attempt, text, original) in [
        (&plan["attemptId"], ROOT_TEXT, &root),
        (&action.generation["attemptId"], CHILD_TEXT, &child),
    ] {
        let retained = assert_candidate(&fixture, attempt, text);
        for field in ["itemId", "resultId", "output", "savedRevisionId"] {
            assert_eq!(
                retained["rows"][0][field], original["rows"][0][field],
                "{field}"
            );
        }
        // Candidate-only live effect tracking is session-local. Reopening reads
        // the durable revision without reconstructing executable automation.
        assert!(retained["rows"][0]["automation"].is_null());
        assert_eq!(retained["budget"], child["budget"]);
    }
    assert_eq!(
        requests.lock().unwrap().len(),
        2,
        "reopen and export never call the model"
    );
    fixture.app.state::<AppState>().plugins.close();
    drop(fixture);
    drop(installation);
}
