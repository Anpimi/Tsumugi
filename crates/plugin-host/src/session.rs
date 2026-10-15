use crate::staging::StagedDirectory;
use crate::*;
use std::{
    collections::BTreeSet,
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::mpsc,
    task::JoinHandle,
    time::{Instant, timeout},
};
use tsumugi_plugin_sdk::*;

#[derive(Clone, Debug)]
pub struct ScopeBinding {
    pub project_id: String,
    pub scope_id: String,
}

/// Host policy, not a permission request made by a plugin. Native processes have
/// the user's OS access. The caller must obtain explicit execution authorization
/// and keep the live authority guard current; this crate cannot create a grant.
#[derive(Clone, Debug)]
pub struct LaunchOptions {
    pub scope: ScopeBinding,
    pub allow_unsandboxed_execution: bool,
    pub limits: HostLimits,
}
#[derive(Clone, Debug)]
pub struct HostLimits {
    pub max_frame_bytes: usize,
    pub max_session_output_bytes: usize,
    pub max_stderr_bytes: usize,
    pub max_invocations: u32,
    pub handshake_timeout_ms: u32,
    pub invocation_timeout_ms: u32,
    pub stop_timeout_ms: u32,
    pub cleanup_timeout_ms: u32,
}
impl Default for HostLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: MAX_PROCESS_FRAME_BYTES,
            max_session_output_bytes: 64 * 1024 * 1024,
            max_stderr_bytes: 16 * 1024,
            max_invocations: 128,
            handshake_timeout_ms: 3000,
            invocation_timeout_ms: 10000,
            stop_timeout_ms: 500,
            cleanup_timeout_ms: 500,
        }
    }
}
impl HostLimits {
    fn validate(&self) -> HostResult<()> {
        if self.max_frame_bytes == 0
            || self.max_frame_bytes > MAX_PROCESS_FRAME_BYTES
            || self.max_session_output_bytes < self.max_frame_bytes
            || self.max_session_output_bytes > 64 * 1024 * 1024
            || self.max_stderr_bytes > 64 * 1024
            || self.max_invocations == 0
            || self.max_invocations > 128
            || [
                self.handshake_timeout_ms,
                self.invocation_timeout_ms,
                self.stop_timeout_ms,
                self.cleanup_timeout_ms,
            ]
            .iter()
            .any(|n| *n == 0 || *n > 10000)
        {
            return Err(HostError::InvalidLimits);
        }
        Ok(())
    }
}

/// Runtime bytes selected by the trusted installer. JavaScript launches only
/// the captured tool and Host trees. Native is the standalone process profile;
/// it does not provide a complete Core runtime-environment binding.
#[derive(Clone, Debug)]
pub enum RuntimeLauncher {
    Native,
    NativeCore { runtime: CapturedNativeRuntime },
    JavaScript { runtime: CapturedRuntime },
}

