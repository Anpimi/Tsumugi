//! Actual synthetic two-version source interpretation and explicit adoption.
//! The stable records profile promises captured references and original bytes;
//! ASCII folding/exact matching belong to separately versioned native identity.
//! This does not establish upgrade compatibility for any included real format.
use super::{
    missing_package::{ApplicationCleanup, OwnedDirectory},
    native::{call, completed, consent, consents, scoped},
    *,
};
use crate::commands::plugins::{PluginBuildRequest, PluginInventoryView, PluginPackageRequest};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use tauri::Manager;
use tsumugi_core::{
    content::{SourceBundle, SourceSettings},
    execution::FixedResult,
};
use tsumugi_plugin_host::{
    ApprovedPackageSetting, PackageFile, PackageImage, PackageStore, PluginSettingsUpdate,
    RuntimeApproval,
    catalog::{PackageApproval, PackageCatalog, PackageOrigin},
};
use tsumugi_plugin_sdk as sdk;

mod runtime_fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/plugin-host/tests/support/runtime.rs"
    ));
}

const RAW: &str = "MixedCase\tHello 👩🏽‍💻\r\n";
const TEXT: &str = "Hello 👩🏽‍💻";
const TRANSLATION: &str = "你好 👩🏽‍💻 e\u{301}";
const LOCALE: &str = "zh-CN";
const OUTPUT_PATH: &str = "zh-CN.txt";

fn contract(id: &str, behavior: u32) -> Value {
    json!({"id":id,"schemaVersion":1,"behaviorVersion":behavior})
}
fn profile() -> Value {
    contract("example.upgrade-records", 1)
}

fn image(version: &str, behavior: u32) -> PackageImage {
    assert!(matches!((version, behavior), ("0.1.0", 1) | ("0.2.0", 2)));
    let components = [
        "extract",
        "source-check",
        "review-check",
        "build",
        "artifact-check",
    ];
    let mut contributions = vec![
        json!({"id":"source-profile","componentId":"extract","contribution":{"kind":"resource","schema":{"id":"tsumugi.source-import-declaration","schemaVersion":2,"behaviorVersion":2},"path":"source-profile.json"}}),
        json!({"id":"review-profile","componentId":"review-check","contribution":{"kind":"resource","schema":sdk::review_declaration_contract(),"path":"review-profile.json"}}),
        json!({"id":"build-profile","componentId":"build","contribution":{"kind":"resource","schema":sdk::build_declaration_contract(),"path":"build-profile.json"}}),
    ];
    for (role, input, output, error, effect) in [
        (
            "extract",
            sdk::source_extraction_input_contract(),
            sdk::content_exchange_contract(),
            sdk::source_extraction_error_contract(),
            "proposal",
        ),
        (
            "source-check",
            sdk::source_extraction_check_input_contract(),
            sdk::check_results_contract(),
            sdk::source_extraction_error_contract(),
            "read-only",
        ),
        (
            "review-check",
            sdk::review_check_input_contract(),
            sdk::check_results_contract(),
            sdk::review_check_error_contract(),
            "read-only",
        ),
        (
            "build",
            sdk::build_input_contract(),
            sdk::artifact_set_contract(),
            sdk::build_error_contract(),
            "proposal",
        ),
        (
            "artifact-check",
            sdk::artifact_check_input_contract(),
            sdk::check_results_contract(),
            sdk::build_error_contract(),
            "read-only",
        ),
    ] {
        contributions.push(json!({"id":role,"componentId":role,"contribution":{"kind":"capability","declaration":{
            "contract":contract(&format!("example.upgrade.{role}"),behavior),"inputSchema":input,"outputSchema":output,"errorSchema":error,
            "profiles":[profile()],"effect":effect,"permissions":[{"kind":"captured-input"}],
            "limits":{"maxInputBytes":4194304,"maxOutputBytes":2097152,"concurrency":1,"timeoutMs":10000}
        }}}));
    }
    let manifest = json!({"protocolVersion":sdk::MANIFEST_PROTOCOL,
        "plugin":{"publisher":"example","id":"source-upgrade","version":version},
        "permissions":[{"kind":"captured-input"}],
        "components":components.iter().map(|role| json!({"id":role,"scope":"project","runtime":"javascript","entrypoint":format!("{role}.mjs"),"dependencies":[],"exit":{"stopTimeoutMs":1000,"cleanupTimeoutMs":1000}})).collect::<Vec<_>>(),
        "contributions":contributions});
    let mut files: BTreeMap<String, PackageFile> = components
        .into_iter()
        .map(|role| {
            (
                format!("{role}.mjs"),
                PackageFile {
                    bytes: include_bytes!("upgrade.mjs").to_vec(),
                    executable: false,
                },
            )
        })
        .collect();
    for (path, value) in [
        ("identity.json", json!({"behaviorVersion":behavior})),
        (
            "source-profile.json",
            json!({"displayName":"Synthetic versioned ASCII keys","profile":profile(),
            "materials":[{"logicalPath":"record.txt","role":"source","maxBytes":131072}],"extractor":"extract","checker":"source-check",
            "revisionPolicy":{"profile":profile(),"revisionBasis":[]},"semanticRules":[contract("example.upgrade.source-semantics",behavior)],"reviewResource":"review-profile"}),
        ),
        (
            "review-profile.json",
            json!({"profile":profile(),"checker":"review-check","rules":[{"rule":contract("example.upgrade.review",behavior),"requiresTranslation":true}]}),
        ),
        (
            "build-profile.json",
            json!({"displayName":"Synthetic exact CRLF record","profile":profile(),"builder":"build","checker":"artifact-check",
            "outputLimits":{"maxArtifacts":1,"maxTotalBytes":131072},"artifactRules":[contract("example.upgrade.artifact",behavior)]}),
        ),
    ] {
        files.insert(
            path.into(),
            PackageFile {
                bytes: serde_json::to_vec(&value).unwrap(),
                executable: false,
            },
        );
    }
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    let captured = PackageImage::capture(manifest, files, &digest).unwrap();
    // Parse and bind complete original source/review/build contracts now; the
    // runtime capture below independently repeats these owning-layer checks.
    captured.source_import("source-profile").unwrap();
    captured.build_declaration("build-profile").unwrap();
    captured
}

