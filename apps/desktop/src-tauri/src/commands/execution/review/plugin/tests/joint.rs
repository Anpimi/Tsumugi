//! Real independently installed format and advisory workers through production IPC.
use super::*;
use crate::commands::execution::test_fixtures::{
    OwnedDirectory, approved_runtime, provision_packages, selected_package,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::content::{SourceBundle, SourceReviewBinding, SourceSettings};
use tsumugi_plugin_host::{
    HostLimits, RuntimeApproval, catalog::PackageApproval, core::RunnerProxy,
};
use tsumugi_plugin_sdk as sdk;

type Window = tauri::WebviewWindow<tauri::test::MockRuntime>;

fn call(window: &Window, command: &str, request: Option<Value>) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(
                request.map_or_else(|| json!({}), |request| json!({"request":request})),
            ),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

fn scoped(context: &Value, fields: Value) -> Value {
    let mut request = context.clone();
    request
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    request
}

fn consent(context: &Value, slot: &Value) -> Value {
    scoped(
        context,
        json!({
            "attemptId":slot["attemptId"], "inputDigest":slot["inputDigest"],
            "grantId":ExecutionId::new(), "unsandboxedExecution":true,
            "expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+600_000).to_string()
        }),
    )
}

fn completed_result(window: &Window, context: &Value, attempt: Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = call(
            window,
            "read_execution_attempt",
            Some(scoped(
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

fn assert_no_worker_stages(application: &Path) {
    assert!(
        !application.read_dir().unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("plugin-instance-")),
        "observation/preparation must not start a worker"
    );
}

fn review_phase(phase: &str) {
    eprintln!("joint-review phase={phase}");
}

/// Borrow the same real setup while each test owns a separate temporary project.
struct JointReviewFixture<'a> {
    app: &'a tauri::App<tauri::test::MockRuntime>,
    window: &'a Window,
    application: &'a Path,
    project_path: &'a Path,
    context: &'a Value,
    intent: &'a Value,
    checked: &'a Value,
    unit: &'a Value,
    source_action: &'a Value,
    source_receipt: &'a Value,
    history: &'a Value,
    choice: &'a Value,
    view: &'a Value,
    captured_slots: &'a [Slot],
    format_approval: &'a PackageApproval,
    runtime_approval: &'a RuntimeApproval,
}

fn with_joint_review_fixture(assertions: impl FnOnce(JointReviewFixture<'_>)) {
    with_joint_review_fixture_units(1, assertions);
}

fn with_joint_review_fixture_units(
    unit_count: usize,
    assertions: impl FnOnce(JointReviewFixture<'_>),
) {
    review_phase("setup: independent packages and runtime");
    let temporary = OwnedDirectory(tempfile::tempdir().unwrap());
    let root = temporary.0.path();
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
    let resource_pins = knowledge.text_review_resource_pins("text-review").unwrap();
    let soundness = text_binding
        .declaration
        .rules
        .iter()
        .find(|rule| rule.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
    let runtime = approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let environment_digest = runtime_approval.environment.digest().unwrap();
    provision_packages(
        root,
        &[
            (format, format_approval.clone()),
            (knowledge, knowledge_approval.clone()),
        ],
        &runtime,
        &runtime_approval,
    );
    drop(runtime);

    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    let application = root.join("application");
    state.plugins.configure(application.clone()).unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project_path = root.join("project");
    let project = call(
        &window,
        "create_project",
        Some(json!({
            "destination":project_path, "displayName":"Independent joint Review fixture",
            "sourceLocale":"en", "targetLocales":["zh-CN"]
        })),
    )
    .unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let source_choice = crate::commands::plugins::PluginSourceRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: format_approval.plugin.clone(),
            package_digest: format_approval.package_digest.clone(),
        },
        resource_id: "source-profile".into(),
        environment_digest: environment_digest.clone(),
    };
    let source = state.plugins.capture_source(&source_choice).unwrap();
    assert_eq!(source.binding, source_binding);
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
        component_scope: tsumugi_plugin_sdk::ComponentScope::Project,
        application_scope: None,
        capability: source.binding.checker.clone(),
        profile: Some(source.binding.declaration.profile.clone()),
        environment: source.runtime.environment(),
    };
    let source_text = "👩🏽‍💻 é sound premises";
    let mut raw_source = format!("WEBVTT\n\nCue\n00:01.000 --> 00:02.000\n{source_text}\n\n");
    for index in 1..unit_count {
        raw_source.push_str(&format!(
            "Cue{index}\n00:{:02}.000 --> 00:{:02}.000\nSynthetic independent sample {index}\n\n",
            index * 3,
            index * 3 + 1
        ));
    }
    // Source setup uses the ordinary capture/runtime APIs and an actual Node
    // extractor. The independent proof and adoption use registered IPC below.
    review_phase("setup: real source extraction");
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
                                &tsumugi_core::execution::PluginExecutionBinding {
                                    component_scope: sdk::ComponentScope::Project,
                                    application_scope: None,
                                    capability: (&source.binding.review).checker.clone(),
                                    profile: Some(
                                        (&source.binding.review).declaration.profile.clone(),
                                    ),
                                    environment: (*(&producer.environment)).clone().into(),
                                },
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
                    application_execution: false,
                },
            )
            .unwrap();
        host.runtime.submit(store, &input).unwrap();
        input.envelope().attempt_id
    });
    let source_result = completed_result(&window, &context, json!(source_attempt));
    let preview = call(
        &window,
        "read_source_preview",
        Some(scoped(
            &context,
            json!({"attemptId":source_attempt,"resultId":source_result,"after":0,"limit":10}),
        )),
    )
    .unwrap();
    assert_eq!(preview["rows"][0]["occurrence"]["text"], source_text);
    let mut adoption = scoped(
        &context,
        json!({"attemptId":source_attempt,"resultId":source_result,
        "actionId":ExecutionId::new(),"confirmation":preview["confirmation"]}),
    );
    call(&window, "prepare_source_adoption", Some(adoption.clone())).unwrap();
    assert!(
        call(
            &window,
            "adopt_execution",
            Some(scoped(&context, json!({"actionId":adoption["actionId"]})))
        )
        .is_err(),
        "producer output alone is not independent source proof"
    );
    let source_check = call(&window, "prepare_source_check", Some(scoped(&context, json!({
        "sourceAttemptId":source_attempt,"sourceResultId":source_result,"attemptId":ExecutionId::new(),"source":source_choice
    })))).unwrap();
    let source_check_start = consent(&context, &source_check);
    review_phase("setup: independent source check");
    let checked_source = call(&window, "start_source_check", Some(source_check_start)).unwrap();
    let checked_source_result = completed_result(&window, &context, checked_source.clone());
    call(
        &window,
        "finish_source_check",
        Some(scoped(
            &context,
            json!({"attemptId":checked_source,"resultId":checked_source_result}),
        )),
    )
    .unwrap();
    adoption["actionId"] = json!(ExecutionId::new());
    call(&window, "prepare_source_adoption", Some(adoption.clone())).unwrap();
    let source_action = scoped(&context, json!({"actionId":adoption["actionId"]}));
    review_phase("setup: adopt checked source");
    let source_receipt = call(&window, "adopt_execution", Some(source_action.clone())).unwrap();

    let page = call(
        &window,
        "read_review_page",
        Some(scoped(
            &context,
            json!({"locale":"zh-CN","afterOrdinal":0,"limit":10}),
        )),
    )
    .unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), unit_count);
    let unit = page["rows"][0]["unitId"].clone();
    let target_request = scoped(&context, json!({"unitId":unit,"locale":"zh-CN"}));
    let target = call(&window, "read_review_target", Some(target_request.clone())).unwrap();
    call(&window, "save_translation_revision", Some(scoped(&context, json!({
        "unitId":unit,"locale":"zh-CN","sourceRevisionId":target["sourceRevisionId"],
        "expectedSelectionId":target["selectionId"],"text":"👩🏽‍💻 é 前提","actionId":ExecutionId::new()
    })))).unwrap();
    let target = call(&window, "read_review_target", Some(target_request.clone())).unwrap();
    let list = call(&window, "read_plugin_text_reviews", None).unwrap();
    assert_eq!(
        call(&window, "read_plugin_text_reviews", None).unwrap(),
        list
    );
    let entry = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["package"]["plugin"] == json!(knowledge_approval.plugin)
                && entry["package"]["packageDigest"] == knowledge_approval.package_digest
                && entry["resourceId"] == "text-review"
                && entry["environmentDigest"] == environment_digest
        })
        .unwrap();
    assert_eq!(entry["availability"]["kind"], "ready");
    let view = &entry["availability"]["view"];
    assert_eq!(view["binding"], json!(text_binding));
    assert_eq!(view["resourcePins"], json!(resource_pins));
    assert_eq!(view["binding"]["declaration"]["disposition"], "advisory");
    let choice = json!({"package":entry["package"],"resourceId":entry["resourceId"],"environmentDigest":entry["environmentDigest"]});
    assert_eq!(
        call(&window, "read_plugin_text_review", Some(choice.clone())).unwrap(),
        *view
    );
    let mut selection = choice.clone();
    selection["rules"] = json!([soundness]);
    let intent = scoped(
        &context,
        json!({"unitId":unit,"locale":"zh-CN","expectedBasis":target["basis"],
        "actionId":ExecutionId::new(),"advisoryChecks":[selection]}),
    );
    let review = call(&window, "prepare_review_checks", Some(intent.clone())).unwrap();
    assert_eq!(review["kind"], "plugin");
    assert_eq!(
        call(&window, "prepare_review_checks", Some(intent.clone())).unwrap(),
        review
    );
    let slots = review["view"]["checkers"].as_array().unwrap();
    assert_eq!(slots.len(), 2);
    assert_eq!(slots[0]["plugin"]["kind"], "format");
    assert_eq!(slots[1]["plugin"]["kind"], "advisory-text");
    assert_eq!(slots[1]["plugin"]["plugin"]["rules"], json!([soundness]));
    assert_eq!(
        slots[1]["checker"]["provider"],
        json!(text_binding.checker.provider)
    );
    assert_eq!(
        slots[1]["checker"]["profile"],
        json!(text_binding.declaration.profile)
    );
    assert_ne!(slots[0]["attemptId"], slots[1]["attemptId"]);
    assert_ne!(slots[0]["inputDigest"], slots[1]["inputDigest"]);
    assert_no_worker_stages(&application);
    let captured_slots = state.sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let slots = host.review.preflight.as_ref().unwrap().slots.clone();
        for slot in &slots {
            host.register_plugin(
                slot.environment.clone().runner().unwrap(),
                slot.environment.binding().unwrap(),
            )
            .unwrap();
            assert_eq!(
                host.runtime.submit(store, &slot.input).unwrap_err().code,
                ErrorCode::Unauthorized,
                "read/prepare plus real runner registration cannot authorize a checker"
            );
            assert!(
                store
                    .execution_input(slot.input.envelope().attempt_id)
                    .is_err()
            );
        }
        slots
    });
    let text_input: sdk::TextReviewCheckInput =
        serde_json::from_value(captured_slots[1].input.envelope().items[0].payload.clone())
            .unwrap();
    text_binding.validate_input(&text_input).unwrap();
    assert_eq!(text_input.resources, resource_pins);
    assert_eq!(text_input.selections.len(), 1);
    assert_eq!(text_input.selections[0].source_text, source_text);
    assert_eq!(
        text_input.selections[0].translation_text.as_deref(),
        Some("👩🏽‍💻 é 前提")
    );
    assert_eq!(text_input.requirements.len(), 1);
    assert_eq!(text_input.requirements[0].key.rule, soundness);
    let grants = slots
        .iter()
        .map(|slot| consent(&context, slot))
        .collect::<Vec<_>>();
    assert_ne!(grants[0]["grantId"], grants[1]["grantId"]);
    let start = scoped(&context, json!({"check":intent,"executions":grants}));
    let mut missing = start.clone();
    missing["executions"].as_array_mut().unwrap().pop();
    assert!(call(&window, "run_review_checks", Some(missing)).is_err());
    let mut duplicate = start.clone();
    duplicate["executions"][1]["grantId"] = duplicate["executions"][0]["grantId"].clone();
    assert!(call(&window, "run_review_checks", Some(duplicate)).is_err());
    for index in 0..2 {
        let mut denied = start.clone();
        denied["executions"][index]["unsandboxedExecution"] = json!(false);
        assert_eq!(
            call(&window, "run_review_checks", Some(denied)).unwrap_err()["code"],
            "permission-denied"
        );
        let mut substituted = start.clone();
        substituted["executions"][index]["inputDigest"] = json!("f".repeat(64));
        assert!(call(&window, "run_review_checks", Some(substituted)).is_err());
    }
    assert!(
        call(&window, "read_review_target", Some(target_request.clone())).unwrap()["currentCheck"]
            .is_null()
    );
    assert_no_worker_stages(&application);
    review_phase("setup: granted joint QA");
    let checked = call(&window, "run_review_checks", Some(start.clone())).unwrap();
    assert_eq!(checked["actionId"], intent["actionId"]);
    assert_eq!(checked["outcome"], "completed");
    let run: CheckRun = serde_json::from_value(checked.clone()).unwrap();
    let evidence = run.evidence.as_ref().unwrap();
    assert_eq!(evidence.origins.len(), 2);
    assert_eq!(evidence.advisory_checks.len(), 1);
    assert_eq!(evidence.advisory_checks[0].binding, text_binding);
    assert_eq!(
        evidence.advisory_checks[0].declaration_resource_id,
        "text-review"
    );
    assert_eq!(evidence.advisory_checks[0].resource_pins, resource_pins);
    assert_eq!(evidence.advisory_checks[0].rules, vec![soundness.clone()]);
    assert_eq!(
        evidence.source_binding.declaration,
        source_binding.review.declaration
    );
    assert_ne!(evidence.qa_basis, run.basis);
    let advisory = run
        .rules
        .iter()
        .filter(|rule| !rule.mandatory)
        .collect::<Vec<_>>();
    assert_eq!(
        advisory.len(),
        1,
        "only the explicitly selected concept is QA"
    );
    assert_eq!(advisory[0].key.rule, soundness);
    assert!(
        matches!(&advisory[0].key.implementation, sdk::CheckImplementation::Plugin { provider }
        if provider == &text_binding.checker.provider)
    );
    assert_eq!(advisory[0].status, "findings");
    assert_eq!(advisory[0].findings.len(), 1);
    assert_eq!(advisory[0].findings[0].code, "preferred-term-missing");
    assert_eq!(advisory[0].findings[0].severity, "warning");
    assert!(!advisory[0].findings[0].waivable);
    assert!(
        run.rules
            .iter()
            .filter(|rule| rule.mandatory)
            .all(|rule| rule.status == "passed")
    );
    let selected_requirement = evidence
        .required_checks
        .requirements
        .iter()
        .find(|requirement| requirement.key == advisory[0].key)
        .unwrap();
    assert!(!selected_requirement.mandatory && !selected_requirement.waivable);
    assert_eq!(evidence.required_checks.requirements.len(), run.rules.len());
    assert_eq!(evidence.diagnostics.len(), 1);
    let diagnostic = &evidence.diagnostics[0];
    assert_eq!(diagnostic.key, advisory[0].key);
    // SDK targets retain source-proof operation IDs, separate from Core UUIDs.
    assert_eq!(selected_requirement.targets, vec!["cue-0".to_owned()]);
    assert_eq!(diagnostic.target, "cue-0");
    assert!(selected_requirement.targets.contains(&diagnostic.target));
    assert_ne!(diagnostic.target, run.unit_id.to_string());
    assert_eq!(diagnostic.code, "preferred-term-missing");
    let location = diagnostic.location.as_ref().unwrap();
    assert_eq!(location.range.encoding, sdk::TextEncoding::Utf16);
    assert_eq!(
        serde_json::to_value(location).unwrap()["field"],
        "translation"
    );
    assert_eq!(location.range.start, 0);
    assert_eq!(
        location.range.end,
        "👩🏽‍💻 é 前提".encode_utf16().count() as u32
    );
    assert!(
        diagnostic
            .detail
            .as_ref()
            .is_some_and(|text| !text.is_empty())
    );
    assert!(
        diagnostic
            .suggestion
            .as_ref()
            .is_some_and(|text| !text.is_empty())
    );
    assert_eq!(
        diagnostic.resource_entry.as_ref().unwrap().contribution_id,
        "terminology"
    );
    let mut instances = BTreeSet::new();
    for (index, origin) in evidence.origins.iter().enumerate() {
        assert_eq!(
            origin.input_digest,
            slots[index]["inputDigest"].as_str().unwrap()
        );
        let output = call(
            &window,
            "read_execution_output",
            Some(scoped(
                &context,
                json!({"attemptId":origin.attempt_id,"resultId":origin.result_id}),
            )),
        )
        .unwrap();
        assert_eq!(output["outcome"], "succeeded");
        assert_eq!(
            output["plugin"]["authorizationId"],
            grants[index]["grantId"]
        );
        let channel: sdk::ProviderBinding =
            serde_json::from_value(output["plugin"]["channel"].clone()).unwrap();
        assert_eq!(channel.selection(), origin.checker.provider);
        assert!(channel.activation_generation > 0);
        assert!(instances.insert(channel.instance_id.clone()));
        let attempt = origin.attempt_id;
        let result_id = origin.result_id;
        let ledger_digest = origin.input_digest.clone();
        let result_digest = origin.result_digest.clone();
        assert_eq!(ledger_digest, slots[index]["inputDigest"].as_str().unwrap());
        let invocation = state.sessions.with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let input = store.execution_input(attempt).unwrap();
            let result = store.execution_result(attempt, result_id).unwrap();
            assert_eq!(input.digest(), ledger_digest);
            assert_eq!(result.digest(), result_digest);
            // The process context hashes its encoded payload. The preflight
            // digest binds the complete Core input; preserve both identities.
            input
                .plugin_request(
                    result.envelope().item_id,
                    result.envelope().dispatch_token,
                    &channel,
                )
                .unwrap()
        });
        assert_eq!(
            output["plugin"]["result"]["context"],
            serde_json::to_value(invocation.context).unwrap()
        );
    }
    assert_eq!(
        instances.len(),
        2,
        "independent actual Host activations required"
    );
    assert_eq!(
        call(&window, "run_review_checks", Some(start)).unwrap(),
        checked
    );
    assert_eq!(
        call(&window, "prepare_review_checks", Some(intent.clone())).unwrap(),
        json!({"kind":"recorded","run":checked})
    );
    assert_eq!(
        call(&window, "read_review_target", Some(target_request.clone())).unwrap()["currentCheck"],
        checked
    );
    let history_request = scoped(
        &context,
        json!({"unitId":unit,"locale":"zh-CN","offset":0,"limit":10}),
    );
    let history = call(
        &window,
        "read_review_history",
        Some(history_request.clone()),
    )
    .unwrap();
    assert_eq!(history["checks"], json!([checked]));
    let summary = call(
        &window,
        "read_review_summary_page",
        Some(scoped(
            &context,
            json!({"locale":"zh-CN","query":"","scopeId":null,"afterOrdinal":0,"limit":10}),
        )),
    )
    .unwrap();
    assert_eq!(summary["rows"][0]["currentCheck"]["hasFindings"], true);
    assert_eq!(summary["rows"][0]["currentCheck"]["hasIncomplete"], false);
    assert_eq!(
        call(
            &window,
            "read_review_eligibility",
            Some(scoped(&context, json!({"locales":["zh-CN"]})))
        )
        .unwrap()["ready"],
        false,
        "successful QA does not supply the human approval"
    );
    call(&window, "write_review_decision", Some(scoped(&context, json!({"decision":{
        "projectId":context["projectId"],"unitId":unit,"locale":"zh-CN","expectedBasis":target["basis"],
        "expectedDecisionId":null,"actor":"Synthetic reviewer","kind":"approve","reason":"Checked exact selection","actionId":ExecutionId::new()
    }})))).unwrap();
    let eligibility = call(
        &window,
        "read_review_eligibility",
        Some(scoped(&context, json!({"locales":["zh-CN"]}))),
    )
    .unwrap();
    let locales = eligibility["locales"].as_array().unwrap();
    assert_eq!(locales.len(), 1);
    assert_eq!(locales[0]["checkedUnits"], json!(unit_count));
    let blockers = locales[0]["blockers"].as_array().unwrap();
    assert!(
        blockers.iter().all(|reason| reason["unitId"] != unit),
        "the approved first unit has no blocker from its unadopted editorial warning"
    );
    if unit_count == 1 {
        assert_eq!(
            eligibility["ready"], true,
            "an unadopted editorial warning must not become a mandatory blocker"
        );
    } else {
        assert_eq!(eligibility["ready"], false);
        assert_eq!(locales[0]["ready"], false);
        for row in page["rows"].as_array().unwrap().iter().skip(1) {
            let unit_blockers = blockers
                .iter()
                .filter(|reason| reason["unitId"] == row["unitId"])
                .collect::<Vec<_>>();
            assert_eq!(unit_blockers.len(), 2);
            assert_eq!(
                unit_blockers
                    .iter()
                    .map(|reason| reason["code"].as_str().unwrap())
                    .collect::<BTreeSet<_>>(),
                BTreeSet::from(["qa-missing-or-stale", "translation-missing"]),
                "the remaining fixture units are still untranslated and unchecked"
            );
        }
    }
    assert_eq!(locales[0]["blockerCount"], json!((unit_count - 1) * 2));
    assert_eq!(blockers.len(), (unit_count - 1) * 2);
    assert_eq!(
        call(
            &window,
            "read_terms",
            Some(scoped(
                &context,
                json!({"locale":"zh-CN","afterTermId":null,"limit":10})
            ))
        )
        .unwrap(),
        json!([]),
        "checking an editorial resource must not adopt terminology"
    );

    review_phase("setup: current QA and approval verified");
    assertions(JointReviewFixture {
        app: &app,
        window: &window,
        application: &application,
        project_path: &project_path,
        context: &context,
        intent: &intent,
        checked: &checked,
        unit: &unit,
        source_action: &source_action,
        source_receipt: &source_receipt,
        history: &history,
        choice: &choice,
        view,
        captured_slots: &captured_slots,
        format_approval: &format_approval,
        runtime_approval: &runtime_approval,
    });
    state.plugins.close();
}

