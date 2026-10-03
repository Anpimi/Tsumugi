//! Native, session-scoped local export of an immutable verified release.
use super::*;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::content::artifact_digest;
use tsumugi_core::{BuildLocaleChoice, DeliveryFile, DeliveryView, ReleaseView};

#[derive(Default)]
pub(super) struct ReleaseSession {
    picker: Option<ExecutionId>,
    selection: Option<(ExecutionId, Arc<source::capture::Selection>)>,
    preview: Option<DeliveryPreview>,
}
impl ReleaseSession {
    pub fn stop(&mut self) {
        self.picker = None;
        self.selection = None;
        self.preview = None;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverySelection {
    pub selection_id: ExecutionId,
    pub folder_name: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewFile {
    pub locale: String,
    pub file_name: String,
    pub expected_sha256: String,
    pub current_sha256: Option<String>,
    pub state: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryPreview {
    pub preview_id: ExecutionId,
    pub release_id: ExecutionId,
    pub selection_id: ExecutionId,
    pub folder_name: String,
    pub files: Vec<PreviewFile>,
}
request!(BuildRequest { attempt_id: ExecutionId, choices: Vec<BuildLocaleChoice>, expected_eligibility_basis: String });
request!(ReleaseRequest {
    release_id: ExecutionId
});
request!(PreviewRequest {
    release_id: ExecutionId,
    selection_id: ExecutionId
});
request!(ExportRequest {
    release_id: ExecutionId,
    selection_id: ExecutionId,
    preview_id: ExecutionId,
    action_id: ExecutionId,
    overwrite_conflicts: bool
});
request!(ReconcileRequest {
    action_id: ExecutionId,
    selection_id: ExecutionId
});

fn mapped(error: ExecutionError, stage: CommandStage) -> CommandError {
    let result = map_execution(error, stage);
    result
}
fn invalid(stage: CommandStage, field: &str) -> CommandError {
    CommandError::invalid_input(stage, Some(field))
}

#[tauri::command]
pub async fn start_locale_build(
    state: State<'_, AppState>,
    request: BuildRequest,
) -> Result<ExecutionId, CommandError> {
    state
        .sessions
        .run(
            "start_locale_build",
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
                let input = store
                    .prepare_locale_build(
                        request.project_id,
                        request.attempt_id,
                        &request.choices,
                        &request.expected_eligibility_basis,
                    )
                    .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))?;
                host.runtime
                    .submit(store, &input)
                    .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))?;
                Ok(request.attempt_id)
            },
        )
        .await
}

#[tauri::command]
pub async fn list_releases(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<Vec<ReleaseView>, CommandError> {
    state
        .sessions
        .run(
            "list_releases",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .list_releases(request.project_id)
                .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn choose_delivery_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<Option<DeliverySelection>, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let picker = ExecutionId::new();
    let initial = request.clone();
    lease
        .run(
            "choose_delivery_folder.begin",
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
                host.release.picker = Some(picker);
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
                        let path = path
                            .into_path()
                            .map_err(|_| invalid(CommandStage::ExecutionRead, "delivery-folder"))?;
                        source::capture::Selection::authorize(path)
                            .map(Arc::new)
                            .map_err(|error| mapped(error, CommandStage::ExecutionRead))
                    })
                    .transpose()
            })
            .await
    }
    .await;
    lease
        .run(
            "choose_delivery_folder.finish",
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
                if host.release.picker != Some(picker) {
                    return Err(CommandError::simple(
                        CommandErrorCode::SessionInvalid,
                        CommandStage::ExecutionRead,
                    ));
                }
                host.release.picker = None;
                Ok(selection?.map(|selection| {
                    host.release.preview = None;
                    let selection_id = ExecutionId::new();
                    let folder_name = selection.label();
                    host.release.selection = Some((selection_id, selection));
                    DeliverySelection {
                        selection_id,
                        folder_name,
                    }
                }))
            },
        )
        .await
}

fn selected(
    host: &ExecutionHost,
    id: ExecutionId,
) -> Result<&source::capture::Selection, CommandError> {
    host.release
        .selection
        .as_ref()
        .filter(|(current, _)| *current == id)
        .map(|(_, value)| value.as_ref())
        .ok_or_else(|| {
            CommandError::simple(
                CommandErrorCode::SessionInvalid,
                CommandStage::ExecutionRead,
            )
        })
}

