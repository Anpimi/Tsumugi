//! Native, session-scoped local export of an immutable verified release.
use super::*;
#[cfg(not(target_os = "macos"))]
use std::fs::OpenOptions;
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};
use tauri_plugin_dialog::DialogExt;
#[cfg(any(test, feature = "execution-test-host"))]
use tsumugi_core::BuildLocaleChoice;
use tsumugi_core::content::artifact_digest;
use tsumugi_core::{DeliveryFile, DeliveryFileState, DeliveryState, DeliveryView, ReleaseView};

pub(in crate::commands) mod plugin;

#[derive(Default)]
pub(super) struct ReleaseSession {
    picker: Option<ExecutionId>,
    selection: Option<(ExecutionId, Arc<source::capture::Selection>)>,
    preview: Option<DeliveryPreview>,
    delivery: Option<(ExecutionId, Cancellation)>,
    pub(super) plugin: plugin::PluginBuildSession,
}
impl ReleaseSession {
    pub(super) fn stop_package(
        &mut self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) {
        self.plugin.stop_package(package);
        // Delivery of already saved releases does not execute the removed package.
    }
    #[cfg(test)]
    pub(super) fn select_for_test(
        &mut self,
        id: ExecutionId,
        selection: Arc<source::capture::Selection>,
    ) {
        self.selection = Some((id, selection));
    }

