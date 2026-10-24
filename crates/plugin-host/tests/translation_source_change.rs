#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! Actual independently checked Source updates invalidate uncommitted translation
//! adoption without removing saved candidates, selections or original receipts.
use std::{path::PathBuf, sync::Arc};
use tsumugi_core::{
    ProjectMetadata, ProjectStore, TranslationAdoptionConfirmation, TranslationAdoptionHandler,
    TranslationMatch, TranslationSelectionDecision,
    content::{
        LineageChoice, LineageDecision, PluginTranslationSettings, SourceAdoptionHandler,
        SourceBundle, SourceChangeKind, SourceSettings, TranslationProjectionRunner,
        validate_plugin_translation_output,
    },
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/core_execution.rs"]
mod core_execution;
#[path = "support/runtime.rs"]
mod runtime_fixture;
use core_execution::{authorize, execute, execute_all};

fn checked_source(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    resource: &sdk::SourceImportBinding,
    producer: &RunnerProxy,
    checker: &RunnerProxy,
    text: &[u8],
) -> (SourceBundle, FixedInput, FixedResult) {
    checked_source_materials(
        runtime,
        store,
        resource,
        producer,
        checker,
        vec![
            br#"{"UniqueID":"Example.Mod","Name":"Test","Version":"1.0.0","EntryDll":"Test.dll"}"#
                .to_vec(),
            text.to_vec(),
        ],
    )
}

fn checked_source_materials(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    resource: &sdk::SourceImportBinding,
    producer: &RunnerProxy,
    checker: &RunnerProxy,
    materials: Vec<Vec<u8>>,
) -> (SourceBundle, FixedInput, FixedResult) {
    let bundle = SourceBundle::capture_declared(resource, materials, "en-US").unwrap();
    let profile = resource.declaration.profile.clone();
    let input = bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            producer.execution_binding(Some(profile.clone())).unwrap(),
            SourceSettings {
                native_start: None,
                revision_policy: resource.declaration.revision_policy.clone(),
                checker: Some(checker.execution_binding(Some(profile)).unwrap()),
                semantic_rules: resource.declaration.semantic_rules.clone(),
                review: Some(
                    tsumugi_core::content::SourceReviewBinding::capture(
                        &resource.review,
                        &tsumugi_core::execution::PluginExecutionBinding {
                            component_scope: sdk::ComponentScope::Project,
                            application_scope: None,
                            capability: (&resource.review).checker.clone(),
                            profile: Some((&resource.review).declaration.profile.clone()),
                            environment: (*(&producer
                                .execution_binding(Some(resource.declaration.profile.clone()))
                                .unwrap()
                                .environment))
                                .clone()
                                .into(),
                        },
                    )
                    .unwrap(),
                ),
            },
        )
        .unwrap();
    authorize(runtime, store, &input);
    let result = execute(runtime, store, &input);
    let captured = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check = captured.check_input().clone();
    authorize(runtime, store, &check);
    let checked = execute(runtime, store, &check);
    store
        .commit_source_validation(captured.prepare(checked).unwrap())
        .unwrap();
    (bundle, input, result)
}

fn checked_translation(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    resource: &sdk::TranslationImportBinding,
    producer: &RunnerProxy,
    checker: &RunnerProxy,
    material: sdk::TranslationExtractionInput,
) -> (FixedInput, FixedResult, FixedInput) {
    let profile = resource.declaration.profile.clone();
    let input = PluginTranslationSettings {
        declaration: resource.declaration.clone(),
        checker: checker.execution_binding(Some(profile.clone())).unwrap(),
    }
    .fixed_input(
        store.metadata().unwrap().project_id(),
        material,
        producer.execution_binding(Some(profile)).unwrap(),
    )
    .unwrap();
    authorize(runtime, store, &input);
    let result = execute(runtime, store, &input);
    let captured = store
        .capture_translation_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check = captured.check_input().clone();
    authorize(runtime, store, &check);
    let checked = execute(runtime, store, &check);
    store
        .commit_translation_validation(captured.prepare(checked).unwrap())
        .unwrap();
    let projected = store
        .capture_translation_projection(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    for result in execute_all(runtime, store, &projected) {
        store
            .validate_execution_result(projected.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
    }
    (input, result, projected)
}

fn translation_action(
    store: &mut ProjectStore,
    projected: &FixedInput,
    row: &tsumugi_core::TranslationPreviewRow,
    snapshot: ExecutionId,
    decision: TranslationSelectionDecision,
) -> AdoptionAction {
    let unit = projected
        .envelope()
        .units
        .iter()
        .find(|unit| unit.item_ids == [row.item_id])
        .unwrap();
    store
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
                expected_selection_id: row.current_selection.as_ref().map(|s| s.event_id),
                decision,
            })
            .unwrap(),
        )
        .unwrap()
}

