//! Native drop paths remain in the current Host session. IPC receives only a
//! short-lived ticket and consumes it through the ordinary source selection.
use super::*;
use crate::commands::plugins::PluginSourceRequest;
use std::{path::PathBuf, time::Instant};
use tauri::{Emitter, Manager};

const TICKET_LIFETIME: Duration = Duration::from_secs(60);
const EVENT: &str = "source-native-drop";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DropScope {
    pub(super) window: String,
    pub(super) session_token: String,
    pub(super) project_id: ExecutionId,
    pub(super) generation: ExecutionId,
}

struct DropTicket {
    id: ExecutionId,
    scope: DropScope,
    path: PathBuf,
    issued: Instant,
}

#[derive(Default)]
pub(super) struct NativeDropSession {
    ticket: Option<DropTicket>,
    picker: Option<(String, ExecutionId)>,
}

impl NativeDropSession {
    pub(super) fn clear(&mut self) {
        self.ticket = None;
        self.picker = None;
    }

    fn clear_window(&mut self, window: &str) -> Option<ExecutionId> {
        if self.ticket.as_ref().is_some_and(|ticket| ticket.scope.window == window) {
            self.ticket = None;
        }
        self.picker.as_ref().filter(|(label, _)| label == window)?;
        self.picker.take().map(|(_, picker)| picker)
    }

    pub(super) fn begin_selection(&mut self, window: String, picker: ExecutionId) {
        self.picker = Some((window, picker));
    }

    pub(super) fn finish_selection(&mut self, picker: ExecutionId) {
        if self.picker.as_ref().is_some_and(|(_, current)| *current == picker) {
            self.picker = None;
        }
    }

    fn register(
        &mut self,
        scope: DropScope,
        paths: Vec<PathBuf>,
        now: Instant,
    ) -> Result<NativeSourceDropEvent, CommandError> {
        // A new native drop supersedes the prior invitation, including rejected
        // multi-file drops. Directory authorization still belongs to Selection.
        self.ticket = None;
        if paths.len() != 1 {
            return Err(map_source(ExecutionError::new(
                ErrorCode::InvalidInput,
                "native-drop-one-directory",
            )));
        }
        let path = paths.into_iter().next().expect("one native drop path");
        let id = ExecutionId::new();
        let folder_name = path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned();
        let event = NativeSourceDropEvent::Ready {
            drop_ticket: id,
            folder_name,
            session_token: scope.session_token.clone(),
            project_id: scope.project_id,
        };
        self.ticket = Some(DropTicket { id, scope, path, issued: now });
        Ok(event)
    }

    pub(super) fn consume(
        &mut self,
        id: ExecutionId,
        scope: &DropScope,
        now: Instant,
    ) -> Result<PathBuf, CommandError> {
        let ticket = self.ticket.as_ref().ok_or_else(stale)?;
        if now.saturating_duration_since(ticket.issued) >= TICKET_LIFETIME {
            self.clear();
            return Err(stale());
        }
        if ticket.id != id || ticket.scope != *scope {
            return Err(stale());
        }
        Ok(self.ticket.take().expect("checked native drop ticket").path)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum NativeSourceDropEvent {
    Ready {
        drop_ticket: ExecutionId,
        folder_name: String,
        session_token: String,
        project_id: ExecutionId,
    },
    Rejected { error: CommandError },
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PluginSourceDropRequest {
        drop_ticket: ExecutionId,
        source: PluginSourceRequest
    }
);

/// Call only from Tauri's native window callback. No command registers paths.
pub(in crate::commands) fn on_window_event<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::WindowEvent,
) {
    if window.label() != "main" {
        return;
    }
    let paths = match event {
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
            // Do not copy an unbounded native list just to reject its arity.
            Some(if paths.len() == 1 { paths.clone() } else { Vec::new() })
        }
        tauri::WindowEvent::Destroyed => None,
        _ => return,
    };
    let destroyed = paths.is_none();
    let dropped_at = Instant::now();
    let label = window.label().to_owned();
    let registered = window.state::<AppState>().sessions.callback().submit(
        "source_native_drop",
        CommandStage::ExecutionRead,
        move |sessions| {
            if destroyed {
                if let Some(host) = sessions.active.as_mut().and_then(|active| active.execution.as_mut()) {
                    if host.source.plugin.native_drop.clear_window(&label)
                        .is_some_and(|picker| host.source.picker == Some(picker))
                    {
                        host.source.stop();
                    }
                }
                return Ok(None);
            }
            let active = sessions.active.as_ref().ok_or_else(stale)?;
            let token = active.token.clone();
            let project = ExecutionId::parse(&active.store.metadata()
                .map_err(|error| map_persistence_error(error, CommandStage::ExecutionRead))?
                .project_id().to_string()).map_err(map_source)?;
            let active = authorized(sessions, &token, project, CommandStage::ExecutionRead)?;
            let (host, _) = active.execution_parts()?;
            host.allow_mutation()?;
            let scope = DropScope {
                window: label,
                session_token: token,
                project_id: project,
                generation: host.runtime.generation(),
            };
            host.source.plugin.native_drop
                .register(scope, paths.expect("native drop paths"), dropped_at)
                .map(Some)
        },
    );
    let window = window.clone();
    match registered {
        Ok(registered) => {
            tauri::async_runtime::spawn(async move {
                match registered.await {
                    Ok(Some(event)) => { let _ = window.emit(EVENT, event); }
                    Err(error) if !destroyed => {
                        let _ = window.emit(EVENT, NativeSourceDropEvent::Rejected { error });
                    }
                    _ => {}
                }
            });
        }
        Err(error) if !destroyed => {
            let _ = window.emit(EVENT, NativeSourceDropEvent::Rejected { error });
        }
        Err(_) => {}
    }
}

#[tauri::command]
pub async fn select_dropped_plugin_source<R: tauri::Runtime>(
    window: tauri::Window<R>,
    state: State<'_, AppState>,
    request: PluginSourceDropRequest,
) -> Result<plugin::PluginSourceSelection, CommandError> {
    plugin::select_plugin_source_location::<R>(
        None,
        state,
        plugin::PluginSourceSelectRequest {
            session_token: request.session_token,
            project_id: request.project_id,
            source: request.source,
        },
        Some((window.label().to_owned(), request.drop_ticket)),
    )
    .await?
    .ok_or_else(stale)
}

#[cfg(test)]
mod tests;