    pub(super) fn delivery_is_active(&self) -> bool {
        self.delivery.is_some()
    }
    pub(super) fn is_active(&self) -> bool {
        self.plugin.is_active() || self.delivery.is_some() || self.picker.is_some()
    }
    pub fn stop(&mut self) {
        if let Some((_, cancel)) = &self.delivery {
            cancel.request();
        }
        // Accepted file IO keeps its slot until its outcome is recorded.
        self.plugin.stop();
        self.picker = None;
        self.selection = None;
        self.preview = None;
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverySelection {
    pub selection_id: ExecutionId,
    pub folder_name: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PreviewFile {
    pub locale: String,
    pub file_name: String,
    pub expected_sha256: String,
    pub current_sha256: Option<String>,
    pub state: DeliveryPreviewState,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryPreviewState {
    Absent,
    Same,
    Conflict,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DeliveryPreview {
    pub preview_id: ExecutionId,
    pub release_id: ExecutionId,
    pub selection_id: ExecutionId,
    pub folder_name: String,
    pub files: Vec<PreviewFile>,
}
#[cfg(any(test, feature = "execution-test-host"))]
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] BuildRequest { attempt_id: ExecutionId, choices: Vec<BuildLocaleChoice>, expected_eligibility_basis: String });
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReleaseRequest {
        release_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PreviewRequest {
        release_id: ExecutionId,
        selection_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ExportRequest {
        release_id: ExecutionId,
        selection_id: ExecutionId,
        preview_id: ExecutionId,
        action_id: ExecutionId,
        overwrite_conflicts: bool
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReconcileRequest {
        action_id: ExecutionId,
        selection_id: ExecutionId
    }
);

fn mapped(error: ExecutionError, stage: CommandStage) -> CommandError {
    let result = map_execution(error, stage);
    result
}
fn invalid(stage: CommandStage, field: &str) -> CommandError {
    CommandError::invalid_input(stage, Some(field))
}

#[cfg(any(test, feature = "execution-test-host"))]
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

#[cfg(any(test, feature = "execution-test-host"))]
#[tauri::command]
pub async fn read_locale_build_attempt(
    state: State<'_, AppState>,
    request: BuildRequest,
) -> Result<Option<AttemptDetail>, CommandError> {
    state
        .sessions
        .run(
            "read_locale_build_attempt",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                if store
                    .find_locale_build(
                        request.project_id,
                        request.attempt_id,
                        &request.choices,
                        &request.expected_eligibility_basis,
                    )
                    .map_err(map_read)?
                    .is_none()
                {
                    return Ok(None);
                }
                attempt_detail(host, store, request.attempt_id, 0, 100).map(Some)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_delivery_action(
    state: State<'_, AppState>,
    request: ReconcileRequest,
) -> Result<Option<DeliveryView>, CommandError> {
    state
        .sessions
        .run(
            "read_delivery_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                let root = selected(host, request.selection_id)?.destination_path();
                let delivery = store
                    .delivery_by_action(request.action_id)
                    .map_err(map_read)?;
                if delivery
                    .as_ref()
                    .is_some_and(|value| value.directory != root.to_string_lossy())
                {
                    return Err(CommandError::simple(
                        CommandErrorCode::PermissionDenied,
                        CommandStage::ExecutionRead,
                    ));
                }
                Ok(delivery)
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
    let admitted = lease.submit(
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
            if host.release.delivery.is_some() || host.release.picker.is_some() {
                return Err(CommandError::simple(
                    CommandErrorCode::Busy,
                    CommandStage::ExecutionRead,
                ));
            }
            host.release.picker = Some(picker);
            Ok(())
        },
    )?;
    let dialogs = state.dialogs.clone();
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        admitted.await?;
        let selection = async {
            let selected = dialogs
                .run(CommandStage::ExecutionRead, move || {
                    Ok(app.dialog().file().blocking_pick_folder())
                })
                .await?;
            io.run(CommandStage::ExecutionRead, move || {
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
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

fn selected(
    host: &ExecutionHost,
    id: ExecutionId,
) -> Result<&Arc<source::capture::Selection>, CommandError> {
    host.release
        .selection
        .as_ref()
        .filter(|(current, _)| *current == id)
        .map(|(_, value)| value)
        .ok_or_else(|| {
            CommandError::simple(
                CommandErrorCode::SessionInvalid,
                CommandStage::ExecutionRead,
            )
        })
}

fn begin_delivery_job(
    host: &mut ExecutionHost,
) -> Result<(ExecutionId, Cancellation), CommandError> {
    host.allow_mutation()?;
    if host.release.delivery.is_some() || host.release.picker.is_some() {
        return Err(CommandError::simple(
            CommandErrorCode::Busy,
            CommandStage::ExecutionRead,
        ));
    }
    let job = ExecutionId::new();
    let cancel = Cancellation::default();
    host.release.delivery = Some((job, cancel.clone()));
    Ok((job, cancel))
}
fn finish_delivery_job<'a>(
    sessions: &'a mut SessionManager,
    token: &str,
    project: ExecutionId,
    job: ExecutionId,
    stage: CommandStage,
) -> Result<&'a mut ActiveSession, CommandError> {
    let active = authorized(sessions, token, project, stage)?;
    let (host, _) = active.execution_parts()?;
    if host.release.delivery.as_ref().map(|entry| entry.0) != Some(job) {
        return Err(CommandError::simple(
            CommandErrorCode::SessionInvalid,
            stage,
        ));
    }
    host.release.delivery = None;
    Ok(active)
}
fn current_digest(
    destination: &source::capture::Destination<'_>,
    path: &Path,
) -> Result<Option<String>, CommandError> {
    destination
        .read_file(path)
        .map(|bytes| bytes.map(|bytes| artifact_digest(&bytes)))
        .map_err(map_read)
}
fn selected_digest(
    selection: &source::capture::Selection,
    path: &str,
) -> Result<Option<String>, CommandError> {
    match selection.destination(path, false).map_err(map_read)? {
        Some(destination) => current_digest(&destination, destination.path()),
        None => Ok(None),
    }
}
fn preview_files(
    selection: &source::capture::Selection,
    release: ReleaseView,
) -> Result<Vec<PreviewFile>, CommandError> {
    selection.destination_root().map_err(map_read)?;
    release
        .artifacts
        .into_iter()
        .map(|artifact| {
            let current_sha256 = selected_digest(selection, &artifact.file_name)?;
            let state = match &current_sha256 {
                None => DeliveryPreviewState::Absent,
                Some(current) if *current == artifact.sha256 => DeliveryPreviewState::Same,
                Some(_) => DeliveryPreviewState::Conflict,
            };
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
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "preview_delivery.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (host, store) = active.execution_parts()?;
            let selection = selected(host, initial.selection_id)?.clone();
            let release = store.release_view(initial.release_id).map_err(map_read)?;
            let (job, cancel) = begin_delivery_job(host)?;
            // An accepted refresh supersedes the prior preview, including on failure.
            host.release.preview = None;
            Ok((job, cancel, selection, release))
        },
    )?;
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        let (job, cancel, selection, release) = admitted.await?;
        let folder_name = selection.label();
        let files = io
            .run(CommandStage::ExecutionRead, move || {
                if cancel.is_requested() {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::Cancelled,
                        "cancelled",
                    )));
                }
                let files = preview_files(&selection, release)?;
                if cancel.is_requested() {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::Cancelled,
                        "cancelled",
                    )));
                }
                Ok(files)
            })
            .await;
        lease
            .run(
                "preview_delivery.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = finish_delivery_job(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        job,
                        CommandStage::ExecutionRead,
                    )?;
                    let (host, _) = active.execution_parts()?;
                    host.allow_mutation()?;
                    selected(host, request.selection_id)?;
                    let preview = DeliveryPreview {
                        preview_id: ExecutionId::new(),
                        release_id: request.release_id,
                        selection_id: request.selection_id,
                        folder_name,
                        files: files?,
                    };
                    host.release.preview = Some(preview.clone());
                    Ok(preview)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path, overwrite: bool) -> std::io::Result<()> {
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
            MOVEFILE_WRITE_THROUGH
                | if overwrite {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                },
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(any(windows, target_os = "macos")))]
fn replace_file(_: &Path, _: &Path, _: bool) -> std::io::Result<()> {
    Err(std::io::Error::other("unsupported-platform"))
}

#[cfg(target_os = "macos")]
fn commit_macos(
    directory: &File,
    source: &Path,
    target: &Path,
    overwrite: bool,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let name = |path: &Path| {
        source::capture::platform::name(path.file_name().unwrap())
            .map_err(|_| std::io::Error::other("invalid-name"))
    };
    let from = name(source)?;
    let to = name(target)?;
    // Both names belong to the same verified directory. EXCL prevents overwriting
    // a file created after an absent-target preview.
    if unsafe {
        libc::renameatx_np(
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
            if overwrite { 0 } else { libc::RENAME_EXCL },
        )
    } == -1
    {
        return Err(std::io::Error::last_os_error());
    }
    directory.sync_all()
}

#[cfg(target_os = "macos")]
fn create_macos_output(directory: &File, name: &std::ffi::OsStr) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name =
        source::capture::platform::name(name).map_err(|_| std::io::Error::other("invalid-name"))?;
    // Fresh owner-only output in the held destination directory.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
#[cfg(target_os = "macos")]
fn remove_macos_output(directory: &File, name: &std::ffi::OsStr) {
    use std::os::fd::AsRawFd;
    if let Ok(name) = source::capture::platform::name(name) {
        // Only the fresh task-owned temporary name in this held directory.
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0);
        }
    }
}