/// Reopening checks original receipts and QA without reconstructing authority.
fn reopen_joint_review_fixture(fixture: &JointReviewFixture<'_>) -> (Value, Value) {
    review_phase("reopen: original receipts and current QA");
    let window = fixture.window;
    let context = fixture.context.clone();
    let intent = fixture.intent.clone();
    let checked = fixture.checked.clone();
    let unit = fixture.unit.clone();
    let project_path = fixture.project_path;
    let source_action = fixture.source_action.clone();
    let source_receipt = fixture.source_receipt.clone();
    let history = fixture.history.clone();
    let choice = fixture.choice.clone();
    let view = fixture.view;
    call(&window, "quiesce_execution", Some(context.clone())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while call(&window, "execution_status", Some(context.clone())).unwrap()["active"] == true {
        assert!(
            Instant::now() < deadline,
            "actual checker channels did not drain"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    call(
        &window,
        "close_project",
        Some(json!({"sessionToken":context["sessionToken"]})),
    )
    .unwrap();
    let reopened = call(
        &window,
        "open_project",
        Some(json!({"locator":project_path})),
    )
    .unwrap();
    let reopened_context =
        json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]});
    let mut reopened_intent = intent;
    reopened_intent["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(
            &window,
            "prepare_review_checks",
            Some(reopened_intent.clone())
        )
        .unwrap(),
        json!({"kind":"recorded","run":checked})
    );
    // Replaying a completed action reads its receipt; no fresh execution grant
    // is necessary or reconstructed, even when the request has no executions.
    assert_eq!(
        call(
            &window,
            "run_review_checks",
            Some(scoped(
                &reopened_context,
                json!({"check":reopened_intent,"executions":[]})
            ))
        )
        .unwrap(),
        checked
    );
    assert_eq!(
        call(
            &window,
            "read_execution_receipt",
            Some(scoped(
                &reopened_context,
                json!({"actionId":source_action["actionId"]})
            ))
        )
        .unwrap(),
        source_receipt
    );
    assert_eq!(
        call(
            &window,
            "read_review_history",
            Some(scoped(
                &reopened_context,
                json!({"unitId":unit,"locale":"zh-CN","offset":0,"limit":10})
            ))
        )
        .unwrap()["checks"],
        history["checks"]
    );
    assert_eq!(
        call(
            &window,
            "read_review_target",
            Some(scoped(
                &reopened_context,
                json!({"unitId":unit,"locale":"zh-CN"})
            ))
        )
        .unwrap()["currentCheck"],
        checked
    );
    assert_eq!(
        call(&window, "read_plugin_text_review", Some(choice)).unwrap(),
        *view
    );
    review_phase("reopen: original receipts and current QA verified");
    (reopened_context, reopened_intent)
}

