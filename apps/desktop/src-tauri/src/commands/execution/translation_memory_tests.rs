use super::*;
use serde_json::{Value, json};
use tauri::{Manager, ipc::{CallbackFn, InvokeBody}, webview::InvokeRequest};
#[allow(dead_code)]
#[path = "../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;

fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(window, InvokeRequest { cmd: command.into(), callback: CallbackFn(0), error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(), body: InvokeBody::Json(json!({"request":request})),
        headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into() })
        .map(|response| response.deserialize().unwrap())
}

#[test]
fn memory_wire_fixture_keeps_exact_origins_and_old_optional_encoding() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../test/fixtures/translationMemory.contract.json")).unwrap();
    macro_rules! round_trip { ($group:literal, $key:literal, $kind:ty) => {
        let value: $kind = serde_json::from_value(fixture[$group][$key].clone()).unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(),fixture[$group][$key],$key);
    }; }
    round_trip!("requests","page",TranslationMemoryPageRequest);
    round_trip!("requests","entry",TranslationMemoryEntryRequest);
    round_trip!("requests","reuse",TranslationMemoryReuseRequest);
    round_trip!("requests","save",crate::commands::execution::source::translation::TranslationSaveRequest);
    round_trip!("responses","page",TranslationMemoryPage);
    round_trip!("responses","entry",TranslationMemoryEntry);
    round_trip!("responses","reuse",TranslationMemoryReusePreview);
    round_trip!("responses","saved",tsumugi_core::TranslationSaveReceipt);
    round_trip!("responses","recovery",tsumugi_core::TranslationSaveRecovery);
    let draft: crate::commands::drafts::DraftValue = serde_json::from_value(fixture["draft"].clone()).unwrap();
    assert_eq!(serde_json::to_value(draft).unwrap(),fixture["draft"]);
    let mut original = fixture["responses"]["recovery"]["request"].clone();
    original.as_object_mut().unwrap().remove("reuseOrigin");
    let old: tsumugi_core::SaveTranslationRevision = serde_json::from_value(original.clone()).unwrap();
    assert!(old.reuse_origin.is_none());
    assert_eq!(serde_json::to_value(old).unwrap(),original);
}

