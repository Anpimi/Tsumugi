use super::*;
#[path = "arena_tests.rs"]
mod arena_tests;
use crate::{ProjectMetadata, ProjectStore, content::*};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Instant,
};
fn source_project() -> (tempfile::TempDir, ProjectStore, Vec<ContentRow>) {
    let temp = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        temp.path().join("project"),
        ProjectMetadata::create("AI tests", "en", ["zh-CN", "ja"]).unwrap(),
    )
    .unwrap();
    let rows = replace_source(
        &mut store,
        br#"{"first":"Hello {name}","second":"Goodbye","third":"Open"}"#,
    );
    (temp, store, rows)
}
fn replace_source(store: &mut ProjectStore, source: &[u8]) -> Vec<ContentRow> {
    let bundle=SourceBundle::capture(br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,source,"en").unwrap();
    let input = bundle
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    drain(&mut runtime, store, input.envelope().attempt_id);
    let result = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let page = store
        .source_preview(input.envelope().attempt_id, result, 0, 10)
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::to_value(page.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    store
        .source_content(
            store.content_scope().unwrap().current_snapshot.unwrap(),
            0,
            10,
        )
        .unwrap()
        .rows
}
fn drain(runtime: &mut ExecutionRuntime, store: &mut ProjectStore, attempt: ExecutionId) {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        runtime.tick(store).unwrap();
        let p = runtime.attempt(store, attempt).unwrap().progress;
        if p.queued == 0 && p.running == 0 {
            break;
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    }
}
fn server(mode: &'static str) -> (String, Arc<AtomicUsize>, thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            let Ok((mut stream, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            let header_end = loop {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
            assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
            if mode == "auth" {
                assert!(
                    headers
                        .to_lowercase()
                        .contains("authorization: bearer synthetic-wire-credential")
                );
            }
            let len: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
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
            assert_eq!(body["stream"], false);
            assert_eq!(body["model"], "test-model");
            assert_eq!(body["max_tokens"], 2000);
            assert_eq!(body["messages"][0]["content"], SYSTEM);
            let number = calls.fetch_add(1, Ordering::SeqCst);
            requests.push(body);
            if mode == "disconnect" {
                continue;
            }
            if mode == "timeout" {
                thread::sleep(Duration::from_millis(1300));
            }
            let (status, mut response) = if (mode == "retry" || mode == "unavailable")
                && number == 0
            {
                (
                    if mode == "retry" {
                        "429 Too Many Requests"
                    } else {
                        "503 Service Unavailable"
                    },
                    json!({"error":{"message":"must not be persisted"}}),
                )
            } else if mode == "partial" && number == 1 {
                (
                    "401 Unauthorized",
                    json!({"error":{"message":"private server diagnostic"}}),
                )
            } else {
                let content = if mode == "invalid" {
                    format!(
                        "{{\"unitId\":\"{}\",\"targetLocale\":\"zh-CN\",\"text\":\"x\",\"text\":\"y\"}}",
                        item["unitId"].as_str().unwrap()
                    )
                } else {
                    json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":"你好 {name}"}).to_string()
                };
                (
                    "200 OK",
                    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":content}}],"usage":{"prompt_tokens":40,"completion_tokens":10}}),
                )
            };
            if mode == "wrong-id" {
                let mut content: Value = serde_json::from_str(
                    response["choices"][0]["message"]["content"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                content["unitId"] = ExecutionId::new().to_string().into();
                response["choices"][0]["message"]["content"] = content.to_string().into();
            }
            if mode == "wrong-locale" {
                let mut content: Value = serde_json::from_str(
                    response["choices"][0]["message"]["content"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                content["targetLocale"] = "ja".into();
                response["choices"][0]["message"]["content"] = content.to_string().into();
            }
            if mode == "truncated" {
                response["choices"][0]["finish_reason"] = "length".into();
            }
            if mode == "tools" {
                response["choices"][0]["message"]["tool_calls"] = json!([]);
            }
            if mode == "oversized" {
                response["choices"][0]["message"]["content"] = "x".repeat(70000).into();
            }
            if mode == "no-usage" {
                response.as_object_mut().unwrap().remove("usage");
            }
            let body = if mode == "malformed" {
                "{broken".into()
            } else {
                response.to_string()
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{body}",
                body.len()
            );
        }
        requests
    });
    (
        format!("http://{address}/v1/chat/completions"),
        count,
        handle,
    )
}
fn config(url: String) -> AiConfig {
    AiConfig {
        endpoint: url,
        model: "test-model".into(),
        credential_env: String::new(),
        ..Default::default()
    }
}
#[test]
fn direct_ai_schema_nine_preserves_manual_history_and_backup() {
    let (temp, mut store, rows) = source_project();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let saved = store
        .save_translation_revision(&crate::SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: rows[0].unit_id.unwrap(),
            locale: "zh-CN".into(),
            source_revision_id: rows[0].source_revision_id.unwrap(),
            expected_selection_id: None,
            text: "Preserved manual translation".into(),
        })
        .unwrap();
    store.close().unwrap();
    let connection =
        rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    crate::persistence::restore_legacy_translation_fixture(&connection).unwrap();
    connection.pragma_update(None, "user_version", 9).unwrap();
    drop(connection);
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    let history = reopened
        .translation_history(project, rows[0].unit_id.unwrap(), "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(history.current.unwrap(), saved);
    assert_eq!(
        history.current_text.unwrap(),
        "Preserved manual translation"
    );
    reopened.close().unwrap();
    let backup = std::fs::read_dir(temp.path().join("project"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("project.sqlite3.pre-v9-")
        })
        .unwrap();
    let connection =
        rusqlite::Connection::open_with_flags(backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        connection
            .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
#[test]
fn direct_ai_wire_partial_budget_candidates_and_reopen() {
    let (temp, mut store, rows) = source_project();
    let (url, calls, wire) = server("partial");
    let mut config = config(url);
    config.max_requests = 2;
    let units = rows.iter().map(|r| r.unit_id.unwrap()).collect::<Vec<_>>();
    let preview = store.preview_ai(config, "zh-CN", &units).unwrap();
    assert!(
        preview
            .items
            .iter()
            .all(|i| i.terms.is_empty() && i.context.is_none())
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let input = preview
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(AiRunner::default())).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    let view = runtime
        .attempt(&store, input.envelope().attempt_id)
        .unwrap();
    assert_eq!((view.progress.succeeded, view.progress.failed), (1, 2));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let success = view
        .items
        .iter()
        .find(|i| i.execution == ExecutionState::Succeeded)
        .unwrap();
    let result = store
        .execution_current_result(view.attempt_id, success.item_id)
        .unwrap()
        .unwrap();
    let output = super::validate_output(
        &input,
        &store.execution_result(view.attempt_id, result).unwrap(),
    )
    .unwrap();
    assert_eq!(output.usage.unwrap().prompt_tokens, 40);
    assert_eq!(output.text, "你好 {name}");
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|u| u.item_ids.contains(&success.item_id))
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            view.attempt_id,
            unit.unit_id,
            vec![result],
            Value::Null,
        )
        .unwrap();
    let first = store
        .adopt_execution(&action, &crate::AiAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &crate::AiAdoptionHandler)
            .unwrap(),
        first
    );
    let project = input.envelope().project_id;
    let target = item_payload(&input, success.item_id).unwrap();
    let history = store
        .translation_history(project, target.unit_id, "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(history.total, 1);
    assert!(history.current.is_none());
    assert_eq!(history.rows[0].origin_kind, "ai");
    assert!(
        runtime
            .resume(&mut store, view.attempt_id, &[success.item_id])
            .is_err()
    );
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .translation_history(project, target.unit_id, "zh-CN", 0, 10)
            .unwrap()
            .total,
        1
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    reopened.close().unwrap();
    let requests = wire.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        !input
            .bytes()
            .windows(25)
            .any(|w| w == b"private server diagnostic")
    );
}
#[test]
fn direct_ai_retry_invalid_and_unknown_are_bounded() {
    for mode in [
        "retry",
        "unavailable",
        "invalid",
        "disconnect",
        "timeout",
        "wrong-id",
        "wrong-locale",
        "truncated",
        "tools",
        "oversized",
        "malformed",
        "no-usage",
    ] {
        let (_temp, mut store, rows) = source_project();
        let (url, calls, wire) = server(mode);
        let mut config = config(url);
        config.max_retries = 1;
        if mode == "timeout" {
            config.timeout_seconds = 1;
        }
        let input = store
            .preview_ai(config, "zh-CN", &[rows[0].unit_id.unwrap()])
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(Arc::new(AiRunner::default())).unwrap();
        runtime.submit(&mut store, &input).unwrap();
        drain(&mut runtime, &mut store, input.envelope().attempt_id);
        let view = runtime
            .attempt(&store, input.envelope().attempt_id)
            .unwrap();
        if mode == "retry" || mode == "unavailable" || mode == "no-usage" {
            assert_eq!(view.progress.succeeded, 1);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                if mode == "no-usage" { 1 } else { 2 }
            );
            let result = store
                .execution_current_result(view.attempt_id, view.items[0].item_id)
                .unwrap()
                .unwrap();
            let output = super::validate_output(
                &input,
                &store.execution_result(view.attempt_id, result).unwrap(),
            )
            .unwrap();
            assert!(output.usage_incomplete);
            if mode == "no-usage" {
                assert!(output.usage.is_none());
            }
        } else {
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                view.items[0].execution,
                if mode == "disconnect" || mode == "timeout" {
                    ExecutionState::Unknown
                } else {
                    ExecutionState::Failed
                }
            );
        }
        wire.join().unwrap();
    }
}
#[test]
fn direct_ai_rejects_bad_configuration_and_preserves_manual_selection() {
    let (_temp, mut store, rows) = source_project();
    let (url, _, wire) = server("success");
    let good = config(url);
    for endpoint in [
        "http://example.com/v1/chat/completions",
        "https://user:secret@example.com/v1/chat/completions",
        "https://example.com/v1/chat/completions?key=x",
    ] {
        let mut bad = good.clone();
        bad.endpoint = endpoint.into();
        assert!(bad.validate().is_err());
    }
    let preview = store
        .preview_ai(good, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap();
    let input = preview
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let selected = store
        .save_translation_revision(&crate::SaveTranslationRevision {
            project_id: input.envelope().project_id,
            action_id: ExecutionId::new(),
            unit_id: rows[0].unit_id.unwrap(),
            locale: "zh-CN".into(),
            source_revision_id: rows[0].source_revision_id.unwrap(),
            expected_selection_id: None,
            text: "Human work".into(),
        })
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(AiRunner::default())).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    let result = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            Value::Null,
        )
        .unwrap();
    store
        .adopt_execution(&action, &crate::AiAdoptionHandler)
        .unwrap();
    let history = store
        .translation_history(
            input.envelope().project_id,
            rows[0].unit_id.unwrap(),
            "zh-CN",
            0,
            10,
        )
        .unwrap();
    assert_eq!(history.current.unwrap(), selected);
    assert_eq!(history.current_text.unwrap(), "Human work");
    assert_eq!(history.total, 2);
    wire.join().unwrap();
}

