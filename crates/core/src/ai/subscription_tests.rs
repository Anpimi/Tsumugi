use super::*;
use crate::ai::provider::{CompletionExecutor, CompletionPrompt, ProviderRequestCapture, ProviderService, SubscriptionCredentials};
use std::sync::atomic::AtomicBool;

fn subscription() -> AiConfig {
    AiConfig { endpoint: provider::CHATGPT_RESPONSES_ENDPOINT.into(), model: "synthetic-subscription-model".into(),
        credential_env: String::new(), token_field: "chatgpt_subscription".into(),
        chatgpt_account: Some(ExecutionId::new()), max_output_tokens: 0, max_retries: 0,
        ..Default::default() }
}
fn capture(config: &AiConfig, prompt: &CompletionPrompt) -> ProviderRequestCapture {
    ProviderRequestCapture { body: json!({"model":config.model,"stream":true,"store":false,
        "input":[{"role":"developer","content":prompt.system},
            {"role":"user","content":[{"type":"input_text","text":prompt.input}]}]}).to_string(),
        team_view: None, team_work_view: None }
}
fn dispatch(config: AiConfig) -> (tempfile::TempDir, ProjectStore, DispatchRequest) {
    let (temp, mut store, rows) = source_project();
    let input = store.preview_ai(config, "zh-CN", &[rows[0].unit_id.unwrap()]).unwrap()
        .fixed_input(store.metadata().unwrap().project_id()).unwrap();
    store.enqueue_execution(&input).unwrap();
    let request = store.dispatch_execution_item(input.envelope().attempt_id, input.envelope().items[0].item_id).unwrap();
    (temp, store, request)
}

#[test]
fn subscription_profile_is_explicit_and_api_key_limits_remain_required() {
    let config = subscription();
    config.validate().unwrap();
    assert_eq!(AiConnection::from_config(&config).chatgpt_account, config.chatgpt_account);
    for edited in [
        AiConfig { endpoint: "https://chatgpt.com/backend-api/codex/responses".into(), ..config.clone() },
        AiConfig { endpoint: "http://127.0.0.1/v1/responses".into(), ..config.clone() },
        AiConfig { credential_env: "OPENAI_API_KEY".into(), ..config.clone() },
        AiConfig { max_output_tokens: 1, ..config.clone() },
        AiConfig { max_retries: 1, ..config.clone() },
        AiConfig { token_field: "max_tokens".into(), ..config.clone() },
        AiConfig { chatgpt_account: None, ..config.clone() },
    ] { assert!(edited.validate().is_err()); }
}

#[test]
fn subscription_identity_is_optional_for_existing_wire_and_not_an_output_limit() {
    let mut api = config("https://api.example/v1/chat/completions".into());
    let old = serde_json::to_value(&api).unwrap();
    assert!(old.get("chatgptAccount").is_none());
    assert_eq!(serde_json::from_value::<AiConfig>(old).unwrap(), api);
    api.max_output_tokens = 0;
    assert!(api.validate().is_err());
    api.max_output_tokens = 16384;
    api.validate().unwrap();
    assert!(api.output_tokens_exceeded(16385, 1));
    let subscription = subscription();
    assert!(!subscription.output_tokens_exceeded(16385, 1));
    let mut selected = AiConfig::default();
    AiConnection::from_config(&subscription).apply(&mut selected);
    selected.validate().unwrap();
}

