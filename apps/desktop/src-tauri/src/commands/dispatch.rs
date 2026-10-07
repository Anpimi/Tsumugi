//! Bounded ownership of the project connection and desktop blocking work.
//!
//! Accepted operations finish even when their reply receiver disappears. A lost
//! reply is not evidence that a write was rolled back; callers reconcile by action.

use super::{CommandError, CommandErrorCode, CommandStage, SessionManager};
use std::{
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const PROJECT_CAPACITY: usize = 32;
const CONTROL_CAPACITY: usize = 4;
const TICK_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone)]
struct Capacity {
    used: Arc<AtomicUsize>,
    limit: usize,
}

impl Capacity {
    fn new(limit: usize) -> Self {
        Self {
            used: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }

    fn acquire(&self, stage: CommandStage) -> Result<Permit, CommandError> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                (used < self.limit).then_some(used + 1)
            })
            .map_err(|_| {
                CommandError::simple(CommandErrorCode::Busy, stage)
                    .report("admission", tsumugi_core::execution::ExecutionId::new())
            })?;
        Ok(Permit(Arc::clone(&self.used)))
    }
}

struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

type Work = Box<dyn FnOnce(&mut SessionManager) + Send>;
struct Job {
    work: Work,
    operation: &'static str,
    queued: Instant,
    _permit: Arc<Permit>,
}

struct SessionAdmission {
    sender: mpsc::Sender<Job>,
    normal: Capacity,
    control: Capacity,
    accepting: AtomicBool,
}

impl SessionAdmission {
    fn lease(&self, stage: CommandStage) -> Result<SessionLease, CommandError> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(CommandError::simple(
                CommandErrorCode::SessionInvalid,
                stage,
            ));
        }
        let capacity = if matches!(
            stage,
            CommandStage::Close | CommandStage::ExecutionCancel | CommandStage::ExecutionQuiesce
        ) {
            &self.control
        } else {
            &self.normal
        };
        Ok(SessionLease {
            sender: self.sender.clone(),
            permit: Arc::new(capacity.acquire(stage)?),
        })
    }
}

pub(super) struct SessionExecutor {
    admission: Arc<SessionAdmission>,
    changes: Arc<Mutex<Option<super::changes::ChangeSink>>>,
}

impl Drop for SessionExecutor {
    fn drop(&mut self) {
        // Another short callback may still hold a temporary upgrade. Closing
        // admission prevents that upgrade from keeping new work admissible;
        // existing leases and accepted jobs retain their original completion.
        self.admission.accepting.store(false, Ordering::Release);
    }
}

/// Cached consumers may submit short owner operations without keeping the
/// project connection alive. Each operation must recheck its original session
/// and authority inside the queued work; upgrading is only admission.
#[derive(Clone)]
pub(super) struct SessionCallback {
    admission: Weak<SessionAdmission>,
}

impl SessionCallback {
    pub(super) fn submit<T, F>(
        &self,
        operation: &'static str,
        stage: CommandStage,
        work: F,
    ) -> Result<
        impl std::future::Future<Output = Result<T, CommandError>> + Send + 'static + use<T, F>,
        CommandError,
    >
    where
        T: Send + 'static,
        F: FnOnce(&mut SessionManager) -> Result<T, CommandError> + Send + 'static,
    {
        let admission = self.admission.upgrade().ok_or_else(|| {
            CommandError::simple(CommandErrorCode::SessionInvalid, stage)
                .report(operation, tsumugi_core::execution::ExecutionId::new())
        })?;
        let lease = admission.lease(stage);
        drop(admission);
        let lease = lease.map_err(|error| {
            error.report(operation, tsumugi_core::execution::ExecutionId::new())
        })?;
        // The reply future owns no sender, lease or admission handle. Only the
        // already accepted job retains its permit after these locals drop.
        lease.submit(operation, stage, work)
    }
}

