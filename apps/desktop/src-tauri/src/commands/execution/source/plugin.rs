//! Generic source import: declared native capture, separately consented producer
//! and semantic checker, and the existing Core adoption boundary.
pub use super::super::PluginStartRequest;
use super::*;
use crate::commands::plugins::{PluginSourceRequest, PluginSourceView, sources::SourceEnvironment};
use tsumugi_core::content::SourceSettings;
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};

#[derive(Default)]
pub(super) struct PluginSourceSession {
    choice: Option<(ExecutionId, PluginSourceRequest)>,
    review: Option<Arc<SourceReview>>,
    last_start: Option<PluginStartRequest>,
    check: Option<Arc<CheckReview>>,
    last_check_start: Option<PluginStartRequest>,
}
impl PluginSourceSession {
    pub(super) fn discard_capture(&mut self) {
        self.choice = None;
        self.review = None;
        // Accepted execution/check identities remain available for reconciliation.
    }
}
struct SourceReview {
    choice: PluginSourceRequest,
    input: FixedInput,
    view: PluginSourcePreflight,
}
struct CheckReview {
    request: SourceCheckPrepareRequest,
    capture: SourceValidationCapture,
    view: SourceCheckReview,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginSourceSelection {
    pub selection_id: ExecutionId,
    pub folder_name: String,
    pub source: PluginSourceView,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginSourceFile {
    pub logical_path: String,
    pub role: String,
    pub byte_length: u32,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginSourcePreflight {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub source_language: String,
    pub source: PluginSourceView,
    pub files: Vec<PluginSourceFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceCheckReview {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub source_attempt_id: ExecutionId,
    pub source_result_id: ExecutionId,
    pub source: PluginSourceView,
    pub rules: Vec<tsumugi_plugin_sdk::ContractRef>,
}
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginSourceSelectRequest {
        source: PluginSourceRequest
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginCaptureRequest {
        selection_id: ExecutionId,
        source_language: String,
        attempt_id: ExecutionId
    }
);
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SourceCheckPrepareRequest {
        source_attempt_id: ExecutionId,
        source_result_id: ExecutionId,
        attempt_id: ExecutionId,
        source: PluginSourceRequest
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SourceCheckFinishRequest {
        attempt_id: ExecutionId,
        result_id: ExecutionId
    }
);

fn proxies(environment: &SourceEnvironment) -> Result<[Arc<RunnerProxy>; 2], CommandError> {
    let proxy = |id: &str| {
        RunnerProxy::new(
            environment.package.image().clone(),
            id,
            environment.runtime.clone(),
            environment.staging_parent.clone(),
            HostLimits::default(),
        )
        .map(Arc::new)
        .map_err(map_source)
    };
    Ok([
        proxy(&environment.binding.declaration.extractor)?,
        proxy(&environment.binding.declaration.checker)?,
    ])
}
fn binding(environment: &SourceEnvironment, checker: bool) -> PluginExecutionBinding {
    PluginExecutionBinding {
        capability: if checker {
            environment.binding.checker.clone()
        } else {
            environment.binding.extractor.clone()
        },
        profile: Some(environment.binding.declaration.profile.clone()),
        environment: environment.runtime.descriptor().clone(),
    }
}
fn matches_source(input: &FixedInput, environment: &SourceEnvironment) -> Result<(), CommandError> {
    let settings = SourceSettings::from_input(input).map_err(map_source)?;
    let declaration = &environment.binding.declaration;
    if input.envelope().plugin.as_ref() != Some(&binding(environment, false))
        || settings.checker.as_ref() != Some(&binding(environment, true))
        || settings.revision_policy != declaration.revision_policy
        || settings.semantic_rules != declaration.semantic_rules
    {
        return Err(stale());
    }
    Ok(())
}
fn register(
    host: &mut ExecutionHost,
    proxies: [Arc<RunnerProxy>; 2],
    environment: &SourceEnvironment,
) -> Result<(), CommandError> {
    for (index, proxy) in proxies.into_iter().enumerate() {
        let selected = binding(environment, index == 1);
        host.register_plugin(proxy, selected).map_err(map_source)?;
    }
    Ok(())
}
pub(super) fn begin_job(active: &mut ActiveSession) -> Result<ExecutionId, CommandError> {
    let (host, _) = active.execution_parts()?;
    host.allow_mutation()?;
    if host.source.is_active() {
        return Err(map_source(ExecutionError::new(
            ErrorCode::Busy,
            "input-busy",
        )));
    }
    let id = ExecutionId::new();
    host.source.job = Some(id);
    host.source.cancel = Cancellation::default();
    Ok(id)
}

#[tauri::command]
pub async fn select_plugin_source<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: PluginSourceSelectRequest,
) -> Result<Option<PluginSourceSelection>, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let picker = ExecutionId::new();
    let admitted = lease.submit(
        "select_plugin_source.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (host, _) = active.execution_parts()?;
            host.allow_mutation()?;
            host.source.stop();
            host.source.picker = Some(picker);
            Ok(())
        },
    )?;
    let io = state.io.clone();
    let dialogs = state.dialogs.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        admitted.await?;
        let source = request.source.clone();
        let captured = async {
            let environment = io
                .run(CommandStage::ExecutionRead, move || {
                    plugins.capture_source(&source)
                })
                .await?;
            let path = dialogs
                .run(CommandStage::ExecutionRead, move || {
                    Ok(app.dialog().file().blocking_pick_folder())
                })
                .await?;
            io.run(CommandStage::ExecutionRead, move || {
                path.map(|path| {
                    let selection =
                        capture::Selection::authorize(path.into_path().map_err(|_| stale())?)
                            .map_err(map_source)?;
                    Ok((Arc::new(selection), environment.view()?))
                })
                .transpose()
            })
            .await
        }
        .await;
        lease
            .run(
                "select_plugin_source.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, _) = active.execution_parts()?;
                    host.allow_mutation()?;
                    if host.source.picker != Some(picker) {
                        return Err(stale());
                    }
                    host.source.picker = None;
                    Ok(captured?.map(|(selection, source)| {
                        let selection_id = ExecutionId::new();
                        let folder_name = selection.label();
                        host.source.selection = Some((selection_id, selection));
                        host.source.plugin.choice = Some((selection_id, request.source));
                        PluginSourceSelection {
                            selection_id,
                            folder_name,
                            source,
                        }
                    }))
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn preflight_plugin_source(
    state: State<'_, AppState>,
    request: PluginCaptureRequest,
) -> Result<PluginSourcePreflight, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "preflight_plugin_source.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let choice = host
                .source
                .plugin
                .choice
                .as_ref()
                .filter(|(id, _)| *id == initial.selection_id)
                .map(|(_, choice)| choice.clone())
                .ok_or_else(stale)?;
            if let Some(review) = &host.source.plugin.review {
                if review.input.envelope().attempt_id == initial.attempt_id {
                    if review.choice != choice
                        || review.view.source_language != initial.source_language
                    {
                        return Err(stale());
                    }
                    return Ok(Err(review.view.clone()));
                }
            }
            match store.execution_input(initial.attempt_id) {
                Ok(_) => return Err(stale()),
                Err(error) if error.code == ErrorCode::InvalidInput => {}
                Err(error) => return Err(map_source(error)),
            }
            let project = store
                .metadata()
                .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRead))?
                .project_id();
            let job = begin(
                sessions,
                &initial.session_token,
                initial.project_id,
                initial.selection_id,
                &initial.source_language,
            )?;
            Ok(Ok((job, choice, project)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (job, choice, project) = match admitted.await? {
            Ok(job) => job,
            Err(view) => return Ok(view),
        };
        let id = job.id;
        let language = request.source_language.clone();
        let captured = io
            .run(CommandStage::ExecutionRead, move || {
                let environment = plugins.capture_source(&choice)?;
                let bundle = job
                    .selection
                    .capture_declared(&environment.binding, &language, &job.cancel)
                    .map_err(map_source)?;
                let fixed = bundle
                    .fixed_plugin_input(
                        project,
                        binding(&environment, false),
                        SourceSettings {
                            revision_policy: environment
                                .binding
                                .declaration
                                .revision_policy
                                .clone(),
                            checker: Some(binding(&environment, true)),
                            semantic_rules: environment.binding.declaration.semantic_rules.clone(),
                        },
                    )
                    .map_err(map_source)?;
                let mut envelope = fixed.envelope().clone();
                envelope.attempt_id = request.attempt_id;
                let input = FixedInput::capture(envelope).map_err(map_source)?;
                let view = PluginSourcePreflight {
                    attempt_id: request.attempt_id,
                    input_digest: input.digest().into(),
                    source_language: language,
                    source: environment.view()?,
                    files: bundle
                        .files
                        .iter()
                        .map(|file| PluginSourceFile {
                            logical_path: file.logical_path.clone(),
                            role: file.role.clone(),
                            byte_length: file.byte_length,
                            sha256: file.sha256.clone(),
                        })
                        .collect(),
                };
                Ok(Arc::new(SourceReview {
                    choice,
                    input,
                    view,
                }))
            })
            .await;
        lease
            .run(
                "preflight_plugin_source.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    let (host, _) = active.execution_parts()?;
                    let review = captured?;
                    let view = review.view.clone();
                    host.source.plugin.review = Some(review);
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

async fn start(
    state: State<'_, AppState>,
    request: PluginStartRequest,
    checker: bool,
) -> Result<ExecutionId, CommandError> {
    if !request.unsandboxed_execution
        || tsumugi_plugin_sdk::validate_package_digest(&request.input_digest).is_err()
    {
        return Err(map_source(ExecutionError::new(
            ErrorCode::Unauthorized,
            "plugin-consent-required",
        )));
    }
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "start_plugin_source.begin",
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
            let previous = if checker {
                &host.source.plugin.last_check_start
            } else {
                &host.source.plugin.last_start
            };
            if previous.as_ref() == Some(&initial) {
                if let Ok(input) = store.execution_input(initial.attempt_id) {
                    if input.digest() != initial.input_digest {
                        return Err(stale());
                    }
                    return Ok(None);
                }
            }
            let (input, choice) = if checker {
                let review = host
                    .source
                    .plugin
                    .check
                    .as_ref()
                    .filter(|review| review.view.attempt_id == initial.attempt_id)
                    .ok_or_else(stale)?;
                (
                    review.capture.check_input().clone(),
                    review.request.source.clone(),
                )
            } else {
                let review = host
                    .source
                    .plugin
                    .review
                    .as_ref()
                    .filter(|review| review.view.attempt_id == initial.attempt_id)
                    .ok_or_else(stale)?;
                (review.input.clone(), review.choice.clone())
            };
            if input.digest() != initial.input_digest {
                return Err(stale());
            }
            if previous
                .as_ref()
                .is_some_and(|prior| prior.attempt_id == initial.attempt_id && prior != &initial)
            {
                return Err(stale());
            }
            let id = begin_job(active)?;
            Ok(Some((id, input, choice)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let Some((id, input, choice)) = admitted.await? else {
            return Ok(request.attempt_id);
        };
        let fixed = input.clone();
        let loaded = io
            .run(CommandStage::ExecutionRecover, move || {
                let environment = plugins.capture_source(&choice)?;
                if checker {
                    if fixed.envelope().plugin.as_ref() != Some(&binding(&environment, true)) {
                        return Err(stale());
                    }
                } else {
                    matches_source(&fixed, &environment)?;
                }
                let runners = proxies(&environment)?;
                Ok((environment, runners))
            })
            .await;
        lease
            .run(
                "start_plugin_source.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    let (host, store) = active.execution_parts()?;
                    let (environment, runners) = loaded?;
                    register(host, runners, &environment)?;
                    host.runtime
                        .authorize_plugin(
                            store,
                            request.grant_id,
                            &input,
                            request.expires_at_ms.get(),
                            PluginConsent {
                                unsandboxed_execution: request.unsandboxed_execution,
                            },
                        )
                        .map_err(map_source)?;
                    // Preserve the original consent even if enqueue's durable outcome is
                    // uncertain. An existing grant is never silently replaced or extended.
                    if checker {
                        host.source.plugin.last_check_start = Some(request.clone());
                    } else {
                        host.source.plugin.last_start = Some(request.clone());
                    }
                    host.runtime.submit(store, &input).map_err(map_source)?;
                    Ok(request.attempt_id)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}
#[tauri::command]
pub async fn start_plugin_source(
    state: State<'_, AppState>,
    request: PluginStartRequest,
) -> Result<ExecutionId, CommandError> {
    start(state, request, false).await
}
#[tauri::command]
pub async fn start_source_check(
    state: State<'_, AppState>,
    request: PluginStartRequest,
) -> Result<ExecutionId, CommandError> {
    start(state, request, true).await
}

#[tauri::command]
pub async fn prepare_source_check(
    state: State<'_, AppState>,
    request: SourceCheckPrepareRequest,
) -> Result<SourceCheckReview, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "prepare_source_check.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            if let Some(review) = &host.source.plugin.check {
                if review.request.attempt_id == initial.attempt_id {
                    if review.request != initial {
                        return Err(stale());
                    }
                    return Ok(Err(review.view.clone()));
                }
                if host.runtime.is_active(review.view.attempt_id) {
                    return Err(map_source(ExecutionError::new(
                        ErrorCode::Busy,
                        "input-busy",
                    )));
                }
            }
            match store.execution_input(initial.attempt_id) {
                Ok(_) => return Err(stale()),
                Err(error) if error.code == ErrorCode::InvalidInput => {}
                Err(error) => return Err(map_source(error)),
            }
            let captured = store
                .capture_result_validation(initial.source_attempt_id, initial.source_result_id)
                .map_err(map_source)?;
            let id = begin_job(active)?;
            Ok(Ok((id, captured)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (id, captured) = match admitted.await? {
            Ok(capture) => capture,
            Err(view) => return Ok(view),
        };
        let choice = request.source.clone();
        let preparing = request.clone();
        let prepared = io
            .run(CommandStage::ExecutionRead, move || {
                let environment = plugins.capture_source(&choice)?;
                matches_source(captured.input(), &environment)?;
                let capture = captured
                    .prepare_source_check(preparing.attempt_id)
                    .map_err(map_source)?;
                let view = SourceCheckReview {
                    attempt_id: preparing.attempt_id,
                    input_digest: capture.check_input().digest().into(),
                    source_attempt_id: preparing.source_attempt_id,
                    source_result_id: preparing.source_result_id,
                    source: environment.view()?,
                    rules: environment.binding.declaration.semantic_rules.clone(),
                };
                Ok(Arc::new(CheckReview {
                    request: preparing,
                    capture,
                    view,
                }))
            })
            .await;
        lease
            .run(
                "prepare_source_check.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    let (host, _) = active.execution_parts()?;
                    let review = prepared?;
                    let view = review.view.clone();
                    host.source.plugin.check = Some(review);
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn finish_source_check(
    state: State<'_, AppState>,
    request: SourceCheckFinishRequest,
) -> Result<(), CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionAdopt)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "finish_source_check.capture",
        CommandStage::ExecutionAdopt,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionAdopt,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let review = host
                .source
                .plugin
                .check
                .as_ref()
                .filter(|review| review.view.attempt_id == initial.attempt_id)
                .cloned()
                .ok_or_else(stale)?;
            let result = store
                .execution_result(initial.attempt_id, initial.result_id)
                .map_err(map_source)?;
            let id = begin_job(active)?;
            Ok((id, review, result))
        },
    )?;
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        let (id, review, result) = admitted.await?;
        let prepared = io
            .run(CommandStage::ExecutionAdopt, move || {
                review.capture.clone().prepare(result).map_err(map_source)
            })
            .await;
        lease
            .run(
                "finish_source_check.commit",
                CommandStage::ExecutionAdopt,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    let (host, store) = active.execution_parts()?;
                    host.allow_mutation()?;
                    store
                        .commit_source_validation(prepared?)
                        .map_err(map_source)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
}

#[cfg(test)]
mod tests;
