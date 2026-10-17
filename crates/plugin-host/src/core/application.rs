//! One application-owned process lifetime. Idle Host records retain neither a
//! project connection nor the previous invocation's permit, input or deadline.
//! The unsandboxed component can retain its own previously supplied data.
use super::*;
use crate::session::LaunchCleanup;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::{collections::BTreeMap, thread::JoinHandle, time::Instant};
use tsumugi_core::execution::{ApplicationExecutionLease, ApplicationScopeBasis, ExecutionId};

struct Call {
    request: DispatchRequest,
    cancellation: Cancellation,
    reply: mpsc::SyncSender<Result<FixedResult, ExecutionError>>,
}
struct Ready {
    deadline: Instant,
    cancellation: Cancellation,
    reply: mpsc::SyncSender<Result<(), ExecutionError>>,
}
enum Work {
    Call(Call),
    Ready(Ready),
}
impl Work {
    fn reject(self) {
        match self {
            Self::Call(call) => {
                let _ = call.reply.send(Err(denied()));
            }
            Self::Ready(ready) => {
                let _ = ready.reply.send(Err(denied()));
            }
        }
    }
}
struct Control {
    original: Option<ExecutionId>,
    lease: Option<ApplicationExecutionLease>,
    sender: Option<tokio::sync::mpsc::Sender<Work>>,
    thread: Option<JoinHandle<()>>,
}
pub struct ApplicationInstance {
    basis: ApplicationScopeBasis,
    proxies: BTreeMap<String, RunnerProxy>,
    bindings: Vec<PluginExecutionBinding>,
    revocation: Cancellation,
    finished: Arc<AtomicBool>,
    cleanup_confirmed: Arc<AtomicBool>,
    control: Mutex<Control>,
}
fn denied() -> ExecutionError {
    ExecutionError::new(ErrorCode::Unauthorized, "application-instance-lease")
}
fn check_ready(deadline: Instant, cancellation: &Cancellation) -> Result<(), ExecutionError> {
    if cancellation.is_requested() {
        Err(ExecutionError::new(
            ErrorCode::Cancelled,
            "application-instance-ready-cancelled",
        ))
    } else if Instant::now() >= deadline {
        Err(ExecutionError::new(
            ErrorCode::OutcomeUnknown,
            "application-instance-ready-timeout",
        ))
    } else {
        Ok(())
    }
}
impl ApplicationInstance {
    pub fn validate_selection(
        image: &PackageImage,
        resource_id: &str,
        runtime: &RunnerRuntime,
    ) -> Result<(), ExecutionError> {
        let tool = image.capability_tool(resource_id).map_err(|_| denied())?;
        super::validate_application_selection(image, &tool.capability, runtime)
    }
    /// Reserve exact identity only. No runtime or component instructions start
    /// until a human separately authorizes this application's instance lifetime.
    pub fn reserve(
        image: PackageImage,
        resource_id: &str,
        runtime: RunnerRuntime,
        staging_parent: PathBuf,
        limits: HostLimits,
    ) -> Result<Arc<Self>, ExecutionError> {
        let tool = image.capability_tool(resource_id).map_err(|_| denied())?;
        let basis = ApplicationScopeBasis {
            instance_id: ExecutionId::new(),
            activation_generation: 1,
        };
        super::validate_application_selection(&image, &tool.capability, &runtime)?;
        let roster =
            crate::session::application_roster(&image, &tool.capability.provider.component_id)
                .map_err(|_| denied())?;
        let mut proxies = BTreeMap::new();
        let mut bindings = Vec::new();
        let mut bytes = 2usize;
        for member in roster {
            let proxy = RunnerProxy::new_inner(
                image.clone(),
                member.contribution_id.clone(),
                runtime.clone(),
                staging_parent.clone(),
                limits.clone(),
                Some(basis.clone()),
            )?;
            let profiles = if member.capability.profiles.is_empty() {
                vec![None]
            } else {
                member.capability.profiles.into_iter().map(Some).collect()
            };
            for profile in profiles {
                let binding = proxy.execution_binding(profile)?;
                bytes = bytes
                    .checked_add(serde_json::to_vec(&binding).map_err(|_| denied())?.len() + 1)
                    .filter(|bytes| *bytes <= tsumugi_core::execution::MAX_INPUT_BYTES)
                    .ok_or_else(|| {
                        ExecutionError::new(ErrorCode::LimitExceeded, "application-instance-roster")
                    })?;
                bindings.push(binding);
            }
            proxies.insert(member.contribution_id, proxy);
        }
        Ok(Arc::new(Self {
            basis,
            proxies,
            bindings,
            revocation: Cancellation::default(),
            finished: Arc::new(AtomicBool::new(false)),
            cleanup_confirmed: Arc::new(AtomicBool::new(false)),
            control: Mutex::new(Control {
                original: None,
                lease: None,
                sender: None,
                thread: None,
            }),
        }))
    }
    pub fn basis(&self) -> &ApplicationScopeBasis {
        &self.basis
    }
    pub fn is_stopped(&self) -> bool {
        self.revocation.is_requested()
    }
    pub fn is_authorized(&self) -> bool {
        !self.is_stopped()
            && self
                .control
                .lock()
                .is_ok_and(|control| control.lease.as_ref().is_some_and(|lease| lease.is_live()))
    }
    pub fn binding(
        &self,
        contribution: &str,
        profile: Option<sdk::ContractRef>,
    ) -> Result<PluginExecutionBinding, ExecutionError> {
        let binding = self
            .proxies
            .get(contribution)
            .ok_or_else(denied)?
            .execution_binding(profile)?;
        if !self.bindings.contains(&binding) {
            return Err(denied());
        }
        Ok(binding)
    }
    pub fn capabilities(&self) -> Vec<sdk::ProcessCapability> {
        self.proxies
            .iter()
            .map(|(id, proxy)| sdk::ProcessCapability {
                contribution_id: id.clone(),
                capability: proxy.capability.declaration.clone(),
            })
            .collect()
    }
    pub fn runner(
        self: &Arc<Self>,
        contribution: &str,
    ) -> Result<Arc<RunnerProxy>, ExecutionError> {
        let mut proxy = self.proxies.get(contribution).ok_or_else(denied)?.clone();
        proxy.application = Some(self.clone());
        Ok(Arc::new(proxy))
    }
    /// The application entry owns this independent consent and the original
    /// settings signal. Neither package metadata nor a project grant calls it.
    pub fn authorize(
        &self,
        original: ExecutionId,
        explicit_consent: bool,
        settings_revocation: Cancellation,
    ) -> Result<ApplicationExecutionLease, ExecutionError> {
        let mut control = self.control.lock().map_err(|_| denied())?;
        if self.is_stopped() || settings_revocation.is_requested() {
            return Err(denied());
        }
        if let Some(lease) = &control.lease {
            return Ok(lease.clone());
        }
        if control.original.is_some() || !explicit_consent {
            return Err(denied());
        }
        let lease = ApplicationExecutionLease::capture(
            self.bindings.clone(),
            true,
            self.revocation.clone(),
            settings_revocation.clone(),
        )?;
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<Work>(8);
        let proxies = self.proxies.clone();
        let basis = self.basis.clone();
        let revoked = self.revocation.clone();
        let finished = self.finished.clone();
        let cleanup = self.cleanup_confirmed.clone();
        let thread = std::thread::Builder::new().name("application-component".into()).spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();
            if let Ok(runtime) = runtime {
                runtime.block_on(async {
                    let mut session: Option<ProcessSession> = None;
                    let launch_cleanup = LaunchCleanup::default();
                    loop {
                        if revoked.is_requested() || settings_revocation.is_requested() { break; }
                        let work = tokio::select! {
                            work = receiver.recv() => match work { Some(work) => work, None => break },
                            _ = tokio::time::sleep(Duration::from_millis(5)) => continue,
                        };
                        let call = match work {
                            Work::Call(call) => call,
                            Work::Ready(ready) => {
                                if let Err(error) = check_ready(ready.deadline, &ready.cancellation) {
                                    let _ = ready.reply.send(Err(error));
                                    continue;
                                }
                                let result = async {
                                    if session.is_none() {
                                        let proxy = proxies.values().next().ok_or_else(denied)?;
                                        let lifetime = revoked.clone();
                                        let settings = settings_revocation.clone();
                                        let cancellation = ready.cancellation.clone();
                                        let deadline = ready.deadline;
                                        let complete = Arc::new(AtomicBool::new(false));
                                        let admission = complete.clone();
                                        let launched = ProcessSession::launch_observed(
                                            &proxy.image, &proxy.capability.provider.contribution_id, &proxy.staging_parent,
                                            &proxy.runtime.launcher(), LaunchOptions {
                                                scope: crate::SessionScope::Application {
                                                    instance_id: basis.instance_id.to_string(), activation_generation: basis.activation_generation,
                                                },
                                                allow_unsandboxed_execution: true, limits: proxy.limits.clone(),
                                            }, launch_cleanup.clone(), move || !lifetime.is_requested() && !settings.is_requested()
                                                && (admission.load(Ordering::Acquire)
                                                    || (!cancellation.is_requested() && Instant::now() < deadline)),
                                        ).await;
                                        match launched {
                                            Ok(value) => session = Some(value),
                                            Err(_) => {
                                                check_ready(ready.deadline, &ready.cancellation)?;
                                                if revoked.is_requested() || settings_revocation.is_requested() {
                                                    return Err(denied());
                                                }
                                                return Err(ExecutionError::new(ErrorCode::DependencyConflict, "application-instance-ready"));
                                            }
                                        }
                                        check_ready(ready.deadline, &ready.cancellation)?;
                                        // A caller's readiness bound is not this shared
                                        // process's lifetime or a future project's grant.
                                        complete.store(true, Ordering::Release);
                                    }
                                    check_ready(ready.deadline, &ready.cancellation)?;
                                    if revoked.is_requested() || settings_revocation.is_requested()
                                        || !session.as_ref().is_some_and(ProcessSession::is_accepting)
                                    { return Err(denied()); }
                                    Ok(())
                                }.await;
                                let failed = result.is_err();
                                let _ = ready.reply.send(result);
                                if failed { break; }
                                continue;
                            }
                        };
                        let proxy = match call.request.input.envelope().plugin.as_ref()
                            .and_then(|binding| proxies.get(&binding.capability.provider.contribution_id)) {
                            Some(proxy) => proxy,
                            None => { let _ = call.reply.send(Err(denied())); continue; }
                        };
                        if let Err(error) = proxy.check_request(&call.request) {
                            let _ = call.reply.send(Err(error)); continue;
                        }
                        let permit = match call.request.plugin_permit().cloned() {
                            Some(permit) => permit,
                            None => { let _ = call.reply.send(Err(denied())); continue; }
                        };
                        if let Err(error) = require_live(&call.request, &permit, &call.cancellation) {
                            let _ = call.reply.send(Err(error)); continue;
                        }
                        let result = async {
                            if session.is_none() {
                                let lifetime = revoked.clone();
                                let settings = settings_revocation.clone();
                                let launched = ProcessSession::launch_observed(
                                    &proxy.image, &proxy.capability.provider.contribution_id, &proxy.staging_parent,
                                    &proxy.runtime.launcher(), LaunchOptions {
                                        scope: crate::SessionScope::Application {
                                            instance_id: basis.instance_id.to_string(), activation_generation: basis.activation_generation,
                                        },
                                        allow_unsandboxed_execution: true, limits: proxy.limits.clone(),
                                    }, launch_cleanup.clone(), move || !lifetime.is_requested() && !settings.is_requested(),
                                ).await;
                                match launched {
                                    Ok(value) => session = Some(value),
                                    Err(error) => {
                                        return Err(current_error(error, &call.request, &permit, &call.cancellation));
                                    }
                                }
                            }
                            let received = proxy.invoke(session.as_mut().unwrap(), &call.request, &permit, &call.cancellation).await?;
                            require_live(&call.request, &permit, &call.cancellation)?;
                            if revoked.is_requested() || settings_revocation.is_requested() { return Err(denied()); }
                            FixedResult::capture_plugin(&call.request.input, call.request.item_id, call.request.dispatch_token,
                                PluginResultEvidence { authorization_id: permit.grant_id(), channel: received.channel().provider.clone(), result: received.result().clone() })
                        }.await;
                        let failed = result.is_err();
                        let _ = call.reply.send(result);
                        // A failed, cancelled, exhausted or uncooperative channel
                        // retires this exact activation. No hidden replacement.
                        if failed { break; }
                    }
                    revoked.request();
                    while let Ok(work) = receiver.try_recv() { work.reject(); }
                    if let Some(session) = session.as_mut() { let _ = session.close().await; }
                    drop(session);
                    cleanup.store(launch_cleanup.confirmed(), Ordering::Release);
                });
            } else {
                cleanup.store(true, Ordering::Release);
            }
            revoked.request();
            finished.store(true, Ordering::Release);
        }).map_err(|_| denied())?;
        control.original = Some(original);
        control.lease = Some(lease.clone());
        control.sender = Some(sender);
        control.thread = Some(thread);
        Ok(lease)
    }
    /// Wait for this independently authorized instance's actual Ready handshake
    /// on its original owner thread. No tool invocation or project grant starts.
    /// The caller's bound applies only to readiness, never the shared lifetime.
    pub fn ensure_ready(
        &self,
        deadline: Instant,
        cancellation: &Cancellation,
    ) -> Result<(), ExecutionError> {
        check_ready(deadline, cancellation)?;
        let (reply, result) = mpsc::sync_channel(1);
        {
            let control = self.control.lock().map_err(|_| denied())?;
            if self.is_stopped() || !control.lease.as_ref().is_some_and(|lease| lease.is_live()) {
                return Err(denied());
            }
            control
                .sender
                .as_ref()
                .ok_or_else(denied)?
                .try_send(Work::Ready(Ready {
                    deadline,
                    cancellation: cancellation.clone(),
                    reply,
                }))
                .map_err(|_| ExecutionError::new(ErrorCode::Busy, "application-instance-queue"))?;
        }
        loop {
            check_ready(deadline, cancellation)?;
            if !self.is_authorized() {
                return Err(denied());
            }
            match result.recv_timeout(Duration::from_millis(5)) {
                Ok(value) => return value,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(denied()),
            }
        }
    }
    pub(super) fn dispatch(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
    ) -> Result<FixedResult, ExecutionError> {
        if self.is_stopped()
            || !request
                .input
                .envelope()
                .plugin
                .as_ref()
                .is_some_and(|binding| self.bindings.contains(binding))
        {
            return Err(denied());
        }
        let (reply, result) = mpsc::sync_channel(1);
        {
            let control = self.control.lock().map_err(|_| denied())?;
            let lease = control.lease.as_ref().ok_or_else(denied)?;
            if !lease.matches(&request.input) {
                return Err(denied());
            }
            control
                .sender
                .as_ref()
                .ok_or_else(denied)?
                .try_send(Work::Call(Call {
                    request: request.clone(),
                    cancellation: cancellation.clone(),
                    reply,
                }))
                .map_err(|_| ExecutionError::new(ErrorCode::Busy, "application-instance-queue"))?;
        }
        loop {
            if self.is_stopped() {
                return Err(denied());
            }
            let permit = request.plugin_permit().ok_or_else(denied)?;
            require_live(&request, permit, &cancellation)?;
            match result.recv_timeout(Duration::from_millis(5)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(denied()),
            }
        }
    }
    pub fn stop(&self) {
        self.revocation.request();
    }
    /// Reap only the thread belonging to this activation. Callers keep the
    /// record until this confirms actual cleanup rather than a stop request.
    pub fn drained(&self) -> bool {
        let Ok(mut control) = self.control.lock() else {
            return false;
        };
        if control
            .thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
        {
            return false;
        }
        if let Some(thread) = control.thread.take() {
            let _ = thread.join();
        }
        control.original.is_none()
            || (self.finished.load(Ordering::Acquire)
                && self.cleanup_confirmed.load(Ordering::Acquire))
    }
}
impl Drop for ApplicationInstance {
    fn drop(&mut self) {
        self.revocation.request();
    }
}
