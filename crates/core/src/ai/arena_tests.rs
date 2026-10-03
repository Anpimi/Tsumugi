use super::*;
use crate::ai::arena::{item_payload, settings, validate_output};
use crate::{ComparisonRequest, MergeBasis, SaveTranslationRevision, ai::arena::*};
use std::sync::Mutex;

struct Wire {
    url: String,
    calls: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    data: thread::JoinHandle<Vec<(String, Value)>>,
}
fn controlled(mode: &'static str) -> Wire {
    controlled_for(mode, 3)
}
fn controlled_for(mode: &'static str, seconds: u64) -> Wire {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let peak = Arc::new(AtomicUsize::new(0));
    let highest = peak.clone();
    let data = thread::spawn(move || {
        let live = Arc::new(AtomicUsize::new(0));
        let records = Arc::new(Mutex::new(Vec::new()));
        let mut workers = Vec::new();
        let end = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < end {
            let Ok((mut stream, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(2));
                continue;
            };
            let count = count.clone();
            let peak = highest.clone();
            let live = live.clone();
            let records = records.clone();
            workers.push(thread::spawn(move||{
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut bytes=Vec::new();let mut buf=[0;4096];
                let header=loop{let n=stream.read(&mut buf).unwrap();assert!(n>0);bytes.extend_from_slice(&buf[..n]);if let Some(i)=bytes.windows(4).position(|w|w==b"\r\n\r\n"){break i+4;}};
                let headers=std::str::from_utf8(&bytes[..header]).unwrap();assert!(!headers.to_lowercase().contains("authorization:"));
                let path=headers.split_whitespace().nth(1).unwrap().to_string();let len:usize=headers.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length:").map(|s|s.trim().parse().unwrap())).unwrap();
                while bytes.len()<header+len {let n=stream.read(&mut buf).unwrap();assert!(n>0);bytes.extend_from_slice(&buf[..n]);}
                let body:Value=serde_json::from_slice(&bytes[header..header+len]).unwrap();
                let item:Value=serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                let n=count.fetch_add(1,Ordering::SeqCst);peak.fetch_max(live.fetch_add(1,Ordering::SeqCst)+1,Ordering::SeqCst);records.lock().unwrap().push((path.clone(),body));
                thread::sleep(Duration::from_millis(if path=="/a" {180}else{25}));
                if mode=="disconnect" && path=="/b" {live.fetch_sub(1,Ordering::SeqCst);return;}
                let retry=mode=="retry"&&n<2;
                let status=if retry {"429 Too Many Requests"}else{"200 OK"};
                let mut value=json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":if path=="/a" {"Alpha {name}"}else{"Beta {name}"}});
                if mode=="wrong-locale"&&path=="/b" {value["targetLocale"]="ja".into();}
                let mut response=json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":value.to_string()}}]});
                if path=="/a" {response["usage"]=json!({"prompt_tokens":40,"completion_tokens":10});}
                let response=response.to_string();let _=write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{response}",response.len());live.fetch_sub(1,Ordering::SeqCst);
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        Arc::try_unwrap(records).unwrap().into_inner().unwrap()
    });
    Wire {
        url,
        calls,
        peak,
        data,
    }
}
fn cfg(url: &str) -> ArenaConfig {
    let a = AiConfig {
        endpoint: format!("{url}/a"),
        model: "alpha-model".into(),
        credential_env: String::new(),
        ..Default::default()
    };
    let b = AiConfig {
        endpoint: format!("{url}/b"),
        model: "beta-model".into(),
        token_field: "max_completion_tokens".into(),
        max_output_tokens: 800,
        credential_env: String::new(),
        ..Default::default()
    };
    ArenaConfig {
        variants: vec![a, b],
        max_items: 20,
        max_requests: 40,
        concurrency: 2,
        blind: true,
        parent_attempt_id: None,
    }
}
fn runtime(store: &ProjectStore) -> ExecutionRuntime {
    let mut r = ExecutionRuntime::new(store).unwrap();
    r.register(Arc::new(ArenaRunner::default())).unwrap();
    r
}
fn adopt(store: &mut ProjectStore, input: &FixedInput, item: ExecutionId) -> ExecutionId {
    let result = store
        .execution_current_result(input.envelope().attempt_id, item)
        .unwrap()
        .unwrap();
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|u| u.item_ids.contains(&item))
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            unit.unit_id,
            vec![result],
            Value::Null,
        )
        .unwrap();
    let receipt = store
        .adopt_execution(&action, &crate::ArenaAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &crate::ArenaAdoptionHandler)
            .unwrap(),
        receipt
    );
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}

#[test]
fn arena_wire_identity_order_partial_usage_and_saved_candidates_survive_reopen() {
    let (temp, mut store, _) = source_project();
    let rows = replace_source(
        &mut store,
        br#"{"first":"Echo {name}","second":"Echo {name}"}"#,
    );
    let wire = controlled("success");
    let units = rows.iter().map(|r| r.unit_id.unwrap()).collect::<Vec<_>>();
    let sequence = store.execution_sequence().unwrap();
    let preview = store
        .preview_arena(cfg(&wire.url), "zh-CN", &units)
        .unwrap();
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    assert_eq!(wire.calls.load(Ordering::SeqCst), 0);
    assert_eq!(preview.items.len(), 4);
    let input = preview
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let display = settings(&input).unwrap().display_order;
    for (i, item) in input.envelope().items.iter().enumerate() {
        let p = item_payload(&input, item.item_id).unwrap();
        assert_eq!(
            (p.source_order, p.slot, p.item.unit_id),
            (i / 2, i % 2, units[i / 2])
        );
    }
    let mut rt = runtime(&store);
    rt.submit(&mut store, &input).unwrap();
    rt.submit(&mut store, &input).unwrap();
    drain(&mut rt, &mut store, input.envelope().attempt_id);
    assert_eq!(
        rt.attempt(&store, input.envelope().attempt_id)
            .unwrap()
            .progress
            .succeeded,
        4
    );
    for item in &input.envelope().items {
        let result = store
            .execution_current_result(input.envelope().attempt_id, item.item_id)
            .unwrap()
            .unwrap();
        let out = validate_output(
            &input,
            &store
                .execution_result(input.envelope().attempt_id, result)
                .unwrap(),
        )
        .unwrap();
        let p = item_payload(&input, item.item_id).unwrap();
        assert_eq!(
            out.text,
            if p.slot == 0 {
                "Alpha {name}"
            } else {
                "Beta {name}"
            }
        );
        assert_eq!(out.usage.is_some(), p.slot == 0);
        assert_eq!(out.usage_incomplete, p.slot == 1);
    }
    let project = input.envelope().project_id;
    let chosen = store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: units[0],
            locale: "zh-CN".into(),
            source_revision_id: rows[0].source_revision_id.unwrap(),
            expected_selection_id: None,
            text: "Manual {name}".into(),
        })
        .unwrap();
    let refs = input.envelope().items[..2]
        .iter()
        .map(|i| adopt(&mut store, &input, i.item_id))
        .collect::<Vec<_>>();
    assert_eq!(
        store
            .translation_history(project, units[0], "zh-CN", 0, 10)
            .unwrap()
            .current,
        Some(chosen)
    );
    let request = ComparisonRequest {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: units[0],
        locale: "zh-CN".into(),
        revision_ids: refs,
        blind: true,
    };
    let view = store.create_comparison(&request).unwrap();
    assert!(!view.revealed);
    assert!(view.rows.iter().all(|r| r.model.is_none()));
    assert_eq!(
        store
            .create_comparison(&request)
            .unwrap()
            .rows
            .iter()
            .map(|r| r.revision_id)
            .collect::<Vec<_>>(),
        view.rows.iter().map(|r| r.revision_id).collect::<Vec<_>>()
    );
    let reveal = ExecutionId::new();
    store
        .reveal_arena(project, request.action_id, reveal)
        .unwrap();
    store
        .reveal_arena(project, request.action_id, reveal)
        .unwrap();
    assert!(
        store
            .read_comparison(project, request.action_id)
            .unwrap()
            .revealed
    );
    drop(rt);
    store.close().unwrap();
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(
        settings(
            &reopened
                .execution_input(input.envelope().attempt_id)
                .unwrap()
        )
        .unwrap()
        .display_order,
        display
    );
    assert!(
        reopened
            .read_comparison(project, request.action_id)
            .unwrap()
            .revealed
    );
    assert_eq!(wire.calls.load(Ordering::SeqCst), 4);
    let requests = wire.data.join().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(wire.peak.load(Ordering::SeqCst) <= 2);
    for (path, body) in requests {
        assert_eq!(body["stream"], false);
        assert_eq!(body.as_object().unwrap().len(), 4);
        let p: Value =
            serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(p["sourceText"], "Echo {name}");
        assert_eq!(p["terms"], json!([]));
        assert!(p["context"].is_null());
        assert!(p.get("revisionId").is_none());
        assert_eq!(
            body["model"],
            if path == "/a" {
                "alpha-model"
            } else {
                "beta-model"
            }
        );
        assert_eq!(
            body[if path == "/a" {
                "max_tokens"
            } else {
                "max_completion_tokens"
            }],
            if path == "/a" { 2000 } else { 800 }
        );
    }
}