#[test]
fn subscription_capture_rejects_unsupported_parameters_and_mutated_completion_prompt() {
    let config = subscription();
    let prompt = CompletionPrompt { system: "Follow this captured task".into(), input: "Original source 👩🏽‍💻".into() };
    let original = capture(&config, &prompt);
    original.validate(&config).unwrap();
    original.validate_completion(&prompt).unwrap();
    for key in ["max_output_tokens", "max_tokens", "max_completion_tokens", "temperature", "previous_response_id", "authorization"] {
        let mut body: Value = serde_json::from_str(&original.body).unwrap();
        body[key] = 1.into();
        assert!(ProviderRequestCapture { body: body.to_string(), ..original.clone() }.validate(&config).is_err());
    }
    let mut invalid_role: Value = serde_json::from_str(&original.body).unwrap();
    invalid_role["input"][0]["role"] = "system".into();
    assert!(ProviderRequestCapture { body: invalid_role.to_string(), ..original.clone() }.validate(&config).is_err());
    let mut namespaced: Value = serde_json::from_str(&original.body).unwrap();
    namespaced["tools"] = json!([{"type":"namespace","name":"tsumugi","tools":[{"type":"function","name":"read_evidence","parameters":{"type":"object"}}]}]);
    ProviderRequestCapture { body: namespaced.to_string(), ..original.clone() }.validate(&config).unwrap();
    namespaced["tools"] = json!([{"type":"function","name":"read_evidence"}]);
    assert!(ProviderRequestCapture { body: namespaced.to_string(), ..original.clone() }.validate(&config).is_err());
    let mut body: Value = serde_json::from_str(&original.body).unwrap();
    body["store"] = true.into();
    assert!(ProviderRequestCapture { body: body.to_string(), ..original.clone() }.validate(&config).is_err());
    let wrong = capture(&config, &CompletionPrompt { input: "Changed source".into(), ..prompt.clone() });
    assert!(wrong.validate_completion(&prompt).is_err());
    let mut body: Value = serde_json::from_str(&original.body).unwrap();
    body["tools"] = json!([]);
    assert!(ProviderRequestCapture { body: body.to_string(), ..original }.validate_completion(&prompt).is_err());
}

struct Credentials { account: ExecutionId, active: AtomicBool, calls: AtomicUsize }
impl SubscriptionCredentials for Credentials {
    fn check_active(&self, account: ExecutionId) -> Result<(), ExecutionError> {
        if account == self.account && self.active.load(Ordering::SeqCst) { Ok(()) }
        else { Err(error(ErrorCode::Unauthorized, "synthetic-account-revoked")) }
    }
    fn access_token(&self, account: ExecutionId) -> Result<String, ExecutionError> {
        self.check_active(account)?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok("synthetic-not-an-authentication-secret".into())
    }
}
#[test]
fn subscription_credential_owner_keeps_captured_account_and_revokes_without_fallback() {
    let config = subscription();
    let owner = Arc::new(Credentials { account: config.chatgpt_account.unwrap(), active: AtomicBool::new(true), calls: AtomicUsize::new(0) });
    let service = ProviderService::with_subscription_credentials(owner.clone());
    assert!(service.credential(&config).unwrap().is_some());
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
    let other = AiConfig { chatgpt_account: Some(ExecutionId::new()), ..config.clone() };
    assert!(service.credential(&other).is_err());
    owner.active.store(false, Ordering::SeqCst);
    assert!(service.credential(&config).is_err());
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
    assert!(ProviderService::default().credential(&config).is_err());
    assert!(!serde_json::to_string(&config).unwrap().contains("synthetic-not-an-authentication-secret"));
}

