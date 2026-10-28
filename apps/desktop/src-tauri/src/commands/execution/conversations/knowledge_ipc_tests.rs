use super::*;
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;

#[test]
fn knowledge_decision_wire_fixture_round_trips_the_original_request_and_causal_reference() {
    use super::super::proposals::knowledge::*;
    let fixture: Value = serde_json::from_str(include_str!("../../../../../test/fixtures/conversationKnowledge.contract.json")).unwrap();
    macro_rules! round_trip { ($group:literal, $key:literal, $kind:ty) => {
        let value: $kind = serde_json::from_value(fixture[$group][$key].clone()).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(),fixture[$group][$key],$key);
    }; }
    round_trip!("requests","preview",PreviewConversationKnowledgeAdoptionRequest);
    round_trip!("requests","decision",ConversationKnowledgeDecisionRequest);
    round_trip!("requests","read",ReadConversationKnowledgeDecisionRequest);
    round_trip!("requests","action",ConversationKnowledgeDecisionRequest);
    round_trip!("requests","recovery",ConversationKnowledgeDecisionRequest);
    round_trip!("responses","preview",ConversationKnowledgeAdoptionPreview);
    round_trip!("responses","decision",ConversationKnowledgeDecision);
    round_trip!("responses","read",Option<ConversationKnowledgeDecision>);
    round_trip!("responses","action",Option<ConversationKnowledgeDecision>);
    round_trip!("responses","recovery",ConversationKnowledgeDecisionRecovery);
    round_trip!("responses","pending",ConversationKnowledgeDecisionRecovery);
    let causal: tsumugi_core::ContextResourceAction = serde_json::from_value(fixture["causal"].clone()).unwrap();
    assert_eq!(serde_json::to_value(causal).unwrap(),fixture["causal"]);
    let mut injected = fixture["responses"]["preview"]["entry"].clone();
    injected["contextId"] = fixture["responses"]["decision"]["resource"]["contextId"].clone();
    assert!(serde_json::from_value::<ConversationKnowledgeEntry>(injected).is_err());
}

