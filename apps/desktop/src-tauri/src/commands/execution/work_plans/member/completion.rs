//! Fixed completions use the same Pi process and original Core dispatch. They
//! have no agent lease, tools, team scope or alternate credential channel.
use super::*;
use tsumugi_core::ai::{
    ProviderCompletion,
    provider::{CompletionExecutor, CompletionPrompt},
};

impl CompletionExecutor for MemberFactory {
    fn complete(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        service: Arc<ProviderService>,
        config: AiConfig,
        prompt: CompletionPrompt,
    ) -> Result<ProviderCompletion, ExecutionError> {
        self.executor_runtime()?.block_on(self.run_completion(
            request,
            cancellation,
            service,
            config,
            prompt,
        ))
    }
}

impl MemberFactory {
    async fn run_completion(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        service: Arc<ProviderService>,
        config: AiConfig,
        prompt: CompletionPrompt,
    ) -> Result<ProviderCompletion, ExecutionError> {
        request.check_service_dispatch()?;
        config.validate()?;
        let local_stop = Cancellation::default();
        let deadline = request
            .deadline()
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "member-deadline"))?;
        let admission =
            EnvironmentAdmission::new(deadline, vec![cancellation.clone(), local_stop.clone()]);
        let environment = admission
            .wait(
                || request.check_service_dispatch(),
                || {
                    let plugins = self.owner.context.plugins.clone();
                    let io = self.owner.context.io.clone();
                    let selected = request.clone();
                    let admission = admission.clone();
                    async move {
                        io.run(CommandStage::ExecutionRecover, move || {
                            Ok(EnvironmentAttempt::read_only(
                                plugins.capture_member_environment(None, || {
                                    admission.check().is_ok()
                                        && selected.check_service_dispatch().is_ok()
                                }),
                            ))
                        })
                        .await
                    }
                },
            )
            .await?;
        let revision = environment.settings_revision;
        let settings_stop = admission
            .wait(
                || request.check_service_dispatch(),
                || {
                    let owner = self.owner.clone();
                    let selected = request.clone();
                    let admission = admission.clone();
                    async move {
                        let callback = owner.context.callback.clone();
                        callback
                            .submit(
                                "completion.admit",
                                CommandStage::ExecutionRecover,
                                move |sessions| {
                                    Ok(admission.enter(
                                        &owner.context.plugins,
                                        revision,
                                        || selected.check_service_dispatch(),
                                        |stop| {
                                            let (host, _) = owner.original(sessions)?;
                                            host.allow_mutation()?;
                                            Ok(stop)
                                        },
                                    ))
                                },
                            )?
                            .await
                    }
                },
            )
            .await?;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .and_then(|duration| u32::try_from(duration.as_millis()).ok())
            .map(|remaining| remaining.min(request.input.envelope().limits.timeout_ms))
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| fail(ErrorCode::Cancelled, "member-deadline"))?;
        let profile = tsumugi_core::ai::provider::ProviderProfile::compatible(&config)?;
        let start = MemberFrame {
            protocol_version: wire::PROTOCOL,
            session_id: ExecutionId::new(),
            sequence: 0,
            body: MemberBody::Start {
                // A process identity is not a team member or permission lease.
                member_id: ExecutionId::new(),
                work_item_id: request.item_id,
                context_version: request.input.digest().into(),
                profile: MemberProfile {
                    endpoint: config.endpoint.clone(),
                    model: config.model.clone(),
                    token_field: TokenField::ChatGptSubscription,
                    max_output_tokens: 0,
                    context_tokens: profile.context_tokens,
                },
                system_prompt: prompt.system.clone(),
                context: json!([]),
                input: prompt.input.clone(),
                tools: vec![],
                max_turns: 1,
                timeout_ms: remaining,
            },
        };
        let provider = MemberProviderSession::new_completion(
            service,
            request.clone(),
            local_stop.clone(),
            config.clone(),
            prompt,
        )?;
        let mut handler = CompletionHandler {
            request: request.clone(),
            cancellation: cancellation.clone(),
            local_stop: local_stop.clone(),
            settings_stop: settings_stop.clone(),
            endpoint: config.endpoint,
            provider: Arc::new(Mutex::new(provider)),
            pending: None,
            failure: None,
            usage: BTreeMap::new(),
            events: 0,
            event_bytes: 0,
        };
        let observation = MemberRunObservation::default();
        let result = host_member::run_member_observed(
            &environment.artifact,
            &environment.runtime,
            &environment.staging_parent,
            start,
            MemberLaunchOptions {
                allow_unsandboxed_execution: true,
                cancellation: cancellation.clone(),
                limits: HostLimits::default(),
            },
            &mut handler,
            Arc::new(move || {
                !cancellation.is_requested()
                    && !settings_stop.is_requested()
                    && request.check_service_dispatch().is_ok()
            }),
            &observation,
        )
        .await;
        let cleanup = handler.drain().await;
        let receipt = finish_run(result, cleanup, handler.failure.take(), &observation)?;
        if receipt.turn_limit_reached {
            return Err(fail(ErrorCode::LimitExceeded, "member-turn-limit"));
        }
        let content = assistant_text(&receipt.messages)?;
        let (usage, usage_incomplete) = Handler::total_usage(&handler.usage)?;
        Ok(ProviderCompletion {
            content,
            usage,
            usage_incomplete,
            requests: handler
                .usage
                .len()
                .try_into()
                .map_err(|_| fail(ErrorCode::LimitExceeded, "member-usage"))?,
        })
    }
}

