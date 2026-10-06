use super::{native::*, *};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tsumugi_plugin_host::{
    CapturedRuntime, PackageImage, RuntimeApproval,
    catalog::{PackageApproval, PackageOrigin},
};

fn wait(state: &AppState, attempt: ExecutionId, count: usize) -> Vec<ExecutionId> {
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let complete = state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.tick(store).unwrap();
            let status = store.execution_attempt(attempt, true).unwrap();
            assert_eq!(status.items.len(), count);
            assert!(
                !status.items.iter().any(|item| matches!(
                    item.execution,
                    ExecutionState::Failed | ExecutionState::Unknown
                )),
                "{status:?}"
            );
            status
                .items
                .iter()
                .all(|item| item.execution == ExecutionState::Succeeded)
                .then(|| {
                    status
                        .items
                        .iter()
                        .map(|item| {
                            store
                                .execution_current_result(attempt, item.item_id)
                                .unwrap()
                                .unwrap()
                        })
                        .collect()
                })
        });
        if let Some(results) = complete {
            return results;
        }
        assert!(
            Instant::now() < deadline,
            "original translation execution remained incomplete"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "requires an explicitly fingerprinted prebuilt SMAPI package and bundled macOS runtime"]
fn translation_execution_ipc_runs_independent_workers_proof_projection_and_adoption() {
    let selected = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
            .expect("explicit prebuilt SMAPI package required"),
    );
    let digest = std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST")
        .expect("independent package fingerprint required");
    let image = PackageImage::capture_directory(&selected, &digest, || true).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("material");
    fs::create_dir_all(directory.join("i18n")).unwrap();
    let raw = "\u{feff}{\"FIRST\":\"译文 👩🏽‍💻 e\u{301}\",\"second\":\"\",\"ghost\":\"unmatched\"}";
    fs::write(directory.join("i18n/zh.json"), raw).unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project_path = temporary.path().join("project");
    let project = call(&window, "create_project", json!({"destination":project_path, "displayName":"Declared translation execution", "sourceLocale":"en", "targetLocales":["zh-CN","ja"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"], "projectId":project["metadata"]["projectId"]});
    let state = app.state::<AppState>();
    // Source establishment is an explicit test-only builtin fixture. Only the
    // independently installed translation producer/checker execute plugin code.
    let source = adopt_source(&state, br#"{"first":"same","second":"same"}"#);
    let approval = PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "manual-local".into(),
            publisher_id: "user-approved".into(),
        },
    };
    let fixture = crate::commands::plugins::InstalledPluginFixture::from_image(
        state.plugins.clone(),
        image,
        approval,
    );
    fixture.install();
    let metadata: crate::runtime_bundle::BundledRuntimeMetadata =
        serde_json::from_str(crate::commands::plugins::runtimes::BUILT_RUNTIME.unwrap()).unwrap();
    let runtime_root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/javascript-runtime");
    let runtime = CapturedRuntime::capture_directories(
        &runtime_root.join("tool"),
        &runtime_root.join("host"),
        &metadata.environment,
        || true,
    )
    .unwrap();
    let runtime_approval = RuntimeApproval {
        environment: metadata.environment,
        origin: crate::runtime_bundle::bundled_origin(),
    };
    fixture.install_runtime(&runtime, &runtime_approval);
    fixture.decide(true, vec![runtime_approval.clone()]);
    drop(runtime);
    let translation = PluginTranslationRequest {
        package: fixture.request().package,
        resource_id: "translation-profile".into(),
        environment_digest: runtime_approval.environment.digest().unwrap(),
    };
    let selection = choose(
        &state,
        directory.clone(),
        PluginTranslationSelectRequest {
            session_token: context["sessionToken"].as_str().unwrap().into(),
            project_id: serde_json::from_value(context["projectId"].clone()).unwrap(),
            translation: translation.clone(),
            target_locale: "zh-CN".into(),
            expected_source_snapshot_id: source.source_snapshot_id,
            native_scope: source.native_scopes[0].clone(),
        },
    );
    let producer = ExecutionId::new();
    let capture = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"selectionId":selection,"fileName":"zh.json","languageConfirmed":true,"attemptId":producer});
    let review = call(&window, "preflight_plugin_translation", capture).unwrap();
    fs::remove_file(directory.join("i18n/zh.json")).unwrap();
    let expiry = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 900_000)
        .to_string();
    let grant = ExecutionId::new();
    let start = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":producer,"inputDigest":review["inputDigest"],"grantId":grant,"expiresAtMs":expiry,"unsandboxedExecution":true});
    let mut denied = start.clone();
    denied["unsandboxedExecution"] = json!(false);
    assert!(call(&window, "start_plugin_translation", denied).is_err());
    assert!(call(&window, "start_translation_check", start.clone()).is_err());
    state.sessions.with(move |sessions| {
        assert!(
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .execution_input(producer)
                .is_err()
        )
    });
    assert_eq!(
        call(&window, "start_plugin_translation", start.clone()).unwrap(),
        json!(producer)
    );
    assert_eq!(
        call(&window, "start_plugin_translation", start.clone()).unwrap(),
        json!(producer)
    );
    let mut altered = start.clone();
    altered["grantId"] = json!(ExecutionId::new());
    assert!(call(&window, "start_plugin_translation", altered).is_err());
    let mut altered = start.clone();
    altered["expiresAtMs"] = json!((expiry.parse::<u64>().unwrap() + 1).to_string());
    assert!(call(&window, "start_plugin_translation", altered).is_err());
    let result = wait(&state, producer, 1)[0];
    state.sessions.with(move |sessions| {
        let input = sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .execution_input(producer)
            .unwrap();
        let (material, _) = content::plugin_translation_input(&input).unwrap();
        assert_eq!(material.artifacts[0].utf8, raw);
        assert_eq!(material.target_language, "zh-CN");
    });
    let projection = ExecutionId::new();
    let project_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"translationAttemptId":producer,"translationResultId":result,"attemptId":projection});
    let incomplete = call(
        &window,
        "prepare_translation_projection",
        project_request.clone(),
    )
    .unwrap_err();
    assert_eq!(incomplete["code"], "dependency-conflict");
    assert_eq!(incomplete["reason"], "translation-check-incomplete");
    // Corruption fixtures are confined to this owned temporary project. A
    // rejected check and a lost qualified proof must not look merely pending.
    let database = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
    state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        for (validation, code, stage) in [
            (
                "invalid",
                ErrorCode::OutputInvalid,
                "translation-check-invalid",
            ),
            (
                "valid",
                ErrorCode::CorruptLedger,
                "semantic-validation-link",
            ),
            ("absent", ErrorCode::CorruptLedger, "result-state"),
        ] {
            database
                .execute(
                    "UPDATE execution_items SET validation=?2 WHERE attempt_id=?1",
                    rusqlite::params![producer.to_string(), validation],
                )
                .unwrap();
            let error = store
                .capture_translation_projection(producer, result)
                .unwrap_err();
            assert_eq!((error.code, error.stage.as_str()), (code, stage));
        }
        database
            .execute(
                "UPDATE execution_items SET validation='pending' WHERE attempt_id=?1",
                [producer.to_string()],
            )
            .unwrap();
    });
    let checker = ExecutionId::new();
    let check_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"translationAttemptId":producer,"translationResultId":result,"attemptId":checker,"translation":translation});
    let checked = call(&window, "prepare_translation_check", check_request.clone()).unwrap();
    assert_eq!(
        call(&window, "prepare_translation_check", check_request.clone()).unwrap(),
        checked
    );
    let mut check_start = start.clone();
    check_start["attemptId"] = json!(checker);
    check_start["inputDigest"] = checked["inputDigest"].clone();
    assert!(
        call(&window, "start_translation_check", check_start.clone()).is_err(),
        "producer grant must not authorize the checker"
    );
    check_start["grantId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "start_translation_check", check_start.clone()).unwrap(),
        json!(checker)
    );
    assert_eq!(
        call(&window, "start_translation_check", check_start.clone()).unwrap(),
        json!(checker)
    );
    let check_result = wait(&state, checker, 1)[0];
    let finish = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"translationAttemptId":producer,"translationResultId":result,"attemptId":checker,"resultId":check_result});
    let mut crossed = finish.clone();
    crossed["translationResultId"] = json!(check_result);
    assert!(call(&window, "finish_translation_check", crossed).is_err());
    // Reconstruct from original ledger bytes, not a retained volatile review.
    state.sessions.with(|sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .source
            .translation
            .check = None
    });
    assert_eq!(
        call(&window, "prepare_translation_check", check_request.clone()).unwrap(),
        checked
    );
    assert_eq!(
        call(&window, "finish_translation_check", finish.clone()).unwrap(),
        Value::Null
    );
    assert_eq!(
        call(&window, "finish_translation_check", finish.clone()).unwrap(),
        Value::Null
    );
    let projected = call(
        &window,
        "prepare_translation_projection",
        project_request.clone(),
    )
    .unwrap();
    assert_eq!(projected["itemCount"], 3);
    assert_eq!(
        call(
            &window,
            "prepare_translation_projection",
            project_request.clone()
        )
        .unwrap(),
        projected
    );
    let project_start = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":projection,"inputDigest":projected["inputDigest"]});
    let mut bad = project_start.clone();
    bad["inputDigest"] = json!("0".repeat(64));
    assert!(call(&window, "start_translation_projection", bad).is_err());
    assert_eq!(
        call(
            &window,
            "start_translation_projection",
            project_start.clone()
        )
        .unwrap(),
        json!(projection)
    );
    assert_eq!(
        call(
            &window,
            "start_translation_projection",
            project_start.clone()
        )
        .unwrap(),
        json!(projection)
    );
    wait(&state, projection, 3);
    state.sessions.with(|sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .source
            .translation
            .projection = None
    });
    assert_eq!(
        call(
            &window,
            "prepare_translation_projection",
            project_request.clone()
        )
        .unwrap(),
        projected,
        "recovery must keep every original item and unit identity"
    );
    let mut crossed = project_request.clone();
    crossed["translationResultId"] = json!(check_result);
    assert!(call(&window, "prepare_translation_projection", crossed).is_err());
    let preview_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":projection,"after":0,"limit":10,"basis":null});
    let page = call(&window, "read_translation_preview", preview_request.clone()).unwrap();
    assert_eq!(
        (
            page["total"].as_u64(),
            page["unique"].as_u64(),
            page["unmatched"].as_u64()
        ),
        (Some(3), Some(2), Some(1))
    );
    assert_eq!(page["rows"][0]["entry"]["text"], "译文 👩🏽‍💻 e\u{301}");
    assert_eq!(page["rows"][1]["entry"]["text"], "");
    let row = &page["rows"][0];
    let action = ExecutionId::new();
    let adopt = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":projection,"itemId":row["itemId"],"resultId":row["resultId"],"actionId":action,
        "confirmation":{"resultDigest":row["resultDigest"],"sourceSnapshotId":page["currentSourceSnapshotId"],"occurrenceId":row["occurrenceId"],"sourceRevisionId":row["sourceRevisionId"],"targetUnitId":row["unitId"],"expectedSelectionId":row["currentSelection"]["eventId"],"decision":"select-if-empty"}});
    call(&window, "prepare_translation_adoption", adopt.clone()).unwrap();
    let action_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":action});
    let receipt = call(&window, "adopt_execution", action_request.clone()).unwrap();
    assert_eq!(
        call(&window, "adopt_execution", action_request.clone()).unwrap(),
        receipt
    );
    let history_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"unitId":row["unitId"],"locale":"zh-CN","afterOrdinal":"0","limit":10});
    let history = call(&window, "read_translation_history", history_request.clone()).unwrap();
    assert_eq!(history["total"], "1");
    assert_eq!(history["rows"][0]["text"], "译文 👩🏽‍💻 e\u{301}");
    let changed = adopt_source(
        &state,
        br#"{"first":"same","second":"changed current source"}"#,
    );
    assert_ne!(source.source_snapshot_id, changed.source_snapshot_id);
    let mut fresh = project_request.clone();
    fresh["attemptId"] = json!(ExecutionId::new());
    assert!(call(&window, "prepare_translation_projection", fresh).is_err());
    assert!(call(&window, "prepare_translation_check", check_request.clone()).is_err());
    assert!(call(&window, "finish_translation_check", finish.clone()).is_err());
    // Historical identities reconcile without re-execution or consent renewal.
    assert_eq!(
        call(&window, "start_plugin_translation", start).unwrap(),
        json!(producer)
    );
    assert_eq!(
        call(&window, "start_translation_projection", project_start).unwrap(),
        json!(projection)
    );
    assert_eq!(
        call(&window, "adopt_execution", action_request.clone()).unwrap(),
        receipt
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while state.sessions.with(|sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.tick(store).unwrap();
        host.active(store).unwrap()
    }) {
        assert!(
            Instant::now() < deadline,
            "owned execution cleanup did not finish"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let opened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let mut reopened_preview = preview_request;
    reopened_preview["sessionToken"] = opened["sessionToken"].clone();
    let historical = call(&window, "read_translation_preview", reopened_preview).unwrap();
    assert_eq!(historical["rows"][0]["resultId"], row["resultId"]);
    assert_eq!(historical["rows"][0]["entry"], row["entry"]);
    let mut reopened_history = history_request;
    reopened_history["sessionToken"] = opened["sessionToken"].clone();
    let saved = call(&window, "read_translation_history", reopened_history).unwrap();
    assert_eq!(saved["total"], "1");
    let mut reopened_action = action_request;
    reopened_action["sessionToken"] = opened["sessionToken"].clone();
    assert_eq!(
        call(&window, "adopt_execution", reopened_action).unwrap(),
        receipt
    );
    let mut proof = finish;
    proof["sessionToken"] = opened["sessionToken"].clone();
    assert!(
        call(&window, "finish_translation_check", proof).is_err(),
        "opening must not restore live grants"
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":opened["sessionToken"]}),
    )
    .unwrap();
}