#[test]
fn registered_memory_reuses_an_exact_historical_donor_and_reopens_pending_input_with_its_origin() {
    let (directory, mut store, rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let donor_unit = rows[0].unit_id.unwrap();
    let target = rows.iter().find(|row| row.unit_id != Some(donor_unit)).unwrap();
    let target_unit = target.unit_id.unwrap();
    let target_source = target.source_revision_id.unwrap();
    let mut selection = None;
    for number in 0..26 {
        let saved = store.save_translation_revision(&tsumugi_core::SaveTranslationRevision {
            project_id: project, action_id: ExecutionId::new(), unit_id: donor_unit, locale: "zh-CN".into(),
            source_revision_id: rows[0].source_revision_id.unwrap(), expected_selection_id: selection,
            text: format!("Memory {number}: {{{{name}}}} é 👩🏽‍💻"), reuse_origin: None,
        }).unwrap();
        selection = Some(saved.event_id);
    }
    let suggestions = store.tm_suggestions(project, target_unit, "zh-CN", 0, 20).unwrap();
    let filter = TranslationMemoryFilter { source_locale: "en".into(), target_locale: "zh-CN".into(),
        source_text: None, translation_text: None, origin: None, selection: tsumugi_core::TranslationMemorySelection::All };
    let complete = store.list_translation_memory(project, &filter, None, 100).unwrap();
    assert_eq!(complete.rows.len(), 26);
    let donor = complete.rows.iter().find(|entry| !suggestions.iter().any(|row| row.translation_revision_id == entry.revision.revision_id)).unwrap().clone();
    store.close().unwrap();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.state::<AppState>().local_drafts.set(crate::commands::drafts::DraftStore::at(directory.path().join("local-drafts")).unwrap()).ok().unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let locator = directory.path().join("project");
    let opened = call(&window,"open_project",json!({"locator":locator})).unwrap();
    let in_session = |fields: Value| { let mut request = json!({"sessionToken":opened["sessionToken"],"projectId":project});
        request.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone()); request };
    let clock = || app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().store
        .changes_since(Revision::new(0).unwrap()).sequence);
    let original_clock = clock();
    let page_request = in_session(json!({"filter":filter,"cursor":null,"limit":4}));
    let page = call(&window,"list_translation_memory",page_request.clone()).unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(),4);
    assert!(page["nextCursor"].is_string());
    assert_eq!(page["projectId"],json!(project));
    assert_eq!(page["filter"],serde_json::to_value(&filter).unwrap());
    let exact = in_session(json!({"unitId":donor_unit,"locale":"zh-CN","revisionId":donor.revision.revision_id}));
    assert_eq!(call(&window,"read_translation_memory_entry",exact.clone()).unwrap(),serde_json::to_value(&donor).unwrap());
    let reuse = json!({"projectId":project,"unitId":target_unit,"locale":"zh-CN","sourceRevisionId":target_source,
        "expectedSelectionId":null,"donorUnitId":donor_unit,"donorRevisionId":donor.revision.revision_id,"donorBasis":donor.basis});
    let preview = call(&window,"prepare_translation_memory_reuse",in_session(json!({"reuse":reuse}))).unwrap();
    assert_eq!(preview["donor"],serde_json::to_value(&donor).unwrap());
    assert_eq!(clock(),original_clock,"memory browsing and preparation have no project writes");
    assert!(app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().execution.is_none()));
    let mut foreign = reuse.clone(); foreign["projectId"] = json!(ExecutionId::new());
    assert_eq!(call(&window,"prepare_translation_memory_reuse",in_session(json!({"reuse":foreign}))).unwrap_err()["code"],"permission-denied");
    let action = ExecutionId::new();
    let original = json!({"projectId":project,"actionId":action,"unitId":target_unit,"locale":"zh-CN","sourceRevisionId":target_source,
        "expectedSelectionId":null,"text":"Reviewed A {{name}} é 👩🏽‍💻","reuseOrigin":preview["reuseOrigin"]});
    let key = json!({"projectId":project,"unitId":target_unit,"locale":"zh-CN"});
    let mut write = json!({"key":key,"expectedRevision":"0","writerId":ExecutionId::new(),"value":{
        "basis":{"sourceRevisionId":target_source,"selectionId":null,"revisionId":null,"text":null},
        "text":original["text"],"editSeq":"1","reuseOrigin":preview["reuseOrigin"],
        "pending":{"kind":"save","request":original,"submittedSeq":"1"}}});
    let first = call(&window,"write_local_draft",json!({"sessionToken":opened["sessionToken"],"write":write})).unwrap();
    write["expectedRevision"] = first["revision"].clone(); write["value"]["editSeq"] = json!("2");
    write["value"]["text"] = json!("Newer B remains local 人工输入");
    let retained = call(&window,"write_local_draft",json!({"sessionToken":opened["sessionToken"],"write":write})).unwrap();
    let save = in_session(original.clone());
    let receipt = call(&window,"save_translation_revision",save.clone()).unwrap();
    assert_eq!(call(&window,"save_translation_revision",save.clone()).unwrap(),receipt);
    assert_eq!(receipt["revision"]["originKind"],"manual");
    assert_eq!(receipt["revision"]["reuseOrigin"],preview["reuseOrigin"]);
    assert_eq!(call(&window,"read_translation_save_action",save.clone()).unwrap(),receipt);
    let read = json!({"sessionToken":opened["sessionToken"],"key":key});
    let view = call(&window,"read_local_draft",read).unwrap();
    assert_eq!(view["head"],retained);
    assert_eq!(view["current"]["reuseOrigin"],preview["reuseOrigin"]);
    assert_eq!(view["head"]["value"]["text"],"Newer B remains local 人工输入");
    assert_eq!(view["head"]["value"]["pending"]["request"],original);
    let mut old_page = page_request; old_page["cursor"] = page["nextCursor"].clone();
    assert_eq!(call(&window,"list_translation_memory",old_page).unwrap_err()["code"],"dependency-conflict");
    call(&window,"close_project",json!({"sessionToken":opened["sessionToken"]})).unwrap();
    let reopened = call(&window,"open_project",json!({"locator":locator})).unwrap();
    let current = call(&window,"read_local_draft",json!({"sessionToken":reopened["sessionToken"],"key":key})).unwrap();
    assert_eq!(current["head"],retained);
    assert_eq!(current["current"]["reuseOrigin"],preview["reuseOrigin"]);
    let mut recovered = save; recovered["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&window,"recover_translation_save",recovered).unwrap()["outcome"],json!({"kind":"recorded","receipt":receipt}));
    assert!(app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().execution.is_none()));
    call(&window,"close_project",json!({"sessionToken":reopened["sessionToken"]})).unwrap();
}
