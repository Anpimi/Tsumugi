use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::model_connections::ModelConnectionEdit;

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    name: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: name.into(),
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
fn application(
    directory: &Path,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let state = AppState::default();
    configure(&state, directory).unwrap();
    let app = tauri::test::mock_builder()
        .manage(state)
        .invoke_handler(super::super::execution::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    (app, window)
}
fn snapshot(window: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> ModelConnectionSnapshot {
    read_view(window).snapshot
}
fn read_view(window: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> ConnectionReadView {
    serde_json::from_value(call(window, "read_model_connections", json!({})).unwrap()).unwrap()
}
fn save(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    profile_id: ExecutionId,
    name: &str,
) -> ModelConnectionChange {
    ModelConnectionChange {
        action_id: ExecutionId::new(),
        expected: read_view(window).basis,
        edit: ModelConnectionEdit::Save {
            profile_id,
            name: name.into(),
            connection: AiConnection {
                endpoint: "https://example.test/v1/chat/completions".into(),
                model: "Synthetic model".into(),
                credential_env: "SYNTHETIC_CREDENTIAL_REFERENCE".into(),
                token_field: "max_tokens".into(),
            },
        },
    }
}
fn change(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    request: &ModelConnectionChange,
) -> ModelConnectionReceipt {
    serde_json::from_value(
        call(
            window,
            "change_model_connections",
            serde_json::to_value(request).unwrap(),
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn registered_reads_need_no_project_and_leave_missing_storage_absent() {
    let temp = tempfile::tempdir().unwrap();
    let (_app, window) = application(temp.path());
    assert_eq!(snapshot(&window).revision.get(), 0);
    assert!(
        call(
            &window,
            "read_model_connection_action",
            json!({"actionId":ExecutionId::new()})
        )
        .unwrap()
        .is_null()
    );
    assert!(!temp.path().join("model-connections").exists());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}
#[test]
fn registered_changes_replay_original_receipts_after_reopen_and_refuse_stale_or_altered_actions() {
    let temp = tempfile::tempdir().unwrap();
    let (app, window) = application(temp.path());
    let id = ExecutionId::new();
    let first = save(&window, id, "Primary");
    let receipt = change(&window, &first);
    let stale = save(&window, id, "Stale");
    change(&window, &save(&window, ExecutionId::new(), "Other"));
    let current = snapshot(&window);
    assert_eq!(change(&window, &first), receipt);
    let error = call(
        &window,
        "change_model_connections",
        serde_json::to_value(&stale).unwrap(),
    )
    .unwrap_err();
    assert_eq!(error["code"], "dependency-conflict");
    assert_eq!(error["stage"], "model-connections");
    assert_eq!(snapshot(&window), current);
    assert!(
        call(
            &window,
            "read_model_connection_action",
            json!({"actionId":stale.action_id})
        )
        .unwrap()
        .is_null()
    );
    let mut altered = first.clone();
    if let ModelConnectionEdit::Save { name, .. } = &mut altered.edit {
        *name = "Changed original action".into();
    }
    assert_eq!(
        call(
            &window,
            "change_model_connections",
            serde_json::to_value(altered).unwrap()
        )
        .unwrap_err()["code"],
        "dependency-conflict"
    );
    drop(window);
    drop(app);
    let (_app, window) = application(temp.path());
    assert_eq!(snapshot(&window), current);
    assert_eq!(
        serde_json::from_value::<ModelConnectionReceipt>(
            call(
                &window,
                "read_model_connection_action",
                json!({"actionId":first.action_id})
            )
            .unwrap()
        )
        .unwrap(),
        receipt
    );
    assert_eq!(change(&window, &first), receipt);
}
#[test]
fn registered_resolution_refuses_changed_archived_and_foreign_profiles_without_rewriting_captured_defaults()
 {
    let temp = tempfile::tempdir().unwrap();
    let (_app, window) = application(temp.path());
    let id = ExecutionId::new();
    let receipt = change(&window, &save(&window, id, "Primary"));
    let reference = receipt.snapshot.reference(id).unwrap();
    let captured = call(
        &window,
        "resolve_model_connection",
        json!({"reference":reference}),
    )
    .unwrap();
    let archive = ModelConnectionChange {
        action_id: ExecutionId::new(),
        expected: snapshot(&window).basis().unwrap(),
        edit: ModelConnectionEdit::Archive { profile_id: id },
    };
    change(&window, &archive);
    assert_eq!(
        call(
            &window,
            "resolve_model_connection",
            json!({"reference":reference})
        )
        .unwrap_err()["code"],
        "dependency-conflict"
    );
    let restore = ModelConnectionChange {
        action_id: ExecutionId::new(),
        expected: snapshot(&window).basis().unwrap(),
        edit: ModelConnectionEdit::Restore { profile_id: id },
    };
    change(&window, &restore);
    assert_eq!(
        call(
            &window,
            "resolve_model_connection",
            json!({"reference":reference})
        )
        .unwrap_err()["code"],
        "dependency-conflict"
    );
    let mut foreign = snapshot(&window).reference(id).unwrap();
    foreign.store_id = ExecutionId::new();
    assert_eq!(
        call(
            &window,
            "resolve_model_connection",
            json!({"reference":foreign})
        )
        .unwrap_err()["code"],
        "dependency-conflict"
    );
    assert_eq!(captured["model"], "Synthetic model");
    assert_eq!(captured["credentialEnv"], "SYNTHETIC_CREDENTIAL_REFERENCE");
}
#[test]
fn registered_requests_cannot_choose_storage_or_supply_raw_credentials_and_invalid_saves_do_not_create_storage()
 {
    let temp = tempfile::tempdir().unwrap();
    let (_app, window) = application(temp.path());
    assert!(
        call(
            &window,
            "read_model_connections",
            json!({"directory":"untrusted"})
        )
        .is_err()
    );
    let first = save(&window, ExecutionId::new(), "Primary");
    let mut raw = serde_json::to_value(&first).unwrap();
    raw["edit"]["connection"]["apiKey"] = json!("synthetic-rejected-value");
    assert!(call(&window, "change_model_connections", raw).is_err());
    let mut invalid = first.clone();
    if let ModelConnectionEdit::Save { connection, .. } = &mut invalid.edit {
        connection.endpoint = "https://user:synthetic@example.test/api?token=synthetic".into();
    }
    let error = call(
        &window,
        "change_model_connections",
        serde_json::to_value(invalid).unwrap(),
    )
    .unwrap_err();
    assert_eq!(error["code"], "invalid-input");
    assert_eq!(error["stage"], "model-connections");
    assert_eq!(error["reason"], "ai-endpoint");
    assert!(!error.to_string().contains("synthetic@example"));
    assert!(!temp.path().join("model-connections").exists());
}
#[test]
fn unsupported_connection_formats_are_reported_in_their_own_scope_without_repair() {
    let temp = tempfile::tempdir().unwrap();
    let (_app, window) = application(temp.path());
    change(&window, &save(&window, ExecutionId::new(), "Primary"));
    let path = temp
        .path()
        .join("model-connections/model-connections.sqlite3");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 2).unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let error = call(&window, "read_model_connections", json!({})).unwrap_err();
    assert_eq!(error["code"], "unsupported-schema");
    assert_eq!(error["stage"], "model-connections");
    assert_eq!(before, std::fs::read(&path).unwrap());
}
#[test]
fn unavailable_configuration_and_connection_corruption_keep_finite_non_project_errors() {
    let state = AppState::default();
    assert!(store(&state).is_err());
    let corrupt = map_error(ExecutionError::new(
        ErrorCode::CorruptLedger,
        "model-connections-digest",
    ));
    assert_eq!(corrupt.code, CommandErrorCode::StorageFailed);
    assert_eq!(corrupt.stage, CommandStage::ModelConnections);
    let unknown = map_error(ExecutionError::new(
        ErrorCode::OutcomeUnknown,
        "model-connections-commit",
    ));
    assert_eq!(unknown.outcome, super::super::CommandOutcome::Unknown);
    assert!(unknown.recovery_required);
}
#[test]
fn connection_wire_fixture_uses_the_actual_rust_shapes_and_refuses_unrecognized_fields() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/connectionCommands.contract.json"
    ))
    .unwrap();
    macro_rules! check {
        ($group:literal,$key:literal,$kind:ty) => {
            let value: $kind = serde_json::from_value(fixture[$group][$key].clone()).unwrap();
            assert_eq!(serde_json::to_value(value).unwrap(), fixture[$group][$key]);
        };
    }
    check!("requests", "snapshot", ConnectionSnapshotRequest);
    check!("requests", "change", ModelConnectionChange);
    check!("requests", "action", ConnectionActionRequest);
    check!("requests", "resolve", ConnectionResolveRequest);
    check!("responses", "snapshot", ConnectionReadView);
    check!("responses", "receipt", ModelConnectionReceipt);
    check!("responses", "action", Option<ModelConnectionReceipt>);
    check!("responses", "connection", AiConnection);
    let mut raw = fixture["requests"]["change"].clone();
    raw["expected"]["revision"] = json!(0);
    assert!(serde_json::from_value::<ModelConnectionChange>(raw).is_err());
    let mut raw = fixture["requests"]["change"].clone();
    raw["edit"]["unknown"] = json!(true);
    assert!(serde_json::from_value::<ModelConnectionChange>(raw).is_err());
}

#[test]
fn registered_read_envelope_binds_core_basis_and_active_references_to_one_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let (_app, window) = application(temp.path());
    let empty = read_view(&window);
    assert_eq!(empty.basis, empty.snapshot.basis().unwrap());
    assert!(empty.references.is_empty());
    let id = ExecutionId::new();
    change(&window, &save(&window, id, "Primary"));
    change(&window, &save(&window, ExecutionId::new(), "Other"));
    let current = read_view(&window);
    assert_eq!(current.basis, current.snapshot.basis().unwrap());
    assert_eq!(current.references.len(), 2);
    for reference in &current.references {
        assert_eq!(
            current.snapshot.reference(reference.profile_id).unwrap(),
            *reference
        );
    }
    let archive = ModelConnectionChange {
        action_id: ExecutionId::new(),
        expected: current.basis,
        edit: ModelConnectionEdit::Archive { profile_id: id },
    };
    change(&window, &archive);
    let current = read_view(&window);
    assert_eq!(current.references.len(), 1);
    assert_ne!(current.references[0].profile_id, id);
    assert_eq!(current.basis, current.snapshot.basis().unwrap());
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/connectionCommands.contract.json"
    ))
    .unwrap();
    let fixture: ConnectionReadView =
        serde_json::from_value(fixture["responses"]["snapshot"].clone()).unwrap();
    assert_eq!(fixture.basis, fixture.snapshot.basis().unwrap());
    assert_eq!(
        fixture.references,
        vec![
            fixture
                .snapshot
                .reference(fixture.snapshot.profiles[0].id)
                .unwrap()
        ]
    );
}
