use super::*;
use crate::model_connections::{ModelConnectionChange, ModelConnectionEdit, ModelConnectionStore};

#[test]
fn reopen_preserves_original_fixed_connection_inputs() {
    let (temp, mut project, rows) = source_project();
    let cfg = config("http://127.0.0.1:9/v1/chat/completions".into());
    let input = project.preview_ai(cfg, "zh-CN", &[rows[0].unit_id.unwrap()]).unwrap()
        .fixed_input(project.metadata().unwrap().project_id()).unwrap();
    project.enqueue_execution(&input).unwrap(); drop(project);
    let path = temp.path().join("project");
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.execution_input(input.envelope().attempt_id).unwrap().bytes(), input.bytes());
    assert_eq!(rusqlite::Connection::open(path.join("project.sqlite3")).unwrap()
        .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), crate::persistence::SCHEMA_VERSION);
}

#[test]
fn keychain_reference_is_captured_but_only_resolved_at_physical_dispatch() {
    struct Keys { expected: ExecutionId, calls: Arc<AtomicUsize> }
    impl provider::ApiKeyCredentials for Keys {
        fn api_key(&self, reference: ExecutionId) -> Result<String, ExecutionError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if reference == self.expected { Ok("synthetic-wire-credential".into()) }
            else { Err(error(ErrorCode::Unauthorized, "ai-api-key-unavailable")) }
        }
    }
    for available in [true, false] {
        let (_temp, mut store, rows) = source_project();
        let (url, count, wire) = server("auth");
        let reference = ExecutionId::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(provider::ProviderService::with_credentials(None, Some(Arc::new(Keys {
            expected: if available { reference } else { ExecutionId::new() }, calls: calls.clone(),
        }))));
        let mut cfg = config(url); cfg.credential_reference = Some(reference);
        let preview = store.preview_ai(cfg.clone(), "zh-CN", &[rows[0].unit_id.unwrap()]).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let body = request_body(&cfg, &preview.items[0]).unwrap().to_string();
        assert!(!body.contains(&reference.to_string()));
        let input = preview.fixed_input(store.metadata().unwrap().project_id()).unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register_with_policy(Arc::new(AiRunner::with_service(service)), RecoveryPolicy::ExternalUnknown).unwrap();
        runtime.submit(&mut store, &input).unwrap();
        drain(&mut runtime, &mut store, input.envelope().attempt_id);
        let view = runtime.attempt(&store, input.envelope().attempt_id).unwrap();
        assert_eq!(view.progress.failed, if available { 0 } else { 1 });
        assert_eq!(count.load(Ordering::SeqCst), if available { 1 } else { 0 });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let requests = wire.join().unwrap();
        assert_eq!(requests.len(), if available { 1 } else { 0 });
        assert!(!String::from_utf8_lossy(input.bytes()).contains("synthetic-wire-credential"));
        assert!(!serde_json::to_string(&requests).unwrap().contains("synthetic-wire-credential"));
    }
}

#[test]
fn credential_sources_are_exclusive_and_legacy_serialization_is_unchanged() {
    let mut cfg = config("http://127.0.0.1:9/v1/chat/completions".into());
    assert!(!serde_json::to_string(&cfg).unwrap().contains("credentialReference"));
    cfg.credential_reference = Some(ExecutionId::new());
    cfg.validate().unwrap();
    assert_eq!(AiConnection::from_config(&cfg).credential_reference, cfg.credential_reference);
    cfg.credential_env = "SYNTHETIC_ENVIRONMENT".into();
    assert_eq!(cfg.validate().unwrap_err().stage, "ai-credential-source");
    cfg.credential_env.clear(); cfg.chatgpt_account = Some(ExecutionId::new());
    assert_eq!(cfg.validate().unwrap_err().stage, "ai-credential-source");
}

fn capture_profile(store: &ModelConnectionStore) -> AiConfig {
    let id = ExecutionId::new();
    let connection = AiConnection {
        endpoint: "https://example.test/v1/chat/completions".into(),
        model: "Synthetic model".into(),
        credential_env: String::new(),
        credential_reference: None,
        token_field: "max_tokens".into(),
        chatgpt_account: None,
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
