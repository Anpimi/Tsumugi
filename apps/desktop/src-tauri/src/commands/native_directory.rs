//! A native invitation is scoped, short-lived and consumed before directory authorization.
use super::{
    AppState, CommandError, CommandStage,
    execution::source::native_drop::{self, NativeSourceDropEvent},
    startup::{self, StartupDropEvent},
};
use serde::Serialize;
use std::{path::PathBuf, time::{Duration, Instant}};
use tauri::{Emitter, Manager};
use tsumugi_core::execution::ExecutionId;

const DROP_OPERATION: &str = "native_directory_drop";

/// Route each native event with the session state seen by its single owner job.
pub(super) fn on_window_event<R: tauri::Runtime>(
    window: &tauri::Window<R>, event: &tauri::WindowEvent,
) {
    if window.label() != "main" { return; }
    let paths = match event {
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
            // Reject the arity without copying an unbounded native list.
            Some(if paths.len() == 1 { paths.clone() } else { Vec::new() })
        }
        tauri::WindowEvent::Destroyed => None,
        _ => return,
    };
    let destroyed = paths.is_none();
    let owner = window.label().to_owned();
    let now = Instant::now();
    let callback = window.state::<AppState>().sessions.callback();
    let event_window = window.clone();
    let admitted = callback.submit(DROP_OPERATION, CommandStage::ExecutionRead, move |sessions| {
        let Some(paths) = paths else {
            sessions.startup.clear_window(&owner);
            native_drop::clear_window(sessions, &owner);
            return Ok(());
        };
        if let Some(active) = &sessions.active {
            let token = active.token.clone();
            let event = native_drop::register_window_drop(sessions, &token, owner, paths, now)
                .unwrap_or_else(|error| NativeSourceDropEvent::Rejected {
                    error: error.report(DROP_OPERATION, ExecutionId::new()),
                });
            publish(&event_window, native_drop::DROP_EVENT, event);
        } else {
            let event = startup::register_window_drop(sessions, owner, paths, now)
                .unwrap_or_else(|error| StartupDropEvent::Rejected {
                    error: error.report(DROP_OPERATION, ExecutionId::new()),
                });
            publish(&event_window, startup::DROP_EVENT, event);
        }
        Ok(())
    });
    if destroyed { return; }
    match admitted {
        Ok(reply) => {
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = reply.await {
                    emit_dispatch_error(&window, error);
                }
            });
        }
        Err(error) => emit_dispatch_error(window, error),
    }
}

fn publish<R: tauri::Runtime, E: Clone + Serialize + Send + 'static>(
    window: &tauri::Window<R>, event_name: &'static str, event: E,
) {
    // Queue from the same owner that changes the ticket. Independent reply
    // waiters can resume out of order.
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = target.emit(event_name, event);
    });
}

fn emit_dispatch_error<R: tauri::Runtime>(window: &tauri::Window<R>, error: CommandError) {
    // A dispatch failure has no known session route and changes no ticket.
    let _ = window.emit(startup::DROP_EVENT, StartupDropEvent::Rejected { error: error.clone() });
    let _ = window.emit(native_drop::DROP_EVENT, NativeSourceDropEvent::Rejected { error });
}

pub(super) const LIFETIME: Duration = Duration::from_secs(60);
pub(super) trait Scope: PartialEq { fn window(&self) -> &str; }
pub(super) struct Drop<S> { id: ExecutionId, scope: S, path: PathBuf, issued: Instant }
#[derive(Debug)]
pub(super) enum Rejected { Arity, Stale, Expired }

impl<S: Scope> Drop<S> {
    pub(super) fn register(slot: &mut Option<Self>, scope: S, paths: Vec<PathBuf>, now: Instant) -> Result<(ExecutionId, String), Rejected> {
        *slot = None;
        if paths.len() != 1 { return Err(Rejected::Arity); }
        let path = paths.into_iter().next().expect("one native path");
        let label = path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned();
        let id = ExecutionId::new();
        *slot = Some(Self { id, scope, path, issued: now });
        Ok((id, label))
    }
    pub(super) fn consume(slot: &mut Option<Self>, id: ExecutionId, scope: &S, now: Instant) -> Result<PathBuf, Rejected> {
        let current = slot.as_ref().ok_or(Rejected::Stale)?;
        if now.saturating_duration_since(current.issued) >= LIFETIME { *slot = None; return Err(Rejected::Expired); }
        if current.id != id || current.scope != *scope { return Err(Rejected::Stale); }
        Ok(slot.take().expect("checked native invitation").path)
    }
    pub(super) fn clear_window(slot: &mut Option<Self>, window: &str) {
        if slot.as_ref().is_some_and(|current| current.scope.window() == window) { *slot = None; }
    }
}
