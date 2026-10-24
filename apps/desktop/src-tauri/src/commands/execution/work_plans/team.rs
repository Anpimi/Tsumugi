//! Trusted local history and publication reuse the original project session.
//! Reading retained reasons never reopens a member scope or model permission.
use super::*;
use tsumugi_core::application::{
    PublishTeamDiscussion, ReadTeamHistory, SendHumanTeamMessage, TeamDiscussionPost,
    TeamHistoryPage, TeamMessage,
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
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanTeamMessageRequest {
        lease: AutomationLease,
        message: SendHumanTeamMessage
    }
);

#[tauri::command]
pub async fn send_work_plan_team_message(
    state: State<'_, AppState>,
    request: WorkPlanTeamMessageRequest,
) -> Result<TeamMessage, CommandError> {
    state
        .sessions
        .run(
            "send_work_plan_team_message",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                if let Some(recorded) = active
                    .store
                    .read_human_team_message_action(
                        request.project_id,
                        &request.lease,
                        LOCAL_ACTOR,
                        &request.message,
                    )
                    .map_err(map_recover)?
                {
                    return Ok(recorded);
                }
                let status = active
                    .store
                    .work_plan_status(request.lease.plan_id)
                    .map_err(map_recover)?;
                if status.lease.plan_id == request.lease.plan_id
                    && status.lease.generation > request.lease.generation
                {
                    // A later durable generation permanently closes this
                    // original lease, even when only historical readers remain.
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::Cancelled,
                        "team-human-message-lease-closed",
                    )));
                }
                // Historical acknowledgement must not construct a Host or
                // revive its original scope. Only a new local send needs one.
                let host = active.execution.as_mut().ok_or_else(|| {
                    map_recover(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "work-plan-session",
                    ))
                })?;
                let (_, scope) = agent::root_scope(host, &active.store, request.lease)?;
                active
                    .store
                    .send_human_team_message(&scope, LOCAL_ACTOR, &request.message)
                    .map_err(map_recover)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_team_message_action(
    state: State<'_, AppState>,
    request: WorkPlanTeamMessageRequest,
) -> Result<Option<TeamMessage>, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_team_message_action",
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
                    .read_human_team_message_action(
                        request.project_id,
                        &request.lease,
                        LOCAL_ACTOR,
                        &request.message,
                    )
                    .map_err(map_read)
            },
        )
        .await
}

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