#[derive(Clone, Debug)]
pub struct ChannelReceipt {
    pub provider: ProviderBinding,
    pub child_pid: u32,
    pub scope: ScopeBinding,
}
/// Valid wire output bound to the captured request and this actual child. Domain
/// semantics, current authority and adoption must still be checked by Core.
#[derive(Clone, Debug)]
pub struct ReceivedResult {
    result: InvocationResult,
    channel: ChannelReceipt,
}
impl ReceivedResult {
    pub fn result(&self) -> &InvocationResult {
        &self.result
    }
    pub fn channel(&self) -> &ChannelReceipt {
        &self.channel
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseReceipt {
    pub cooperative_acknowledgement: bool,
    pub direct_child_reaped: bool,
    pub exit_code: Option<i32>,
}
enum Event {
    Frame(Vec<u8>),
    Fault(HostError),
}
struct Pipes {
    sender: mpsc::Sender<Vec<u8>>,
    receiver: mpsc::Receiver<Event>,
    overflow: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}

/// One serialized contribution channel on an owned component instance. Multiple
/// instances have distinct staged directories, process groups and identities.
/// Direction/state errors permanently revoke a channel; no hidden retry.
pub struct ProcessSession {
    child: Child,
    pid: u32,
    directory: Option<StagedDirectory>,
    environment_digest: Option<String>,
    pipes: Pipes,
    activation: ProcessActivation,
    component_scope: ComponentScope,
    authority: Arc<dyn Fn() -> bool + Send + Sync>,
    attempt_revoked: AtomicBool,
    options: LaunchOptions,
    accepting: bool,
    invocations: u32,
    dispatches: BTreeSet<String>,
    result_ids: BTreeSet<String>,
    service_broker: Option<Arc<dyn ProjectServiceBroker>>,
    service_calls: BTreeSet<String>,
    service_output_bytes: usize,
    services_released: bool,
    termination: Option<CloseReceipt>,
    stop_ms: u32,
    cleanup_ms: u32,
}
impl ProcessSession {
    pub async fn launch(
        image: &PackageImage,
        contribution_id: &str,
        staging_parent: &Path,
        launcher: &RuntimeLauncher,
        options: LaunchOptions,
        authorized: impl Fn() -> bool + Send + Sync + 'static,
    ) -> HostResult<Self> {
        Self::launch_inner(
            image,
            contribution_id,
            staging_parent,
            launcher,
            options,
            None,
            authorized,
        )
        .await
    }
    pub async fn launch_with_services(
        image: &PackageImage,
        contribution_id: &str,
        staging_parent: &Path,
        launcher: &RuntimeLauncher,
        options: LaunchOptions,
        broker: Arc<dyn ProjectServiceBroker>,
        authorized: impl Fn() -> bool + Send + Sync + 'static,
    ) -> HostResult<Self> {
        Self::launch_inner(
            image,
            contribution_id,
            staging_parent,
            launcher,
            options,
            Some(broker),
            authorized,
        )
        .await
    }
    async fn launch_inner(
        image: &PackageImage,
        contribution_id: &str,
        staging_parent: &Path,
        launcher: &RuntimeLauncher,
        options: LaunchOptions,
        broker: Option<Arc<dyn ProjectServiceBroker>>,
        authorized: impl Fn() -> bool + Send + Sync + 'static,
    ) -> HostResult<Self> {
        options.limits.validate()?;
        if !options.allow_unsandboxed_execution {
            return Err(HostError::ExecutionNotAuthorized);
        }
        if !authorized() {
            return Err(HostError::AuthorityRevoked);
        }
        if options.scope.project_id.is_empty()
            || options.scope.scope_id.is_empty()
            || options.scope.project_id.len() > 128
            || options.scope.scope_id.len() > 128
        {
            return Err(HostError::InvalidContract);
        }
        // Windows needs an owned Job Object before it can make the same bounded
        // descendant-cleanup claim. This experimental runtime refuses it rather
        // than silently weakening process cleanup. The desktop is unaffected.
        #[cfg(not(unix))]
        return Err(HostError::UnsupportedPlatform);
        #[cfg(unix)]
        {
            let manifest = image.manifest().manifest();
            let contribution = manifest
                .contributions
                .iter()
                .find(|c| c.id == contribution_id)
                .ok_or(HostError::MissingArtifact)?;
            let ContributionKind::Capability { declaration } = &contribution.contribution else {
                return Err(HostError::UnsupportedRuntime);
            };
            let component = manifest
                .components
                .iter()
                .find(|c| c.id == contribution.component_id)
                .ok_or(HostError::MissingArtifact)?;
            if component.scope == ComponentScope::Application {
                return Err(HostError::UnsupportedRuntime);
            }
            let services = crate::service::select_service_bindings(
                component,
                declaration,
                &options.scope,
                broker.as_deref(),
            )?;
            let runtime = match (component.runtime, launcher) {
                (RuntimeKind::NativeWorker, RuntimeLauncher::Native) => None,
                (RuntimeKind::NativeWorker, RuntimeLauncher::NativeCore { runtime }) => {
                    runtime.require_current()?;
                    None
                }
                (RuntimeKind::JavaScript, RuntimeLauncher::JavaScript { runtime }) => {
                    Some(runtime.clone())
                }
                _ => return Err(HostError::UnsupportedRuntime),
            };
            let environment_digest = match launcher {
                RuntimeLauncher::NativeCore { runtime } => {
                    Some(runtime.environment_digest().to_owned())
                }
                _ => runtime.as_ref().map(|r| r.environment_digest().to_owned()),
            };
            let authorized = Arc::new(authorized);
            let stage_guard = authorized.clone();
            let stage_broker = broker.clone();
            let stage_services = services.clone();
            let captured = image.clone();
            let parent = staging_parent.to_owned();
            let stage_runtime = runtime.clone();
            let directory = tokio::task::spawn_blocking(move || {
                captured.stage(&parent, stage_runtime.as_ref(), || {
                    stage_guard()
                        && stage_broker.as_ref().is_none_or(|broker| {
                            stage_services
                                .iter()
                                .all(|binding| broker.is_current(binding))
                        })
                })
            })
            .await
            .map_err(|_| HostError::StageFailed)??;
            let package_directory = directory.path().join("package");
            let entry = package_directory.join(
                component
                    .entrypoint
                    .as_ref()
                    .ok_or(HostError::MissingArtifact)?,
            );
            let mut command = match runtime.as_ref() {
                None => Command::new(&entry),
                Some(runtime) => {
                    let descriptor = runtime.descriptor();
                    let mut c = Command::new(
                        directory
                            .path()
                            .join("runtime/tool")
                            .join(&descriptor.tool.entrypoint),
                    );
                    c.arg(
                        directory
                            .path()
                            .join("runtime/host")
                            .join(&descriptor.host.entrypoint),
                    )
                    .arg(&entry);
                    c
                }
            };
            command
                .current_dir(&package_directory)
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
            // Capturing/materializing a package can outlive its original grant.
            // Recheck immediately before executing any plugin instructions.
            if !authorized() {
                return Err(HostError::AuthorityRevoked);
            }
            if broker
                .as_ref()
                .is_some_and(|broker| services.iter().any(|binding| !broker.is_current(binding)))
            {
                return Err(HostError::AuthorityRevoked);
            }
            directory.verify_binding()?;
            if let RuntimeLauncher::NativeCore { runtime } = launcher {
                runtime.require_current()?;
            }
            let child = command.spawn().map_err(|_| HostError::SpawnFailed)?;
            // From the first successful spawn through every subsequent await,
            // an owned lease keeps files alive unless the direct child is reaped.
            let mut pending = PendingChild::new(child, directory);
            let Some(pid) = pending.pid else {
                pending.rollback(options.limits.cleanup_timeout_ms).await;
                return Err(HostError::SpawnFailed);
            };
            let pipes = match attach_pipes(pending.child.as_mut().unwrap(), &options.limits) {
                Ok(pipes) => pipes,
                Err(error) => {
                    pending.rollback(options.limits.cleanup_timeout_ms).await;
                    return Err(error);
                }
            };
            let activation = ProcessActivation {
                provider: ProviderBinding {
                    plugin: manifest.plugin.clone(),
                    component_id: component.id.clone(),
                    contribution_id: contribution.id.clone(),
                    package_digest: image.package_digest().into(),
                    instance_id: uuid::Uuid::new_v4().to_string(),
                    activation_generation: 1,
                },
                capability: declaration.clone(),
                services,
            };
            let stop_ms = component
                .exit
                .stop_timeout_ms
                .min(options.limits.stop_timeout_ms);
            let cleanup_ms = component
                .exit
                .cleanup_timeout_ms
                .min(options.limits.cleanup_timeout_ms);
            let mut session = Self {
                child: pending.child.take().unwrap(),
                pid,
                directory: pending.directory.take(),
                environment_digest,
                pipes,
                activation,
                component_scope: component.scope,
                authority: authorized.clone(),
                attempt_revoked: AtomicBool::new(false),
                options,
                accepting: false,
                invocations: 0,
                dispatches: BTreeSet::new(),
                result_ids: BTreeSet::new(),
                service_broker: broker,
                service_calls: BTreeSet::new(),
                service_output_bytes: 0,
                services_released: false,
                termination: None,
                stop_ms,
                cleanup_ms,
            };
            let result = async {
                session.send(ProcessBody::Activate(session.activation.clone()))?;
                let ready = session
                    .receive(
                        session.options.limits.handshake_timeout_ms,
                        session.options.limits.max_frame_bytes,
                        || false,
                        || authorized(),
                    )
                    .await?;
                match ready.body {
                    ProcessBody::Ready(a) if a == session.activation => {
                        if session.service_broker.as_ref().is_some_and(|broker| {
                            session
                                .activation
                                .services
                                .iter()
                                .any(|binding| !broker.is_current(binding))
                        }) {
                            Err(HostError::AuthorityRevoked)
                        } else {
                            Ok(())
                        }
                    }
                    _ => Err(HostError::HandshakeMismatch),
                }
            }
            .await;
            if let Err(error) = result {
                session.terminate().await;
                return Err(error);
            }
            session.accepting = true;
            Ok(session)
        }
    }
    pub fn channel(&self) -> ChannelReceipt {
        ChannelReceipt {
            provider: self.activation.provider.clone(),
            child_pid: self.pid,
            scope: self.options.scope.clone(),
        }
    }
    pub fn environment_digest(&self) -> Option<&str> {
        self.environment_digest.as_deref()
    }
    pub fn is_accepting(&self) -> bool {
        self.accepting
            && self.services_current()
            && !self.pipes.overflow.load(Ordering::Acquire)
            && self.pipes.receiver.is_empty()
    }
    /// Records actual direct-child cleanup independently of the invocation's
    /// cancellation/error. No receipt asserts rollback of external effects.
    pub fn termination_receipt(&self) -> Option<&CloseReceipt> {
        self.termination.as_ref()
    }
    fn services_current(&self) -> bool {
        // Attempt channels retain the original admission guard. A caller's
        // later callback cannot substitute a new grant after this one expires.
        (self.component_scope != ComponentScope::Attempt || {
            if !(self.authority)() {
                self.attempt_revoked.store(true, Ordering::Release);
            }
            !self.attempt_revoked.load(Ordering::Acquire)
        }) && self.service_broker.as_ref().is_none_or(|broker| {
            self.activation
                .services
                .iter()
                .all(|binding| broker.is_current(binding))
        })
    }
    fn send(&self, body: ProcessBody) -> HostResult<()> {
        let bytes = ProcessFrame::new(body)
            .encode()
            .map_err(|_| HostError::InvalidContract)?;
        if bytes.len() > self.options.limits.max_frame_bytes {
            return Err(HostError::OutputLimit);
        }
        self.pipes
            .sender
            .try_send(bytes)
            .map_err(|_| HostError::ChannelFailed)
    }
    async fn receive(
        &mut self,
        timeout_ms: u32,
        frame_limit: usize,
        cancelled: impl Fn() -> bool,
        authorized: impl Fn() -> bool,
    ) -> HostResult<ProcessFrame> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.into());
        self.receive_until(deadline, frame_limit, cancelled, authorized)
            .await
            .map(|(frame, _)| frame)
    }
    async fn receive_until(
        &mut self,
        deadline: Instant,
        frame_limit: usize,
        cancelled: impl Fn() -> bool,
        authorized: impl Fn() -> bool,
    ) -> HostResult<(ProcessFrame, usize)> {
        loop {
            if cancelled() {
                return Err(HostError::Cancelled);
            }
            if !authorized() || !self.services_current() {
                return Err(HostError::AuthorityRevoked);
            }
            if self.pipes.overflow.load(Ordering::Acquire) {
                return Err(HostError::OutputLimit);
            }
            if Instant::now() >= deadline {
                return Err(HostError::Timeout);
            }
            tokio::select! {
                event=self.pipes.receiver.recv() => {
                    if cancelled() { return Err(HostError::Cancelled); }
                    if !authorized() || !self.services_current() { return Err(HostError::AuthorityRevoked); }
                    if self.pipes.overflow.load(Ordering::Acquire) { return Err(HostError::OutputLimit); }
                    if Instant::now() >= deadline { return Err(HostError::Timeout); }
                    return match event {
                        // Preserve the original encoded size: parsing and then
                        // re-encoding would discard whitespace/escape overhead.
                        Some(Event::Frame(bytes)) if bytes.len() > frame_limit=>Err(HostError::OutputLimit),
                        Some(Event::Frame(bytes))=>parse_process_frame(&bytes)
                            .map(|frame| (frame, bytes.len())).map_err(|_| HostError::InvalidFrame),
                        Some(Event::Fault(error))=>Err(error),
                        None=>Err(HostError::ChannelFailed),
                    };
                }
                _=tokio::time::sleep(Duration::from_millis(5))=>{}
            }
        }
    }
    fn check_request(&self, request: &InvocationRequest) -> HostResult<()> {
        request.validate().map_err(|_| HostError::InvalidContract)?;
        let c = &self.activation.capability;
        if request.provider != self.activation.provider
            || self
                .environment_digest
                .as_ref()
                .is_some_and(|digest| request.context.environment_digest != *digest)
            || request.context.project_id != self.options.scope.project_id
            || request.context.scope_id != self.options.scope.scope_id
            || (self.component_scope == ComponentScope::Attempt
                && request.context.attempt_id != self.options.scope.scope_id)
            || request.capability != c.contract
            || request.input.schema != c.input_schema
            || request.output_schema != c.output_schema
            || request.error_schema != c.error_schema
            || request
                .profile
                .as_ref()
                .is_some_and(|p| !c.profiles.contains(p))
            || (request.profile.is_none() && !c.profiles.is_empty())
            || request.input.utf8.len() > c.limits.max_input_bytes as usize
            || request.max_result_bytes as usize > self.options.limits.max_frame_bytes
        {
            return Err(HostError::RequestMismatch);
        }
        Ok(())
    }
    async fn service_call(
        &mut self,
        service_request: ServiceRequest,
        invocation: &InvocationRequest,
        deadline: Instant,
        cancelled: &impl Fn() -> bool,
        authorized: &impl Fn() -> bool,
    ) -> HostResult<()> {
        let binding = self
            .activation
            .services
            .iter()
            .find(|binding| binding.handle_id == service_request.handle_id)
            .cloned()
            .ok_or(HostError::RequestMismatch)?;
        service_request
            .validate_against(&binding, &invocation.context)
            .map_err(|_| HostError::RequestMismatch)?;
        if self.service_calls.len() >= MAX_SERVICE_CALLS as usize {
            return Err(HostError::OutputLimit);
        }
        if !self.service_calls.insert(service_request.call_id.clone()) {
            return Err(HostError::RequestMismatch);
        }
        let broker = self
            .service_broker
            .clone()
            .ok_or(HostError::RequestMismatch)?;
        let caller = ServiceCaller::capture(self.channel(), invocation, deadline.into_std());
        let captured_services = self.activation.services.clone();
        let service_deadline =
            deadline.min(Instant::now() + Duration::from_millis(binding.limits.timeout_ms.into()));
        let check_live = || {
            if cancelled() {
                Err(HostError::Cancelled)
            } else if !authorized()
                || captured_services
                    .iter()
                    .any(|binding| !broker.is_current(binding))
            {
                Err(HostError::AuthorityRevoked)
            } else if Instant::now() >= service_deadline {
                Err(HostError::Timeout)
            } else {
                Ok(())
            }
        };
        check_live()?;
        // Construct only after current caller/binding checks. Dropping this
        // bounded future on cancellation does not claim external rollback.
        let mut call = broker.call(caller, binding.clone(), service_request.clone());
        let response = loop {
            check_live()?;
            if self.pipes.overflow.load(Ordering::Acquire) {
                return Err(HostError::OutputLimit);
            }
            tokio::select! {
                response = &mut call => break response?,
                event = self.pipes.receiver.recv() => {
                    return Err(match event {
                        Some(Event::Fault(error)) => error,
                        Some(Event::Frame(_)) => HostError::UnexpectedFrame,
                        None => HostError::ChannelFailed,
                    });
                }
                _ = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
        };
        check_live()?;
        if self.pipes.overflow.load(Ordering::Acquire) {
            return Err(HostError::OutputLimit);
        }
        if self.pipes.receiver.try_recv().is_ok() {
            return Err(HostError::UnexpectedFrame);
        }
        response
            .validate_against(&service_request, &binding)
            .map_err(|_| HostError::ResultMismatch)?;
        // Correlation is derived from the verified actual call, even after the
        // broker's response has passed exact SDK matching.
        let response = ServiceResponse {
            call_id: service_request.call_id,
            handle_id: binding.handle_id.clone(),
            context: invocation.context.clone(),
            outcome: response.outcome,
        };
        let body = ProcessBody::ServiceResponse(response);
        let encoded_size = ProcessFrame::new(body.clone())
            .encode()
            .map_err(|_| HostError::InvalidContract)?
            .len();
        self.service_output_bytes = self
            .service_output_bytes
            .checked_add(encoded_size)
            .ok_or(HostError::OutputLimit)?;
        if self.service_output_bytes > self.options.limits.max_session_output_bytes {
            return Err(HostError::OutputLimit);
        }
        check_live()?;
        self.send(body)
    }
    /// Cancellation/authority callbacks come from the current trusted owner.
    /// A revoked or uncertain invocation consumes this process channel, since
    /// arbitrary native code cannot promise rollback or prevent a late write.
    pub async fn invoke(
        &mut self,
        request: &InvocationRequest,
        cancelled: impl Fn() -> bool,
        authorized: impl Fn() -> bool,
    ) -> HostResult<ReceivedResult> {
        if !self.accepting {
            return Err(HostError::Closed);
        }
        self.check_request(request)?;
        if cancelled() {
            self.terminate().await;
            return Err(HostError::Cancelled);
        }
        if !authorized() || !self.services_current() {
            self.terminate().await;
            return Err(HostError::AuthorityRevoked);
        }
        if self.invocations >= self.options.limits.max_invocations {
            return Err(HostError::OutputLimit);
        }
        if self.dispatches.contains(&request.context.dispatch_id) {
            return Err(HostError::RequestMismatch);
        }
        // Do not admit an unsolicited or late frame into the next dispatch.
        if self.pipes.receiver.try_recv().is_ok() || self.pipes.overflow.load(Ordering::Acquire) {
            self.terminate().await;
            return Err(HostError::UnexpectedFrame);
        }
        self.invocations += 1;
        self.dispatches.insert(request.context.dispatch_id.clone());
        let deadline = Instant::now()
            + Duration::from_millis(
                self.activation
                    .capability
                    .limits
                    .timeout_ms
                    .min(self.options.limits.invocation_timeout_ms)
                    .into(),
            );
        if let Err(error) = self.send(ProcessBody::Invoke(request.clone())) {
            self.terminate().await;
            return Err(error);
        }
        let outcome = async {
            let result = loop {
                let (frame, encoded_size) = self
                    .receive_until(
                        deadline,
                        self.options.limits.max_frame_bytes,
                        &cancelled,
                        &authorized,
                    )
                    .await?;
                match frame.body {
                    ProcessBody::ServiceRequest(service_request) => {
                        self.service_call(
                            service_request,
                            request,
                            deadline,
                            &cancelled,
                            &authorized,
                        )
                        .await?;
                    }
                    ProcessBody::Result(result) => {
                        if encoded_size > request.max_result_bytes as usize {
                            return Err(HostError::OutputLimit);
                        }
                        break result;
                    }
                    _ => return Err(HostError::UnexpectedFrame),
                }
            };
            check_result_payload(&result, self.activation.capability.limits.max_output_bytes)?;
            let bytes = serde_json::to_vec(&ExchangeDocument {
                protocol_version: EXCHANGE_PROTOCOL,
                body: ExchangeBody::Result(result.clone()),
            })
            .map_err(|_| HostError::InvalidFrame)?;
            receive_invocation_result(&bytes, request, &self.activation.provider)
                .map_err(|_| HostError::ResultMismatch)?;
            if !self.result_ids.insert(result.result_id.clone()) {
                return Err(HostError::ResultMismatch);
            }
            if cancelled() {
                return Err(HostError::Cancelled);
            }
            if !authorized() || !self.services_current() {
                return Err(HostError::AuthorityRevoked);
            }
            if Instant::now() >= deadline {
                return Err(HostError::Timeout);
            }
            Ok(ReceivedResult {
                result,
                channel: self.channel(),
            })
        }
        .await;
        if let Err(error) = outcome {
            if matches!(error, HostError::Cancelled | HostError::AuthorityRevoked) {
                let _ = self.send(ProcessBody::Cancel {
                    dispatch_id: request.context.dispatch_id.clone(),
                });
            }
            self.terminate().await;
            return Err(error);
        }
        outcome
    }
    pub async fn heartbeat(&mut self) -> HostResult<()> {
        if !self.accepting {
            return Err(HostError::Closed);
        }
        let nonce = uuid::Uuid::new_v4().to_string();
        let outcome = async {
            self.send(ProcessBody::Ping {
                nonce: nonce.clone(),
            })?;
            match self
                .receive(
                    self.options.limits.handshake_timeout_ms,
                    self.options.limits.max_frame_bytes,
                    || false,
                    || true,
                )
                .await?
                .body
            {
                ProcessBody::Pong { nonce: n } if n == nonce => Ok(()),
                _ => Err(HostError::UnexpectedFrame),
            }
        }
        .await;
        if outcome.is_err() {
            self.terminate().await;
        }
        outcome
    }
    pub async fn close(&mut self) -> CloseReceipt {
        self.accepting = false;
        if self.directory.is_none() {
            self.release_services();
            return self.termination.clone().unwrap_or(CloseReceipt {
                cooperative_acknowledgement: false,
                direct_child_reaped: false,
                exit_code: None,
            });
        }
        let acknowledged = async {
            self.send(ProcessBody::Close {
                provider: self.activation.provider.clone(),
            })?;
            match self
                .receive(
                    self.stop_ms,
                    self.options.limits.max_frame_bytes,
                    || false,
                    || true,
                )
                .await?
                .body
            {
                ProcessBody::Closed { provider } if provider == self.activation.provider => Ok(()),
                _ => Err(HostError::UnexpectedFrame),
            }
        }
        .await
        .is_ok();
        // Even a cooperative direct worker may leave descendants in its group.
        // Kill the owned group before reaping its leader; never signal a reaped
        // numeric PID that could belong to a later unrelated process.
        self.kill_group();
        let status = timeout(
            Duration::from_millis(self.cleanup_ms.into()),
            self.child.wait(),
        )
        .await;
        let reaped = matches!(status, Ok(Ok(_)));
        let exit_code = status.ok().and_then(Result::ok).and_then(|s| s.code());
        self.abort_pipes();
        self.release_services();
        if reaped {
            self.directory.take();
        }
        let receipt = CloseReceipt {
            cooperative_acknowledgement: acknowledged,
            direct_child_reaped: reaped,
            exit_code,
        };
        self.termination = Some(receipt.clone());
        receipt
    }
    fn kill_group(&mut self) {
        kill_owned_child(&mut self.child, Some(self.pid));
    }
    fn abort_pipes(&mut self) {
        for task in self.pipes.tasks.drain(..) {
            task.abort();
        }
    }
    fn release_services(&mut self) {
        if !self.services_released {
            self.services_released = true;
            if let Some(broker) = &self.service_broker {
                broker.release_channel(&self.channel());
            }
        }
    }
    async fn terminate(&mut self) {
        self.accepting = false;
        self.release_services();
        self.kill_group();
        let status = timeout(
            Duration::from_millis(self.cleanup_ms.into()),
            self.child.wait(),
        )
        .await;
        let reaped = matches!(status, Ok(Ok(_)));
        let exit_code = status.ok().and_then(Result::ok).and_then(|s| s.code());
        self.termination = Some(CloseReceipt {
            cooperative_acknowledgement: false,
            direct_child_reaped: reaped,
            exit_code,
        });
        self.abort_pipes();
        if reaped {
            self.directory.take();
        }
    }
}
impl Drop for ProcessSession {
    fn drop(&mut self) {
        self.accepting = false;
        self.release_services();
        self.kill_group();
        self.abort_pipes();
        release_or_keep(&mut self.child, &mut self.directory);
    }
}

// A cancelled launch future cannot run async rollback. In that case the same
// conservative Drop rule applies as to an already established session.
struct PendingChild {
    child: Option<Child>,
    directory: Option<StagedDirectory>,
    pid: Option<u32>,
}
impl PendingChild {
    fn new(child: Child, directory: StagedDirectory) -> Self {
        Self {
            pid: child.id(),
            child: Some(child),
            directory: Some(directory),
        }
    }
    async fn rollback(&mut self, timeout_ms: u32) {
        let child = self.child.as_mut().unwrap();
        kill_owned_child(child, self.pid);
        if matches!(
            timeout(Duration::from_millis(timeout_ms.into()), child.wait()).await,
            Ok(Ok(_))
        ) {
            self.directory.take();
        }
    }
}
impl Drop for PendingChild {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            kill_owned_child(child, self.pid);
            release_or_keep(child, &mut self.directory);
        }
    }
}
fn kill_owned_child(child: &mut Child, pid: Option<u32>) {
    #[cfg(unix)]
    if child.id().is_some()
        && let Some(pid) = pid
    {
        // This group belongs to the unreaped child created at spawn. It is
        // lifecycle control, not confinement of code that can escape the group.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}
fn release_or_keep(child: &mut Child, directory: &mut Option<StagedDirectory>) {
    if let Some(directory) = directory.take() {
        if matches!(child.try_wait(), Ok(Some(_))) {
            drop(directory);
        } else {
            // Unknown reap state must not invalidate files a live child uses.
            // This retained instance is not a successful cleanup receipt.
            directory.keep();
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod lifetime_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    fn staged(parent: &Path) -> StagedDirectory {
        crate::staging::materialize(parent, b"{}", &BTreeMap::new(), None, || true).unwrap()
    }
    fn sleeping_child() -> Child {
        // A real owned process exercises reap/lease behavior independently of
        // the synthetic protocol worker. No plugin or user project is opened.
        let mut command = Command::new("/bin/sleep");
        command.arg("10").env_clear().kill_on_drop(true);
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
        command.spawn().unwrap()
    }

    #[test]
    fn post_spawn_pipe_failure_rolls_back_and_reaps_before_removing_files() {
        runtime().block_on(async {
            let parent = tempfile::tempdir().unwrap();
            let directory = staged(parent.path());
            let path = directory.path().to_owned();
            let mut pending = PendingChild::new(sleeping_child(), directory);
            assert!(matches!(
                attach_pipes(pending.child.as_mut().unwrap(), &HostLimits::default()),
                Err(HostError::ChannelFailed)
            ));
            pending.rollback(1000).await;
            assert!(
                pending
                    .child
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .unwrap()
                    .is_some()
            );
            assert!(pending.directory.is_none());
            assert!(!path.exists());
        });
    }

    #[test]
    fn an_unreaped_child_keeps_its_instance_until_explicit_owned_cleanup() {
        runtime().block_on(async {
            let parent = tempfile::tempdir().unwrap();
            let directory = staged(parent.path());
            let path = directory.path().to_owned();
            let mut child = sleeping_child();
            let mut lease = Some(directory);
            assert!(child.try_wait().unwrap().is_none());
            release_or_keep(&mut child, &mut lease);
            assert!(lease.is_none());
            assert!(path.join("package/manifest.json").is_file());
            let pid = child.id();
            kill_owned_child(&mut child, pid);
            timeout(Duration::from_secs(1), child.wait())
                .await
                .unwrap()
                .unwrap();
            // Only this test-created tree is removed, after the real reap.
            std::fs::remove_dir_all(path).unwrap();
        });
    }
}
fn check_result_payload(result: &InvocationResult, raw_limit: u32) -> HostResult<()> {
    let payload = match &result.outcome {
        InvocationOutcome::Succeeded { output } => output,
        InvocationOutcome::Failed { error } | InvocationOutcome::Unknown { error } => error,
    };
    if payload.utf8.len() > raw_limit as usize {
        return Err(HostError::OutputLimit);
    }
    Ok(())
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn process_and_aggregate_limits_have_independent_finite_bounds() {
        let limits = HostLimits::default();
        assert_eq!(limits.max_frame_bytes, MAX_PROCESS_FRAME_BYTES);
        assert_eq!(limits.max_session_output_bytes, 64 * 1024 * 1024);
        limits.validate().unwrap();
        let narrower = HostLimits {
            max_frame_bytes: 16 * 1024,
            ..limits.clone()
        };
        narrower.validate().unwrap();
        for invalid in [
            HostLimits {
                max_frame_bytes: MAX_PROCESS_FRAME_BYTES + 1,
                ..limits.clone()
            },
            HostLimits {
                max_session_output_bytes: MAX_PROCESS_FRAME_BYTES - 1,
                ..limits.clone()
            },
            HostLimits {
                max_session_output_bytes: 64 * 1024 * 1024 + 1,
                ..limits.clone()
            },
        ] {
            assert!(matches!(invalid.validate(), Err(HostError::InvalidLimits)));
        }
    }

    #[test]
    fn raw_output_limit_counts_utf8_for_every_outcome_independently_of_framing() {
        let document: ExchangeDocument = serde_json::from_str(include_str!(
            "../../plugin-sdk/tests/fixtures/invocation.result.json"
        ))
        .unwrap();
        let ExchangeBody::Result(mut result) = document.body else {
            panic!("Expected result fixture");
        };
        let schema = match &result.outcome {
            InvocationOutcome::Succeeded { output } => output.schema.clone(),
            _ => panic!("Expected successful result fixture"),
        };
        for kind in 0..3 {
            for (utf8, allowed) in [("éé", true), ("ééx", false)] {
                let payload = EncodedPayload::capture(schema.clone(), utf8.into()).unwrap();
                result.outcome = match kind {
                    0 => InvocationOutcome::Succeeded { output: payload },
                    1 => InvocationOutcome::Failed { error: payload },
                    _ => InvocationOutcome::Unknown { error: payload },
                };
                let frame = ProcessFrame::new(ProcessBody::Result(result.clone()))
                    .encode()
                    .unwrap();
                assert!(frame.len() > 4);
                assert!(frame.len() < 64 * 1024);
                let checked = check_result_payload(&result, 4);
                if allowed {
                    checked.unwrap();
                } else {
                    assert!(matches!(checked, Err(HostError::OutputLimit)));
                }
            }
        }
    }
}

fn publish(sender: &mpsc::Sender<Event>, overflow: &AtomicBool, event: Event) {
    if sender.try_send(event).is_err() {
        overflow.store(true, Ordering::Release);
    }
}
fn attach_pipes(child: &mut Child, limits: &HostLimits) -> HostResult<Pipes> {
    let mut stdin = child.stdin.take().ok_or(HostError::ChannelFailed)?;
    let stdout = child.stdout.take().ok_or(HostError::ChannelFailed)?;
    let mut stderr = child.stderr.take().ok_or(HostError::ChannelFailed)?;
    let (sender, mut writes) = mpsc::channel::<Vec<u8>>(1);
    let (events, receiver) = mpsc::channel(4);
    let overflow = Arc::new(AtomicBool::new(false));
    let e = events.clone();
    let o = overflow.clone();
    let writer = tokio::spawn(async move {
        while let Some(bytes) = writes.recv().await {
            if stdin
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .await
                .is_err()
                || stdin.write_all(&bytes).await.is_err()
                || stdin.flush().await.is_err()
            {
                publish(&e, &o, Event::Fault(HostError::ChannelFailed));
                break;
            }
        }
    });
    let e = events.clone();
    let o = overflow.clone();
    let frame_limit = limits.max_frame_bytes;
    let total_limit = limits.max_session_output_bytes;
    let reader = tokio::spawn(async move {
        read_frames(stdout, e, o, frame_limit, total_limit).await;
    });
    let e = events;
    let o = overflow.clone();
    let stderr_limit = limits.max_stderr_bytes;
    let diagnostic = tokio::spawn(async move {
        let mut bytes = [0u8; 1024];
        let mut total = 0usize;
        loop {
            match stderr.read(&mut bytes).await {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if total > stderr_limit {
                        publish(&e, &o, Event::Fault(HostError::OutputLimit));
                        break;
                    }
                }
                Err(_) => {
                    publish(&e, &o, Event::Fault(HostError::ChannelFailed));
                    break;
                }
            }
        }
        // Raw untrusted diagnostics are deliberately not retained or printed.
    });
    Ok(Pipes {
        sender,
        receiver,
        overflow,
        tasks: vec![writer, reader, diagnostic],
    })
}
async fn read_frames(
    mut reader: impl AsyncRead + Unpin,
    sender: mpsc::Sender<Event>,
    overflow: Arc<AtomicBool>,
    frame_limit: usize,
    total_limit: usize,
) {
    let mut total = 0usize;
    loop {
        let mut header = [0u8; 4];
        if reader.read_exact(&mut header).await.is_err() {
            publish(&sender, &overflow, Event::Fault(HostError::Crashed));
            return;
        }
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > frame_limit {
            publish(&sender, &overflow, Event::Fault(HostError::OutputLimit));
            return;
        }
        total = match total.checked_add(length + 4) {
            Some(n) if n <= total_limit => n,
            _ => {
                publish(&sender, &overflow, Event::Fault(HostError::OutputLimit));
                return;
            }
        };
        let mut bytes = vec![0u8; length];
        if reader.read_exact(&mut bytes).await.is_err() {
            publish(&sender, &overflow, Event::Fault(HostError::Crashed));
            return;
        }
        publish(&sender, &overflow, Event::Frame(bytes));
        if overflow.load(Ordering::Acquire) {
            return;
        }
    }
}