impl Default for SessionExecutor {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<Job>();
        let changes: Arc<Mutex<Option<super::changes::ChangeSink>>> = Arc::default();
        let sink = changes.clone();
        std::thread::Builder::new().name("project-commands".into()).spawn(move || {
            let mut sessions = SessionManager::default();
            let mut last_tick = Instant::now();
            let mut notifications = super::changes::Notifications::default();
            let mut sequence = 0_u64;
            let mut epoch = 0_u64;
            let mut token = None;
            loop {
                match receiver.recv_timeout(TICK_INTERVAL.saturating_sub(last_tick.elapsed())) {
                    Ok(job) => {
                        sequence = sequence.saturating_add(1);
                        let started = Instant::now();
                        let queue_time = started.duration_since(job.queued);
                        // Stop the owner on panic: continuing with possibly partial
                        // in-memory state could turn an unknown write into a retry.
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            (job.work)(&mut sessions);
                        }));
                        let current = sessions.active.as_ref().map(|active| active.token.clone());
                        if current != token {
                            epoch = epoch.saturating_add(1);
                            token = current;
                        }
                        let work_time = started.elapsed();
                        if queue_time + work_time >= Duration::from_millis(100) {
                            // Never log request bodies, paths, project IDs or session tokens.
                            eprintln!("desktop operation={} dispatch={} epoch={} queue_ms={} work_ms={}",
                                job.operation, sequence, epoch, queue_time.as_millis(), work_time.as_millis());
                        }
                        drop(job._permit);
                        if result.is_err() { break; }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                let callback = sink.lock().expect("change sink poisoned").clone();
                if let Some(callback) = callback {
                    notifications.publish(&sessions, &callback);
                }
                if last_tick.elapsed() >= TICK_INTERVAL {
                    super::execution::tick_sessions(&mut sessions);
                    last_tick = Instant::now();
                    let callback = sink.lock().expect("change sink poisoned").clone();
                    if let Some(callback) = callback {
                        notifications.publish(&sessions, &callback);
                    }
                }
            }
        }).expect("failed to start project command thread");
        Self {
            admission: Arc::new(SessionAdmission {
                sender,
                normal: Capacity::new(PROJECT_CAPACITY),
                control: Capacity::new(CONTROL_CAPACITY),
                accepting: AtomicBool::new(true),
            }),
            changes,
        }
    }
}

impl SessionExecutor {
    pub(super) fn set_change_sink(&self, sink: Option<super::changes::ChangeSink>) {
        *self.changes.lock().expect("change sink poisoned") = sink;
    }

    pub(super) fn lease(&self, stage: CommandStage) -> Result<SessionLease, CommandError> {
        self.admission.lease(stage)
    }

    pub(super) fn callback(&self) -> SessionCallback {
        SessionCallback {
            admission: Arc::downgrade(&self.admission),
        }
    }

    pub(super) async fn run<T: Send + 'static>(
        &self,
        operation: &'static str,
        stage: CommandStage,
        work: impl FnOnce(&mut SessionManager) -> Result<T, CommandError> + Send + 'static,
    ) -> Result<T, CommandError> {
        self.lease(stage)
            .map_err(|error| error.report(operation, tsumugi_core::execution::ExecutionId::new()))?
            .run(operation, stage, work)
            .await
    }

    #[cfg(any(test, feature = "execution-test-host"))]
    pub(super) fn with<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut SessionManager) -> T + Send + 'static,
    ) -> T {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.lease(CommandStage::ExecutionRead)
            .expect("fixture capacity exhausted")
            .enqueue(
                "fixture",
                CommandStage::ExecutionRead,
                Box::new(move |sessions| {
                    let _ = sender.send(work(sessions));
                }),
            )
            .expect("fixture dispatch failed");
        receiver.recv().expect("fixture project owner stopped")
    }

    #[cfg(test)]
    pub(super) fn pause(&self) -> Pause {
        let (entered, started) = mpsc::sync_channel(1);
        let (release, wait) = mpsc::sync_channel(1);
        self.lease(CommandStage::ExecutionRead)
            .unwrap()
            .enqueue(
                "test-barrier",
                CommandStage::ExecutionRead,
                Box::new(move |_| {
                    entered.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(10))
                        .expect("test did not release project owner");
                }),
            )
            .unwrap();
        started
            .recv_timeout(Duration::from_secs(5))
            .expect("project owner did not reach barrier");
        Pause(Some(release))
    }
}