#[test]
fn registered_knowledge_planning_and_human_decisions_keep_original_authority_after_reopen() {
    let (directory, store, rows) = fixture::source_fixture();
    let project_id = store.metadata().unwrap().project_id().to_string();
    let unit = rows[0].unit_id.unwrap();
    store.close().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
        .build().unwrap();
    let locator = directory.path().join("project");
    let project = call(&window, "open_project", json!({"locator":locator}));
    assert!(runtime_absent(&app, &project));
    let thread = call(&window, "create_project_conversation", in_session(&project,
        json!({"actionId":identity(),"conversationId":identity(),"title":"Knowledge review"})));
    let message = call(&window, "append_project_conversation_message", in_session(&project,
        json!({"actionId":identity(),"conversationId":thread["conversationId"],"messageId":identity(),"body":"Suggest character, style and background notes for the selected entry."})));
    let entries: Vec<_> = ["character", "style", "background"].into_iter().map(|kind|
        json!({"kind":kind,"name":format!("Suggested {kind}"),"text":"Keep {{name}} — é 👩🏽‍💻","unitIds":[unit]})).collect();
    let content = json!({"kind":"knowledge-proposal","summary":"Knowledge suggestions for review","entries":entries,"questions":[]});
    let provider = PlanningProvider::with_content(content.clone());
    let config = tsumugi_core::ai::AiConfig { endpoint: provider.endpoint.clone(), model:"synthetic-knowledge-planner".into(),
        credential_env:String::new(), max_requests:1, ..Default::default() };
    let prepare = in_session(&project, json!({"conversationId":thread["conversationId"],"purpose":"knowledge",
        "selectedMessageIds":[message["messageId"]],"scope":{"kind":"units","locale":"zh-CN","unitIds":[unit]},"config":config}));
    let mut wrong_scope = prepare.clone();
    wrong_scope["scope"] = json!({"kind":"conversation-only"});
    assert!(!reject(&window,"prepare_conversation_planning",wrong_scope).is_null());
    let prepared = call(&window,"prepare_conversation_planning",prepare);
    assert_eq!(prepared["preview"]["version"],3);
    assert_eq!(prepared["preview"]["purpose"],"knowledge");
    assert_eq!(provider.count(),0);
    assert!(runtime_absent(&app,&project));
    let attempt = identity();
    let expires = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()+60_000;
    let start = in_session(&project,json!({"conversationId":thread["conversationId"],"preparationId":prepared["preparationId"],
        "consent":{"actionId":attempt,"attemptId":attempt,"taskId":identity(),"previewDigest":prepared["previewDigest"],
            "expiresAtMs":expires.to_string(),"shareMessages":true,"shareUnits":true}}));
    let mut unapproved = start.clone();
    unapproved["consent"]["shareUnits"] = false.into();
    assert!(!reject(&window,"start_conversation_planning",unapproved).is_null());
    assert_eq!(provider.count(),0);
    let started = call(&window,"start_conversation_planning",start.clone());
    assert_eq!(call(&window,"start_conversation_planning",start),started);
    let deadline = std::time::Instant::now()+std::time::Duration::from_secs(8);
    let completed = loop {
        let view = call(&window,"read_conversation_planning",in_session(&project,
            json!({"conversationId":thread["conversationId"],"attemptId":attempt})));
        if view["output"].is_object(){ break view; }
        assert!(std::time::Instant::now()<deadline,"knowledge planning did not finish: {view}");
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(completed["output"]["model"],content);
    assert_eq!(provider.count(),1);
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests[0]["messages"][0]["content"],prepared["preview"]["system"]);
        assert_eq!(requests[0]["messages"][1]["content"],prepared["preview"]["input"]);
        assert!(requests[0].get("material").is_none());
    }
    let captured = call(&window,"capture_conversation_proposal",in_session(&project,
        json!({"actionId":identity(),"conversationId":thread["conversationId"],"proposalId":identity(),"revisionId":identity(),
            "attemptId":attempt,"resultId":completed["resultId"]})));
    let reference = json!({"projectId":project_id,"conversationId":thread["conversationId"],
        "proposalId":captured["proposalId"],"revisionId":captured["revisionId"]});
    let inbox = in_session(&project,json!({"query":{"locale":"zh-CN","sources":["resource-proposal"]},"cursor":null,"limit":100,"activity":null}));
    let page = call(&window,"read_decision_page",inbox.clone());
    assert_eq!(page["items"].as_array().unwrap().len(),3);
    for item in page["items"].as_array().unwrap() {
        assert!(item["decisionId"].as_str().unwrap().starts_with("resource-proposal:knowledge:"));
        assert_eq!(item["action"]["kind"],"review-knowledge-proposal");
        assert_eq!(item["action"]["proposal"],reference);
    }
    let comparison = json!({"proposal":reference,"entryIndex":0,"contextId":null,"scope":{"kind":"unit","unitId":unit}});
    let preview_request = in_session(&project,json!({"adoption":comparison}));
    let before_read = planning_clock(&app,&project);
    let preview = call(&window,"preview_conversation_knowledge_adoption",preview_request.clone());
    assert_eq!(planning_clock(&app,&project),before_read);
    assert_eq!(preview["requiresWiderConfirmation"],false);
    assert!(preview["current"].is_null());
    assert_eq!(preview["entry"],content["entries"][0]);
    let mut foreign = preview_request.clone();
    foreign["adoption"]["proposal"]["projectId"] = json!(identity());
    assert!(!reject(&window,"preview_conversation_knowledge_adoption",foreign).is_null());
    let action = identity();
    let decision = json!({"actionId":action,"proposal":reference,"entryIndex":0,"decision":"adopt","actor":"Human reviewer",
        "reason":"Compared with the selected source","adoption":{"contextId":null,"expectedRevisionId":null,
            "scope":preview["scope"],"sourceBasis":preview["sourceBasis"],"name":"Reviewed character",
            "text":"Human edited {{name}} — é 👩🏽‍💻","comparisonBasis":preview["basis"],"confirmWiderScope":false}});
    let decision_request = in_session(&project,json!({"decision":decision}));
    let before_lookup = planning_clock(&app,&project);
    assert!(call(&window,"read_conversation_knowledge_decision_action",decision_request.clone()).is_null());
    assert_eq!(planning_clock(&app,&project),before_lookup);
    let pending = call(&window,"recover_conversation_knowledge_decision",decision_request.clone());
    assert_eq!(pending["request"],decision);
    assert_eq!(pending["outcome"],json!({"kind":"pending","replay":"explicit-same-request"}));
    let mut stale = decision_request.clone();
    stale["decision"]["actionId"] = json!(identity());
    stale["decision"]["adoption"]["comparisonBasis"] = json!("0".repeat(64));
    assert!(!reject(&window,"decide_conversation_knowledge_proposal",stale).is_null());
    let receipt = call(&window,"decide_conversation_knowledge_proposal",decision_request.clone());
    assert_eq!(call(&window,"decide_conversation_knowledge_proposal",decision_request.clone()),receipt);
    assert_eq!(receipt["actor"],decision["actor"]);
    assert_eq!(receipt["reason"],decision["reason"]);
    assert_eq!(receipt["resource"]["text"],decision["adoption"]["text"]);
    assert_eq!(receipt["resource"]["proposalOrigin"]["proposal"],reference);
    assert_eq!(receipt["resource"]["proposalOrigin"]["modelOrigin"],captured["origin"]);
    let mut saved = vec![(decision_request,receipt)];
    for (index,kind) in [(1,"keep"),(2,"reject")] {
        let request = in_session(&project,json!({"decision":{"actionId":identity(),"proposal":reference,"entryIndex":index,
            "decision":kind,"actor":"Human reviewer","reason":format!("Reviewed {kind}"),"adoption":null}}));
        let receipt = call(&window,"decide_conversation_knowledge_proposal",request.clone());
        assert!(receipt["resource"].is_null());
        saved.push((request,receipt));
    }
    assert_eq!(call(&window,"read_decision_page",inbox)["items"],json!([]));
    assert_eq!(provider.count(),1);
    call(&window,"close_project",json!({"sessionToken":project["sessionToken"]}));
    let reopened = call(&window,"open_project",json!({"locator":locator}));
    assert!(runtime_absent(&app,&reopened));
    let reopened_clock = planning_clock(&app,&reopened);
    for (old_request,receipt) in &saved {
        let mut request = old_request.clone(); request["sessionToken"] = reopened["sessionToken"].clone();
        assert_eq!(call(&window,"read_conversation_knowledge_decision_action",request.clone()),*receipt);
        assert_eq!(call(&window,"read_conversation_knowledge_decision",in_session(&reopened,
            json!({"proposal":reference,"entryIndex":receipt["entryIndex"]}))),*receipt);
        assert_eq!(planning_clock(&app,&reopened),reopened_clock);
        assert_eq!(call(&window,"recover_conversation_knowledge_decision",request)["outcome"],json!({"kind":"recorded","receipt":receipt}));
    }
    let causal = call(&window,"read_context_resource_action",in_session(&reopened,json!({"actionId":action})));
    assert_eq!(causal["request"]["kind"],"proposal-adoption");
    assert_eq!(causal["request"]["request"]["proposal"],reference);
    assert_eq!(causal["receipt"],saved[0].1["resource"]);
    assert!(!reject(&window,"reconcile_context_resource_action",in_session(&reopened,json!({"action":causal["request"]}))).is_null());
    assert_eq!(provider.count(),1);
    assert!(runtime_absent(&app,&reopened));
    call(&window,"close_project",json!({"sessionToken":reopened["sessionToken"]}));
}