#[test]
fn arena_retry_uses_one_budget_and_invalid_unknown_outputs_never_become_candidates() {
    for mode in ["retry", "wrong-locale", "disconnect"] {
        let (_temp, mut store, rows) = source_project();
        let wire = controlled(mode);
        let mut config = cfg(&wire.url);
        config.max_requests = if mode == "retry" { 3 } else { 2 };
        for v in &mut config.variants {
            v.max_retries = 2;
        }
        let input = store
            .preview_arena(config, "zh-CN", &[rows[0].unit_id.unwrap()])
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut rt = runtime(&store);
        rt.submit(&mut store, &input).unwrap();
        drain(&mut rt, &mut store, input.envelope().attempt_id);
        let status = rt.attempt(&store, input.envelope().attempt_id).unwrap();
        let requests = wire.data.join().unwrap();
        assert_eq!(requests.len(), if mode == "retry" { 3 } else { 2 });
        assert!(wire.peak.load(Ordering::SeqCst) <= 2);
        if mode == "retry" {
            assert_eq!((status.progress.succeeded, status.progress.failed), (1, 1));
        } else if mode == "wrong-locale" {
            assert_eq!((status.progress.succeeded, status.progress.failed), (1, 1));
        } else {
            assert_eq!((status.progress.succeeded, status.progress.unknown), (1, 1));
        }
        for i in &status.items {
            if i.execution != ExecutionState::Succeeded {
                let result = store
                    .execution_current_result(input.envelope().attempt_id, i.item_id)
                    .unwrap()
                    .unwrap();
                let unit = input
                    .envelope()
                    .units
                    .iter()
                    .find(|u| u.item_ids.contains(&i.item_id))
                    .unwrap();
                assert!(
                    store
                        .prepare_adoption_with_id(
                            ExecutionId::new(),
                            input.envelope().attempt_id,
                            unit.unit_id,
                            vec![result],
                            Value::Null
                        )
                        .is_err()
                );
            }
        }
        assert!(
            rt.resume(
                &mut store,
                input.envelope().attempt_id,
                &[input.envelope().items[0].item_id]
            )
            .is_err()
        );
    }
}

