#![cfg(not(feature = "execution-test-host"))]
//! Synthetic project facts and the real execution/resource owners; no network.
mod support;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tsumugi_core::{application::*, execution::*, *};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn project(s: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&s.metadata().unwrap().project_id().to_string()).unwrap()
}
fn tool() -> McpTermTool {
    McpTermTool {
        discovery_id: ExecutionId::new(),
        discovery_generation: 1u64.into(),
        discovery_expires_at_ms: now() + 120_000,
        endpoint: "https://terms.example/mcp".into(),
        credential_env: Some("TSUMUGI_MCP_TEST_TOKEN".into()),
        server_name: "Synthetic terminology service".into(),
        server_version: "1".into(),
        protocol_version: "2025-11-25".into(),
        tool_name: "terms".into(),
        description: Some("Untrusted service description".into()),
        profile_version: MCP_TERM_QUERY_PROFILE.into(),
        input_schema: mcp_term_query_input_schema(),
        output_schema: mcp_term_query_output_schema(),
    }
}
fn request(s: &ProjectStore, row: &content::ContentRow) -> McpTermQueryRequest {
    McpTermQueryRequest {
        project_id: project(s),
        action_id: ExecutionId::new(),
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        unit_id: row.unit_id.unwrap(),
        locale: "zh-CN".into(),
        query: row.occurrence.text.clone(),
        expires_at_ms: now() + 60_000,
        tool: tool(),
    }
}
fn consent(p: &PreparedMcpTermQuery) -> McpTermQueryConsent {
    McpTermQueryConsent {
        action_id: p.preview().request.action_id,
        input_digest: p.input().digest().into(),
        expires_at_ms: p.preview().request.expires_at_ms,
        share_query: true,
    }
}
struct SyntheticMcp(Arc<AtomicUsize>);
impl Runner for SyntheticMcp {
    fn capability_id(&self) -> &str {
        MCP_TERM_QUERY_CAPABILITY
    }
    fn capability_version(&self) -> &str {
        MCP_TERM_QUERY_PROFILE
    }
    fn run(
        &self,
        r: DispatchRequest,
        _: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let query = r.input.item(r.item_id)?.payload["query"].as_str().unwrap();
        let result = FixedResult::capture(
            ResultEnvelope {
                project_id: r.input.envelope().project_id,
                attempt_id: r.input.envelope().attempt_id,
                item_id: r.item_id,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: r.dispatch_token,
                capability_id: MCP_TERM_QUERY_CAPABILITY.into(),
                capability_version: MCP_TERM_QUERY_PROFILE.into(),
                plugin: None,
                outcome: ExecutionState::Succeeded,
                output: Some(
                    serde_json::json!({"entries":[{"id":"term","source":query,"target":"e\u{301} 👩🏽‍💻","reason":"Synthetic exact result"}]}),
                ),
                diagnostic: None,
            },
            &r.input,
            r.dispatch_token,
        )?;
        validate_mcp_term_query_result(&r.input, &result)?;
        sender.send(result)
    }
}
fn runtime(s: &ProjectStore) -> (ExecutionRuntime, Arc<AtomicUsize>) {
    let mut r = ExecutionRuntime::new(s).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    r.register(Arc::new(SyntheticMcp(calls.clone()))).unwrap();
    (r, calls)
}
fn complete(
    s: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    p: &PreparedMcpTermQuery,
) -> (McpTermQueryPermit, FixedResult) {
    let permit = s.authorize_mcp_term_query(p, &consent(p)).unwrap();
    runtime.submit_mcp_term_query(s, p, &permit).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(s).unwrap();
        if let Some(id) = s
            .execution_current_result(
                p.input().envelope().attempt_id,
                p.input().envelope().items[0].item_id,
            )
            .unwrap()
        {
            if !runtime.has_owned_attempt_work(p.input().envelope().attempt_id) {
                return (
                    permit,
                    s.execution_result(p.input().envelope().attempt_id, id)
                        .unwrap(),
                );
            }
        }
        assert!(Instant::now() < until, "synthetic MCP result deadline");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn capture(
    s: &mut ProjectStore,
    p: &PreparedMcpTermQuery,
    result: &FixedResult,
) -> McpTermCaptureReceipt {
    let a = s
        .prepare_adoption_with_id(
            ExecutionId::new(),
            p.input().envelope().attempt_id,
            p.input().envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::Value::Null,
        )
        .unwrap();
    let receipt = s.adopt_execution(&a, &McpTermQueryAdoptionHandler).unwrap();
    let captured = s
        .mcp_term_capture_receipt(project(s), a.action_id)
        .unwrap()
        .unwrap();
    assert_eq!(captured.receipt, receipt);
    captured
}
fn decision(
    s: &ProjectStore,
    c: &McpTermCaptureReceipt,
    kind: ResourceDecisionKind,
    expected: Option<ExecutionId>,
) -> ResourceDecision {
    ResourceDecision {
        project_id: project(s),
        action_id: ExecutionId::new(),
        capture_id: c.capture.capture_id,
        entry_id: "term".into(),
        expected_revision_id: expected,
        decision: kind,
    }
}

#[test]
fn raw_json_and_unconfirmed_or_changed_disclosure_cannot_enqueue() {
    let (_d, mut s, rows) = support::source_fixture();
    let p = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    assert_eq!(p.preview().arguments.query, rows[0].occurrence.text);
    assert_eq!(p.preview().arguments.source_locale, "en");
    assert_eq!(p.preview().arguments.target_locale, "zh-CN");
    assert_eq!(
        s.enqueue_execution(p.input()).unwrap_err().stage,
        "mcp-query-admission"
    );
    assert_eq!(
        s.enqueue_read_only_execution(p.input()).unwrap_err().stage,
        "mcp-query-admission"
    );
    let mut bad = consent(&p);
    bad.share_query = false;
    assert_eq!(
        s.authorize_mcp_term_query(&p, &bad).unwrap_err().stage,
        "mcp-query-consent"
    );
    bad = consent(&p);
    bad.expires_at_ms += 1;
    assert!(s.authorize_mcp_term_query(&p, &bad).is_err());
    let permit = s.authorize_mcp_term_query(&p, &consent(&p)).unwrap();
    let mut forged = p.input().envelope().clone();
    forged.items[0].payload["query"] = "another".into();
    assert!(
        permit
            .check_input(&FixedInput::capture(forged).unwrap())
            .is_err()
    );
    let mut disguised = p.input().envelope().clone();
    disguised.operation = "other".into();
    disguised.limits.timeout_ms = 60_000;
    assert_eq!(
        s.enqueue_execution(&FixedInput::capture(disguised).unwrap())
            .unwrap_err()
            .stage,
        "mcp-query-admission"
    );
    assert!(
        s.execution_attempt_ids(p.input().envelope().task_id)
            .unwrap()
            .is_empty()
    );
    assert!(
        s.list_glossary_captures(project(&s), 100)
            .unwrap()
            .is_empty()
    );
    permit.revoke();
    assert!(
        s.authorize_mcp_term_query(&p, &consent(&p)).is_err(),
        "same preparation cannot restore a revoked permit"
    );
}

#[test]
fn one_original_dispatch_captures_provenance_and_only_explicit_adoption_changes_new_ai_inputs() {
    let (_d, mut s, rows) = support::source_fixture_with_scope(2, &["zh-CN", "ja"]);
    let unit = rows[0].unit_id.unwrap();
    let cfg = ai::AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        share_terms: true,
        ..Default::default()
    };
    let old = s
        .preview_ai(cfg.clone(), "zh-CN", &[unit])
        .unwrap()
        .fixed_input(s.metadata().unwrap().project_id())
        .unwrap();
    let old_bytes = old.bytes().to_vec();
    s.enqueue_execution(&old).unwrap();
    let p = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    let (mut r, calls) = runtime(&s);
    let (permit, result) = complete(&mut s, &mut r, &p);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let c = capture(&mut s, &p, &result);
    let GlossaryCaptureOrigin::Mcp { provenance } = &c.capture.origin else {
        panic!("real MCP origin");
    };
    assert_eq!(provenance.basis, p.preview().basis);
    assert_eq!(provenance.tool, p.preview().request.tool);
    assert_eq!(provenance.result_digest, result.digest());
    assert_eq!(c.receipt.changes[0].kind, "resource-capture");
    assert!(
        s.resolve_terms(project(&s), unit, "zh-CN")
            .unwrap()
            .entries
            .is_empty()
    );
    for kind in [ResourceDecisionKind::Keep, ResourceDecisionKind::Ignore] {
        let d = decision(&s, &c, kind, None);
        s.decide_glossary_entry(&d).unwrap();
    }
    assert!(
        s.resolve_terms(project(&s), unit, "zh-CN")
            .unwrap()
            .entries
            .is_empty()
    );
    let d = decision(&s, &c, ResourceDecisionKind::Adopt, None);
    let term = s.decide_glossary_entry(&d).unwrap().revision.unwrap();
    assert_eq!(term.origin_kind, TermOrigin::External);
    assert_eq!(term.scope_unit_id, Some(unit));
    assert_eq!(term.target, "e\u{301} 👩🏽‍💻");
    assert!(
        s.resolve_terms(project(&s), rows[1].unit_id.unwrap(), "zh-CN")
            .unwrap()
            .entries
            .is_empty()
    );
    assert!(
        s.resolve_terms(project(&s), unit, "ja")
            .unwrap()
            .entries
            .is_empty()
    );
    assert_eq!(old.bytes(), old_bytes);
    assert_eq!(
        s.execution_input(old.envelope().attempt_id)
            .unwrap()
            .bytes(),
        old_bytes
    );
    let new = s.preview_ai(cfg.clone(), "zh-CN", &[unit]).unwrap();
    let body = ai::request_body(&cfg, &new.items[0]).unwrap();
    assert!(body.to_string().contains("é 👩🏽‍💻"));
    let private = ai::AiConfig {
        share_terms: false,
        ..cfg
    };
    let new = s.preview_ai(private.clone(), "zh-CN", &[unit]).unwrap();
    assert!(
        !ai::request_body(&private, &new.items[0])
            .unwrap()
            .to_string()
            .contains("é 👩🏽‍💻")
    );
    permit.revoke();
    r.submit_mcp_term_query(&mut s, &p, &permit).unwrap();
    r.tick(&mut s).unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "historical ACK never replays the call"
    );
    assert_eq!(
        s.adopt_execution(&c.action, &McpTermQueryAdoptionHandler)
            .unwrap(),
        c.receipt
    );
}

