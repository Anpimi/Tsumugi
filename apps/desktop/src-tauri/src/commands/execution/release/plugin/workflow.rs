//! Session-owned sequencing of independently authorized artifact checks.
use super::*;
use tsumugi_core::SavedArtifactCheckProof;
use tsumugi_core::execution::ArtifactCheckBuildResultRef;
mod state;
pub(in crate::commands::execution) use state::WorkflowSession;

fn workflow_error(code: ErrorCode, stage: &'static str) -> CommandError {
    map_recover(ExecutionError::new(code, stage))
}

fn required<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
#[cfg(feature = "wire-schema")]
fn nullable<T: schemars::JsonSchema>(
    generator: &mut schemars::SchemaGenerator,
) -> schemars::Schema {
    <Option<T> as schemars::JsonSchema>::json_schema(generator)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowIdentity {
    pub owner_id: ExecutionId,
    pub generation: Revision,
    pub workflow_id: ExecutionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowPreparation {
    pub identity: ArtifactCheckWorkflowIdentity,
    pub build_attempt_id: ExecutionId,
    pub build_input_digest: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 16)))]
    pub build_results: Vec<ArtifactCheckBuildResultRef>,
    pub build: PluginBuildRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowStepIdentity {
    pub locale: String,
    pub build_item_id: ExecutionId,
    pub build_result_id: ExecutionId,
    pub producer_attempt_id: ExecutionId,
    pub producer_input_digest: String,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowConsent {
    pub step: ArtifactCheckWorkflowStepIdentity,
    pub grant_id: ExecutionId,
    pub expires_at_ms: UnsignedDecimal,
    pub unsandboxed_execution: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowStart {
    pub identity: ArtifactCheckWorkflowIdentity,
    pub materialization_digest: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 16)))]
    pub consents: Vec<ArtifactCheckWorkflowConsent>,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ArtifactCheckWorkflowPrepareRequest {
        preparation: ArtifactCheckWorkflowPreparation
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ArtifactCheckWorkflowStartRequest {
        start: ArtifactCheckWorkflowStart
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
ArtifactCheckWorkflowReadRequest {
    preparation: ArtifactCheckWorkflowPreparation,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable::<ArtifactCheckWorkflowStart>"))]
    start: Option<ArtifactCheckWorkflowStart>
});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ArtifactCheckWorkflowStopRequest {
        identity: ArtifactCheckWorkflowIdentity
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ArtifactCheckWorkflowSessionView {
    Unavailable,
    Available {
        owner_id: ExecutionId,
        next_generation: Revision,
        #[serde(deserialize_with = "required")]
        #[cfg_attr(
            feature = "wire-schema",
            schemars(schema_with = "nullable::<ArtifactCheckWorkflowIdentity>")
        )]
        current: Option<ArtifactCheckWorkflowIdentity>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ArtifactCheckWorkflowPhase {
    Preparing,
    Prepared,
    Running,
    Paused,
    Completed,
    Stopped,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ArtifactCheckWorkflowStepPhase {
    Prepared,
    NotSelected,
    Waiting,
    Enqueued,
    Recording,
    Proved,
    Failed,
    Unknown,
    Cancelled,
    NotStarted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowTask {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowStepView {
    pub ordinal: u32,
    pub step: ArtifactCheckWorkflowStepIdentity,
    pub build_result_digest: String,
    pub review: ArtifactCheckReview,
    pub selected: bool,
    pub phase: ArtifactCheckWorkflowStepPhase,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<SavedArtifactCheckProof>")
    )]
    pub proof: Option<SavedArtifactCheckProof>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<CommandError>")
    )]
    pub error: Option<CommandError>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowView {
    pub preparation: ArtifactCheckWorkflowPreparation,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable::<String>"))]
    pub materialization_digest: Option<String>,
    pub phase: ArtifactCheckWorkflowPhase,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<ArtifactCheckWorkflowStart>")
    )]
    pub start: Option<ArtifactCheckWorkflowStart>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub steps: Vec<ArtifactCheckWorkflowStepView>,
    pub admission_closed: bool,
    pub callbacks_drained: bool,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<ArtifactCheckWorkflowTask>")
    )]
    pub current_task: Option<ArtifactCheckWorkflowTask>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<CommandError>")
    )]
    pub error: Option<CommandError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ArtifactCheckWorkflowObservationKind {
    Current,
    Retired,
    AdmissionClosed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ArtifactCheckWorkflowEnqueueOutcome {
    Pending,
    Enqueued,
    NotEnqueued,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowStepObservation {
    pub step: ArtifactCheckWorkflowStepIdentity,
    pub outcome: ArtifactCheckWorkflowEnqueueOutcome,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<ExecutionState>")
    )]
    pub execution: Option<ExecutionState>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<ExecutionId>")
    )]
    pub result_id: Option<ExecutionId>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<SavedArtifactCheckProof>")
    )]
    pub proof: Option<SavedArtifactCheckProof>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowObservation {
    pub identity: ArtifactCheckWorkflowIdentity,
    pub kind: ArtifactCheckWorkflowObservationKind,
    pub admission_closed: bool,
    pub callbacks_drained: bool,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<ArtifactCheckWorkflowTask>")
    )]
    pub current_task: Option<ArtifactCheckWorkflowTask>,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<ArtifactCheckWorkflowView>")
    )]
    pub view: Option<ArtifactCheckWorkflowView>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub steps: Vec<ArtifactCheckWorkflowStepObservation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckWorkflowStopReceipt {
    pub identity: ArtifactCheckWorkflowIdentity,
    pub admission_closed: bool,
    pub callbacks_drained: bool,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable::<ArtifactCheckWorkflowTask>")
    )]
    pub current_task: Option<ArtifactCheckWorkflowTask>,
}

