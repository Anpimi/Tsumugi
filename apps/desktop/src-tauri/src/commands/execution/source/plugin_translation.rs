//! Declared translation capture bound to an adopted source and an explicit
//! project target. Native IO does not interpret domain filenames or text.
use super::*;
use crate::commands::plugins::{
    PluginTranslationRequest, PluginTranslationView, translations::TranslationEnvironment,
};
use tsumugi_core::{TranslationSourceContext, content::PluginTranslationSettings};
use tsumugi_plugin_sdk as sdk;
mod execution;
pub use execution::*;

#[derive(Default)]
pub(super) struct PluginTranslationSession {
    choice: Option<TranslationChoice>,
    review: Option<Arc<TranslationReview>>,
    last_start: Option<PluginStartRequest>,
    check: Option<Arc<execution::CheckReview>>,
    last_check_start: Option<PluginStartRequest>,
    projection: Option<Arc<execution::ProjectionReview>>,
}
impl PluginTranslationSession {
    pub(super) fn discard_capture(&mut self) {
        self.choice = None;
        self.review = None;
    }
}
#[derive(Clone)]
struct TranslationChoice {
    selection_id: ExecutionId,
    request: PluginTranslationSelectRequest,
    source: TranslationSourceContext,
}
struct TranslationReview {
    choice: TranslationChoice,
    request: PluginTranslationCaptureRequest,
    input: FixedInput,
    view: PluginTranslationPreflight,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationSourceRequest {
        target_locale: String
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginTranslationSelectRequest {
        translation: PluginTranslationRequest,
        target_locale: String,
        expected_source_snapshot_id: ExecutionId,
        native_scope: sdk::TranslationNativeScope
    }
);
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginTranslationCaptureRequest {
        selection_id: ExecutionId,
        file_name: String,
        language_confirmed: bool,
        attempt_id: ExecutionId
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTranslationSelection {
    pub selection_id: ExecutionId,
    pub folder_name: String,
    pub target_locale: String,
    pub native_scope: sdk::TranslationNativeScope,
    pub source: TranslationSourceContext,
    pub translation: PluginTranslationView,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTranslationPreflight {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub target_locale: String,
    pub source: TranslationSourceContext,
    pub translation: PluginTranslationView,
    pub file: plugin::PluginSourceFile,
}

fn conflict(stage: &str) -> CommandError {
    map_source(ExecutionError::new(ErrorCode::DependencyConflict, stage))
}
fn source_context(
    store: &ProjectStore,
    request: &PluginTranslationSelectRequest,
) -> Result<TranslationSourceContext, CommandError> {
    let source = store
        .translation_source_context(&request.target_locale)
        .map_err(map_source)?;
    if source.source_snapshot_id != request.expected_source_snapshot_id {
        return Err(conflict("translation-source"));
    }
    if !source.native_scopes.contains(&request.native_scope) {
        return Err(conflict("translation-native-scope"));
    }
    Ok(source)
}
fn current_choice(store: &ProjectStore, choice: &TranslationChoice) -> Result<(), CommandError> {
    if source_context(store, &choice.request)? != choice.source {
        return Err(conflict("translation-source"));
    }
    Ok(())
}
fn environment_matches(
    environment: &TranslationEnvironment,
    source: &TranslationSourceContext,
) -> Result<(), CommandError> {
    if environment.binding.declaration.profile != source.profile {
        return Err(conflict("translation-format"));
    }
    Ok(())
}
fn execution_binding(
    environment: &TranslationEnvironment,
    checker: bool,
) -> PluginExecutionBinding {
    PluginExecutionBinding {
        capability: if checker {
            environment.binding.checker.clone()
        } else {
            environment.binding.extractor.clone()
        },
        profile: Some(environment.binding.declaration.profile.clone()),
        environment: environment.runtime.environment(),
    }
}
fn choice_and_selection(
    active: &mut ActiveSession,
    selection_id: ExecutionId,
) -> Result<(TranslationChoice, Arc<capture::Selection>), CommandError> {
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    let choice = host
        .source
        .translation
        .choice
        .as_ref()
        .filter(|choice| choice.selection_id == selection_id)
        .cloned()
        .ok_or_else(stale)?;
    let selection = host
        .source
        .selection
        .as_ref()
        .filter(|(id, _)| *id == selection_id)
        .map(|(_, selection)| selection.clone())
        .ok_or_else(stale)?;
    current_choice(store, &choice)?;
    Ok((choice, selection))
}

#[tauri::command]
pub async fn read_plugin_translation_source(
    state: State<'_, AppState>,
    request: TranslationSourceRequest,
) -> Result<TranslationSourceContext, CommandError> {
    state
        .sessions
        .lease(CommandStage::ExecutionRead)?
        .run(
            "read_plugin_translation_source",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .translation_source_context(&request.target_locale)
                    .map_err(map_source)
            },
        )
        .await
}

#[tauri::command]
pub async fn select_plugin_translation<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: PluginTranslationSelectRequest,
) -> Result<Option<PluginTranslationSelection>, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let picker = ExecutionId::new();
    let admitted = lease.submit(
        "select_plugin_translation.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let source = source_context(store, &initial)?;
            host.source.stop();
            host.source.picker = Some(picker);
            Ok(source)
        },
    )?;
    let io = state.io.clone();
    let dialogs = state.dialogs.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let source = admitted.await?;
        let choice = request.translation.clone();
        let expected = source.clone();
        let captured = async {
            let environment = io
                .run(CommandStage::ExecutionRead, move || {
                    let environment = plugins.capture_translation(&choice)?;
                    environment_matches(&environment, &expected)?;
                    Ok(environment)
                })
                .await?;
            let path = dialogs
                .run(CommandStage::ExecutionRead, move || {
                    Ok(app.dialog().file().blocking_pick_folder())
                })
                .await?;
            io.run(CommandStage::ExecutionRead, move || {
                path.map(|path| {
                    let selection =
                        capture::Selection::authorize(path.into_path().map_err(|_| stale())?)
                            .map_err(map_source)?;
                    Ok((Arc::new(selection), environment.view()?))
                })
                .transpose()
            })
            .await
        }
        .await;
        lease
            .run(
                "select_plugin_translation.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    host.allow_mutation()?;
                    if host.source.picker != Some(picker) {
                        return Err(stale());
                    }
                    host.source.picker = None;
                    if source_context(store, &request)? != source {
                        return Err(conflict("translation-source"));
                    }
                    Ok(captured?.map(|(selection, translation)| {
                        let selection_id = ExecutionId::new();
                        let view = PluginTranslationSelection {
                            selection_id,
                            folder_name: selection.label(),
                            target_locale: request.target_locale.clone(),
                            native_scope: request.native_scope.clone(),
                            source: source.clone(),
                            translation,
                        };
                        host.source.selection = Some((selection_id, selection));
                        host.source.translation.choice = Some(TranslationChoice {
                            selection_id,
                            request,
                            source,
                        });
                        view
                    }))
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn list_plugin_translation_files(
    state: State<'_, AppState>,
    request: translation::TranslationFilesRequest,
) -> Result<Vec<String>, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let (choice, selection) = lease
        .run(
            "list_plugin_translation_files.begin",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &initial.session_token,
                    initial.project_id,
                    CommandStage::ExecutionRead,
                )?;
                choice_and_selection(active, initial.selection_id)
            },
        )
        .await?;
    let plugins = state.plugins.clone();
    let selected = choice.clone();
    let files = state
        .io
        .run(CommandStage::ExecutionRead, move || {
            let environment = plugins.capture_translation(&selected.request.translation)?;
            environment_matches(&environment, &selected.source)?;
            selection
                .declared_translation_files(&environment.binding)
                .map_err(map_source)
        })
        .await;
    lease
        .run(
            "list_plugin_translation_files.finish",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (current, _) = choice_and_selection(active, request.selection_id)?;
                if current.source != choice.source {
                    return Err(stale());
                }
                files
            },
        )
        .await
}

