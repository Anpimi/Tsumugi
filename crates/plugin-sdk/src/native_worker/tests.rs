use super::*;
use std::{
    net::Shutdown,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
enum Behavior {
    Echo,
    WaitActivation,
    WaitInvocation,
    ActivationFailure,
    CleanupFailure,
    Panic,
}
enum Observation {
    Activated(String, ContractRef),
    Invoked(EncodedPayload, InvocationContext, Option<ContractRef>),
}
struct Component {
    behavior: Behavior,
    observed: mpsc::Sender<Observation>,
    disposed: Arc<std::sync::atomic::AtomicUsize>,
    scope: Option<NativeCancellation>,
    invocation: Option<NativeCancellation>,
}
fn await_cancel(token: &NativeCancellation) {
    let until = Instant::now() + Duration::from_secs(3);
    while !token.is_cancelled() {
        assert!(
            Instant::now() < until,
            "control reader did not cancel running code"
        );
        thread::sleep(Duration::from_millis(1));
    }
}
impl NativeComponent for Component {
    fn activate(&mut self, context: &NativeComponentContext) -> Result<(), NativeComponentError> {
        self.scope = Some(context.cancellation.clone());
        self.observed
            .send(Observation::Activated(
                context.contribution_id.clone(),
                context.contract.clone(),
            ))
            .unwrap();
        if matches!(self.behavior, Behavior::WaitActivation) {
            await_cancel(&context.cancellation);
        }
        if matches!(self.behavior, Behavior::ActivationFailure) {
            return Err(io::Error::other("activation failed").into());
        }
        Ok(())
    }
    fn invoke(
        &mut self,
        input: &EncodedPayload,
        metadata: &NativeInvocationMetadata,
    ) -> NativeCapabilityOutput {
        self.invocation = Some(metadata.cancellation.clone());
        self.observed
            .send(Observation::Invoked(
                input.clone(),
                metadata.context.clone(),
                metadata.profile.clone(),
            ))
            .unwrap();
        if matches!(self.behavior, Behavior::WaitInvocation) {
            await_cancel(&metadata.cancellation);
        }
        if matches!(self.behavior, Behavior::Panic) {
            panic!("component failed");
        }
        match input.utf8.as_str() {
            "failed" => NativeCapabilityOutput::Failed("{\"code\":\"example.invalid\"}".into()),
            "unknown" => NativeCapabilityOutput::Unknown("{\"code\":\"example.uncertain\"}".into()),
            "oversized" => NativeCapabilityOutput::Succeeded("x".repeat(65537)),
            _ => NativeCapabilityOutput::Succeeded(input.utf8.clone()),
        }
    }
    fn dispose(&mut self) -> Result<(), NativeComponentError> {
        assert!(
            self.scope
                .as_ref()
                .is_none_or(NativeCancellation::is_cancelled)
        );
        assert!(
            self.invocation
                .as_ref()
                .is_none_or(NativeCancellation::is_cancelled)
        );
        self.disposed.fetch_add(1, Ordering::AcqRel);
        if matches!(self.behavior, Behavior::CleanupFailure) {
            return Err(io::Error::other("cleanup failed").into());
        }
        Ok(())
    }
}
struct Harness {
    peer: Peer,
    server: thread::JoinHandle<Result<(), NativeWorkerError>>,
    observed: Receiver<Observation>,
    disposed: Arc<std::sync::atomic::AtomicUsize>,
}
struct Peer {
    input: UnixStream,
    output: UnixStream,
}
impl Read for Peer {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.output.read(bytes)
    }
}
impl Write for Peer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.input.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.input.flush()
    }
}
fn harness(behavior: Behavior) -> Harness {
    let (input, reader) = UnixStream::pair().unwrap();
    let (output, writer) = UnixStream::pair().unwrap();
    output
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    input
        .set_write_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    let (send, observed) = mpsc::channel();
    let disposed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let component = Component {
        behavior,
        observed: send,
        disposed: disposed.clone(),
        scope: None,
        invocation: None,
    };
    Harness {
        peer: Peer { input, output },
        server: thread::spawn(move || serve(reader, writer, component)),
        observed,
        disposed,
    }
}
fn request() -> InvocationRequest {
    let ExchangeBody::Request(mut request) = parse_exchange(include_bytes!(
        "../../tests/fixtures/invocation.request.json"
    ))
    .unwrap()
    .document()
    .body
    .clone() else {
        panic!("request fixture");
    };
    request.input = EncodedPayload::capture(
        request.input.schema.clone(),
        "\u{feff}中文\r\n👩🏽‍💻 e\u{301}".into(),
    )
    .unwrap();
    request.context.input_digest = request.input.sha256.clone();
    request
}
fn activation(request: &InvocationRequest) -> ProcessActivation {
    ProcessActivation {
        services: vec![],
        instance: request.provider.instance(),
        capabilities: vec![ProcessCapability {
            contribution_id: request.provider.contribution_id.clone(),
            capability: CapabilityDeclaration {
                contract: request.capability.clone(),
                input_schema: request.input.schema.clone(),
                output_schema: request.output_schema.clone(),
                error_schema: request.error_schema.clone(),
                profiles: vec![request.profile.clone().unwrap()],
                effect: EffectKind::ReadOnly,
                permissions: vec![PermissionRequest::CapturedInput],
                limits: CapabilityLimits {
                    max_input_bytes: 131072,
                    max_output_bytes: 65536,
                    concurrency: 1,
                    timeout_ms: 1000,
                },
            },
        }],
    }
}
fn send(peer: &mut Peer, body: ProcessBody) {
    let bytes = ProcessFrame::new(body).encode().unwrap();
    peer.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
    peer.write_all(&bytes).unwrap();
}
fn receive(peer: &mut Peer) -> ProcessBody {
    read_frame(peer, &mut 0).unwrap().body
}
fn activated(h: &mut Harness, a: &ProcessActivation) {
    send(&mut h.peer, ProcessBody::Activate(a.clone()));
    assert_eq!(receive(&mut h.peer), ProcessBody::Ready(a.clone()));
    let Observation::Activated(id, contract) =
        h.observed.recv_timeout(Duration::from_secs(1)).unwrap()
    else {
        panic!("activation");
    };
    assert_eq!(id, a.capabilities[0].contribution_id);
    assert_eq!(contract, a.capabilities[0].capability.contract);
}
fn finish(mut h: Harness, a: &ProcessActivation) {
    send(
        &mut h.peer,
        ProcessBody::Close {
            instance: a.instance.clone(),
        },
    );
    assert_eq!(
        receive(&mut h.peer),
        ProcessBody::Closed {
            instance: a.instance.clone()
        }
    );
    drop(h.peer);
    h.server.join().unwrap().unwrap();
    assert_eq!(h.disposed.load(Ordering::Acquire), 1);
}
fn refused(mut h: Harness) -> NativeWorkerError {
    let mut unexpected = vec![];
    h.peer.read_to_end(&mut unexpected).unwrap();
    assert!(unexpected.is_empty(), "failed channel emitted a frame");
    drop(h.peer);
    let error = h.server.join().unwrap().unwrap_err();
    assert_eq!(h.disposed.load(Ordering::Acquire), 1);
    error
}

