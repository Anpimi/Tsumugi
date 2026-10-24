use super::*;

#[test]
fn mcp_retrieval_stop_and_call_admission_share_one_gate() {
    let closed = Control::new(Instant::now() + std::time::Duration::from_secs(10));
    closed.close();
    assert!(!closed.claim_call());
    assert!(!closed.called.load(Ordering::Acquire));
    let live = Control::new(Instant::now() + std::time::Duration::from_secs(10));
    assert!(live.claim_call());
    assert!(!live.claim_call());
    live.close();
    assert!(!live.claim_call());
    let expired = Control::new(Instant::now());
    assert!(!expired.claim_call());
    let stopped = Control::new(Instant::now() + std::time::Duration::from_secs(10));
    assert!(stopped.claim_call());
    stopped.close();
    assert!(!stopped.accept_result(|| true));
    let completed = Control::new(Instant::now() + std::time::Duration::from_secs(10));
    assert!(completed.claim_call());
    assert!(completed.accept_result(|| true));
    assert!(!completed.accept_result(|| true));
}

#[test]
fn mcp_retrieval_sse_limits_count_empty_frames_and_partial_long_events() {
    tauri::async_runtime::block_on(async {
        let control = Control::new(Instant::now() + std::time::Duration::from_secs(10));
        let mut stream = EventBytes {
            inner: Box::pin(futures::stream::iter([Ok::<_, reqwest::Error>(
                bytes::Bytes::from(vec![b'\n'; MAX_FRAMES + 1]),
            )])),
            control: control.clone(),
            _work: control.work(),
            event_bytes: 0,
            line_bytes: 0,
            event_limit: MAX_FRAME_BYTES,
            failed: false,
        };
        assert!(stream.next().await.unwrap().is_err());
        assert!(control.closed());
        assert_eq!(control.frames.load(Ordering::Acquire), MAX_FRAMES);
        drop(stream);
        assert!(control.drained());
        let control = Control::new(Instant::now() + std::time::Duration::from_secs(10));
        let mut stream = EventBytes {
            inner: Box::pin(futures::stream::iter([
                Ok::<_, reqwest::Error>(bytes::Bytes::from_static(b":ignored-comment")),
                Ok(bytes::Bytes::from(vec![b'x'; 32])),
            ])),
            control: control.clone(),
            _work: control.work(),
            event_bytes: 0,
            line_bytes: 0,
            event_limit: 32,
            failed: false,
        };
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.unwrap().is_err());
        assert!(control.closed());
        assert_eq!(
            control.bytes.load(Ordering::Acquire),
            b":ignored-comment".len() + 32
        );
    });
}

#[test]
fn mcp_retrieval_sdk_and_response_work_remain_in_the_drain_barrier() {
    let control = Control::new(Instant::now() + std::time::Duration::from_secs(10));
    let sdk = Arc::new(control.work());
    let another_sdk_reference = sdk.clone();
    let response = control.work();
    control.close();
    assert!(!control.drained());
    drop(sdk);
    drop(response);
    assert!(!control.drained());
    drop(another_sdk_reference);
    assert!(control.drained());
}