#[cfg(test)]
fn export_one(
    selection: &source::capture::Selection,
    file: &PreviewFile,
    bytes: &[u8],
    overwrite: bool,
) -> Result<DeliveryFile, CommandError> {
    export_one_with_digest(selection, file, bytes, overwrite, current_digest)
}

#[cfg(test)]
fn export_one_with_digest(
    selection: &source::capture::Selection,
    file: &PreviewFile,
    bytes: &[u8],
    overwrite: bool,
    digest: impl Fn(&source::capture::Destination<'_>, &Path) -> Result<Option<String>, CommandError>,
) -> Result<DeliveryFile, CommandError> {
    export_one_with_checks(
        selection,
        file,
        bytes,
        overwrite,
        digest,
        &Cancellation::default(),
    )
}
fn export_one_with_checks(
    selection: &source::capture::Selection,
    file: &PreviewFile,
    bytes: &[u8],
    overwrite: bool,
    digest: impl Fn(&source::capture::Destination<'_>, &Path) -> Result<Option<String>, CommandError>,
    cancel: &Cancellation,
) -> Result<DeliveryFile, CommandError> {
    if cancel.is_requested() {
        return Err(map_adopt(ExecutionError::new(
            ErrorCode::Cancelled,
            "cancelled",
        )));
    }
    let destination = selection
        .destination(&file.file_name, true)
        .map_err(map_adopt)?
        .ok_or_else(|| invalid(CommandStage::ExecutionAdopt, "delivery-file"))?;
    #[cfg(target_os = "macos")]
    let directory = destination.directory();
    let target = destination.path();
    let current = digest(&destination, target)?;
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
            state: DeliveryFileState::Succeeded,
        });
    }
    if current.is_some() && !overwrite {
        return Err(CommandError::simple(
            CommandErrorCode::DestinationConflict,
            CommandStage::ExecutionAdopt,
        ));
    }
    let temporary = target
        .parent()
        .unwrap()
        .join(format!(".tsumugi-{}.tmp", ExecutionId::new()));
    #[cfg(target_os = "macos")]
    let opened = create_macos_output(&directory, temporary.file_name().unwrap());
    #[cfg(not(target_os = "macos"))]
    let opened = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary);
    let mut output = opened.map_err(|_| {
        CommandError::simple(
            CommandErrorCode::StorageFailed,
            CommandStage::ExecutionAdopt,
        )
    })?;
    let write = output.write_all(bytes).and_then(|_| output.sync_all());
    drop(output);
    let temporary_digest = digest(&destination, &temporary);
    if write.is_err()
        || !matches!(temporary_digest, Ok(Some(ref value)) if value == &file.expected_sha256)
    {
        #[cfg(target_os = "macos")]
        remove_macos_output(&directory, temporary.file_name().unwrap());
        #[cfg(not(target_os = "macos"))]
        let _ = fs::remove_file(&temporary);
        return Err(CommandError::simple(
            CommandErrorCode::StorageFailed,
            CommandStage::ExecutionAdopt,
        ));
    }
    let fresh = if cancel.is_requested() {
        Err(map_adopt(ExecutionError::new(
            ErrorCode::Cancelled,
            "cancelled",
        )))
    } else {
        digest(&destination, target)
    };
    if !matches!(&fresh, Ok(value) if value == &current) {
        #[cfg(target_os = "macos")]
        remove_macos_output(&directory, temporary.file_name().unwrap());
        #[cfg(not(target_os = "macos"))]
        let _ = fs::remove_file(&temporary);
        return Err(match fresh {
            Ok(_) => CommandError::simple(
                CommandErrorCode::DestinationConflict,
                CommandStage::ExecutionAdopt,
            ),
            Err(error) => error,
        });
    }
    if cancel.is_requested() {
        #[cfg(target_os = "macos")]
        remove_macos_output(directory, temporary.file_name().unwrap());
        #[cfg(not(target_os = "macos"))]
        let _ = fs::remove_file(&temporary);
        return Err(map_adopt(ExecutionError::new(
            ErrorCode::Cancelled,
            "cancelled",
        )));
    }
    let commit = if destination.verify().is_err() {
        Err(std::io::Error::other("destination-changed"))
    } else {
        #[cfg(target_os = "macos")]
        let result = commit_macos(directory, &temporary, target, current.is_some());
        #[cfg(not(target_os = "macos"))]
        let result = replace_file(&temporary, target, current.is_some());
        result
    };
    if commit.is_err() {
        #[cfg(target_os = "macos")]
        remove_macos_output(&directory, temporary.file_name().unwrap());
        #[cfg(not(target_os = "macos"))]
        let _ = fs::remove_file(&temporary);
    }
    let observed = digest(&destination, target);
    let observed = if destination.verify().is_ok() {
        observed
    } else {
        Err(CommandError::simple(
            CommandErrorCode::OutcomeUnknown,
            CommandStage::ExecutionAdopt,
        ))
    };
    let state = match &observed {
        Ok(Some(value)) if value == &file.expected_sha256 => DeliveryFileState::Succeeded,
        Ok(_) if commit.is_err() => DeliveryFileState::Failed,
        _ => DeliveryFileState::Unknown,
    };
    let actual = observed.ok().flatten();
    Ok(DeliveryFile {
        locale: file.locale.clone(),
        file_name: file.file_name.clone(),
        expected_sha256: file.expected_sha256.clone(),
        actual_sha256: actual,
        state,
    })
}

