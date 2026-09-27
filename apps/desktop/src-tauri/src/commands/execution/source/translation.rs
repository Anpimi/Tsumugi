use super::*;
use tsumugi_core::{
    SaveTranslationRevision, SelectTranslationRevision, TranslationAdoptionConfirmation,
    TranslationHistory, TranslationPreview, TranslationSelection,
};

request!(TranslationFilesRequest {
    selection_id: ExecutionId
});
request!(TranslationCaptureRequest {
    selection_id: ExecutionId,
    file_name: String,
    target_locale: String,
});
request!(TranslationStartRequest {
    selection_id: ExecutionId,
    file_name: String,
    target_locale: String,
    language_confirmed: bool,
    attempt_id: ExecutionId,
});
request!(TranslationPreviewRequest {
    attempt_id: ExecutionId,
    after: u32,
    limit: u32,
    basis: Option<String>,
});
request!(TranslationAdoptRequest {
    attempt_id: ExecutionId,
    item_id: ExecutionId,
    result_id: ExecutionId,
    action_id: ExecutionId,
    confirmation: TranslationAdoptionConfirmation,
});
request!(TranslationHistoryRequest {
    unit_id: ExecutionId,
    locale: String,
    after_ordinal: u64,
    limit: u32,
});
request!(TranslationSaveRequest {
    action_id: ExecutionId,
    unit_id: ExecutionId,
    locale: String,
    source_revision_id: ExecutionId,
    expected_selection_id: Option<ExecutionId>,
    text: String,
});
request!(TranslationSelectRequest {
    action_id: ExecutionId,
    unit_id: ExecutionId,
    locale: String,
    source_revision_id: ExecutionId,
    expected_selection_id: Option<ExecutionId>,
    revision_id: ExecutionId,
});

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationPreflight {
    pub file_name: String,
    pub file_digest: String,
    pub declared_locale: String,
    pub target_locale: String,
    pub count: u32,
    pub source_snapshot_id: ExecutionId,
}

fn begin_translation(
    sessions: &mut SessionManager,
    token: &str,
    project: ExecutionId,
    selection_id: ExecutionId,
    target_locale: &str,
) -> Result<(CaptureJob, ExecutionId), CommandError> {
    let active = authorized(sessions, token, project, CommandStage::ExecutionRead)?;
    let metadata = active
        .store
        .metadata()
        .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRead))?;
    if !metadata
        .target_locales()
        .iter()
        .any(|locale| locale.as_str() == target_locale)
    {
        return Err(map_source(ExecutionError::new(
            ErrorCode::DependencyConflict,
            "translation-locale",
        )));
    }
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    let snapshot = store
        .content_scope()
        .map_err(map_source)?
        .current_snapshot
        .ok_or_else(|| {
            map_source(ExecutionError::new(
                ErrorCode::DependencyConflict,
                "translation-source",
            ))
        })?;
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
        .map(|(_, selection)| selection.clone())
        .ok_or_else(stale)?;
    let id = ExecutionId::new();
    host.source.cancel = Cancellation::default();
    host.source.job = Some(id);
    Ok((
        CaptureJob {
            id,
            selection,
            cancel: host.source.cancel.clone(),
        },
        snapshot,
    ))
}

#[tauri::command]
pub async fn list_translation_files(
    state: State<'_, AppState>,
    request: TranslationFilesRequest,
) -> Result<Vec<String>, CommandError> {
    let selection = {
        let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
        let active = authorized(
            &mut sessions,
            &request.session_token,
            request.project_id,
            CommandStage::ExecutionRead,
        )?;
        active
            .execution_parts()?
            .0
            .source
            .selection
            .as_ref()
            .filter(|(id, _)| *id == request.selection_id)
            .map(|(_, selection)| selection.clone())
            .ok_or_else(stale)?
    };
    let files = tauri::async_runtime::spawn_blocking(move || selection.translation_files())
        .await
        .map_err(|_| stale())?
        .map_err(map_source)?;
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?;
    if active
        .execution_parts()?
        .0
        .source
        .selection
        .as_ref()
        .map(|(id, _)| *id)
        != Some(request.selection_id)
    {
        return Err(stale());
    }
    Ok(files)
}

#[tauri::command]
pub async fn preflight_translation(
    state: State<'_, AppState>,
    request: TranslationCaptureRequest,
) -> Result<TranslationPreflight, CommandError> {
    let (job, snapshot) = {
        let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
        begin_translation(
            &mut sessions,
            &request.session_token,
            request.project_id,
            request.selection_id,
            &request.target_locale,
        )?
    };
    let job_id = job.id;
    let file_name = request.file_name.clone();
    let target = request.target_locale.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bundle =
            job.selection
                .capture_translation(&file_name, &target, snapshot, &job.cancel)?;
        let count = content::extract_translation(&bundle, &job.cancel)?.len() as u32;
        Ok::<_, ExecutionError>(TranslationPreflight {
            file_name,
            file_digest: bundle.file.sha256,
            declared_locale: bundle.declared_locale,
            target_locale: bundle.target_locale,
            count,
            source_snapshot_id: snapshot,
        })
    })
    .await
    .map_err(|_| stale());
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    finish(
        &mut sessions,
        &request.session_token,
        request.project_id,
        job_id,
    )?;
    result?.map_err(map_source)
}