#[tauri::command]
pub async fn preflight_plugin_translation(
    state: State<'_, AppState>,
    request: PluginTranslationCaptureRequest,
) -> Result<PluginTranslationPreflight, CommandError> {
    if !request.language_confirmed {
        return Err(map_source(ExecutionError::new(
            ErrorCode::Unauthorized,
            "translation-language-confirmation",
        )));
    }
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "preflight_plugin_translation.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (choice, selection) = choice_and_selection(active, initial.selection_id)?;
            let (host, store) = active.execution_parts()?;
            let existing = host
                .source
                .translation
                .review
                .as_ref()
                .filter(|review| review.request.attempt_id == initial.attempt_id)
                .cloned();
            if existing
                .as_ref()
                .is_some_and(|review| review.request != initial)
            {
                return Err(stale());
            }
            match store.execution_input(initial.attempt_id) {
                Ok(_) => return Err(stale()),
                Err(error) if error.code == ErrorCode::InvalidInput => {}
                Err(error) => return Err(map_source(error)),
            }
            let project = store
                .metadata()
                .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRead))?
                .project_id();
            let id = plugin::begin_job(active)?;
            let cancel = active.execution_parts()?.0.source.cancel.clone();
            Ok((id, cancel, choice, selection, existing, project))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (id, cancel, choice, selection, existing, project) = admitted.await?;
        let selected = choice.clone();
        let capturing = request.clone();
        let captured = io
            .run(CommandStage::ExecutionRead, move || {
                let environment = plugins.capture_translation(&selected.request.translation)?;
                environment_matches(&environment, &selected.source)?;
                let settings = PluginTranslationSettings {
                    declaration: environment.binding.declaration.clone(),
                    checker: execution_binding(&environment, true),
                };
                if let Some(review) = existing {
                    let (_, original) =
                        content::plugin_translation_input(&review.input).map_err(map_source)?;
                    if review.input.envelope().plugin.as_ref()
                        != Some(&execution_binding(&environment, false))
                        || original != settings
                    {
                        return Err(stale());
                    }
                    return Ok(review);
                }
                let artifact = selection
                    .capture_declared_translation(
                        &environment.binding,
                        &capturing.file_name,
                        &cancel,
                    )
                    .map_err(map_source)?;
                let file = plugin::PluginSourceFile {
                    logical_path: artifact.logical_path.clone(),
                    role: artifact.role.clone(),
                    byte_length: artifact.utf8.len() as u32,
                    sha256: artifact.sha256.clone(),
                };
                let material = sdk::TranslationExtractionInput {
                    profile: selected.source.profile.clone(),
                    import_id: capturing.attempt_id.to_string(),
                    source_set_id: selected.source.source_set_id.to_string(),
                    source_snapshot_id: selected.source.source_snapshot_id.to_string(),
                    target_language: selected.request.target_locale.clone(),
                    language_evidence: sdk::TranslationLanguageEvidence::UserConfirmed,
                    native_scope: selected.request.native_scope.clone(),
                    artifacts: vec![artifact],
                };
                let fixed = settings
                    .fixed_input(project, material, execution_binding(&environment, false))
                    .map_err(map_source)?;
                let mut envelope = fixed.envelope().clone();
                envelope.attempt_id = capturing.attempt_id;
                let input = FixedInput::capture(envelope).map_err(map_source)?;
                let review_choice = selected.clone();
                let view = PluginTranslationPreflight {
                    attempt_id: capturing.attempt_id,
                    input_digest: input.digest().into(),
                    target_locale: selected.request.target_locale,
                    source: selected.source,
                    translation: environment.view()?,
                    file,
                };
                Ok(Arc::new(TranslationReview {
                    choice: review_choice,
                    request: capturing,
                    input,
                    view,
                }))
            })
            .await;
        lease
            .run(
                "preflight_plugin_translation.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    let (host, store) = active.execution_parts()?;
                    current_choice(store, &choice)?;
                    if host
                        .source
                        .translation
                        .choice
                        .as_ref()
                        .map(|choice| choice.selection_id)
                        != Some(request.selection_id)
                    {
                        return Err(stale());
                    }
                    let review = captured?;
                    let view = review.view.clone();
                    host.source.translation.review = Some(review);
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[cfg(test)]
mod tests;

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(super) use tests::choose as choose_translation_for_test;