struct CompletionHandler {
    request: DispatchRequest,
    cancellation: Cancellation,
    local_stop: Cancellation,
    settings_stop: Cancellation,
    endpoint: String,
    provider: Arc<Mutex<MemberProviderSession>>,
    pending: Option<tokio::task::JoinHandle<Result<MemberReply, ExecutionError>>>,
    failure: Option<ExecutionError>,
    usage: BTreeMap<ExecutionId, Option<Usage>>,
    events: u32,
    event_bytes: usize,
}
impl CompletionHandler {
    fn live(&self) -> Result<(), ExecutionError> {
        if self.cancellation.is_requested()
            || self.local_stop.is_requested()
            || self.settings_stop.is_requested()
        {
            return Err(fail(ErrorCode::Cancelled, "member-cancelled"));
        }
        self.request.check_service_dispatch()
    }
    async fn provider_call(&mut self, call: MemberCall) -> Result<MemberReply, ExecutionError> {
        let provider = self.provider.clone();
        self.pending = Some(tokio::task::spawn_blocking(move || {
            let mut provider = provider
                .lock()
                .map_err(|_| fail(ErrorCode::StorageFailed, "member-provider"))?;
            match call {
                MemberCall::Prepare { .. } => Ok(MemberReply::Prepared {
                    request_id: provider.prepare()?,
                    shared_view: None,
                }),
                MemberCall::Http {
                    request_id, body, ..
                } => {
                    let response = provider.exchange(request_id, body)?;
                    Ok(MemberReply::Http {
                        request_id,
                        status: response.status,
                        content_type: response.content_type,
                        body: String::from_utf8(response.body)
                            .map_err(|_| fail(ErrorCode::OutputInvalid, "member-response"))?,
                    })
                }
                MemberCall::Usage { request_id, usage } => {
                    provider.settle_usage(request_id, usage)?;
                    Ok(MemberReply::Recorded)
                }
                _ => Err(fail(ErrorCode::Unauthorized, "ai-completion-tool")),
            }
        }));
        let joined = self.pending.as_mut().unwrap().await;
        self.pending.take();
        let result = joined
            .map_err(|_| fail(ErrorCode::OutcomeUnknown, "member-provider"))
            .and_then(|result| result);
        if let Err(error) = &result {
            self.failure.get_or_insert_with(|| error.clone());
        }
        result
    }
    async fn drain(&mut self) -> Result<(), ExecutionError> {
        self.local_stop.request();
        if let Some(pending) = self.pending.take() {
            let result = pending
                .await
                .map_err(|_| fail(ErrorCode::OutcomeUnknown, "member-provider-drain"))?;
            if let Err(error) = result {
                self.failure.get_or_insert(error);
            }
        }
        Ok(())
    }
}
impl MemberHandler for CompletionHandler {
    fn cancellation(&self) -> Cancellation {
        self.local_stop.clone()
    }
    fn handle(
        &mut self,
        call: MemberCall,
    ) -> Pin<Box<dyn Future<Output = Result<MemberReply, ExecutionError>> + Send + '_>> {
        Box::pin(async move {
            self.live()?;
            match call {
                MemberCall::Prepare { messages } => {
                    self.provider_call(MemberCall::Prepare { messages }).await
                }
                MemberCall::Http {
                    request_id,
                    endpoint,
                    body,
                } => {
                    if endpoint != self.endpoint {
                        return Err(fail(ErrorCode::Unauthorized, "member-endpoint"));
                    }
                    let reply = self
                        .provider_call(MemberCall::Http {
                            request_id,
                            endpoint,
                            body,
                        })
                        .await?;
                    self.usage.insert(request_id, None);
                    Ok(reply)
                }
                MemberCall::Usage { request_id, usage } => {
                    let reply = self
                        .provider_call(MemberCall::Usage {
                            request_id,
                            usage: usage.clone(),
                        })
                        .await?;
                    let saved = self
                        .usage
                        .get_mut(&request_id)
                        .ok_or_else(|| fail(ErrorCode::ResultMismatch, "member-usage"))?;
                    if usage.is_some() {
                        *saved = usage;
                    }
                    Ok(reply)
                }
                MemberCall::FinishTurn { stop_reason, .. } => {
                    if stop_reason != "stop" {
                        return Err(fail(ErrorCode::OutputInvalid, "ai-completion-stop"));
                    }
                    Ok(MemberReply::Turn {
                        action: TurnAction::End,
                    })
                }
                MemberCall::Event { event, .. } => {
                    self.events += 1;
                    self.event_bytes = self
                        .event_bytes
                        .checked_add(
                            serde_json::to_vec(&event)
                                .map_err(|_| fail(ErrorCode::InvalidInput, "member-event"))?
                                .len(),
                        )
                        .ok_or_else(|| fail(ErrorCode::LimitExceeded, "member-events"))?;
                    if self.events > 8192 || self.event_bytes > 8 * 1024 * 1024 {
                        return Err(fail(ErrorCode::LimitExceeded, "member-events"));
                    }
                    Ok(MemberReply::Recorded)
                }
                _ => Err(fail(ErrorCode::Unauthorized, "ai-completion-tool")),
            }
        })
    }
}
