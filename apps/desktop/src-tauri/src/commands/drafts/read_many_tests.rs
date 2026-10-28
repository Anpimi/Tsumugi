use super::*;
use serde_json::{Value,json};
use tauri::{Manager,ipc::{CallbackFn,InvokeBody},webview::InvokeRequest};
use tsumugi_core::{SaveTranslationRevision,execution::Revision};
#[allow(dead_code)]
#[path = "../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;

fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value,Value> {
    tauri::test::get_ipc_response(window,InvokeRequest { cmd:command.into(),callback:CallbackFn(0),error:CallbackFn(1),
        url:crate::ipc_test_url().parse().unwrap(),body:InvokeBody::Json(json!({"request":request})),headers:Default::default(),invoke_key:tauri::test::INVOKE_KEY.into() })
        .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn draft_read_many_ipc_keeps_full_pending_heads_and_bounded_current_member_order() {
    let (directory,mut core,rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    core.save_translation_revision(&SaveTranslationRevision { reuse_origin: None, project_id:project,action_id:ExecutionId::new(),unit_id:rows[0].unit_id.unwrap(),locale:"zh-CN".into(),
        source_revision_id:rows[0].source_revision_id.unwrap(),expected_selection_id:None,text:String::new() }).unwrap();
    core.close().unwrap();
    let application = tempfile::tempdir().unwrap(); let journal = application.path().join("drafts");
    let state = AppState::default(); state.local_drafts.set(DraftStore::at(&journal).unwrap()).ok().unwrap();
    let app = tauri::test::mock_builder().manage(state).invoke_handler(super::super::execution::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app,"main",tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window,"open_project",json!({"locator":directory.path().join("project")})).unwrap();
    let token = opened["sessionToken"].clone();
    let units = [rows[1].unit_id.unwrap(),rows[0].unit_id.unwrap()];
    let request = json!({"sessionToken":token,"projectId":project,"locale":"zh-CN","unitIds":units});
    let initial = call(&window,"read_local_drafts",request.clone()).unwrap();
    assert!(!journal.exists(),"querying an absent journal never creates it");
    assert_eq!(initial["items"][0]["head"]["key"]["unitId"],json!(units[0]));
    assert_eq!(initial["items"][0]["current"]["basis"]["text"],Value::Null);
    assert_eq!(initial["items"][1]["current"]["basis"]["text"],"");
    let text = "界e\u{301}👩🏽‍💻".repeat(7000);
    for (index,unit) in units.iter().enumerate() {
        let basis: DraftBasis = serde_json::from_value(initial["items"][index]["current"]["basis"].clone()).unwrap();
        let pending = (index == 0).then(|| DraftPending::Save { request:SaveTranslationRevision { reuse_origin: None, project_id:project,action_id:ExecutionId::new(),unit_id:*unit,
            locale:"zh-CN".into(),source_revision_id:basis.source_revision_id,expected_selection_id:basis.selection_id,text:"Original A".into() },submitted_seq:Revision::new(1).unwrap() });
        let value = DraftValue { reuse_origin: None, basis,text:text.clone(),edit_seq:Revision::new(2).unwrap(),pending,merge:None };
        call(&window,"write_local_draft",json!({"sessionToken":token,"write":{"key":{"projectId":project,"unitId":unit,"locale":"zh-CN"},
            "expectedRevision":"0","writerId":ExecutionId::new(),"value":value}})).unwrap();
    }
    let prefix = call(&window,"read_local_drafts",request.clone()).unwrap();
    assert_eq!(prefix["nextAfter"],1); assert_eq!(prefix["items"].as_array().unwrap().len(),1);
    assert_eq!(prefix["items"][0]["head"]["value"]["text"],text);
    assert_eq!(prefix["items"][0]["head"]["value"]["pending"]["request"]["text"],"Original A");
    let mut rest = request.clone(); rest["unitIds"] = json!([units[1]]);
    let last = call(&window,"read_local_drafts",rest).unwrap(); assert_eq!(last["nextAfter"],Value::Null);
    assert_eq!(last["items"][0]["head"]["value"]["text"],text);
    for (field,value) in [("sessionToken",json!("stale")),("projectId",json!(ExecutionId::new())),("locale",json!("ZH-cn")),
        ("unitIds",json!([units[0],units[0]])),("unitIds",json!([])),("unitIds",json!([ExecutionId::new()])),("unitIds",json!(vec![ExecutionId::new();51]))] {
        let mut wrong = request.clone(); wrong[field] = value; assert!(call(&window,"read_local_drafts",wrong).is_err(),"{field}");
    }
    let single = call(&window,"read_local_draft",json!({"sessionToken":token,"key":{"projectId":project,"unitId":units[0],"locale":"zh-CN"}})).unwrap();
    assert_eq!(single,prefix["items"][0],"existing recovery representation stays unchanged");
    let mut head: DraftHead = serde_json::from_value(single["head"].clone()).unwrap();
    let before = head.revision;
    head.revision = Revision::new(2).unwrap();
    let value = head.value.as_mut().unwrap(); value.edit_seq = Revision::new(3).unwrap(); value.text.clear();
    let overhead = serde_json::to_vec(&head).unwrap().len();
    head.value.as_mut().unwrap().text = "x".repeat(store::MAX_DRAFT_RECORD_BYTES - overhead - 16);
    call(&window,"write_local_draft",json!({"sessionToken":token,"write":{"key":head.key,"expectedRevision":before,"writerId":head.writer_id,"value":head.value}})).unwrap();
    let mut one = request; one["unitIds"] = json!([units[0]]);
    assert!(call(&window,"read_local_drafts",one).is_err(),"a single full record is rejected rather than truncated");
    let kept = call(&window,"read_local_draft",json!({"sessionToken":token,"key":{"projectId":project,"unitId":units[0],"locale":"zh-CN"}})).unwrap();
    assert_eq!(kept["head"],serde_json::to_value(head).unwrap());
}