#[test]
fn direct_ai_candidate_checks_source_locale_and_cancellation_at_commit() {
    for conflict in ["source", "locale", "cancel"] {
        let (_temp, mut store, rows) = source_project();
        let (url, _, wire) = server("success");
        let input = store
            .preview_ai(config(url), "zh-CN", &[rows[0].unit_id.unwrap()])
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(Arc::new(AiRunner::default())).unwrap();
        runtime.submit(&mut store, &input).unwrap();
        drain(&mut runtime, &mut store, input.envelope().attempt_id);
        let result = store
            .execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap()
            .unwrap();
        let action = store
            .prepare_adoption_with_id(
                ExecutionId::new(),
                input.envelope().attempt_id,
                input.envelope().units[0].unit_id,
                vec![result],
                Value::Null,
            )
            .unwrap();
        match conflict {
            "source" => {
                replace_source(&mut store,br#"{"first":"Changed first","second":"Changed second","third":"Changed third"}"#);
            }
            "locale" => {
                store
                    .set_target_locales(
                        store.metadata().unwrap().metadata_revision(),
                        &["ja".into()],
                    )
                    .unwrap();
            }
            _ => {
                store
                    .cancel_execution(input.envelope().task_id, ExecutionId::new())
                    .unwrap();
            }
        }
        assert!(
            store
                .adopt_execution(&action, &crate::AiAdoptionHandler)
                .is_err(),
            "{conflict}"
        );
        assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
        wire.join().unwrap();
    }
}

#[test]
fn direct_ai_missing_credential_dispatches_no_http() {
    let (_temp, mut store, rows) = source_project();
    let (url, count, wire) = server("success");
    let mut cfg = config(url);
    cfg.credential_env = "TSUMUGI_NONEXISTENT_AI_ACCEPTANCE_CREDENTIAL".into();
    assert!(std::env::var(&cfg.credential_env).is_err());
    let input = store
        .preview_ai(cfg, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(AiRunner::default())).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    let view = runtime
        .attempt(&store, input.envelope().attempt_id)
        .unwrap();
    assert_eq!(view.progress.failed, 1);
    assert_eq!(view.items[0].diagnostic.as_deref(), Some("ai-credential"));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(wire.join().unwrap().is_empty());
}

#[test]
fn direct_ai_concurrency_and_total_request_budget_are_shared() {
    let (_temp, mut store, rows) = source_project();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let total = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let counts = (total.clone(), peak.clone(), active.clone());
    let server = thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(4);
        let mut workers = vec![];
        while Instant::now() < end {
            if let Ok((mut stream, _)) = listener.accept() {
                stream.set_nonblocking(false).unwrap();
                let (total, peak, active) = counts.clone();
                workers.push(thread::spawn(move || {total.fetch_add(1,Ordering::SeqCst);let now=active.fetch_add(1,Ordering::SeqCst)+1;peak.fetch_max(now,Ordering::SeqCst);let mut buf=[0;8192];stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let _=stream.read(&mut buf);thread::sleep(Duration::from_millis(500));let _=write!(stream,"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");active.fetch_sub(1,Ordering::SeqCst);}));
            } else {
                thread::sleep(Duration::from_millis(5));
            }
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });
    let mut cfg = config(format!("http://{address}/v1/chat/completions"));
    cfg.concurrency = 2;
    cfg.max_requests = 2;
    let input = store
        .preview_ai(
            cfg,
            "zh-CN",
            &rows.iter().map(|r| r.unit_id.unwrap()).collect::<Vec<_>>(),
        )
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(AiRunner::default())).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    server.join().unwrap();
    assert_eq!(total.load(Ordering::SeqCst), 2);
    assert_eq!(peak.load(Ordering::SeqCst), 2);
    assert_eq!(
        runtime
            .attempt(&store, input.envelope().attempt_id)
            .unwrap()
            .progress
            .failed,
        3
    );
}

