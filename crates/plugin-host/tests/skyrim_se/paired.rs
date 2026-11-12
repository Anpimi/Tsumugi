//! Real paired Native proposals enter the normal Core projection and mutations.
use super::*;
use tsumugi_core::{
    TranslationAdoptionConfirmation, TranslationAdoptionHandler, TranslationMatch,
    TranslationOrigin, TranslationPreviewRow, TranslationSelectionDecision,
    content::{
        PluginTranslationSettings, TranslationProjectionRunner, validate_plugin_translation_output,
    },
};

#[path = "paired/maintenance.rs"]
mod maintenance;

fn mcm(id: &str, module: &str, text: &str) -> sdk::CapturedArtifact {
    let bytes = [
        vec![0xff, 0xfe],
        text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
    ]
    .concat();
    sdk::CapturedArtifact::from_bytes(
        id.into(),
        format!("Interface/Translations/{module}_english.txt"),
        "mcm".into(),
        &bytes,
    )
    .unwrap()
}

fn fixed_capture(
    store: &ProjectStore,
    binding: &sdk::SourceImportBinding,
    extractor: &RunnerProxy,
    checker: &RunnerProxy,
    captured: &sdk::SourceExtractionInput,
) -> FixedInput {
    assert_eq!(captured.profile, binding.declaration.profile);
    let selections = binding
        .declaration
        .file_sets
        .as_ref()
        .unwrap()
        .iter()
        .map(|set| sdk::SourceFileSetSelection {
            id: set.id.clone(),
            logical_paths: captured
                .artifacts
                .iter()
                .filter(|file| file.role() == set.role)
                .map(|file| file.logical_path().into())
                .collect(),
        })
        .collect::<Vec<_>>();
    let bytes = captured
        .artifacts
        .iter()
        .map(|file| file.validated_bytes().unwrap().into_owned())
        .collect();
    let bundle =
        SourceBundle::capture_selected(binding, &selections, bytes, &captured.source_language)
            .unwrap();
    let producer = extractor
        .execution_binding(Some(binding.declaration.profile.clone()))
        .unwrap();
    let review = SourceReviewBinding::capture(
        &binding.review,
        &PluginExecutionBinding {
            component_scope: sdk::ComponentScope::Project,
            application_scope: None,
            capability: binding.review.checker.clone(),
            profile: Some(binding.review.declaration.profile.clone()),
            environment: producer.environment.clone(),
        },
    )
    .unwrap();
    bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            producer,
            SourceSettings {
                native_start: None,
                revision_policy: binding.declaration.revision_policy.clone(),
                checker: Some(
                    checker
                        .execution_binding(Some(binding.declaration.profile.clone()))
                        .unwrap(),
                ),
                semantic_rules: binding.declaration.semantic_rules.clone(),
                review: Some(review),
            },
        )
        .unwrap()
}

fn pair_input(
    store: &ProjectStore,
    resource: &sdk::TranslationImportBinding,
    producer: &RunnerProxy,
    checker: &RunnerProxy,
    namespace: &str,
    artifacts: Vec<sdk::CapturedArtifact>,
) -> FixedInput {
    let context = store.translation_source_context("zh-CN").unwrap();
    let material = sdk::TranslationExtractionInput {
        profile: context.profile.clone(),
        import_id: ExecutionId::new().to_string(),
        source_set_id: context.source_set_id.to_string(),
        source_snapshot_id: context.source_snapshot_id.to_string(),
        target_language: "zh-CN".into(),
        language_evidence: sdk::TranslationLanguageEvidence::UserConfirmed,
        native_scope: context
            .native_scopes
            .into_iter()
            .find(|scope| scope.namespace == namespace)
            .unwrap(),
        paired_source: Some(
            store
                .translation_pair_source("zh-CN", context.source_snapshot_id)
                .unwrap(),
        ),
        artifacts,
    };
    let profile = Some(context.profile);
    PluginTranslationSettings {
        declaration: resource.declaration.clone(),
        checker: checker.execution_binding(profile.clone()).unwrap(),
    }
    .fixed_input(
        store.metadata().unwrap().project_id(),
        material,
        producer.execution_binding(profile).unwrap(),
    )
    .unwrap()
}

