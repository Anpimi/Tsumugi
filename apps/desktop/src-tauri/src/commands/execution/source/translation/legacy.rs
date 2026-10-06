//! Built-in translation import baseline for isolated tests only.
use super::*;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationCaptureRequest {
        selection_id: ExecutionId,
        file_name: String,
        target_locale: String,
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationStartRequest {
        selection_id: ExecutionId,
        file_name: String,
        target_locale: String,
        language_confirmed: bool,
        expected_file_digest: String,
        expected_source_snapshot_id: ExecutionId,
        attempt_id: ExecutionId,
    }
);
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
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
    expected_snapshot: Option<ExecutionId>,
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
    if expected_snapshot.is_some_and(|expected| expected != snapshot) {
        return Err(map_source(ExecutionError::new(
            ErrorCode::DependencyConflict,
            "translation-source",
        )));
    }
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
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let selection = lease
        .run(
            "list_translation_files.begin",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .execution_parts()?
                    .0
                    .source
                    .selection
                    .as_ref()
                    .filter(|(id, _)| *id == initial.selection_id)
                    .map(|(_, selection)| selection.clone())
                    .ok_or_else(stale)
            },
        )
        .await?;
    let files = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            selection.translation_files().map_err(map_source)
        })
        .await;
    lease
        .run(
            "list_translation_files.finish",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
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
                files
            },
        )
        .await
}

#[tauri::command]
pub async fn preflight_translation(
    state: State<'_, AppState>,
    request: TranslationCaptureRequest,
) -> Result<TranslationPreflight, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let (job, snapshot) = lease
        .run(
            "preflight_translation.begin",
            CommandStage::ExecutionRead,
            move |sessions| {
                begin_translation(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    initial.selection_id,
                    &initial.target_locale,
                    None,
                )
            },
        )
        .await?;
    let job_id = job.id;
    let file_name = request.file_name.clone();
    let target = request.target_locale.clone();
    let result = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            let bundle = job
                .selection
                .capture_translation(&file_name, &target, snapshot, &job.cancel)
                .map_err(map_source)?;
            let count = content::extract_translation(&bundle, &job.cancel)
                .map_err(map_source)?
                .len() as u32;
            Ok(TranslationPreflight {
                file_name,
                file_digest: bundle.file.sha256,
                declared_locale: bundle.declared_locale,
                target_locale: bundle.target_locale,
                count,
                source_snapshot_id: snapshot,
            })
        })
        .await;
    lease
        .run(
            "preflight_translation.finish",
            CommandStage::ExecutionRead,
            move |sessions| {
                finish(sessions, &request.session_token, request.project_id, job_id)?;
                result
            },
        )
        .await
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
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let pair = lease
        .run(
            "start_translation_import.begin",
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
                    initial.file_name.clone(),
                    initial.target_locale.clone(),
                    initial.expected_file_digest.clone(),
                    initial.expected_source_snapshot_id,
                );
                match store.execution_input(initial.attempt_id) {
                    Ok(input) => {
                        if host.source.translation_last_start.as_ref() != Some(&identity)
                            || input.envelope().operation != content::TRANSLATION_OPERATION
                        {
                            return Err(stale());
                        }
                        return Ok(None);
                    }
                    Err(error) if error.code == ErrorCode::InvalidInput => {}
                    Err(error) => return Err(map_source(error)),
                }
                let pair = begin_translation(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    initial.selection_id,
                    &initial.target_locale,
                    Some(initial.expected_source_snapshot_id),
                )?;
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                active.execution_parts()?.0.source.translation_last_start = Some(identity);
                Ok(Some(pair))
            },
        )
        .await?;
    let Some((job, snapshot)) = pair else {
        return Ok(request.attempt_id);
    };
    let job_id = job.id;
    let file_name = request.file_name.clone();
    let target = request.target_locale.clone();
    let result = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            let bundle = job
                .selection
                .capture_translation(&file_name, &target, snapshot, &job.cancel)
                .map_err(map_source)?;
            content::extract_translation(&bundle, &job.cancel).map_err(map_source)?;
            Ok(bundle)
        })
        .await;
    lease
        .run(
            "start_translation_import.finish",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = finish(sessions, &request.session_token, request.project_id, job_id)?;
                let bundle = result?;
                if bundle.file.sha256 != request.expected_file_digest {
                    return Err(map_source(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "source-changed",
                    )));
                }
                let metadata = active.store.metadata().map_err(|error| {
                    map_persistence_error(error, CommandStage::ExecutionRecover)
                })?;
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
