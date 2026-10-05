use super::*;
use serde_json::{Value, json};

#[test]
fn dropped_prepare_caller_still_releases_its_owned_failed_job() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    use tauri::Manager;
    let temporary = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    state
        .plugins
        .configure(temporary.path().join("application"))
        .unwrap();
    let destination = temporary
        .path()
        .join("project")
        .to_string_lossy()
        .into_owned();
    let view = state
        .sessions
        .with(move |sessions| {
            sessions.create(CreateProjectRequest {
                destination,
                display_name: "Dropped caller".into(),
                source_locale: "en".into(),
                target_locales: vec!["zh-CN".into()],
            })
        })
        .unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/pluginBuildWorkflow.contract.json"
    ))
    .unwrap();
    let mut request = fixture["prepare"].clone();
    request["sessionToken"] = json!(view.session_token);
    request["projectId"] = json!(view.metadata.project_id);
    let mut waiting = Box::pin(prepare_plugin_build(
        app.state(),
        serde_json::from_value(request).unwrap(),
    ));
    assert!(matches!(
        waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(waiting);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        // This actor barrier follows admission even if the caller disappeared.
        let active = state.sessions.with(|sessions| {
            let host = sessions
                .active
                .as_mut()
                .unwrap()
                .execution_parts()
                .unwrap()
                .0;
            assert!(
                host.release.plugin.review.is_none(),
                "missing fixture package cannot create a review"
            );
            host.release.plugin.is_active()
        });
        if !active {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "dropped caller stranded the preparation slot"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn build_workflow_wire_preserves_exact_scope_and_separate_consents() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/pluginBuildWorkflow.contract.json"
    ))
    .unwrap();
    fn round<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round::<PluginBuildPrepareRequest>(&fixture["prepare"]);
    round::<PluginBuildReview>(&fixture["review"]);
    round::<PluginStartRequest>(&fixture["start"]);
    round::<ArtifactCheckPrepareRequest>(&fixture["prepareCheck"]);
    round::<ArtifactCheckReview>(&fixture["checkReview"]);
    round::<PluginStartRequest>(&fixture["startCheck"]);
    round::<ArtifactCheckFinishRequest>(&fixture["finishCheck"]);
    for property in ["directory", "approved", "environment", "renewGrant"] {
        let mut forged = fixture["start"].clone();
        forged[property] = json!(true);
        assert!(serde_json::from_value::<PluginStartRequest>(forged).is_err());
        let mut forged = fixture["prepare"].clone();
        forged[property] = json!(true);
        assert!(serde_json::from_value::<PluginBuildPrepareRequest>(forged).is_err());
    }
}

