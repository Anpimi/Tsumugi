//! Human corrections share the content owner and do not initialize execution.
use super::*;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SourceLineageCorrectionBasisRequest { snapshot_id: ExecutionId, ordinal: u32 }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SourceLineageCorrectionRequest { correction: content::CorrectSourceLineage }
);

fn association(request: &SourceLineageCorrectionRequest) -> Result<(), CommandError> {
    if request.project_id != request.correction.project_id {
        return Err(map_source(ExecutionError::new(ErrorCode::Unauthorized, "source-lineage-project")));
    }
    Ok(())
}

#[tauri::command]
pub async fn read_source_lineage_correction_basis(
    state: State<'_, AppState>, request: SourceLineageCorrectionBasisRequest,
) -> Result<content::SourceLineageCorrectionBasis, CommandError> {
    state.sessions.run("read_source_lineage_correction_basis", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?.store
            .source_lineage_correction_basis(request.project_id, request.snapshot_id, request.ordinal).map_err(map_source)
    }).await
}

#[tauri::command]
pub async fn read_source_lineage_correction_action(
    state: State<'_, AppState>, request: SourceLineageCorrectionRequest,
) -> Result<content::SourceLineageCorrectionObservation, CommandError> {
    association(&request)?;
    state.sessions.run("read_source_lineage_correction_action", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?.store
            .source_lineage_correction_request_observation(&request.correction).map_err(map_source)
    }).await
}

#[tauri::command]
pub async fn validate_source_lineage_correction(
    state: State<'_, AppState>, request: SourceLineageCorrectionRequest,
) -> Result<(), CommandError> {
    association(&request)?;
    state.sessions.run("validate_source_lineage_correction", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?.store
            .validate_source_lineage_correction(&request.correction).map_err(map_source)
    }).await
}

#[tauri::command]
pub async fn correct_source_lineage(
    state: State<'_, AppState>, request: SourceLineageCorrectionRequest,
) -> Result<content::SourceLineageCorrectionReceipt, CommandError> {
    association(&request)?;
    state.sessions.run("correct_source_lineage", CommandStage::ExecutionAdopt, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionAdopt)?;
        if let Some(host) = active.execution.as_mut() { host.allow_mutation()?; }
        active.store.correct_source_lineage(&request.correction).map_err(map_source)
    }).await
}