fn checked_projection(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    input: &FixedInput,
) -> (FixedInput, sdk::TranslationExchange) {
    assert_eq!(
        runtime.submit(store, input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let grant = authorize(runtime, store, input);
    let result = execute(runtime, store, input);
    let proposal = validate_plugin_translation_output(input, &result).unwrap();
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Pending
    );
    assert!(
        store
            .capture_translation_projection(
                input.envelope().attempt_id,
                result.envelope().result_id
            )
            .is_err()
    );
    let capture = store
        .capture_translation_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check = capture.check_input().clone();
    assert_eq!(
        runtime.submit(store, &check).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let checker_grant = authorize(runtime, store, &check);
    assert_ne!(checker_grant, grant);
    let checked = execute(runtime, store, &check);
    store
        .commit_translation_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let projected = store
        .capture_translation_projection(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(projected.envelope().settings["version"], 2);
    assert!(projected.envelope().plugin.is_none());
    let results = core_execution::execute_all(runtime, store, &projected);
    assert_eq!(results.len(), proposal.entries.len());
    (projected, proposal)
}

fn translation_action(
    store: &mut ProjectStore,
    input: &FixedInput,
    snapshot: ExecutionId,
    row: &TranslationPreviewRow,
    decision: TranslationSelectionDecision,
) -> AdoptionAction {
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|unit| unit.item_ids == [row.item_id])
        .unwrap();
    translation_action_for_unit(store, input, snapshot, row, decision, unit.unit_id)
}

fn translation_action_for_unit(
    store: &mut ProjectStore,
    input: &FixedInput,
    snapshot: ExecutionId,
    row: &TranslationPreviewRow,
    decision: TranslationSelectionDecision,
    unit: ExecutionId,
) -> AdoptionAction {
    store
        .prepare_adoption(
            input.envelope().attempt_id,
            unit,
            vec![row.result_id],
            json!(TranslationAdoptionConfirmation {
                result_digest: row.result_digest.clone(),
                source_snapshot_id: snapshot,
                occurrence_id: row.occurrence_id.unwrap(),
                source_revision_id: row.source_revision_id.unwrap(),
                target_unit_id: row.unit_id.unwrap(),
                expected_selection_id: row
                    .current_selection
                    .as_ref()
                    .map(|selection| selection.event_id),
                decision,
            }),
        )
        .unwrap()
}

fn checked_source_result(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    input: &FixedInput,
) -> FixedResult {
    authorize(runtime, store, input);
    let result = execute(runtime, store, input);
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check = capture.check_input().clone();
    authorize(runtime, store, &check);
    let checked = execute(runtime, store, &check);
    store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
    result
}

#[test]
#[ignore = "requires an inspected Skyrim SE package and synthetic fixtures"]
fn skyrim_j2_repeated_capture_keeps_source_semantics_and_manual_work() {
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let environment = super::runtime();
    let source = image.source_import("source-profile").unwrap();
    let stage = root.path().join("workers");
    std::fs::create_dir(&stage).unwrap();
    let proxy = |id: &str| {
        Arc::new(
            RunnerProxy::new(
                image.clone(),
                id,
                environment.clone(),
                &stage,
                HostLimits::default(),
            )
            .unwrap(),
        )
    };
    let extractor = proxy(&source.declaration.extractor);
    let checker = proxy(&source.declaration.checker);
    let path = root.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Repeated Skyrim capture", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&extractor, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    let captured = fixture("coverage-shared", true, true);
    let first = fixed_capture(&store, &source, &extractor, &checker, &captured);
    let adopted = adopt_source(&mut store, &mut runtime, &first);
    let page = store.source_content(adopted.snapshot, 0, 100).unwrap();
    let row = page
        .rows
        .iter()
        .find(|row| row.occurrence.text == "Star {$BASE}")
        .unwrap();
    let unit = row.unit_id.unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: row.source_revision_id.unwrap(),
            expected_selection_id: None,
            text: "人工保留 {$BASE}".into(),
            reuse_origin: None,
        })
        .unwrap();
    let work = store.review_target(project, unit, "zh-CN").unwrap();
    let next = fixed_capture(&store, &source, &extractor, &checker, &captured);
    let next_bundle = SourceBundle::from_input(&next).unwrap();
    let first_bundle = SourceBundle::from_input(&first).unwrap();
    assert_ne!(
        first_bundle.files[0].artifact_id,
        next_bundle.files[0].artifact_id
    );
    assert!(
        first_bundle
            .files
            .iter()
            .zip(&next_bundle.files)
            .all(|(a, b)| a.bytes().unwrap() == b.bytes().unwrap())
    );
    let result = checked_source_result(&mut store, &mut runtime, &next);
    let comparison = store
        .source_comparison(
            next.envelope().attempt_id,
            result.envelope().result_id,
            0,
            100,
        )
        .unwrap();
    eprintln!(
        "repeated capture counts: unchanged={} moved={} changed={} added={} removed={} ambiguous={}",
        comparison.counts.unchanged,
        comparison.counts.moved,
        comparison.counts.changed,
        comparison.counts.added,
        comparison.counts.removed,
        comparison.counts.ambiguous
    );
    assert_eq!(
        comparison.counts.changed, 0,
        "fresh capture IDs cannot alter source semantics"
    );
    assert_eq!(comparison.counts.unchanged, 13);
    assert_eq!(
        (
            comparison.counts.moved,
            comparison.counts.added,
            comparison.counts.removed,
            comparison.counts.ambiguous
        ),
        (0, 0, 0, 0)
    );
    assert_eq!(
        store.content_scope().unwrap().current_snapshot,
        Some(adopted.snapshot)
    );
    assert_eq!(store.review_target(project, unit, "zh-CN").unwrap(), work);
    let mut shifted = captured.clone();
    shifted.artifacts[4] = mcm(
        "moved-mcm",
        "Example",
        "; only coordinates change\r\n$TITLE\tStar {$BASE}\r\n$KEEP\tOriginal\r\n",
    );
    let mut final_adoption = None;
    for (name, captured) in [
        ("coordinates", shifted),
        ("string-ids", fixture("coverage-renumbered", true, true)),
    ] {
        let input = fixed_capture(&store, &source, &extractor, &checker, &captured);
        let result = checked_source_result(&mut store, &mut runtime, &input);
        let comparison = store
            .source_comparison(
                input.envelope().attempt_id,
                result.envelope().result_id,
                0,
                100,
            )
            .unwrap();
        eprintln!(
            "{name}: unchanged={} moved={} changed={}",
            comparison.counts.unchanged, comparison.counts.moved, comparison.counts.changed
        );
        assert_eq!(comparison.counts.changed, 0, "{name} cannot change meaning");
        assert_eq!(comparison.counts.unchanged + comparison.counts.moved, 13);
        assert_eq!(
            (
                comparison.counts.added,
                comparison.counts.removed,
                comparison.counts.ambiguous
            ),
            (0, 0, 0)
        );
        assert_eq!(
            store.content_scope().unwrap().current_snapshot,
            Some(adopted.snapshot)
        );
        assert_eq!(store.review_target(project, unit, "zh-CN").unwrap(), work);
        final_adoption = Some((input, result, comparison.confirmation));
    }
    let (input, result, confirmation) = final_adoption.unwrap();
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            json!(confirmation),
        )
        .unwrap();
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap(),
        receipt
    );
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    assert_ne!(snapshot, adopted.snapshot);
    let current = store.source_content(snapshot, 0, 100).unwrap();
    for row in &current.rows {
        let identity = row.occurrence.native_identity.as_ref().unwrap();
        let previous = page
            .rows
            .iter()
            .find(|old| {
                old.occurrence
                    .native_identity
                    .as_ref()
                    .is_some_and(|value| {
                        value.namespace == identity.namespace
                            && value.policy == identity.policy
                            && value.value == identity.value
                    })
            })
            .unwrap();
        assert_eq!(
            (row.unit_id, row.source_revision_id),
            (previous.unit_id, previous.source_revision_id)
        );
    }
    let preserved = store.review_target(project, unit, "zh-CN").unwrap();
    assert_eq!(preserved.selection_id, work.selection_id);
    assert_eq!(preserved.revision_id, work.revision_id);
    assert_eq!(preserved.source_revision_id, work.source_revision_id);
    assert_eq!(preserved.translation_text, work.translation_text);
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_content(snapshot, 0, 100).unwrap(), current);
    let historical = reopened.source_content(adopted.snapshot, 0, 100).unwrap();
    assert_eq!(historical.snapshot_id, page.snapshot_id);
    assert_eq!(historical.rows, page.rows);
    assert_eq!(historical.coverage, page.coverage);
    assert_eq!(historical.capture_summary, page.capture_summary);
    assert_eq!(
        reopened.review_target(project, unit, "zh-CN").unwrap(),
        preserved
    );
    reopened.close().unwrap();
    assert_eq!(std::fs::read_dir(stage).unwrap().count(), 0);
}