struct ExportCapture {
    selection: Arc<source::capture::Selection>,
    release: ReleaseView,
    preview: DeliveryPreview,
    bytes: Vec<Vec<u8>>,
    overwrite: bool,
}
struct ExportOutcome {
    files: Vec<DeliveryFile>,
    error: Option<CommandError>,
}
fn unobserved_files(files: &[PreviewFile], state: DeliveryFileState) -> Vec<DeliveryFile> {
    files
        .iter()
        .map(|file| DeliveryFile {
            locale: file.locale.clone(),
            file_name: file.file_name.clone(),
            expected_sha256: file.expected_sha256.clone(),
            actual_sha256: None,
            state,
        })
        .collect()
}
impl ExportCapture {
    fn perform(self, cancel: &Cancellation) -> ExportOutcome {
        // A full read-only recheck precedes the first directory or file write.
        let fresh = preview_files(&self.selection, self.release);
        let error = match &fresh {
            Ok(files) if *files == self.preview.files => None,
            Ok(_) => Some(CommandError::simple(
                CommandErrorCode::DestinationConflict,
                CommandStage::ExecutionAdopt,
            )),
            Err(error) => Some(error.clone()),
        };
        if let Some(error) = error {
            let mut files = unobserved_files(&self.preview.files, DeliveryFileState::Failed);
            if let Ok(fresh) = fresh {
                for file in &mut files {
                    file.actual_sha256 = fresh
                        .iter()
                        .find(|current| {
                            current.locale == file.locale && current.file_name == file.file_name
                        })
                        .and_then(|current| current.current_sha256.clone());
                }
            }
            return ExportOutcome {
                files,
                error: Some(error),
            };
        }
        let files = self
            .preview
            .files
            .iter()
            .zip(self.bytes)
            .map(|(file, bytes)| {
                let result = if cancel.is_requested() {
                    Err(map_adopt(ExecutionError::new(
                        ErrorCode::Cancelled,
                        "cancelled",
                    )))
                } else {
                    export_one_with_checks(
                        &self.selection,
                        file,
                        &bytes,
                        self.overwrite,
                        current_digest,
                        cancel,
                    )
                };
                result.unwrap_or_else(|_| DeliveryFile {
                    locale: file.locale.clone(),
                    file_name: file.file_name.clone(),
                    expected_sha256: file.expected_sha256.clone(),
                    actual_sha256: None,
                    state: DeliveryFileState::Failed,
                })
            })
            .collect();
        ExportOutcome { files, error: None }
    }
}

