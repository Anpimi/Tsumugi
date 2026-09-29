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
pub struct SourceSelection {
    pub selection_id: ExecutionId,
    pub folder_name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preflight {
    pub namespace: String,
    pub count: u32,
    pub source_language: String,
    pub diagnostics: Vec<String>,
    pub files: Vec<content::FileCoverage>,
}
request!(CaptureRequest {
    selection_id: ExecutionId,
    source_language: String
});
request!(StartRequest {
    selection_id: ExecutionId,
    source_language: String,
    attempt_id: ExecutionId
});
request!(PreviewRequest {
    attempt_id: ExecutionId,
    result_id: ExecutionId,
    after: u32,
    limit: u32
});
request!(ContentRequest {
    snapshot_id: ExecutionId,
    after: u32,
    limit: u32
});
request!(ComparisonRequest {
    attempt_id: ExecutionId,
    result_id: ExecutionId,
    base: Option<ExecutionId>,
    filter: String,
    after: u32,
    limit: u32
});
request!(HistoryRequest {
    offset: u32,
    limit: u32
});
request!(HistoryContentRequest {
    snapshot_id: ExecutionId,
    query: String,
    after: u32,
    limit: u32
});
request!(LineageRequest {
    snapshot_id: ExecutionId,
    ordinal: u32
});
request!(ImpactRequest {
    snapshot_id: ExecutionId,
    locale: String,
    after: u32,
    limit: u32
});
request!(SourceAdoptRequest {
    attempt_id: ExecutionId,
    result_id: ExecutionId,
    action_id: ExecutionId,
    confirmation: SourceConfirmation
});
fn map_source(error: ExecutionError) -> CommandError {
    let reason = error.stage.clone();
    let mut mapped = map_execution(error, CommandStage::ExecutionRead);
    mapped.field = Some(reason);
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
        host.source.stop();
        host.source.picker = Some(picker);
    }
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|_| {
                map_source(ExecutionError::new(
                    ErrorCode::StorageFailed,
                    "selection-failed",
                ))
            })?;
    let selection = selected
        .map(|path| {
            let path = path.into_path().map_err(|_| stale())?;
            capture::Selection::authorize(path)
                .map(Arc::new)
                .map_err(map_source)
        })
        .transpose()?;
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    let active = authorized(
        &mut sessions,
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
    Ok(selection.map(|selection| {
        let id = ExecutionId::new();
        let folder_name = selection.label();
        host.source.selection = Some((id, selection));
        SourceSelection {
            selection_id: id,
            folder_name,
        }
    }))
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
    let job = {
        let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
        begin(
            &mut sessions,
            &request.session_token,
            request.project_id,
            request.selection_id,
            &request.source_language,
        )?
    };
    let id = job.id;
    let language = request.source_language;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bundle = job.selection.capture(&language, &job.cancel)?;
        content::extract(&bundle, &job.cancel)
    })
    .await
    .map_err(|_| {
        map_source(ExecutionError::new(
            ErrorCode::StorageFailed,
            "capture-failed",
        ))
    });
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    finish(
        &mut sessions,
        &request.session_token,
        request.project_id,
        id,
    )?;
    let output = result?.map_err(map_source)?;
    Ok(Preflight {
        namespace: output.namespace,
        count: output.occurrences.len() as u32,
        source_language: output.source_language,
        diagnostics: output.diagnostics,
        files: output.coverage,
    })
}
#[tauri::command]
pub async fn start_source_import(
    state: State<'_, AppState>,
    request: StartRequest,
) -> Result<ExecutionId, CommandError> {
    let job = {
        let mut sessions = lock_sessions(&state, CommandStage::ExecutionRecover)?;
        let active = authorized(
            &mut sessions,
            &request.session_token,
            request.project_id,
            CommandStage::ExecutionRecover,
        )?;
        let (host, store) = active.execution_parts()?;
        host.allow_mutation()?;
        let identity = (
            request.attempt_id,
            request.selection_id,
            request.source_language.clone(),
        );
        match store.execution_input(request.attempt_id) {
            Ok(input) => {
                if host.source.last_start.as_ref() != Some(&identity)
                    || input.envelope().operation != content::OPERATION
                {
                    return Err(stale());
                }
                return Ok(request.attempt_id);
            }
            Err(error) if error.code == ErrorCode::InvalidInput => {}
            Err(error) => return Err(map_source(error)),
        }
        let job = begin(
            &mut sessions,
            &request.session_token,
            request.project_id,
            request.selection_id,
            &request.source_language,
        )?;
        let active = authorized(
            &mut sessions,
            &request.session_token,
            request.project_id,
            CommandStage::ExecutionRecover,
        )?;
        active.execution_parts()?.0.source.last_start = Some(identity);
        job
    };
    let id = job.id;
    let language = request.source_language;
    let result =
        tauri::async_runtime::spawn_blocking(move || job.selection.capture(&language, &job.cancel))
            .await
            .map_err(|_| {
                map_source(ExecutionError::new(
                    ErrorCode::StorageFailed,
                    "capture-failed",
                ))
            });
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRecover)?;
    let active = finish(
        &mut sessions,
        &request.session_token,
        request.project_id,
        id,
    )?;
    let bundle: SourceBundle = result?.map_err(map_source)?;
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
}
#[tauri::command]
pub fn cancel_source_capture(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<(), CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionCancel)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionCancel,
    )?;
    active.execution_parts()?.0.source.stop();
    Ok(())
}
#[tauri::command]
pub fn read_source_integration(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<content::IntegrationDescriptor, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?;
    Ok(content::integration_descriptor(cfg!(windows)))
}

