use super::*;
use crate::persistence::review::tests::{adopt_source, fixture, translate};
use crate::{
    ProjectMetadata, SaveContext, SaveTerm,
    ai::{AiConfig, provider},
    application::*,
};
use std::{fs, sync::atomic::Ordering};

struct AuthorityOnlyRunner;
impl crate::execution::Runner for AuthorityOnlyRunner {
    fn capability_id(&self) -> &str {
        crate::ai::conversation_planning::CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        _: crate::execution::DispatchRequest,
        _: crate::execution::Cancellation,
        _: crate::execution::ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("authority fixture must never invoke a producer")
    }
}
fn planning_runtime(store: &ProjectStore) -> crate::execution::ExecutionRuntime {
    let mut runtime = crate::execution::ExecutionRuntime::new(store).unwrap();
    runtime.register(Arc::new(AuthorityOnlyRunner)).unwrap();
    runtime
}
fn planning_consent(capture: &CapturedConversationPlanning) -> ConversationPlanningConsent {
    let action = ExecutionId::new();
    ConversationPlanningConsent {
        action_id: action,
        task_id: ExecutionId::new(),
        attempt_id: action,
        preview_digest: capture.preview_digest().unwrap(),
        expires_at_ms: (crate::execution::plugin_authority::plugin_now_ms().unwrap() + 30_000)
            .into(),
        share_messages: true,
        share_units: matches!(
            capture.preview().scope,
            ConversationPlanningScope::Units { .. }
        ),
    }
}
fn planning_action(prepared: &PreparedConversationPlanning) -> ReadConversationPlanningAction {
    ReadConversationPlanningAction {
        project_id: prepared.preview().project_id,
        conversation_id: prepared.preview().conversation_id,
        consent: prepared.consent().clone(),
    }
}

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

