use super::*;
use serde_json::{Value, json};
use tauri::{ipc::{CallbackFn, InvokeBody}, webview::InvokeRequest};
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/automatic.rs"]
mod automatic;

fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(window, InvokeRequest { cmd: command.into(), callback: CallbackFn(0), error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(), body: InvokeBody::Json(json!({"request": request})),
        headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into() })
        .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn decision_wire_fixture_preserves_missing_source_counts_and_typed_targets() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../../test/fixtures/decisionCommands.contract.json")).unwrap();
    let request: DecisionPageRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    let response: DecisionPage = serde_json::from_value(fixture["response"].clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), fixture["request"]);
    assert_eq!(serde_json::to_value(response).unwrap(), fixture["response"]);
}

#[test]
fn registered_decision_inbox_pages_original_facts_and_rechecks_after_owner_decisions() {
    let (directory, mut core, rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let candidate = automatic::candidate_request(&mut core, unit, "A candidate", tsumugi_core::application::SelectionPolicy::CandidatesOnly);
    core.save_translation_revision(&tsumugi_core::SaveTranslationRevision { project_id: project, action_id: ExecutionId::new(),
        unit_id: unit, locale: "zh-CN".into(), source_revision_id: rows[0].source_revision_id.unwrap(),
        expected_selection_id: None, text: "Saved translation".into() }).unwrap();
    core.close().unwrap();
    let app = tauri::test::mock_builder().manage(AppState::default()).invoke_handler(super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let request = json!({"sessionToken": opened["sessionToken"], "projectId": project,
        "query": {"locale": null, "sources": []}, "cursor": null, "limit": 1});
    let first = call(&window, "read_decision_page", request.clone()).unwrap();
    let repeated = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(first, repeated, "reading does not advance a source or resolve a request");
    assert_eq!(first["total"], Value::Null, "unconnected sources are not global zero");
    assert_eq!(first["coverage"].as_array().unwrap().len(), 9);
    assert_eq!(first["coverage"].as_array().unwrap().iter().filter(|source| source["state"] == "unavailable").count(), 2);
    let mut ids = Vec::new();
    let mut page = first.clone();
    loop {
        let decoded: DecisionPage = serde_json::from_value(page.clone()).unwrap();
        assert_eq!(decoded.project_id, project);
        ids.extend(decoded.items.into_iter().map(|item| item.decision_id));
        if page["next"].is_null() { break; }
        let mut next = request.clone(); next["cursor"] = page["next"].clone();
        page = call(&window, "read_decision_page", next).unwrap();
    }
    assert_eq!(ids.len(), first["knownCount"].as_u64().unwrap() as usize);
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(ids.iter().any(|id| id.contains(&candidate.revision_id.to_string())));
    let mut focused = request.clone(); focused["query"] = json!({"locale": "zh-CN", "sources": ["translation-candidate"]});
    let candidates = call(&window, "read_decision_page", focused.clone()).unwrap();
    assert_eq!(candidates["total"], 1);
    let target = call(&window, "read_review_target", json!({"sessionToken": opened["sessionToken"], "projectId": project,
        "unitId": unit, "locale": "zh-CN"})).unwrap();
    call(&window, "decide_translation_candidate", json!({"sessionToken": opened["sessionToken"], "projectId": project,
        "decision": {"projectId": project, "actionId": ExecutionId::new(), "unitId": unit, "locale": "zh-CN",
            "revisionId": candidate.revision_id, "sourceRevisionId": target["sourceRevisionId"],
            "expectedSelectionId": target["selectionId"], "expectedDecisionId": null, "disposition": "rejected",
            "actor": "Synthetic reviewer", "reason": "Use the saved translation"}})).unwrap();
    let mut stale = request.clone(); stale["cursor"] = first["next"].clone();
    assert!(call(&window, "read_decision_page", stale).is_err());
    let resolved = call(&window, "read_decision_page", focused).unwrap();
    assert_eq!(resolved["total"], 0);
    assert_eq!(resolved["items"], json!([]));
    for (field, value) in [("projectId", json!(ExecutionId::new())), ("sessionToken", json!("stale")),
        ("query", json!({"locale": "ZH-cn", "sources": []})), ("limit", json!(0))] {
        let mut wrong = request.clone(); wrong[field] = value;
        assert!(call(&window, "read_decision_page", wrong).is_err(), "{field}");
    }
    call(&window, "close_project", json!({"sessionToken": opened["sessionToken"], "projectId": project})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let mut after_reopen = request;
    after_reopen["sessionToken"] = reopened["sessionToken"].clone();
    after_reopen["query"] = json!({"locale": "zh-CN", "sources": ["translation-candidate"]});
    assert_eq!(call(&window, "read_decision_page", after_reopen).unwrap()["total"], 0);
}

#[test]
fn registered_local_inbox_checks_receipts_and_lifecycle_without_resolving_original_input() {
    use crate::commands::drafts::{ConversationDraftWrite, DraftStore, DraftWrite};
    let (directory, mut core, rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let action = ExecutionId::new();
    let original = tsumugi_core::SaveTranslationRevision { project_id: project, action_id: action, unit_id: unit,
        locale: "zh-CN".into(), source_revision_id: rows[0].source_revision_id.unwrap(), expected_selection_id: None, text: "Submitted A".into() };
    core.close().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let journal = DraftStore::at(profile.path().join("drafts")).unwrap();
    let writer = ExecutionId::new();
    let write: DraftWrite = serde_json::from_value(json!({"key":{"projectId":project,"unitId":unit,"locale":"zh-CN"},
        "expectedRevision":"0","writerId":writer,"value":{"basis":{"sourceRevisionId":original.source_revision_id,"selectionId":null,"revisionId":null,"text":null},
            "text":"Newer B","editSeq":"2","pending":{"kind":"save","request":original,"submittedSeq":"1"}}})).unwrap();
    let before = journal.write(&write).unwrap();
    let thread = ExecutionId::new();
    let create_action = ExecutionId::new();
    let conversation: ConversationDraftWrite = serde_json::from_value(json!({"key":{"projectId":project,"conversationId":thread},
        "expectedRevision":"0","writerId":writer,"value":{"text":"New message input","editSeq":"1","pending":{"kind":"create","submittedSeq":"1",
            "request":{"projectId":project,"actionId":create_action,"conversationId":thread,"title":"Synthetic thread"}}}})).unwrap();
    journal.write_conversation(&conversation).unwrap();
    let state = AppState::default(); state.local_drafts.set(journal.clone()).ok().unwrap();
    let app = tauri::test::mock_builder().manage(state).invoke_handler(super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window, "open_project", json!({"locator":directory.path().join("project")})).unwrap();
    let mut request = json!({"sessionToken":opened["sessionToken"],"projectId":project,
        "query":{"locale":null,"sources":["local-action-recovery"]},"cursor":null,"limit":100,"activity":null});
    let unobserved = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(unobserved["knownCount"], 0);
    assert_eq!(unobserved["total"], Value::Null);
    assert_eq!(unobserved["coverage"][0]["reason"], "lifecycle-unavailable");
    assert_eq!(unobserved["localActions"]["observations"].as_array().unwrap().len(), 2);
    request["activity"] = json!([{"ownerId":writer,"revision":"1","actions":[{"key":{"kind":"translation","unitId":unit,"locale":"zh-CN"},
        "slot":"primary","actionId":action,"submittedSeq":"1"}]}]);
    let running = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(running["total"], 1, "the live save is progress; the unowned conversation needs a check");
    assert_eq!(running["items"][0]["targets"][0]["kind"], "conversation");
    assert!(running["localActions"]["observations"].as_array().unwrap().iter().any(|row| row["outcome"] == "in-flight"));
    request["activity"] = json!([]);
    let unknown = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(unknown["total"], 2);
    let mut save = serde_json::to_value(&original).unwrap(); save["sessionToken"] = opened["sessionToken"].clone();
    call(&window, "save_translation_revision", save).unwrap();
    let recorded = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(recorded["total"], 1);
    assert!(recorded["localActions"]["observations"].as_array().unwrap().iter().any(|row| row["outcome"] == "recorded"));
    let after = journal.read(&write.key).unwrap();
    assert_eq!(after, before, "inbox reads leave B and the exact original pending request intact");
    let mut malformed = request.clone();
    malformed["activity"] = json!([{"ownerId":writer,"revision":"1","actions":[]},{"ownerId":writer,"revision":"2","actions":[]}]);
    assert!(call(&window, "read_decision_page", malformed).is_err());
}
