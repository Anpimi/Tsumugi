use super::*;
#[test]
fn source_wire_fixture_matches_rust_types() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/sourceCommands.contract.json"
    ))
    .unwrap();
    fn round_trip<T: serde::de::DeserializeOwned + Serialize>(value: &serde_json::Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round_trip::<SessionRequest>(&fixture["session"]);
    round_trip::<SourceSelection>(&fixture["selection"]);
    round_trip::<CaptureRequest>(&fixture["capture"]);
    round_trip::<StartRequest>(&fixture["start"]);
    round_trip::<PreviewRequest>(&fixture["preview"]);
    round_trip::<ContentRequest>(&fixture["content"]);
    round_trip::<SourceContextReadRequest>(&fixture["sourceContextRequest"]);
    round_trip::<tsumugi_core::SourceContextPage>(&fixture["sourceContext"]);
    round_trip::<SourceAdoptRequest>(&fixture["prepare"]);
    let action_read = json!({
        "adoption": fixture["prepare"],
        "unitId": ExecutionId::new(),
    });
    round_trip::<SourceAdoptionActionRequest>(&action_read);
    let mut unexpected = action_read;
    unexpected["sessionToken"] = json!("not-an-outer-session");
    assert!(serde_json::from_value::<SourceAdoptionActionRequest>(unexpected).is_err());
    round_trip::<ContentPage>(&fixture["page"]);
    round_trip::<Preflight>(&fixture["preflight"]);
    round_trip::<content::IntegrationDescriptor>(&fixture["integration"]);
    assert_eq!(serde_json::to_value(content::integration_descriptor(true)).unwrap(), fixture["integration"]);
    round_trip::<HistoryRequest>(&fixture["historyRequest"]);
    round_trip::<ComparisonRequest>(&fixture["comparisonRequest"]);
    round_trip::<HistoryContentRequest>(&fixture["historyContent"]);
    round_trip::<LineageRequest>(&fixture["lineageRequest"]);
    round_trip::<ImpactRequest>(&fixture["impactRequest"]);
    round_trip::<content::SourceHistory>(&fixture["history"]);
    round_trip::<Vec<content::LineageEvidence>>(&fixture["lineage"]);
    round_trip::<SourceChangePage>(&fixture["comparison"]);
    round_trip::<content::SourceImpactPage>(&fixture["impact"]);
    round_trip::<Vec<content::SourceImpactSummary>>(&fixture["estimates"]);
    let mut rounded = fixture["history"].clone();
    rounded["snapshots"][0]["revision"] = serde_json::json!(9_007_199_254_740_993u64);
    assert!(serde_json::from_value::<content::SourceHistory>(rounded).is_err());
    let mut history = fixture["history"].clone();
    history["snapshots"][0]["revision"] = serde_json::json!("9223372036854775807");
    round_trip::<content::SourceHistory>(&history);
    history["snapshots"][0]["revision"] = serde_json::json!("9223372036854775808");
    assert!(serde_json::from_value::<content::SourceHistory>(history).is_err());
    let mut overflow = fixture["preview"].clone();
    overflow["after"] = serde_json::json!(4_294_967_296u64);
    assert!(serde_json::from_value::<PreviewRequest>(overflow).is_err());
    let mut invalid_range = fixture["page"].clone();
    invalid_range["rows"][0]["occurrence"]["keyByteRange"] = serde_json::json!([0, 1, 2]);
    assert!(serde_json::from_value::<ContentPage>(invalid_range).is_err());
    let mut unknown_kind = fixture["comparison"].clone();
    unknown_kind["rows"][0]["kind"] = serde_json::json!("future-kind");
    assert!(serde_json::from_value::<SourceChangePage>(unknown_kind).is_err());
    let mut unknown_status = fixture["impact"].clone();
    unknown_status["rows"][0]["status"] = serde_json::json!("future-status");
    assert!(serde_json::from_value::<content::SourceImpactPage>(unknown_status).is_err());
    let mut unknown = fixture["prepare"].clone();
    unknown["confirmation"]["requiredExtension"] = serde_json::json!("unknown/v1");
    assert!(serde_json::from_value::<SourceAdoptRequest>(unknown).is_err());
}
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

fn call(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":body})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|r| r.deserialize::<Value>().unwrap())
}

#[test]
fn source_context_ipc_requires_current_session_and_does_not_mutate_empty_project() {
    let directory = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({
            "destination":directory.path().join("project"), "displayName":"Source context reads",
            "sourceLocale":"en", "targetLocales":["zh-CN"]
        }),
    )
    .unwrap();
    let request = json!({"sessionToken":project["sessionToken"], "projectId":project["metadata"]["projectId"],
        "sourceSnapshotId":ExecutionId::new(), "unitId":ExecutionId::new(),
        "sourceRevisionId":ExecutionId::new(), "locale":"zh-CN", "after":0, "limit":4});
    let database = directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let missing = call(&window, "read_source_context", request.clone()).unwrap_err();
    assert_eq!(missing["reason"], "source-context-snapshot");
    for field in ["sessionToken", "projectId"] {
        let mut foreign = request.clone();
        foreign[field] = if field == "sessionToken" {
            json!("foreign-session")
        } else {
            json!(ExecutionId::new())
        };
        let error = call(&window, "read_source_context", foreign).unwrap_err();
        assert_eq!(error["code"], "session-invalid");
    }
    let mut authority = request.clone();
    authority["approved"] = json!(true);
    assert!(call(&window, "read_source_context", authority).is_err());
    let mut overflow = request;
    overflow["after"] = json!(4_294_967_296u64);
    assert!(call(&window, "read_source_context", overflow).is_err());
    assert_eq!(std::fs::read(database).unwrap(), before);
}