#[test]
fn exact_unicode_identity_all_outcomes_heartbeat_and_serial_results() {
    let mut h = harness(Behavior::Echo);
    let mut r = request();
    let a = activation(&r);
    activated(&mut h, &a);
    for (i, utf8) in [r.input.utf8.clone(), "failed".into(), "unknown".into()]
        .into_iter()
        .enumerate()
    {
        r.context.dispatch_id = if i == 0 {
            "d".repeat(128)
        } else {
            format!("dispatch-{i}")
        };
        r.input = EncodedPayload::capture(r.input.schema.clone(), utf8.clone()).unwrap();
        r.context.input_digest = r.input.sha256.clone();
        send(&mut h.peer, ProcessBody::Invoke(r.clone()));
        let ProcessBody::Result(result) = receive(&mut h.peer) else {
            panic!("result");
        };
        let bytes = serde_json::to_vec(&ExchangeDocument {
            protocol_version: EXCHANGE_PROTOCOL,
            body: ExchangeBody::Result(result.clone()),
        })
        .unwrap();
        receive_invocation_result(
            &bytes,
            &r,
            &a.provider(&r.provider.contribution_id).unwrap(),
        )
        .unwrap();
        assert_eq!(result.result_id, r.context.dispatch_id);
        match (i, result.outcome) {
            (0, InvocationOutcome::Succeeded { output }) => assert_eq!(output.utf8, utf8),
            (1, InvocationOutcome::Failed { error }) => {
                assert_eq!(error.utf8, "{\"code\":\"example.invalid\"}")
            }
            (2, InvocationOutcome::Unknown { error }) => {
                assert_eq!(error.utf8, "{\"code\":\"example.uncertain\"}")
            }
            _ => panic!("wrong outcome"),
        }
        let Observation::Invoked(input, context, profile) = h.observed.recv().unwrap() else {
            panic!("invocation");
        };
        assert_eq!(input, r.input);
        assert_eq!(context, r.context);
        assert_eq!(profile, r.profile);
        send(
            &mut h.peer,
            ProcessBody::Ping {
                nonce: format!("nonce-{i}"),
            },
        );
        assert_eq!(
            receive(&mut h.peer),
            ProcessBody::Pong {
                nonce: format!("nonce-{i}")
            }
        );
    }
    finish(h, &a);
}
#[test]
fn forged_requests_and_declared_input_limits_never_enter_component() {
    for case in 0..10 {
        let mut h = harness(Behavior::Echo);
        let mut r = request();
        let a = activation(&r);
        activated(&mut h, &a);
        match case {
            0 => r.provider.instance_id = "forged".into(),
            1 => r.capability.behavior_version += 1,
            2 => r.input.schema.behavior_version += 1,
            3 => r.output_schema.behavior_version += 1,
            4 => r.error_schema.behavior_version += 1,
            5 => r.profile = None,
            6 => r.profile.as_mut().unwrap().behavior_version += 1,
            7 => r.provider.contribution_id = "not-in-roster".into(),
            8 => r.provider.activation_generation += 1,
            _ => {
                r.input =
                    EncodedPayload::capture(r.input.schema.clone(), "x".repeat(131073)).unwrap();
                r.context.input_digest = r.input.sha256.clone();
            }
        }
        send(&mut h.peer, ProcessBody::Invoke(r));
        assert!(matches!(refused(h), NativeWorkerError::RequestMismatch));
    }
}
#[test]
fn output_payload_and_whole_result_limits_refuse_without_partial_frame() {
    for case in 0..2 {
        let mut h = harness(Behavior::Echo);
        let mut r = request();
        let a = activation(&r);
        activated(&mut h, &a);
        if case == 0 {
            r.input = EncodedPayload::capture(r.input.schema.clone(), "oversized".into()).unwrap();
            r.context.input_digest = r.input.sha256.clone();
        } else {
            r.max_result_bytes = 1;
        }
        send(&mut h.peer, ProcessBody::Invoke(r));
        assert!(matches!(refused(h), NativeWorkerError::OutputLimit));
    }
}
#[test]
fn cancellation_interrupts_running_handler_and_suppresses_late_result() {
    let mut h = harness(Behavior::WaitInvocation);
    let r = request();
    let a = activation(&r);
    activated(&mut h, &a);
    send(&mut h.peer, ProcessBody::Invoke(r.clone()));
    assert!(matches!(
        h.observed.recv_timeout(Duration::from_secs(1)).unwrap(),
        Observation::Invoked(..)
    ));
    send(
        &mut h.peer,
        ProcessBody::Cancel {
            dispatch_id: r.context.dispatch_id.clone(),
        },
    );
    assert_eq!(
        receive(&mut h.peer),
        ProcessBody::Cancelled {
            dispatch_id: r.context.dispatch_id
        }
    );
    finish(h, &a);
}
#[test]
fn unsupported_service_facade_refuses_before_author_activation() {
    let mut h = harness(Behavior::Echo);
    let request = request();
    let mut activation = activation(&request);
    activation.services.push(ServiceBinding {
        handle_id: "service-a".into(),
        provider_id: "example.native-service".into(),
        contract: request.capability.clone(),
        input_schema: request.input.schema.clone(),
        output_schema: request.output_schema.clone(),
        error_schema: request.error_schema.clone(),
        effect: EffectKind::ReadOnly,
        project_id: request.context.project_id.clone(),
        scope_id: request.context.scope_id.clone(),
        activation_generation: 1,
        configuration_digest: request.context.configuration_digest.clone(),
        limits: CapabilityLimits {
            max_input_bytes: 1024,
            max_output_bytes: 1024,
            concurrency: 1,
            timeout_ms: 1000,
        },
    });
    send(&mut h.peer, ProcessBody::Activate(activation));
    assert!(h.observed.recv_timeout(Duration::from_secs(1)).is_err());
    assert!(matches!(refused(h), NativeWorkerError::UnsupportedServices));
}

