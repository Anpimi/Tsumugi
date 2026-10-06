//! Optional component-side lifecycle. The actual Host still owns the child,
//! package/channel identity, current authority, timeouts and adoption.
use crate::*;
use std::{
    collections::BTreeSet,
    fmt,
    io::{self, Read, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
};

const MAX_DISPATCHES: usize = 128;
const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;

/// Cooperative stop signal. It is not an authorization lease or evidence of
/// rollback. The Host terminates workers that do not respect its deadlines.
#[derive(Clone, Default)]
pub struct NativeCancellation {
    requested: Arc<AtomicBool>,
    scope: Option<Arc<AtomicBool>>,
}
impl NativeCancellation {
    pub fn is_cancelled(&self) -> bool {
        self.requested.load(Ordering::Acquire)
            || self
                .scope
                .as_ref()
                .is_some_and(|scope| scope.load(Ordering::Acquire))
    }
    fn cancel(&self) {
        self.requested.store(true, Ordering::Release);
    }
    fn child(scope: &Self) -> Self {
        Self {
            requested: Arc::default(),
            scope: Some(scope.requested.clone()),
        }
    }
}

pub struct NativeComponentContext {
    pub contribution_id: String,
    pub contract: ContractRef,
    pub cancellation: NativeCancellation,
}
pub struct NativeInvocationMetadata {
    pub context: InvocationContext,
    pub profile: Option<ContractRef>,
    pub cancellation: NativeCancellation,
}

/// Only opaque proposal bytes are author-owned. The SDK supplies the captured
/// request's context/provider/schema/digest and one result ID per dispatch.
pub enum NativeCapabilityOutput {
    Succeeded(String),
    Failed(String),
    Unknown(String),
}
pub type NativeComponentError = Box<dyn std::error::Error + Send + Sync>;

/// One component for the selected contribution on a serial process channel.
/// Activation and invocation run away from the control reader, so cancellation
/// and close remain observable while component code is running.
pub trait NativeComponent: Send + 'static {
    fn activate(&mut self, _context: &NativeComponentContext) -> Result<(), NativeComponentError> {
        Ok(())
    }
    fn invoke(
        &mut self,
        input: &EncodedPayload,
        metadata: &NativeInvocationMetadata,
    ) -> NativeCapabilityOutput;
    /// Called once after partial activation or an unwinding invocation panic.
    /// With `panic=abort`, the process exits and Host cleanup remains separate.
    /// A failure prevents a cooperative `closed` acknowledgement.
    fn dispose(&mut self) -> Result<(), NativeComponentError> {
        Ok(())
    }
}

#[derive(Debug)]
pub enum NativeWorkerError {
    Io(io::ErrorKind),
    Contract(ContractError),
    UnexpectedFrame,
    RequestMismatch,
    OutputLimit,
    ComponentFailed,
    ThreadUnavailable,
}
impl fmt::Display for NativeWorkerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never copy opaque inputs, component error messages or panic payloads.
        write!(f, "Native component channel failed: {self:?}")
    }
}
impl std::error::Error for NativeWorkerError {}
impl From<ContractError> for NativeWorkerError {
    fn from(error: ContractError) -> Self {
        Self::Contract(error)
    }
}
impl From<io::Error> for NativeWorkerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.kind())
    }
}

/// Serve one native Worker process. Call once from `main`; reserve stdout for
/// frames and exit unsuccessfully on error. The Host owns execution deadlines.
/// The bounded stdin reader ends when the peer closes stdin or this process
/// exits; this entry point is not an in-process, reusable transport service.
pub fn serve_native_component(component: impl NativeComponent) -> Result<(), NativeWorkerError> {
    serve(io::stdin(), io::stdout(), component)
}

enum Event {
    Frame(ProcessFrame),
    ReadFailed(NativeWorkerError),
    Activated,
    Output(Option<NativeCapabilityOutput>),
    Disposed,
    ComponentFailed,
}
enum Job {
    Activate(NativeComponentContext),
    Invoke(Arc<InvocationRequest>, NativeCancellation),
    Close,
}
#[derive(PartialEq)]
enum Phase {
    Waiting,
    Activating,
    Active,
    Closing,
}