#[test]
fn candidate_decision_ipc_requires_current_session_matching_project_and_read_scope() {
    let directory = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &window,
        "create_project",
        json!({
            "destination":directory.path().join("project"), "displayName":"Candidate authorization",
            "sourceLocale":"en", "targetLocales":["zh-CN"]
        }),
    )
    .unwrap();
    let context = json!({"sessionToken":project["sessionToken"], "projectId":project["metadata"]["projectId"]});
    let request = json!({"sessionToken":context["sessionToken"], "projectId":context["projectId"],
        "decision":{"projectId":context["projectId"], "actionId":ExecutionId::new(), "unitId":ExecutionId::new(),
        "locale":"zh-CN", "revisionId":ExecutionId::new(), "sourceRevisionId":ExecutionId::new(),
        "expectedSelectionId":null, "expectedDecisionId":null, "disposition":"rejected",
        "actor":"Synthetic reviewer", "reason":"Does not fit this entry"}});
    let lookup = json!({"sessionToken":context["sessionToken"], "projectId":context["projectId"],
        "actionId":request["decision"]["actionId"], "unitId":request["decision"]["unitId"], "locale":"zh-CN"});
    let database = directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let status = call(&window, "execution_status", context.clone()).unwrap();

    // Authorized requests reach the real Core owner, which rejects missing
    // source/revision evidence rather than granting authority from the wire.
    assert_eq!(
        call(&window, "decide_translation_candidate", request.clone()).unwrap_err()["reason"],
        "translation-source"
    );
    assert_eq!(
        call(&window, "read_translation_candidate_action", lookup.clone()).unwrap_err()["reason"],
        "translation-project"
    );
    for (command, original) in [
        ("decide_translation_candidate", &request),
        ("read_translation_candidate_action", &lookup),
    ] {
        for field in ["sessionToken", "projectId"] {
            let mut foreign = original.clone();
            foreign[field] = if field == "sessionToken" {
                json!("inactive-session")
            } else {
                json!(ExecutionId::new())
            };
            assert_eq!(
                call(&window, command, foreign).unwrap_err()["code"],
                "session-invalid"
            );
        }
        let mut unknown = original.clone();
        unknown["approved"] = json!(true);
        assert!(call(&window, command, unknown).is_err());
    }
    let mut mismatched = request.clone();
    mismatched["decision"]["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "decide_translation_candidate", mismatched).unwrap_err()["reason"],
        "unauthorized-selection"
    );
    let mut nested_authority = request;
    nested_authority["decision"]["approved"] = json!(true);
    assert!(call(&window, "decide_translation_candidate", nested_authority).is_err());
    assert_eq!(call(&window, "execution_status", context).unwrap(), status);
    assert_eq!(std::fs::read(database).unwrap(), before);
}

