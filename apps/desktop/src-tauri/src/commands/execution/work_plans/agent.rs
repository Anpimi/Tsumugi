//! A bounded Agent consumer of the original work-plan generation service.
//! The trusted host opens a scope; Agent calls carry no authorizer or controls.
use super::*;
use tsumugi_core::{
    ProviderBudget,
    application::{
        AgentDelegationRequest, AgentGenerationRequest, WorkPlanAgentExecutionIdentity,
        WorkPlanAgentReconciliation, WorkPlanAgentSubset,
    },
};

const MAX_AGENT_SCOPES: usize = 128;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentOpenRequest {
        lease: AutomationLease
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentDelegateRequest {
        scope_id: ExecutionId,
        delegation: AgentDelegationRequest
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentReconcileRequest {
        lease: AutomationLease,
        task_id: ExecutionId,
        attempt_id: ExecutionId,
        #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
        input_digest: String
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentGenerationAttemptRequest {
        scope_id: ExecutionId,
        generation: AgentGenerationRequest,
        #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
        input_digest: String,
        #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
        offset: u32,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 100)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentGenerationOutputRequest {
        scope_id: ExecutionId,
        generation: AgentGenerationRequest,
        #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
        input_digest: String,
        item_id: ExecutionId,
        result_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentPrepareRequest {
        scope_id: ExecutionId,
        generation: AgentGenerationRequest
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentStartRequest {
        scope_id: ExecutionId,
        generation: AgentGenerationRequest,
        #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
        input_digest: String
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentView {
    pub scope_id: ExecutionId,
    pub lease: AutomationLease,
    pub parent_task: ExecutionId,
    pub scope: Vec<PlanSelectionBasis>,
    pub budget: ProviderBudget,
    #[serde(deserialize_with = "tsumugi_core::application::required_agent_subset")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "tsumugi_core::application::agent_subset_schema")
    )]
    pub delegation: Option<WorkPlanAgentSubset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentGenerationView {
    pub scope_id: ExecutionId,
    pub parent_task: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub input_digest: String,
    pub scope: Vec<PlanSelectionBasis>,
    pub budget: ProviderBudget,
}

pub(super) fn scope(
    host: &ExecutionHost,
    store: &ProjectStore,
    id: ExecutionId,
) -> Result<WorkPlanAgentScope, CommandError> {
    let scope = host
        .work_plans
        .agent_scopes
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            map_recover(ExecutionError::new(
                ErrorCode::Unauthorized,
                "work-plan-agent-session",
            ))
        })?;
    store
        .check_work_plan_agent_scope(&scope)
        .map_err(map_recover)?;
    Ok(scope)
}

fn budget(
    store: &ProjectStore,
    scope: &WorkPlanAgentScope,
) -> Result<ProviderBudget, CommandError> {
    store
        .provider_budget(scope.parent_task())
        .map_err(map_recover)?
        .ok_or_else(|| {
            map_recover(ExecutionError::new(
                ErrorCode::CorruptLedger,
                "work-plan-budget-owner",
            ))
        })
}

/// Trusted host entry point. This is absent from the bounded Agent adapter.
/// Opening a session observes an existing grant; it does not renew authority.
#[tauri::command]
pub async fn open_work_plan_agent_scope(
    state: State<'_, AppState>,
    request: WorkPlanAgentOpenRequest,
) -> Result<WorkPlanAgentView, CommandError> {
    state
        .sessions
        .run(
            "open_work_plan_agent_scope",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = active.execution.as_mut().ok_or_else(|| {
                    map_read(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "work-plan-agent-session",
                    ))
                })?;
                let store = &active.store;
                host.allow_mutation()?;
                let opened = store
                    .work_plan_agent_scope(request.lease)
                    .map_err(map_recover)?;
                let mut stale = Vec::new();
                for (id, scope) in &host.work_plans.agent_scopes {
                    match store.check_work_plan_agent_scope(scope) {
                        Ok(()) => {}
                        Err(error)
                            if matches!(
                                error.code,
                                ErrorCode::Cancelled | ErrorCode::Unauthorized
                            ) =>
                        {
                            stale.push(*id)
                        }
                        Err(error) => return Err(map_recover(error)),
                    }
                }
                for id in stale {
                    host.work_plans.agent_scopes.remove(&id);
                }
                let id = if let Some((id, _)) =
                    host.work_plans.agent_scopes.iter().find(|(_, scope)| {
                        scope.lease() == opened.lease() && scope.delegation().is_none()
                    }) {
                    *id
                } else {
                    if host.work_plans.agent_scopes.len() >= MAX_AGENT_SCOPES {
                        return Err(map_recover(ExecutionError::new(
                            ErrorCode::LimitExceeded,
                            "work-plan-agent-session",
                        )));
                    }
                    let id = opened.caller_id();
                    host.work_plans.agent_scopes.insert(id, opened.clone());
                    id
                };
                let plan = store
                    .work_plan(request.lease.plan_id)
                    .map_err(map_recover)?;
                Ok(WorkPlanAgentView {
                    scope_id: id,
                    lease: opened.lease(),
                    parent_task: opened.parent_task(),
                    scope: plan.selection_basis,
                    budget: budget(store, &opened)?,
                    delegation: None,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn delegate_work_plan_agent_scope(
    state: State<'_, AppState>,
    request: WorkPlanAgentDelegateRequest,
) -> Result<WorkPlanAgentView, CommandError> {
    state
        .sessions
        .run(
            "delegate_work_plan_agent_scope",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = active.execution.as_mut().ok_or_else(|| {
                    map_read(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "work-plan-agent-session",
                    ))
                })?;
                host.allow_mutation()?;
                let store = &active.store;
                let parent = scope(host, store, request.scope_id)?;
                let opened = store
                    .delegate_work_plan_agent_scope(&parent, &request.delegation)
                    .map_err(map_read)?;
                let mut stale = Vec::new();
                for (id, scope) in &host.work_plans.agent_scopes {
                    match store.check_work_plan_agent_scope(scope) {
                        Ok(()) => {}
                        Err(error)
                            if matches!(
                                error.code,
                                ErrorCode::Cancelled | ErrorCode::Unauthorized
                            ) =>
                        {
                            stale.push(*id)
                        }
                        Err(error) => return Err(map_read(error)),
                    }
                }
                for id in stale {
                    host.work_plans.agent_scopes.remove(&id);
                }
                let existing = host.work_plans.agent_scopes.iter().find(|(_, scope)| {
                    scope.delegation().is_some_and(|subset| {
                        subset.parent_scope_id == parent.caller_id()
                            && subset.delegation_id == request.delegation.delegation_id
                    })
                });
                let child = if let Some((_, scope)) = existing {
                    if scope.delegation() != opened.delegation() || scope.lease() != opened.lease()
                    {
                        return Err(map_read(ExecutionError::new(
                            ErrorCode::ResultMismatch,
                            "work-plan-agent-delegation",
                        )));
                    }
                    scope.clone()
                } else {
                    if host.work_plans.agent_scopes.len() >= MAX_AGENT_SCOPES {
                        return Err(map_read(ExecutionError::new(
                            ErrorCode::LimitExceeded,
                            "work-plan-agent-session",
                        )));
                    }
                    host.work_plans
                        .agent_scopes
                        .insert(opened.caller_id(), opened.clone());
                    opened
                };
                let plan = store.work_plan(child.lease().plan_id).map_err(map_read)?;
                let subset = child.delegation().ok_or_else(|| {
                    map_read(ExecutionError::new(
                        ErrorCode::CorruptLedger,
                        "work-plan-agent-subset",
                    ))
                })?;
                Ok(WorkPlanAgentView {
                    scope_id: child.caller_id(),
                    lease: child.lease(),
                    parent_task: child.parent_task(),
                    scope: plan
                        .selection_basis
                        .into_iter()
                        .filter(|basis| subset.unit_ids.contains(&basis.unit_id))
                        .collect(),
                    budget: budget(store, &child)?,
                    delegation: child.delegation().cloned(),
                })
            },
        )
        .await
}

/// This human recovery read never restores a bounded consumer or its output.
#[tauri::command]
pub async fn reconcile_work_plan_agent_execution(
    state: State<'_, AppState>,
    request: WorkPlanAgentReconcileRequest,
) -> Result<WorkPlanAgentReconciliation, CommandError> {
    state
        .sessions
        .run(
            "reconcile_work_plan_agent_execution",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .reconcile_work_plan_agent_execution(&WorkPlanAgentExecutionIdentity {
                        lease: request.lease,
                        task_id: request.task_id,
                        attempt_id: request.attempt_id,
                        input_digest: request.input_digest,
                    })
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_agent_generation_attempt(
    state: State<'_, AppState>,
    request: WorkPlanAgentGenerationAttemptRequest,
) -> Result<AttemptDetail, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_agent_generation_attempt",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = broker::read_host(active)?;
                let scope = scope(host, &active.store, request.scope_id)?;
                active
                    .store
                    .read_work_plan_agent_generation_attempt(
                        &scope,
                        &request.generation,
                        &request.input_digest,
                        host.runtime.is_active(request.generation.attempt_id),
                        request.offset,
                        request.limit,
                    )
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_agent_generation_output(
    state: State<'_, AppState>,
    request: WorkPlanAgentGenerationOutputRequest,
) -> Result<ExecutionOutputView, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_agent_generation_output",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = broker::read_host(active)?;
                let scope = scope(host, &active.store, request.scope_id)?;
                let result = active
                    .store
                    .read_work_plan_agent_generation_output(
                        &scope,
                        &request.generation,
                        &request.input_digest,
                        request.item_id,
                        request.result_id,
                    )
                    .map_err(map_read)?;
                Ok(ExecutionOutputView {
                    result: result.envelope().clone(),
                    source_failure: None,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn prepare_work_plan_agent_generation(
    state: State<'_, AppState>,
    request: WorkPlanAgentPrepareRequest,
) -> Result<WorkPlanAgentGenerationView, CommandError> {
    state
        .sessions
        .run(
            "prepare_work_plan_agent_generation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let scope = scope(host, store, request.scope_id)?;
                let input = store
                    .prepare_work_plan_agent_generation(&scope, &request.generation)
                    .map_err(map_recover)?;
                let plan = store
                    .work_plan(scope.lease().plan_id)
                    .map_err(map_recover)?;
                Ok(WorkPlanAgentGenerationView {
                    scope_id: request.scope_id,
                    parent_task: scope.parent_task(),
                    task_id: input.envelope().task_id,
                    attempt_id: input.envelope().attempt_id,
                    input_digest: input.digest().into(),
                    scope: plan
                        .selection_basis
                        .into_iter()
                        .filter(|unit| request.generation.unit_ids.contains(&unit.unit_id))
                        .collect(),
                    budget: budget(store, &scope)?,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn start_work_plan_agent_generation(
    state: State<'_, AppState>,
    request: WorkPlanAgentStartRequest,
) -> Result<ExecutionId, CommandError> {
    let plugins = state.plugins.clone();
    state
        .sessions
        .run(
            "start_work_plan_agent_generation",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let scope = scope(host, store, request.scope_id)?;
                let input = store
                    .prepare_work_plan_agent_generation(&scope, &request.generation)
                    .map_err(map_recover)?;
                if input.digest() != request.input_digest {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "work-plan-agent-preflight",
                    )));
                }
                let plan = store
                    .work_plan(scope.lease().plan_id)
                    .map_err(map_recover)?;
                let checker = current_checker_consent(host, store, &plan, scope.lease())?;
                let checker_revision = checker.as_ref().map(|consent| consent.settings_revision);
                with_plan_environment_revision(&plugins, &plan, checker_revision, || {
                    host.runtime
                        .submit_work_plan_agent_generation(store, &input)
                        .map_err(map_recover)?;
                    host.ai.track(store, &input, checker).map_err(map_recover)?;
                    Ok(input.envelope().attempt_id)
                })
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_agent_fixture_round_trips_and_excludes_authority_overrides() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/workPlanAgent.contract.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($group:literal, $key:literal, $ty:ty) => {{
                let value = fixture[$group][$key].clone();
                let decoded: $ty = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), value);
            }};
        }
        round_trip!("requests", "open", WorkPlanAgentOpenRequest);
        round_trip!("requests", "delegate", WorkPlanAgentDelegateRequest);
        round_trip!("requests", "reconcile", WorkPlanAgentReconcileRequest);
        round_trip!(
            "requests",
            "generationAttempt",
            WorkPlanAgentGenerationAttemptRequest
        );
        round_trip!(
            "requests",
            "generationOutput",
            WorkPlanAgentGenerationOutputRequest
        );
        round_trip!("requests", "prepare", WorkPlanAgentPrepareRequest);
        round_trip!("requests", "start", WorkPlanAgentStartRequest);
        round_trip!("responses", "scope", WorkPlanAgentView);
        round_trip!("responses", "child", WorkPlanAgentView);
        round_trip!("responses", "reconciliation", WorkPlanAgentReconciliation);
        round_trip!("responses", "generationAttempt", AttemptDetail);
        // Output is the existing serialize-only projection; compare its stored frame.
        let result: ResultEnvelope =
            serde_json::from_value(fixture["responses"]["generationOutput"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(ExecutionOutputView {
                result,
                source_failure: None
            })
            .unwrap(),
            fixture["responses"]["generationOutput"]
        );
        round_trip!("responses", "generation", WorkPlanAgentGenerationView);
        let mut missing = fixture["responses"]["scope"].clone();
        missing.as_object_mut().unwrap().remove("delegation");
        assert!(serde_json::from_value::<WorkPlanAgentView>(missing).is_err());
        for field in [
            "confirmed",
            "effects",
            "config",
            "payload",
            "lease",
            "parentTask",
        ] {
            let mut forged = fixture["requests"]["prepare"].clone();
            forged["generation"][field] = serde_json::json!(true);
            assert!(serde_json::from_value::<WorkPlanAgentPrepareRequest>(forged).is_err());
            let mut forged = fixture["requests"]["start"].clone();
            forged[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<WorkPlanAgentStartRequest>(forged).is_err());
        }
    }
}
