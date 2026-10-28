use super::*;
use crate::persistence::review::tests::{adopt_source, fixture, translate};
use crate::{
    ProjectMetadata, SaveContext, SaveTerm,
    ai::{AiConfig, provider},
    application::*,
};
use std::{fs, sync::atomic::Ordering};

fn config() -> AiConfig {
    AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-planning".into(),
        credential_env: String::new(),
        max_requests: 1,
        ..AiConfig::default()
    }
}
fn request(
    store: &ProjectStore,
    project: ExecutionId,
    units: &[ExecutionId],
) -> PrepareConversationPlanning {
    let conversation_id = ExecutionId::new();
    store
        .create_project_conversation(&CreateProjectConversation {
            project_id: project,
            action_id: ExecutionId::new(),
            conversation_id,
            title: None,
        })
        .unwrap();
    let message = append(
        store,
        project,
        conversation_id,
        "  Plan e\u{301} 👩🏽‍💻\r\n保留 {{name}}  ",
    );
    PrepareConversationPlanning {
        project_id: project,
        conversation_id,
        selected_message_ids: vec![message],
        scope: ConversationPlanningScope::Units {
            locale: "zh-CN".into(),
            unit_ids: units.into(),
        },
        config: config(),
    }
}
fn append(
    store: &ProjectStore,
    project: ExecutionId,
    conversation: ExecutionId,
    body: &str,
) -> ExecutionId {
    let id = ExecutionId::new();
    store
        .append_project_conversation_message(&AppendProjectConversationMessage {
            project_id: project,
            conversation_id: conversation,
            action_id: ExecutionId::new(),
            message_id: id,
            body: body.into(),
        })
        .unwrap();
    id
}
fn clock(store: &ProjectStore) -> (String, u64, u64) {
    let value = store.changes_since(Revision::new(0).unwrap());
    (
        value.epoch,
        value.sequence.get(),
        value.progress_sequence.get(),
    )
}
fn readonly<T>(store: &ProjectStore, operation: impl FnOnce() -> T) -> T {
    let path = store
        .directory()
        .join(crate::persistence::DATABASE_FILENAME);
    let before = fs::read(&path).unwrap();
    let version = clock(store);
    let writes = store.connection().unwrap().total_changes();
    let result = operation();
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    assert_eq!(clock(store), version);
    assert_eq!(fs::read(&path).unwrap(), before);
    result
}
fn context(store: &mut ProjectStore, project: ExecutionId, unit: ExecutionId, text: &str) {
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let prior = store.context_revision(project, unit, "zh-CN").unwrap();
    store
        .save_context(&SaveContext {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: target.source_revision_id,
            expected_revision_id: prior.map(|value| value.revision_id),
            text: text.into(),
            reason: "Local context edit".into(),
        })
        .unwrap();
}
fn term(store: &mut ProjectStore, project: ExecutionId, unit: ExecutionId, text: &str) {
    store
        .save_term(&SaveTerm {
            project_id: project,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "Hello".into(),
            aliases: Vec::new(),
            target: text.into(),
            protected: true,
            scope_unit_id: Some(unit),
            expected_revision_id: None,
            reason: "Explicit local terminology".into(),
        })
        .unwrap();
}