#[test]
#[ignore = "requires an inspected paired Skyrim SE package and synthetic fixtures"]
fn skyrim_paired_core_keeps_multifile_candidates_and_manual_selection_on_reopen() {
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let environment = super::runtime();
    let source = image.source_import("source-profile").unwrap();
    let translations = image.translation_import("translation-profile").unwrap();
    assert!(translations.declaration.is_paired());
    let stage = root.path().join("workers");
    std::fs::create_dir(&stage).unwrap();
    let proxy = |id: &str| {
        Arc::new(
            RunnerProxy::new(
                image.clone(),
                id,
                environment.clone(),
                &stage,
                HostLimits::default(),
            )
            .unwrap(),
        )
    };
    let extractor = proxy(&source.declaration.extractor);
    let source_checker = proxy(&source.declaration.checker);
    let producer = proxy(&translations.declaration.extractor);
    let checker = proxy(&translations.declaration.checker);
    let path = root.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Paired Skyrim translations", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&extractor, &source_checker, &producer, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    runtime
        .register_read_only(Arc::new(TranslationProjectionRunner))
        .unwrap();
    let captured = fixture("coverage-shared", true, true);
    let source_input = fixed_capture(&store, &source, &extractor, &source_checker, &captured);
    let adopted = adopt_source(&mut store, &mut runtime, &source_input);
    let original_page = store.source_content(adopted.snapshot, 0, 100).unwrap();
    assert_eq!(original_page.total, 13);
    assert_eq!(original_page.coverage.len(), 5);
    assert_eq!(adopted.preview_summary.materials.len(), 2);
    assert_eq!(
        store
            .translation_source_context("zh-CN")
            .unwrap()
            .native_scopes
            .len(),
        2
    );
    let mut translated = fixture("coverage-stable-tables", true, false).artifacts;
    translated.push(mcm(
        "translated-mcm",
        "Example",
        "$TITLE\t星 {$BASE}\r\n$KEEP\t已有译文\r\n$NEW\t未匹配\r\n$EMPTY\t\r\n",
    ));
    translated.push(mcm("other-mod", "Other", "$TITLE\t另一个Mod\r\n"));
    let input = pair_input(
        &store,
        &translations,
        &producer,
        &checker,
        "skyrim-se:record-field",
        translated.clone(),
    );
    let (projected, proposal) = checked_projection(&mut store, &mut runtime, &input);
    assert_eq!(proposal.entries.len(), 10);
    assert_eq!(proposal.artifacts, translated);
    let preview = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!(
        (
            preview.total,
            preview.unique,
            preview.unmatched,
            preview.ambiguous
        ),
        (10, 10, 0, 0)
    );
    let files = preview.files.as_ref().unwrap();
    assert_eq!(files.len(), 6);
    for row in &preview.rows {
        let value_file = files
            .iter()
            .find(|file| file.artifact_id == row.entry.artifact_id)
            .unwrap();
        let label_file = files
            .iter()
            .find(|file| Some(file.artifact_id) == row.entry.key_artifact_id)
            .unwrap();
        assert_eq!(value_file.role, "strings");
        assert_eq!(label_file.logical_path, "FormatProbe.esp");
        assert_ne!(value_file.artifact_id, label_file.artifact_id);
    }
    let shared: Vec<_> = preview
        .rows
        .iter()
        .filter(|row| row.entry.text == "共享名称 — é")
        .collect();
    assert_eq!(shared.len(), 1);
    let shared = shared[0];
    let unit = shared.unit_id.unwrap();
    assert_eq!(
        original_page
            .rows
            .iter()
            .filter(|row| row.unit_id == Some(unit))
            .count(),
        2
    );
    let conflict = translation_action(
        &mut store,
        &projected,
        adopted.snapshot,
        shared,
        TranslationSelectionDecision::SelectIfEmpty,
    );
    let prepared = store
        .capture_execution_adoption(&conflict)
        .unwrap()
        .prepare(&TranslationAdoptionHandler)
        .unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: shared.source_revision_id.unwrap(),
            expected_selection_id: None,
            text: "较新的人工译文".into(),
            reuse_origin: None,
        })
        .unwrap();
    assert_eq!(
        store.commit_execution_adoption(prepared).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
    assert!(
        store
            .adoption_receipt(conflict.action_id)
            .unwrap()
            .is_none()
    );
    let current = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    let current_shared = current
        .rows
        .iter()
        .find(|row| row.item_id == shared.item_id)
        .unwrap();
    assert_eq!(current_shared.status, TranslationMatch::SelectedConflict);
    let candidate = translation_action(
        &mut store,
        &projected,
        adopted.snapshot,
        current_shared,
        TranslationSelectionDecision::CandidateOnly,
    );
    let receipt = store
        .adopt_execution(&candidate, &TranslationAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&candidate, &TranslationAdoptionHandler)
            .unwrap(),
        receipt
    );
    assert_eq!(
        store
            .review_target(project, unit, "zh-CN")
            .unwrap()
            .translation_text
            .as_deref(),
        Some("较新的人工译文")
    );
    let history = store
        .translation_history(project, unit, "zh-CN", 0, 100)
        .unwrap();
    assert_eq!(history.rows.len(), 2);
    let imported = history
        .rows
        .iter()
        .find(|row| row.origin_kind == TranslationOrigin::Import)
        .unwrap();
    assert_eq!(imported.text, "共享名称 — é");
    assert!(
        imported
            .logical_path
            .as_ref()
            .unwrap()
            .ends_with(".STRINGS")
    );
    assert_eq!(imported.artifact_id, Some(shared.entry.artifact_id));
    let review = store.review_history(project, unit, "zh-CN", 0, 50).unwrap();
    assert!(review.decisions.is_empty() && review.checks.is_empty());
    let mcm_input = pair_input(
        &store,
        &translations,
        &producer,
        &checker,
        "skyrim-se:mcm",
        translated,
    );
    let (mcm_projected, _) = checked_projection(&mut store, &mut runtime, &mcm_input);
    let mcm_preview = store
        .translation_preview(mcm_projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!(
        (mcm_preview.total, mcm_preview.unique, mcm_preview.unmatched),
        (5, 2, 3)
    );
    assert!(
        mcm_preview
            .rows
            .iter()
            .any(|row| row.entry.text.is_empty() && row.status == TranslationMatch::Unmatched)
    );
    let title = mcm_preview
        .rows
        .iter()
        .find(|row| row.entry.text == "星 {$BASE}")
        .unwrap();
    let selected = translation_action(
        &mut store,
        &mcm_projected,
        adopted.snapshot,
        title,
        TranslationSelectionDecision::SelectIfEmpty,
    );
    let selected_receipt = store
        .adopt_execution(&selected, &TranslationAdoptionHandler)
        .unwrap();
    let title_unit = title.unit_id.unwrap();
    assert_eq!(
        store
            .review_target(project, title_unit, "zh-CN")
            .unwrap()
            .translation_text
            .as_deref(),
        Some("星 {$BASE}")
    );
    let review = store
        .review_history(project, title_unit, "zh-CN", 0, 50)
        .unwrap();
    assert!(review.decisions.is_empty() && review.checks.is_empty());
    let saved_preview = store
        .translation_preview(mcm_projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.source_content(adopted.snapshot, 0, 100).unwrap(),
        original_page
    );
    assert_eq!(
        reopened
            .translation_history(project, unit, "zh-CN", 0, 100)
            .unwrap(),
        history
    );
    assert_eq!(
        reopened
            .translation_preview(mcm_projected.envelope().attempt_id, 0, 100, None)
            .unwrap(),
        saved_preview
    );
    assert_eq!(
        reopened
            .adopt_execution(&selected, &TranslationAdoptionHandler)
            .unwrap(),
        selected_receipt
    );
    reopened.close().unwrap();
    assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
}