#[test]
fn multi_callable_roster_refuses_before_author_activation_or_ready() {
    let mut h = harness(Behavior::Echo);
    let mut a = activation(&request());
    let mut second = a.capabilities[0].clone();
    second.contribution_id = "another-capability".into();
    a.capabilities.push(second);
    a.validate().unwrap();
    send(&mut h.peer, ProcessBody::Activate(a));
    assert!(h.observed.recv_timeout(Duration::from_secs(1)).is_err());
    assert!(matches!(
        refused(h),
        NativeWorkerError::UnsupportedCapabilities
    ));
}

#[test]
fn close_during_activation_cancels_scope_and_waits_for_cleanup_without_ready() {
    let mut h = harness(Behavior::WaitActivation);
    let a = activation(&request());
    send(&mut h.peer, ProcessBody::Activate(a.clone()));
    assert!(matches!(
        h.observed.recv_timeout(Duration::from_secs(1)).unwrap(),
        Observation::Activated(..)
    ));
    finish(h, &a);
}
#[test]
fn close_during_invocation_waits_for_handler_and_cleanup_without_result() {
    let mut h = harness(Behavior::WaitInvocation);
    let r = request();
    let a = activation(&r);
    activated(&mut h, &a);
    send(&mut h.peer, ProcessBody::Invoke(r));
    assert!(matches!(
        h.observed.recv_timeout(Duration::from_secs(1)).unwrap(),
        Observation::Invoked(..)
    ));
    finish(h, &a);
}
#[test]
fn partial_activation_panic_and_failed_disposal_never_acknowledge_success() {
    for behavior in [
        Behavior::ActivationFailure,
        Behavior::Panic,
        Behavior::CleanupFailure,
    ] {
        let mut h = harness(behavior);
        let r = request();
        let a = activation(&r);
        if matches!(behavior, Behavior::ActivationFailure) {
            send(&mut h.peer, ProcessBody::Activate(a));
        } else {
            activated(&mut h, &a);
            send(
                &mut h.peer,
                if matches!(behavior, Behavior::Panic) {
                    ProcessBody::Invoke(r)
                } else {
                    ProcessBody::Close {
                        instance: a.instance,
                    }
                },
            );
        }
        assert!(matches!(refused(h), NativeWorkerError::ComponentFailed));
    }
}
#[test]
fn duplicate_dispatch_and_129th_call_are_refused() {
    for duplicate in [true, false] {
        let mut h = harness(Behavior::Echo);
        let mut r = request();
        let a = activation(&r);
        activated(&mut h, &a);
        let count = if duplicate { 1 } else { MAX_DISPATCHES };
        for i in 0..count {
            r.context.dispatch_id = format!("dispatch-{i}");
            send(&mut h.peer, ProcessBody::Invoke(r.clone()));
            assert!(matches!(receive(&mut h.peer), ProcessBody::Result(..)));
            h.observed.recv().unwrap();
        }
        if !duplicate {
            r.context.dispatch_id = "dispatch-extra".into();
        }
        send(&mut h.peer, ProcessBody::Invoke(r));
        assert!(matches!(refused(h), NativeWorkerError::RequestMismatch));
    }
}
#[test]
fn conflicting_control_and_worker_direction_are_refused_and_cancel_owned_work() {
    for case in 0..6 {
        let mut h = harness(Behavior::WaitInvocation);
        let r = request();
        let a = activation(&r);
        activated(&mut h, &a);
        send(&mut h.peer, ProcessBody::Invoke(r.clone()));
        h.observed.recv().unwrap();
        let body = match case {
            0 => ProcessBody::Invoke(r),
            1 => ProcessBody::Cancel {
                dispatch_id: "other".into(),
            },
            2 => ProcessBody::Ping {
                nonce: "busy".into(),
            },
            3 => {
                let mut instance = a.instance;
                instance.instance_id = "other".into();
                ProcessBody::Close { instance }
            }
            4 => {
                let mut instance = a.instance;
                instance.activation_generation += 1;
                ProcessBody::Close { instance }
            }
            _ => ProcessBody::Ready(a),
        };
        send(&mut h.peer, body);
        assert!(matches!(refused(h), NativeWorkerError::UnexpectedFrame));
    }
}
#[test]
fn malformed_and_incomplete_wire_is_refused_before_component_activation() {
    let duplicate =
        br#"{"protocolVersion":3,"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":"a"}}}"#;
    let mut malformed = (duplicate.len() as u32).to_be_bytes().to_vec();
    malformed.extend_from_slice(duplicate);
    for bytes in [
        vec![0, 0],
        vec![0, 0, 0, 0],
        u32::MAX.to_be_bytes().to_vec(),
        vec![0, 0, 0, 8, b'{'],
        malformed,
    ] {
        let mut h = harness(Behavior::Echo);
        h.peer.write_all(&bytes).unwrap();
        h.peer.input.shutdown(Shutdown::Write).unwrap();
        let _ = refused(h);
    }
}
#[test]
fn aggregate_stream_budget_is_checked_before_allocation_or_write() {
    let bytes = ProcessFrame::new(ProcessBody::Ping {
        nonce: "bounded".into(),
    })
    .encode()
    .unwrap();
    let mut wire = (bytes.len() as u32).to_be_bytes().to_vec();
    wire.extend_from_slice(&bytes);
    let mut total = MAX_STREAM_BYTES;
    assert!(matches!(
        read_frame(&mut wire.as_slice(), &mut total),
        Err(NativeWorkerError::OutputLimit)
    ));
    let mut writer = vec![];
    let mut total = MAX_STREAM_BYTES;
    assert!(matches!(
        emit(
            &mut writer,
            ProcessBody::Pong {
                nonce: "bounded".into()
            },
            &mut total,
            None
        ),
        Err(NativeWorkerError::OutputLimit)
    ));
    assert!(writer.is_empty());
}
