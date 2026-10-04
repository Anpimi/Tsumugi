use crate::*;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tempfile::TempDir;
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
            max_frame_bytes: MAX_EXCHANGE_BYTES,
            max_session_output_bytes: 16 * 1024 * 1024,
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
            || self.max_frame_bytes > MAX_EXCHANGE_BYTES
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

/// An approved interpreter supplied by the trusted runtime installer. Its path
/// is not selected from PATH or a plugin manifest. Authentication/pinning of
/// the interpreter, bootstrap and its dependencies belongs to that installer,
/// not a self-reported worker frame.
#[derive(Clone, Debug)]
pub enum RuntimeLauncher {
    Native,
    JavaScript {
        approved_node: PathBuf,
        approved_bootstrap: PathBuf,
    },
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
    directory: Option<TempDir>,
    pipes: Pipes,
    activation: ProcessActivation,
    options: LaunchOptions,
    accepting: bool,
    invocations: u32,
    dispatches: BTreeSet<String>,
    result_ids: BTreeSet<String>,
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
        authorized: impl Fn() -> bool,
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
            if component.scope != ComponentScope::Project {
                return Err(HostError::UnsupportedRuntime);
            }
            if component.dependencies.iter().any(|d| d.required) {
                return Err(HostError::DependencyUnavailable);
            }
            let captured = image.clone();
            let parent = staging_parent.to_owned();
            let directory = tokio::task::spawn_blocking(move || captured.stage(&parent))
                .await
                .map_err(|_| HostError::StageFailed)??;
            let entry = directory.path().join(
                component
                    .entrypoint
                    .as_ref()
                    .ok_or(HostError::MissingArtifact)?,
            );
            let mut command = match (component.runtime, launcher) {
                (RuntimeKind::NativeWorker, RuntimeLauncher::Native) => Command::new(&entry),
                (
                    RuntimeKind::JavaScript,
                    RuntimeLauncher::JavaScript {
                        approved_node,
                        approved_bootstrap,
                    },
                ) if approved_node.is_absolute() && approved_bootstrap.is_absolute() => {
                    let mut c = Command::new(approved_node);
                    c.arg(approved_bootstrap).arg(&entry);
                    c
                }
                _ => return Err(HostError::UnsupportedRuntime),
            };
            command
                .current_dir(directory.path())
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
            let mut child = command.spawn().map_err(|_| HostError::SpawnFailed)?;
            let pid = child.id().ok_or(HostError::SpawnFailed)?;
            let pipes = attach_pipes(&mut child, &options.limits)?;
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
                child,
                pid,
                directory: Some(directory),
                pipes,
                activation,
                options,
                accepting: false,
                invocations: 0,
                dispatches: BTreeSet::new(),
                result_ids: BTreeSet::new(),
                termination: None,
                stop_ms,
                cleanup_ms,
            };
            let result = async {
                session.send(ProcessBody::Activate(session.activation.clone()))?;
                let ready = session
                    .receive(
                        session.options.limits.handshake_timeout_ms,
                        || false,
                        &authorized,
                    )
                    .await?;
                match ready.body {
                    ProcessBody::Ready(a) if a == session.activation => Ok(()),
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
    pub fn is_accepting(&self) -> bool {
        self.accepting
            && !self.pipes.overflow.load(Ordering::Acquire)
            && self.pipes.receiver.is_empty()
    }
    /// Records actual direct-child cleanup independently of the invocation's
    /// cancellation/error. No receipt asserts rollback of external effects.
    pub fn termination_receipt(&self) -> Option<&CloseReceipt> {
        self.termination.as_ref()
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
        cancelled: impl Fn() -> bool,
        authorized: impl Fn() -> bool,
    ) -> HostResult<ProcessFrame> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.into());
        loop {
            if cancelled() {
                return Err(HostError::Cancelled);
            }
            if !authorized() {
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
                    if !authorized() { return Err(HostError::AuthorityRevoked); }
                    if self.pipes.overflow.load(Ordering::Acquire) { return Err(HostError::OutputLimit); }
                    return match event {
                        Some(Event::Frame(bytes))=>parse_process_frame(&bytes).map_err(|_| HostError::InvalidFrame),
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
            || request.context.project_id != self.options.scope.project_id
            || request.context.scope_id != self.options.scope.scope_id
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
            || request.max_result_bytes > c.limits.max_output_bytes
            || request.max_result_bytes as usize > self.options.limits.max_frame_bytes
        {
            return Err(HostError::RequestMismatch);
        }
        Ok(())
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
        if !authorized() {
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
        if let Err(error) = self.send(ProcessBody::Invoke(request.clone())) {
            self.terminate().await;
            return Err(error);
        }
        let received = self
            .receive(
                self.activation
                    .capability
                    .limits
                    .timeout_ms
                    .min(self.options.limits.invocation_timeout_ms),
                &cancelled,
                &authorized,
            )
            .await;
        let outcome = (|| {
            let frame = received?;
            let ProcessBody::Result(result) = frame.body else {
                return Err(HostError::UnexpectedFrame);
            };
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
            if !authorized() {
                return Err(HostError::AuthorityRevoked);
            }
            Ok(ReceivedResult {
                result,
                channel: self.channel(),
            })
        })();
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
                .receive(self.options.limits.handshake_timeout_ms, || false, || true)
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
            match self.receive(self.stop_ms, || false, || true).await?.body {
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
        #[cfg(unix)]
        if self.child.id().is_some() {
            // The group was created for this owned child at spawn. This is
            // lifecycle control, not confinement: trusted code can escape it.
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
    fn abort_pipes(&mut self) {
        for task in self.pipes.tasks.drain(..) {
            task.abort();
        }
    }
    async fn terminate(&mut self) {
        self.accepting = false;
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
        self.kill_group();
        self.abort_pipes();
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
