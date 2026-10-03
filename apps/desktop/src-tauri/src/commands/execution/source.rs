use super::*;
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::content::{
    self, ContentPage, ContentScope, SourceBundle, SourceChangePage, SourceConfirmation,
};
pub(super) mod capture;
#[cfg(test)]
mod tests;
pub mod translation;

#[derive(Default)]
pub(super) struct SourceSession {
    selection: Option<(ExecutionId, Arc<capture::Selection>)>,
    picker: Option<ExecutionId>,
    pub(super) resource_picker: Option<ExecutionId>,
    job: Option<ExecutionId>,
    cancel: Cancellation,
    last_start: Option<(ExecutionId, ExecutionId, String)>,
    translation_last_start: Option<(
        ExecutionId,
        ExecutionId,
        String,
        String,
        String,
        ExecutionId,
    )>,
}
impl SourceSession {
    pub fn is_active(&self) -> bool {
        self.job.is_some()
    }
    pub fn stop(&mut self) {
        self.cancel.request();
        self.job = None;
        self.picker = None;
        self.resource_picker = None;
        self.selection = None;
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceSelection {
    pub selection_id: ExecutionId,
    pub folder_name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct Preflight {
    pub namespace: String,
    pub count: u32,
    pub source_language: String,
    pub diagnostics: Vec<String>,
    pub files: Vec<content::FileCoverage>,
}
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] CaptureRequest {
    selection_id: ExecutionId,
    source_language: String
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] StartRequest {
    selection_id: ExecutionId,
    source_language: String,
    attempt_id: ExecutionId
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] PreviewRequest {
    attempt_id: ExecutionId,
    result_id: ExecutionId,
    after: u32,
    limit: u32
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] ContentRequest {
    snapshot_id: ExecutionId,
    after: u32,
    limit: u32
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] ComparisonRequest {
    attempt_id: ExecutionId,
    result_id: ExecutionId,
    base: Option<ExecutionId>,
    filter: String,
    after: u32,
    limit: u32
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] HistoryRequest {
    offset: u32,
    limit: u32
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] HistoryContentRequest {
    snapshot_id: ExecutionId,
    query: String,
    after: u32,
    limit: u32
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] LineageRequest {
    snapshot_id: ExecutionId,
    ordinal: u32
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] ImpactRequest {
    snapshot_id: ExecutionId,
    locale: String,
    after: u32,
    limit: u32
});
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] SourceAdoptRequest {
    attempt_id: ExecutionId,
    result_id: ExecutionId,
    action_id: ExecutionId,
    confirmation: SourceConfirmation
});
fn map_source(error: ExecutionError) -> CommandError {
    let mapped = map_execution(error, CommandStage::ExecutionRead);
    mapped
}
fn stale() -> CommandError {
    map_source(ExecutionError::new(
        ErrorCode::Unauthorized,
        "unauthorized-selection",
    ))
}

#[tauri::command]
pub async fn select_source<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<Option<SourceSelection>, CommandError> {
    select_source_kind(app, state, request, false).await
}
#[tauri::command]
pub async fn select_webvtt_source<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<Option<SourceSelection>, CommandError> {
    select_source_kind(app, state, request, true).await
}
async fn select_source_kind<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: SessionRequest,
    webvtt: bool,
) -> Result<Option<SourceSelection>, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let picker = ExecutionId::new();
    let initial = request.clone();
    lease
        .run(
            "select_source.begin",
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
                host.source.stop();
                host.source.picker = Some(picker);
                Ok(())
            },
        )
        .await?;
    let selection = async {
        let selected = state
            .dialogs
            .run(CommandStage::ExecutionRead, move || {
                Ok(app.dialog().file().blocking_pick_folder())
            })
            .await?;
        state
            .io
            .run(CommandStage::ExecutionRead, move || {
                selected
                    .map(|path| {
                        let path = path.into_path().map_err(|_| stale())?;
                        (if webvtt {
                            capture::Selection::authorize_webvtt(path)
                        } else {
                            capture::Selection::authorize(path)
                        })
                        .map(Arc::new)
                        .map_err(map_source)
                    })
                    .transpose()
            })
            .await
    }
    .await;
    lease
        .run(
            "select_source.finish",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, _) = active.execution_parts()?;
                host.allow_mutation()?;
                if host.source.picker != Some(picker) {
                    return Err(stale());
                }
                host.source.picker = None;
                Ok(selection?.map(|selection| {
                    let id = ExecutionId::new();
                    let folder_name = selection.label();
                    host.source.selection = Some((id, selection));
                    SourceSelection {
                        selection_id: id,
                        folder_name,
                    }
                }))
            },
        )
        .await
}

