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
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let picker = ExecutionId::new();
    let initial = request.clone();
    lease
        .run(
            "choose_resource_file.begin",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, _) = active.execution_parts()?;
                host.allow_mutation()?;
                host.source.resource_picker = Some(picker);
                Ok(())
            },
        )
        .await?;
    let read_result = async {
        let selected = state
            .dialogs
            .run(CommandStage::ExecutionRead, move || {
                Ok(app.dialog().file().blocking_pick_file())
            })
            .await?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        state
            .io
            .run(CommandStage::ExecutionRead, move || {
                let path = selected.into_path().map_err(|_| {
                    CommandError::simple(
                        CommandErrorCode::PermissionDenied,
                        CommandStage::ExecutionRead,
                    )
                })?;
                source::capture::read_resource_file(&path)
                    .map(Some)
                    .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            })
            .await
    }
    .await;
    lease
        .run(
            "choose_resource_file.finish",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
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
            },
        )
        .await
}

#[tauri::command]
pub async fn list_resource_captures(
    state: State<'_, AppState>,
    request: CaptureListRequest,
) -> Result<Vec<GlossaryCapture>, CommandError> {
    state
        .sessions
        .run(
            "list_resource_captures",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .list_glossary_captures(request.project_id, request.limit)
                .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_resource_preview(
    state: State<'_, AppState>,
    request: CaptureRequest,
) -> Result<ResourcePreview, CommandError> {
    state
        .sessions
        .run(
            "read_resource_preview",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .glossary_preview(request.project_id, request.capture_id)
                .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn decide_resource_entry(
    state: State<'_, AppState>,
    request: DecisionRequest,
) -> Result<ResourceDecisionResult, CommandError> {
    state
        .sessions
        .run(
            "decide_resource_entry",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .decide_glossary_entry(&request.decision)
                    .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
            },
        )
        .await
}

#[tauri::command]
pub async fn save_term(
    state: State<'_, AppState>,
    request: TermRequest,
) -> Result<TermRevision, CommandError> {
    state
        .sessions
        .run("save_term", CommandStage::ExecutionAdopt, move |sessions| {
            let active = authorized(
                sessions,
                &request.session_token,
                request.project_id,
                CommandStage::ExecutionAdopt,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            store
                .save_term(&request.term)
                .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
        })
        .await
}

#[tauri::command]
pub async fn read_terms(
    state: State<'_, AppState>,
    request: TermListRequest,
) -> Result<Vec<TermRevision>, CommandError> {
    state
        .sessions
        .run("read_terms", CommandStage::ExecutionRead, move |sessions| {
            authorized(
                sessions,
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
        })
        .await
}

#[tauri::command]
pub async fn read_term_history(
    state: State<'_, AppState>,
    request: TermHistoryRequest,
) -> Result<Vec<TermRevision>, CommandError> {
    state
        .sessions
        .run(
            "read_term_history",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
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
            },
        )
        .await
}

#[tauri::command]
pub async fn resolve_terms(
    state: State<'_, AppState>,
    request: UnitLocaleRequest,
) -> Result<TermResolution, CommandError> {
    state
        .sessions
        .run(
            "resolve_terms",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .resolve_terms(request.project_id, request.unit_id, &request.locale)
                .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_context_revision(
    state: State<'_, AppState>,
    request: UnitLocaleRequest,
) -> Result<Option<ContextRevision>, CommandError> {
    state
        .sessions
        .run(
            "read_context_revision",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .context_revision(request.project_id, request.unit_id, &request.locale)
                .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn save_context(
    state: State<'_, AppState>,
    request: ContextWriteRequest,
) -> Result<ContextRevision, CommandError> {
    state
        .sessions
        .run(
            "save_context",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .save_context(&request.context)
                    .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
            },
        )
        .await
}

#[tauri::command]
pub async fn capture_context(
    state: State<'_, AppState>,
    request: ContextCaptureRequest,
) -> Result<ContextCapture, CommandError> {
    state
        .sessions
        .run(
            "capture_context",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .capture_context(&request.capture)
                    .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_context_capture(
    state: State<'_, AppState>,
    request: CaptureRequest,
) -> Result<ContextCapture, CommandError> {
    state
        .sessions
        .run(
            "read_context_capture",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .read_context_capture(request.project_id, request.capture_id)
                .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn tm_suggestions(
    state: State<'_, AppState>,
    request: SuggestionRequest,
) -> Result<Vec<TmSuggestion>, CommandError> {
    state
        .sessions
        .run(
            "tm_suggestions",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
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
            },
        )
        .await
}

#[tauri::command]
pub async fn resource_impacts(
    state: State<'_, AppState>,
    request: ImpactRequest,
) -> Result<ImpactPage, CommandError> {
    state
        .sessions
        .run(
            "resource_impacts",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
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
            },
        )
        .await
}
