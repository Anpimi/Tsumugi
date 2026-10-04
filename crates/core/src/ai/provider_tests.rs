use super::*;
use crate::ai::provider::ProviderService;
use std::process::{Command, Stdio};

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
fn provider_schema_eleven_upgrade_retains_unknown_exposure_and_validated_backup() {
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
    drop(rt);
    drop(store);
    wire.join().unwrap();
    let path = temp.path().join("project");
    let db = path.join("project.sqlite3");
    let conn = rusqlite::Connection::open(&db).unwrap();
    crate::persistence::ledger::provider::drop_for_legacy_fixture(&conn).unwrap();
    conn.pragma_update(None, "user_version", 11).unwrap();
    drop(conn);
    let before = std::fs::read(&db).unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    let budget = reopened
        .provider_budget(input.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (budget.limit, budget.dispatched, budget.legacy_held),
        (3, 0, 3)
    );
    let backup = std::fs::read_dir(&path)
        .unwrap()
        .flatten()
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("project.sqlite3.pre-v11-")
        })
        .unwrap()
        .path();
    let old = rusqlite::Connection::open(&backup).unwrap();
    assert_eq!(
        old.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        11
    );
    assert_eq!(
        old.query_row("SELECT COUNT(*) FROM execution_results", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        2
    );
    drop(old);
    drop(reopened);
    let c = rusqlite::Connection::open(&db).unwrap();
    c.pragma_update(None, "user_version", 13).unwrap();
    drop(c);
    let future = std::fs::read(&db).unwrap();
    assert!(ProjectStore::open(&path).is_err());
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
fn provider_schema_migration_process_interrupt_is_atomic() {
    for (point, committed) in [
        ("before-provider-migration-commit", false),
        ("after-provider-migration-commit", true),
    ] {
        let (temp, store, _) = source_project();
        let path = store.directory().to_path_buf();
        drop(store);
        let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        crate::persistence::ledger::provider::drop_for_legacy_fixture(&c).unwrap();
        c.pragma_update(None, "user_version", 11).unwrap();
        drop(c);
        let hook = temp.path().join("hook");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "persistence::tests::schema_migration_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_MIGRATION_PROJECT", &path)
            .env("TSUMUGI_MIGRATION_CRASH", point)
            .env("TSUMUGI_MIGRATION_HOOK", &hook)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(!bounded_child(child).success());
        assert_eq!(std::fs::read_to_string(hook).unwrap(), point);
        let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
                .unwrap(),
            if committed { 12 } else { 11 }
        );
        drop(c);
        let opened = ProjectStore::open(&path).unwrap();
        assert!(
            !opened
                .execution_tasks(Revision::new(0).unwrap(), 50)
                .unwrap()
                .is_empty()
        );
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
