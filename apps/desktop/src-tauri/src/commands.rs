use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::State;
use tsumugi_core::{
    ChangeOutcome, MetadataError, MetadataField, PersistenceError, PersistenceStage, ProjectId,
    ProjectMetadata, ProjectStore, Reconciliation,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandErrorCode {
    InvalidInput,
    DestinationConflict,
    MissingProject,
    PermissionDenied,
    UnsupportedSchema,
    CorruptProject,
    StaleRevision,
    SessionInvalid,
    ProjectInUse,
    Busy,
    StorageFailed,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandStage {
    Create,
    Open,
    Read,
    Rename,
    AddTargetLocale,
    SetTargetLocales,
    Close,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: CommandErrorCode,
    pub stage: CommandStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
    pub recovery_required: bool,
}

impl CommandError {
    fn simple(code: CommandErrorCode, stage: CommandStage) -> Self {
        Self {
            code,
            stage,
            field: None,
            current_revision: None,
            recovery_required: false,
        }
    }

    fn invalid_input(stage: CommandStage, field: Option<&str>) -> Self {
        Self {
            code: CommandErrorCode::InvalidInput,
            stage,
            field: field.map(str::to_owned),
            current_revision: None,
            recovery_required: false,
        }
    }

    fn stale(stage: CommandStage, current_revision: u64) -> Self {
        Self {
            code: CommandErrorCode::StaleRevision,
            stage,
            field: None,
            current_revision: Some(current_revision.to_string()),
            recovery_required: false,
        }
    }

    fn unknown(stage: CommandStage) -> Self {
        Self {
            code: CommandErrorCode::OutcomeUnknown,
            stage,
            field: None,
            current_revision: None,
            recovery_required: true,
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?} at {:?}", self.code, self.stage)
    }
}

impl std::error::Error for CommandError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub destination: String,
    pub display_name: String,
    pub source_locale: String,
    pub target_locales: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectRequest {
    pub locator: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadProjectRequest {
    pub session_token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectRequest {
    pub session_token: String,
    pub expected_revision: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTargetLocaleRequest {
    pub session_token: String,
    pub expected_revision: String,
    pub locale: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTargetLocalesRequest {
    pub session_token: String,
    pub expected_revision: String,
    pub target_locales: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseProjectRequest {
    pub session_token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadataView {
    pub project_id: String,
    pub display_name: String,
    pub source_locale: String,
    pub target_locales: Vec<String>,
    pub metadata_revision: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReconciliationState {
    Settled,
    Committed,
    Previous,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub session_token: String,
    pub locator: String,
    pub metadata: ProjectMetadataView,
    pub reconciliation_state: ReconciliationState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetadataChangeOutcome {
    Changed,
    Unchanged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataMutationView {
    pub session_token: String,
    pub locator: String,
    pub metadata: ProjectMetadataView,
    pub outcome: MetadataChangeOutcome,
    pub directory_changed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloseProjectView {
    pub closed: bool,
}

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<SessionManager>,
}

#[derive(Default)]
struct SessionManager {
    active: Option<ActiveSession>,
}

struct ActiveSession {
    token: String,
    locator: PathBuf,
    store: ProjectStore,
}

impl SessionManager {
    fn create(&mut self, request: CreateProjectRequest) -> Result<ProjectView, CommandError> {
        self.ensure_switch_allowed(CommandStage::Create)?;
        let destination =
            validate_locator(&request.destination, CommandStage::Create, "destination")?;
        let metadata = ProjectMetadata::create(
            &request.display_name,
            &request.source_locale,
            &request.target_locales,
        )
        .map_err(|error| map_metadata_error(error, CommandStage::Create))?;
        let store = ProjectStore::create(&destination, metadata)
            .map_err(|error| map_persistence_error(error, CommandStage::Create))?;
        let locator = canonicalize_created(&destination)?;
        let metadata = store
            .metadata()
            .map_err(|error| map_persistence_error(error, CommandStage::Create))?;
        let token = new_session_token();
        let view = project_view(&token, &locator, &metadata, ReconciliationState::Settled);
        self.active = Some(ActiveSession {
            token,
            locator,
            store,
        });
        Ok(view)
    }

    fn open(&mut self, request: OpenProjectRequest) -> Result<ProjectView, CommandError> {
        self.ensure_switch_allowed(CommandStage::Open)?;
        let locator = resolve_existing_locator(&request.locator, CommandStage::Open)?;
        if let Some(active) = self.active.as_ref() {
            if active.locator == locator {
                let token = active.token.clone();
                return self.read(ReadProjectRequest {
                    session_token: token,
                });
            }
        }

        let store = ProjectStore::open(&locator)
            .map_err(|error| map_persistence_error(error, CommandStage::Open))?;
        let metadata = store
            .metadata()
            .map_err(|error| map_persistence_error(error, CommandStage::Open))?;
        let token = new_session_token();
        let view = project_view(&token, &locator, &metadata, ReconciliationState::Settled);
        self.active = Some(ActiveSession {
            token,
            locator,
            store,
        });
        Ok(view)
    }

    fn read(&mut self, request: ReadProjectRequest) -> Result<ProjectView, CommandError> {
        let active = self.active_mut(&request.session_token, CommandStage::Read)?;
        let (metadata, reconciliation_state) = if active.store.is_reconciling() {
            match active
                .store
                .reconcile()
                .map_err(|error| map_persistence_error(error, CommandStage::Read))?
            {
                Reconciliation::Committed(metadata) => (metadata, ReconciliationState::Committed),
                Reconciliation::Previous(metadata) => (metadata, ReconciliationState::Previous),
                Reconciliation::Settled(metadata) => (metadata, ReconciliationState::Settled),
                Reconciliation::StillUnknown => {
                    return Err(CommandError::unknown(CommandStage::Read));
                }
            }
        } else {
            (
                active
                    .store
                    .metadata()
                    .map_err(|error| map_persistence_error(error, CommandStage::Read))?,
                ReconciliationState::Settled,
            )
        };
        Ok(project_view(
            &active.token,
            &active.locator,
            &metadata,
            reconciliation_state,
        ))
    }

    fn rename(
        &mut self,
        request: RenameProjectRequest,
    ) -> Result<MetadataMutationView, CommandError> {
        if request.directory_name.is_none() {
            let expected_revision =
                parse_revision(&request.expected_revision, CommandStage::Rename)?;
            let active = self.active_mut(&request.session_token, CommandStage::Rename)?;
            let change = active
                .store
                .rename(expected_revision, &request.display_name)
                .map_err(|error| map_persistence_error(error, CommandStage::Rename))?;
            return Ok(metadata_mutation_view(
                &active.token,
                &active.locator,
                &change,
                false,
            ));
        }

        let expected_revision = parse_revision(&request.expected_revision, CommandStage::Rename)?;
        let directory_name = request.directory_name.expect("checked above");
        validate_directory_name(&directory_name, CommandStage::Rename)?;

        {
            let active = self.active.as_ref().ok_or_else(|| {
                CommandError::simple(CommandErrorCode::SessionInvalid, CommandStage::Rename)
            })?;
            if active.token != request.session_token {
                return Err(CommandError::simple(
                    CommandErrorCode::SessionInvalid,
                    CommandStage::Rename,
                ));
            }
            if active.store.is_reconciling() {
                return Err(CommandError::unknown(CommandStage::Rename));
            }
            let metadata = active
                .store
                .metadata()
                .map_err(|error| map_persistence_error(error, CommandStage::Rename))?;
            metadata
                .rename(expected_revision, &request.display_name)
                .map_err(|error| map_metadata_error(error, CommandStage::Rename))?;
        }

        let active = self.active.take().ok_or_else(|| {
            CommandError::simple(CommandErrorCode::SessionInvalid, CommandStage::Rename)
        })?;
        if active.token != request.session_token {
            self.active = Some(active);
            return Err(CommandError::simple(
                CommandErrorCode::SessionInvalid,
                CommandStage::Rename,
            ));
        }
        if active.store.is_reconciling() {
            self.active = Some(active);
            return Err(CommandError::unknown(CommandStage::Rename));
        }

        let old_locator = active.locator.clone();
        let parent = match old_locator.parent() {
            Some(parent) => parent,
            None => {
                self.active = Some(active);
                return Err(CommandError::invalid_input(
                    CommandStage::Rename,
                    Some("directoryName"),
                ));
            }
        };
        let new_locator = parent.join(&directory_name);
        if same_locator(&old_locator, &new_locator) {
            let mut active = active;
            let change = active
                .store
                .rename(expected_revision, &request.display_name)
                .map_err(|error| map_persistence_error(error, CommandStage::Rename))?;
            let view = metadata_mutation_view(&active.token, &active.locator, &change, false);
            self.active = Some(active);
            return Ok(view);
        }
        if new_locator.exists() {
            self.active = Some(active);
            return Err(CommandError::simple(
                CommandErrorCode::DestinationConflict,
                CommandStage::Rename,
            ));
        }

        let ActiveSession {
            token,
            locator: old_locator,
            store,
        } = active;
        if let Err(error) = store.close() {
            return Err(self.restore_session_after_directory_failure(
                token,
                old_locator,
                map_persistence_error(error, CommandStage::Rename),
            ));
        }

        if let Err(error) = fs::rename(&old_locator, &new_locator) {
            return Err(self.restore_session_after_directory_failure(
                token,
                old_locator,
                map_directory_rename_error(error),
            ));
        }

        let mut new_store = match ProjectStore::open(&new_locator) {
            Ok(store) => store,
            Err(error) => {
                return Err(self.rollback_directory_rename(
                    token,
                    old_locator,
                    new_locator,
                    map_persistence_error(error, CommandStage::Rename),
                ));
            }
        };
        let change = match new_store.rename(expected_revision, &request.display_name) {
            Ok(change) => change,
            Err(error) => {
                if matches!(error, PersistenceError::OutcomeUnknown { .. }) {
                    self.active = Some(ActiveSession {
                        token,
                        locator: new_locator,
                        store: new_store,
                    });
                    return Err(map_persistence_error(error, CommandStage::Rename));
                }
                let mapped = map_persistence_error(error, CommandStage::Rename);
                if new_store.close().is_err() {
                    if let Ok(store) = ProjectStore::open(&new_locator) {
                        self.active = Some(ActiveSession {
                            token,
                            locator: new_locator,
                            store,
                        });
                    }
                    return Err(CommandError::unknown(CommandStage::Rename));
                }
                return Err(self.rollback_directory_rename(
                    token,
                    old_locator,
                    new_locator,
                    mapped,
                ));
            }
        };
        let view = metadata_mutation_view(&token, &new_locator, &change, true);
        self.active = Some(ActiveSession {
            token,
            locator: new_locator,
            store: new_store,
        });
        Ok(view)
    }

    fn restore_session_after_directory_failure(
        &mut self,
        token: String,
        locator: PathBuf,
        error: CommandError,
    ) -> CommandError {
        match ProjectStore::open(&locator) {
            Ok(store) => {
                self.active = Some(ActiveSession {
                    token,
                    locator: locator.clone(),
                    store,
                });
                error
            }
            Err(_) => CommandError::unknown(CommandStage::Rename),
        }
    }

    fn rollback_directory_rename(
        &mut self,
        token: String,
        old_locator: PathBuf,
        new_locator: PathBuf,
        error: CommandError,
    ) -> CommandError {
        if fs::rename(&new_locator, &old_locator).is_err() {
            return CommandError::unknown(CommandStage::Rename);
        }
        match ProjectStore::open(&old_locator) {
            Ok(store) => {
                self.active = Some(ActiveSession {
                    token,
                    locator: old_locator,
                    store,
                });
                error
            }
            Err(_) => CommandError::unknown(CommandStage::Rename),
        }
    }

    fn add_target_locale(
        &mut self,
        request: AddTargetLocaleRequest,
    ) -> Result<MetadataMutationView, CommandError> {
        let expected_revision =
            parse_revision(&request.expected_revision, CommandStage::AddTargetLocale)?;
        let active = self.active_mut(&request.session_token, CommandStage::AddTargetLocale)?;
        let change = active
            .store
            .add_target_locale(expected_revision, &request.locale)
            .map_err(|error| map_persistence_error(error, CommandStage::AddTargetLocale))?;
        Ok(metadata_mutation_view(
            &active.token,
            &active.locator,
            &change,
            false,
        ))
    }

    fn set_target_locales(
        &mut self,
        request: SetTargetLocalesRequest,
    ) -> Result<MetadataMutationView, CommandError> {
        let stage = CommandStage::SetTargetLocales;
        let expected_revision = parse_revision(&request.expected_revision, stage)?;
        let active = self.active_mut(&request.session_token, stage)?;
        let change = active
            .store
            .set_target_locales(expected_revision, &request.target_locales)
            .map_err(|error| map_persistence_error(error, stage))?;
        Ok(metadata_mutation_view(
            &active.token,
            &active.locator,
            &change,
            false,
        ))
    }

    fn close(&mut self, request: CloseProjectRequest) -> Result<CloseProjectView, CommandError> {
        let active = self.active.as_ref().ok_or_else(|| {
            CommandError::simple(CommandErrorCode::SessionInvalid, CommandStage::Close)
        })?;
        if active.token != request.session_token {
            return Err(CommandError::simple(
                CommandErrorCode::SessionInvalid,
                CommandStage::Close,
            ));
        }
        if active.store.is_reconciling() {
            return Err(CommandError::unknown(CommandStage::Close));
        }
        let active = self.active.take().expect("active session checked above");
        active
            .store
            .close()
            .map_err(|error| map_persistence_error(error, CommandStage::Close))?;
        Ok(CloseProjectView { closed: true })
    }

    fn ensure_switch_allowed(&self, stage: CommandStage) -> Result<(), CommandError> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.store.is_reconciling())
        {
            return Err(CommandError::unknown(stage));
        }
        Ok(())
    }

    fn active_mut(
        &mut self,
        token: &str,
        stage: CommandStage,
    ) -> Result<&mut ActiveSession, CommandError> {
        let active = self
            .active
            .as_mut()
            .ok_or_else(|| CommandError::simple(CommandErrorCode::SessionInvalid, stage))?;
        if active.token != token {
            return Err(CommandError::simple(
                CommandErrorCode::SessionInvalid,
                stage,
            ));
        }
        Ok(active)
    }
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    request: CreateProjectRequest,
) -> Result<ProjectView, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::Create)?;
    sessions.create(request)
}

#[tauri::command]
pub fn open_project(
    state: State<'_, AppState>,
    request: OpenProjectRequest,
) -> Result<ProjectView, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::Open)?;
    sessions.open(request)
}

#[tauri::command]
pub fn read_project(
    state: State<'_, AppState>,
    request: ReadProjectRequest,
) -> Result<ProjectView, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::Read)?;
    sessions.read(request)
}

#[tauri::command]
pub fn rename_project(
    state: State<'_, AppState>,
    request: RenameProjectRequest,
) -> Result<MetadataMutationView, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::Rename)?;
    sessions.rename(request)
}

#[tauri::command]
pub fn add_target_locale(
    state: State<'_, AppState>,
    request: AddTargetLocaleRequest,
) -> Result<MetadataMutationView, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::AddTargetLocale)?;
    sessions.add_target_locale(request)
}

