//! Desktop boundary for project-local resource decisions.

use super::*;
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::{
    CaptureContext, CaptureCorrectionTerm, ContextCapture, ContextRevision, CorrectionTermEvidence,
    CorrectionTermReceipt, GlossaryCapture, ImpactPage, ResourceDecision, ResourceDecisionResult,
    ResourcePreview, SaveContext, SaveTerm, TbxExchangePreview, TermResolution, TermRevision,
    TmSuggestion, TmxExchangePreview,
};

#[cfg(test)]
#[path = "resource_exchange_tests.rs"]
mod exchange_tests;

#[cfg(test)]
#[path = "resource_correction_tests.rs"]
mod correction_tests;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TmxPreviewRequest { locale: String }
);

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TmxFilePreview {
    pub project_id: ExecutionId,
    pub file_name: String,
    pub preview: TmxExchangePreview,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TbxPreviewRequest { locale: String }
);

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TbxFilePreview {
    pub project_id: ExecutionId,
    pub file_name: String,
    pub preview: TbxExchangePreview,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CaptureListRequest { limit: u32 }
);

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CaptureRequest {
        capture_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TermRequest { term: SaveTerm }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    DecisionRequest {
        decision: ResourceDecision
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CorrectionBasisRequest {
        unit_id: ExecutionId,
        locale: String,
        after_selection_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CorrectionCaptureRequest {
        capture: CaptureCorrectionTerm
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ResourceActionRequest {
        action_id: ExecutionId
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] TermListRequest {
    locale: String,
    after_term_id: Option<String>,
    limit: u32
});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TermHistoryRequest {
        term_id: String,
        offset: u32,
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    UnitLocaleRequest {
        unit_id: ExecutionId,
        locale: String
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextWriteRequest {
        context: SaveContext
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextCaptureRequest {
        capture: CaptureContext
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SuggestionRequest {
        unit_id: ExecutionId,
        locale: String,
        offset: u32,
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ImpactRequest {
        locale: String,
        offset: u32,
        limit: u32
    }
);

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextFactRequest {
        decision: tsumugi_core::ContextFactWrite
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextFactsRequest {
        scope: tsumugi_core::SourceContextRequest,
        facts: Vec<tsumugi_core::ContextFactPosition>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextFactActionRequest {
        action_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ContextFactHistoryRequest {
        unit_id: ExecutionId,
        locale: String,
        offset: u32,
        limit: u32
    }
);

#[tauri::command]
pub async fn decide_context_fact(
    state: State<'_, AppState>,
    request: ContextFactRequest,
) -> Result<tsumugi_core::ContextFactDecision, CommandError> {
    state
        .sessions
        .run(
            "decide_context_fact",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                if request.project_id != request.decision.basis.scope.project_id {
                    return Err(resource_error(
                        ExecutionError::new(ErrorCode::Unauthorized, "context-fact-project"),
                        CommandStage::ExecutionAdopt,
                    ));
                }
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .decide_context_fact(&request.decision)
                    .map_err(|e| resource_error(e, CommandStage::ExecutionAdopt))
            },
        )
        .await
}
#[tauri::command]
pub async fn read_context_fact_decisions(
    state: State<'_, AppState>,
    request: ContextFactsRequest,
) -> Result<Vec<tsumugi_core::ContextFactDecision>, CommandError> {
    state
        .sessions
        .run(
            "read_context_fact_decisions",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                if request.project_id != request.scope.project_id {
                    return Err(resource_error(
                        ExecutionError::new(ErrorCode::Unauthorized, "context-fact-project"),
                        CommandStage::ExecutionRead,
                    ));
                }
                active
                    .store
                    .context_fact_decisions(&request.scope, &request.facts)
                    .map_err(|e| resource_error(e, CommandStage::ExecutionRead))
            },
        )
        .await
}
#[tauri::command]
pub async fn read_context_fact_action(
    state: State<'_, AppState>,
    request: ContextFactActionRequest,
) -> Result<Option<tsumugi_core::ContextFactDecision>, CommandError> {
    state
        .sessions
        .run(
            "read_context_fact_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .context_fact_action(request.project_id, request.action_id)
                .map_err(|e| resource_error(e, CommandStage::ExecutionRead))
            },
        )
        .await
}
#[tauri::command]
pub async fn read_context_fact_history(
    state: State<'_, AppState>,
    request: ContextFactHistoryRequest,
) -> Result<tsumugi_core::ContextFactHistory, CommandError> {
    state
        .sessions
        .run(
            "read_context_fact_history",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .context_fact_history(
                    request.project_id,
                    request.unit_id,
                    &request.locale,
                    request.offset,
                    request.limit,
                )
                .map_err(|e| resource_error(e, CommandStage::ExecutionRead))
            },
        )
        .await
}

fn resource_error(error: ExecutionError, stage: CommandStage) -> CommandError {
    let mapped = map_execution(error, stage);
    mapped
}

fn exchange_scope(
    sessions: &mut SessionManager,
    session_token: &str,
    project_id: ExecutionId,
    locale: &str,
    scope_reason: &'static str,
) -> Result<(String, String), CommandError> {
    let active = authorized(
        sessions,
        session_token,
        project_id,
        CommandStage::ExecutionRead,
    )?;
    let metadata = active
        .store
        .metadata()
        .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRead))?;
    if !metadata
        .target_locales()
        .iter()
        .any(|target| target.as_str() == locale)
    {
        return Err(resource_error(
            ExecutionError::new(ErrorCode::DependencyConflict, scope_reason),
            CommandStage::ExecutionRead,
        ));
    }
    Ok((
        metadata.source_locale().as_str().to_owned(),
        locale.to_owned(),
    ))
}

fn tmx_scope(
    sessions: &mut SessionManager,
    request: &TmxPreviewRequest,
) -> Result<(String, String), CommandError> {
    exchange_scope(
        sessions,
        &request.session_token,
        request.project_id,
        &request.locale,
        "tmx-project-scope",
    )
}
fn tbx_scope(
    sessions: &mut SessionManager,
    request: &TbxPreviewRequest,
) -> Result<(String, String), CommandError> {
    exchange_scope(
        sessions,
        &request.session_token,
        request.project_id,
        &request.locale,
        "tbx-project-scope",
    )
}

fn read_exchange_preview<T>(
    path: &std::path::Path,
    scope: &(String, String),
    read: fn(&std::path::Path) -> Result<Vec<u8>, ExecutionError>,
    preview: fn(&[u8], &str, &str) -> Result<T, ExecutionError>,
) -> Result<(String, T), CommandError> {
    let bytes = read(path).map_err(|error| resource_error(error, CommandStage::ExecutionRead))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            CommandError::simple(
                CommandErrorCode::PermissionDenied,
                CommandStage::ExecutionRead,
            )
        })?;
    let report = preview(&bytes, &scope.0, &scope.1)
        .map_err(|error| resource_error(error, CommandStage::ExecutionRead))?;
    Ok((name.to_owned(), report))
}
fn read_tmx_preview(
    path: &std::path::Path,
    scope: &(String, String),
) -> Result<(String, TmxExchangePreview), CommandError> {
    read_exchange_preview(
        path,
        scope,
        source::capture::read_tmx_file,
        tsumugi_core::preview_tmx_exchange,
    )
}
fn read_tbx_preview(
    path: &std::path::Path,
    scope: &(String, String),
) -> Result<(String, TbxExchangePreview), CommandError> {
    read_exchange_preview(
        path,
        scope,
        source::capture::read_tbx_file,
        tsumugi_core::preview_tbx_exchange,
    )
}

fn finish_exchange_preview<T: serde::Serialize>(
    current_scope: (String, String),
    initial_scope: (String, String),
    result: Result<Option<T>, CommandError>,
    max_bytes: usize,
    scope_reason: &'static str,
    report_reason: &'static str,
) -> Result<Option<T>, CommandError> {
    if current_scope != initial_scope {
        return Err(resource_error(
            ExecutionError::new(ErrorCode::DependencyConflict, scope_reason),
            CommandStage::ExecutionRead,
        ));
    }
    result?
        .map(|view| {
            // The final wire bound includes the original selected filename and project envelope.
            let encoded = serde_json::to_vec(&view).map_err(|_| {
                CommandError::simple(CommandErrorCode::OutputInvalid, CommandStage::ExecutionRead)
            })?;
            if encoded.len() > max_bytes {
                return Err(resource_error(
                    ExecutionError::new(ErrorCode::LimitExceeded, report_reason),
                    CommandStage::ExecutionRead,
                ));
            }
            Ok(view)
        })
        .transpose()
}
fn finish_tmx_preview(
    sessions: &mut SessionManager,
    request: TmxPreviewRequest,
    initial_scope: (String, String),
    result: Result<Option<(String, TmxExchangePreview)>, CommandError>,
) -> Result<Option<TmxFilePreview>, CommandError> {
    let current_scope = tmx_scope(sessions, &request)?;
    let result = result.map(|value| {
        value.map(|(file_name, preview)| TmxFilePreview {
            project_id: request.project_id,
            file_name,
            preview,
        })
    });
    finish_exchange_preview(
        current_scope,
        initial_scope,
        result,
        tsumugi_core::MAX_TMX_REPORT_BYTES,
        "tmx-project-scope",
        "tmx-report-budget",
    )
}
fn finish_tbx_preview(
    sessions: &mut SessionManager,
    request: TbxPreviewRequest,
    initial_scope: (String, String),
    result: Result<Option<(String, TbxExchangePreview)>, CommandError>,
) -> Result<Option<TbxFilePreview>, CommandError> {
    let current_scope = tbx_scope(sessions, &request)?;
    let result = result.map(|value| {
        value.map(|(file_name, preview)| TbxFilePreview {
            project_id: request.project_id,
            file_name,
            preview,
        })
    });
    finish_exchange_preview(
        current_scope,
        initial_scope,
        result,
        tsumugi_core::MAX_TBX_REPORT_BYTES,
        "tbx-project-scope",
        "tbx-report-budget",
    )
}

async fn pick_exchange_file<R: tauri::Runtime, T: Send + 'static>(
    app: tauri::AppHandle<R>,
    state: &AppState,
    filter: &'static str,
    extension: &'static str,
    scope: (String, String),
    read: fn(&std::path::Path, &(String, String)) -> Result<(String, T), CommandError>,
) -> Result<Option<(String, T)>, CommandError> {
    let selected = state
        .dialogs
        .run(CommandStage::ExecutionRead, move || {
            Ok(app
                .dialog()
                .file()
                .add_filter(filter, &[extension])
                .blocking_pick_file())
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
            read(&path, &scope).map(Some)
        })
        .await
}

