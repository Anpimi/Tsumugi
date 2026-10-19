//! Built-in Pi members retain the original project owner, scope, model budget
//! and independently consented tool boundary. No plugin caller is fabricated.
use super::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    future::Future,
    pin::Pin,
    sync::{Mutex, OnceLock},
};
use tsumugi_core::{
    ai::{
        AiOutput, Usage,
        member::{MemberExecutor, MemberSeed},
        member_wire::{
            self as wire, MemberBody, MemberCall, MemberFrame, MemberProfile, MemberReply,
            MemberTool, TokenField, TurnAction,
        },
        provider::{MemberProviderSession, ProviderService},
    },
    application::{AgentToolRequest, WorkPlanAgentExecutionBinding, WorkPlanToolSpec},
};
use tsumugi_plugin_host::{
    HostError,
    member::{self as host_member, MemberHandler, MemberLaunchOptions},
};

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn command_error(error: CommandError) -> ExecutionError {
    let code = match error.code {
        CommandErrorCode::Busy => ErrorCode::Busy,
        CommandErrorCode::StorageFailed => ErrorCode::StorageFailed,
        CommandErrorCode::OutcomeUnknown => ErrorCode::OutcomeUnknown,
        CommandErrorCode::LimitExceeded => ErrorCode::LimitExceeded,
        CommandErrorCode::Cancelled => ErrorCode::Cancelled,
        CommandErrorCode::InvalidInput => ErrorCode::InvalidInput,
        CommandErrorCode::ResultMismatch => ErrorCode::ResultMismatch,
        CommandErrorCode::DependencyConflict => ErrorCode::DependencyConflict,
        _ => ErrorCode::Unauthorized,
    };
    fail(code, "member-owner")
}
fn host_error(error: HostError) -> ExecutionError {
    fail(
        match error {
            HostError::Cancelled | HostError::AuthorityRevoked => ErrorCode::Cancelled,
            HostError::Timeout | HostError::Crashed | HostError::ChannelFailed => {
                ErrorCode::OutcomeUnknown
            }
            HostError::OutputLimit => ErrorCode::LimitExceeded,
            _ => ErrorCode::OutputInvalid,
        },
        "member-process",
    )
}

