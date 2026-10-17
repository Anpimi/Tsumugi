//! Installed domain worker evidence through source checking, adoption and read IPC.
use super::*;
use crate::commands::execution::test_fixtures::{
    OwnedDirectory, approved_runtime, provision_packages, selected_package,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_plugin_host::RuntimeApproval;

type Window = tauri::WebviewWindow<tauri::test::MockRuntime>;

fn call(window: &Window, command: &str, request: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({ "request": request })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

fn scoped(context: &Value, fields: Value) -> Value {
    let mut request = context.clone();
    request
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    request
}

fn consent(context: &Value, review: &Value) -> Value {
    scoped(
        context,
        json!({
            "attemptId": review["attemptId"],
            "inputDigest": review["inputDigest"],
            "grantId": ExecutionId::new(),
            "unsandboxedExecution": true,
            "expiresAtMs": (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
                + 600_000).to_string()
        }),
    )
}

fn completed_result(window: &Window, context: &Value, attempt: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = call(
            window,
            "read_execution_attempt",
            scoped(
                context,
                json!({ "attemptId": attempt, "offset": 0, "limit": 100 }),
            ),
        )
        .unwrap();
        match detail["items"][0]["status"]["execution"].as_str() {
            Some("succeeded") => return detail["items"][0]["resultId"].clone(),
            Some("queued" | "dispatched") => {}
            _ => panic!("installed source worker did not succeed: {detail}"),
        }
        assert!(
            Instant::now() < deadline,
            "installed source worker deadline: {detail}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The test owns the directory handle; the product has no path-grant IPC.
fn checked_proposal(
    app: &tauri::App<tauri::test::MockRuntime>,
    window: &Window,
    context: &Value,
    source_choice: &PluginSourceRequest,
    source_directory: &Path,
) -> (Value, Value, Value) {
    let selection = ExecutionId::new();
    let selected = source_directory.to_path_buf();
    let choice = source_choice.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let host = sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0;
        host.source.selection = Some((
            selection,
            Arc::new(capture::Selection::authorize(selected).unwrap()),
        ));
        host.source.plugin.choice = Some((selection, choice));
    });
    let preflight = call(
        window,
        "preflight_plugin_source",
        scoped(
            context,
            json!({
                "selectionId": selection,
                "sourceLanguage": "en-US",
                "attemptId": ExecutionId::new()
            }),
        ),
    )
    .unwrap();
    let started = call(window, "start_plugin_source", consent(context, &preflight)).unwrap();
    let result = completed_result(window, context, &started);
    let preview = call(
        window,
        "read_source_preview",
        scoped(
            context,
            json!({ "attemptId": started, "resultId": result, "after": 0, "limit": 10 }),
        ),
    )
    .unwrap();
    let check_review = call(
        window,
        "prepare_source_check",
        scoped(
            context,
            json!({
                "sourceAttemptId": started,
                "sourceResultId": result,
                "attemptId": ExecutionId::new(),
                "source": source_choice
            }),
        ),
    )
    .unwrap();
    let checked = call(
        window,
        "start_source_check",
        consent(context, &check_review),
    )
    .unwrap();
    let checked_result = completed_result(window, context, &checked);
    call(
        window,
        "finish_source_check",
        scoped(
            context,
            json!({ "attemptId": checked, "resultId": checked_result }),
        ),
    )
    .unwrap();
    (started, result, preview)
}

fn adopt(window: &Window, context: &Value, attempt: &Value, result: &Value, confirmation: Value) {
    let action_id = ExecutionId::new();
    call(
        window,
        "prepare_source_adoption",
        scoped(
            context,
            json!({
                "attemptId": attempt,
                "resultId": result,
                "actionId": action_id,
                "confirmation": confirmation
            }),
        ),
    )
    .unwrap();
    call(
        window,
        "adopt_execution",
        scoped(context, json!({ "actionId": action_id })),
    )
    .unwrap();
}

fn content(window: &Window, context: &Value) -> (Value, Value) {
    let scope = call(window, "read_content_scope", context.clone()).unwrap();
    let page = call(
        window,
        "read_source_content",
        scoped(
            context,
            json!({ "snapshotId": scope["currentSnapshot"], "after": 0, "limit": 10 }),
        ),
    )
    .unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
    (scope, page)
}

fn context_request(context: &Value, scope: &Value, row: &Value) -> Value {
    scoped(
        context,
        json!({
            "sourceSnapshotId": scope["currentSnapshot"],
            "unitId": row["unitId"],
            "sourceRevisionId": row["sourceRevisionId"],
            "locale": "zh-CN",
            "after": 0,
            "limit": 10
        }),
    )
}

fn block_request(context: &Value, page: &Value, descriptor: &Value) -> Value {
    scoped(
        context,
        json!({
            "basis": {
                "scope": page["scope"], "contentRevision": page["contentRevision"],
                "sourceAttemptId": page["sourceAttemptId"], "sourceResultId": page["sourceResultId"],
                "sourceResultDigest": page["sourceResultDigest"], "sourceLocale": page["sourceLocale"],
                "localUnitId": page["localUnitId"]
            },
            "descriptor": descriptor
        }),
    )
}

fn neighbor(page: &Value) -> &Value {
    &page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "neighbor")
        .unwrap()["value"]
}

fn assert_time_fact(page: &Value, source: &str, time: &str, artifact_id: &Value) {
    let blocks: Vec<_> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "block")
        .collect();
    assert_eq!(blocks.len(), 1);
    let block = &blocks[0]["value"];
    assert_eq!(block["schema"]["id"], "tsumugi.source-context-facts");
    assert_eq!(block["target"]["kind"], "occurrence");
    assert_eq!(block["handling"], "required");
    assert_eq!(block["facts"]["facts"].as_array().unwrap().len(), 1);
    let fact = &block["facts"]["facts"][0];
    assert_eq!(fact["id"], "time");
    assert_eq!(fact["kind"], "time");
    assert_eq!(fact["text"], time);
    assert_eq!(fact["origin"]["kind"], "extracted");
    assert_eq!(fact["origin"]["sources"].as_array().unwrap().len(), 1);
    let reference = &fact["origin"]["sources"][0];
    let start = source.find(time).unwrap();
    assert_eq!(reference["artifactId"], *artifact_id);
    assert_eq!(reference["range"]["encoding"], "utf8-byte");
    assert_eq!(reference["range"]["start"], json!(start));
    assert_eq!(reference["range"]["end"], json!(start + time.len()));
    assert_eq!(page["observations"]["knownFacts"], 1);
    assert_eq!(page["observations"]["unknownRequiredBlocks"], 0);
}