#[test]
fn arena_boundaries_digest_cancellation_and_parent_round_are_checked() {
    let (_temp, mut store, rows) = source_project();
    let wire = controlled("success");
    let config = cfg(&wire.url);
    let units = [rows[0].unit_id.unwrap()];
    let preview = store
        .preview_arena(config.clone(), "zh-CN", &units)
        .unwrap();
    for count in [0, 1, 5] {
        let mut c = config.clone();
        c.variants = vec![c.variants[0].clone(); count];
        assert!(store.preview_arena(c, "zh-CN", &units).is_err());
    }
    for count in [3, 4] {
        let mut c = config.clone();
        c.variants = vec![c.variants[0].clone(); count];
        assert_eq!(
            store
                .preview_arena(c.clone(), "zh-CN", &units)
                .unwrap()
                .items
                .len(),
            count
        );
        c.max_items = 100;
        c.max_requests = 100;
        assert!(c.validate(100 / count).is_ok());
        assert!(c.validate(100 / count + 1).is_err());
    }
    let mut c = config.clone();
    c.max_requests = 1;
    assert!(store.preview_arena(c, "zh-CN", &units).is_err());
    assert!(
        store
            .preview_arena(config.clone(), "zh-CN", &[units[0], units[0]])
            .is_err()
    );
    assert!(store.preview_arena(config.clone(), "fr", &units).is_err());
    let mut c = config.clone();
    c.variants[1].model = "changed".into();
    assert_ne!(
        store.preview_arena(c, "zh-CN", &units).unwrap().digest,
        preview.digest
    );
    let input = preview
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut rt = runtime(&store);
    rt.submit(&mut store, &input).unwrap();
    rt.tick(&mut store).unwrap();
    let mut next = config.clone();
    next.parent_attempt_id = Some(input.envelope().attempt_id);
    assert!(store.preview_arena(next.clone(), "zh-CN", &units).is_err());
    drain(&mut rt, &mut store, input.envelope().attempt_id);
    let item = &input.envelope().items[0];
    let result = store
        .execution_current_result(input.envelope().attempt_id, item.item_id)
        .unwrap()
        .unwrap();
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|u| u.item_ids.contains(&item.item_id))
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            unit.unit_id,
            vec![result],
            Value::Null,
        )
        .unwrap();
    store
        .cancel_execution(input.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert!(
        store
            .adopt_execution(&action, &crate::ArenaAdoptionHandler)
            .is_err()
    );
    let again = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            unit.unit_id,
            vec![result],
            Value::Null,
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&again, &crate::ArenaAdoptionHandler)
            .is_err()
    );
    assert!(store.preview_arena(next, "zh-CN", &units).is_ok());
    assert_eq!(wire.data.join().unwrap().len(), 2);
}

