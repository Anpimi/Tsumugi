#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! A prebuilt independent domain package runs through Core's real execution,
//! semantic-check and atomic source-adoption boundaries, using synthetic data.
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{
    ProjectMetadata, ProjectStore,
    content::{
        LineageChoice, LineageDecision, SourceAdoptionHandler, SourceBundle, SourceChangeKind,
        SourceSettings,
    },
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/runtime.rs"]
mod runtime_fixture;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn authorize(
    runtime: &ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> ExecutionId {
    let grant = ExecutionId::new();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 180_000;
    runtime
        .authorize_plugin(
            store,
            grant,
            input,
            expires,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    grant
}
fn execute(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> FixedResult {
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(input.envelope().attempt_id) {
            if let Some(id) = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
            {
                let result = store
                    .execution_result(input.envelope().attempt_id, id)
                    .unwrap();
                assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
                return result;
            }
        }
        assert!(
            Instant::now() < deadline,
            "actual source worker completion deadline"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn fixed(
    store: &ProjectStore,
    producer: &RunnerProxy,
    checker: &RunnerProxy,
    text: &str,
) -> FixedInput {
    let bundle = SourceBundle::capture_webvtt(text.as_bytes(), "en-US").unwrap();
    let profile = contract("webvtt-captions");
    bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            producer.execution_binding(Some(profile.clone())).unwrap(),
            SourceSettings {
                revision_policy: sdk::SourceRevisionPolicy {
                    profile: profile.clone(),
                    revision_basis: vec![contract("webvtt.cue-basis")],
                },
                checker: Some(checker.execution_binding(Some(profile)).unwrap()),
                semantic_rules: vec![contract("webvtt.source-semantics")],
            },
        )
        .unwrap()
}
fn validate(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
    source: &FixedResult,
) -> PreparedSourceValidation {
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, source.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    authorize(runtime, store, &check_input);
    let result = execute(runtime, store, &check_input);
    let evidence = result.envelope().plugin.as_ref().unwrap();
    assert_eq!(
        evidence.channel.selection(),
        check_input
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .capability
            .provider
    );
    let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
        panic!()
    };
    let checks = sdk::parse_check_results(output.utf8.as_bytes()).unwrap();
    assert_eq!(checks.len(), 1);
    assert!(
        matches!(&checks[0].outcome,sdk::CheckOutcome::Completed {findings} if findings.is_empty())
    );
    capture.prepare(result).unwrap()
}
fn adopt(
    store: &mut ProjectStore,
    input: &FixedInput,
    source: &FixedResult,
    update: bool,
) -> ExecutionId {
    let confirmation = if update {
        let comparison = store
            .source_comparison(
                input.envelope().attempt_id,
                source.envelope().result_id,
                0,
                100,
            )
            .unwrap();
        let mut confirmation = comparison.confirmation;
        confirmation.actor = Some("Caption reviewer".into());
        for row in &comparison.rows {
            if row.kind == SourceChangeKind::Changed {
                confirmation.lineage.push(LineageChoice {
                    new_ordinal: row.new.as_ref().unwrap().ordinal,
                    old_occurrence_id: row.old.as_ref().unwrap().occurrence_id.unwrap(),
                    decision: LineageDecision::Continue,
                    reason: "Confirmed same cue with updated timing".into(),
                });
            }
        }
        confirmation
    } else {
        store
            .source_preview(
                input.envelope().attempt_id,
                source.envelope().result_id,
                0,
                100,
            )
            .unwrap()
            .confirmation
    };
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![source.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    store.content_scope().unwrap().current_snapshot.unwrap()
}

#[test]
fn official_source_checks_gate_atomic_adoption_revision_updates_and_reopening() {
    let selected = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
            .expect("explicit prebuilt official package required"),
    );
    let digest = std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST")
        .expect("independent package fingerprint required");
    let image = PackageImage::capture_directory(&selected, &digest, || true).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let staging = temporary.path().join("workers");
    std::fs::create_dir(&staging).unwrap();
    let proxy = |contribution| {
        Arc::new(
            RunnerProxy::new(
                image.clone(),
                contribution,
                runtime_fixture::approved_runtime(),
                &staging,
                HostLimits::default(),
            )
            .unwrap(),
        )
    };
    let producer = proxy("extract-source");
    let checker = proxy("source-semantic-check");
    let path = temporary.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Independent caption adoption", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(producer.clone()).unwrap();
    runtime.register(checker.clone()).unwrap();
    let original = "\u{feff}WEBVTT\r\n\r\nNOTE preserved\r\nRaw note\r\n\r\nKeep\r\n00:00:01.000 --> 00:00:02.000\r\n中文 👩🏽‍💻 é\r\n\r\n";
    let input = fixed(&store, &producer, &checker, original);
    authorize(&runtime, &mut store, &input);
    let source = execute(&mut runtime, &mut store, &input);
    let preview = store
        .source_preview(
            input.envelope().attempt_id,
            source.envelope().result_id,
            0,
            100,
        )
        .unwrap();
    assert_eq!(preview.rows[0].occurrence.key, "Keep");
    assert_eq!(
        preview.rows[0]
            .occurrence
            .native_identity
            .as_ref()
            .unwrap()
            .value,
        "keep"
    );
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Pending
    );
    let premature = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![source.envelope().result_id],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&premature, &SourceAdoptionHandler)
            .is_err()
    );
    assert!(
        store
            .validate_execution_result(input.envelope().attempt_id, source.envelope().result_id)
            .is_err()
    );
    let prepared = validate(&mut runtime, &mut store, &input, &source);
    store.commit_source_validation(prepared).unwrap();
    let first = adopt(&mut store, &input, &source, false);
    let first_page = store.source_content(first, 0, 100).unwrap();
    let unit = first_page.rows[0].unit_id;
    let revision = first_page.rows[0].source_revision_id;

    // A note-only raw change preserves the Core semantic source revision.
    let note = original.replace("Raw note", "Changed note");
    let input2 = fixed(&store, &producer, &checker, &note);
    authorize(&runtime, &mut store, &input2);
    let source2 = execute(&mut runtime, &mut store, &input2);
    let prepared = validate(&mut runtime, &mut store, &input2, &source2);
    store.commit_source_validation(prepared).unwrap();
    assert_eq!(
        store
            .source_comparison(
                input2.envelope().attempt_id,
                source2.envelope().result_id,
                0,
                100
            )
            .unwrap()
            .rows[0]
            .kind,
        SourceChangeKind::Unchanged
    );
    let second = adopt(&mut store, &input2, &source2, true);
    let page2 = store.source_content(second, 0, 100).unwrap();
    assert_eq!(page2.rows[0].unit_id, unit);
    assert_eq!(page2.rows[0].source_revision_id, revision);

    // Same text with changed timing changes the policy-selected opaque basis.
    let timing = note.replace("00:00:02.000", "00:00:03.000");
    let input3 = fixed(&store, &producer, &checker, &timing);
    authorize(&runtime, &mut store, &input3);
    let source3 = execute(&mut runtime, &mut store, &input3);
    let prepared = validate(&mut runtime, &mut store, &input3, &source3);
    store.commit_source_validation(prepared).unwrap();
    assert_eq!(
        store
            .source_comparison(
                input3.envelope().attempt_id,
                source3.envelope().result_id,
                0,
                100
            )
            .unwrap()
            .rows[0]
            .kind,
        SourceChangeKind::Changed
    );
    let third = adopt(&mut store, &input3, &source3, true);
    let page3 = store.source_content(third, 0, 100).unwrap();
    assert_eq!(page3.rows[0].unit_id, unit);
    assert_ne!(page3.rows[0].source_revision_id, revision);

    let input4 = fixed(&store, &producer, &checker, &timing);
    let grant = authorize(&runtime, &mut store, &input4);
    let source4 = execute(&mut runtime, &mut store, &input4);
    let prepared = validate(&mut runtime, &mut store, &input4, &source4);
    runtime.revoke_plugin(&mut store, grant).unwrap();
    assert_eq!(
        store.commit_source_validation(prepared).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(store.content_scope().unwrap().current_snapshot, Some(third));

    // The largest declared source/cue scope crosses the old frame and ledger
    // budgets. Exercise its original bytes and complete proof on real workers.
    let cues: String = (0..2000)
        .map(|index| format!("C{index}\n00:00.000 --> 00:01.000\na\n\n"))
        .collect();
    let prefix = "WEBVTT\n\nNOTE ";
    let large_source = format!(
        "{prefix}{}\n\n{cues}",
        "x".repeat(128 * 1024 - prefix.len() - 2 - cues.len())
    );
    assert_eq!(large_source.len(), 128 * 1024);
    let large_path = temporary.path().join("large-project");
    let mut large_store = ProjectStore::create(
        &large_path,
        ProjectMetadata::create("Complete bounded source", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut large_runtime = ExecutionRuntime::new(&large_store).unwrap();
    large_runtime.register(producer.clone()).unwrap();
    large_runtime.register(checker.clone()).unwrap();
    let large_input = fixed(&large_store, &producer, &checker, &large_source);
    authorize(&large_runtime, &mut large_store, &large_input);
    let large_result = execute(&mut large_runtime, &mut large_store, &large_input);
    assert!(large_result.bytes().len() > 2 * 1024 * 1024);
    assert!(large_result.bytes().len() <= large_input.envelope().limits.max_result_bytes as usize);
    let large_capture = large_store
        .capture_source_validation(
            large_input.envelope().attempt_id,
            large_result.envelope().result_id,
        )
        .unwrap();
    assert!(large_capture.check_input().bytes().len() > sdk::MAX_EXCHANGE_BYTES);
    let prepared = validate(
        &mut large_runtime,
        &mut large_store,
        &large_input,
        &large_result,
    );
    large_store.commit_source_validation(prepared).unwrap();
    let large_snapshot = adopt(&mut large_store, &large_input, &large_result, false);
    let last_page = large_store
        .source_content(large_snapshot, 1900, 100)
        .unwrap();
    assert_eq!(last_page.total, 2000);
    assert_eq!(last_page.rows.len(), 100);
    assert_eq!(last_page.rows[99].occurrence.key, "C1999");
    large_runtime.begin_quiesce(&mut large_store).unwrap();
    large_runtime.finish_quiesce(&mut large_store).unwrap();
    drop(large_runtime);
    drop(large_store);
    let large_reopened = ProjectStore::open(&large_path).unwrap();
    assert_eq!(
        large_reopened
            .source_content(large_snapshot, 1900, 100)
            .unwrap(),
        last_page
    );
    assert_eq!(
        large_reopened
            .source_bundle(large_snapshot)
            .unwrap()
            .source_input()
            .artifacts[0]
            .utf8,
        large_source
    );
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    assert_eq!(
        std::fs::read_dir(&staging).unwrap().count(),
        0,
        "all task processes reaped and instance trees reclaimed"
    );
    let source_bytes = source.bytes().to_vec();
    drop(runtime);
    drop(store);
    // Reading persisted source/check provenance never reacquires permission or
    // needs an installed domain package. The runner and runtime are gone.
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_content(third, 0, 100).unwrap(), page3);
    assert_eq!(
        reopened
            .source_bundle(first)
            .unwrap()
            .source_input()
            .artifacts[0]
            .utf8,
        original
    );
    assert_eq!(
        reopened
            .execution_result(input.envelope().attempt_id, source.envelope().result_id)
            .unwrap()
            .bytes(),
        source_bytes
    );
    assert_eq!(
        reopened
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Valid
    );
    assert_eq!(
        reopened.content_scope().unwrap().current_snapshot,
        Some(third)
    );
}