#[test]
#[ignore = "requires an inspected paired Skyrim SE package and explicit --capacity-large fixtures"]
fn skyrim_large_paired_projection_preserves_selection_scope_across_source_updates() {
    use std::{collections::BTreeMap, time::Instant};
    use tsumugi_core::content::{LineageChoice, LineageDecision, SourceChangeKind};

    const FIELDS: u32 = 50_000;
    const CHANGED: usize = 32;
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let environment = super::runtime();
    let source = image.source_import("source-profile").unwrap();
    let translations = image.translation_import("translation-profile").unwrap();
    assert!(translations.declaration.is_paired());
    let stage = root.path().join("workers");
    std::fs::create_dir(&stage).unwrap();
    let proxy = |id: &str| {
        Arc::new(
            RunnerProxy::new(
                image.clone(), id, environment.clone(), &stage, HostLimits::default(),
            ).unwrap(),
        )
    };
    let extractor = proxy(&source.declaration.extractor);
    let source_checker = proxy(&source.declaration.checker);
    let producer = proxy(&translations.declaration.extractor);
    let checker = proxy(&translations.declaration.checker);
    let path = root.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Large paired Skyrim translations", "en-US", ["zh-CN"]).unwrap(),
    ).unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&extractor, &source_checker, &producer, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    runtime.register_read_only(Arc::new(TranslationProjectionRunner)).unwrap();

    let started = Instant::now();
    let captured = fixture("capacity-large-source", false, false);
    assert!(captured.artifacts[0].validated_bytes().unwrap().len() >= 64 * 1024 * 1024);
    let source_input = fixed_capture(&store, &source, &extractor, &source_checker, &captured);
    let AdoptedSource { snapshot, preview_total, .. } = adopt_source(&mut store, &mut runtime, &source_input);
    assert_eq!(preview_total, FIELDS);
    drop(source_input);
    drop(captured);
    eprintln!("large paired S1 source adopted: {FIELDS} fields in {:?}", started.elapsed());

    let translated = fixture("capacity-large-translated", false, false).artifacts;
    let translated_bytes = translated[0].validated_bytes().unwrap().len();
    assert!(translated_bytes >= 64 * 1024 * 1024);
    let input = pair_input(
        &store, &translations, &producer, &checker, "skyrim-se:record-field", translated,
    );
    let started = Instant::now();
    let (projected, proposal) = checked_projection(&mut store, &mut runtime, &input);
    assert_eq!(proposal.entries.len(), FIELDS as usize);
    assert_eq!(proposal.order.len(), FIELDS as usize);
    assert_eq!(projected.envelope().items.len(), FIELDS as usize);
    assert!(proposal.entries.iter().all(|entry| entry.text.starts_with("Translated ")));
    drop(proposal);
    drop(input);
    eprintln!("large paired extraction, independent check and {FIELDS} Core projections completed in {:?}", started.elapsed());

    let units: BTreeMap<_, _> = projected.envelope().units.iter().map(|unit| {
        assert_eq!(unit.item_ids.len(), 1);
        (unit.item_ids[0], unit.unit_id)
    }).collect();
    assert_eq!(units.len(), FIELDS as usize);
    let attempt = projected.envelope().attempt_id;
    let mut preview = store.translation_preview(attempt, 0, 100, None).unwrap();
    assert_eq!((preview.total, preview.unique, preview.unmatched, preview.ambiguous), (FIELDS, FIELDS, 0, 0));
    assert_eq!(preview.files.as_ref().unwrap().len(), 1);
    assert_eq!(preview.files.as_ref().unwrap()[0].byte_length as usize, translated_bytes);
    let basis = preview.basis.clone();
    let last = store.translation_preview(attempt, FIELDS - 1, 1, Some(&basis)).unwrap();
    assert_eq!(last.rows[0].entry.ordinal, FIELDS - 1);
    assert_eq!(last.rows[0].status, TranslationMatch::Unique);
    assert!(last.next_ordinal.is_none());

    // Every entry was projected through the runtime. Adoption deliberately
    // exercises the complete changed scope plus stable and pending boundaries;
    // it is not a claim that 50,000 individual adoption transactions ran.
    let mut affected = BTreeMap::new();
    let mut stable = None;
    let mut pending = None;
    loop {
        for row in &preview.rows {
            assert_eq!(row.status, TranslationMatch::Unique);
            let book: usize = row.source_text.as_ref().unwrap()
                .strip_prefix("Chapter ").unwrap().split_whitespace().next().unwrap().parse().unwrap();
            if book < 16 {
                assert!(affected.insert(row.unit_id.unwrap(), row.clone()).is_none());
            } else if book == 16 && stable.is_none() {
                stable = Some(row.clone());
            } else if book == 17 && pending.is_none() {
                pending = Some(row.clone());
            }
        }
        if affected.len() == CHANGED && stable.is_some() && pending.is_some() {
            break;
        }
        let next = preview.next_ordinal.expect("the declared capacity adoption scope is missing");
        preview = store.translation_preview(attempt, next, 100, Some(&basis)).unwrap();
    }
    let stable = stable.unwrap();
    let pending = pending.unwrap();
    let mut selected = BTreeMap::new();
    for row in affected.values().chain(std::iter::once(&stable)) {
        let action = translation_action_for_unit(
            &mut store, &projected, snapshot, row, TranslationSelectionDecision::SelectIfEmpty,
            units[&row.item_id],
        );
        store.adopt_execution(&action, &TranslationAdoptionHandler).unwrap();
        let target = store.review_target(project, row.unit_id.unwrap(), "zh-CN").unwrap();
        assert_eq!(target.translation_text.as_deref(), Some(row.entry.text.as_str()));
        assert_eq!(target.source_revision_id, row.source_revision_id.unwrap());
        assert!(target.current_check.is_none() && target.current_decision.is_none());
        selected.insert(target.unit_id, target);
    }
    assert_eq!(selected.len(), CHANGED + 1);
    let pending_action = translation_action_for_unit(
        &mut store, &projected, snapshot, &pending, TranslationSelectionDecision::SelectIfEmpty,
        units[&pending.item_id],
    );
    let prepared = store.capture_execution_adoption(&pending_action).unwrap()
        .prepare(&TranslationAdoptionHandler).unwrap();

    let updated = fixture("capacity-large-updated", false, false);
    let input = fixed_capture(&store, &source, &extractor, &source_checker, &updated);
    let result = checked_source_result(&mut store, &mut runtime, &input);
    let mut comparison = store.source_comparison_filtered(
        input.envelope().attempt_id, result.envelope().result_id, None, "Updated", 0, 100,
    ).unwrap();
    assert_eq!(comparison.previous_snapshot_id, snapshot);
    assert_eq!(comparison.total, FIELDS);
    assert_eq!(comparison.filtered_total, CHANGED as u32);
    assert_eq!(comparison.counts.changed, CHANGED as u32);
    assert_eq!(comparison.counts.unchanged + comparison.counts.moved, FIELDS - CHANGED as u32);
    assert_eq!((comparison.counts.added, comparison.counts.removed, comparison.counts.rename_candidate, comparison.counts.ambiguous), (0, 0, 0, 0));
    assert_eq!(comparison.mapping_review_required, CHANGED as u32);
    let mut confirmation = comparison.confirmation.clone();
    confirmation.actor = Some("Synthetic maintainer".into());
    loop {
        for change in &comparison.rows {
            assert_eq!(change.kind, SourceChangeKind::Changed);
            let old = change.old.as_ref().unwrap();
            assert!(affected.contains_key(&old.unit_id.unwrap()));
            confirmation.lineage.push(LineageChoice {
                new_ordinal: change.new.as_ref().unwrap().ordinal,
                old_occurrence_id: old.occurrence_id.unwrap(),
                decision: LineageDecision::Continue,
                reason: "The synthetic update oracle preserves this native BOOK field".into(),
            });
        }
        let Some(next) = comparison.next_ordinal else { break; };
        comparison = store.source_comparison_filtered(
            input.envelope().attempt_id, result.envelope().result_id, None, "Updated", next, 100,
        ).unwrap();
    }
    assert_eq!(confirmation.lineage.len(), CHANGED);
    assert_eq!(store.content_scope().unwrap().current_snapshot, Some(snapshot));
    let action = store.prepare_adoption(
        input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![result.envelope().result_id], json!(confirmation),
    ).unwrap();
    store.adopt_execution(&action, &SourceAdoptionHandler).unwrap();
    let next_snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    assert_ne!(next_snapshot, snapshot);

    assert_eq!(store.commit_execution_adoption(prepared).unwrap_err().code, ErrorCode::DependencyConflict);
    assert!(store.adoption_receipt(pending_action.action_id).unwrap().is_none());
    assert!(store.review_target(project, pending.unit_id.unwrap(), "zh-CN").unwrap().selection_id.is_none());
    let mut retained = BTreeMap::new();
    for (unit, before) in &selected {
        let current = store.review_target(project, *unit, "zh-CN").unwrap();
        assert_eq!(current.source_snapshot_id, next_snapshot);
        assert_eq!((current.selection_id, current.revision_id), (before.selection_id, before.revision_id));
        assert_eq!(current.translation_text, before.translation_text);
        if affected.contains_key(unit) {
            assert_ne!(current.source_revision_id, before.source_revision_id);
            assert!(current.source_text.starts_with("Updated "));
            let saved = store.translation_revision(project, *unit, "zh-CN", before.revision_id.unwrap()).unwrap();
            assert_eq!(saved.source_snapshot_id, snapshot);
            assert_eq!(saved.source_revision_id, before.source_revision_id);
            let error = store.save_translation_revision(&SaveTranslationRevision {
                project_id: project, action_id: ExecutionId::new(), unit_id: *unit,
                locale: "zh-CN".into(), source_revision_id: before.source_revision_id,
                expected_selection_id: before.selection_id,
                text: before.translation_text.clone().unwrap(), reuse_origin: None,
            }).unwrap_err();
            assert_eq!((error.code, error.stage.as_str()), (ErrorCode::DependencyConflict, "translation-source"));
        } else {
            assert_eq!(current.source_revision_id, before.source_revision_id);
            assert_eq!(current.source_text, before.source_text);
        }
        assert!(current.current_check.is_none() && current.current_decision.is_none());
        retained.insert(*unit, current);
    }
    let stale = store.translation_preview(attempt, 0, 100, None).unwrap();
    assert_eq!((stale.total, stale.source_changed, stale.applied), (FIELDS, FIELDS, CHANGED as u32 + 1));
    let pending_page = store.translation_preview(attempt, pending.entry.ordinal, 1, Some(&stale.basis)).unwrap();
    assert_eq!(pending_page.rows[0].status, TranslationMatch::SourceChanged);
    assert!(pending_page.rows[0].current_selection.is_none());

    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.content_scope().unwrap().current_snapshot, Some(next_snapshot));
    for (unit, expected) in retained {
        assert_eq!(reopened.review_target(project, unit, "zh-CN").unwrap(), expected);
    }
    assert!(reopened.adoption_receipt(pending_action.action_id).unwrap().is_none());
    reopened.close().unwrap();
    assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    eprintln!("large paired Core boundary: {FIELDS} checked projections, 33 selected imports, 32 stale source writes and one pending adoption rejected");
}