#[test]
fn arena_merge_commit_uncertainty_reconciles_before_same_action_retry() {
    let (temp, mut store, rows) = source_project();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let source = rows[0].source_revision_id.unwrap();
    let mut refs = Vec::new();
    let mut selection = None;
    for text in ["First {name}", "Second {name}"] {
        let saved = store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: source,
                expected_selection_id: selection,
                text: text.into(),
            })
            .unwrap();
        refs.push(saved.revision_id);
        selection = Some(saved.event_id);
    }
    let view = store
        .preview_comparison(project, unit, "zh-CN", &refs)
        .unwrap();
    let request = SaveTranslationRevision {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        source_revision_id: source,
        expected_selection_id: selection,
        text: "Merged {name}".into(),
    };
    let basis = MergeBasis {
        contributors: refs,
        expected_basis: view.basis,
    };
    let reader = rusqlite::Connection::open_with_flags(
        temp.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    reader
        .execute_batch("BEGIN; SELECT COUNT(*) FROM translation_revisions;")
        .unwrap();
    assert_eq!(
        store
            .save_merged_translation(&request, &basis)
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    assert!(store.is_reconciling());
    reader.execute_batch("ROLLBACK").unwrap();
    assert!(
        store
            .translation_selection_by_action(project, unit, "zh-CN", request.action_id)
            .unwrap()
            .is_none()
    );
    assert!(!store.is_reconciling());
    let saved = store.save_merged_translation(&request, &basis).unwrap();
    assert_eq!(
        store.save_merged_translation(&request, &basis).unwrap(),
        saved
    );
    assert_eq!(
        store
            .translation_history(project, unit, "zh-CN", 0, 10)
            .unwrap()
            .total,
        3
    );
}

#[test]
fn arena_manual_merge_has_atomic_ancestry_conflicts_idempotency_and_schema_ten_backup() {
    let (temp, mut store, rows) = source_project();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let source = rows[0].source_revision_id.unwrap();
    let mut refs = Vec::new();
    let mut selection = None;
    for text in ["First {name}", "Second {name}"] {
        let saved = store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: source,
                expected_selection_id: selection,
                text: text.into(),
            })
            .unwrap();
        refs.push(saved.revision_id);
        selection = Some(saved.event_id);
    }
    assert!(
        store
            .preview_comparison(project, unit, "ja", &refs)
            .is_err()
    );
    assert!(
        store
            .preview_comparison(ExecutionId::new(), unit, "zh-CN", &refs)
            .is_err()
    );
    assert!(
        store
            .preview_comparison(project, rows[1].unit_id.unwrap(), "zh-CN", &refs)
            .is_err()
    );
    let view = store
        .create_comparison(&ComparisonRequest {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            revision_ids: refs.clone(),
            blind: false,
        })
        .unwrap();
    let request = SaveTranslationRevision {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        source_revision_id: source,
        expected_selection_id: selection,
        text: "Merged {name}".into(),
    };
    let basis = MergeBasis {
        contributors: refs.clone(),
        expected_basis: view.basis.clone(),
    };
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "ja".into(),
            source_revision_id: source,
            expected_selection_id: None,
            text: "Other language".into(),
        })
        .unwrap();
    let merged = store.save_merged_translation(&request, &basis).unwrap();
    assert_eq!(
        store.save_merged_translation(&request, &basis).unwrap(),
        merged
    );
    let history = store
        .translation_history(project, unit, "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(history.total, 3);
    let merged_row = history
        .rows
        .iter()
        .find(|r| r.revision_id == merged.revision_id)
        .unwrap();
    assert_eq!(merged_row.origin_kind, crate::TranslationOrigin::Manual);
    assert_eq!(merged_row.contributors, refs);
    assert_eq!(history.current, Some(merged.clone()));
    let mut stale = request.clone();
    stale.action_id = ExecutionId::new();
    assert!(store.save_merged_translation(&stale, &basis).is_err());
    assert_eq!(
        store
            .translation_history(project, unit, "zh-CN", 0, 10)
            .unwrap()
            .total,
        3
    );
    let fresh = store
        .read_comparison(project, view.comparison_id.unwrap())
        .unwrap();
    assert_eq!(fresh.selected_revision_id, Some(merged.revision_id));
    assert_eq!(fresh.selected_text.as_deref(), Some("Merged {name}"));
    assert!(
        fresh
            .rows
            .iter()
            .all(|row| row.revision_id != merged.revision_id)
    );
    assert_eq!(
        serde_json::to_value(&fresh).unwrap()["selectedText"],
        "Merged {name}"
    );
    let fresh_basis = MergeBasis {
        contributors: refs,
        expected_basis: fresh.basis.clone(),
    };
    stale.expected_selection_id = Some(merged.event_id);
    store
        .save_context(&crate::SaveContext {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: source,
            reason: "Synthetic change".into(),
            expected_revision_id: None,
            text: "New context".into(),
        })
        .unwrap();
    assert!(store.save_merged_translation(&stale, &fresh_basis).is_err());
    let path = temp.path().join("project");
    store.close().unwrap();
    let conn = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM translation_contributors", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        2
    );
    // Remove only the additive relations to obtain an authentic schema-10 shape.
    conn.execute_batch("DROP TABLE translation_contributors; DROP TABLE arena_reveals; DROP TABLE arena_entries; DROP TABLE arena_comparisons;").unwrap();
    conn.pragma_update(None, "user_version", 10).unwrap();
    drop(conn);
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .translation_history(project, unit, "zh-CN", 0, 10)
            .unwrap()
            .current,
        Some(merged)
    );
    reopened.close().unwrap();
    let backup = std::fs::read_dir(&path)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("project.sqlite3.pre-v10-")
        })
        .unwrap();
    let backup =
        rusqlite::Connection::open_with_flags(backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
    assert_eq!(
        backup
            .query_row("SELECT COUNT(*) FROM translation_revisions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        4
    );
}

#[test]
fn arena_history_summary_retains_removed_units_without_blocking_current_comparisons() {
    let (_temp, mut store, rows) = source_project();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let mut selection = None;
    let mut refs = Vec::new();
    for text in ["Alpha {name}", "Beta {name}"] {
        let saved = store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: rows[0].source_revision_id.unwrap(),
                expected_selection_id: selection,
                text: text.into(),
            })
            .unwrap();
        selection = Some(saved.event_id);
        refs.push(saved.revision_id);
    }
    let saved = store
        .create_comparison(&ComparisonRequest {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            revision_ids: refs,
            blind: true,
        })
        .unwrap();
    replace_source(&mut store, br#"{"second":"Goodbye","third":"Open"}"#);
    let summaries = store.list_comparisons(project).unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].comparison_id, saved.comparison_id.unwrap());
    assert_eq!(summaries[0].native_key, "first");
    assert!(
        store
            .read_comparison(project, saved.comparison_id.unwrap())
            .is_err()
    );
    assert_eq!(
        store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10
            )
            .unwrap()
            .rows
            .len(),
        2
    );
}