#[test]
fn repeated_batches_use_stable_terms_preserve_manual_edits_and_never_remove_omissions() {
    let (directory, mut s, rows) = support::source_fixture();
    let (mut r, _) = runtime(&s);
    let p = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    let (_, result) = complete(&mut s, &mut r, &p);
    let a = capture(&mut s, &p, &result);
    let d = decision(&s, &a, ResourceDecisionKind::Adopt, None);
    let first = s.decide_glossary_entry(&d).unwrap().revision.unwrap();
    let manual = s
        .save_term(&SaveTerm {
            project_id: project(&s),
            action_id: ExecutionId::new(),
            term_id: Some(first.term_id.clone()),
            locale: "zh-CN".into(),
            source: first.source.clone(),
            aliases: vec![],
            target: "manual B".into(),
            protected: true,
            scope_unit_id: first.scope_unit_id,
            expected_revision_id: Some(first.revision_id),
            reason: "Human correction".into(),
        })
        .unwrap();
    let p2 = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    assert_ne!(
        p2.preview().request.tool.discovery_id,
        p.preview().request.tool.discovery_id
    );
    let (_, result) = complete(&mut s, &mut r, &p2);
    let b = capture(&mut s, &p2, &result);
    let preview = s
        .glossary_preview(project(&s), b.capture.capture_id)
        .unwrap();
    assert!(preview.removed.is_empty());
    assert_eq!(
        preview.rows[0].current.as_ref().unwrap().term_id,
        first.term_id
    );
    assert_eq!(preview.rows[0].kind, ResourceChangeKind::Override);
    let stale = decision(&s, &b, ResourceDecisionKind::Adopt, Some(first.revision_id));
    assert_eq!(
        s.decide_glossary_entry(&stale).unwrap_err().stage,
        "resource-current"
    );
    let adopt = decision(
        &s,
        &b,
        ResourceDecisionKind::Adopt,
        Some(manual.revision_id),
    );
    assert_eq!(
        s.decide_glossary_entry(&adopt).unwrap_err().stage,
        "resource-override"
    );
    let override_request = decision(
        &s,
        &b,
        ResourceDecisionKind::Override,
        Some(manual.revision_id),
    );
    let updated = s
        .decide_glossary_entry(&override_request)
        .unwrap()
        .revision
        .unwrap();
    assert_eq!(updated.term_id, first.term_id);
    assert_eq!(updated.previous_revision_id, Some(manual.revision_id));
    assert_eq!(
        s.term_history(project(&s), &first.term_id, 0, 100)
            .unwrap()
            .len(),
        3
    );
    // A different result containing no proposals does not delete a saved term.
    let empty = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    let permit = s
        .authorize_mcp_term_query(&empty, &consent(&empty))
        .unwrap();
    r.submit_mcp_term_query(&mut s, &empty, &permit).unwrap();
    let dispatch = s
        .dispatch_execution_item(
            empty.input().envelope().attempt_id,
            empty.input().envelope().items[0].item_id,
        )
        .unwrap();
    let result = fixed_result(empty.input(), &dispatch, serde_json::json!({"entries":[]}));
    s.save_execution_result(&result).unwrap();
    s.validate_execution_result(
        empty.input().envelope().attempt_id,
        result.envelope().result_id,
    )
    .unwrap();
    let empty = capture(&mut s, &empty, &result);
    let view = s
        .glossary_preview(project(&s), empty.capture.capture_id)
        .unwrap();
    assert!(view.rows.is_empty() && view.removed.is_empty());
    assert_eq!(
        s.resolve_terms(project(&s), rows[0].unit_id.unwrap(), "zh-CN")
            .unwrap()
            .entries[0]
            .selected
            .as_ref()
            .unwrap()
            .revision_id,
        updated.revision_id
    );
    drop(r);
    s.close().unwrap();
    let s = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(
        s.term_history(project(&s), &first.term_id, 0, 100)
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        s.glossary_preview(project(&s), empty.capture.capture_id)
            .unwrap()
            .removed,
        vec![]
    );
}