fn read_frame(
    reader: &mut impl Read,
    total: &mut usize,
) -> Result<ProcessFrame, NativeWorkerError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_PROCESS_FRAME_BYTES {
        return Err(NativeWorkerError::OutputLimit);
    }
    *total = total
        .checked_add(length + 4)
        .ok_or(NativeWorkerError::OutputLimit)?;
    if *total > MAX_STREAM_BYTES {
        return Err(NativeWorkerError::OutputLimit);
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(parse_process_frame(&bytes)?)
}
fn emit(
    writer: &mut impl Write,
    body: ProcessBody,
    total: &mut usize,
    result_limit: Option<u32>,
) -> Result<(), NativeWorkerError> {
    let bytes = ProcessFrame::new(body).encode()?;
    if result_limit.is_some_and(|limit| bytes.len() > limit as usize) {
        return Err(NativeWorkerError::OutputLimit);
    }
    *total = total
        .checked_add(bytes.len() + 4)
        .ok_or(NativeWorkerError::OutputLimit)?;
    if *total > MAX_STREAM_BYTES {
        return Err(NativeWorkerError::OutputLimit);
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}
fn component_loop(
    mut component: impl NativeComponent,
    jobs: Receiver<Job>,
    events: SyncSender<Event>,
    scope: NativeCancellation,
) -> Result<(), NativeWorkerError> {
    let work = catch_unwind(AssertUnwindSafe(|| -> Result<(), NativeWorkerError> {
        while let Ok(job) = jobs.recv() {
            let event = match job {
                Job::Activate(context) => {
                    component
                        .activate(&context)
                        .map_err(|_| NativeWorkerError::ComponentFailed)?;
                    Event::Activated
                }
                Job::Invoke(request, cancellation) => {
                    let metadata = NativeInvocationMetadata {
                        context: request.context.clone(),
                        profile: request.profile.clone(),
                        cancellation,
                    };
                    Event::Output(if metadata.cancellation.is_cancelled() {
                        None
                    } else {
                        Some(component.invoke(&request.input, &metadata))
                    })
                }
                Job::Close => break,
            };
            if events.send(event).is_err() {
                break;
            }
        }
        Ok(())
    }))
    .unwrap_or(Err(NativeWorkerError::ComponentFailed));
    // Failed/partial activation and panics cancel author-owned work before
    // disposal too, without waiting for the coordinator to receive its error.
    scope.cancel();
    let cleanup = catch_unwind(AssertUnwindSafe(|| component.dispose()))
        .map_err(|_| NativeWorkerError::ComponentFailed)
        .and_then(|result| result.map_err(|_| NativeWorkerError::ComponentFailed));
    let result = work.and(cleanup);
    let _ = events.send(if result.is_ok() {
        Event::Disposed
    } else {
        Event::ComponentFailed
    });
    result
}

fn check_request(
    request: &InvocationRequest,
    activation: &ProcessActivation,
) -> Result<(), NativeWorkerError> {
    request.validate()?;
    let capability = &activation.capability;
    if request.provider != activation.provider
        || request.capability != capability.contract
        || request.input.schema != capability.input_schema
        || request.output_schema != capability.output_schema
        || request.error_schema != capability.error_schema
        || request
            .profile
            .as_ref()
            .is_some_and(|p| !capability.profiles.contains(p))
        || (request.profile.is_none() && !capability.profiles.is_empty())
        || request.input.utf8.len() > capability.limits.max_input_bytes as usize
    {
        return Err(NativeWorkerError::RequestMismatch);
    }
    Ok(())
}

fn result(
    request: &InvocationRequest,
    output: NativeCapabilityOutput,
    limit: u32,
) -> Result<InvocationResult, NativeWorkerError> {
    let (schema, utf8) = match &output {
        NativeCapabilityOutput::Succeeded(value) => (&request.output_schema, value),
        NativeCapabilityOutput::Failed(value) | NativeCapabilityOutput::Unknown(value) => {
            (&request.error_schema, value)
        }
    };
    if utf8.len() > limit as usize {
        return Err(NativeWorkerError::OutputLimit);
    }
    let payload = EncodedPayload::capture(schema.clone(), utf8.clone())?;
    let outcome = match output {
        NativeCapabilityOutput::Succeeded(_) => InvocationOutcome::Succeeded { output: payload },
        NativeCapabilityOutput::Failed(_) => InvocationOutcome::Failed { error: payload },
        NativeCapabilityOutput::Unknown(_) => InvocationOutcome::Unknown { error: payload },
    };
    Ok(InvocationResult {
        context: request.context.clone(),
        provider: request.provider.clone(),
        capability: request.capability.clone(),
        profile: request.profile.clone(),
        // Dispatch IDs are unique and already bounded on this channel. Do not
        // prefix an arbitrary 128-byte ID or give component code a result-ID hook.
        result_id: request.context.dispatch_id.clone(),
        outcome,
    })
}

fn serve<R: Read + Send + 'static, W: Write>(
    mut reader: R,
    mut writer: W,
    component: impl NativeComponent,
) -> Result<(), NativeWorkerError> {
    let (events, receive) = mpsc::sync_channel(2);
    let read_events = events.clone();
    thread::Builder::new()
        .name("tsumugi-native-input".into())
        .spawn(move || {
            let mut total = 0;
            loop {
                let event = match read_frame(&mut reader, &mut total) {
                    Ok(frame) => Event::Frame(frame),
                    Err(error) => {
                        let _ = read_events.send(Event::ReadFailed(error));
                        break;
                    }
                };
                if read_events.send(event).is_err() {
                    break;
                }
            }
        })
        .map_err(|_| NativeWorkerError::ThreadUnavailable)?;
    // A close can follow an activation/invocation before the worker has taken
    // that job. The state machine admits at most that job plus its close.
    let (jobs, work) = mpsc::sync_channel(2);
    let scope = NativeCancellation::default();
    let worker_scope = scope.clone();
    let worker = thread::Builder::new()
        .name("tsumugi-native-component".into())
        .spawn(move || component_loop(component, work, events, worker_scope))
        .map_err(|_| NativeWorkerError::ThreadUnavailable)?;
    let mut pending: Option<(Arc<InvocationRequest>, NativeCancellation)> = None;
    let mut activation: Option<ProcessActivation> = None;
    let mut phase = Phase::Waiting;
    let mut dispatches = BTreeSet::new();
    let mut sent = 0;
    let outcome = (|| {
        loop {
            match receive
                .recv()
                .map_err(|_| NativeWorkerError::ComponentFailed)?
            {
                Event::Frame(frame) => match frame.body {
                    ProcessBody::Activate(value) if phase == Phase::Waiting => {
                        jobs.try_send(Job::Activate(NativeComponentContext {
                            contribution_id: value.provider.contribution_id.clone(),
                            contract: value.capability.contract.clone(),
                            cancellation: scope.clone(),
                        }))
                        .map_err(|_| NativeWorkerError::UnexpectedFrame)?;
                        activation = Some(value);
                        phase = Phase::Activating;
                    }
                    ProcessBody::Invoke(request) if phase == Phase::Active && pending.is_none() => {
                        check_request(&request, activation.as_ref().unwrap())?;
                        if dispatches.len() >= MAX_DISPATCHES
                            || !dispatches.insert(request.context.dispatch_id.clone())
                        {
                            return Err(NativeWorkerError::RequestMismatch);
                        }
                        let request = Arc::new(request);
                        let cancellation = NativeCancellation::child(&scope);
                        jobs.try_send(Job::Invoke(request.clone(), cancellation.clone()))
                            .map_err(|_| NativeWorkerError::UnexpectedFrame)?;
                        pending = Some((request, cancellation));
                    }
                    ProcessBody::Cancel { dispatch_id }
                        if phase == Phase::Active
                            && pending
                                .as_ref()
                                .is_some_and(|(r, _)| r.context.dispatch_id == dispatch_id) =>
                    {
                        let (_, cancellation) = pending.as_ref().unwrap();
                        if cancellation.is_cancelled() {
                            return Err(NativeWorkerError::UnexpectedFrame);
                        }
                        cancellation.cancel();
                        emit(
                            &mut writer,
                            ProcessBody::Cancelled { dispatch_id },
                            &mut sent,
                            None,
                        )?;
                    }
                    ProcessBody::Close { provider }
                        if (phase == Phase::Active || phase == Phase::Activating)
                            && activation.as_ref().is_some_and(|a| a.provider == provider) =>
                    {
                        phase = Phase::Closing;
                        scope.cancel();
                        if let Some((_, token)) = &pending {
                            token.cancel();
                        }
                        jobs.try_send(Job::Close)
                            .map_err(|_| NativeWorkerError::UnexpectedFrame)?;
                    }
                    ProcessBody::Ping { nonce } if phase == Phase::Active && pending.is_none() => {
                        emit(&mut writer, ProcessBody::Pong { nonce }, &mut sent, None)?;
                    }
                    _ => return Err(NativeWorkerError::UnexpectedFrame),
                },
                Event::Activated if phase == Phase::Activating => {
                    phase = Phase::Active;
                    emit(
                        &mut writer,
                        ProcessBody::Ready(activation.as_ref().unwrap().clone()),
                        &mut sent,
                        None,
                    )?;
                }
                Event::Activated if phase == Phase::Closing => {}
                Event::Output(output) if phase == Phase::Active || phase == Phase::Closing => {
                    let (request, cancellation) =
                        pending.take().ok_or(NativeWorkerError::UnexpectedFrame)?;
                    if phase == Phase::Active && !cancellation.is_cancelled() {
                        let result = result(
                            &request,
                            output.ok_or(NativeWorkerError::ComponentFailed)?,
                            activation
                                .as_ref()
                                .unwrap()
                                .capability
                                .limits
                                .max_output_bytes,
                        )?;
                        emit(
                            &mut writer,
                            ProcessBody::Result(result),
                            &mut sent,
                            Some(request.max_result_bytes),
                        )?;
                    }
                }
                Event::Disposed if phase == Phase::Closing && pending.is_none() => {
                    emit(
                        &mut writer,
                        ProcessBody::Closed {
                            provider: activation.as_ref().unwrap().provider.clone(),
                        },
                        &mut sent,
                        None,
                    )?;
                    return Ok(());
                }
                Event::ReadFailed(error) => return Err(error),
                Event::ComponentFailed => return Err(NativeWorkerError::ComponentFailed),
                _ => return Err(NativeWorkerError::UnexpectedFrame),
            }
        }
    })();
    scope.cancel();
    if let Some((_, token)) = pending {
        token.cancel();
    }
    // Release a reader blocked on its bounded queue and let the owned component
    // finish/clean up. An uncooperative component is bounded by the actual Host.
    drop(receive);
    drop(jobs);
    let cleanup = worker
        .join()
        .map_err(|_| NativeWorkerError::ComponentFailed)?;
    outcome.and(cleanup)
}

#[cfg(all(test, unix))]
mod tests;