#[test]
fn actual_current_diagnostic_location_ipc_preserves_saved_qa_and_session_scope() {
    with_joint_review_fixture(|fixture| {
        let run: tsumugi_core::CheckRun = serde_json::from_value(fixture.checked.clone()).unwrap();
        let diagnostic = &run.evidence.as_ref().unwrap().diagnostics[0];
        let target_request = scoped(fixture.context, json!({ "unitId": run.unit_id, "locale": run.locale }));
        let before = call(fixture.window, "read_review_target", Some(target_request.clone())).unwrap();
        let location_request = scoped(fixture.context, json!({
            "unitId": run.unit_id, "locale": run.locale, "runId": run.run_id,
            "diagnostic": diagnostic,
        }));
        let resolved: tsumugi_core::ReviewDiagnosticLocation = serde_json::from_value(
            call(fixture.window, "read_review_diagnostic_location", Some(location_request.clone())).unwrap(),
        ).unwrap();
        assert_eq!(resolved.unit_id, run.unit_id);
        assert_eq!(resolved.locale, run.locale);
        assert_eq!(resolved.run_id, run.run_id);
        assert_eq!(resolved.basis, run.basis);
        assert_eq!(resolved.basis_evidence, run.basis_evidence);
        assert_eq!(Some(&resolved.location), diagnostic.location.as_ref());
        assert_eq!(resolved.location.range.encoding, sdk::TextEncoding::Utf16);
        assert_eq!(resolved.location.range.end, 13, "DOM offsets count UTF-16 code units, not UTF-8 bytes or graphemes");
        let mut missing_session = location_request.clone();
        missing_session.as_object_mut().unwrap().remove("sessionToken");
        assert!(call(fixture.window, "read_review_diagnostic_location", Some(missing_session)).is_err());
        let mut wrong_session = location_request.clone();
        wrong_session["sessionToken"] = json!("not-the-active-session");
        assert!(call(fixture.window, "read_review_diagnostic_location", Some(wrong_session)).is_err());
        let mut forged_target = location_request;
        forged_target["diagnostic"]["target"] = json!(run.unit_id);
        assert!(call(fixture.window, "read_review_diagnostic_location", Some(forged_target)).is_err());
        let after = call(fixture.window, "read_review_target", Some(target_request)).unwrap();
        assert_eq!(after, before, "location reads cannot change saved QA or approval");
        assert_eq!(after["currentCheck"], *fixture.checked);
    });
}

