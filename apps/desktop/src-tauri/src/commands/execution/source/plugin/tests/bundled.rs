//! Fixed application packages use the real setup, Host and Core boundaries.
//! Only the window transport and directory picker are synthetic.
use super::{
    native::{call, completed, consents, scoped},
    *,
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use tauri::Manager;

struct Materials {
    plugin: &'static str,
    files: &'static [(&'static str, &'static str)],
    source_text: &'static str,
    translations: [(&'static str, &'static str, &'static str); 2],
    output: fn(&str) -> Vec<u8>,
    rules: [&'static str; 2],
}

struct OwnedTemporary(tempfile::TempDir);
impl OwnedTemporary {
    fn path(&self) -> &Path {
        self.0.path()
    }
}
impl Drop for OwnedTemporary {
    fn drop(&mut self) {
        // Managed installed objects are read-only. Make only this test's owned
        // tree removable even if an assertion fails, before TempDir cleans it.
        removable(self.path());
    }
}

fn copy_tree(source: &Path, output: &Path) {
    fs::create_dir(output).unwrap();
    fs::set_permissions(output, fs::Permissions::from_mode(0o700)).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let source = entry.unwrap().path();
        let output = output.join(source.file_name().unwrap());
        let info = fs::symlink_metadata(&source).unwrap();
        assert!(!info.is_symlink());
        if info.is_dir() {
            copy_tree(&source, &output);
        } else {
            assert!(info.is_file());
            fs::copy(&source, &output).unwrap();
            fs::set_permissions(
                output,
                fs::Permissions::from_mode(info.permissions().mode() & 0o700),
            )
            .unwrap();
        }
    }
}

fn removable(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|info| info.is_dir()) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        for child in fs::read_dir(path).unwrap() {
            removable(&child.unwrap().path());
        }
    }
}

fn journey(material: Materials) {
    let temporary = OwnedTemporary(tempfile::tempdir().unwrap());
    let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let resources = temporary.path().join("resources");
    fs::create_dir(&resources).unwrap();
    copy_tree(
        &prepared.join("bundled-plugins"),
        &resources.join("bundled-plugins"),
    );
    fs::create_dir(resources.join("runtimes")).unwrap();
    copy_tree(
        &prepared.join("javascript-runtime"),
        &resources.join("runtimes/javascript"),
    );
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let state = app.state::<AppState>();
    state
        .plugins
        .configure(temporary.path().join("application"))
        .unwrap();
    state
        .plugins
        .configure_bundle(Some(resources.clone()))
        .unwrap();
    state
        .plugins
        .configure_default_bundle(Some(resources))
        .unwrap();
    let inventory = call(&window, "read_plugin_inventory", json!({})).unwrap();
    assert!(inventory["packages"].as_array().unwrap().is_empty());
    let offer = &inventory["defaultsOffer"];
    assert_eq!(offer["availability"], "available");
    assert_eq!(offer["packages"].as_array().unwrap().len(), 2);
    let installed = call(&window, "install_plugin_defaults", json!({"id":offer["id"],"selectionDigest":offer["selectionDigest"],"expectedRevision":inventory["settingsRevision"],"actionId":ExecutionId::new()})).unwrap();
    assert_eq!(installed["packages"].as_array().unwrap().len(), 2);
    assert_eq!(installed["runtimes"].as_array().unwrap().len(), 1);
    let selected = installed["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["plugin"]["id"] == material.plugin)
        .unwrap();
    let package = crate::commands::plugins::PluginPackageRequest {
        plugin: serde_json::from_value(selected["plugin"].clone()).unwrap(),
        package_digest: selected["packageDigest"].as_str().unwrap().into(),
    };
    let environment = offer["runtimeEnvironmentDigest"]
        .as_str()
        .unwrap()
        .to_owned();
    let source_choice = PluginSourceRequest {
        package: package.clone(),
        resource_id: "source-profile".into(),
        environment_digest: environment.clone(),
    };
    let build_choice = crate::commands::plugins::PluginBuildRequest {
        package,
        resource_id: "build-profile".into(),
        environment_digest: environment.clone(),
    };
    let source_view = call(&window, "read_plugin_source", json!(source_choice)).unwrap();
    assert_eq!(
        source_view["declaration"]["reviewResource"],
        "review-profile"
    );
    let project_path = temporary.path().join("project");
    let project = call(&window, "create_project", json!({"destination":project_path,"displayName":"Included package acceptance","sourceLocale":"en-US","targetLocales":["zh-CN","ja"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let directory = temporary.path().join("materials");
    fs::create_dir(&directory).unwrap();
    for (path, bytes) in material.files {
        let path = directory.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    // This supplies only the picker result. Capture and all mutations use their
    // registered production IPC, current package and independent grants.
    let selection = ExecutionId::new();
    let fixed_choice = source_choice.clone();
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
            Arc::new(capture::Selection::authorize(directory).unwrap()),
        ));
        host.source.plugin.choice = Some((selection, fixed_choice));
    });
    let preflight = call(&window, "preflight_plugin_source", scoped(&context, json!({"selectionId":selection,"sourceLanguage":"en-US","attemptId":ExecutionId::new()}))).unwrap();
    let start = consent(&context, &preflight);
    let mut denied = start.clone();
    denied["unsandboxedExecution"] = json!(false);
    assert!(call(&window, "start_plugin_source", denied).is_err());
    let started = call(&window, "start_plugin_source", start.clone()).unwrap();
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
    assert_eq!(preview["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        preview["rows"][0]["occurrence"]["text"],
        material.source_text
    );
    let adoption = scoped(
        &context,
        json!({"attemptId":started,"resultId":source_result,"actionId":ExecutionId::new(),"confirmation":preview["confirmation"]}),
    );
    call(&window, "prepare_source_adoption", adoption.clone()).unwrap();
    let action = scoped(&context, json!({"actionId":adoption["actionId"]}));
    assert!(call(&window, "adopt_execution", action.clone()).is_err());
    let check = call(&window, "prepare_source_check", scoped(&context, json!({"sourceAttemptId":started,"sourceResultId":source_result,"attemptId":ExecutionId::new(),"source":source_choice}))).unwrap();
    let check_start = consent(&context, &check);
    let mut borrowed = check_start.clone();
    borrowed["grantId"] = start["grantId"].clone();
    assert!(call(&window, "start_source_check", borrowed).is_err());
    let checked = call(&window, "start_source_check", check_start).unwrap();
    let checked_detail = completed(&window, &context, &checked);
    call(
        &window,
        "finish_source_check",
        scoped(
            &context,
            json!({"attemptId":checked,"resultId":checked_detail["items"][0]["resultId"]}),
        ),
    )
    .unwrap();
    call(&window, "adopt_execution", action).unwrap();
    for (locale, text, _) in material.translations {
        let page = call(
            &window,
            "read_review_page",
            scoped(
                &context,
                json!({"locale":locale,"afterOrdinal":0,"limit":50}),
            ),
        )
        .unwrap();
        assert_eq!(page["rows"].as_array().unwrap().len(), 1);
        let row = &page["rows"][0];
        let target_request = scoped(&context, json!({"unitId":row["unitId"],"locale":locale}));
        call(&window, "save_translation_revision", scoped(&context, json!({"unitId":row["unitId"],"locale":locale,"sourceRevisionId":row["sourceRevisionId"],"expectedSelectionId":null,"text":text,"actionId":ExecutionId::new()}))).unwrap();
        let target = call(&window, "read_review_target", target_request.clone()).unwrap();
        let intent = scoped(
            &context,
            json!({"unitId":row["unitId"],"locale":locale,"expectedBasis":target["basis"],"actionId":ExecutionId::new(),"advisoryChecks":[]}),
        );
        let review = call(&window, "prepare_review_checks", intent.clone()).unwrap();
        assert_eq!(review["kind"], "plugin");
        assert_eq!(
            review["view"]["checkers"][0]["plugin"]["plugin"]["environmentDigest"],
            environment
        );
        let result = call(
            &window,
            "run_review_checks",
            scoped(
                &context,
                json!({"check":intent,"executions":consents(&context,&review["view"])}),
            ),
        )
        .unwrap();
        assert_eq!(result["outcome"], "completed");
        let current = call(&window, "read_review_target", target_request).unwrap();
        let rules = current["currentCheck"]["rules"].as_array().unwrap();
        assert!(
            rules.iter().all(|rule| rule["status"] == "passed"),
            "{current}"
        );
        let actual = rules
            .iter()
            .map(|rule| rule["rule"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "required-translation",
            "terminology",
            material.rules[0],
            material.rules[1],
        ]
        .into_iter()
        .collect();
        assert_eq!(actual, expected);
        call(&window, "write_review_decision", scoped(&context, json!({"decision":{"projectId":context["projectId"],"unitId":row["unitId"],"locale":locale,"expectedBasis":current["basis"],"expectedDecisionId":null,"actor":"Synthetic reviewer","kind":"approve","reason":"","actionId":ExecutionId::new()}}))).unwrap();
    }
    let eligibility = call(
        &window,
        "read_review_eligibility",
        scoped(&context, json!({"locales":["zh-CN","ja"]})),
    )
    .unwrap();
    assert_eq!(eligibility["ready"], true);
    let choices = material
        .translations
        .iter()
        .map(|(locale, _, path)| json!({"locale":locale,"outputPaths":[path],"configuration":[]}))
        .collect::<Vec<_>>();
    let build = call(&window, "prepare_plugin_build", scoped(&context, json!({"attemptId":ExecutionId::new(),"build":build_choice,"expectedEligibilityBasis":eligibility["basis"],"choices":choices}))).unwrap();
    let build_start = consent(&context, &build);
    let built = call(&window, "start_plugin_build", build_start.clone()).unwrap();
    let built_detail = completed(&window, &context, &built);
    assert_eq!(built_detail["items"].as_array().unwrap().len(), 2);
    let results = built_detail["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["resultId"].clone())
        .collect::<Vec<_>>();
    let adoption = call(&window, "prepare_execution_adoption", scoped(&context, json!({"attemptId":built,"unitId":built_detail["recovery"]["units"][0]["unitId"],"resultIds":results,"actionId":ExecutionId::new()}))).unwrap();
    let release_action = scoped(&context, json!({"actionId":adoption["actionId"]}));
    assert!(call(&window, "adopt_execution", release_action.clone()).is_err());
    for result in &results {
        let check = call(&window, "prepare_artifact_check", scoped(&context, json!({"buildAttemptId":built,"buildResultId":result,"attemptId":ExecutionId::new(),"build":build_choice}))).unwrap();
        let check_start = consent(&context, &check);
        let mut borrowed = check_start.clone();
        borrowed["grantId"] = build_start["grantId"].clone();
        assert!(call(&window, "start_artifact_check", borrowed).is_err());
        let checked = call(&window, "start_artifact_check", check_start).unwrap();
        let detail = completed(&window, &context, &checked);
        call(
            &window,
            "finish_artifact_check",
            scoped(
                &context,
                json!({"attemptId":checked,"resultId":detail["items"][0]["resultId"]}),
            ),
        )
        .unwrap();
    }
    let receipt = call(&window, "adopt_execution", release_action.clone()).unwrap();
    assert_eq!(
        call(&window, "adopt_execution", release_action).unwrap(),
        receipt
    );
    let releases = call(&window, "list_releases", context.clone()).unwrap();
    assert_eq!(releases.as_array().unwrap().len(), 1);
    let release: ExecutionId = serde_json::from_value(releases[0]["releaseId"].clone()).unwrap();
    let expected = material
        .translations
        .iter()
        .map(|(locale, text, path)| {
            (
                locale.to_string(),
                path.to_string(),
                (material.output)(text),
            )
        })
        .collect::<Vec<_>>();
    let assert_artifacts = |state: &AppState| {
        let expected = expected.clone();
        state.sessions.with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            for (locale, path, expected) in expected {
                let (_, bytes) = store
                    .release_artifact_by_path(release, &locale, &path)
                    .unwrap();
                assert_eq!(bytes, expected);
            }
        });
    };
    assert_artifacts(&state);
    let destination = temporary.path().join("delivery");
    fs::create_dir(&destination).unwrap();
    let delivery_selection = ExecutionId::new();
    let held = Arc::new(capture::Selection::authorize(destination.clone()).unwrap());
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .release
            .select_for_test(delivery_selection, held);
    });
    let preview = call(
        &window,
        "preview_delivery",
        scoped(
            &context,
            json!({"releaseId":release,"selectionId":delivery_selection}),
        ),
    )
    .unwrap();
    assert_eq!(preview["files"].as_array().unwrap().len(), 2);
    assert!(
        preview["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|file| file["state"] == "absent")
    );
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    let export = scoped(
        &context,
        json!({"releaseId":release,"selectionId":delivery_selection,"previewId":preview["previewId"],"actionId":ExecutionId::new(),"overwriteConflicts":false}),
    );
    let delivery = call(&window, "export_release", export.clone()).unwrap();
    assert_eq!(delivery["state"], "succeeded");
    assert_eq!(delivery["files"].as_array().unwrap().len(), 2);
    assert_eq!(call(&window, "export_release", export).unwrap(), delivery);
    for (_, path, bytes) in &expected {
        assert_eq!(fs::read(destination.join(path)).unwrap(), *bytes);
    }
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
    assert_artifacts(&state);
    for (_, path, bytes) in &expected {
        assert_eq!(fs::read(destination.join(path)).unwrap(), *bytes);
    }
    assert_eq!(
        call(&window, "read_plugin_inventory", json!({})).unwrap(),
        installed
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":reopened_context["sessionToken"]}),
    )
    .unwrap();
    state.plugins.close();
    drop(state);
    drop(app);
    removable(temporary.path());
}

#[test]
fn included_webvtt_source_review_build_and_reopen_use_fixed_packages_and_real_workers() {
    journey(Materials {
        plugin: "webvtt",
        files: &[(
            "source.vtt",
            "WEBVTT\r\n\r\nCue\r\n00:00:01.000 --> 00:00:02.000\r\nHello 👩🏽‍💻\r\n\r\n",
        )],
        source_text: "Hello 👩🏽‍💻",
        translations: [
            ("zh-CN", "你好 👩🏽‍💻", "zh-CN.vtt"),
            ("ja", "こんにちは 👩🏽‍💻", "ja.vtt"),
        ],
        output: |text| {
            format!("WEBVTT\r\n\r\nCue\r\n00:00:01.000 --> 00:00:02.000\r\n{text}\r\n\r\n")
                .into_bytes()
        },
        rules: ["plugin:webvtt.source-structure", "plugin:webvtt.payload"],
    });
}

#[test]
fn included_smapi_source_review_build_and_reopen_use_fixed_packages_and_real_workers() {
    journey(Materials {
        plugin: "stardew-smapi",
        files: &[
            (
                "manifest.json",
                r#"{"Name":"Synthetic mod","Author":"Synthetic","Version":"1.0.0","Description":"Synthetic acceptance input","UniqueID":"Synthetic.Included","EntryDll":"Synthetic.dll"}"#,
            ),
            ("i18n/default.json", "{\"message\":\"Hello {{name}} 👩🏽‍💻\"}"),
        ],
        source_text: "Hello {{name}} 👩🏽‍💻",
        translations: [
            ("zh-CN", "你好 {{name}} 👩🏽‍💻", "i18n/zh.json"),
            ("ja", "こんにちは {{name}} 👩🏽‍💻", "i18n/ja.json"),
        ],
        output: |text| {
            format!(
                "{{\n  \"message\": {}\n}}\n",
                serde_json::to_string(text).unwrap()
            )
            .into_bytes()
        },
        rules: ["plugin:smapi.placeholders", "plugin:smapi.format"],
    });
}