#[test]
fn installed_webvtt_context_keeps_time_provenance_neighbors_and_rejects_stale_source() {
    let temporary = OwnedDirectory(tempfile::tempdir().unwrap());
    let root = temporary.0.path();
    let (package, approval) = selected_package(
        "TSUMUGI_TEST_PLUGIN_PACKAGE",
        "TSUMUGI_TEST_PLUGIN_DIGEST",
        "webvtt",
    );
    let runtime = approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let environment_digest = runtime_approval.environment.digest().unwrap();
    provision_packages(
        root,
        &[(package, approval.clone())],
        &runtime,
        &runtime_approval,
    );
    drop(runtime);

    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    state.plugins.configure(root.join("application")).unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({
            "destination": root.join("project"),
            "displayName": "Installed caption context",
            "sourceLocale": "en-US",
            "targetLocales": ["zh-CN"]
        }),
    )
    .unwrap();
    let context = json!({
        "sessionToken": project["sessionToken"],
        "projectId": project["metadata"]["projectId"]
    });
    let source_choice = PluginSourceRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: approval.plugin.clone(),
            package_digest: approval.package_digest.clone(),
        },
        resource_id: "source-profile".into(),
        environment_digest,
    };
    let source_directory = root.join("captions");
    std::fs::create_dir(&source_directory).unwrap();
    let first_time = "00:00:01.000 --> 00:00:02.000";
    let second_time = "00:00:03.000 --> 00:00:04.000";
    // The official 128 KiB source profile can legally preserve a long REGION
    // name. Repetition and JSON escaping make the cue basis exceed a read page.
    let region_id = "\\\"".repeat(20_000);
    let first_settings = format!("region:{region_id} align:start");
    let original = format!(
        "WEBVTT\n\nREGION\nid:{region_id}\n\nCueA\n{first_time} {first_settings}\nCaptured 👩🏽‍💻\n\nCueB\n{second_time}\nNext café\n\n"
    );
    assert!(original.len() <= 128 * 1024);
    std::fs::write(source_directory.join("source.vtt"), &original).unwrap();

    let (first_attempt, first_result, first_preview) =
        checked_proposal(&app, &window, &context, &source_choice, &source_directory);
    assert_eq!(first_preview["rows"].as_array().unwrap().len(), 2);
    adopt(
        &window,
        &context,
        &first_attempt,
        &first_result,
        first_preview["confirmation"].clone(),
    );
    let (first_scope, first_content) = content(&window, &context);
    let rows = first_content["rows"].as_array().unwrap();
    let artifact_id = &first_content["coverage"][0]["artifactId"];
    let first_request = context_request(&context, &first_scope, &rows[0]);
    let first_page = call(&window, "read_source_context", first_request.clone()).unwrap();
    assert_eq!(
        first_page["scope"]["sourceSnapshotId"],
        first_scope["currentSnapshot"]
    );
    assert_eq!(first_page["scope"]["unitId"], rows[0]["unitId"]);
    assert_eq!(
        first_page["scope"]["sourceRevisionId"],
        rows[0]["sourceRevisionId"]
    );
    assert_eq!(first_page["contentRevision"], first_scope["revision"]);
    assert_eq!(first_page["sourceAttemptId"], first_attempt);
    assert_eq!(first_page["sourceResultId"], first_result);
    assert_eq!(
        first_page["sourceResultDigest"],
        first_preview["confirmation"]["resultDigest"]
    );
    assert_eq!(first_page["localUnitId"], "cue-0");
    assert_eq!(first_page["occurrenceCount"], 1);
    assert_time_fact(&first_page, &original, first_time, artifact_id);
    assert_eq!(first_page["totalEntries"], 4);
    assert_eq!(first_page["nextAfter"], Value::Null);
    let first_neighbor = neighbor(&first_page);
    assert_eq!(first_neighbor["unitId"], rows[1]["unitId"]);
    assert_eq!(
        first_neighbor["sourceRevisionId"],
        rows[1]["sourceRevisionId"]
    );
    assert_eq!(first_neighbor["text"], "Next café");
    assert_eq!(
        first_neighbor["adjacentTo"][0]["occurrenceId"],
        rows[0]["occurrenceId"]
    );
    assert_eq!(first_neighbor["adjacentTo"][0]["direction"], "after");

    let descriptor = first_page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["kind"] == "stored-block" && entry["value"]["schema"]["id"] == "webvtt.cue-basis"
        })
        .unwrap()["value"]
        .clone();
    assert!(
        descriptor["payloadBytes"].as_u64().unwrap()
            > tsumugi_core::MAX_SOURCE_CONTEXT_PAGE_BYTES as u64
    );
    assert!(
        serde_json::to_vec(&first_page).unwrap().len()
            <= tsumugi_core::MAX_SOURCE_CONTEXT_PAGE_BYTES
    );
    let detail_request = block_request(&context, &first_page, &descriptor);
    let database = root.join("project/project.sqlite3");
    let bytes_before_read = std::fs::read(&database).unwrap();
    let detail = call(&window, "read_source_context_block", detail_request.clone()).unwrap();
    assert_eq!(detail["basis"], detail_request["basis"]);
    assert_eq!(detail["descriptor"], descriptor);
    let payload = detail["payloadUtf8"].as_str().unwrap();
    assert_eq!(
        payload.len() as u64,
        descriptor["payloadBytes"].as_u64().unwrap()
    );
    let producer = call(
        &window,
        "read_execution_output",
        scoped(
            &context,
            json!({"attemptId":first_attempt,"resultId":first_result}),
        ),
    )
    .unwrap();
    let block_index = descriptor["blockIndex"].as_u64().unwrap() as usize;
    let producer: ResultEnvelope = serde_json::from_value(producer).unwrap();
    let tsumugi_plugin_sdk::InvocationOutcome::Succeeded { output } =
        producer.plugin.unwrap().result.outcome
    else {
        panic!("expected the installed extractor's successful SDK result");
    };
    let captured_exchange =
        tsumugi_plugin_sdk::parse_content_exchange(output.utf8.as_bytes()).unwrap();
    assert_eq!(
        captured_exchange.domain_blocks[block_index]
            .payload_utf8
            .as_bytes(),
        payload.as_bytes()
    );
    let interpreted_for_assertions: Value = serde_json::from_str(payload).unwrap();
    assert_eq!(
        interpreted_for_assertions["timing"],
        format!("{first_time} {first_settings}")
    );
    assert_eq!(
        interpreted_for_assertions["settings"],
        json!([format!("region:{region_id}"), "align:start"])
    );
    for field in ["sessionToken", "projectId"] {
        let mut foreign = detail_request.clone();
        foreign[field] = if field == "sessionToken" {
            json!("wrong-session")
        } else {
            json!(ExecutionId::new())
        };
        assert_eq!(
            call(&window, "read_source_context_block", foreign).unwrap_err()["code"],
            "session-invalid"
        );
    }
    let mut foreign_basis = detail_request.clone();
    foreign_basis["basis"]["scope"]["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "read_source_context_block", foreign_basis).unwrap_err()["reason"],
        "source-context-scope"
    );
    let mut wrong_target = detail_request.clone();
    wrong_target["descriptor"]["target"] = json!({"kind":"snapshot"});
    assert_eq!(
        call(&window, "read_source_context_block", wrong_target).unwrap_err()["reason"],
        "source-context-block-descriptor"
    );
    assert_eq!(std::fs::read(&database).unwrap(), bytes_before_read);

    let second_request = context_request(&context, &first_scope, &rows[1]);
    let second_page = call(&window, "read_source_context", second_request).unwrap();
    assert_eq!(second_page["localUnitId"], "cue-1");
    assert_time_fact(&second_page, &original, second_time, artifact_id);
    assert!(
        original[..original.find(second_time).unwrap()]
            .chars()
            .count()
            < original.find(second_time).unwrap()
    );
    let second_neighbor = neighbor(&second_page);
    assert_eq!(second_neighbor["text"], "Captured 👩🏽‍💻");
    assert_eq!(
        second_neighbor["adjacentTo"][0]["occurrenceId"],
        rows[1]["occurrenceId"]
    );
    assert_eq!(second_neighbor["adjacentTo"][0]["direction"], "before");

    // A changed timing literal updates one semantic revision. The second cue
    // retains its identity and revision, despite both facts coming from a new
    // checked source result.
    let changed_time = "00:00:01.500 --> 00:00:02.500";
    let updated = original.replace(first_time, changed_time);
    std::fs::write(source_directory.join("source.vtt"), &updated).unwrap();
    let (next_attempt, next_result, _) =
        checked_proposal(&app, &window, &context, &source_choice, &source_directory);
    let comparison = call(
        &window,
        "read_source_comparison",
        scoped(
            &context,
            json!({
                "attemptId": next_attempt,
                "resultId": next_result,
                "base": first_scope["currentSnapshot"],
                "filter": "",
                "after": 0,
                "limit": 10
            }),
        ),
    )
    .unwrap();
    assert_eq!(comparison["changed"], 1);
    assert_eq!(comparison["unchanged"], 1);
    let changed = comparison["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["new"]["ordinal"].as_u64() == Some(0))
        .unwrap();
    assert_eq!(changed["kind"], "changed");
    assert_eq!(changed["old"]["unitId"], rows[0]["unitId"]);
    let mut confirmation = comparison["confirmation"].clone();
    confirmation["actor"] = json!("Caption reviewer");
    confirmation["lineage"] = json!([{
        "newOrdinal": 0,
        "oldOccurrenceId": changed["old"]["occurrenceId"],
        "decision": "continue",
        "reason": "Same explicit cue identity with updated timing"
    }]);
    adopt(&window, &context, &next_attempt, &next_result, confirmation);
    let stale = call(&window, "read_source_context", first_request).unwrap_err();
    assert_eq!(stale["reason"], "source-context-snapshot");
    assert_eq!(
        call(&window, "read_source_context_block", detail_request).unwrap_err()["reason"],
        "source-context-snapshot"
    );

    let (next_scope, next_content) = content(&window, &context);
    let next_rows = next_content["rows"].as_array().unwrap();
    assert_ne!(
        next_scope["currentSnapshot"],
        first_scope["currentSnapshot"]
    );
    assert_ne!(next_scope["revision"], first_scope["revision"]);
    assert_eq!(next_rows[0]["unitId"], rows[0]["unitId"]);
    assert_ne!(
        next_rows[0]["sourceRevisionId"],
        rows[0]["sourceRevisionId"]
    );
    assert_eq!(next_rows[1]["unitId"], rows[1]["unitId"]);
    assert_eq!(
        next_rows[1]["sourceRevisionId"],
        rows[1]["sourceRevisionId"]
    );
    let next_request = context_request(&context, &next_scope, &next_rows[0]);
    let next_page = call(&window, "read_source_context", next_request.clone()).unwrap();
    assert_eq!(next_page["sourceAttemptId"], next_attempt);
    assert_eq!(next_page["sourceResultId"], next_result);
    assert_eq!(next_page["contentRevision"], next_scope["revision"]);
    assert_time_fact(
        &next_page,
        &updated,
        changed_time,
        &next_content["coverage"][0]["artifactId"],
    );
    let next_descriptor = next_page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["kind"] == "stored-block" && entry["value"]["schema"]["id"] == "webvtt.cue-basis"
        })
        .unwrap()["value"]
        .clone();
    let mut next_detail_request = block_request(&context, &next_page, &next_descriptor);
    let next_detail = call(
        &window,
        "read_source_context_block",
        next_detail_request.clone(),
    )
    .unwrap();

    call(
        &window,
        "close_project",
        json!({ "sessionToken": context["sessionToken"] }),
    )
    .unwrap();
    let reopened = call(
        &window,
        "open_project",
        json!({ "locator": root.join("project") }),
    )
    .unwrap();
    let reopened_context = json!({
        "sessionToken": reopened["sessionToken"],
        "projectId": context["projectId"]
    });
    let reopened_scope = call(&window, "read_content_scope", reopened_context.clone()).unwrap();
    assert_eq!(reopened_scope, next_scope);
    let mut reopened_request = next_request;
    reopened_request["sessionToken"] = reopened_context["sessionToken"].clone();
    next_detail_request["sessionToken"] = reopened_context["sessionToken"].clone();
    assert_eq!(
        call(&window, "read_source_context_block", next_detail_request).unwrap(),
        next_detail
    );
    assert_eq!(
        call(&window, "read_source_context", reopened_request).unwrap(),
        next_page
    );
    state.plugins.close();
    drop(state);
    drop(app);
}