#[tauri::command]
pub async fn export_release(
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<DeliveryView, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionAdopt)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "export_release.begin",
        CommandStage::ExecutionAdopt,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionAdopt,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let selection = selected(host, initial.selection_id)?.clone();
            let directory = selection.destination_path().to_string_lossy().into_owned();
            if let Some(existing) = store
                .delivery_by_action(initial.action_id)
                .map_err(map_adopt)?
            {
                if existing.release_id != initial.release_id
                    || existing.directory != directory
                    || existing.overwrite_conflicts != initial.overwrite_conflicts
                {
                    return Err(CommandError::simple(
                        CommandErrorCode::DependencyConflict,
                        CommandStage::ExecutionAdopt,
                    ));
                }
                if existing.state == DeliveryState::Pending {
                    return Err(CommandError::simple(
                        CommandErrorCode::OutcomeUnknown,
                        CommandStage::ExecutionAdopt,
                    ));
                }
                return Ok(Err(existing));
            }
            if host.release.delivery.is_some() || host.release.picker.is_some() {
                return Err(CommandError::simple(
                    CommandErrorCode::Busy,
                    CommandStage::ExecutionAdopt,
                ));
            }
            let preview = host
                .release
                .preview
                .as_ref()
                .filter(|item| {
                    item.preview_id == initial.preview_id
                        && item.release_id == initial.release_id
                        && item.selection_id == initial.selection_id
                })
                .cloned()
                .ok_or_else(|| {
                    CommandError::simple(
                        CommandErrorCode::DependencyConflict,
                        CommandStage::ExecutionAdopt,
                    )
                })?;
            if !initial.overwrite_conflicts
                && preview
                    .files
                    .iter()
                    .any(|file| file.state == DeliveryPreviewState::Conflict)
            {
                return Err(CommandError::simple(
                    CommandErrorCode::DestinationConflict,
                    CommandStage::ExecutionAdopt,
                ));
            }
            let release = store.release_view(initial.release_id).map_err(map_adopt)?;
            let bytes = preview
                .files
                .iter()
                .map(|file| {
                    let (artifact, bytes) = store
                        .release_artifact_by_path(initial.release_id, &file.locale, &file.file_name)
                        .map_err(map_adopt)?;
                    if artifact.sha256 != file.expected_sha256 {
                        return Err(CommandError::simple(
                            CommandErrorCode::DependencyConflict,
                            CommandStage::ExecutionAdopt,
                        ));
                    }
                    Ok(bytes)
                })
                .collect::<Result<Vec<_>, CommandError>>()?;
            store
                .begin_delivery(
                    initial.action_id,
                    initial.release_id,
                    &directory,
                    initial.overwrite_conflicts,
                )
                .map_err(map_adopt)?;
            let (job, cancel) = begin_delivery_job(host)?;
            host.release.preview = None;
            Ok(Ok((
                job,
                cancel,
                ExportCapture {
                    selection,
                    release,
                    preview,
                    bytes,
                    overwrite: initial.overwrite_conflicts,
                },
            )))
        },
    )?;
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        let (job, cancel, capture) = match admitted.await? {
            Ok(work) => work,
            Err(existing) => return Ok(existing),
        };
        let expected = capture.preview.files.clone();
        let result = io
            .run(CommandStage::ExecutionAdopt, move || {
                Ok(capture.perform(&cancel))
            })
            .await;
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => ExportOutcome {
                files: unobserved_files(
                    &expected,
                    if error.code == CommandErrorCode::Busy {
                        DeliveryFileState::Failed
                    } else {
                        DeliveryFileState::Unknown
                    },
                ),
                error: Some(error),
            },
        };
        lease
            .run(
                "export_release.finish",
                CommandStage::ExecutionAdopt,
                move |sessions| {
                    let active = finish_delivery_job(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        job,
                        CommandStage::ExecutionAdopt,
                    )?;
                    // Persist already accepted external effects even while quiescing.
                    // The project cannot close until this owned continuation releases its slot.
                    let delivery = active
                        .store
                        .finish_delivery(request.action_id, outcome.files)
                        .map_err(|error| {
                            // External bytes may already be committed. The durable
                            // pending action, rather than a blind write retry, owns recovery.
                            let mut error = map_adopt(error);
                            error.code = CommandErrorCode::OutcomeUnknown;
                            error.recovery_required = true;
                            error
                        })?;
                    match outcome.error {
                        Some(error) => Err(error),
                        None => Ok(delivery),
                    }
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
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
    selection: &source::capture::Selection,
    files: Vec<DeliveryFile>,
) -> Result<Vec<DeliveryFile>, CommandError> {
    selection.destination_root().map_err(map_read)?;
    files
        .into_iter()
        .map(|mut file| {
            if file.state != DeliveryFileState::Pending && file.state != DeliveryFileState::Unknown
            {
                return Ok(file);
            }
            let observation = selected_digest(selection, &file.file_name);
            file.state = match &observation {
                Ok(Some(value)) if *value == file.expected_sha256 => DeliveryFileState::Succeeded,
                Ok(None) => DeliveryFileState::Failed,
                _ => DeliveryFileState::Unknown,
            };
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
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "reconcile_delivery.begin",
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
            let selection = selected(host, initial.selection_id)?.clone();
            let current = store
                .delivery_by_action(initial.action_id)
                .map_err(map_recover)?
                .ok_or_else(|| invalid(CommandStage::ExecutionRecover, "delivery-action"))?;
            if current.directory != selection.destination_path().to_string_lossy() {
                return Err(CommandError::simple(
                    CommandErrorCode::PermissionDenied,
                    CommandStage::ExecutionRecover,
                ));
            }
            if !matches!(
                current.state,
                DeliveryState::Pending | DeliveryState::Unknown
            ) {
                return Ok(Err(current));
            }
            let (job, cancel) = begin_delivery_job(host)?;
            Ok(Ok((job, cancel, selection, current)))
        },
    )?;
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        let (job, cancel, selection, current) = match admitted.await? {
            Ok(work) => work,
            Err(existing) => return Ok(existing),
        };
        let files = io
            .run(CommandStage::ExecutionRecover, move || {
                if cancel.is_requested() {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::Cancelled,
                        "cancelled",
                    )));
                }
                observe_delivery_files(&selection, current.files)
            })
            .await;
        lease
            .run(
                "reconcile_delivery.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active = finish_delivery_job(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        job,
                        CommandStage::ExecutionRecover,
                    )?;
                    active
                        .store
                        .reconcile_delivery(request.action_id, files?)
                        .map_err(map_recover)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}

#[cfg(test)]
mod contracts {
    use super::*;