fn approve_and_build(store: &mut ProjectStore, unit: ExecutionId, vtt: bool) -> ExecutionId {
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .run_review_checks(project, unit, "zh-CN", &target.basis, ExecutionId::new())
        .unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .write_review(&crate::ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            expected_decision_id: target.current_decision.map(|d| d.decision_id),
            actor: "Synthetic reviewer".into(),
            kind: crate::ReviewDecisionKind::Approve,
            reason: String::new(),
        })
        .unwrap();
    let ready = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap();
    assert!(ready.ready, "{ready:?}");
    let input = store
        .prepare_locale_build(
            project,
            ExecutionId::new(),
            &[crate::BuildLocaleChoice {
                locale: "zh-CN".into(),
                file_name: if vtt { "zh-CN.vtt" } else { "i18n/zh-CN.json" }.into(),
            }],
            &ready.basis,
        )
        .unwrap();
    let mut rt = ExecutionRuntime::new(store).unwrap();
    if vtt {
        rt.register(Arc::new(WebvttBuildRunner)).unwrap();
    } else {
        rt.register(Arc::new(BuildRunner)).unwrap();
    }
    rt.submit(store, &input).unwrap();
    drain(&mut rt, store, input.envelope().attempt_id);
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
    let receipt = store
        .adopt_execution(&action, &crate::ReleaseAdoptionHandler)
        .unwrap();
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}

