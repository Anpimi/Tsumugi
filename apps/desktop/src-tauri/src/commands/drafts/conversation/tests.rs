use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::{
    ProjectMetadata,
    application::{AppendProjectConversationMessage, CreateProjectConversation},
    execution::Revision,
};

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
fn conversation_journal_ipc_keeps_create_append_and_newer_input_without_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("project");
    let core = ProjectStore::create(
        &path,
        ProjectMetadata::create("Conversation draft", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    core.close().unwrap();
    let application = tempfile::tempdir().unwrap();
    let journal = application.path().join("drafts");
    let state = AppState::default();
    state
        .local_drafts
        .set(DraftStore::at(&journal).unwrap())
        .ok()
        .unwrap();
    let app = tauri::test::mock_builder()
        .manage(state)
        .invoke_handler(super::super::super::execution::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let opened = call(&window, "open_project", json!({"locator":path})).unwrap();
    let token = opened["sessionToken"].clone();
    let key = ConversationDraftKey {
        project_id: project,
        conversation_id: ExecutionId::new(),
    };
    assert_eq!(
        call(
            &window,
            "read_local_conversation_draft",
            json!({"sessionToken":token,"key":key})
        )
        .unwrap()["revision"],
        "0"
    );
    assert!(!journal.exists());
    let create = CreateProjectConversation {
        project_id: project,
        conversation_id: key.conversation_id,
        action_id: ExecutionId::new(),
        title: None,
    };
    let pending = ConversationDraftPending::Create {
        request: create.clone(),
        submitted_seq: Revision::new(1).unwrap(),
    };
    let mut write = ConversationDraftWrite {
        key: key.clone(),
        expected_revision: Revision::new(0).unwrap(),
        writer_id: ExecutionId::new(),
        value: ConversationDraftValue {
            text: "Composer retained while creating".into(),
            edit_seq: Revision::new(1).unwrap(),
            message_edit_seq: None,
            pending: Some(pending.clone()),
            revocations: vec![],
            proposal_edits: vec![],
            team_drafts: vec![],
        },
    };
    let written = call(
        &window,
        "write_local_conversation_draft",
        json!({"sessionToken":token,"write":write}),
    )
    .unwrap();
    write.expected_revision = serde_json::from_value(written["revision"].clone()).unwrap();
    write.value.pending = None;
    write.value.edit_seq = Revision::new(2).unwrap();
    let resolve = ConversationDraftResolve {
        write: write.clone(),
        target: ConversationDraftResolveTarget::Pending { pending: pending.clone() },
        disposition: ConversationDraftDisposition::Recorded,
    };
    assert!(
        call(
            &window,
            "resolve_local_conversation_draft",
            json!({"sessionToken":token,"resolve":resolve})
        )
        .is_err(),
        "no original receipt means no pending removal"
    );
    let mut request = serde_json::to_value(&create).unwrap();
    request["sessionToken"] = token.clone();
    call(&window, "create_project_conversation", request).unwrap();
    let resolved = call(
        &window,
        "resolve_local_conversation_draft",
        json!({"sessionToken":token,"resolve":resolve}),
    )
    .unwrap();
    assert_eq!(
        call(
            &window,
            "resolve_local_conversation_draft",
            json!({"sessionToken":token,"resolve":resolve})
        )
        .unwrap(),
        resolved
    );
    let append = AppendProjectConversationMessage {
        project_id: project,
        conversation_id: key.conversation_id,
        action_id: ExecutionId::new(),
        message_id: ExecutionId::new(),
        body: "  Sent A 👩🏽‍💻  ".into(),
    };
    write.expected_revision = serde_json::from_value(resolved["revision"].clone()).unwrap();
    write.value.text = append.body.clone();
    write.value.edit_seq = Revision::new(3).unwrap();
    write.value.pending = Some(ConversationDraftPending::Append {
        request: append.clone(),
        submitted_seq: Revision::new(3).unwrap(),
    });
    let written = call(
        &window,
        "write_local_conversation_draft",
        json!({"sessionToken":token,"write":write}),
    )
    .unwrap();
    write.expected_revision = serde_json::from_value(written["revision"].clone()).unwrap();
    write.value.text = "Newer B that must survive A".into();
    write.value.edit_seq = Revision::new(4).unwrap();
    let written = call(
        &window,
        "write_local_conversation_draft",
        json!({"sessionToken":token,"write":write}),
    )
    .unwrap();
    let mut request = serde_json::to_value(&append).unwrap();
    request["sessionToken"] = token.clone();
    call(&window, "append_project_conversation_message", request).unwrap();
    call(&window, "close_project", json!({"sessionToken":token})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator":path})).unwrap();
    let new_token = reopened["sessionToken"].clone();
    assert_ne!(new_token, token);
    let saved = call(
        &window,
        "read_local_conversation_draft",
        json!({"sessionToken":new_token,"key":key}),
    )
    .unwrap();
    assert_eq!(saved, written);
    let pending = write.value.pending.take().unwrap();
    write.expected_revision = serde_json::from_value(saved["revision"].clone()).unwrap();
    write.value.edit_seq = Revision::new(5).unwrap();
    let resolve = ConversationDraftResolve {
        write: write.clone(),
        target: ConversationDraftResolveTarget::Pending { pending },
        disposition: ConversationDraftDisposition::Recorded,
    };
    let settled = call(
        &window,
        "resolve_local_conversation_draft",
        json!({"sessionToken":new_token,"resolve":resolve}),
    )
    .unwrap();
    assert_eq!(settled["value"]["text"], write.value.text);
    assert_eq!(settled["value"]["pending"], Value::Null);
    assert!(
        app.state::<AppState>().sessions.with(|sessions| sessions
            .active
            .as_ref()
            .unwrap()
            .execution
            .is_none())
    );
    let mut wrong = write.clone();
    wrong.key.project_id = ExecutionId::new();
    assert!(
        call(
            &window,
            "write_local_conversation_draft",
            json!({"sessionToken":new_token,"write":wrong})
        )
        .is_err()
    );
    let mut injected = serde_json::to_value(&resolve).unwrap();
    injected["target"]["pending"]["request"]["sessionToken"] = json!("not-allowed");
    assert!(serde_json::from_value::<ConversationDraftResolve>(injected).is_err());

    let plan_id = ExecutionId::new(); let member_id = ExecutionId::new(); let unit_id = ExecutionId::new();
    let pending: ConversationDraftPending = serde_json::from_value(json!({"kind":"team-message","conversationId":key.conversation_id,
        "targetName":"Saved entry name", "destination":{"name":"Saved member","role":"Read original reasons", "endpoint":"http://127.0.0.1:9/v1/chat/completions","model":"synthetic-model"},
        "request":{"projectId":project,"lease":{"planId":plan_id,"generation":"1"},"message":{"messageId":ExecutionId::new(),
            "recipientMemberId":member_id,"expectedRecipientRoleVersionId":ExecutionId::new(),"target":{"unitId":unit_id,"locale":"zh-CN",
                "sourceSnapshotId":ExecutionId::new(),"sourceRevisionId":ExecutionId::new()},"body":"Original team A"}},"submittedSeq":"6"})).unwrap();
    write.expected_revision = serde_json::from_value(settled["revision"].clone()).unwrap();
    write.value.edit_seq = Revision::new(6).unwrap(); write.value.pending = Some(pending.clone());
    write.value.team_drafts = vec![ConversationTeamDraft { plan_id, plan_digest: "a".repeat(64),
        guidance: Some(ConversationTeamGuidanceDraft { edit_seq: Revision::new(6).unwrap(), member_id: Some(member_id), unit_id: Some(unit_id), body: "Original team A".into() }), publication: None }];
    let retained = call(&window, "write_local_conversation_draft", json!({"sessionToken":new_token,"write":write})).unwrap();
    for disposition in [ConversationDraftDisposition::Recorded, ConversationDraftDisposition::FencedNotApplied] {
        let mut next = write.clone(); next.expected_revision = serde_json::from_value(retained["revision"].clone()).unwrap();
        next.value.edit_seq = Revision::new(7).unwrap(); next.value.pending = None;
        if disposition == ConversationDraftDisposition::Recorded {
            let input = next.value.team_drafts[0].guidance.as_mut().unwrap(); input.body.clear(); input.edit_seq = Revision::new(7).unwrap();
        }
        let resolve = ConversationDraftResolve { write: next, target: ConversationDraftResolveTarget::Pending { pending: pending.clone() }, disposition };
        assert!(call(&window, "resolve_local_conversation_draft", json!({"sessionToken":new_token,"resolve":resolve})).is_err(),
            "a plan without the original conversation link cannot settle this input");
        assert_eq!(call(&window, "read_local_conversation_draft", json!({"sessionToken":new_token,"key":key})).unwrap(), retained);
    }
    assert!(app.state::<AppState>().sessions.with(|sessions| sessions.active.as_ref().unwrap().execution.is_none()));
}
