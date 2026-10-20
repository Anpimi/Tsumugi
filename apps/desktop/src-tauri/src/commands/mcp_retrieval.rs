//! Explicit discovery and one fixed terminology request to an external MCP server.
//! Project facts and accepted results remain with the original Core owners.
use super::*;
use tsumugi_core::{
    application::{
        McpTermQueryConsent, McpTermQueryPermit, McpTermQueryPreview, McpTermQueryRequest,
        McpTermTool, PreparedMcpTermQuery,
    },
    execution::{ExecutionId, UnsignedDecimal},
};

#[cfg(test)]
mod tests;
pub(in crate::commands) mod transport;
pub(in crate::commands) mod member;

fn required<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn nullable<T: schemars::JsonSchema>(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<T> as schemars::JsonSchema>::json_schema(g)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpRetrievalIdentity {
    pub generation: UnsignedDecimal,
    pub action_id: ExecutionId,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpRetrievalDiscovery {
    pub identity: McpRetrievalIdentity,
    pub endpoint: String,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable::<String>"))]
    pub credential_env: Option<String>,
    pub expires_at_ms: u64,
    pub allow_discovery: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum McpRetrievalPhase {
    Discovering,
    Ready,
    Prepared,
    Enqueued,
    Closed,
    Failed,
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpRetrievalTask {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpRetrievalStop {
    pub identity: McpRetrievalIdentity,
    pub action_id: ExecutionId,
    pub discovery: McpRetrievalDiscovery,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpRetrievalSession {
    pub next_generation: UnsignedDecimal,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpRetrievalIdentity>")
    )]
    pub current: Option<McpRetrievalIdentity>,
    pub lifetime_ms: u32,
    pub max_tools: u32,
    pub max_query_bytes: u32,
    pub max_result_bytes: u32,
    pub max_entries: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpRetrievalView {
    pub identity: McpRetrievalIdentity,
    pub discovery: McpRetrievalDiscovery,
    pub phase: McpRetrievalPhase,
    pub tools: Vec<McpTermTool>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpTermQueryRequest>")
    )]
    pub query: Option<McpTermQueryRequest>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpTermQueryPreview>")
    )]
    pub preview: Option<McpTermQueryPreview>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpTermQueryConsent>")
    )]
    pub consent: Option<McpTermQueryConsent>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpRetrievalTask>")
    )]
    pub task: Option<McpRetrievalTask>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpRetrievalStop>")
    )]
    pub stop: Option<McpRetrievalStop>,
    pub admission_closed: bool,
    pub callbacks_drained: bool,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<CommandError>")
    )]
    pub error: Option<CommandError>,
}
macro_rules! request {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
        pub struct $name {
            pub session_token: String,
            pub project_id: ExecutionId,
            $(pub $field: $ty,)*
        }
    };
}
request!(McpRetrievalDiscoverRequest {
    discovery: McpRetrievalDiscovery
});
request!(McpRetrievalReadRequest {
    identity: McpRetrievalIdentity
});
request!(McpRetrievalPrepareRequest {
    identity: McpRetrievalIdentity,
    query: McpTermQueryRequest
});
request!(McpRetrievalStartRequest {
    identity: McpRetrievalIdentity,
    consent: McpTermQueryConsent
});
request!(McpRetrievalStopRequest {
    stop: McpRetrievalStop
});
request!(McpRetrievalCaptureRequest {
    action_id: ExecutionId,
    attempt_id: ExecutionId,
    result_id: ExecutionId
});
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpRetrievalStopped {
    pub request: McpRetrievalStop,
    pub view: McpRetrievalView,
}

fn failure(code: CommandErrorCode) -> CommandError {
    CommandError::simple(code, CommandStage::ExecutionRead)
}
fn mapped(error: tsumugi_core::execution::ExecutionError) -> CommandError {
    execution::map_execution(error, CommandStage::ExecutionRead)
}
fn now_ms() -> Result<u64, CommandError> {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| failure(CommandErrorCode::StorageFailed))?
            .as_millis(),
    )
    .map_err(|_| failure(CommandErrorCode::StorageFailed))
}

