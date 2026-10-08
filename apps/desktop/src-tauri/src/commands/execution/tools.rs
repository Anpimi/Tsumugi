//! Generic single or batch read-only queries through the original Core ledger
//! and RunnerProxy. Tool metadata and query output grant no adoption authority.
use super::*;
use crate::commands::plugins::{PluginToolRequest, PluginToolView, tools::ToolEnvironment};
use serde_json::{Value, json};
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};

const OPERATION: &str = "plugin-tool-query";

#[derive(Default)]
pub(super) struct ToolSession {
    pending: Option<(ExecutionId, ExecutionId)>,
    prepared: Option<Arc<PreparedTool>>,
    last_start: Option<PluginStartRequest>,
}
impl ToolSession {
    pub(super) fn stop_package(
        &mut self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) {
        if self
            .prepared
            .as_ref()
            .is_some_and(|prepared| prepared.request.tool.package == *package)
        {
            self.prepared = None;
        }
        // In-flight preparation keeps its PackageWork guard; its original
        // continuation observes cancellation before publishing a new preflight.
    }
    pub(super) fn active(&self) -> bool {
        self.pending.is_some()
    }
    pub(super) fn stop(&mut self) {
        *self = Self::default();
    }
    fn begin(&mut self, attempt: ExecutionId) -> Result<ExecutionId, CommandError> {
        if self.active() {
            return Err(map_recover(ExecutionError::new(
                ErrorCode::Busy,
                "tool-preparation-active",
            )));
        }
        let ticket = ExecutionId::new();
        self.pending = Some((ticket, attempt));
        Ok(ticket)
    }
    fn discard(&mut self, attempt: ExecutionId) -> bool {
        let mut discarded = false;
        if self.pending.is_some_and(|(_, id)| id == attempt) {
            self.pending = None;
            discarded = true;
        }
        if self
            .prepared
            .as_ref()
            .is_some_and(|prepared| prepared.view.attempt_id == attempt)
        {
            self.prepared = None;
            discarded = true;
        }
        // A queued/uncertain start keeps its original consent for reconciliation.
        discarded
    }
}
struct PreparedTool {
    request: Arc<PluginToolPrepareRequest>,
    input: FixedInput,
    view: PluginToolPreflight,
}

