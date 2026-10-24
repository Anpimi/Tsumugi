#![cfg(all(feature = "legacy-desktop-domain", not(feature = "execution-test-host")))]
//! The explicit production transition does not enable execution test hooks.
mod support;

use std::{sync::Arc, time::{Duration, Instant}};
use tsumugi_core::{
    BuildLocaleChoice, ProjectMetadata, ProjectStore, ReleaseAdoptionHandler, ReviewCheckOutcome,
    ReviewDecisionKind, ReviewWrite, SaveTranslationRevision, TranslationAdoptionConfirmation,
    TranslationAdoptionHandler, TranslationSelectionDecision,
    content::{BuildRunner, SourceAdoptionHandler, SourceBundle, SourceImportStart, SourceRunner,
        TranslationBundle, TranslationImportStart, TranslationRunner, WebvttBuildRunner,
        WebvttSourceRunner},
    execution::*,
};

fn finish(runtime: &mut ExecutionRuntime, store: &mut ProjectStore, input: &FixedInput) -> ExecutionId {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(store).unwrap();
        let state = store.execution_attempt(input.envelope().attempt_id, true).unwrap();
        if state.items.iter().all(|item| item.execution == ExecutionState::Succeeded) {
            assert!(state.items.iter().all(|item| item.validation == ValidationState::Valid));
            return store.execution_current_result(input.envelope().attempt_id,
                input.envelope().items[0].item_id).unwrap().unwrap();
        }
        assert!(!state.items.iter().any(|item| matches!(item.execution,
            ExecutionState::Failed | ExecutionState::Unknown)), "{state:?}");
        assert!(Instant::now() < deadline, "legacy runner did not settle");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn explicit_legacy_desktop_imports_adopt_and_reopen_with_original_start_proofs() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("project");
    let mut store = ProjectStore::create(&path,
        ProjectMetadata::create("Legacy desktop", "en", ["zh-CN"]).unwrap()).unwrap();
    let project = store.metadata().unwrap().project_id();
    let source = SourceBundle::capture(
        br#"{"UniqueID":"Synthetic.Mod","Name":"Synthetic","Version":"1.0.0","EntryDll":"Synthetic.dll"}"#,
        br#"{"first":"Original"}"#, "en").unwrap();
    let request = SourceImportStart {
        project_id: ExecutionId::parse(&project.to_string()).unwrap(), attempt_id: ExecutionId::new(),
        selection_id: ExecutionId::new(), source_language: "en".into(),
    };
    let input = source.fixed_input_for_import_start(project, &request).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.register_read_only(Arc::new(TranslationRunner)).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    let result = finish(&mut runtime, &mut store, &input);
    let confirmation = store.source_preview(request.attempt_id, result, 0, 10).unwrap().confirmation;
    let action = store.prepare_adoption_with_id(ExecutionId::new(), request.attempt_id,
        input.envelope().units[0].unit_id, vec![result], serde_json::to_value(confirmation).unwrap()).unwrap();
    store.adopt_execution(&action, &SourceAdoptionHandler).unwrap();
    let source_proof = store.source_import_start_action_read(&request).unwrap().unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let translations = TranslationBundle::capture("i18n/zh.json", br#"{"first":"Translation"}"#,
        "zh-CN", snapshot).unwrap();
    let translation_request = TranslationImportStart {
        project_id: request.project_id, attempt_id: ExecutionId::new(), selection_id: request.selection_id,
        file_name: "zh.json".into(), target_locale: "zh-CN".into(), language_confirmed: true,
        expected_file_digest: translations.file.sha256.clone(), expected_source_snapshot_id: snapshot,
    };
    let translated = translations.fixed_input_for_import_start(project, &translation_request).unwrap();
    runtime.submit(&mut store, &translated).unwrap();
    let result = finish(&mut runtime, &mut store, &translated);
    let preview = store.translation_preview(translation_request.attempt_id, 0, 10, None).unwrap();
    let row = &preview.rows[0];
    let unit = row.unit_id.unwrap();
    let confirmation = TranslationAdoptionConfirmation {
        result_digest: row.result_digest.clone(), source_snapshot_id: snapshot,
        occurrence_id: row.occurrence_id.unwrap(), source_revision_id: row.source_revision_id.unwrap(),
        target_unit_id: unit, expected_selection_id: None,
        decision: TranslationSelectionDecision::CandidateOnly,
    };
    let action = store.prepare_adoption_with_id(ExecutionId::new(), translation_request.attempt_id,
        translated.envelope().units[0].unit_id, vec![result], serde_json::to_value(confirmation).unwrap()).unwrap();
    store.adopt_execution(&action, &TranslationAdoptionHandler).unwrap();
    assert_eq!(store.translation_history(request.project_id, unit, "zh-CN", 0, 10).unwrap().total, 1);
    let proof = store.translation_import_start_action_read(&translation_request).unwrap().unwrap();
    let sequence = store.execution_sequence().unwrap();
    assert_eq!(store.source_import_start_action_read(&request).unwrap(), Some(source_proof.clone()));
    assert_eq!(store.translation_import_start_action_read(&translation_request).unwrap(), Some(proof.clone()));
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_import_start_action_read(&request).unwrap(), Some(source_proof));
    assert_eq!(reopened.translation_import_start_action_read(&translation_request).unwrap(), Some(proof));
    assert_eq!(reopened.translation_history(request.project_id, unit, "zh-CN", 0, 10).unwrap().rows[0].text,
        "Translation");
}