#[test]
fn arena_merge_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_ARENA_MERGE_PROJECT") else {
        return;
    };
    let (request, basis): (SaveTranslationRevision, MergeBasis) = serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(&path)
                .parent()
                .unwrap()
                .join("merge-request.json"),
        )
        .unwrap(),
    )
    .unwrap();
    ProjectStore::open(path)
        .unwrap()
        .save_merged_translation(&request, &basis)
        .unwrap();
    panic!("merge crash hook did not abort");
}

#[test]
fn arena_merge_process_interrupt_is_atomic_and_lost_response_reconciles_by_action() {
    for (point, committed) in [
        ("before-arena-merge-commit", false),
        ("after-arena-merge-commit", true),
    ] {
        let (temp, mut store, rows) = source_project();
        let project =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let unit = rows[0].unit_id.unwrap();
        let source = rows[0].source_revision_id.unwrap();
        let mut refs = Vec::new();
        let mut selection = None;
        for text in ["Alpha {name}", "Beta {name}"] {
            let saved = store
                .save_translation_revision(&SaveTranslationRevision {
                    project_id: project,
                    action_id: ExecutionId::new(),
                    unit_id: unit,
                    locale: "zh-CN".into(),
                    source_revision_id: source,
                    expected_selection_id: selection,
                    text: text.into(),
                })
                .unwrap();
            refs.push(saved.revision_id);
            selection = Some(saved.event_id);
        }
        let view = store
            .create_comparison(&ComparisonRequest {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                revision_ids: refs.clone(),
                blind: true,
            })
            .unwrap();
        let request = SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: source,
            expected_selection_id: selection,
            text: "Merged {name}".into(),
        };
        let basis = MergeBasis {
            contributors: refs,
            expected_basis: view.basis,
        };
        std::fs::write(
            temp.path().join("merge-request.json"),
            serde_json::to_vec(&(&request, &basis)).unwrap(),
        )
        .unwrap();
        store.close().unwrap();
        let path = temp.path().join("project");
        let hook = temp.path().join("merge-hook");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "ai::tests::arena_tests::arena_merge_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_ARENA_MERGE_PROJECT", &path)
            .env("TSUMUGI_MIGRATION_CRASH", point)
            .env("TSUMUGI_MIGRATION_HOOK", &hook)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(!status.success());
                break;
            }
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned merge helper timed out");
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(std::fs::read_to_string(hook).unwrap(), point);
        let mut store = ProjectStore::open(&path).unwrap();
        let receipt = store
            .translation_selection_by_action(project, unit, "zh-CN", request.action_id)
            .unwrap();
        assert_eq!(receipt.is_some(), committed);
        let c = rusqlite::Connection::open_with_flags(
            path.join("project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        for (table, expected) in [
            ("translation_revisions", if committed { 3 } else { 2 }),
            ("translation_selections", if committed { 3 } else { 2 }),
            ("translation_contributors", if committed { 2 } else { 0 }),
        ] {
            assert_eq!(
                c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                expected
            );
        }
        drop(c);
        let saved = store.save_merged_translation(&request, &basis).unwrap();
        if let Some(receipt) = receipt {
            assert_eq!(saved, receipt);
        }
        assert_eq!(
            store.save_merged_translation(&request, &basis).unwrap(),
            saved
        );
        let mut changed = request.clone();
        changed.text = "Different {name}".into();
        assert!(store.save_merged_translation(&changed, &basis).is_err());
        assert_eq!(
            store
                .translation_history(project, unit, "zh-CN", 0, 10)
                .unwrap()
                .total,
            3
        );
    }
}

