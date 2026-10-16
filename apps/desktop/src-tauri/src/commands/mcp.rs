//! Explicit, ephemeral disclosure to one independently paired MCP recipient.
use super::*;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tsumugi_core::{
    application::{CapturedMcpShare, McpSharePreview, McpShareRequest},
    execution::{ExecutionId, Revision, UnsignedDecimal},
};
#[cfg(test)]
mod tests;
mod transport;

pub(super) const MAX_READS: u32 = 100;
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
fn failure(code: CommandErrorCode) -> CommandError {
    CommandError::simple(code, CommandStage::ExecutionRead)
}
fn required<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn nullable<T: schemars::JsonSchema>(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<T> as schemars::JsonSchema>::json_schema(g)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareIdentity {
    pub owner_id: ExecutionId,
    pub generation: Revision,
    pub share_id: ExecutionId,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharePreparation {
    pub identity: McpShareIdentity,
    pub recipient_label: String,
    pub selection: McpShareRequest,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareAuthorization {
    pub identity: McpShareIdentity,
    pub action_id: ExecutionId,
    pub preview_digest: String,
    #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 600)))]
    pub valid_for_seconds: u32,
    pub confirmed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharePrepared {
    pub preparation: McpSharePreparation,
    pub preview: McpSharePreview,
}

// This response contains a bearer credential. It is never a normal status query,
// diagnostic, project field or model input, and deliberately has no Debug impl.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareConfiguration {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareAuthorized {
    pub view: McpShareView,
    pub configuration: McpShareConfiguration,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum McpSharePhase {
    Prepared,
    AwaitingPairing,
    Connected,
    Closing,
    Closed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareView {
    pub identity: McpShareIdentity,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpSharePreparation>")
    )]
    pub preparation: Option<McpSharePreparation>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable::<String>"))]
    pub preview_digest: Option<String>,
    pub phase: McpSharePhase,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<McpShareAuthorization>")
    )]
    pub authorization: Option<McpShareAuthorization>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<UnsignedDecimal>")
    )]
    pub expires_at_ms: Option<UnsignedDecimal>,
    pub admission_closed: bool,
    pub callbacks_drained: bool,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<CommandError>")
    )]
    pub error: Option<CommandError>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum McpShareSessionView {
    Unavailable,
    Available {
        owner_id: ExecutionId,
        next_generation: Revision,
        #[serde(deserialize_with = "required")]
        #[cfg_attr(
            feature = "wire-schema",
            schemars(schema_with = "nullable::<McpShareIdentity>")
        )]
        current: Option<McpShareIdentity>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareRevocation {
    pub identity: McpShareIdentity,
    pub action_id: ExecutionId,
    pub admission_closed: bool,
    pub callbacks_drained: bool,
}

macro_rules! request {
    ($name:ident { $($body:tt)* }) => {
        #[derive(Clone, Deserialize, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
        pub struct $name { pub session_token: String, pub project_id: ExecutionId, $($body)* }
    };
}
request!(McpSharePrepareRequest { pub preparation: McpSharePreparation });
request!(McpShareAuthorizeRequest { pub authorization: McpShareAuthorization });
request!(McpShareReadRequest { pub identity: McpShareIdentity,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable::<McpShareAuthorization>"))]
    pub authorization: Option<McpShareAuthorization> });
request!(McpShareRevokeRequest { pub identity: McpShareIdentity, pub action_id: ExecutionId });

