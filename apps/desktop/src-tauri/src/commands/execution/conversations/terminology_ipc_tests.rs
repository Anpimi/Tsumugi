use super::*;
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;

#[test]
fn registered_terminology_planning_and_edited_decisions_survive_reopen() {
    let (directory, store, rows) = fixture::source_fixture();
    let source_row = rows
        .iter()
        .find(|row| row.unit_id.is_some() && row.occurrence.text.trim().chars().count() > 1)
        .expect("a nonempty source with distinct fragments");
    let unit = source_row.unit_id.unwrap();
    let source = source_row
        .occurrence
        .text
        .chars()
        .take(128)
        .collect::<String>();
    let fragment = source
        .chars()
        .find(|character| !character.is_whitespace())
        .unwrap()
        .to_string();
    assert_ne!(source, fragment);
    assert!(source_row.occurrence.text.contains(&fragment));
    let units = vec![unit];
    let sources = [source, fragment];
    store.close().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.state::<AppState>()
        .local_drafts
        .set(
            crate::commands::drafts::DraftStore::at(directory.path().join("local-drafts")).unwrap(),
        )
        .ok()
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let locator = directory.path().join("project");
    let project = call(&window, "open_project", json!({"locator":locator}));
    let project_id = project["metadata"]["projectId"].clone();
    let thread = call(
        &window,
        "create_project_conversation",
        in_session(
            &project,
            json!({"actionId":identity(),"conversationId":identity(),"title":"Terminology review"}),
        ),
    );
    let message = call(
        &window,
        "append_project_conversation_message",
        in_session(
            &project,
            json!({"actionId":identity(),"conversationId":thread["conversationId"],"messageId":identity(),"body":"Suggest two terms for the selected entry."}),
        ),
    );
    let entries: Vec<_> = sources.iter().enumerate().map(|(index,source)|
        json!({"unitId":unit,"source":source,"aliases":[format!("Alias {index}")],"target":format!("Suggested {index}"),"protected":false,"reason":"Review this term"})).collect();
    let content = json!({"kind":"term-proposal","summary":"Terminology for review","entries":entries,"questions":[]});
    let provider = PlanningProvider::with_content(content.clone());
    let config = tsumugi_core::ai::AiConfig {
        endpoint: provider.endpoint.clone(),
        model: "synthetic-term-planner".into(),
        credential_env: String::new(),
        max_requests: 1,
        ..Default::default()
    };
    let prepare = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"purpose":"terminology",
        "selectedMessageIds":[message["messageId"]],"scope":{"kind":"units","locale":"zh-CN","unitIds":units},"config":config}),
    );
    let mut wrong_scope = prepare.clone();
    wrong_scope["scope"] = json!({"kind":"conversation-only"});
    assert!(!reject(&window, "prepare_conversation_planning", wrong_scope).is_null());
    let prepared = call(&window, "prepare_conversation_planning", prepare);
    assert_eq!(prepared["preview"]["version"], 4);
    assert_eq!(prepared["preview"]["purpose"], "terminology");
    assert_eq!(provider.count(), 0);
    let attempt = identity();
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 60_000;
    let start = in_session(
        &project,
        json!({"conversationId":thread["conversationId"],"preparationId":prepared["preparationId"],
        "consent":{"actionId":attempt,"attemptId":attempt,"taskId":identity(),"previewDigest":prepared["previewDigest"],
            "expiresAtMs":expires.to_string(),"shareMessages":true,"shareUnits":true}}),
    );
    let mut unapproved = start.clone();
    unapproved["consent"]["shareUnits"] = false.into();
    assert!(!reject(&window, "start_conversation_planning", unapproved).is_null());
    assert_eq!(provider.count(), 0);
    let started = call(&window, "start_conversation_planning", start.clone());
    assert_eq!(call(&window, "start_conversation_planning", start), started);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let completed = loop {
        let view = call(
            &window,
            "read_conversation_planning",
            in_session(
                &project,
                json!({"conversationId":thread["conversationId"],"attemptId":attempt}),
            ),
        );
        if view["output"].is_object() {
            break view;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "terminology planning did not finish: {view}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(completed["output"]["model"], content);
    assert_eq!(completed["output"]["usage"]["promptTokens"], "7");
    assert_eq!(completed["budget"]["dispatched"], 1);
    assert_eq!(provider.count(), 1);
    let terms = in_session(
        &project,
        json!({"locale":"zh-CN","afterTermId":null,"limit":100}),
    );
    assert_eq!(call(&window, "read_terms", terms.clone()), json!([]));
    let capture_request = in_session(
        &project,
        json!({"actionId":identity(),"conversationId":thread["conversationId"],"proposalId":identity(),"revisionId":identity(),
        "attemptId":attempt,"resultId":completed["resultId"]}),
    );
    let captured = call(
        &window,
        "capture_conversation_proposal",
        capture_request.clone(),
    );
    assert_eq!(
        call(&window, "capture_conversation_proposal", capture_request),
        captured
    );
    let reference = json!({"projectId":project_id,"conversationId":thread["conversationId"],"proposalId":captured["proposalId"],"revisionId":captured["revisionId"]});
    let captures = call(
        &window,
        "list_resource_captures",
        in_session(&project, json!({"limit":100})),
    );
    assert_eq!(captures.as_array().unwrap().len(), 1);
    assert_eq!(captures[0]["captureId"], captured["revisionId"]);
    assert_eq!(captures[0]["origin"]["kind"], "conversation");
    assert_eq!(captures[0]["origin"]["proposal"], reference);
    assert_eq!(captures[0]["origin"]["modelOrigin"], captured["origin"]);
    let preview_request = in_session(&project, json!({"captureId":captured["revisionId"]}));
    let preview = call(&window, "read_resource_preview", preview_request.clone());
    assert_eq!(
        preview["conversation"],
        json!({"proposal":reference,"modelOrigin":captured["origin"],"current":true})
    );
    assert_eq!(preview["rows"].as_array().unwrap().len(), 2);
    for index in 0..2 {
        assert_eq!(preview["rows"][index]["entry"]["source"], sources[index]);
        assert_eq!(preview["rows"][index]["scopeUnitId"], json!(unit));
    }
    assert_eq!(call(&window, "read_terms", terms.clone()), json!([]));
    let mut saved = Vec::new();
    let mut journal = None;
    for index in 0..2 {
        let decision = json!({"projectId":project_id,"actionId":identity(),"captureId":captured["revisionId"],
            "entryId":preview["rows"][index]["entry"]["id"],"expectedRevisionId":null,"decision":"adopt",
            "editedTarget":format!("Human edited {index} é 👩🏽‍💻")});
        let request = in_session(&project, json!({"decision":decision}));
        assert!(call(&window, "read_resource_decision_action", request.clone()).is_null());
        if index == 0 {
            let fixture: Value = serde_json::from_str(include_str!(
                "../../../../../test/fixtures/resourceDraftCommands.contract.json"
            ))
            .unwrap();
            let mut value = fixture["requests"]["write"]["write"]["value"].clone();
            value["previewCaptureId"] = captured["revisionId"].clone();
            value["proposalEditDraft"] = json!({"captureId":captured["revisionId"],"entryId":decision["entryId"],"locale":"zh-CN",
                "expectedRevisionId":null,"source":sources[0],"currentTarget":null,"originalTarget":content["entries"][0]["target"],
                "target":decision["editedTarget"],"editSeq":"10"});
            value["pending"] =
                json!({"kind":"decision","request":decision,"locale":"zh-CN","submittedSeq":"10"});
            let key = json!({"projectId":project_id});
            let write =
                json!({"key":key,"expectedRevision":"0","writerId":identity(),"value":value});
            let head = call(
                &window,
                "write_local_resource_draft",
                json!({"sessionToken":project["sessionToken"],"write":write}),
            );
            journal = Some((key, head));
        }
        let receipt = call(&window, "decide_resource_entry", request.clone());
        assert_eq!(receipt["revision"]["target"], decision["editedTarget"]);
        assert_eq!(receipt["revision"]["source"], sources[index]);
        assert_eq!(receipt["revision"]["scopeUnitId"], json!(unit));
        assert_eq!(
            call(&window, "decide_resource_entry", request.clone()),
            receipt
        );
        saved.push((request, receipt));
    }
    assert_eq!(
        call(&window, "read_terms", terms).as_array().unwrap().len(),
        2
    );
    assert_eq!(provider.count(), 1);
    call(
        &window,
        "close_project",
        json!({"sessionToken":project["sessionToken"]}),
    );
    let reopened = call(&window, "open_project", json!({"locator":locator}));
    let (key, head) = journal.unwrap();
    assert_eq!(
        call(
            &window,
            "read_local_resource_draft",
            json!({"sessionToken":reopened["sessionToken"],"key":key})
        ),
        head
    );
    let reopened_run = call(
        &window,
        "read_conversation_planning",
        in_session(
            &reopened,
            json!({"conversationId":thread["conversationId"],"attemptId":attempt}),
        ),
    );
    assert_eq!(reopened_run["output"]["usage"]["promptTokens"], "7");
    assert_eq!(reopened_run["budget"]["dispatched"], 1);
    let reopened_preview = call(
        &window,
        "read_resource_preview",
        in_session(&reopened, json!({"captureId":captured["revisionId"]})),
    );
    assert_eq!(reopened_preview["capture"]["origin"], captures[0]["origin"]);
    for (mut request, receipt) in saved {
        request["sessionToken"] = reopened["sessionToken"].clone();
        let observed = call(&window, "read_resource_decision_action", request.clone());
        assert_eq!(observed["request"], request["decision"]);
        assert_eq!(observed["receipt"], receipt);
        assert_eq!(call(&window, "decide_resource_entry", request), receipt);
    }
    assert_eq!(provider.count(), 1);
    let mut revised_content = content.clone();
    revised_content["summary"] = json!("Clarified terms; original entries preserved");
    let revise = in_session(
        &reopened,
        json!({"actionId":identity(),"conversationId":thread["conversationId"],
        "proposalId":captured["proposalId"],"revisionId":identity(),"expectedRevisionId":captured["revisionId"],"content":revised_content}),
    );
    let mut changed_entries = revise.clone();
    changed_entries["actionId"] = json!(identity());
    changed_entries["content"]["entries"][0]["target"] =
        json!("This edit belongs to resource adoption");
    assert!(!reject(&window, "revise_conversation_proposal", changed_entries).is_null());
    let revised = call(&window, "revise_conversation_proposal", revise.clone());
    assert_eq!(
        call(&window, "revise_conversation_proposal", revise),
        revised
    );
    assert_eq!(revised["content"]["entries"], content["entries"]);
    assert_eq!(revised["origin"], captured["origin"]);
    let new_preview = call(
        &window,
        "read_resource_preview",
        in_session(&reopened, json!({"captureId":revised["revisionId"]})),
    );
    assert_eq!(new_preview["conversation"]["current"], true);
    assert_eq!(
        new_preview["capture"]["origin"]["proposal"]["revisionId"],
        revised["revisionId"]
    );
    let historical = call(
        &window,
        "read_resource_preview",
        in_session(&reopened, json!({"captureId":captured["revisionId"]})),
    );
    assert_eq!(historical["conversation"]["current"], false);
    assert_eq!(historical["capture"]["origin"], captures[0]["origin"]);
    assert_eq!(
        provider.count(),
        1,
        "Formal revisions never dispatch another planning call"
    );
    call(
        &window,
        "close_project",
        json!({"sessionToken":reopened["sessionToken"]}),
    );
}