#[test]
fn arena_both_domains_preserve_schema_ten_history_and_build_only_explicitly_reviewed_merges() {
    for vtt in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("project");
        let mut store = ProjectStore::create(
            &path,
            ProjectMetadata::create("Comparison", "en", ["zh-CN", "ja"]).unwrap(),
        )
        .unwrap();
        let bundle = if vtt {
            SourceBundle::capture_webvtt(
                b"WEBVTT\n\nfirst\n00:00.000 --> 00:01.000\nHello {name}\n",
                "en",
            )
            .unwrap()
        } else {
            SourceBundle::capture(br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
                br#"{"first":"Hello {name}"}"#, "en").unwrap()
        };
        let source = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut source_rt = ExecutionRuntime::new(&store).unwrap();
        if vtt {
            source_rt.register(Arc::new(WebvttSourceRunner)).unwrap();
        } else {
            source_rt.register(Arc::new(SourceRunner)).unwrap();
        }
        source_rt.submit(&mut store, &source).unwrap();
        drain(&mut source_rt, &mut store, source.envelope().attempt_id);
        let source_result = store
            .execution_current_result(
                source.envelope().attempt_id,
                source.envelope().items[0].item_id,
            )
            .unwrap()
            .unwrap();
        let preview = store
            .source_preview(source.envelope().attempt_id, source_result, 0, 10)
            .unwrap();
        let action = store
            .prepare_adoption_with_id(
                ExecutionId::new(),
                source.envelope().attempt_id,
                source.envelope().units[0].unit_id,
                vec![source_result],
                serde_json::to_value(preview.confirmation).unwrap(),
            )
            .unwrap();
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        drop(source_rt);
        let row = store
            .source_content(
                store.content_scope().unwrap().current_snapshot.unwrap(),
                0,
                10,
            )
            .unwrap()
            .rows
            .remove(0);
        let unit = row.unit_id.unwrap();
        let project = source.envelope().project_id;
        // Populate the old schema with a genuine single-model candidate, manual selection,
        // QA, approval and release. The two new requests use the same real HTTP transport.
        let wire = controlled_for("success", 10);
        let ai = store
            .preview_ai(cfg(&wire.url).variants[0].clone(), "zh-CN", &[unit])
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut rt = ExecutionRuntime::new(&store).unwrap();
        rt.register(Arc::new(AiRunner::default())).unwrap();
        rt.submit(&mut store, &ai).unwrap();
        drain(&mut rt, &mut store, ai.envelope().attempt_id);
        let ai_result = store
            .execution_current_result(ai.envelope().attempt_id, ai.envelope().items[0].item_id)
            .unwrap()
            .unwrap();
        let action = store
            .prepare_adoption_with_id(
                ExecutionId::new(),
                ai.envelope().attempt_id,
                ai.envelope().units[0].unit_id,
                vec![ai_result],
                Value::Null,
            )
            .unwrap();
        store
            .adopt_execution(&action, &crate::AiAdoptionHandler)
            .unwrap();
        drop(rt);
        let old_selection = store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: row.source_revision_id.unwrap(),
                expected_selection_id: None,
                text: "Old {name}".into(),
            })
            .unwrap();
        let old_release = approve_and_build(&mut store, unit, vtt);
        let old_artifact = store.release_artifact(old_release, "zh-CN").unwrap();
        let old_view = store.release_view(old_release).unwrap();
        assert_eq!(
            old_artifact.1,
            if vtt {
                b"WEBVTT\n\nfirst\n00:00.000 --> 00:01.000\nOld {name}\n".to_vec()
            } else {
                b"{\n  \"first\": \"Old {name}\"\n}\n".to_vec()
            }
        );
        store.close().unwrap();
        let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        let facts = |c: &rusqlite::Connection| -> Vec<(String, i64)> {
            [
                "translation_revisions",
                "translation_selections",
                "review_checks",
                "review_decisions",
                "release_records",
                "execution_results",
                "adoption_receipts",
            ]
            .into_iter()
            .map(|table| {
                (
                    table.to_string(),
                    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                        .unwrap(),
                )
            })
            .collect()
        };
        let prior = facts(&c);
        c.execute_batch("DROP TABLE translation_contributors; DROP TABLE arena_reveals; DROP TABLE arena_entries; DROP TABLE arena_comparisons;").unwrap();
        c.pragma_update(None, "user_version", 10).unwrap();
        drop(c);
        let mut store = ProjectStore::open(&path).unwrap();
        assert_eq!(store.release_view(old_release).unwrap(), old_view);
        assert_eq!(
            store.release_artifact(old_release, "zh-CN").unwrap(),
            old_artifact
        );
        let c = rusqlite::Connection::open_with_flags(
            path.join("project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(facts(&c), prior);
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            11
        );
        drop(c);
        let backup = std::fs::read_dir(&path)
            .unwrap()
            .map(|p| p.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("project.sqlite3.pre-v10-")
            })
            .unwrap();
        let c = rusqlite::Connection::open_with_flags(
            backup,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(facts(&c), prior);
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        drop(c);
        let arena = store
            .preview_arena(cfg(&wire.url), "zh-CN", &[unit])
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut rt = runtime(&store);
        rt.submit(&mut store, &arena).unwrap();
        drain(&mut rt, &mut store, arena.envelope().attempt_id);
        let parents = arena
            .envelope()
            .items
            .iter()
            .map(|i| adopt(&mut store, &arena, i.item_id))
            .collect::<Vec<_>>();
        drop(rt);
        assert_eq!(
            store
                .translation_history(project, unit, "zh-CN", 0, 10)
                .unwrap()
                .current,
            Some(old_selection.clone())
        );
        let comparison = store
            .create_comparison(&ComparisonRequest {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                revision_ids: parents.clone(),
                blind: true,
            })
            .unwrap();
        let merge_action = ExecutionId::new();
        let merged = store
            .save_merged_translation(
                &SaveTranslationRevision {
                    project_id: project,
                    action_id: merge_action,
                    unit_id: unit,
                    locale: "zh-CN".into(),
                    source_revision_id: row.source_revision_id.unwrap(),
                    expected_selection_id: Some(old_selection.event_id),
                    text: "Merged {name}".into(),
                },
                &MergeBasis {
                    contributors: parents.clone(),
                    expected_basis: comparison.basis,
                },
            )
            .unwrap();
        assert!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_decision
                .is_none()
        );
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
        let new_release = approve_and_build(&mut store, unit, vtt);
        assert_eq!(
            store.release_artifact(new_release, "zh-CN").unwrap().1,
            if vtt {
                b"WEBVTT\n\nfirst\n00:00.000 --> 00:01.000\nMerged {name}\n".to_vec()
            } else {
                b"{\n  \"first\": \"Merged {name}\"\n}\n".to_vec()
            }
        );
        assert_eq!(store.release_view(old_release).unwrap(), old_view);
        assert_eq!(
            store.release_artifact(old_release, "zh-CN").unwrap(),
            old_artifact
        );
        // A later selection must not hide the committed merge's action receipt.
        store
            .select_translation_revision(&crate::SelectTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: row.source_revision_id.unwrap(),
                expected_selection_id: Some(merged.event_id),
                revision_id: old_selection.revision_id,
            })
            .unwrap();
        assert_eq!(
            store
                .translation_selection_by_action(project, unit, "zh-CN", merge_action)
                .unwrap(),
            Some(merged.clone())
        );
        assert!(
            store
                .translation_selection_by_action(project, unit, "ja", merge_action)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .translation_selection_by_action(ExecutionId::new(), unit, "zh-CN", merge_action)
                .is_err()
        );
        store.close().unwrap();
        let reopened = ProjectStore::open(&path).unwrap();
        let history = reopened
            .translation_history(project, unit, "zh-CN", 0, 10)
            .unwrap();
        assert_eq!(history.total, 5);
        assert_eq!(
            history
                .rows
                .iter()
                .find(|r| r.revision_id == merged.revision_id)
                .unwrap()
                .contributors,
            parents
        );
        assert_eq!(
            reopened.release_artifact(new_release, "zh-CN").unwrap().1,
            if vtt {
                b"WEBVTT\n\nfirst\n00:00.000 --> 00:01.000\nMerged {name}\n".to_vec()
            } else {
                b"{\n  \"first\": \"Merged {name}\"\n}\n".to_vec()
            }
        );
        assert_eq!(wire.calls.load(Ordering::SeqCst), 3);
        assert_eq!(wire.data.join().unwrap().len(), 3);
    }
}
