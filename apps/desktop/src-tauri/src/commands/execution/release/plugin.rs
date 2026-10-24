//! Installed builders and independent artifact checks share Core's fixed
//! execution, grants, proof and Release adoption owners.
use super::*;
use crate::commands::plugins::{PluginBuildRequest, PluginBuildView, builds::BuildEnvironment};
use tsumugi_core::{PluginBuildLocaleChoice, ReleaseBuildEnvironment, ReleasePlan};
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};
use tsumugi_plugin_sdk as sdk;
pub(in crate::commands) mod workflow;

pub(in crate::commands::execution) struct PluginBuildSession {
    job: Option<ExecutionId>,
    review: Option<Arc<BuildReview>>,
    check: Option<Arc<CheckReview>>,
    last_start: Option<PluginStartRequest>,
    last_check_start: Option<PluginStartRequest>,
    workflow: Option<workflow::WorkflowSession>,
}
impl Default for PluginBuildSession {
    fn default() -> Self {
        Self {
            job: None,
            review: None,
            check: None,
            last_start: None,
            last_check_start: None,
            workflow: Some(workflow::WorkflowSession::default()),
        }
    }
}
impl PluginBuildSession {
    pub(super) fn stop_package(
        &mut self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) {
        if let Some(workflow) = &mut self.workflow {
            workflow.stop_package(package);
        }
        if self
            .review
            .as_ref()
            .is_some_and(|review| review.request.build.package == *package)
        {
            self.review = None;
        }
        if self
            .check
            .as_ref()
            .is_some_and(|review| review.request.build.package == *package)
        {
            self.check = None;
        }
    }
    pub(in crate::commands::execution) fn is_active(&self) -> bool {
        self.job.is_some() || self.workflow.as_ref().is_some_and(|w| w.busy())
    }
    pub(super) fn stop(&mut self) {
        if let Some(workflow) = &mut self.workflow {
            workflow.close(false);
        }
        // Late preparation cannot create a new review or grant in this session.
        self.job = None;
        self.review = None;
        self.check = None;
    }
}
struct BuildReview {
    request: PluginBuildPrepareRequest,
    input: FixedInput,
    view: PluginBuildReview,
}
struct CheckReview {
    request: ArtifactCheckPrepareRequest,
    capture: ArtifactValidationCapture,
    view: ArtifactCheckReview,
}

request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginBuildPrepareRequest {
        attempt_id: ExecutionId,
        choices: Vec<PluginBuildLocaleChoice>,
        expected_eligibility_basis: String,
        build: PluginBuildRequest
    }
);
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ArtifactCheckPrepareRequest {
        build_attempt_id: ExecutionId,
        build_result_id: ExecutionId,
        attempt_id: ExecutionId,
        build: PluginBuildRequest
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ArtifactCheckFinishRequest {
        attempt_id: ExecutionId,
        result_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SavedPluginBuildRequest {
        attempt_id: ExecutionId
    }
);

/// A historical projection grants no execution and never consults or repairs
/// installation state. The Core owner validates original immutable references.
#[tauri::command]
pub async fn read_saved_plugin_build(
    state: State<'_, AppState>,
    request: SavedPluginBuildRequest,
) -> Result<tsumugi_core::SavedPluginBuildView, CommandError> {
    state
        .sessions
        .run(
            "read_saved_plugin_build",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let running = active
                    .execution
                    .as_ref()
                    .is_some_and(|host| host.runtime.is_active(request.attempt_id));
                active
                    .store
                    .read_saved_plugin_build(request.project_id, request.attempt_id, running)
                    .map_err(map_read)
            },
        )
        .await
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginBuildReview {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub source_snapshot_id: ExecutionId,
    pub eligibility_basis: String,
    pub choices: Vec<PluginBuildLocaleChoice>,
    pub build: PluginBuildView,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CheckedArtifact {
    pub id: String,
    pub role: String,
    pub logical_path: String,
    pub byte_length: u32,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckReview {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub build_attempt_id: ExecutionId,
    pub build_result_id: ExecutionId,
    pub locale: String,
    pub artifacts: Vec<CheckedArtifact>,
    pub requirements: Vec<sdk::CheckRequirement>,
    pub build: PluginBuildView,
}
fn stale() -> CommandError {
    map_recover(ExecutionError::new(
        ErrorCode::Unauthorized,
        "unauthorized-selection",
    ))
}
fn begin_job(active: &mut ActiveSession) -> Result<ExecutionId, CommandError> {
    let (host, _) = active.execution_parts()?;
    host.allow_mutation()?;
    if host.release.plugin.is_active() {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::Busy,
            "input-busy",
        )));
    }
    let job = ExecutionId::new();
    host.release.plugin.job = Some(job);
    Ok(job)
}
fn finish<'a>(
    sessions: &'a mut SessionManager,
    token: &str,
    project: ExecutionId,
    job: ExecutionId,
    stage: CommandStage,
) -> Result<&'a mut ActiveSession, CommandError> {
    let active = authorized(sessions, token, project, stage)?;
    let (host, _) = active.execution_parts()?;
    if host.release.plugin.job != Some(job) {
        return Err(stale());
    }
    host.release.plugin.job = None;
    host.allow_mutation()?;
    Ok(active)
}
fn selected(environment: &BuildEnvironment) -> Result<ReleaseBuildEnvironment, CommandError> {
    ReleaseBuildEnvironment::new(
        environment.binding.clone(),
        binding(environment, false)?,
        binding(environment, true)?,
    )
    .map_err(map_read)
}
fn binding(
    environment: &BuildEnvironment,
    checker: bool,
) -> Result<PluginExecutionBinding, CommandError> {
    environment.execution_binding(
        if checker {
            &environment.binding.checker
        } else {
            &environment.binding.builder
        },
        Some(environment.binding.declaration.profile.clone()),
    )
}