#[tauri::command]
pub fn set_target_locales(
    state: State<'_, AppState>,
    request: SetTargetLocalesRequest,
) -> Result<MetadataMutationView, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::SetTargetLocales)?;
    sessions.set_target_locales(request)
}

#[tauri::command]
pub fn close_project(
    state: State<'_, AppState>,
    request: CloseProjectRequest,
) -> Result<CloseProjectView, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::Close)?;
    sessions.close(request)
}

pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_project,
            open_project,
            read_project,
            rename_project,
            add_target_locale,
            set_target_locales,
            close_project,
        ])
}

fn lock_sessions<'a>(
    state: &'a State<'_, AppState>,
    stage: CommandStage,
) -> Result<MutexGuard<'a, SessionManager>, CommandError> {
    state
        .sessions
        .lock()
        .map_err(|_| CommandError::simple(CommandErrorCode::Busy, stage))
}

fn validate_locator(raw: &str, stage: CommandStage, field: &str) -> Result<PathBuf, CommandError> {
    if raw.trim().is_empty() || raw.chars().any(char::is_control) {
        return Err(CommandError::invalid_input(stage, Some(field)));
    }
    Ok(PathBuf::from(raw))
}

fn validate_directory_name(raw: &str, stage: CommandStage) -> Result<(), CommandError> {
    if raw.is_empty()
        || raw.trim() != raw
        || raw == "."
        || raw == ".."
        || raw.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
        || raw.ends_with(' ')
        || raw.ends_with('.')
        || is_reserved_windows_name(raw)
    {
        return Err(CommandError::invalid_input(stage, Some("directoryName")));
    }
    Ok(())
}

