//! The trusted application's member channel. This uses the approved Node tool,
//! captured application code, and the existing pipe/filesystem lifetime owners.
//! It is independent of plugin activation and grants no domain authority.
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use serde_json::Value;
use tokio::time::{Instant, timeout, timeout_at};
use tsumugi_core::{
    ai::member_wire::{self as wire, MemberBody, MemberCall, MemberFrame, MemberReply},
    execution::{Cancellation, ExecutionError, ExecutionId},
};

pub use crate::{CapturedMemberArtifact, MemberArtifactManifest};

use crate::{
    CapturedRuntime, CloseReceipt, HostError, HostLimits, HostResult,
    child::{ChildCommand, OwnedChild},
    session::{Event, PendingChild, Pipes, attach_pipes, kill_owned_child},
    staging,
};

const MAX_CALLS: u32 = 16_384;
const POLL: Duration = Duration::from_millis(20);

struct ToolCall {
    name: String,
    arguments: Value,
    state: ToolState,
}
#[derive(PartialEq, Eq)]
enum ToolState {
    Admitted,
    Denied,
    Executed,
    Finalized,
}

/// Host handlers own consent, model reservations, tool permissions, and records.
/// The returned future must retain and join its owned work when cancellation is
/// requested; it must not detach mutations or a blocking request on drop.
pub trait MemberHandler: Send {
    /// A local I/O stop token. Requesting it is not business revocation or a
    /// durable cancellation receipt; those remain with the original Core owner.
    fn cancellation(&self) -> Cancellation;
    fn handle(
        &mut self,
        call: MemberCall,
    ) -> Pin<Box<dyn Future<Output = Result<MemberReply, ExecutionError>> + Send + '_>>;
}

pub struct MemberLaunchOptions {
    pub allow_unsandboxed_execution: bool,
    pub cancellation: Cancellation,
    pub limits: HostLimits,
}

pub struct MemberRunReceipt {
    pub messages: Value,
    pub turn_limit_reached: bool,
    pub child_pid: u32,
    pub termination: CloseReceipt,
}

/// One run's last trusted boundary, without payloads or process-cleanup claims.
/// Use a fresh observation per run; a category never proves that work can be
/// replayed or that its child was reaped.
#[derive(Default)]
pub struct MemberRunObservation {
    phase: AtomicU8,
}

#[derive(Clone, Copy)]
enum MemberPhase {
    Admission = 0,
    Staging = 1,
    Spawn = 2,
    Ready = 3,
    Run = 4,
    Close = 5,
    Cleanup = 6,
}

impl MemberRunObservation {
    fn enter(&self, phase: MemberPhase) {
        self.phase.store(phase as u8, Ordering::Release);
    }

    /// Refine only fixed uncertain process failures. Child fault text and other
    /// errors never become trusted categories through this observation.
    pub fn failure_category(&self, error: &HostError) -> Option<&'static str> {
        let phase = self.phase.load(Ordering::Acquire);
        Some(match (error, phase) {
            (HostError::Timeout, 1) => "member-timeout-staging",
            (HostError::Timeout, 2) => "member-timeout-spawn",
            (HostError::Timeout, 3) => "member-timeout-ready",
            (HostError::Timeout, 4) => "member-timeout-run",
            (HostError::Timeout, 5) => "member-timeout-close",
            (HostError::Timeout, 6) => "member-timeout-cleanup",
            (HostError::Timeout, _) => "member-timeout-admission",
            (HostError::Crashed, 1) => "member-crashed-staging",
            (HostError::Crashed, 2) => "member-crashed-spawn",
            (HostError::Crashed, 3) => "member-crashed-ready",
            (HostError::Crashed, 4) => "member-crashed-run",
            (HostError::Crashed, 5) => "member-crashed-close",
            (HostError::Crashed, 6) => "member-crashed-cleanup",
            (HostError::Crashed, _) => "member-crashed-admission",
            (HostError::ChannelFailed, 1) => "member-channel-staging",
            (HostError::ChannelFailed, 2) => "member-channel-spawn",
            (HostError::ChannelFailed, 3) => "member-channel-ready",
            (HostError::ChannelFailed, 4) => "member-channel-run",
            (HostError::ChannelFailed, 5) => "member-channel-close",
            (HostError::ChannelFailed, 6) => "member-channel-cleanup",
            (HostError::ChannelFailed, _) => "member-channel-admission",
            _ => return None,
        })
    }
}