#[cfg(windows)]
fn regular_file(path: &Path) -> Result<bool, CommandError> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_file()
                && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 =>
        {
            Ok(true)
        }
        Ok(_) => Err(CommandError::simple(
            CommandErrorCode::PermissionDenied,
            CommandStage::ExecutionRead,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(CommandError::simple(
            CommandErrorCode::StorageFailed,
            CommandStage::ExecutionRead,
        )),
    }
}
#[cfg(not(windows))]
fn regular_file(_: &Path) -> Result<bool, CommandError> {
    Err(CommandError::simple(
        CommandErrorCode::PermissionDenied,
        CommandStage::ExecutionRead,
    ))
}
fn current_digest(path: &Path) -> Result<Option<String>, CommandError> {
    if !regular_file(path)? {
        return Ok(None);
    }
    let file = OpenOptions::new().read(true).open(path).map_err(|_| {
        CommandError::simple(CommandErrorCode::StorageFailed, CommandStage::ExecutionRead)
    })?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            CommandError::simple(CommandErrorCode::StorageFailed, CommandStage::ExecutionRead)
        })?;
    if bytes.len() > 1024 * 1024 {
        return Err(CommandError::simple(
            CommandErrorCode::LimitExceeded,
            CommandStage::ExecutionRead,
        ));
    }
    Ok(Some(artifact_digest(&bytes)))
}
fn delivery_name(path: &str) -> Result<&str, CommandError> {
    if let Some(name) = path.strip_prefix("i18n/") {
        if tsumugi_core::content::declared_locale(path).is_ok() {
            return Ok(name);
        }
    }
    if tsumugi_core::content::webvtt::file_name(path) {
        return Ok(path);
    }
    Err(invalid(CommandStage::ExecutionRead, "delivery-file"))
}
fn preview_files(
    store: &ProjectStore,
    release_id: ExecutionId,
    root: &Path,
) -> Result<Vec<PreviewFile>, CommandError> {
    let release = store.release_view(release_id).map_err(map_read)?;
    let i18n = root.join("i18n");
    if i18n.exists() {
        source::capture::Selection::authorize(i18n.clone()).map_err(map_read)?;
    }
    release
        .artifacts
        .into_iter()
        .map(|artifact| {
            let name = delivery_name(&artifact.file_name)?;
            let destination = if artifact.file_name.starts_with("i18n/") {
                &i18n
            } else {
                root
            };
            let current_sha256 = current_digest(&destination.join(name))?;
            let state = match &current_sha256 {
                None => "absent",
                Some(current) if *current == artifact.sha256 => "same",
                Some(_) => "conflict",
            }
            .to_owned();
            Ok(PreviewFile {
                locale: artifact.locale,
                file_name: artifact.file_name,
                expected_sha256: artifact.sha256,
                current_sha256,
                state,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn preview_delivery(
    state: State<'_, AppState>,
    request: PreviewRequest,
) -> Result<DeliveryPreview, CommandError> {
    state
        .sessions
        .run(
            "preview_delivery",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                let selection = selected(host, request.selection_id)?;
                let root = selection.destination_root().map_err(map_read)?;
                let files = preview_files(store, request.release_id, root)?;
                let preview = DeliveryPreview {
                    preview_id: ExecutionId::new(),
                    release_id: request.release_id,
                    selection_id: request.selection_id,
                    folder_name: selection.label(),
                    files,
                };
                host.release.preview = Some(preview.clone());
                Ok(preview)
            },
        )
        .await
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let source = wide(source);
    let target = wide(target);
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(windows))]
fn replace_file(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("unsupported-platform"))
}

fn export_one(
    i18n: &Path,
    file: &PreviewFile,
    bytes: &[u8],
    overwrite: bool,
) -> Result<DeliveryFile, CommandError> {
    export_one_with_digest(i18n, file, bytes, overwrite, current_digest)
}

fn export_one_with_digest(
    i18n: &Path,
    file: &PreviewFile,
    bytes: &[u8],
    overwrite: bool,
    digest: impl Fn(&Path) -> Result<Option<String>, CommandError>,
) -> Result<DeliveryFile, CommandError> {
    let name = delivery_name(&file.file_name)?;
    let target = i18n.join(name);
    let current = digest(&target)?;
    if current != file.current_sha256 {
        return Err(CommandError::simple(
            CommandErrorCode::DestinationConflict,
            CommandStage::ExecutionAdopt,
        ));
    }
    if current.as_deref() == Some(&file.expected_sha256) {
        return Ok(DeliveryFile {
            locale: file.locale.clone(),
            file_name: file.file_name.clone(),
            expected_sha256: file.expected_sha256.clone(),
            actual_sha256: current,
            state: "succeeded".into(),
        });
    }
    if current.is_some() && !overwrite {
        return Err(CommandError::simple(
            CommandErrorCode::DestinationConflict,
            CommandStage::ExecutionAdopt,
        ));
    }
    let temporary = i18n.join(format!(".tsumugi-{}.tmp", ExecutionId::new()));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| {
            CommandError::simple(
                CommandErrorCode::StorageFailed,
                CommandStage::ExecutionAdopt,
            )
        })?;
    let write = output.write_all(bytes).and_then(|_| output.sync_all());
    drop(output);
    let temporary_digest = digest(&temporary);
    if write.is_err()
        || !matches!(temporary_digest, Ok(Some(ref value)) if value == &file.expected_sha256)
    {
        let _ = fs::remove_file(&temporary);
        return Err(CommandError::simple(
            CommandErrorCode::StorageFailed,
            CommandStage::ExecutionAdopt,
        ));
    }
    let fresh = digest(&target);
    if !matches!(&fresh, Ok(value) if value == &current) {
        let _ = fs::remove_file(&temporary);
        return Err(match fresh {
            Ok(_) => CommandError::simple(
                CommandErrorCode::DestinationConflict,
                CommandStage::ExecutionAdopt,
            ),
            Err(error) => error,
        });
    }
    let commit = if current.is_some() {
        replace_file(&temporary, &target)
    } else {
        fs::rename(&temporary, &target)
    };
    if commit.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    let observed = digest(&target);
    let state = match &observed {
        Ok(Some(value)) if value == &file.expected_sha256 => "succeeded",
        Ok(_) if commit.is_err() => "failed",
        _ => "unknown",
    };
    let actual = observed.ok().flatten();
    Ok(DeliveryFile {
        locale: file.locale.clone(),
        file_name: file.file_name.clone(),
        expected_sha256: file.expected_sha256.clone(),
        actual_sha256: actual,
        state: state.into(),
    })
}

#[tauri::command]
pub async fn export_release(
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<DeliveryView, CommandError> {
    state
        .sessions
        .run(
            "export_release",
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
                let selection = selected(host, request.selection_id)?;
                let root = selection
                    .destination_root()
                    .map_err(map_read)?
                    .to_path_buf();
                let directory = root.to_string_lossy().into_owned();
                if let Some(existing) = store
                    .delivery_by_action(request.action_id)
                    .map_err(map_adopt)?
                {
                    if existing.release_id != request.release_id
                        || existing.directory != directory
                        || existing.overwrite_conflicts != request.overwrite_conflicts
                    {
                        return Err(CommandError::simple(
                            CommandErrorCode::DependencyConflict,
                            CommandStage::ExecutionAdopt,
                        ));
                    }
                    if existing.state == "pending" {
                        return Err(CommandError::simple(
                            CommandErrorCode::OutcomeUnknown,
                            CommandStage::ExecutionAdopt,
                        ));
                    }
                    return Ok(existing);
                }
                let preview = host
                    .release
                    .preview
                    .as_ref()
                    .filter(|item| {
                        item.preview_id == request.preview_id
                            && item.release_id == request.release_id
                            && item.selection_id == request.selection_id
                    })
                    .cloned()
                    .ok_or_else(|| {
                        CommandError::simple(
                            CommandErrorCode::DependencyConflict,
                            CommandStage::ExecutionAdopt,
                        )
                    })?;
                if preview.files.iter().any(|file| file.state == "conflict")
                    && !request.overwrite_conflicts
                {
                    return Err(CommandError::simple(
                        CommandErrorCode::DestinationConflict,
                        CommandStage::ExecutionAdopt,
                    ));
                }
                store
                    .begin_delivery(
                        request.action_id,
                        request.release_id,
                        &directory,
                        request.overwrite_conflicts,
                    )
                    .map_err(map_adopt)?;
                let fresh = preview_files(store, request.release_id, &root)?;
                if fresh != preview.files {
                    let failed = preview
                        .files
                        .iter()
                        .map(|file| DeliveryFile {
                            locale: file.locale.clone(),
                            file_name: file.file_name.clone(),
                            expected_sha256: file.expected_sha256.clone(),
                            actual_sha256: fresh
                                .iter()
                                .find(|current| current.locale == file.locale)
                                .and_then(|current| current.current_sha256.clone()),
                            state: "failed".into(),
                        })
                        .collect();
                    store
                        .finish_delivery(request.action_id, failed)
                        .map_err(map_adopt)?;
                    host.release.preview = None;
                    return Err(CommandError::simple(
                        CommandErrorCode::DestinationConflict,
                        CommandStage::ExecutionAdopt,
                    ));
                }
                let i18n = if preview
                    .files
                    .iter()
                    .all(|file| file.file_name.starts_with("i18n/"))
                {
                    root.join("i18n")
                } else {
                    root.clone()
                };
                if !i18n.exists() {
                    fs::create_dir(&i18n).map_err(|_| {
                        CommandError::simple(
                            CommandErrorCode::StorageFailed,
                            CommandStage::ExecutionAdopt,
                        )
                    })?;
                }
                let _guard =
                    source::capture::Selection::authorize(i18n.clone()).map_err(map_adopt)?;
                let mut results = Vec::new();
                for file in &preview.files {
                    let result = store
                        .release_artifact(request.release_id, &file.locale)
                        .map_err(map_adopt)
                        .and_then(|(_, bytes)| {
                            export_one(&i18n, file, &bytes, request.overwrite_conflicts)
                        });
                    results.push(match result {
                        Ok(result) => result,
                        Err(_) => DeliveryFile {
                            locale: file.locale.clone(),
                            file_name: file.file_name.clone(),
                            expected_sha256: file.expected_sha256.clone(),
                            actual_sha256: None,
                            state: "failed".into(),
                        },
                    });
                }
                host.release.preview = None;
                store
                    .finish_delivery(request.action_id, results)
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn list_deliveries(
    state: State<'_, AppState>,
    request: ReleaseRequest,
) -> Result<Vec<DeliveryView>, CommandError> {
    state
        .sessions
        .run(
            "list_deliveries",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .list_deliveries(request.release_id)
                .map_err(map_read)
            },
        )
        .await
}

fn observe_delivery_files(
    i18n: &Path,
    files: Vec<DeliveryFile>,
) -> Result<Vec<DeliveryFile>, CommandError> {
    files
        .into_iter()
        .map(|mut file| {
            if file.state != "pending" && file.state != "unknown" {
                return Ok(file);
            }
            let name = delivery_name(&file.file_name)?;
            let observation = current_digest(&i18n.join(name));
            file.state = match &observation {
                Ok(Some(digest)) if digest == &file.expected_sha256 => "succeeded",
                Ok(None) => "failed",
                _ => "unknown",
            }
            .into();
            file.actual_sha256 = observation.ok().flatten();
            Ok(file)
        })
        .collect()
}

#[tauri::command]
pub async fn reconcile_delivery(
    state: State<'_, AppState>,
    request: ReconcileRequest,
) -> Result<DeliveryView, CommandError> {
    state
        .sessions
        .run(
            "reconcile_delivery",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let root = selected(host, request.selection_id)?
                    .destination_root()
                    .map_err(map_read)?
                    .to_path_buf();
                let current = store
                    .delivery_by_action(request.action_id)
                    .map_err(map_recover)?
                    .ok_or_else(|| invalid(CommandStage::ExecutionRecover, "delivery-action"))?;
                if current.directory != root.to_string_lossy() {
                    return Err(CommandError::simple(
                        CommandErrorCode::PermissionDenied,
                        CommandStage::ExecutionRecover,
                    ));
                }
                if !matches!(current.state.as_str(), "pending" | "unknown") {
                    return Ok(current);
                }
                let folder = if current
                    .files
                    .iter()
                    .all(|file| file.file_name.starts_with("i18n/"))
                {
                    root.join("i18n")
                } else {
                    root.clone()
                };
                let files = observe_delivery_files(&folder, current.files)?;
                store
                    .reconcile_delivery(request.action_id, files)
                    .map_err(map_recover)
            },
        )
        .await
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn webvtt_delivery_uses_verified_root_file_and_keeps_conflict_checks() {
        let root = tempfile::tempdir().unwrap();
        let bytes = include_bytes!(
            "../../../../../../crates/core/tests/fixtures/webvtt/expected-zh-CN.vtt"
        );
        let file = PreviewFile {
            locale: "zh-CN".into(),
            file_name: "zh-CN.vtt".into(),
            expected_sha256: artifact_digest(bytes),
            current_sha256: None,
            state: "absent".into(),
        };
        assert_eq!(
            export_one(root.path(), &file, bytes, false).unwrap().state,
            "succeeded"
        );
        assert_eq!(fs::read(root.path().join("zh-CN.vtt")).unwrap(), bytes);
        assert!(!root.path().join("i18n").exists());
        assert!(export_one(root.path(), &file, bytes, true).is_err());
        let same = PreviewFile {
            current_sha256: Some(artifact_digest(bytes)),
            state: "same".into(),
            ..file
        };
        assert_eq!(
            export_one(root.path(), &same, bytes, false).unwrap().state,
            "succeeded"
        );
        assert!(delivery_name("../zh-CN.vtt").is_err());
    }

    fn preview(state: &str, current_sha256: Option<String>, bytes: &[u8]) -> PreviewFile {
        PreviewFile {
            locale: "zh-CN".into(),
            file_name: "i18n/zh.json".into(),
            expected_sha256: artifact_digest(bytes),
            current_sha256,
            state: state.into(),
        }
    }

    #[test]
    fn local_export_checks_conflicts_bytes_and_explicit_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let i18n = directory.path().join("i18n");
        fs::create_dir(&i18n).unwrap();
        let bytes = b"{\n  \"hello\": \"world\"\n}\n";
        let absent = preview("absent", None, bytes);
        let first = export_one(&i18n, &absent, bytes, false).unwrap();
        assert_eq!(first.state, "succeeded");
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), bytes);
        assert_eq!(
            export_one(&i18n, &absent, bytes, false).unwrap_err().code,
            CommandErrorCode::DestinationConflict
        );
        let same = preview("same", Some(artifact_digest(bytes)), bytes);
        assert_eq!(
            export_one(&i18n, &same, bytes, false).unwrap().state,
            "succeeded"
        );
        fs::write(i18n.join("zh.json"), b"different").unwrap();
        assert_eq!(
            export_one(&i18n, &same, bytes, true).unwrap_err().code,
            CommandErrorCode::DestinationConflict
        );
        let different = preview("conflict", Some(artifact_digest(b"different")), bytes);
        assert_eq!(
            export_one(&i18n, &different, bytes, false)
                .unwrap_err()
                .code,
            CommandErrorCode::DestinationConflict
        );
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), b"different");
        assert_eq!(
            export_one(&i18n, &different, bytes, true).unwrap().state,
            "succeeded"
        );
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), bytes);
    }

    #[test]
    fn second_locale_failure_preserves_first_file_and_removes_temp_output() {
        let directory = tempfile::tempdir().unwrap();
        let i18n = directory.path().join("i18n");
        fs::create_dir(&i18n).unwrap();
        let zh = b"{\"hello\":\"zh\"}";
        let fr = b"{\"hello\":\"fr\"}";
        let first = preview("absent", None, zh);
        let second = PreviewFile {
            locale: "fr-FR".into(),
            file_name: "i18n/fr.json".into(),
            expected_sha256: artifact_digest(fr),
            current_sha256: None,
            state: "absent".into(),
        };
        assert_eq!(
            export_one(&i18n, &first, zh, false).unwrap().state,
            "succeeded"
        );
        assert!(export_one(&i18n, &second, b"bad bytes", false).is_err());
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), zh);
        assert!(!i18n.join("fr.json").exists());
        assert_eq!(fs::read_dir(&i18n).unwrap().count(), 1);
    }

    #[test]
    fn lost_post_commit_observation_is_unknown_and_keeps_the_written_file() {
        let directory = tempfile::tempdir().unwrap();
        let i18n = directory.path().join("i18n");
        fs::create_dir(&i18n).unwrap();
        let bytes = b"{\"hello\":\"world\"}";
        let file = preview("absent", None, bytes);
        let target = i18n.join("zh.json");
        let result = export_one_with_digest(&i18n, &file, bytes, false, |path| {
            if path == target && path.exists() {
                Err(CommandError::simple(
                    CommandErrorCode::StorageFailed,
                    CommandStage::ExecutionRead,
                ))
            } else {
                current_digest(path)
            }
        })
        .unwrap();
        assert_eq!(result.state, "unknown");
        assert!(result.actual_sha256.is_none());
        assert_eq!(fs::read(target).unwrap(), bytes);
        assert_eq!(fs::read_dir(&i18n).unwrap().count(), 1);
        let reconciled = observe_delivery_files(&i18n, vec![result.clone()]).unwrap();
        assert_eq!(reconciled[0].state, "succeeded");
        assert_eq!(
            reconciled[0].actual_sha256.as_deref(),
            Some(file.expected_sha256.as_str())
        );
        fs::remove_file(i18n.join("zh.json")).unwrap();
        let missing = observe_delivery_files(&i18n, vec![result]).unwrap();
        assert_eq!(missing[0].state, "failed");
        assert!(missing[0].actual_sha256.is_none());
    }
}
