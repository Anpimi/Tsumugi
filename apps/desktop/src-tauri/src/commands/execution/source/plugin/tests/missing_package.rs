//! Actual included-package execution, exact removal and generic reuse.
//! Only window transport and directory picker results are synthetic.
use super::{
    native::{call, completed, consent, consents, scoped},
    *,
};
use crate::commands::plugins::{
    PluginApprovalRemovalRequest, PluginBuildRequest, PluginInventoryView, PluginObjectState,
    PluginOriginView, PluginPackageRequest, PluginUninstallRequest,
};
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};
use tauri::Manager;
use tsumugi_core::{content::SourceBundle, execution::FixedResult};
use tsumugi_plugin_host::{
    ApprovedPackageSetting, PackageImage, PackageStore, PluginSettingsUpdate, RuntimeApproval,
    catalog::{PackageApproval, PackageCatalog},
};

mod runtime_fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/plugin-host/tests/support/runtime.rs"
    ));
}

struct OwnedDirectory {
    directory: Option<tempfile::TempDir>,
    removable: Arc<AtomicBool>,
    retain_on_failure: bool,
}
impl OwnedDirectory {
    fn new(retain_on_failure: bool) -> Self {
        Self {
            directory: Some(tempfile::tempdir().unwrap()),
            removable: Arc::new(AtomicBool::new(true)),
            retain_on_failure,
        }
    }
    fn path(&self) -> &Path {
        self.directory.as_ref().unwrap().path()
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        fn removable(path: &Path) -> std::io::Result<()> {
            let metadata = fs::symlink_metadata(path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
                for entry in fs::read_dir(path)? {
                    removable(&entry?.path())?;
                }
            }
            Ok(())
        }
        let directory = self.directory.take().unwrap();
        let error = if self.retain_on_failure && std::thread::panicking() {
            Some("missing-installation fixture failed; original evidence retained".into())
        } else if self.removable.load(Ordering::Acquire) {
            removable(directory.path())
                .err()
                .map(|error| error.to_string())
        } else {
            Some("original execution and installation owners did not confirm teardown".into())
        };
        if let Some(error) = error {
            eprintln!(
                "owned journey retained at {}: {error}",
                directory.path().display()
            );
            std::mem::forget(directory);
            if !std::thread::panicking() {
                panic!("owned journey cleanup failed: {error}");
            }
        }
    }
}

