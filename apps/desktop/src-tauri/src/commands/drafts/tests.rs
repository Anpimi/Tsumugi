use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::{SaveTranslationRevision, execution::Revision};

#[allow(dead_code)]
#[path = "../../../../../../crates/core/tests/support/mod.rs"]
mod source_fixture;

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn draft_wire_fixture_binds_complete_input_without_session_credentials() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/draftCommands.contract.json"
    ))
    .unwrap();
    fn round_trip<T: serde::de::DeserializeOwned + Serialize>(value: &Value) {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<T>(value.clone()).unwrap()).unwrap(),
            *value
        );
    }
    round_trip::<DraftReadRequest>(&fixture["requests"]["read"]);
    round_trip::<DraftWriteRequest>(&fixture["requests"]["write"]);
    round_trip::<DraftClearRequest>(&fixture["requests"]["clear"]);
    round_trip::<DraftListRequest>(&fixture["requests"]["list"]);
    round_trip::<DraftReadView>(&fixture["responses"]["read"]);
    round_trip::<DraftHead>(&fixture["responses"]["written"]);
    round_trip::<DraftHead>(&fixture["responses"]["cleared"]);
    round_trip::<DraftPage>(&fixture["responses"]["page"]);
    let mut credential = fixture["requests"]["write"].clone();
    credential["write"]["value"]["pending"]["request"]["sessionToken"] = json!("forged");
    assert!(serde_json::from_value::<DraftWriteRequest>(credential).is_err());
    let mut rounded = fixture["responses"]["written"].clone();
    rounded["value"]["editSeq"] = json!(9_007_199_254_740_993u64);
    assert!(serde_json::from_value::<DraftHead>(rounded).is_err());
}