fn approval(image: &PackageImage) -> PackageApproval {
    PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: image.package_digest().into(),
        origin: PackageOrigin {
            source_id: "synthetic-records-upgrade".into(),
            publisher_id: "example".into(),
        },
    }
}
fn source_choice(approval: &PackageApproval, runtime: &RuntimeApproval) -> PluginSourceRequest {
    PluginSourceRequest {
        package: PluginPackageRequest {
            plugin: approval.plugin.clone(),
            package_digest: approval.package_digest.clone(),
        },
        resource_id: "source-profile".into(),
        environment_digest: runtime.environment.digest().unwrap(),
    }
}
fn build_choice(source: &PluginSourceRequest) -> PluginBuildRequest {
    PluginBuildRequest {
        package: source.package.clone(),
        resource_id: "build-profile".into(),
        environment_digest: source.environment_digest.clone(),
    }
}
fn application(
    owned: &OwnedDirectory,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
    ApplicationCleanup,
) {
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let cleanup = ApplicationCleanup::new(&app, owned, &owned.path().join("application"));
    app.state::<AppState>()
        .plugins
        .configure(owned.path().join("application"))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    (app, window, cleanup)
}
fn context(project: &Value) -> Value {
    json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]})
}
fn idle(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, context: &Value) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let status = call(window, "execution_status", context.clone()).unwrap();
        assert!(
            status["error"].is_null(),
            "original execution did not settle: {status}"
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
fn result(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
    attempt: &Value,
) -> Value {
    let detail = completed(window, context, attempt);
    assert_eq!(detail["items"].as_array().unwrap().len(), 1);
    assert!(detail["items"][0]["resultId"].is_string());
    detail["items"][0]["resultId"].clone()
}

#[derive(Clone)]
struct Frame {
    input: FixedInput,
    results: Vec<FixedResult>,
}
fn frames(store: &ProjectStore) -> Vec<Frame> {
    let mut after = Revision::new(0).unwrap();
    let mut frames = vec![];
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
                        let id = store
                            .execution_current_result(attempt, item.item_id)
                            .unwrap()
                            .unwrap();
                        store.execution_result(attempt, id).unwrap()
                    })
                    .collect();
                frames.push(Frame { input, results });
            }
        }
        assert!(
            frames.len() <= 7,
            "the upgrade journey admits exactly seven actual executions"
        );
    }
    frames.sort_by_key(|frame| frame.input.envelope().attempt_id);
    frames
}
fn unchanged_frames(store: &ProjectStore, saved: &[Frame], total: usize) {
    let current = frames(store);
    assert_eq!(current.len(), total);
    for old in saved {
        let current = current
            .iter()
            .find(|frame| frame.input.envelope().attempt_id == old.input.envelope().attempt_id)
            .unwrap();
        assert_eq!(current.input.bytes(), old.input.bytes());
        assert_eq!(current.input.digest(), old.input.digest());
        assert_eq!(current.results.len(), old.results.len());
        for (old, current) in old.results.iter().zip(&current.results) {
            assert_eq!(current.envelope().result_id, old.envelope().result_id);
            assert_eq!(current.bytes(), old.bytes());
            assert_eq!(current.digest(), old.digest());
        }
    }
}