struct MemberProcess<'a> {
    pending: PendingChild,
    pipes: Pipes,
    session: ExecutionId,
    next_input: u32,
    next_output: u32,
    input_bytes: usize,
    limits: HostLimits,
    cancellation: Cancellation,
    io_stop: Cancellation,
    observation: &'a MemberRunObservation,
}
impl Drop for MemberProcess<'_> {
    fn drop(&mut self) {
        self.io_stop.request();
        for task in &self.pipes.tasks {
            task.abort();
        }
        // PendingChild retains its directory unless this exact child is reaped.
    }
}
impl MemberProcess<'_> {
    fn check(&mut self, authorized: &impl Fn() -> bool, deadline: Instant) -> HostResult<()> {
        if self.cancellation.is_requested() {
            return Err(HostError::Cancelled);
        }
        if !authorized() {
            return Err(HostError::AuthorityRevoked);
        }
        if Instant::now() >= deadline {
            return Err(HostError::Timeout);
        }
        if self.pipes.overflow.load(Ordering::Acquire) {
            return Err(HostError::OutputLimit);
        }
        match self.pending.child.as_mut().unwrap().try_wait() {
            Ok(None) => Ok(()),
            Ok(Some(_)) => Err(HostError::Crashed),
            Err(_) => Err(HostError::ChannelFailed),
        }
    }

    async fn send(
        &mut self,
        body: MemberBody,
        authorized: &impl Fn() -> bool,
        deadline: Instant,
    ) -> HostResult<()> {
        self.check(authorized, deadline)?;
        let frame = MemberFrame {
            protocol_version: wire::PROTOCOL,
            session_id: self.session,
            sequence: self.next_input,
            body,
        };
        let bytes = wire::encode_frame(&frame, self.limits.max_frame_bytes)
            .map_err(|_| HostError::OutputLimit)?;
        self.input_bytes = self
            .input_bytes
            .checked_add(bytes.len() + 4)
            .filter(|total| *total <= wire::MAX_SESSION_BYTES)
            .ok_or(HostError::OutputLimit)?;
        self.next_input = self
            .next_input
            .checked_add(1)
            .ok_or(HostError::OutputLimit)?;
        let sender = self.pipes.sender.clone();
        let writing = sender.send(bytes);
        tokio::pin!(writing);
        loop {
            tokio::select! {
                result = &mut writing => return result.map_err(|_| HostError::ChannelFailed),
                _ = tokio::time::sleep(POLL) => self.check(authorized, deadline)?,
            }
        }
    }

    fn decode(&mut self, event: Option<Event>) -> HostResult<MemberBody> {
        let bytes = match event {
            Some(Event::Frame(bytes)) => bytes,
            Some(Event::Fault(error)) => return Err(error),
            None => return Err(HostError::ChannelFailed),
        };
        let frame = wire::decode_frame(&bytes, self.limits.max_frame_bytes)
            .map_err(|_| HostError::InvalidFrame)?;
        if frame.session_id != self.session || frame.sequence != self.next_output {
            return Err(HostError::RequestMismatch);
        }
        self.next_output = self
            .next_output
            .checked_add(1)
            .ok_or(HostError::OutputLimit)?;
        Ok(frame.body)
    }

    async fn receive(
        &mut self,
        authorized: &impl Fn() -> bool,
        deadline: Instant,
    ) -> HostResult<MemberBody> {
        loop {
            if self.pipes.overflow.load(Ordering::Acquire) {
                return Err(HostError::OutputLimit);
            }
            tokio::select! {
                biased;
                event = self.pipes.receiver.recv() => return self.decode(event),
                _ = tokio::time::sleep(POLL) => self.check(authorized, deadline)?,
            }
        }
    }

    async fn dispatch(
        &mut self,
        handler: &mut impl MemberHandler,
        call: MemberCall,
        authorized: &impl Fn() -> bool,
        deadline: Instant,
    ) -> HostResult<MemberReply> {
        self.check(authorized, deadline)?;
        let handling = handler.handle(call);
        tokio::pin!(handling);
        let stopped = loop {
            tokio::select! {
                result = &mut handling => return Ok(result.unwrap_or_else(|error| MemberReply::Rejected { error })),
                event = self.pipes.receiver.recv() => break match event {
                    Some(Event::Fault(error)) => error,
                    _ => HostError::UnexpectedFrame,
                },
                _ = tokio::time::sleep(POLL) => if let Err(error) = self.check(authorized, deadline) { break error; },
            }
        };
        self.io_stop.request();
        kill_owned_child(self.pending.child.as_mut().unwrap());
        // Core's request observes the shared stop token while actual I/O is
        // pending. Drain it before allowing a caller to retry or release facts.
        if timeout(
            Duration::from_millis(self.limits.cleanup_timeout_ms.into()),
            &mut handling,
        )
        .await
        .is_err()
        {
            if let Some(directory) = self.pending.directory.take() {
                directory.keep();
            }
            self.observation.enter(MemberPhase::Cleanup);
            return Err(HostError::Timeout);
        }
        Err(stopped)
    }

    async fn finish(
        &mut self,
        authorized: &impl Fn() -> bool,
        original_deadline: Instant,
    ) -> HostResult<CloseReceipt> {
        let deadline = original_deadline
            .min(Instant::now() + Duration::from_millis(self.limits.stop_timeout_ms.into()));
        self.send(MemberBody::Close, authorized, deadline).await?;
        if !matches!(
            self.receive(authorized, deadline).await?,
            MemberBody::Closed
        ) {
            return Err(HostError::UnexpectedFrame);
        }
        let status = timeout_at(deadline, self.pending.child.as_mut().unwrap().wait())
            .await
            .map_err(|_| HostError::Timeout)?
            .map_err(|_| HostError::ChannelFailed)?;
        // Read through the original stdout's EOF, rejecting trailing messages.
        loop {
            match timeout_at(deadline, self.pipes.receiver.recv())
                .await
                .map_err(|_| HostError::Timeout)?
            {
                Some(Event::Fault(HostError::Crashed)) => break,
                Some(Event::Fault(error)) => return Err(error),
                _ => return Err(HostError::UnexpectedFrame),
            }
        }
        if !status.success() || self.pipes.overflow.load(Ordering::Acquire) {
            return Err(HostError::Crashed);
        }
        self.pending.directory.take();
        Ok(CloseReceipt {
            cooperative_acknowledgement: true,
            direct_child_reaped: true,
            exit_code: status.code(),
        })
    }
}

