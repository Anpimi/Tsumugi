//! Bounded coordination is projected from its original project execution owner.
use super::*;
use tsumugi_core::application::{ReadTeamExecution, TeamExecutionView};

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamExecutionRequest {
        plan_id: ExecutionId,
        after_work: Option<Revision>,
        after_message: Option<Revision>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16)))]
        limit: u32
    }
);

#[tauri::command]
pub async fn read_work_plan_team_execution(
    state: State<'_, AppState>,
    request: WorkPlanTeamExecutionRequest,
) -> Result<TeamExecutionView, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_execution",
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
                    .read_team_execution(&ReadTeamExecution {
                        project_id: request.project_id,
                        plan_id: request.plan_id,
                        after_work: request.after_work,
                        after_message: request.after_message,
                        limit: request.limit,
                    })
                    .map_err(map_read)
            },
        )
        .await
}