#[derive(Clone)]
struct Owner {
    context: ProjectServiceContext,
    token: String,
    project: ExecutionId,
    generation: ExecutionId,
}
impl Owner {
    fn original<'a>(
        &self,
        sessions: &'a mut SessionManager,
    ) -> Result<(&'a mut ExecutionHost, &'a mut ProjectStore), CommandError> {
        let active = authorized(
            sessions,
            &self.token,
            self.project,
            CommandStage::ExecutionRecover,
        )?;
        let host = active
            .execution
            .as_mut()
            .ok_or_else(|| map_recover(fail(ErrorCode::Unauthorized, "member-session")))?;
        if host.runtime.generation() != self.generation {
            return Err(map_recover(fail(ErrorCode::Unauthorized, "member-session")));
        }
        Ok((host, &mut active.store))
    }
    fn capture(
        &self,
        sessions: &mut SessionManager,
        request: &DispatchRequest,
        seed: &MemberSeed,
    ) -> Result<CapturedScope, CommandError> {
        let (host, store) = self.original(sessions)?;
        host.allow_mutation()?;
        request.check_service_dispatch().map_err(map_recover)?;
        let binding = seed.binding();
        let (scope_id, scope) = host
            .work_plans
            .agent_scopes
            .iter()
            .find(|(_, scope)| matches_scope(scope, binding))
            .map(|(id, scope)| (*id, scope.clone()))
            .ok_or_else(|| map_recover(fail(ErrorCode::Unauthorized, "member-scope")))?;
        store
            .check_work_plan_agent_scope(&scope)
            .map_err(map_recover)?;
        let tools = effective_tools(store, &scope)?;
        let consent = if tools.is_empty() {
            None
        } else {
            let consent = broker::current_consent(host, store, &scope)?;
            let guidance = store
                .capture_work_plan_agent_guidance(&scope)
                .map_err(map_recover)?;
            if guidance.tools() != tools {
                return Err(map_recover(fail(ErrorCode::Unauthorized, "member-tools")));
            }
            Some(consent)
        };
        let mut revisions = BTreeSet::new();
        for tool in &tools {
            if tool.binding.capability.declaration.effect != sdk::EffectKind::ReadOnly
                || tool.binding.declaration.query.is_none()
            {
                return Err(map_recover(fail(ErrorCode::Unauthorized, "member-tool")));
            }
            revisions.insert(tool.settings_revision);
        }
        if revisions.len() > 1 {
            return Err(map_recover(fail(
                ErrorCode::DependencyConflict,
                "member-tool-revision",
            )));
        }
        Ok(CapturedScope {
            scope_id,
            scope,
            consent,
            tools,
            tool_revision: revisions.into_iter().next(),
        })
    }
    fn check_scope(
        &self,
        sessions: &mut SessionManager,
        captured: &CapturedScope,
    ) -> Result<(), CommandError> {
        let (host, store) = self.original(sessions)?;
        host.allow_mutation()?;
        if agent::scope(host, store, captured.scope_id)? != captured.scope
            || effective_tools(store, &captured.scope)? != captured.tools
        {
            return Err(map_recover(fail(ErrorCode::Unauthorized, "member-scope")));
        }
        if let Some(consent) = &captured.consent {
            if !Arc::ptr_eq(
                &broker::current_consent(host, store, &captured.scope)?,
                consent,
            ) || store
                .capture_work_plan_agent_guidance(&captured.scope)
                .map_err(map_recover)?
                .tools()
                != captured.tools
            {
                return Err(map_recover(fail(ErrorCode::Unauthorized, "member-scope")));
            }
        }
        Ok(())
    }
}
fn effective_tools(
    store: &ProjectStore,
    scope: &WorkPlanAgentScope,
) -> Result<Vec<WorkPlanToolSpec>, CommandError> {
    let plan = store
        .work_plan(scope.lease().plan_id)
        .map_err(map_recover)?;
    Ok(plan
        .tools
        .into_iter()
        .flat_map(|tools| tools.entries)
        .filter(|tool| {
            scope
                .delegation()
                .is_none_or(|subset| subset.tool_handles.contains(&tool.handle))
        })
        .collect())
}
fn matches_scope(scope: &WorkPlanAgentScope, binding: &WorkPlanAgentExecutionBinding) -> bool {
    scope.lease() == binding.lease
        && scope.parent_task() == binding.root_task
        && scope.caller_id() == binding.caller_id
        && scope.delegation() == binding.delegation.as_ref()
}
#[derive(Clone)]
struct CapturedScope {
    scope_id: ExecutionId,
    scope: WorkPlanAgentScope,
    consent: Option<Arc<WorkPlanToolConsent>>,
    tools: Vec<WorkPlanToolSpec>,
    tool_revision: Option<UnsignedDecimal>,
}

