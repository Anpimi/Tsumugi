use super::tests::{config, consent, fixture};
use super::*;
use crate::{ai::provider::*, application::*, execution::*};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

fn member_fixture(
    endpoint: String,
) -> (tempfile::TempDir, ProjectStore, WorkPlan, DispatchRequest) {
    let (temp, mut store, units) = fixture();
    let mut config = config();
    config.endpoint = endpoint;
    config.max_requests = 2;
    config.timeout_seconds = 5;
    let plan = store
        .prepare_work_plan(Some(config), "zh-CN", &units, PlanOptions::default())
        .unwrap();
    let receipt = store.authorize_work_plan(&plan, &consent(&plan)).unwrap();
    store
        .enqueue_execution(&FixedInput::capture(receipt.input.unwrap()).unwrap())
        .unwrap();
    let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
    let input = store
        .prepare_work_plan_agent_generation(
            &scope,
            &AgentGenerationRequest {
                task_id: ExecutionId::new(),
                attempt_id: ExecutionId::new(),
                unit_ids: vec![units[0]],
            },
        )
        .unwrap();
    store
        .enqueue_work_plan_agent_generation(&input, RecoveryPolicy::ExternalUnknown)
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    (temp, store, plan, dispatch)
}
fn body(dispatch: &DispatchRequest) -> String {
    let config = crate::ai::settings(&dispatch.input).unwrap().config;
    let mut body = serde_json::json!({"model":config.model,"stream":true,"messages":[{"role":"user","content":"captured 👩🏽‍💻"}]});
    body[&config.token_field] = config.max_output_tokens.into();
    body.to_string()
}
fn drive<T: Send>(
    store: &mut ProjectStore,
    mut dispatch: DispatchRequest,
    work: impl FnOnce(MemberProviderSession) -> T + Send,
    mut tick: impl FnMut(&mut ProjectStore),
) -> T {
    let (budget, events) = crate::ai::provider::budget_channel();
    dispatch.provider = Some(budget);
    let original = dispatch.clone();
    std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            work(
                MemberProviderSession::new(
                    Arc::new(ProviderService::default()),
                    dispatch,
                    Cancellation::default(),
                )
                .unwrap(),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        while !worker.is_finished() {
            assert!(Instant::now() < deadline, "bounded member budget exchange");
            match events.recv_timeout(Duration::from_millis(10)) {
                Ok(BudgetEvent::Reserve {
                    id,
                    limit,
                    capture,
                    reply,
                }) => {
                    let _ = reply.send(store.reserve_provider_request_capture(
                        &original,
                        id,
                        limit,
                        capture.as_ref(),
                    ));
                }
                Ok(BudgetEvent::Settle { id, usage, reply }) => {
                    let _ = reply.send(store.settle_provider_request(&original, id, usage));
                }
                Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
            }
            tick(store);
        }
        worker.join().unwrap()
    })
}
fn request(socket: &mut std::net::TcpStream) -> Vec<u8> {
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let read = socket.read(&mut chunk).unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
        assert!(bytes.len() < 65536);
        if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|length| length.trim().parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                return bytes[end + 4..].to_vec();
            }
        }
    }
}

