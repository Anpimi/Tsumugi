// Registered IPC plus actual native file handles and Core storage. The installed
// metadata host deliberately throws; no producer or checker worker may execute.
#[test]
fn paired_translation_capture_ipc_keeps_native_choice_originals_and_frozen_review() {
    use std::fs;
    use tauri::Manager;
    use native::{adopt_source, call};
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("material");
    fs::create_dir_all(directory.join("i18n")).unwrap();
    fs::write(directory.join("i18n/records.json"), [0,255,1]).unwrap();
    fs::write(directory.join("i18n/values.json"), "已有译文".as_bytes()).unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let project = call(&window, "create_project", json!({"destination":temporary.path().join("project"), "displayName":"Paired capture", "sourceLocale":"en", "targetLocales":["zh-CN"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"], "projectId":project["metadata"]["projectId"]});
    let state = app.state::<AppState>();
    let source = adopt_source(&state, br#"{"first":"same","second":"same"}"#);
    let profile = source.profile.clone();
    let fixture = crate::commands::plugins::InstalledPluginFixture::with_resource(state.plugins.clone(),
        include_bytes!("../../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.manifest.json"),
        "translation-profile.json", include_bytes!("../../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.declaration.json"),
        move |manifest, files| {
            for contribution in &mut manifest.contributions {
                match &mut contribution.contribution {
                    sdk::ContributionKind::Capability { declaration } => {
                        declaration.profiles = vec![profile.clone()];
                        declaration.input_schema.schema_version = 3;
                        declaration.limits.max_input_bytes = sdk::MAX_INVOCATION_PAYLOAD_BYTES as u32;
                        declaration.limits.max_output_bytes = sdk::MAX_PAIRED_TRANSLATION_RESULT_BYTES as u32;
                        if contribution.id == "extract" { declaration.output_schema.schema_version = 3; }
                    }
                    sdk::ContributionKind::Resource { schema, .. } => schema.schema_version = 2,
                    _ => {}
                }
            }
            let file = files.get_mut("translation-profile.json").unwrap();
            let mut declaration: sdk::TranslationImportDeclaration = serde_json::from_slice(&file.bytes).unwrap();
            declaration.profile = profile;
            declaration.material = None;
            declaration.max_total_bytes = Some(sdk::MAX_EXCHANGE_BYTES as u32);
            declaration.file_sets = Some(vec![sdk::SourceFileSetDeclaration { id: "translations".into(), display_name:"Translated material".into(), role:"translation".into(),
                encoding:sdk::SourceMaterialEncoding::Binary, extensions:vec!["json".into()], min_files:1, max_files:2, max_bytes:sdk::MAX_EXCHANGE_BYTES as u32 }]);
            file.bytes = serde_json::to_vec(&declaration).unwrap();
        });
    fixture.install();
    let approval = fixture.install_metadata_runtime(sdk::SDK_VERSION);
    let translation = PluginTranslationRequest { package:fixture.request().package, resource_id:"translation-profile".into(), environment_digest:approval.environment.digest().unwrap() };
    let select = PluginTranslationSelectRequest { session_token:context["sessionToken"].as_str().unwrap().into(), project_id:ExecutionId::parse(context["projectId"].as_str().unwrap()).unwrap(),
        translation, target_locale:"zh-CN".into(), expected_source_snapshot_id:source.source_snapshot_id, native_scope:source.native_scopes[0].clone() };
    let selections = vec![sdk::SourceFileSetSelection { id:"translations".into(), logical_paths:vec!["i18n/records.json".into(),"i18n/values.json".into()] }];
    // Only the interactive dialogs are replaced. The held native directory,
    // installed resource, registered handler and Core reads remain real.
    let selection = choose_materials(&state, directory.clone(), select, Some(selections));
    let mut capture = context.clone();
    capture["selectionId"] = json!(selection);
    assert_eq!(call(&window,"list_plugin_translation_files",capture.clone()).unwrap(), json!(["i18n/records.json","i18n/values.json"]));
    capture["attemptId"] = json!(ExecutionId::new());
    capture["languageConfirmed"] = json!(false);
    assert!(call(&window,"preflight_plugin_translation",capture.clone()).is_err());
    capture["languageConfirmed"] = json!(true);
    for property in ["fileName","path","fileSets","pairedSource","grantId"] {
        let mut forged = capture.clone(); forged[property] = json!("untrusted");
        assert!(call(&window,"preflight_plugin_translation",forged).is_err(), "{property}");
    }
    let view = call(&window,"preflight_plugin_translation",capture.clone()).unwrap();
    assert!(view.get("file").is_none());
    assert_eq!(view["files"][0]["byteLength"],3);
    assert_eq!(view["files"][1]["byteLength"],"已有译文".len());
    assert_eq!(view["pairedSourceFiles"].as_array().unwrap().len(),2);
    assert_eq!(view["source"],json!(source));
    let attempt = ExecutionId::parse(capture["attemptId"].as_str().unwrap()).unwrap();
    state.sessions.with(move |sessions| {
        let (host,store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let review = host.source.translation.review.as_ref().unwrap();
        let (input,_) = content::plugin_translation_input(&review.input).unwrap();
        assert_eq!(&*input.artifacts[0].bytes().unwrap(), &[0,255,1]);
        assert_eq!(input.paired_source.as_ref().unwrap(), &store.translation_pair_source("zh-CN",source.source_snapshot_id).unwrap());
        assert_eq!(store.execution_input(attempt).unwrap_err().code,ErrorCode::InvalidInput);
        assert!(!host.runtime.is_active(attempt));
    });
    fs::remove_file(directory.join("i18n/records.json")).unwrap();
    assert_eq!(call(&window,"preflight_plugin_translation",capture.clone()).unwrap(),view);
    let mut next = capture.clone(); next["attemptId"] = json!(ExecutionId::new());
    assert!(call(&window,"preflight_plugin_translation",next).is_err());
    fixture.decide(false,vec![approval.clone()]);
    assert!(call(&window,"preflight_plugin_translation",capture.clone()).is_err());
    fixture.decide(true,vec![approval]);
    adopt_source(&state,br#"{"first":"changed","second":"same"}"#);
    assert!(call(&window,"preflight_plugin_translation",capture.clone()).is_err());
    call(&window,"cancel_source_capture",context).unwrap();
    assert!(call(&window,"preflight_plugin_translation",capture).is_err());
}
