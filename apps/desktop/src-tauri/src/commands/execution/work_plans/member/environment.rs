//! Local contention waits retain the original member lifetime and authority.
use super::*;

pub(in crate::commands::execution::work_plans) enum EnvironmentAttempt<T> {
    Waiting,
    Complete(Result<T, CommandError>),
}
fn plugin_busy(error: &CommandError) -> bool {
    error.code == CommandErrorCode::Busy && error.reason.as_deref() == Some("plugin-store-busy")
}
impl<T> EnvironmentAttempt<T> {
    // Only a completely read-only capture may use this classification.
    pub(in crate::commands::execution::work_plans) fn read_only(result: Result<T, CommandError>) -> Self {
        if result.as_ref().is_err_and(|error| plugin_busy(error)) {
            Self::Waiting
        } else {
            Self::Complete(result)
        }
    }
}

#[derive(Clone)]
pub(in crate::commands::execution::work_plans) struct EnvironmentAdmission {
    deadline: Instant,
    stops: Vec<Cancellation>,
}
impl EnvironmentAdmission {
    pub(in crate::commands::execution::work_plans) fn new(deadline: Instant, stops: Vec<Cancellation>) -> Self {
        Self { deadline, stops }
    }
    pub(in crate::commands::execution::work_plans) fn check(&self) -> Result<(), ExecutionError> {
        if self.stops.iter().any(Cancellation::is_requested) {
            return Err(fail(ErrorCode::Cancelled, "member-cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(fail(ErrorCode::Cancelled, "member-deadline"));
        }
        Ok(())
    }
    pub(super) fn enter<T>(
        &self,
        plugins: &ApplicationPlugins,
        revision: UnsignedDecimal,
        current: impl FnOnce() -> Result<(), ExecutionError>,
        operation: impl FnOnce(Cancellation) -> Result<T, CommandError>,
    ) -> EnvironmentAttempt<T> {
        if let Err(error) = self.check() {
            return EnvironmentAttempt::Complete(Err(map_recover(error)));
        }
        let mut entered = false;
        let result = plugins.with_environment_authority(revision, |settings| {
            self.check().and_then(|()| current()).map_err(map_recover)?;
            entered = true;
            operation(settings)
        });
        if !entered && result.as_ref().is_err_and(|error| plugin_busy(error)) {
            EnvironmentAttempt::Waiting
        } else {
            EnvironmentAttempt::Complete(result)
        }
    }
    pub(in crate::commands::execution::work_plans) async fn wait<T, F, Fut>(
        &self,
        current: impl Fn() -> Result<(), ExecutionError>,
        mut attempt: F,
    ) -> Result<T, ExecutionError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<EnvironmentAttempt<T>, CommandError>>,
    {
        loop {
            self.check()?;
            current()?;
            match attempt().await.map_err(command_error)? {
                EnvironmentAttempt::Complete(result) => return result.map_err(command_error),
                EnvironmentAttempt::Waiting => {
                    self.check()?;
                    current()?;
                    // No SessionOwner or IO worker is occupied during this wait.
                    tokio::time::sleep(
                        Duration::from_millis(10)
                            .min(self.deadline.saturating_duration_since(Instant::now())),
                    )
                    .await;
                }
            }
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        sync::mpsc,
    };

    struct Installed {
        plugins: Arc<ApplicationPlugins>,
        _directory: tempfile::TempDir,
    }
    impl Installed {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let plugins = Arc::new(ApplicationPlugins::default());
            plugins
                .configure(directory.path().join("application"))
                .unwrap();
            plugins
                .with_environment_revision(0_u64.into(), || Ok(()))
                .unwrap();
            Self {
                plugins,
                _directory: directory,
            }
        }
        fn hold(&self) -> Held {
            let plugins = self.plugins.clone();
            let (entered, wait) = mpsc::sync_channel(1);
            let (release, released) = mpsc::sync_channel(1);
            let thread = std::thread::spawn(move || {
                plugins
                    .with_environment_revision(0_u64.into(), || {
                        entered.send(()).unwrap();
                        released.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(())
                    })
                    .unwrap();
            });
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Held {
                release: Some(release),
                thread: Some(thread),
            }
        }
    }
    struct Held {
        release: Option<mpsc::SyncSender<()>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Held {
        fn release(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
        }
    }
    impl Drop for Held {
        fn drop(&mut self) {
            self.release();
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }
    fn busy(reason: &str) -> CommandError {
        let mut error = CommandError::simple(CommandErrorCode::Busy, CommandStage::Read);
        error.reason = Some(reason.into());
        error
    }

    #[test]
    fn member_environment_waits_before_entry_and_enters_once_after_release() {
        let installed = Installed::new();
        let mut held = installed.hold();
        let admission = EnvironmentAdmission::new(Instant::now() + Duration::from_secs(2), vec![]);
        assert!(matches!(
            EnvironmentAttempt::read_only(
                installed.plugins.capture_member_environment(None, || true)
            ),
            EnvironmentAttempt::Waiting
        ));
        let entered = Cell::new(0);
        let waited = Cell::new(false);
        let tickets = RefCell::new(crate::commands::execution::tools::ToolSession::default());
        let ticket = tickets.borrow_mut().begin(ExecutionId::new()).unwrap();
        runtime()
            .block_on(admission.wait(
                || Ok(()),
                || {
                    let result = admission.enter(
                        &installed.plugins,
                        0_u64.into(),
                        || Ok(()),
                        |_| {
                            entered.set(entered.get() + 1);
                            tickets.borrow_mut().abandon(ticket)?;
                            Ok(())
                        },
                    );
                    if matches!(result, EnvironmentAttempt::Waiting) {
                        assert_eq!(entered.get(), 0);
                        assert!(tickets.borrow().active());
                        waited.set(true);
                        held.release();
                    }
                    std::future::ready(Ok(result))
                },
            ))
            .unwrap();
        assert!(waited.get());
        assert_eq!(entered.get(), 1);
        assert!(!tickets.borrow().active());
        let next = tickets.borrow_mut().begin(ExecutionId::new()).unwrap();
        assert!(tickets.borrow_mut().abandon(ExecutionId::new()).is_err());
        assert!(tickets.borrow().active());
        tickets.borrow_mut().abandon(next).unwrap();
    }

    #[test]
    fn member_environment_wait_preserves_each_stop_and_original_deadline() {
        for stopped in 0..3 {
            let installed = Installed::new();
            let _held = installed.hold();
            let stops = vec![
                Cancellation::default(),
                Cancellation::default(),
                Cancellation::default(),
            ];
            let admission =
                EnvironmentAdmission::new(Instant::now() + Duration::from_secs(2), stops.clone());
            let entered = Cell::new(0);
            let error = runtime()
                .block_on(admission.wait(
                    || Ok(()),
                    || {
                        let result = admission.enter(
                            &installed.plugins,
                            0_u64.into(),
                            || Ok(()),
                            |_| {
                                entered.set(entered.get() + 1);
                                Ok(())
                            },
                        );
                        assert!(matches!(result, EnvironmentAttempt::Waiting));
                        stops[stopped].request();
                        std::future::ready(Ok(result))
                    },
                ))
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::Cancelled);
            assert_eq!(entered.get(), 0);
        }
        let installed = Installed::new();
        let _held = installed.hold();
        let deadline = Instant::now() + Duration::from_millis(30);
        let admission = EnvironmentAdmission::new(deadline, vec![]);
        let entered = Cell::new(0);
        let error = runtime()
            .block_on(admission.wait(
                || Ok(()),
                || {
                    std::future::ready(Ok(admission.enter(
                        &installed.plugins,
                        0_u64.into(),
                        || Ok(()),
                        |_| {
                            entered.set(entered.get() + 1);
                            Ok(())
                        },
                    )))
                },
            ))
            .unwrap_err();
        assert_eq!(error.stage, "member-deadline");
        assert_eq!(entered.get(), 0);
    }

    #[test]
    fn member_environment_rechecks_revision_and_never_replays_entered_errors() {
        let installed = Installed::new();
        let mut held = installed.hold();
        let admission = EnvironmentAdmission::new(Instant::now() + Duration::from_secs(2), vec![]);
        let entered = Cell::new(0);
        let error = runtime()
            .block_on(admission.wait(
                || Ok(()),
                || {
                    let result = admission.enter(
                        &installed.plugins,
                        1_u64.into(),
                        || Ok(()),
                        |_| {
                            entered.set(entered.get() + 1);
                            Ok(())
                        },
                    );
                    if matches!(result, EnvironmentAttempt::Waiting) {
                        held.release();
                    }
                    std::future::ready(Ok(result))
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict);
        assert_eq!(entered.get(), 0);
        let attempts = Cell::new(0);
        let error = runtime()
            .block_on(admission.wait(
                || Ok(()),
                || {
                    attempts.set(attempts.get() + 1);
                    std::future::ready(Ok(admission.enter(
                        &installed.plugins,
                        0_u64.into(),
                        || Ok(()),
                        |_| {
                            entered.set(entered.get() + 1);
                            Err::<(), _>(busy("plugin-store-busy"))
                        },
                    )))
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Busy);
        assert_eq!(attempts.get(), 1);
        assert_eq!(entered.get(), 1);
        for reason in ["execution-storage", "owner-busy"] {
            let attempts = Cell::new(0);
            let error = runtime()
                .block_on(admission.wait(
                    || Ok(()),
                    || {
                        attempts.set(attempts.get() + 1);
                        std::future::ready(Ok(EnvironmentAttempt::<()>::read_only(Err(busy(
                            reason,
                        )))))
                    },
                ))
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::Busy);
            assert_eq!(attempts.get(), 1);
        }
    }

    #[test]
    fn member_environment_rechecks_live_scope_and_propagates_unknown() {
        let installed = Installed::new();
        let mut held = installed.hold();
        let admission = EnvironmentAdmission::new(Instant::now() + Duration::from_secs(2), vec![]);
        let live = Cell::new(true);
        let entered = Cell::new(0);
        let error = runtime()
            .block_on(admission.wait(
                || {
                    if live.get() {
                        Ok(())
                    } else {
                        Err(fail(ErrorCode::Unauthorized, "original-scope-stopped"))
                    }
                },
                || {
                    let result = admission.enter(
                        &installed.plugins,
                        0_u64.into(),
                        || Ok(()),
                        |_| {
                            entered.set(entered.get() + 1);
                            Ok(())
                        },
                    );
                    assert!(matches!(result, EnvironmentAttempt::Waiting));
                    live.set(false);
                    held.release();
                    std::future::ready(Ok(result))
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Unauthorized);
        assert_eq!(entered.get(), 0);
        let attempts = Cell::new(0);
        let error = runtime()
            .block_on(admission.wait(
                || Ok(()),
                || {
                    attempts.set(attempts.get() + 1);
                    std::future::ready(Ok(EnvironmentAttempt::<()>::read_only(Err(
                        CommandError::unknown(CommandStage::ExecutionRecover),
                    ))))
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::OutcomeUnknown);
        assert_eq!(attempts.get(), 1);
    }
}
