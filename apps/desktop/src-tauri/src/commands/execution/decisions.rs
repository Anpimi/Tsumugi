//! A single authenticated inbox read. Business actions remain with their owners.
use super::*;
use tsumugi_core::{DecisionClientActivity, DecisionCursor, DecisionPage, DecisionQuery};
mod local;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionPageRequest {
    pub session_token: String,
    pub project_id: ExecutionId,
    pub query: DecisionQuery,
    pub cursor: Option<DecisionCursor>,
    pub limit: u32,
    /// None means no current Session lifecycle observation is available.
    pub activity: Option<Vec<DecisionClientActivity>>,
}

#[tauri::command]
pub async fn read_decision_page(
    state: State<'_, AppState>, request: DecisionPageRequest,
) -> Result<DecisionPage, CommandError> {
    let drafts = state.local_drafts.get().cloned();
    state.sessions.run("read_decision_page", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        local::validate_activity(request.activity.as_deref()).map_err(|error| map_execution(error, CommandStage::ExecutionRead))?;
        let local_selected = request.query.sources.is_empty() || request.query.sources.contains(&tsumugi_core::DecisionSource::LocalActionRecovery);
        let snapshot = if local_selected { Some(drafts.ok_or_else(|| ExecutionError::new(ErrorCode::StorageFailed, "decision-local-store"))
            .and_then(|drafts| drafts.pending_snapshot(request.project_id, request.query.locale.as_deref()))) } else { None };
        let delivery_activity = active.execution.as_ref().and_then(|host| host.release.delivery_activity()).into_iter().collect::<Vec<_>>();
        active.store.decision_page_with_host_observations(request.project_id, &request.query, request.cursor.as_ref(), request.limit,
            |attempt| active.execution.as_ref().is_some_and(|host| host.runtime.is_active(attempt)), &delivery_activity,
            |store| snapshot.expect("selected local source").and_then(|snapshot| local::project(store, request.project_id, snapshot, request.activity)).map(Some))
            .map_err(|error| map_execution(error, CommandStage::ExecutionRead))
    }).await
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
