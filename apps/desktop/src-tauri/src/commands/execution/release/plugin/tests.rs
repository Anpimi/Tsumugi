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
    round::<SavedPluginBuildRequest>(&fixture["savedRead"]);
    round::<tsumugi_core::SavedPluginBuildView>(&fixture["savedBuild"]);
    for property in ["build", "resourceId", "grantId", "unsandboxedExecution"] {
        let mut forged = fixture["savedRead"].clone();
        forged[property] = json!(true);
        assert!(serde_json::from_value::<SavedPluginBuildRequest>(forged).is_err());
    }
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
    installed_build_and_checks(false, None);
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn artifact_workflow_actual_registered_ipc_sequences_explicit_subset_then_stops_at_human_release() {
    installed_build_and_checks(true, None);
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn artifact_workflow_actual_failed_checker_preserves_proof_and_never_enqueues_the_remaining_locale()
{
    installed_build_and_checks(true, Some("failed"));
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn artifact_workflow_actual_unknown_checker_preserves_uncertainty_and_never_retries() {
    installed_build_and_checks(true, Some("unknown"));
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn installed_build_and_checks(workflow: bool, failure_outcome: Option<&str>) {
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
    assert!(matches!(failure_outcome, None | Some("failed" | "unknown")));
    let failed_checker = failure_outcome.is_some();
    let owned =
        crate::commands::execution::test_fixtures::OwnedDirectory(tempfile::tempdir().unwrap());
    let temporary = &owned.0;
    let locales: &[&str] = if failed_checker {
        &["zh-CN", "fr-FR", "de"]
    } else {
        &["zh-CN", "fr-FR"]
    };
    let directory = temporary.path().join("project");
    let mut store = ProjectStore::create(
        &directory,
        ProjectMetadata::create("Installed build fixture", "en", locales.iter().copied()).unwrap(),
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
    for &locale in locales {
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
        .review_eligibility(
            project,
            &locales.iter().map(|l| (*l).into()).collect::<Vec<_>>(),
        )
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
    let mut component = include_str!("component.mjs").to_owned();
    if failed_checker {
        let marker = "const input = data.input;";
        assert_eq!(
            component.matches(marker).count(),
            1,
            "synthetic component drift"
        );
        let outcome =
            json!({"kind":failure_outcome.expect("negative fixture outcome"),"utf8":"{}"});
        component = component.replace(
            marker,
            &format!(
                "const input = data.input; if (input.targetLanguage === 'fr-FR') return {outcome};"
            ),
        );
    }
    let files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                bytes: component.into_bytes(),
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
    let descriptor = if workflow {
        serde_json::from_slice(
            &fs::read(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL")
                    .expect("explicit qualified runtime descriptor required"),
            )
            .unwrap(),
        )
        .unwrap()
    } else {
        let inspection: Value =
            serde_json::from_slice(&fs::read(resources.join("inspection.json")).unwrap()).unwrap();
        serde_json::from_value(inspection["environment"].clone()).unwrap()
    };
    let tool = if workflow {
        PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").expect("explicit runtime tool required"),
        )
    } else {
        resources.join("tool")
    };
    let host = if workflow {
        PathBuf::from(
            std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").expect("explicit Process3 Host required"),
        )
    } else {
        resources.join("host")
    };
    let captured =
        CapturedRuntime::capture_directories(&tool, &host, &descriptor, || true).unwrap();
    let runtime_approval = RuntimeApproval {
        environment: descriptor.into(),
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
    if workflow {
        let sequence = state.sessions.with(|sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .execution_sequence()
                .unwrap()
        });
        assert_eq!(
            call(
                &window,
                "read_artifact_check_workflow_session",
                context.clone()
            )
            .unwrap(),
            json!({"kind":"unavailable"})
        );
        let mut wrong = context.clone();
        wrong["sessionToken"] = json!("retired-session");
        assert!(call(&window, "read_artifact_check_workflow_session", wrong).is_err());
        let mut wrong = context.clone();
        wrong["projectId"] = json!(ExecutionId::new());
        assert!(call(&window, "read_artifact_check_workflow_session", wrong).is_err());
        state.sessions.with(move |sessions| {
            let active = sessions.active.as_ref().unwrap();
            assert!(
                active.execution.is_none(),
                "read-only workflow observation creates no runtime"
            );
            assert_eq!(active.store.execution_sequence().unwrap(), sequence);
        });
    }
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
    prepare["choices"] = json!(locales.iter().map(|locale| json!({"locale":locale,
        "outputPaths":[format!("deliverables/{locale}/content.txt"),format!("{locale}.meta")],"configuration":[]})).collect::<Vec<_>>());
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
    let detail = completed(&window, &context, &attempt, locales.len());
    let saved_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":attempt});
    let saved_build = call(&window, "read_saved_plugin_build", saved_request.clone()).unwrap();
    assert_eq!(saved_build["attemptId"], attempt);
    assert_eq!(
        saved_build["locales"].as_array().unwrap().len(),
        locales.len()
    );
    assert!(
        saved_build["locales"]
            .as_array()
            .unwrap()
            .iter()
            .all(|locale| locale["targetCount"] == 1
                && locale["result"]["artifacts"].as_array().unwrap().len() == 2)
    );
    assert!(
        detail["recovery"]["units"][0]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|action| action != "validate-output")
    );
    let mut wrong = saved_request.clone();
    wrong["projectId"] = json!(ExecutionId::new());
    assert!(call(&window, "read_saved_plugin_build", wrong).is_err());
    let mut wrong = saved_request;
    wrong["attemptId"] = json!(ExecutionId::new());
    assert!(call(&window, "read_saved_plugin_build", wrong).is_err());
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
    if workflow {
        let session = call(
            &window,
            "read_artifact_check_workflow_session",
            context.clone(),
        )
        .unwrap();
        assert_eq!(session["kind"], "available");
        let stopped_identity = json!({"ownerId":session["ownerId"],"generation":session["nextGeneration"],"workflowId":ExecutionId::new()});
        let stopped = call(
            &window,
            "stop_artifact_check_workflow",
            json!({"sessionToken":context["sessionToken"],
            "projectId":context["projectId"],"identity":stopped_identity}),
        )
        .unwrap();
        assert_eq!(stopped["admissionClosed"], true);
        assert_eq!(stopped["callbacksDrained"], true);
        let build_results: Vec<_> = saved_build["locales"]
            .as_array()
            .unwrap()
            .iter()
            .map(
                |locale| json!({"itemId":locale["itemId"],"resultId":locale["result"]["resultId"]}),
            )
            .collect();
        let mut preparation = json!({"identity":stopped_identity,"buildAttemptId":attempt,
            "buildInputDigest":saved_build["inputDigest"],"buildResults":build_results,"build":choice});
        let request = |preparation: &Value| json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"preparation":preparation});
        assert!(
            call(
                &window,
                "prepare_artifact_check_workflow",
                request(&preparation)
            )
            .is_err(),
            "a stop accepted before prepare irreversibly consumes admission"
        );
        let old_read = call(
            &window,
            "read_artifact_check_workflow",
            json!({"sessionToken":context["sessionToken"],
            "projectId":context["projectId"],"preparation":preparation,"start":null}),
        )
        .unwrap();
        assert_eq!(old_read["admissionClosed"], true);
        assert_eq!(old_read["callbacksDrained"], true);
        for index in 0..if failed_checker { 1 } else { 2 } {
            let session = call(
                &window,
                "read_artifact_check_workflow_session",
                context.clone(),
            )
            .unwrap();
            preparation["identity"] = json!({"ownerId":session["ownerId"],"generation":session["nextGeneration"],"workflowId":ExecutionId::new()});
            let accepted = call(
                &window,
                "prepare_artifact_check_workflow",
                request(&preparation),
            )
            .unwrap();
            assert_eq!(accepted["preparation"], preparation);
            let mut forged = preparation.clone();
            forged["buildInputDigest"] = json!("a".repeat(64));
            assert!(call(&window, "prepare_artifact_check_workflow", request(&forged)).is_err());
            let deadline = Instant::now() + Duration::from_secs(30);
            let view = loop {
                call(&window, "execution_status", context.clone()).unwrap();
                let observation = call(
                    &window,
                    "read_artifact_check_workflow",
                    json!({"sessionToken":context["sessionToken"],
                    "projectId":context["projectId"],"preparation":preparation,"start":null}),
                )
                .unwrap();
                if observation["view"]["phase"] == "prepared" {
                    break observation["view"].clone();
                }
                assert_eq!(
                    observation["admissionClosed"], false,
                    "preparation failed: {observation}"
                );
                assert!(
                    Instant::now() < deadline,
                    "preparation did not complete: {observation}"
                );
                std::thread::sleep(Duration::from_millis(5));
            };
            assert_eq!(view["steps"].as_array().unwrap().len(), locales.len());
            assert!(
                view["steps"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|s| s["proof"].is_null() && s["selected"] == false)
            );
            let step = &view["steps"][index];
            assert_eq!(
                step["step"]["producerAttemptId"],
                preparation["buildAttemptId"]
            );
            assert_eq!(
                step["step"]["producerInputDigest"],
                preparation["buildInputDigest"]
            );
            assert_eq!(
                step["review"]["buildAttemptId"],
                step["step"]["producerAttemptId"]
            );
            let manual = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
                "buildAttemptId":attempt,"buildResultId":step["step"]["buildResultId"],"attemptId":ExecutionId::new(),"build":choice});
            assert!(
                call(&window, "prepare_artifact_check", manual).is_err(),
                "single-check cannot steal the workflow owner"
            );
            let consents: Vec<_> = view["steps"].as_array().unwrap().iter().enumerate()
                .filter(|(ordinal, _)| failed_checker || index == 1 || *ordinal == 0)
                .map(|(_, step)| json!({"step":step["step"],"grantId":ExecutionId::new(),"expiresAtMs":
                    (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()+600_000).to_string(),"unsandboxedExecution":true})).collect();
            let start = json!({"identity":preparation["identity"],"materializationDigest":view["materializationDigest"],"consents":consents});
            let mut forged = start.clone();
            forged["consents"][0]["unsandboxedExecution"] = json!(false);
            assert!(call(&window, "start_artifact_check_workflow", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"start":forged})).is_err());
            call(&window, "start_artifact_check_workflow", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"start":start})).unwrap();
            let deadline = Instant::now() + Duration::from_secs(30);
            let observation = loop {
                call(&window, "execution_status", context.clone()).unwrap();
                let observation = call(
                    &window,
                    "read_artifact_check_workflow",
                    json!({"sessionToken":context["sessionToken"],
                    "projectId":context["projectId"],"preparation":preparation,"start":start}),
                )
                .unwrap();
                assert_eq!(
                    observation["steps"].as_array().unwrap().len(),
                    if failed_checker {
                        3
                    } else if index == 0 {
                        1
                    } else {
                        2
                    },
                    "observation covers exactly every original consent"
                );
                if index == 1 || failed_checker {
                    if observation["steps"][1]["outcome"] == "enqueued" {
                        assert_eq!(
                            observation["steps"][0]["proof"]["valid"], true,
                            "second enqueue requires the first durable semantic proof"
                        );
                    }
                    let attempts: Vec<ExecutionId> = start["consents"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|c| serde_json::from_value(c["step"]["attemptId"].clone()).unwrap())
                        .collect();
                    state.sessions.with(move |sessions| {
                        let runtime = &sessions
                            .active
                            .as_ref()
                            .unwrap()
                            .execution
                            .as_ref()
                            .unwrap()
                            .runtime;
                        assert!(
                            attempts
                                .iter()
                                .filter(|a| runtime.has_owned_attempt_work(**a))
                                .count()
                                <= 1,
                            "only one exact checker may own live callbacks"
                        );
                    });
                }
                if observation["admissionClosed"] == true && observation["callbacksDrained"] == true
                {
                    break observation;
                }
                assert!(
                    Instant::now() < deadline,
                    "workflow did not drain: {observation}"
                );
                std::thread::sleep(Duration::from_millis(5));
            };
            if failed_checker {
                assert_eq!(observation["view"]["phase"], "paused", "{observation}");
                assert_eq!(observation["view"]["steps"][0]["phase"], "proved");
                assert_eq!(observation["view"]["steps"][0]["proof"]["valid"], true);
                let outcome = failure_outcome.expect("negative fixture outcome");
                assert_eq!(observation["view"]["steps"][1]["phase"], outcome);
                assert_eq!(observation["steps"][1]["execution"], outcome);
                if outcome == "unknown" {
                    assert_eq!(observation["view"]["error"]["code"], "outcome-unknown");
                }
                assert_eq!(observation["view"]["steps"][1]["proof"]["valid"], false);
                assert!(observation["view"]["steps"][1]["proof"]["checks"].is_null());
                assert_eq!(observation["view"]["steps"][2]["phase"], "not-started");
                assert_eq!(observation["steps"][2]["outcome"], "not-enqueued");
                assert!(observation["currentTask"].is_null());
                let sequence = state.sessions.with(|sessions| {
                    sessions
                        .active
                        .as_ref()
                        .unwrap()
                        .store
                        .execution_sequence()
                        .unwrap()
                });
                let original = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"start":start});
                assert_eq!(
                    call(&window, "start_artifact_check_workflow", original).unwrap(),
                    observation["view"]
                );
                for _ in 0..3 {
                    call(&window, "execution_status", context.clone()).unwrap();
                }
                let unstarted: ExecutionId =
                    serde_json::from_value(start["consents"][2]["step"]["attemptId"].clone())
                        .unwrap();
                state.sessions.with(move |sessions| {
                    let active = sessions.active.as_ref().unwrap();
                    assert_eq!(
                        active.store.execution_sequence().unwrap(),
                        sequence,
                        "same Start and later ticks cannot retry dispatch"
                    );
                    assert!(
                        active
                            .execution
                            .as_ref()
                            .unwrap()
                            .runtime
                            .input_if_present(&active.store, unstarted)
                            .unwrap()
                            .is_none()
                    );
                    assert!(
                        !active
                            .execution
                            .as_ref()
                            .unwrap()
                            .runtime
                            .has_owned_attempt_work(unstarted)
                    );
                });
                let historical = call(&window, "read_saved_plugin_build", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":attempt})).unwrap();
                let saved_locale = |step: &Value| {
                    let locale = historical["locales"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|locale| locale["itemId"] == step["buildItemId"])
                        .expect("exact saved build item");
                    assert_eq!(locale["choice"]["locale"], step["locale"]);
                    locale
                };
                assert_eq!(
                    saved_locale(&start["consents"][0]["step"])["artifactCheck"]["valid"],
                    true
                );
                assert_eq!(
                    saved_locale(&start["consents"][1]["step"])["artifactCheck"]["valid"],
                    false
                );
                assert!(saved_locale(&start["consents"][2]["step"])["artifactCheck"].is_null());
                assert!(
                    call(&window, "list_releases", context.clone())
                        .unwrap()
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                call(&window, "quiesce_execution", context.clone()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(10);
                while call(&window, "execution_status", context.clone()).unwrap()["active"] != false
                {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
                call(
                    &window,
                    "close_project",
                    json!({"sessionToken":context["sessionToken"]}),
                )
                .unwrap();
                let reopened = call(&window, "open_project", json!({"locator":directory})).unwrap();
                let history = call(
                    &window,
                    "read_saved_plugin_build",
                    json!({"sessionToken":reopened["sessionToken"],
                    "projectId":reopened["metadata"]["projectId"],"attemptId":attempt}),
                )
                .unwrap();
                assert_eq!(history["locales"], historical["locales"]);
                state.sessions.with(|sessions| {
                    assert!(sessions.active.as_ref().unwrap().execution.is_none())
                });
                state.plugins.close();
                return;
            }
            assert_eq!(observation["view"]["phase"], "completed", "{observation}");
            assert!(observation["currentTask"].is_null());
            assert_eq!(observation["view"]["steps"][index]["phase"], "proved");
            if index == 0 {
                assert_eq!(observation["view"]["steps"][1]["phase"], "not-selected");
            } else {
                assert!(
                    observation["view"]["steps"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|s| s["phase"] == "proved" && s["proof"]["valid"] == true)
                );
            }
            assert_eq!(observation["steps"][0]["outcome"], "enqueued");
            assert_eq!(observation["steps"][0]["proof"]["valid"], true);
            assert!(observation["steps"][0]["proof"]["checks"].is_array());
            let original_start = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"start":start});
            assert_eq!(
                call(&window, "start_artifact_check_workflow", original_start).unwrap(),
                observation["view"]
            );
            let mut changed = start.clone();
            changed["consents"][0]["grantId"] = json!(ExecutionId::new());
            assert!(call(&window, "start_artifact_check_workflow", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"start":changed})).is_err());
            assert!(
                call(&window, "list_releases", context.clone())
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "checks never record or export a release"
            );
            if index == 0 {
                assert!(
                    call(&window, "adopt_execution", action_request.clone()).is_err(),
                    "unselected locale still needs its own proof"
                );
            }
            // The old stop observes only its own consumed identity.
            call(&window, "stop_artifact_check_workflow", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"identity":stopped_identity})).unwrap();
        }
    } else {
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
    }
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
                .release_artifact_by_path(
                    release,
                    locale,
                    &format!("deliverables/{locale}/content.txt"),
                )
                .unwrap();
            assert_eq!(bytes, format!("\u{feff}Saved {locale} 👩🏽‍💻\r\n").as_bytes());
        }
    });
    // The native picker authority is injected only by the test owner. All
    // subsequent preview/export/reconcile calls use registered production IPC.
    let destination = temporary.path().join("delivery");
    fs::create_dir(&destination).unwrap();
    let selected = Arc::new(source::capture::Selection::authorize(destination.clone()).unwrap());
    let selection_id = ExecutionId::new();
    let held = selected.clone();
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .release
            .selection = Some((selection_id, held));
    });
    let delivery_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
        "releaseId":release,"selectionId":selection_id});
    let preview = call(&window, "preview_delivery", delivery_request.clone()).unwrap();
    assert_eq!(preview["files"].as_array().unwrap().len(), 4);
    assert!(
        preview["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|file| file["state"] == "absent")
    );
    assert_eq!(
        fs::read_dir(&destination).unwrap().count(),
        0,
        "preview creates no output directory"
    );
    let mut export = delivery_request.clone();
    export["previewId"] = preview["previewId"].clone();
    export["actionId"] = json!(ExecutionId::new());
    export["overwriteConflicts"] = json!(false);
    let delivery = call(&window, "export_release", export.clone()).unwrap();
    assert_eq!(delivery["state"], "succeeded");
    assert_eq!(delivery["files"].as_array().unwrap().len(), 4);
    assert_eq!(
        call(&window, "export_release", export.clone()).unwrap(),
        delivery
    );
    for locale in ["zh-CN", "fr-FR"] {
        assert_eq!(
            fs::read(destination.join(format!("deliverables/{locale}/content.txt"))).unwrap(),
            format!("\u{feff}Saved {locale} 👩🏽‍💻\r\n").as_bytes()
        );
        assert!(
            fs::read(destination.join(format!("{locale}.meta")))
                .unwrap()
                .starts_with(b"[")
        );
    }
    let preview = call(&window, "preview_delivery", delivery_request.clone()).unwrap();
    assert!(
        preview["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|file| file["state"] == "same")
    );
    // A changed second file of the same locale is matched by path as well.
    fs::write(destination.join("zh-CN.meta"), b"external metadata").unwrap();
    export["previewId"] = preview["previewId"].clone();
    export["actionId"] = json!(ExecutionId::new());
    assert!(call(&window, "export_release", export.clone()).is_err());
    let mut reconcile = context.clone();
    reconcile["actionId"] = export["actionId"].clone();
    reconcile["selectionId"] = json!(selection_id);
    let failed = call(&window, "read_delivery_action", reconcile.clone()).unwrap();
    assert_eq!(failed["state"], "failed");
    let metadata = failed["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["locale"] == "zh-CN" && file["fileName"] == "zh-CN.meta")
        .unwrap();
    assert_eq!(
        metadata["actualSha256"],
        artifact_digest(b"external metadata")
    );
    assert_eq!(
        fs::read(destination.join("zh-CN.meta")).unwrap(),
        b"external metadata"
    );
    let conflict = call(&window, "preview_delivery", delivery_request.clone()).unwrap();
    export["previewId"] = conflict["previewId"].clone();
    export["actionId"] = json!(ExecutionId::new());
    assert!(call(&window, "export_release", export.clone()).is_err());
    assert!(call(&window, "read_delivery_action", json!({"actionId":export["actionId"],
        "selectionId":selection_id,"sessionToken":context["sessionToken"],"projectId":context["projectId"]})).unwrap().is_null());
    export["overwriteConflicts"] = json!(true);
    assert_eq!(
        call(&window, "export_release", export).unwrap()["state"],
        "succeeded"
    );
    // Simulate a lost completion receipt using the real Core action owner.
    let pending_action = ExecutionId::new();
    let root = selected.destination_path().to_string_lossy().into_owned();
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .store
            .begin_delivery(pending_action, release, &root, false)
            .unwrap();
    });
    reconcile["actionId"] = json!(pending_action);
    assert_eq!(
        call(&window, "reconcile_delivery", reconcile).unwrap()["state"],
        "succeeded"
    );
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
    assert_eq!(
        call(&window, "list_releases", context.clone()).unwrap(),
        releases
    );
    state.plugins.close();
    let historical = call(&window, "read_saved_plugin_build", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"attemptId":attempt})).unwrap();
    assert_eq!(historical["inputDigest"], saved_build["inputDigest"]);
    assert_eq!(
        historical["sourceSnapshotId"],
        saved_build["sourceSnapshotId"]
    );
    assert_eq!(historical["build"], saved_build["build"]);
    for (current, original) in historical["locales"]
        .as_array()
        .unwrap()
        .iter()
        .zip(saved_build["locales"].as_array().unwrap())
    {
        assert_eq!(current["choice"], original["choice"]);
        assert_eq!(current["targetCount"], original["targetCount"]);
        assert_eq!(current["result"], original["result"]);
    }
    state.sessions.with(|sessions| {
        assert!(
            sessions.active.as_ref().unwrap().execution.is_none(),
            "history must not initialize an execution epoch"
        );
    });
    // Release export has no dependency on the current package/runtime manager.
    let held = selected;
    let selection_id = ExecutionId::new();
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .release
            .selection = Some((selection_id, held));
    });
    let preview_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
        "releaseId":release,"selectionId":selection_id});
    let preview = call(&window, "preview_delivery", preview_request.clone()).unwrap();
    let mut export = preview_request;
    export["previewId"] = preview["previewId"].clone();
    export["actionId"] = json!(ExecutionId::new());
    export["overwriteConflicts"] = json!(false);
    assert_eq!(
        call(&window, "export_release", export).unwrap()["state"],
        "succeeded"
    );
    // A dropped command future is not cancellation of an already admitted action.
    let mut preview_request = context.clone();
    preview_request["releaseId"] = json!(release);
    preview_request["selectionId"] = json!(selection_id);
    let preview = call(&window, "preview_delivery", preview_request.clone()).unwrap();
    let dropped_action = ExecutionId::new();
    preview_request["previewId"] = preview["previewId"].clone();
    preview_request["actionId"] = json!(dropped_action);
    preview_request["overwriteConflicts"] = json!(false);
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let mut waiting = Box::pin(export_release(
        app.state(),
        serde_json::from_value(preview_request).unwrap(),
    ));
    assert!(matches!(
        waiting
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(waiting);
    let read = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
        "selectionId":selection_id,"actionId":dropped_action});
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let delivery = call(&window, "read_delivery_action", read.clone()).unwrap();
        if delivery["state"] == "succeeded" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "accepted export lost its completion: {delivery}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    // Real SQLite failure after a newly written file leaves the original
    // pending action for read-only reconciliation, rather than replaying bytes.
    let target = destination.join("deliverables/zh-CN/content.txt");
    fs::remove_file(&target).unwrap();
    let preview_request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
        "selectionId":selection_id,"releaseId":release});
    let preview = call(&window, "preview_delivery", preview_request.clone()).unwrap();
    let connection = rusqlite::Connection::open(directory.join("project.sqlite3")).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_delivery_completion BEFORE UPDATE ON release_deliveries
        BEGIN SELECT RAISE(FAIL, 'synthetic delivery completion failure'); END;",
        )
        .unwrap();
    let action = ExecutionId::new();
    let mut export = preview_request;
    export["previewId"] = preview["previewId"].clone();
    export["actionId"] = json!(action);
    export["overwriteConflicts"] = json!(false);
    let error = call(&window, "export_release", export.clone()).unwrap_err();
    assert_eq!(error["code"], "outcome-unknown");
    assert_eq!(error["recoveryRequired"], true);
    assert_eq!(
        fs::read(&target).unwrap(),
        "\u{feff}Saved zh-CN 👩🏽‍💻\r\n".as_bytes()
    );
    let modified = fs::metadata(&target).unwrap().modified().unwrap();
    let read = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
        "selectionId":selection_id,"actionId":action});
    assert_eq!(
        call(&window, "read_delivery_action", read.clone()).unwrap()["state"],
        "pending"
    );
    assert_eq!(
        call(&window, "export_release", export).unwrap_err()["code"],
        "outcome-unknown"
    );
    connection
        .execute_batch("DROP TRIGGER fail_delivery_completion;")
        .unwrap();
    drop(connection);
    assert_eq!(
        call(&window, "reconcile_delivery", read).unwrap()["state"],
        "succeeded"
    );
    assert_eq!(
        fs::metadata(&target).unwrap().modified().unwrap(),
        modified,
        "reconciliation does not rewrite the file"
    );
    let history = call(
        &window,
        "list_deliveries",
        json!({"sessionToken":context["sessionToken"],
        "projectId":context["projectId"],"releaseId":release}),
    )
    .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 7);

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