fn fixed_result(
    input: &FixedInput,
    dispatch: &DispatchRequest,
    output: serde_json::Value,
) -> FixedResult {
    FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: dispatch.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: dispatch.dispatch_token,
            capability_id: MCP_TERM_QUERY_CAPABILITY.into(),
            capability_version: MCP_TERM_QUERY_PROFILE.into(),
            plugin: None,
            outcome: ExecutionState::Succeeded,
            output: Some(output),
            diagnostic: None,
        },
        input,
        dispatch.dispatch_token,
    )
    .unwrap()
}

#[test]
fn strict_profile_scope_and_output_limits_reject_untrusted_facts_without_adopting() {
    let (_d, mut s, rows) = support::source_fixture();
    let base = request(&s, &rows[0]);
    for endpoint in [
        "http://localhost/mcp",
        "https://user:secret@terms.example/mcp",
        "https://terms.example/mcp?token=x",
        "https://terms.example/mcp#x",
        "http://terms.example/mcp",
        "https://terms.example/mcp\n",
    ] {
        assert!(validate_mcp_term_endpoint(endpoint).is_err());
    }
    for endpoint in [
        "http://127.0.0.1:8080/mcp",
        "http://[::1]:8080/mcp",
        "https://terms.example/mcp",
    ] {
        validate_mcp_term_endpoint(endpoint).unwrap();
    }
    for bad in [
        McpTermQueryRequest {
            query: "not in source".into(),
            ..base.clone()
        },
        McpTermQueryRequest {
            locale: "fr".into(),
            ..base.clone()
        },
        McpTermQueryRequest {
            unit_id: ExecutionId::new(),
            ..base.clone()
        },
        McpTermQueryRequest {
            project_id: ExecutionId::new(),
            ..base.clone()
        },
        McpTermQueryRequest {
            query: "x".repeat(MAX_MCP_QUERY_BYTES + 1),
            ..base.clone()
        },
        McpTermQueryRequest {
            expires_at_ms: now() + MAX_MCP_QUERY_LIFETIME_MS + 10_000,
            ..base.clone()
        },
    ] {
        assert!(s.prepare_mcp_term_query(&bad).is_err());
    }
    let mut unsupported = base.clone();
    unsupported.tool.output_schema["additionalProperties"] = true.into();
    assert!(s.prepare_mcp_term_query(&unsupported).is_err());
    let p = s.prepare_mcp_term_query(&base).unwrap();
    let (mut r, _) = runtime(&s);
    let permit = s.authorize_mcp_term_query(&p, &consent(&p)).unwrap();
    r.submit_mcp_term_query(&mut s, &p, &permit).unwrap();
    let dispatched = s
        .dispatch_execution_item(
            p.input().envelope().attempt_id,
            p.input().envelope().items[0].item_id,
        )
        .unwrap();
    for output in [
        serde_json::json!({"entries":[],"uri":"https://elsewhere"}),
        serde_json::json!({"entries":[{"id":"a","source":"not the query","target":"x","reason":"x"}]}),
        serde_json::json!({"entries":[{"id":"a","source":"same","target":"x","reason":"x"},{"id":"a","source":"same","target":"y","reason":"y"}]}),
        serde_json::json!({"entries":[{"id":"a","source":"same","target":"x","reason":"x","unitId":rows[1].unit_id}]}),
        serde_json::json!({"entries":[{"id":"a","source":"same","target":"x"}]}),
        serde_json::json!({"entries":[{"id":"a\u{0}","source":"same","target":"x","reason":"x"}]}),
        serde_json::json!({"entries":[{"id":"a","source":"same","target":"x\u{0}","reason":"x"}]}),
        serde_json::json!({"entries":[{"id":"a","source":"same","target":"x","reason":"x\u{0}"}]}),
    ] {
        let result = fixed_result(p.input(), &dispatched, output);
        assert!(validate_mcp_term_query_result(p.input(), &result).is_err());
    }
    let bad = fixed_result(
        p.input(),
        &dispatched,
        serde_json::json!({"entries":[{"id":"a","source":"other","target":"x","reason":"x"}]}),
    );
    s.save_execution_result(&bad).unwrap();
    assert!(
        s.validate_execution_result(p.input().envelope().attempt_id, bad.envelope().result_id)
            .is_err()
    );
    assert_eq!(
        s.execution_attempt(p.input().envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Invalid
    );
    assert!(
        s.list_glossary_captures(project(&s), 100)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn accepted_action_is_atomic_and_unknown_reopen_only_reconciles_original_identity() {
    let (d, mut s, rows) = support::source_fixture();
    let p = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    let mut changed_request = p.preview().request.clone();
    changed_request.attempt_id = ExecutionId::new();
    changed_request.task_id = ExecutionId::new();
    let changed = s.prepare_mcp_term_query(&changed_request).unwrap();
    let (mut r, calls) = runtime(&s);
    let permit = s.authorize_mcp_term_query(&p, &consent(&p)).unwrap();
    r.submit_mcp_term_query(&mut s, &p, &permit).unwrap();
    let changed_permit = s
        .authorize_mcp_term_query(&changed, &consent(&changed))
        .unwrap();
    assert_eq!(
        r.submit_mcp_term_query(&mut s, &changed, &changed_permit)
            .unwrap_err()
            .stage,
        "mcp-query-action"
    );
    assert!(
        s.execution_attempt_ids(changed_request.task_id)
            .unwrap()
            .is_empty(),
        "failed action reuse rolls back the whole enqueue"
    );
    let dispatched = s
        .dispatch_execution_item(
            p.input().envelope().attempt_id,
            p.input().envelope().items[0].item_id,
        )
        .unwrap();
    assert_eq!(dispatched.input.bytes(), p.input().bytes());
    drop(r);
    s.close().unwrap();
    assert!(permit.check_input(p.input()).is_err());
    let mut s = ProjectStore::open(d.path().join("project")).unwrap();
    assert_eq!(
        s.reconcile_mcp_term_query(project(&s), p.input().envelope().attempt_id, &consent(&p))
            .unwrap()
            .unwrap(),
        *p.preview()
    );
    assert_eq!(
        s.reconcile_mcp_term_query_action(project(&s), &consent(&p))
            .unwrap()
            .unwrap(),
        *p.preview()
    );
    let mut bad = consent(&p);
    bad.input_digest = "0".repeat(64);
    assert!(
        s.reconcile_mcp_term_query(project(&s), p.input().envelope().attempt_id, &bad)
            .is_err()
    );
    assert!(s.authorize_mcp_term_query(&p, &consent(&p)).is_err());
    let (mut r, new_calls) = runtime(&s);
    r.submit_mcp_term_query(&mut s, &p, &permit).unwrap();
    r.tick(&mut s).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(new_calls.load(Ordering::SeqCst), 0);
    let recovery = s
        .execution_recovery(p.input().envelope().attempt_id, false)
        .unwrap();
    assert!(!recovery.units[0].actions.iter().any(|a| matches!(
        a,
        RecoveryAction::RetrySafeFailure | RecoveryAction::ResumeUndispatched
    )));
}

#[test]
fn stored_capture_rejects_rewritten_provenance_and_action_link_on_reopen() {
    for corruption in ["link", "missing-link", "provenance", "term"] {
        let (d, mut s, rows) = support::source_fixture();
        let p = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
        let (mut r, _) = runtime(&s);
        let (_, result) = complete(&mut s, &mut r, &p);
        let c = capture(&mut s, &p, &result);
        let decide = decision(&s, &c, ResourceDecisionKind::Adopt, None);
        let term = s.decide_glossary_entry(&decide).unwrap().revision.unwrap();
        drop(r);
        s.close().unwrap();
        let path = d.path().join("project");
        let db = Connection::open(path.join("project.sqlite3")).unwrap();
        match corruption {
            "link" => {
                db.execute(
                    "UPDATE mcp_query_actions SET input_digest=?1",
                    ["a".repeat(64)],
                )
                .unwrap();
            }
            "missing-link" => {
                db.execute("DELETE FROM mcp_query_actions", []).unwrap();
            }
            "provenance" => {
                let bytes: Vec<u8> = db
                    .query_row(
                        "SELECT bytes FROM resource_captures WHERE capture_id=?1",
                        [c.capture.capture_id.to_string()],
                        |r| r.get(0),
                    )
                    .unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                value["provenance"]["tool"]["endpoint"] = "https://different.example/mcp".into();
                let bytes = serde_json::to_vec(&value).unwrap();
                let digest = format!("{:x}", Sha256::digest(&bytes));
                db.execute("UPDATE resource_captures SET bytes=?2,digest=?3,request_digest=?3 WHERE capture_id=?1", params![c.capture.capture_id.to_string(),bytes,digest]).unwrap();
            }
            "term" => {
                db.execute(
                    "UPDATE term_revisions SET target='rewritten' WHERE revision_id=?1",
                    [term.revision_id.to_string()],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        drop(db);
        assert_eq!(
            ProjectStore::open(&path).unwrap_err().code(),
            PersistenceErrorCode::CorruptProject,
            "{corruption}"
        );
    }
}

fn replace_source(s: &mut ProjectStore) {
    let input = support::source_input_with_texts(s, &["new source", "other source"]);
    let mut runtime = support::source_runtime(s);
    let (_, result) = support::execute(&mut runtime, s, &input);
    let check = s
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let (_, checked) = support::execute(&mut runtime, s, check.check_input());
    s.commit_source_validation(check.prepare(checked).unwrap())
        .unwrap();
    let comparison = s
        .source_comparison(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            2,
        )
        .unwrap();
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Synthetic reviewer".into());
    assert!(confirmation.lineage.is_empty());
    for row in comparison.rows {
        let new = row.new.unwrap();
        let old = row.old.unwrap();
        assert_eq!(row.candidates.len(), 1);
        assert_eq!(row.candidates[0].occurrence_id, old.occurrence_id);
        confirmation.lineage.push(content::LineageChoice {
            new_ordinal: new.ordinal,
            old_occurrence_id: old.occurrence_id.unwrap(),
            decision: content::LineageDecision::Continue,
            reason: "Explicit original lineage".into(),
        });
    }
    let action = s
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    s.adopt_execution(&action, &content::SourceAdoptionHandler)
        .unwrap();
}

#[test]
fn source_changes_block_new_capture_and_adoption_but_keep_exact_receipts_and_history_readable() {
    let (d, mut s, rows) = support::source_fixture();
    let p = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    let (mut r, _) = runtime(&s);
    let (_, result) = complete(&mut s, &mut r, &p);
    let c = capture(&mut s, &p, &result);
    let pending = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    let (_, late_result) = complete(&mut s, &mut r, &pending);
    drop(r);
    replace_source(&mut s);
    let preview = s
        .glossary_preview(project(&s), c.capture.capture_id)
        .unwrap();
    assert!(!preview.mcp.unwrap().current);
    let adopt = decision(&s, &c, ResourceDecisionKind::Adopt, None);
    assert_eq!(
        s.decide_glossary_entry(&adopt).unwrap_err().stage,
        "mcp-query-stale"
    );
    for kind in [ResourceDecisionKind::Keep, ResourceDecisionKind::Ignore] {
        let decide = decision(&s, &c, kind, None);
        s.decide_glossary_entry(&decide).unwrap();
    }
    let late = s
        .prepare_adoption_with_id(
            ExecutionId::new(),
            pending.input().envelope().attempt_id,
            pending.input().envelope().units[0].unit_id,
            vec![late_result.envelope().result_id],
            serde_json::Value::Null,
        )
        .unwrap();
    assert_eq!(
        s.adopt_execution(&late, &McpTermQueryAdoptionHandler)
            .unwrap_err()
            .stage,
        "mcp-query-stale"
    );
    assert!(
        s.mcp_term_capture_receipt(project(&s), late.action_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        s.adopt_execution(&c.action, &McpTermQueryAdoptionHandler)
            .unwrap(),
        c.receipt
    );
    s.close().unwrap();
    let mut s = ProjectStore::open(d.path().join("project")).unwrap();
    assert_eq!(
        s.mcp_term_capture_receipt(project(&s), c.action.action_id)
            .unwrap()
            .unwrap(),
        c
    );
    assert!(
        !s.glossary_preview(project(&s), c.capture.capture_id)
            .unwrap()
            .mcp
            .unwrap()
            .current
    );
    assert_eq!(
        s.reconcile_mcp_term_query(project(&s), p.input().envelope().attempt_id, &consent(&p))
            .unwrap()
            .unwrap(),
        *p.preview()
    );
    assert!(s.authorize_mcp_term_query(&p, &consent(&p)).is_err());
    let keep = decision(&s, &c, ResourceDecisionKind::Keep, None);
    s.decide_glossary_entry(&keep).unwrap();
}

#[test]
fn query_result_entry_and_utf8_byte_budgets_are_checked_before_capture() {
    let (_d, mut s, rows) = support::source_fixture();
    let p = s.prepare_mcp_term_query(&request(&s, &rows[0])).unwrap();
    let (mut r, _) = runtime(&s);
    let permit = s.authorize_mcp_term_query(&p, &consent(&p)).unwrap();
    r.submit_mcp_term_query(&mut s, &p, &permit).unwrap();
    let dispatch = s
        .dispatch_execution_item(
            p.input().envelope().attempt_id,
            p.input().envelope().items[0].item_id,
        )
        .unwrap();
    let entries: Vec<_> = (0..101).map(|n| serde_json::json!({"id":n.to_string(),"source":"same","target":"target","reason":"reason"})).collect();
    let result = fixed_result(p.input(), &dispatch, serde_json::json!({"entries":entries}));
    assert_eq!(
        validate_mcp_term_query_result(p.input(), &result)
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let entries: Vec<_> = (0..4).map(|n| serde_json::json!({"id":n.to_string(),"source":"same","target":"🧭".repeat(4096),"reason":"reason"})).collect();
    // Each target is exactly the valid 16KiB field limit, but the aggregate is
    // larger than the 64KiB structured-content budget.
    let value = serde_json::json!({"entries":entries});
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(bytes.len() > MAX_MCP_TERM_RESULT_BYTES);
    let result = fixed_result(p.input(), &dispatch, value);
    assert_eq!(
        validate_mcp_term_query_result(p.input(), &result)
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    assert!(
        s.list_glossary_captures(project(&s), 100)
            .unwrap()
            .is_empty()
    );
}