#[test]
fn explicit_legacy_feature_does_not_relax_plugin_source_binding_or_unknown_capability() {
    let (_directory, mut store, _) = support::source_fixture();
    let original = support::source_input(&store);
    assert!(SourceBundle::from_input(&original).is_ok());
    let before = serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap();
    for field in ["review", "checker"] {
        let mut envelope = original.envelope().clone();
        envelope.attempt_id = ExecutionId::new();
        envelope.settings[field] = serde_json::Value::Null;
        let input = FixedInput::capture(envelope).unwrap();
        assert!(SourceBundle::from_input(&input).is_err(), "{field}");
        assert!(store.enqueue_execution(&input).is_err(), "{field}");
    }
    let native = SourceBundle::capture(
        br#"{"UniqueID":"Synthetic.Mod","Name":"Synthetic","Version":"1.0.0","EntryDll":"Synthetic.dll"}"#,
        br#"{"first":"Original"}"#, "en").unwrap().fixed_input(store.metadata().unwrap().project_id()).unwrap();
    let mut envelope = native.envelope().clone();
    envelope.capability_id = "unknown.source-extract".into();
    let input = FixedInput::capture(envelope).unwrap();
    assert!(SourceBundle::from_input(&input).is_err());
    assert!(store.enqueue_execution(&input).is_err());
    assert_eq!(serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap(), before);
}

fn release_legacy_domain(caption: bool) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("project");
    let mut store = ProjectStore::create(&path,
        ProjectMetadata::create("Legacy release", "en", ["zh-CN"]).unwrap()).unwrap();
    let project = store.metadata().unwrap().project_id();
    let project_id = ExecutionId::parse(&project.to_string()).unwrap();
    let source = if caption {
        SourceBundle::capture_webvtt(include_bytes!("fixtures/webvtt/s1.vtt"), "en").unwrap()
    } else {
        SourceBundle::capture(
            br#"{"UniqueID":"Synthetic.Mod","Name":"Synthetic","Version":"1.0.0","EntryDll":"Synthetic.dll"}"#,
            br#"{"hello":"Hello {{name}}","plain":"Ordinary"}"#, "en").unwrap()
    };
    let start = SourceImportStart { project_id, attempt_id: ExecutionId::new(),
        selection_id: ExecutionId::new(), source_language: "en".into() };
    let input = source.fixed_input_for_import_start(project, &start).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.register_read_only(Arc::new(WebvttSourceRunner)).unwrap();
    runtime.register_read_only(Arc::new(BuildRunner)).unwrap();
    runtime.register_read_only(Arc::new(WebvttBuildRunner)).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    let result = finish(&mut runtime, &mut store, &input);
    let confirmation = store.source_preview(start.attempt_id, result, 0, 50).unwrap().confirmation;
    let adoption = store.prepare_adoption_with_id(ExecutionId::new(), start.attempt_id,
        input.envelope().units[0].unit_id, vec![result], serde_json::to_value(confirmation).unwrap()).unwrap();
    store.adopt_execution(&adoption, &SourceAdoptionHandler).unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let rows = store.source_content(snapshot, 0, 50).unwrap().rows;
    // These values and the complete caption bytes use the existing independent
    // WebVTT oracle; the SMAPI oracle covers its exact flat JSON output.
    let values: &[&str] = if caption {
        &["你好\n世界", "等待", "旧", "布局", "相同", "消失"]
    } else {
        &["你好 {{name}}", "普通"]
    };
    assert_eq!(rows.len(), values.len());
    let choices = vec![BuildLocaleChoice { locale: "zh-CN".into(),
        file_name: if caption { "zh-CN.vtt" } else { "i18n/zh.json" }.into() }];
    let missing = store.review_eligibility(project_id, &["zh-CN".into()]).unwrap();
    assert!(!missing.ready);
    assert_eq!(store.prepare_locale_build(project_id, ExecutionId::new(), &choices,
        &missing.basis).unwrap_err().code, ErrorCode::DependencyConflict);

    let mut manual_receipts = Vec::new();
    let mut human_receipts = Vec::new();
    for (row, text) in rows.iter().zip(values) {
        let unit = row.unit_id.unwrap();
        let target = store.review_target(project_id, unit, "zh-CN").unwrap();
        let request = SaveTranslationRevision { project_id, action_id: ExecutionId::new(),
            unit_id: unit, locale: "zh-CN".into(), source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id, text: (*text).into() };
        let receipt = store.save_translation_edit(&request).unwrap();
        manual_receipts.push((request, receipt));
        let target = store.review_target(project_id, unit, "zh-CN").unwrap();
        let prepared = store.prepare_review_check(project_id, unit, "zh-CN", &target.basis,
            ExecutionId::new(), &[]).unwrap();
        let cancellation = Cancellation::default();
        let checked = store.commit_review_check(prepared.compute(&cancellation), &cancellation).unwrap();
        assert_eq!(checked.outcome, ReviewCheckOutcome::Completed);
        let target = store.review_target(project_id, unit, "zh-CN").unwrap();
        assert_eq!(target.current_check.as_ref().unwrap().run_id, checked.run_id);
        let request = ReviewWrite { project_id, action_id: ExecutionId::new(), unit_id: unit,
            locale: "zh-CN".into(), expected_basis: target.basis,
            expected_decision_id: target.current_decision.map(|decision| decision.decision_id),
            actor: "Legacy domain reviewer".into(), kind: ReviewDecisionKind::Approve,
            reason: String::new() };
        let receipt = store.write_review(&request).unwrap();
        human_receipts.push((request, receipt));
    }
    let ready = store.review_eligibility(project_id, &["zh-CN".into()]).unwrap();
    assert!(ready.ready, "{ready:?}");
    let attempt = ExecutionId::new();
    let build = store.prepare_locale_build(project_id, attempt, &choices, &ready.basis).unwrap();
    assert!(build.envelope().plugin.is_none());
    runtime.submit(&mut store, &build).unwrap();
    let result = finish(&mut runtime, &mut store, &build);
    let action = store.prepare_adoption_with_id(ExecutionId::new(), attempt,
        build.envelope().units[0].unit_id, vec![result], serde_json::Value::Null).unwrap();
    let receipt = store.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap();
    let release = ExecutionId::parse(&receipt.changes[0].id).unwrap();
    let expected = if caption {
        include_str!("fixtures/webvtt/expected-zh-CN.vtt")
    } else {
        "{\n  \"hello\": \"你好 {{name}}\",\n  \"plain\": \"普通\"\n}\n"
    };
    assert_eq!(store.release_artifact(release, "zh-CN").unwrap().1, expected.as_bytes());
    let original = store.locale_build_start_receipt(project_id, attempt, &choices,
        &ready.basis).unwrap().unwrap();
    assert_eq!(original.task_id, build.envelope().task_id);
    assert_eq!(original.input_digest, build.digest());
    assert_eq!(original.choices, choices);
    assert_eq!(original.expected_eligibility_basis, ready.basis);
    drop(runtime);
    store.close().unwrap();

    let reopened = ProjectStore::open(&path).unwrap();
    let before = serde_json::to_value(reopened.changes_since(Revision::new(0).unwrap())).unwrap();
    assert_eq!(reopened.locale_build_start_receipt(project_id, attempt, &choices,
        &ready.basis).unwrap(), Some(original));
    assert_eq!(reopened.adoption_receipt(action.action_id).unwrap(), Some(receipt));
    assert_eq!(reopened.release_artifact(release, "zh-CN").unwrap().1, expected.as_bytes());
    for (request, receipt) in manual_receipts {
        assert_eq!(reopened.translation_save_receipt_by_request(&request).unwrap(), Some(receipt));
    }
    for (request, receipt) in human_receipts {
        assert_eq!(reopened.review_decision_action_read(&request).unwrap().unwrap().receipt, receipt);
    }
    assert_eq!(serde_json::to_value(reopened.changes_since(Revision::new(0).unwrap())).unwrap(), before);
}

#[test]
fn legacy_smapi_manual_review_qa_build_and_original_receipts_survive_reopen() {
    release_legacy_domain(false);
}

#[test]
fn legacy_webvtt_manual_review_qa_build_matches_caption_oracle_after_reopen() {
    release_legacy_domain(true);
}
