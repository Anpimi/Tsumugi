//! Two source generations, checked releases and real exports through registered IPC.
use super::*;
use std::collections::BTreeMap;

const S1: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../crates/core/tests/fixtures/webvtt/s1.vtt"
));
const S2: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../crates/core/tests/fixtures/webvtt/s2.vtt"
));
const S1_OUTPUT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../crates/core/tests/fixtures/webvtt/expected-zh-CN.vtt"
));
const LOCALE: &str = "zh-CN";

fn ipc(window: &TestWindow, context: &Value, command: &str, fields: Value) -> Value {
    call(window, command, scoped(context, fields))
        .unwrap_or_else(|error| panic!("{command}: {error}"))
}

fn target(window: &TestWindow, context: &Value, row: &Value) -> Value {
    ipc(
        window,
        context,
        "read_review_target",
        json!({"unitId":row["unitId"],"locale":LOCALE}),
    )
}

fn rows(page: &Value) -> BTreeMap<String, Value> {
    page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["occurrence"]["key"].as_str().unwrap().to_owned(),
                row.clone(),
            )
        })
        .collect()
}

fn translation_history(window: &TestWindow, context: &Value, row: &Value) -> Value {
    ipc(
        window,
        context,
        "read_translation_history",
        json!({"unitId":row["unitId"],"locale":LOCALE,"afterOrdinal":"0","limit":50}),
    )
}

fn review_history(window: &TestWindow, context: &Value, row: &Value) -> Value {
    ipc(
        window,
        context,
        "read_review_history",
        json!({"unitId":row["unitId"],"locale":LOCALE,"offset":0,"limit":50}),
    )
}

fn save(window: &TestWindow, context: &Value, row: &Value, text: &str) {
    let current = target(window, context, row);
    ipc(
        window,
        context,
        "save_translation_revision",
        json!({"unitId":row["unitId"],"locale":LOCALE,
        "sourceRevisionId":row["sourceRevisionId"],"expectedSelectionId":current["selectionId"],
        "text":text,"actionId":ExecutionId::new()}),
    );
}