    #[test]
    fn release_wire_fixture_matches_actual_rust_requests_and_responses() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/releaseCommands.contract.json"
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
        round_trip!("requests", "release", ReleaseRequest);
        round_trip!("requests", "preview", PreviewRequest);
        round_trip!("requests", "export", ExportRequest);
        round_trip!("requests", "reconcile", ReconcileRequest);
        round_trip!("responses", "identity", ExecutionId);
        round_trip!("responses", "deliveryAction", Option<DeliveryView>);
        assert!(
            serde_json::from_value::<Option<AttemptDetail>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        assert!(
            serde_json::from_value::<Option<DeliveryView>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        round_trip!("responses", "releases", Vec<ReleaseView>);
        round_trip!("responses", "selection", Option<DeliverySelection>);
        round_trip!("responses", "preview", DeliveryPreview);
        round_trip!("responses", "delivery", DeliveryView);
        round_trip!("responses", "deliveries", Vec<DeliveryView>);
        assert!(
            serde_json::from_value::<Option<DeliverySelection>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        let mut value = fixture["responses"]["delivery"].clone();
        value["state"] = serde_json::json!("completed");
        assert!(serde_json::from_value::<DeliveryView>(value).is_err());
        let mut value = fixture["responses"]["delivery"].clone();
        value["files"][0]["state"] = serde_json::json!("partial");
        assert!(serde_json::from_value::<DeliveryView>(value).is_err());
        let mut value = fixture["responses"]["preview"].clone();
        value["files"][0]["state"] = serde_json::json!("unknown");
        assert!(serde_json::from_value::<DeliveryPreview>(value).is_err());
        let mut value = fixture["responses"]["releases"][0].clone();
        value["exceptions"][0]["kind"] = serde_json::json!("approved");
        assert!(serde_json::from_value::<ReleaseView>(value).is_err());
        let mut value = fixture["responses"]["releases"][0].clone();
        value["artifacts"][0]["entryCount"] = serde_json::json!(4294967296u64);
        assert!(serde_json::from_value::<ReleaseView>(value).is_err());
        let mut value = fixture["responses"]["delivery"].clone();
        value.as_object_mut().unwrap().remove("files");
        assert!(serde_json::from_value::<DeliveryView>(value).is_err());
    }
}

#[cfg(all(test, any(windows, target_os = "macos")))]
mod tests {
    use super::*;
    #[test]
    fn webvtt_delivery_uses_verified_root_file_and_keeps_conflict_checks() {
        let root = tempfile::tempdir().unwrap();
        let selection = source::capture::Selection::authorize(root.path().to_path_buf()).unwrap();
        let bytes = include_bytes!(
            "../../../../../../crates/core/tests/fixtures/webvtt/expected-zh-CN.vtt"
        );
        let file = PreviewFile {
            locale: "zh-CN".into(),
            file_name: "zh-CN.vtt".into(),
            expected_sha256: artifact_digest(bytes),
            current_sha256: None,
            state: DeliveryPreviewState::Absent,
        };
        assert_eq!(
            export_one(&selection, &file, bytes, false).unwrap().state,
            DeliveryFileState::Succeeded
        );
        assert_eq!(fs::read(root.path().join("zh-CN.vtt")).unwrap(), bytes);
        assert!(!root.path().join("i18n").exists());
        assert!(export_one(&selection, &file, bytes, true).is_err());
        let same = PreviewFile {
            current_sha256: Some(artifact_digest(bytes)),
            state: DeliveryPreviewState::Same,
            ..file
        };
        assert_eq!(
            export_one(&selection, &same, bytes, false).unwrap().state,
            DeliveryFileState::Succeeded
        );
        assert!(selection.destination("../zh-CN.vtt", true).is_err());
    }

    fn preview(
        state: DeliveryPreviewState,
        current_sha256: Option<String>,
        bytes: &[u8],
    ) -> PreviewFile {
        PreviewFile {
            locale: "zh-CN".into(),
            file_name: "i18n/zh.json".into(),
            expected_sha256: artifact_digest(bytes),
            current_sha256,
            state,
        }
    }

    #[test]
    fn local_export_checks_conflicts_bytes_and_explicit_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let selection =
            source::capture::Selection::authorize(directory.path().to_path_buf()).unwrap();
        let i18n = directory.path().join("i18n");
        fs::create_dir(&i18n).unwrap();
        let bytes = b"{\n  \"hello\": \"world\"\n}\n";
        let absent = preview(DeliveryPreviewState::Absent, None, bytes);
        let first = export_one(&selection, &absent, bytes, false).unwrap();
        assert_eq!(first.state, DeliveryFileState::Succeeded);
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), bytes);
        assert_eq!(
            export_one(&selection, &absent, bytes, false)
                .unwrap_err()
                .code,
            CommandErrorCode::DestinationConflict
        );
        let same = preview(
            DeliveryPreviewState::Same,
            Some(artifact_digest(bytes)),
            bytes,
        );
        assert_eq!(
            export_one(&selection, &same, bytes, false).unwrap().state,
            DeliveryFileState::Succeeded
        );
        fs::write(i18n.join("zh.json"), b"different").unwrap();
        assert_eq!(
            export_one(&selection, &same, bytes, true).unwrap_err().code,
            CommandErrorCode::DestinationConflict
        );
        let different = preview(
            DeliveryPreviewState::Conflict,
            Some(artifact_digest(b"different")),
            bytes,
        );
        assert_eq!(
            export_one(&selection, &different, bytes, false)
                .unwrap_err()
                .code,
            CommandErrorCode::DestinationConflict
        );
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), b"different");
        assert_eq!(
            export_one(&selection, &different, bytes, true)
                .unwrap()
                .state,
            DeliveryFileState::Succeeded
        );
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), bytes);
    }

    #[test]
    fn second_locale_failure_preserves_first_file_and_removes_temp_output() {
        let directory = tempfile::tempdir().unwrap();
        let selection =
            source::capture::Selection::authorize(directory.path().to_path_buf()).unwrap();
        let i18n = directory.path().join("i18n");
        fs::create_dir(&i18n).unwrap();
        let zh = b"{\"hello\":\"zh\"}";
        let fr = b"{\"hello\":\"fr\"}";
        let first = preview(DeliveryPreviewState::Absent, None, zh);
        let second = PreviewFile {
            locale: "fr-FR".into(),
            file_name: "i18n/fr.json".into(),
            expected_sha256: artifact_digest(fr),
            current_sha256: None,
            state: DeliveryPreviewState::Absent,
        };
        assert_eq!(
            export_one(&selection, &first, zh, false).unwrap().state,
            DeliveryFileState::Succeeded
        );
        assert!(export_one(&selection, &second, b"bad bytes", false).is_err());
        assert_eq!(fs::read(i18n.join("zh.json")).unwrap(), zh);
        assert!(!i18n.join("fr.json").exists());
        assert_eq!(fs::read_dir(&i18n).unwrap().count(), 1);
    }

    #[test]
    fn lost_post_commit_observation_is_unknown_and_keeps_the_written_file() {
        let directory = tempfile::tempdir().unwrap();
        let selection =
            source::capture::Selection::authorize(directory.path().to_path_buf()).unwrap();
        let i18n = directory.path().join("i18n");
        fs::create_dir(&i18n).unwrap();
        let bytes = b"{\"hello\":\"world\"}";
        let file = preview(DeliveryPreviewState::Absent, None, bytes);
        let target = selection.destination_path().join("i18n/zh.json");
        let result =
            export_one_with_digest(&selection, &file, bytes, false, |destination, path| {
                if path == target && path.exists() {
                    Err(CommandError::simple(
                        CommandErrorCode::StorageFailed,
                        CommandStage::ExecutionRead,
                    ))
                } else {
                    current_digest(destination, path)
                }
            })
            .unwrap();
        assert_eq!(result.state, DeliveryFileState::Unknown);
        assert!(result.actual_sha256.is_none());
        assert_eq!(fs::read(target).unwrap(), bytes);
        assert_eq!(fs::read_dir(&i18n).unwrap().count(), 1);
        let reconciled = observe_delivery_files(&selection, vec![result.clone()]).unwrap();
        assert_eq!(reconciled[0].state, DeliveryFileState::Succeeded);
        assert_eq!(
            reconciled[0].actual_sha256.as_deref(),
            Some(file.expected_sha256.as_str())
        );
        fs::remove_file(i18n.join("zh.json")).unwrap();
        let missing = observe_delivery_files(&selection, vec![result]).unwrap();
        assert_eq!(missing[0].state, DeliveryFileState::Failed);
        assert!(missing[0].actual_sha256.is_none());
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn macos_export_preserves_late_files_and_rejects_linked_targets() {
        use std::{cell::Cell, os::unix::fs::symlink};
        let root = tempfile::tempdir().unwrap();
        let selection = source::capture::Selection::authorize(root.path().to_path_buf()).unwrap();
        let bytes = b"verified";
        let file = PreviewFile {
            locale: "zh-CN".into(),
            file_name: "zh-CN.vtt".into(),
            expected_sha256: artifact_digest(bytes),
            current_sha256: None,
            state: DeliveryPreviewState::Absent,
        };
        let target = selection.destination_path().join("zh-CN.vtt");
        let calls = Cell::new(0);
        let result =
            export_one_with_digest(&selection, &file, bytes, false, |destination, path| {
                let result = current_digest(destination, path);
                if path == target {
                    calls.set(calls.get() + 1);
                    if calls.get() == 2 {
                        fs::write(&target, b"external update").unwrap();
                    }
                }
                result
            })
            .unwrap();
        assert_eq!(result.state, DeliveryFileState::Failed);
        assert_eq!(fs::read(&target).unwrap(), b"external update");
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("protected"), b"protected").unwrap();
        fs::remove_file(&target).unwrap();
        symlink(outside.path().join("protected"), &target).unwrap();
        assert!(export_one(&selection, &file, bytes, true).is_err());
        assert_eq!(
            fs::read(outside.path().join("protected")).unwrap(),
            b"protected"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn generic_nested_empty_and_large_artifacts_use_the_sdk_bound() {
        let root = tempfile::tempdir().unwrap();
        let selection = source::capture::Selection::authorize(root.path().to_path_buf()).unwrap();
        assert!(
            selected_digest(&selection, "bundle/zh/content.data")
                .unwrap()
                .is_none()
        );
        assert!(!root.path().join("bundle").exists());
        for (name, bytes) in [
            ("empty.data", vec![]),
            ("bundle/zh/content.data", vec![b'x'; 1024 * 1024 + 17]),
        ] {
            let file = PreviewFile {
                locale: "zh-CN".into(),
                file_name: name.into(),
                expected_sha256: artifact_digest(&bytes),
                current_sha256: None,
                state: DeliveryPreviewState::Absent,
            };
            assert_eq!(
                export_one(&selection, &file, &bytes, false).unwrap().state,
                DeliveryFileState::Succeeded
            );
            assert_eq!(fs::read(root.path().join(name)).unwrap(), bytes);
            assert_eq!(
                selected_digest(&selection, name).unwrap().as_deref(),
                Some(file.expected_sha256.as_str())
            );
        }
        for path in [
            "../outside",
            "a/../outside",
            "/outside",
            "a\\outside",
            "a//b",
            "a/CON.txt",
        ] {
            assert!(selection.destination(path, true).is_err(), "{path}");
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
        fs::write(
            root.path().join("too-large.data"),
            vec![b'x'; tsumugi_plugin_sdk::MAX_EXCHANGE_BYTES + 1],
        )
        .unwrap();
        assert_eq!(
            selected_digest(&selection, "too-large.data")
                .unwrap_err()
                .code,
            CommandErrorCode::LimitExceeded
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn held_nested_directories_reject_replacement_and_links_without_outside_writes() {
        use std::{cell::Cell, os::unix::fs::symlink};
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let selection = source::capture::Selection::authorize(root.path().to_path_buf()).unwrap();
        let bytes = b"captured";
        let file = PreviewFile {
            locale: "zh-CN".into(),
            file_name: "bundle/zh/content.data".into(),
            expected_sha256: artifact_digest(bytes),
            current_sha256: None,
            state: DeliveryPreviewState::Absent,
        };
        let replaced = Cell::new(false);
        let result =
            export_one_with_digest(&selection, &file, bytes, false, |destination, path| {
                let value = current_digest(destination, path);
                if path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with(".tmp")
                    && !replaced.replace(true)
                {
                    fs::rename(root.path().join("bundle/zh"), root.path().join("moved")).unwrap();
                    symlink(outside.path(), root.path().join("bundle/zh")).unwrap();
                }
                value
            });
        assert!(result.is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(
            fs::read_dir(root.path().join("moved")).unwrap().count(),
            0,
            "owned temp removed through held descriptor"
        );
        assert!(selected_digest(&selection, "bundle/zh/content.data").is_err());
        assert!(export_one(&selection, &file, bytes, true).is_err());
    }

    #[test]
    fn cancellation_before_commit_removes_temporary_bytes_and_preserves_target() {
        let root = tempfile::tempdir().unwrap();
        let selection = source::capture::Selection::authorize(root.path().to_path_buf()).unwrap();
        let cancel = Cancellation::default();
        let bytes = b"captured";
        let file = PreviewFile {
            locale: "zh-CN".into(),
            file_name: "nested/content.data".into(),
            expected_sha256: artifact_digest(bytes),
            current_sha256: None,
            state: DeliveryPreviewState::Absent,
        };
        let result = export_one_with_checks(
            &selection,
            &file,
            bytes,
            false,
            |destination, path| {
                let value = current_digest(destination, path);
                if path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with(".tmp")
                {
                    cancel.request();
                }
                value
            },
            &cancel,
        );
        assert_eq!(result.unwrap_err().code, CommandErrorCode::Cancelled);
        assert!(!root.path().join("nested/content.data").exists());
        assert_eq!(fs::read_dir(root.path().join("nested")).unwrap().count(), 0);
    }

    #[test]
    fn quiescing_delivery_keeps_its_owned_job_until_outcome_commit() {
        let root = tempfile::tempdir().unwrap();
        let mut sessions = SessionManager::default();
        let view = sessions
            .create(CreateProjectRequest {
                destination: root.path().join("project").to_string_lossy().into(),
                display_name: "Delivery lifecycle".into(),
                source_locale: "en".into(),
                target_locales: vec!["zh-CN".into()],
            })
            .unwrap();
        let project = ExecutionId::parse(&view.metadata.project_id).unwrap();
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        let (job, cancel) = begin_delivery_job(host).unwrap();
        assert!(begin_delivery_job(host).is_err());
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.begin_quiesce(store).unwrap();
        assert!(cancel.is_requested());
        assert!(host.active(store).unwrap());
        assert_eq!(
            host.finish_quiesce(store).unwrap_err().code,
            ErrorCode::Busy
        );
        assert!(
            finish_delivery_job(
                &mut sessions,
                &view.session_token,
                project,
                ExecutionId::new(),
                CommandStage::ExecutionAdopt
            )
            .is_err()
        );
        assert!(
            sessions
                .close(CloseProjectRequest {
                    session_token: view.session_token.clone()
                })
                .is_err()
        );
        finish_delivery_job(
            &mut sessions,
            &view.session_token,
            project,
            job,
            CommandStage::ExecutionAdopt,
        )
        .unwrap();
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.tick(store).unwrap();
        assert!(!host.active(store).unwrap());
        sessions
            .close(CloseProjectRequest {
                session_token: view.session_token,
            })
            .unwrap();
    }
    #[test]
    fn native_picker_blocks_conflicting_work_until_cancelled() {
        let root = tempfile::tempdir().unwrap();
        let mut sessions = SessionManager::default();
        let view = sessions
            .create(CreateProjectRequest {
                destination: root.path().join("project").to_string_lossy().into(),
                display_name: "Picker lifecycle".into(),
                source_locale: "en".into(),
                target_locales: vec!["zh-CN".into()],
            })
            .unwrap();
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.release.picker = Some(ExecutionId::new());
        assert!(host.active(store).unwrap());
        assert!(
            matches!(begin_delivery_job(host), Err(error) if error.code == CommandErrorCode::Busy)
        );
        assert!(
            sessions
                .close(CloseProjectRequest {
                    session_token: view.session_token.clone()
                })
                .is_err()
        );
        let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.begin_quiesce(store).unwrap();
        host.tick(store).unwrap();
        assert!(!host.active(store).unwrap());
        sessions
            .close(CloseProjectRequest {
                session_token: view.session_token,
            })
            .unwrap();
    }
}
