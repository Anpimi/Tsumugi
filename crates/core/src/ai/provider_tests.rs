use super::*;
use crate::ai::provider::ProviderService;
use std::process::{Command, Stdio};

#[test]
fn provider_children_keep_the_exact_parent_dependencies() {
    let (_temp, mut store, rows) = source_project();
    let preview = store
        .preview_ai(
            config("http://127.0.0.1:9/v1/chat/completions".into()),
            "zh-CN",
            &[rows[0].unit_id.unwrap()],
        )
        .unwrap();
    let project = store.metadata().unwrap().project_id();
    let dependency = Dependency {
        kind: "captured-source".into(),
        id: rows[0].source_revision_id.unwrap().to_string(),
        expected_revision: Revision::new(1).unwrap(),
    };
    let mut other_dependency = dependency.clone();
    other_dependency.id = rows[1].source_revision_id.unwrap().to_string();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register_with_policy(
            Arc::new(AiRunner::default()),
            RecoveryPolicy::ExternalUnknown,
        )
        .unwrap();

    for parent_dependencies in [
        vec![],
        vec![dependency.clone()],
        vec![dependency.clone(), other_dependency.clone()],
    ] {
        let capture = |dependencies| {
            let mut envelope = preview.fixed_input(project).unwrap().envelope().clone();
            envelope.items[0].dependencies = dependencies;
            FixedInput::capture(envelope).unwrap()
        };
        let parent = capture(parent_dependencies.clone());
        runtime.submit(&mut store, &parent).unwrap();
        let mut changed_revision = dependency.clone();
        changed_revision.expected_revision = Revision::new(2).unwrap();
        let mut changed_kind = dependency.clone();
        changed_kind.kind = "captured-context".into();
        for dependencies in [
            vec![],
            vec![dependency.clone()],
            vec![other_dependency.clone()],
            vec![changed_revision],
            vec![changed_kind],
            vec![dependency.clone(), other_dependency.clone()],
        ] {
            if dependencies == parent_dependencies {
                continue;
            }
            let child = capture(dependencies);
            assert_eq!(
                child.envelope().items[0].scope,
                parent.envelope().items[0].scope
            );
            assert_eq!(
                child.envelope().items[0].payload,
                parent.envelope().items[0].payload
            );
            let error = runtime
                .submit_child(&mut store, &child, parent.envelope().task_id)
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::Unauthorized);
            assert_eq!(error.stage, "provider-parent-scope");
            assert!(store.execution_input(child.envelope().attempt_id).is_err());
        }
        let child = capture(parent_dependencies.into_iter().rev().collect());
        runtime
            .submit_child(&mut store, &child, parent.envelope().task_id)
            .unwrap();
        let stored = store.execution_input(child.envelope().attempt_id).unwrap();
        assert_eq!(stored.envelope(), child.envelope());
        assert_eq!(stored.digest(), child.digest());
        let budget = store
            .provider_budget(parent.envelope().task_id)
            .unwrap()
            .unwrap();
        assert_eq!((budget.dispatched, budget.unresolved), (0, 0));
    }
}