fn matches_build(input: &FixedInput, environment: &BuildEnvironment) -> Result<(), CommandError> {
    if ReleasePlan::from_input(input)
        .map_err(map_read)?
        .build_environment()
        != &selected(environment)?
    {
        return Err(stale());
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_plugin_build(
    state: State<'_, AppState>,
    request: PluginBuildPrepareRequest,
) -> Result<PluginBuildReview, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "prepare_plugin_build.begin",
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
            if let Some(review) = &host.release.plugin.review {
                if review.request.attempt_id == initial.attempt_id {
                    if review.request != initial {
                        return Err(stale());
                    }
                    return Ok(Err(review.view.clone()));
                }
                if host.runtime.is_active(review.view.attempt_id) {
                    return Err(map_read(ExecutionError::new(ErrorCode::Busy, "input-busy")));
                }
            }
            let work = host.begin_package_work(vec![initial.build.package.clone()])?;
            begin_job(active).map(|job| Ok((job, work)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (job, work) = match admitted.await? {
            Ok(job) => job,
            Err(view) => return Ok(view),
        };
        let choice = request.build.clone();
        let accepted_work = work.clone();
        let loaded = io
            .run(CommandStage::ExecutionRead, move || {
                accepted_work.check()?;
                plugins.capture_build(&choice)
            })
            .await;
        lease
            .run(
                "prepare_plugin_build.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = finish(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        job,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    work.check()?;
                    let environment = loaded?;
                    let input = store
                        .prepare_plugin_build(
                            request.project_id,
                            request.attempt_id,
                            &request.choices,
                            &request.expected_eligibility_basis,
                            &selected(&environment)?,
                        )
                        .map_err(map_read)?;
                    let plan = ReleasePlan::from_input(&input).map_err(map_read)?;
                    let view = PluginBuildReview {
                        attempt_id: request.attempt_id,
                        input_digest: input.digest().into(),
                        source_snapshot_id: plan.source_snapshot_id(),
                        eligibility_basis: plan.eligibility_basis().into(),
                        choices: request.choices.clone(),
                        build: environment.view()?,
                    };
                    host.release.plugin.review = Some(Arc::new(BuildReview {
                        request,
                        input,
                        view: view.clone(),
                    }));
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
        || sdk::validate_package_digest(&request.input_digest).is_err()
    {
        return Err(map_recover(ExecutionError::new(
            ErrorCode::Unauthorized,
            "plugin-consent-required",
        )));
    }
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "start_plugin_build.begin",
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
                &host.release.plugin.last_check_start
            } else {
                &host.release.plugin.last_start
            };
            if previous.as_ref() == Some(&initial) {
                if let Ok(input) = store.execution_input(initial.attempt_id) {
                    if input.digest() != initial.input_digest {
                        return Err(stale());
                    }
                    return Ok(None);
                }
            }
            if previous
                .as_ref()
                .is_some_and(|prior| prior.attempt_id == initial.attempt_id && prior != &initial)
            {
                return Err(stale());
            }
            let (input, choice) = if checker {
                let review = host
                    .release
                    .plugin
                    .check
                    .as_ref()
                    .filter(|r| r.view.attempt_id == initial.attempt_id)
                    .ok_or_else(stale)?;
                (
                    review.capture.check_input().clone(),
                    review.request.build.clone(),
                )
            } else {
                let review = host
                    .release
                    .plugin
                    .review
                    .as_ref()
                    .filter(|r| r.view.attempt_id == initial.attempt_id)
                    .ok_or_else(stale)?;
                (review.input.clone(), review.request.build.clone())
            };
            if input.digest() != initial.input_digest {
                return Err(stale());
            }
            let work = host.begin_package_work(vec![choice.package.clone()])?;
            let job = begin_job(active)?;
            Ok(Some((job, input, choice, work)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let Some((job, input, choice, work)) = admitted.await? else {
            return Ok(request.attempt_id);
        };
        let fixed = input.clone();
        let accepted_work = work.clone();
        let loaded = io
            .run(CommandStage::ExecutionRecover, move || {
                accepted_work.check()?;
                let environment = plugins.capture_build(&choice)?;
                if checker {
                    if fixed.envelope().plugin.as_ref() != Some(&binding(&environment, true)?) {
                        return Err(stale());
                    }
                } else {
                    matches_build(&fixed, &environment)?;
                }
                let mut runners = Vec::new();
                for (id, is_checker) in [
                    (&environment.binding.declaration.builder, false),
                    (&environment.binding.declaration.checker, true),
                ] {
                    let proxy = RunnerProxy::new(
                        environment.package.image().clone(),
                        id,
                        environment.runtime.clone(),
                        environment.staging_parent.clone(),
                        HostLimits::default(),
                    )
                    .map_err(map_recover)?;
                    runners.push((Arc::new(proxy), binding(&environment, is_checker)?));
                }
                Ok(runners)
            })
            .await;
        lease
            .run(
                "start_plugin_build.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active = finish(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        job,
                        CommandStage::ExecutionRecover,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    work.check()?;
                    for (runner, binding) in loaded? {
                        host.register_plugin(runner, binding).map_err(map_recover)?;
                    }
                    host.runtime
                        .authorize_plugin(
                            store,
                            request.grant_id,
                            &input,
                            request.expires_at_ms.get(),
                            PluginConsent {
                                unsandboxed_execution: request.unsandboxed_execution,
                                application_execution: false,
                            },
                        )
                        .map_err(map_recover)?;
                    if checker {
                        host.release.plugin.last_check_start = Some(request.clone());
                    } else {
                        host.release.plugin.last_start = Some(request.clone());
                    }
                    host.runtime.submit(store, &input).map_err(map_recover)?;
                    Ok(request.attempt_id)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}
#[tauri::command]
pub async fn start_plugin_build(
    state: State<'_, AppState>,
    request: PluginStartRequest,
) -> Result<ExecutionId, CommandError> {
    start(state, request, false).await
}
#[tauri::command]
pub async fn start_artifact_check(
    state: State<'_, AppState>,
    request: PluginStartRequest,
) -> Result<ExecutionId, CommandError> {
    start(state, request, true).await
}

#[tauri::command]
pub async fn prepare_artifact_check(
    state: State<'_, AppState>,
    request: ArtifactCheckPrepareRequest,
) -> Result<ArtifactCheckReview, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "prepare_artifact_check.begin",
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
            if let Some(review) = &host.release.plugin.check {
                if review.request.attempt_id == initial.attempt_id {
                    if review.request != initial {
                        return Err(stale());
                    }
                    return Ok(Err(review.view.clone()));
                }
                if host.runtime.is_active(review.view.attempt_id) {
                    return Err(map_read(ExecutionError::new(ErrorCode::Busy, "input-busy")));
                }
            }
            match store.execution_input(initial.attempt_id) {
                Ok(_) => return Err(stale()),
                Err(error) if error.code == ErrorCode::InvalidInput => {}
                Err(error) => return Err(map_read(error)),
            }
            let capture = store
                .capture_result_validation(initial.build_attempt_id, initial.build_result_id)
                .map_err(map_read)?;
            let work = host.begin_package_work(vec![initial.build.package.clone()])?;
            let job = begin_job(active)?;
            Ok(Ok((job, capture, work)))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (job, capture, work) = match admitted.await? {
            Ok(pair) => pair,
            Err(view) => return Ok(view),
        };
        let preparing = request.clone();
        let accepted_work = work.clone();
        let prepared = io
            .run(CommandStage::ExecutionRead, move || {
                accepted_work.check()?;
                let environment = plugins.capture_build(&preparing.build)?;
                matches_build(capture.input(), &environment)?;
                let capture = capture
                    .prepare_artifact_check(preparing.attempt_id)
                    .map_err(map_read)?;
                let payload: sdk::ArtifactCheckInput = serde_json::from_value(
                    capture.check_input().envelope().items[0].payload.clone(),
                )
                .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?;
                let view = ArtifactCheckReview {
                    attempt_id: preparing.attempt_id,
                    input_digest: capture.check_input().digest().into(),
                    build_attempt_id: preparing.build_attempt_id,
                    build_result_id: preparing.build_result_id,
                    locale: payload.input.target_language,
                    artifacts: payload
                        .output
                        .artifacts
                        .into_iter()
                        .map(|a| CheckedArtifact {
                            id: a.id,
                            role: a.role,
                            logical_path: a.logical_path,
                            byte_length: a.utf8.len() as u32,
                            sha256: a.sha256,
                        })
                        .collect(),
                    requirements: payload.requirements,
                    build: environment.view()?,
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
                "prepare_artifact_check.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = finish(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        job,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, _) = active.execution_parts()?;
                    work.check()?;
                    let review = prepared?;
                    let view = review.view.clone();
                    host.release.plugin.check = Some(review);
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn finish_artifact_check(
    state: State<'_, AppState>,
    request: ArtifactCheckFinishRequest,
) -> Result<(), CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionAdopt)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "finish_artifact_check.capture",
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
                .release
                .plugin
                .check
                .as_ref()
                .filter(|r| r.view.attempt_id == initial.attempt_id)
                .cloned()
                .ok_or_else(stale)?;
            let result = store
                .execution_result(initial.attempt_id, initial.result_id)
                .map_err(map_adopt)?;
            let job = begin_job(active)?;
            Ok((job, review, result))
        },
    )?;
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        let (job, review, result) = admitted.await?;
        let prepared = io
            .run(CommandStage::ExecutionAdopt, move || {
                review.capture.clone().prepare(result).map_err(map_adopt)
            })
            .await;
        lease
            .run(
                "finish_artifact_check.commit",
                CommandStage::ExecutionAdopt,
                move |sessions| {
                    let active = finish(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        job,
                        CommandStage::ExecutionAdopt,
                    )?;
                    let (_, store) = active.execution_parts()?;
                    store
                        .commit_artifact_validation(prepared?)
                        .map_err(map_adopt)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
}
#[tauri::command]
pub async fn cancel_plugin_build_preparation(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<bool, CommandError> {
    state
        .sessions
        .run(
            "cancel_plugin_build_preparation",
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
                if host
                    .release
                    .plugin
                    .workflow
                    .as_ref()
                    .is_some_and(|w| w.busy())
                {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::Busy,
                        "artifact-workflow-active",
                    )));
                }
                Ok(host.release.plugin.job.take().is_some())
            },
        )
        .await
}

#[cfg(test)]
mod tests;