#[tauri::command]
pub fn read_content_scope(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<ContentScope, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .content_scope()
    .map_err(map_source)
}
#[tauri::command]
pub fn read_source_preview(
    state: State<'_, AppState>,
    request: PreviewRequest,
) -> Result<ContentPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
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
}
#[tauri::command]
pub fn read_source_content(
    state: State<'_, AppState>,
    request: ContentRequest,
) -> Result<ContentPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .source_content(request.snapshot_id, request.after, request.limit)
    .map_err(map_source)
}
#[tauri::command]
pub fn read_source_comparison(
    state: State<'_, AppState>,
    request: ComparisonRequest,
) -> Result<SourceChangePage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
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
}
#[tauri::command]
pub fn read_source_history(
    state: State<'_, AppState>,
    request: HistoryRequest,
) -> Result<content::SourceHistory, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .source_history(request.offset, request.limit)
    .map_err(map_source)
}
#[tauri::command]
pub fn read_source_history_content(
    state: State<'_, AppState>,
    request: HistoryContentRequest,
) -> Result<ContentPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
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
}
#[tauri::command]
pub fn read_source_lineage(
    state: State<'_, AppState>,
    request: LineageRequest,
) -> Result<Vec<content::LineageEvidence>, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .source_lineage_evidence(request.snapshot_id, request.ordinal)
    .map_err(map_source)
}
#[tauri::command]
pub async fn estimate_source_update(
    state: State<'_, AppState>,
    request: SourceAdoptRequest,
) -> Result<Vec<content::SourceImpactSummary>, CommandError> {
    let sessions = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = sessions.lock().map_err(|_| {
            CommandError::simple(CommandErrorCode::Busy, CommandStage::ExecutionRead)
        })?;
        let active = authorized(
            &mut sessions,
            &request.session_token,
            request.project_id,
            CommandStage::ExecutionRead,
        )?;
        #[cfg(feature = "execution-test-host")]
        test_support::source_fixture_hook(&mut active.store, "estimate").map_err(map_source)?;
        active
            .store
            .source_update_estimate(request.attempt_id, request.result_id, &request.confirmation)
            .map_err(map_source)
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}
#[tauri::command]
pub fn read_source_impact(
    state: State<'_, AppState>,
    request: ImpactRequest,
) -> Result<content::SourceImpactPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
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
}
#[tauri::command]
pub fn prepare_source_adoption(
    state: State<'_, AppState>,
    request: SourceAdoptRequest,
) -> Result<AdoptionAction, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
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
    let parameters = serde_json::to_value(&request.confirmation).map_err(|_| stale())?;
    store
        .prepare_adoption_with_id(
            request.action_id,
            request.attempt_id,
            input.envelope().units[0].unit_id,
            vec![request.result_id],
            parameters,
        )
        .map_err(map_source)
}
