//! A bounded Agent consumer of the original work-plan generation service.
//! The trusted host opens a scope; Agent calls carry no authorizer or controls.
use super::*;
use tsumugi_core::{ProviderBudget, application::AgentGenerationRequest};

const MAX_AGENT_SCOPES: usize = 128;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentOpenRequest {
        lease: AutomationLease
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

fn scope(
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
                let (host, store) = active.execution_parts()?;
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
                let id = if let Some((id, _)) = host
                    .work_plans
                    .agent_scopes
                    .iter()
                    .find(|(_, scope)| scope.lease() == opened.lease())
                {
                    *id
                } else {
                    if host.work_plans.agent_scopes.len() >= MAX_AGENT_SCOPES {
                        return Err(map_recover(ExecutionError::new(
                            ErrorCode::LimitExceeded,
                            "work-plan-agent-session",
                        )));
                    }
                    let id = ExecutionId::new();
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
                host.runtime
                    .submit_child(store, &input, scope.parent_task())
                    .map_err(map_recover)?;
                host.ai.track(store, &input, checker).map_err(map_recover)?;
                Ok(input.envelope().attempt_id)
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
        round_trip!("requests", "prepare", WorkPlanAgentPrepareRequest);
        round_trip!("requests", "start", WorkPlanAgentStartRequest);
        round_trip!("responses", "scope", WorkPlanAgentView);
        round_trip!("responses", "generation", WorkPlanAgentGenerationView);
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
