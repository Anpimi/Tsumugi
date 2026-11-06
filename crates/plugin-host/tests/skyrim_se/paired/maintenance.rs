//! Two-version maintenance uses the installed package and the normal Core owners.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use tsumugi_core::content::{
    ContentPage, ContentRow, CorrectSourceLineage, LineageChoice, LineageDecision,
    SourceChangeKind, SourceLineageCorrectionDecision,
};

const S1: &str = "$STABLE\tStable {$BASE}\r\n$EDITED\tOld item\r\n$REMOVE\tGone\r\n$SAME_A\tOpen\r\n$SAME_B\tOpen\r\n";
const S2: &str = "$STABLE\tStable {$BASE}\r\n$EDITED\tNew item\r\n$ADDED\tBrand new\r\n$RENAME_A\tOpen\r\n$RENAME_B\tOpen\r\n";
const TRANSLATED: &str = "$STABLE\t稳定 {$BASE}\r\n$EDITED\t旧条目\r\n$REMOVE\t已删除条目\r\n$SAME_A\t打开甲\r\n$SAME_B\t打开乙\r\n";

fn row<'a>(page: &'a ContentPage, text: &str) -> &'a ContentRow {
    let rows: Vec<_> = page
        .rows
        .iter()
        .filter(|row| row.occurrence.text == text)
        .collect();
    assert_eq!(rows.len(), 1, "unique fixture text: {text}");
    rows[0]
}

fn manual(store: &mut ProjectStore, project: ExecutionId, unit: ExecutionId, text: &str) {
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id,
            text: text.into(),
            reuse_origin: None,
        })
        .unwrap();
}

fn qa(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    project: ExecutionId,
    unit: ExecutionId,
) {
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let prepared = store
        .prepare_review_check(
            project,
            unit,
            "zh-CN",
            &target.basis,
            ExecutionId::new(),
            &[],
        )
        .unwrap();
    let plan = prepared.plan().unwrap();
    let mut origins = Vec::new();
    for (input, checker) in prepared.execution_inputs().iter().zip(plan.checkers()) {
        prepared.validate_execution_input(input).unwrap();
        authorize(runtime, store, input);
        let result = execute(runtime, store, input);
        origins.push(tsumugi_core::ReviewCheckOrigin {
            checker: checker.key.clone(),
            attempt_id: input.envelope().attempt_id,
            result_id: result.envelope().result_id,
        });
    }
    assert_eq!(origins.len(), plan.checkers().len());
    assert!(!origins.is_empty());
    let computed = store
        .capture_review_check_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert!(computed.coverage().complete);
    assert!(
        computed
            .core_rules()
            .iter()
            .all(|rule| rule.findings.is_empty())
    );
    assert!(computed.results().iter().all(|result| matches!(&result.outcome, sdk::CheckOutcome::Completed { findings } if findings.is_empty())));
    store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
}

fn approve(store: &mut ProjectStore, project: ExecutionId, unit: ExecutionId) {
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    assert!(target.current_check.is_some());
    assert!(target.current_decision.is_none());
    store
        .write_review(&ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            expected_decision_id: None,
            actor: "Synthetic maintainer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: "Approve this exact checked translation for the captured version".into(),
        })
        .unwrap();
}