fn extract_checked(
    app: &tauri::App<tauri::test::MockRuntime>,
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
    materials: &Path,
    choice: &PluginSourceRequest,
    grants: &mut Vec<Value>,
) -> (Value, Value, Value) {
    let selection = ExecutionId::new();
    let selected = Arc::new(capture::Selection::authorize(materials.to_path_buf()).unwrap());
    let fixed_choice = choice.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let host = sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0;
        host.source.selection = Some((selection, selected));
        host.source.plugin.choice = Some((selection, fixed_choice));
    });
    let review = call(window,"preflight_plugin_source",scoped(context,json!({"selectionId":selection,"sourceLanguage":"en-US","attemptId":ExecutionId::new()}))).unwrap();
    assert_eq!(review["files"].as_array().unwrap().len(), 1);
    assert_eq!(review["files"][0]["byteLength"], RAW.len());
    assert_eq!(review["files"][0]["sha256"], sdk::payload_digest(RAW));
    let start = consent(context, &review);
    let attempt = call(window, "start_plugin_source", start.clone()).unwrap();
    let produced = result(window, context, &attempt);
    grants.push(start);
    let preview = call(
        window,
        "read_source_preview",
        scoped(
            context,
            json!({"attemptId":attempt,"resultId":produced,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    assert_eq!(preview["rows"].as_array().unwrap().len(), 1);
    assert_eq!(preview["rows"][0]["occurrence"]["text"], TEXT);
    let check = call(window,"prepare_source_check",scoped(context,json!({"sourceAttemptId":attempt,"sourceResultId":produced,"attemptId":ExecutionId::new(),"source":choice}))).unwrap();
    let check_start = consent(context, &check);
    let checked = call(window, "start_source_check", check_start.clone()).unwrap();
    let checked_result = result(window, context, &checked);
    grants.push(check_start);
    call(
        window,
        "finish_source_check",
        scoped(
            context,
            json!({"attemptId":checked,"resultId":checked_result}),
        ),
    )
    .unwrap();
    (attempt, produced, preview)
}
fn adopt(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
    attempt: &Value,
    result: &Value,
    confirmation: &Value,
) -> Value {
    let action = ExecutionId::new();
    call(window,"prepare_source_adoption",scoped(context,json!({"attemptId":attempt,"resultId":result,"actionId":action,"confirmation":confirmation}))).unwrap();
    call(
        window,
        "adopt_execution",
        scoped(context, json!({"actionId":action})),
    )
    .unwrap()
}

#[test]
#[ignore = "requires explicit independently approved macOS arm64 Node tool, Host and runtime approval trees"]
fn actual_two_version_identity_upgrade_compares_before_adoption_and_preserves_original_release() {
    let owned = OwnedDirectory::new(true);
    let old_image = image("0.1.0", 1);
    let new_image = image("0.2.0", 2);
    let old_approval = approval(&old_image);
    let new_approval = approval(&new_image);
    assert_eq!(old_approval.plugin.publisher, new_approval.plugin.publisher);
    assert_eq!(old_approval.plugin.id, new_approval.plugin.id);
    assert_eq!(old_approval.plugin.version, "0.1.0");
    assert_eq!(new_approval.plugin.version, "0.2.0");
    assert_ne!(old_approval.package_digest, new_approval.package_digest);
    assert_eq!(old_approval.origin, new_approval.origin);
    let mut catalog = PackageCatalog::new();
    catalog.register(old_image, old_approval.clone()).unwrap();
    catalog.register(new_image, new_approval.clone()).unwrap();
    let runtime = runtime_fixture::approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let mut installation =
        PackageStore::provision(owned.path(), &["application", "plugins"], || true).unwrap();
    let original_install_action = ExecutionId::new();
    let original_install = installation
        .install(
            &original_install_action.to_string(),
            catalog.registered(&old_approval.plugin).unwrap(),
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
    installation
        .update_settings(
            0,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: vec![ApprovedPackageSetting {
                    approval: old_approval.clone(),
                    enabled: true,
                }],
                runtimes: vec![runtime_approval.clone()],
            },
            || true,
        )
        .unwrap();
    assert_eq!(
        original_install.action_id(),
        original_install_action.to_string()
    );
    assert_eq!(original_install.plugin(), &old_approval.plugin);
    assert_eq!(
        original_install.package_digest(),
        old_approval.package_digest
    );
    assert_eq!(original_install.origin(), &old_approval.origin);
    drop(installation);
    drop(runtime);
    let old_choice = source_choice(&old_approval, &runtime_approval);
    let new_choice = source_choice(&new_approval, &runtime_approval);
    let old_build = build_choice(&old_choice);
    let material_directory = owned.path().join("materials");
    fs::create_dir(&material_directory).unwrap();
    fs::write(material_directory.join("record.txt"), RAW).unwrap();
    let project_path = owned.path().join("project");
    let (app, window, cleanup) = application(&owned);
    let state = app.state::<AppState>();
    let original_inventory: PluginInventoryView =
        serde_json::from_value(call(&window, "read_plugin_inventory", json!({})).unwrap()).unwrap();
    assert_eq!(original_inventory.packages.len(), 1);
    assert_eq!(
        original_inventory.packages[0].original_install_action,
        original_install.action_id()
    );
    assert_eq!(original_inventory.package_decisions.len(), 1);
    assert!(original_inventory.package_decisions[0].enabled);
    let project = call(&window,"create_project",json!({"destination":project_path,"displayName":"Explicit source interpretation upgrade","sourceLocale":"en-US","targetLocales":[LOCALE]})).unwrap();
    let original_context = context(&project);
    let mut grants = vec![];
    let (original_attempt, original_result, original_preview) = extract_checked(
        &app,
        &window,
        &original_context,
        &material_directory,
        &old_choice,
        &mut grants,
    );
    let old_native = &original_preview["rows"][0]["occurrence"]["nativeIdentity"];
    assert_eq!(old_native["namespace"], "Synthetic.UpgradeRecords");
    assert_eq!(old_native["value"], "mixedcase");
    assert_eq!(old_native["display"]["value"], "MixedCase");
    assert_eq!(old_native["policy"], contract("example.upgrade.key", 1));
    adopt(
        &window,
        &original_context,
        &original_attempt,
        &original_result,
        &original_preview["confirmation"],
    );
    let old_scope = call(&window, "read_content_scope", original_context.clone()).unwrap();
    let old_snapshot: ExecutionId =
        serde_json::from_value(old_scope["currentSnapshot"].clone()).unwrap();
    let old_content = call(
        &window,
        "read_source_content",
        scoped(
            &original_context,
            json!({"snapshotId":old_snapshot,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    assert_eq!(old_content["total"], 1);
    let old_unit = old_content["rows"][0]["unitId"].clone();
    let old_revision = old_content["rows"][0]["sourceRevisionId"].clone();
    let manual = call(
        &window,
        "save_translation_revision",
        scoped(
            &original_context,
            json!({"actionId":ExecutionId::new(),"unitId":old_unit,"locale":LOCALE,
        "sourceRevisionId":old_revision,"expectedSelectionId":null,"text":TRANSLATION}),
        ),
    )
    .unwrap();
    assert_eq!(manual["revision"]["text"], TRANSLATION);
    assert_eq!(manual["revision"]["originKind"], "manual");
    let old_target_fields = json!({"unitId":old_unit,"locale":LOCALE});
    let target = call(
        &window,
        "read_review_target",
        scoped(&original_context, old_target_fields.clone()),
    )
    .unwrap();
    let review_intent = scoped(
        &original_context,
        json!({"unitId":old_unit,"locale":LOCALE,"expectedBasis":target["basis"],"actionId":ExecutionId::new(),"advisoryChecks":[]}),
    );
    let review = call(&window, "prepare_review_checks", review_intent.clone()).unwrap();
    assert_eq!(review["kind"], "plugin");
    assert_eq!(review["view"]["checkers"].as_array().unwrap().len(), 1);
    let review_starts = consents(&original_context, &review["view"]);
    let reviewed = call(
        &window,
        "run_review_checks",
        scoped(
            &original_context,
            json!({"check":review_intent,"executions":review_starts}),
        ),
    )
    .unwrap();
    assert_eq!(reviewed["outcome"], "completed");
    assert!(
        reviewed["rules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|rule| rule["status"] == "passed"),
        "{reviewed}"
    );
    assert_eq!(
        reviewed["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rule| rule["rule"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        [
            "required-translation",
            "terminology",
            "plugin:example.upgrade.review"
        ]
        .into_iter()
        .collect()
    );
    result(&window, &original_context, &review_starts[0]["attemptId"]);
    grants.push(review_starts[0].clone());
    let reviewed_target = call(
        &window,
        "read_review_target",
        scoped(&original_context, old_target_fields.clone()),
    )
    .unwrap();
    let decision = call(&window,"write_review_decision",scoped(&original_context,json!({"decision":{
        "projectId":original_context["projectId"],"unitId":old_unit,"locale":LOCALE,"expectedBasis":reviewed_target["basis"],"expectedDecisionId":null,
        "actor":"Synthetic reviewer","kind":"approve","reason":"Checked exact original records selection","actionId":ExecutionId::new()}}))).unwrap();
    let eligibility = call(
        &window,
        "read_review_eligibility",
        scoped(&original_context, json!({"locales":[LOCALE]})),
    )
    .unwrap();
    assert_eq!(eligibility["ready"], true);
    let build = call(&window,"prepare_plugin_build",scoped(&original_context,json!({"attemptId":ExecutionId::new(),"build":old_build,"expectedEligibilityBasis":eligibility["basis"],
        "choices":[{"locale":LOCALE,"outputPaths":[OUTPUT_PATH],"configuration":[]}]}))).unwrap();
    let build_start = consent(&original_context, &build);
    let built = call(&window, "start_plugin_build", build_start.clone()).unwrap();
    grants.push(build_start);
    let detail = completed(&window, &original_context, &built);
    assert_eq!(detail["items"].as_array().unwrap().len(), 1);
    let built_result = detail["items"][0]["resultId"].clone();
    assert!(built_result.is_string());
    let release_action = ExecutionId::new();
    call(
        &window,
        "prepare_execution_adoption",
        scoped(
            &original_context,
            json!({"attemptId":built,"unitId":detail["recovery"]["units"][0]["unitId"],
        "resultIds":[built_result],"actionId":release_action}),
        ),
    )
    .unwrap();
    let artifact_check = call(&window,"prepare_artifact_check",scoped(&original_context,json!({"buildAttemptId":built,"buildResultId":built_result,"attemptId":ExecutionId::new(),"build":old_build}))).unwrap();
    let artifact_start = consent(&original_context, &artifact_check);
    let artifact_attempt = call(&window, "start_artifact_check", artifact_start.clone()).unwrap();
    grants.push(artifact_start);
    let artifact_result = result(&window, &original_context, &artifact_attempt);
    call(
        &window,
        "finish_artifact_check",
        scoped(
            &original_context,
            json!({"attemptId":artifact_attempt,"resultId":artifact_result}),
        ),
    )
    .unwrap();
    let release_receipt = call(
        &window,
        "adopt_execution",
        scoped(&original_context, json!({"actionId":release_action})),
    )
    .unwrap();
    assert_eq!(
        call(
            &window,
            "adopt_execution",
            scoped(&original_context, json!({"actionId":release_action}))
        )
        .unwrap(),
        release_receipt
    );
    idle(&window, &original_context);
    let original_frames = state
        .sessions
        .with(|sessions| frames(&sessions.active.as_ref().unwrap().store));
    assert_eq!(original_frames.len(), 5);
    let actual_capabilities = original_frames
        .iter()
        .map(|frame| {
            frame
                .input
                .envelope()
                .plugin
                .as_ref()
                .unwrap()
                .capability
                .declaration
                .contract
                .id
                .as_str()
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        actual_capabilities,
        [
            "example.upgrade.extract",
            "example.upgrade.source-check",
            "example.upgrade.review-check",
            "example.upgrade.build",
            "example.upgrade.artifact-check"
        ]
        .into_iter()
        .collect()
    );
    let expected_profile: sdk::ContractRef = serde_json::from_value(profile()).unwrap();
    for frame in &original_frames {
        let binding = frame.input.envelope().plugin.as_ref().unwrap();
        assert_eq!(binding.capability.provider.plugin, old_approval.plugin);
        assert_eq!(
            binding.capability.provider.package_digest,
            old_approval.package_digest
        );
        assert_eq!(binding.profile.as_ref(), Some(&expected_profile));
        assert_eq!(binding.environment, runtime_approval.environment);
        assert_eq!(frame.results.len(), 1);
        assert_eq!(
            frame.results[0].envelope().attempt_id,
            frame.input.envelope().attempt_id
        );
        assert_eq!(
            frame.results[0]
                .envelope()
                .plugin
                .as_ref()
                .unwrap()
                .channel
                .selection(),
            binding.capability.provider
        );
        assert_eq!(
            frame.input.digest(),
            sdk::payload_digest(std::str::from_utf8(frame.input.bytes()).unwrap())
        );
        assert_eq!(
            frame.results[0].digest(),
            sdk::payload_digest(std::str::from_utf8(frame.results[0].bytes()).unwrap())
        );
    }
    let releases = call(&window, "list_releases", original_context.clone()).unwrap();
    assert_eq!(releases.as_array().unwrap().len(), 1);
    let release_id: ExecutionId = serde_json::from_value(releases[0]["releaseId"].clone()).unwrap();
    // Independent literal oracle, never read back from a producer or builder.
    let expected = "MixedCase\t你好 👩🏽‍💻 e\u{301}\r\n".as_bytes().to_vec();
    let expected_bytes = expected.clone();
    let (old_bundle, old_release) = state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        assert_eq!(
            store
                .release_artifact_by_path(release_id, LOCALE, OUTPUT_PATH)
                .unwrap()
                .1,
            expected_bytes
        );
        (
            store.source_bundle(old_snapshot).unwrap(),
            store.release_view(release_id).unwrap(),
        )
    });
    assert_eq!(old_bundle.profile, expected_profile);
    assert_eq!(old_bundle.files.len(), 1);
    assert_eq!(old_bundle.files[0].utf8.as_bytes(), RAW.as_bytes());
    assert_eq!(old_bundle.files[0].sha256, sdk::payload_digest(RAW));
    let original_source_input = original_frames
        .iter()
        .find(|frame| {
            frame.input.envelope().attempt_id
                == serde_json::from_value::<ExecutionId>(original_attempt.clone()).unwrap()
        })
        .unwrap()
        .input
        .clone();
    let original_settings = SourceSettings::from_input(&original_source_input).unwrap();
    let source_history = call(
        &window,
        "read_source_history",
        scoped(&original_context, json!({"offset":0,"limit":50})),
    )
    .unwrap();
    let translation_fields =
        json!({"unitId":old_unit,"locale":LOCALE,"afterOrdinal":"0","limit":50});
    let translation_history = call(
        &window,
        "read_translation_history",
        scoped(&original_context, translation_fields.clone()),
    )
    .unwrap();
    assert_eq!(translation_history["rows"], json!([manual["revision"]]));
    let review_fields = json!({"unitId":old_unit,"locale":LOCALE,"offset":0,"limit":50});
    let review_history = call(
        &window,
        "read_review_history",
        scoped(&original_context, review_fields.clone()),
    )
    .unwrap();
    assert_eq!(review_history["checks"], json!([reviewed]));
    assert_eq!(review_history["decisions"], json!([decision]));
    call(
        &window,
        "close_project",
        json!({"sessionToken":original_context["sessionToken"]}),
    )
    .unwrap();
    state.sessions.with(|sessions| {
        assert!(sessions.active.is_none());
        assert!(sessions.package_operation.is_none());
    });
    cleanup.require_released_staging().unwrap();
    drop(state);
    drop(window);
    drop(cleanup);
    drop(app);

    // Explicitly install the second complete package through the original
    // Store after the first application has released its lock. Versions coexist.
    let mut installation =
        PackageStore::open_existing(&owned.path().join("application/plugins")).unwrap();
    let new_install_action = ExecutionId::new();
    let new_install = installation
        .install(
            &new_install_action.to_string(),
            catalog.registered(&new_approval.plugin).unwrap(),
            || true,
        )
        .unwrap();
    assert_ne!(new_install.action_id(), original_install.action_id());
    assert_eq!(
        installation.load(&old_approval, || true).unwrap().receipt(),
        &original_install
    );
    assert_eq!(
        installation.load(&new_approval, || true).unwrap().receipt(),
        &new_install
    );
    installation
        .update_settings(
            1,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: vec![
                    ApprovedPackageSetting {
                        approval: old_approval.clone(),
                        enabled: true,
                    },
                    ApprovedPackageSetting {
                        approval: new_approval.clone(),
                        enabled: true,
                    },
                ],
                runtimes: vec![runtime_approval.clone()],
            },
            || true,
        )
        .unwrap();
    drop(installation);
    drop(catalog);
    assert_eq!(
        fs::read(material_directory.join("record.txt")).unwrap(),
        RAW.as_bytes()
    );
    let (app, window, cleanup) = application(&owned);
    let state = app.state::<AppState>();
    let upgraded: PluginInventoryView =
        serde_json::from_value(call(&window, "read_plugin_inventory", json!({})).unwrap()).unwrap();
    assert_eq!(upgraded.settings_revision.get(), 2);
    assert_eq!(upgraded.packages.len(), 2);
    assert_eq!(upgraded.package_decisions.len(), 2);
    assert!(
        upgraded
            .package_decisions
            .iter()
            .all(|decision| decision.enabled)
    );
    assert!(upgraded.packages.contains(&original_inventory.packages[0]));
    assert_eq!(upgraded.runtimes, original_inventory.runtimes);
    assert_eq!(
        upgraded.runtime_decisions,
        original_inventory.runtime_decisions
    );
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let current = context(&reopened);
    assert_eq!(current["projectId"], original_context["projectId"]);
    assert_ne!(current["sessionToken"], original_context["sessionToken"]);
    let require_original = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
                            current: &Value| {
        assert_eq!(
            call(window, "read_content_scope", current.clone()).unwrap(),
            old_scope
        );
        assert_eq!(
            call(
                window,
                "read_source_content",
                scoped(
                    current,
                    json!({"snapshotId":old_snapshot,"after":0,"limit":50})
                )
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
        assert_eq!(
            call(
                window,
                "read_review_history",
                scoped(current, review_fields.clone())
            )
            .unwrap(),
            review_history
        );
        assert_eq!(
            call(window, "list_releases", current.clone()).unwrap(),
            releases
        );
    };
    require_original(&window, &current);
    let saved_frames = original_frames.clone();
    let saved_bundle = old_bundle.clone();
    let saved_release = old_release.clone();
    let expected_bytes = expected.clone();
    state.sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(
            active.execution.is_none(),
            "installing/opening an available version cannot dispatch or adopt it"
        );
        unchanged_frames(&active.store, &saved_frames, 5);
        assert_eq!(
            active.store.source_bundle(old_snapshot).unwrap(),
            saved_bundle
        );
        assert_eq!(
            active.store.release_view(release_id).unwrap(),
            saved_release
        );
        assert_eq!(
            active
                .store
                .release_artifact_by_path(release_id, LOCALE, OUTPUT_PATH)
                .unwrap()
                .1,
            expected_bytes
        );
    });
    let (new_attempt, new_result, new_preview) = extract_checked(
        &app,
        &window,
        &current,
        &material_directory,
        &new_choice,
        &mut grants,
    );
    let new_native = &new_preview["rows"][0]["occurrence"]["nativeIdentity"];
    assert_eq!(new_native["namespace"], old_native["namespace"]);
    assert_eq!(
        new_native["display"]["value"],
        old_native["display"]["value"]
    );
    assert_eq!(
        new_native["display"]["source"]["range"],
        old_native["display"]["source"]["range"]
    );
    assert_eq!(new_native["value"], "MixedCase");
    assert_eq!(new_native["policy"], contract("example.upgrade.key", 2));
    assert_ne!(new_native["value"], old_native["value"]);
    assert_eq!(
        new_preview["confirmation"]["identityPolicy"],
        original_preview["confirmation"]["identityPolicy"]
    );
    assert_eq!(
        fs::read(material_directory.join("record.txt")).unwrap(),
        RAW.as_bytes()
    );
    require_original(&window, &current);
    let all_frames = state
        .sessions
        .with(|sessions| frames(&sessions.active.as_ref().unwrap().store));
    assert_eq!(all_frames.len(), 7);
    assert_eq!(
        grants
            .iter()
            .map(|start| start["grantId"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        7,
        "all seven actual Node executions require distinct original grants"
    );
    let new_source_input = all_frames
        .iter()
        .find(|frame| {
            frame.input.envelope().attempt_id
                == serde_json::from_value::<ExecutionId>(new_attempt.clone()).unwrap()
        })
        .unwrap()
        .input
        .clone();
    let new_bundle = SourceBundle::from_input(&new_source_input).unwrap();
    assert_eq!(new_bundle.profile, old_bundle.profile);
    assert_eq!(new_bundle.plugin_id, old_bundle.plugin_id);
    assert_eq!(new_bundle.files.len(), old_bundle.files.len());
    assert_eq!(
        new_bundle.files[0].logical_path,
        old_bundle.files[0].logical_path
    );
    assert_eq!(new_bundle.files[0].role, old_bundle.files[0].role);
    assert_eq!(
        new_bundle.files[0].utf8.as_bytes(),
        old_bundle.files[0].utf8.as_bytes()
    );
    assert_eq!(new_bundle.files[0].sha256, old_bundle.files[0].sha256);
    assert_eq!(
        new_native["display"]["source"]["artifactId"],
        json!(new_bundle.files[0].artifact_id)
    );
    assert_eq!(
        old_native["display"]["source"]["artifactId"],
        json!(old_bundle.files[0].artifact_id)
    );
    let new_settings = SourceSettings::from_input(&new_source_input).unwrap();
    assert_eq!(
        new_settings.revision_policy,
        original_settings.revision_policy
    );
    assert_eq!(
        serde_json::to_value(&new_settings.revision_policy).unwrap(),
        json!({"profile":profile(),"revisionBasis":[]})
    );
    assert_ne!(new_settings.review, original_settings.review);
    assert_eq!(
        new_settings.semantic_rules,
        vec![
            serde_json::from_value::<sdk::ContractRef>(contract(
                "example.upgrade.source-semantics",
                2
            ))
            .unwrap()
        ]
    );
    for frame in all_frames.iter().filter(|frame| {
        !original_frames
            .iter()
            .any(|old| old.input.envelope().attempt_id == frame.input.envelope().attempt_id)
    }) {
        let binding = frame.input.envelope().plugin.as_ref().unwrap();
        assert_eq!(binding.capability.provider.plugin, new_approval.plugin);
        assert_eq!(
            binding.capability.provider.package_digest,
            new_approval.package_digest
        );
        assert_eq!(binding.environment, runtime_approval.environment);
        assert_eq!(binding.profile.as_ref(), Some(&expected_profile));
        assert_eq!(binding.capability.declaration.contract.behavior_version, 2);
        assert_eq!(frame.results.len(), 1);
        assert_eq!(
            frame.results[0]
                .envelope()
                .plugin
                .as_ref()
                .unwrap()
                .channel
                .selection(),
            binding.capability.provider
        );
    }
    let comparison = call(&window,"read_source_comparison",scoped(&current,json!({"attemptId":new_attempt,"resultId":new_result,"base":old_snapshot,"filter":"","after":0,"limit":50}))).unwrap();
    assert_eq!(comparison["previousSnapshotId"], json!(old_snapshot));
    assert_eq!(comparison["total"], 2);
    assert_eq!(comparison["added"], 1);
    assert_eq!(comparison["removed"], 1);
    assert_eq!(comparison["changed"], 0);
    assert_eq!(comparison["unchanged"], 0);
    assert_eq!(comparison["ambiguous"], 0);
    assert_eq!(comparison["rows"][0]["kind"], "added");
    assert_eq!(comparison["rows"][0]["new"]["nativeIdentity"], *new_native);
    assert!(comparison["rows"][0]["old"].is_null());
    assert_eq!(comparison["rows"][0]["candidates"], json!([]));
    assert_eq!(comparison["rows"][1]["kind"], "removed");
    assert_eq!(comparison["rows"][1]["old"], old_content["rows"][0]);
    assert!(comparison["rows"][1]["new"].is_null());
    assert_eq!(comparison["rows"][1]["candidates"], json!([]));
    require_original(&window, &current);

    // A human choice cannot assert compatibility between different complete
    // native identity policies. The original adoption transaction must refuse.
    let mut incompatible = comparison["confirmation"].clone();
    incompatible["actor"] = json!("Synthetic maintainer");
    incompatible["lineage"] = json!([{"newOrdinal":0,"oldOccurrenceId":old_content["rows"][0]["occurrenceId"],"decision":"continue",
        "reason":"Deliberately invalid cross-policy continuation"}]);
    let rejected_action = ExecutionId::new();
    call(&window,"prepare_source_adoption",scoped(&current,json!({"attemptId":new_attempt,"resultId":new_result,"actionId":rejected_action,"confirmation":incompatible}))).unwrap();
    let rejected = call(
        &window,
        "adopt_execution",
        scoped(&current, json!({"actionId":rejected_action})),
    )
    .unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["reason"], "source-namespace");
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["recoveryRequired"], false);
    require_original(&window, &current);
    let saved_frames = all_frames.clone();
    state.sessions.with(move |sessions| {
        unchanged_frames(&sessions.active.as_ref().unwrap().store, &saved_frames, 7)
    });
    assert!(
        comparison["confirmation"]["lineage"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    adopt(
        &window,
        &current,
        &new_attempt,
        &new_result,
        &comparison["confirmation"],
    );
    let new_scope = call(&window, "read_content_scope", current.clone()).unwrap();
    assert_ne!(new_scope["currentSnapshot"], old_scope["currentSnapshot"]);
    let new_snapshot: ExecutionId =
        serde_json::from_value(new_scope["currentSnapshot"].clone()).unwrap();
    let new_content = call(
        &window,
        "read_source_content",
        scoped(
            &current,
            json!({"snapshotId":new_snapshot,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    assert_eq!(new_content["rows"].as_array().unwrap().len(), 1);
    assert_eq!(
        new_content["rows"][0]["occurrence"]["nativeIdentity"],
        *new_native
    );
    assert_ne!(new_content["rows"][0]["unitId"], old_unit);
    assert_ne!(new_content["rows"][0]["sourceRevisionId"], old_revision);
    let new_target = call(
        &window,
        "read_review_target",
        scoped(
            &current,
            json!({"unitId":new_content["rows"][0]["unitId"],"locale":LOCALE}),
        ),
    )
    .unwrap();
    assert_eq!(new_target["sourceText"], TEXT);
    assert!(new_target["translationText"].is_null());
    assert!(new_target["currentCheck"].is_null());
    assert!(new_target["currentDecision"].is_null());
    assert_eq!(
        call(
            &window,
            "read_review_eligibility",
            scoped(&current, json!({"locales":[LOCALE]}))
        )
        .unwrap()["ready"],
        false
    );
    let after_history = call(
        &window,
        "read_source_history",
        scoped(&current, json!({"offset":0,"limit":50})),
    )
    .unwrap();
    assert_eq!(after_history["total"], 2);
    let old_entry = after_history["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["snapshotId"] == json!(old_snapshot))
        .unwrap();
    let mut expected_old_entry = source_history["snapshots"][0].clone();
    expected_old_entry["current"] = json!(false);
    assert_eq!(*old_entry, expected_old_entry);
    let historical = call(
        &window,
        "read_source_content",
        scoped(
            &current,
            json!({"snapshotId":old_snapshot,"after":0,"limit":50}),
        ),
    )
    .unwrap();
    for field in [
        "snapshotId",
        "attemptId",
        "resultId",
        "namespace",
        "coverage",
        "total",
        "nextOrdinal",
        "diagnostics",
        "rows",
    ] {
        assert_eq!(
            historical[field], old_content[field],
            "immutable old source field changed: {field}"
        );
    }
    assert_eq!(
        call(
            &window,
            "read_translation_history",
            scoped(&current, translation_fields.clone())
        )
        .unwrap(),
        translation_history
    );
    assert_eq!(
        call(
            &window,
            "read_review_history",
            scoped(&current, review_fields.clone())
        )
        .unwrap(),
        review_history
    );
    assert_eq!(
        call(&window, "list_releases", current.clone()).unwrap(),
        releases
    );
    let saved_frames = all_frames.clone();
    let saved_old_bundle = old_bundle.clone();
    let saved_new_bundle = new_bundle.clone();
    let saved_release = old_release.clone();
    let expected_bytes = expected.clone();
    state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        unchanged_frames(store, &saved_frames, 7);
        assert_eq!(store.source_bundle(old_snapshot).unwrap(), saved_old_bundle);
        assert_eq!(store.source_bundle(new_snapshot).unwrap(), saved_new_bundle);
        assert_eq!(store.release_view(release_id).unwrap(), saved_release);
        assert_eq!(
            store
                .release_artifact_by_path(release_id, LOCALE, OUTPUT_PATH)
                .unwrap()
                .1,
            expected_bytes
        );
    });

    // Export the saved original artifact after the explicit new interpretation;
    // no builder rerun or new grant is involved in delivery.
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
            .select_for_test(delivery_selection, selected)
    });
    let delivery_preview = call(
        &window,
        "preview_delivery",
        scoped(
            &current,
            json!({"releaseId":release_id,"selectionId":delivery_selection}),
        ),
    )
    .unwrap();
    assert_eq!(delivery_preview["files"].as_array().unwrap().len(), 1);
    assert_eq!(delivery_preview["files"][0]["state"], "absent");
    let expected_digest = tsumugi_core::content::artifact_digest(&expected);
    assert_eq!(
        delivery_preview["files"][0]["expectedSha256"],
        expected_digest
    );
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    let delivery_request = scoped(
        &current,
        json!({"releaseId":release_id,"selectionId":delivery_selection,"previewId":delivery_preview["previewId"],"actionId":ExecutionId::new(),"overwriteConflicts":false}),
    );
    let delivered = call(&window, "export_release", delivery_request.clone()).unwrap();
    assert_eq!(delivered["state"], "succeeded");
    assert_eq!(delivered["files"][0]["actualSha256"], expected_digest);
    assert_eq!(
        call(&window, "export_release", delivery_request).unwrap(),
        delivered
    );
    assert_eq!(fs::read(destination.join(OUTPUT_PATH)).unwrap(), expected);
    idle(&window, &current);
    call(
        &window,
        "close_project",
        json!({"sessionToken":current["sessionToken"]}),
    )
    .unwrap();
    cleanup.require_released_staging().unwrap();
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let final_context = context(&reopened);
    assert_eq!(
        call(&window, "read_content_scope", final_context.clone()).unwrap(),
        new_scope
    );
    assert_eq!(
        call(
            &window,
            "read_source_content",
            scoped(
                &final_context,
                json!({"snapshotId":new_snapshot,"after":0,"limit":50})
            )
        )
        .unwrap(),
        new_content
    );
    assert_eq!(
        call(
            &window,
            "read_source_content",
            scoped(
                &final_context,
                json!({"snapshotId":old_snapshot,"after":0,"limit":50})
            )
        )
        .unwrap(),
        historical
    );
    assert_eq!(
        call(
            &window,
            "read_source_history",
            scoped(&final_context, json!({"offset":0,"limit":50}))
        )
        .unwrap(),
        after_history
    );
    assert_eq!(
        call(
            &window,
            "read_translation_history",
            scoped(&final_context, translation_fields)
        )
        .unwrap(),
        translation_history
    );
    assert_eq!(
        call(
            &window,
            "read_review_history",
            scoped(&final_context, review_fields)
        )
        .unwrap(),
        review_history
    );
    assert_eq!(
        call(&window, "list_releases", final_context.clone()).unwrap(),
        releases
    );
    let saved_frames = all_frames.clone();
    let saved_old_bundle = old_bundle.clone();
    let saved_new_bundle = new_bundle.clone();
    let saved_release = old_release.clone();
    let expected_bytes = expected.clone();
    state.sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(
            active.execution.is_none(),
            "saved old/new history does not create a Worker Host"
        );
        unchanged_frames(&active.store, &saved_frames, 7);
        assert_eq!(
            active.store.source_bundle(old_snapshot).unwrap(),
            saved_old_bundle
        );
        assert_eq!(
            active.store.source_bundle(new_snapshot).unwrap(),
            saved_new_bundle
        );
        assert_eq!(
            active.store.release_view(release_id).unwrap(),
            saved_release
        );
        assert_eq!(
            active
                .store
                .release_artifact_by_path(release_id, LOCALE, OUTPUT_PATH)
                .unwrap()
                .1,
            expected_bytes
        );
    });
    assert_eq!(fs::read(destination.join(OUTPUT_PATH)).unwrap(), expected);
    call(
        &window,
        "close_project",
        json!({"sessionToken":final_context["sessionToken"]}),
    )
    .unwrap();
    cleanup.require_released_staging().unwrap();
    drop(state);
    drop(window);
    drop(cleanup);
    drop(app);
}