#[test]
fn planning_authority_requires_exact_explicit_consent_and_opaque_admission() {
    let (_temp, mut store, project, units) = fixture();
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let consent = planning_consent(&capture);
    for bad in [
        ConversationPlanningConsent {
            share_messages: false,
            ..consent.clone()
        },
        ConversationPlanningConsent {
            share_units: false,
            ..consent.clone()
        },
        ConversationPlanningConsent {
            preview_digest: "0".repeat(64),
            ..consent.clone()
        },
        ConversationPlanningConsent {
            action_id: ExecutionId::new(),
            ..consent.clone()
        },
        ConversationPlanningConsent {
            expires_at_ms: (crate::execution::plugin_authority::plugin_now_ms().unwrap() + 121_000)
                .into(),
            ..consent.clone()
        },
    ] {
        readonly(&store, || {
            assert!(
                store
                    .authorize_conversation_planning(&capture, &bad)
                    .is_err()
            )
        });
    }
    let prepared = readonly(&store, || {
        store
            .authorize_conversation_planning(&capture, &consent)
            .unwrap()
    });
    let restored =
        crate::execution::FixedInput::restore(prepared.input().bytes(), prepared.input().digest())
            .unwrap();
    assert_eq!(
        store.enqueue_execution(&restored).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .enqueue_read_only_execution(&restored)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    for change_operation in [true, false] {
        let mut envelope = restored.envelope().clone();
        if change_operation {
            envelope.operation = "unrelated".into();
        } else {
            envelope.capability_id = "unrelated".into();
        }
        let forged = crate::execution::FixedInput::capture(envelope).unwrap();
        assert_eq!(
            store.enqueue_execution(&forged).unwrap_err().code,
            ErrorCode::Unauthorized
        );
    }
    let mut runtime = planning_runtime(&store);
    assert_eq!(
        runtime.submit(&mut store, &restored).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let receipt = runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    assert_eq!(receipt.consent, consent);
    assert_eq!(store.conversation_planning_permits.len(), 1);
    let before = store.connection().unwrap().total_changes();
    assert_eq!(
        runtime
            .submit_conversation_planning(&mut store, &prepared)
            .unwrap(),
        receipt
    );
    assert_eq!(store.connection().unwrap().total_changes(), before);
    assert_eq!(
        store
            .provider_budget(consent.task_id)
            .unwrap()
            .unwrap()
            .limit,
        1
    );
    let mut mismatch = planning_action(&prepared);
    mismatch.consent.preview_digest = "0".repeat(64);
    assert!(matches!(
        store
            .recover_conversation_planning(&mismatch)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Mismatch {}
    ));
}

#[test]
fn planning_authority_keeps_original_budget_and_revokes_even_when_cancel_is_unknown() {
    let (_temp, mut store, project, units) = fixture();
    let mut req = request(&store, project, &units[..1]);
    req.scope = ConversationPlanningScope::ConversationOnly {};
    let capture = store.prepare_conversation_planning(&req).unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    let receipt = runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let input = prepared.input();
    let dispatch = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    dispatch.check_service_dispatch().unwrap();
    assert!(dispatch.deadline().unwrap() <= prepared.permit.deadline());
    let request_id = ExecutionId::new();
    store
        .reserve_provider_request(&dispatch, request_id, 1)
        .unwrap();
    assert_eq!(
        store
            .reserve_provider_request(&dispatch, ExecutionId::new(), 1)
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let original = store
        .provider_budget(receipt.consent.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(original.dispatched, 1);
    assert_eq!(original.unresolved, 1);
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(
        store
            .cancel_execution(receipt.consent.task_id, ExecutionId::new())
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
    store.reconcile_execution().unwrap();
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .provider_budget(receipt.consent.task_id)
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(
        store
            .conversation_planning_receipt(&planning_action(&prepared))
            .unwrap(),
        Some(receipt)
    );
}

#[test]
fn planning_authority_reopen_and_replay_return_history_without_installing_permission() {
    let (_temp, mut store, project, units) = fixture();
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    let receipt = runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let action = planning_action(&prepared);
    let directory = store.directory().to_path_buf();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(directory).unwrap();
    let mut runtime = planning_runtime(&reopened);
    assert!(
        matches!(reopened.recover_conversation_planning(&action).unwrap().outcome, ConversationActionOutcome::Recorded { receipt: ref original } if original == &receipt)
    );
    assert_eq!(
        runtime
            .submit_conversation_planning(&mut reopened, &prepared)
            .unwrap(),
        receipt
    );
    assert!(reopened.conversation_planning_permits.is_empty());
    runtime.tick(&mut reopened).unwrap();
    assert_eq!(
        reopened
            .provider_budget(action.consent.task_id)
            .unwrap()
            .unwrap()
            .dispatched,
        0
    );
    assert_eq!(
        reopened
            .dispatch_execution_item(
                action.consent.attempt_id,
                prepared.input().envelope().items[0].item_id
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        reopened.conversation_planning_receipt(&action).unwrap(),
        Some(receipt)
    );
    let mut missing = action;
    let id = ExecutionId::new();
    missing.consent.action_id = id;
    missing.consent.attempt_id = id;
    assert!(matches!(
        reopened
            .recover_conversation_planning(&missing)
            .unwrap()
            .outcome,
        ConversationActionOutcome::Pending {
            replay: ConversationActionReplay::Blocked
        }
    ));
}

#[test]
fn planning_authority_current_source_and_generation_boundaries_stop_dispatch() {
    let (_temp, mut store, project, units) = fixture();
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    translate(
        &mut store,
        project,
        units[0],
        "zh-CN",
        "A newer human translation",
    );
    assert_eq!(
        store
            .dispatch_execution_item(
                prepared.consent.attempt_id,
                prepared.input().envelope().items[0].item_id
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .provider_budget(prepared.consent.task_id)
            .unwrap()
            .unwrap()
            .dispatched,
        0
    );
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let next = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    runtime
        .submit_conversation_planning(&mut store, &next)
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            next.consent.attempt_id,
            next.input().envelope().items[0].item_id,
        )
        .unwrap();
    dispatch.check_service_dispatch().unwrap();
    runtime.begin_quiesce(&mut store).unwrap();
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
    runtime.finish_quiesce(&mut store).unwrap();
    assert_eq!(
        runtime
            .submit_conversation_planning(&mut store, &next)
            .unwrap()
            .consent,
        next.consent
    );
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
}

#[test]
fn planning_authority_runtime_drop_and_original_deadlines_never_renew() {
    let (_temp, mut store, project, units) = fixture();
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            prepared.consent.attempt_id,
            prepared.input().envelope().items[0].item_id,
        )
        .unwrap();
    let mut expired = dispatch.clone();
    expired.planning_permit.as_mut().unwrap().deadline = Instant::now();
    assert_eq!(
        expired.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let next = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    runtime
        .submit_conversation_planning(&mut store, &next)
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            next.consent.attempt_id,
            next.input().envelope().items[0].item_id,
        )
        .unwrap();
    drop(runtime);
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let mut replacement = planning_runtime(&store);
    replacement
        .submit_conversation_planning(&mut store, &next)
        .unwrap();
    assert_eq!(
        dispatch.check_service_dispatch().unwrap_err().code,
        ErrorCode::Unauthorized
    );
}

#[test]
fn planning_authority_generic_recovery_and_adoption_remain_read_only() {
    use crate::execution::{
        AdoptionAction, ContinuationAction, ContinuationKind, ExecutionState, FixedResult,
        RecoveryPolicy, ResultEnvelope,
    };
    let (_temp, mut store, project, units) = fixture();
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let input = prepared.input();
    let attempt = input.envelope().attempt_id;
    let item = input.envelope().items[0].item_id;
    let unit = input.envelope().units[0].unit_id;
    assert!(
        store.execution_recovery(attempt, false).unwrap().units[0]
            .actions
            .is_empty()
    );
    assert!(
        store
            .execution_attempt_detail(attempt, false, 0, 1)
            .unwrap()
            .recovery
            .units[0]
            .actions
            .is_empty()
    );
    assert_eq!(
        store
            .execution_retry_input(attempt, &[item])
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let continuation = ContinuationAction {
        action_id: ExecutionId::new(),
        project_id: project,
        source_attempt_id: attempt,
        unit_id: unit,
        kind: ContinuationKind::ResumeUndispatched,
        item_ids: vec![item],
        expected_cancellation_revision: Revision::new(0).unwrap(),
    };
    assert_eq!(
        runtime.resume(&mut store, &continuation).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .enqueue_continuation(&continuation, input, RecoveryPolicy::ExternalUnknown)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let dispatch = store.dispatch_execution_item(attempt, item).unwrap();
    store
        .note_execution_unknown(attempt, item, "synthetic-unknown")
        .unwrap();
    let unknown = store.execution_recovery(attempt, false).unwrap();
    assert!(unknown.units[0].actions.is_empty());
    assert_eq!(
        unknown.units[0].blocked_reason.as_deref(),
        Some("outcome-unknown")
    );
    assert!(runtime.outcome_query(&store, attempt, item).is_err());
    let result = FixedResult::capture(ResultEnvelope {
        project_id: project, attempt_id: attempt, item_id: item, result_id: ExecutionId::new(),
        supersedes: None, dispatch_token: dispatch.dispatch_token,
        capability_id: input.envelope().capability_id.clone(), capability_version: "1".into(),
        plugin: None, outcome: ExecutionState::Succeeded,
        output: Some(serde_json::json!({"model":{"kind":"reply","summary":"A bounded explanation","questions":[]},
            "usage":null,"requests":1,"usageIncomplete":true})), diagnostic: None,
    }, input, dispatch.dispatch_token).unwrap();
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(attempt, result.envelope().result_id)
        .unwrap();
    let detail = store
        .execution_attempt_detail(attempt, false, 0, 1)
        .unwrap();
    assert_eq!(detail.progress.succeeded, 1);
    assert!(detail.recovery.units[0].actions.is_empty());
    assert_eq!(
        detail.recovery.units[0].result_ids,
        vec![result.envelope().result_id]
    );
    assert_eq!(
        store
            .execution_result(attempt, result.envelope().result_id)
            .unwrap()
            .digest(),
        result.digest()
    );
    let action = AdoptionAction {
        project_id: project,
        attempt_id: attempt,
        action_id: ExecutionId::new(),
        unit_id: unit,
        operation: input.envelope().operation.clone(),
        result_ids: vec![result.envelope().result_id],
        cancellation_revision: Revision::new(0).unwrap(),
        parameters: serde_json::Value::Null,
    };
    let before = store.connection().unwrap().total_changes();
    assert_eq!(
        store
            .prepare_adoption_with_id(
                action.action_id,
                attempt,
                unit,
                action.result_ids.clone(),
                serde_json::Value::Null
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store.capture_execution_adoption(&action).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(store.connection().unwrap().total_changes(), before);
}

#[test]
fn planning_authority_loopback_dispatch_preserves_exact_prompt_budget_and_receipt() {
    use crate::{
        ai::conversation_planning::{ConversationPlanningModelOutput, ConversationPlanningRunner},
        execution::{ExecutionRuntime, FixedInput, ValidationState},
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::AtomicUsize,
        thread,
        time::Duration,
    };

    struct Loopback {
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<Result<serde_json::Value, String>>>,
    }
    impl Drop for Loopback {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let server = thread::spawn(move || -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut captured = None;
        while !stopping.load(Ordering::Acquire) && Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(error) => return Err(format!("loopback accept: {error}")),
            };
            if calls.fetch_add(1, Ordering::AcqRel) != 0 {
                return Err("unexpected second planning request".into());
            }
            stream
                .set_nonblocking(false)
                .map_err(|error| format!("planning blocking stream: {error}"))?;
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .map_err(|error| error.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .map_err(|error| error.to_string())?;
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let header_end = loop {
                if stopping.load(Ordering::Acquire) || Instant::now() >= deadline {
                    return Err("planning header deadline".into());
                }
                let length = stream
                    .read(&mut buffer)
                    .map_err(|error| format!("planning header read: {error}"))?;
                if length == 0 {
                    return Err("incomplete planning headers".into());
                }
                bytes.extend_from_slice(&buffer[..length]);
                if bytes.len() > 96 * 1024 {
                    return Err("planning request exceeds fixture bound".into());
                }
                if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers =
                std::str::from_utf8(&bytes[..header_end]).map_err(|error| error.to_string())?;
            if !headers.starts_with("POST /v1/chat/completions HTTP/1.1\r\n")
                || headers.to_ascii_lowercase().contains("authorization:")
            {
                return Err("unexpected planning method, path or credential header".into());
            }
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, length)| length.trim().parse::<usize>().ok())
                })
                .filter(|length| *length <= 64 * 1024)
                .ok_or("missing or oversized planning content length")?;
            while bytes.len() < header_end + content_length {
                if stopping.load(Ordering::Acquire) || Instant::now() >= deadline {
                    return Err("planning body deadline".into());
                }
                let length = stream
                    .read(&mut buffer)
                    .map_err(|error| format!("planning body read: {error}"))?;
                if length == 0 {
                    return Err("incomplete planning body".into());
                }
                bytes.extend_from_slice(&buffer[..length]);
                if bytes.len() > 96 * 1024 {
                    return Err("planning request exceeds fixture bound".into());
                }
            }
            captured = Some(
                serde_json::from_slice(&bytes[header_end..header_end + content_length])
                    .map_err(|error| error.to_string())?,
            );
            let response = serde_json::json!({
                "choices":[{"finish_reason":"stop","message":{"role":"assistant",
                    "content":serde_json::json!({"kind":"reply","summary":"A bounded explanation","questions":[]}).to_string()}}],
                "usage":{"prompt_tokens":7,"completion_tokens":3,
                    "prompt_tokens_details":{"cached_tokens":2},
                    "completion_tokens_details":{"reasoning_tokens":1}}
            }).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}", response.len(), response)
                .map_err(|error| error.to_string())?;
        }
        captured.ok_or_else(|| "planning request was not observed".into())
    });
    let mut loopback = Loopback {
        stop,
        thread: Some(server),
    };
    let (_temp, mut store, project, units) = fixture();
    let mut req = request(&store, project, &units[..1]);
    req.config.endpoint = endpoint;
    req.config.credential_env.clear();
    let capture = store.prepare_conversation_planning(&req).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register(Arc::new(ConversationPlanningRunner::with_service(
            Arc::new(provider::ProviderService::default()),
        )))
        .unwrap();
    runtime.tick(&mut store).unwrap();
    assert_eq!(count.load(Ordering::Acquire), 0);
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let restored =
        FixedInput::restore(prepared.input().bytes(), prepared.input().digest()).unwrap();
    assert_eq!(
        runtime.submit(&mut store, &restored).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    runtime.tick(&mut store).unwrap();
    assert_eq!(count.load(Ordering::Acquire), 0);
    assert!(
        store
            .conversation_planning_receipt(&planning_action(&prepared))
            .unwrap()
            .is_none()
    );
    let receipt = runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while runtime.has_active_work(&store).unwrap() {
        runtime.tick(&mut store).unwrap();
        assert!(Instant::now() < deadline, "planning loopback did not drain");
        thread::sleep(Duration::from_millis(2));
    }
    let detail = store
        .execution_attempt_detail(receipt.consent.attempt_id, false, 0, 1)
        .unwrap();
    let server_failure = if detail.progress.succeeded != 1 {
        loopback.stop.store(true, Ordering::Release);
        loopback.thread.take().map(|thread| {
            thread
                .join()
                .map_err(|_| "planning server panicked".to_owned())
                .and_then(|result| result.map(|_| ()))
        })
    } else {
        None
    };
    assert_eq!(
        detail.progress.succeeded,
        1,
        "unexpected planning state: {detail:?}; server={server_failure:?}; calls={}",
        count.load(Ordering::Acquire)
    );
    assert_eq!(detail.items[0].status.validation, ValidationState::Valid);
    let result = store
        .execution_result(
            receipt.consent.attempt_id,
            detail.items[0].result_id.unwrap(),
        )
        .unwrap();
    let output =
        crate::ai::conversation_planning::validate_output(prepared.input(), &result).unwrap();
    assert!(
        matches!(output.model, ConversationPlanningModelOutput::Reply { ref summary, ref questions }
        if summary == "A bounded explanation" && questions.is_empty())
    );
    assert_eq!(output.requests, 1);
    assert!(!output.usage_incomplete);
    assert_eq!(output.usage.as_ref().unwrap().prompt_tokens, 7);
    assert_eq!(output.usage.as_ref().unwrap().completion_tokens, 3);
    let budget = store
        .provider_budget(receipt.consent.task_id)
        .unwrap()
        .unwrap();
    assert_eq!(budget.dispatched, 1);
    assert_eq!(budget.unresolved, 0);
    assert_eq!(budget.usage_unknown, 0);
    assert_eq!(budget.prompt_tokens, "7");
    assert_eq!(budget.completion_tokens, "3");
    let before = store.connection().unwrap().total_changes();
    assert_eq!(
        runtime
            .submit_conversation_planning(&mut store, &prepared)
            .unwrap(),
        receipt
    );
    assert!(
        matches!(store.recover_conversation_planning(&planning_action(&prepared)).unwrap().outcome,
        ConversationActionOutcome::Recorded { receipt: ref original } if original == &receipt)
    );
    for _ in 0..3 {
        runtime.tick(&mut store).unwrap();
    }
    assert_eq!(store.connection().unwrap().total_changes(), before);
    assert_eq!(
        store
            .provider_budget(receipt.consent.task_id)
            .unwrap()
            .unwrap(),
        budget
    );
    loopback.stop.store(true, Ordering::Release);
    let wire = loopback
        .thread
        .take()
        .unwrap()
        .join()
        .expect("loopback thread panicked")
        .expect("loopback provider failed");
    assert_eq!(count.load(Ordering::Acquire), 1);
    assert_eq!(wire["model"], capture.preview().config.model);
    assert_eq!(
        wire["messages"],
        serde_json::json!([
            {"role":"system","content":capture.preview().system},
            {"role":"user","content":capture.preview().input}
        ])
    );
}

#[test]
fn planning_authority_mismatched_recovery_never_clears_unknown_or_restores_permission() {
    let (_temp, mut store, project, units) = fixture();
    let capture = store
        .prepare_conversation_planning(&request(&store, project, &units[..1]))
        .unwrap();
    let prepared = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let mut runtime = planning_runtime(&store);
    let original = runtime
        .submit_conversation_planning(&mut store, &prepared)
        .unwrap();
    let not_enqueued = store
        .authorize_conversation_planning(&capture, &planning_consent(&capture))
        .unwrap();
    let action = planning_action(&prepared);
    store.execution_unknown.store(true, Ordering::Release);
    let mut invalid = action.clone();
    invalid.consent.attempt_id = ExecutionId::new();
    assert!(store.recover_conversation_planning(&invalid).is_err());
    assert!(store.is_reconciling());
    let mut mismatch = action.clone();
    mismatch.consent.preview_digest = "0".repeat(64);
    let response = store.recover_conversation_planning(&mismatch).unwrap();
    assert!(matches!(
        response.outcome,
        ConversationActionOutcome::Mismatch {}
    ));
    assert!(store.is_reconciling());
    let response = store.recover_conversation_planning(&action).unwrap();
    assert_eq!(
        response.outcome,
        ConversationActionOutcome::Recorded { receipt: original }
    );
    assert!(!store.is_reconciling());
    assert!(prepared.permit.check_input(prepared.input()).is_err());
    assert!(
        not_enqueued
            .permit
            .check_input(not_enqueued.input())
            .is_err()
    );
    assert!(
        runtime
            .submit_conversation_planning(&mut store, &not_enqueued)
            .is_err()
    );
}