/// A file-selection read only. No capture, adoption, execution host or grant is created.
#[tauri::command]
pub async fn preview_tmx_exchange<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: TmxPreviewRequest,
) -> Result<Option<TmxFilePreview>, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let scope = lease
        .run(
            "preview_tmx_exchange.begin",
            CommandStage::ExecutionRead,
            move |sessions| tmx_scope(sessions, &initial),
        )
        .await?;
    let result =
        pick_exchange_file(app, &state, "TMX", "tmx", scope.clone(), read_tmx_preview).await;
    lease
        .run(
            "preview_tmx_exchange.finish",
            CommandStage::ExecutionRead,
            move |sessions| finish_tmx_preview(sessions, request, scope, result),
        )
        .await
}

/// Read a selected terminology exchange without modifying project resource facts.
#[tauri::command]
pub async fn preview_tbx_exchange<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: TbxPreviewRequest,
) -> Result<Option<TbxFilePreview>, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let scope = lease
        .run(
            "preview_tbx_exchange.begin",
            CommandStage::ExecutionRead,
            move |sessions| tbx_scope(sessions, &initial),
        )
        .await?;
    let result =
        pick_exchange_file(app, &state, "TBX", "tbx", scope.clone(), read_tbx_preview).await;
    lease
        .run(
            "preview_tbx_exchange.finish",
            CommandStage::ExecutionRead,
            move |sessions| finish_tbx_preview(sessions, request, scope, result),
        )
        .await
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
pub async fn read_correction_term_basis(
    state: State<'_, AppState>,
    request: CorrectionBasisRequest,
) -> Result<CorrectionTermEvidence, CommandError> {
    state
        .sessions
        .run(
            "read_correction_term_basis",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .correction_term_basis(
                    request.project_id,
                    request.unit_id,
                    &request.locale,
                    request.after_selection_id,
                )
                .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn capture_correction_term(
    state: State<'_, AppState>,
    request: CorrectionCaptureRequest,
) -> Result<CorrectionTermReceipt, CommandError> {
    state
        .sessions
        .run(
            "capture_correction_term",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                if request.capture.basis.project_id != request.project_id {
                    return Err(resource_error(
                        ExecutionError::new(ErrorCode::Unauthorized, "correction-term-project"),
                        CommandStage::ExecutionAdopt,
                    ));
                }
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .capture_correction_term(&request.capture)
                    .map_err(|error| resource_error(error, CommandStage::ExecutionAdopt))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_correction_term_action(
    state: State<'_, AppState>,
    request: ResourceActionRequest,
) -> Result<Option<CorrectionTermReceipt>, CommandError> {
    state
        .sessions
        .run(
            "read_correction_term_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .correction_term_capture_action(request.project_id, request.action_id)
                .map_err(|error| resource_error(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_resource_decision_action(
    state: State<'_, AppState>,
    request: ResourceActionRequest,
) -> Result<Option<ResourceDecisionResult>, CommandError> {
    state
        .sessions
        .run(
            "read_resource_decision_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .resource_decision_action(request.project_id, request.action_id)
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
                if request.decision.project_id != request.project_id {
                    return Err(resource_error(
                        ExecutionError::new(ErrorCode::Unauthorized, "resource-decision-project"),
                        CommandStage::ExecutionAdopt,
                    ));
                }
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

#[cfg(test)]
mod contracts {
    use super::*;

    #[test]
    fn resource_wire_fixture_matches_actual_rust_requests_and_responses() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/resourceCommands.contract.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($group:literal, $key:literal, $kind:ty) => {
                let value: $kind = serde_json::from_value(fixture[$group][$key].clone()).unwrap();
                assert_eq!(
                    serde_json::to_value(value).unwrap(),
                    fixture[$group][$key],
                    $key
                );
            };
        }
        round_trip!("requests", "session", SessionRequest);
        round_trip!("requests", "tmxPreview", TmxPreviewRequest);
        round_trip!("requests", "tbxPreview", TbxPreviewRequest);
        round_trip!("requests", "captures", CaptureListRequest);
        round_trip!("requests", "capture", CaptureRequest);
        round_trip!("requests", "term", TermRequest);
        round_trip!("requests", "decision", DecisionRequest);
        round_trip!("requests", "correctionBasis", CorrectionBasisRequest);
        round_trip!("requests", "correctionCapture", CorrectionCaptureRequest);
        round_trip!("requests", "resourceAction", ResourceActionRequest);
        round_trip!("requests", "terms", TermListRequest);
        round_trip!("requests", "termHistory", TermHistoryRequest);
        round_trip!("requests", "unitLocale", UnitLocaleRequest);
        round_trip!("requests", "context", ContextWriteRequest);
        round_trip!("requests", "contextCapture", ContextCaptureRequest);
        round_trip!("requests", "suggestions", SuggestionRequest);
        round_trip!("requests", "impacts", ImpactRequest);
        round_trip!("responses", "captures", Vec<GlossaryCapture>);
        round_trip!("responses", "tmxPreview", Option<TmxFilePreview>);
        round_trip!("responses", "tbxPreview", Option<TbxFilePreview>);
        round_trip!("responses", "capture", Option<GlossaryCapture>);
        round_trip!("responses", "preview", ResourcePreview);
        round_trip!("responses", "decision", ResourceDecisionResult);
        round_trip!("responses", "correctionBasis", CorrectionTermEvidence);
        round_trip!("responses", "correctionCapture", CorrectionTermReceipt);
        round_trip!(
            "responses",
            "correctionAction",
            Option<CorrectionTermReceipt>
        );
        round_trip!(
            "responses",
            "decisionAction",
            Option<ResourceDecisionResult>
        );
        round_trip!("responses", "term", TermRevision);
        round_trip!("responses", "terms", Vec<TermRevision>);
        round_trip!("responses", "resolution", TermResolution);
        round_trip!("responses", "context", Option<ContextRevision>);
        round_trip!("responses", "savedContext", ContextRevision);
        round_trip!("responses", "contextCapture", ContextCapture);
        round_trip!("responses", "suggestions", Vec<TmSuggestion>);
        round_trip!("responses", "impacts", ImpactPage);
        assert!(
            serde_json::from_value::<Option<TmxFilePreview>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        let mut unknown = fixture["requests"]["tmxPreview"].clone();
        unknown["path"] = serde_json::json!("/not-an-authorized-selection.tmx");
        assert!(serde_json::from_value::<TmxPreviewRequest>(unknown).is_err());
        let mut unknown = fixture["responses"]["tmxPreview"].clone();
        unknown["preview"]["license"] = serde_json::json!("approved");
        assert!(serde_json::from_value::<Option<TmxFilePreview>>(unknown).is_err());
        assert!(
            serde_json::from_value::<Option<TbxFilePreview>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        let mut unknown = fixture["requests"]["tbxPreview"].clone();
        unknown["schemaHref"] = serde_json::json!("untrusted-schema.xsd");
        assert!(serde_json::from_value::<TbxPreviewRequest>(unknown).is_err());
        let mut unknown = fixture["responses"]["tbxPreview"].clone();
        unknown["preview"]["rows"][0]["status"] = serde_json::json!("adopted");
        assert!(serde_json::from_value::<Option<TbxFilePreview>>(unknown).is_err());
        assert!(
            serde_json::from_value::<Option<GlossaryCapture>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        assert!(
            serde_json::from_value::<Option<ContextRevision>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        let mut request = fixture["requests"]["term"].clone();
        request["term"]
            .as_object_mut()
            .unwrap()
            .remove("expectedRevisionId");
        request["term"].as_object_mut().unwrap().remove("termId");
        let decoded: TermRequest = serde_json::from_value(request).unwrap();
        assert_eq!(decoded.term.expected_revision_id, None);
        assert_eq!(decoded.term.term_id, None);
        let mut unknown = fixture["requests"]["decision"].clone();
        unknown["decision"]["decision"] = serde_json::json!("apply-all");
        assert!(serde_json::from_value::<DecisionRequest>(unknown).is_err());
        let mut missing = fixture["responses"]["decision"].clone();
        missing.as_object_mut().unwrap().remove("request");
        assert!(serde_json::from_value::<ResourceDecisionResult>(missing).is_err());
        let mut missing = fixture["responses"]["preview"].clone();
        missing.as_object_mut().unwrap().remove("correction");
        assert!(serde_json::from_value::<ResourcePreview>(missing).is_err());
        let mut unknown = fixture["responses"]["term"].clone();
        unknown["originKind"] = serde_json::json!("import");
        assert!(serde_json::from_value::<TermRevision>(unknown).is_err());
        let mut unknown = fixture["responses"]["impacts"].clone();
        unknown["items"][0]["status"] = serde_json::json!("invalidated");
        assert!(serde_json::from_value::<ImpactPage>(unknown).is_err());
        let mut unknown = fixture["responses"]["suggestions"].clone();
        unknown[0]["matchKind"] = serde_json::json!("best");
        assert!(serde_json::from_value::<Vec<TmSuggestion>>(unknown).is_err());
        let mut overflow = fixture["requests"]["captures"].clone();
        overflow["limit"] = serde_json::json!(4294967296u64);
        assert!(serde_json::from_value::<CaptureListRequest>(overflow).is_err());
        let mut overflow = fixture["responses"]["suggestions"].clone();
        overflow[0]["scorePercent"] = serde_json::json!(256);
        assert!(serde_json::from_value::<Vec<TmSuggestion>>(overflow).is_err());
        let mut unknown = fixture["responses"]["contextCapture"].clone();
        unknown["included"][0]["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<ContextCapture>(unknown).is_err());
    }
}