#[test]
fn actual_joint_review_ipc_requires_independent_grants_and_preserves_advisory_qa_across_reopen() {
    review_phase("joint: start");
    with_joint_review_fixture(|fixture| {
        let (reopened_context, reopened_intent) = reopen_joint_review_fixture(&fixture);
        let app = fixture.app;
        let state = app.state::<AppState>();
        let window = fixture.window;
        let checked = fixture.checked.clone();
        let application = fixture.application;
        let project_path = fixture.project_path;
        let format_approval = fixture.format_approval;
        let runtime_approval = fixture.runtime_approval;
        let captured_slots = fixture.captured_slots.to_vec();
        review_phase("joint: reopened captures cannot restore authority");
        let plugins = state.plugins.clone();
        let recaptured = captured_slots
            .into_iter()
            .map(|slot| {
                let environment = slot.environment.reopen(&plugins).unwrap();
                (slot.input, environment)
            })
            .collect::<Vec<_>>();
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            for (input, environment) in recaptured {
                let saved = store.execution_input(input.envelope().attempt_id).unwrap();
                assert_eq!(saved.bytes(), input.bytes());
                host.register_plugin(
                    environment.clone().runner().unwrap(),
                    environment.binding().unwrap(),
                )
                .unwrap();
                assert_eq!(
                    host.runtime.submit(store, &saved).unwrap_err().code,
                    ErrorCode::Unauthorized,
                    "reopened captures/history/receipts cannot restore live checker authority"
                );
            }
        });
        assert_no_worker_stages(&application);
        review_phase("joint: currentness and revocation group");
        currentness::rejects_revoked_manual_computation(
            &app,
            &window,
            &reopened_context,
            &reopened_intent,
            &checked,
            &format_approval,
            &runtime_approval,
            &project_path,
        );
        review_phase("joint: currentness and revocation group complete");
        call(
            window,
            "close_project",
            Some(json!({"sessionToken":reopened_context["sessionToken"]})),
        )
        .unwrap();
    });
    review_phase("joint: complete");
}

#[path = "currentness.rs"]
mod currentness;

#[path = "findings.rs"]
mod findings;

#[path = "strategy.rs"]
mod strategy;