request!(
    #[derive(PartialEq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginToolPrepareRequest {
        tool: PluginToolRequest,
        attempt_id: ExecutionId,
        payloads: Vec<Value>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginToolDiscardRequest {
        attempt_id: ExecutionId
    }
);

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginToolItem {
    pub item_id: ExecutionId,
    pub payload: Value,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginToolPreflight {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub tool: PluginToolView,
    pub items: Vec<PluginToolItem>,
}

fn stale() -> CommandError {
    map_recover(ExecutionError::new(
        ErrorCode::DependencyConflict,
        "tool-preflight-stale",
    ))
}
fn binding(environment: &ToolEnvironment) -> PluginExecutionBinding {
    PluginExecutionBinding {
        capability: environment.binding.capability.clone(),
        profile: environment.binding.declaration.profile.clone(),
        environment: environment.runtime.environment(),
    }
}
fn finish<'a>(
    sessions: &'a mut SessionManager,
    request: &PluginStartRequest,
    ticket: ExecutionId,
) -> Result<&'a mut ActiveSession, CommandError> {
    finish_job(sessions, &request.session_token, request.project_id, ticket)
}
fn finish_job<'a>(
    sessions: &'a mut SessionManager,
    token: &str,
    project: ExecutionId,
    ticket: ExecutionId,
) -> Result<&'a mut ActiveSession, CommandError> {
    let active = authorized(sessions, token, project, CommandStage::ExecutionRecover)?;
    let (host, _) = active.execution_parts()?;
    host.allow_mutation()?;
    if host.tools.pending.map(|(id, _)| id) != Some(ticket) {
        return Err(stale());
    }
    host.tools.pending = None;
    Ok(active)
}
fn capture(
    project: tsumugi_core::ProjectId,
    request: Arc<PluginToolPrepareRequest>,
    environment: ToolEnvironment,
) -> Result<Arc<PreparedTool>, CommandError> {
    let capability = &environment.binding.capability.declaration;
    let result_bytes = capability
        .limits
        .max_output_bytes
        .checked_mul(8)
        .and_then(|size| size.checked_add(16 * 1024))
        .filter(|size| *size as usize <= MAX_RESULT_BYTES)
        .ok_or_else(|| {
            map_recover(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "tool-result-limit",
            ))
        })?;
    let scope = Scope {
        kind: OPERATION.into(),
        id: project.to_string(),
        locale: None,
    };
    let items = request
        .payloads
        .iter()
        .map(|payload| InputItem::new(scope.clone(), payload.clone(), Vec::new()))
        .collect();
    let mut envelope = InputEnvelope::new(
        project,
        OPERATION,
        &capability.contract.id,
        &binding(&environment).capability_version(),
        items,
    )
    .map_err(map_recover)?;
    envelope.attempt_id = request.attempt_id;
    envelope.plugin = Some(binding(&environment));
    envelope.limits.timeout_ms = capability.limits.timeout_ms.min(60_000);
    envelope.limits.max_result_bytes = result_bytes;
    let tool = environment.view()?;
    envelope.settings = json!({"tool": tool});
    let input = FixedInput::capture(envelope).map_err(map_recover)?;
    // Bound each normalized payload before granting execution. Core's request
    // encoder checks the same original item again at dispatch.
    for item in &input.envelope().items {
        if serde_json::to_vec(&item.payload)
            .map_err(|_| stale())?
            .len()
            > capability.limits.max_input_bytes as usize
        {
            return Err(map_recover(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "tool-input-limit",
            )));
        }
    }
    let view = PluginToolPreflight {
        attempt_id: request.attempt_id,
        input_digest: input.digest().into(),
        tool,
        items: input
            .envelope()
            .items
            .iter()
            .map(|item| PluginToolItem {
                item_id: item.item_id,
                payload: item.payload.clone(),
            })
            .collect(),
    };
    Ok(Arc::new(PreparedTool {
        request,
        input,
        view,
    }))
}

