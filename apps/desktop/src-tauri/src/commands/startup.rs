//! Native directory preparation before a project exists. No plugin is executed.
use super::*;
use std::{path::PathBuf, time::Instant};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::execution::ExecutionId;
use execution::source::{capture::{DeclaredMaterial, Selection}, plugin::PluginSourceSelection};
use plugins::{PluginSourceRequest, PluginSourceView};

pub(super) const DROP_EVENT: &str = "startup-native-drop";

fn stale() -> CommandError {
    let mut error = CommandError::simple(CommandErrorCode::DependencyConflict, CommandStage::ExecutionRead);
    error.reason = Some("startup-selection-expired".into()); error
}
fn map_input(error: tsumugi_core::execution::ExecutionError) -> CommandError {
    execution::map_execution(error, CommandStage::ExecutionRead)
}
fn empty(sessions: &SessionManager) -> Result<(), CommandError> {
    if sessions.active.is_some() || sessions.directory_recovery.is_some() || sessions.package_operation.is_some() { Err(stale()) } else { Ok(()) }
}
fn main_window(window: &str) -> Result<(), CommandError> { if window == "main" { Ok(()) } else { Err(stale()) } }

#[derive(Clone, PartialEq, Eq)]
struct Scope { window: String, epoch: ExecutionId }
impl native_directory::Scope for Scope { fn window(&self) -> &str { &self.window } }

#[derive(Clone)]
struct Inspection {
    source: PluginSourceRequest,
    materials: Vec<DeclaredMaterial>,
    file_sets: Vec<tsumugi_plugin_sdk::SourceFileSetSelection>,
}
struct Chosen {
    window: String,
    id: ExecutionId,
    selection: Arc<Selection>,
    inspections: Vec<Inspection>,
}
struct Handoff { chosen: Chosen, session_token: String, project_id: ExecutionId }

