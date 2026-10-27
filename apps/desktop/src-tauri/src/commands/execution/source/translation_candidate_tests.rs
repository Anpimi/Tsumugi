use super::*;
use serde_json::{Value,json};
use tauri::{Manager,ipc::{CallbackFn,InvokeBody},webview::InvokeRequest};
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/automatic.rs"]
mod automatic;

fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value,Value> {
    tauri::test::get_ipc_response(window,InvokeRequest { cmd:command.into(),callback:CallbackFn(0),error:CallbackFn(1),
        url:crate::ipc_test_url().parse().unwrap(),body:InvokeBody::Json(json!({"request":request})),headers:Default::default(),invoke_key:tauri::test::INVOKE_KEY.into() })
        .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn candidate_slice_wire_fixture_preserves_full_revisions_and_ordinal_continuations() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../../test/fixtures/translationCandidateSlice.contract.json")).unwrap();
    let request: TranslationCandidateSliceRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    let response: tsumugi_core::TranslationCandidateSlice = serde_json::from_value(fixture["response"].clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(),fixture["request"]);
    assert_eq!(serde_json::to_value(response).unwrap(),fixture["response"]);
    let draft: Value = serde_json::from_str(include_str!("../../../../../test/fixtures/draftCommands.contract.json")).unwrap();
    let request: crate::commands::drafts::DraftReadManyRequest = serde_json::from_value(draft["requests"]["readMany"].clone()).unwrap();
    let response: crate::commands::drafts::DraftReadMany = serde_json::from_value(draft["responses"]["readMany"].clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(),draft["requests"]["readMany"]);
    assert_eq!(serde_json::to_value(response).unwrap(),draft["responses"]["readMany"]);
}

#[test]
fn bounded_candidate_reads_ipc_keep_current_source_metadata_and_reject_foreign_or_changed_reads() {
    let (directory,mut core,rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let first = automatic::candidate_request(&mut core,unit,"",tsumugi_core::application::SelectionPolicy::CandidatesOnly);
    let text = "Candidate {{name}}\ne\u{301} 👩🏽‍💻 日本語 العربية";
    let second = automatic::candidate_request(&mut core,unit,text,tsumugi_core::application::SelectionPolicy::CandidatesOnly);
    core.save_translation_revision(&SaveTranslationRevision { project_id:project,action_id:ExecutionId::new(),unit_id:unit,locale:"zh-CN".into(),
        source_revision_id:rows[0].source_revision_id.unwrap(),expected_selection_id:None,text:String::new() }).unwrap();
    let snapshot = core.content_scope().unwrap().current_snapshot.unwrap();
    let expected = core.translation_revision(project,unit,"zh-CN",second.revision_id).unwrap();
    core.close().unwrap();
    let app = tauri::test::mock_builder().manage(AppState::default()).invoke_handler(super::super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app,"main",tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window,"open_project",json!({"locator":directory.path().join("project")})).unwrap();
    let token = opened["sessionToken"].clone();
    let request = json!({"sessionToken":token,"projectId":project,"locale":"zh-CN","sourceSnapshotId":snapshot,"scopeId":null,
        "unitIds":[unit,rows[1].unit_id.unwrap()],"state":"available","afterOrdinal":"0","readVersion":null});
    let page = call(&window,"read_translation_candidate_slice",request.clone()).unwrap();
    assert_eq!(page["rows"][0]["candidateCount"],2);
    assert_eq!(page["rows"][0]["selectedOriginKind"],"manual");
    assert_eq!(page["rows"][0]["target"]["translationText"],"");
    assert_eq!(page["rows"][0]["protection"]["protected"],true);
    assert_eq!(page["rows"][0]["revisions"][0]["revisionId"],json!(first.revision_id));
    assert_eq!(page["rows"][0]["revisions"][0]["text"],"");
    assert_eq!(page["rows"][0]["revisions"][1],serde_json::to_value(expected).unwrap());
    assert_eq!(page["rows"][1]["target"]["translationText"],Value::Null);
    for (field,value) in [("sessionToken",json!("stale")),("projectId",json!(ExecutionId::new())),("locale",json!("ZH-cn")),
        ("sourceSnapshotId",json!(ExecutionId::new())),("scopeId",json!(ExecutionId::new())),("unitIds",json!([unit,unit])),
        ("unitIds",json!([ExecutionId::new()])),("unitIds",json!([])),("unitIds",json!(vec![ExecutionId::new();51]))] {
        let mut wrong = request.clone(); wrong[field] = value; assert!(call(&window,"read_translation_candidate_slice",wrong).is_err(),"{field}");
    }
    let target = &page["rows"][0]["target"];
    let decision = json!({"sessionToken":token,"projectId":project,"decision":{"projectId":project,"actionId":ExecutionId::new(),"unitId":unit,"locale":"zh-CN",
        "revisionId":first.revision_id,"sourceRevisionId":target["sourceRevisionId"],"expectedSelectionId":target["selectionId"],"expectedDecisionId":null,
        "disposition":"rejected","actor":"Synthetic reviewer","reason":"Does not fit"}});
    call(&window,"decide_translation_candidate",decision).unwrap();
    let mut stale = request.clone(); stale["readVersion"] = page["readVersion"].clone();
    assert!(call(&window,"read_translation_candidate_slice",stale).is_err());
    let mut rejected = request.clone(); rejected["state"] = json!("rejected");
    let hidden = call(&window,"read_translation_candidate_slice",rejected).unwrap();
    assert_eq!(hidden["rows"][0]["candidateCount"],1);
    assert_eq!(hidden["rows"][0]["revisions"][0]["candidateDecision"]["request"]["disposition"],"rejected");
    let mut fresh = request; fresh["state"] = json!("available");
    assert_eq!(call(&window,"read_translation_candidate_slice",fresh).unwrap()["rows"][0]["candidateCount"],1);
}