struct CaptureJob {
    id: ExecutionId,
    selection: Arc<capture::Selection>,
    cancel: Cancellation,
}
fn begin(
    sessions: &mut SessionManager,
    token: &str,
    project: ExecutionId,
    selection_id: ExecutionId,
    language: &str,
) -> Result<CaptureJob, CommandError> {
    let active = authorized(sessions, token, project, CommandStage::ExecutionRead)?;
    let metadata = active
        .store
        .metadata()
        .map_err(|e| map_persistence_error(e, CommandStage::ExecutionRead))?;
    if language != metadata.source_locale().as_str() {
        return Err(map_source(ExecutionError::new(
            ErrorCode::DependencyConflict,
            "language-conflict",
        )));
    }
    let (host, _) = active.execution_parts()?;
    host.allow_mutation()?;
    if host.source.is_active() {
        return Err(map_source(ExecutionError::new(
            ErrorCode::Busy,
            "input-busy",
        )));
    }
    let selection = host
        .source
        .selection
        .as_ref()
        .filter(|(id, _)| *id == selection_id)
        .map(|(_, s)| s.clone())
        .ok_or_else(stale)?;
    let id = ExecutionId::new();
    host.source.cancel = Cancellation::default();
    host.source.job = Some(id);
    Ok(CaptureJob {
        id,
        selection,
        cancel: host.source.cancel.clone(),
    })
}
fn finish<'a>(
    sessions: &'a mut SessionManager,
    token: &str,
    project: ExecutionId,
    job: ExecutionId,
) -> Result<&'a mut ActiveSession, CommandError> {
    let active = authorized(sessions, token, project, CommandStage::ExecutionRead)?;
    let (host, _) = active.execution_parts()?;
    if host.source.job != Some(job) {
        return Err(stale());
    }
    host.source.job = None;
    host.allow_mutation()?;
    Ok(active)
}
#[tauri::command]
pub async fn preflight_source(
    state: State<'_, AppState>,
    request: CaptureRequest,
) -> Result<Preflight, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let job = lease
        .run(
            "preflight_source.begin",
            CommandStage::ExecutionRead,
            move |sessions| {
                begin(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    initial.selection_id,
                    &initial.source_language,
                )
            },
        )
        .await?;
    let id = job.id;
    let language = request.source_language;
    let result = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            let bundle = job
                .selection
                .capture(&language, &job.cancel)
                .map_err(map_source)?;
            content::extract(&bundle, &job.cancel).map_err(map_source)
        })
        .await;
    lease
        .run(
            "preflight_source.finish",
            CommandStage::ExecutionRead,
            move |sessions| {
                finish(sessions, &request.session_token, request.project_id, id)?;
                let output = result?;
                Ok(Preflight {
                    namespace: output.namespace,
                    count: output.occurrences.len() as u32,
                    source_language: output.source_language,
                    diagnostics: output.diagnostics,
                    files: output.coverage,
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn start_source_import(
    state: State<'_, AppState>,
    request: StartRequest,
) -> Result<ExecutionId, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let job = lease
        .run(
            "start_source_import.begin",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let identity = (
                    initial.attempt_id,
                    initial.selection_id,
                    initial.source_language.clone(),
                );
                match store.execution_input(initial.attempt_id) {
                    Ok(input) => {
                        if host.source.last_start.as_ref() != Some(&identity)
                            || input.envelope().operation != content::OPERATION
                        {
                            return Err(stale());
                        }
                        return Ok(None);
                    }
                    Err(error) if error.code == ErrorCode::InvalidInput => {}
                    Err(error) => return Err(map_source(error)),
                }
                let job = begin(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    initial.selection_id,
                    &initial.source_language,
                )?;
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                active.execution_parts()?.0.source.last_start = Some(identity);
                Ok(Some(job))
            },
        )
        .await?;
    let Some(job) = job else {
        return Ok(request.attempt_id);
    };
    let id = job.id;
    let language = request.source_language;
    let result = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            job.selection
                .capture(&language, &job.cancel)
                .map_err(map_source)
        })
        .await;
    lease
        .run(
            "start_source_import.finish",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = finish(sessions, &request.session_token, request.project_id, id)?;
                let bundle: SourceBundle = result?;
                let metadata = active
                    .store
                    .metadata()
                    .map_err(|e| map_persistence_error(e, CommandStage::ExecutionRecover))?;
                let input = bundle
                    .fixed_input(metadata.project_id())
                    .map_err(map_source)?;
                let mut envelope = input.envelope().clone();
                envelope.attempt_id = request.attempt_id;
                let input = FixedInput::capture(envelope).map_err(map_source)?;
                let (host, store) = active.execution_parts()?;
                host.runtime.submit(store, &input).map_err(map_source)?;
                Ok(request.attempt_id)
            },
        )
        .await
}
#[tauri::command]
pub async fn cancel_source_capture(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<(), CommandError> {
    state
        .sessions
        .run(
            "cancel_source_capture",
            CommandStage::ExecutionCancel,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                active.execution_parts()?.0.source.stop();
                Ok(())
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_integration(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<content::IntegrationDescriptor, CommandError> {
    state
        .sessions
        .run(
            "read_source_integration",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                if let Some(snapshot) = active
                    .store
                    .content_scope()
                    .map_err(map_source)?
                    .current_snapshot
                {
                    if active
                        .store
                        .source_bundle(snapshot)
                        .map_err(map_source)?
                        .plugin_id
                        == content::webvtt::PLUGIN
                    {
                        return Ok(content::webvtt_descriptor(cfg!(windows)));
                    }
                }
                Ok(content::integration_descriptor(cfg!(windows)))
            },
        )
        .await
}
#[tauri::command]
pub async fn read_webvtt_integration(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<content::IntegrationDescriptor, CommandError> {
    state
        .sessions
        .run(
            "read_webvtt_integration",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                Ok(content::webvtt_descriptor(cfg!(windows)))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_content_scope(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<ContentScope, CommandError> {
    state
        .sessions
        .run(
            "read_content_scope",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .content_scope()
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_preview(
    state: State<'_, AppState>,
    request: PreviewRequest,
) -> Result<ContentPage, CommandError> {
    state
        .sessions
        .run(
            "read_source_preview",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_preview(
                    request.attempt_id,
                    request.result_id,
                    request.after,
                    request.limit,
                )
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_content(
    state: State<'_, AppState>,
    request: ContentRequest,
) -> Result<ContentPage, CommandError> {
    state
        .sessions
        .run(
            "read_source_content",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_content(request.snapshot_id, request.after, request.limit)
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_comparison(
    state: State<'_, AppState>,
    request: ComparisonRequest,
) -> Result<SourceChangePage, CommandError> {
    state
        .sessions
        .run(
            "read_source_comparison",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_comparison_filtered(
                    request.attempt_id,
                    request.result_id,
                    request.base,
                    &request.filter,
                    request.after,
                    request.limit,
                )
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_history(
    state: State<'_, AppState>,
    request: HistoryRequest,
) -> Result<content::SourceHistory, CommandError> {
    state
        .sessions
        .run(
            "read_source_history",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_history(request.offset, request.limit)
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_history_content(
    state: State<'_, AppState>,
    request: HistoryContentRequest,
) -> Result<ContentPage, CommandError> {
    state
        .sessions
        .run(
            "read_source_history_content",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_history_content(
                    request.snapshot_id,
                    &request.query,
                    request.after,
                    request.limit,
                )
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_lineage(
    state: State<'_, AppState>,
    request: LineageRequest,
) -> Result<Vec<content::LineageEvidence>, CommandError> {
    state
        .sessions
        .run(
            "read_source_lineage",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_lineage_evidence(request.snapshot_id, request.ordinal)
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn estimate_source_update(
    state: State<'_, AppState>,
    request: SourceAdoptRequest,
) -> Result<Vec<content::SourceImpactSummary>, CommandError> {
    state
        .sessions
        .run(
            "estimate_source_update",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                #[cfg(feature = "execution-test-host")]
                test_support::source_fixture_hook(&mut active.store, "estimate")
                    .map_err(map_source)?;
                active
                    .store
                    .source_update_estimate(
                        request.attempt_id,
                        request.result_id,
                        &request.confirmation,
                    )
                    .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_impact(
    state: State<'_, AppState>,
    request: ImpactRequest,
) -> Result<content::SourceImpactPage, CommandError> {
    state
        .sessions
        .run(
            "read_source_impact",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_impact(
                    request.snapshot_id,
                    &request.locale,
                    request.after,
                    request.limit,
                )
                .map_err(map_source)
            },
        )
        .await
}
#[tauri::command]
pub async fn prepare_source_adoption(
    state: State<'_, AppState>,
    request: SourceAdoptRequest,
) -> Result<AdoptionAction, CommandError> {
    state
        .sessions
        .run(
            "prepare_source_adoption",
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
                #[cfg(feature = "execution-test-host")]
                test_support::source_fixture_hook(store, "prepare").map_err(map_source)?;
                let input = store
                    .execution_input(request.attempt_id)
                    .map_err(map_source)?;
                if input.envelope().operation != content::OPERATION {
                    return Err(stale());
                }
                let parameters =
                    serde_json::to_value(&request.confirmation).map_err(|_| stale())?;
                store
                    .prepare_adoption_with_id(
                        request.action_id,
                        request.attempt_id,
                        input.envelope().units[0].unit_id,
                        vec![request.result_id],
                        parameters,
                    )
                    .map_err(map_source)
            },
        )
        .await
}