#[test]
fn context_fact_ipc_checks_session_inner_scope_and_strict_actions_without_side_effects() {
    let directory = tempfile::tempdir().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(&window,"create_project",json!({
        "destination":directory.path().join("project"),"displayName":"Fact decision authorization",
        "sourceLocale":"en","targetLocales":["zh-CN"]
    })).unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let scope = json!({"projectId":context["projectId"],"sourceSnapshotId":ExecutionId::new(),
        "unitId":ExecutionId::new(),"sourceRevisionId":ExecutionId::new(),"locale":"zh-CN"});
    let write = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"decision":{
        "actionId":ExecutionId::new(),"basis":{"scope":scope,"sourceResultId":ExecutionId::new(),"sourceResultDigest":"a".repeat(64),
            "fact":{"blockIndex":0,"factIndex":0,"target":{"kind":"unit","id":"synthetic-entry"},
                "schema":{"id":"tsumugi.source-context-facts","schemaVersion":1,"behaviorVersion":1},"handling":"preserve","inRevisionBasis":true,
                "fact":{"id":"role","kind":"role","text":"Synthetic inference","origin":{"kind":"inferred","rationale":"Synthetic evidence",
                    "sources":[{"artifactId":"synthetic-source","range":{"encoding":"utf8-byte","start":0,"end":4}}]}}}},
        "expectedDecisionId":null,"disposition":{"kind":"reject-inference"},"actor":"Synthetic reviewer","reason":"Unconfirmed inference"
    }});
    let read = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"scope":scope,"facts":[{"blockIndex":0,"factIndex":0}]});
    let action = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":write["decision"]["actionId"]});
    let history = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"unitId":scope["unitId"],"locale":"zh-CN","offset":0,"limit":10});
    let database = directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let status = call(&window, "execution_status", context.clone()).unwrap();
    // These valid wire requests reach the existing Core owner; missing source
    // facts never become accepted decisions or another execution authority.
    assert_eq!(
        call(&window, "decide_context_fact", write.clone()).unwrap_err()["reason"],
        "source-context-snapshot"
    );
    assert_eq!(
        call(&window, "read_context_fact_decisions", read.clone()).unwrap_err()["reason"],
        "source-context-snapshot"
    );
    assert_eq!(
        call(&window, "read_context_fact_action", action.clone()).unwrap(),
        Value::Null
    );
    assert!(call(&window, "read_context_fact_history", history.clone()).is_err());
    for (command, original) in [
        ("decide_context_fact", &write),
        ("read_context_fact_decisions", &read),
        ("read_context_fact_action", &action),
        ("read_context_fact_history", &history),
    ] {
        for field in ["sessionToken", "projectId"] {
            let mut foreign = original.clone();
            foreign[field] = if field == "sessionToken" {
                json!("inactive-session")
            } else {
                json!(ExecutionId::new())
            };
            assert_eq!(
                call(&window, command, foreign).unwrap_err()["code"],
                "session-invalid"
            );
        }
        let mut unknown = original.clone();
        unknown["approved"] = json!(true);
        assert!(call(&window, command, unknown).is_err());
    }
    let mut inner = write.clone();
    inner["decision"]["basis"]["scope"]["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "decide_context_fact", inner).unwrap_err()["reason"],
        "context-fact-project"
    );
    let mut inner = read.clone();
    inner["scope"]["projectId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&window, "read_context_fact_decisions", inner).unwrap_err()["reason"],
        "context-fact-project"
    );
    let mut missing_positions = read.clone();
    missing_positions.as_object_mut().unwrap().remove("facts");
    assert!(call(&window, "read_context_fact_decisions", missing_positions).is_err());
    let mut nested = write;
    nested["decision"]["basis"]["approved"] = json!(true);
    assert!(call(&window, "decide_context_fact", nested).is_err());
    assert_eq!(call(&window, "execution_status", context).unwrap(), status);
    assert_eq!(std::fs::read(database).unwrap(), before);
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_execution_idle(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    context: &Value,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = call(webview, "execution_status", context.clone()).unwrap();
        if status["active"] == false {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "execution stayed active: {status}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn production_source_ipc_captures_previews_commits_and_reopens() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("mod");
    std::fs::create_dir_all(source.join("i18n")).unwrap();
    std::fs::write(
        source.join("manifest.json"),
        include_bytes!(
            "../../../../../../../crates/core/tests/fixtures/stardew-lookup/manifest.json"
        ),
    )
    .unwrap();
    std::fs::write(
        source.join("i18n/default.json"),
        include_bytes!(
            "../../../../../../../crates/core/tests/fixtures/stardew-lookup/i18n/default.json"
        ),
    )
    .unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(&view,"create_project",json!({"destination":temp.path().join("project"),"displayName":"Import fixture","sourceLocale":"en","targetLocales":["zh-CN"]})).unwrap();
    let context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    for command in ["read_source_integration", "read_webvtt_integration"] {
        let descriptor = call(&view, command, context.clone()).unwrap();
        assert_eq!(descriptor["available"], true, "{command}");
        assert!(descriptor["reason"].is_null());
    }
    let mut wrong = context.clone();
    wrong["projectId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_content_scope", wrong).is_err());
    let selection = ExecutionId::new();
    // The test grants a real native directory handle instead of opening a UI picker.
    // No path-grant IPC command is registered in either product configuration.
    {
        let state = app.state::<AppState>();
        let source = source.clone();
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
                Arc::new(capture::Selection::authorize(source.clone()).unwrap()),
            ));
        })
    }
    let mut capture = context.clone();
    capture["selectionId"] = json!(selection);
    capture["sourceLanguage"] = json!("en");
    let mut stale = capture.clone();
    stale["selectionId"] = json!(ExecutionId::new());
    assert!(call(&view, "preflight_source", stale).is_err());
    let mut language = capture.clone();
    language["sourceLanguage"] = json!("zh-CN");
    assert!(call(&view, "preflight_source", language).is_err());
    let mut arbitrary = capture.clone();
    arbitrary["path"] = json!(source);
    assert!(call(&view, "preflight_source", arbitrary).is_err());
    assert_eq!(
        call(&view, "preflight_source", capture.clone()).unwrap()["count"],
        532
    );
    assert_eq!(
        call(&view, "read_content_scope", context.clone()).unwrap()["revision"],
        "1"
    );
    assert_eq!(
        call(&view, "list_execution_tasks", {
            let mut r = context.clone();
            r["after"] = json!("0");
            r["limit"] = json!(50);
            r
        })
        .unwrap(),
        json!([])
    );
    let attempt = ExecutionId::new();
    capture["attemptId"] = json!(attempt);
    assert_eq!(call(&view, "read_source_import_start", capture.clone()).unwrap(), Value::Null);
    let original: StartRequest = serde_json::from_value(capture.clone()).unwrap();
    app.state::<AppState>().sessions.with(move |sessions| {
        let host = sessions.active.as_mut().unwrap().execution_parts().unwrap().0;
        host.source.job = Some(ExecutionId::new()); host.source.last_start = Some(original.original());
    });
    assert!(call(&view, "read_source_import_start", capture.clone()).is_err());
    app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_mut().unwrap().execution_parts().unwrap().0.source.job = None;
    });
    assert_eq!(
        call(&view, "start_source_import", capture.clone()).unwrap(),
        json!(attempt)
    );
    assert_eq!(
        call(&view, "start_source_import", capture.clone()).unwrap(),
        json!(attempt)
    );
    let source_start_read = call(&view, "read_source_import_start", capture.clone()).unwrap();
    let mut expected_request = capture.clone(); expected_request.as_object_mut().unwrap().remove("sessionToken");
    assert_eq!(source_start_read["request"], expected_request);
    for (field, value) in [("selectionId",json!(ExecutionId::new())),("sourceLanguage",json!("fr")),
        ("projectId",json!(ExecutionId::new())),("sessionToken",json!("retired-session"))] {
        let mut wrong = capture.clone(); wrong[field] = value;
        assert!(call(&view, "read_source_import_start", wrong).is_err());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let detail = loop {
        {
            let state = app.state::<AppState>();
            state.sessions.with(move |sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                host.tick(store).unwrap();
            })
        }
        let mut r = context.clone();
        r["attemptId"] = json!(attempt);
        r["offset"] = json!(0);
        r["limit"] = json!(1);
        let detail = call(&view, "read_execution_attempt", r).unwrap();
        if detail["items"][0]["status"]["validation"] == "valid" {
            break detail;
        }
        assert!(Instant::now() < deadline, "{detail}");
        std::thread::sleep(Duration::from_millis(1));
    };
    call(&view, "cancel_source_capture", context.clone()).unwrap();
    std::fs::remove_file(source.join("i18n/default.json")).unwrap();
    let mut request = context.clone();
    request["attemptId"] = json!(attempt);
    request["resultId"] = detail["items"][0]["resultId"].clone();
    request["after"] = json!(0);
    request["limit"] = json!(100);
    let preview = call(&view, "read_source_preview", request.clone()).unwrap();
    assert_eq!(preview["total"], 532);
    assert_eq!(preview["rows"].as_array().unwrap().len(), 100);
    assert_eq!(
        call(&view, "read_source_preview", request).unwrap(),
        preview
    );
    assert_eq!(
        call(&view, "read_content_scope", context.clone()).unwrap()["currentSnapshot"],
        Value::Null
    );
    let action = ExecutionId::new();
    let mut prepare = context.clone();
    prepare["attemptId"] = json!(attempt);
    prepare["resultId"] = preview["resultId"].clone();
    prepare["actionId"] = json!(action);
    prepare["confirmation"] = preview["confirmation"].clone();
    let original_unit = app.state::<AppState>().sessions.with(move |sessions| sessions.active.as_ref().unwrap().store.execution_input(attempt).unwrap().envelope().units[0].unit_id);
    let mut source_read = json!({"adoption":prepare,"unitId":original_unit});
    assert_eq!(call(&view, "read_source_adoption_action", source_read.clone()).unwrap(), Value::Null);
    let source_prepared = call(&view, "prepare_source_adoption", prepare.clone()).unwrap();
    assert_eq!(call(&view, "read_source_adoption_action", source_read.clone()).unwrap(), json!({"action":source_prepared,"receipt":null}));
    assert!(serde_json::from_value::<AdoptionActionRead>(json!({"action":source_prepared})).is_err());
    for field in ["projectId", "attemptId", "resultId", "sessionToken"] {
        let mut wrong = source_read.clone(); wrong["adoption"][field] = json!(ExecutionId::new());
        assert!(call(&view, "read_source_adoption_action", wrong).is_err());
    }

    let mut missing_action = source_read.clone();
    missing_action["adoption"]["actionId"] = json!(ExecutionId::new());
    assert_eq!(
        call(&view, "read_source_adoption_action", missing_action).unwrap(),
        Value::Null
    );
    assert!(serde_json::from_value::<AdoptionActionRead>(json!({"action":source_prepared.clone(),"receipt":null})).is_ok());
    let mut wrong_unit = source_read.clone();
    wrong_unit["unitId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_source_adoption_action", wrong_unit).is_err());
    let mut wrong_confirmation = source_read.clone();
    wrong_confirmation["adoption"]["confirmation"]["sourceLanguage"] = json!("fr-FR");
    assert!(call(&view, "read_source_adoption_action", wrong_confirmation).is_err());
    let mut adopt = context.clone();
    adopt["actionId"] = json!(action);
    let receipt = call(&view, "adopt_execution", adopt.clone()).unwrap();
    assert_eq!(
        call(&view, "read_source_adoption_action", source_read.clone()).unwrap(),
        json!({"action":source_prepared.clone(),"receipt":receipt.clone()})
    );
    assert_eq!(
        call(&view, "read_execution_receipt", adopt.clone()).unwrap(),
        receipt
    );
    assert_eq!(call(&view, "adopt_execution", adopt).unwrap(), receipt);
    let expected_source_read = json!({"action":source_prepared,"receipt":receipt});
    assert_eq!(call(&view, "read_source_adoption_action", source_read.clone()).unwrap(), expected_source_read);
    let snapshot = receipt["changes"][0]["id"].clone();
    let mut read = context.clone();
    read["snapshotId"] = snapshot.clone();
    read["after"] = json!(0);
    read["limit"] = json!(100);
    let content = call(&view, "read_source_content", read.clone()).unwrap();
    assert_eq!(content["total"], 532);
    let mut source_history_request = context.clone();
    source_history_request["offset"] = json!(0);
    source_history_request["limit"] = json!(100);
    let source_history =
        call(&view, "read_source_history", source_history_request.clone()).unwrap();
    assert_eq!(source_history["snapshots"][0]["snapshotId"], snapshot);
    let expected_revision = (preview["scope"]["revision"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap()
        + 1)
    .to_string();
    assert_eq!(
        source_history["snapshots"][0]["revision"],
        expected_revision
    );
    assert_eq!(
        source_history["snapshots"][0]["revision"],
        receipt["changes"][0]["revision"]
    );
    let mut summary_request = context.clone();
    summary_request["locale"] = json!("zh-CN");
    summary_request["query"] = json!("");
    summary_request["scopeId"] = Value::Null;
    summary_request["afterOrdinal"] = json!(0);
    summary_request["limit"] = json!(50);
    let summaries = call(&view, "read_review_summary_page", summary_request.clone()).unwrap();
    let typed: tsumugi_core::ReviewSummaryPage = serde_json::from_value(summaries.clone()).unwrap();
    assert_eq!(typed.total, 532);
    assert_eq!(typed.rows.len(), 50);
    assert_eq!(
        typed.source_snapshot_id.to_string(),
        snapshot.as_str().unwrap()
    );
    assert!(
        typed
            .rows
            .iter()
            .all(|row| row.source_preview.chars().count() <= 256)
    );
    assert!(summaries["rows"][0].get("basisEvidence").is_none());
    let last = &summaries["rows"][49];
    let mut save = context.clone();
    save["actionId"] = json!(ExecutionId::new());
    save["unitId"] = last["unitId"].clone();
    save["locale"] = json!("zh-CN");
    save["sourceRevisionId"] = last["sourceRevisionId"].clone();
    save["expectedSelectionId"] = Value::Null;
    save["text"] = json!("Saved fiftieth entry");
    let saved = call(&view, "save_translation_revision", save).unwrap();
    let mut editor_request = context.clone();
    editor_request["unitId"] = last["unitId"].clone();
    editor_request["locale"] = json!("zh-CN");
    let editor = call(&view, "read_review_editor_snapshot", editor_request).unwrap();
    let editor: tsumugi_core::ReviewEditorSnapshot = serde_json::from_value(editor).unwrap();
    assert_eq!(
        editor.target.translation_text.as_deref(),
        Some("Saved fiftieth entry")
    );
    assert_eq!(
        editor.target.selection_id.unwrap().to_string(),
        saved["selection"]["eventId"].as_str().unwrap()
    );
    assert_eq!(editor.translations.total, 1);
    assert_ne!(editor.target.basis, typed.rows[49].basis);
    let mut neighbor_request = context.clone();
    neighbor_request["locale"] = json!("zh-CN");
    neighbor_request["scopeId"] = summaries["scopeId"].clone();
    neighbor_request["unitId"] = last["unitId"].clone();
    neighbor_request["direction"] = json!(1);
    let neighbor = call(&view, "read_review_neighbor", neighbor_request.clone()).unwrap();
    summary_request["scopeId"] = summaries["scopeId"].clone();
    summary_request["afterOrdinal"] = neighbor["afterOrdinal"].clone();
    let next = call(&view, "read_review_summary_page", summary_request.clone()).unwrap();
    assert_eq!(next["rows"][0]["unitId"], neighbor["unitId"]);
    assert_eq!(next["rows"][0]["unitId"], content["rows"][50]["unitId"]);
    let mut scope_request = context.clone();
    scope_request["locale"] = json!("zh-CN");
    scope_request["scopeId"] = summaries["scopeId"].clone();
    scope_request["excluded"] = json!([last["unitId"]]);
    let captured = call(&view, "capture_review_scope", scope_request).unwrap();
    let captured: tsumugi_core::ReviewScopeCapture = serde_json::from_value(captured).unwrap();
    assert_eq!(captured.units.len(), 531);
    assert!(
        !captured
            .units
            .iter()
            .any(|unit| unit.unit_id == typed.rows[49].unit_id)
    );
    let mut wrong_scope = neighbor_request;
    wrong_scope["locale"] = json!("fr-FR");
    assert!(call(&view, "read_review_neighbor", wrong_scope).is_err());
    let mut changed_query = summary_request.clone();
    changed_query["query"] = json!("changed");
    assert!(call(&view, "read_review_summary_page", changed_query).is_err());
    wait_for_execution_idle(&view, &context);
    app.state::<AppState>().sessions.with(|sessions| {
        sessions.active.as_mut().unwrap().execution_parts().unwrap().0.quiescing = true;
    });
    assert_eq!(call(&view, "read_source_import_start", capture.clone()).unwrap(), source_start_read);
    app.state::<AppState>().sessions.with(|sessions| { sessions.active.as_mut().unwrap().execution = None; });
    let sequence = app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store.execution_sequence().unwrap());
    assert_eq!(call(&view, "read_source_import_start", capture.clone()).unwrap(), source_start_read);
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap(); assert!(active.execution.is_none());
        assert_eq!(active.store.execution_sequence().unwrap(), sequence);
    });
    call(
        &view,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &view,
        "open_project",
        json!({"locator":temp.path().join("project")}),
    )
    .unwrap();
    assert!(call(&view, "read_source_import_start", capture.clone()).is_err());
    capture["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_source_import_start", capture).unwrap(), source_start_read);
    app.state::<AppState>().sessions.with(|sessions| { assert!(sessions.active.as_ref().unwrap().execution.is_none()); });
    assert!(call(&view, "read_source_content", read.clone()).is_err());
    assert!(call(&view, "read_review_summary_page", summary_request.clone()).is_err());
    summary_request["sessionToken"] = reopened["sessionToken"].clone();
    let expired = call(&view, "read_review_summary_page", summary_request.clone()).unwrap_err();
    assert_eq!(expired["reason"], "review-scope-expired");
    summary_request["scopeId"] = Value::Null;
    assert_eq!(
        call(&view, "read_review_summary_page", summary_request).unwrap()["total"],
        532
    );
    assert!(call(&view, "read_source_adoption_action", source_read.clone()).is_err());
    source_read["adoption"]["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_source_adoption_action", source_read).unwrap(), expected_source_read);
    read["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_source_content", read).unwrap(), content);
    source_history_request["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(&view, "read_source_history", source_history_request).unwrap(),
        source_history
    );
    call(
        &view,
        "close_project",
        json!({"sessionToken":reopened["sessionToken"]}),
    )
    .unwrap();
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn segment_ipc_pages_and_freezes_one_basis_and_rejects_stale_or_foreign_reads() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("mod");
    std::fs::create_dir_all(source.join("i18n")).unwrap();
    std::fs::write(source.join("manifest.json"), br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#).unwrap();
    let source_text = format!("same {}", "你好🧵".repeat(100));
    std::fs::write(source.join("i18n/default.json"), serde_json::to_vec(&json!({
        "first":source_text, "second":source_text, "third":source_text,
    })).unwrap()).unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let project = call(&view, "create_project", json!({
        "destination":temp.path().join("project"), "displayName":"Segment reads",
        "sourceLocale":"en", "targetLocales":["zh-CN"]
    })).unwrap();
    let context = json!({"sessionToken":project["sessionToken"], "projectId":project["metadata"]["projectId"]});
    let selection = ExecutionId::new();
    app.state::<AppState>().sessions.with(move |sessions| {
        sessions.active.as_mut().unwrap().execution_parts().unwrap().0.source.selection = Some((
            selection,
            Arc::new(capture::Selection::authorize(source).unwrap()),
        ));
    });
    let attempt = ExecutionId::new();
    let mut start = context.clone();
    start["selectionId"] = json!(selection);
    start["sourceLanguage"] = json!("en");
    start["attemptId"] = json!(attempt);
    call(&view, "start_source_import", start).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let result = loop {
        app.state::<AppState>().sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.tick(store).unwrap();
        });
        let mut request = context.clone();
        request["attemptId"] = json!(attempt);
        request["offset"] = json!(0);
        request["limit"] = json!(1);
        let detail = call(&view, "read_execution_attempt", request).unwrap();
        if detail["items"][0]["status"]["validation"] == "valid" {
            break detail["items"][0]["resultId"].clone();
        }
        assert!(Instant::now() < deadline, "{detail}");
        std::thread::sleep(Duration::from_millis(1));
    };
    let mut preview = context.clone();
    preview["attemptId"] = json!(attempt);
    preview["resultId"] = result.clone();
    preview["after"] = json!(0);
    preview["limit"] = json!(10);
    let preview = call(&view, "read_source_preview", preview).unwrap();
    let action = ExecutionId::new();
    let mut prepare = context.clone();
    prepare["attemptId"] = json!(attempt);
    prepare["resultId"] = result;
    prepare["actionId"] = json!(action);
    prepare["confirmation"] = preview["confirmation"].clone();
    call(&view, "prepare_source_adoption", prepare).unwrap();
    let mut adopt = context.clone();
    adopt["actionId"] = json!(action);
    call(&view, "adopt_execution", adopt).unwrap();

    let mut request = context.clone();
    request["locale"] = json!("zh-CN");
    request["query"] = json!({"text":"same", "selection":"all"});
    request["scopeId"] = Value::Null;
    request["cursor"] = Value::Null;
    request["limit"] = json!(1);
    let read_started = Instant::now();
    let first = call(&view, "read_segment_page", request.clone()).unwrap();
    println!("segment ipc-fixture data=3 page=1 bytes={} round_trip_us={}", serde_json::to_vec(&first).unwrap().len(), read_started.elapsed().as_micros());
    let typed: tsumugi_core::SegmentPage = serde_json::from_value(first.clone()).unwrap();
    assert_eq!(typed.total, 3);
    assert_eq!(typed.rows.len(), 1);
    assert_eq!(first["projectId"], context["projectId"]);
    assert_eq!(first["query"], request["query"]);
    assert!(!first["nextCursor"].is_null());
    let mut continuation = request.clone();
    continuation["scopeId"] = first["scopeId"].clone();
    continuation["cursor"] = first["nextCursor"].clone();
    let second = call(&view, "read_segment_page", continuation.clone()).unwrap();
    continuation["cursor"] = second["nextCursor"].clone();
    let third = call(&view, "read_segment_page", continuation.clone()).unwrap();
    let pages = [&first, &second, &third];
    let units: std::collections::BTreeSet<_> = pages.iter()
        .map(|page| page["rows"][0]["content"]["unitId"].as_str().unwrap())
        .collect();
    assert_eq!(units.len(), 3, "equal source text must retain distinct identities");
    for page in pages {
        for field in ["scopeId", "sourceSnapshotId", "queryFingerprint", "readVersion", "epoch", "sequence"] {
            assert_eq!(page[field], first[field], "{field}");
        }
        assert_eq!(page["rows"][0]["content"]["sourcePreview"], source_text.chars().take(256).collect::<String>());
        assert_eq!(page["rows"][0]["sourceTruncated"], true);
        assert_eq!(page["rows"][0]["translationTruncated"], false);
        assert_eq!(page["rows"][0]["candidateCount"], 0);
        assert_eq!(page["rows"][0]["protection"]["unitId"], page["rows"][0]["content"]["unitId"]);
        assert_eq!(page["rows"][0]["protection"]["locale"], "zh-CN");
        assert_eq!(page["rows"][0]["qa"]["current"], false);
        assert!(page["rows"][0]["qa"]["outcome"].is_null());
        assert!(page["rows"][0]["qa"]["mandatoryCoverageComplete"].is_null());
        assert!(page["rows"][0]["applicability"]["sourceBasisCurrent"].is_null());
        assert!(page["rows"][0]["applicability"]["capturedBasisCurrent"].is_null());
        assert!(serde_json::to_vec(page).unwrap().len() <= content::MAX_CONTENT_PAGE_BYTES);
    }
    assert!(third["nextCursor"].is_null());
    let mut scope = context.clone();
    scope["locale"] = request["locale"].clone();
    scope["scopeId"] = first["scopeId"].clone();
    scope["queryFingerprint"] = first["queryFingerprint"].clone();
    scope["readVersion"] = first["readVersion"].clone();
    scope["excluded"] = json!([]);
    let frozen = call(&view, "capture_segment_scope", scope.clone()).unwrap();
    let frozen_typed: tsumugi_core::SegmentScopeCapture = serde_json::from_value(frozen.clone()).unwrap();
    assert_eq!(frozen_typed.capture.units.len(), 3, "capture includes unseen pages");
    assert_eq!(frozen["projectId"], context["projectId"]);
    assert_eq!(frozen["readVersion"], first["readVersion"]);
    assert_eq!(frozen["queryFingerprint"], first["queryFingerprint"]);
    let mut excluded = scope.clone();
    excluded["excluded"] = json!([first["rows"][0]["content"]["unitId"]]);
    let excluded = call(&view, "capture_segment_scope", excluded).unwrap();
    assert_eq!(excluded["capture"]["units"].as_array().unwrap().len(), 2);
    assert!(excluded["capture"]["units"].as_array().unwrap().iter()
        .all(|unit| unit["unitId"] != first["rows"][0]["content"]["unitId"]));
    for query in [json!({"text":"different", "selection":"all"}), json!({"text":"same", "selection":"selected"})] {
        let mut wrong = continuation.clone();
        wrong["query"] = query;
        assert!(call(&view, "read_segment_page", wrong).is_err());
    }
    for (field, value) in [("projectId", json!(ExecutionId::new())), ("sessionToken", json!("foreign-session"))] {
        let mut wrong_page = continuation.clone();
        wrong_page[field] = value.clone();
        assert_eq!(call(&view, "read_segment_page", wrong_page).unwrap_err()["code"], "session-invalid");
        let mut wrong_scope = scope.clone();
        wrong_scope[field] = value;
        assert_eq!(call(&view, "capture_segment_scope", wrong_scope).unwrap_err()["code"], "session-invalid");
    }
    for field in ["queryFingerprint", "readVersion"] {
        let mut wrong = scope.clone();
        wrong[field] = json!("unrelated-basis");
        assert!(call(&view, "capture_segment_scope", wrong).is_err());
    }

    let row = &first["rows"][0]["content"];
    let mut save = context.clone();
    save["actionId"] = json!(ExecutionId::new());
    save["unitId"] = row["unitId"].clone();
    save["locale"] = request["locale"].clone();
    save["sourceRevisionId"] = row["sourceRevisionId"].clone();
    save["expectedSelectionId"] = Value::Null;
    let translation_text = "译文🧵".repeat(100);
    save["text"] = json!(translation_text);
    let saved = call(&view, "save_translation_revision", save.clone()).unwrap();
    assert!(call(&view, "read_segment_page", continuation).is_err());
    assert!(call(&view, "capture_segment_scope", scope).is_err());
    assert_eq!(frozen_typed.capture.units.len(), 3, "an earlier captured value remains fixed");
    request["query"]["selection"] = json!("selected");
    let selected = call(&view, "read_segment_page", request.clone()).unwrap();
    assert_eq!(selected["total"], 1);
    assert_eq!(selected["rows"][0]["content"]["translationPreview"], translation_text.chars().take(256).collect::<String>());
    assert_eq!(selected["rows"][0]["translationTruncated"], true);
    assert_eq!(selected["rows"][0]["protection"]["protected"], true);
    assert_eq!(selected["rows"][0]["candidateCount"], 0, "current selection is not a candidate");
    assert_eq!(selected["rows"][0]["applicability"]["sourceBasisCurrent"], true);
    assert_eq!(selected["rows"][0]["applicability"]["capturedBasisCurrent"], true);

    let captured_request = |page: &Value| json!({
        "sessionToken":context["sessionToken"], "projectId":context["projectId"], "locale":"zh-CN",
        "scopeId":page["scopeId"], "queryFingerprint":page["queryFingerprint"],
        "readVersion":page["readVersion"], "excluded":[],
    });
    let continuation_request = |page: &Value| {
        let mut follow = request.clone();
        follow["scopeId"] = page["scopeId"].clone();
        follow
    };
    let mut release = context.clone();
    release["actionId"] = json!(ExecutionId::new());
    release["unitId"] = row["unitId"].clone();
    release["locale"] = json!("zh-CN");
    release["sourceRevisionId"] = row["sourceRevisionId"].clone();
    release["selectionId"] = saved["selection"]["eventId"].clone();
    release["expectedRevision"] = selected["rows"][0]["protection"]["revision"].clone();
    release["protected"] = json!(false);
    release["confirmedRelease"] = json!(true);
    call(&view, "set_work_protection", release).unwrap();
    assert!(call(&view, "read_segment_page", continuation_request(&selected)).is_err());
    assert!(call(&view, "capture_segment_scope", captured_request(&selected)).is_err());
    let released = call(&view, "read_segment_page", request.clone()).unwrap();
    assert_eq!(released["rows"][0]["protection"]["protected"], false);

    save["actionId"] = json!(ExecutionId::new());
    save["expectedSelectionId"] = saved["selection"]["eventId"].clone();
    save["text"] = json!("Replacement translation");
    call(&view, "save_translation_revision", save).unwrap();
    assert!(call(&view, "read_segment_page", continuation_request(&released)).is_err());
    assert!(call(&view, "capture_segment_scope", captured_request(&released)).is_err());
    let replacement = call(&view, "read_segment_page", request.clone()).unwrap();
    assert_eq!(replacement["rows"][0]["candidateCount"], 1, "comparable historical revision remains a candidate");
    assert_eq!(replacement["rows"][0]["translationTruncated"], false);

    for index in 0..9 {
        let mut term = context.clone();
        term["term"] = json!({
            "projectId":context["projectId"], "actionId":ExecutionId::new(), "termId":null,
            "locale":"zh-CN", "source":format!("scope-only-{index}"), "aliases":[],
            "target":format!("Target {index}"), "protected":false, "scopeUnitId":row["unitId"],
            "expectedRevisionId":null, "reason":"Synthetic unit-scoped term",
        });
        call(&view, "save_term", term).unwrap();
    }
    assert!(call(&view, "read_segment_page", continuation_request(&replacement)).is_err());
    assert!(call(&view, "capture_segment_scope", captured_request(&replacement)).is_err());
    let resources = call(&view, "read_segment_page", request.clone()).unwrap();
    let enriched = &resources["rows"][0];
    assert_eq!(enriched["terms"]["applicableEntryCount"], 9, "unit-scoped applicability does not require a literal source hit");
    assert_eq!(enriched["terms"]["conflictingEntryCount"], 0);
    assert_eq!(enriched["terms"]["revisionCount"], 9);
    assert_eq!(enriched["terms"]["revisions"].as_array().unwrap().len(), 8);
    assert_eq!(enriched["terms"]["truncated"], true);
    assert_eq!(enriched["applicability"]["sourceBasisCurrent"], true);
    assert_eq!(enriched["applicability"]["capturedBasisCurrent"], false);
    assert_eq!(enriched["applicability"]["resourceReviewRequired"], true);
    assert_eq!(enriched["applicability"]["resourceImpact"]["reasonCount"], 9);
    assert_eq!(enriched["applicability"]["resourceImpact"]["changes"].as_array().unwrap().len(), 8);
    assert_eq!(enriched["applicability"]["resourceImpact"]["truncated"], true);
    assert!(serde_json::to_vec(&resources).unwrap().len() <= content::MAX_CONTENT_PAGE_BYTES);
    request["query"]["selection"] = json!("unselected");
    assert_eq!(call(&view, "read_segment_page", request).unwrap()["total"], 2);
}