#[test]
fn provider_shared_parent_budget_persists_and_scope_cannot_expand() {
    let (temp, mut store, rows) = source_project();
    let (url, calls, wire) = server("ok");
    let mut config = config(url);
    config.max_requests = 1;
    let root = store
        .preview_ai(config.clone(), "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let child = store
        .preview_ai(config.clone(), "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let outside = store
        .preview_ai(config.clone(), "zh-CN", &[rows[1].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let service = Arc::new(ProviderService::default());
    let mut rt = ExecutionRuntime::new(&store).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::with_service(service.clone())),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    rt.submit(&mut store, &root).unwrap();
    assert_eq!(
        rt.submit_child(&mut store, &outside, root.envelope().task_id)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        store
            .execution_input(outside.envelope().attempt_id)
            .is_err()
    );
    let mut other_config = config.clone();
    other_config.endpoint = "http://127.0.0.1:9/v1/chat/completions".into();
    let different = store
        .preview_ai(other_config, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    assert_eq!(
        rt.submit_child(&mut store, &different, root.envelope().task_id)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        store
            .execution_input(different.envelope().attempt_id)
            .is_err()
    );
    rt.submit_child(&mut store, &child, root.envelope().task_id)
        .unwrap();
    drain(&mut rt, &mut store, root.envelope().attempt_id);
    drain(&mut rt, &mut store, child.envelope().attempt_id);
    let budget = store
        .provider_budget(root.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(budget.dispatched, 1);
    assert_eq!(budget.limit, 1);
    assert_eq!(budget.usage_unknown, 0);
    assert_eq!(budget.prompt_tokens, "40");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.client_count(), 1);
    drop(rt);
    drop(store);
    let mut reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .provider_budget(root.envelope().task_id)
            .unwrap()
            .unwrap(),
        budget
    );
    let mut rt = ExecutionRuntime::new(&reopened).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::default()),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    rt.tick(&mut reopened).unwrap();
    let next = reopened
        .preview_ai(config, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(reopened.metadata().unwrap().project_id())
        .unwrap();
    rt.submit_child(&mut reopened, &next, root.envelope().task_id)
        .unwrap();
    drain(&mut rt, &mut reopened, next.envelope().attempt_id);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        reopened
            .execution_recovery(next.envelope().attempt_id, false)
            .unwrap()
            .units
            .iter()
            .all(|u| !u.actions.iter().any(|a| matches!(
                a,
                RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure
            )))
    );
    wire.join().unwrap();
}

#[test]
fn provider_rate_window_is_separate_from_concurrency_and_clients_are_reused() {
    let (_temp, mut store, rows) = source_project();
    let (url, calls, wire) = server("ok");
    let service = Arc::new(ProviderService::default());
    let mut config = config(url);
    config.concurrency = 2;
    let mut rt = ExecutionRuntime::new(&store).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::with_service(service.clone())),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    let first = store
        .preview_ai(
            config.clone(),
            "zh-CN",
            &[
                rows[0].unit_id.unwrap(),
                rows[1].unit_id.unwrap(),
                rows[2].unit_id.unwrap(),
            ],
        )
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let start = Instant::now();
    rt.submit(&mut store, &first).unwrap();
    drain(&mut rt, &mut store, first.envelope().attempt_id);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert!(start.elapsed() >= Duration::from_millis(1000));
    assert_eq!(service.client_count(), 1);
    config.credential_env = "A_DIFFERENT_NAME".into();
    let _ = service.client(&config).unwrap();
    assert_eq!(service.client_count(), 1);
    config.timeout_seconds += 1;
    let _ = service.client(&config).unwrap();
    assert_eq!(service.client_count(), 2);
    wire.join().unwrap();
}

#[test]
fn provider_parent_cancel_stops_children_and_preserves_unknown_reservation() {
    let (_temp, mut store, rows) = source_project();
    let mut c = config("http://127.0.0.1:9/v1/chat/completions".into());
    c.max_requests = 2;
    let root = store
        .preview_ai(c.clone(), "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let child = store
        .preview_ai(c, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut rt = ExecutionRuntime::new(&store).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::default()),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    rt.submit(&mut store, &root).unwrap();
    rt.submit_child(&mut store, &child, root.envelope().task_id)
        .unwrap();
    let request = store
        .dispatch_execution_item(
            child.envelope().attempt_id,
            child.envelope().items[0].item_id,
        )
        .unwrap();
    store
        .reserve_provider_request(&request, ExecutionId::new(), 2)
        .unwrap();
    let cancellation = ExecutionId::new();
    rt.cancel(&mut store, root.envelope().task_id, cancellation)
        .unwrap();
    rt.cancel(&mut store, root.envelope().task_id, cancellation)
        .unwrap();
    let view = store
        .execution_attempt(child.envelope().attempt_id, false)
        .unwrap();
    assert!(view.items[0].cancellation_requested);
    assert_eq!(view.cancellation_revision.get(), 1);
    assert_eq!(
        store
            .reserve_provider_request(&request, ExecutionId::new(), 2)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    let budget = store
        .provider_budget(root.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (budget.dispatched, budget.unresolved, budget.usage_unknown),
        (1, 1, 1)
    );
}

#[test]
fn provider_current_reopen_preserves_budget_and_refuses_future_schema() {
    let (temp, mut store, rows) = source_project();
    let (url, _, wire) = server("ok");
    let mut c = config(url);
    c.max_requests = 3;
    let input = store
        .preview_ai(c, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut rt = ExecutionRuntime::new(&store).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::default()),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    rt.submit(&mut store, &input).unwrap();
    drain(&mut rt, &mut store, input.envelope().attempt_id);
    let captured_budget = store
        .provider_budget(input.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!((captured_budget.limit, captured_budget.dispatched), (3, 1));
    drop(rt);
    drop(store);
    wire.join().unwrap();
    let path = temp.path().join("project");
    let db = path.join("project.sqlite3");
    let before = std::fs::read(&db).unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    let budget = reopened
        .provider_budget(input.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(budget, captured_budget);
    assert_eq!(std::fs::read(&db).unwrap(), before);
    drop(reopened);
    let c = rusqlite::Connection::open(&db).unwrap();
    c.pragma_update(None, "user_version", crate::persistence::SCHEMA_VERSION + 1)
        .unwrap();
    drop(c);
    let future = std::fs::read(&db).unwrap();
    let error = ProjectStore::open(&path).unwrap_err();
    assert_eq!(error.code(), crate::PersistenceErrorCode::UnsupportedSchema);
    assert_eq!(
        error.found_schema_version(),
        Some(crate::persistence::SCHEMA_VERSION + 1)
    );
    assert_eq!(std::fs::read(&db).unwrap(), future);
    assert_ne!(before, future);
}

#[test]
fn provider_reservation_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_PROVIDER_PROJECT") else {
        return;
    };
    let attempt = ExecutionId::parse(&std::env::var("TSUMUGI_PROVIDER_ATTEMPT").unwrap()).unwrap();
    let mut store = ProjectStore::open(path).unwrap();
    let input = store.execution_input(attempt).unwrap();
    let request = store
        .execution_dispatch(attempt, input.envelope().items[0].item_id)
        .unwrap();
    store
        .reserve_provider_request(&request, ExecutionId::new(), 1)
        .unwrap();
    std::process::abort();
}
#[test]
fn provider_process_crash_preserves_reservation_without_sending_or_replaying() {
    let (temp, mut store, rows) = source_project();
    let (url, calls, wire) = server("ok");
    let mut c = config(url);
    c.max_requests = 1;
    let input = store
        .preview_ai(c, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut rt = ExecutionRuntime::new(&store).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::default()),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    rt.submit(&mut store, &input).unwrap();
    store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    drop(rt);
    drop(store);
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ai::tests::provider_tests::provider_reservation_crash_child",
            "--nocapture",
        ])
        .env("TSUMUGI_PROVIDER_PROJECT", temp.path().join("project"))
        .env(
            "TSUMUGI_PROVIDER_ATTEMPT",
            input.envelope().attempt_id.to_string(),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let status = bounded_child(status);
    assert!(!status.success());
    let mut store = ProjectStore::open(temp.path().join("project")).unwrap();
    let budget = store
        .provider_budget(input.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!((budget.dispatched, budget.unresolved), (1, 1));
    let mut rt = ExecutionRuntime::new(&store).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::default()),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    rt.tick(&mut store).unwrap();
    assert!(
        rt.resume(
            &mut store,
            input.envelope().attempt_id,
            &[input.envelope().items[0].item_id]
        )
        .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    wire.join().unwrap();
}

#[test]
fn provider_backoff_honors_delta_and_date_without_unbounded_wait() {
    use crate::ai::provider::retry_delay;
    assert_eq!(retry_delay(0, Some("2")).unwrap(), Duration::from_secs(2));
    let date = httpdate::fmt_http_date(std::time::SystemTime::now() + Duration::from_secs(3));
    let delay = retry_delay(0, Some(&date)).unwrap();
    assert!(delay <= Duration::from_secs(3) && delay >= Duration::from_secs(1));
    assert_eq!(
        retry_delay(0, Some("60")).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    assert!(retry_delay(1, Some("invalid")).unwrap() >= Duration::from_millis(1000));
}

fn bounded_child(mut child: std::process::Child) -> std::process::ExitStatus {
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= end {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned provider child exceeded deadline");
        }
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn provider_keep_alive_credential_child() {
    let Ok(url) = std::env::var("TSUMUGI_PROVIDER_URL") else {
        return;
    };
    let (_temp, mut store, rows) = source_project();
    let service = Arc::new(ProviderService::default());
    let mut rt = ExecutionRuntime::new(&store).unwrap();
    rt.register_with_policy(
        Arc::new(AiRunner::with_service(service.clone())),
        RecoveryPolicy::ExternalUnknown,
    )
    .unwrap();
    for name in ["TSUMUGI_FIRST_KEY", "TSUMUGI_SECOND_KEY"] {
        let mut c = config(url.clone());
        c.credential_env = name.into();
        let input = store
            .preview_ai(c, "zh-CN", &[rows[0].unit_id.unwrap()])
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        rt.submit(&mut store, &input).unwrap();
        drain(&mut rt, &mut store, input.envelope().attempt_id);
        assert_eq!(
            store
                .execution_attempt(input.envelope().attempt_id, false)
                .unwrap()
                .progress
                .succeeded,
            1
        );
    }
    assert_eq!(service.client_count(), 1);
}
#[test]
fn provider_reuses_actual_connection_and_attaches_credentials_per_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let wire = thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(10);
        let mut stream = loop {
            if let Ok((stream, _)) = listener.accept() {
                break stream;
            }
            assert!(Instant::now() < end);
            thread::sleep(Duration::from_millis(5));
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        for credential in ["first-synthetic-key", "second-synthetic-key"] {
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            let header_end = loop {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains(&format!("authorization: bearer {credential}"))
            );
            let len: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < header_end + len {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
            }
            let body: Value = serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap();
            let item: Value =
                serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            let content=json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":"Synthetic"}).to_string();
            let response=json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":content}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n\r\n{}",response.len(),response).unwrap();
            stream.flush().unwrap();
        }
        assert!(listener.accept().is_err());
    });
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "ai::tests::provider_tests::provider_keep_alive_credential_child",
            "--nocapture",
        ])
        .env("TSUMUGI_PROVIDER_URL", url)
        .env("TSUMUGI_FIRST_KEY", "first-synthetic-key")
        .env("TSUMUGI_SECOND_KEY", "second-synthetic-key")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let status = bounded_child(child);
    wire.join().unwrap();
    assert!(status.success());
}