fn is_reserved_windows_name(raw: &str) -> bool {
    let base = raw.split('.').next().unwrap_or(raw).to_ascii_lowercase();
    matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || (base.len() == 4
            && (base.starts_with("com") || base.starts_with("lpt"))
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

fn same_locator(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn map_directory_rename_error(error: io::Error) -> CommandError {
    let code = match error.kind() {
        io::ErrorKind::AlreadyExists => CommandErrorCode::DestinationConflict,
        io::ErrorKind::NotFound => CommandErrorCode::MissingProject,
        io::ErrorKind::PermissionDenied => CommandErrorCode::PermissionDenied,
        _ => CommandErrorCode::StorageFailed,
    };
    CommandError::simple(code, CommandStage::Rename)
}

fn canonicalize_created(path: &Path) -> Result<PathBuf, CommandError> {
    fs::canonicalize(path).map_err(|error| map_locator_error(error, CommandStage::Create))
}

fn resolve_existing_locator(raw: &str, stage: CommandStage) -> Result<PathBuf, CommandError> {
    let path = validate_locator(raw, stage, "locator")?;
    fs::canonicalize(path).map_err(|error| map_locator_error(error, stage))
}

fn map_locator_error(error: io::Error, stage: CommandStage) -> CommandError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => CommandErrorCode::MissingProject,
        io::ErrorKind::PermissionDenied => CommandErrorCode::PermissionDenied,
        _ => CommandErrorCode::StorageFailed,
    };
    CommandError::simple(code, stage)
}

fn parse_revision(raw: &str, stage: CommandStage) -> Result<u64, CommandError> {
    raw.parse::<u64>()
        .map_err(|_| CommandError::invalid_input(stage, Some("expectedRevision")))
}

fn new_session_token() -> String {
    ProjectId::new_v4().to_string()
}

fn project_view(
    session_token: &str,
    locator: &Path,
    metadata: &ProjectMetadata,
    reconciliation_state: ReconciliationState,
) -> ProjectView {
    ProjectView {
        session_token: session_token.to_owned(),
        locator: locator.to_string_lossy().into_owned(),
        metadata: metadata_view(metadata),
        reconciliation_state,
    }
}

fn metadata_view(metadata: &ProjectMetadata) -> ProjectMetadataView {
    ProjectMetadataView {
        project_id: metadata.project_id().to_string(),
        display_name: metadata.display_name().to_owned(),
        source_locale: metadata.source_locale().to_string(),
        target_locales: metadata
            .target_locales()
            .iter()
            .map(ToString::to_string)
            .collect(),
        metadata_revision: metadata.metadata_revision().to_string(),
    }
}

fn metadata_mutation_view(
    session_token: &str,
    locator: &Path,
    change: &tsumugi_core::MetadataChange,
    directory_changed: bool,
) -> MetadataMutationView {
    MetadataMutationView {
        session_token: session_token.to_owned(),
        locator: locator.to_string_lossy().into_owned(),
        metadata: metadata_view(change.metadata()),
        outcome: match change.outcome() {
            ChangeOutcome::Changed => MetadataChangeOutcome::Changed,
            ChangeOutcome::Unchanged => MetadataChangeOutcome::Unchanged,
        },
        directory_changed,
    }
}

fn map_metadata_error(error: MetadataError, stage: CommandStage) -> CommandError {
    match error {
        MetadataError::InvalidInput { field, .. } => {
            CommandError::invalid_input(stage, Some(metadata_field_name(field)))
        }
        MetadataError::StaleRevision { current_revision } => {
            CommandError::stale(stage, current_revision)
        }
        MetadataError::RevisionOverflow => {
            CommandError::invalid_input(stage, Some("metadataRevision"))
        }
    }
}

fn map_persistence_error(error: PersistenceError, fallback: CommandStage) -> CommandError {
    let stage = command_stage(error.stage(), fallback);
    match error {
        PersistenceError::InvalidInput { error, .. } => map_metadata_error(error, stage),
        PersistenceError::DestinationConflict { .. } => {
            CommandError::simple(CommandErrorCode::DestinationConflict, stage)
        }
        PersistenceError::MissingProject { .. } => {
            CommandError::simple(CommandErrorCode::MissingProject, stage)
        }
        PersistenceError::PermissionDenied { .. } => {
            CommandError::simple(CommandErrorCode::PermissionDenied, stage)
        }
        PersistenceError::UnsupportedSchema { .. } => {
            CommandError::simple(CommandErrorCode::UnsupportedSchema, stage)
        }
        PersistenceError::CorruptProject { .. } => {
            CommandError::simple(CommandErrorCode::CorruptProject, stage)
        }
        PersistenceError::StaleRevision {
            current_revision, ..
        } => CommandError::stale(stage, current_revision),
        PersistenceError::SessionInvalid { .. } => {
            CommandError::simple(CommandErrorCode::SessionInvalid, stage)
        }
        PersistenceError::ProjectInUse { .. } => {
            CommandError::simple(CommandErrorCode::ProjectInUse, stage)
        }
        PersistenceError::Busy { .. } => CommandError::simple(CommandErrorCode::Busy, stage),
        PersistenceError::StorageFailed { .. } => {
            CommandError::simple(CommandErrorCode::StorageFailed, stage)
        }
        PersistenceError::OutcomeUnknown { .. } => CommandError::unknown(stage),
    }
}

fn command_stage(persistence: PersistenceStage, fallback: CommandStage) -> CommandStage {
    match persistence {
        PersistenceStage::Create => CommandStage::Create,
        PersistenceStage::Open | PersistenceStage::Ownership => fallback,
        PersistenceStage::Read | PersistenceStage::Reconcile => CommandStage::Read,
        PersistenceStage::Write | PersistenceStage::Commit => fallback,
        PersistenceStage::Close => CommandStage::Close,
    }
}

fn metadata_field_name(field: MetadataField) -> &'static str {
    match field {
        MetadataField::DisplayName => "displayName",
        MetadataField::MetadataRevision => "metadataRevision",
        MetadataField::SourceLocale => "sourceLocale",
        MetadataField::TargetLocales => "targetLocales",
        MetadataField::TargetLocale => "locale",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn temporary_directory(label: &str) -> TempDir {
        tempfile::Builder::new()
            .prefix(&format!("tsumugi-command-{label}-"))
            .tempdir()
            .unwrap()
    }

    fn create_request(path: &Path) -> CreateProjectRequest {
        CreateProjectRequest {
            destination: path.to_string_lossy().into_owned(),
            display_name: "Command Demo".to_owned(),
            source_locale: "en-US".to_owned(),
            target_locales: vec!["zh-CN".to_owned(), "ja".to_owned()],
        }
    }

    #[test]
    fn dto_serialization_preserves_wire_names_and_rejects_missing_fields() {
        let request = RenameProjectRequest {
            session_token: "session-1".to_owned(),
            expected_revision: u64::MAX.to_string(),
            display_name: "Literal name".to_owned(),
            directory_name: Some("renamed-folder".to_owned()),
        };
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(wire["sessionToken"], "session-1");
        assert_eq!(wire["expectedRevision"], u64::MAX.to_string());
        assert_eq!(wire["displayName"], "Literal name");
        assert!(wire.get("session_token").is_none());
        assert_eq!(
            serde_json::from_value::<RenameProjectRequest>(wire).unwrap(),
            request
        );

        let malformed = serde_json::from_value::<RenameProjectRequest>(json!({
            "sessionToken": "session-1",
            "displayName": "Literal name"
        }));
        assert!(malformed.is_err());
    }

    #[test]
    fn shared_typescript_fixture_matches_rust_serialization() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../test/fixtures/projectCommands.contract.json"
        ))
        .unwrap();

        let requests = &fixture["requests"];
        assert_eq!(
            requests["create"],
            serde_json::to_value(CreateProjectRequest {
                destination: "C:\\Projects\\demo".to_owned(),
                display_name: "Literal name".to_owned(),
                source_locale: "en-US".to_owned(),
                target_locales: vec!["ja".to_owned(), "zh-CN".to_owned()],
            })
            .unwrap()
        );
        assert_eq!(
            requests["open"],
            serde_json::to_value(OpenProjectRequest {
                locator: "C:\\Projects\\demo".to_owned(),
            })
            .unwrap()
        );
        assert_eq!(
            requests["read"],
            serde_json::to_value(ReadProjectRequest {
                session_token: "session-1".to_owned(),
            })
            .unwrap()
        );
        assert_eq!(
            requests["rename"],
            serde_json::to_value(RenameProjectRequest {
                session_token: "session-1".to_owned(),
                expected_revision: u64::MAX.to_string(),
                display_name: "Literal name".to_owned(),
                directory_name: Some("renamed-folder".to_owned()),
            })
            .unwrap()
        );
        assert_eq!(
            requests["addTargetLocale"],
            serde_json::to_value(AddTargetLocaleRequest {
                session_token: "session-1".to_owned(),
                expected_revision: "2".to_owned(),
                locale: "ko".to_owned(),
            })
            .unwrap()
        );
        assert_eq!(
            requests["close"],
            serde_json::to_value(CloseProjectRequest {
                session_token: "session-1".to_owned(),
            })
            .unwrap()
        );

        let metadata = ProjectMetadataView {
            project_id: "123e4567-e89b-42d3-a456-426614174000".to_owned(),
            display_name: "Literal name".to_owned(),
            source_locale: "en-US".to_owned(),
            target_locales: vec!["ja".to_owned(), "zh-CN".to_owned()],
            metadata_revision: "2".to_owned(),
        };
        assert_eq!(
            fixture["responses"]["projectView"],
            serde_json::to_value(ProjectView {
                session_token: "session-1".to_owned(),
                locator: "C:\\Projects\\demo".to_owned(),
                metadata: metadata.clone(),
                reconciliation_state: ReconciliationState::Settled,
            })
            .unwrap()
        );
        assert_eq!(
            fixture["responses"]["metadataMutation"],
            serde_json::to_value(MetadataMutationView {
                session_token: "session-1".to_owned(),
                locator: "C:\\Projects\\demo".to_owned(),
                metadata,
                outcome: MetadataChangeOutcome::Changed,
                directory_changed: false,
            })
            .unwrap()
        );
        assert_eq!(
            fixture["responses"]["close"],
            serde_json::to_value(CloseProjectView { closed: true }).unwrap()
        );
        assert_eq!(
            fixture["error"],
            serde_json::to_value(CommandError::unknown(CommandStage::Rename)).unwrap()
        );
    }

    #[test]
    fn manager_round_trip_uses_authoritative_core_and_decimal_revisions() {
        let parent = temporary_directory("round-trip");
        let project = parent.path().join("project");
        let mut manager = SessionManager::default();
        let created = manager.create(create_request(&project)).unwrap();
        assert_eq!(created.metadata.metadata_revision, "1");
        assert_eq!(created.metadata.target_locales, vec!["ja", "zh-CN"]);

        let renamed = manager
            .rename(RenameProjectRequest {
                session_token: created.session_token.clone(),
                expected_revision: "1".to_owned(),
                display_name: "Command Demo 2".to_owned(),
                directory_name: None,
            })
            .unwrap();
        assert_eq!(renamed.outcome, MetadataChangeOutcome::Changed);
        assert_eq!(renamed.metadata.metadata_revision, "2");

        let read = manager
            .read(ReadProjectRequest {
                session_token: created.session_token.clone(),
            })
            .unwrap();
        assert_eq!(read.metadata.display_name, "Command Demo 2");
        assert_eq!(read.metadata.metadata_revision, "2");

        let closed = manager
            .close(CloseProjectRequest {
                session_token: created.session_token,
            })
            .unwrap();
        assert!(closed.closed);
    }

    #[test]
    fn rename_can_move_directory_and_reopen_at_new_locator() {
        let parent = temporary_directory("directory-rename");
        let old_path = parent.path().join("project");
        let new_path = parent.path().join("renamed-folder");
        let mut manager = SessionManager::default();
        let created = manager.create(create_request(&old_path)).unwrap();

        let renamed = manager
            .rename(RenameProjectRequest {
                session_token: created.session_token.clone(),
                expected_revision: "1".to_owned(),
                display_name: "Renamed project".to_owned(),
                directory_name: Some("renamed-folder".to_owned()),
            })
            .unwrap();

        assert!(renamed.directory_changed);
        assert_eq!(renamed.metadata.display_name, "Renamed project");
        assert_eq!(renamed.metadata.metadata_revision, "2");
        assert_eq!(
            renamed.locator,
            fs::canonicalize(&new_path).unwrap().to_string_lossy()
        );
        assert!(!old_path.exists());
        assert!(new_path.is_dir());

        let read = manager
            .read(ReadProjectRequest {
                session_token: created.session_token.clone(),
            })
            .unwrap();
        assert_eq!(read.locator, renamed.locator);
        assert_eq!(read.metadata.display_name, "Renamed project");

        manager
            .close(CloseProjectRequest {
                session_token: created.session_token,
            })
            .unwrap();
        let reopened = manager
            .open(OpenProjectRequest {
                locator: new_path.to_string_lossy().into_owned(),
            })
            .unwrap();
        assert_eq!(reopened.locator, renamed.locator);
        assert_eq!(reopened.metadata.display_name, "Renamed project");
    }

    #[test]
    fn directory_rename_rejects_unsafe_names_and_existing_destinations() {
        let parent = temporary_directory("directory-rename-validation");
        let old_path = parent.path().join("project");
        let taken_path = parent.path().join("taken");
        fs::create_dir(&taken_path).unwrap();
        let mut manager = SessionManager::default();
        let created = manager.create(create_request(&old_path)).unwrap();

        let conflict = manager
            .rename(RenameProjectRequest {
                session_token: created.session_token.clone(),
                expected_revision: "1".to_owned(),
                display_name: "Renamed project".to_owned(),
                directory_name: Some("taken".to_owned()),
            })
            .unwrap_err();
        assert_eq!(conflict.code, CommandErrorCode::DestinationConflict);
        assert!(old_path.is_dir());

        for name in ["", ".", "..", "bad/name", "CON", "trailing ", "trailing."] {
            let error = manager
                .rename(RenameProjectRequest {
                    session_token: created.session_token.clone(),
                    expected_revision: "1".to_owned(),
                    display_name: "Renamed project".to_owned(),
                    directory_name: Some(name.to_owned()),
                })
                .unwrap_err();
            assert_eq!(error.code, CommandErrorCode::InvalidInput, "{name:?}");
            assert_eq!(error.field.as_deref(), Some("directoryName"), "{name:?}");
        }

        let read = manager
            .read(ReadProjectRequest {
                session_token: created.session_token.clone(),
            })
            .unwrap();
        assert_eq!(
            read.locator,
            fs::canonicalize(&old_path).unwrap().to_string_lossy()
        );
        assert_eq!(read.metadata.metadata_revision, "1");
        manager
            .close(CloseProjectRequest {
                session_token: created.session_token,
            })
            .unwrap();
    }

    #[test]
    fn target_scope_edit_validates_atomically_and_survives_reopen() {
        let parent = temporary_directory("target-edit");
        let path = parent.path().join("project");
        let mut manager = SessionManager::default();
        let created = manager.create(create_request(&path)).unwrap();
        for targets in [vec![], vec!["ssss"], vec!["ssssss"], vec!["en-US", "EN-us"]] {
            let error = manager
                .set_target_locales(SetTargetLocalesRequest {
                    session_token: created.session_token.clone(),
                    expected_revision: "1".to_owned(),
                    target_locales: targets.into_iter().map(str::to_owned).collect(),
                })
                .unwrap_err();
            assert_eq!(error.code, CommandErrorCode::InvalidInput);
            assert_eq!(error.field.as_deref(), Some("targetLocales"));
        }
        let changed = manager
            .set_target_locales(SetTargetLocalesRequest {
                session_token: created.session_token.clone(),
                expected_revision: "1".to_owned(),
                target_locales: vec!["fr-FR".to_owned()],
            })
            .unwrap();
        assert_eq!(changed.metadata.target_locales, vec!["fr-FR"]);
        assert_eq!(changed.metadata.metadata_revision, "2");
        let stale = manager
            .set_target_locales(SetTargetLocalesRequest {
                session_token: created.session_token.clone(),
                expected_revision: "1".to_owned(),
                target_locales: vec!["ja".to_owned()],
            })
            .unwrap_err();
        assert_eq!(stale.code, CommandErrorCode::StaleRevision);
        let unchanged = manager
            .set_target_locales(SetTargetLocalesRequest {
                session_token: created.session_token.clone(),
                expected_revision: "2".to_owned(),
                target_locales: vec!["FR-fr".to_owned()],
            })
            .unwrap();
        assert_eq!(unchanged.outcome, MetadataChangeOutcome::Unchanged);
        assert_eq!(unchanged.metadata.metadata_revision, "2");
        manager
            .close(CloseProjectRequest {
                session_token: created.session_token,
            })
            .unwrap();
        let reopened = manager
            .open(OpenProjectRequest {
                locator: path.to_string_lossy().into_owned(),
            })
            .unwrap();
        assert_eq!(reopened.metadata.target_locales, vec!["fr-FR"]);
        assert_eq!(reopened.metadata.metadata_revision, "2");
    }

    #[test]
    fn rejected_session_and_basis_requests_do_not_write() {
        let parent = temporary_directory("rejection");
        let project = parent.path().join("project");
        let mut manager = SessionManager::default();
        let created = manager.create(create_request(&project)).unwrap();

        let invalid_session = manager
            .read(ReadProjectRequest {
                session_token: "wrong".to_owned(),
            })
            .unwrap_err();
        assert_eq!(invalid_session.code, CommandErrorCode::SessionInvalid);

        let invalid_name = manager
            .rename(RenameProjectRequest {
                session_token: created.session_token.clone(),
                expected_revision: "1".to_owned(),
                display_name: "".to_owned(),
                directory_name: None,
            })
            .unwrap_err();
        assert_eq!(invalid_name.code, CommandErrorCode::InvalidInput);
        assert_eq!(invalid_name.field.as_deref(), Some("displayName"));

        let invalid_locale = manager
            .add_target_locale(AddTargetLocaleRequest {
                session_token: created.session_token.clone(),
                expected_revision: "1".to_owned(),
                locale: "ssss".to_owned(),
            })
            .unwrap_err();
        assert_eq!(invalid_locale.code, CommandErrorCode::InvalidInput);
        assert_eq!(invalid_locale.field.as_deref(), Some("locale"));

        let stale = manager
            .add_target_locale(AddTargetLocaleRequest {
                session_token: created.session_token.clone(),
                expected_revision: "0".to_owned(),
                locale: "ko".to_owned(),
            })
            .unwrap_err();
        assert_eq!(stale.code, CommandErrorCode::StaleRevision);
        assert_eq!(stale.current_revision.as_deref(), Some("1"));

        let read = manager
            .read(ReadProjectRequest {
                session_token: created.session_token.clone(),
            })
            .unwrap();
        assert_eq!(read.metadata.metadata_revision, "1");
        assert_eq!(read.metadata.target_locales, vec!["ja", "zh-CN"]);
        manager
            .close(CloseProjectRequest {
                session_token: created.session_token,
            })
            .unwrap();
    }

    #[test]
    fn same_active_open_reuses_session_and_failed_switch_preserves_it() {
        let parent = temporary_directory("switch");
        let project_a = parent.path().join("project-a");
        let project_b = parent.path().join("project-b");
        let mut manager = SessionManager::default();
        let created = manager.create(create_request(&project_a)).unwrap();

        let reopened = manager
            .open(OpenProjectRequest {
                locator: project_a.to_string_lossy().into_owned(),
            })
            .unwrap();
        assert_eq!(reopened.session_token, created.session_token);

        let standalone = ProjectMetadata::create("Broken", "en-US", ["zh-CN"]).unwrap();
        let standalone_store = ProjectStore::create(&project_b, standalone).unwrap();
        standalone_store.close().unwrap();
        fs::write(project_b.join("project.sqlite3"), b"corrupt project").unwrap();

        let failed = manager
            .open(OpenProjectRequest {
                locator: project_b.to_string_lossy().into_owned(),
            })
            .unwrap_err();
        assert_eq!(failed.code, CommandErrorCode::CorruptProject);

        let preserved = manager
            .read(ReadProjectRequest {
                session_token: created.session_token.clone(),
            })
            .unwrap();
        assert_eq!(preserved.metadata.display_name, "Command Demo");
        manager
            .close(CloseProjectRequest {
                session_token: created.session_token,
            })
            .unwrap();
    }

    #[test]
    fn error_mapping_preserves_unknown_and_stale_context() {
        let stale = map_persistence_error(
            PersistenceError::StaleRevision {
                current_revision: 42,
                stage: PersistenceStage::Write,
            },
            CommandStage::Rename,
        );
        assert_eq!(stale.code, CommandErrorCode::StaleRevision);
        assert_eq!(stale.current_revision.as_deref(), Some("42"));

        let unknown = map_persistence_error(
            PersistenceError::OutcomeUnknown {
                stage: PersistenceStage::Commit,
            },
            CommandStage::Rename,
        );
        assert_eq!(unknown.code, CommandErrorCode::OutcomeUnknown);
        assert!(unknown.recovery_required);
        let json = serde_json::to_value(unknown).unwrap();
        assert_eq!(json["code"], "outcome-unknown");
        assert_eq!(json["stage"], "rename");
    }
}
