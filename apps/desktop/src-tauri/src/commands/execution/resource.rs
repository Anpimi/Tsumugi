//! Desktop boundary for project-local resource decisions.

use super::*;
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::{
    CaptureContext, ContextCapture, ContextRevision, GlossaryCapture, ImpactPage, ResourceDecision,
    ResourceDecisionResult, ResourcePreview, SaveContext, SaveTerm, TermResolution, TermRevision,
    TmSuggestion,
};

request!(CaptureListRequest { limit: u32 });

request!(CaptureRequest {
    capture_id: ExecutionId
});
request!(TermRequest { term: SaveTerm });
request!(DecisionRequest {
    decision: ResourceDecision
});
request!(TermListRequest {
    locale: String,
    after_term_id: Option<String>,
    limit: u32
});
request!(TermHistoryRequest {
    term_id: String,
    offset: u32,
    limit: u32
});
request!(UnitLocaleRequest {
    unit_id: ExecutionId,
    locale: String
});
request!(ContextWriteRequest {
    context: SaveContext
});
request!(ContextCaptureRequest {
    capture: CaptureContext
});
request!(SuggestionRequest {
    unit_id: ExecutionId,
    locale: String,
    offset: u32,
    limit: u32
});
request!(ImpactRequest {
    locale: String,
    offset: u32,
    limit: u32
});

fn resource_error(error: ExecutionError, stage: CommandStage) -> CommandError {
    let field = error.stage.clone();
    let mut mapped = map_execution(error, stage);
    mapped.field = Some(field);
    mapped
}

#[tauri::command]
pub async fn choose_resource_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<Option<GlossaryCapture>, CommandError> {
    let picker = ExecutionId::new();
    {
        let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
        let active = authorized(
            &mut sessions,
            &request.session_token,
            request.project_id,
            CommandStage::ExecutionRead,
        )?;
        let (host, _) = active.execution_parts()?;
        host.allow_mutation()?;
        host.source.resource_picker = Some(picker);
    }
    let read_result: Result<Option<Vec<u8>>, CommandError> =
        async {
            let selected = tauri::async_runtime::spawn_blocking(move || {
                app.dialog().file().blocking_pick_file()
            })
            .await
            .map_err(|_| {
                CommandError::simple(CommandErrorCode::StorageFailed, CommandStage::ExecutionRead)
            })?;
            let Some(selected) = selected else {
                return Ok(None);
            };
            let path = selected.into_path().map_err(|_| {
                CommandError::simple(
                    CommandErrorCode::PermissionDenied,
                    CommandStage::ExecutionRead,
                )
            })?;
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                source::capture::read_resource_file(&path)
            })
            .await
            .map_err(|_| {
                CommandError::simple(CommandErrorCode::StorageFailed, CommandStage::ExecutionRead)
            })?
            .map_err(|error| resource_error(error, CommandStage::ExecutionRead))?;
            Ok(Some(bytes))
        }
        .await;
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    if host.source.resource_picker != Some(picker) {
        return Err(CommandError::simple(
            CommandErrorCode::SessionInvalid,
            CommandStage::ExecutionAdopt,
        ));
    }
    host.source.resource_picker = None;
    read_result?
        .map(|bytes| {
            store
                .capture_glossary(request.project_id, picker, &bytes)
                .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
        })
        .transpose()
}

#[tauri::command]
pub fn list_resource_captures(
    state: State<'_, AppState>,
    request: CaptureListRequest,
) -> Result<Vec<GlossaryCapture>, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .list_glossary_captures(request.project_id, request.limit)
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn read_resource_preview(
    state: State<'_, AppState>,
    request: CaptureRequest,
) -> Result<ResourcePreview, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .glossary_preview(request.project_id, request.capture_id)
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn decide_resource_entry(
    state: State<'_, AppState>,
    request: DecisionRequest,
) -> Result<ResourceDecisionResult, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    store
        .decide_glossary_entry(&request.decision)
        .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
}

#[tauri::command]
pub fn save_term(
    state: State<'_, AppState>,
    request: TermRequest,
) -> Result<TermRevision, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    store
        .save_term(&request.term)
        .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
}

#[tauri::command]
pub fn read_terms(
    state: State<'_, AppState>,
    request: TermListRequest,
) -> Result<Vec<TermRevision>, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .list_terms(
        request.project_id,
        &request.locale,
        request.after_term_id.as_deref(),
        request.limit,
    )
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn read_term_history(
    state: State<'_, AppState>,
    request: TermHistoryRequest,
) -> Result<Vec<TermRevision>, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .term_history(
        request.project_id,
        &request.term_id,
        request.offset,
        request.limit,
    )
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn resolve_terms(
    state: State<'_, AppState>,
    request: UnitLocaleRequest,
) -> Result<TermResolution, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .resolve_terms(request.project_id, request.unit_id, &request.locale)
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn read_context_revision(
    state: State<'_, AppState>,
    request: UnitLocaleRequest,
) -> Result<Option<ContextRevision>, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .context_revision(request.project_id, request.unit_id, &request.locale)
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn save_context(
    state: State<'_, AppState>,
    request: ContextWriteRequest,
) -> Result<ContextRevision, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    store
        .save_context(&request.context)
        .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
}

#[tauri::command]
pub fn capture_context(
    state: State<'_, AppState>,
    request: ContextCaptureRequest,
) -> Result<ContextCapture, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    store
        .capture_context(&request.capture)
        .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
}

#[tauri::command]
pub fn read_context_capture(
    state: State<'_, AppState>,
    request: CaptureRequest,
) -> Result<ContextCapture, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .read_context_capture(request.project_id, request.capture_id)
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn tm_suggestions(
    state: State<'_, AppState>,
    request: SuggestionRequest,
) -> Result<Vec<TmSuggestion>, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .tm_suggestions(
        request.project_id,
        request.unit_id,
        &request.locale,
        request.offset,
        request.limit,
    )
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn resource_impacts(
    state: State<'_, AppState>,
    request: ImpactRequest,
) -> Result<ImpactPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .resource_impacts(
        request.project_id,
        &request.locale,
        request.offset,
        request.limit,
    )
    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
}
