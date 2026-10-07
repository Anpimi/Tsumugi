use super::*;
use crate::commands::plugins::InstalledFixture as Fixture;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_plugin_host::{
    CapturedNativeRuntime, PackageImage,
    catalog::{PackageApproval, PackageOrigin},
};

pub(super) fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}
pub(super) fn scoped(context: &Value, fields: Value) -> Value {
    let mut value = context.clone();
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    value
}
pub(super) fn consent(context: &Value, review: &Value) -> Value {
    scoped(
        context,
        json!({"attemptId":review["attemptId"],"inputDigest":review["inputDigest"],"grantId":ExecutionId::new(),"unsandboxedExecution":true,
        "expiresAtMs":(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+600_000).to_string()}),
    )
}
pub(super) fn completed(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
    attempt: &Value,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = call(
            window,
            "read_execution_attempt",
            scoped(context, json!({"attemptId":attempt,"offset":0,"limit":100})),
        )
        .unwrap();
        let items = detail["items"].as_array().unwrap();
        assert!(!items.is_empty());
        assert!(
            !items.iter().any(|item| matches!(
                item["status"]["execution"].as_str(),
                Some("failed" | "cancelled")
            )),
            "actual worker failed: {detail}"
        );
        if items
            .iter()
            .all(|item| item["status"]["execution"] == "succeeded")
        {
            return detail;
        }
        assert!(
            Instant::now() < deadline,
            "actual worker did not complete: {detail}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn native_review(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
    unit: &Value,
    environment: &Value,
) -> Value {
    let request = scoped(context, json!({"unitId":unit,"locale":"zh-CN"}));
    let target = call(window, "read_review_target", request.clone()).unwrap();
    let intent = scoped(
        context,
        json!({"unitId":unit,"locale":"zh-CN","expectedBasis":target["basis"],"actionId":ExecutionId::new()}),
    );
    let review = call(window, "prepare_review_checks", intent.clone()).unwrap();
    assert_eq!(review["kind"], "plugin");
    assert_eq!(review["view"]["plugin"]["environment"], *environment);
    let qa = call(
        window,
        "run_review_checks",
        scoped(
            context,
            json!({"check":intent,"execution":consent(context, &review["view"])}),
        ),
    )
    .unwrap();
    assert_eq!(qa["outcome"], "completed");
    let current = call(window, "read_review_target", request).unwrap();
    let mut rules = current["currentCheck"]["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| result["rule"].as_str().unwrap())
        .collect::<Vec<_>>();
    rules.sort_unstable();
    assert_eq!(
        rules,
        [
            "plugin:flat-json.placeholders",
            "plugin:flat-json.source-semantics",
            "required-translation",
            "terminology"
        ]
    );
    current
}

#[test]
#[ignore = "requires an explicit independently built macOS arm64 Native catalog package and digest"]
fn actual_native_desktop_source_translation_review_and_build_use_independent_grants_and_proofs() {
    let selected = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_NATIVE_PACKAGE")
            .expect("explicit independent Native package required"),
    );
    let digest = std::env::var("TSUMUGI_TEST_NATIVE_DIGEST")
        .expect("explicit Native package digest required");
    let image = PackageImage::capture_directory(&selected, &digest, || true).unwrap();
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "synthetic-manual-source".into(),
            publisher_id: "synthetic-manual-publisher".into(),
        },
    };
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    let fixture = Fixture::from_image(state.plugins.clone(), image, approval);
    fixture.install();
    fixture.decide(true, vec![]);
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let inventory = call(&window, "read_plugin_inventory", json!({})).unwrap();
    let offer = &inventory["nativeHostOffer"];
    assert_eq!(offer["availability"], "available");
    let host = CapturedNativeRuntime::inspect_current().unwrap();
    assert_eq!(offer["environment"], serde_json::to_value(&host).unwrap());
    let host_digest = host.digest().unwrap();
    assert_eq!(offer["environmentDigest"], host_digest);
    assert_eq!(inventory["runtimes"], json!([]));
    let package = fixture.request().package;
    let source_choice = PluginSourceRequest {
        package: package.clone(),
        resource_id: "source-profile".into(),
        environment_digest: host_digest.clone(),
    };
    assert!(
        call(&window, "read_plugin_source", json!(source_choice)).is_err(),
        "an installation cannot approve the Host"
    );
    let native_approval = json!({"environmentDigest":host_digest,"approved":true,"expectedRevision":inventory["settingsRevision"],"actionId":ExecutionId::new()});
    let approved = call(
        &window,
        "set_plugin_native_host_approval",
        native_approval.clone(),
    )
    .unwrap();
    assert_eq!(
        call(&window, "set_plugin_native_host_approval", native_approval).unwrap(),
        approved
    );
    assert_eq!(
        approved["runtimes"],
        json!([]),
        "Native approval creates no Node installation"
    );
    let environment = call(&window, "read_plugin_source", json!(source_choice)).unwrap();
    assert_eq!(environment["environment"], offer["environment"]);
    let build_choice = crate::commands::plugins::PluginBuildRequest {
        package: package.clone(),
        resource_id: "build-profile".into(),
        environment_digest: host_digest.clone(),
    };
    assert_eq!(
        call(&window, "read_plugin_build", json!(build_choice)).unwrap()["environment"],
        offer["environment"]
    );
    let project_path = fixture.directory.path().join("project");
    let project = call(&window, "create_project", json!({"destination":project_path,"displayName":"Independent Native catalog","sourceLocale":"en-US","targetLocales":["zh-CN"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let source = fixture.directory.path().join("catalog");
    fs::create_dir(&source).unwrap();
    let original = "\u{feff}{\r\n  \"message\": \"Hello {name} 👩🏽‍💻\",\r\n  \"empty\": \"\"\r\n}\r\n";
    fs::write(source.join("source.json"), original).unwrap();
    // Only the native picker selection is injected. Actual capture, IPC,
    // Host, workers, Core checks, proof and persistence remain production paths.
    let selection = ExecutionId::new();
    let selected_choice = source_choice.clone();
    let source_path = source.clone();
    state.sessions.with(move |sessions| {
        let host = sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0;
        host.source.selection = Some((
            selection,
            Arc::new(capture::Selection::authorize(source_path).unwrap()),
        ));
        host.source.plugin.choice = Some((selection, selected_choice));
    });
    let preflight = call(&window, "preflight_plugin_source", scoped(&context, json!({"selectionId":selection,"sourceLanguage":"en-US","attemptId":ExecutionId::new()}))).unwrap();
    assert_eq!(preflight["files"][0]["byteLength"], original.len());
    assert_eq!(preflight["source"]["environment"], offer["environment"]);
    let attempt: ExecutionId = serde_json::from_value(preflight["attemptId"].clone()).unwrap();
    state.sessions.with(move |sessions| {
        assert!(
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .execution_input(attempt)
                .is_err()
        )
    });
    fs::write(source.join("source.json"), "Changed after fixed capture").unwrap();
    let revoked = call(&window, "set_plugin_native_host_approval", json!({"environmentDigest":host_digest,"approved":false,"expectedRevision":approved["settingsRevision"],"actionId":ExecutionId::new()})).unwrap();
    let start = consent(&context, &preflight);
    assert!(
        call(&window, "start_plugin_source", start.clone()).is_err(),
        "a captured review cannot bypass Host revocation"
    );
    call(&window, "set_plugin_native_host_approval", json!({"environmentDigest":host_digest,"approved":true,"expectedRevision":revoked["settingsRevision"],"actionId":ExecutionId::new()})).unwrap();
    let mut denied = start.clone();
    denied["unsandboxedExecution"] = json!(false);
    assert!(call(&window, "start_plugin_source", denied).is_err());
    let mut expired = start.clone();
    expired["expiresAtMs"] = json!("1");
    assert!(call(&window, "start_plugin_source", expired).is_err());
    let started = call(&window, "start_plugin_source", start.clone()).unwrap();
    assert_eq!(
        call(&window, "start_plugin_source", start.clone()).unwrap(),
        started
    );
    let produced = completed(&window, &context, &started);
    let source_result = &produced["items"][0]["resultId"];
    let preview = call(
        &window,
        "read_source_preview",
        scoped(
            &context,
            json!({"attemptId":started,"resultId":source_result,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    assert_eq!(preview["rows"][0]["occurrence"]["text"], "Hello {name} 👩🏽‍💻");
    let adoption = scoped(
        &context,
        json!({"attemptId":started,"resultId":source_result,"actionId":ExecutionId::new(),"confirmation":preview["confirmation"]}),
    );
    call(&window, "prepare_source_adoption", adoption.clone()).unwrap();
    let action = scoped(&context, json!({"actionId":adoption["actionId"]}));
    assert!(
        call(&window, "adopt_execution", action.clone()).is_err(),
        "Native producer output still requires independent proof"
    );
    let check = call(&window, "prepare_source_check", scoped(&context, json!({"sourceAttemptId":started,"sourceResultId":source_result,"attemptId":ExecutionId::new(),"source":source_choice}))).unwrap();
    assert_eq!(check["source"]["environment"], offer["environment"]);
    let check_start = consent(&context, &check);
    let mut borrowed = check_start.clone();
    borrowed["grantId"] = start["grantId"].clone();
    assert!(call(&window, "start_source_check", borrowed).is_err());
    let checked = call(&window, "start_source_check", check_start).unwrap();
    let checked_result = completed(&window, &context, &checked);
    call(
        &window,
        "finish_source_check",
        scoped(
            &context,
            json!({"attemptId":checked,"resultId":checked_result["items"][0]["resultId"]}),
        ),
    )
    .unwrap();
    let receipt = call(&window, "adopt_execution", action.clone()).unwrap();
    assert_eq!(call(&window, "adopt_execution", action).unwrap(), receipt);
    // The public translation declaration supplies the exact current-source
    // scope. Only the existing picker fixture is shared across these IPC flows.
    let translation_choice = crate::commands::plugins::PluginTranslationRequest {
        package,
        resource_id: "translation-profile".into(),
        environment_digest: host_digest.clone(),
    };
    let translation_environment = call(
        &window,
        "read_plugin_translation",
        json!(translation_choice),
    )
    .unwrap();
    assert_eq!(translation_environment["environment"], offer["environment"]);
    let current_source = call(
        &window,
        "read_plugin_translation_source",
        scoped(&context, json!({"targetLocale":"zh-CN"})),
    )
    .unwrap();
    let translated = "你好 {name} 👩🏽‍💻 e\u{301}";
    let translation_raw = format!(
        "\u{feff}{{\r\n  \"\\u006dessage\": \"{translated}\",\r\n  \"empty\": \"\",\r\n  \"ghost\": \"unmatched\"\r\n}}\r\n"
    );
    fs::create_dir(source.join("translations")).unwrap();
    fs::write(source.join("translations/zh-CN.json"), &translation_raw).unwrap();
    let select = scoped(
        &context,
        json!({"translation":translation_choice,"targetLocale":"zh-CN","expectedSourceSnapshotId":current_source["sourceSnapshotId"],"nativeScope":current_source["nativeScopes"][0]}),
    );
    let selection =
        crate::commands::execution::source::plugin_translation::choose_translation_for_test(
            &state,
            source.clone(),
            serde_json::from_value(select).unwrap(),
        );
    let producer = ExecutionId::new();
    let mut capture = scoped(
        &context,
        json!({"selectionId":selection,"fileName":"zh-CN.json","languageConfirmed":false,"attemptId":producer}),
    );
    assert!(call(&window, "preflight_plugin_translation", capture.clone()).is_err());
    capture["languageConfirmed"] = json!(true);
    let translation_review = call(&window, "preflight_plugin_translation", capture).unwrap();
    assert_eq!(
        translation_review["translation"]["environment"],
        offer["environment"]
    );
    fs::remove_file(source.join("translations/zh-CN.json")).unwrap();
    let translation_start = consent(&context, &translation_review);
    let mut refused = translation_start.clone();
    refused["unsandboxedExecution"] = json!(false);
    assert!(call(&window, "start_plugin_translation", refused).is_err());
    assert!(
        call(
            &window,
            "start_translation_check",
            translation_start.clone()
        )
        .is_err()
    );
    assert_eq!(
        call(
            &window,
            "start_plugin_translation",
            translation_start.clone()
        )
        .unwrap(),
        json!(producer)
    );
    assert_eq!(
        call(
            &window,
            "start_plugin_translation",
            translation_start.clone()
        )
        .unwrap(),
        json!(producer)
    );
    let produced = completed(&window, &context, &json!(producer));
    let translation_result = &produced["items"][0]["resultId"];
    let projection = ExecutionId::new();
    let project_translation = scoped(
        &context,
        json!({"translationAttemptId":producer,"translationResultId":translation_result,"attemptId":projection}),
    );
    let incomplete = call(
        &window,
        "prepare_translation_projection",
        project_translation.clone(),
    )
    .unwrap_err();
    assert_eq!(incomplete["reason"], "translation-check-incomplete");
    let checker = ExecutionId::new();
    let check_request = scoped(
        &context,
        json!({"translationAttemptId":producer,"translationResultId":translation_result,"attemptId":checker,"translation":translation_choice}),
    );
    let translation_check =
        call(&window, "prepare_translation_check", check_request.clone()).unwrap();
    assert_eq!(
        translation_check["translation"]["environment"],
        offer["environment"]
    );
    let mut checker_start = consent(&context, &translation_check);
    checker_start["grantId"] = translation_start["grantId"].clone();
    assert!(
        call(&window, "start_translation_check", checker_start.clone()).is_err(),
        "producer consent cannot authorize the independent checker"
    );
    checker_start["grantId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "start_translation_check", checker_start).unwrap(),
        json!(checker)
    );
    let checked_translation = completed(&window, &context, &json!(checker));
    let finish = scoped(
        &context,
        json!({"translationAttemptId":producer,"translationResultId":translation_result,"attemptId":checker,"resultId":checked_translation["items"][0]["resultId"]}),
    );
    assert_eq!(
        call(&window, "finish_translation_check", finish.clone()).unwrap(),
        Value::Null
    );
    assert_eq!(
        call(&window, "finish_translation_check", finish).unwrap(),
        Value::Null
    );
    let projected = call(
        &window,
        "prepare_translation_projection",
        project_translation,
    )
    .unwrap();
    assert_eq!(projected["itemCount"], 3);
    let project_start = scoped(
        &context,
        json!({"attemptId":projection,"inputDigest":projected["inputDigest"]}),
    );
    assert_eq!(
        call(&window, "start_translation_projection", project_start).unwrap(),
        json!(projection)
    );
    completed(&window, &context, &json!(projection));
    let preview = call(
        &window,
        "read_translation_preview",
        scoped(
            &context,
            json!({"attemptId":projection,"after":0,"limit":10,"basis":null}),
        ),
    )
    .unwrap();
    assert_eq!(
        (
            preview["total"].as_u64(),
            preview["unique"].as_u64(),
            preview["unmatched"].as_u64()
        ),
        (Some(3), Some(2), Some(1))
    );
    assert_eq!(preview["rows"][0]["entry"]["text"], translated);
    assert_eq!(preview["rows"][1]["entry"]["text"], "");
    assert!(preview["rows"][2]["unitId"].is_null());
    let mut histories = Vec::new();
    for row in &preview["rows"].as_array().unwrap()[..2] {
        let action = ExecutionId::new();
        let adopt = scoped(
            &context,
            json!({"attemptId":projection,"itemId":row["itemId"],"resultId":row["resultId"],"actionId":action,"confirmation":{"resultDigest":row["resultDigest"],"sourceSnapshotId":preview["currentSourceSnapshotId"],"occurrenceId":row["occurrenceId"],"sourceRevisionId":row["sourceRevisionId"],"targetUnitId":row["unitId"],"expectedSelectionId":row["currentSelection"]["eventId"],"decision":"select-if-empty"}}),
        );
        call(&window, "prepare_translation_adoption", adopt).unwrap();
        let action_request = scoped(&context, json!({"actionId":action}));
        let receipt = call(&window, "adopt_execution", action_request.clone()).unwrap();
        assert_eq!(
            call(&window, "adopt_execution", action_request).unwrap(),
            receipt
        );
        let request = scoped(
            &context,
            json!({"unitId":row["unitId"],"locale":"zh-CN","afterOrdinal":"0","limit":10}),
        );
        let history = call(&window, "read_translation_history", request.clone()).unwrap();
        assert_eq!(history["total"], "1");
        assert_eq!(history["rows"][0]["text"], row["entry"]["text"]);
        histories.push((request, history));
    }
    let captured_raw = translation_raw.clone();
    let expected_environment = offer["environment"].clone();
    state.sessions.with(move |sessions| {
        let input = sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .execution_input(producer)
            .unwrap();
        let (material, _) = tsumugi_core::content::plugin_translation_input(&input).unwrap();
        assert_eq!(material.artifacts[0].utf8, captured_raw);
        assert_eq!(
            serde_json::to_value(&input.envelope().plugin.as_ref().unwrap().environment).unwrap(),
            expected_environment
        );
    });
    // Saving an empty translation is valid history, but Core release policy
    // remains mandatory even when both independent Native domain rules pass.
    let empty_unit = &preview["rows"][1]["unitId"];
    let empty_target = native_review(&window, &context, empty_unit, &offer["environment"]);
    let empty_rules = empty_target["currentCheck"]["rules"].as_array().unwrap();
    let required = empty_rules
        .iter()
        .find(|r| r["rule"] == "required-translation")
        .unwrap();
    assert_eq!(required["status"], "findings");
    assert_eq!(required["findings"].as_array().unwrap().len(), 1);
    assert_eq!(required["findings"][0]["code"], "empty");
    assert!(
        empty_rules
            .iter()
            .filter(|r| r["rule"] != "required-translation")
            .all(|r| r["status"] == "passed")
    );
    let blocked = call(
        &window,
        "read_review_eligibility",
        scoped(&context, json!({"locales":["zh-CN"]})),
    )
    .unwrap();
    assert_eq!(blocked["ready"], false);
    assert!(call(&window, "prepare_plugin_build", scoped(&context, json!({"attemptId":ExecutionId::new(),"build":build_choice,"expectedEligibilityBasis":blocked["basis"],"choices":[{"locale":"zh-CN","outputPaths":["authorized.json"],"configuration":[]}]}))).is_err());
    let corrected_empty = "空值";
    let correction = scoped(
        &context,
        json!({"unitId":empty_unit,"locale":"zh-CN","sourceRevisionId":empty_target["sourceRevisionId"],"expectedSelectionId":empty_target["selectionId"],"text":corrected_empty,"actionId":ExecutionId::new()}),
    );
    let saved = call(&window, "save_translation_revision", correction.clone()).unwrap();
    assert_eq!(
        call(&window, "save_translation_revision", correction).unwrap(),
        saved
    );
    for (request, history) in &mut histories {
        if request["unitId"] == *empty_unit {
            *history = call(&window, "read_translation_history", request.clone()).unwrap();
            assert_eq!(history["total"], "2");
            assert_eq!(history["rows"][0]["text"], "");
            assert_eq!(history["rows"][1]["text"], corrected_empty);
        }
    }
    let page = call(
        &window,
        "read_review_page",
        scoped(
            &context,
            json!({"locale":"zh-CN","afterOrdinal":0,"limit":50}),
        ),
    )
    .unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
    for row in page["rows"].as_array().unwrap() {
        let unit = &row["unitId"];
        let current = native_review(&window, &context, unit, &offer["environment"]);
        assert!(
            current["currentCheck"]["rules"]
                .as_array()
                .unwrap()
                .iter()
                .all(|result| result["status"] == "passed"),
            "Native QA rejected a valid exact placeholder: {current}"
        );
        call(&window, "write_review_decision", scoped(&context, json!({"decision":{"projectId":context["projectId"],"unitId":unit,"locale":"zh-CN","expectedBasis":current["basis"],"expectedDecisionId":null,"actor":"Synthetic reviewer","kind":"approve","reason":"","actionId":ExecutionId::new()}}))).unwrap();
    }
    let eligibility = call(
        &window,
        "read_review_eligibility",
        scoped(&context, json!({"locales":["zh-CN"]})),
    )
    .unwrap();
    assert_eq!(eligibility["ready"], true);
    let build = call(&window, "prepare_plugin_build", scoped(&context, json!({"attemptId":ExecutionId::new(),"build":build_choice,"expectedEligibilityBasis":eligibility["basis"],"choices":[{"locale":"zh-CN","outputPaths":["authorized.json"],"configuration":[]}]}))).unwrap();
    assert_eq!(build["build"]["environment"], offer["environment"]);
    let build_start = consent(&context, &build);
    let built = call(&window, "start_plugin_build", build_start.clone()).unwrap();
    let built_detail = completed(&window, &context, &built);
    let build_result = &built_detail["items"][0]["resultId"];
    let adoption = call(&window, "prepare_execution_adoption", scoped(&context, json!({"attemptId":built,"unitId":built_detail["recovery"]["units"][0]["unitId"],"resultIds":[build_result],"actionId":ExecutionId::new()}))).unwrap();
    let release_action = scoped(&context, json!({"actionId":adoption["actionId"]}));
    assert!(call(&window, "adopt_execution", release_action.clone()).is_err());
    let artifact = call(&window, "prepare_artifact_check", scoped(&context, json!({"buildAttemptId":built,"buildResultId":build_result,"attemptId":ExecutionId::new(),"build":build_choice}))).unwrap();
    let artifact_start = consent(&context, &artifact);
    let mut borrowed = artifact_start.clone();
    borrowed["grantId"] = build_start["grantId"].clone();
    assert!(call(&window, "start_artifact_check", borrowed).is_err());
    let verified = call(&window, "start_artifact_check", artifact_start).unwrap();
    let verified_detail = completed(&window, &context, &verified);
    call(
        &window,
        "finish_artifact_check",
        scoped(
            &context,
            json!({"attemptId":verified,"resultId":verified_detail["items"][0]["resultId"]}),
        ),
    )
    .unwrap();
    let release_receipt = call(&window, "adopt_execution", release_action.clone()).unwrap();
    assert_eq!(
        call(&window, "adopt_execution", release_action).unwrap(),
        release_receipt
    );
    let releases = call(&window, "list_releases", context.clone()).unwrap();
    assert_eq!(releases.as_array().unwrap().len(), 1);
    let release: ExecutionId = serde_json::from_value(releases[0]["releaseId"].clone()).unwrap();
    let expected = format!(
        "\u{feff}{{\n  \"empty\": \"{corrected_empty}\",\n  \"message\": \"{translated}\"\n}}\n"
    )
    .into_bytes();
    let retained = expected.clone();
    state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        let (_, bytes) = store
            .release_artifact_by_path(release, "zh-CN", "authorized.json")
            .unwrap();
        assert_eq!(bytes, retained);
    });
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let reopened_context =
        json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]});
    assert_eq!(
        call(&window, "list_releases", reopened_context.clone()).unwrap(),
        releases
    );
    for (mut request, history) in histories {
        request["sessionToken"] = reopened_context["sessionToken"].clone();
        assert_eq!(
            call(&window, "read_translation_history", request).unwrap(),
            history
        );
    }
    state.sessions.with(move |sessions| {
        let (_, bytes) = sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .release_artifact_by_path(release, "zh-CN", "authorized.json")
            .unwrap();
        assert_eq!(bytes, expected);
    });
    call(
        &window,
        "close_project",
        json!({"sessionToken":reopened_context["sessionToken"]}),
    )
    .unwrap();
    println!(
        "Native desktop source/translation/QA/build/reopen accepted: package={} environment={host_digest}; no installed Node runtime",
        fixture.approval.package_digest
    );
}