struct CapturedCompletion { dispatch: DispatchRequest, calls: AtomicUsize }
impl CompletionExecutor for CapturedCompletion {
    fn complete(&self, request: DispatchRequest, cancellation: Cancellation,
        _service: Arc<ProviderService>, config: AiConfig, prompt: CompletionPrompt,
    ) -> Result<ProviderCompletion, ExecutionError> {
        assert_eq!(request.input.bytes(), self.dispatch.input.bytes());
        assert_eq!(request.dispatch_token, self.dispatch.dispatch_token);
        assert_eq!(request.deadline(), self.dispatch.deadline());
        assert!(settings(&request.input)?.agent.is_none());
        assert!(!cancellation.is_requested());
        assert!(config.is_chatgpt_subscription());
        assert_eq!(prompt.system, SYSTEM);
        let payload: Value = serde_json::from_str(&prompt.input).unwrap();
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderCompletion { content: json!({"unitId":payload["unitId"],"targetLocale":payload["targetLocale"],"text":"订阅候选"}).to_string(),
            usage: Some(Usage { prompt_tokens: 100, completion_tokens: 20000, cache_read_tokens: Some(40.into()), cache_write_tokens: None, reasoning_tokens: Some(500.into()) }),
            requests: 1, usage_incomplete: false })
    }
}
#[test]
fn ordinary_subscription_completion_uses_original_dispatch_without_agent_binding() {
    let (_temp, _store, mut request) = dispatch(subscription());
    let (budget, _events) = provider::budget_channel();
    request.provider = Some(budget);
    let executor = Arc::new(CapturedCompletion { dispatch: request.clone(), calls: AtomicUsize::new(0) });
    let erased: Arc<dyn CompletionExecutor> = executor.clone();
    let config = settings(&request.input).unwrap().config;
    let service = Arc::new(ProviderService::with_subscription_credentials(Arc::new(Credentials {
        account: config.chatgpt_account.unwrap(), active: AtomicBool::new(true), calls: AtomicUsize::new(0),
    })));
    service.set_completion_executor(Arc::downgrade(&erased)).unwrap();
    let output = AiRunner::with_service(service).execute(&request, &Cancellation::default()).unwrap();
    assert_eq!(output.text, "订阅候选");
    assert_eq!(output.usage.unwrap().completion_tokens, 20000);
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn subscription_completion_capture_uses_existing_budget_and_survives_project_reopen() {
    let (temp, mut store, request) = dispatch(subscription());
    let config = settings(&request.input).unwrap().config;
    let item = item_payload(&request.input, request.item_id).unwrap();
    let prompt = CompletionPrompt::capture(&request_body(&config, &item).unwrap()).unwrap();
    let original = capture(&config, &prompt);
    let mutated = capture(&config, &CompletionPrompt { input: "Other source".into(), ..prompt });
    assert!(store.reserve_provider_request_capture(&request, ExecutionId::new(), config.max_requests, Some(&mutated)).is_err());
    let id = ExecutionId::new();
    store.reserve_provider_request_capture(&request, id, config.max_requests, Some(&original)).unwrap();
    let unknown = store.provider_budget(request.input.envelope().task_id).unwrap().unwrap();
    assert_eq!((unknown.dispatched, unknown.unresolved), (1, 1));
    store.settle_provider_request(&request, id, Some(Usage { prompt_tokens: 100, completion_tokens: 20000,
        cache_read_tokens: Some(30.into()), cache_write_tokens: None, reasoning_tokens: Some(500.into()) })).unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    let budget = reopened.provider_budget(request.input.envelope().task_id).unwrap().unwrap();
    assert_eq!((budget.dispatched, budget.unresolved, budget.usage_unknown), (1, 0, 0));
    assert_eq!(budget.completion_tokens, "20000");
    assert_eq!(budget.cache_read.tokens, "30");
    assert_eq!(budget.reasoning.tokens, "500");
}

#[test]
fn subscription_revocation_preserves_unissued_inflight_and_completed_outcomes() {
    let (_temp, _store, request) = dispatch(subscription());
    let config = settings(&request.input).unwrap().config;
    let owner = Arc::new(Credentials { account: config.chatgpt_account.unwrap(), active: AtomicBool::new(true), calls: AtomicUsize::new(0) });
    let service = ProviderService::with_subscription_credentials(owner.clone());
    service.check_transport_authority(&request, &config, false).unwrap();
    service.check_transport_authority(&request, &config, true).unwrap();
    // Rotating the token is independent of this selected-account identity gate.
    assert!(service.credential(&config).unwrap().is_some());
    assert!(service.credential(&config).unwrap().is_some());
    service.check_transport_authority(&request, &config, true).unwrap();
    owner.active.store(false, Ordering::SeqCst);
    let unissued = service.check_transport_authority(&request, &config, false).unwrap_err();
    assert_eq!(unissued.code, ErrorCode::Unauthorized);
    let issued = service.check_transport_authority(&request, &config, true).unwrap_err();
    assert_eq!((issued.code, issued.stage.as_str()), (ErrorCode::OutcomeUnknown, "ai-service-revoked-after-dispatch"));
    let observed = service.check_completed_authority(&request, &Cancellation::default(), &config).unwrap_err();
    assert_eq!(observed.code, ErrorCode::Unauthorized);
    let cancelled = Cancellation::default(); cancelled.request();
    assert_eq!(service.check_completed_authority(&request, &cancelled, &config).unwrap_err().code, ErrorCode::Cancelled);
}