#[derive(Default)]
pub(super) struct Shutdown(Mutex<(bool, Option<Weak<transport::Control>>)>);
impl Shutdown {
    pub(super) fn close(&self) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.0 = true;
        if let Some(control) = state.1.as_ref().and_then(Weak::upgrade) {
            control.close();
        }
    }
    fn install(&self, control: &Arc<transport::Control>) -> Result<(), CommandError> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if state.0 {
            control.close();
            return Err(failure(CommandErrorCode::SessionInvalid));
        }
        if state
            .1
            .as_ref()
            .and_then(Weak::upgrade)
            .is_some_and(|old| !old.drained())
        {
            control.close();
            return Err(failure(CommandErrorCode::Busy));
        }
        state.1 = Some(Arc::downgrade(control));
        Ok(())
    }
}
struct Intent {
    token: String,
    project: ExecutionId,
    view: McpRetrievalView,
    control: Arc<transport::Control>,
    connection: Option<Arc<transport::Connection>>,
    prepared: Option<PreparedMcpTermQuery>,
    permit: Option<McpTermQueryPermit>,
    member_binding: Option<member::Binding>,
}
impl Intent {
    fn close(&mut self) {
        if let Some(binding) = &self.member_binding {
            binding.stop();
        }
        self.close_transport();
    }
    fn close_transport(&mut self) {
        self.control.close();
        if let Some(permit) = &self.permit {
            permit.revoke();
        }
        self.connection = None;
        self.prepared = None;
        self.view.admission_closed = true;
        if !matches!(
            self.view.phase,
            McpRetrievalPhase::Enqueued | McpRetrievalPhase::Failed | McpRetrievalPhase::Unknown
        ) {
            self.view.phase = McpRetrievalPhase::Closed;
        }
    }
    fn view(&mut self, active: &ActiveSession) -> McpRetrievalView {
        if self.control.closed() || self.connection.as_ref().is_some_and(|c| !c.live()) {
            // A successful one-shot call consumes its transport permission.
            // Only an explicit Stop/session closure revokes its separate
            // original member result-sharing guard.
            self.close_transport();
        }
        let mut view = self.view.clone();
        view.callbacks_drained = self.control.drained()
            && view
                .task
                .as_ref()
                .is_none_or(|task| !execution::mcp_retrieval::owned(active, task.attempt_id));
        view
    }
}
pub(super) struct Retrievals {
    shutdown: Arc<Shutdown>,
    next: u64,
    current: Option<Intent>,
    retired: Option<(String, ExecutionId, McpRetrievalView)>,
}
impl Default for Retrievals {
    fn default() -> Self {
        Self::with_shutdown(Arc::default())
    }
}
impl Drop for Retrievals {
    fn drop(&mut self) {
        self.shutdown.close();
        self.close();
    }
}
impl Retrievals {
    pub(super) fn with_shutdown(shutdown: Arc<Shutdown>) -> Self {
        Self {
            shutdown,
            next: 1,
            current: None,
            retired: None,
        }
    }
    pub(super) fn close(&mut self) {
        if let Some(current) = &mut self.current {
            current.close();
        }
    }
    pub(super) fn close_and_check(&mut self) -> Result<(), CommandError> {
        self.close();
        if self
            .current
            .as_ref()
            .is_some_and(|intent| !intent.control.drained())
        {
            return Err(failure(CommandErrorCode::Busy));
        }
        Ok(())
    }
    pub(super) fn active(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|intent| !intent.control.drained())
    }
    fn find_mut(
        &mut self,
        token: &str,
        project: ExecutionId,
        identity: &McpRetrievalIdentity,
    ) -> Result<&mut Intent, CommandError> {
        self.current
            .as_mut()
            .filter(|intent| {
                intent.token == token
                    && intent.project == project
                    && intent.view.identity == *identity
            })
            .ok_or_else(|| failure(CommandErrorCode::ResultMismatch))
    }
    fn read(
        &mut self,
        active: &ActiveSession,
        identity: &McpRetrievalIdentity,
    ) -> Result<McpRetrievalView, CommandError> {
        let expected_project = identity_project(active)?;
        if let Some(intent) = self
            .current
            .as_mut()
            .filter(|intent| intent.token == active.token && intent.view.identity == *identity)
        {
            return Ok(intent.view(active));
        }
        self.retired
            .as_ref()
            .filter(|(token, project, view)| {
                *token == active.token && *project == expected_project && view.identity == *identity
            })
            .map(|(_, _, view)| view.clone())
            .ok_or_else(|| failure(CommandErrorCode::ResultMismatch))
    }
    fn admit(
        &mut self,
        active: &ActiveSession,
        discovery: &McpRetrievalDiscovery,
        stopping: bool,
    ) -> Result<(), CommandError> {
        let project = identity_project(active)?;
        if let Some(intent) = &self.current {
            if intent.view.identity == discovery.identity {
                if intent.token != active.token
                    || intent.project != project
                    || intent.view.discovery != *discovery
                {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
                return Ok(());
            }
        }
        if discovery.identity.generation.get() != self.next {
            return Err(failure(CommandErrorCode::ResultMismatch));
        }
        if self
            .retired
            .as_ref()
            .is_some_and(|(_, _, old)| old.identity.action_id == discovery.identity.action_id)
        {
            return Err(failure(CommandErrorCode::ResultMismatch));
        }
        if let Some(intent) = &mut self.current {
            let old = intent.view(active);
            if !old.admission_closed || !old.callbacks_drained {
                return Err(failure(CommandErrorCode::Busy));
            }
        }
        transport::endpoint(&discovery.endpoint)?;
        if let Some(reference) = &discovery.credential_env {
            if !reference.starts_with("TSUMUGI_MCP_CLIENT_")
                || reference.len() <= "TSUMUGI_MCP_CLIENT_".len()
                || reference.len() > 128
                || !reference
                    .bytes()
                    .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_')
            {
                return Err(failure(CommandErrorCode::PermissionDenied));
            }
        }
        let now = now_ms()?;
        if !discovery.allow_discovery
            || discovery.expires_at_ms == 0
            || discovery.expires_at_ms > now.saturating_add(120_000)
            || !stopping && discovery.expires_at_ms <= now
        {
            return Err(failure(CommandErrorCode::InvalidInput));
        }
        let deadline = std::time::Instant::now()
            .checked_add(std::time::Duration::from_millis(
                discovery.expires_at_ms.saturating_sub(now),
            ))
            .ok_or_else(|| failure(CommandErrorCode::InvalidInput))?;
        let control = transport::Control::new(deadline);
        let next = self
            .next
            .checked_add(1)
            .ok_or_else(|| failure(CommandErrorCode::LimitExceeded))?;
        self.shutdown.install(&control)?;
        if let Some(mut old) = self.current.take() {
            let view = old.view(active);
            self.retired = Some((old.token, old.project, view));
        }
        self.next = next;
        self.current = Some(Intent {
            token: active.token.clone(),
            project,
            control,
            connection: None,
            prepared: None,
            permit: None,
            member_binding: None,
            view: McpRetrievalView {
                identity: discovery.identity.clone(),
                discovery: discovery.clone(),
                phase: McpRetrievalPhase::Discovering,
                tools: Vec::new(),
                query: None,
                preview: None,
                consent: None,
                task: None,
                stop: None,
                admission_closed: false,
                callbacks_drained: false,
                error: None,
            },
        });
        Ok(())
    }
}
fn identity_project(active: &ActiveSession) -> Result<ExecutionId, CommandError> {
    ExecutionId::parse(
        &active
            .store
            .metadata()
            .map_err(|e| map_persistence_error(e, CommandStage::ExecutionRead))?
            .project_id()
            .to_string(),
    )
    .map_err(mapped)
}

