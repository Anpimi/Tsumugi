//! Bounded, explicitly requested package guidance. Text is untrusted content;
//! this reader neither prepares an execution nor grants any additional effect.
use super::*;
use tsumugi_core::application::{CapturedWorkPlanToolGuidance, WorkPlanToolSpec};

const MAX_TEXT_BYTES: usize = 65_536;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentGuidanceRequest {
        scope_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentSkillRequest {
        scope_id: ExecutionId,
        tool_handle: ExecutionId,
        #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 128)))]
        skill_id: String
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAgentResourceRequest {
        scope_id: ExecutionId,
        tool_handle: ExecutionId,
        #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 128)))]
        resource_id: String
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentGuidanceView {
    pub scope_id: ExecutionId,
    pub parent_task: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 32)))]
    pub tools: Vec<WorkPlanToolSpec>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanGuidanceContent {
    Skill {
        contribution_id: String,
        #[cfg_attr(feature = "wire-schema", schemars(length(max = 65_536)))]
        text: String,
    },
    Resource {
        contribution_id: String,
        schema: sdk::ContractRef,
        #[cfg_attr(feature = "wire-schema", schemars(length(max = 65_536)))]
        text: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentGuidanceTextView {
    pub scope_id: ExecutionId,
    pub parent_task: ExecutionId,
    pub tool: WorkPlanToolSpec,
    pub content: WorkPlanGuidanceContent,
}

fn member() -> CommandError {
    map_read(ExecutionError::new(
        ErrorCode::Unauthorized,
        "work-plan-guidance-member",
    ))
}
fn content_error() -> CommandError {
    map_read(ExecutionError::new(
        ErrorCode::DependencyConflict,
        "work-plan-guidance-content",
    ))
}
fn text(bytes: &[u8]) -> Result<String, CommandError> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(map_read(ExecutionError::new(
            ErrorCode::LimitExceeded,
            "work-plan-guidance-text-limit",
        )));
    }
    std::str::from_utf8(bytes).map(str::to_owned).map_err(|_| {
        map_read(ExecutionError::new(
            ErrorCode::InvalidInput,
            "work-plan-guidance-utf8",
        ))
    })
}

/// Keep the original project/session admission across package IO, then recheck
/// its exact scope witness before releasing any content to the caller.
pub(super) async fn read<T: Send + 'static>(
    state: State<'_, AppState>,
    request: WorkPlanAgentGuidanceRequest,
    read: impl FnOnce(&ApplicationPlugins, &CapturedWorkPlanToolGuidance) -> Result<T, CommandError>
    + Send
    + 'static,
) -> Result<(ExecutionId, T), CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let captured = lease
        .run(
            "read_work_plan_agent_guidance.capture",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = broker::read_host(active)?;
                let scope = agent::scope(host, &active.store, initial.scope_id)?;
                let captured = active
                    .store
                    .capture_work_plan_agent_guidance(&scope)
                    .map_err(map_read)?;
                Ok(captured)
            },
        )
        .await?;
    let reading = captured.clone();
    let plugins = state.plugins.clone();
    let value = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            read(&plugins, &reading)
        })
        .await?;
    let plugins = state.plugins.clone();
    lease
        .run(
            "read_work_plan_agent_guidance.finish",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let host = broker::read_host(active)?;
                let scope = agent::scope(host, &active.store, request.scope_id)?;
                active
                    .store
                    .check_work_plan_agent_guidance(&scope, &captured)
                    .map_err(map_read)?;
                let revision = plugins.environment_settings_revision()?;
                if captured
                    .tools()
                    .iter()
                    .any(|tool| tool.settings_revision != revision)
                {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "work-plan-guidance-settings",
                    )));
                }
                Ok((scope.parent_task(), value))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_agent_guidance(
    state: State<'_, AppState>,
    request: WorkPlanAgentGuidanceRequest,
) -> Result<WorkPlanAgentGuidanceView, CommandError> {
    let scope_id = request.scope_id;
    let (parent_task, tools) = read(state, request, |plugins, captured| {
        for tool in captured.tools() {
            // Rebind declarations and membership, but do not project a Skill or
            // supporting-resource body into this directory response.
            plugins.read_tool_guidance(tool, |_| Ok(()))?;
        }
        Ok(captured.tools().to_vec())
    })
    .await?;
    Ok(WorkPlanAgentGuidanceView {
        scope_id,
        parent_task,
        tools,
    })
}

#[tauri::command]
pub async fn read_work_plan_agent_skill(
    state: State<'_, AppState>,
    request: WorkPlanAgentSkillRequest,
) -> Result<WorkPlanAgentGuidanceTextView, CommandError> {
    let common = WorkPlanAgentGuidanceRequest {
        session_token: request.session_token,
        project_id: request.project_id,
        scope_id: request.scope_id,
    };
    let scope_id = common.scope_id;
    let (parent_task, (tool, content)) = read(state, common, move |plugins, captured| {
        let tool = captured.tool(request.tool_handle).map_err(map_read)?;
        if tool.binding.declaration.skill.as_deref() != Some(request.skill_id.as_str()) {
            return Err(member());
        }
        let content = plugins.read_tool_guidance(tool, |image| {
            let bytes = image
                .skill_bytes(&request.skill_id)
                .map_err(|_| content_error())?;
            Ok(WorkPlanGuidanceContent::Skill {
                contribution_id: request.skill_id,
                text: text(bytes)?,
            })
        })?;
        Ok((tool.clone(), content))
    })
    .await?;
    Ok(WorkPlanAgentGuidanceTextView {
        scope_id,
        parent_task,
        tool,
        content,
    })
}

#[tauri::command]
pub async fn read_work_plan_agent_resource(
    state: State<'_, AppState>,
    request: WorkPlanAgentResourceRequest,
) -> Result<WorkPlanAgentGuidanceTextView, CommandError> {
    let common = WorkPlanAgentGuidanceRequest {
        session_token: request.session_token,
        project_id: request.project_id,
        scope_id: request.scope_id,
    };
    let scope_id = common.scope_id;
    let (parent_task, (tool, content)) = read(state, common, move |plugins, captured| {
        let tool = captured.tool(request.tool_handle).map_err(map_read)?;
        let resource = tool
            .binding
            .resources
            .iter()
            .find(|resource| resource.contribution_id == request.resource_id)
            .ok_or_else(member)?;
        let content = plugins.read_tool_guidance(tool, |image| {
            let bytes = image
                .resource_bytes(&resource.contribution_id, &resource.schema)
                .map_err(|_| content_error())?;
            Ok(WorkPlanGuidanceContent::Resource {
                contribution_id: resource.contribution_id.clone(),
                schema: resource.schema.clone(),
                text: text(bytes)?,
            })
        })?;
        Ok((tool.clone(), content))
    })
    .await?;
    Ok(WorkPlanAgentGuidanceTextView {
        scope_id,
        parent_task,
        tool,
        content,
    })
}