pub(super) struct StartupSession {
    epoch: ExecutionId,
    picker: Option<(String, ExecutionId)>,
    inspection: Option<ExecutionId>,
    drop: Option<native_directory::Drop<Scope>>,
    chosen: Option<Chosen>,
    handoff: Option<Handoff>,
}
impl Default for StartupSession {
    fn default() -> Self { Self { epoch: ExecutionId::new(), picker: None, inspection: None, drop: None, chosen: None, handoff: None } }
}
impl StartupSession {
    pub(super) fn epoch(&self) -> ExecutionId { self.epoch }
    pub(super) fn retire(&mut self) { *self = Self::default(); }
    pub(super) fn created(&mut self, project: &ProjectView) {
        let chosen = self.chosen.take(); self.retire();
        self.handoff = chosen.map(|chosen| Handoff { chosen, session_token: project.session_token.clone(),
            project_id: ExecutionId::parse(&project.metadata.project_id).expect("Core project identity") });
    }
    fn chosen(&self, window: &str, id: ExecutionId) -> Result<&Chosen, CommandError> {
        self.chosen.as_ref().filter(|chosen| chosen.id == id && chosen.window == window).ok_or_else(stale)
    }
    fn begin(&mut self, window: String) -> ExecutionId {
        self.epoch = ExecutionId::new(); self.drop = None; self.inspection = None;
        let picker = ExecutionId::new(); self.picker = Some((window, picker)); picker
    }
    fn register_drop(
        &mut self, window: String, paths: Vec<PathBuf>, now: Instant,
    ) -> Result<StartupDropEvent, CommandError> {
        let epoch = ExecutionId::new();
        let scope = Scope { window, epoch };
        let (drop_ticket, folder_name) = native_directory::Drop::register(&mut self.drop, scope, paths, now).map_err(|_| {
            let mut error = CommandError::simple(CommandErrorCode::InvalidInput, CommandStage::ExecutionRead);
            error.reason = Some("native-drop-one-directory".into());
            error
        })?;
        self.epoch = epoch;
        self.picker = None;
        Ok(StartupDropEvent::Ready { drop_ticket, folder_name })
    }
    fn finish(&mut self, window: &str, picker: ExecutionId, selected: Option<Arc<Selection>>) -> Result<Option<StartupDirectory>, CommandError> {
        if self.picker.as_ref() != Some(&(window.to_owned(), picker)) { return Err(stale()); }
        self.picker = None;
        Ok(selected.map(|selection| {
            let id = ExecutionId::new(); let folder_name = selection.label();
            self.chosen = Some(Chosen { window: window.into(), id, selection, inspections: Vec::new() });
            StartupDirectory { selection_id: id, folder_name }
        }))
    }
    pub(super) fn clear_window(&mut self, window: &str) {
        let owns = self.picker.as_ref().is_some_and(|(owner, _)| owner == window)
            || self.chosen.as_ref().is_some_and(|chosen| chosen.window == window)
            || self.handoff.as_ref().is_some_and(|handoff| handoff.chosen.window == window);
        native_directory::Drop::clear_window(&mut self.drop, window);
        if owns { self.retire(); }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StartupSelectRequest {}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StartupDropRequest { pub drop_ticket: ExecutionId }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StartupPreflightRequest { pub selection_id: ExecutionId, pub source: PluginSourceRequest }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StartupClaimRequest {
    pub selection_id: ExecutionId, pub source: PluginSourceRequest, pub project_id: ExecutionId, pub session_token: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StartupDirectory { pub selection_id: ExecutionId, pub folder_name: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StartupPreflight {
    pub directory: StartupDirectory, pub source: PluginSourceView, pub materials: Vec<DeclaredMaterial>, pub complete: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_sets: Vec<tsumugi_plugin_sdk::SourceFileSetSelection>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum StartupDropEvent { Ready { drop_ticket: ExecutionId, folder_name: String }, Rejected { error: CommandError } }

#[tauri::command]
pub async fn select_startup_source_directory<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, window: tauri::Window<R>, state: State<'_, AppState>, request: StartupSelectRequest,
) -> Result<Option<StartupDirectory>, CommandError> {
    let _ = request; select_directory(Some(app), window.label().to_owned(), &state, None).await
}
#[tauri::command]
pub async fn select_dropped_startup_source_directory<R: tauri::Runtime>(
    window: tauri::Window<R>, state: State<'_, AppState>, request: StartupDropRequest,
) -> Result<StartupDirectory, CommandError> {
    select_directory::<R>(None, window.label().to_owned(), &state, Some(request.drop_ticket)).await?.ok_or_else(stale)
}

async fn select_directory<R: tauri::Runtime>(app: Option<tauri::AppHandle<R>>, window: String, state: &AppState, drop: Option<ExecutionId>) -> Result<Option<StartupDirectory>, CommandError> {
    main_window(&window)?;
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?; let owner = window.clone();
    let admitted = lease.submit("startup.select.begin", CommandStage::ExecutionRead, move |sessions| {
        empty(sessions)?;
        let scope = Scope { window: owner.clone(), epoch: sessions.startup.epoch };
        let path = drop.map(|id| native_directory::Drop::consume(&mut sessions.startup.drop, id, &scope, Instant::now()).map_err(|_| stale())).transpose()?;
        Ok((sessions.startup.begin(owner), path))
    })?;
    let (picker, path) = admitted.await?;
    let selected = match path {
        Some(path) => Ok(Some(path)),
        None => {
            let app = app.ok_or_else(stale)?;
            state.dialogs.run(CommandStage::ExecutionRead, move || app.dialog().file().blocking_pick_folder()
                .map(|path| path.into_path().map_err(|_| stale())).transpose()).await
        }
    };
    let selected = match selected {
        Ok(path) => state.io.run(CommandStage::ExecutionRead, move || path.map(|path| Selection::authorize(path).map(Arc::new).map_err(map_input)).transpose()).await,
        Err(error) => Err(error),
    };
    lease.run("startup.select.finish", CommandStage::ExecutionRead, move |sessions| {
        empty(sessions)?;
        let result = sessions.startup.finish(&window, picker, selected.as_ref().ok().cloned().flatten());
        selected?; result
    }).await
}

#[tauri::command]
pub async fn read_startup_source_preflight<R: tauri::Runtime>(
    window: tauri::Window<R>, state: State<'_, AppState>, request: StartupPreflightRequest,
) -> Result<StartupPreflight, CommandError> {
    let app = window.app_handle().clone();
    let window = window.label().to_owned(); main_window(&window)?;
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?; let original = request.clone(); let owner = window.clone();
    let inspection = ExecutionId::new();
    let admitted = lease.submit("startup.preflight.begin", CommandStage::ExecutionRead, move |sessions| {
        empty(sessions)?;
        let selected = sessions.startup.chosen(&owner, original.selection_id)?.selection.clone();
        sessions.startup.inspection = Some(inspection);
        let chosen = sessions.startup.chosen.as_mut().expect("checked startup selection");
        chosen.inspections.retain(|value| value.source != original.source);
        Ok((sessions.startup.epoch, selected))
    })?;
    let (epoch, selected) = admitted.await?; let plugins = state.plugins.clone(); let source = request.source.clone();
    let result = async {
        let environment = state.io.run(CommandStage::ExecutionRead, move || plugins.capture_source(&source)).await?;
        let scope = &lease;
        let owner = window.clone();
        let selection_id = request.selection_id;
        let check_scope = || {
            let owner = owner.clone();
            async move {
                scope.run("startup.preflight.check", CommandStage::ExecutionRead, move |sessions| {
                    empty(sessions)?;
                    sessions.startup.chosen(&owner, selection_id)?;
                    if sessions.startup.epoch != epoch || sessions.startup.inspection != Some(inspection) { return Err(stale()); }
                    Ok(())
                }).await
            }
        };
        let file_sets = execution::source::plugin::file_sets::choose(Some(app), &state.io, &state.dialogs,
            selected.clone(), environment.binding.clone(), check_scope).await?
            .ok_or_else(|| map_input(tsumugi_core::execution::ExecutionError::new(tsumugi_core::execution::ErrorCode::Cancelled, "cancelled")))?;
        state.io.run(CommandStage::ExecutionRead, move || {
            let materials = selected.inspect_selected(&environment.binding, &file_sets).map_err(map_input)?;
            Ok((environment.view()?, materials, file_sets))
        }).await
    }.await;
    lease.run("startup.preflight.finish", CommandStage::ExecutionRead, move |sessions| {
        empty(sessions)?;
        if sessions.startup.epoch != epoch || sessions.startup.inspection != Some(inspection) { return Err(stale()); }
        sessions.startup.inspection = None;
        let (source_view, materials, file_sets) = result?;
        let chosen = sessions.startup.chosen(&window, request.selection_id)?;
        let directory = StartupDirectory { selection_id: chosen.id, folder_name: chosen.selection.label() };
        let complete = materials.iter().all(|item| item.byte_length.is_some());
        let chosen = sessions.startup.chosen.as_mut().expect("checked startup directory");
        chosen.inspections.retain(|value| value.source != request.source);
        if chosen.inspections.len() >= 32 { chosen.inspections.remove(0); }
        chosen.inspections.push(Inspection { source: request.source, materials: materials.clone(), file_sets: file_sets.clone() });
        Ok(StartupPreflight { directory, source: source_view, materials, complete, file_sets })
    }).await
}

#[tauri::command]
pub async fn claim_startup_source_directory<R: tauri::Runtime>(
    window: tauri::Window<R>, state: State<'_, AppState>, request: StartupClaimRequest,
) -> Result<PluginSourceSelection, CommandError> {
    let window = window.label().to_owned(); main_window(&window)?;
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?; let original = request.clone(); let owner = window.clone();
    let admitted = lease.submit("startup.claim.begin", CommandStage::ExecutionRead, move |sessions| {
        execution::authorized(sessions, &original.session_token, original.project_id, CommandStage::ExecutionRead)?;
        let handoff = sessions.startup.handoff.as_ref().filter(|handoff| handoff.chosen.id == original.selection_id
            && handoff.chosen.window == owner && handoff.session_token == original.session_token && handoff.project_id == original.project_id).ok_or_else(stale)?;
        let expected = handoff.chosen.inspections.iter().find(|value| value.source == original.source).cloned().ok_or_else(stale)?;
        if expected.materials.iter().any(|item| item.byte_length.is_none()) { return Err(stale()); }
        Ok((sessions.startup.epoch, handoff.chosen.selection.clone(), expected))
    })?;
    let (epoch, selection, expected) = admitted.await?; let plugins = state.plugins.clone(); let source = request.source.clone();
    let selected = selection.clone();
    let file_sets = expected.file_sets.clone();
    let view = state.io.run(CommandStage::ExecutionRead, move || {
        let environment = plugins.capture_source(&source)?;
        if selected.inspect_selected(&environment.binding, &expected.file_sets).map_err(map_input)? != expected.materials { return Err(stale()); }
        environment.view()
    }).await?;
    let plugins = state.plugins.clone();
    lease.run("startup.claim.finish", CommandStage::ExecutionRead, move |sessions| {
        if sessions.startup.epoch != epoch { return Err(stale()); }
        plugins.with_environment_revision(view.settings_revision, || {
            let active = execution::authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
            execution::source::plugin::accept_startup_selection(active, selection, request.selection_id, request.source, view, file_sets)
        })
    }).await
}

pub(super) fn register_window_drop(
    sessions: &mut SessionManager, window: String, paths: Vec<PathBuf>, now: Instant,
) -> Result<StartupDropEvent, CommandError> {
    empty(sessions)?;
    sessions.startup.register_drop(window, paths, now)
}

#[cfg(test)]
mod tests;
