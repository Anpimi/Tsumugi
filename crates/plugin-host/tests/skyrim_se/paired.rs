//! Real paired Native proposals enter the normal Core projection and mutations.
use super::*;
use tsumugi_core::{
    TranslationAdoptionConfirmation, TranslationAdoptionHandler, TranslationMatch,
    TranslationOrigin, TranslationPreviewRow, TranslationSelectionDecision,
    content::{
        PluginTranslationSettings, TranslationProjectionRunner, validate_plugin_translation_output,
    },
};

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
    store
        .prepare_adoption(
            input.envelope().attempt_id,
            unit.unit_id,
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