fn import_source(
    window: &TestWindow,
    state: &AppState,
    context: &Value,
    source: &PluginSourceRequest,
    directory: PathBuf,
    previous: Option<&BTreeMap<String, Value>>,
) -> Value {
    let selection = ExecutionId::new();
    let choice = source.clone();
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
        host.source.plugin.choice = Some((selection, choice));
    });
    let prepared = ipc(
        window,
        context,
        "preflight_plugin_source",
        json!({"selectionId":selection,
        "sourceLanguage":"en-US","attemptId":ExecutionId::new()}),
    );
    let started = call(
        window,
        "start_plugin_source",
        source_consent(context, &prepared),
    )
    .unwrap();
    let detail = completed(window, context, &started);
    let result = &detail["items"][0]["resultId"];
    let preview = ipc(
        window,
        context,
        "read_source_preview",
        json!({"attemptId":started,"resultId":result,"after":0,"limit":50}),
    );
    assert_eq!(preview["total"], 6);
    let mut confirmation = preview["confirmation"].clone();
    if let Some(previous) = previous {
        let comparison = ipc(
            window,
            context,
            "read_source_comparison",
            json!({"attemptId":started,
            "resultId":result,"base":confirmation["expectedCurrentSnapshot"],"filter":"","after":0,"limit":50}),
        );
        confirmation = comparison["confirmation"].clone();
        confirmation["actor"] = json!("Synthetic caption maintainer");
        confirmation["lineageBaseSnapshot"] = comparison["previousSnapshotId"].clone();
        let mut decisions = Vec::new();
        for (new_key, old_key) in [
            ("timed", "timed"),
            ("word", "word"),
            ("layout", "layout"),
            ("renamed", "rename"),
        ] {
            let change = comparison["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|change| change["new"]["key"] == new_key)
                .unwrap();
            assert!(
                matches!(
                    change["kind"].as_str(),
                    Some("changed" | "rename-candidate")
                ),
                "{change}"
            );
            decisions.push(json!({"newOrdinal":change["new"]["ordinal"],"oldOccurrenceId":previous[old_key]["occurrenceId"],
                "decision":"continue","reason":format!("Keep the reviewed caption identity: {old_key} to {new_key}")}));
        }
        assert!(
            comparison["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|change| change["kind"] == "removed"
                    && change["old"]["occurrence"]["key"] == "removed")
        );
        assert!(
            comparison["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|change| change["kind"] == "added" && change["new"]["key"] == "added")
        );
        confirmation["lineage"] = json!(decisions);
    }
    let action = ExecutionId::new();
    ipc(
        window,
        context,
        "prepare_source_adoption",
        json!({"attemptId":started,"resultId":result,"actionId":action,"confirmation":confirmation}),
    );
    // S1's independent source proof cannot authorize a new S2 result.
    assert!(
        call(
            window,
            "adopt_execution",
            scoped(context, json!({"actionId":action}))
        )
        .is_err()
    );
    let prepared = ipc(
        window,
        context,
        "prepare_source_check",
        json!({"sourceAttemptId":started,
        "sourceResultId":result,"attemptId":ExecutionId::new(),"source":source}),
    );
    let checked = call(
        window,
        "start_source_check",
        source_consent(context, &prepared),
    )
    .unwrap();
    let check = completed(window, context, &checked);
    ipc(
        window,
        context,
        "finish_source_check",
        json!({"attemptId":checked,"resultId":check["items"][0]["resultId"]}),
    );
    ipc(
        window,
        context,
        "adopt_execution",
        json!({"actionId":action}),
    );
    let scope = ipc(window, context, "read_content_scope", json!({}));
    ipc(
        window,
        context,
        "read_source_content",
        json!({"snapshotId":scope["currentSnapshot"],"after":0,"limit":50}),
    )
}

fn check_and_approve(window: &TestWindow, context: &Value, row: &Value) {
    let current = target(window, context, row);
    let intent = scoped(
        context,
        json!({"unitId":row["unitId"],"locale":LOCALE,
        "expectedBasis":current["basis"],"actionId":ExecutionId::new(),"advisoryChecks":[]}),
    );
    let preparation = call(window, "prepare_review_checks", intent.clone()).unwrap();
    assert_eq!(preparation["kind"], "plugin");
    let checked = ipc(
        window,
        context,
        "run_review_checks",
        json!({"check":intent,"executions":consents(context, &preparation["view"])}),
    );
    assert_eq!(checked["outcome"], "completed");
    let current = target(window, context, row);
    assert!(
        current["currentCheck"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|rule| rule["status"] == "passed"),
        "{current}"
    );
    if current["currentDecision"].is_null() {
        ipc(
            window,
            context,
            "write_review_decision",
            json!({"decision":{"projectId":context["projectId"],
            "unitId":row["unitId"],"locale":LOCALE,"expectedBasis":current["basis"],"expectedDecisionId":null,
            "actor":"Synthetic caption reviewer","kind":"approve","reason":"Checked current caption and formatting","actionId":ExecutionId::new()}}),
        );
    }
}

struct Release {
    view: Value,
    delivery: Value,
    destination: PathBuf,
    expected: Vec<u8>,
}

fn build_and_export(
    window: &TestWindow,
    state: &AppState,
    context: &Value,
    build: &crate::commands::plugins::PluginBuildRequest,
    destination: PathBuf,
    expected: Vec<u8>,
) -> Release {
    let eligibility = ipc(
        window,
        context,
        "read_review_eligibility",
        json!({"locales":[LOCALE]}),
    );
    assert_eq!(eligibility["ready"], true, "{eligibility}");
    let prepared = ipc(
        window,
        context,
        "prepare_plugin_build",
        json!({"attemptId":ExecutionId::new(),
        "build":build,"expectedEligibilityBasis":eligibility["basis"],
        "choices":[{"locale":LOCALE,"outputPaths":["zh-CN.vtt"],"configuration":[]}]}),
    );
    let built = call(window, "start_plugin_build", consent(context, &prepared)).unwrap();
    let detail = completed(window, context, &built);
    assert_eq!(detail["items"].as_array().unwrap().len(), 1);
    let result = &detail["items"][0]["resultId"];
    let adoption = ipc(
        window,
        context,
        "prepare_execution_adoption",
        json!({"attemptId":built,
        "unitId":detail["recovery"]["units"][0]["unitId"],"resultIds":[result],"actionId":ExecutionId::new()}),
    );
    let action = scoped(context, json!({"actionId":adoption["actionId"]}));
    // A prior release's artifact proof never qualifies this new build.
    assert!(call(window, "adopt_execution", action.clone()).is_err());
    let prepared = ipc(
        window,
        context,
        "prepare_artifact_check",
        json!({"buildAttemptId":built,
        "buildResultId":result,"attemptId":ExecutionId::new(),"build":build}),
    );
    let checked = call(window, "start_artifact_check", consent(context, &prepared)).unwrap();
    let check = completed(window, context, &checked);
    ipc(
        window,
        context,
        "finish_artifact_check",
        json!({"attemptId":checked,"resultId":check["items"][0]["resultId"]}),
    );
    let receipt = call(window, "adopt_execution", action.clone()).unwrap();
    assert_eq!(call(window, "adopt_execution", action).unwrap(), receipt);
    let releases = ipc(window, context, "list_releases", json!({}));
    let release = releases
        .as_array()
        .unwrap()
        .iter()
        .find(|release| release["attemptId"] == built)
        .unwrap()
        .clone();
    assert_eq!(release["sourceSnapshotId"], eligibility["sourceSnapshotId"]);
    fs::create_dir(&destination).unwrap();
    let selection = ExecutionId::new();
    let selected = destination.clone();
    state.sessions.with(move |sessions| {
        sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0
            .release
            .select_for_test(
                selection,
                Arc::new(capture::Selection::authorize(selected).unwrap()),
            );
    });
    let preview = ipc(
        window,
        context,
        "preview_delivery",
        json!({"releaseId":release["releaseId"],"selectionId":selection}),
    );
    assert_eq!(preview["files"].as_array().unwrap().len(), 1);
    assert_eq!(preview["files"][0]["state"], "absent");
    assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    let export = scoped(
        context,
        json!({"releaseId":release["releaseId"],"selectionId":selection,
        "previewId":preview["previewId"],"actionId":ExecutionId::new(),"overwriteConflicts":false}),
    );
    let delivery = call(window, "export_release", export.clone()).unwrap();
    assert_eq!(delivery["state"], "succeeded");
    assert_eq!(call(window, "export_release", export).unwrap(), delivery);
    assert_eq!(fs::read(destination.join("zh-CN.vtt")).unwrap(), expected);
    Release {
        view: release,
        delivery,
        destination,
        expected,
    }
}

fn assert_release(window: &TestWindow, state: &AppState, context: &Value, release: &Release) {
    let releases = ipc(window, context, "list_releases", json!({}));
    assert!(releases.as_array().unwrap().contains(&release.view));
    let delivery = ipc(
        window,
        context,
        "read_delivery_record",
        json!({"releaseId":release.view["releaseId"],
        "deliveryId":release.delivery["deliveryId"],"actionId":release.delivery["actionId"]}),
    );
    for field in [
        "deliveryId",
        "actionId",
        "releaseId",
        "state",
        "files",
        "createdAt",
    ] {
        assert_eq!(delivery[field], release.delivery[field], "{field}");
    }
    let id: ExecutionId = serde_json::from_value(release.view["releaseId"].clone()).unwrap();
    let expected = release.expected.clone();
    state.sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        assert_eq!(
            store
                .release_artifact_by_path(id, LOCALE, "zh-CN.vtt")
                .unwrap()
                .1,
            expected
        );
    });
    assert_eq!(
        fs::read(release.destination.join("zh-CN.vtt")).unwrap(),
        release.expected
    );
}