#[cfg(test)]
pub(super) struct Pause(Option<mpsc::SyncSender<()>>);
#[cfg(test)]
impl Drop for Pause {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}

/// A split capture reserves admission until its final session recheck. Otherwise
/// a full queue could reject cleanup and strand the project's in-flight marker.
/// Use one sequential operation at a time for each lease.
pub(super) struct SessionLease {
    sender: mpsc::Sender<Job>,
    permit: Arc<Permit>,
}

impl SessionLease {
    fn enqueue(
        &self,
        operation: &'static str,
        stage: CommandStage,
        work: Work,
    ) -> Result<(), CommandError> {
        self.sender
            .send(Job {
                work,
                operation,
                queued: Instant::now(),
                _permit: Arc::clone(&self.permit),
            })
            .map_err(|_| CommandError::unknown(stage))
    }

    pub(super) async fn run<T: Send + 'static>(
        &self,
        operation: &'static str,
        stage: CommandStage,
        work: impl FnOnce(&mut SessionManager) -> Result<T, CommandError> + Send + 'static,
    ) -> Result<T, CommandError> {
        self.submit(operation, stage, work)?.await
    }

    /// Enqueue before handing ownership to an asynchronous continuation. This
    /// preserves command order while the continuation survives a lost IPC waiter.
    pub(super) fn submit<T, F>(
        &self,
        operation: &'static str,
        stage: CommandStage,
        work: F,
    ) -> Result<
        impl std::future::Future<Output = Result<T, CommandError>> + Send + 'static + use<T, F>,
        CommandError,
    >
    where
        T: Send + 'static,
        F: FnOnce(&mut SessionManager) -> Result<T, CommandError> + Send + 'static,
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let diagnostic_id = tsumugi_core::execution::ExecutionId::new();
        self.enqueue(
            operation,
            stage,
            Box::new(move |sessions| {
                let result = work(sessions).map_err(|error| error.report(operation, diagnostic_id));
                let _ = sender.try_send(result);
            }),
        )
        .map_err(|error| error.report(operation, diagnostic_id))?;
        Ok(async move {
            receiver
                .recv()
                .await
                .ok_or_else(|| CommandError::unknown(stage).report(operation, diagnostic_id))?
        })
    }
}

/// File/capture work may run independently of the project owner. Admission is
/// bounded before spawning, and the permit lives with the work, not its waiter.
#[derive(Clone)]
pub(super) struct BlockingExecutor(Capacity);

impl BlockingExecutor {
    pub(super) fn new(limit: usize) -> Self {
        Self(Capacity::new(limit))
    }

