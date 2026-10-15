use super::*;
use crate::model_connections::{ModelConnectionChange, ModelConnectionEdit, ModelConnectionStore};

fn capture_profile(store: &ModelConnectionStore) -> AiConfig {
    let id = ExecutionId::new();
    let connection = AiConnection {
        endpoint: "https://example.test/v1/chat/completions".into(),
        model: "Synthetic model".into(),
        credential_env: String::new(),
        token_field: "max_tokens".into(),
    };
    store
        .change(&ModelConnectionChange {
            action_id: ExecutionId::new(),
            expected: store.snapshot().unwrap().basis().unwrap(),
            edit: ModelConnectionEdit::Save {
                profile_id: id,
                name: "Synthetic profile".into(),
                connection: connection.clone(),
            },
        })
        .unwrap();
    let mut config = AiConfig {
        max_requests: 4,
        max_output_tokens: 37,
        ..Default::default()
    };
    connection.apply(&mut config);
    config.connection_profile = Some(store.snapshot().unwrap().reference(id).unwrap());
    config
}

#[test]
fn captured_connection_identity_persists_in_original_input_without_reading_mutable_defaults() {
    let (temp, mut project, rows) = source_project();
    let connections = ModelConnectionStore::at(temp.path().join("connections")).unwrap();
    let config = capture_profile(&connections);
    let preview = project
        .preview_ai(config.clone(), "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap();
    let input = preview
        .fixed_input(project.metadata().unwrap().project_id())
        .unwrap();
    project.enqueue_execution(&input).unwrap();
    let reference = config.connection_profile.as_ref().unwrap();
    connections
        .change(&ModelConnectionChange {
            action_id: ExecutionId::new(),
            expected: connections.snapshot().unwrap().basis().unwrap(),
            edit: ModelConnectionEdit::Archive {
                profile_id: reference.profile_id,
            },
        })
        .unwrap();
    assert!(connections.verify_configs(&[config.clone()]).is_err());
    drop(project);
    let project = ProjectStore::open(temp.path().join("project")).unwrap();
    let restored = project
        .execution_input(input.envelope().attempt_id)
        .unwrap();
    assert_eq!(settings(&restored).unwrap().config, config);
    assert_eq!(restored.envelope().attempt_id, input.envelope().attempt_id);
    assert_eq!(restored.bytes(), input.bytes());
    assert_eq!(
        restored.envelope().items[0].scope,
        input.envelope().items[0].scope
    );
}

#[test]
fn profile_identity_changes_preview_proof_without_entering_provider_payloads() {
    let (temp, project, rows) = source_project();
    let connections = ModelConnectionStore::at(temp.path().join("connections")).unwrap();
    let config = capture_profile(&connections);
    let mut manual = config.clone();
    manual.connection_profile = None;
    let preview = project
        .preview_ai(config.clone(), "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap();
    let item = &preview.items[0];
    assert_ne!(
        preview_digest(&config, &preview.items).unwrap(),
        preview_digest(&manual, &preview.items).unwrap()
    );
    let body = request_body(&config, item).unwrap();
    assert_eq!(body, request_body(&manual, item).unwrap());
    let body = body.to_string();
    let reference = config.connection_profile.unwrap();
    assert!(!body.contains(&reference.profile_id.to_string()));
    assert!(!body.contains(&reference.store_id.to_string()));
    assert!(!body.contains("connectionProfile"));
}