#[test]
fn build_preparation_jobs_do_not_reuse_source_capture_or_survive_stop() {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        temporary.path().join("project"),
        tsumugi_core::ProjectMetadata::create("Owned fixture", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut host = ExecutionHost::new(&store).unwrap();
    host.release.plugin.job = Some(ExecutionId::new());
    assert!(host.active(&store).unwrap());
    assert!(!host.source.is_active());
    host.release.stop();
    assert!(!host.active(&store).unwrap());
    host.release.plugin.job = Some(ExecutionId::new());
    host.begin_quiesce(&mut store).unwrap();
    assert!(!host.release.plugin.is_active());
    assert!(host.allow_mutation().is_err());
}

#[cfg(all(
    feature = "bundled-runtime",
    target_os = "macos",
    target_arch = "aarch64"
))]
#[test]
fn actual_installed_build_and_checker_ipc_commit_a_complete_release() {
    use std::{
        collections::BTreeMap,
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    use tsumugi_core::{
        ProjectMetadata, ReviewDecisionKind, ReviewWrite, SaveTranslationRevision,
        content::{SourceAdoptionHandler, SourceBundle, SourceRunner},
    };
    use tsumugi_plugin_host::{
        ApprovedPackageSetting, CapturedRuntime, PackageFile, PackageImage, PackageStore,
        PluginSettingsUpdate, RuntimeApproval,
        catalog::{PackageApproval, PackageCatalog, PackageOrigin},
    };

    fn call(
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
    fn consent(context: &Value, view: &Value) -> Value {
        let mut request = context.clone();
        request["attemptId"] = view["attemptId"].clone();
        request["inputDigest"] = view["inputDigest"].clone();
        request["grantId"] = json!(ExecutionId::new());
        request["unsandboxedExecution"] = json!(true);
        request["expiresAtMs"] = json!(
            (SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                + 600_000)
                .to_string()
        );
        request
    }
    fn completed(
        window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        context: &Value,
        attempt: &Value,
        count: usize,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let mut read = context.clone();
            read["attemptId"] = attempt.clone();
            read["offset"] = json!(0);
            read["limit"] = json!(100);
            let detail = call(window, "read_execution_attempt", read).unwrap();
            let items = detail["items"].as_array().unwrap();
            if items.len() == count
                && items
                    .iter()
                    .all(|item| item["status"]["execution"] == "succeeded")
            {
                return detail;
            }
            assert!(
                !items
                    .iter()
                    .any(|item| item["status"]["execution"] == "failed"),
                "worker failed: {detail}"
            );
            assert!(
                Instant::now() < deadline,
                "worker did not complete: {detail}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("project");
    let mut store = ProjectStore::create(
        &directory,
        ProjectMetadata::create("Installed build fixture", "en", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    // Only source seeding uses an in-process test fixture. The production build
    // and checker below both execute an independently installed JS component.
    let source = SourceBundle::capture(
        br#"{"UniqueID":"Example.Test","Name":"Test","Version":"1.0.0","EntryDll":"Test.dll"}"#,
        br#"{"greeting":"Original"}"#,
        "en",
    )
    .unwrap();
    let input = source
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let source_result = loop {
        runtime.tick(&mut store).unwrap();
        if store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap()
            .items[0]
            .execution
            == ExecutionState::Succeeded
        {
            break store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    };
    let preview = store
        .source_preview(input.envelope().attempt_id, source_result, 0, 50)
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![source_result],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let project = input.envelope().project_id;
    let unit = store.review_page(project, "zh-CN", 0, 100).unwrap().rows[0].unit_id;
    for locale in ["zh-CN", "fr-FR"] {
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: locale.into(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: target.selection_id,
                text: format!("Saved {locale} 👩🏽‍💻"),
            })
            .unwrap();
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .run_review_checks(project, unit, locale, &target.basis, ExecutionId::new())
            .unwrap();
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .write_review(&ReviewWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: locale.into(),
                expected_basis: target.basis,
                expected_decision_id: None,
                actor: "Fixture reviewer".into(),
                kind: ReviewDecisionKind::Approve,
                reason: String::new(),
            })
            .unwrap();
    }
    let basis = store
        .review_eligibility(project, &["zh-CN".into(), "fr-FR".into()])
        .unwrap();
    assert!(basis.ready);
    let mut declaration: sdk::BuildDeclaration = serde_json::from_slice(include_bytes!(
        "../../../../../../../../crates/plugin-sdk/tests/fixtures/build.declaration.json"
    ))
    .unwrap();
    declaration.profile = source.profile.clone();
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../../../../../../../crates/plugin-sdk/tests/fixtures/build.manifest.json"
    ))
    .unwrap();
    for contribution in &mut manifest.contributions {
        if let sdk::ContributionKind::Capability { declaration } = &mut contribution.contribution {
            declaration.profiles = vec![source.profile.clone()];
        }
    }
    let files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: include_bytes!("component.mjs").to_vec(),
                executable: false,
            },
        ),
        (
            "build-profile.json".into(),
            PackageFile {
                bytes: serde_json::to_vec(&declaration).unwrap(),
                executable: false,
            },
        ),
    ]);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    let image = PackageImage::capture(bytes, files, &digest).unwrap();
    let approval = PackageApproval {
        plugin: manifest.plugin,
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "synthetic-fixture".into(),
            publisher_id: "synthetic-fixture".into(),
        },
    };
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/javascript-runtime");
    let inspection: Value =
        serde_json::from_slice(&fs::read(resources.join("inspection.json")).unwrap()).unwrap();
    let descriptor = serde_json::from_value(inspection["environment"].clone()).unwrap();
    let captured = CapturedRuntime::capture_directories(
        &resources.join("tool"),
        &resources.join("host"),
        &descriptor,
        || true,
    )
    .unwrap();
    let runtime_approval = RuntimeApproval {
        environment: descriptor,
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    let mut installation =
        PackageStore::provision(temporary.path(), &["application", "plugins"], || true).unwrap();
    installation
        .install(
            &ExecutionId::new().to_string(),
            catalog.registered(&approval.plugin).unwrap(),
            || true,
        )
        .unwrap();
    installation
        .install_runtime(
            &ExecutionId::new().to_string(),
            &captured,
            &runtime_approval,
            || true,
        )
        .unwrap();
    installation
        .update_settings(
            0,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: vec![ApprovedPackageSetting {
                    approval: approval.clone(),
                    enabled: true,
                }],
                runtimes: vec![runtime_approval.clone()],
            },
            || true,
        )
        .unwrap();
    drop(installation);
    drop(captured);
    drop(runtime);
    drop(store);
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    state
        .plugins
        .configure(temporary.path().join("application"))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let opened = call(&window, "open_project", json!({"locator":directory})).unwrap();
    let context =
        json!({"sessionToken":opened["sessionToken"], "projectId":opened["metadata"]["projectId"]});
    let choice = PluginBuildRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: approval.plugin,
            package_digest: approval.package_digest,
        },
        resource_id: "build-profile".into(),
        environment_digest: runtime_approval.environment.digest().unwrap(),
    };
    let attempt = json!(ExecutionId::new());
    let mut prepare = context.clone();
    prepare["attemptId"] = attempt.clone();
    prepare["build"] = json!(choice);
    prepare["expectedEligibilityBasis"] = json!(basis.basis);
    prepare["choices"] = json!([{"locale":"zh-CN","outputPaths":["zh-CN.txt","zh-CN.meta"],"configuration":[]},{"locale":"fr-FR","outputPaths":["fr-FR.txt","fr-FR.meta"],"configuration":[]}]);
    let view = call(&window, "prepare_plugin_build", prepare.clone()).unwrap();
    assert_eq!(
        call(&window, "prepare_plugin_build", prepare.clone()).unwrap(),
        view
    );
    let mut forged = prepare.clone();
    forged["choices"][0]["outputPaths"][0] = json!("changed.txt");
    assert!(call(&window, "prepare_plugin_build", forged).is_err());
    let reviewed_attempt = serde_json::from_value(attempt.clone()).unwrap();
    state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        assert!(
            store.execution_input(reviewed_attempt).is_err(),
            "read preparation grants no execution"
        );
    });
    let start = consent(&context, &view);
    let mut refused = start.clone();
    refused["unsandboxedExecution"] = json!(false);
    assert!(call(&window, "start_plugin_build", refused).is_err());
    let mut refused = start.clone();
    refused["inputDigest"] = json!("a".repeat(64));
    assert!(call(&window, "start_plugin_build", refused).is_err());
    let mut refused = start.clone();
    refused["expiresAtMs"] = json!("1");
    assert!(call(&window, "start_plugin_build", refused).is_err());
    assert_eq!(
        call(&window, "start_plugin_build", start.clone()).unwrap(),
        attempt
    );
    let detail = completed(&window, &context, &attempt, 2);
    assert_eq!(
        call(&window, "start_plugin_build", start.clone()).unwrap(),
        attempt
    );
    let mut renewed = start;
    renewed["expiresAtMs"] = json!("18446744073709551615");
    assert!(call(&window, "start_plugin_build", renewed.clone()).is_err());
    let results: Vec<_> = detail["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["resultId"].clone())
        .collect();
    let mut adopt = context.clone();
    adopt["attemptId"] = attempt.clone();
    adopt["unitId"] = detail["recovery"]["units"][0]["unitId"].clone();
    adopt["resultIds"] = json!(results);
    adopt["actionId"] = json!(ExecutionId::new());
    let action = call(&window, "prepare_execution_adoption", adopt.clone()).unwrap();
    let action_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":action["actionId"]});
    assert!(
        call(&window, "adopt_execution", action_request.clone()).is_err(),
        "unproved builder output is not a release"
    );
    let mut last_finish = Value::Null;
    for (index, result) in results.iter().enumerate() {
        let mut check = context.clone();
        check["buildAttemptId"] = attempt.clone();
        check["buildResultId"] = result.clone();
        check["attemptId"] = json!(ExecutionId::new());
        check["build"] = json!(choice);
        let check_view = call(&window, "prepare_artifact_check", check.clone()).unwrap();
        assert_eq!(
            call(&window, "prepare_artifact_check", check).unwrap(),
            check_view
        );
        assert_eq!(check_view["artifacts"].as_array().unwrap().len(), 2);
        assert_eq!(
            check_view["requirements"][0]["targets"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(check_view["requirements"][0]["mandatory"], true);
        assert_eq!(check_view["requirements"][0]["waivable"], false);
        let start_check = consent(&context, &check_view);
        let mut wrong = start_check.clone();
        wrong["grantId"] = renewed["grantId"].clone();
        assert!(
            call(&window, "start_artifact_check", wrong).is_err(),
            "builder consent cannot authorize the checker"
        );
        let mut wrong = start_check.clone();
        wrong["unsandboxedExecution"] = json!(false);
        assert!(call(&window, "start_artifact_check", wrong).is_err());
        assert_eq!(
            call(&window, "start_artifact_check", start_check).unwrap(),
            check_view["attemptId"]
        );
        let checked = completed(&window, &context, &check_view["attemptId"], 1);
        let mut finish = context.clone();
        finish["attemptId"] = check_view["attemptId"].clone();
        finish["resultId"] = checked["items"][0]["resultId"].clone();
        let mut substituted = finish.clone();
        substituted["resultId"] = result.clone();
        assert!(call(&window, "finish_artifact_check", substituted).is_err());
        assert!(
            call(&window, "finish_artifact_check", finish.clone())
                .unwrap()
                .is_null()
        );
        if index == 0 {
            assert!(
                call(&window, "adopt_execution", action_request.clone()).is_err(),
                "one locale proof cannot release both"
            );
        }
        last_finish = finish;
    }
    assert!(
        call(&window, "finish_artifact_check", last_finish)
            .unwrap()
            .is_null()
    );
    let receipt = call(&window, "adopt_execution", action_request.clone()).unwrap();
    assert_eq!(
        call(&window, "adopt_execution", action_request).unwrap(),
        receipt
    );
    let releases = call(&window, "list_releases", context.clone()).unwrap();
    assert_eq!(releases.as_array().unwrap().len(), 1);
    let release: ExecutionId = serde_json::from_value(releases[0]["releaseId"].clone()).unwrap();
    state.sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let (host, store) = active.execution_parts().unwrap();
        assert_eq!(
            host.plugin_registrations.len(),
            2,
            "fresh package captures reuse one registration per provider/environment"
        );
        assert_eq!(store.release_view(release).unwrap().artifacts.len(), 4);
        for locale in ["zh-CN", "fr-FR"] {
            assert!(store.release_artifact(release, locale).is_err());
            let (_, bytes) = store
                .release_artifact_by_path(release, locale, &format!("{locale}.txt"))
                .unwrap();
            assert_eq!(bytes, format!("\u{feff}Saved {locale} 👩🏽‍💻\r\n").as_bytes());
        }
    });
    call(&window, "quiesce_execution", context.clone()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = call(&window, "execution_status", context.clone()).unwrap();
        if status["active"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "{status}");
        std::thread::sleep(Duration::from_millis(20));
    }
    // Session close uses the existing durable lifecycle and releases its lock.
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(&window, "open_project", json!({"locator":directory})).unwrap();
    let context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    assert_eq!(call(&window, "list_releases", context).unwrap(), releases);
    state.plugins.close();
    drop(state);
    drop(app);
    fn removable(path: &std::path::Path) {
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
            for child in fs::read_dir(path).unwrap() {
                removable(&child.unwrap().path());
            }
        }
    }
    removable(temporary.path());
}