#[tauri::command]
pub async fn read_mcp_retrieval_session(
    state: State<'_, AppState>,
    request: execution::SessionRequest,
) -> Result<McpRetrievalSession, CommandError> {
    state
        .sessions
        .run(
            "read_mcp_retrieval_session",
            CommandStage::ExecutionRead,
            move |sessions| {
                execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let retrievals = &sessions.mcp_retrieval;
                Ok(McpRetrievalSession {
                    next_generation: retrievals.next.into(),
                    current: retrievals
                        .current
                        .as_ref()
                        .filter(|v| {
                            v.token == request.session_token && v.project == request.project_id
                        })
                        .map(|v| v.view.identity.clone()),
                    lifetime_ms: 120_000,
                    max_tools: 32,
                    max_query_bytes: 16 * 1024,
                    max_result_bytes: 64 * 1024,
                    max_entries: 100,
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn read_mcp_retrieval(
    state: State<'_, AppState>,
    request: McpRetrievalReadRequest,
) -> Result<McpRetrievalView, CommandError> {
    state
        .sessions
        .run(
            "read_mcp_retrieval",
            CommandStage::ExecutionRead,
            move |sessions| {
                execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                sessions.mcp_retrieval.read(
                    sessions.active.as_ref().expect("authorized session"),
                    &request.identity,
                )
            },
        )
        .await
}
#[tauri::command]
pub async fn discover_mcp_terms(
    state: State<'_, AppState>,
    request: McpRetrievalDiscoverRequest,
) -> Result<McpRetrievalView, CommandError> {
    state
        .sessions
        .run(
            "discover_mcp_terms",
            CommandStage::ExecutionRead,
            move |sessions| {
                execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let active = sessions.active.as_ref().expect("authorized session");
                // Exact original discovery is a status acknowledgement, never another
                // handshake, credential resolution or network retry.
                if sessions
                    .mcp_retrieval
                    .current
                    .as_ref()
                    .is_some_and(|v| v.view.identity == request.discovery.identity)
                {
                    sessions
                        .mcp_retrieval
                        .admit(active, &request.discovery, false)?;
                    return sessions
                        .mcp_retrieval
                        .read(active, &request.discovery.identity);
                }
                if let Some((token, project, view)) = &sessions.mcp_retrieval.retired {
                    if view.identity == request.discovery.identity {
                        if token != &request.session_token
                            || *project != request.project_id
                            || view.discovery != request.discovery
                        {
                            return Err(failure(CommandErrorCode::ResultMismatch));
                        }
                        return Ok(view.clone());
                    }
                }
                if let Some(host) = &active.execution {
                    host.allow_mcp_capture()?;
                }
                let lease = active
                    .services
                    .as_ref()
                    .ok_or_else(|| failure(CommandErrorCode::SessionInvalid))?
                    .callback
                    .reserve_control()?;
                sessions
                    .mcp_retrieval
                    .admit(active, &request.discovery, false)?;
                let intent = sessions
                    .mcp_retrieval
                    .current
                    .as_mut()
                    .expect("accepted discovery");
                let control = intent.control.clone();
                let work = control.work();
                let identity = request.discovery.identity.clone();
                let discovery = request.discovery.clone();
                let token = request.session_token.clone();
                let project = request.project_id;
                tauri::async_runtime::spawn(async move {
                    let _work = work;
                    let result = transport::discover(discovery, control.clone()).await;
                    let completion = lease
                        .run(
                            "mcp_retrieval.discovery_finished",
                            CommandStage::ExecutionCancel,
                            move |sessions| {
                                execution::authorized(
                                    sessions,
                                    &token,
                                    project,
                                    CommandStage::ExecutionCancel,
                                )?;
                                let intent = sessions
                                    .mcp_retrieval
                                    .find_mut(&token, project, &identity)?;
                                match result {
                                    Ok((connection, tools)) if !intent.control.closed() => {
                                        intent.connection = Some(connection);
                                        intent.view.tools = tools;
                                        intent.view.phase = McpRetrievalPhase::Ready;
                                    }
                                    Ok((connection, _)) => {
                                        connection.close();
                                        intent.close();
                                    }
                                    Err(error) => {
                                        intent.close();
                                        intent.view.phase =
                                            if error.code == CommandErrorCode::OutcomeUnknown {
                                                McpRetrievalPhase::Unknown
                                            } else {
                                                McpRetrievalPhase::Failed
                                            };
                                        intent.view.error = Some(error);
                                    }
                                }
                                Ok(())
                            },
                        )
                        .await;
                    if completion.is_err() {
                        control.close();
                    }
                });
                Ok(intent.view(active))
            },
        )
        .await
}
#[tauri::command]
pub async fn prepare_mcp_term_query(
    state: State<'_, AppState>,
    request: McpRetrievalPrepareRequest,
) -> Result<McpRetrievalView, CommandError> {
    state
        .sessions
        .run(
            "prepare_mcp_term_query",
            CommandStage::ExecutionRead,
            move |sessions| {
                execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let active = sessions.active.as_ref().expect("authorized session");
                if let Some(host) = &active.execution {
                    host.allow_mcp_capture()?;
                }
                let intent = sessions.mcp_retrieval.find_mut(
                    &request.session_token,
                    request.project_id,
                    &request.identity,
                )?;
                if let Some(original) = &intent.view.query {
                    if original != &request.query {
                        return Err(failure(CommandErrorCode::ResultMismatch));
                    }
                    return Ok(intent.view(active));
                }
                if intent.control.closed()
                    || intent.view.phase != McpRetrievalPhase::Ready
                    || !intent.connection.as_ref().is_some_and(|c| c.live())
                {
                    return Err(failure(CommandErrorCode::PermissionDenied));
                }
                if request.query.project_id != request.project_id
                    || request.query.expires_at_ms > intent.view.discovery.expires_at_ms
                    || request.query.tool.discovery_expires_at_ms
                        != intent.view.discovery.expires_at_ms
                    || !intent.view.tools.contains(&request.query.tool)
                {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
                let prepared = active
                    .store
                    .prepare_mcp_term_query(&request.query)
                    .map_err(mapped)?;
                intent.view.query = Some(request.query);
                intent.view.preview = Some(prepared.preview().clone());
                intent.view.phase = McpRetrievalPhase::Prepared;
                intent.prepared = Some(prepared);
                Ok(intent.view(active))
            },
        )
        .await
}
#[tauri::command]
pub async fn start_mcp_term_query(
    state: State<'_, AppState>,
    request: McpRetrievalStartRequest,
) -> Result<McpRetrievalView, CommandError> {
    state
        .sessions
        .run(
            "start_mcp_term_query",
            CommandStage::ExecutionRecover,
            move |sessions| {
                execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let active = sessions.active.as_mut().expect("authorized session");
                if !sessions
                    .mcp_retrieval
                    .current
                    .as_ref()
                    .is_some_and(|intent| {
                        intent.token == request.session_token
                            && intent.project == request.project_id
                            && intent.view.identity == request.identity
                    })
                {
                    let saved = active
                        .store
                        .reconcile_mcp_term_query_action(request.project_id, &request.consent)
                        .map_err(mapped)?
                        .ok_or_else(|| failure(CommandErrorCode::ResultMismatch))?;
                    if saved.request.tool.discovery_id != request.identity.action_id
                        || saved.request.tool.discovery_generation != request.identity.generation
                    {
                        return Err(failure(CommandErrorCode::ResultMismatch));
                    }
                    let task = McpRetrievalTask {
                        task_id: saved.request.task_id,
                        attempt_id: saved.request.attempt_id,
                        input_digest: saved.input_digest.clone(),
                    };
                    if let Some((token, project, original)) = &sessions.mcp_retrieval.retired {
                        if token == &request.session_token
                            && *project == request.project_id
                            && original.identity == request.identity
                        {
                            let mut view = original.clone();
                            view.consent = Some(request.consent);
                            view.task = Some(task);
                            view.phase = McpRetrievalPhase::Enqueued;
                            return Ok(view);
                        }
                    }
                    // The ledger proves enqueue, not the lifetime of an old HTTP
                    // connection. No transport, permit, full catalog or drain claim is
                    // reconstructed from this historical data acknowledgement.
                    return Ok(McpRetrievalView {
                        identity: request.identity.clone(),
                        discovery: McpRetrievalDiscovery {
                            identity: request.identity,
                            endpoint: saved.request.tool.endpoint.clone(),
                            credential_env: saved.request.tool.credential_env.clone(),
                            expires_at_ms: saved.request.tool.discovery_expires_at_ms,
                            allow_discovery: true,
                        },
                        phase: McpRetrievalPhase::Enqueued,
                        tools: vec![saved.request.tool.clone()],
                        query: Some(saved.request.clone()),
                        preview: Some(saved),
                        consent: Some(request.consent),
                        task: Some(task),
                        stop: None,
                        admission_closed: true,
                        callbacks_drained: false,
                        error: None,
                    });
                }
                let intent = sessions.mcp_retrieval.find_mut(
                    &request.session_token,
                    request.project_id,
                    &request.identity,
                )?;
                let preview = intent
                    .view
                    .preview
                    .as_ref()
                    .ok_or_else(|| failure(CommandErrorCode::ResultMismatch))?;
                if intent.member_binding.is_some() {
                    return Err(failure(CommandErrorCode::PermissionDenied));
                }
                if request.consent.action_id != preview.request.action_id
                    || request.consent.input_digest != preview.input_digest
                    || request.consent.expires_at_ms != preview.request.expires_at_ms
                    || !request.consent.share_query
                {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
                if let Some(original) = &intent.view.consent {
                    if original != &request.consent {
                        return Err(failure(CommandErrorCode::ResultMismatch));
                    }
                }
                // The original ledger distinguishes accepted enqueue from an unresolved
                // local preparation, including after this connection has been stopped.
                if let Some(saved) = active
                    .store
                    .reconcile_mcp_term_query(
                        request.project_id,
                        preview.request.attempt_id,
                        &request.consent,
                    )
                    .map_err(mapped)?
                {
                    intent.view.consent = Some(request.consent);
                    intent.view.task = Some(McpRetrievalTask {
                        task_id: saved.request.task_id,
                        attempt_id: saved.request.attempt_id,
                        input_digest: saved.input_digest,
                    });
                    intent.view.phase = McpRetrievalPhase::Enqueued;
                    return Ok(intent.view(active));
                }
                if intent.control.closed() || !intent.connection.as_ref().is_some_and(|c| c.live())
                {
                    return Err(failure(CommandErrorCode::PermissionDenied));
                }
                let prepared = intent
                    .prepared
                    .clone()
                    .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
                if intent.permit.is_none() {
                    intent.permit = Some(
                        active
                            .store
                            .authorize_mcp_term_query(&prepared, &request.consent)
                            .map_err(mapped)?,
                    );
                }
                intent.view.consent = Some(request.consent);
                let call = execution::mcp_retrieval::Call::new(
                    prepared,
                    intent.permit.as_ref().expect("original permit").clone(),
                    intent.connection.as_ref().expect("live connection").clone(),
                );
                let task = match execution::mcp_retrieval::start(active, call) {
                    Ok(task) => task,
                    Err(error) => {
                        intent.close();
                        intent.view.error = Some(error.clone());
                        return Err(error);
                    }
                };
                intent.view.task = Some(task);
                intent.view.phase = McpRetrievalPhase::Enqueued;
                Ok(intent.view(active))
            },
        )
        .await
}
#[tauri::command]
pub async fn stop_mcp_retrieval(
    state: State<'_, AppState>,
    request: McpRetrievalStopRequest,
) -> Result<McpRetrievalStopped, CommandError> {
    state
        .sessions
        .run(
            "stop_mcp_retrieval",
            CommandStage::ExecutionCancel,
            move |sessions| {
                execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                if request.stop.identity != request.stop.discovery.identity
                    || request.stop.action_id == request.stop.identity.action_id
                {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
                let active = sessions.active.as_ref().expect("authorized session");
                if let Some((token, project, view)) = &mut sessions.mcp_retrieval.retired {
                    if view.identity == request.stop.identity {
                        if token != &request.session_token
                            || *project != request.project_id
                            || view.discovery != request.stop.discovery
                            || view.stop.as_ref().is_some_and(|old| old != &request.stop)
                        {
                            return Err(failure(CommandErrorCode::ResultMismatch));
                        }
                        view.stop = Some(request.stop.clone());
                        return Ok(McpRetrievalStopped {
                            request: request.stop,
                            view: view.clone(),
                        });
                    }
                }
                sessions
                    .mcp_retrieval
                    .admit(active, &request.stop.discovery, true)?;
                let intent = sessions.mcp_retrieval.find_mut(
                    &request.session_token,
                    request.project_id,
                    &request.stop.identity,
                )?;
                if let Some(original) = &intent.view.stop {
                    if original != &request.stop {
                        return Err(failure(CommandErrorCode::ResultMismatch));
                    }
                }
                intent.view.stop = Some(request.stop.clone());
                intent.close();
                Ok(McpRetrievalStopped {
                    request: request.stop,
                    view: intent.view(active),
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn capture_mcp_glossary(
    state: State<'_, AppState>,
    request: McpRetrievalCaptureRequest,
) -> Result<tsumugi_core::application::McpTermCaptureReceipt, CommandError> {
    let original = request.clone();
    let saved = state
        .sessions
        .run(
            "capture_mcp_glossary.prepare",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                if let Some(saved) = active
                    .store
                    .mcp_term_capture_receipt(request.project_id, request.action_id)
                    .map_err(mapped)?
                {
                    if saved.action.attempt_id != request.attempt_id
                        || saved.action.result_ids != vec![request.result_id]
                    {
                        return Err(failure(CommandErrorCode::ResultMismatch));
                    }
                    return Ok(Some(saved));
                }
                let input = active
                    .store
                    .execution_input(request.attempt_id)
                    .map_err(mapped)?;
                if input.envelope().operation != tsumugi_core::application::MCP_TERM_QUERY_OPERATION
                {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
                if let Some(host) = active.execution.as_ref() {
                    host.allow_mcp_capture()?;
                }
                let unit = input
                    .envelope()
                    .units
                    .first()
                    .ok_or_else(|| failure(CommandErrorCode::ResultMismatch))?
                    .unit_id;
                active
                    .store
                    .prepare_adoption_with_id(
                        request.action_id,
                        request.attempt_id,
                        unit,
                        vec![request.result_id],
                        serde_json::Value::Null,
                    )
                    .map_err(mapped)?;
                Ok(None)
            },
        )
        .await?;
    if let Some(saved) = saved {
        return Ok(saved);
    }
    execution::adopt_execution(
        state.clone(),
        execution::AdoptRequest {
            session_token: original.session_token.clone(),
            project_id: original.project_id,
            action_id: original.action_id,
        },
    )
    .await?;
    state
        .sessions
        .run(
            "capture_mcp_glossary.receipt",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = execution::authorized(
                    sessions,
                    &original.session_token,
                    original.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .mcp_term_capture_receipt(original.project_id, original.action_id)
                    .map_err(mapped)?
                    .ok_or_else(|| CommandError::unknown(CommandStage::ExecutionAdopt))
            },
        )
        .await
}
