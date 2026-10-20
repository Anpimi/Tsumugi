#![cfg(not(feature = "execution-test-host"))]
//! Normal Core, real localhost Provider transport, and original review/adoption
//! owners. Synthetic responses test contracts, not a model's review quality.
mod support;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use tsumugi_core::{
    ProjectStore, ReviewFindingDisposition, ReviewFindingWrite, ReviewRepairStatus, SaveContext,
    SaveTranslationRevision,
    ai::{AiConfig, provider::ProviderService, semantic_review::*},
    execution::*,
};
use tsumugi_plugin_sdk as sdk;

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}
fn config(endpoint: String) -> AiConfig {
    AiConfig {
        endpoint,
        model: "synthetic-review".into(),
        credential_env: String::new(),
        max_items: 4,
        max_requests: 4,
        timeout_seconds: 2,
        ..Default::default()
    }
}
fn save(store: &mut ProjectStore, unit: ExecutionId, locale: &str, text: &str) {
    let target = store.review_target(project(store), unit, locale).unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project(store),
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: locale.into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id,
            text: text.into(),
        })
        .unwrap();
}
fn pair(unit: ExecutionId, locale: &str) -> AiSemanticReviewTarget {
    AiSemanticReviewTarget {
        unit_id: unit,
        locale: locale.into(),
    }
}
#[derive(Clone, Copy)]
enum Reply {
    Finding,
    Clear,
    Rejected,
    Unknown,
    WrongPair,
    MissingRule,
    BadRange,
    ExtraField,
}
fn server(replies: Vec<Reply>) -> (String, thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut requests = Vec::new();
        for reply in replies {
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(Instant::now() < deadline, "review wire request deadline");
                thread::sleep(Duration::from_millis(2));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let header_end = loop {
                let size = stream.read(&mut buffer).unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&buffer[..size]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
            assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|n| n.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < header_end + length {
                let size = stream.read(&mut buffer).unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&buffer[..size]);
            }
            let request: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            let content: Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            assert_eq!(request["model"], "synthetic-review");
            assert!(
                request["messages"][0]["content"]
                    .as_str()
                    .unwrap()
                    .starts_with("Review the supplied source")
            );
            assert!(content.get("translationText").is_some());
            assert!(content.get("resourceBaseline").is_none());
            assert!(content.get("credentialEnv").is_none());
            let mut output = json!({"unitId":content["unitId"],"targetLocale":content["targetLocale"],"rules":content["rules"].as_array().unwrap().iter().map(|rule|json!({"rule":rule,"findings":[]})).collect::<Vec<_>>()});
            match reply {
                Reply::Finding | Reply::BadRange => {
                    output["rules"][0]["findings"] = json!([{
                        "code":"meaning-mismatch","detail":"Synthetic semantic concern","severity":"warning",
                        "location":{"field":"translation","range":{"encoding":"utf8-byte","start":0,"end":if matches!(reply,Reply::BadRange){2}else{3}}},
                        "suggestion":"Synthetic suggested wording"
                    }])
                }
                Reply::WrongPair => output["unitId"] = ExecutionId::new().to_string().into(),
                Reply::MissingRule => output["rules"] = json!([]),
                Reply::ExtraField => output["approval"] = true.into(),
                _ => {}
            }
            requests.push(request);
            if matches!(reply, Reply::Unknown) {
                continue;
            }
            let (status, response) = if matches!(reply, Reply::Rejected) {
                (
                    "401 Unauthorized",
                    json!({"error":{"message":"private remote diagnostic"}}),
                )
            } else {
                (
                    "200 OK",
                    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":output.to_string()}}],"usage":{"prompt_tokens":10,"completion_tokens":4}}),
                )
            };
            let body = response.to_string();
            write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    });
    (format!("http://{address}/v1/chat/completions"), handle)
}
fn new_runtime(store: &ProjectStore) -> ExecutionRuntime {
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime
        .register_with_policy(
            Arc::new(AiSemanticReviewRunner::with_service(Arc::new(
                ProviderService::default(),
            ))),
            RecoveryPolicy::ExternalUnknown,
        )
        .unwrap();
    runtime
}
fn drain(runtime: &mut ExecutionRuntime, store: &mut ProjectStore, attempt: ExecutionId) {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(attempt) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "semantic review completion deadline"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
fn action(store: &mut ProjectStore, input: &FixedInput, item: ExecutionId) -> AdoptionAction {
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|unit| unit.item_ids == [item])
        .unwrap()
        .unit_id;
    let result = store
        .execution_current_result(input.envelope().attempt_id, item)
        .unwrap()
        .unwrap();
    store
        .prepare_adoption(input.envelope().attempt_id, unit, vec![result], Value::Null)
        .unwrap()
}
fn record(store: &mut ProjectStore, input: &FixedInput, item: ExecutionId) -> AiSemanticReviewRun {
    let request = action(store, input, item);
    let receipt = store
        .adopt_execution(&request, &AiSemanticReviewAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&request, &AiSemanticReviewAdoptionHandler)
            .unwrap(),
        receipt
    );
    store
        .read_ai_semantic_review_item(input.envelope().attempt_id, item)
        .unwrap()
        .run
        .unwrap()
}
fn execute(
    store: &mut ProjectStore,
    prepared: &PreparedAiSemanticReview,
) -> (FixedInput, AiSemanticReviewRun) {
    let input = prepared.input().clone();
    let mut runtime = new_runtime(store);
    runtime.submit(store, &input).unwrap();
    drain(&mut runtime, store, input.envelope().attempt_id);
    let item = input.envelope().items[0].item_id;
    let run = record(store, &input, item);
    (input, run)
}

