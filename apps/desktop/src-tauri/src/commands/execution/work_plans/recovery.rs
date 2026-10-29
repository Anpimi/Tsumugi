//! Explicit human continuation retains the original live runtime and budget.
use super::member::environment::{EnvironmentAdmission, EnvironmentAttempt};
use super::*;
use tsumugi_core::application::{
    AuthorizeTeamRecovery, PrepareTeamRecovery, PreparedTeamRecovery, TeamEffectiveVersion,
    TeamExecutionLimits, TeamExecutionMember, TeamHumanWork, TeamRecoveryDiscussionPreview,
    TeamRecoveryPreview, TeamRecoveryReceipt, TeamRecoveryRuntimeState, TeamRecoveryState,
    TeamWorkReference,
};

pub(super) struct RecoveryPreparation {
    id: ExecutionId,
    request: PrepareTeamRecovery,
    prepared: Option<PreparedTeamRecovery>,
    settings_revision: Option<UnsignedDecimal>,
    authorized_action: Option<ExecutionId>,
    pub(super) stop: Cancellation,
}
impl RecoveryPreparation {
    pub(super) fn new(id: ExecutionId, request: PrepareTeamRecovery, stop: Cancellation) -> Self {
        Self {
            id,
            request,
            prepared: None,
            settings_revision: None,
            authorized_action: None,
            stop,
        }
    }
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamRecoveryPrepareRequest {
        preparation_id: ExecutionId,
        recovery: PrepareTeamRecovery
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamRecoveryAuthorizeRequest {
        preparation_id: ExecutionId,
        plan_id: ExecutionId,
        recovery: AuthorizeTeamRecovery,
        checker_executions: Vec<ReviewCheckerKey>,
        tool_execution: bool,
        #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
        application_tool_executions: Vec<tsumugi_core::execution::ApplicationScopeBasis>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamRecoveryStateRequest {
        plan_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamRecoverySettlementRequest {
        preparation_id: ExecutionId,
        plan_id: ExecutionId,
        base_lease: AutomationLease,
        recovery: AuthorizeTeamRecovery,
        checker_executions: Vec<ReviewCheckerKey>,
        tool_execution: bool,
        #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
        application_tool_executions: Vec<tsumugi_core::execution::ApplicationScopeBasis>
    }
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoverySettlementOriginal {
    pub project_id: ExecutionId,
    pub preparation_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub base_lease: AutomationLease,
    pub recovery: AuthorizeTeamRecovery,
    pub checker_executions: Vec<ReviewCheckerKey>,
    pub tool_execution: bool,
    pub application_tool_executions: Vec<tsumugi_core::execution::ApplicationScopeBasis>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoverySettlementView {
    pub request: WorkPlanTeamRecoverySettlementOriginal,
    pub settlement: WorkPlanRequestSettlement<TeamRecoveryReceipt>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoveryPrepareOriginal {
    pub project_id: ExecutionId,
    pub preparation_id: ExecutionId,
    pub recovery: PrepareTeamRecovery,
}
impl From<&WorkPlanTeamRecoveryPrepareRequest> for WorkPlanTeamRecoveryPrepareOriginal {
    fn from(request: &WorkPlanTeamRecoveryPrepareRequest) -> Self {
        Self {
            project_id: request.project_id,
            preparation_id: request.preparation_id,
            recovery: request.recovery.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanTeamRecoveryPreparationOutcome {
    Pending,
    Draining,
    /// Only the original Host slot is closed. Releasing a durable pending
    /// request additionally requires a later Core lease generation.
    Closed,
    FencedNotApplied,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoveryPreparationView {
    pub request: WorkPlanTeamRecoveryPrepareOriginal,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub host_callbacks_drained: bool,
    pub outcome: WorkPlanTeamRecoveryPreparationOutcome,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamRecoveryPreviewView {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub base_lease: AutomationLease,
    pub base_effective_version: TeamEffectiveVersion,
    pub digest: String,
    pub members: Vec<TeamExecutionMember>,
    pub retired_member_ids: Vec<ExecutionId>,
    pub member_previews: Vec<TeamMemberPreviewView>,
    pub discussion_previews: Vec<TeamRecoveryDiscussionPreview>,
    pub work: TeamHumanWork,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub root_task_id: ExecutionId,
    pub expires_at_ms: UnsignedDecimal,
    pub limits: TeamExecutionLimits,
    pub budget: tsumugi_core::ProviderBudget,
    pub activations: u32,
    pub unconfirmed_completions: u32,
}
impl From<TeamRecoveryPreview> for TeamRecoveryPreviewView {
    fn from(value: TeamRecoveryPreview) -> Self {
        Self {
            project_id: value.project_id,
            plan_id: value.plan_id,
            base_lease: value.base_lease,
            base_effective_version: value.base_effective_version,
            digest: value.digest,
            members: value.members,
            retired_member_ids: value.retired_member_ids,
            member_previews: value
                .member_previews
                .into_iter()
                .map(|member| TeamMemberPreviewView {
                    member_id: member.member_id,
                    preview: member.preview.into(),
                })
                .collect(),
            discussion_previews: value.discussion_previews,
            work: value.work,
            task_id: value.task_id,
            attempt_id: value.attempt_id,
            input_digest: value.input_digest,
            root_task_id: value.root_task_id,
            expires_at_ms: value.expires_at_ms.into(),
            limits: value.limits,
            budget: value.budget,
            activations: value.activations,
            unconfirmed_completions: value.unconfirmed_completions,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoveryPreviewView {
    pub preparation_id: ExecutionId,
    pub preview: TeamRecoveryPreviewView,
    pub tools: Option<WorkPlanTools>,
    pub checkers: Vec<WorkPlanCheckerView>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoveryStateView {
    pub state: TeamRecoveryStateView,
    pub runtime: Option<TeamRecoveryRuntimeState>,
    pub host_callbacks_drained: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamRecoveryStateView {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub effective_version: TeamEffectiveVersion,
    pub root_task_id: ExecutionId,
    pub expires_at_ms: UnsignedDecimal,
    pub budget: tsumugi_core::ProviderBudget,
    pub activations: u32,
    pub unconfirmed_completions: u32,
    pub unresolved_work: Vec<TeamWorkReference>,
}
impl From<TeamRecoveryState> for TeamRecoveryStateView {
    fn from(value: TeamRecoveryState) -> Self {
        Self {
            project_id: value.project_id,
            plan_id: value.plan_id,
            lease: value.lease,
            state: value.state,
            effective_version: value.effective_version,
            root_task_id: value.root_task_id,
            expires_at_ms: value.expires_at_ms.into(),
            budget: value.budget,
            activations: value.activations,
            unconfirmed_completions: value.unconfirmed_completions,
            unresolved_work: value.unresolved_work,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoveryRecordedRequest {
    pub plan_id: ExecutionId,
    pub recovery: AuthorizeTeamRecovery,
    pub checker_executions: Vec<ReviewCheckerKey>,
    pub tool_execution: bool,
    pub application_tool_executions: Vec<tsumugi_core::execution::ApplicationScopeBasis>,
}
impl From<&WorkPlanTeamRecoveryAuthorizeRequest> for WorkPlanTeamRecoveryRecordedRequest {
    fn from(request: &WorkPlanTeamRecoveryAuthorizeRequest) -> Self {
        Self {
            plan_id: request.plan_id,
            recovery: request.recovery.clone(),
            checker_executions: request.checker_executions.clone(),
            tool_execution: request.tool_execution,
            application_tool_executions: request.application_tool_executions.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTeamRecoveryActionView {
    pub project_id: ExecutionId,
    pub request: WorkPlanTeamRecoveryRecordedRequest,
    pub receipt: TeamRecoveryReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanTeamRecoveryEndView {
    AuthorizationRecorded {
        action: WorkPlanTeamRecoveryActionView,
    },
    PreparationClosed {
        project_id: ExecutionId,
        preparation_id: ExecutionId,
        request: WorkPlanTeamRecoveryRecordedRequest,
    },
}

fn fail(code: ErrorCode, reason: &str) -> CommandError {
    map_recover(ExecutionError::new(code, reason))
}
fn host<'a>(
    active: &'a mut crate::commands::ActiveSession,
) -> Result<(&'a mut ExecutionHost, &'a mut ProjectStore), CommandError> {
    let host = active
        .execution
        .as_mut()
        .ok_or_else(|| fail(ErrorCode::Unauthorized, "team-recovery-original-runtime"))?;
    host.allow_mutation()?;
    Ok((host, &mut active.store))
}
fn callbacks(host: &ExecutionHost, plan: ExecutionId) -> Result<(), CommandError> {
    if host.plan_callbacks_active(plan) {
        Err(fail(ErrorCode::Busy, "team-recovery-host-draining"))
    } else {
        Ok(())
    }
}

/// Descriptive only: a missing slot never proves that an accepted preparation
/// did not run. The Core generation is the durable fence against later replay.
pub(in crate::commands) fn observe_prepare(
    store: &ProjectStore,
    host: Option<&ExecutionHost>,
    request: &WorkPlanTeamRecoveryPrepareOriginal,
) -> Result<WorkPlanTeamRecoveryPreparationView, CommandError> {
    let recovery = &request.recovery;
    if request.project_id != recovery.project_id
        || recovery.expected_lease.plan_id != recovery.plan_id
        || recovery.expected_lease.generation.get() == 0
    {
        return Err(fail(
            ErrorCode::ResultMismatch,
            "team-recovery-preparation-request",
        ));
    }
    let state = store
        .read_team_recovery_state(request.project_id, recovery.plan_id)
        .map_err(map_read)?;
    let drained = host.is_none_or(|host| !host.plan_callbacks_active(recovery.plan_id));
    let stopped = host
        .and_then(|host| host.work_plans.recovery.as_ref())
        .is_some_and(|slot| {
            slot.id == request.preparation_id
                && slot.request == *recovery
                && slot.stop.is_requested()
        });
    let outcome = if stopped {
        if drained {
            WorkPlanTeamRecoveryPreparationOutcome::Closed
        } else {
            WorkPlanTeamRecoveryPreparationOutcome::Draining
        }
    } else if host.is_none()
        && drained
        && state.lease.generation > recovery.expected_lease.generation
    {
        WorkPlanTeamRecoveryPreparationOutcome::FencedNotApplied
    } else {
        WorkPlanTeamRecoveryPreparationOutcome::Pending
    };
    Ok(WorkPlanTeamRecoveryPreparationView {
        request: request.clone(),
        lease: state.lease,
        state: state.state,
        host_callbacks_drained: drained,
        outcome,
    })
}

fn check_settlement_choices(
    store: &ProjectStore,
    request: &WorkPlanTeamRecoverySettlementOriginal,
) -> Result<(), ExecutionError> {
    if request.plan_id != request.base_lease.plan_id {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "team-recovery-base-lease",
        ));
    }
    let plan = store.work_plan(request.plan_id)?;
    let keys: Vec<_> = store
        .work_plan_review_checkers(&plan)?
        .into_iter()
        .map(|checker| checker.key)
        .collect();
    if plan.project_id != request.project_id
        || request.checker_executions != keys
        || request.tool_execution != plan.tools.is_some()
        || !request.recovery.confirmed
        || request.recovery.effects != plan.authorization_effects()?
    {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "team-recovery-consent",
        ));
    }
    broker::require_consent(
        &plan,
        request.tool_execution,
        Some(&request.recovery.effects),
        &request.application_tool_executions,
    )
    .map_err(|_| {
        ExecutionError::new(
            ErrorCode::ResultMismatch,
            "team-recovery-application-consent",
        )
    })
}

/// A pure journal observation binds both the complete preparation and the
/// authorization, including every deterministic Host consent choice.
pub(crate) fn observe_settlement(
    store: &ProjectStore,
    preparation: &WorkPlanTeamRecoveryPrepareOriginal,
    request: &WorkPlanTeamRecoverySettlementOriginal,
) -> Result<WorkPlanRequestSettlement<TeamRecoveryReceipt>, ExecutionError> {
    if preparation.project_id != request.project_id
        || preparation.preparation_id != request.preparation_id
        || preparation.recovery.project_id != request.project_id
        || preparation.recovery.plan_id != request.plan_id
        || preparation.recovery.expected_lease != request.base_lease
    {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "team-recovery-preparation-request",
        ));
    }
    check_settlement_choices(store, request)?;
    store.team_recovery_preparation_settlement(&preparation.recovery, &request.recovery)
}
fn connections(
    store: Option<&tsumugi_core::model_connections::ModelConnectionStore>,
    preview: &TeamRecoveryPreview,
) -> Result<(), CommandError> {
    let configs: Vec<_> = preview
        .members
        .iter()
        .map(|member| member.config.clone())
        .collect();
    crate::commands::connections::verify_configs(store, &configs)
}
fn confirmations(
    store: &ProjectStore,
    plan: &WorkPlan,
    request: &WorkPlanTeamRecoveryAuthorizeRequest,
) -> Result<(), CommandError> {
    if request.tool_execution != plan.tools.is_some() {
        return Err(fail(
            ErrorCode::ResultMismatch,
            "team-recovery-tool-consent",
        ));
    }
    broker::require_consent(
        plan,
        request.tool_execution,
        Some(&request.recovery.effects),
        &request.application_tool_executions,
    )?;
    let expected = store.work_plan_review_checkers(plan).map_err(map_recover)?;
    let keys: Vec<_> = expected.iter().map(|checker| checker.key.clone()).collect();
    if keys != request.checker_executions {
        return Err(fail(
            ErrorCode::ResultMismatch,
            "team-recovery-checker-consent",
        ));
    }
    Ok(())
}
fn exact_action(
    store: &ProjectStore,
    request: &WorkPlanTeamRecoveryAuthorizeRequest,
) -> Result<Option<TeamRecoveryReceipt>, CommandError> {
    let Some(receipt) = store
        .read_team_recovery_action(request.project_id, &request.recovery)
        .map_err(map_read)?
    else {
        return Ok(None);
    };
    if receipt.base_lease.plan_id != request.plan_id {
        return Err(fail(ErrorCode::ResultMismatch, "team-recovery-action"));
    }
    let plan = store
        .team_recovery_action_plan(request.project_id, &request.recovery)
        .map_err(map_read)?
        .ok_or_else(|| fail(ErrorCode::CorruptLedger, "team-recovery-action"))?;
    confirmations(store, &plan, request)?;
    Ok(Some(receipt))
}

pub(super) fn start_revision(
    host: &ExecutionHost,
    prepared: &tsumugi_core::application::PreparedTeamWork,
    action: ExecutionId,
) -> Result<Option<UnsignedDecimal>, CommandError> {
    if !matches!(
        ai::team::settings(prepared.input())
            .map_err(map_recover)?
            .binding,
        tsumugi_core::application::TeamWorkBinding::HumanContinuation { .. }
    ) {
        return Ok(None);
    }
    let slot = host
        .work_plans
        .recovery
        .as_ref()
        .filter(|slot| slot.authorized_action == Some(action) && !slot.stop.is_requested())
        .ok_or_else(|| {
            fail(
                ErrorCode::Unauthorized,
                "team-recovery-original-preparation",
            )
        })?;
    let capture = slot.prepared.as_ref().ok_or_else(|| {
        fail(
            ErrorCode::Unauthorized,
            "team-recovery-original-preparation",
        )
    })?;
    if Instant::now() >= capture.deadline()
        || capture.preview().input_digest != prepared.input().digest()
    {
        return Err(fail(
            ErrorCode::Unauthorized,
            "team-recovery-original-preparation",
        ));
    }
    callbacks(host, prepared.receipt().plan_id)?;
    Ok(Some(slot.settings_revision.ok_or_else(|| {
        fail(ErrorCode::Unauthorized, "team-recovery-environment")
    })?))
}

#[tauri::command]
pub async fn read_work_plan_team_recovery_state(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoveryStateRequest,
) -> Result<WorkPlanTeamRecoveryStateView, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_recovery_state",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let view = active
                    .store
                    .read_team_recovery_state(request.project_id, request.plan_id)
                    .map_err(map_read)?;
                let runtime = active
                    .execution
                    .as_ref()
                    .map(|host| {
                        host.runtime
                            .team_recovery_state(&active.store, request.plan_id)
                    })
                    .transpose()
                    .map_err(map_read)?;
                Ok(WorkPlanTeamRecoveryStateView {
                    state: view.into(),
                    runtime,
                    host_callbacks_drained: active
                        .execution
                        .as_ref()
                        .is_none_or(|host| !host.plan_callbacks_active(request.plan_id)),
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_team_recovery_action(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoveryAuthorizeRequest,
) -> Result<Option<WorkPlanTeamRecoveryActionView>, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_recovery_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                Ok(exact_action(&active.store, &request)?.map(|receipt| {
                    WorkPlanTeamRecoveryActionView {
                        project_id: request.project_id,
                        request: (&request).into(),
                        receipt,
                    }
                }))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_team_recovery_settlement(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoverySettlementRequest,
) -> Result<WorkPlanTeamRecoverySettlementView, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_recovery_settlement",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                // Host choices are deterministic parts of the original plan consent;
                // observing them never reinstalls a local checker or tool permission.
                let original = WorkPlanTeamRecoverySettlementOriginal {
                    project_id: request.project_id,
                    preparation_id: request.preparation_id,
                    plan_id: request.plan_id,
                    base_lease: request.base_lease,
                    recovery: request.recovery,
                    checker_executions: request.checker_executions,
                    tool_execution: request.tool_execution,
                    application_tool_executions: request.application_tool_executions,
                };
                check_settlement_choices(&active.store, &original).map_err(map_read)?;
                let settlement = active
                    .store
                    .team_recovery_settlement(
                        original.project_id,
                        &original.base_lease,
                        &original.recovery,
                    )
                    .map_err(map_read)?;
                Ok(WorkPlanTeamRecoverySettlementView {
                    request: original,
                    settlement,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_team_recovery_preparation(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoveryPrepareRequest,
) -> Result<WorkPlanTeamRecoveryPreparationView, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_recovery_preparation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                observe_prepare(&active.store, active.execution.as_ref(), &(&request).into())
            },
        )
        .await
}

#[tauri::command]
pub async fn close_work_plan_team_recovery_preparation(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoveryPrepareRequest,
) -> Result<WorkPlanTeamRecoveryPreparationView, CommandError> {
    state
        .sessions
        .run(
            "close_work_plan_team_recovery_preparation",
            CommandStage::ExecutionCancel,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                let original = (&request).into();
                // Validate the project and basis before touching any Host state.
                observe_prepare(&active.store, active.execution.as_ref(), &original)?;
                if let Some(slot) = active
                    .execution
                    .as_mut()
                    .and_then(|host| host.work_plans.recovery.as_mut())
                {
                    if slot.id == request.preparation_id && slot.request == request.recovery {
                        slot.stop.request();
                    }
                }
                // Keep the stopped slot while accepted IO drains. Repeating this exact
                // close can then observe closure without mistaking not-found for proof.
                observe_prepare(&active.store, active.execution.as_ref(), &original)
            },
        )
        .await
}

#[tauri::command]
pub async fn end_work_plan_team_recovery(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoveryAuthorizeRequest,
) -> Result<WorkPlanTeamRecoveryEndView, CommandError> {
    state
        .sessions
        .run(
            "end_work_plan_team_recovery",
            CommandStage::ExecutionCancel,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                let recorded = |receipt| WorkPlanTeamRecoveryEndView::AuthorizationRecorded {
                    action: WorkPlanTeamRecoveryActionView {
                        project_id: request.project_id,
                        request: (&request).into(),
                        receipt,
                    },
                };
                if let Some(receipt) = exact_action(&active.store, &request)? {
                    return Ok(recorded(receipt));
                }
                let plan = active.store.work_plan(request.plan_id).map_err(map_read)?;
                if plan.project_id != request.project_id
                    || plan.options.team_execution.is_none()
                    || !request.recovery.confirmed
                    || request.recovery.effects != plan.authorization_effects().map_err(map_read)?
                {
                    return Err(fail(
                        ErrorCode::ResultMismatch,
                        "team-recovery-close-request",
                    ));
                }
                confirmations(&active.store, &plan, &request)?;
                if let Some(host) = active.execution.as_mut() {
                    let matches = host.work_plans.recovery.as_ref().is_some_and(|slot| {
                        slot.id == request.preparation_id
                            && slot.request.plan_id == request.plan_id
                            && slot
                                .authorized_action
                                .is_none_or(|action| action == request.recovery.action_id)
                            && slot.prepared.as_ref().is_some_and(|prepared| {
                                prepared.preview().digest == request.recovery.digest
                            })
                    });
                    if matches {
                        host.work_plans.clear_recovery();
                    }
                }
                // Owner serialization makes revocation and this final receipt check one
                // boundary. An accepted IO continuation must recheck its original stop.
                if let Some(receipt) = exact_action(&active.store, &request)? {
                    return Ok(recorded(receipt));
                }
                Ok(WorkPlanTeamRecoveryEndView::PreparationClosed {
                    project_id: request.project_id,
                    preparation_id: request.preparation_id,
                    request: (&request).into(),
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn prepare_work_plan_team_recovery(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoveryPrepareRequest,
) -> Result<WorkPlanTeamRecoveryPreviewView, CommandError> {
    let model_connections = crate::commands::connections::captured_store(&state);
    let initial_connections = model_connections.clone();
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let (prepared, work, stop, generation, source, checkers) = lease
        .run(
            "prepare_work_plan_team_recovery.capture",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRead,
                )?;
                if initial.recovery.project_id != initial.project_id {
                    return Err(fail(ErrorCode::ResultMismatch, "team-recovery-project"));
                }
                let (host, store) = host(active)?;
                if host.work_plans.recovery.as_ref().is_some_and(|slot| {
                    slot.id == initial.preparation_id && slot.request == initial.recovery
                }) {
                    return Err(fail(
                        ErrorCode::DependencyConflict,
                        "team-recovery-preparation-replay",
                    ));
                }
                host.work_plans.clear_recovery();
                host.work_plans.prepared = None;
                callbacks(host, initial.recovery.plan_id)?;
                let prepared = host
                    .runtime
                    .prepare_team_recovery(store, &initial.recovery)
                    .map_err(map_read)?;
                connections(initial_connections.as_ref(), prepared.preview())?;
                let packages = store
                    .work_plan_review_checkers(prepared.plan())
                    .map_err(map_read)?
                    .iter()
                    .map(|checker| package_lifecycle::binding_package(&checker.binding))
                    .collect();
                let work = host.begin_plan_work(initial.recovery.plan_id, packages)?;
                let stop = Cancellation::default();
                host.work_plans.recovery = Some(RecoveryPreparation::new(
                    initial.preparation_id,
                    initial.recovery,
                    stop.clone(),
                ));
                let source = store
                    .work_plan_review_binding(prepared.plan())
                    .map_err(map_read)?;
                let checkers = store
                    .work_plan_review_checkers(prepared.plan())
                    .map_err(map_read)?;
                Ok((
                    prepared,
                    work,
                    stop,
                    host.runtime.generation(),
                    source,
                    checkers,
                ))
            },
        )
        .await?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let admission = EnvironmentAdmission::new(prepared.deadline(), vec![stop.clone()]);
        let expected_revision = broker::tools_revision(prepared.plan())?;
        let plan = prepared.plan().clone();
        let runtime_revision = admission
            .wait(
                || Ok(()),
                || {
                    let io = io.clone();
                    let plugins = plugins.clone();
                    let work = work.clone();
                    let admission = admission.clone();
                    let plan = plan.clone();
                    async move {
                        io.run(CommandStage::ExecutionRead, move || {
                            work.check()?;
                            // This entire admission phase reads exact installed facts only.
                            let captured = (|| {
                                broker::recapture_tools(&plugins, &plan)?;
                                plugins
                                    .capture_member_environment(expected_revision, || {
                                        admission.check().is_ok() && work.check().is_ok()
                                    })
                                    .map(|environment| environment.settings_revision)
                            })();
                            Ok(EnvironmentAttempt::read_only(captured))
                        })
                        .await
                    }
                },
            )
            .await
            .map_err(map_recover)?;
        let (environments, views) = load_checkers(
            io,
            plugins.clone(),
            source,
            checkers,
            prepared.plan().options.advisory_checks.clone(),
            None,
            work.clone(),
        )
        .await?;
        if checker_environment_revision(&environments)?
            .is_some_and(|checker| checker != runtime_revision)
        {
            return Err(super::super::review::checkers::stale());
        }
        lease
            .run(
                "prepare_work_plan_team_recovery.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, store) = host(active)?;
                    work.check()?;
                    admission.check().map_err(map_recover)?;
                    drop(work);
                    let current = host
                        .work_plans
                        .recovery
                        .as_ref()
                        .filter(|slot| {
                            slot.id == request.preparation_id
                                && slot.request == request.recovery
                                && !slot.stop.is_requested()
                        })
                        .ok_or_else(|| {
                            fail(ErrorCode::DependencyConflict, "team-recovery-preparation")
                        })?;
                    let _ = current;
                    if host.runtime.generation() != generation {
                        return Err(fail(
                            ErrorCode::Unauthorized,
                            "team-recovery-original-runtime",
                        ));
                    }
                    callbacks(host, request.recovery.plan_id)?;
                    plugins.with_environment_revision(runtime_revision, || {
                        host.runtime
                            .check_team_recovery(store, &prepared)
                            .map_err(map_read)?;
                        connections(model_connections.as_ref(), prepared.preview())?;
                        let view = WorkPlanTeamRecoveryPreviewView {
                            preparation_id: request.preparation_id,
                            preview: prepared.preview().clone().into(),
                            tools: prepared.plan().tools.clone(),
                            checkers: views,
                        };
                        host.work_plans.environments.insert(
                            request.recovery.plan_id,
                            (prepared.plan().digest.clone(), environments),
                        );
                        let slot = host
                            .work_plans
                            .recovery
                            .as_mut()
                            .expect("checked preparation");
                        slot.prepared = Some(prepared);
                        slot.settings_revision = Some(runtime_revision);
                        Ok(view)
                    })
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn authorize_work_plan_team_recovery(
    state: State<'_, AppState>,
    request: WorkPlanTeamRecoveryAuthorizeRequest,
) -> Result<TeamRecoveryReceipt, CommandError> {
    let model_connections = crate::commands::connections::captured_store(&state);
    let initial_connections = model_connections.clone();
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let initial_plugins = state.plugins.clone();
    let captured = lease
        .run(
            "authorize_work_plan_team_recovery.capture",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                if let Some(receipt) = exact_action(&active.store, &initial)? {
                    return Ok(Err(receipt));
                }
                let (host, store) = host(active)?;
                callbacks(host, initial.plan_id)?;
                let slot = host
                    .work_plans
                    .recovery
                    .as_ref()
                    .filter(|slot| {
                        slot.id == initial.preparation_id
                            && slot.request.plan_id == initial.plan_id
                            && !slot.stop.is_requested()
                    })
                    .ok_or_else(|| {
                        fail(ErrorCode::DependencyConflict, "team-recovery-preparation")
                    })?;
                let prepared = slot
                    .prepared
                    .clone()
                    .ok_or_else(|| fail(ErrorCode::Busy, "team-recovery-preparation"))?;
                prepared
                    .verify_digest(&initial.recovery.digest)
                    .map_err(map_recover)?;
                let revision = slot
                    .settings_revision
                    .ok_or_else(|| fail(ErrorCode::Unauthorized, "team-recovery-environment"))?;
                let stop = slot.stop.clone();
                confirmations(store, prepared.plan(), &initial)?;
                connections(initial_connections.as_ref(), prepared.preview())?;
                broker::capture_recovery_intent(
                    host,
                    prepared.plan(),
                    initial.recovery.action_id,
                    prepared.preview().expires_at_ms / 1000,
                    prepared.deadline(),
                    &initial,
                    &initial.application_tool_executions,
                    initial.tool_execution,
                    &initial_plugins,
                )?;
                let environments = consent_environments(
                    host,
                    store,
                    prepared.plan(),
                    &initial.checker_executions,
                )?;
                let work = host.begin_plan_work(
                    initial.plan_id,
                    environments
                        .iter()
                        .map(|(_, checker)| package_lifecycle::binding_package(&checker.binding))
                        .collect(),
                )?;
                Ok(Ok((
                    prepared,
                    revision,
                    stop,
                    environments,
                    work,
                    host.runtime.generation(),
                )))
            },
        )
        .await?;
    let (prepared, revision, stop, environments, work, generation) = match captured {
        Err(receipt) => return Ok(receipt),
        Ok(value) => value,
    };
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (checker_revision, runners) =
            checker_runners(io, plugins.clone(), environments, Some(work.clone())).await?;
        #[cfg(test)]
        {
            let checking = request.clone();
            if let Some(probe) = lease
                .run(
                    "authorize_work_plan_team_recovery.probe",
                    CommandStage::ExecutionRead,
                    move |sessions| {
                        let active = authorized(
                            sessions,
                            &checking.session_token,
                            checking.project_id,
                            CommandStage::ExecutionRead,
                        )?;
                        Ok(active
                            .execution
                            .as_mut()
                            .and_then(|host| host.work_plans.recovery_authorize_probe.take()))
                    },
                )
                .await?
            {
                probe.after_successful_capture(revision).await;
            }
        }
        if checker_revision.is_some_and(|checker| checker != revision) {
            return Err(super::super::review::checkers::stale());
        }
        lease
            .run(
                "authorize_work_plan_team_recovery.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRecover,
                    )?;
                    if let Some(receipt) = exact_action(&active.store, &request)? {
                        return Ok(receipt);
                    }
                    let (host, store) = host(active)?;
                    work.check()?;
                    drop(work);
                    if stop.is_requested()
                        || Instant::now() >= prepared.deadline()
                        || host.runtime.generation() != generation
                    {
                        return Err(fail(ErrorCode::Unauthorized, "team-recovery-preparation"));
                    }
                    if !host.work_plans.recovery.as_ref().is_some_and(|slot| {
                        slot.id == request.preparation_id && !slot.stop.is_requested()
                    }) {
                        return Err(fail(
                            ErrorCode::DependencyConflict,
                            "team-recovery-preparation",
                        ));
                    }
                    callbacks(host, request.plan_id)?;
                    plugins.with_environment_revision(revision, || {
                        connections(model_connections.as_ref(), prepared.preview())?;
                        for (runner, checker) in &runners {
                            host.register_plugin(runner.clone(), checker.binding.clone())
                                .map_err(map_recover)?;
                        }
                        let receipt = host
                            .runtime
                            .authorize_team_recovery(store, &prepared, &request.recovery)
                            .map_err(map_recover)?;
                        let standard = store
                            .work_plan_receipt(receipt.action_id)
                            .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
                            .ok_or_else(|| CommandError::unknown(CommandStage::ExecutionRecover))?;
                        broker::save_consent(host, store, prepared.plan(), &standard)
                            .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?;
                        if !runners.is_empty() {
                            host.work_plans.checker_consents.insert(
                                request.plan_id,
                                CheckerConsent {
                                    lease: receipt.effective_version.lease,
                                    bindings: runners
                                        .into_iter()
                                        .map(|(_, checker)| checker)
                                        .collect(),
                                    expires_at_ms: prepared.preview().expires_at_ms,
                                    settings_revision: revision,
                                    plugins: plugins.clone(),
                                },
                            );
                        }
                        host.work_plans
                            .agent_scopes
                            .retain(|_, scope| scope.lease().plan_id != request.plan_id);
                        let slot = host
                            .work_plans
                            .recovery
                            .as_mut()
                            .expect("checked preparation");
                        slot.authorized_action = Some(receipt.action_id);
                        Ok(receipt)
                    })
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}
