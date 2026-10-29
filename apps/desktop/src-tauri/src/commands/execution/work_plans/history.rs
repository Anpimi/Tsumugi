//! Original Core actions are observations, never restored execution consent.
use super::*;
use tsumugi_core::application::{WorkPlanHistoryBaseline, WorkPlanHistoryPage};

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanHistoryRequest {
        plan_id: ExecutionId,
        after: Revision,
        baseline: Option<WorkPlanHistoryBaseline>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16)))]
        limit: u32
    }
);

#[tauri::command]
pub async fn read_work_plan_history(
    state: State<'_, AppState>, request: WorkPlanHistoryRequest,
) -> Result<WorkPlanHistoryPage, CommandError> {
    state.sessions.run("read_work_plan_history", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?
            .store.read_work_plan_history(request.project_id, request.plan_id, request.after,
                request.baseline.as_ref(), request.limit).map_err(map_read)
    }).await
}