#[test]
fn checked_source_update_refuses_old_translation_adoption_and_preserves_committed_history() {
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
        ProjectMetadata::create("Translation source update", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&source_producer, &source_checker, &producer, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    runtime
        .register_read_only(Arc::new(TranslationProjectionRunner))
        .unwrap();
    let (source_bundle, source_input, source_result) = checked_source(
        &mut runtime,
        &mut store,
        &source_resource,
        &source_producer,
        &source_checker,
        br#"{"MiXA":"same","Different":"same","Empty":"","Removed":"obsolete"}"#,
    );
    let confirmation = store
        .source_preview(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
            0,
            100,
        )
        .unwrap()
        .confirmation;
    let source_action = store
        .prepare_adoption(
            source_input.envelope().attempt_id,
            source_input.envelope().units[0].unit_id,
            vec![source_result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    let source_receipt = store
        .adopt_execution(&source_action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let source = store.source_content(snapshot, 0, 100).unwrap();
    let native = source.rows[0].occurrence.native_identity.as_ref().unwrap();
    let raw =
        "{\"mIxA\":\"你好 é\",\"Different\":\"已选译文\",\"Empty\":\"\",\"Removed\":\"旧条目\"}";
    let material = sdk::TranslationExtractionInput {
        profile: resource.declaration.profile.clone(),
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
            utf8: raw.into(),
            sha256: sdk::payload_digest(raw),
        }],
    };
    let (input, result, projected) = checked_translation(
        &mut runtime,
        &mut store,
        &resource,
        &producer,
        &checker,
        material.clone(),
    );
    let proposal = validate_plugin_translation_output(&input, &result).unwrap();
    let preview = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!((preview.total, preview.unique), (4, 4));
    let candidate = translation_action(
        &mut store,
        &projected,
        &preview.rows[0],
        snapshot,
        TranslationSelectionDecision::CandidateOnly,
    );
    let candidate_receipt = store
        .adopt_execution(&candidate, &TranslationAdoptionHandler)
        .unwrap();
    assert_eq!(candidate_receipt.changes.len(), 1);
    let selected = translation_action(
        &mut store,
        &projected,
        &preview.rows[1],
        snapshot,
        TranslationSelectionDecision::SelectIfEmpty,
    );
    let selected_receipt = store
        .adopt_execution(&selected, &TranslationAdoptionHandler)
        .unwrap();
    assert_eq!(selected_receipt.changes.len(), 2);
    let history = |store: &ProjectStore, n: usize| {
        store
            .translation_history(project, preview.rows[n].unit_id.unwrap(), "zh-CN", 0, 100)
            .unwrap()
    };
    let candidate_history = history(&store, 0);
    let selected_history = history(&store, 1);
    assert_eq!(candidate_history.total, 1);
    assert!(candidate_history.current.is_none());
    assert_eq!(candidate_history.rows[0].text, "你好 é");
    assert_eq!(candidate_history.rows[0].source_snapshot_id, snapshot);
    assert_eq!(
        candidate_history.rows[0].source_revision_id,
        preview.rows[0].source_revision_id.unwrap()
    );
    assert_eq!(candidate_history.rows[0].action_id, candidate.action_id);
    assert_eq!(
        candidate_history.rows[0].result_id,
        Some(preview.rows[0].result_id)
    );
    assert_eq!(selected_history.current_text.as_deref(), Some("已选译文"));
    assert_eq!(history(&store, 2).total, 0);
    let before_update = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    let stale = translation_action(
        &mut store,
        &projected,
        &before_update.rows[2],
        snapshot,
        TranslationSelectionDecision::SelectIfEmpty,
    );
    let prepared_stale = store
        .capture_execution_adoption(&stale)
        .unwrap()
        .prepare(&TranslationAdoptionHandler)
        .unwrap();
    let removed = translation_action(
        &mut store,
        &projected,
        &before_update.rows[3],
        snapshot,
        TranslationSelectionDecision::CandidateOnly,
    );
    let prepared_removed = store
        .capture_execution_adoption(&removed)
        .unwrap()
        .prepare(&TranslationAdoptionHandler)
        .unwrap();
    let old_source_projection = store
        .capture_translation_projection(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();

    // Use the actual producer/checker and the existing lineage transaction. No
    // grant is revoked, so a stale-source refusal cannot be masked by consent.
    let (updated_bundle, updated_input, updated_result) = checked_source(
        &mut runtime,
        &mut store,
        &source_resource,
        &source_producer,
        &source_checker,
        br#"{"MiXA":"changed source","Different":"same","Empty":""}"#,
    );
    let comparison = store
        .source_comparison(
            updated_input.envelope().attempt_id,
            updated_result.envelope().result_id,
            0,
            100,
        )
        .unwrap();
    assert_eq!(
        (
            comparison.changed,
            comparison.unchanged,
            comparison.added,
            comparison.removed
        ),
        (1, 2, 0, 1)
    );
    assert_eq!(
        comparison
            .rows
            .iter()
            .find(|row| row.kind == SourceChangeKind::Removed)
            .unwrap()
            .old
            .as_ref()
            .unwrap()
            .occurrence
            .key,
        "Removed"
    );
    let changed = comparison
        .rows
        .iter()
        .find(|row| row.kind == SourceChangeKind::Changed)
        .unwrap();
    assert_eq!(changed.old.as_ref().unwrap().occurrence.key, "MiXA");
    assert_eq!(changed.new.as_ref().unwrap().text, "changed source");
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Synthetic source reviewer".into());
    confirmation.lineage.push(LineageChoice {
        new_ordinal: changed.new.as_ref().unwrap().ordinal,
        old_occurrence_id: changed.old.as_ref().unwrap().occurrence_id.unwrap(),
        decision: LineageDecision::Continue,
        reason: "Confirmed same native key with updated source text".into(),
    });
    let updated_action = store
        .prepare_adoption(
            updated_input.envelope().attempt_id,
            updated_input.envelope().units[0].unit_id,
            vec![updated_result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    let updated_receipt = store
        .adopt_execution(&updated_action, &SourceAdoptionHandler)
        .unwrap();
    let current_snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    assert_ne!(current_snapshot, snapshot);
    let updated_source = store.source_content(current_snapshot, 0, 100).unwrap();
    assert_eq!(updated_source.rows[0].unit_id, source.rows[0].unit_id);
    assert_ne!(
        updated_source.rows[0].source_revision_id,
        source.rows[0].source_revision_id
    );
    assert_eq!(updated_source.rows[1].unit_id, source.rows[1].unit_id);
    assert_eq!(
        updated_source.rows[1].source_revision_id,
        source.rows[1].source_revision_id
    );
    let saved_source = store.source_content(snapshot, 0, 100).unwrap();
    assert_eq!(saved_source.rows, source.rows);
    assert_eq!(saved_source.coverage, source.coverage);
    assert_eq!(saved_source.namespace, source.namespace);
    assert_eq!(saved_source.total, 4);

    let error = store.commit_execution_adoption(prepared_stale).unwrap_err();
    assert_eq!(error.code, ErrorCode::DependencyConflict);
    assert_eq!(error.stage, "translation-source");
    assert!(store.adoption_receipt(stale.action_id).unwrap().is_none());
    let error = store
        .commit_execution_adoption(prepared_removed)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::DependencyConflict);
    assert_eq!(error.stage, "translation-source");
    assert!(store.adoption_receipt(removed.action_id).unwrap().is_none());
    let old = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!(old.fixed_source_snapshot_id, snapshot);
    assert_eq!(old.current_source_snapshot_id, current_snapshot);
    assert_eq!((old.total, old.applied, old.source_changed), (4, 2, 4));
    assert_eq!(old.rows[0].status, TranslationMatch::Applied);
    assert_eq!(old.rows[1].status, TranslationMatch::Applied);
    assert_eq!(old.rows[2].status, TranslationMatch::SourceChanged);
    assert_eq!(old.rows[3].status, TranslationMatch::SourceChanged);
    assert!(old.rows[3].unit_id.is_none());
    assert!(
        store
            .translation_preview(
                projected.envelope().attempt_id,
                1,
                1,
                Some(&before_update.basis)
            )
            .is_err()
    );
    let fresh_action = translation_action(
        &mut store,
        &projected,
        &before_update.rows[2],
        snapshot,
        TranslationSelectionDecision::CandidateOnly,
    );
    let error = store
        .adopt_execution(&fresh_action, &TranslationAdoptionHandler)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::DependencyConflict);
    assert_eq!(error.stage, "translation-source");
    let error = store
        .enqueue_read_only_execution(&old_source_projection)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::DependencyConflict);
    assert_eq!(error.stage, "translation-source");
    assert!(
        store
            .execution_input(old_source_projection.envelope().attempt_id)
            .is_err()
    );
    assert!(
        store
            .adoption_receipt(fresh_action.action_id)
            .unwrap()
            .is_none()
    );
    let error = store
        .capture_translation_projection(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::DependencyConflict);
    assert_eq!(error.stage, "translation-source");
    assert_eq!(history(&store, 0), candidate_history);
    assert_eq!(history(&store, 1), selected_history);
    assert_eq!(history(&store, 2).total, 0);

    // A freshly checked import bound to S2 can still be applied. The unchanged
    // selected entry remains a conflict and keeps its exact original selection.
    let mut current_material = material;
    current_material.import_id = ExecutionId::new().to_string();
    current_material.source_set_id = updated_bundle.set_id.to_string();
    current_material.source_snapshot_id = current_snapshot.to_string();
    let (_, _, current_projected) = checked_translation(
        &mut runtime,
        &mut store,
        &resource,
        &producer,
        &checker,
        current_material,
    );
    let current_preview = store
        .translation_preview(current_projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!(current_preview.source_changed, 0);
    assert_eq!(current_preview.rows[0].status, TranslationMatch::Unique);
    assert_eq!(
        current_preview.rows[1].status,
        TranslationMatch::SelectedConflict
    );
    assert_eq!(
        current_preview.rows[1].current_selection,
        selected_history.current
    );
    assert_eq!(current_preview.rows[2].status, TranslationMatch::Unique);
    assert_eq!(current_preview.rows[3].status, TranslationMatch::Unmatched);
    assert!(current_preview.rows[3].unit_id.is_none());
    let current_action = translation_action(
        &mut store,
        &current_projected,
        &current_preview.rows[2],
        current_snapshot,
        TranslationSelectionDecision::SelectIfEmpty,
    );
    let current_receipt = store
        .adopt_execution(&current_action, &TranslationAdoptionHandler)
        .unwrap();
    assert_eq!(current_receipt.changes.len(), 2);
    let current_history = history(&store, 2);
    assert_eq!(current_history.total, 1);
    assert_eq!(current_history.current_text.as_deref(), Some(""));
    assert_eq!(current_history.rows[0].source_snapshot_id, current_snapshot);
    assert_eq!(
        current_history.rows[0].result_id,
        Some(current_preview.rows[2].result_id)
    );
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    drop(store);
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.content_scope().unwrap().current_snapshot,
        Some(current_snapshot)
    );
    let saved_source = reopened.source_content(snapshot, 0, 100).unwrap();
    assert_eq!(saved_source.rows, source.rows);
    assert_eq!(saved_source.coverage, source.coverage);
    assert_eq!(saved_source.namespace, source.namespace);
    assert_eq!(saved_source.total, 4);
    assert_eq!(
        reopened.source_content(current_snapshot, 0, 100).unwrap(),
        updated_source
    );
    for (action, receipt) in [
        (&source_action, &source_receipt),
        (&updated_action, &updated_receipt),
    ] {
        assert_eq!(
            reopened
                .adopt_execution(action, &SourceAdoptionHandler)
                .unwrap(),
            *receipt
        );
    }
    for (action, receipt) in [
        (&candidate, &candidate_receipt),
        (&selected, &selected_receipt),
        (&current_action, &current_receipt),
    ] {
        assert_eq!(
            reopened
                .adopt_execution(action, &TranslationAdoptionHandler)
                .unwrap(),
            *receipt
        );
    }
    assert_eq!(history(&reopened, 0), candidate_history);
    assert_eq!(history(&reopened, 1), selected_history);
    assert_eq!(history(&reopened, 2), current_history);
    assert!(
        reopened
            .adopt_execution(&stale, &TranslationAdoptionHandler)
            .is_err()
    );
    assert!(
        reopened
            .adoption_receipt(stale.action_id)
            .unwrap()
            .is_none()
    );
    assert!(
        reopened
            .adoption_receipt(removed.action_id)
            .unwrap()
            .is_none()
    );
    assert!(
        reopened
            .adoption_receipt(fresh_action.action_id)
            .unwrap()
            .is_none()
    );
    let saved = reopened
        .execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(
        validate_plugin_translation_output(&input, &saved).unwrap(),
        proposal
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
        reopened
            .translation_preview(projected.envelope().attempt_id, 0, 100, None)
            .unwrap()
            .applied,
        2
    );
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
}

#[test]
fn webvtt_translation_preserves_captured_cues_and_uses_original_per_entry_adoption() {
    let selected = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_WEBVTT_PACKAGE")
            .expect("explicit prebuilt WebVTT package required"),
    );
    let digest = std::env::var("TSUMUGI_TEST_WEBVTT_DIGEST")
        .expect("independent WebVTT package fingerprint required");
    let image = PackageImage::capture_directory(&selected, &digest, || true).unwrap();
    let source_resource = image.source_import("source-profile").unwrap();
    let resource = image.translation_import("translation-profile").unwrap();
    assert_eq!(
        resource.declaration.profile,
        source_resource.declaration.profile
    );
    assert_eq!(
        resource.declaration.material.logical_directory,
        "translations"
    );
    assert_eq!(resource.declaration.material.extension, "vtt");
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
    let source_producer = proxy(source_resource.declaration.extractor.as_str());
    let source_checker = proxy(source_resource.declaration.checker.as_str());
    let producer = proxy(resource.declaration.extractor.as_str());
    let checker = proxy(resource.declaration.checker.as_str());
    let path = temporary.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("WebVTT existing translations", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&source_producer, &source_checker, &producer, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    runtime
        .register_read_only(Arc::new(TranslationProjectionRunner))
        .unwrap();
    let source_raw = "WEBVTT\n\nMiXA\n00:01.000 --> 00:02.000\nsame\n\nOther\n00:03.000 --> 00:04.000\nsame\n\nAbsent\n00:05.000 --> 00:06.000\nnot imported\n";
    let (bundle, source_input, source_result) = checked_source_materials(
        &mut runtime,
        &mut store,
        &source_resource,
        &source_producer,
        &source_checker,
        vec![source_raw.as_bytes().to_vec()],
    );
    let confirmation = store
        .source_preview(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
            0,
            100,
        )
        .unwrap()
        .confirmation;
    let source_action = store
        .prepare_adoption(
            source_input.envelope().attempt_id,
            source_input.envelope().units[0].unit_id,
            vec![source_result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&source_action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let before = store.source_content(snapshot, 0, 100).unwrap();
    let native = before.rows[0].occurrence.native_identity.as_ref().unwrap();
    // Import order, timings and line endings differ. Only canonical cue identity
    // pairs entries; the captured translation timeline never updates the source.
    let raw = "\u{feff}WEBVTT\r\n\r\nNOTE imported evidence 👩🏽‍💻\r\n\r\nOTHER\r\n00:10.000 --> 00:11.000\r\n另一条\r\n第二行\r\n\r\nmIxA\r\n00:20.000 --> 00:21.000\r\n译文 e\u{301} 👩🏽‍💻\r\n\r\nghost\r\n00:30.000 --> 00:31.000\r\nunmatched\r\n";
    let material = sdk::TranslationExtractionInput {
        profile: resource.declaration.profile.clone(),
        import_id: ExecutionId::new().to_string(),
        source_set_id: bundle.set_id.to_string(),
        source_snapshot_id: snapshot.to_string(),
        target_language: "zh-CN".into(),
        language_evidence: sdk::TranslationLanguageEvidence::UserConfirmed,
        native_scope: sdk::TranslationNativeScope {
            namespace: native.namespace.clone(),
            policy: native.policy.clone(),
        },
        artifacts: vec![sdk::CapturedTextArtifact {
            id: ExecutionId::new().to_string(),
            logical_path: "translations/zh.vtt".into(),
            role: "translation".into(),
            utf8: raw.into(),
            sha256: sdk::payload_digest(raw),
        }],
    };
    resource.validate_input(&material).unwrap();
    let (input, result, projected) = checked_translation(
        &mut runtime,
        &mut store,
        &resource,
        &producer,
        &checker,
        material.clone(),
    );
    let proposal = validate_plugin_translation_output(&input, &result).unwrap();
    assert_eq!(proposal.artifacts, material.artifacts);
    assert_eq!(proposal.declared_language, "zh");
    assert_eq!(proposal.target_language, "zh-CN");
    assert_eq!(proposal.entries[0].text, "另一条\n第二行");
    assert_eq!(proposal.entries[1].text, "译文 e\u{301} 👩🏽‍💻");
    let preview = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!(
        (preview.total, preview.unique, preview.unmatched),
        (3, 2, 1)
    );
    assert_eq!(preview.rows[2].status, TranslationMatch::Unmatched);
    let row = &preview.rows[1];
    assert_eq!(row.entry.native_key, "mIxA");
    assert_eq!(row.source_text.as_deref(), Some("same"));
    assert_ne!(row.unit_id, preview.rows[0].unit_id);
    assert_eq!(
        store
            .translation_history(project, row.unit_id.unwrap(), "zh-CN", 0, 10)
            .unwrap()
            .total,
        0
    );
    let candidate = translation_action(
        &mut store,
        &projected,
        row,
        snapshot,
        TranslationSelectionDecision::CandidateOnly,
    );
    let receipt = store
        .adopt_execution(&candidate, &TranslationAdoptionHandler)
        .unwrap();
    assert_eq!(receipt.changes.len(), 1);
    let history = store
        .translation_history(project, row.unit_id.unwrap(), "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(history.total, 1);
    assert!(history.current.is_none());
    assert_eq!(history.rows[0].text, "译文 e\u{301} 👩🏽‍💻");
    assert_eq!(history.rows[0].source_snapshot_id, snapshot);
    assert_eq!(history.rows[0].result_id, Some(row.result_id));
    let selected = translation_action(
        &mut store,
        &projected,
        &preview.rows[0],
        snapshot,
        TranslationSelectionDecision::SelectIfEmpty,
    );
    let selected_receipt = store
        .adopt_execution(&selected, &TranslationAdoptionHandler)
        .unwrap();
    assert_eq!(selected_receipt.changes.len(), 2);
    let selected_history = store
        .translation_history(project, preview.rows[0].unit_id.unwrap(), "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(
        selected_history.current_text.as_deref(),
        Some("另一条\n第二行")
    );
    assert_eq!(store.source_content(snapshot, 0, 100).unwrap(), before);
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    drop(store);
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_content(snapshot, 0, 100).unwrap(), before);
    assert_eq!(
        reopened
            .translation_history(project, row.unit_id.unwrap(), "zh-CN", 0, 10)
            .unwrap(),
        history
    );
    assert_eq!(
        reopened
            .translation_history(project, preview.rows[0].unit_id.unwrap(), "zh-CN", 0, 10)
            .unwrap(),
        selected_history
    );
    assert_eq!(
        reopened
            .adopt_execution(&candidate, &TranslationAdoptionHandler)
            .unwrap(),
        receipt
    );
    assert_eq!(
        reopened
            .adopt_execution(&selected, &TranslationAdoptionHandler)
            .unwrap(),
        selected_receipt
    );
    let saved = reopened
        .execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(
        validate_plugin_translation_output(&input, &saved).unwrap(),
        proposal
    );
    assert_eq!(
        reopened
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Valid
    );
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
}