struct Share {
    view: McpShareView,
    session: String,
    capture: Option<CapturedMcpShare>,
    configuration: Option<McpShareConfiguration>,
    control: Option<Arc<transport::Control>>,
    revocation: Option<ExecutionId>,
}
pub(super) struct Shares {
    shutdown: Arc<Shutdown>,
    owner: ExecutionId,
    generation: Revision,
    current: Option<Share>,
    retired: Option<Share>,
}
impl Default for Shares {
    fn default() -> Self {
        Self {
            shutdown: Arc::default(),
            owner: ExecutionId::new(),
            generation: Revision::new(0).expect("initial generation"),
            current: None,
            retired: None,
        }
    }
}
impl Drop for Shares {
    fn drop(&mut self) {
        self.close();
    }
}
impl Shares {
    pub(super) fn with_shutdown(shutdown: Arc<Shutdown>) -> Self {
        let mut shares = Self::default();
        shares.shutdown = shutdown;
        shares
    }
    fn next(&self) -> Result<Revision, CommandError> {
        self.generation
            .next()
            .map_err(|error| execution::map_execution(error, CommandStage::ExecutionRead))
    }
    fn check(&self, id: &McpShareIdentity) -> Result<(), CommandError> {
        if id.owner_id != self.owner || id.generation.get() == 0 {
            return Err(failure(CommandErrorCode::PermissionDenied));
        }
        Ok(())
    }
    fn refresh(share: &mut Share) {
        if let Some(control) = &share.control {
            if control.expired() {
                control.close();
            }
            share.view.admission_closed = control.closed();
            share.view.callbacks_drained = control.drained();
            share.view.phase = if control.closed() {
                if control.drained() {
                    McpSharePhase::Closed
                } else {
                    McpSharePhase::Closing
                }
            } else if control.authenticated() {
                McpSharePhase::Connected
            } else {
                McpSharePhase::AwaitingPairing
            };
        }
        if share.view.admission_closed {
            share.capture = None;
            share.configuration = None;
            // Retained receipts contain no reusable credential or payload.
            // The original credential stays available only in the accepted
            // authorization response while this exact share remains current.
        }
    }
    fn find_mut(&mut self, id: &McpShareIdentity) -> Option<&mut Share> {
        if self
            .current
            .as_ref()
            .is_some_and(|s| s.view.identity == *id)
        {
            self.current.as_mut()
        } else {
            self.retired.as_mut().filter(|s| s.view.identity == *id)
        }
    }
    fn retire(&mut self) {
        if let Some(current) = &mut self.current {
            Self::refresh(current);
        }
        if self
            .current
            .as_ref()
            .is_some_and(|s| s.view.admission_closed && s.view.callbacks_drained)
        {
            let mut old = self.current.take().expect("observed share");
            old.capture = None;
            old.control = None;
            old.configuration = None;
            self.retired = Some(old);
        }
    }
    pub(super) fn close(&mut self) {
        if let Some(s) = &mut self.current {
            if let Some(control) = &s.control {
                control.close();
            }
            s.view.admission_closed = true;
            if s.control.is_none() {
                s.view.callbacks_drained = true;
                s.view.phase = McpSharePhase::Closed;
            }
            Self::refresh(s);
        }
    }
    pub(super) fn close_and_check(&mut self) -> Result<(), CommandError> {
        self.close();
        self.retire();
        if self
            .current
            .as_ref()
            .is_some_and(|s| !s.view.callbacks_drained)
        {
            return Err(failure(CommandErrorCode::Busy));
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn read_mcp_share_session(
    state: State<'_, AppState>,
    request: execution::SessionRequest,
) -> Result<McpShareSessionView, CommandError> {
    state
        .sessions
        .run(
            "read_mcp_share_session",
            CommandStage::ExecutionRead,
            move |s| {
                execution::authorized(
                    s,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                s.mcp.retire();
                Ok(McpShareSessionView::Available {
                    owner_id: s.mcp.owner,
                    next_generation: s.mcp.next()?,
                    current: s
                        .mcp
                        .current
                        .as_ref()
                        .filter(|share| share.session == request.session_token)
                        .map(|share| share.view.identity.clone()),
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn prepare_mcp_share(
    state: State<'_, AppState>,
    request: McpSharePrepareRequest,
) -> Result<McpSharePrepared, CommandError> {
    state
        .sessions
        .run("prepare_mcp_share", CommandStage::ExecutionRead, move |s| {
            execution::authorized(
                s,
                &request.session_token,
                request.project_id,
                CommandStage::ExecutionRead,
            )?;
            if s.active
                .as_ref()
                .and_then(|a| a.execution.as_ref())
                .is_some_and(|h| h.is_quiescing())
            {
                return Err(failure(CommandErrorCode::Busy));
            }
            let p = request.preparation;
            s.mcp.check(&p.identity)?;
            if p.selection.project_id != request.project_id
                || p.recipient_label.trim().is_empty()
                || p.recipient_label.len() > 128
                || p.recipient_label.chars().any(char::is_control)
            {
                return Err(failure(CommandErrorCode::InvalidInput));
            }
            if let Some(original) = s.mcp.find_mut(&p.identity) {
                if original.session != request.session_token {
                    return Err(failure(CommandErrorCode::SessionInvalid));
                }
                if original.view.preparation.as_ref() != Some(&p) {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
                let capture = original
                    .capture
                    .as_ref()
                    .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
                return Ok(McpSharePrepared {
                    preparation: p,
                    preview: capture.preview().clone(),
                });
            }
            s.mcp.retire();
            if s.mcp.current.is_some() {
                return Err(failure(CommandErrorCode::Busy));
            }
            if p.identity.generation != s.mcp.next()? {
                return Err(failure(CommandErrorCode::PermissionDenied));
            }
            // Consume before capture: a failed or stopped original generation can
            // never be revived by a delayed request or a changed body.
            s.mcp.generation = p.identity.generation;
            let capture = match s
                .active
                .as_ref()
                .expect("authorized session")
                .store
                .prepare_mcp_share(&p.selection)
                .map_err(|error| execution::map_execution(error, CommandStage::ExecutionRead))
            {
                Ok(capture) => capture,
                Err(error) => {
                    s.mcp.current = Some(Share {
                        view: McpShareView {
                            identity: p.identity.clone(),
                            preparation: Some(p),
                            preview_digest: None,
                            phase: McpSharePhase::Closed,
                            authorization: None,
                            expires_at_ms: None,
                            admission_closed: true,
                            callbacks_drained: true,
                            error: Some(error.clone()),
                        },
                        session: request.session_token,
                        capture: None,
                        configuration: None,
                        control: None,
                        revocation: None,
                    });
                    return Err(error);
                }
            };
            let preview = capture.preview().clone();
            s.mcp.current = Some(Share {
                view: McpShareView {
                    identity: p.identity.clone(),
                    preparation: Some(p.clone()),
                    preview_digest: Some(preview.digest.clone()),
                    phase: McpSharePhase::Prepared,
                    authorization: None,
                    expires_at_ms: None,
                    admission_closed: false,
                    callbacks_drained: true,
                    error: None,
                },
                session: request.session_token,
                capture: Some(capture),
                configuration: None,
                control: None,
                revocation: None,
            });
            Ok(McpSharePrepared {
                preparation: p,
                preview,
            })
        })
        .await
}

#[tauri::command]
pub async fn authorize_mcp_share(
    state: State<'_, AppState>,
    request: McpShareAuthorizeRequest,
) -> Result<McpShareAuthorized, CommandError> {
    let callback = state.sessions.callback();
    state
        .sessions
        .run(
            "authorize_mcp_share",
            CommandStage::ExecutionRead,
            move |s| {
                execution::authorized(
                    s,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let a = request.authorization;
                s.mcp.check(&a.identity)?;
                if s.active
                    .as_ref()
                    .and_then(|a| a.execution.as_ref())
                    .is_some_and(|h| h.is_quiescing())
                {
                    return Err(failure(CommandErrorCode::Busy));
                }
                let shutdown = s.mcp.shutdown.clone();
                let share = s
                    .mcp
                    .find_mut(&a.identity)
                    .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
                if share.session != request.session_token {
                    return Err(failure(CommandErrorCode::SessionInvalid));
                }
                if let Some(original) = &share.view.authorization {
                    if original != &a {
                        return Err(failure(CommandErrorCode::ResultMismatch));
                    }
                    Shares::refresh(share);
                    return Ok(McpShareAuthorized {
                        view: share.view.clone(),
                        configuration: share
                            .configuration
                            .clone()
                            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?,
                    });
                }
                if share.view.admission_closed
                    || !a.confirmed
                    || !(1..=600).contains(&a.valid_for_seconds)
                    || share.view.preview_digest.as_ref() != Some(&a.preview_digest)
                {
                    return Err(failure(CommandErrorCode::PermissionDenied));
                }
                let capture = share
                    .capture
                    .as_ref()
                    .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
                s.active
                    .as_ref()
                    .expect("authorized session")
                    .store
                    .validate_mcp_share(capture)
                    .map_err(|error| {
                        execution::map_execution(error, CommandStage::ExecutionRead)
                    })?;
                let deadline = Instant::now()
                    .checked_add(Duration::from_secs(a.valid_for_seconds.into()))
                    .ok_or_else(|| failure(CommandErrorCode::InvalidInput))?;
                let expiry = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| failure(CommandErrorCode::InvalidInput))?
                    .as_millis()
                    .checked_add(u128::from(a.valid_for_seconds) * 1000)
                    .ok_or_else(|| failure(CommandErrorCode::InvalidInput))?;
                let expires = UnsignedDecimal::parse(&expiry.to_string()).map_err(|error| {
                    execution::map_execution(error, CommandStage::ExecutionRead)
                })?;
                let (control, configuration) =
                    transport::start(a.identity.clone(), callback, deadline)?;
                shutdown.install(&control)?;
                share.view.authorization = Some(a);
                share.view.expires_at_ms = Some(expires);
                share.view.phase = McpSharePhase::AwaitingPairing;
                share.view.callbacks_drained = false;
                share.control = Some(control);
                share.configuration = Some(configuration.clone());
                Ok(McpShareAuthorized {
                    view: share.view.clone(),
                    configuration,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn read_mcp_share(
    state: State<'_, AppState>,
    request: McpShareReadRequest,
) -> Result<McpShareView, CommandError> {
    state
        .sessions
        .run("read_mcp_share", CommandStage::ExecutionRead, move |s| {
            execution::authorized(
                s,
                &request.session_token,
                request.project_id,
                CommandStage::ExecutionRead,
            )?;
            s.mcp.check(&request.identity)?;
            let share = s
                .mcp
                .find_mut(&request.identity)
                .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
            if share.session != request.session_token {
                return Err(failure(CommandErrorCode::SessionInvalid));
            }
            if let Some(a) = request.authorization {
                if a.identity != request.identity
                    || share
                        .view
                        .authorization
                        .as_ref()
                        .is_some_and(|original| original != &a)
                {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
            }
            Shares::refresh(share);
            Ok(share.view.clone())
        })
        .await
}

#[tauri::command]
pub async fn revoke_mcp_share(
    state: State<'_, AppState>,
    request: McpShareRevokeRequest,
) -> Result<McpShareRevocation, CommandError> {
    state
        .sessions
        .run(
            "revoke_mcp_share",
            CommandStage::ExecutionCancel,
            move |s| {
                execution::authorized(
                    s,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                s.mcp.check(&request.identity)?;
                if s.mcp.find_mut(&request.identity).is_none() {
                    s.mcp.retire();
                    if s.mcp.current.is_some() {
                        return Err(failure(CommandErrorCode::Busy));
                    }
                    if request.identity.generation != s.mcp.next()? {
                        return Err(failure(CommandErrorCode::PermissionDenied));
                    }
                    s.mcp.generation = request.identity.generation;
                    s.mcp.current = Some(Share {
                        view: McpShareView {
                            identity: request.identity.clone(),
                            preparation: None,
                            preview_digest: None,
                            phase: McpSharePhase::Closed,
                            authorization: None,
                            expires_at_ms: None,
                            admission_closed: true,
                            callbacks_drained: true,
                            error: None,
                        },
                        session: request.session_token.clone(),
                        capture: None,
                        configuration: None,
                        control: None,
                        revocation: None,
                    });
                }
                let share = s
                    .mcp
                    .find_mut(&request.identity)
                    .expect("accepted identity");
                if share.session != request.session_token {
                    return Err(failure(CommandErrorCode::SessionInvalid));
                }
                if share.revocation.is_some_and(|id| id != request.action_id) {
                    return Err(failure(CommandErrorCode::ResultMismatch));
                }
                share.revocation = Some(request.action_id);
                if let Some(control) = &share.control {
                    control.close();
                }
                share.view.admission_closed = true;
                if share.control.is_none() {
                    share.view.phase = McpSharePhase::Closed;
                }
                Shares::refresh(share);
                Ok(McpShareRevocation {
                    identity: request.identity,
                    action_id: request.action_id,
                    admission_closed: true,
                    callbacks_drained: share.view.callbacks_drained,
                })
            },
        )
        .await
}

pub(crate) fn bridge_main() -> bool {
    transport::bridge_main()
}

impl SessionManager {
    // No external caller receives a GUI token. Every accepted operation returns
    // through the original weak owner and checks its exact live capture again.
    fn mcp_read(
        &mut self,
        id: &McpShareIdentity,
        tool: Option<&str>,
    ) -> Result<serde_json::Value, CommandError> {
        let share = self
            .mcp
            .current
            .as_mut()
            .filter(|s| s.view.identity == *id)
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        Shares::refresh(share);
        if share.view.admission_closed || share.view.authorization.is_none() {
            return Err(failure(CommandErrorCode::PermissionDenied));
        }
        let active = self
            .active
            .as_ref()
            .filter(|a| a.token == share.session)
            .ok_or_else(|| failure(CommandErrorCode::SessionInvalid))?;
        if active.execution.as_ref().is_some_and(|h| h.is_quiescing()) {
            return Err(failure(CommandErrorCode::Busy));
        }
        let capture = share
            .capture
            .as_ref()
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        active
            .store
            .check_mcp_share_session(capture)
            .map_err(|error| execution::map_execution(error, CommandStage::ExecutionRead))?;
        let payload = capture.payload();
        let selection = &share
            .view
            .preparation
            .as_ref()
            .expect("authorized preparation")
            .selection;
        match tool {
            None => Ok(serde_json::Value::Null),
            Some("tsumugi_read_entry") => Ok(
                serde_json::json!({"unitId":payload.unit_id,"locale":payload.locale,
                "source":payload.source,"translation":payload.translation}),
            ),
            Some("tsumugi_read_terms") if selection.share_terms => {
                Ok(serde_json::json!({"terms":payload.terms}))
            }
            Some("tsumugi_read_context") if selection.share_context => {
                Ok(serde_json::json!({"manualContext":payload.manual_context}))
            }
            _ => Err(failure(CommandErrorCode::PermissionDenied)),
        }
    }
}
