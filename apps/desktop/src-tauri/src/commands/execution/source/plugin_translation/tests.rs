use super::*;
use serde_json::{Value, json};

#[test]
fn translation_execution_wire_keeps_original_actions_and_separate_consent() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/pluginTranslationExecution.contract.json"
    ))
    .unwrap();
    fn round<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round::<PluginStartRequest>(&fixture["start"]);
    round::<TranslationCheckPrepareRequest>(&fixture["checkPrepare"]);
    round::<TranslationCheckFinishRequest>(&fixture["checkFinish"]);
    round::<TranslationCheckReview>(&fixture["checkReview"]);
    round::<TranslationProjectionPrepareRequest>(&fixture["projectionPrepare"]);
    round::<TranslationProjectionStartRequest>(&fixture["projectionStart"]);
    round::<TranslationProjectionReview>(&fixture["projectionReview"]);
    round::<()>(&fixture["checked"]);
    for field in ["grantId", "approved", "path", "environment", "targetLocale"] {
        let mut value = fixture["checkPrepare"].clone();
        value[field] = json!(true);
        assert!(serde_json::from_value::<TranslationCheckPrepareRequest>(value).is_err());
        let mut value = fixture["projectionStart"].clone();
        value[field] = json!(true);
        assert!(serde_json::from_value::<TranslationProjectionStartRequest>(value).is_err());
    }
    let mut value = fixture["start"].clone();
    value["expiresAtMs"] = json!(9_007_199_254_740_993u64);
    assert!(serde_json::from_value::<PluginStartRequest>(value).is_err());
}