/// Run exactly one captured member invocation. The caller must validate the
/// canonical context and model/tool profile through their original Core owners
/// before launch, and maintain the original live authority predicate thereafter.
pub async fn run_member(
    artifact: &CapturedMemberArtifact,
    runtime: &CapturedRuntime,
    staging_parent: &Path,
    start: MemberFrame,
    options: MemberLaunchOptions,
    handler: &mut impl MemberHandler,
    authorized: Arc<dyn Fn() -> bool + Send + Sync>,
) -> HostResult<MemberRunReceipt> {
    let observation = MemberRunObservation::default();
    run_member_observed(
        artifact,
        runtime,
        staging_parent,
        start,
        options,
        handler,
        authorized,
        &observation,
    )
    .await
}

/// The same owned run, with bounded failure attribution retained for its caller.
/// Observation does not change deadlines, authority or cleanup requirements.
pub async fn run_member_observed(
    artifact: &CapturedMemberArtifact,
    runtime: &CapturedRuntime,
    staging_parent: &Path,
    start: MemberFrame,
    options: MemberLaunchOptions,
    handler: &mut impl MemberHandler,
    authorized: Arc<dyn Fn() -> bool + Send + Sync>,
    observation: &MemberRunObservation,
) -> HostResult<MemberRunReceipt> {
    observation.enter(MemberPhase::Admission);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (
            artifact,
            runtime,
            staging_parent,
            start,
            options,
            handler,
            authorized,
        );
        Err(HostError::UnsupportedPlatform)
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        options.limits.validate()?;
        if !options.allow_unsandboxed_execution {
            return Err(HostError::ExecutionNotAuthorized);
        }
        if options.cancellation.is_requested() {
            return Err(HostError::Cancelled);
        }
        if !authorized() {
            return Err(HostError::AuthorityRevoked);
        }
        if start.protocol_version != wire::PROTOCOL
            || artifact.manifest().protocol_version != wire::PROTOCOL
            || start.sequence != 0
        {
            return Err(HostError::InvalidContract);
        }
        let MemberBody::Start {
            profile,
            tools,
            max_turns,
            timeout_ms,
            ..
        } = &start.body
        else {
            return Err(HostError::InvalidContract);
        };
        if *max_turns == 0 || *max_turns > 128 || *timeout_ms == 0 || *timeout_ms > 3_600_000 {
            return Err(HostError::InvalidLimits);
        }
        let max_turns = *max_turns;
        let endpoint = profile.endpoint.clone();
        let mut roster = BTreeSet::new();
        for tool in tools {
            if tool.name.is_empty() || tool.name.len() > 128 || !roster.insert(tool.name.clone()) {
                return Err(HostError::InvalidContract);
            }
        }
        let deadline = Instant::now() + Duration::from_millis((*timeout_ms).into());
        let io_stop = handler.cancellation();
        if io_stop.is_requested() {
            return Err(HostError::Cancelled);
        }
        let stage_artifact = artifact.clone();
        let stage_runtime = runtime.clone();
        let parent = staging_parent.to_owned();
        let stage_authorized = authorized.clone();
        let stage_cancelled = options.cancellation.clone();
        observation.enter(MemberPhase::Staging);
        let directory = tokio::task::spawn_blocking(move || {
            staging::materialize_member(
                &parent,
                stage_artifact.manifest_bytes(),
                stage_artifact.files(),
                &stage_runtime,
                || {
                    stage_authorized()
                        && !stage_cancelled.is_requested()
                        && Instant::now() < deadline
                },
            )
        })
        .await
        .map_err(|_| HostError::StageFailed)??;
        observation.enter(MemberPhase::Spawn);
        let package = directory.path().join("package");
        let mut command = ChildCommand::new(
            directory
                .path()
                .join("runtime/tool")
                .join(&runtime.descriptor().tool.entrypoint),
        );
        command
            .arg(package.join(&artifact.manifest().entrypoint))
            .current_dir(&package);
        directory.verify_binding()?;
        if !authorized() {
            return Err(HostError::AuthorityRevoked);
        }
        if options.cancellation.is_requested() {
            return Err(HostError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(HostError::Timeout);
        }
        let child = OwnedChild::spawn(&command).map_err(|_| HostError::SpawnFailed)?;
        let mut pending = PendingChild::new(child, directory, None);
        let child_pid = pending.pid.ok_or(HostError::SpawnFailed)?;
        let pipes = match attach_pipes(pending.child.as_mut().unwrap(), &options.limits) {
            Ok(pipes) => pipes,
            Err(error) => {
                pending.rollback(options.limits.cleanup_timeout_ms).await;
                if !matches!(pending.child.as_mut().unwrap().try_wait(), Ok(Some(_))) {
                    observation.enter(MemberPhase::Cleanup);
                    return Err(HostError::Timeout);
                }
                return Err(error);
            }
        };
        let admission = (|| {
            if !authorized() {
                return Err(HostError::AuthorityRevoked);
            }
            if options.cancellation.is_requested() || io_stop.is_requested() {
                return Err(HostError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(HostError::Timeout);
            }
            pending.directory.as_ref().unwrap().verify_binding()?;
            pending
                .child
                .as_mut()
                .unwrap()
                .start()
                .map_err(|_| HostError::SpawnFailed)
        })();
        if let Err(error) = admission {
            pending.rollback(options.limits.cleanup_timeout_ms).await;
            return Err(error);
        }
        let mut process = MemberProcess {
            pending,
            pipes,
            session: start.session_id,
            next_input: 0,
            next_output: 0,
            input_bytes: 0,
            limits: options.limits,
            cancellation: options.cancellation,
            io_stop,
            observation,
        };
        observation.enter(MemberPhase::Ready);
        let outcome = async {
            let handshake = deadline.min(
                Instant::now() + Duration::from_millis(process.limits.handshake_timeout_ms.into()),
            );
            process
                .send(start.body, &|| authorized(), handshake)
                .await?;
            if !matches!(
                process.receive(&|| authorized(), handshake).await?,
                MemberBody::Ready
            ) {
                return Err(HostError::HandshakeMismatch);
            }
            observation.enter(MemberPhase::Run);
            let mut calls = 0u32;
            let mut turns = 0u32;
            let mut active = None;
            let mut http_returned = false;
            let mut seen_requests = BTreeSet::new();
            let mut tool_calls = BTreeMap::new();
            loop {
                match process.receive(&|| authorized(), deadline).await? {
                    MemberBody::Request { request, call } => {
                        calls = calls
                            .checked_add(1)
                            .filter(|n| *n <= MAX_CALLS)
                            .ok_or(HostError::OutputLimit)?;
                        if request != calls {
                            return Err(HostError::RequestMismatch);
                        }
                        validate_call(&call, active, http_returned, &endpoint, &roster)?;
                        validate_tool_call(&call, &tool_calls)?;
                        let reply = process
                            .dispatch(handler, call.clone(), &|| authorized(), deadline)
                            .await?;
                        validate_reply(&call, &reply)?;
                        if let (
                            MemberCall::Prepare { .. },
                            MemberReply::Prepared { request_id, .. },
                        ) = (&call, &reply)
                        {
                            turns += 1;
                            if turns > max_turns || !seen_requests.insert(*request_id) {
                                return Err(HostError::RequestMismatch);
                            }
                            active = Some(*request_id);
                            http_returned = false;
                            tool_calls.clear();
                        }
                        observe_tool_reply(&call, &reply, &mut tool_calls);
                        if matches!(
                            (&call, &reply),
                            (MemberCall::Http { .. }, MemberReply::Http { .. })
                        ) {
                            http_returned = true;
                        }
                        process
                            .send(
                                MemberBody::Reply { request, reply },
                                &|| authorized(),
                                deadline,
                            )
                            .await?;
                    }
                    MemberBody::Result {
                        messages,
                        turn_limit_reached,
                    } => {
                        if turns == 0
                            || !http_returned
                            || tool_calls.values().any(|call| {
                                !matches!(call.state, ToolState::Denied | ToolState::Finalized)
                            })
                        {
                            return Err(HostError::ResultMismatch);
                        }
                        observation.enter(MemberPhase::Close);
                        let termination = process.finish(&|| authorized(), deadline).await?;
                        return Ok(MemberRunReceipt {
                            messages,
                            turn_limit_reached,
                            child_pid,
                            termination,
                        });
                    }
                    MemberBody::Fault { .. } => return Err(HostError::Crashed),
                    _ => return Err(HostError::UnexpectedFrame),
                }
            }
        }
        .await;
        if outcome.is_err() {
            process.io_stop.request();
            process
                .pending
                .rollback(process.limits.cleanup_timeout_ms)
                .await;
            if !matches!(
                process.pending.child.as_mut().unwrap().try_wait(),
                Ok(Some(_))
            ) {
                observation.enter(MemberPhase::Cleanup);
                return Err(HostError::Timeout);
            }
        }
        outcome
    }
}

fn validate_tool_call(call: &MemberCall, calls: &BTreeMap<String, ToolCall>) -> HostResult<()> {
    let valid = match call {
        MemberCall::Prepare { .. } => calls
            .values()
            .all(|call| matches!(call.state, ToolState::Denied | ToolState::Finalized)),
        MemberCall::BeforeTool { call_id, .. } => !calls.contains_key(call_id),
        MemberCall::ExecuteTool {
            call_id,
            name,
            arguments,
            ..
        } => calls.get(call_id).is_some_and(|call| {
            call.state == ToolState::Admitted && call.name == *name && call.arguments == *arguments
        }),
        MemberCall::AfterTool { call_id, name, .. } => calls.get(call_id).is_some_and(|call| {
            matches!(call.state, ToolState::Denied | ToolState::Executed) && call.name == *name
        }),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(HostError::RequestMismatch)
    }
}

fn observe_tool_reply(
    call: &MemberCall,
    reply: &MemberReply,
    calls: &mut BTreeMap<String, ToolCall>,
) {
    match (call, reply) {
        (
            MemberCall::BeforeTool {
                call_id,
                name,
                arguments,
                ..
            },
            MemberReply::ToolAdmission { block, .. },
        ) => {
            calls.insert(
                call_id.clone(),
                ToolCall {
                    name: name.clone(),
                    arguments: arguments.clone(),
                    state: if *block {
                        ToolState::Denied
                    } else {
                        ToolState::Admitted
                    },
                },
            );
        }
        (MemberCall::ExecuteTool { call_id, .. }, MemberReply::ToolResult { .. }) => {
            if let Some(call) = calls.get_mut(call_id) {
                call.state = ToolState::Executed;
            }
        }
        (MemberCall::AfterTool { call_id, .. }, MemberReply::ToolFinalized { .. }) => {
            if let Some(call) = calls.get_mut(call_id) {
                call.state = ToolState::Finalized;
            }
        }
        _ => {}
    }
}

fn validate_call(
    call: &MemberCall,
    active: Option<ExecutionId>,
    http_returned: bool,
    endpoint: &str,
    roster: &BTreeSet<String>,
) -> HostResult<()> {
    let matches = |request: &ExecutionId| {
        if Some(*request) == active {
            Ok(())
        } else {
            Err(HostError::RequestMismatch)
        }
    };
    match call {
        MemberCall::Prepare { .. } => Ok(()),
        MemberCall::Http {
            request_id,
            endpoint: observed,
            ..
        } => {
            matches(request_id)?;
            if http_returned || observed != endpoint {
                Err(HostError::RequestMismatch)
            } else {
                Ok(())
            }
        }
        MemberCall::BeforeTool {
            request_id,
            call_id,
            name,
            ..
        }
        | MemberCall::ExecuteTool {
            request_id,
            call_id,
            name,
            ..
        }
        | MemberCall::AfterTool {
            request_id,
            call_id,
            name,
            ..
        } => {
            matches(request_id)?;
            if !http_returned || call_id.is_empty() || call_id.len() > 256 || !roster.contains(name)
            {
                Err(HostError::RequestMismatch)
            } else {
                Ok(())
            }
        }
        MemberCall::FinishTurn { request_id, .. } | MemberCall::Usage { request_id, .. } => {
            matches(request_id)?;
            if http_returned {
                Ok(())
            } else {
                Err(HostError::RequestMismatch)
            }
        }
        MemberCall::Event { request_id, .. } => match request_id {
            Some(id) => matches(id),
            None => Ok(()),
        },
    }
}

fn validate_reply(call: &MemberCall, reply: &MemberReply) -> HostResult<()> {
    if matches!(reply, MemberReply::Rejected { .. }) {
        return Ok(());
    }
    let matched = match (call, reply) {
        (MemberCall::Prepare { .. }, MemberReply::Prepared { .. }) => true,
        (
            MemberCall::Http { request_id, .. },
            MemberReply::Http {
                request_id: returned,
                status,
                ..
            },
        ) => request_id == returned && (100..=599).contains(status),
        (MemberCall::BeforeTool { .. }, MemberReply::ToolAdmission { .. })
        | (MemberCall::ExecuteTool { .. }, MemberReply::ToolResult { .. })
        | (MemberCall::AfterTool { .. }, MemberReply::ToolFinalized { .. })
        | (MemberCall::FinishTurn { .. }, MemberReply::Turn { .. })
        | (MemberCall::Event { .. } | MemberCall::Usage { .. }, MemberReply::Recorded) => true,
        _ => false,
    };
    if matched {
        Ok(())
    } else {
        Err(HostError::ResultMismatch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn member_failure_categories_are_bounded_and_keep_other_errors_distinct() {
        let observation = MemberRunObservation::default();
        for (phase, categories) in [
            (
                MemberPhase::Admission,
                [
                    "member-timeout-admission",
                    "member-crashed-admission",
                    "member-channel-admission",
                ],
            ),
            (
                MemberPhase::Staging,
                [
                    "member-timeout-staging",
                    "member-crashed-staging",
                    "member-channel-staging",
                ],
            ),
            (
                MemberPhase::Spawn,
                [
                    "member-timeout-spawn",
                    "member-crashed-spawn",
                    "member-channel-spawn",
                ],
            ),
            (
                MemberPhase::Ready,
                [
                    "member-timeout-ready",
                    "member-crashed-ready",
                    "member-channel-ready",
                ],
            ),
            (
                MemberPhase::Run,
                [
                    "member-timeout-run",
                    "member-crashed-run",
                    "member-channel-run",
                ],
            ),
            (
                MemberPhase::Close,
                [
                    "member-timeout-close",
                    "member-crashed-close",
                    "member-channel-close",
                ],
            ),
            (
                MemberPhase::Cleanup,
                [
                    "member-timeout-cleanup",
                    "member-crashed-cleanup",
                    "member-channel-cleanup",
                ],
            ),
        ] {
            observation.enter(phase);
            for (error, category) in [
                HostError::Timeout,
                HostError::Crashed,
                HostError::ChannelFailed,
            ]
            .iter()
            .zip(categories)
            {
                assert_eq!(observation.failure_category(error), Some(category));
            }
            for error in [
                HostError::Cancelled,
                HostError::AuthorityRevoked,
                HostError::InvalidFrame,
                HostError::HandshakeMismatch,
                HostError::OutputLimit,
                HostError::StageFailed,
                HostError::SpawnFailed,
            ] {
                assert_eq!(observation.failure_category(&error), None);
            }
        }
    }

    #[test]
    fn tool_execution_requires_the_original_admission_and_arguments() {
        let request_id = ExecutionId::new();
        let before = MemberCall::BeforeTool {
            request_id,
            call_id: "call-1".into(),
            name: "lookup".into(),
            arguments: json!({"query":"one"}),
        };
        let execute = MemberCall::ExecuteTool {
            request_id,
            call_id: "call-1".into(),
            name: "lookup".into(),
            arguments: json!({"query":"one"}),
        };
        let mut calls = BTreeMap::new();
        assert_eq!(
            validate_tool_call(&execute, &calls),
            Err(HostError::RequestMismatch)
        );
        observe_tool_reply(
            &before,
            &MemberReply::ToolAdmission {
                block: false,
                reason: None,
            },
            &mut calls,
        );
        validate_tool_call(&execute, &calls).unwrap();
        assert_eq!(
            validate_tool_call(&before, &calls),
            Err(HostError::RequestMismatch)
        );
        let substituted = MemberCall::ExecuteTool {
            request_id,
            call_id: "call-1".into(),
            name: "lookup".into(),
            arguments: json!({"query":"two"}),
        };
        assert_eq!(
            validate_tool_call(&substituted, &calls),
            Err(HostError::RequestMismatch)
        );
        observe_tool_reply(
            &execute,
            &MemberReply::ToolResult {
                content: json!([]),
                details: json!({}),
                is_error: false,
            },
            &mut calls,
        );
        assert_eq!(
            validate_tool_call(&execute, &calls),
            Err(HostError::RequestMismatch)
        );
        let after = MemberCall::AfterTool {
            request_id,
            call_id: "call-1".into(),
            name: "lookup".into(),
            result: json!({}),
            is_error: false,
        };
        validate_tool_call(&after, &calls).unwrap();
        observe_tool_reply(
            &after,
            &MemberReply::ToolFinalized {
                content: None,
                is_error: None,
            },
            &mut calls,
        );
        assert_eq!(
            validate_tool_call(&after, &calls),
            Err(HostError::RequestMismatch)
        );
    }

    #[test]
    fn request_profile_identity_and_reply_kind_cannot_be_substituted() {
        let request_id = ExecutionId::new();
        let call = MemberCall::Http {
            request_id,
            endpoint: "http://127.0.0.1/model".into(),
            body: "{}".into(),
        };
        let roster = BTreeSet::new();
        validate_call(
            &call,
            Some(request_id),
            false,
            "http://127.0.0.1/model",
            &roster,
        )
        .unwrap();
        assert_eq!(
            validate_call(
                &call,
                Some(ExecutionId::new()),
                false,
                "http://127.0.0.1/model",
                &roster
            ),
            Err(HostError::RequestMismatch)
        );
        assert_eq!(
            validate_call(
                &call,
                Some(request_id),
                false,
                "http://127.0.0.1/other",
                &roster
            ),
            Err(HostError::RequestMismatch)
        );
        assert_eq!(
            validate_call(
                &call,
                Some(request_id),
                true,
                "http://127.0.0.1/model",
                &roster
            ),
            Err(HostError::RequestMismatch)
        );
        assert_eq!(
            validate_reply(&call, &MemberReply::Recorded),
            Err(HostError::ResultMismatch)
        );
        assert_eq!(
            validate_reply(
                &call,
                &MemberReply::Http {
                    request_id: ExecutionId::new(),
                    status: 200,
                    content_type: None,
                    body: String::new()
                }
            ),
            Err(HostError::ResultMismatch)
        );
    }
}