#[test]
fn direct_ai_preview_shares_only_opted_in_resolved_resources_without_writes() {
    let (temp, mut store, rows) = source_project();
    let row = rows.iter().find(|r| r.occurrence.key == "first").unwrap();
    let unit = row.unit_id.unwrap();
    let source = row.source_revision_id.unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let term = store
        .save_term(&crate::SaveTerm {
            project_id: project,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "Hello".into(),
            aliases: vec![],
            target: "你好".into(),
            protected: false,
            scope_unit_id: None,
            expected_revision_id: None,
            reason: "Synthetic accepted term".into(),
        })
        .unwrap();
    store
        .save_context(&crate::SaveContext {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: source,
            expected_revision_id: None,
            text: "A greeting shown to a player".into(),
            reason: "Synthetic context".into(),
        })
        .unwrap();
    let database = rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    let before = database
        .query_row("SELECT COUNT(*) FROM execution_attempts", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    let cfg = config("http://127.0.0.1:65534/v1/chat/completions".into());
    let preview = store.preview_ai(cfg.clone(), "zh-CN", &[unit]).unwrap();
    assert!(preview.items[0].terms.is_empty());
    assert!(preview.items[0].context.is_none());
    let mut shared = cfg;
    shared.share_terms = true;
    shared.share_context = true;
    let preview = store.preview_ai(shared, "zh-CN", &[unit]).unwrap();
    assert_eq!(preview.items[0].terms[0].revision_id, term.revision_id);
    assert_eq!(
        preview.items[0].context.as_ref().unwrap().text,
        "A greeting shown to a player"
    );
    let body = request_body(&preview.config, &preview.items[0]).unwrap();
    let wire: Value =
        serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        wire["terms"][0],
        json!({"source":"Hello","target":"你好","protected":false})
    );
    assert_eq!(wire["context"], "A greeting shown to a player");
    assert!(wire.get("resourceBaseline").is_none());
    assert!(wire.get("sourceRevisionId").is_none());
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM execution_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    store
        .save_term(&crate::SaveTerm {
            project_id: project,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "Hello".into(),
            aliases: vec![],
            target: "您好".into(),
            protected: false,
            scope_unit_id: None,
            expected_revision_id: None,
            reason: "Conflicting accepted term".into(),
        })
        .unwrap();
    let conflicted = store.preview_ai(preview.config, "zh-CN", &[unit]).unwrap();
    assert!(conflicted.items[0].terms.is_empty());
    assert!(
        conflicted.items[0]
            .omissions
            .iter()
            .any(|o| o == "term-conflict:Hello")
    );
}

#[test]
fn direct_ai_auth_header_is_sent_without_persisting_credential_value() {
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "ai::tests::direct_ai_auth_child", "--nocapture"])
        .env("TSUMUGI_AI_WIRE_CREDENTIAL", "synthetic-wire-credential")
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn direct_ai_auth_child() {
    if std::env::var("TSUMUGI_AI_WIRE_CREDENTIAL").as_deref() != Ok("synthetic-wire-credential") {
        return;
    }
    let (_temp, mut store, rows) = source_project();
    let (url, count, wire) = server("auth");
    let mut cfg = config(url);
    cfg.credential_env = "TSUMUGI_AI_WIRE_CREDENTIAL".into();
    let input = store
        .preview_ai(cfg, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(AiRunner::default())).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    let result = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let result = store
        .execution_result(input.envelope().attempt_id, result)
        .unwrap();
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    assert!(!String::from_utf8_lossy(input.bytes()).contains("synthetic-wire-credential"));
    assert!(!String::from_utf8_lossy(result.bytes()).contains("synthetic-wire-credential"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    wire.join().unwrap();
}