#[test]
fn cancelled_preparation_cannot_overwrite_a_new_job_or_close_a_busy_session() {
    let temporary = tempfile::tempdir().unwrap();
    let mut sessions = SessionManager::default();
    let view = sessions
        .create(CreateProjectRequest {
            destination: temporary.path().join("project").to_string_lossy().into(),
            display_name: "Job ownership".into(),
            source_locale: "en".into(),
            target_locales: vec!["zh-CN".into()],
        })
        .unwrap();
    let project = ExecutionId::parse(&view.metadata.project_id).unwrap();
    let old = begin_job(sessions.active.as_mut().unwrap()).unwrap();
    sessions
        .active
        .as_mut()
        .unwrap()
        .execution_parts()
        .unwrap()
        .0
        .release
        .plugin
        .job = None;
    let current = begin_job(sessions.active.as_mut().unwrap()).unwrap();
    assert!(
        finish(
            &mut sessions,
            &view.session_token,
            project,
            old,
            CommandStage::ExecutionRead
        )
        .is_err()
    );
    assert_eq!(
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .release
            .plugin
            .job,
        Some(current)
    );
    assert!(
        sessions
            .close(CloseProjectRequest {
                session_token: view.session_token.clone()
            })
            .is_err()
    );
    finish(
        &mut sessions,
        &view.session_token,
        project,
        current,
        CommandStage::ExecutionRead,
    )
    .unwrap();
    sessions
        .close(CloseProjectRequest {
            session_token: view.session_token,
        })
        .unwrap();
}