#[test]
#[cfg(any(windows, target_os = "macos"))]
fn translation_ipc_imports_candidates_edits_and_reopens() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("mod");
    std::fs::create_dir_all(source.join("i18n")).unwrap();
    std::fs::write(source.join("manifest.json"), br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#).unwrap();
    std::fs::write(
        source.join("i18n/default.json"),
        br#"{"first":"same","second":"same"}"#,
    )
    .unwrap();
    std::fs::write(
        source.join("i18n/zh.json"),
        r#"{"FIRST":"你好","second":"","missing":"same"}"#.as_bytes(),
    )
    .unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project = call(
        &view,
        "create_project",
        json!({
            "destination": temp.path().join("project"), "displayName":"Translation IPC",
            "sourceLocale":"en", "targetLocales":["zh-CN"]
        }),
    )
    .unwrap();
    let mut context = json!({"sessionToken":project["sessionToken"],"projectId":project["metadata"]["projectId"]});
    let selection = ExecutionId::new();
    {
        let state = app.state::<AppState>();
        let source = source.clone();
        state.sessions.with(move |sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution_parts()
                .unwrap()
                .0
                .source
                .selection = Some((
                selection,
                Arc::new(capture::Selection::authorize(source.clone()).unwrap()),
            ));
        })
    }
    let mut files = context.clone();
    files["selectionId"] = json!(selection);
    assert_eq!(
        call(&view, "list_translation_files", files).unwrap(),
        json!(["zh.json"])
    );
    let mut capture = context.clone();
    capture["selectionId"] = json!(selection);
    capture["sourceLanguage"] = json!("en");
    let source_attempt = ExecutionId::new();
    capture["attemptId"] = json!(source_attempt);
    call(&view, "start_source_import", capture).unwrap();
    let wait = |attempt: ExecutionId, expected: usize| {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            {
                let state = app.state::<AppState>();
                state.sessions.with(move |sessions| {
                    let (host, store) =
                        sessions.active.as_mut().unwrap().execution_parts().unwrap();
                    host.tick(store).unwrap();
                })
            }
            let mut request = context.clone();
            request["attemptId"] = json!(attempt);
            request["offset"] = json!(0);
            request["limit"] = json!(100);
            let detail = call(&view, "read_execution_attempt", request).unwrap();
            if detail["items"].as_array().unwrap().len() == expected
                && detail["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| item["status"]["validation"] == "valid")
            {
                return detail;
            }
            assert!(Instant::now() < deadline, "{detail}");
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    let detail = wait(source_attempt, 1);
    let source_result = detail["items"][0]["resultId"].clone();
    let mut source_preview = context.clone();
    source_preview["attemptId"] = json!(source_attempt);
    source_preview["resultId"] = source_result.clone();
    source_preview["after"] = json!(0);
    source_preview["limit"] = json!(10);
    let preview = call(&view, "read_source_preview", source_preview).unwrap();
    let source_action = ExecutionId::new();
    let mut prepare = context.clone();
    prepare["attemptId"] = json!(source_attempt);
    prepare["resultId"] = source_result;
    prepare["actionId"] = json!(source_action);
    prepare["confirmation"] = preview["confirmation"].clone();
    call(&view, "prepare_source_adoption", prepare).unwrap();
    let mut adopt = context.clone();
    adopt["actionId"] = json!(source_action);
    call(&view, "adopt_execution", adopt).unwrap();

    let mut translation = context.clone();
    translation["selectionId"] = json!(selection);
    translation["fileName"] = json!("zh.json");
    translation["targetLocale"] = json!("zh-CN");
    assert_eq!(
        call(&view, "preflight_translation", translation.clone()).unwrap()["count"],
        3
    );
    let translation_attempt = ExecutionId::new();
    translation["attemptId"] = json!(translation_attempt);
    let checked = call(&view, "preflight_translation", {
        let mut request = translation.clone();
        request.as_object_mut().unwrap().remove("attemptId");
        request
    })
    .unwrap();
    translation["expectedFileDigest"] = checked["fileDigest"].clone();
    translation["expectedSourceSnapshotId"] = checked["sourceSnapshotId"].clone();
    translation["languageConfirmed"] = json!(false);
    assert!(call(&view, "start_translation_import", translation.clone()).is_err());
    translation["languageConfirmed"] = json!(true);
    assert_eq!(call(&view, "read_translation_import_start", translation.clone()).unwrap(), Value::Null);
    call(&view, "start_translation_import", translation.clone()).unwrap();
    assert_eq!(
        call(&view, "start_translation_import", translation.clone()).unwrap(),
        json!(translation_attempt)
    );
    let translation_start_read = call(&view, "read_translation_import_start", translation.clone()).unwrap();
    let mut expected_request = translation.clone(); expected_request.as_object_mut().unwrap().remove("sessionToken");
    assert_eq!(translation_start_read["request"], expected_request);
    for (field, value) in [("selectionId",json!(ExecutionId::new())),("fileName",json!("zh-CN.json")),
        ("targetLocale",json!("zh-TW")),("languageConfirmed",json!(false)),("expectedFileDigest",json!("0".repeat(64))),
        ("expectedSourceSnapshotId",json!(ExecutionId::new())),("projectId",json!(ExecutionId::new())),("sessionToken",json!("retired-session"))] {
        let mut wrong = translation.clone(); wrong[field] = value;
        assert!(call(&view, "read_translation_import_start", wrong).is_err());
    }
    wait(translation_attempt, 3);
    let mut read = context.clone();
    read["attemptId"] = json!(translation_attempt);
    read["after"] = json!(0);
    read["limit"] = json!(10);
    read["basis"] = Value::Null;
    let page = call(&view, "read_translation_preview", read.clone()).unwrap();
    assert_eq!(
        (
            page["total"].as_u64(),
            page["unique"].as_u64(),
            page["unmatched"].as_u64()
        ),
        (Some(3), Some(2), Some(1))
    );
    assert_eq!(page["rows"][0]["entry"]["nativeKey"], "FIRST");
    let import = |row: &Value, decision: &str| {
        let action_id = ExecutionId::new();
        let request = json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],
            "attemptId":translation_attempt,"itemId":row["itemId"],"resultId":row["resultId"],"actionId":action_id,
            "confirmation":{"resultDigest":row["resultDigest"],"sourceSnapshotId":page["currentSourceSnapshotId"],
                "occurrenceId":row["occurrenceId"],"sourceRevisionId":row["sourceRevisionId"],
                "targetUnitId":row["unitId"],"expectedSelectionId":row["currentSelection"]["eventId"],"decision":decision}});
        (action_id, request)
    };
    let (_first_id, first_request) = import(&page["rows"][0], "candidate-only");
    let original_item = ExecutionId::parse(first_request["itemId"].as_str().unwrap()).unwrap();
    let recovery_unit = app.state::<AppState>().sessions.with(move |sessions| {
        let input = sessions.active.as_ref().unwrap().store.execution_input(translation_attempt).unwrap();
        input.envelope().units.iter().find(|unit| unit.item_ids == [original_item]).unwrap().unit_id
    });
    let mut import_read = json!({"adoption":first_request,"unitId":recovery_unit});
    assert_eq!(call(&view, "read_translation_adoption_action", import_read.clone()).unwrap(), Value::Null);
    let import_prepared = call(&view, "prepare_translation_adoption", first_request.clone()).unwrap();
    assert_eq!(call(&view, "read_translation_adoption_action", import_read.clone()).unwrap(), json!({"action":import_prepared,"receipt":null}));
    for field in ["projectId", "itemId", "sessionToken"] {
        let mut wrong = import_read.clone(); wrong["adoption"][field] = json!(ExecutionId::new());
        assert!(call(&view, "read_translation_adoption_action", wrong).is_err());
    }
    let mut wrong = import_read.clone(); wrong["adoption"]["confirmation"]["decision"] = json!("replace");
    assert!(call(&view, "read_translation_adoption_action", wrong).is_err());

    let mut wrong = import_read.clone(); wrong["unitId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_translation_adoption_action", wrong).is_err());
    let mut wrong = import_read.clone(); wrong["sessionToken"] = context["sessionToken"].clone();
    assert!(call(&view, "read_translation_adoption_action", wrong).is_err());
    let first_id = first_request["actionId"].clone();
    let first_receipt = call(&view, "adopt_execution", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":first_id})).unwrap();
    assert_eq!(first_receipt["changes"].as_array().unwrap().len(), 1);
    let expected_import_read = json!({"action":import_prepared,"receipt":first_receipt});
    assert_eq!(call(&view, "read_translation_adoption_action", import_read.clone()).unwrap(), expected_import_read);
    let (_second_id, second_request) = import(&page["rows"][1], "select-if-empty");
    call(
        &view,
        "prepare_translation_adoption",
        second_request.clone(),
    )
    .unwrap();
    let second_receipt = call(&view, "adopt_execution", json!({"sessionToken":context["sessionToken"],"projectId":context["projectId"],"actionId":second_request["actionId"]})).unwrap();
    assert_eq!(second_receipt["changes"].as_array().unwrap().len(), 2);
    let mut history = context.clone();
    history["unitId"] = page["rows"][0]["unitId"].clone();
    history["locale"] = json!("zh-CN");
    history["afterOrdinal"] = json!("0");
    history["limit"] = json!(10);
    let imported = call(&view, "read_translation_history", history.clone()).unwrap();
    assert_eq!(imported["total"], "1");
    assert_eq!(imported["current"], Value::Null);
    let mut save = context.clone();
    save["actionId"] = json!(ExecutionId::new());
    save["unitId"] = history["unitId"].clone();
    save["locale"] = json!("zh-CN");
    save["sourceRevisionId"] = page["rows"][0]["sourceRevisionId"].clone();
    save["expectedSelectionId"] = Value::Null;
    save["text"] = json!("人工编辑");
    let manual = call(&view, "save_translation_revision", save.clone()).unwrap();
    assert_eq!(
        call(&view, "save_translation_revision", save.clone()).unwrap(),
        manual
    );
    let mut select = context.clone();
    select["actionId"] = json!(ExecutionId::new());
    select["unitId"] = history["unitId"].clone();
    select["locale"] = json!("zh-CN");
    select["sourceRevisionId"] = page["rows"][0]["sourceRevisionId"].clone();
    select["expectedSelectionId"] = manual["selection"]["eventId"].clone();
    select["revisionId"] = imported["rows"][0]["revisionId"].clone();
    let restored = call(&view, "select_translation_revision", select.clone()).unwrap();
    assert_eq!(restored["revisionId"], imported["rows"][0]["revisionId"]);
    let project_id = ExecutionId::parse(context["projectId"].as_str().unwrap()).unwrap();
    let unit_id = ExecutionId::parse(history["unitId"].as_str().unwrap()).unwrap();
    let before_reads = app.state::<AppState>().sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        (
            store
                .changes_since(tsumugi_core::execution::Revision::new(0).unwrap())
                .sequence,
            store
                .translation_history(project_id, unit_id, "zh-CN", 0, 10)
                .unwrap()
                .total,
        )
    });
    assert_eq!(
        call(&view, "read_translation_save_action", save.clone()).unwrap(),
        manual
    );
    assert_eq!(
        call(&view, "read_translation_selection_action", select.clone()).unwrap(),
        restored
    );
    let mut missing = save.clone();
    missing["actionId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_translation_save_action", missing).unwrap().is_null());
    let mut missing_selection = select.clone();
    missing_selection["actionId"] = json!(ExecutionId::new());
    assert!(call(&view, "read_translation_selection_action", missing_selection)
        .unwrap()
        .is_null());
    let mut altered = save.clone();
    altered["text"] = json!("Different request");
    assert_eq!(
        call(&view, "read_translation_save_action", altered).unwrap_err()["code"],
        "result-mismatch"
    );
    let mut other_kind = save.clone();
    other_kind["actionId"] = select["actionId"].clone();
    assert_eq!(
        call(&view, "read_translation_save_action", other_kind).unwrap_err()["code"],
        "result-mismatch"
    );
    let mut other_kind = select.clone();
    other_kind["actionId"] = save["actionId"].clone();
    assert_eq!(
        call(&view, "read_translation_selection_action", other_kind)
            .unwrap_err()["code"],
        "result-mismatch"
    );
    for command in [
        "read_translation_save_action",
        "read_translation_selection_action",
    ] {
        let original = if command == "read_translation_save_action" {
            &save
        } else {
            &select
        };
        for field in ["sessionToken", "projectId"] {
            let mut foreign = original.clone();
            foreign[field] = if field == "sessionToken" {
                json!("inactive-session")
            } else {
                json!(ExecutionId::new())
            };
            assert_eq!(call(&view, command, foreign).unwrap_err()["code"], "session-invalid");
        }
        let mut unknown = original.clone();
        unknown["approved"] = json!(true);
        assert!(call(&view, command, unknown).is_err());
    }
    app.state::<AppState>().sessions.with(|sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.quiescing = true;
    });
    assert_eq!(call(&view, "read_translation_import_start", translation.clone()).unwrap(), translation_start_read);
    assert_eq!(call(&view, "read_translation_save_action", save.clone()).unwrap(), manual);
    assert_eq!(call(&view, "read_translation_selection_action", select.clone()).unwrap(), restored);
    app.state::<AppState>().sessions.with(|sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.quiescing = false;
    });
    let after_reads = app.state::<AppState>().sessions.with(move |sessions| {
        let store = &sessions.active.as_ref().unwrap().store;
        (
            store
                .changes_since(tsumugi_core::execution::Revision::new(0).unwrap())
                .sequence,
            store
                .translation_history(project_id, unit_id, "zh-CN", 0, 10)
                .unwrap()
                .total,
        )
    });
    let sequence_before_action = app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()).sequence);
    assert_eq!(call(&view, "read_translation_adoption_action", import_read.clone()).unwrap(), expected_import_read);
    assert_eq!(app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()).sequence), sequence_before_action);
    assert_eq!(after_reads, before_reads);
    wait_for_execution_idle(&view, &context);
    call(
        &view,
        "close_project",
        json!({"sessionToken":context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &view,
        "open_project",
        json!({"locator":temp.path().join("project")}),
    )
    .unwrap();
    assert!(call(&view, "read_translation_import_start", translation.clone()).is_err());
    translation["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_translation_import_start", translation).unwrap(), translation_start_read);
    app.state::<AppState>().sessions.with(|sessions| { assert!(sessions.active.as_ref().unwrap().execution.is_none()); });
    assert!(call(&view, "read_translation_adoption_action", import_read.clone()).is_err());
    import_read["adoption"]["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_translation_adoption_action", import_read).unwrap(), expected_import_read);
    context["sessionToken"] = reopened["sessionToken"].clone();
    history["sessionToken"] = reopened["sessionToken"].clone();
    save["sessionToken"] = reopened["sessionToken"].clone();
    select["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&view, "read_translation_save_action", save).unwrap(), manual);
    assert_eq!(call(&view, "read_translation_selection_action", select).unwrap(), restored);
    let saved = call(&view, "read_translation_history", history).unwrap();
    assert_eq!(saved["total"], "2");
    assert_eq!(saved["current"]["revisionId"], restored["revisionId"]);
    assert_eq!(saved["rows"][0]["originKind"], "import");
}