#[test]
fn complete_original_material_and_actual_share_brief_use_one_readonly_capture() {
    let (_temp, mut store, project, _) = fixture();
    adopt_source(
        &mut store,
        "{\"hello\":\"Hello é 👩🏽‍💻 {{name}}\",\"plain\":\"Plain\"}".as_bytes(),
    );
    let units: Vec<_> = store
        .review_page(project, "zh-CN", 0, 10)
        .unwrap()
        .rows
        .iter()
        .map(|row| row.unit_id)
        .collect();
    context(&mut store, project, units[0], "  Manual 语境\n{{name}}  ");
    term(&mut store, project, units[0], "你好");
    let mut req = request(&store, project, &units[..1]);
    let second = append(
        &store,
        project,
        req.conversation_id,
        "Second original question",
    );
    append(
        &store,
        project,
        req.conversation_id,
        "UNSELECTED PRIVATE MESSAGE",
    );
    req.selected_message_ids.insert(0, second);
    req.config.share_terms = true;
    req.config.share_context = true;
    req.config.source_context.neighbors = true;
    let capture = readonly(&store, || {
        store.prepare_conversation_planning(&req).unwrap()
    });
    readonly(&store, || {
        store.validate_conversation_planning(&capture).unwrap()
    });
    let view = capture.preview();
    assert_eq!(view.selected_messages[0].ordinal.get(), 1);
    assert_eq!(view.selected_messages[1].message_id, second);
    let input: serde_json::Value = serde_json::from_str(&view.input).unwrap();
    assert_eq!(input["messages"][0]["body"], view.selected_messages[0].body);
    assert_eq!(input["units"][0]["sourceText"], "Hello é 👩🏽‍💻 {{name}}");
    assert_eq!(input["units"][0]["context"], "  Manual 语境\n{{name}}  ");
    assert_eq!(input["units"][0]["terms"][0]["target"], "你好");
    assert!(!view.input.contains("UNSELECTED PRIVATE MESSAGE"));
    for excluded in [
        "sourceRevisionId",
        "sourceSnapshotId",
        "resourceBaseline",
        "digest",
        "basis",
        "reason",
        "omissions",
        "revisionId",
        "conversationId",
        "projectId",
    ] {
        assert!(
            !view.input.contains(excluded),
            "unexpected local field {excluded}"
        );
    }
    assert_eq!(view.brief.messages, 2);
    assert_eq!(view.brief.units, 1);
    assert_eq!(view.brief.source_texts, 1);
    assert_eq!(
        view.brief.terms,
        input["units"][0]["terms"].as_array().unwrap().len() as u32
    );
    assert_eq!(view.brief.manual_contexts, 1);
    assert_eq!(
        view.brief.source_context_neighbors,
        input["units"][0]["sourceContext"]["neighbors"]
            .as_array()
            .unwrap()
            .len() as u32
    );
    assert!(view.brief.source_context_neighbors > 0);
    assert_eq!(
        view.byte_length as usize,
        serde_json::to_vec(&serde_json::json!({"system":view.system,"input":view.input}))
            .unwrap()
            .len()
    );
    assert!(view.byte_length <= 32768);
    assert_eq!(
        capture.ai_preview.as_ref().unwrap().items[0].resource_baseline,
        store
            .connection()
            .unwrap()
            .query_row(
                "SELECT COALESCE(MAX(rowid),0) FROM resource_changes",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap() as u64
    );
    let roundtrip: ConversationPlanningPreview =
        serde_json::from_slice(&serde_json::to_vec(view).unwrap()).unwrap();
    assert_eq!(&roundtrip, view);
}

#[test]
fn conversation_only_needs_no_source_or_fake_unit_and_subscription_keeps_zero_output_tokens() {
    let temp = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(
        temp.path().join("project"),
        ProjectMetadata::create("Only conversation", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut req = request(&store, project, &[]);
    req.scope = ConversationPlanningScope::ConversationOnly {};
    req.config.chatgpt_account = Some(ExecutionId::new());
    req.config.endpoint = provider::CHATGPT_RESPONSES_ENDPOINT.into();
    req.config.token_field = "chatgpt_subscription".into();
    req.config.max_output_tokens = 0;
    req.config.share_context = true;
    req.config.share_terms = true;
    let capture = readonly(&store, || {
        store.prepare_conversation_planning(&req).unwrap()
    });
    assert!(capture.ai_preview.is_none());
    assert!(capture.preview().units.is_empty());
    assert_eq!(capture.preview().config.max_output_tokens, 0);
    assert_eq!(
        capture.preview().brief,
        ConversationPlanningBrief {
            messages: 1,
            ..Default::default()
        }
    );
    readonly(&store, || {
        store.validate_conversation_planning(&capture).unwrap()
    });
}

#[test]
fn malformed_project_thread_messages_locale_scope_and_configuration_are_rejected_without_writes() {
    let (_temp, store, project, units) = fixture();
    let base = request(&store, project, &units[..1]);
    let other = request(&store, project, &units[..1]);
    let mut cases = Vec::new();
    let mut invalid = base.clone();
    invalid.project_id = ExecutionId::new();
    cases.push(invalid);
    let mut invalid = base.clone();
    invalid.conversation_id = ExecutionId::new();
    cases.push(invalid);
    let mut invalid = base.clone();
    invalid.selected_message_ids.clear();
    cases.push(invalid);
    let mut invalid = base.clone();
    invalid
        .selected_message_ids
        .push(base.selected_message_ids[0]);
    cases.push(invalid);
    let mut invalid = base.clone();
    invalid.selected_message_ids = vec![ExecutionId::new(); 17];
    cases.push(invalid);
    let mut invalid = base.clone();
    invalid.selected_message_ids = vec![ExecutionId::new()];
    cases.push(invalid);
    let mut invalid = base.clone();
    invalid.selected_message_ids = other.selected_message_ids;
    cases.push(invalid);
    for locale in ["zh-cn", "de-DE", "invalid locale"] {
        let mut invalid = base.clone();
        invalid.scope = ConversationPlanningScope::Units {
            locale: locale.into(),
            unit_ids: units[..1].into(),
        };
        cases.push(invalid);
    }
    for ids in [vec![], vec![units[0], units[0]], vec![ExecutionId::new()]] {
        let mut invalid = base.clone();
        invalid.scope = ConversationPlanningScope::Units {
            locale: "zh-CN".into(),
            unit_ids: ids,
        };
        cases.push(invalid);
    }
    let mut invalid = base.clone();
    invalid.config.max_items = 1;
    invalid.scope = ConversationPlanningScope::Units {
        locale: "zh-CN".into(),
        unit_ids: units,
    };
    cases.push(invalid);
    for field in [
        "requests",
        "retries",
        "concurrency",
        "endpoint",
        "model",
        "items",
        "output",
    ] {
        let mut invalid = base.clone();
        match field {
            "requests" => invalid.config.max_requests = 2,
            "retries" => invalid.config.max_retries = 1,
            "concurrency" => invalid.config.concurrency = 2,
            "endpoint" => invalid.config.endpoint = "http://remote.example/v1".into(),
            "model" => invalid.config.model.clear(),
            "items" => invalid.config.max_items = 0,
            _ => invalid.config.max_output_tokens = 0,
        }
        cases.push(invalid);
    }
    readonly(&store, || {
        for case in cases {
            assert!(
                store.prepare_conversation_planning(&case).is_err(),
                "accepted invalid request {case:?}"
            );
        }
    });
    let mut encoded = serde_json::to_value(&base).unwrap();
    encoded["scope"]["filter"] = "all".into();
    assert!(serde_json::from_value::<PrepareConversationPlanning>(encoded).is_err());
}

#[test]
fn message_count_and_aggregate_prompt_limit_reject_whole_requests_without_truncation() {
    let (_temp, store, project, units) = fixture();
    let mut req = request(&store, project, &units[..1]);
    for index in 1..16 {
        req.selected_message_ids.push(append(
            &store,
            project,
            req.conversation_id,
            &format!("Message {index}"),
        ));
    }
    let capture = readonly(&store, || {
        store.prepare_conversation_planning(&req).unwrap()
    });
    assert_eq!(capture.preview().selected_messages.len(), 16);
    req.selected_message_ids
        .push(append(&store, project, req.conversation_id, "Seventeenth"));
    readonly(&store, || {
        assert!(store.prepare_conversation_planning(&req).is_err())
    });
    // Every individual message remains valid; the aggregate crosses the real
    // provider budget and must not silently keep only the last messages.
    req.selected_message_ids = (0..6)
        .map(|_| append(&store, project, req.conversation_id, &"😀\"\\".repeat(900)))
        .collect();
    readonly(&store, || {
        assert_eq!(
            store.prepare_conversation_planning(&req).unwrap_err().code,
            ErrorCode::LimitExceeded
        )
    });
}

#[test]
fn original_capture_survives_unrelated_edits_and_unselected_new_messages() {
    let (_temp, mut store, project, units) = fixture();
    let req = request(&store, project, &units[..1]);
    let capture = store.prepare_conversation_planning(&req).unwrap();
    let original = capture.preview().clone();
    translate(
        &mut store,
        project,
        units[1],
        "zh-CN",
        "Unrelated translation",
    );
    context(&mut store, project, units[1], "Unrelated context");
    context(&mut store, project, units[0], "Not shared context");
    term(&mut store, project, units[0], "Unshared terminology");
    append(
        &store,
        project,
        req.conversation_id,
        "A new message must not enter the capture",
    );
    readonly(&store, || {
        store.validate_conversation_planning(&capture).unwrap()
    });
    assert_eq!(capture.preview(), &original);
}

#[test]
fn related_selection_protection_source_and_shared_resource_changes_invalidate_without_refresh() {
    let (_temp, mut store, project, units) = fixture();
    let mut req = request(&store, project, &units[..1]);
    let capture = store.prepare_conversation_planning(&req).unwrap();
    let target = store.review_target(project, units[0], "zh-CN").unwrap();
    store
        .set_work_protection(&SetWorkProtection {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: units[0],
            locale: "zh-CN".into(),
            source_revision_id: target.source_revision_id,
            selection_id: target.selection_id,
            expected_revision: Revision::new(0).unwrap(),
            protected: true,
            confirmed_release: false,
        })
        .unwrap();
    readonly(&store, || {
        assert_eq!(
            store
                .validate_conversation_planning(&capture)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        )
    });
    let capture = store.prepare_conversation_planning(&req).unwrap();
    translate(
        &mut store,
        project,
        units[0],
        "zh-CN",
        "Latest human selection {{name}}",
    );
    readonly(&store, || {
        assert!(store.validate_conversation_planning(&capture).is_err())
    });
    req.config.share_context = true;
    context(&mut store, project, units[0], "First shared context");
    let capture = store.prepare_conversation_planning(&req).unwrap();
    let original = capture.preview().clone();
    context(&mut store, project, units[0], "New shared context");
    readonly(&store, || {
        assert!(store.validate_conversation_planning(&capture).is_err())
    });
    assert_eq!(capture.preview(), &original);
    req.config.share_terms = true;
    let capture = store.prepare_conversation_planning(&req).unwrap();
    term(&mut store, project, units[0], "Shared terminology");
    readonly(&store, || {
        assert!(store.validate_conversation_planning(&capture).is_err())
    });
    let capture = store.prepare_conversation_planning(&req).unwrap();
    adopt_source(
        &mut store,
        br#"{"hello":"Changed Hello {{name}}","plain":"Plain"}"#,
    );
    readonly(&store, || {
        assert!(store.validate_conversation_planning(&capture).is_err())
    });
}

#[test]
fn opaque_capture_rejects_reconciling_and_reopened_store_without_recreating_authority() {
    let (_temp, store, project, units) = fixture();
    let req = request(&store, project, &units[..1]);
    let capture = store.prepare_conversation_planning(&req).unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    readonly(&store, || {
        assert_eq!(
            store.prepare_conversation_planning(&req).unwrap_err().code,
            ErrorCode::OutcomeUnknown
        );
        assert_eq!(
            store
                .validate_conversation_planning(&capture)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
    });
    store.execution_unknown.store(false, Ordering::Release);
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    readonly(&reopened, || {
        assert_eq!(
            reopened
                .validate_conversation_planning(&capture)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        )
    });
    let fresh = readonly(&reopened, || {
        reopened.prepare_conversation_planning(&req).unwrap()
    });
    assert_eq!(fresh.preview(), capture.preview());
    assert_ne!(fresh.epoch, capture.epoch);
}
