//! Actual synthetic version promotion in one live project owner, then cold open.
//! This covers the plain Source consumer's fixed Core permit, not AI or Review
//! settings-consent policy, included-package compatibility or native GUI exit.
use super::{
    missing_package::OwnedDirectory,
    native::{call, completed, consent, scoped},
    upgrade, *,
};
use crate::commands::plugins::{
    PluginApprovalRemovalRequest, PluginEnableRequest, PluginInstallRequest, PluginInventoryView,
    PluginObjectState,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;
use tsumugi_core::{
    content::{SourceBundle, SourceSettings},
    execution::{DispatchRequest, ExecutionState, FixedResult, PluginConsent},
};
use tsumugi_plugin_host::{
    PackageFile, PackageImage, RuntimeApproval,
    catalog::{PackageApproval, PackageCatalog, PackageOrigin},
};
use tsumugi_plugin_sdk as sdk;

const RAW: &str = "MixedCase\tHello 👩🏽‍💻\r\n";
const TRANSLATION: &str = "旧译文 👩🏽‍💻 e\u{301}";
const LOCALE: &str = "zh-CN";
type Window = tauri::WebviewWindow<tauri::test::MockRuntime>;
type App = tauri::App<tauri::test::MockRuntime>;
type GrantRecord = (String, String, String, String, String, i64, i64, i64);

fn package(
    version: &str,
    behavior: u32,
    observations: &Path,
    candidate: &Path,
) -> (PackageImage, Vec<u8>, BTreeMap<String, PackageFile>) {
    let files = BTreeMap::from([
        (
            "upgrade.mjs".into(),
            PackageFile {
                bytes: include_bytes!("upgrade.mjs").to_vec(),
                executable: false,
            },
        ),
        (
            "lifecycle.json".into(),
            PackageFile {
                bytes: serde_json::to_vec(&json!({"observations":observations})).unwrap(),
                executable: false,
            },
        ),
    ]);
    let (manifest, files) = upgrade::image_files(
        version,
        behavior,
        include_bytes!("lifecycle_update.mjs"),
        files,
    );
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    let image = PackageImage::capture(manifest.clone(), files.clone(), &digest).unwrap();
    image.source_import("source-profile").unwrap();
    image.build_declaration("build-profile").unwrap();
    fs::create_dir(candidate).unwrap();
    fs::write(candidate.join("manifest.json"), &manifest).unwrap();
    for (path, file) in &files {
        // The shared fixture contains only flat, explicit synthetic files.
        assert_eq!(Path::new(path).components().count(), 1);
        assert!(!file.executable);
        fs::write(candidate.join(path), &file.bytes).unwrap();
    }
    (image, manifest, files)
}

fn observation(root: &Path, attempt: ExecutionId, suffix: &str) -> Value {
    let path = root.join(format!("{attempt}.{suffix}.json"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match fs::read(&path) {
            Ok(bytes) => return serde_json::from_slice(&bytes).unwrap(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("owned observation read failed: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "actual component did not write {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn child_alive(observation: &Value) -> bool {
    let pid = i32::try_from(observation["pid"].as_i64().unwrap()).unwrap();
    assert!(pid > 0);
    // Signal zero observes only the exact PID written by this fixture's child.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn stage(observation: &Value, application: &Path) -> PathBuf {
    let path = PathBuf::from(observation["stage"].as_str().unwrap());
    let application = application.canonicalize().unwrap();
    assert_eq!(path.parent(), Some(application.as_path()));
    assert!(
        path.file_name()
            .unwrap()
            .as_encoded_bytes()
            .starts_with(b"plugin-instance-")
    );
    let metadata = fs::symlink_metadata(&path).unwrap();
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    path
}

fn grant_record(project: &Path, grant: ExecutionId) -> GrantRecord {
    let connection = rusqlite::Connection::open_with_flags(
        project.join("project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    connection.query_row("SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked FROM plugin_execution_grants WHERE grant_id=?1",
        [grant.to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))).unwrap()
}

fn all_grants(project: &Path) -> Vec<GrantRecord> {
    let connection = rusqlite::Connection::open_with_flags(
        project.join("project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut statement = connection.prepare("SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked FROM plugin_execution_grants ORDER BY grant_id").unwrap();
    let records = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    records
}

fn assert_held(
    app: &App,
    dispatch: &DispatchRequest,
    observed: &Value,
    project: &Path,
    original: &GrantRecord,
) {
    let permit = dispatch.plugin_permit().unwrap();
    // The original guard checks its original monotonic/wall-clock expiry. No
    // lease, consent or expiry is refreshed to manufacture overlap.
    assert!(permit.is_authorized() && permit.matches(&dispatch.input));
    assert!(child_alive(observed));
    assert_eq!(grant_record(project, permit.grant_id()), *original);
    let fixed = dispatch.input.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        let attempt = fixed.envelope().attempt_id;
        let (host, store) = active.execution_parts().unwrap();
        // Use the same live runtime projection as the registered read command;
        // an explicitly inactive Core projection renders dispatched as unknown.
        assert!(host.runtime.is_active(attempt));
        let detail = host.runtime.attempt(store, attempt).unwrap();
        assert_eq!(detail.items[0].execution, ExecutionState::Dispatched);
        assert!(!detail.items[0].cancellation_requested);
        assert_eq!(
            store.execution_input(attempt).unwrap().bytes(),
            fixed.bytes()
        );
        assert!(
            store
                .execution_current_result(attempt, detail.items[0].item_id)
                .unwrap()
                .is_none()
        );
    });
}

fn original_dispatch(app: &App, attempt: ExecutionId) -> DispatchRequest {
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        let input = active.store.execution_input(attempt).unwrap();
        assert_eq!(input.envelope().items.len(), 1);
        active
            .store
            .execution_dispatch(attempt, input.envelope().items[0].item_id)
            .unwrap()
    })
}

fn assert_channel(dispatch: &DispatchRequest, observed: &Value, grant: ExecutionId) {
    let input = &dispatch.input;
    let binding = input.envelope().plugin.as_ref().unwrap();
    let provider: sdk::ProviderBinding =
        serde_json::from_value(observed["provider"].clone()).unwrap();
    assert_eq!(provider.selection(), binding.capability.provider);
    assert_eq!(provider.activation_generation, 1);
    assert!(!provider.instance_id.is_empty());
    let request = input
        .plugin_request(dispatch.item_id, dispatch.dispatch_token, &provider)
        .unwrap();
    assert_eq!(
        observed["context"],
        serde_json::to_value(&request.context).unwrap()
    );
    assert_eq!(
        observed["input"],
        serde_json::to_value(&request.input).unwrap()
    );
    assert_eq!(
        observed["profile"],
        serde_json::to_value(&request.profile).unwrap()
    );
    assert_eq!(
        observed["contribution"]["contract"],
        serde_json::to_value(&request.capability).unwrap()
    );
    let permit = dispatch.plugin_permit().unwrap();
    assert_eq!(permit.grant_id(), grant);
    assert!(permit.matches(input) && permit.is_authorized());
}

fn assert_selection(
    dispatch: &DispatchRequest,
    image: &PackageImage,
    runtime: &RuntimeApproval,
    role: &str,
) {
    let binding = dispatch.input.envelope().plugin.as_ref().unwrap();
    let expected = sdk::bind_capability(image.manifest(), role, image.package_digest()).unwrap();
    assert_eq!(binding.capability, expected);
    assert_eq!(
        binding.profile,
        Some(
            serde_json::from_value(
                json!({"id":"example.upgrade-records","schemaVersion":1,"behaviorVersion":1})
            )
            .unwrap()
        )
    );
    assert_eq!(binding.environment, runtime.environment);
    assert_eq!(
        dispatch.input.envelope().capability_id,
        expected.declaration.contract.id
    );
    assert_eq!(
        dispatch.input.envelope().capability_version,
        binding.capability_version()
    );
}

fn assert_installed_bytes(
    root: &Path,
    image: &PackageImage,
    manifest: &[u8],
    files: &BTreeMap<String, PackageFile>,
) {
    let archive = root
        .join("plugins/objects")
        .join(image.package_digest())
        .join("package.tar");
    let bytes = fs::read(archive).unwrap();
    let expected =
        PackageImage::capture(manifest.to_vec(), files.clone(), image.package_digest()).unwrap();
    assert_eq!(bytes, expected.encode_archive(|| true).unwrap());
    assert_eq!(bytes, image.encode_archive(|| true).unwrap());
    let captured = PackageImage::capture_archive(&bytes, image.package_digest(), || true).unwrap();
    assert_eq!(captured.package_digest(), image.package_digest());
    assert_eq!(captured.encode_archive(|| true).unwrap(), bytes);
}

#[derive(Clone)]
struct Frame {
    input: FixedInput,
    result: Option<FixedResult>,
}
fn frame(app: &App, attempt: ExecutionId) -> Frame {
    app.state::<AppState>().sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        let input = store.execution_input(attempt).unwrap();
        let id = store
            .execution_current_result(attempt, input.envelope().items[0].item_id)
            .unwrap();
        let result = id.map(|id| store.execution_result(attempt, id).unwrap());
        Frame { input, result }
    })
}
fn assert_frames(app: &App, expected: &[Frame], total: usize) {
    let expected = expected.to_vec();
    app.state::<AppState>().sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        let tasks = store
            .execution_tasks(Revision::new(0).unwrap(), 50)
            .unwrap();
        let attempts = tasks
            .iter()
            .map(|task| store.execution_attempt_ids(task.task_id).unwrap().len())
            .sum::<usize>();
        assert_eq!(attempts, total);
        for saved in expected {
            let attempt = saved.input.envelope().attempt_id;
            let current = store.execution_input(attempt).unwrap();
            assert_eq!(current.bytes(), saved.input.bytes());
            assert_eq!(current.digest(), saved.input.digest());
            assert_eq!(current.envelope(), saved.input.envelope());
            let item = current.envelope().items[0].item_id;
            let id = store.execution_current_result(attempt, item).unwrap();
            assert_eq!(
                id,
                saved
                    .result
                    .as_ref()
                    .map(|result| result.envelope().result_id)
            );
            if let Some(saved) = saved.result {
                let current = store.execution_result(attempt, id.unwrap()).unwrap();
                assert_eq!(current.bytes(), saved.bytes());
                assert_eq!(current.digest(), saved.digest());
                assert_eq!(current.envelope(), saved.envelope());
            }
        }
    });
}

fn succeeded(window: &Window, context: &Value, attempt: ExecutionId) -> ExecutionId {
    let detail = completed(window, context, &json!(attempt));
    assert_eq!(detail["items"].as_array().unwrap().len(), 1);
    serde_json::from_value(detail["items"][0]["resultId"].clone()).unwrap()
}

fn frame_output(frame: &Frame) -> Value {
    let result = frame.result.as_ref().unwrap();
    if frame.input.envelope().operation == tsumugi_core::content::OPERATION {
        // The ledger retains the schema/digest reference. Reconstruct the
        // complete proposal through its original Core owner.
        let output = tsumugi_core::content::validate_output(&frame.input, result).unwrap();
        serde_json::to_value(output.exchange).unwrap()
    } else {
        result.envelope().output.clone().unwrap()
    }
}

fn assert_result(frame: &Frame, dispatch: &DispatchRequest, observed: &Value) {
    let result = frame.result.as_ref().unwrap();
    assert_eq!(frame.input.bytes(), dispatch.input.bytes());
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    assert_eq!(
        result.envelope().attempt_id,
        frame.input.envelope().attempt_id
    );
    assert_eq!(result.envelope().item_id, dispatch.item_id);
    assert_eq!(result.envelope().dispatch_token, dispatch.dispatch_token);
    let evidence = result.envelope().plugin.as_ref().unwrap();
    assert_eq!(
        evidence.authorization_id,
        dispatch.plugin_permit().unwrap().grant_id()
    );
    assert_eq!(
        serde_json::to_value(&evidence.channel).unwrap(),
        observed["provider"]
    );
    assert_eq!(evidence.channel, evidence.result.provider);
    assert_eq!(
        serde_json::to_value(&evidence.result.context).unwrap(),
        observed["context"]
    );
    let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
        panic!("real SDK result did not succeed")
    };
    assert_eq!(output.sha256, sdk::payload_digest(&output.utf8));
    if frame.input.envelope().operation == tsumugi_core::content::OPERATION {
        assert_eq!(
            result.envelope().output.as_ref().unwrap(),
            &serde_json::to_value((&output.schema, &output.sha256)).unwrap()
        );
    }
    assert_eq!(
        serde_json::from_str::<Value>(&output.utf8).unwrap(),
        frame_output(frame)
    );
}

fn stable_source_input(input: &FixedInput) -> Value {
    SourceBundle::from_input(input).unwrap();
    let mut payload = input.envelope().items[0].payload.clone();
    assert!(
        payload
            .as_object_mut()
            .unwrap()
            .remove("sourceSetId")
            .unwrap()
            .is_string()
    );
    assert_eq!(payload["artifacts"].as_array().unwrap().len(), 1);
    assert!(
        payload["artifacts"][0]
            .as_object_mut()
            .unwrap()
            .remove("id")
            .unwrap()
            .is_string()
    );
    assert_eq!(payload["artifacts"][0]["utf8"], RAW);
    assert_eq!(payload["artifacts"][0]["sha256"], sdk::payload_digest(RAW));
    payload
}
fn stable_source_output(frame: &Frame) -> Value {
    let input = &frame.input.envelope().items[0].payload;
    let mut output = frame_output(frame);
    assert_eq!(output["sourceSetId"], input["sourceSetId"]);
    assert_eq!(output["artifacts"], input["artifacts"]);
    let artifact = input["artifacts"][0]["id"].clone();
    assert_eq!(output["units"].as_array().unwrap().len(), 1);
    assert_eq!(
        output["units"][0]["occurrences"].as_array().unwrap().len(),
        1
    );
    let occurrence = &mut output["units"][0]["occurrences"][0];
    assert_eq!(occurrence["source"]["artifactId"], artifact);
    assert_eq!(
        occurrence["nativeIdentity"]["display"]["source"]["artifactId"],
        artifact
    );
    occurrence["source"]["artifactId"] = json!("captured-record");
    occurrence["nativeIdentity"]["display"]["source"]["artifactId"] = json!("captured-record");
    output
        .as_object_mut()
        .unwrap()
        .remove("sourceSetId")
        .unwrap();
    output["artifacts"][0]["id"] = json!("captured-record");
    output
}

fn close(
    app: &App,
    window: &Window,
    context: &Value,
    cleanup: &super::missing_package::ApplicationCleanup,
) {
    upgrade::idle(window, context);
    app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.package_operation.is_none());
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert!(!host.runtime.has_active_work(store).unwrap());
    });
    call(window, "quiesce_execution", context.clone()).unwrap();
    upgrade::idle(window, context);
    call(
        window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    app.state::<AppState>().sessions.with(|sessions| {
        assert!(sessions.active.is_none() && sessions.package_operation.is_none());
    });
    cleanup.require_released_staging().unwrap();
    let state = app.state::<AppState>();
    state.plugins.close();
    state.plugins.dispose_closed_store_for_test().unwrap();
}