#[test]
fn installed_smapi_source_failure_details_survive_saved_output_read_and_reopen() {
    let temporary = OwnedDirectory(tempfile::tempdir().unwrap());
    let root = temporary.0.path();
    let (package, approval) = selected_package(
        "TSUMUGI_TEST_SMAPI_PACKAGE",
        "TSUMUGI_TEST_SMAPI_DIGEST",
        "stardew-smapi",
    );
    let runtime = approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let environment_digest = runtime_approval.environment.digest().unwrap();
    provision_packages(
        root,
        &[(package, approval.clone())],
        &runtime,
        &runtime_approval,
    );
    drop(runtime);
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    state.plugins.configure(root.join("application")).unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({
            "destination": root.join("project"), "displayName": "Saved source failure",
            "sourceLocale": "en-US", "targetLocales": ["zh-CN"]
        }),
    )
    .unwrap();
    let context = json!({
        "sessionToken": project["sessionToken"],
        "projectId": project["metadata"]["projectId"]
    });
    let source_choice = PluginSourceRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: approval.plugin.clone(),
            package_digest: approval.package_digest.clone(),
        },
        resource_id: "source-profile".into(),
        environment_digest,
    };
    let source_directory = root.join("mod");
    std::fs::create_dir_all(source_directory.join("i18n")).unwrap();
    // The manifest is valid JSON but deliberately lacks the profile's required
    // exactly-one entry declaration. No mod code is supplied or executed.
    let manifest = r#"{"UniqueID":"Example.Failure","Name":"Moon 👩🏽‍💻","Version":"1.0.0"}"#;
    let source_text = r#"{"greeting":"Hello {{player}}"}"#;
    std::fs::write(source_directory.join("manifest.json"), manifest).unwrap();
    std::fs::write(source_directory.join("i18n/default.json"), source_text).unwrap();
    let selection = ExecutionId::new();
    let selected = source_directory.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let host = sessions
            .active
            .as_mut()
            .unwrap()
            .execution_parts()
            .unwrap()
            .0;
        host.source.selection = Some((
            selection,
            Arc::new(capture::Selection::authorize(selected).unwrap()),
        ));
        host.source.plugin.choice = Some((selection, source_choice));
    });
    let preflight = call(
        &window,
        "preflight_plugin_source",
        scoped(
            &context,
            json!({
                "selectionId": selection, "sourceLanguage": "en-US", "attemptId": ExecutionId::new()
            }),
        ),
    )
    .unwrap();
    let attempt = call(
        &window,
        "start_plugin_source",
        consent(&context, &preflight),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let failed = loop {
        let detail = call(
            &window,
            "read_execution_attempt",
            scoped(
                &context,
                json!({
                    "attemptId": attempt, "offset": 0, "limit": 100
                }),
            ),
        )
        .unwrap();
        let item = &detail["items"][0];
        match item["status"]["execution"].as_str() {
            Some("failed") => break item.clone(),
            Some("queued" | "dispatched") => {}
            _ => panic!("expected the installed extractor's failure: {detail}"),
        }
        assert!(
            Instant::now() < deadline,
            "installed failure did not finish: {detail}"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(failed["status"]["diagnostic"], "plugin-failed");
    assert_eq!(failed["status"]["retrySafe"], false);
    let selected = json!({"attemptId": attempt, "resultId": failed["resultId"]});
    let output = call(
        &window,
        "read_execution_output",
        scoped(&context, selected.clone()),
    )
    .unwrap();
    let raw = output["plugin"]["result"]["outcome"]["error"]["utf8"]
        .as_str()
        .unwrap();
    let original = tsumugi_plugin_sdk::parse_source_extraction_error(raw.as_bytes()).unwrap();
    assert_eq!(
        output["sourceFailure"],
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(output["sourceFailure"]["code"], "invalid-source");
    assert_eq!(
        output["sourceFailure"]["detail"],
        "Expected exactly one EntryDll or ContentPackFor.UniqueID."
    );
    assert!(output["sourceFailure"]["artifactId"].is_string());
    assert_eq!(output["outcome"], "failed");
    assert!(output["output"].is_null());
    assert_eq!(
        output["diagnostic"],
        json!({"code":"plugin-failed","retrySafe":false})
    );
    let mut foreign = scoped(&context, selected.clone());
    foreign["projectId"] = json!(ExecutionId::new());
    assert!(call(&window, "read_execution_output", foreign).is_err());
    let scope = call(&window, "read_content_scope", context.clone()).unwrap();
    assert!(scope["currentSnapshot"].is_null());
    call(
        &window,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &window,
        "open_project",
        json!({"locator":root.join("project")}),
    )
    .unwrap();
    let reopened_context =
        json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]});
    assert_eq!(
        call(
            &window,
            "read_execution_output",
            scoped(&reopened_context, selected)
        )
        .unwrap(),
        output
    );
    assert_eq!(
        std::fs::read_to_string(source_directory.join("manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(
        std::fs::read_to_string(source_directory.join("i18n/default.json")).unwrap(),
        source_text
    );
    let tasks = call(
        &window,
        "list_execution_tasks",
        scoped(&reopened_context, json!({"after":"0","limit":50})),
    )
    .unwrap();
    assert_eq!(tasks.as_array().unwrap().len(), 1);
    state.plugins.close();
    drop(state);
    drop(app);
}

fn assert_manifest_name_fact(page: &Value, manifest: &str, name: &str, artifact_id: &Value) {
    let blocks: Vec<_> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "block")
        .collect();
    assert_eq!(blocks.len(), 1);
    let block = &blocks[0]["value"];
    assert_eq!(block["schema"]["id"], "tsumugi.source-context-facts");
    assert_eq!(block["target"]["kind"], "snapshot");
    assert_eq!(block["handling"], "required");
    assert_eq!(block["inRevisionBasis"], false);
    assert_eq!(block["facts"]["facts"].as_array().unwrap().len(), 1);
    let fact = &block["facts"]["facts"][0];
    assert_eq!(fact["id"], "manifest-name");
    assert_eq!(fact["kind"], "note");
    assert_eq!(fact["text"], name);
    assert_eq!(fact["origin"]["kind"], "extracted");
    assert_eq!(fact["origin"]["sources"].as_array().unwrap().len(), 1);
    let reference = &fact["origin"]["sources"][0];
    let quoted = format!("\"{name}\"");
    let start = manifest.find(&quoted).unwrap();
    assert_eq!(reference["artifactId"], *artifact_id);
    assert_eq!(reference["range"]["encoding"], "utf8-byte");
    assert_eq!(reference["range"]["start"], json!(start));
    assert_eq!(reference["range"]["end"], json!(start + quoted.len()));
    assert_eq!(&manifest[start..start + quoted.len()], quoted);
    assert_eq!(page["observations"]["knownFacts"], 1);
    assert_eq!(page["observations"]["unknownRequiredBlocks"], 0);
}

#[test]
fn installed_smapi_manifest_name_context_tracks_snapshot_basis_and_reopen() {
    let temporary = OwnedDirectory(tempfile::tempdir().unwrap());
    let root = temporary.0.path();
    let (package, approval) = selected_package(
        "TSUMUGI_TEST_SMAPI_PACKAGE",
        "TSUMUGI_TEST_SMAPI_DIGEST",
        "stardew-smapi",
    );
    let runtime = approved_runtime();
    let runtime_approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let environment_digest = runtime_approval.environment.digest().unwrap();
    provision_packages(
        root,
        &[(package, approval.clone())],
        &runtime,
        &runtime_approval,
    );
    drop(runtime);

    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<AppState>();
    state.plugins.configure(root.join("application")).unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({
            "destination": root.join("project"),
            "displayName": "Installed manifest context",
            "sourceLocale": "en-US",
            "targetLocales": ["zh-CN"]
        }),
    )
    .unwrap();
    let context = json!({
        "sessionToken": project["sessionToken"],
        "projectId": project["metadata"]["projectId"]
    });
    let source_choice = PluginSourceRequest {
        package: crate::commands::plugins::PluginPackageRequest {
            plugin: approval.plugin.clone(),
            package_digest: approval.package_digest.clone(),
        },
        resource_id: "source-profile".into(),
        environment_digest,
    };
    let source_directory = root.join("mod");
    std::fs::create_dir_all(source_directory.join("i18n")).unwrap();
    let first_name = "Moon 👩🏽‍💻";
    let manifest = format!(
        "{{\"UniqueID\":\"Example.Context\",\"Description\":\"雪\",\"Name\":\"{first_name}\",\"Version\":\"1.0.0\",\"EntryDll\":\"Context.dll\"}}"
    );
    let source_text = "{\"greeting\":\"Hello 👩🏽‍💻\",\"farewell\":\"Next café\"}";
    std::fs::write(source_directory.join("manifest.json"), &manifest).unwrap();
    std::fs::write(source_directory.join("i18n/default.json"), source_text).unwrap();

    let (first_attempt, first_result, first_preview) =
        checked_proposal(&app, &window, &context, &source_choice, &source_directory);
    assert_eq!(first_preview["rows"].as_array().unwrap().len(), 2);
    adopt(
        &window,
        &context,
        &first_attempt,
        &first_result,
        first_preview["confirmation"].clone(),
    );
    let (first_scope, first_content) = content(&window, &context);
    let rows = first_content["rows"].as_array().unwrap();
    assert_eq!(rows[0]["occurrence"]["text"], "Hello 👩🏽‍💻");
    assert_eq!(rows[1]["occurrence"]["text"], "Next café");
    let manifest_coverage = first_content["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["logicalPath"] == "manifest.json")
        .unwrap();
    let source_coverage = first_content["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["logicalPath"] == "i18n/default.json")
        .unwrap();
    assert_eq!(manifest_coverage["role"], "companion");
    assert_eq!(source_coverage["role"], "source");
    let first_request = context_request(&context, &first_scope, &rows[0]);
    let first_page = call(&window, "read_source_context", first_request.clone()).unwrap();
    assert_eq!(
        first_page["scope"]["sourceSnapshotId"],
        first_scope["currentSnapshot"]
    );
    assert_eq!(first_page["scope"]["unitId"], rows[0]["unitId"]);
    assert_eq!(
        first_page["scope"]["sourceRevisionId"],
        rows[0]["sourceRevisionId"]
    );
    assert_eq!(first_page["contentRevision"], first_scope["revision"]);
    assert_eq!(first_page["sourceAttemptId"], first_attempt);
    assert_eq!(first_page["sourceResultId"], first_result);
    assert_eq!(
        first_page["sourceResultDigest"],
        first_preview["confirmation"]["resultDigest"]
    );
    assert_eq!(first_page["localUnitId"], "entry-0");
    assert_eq!(first_page["occurrenceCount"], 1);
    assert_manifest_name_fact(
        &first_page,
        &manifest,
        first_name,
        &manifest_coverage["artifactId"],
    );
    assert!(
        manifest[..manifest.find(&format!("\"{first_name}\"")).unwrap()]
            .chars()
            .count()
            < manifest.find(&format!("\"{first_name}\"")).unwrap()
    );
    assert_eq!(first_page["totalEntries"], 4);
    assert_eq!(first_page["nextAfter"], Value::Null);
    let first_neighbor = neighbor(&first_page);
    assert_eq!(first_neighbor["unitId"], rows[1]["unitId"]);
    assert_eq!(
        first_neighbor["sourceRevisionId"],
        rows[1]["sourceRevisionId"]
    );
    assert_eq!(first_neighbor["text"], "Next café");
    assert_eq!(
        first_neighbor["adjacentTo"][0]["occurrenceId"],
        rows[0]["occurrenceId"]
    );
    assert_eq!(first_neighbor["adjacentTo"][0]["direction"], "after");
    let neighbor_source = &first_neighbor["occurrence"]["source"];
    let neighbor_literal = "\"Next café\"";
    let neighbor_start = source_text.find(neighbor_literal).unwrap();
    assert_eq!(neighbor_source["artifactId"], source_coverage["artifactId"]);
    assert_eq!(neighbor_source["range"]["encoding"], "utf8-byte");
    assert_eq!(neighbor_source["range"]["start"], json!(neighbor_start));
    assert_eq!(
        neighbor_source["range"]["end"],
        json!(neighbor_start + neighbor_literal.len())
    );

    let second_request = context_request(&context, &first_scope, &rows[1]);
    let second_page = call(&window, "read_source_context", second_request).unwrap();
    assert_eq!(second_page["localUnitId"], "entry-1");
    assert_manifest_name_fact(
        &second_page,
        &manifest,
        first_name,
        &manifest_coverage["artifactId"],
    );
    let second_neighbor = neighbor(&second_page);
    assert_eq!(second_neighbor["text"], "Hello 👩🏽‍💻");
    assert_eq!(
        second_neighbor["adjacentTo"][0]["occurrenceId"],
        rows[1]["occurrenceId"]
    );
    assert_eq!(second_neighbor["adjacentTo"][0]["direction"], "before");

    // The selected revision basis is the decoded snapshot Name, so a change
    // affects both units. Explicit lineage retains their reviewed identities.
    let next_name = "Forest 👩🏽‍💻";
    let updated = manifest.replace(&format!("\"{first_name}\""), &format!("\"{next_name}\""));
    std::fs::write(source_directory.join("manifest.json"), &updated).unwrap();
    let (next_attempt, next_result, _) =
        checked_proposal(&app, &window, &context, &source_choice, &source_directory);
    let comparison = call(
        &window,
        "read_source_comparison",
        scoped(
            &context,
            json!({
                "attemptId": next_attempt,
                "resultId": next_result,
                "base": first_scope["currentSnapshot"],
                "filter": "",
                "after": 0,
                "limit": 10
            }),
        ),
    )
    .unwrap();
    assert_eq!(comparison["changed"], 2);
    assert_eq!(comparison["unchanged"], 0);
    let changes = comparison["rows"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    let lineage: Vec<Value> = changes
        .iter()
        .map(|change| {
            assert_eq!(change["kind"], "changed");
            json!({
                "newOrdinal": change["new"]["ordinal"],
                "oldOccurrenceId": change["old"]["occurrenceId"],
                "decision": "continue",
                "reason": "Same native key with updated manifest context"
            })
        })
        .collect();
    let mut confirmation = comparison["confirmation"].clone();
    confirmation["actor"] = json!("Manifest reviewer");
    confirmation["lineage"] = json!(lineage);
    adopt(&window, &context, &next_attempt, &next_result, confirmation);
    let stale = call(&window, "read_source_context", first_request).unwrap_err();
    assert_eq!(stale["reason"], "source-context-snapshot");

    let (next_scope, next_content) = content(&window, &context);
    let next_rows = next_content["rows"].as_array().unwrap();
    assert_ne!(
        next_scope["currentSnapshot"],
        first_scope["currentSnapshot"]
    );
    assert_ne!(next_scope["revision"], first_scope["revision"]);
    for index in 0..2 {
        assert_eq!(next_rows[index]["unitId"], rows[index]["unitId"]);
        assert_ne!(
            next_rows[index]["sourceRevisionId"],
            rows[index]["sourceRevisionId"]
        );
        assert_eq!(
            next_rows[index]["occurrence"]["text"],
            rows[index]["occurrence"]["text"]
        );
    }
    let next_coverage = next_content["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["logicalPath"] == "manifest.json")
        .unwrap();
    let next_request = context_request(&context, &next_scope, &next_rows[0]);
    let next_page = call(&window, "read_source_context", next_request.clone()).unwrap();
    assert_eq!(next_page["sourceAttemptId"], next_attempt);
    assert_eq!(next_page["sourceResultId"], next_result);
    assert_eq!(next_page["contentRevision"], next_scope["revision"]);
    assert_manifest_name_fact(
        &next_page,
        &updated,
        next_name,
        &next_coverage["artifactId"],
    );
    assert_eq!(neighbor(&next_page)["text"], "Next café");
    assert_eq!(
        neighbor(&next_page)["sourceRevisionId"],
        next_rows[1]["sourceRevisionId"]
    );

    call(
        &window,
        "close_project",
        json!({ "sessionToken": context["sessionToken"] }),
    )
    .unwrap();
    let reopened = call(
        &window,
        "open_project",
        json!({ "locator": root.join("project") }),
    )
    .unwrap();
    let reopened_context = json!({
        "sessionToken": reopened["sessionToken"],
        "projectId": context["projectId"]
    });
    assert_eq!(
        call(&window, "read_content_scope", reopened_context.clone()).unwrap(),
        next_scope
    );
    let mut reopened_request = next_request;
    reopened_request["sessionToken"] = reopened_context["sessionToken"].clone();
    assert_eq!(
        call(&window, "read_source_context", reopened_request).unwrap(),
        next_page
    );
    state.plugins.close();
    drop(state);
    drop(app);
}
