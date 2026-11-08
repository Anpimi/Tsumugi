//! A native invitation is scoped, short-lived and consumed before directory authorization.
use super::{AppState, CommandError, CommandStage, SessionManager};
use serde::Serialize;
use std::{path::PathBuf, time::{Duration, Instant}};
use tauri::{Emitter, Manager};
use tsumugi_core::execution::ExecutionId;

pub(super) fn submit_window_update<R, E>(
    window: &tauri::Window<R>,
    event_name: &'static str,
    operation: &'static str,
    reject: Option<fn(CommandError) -> E>,
    update: impl FnOnce(&mut SessionManager) -> Result<Option<E>, CommandError> + Send + 'static,
) where
    R: tauri::Runtime,
    E: Clone + Serialize + Send + 'static,
{
    let callback = window.state::<AppState>().sessions.callback();
    let event_window = window.clone();
    let admitted = callback.submit(operation, CommandStage::ExecutionRead, move |sessions| {
        let event = match update(sessions) {
            Ok(event) => event,
            Err(error) => {
                let error = error.report(operation, ExecutionId::new());
                reject.map(|rejected| rejected(error))
            }
        };
        if let Some(event) = event {
            // Queue notifications from the same owner that updates the ticket.
            // Independent reply waiters can resume out of order.
            let window = event_window.clone();
            let _ = event_window.run_on_main_thread(move || {
                let _ = window.emit(event_name, event);
            });
        }
        Ok(())
    });
    let Some(reject) = reject else { return; };
    match admitted {
        Ok(reply) => {
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = reply.await {
                    let _ = window.emit(event_name, reject(error));
                }
            });
        }
        Err(error) => { let _ = window.emit(event_name, reject(error)); }
    }
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