pub(in crate::commands::execution) struct MemberFactory {
    owner: Owner,
    runtime: OnceLock<tokio::runtime::Runtime>,
}
impl MemberFactory {
    pub(in crate::commands::execution) fn new(
        context: ProjectServiceContext,
        token: String,
        project: ExecutionId,
        generation: ExecutionId,
    ) -> Self {
        Self {
            owner: Owner {
                context,
                token,
                project,
                generation,
            },
            runtime: OnceLock::new(),
        }
    }
    async fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        service: Arc<ProviderService>,
    ) -> Result<AiOutput, ExecutionError> {
        let seed = MemberSeed::capture(&request)?;
        let owner = self.owner.clone();
        let selected = request.clone();
        let capture_seed = seed.clone();
        let captured = self
            .owner
            .context
            .callback
            .submit(
                "member.capture",
                CommandStage::ExecutionRecover,
                move |sessions| owner.capture(sessions, &selected, &capture_seed),
            )
            .map_err(command_error)?
            .await
            .map_err(command_error)?;
        let plugins = self.owner.context.plugins.clone();
        let revision = captured.tool_revision;
        let environment = self
            .owner
            .context
            .io
            .run(CommandStage::ExecutionRecover, move || {
                plugins.capture_member_environment(revision)
            })
            .await
            .map_err(command_error)?;
        let owner = self.owner.clone();
        let checking = captured.clone();
        let runtime_revision = environment.settings_revision;
        let settings_stop = self
            .owner
            .context
            .callback
            .submit(
                "member.admit",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    owner
                        .context
                        .plugins
                        .with_environment_authority(runtime_revision, |stop| {
                            owner.check_scope(sessions, &checking)?;
                            Ok(stop)
                        })
                },
            )
            .map_err(command_error)?
            .await
            .map_err(command_error)?;
        let local_stop = Cancellation::default();
        let deadline = request
            .deadline()
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "member-deadline"))?;
        let deadline = captured
            .consent
            .as_ref()
            .map_or(deadline, |consent| deadline.min(consent.deadline()));
        let remaining: u32 = deadline
            .checked_duration_since(Instant::now())
            .and_then(|d| u32::try_from(d.as_millis()).ok())
            .map(|remaining| remaining.min(request.input.envelope().limits.timeout_ms))
            .filter(|n| *n > 0)
            .ok_or_else(|| fail(ErrorCode::Cancelled, "member-deadline"))?;
        let profile = tsumugi_core::ai::provider::ProviderProfile::compatible(seed.config())?;
        let roster = captured.tools.iter().map(|tool| MemberTool {
            name: tool_name(tool.handle), description: tool.binding.declaration.description.clone(),
            parameters: json!({"type":"object","properties":{"unitId":{"type":"string","enum":[seed.item().unit_id]}},
                "required":["unitId"],"additionalProperties":false}),
        }).collect();
        let start = MemberFrame {
            protocol_version: wire::PROTOCOL,
            session_id: ExecutionId::new(),
            sequence: 0,
            body: MemberBody::Start {
                member_id: seed.binding().caller_id,
                work_item_id: request.item_id,
                context_version: request.input.digest().into(),
                profile: MemberProfile {
                    endpoint: seed.config().endpoint.clone(),
                    model: seed.config().model.clone(),
                    token_field: if seed.config().token_field == "max_tokens" {
                        TokenField::MaxTokens
                    } else {
                        TokenField::MaxCompletionTokens
                    },
                    max_output_tokens: seed.config().max_output_tokens,
                    context_tokens: profile.context_tokens,
                },
                system_prompt: seed.system().into(),
                context: json!([]),
                input: seed.input().into(),
                tools: roster,
                max_turns: seed.config().max_requests.min(128),
                timeout_ms: remaining,
            },
        };
        let mut handler = Handler {
            owner: self.owner.clone(),
            captured,
            request: request.clone(),
            cancellation: cancellation.clone(),
            local_stop: local_stop.clone(),
            settings_stop: settings_stop.clone(),
            runtime_revision,
            provider: Arc::new(Mutex::new(MemberProviderSession::new(
                service,
                request.clone(),
                local_stop.clone(),
            )?)),
            pending: None,
            pending_provider: false,
            provider_failure: None,
            join_failure: None,
            usage: BTreeMap::new(),
            tool_results: BTreeMap::new(),
            tools: Arc::new(Mutex::new(BTreeMap::new())),
            events: 0,
            event_bytes: 0,
        };
        let live_request = request.clone();
        let live_cancel = cancellation.clone();
        let live_settings = settings_stop;
        let result = host_member::run_member(
            &environment.artifact,
            &environment.runtime,
            &environment.staging_parent,
            start,
            MemberLaunchOptions {
                allow_unsandboxed_execution: true,
                cancellation,
                limits: HostLimits::default(),
            },
            &mut handler,
            Arc::new(move || {
                !live_cancel.is_requested()
                    && !live_settings.is_requested()
                    && live_request.check_service_dispatch().is_ok()
            }),
        )
        .await;
        let cleanup = handler.drain().await;
        let failure = handler
            .join_failure
            .take()
            .or_else(|| handler.provider_failure.take());
        let receipt = finish_run(result, cleanup, failure)?;
        if receipt.turn_limit_reached {
            return Err(fail(ErrorCode::LimitExceeded, "member-turn-limit"));
        }
        let text = assistant_text(&receipt.messages)?;
        let (usage, incomplete) = handler.total_usage()?;
        seed.validate_output(
            &text,
            usage,
            handler
                .usage
                .len()
                .try_into()
                .map_err(|_| fail(ErrorCode::LimitExceeded, "member-usage"))?,
            incomplete,
        )
    }
}

