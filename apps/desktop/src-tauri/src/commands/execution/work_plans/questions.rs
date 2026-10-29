//! Human replies are local project facts, not execution authorization.
use super::*;
use tsumugi_core::application::{ReadTeamQuestions, RespondTeamQuestion, TeamDiscussionPost,
    TeamQuestionResponseSettlement, TeamQuestionView, TeamQuestionsPage};

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamQuestionsRequest {
        plan_id: ExecutionId,
        after: Option<Revision>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamQuestionRequest {
        plan_id: ExecutionId,
        question_post_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamQuestionRespondRequest {
        plan_id: ExecutionId,
        response: RespondTeamQuestion
    }
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamQuestionResponseOriginal {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub response: RespondTeamQuestion,
}

#[tauri::command]
pub async fn read_work_plan_team_questions(state: State<'_, AppState>, request: WorkPlanTeamQuestionsRequest)
    -> Result<TeamQuestionsPage, CommandError> {
    state.sessions.run("read_work_plan_team_questions", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        active.store.read_team_questions(&ReadTeamQuestions { project_id: request.project_id, plan_id: request.plan_id,
            after: request.after, limit: request.limit }).map_err(map_read)
    }).await
}

#[tauri::command]
pub async fn read_work_plan_team_question(state: State<'_, AppState>, request: WorkPlanTeamQuestionRequest)
    -> Result<TeamQuestionView, CommandError> {
    state.sessions.run("read_work_plan_team_question", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        active.store.read_team_question(request.project_id, request.plan_id, request.question_post_id).map_err(map_read)
    }).await
}

#[tauri::command]
pub async fn respond_work_plan_team_question(state: State<'_, AppState>, request: WorkPlanTeamQuestionRespondRequest)
    -> Result<TeamDiscussionPost, CommandError> {
    state.sessions.run("respond_work_plan_team_question", CommandStage::ExecutionAdopt, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionAdopt)?;
        active.store.respond_team_question(request.project_id, request.plan_id, super::team::LOCAL_ACTOR, &request.response).map_err(map_recover)
    }).await
}

#[tauri::command]
pub async fn read_work_plan_team_question_response_settlement(state: State<'_, AppState>, request: WorkPlanTeamQuestionRespondRequest)
    -> Result<TeamQuestionResponseSettlement, CommandError> {
    state.sessions.run("read_work_plan_team_question_response_settlement", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        active.store.team_question_response_settlement(request.project_id, request.plan_id, super::team::LOCAL_ACTOR, &request.response).map_err(map_read)
    }).await
}
