//! Trusted local history and publication reuse the original project session.
//! Reading retained reasons never reopens a member scope or model permission.
use super::*;
use tsumugi_core::application::{
    PublishTeamDiscussion, ReadTeamHistory, TeamDiscussionPost, TeamHistoryPage,
};

const LOCAL_ACTOR: &str = "local-user";

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamHistoryRequest {
        plan_id: ExecutionId,
        after: Option<Revision>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamPostRequest {
        plan_id: ExecutionId,
        post_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamPublishRequest {
        lease: AutomationLease,
        publication: PublishTeamDiscussion
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamPublicationActionRequest {
        lease: AutomationLease,
        publication: PublishTeamDiscussion
    }
);

#[tauri::command]
pub async fn read_work_plan_team_history(
    state: State<'_, AppState>,
    request: WorkPlanTeamHistoryRequest,
) -> Result<TeamHistoryPage, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_history",
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
                    .read_team_history(&ReadTeamHistory {
                        project_id: request.project_id,
                        plan_id: request.plan_id,
                        after: request.after,
                        limit: request.limit,
                    })
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_team_post(
    state: State<'_, AppState>,
    request: WorkPlanTeamPostRequest,
) -> Result<TeamDiscussionPost, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_post",
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
                    .read_team_history_post(request.project_id, request.plan_id, request.post_id)
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn publish_work_plan_team_discussion(
    state: State<'_, AppState>,
    request: WorkPlanTeamPublishRequest,
) -> Result<TeamDiscussionPost, CommandError> {
    state
        .sessions
        .run(
            "publish_work_plan_team_discussion",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let (host, store) = active.execution_parts()?;
                let (_, scope) = agent::root_scope(host, store, request.lease)?;
                store
                    .publish_human_team_discussion(&scope, LOCAL_ACTOR, &request.publication)
                    .map_err(map_recover)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_team_publication_action(
    state: State<'_, AppState>,
    request: WorkPlanTeamPublicationActionRequest,
) -> Result<Option<TeamDiscussionPost>, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_publication_action",
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
                    .read_human_team_publication_action(
                        request.project_id,
                        &request.lease,
                        LOCAL_ACTOR,
                        &request.publication,
                    )
                    .map_err(map_read)
            },
        )
        .await
}
