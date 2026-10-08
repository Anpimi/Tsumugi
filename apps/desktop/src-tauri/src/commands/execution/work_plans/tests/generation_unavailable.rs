//! Saved work and ordinary domain operations outlive generation availability.
use super::*;

fn ordinary_consent(preflight: &Value) -> Value {
    json!({
        "attemptId":preflight["attemptId"],"inputDigest":preflight["inputDigest"],
        "grantId":ExecutionId::new(),"unsandboxedExecution":true,
        "expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+600_000).to_string()
    })
}

fn settled(fixture: &Fixture) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while fixture.call("execution_status", json!({})).unwrap()["active"] == true {
        assert!(Instant::now() < deadline, "owned workers did not settle");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn disable(fixture: &Fixture, package: &Value) -> Value {
    let plugins = fixture.app.state::<AppState>().plugins.clone();
    let revision = plugins.environment_settings_revision().unwrap();
    call(
        &fixture.webview,
        "set_plugin_enabled",
        json!({
            "package":package,"enabled":false,"expectedRevision":revision,
            "actionId":ExecutionId::new()
        }),
    )
    .unwrap()
}

fn assert_saved(fixture: &Fixture, attempt: &Value, before: &Value) {
    let after = fixture
        .call("read_ai_translation", json!({"attemptId":attempt}))
        .unwrap();
    for field in ["itemId", "resultId", "output", "savedRevisionId"] {
        assert_eq!(after["rows"][0][field], before["rows"][0][field], "{field}");
    }
    assert_eq!(after["budget"], before["budget"]);
}

fn assert_manual_selection(fixture: &Fixture, target: &Value, saved: &Value, text: &str) -> Value {
    assert_eq!(saved["revision"]["text"], text);
    assert_eq!(saved["revision"]["originKind"], "manual");
    let current = fixture.call("read_review_target", target.clone()).unwrap();
    assert_eq!(current["translationText"], text);
    assert_eq!(current["revisionId"], saved["revision"]["revisionId"]);
    assert_eq!(current["selectionId"], saved["selection"]["eventId"]);
    current
}

#[test]
fn unavailable_generation_preserves_manual_queries_checks_releases_and_reopened_history() {
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
    let soundness = text_binding
        .declaration
        .rules
        .iter()
        .find(|rule| rule.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
    let tool_binding = knowledge.capability_tool("agent-query-tool").unwrap();
    let observer = installation.0.path().join("generation-disposal.txt");
    let generation = generation_package_with_timeout(Some(&observer), 60_000);
    let generation_approval = PackageApproval {
        plugin: generation.manifest().manifest().plugin.clone(),
        package_digest: generation.package_digest().into(),
        origin: PackageOrigin {
            source_id: "synthetic-generation-source".into(),
            publisher_id: "synthetic-generation-publisher".into(),
        },
    };
    let generation_binding = sdk::bind_capability(
        generation.manifest(),
        &generation.manifest().manifest().contributions[0].id,
        generation.package_digest(),
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
            (knowledge, knowledge_approval.clone()),
            (generation, generation_approval.clone()),
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
    let component = json!({"provider":generation_binding.provider,
        "profile":generation_binding.declaration.profiles.first(),"environmentDigest":environment});
    let generation_package = json!({"plugin":generation_approval.plugin,
        "packageDigest":generation_approval.package_digest});
    let format_package = json!({"plugin":format_approval.plugin,
        "packageDigest":format_approval.package_digest});
    let knowledge_package = json!({"plugin":knowledge_approval.plugin,
        "packageDigest":knowledge_approval.package_digest});

    let (config, provider) = local_provider_sequence_with_accept_timeout(
        vec!["👩🏽‍💻 é root candidate", "👩🏽‍💻 é component candidate"],
        None,
        None,
        Duration::from_secs(90),
    );
    let (plan, grant) = fixture.start_candidates(config);
    fixture.wait_saved(&plan["attemptId"]);
    let action = start_component_for_units(&fixture, component.clone(), &grant, &[fixture.unit]);
    let child_id: ExecutionId =
        serde_json::from_value(action.generation["attemptId"].clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let present = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
                host.runtime
                    .input_if_present(store, child_id)
                    .unwrap()
                    .is_some()
            });
        if present {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "component child was not recorded"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let child = fixture.wait_saved(&action.generation["attemptId"]);
    assert_eq!(
        child["rows"][0]["output"]["text"],
        "👩🏽‍💻 é component candidate"
    );
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    settled(&fixture);
    assert_eq!(std::fs::read_to_string(&observer).unwrap(), "disposed");
    let root = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(root["budget"]["dispatched"], 2);
    disable(&fixture, &generation_package);
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let unavailable = call(
        &fixture.webview,
        "read_plugin_generation_component",
        component,
    )
    .unwrap_err();
    assert_eq!(unavailable["code"], "permission-denied");
    assert_eq!(unavailable["reason"], "plugin-disabled");
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    fixture.reopen();
    assert_saved(&fixture, &plan["attemptId"], &root);
    assert_saved(&fixture, &action.generation["attemptId"], &child);

    // Missing credentials fail in the real producer before any HTTP request.
    // This unique absent name never reads or changes the developer's credentials.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let credential_env = format!(
        "TSUMUGI_ABSENT_{}",
        ExecutionId::new().to_string().replace('-', "_")
    );
    assert!(std::env::var_os(&credential_env).is_none());
    let (missing, _) = fixture.start_candidates(AiConfig {
        endpoint: format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        ),
        model: "synthetic-unavailable".into(),
        credential_env,
        max_requests: 1,
        timeout_seconds: 2,
        ..AiConfig::default()
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let failed = loop {
        let view = fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":missing["attemptId"]}),
            )
            .unwrap();
        if view["detail"]["items"][0]["status"]["execution"] == "failed" {
            break view;
        }
        assert!(
            Instant::now() < deadline,
            "credential failure did not settle: {view}"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(
        failed["detail"]["items"][0]["status"]["diagnostic"],
        "ai-credential"
    );
    assert!(failed["rows"][0]["savedRevisionId"].is_null());
    assert_eq!(failed["budget"]["dispatched"], 0);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(listener);
    settled(&fixture);
    assert_saved(&fixture, &plan["attemptId"], &root);
    assert_saved(&fixture, &action.generation["attemptId"], &child);

    let target_request = json!({"unitId":fixture.unit,"locale":"zh-CN"});
    let target = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    let text = "👩🏽‍💻 é 人工可靠性";
    let save = json!({"unitId":fixture.unit,"locale":"zh-CN",
        "sourceRevisionId":target["sourceRevisionId"],"expectedSelectionId":target["selectionId"],
        "text":text,"actionId":ExecutionId::new()});
    let saved = fixture
        .call("save_translation_revision", save.clone())
        .unwrap();
    assert_eq!(
        fixture.call("save_translation_revision", save).unwrap(),
        saved
    );
    let target = assert_manual_selection(&fixture, &target_request, &saved, text);
    let history = fixture
        .call(
            "read_review_history",
            json!({"unitId":fixture.unit,
        "locale":"zh-CN","offset":0,"limit":10}),
        )
        .unwrap();

    // Ordinary manual reference queries have their own grant, no Agent scope,
    // automation lease, model request or authority to adopt reference output.
    let payload = tool_binding
        .declaration
        .query
        .as_ref()
        .unwrap()
        .prepare_payload(
            "👩🏽‍💻 é sound premises",
            "zh-CN",
            &["soundness".into()],
            tool_binding.capability.declaration.limits.max_input_bytes,
        )
        .unwrap();
    let query = fixture.call("prepare_plugin_tool", json!({"attemptId":ExecutionId::new(),
        "tool":{"package":knowledge_package,"resourceId":"agent-query-tool","environmentDigest":environment},
        "payloads":[payload]})).unwrap();
    let query_consent = ordinary_consent(&query);
    let query_attempt = fixture
        .call("start_plugin_tool", query_consent.clone())
        .unwrap();
    let query_result = completed_result(&fixture.webview, &fixture.context, query_attempt.clone());
    let output = fixture
        .call(
            "read_execution_output",
            json!({"attemptId":query_attempt,
        "resultId":query_result}),
        )
        .unwrap();
    assert_eq!(output["outcome"], "succeeded");
    assert_eq!(
        output["plugin"]["authorizationId"],
        query_consent["grantId"]
    );
    let query_output: Value = serde_json::from_str(
        output["plugin"]["result"]["outcome"]["output"]["utf8"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(query_output["basis"]["resource"], payload["resource"]);
    let mut entries = &query_output;
    for part in &tool_binding
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
    assert!(
        !entries.is_empty(),
        "the manual reference query must return its captured concept"
    );
    assert_eq!(entries[0]["preferredTarget"], "可靠性");
    let query_id: ExecutionId = serde_json::from_value(query_attempt.clone()).unwrap();
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
                .execution_input(query_id)
                .unwrap();
            assert!(input.envelope().automation.is_none());
            assert!(input.envelope().settings.get("callerId").is_none());
        });
    assert_eq!(
        fixture
            .call(
                "read_execution_attempt",
                json!({"attemptId":query_attempt,
        "offset":0,"limit":10})
            )
            .unwrap()["items"][0]["status"]["adoption"],
        "unapplied"
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
                "read_review_history",
                json!({"unitId":fixture.unit,
        "locale":"zh-CN","offset":0,"limit":10})
            )
            .unwrap(),
        history
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

    let check = json!({"unitId":fixture.unit,"locale":"zh-CN","expectedBasis":target["basis"],
        "actionId":ExecutionId::new(),"advisoryChecks":[{"package":knowledge_package,
        "resourceId":"text-review","environmentDigest":environment,"rules":[soundness]}]});
    let review = fixture
        .call("prepare_review_checks", check.clone())
        .unwrap();
    assert_eq!(review["kind"], "plugin");
    let checkers = review["view"]["checkers"].as_array().unwrap();
    assert_eq!(checkers.len(), 2);
    let consents: Vec<Value> = checkers
        .iter()
        .map(|checker| request(&fixture.context, ordinary_consent(checker)))
        .collect();
    let checked = fixture
        .call(
            "run_review_checks",
            json!({"check":request(&fixture.context,check),
        "executions":consents}),
        )
        .unwrap();
    assert_eq!(checked["outcome"], "completed");
    let checked_target = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    assert!(
        checked_target["currentCheck"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|rule| matches!(rule["status"].as_str(), Some("passed" | "not-applicable"))),
        "{checked_target}"
    );
    fixture
        .call(
            "write_review_decision",
            json!({"decision":{"projectId":fixture.context["projectId"],
        "unitId":fixture.unit,"locale":"zh-CN","expectedBasis":checked_target["basis"],
        "expectedDecisionId":null,"actor":"Synthetic reviewer","kind":"approve","reason":"",
        "actionId":ExecutionId::new()}}),
        )
        .unwrap();
    let eligibility = fixture
        .call("read_review_eligibility", json!({"locales":["zh-CN"]}))
        .unwrap();
    assert_eq!(eligibility["ready"], true);

    let build_choice = json!({"package":format_package,"resourceId":"build-profile","environmentDigest":environment});
    let choices = json!([{"locale":"zh-CN","outputPaths":["zh-CN.vtt"],"configuration":[]}]);
    let build = fixture
        .call(
            "prepare_plugin_build",
            json!({"attemptId":ExecutionId::new(),
        "build":build_choice,"expectedEligibilityBasis":eligibility["basis"],"choices":choices}),
        )
        .unwrap();
    let built = fixture
        .call("start_plugin_build", ordinary_consent(&build))
        .unwrap();
    let built_result = completed_result(&fixture.webview, &fixture.context, built.clone());
    let detail = fixture
        .call(
            "read_execution_attempt",
            json!({"attemptId":built,"offset":0,"limit":10}),
        )
        .unwrap();
    let adoption = fixture
        .call(
            "prepare_execution_adoption",
            json!({"attemptId":built,
        "unitId":detail["recovery"]["units"][0]["unitId"],"resultIds":[built_result],
        "actionId":ExecutionId::new()}),
        )
        .unwrap();
    let release_action = json!({"actionId":adoption["actionId"]});
    assert!(
        fixture
            .call("adopt_execution", release_action.clone())
            .is_err()
    );
    let artifact = fixture
        .call(
            "prepare_artifact_check",
            json!({"buildAttemptId":built,
        "buildResultId":built_result,"attemptId":ExecutionId::new(),"build":build_choice}),
        )
        .unwrap();
    let checked = fixture
        .call("start_artifact_check", ordinary_consent(&artifact))
        .unwrap();
    let result = completed_result(&fixture.webview, &fixture.context, checked.clone());
    fixture
        .call(
            "finish_artifact_check",
            json!({"attemptId":checked,"resultId":result}),
        )
        .unwrap();
    let receipt = fixture
        .call("adopt_execution", release_action.clone())
        .unwrap();
    assert_eq!(
        fixture.call("adopt_execution", release_action).unwrap(),
        receipt
    );
    let releases = fixture.call("list_releases", json!({})).unwrap();
    assert_eq!(releases.as_array().unwrap().len(), 1);
    let release = releases[0]["releaseId"].clone();
    let target = fixture
        .call("read_review_target", target_request.clone())
        .unwrap();

    settled(&fixture);
    disable(&fixture, &format_package);
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let blocked = fixture
        .call(
            "prepare_plugin_build",
            json!({"attemptId":ExecutionId::new(),
        "build":build_choice,"expectedEligibilityBasis":eligibility["basis"],"choices":choices}),
        )
        .unwrap_err();
    assert_eq!(blocked["code"], "permission-denied");
    assert_eq!(blocked["reason"], "plugin-disabled");
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fixture.attempt_count(), count);
    fixture.reopen();
    assert_eq!(fixture.call("list_releases", json!({})).unwrap(), releases);
    assert_eq!(
        fixture
            .call("read_review_target", target_request.clone())
            .unwrap(),
        target
    );
    assert_saved(&fixture, &plan["attemptId"], &root);
    assert_saved(&fixture, &action.generation["attemptId"], &child);

    // Closing the installed owner withdraws every executable environment.
    // Export reads the stored release; it never resolves or re-runs a builder.
    fixture.app.state::<AppState>().plugins.close();
    let destination = fixture.directory.path().join("delivery-after-close");
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
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
    let export = json!({"releaseId":release,"selectionId":selection,"previewId":preview["previewId"],
        "actionId":ExecutionId::new(),"overwriteConflicts":false});
    let delivered = fixture.call("export_release", export.clone()).unwrap();
    assert_eq!(delivered["state"], "succeeded");
    assert_eq!(fixture.call("export_release", export).unwrap(), delivered);
    assert_eq!(
        std::fs::read(destination.join("zh-CN.vtt")).unwrap(),
        format!("WEBVTT\n\nCue\n00:01.000 --> 00:02.000\n{text}\n\n").into_bytes()
    );
    let saved = fixture
        .call(
            "save_translation_revision",
            json!({"unitId":fixture.unit,"locale":"zh-CN",
        "sourceRevisionId":target["sourceRevisionId"],"expectedSelectionId":target["selectionId"],
        "text":"👩🏽‍💻 é 宿主关闭后人工编辑","actionId":ExecutionId::new()}),
        )
        .unwrap();
    let saved_target =
        assert_manual_selection(&fixture, &target_request, &saved, "👩🏽‍💻 é 宿主关闭后人工编辑");
    settled(&fixture);
    fixture.reopen();
    assert_eq!(
        assert_manual_selection(&fixture, &target_request, &saved, "👩🏽‍💻 é 宿主关闭后人工编辑"),
        saved_target
    );
    assert_eq!(fixture.call("list_releases", json!({})).unwrap(), releases);
    assert_saved(&fixture, &plan["attemptId"], &root);
    assert_saved(&fixture, &action.generation["attemptId"], &child);
    drop(fixture);
    drop(installation);
}
