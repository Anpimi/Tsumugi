//! A native invitation is scoped, short-lived and consumed before directory authorization.
use std::{path::PathBuf, time::{Duration, Instant}};
use tsumugi_core::execution::ExecutionId;

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
