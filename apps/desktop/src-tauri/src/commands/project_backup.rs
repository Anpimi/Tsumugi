//! Native selections and the project-session boundary for local backup and restore.
use super::*;
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::execution::ExecutionId;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupProjectRequest {
    pub session_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreProjectRequest {
    pub directory_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct BackupProjectView {
    pub saved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RestoreProjectView {
    pub project: Option<ProjectView>,
}

fn backup_source<'a>(
    sessions: &'a SessionManager,
    token: &str,
) -> Result<&'a ProjectStore, CommandError> {
    let stage = CommandStage::Read;
    sessions.ensure_recovery_allowed(token, stage)?;
    let active = sessions
        .active
        .as_ref()
        .filter(|active| active.token == token)
        .ok_or_else(|| CommandError::simple(CommandErrorCode::SessionInvalid, stage))?;
    sessions.ensure_package_operation_idle(stage)?;
    active.ensure_execution_idle(stage)?;
    if sessions.mcp.active() || sessions.mcp_retrieval.active() || sessions.source_hooks.is_active()
    {
        return Err(CommandError::simple(CommandErrorCode::Busy, stage));
    }
    Ok(&active.store)
}

fn restore_epoch(sessions: &SessionManager) -> Result<ExecutionId, CommandError> {
    let stage = CommandStage::Create;
    sessions.ensure_package_operation_idle(stage)?;
    if sessions.active.is_some() || sessions.directory_recovery.is_some() {
        return Err(CommandError::simple(CommandErrorCode::Busy, stage));
    }
    Ok(sessions.startup.epoch())
}

fn restore_selected(
    sessions: &mut SessionManager,
    epoch: ExecutionId,
    backup: &Path,
    parent: &Path,
    name: &str,
) -> Result<ProjectView, CommandError> {
    let stage = CommandStage::Create;
    if restore_epoch(sessions)? != epoch {
        return Err(CommandError::simple(
            CommandErrorCode::SessionInvalid,
            stage,
        ));
    }
    validate_directory_name(name, stage)?;
    let destination = parent.join(name);
    let locator = destination
        .to_str()
        .ok_or_else(|| CommandError::invalid_input(stage, Some("directoryName")))?;
    ProjectStore::restore_backup(backup, &destination)
        .map_err(|error| map_persistence_error(error, stage))?;
    sessions
        .open(OpenProjectRequest {
            locator: locator.into(),
        })
        .map_err(|mut error| {
            error.reason = Some("restored-project-open-failed".into());
            error
        })
}

#[tauri::command]
pub async fn backup_project<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::Window<R>,
    state: State<'_, AppState>,
    request: BackupProjectRequest,
) -> Result<BackupProjectView, CommandError> {
    let stage = CommandStage::Read;
    if window.label() != "main" {
        return Err(CommandError::simple(
            CommandErrorCode::SessionInvalid,
            stage,
        ));
    }
    let token = request.session_token.clone();
    state
        .sessions
        .run("backup_project.admit", stage, move |sessions| {
            backup_source(sessions, &token).map(|_| ())
        })
        .await?;
    let destination = state
        .dialogs
        .run(stage, move || {
            app.dialog()
                .file()
                .set_file_name("project.backup")
                .blocking_save_file()
                .map(|path| {
                    path.into_path()
                        .map_err(|_| CommandError::invalid_input(stage, Some("destination")))
                })
                .transpose()
        })
        .await?;
    let Some(destination) = destination else {
        return Ok(BackupProjectView { saved: false });
    };
    state
        .sessions
        .run("backup_project.save", stage, move |sessions| {
            backup_source(sessions, &request.session_token)?
                .backup_to(&destination)
                .map_err(|error| map_persistence_error(error, stage))?;
            Ok(BackupProjectView { saved: true })
        })
        .await
}

#[tauri::command]
pub async fn restore_project<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::Window<R>,
    state: State<'_, AppState>,
    request: RestoreProjectRequest,
) -> Result<RestoreProjectView, CommandError> {
    let stage = CommandStage::Create;
    if window.label() != "main" {
        return Err(CommandError::simple(
            CommandErrorCode::SessionInvalid,
            stage,
        ));
    }
    validate_directory_name(&request.directory_name, stage)?;
    let epoch = state
        .sessions
        .run("restore_project.admit", stage, |sessions| {
            restore_epoch(sessions)
        })
        .await?;
    let selection = state
        .dialogs
        .run(stage, move || {
            let Some(backup) = app
                .dialog()
                .file()
                .add_filter("Tsumugi", &["backup"])
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            let Some(parent) = app.dialog().file().blocking_pick_folder() else {
                return Ok(None);
            };
            let invalid = |_| CommandError::invalid_input(stage, Some("destination"));
            Ok(Some((
                backup.into_path().map_err(invalid)?,
                parent.into_path().map_err(invalid)?,
            )))
        })
        .await?;
    let Some((backup, parent)) = selection else {
        return Ok(RestoreProjectView { project: None });
    };
    state
        .sessions
        .run("restore_project.open", stage, move |sessions| {
            let project =
                restore_selected(sessions, epoch, &backup, &parent, &request.directory_name)?;
            Ok(RestoreProjectView {
                project: Some(project),
            })
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_backup_native_selection_uses_original_session_and_opens_restored_copy() {
        let directory = tempfile::tempdir().unwrap();
        let mut sessions = SessionManager::default();
        let stale_epoch = restore_epoch(&sessions).unwrap();
        let original = sessions
            .create(CreateProjectRequest {
                destination: directory.path().join("original").to_str().unwrap().into(),
                display_name: "Original".into(),
                source_locale: "en-US".into(),
                target_locales: vec!["zh-CN".into()],
            })
            .unwrap();
        assert!(backup_source(&sessions, "stale").is_err());
        assert!(restore_epoch(&sessions).is_err());
        let backup = directory.path().join("project.backup");
        backup_source(&sessions, &original.session_token)
            .unwrap()
            .backup_to(&backup)
            .unwrap();
        sessions
            .close(CloseProjectRequest {
                session_token: original.session_token,
            })
            .unwrap();
        assert_eq!(
            restore_selected(
                &mut sessions,
                stale_epoch,
                &backup,
                directory.path(),
                "stale"
            )
            .unwrap_err()
            .code,
            CommandErrorCode::SessionInvalid
        );
        assert!(!directory.path().join("stale").exists());

        let epoch = restore_epoch(&sessions).unwrap();
        assert_eq!(
            restore_selected(&mut sessions, epoch, &backup, directory.path(), "original")
                .unwrap_err()
                .code,
            CommandErrorCode::DestinationConflict
        );
        let restored =
            restore_selected(&mut sessions, epoch, &backup, directory.path(), "restored").unwrap();
        assert_eq!(restored.metadata.project_id, original.metadata.project_id);
        let active = sessions.active.as_ref().unwrap();
        assert!(active.store.restored_instance().is_some());
        assert!(active.execution.is_none());
    }
}