#[test]
fn member_provider_persists_exact_sse_requests_and_shares_original_budget_on_reopen() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let mut reply = ": heartbeat\n\n".repeat(6000).into_bytes();
    reply.extend_from_slice(
        b"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n",
    );
    let expected_reply = reply.clone();
    let wire = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().unwrap();
            requests.push(request(&mut socket));
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).unwrap();
            socket.write_all(&reply).unwrap();
        }
        requests
    });
    let (_temp, mut store, plan, dispatch) = member_fixture(endpoint);
    let payload = body(&dispatch);
    let expected = payload.clone();
    let ids = drive(
        &mut store,
        dispatch,
        move |mut session| {
            let mut ids = Vec::new();
            for index in 0..2 {
                let id = session.prepare().unwrap();
                let response = session.exchange(id, payload.clone()).unwrap();
                assert_eq!(response.request_id, id);
                assert_eq!(response.status, 200);
                assert_eq!(response.content_type.as_deref(), Some("text/event-stream"));
                assert_eq!(response.body, expected_reply);
                session
                    .settle_usage(
                        id,
                        if index == 0 {
                            None
                        } else {
                            Some(crate::ai::Usage {
                                prompt_tokens: 10,
                                completion_tokens: 3,
                            })
                        },
                    )
                    .unwrap();
                if index == 1 {
                    assert_eq!(
                        session
                            .settle_usage(
                                id,
                                Some(crate::ai::Usage {
                                    prompt_tokens: 11,
                                    completion_tokens: 3
                                })
                            )
                            .err()
                            .unwrap()
                            .code,
                        ErrorCode::ResultMismatch
                    );
                    session.settle_usage(id, None).unwrap();
                }
                ids.push(id);
            }
            let third = session.prepare().unwrap();
            assert_eq!(
                session.exchange(third, payload).err().unwrap().code,
                ErrorCode::LimitExceeded
            );
            ids
        },
        |_| {},
    );
    assert_eq!(
        wire.join().unwrap(),
        vec![expected.as_bytes(), expected.as_bytes()]
    );
    let budget = store
        .provider_budget(plan.execution_input().unwrap().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(budget.dispatched, 2);
    assert_eq!(budget.usage_unknown, 1);
    assert_eq!(budget.prompt_tokens, "10");
    for id in &ids {
        let bytes: Vec<u8> = store
            .connection
            .as_ref()
            .unwrap()
            .query_row(
                "SELECT capture FROM execution_provider_requests WHERE request_id=?1",
                [id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        let capture: ProviderRequestCapture = codec::decode(&bytes, 131072).unwrap();
        assert_eq!(capture.body, expected);
    }
    let connection = store.connection.as_ref().unwrap();
    let original: Vec<u8> = connection
        .query_row(
            "SELECT capture FROM execution_provider_requests WHERE request_id=?1",
            [ids[0].to_string()],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "UPDATE execution_provider_requests SET capture=?1 WHERE request_id=?2",
            rusqlite::params![b"corrupt".as_slice(), ids[0].to_string()],
        )
        .unwrap();
    assert_eq!(
        super::super::ledger::provider::validate(connection)
            .err()
            .unwrap()
            .code,
        ErrorCode::CorruptLedger
    );
    connection
        .execute(
            "UPDATE execution_provider_requests SET capture=?1 WHERE request_id=?2",
            rusqlite::params![original, ids[0].to_string()],
        )
        .unwrap();
    let directory = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(directory).unwrap();
    assert_eq!(
        reopened
            .provider_budget(plan.execution_input().unwrap().task_id)
            .unwrap()
            .unwrap(),
        budget
    );
}

#[test]
fn member_provider_rejects_changed_profile_before_reservation_or_http() {
    let (_temp, mut store, _plan, dispatch) =
        member_fixture("http://127.0.0.1:9/v1/chat/completions".into());
    let payload = body(&dispatch);
    let parent = dispatch.input.envelope().task_id;
    drive(
        &mut store,
        dispatch,
        move |mut session| {
            let id = session.prepare().unwrap();
            for (field, value) in [
                ("model", serde_json::json!("different")),
                ("stream", serde_json::json!(false)),
                ("max_tokens", serde_json::json!(999999)),
            ] {
                let mut changed: serde_json::Value = serde_json::from_str(&payload).unwrap();
                changed[field] = value;
                assert_eq!(
                    session
                        .exchange(id, changed.to_string())
                        .err()
                        .unwrap()
                        .code,
                    ErrorCode::ResultMismatch
                );
            }
        },
        |_| {},
    );
    assert_eq!(
        store.provider_budget(parent).unwrap().unwrap().dispatched,
        0
    );
}

#[test]
fn member_provider_cancel_drops_stalled_sse_and_keeps_durable_unknown_capture() {
    cancel_stalled_member_response(false);
}

#[test]
fn member_provider_chunked_cancel_closes_socket_while_shared_service_stays_alive() {
    cancel_stalled_member_response(true);
}

fn cancel_stalled_member_response(chunked: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let (started, started_rx) = mpsc::channel();
    let wire = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        request(&mut socket);
        if chunked {
            // This is one complete HTTP chunk and an unfinished response. The
            // chunk's eleven bytes contain an SSE comment, not a provider result.
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nB\r\n: waiting\n\n\r\n").unwrap();
        } else {
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 10000\r\n\r\ndata: partial\n\n").unwrap();
        }
        socket.flush().unwrap();
        started.send(()).unwrap();
        let mut byte = [0];
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        assert_eq!(
            socket.read(&mut byte).unwrap(),
            0,
            "cancelled transport socket closed"
        );
    });
    let (_temp, mut store, plan, mut dispatch) = member_fixture(endpoint);
    let payload = body(&dispatch);
    let cancellation = Cancellation::default();
    let worker_cancel = cancellation.clone();
    let (budget, events) = crate::ai::provider::budget_channel();
    dispatch.provider = Some(budget);
    let worker_dispatch = dispatch.clone();
    // The desktop retains this service beyond any member. Holding the owner
    // through the socket observation prevents client/runtime destruction from
    // being mistaken for cancellation of this individual physical request.
    let service = Arc::new(ProviderService::default());
    let worker_service = service.clone();
    let before = Instant::now();
    let mut paused = false;
    std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            let mut session =
                MemberProviderSession::new(worker_service, worker_dispatch, worker_cancel).unwrap();
            let id = session.prepare().unwrap();
            let error = session.exchange(id, payload).err().unwrap();
            assert_eq!(error.code, ErrorCode::OutcomeUnknown);
            assert_eq!(error.stage, "ai-cancelled-after-dispatch");
            assert!(session.prepare().is_err());
        });
        while !worker.is_finished() {
            if let Ok(BudgetEvent::Reserve {
                id,
                limit,
                capture,
                reply,
            }) = events.recv_timeout(Duration::from_millis(10))
            {
                reply
                    .send(store.reserve_provider_request_capture(
                        &dispatch,
                        id,
                        limit,
                        capture.as_ref(),
                    ))
                    .unwrap();
            }
            if started_rx.try_recv().is_ok() {
                assert!(
                    Arc::strong_count(&service) >= 2,
                    "shared transport service must outlive the pending request"
                );
                cancellation.request();
                paused = true;
            }
            assert!(
                before.elapsed() < Duration::from_secs(3),
                "cancellation interrupts IO before model timeout"
            );
        }
        worker.join().unwrap();
    });
    assert_eq!(
        Arc::strong_count(&service),
        1,
        "only the external service owner remains after the member drains"
    );
    wire.join().unwrap();
    // Keep the exact shared client/runtime owner alive until after real EOF.
    drop(service);
    assert!(paused);
    let budget = store
        .provider_budget(plan.execution_input().unwrap().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(budget.dispatched, 1);
    assert_eq!(budget.unresolved, 1);
    assert_eq!(budget.usage_unknown, 1);
    let captures: u32 = store
        .connection
        .as_ref()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM execution_provider_requests WHERE capture IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(captures, 1);
}