#[test]
fn local_draft_ipc_preserves_input_across_real_confirmation_and_project_reopen() {
    let (source_directory, core, rows) = source_fixture::source_fixture();
    let project = core.metadata().unwrap().project_id();
    let key = DraftKey {
        project_id: ExecutionId::parse(&project.to_string()).unwrap(),
        unit_id: rows[0].unit_id.unwrap(),
        locale: "zh-CN".into(),
    };
    let basis = DraftBasis {
        source_revision_id: rows[0].source_revision_id.unwrap(),
        selection_id: None,
        revision_id: None,
        text: None,
    };
    let revision_count = core
        .translation_history(key.project_id, key.unit_id, &key.locale, 0, 1)
        .unwrap()
        .total;
    core.close().unwrap();
    let application = tempfile::tempdir().unwrap();
    let journal_directory = application.path().join("drafts");
    let state = AppState::default();
    state
        .local_drafts
        .set(DraftStore::at(&journal_directory).unwrap())
        .ok()
        .unwrap();
    // This test uses the production handler and a private app-data owner. It
    // does not run desktop setup against the developer's application directory.
    let app = tauri::test::mock_builder()
        .manage(state)
        .invoke_handler(super::super::execution::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let project_path = source_directory.path().join("project");
    let opened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let token = opened["sessionToken"].clone();
    let read = json!({"sessionToken":token,"key":key});
    let empty = call(&window, "read_local_draft", read.clone()).unwrap();
    assert_eq!(empty["head"]["revision"], "0");
    assert_eq!(empty["head"]["value"], Value::Null);
    assert_eq!(
        empty["current"]["basis"],
        serde_json::to_value(&basis).unwrap()
    );
    let listed = call(
        &window,
        "list_local_drafts",
        json!({"sessionToken":token,"projectId":key.project_id,"after":null,"limit":50}),
    )
    .unwrap();
    assert_eq!(listed, json!({"items":[],"next":null}));
    assert!(!journal_directory.exists());
    assert!(
        app.state::<AppState>().sessions.with(|sessions| sessions
            .active
            .as_ref()
            .unwrap()
            .execution
            .is_none())
    );

    let original = SaveTranslationRevision {
        project_id: key.project_id,
        action_id: ExecutionId::new(),
        unit_id: key.unit_id,
        locale: key.locale.clone(),
        source_revision_id: basis.source_revision_id,
        expected_selection_id: None,
        text: "Original A 👩🏽‍💻\ne\u{301}".into(),
    };
    let writer = ExecutionId::new();
    let mut value = DraftValue {
        basis: basis.clone(),
        text: original.text.clone(),
        edit_seq: Revision::new(1).unwrap(),
        pending: None,
    };
    let write = |version: &str, value: &DraftValue| json!({"sessionToken":token,"write":{"key":key,"expectedRevision":version,"writerId":writer,"value":value}});
    assert_eq!(
        call(&window, "write_local_draft", write("0", &value)).unwrap()["revision"],
        "1"
    );
    value.pending = Some(DraftPending::Save {
        request: original.clone(),
        submitted_seq: Revision::new(1).unwrap(),
    });
    assert_eq!(
        call(&window, "write_local_draft", write("1", &value)).unwrap()["revision"],
        "2"
    );
    value.text = "Newer B — kept locally".into();
    value.edit_seq = Revision::new(2).unwrap();
    assert_eq!(
        call(&window, "write_local_draft", write("2", &value)).unwrap()["revision"],
        "3"
    );
    let before = app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(active.execution.is_none());
        assert_eq!(
            active
                .store
                .translation_history(key.project_id, key.unit_id, "zh-CN", 0, 1)
                .unwrap()
                .total,
            revision_count
        );
        active
            .store
            .changes_since(Revision::new(0).unwrap())
            .sequence
    });
    let saved_input = call(&window, "read_local_draft", read.clone()).unwrap();
    assert_eq!(
        saved_input["head"]["value"],
        serde_json::to_value(&value).unwrap()
    );
    let mut save = serde_json::to_value(&original).unwrap();
    save["sessionToken"] = token.clone();
    let receipt = call(&window, "save_translation_revision", save.clone()).unwrap();
    let retained = call(&window, "read_local_draft", read.clone()).unwrap();
    assert_eq!(retained["head"]["value"]["text"], "Newer B — kept locally");
    assert_eq!(
        retained["current"]["basis"]["selectionId"],
        receipt["selection"]["eventId"]
    );
    let after = app.state::<AppState>().sessions.with(move |sessions| {
        sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .changes_since(before)
            .sequence
    });
    assert!(after > before);
    assert_eq!(
        call(
            &window,
            "clear_local_draft",
            json!({"sessionToken":token,"clear":{"key":key,"expectedRevision":"3"}})
        )
        .unwrap_err()["code"],
        "dependency-conflict"
    );

    for field in ["sessionToken", "projectId", "unitId"] {
        let mut foreign = read.clone();
        if field == "sessionToken" {
            foreign[field] = json!("retired-session");
        } else {
            foreign["key"][field] = json!(ExecutionId::new());
        }
        assert!(call(&window, "read_local_draft", foreign).is_err());
    }
    let mut credentials = write("3", &value);
    credentials["write"]["value"]["pending"]["request"]["sessionToken"] = token.clone();
    assert!(call(&window, "write_local_draft", credentials).is_err());
    assert_eq!(
        call(&window, "write_local_draft", write("2", &value)).unwrap()["revision"],
        "3"
    );
    call(&window, "close_project", json!({"sessionToken":token})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    assert!(call(&window, "read_local_draft", read).is_err());
    let restored = call(
        &window,
        "read_local_draft",
        json!({"sessionToken":reopened["sessionToken"],"key":key}),
    )
    .unwrap();
    assert_eq!(
        restored["head"]["value"],
        serde_json::to_value(&value).unwrap()
    );
    save["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(
        call(&window, "recover_translation_save", save).unwrap()["outcome"],
        json!({"kind":"recorded","receipt":receipt})
    );
    assert!(
        app.state::<AppState>().sessions.with(|sessions| sessions
            .active
            .as_ref()
            .unwrap()
            .execution
            .is_none())
    );
    value.basis = serde_json::from_value(restored["current"]["basis"].clone()).unwrap();
    value.pending = None;
    let settled = call(&window, "write_local_draft", json!({"sessionToken":reopened["sessionToken"],"write":{"key":key,"expectedRevision":"3","writerId":writer,"value":value}})).unwrap();
    assert_eq!(settled["revision"], "4");
    assert_eq!(settled["value"]["text"], "Newer B — kept locally");
    assert_eq!(call(&window, "clear_local_draft", json!({"sessionToken":reopened["sessionToken"],"clear":{"key":key,"expectedRevision":"3"}})).unwrap_err()["code"], "dependency-conflict");
    let cleared = call(
        &window,
        "clear_local_draft",
        json!({"sessionToken":reopened["sessionToken"],"clear":{"key":key,"expectedRevision":"4"}}),
    )
    .unwrap();
    assert_eq!(cleared["revision"], "5");
    assert_eq!(cleared["value"], Value::Null);
    let clock = app.state::<AppState>().sessions.with(|sessions| {
        sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .changes_since(Revision::new(0).unwrap())
            .sequence
    });
    let final_list = call(&window, "list_local_drafts", json!({"sessionToken":reopened["sessionToken"],"projectId":key.project_id,"after":null,"limit":50})).unwrap();
    assert_eq!(final_list["items"], json!([]));
    assert_eq!(
        app.state::<AppState>().sessions.with(|sessions| sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .changes_since(Revision::new(0).unwrap())
            .sequence),
        clock
    );
}