    pub(super) async fn run<T: Send + 'static>(
        &self,
        stage: CommandStage,
        work: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
    ) -> Result<T, CommandError> {
        let diagnostic_id = tsumugi_core::execution::ExecutionId::new();
        let permit = self
            .0
            .acquire(stage)
            .map_err(|error| error.report("blocking-work", diagnostic_id))?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            work().map_err(|error| error.report("blocking-work", diagnostic_id))
        })
        .await
        .map_err(|_| CommandError::unknown(stage).report("blocking-work", diagnostic_id))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{
        CloseProjectRequest, CreateProjectRequest, ReadProjectRequest, RenameProjectRequest,
    };
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll, Waker},
    };

    fn pending<T>(future: Pin<&mut impl Future<Output = T>>) {
        assert!(matches!(
            future.poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
    }

    #[test]
    fn command_error_dispatch_retains_evidence_and_marks_an_owner_panic_unknown() {
        let executor = SessionExecutor::default();
        let current = tsumugi_core::execution::ExecutionId::new();
        let conflict = tsumugi_core::execution::ConflictEvidence::TranslationSelection {
            expected: None,
            current: Some(current),
        };
        let expected = conflict.clone();
        let error = tauri::async_runtime::block_on(executor.run::<()>(
            "controlled-save",
            CommandStage::ExecutionAdopt,
            move |_| {
                let mut error = CommandError::simple(
                    CommandErrorCode::DependencyConflict,
                    CommandStage::ExecutionAdopt,
                );
                error.conflict = Some(conflict);
                Err(error)
            },
        ))
        .unwrap_err();
        assert_eq!(error.conflict, Some(expected));
        assert_eq!(error.outcome, super::super::CommandOutcome::Rejected);
        assert!(error.diagnostic_id.is_some());
        let prior = error.diagnostic_id;
        let error = tauri::async_runtime::block_on(executor.run::<()>(
            "controlled-panic",
            CommandStage::ExecutionAdopt,
            |_| panic!("controlled owner failure"),
        ))
        .unwrap_err();
        assert_eq!(error.outcome, super::super::CommandOutcome::Unknown);
        assert!(error.recovery_required);
        assert_eq!(
            error.recovery_guidance,
            Some(super::super::RecoveryGuidance::ReconcileOriginal)
        );
        assert!(error.diagnostic_id.is_some() && error.diagnostic_id != prior);
    }

    #[test]
    fn saturated_work_keeps_control_admission_and_capture_completion_bounded() {
        let executor = SessionExecutor::default();
        let callback = executor.callback();
        let capture = executor.lease(CommandStage::ExecutionRead).unwrap();
        let held = executor.pause();
        let reservations: Vec<_> = (0..PROJECT_CAPACITY - 2)
            .map(|_| executor.lease(CommandStage::ExecutionRead).unwrap())
            .collect();
        assert_eq!(
            executor
                .lease(CommandStage::ExecutionRead)
                .err()
                .unwrap()
                .code,
            CommandErrorCode::Busy
        );
        let error = callback
            .submit(
                "callback.saturated",
                CommandStage::ExecutionRead,
                |_| Ok(()),
            )
            .err()
            .unwrap();
        assert_eq!(error.code, CommandErrorCode::Busy);
        assert!(error.diagnostic_id.is_some());
        let controls: Vec<_> = (0..CONTROL_CAPACITY)
            .map(|_| {
                callback
                    .submit("callback.cancel", CommandStage::ExecutionCancel, |_| Ok(()))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            executor.lease(CommandStage::Close).err().unwrap().code,
            CommandErrorCode::Busy
        );
        assert_eq!(
            callback
                .submit("callback.close", CommandStage::Close, |_| Ok(()))
                .err()
                .unwrap()
                .code,
            CommandErrorCode::Busy
        );
        let mut finish =
            Box::pin(capture.run("capture.finish", CommandStage::ExecutionRead, |_| Ok(42)));
        pending(finish.as_mut());
        drop(held);
        assert_eq!(tauri::async_runtime::block_on(finish).unwrap(), 42);
        drop(reservations);
        drop(controls);
        assert!(executor.lease(CommandStage::ExecutionRead).is_ok());
    }

    #[test]
    fn weak_submission_enters_fifo_before_polling_and_survives_a_lost_reply() {
        let executor = SessionExecutor::default();
        let callback = executor.callback();
        let held = executor.pause();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let first = writes.clone();
        let lost = callback
            .submit("callback.first", CommandStage::Rename, move |_| {
                first.lock().unwrap().push(1);
                Ok(())
            })
            .unwrap();
        let second = writes.clone();
        let reply = callback
            .submit("callback.second", CommandStage::Rename, move |_| {
                second.lock().unwrap().push(2);
                Ok(())
            })
            .unwrap();
        drop(lost);
        assert!(writes.lock().unwrap().is_empty());
        drop(held);
        tauri::async_runtime::block_on(reply).unwrap();
        executor.with(|_| ());
        assert_eq!(*writes.lock().unwrap(), vec![1, 2]);
    }

    #[test]
    fn cached_weak_callback_rejects_new_work_after_owner_drop_and_releases_the_project() {
        struct OwnerDropProbe(mpsc::Sender<()>);
        impl Drop for OwnerDropProbe {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }

        let root = tempfile::tempdir().unwrap();
        let executor = SessionExecutor::default();
        let callback = executor.callback();
        let cached = callback.clone();
        let (stopped, owner_stopped) = mpsc::channel();
        let probe = OwnerDropProbe(stopped);
        executor.set_change_sink(Some(Arc::new(move |_| {
            // The owner retains the same kind of weak handle as a cached broker.
            let _ = (cached.clone(), &probe);
        })));
        let destination = root.path().join("project").to_string_lossy().into_owned();
        let view = tauri::async_runtime::block_on(executor.run(
            "create",
            CommandStage::Create,
            move |sessions| {
                sessions.create(CreateProjectRequest {
                    destination,
                    display_name: "Original".into(),
                    source_locale: "en".into(),
                    target_locales: vec!["zh-CN".into()],
                })
            },
        ))
        .unwrap();
        let writes = Arc::new(AtomicUsize::new(0));
        let completion = executor.lease(CommandStage::ExecutionRead).unwrap();
        let written = writes.clone();
        let (entered, started) = mpsc::sync_channel(1);
        let (release, wait) = mpsc::sync_channel(1);
        let reply = callback
            .submit("callback.rename", CommandStage::Rename, move |sessions| {
                entered.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                let result = sessions.rename(RenameProjectRequest {
                    session_token: view.session_token,
                    expected_revision: "1".into(),
                    display_name: "Accepted once".into(),
                    directory_name: None,
                })?;
                written.fetch_add(1, Ordering::AcqRel);
                Ok(result)
            })
            .unwrap();
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        // Simulate a concurrent submission paused after its temporary upgrade.
        let upgraded = callback.admission.upgrade().unwrap();
        drop(executor);
        let rejected = callback
            .submit("callback.after-drop", CommandStage::Close, |_| Ok(()))
            .err();
        // Previously admitted split work may still finish and release its slot.
        let finished = completion.submit(
            "capture.finish-after-drop",
            CommandStage::ExecutionRead,
            |_| Ok(42),
        );
        drop(completion);
        // Always release accepted work before assertions so a failing lifecycle
        // check cannot strand the owner's bounded test barrier.
        drop(reply);
        release.send(()).unwrap();
        drop(upgraded);
        let error = rejected.expect("a cached callback kept admission alive");
        assert_eq!(error.code, CommandErrorCode::SessionInvalid);
        assert!(error.diagnostic_id.is_some());
        assert_eq!(
            tauri::async_runtime::block_on(finished.unwrap()).unwrap(),
            42
        );
        owner_stopped
            .recv_timeout(Duration::from_secs(5))
            .expect("the cached weak callback kept the project owner alive");
        assert_eq!(writes.load(Ordering::Acquire), 1);
        let store = tsumugi_core::ProjectStore::open(root.path().join("project")).unwrap();
        assert_eq!(store.metadata().unwrap().display_name(), "Accepted once");
        store.close().unwrap();
    }

    #[test]
    fn queued_write_close_and_switch_recheck_session_at_execution() {
        let root = tempfile::tempdir().unwrap();
        let executor = SessionExecutor::default();
        let destination = root.path().join("first").to_string_lossy().into_owned();
        let first = tauri::async_runtime::block_on(executor.run(
            "create",
            CommandStage::Create,
            move |sessions| {
                sessions.create(CreateProjectRequest {
                    destination,
                    display_name: "First".into(),
                    source_locale: "en".into(),
                    target_locales: vec!["zh-CN".into()],
                })
            },
        ))
        .unwrap();
        let held = executor.pause();
        let token = first.session_token.clone();
        let mut save = Box::pin(
            executor.run("rename", CommandStage::Rename, move |sessions| {
                sessions.rename(RenameProjectRequest {
                    session_token: token,
                    expected_revision: "1".into(),
                    display_name: "Saved before close".into(),
                    directory_name: None,
                })
            }),
        );
        pending(save.as_mut());
        let token = first.session_token.clone();
        let mut close = Box::pin(executor.run("close", CommandStage::Close, move |sessions| {
            sessions.close(CloseProjectRequest {
                session_token: token,
            })
        }));
        pending(close.as_mut());
        let destination = root.path().join("second").to_string_lossy().into_owned();
        let mut next = Box::pin(
            executor.run("create", CommandStage::Create, move |sessions| {
                sessions.create(CreateProjectRequest {
                    destination,
                    display_name: "Second".into(),
                    source_locale: "en".into(),
                    target_locales: vec!["zh-CN".into()],
                })
            }),
        );
        pending(next.as_mut());
        let mut late =
            Box::pin(
                executor.run("late-rename", CommandStage::Rename, move |sessions| {
                    sessions.rename(RenameProjectRequest {
                        session_token: first.session_token,
                        expected_revision: "1".into(),
                        display_name: "Must not reach second".into(),
                        directory_name: None,
                    })
                }),
            );
        pending(late.as_mut());
        drop(held);
        // Dropping an accepted write's receiver does not remove the write from FIFO.
        drop(save);
        assert!(tauri::async_runtime::block_on(close).unwrap().closed);
        let second = tauri::async_runtime::block_on(next).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(late).unwrap_err().code,
            CommandErrorCode::SessionInvalid
        );
        let current = tauri::async_runtime::block_on(executor.run(
            "read",
            CommandStage::Read,
            move |sessions| {
                sessions.read(ReadProjectRequest {
                    session_token: second.session_token,
                    expected_revision: None,
                })
            },
        ))
        .unwrap();
        assert_eq!(current.metadata.display_name, "Second");
        let stored = tsumugi_core::ProjectStore::open(root.path().join("first")).unwrap();
        assert_eq!(
            stored.metadata().unwrap().display_name(),
            "Saved before close"
        );
        stored.close().unwrap();
        executor.with(|sessions| {
            let token = sessions.active.as_ref().unwrap().token.clone();
            sessions
                .close(CloseProjectRequest {
                    session_token: token,
                })
                .unwrap();
        });
    }

    #[test]
    fn dropped_io_waiter_does_not_release_a_running_slot() {
        let executor = BlockingExecutor::new(1);
        let (entered, started) = mpsc::sync_channel(1);
        let (release, wait) = mpsc::sync_channel(1);
        let mut work = Box::pin(executor.run(CommandStage::ExecutionRead, move || {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        }));
        pending(work.as_mut());
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(work);
        assert_eq!(
            tauri::async_runtime::block_on(executor.run(CommandStage::ExecutionRead, || Ok(())))
                .unwrap_err()
                .code,
            CommandErrorCode::Busy
        );
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while executor.0.used.load(Ordering::Acquire) != 0 {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        tauri::async_runtime::block_on(executor.run(CommandStage::ExecutionRead, || Ok(())))
            .unwrap();
    }

    #[test]
    fn panicked_project_work_stops_the_owner_instead_of_replaying() {
        let executor = SessionExecutor::default();
        let failure = tauri::async_runtime::block_on(executor.run::<()>(
            "panic",
            CommandStage::ExecutionAdopt,
            |_| panic!("synthetic failure"),
        ))
        .unwrap_err();
        assert_eq!(failure.code, CommandErrorCode::OutcomeUnknown);
        let next =
            tauri::async_runtime::block_on(
                executor.run("after-panic", CommandStage::Read, |_| Ok(())),
            )
            .unwrap_err();
        assert_eq!(next.code, CommandErrorCode::OutcomeUnknown);
    }
}