/// Retains the original application through bounded cancellation, producer join
/// and project close. Failed cleanup never removes a worker's captured files.
struct ApplicationCleanup {
    handle: tauri::AppHandle<tauri::test::MockRuntime>,
    removable: Arc<AtomicBool>,
    staging: PathBuf,
    parked_installation: Option<PathBuf>,
}
impl ApplicationCleanup {
    fn new(
        app: &tauri::App<tauri::test::MockRuntime>,
        owned: &OwnedDirectory,
        staging: &Path,
    ) -> Self {
        owned.removable.store(false, Ordering::Release);
        Self {
            handle: app.handle().clone(),
            removable: owned.removable.clone(),
            staging: staging.to_path_buf(),
            parked_installation: None,
        }
    }
    fn require_released_staging(&self) -> Result<(), String> {
        // A joined Rust producer can retain an instance namespace when child
        // reap or captured-file cleanup was not confirmed.
        for entry in fs::read_dir(&self.staging)
            .map_err(|error| format!("owned staging inspection: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("owned staging entry inspection: {error}"))?;
            if entry
                .file_name()
                .as_encoded_bytes()
                .starts_with(b"plugin-instance-")
            {
                return Err(format!(
                    "original worker instance namespace retained at {}",
                    entry.path().display()
                ));
            }
        }
        Ok(())
    }
    fn reclaim(&self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut package_core_drained = false;
        loop {
            let (sender, receiver) = mpsc::sync_channel(1);
            let response =
                self.handle
                    .state::<AppState>()
                    .sessions
                    .lease(CommandStage::ExecutionCancel)
                    .map_err(|error| format!("teardown admission: {error:?}"))?
                    .submit(
                        "missing_package_test.teardown",
                        CommandStage::ExecutionCancel,
                        move |sessions| {
                            let result = (|| -> Result<(bool, bool), String> {
                                let package_idle = sessions.package_operation.is_none();
                                let Some(active) = sessions.active.as_mut() else {
                                    return Ok((package_idle, package_core_drained));
                                };
                                if let Some(host) = active.execution.as_mut() {
                                    if host.package_lifecycle_active() {
                                        // A retained removal holds its original request. Stop
                                        // actual Core workers without forging its completion
                                        // or clearing the application/session package hold.
                                        if !package_core_drained {
                                            match host.runtime.begin_quiesce(&mut active.store) {
                                                Ok(()) => {}
                                                Err(error) if error.code == ErrorCode::Busy => {}
                                                Err(error) => {
                                                    return Err(format!(
                                                        "teardown cancellation: {error:?}"
                                                    ));
                                                }
                                            }
                                            match host.runtime.finish_quiesce(&mut active.store) {
                                                Ok(()) => package_core_drained = true,
                                                Err(error) if error.code == ErrorCode::Busy => {}
                                                Err(error) => {
                                                    return Err(format!(
                                                        "teardown producer join: {error:?}"
                                                    ));
                                                }
                                            }
                                        }
                                        return Ok((false, package_core_drained));
                                    }
                                    if !host.quiescing {
                                        host.begin_quiesce(&mut active.store).map_err(|error| {
                                            format!("teardown cancellation: {error:?}")
                                        })?;
                                    }
                                    match host.tick(&mut active.store) {
                                        Ok(()) => {}
                                        Err(error) if error.code == CommandErrorCode::Busy => {
                                            return Ok((false, package_core_drained));
                                        }
                                        Err(error) => {
                                            return Err(format!("teardown owner tick: {error:?}"));
                                        }
                                    }
                                    if host.active(&active.store).map_err(|error| {
                                        format!("teardown currentness: {error:?}")
                                    })? {
                                        return Ok((false, package_core_drained));
                                    }
                                }
                                if !package_idle {
                                    return Ok((false, package_core_drained));
                                }
                                let token = active.token.clone();
                                match sessions.close(CloseProjectRequest {
                                    session_token: token,
                                }) {
                                    Ok(_) => Ok((true, package_core_drained)),
                                    Err(error) if error.code == CommandErrorCode::Busy => {
                                        Ok((false, package_core_drained))
                                    }
                                    Err(error) => Err(format!("teardown project close: {error:?}")),
                                }
                            })();
                            let _ = sender.send(result);
                            Ok(())
                        },
                    )
                    .map_err(|error| format!("teardown dispatch: {error:?}"))?;
            let (closed, drained) = receiver
                .recv_timeout(Duration::from_secs(1))
                .map_err(|error| format!("teardown original owner reply: {error}"))??;
            drop(response);
            package_core_drained = drained;
            if closed {
                let state = self.handle.state::<AppState>();
                state.plugins.close();
                state
                    .plugins
                    .dispose_closed_store_for_test()
                    .map_err(|error| format!("teardown closed Store: {error:?}"))?;
                self.require_released_staging()?;
                if let Some(parking) = &self.parked_installation {
                    return Err(format!(
                        "fixture installation restoration was not confirmed; original parking at {}",
                        parking.display()
                    ));
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("original workers, continuations or retained package request did not drain within teardown limit".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for ApplicationCleanup {
    fn drop(&mut self) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.handle.state::<AppState>().disconnect_change_events();
            self.reclaim()
        }))
        .unwrap_or_else(|_| {
            Err("original-owner teardown panicked before confirming resource release".into())
        });
        match result {
            Ok(()) => self.removable.store(true, Ordering::Release),
            Err(error) => {
                eprintln!("owned journey teardown failed; retaining fixture directory: {error}");
                if !std::thread::panicking() {
                    panic!("owned journey teardown failed: {error}");
                }
            }
        }
    }
}

#[derive(Clone)]
struct Frames {
    input: FixedInput,
    results: Vec<FixedResult>,
}
fn stored_frames(store: &ProjectStore) -> Vec<Frames> {
    let mut after = Revision::new(0).unwrap();
    let mut frames = Vec::new();
    loop {
        let tasks = store.execution_tasks(after, 50).unwrap();
        if tasks.is_empty() {
            break;
        }
        after = tasks.last().unwrap().sequence;
        for task in tasks {
            for attempt in store.execution_attempt_ids(task.task_id).unwrap() {
                let input = store.execution_input(attempt).unwrap();
                let results = store
                    .execution_attempt(attempt, false)
                    .unwrap()
                    .items
                    .into_iter()
                    .map(|item| {
                        let result = store
                            .execution_current_result(attempt, item.item_id)
                            .unwrap()
                            .unwrap();
                        store.execution_result(attempt, result).unwrap()
                    })
                    .collect();
                frames.push(Frames { input, results });
            }
        }
        assert!(
            frames.len() <= 5,
            "this journey admits exactly five independent executions"
        );
    }
    frames.sort_by_key(|frame| frame.input.envelope().attempt_id);
    frames
}
fn unchanged_frames(store: &ProjectStore, original: &[Frames]) {
    let current = stored_frames(store);
    assert_eq!(
        current.len(),
        original.len(),
        "denied preparations must not enqueue an input"
    );
    for (old, current) in original.iter().zip(current) {
        assert_eq!(
            current.input.envelope().attempt_id,
            old.input.envelope().attempt_id
        );
        assert_eq!(current.input.bytes(), old.input.bytes());
        assert_eq!(current.input.digest(), old.input.digest());
        assert_eq!(current.results.len(), old.results.len());
        for (old, current) in old.results.iter().zip(current.results) {
            assert_eq!(current.envelope().result_id, old.envelope().result_id);
            assert_eq!(current.bytes(), old.bytes());
            assert_eq!(current.digest(), old.digest());
        }
    }
}
fn idle(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, context: &Value) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let status = call(window, "execution_status", context.clone()).unwrap();
        assert!(
            status["error"].is_null(),
            "original execution failed to settle: {status}"
        );
        if status["active"] == false {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "original execution did not settle: {status}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn one_result(detail: &Value) -> Value {
    assert_eq!(detail["items"].as_array().unwrap().len(), 1);
    assert!(detail["items"][0]["resultId"].is_string());
    detail["items"][0]["resultId"].clone()
}

struct Materials {
    plugin: &'static str,
    profile_id: &'static str,
    files: &'static [(&'static str, &'static str)],
    source_text: &'static str,
    locale: &'static str,
    old_text: &'static str,
    new_text: &'static str,
    output_path: &'static str,
    output: fn(&str) -> Vec<u8>,
    rules: [&'static str; 2],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PackageLoss {
    ExactUninstall,
    MissingInstallation,
}
impl PackageLoss {
    fn rejection(self) -> (&'static str, &'static str) {
        match self {
            Self::ExactUninstall => ("permission-denied", "plugin-approval-mismatch"),
            Self::MissingInstallation => ("dependency-conflict", "plugin-package-missing"),
        }
    }
}

fn require_absent(path: &Path) {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        other => panic!(
            "fixture rename target must be absent at {}: {other:?}",
            path.display()
        ),
    }
}

fn move_fixture_installation(source: &Path, target: &Path, receipt_bytes: &[u8]) {
    require_absent(target);
    let metadata = fs::symlink_metadata(source).unwrap();
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    assert_eq!(metadata.permissions().mode() & 0o7777, 0o500);
    assert_eq!(
        fs::read(source.join("receipt.json")).unwrap().as_slice(),
        receipt_bytes
    );
    // macOS requires this owned wrapper to be writable for a cross-parent
    // rename. Only its envelope's mode changes; captured content is untouched.
    fs::set_permissions(source, fs::Permissions::from_mode(0o700)).unwrap();
    require_absent(target);
    fs::rename(source, target).unwrap();
    fs::set_permissions(target, fs::Permissions::from_mode(0o500)).unwrap();
    require_absent(source);
    let metadata = fs::symlink_metadata(target).unwrap();
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    assert_eq!(metadata.permissions().mode() & 0o7777, 0o500);
    assert_eq!(
        fs::read(target.join("receipt.json")).unwrap().as_slice(),
        receipt_bytes
    );
}

fn journey(material: Materials, loss: PackageLoss) {
    let locale = material.locale;
    let output_path = material.output_path;
    let source_text = material.source_text;
    let old_text = material.old_text;
    let new_text = material.new_text;
    let expected_profile = tsumugi_plugin_sdk::ContractRef {
        id: material.profile_id.into(),
        schema_version: 1,
        behavior_version: 1,
    };
    let owned = OwnedDirectory::new(loss == PackageLoss::MissingInstallation);
    let pin = crate::plugin_bundle::selection()
        .unwrap()
        .packages
        .into_iter()
        .find(|pin| pin.id == material.plugin)
        .unwrap();
    let package_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/bundled-plugins")
        .join(&pin.id);
    let image =
        PackageImage::capture_directory(&package_path, &pin.package_digest, || true).unwrap();
    assert_eq!(image.manifest().manifest().plugin, pin.plugin);
    let approval = PackageApproval {
        plugin: pin.plugin,
        package_digest: pin.package_digest,
        origin: crate::plugin_bundle::bundled_origin(),
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    let runtime = runtime_fixture::approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let mut installation =
        PackageStore::provision(owned.path(), &["application", "plugins"], || true).unwrap();
    let original_install_action = ExecutionId::new();
    let receipt = installation
        .install(
            &original_install_action.to_string(),
            catalog.registered(&approval.plugin).unwrap(),
            || true,
        )
        .unwrap();
    installation
        .install_runtime(
            &ExecutionId::new().to_string(),
            &runtime,
            &runtime_approval,
            || true,
        )
        .unwrap();
    let original_settings_action = ExecutionId::new();
    installation
        .update_settings(
            0,
            &original_settings_action.to_string(),
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
    assert_eq!(receipt.action_id(), original_install_action.to_string());
    assert_eq!(receipt.plugin(), &approval.plugin);
    assert_eq!(receipt.package_digest(), approval.package_digest);
    assert_eq!(receipt.origin(), &approval.origin);
    drop(installation);
    drop(runtime);
    drop(catalog);
    let package = PluginPackageRequest {
        plugin: receipt.plugin().clone(),
        package_digest: receipt.package_digest().into(),
    };
    let environment = runtime_approval.environment.digest().unwrap();
    let source_choice = PluginSourceRequest {
        package: package.clone(),
        resource_id: "source-profile".into(),
        environment_digest: environment.clone(),
    };
    let build_choice = PluginBuildRequest {
        package: package.clone(),
        resource_id: "build-profile".into(),
        environment_digest: environment.clone(),
    };
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let application = owned.path().join("application");
    let mut cleanup = ApplicationCleanup::new(&app, &owned, &application);
    let state = app.state::<AppState>();
    state.plugins.configure(application).unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let source_view = call(&window, "read_plugin_source", json!(&source_choice)).unwrap();
    assert_eq!(
        source_view["declaration"]["reviewResource"],
        "review-profile"
    );
    assert_eq!(source_view["environmentDigest"], environment);
    assert_eq!(
        source_view["declaration"]["profile"],
        json!(&expected_profile)
    );
    let project_path = owned.path().join("project");
    let project = call(&window, "create_project", json!({"destination":project_path,"displayName":"Missing package acceptance","sourceLocale":"en-US","targetLocales":[locale]})).unwrap();
    let mut context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let directory = owned.path().join("materials");
    fs::create_dir(&directory).unwrap();
    for &(path, raw) in material.files {
        let path = directory.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, raw).unwrap();
    }
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
    let source_start = consent(&context, &preflight);
    let source_attempt = call(&window, "start_plugin_source", source_start.clone()).unwrap();
    let source_result = one_result(&completed(&window, &context, &source_attempt));
    let preview = call(
        &window,
        "read_source_preview",
        scoped(
            &context,
            json!({"attemptId":source_attempt,"resultId":source_result,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    assert_eq!(preview["rows"].as_array().unwrap().len(), 1);
    assert_eq!(preview["rows"][0]["occurrence"]["text"], source_text);
    let source_adoption = ExecutionId::new();
    call(&window, "prepare_source_adoption", scoped(&context, json!({"attemptId":source_attempt,"resultId":source_result,"actionId":source_adoption,"confirmation":preview["confirmation"]}))).unwrap();
    let source_check = call(&window, "prepare_source_check", scoped(&context, json!({"sourceAttemptId":source_attempt,"sourceResultId":source_result,"attemptId":ExecutionId::new(),"source":source_choice}))).unwrap();
    let source_check_start = consent(&context, &source_check);
    assert_ne!(source_check_start["grantId"], source_start["grantId"]);
    let source_checked = call(&window, "start_source_check", source_check_start.clone()).unwrap();
    let source_checked_result = one_result(&completed(&window, &context, &source_checked));
    call(
        &window,
        "finish_source_check",
        scoped(
            &context,
            json!({"attemptId":source_checked,"resultId":source_checked_result}),
        ),
    )
    .unwrap();
    call(
        &window,
        "adopt_execution",
        scoped(&context, json!({"actionId":source_adoption})),
    )
    .unwrap();
    let scope = call(&window, "read_content_scope", context.clone()).unwrap();
    let snapshot_id: ExecutionId =
        serde_json::from_value(scope["currentSnapshot"].clone()).unwrap();
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
    let unit = page["rows"][0]["unitId"].clone();
    let source_revision = page["rows"][0]["sourceRevisionId"].clone();
    let first_manual = call(&window, "save_translation_revision", scoped(&context, json!({"actionId":ExecutionId::new(),"unitId":unit,"locale":locale,"sourceRevisionId":source_revision,"expectedSelectionId":null,"text":old_text}))).unwrap();
    assert_eq!(first_manual["revision"]["text"], old_text);
    assert_eq!(first_manual["revision"]["originKind"], "manual");
    let target_fields = json!({"unitId":unit,"locale":locale});
    let target = call(
        &window,
        "read_review_target",
        scoped(&context, target_fields.clone()),
    )
    .unwrap();
    let qa_intent = scoped(
        &context,
        json!({"unitId":unit,"locale":locale,"expectedBasis":target["basis"],"actionId":ExecutionId::new(),"advisoryChecks":[]}),
    );
    let qa = call(&window, "prepare_review_checks", qa_intent.clone()).unwrap();
    assert_eq!(qa["kind"], "plugin");
    assert_eq!(qa["view"]["checkers"].as_array().unwrap().len(), 1);
    assert_eq!(
        qa["view"]["checkers"][0]["plugin"]["plugin"]["environmentDigest"],
        environment
    );
    let qa_starts = consents(&context, &qa["view"]);
    let qa_attempt = qa_starts[0]["attemptId"].clone();
    let checked = call(
        &window,
        "run_review_checks",
        scoped(&context, json!({"check":qa_intent,"executions":qa_starts})),
    )
    .unwrap();
    assert_eq!(checked["outcome"], "completed");
    one_result(&completed(&window, &context, &qa_attempt));
    let checked_target = call(
        &window,
        "read_review_target",
        scoped(&context, target_fields.clone()),
    )
    .unwrap();
    assert_eq!(checked_target["currentCheck"], checked);
    let rules = checked["rules"].as_array().unwrap();
    assert!(
        rules.iter().all(|rule| rule["status"] == "passed"),
        "{checked}"
    );
    assert_eq!(
        rules
            .iter()
            .map(|rule| rule["rule"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        [
            "required-translation",
            "terminology",
            material.rules[0],
            material.rules[1]
        ]
        .into_iter()
        .collect()
    );
    let decision = call(&window, "write_review_decision", scoped(&context, json!({"decision":{"projectId":context["projectId"],"unitId":unit,"locale":locale,"expectedBasis":checked_target["basis"],"expectedDecisionId":null,"actor":"Synthetic reviewer","kind":"approve","reason":"Checked exact selection","actionId":ExecutionId::new()}}))).unwrap();
    let eligibility = call(
        &window,
        "read_review_eligibility",
        scoped(&context, json!({"locales":[locale]})),
    )
    .unwrap();
    assert_eq!(eligibility["ready"], true);
    let build_fields = json!({"build":build_choice,"expectedEligibilityBasis":eligibility["basis"],"choices":[{"locale":locale,"outputPaths":[output_path],"configuration":[]}]});
    let mut build_request = scoped(&context, build_fields.clone());
    build_request["attemptId"] = json!(ExecutionId::new());
    let build = call(&window, "prepare_plugin_build", build_request).unwrap();
    let build_start = consent(&context, &build);
    let built = call(&window, "start_plugin_build", build_start.clone()).unwrap();
    let built_detail = completed(&window, &context, &built);
    let build_result = one_result(&built_detail);
    let release_action = ExecutionId::new();
    call(&window, "prepare_execution_adoption", scoped(&context, json!({"attemptId":built,"unitId":built_detail["recovery"]["units"][0]["unitId"],"resultIds":[build_result],"actionId":release_action}))).unwrap();
    let artifact_check = call(&window, "prepare_artifact_check", scoped(&context, json!({"buildAttemptId":built,"buildResultId":build_result,"attemptId":ExecutionId::new(),"build":build_choice}))).unwrap();
    let artifact_start = consent(&context, &artifact_check);
    assert_ne!(artifact_start["grantId"], build_start["grantId"]);
    let artifact_checked = call(&window, "start_artifact_check", artifact_start.clone()).unwrap();
    let artifact_result = one_result(&completed(&window, &context, &artifact_checked));
    call(
        &window,
        "finish_artifact_check",
        scoped(
            &context,
            json!({"attemptId":artifact_checked,"resultId":artifact_result}),
        ),
    )
    .unwrap();
    let release_receipt = call(
        &window,
        "adopt_execution",
        scoped(&context, json!({"actionId":release_action})),
    )
    .unwrap();
    assert_eq!(
        call(
            &window,
            "adopt_execution",
            scoped(&context, json!({"actionId":release_action}))
        )
        .unwrap(),
        release_receipt
    );
    idle(&window, &context);
    let grants = [
        &source_start,
        &source_check_start,
        &qa_starts[0],
        &build_start,
        &artifact_start,
    ]
    .into_iter()
    .map(|request| request["grantId"].as_str().unwrap())
    .collect::<BTreeSet<_>>();
    assert_eq!(
        grants.len(),
        5,
        "each real execution uses an independent explicit grant"
    );
    let releases = call(&window, "list_releases", context.clone()).unwrap();
    assert_eq!(releases.as_array().unwrap().len(), 1);
    let release_id: ExecutionId = serde_json::from_value(releases[0]["releaseId"].clone()).unwrap();
    let expected = (material.output)(old_text);
    let expected_digest = tsumugi_core::content::artifact_digest(&expected);
    let frames = state
        .sessions
        .with(|sessions| stored_frames(&sessions.active.as_ref().unwrap().store));
    let expected_attempts = [
        &source_attempt,
        &source_checked,
        &qa_attempt,
        &built,
        &artifact_checked,
    ]
    .into_iter()
    .map(|value| serde_json::from_value::<ExecutionId>(value.clone()).unwrap())
    .collect::<BTreeSet<_>>();
    assert_eq!(frames.len(), 5);
    assert_eq!(
        frames
            .iter()
            .map(|frame| frame.input.envelope().attempt_id)
            .collect::<BTreeSet<_>>(),
        expected_attempts
    );
    for frame in &frames {
        let binding = frame.input.envelope().plugin.as_ref().unwrap();
        assert_eq!(binding.capability.provider.plugin, package.plugin);
        assert_eq!(
            binding.capability.provider.package_digest,
            package.package_digest
        );
        assert_eq!(binding.environment, runtime_approval.environment);
        assert_eq!(binding.profile.as_ref(), Some(&expected_profile));
        assert_eq!(
            frame.input.digest(),
            tsumugi_plugin_sdk::payload_digest(std::str::from_utf8(frame.input.bytes()).unwrap())
        );
        assert_eq!(frame.results.len(), 1);
        for result in &frame.results {
            assert_eq!(
                result.envelope().attempt_id,
                frame.input.envelope().attempt_id
            );
            assert_eq!(
                result
                    .envelope()
                    .plugin
                    .as_ref()
                    .unwrap()
                    .channel
                    .selection(),
                binding.capability.provider
            );
            assert_eq!(
                result.digest(),
                tsumugi_plugin_sdk::payload_digest(std::str::from_utf8(result.bytes()).unwrap())
            );
        }
    }
    let expected_bytes = expected.clone();
    let (source_bundle, release_view) = state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        let source = store.source_bundle(snapshot_id).unwrap();
        let release = store.release_view(release_id).unwrap();
        assert_eq!(
            store
                .release_artifact_by_path(release_id, locale, output_path)
                .unwrap()
                .1,
            expected_bytes
        );
        (source, release)
    });
    assert_eq!(source_bundle.profile, expected_profile);
    assert_eq!(source_bundle.files.len(), material.files.len());
    for &(path, raw) in material.files {
        let file = source_bundle
            .files
            .iter()
            .find(|file| file.logical_path == path)
            .unwrap();
        assert_eq!(file.utf8.as_bytes(), raw.as_bytes());
        assert_eq!(file.sha256, tsumugi_plugin_sdk::payload_digest(raw));
    }
    let source_content = call(
        &window,
        "read_source_content",
        scoped(
            &context,
            json!({"snapshotId":snapshot_id,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    let source_history = call(
        &window,
        "read_source_history",
        scoped(&context, json!({"offset":0,"limit":50})),
    )
    .unwrap();
    let translation_fields = json!({"unitId":unit,"locale":locale,"afterOrdinal":"0","limit":50});
    let first_history = call(
        &window,
        "read_translation_history",
        scoped(&context, translation_fields.clone()),
    )
    .unwrap();
    assert_eq!(first_history["rows"], json!([first_manual["revision"]]));
    let review_fields = json!({"unitId":unit,"locale":locale,"offset":0,"limit":50});
    let review_history = call(
        &window,
        "read_review_history",
        scoped(&context, review_fields.clone()),
    )
    .unwrap();
    assert_eq!(review_history["checks"], json!([checked]));
    assert_eq!(review_history["decisions"], json!([decision]));

    let installed: PluginInventoryView =
        serde_json::from_value(call(&window, "read_plugin_inventory", json!({})).unwrap()).unwrap();
    assert_eq!(installed.settings_revision.get(), 1);
    assert_eq!(
        installed.last_settings_action,
        Some(original_settings_action.to_string())
    );
    assert_eq!(installed.packages.len(), 1);
    let original = installed.packages[0].clone();
    assert_eq!(original.original_install_action, receipt.action_id());
    assert_eq!(original.plugin, *receipt.plugin());
    assert_eq!(original.package_digest, receipt.package_digest());
    assert_eq!(original.origin, PluginOriginView::from(receipt.origin()));
    assert_eq!(original.state, PluginObjectState::Sealed);
    assert!(installed.package_decisions[0].enabled);
    let object = owned
        .path()
        .join("application/plugins/objects")
        .join(receipt.package_digest());
    assert!(object.is_dir());
    let original_receipt_bytes = fs::read(object.join("receipt.json")).unwrap();
    let parking = owned.path().join("parked-original-installation");
    let unavailable = match loss {
        PackageLoss::ExactUninstall => {
            let withdrawal = PluginApprovalRemovalRequest {
                package: package.clone(),
                origin: original.origin.clone(),
                expected_revision: installed.settings_revision,
                action_id: ExecutionId::new(),
            };
            let withdrawn: PluginInventoryView = serde_json::from_value(
                call(&window, "remove_plugin_approval", json!(&withdrawal)).unwrap(),
            )
            .unwrap();
            assert_eq!(withdrawn.settings_revision.get(), 2);
            assert_eq!(
                withdrawn.last_settings_action,
                Some(withdrawal.action_id.to_string())
            );
            assert!(withdrawn.package_decisions.is_empty());
            assert_eq!(withdrawn.packages, installed.packages);
            assert_eq!(withdrawn.runtime_decisions, installed.runtime_decisions);
            assert!(
                object.is_dir(),
                "approval removal is separate from exact installation deletion"
            );
            let removal = PluginUninstallRequest {
                package,
                origin: original.origin.clone(),
                original_install_action: receipt.action_id().into(),
                expected_revision: withdrawn.settings_revision,
                action_id: ExecutionId::new(),
            };
            assert_ne!(removal.action_id, withdrawal.action_id);
            assert_ne!(removal.action_id, original_install_action);
            let removed: PluginInventoryView = serde_json::from_value(
                call(&window, "uninstall_plugin_package", json!(&removal)).unwrap(),
            )
            .unwrap();
            assert!(removed.packages.is_empty());
            assert!(removed.package_decisions.is_empty());
            assert_eq!(removed.settings_revision, withdrawn.settings_revision);
            assert_eq!(removed.last_settings_action, withdrawn.last_settings_action);
            assert_eq!(removed.runtimes, installed.runtimes);
            assert_eq!(removed.runtime_decisions, installed.runtime_decisions);
            assert_eq!(removed.uninstallations.len(), 1);
            assert_eq!(removed.uninstallations[0].installation, original);
            assert_eq!(
                removed.uninstallations[0].action_id,
                removal.action_id.to_string()
            );
            assert_eq!(
                removed.uninstallations[0].settings_revision,
                removal.expected_revision
            );
            assert_eq!(removed.uninstallations[0].state, PluginObjectState::Sealed);
            assert!(!object.exists());
            state
                .sessions
                .with(|sessions| assert!(sessions.package_operation.is_none()));
            call(
                &window,
                "close_project",
                json!({"sessionToken":context["sessionToken"]}),
            )
            .unwrap();
            removed
        }
        PackageLoss::MissingInstallation => {
            // This fixture changes only its owned installation leaf after the
            // original complete Host and Session have released their work.
            // Approval is deliberately retained; this is not an uninstall.
            cleanup.parked_installation = Some(parking.clone());
            call(&window, "quiesce_execution", context.clone()).unwrap();
            idle(&window, &context);
            call(
                &window,
                "close_project",
                json!({"sessionToken":context["sessionToken"]}),
            )
            .unwrap();
            state.sessions.with(|sessions| {
                assert!(sessions.active.is_none());
                assert!(sessions.package_operation.is_none());
            });
            cleanup.require_released_staging().unwrap();
            move_fixture_installation(&object, &parking, &original_receipt_bytes);
            let missing: PluginInventoryView =
                serde_json::from_value(call(&window, "read_plugin_inventory", json!({})).unwrap())
                    .unwrap();
            assert!(missing.packages.is_empty());
            assert!(missing.uninstallations.is_empty());
            assert_eq!(missing.settings_revision, installed.settings_revision);
            assert_eq!(missing.last_settings_action, installed.last_settings_action);
            assert_eq!(missing.package_decisions, installed.package_decisions);
            assert!(missing.package_decisions[0].enabled);
            assert_eq!(missing.runtimes, installed.runtimes);
            assert_eq!(missing.runtime_decisions, installed.runtime_decisions);
            assert_eq!(missing.runtime_offers, installed.runtime_offers);
            assert_eq!(missing.native_host_offer, installed.native_host_offer);
            assert_eq!(missing.defaults_offer, installed.defaults_offer);
            missing
        }
    };
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    assert_eq!(context["projectId"], project["metadata"]["projectId"]);
    assert_ne!(context["sessionToken"], project["sessionToken"]);
    assert_eq!(
        call(&window, "read_content_scope", context.clone()).unwrap(),
        scope
    );
    assert_eq!(
        call(
            &window,
            "read_source_content",
            scoped(
                &context,
                json!({"snapshotId":snapshot_id,"after":0,"limit":50})
            )
        )
        .unwrap(),
        source_content
    );
    assert_eq!(
        call(
            &window,
            "read_source_history",
            scoped(&context, json!({"offset":0,"limit":50}))
        )
        .unwrap(),
        source_history
    );
    assert_eq!(
        call(
            &window,
            "read_translation_history",
            scoped(&context, translation_fields.clone())
        )
        .unwrap(),
        first_history
    );
    assert_eq!(
        call(
            &window,
            "read_review_history",
            scoped(&context, review_fields.clone())
        )
        .unwrap(),
        review_history
    );
    assert_eq!(
        call(&window, "list_releases", context.clone()).unwrap(),
        releases
    );
    state.sessions.with(|sessions| {
        assert!(
            sessions.active.as_ref().unwrap().execution.is_none(),
            "generic saved reads must not initialize a Worker Host"
        )
    });
    let old_target = call(
        &window,
        "read_review_target",
        scoped(&context, target_fields.clone()),
    )
    .unwrap();
    assert_eq!(old_target["translationText"], old_text);
    assert_eq!(old_target["currentCheck"], checked);
    assert_eq!(old_target["currentDecision"], decision);
    let manual_request = scoped(
        &context,
        json!({"actionId":ExecutionId::new(),"unitId":unit,"locale":locale,"sourceRevisionId":source_revision,"expectedSelectionId":old_target["selectionId"],"text":new_text}),
    );
    let manual = call(&window, "save_translation_revision", manual_request.clone()).unwrap();
    assert_eq!(
        call(&window, "save_translation_revision", manual_request).unwrap(),
        manual
    );
    assert_eq!(manual["revision"]["text"], new_text);
    assert_eq!(manual["revision"]["originKind"], "manual");
    assert_ne!(
        manual["revision"]["revisionId"],
        first_manual["revision"]["revisionId"]
    );
    assert_ne!(
        manual["selection"]["eventId"],
        first_manual["selection"]["eventId"]
    );
    let new_target = call(
        &window,
        "read_review_target",
        scoped(&context, target_fields.clone()),
    )
    .unwrap();
    assert_eq!(new_target["sourceText"], source_text);
    assert_eq!(new_target["sourceRevisionId"], source_revision);
    assert_eq!(new_target["translationText"], new_text);
    assert_ne!(new_target["basis"], old_target["basis"]);
    assert!(new_target["currentCheck"].is_null());
    assert!(new_target["currentDecision"].is_null());
    assert_eq!(
        call(
            &window,
            "read_review_history",
            scoped(&context, review_fields.clone())
        )
        .unwrap(),
        review_history
    );
    let not_ready = call(
        &window,
        "read_review_eligibility",
        scoped(&context, json!({"locales":[locale]})),
    )
    .unwrap();
    assert_eq!(not_ready["ready"], false);
    assert_ne!(not_ready["basis"], eligibility["basis"]);
    let refused_qa_action = ExecutionId::new();
    let refused_qa = call(&window, "prepare_review_checks", scoped(&context, json!({"unitId":unit,"locale":locale,"expectedBasis":new_target["basis"],"actionId":refused_qa_action,"advisoryChecks":[]}))).unwrap_err();
    let (expected_code, expected_reason) = loss.rejection();
    assert_eq!(refused_qa["code"], expected_code);
    assert_eq!(refused_qa["reason"], expected_reason);
    assert_eq!(refused_qa["outcome"], "rejected");
    assert_eq!(refused_qa["recoveryRequired"], false);
    let refused_build_attempt = ExecutionId::new();
    let refused_build = call(&window, "prepare_plugin_build", scoped(&context, json!({"attemptId":refused_build_attempt,"build":build_choice,"expectedEligibilityBasis":not_ready["basis"],"choices":[{"locale":locale,"outputPaths":[output_path],"configuration":[]}]}))).unwrap_err();
    assert_eq!(refused_build["code"], expected_code);
    assert_eq!(refused_build["reason"], expected_reason);
    assert_eq!(refused_build["outcome"], "rejected");
    assert_eq!(refused_build["recoveryRequired"], false);
    let original_frames = frames.clone();
    let project_id: ExecutionId = serde_json::from_value(context["projectId"].clone()).unwrap();
    state.sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        unchanged_frames(&active.store, &original_frames);
        assert_eq!(
            active
                .store
                .execution_input(refused_build_attempt)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert!(
            active
                .store
                .review_check_action(project_id, refused_qa_action)
                .unwrap()
                .is_none()
        );
        let host = active.execution.as_ref().unwrap();
        assert!(
            host.plugin_registrations.is_empty(),
            "denied preparations cannot restore an unavailable provider"
        );
        assert!(!host.active(&active.store).unwrap());
    });
    let destination = owned.path().join("delivery");
    fs::create_dir(&destination).unwrap();
    let delivery_selection = ExecutionId::new();
    let selected = Arc::new(capture::Selection::authorize(destination.clone()).unwrap());
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .release
            .select_for_test(delivery_selection, selected);
    });
    let delivery_preview = call(
        &window,
        "preview_delivery",
        scoped(
            &context,
            json!({"releaseId":release_id,"selectionId":delivery_selection}),
        ),
    )
    .unwrap();
    assert_eq!(delivery_preview["files"].as_array().unwrap().len(), 1);
    assert_eq!(delivery_preview["files"][0]["state"], "absent");
    assert_eq!(
        delivery_preview["files"][0]["expectedSha256"],
        expected_digest
    );
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    let export_request = scoped(
        &context,
        json!({"releaseId":release_id,"selectionId":delivery_selection,"previewId":delivery_preview["previewId"],"actionId":ExecutionId::new(),"overwriteConflicts":false}),
    );
    let delivery = call(&window, "export_release", export_request.clone()).unwrap();
    assert_eq!(delivery["state"], "succeeded");
    assert_eq!(delivery["files"].as_array().unwrap().len(), 1);
    assert_eq!(delivery["files"][0]["actualSha256"], expected_digest);
    assert_eq!(
        call(&window, "export_release", export_request).unwrap(),
        delivery
    );
    assert_eq!(fs::read(destination.join(output_path)).unwrap(), expected);
    let final_history = call(
        &window,
        "read_translation_history",
        scoped(&context, translation_fields.clone()),
    )
    .unwrap();
    assert_eq!(final_history["total"], "2");
    assert_eq!(final_history["currentText"], new_text);
    assert_eq!(
        final_history["rows"],
        json!([first_manual["revision"], manual["revision"]])
    );
    idle(&window, &context);
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    assert_eq!(
        call(&window, "read_content_scope", context.clone()).unwrap(),
        scope
    );
    assert_eq!(
        call(
            &window,
            "read_source_content",
            scoped(
                &context,
                json!({"snapshotId":snapshot_id,"after":0,"limit":50})
            )
        )
        .unwrap(),
        source_content
    );
    assert_eq!(
        call(
            &window,
            "read_source_history",
            scoped(&context, json!({"offset":0,"limit":50}))
        )
        .unwrap(),
        source_history
    );
    assert_eq!(
        call(
            &window,
            "read_translation_history",
            scoped(&context, translation_fields.clone())
        )
        .unwrap(),
        final_history
    );
    assert_eq!(
        call(
            &window,
            "read_review_history",
            scoped(&context, review_fields.clone())
        )
        .unwrap(),
        review_history
    );
    assert_eq!(
        call(
            &window,
            "read_review_target",
            scoped(&context, target_fields.clone())
        )
        .unwrap(),
        new_target
    );
    assert_eq!(
        call(
            &window,
            "read_review_eligibility",
            scoped(&context, json!({"locales":[locale]}))
        )
        .unwrap(),
        not_ready
    );
    assert_eq!(
        call(&window, "list_releases", context.clone()).unwrap(),
        releases
    );
    assert_eq!(
        serde_json::from_value::<PluginInventoryView>(
            call(&window, "read_plugin_inventory", json!({})).unwrap()
        )
        .unwrap(),
        unavailable
    );
    let assert_saved_evidence = |state: &AppState| {
        let original_frames = frames.clone();
        let original_bundle: SourceBundle = source_bundle.clone();
        let original_release = release_view.clone();
        let expected_bytes = expected.clone();
        state.sessions.with(move |sessions| {
            let active = sessions.active.as_ref().unwrap();
            assert!(
                active.execution.is_none(),
                "reopened saved records do not create a Worker Host"
            );
            unchanged_frames(&active.store, &original_frames);
            assert_eq!(
                active.store.source_bundle(snapshot_id).unwrap(),
                original_bundle
            );
            assert_eq!(
                active.store.release_view(release_id).unwrap(),
                original_release
            );
            assert_eq!(
                active
                    .store
                    .release_artifact_by_path(release_id, locale, output_path)
                    .unwrap()
                    .1,
                expected_bytes
            );
        });
    };
    assert_saved_evidence(&state);
    assert_eq!(fs::read(destination.join(output_path)).unwrap(), expected);
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    if loss == PackageLoss::MissingInstallation {
        state.sessions.with(|sessions| {
            assert!(sessions.active.is_none());
            assert!(sessions.package_operation.is_none());
        });
        cleanup.require_released_staging().unwrap();
        // Only put this fixture's original object back. This is not an
        // application recovery operation or a renewed installation/approval.
        move_fixture_installation(&parking, &object, &original_receipt_bytes);
        assert_eq!(
            serde_json::from_value::<PluginInventoryView>(
                call(&window, "read_plugin_inventory", json!({})).unwrap()
            )
            .unwrap(),
            installed
        );
        assert_eq!(
            call(&window, "read_plugin_source", json!(&source_choice)).unwrap(),
            source_view
        );
        assert_eq!(
            call(&window, "read_plugin_build", json!(&build_choice)).unwrap(),
            build["build"]
        );
        state.sessions.with(|sessions| {
            assert!(
                sessions.active.is_none(),
                "capturing restored declarations does not open a project or grant execution"
            )
        });
        let restored = call(&window, "open_project", json!({"locator":project_path})).unwrap();
        context = json!({"sessionToken":restored["sessionToken"],"projectId":restored["metadata"]["projectId"]});
        for (command, fields, saved) in [
            ("read_content_scope", json!({}), scope.clone()),
            (
                "read_source_content",
                json!({"snapshotId":snapshot_id,"after":0,"limit":50}),
                source_content.clone(),
            ),
            (
                "read_source_history",
                json!({"offset":0,"limit":50}),
                source_history.clone(),
            ),
            (
                "read_translation_history",
                translation_fields.clone(),
                final_history.clone(),
            ),
            (
                "read_review_history",
                review_fields.clone(),
                review_history.clone(),
            ),
            (
                "read_review_target",
                target_fields.clone(),
                new_target.clone(),
            ),
            (
                "read_review_eligibility",
                json!({"locales":[locale]}),
                not_ready.clone(),
            ),
            ("list_releases", json!({}), releases.clone()),
        ] {
            assert_eq!(
                call(&window, command, scoped(&context, fields)).unwrap(),
                saved,
                "fixture restoration changed saved {command}"
            );
        }
        assert_saved_evidence(&state);
        assert_eq!(fs::read(destination.join(output_path)).unwrap(), expected);
        call(
            &window,
            "close_project",
            json!({"sessionToken":context["sessionToken"]}),
        )
        .unwrap();
        cleanup.require_released_staging().unwrap();
        // All original bytes, decisions and generic history were verified
        // after physical restoration; only now can normal teardown remove root.
        cleanup.parked_installation = None;
    }
    drop(state);
    drop(window);
    drop(cleanup);
    drop(app);
}

fn smapi_materials() -> Materials {
    Materials {
        plugin: "stardew-smapi",
        profile_id: "smapi-i18n-flat",
        files: &[
            (
                "manifest.json",
                r#"{"Name":"Synthetic mod","Author":"Synthetic","Version":"1.0.0","Description":"Synthetic acceptance input","UniqueID":"Synthetic.Included","EntryDll":"Synthetic.dll"}"#,
            ),
            ("i18n/default.json", "{\"message\":\"Hello {{name}} 👩🏽‍💻\"}"),
        ],
        source_text: "Hello {{name}} 👩🏽‍💻",
        locale: "zh-CN",
        old_text: "你好 {{name}} 👩🏽‍💻",
        new_text: "手工更新 {{name}} 👩🏽‍💻 e\u{301}",
        output_path: "i18n/zh.json",
        output: |text| {
            format!(
                "{{\n  \"message\": {}\n}}\n",
                serde_json::to_string(text).unwrap()
            )
            .into_bytes()
        },
        rules: ["plugin:smapi.placeholders", "plugin:smapi.format"],
    }
}

fn webvtt_materials() -> Materials {
    Materials {
        plugin: "webvtt",
        profile_id: "webvtt-captions",
        files: &[(
            "source.vtt",
            "WEBVTT\r\n\r\nCue\r\n00:00:01.000 --> 00:00:02.000\r\nHello 👩🏽‍💻\r\n\r\n",
        )],
        source_text: "Hello 👩🏽‍💻",
        locale: "zh-CN",
        old_text: "你好 👩🏽‍💻",
        new_text: "手工更新 👩🏽‍💻 e\u{301}",
        output_path: "zh-CN.vtt",
        output: |text| {
            format!("WEBVTT\r\n\r\nCue\r\n00:00:01.000 --> 00:00:02.000\r\n{text}\r\n\r\n")
                .into_bytes()
        },
        rules: ["plugin:webvtt.source-structure", "plugin:webvtt.payload"],
    }
}

#[test]
#[ignore = "requires explicit independently approved macOS arm64 Node tool, Host and runtime approval trees"]
fn actual_smapi_uninstall_preserves_manual_history_and_original_release_without_workers() {
    journey(smapi_materials(), PackageLoss::ExactUninstall);
}

#[test]
#[ignore = "requires explicit independently approved macOS arm64 Node tool, Host and runtime approval trees"]
fn actual_webvtt_uninstall_preserves_manual_history_and_original_release_without_workers() {
    journey(webvtt_materials(), PackageLoss::ExactUninstall);
}

#[test]
#[ignore = "requires explicit independently approved macOS arm64 Node tool, Host and runtime approval trees"]
fn actual_smapi_missing_installation_preserves_manual_history_and_original_release_without_workers()
{
    journey(smapi_materials(), PackageLoss::MissingInstallation);
}

#[test]
#[ignore = "requires explicit independently approved macOS arm64 Node tool, Host and runtime approval trees"]
fn actual_webvtt_missing_installation_preserves_manual_history_and_original_release_without_workers()
 {
    journey(webvtt_materials(), PackageLoss::MissingInstallation);
}