#[test]
fn included_webvtt_maintenance_builds_checks_and_exports_two_traceable_releases() {
    let temporary = OwnedTemporary(tempfile::tempdir().unwrap());
    let (app, window, installed, environment) = bundled_application(temporary.path());
    let state = app.state::<AppState>();
    let selected = installed["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["plugin"]["id"] == "webvtt")
        .unwrap();
    let package = crate::commands::plugins::PluginPackageRequest {
        plugin: serde_json::from_value(selected["plugin"].clone()).unwrap(),
        package_digest: selected["packageDigest"].as_str().unwrap().into(),
    };
    let source = PluginSourceRequest {
        package: package.clone(),
        resource_id: "source-profile".into(),
        environment_digest: environment.clone(),
    };
    let build = crate::commands::plugins::PluginBuildRequest {
        package,
        resource_id: "build-profile".into(),
        environment_digest: environment,
    };
    let project_path = temporary.path().join("project");
    let project = call(
        &window,
        "create_project",
        json!({"destination":project_path,"displayName":"Caption maintenance",
        "sourceLocale":"en-US","targetLocales":[LOCALE,"ja"]}),
    )
    .unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let s1_directory = temporary.path().join("source-s1");
    fs::create_dir(&s1_directory).unwrap();
    fs::write(s1_directory.join("source.vtt"), S1).unwrap();
    let first_page = import_source(&window, &state, &context, &source, s1_directory, None);
    let first = rows(&first_page);
    assert_eq!(first.len(), 6);
    for (key, text) in [
        ("keep", "你好\n世界"),
        ("timed", "等待"),
        ("word", "旧"),
        ("layout", "布局"),
        ("rename", "相同"),
        ("removed", "消失"),
    ] {
        save(&window, &context, &first[key], text);
    }
    let keep = target(&window, &context, &first["keep"]);
    let protection = ipc(
        &window,
        &context,
        "read_work_protection",
        json!({"unitId":first["keep"]["unitId"],"locale":LOCALE}),
    );
    let protection = ipc(
        &window,
        &context,
        "set_work_protection",
        json!({"actionId":ExecutionId::new(),
        "unitId":first["keep"]["unitId"],"locale":LOCALE,"sourceRevisionId":first["keep"]["sourceRevisionId"],
        "selectionId":keep["selectionId"],"expectedRevision":protection["revision"],"protected":true,"confirmedRelease":false}),
    );
    assert_eq!(protection["protected"], true);
    for row in first.values() {
        check_and_approve(&window, &context, row);
    }
    let retained = first
        .iter()
        .map(|(key, row)| {
            (
                key.clone(),
                (
                    target(&window, &context, row),
                    translation_history(&window, &context, row),
                    review_history(&window, &context, row),
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let first_release = build_and_export(
        &window,
        &state,
        &context,
        &build,
        temporary.path().join("delivery-s1"),
        S1_OUTPUT.as_bytes().to_vec(),
    );
    assert_release(&window, &state, &context, &first_release);
    eprintln!("First caption generation was checked, released and exported.");

    let s2_directory = temporary.path().join("source-s2");
    fs::create_dir(&s2_directory).unwrap();
    fs::write(s2_directory.join("source.vtt"), S2).unwrap();
    let second_page = import_source(
        &window,
        &state,
        &context,
        &source,
        s2_directory,
        Some(&first),
    );
    assert_ne!(second_page["snapshotId"], first_page["snapshotId"]);
    let second = rows(&second_page);
    assert_eq!(second.len(), 6);
    assert!(!second.contains_key("removed") && !second.contains_key("rename"));
    assert!(second.contains_key("added") && second.contains_key("renamed"));
    for (old_key, new_key) in [
        ("keep", "keep"),
        ("timed", "timed"),
        ("word", "word"),
        ("layout", "layout"),
        ("rename", "renamed"),
    ] {
        assert_eq!(second[new_key]["unitId"], first[old_key]["unitId"]);
        let current = target(&window, &context, &second[new_key]);
        assert_eq!(current["selectionId"], retained[old_key].0["selectionId"]);
        assert_eq!(current["revisionId"], retained[old_key].0["revisionId"]);
        assert_eq!(
            current["translationText"],
            retained[old_key].0["translationText"]
        );
        assert!(
            current["currentCheck"].is_null(),
            "S1 QA must not qualify S2: {new_key}"
        );
        assert_eq!(
            translation_history(&window, &context, &second[new_key]),
            retained[old_key].1
        );
        assert_eq!(
            review_history(&window, &context, &second[new_key]),
            retained[old_key].2
        );
    }
    let keep = target(&window, &context, &second["keep"]);
    assert_eq!(keep["basis"], retained["keep"].0["basis"]);
    assert_eq!(
        keep["currentDecision"],
        retained["keep"].0["currentDecision"]
    );
    assert_eq!(
        ipc(
            &window,
            &context,
            "read_work_protection",
            json!({"unitId":second["keep"]["unitId"],"locale":LOCALE})
        ),
        protection
    );
    assert_eq!(
        translation_history(&window, &context, &first["removed"]),
        retained["removed"].1
    );
    assert_eq!(
        review_history(&window, &context, &first["removed"]),
        retained["removed"].2
    );
    assert!(target(&window, &context, &second["added"])["selectionId"].is_null());
    let lineage = ipc(
        &window,
        &context,
        "read_source_lineage",
        json!({"snapshotId":second_page["snapshotId"],"ordinal":second["renamed"]["occurrence"]["ordinal"]}),
    );
    assert_eq!(lineage.as_array().unwrap().len(), 1);
    assert_eq!(lineage[0]["decision"], "continue");
    assert_eq!(lineage[0]["actor"], "Synthetic caption maintainer");
    assert_eq!(lineage[0]["oldSnapshotId"], first_page["snapshotId"]);
    let eligibility = ipc(
        &window,
        &context,
        "read_review_eligibility",
        json!({"locales":[LOCALE]}),
    );
    assert_eq!(eligibility["ready"], false);
    assert_release(&window, &state, &context, &first_release);

    save(&window, &context, &second["word"], "新");
    save(&window, &context, &second["added"], "新增");
    for row in second.values() {
        check_and_approve(&window, &context, row);
    }
    let expected = S2
        .replace("Hello 世界\nWorld", "你好\n世界")
        .replace("\nWait\n", "\n等待\n")
        .replace("\nNew\n", "\n新\n")
        .replace("\nLayout\n", "\n布局\n")
        .replace("\nSame\n", "\n相同\n")
        .replace("\nAdded\n", "\n新增\n");
    let second_release = build_and_export(
        &window,
        &state,
        &context,
        &build,
        temporary.path().join("delivery-s2"),
        expected.into_bytes(),
    );
    assert_ne!(
        second_release.view["releaseId"],
        first_release.view["releaseId"]
    );
    assert_ne!(
        second_release.view["sourceSnapshotId"],
        first_release.view["sourceSnapshotId"]
    );
    assert_release(&window, &state, &context, &first_release);
    assert_release(&window, &state, &context, &second_release);
    let releases = ipc(&window, &context, "list_releases", json!({}));
    assert_eq!(releases.as_array().unwrap().len(), 2);
    eprintln!(
        "Second caption generation was independently checked, released and exported; the first release is unchanged."
    );

    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let context = json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]});
    assert_eq!(ipc(&window, &context, "list_releases", json!({})), releases);
    assert_release(&window, &state, &context, &first_release);
    assert_release(&window, &state, &context, &second_release);
    assert_eq!(
        translation_history(&window, &context, &second["keep"]),
        retained["keep"].1
    );
    assert_eq!(
        ipc(
            &window,
            &context,
            "read_work_protection",
            json!({"unitId":second["keep"]["unitId"],"locale":LOCALE})
        ),
        protection
    );
    let history = ipc(
        &window,
        &context,
        "read_source_history",
        json!({"offset":0,"limit":50}),
    );
    assert_eq!(history["total"], 2);
    assert_eq!(
        ipc(
            &window,
            &context,
            "read_source_content",
            json!({"snapshotId":first_page["snapshotId"],"after":0,"limit":50})
        )["rows"],
        first_page["rows"]
    );
    let context = knowledge_consumers_preserve_history_after_source_disable(
        &window, &context, &source, &second_page, &second, &project_path,
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    state.plugins.close();
    drop(state);
    drop(app);
    removable(temporary.path());
}


fn knowledge_consumers_preserve_history_after_source_disable(
    window: &TestWindow,
    context: &Value,
    source: &PluginSourceRequest,
    page: &Value,
    rows: &BTreeMap<String, Value>,
    project_path: &Path,
) -> Value {
    let row = &rows["word"];
    let before = target(window, context, row);
    let history = translation_history(window, context, row);
    let source_basis = ipc(window, context, "read_content_scope", json!({}));
    let scope = |row: &Value, locale: &str| json!({"projectId":context["projectId"],
        "sourceSnapshotId":page["snapshotId"],"unitId":row["unitId"],"sourceRevisionId":row["sourceRevisionId"],"locale":locale});
    let config = tsumugi_core::ai::AiConfig { endpoint:"http://127.0.0.1:9/v1/chat/completions".into(),
        model:"local-preview-only".into(), credential_env:String::new(), share_terms:true, share_context:true, max_requests:1, ..Default::default() };
    let prepare = json!({"config":config,"locale":LOCALE,"unitIds":[row["unitId"]],
        "options":tsumugi_core::application::PlanOptions::default(),"advisoryChecks":[],"toolSelection":null,"maintenance":null});
    let old_plan = ipc(window, context, "prepare_work_plan", prepare.clone());
    let file = page["coverage"].as_array().unwrap().iter()
        .find(|file| file["artifactId"] == row["occurrence"]["artifactId"]).unwrap();
    let mut saved = Vec::new();
    for kind in ["character", "style", "background"] {
        let original = json!({"projectId":context["projectId"],"actionId":ExecutionId::new(),"kind":kind,
            "sourceBasis":source_basis,"locale":LOCALE,"scope":{"kind":"project"},
            "name":format!("Reviewed {kind}"),"text":format!("Project {kind}"),"actor":"Synthetic maintainer","reason":"Reviewed source materials"});
        let base = ipc(window, context, "save_context_resource", json!({"resource":original}));
        assert_eq!(ipc(window, context, "save_context_resource", json!({"resource":original})), base);
        let mut group = original.clone();
        group["actionId"] = json!(ExecutionId::new());
        group["subjectId"] = base["subjectId"].clone();
        group["scope"] = json!({"kind":"file-group","namespace":row["occurrence"]["namespace"],"logicalPaths":[file["logicalPath"]]});
        group["text"] = json!(format!("File {kind}"));
        let grouped = ipc(window, context, "save_context_resource", json!({"resource":group}));
        let mut narrow = original.clone();
        narrow["actionId"] = json!(ExecutionId::new());
        narrow["subjectId"] = base["subjectId"].clone();
        narrow["scope"] = json!({"kind":"unit","unitId":row["unitId"]});
        narrow["text"] = json!(format!("Unit {kind}"));
        let selected = ipc(window, context, "save_context_resource", json!({"resource":narrow}));
        let resolved = ipc(window, context, "resolve_context_resources", json!({"scope":scope(row,LOCALE)}));
        assert!(resolved["entries"].as_array().unwrap().iter().any(|entry| entry["revision"]["contextId"]==selected["contextId"] && entry["status"]=="selected"));
        assert!(resolved["entries"].as_array().unwrap().iter().any(|entry| entry["revision"]["contextId"]==grouped["contextId"] && entry["status"]=="shadowed"));
        let other = ipc(window, context, "resolve_context_resources", json!({"scope":scope(&rows["keep"],LOCALE)}));
        assert!(other["entries"].as_array().unwrap().iter().any(|entry| entry["revision"]["contextId"]==grouped["contextId"] && entry["status"]=="selected"));
        assert!(other["entries"].as_array().unwrap().iter().any(|entry| entry["revision"]["contextId"]==selected["contextId"] && entry["status"]=="outside-scope"));
        let mut edit = narrow;
        edit["actionId"] = json!(ExecutionId::new());
        edit["contextId"] = selected["contextId"].clone();
        edit["expectedRevisionId"] = selected["revisionId"].clone();
        edit["text"] = json!(format!("Human corrected {kind}"));
        let corrected = ipc(window, context, "save_context_resource", json!({"resource":edit}));
        let mut late = edit.clone(); late["actionId"] = json!(ExecutionId::new()); late["text"] = json!("Late stale value");
        assert!(call(window, "save_context_resource", scoped(context,json!({"resource":late}))).is_err());
        assert_eq!(ipc(window, context, "save_context_resource", json!({"resource":edit})), corrected);
        saved.push(corrected);
    }
    assert_eq!(ipc(window, context, "resolve_context_resources", json!({"scope":scope(row,"ja")}))["entries"],json!([]));
    let impacts = ipc(window, context, "resource_impacts", json!({"locale":LOCALE,"offset":0,"limit":100}));
    assert_eq!(impacts["items"].as_array().unwrap().len(),6);
    assert!(impacts["items"].as_array().unwrap().iter().all(|item| item["reasons"].as_array().unwrap().iter()
        .any(|reason| reason["kind"]=="context-resource" && reason["confidence"]=="scope-possible")));
    assert!(ipc(window, context, "resource_impacts", json!({"locale":"ja","offset":0,"limit":100}))["items"].as_array().unwrap().is_empty());
    let after = target(window, context, row);
    assert_eq!(after["selectionId"],before["selectionId"]);
    assert_eq!(after["currentDecision"],before["currentDecision"]);
    assert_eq!(after["currentCheck"],before["currentCheck"],"typed context impact does not invent a new format-check result");
    assert_eq!(translation_history(window, context, row),history);
    let segments = ipc(window, context, "read_segment_page", json!({"locale":LOCALE,"query":{"text":"","selection":"all","status":"all"},"scopeId":null,"cursor":null,"limit":50}));
    let segment_rows = segments["rows"].as_array().unwrap();
    assert_eq!(segment_rows.len(),rows.len());
    for row in segment_rows {
        // Recorded scope-possible changes remain visible without replacing the
        // separate current selection, human approval or format-check evidence.
        let applicability = &row["applicability"];
        assert!(row["content"]["selectionId"].is_string());
        assert_eq!(row["content"]["currentDecision"]["kind"],"approve");
        assert_eq!(row["qa"]["current"],true);
        assert_eq!(applicability["capturedBasisCurrent"],false);
        assert_eq!(applicability["resourceReviewRequired"],false);
        assert!(applicability["resourceImpact"]["reasonCount"].as_u64().unwrap()>0);
        assert!(applicability["resourceImpact"]["changes"].as_array().unwrap().iter()
            .any(|change| change["kind"]=="context-resource" && change["confidence"]=="scope-possible"));
        assert!(!row["qualification"]["blockers"].as_array().unwrap().iter()
            .any(|reason| reason["code"]=="resource-impact-unresolved"));
    }
    let expires = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()+600;
    let authorization = json!({"planId":old_plan["planId"],"digest":old_plan["digest"],"actionId":ExecutionId::new(),
        "confirmed":true,"effects":["save-candidate"],"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"expiresAt":expires.to_string()});
    let rejected = call(window,"authorize_work_plan",scoped(context,authorization)).unwrap_err();
    assert_eq!(rejected["code"],"dependency-conflict");
    assert!(matches!(rejected["reason"].as_str(),Some("work-plan-evidence"|"work-plan-preview")),"{rejected}");
    let fresh = ipc(window, context, "prepare_work_plan", prepare.clone());
    let captured = &fresh["preview"]["items"][0]["contextResources"]["entries"];
    assert_eq!(captured.as_array().unwrap().len(),3);
    for resource in &saved {
        assert!(captured.as_array().unwrap().iter().any(|entry| entry["revision"]["revisionId"]==resource["revisionId"]));
    }
    let inventory = call(window,"read_plugin_inventory",json!({})).unwrap();
    call(window,"set_plugin_enabled",json!({"package":source.package,"enabled":false,
        "expectedRevision":inventory["settingsRevision"],"actionId":ExecutionId::new()})).unwrap();
    let missing = call(window,"read_plugin_source",json!(source)).unwrap_err();
    assert_eq!(missing["reason"],"plugin-disabled");
    assert_eq!(target(window, context, row)["currentCheck"],after["currentCheck"]);
    assert_eq!(translation_history(window, context, row),history);
    for resource in &saved {
        assert_eq!(ipc(window,context,"read_context_resource_current",json!({"contextId":resource["contextId"]})),*resource);
    }
    let surviving = ipc(window, context, "prepare_work_plan", prepare.clone());
    assert_eq!(surviving["preview"]["items"][0]["contextResources"],fresh["preview"]["items"][0]["contextResources"]);
    assert_eq!(ipc(window,context,"resolve_context_resources",json!({"scope":scope(row,LOCALE)}))["entries"].as_array().unwrap().iter()
        .filter(|entry| entry["status"]=="selected").count(),3);
    // Knowledge and manual translation still use their original authorities
    // when the source package is disabled; no historical approval is renewed.
    let review_history_before = review_history(window, context, row);
    let term_request = json!({"projectId":context["projectId"],"actionId":ExecutionId::new(),"termId":null,
        "locale":LOCALE,"source":row["occurrence"]["text"],"aliases":[],"target":"初译","protected":false,
        "scopeUnitId":row["unitId"],"expectedRevisionId":null,"reason":"Human scoped terminology"});
    let initial_term = ipc(window,context,"save_term",json!({"term":term_request}));
    let mut edit = term_request;
    edit["actionId"] = json!(ExecutionId::new());
    edit["termId"] = initial_term["termId"].clone();
    edit["expectedRevisionId"] = initial_term["revisionId"].clone();
    edit["target"] = json!("新");
    let term = ipc(window,context,"save_term",json!({"term":edit}));
    assert_eq!(ipc(window,context,"save_term",json!({"term":edit})),term);
    let mut stale = edit.clone(); stale["actionId"] = json!(ExecutionId::new());
    stale["target"] = json!("Stale terminology must not replace the human edit");
    assert!(call(window,"save_term",scoped(context,json!({"term":stale}))).is_err());
    let terms = ipc(window,context,"resolve_terms",json!({"unitId":row["unitId"],"locale":LOCALE}));
    assert!(terms["entries"].as_array().unwrap().iter().any(|entry| entry["selected"]["revisionId"]==term["revisionId"]));
    assert!(ipc(window,context,"resolve_terms",json!({"unitId":rows["keep"]["unitId"],"locale":LOCALE}))["entries"].as_array().unwrap().is_empty());
    assert!(ipc(window,context,"resolve_terms",json!({"unitId":row["unitId"],"locale":"ja"}))["entries"].as_array().unwrap().is_empty());
    let term_target = target(window,context,row);
    assert_eq!(term_target["selectionId"],before["selectionId"]);
    assert!(term_target["currentCheck"].is_null() && term_target["currentDecision"].is_null());
    assert_eq!(review_history(window,context,row),review_history_before);
    assert_eq!(translation_history(window,context,row),history);

    let donor_target = target(window,context,&rows["renamed"]);
    let donor_request = json!({"unitId":rows["renamed"]["unitId"],"locale":LOCALE,"revisionId":donor_target["revisionId"]});
    let donor = ipc(window,context,"read_translation_memory_entry",donor_request.clone());
    let filter = json!({"sourceLocale":"en-US","targetLocale":LOCALE,"sourceText":null,"translationText":null,"origin":null,"selection":"all"});
    let memory = ipc(window,context,"list_translation_memory",json!({"filter":filter,"cursor":null,"limit":100}));
    assert!(memory["rows"].as_array().unwrap().iter().any(|entry| entry["revision"]["revisionId"]==donor["revision"]["revisionId"]));
    let reuse = json!({"projectId":context["projectId"],"unitId":row["unitId"],"locale":LOCALE,
        "sourceRevisionId":row["sourceRevisionId"],"expectedSelectionId":term_target["selectionId"],
        "donorUnitId":rows["renamed"]["unitId"],"donorRevisionId":donor["revision"]["revisionId"],"donorBasis":donor["basis"]});
    let staged = ipc(window,context,"prepare_translation_memory_reuse",json!({"reuse":reuse}));
    assert_eq!(staged["donor"],donor);
    assert_eq!(translation_history(window,context,row),history,"TM comparison and staging do not save a translation");
    let manual = json!({"actionId":ExecutionId::new(),"unitId":row["unitId"],"locale":LOCALE,
        "sourceRevisionId":row["sourceRevisionId"],"expectedSelectionId":term_target["selectionId"],
        "text":"新","reuseOrigin":staged["reuseOrigin"]});
    let reused = ipc(window,context,"save_translation_revision",manual.clone());
    assert_eq!(ipc(window,context,"save_translation_revision",manual),reused);
    assert_eq!(reused["revision"]["originKind"],"manual");
    assert_eq!(reused["revision"]["reuseOrigin"],staged["reuseOrigin"]);
    assert_eq!(translation_history(window,context,row)["rows"].as_array().unwrap().len(),history["rows"].as_array().unwrap().len()+1);
    let current = target(window,context,row);
    assert_eq!(current["translationText"],"新");
    assert!(current["currentDecision"].is_null() && current["currentCheck"].is_null(),"TM reuse never imports approval or QA");
    let plan = ipc(window,context,"prepare_work_plan",prepare.clone());
    assert!(plan["preview"]["items"][0]["terms"].as_array().unwrap().iter().any(|entry| entry["revisionId"]==term["revisionId"] && entry["target"]=="新"));
    assert_eq!(plan["preview"]["items"][0]["contextResources"],fresh["preview"]["items"][0]["contextResources"]);

    call(window,"close_project",json!({"sessionToken":context["sessionToken"]})).unwrap();
    let reopened = call(window,"open_project",json!({"locator":project_path})).unwrap();
    let context = json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]});
    for resource in &saved {
        assert_eq!(ipc(window,&context,"read_context_resource_current",json!({"contextId":resource["contextId"]})),*resource);
    }
    assert_eq!(ipc(window,&context,"read_term_current",json!({"termId":term["termId"]})),term);
    assert_eq!(ipc(window,&context,"read_term_history",json!({"termId":term["termId"],"offset":0,"limit":50})).as_array().unwrap().len(),2);
    assert_eq!(ipc(window,&context,"read_translation_memory_entry",donor_request),donor);
    assert_eq!(ipc(window,&context,"read_translation_memory_entry",json!({"unitId":row["unitId"],"locale":LOCALE,"revisionId":reused["revision"]["revisionId"]}))["revision"],reused["revision"]);
    assert_eq!(review_history(window,&context,row),review_history_before);
    assert_eq!(target(window,&context,row),current);
    assert_eq!(ipc(window,&context,"prepare_work_plan",prepare)["preview"]["items"],plan["preview"]["items"]);
    eprintln!("Scoped character/style/background, terminology and TM retain their exact history and consumer basis after source disable and project reopen; no model was called.");
    context
}