fn stage_release(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    project: ExecutionId,
    captured: &sdk::SourceExtractionInput,
    selected: &[ExecutionId],
    environment: &ReleaseBuildEnvironment,
    binding: &sdk::BuildBinding,
) -> tsumugi_core::ReleaseView {
    let scopes = BTreeMap::from([("zh-CN".into(), selected.to_vec())]);
    let eligibility = store
        .review_eligibility_for_build(
            project,
            &["zh-CN".into()],
            &scopes,
            &Cancellation::default(),
        )
        .unwrap();
    assert!(
        eligibility.ready,
        "stage qualification: {:?}",
        eligibility.locales
    );
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &[PluginBuildLocaleChoice {
                translation_units: Some(selected.to_vec()),
                locale: "zh-CN".into(),
                output_paths: captured
                    .artifacts
                    .iter()
                    .map(|artifact| artifact.logical_path().into())
                    .collect(),
                configuration: configuration(binding),
            }],
            &eligibility.basis,
            environment,
        )
        .unwrap();
    authorize(runtime, store, &input);
    let built = execute(runtime, store, &input);
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![built.envelope().result_id],
            json!({}),
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .is_err(),
        "the builder cannot validate its own artifact"
    );
    let capture = store
        .capture_artifact_validation(input.envelope().attempt_id, built.envelope().result_id)
        .unwrap();
    let check = capture.check_input().clone();
    authorize(runtime, store, &check);
    let checked = execute(runtime, store, &check);
    store
        .commit_artifact_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
        receipt
    );
    let release = store
        .release_view(ExecutionId::parse(&receipt.changes[0].id).unwrap())
        .unwrap();
    assert_eq!(
        release.source_snapshot_id,
        store.content_scope().unwrap().current_snapshot.unwrap()
    );
    assert_eq!(release.exceptions.iter().filter(|exception| exception.kind == tsumugi_core::ReleaseExceptionKind::SourceRetained).count(), eligibility.locales[0].retained_source_units as usize);
    release
}

fn release_bytes(
    store: &ProjectStore,
    release: &tsumugi_core::ReleaseView,
) -> BTreeMap<String, Vec<u8>> {
    release
        .artifacts
        .iter()
        .map(|artifact| {
            (
                artifact.file_name.clone(),
                store
                    .release_artifact_by_path(release.release_id, "zh-CN", &artifact.file_name)
                    .unwrap()
                    .1,
            )
        })
        .collect()
}

fn read_back(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    release: &tsumugi_core::ReleaseView,
    captured: &sdk::SourceExtractionInput,
    page: &ContentPage,
    selected: &[ExecutionId],
    source: &sdk::SourceImportBinding,
    extractor: &RunnerProxy,
    checker: &RunnerProxy,
) {
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let expected: BTreeMap<_, _> = page
        .rows
        .iter()
        .map(|row| {
            let text = if selected.contains(&row.unit_id.unwrap()) {
                store
                    .review_target(project, row.unit_id.unwrap(), "zh-CN")
                    .unwrap()
                    .translation_text
                    .unwrap()
            } else {
                row.occurrence.text.clone()
            };
            (
                row.occurrence
                    .native_identity
                    .as_ref()
                    .unwrap()
                    .value
                    .clone(),
                text,
            )
        })
        .collect();
    let mut output = captured.clone();
    output.artifacts = captured
        .artifacts
        .iter()
        .enumerate()
        .map(|(index, artifact)| {
            sdk::CapturedArtifact::from_bytes(
                format!("release-readback-{index}"),
                artifact.logical_path().into(),
                artifact.role().into(),
                &store
                    .release_artifact_by_path(release.release_id, "zh-CN", artifact.logical_path())
                    .unwrap()
                    .1,
            )
            .unwrap()
        })
        .collect();
    let input = fixed_capture(store, source, extractor, checker, &output);
    let result = checked_source_result(store, runtime, &input);
    let parsed = store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            100,
        )
        .unwrap();
    let actual: BTreeMap<_, _> = parsed
        .rows
        .iter()
        .map(|row| {
            (
                row.occurrence
                    .native_identity
                    .as_ref()
                    .unwrap()
                    .value
                    .clone(),
                row.occurrence.text.clone(),
            )
        })
        .collect();
    assert_eq!(
        actual, expected,
        "all native fields and MCM keys reopen with the chosen translations or exact retained source"
    );
    assert_eq!(parsed.total, page.total);
    assert_eq!(
        store.content_scope().unwrap().current_snapshot,
        page.snapshot_id,
        "readback is not source adoption"
    );
}

