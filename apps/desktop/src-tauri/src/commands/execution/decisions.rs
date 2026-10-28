//! A single authenticated inbox read. Business actions remain with their owners.
use super::*;
use tsumugi_core::{DecisionCursor, DecisionPage, DecisionQuery};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionPageRequest {
    pub session_token: String,
    pub project_id: ExecutionId,
    pub query: DecisionQuery,
    pub cursor: Option<DecisionCursor>,
    pub limit: u32,
}

#[tauri::command]
pub async fn read_decision_page(
    state: State<'_, AppState>, request: DecisionPageRequest,
) -> Result<DecisionPage, CommandError> {
    state.sessions.run("read_decision_page", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        active.store.decision_page(request.project_id, &request.query, request.cursor.as_ref(), request.limit,
            |attempt| active.execution.as_ref().is_some_and(|host| host.runtime.is_active(attempt)))
            .map_err(|error| map_execution(error, CommandStage::ExecutionRead))
    }).await
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