fn with_workflow<T>(
    host: &mut ExecutionHost,
    operation: impl FnOnce(&mut WorkflowSession, &mut ExecutionHost) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let mut workflow = host
        .release
        .plugin
        .workflow
        .take()
        .expect("release workflow owner");
    let result = operation(&mut workflow, host);
    host.release.plugin.workflow = Some(workflow);
    result
}
pub(in crate::commands::execution) fn tick(
    host: &mut ExecutionHost,
    store: &mut ProjectStore,
) -> Result<(), CommandError> {
    with_workflow(host, |workflow, host| workflow.tick(host, store))
}

pub(in crate::commands::execution) fn prepare_runtime_tick(
    host: &mut ExecutionHost,
    store: &mut ProjectStore,
) -> Result<
    Option<(
        Arc<crate::commands::plugins::ApplicationPlugins>,
        UnsignedDecimal,
    )>,
    CommandError,
> {
    with_workflow(host, |workflow, host| {
        workflow.prepare_runtime_tick(store, &mut host.runtime)
    })
}

#[tauri::command]
pub async fn read_artifact_check_workflow_session(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<ArtifactCheckWorkflowSessionView, CommandError> {
    state
        .sessions
        .run(
            "read_artifact_check_workflow_session",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let Some(host) = &active.execution else {
                    return Ok(ArtifactCheckWorkflowSessionView::Unavailable);
                };
                let workflow = host
                    .release
                    .plugin
                    .workflow
                    .as_ref()
                    .expect("release workflow owner");
                Ok(ArtifactCheckWorkflowSessionView::Available {
                    owner_id: workflow.owner,
                    next_generation: workflow.next()?,
                    current: workflow
                        .current
                        .as_ref()
                        .map(|i| i.view.preparation.identity.clone()),
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn prepare_artifact_check_workflow(
    state: State<'_, AppState>,
    request: ArtifactCheckWorkflowPrepareRequest,
) -> Result<ArtifactCheckWorkflowView, CommandError> {
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    state
        .sessions
        .run(
            "prepare_artifact_check_workflow",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = active.execution.as_mut().ok_or_else(|| {
                    workflow_error(ErrorCode::Unauthorized, "artifact-workflow-host")
                })?;
                let store = &mut active.store;
                with_workflow(host, |workflow, host| {
                    if let Some(view) = workflow.existing(&request.preparation)? {
                        return Ok(view);
                    }
                    host.allow_mutation()?;
                    workflow.refresh(store, &host.runtime)?;
                    workflow.retire_if_drained();
                    if workflow.busy() || host.release.plugin.job.is_some() {
                        return Err(workflow_error(ErrorCode::Busy, "artifact-workflow-active"));
                    }
                    if let Some(check) = &host.release.plugin.check {
                        let attempt = check.view.attempt_id;
                        if host.runtime.has_owned_attempt_work(attempt)
                            || host
                                .runtime
                                .input_if_present(store, attempt)
                                .map_err(map_read)?
                                .map(|_| store.execution_attempt(attempt, true))
                                .transpose()
                                .map_err(map_read)?
                                .is_some_and(|a| {
                                    a.items.iter().any(|i| {
                                        matches!(
                                            i.execution,
                                            ExecutionState::Queued | ExecutionState::Dispatched
                                        )
                                    })
                                })
                        {
                            return Err(workflow_error(
                                ErrorCode::Busy,
                                "artifact-manual-check-active",
                            ));
                        }
                    }
                    if request.preparation.identity.generation != workflow.next()? {
                        return Err(workflow_error(
                            ErrorCode::Unauthorized,
                            "artifact-workflow-generation",
                        ));
                    }
                    let p = &request.preparation;
                    let captures = store
                        .capture_artifact_check_workflow(
                            request.project_id,
                            p.build_attempt_id,
                            &p.build_input_digest,
                            &p.build_results,
                        )
                        .map_err(map_read)?;
                    let work = host.begin_package_work(vec![p.build.package.clone()])?;
                    workflow.begin(request.preparation, captures, io, plugins, work)
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn start_artifact_check_workflow(
    state: State<'_, AppState>,
    request: ArtifactCheckWorkflowStartRequest,
) -> Result<ArtifactCheckWorkflowView, CommandError> {
    state
        .sessions
        .run(
            "start_artifact_check_workflow",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let host = active.execution.as_mut().ok_or_else(|| {
                    workflow_error(ErrorCode::Unauthorized, "artifact-workflow-host")
                })?;
                with_workflow(host, |workflow, host| {
                    let original = workflow
                        .current
                        .as_ref()
                        .map(|i| &i.view)
                        .filter(|v| v.preparation.identity == request.start.identity)
                        .or_else(|| {
                            workflow
                                .retired
                                .as_ref()
                                .and_then(|r| r.view.as_ref())
                                .filter(|v| v.preparation.identity == request.start.identity)
                        });
                    if original.is_some_and(|v| v.start.is_some()) {
                        return workflow.start(&request.start);
                    }
                    host.allow_mutation()?;
                    workflow.start(&request.start)
                })
            },
        )
        .await
}

fn observe_steps(
    store: &ProjectStore,
    preparation: &ArtifactCheckWorkflowPreparation,
    start: Option<&ArtifactCheckWorkflowStart>,
    closed: bool,
) -> Result<Vec<ArtifactCheckWorkflowStepObservation>, CommandError> {
    let Some(start) = start else {
        return Ok(vec![]);
    };
    if start.identity != preparation.identity
        || start.consents.is_empty()
        || start.consents.len() > 16
        || sdk::validate_package_digest(&start.materialization_digest).is_err()
    {
        return Err(workflow_error(
            ErrorCode::ResultMismatch,
            "artifact-workflow-start",
        ));
    }
    let mut attempts = std::collections::BTreeSet::new();
    let mut grants = std::collections::BTreeSet::new();
    start
        .consents
        .iter()
        .map(|consent| {
            let step = &consent.step;
            if !attempts.insert(step.attempt_id)
                || !grants.insert(consent.grant_id)
                || !preparation
                    .build_results
                    .iter()
                    .any(|r| r.item_id == step.build_item_id && r.result_id == step.build_result_id)
            {
                return Err(workflow_error(
                    ErrorCode::ResultMismatch,
                    "artifact-workflow-step",
                ));
            }
            let input = store
                .reconcile_plugin_start(
                    consent.grant_id,
                    step.attempt_id,
                    &step.input_digest,
                    consent.expires_at_ms.get(),
                    PluginConsent {
                        unsandboxed_execution: consent.unsandboxed_execution,
                        application_execution: false,
                    },
                )
                .map_err(map_read)?;
            let Some(input) = input else {
                return Ok(ArtifactCheckWorkflowStepObservation {
                    step: step.clone(),
                    outcome: if closed {
                        ArtifactCheckWorkflowEnqueueOutcome::NotEnqueued
                    } else {
                        ArtifactCheckWorkflowEnqueueOutcome::Pending
                    },
                    execution: None,
                    result_id: None,
                    proof: None,
                });
            };
            if input.envelope().task_id != step.task_id
                || input.envelope().items.len() != 1
                || input.envelope().items[0].scope.locale.as_deref() != Some(step.locale.as_str())
            {
                return Err(workflow_error(
                    ErrorCode::ResultMismatch,
                    "artifact-workflow-step",
                ));
            }
            let original = store
                .verify_artifact_check_association(
                    input.envelope().project_id,
                    preparation.build_attempt_id,
                    &preparation.build_input_digest,
                    &ArtifactCheckBuildResultRef {
                        item_id: step.build_item_id,
                        result_id: step.build_result_id,
                    },
                    &input,
                )
                .map_err(map_read)?;
            if original.0 != step.producer_attempt_id || original.1 != step.producer_input_digest {
                return Err(workflow_error(
                    ErrorCode::ResultMismatch,
                    "artifact-workflow-producer",
                ));
            }
            let attempt = store
                .execution_attempt(step.attempt_id, true)
                .map_err(map_read)?;
            let result_id = store
                .execution_current_result(step.attempt_id, input.envelope().items[0].item_id)
                .map_err(map_read)?;
            let proof = store
                .read_artifact_check_proof(
                    input.envelope().project_id,
                    preparation.build_attempt_id,
                    step.build_result_id,
                )
                .map_err(map_read)?
                .filter(|proof| proof.checker_attempt_id == step.attempt_id);
            Ok(ArtifactCheckWorkflowStepObservation {
                step: step.clone(),
                outcome: ArtifactCheckWorkflowEnqueueOutcome::Enqueued,
                execution: Some(attempt.items[0].execution),
                result_id,
                proof,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn read_artifact_check_workflow(
    state: State<'_, AppState>,
    request: ArtifactCheckWorkflowReadRequest,
) -> Result<ArtifactCheckWorkflowObservation, CommandError> {
    state
        .sessions
        .run(
            "read_artifact_check_workflow",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = active.execution.as_ref().ok_or_else(|| {
                    workflow_error(ErrorCode::Unauthorized, "artifact-workflow-host")
                })?;
                let workflow = host
                    .release
                    .plugin
                    .workflow
                    .as_ref()
                    .expect("release workflow owner");
                let identity = &request.preparation.identity;
                workflow.validate_identity(identity)?;
                let view = workflow.existing(&request.preparation)?;
                let current = workflow
                    .current
                    .as_ref()
                    .is_some_and(|i| i.view.preparation.identity == *identity);
                if identity.generation > workflow.consumed {
                    return Err(workflow_error(
                        ErrorCode::Unauthorized,
                        "artifact-workflow-generation",
                    ));
                }
                if let (Some(requested), Some(original)) =
                    (&request.start, view.as_ref().and_then(|v| v.start.as_ref()))
                {
                    if requested != original {
                        return Err(workflow_error(
                            ErrorCode::ResultMismatch,
                            "artifact-workflow-start",
                        ));
                    }
                }
                let closed = view.as_ref().map_or(true, |v| v.admission_closed);
                let effective = request
                    .start
                    .as_ref()
                    .or_else(|| view.as_ref().and_then(|v| v.start.as_ref()));
                let steps = observe_steps(&active.store, &request.preparation, effective, closed)?;
                Ok(ArtifactCheckWorkflowObservation {
                    identity: identity.clone(),
                    kind: if current {
                        ArtifactCheckWorkflowObservationKind::Current
                    } else if workflow
                        .retired
                        .as_ref()
                        .is_some_and(|r| r.identity == *identity)
                    {
                        ArtifactCheckWorkflowObservationKind::Retired
                    } else {
                        ArtifactCheckWorkflowObservationKind::AdmissionClosed
                    },
                    admission_closed: closed,
                    callbacks_drained: view.as_ref().map_or(true, |v| v.callbacks_drained),
                    current_task: view.as_ref().and_then(|v| v.current_task.clone()),
                    view,
                    steps,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn stop_artifact_check_workflow(
    state: State<'_, AppState>,
    request: ArtifactCheckWorkflowStopRequest,
) -> Result<ArtifactCheckWorkflowStopReceipt, CommandError> {
    state
        .sessions
        .run(
            "stop_artifact_check_workflow",
            CommandStage::ExecutionCancel,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                let host = active.execution.as_mut().ok_or_else(|| {
                    workflow_error(ErrorCode::Unauthorized, "artifact-workflow-host")
                })?;
                with_workflow(host, |workflow, host| {
                    workflow.validate_identity(&request.identity)?;
                    if workflow
                        .current
                        .as_ref()
                        .is_some_and(|i| i.view.preparation.identity == request.identity)
                    {
                        workflow.close(true);
                        workflow.refresh(&active.store, &host.runtime)?;
                        workflow.retire_if_drained();
                    } else if request.identity.generation == workflow.next()? {
                        if workflow.busy() {
                            return Err(workflow_error(
                                ErrorCode::Busy,
                                "artifact-workflow-active",
                            ));
                        }
                        // A stop accepted before a delayed prepare consumes its exact
                        // generation. That prepare can never acquire this slot later.
                        workflow.consumed = request.identity.generation;
                        workflow.retired = Some(state::Retired {
                            identity: request.identity.clone(),
                            view: None,
                        });
                    } else if request.identity.generation > workflow.consumed {
                        return Err(workflow_error(
                            ErrorCode::Unauthorized,
                            "artifact-workflow-generation",
                        ));
                    }
                    let view = workflow
                        .current
                        .as_ref()
                        .map(|i| &i.view)
                        .filter(|v| v.preparation.identity == request.identity)
                        .or_else(|| {
                            workflow
                                .retired
                                .as_ref()
                                .and_then(|r| r.view.as_ref())
                                .filter(|v| v.preparation.identity == request.identity)
                        });
                    Ok(ArtifactCheckWorkflowStopReceipt {
                        identity: request.identity,
                        admission_closed: true,
                        callbacks_drained: view.map_or(true, |v| v.callbacks_drained),
                        current_task: view.and_then(|v| v.current_task.clone()),
                    })
                })
            },
        )
        .await
}