#[test]
fn translation_capture_wire_does_not_accept_paths_or_execution_grants() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/pluginTranslationCapture.contract.json"
    ))
    .unwrap();
    fn round<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round::<TranslationSourceRequest>(&fixture["sourceRequest"]);
    round::<TranslationSourceContext>(&fixture["source"]);
    round::<PluginTranslationSelectRequest>(&fixture["select"]);
    round::<PluginTranslationSelection>(&fixture["selection"]);
    round::<PluginTranslationCaptureRequest>(&fixture["capture"]);
    round::<PluginTranslationPreflight>(&fixture["preflight"]);
    for name in [
        "path",
        "directory",
        "grantId",
        "environment",
        "approved",
        "targetLocale",
    ] {
        let mut forged = fixture["capture"].clone();
        forged[name] = json!(true);
        assert!(serde_json::from_value::<PluginTranslationCaptureRequest>(forged).is_err());
    }
    let mut lossy = fixture["source"].clone();
    lossy["contentRevision"] = json!(9_007_199_254_740_993u64);
    assert!(serde_json::from_value::<TranslationSourceContext>(lossy).is_err());
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn translation_capture_ipc_binds_current_source_target_and_raw_bytes_without_running_workers() {
    use std::{fs, path::PathBuf};
    use tauri::Manager;
    use tsumugi_plugin_host::{CapturedRuntime, RuntimeApproval};

    use native::*;
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("material");
    fs::create_dir_all(directory.join("i18n")).unwrap();
    let raw = "\u{feff}not domain JSON: 译文 👩🏽‍💻 e\u{301}";
    fs::write(directory.join("i18n/anything.json"), raw).unwrap();
    fs::write(directory.join("i18n/zh.json"), "{}").unwrap();
    fs::write(directory.join("i18n/ignored.JSON"), "{}").unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    for command in [
        "list_translation_files",
        "preflight_translation",
        "start_translation_import",
        "select_source",
        "select_webvtt_source",
        "read_source_integration",
        "read_webvtt_integration",
        "preflight_source",
        "start_source_import",
        "start_locale_build",
        "read_locale_build_attempt",
    ] {
        let error = call(&window, command, json!({})).unwrap_err();
        assert!(
            error.as_str().is_some_and(|value| value.contains("not found")),
            "legacy domain command remained registered: {command}: {error}"
        );
    }
    let project = call(&window, "create_project", json!({
        "destination":temporary.path().join("project"), "displayName":"Translation capture", "sourceLocale":"en", "targetLocales":["zh-CN","ja"]
    })).unwrap();
    let context = json!({"sessionToken":project["sessionToken"], "projectId":project["metadata"]["projectId"]});
    let mut read = context.clone();
    read["targetLocale"] = json!("zh-CN");
    assert!(call(&window, "read_plugin_translation_source", read.clone()).is_err());
    let state = app.state::<AppState>();
    let source = adopt_source(&state, br#"{"first":"same","second":"same"}"#);
    assert_eq!(
        call(&window, "read_plugin_translation_source", read.clone()).unwrap(),
        serde_json::to_value(&source).unwrap()
    );
    assert_eq!(source.native_scopes.len(), 1);
    assert_eq!(source.native_scopes[0].namespace, "Example.Mod");
    for target in ["fr", "zh-cn"] {
        let mut request = read.clone();
        request["targetLocale"] = json!(target);
        assert!(call(&window, "read_plugin_translation_source", request).is_err());
    }
    let profile = source.profile.clone();
    let fixture = crate::commands::plugins::InstalledPluginFixture::with_resource(
        state.plugins.clone(),
        include_bytes!(
            "../../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.manifest.json"
        ),
        "translation-profile.json",
        include_bytes!(
            "../../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.declaration.json"
        ),
        move |manifest, files| {
            for contribution in &mut manifest.contributions {
                if let sdk::ContributionKind::Capability { declaration } =
                    &mut contribution.contribution
                {
                    declaration.profiles = vec![profile.clone()];
                }
            }
            let file = files.get_mut("translation-profile.json").unwrap();
            let mut declaration: sdk::TranslationImportDeclaration =
                serde_json::from_slice(&file.bytes).unwrap();
            declaration.profile = profile;
            file.bytes = serde_json::to_vec(&declaration).unwrap();
        },
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
    let approval = RuntimeApproval {
        environment: metadata.environment,
        origin: crate::runtime_bundle::bundled_origin(),
    };
    fixture.install_runtime(&runtime, &approval);
    fixture.decide(true, vec![approval.clone()]);
    drop(runtime);
    let translation = PluginTranslationRequest {
        package: fixture.request().package,
        resource_id: "translation-profile".into(),
        environment_digest: approval.environment.digest().unwrap(),
    };
    let mut selected = context.clone();
    selected["translation"] = json!(translation);
    selected["targetLocale"] = json!("zh-CN");
    selected["expectedSourceSnapshotId"] = json!(source.source_snapshot_id);
    selected["nativeScope"] = json!(source.native_scopes[0]);
    for property in ["expectedSourceSnapshotId", "nativeScope"] {
        let mut invalid = selected.clone();
        if property == "expectedSourceSnapshotId" {
            invalid[property] = json!(ExecutionId::new());
        } else {
            invalid[property]["policy"]["behaviorVersion"] = json!(9);
        }
        assert!(
            call(&window, "select_plugin_translation", invalid).is_err(),
            "reject before opening any picker"
        );
    }
    let selection = choose(
        &state,
        directory.clone(),
        serde_json::from_value(selected.clone()).unwrap(),
    );
    let mut files = context.clone();
    files["selectionId"] = json!(selection);
    assert_eq!(
        call(&window, "list_plugin_translation_files", files.clone()).unwrap(),
        json!(["anything.json", "zh.json"])
    );
    let attempt = ExecutionId::new();
    let mut capture = files.clone();
    capture["attemptId"] = json!(attempt);
    capture["fileName"] = json!("anything.json");
    capture["languageConfirmed"] = json!(false);
    assert!(call(&window, "preflight_plugin_translation", capture.clone()).is_err());
    capture["languageConfirmed"] = json!(true);
    for property in ["path", "grantId", "targetLocale"] {
        let mut forged = capture.clone();
        forged[property] = json!("untrusted");
        assert!(call(&window, "preflight_plugin_translation", forged).is_err());
    }
    let view = call(&window, "preflight_plugin_translation", capture.clone()).unwrap();
    assert_eq!(view["source"], json!(source));
    assert_eq!(view["targetLocale"], "zh-CN");
    assert_eq!(view["file"]["sha256"], sdk::payload_digest(raw));
    assert_eq!(view["file"]["byteLength"], raw.len());
    state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let review = host.source.translation.review.as_ref().unwrap();
        let (material, _) = content::plugin_translation_input(&review.input).unwrap();
        assert_eq!(material.artifacts[0].utf8, raw);
        assert_eq!(material.native_scope, source.native_scopes[0]);
        assert_eq!(
            material.language_evidence,
            sdk::TranslationLanguageEvidence::UserConfirmed
        );
        assert_eq!(
            store.execution_input(attempt).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(!host.runtime.is_active(attempt));
    });
    fs::remove_file(directory.join("i18n/anything.json")).unwrap();
    assert_eq!(
        call(&window, "preflight_plugin_translation", capture.clone()).unwrap(),
        view,
        "same identity retains original immutable bytes"
    );
    let mut changed = capture.clone();
    changed["fileName"] = json!("zh.json");
    assert!(call(&window, "preflight_plugin_translation", changed).is_err());
    let mut missing = capture.clone();
    missing["attemptId"] = json!(ExecutionId::new());
    assert!(call(&window, "preflight_plugin_translation", missing).is_err());
    fixture.decide(false, vec![approval.clone()]);
    assert!(call(&window, "preflight_plugin_translation", capture.clone()).is_err());
    assert!(call(&window, "list_plugin_translation_files", files.clone()).is_err());
    fixture.decide(true, vec![approval]);
    let changed_source = adopt_source(&state, br#"{"third":"new current source"}"#);
    assert_ne!(
        json!(changed_source.source_snapshot_id),
        view["source"]["sourceSnapshotId"]
    );
    assert!(call(&window, "list_plugin_translation_files", files.clone()).is_err());
    assert!(call(&window, "preflight_plugin_translation", capture.clone()).is_err());
    selected["expectedSourceSnapshotId"] = json!(changed_source.source_snapshot_id);
    let selection = choose(&state, directory, serde_json::from_value(selected).unwrap());
    capture["selectionId"] = json!(selection);
    capture["fileName"] = json!("zh.json");
    capture["attemptId"] = json!(ExecutionId::new());
    assert!(call(&window, "preflight_plugin_translation", capture.clone()).is_ok());
    call(&window, "cancel_source_capture", context).unwrap();
    assert!(call(&window, "preflight_plugin_translation", capture).is_err());
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
mod native {
    use super::*;
    use std::path::PathBuf;
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    use tsumugi_core::content::{SourceAdoptionHandler, SourceBundle};
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
    pub(super) fn adopt_source(state: &AppState, bytes: &'static [u8]) -> TranslationSourceContext {
        let attempt = state.sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        // Test-only built-in source execution establishes a real adopted
        // Core fixture. No plugin worker or native checker is invoked.
        let bundle = SourceBundle::capture(
            br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
            bytes, "en",
        ).unwrap();
        let input = bundle.fixed_input(store.metadata().unwrap().project_id()).unwrap();
        host.runtime.submit(store, &input).unwrap();
        input.envelope().attempt_id
    });
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let accepted = state.sessions.with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
                let status = store.execution_attempt(attempt, true).unwrap();
                if status.items[0].validation != ValidationState::Valid {
                    return None;
                }
                let result = store
                    .execution_current_result(attempt, status.items[0].item_id)
                    .unwrap()
                    .unwrap();
                let confirmation = if store.content_scope().unwrap().current_snapshot.is_some() {
                    store
                        .source_comparison(attempt, result, 0, 10)
                        .unwrap()
                        .confirmation
                } else {
                    store
                        .source_preview(attempt, result, 0, 10)
                        .unwrap()
                        .confirmation
                };
                let input = store.execution_input(attempt).unwrap();
                let action = store
                    .prepare_adoption_with_id(
                        ExecutionId::new(),
                        attempt,
                        input.envelope().units[0].unit_id,
                        vec![result],
                        serde_json::to_value(confirmation).unwrap(),
                    )
                    .unwrap();
                store
                    .adopt_execution(&action, &SourceAdoptionHandler)
                    .unwrap();
                Some(store.translation_source_context("zh-CN").unwrap())
            });
            if let Some(source) = accepted {
                return source;
            }
            assert!(
                Instant::now() < deadline,
                "test source execution did not complete"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    pub(super) fn choose(
        state: &AppState,
        directory: PathBuf,
        request: PluginTranslationSelectRequest,
    ) -> ExecutionId {
        state.sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let source = source_context(store, &request).unwrap();
            host.source.stop();
            let selection_id = ExecutionId::new();
            // A real owned native handle replaces only the interactive picker.
            // No path-grant IPC is exposed by either production configuration.
            host.source.selection = Some((
                selection_id,
                Arc::new(capture::Selection::authorize(directory).unwrap()),
            ));
            host.source.translation.choice = Some(TranslationChoice {
                selection_id,
                request,
                source,
            });
            selection_id
        })
    }
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
mod execution_tests;