#[test]
#[ignore = "requires explicit independently approved macOS arm64 Node tool, Host and runtime approval trees"]
fn actual_live_version_update_rejects_old_callbacks_and_matches_cold_source() {
    let owned = OwnedDirectory::new(true);
    let observations = owned.path().join("observations");
    fs::create_dir(&observations).unwrap();
    let a_candidate = owned.path().join("candidate-a");
    let b_candidate = owned.path().join("candidate-b");
    let (a_image, a_manifest, a_files) = package("0.1.0", 1, &observations, &a_candidate);
    let (b_image, b_manifest, b_files) = package("0.2.0", 2, &observations, &b_candidate);
    let a_approval = PackageApproval {
        plugin: a_image.manifest().manifest().plugin.clone(),
        package_digest: a_image.package_digest().into(),
        origin: PackageOrigin {
            source_id: "manual-local".into(),
            publisher_id: "manual-approval".into(),
        },
    };
    // B's registered local installation records explicit manual trust, not a
    // publisher authentication claim inferred from these synthetic bytes.
    let b_approval = PackageApproval {
        plugin: b_image.manifest().manifest().plugin.clone(),
        package_digest: b_image.package_digest().into(),
        origin: PackageOrigin {
            source_id: "manual-local".into(),
            publisher_id: "manual-approval".into(),
        },
    };
    assert_eq!(a_approval.plugin.publisher, b_approval.plugin.publisher);
    assert_eq!(a_approval.plugin.id, b_approval.plugin.id);
    assert_eq!(a_approval.origin, b_approval.origin);
    assert_ne!(a_approval.plugin.version, b_approval.plugin.version);
    assert_ne!(a_approval.package_digest, b_approval.package_digest);
    assert_eq!(
        PackageImage::digest(&a_manifest, &a_files).unwrap(),
        a_approval.package_digest
    );
    assert_eq!(
        PackageImage::digest(&b_manifest, &b_files).unwrap(),
        b_approval.package_digest
    );
    let mut catalog = PackageCatalog::new();
    catalog
        .register(a_image.clone(), a_approval.clone())
        .unwrap();
    let runtime = upgrade::runtime_fixture::approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let original_install = upgrade::provision_original(
        &owned,
        catalog.registered(&a_approval.plugin).unwrap(),
        &a_approval,
        &runtime,
        &runtime_approval,
        ExecutionId::new(),
    );
    assert_eq!(original_install.plugin(), &a_approval.plugin);
    assert_eq!(original_install.package_digest(), a_approval.package_digest);
    assert_eq!(original_install.origin(), &a_approval.origin);
    drop(catalog);
    drop(runtime);
    let a_choice = upgrade::source_choice(&a_approval, &runtime_approval);
    let b_choice = upgrade::source_choice(&b_approval, &runtime_approval);
    let material = owned.path().join("materials");
    fs::create_dir(&material).unwrap();
    fs::write(material.join("record.txt"), RAW).unwrap();
    let project_path = owned.path().join("project");
    let application_path = owned.path().join("application");
    let (app, window, cleanup) = upgrade::application(&owned);
    let inventory: PluginInventoryView =
        serde_json::from_value(call(&window, "read_plugin_inventory", json!({})).unwrap()).unwrap();
    assert_eq!(inventory.settings_revision.get(), 1);
    assert_eq!(inventory.packages.len(), 1);
    assert_eq!(
        inventory.packages[0].original_install_action,
        original_install.action_id()
    );
    assert_eq!(inventory.package_decisions.len(), 1);
    assert!(inventory.package_decisions[0].enabled);
    let project = call(&window, "create_project", json!({"destination":project_path,"displayName":"Fixed source environments during explicit update","sourceLocale":"en-US","targetLocales":[LOCALE]})).unwrap();
    let context = upgrade::context(&project);
    let old_attempt = ExecutionId::new();
    let old_review =
        upgrade::preflight_source(&app, &window, &context, &material, &a_choice, old_attempt);
    let old_start = consent(&context, &old_review);
    let old_grant: ExecutionId = serde_json::from_value(old_start["grantId"].clone()).unwrap();
    assert_eq!(
        call(&window, "start_plugin_source", old_start.clone()).unwrap(),
        json!(old_attempt)
    );
    let old_result = succeeded(&window, &context, old_attempt);
    let old_entered = observation(&observations, old_attempt, "entered");
    let old_dispatch = original_dispatch(&app, old_attempt);
    assert_channel(&old_dispatch, &old_entered, old_grant);
    assert_selection(&old_dispatch, &a_image, &runtime_approval, "extract");
    let old_frame = frame(&app, old_attempt);
    assert_result(&old_frame, &old_dispatch, &old_entered);
    assert_eq!(
        frame_output(&old_frame)["units"][0]["occurrences"][0]["nativeIdentity"]["value"],
        "mixedcase"
    );
    let old_preview = call(
        &window,
        "read_source_preview",
        scoped(
            &context,
            json!({"attemptId":old_attempt,"resultId":old_result,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    let checker_attempt = ExecutionId::new();
    let check = call(&window, "prepare_source_check", scoped(&context, json!({"sourceAttemptId":old_attempt,"sourceResultId":old_result,"attemptId":checker_attempt,"source":a_choice}))).unwrap();
    let check_start = consent(&context, &check);
    let check_grant: ExecutionId = serde_json::from_value(check_start["grantId"].clone()).unwrap();
    call(&window, "start_source_check", check_start).unwrap();
    let check_result = succeeded(&window, &context, checker_attempt);
    call(
        &window,
        "finish_source_check",
        scoped(
            &context,
            json!({"attemptId":checker_attempt,"resultId":check_result}),
        ),
    )
    .unwrap();
    let check_dispatch = original_dispatch(&app, checker_attempt);
    let check_entered = observation(&observations, checker_attempt, "entered");
    assert_channel(&check_dispatch, &check_entered, check_grant);
    assert_selection(&check_dispatch, &a_image, &runtime_approval, "source-check");
    let check_frame = frame(&app, checker_attempt);
    assert_result(&check_frame, &check_dispatch, &check_entered);
    upgrade::adopt(
        &window,
        &context,
        &json!(old_attempt),
        &json!(old_result),
        &old_preview["confirmation"],
    );
    upgrade::idle(&window, &context);
    cleanup.require_released_staging().unwrap();
    let scope = call(&window, "read_content_scope", context.clone()).unwrap();
    let content_fields = json!({"snapshotId":scope["currentSnapshot"],"after":0,"limit":50});
    let old_content = call(
        &window,
        "read_source_content",
        scoped(&context, content_fields.clone()),
    )
    .unwrap();
    assert_eq!(old_content["total"], 1);
    let row = &old_content["rows"][0];
    let manual = call(&window, "save_translation_revision", scoped(&context, json!({"actionId":ExecutionId::new(),"unitId":row["unitId"],"locale":LOCALE,"sourceRevisionId":row["sourceRevisionId"],"expectedSelectionId":null,"text":TRANSLATION}))).unwrap();
    let translation_fields =
        json!({"unitId":row["unitId"],"locale":LOCALE,"afterOrdinal":"0","limit":50});
    let translation_history = call(
        &window,
        "read_translation_history",
        scoped(&context, translation_fields.clone()),
    )
    .unwrap();
    assert_eq!(translation_history["rows"], json!([manual["revision"]]));
    let source_history = call(
        &window,
        "read_source_history",
        scoped(&context, json!({"offset":0,"limit":50})),
    )
    .unwrap();
    assert_eq!(source_history["total"], 1);
    assert_eq!(source_history["snapshots"].as_array().unwrap().len(), 1);
    let require_history = |window: &Window, current: &Value| {
        assert_eq!(
            call(window, "read_content_scope", current.clone()).unwrap(),
            scope
        );
        assert_eq!(
            call(
                window,
                "read_source_content",
                scoped(current, content_fields.clone())
            )
            .unwrap(),
            old_content
        );
        assert_eq!(
            call(
                window,
                "read_source_history",
                scoped(current, json!({"offset":0,"limit":50}))
            )
            .unwrap(),
            source_history
        );
        assert_eq!(
            call(
                window,
                "read_translation_history",
                scoped(current, translation_fields.clone())
            )
            .unwrap(),
            translation_history
        );
    };

    // Capture B's real picker result before holding A; installation/approval
    // still happen only after A's next actual handler has entered.
    let candidate = app
        .state::<AppState>()
        .plugins
        .capture_candidate_for_test(b_candidate.clone())
        .unwrap();
    assert_eq!(candidate.manifest, b_image.manifest().manifest().clone());
    assert_eq!(candidate.package_digest, b_approval.package_digest);
    assert_eq!(
        candidate.manifest_sha256,
        sdk::payload_digest(std::str::from_utf8(&b_manifest).unwrap())
    );
    assert_eq!(
        call(&window, "read_plugin_inventory", json!({})).unwrap(),
        serde_json::to_value(&inventory).unwrap()
    );
    let held_attempt = ExecutionId::new();
    fs::write(
        observations.join(format!("{held_attempt}.hold")),
        "return-after-cancel",
    )
    .unwrap();
    let held_review =
        upgrade::preflight_source(&app, &window, &context, &material, &a_choice, held_attempt);
    let held_start = consent(&context, &held_review);
    let held_grant: ExecutionId = serde_json::from_value(held_start["grantId"].clone()).unwrap();
    call(&window, "start_plugin_source", held_start.clone()).unwrap();
    let held_entered = observation(&observations, held_attempt, "entered");
    let held_dispatch = original_dispatch(&app, held_attempt);
    assert_channel(&held_dispatch, &held_entered, held_grant);
    assert_selection(&held_dispatch, &a_image, &runtime_approval, "extract");
    assert!(child_alive(&held_entered));
    let held_stage = stage(&held_entered, &application_path);
    let held_frame = frame(&app, held_attempt);
    assert!(held_frame.result.is_none());
    let old_grants =
        [old_grant, check_grant, held_grant].map(|grant| grant_record(&project_path, grant));
    for (record, dispatch) in
        old_grants
            .iter()
            .zip([&old_dispatch, &check_dispatch, &held_dispatch])
    {
        assert_eq!(
            record.0,
            dispatch.plugin_permit().unwrap().grant_id().to_string()
        );
        assert_eq!(record.1, dispatch.input.envelope().attempt_id.to_string());
        assert_eq!(record.2, dispatch.input.envelope().task_id.to_string());
        assert_eq!(record.3, dispatch.input.digest());
        assert_eq!(record.6, 1);
        assert_eq!(record.7, 0);
    }
    let generation = old_grants[2].4.clone();
    assert!(old_grants.iter().all(|record| record.4 == generation));
    assert_eq!(
        old_grants[2].5.to_string(),
        held_start["expiresAtMs"].as_str().unwrap()
    );
    assert_held(
        &app,
        &held_dispatch,
        &held_entered,
        &project_path,
        &old_grants[2],
    );
    let install_action = ExecutionId::new();
    let installed: PluginInventoryView = serde_json::from_value(
        call(
            &window,
            "install_plugin_package",
            json!(PluginInstallRequest {
                ticket: candidate.ticket,
                expected_revision: inventory.settings_revision,
                action_id: install_action
            }),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(installed.settings_revision.get(), 2);
    assert_eq!(
        installed.last_settings_action,
        Some(install_action.to_string())
    );
    assert_eq!(installed.packages.len(), 2);
    assert_eq!(installed.package_decisions.len(), 2);
    assert!(installed.packages.contains(&inventory.packages[0]));
    let installed_b = installed
        .packages
        .iter()
        .find(|package| package.plugin == b_approval.plugin)
        .unwrap()
        .clone();
    assert_eq!(
        installed_b.original_install_action,
        install_action.to_string()
    );
    assert_eq!(installed_b.package_digest, b_approval.package_digest);
    assert_eq!(installed_b.origin.source_id, "manual-local");
    assert_eq!(installed_b.origin.publisher_id, "manual-approval");
    assert_eq!(installed_b.state, PluginObjectState::Sealed);
    let b_decision = installed
        .package_decisions
        .iter()
        .find(|decision| decision.plugin == b_approval.plugin)
        .unwrap();
    assert_eq!(b_decision.package_digest, b_approval.package_digest);
    assert!(!b_decision.enabled);
    assert!(
        installed
            .package_decisions
            .iter()
            .find(|decision| decision.plugin == a_approval.plugin)
            .unwrap()
            .enabled
    );
    let disabled = call(&window, "read_plugin_source", json!(&b_choice)).unwrap_err();
    assert_eq!(disabled["code"], "permission-denied");
    assert_eq!(disabled["reason"], "plugin-disabled");
    assert_held(
        &app,
        &held_dispatch,
        &held_entered,
        &project_path,
        &old_grants[2],
    );
    assert_frames(
        &app,
        &[old_frame.clone(), check_frame.clone(), held_frame.clone()],
        3,
    );
    let enable_action = ExecutionId::new();
    let enabled: PluginInventoryView = serde_json::from_value(
        call(
            &window,
            "set_plugin_enabled",
            json!(PluginEnableRequest {
                package: b_choice.package.clone(),
                enabled: true,
                expected_revision: installed.settings_revision,
                action_id: enable_action
            }),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(enabled.settings_revision.get(), 3);
    assert_eq!(
        enabled.last_settings_action,
        Some(enable_action.to_string())
    );
    assert_eq!(enabled.packages, installed.packages);
    assert_eq!(enabled.runtime_decisions, inventory.runtime_decisions);
    assert_eq!(enabled.runtimes, inventory.runtimes);
    assert!(
        enabled
            .package_decisions
            .iter()
            .all(|decision| decision.enabled)
    );
    assert_held(
        &app,
        &held_dispatch,
        &held_entered,
        &project_path,
        &old_grants[2],
    );
    require_history(&window, &context);
    let b_attempt = ExecutionId::new();
    fs::write(
        observations.join(format!("{b_attempt}.hold")),
        "release-only",
    )
    .unwrap();
    let b_review =
        upgrade::preflight_source(&app, &window, &context, &material, &b_choice, b_attempt);
    assert_eq!(b_review["source"]["settingsRevision"], "3");
    let b_start = consent(&context, &b_review);
    let b_grant: ExecutionId = serde_json::from_value(b_start["grantId"].clone()).unwrap();
    assert_frames(
        &app,
        &[old_frame.clone(), check_frame.clone(), held_frame.clone()],
        3,
    );
    assert_eq!(grant_record(&project_path, held_grant), old_grants[2]);
    call(&window, "start_plugin_source", b_start.clone()).unwrap();
    let b_entered = observation(&observations, b_attempt, "entered");
    let b_dispatch = original_dispatch(&app, b_attempt);
    assert_channel(&b_dispatch, &b_entered, b_grant);
    assert_selection(&b_dispatch, &b_image, &runtime_approval, "extract");
    assert!(
        !held_dispatch
            .plugin_permit()
            .unwrap()
            .matches(&b_dispatch.input)
    );
    assert_ne!(b_grant, held_grant);
    assert_ne!(
        b_entered["provider"]["instanceId"],
        held_entered["provider"]["instanceId"]
    );
    assert_ne!(b_entered["pid"], held_entered["pid"]);
    assert!(child_alive(&b_entered) && child_alive(&held_entered));
    assert_held(
        &app,
        &held_dispatch,
        &held_entered,
        &project_path,
        &old_grants[2],
    );
    let b_stage = stage(&b_entered, &application_path);
    let b_record = grant_record(&project_path, b_grant);
    assert_eq!(b_record.4, generation);
    assert_eq!(b_record.1, b_attempt.to_string());
    assert_eq!(b_record.2, b_dispatch.input.envelope().task_id.to_string());
    assert_eq!(b_record.3, b_dispatch.input.digest());
    assert_eq!(
        b_record.5.to_string(),
        b_start["expiresAtMs"].as_str().unwrap()
    );
    assert_eq!(b_record.6, 1);
    assert_eq!(b_record.7, 0);
    let fixed_b = b_dispatch.input.clone();
    let old_expiry = u64::try_from(old_grants[2].5).unwrap();
    let grants_before_negative = all_grants(&project_path);
    assert_eq!(grants_before_negative.len(), 4);
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let refused = host
            .runtime
            .authorize_plugin(
                store,
                held_grant,
                &fixed_b,
                old_expiry,
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
            )
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::ResultMismatch);
        assert_eq!(refused.stage, "plugin-grant-identity");
    });
    assert_eq!(grant_record(&project_path, held_grant), old_grants[2]);
    assert_eq!(grant_record(&project_path, b_grant), b_record);
    assert_eq!(all_grants(&project_path), grants_before_negative);
    assert_held(
        &app,
        &held_dispatch,
        &held_entered,
        &project_path,
        &old_grants[2],
    );

    // Original exact package coordinator withdraws only A's grants, cancels its
    // dispatched task and joins its actual Host/Node owner before confirming.
    let removal = PluginApprovalRemovalRequest {
        package: a_choice.package.clone(),
        origin: inventory.packages[0].origin.clone(),
        expected_revision: enabled.settings_revision,
        action_id: ExecutionId::new(),
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let final_inventory: PluginInventoryView = loop {
        match call(&window, "remove_plugin_approval", json!(&removal)) {
            Ok(view) => break serde_json::from_value(view).unwrap(),
            Err(error) if error["code"] == "busy" => {
                assert_eq!(error["recoveryRequired"], true);
                assert_eq!(error["recoveryGuidance"], "reconcile-original");
                assert!(
                    Instant::now() < deadline,
                    "exact A owner did not drain: {error}"
                );
                assert!(
                    b_dispatch.plugin_permit().unwrap().is_authorized() && child_alive(&b_entered)
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("original A approval removal failed: {error}"),
        }
    };
    assert_eq!(final_inventory.settings_revision.get(), 4);
    assert_eq!(
        final_inventory.last_settings_action,
        Some(removal.action_id.to_string())
    );
    assert_eq!(final_inventory.packages, enabled.packages);
    assert_eq!(final_inventory.runtimes, enabled.runtimes);
    assert_eq!(final_inventory.runtime_decisions, enabled.runtime_decisions);
    assert_eq!(final_inventory.package_decisions.len(), 1);
    assert_eq!(
        final_inventory.package_decisions[0].plugin,
        b_approval.plugin
    );
    assert_eq!(
        final_inventory.package_decisions[0].package_digest,
        b_approval.package_digest
    );
    assert!(final_inventory.package_decisions[0].enabled);
    assert!(!held_dispatch.plugin_permit().unwrap().is_authorized());
    assert!(!old_dispatch.plugin_permit().unwrap().is_authorized());
    assert!(!check_dispatch.plugin_permit().unwrap().is_authorized());
    assert!(b_dispatch.plugin_permit().unwrap().is_authorized() && child_alive(&b_entered));
    assert!(!child_alive(&held_entered));
    assert!(!held_stage.exists() && b_stage.exists());
    assert!(!observations.join(format!("{b_attempt}.release")).exists());
    assert!(
        !observations
            .join(format!("{b_attempt}.disposed.json"))
            .exists()
    );
    // Cancellation terminates/reaps the worker; cooperative JavaScript cleanup
    // is not guaranteed before SIGKILL. Exercise the retained exact application
    // cleanup callbacks again while B is live instead of requiring a killed
    // process to produce an observation. Cooperative late JavaScript callbacks
    // and facade disposal have a separate actual two-channel lifecycle test.
    let retained_action = removal.action_id;
    let retained_package = removal.package.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.begin_package_cleanup(store, retained_action, retained_package)
            .unwrap();
        host.finish_package_cleanup(store, retained_action).unwrap();
        host.complete_package_cleanup(retained_action).unwrap();
    });
    assert_eq!(
        call(&window, "remove_plugin_approval", json!(&removal)).unwrap(),
        serde_json::to_value(&final_inventory).unwrap()
    );
    assert_eq!(grant_record(&project_path, b_grant), b_record);
    assert!(b_dispatch.plugin_permit().unwrap().is_authorized() && child_alive(&b_entered));
    assert!(b_stage.exists() && !held_stage.exists());
    assert!(
        !observations
            .join(format!("{b_attempt}.disposed.json"))
            .exists()
    );
    app.state::<AppState>().sessions.with(move |sessions| {
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        assert_eq!(host.runtime.generation().to_string(), generation);
        let detail = store.execution_attempt(held_attempt, false).unwrap();
        assert_eq!(detail.items[0].execution, ExecutionState::Unknown);
        assert!(detail.items[0].cancellation_requested);
        assert!(
            store
                .execution_current_result(held_attempt, detail.items[0].item_id)
                .unwrap()
                .is_none()
        );
    });
    for (grant, original) in [old_grant, check_grant, held_grant]
        .into_iter()
        .zip(&old_grants)
    {
        let mut revoked = original.clone();
        revoked.7 = 1;
        assert_eq!(grant_record(&project_path, grant), revoked);
    }
    assert_eq!(grant_record(&project_path, b_grant), b_record);
    assert_frames(
        &app,
        &[old_frame.clone(), check_frame.clone(), held_frame.clone()],
        4,
    );
    require_history(&window, &context);
    fs::write(
        observations.join(format!("{b_attempt}.release")),
        b"release",
    )
    .unwrap();
    let b_result = succeeded(&window, &context, b_attempt);
    let b_disposed = observation(&observations, b_attempt, "disposed");
    assert_eq!(b_disposed["provider"], b_entered["provider"]);
    assert_eq!(b_disposed["context"], b_entered["context"]);
    assert_eq!(b_disposed["scopeAborted"], true);
    assert_eq!(b_disposed["registerError"], "Inactive component");
    assert_eq!(b_disposed["disposeError"], "Inactive component");
    let b_frame = frame(&app, b_attempt);
    assert_result(&b_frame, &b_dispatch, &b_entered);
    assert_eq!(
        frame_output(&b_frame)["units"][0]["occurrences"][0]["nativeIdentity"]["value"],
        "MixedCase"
    );
    call(
        &window,
        "read_source_preview",
        scoped(
            &context,
            json!({"attemptId":b_attempt,"resultId":b_result,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    let saved_frames = vec![old_frame, check_frame, held_frame, b_frame.clone()];
    assert_frames(&app, &saved_frames, 4);
    assert_eq!(grant_record(&project_path, b_grant), b_record);
    require_history(&window, &context);
    let final_source = call(&window, "read_plugin_source", json!(&b_choice)).unwrap();
    assert_eq!(final_source["settingsRevision"], "4");
    let mut promoted_source = b_review["source"].clone();
    assert_eq!(promoted_source["settingsRevision"], "3");
    // This metadata projection compares static declarations only. The original
    // revision-3 view and all fixed execution/result bytes remain untouched.
    promoted_source["settingsRevision"] = json!("4");
    assert_eq!(final_source, promoted_source);
    upgrade::idle(&window, &context);
    cleanup.require_released_staging().unwrap();
    assert!(!b_stage.exists() && !child_alive(&b_entered));
    let receipt_path = application_path
        .join("plugins/objects")
        .join(&b_approval.package_digest)
        .join("receipt.json");
    let b_receipt = fs::read(&receipt_path).unwrap();
    let old_receipt_path = application_path
        .join("plugins/objects")
        .join(&a_approval.package_digest)
        .join("receipt.json");
    let a_receipt = fs::read(&old_receipt_path).unwrap();
    assert_installed_bytes(&application_path, &a_image, &a_manifest, &a_files);
    assert_installed_bytes(&application_path, &b_image, &b_manifest, &b_files);
    close(&app, &window, &context, &cleanup);
    assert!(!b_dispatch.plugin_permit().unwrap().is_authorized());
    assert_eq!(grant_record(&project_path, b_grant), b_record);
    drop(window);
    drop(cleanup);
    drop(app);

    // MockRuntime's owner disposal is explicit above. This fresh App/Session
    // reconstructs final decisions without reviving any durable original grant.
    let (app, window, cleanup) = upgrade::application(&owned);
    assert_eq!(
        call(&window, "read_plugin_inventory", json!({})).unwrap(),
        serde_json::to_value(&final_inventory).unwrap()
    );
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let current = upgrade::context(&reopened);
    assert_eq!(current["projectId"], context["projectId"]);
    assert_ne!(current["sessionToken"], context["sessionToken"]);
    require_history(&window, &current);
    assert_frames(&app, &saved_frames, 4);
    assert!(!b_dispatch.plugin_permit().unwrap().is_authorized());
    assert_eq!(grant_record(&project_path, b_grant), b_record);
    assert_eq!(fs::read(&receipt_path).unwrap(), b_receipt);
    assert_eq!(fs::read(&old_receipt_path).unwrap(), a_receipt);
    assert_installed_bytes(&application_path, &a_image, &a_manifest, &a_files);
    assert_installed_bytes(&application_path, &b_image, &b_manifest, &b_files);
    assert_eq!(
        fs::read(material.join("record.txt")).unwrap(),
        RAW.as_bytes()
    );
    let cold_attempt = ExecutionId::new();
    let cold_review =
        upgrade::preflight_source(&app, &window, &current, &material, &b_choice, cold_attempt);
    assert_eq!(cold_review["source"], final_source);
    assert_eq!(cold_review["files"], b_review["files"]);
    assert_eq!(cold_review["source"]["settingsRevision"], "4");
    let cold_start = consent(&current, &cold_review);
    let cold_grant: ExecutionId = serde_json::from_value(cold_start["grantId"].clone()).unwrap();
    assert_ne!(cold_grant, b_grant);
    call(&window, "start_plugin_source", cold_start.clone()).unwrap();
    let cold_result = succeeded(&window, &current, cold_attempt);
    let cold_entered = observation(&observations, cold_attempt, "entered");
    let cold_dispatch = original_dispatch(&app, cold_attempt);
    assert_channel(&cold_dispatch, &cold_entered, cold_grant);
    assert_selection(&cold_dispatch, &b_image, &runtime_approval, "extract");
    assert_ne!(cold_entered["pid"], b_entered["pid"]);
    assert_ne!(
        cold_entered["provider"]["instanceId"],
        b_entered["provider"]["instanceId"]
    );
    let cold_record = grant_record(&project_path, cold_grant);
    assert_ne!(cold_record.4, b_record.4);
    assert_eq!(cold_record.1, cold_attempt.to_string());
    assert_eq!(
        cold_record.2,
        cold_dispatch.input.envelope().task_id.to_string()
    );
    assert_eq!(cold_record.3, cold_dispatch.input.digest());
    assert_eq!(
        cold_record.5.to_string(),
        cold_start["expiresAtMs"].as_str().unwrap()
    );
    assert_eq!(cold_record.6, 1);
    assert_eq!(cold_record.7, 0);
    let cold_frame = frame(&app, cold_attempt);
    assert_result(&cold_frame, &cold_dispatch, &cold_entered);
    assert_eq!(
        cold_frame.input.envelope().plugin,
        b_frame.input.envelope().plugin
    );
    assert_eq!(
        cold_frame.input.envelope().settings,
        b_frame.input.envelope().settings
    );
    assert_eq!(
        SourceSettings::from_input(&cold_frame.input).unwrap(),
        SourceSettings::from_input(&b_frame.input).unwrap()
    );
    assert_eq!(
        stable_source_input(&cold_frame.input),
        stable_source_input(&b_frame.input)
    );
    assert_eq!(
        stable_source_output(&cold_frame),
        stable_source_output(&b_frame)
    );
    call(
        &window,
        "read_source_preview",
        scoped(
            &current,
            json!({"attemptId":cold_attempt,"resultId":cold_result,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    let mut all_frames = saved_frames;
    all_frames.push(cold_frame);
    assert_frames(&app, &all_frames, 5);
    require_history(&window, &current);
    assert_eq!(grant_record(&project_path, b_grant), b_record);
    for (grant, original) in [old_grant, check_grant, held_grant]
        .into_iter()
        .zip(&old_grants)
    {
        let mut revoked = original.clone();
        revoked.7 = 1;
        assert_eq!(grant_record(&project_path, grant), revoked);
    }
    upgrade::idle(&window, &current);
    cleanup.require_released_staging().unwrap();
    assert!(!child_alive(&cold_entered));
    close(&app, &window, &current, &cleanup);
    assert!(!cold_dispatch.plugin_permit().unwrap().is_authorized());
    assert_eq!(grant_record(&project_path, cold_grant), cold_record);
    drop(window);
    drop(cleanup);
    drop(app);
}
