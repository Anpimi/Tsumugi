//! Installed WebVTT worker facts through source checking, adoption and read IPC.
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
    let original =
        format!("WEBVTT\n\nCueA\n{first_time}\nCaptured 👩🏽‍💻\n\nCueB\n{second_time}\nNext café\n\n");
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
    assert_eq!(first_page["totalEntries"], 2);
    assert_eq!(first_page["nextAfter"], Value::Null);
    let first_neighbor = &first_page["entries"][1]["value"];
    assert_eq!(first_page["entries"][1]["kind"], "neighbor");
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
    let second_neighbor = &second_page["entries"][1]["value"];
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
    assert_eq!(
        call(&window, "read_source_context", reopened_request).unwrap(),
        next_page
    );
    state.plugins.close();
    drop(state);
    drop(app);
}