#[tauri::command]
pub async fn start_translation_import(
    state: State<'_, AppState>,
    request: TranslationStartRequest,
) -> Result<ExecutionId, CommandError> {
    if !request.language_confirmed {
        return Err(map_source(ExecutionError::new(
            ErrorCode::InvalidInput,
            "language-confirmation-required",
        )));
    }
    let (job, snapshot) = {
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
            request.file_name.clone(),
            request.target_locale.clone(),
        );
        match store.execution_input(request.attempt_id) {
            Ok(input) => {
                if host.source.translation_last_start.as_ref() != Some(&identity)
                    || input.envelope().operation != content::TRANSLATION_OPERATION
                {
                    return Err(stale());
                }
                return Ok(request.attempt_id);
            }
            Err(error) if error.code == ErrorCode::InvalidInput => {}
            Err(error) => return Err(map_source(error)),
        }
        let pair = begin_translation(
            &mut sessions,
            &request.session_token,
            request.project_id,
            request.selection_id,
            &request.target_locale,
        )?;
        let active = authorized(
            &mut sessions,
            &request.session_token,
            request.project_id,
            CommandStage::ExecutionRecover,
        )?;
        active.execution_parts()?.0.source.translation_last_start = Some(identity);
        pair
    };
    let job_id = job.id;
    let file_name = request.file_name.clone();
    let target = request.target_locale.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let bundle =
            job.selection
                .capture_translation(&file_name, &target, snapshot, &job.cancel)?;
        content::extract_translation(&bundle, &job.cancel)?;
        Ok::<_, ExecutionError>(bundle)
    })
    .await
    .map_err(|_| stale());
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRecover)?;
    let active = finish(
        &mut sessions,
        &request.session_token,
        request.project_id,
        job_id,
    )?;
    let bundle = result?.map_err(map_source)?;
    let metadata = active
        .store
        .metadata()
        .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRecover))?;
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
pub fn read_translation_preview(
    state: State<'_, AppState>,
    request: TranslationPreviewRequest,
) -> Result<TranslationPreview, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .translation_preview(
        request.attempt_id,
        request.after,
        request.limit,
        request.basis.as_deref(),
    )
    .map_err(map_source)
}

#[tauri::command]
pub fn prepare_translation_adoption(
    state: State<'_, AppState>,
    request: TranslationAdoptRequest,
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
    let input = store
        .execution_input(request.attempt_id)
        .map_err(map_source)?;
    if input.envelope().operation != content::TRANSLATION_OPERATION {
        return Err(stale());
    }
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|unit| unit.item_ids == vec![request.item_id])
        .ok_or_else(stale)?;
    store
        .prepare_adoption_with_id(
            request.action_id,
            request.attempt_id,
            unit.unit_id,
            vec![request.result_id],
            serde_json::to_value(request.confirmation).map_err(|_| stale())?,
        )
        .map_err(map_source)
}

#[tauri::command]
pub fn read_translation_history(
    state: State<'_, AppState>,
    request: TranslationHistoryRequest,
) -> Result<TranslationHistory, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .translation_history(
        request.project_id,
        request.unit_id,
        &request.locale,
        request.after_ordinal,
        request.limit,
    )
    .map_err(map_source)
}

#[tauri::command]
pub fn save_translation_revision(
    state: State<'_, AppState>,
    request: TranslationSaveRequest,
) -> Result<TranslationSelection, CommandError> {
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
        .save_translation_revision(&SaveTranslationRevision {
            project_id: request.project_id,
            action_id: request.action_id,
            unit_id: request.unit_id,
            locale: request.locale,
            source_revision_id: request.source_revision_id,
            expected_selection_id: request.expected_selection_id,
            text: request.text,
        })
        .map_err(map_source)
}

#[tauri::command]
pub fn select_translation_revision(
    state: State<'_, AppState>,
    request: TranslationSelectRequest,
) -> Result<TranslationSelection, CommandError> {
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
        .select_translation_revision(&SelectTranslationRevision {
            project_id: request.project_id,
            action_id: request.action_id,
            unit_id: request.unit_id,
            locale: request.locale,
            source_revision_id: request.source_revision_id,
            expected_selection_id: request.expected_selection_id,
            revision_id: request.revision_id,
        })
        .map_err(map_source)
}