#[test]
#[ignore = "requires an inspected Skyrim SE package and synthetic fixtures"]
fn skyrim_j2_two_versions_preserve_work_review_ambiguity_and_both_releases() {
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let native = super::super::runtime();
    let source = image.source_import("source-profile").unwrap();
    let translations = image.translation_import("translation-profile").unwrap();
    let build = image.build_declaration("build-profile").unwrap();
    let stage = root.path().join("workers");
    std::fs::create_dir(&stage).unwrap();
    let proxy = |id: &str| {
        Arc::new(
            RunnerProxy::new(
                image.clone(),
                id,
                native.clone(),
                &stage,
                HostLimits::default(),
            )
            .unwrap(),
        )
    };
    let extractor = proxy(&source.declaration.extractor);
    let source_checker = proxy(&source.declaration.checker);
    let producer = proxy(&translations.declaration.extractor);
    let translation_checker = proxy(&translations.declaration.checker);
    let review_checker = proxy(&source.review.declaration.checker);
    let builder = proxy(&build.declaration.builder);
    let artifact_checker = proxy(&build.declaration.checker);
    let path = root.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Two-version Skyrim maintenance", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [
        &extractor,
        &source_checker,
        &producer,
        &translation_checker,
        &review_checker,
        &builder,
        &artifact_checker,
    ] {
        runtime.register(runner.clone()).unwrap();
    }
    runtime
        .register_read_only(Arc::new(TranslationProjectionRunner))
        .unwrap();
    let build_environment = ReleaseBuildEnvironment::new(
        build.clone(),
        builder
            .execution_binding(Some(build.declaration.profile.clone()))
            .unwrap(),
        artifact_checker
            .execution_binding(Some(build.declaration.profile.clone()))
            .unwrap(),
    )
    .unwrap();

    let mut s1 = fixture("coverage-shared", true, true);
    s1.artifacts[4] = mcm("maintenance-s1", "Example", S1);
    let input = fixed_capture(&store, &source, &extractor, &source_checker, &s1);
    let adopted = adopt_source(&mut store, &mut runtime, &input);
    let first = store.source_content(adopted.snapshot, 0, 100).unwrap();
    assert_eq!(first.total, 16);
    let mut translated = fixture("coverage-stable-tables", true, true).artifacts;
    translated[4] = mcm("maintenance-translated", "Example", TRANSLATED);
    let mut imports = Vec::new();
    let mut shared = None;
    for namespace in ["skyrim-se:record-field", "skyrim-se:mcm"] {
        let input = pair_input(
            &store,
            &translations,
            &producer,
            &translation_checker,
            namespace,
            translated.clone(),
        );
        let (projected, _) = checked_projection(&mut store, &mut runtime, &input);
        let preview = store
            .translation_preview(projected.envelope().attempt_id, 0, 100, None)
            .unwrap();
        assert_eq!(preview.unmatched, 0);
        for row in &preview.rows {
            if namespace == "skyrim-se:record-field" && row.entry.text != "共享名称 — é" {
                continue;
            }
            assert_eq!(row.status, TranslationMatch::Unique);
            let action = translation_action(
                &mut store,
                &projected,
                adopted.snapshot,
                row,
                TranslationSelectionDecision::SelectIfEmpty,
            );
            let receipt = store
                .adopt_execution(&action, &TranslationAdoptionHandler)
                .unwrap();
            assert_eq!(
                store
                    .adopt_execution(&action, &TranslationAdoptionHandler)
                    .unwrap(),
                receipt
            );
            if namespace == "skyrim-se:record-field" {
                shared = row.unit_id;
            }
            let history = store
                .review_history(project, row.unit_id.unwrap(), "zh-CN", 0, 50)
                .unwrap();
            assert!(
                history.decisions.is_empty() && history.checks.is_empty(),
                "import is not QA or approval"
            );
            imports.push((action, receipt));
        }
    }
    assert_eq!(imports.len(), 6);
    let shared = shared.unwrap();
    assert_eq!(
        first
            .rows
            .iter()
            .filter(|row| row.unit_id == Some(shared))
            .count(),
        2
    );
    let stable = row(&first, "Stable {$BASE}").unit_id.unwrap();
    let edited = row(&first, "Old item").unit_id.unwrap();
    let removed = row(&first, "Gone").unit_id.unwrap();
    manual(&mut store, project, stable, "人工稳定 {$BASE}");
    let scope1 = [shared, stable, edited, removed];
    for unit in scope1 {
        qa(&mut store, &mut runtime, project, unit);
        approve(&mut store, project, unit);
    }
    let stable_before = store.review_target(project, stable, "zh-CN").unwrap();
    let shared_before = store.review_target(project, shared, "zh-CN").unwrap();
    let edited_before = store.review_target(project, edited, "zh-CN").unwrap();
    let removed_history = store
        .translation_history(project, removed, "zh-CN", 0, 100)
        .unwrap();
    let removed_review = store
        .review_history(project, removed, "zh-CN", 0, 50)
        .unwrap();
    let release1 = stage_release(
        &mut store,
        &mut runtime,
        project,
        &s1,
        &scope1,
        &build_environment,
        &build,
    );
    let bytes1 = release_bytes(&store, &release1);
    read_back(
        &mut store,
        &mut runtime,
        &release1,
        &s1,
        &first,
        &scope1,
        &source,
        &extractor,
        &source_checker,
    );
    eprintln!("S1: imported/manual work approved, Native release checked and read back");

    let mut s2 = fixture("coverage-renumbered", true, true);
    s2.artifacts[4] = mcm("maintenance-s2", "Example", S2);
    let input = fixed_capture(&store, &source, &extractor, &source_checker, &s2);
    let result = checked_source_result(&mut store, &mut runtime, &input);
    let comparison = store
        .source_comparison(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            100,
        )
        .unwrap();
    assert_eq!(comparison.previous_snapshot_id, adopted.snapshot);
    assert_eq!(comparison.counts.changed, 1);
    assert_eq!(comparison.counts.added, 1);
    assert_eq!(comparison.counts.ambiguous, 2);
    assert_eq!(comparison.counts.unchanged + comparison.counts.moved, 12);
    assert_eq!(comparison.counts.rename_candidate, 0);
    assert_eq!(comparison.counts.removed, 3);
    assert_eq!(comparison.mapping_review_required, 3);
    let changed = comparison
        .rows
        .iter()
        .find(|change| {
            change
                .new
                .as_ref()
                .is_some_and(|new| new.text == "New item")
        })
        .unwrap();
    assert_eq!(changed.kind, SourceChangeKind::Changed);
    assert_eq!(changed.old.as_ref().unwrap().unit_id, Some(edited));
    let added = comparison
        .rows
        .iter()
        .find(|change| {
            change
                .new
                .as_ref()
                .is_some_and(|new| new.text == "Brand new")
        })
        .unwrap();
    assert_eq!(added.kind, SourceChangeKind::Added);
    assert!(comparison.rows.iter().any(|change| {
        change.kind == SourceChangeKind::Removed
            && change
                .old
                .as_ref()
                .is_some_and(|old| old.unit_id == Some(removed))
    }));
    let old_open: BTreeSet<_> = first
        .rows
        .iter()
        .filter(|row| row.occurrence.text == "Open")
        .map(|row| row.occurrence_id.unwrap())
        .collect();
    assert_eq!(old_open.len(), 2);
    for ambiguous in comparison
        .rows
        .iter()
        .filter(|change| change.kind == SourceChangeKind::Ambiguous)
    {
        assert_eq!(ambiguous.new.as_ref().unwrap().text, "Open");
        assert_eq!(
            ambiguous
                .candidates
                .iter()
                .map(|row| row.occurrence_id.unwrap())
                .collect::<BTreeSet<_>>(),
            old_open
        );
    }
    assert_eq!(
        store.content_scope().unwrap().current_snapshot,
        Some(adopted.snapshot)
    );
    assert_eq!(
        store.review_target(project, stable, "zh-CN").unwrap(),
        stable_before
    );
    let mut confirmation = comparison.confirmation.clone();
    confirmation.actor = Some("Synthetic maintainer".into());
    confirmation.lineage.push(LineageChoice {
        new_ordinal: changed.new.as_ref().unwrap().ordinal,
        old_occurrence_id: row(&first, "Old item").occurrence_id.unwrap(),
        decision: LineageDecision::Continue,
        reason: "Reviewed the changed label against the same native MCM key".into(),
    });
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
    let second = store.source_content(snapshot, 0, 100).unwrap();
    assert_eq!(second.total, 16);
    for current in second
        .rows
        .iter()
        .filter(|row| row.occurrence.namespace == "skyrim-se:record-field")
    {
        let previous = first
            .rows
            .iter()
            .find(|old| old.occurrence.native_identity == current.occurrence.native_identity)
            .unwrap();
        assert_eq!(
            (current.unit_id, current.source_revision_id),
            (previous.unit_id, previous.source_revision_id)
        );
    }
    for (unit, before) in [(stable, &stable_before), (shared, &shared_before)] {
        let current = store.review_target(project, unit, "zh-CN").unwrap();
        assert_eq!(current.selection_id, before.selection_id);
        assert_eq!(current.revision_id, before.revision_id);
        assert_eq!(current.source_revision_id, before.source_revision_id);
        assert_eq!(current.translation_text, before.translation_text);
        assert_eq!(current.basis, before.basis);
        assert_eq!(current.current_decision, before.current_decision);
        assert!(
            current.current_check.is_none(),
            "S1 file QA does not qualify S2"
        );
    }
    let edited_after = store.review_target(project, edited, "zh-CN").unwrap();
    assert_eq!(row(&second, "New item").unit_id, Some(edited));
    assert_ne!(
        edited_after.source_revision_id,
        edited_before.source_revision_id
    );
    assert_eq!(edited_after.selection_id, edited_before.selection_id);
    assert_eq!(
        edited_after.translation_text,
        edited_before.translation_text
    );
    assert!(edited_after.current_check.is_none() && edited_after.current_decision.is_none());
    let old_units: BTreeSet<_> = first.rows.iter().map(|row| row.unit_id.unwrap()).collect();
    for current in second
        .rows
        .iter()
        .filter(|row| row.occurrence.text == "Open" || row.occurrence.text == "Brand new")
    {
        let unit = current.unit_id.unwrap();
        assert!(!old_units.contains(&unit));
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        assert!(
            target.selection_id.is_none()
                && target.translation_text.is_none()
                && target.current_check.is_none()
                && target.current_decision.is_none()
        );
    }
    assert_eq!(
        store
            .translation_history(project, removed, "zh-CN", 0, 100)
            .unwrap(),
        removed_history
    );
    assert_eq!(
        store
            .review_history(project, removed, "zh-CN", 0, 50)
            .unwrap(),
        removed_review
    );
    let impact = store.source_impact(snapshot, "zh-CN", 0, 100).unwrap();
    for current in second
        .rows
        .iter()
        .filter(|row| row.occurrence.text == "Open")
    {
        let entry = impact
            .rows
            .iter()
            .find(|entry| entry.current.occurrence_id == current.occurrence_id)
            .unwrap();
        assert_eq!(
            entry.status,
            tsumugi_core::content::SourceImpactStatus::Unresolved
        );
        assert_eq!(
            entry
                .lineage
                .iter()
                .map(|edge| edge.old.occurrence_id.unwrap())
                .collect::<BTreeSet<_>>(),
            old_open
        );
        assert!(
            entry
                .lineage
                .iter()
                .all(|edge| edge.applied_relation.is_none())
        );
    }
    let added = row(&second, "Brand new").unit_id.unwrap();
    let scope2 = [shared, stable, edited, added];
    let scopes = BTreeMap::from([("zh-CN".into(), scope2.to_vec())]);
    let eligibility = store
        .review_eligibility_for_build(
            project,
            &["zh-CN".into()],
            &scopes,
            &Cancellation::default(),
        )
        .unwrap();
    assert!(!eligibility.ready);
    assert_eq!(
        eligibility.locales[0]
            .blockers
            .iter()
            .filter(|blocker| blocker.code == "correspondence-unresolved")
            .count(),
        2,
        "retaining source cannot bypass unresolved identity"
    );
    eprintln!("S2: independent change oracle and unresolved-identity build gate verified");
    // The fixture's explicit rename oracle is a human decision, never a
    // same-text inference. Reject the other edge before continuing each key.
    let mut corrections = Vec::new();
    for (new_key, old_key) in [("$RENAME_A", "$SAME_A"), ("$RENAME_B", "$SAME_B")] {
        let current = second
            .rows
            .iter()
            .find(|row| row.occurrence.key.ends_with(new_key))
            .unwrap();
        let previous = first
            .rows
            .iter()
            .find(|row| row.occurrence.key.ends_with(old_key))
            .unwrap();
        let correct = previous.occurrence_id.unwrap();
        let other = *old_open.iter().find(|id| **id != correct).unwrap();
        for (old_occurrence_id, decision) in [
            (other, SourceLineageCorrectionDecision::Reject),
            (correct, SourceLineageCorrectionDecision::Continue),
        ] {
            let request = CorrectSourceLineage {
                project_id: project,
                action_id: ExecutionId::new(),
                basis: store
                    .source_lineage_correction_basis(project, snapshot, current.occurrence.ordinal)
                    .unwrap(),
                old_occurrence_id,
                decision,
                actor: "Synthetic maintainer".into(),
                reason: format!(
                    "Explicitly reviewed {new_key} against the fixture rename oracle {old_key}"
                ),
            };
            let receipt = store.correct_source_lineage(&request).unwrap();
            assert_eq!(store.correct_source_lineage(&request).unwrap(), receipt);
            corrections.push((request, receipt));
        }
        let mapped = store.source_content(snapshot, 0, 100).unwrap();
        let mapped = mapped
            .rows
            .iter()
            .find(|row| row.occurrence_id == current.occurrence_id)
            .unwrap();
        assert_eq!(mapped.unit_id, previous.unit_id);
        let target = store
            .review_target(project, mapped.unit_id.unwrap(), "zh-CN")
            .unwrap();
        assert_eq!(
            target.translation_text.as_deref(),
            Some(if old_key == "$SAME_A" {
                "打开甲"
            } else {
                "打开乙"
            })
        );
        assert!(
            target.current_decision.is_none() && target.current_check.is_none(),
            "a mapping decision does not approve the translation"
        );
    }
    let second = store.source_content(snapshot, 0, 100).unwrap();
    let resolved = store.source_impact(snapshot, "zh-CN", 0, 100).unwrap();
    for current in second
        .rows
        .iter()
        .filter(|row| row.occurrence.text == "Open")
    {
        let entry = resolved
            .rows
            .iter()
            .find(|entry| entry.current.occurrence_id == current.occurrence_id)
            .unwrap();
        assert_ne!(
            entry.status,
            tsumugi_core::content::SourceImpactStatus::Unresolved
        );
        assert_eq!(
            entry
                .lineage
                .iter()
                .filter(|edge| edge.decision == "reject")
                .count(),
            1
        );
        assert_eq!(
            entry
                .lineage
                .iter()
                .filter(|edge| edge.decision == "continue")
                .count(),
            1
        );
    }
    manual(&mut store, project, edited, "新条目");
    manual(&mut store, project, added, "新增条目");
    for unit in scope2 {
        qa(&mut store, &mut runtime, project, unit);
        if unit == edited || unit == added {
            approve(&mut store, project, unit);
        }
    }
    assert_eq!(
        store
            .review_target(project, stable, "zh-CN")
            .unwrap()
            .current_decision,
        stable_before.current_decision
    );
    assert_eq!(
        store
            .review_target(project, shared, "zh-CN")
            .unwrap()
            .current_decision,
        shared_before.current_decision
    );
    let release2 = stage_release(
        &mut store,
        &mut runtime,
        project,
        &s2,
        &scope2,
        &build_environment,
        &build,
    );
    assert_ne!(release1.source_snapshot_id, release2.source_snapshot_id);
    assert_ne!(release1.release_id, release2.release_id);
    let bytes2 = release_bytes(&store, &release2);
    assert_ne!(
        bytes1["FormatProbe.esp"], bytes2["FormatProbe.esp"],
        "the second package uses the renumbered upstream plugin"
    );
    assert_ne!(
        bytes1["Interface/Translations/Example_english.txt"],
        bytes2["Interface/Translations/Example_english.txt"]
    );
    read_back(
        &mut store,
        &mut runtime,
        &release2,
        &s2,
        &second,
        &scope2,
        &source,
        &extractor,
        &source_checker,
    );
    assert_eq!(store.release_view(release1.release_id).unwrap(), release1);
    assert_eq!(release_bytes(&store, &release1), bytes1);
    assert_eq!(
        store.source_content(adopted.snapshot, 0, 100).unwrap().rows,
        first.rows
    );
    assert_eq!(store.source_history(0, 100).unwrap().total, 2);
    assert_eq!(store.list_releases(project).unwrap().len(), 2);
    let impact = store.source_impact(snapshot, "zh-CN", 0, 100).unwrap();
    let edited_history = store
        .translation_history(project, edited, "zh-CN", 0, 100)
        .unwrap();
    assert_eq!(edited_history.rows.len(), 2);
    let stable_history = store
        .translation_history(project, stable, "zh-CN", 0, 100)
        .unwrap();
    assert_eq!(stable_history.rows.len(), 2);
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_content(snapshot, 0, 100).unwrap(), second);
    assert_eq!(
        reopened
            .source_content(adopted.snapshot, 0, 100)
            .unwrap()
            .rows,
        first.rows
    );
    assert_eq!(
        reopened.source_impact(snapshot, "zh-CN", 0, 100).unwrap(),
        impact
    );
    assert_eq!(
        reopened
            .translation_history(project, edited, "zh-CN", 0, 100)
            .unwrap(),
        edited_history
    );
    assert_eq!(
        reopened
            .translation_history(project, stable, "zh-CN", 0, 100)
            .unwrap(),
        stable_history
    );
    assert_eq!(
        reopened
            .translation_history(project, removed, "zh-CN", 0, 100)
            .unwrap(),
        removed_history
    );
    assert_eq!(
        reopened
            .review_history(project, removed, "zh-CN", 0, 50)
            .unwrap(),
        removed_review
    );
    assert_eq!(
        reopened
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap(),
        receipt
    );
    for (action, receipt) in imports {
        assert_eq!(
            reopened
                .adoption_receipt(action.action_id)
                .unwrap()
                .unwrap(),
            receipt
        );
    }
    for (request, receipt) in corrections {
        assert_eq!(reopened.correct_source_lineage(&request).unwrap(), receipt);
    }
    for (release, bytes) in [(release1, bytes1), (release2, bytes2)] {
        assert_eq!(reopened.release_view(release.release_id).unwrap(), release);
        assert_eq!(release_bytes(&reopened, &release), bytes);
    }
    reopened.close().unwrap();
    assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    eprintln!(
        "J2 completed: paired import, manual edit, changed/add/remove/ambiguous mapping, two checked native builds, complete native readback, and reopen"
    );
}