#[test]
fn bounded_pair_preparation_is_pure_and_round_trips_the_exact_batch() {
    let (_directory, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN", "ja"]);
    let unit = rows[0].unit_id.unwrap();
    let other = rows[1].unit_id.unwrap();
    save(&mut store, unit, "zh-CN", "译文😀");
    save(&mut store, unit, "ja", "訳文");
    let c = config("https://example.invalid/v1/chat/completions".into());
    let targets = [pair(unit, "zh-CN"), pair(unit, "ja")];
    let before = store.changes_since(Revision::new(0).unwrap());
    let prepared = store
        .prepare_ai_semantic_review(
            c.clone(),
            &targets,
            &[AiSemanticReviewRule::Style, AiSemanticReviewRule::Meaning],
        )
        .unwrap();
    assert_eq!(
        preview_from_input(prepared.input()).unwrap(),
        *prepared.preview()
    );
    assert_eq!(prepared.input().envelope().items.len(), 2);
    let after = store.changes_since(Revision::new(0).unwrap());
    assert_eq!(
        (after.sequence, after.progress_sequence),
        (before.sequence, before.progress_sequence)
    );
    assert!(
        store
            .execution_input(prepared.input().envelope().attempt_id)
            .is_err()
    );
    store.verify_ai_semantic_review(&prepared).unwrap();
    for invalid in [
        vec![],
        vec![targets[0].clone(), targets[0].clone()],
        vec![pair(other, "zh-CN")],
        vec![pair(unit, "fr")],
    ] {
        assert!(
            store
                .prepare_ai_semantic_review(c.clone(), &invalid, &[AiSemanticReviewRule::Meaning])
                .is_err()
        );
    }
    let mut one = c.clone();
    one.max_items = 1;
    assert!(
        store
            .prepare_ai_semantic_review(one, &targets, &[AiSemanticReviewRule::Meaning])
            .is_err()
    );
    assert!(
        store
            .prepare_ai_semantic_review(c.clone(), &targets, &[])
            .is_err()
    );
    assert!(
        store
            .prepare_ai_semantic_review(
                c,
                &targets,
                &[AiSemanticReviewRule::Style, AiSemanticReviewRule::Style]
            )
            .is_err()
    );
    let mut forged = prepared.input().envelope().clone();
    forged.items[0].payload["translationText"] = "substituted input".into();
    let forged = FixedInput::capture(forged).unwrap();
    assert!(preview_from_input(&forged).is_err());
    assert!(new_runtime(&store).submit(&mut store, &forged).is_err());
    save(&mut store, unit, "ja", "新しい訳");
    assert_eq!(
        store.verify_ai_semantic_review(&prepared).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
}

#[test]
fn partial_provider_results_share_one_budget_and_record_only_explicit_successes() {
    let (directory, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN", "ja"]);
    let a = rows[0].unit_id.unwrap();
    let b = rows[1].unit_id.unwrap();
    for target in [pair(a, "zh-CN"), pair(a, "ja"), pair(b, "zh-CN")] {
        save(&mut store, target.unit_id, &target.locale, "译文😀");
    }
    let p = project(&store);
    let qa_prepared = store
        .prepare_review_check(
            p,
            a,
            "zh-CN",
            &store.review_target(p, a, "zh-CN").unwrap().basis,
            ExecutionId::new(),
            &[],
        )
        .unwrap();
    let mut qa_runtime = support::review_runtime(&store, &qa_prepared);
    let qa = support::review_check(&mut store, &mut qa_runtime, a, "zh-CN");
    let eligibility = store.review_eligibility(p, &["zh-CN".into()]).unwrap();
    let (endpoint, wire) = server(vec![Reply::Finding, Reply::Rejected, Reply::Unknown]);
    let prepared = store
        .prepare_ai_semantic_review(
            config(endpoint),
            &[pair(a, "zh-CN"), pair(a, "ja"), pair(b, "zh-CN")],
            &[AiSemanticReviewRule::Meaning],
        )
        .unwrap();
    let input = prepared.input().clone();
    let attempt = input.envelope().attempt_id;
    let mut runtime = new_runtime(&store);
    runtime.submit(&mut store, &input).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drain(&mut runtime, &mut store, attempt);
    assert_eq!(wire.join().unwrap().len(), 3);
    let view = runtime.attempt(&store, attempt).unwrap();
    assert_eq!(
        (
            view.progress.succeeded,
            view.progress.failed,
            view.progress.unknown
        ),
        (1, 1, 1)
    );
    let budget = store
        .provider_budget(input.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(budget.dispatched, 3);
    assert_eq!(budget.unresolved, 1);
    assert_eq!(budget.prompt_tokens, "10");
    let mut saved = None;
    for slot in &input.envelope().items {
        let row = store
            .read_ai_semantic_review_item(attempt, slot.item_id)
            .unwrap();
        assert!(row.run.is_none());
        if let Some(output) = row.output {
            assert_eq!(output.requests, 1);
            let recorded = record(&mut store, &input, slot.item_id);
            assert_eq!(recorded.purpose, ReviewRunPurpose::AiSemantic);
            assert_eq!(recorded.evidence.model, "synthetic-review");
            assert!(recorded.rules.iter().all(
                |rule| !rule.mandatory && rule.findings.iter().all(|finding| !finding.waivable)
            ));
            saved = Some((slot.item_id, recorded));
        } else {
            let unit = input
                .envelope()
                .units
                .iter()
                .find(|unit| unit.item_ids == [slot.item_id])
                .unwrap()
                .unit_id;
            let result = store
                .execution_current_result(attempt, slot.item_id)
                .unwrap()
                .unwrap();
            assert!(
                store
                    .prepare_adoption(attempt, unit, vec![result], Value::Null)
                    .is_err()
            );
        }
    }
    assert_eq!(
        store.review_target(p, a, "zh-CN").unwrap().current_check,
        Some(qa.clone())
    );
    assert_eq!(
        store.review_eligibility(p, &["zh-CN".into()]).unwrap(),
        eligibility
    );
    assert_eq!(
        store.review_history(p, a, "zh-CN", 0, 10).unwrap().checks,
        vec![qa]
    );
    let (item, recorded) = saved.unwrap();
    let database = directory.path().join("project/project.sqlite3");
    let sql = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT COUNT(*) FROM translation_revisions WHERE attempt_id=?1",
            [attempt.to_string()],
            |r| r.get::<_, u32>(0)
        )
        .unwrap(),
        0
    );
    drop(sql);
    drop(runtime);
    drop(qa_runtime);
    store.close().unwrap();
    let store = ProjectStore::open(directory.path().join("project")).unwrap();
    let row = store.read_ai_semantic_review_item(attempt, item).unwrap();
    assert_eq!(row.run, Some(recorded));
    assert!(row.output.is_some());
    assert_eq!(
        store
            .provider_budget(input.envelope().task_id)
            .unwrap()
            .unwrap(),
        budget
    );
    assert!(
        !new_runtime(&store).is_active(attempt),
        "history cannot restore live authority"
    );
}

#[test]
fn task_request_limit_applies_across_review_pairs() {
    let (_directory, mut store, rows) = support::source_fixture_with_scope(2, &["zh-CN"]);
    let targets = rows
        .iter()
        .map(|r| pair(r.unit_id.unwrap(), "zh-CN"))
        .collect::<Vec<_>>();
    for target in &targets {
        save(&mut store, target.unit_id, &target.locale, "译文😀");
    }
    let (endpoint, wire) = server(vec![Reply::Clear]);
    let mut c = config(endpoint);
    c.max_requests = 1;
    let prepared = store
        .prepare_ai_semantic_review(c, &targets, &[AiSemanticReviewRule::Style])
        .unwrap();
    let input = prepared.input();
    let mut runtime = new_runtime(&store);
    runtime.submit(&mut store, input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    let view = runtime
        .attempt(&store, input.envelope().attempt_id)
        .unwrap();
    assert_eq!((view.progress.succeeded, view.progress.failed), (1, 1));
    assert_eq!(wire.join().unwrap().len(), 1);
    assert_eq!(
        store
            .provider_budget(input.envelope().task_id)
            .unwrap()
            .unwrap()
            .dispatched,
        1
    );
}

#[test]
fn typed_adapter_rejects_wrong_coverage_ranges_and_unknown_fields() {
    for reply in [
        Reply::WrongPair,
        Reply::MissingRule,
        Reply::BadRange,
        Reply::ExtraField,
    ] {
        let (_directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "zh-CN", "译文😀");
        let (endpoint, wire) = server(vec![reply]);
        let prepared = store
            .prepare_ai_semantic_review(
                config(endpoint),
                &[pair(unit, "zh-CN")],
                &[AiSemanticReviewRule::Meaning],
            )
            .unwrap();
        let input = prepared.input();
        let mut runtime = new_runtime(&store);
        runtime.submit(&mut store, input).unwrap();
        drain(&mut runtime, &mut store, input.envelope().attempt_id);
        assert_eq!(wire.join().unwrap().len(), 1);
        assert_eq!(
            runtime
                .attempt(&store, input.envelope().attempt_id)
                .unwrap()
                .progress
                .failed,
            1
        );
        let item = input.envelope().items[0].item_id;
        let row = store
            .read_ai_semantic_review_item(input.envelope().attempt_id, item)
            .unwrap();
        assert!(row.output.is_none() && row.run.is_none());
        assert!(
            store
                .read_ai_semantic_review(project(&store), unit, "zh-CN")
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn cancellation_invalidates_old_action_but_fresh_confirmation_can_record_success() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "zh-CN", "译文😀");
    let (endpoint, wire) = server(vec![Reply::Finding]);
    let prepared = store
        .prepare_ai_semantic_review(
            config(endpoint),
            &[pair(unit, "zh-CN")],
            &[AiSemanticReviewRule::Meaning],
        )
        .unwrap();
    let input = prepared.input();
    let item = input.envelope().items[0].item_id;
    let mut runtime = new_runtime(&store);
    runtime.submit(&mut store, input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    wire.join().unwrap();
    let old = action(&mut store, input, item);
    runtime
        .cancel(&mut store, input.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&old, &AiSemanticReviewAdoptionHandler)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    let fresh = action(&mut store, input, item);
    assert_ne!(old.cancellation_revision, fresh.cancellation_revision);
    let receipt = store
        .adopt_execution(&fresh, &AiSemanticReviewAdoptionHandler)
        .unwrap();
    runtime
        .cancel(&mut store, input.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&fresh, &AiSemanticReviewAdoptionHandler)
            .unwrap(),
        receipt,
        "receipt-first recovery never reissues execution authority"
    );
    let row = store
        .read_ai_semantic_review_item(input.envelope().attempt_id, item)
        .unwrap();
    assert!(row.output.is_some() && row.run.is_some());
    assert_eq!(
        store
            .provider_budget(input.envelope().task_id)
            .unwrap()
            .unwrap()
            .dispatched,
        1
    );
}

#[test]
fn human_disposition_navigation_and_repair_use_original_model_evidence() {
    let (directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "zh-CN", "译文😀");
    let (endpoint, wire) = server(vec![Reply::Finding, Reply::Finding, Reply::Clear]);
    let c = config(endpoint);
    let rules = [AiSemanticReviewRule::Meaning, AiSemanticReviewRule::Style];
    let prepared = store
        .prepare_ai_semantic_review(c.clone(), &[pair(unit, "zh-CN")], &rules)
        .unwrap();
    let (_, first) = execute(&mut store, &prepared);
    let p = project(&store);
    let view = store.review_findings(p, unit, "zh-CN", 0, 10).unwrap();
    assert_eq!(view.semantic_run_id, Some(first.run_id));
    let finding = &view.findings[0];
    assert_eq!(finding.run_id, first.run_id);
    assert_eq!(finding.purpose, ReviewRunPurpose::AiSemantic);
    assert_eq!(finding.ai_origin.as_ref().unwrap(), &first.evidence);
    let original = &first.diagnostics[0];
    let location = store
        .review_diagnostic_location(p, unit, "zh-CN", first.run_id, original)
        .unwrap();
    assert_eq!(
        location.location.range,
        sdk::TextRange {
            encoding: sdk::TextEncoding::Utf16,
            start: 0,
            end: 1
        }
    );
    let mut forged = original.clone();
    forged.suggestion = Some("not the recorded diagnostic".into());
    assert!(
        store
            .review_diagnostic_location(p, unit, "zh-CN", first.run_id, &forged)
            .is_err()
    );
    let mut request = ReviewFindingWrite {
        project_id: p,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        expected_basis: first.basis.clone(),
        run_id: first.run_id,
        issue_id: finding.finding.issue_id.clone(),
        expected_decision_id: None,
        disposition: ReviewFindingDisposition::Rejected,
        actor: "Synthetic reviewer".into(),
        reason: "Human false-positive decision".into(),
    };
    let rejected = store.write_review_finding(&request).unwrap();
    assert_eq!(store.write_review_finding(&request).unwrap(), rejected);
    let repeated = store
        .prepare_ai_semantic_review(c.clone(), &[pair(unit, "zh-CN")], &rules)
        .unwrap();
    let (_, repeated) = execute(&mut store, &repeated);
    assert_ne!(repeated.run_id, first.run_id);
    let repeated_view = store.review_findings(p, unit, "zh-CN", 0, 10).unwrap();
    assert_eq!(repeated_view.findings[0].finding.issue_id, request.issue_id);
    assert_eq!(
        repeated_view.findings[0].decision.as_ref(),
        Some(&rejected),
        "same semantic evidence preserves the human disposition"
    );
    request.run_id = repeated.run_id;
    request.action_id = ExecutionId::new();
    request.expected_decision_id = Some(rejected.decision_id);
    request.disposition = ReviewFindingDisposition::Restored;
    let restored = store.write_review_finding(&request).unwrap();
    request.action_id = ExecutionId::new();
    request.expected_decision_id = Some(restored.decision_id);
    request.disposition = ReviewFindingDisposition::RepairRequested;
    let repair = store.write_review_finding(&request).unwrap();
    assert_eq!(
        store
            .review_findings(p, unit, "zh-CN", 0, 10)
            .unwrap()
            .repairs[0]
            .status,
        ReviewRepairStatus::AwaitingCurrentRecheck
    );
    // A real newer response under the exact same captured connection/rules.
    let clear = store
        .prepare_ai_semantic_review(c, &[pair(unit, "zh-CN")], &rules)
        .unwrap();
    let (_, second) = execute(&mut store, &clear);
    assert_eq!(wire.join().unwrap().len(), 3);
    let view = store.review_findings(p, unit, "zh-CN", 0, 10).unwrap();
    assert!(view.findings.is_empty());
    assert_eq!(view.repairs[0].decision, repair);
    assert_eq!(view.repairs[0].status, ReviewRepairStatus::CurrentRuleClear);
    assert_eq!(view.repairs[0].recheck_run_id, Some(second.run_id));
    assert!(
        store
            .review_diagnostic_location(p, unit, "zh-CN", first.run_id, original)
            .is_err()
    );
    let path = directory.path().join("project");
    store.close().unwrap();
    let store = ProjectStore::open(path).unwrap();
    assert_eq!(
        store
            .review_finding_action(p, rejected.request.action_id)
            .unwrap(),
        Some(rejected)
    );
}

#[test]
fn changed_selected_translation_or_shared_context_blocks_recording_without_losing_output() {
    for change_translation in [false, true] {
        let (_directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "zh-CN", "译文😀");
        let p = project(&store);
        let (endpoint, wire) = server(vec![Reply::Finding]);
        let mut c = config(endpoint);
        c.share_context = true;
        let prepared = store
            .prepare_ai_semantic_review(c, &[pair(unit, "zh-CN")], &[AiSemanticReviewRule::Meaning])
            .unwrap();
        let input = prepared.input();
        let item = input.envelope().items[0].item_id;
        let mut runtime = new_runtime(&store);
        runtime.submit(&mut store, input).unwrap();
        drain(&mut runtime, &mut store, input.envelope().attempt_id);
        wire.join().unwrap();
        let request = action(&mut store, input, item);
        if change_translation {
            save(&mut store, unit, "zh-CN", "更新訳");
        } else {
            store
                .save_context(&SaveContext {
                    project_id: p,
                    action_id: ExecutionId::new(),
                    unit_id: unit,
                    locale: "zh-CN".into(),
                    source_revision_id: rows[0].source_revision_id.unwrap(),
                    expected_revision_id: None,
                    text: "New relevant manual context".into(),
                    reason: "Synthetic correction".into(),
                })
                .unwrap();
        }
        assert_eq!(
            store
                .adopt_execution(&request, &AiSemanticReviewAdoptionHandler)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
        let row = store
            .read_ai_semantic_review_item(input.envelope().attempt_id, item)
            .unwrap();
        assert!(row.output.is_some() && row.run.is_none() && !row.current);
        assert!(
            store
                .read_ai_semantic_review(p, unit, "zh-CN")
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn retained_output_survives_source_replacement_and_reopen_without_becoming_current() {
    let (directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "zh-CN", "译文😀");
    let (endpoint, wire) = server(vec![Reply::Finding]);
    let prepared = store
        .prepare_ai_semantic_review(
            config(endpoint),
            &[pair(unit, "zh-CN")],
            &[AiSemanticReviewRule::Meaning],
        )
        .unwrap();
    let (input, run) = execute(&mut store, &prepared);
    wire.join().unwrap();
    let original = run.diagnostics[0].clone();
    let p = project(&store);
    let mut source_runtime = support::source_runtime(&store);
    let source = support::source_input_with_texts(&store, &["changed source", "same"]);
    let (_, result) = support::execute(&mut source_runtime, &mut store, &source);
    let capture = store
        .capture_source_validation(source.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let (_, proof) = support::execute(&mut source_runtime, &mut store, capture.check_input());
    store
        .commit_source_validation(capture.prepare(proof).unwrap())
        .unwrap();
    let comparison = store
        .source_comparison(
            source.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap();
    let action = store
        .prepare_adoption(
            source.envelope().attempt_id,
            source.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(comparison.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler)
        .unwrap();
    assert!(
        store
            .review_diagnostic_location(p, unit, "zh-CN", run.run_id, &original)
            .is_err()
    );
    let item = input.envelope().items[0].item_id;
    let historical = store
        .read_ai_semantic_review_item(input.envelope().attempt_id, item)
        .unwrap();
    assert!(!historical.current && historical.output.is_some());
    assert_eq!(historical.run, Some(run));
    let path = directory.path().join("project");
    drop(source_runtime);
    store.close().unwrap();
    let store = ProjectStore::open(path).unwrap();
    assert_eq!(
        store
            .read_ai_semantic_review_item(input.envelope().attempt_id, item)
            .unwrap(),
        historical
    );
}

#[test]
fn reopen_refuses_forged_model_provenance_purpose_or_projection_without_reset() {
    for mutation in ["origin", "purpose", "rules", "basis", "index"] {
        let (directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "zh-CN", "译文😀");
        let (endpoint, wire) = server(vec![Reply::Finding]);
        let prepared = store
            .prepare_ai_semantic_review(
                config(endpoint),
                &[pair(unit, "zh-CN")],
                &[AiSemanticReviewRule::Meaning],
            )
            .unwrap();
        let (_, run) = execute(&mut store, &prepared);
        wire.join().unwrap();
        let path = directory.path().join("project");
        store.close().unwrap();
        let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        let sql = match mutation {
            "origin" => {
                "UPDATE review_checks SET evidence_json=json_set(evidence_json,'$.origin.model','forged-model') WHERE run_id=?1"
            }
            "purpose" => "UPDATE review_checks SET purpose='qa',qa_basis=basis WHERE run_id=?1",
            "rules" => {
                "UPDATE review_checks SET rules_json=json_set(rules_json,'$[0].mandatory',json('true')) WHERE run_id=?1"
            }
            "basis" => "UPDATE review_checks SET basis=printf('%064d',0) WHERE run_id=?1",
            _ => "DROP INDEX review_semantic_result",
        };
        if mutation == "index" {
            c.execute_batch(sql).unwrap();
        } else {
            c.execute(sql, [run.run_id.to_string()]).unwrap();
        }
        drop(c);
        assert!(ProjectStore::open(&path).is_err(), "mutation {mutation}");
        let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM review_checks WHERE run_id=?1",
                [run.run_id.to_string()],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
            1,
            "refusal preserves evidence"
        );
    }
}

#[test]
fn current_review_layout_preserves_and_refuses_schema_51() {
    let (directory, store, _) = support::source_fixture();
    let path = directory.path().join("project");
    store.close().unwrap();
    let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        61
    );
    let before: u32 = c
        .query_row("SELECT COUNT(*) FROM execution_results", [], |r| r.get(0))
        .unwrap();
    c.pragma_update(None, "user_version", 51).unwrap();
    drop(c);
    let error = ProjectStore::open(&path).unwrap_err();
    assert_eq!(
        error.code(),
        tsumugi_core::PersistenceErrorCode::UnsupportedSchema
    );
    assert_eq!(error.found_schema_version(), Some(51));
    let c = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        51
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM execution_results", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        before
    );
}

#[test]
fn a_changed_connection_creates_new_semantic_evidence_without_inheriting_rejection() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "zh-CN", "译文😀");
    let (first_endpoint, first_wire) = server(vec![Reply::Finding]);
    let prepared = store
        .prepare_ai_semantic_review(
            config(first_endpoint),
            &[pair(unit, "zh-CN")],
            &[AiSemanticReviewRule::Meaning],
        )
        .unwrap();
    let (_, first) = execute(&mut store, &prepared);
    first_wire.join().unwrap();
    let p = project(&store);
    let issue = first.rules[0].findings[0].issue_id.clone();
    let request = ReviewFindingWrite {
        project_id: p,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        expected_basis: first.basis.clone(),
        run_id: first.run_id,
        issue_id: issue.clone(),
        expected_decision_id: None,
        disposition: ReviewFindingDisposition::Rejected,
        actor: "Synthetic reviewer".into(),
        reason: "False positive for this model context".into(),
    };
    store.write_review_finding(&request).unwrap();
    let (second_endpoint, second_wire) = server(vec![Reply::Finding]);
    let prepared = store
        .prepare_ai_semantic_review(
            config(second_endpoint),
            &[pair(unit, "zh-CN")],
            &[AiSemanticReviewRule::Meaning],
        )
        .unwrap();
    let (_, second) = execute(&mut store, &prepared);
    second_wire.join().unwrap();
    assert_ne!(second.evidence.endpoint, first.evidence.endpoint);
    assert_ne!(second.rules[0].findings[0].issue_id, issue);
    let view = store.review_findings(p, unit, "zh-CN", 0, 10).unwrap();
    assert!(view.findings[0].decision.is_none());
    assert_eq!(view.history.len(), 1);
}
