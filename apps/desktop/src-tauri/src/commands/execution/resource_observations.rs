//! Exact receipt observations never reconcile the project or initialize execution.
use super::*;

#[tauri::command]
pub async fn observe_term_save_action(state: State<'_, AppState>, request: TermRequest)
    -> Result<Option<tsumugi_core::TermSaveActionRead>, CommandError> {
    state.sessions.run("observe_term_save_action", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.project_id != request.term.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "resource-project"), CommandStage::ExecutionRead));
        }
        active.store.term_save_request_observation(&request.term)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn observe_context_save_action(state: State<'_, AppState>, request: ContextWriteRequest)
    -> Result<Option<tsumugi_core::ContextSaveActionRead>, CommandError> {
    state.sessions.run("observe_context_save_action", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.project_id != request.context.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "resource-project"), CommandStage::ExecutionRead));
        }
        active.store.context_save_request_observation(&request.context)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn observe_context_capture_action(state: State<'_, AppState>, request: ContextCaptureRequest)
    -> Result<Option<tsumugi_core::ContextCaptureActionRead>, CommandError> {
    state.sessions.run("observe_context_capture_action", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.project_id != request.capture.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "resource-project"), CommandStage::ExecutionRead));
        }
        active.store.context_capture_request_observation(&request.capture)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn observe_correction_term_action(state: State<'_, AppState>, request: CorrectionCaptureRequest)
    -> Result<Option<tsumugi_core::CorrectionTermReceipt>, CommandError> {
    state.sessions.run("observe_correction_term_action", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.project_id != request.capture.basis.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "resource-project"), CommandStage::ExecutionRead));
        }
        active.store.correction_term_request_observation(&request.capture)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn observe_resource_decision_action(state: State<'_, AppState>, request: DecisionRequest)
    -> Result<Option<tsumugi_core::ResourceDecisionActionRead>, CommandError> {
    state.sessions.run("observe_resource_decision_action", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.project_id != request.decision.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "resource-project"), CommandStage::ExecutionRead));
        }
        active.store.resource_decision_request_observation(&request.decision)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn observe_context_fact_action(state: State<'_, AppState>, request: ContextFactRequest)
    -> Result<Option<tsumugi_core::ContextFactDecision>, CommandError> {
    state.sessions.run("observe_context_fact_action", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.project_id != request.decision.basis.scope.project_id {
            return Err(resource_error(ExecutionError::new(ErrorCode::Unauthorized, "resource-project"), CommandStage::ExecutionRead));
        }
        active.store.context_fact_request_observation(&request.decision)
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
    }).await
}