fn finish_run(
    process: Result<host_member::MemberRunReceipt, HostError>,
    cleanup: Result<(), ExecutionError>,
    failure: Option<ExecutionError>,
) -> Result<host_member::MemberRunReceipt, ExecutionError> {
    cleanup.map_err(|mut error| {
        // A process cancellation does not establish its nested producers'
        // terminality. Preserve their records and expose the uncertainty.
        error.code = ErrorCode::OutcomeUnknown;
        error.stage = "member-cleanup".into();
        error
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    process.map_err(host_error)
}
impl MemberExecutor for MemberFactory {
    fn execute(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        service: Arc<ProviderService>,
    ) -> Result<AiOutput, ExecutionError> {
        if self.runtime.get().is_none() {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(|_| fail(ErrorCode::DependencyConflict, "member-runtime"))?;
            let _ = self.runtime.set(runtime);
        }
        self.runtime
            .get()
            .unwrap()
            .block_on(self.run(request, cancellation, service))
    }
}

fn tool_name(handle: ExecutionId) -> String {
    format!("tool_{}", handle.to_string().replace('-', "_"))
}
fn assistant_text(messages: &Value) -> Result<String, ExecutionError> {
    let message = messages
        .as_array()
        .and_then(|rows| rows.last())
        .ok_or_else(|| fail(ErrorCode::OutputInvalid, "member-result"))?;
    if message["role"] != "assistant" || message["stopReason"] != "stop" {
        return Err(fail(ErrorCode::OutputInvalid, "member-result"));
    }
    let mut text = String::new();
    for part in message["content"]
        .as_array()
        .ok_or_else(|| fail(ErrorCode::OutputInvalid, "member-result"))?
    {
        if part["type"] != "text" {
            return Err(fail(ErrorCode::OutputInvalid, "member-result"));
        }
        text.push_str(
            part["text"]
                .as_str()
                .ok_or_else(|| fail(ErrorCode::OutputInvalid, "member-result"))?,
        );
        if text.len() > 65536 {
            return Err(fail(ErrorCode::LimitExceeded, "member-result"));
        }
    }
    Ok(text)
}

#[derive(Clone)]
struct ToolRun {
    request: broker::WorkPlanAgentToolStartRequest,
    cancel_id: ExecutionId,
}
struct Handler {
    owner: Owner,
    captured: CapturedScope,
    request: DispatchRequest,
    cancellation: Cancellation,
    local_stop: Cancellation,
    settings_stop: Cancellation,
    runtime_revision: UnsignedDecimal,
    provider: Arc<Mutex<MemberProviderSession>>,
    pending: Option<tokio::task::JoinHandle<Result<MemberReply, ExecutionError>>>,
    pending_provider: bool,
    provider_failure: Option<ExecutionError>,
    join_failure: Option<ExecutionError>,
    usage: BTreeMap<ExecutionId, Option<Usage>>,
    tool_results: BTreeMap<String, (Value, bool)>,
    tools: Arc<Mutex<BTreeMap<String, ToolRun>>>,
    events: u32,
    event_bytes: usize,
}
impl Handler {
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
        self.pending_provider = true;
        self.pending = Some(tokio::task::spawn_blocking(move || {
            let mut provider = provider
                .lock()
                .map_err(|_| fail(ErrorCode::StorageFailed, "member-provider"))?;
            match call {
                MemberCall::Prepare { .. } => Ok(MemberReply::Prepared {
                    request_id: provider.prepare()?,
                }),
                MemberCall::Http {
                    request_id, body, ..
                } => {
                    let response = provider.exchange(request_id, body)?;
                    Ok(MemberReply::Http {
                        request_id: response.request_id,
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
                _ => Err(fail(ErrorCode::InvalidInput, "member-provider")),
            }
        }));
        let result = self.pending.as_mut().unwrap().await;
        self.pending.take();
        let result = result.map_err(|_| {
            let error = fail(ErrorCode::OutcomeUnknown, "member-provider");
            self.join_failure.get_or_insert_with(|| error.clone());
            error
        })?;
        self.record_provider_failure(&result);
        result
    }
    fn record_provider_failure(&mut self, result: &Result<MemberReply, ExecutionError>) {
        if let Err(error) = result {
            // Only this trusted Core boundary supplies authoritative failures.
            // A child error string or an ordinary domain tool error cannot.
            self.provider_failure.get_or_insert_with(|| error.clone());
        }
    }
    fn selected_tool(
        &self,
        name: &str,
        arguments: &Value,
    ) -> Result<&WorkPlanToolSpec, ExecutionError> {
        let arguments = arguments
            .as_object()
            .filter(|args| args.len() == 1)
            .ok_or_else(|| fail(ErrorCode::InvalidInput, "member-tool-arguments"))?;
        let unit =
            tsumugi_core::ai::item_payload(&self.request.input, self.request.item_id)?.unit_id;
        if arguments.get("unitId") != Some(&json!(unit)) {
            return Err(fail(ErrorCode::Unauthorized, "member-tool-unit"));
        }
        self.captured
            .tools
            .iter()
            .find(|tool| tool_name(tool.handle) == name)
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "member-tool-handle"))
    }
    async fn check_scope(&self) -> Result<(), ExecutionError> {
        let owner = self.owner.clone();
        let captured = self.captured.clone();
        let revision = self.runtime_revision;
        self.owner
            .context
            .callback
            .submit(
                "member.scope",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    owner
                        .context
                        .plugins
                        .with_environment_revision(revision, || {
                            owner.check_scope(sessions, &captured)
                        })
                },
            )
            .map_err(command_error)?
            .await
            .map_err(command_error)
    }
    async fn execute_tool(
        &mut self,
        call_id: String,
        name: String,
        arguments: Value,
    ) -> Result<MemberReply, ExecutionError> {
        self.live()?;
        let handle = self.selected_tool(&name, &arguments)?.handle;
        let operation = ToolOperation {
            owner: self.owner.clone(),
            captured: self.captured.clone(),
            request: self.request.clone(),
            cancellation: self.cancellation.clone(),
            local_stop: self.local_stop.clone(),
            settings_stop: self.settings_stop.clone(),
            tools: self.tools.clone(),
        };
        self.pending_provider = false;
        self.pending = Some(tokio::spawn(
            async move { operation.run(call_id, handle).await },
        ));
        let result = self.pending.as_mut().unwrap().await;
        self.pending.take();
        result.map_err(|_| {
            let error = fail(ErrorCode::OutcomeUnknown, "member-tool-operation");
            self.join_failure.get_or_insert_with(|| error.clone());
            error
        })?
    }
    async fn drain(&mut self) -> Result<(), ExecutionError> {
        self.local_stop.request();
        if let Some(pending) = self.pending.take() {
            let result = pending
                .await
                .map_err(|_| fail(ErrorCode::OutcomeUnknown, "member-provider-drain"))?;
            if self.pending_provider {
                self.record_provider_failure(&result);
            }
        }
        let tools = self
            .tools
            .lock()
            .map_err(|_| fail(ErrorCode::StorageFailed, "member-tools"))?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        if tools.is_empty() {
            return Ok(());
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let owner = self.owner.clone();
            let calls = tools.clone();
            let pending = self
                .owner
                .context
                .callback
                .submit(
                    "member.tool.drain",
                    CommandStage::ExecutionCancel,
                    move |sessions| {
                        let (host, store) = owner.original(sessions)?;
                        let mut pending = false;
                        for call in calls {
                            let attempt = call.request.tool.attempt_id;
                            let Some(_) = store
                                .execution_input_if_present(attempt)
                                .map_err(map_read)?
                            else {
                                continue;
                            };
                            let detail =
                                store.execution_attempt(attempt, false).map_err(map_read)?;
                            let active = host.runtime.has_owned_attempt_work(attempt)
                                || detail.items.iter().any(|item| {
                                    matches!(
                                        item.execution,
                                        ExecutionState::Queued | ExecutionState::Dispatched
                                    )
                                });
                            if active {
                                host.runtime
                                    .cancel(store, call.request.tool.task_id, call.cancel_id)
                                    .map_err(map_recover)?;
                                pending = true;
                            }
                        }
                        Ok(pending)
                    },
                )
                .map_err(command_error)?
                .await
                .map_err(command_error)?;
            if !pending {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(fail(ErrorCode::OutcomeUnknown, "member-tool-drain"));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    fn total_usage(&self) -> Result<(Option<Usage>, bool), ExecutionError> {
        let mut total = None;
        let mut incomplete = false;
        for usage in self.usage.values() {
            if let Some(usage) = usage {
                let accumulated = total.get_or_insert(Usage {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                });
                accumulated.prompt_tokens = accumulated
                    .prompt_tokens
                    .checked_add(usage.prompt_tokens)
                    .ok_or_else(|| fail(ErrorCode::LimitExceeded, "member-usage"))?;
                accumulated.completion_tokens = accumulated
                    .completion_tokens
                    .checked_add(usage.completion_tokens)
                    .ok_or_else(|| fail(ErrorCode::LimitExceeded, "member-usage"))?;
            } else {
                incomplete = true;
            }
        }
        Ok((total, incomplete))
    }
}

struct ToolOperation {
    owner: Owner,
    captured: CapturedScope,
    request: DispatchRequest,
    cancellation: Cancellation,
    local_stop: Cancellation,
    settings_stop: Cancellation,
    tools: Arc<Mutex<BTreeMap<String, ToolRun>>>,
}
impl ToolOperation {
    fn live(&self) -> Result<(), ExecutionError> {
        if self.cancellation.is_requested()
            || self.local_stop.is_requested()
            || self.settings_stop.is_requested()
        {
            return Err(fail(ErrorCode::Cancelled, "member-cancelled"));
        }
        self.request.check_service_dispatch()
    }
    async fn run(
        &self,
        call_id: String,
        handle: ExecutionId,
    ) -> Result<MemberReply, ExecutionError> {
        self.live()?;
        if self
            .tools
            .lock()
            .map_err(|_| fail(ErrorCode::StorageFailed, "member-tools"))?
            .contains_key(&call_id)
        {
            return Err(fail(ErrorCode::ResultMismatch, "member-tool-call"));
        }
        let tool = AgentToolRequest {
            task_id: ExecutionId::new(),
            attempt_id: ExecutionId::new(),
            tool_handle: handle,
            unit_ids: vec![
                tsumugi_core::ai::item_payload(&self.request.input, self.request.item_id)?.unit_id,
            ],
        };
        let owner = self.owner.clone();
        let captured = self.captured.clone();
        let query = tool.clone();
        let digest = self
            .owner
            .context
            .callback
            .submit(
                "member.tool.prepare",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    owner.check_scope(sessions, &captured)?;
                    let (_, store) = owner.original(sessions)?;
                    Ok(store
                        .prepare_work_plan_agent_tool(&captured.scope, &query)
                        .map_err(map_recover)?
                        .input()
                        .digest()
                        .to_owned())
                },
            )
            .map_err(command_error)?
            .await
            .map_err(command_error)?;
        let request = broker::WorkPlanAgentToolStartRequest {
            session_token: self.owner.token.clone(),
            project_id: self.owner.project,
            scope_id: self.captured.scope_id,
            tool,
            input_digest: digest,
        };
        let run = ToolRun {
            request: request.clone(),
            cancel_id: ExecutionId::new(),
        };
        // Retain identity before admitting any enqueue, including uncertain ACKs.
        self.tools
            .lock()
            .map_err(|_| fail(ErrorCode::StorageFailed, "member-tools"))?
            .insert(call_id, run.clone());
        let initial = request.clone();
        let admitted = self
            .owner
            .context
            .callback
            .submit(
                "member.tool.begin",
                CommandStage::ExecutionRecover,
                move |sessions| broker::begin_agent_tool(sessions, &initial),
            )
            .map_err(command_error)?
            .await
            .map_err(command_error)?;
        if let Some((ticket, prepared, consent)) = admitted {
            let current = self.owner.context.plugins.clone();
            let captured = prepared.clone();
            let deadline = self
                .request
                .deadline()
                .ok_or_else(|| fail(ErrorCode::Unauthorized, "member-deadline"))?
                .min(consent.deadline());
            let stop = self.local_stop.clone();
            let loaded = self
                .owner
                .context
                .io
                .run(CommandStage::ExecutionRecover, move || {
                    let loaded = broker::load_runner(&current, &captured)?;
                    broker::ensure_application_ready(&current, &captured, deadline, &stop)?;
                    Ok(loaded)
                })
                .await;
            let owner = self.owner.clone();
            let scope = self.captured.clone();
            let local = self.local_stop.clone();
            let settings = self.settings_stop.clone();
            let cancelled = self.cancellation.clone();
            self.owner
                .context
                .callback
                .submit(
                    "member.tool.finish",
                    CommandStage::ExecutionRecover,
                    move |sessions| {
                        let loaded = if local.is_requested()
                            || settings.is_requested()
                            || cancelled.is_requested()
                        {
                            Err(map_recover(fail(ErrorCode::Cancelled, "member-tool")))
                        } else {
                            owner.check_scope(sessions, &scope).and(loaded)
                        };
                        broker::finish_agent_tool(
                            sessions,
                            &owner.context.plugins,
                            request,
                            ticket,
                            prepared,
                            consent,
                            loaded,
                        )
                    },
                )
                .map_err(command_error)?
                .await
                .map_err(command_error)?;
        }
        loop {
            self.live()?;
            let owner = self.owner.clone();
            let captured = self.captured.clone();
            let reading = run.clone();
            let outcome = self
                .owner
                .context
                .callback
                .submit(
                    "member.tool.read",
                    CommandStage::ExecutionRead,
                    move |sessions| {
                        owner.check_scope(sessions, &captured)?;
                        let (host, store) = owner.original(sessions)?;
                        let attempt = reading.request.tool.attempt_id;
                        if host.runtime.has_owned_attempt_work(attempt) {
                            return Ok(None);
                        }
                        let input = store.execution_input(attempt).map_err(map_read)?;
                        let item = input.envelope().items[0].item_id;
                        if let Some(result) = store
                            .execution_current_result(attempt, item)
                            .map_err(map_read)?
                        {
                            let result = store
                                .read_work_plan_agent_tool_output(
                                    &captured.scope,
                                    &reading.request.tool,
                                    &reading.request.input_digest,
                                    item,
                                    result,
                                )
                                .map_err(map_read)?;
                            return Ok(Some(
                                result
                                    .envelope()
                                    .plugin
                                    .as_ref()
                                    .ok_or_else(|| {
                                        map_read(fail(ErrorCode::OutputInvalid, "member-tool"))
                                    })?
                                    .result
                                    .outcome
                                    .clone(),
                            ));
                        }
                        let detail = store.execution_attempt(attempt, false).map_err(map_read)?;
                        if detail.items.iter().all(|item| {
                            !matches!(
                                item.execution,
                                ExecutionState::Queued | ExecutionState::Dispatched
                            )
                        }) {
                            return Err(map_read(fail(ErrorCode::OutputInvalid, "member-tool")));
                        }
                        Ok(None)
                    },
                )
                .map_err(command_error)?
                .await
                .map_err(command_error)?;
            if let Some(outcome) = outcome {
                let (payload, is_error) = match outcome {
                    sdk::InvocationOutcome::Succeeded { output } => (output, false),
                    sdk::InvocationOutcome::Failed { error } => (error, true),
                    _ => return Err(fail(ErrorCode::OutputInvalid, "member-tool")),
                };
                return Ok(MemberReply::ToolResult {
                    content: json!([{"type":"text","text":payload.utf8}]),
                    details: json!({"taskId":run.request.tool.task_id,"attemptId":run.request.tool.attempt_id}),
                    is_error,
                });
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
impl MemberHandler for Handler {
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
                    self.check_scope().await?;
                    self.provider_call(MemberCall::Prepare { messages }).await
                }
                MemberCall::Http {
                    request_id,
                    endpoint,
                    body,
                } => {
                    self.check_scope().await?;
                    if endpoint
                        != tsumugi_core::ai::settings(&self.request.input)?
                            .config
                            .endpoint
                    {
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
                    let recorded = self
                        .usage
                        .get_mut(&request_id)
                        .ok_or_else(|| fail(ErrorCode::ResultMismatch, "member-usage"))?;
                    if usage.is_some() {
                        *recorded = usage;
                    }
                    Ok(reply)
                }
                MemberCall::BeforeTool {
                    name, arguments, ..
                } => {
                    self.selected_tool(&name, &arguments)?;
                    self.check_scope().await?;
                    Ok(MemberReply::ToolAdmission {
                        block: false,
                        reason: None,
                    })
                }
                MemberCall::ExecuteTool {
                    request_id,
                    call_id,
                    name,
                    arguments,
                    ..
                } => {
                    let key = format!("{request_id}:{call_id}");
                    let reply = self.execute_tool(key.clone(), name, arguments).await?;
                    if let MemberReply::ToolResult {
                        content, is_error, ..
                    } = &reply
                    {
                        self.tool_results.insert(key, (content.clone(), *is_error));
                    }
                    Ok(reply)
                }
                MemberCall::AfterTool {
                    request_id,
                    call_id,
                    ..
                } => {
                    self.check_scope().await?;
                    let (content, is_error) = self
                        .tool_results
                        .get(&format!("{request_id}:{call_id}"))
                        .ok_or_else(|| fail(ErrorCode::ResultMismatch, "member-tool-result"))?;
                    Ok(MemberReply::ToolFinalized {
                        content: Some(content.clone()),
                        is_error: Some(*is_error),
                    })
                }
                MemberCall::FinishTurn { .. } => Ok(MemberReply::Turn {
                    action: TurnAction::Normal,
                }),
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
                    // Ephemeral acknowledgement only. Durable team discussions
                    // and canonical multi-member views have their own owner.
                    Ok(MemberReply::Recorded)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_cleanup_unconfirmed_producer_takes_precedence_over_process_cancellation() {
        let error = finish_run(
            Err(HostError::Cancelled),
            Err(fail(ErrorCode::Unauthorized, "owner-unavailable")),
            Some(fail(ErrorCode::LimitExceeded, "ai-budget")),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, ErrorCode::OutcomeUnknown);
        assert_eq!(error.stage, "member-cleanup");
    }

    #[test]
    fn member_cleanup_confirmed_producers_preserve_process_cancellation() {
        let error = finish_run(Err(HostError::Cancelled), Ok(()), None)
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.stage, "member-process");

        let mut provider = fail(ErrorCode::LimitExceeded, "ai-budget");
        provider.item_ids.push(ExecutionId::new());
        assert_eq!(
            finish_run(
                Err(HostError::ResultMismatch),
                Ok(()),
                Some(provider.clone()),
            )
            .err()
            .unwrap(),
            provider,
        );
    }
}
