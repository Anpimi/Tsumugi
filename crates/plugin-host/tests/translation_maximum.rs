#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! Complete maximum-file execution and adoption through the actual plugin Host.
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tsumugi_core::{
    ProjectMetadata, ProjectStore, TranslationAdoptionConfirmation, TranslationAdoptionHandler,
    TranslationMatch, TranslationSelectionDecision,
    content::{
        PluginTranslationSettings, SourceAdoptionHandler, SourceBundle, SourceSettings,
        TranslationProjectionRunner,
    },
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/core_execution.rs"]
mod core_execution;
#[path = "support/runtime.rs"]
mod runtime_fixture;
use core_execution::{authorize, execute};

#[test]
fn maximum_file_executes_and_adopts_all_entries_with_saved_receipts_after_reopen() {
    maximum_file_workflow(false, 6);
}

#[test]
fn maximum_unicode_and_escaped_text_executes_and_adopts_with_exact_saved_values() {
    maximum_file_workflow(true, 6);
}

#[test]
fn maximum_long_native_keys_execute_and_adopt_all_entries_without_truncation() {
    maximum_file_workflow(false, 48);
}

fn maximum_file_workflow(unicode: bool, key_length: usize) {
    let selected = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
            .expect("explicit prebuilt SMAPI package required"),
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
    let source_resource = image.source_import("source-profile").unwrap();
    let source_producer = proxy(source_resource.declaration.extractor.as_str());
    let source_checker = proxy(source_resource.declaration.checker.as_str());
    let resource = image.translation_import("translation-profile").unwrap();
    let producer = proxy(resource.declaration.extractor.as_str());
    let checker = proxy(resource.declaration.checker.as_str());
    let path = temporary.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Complete translation proof", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = store.metadata().unwrap().project_id();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&source_producer, &source_checker, &producer, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    let source_json = serde_json::to_vec(
        &(0..2000)
            .map(|n| (format!("K{n:04}{}", "X".repeat(key_length - 5)), "same"))
            .collect::<std::collections::BTreeMap<_, _>>(),
    )
    .unwrap();
    let source_bundle = SourceBundle::capture_declared(
        &source_resource,
        vec![
            br#"{"UniqueID":"Example.Mod","Name":"Test","Version":"1.0.0","EntryDll":"Test.dll"}"#
                .to_vec(),
            source_json,
        ],
        "en-US",
    )
    .unwrap();
    let profile = resource.declaration.profile.clone();
    let source_input = source_bundle
        .fixed_plugin_input(
            project,
            source_producer
                .execution_binding(Some(profile.clone()))
                .unwrap(),
            SourceSettings {
                revision_policy: source_resource.declaration.revision_policy.clone(),
                checker: Some(
                    source_checker
                        .execution_binding(Some(profile.clone()))
                        .unwrap(),
                ),
                semantic_rules: source_resource.declaration.semantic_rules.clone(),
            },
        )
        .unwrap();
    authorize(&runtime, &mut store, &source_input);
    let source_result = execute(&mut runtime, &mut store, &source_input);
    let source_capture = store
        .capture_source_validation(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
        )
        .unwrap();
    let check_input = source_capture.check_input().clone();
    authorize(&runtime, &mut store, &check_input);
    let checked = execute(&mut runtime, &mut store, &check_input);
    store
        .commit_source_validation(source_capture.prepare(checked).unwrap())
        .unwrap();
    let confirmation = store
        .source_preview(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
            0,
            100,
        )
        .unwrap()
        .confirmation;
    let adoption = store
        .prepare_adoption(
            source_input.envelope().attempt_id,
            source_input.envelope().units[0].unit_id,
            vec![source_result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&adoption, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let source = store.source_content(snapshot, 0, 100).unwrap();
    let native = source.rows[0].occurrence.native_identity.as_ref().unwrap();

    assert_eq!(store.source_content(snapshot, 0, 100).unwrap().total, 2000);
    let expected_texts = (0..2000)
        .map(|n| {
            if unicode && n == 0 {
                "😀".repeat(4096)
            } else if unicode {
                format!("译文 {n} \"\\\n\t é 👩🏽‍💻")
            } else if n % 500 == 0 {
                format!("译文 {n} 👩🏽‍💻")
            } else {
                String::new()
            }
        })
        .collect::<Vec<_>>();
    if unicode {
        assert_eq!(expected_texts[0].len(), 16 * 1024);
    }
    let pairs = expected_texts
        .iter()
        .enumerate()
        .map(|(n, text)| {
            format!(
                "\"k{n:04}{}\":{}",
                "x".repeat(key_length - 5),
                serde_json::to_string(&text).unwrap()
            )
        })
        .collect::<Vec<_>>();
    let mut raw = format!(
        "{}{{{}}}",
        if unicode { "\u{feff}" } else { "" },
        pairs.join(",")
    );
    let padding = (128 * 1024usize)
        .checked_sub(raw.len())
        .expect("complete fixture fits raw limit");
    raw.push_str(&" ".repeat(padding));
    let material = sdk::TranslationExtractionInput {
        profile: profile.clone(),
        import_id: ExecutionId::new().to_string(),
        source_set_id: source_bundle.set_id.to_string(),
        source_snapshot_id: snapshot.to_string(),
        target_language: "zh-CN".into(),
        language_evidence: sdk::TranslationLanguageEvidence::UserConfirmed,
        native_scope: sdk::TranslationNativeScope {
            namespace: native.namespace.clone(),
            policy: native.policy.clone(),
        },
        artifacts: vec![sdk::CapturedTextArtifact {
            id: ExecutionId::new().to_string(),
            logical_path: "i18n/zh.json".into(),
            role: "translation".into(),
            sha256: sdk::payload_digest(&raw),
            utf8: raw,
        }],
    };
    let settings = PluginTranslationSettings {
        declaration: resource.declaration.clone(),
        checker: checker.execution_binding(Some(profile.clone())).unwrap(),
    };
    if unicode {
        for (key, text, expected) in [
            (
                "İ",
                "译文".to_owned(),
                sdk::SourceExtractionErrorCode::UnsupportedStructure,
            ),
            (
                "k0000x",
                format!("{}x", "😀".repeat(4096)),
                sdk::SourceExtractionErrorCode::LimitExceeded,
            ),
        ] {
            let mut rejected = material.clone();
            rejected.import_id = ExecutionId::new().to_string();
            rejected.artifacts[0].id = ExecutionId::new().to_string();
            rejected.artifacts[0].utf8 =
                serde_json::to_string(&std::collections::BTreeMap::from([(key, text)])).unwrap();
            rejected.artifacts[0].sha256 = sdk::payload_digest(&rejected.artifacts[0].utf8);
            let input = settings
                .fixed_input(
                    project,
                    rejected,
                    producer.execution_binding(Some(profile.clone())).unwrap(),
                )
                .unwrap();
            authorize_maximum(&runtime, &mut store, &input);
            let result = execute_failure(&mut runtime, &mut store, &input);
            let sdk::InvocationOutcome::Failed { error } =
                &result.envelope().plugin.as_ref().unwrap().result.outcome
            else {
                panic!("typed domain failure required")
            };
            assert_eq!(
                sdk::parse_source_extraction_error(error.utf8.as_bytes())
                    .unwrap()
                    .code,
                expected
            );
            assert!(
                store
                    .capture_translation_validation(
                        input.envelope().attempt_id,
                        result.envelope().result_id
                    )
                    .is_err()
            );
            assert!(
                store
                    .capture_translation_projection(
                        input.envelope().attempt_id,
                        result.envelope().result_id
                    )
                    .is_err()
            );
        }
    }
    let input = settings
        .fixed_input(
            project,
            material,
            producer.execution_binding(Some(profile)).unwrap(),
        )
        .unwrap();
    authorize_maximum(&runtime, &mut store, &input);
    let proposal = execute(&mut runtime, &mut store, &input);
    let capture = store
        .capture_translation_validation(input.envelope().attempt_id, proposal.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    println!(
        "maximum transport unicode={unicode} key_length={key_length} producer_input={} ledger_proposal={} fixed_check={}",
        input.bytes().len(),
        proposal.bytes().len(),
        check_input.bytes().len()
    );
    authorize_maximum(&runtime, &mut store, &check_input);
    let checked = execute(&mut runtime, &mut store, &check_input);
    store
        .commit_translation_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let projected = store
        .capture_translation_projection(input.envelope().attempt_id, proposal.envelope().result_id)
        .unwrap();
    runtime
        .register_read_only(Arc::new(TranslationProjectionRunner))
        .unwrap();
    runtime.submit(&mut store, &projected).unwrap();
    for item in projected.envelope().items.iter().take(5) {
        let t = Instant::now();
        let request = store
            .dispatch_execution_item(projected.envelope().attempt_id, item.item_id)
            .unwrap();
        let dispatch = t.elapsed();
        let t = Instant::now();
        let (sender, receiver) = result_channel();
        TranslationProjectionRunner
            .run(request, Cancellation::default(), sender)
            .unwrap();
        let result = receiver.recv().unwrap();
        let produce = t.elapsed();
        let t = Instant::now();
        store.save_execution_result(&result).unwrap();
        let save = t.elapsed();
        let t = Instant::now();
        store
            .validate_execution_result(projected.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        println!(
            "maximum stages dispatch={dispatch:?} produce={produce:?} save={save:?} validate={:?}",
            t.elapsed()
        );
    }
    let started = Instant::now();
    let mut reported = 0;
    loop {
        runtime.tick(&mut store).unwrap();
        if !runtime.is_active(projected.envelope().attempt_id) {
            break;
        }
        if started.elapsed() > Duration::from_secs(300) {
            let state = store
                .execution_attempt(projected.envelope().attempt_id, true)
                .unwrap();
            let completed = state
                .items
                .iter()
                .filter(|item| item.validation == ValidationState::Valid)
                .count();
            panic!(
                "maximum projection exceeded 300s completion bound: {completed}/2000 valid in {:?}",
                started.elapsed()
            );
        }
        if started.elapsed().as_secs() / 30 > reported {
            reported = started.elapsed().as_secs() / 30;
            let state = store
                .execution_attempt(projected.envelope().attempt_id, true)
                .unwrap();
            println!(
                "maximum execution progress {}/2000 valid in {:?}",
                state
                    .items
                    .iter()
                    .filter(|item| item.validation == ValidationState::Valid)
                    .count(),
                started.elapsed()
            );
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let execution_seconds = started.elapsed().as_secs_f64();
    let state = store
        .execution_attempt(projected.envelope().attempt_id, false)
        .unwrap();
    assert!(
        state
            .items
            .iter()
            .all(|item| item.validation == ValidationState::Valid)
    );
    let mut result_bytes = 0usize;
    for item in &projected.envelope().items {
        let id = store
            .execution_current_result(projected.envelope().attempt_id, item.item_id)
            .unwrap()
            .unwrap();
        let result = store
            .execution_result(projected.envelope().attempt_id, id)
            .unwrap();
        assert!(result.bytes().len() <= 2 * 1024 * 1024);
        result_bytes += result.bytes().len();
    }
    assert!(result_bytes <= 8 * 1024 * 1024);
    println!(
        "maximum execution completed in {execution_seconds:.3}s, stored results={result_bytes}"
    );
    let page = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!((page.total, page.unique, page.unmatched), (2000, 2000, 0));
    let basis = page.basis.clone();
    let mut rows = page.rows;
    for after in (100..2000).step_by(100) {
        let page = store
            .translation_preview(projected.envelope().attempt_id, after, 100, Some(&basis))
            .unwrap();
        assert!(
            page.rows
                .iter()
                .all(|row| row.status == TranslationMatch::Unique)
        );
        rows.extend(page.rows);
    }
    assert_eq!(rows.len(), 2000);
    assert_eq!(
        rows.iter()
            .map(|row| row.unit_id.unwrap())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        2000
    );
    for (n, row) in rows.iter().enumerate() {
        assert_eq!(
            row.entry.native_key,
            format!("k{n:04}{}", "x".repeat(key_length - 5))
        );
        assert_eq!(row.entry.text, expected_texts[n]);
    }
    let mut receipts = Vec::new();
    let adopted = Instant::now();
    for row in &rows {
        let unit = projected
            .envelope()
            .units
            .iter()
            .find(|unit| unit.item_ids == [row.item_id])
            .unwrap();
        let action = store
            .prepare_adoption(
                projected.envelope().attempt_id,
                unit.unit_id,
                vec![row.result_id],
                serde_json::to_value(TranslationAdoptionConfirmation {
                    result_digest: row.result_digest.clone(),
                    source_snapshot_id: snapshot,
                    occurrence_id: row.occurrence_id.unwrap(),
                    source_revision_id: row.source_revision_id.unwrap(),
                    target_unit_id: row.unit_id.unwrap(),
                    expected_selection_id: None,
                    decision: TranslationSelectionDecision::SelectIfEmpty,
                })
                .unwrap(),
            )
            .unwrap();
        let receipt = store
            .adopt_execution(&action, &TranslationAdoptionHandler)
            .unwrap();
        assert_eq!(receipt.changes.len(), 2);
        receipts.push((action, receipt));
        if receipts.len() % 500 == 0 {
            println!(
                "maximum adopted {} in {:?}",
                receipts.len(),
                adopted.elapsed()
            );
        }
    }
    let adoption_seconds = adopted.elapsed().as_secs_f64();
    assert_eq!(
        store
            .translation_preview(projected.envelope().attempt_id, 0, 100, None)
            .unwrap()
            .applied,
        2000
    );
    assert!(
        store
            .translation_preview(projected.envelope().attempt_id, 100, 100, Some(&basis))
            .is_err()
    );
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    drop(store);
    let mut reopened = ProjectStore::open(&path).unwrap();
    for (action, receipt) in &receipts {
        assert_eq!(
            reopened
                .adopt_execution(action, &TranslationAdoptionHandler)
                .unwrap(),
            *receipt
        );
    }
    for (n, row) in rows.iter().enumerate() {
        let history = reopened
            .translation_history(
                ExecutionId::parse(&project.to_string()).unwrap(),
                row.unit_id.unwrap(),
                "zh-CN",
                0,
                1,
            )
            .unwrap();
        assert_eq!(history.total, 1);
        assert_eq!(
            history.current_text.as_deref(),
            Some(expected_texts[n].as_str())
        );
        assert_eq!(history.rows[0].text, expected_texts[n]);
        assert_eq!(history.rows[0].result_id, Some(row.result_id));
        assert_eq!(history.rows[0].action_id, receipts[n].0.action_id);
        assert_eq!(
            history.current.as_ref().unwrap().revision_id,
            history.rows[0].revision_id
        );
    }
    let reopened_basis = reopened
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap()
        .basis;
    let history = reopened
        .translation_preview(
            projected.envelope().attempt_id,
            1900,
            100,
            Some(&reopened_basis),
        )
        .unwrap();
    assert_eq!((history.total, history.applied), (2000, 2000));
    assert_eq!(history.rows[99].entry.ordinal, 1999);
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    println!(
        "maximum file unicode={unicode} key_length={key_length} raw=131072 entries=2000 projection_input={} execution_seconds={:.3} adoption_seconds={:.3} receipts={}",
        projected.bytes().len(),
        execution_seconds,
        adoption_seconds,
        receipts.len()
    );
}

fn execute_failure(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> FixedResult {
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(input.envelope().attempt_id) {
            let id = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
            let result = store
                .execution_result(input.envelope().attempt_id, id)
                .unwrap();
            assert_eq!(result.envelope().outcome, ExecutionState::Failed);
            assert_ne!(
                store
                    .execution_attempt(input.envelope().attempt_id, false)
                    .unwrap()
                    .items[0]
                    .validation,
                ValidationState::Valid
            );
            return result;
        }
        assert!(
            Instant::now() < deadline,
            "typed failure completion deadline"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

// This bounded maximum-file fixture performs thousands of separately durable
// writes. Its explicit synthetic producer/checker grants are independent of the
// normal small-worker helper and stay below the production one-hour ceiling.
fn authorize_maximum(runtime: &ExecutionRuntime, store: &mut ProjectStore, input: &FixedInput) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 900_000;
    runtime
        .authorize_plugin(
            store,
            ExecutionId::new(),
            input,
            expires,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
}