#[tauri::command]
pub async fn prepare_plugin_tool(
    state: State<'_, AppState>,
    request: PluginToolPrepareRequest,
) -> Result<PluginToolPreflight, CommandError> {
    if request.payloads.is_empty() || request.payloads.len() > MAX_ITEMS {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::LimitExceeded,
            "tool-item-limit",
        )));
    }
    let request = Arc::new(request);
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "prepare_plugin_tool.begin",
        CommandStage::ExecutionRecover,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRecover,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            if let Some(prepared) = &host.tools.prepared {
                if prepared.request.attempt_id == initial.attempt_id {
                    if prepared.request != initial {
                        return Err(stale());
                    }
                    return Ok(Err(prepared.view.clone()));
                }
            }
            match store.execution_input(initial.attempt_id) {
                Ok(_) => return Err(stale()),
                Err(error) if error.code == ErrorCode::InvalidInput => {}
                Err(error) => return Err(map_recover(error)),
            }
            let project = store
                .metadata()
                .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRecover))?
                .project_id();
            let work = host.begin_package_work(vec![initial.tool.package.clone()])?;
            Ok(Ok((host.tools.begin(initial.attempt_id)?, project, work)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (ticket, project, work) = match admitted.await? {
            Ok(job) => job,
            Err(view) => return Ok(view),
        };
        let original = request.clone();
        let accepted_work = work.clone();
        let captured = io
            .run(CommandStage::ExecutionRecover, move || {
                accepted_work.check()?;
                let environment = plugins.capture_tool(&original.tool)?;
                capture(project, original, environment)
            })
            .await;
        lease
            .run(
                "prepare_plugin_tool.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active =
                        finish_job(sessions, &request.session_token, request.project_id, ticket)?;
                    work.check()?;
                    let (host, _) = active.execution_parts()?;
                    let prepared = captured?;
                    let view = prepared.view.clone();
                    host.tools.prepared = Some(prepared);
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}

#[tauri::command]
pub async fn start_plugin_tool(
    state: State<'_, AppState>,
    request: PluginStartRequest,
) -> Result<ExecutionId, CommandError> {
    if !request.unsandboxed_execution
        || tsumugi_plugin_sdk::validate_package_digest(&request.input_digest).is_err()
    {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::Unauthorized,
            "plugin-consent-required",
        )));
    }
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "start_plugin_tool.begin",
        CommandStage::ExecutionRecover,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRecover,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            if host.tools.last_start.as_ref() == Some(&initial) {
                match store.execution_input(initial.attempt_id) {
                    Ok(input) if input.digest() == initial.input_digest => return Ok(None),
                    Ok(_) => return Err(stale()),
                    Err(error) if error.code == ErrorCode::InvalidInput => {}
                    Err(error) => return Err(map_recover(error)),
                }
            }
            let prepared = host
                .tools
                .prepared
                .as_ref()
                .filter(|prepared| prepared.view.attempt_id == initial.attempt_id)
                .cloned()
                .ok_or_else(stale)?;
            if prepared.input.digest() != initial.input_digest
                || host.tools.last_start.as_ref().is_some_and(|prior| {
                    prior.attempt_id == initial.attempt_id && prior != &initial
                })
            {
                return Err(stale());
            }
            let work = host.begin_package_work(vec![prepared.request.tool.package.clone()])?;
            Ok(Some((
                host.tools.begin(initial.attempt_id)?,
                prepared,
                work,
            )))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let Some((ticket, prepared, work)) = admitted.await? else {
            return Ok(request.attempt_id);
        };
        let fixed = prepared.clone();
        let current_plugins = plugins.clone();
        let accepted_work = work.clone();
        let loaded = io
            .run(CommandStage::ExecutionRecover, move || {
                accepted_work.check()?;
                let environment = current_plugins.capture_tool(&fixed.request.tool)?;
                if environment.view()? != fixed.view.tool
                    || fixed.input.envelope().plugin.as_ref() != Some(&binding(&environment))
                {
                    return Err(stale());
                }
                let proxy = RunnerProxy::new(
                    environment.package.image().clone(),
                    &environment.binding.declaration.capability_id,
                    environment.runtime.clone(),
                    environment.staging_parent.clone(),
                    HostLimits::default(),
                )
                .map(Arc::new)
                .map_err(map_recover)?;
                Ok((environment, proxy))
            })
            .await;
        lease
            .run(
                "start_plugin_tool.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active = finish(sessions, &request, ticket)?;
                    work.check()?;
                    let (host, store) = active.execution_parts()?;
                    let (environment, proxy) = loaded?;
                    plugins.with_environment_revision(environment.settings_revision, || {
                        host.register_plugin(proxy, binding(&environment))
                            .map_err(map_recover)?;
                        host.runtime
                            .authorize_plugin(
                                store,
                                request.grant_id,
                                &prepared.input,
                                request.expires_at_ms.get(),
                                PluginConsent {
                                    unsandboxed_execution: request.unsandboxed_execution,
                                },
                            )
                            .map_err(map_recover)?;
                        // Unknown enqueue outcomes retain the original consent, never a
                        // substituted grant or extended expiry on a retry.
                        host.tools.last_start = Some(request.clone());
                        host.runtime
                            .submit(store, &prepared.input)
                            .map_err(map_recover)?;
                        Ok(request.attempt_id)
                    })
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}

#[tauri::command]
pub async fn discard_plugin_tool_preflight(
    state: State<'_, AppState>,
    request: PluginToolDiscardRequest,
) -> Result<bool, CommandError> {
    state
        .sessions
        .run(
            "discard_plugin_tool_preflight",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let (host, _) = active.execution_parts()?;
                host.allow_mutation()?;
                Ok(host.tools.discard(request.attempt_id))
            },
        )
        .await
}

#[cfg(test)]
mod tests;
