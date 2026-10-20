#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! An independently installed SMAPI package drives source maintenance, real QA
//! and release persistence through normal Core dependencies and actual workers.
use std::{
    collections::{BTreeMap, BTreeSet},
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    sync::Arc,
    time::{Duration, Instant},
};
use tsumugi_core::{
    PluginBuildLocaleChoice, ProjectMetadata, ProjectStore, ReleaseAdoptionHandler,
    ReleaseBuildEnvironment, ReviewCheckOrigin, ReviewDecisionKind, ReviewWrite,
    SaveTranslationRevision,
    content::{
        ContentPage, ContentRow, LineageChoice, LineageDecision, SourceAdoptionHandler,
        SourceBundle, SourceChangeKind, SourceChangePage, SourceConfirmation, SourceReviewBinding,
        SourceSettings,
    },
    execution::*,
};
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};
use tsumugi_plugin_sdk as sdk;

#[path = "../../tests/support/core_execution.rs"]
mod core_execution;
#[path = "../../tests/support/official.rs"]
mod package_fixture;
#[path = "../../tests/support/runtime.rs"]
mod runtime_fixture;
use core_execution::{authorize, execute, execute_all};

const S1_MANIFEST: &[u8] =
    include_bytes!("../../../core/tests/fixtures/upstream-maintenance/s1/manifest.json");
const S1_SOURCE: &[u8] =
    include_bytes!("../../../core/tests/fixtures/upstream-maintenance/s1/i18n/default.json");
const S2_MANIFEST: &[u8] =
    include_bytes!("../../../core/tests/fixtures/upstream-maintenance/s2/manifest.json");
const S2_SOURCE: &[u8] =
    include_bytes!("../../../core/tests/fixtures/upstream-maintenance/s2/i18n/default.json");
const ORACLE: &[u8] =
    include_bytes!("../../../core/tests/fixtures/upstream-maintenance/oracle.json");
const LOCALE: &str = "zh-CN";
const ACTOR: &str = "Synthetic maintainer";
const MANUAL: [(&str, &str); 11] = [
    ("stable", "稳定 {{name}} 👩🏽‍💻 e\u{301}"),
    ("moved", "人工移动译文"),
    ("edited", "人工旧译文 🧶"),
    ("removed", "已移除条目的人工译文"),
    ("rename-old", "人工改名译文 🧭"),
    ("same-text-a", "打开甲"),
    ("same-text-b", "打开乙"),
    ("reuse", "原购买译文"),
    ("split-old", "人工拆分前译文"),
    ("merge-a", "人工合并甲译文"),
    ("merge-b", "人工合并乙译文"),
];
const RELEASE_TEXT: &str = concat!(
    "{\n",
    "  \"stable\": \"稳定 {{name}} 👩🏽‍💻 e\u{301}\",\n",
    "  \"moved\": \"人工移动译文\",\n",
    "  \"edited\": \"人工旧译文 🧶\",\n",
    "  \"removed\": \"已移除条目的人工译文\",\n",
    "  \"rename-old\": \"人工改名译文 🧭\",\n",
    "  \"same-text-a\": \"打开甲\",\n",
    "  \"same-text-b\": \"打开乙\",\n",
    "  \"reuse\": \"原购买译文\",\n",
    "  \"split-old\": \"人工拆分前译文\",\n",
    "  \"merge-a\": \"人工合并甲译文\",\n",
    "  \"merge-b\": \"人工合并乙译文\"\n",
    "}\n",
);

struct EvidenceDirectory(Option<tempfile::TempDir>);

impl EvidenceDirectory {
    fn preserve(&mut self) {
        if let Some(directory) = self.0.take() {
            eprintln!(
                "source maintenance evidence retained: {}",
                directory.keep().display()
            );
        }
    }
}

impl Drop for EvidenceDirectory {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.preserve();
        }
    }
}

fn checked_source(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    binding: &sdk::SourceImportBinding,
    extractor: &RunnerProxy,
    checker: &RunnerProxy,
    review_checker: &RunnerProxy,
    manifest: &[u8],
    source: &[u8],
) -> (FixedInput, FixedResult) {
    let bundle =
        SourceBundle::capture_declared(binding, vec![manifest.to_vec(), source.to_vec()], "en-US")
            .unwrap();
    assert_eq!(bundle.files[0].utf8.as_bytes(), manifest);
    assert_eq!(bundle.files[1].utf8.as_bytes(), source);
    let profile = binding.declaration.profile.clone();
    let producer = extractor.execution_binding(Some(profile.clone())).unwrap();
    let validator = checker.execution_binding(Some(profile.clone())).unwrap();
    assert_eq!(producer.capability, binding.extractor);
    assert_eq!(validator.capability, binding.checker);
    assert_ne!(producer.capability.provider, validator.capability.provider);
    let review = SourceReviewBinding::capture(
        &binding.review,
        &review_checker.execution_binding(Some(profile)).unwrap(),
    )
    .unwrap();
    let input = bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            producer,
            SourceSettings {
                revision_policy: binding.declaration.revision_policy.clone(),
                checker: Some(validator),
                semantic_rules: binding.declaration.semantic_rules.clone(),
                review: Some(review),
            },
        )
        .unwrap();
    let source_grant = authorize(runtime, store, &input);
    let result = execute(runtime, store, &input);
    let captured = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = captured.check_input().clone();
    let check_grant = authorize(runtime, store, &check_input);
    assert_ne!(source_grant, check_grant);
    let checked = execute(runtime, store, &check_input);
    let evidence = checked.envelope().plugin.as_ref().unwrap();
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
        panic!("actual source checker did not succeed")
    };
    let checks = sdk::parse_check_results(output.utf8.as_bytes()).unwrap();
    assert!(!checks.is_empty());
    assert!(checks.iter().all(|check| {
        matches!(&check.outcome, sdk::CheckOutcome::Completed { findings } if findings.is_empty())
    }));
    store
        .commit_source_validation(captured.prepare(checked).unwrap())
        .unwrap();
    (input, result)
}

fn source_action(
    store: &mut ProjectStore,
    input: &FixedInput,
    result: &FixedResult,
    confirmation: &SourceConfirmation,
) -> AdoptionAction {
    store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap()
}

fn by_key(page: &ContentPage) -> BTreeMap<String, ContentRow> {
    page.rows
        .iter()
        .map(|row| (row.occurrence.key.clone(), row.clone()))
        .collect()
}

fn assert_source_text(page: &ContentPage, expected: &[(&str, &str)]) {
    let actual: BTreeMap<_, _> = page
        .rows
        .iter()
        .map(|row| (row.occurrence.key.as_str(), row.occurrence.text.as_str()))
        .collect();
    assert_eq!(actual, expected.iter().copied().collect::<BTreeMap<_, _>>());
}

fn ordinal(comparison: &SourceChangePage, key: &str) -> u32 {
    comparison
        .rows
        .iter()
        .find_map(|row| {
            row.new
                .as_ref()
                .filter(|row| row.key == key)
                .map(|row| row.ordinal)
        })
        .unwrap()
}

fn manual_review(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    project: ExecutionId,
    unit: ExecutionId,
    text: &str,
    binding: &sdk::SourceImportBinding,
    checker: &RunnerProxy,
) {
    let target = store.review_target(project, unit, LOCALE).unwrap();
    let saved = store
        .save_translation_edit(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: LOCALE.into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id,
            text: text.into(),
        })
        .unwrap();
    let target = store.review_target(project, unit, LOCALE).unwrap();
    assert_eq!(target.selection_id, Some(saved.selection.event_id));
    assert_eq!(target.revision_id, Some(saved.revision.revision_id));
    assert_eq!(target.translation_text.as_deref(), Some(text));
    assert!(store.work_protection(unit, LOCALE).unwrap().protected);
    let prepared = store
        .prepare_review_check(
            project,
            unit,
            LOCALE,
            &target.basis,
            ExecutionId::new(),
            &[],
        )
        .unwrap();
    let plan = prepared.plan().unwrap();
    assert_eq!(
        plan.domain_input()
            .source
            .artifacts
            .iter()
            .map(|artifact| artifact.utf8.as_bytes())
            .collect::<Vec<_>>(),
        vec![S1_MANIFEST, S1_SOURCE]
    );
    assert_eq!(
        plan.binding().checker,
        checker
            .execution_binding(Some(binding.review.declaration.profile.clone()),)
            .unwrap()
    );
    let inputs = prepared.execution_inputs();
    assert_eq!(inputs.len(), 1);
    let input = &inputs[0];
    prepared.validate_execution_input(input).unwrap();
    let checker_key = plan.checkers()[0].key.clone();
    authorize(runtime, store, input);
    let result = execute(runtime, store, input);
    let origin = ReviewCheckOrigin {
        checker: checker_key.clone(),
        attempt_id: input.envelope().attempt_id,
        result_id: result.envelope().result_id,
    };
    let computed = store
        .capture_review_check_execution(prepared, &[origin])
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
    assert_eq!(
        computed.checker_result(&checker_key).unwrap().digest(),
        result.digest()
    );
    let domain: Vec<_> = computed
        .results()
        .iter()
        .filter(|check| {
            matches!(
                check.key.implementation,
                sdk::CheckImplementation::Plugin { .. }
            )
        })
        .collect();
    assert_eq!(domain.len(), binding.review.declaration.rules.len());
    assert!(domain.iter().all(|check| {
        matches!(&check.outcome, sdk::CheckOutcome::Completed { findings } if findings.is_empty())
    }));
    assert!(
        store
            .review_target(project, unit, LOCALE)
            .unwrap()
            .current_check
            .is_none()
    );
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    let target = store.review_target(project, unit, LOCALE).unwrap();
    assert_eq!(target.current_check, Some(run));
    store
        .write_review(&ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: LOCALE.into(),
            expected_basis: target.basis,
            expected_decision_id: target.current_decision.map(|decision| decision.decision_id),
            actor: ACTOR.into(),
            kind: ReviewDecisionKind::Approve,
            reason: "Reviewed the exact original translation and QA evidence".into(),
        })
        .unwrap();
}

fn release(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    project: ExecutionId,
    binding: &sdk::BuildBinding,
    builder: &RunnerProxy,
    checker: &RunnerProxy,
) -> (
    AdoptionAction,
    AdoptionReceipt,
    tsumugi_core::ReleaseView,
    Vec<u8>,
) {
    let eligibility = store.review_eligibility(project, &[LOCALE.into()]).unwrap();
    assert!(eligibility.ready, "{eligibility:?}");
    let environment = ReleaseBuildEnvironment::new(
        binding.clone(),
        builder
            .execution_binding(Some(binding.declaration.profile.clone()))
            .unwrap(),
        checker
            .execution_binding(Some(binding.declaration.profile.clone()))
            .unwrap(),
    )
    .unwrap();
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &[PluginBuildLocaleChoice {
                locale: LOCALE.into(),
                output_paths: vec!["i18n/zh.json".into()],
                configuration: vec![],
            }],
            &eligibility.basis,
            &environment,
        )
        .unwrap();
    let producer_grant = authorize(runtime, store, &input);
    let results = execute_all(runtime, store, &input);
    assert_eq!(results.len(), 1);
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            results
                .iter()
                .map(|result| result.envelope().result_id)
                .collect(),
            serde_json::json!({}),
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .is_err()
    );
    assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
    assert!(store.list_releases(project).unwrap().is_empty());
    for result in &results {
        let captured = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let check_input = captured.check_input().clone();
        assert_ne!(authorize(runtime, store, &check_input), producer_grant);
        let checked = execute(runtime, store, &check_input);
        store
            .commit_artifact_validation(captured.prepare(checked).unwrap())
            .unwrap();
    }
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    assert_eq!(receipt.changes.len(), 1);
    let id = ExecutionId::parse(&receipt.changes[0].id).unwrap();
    let view = store.release_view(id).unwrap();
    assert_eq!(view.artifacts.len(), 1);
    assert!(view.exceptions.is_empty());
    let bytes = store
        .release_artifact_by_path(id, LOCALE, "i18n/zh.json")
        .unwrap()
        .1;
    assert_eq!(bytes, RELEASE_TEXT.as_bytes());
    (action, receipt, view, bytes)
}

fn quiesce(runtime: &mut ExecutionRuntime, store: &mut ProjectStore) -> Result<(), ExecutionError> {
    if let Err(error) = runtime.begin_quiesce(store) {
        if error.code != ErrorCode::Busy {
            return Err(error);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        runtime.tick(store)?;
        match runtime.finish_quiesce(store) {
            Ok(()) => return Ok(()),
            Err(error) if error.code == ErrorCode::Busy && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => return Err(error),
        }
    }
}

#[test]
#[ignore = "requires independently captured SMAPI package and runtime artifacts"]
fn actual_smapi_source_maintenance_preserves_explicit_lineage_and_human_history() {
    let mut directory = EvidenceDirectory(Some(tempfile::tempdir().unwrap()));
    let root = directory.0.as_ref().unwrap().path().to_path_buf();
    let image = package_fixture::installed(&root, "stardew-smapi");
    let staging = root.join("workers");
    std::fs::create_dir(&staging).unwrap();
    let proxy = |contribution: &str| {
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
    let source = image.source_import("source-profile").unwrap();
    let build = image.build_declaration("build-profile").unwrap();
    let extractor = proxy(&source.declaration.extractor);
    let source_checker = proxy(&source.declaration.checker);
    let review_checker = proxy(&source.review.declaration.checker);
    let builder = proxy(&build.declaration.builder);
    let artifact_checker = proxy(&build.declaration.checker);
    let path = root.join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Source maintenance", "en-US", [LOCALE]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [
        &extractor,
        &source_checker,
        &review_checker,
        &builder,
        &artifact_checker,
    ] {
        runtime.register(runner.clone()).unwrap();
    }

    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let (first_input, first_result) = checked_source(
            &mut runtime,
            &mut store,
            &source,
            &extractor,
            &source_checker,
            &review_checker,
            S1_MANIFEST,
            S1_SOURCE,
        );
        let first_confirmation = store
            .source_preview(
                first_input.envelope().attempt_id,
                first_result.envelope().result_id,
                0,
                100,
            )
            .unwrap()
            .confirmation;
        let first_action =
            source_action(&mut store, &first_input, &first_result, &first_confirmation);
        let first_receipt = store
            .adopt_execution(&first_action, &SourceAdoptionHandler)
            .unwrap();
        let first_scope = store.content_scope().unwrap();
        let first_snapshot = first_scope.current_snapshot.unwrap();
        let first_page = store.source_content(first_snapshot, 0, 100).unwrap();
        assert_eq!(first_page.namespace, "Example.Maintenance");
        let old = by_key(&first_page);
        let oracle: serde_json::Value = serde_json::from_slice(ORACLE).unwrap();
        assert_eq!(first_page.total as u64, oracle["s1Count"].as_u64().unwrap());
        assert_source_text(
            &first_page,
            &[
                ("stable", "Hello {{name}}"),
                ("moved", "Move me"),
                ("edited", "Old text"),
                ("removed", "Gone"),
                ("rename-old", "Rename me"),
                ("same-text-a", "Open"),
                ("same-text-b", "Open"),
                ("reuse", "Purchase"),
                ("split-old", "Shared"),
                ("merge-a", "Pair"),
                ("merge-b", "Pair"),
            ],
        );
        assert_ne!(old["same-text-a"].unit_id, old["same-text-b"].unit_id);

        for (key, text) in MANUAL {
            manual_review(
                &mut runtime,
                &mut store,
                project,
                old[key].unit_id.unwrap(),
                text,
                &source,
                &review_checker,
            );
        }
        let before: BTreeMap<_, _> = MANUAL
            .iter()
            .map(|(key, _)| {
                let unit = old[*key].unit_id.unwrap();
                (
                    (*key).to_owned(),
                    (
                        store.review_target(project, unit, LOCALE).unwrap(),
                        store
                            .translation_history(project, unit, LOCALE, 0, 100)
                            .unwrap(),
                        store.review_history(project, unit, LOCALE, 0, 50).unwrap(),
                        store.work_protection(unit, LOCALE).unwrap(),
                    ),
                )
            })
            .collect();
        let (release_action, release_receipt, release_view, release_bytes) = release(
            &mut runtime,
            &mut store,
            project,
            &build,
            &builder,
            &artifact_checker,
        );
        assert_eq!(release_view.source_snapshot_id, first_snapshot);

        let (input, result) = checked_source(
            &mut runtime,
            &mut store,
            &source,
            &extractor,
            &source_checker,
            &review_checker,
            S2_MANIFEST,
            S2_SOURCE,
        );
        let comparison = store
            .source_comparison(
                input.envelope().attempt_id,
                result.envelope().result_id,
                0,
                100,
            )
            .unwrap();
        assert_eq!(comparison.previous_snapshot_id, first_snapshot);
        assert_eq!(comparison.total, 16);
        assert_eq!(comparison.rows.len(), 16);
        assert_eq!(comparison.next_ordinal, None);
        for (count, keys) in [
            (comparison.unchanged, "unchanged"),
            (comparison.changed, "changed"),
            (comparison.added, "added"),
            (comparison.removed, "removed"),
        ] {
            assert_eq!(count as usize, oracle[keys].as_array().unwrap().len());
        }
        assert_eq!(comparison.moved, 4);
        assert_eq!(comparison.ambiguous, 3);
        for (kind, keys) in [
            (SourceChangeKind::Unchanged, "unchanged"),
            (SourceChangeKind::Changed, "changed"),
            (SourceChangeKind::Removed, "removed"),
        ] {
            let actual: BTreeSet<_> = comparison
                .rows
                .iter()
                .filter(|row| {
                    row.kind == kind
                        || (kind == SourceChangeKind::Unchanged
                            && row.kind == SourceChangeKind::Moved)
                })
                .map(|row| {
                    row.new
                        .as_ref()
                        .map(|new| new.key.as_str())
                        .unwrap_or_else(|| row.old.as_ref().unwrap().occurrence.key.as_str())
                })
                .collect();
            let expected: BTreeSet<_> = oracle[keys]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap())
                .collect();
            assert_eq!(actual, expected);
        }
        let rename = comparison
            .rows
            .iter()
            .find(|row| row.new.as_ref().is_some_and(|row| row.key == "rename-new"))
            .unwrap();
        assert_eq!(rename.kind, SourceChangeKind::RenameCandidate);
        assert_eq!(rename.old.as_ref().unwrap().occurrence.key, "rename-old");
        assert_eq!(
            comparison
                .rows
                .iter()
                .find(|row| { row.new.as_ref().is_some_and(|row| row.key == "added") })
                .unwrap()
                .kind,
            SourceChangeKind::Added
        );
        for (key, candidates) in oracle["unresolved"].as_object().unwrap() {
            let row = comparison
                .rows
                .iter()
                .find(|row| row.new.as_ref().is_some_and(|row| row.key == *key))
                .unwrap();
            assert_eq!(row.kind, SourceChangeKind::Ambiguous);
            assert_eq!(
                row.candidates
                    .iter()
                    .map(|row| row.occurrence.key.as_str())
                    .collect::<Vec<_>>(),
                candidates
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|key| key.as_str().unwrap())
                    .collect::<Vec<_>>()
            );
        }
        assert_eq!(store.content_scope().unwrap(), first_scope);
        for (key, (_, translations, reviews, protection)) in &before {
            let unit = old[key].unit_id.unwrap();
            assert_eq!(
                store
                    .translation_history(project, unit, LOCALE, 0, 100)
                    .unwrap(),
                *translations
            );
            assert_eq!(
                store.review_history(project, unit, LOCALE, 0, 50).unwrap(),
                *reviews
            );
            assert_eq!(store.work_protection(unit, LOCALE).unwrap(), *protection);
        }

        let mut invalid = comparison.confirmation.clone();
        invalid.actor = Some(ACTOR.into());
        for key in ["split-a", "split-b"] {
            invalid.lineage.push(LineageChoice {
                new_ordinal: ordinal(&comparison, key),
                old_occurrence_id: old["split-old"].occurrence_id.unwrap(),
                decision: LineageDecision::Continue,
                reason: "Reviewing a competing continuation must not split identity".into(),
            });
        }
        let rejected = source_action(&mut store, &input, &result, &invalid);
        let error = store
            .adopt_execution(&rejected, &SourceAdoptionHandler)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict);
        assert_eq!(error.stage, "lineage-split");
        assert!(
            store
                .adoption_receipt(rejected.action_id)
                .unwrap()
                .is_none()
        );
        assert_eq!(store.content_scope().unwrap(), first_scope);
        assert_eq!(
            store.source_content(first_snapshot, 0, 100).unwrap().rows,
            first_page.rows
        );
        assert_eq!(
            store.release_view(release_view.release_id).unwrap(),
            release_view
        );

        let mut confirmation = comparison.confirmation.clone();
        confirmation.actor = Some(ACTOR.into());
        for (new_key, old_key, decision) in [
            ("edited", "edited", LineageDecision::Continue),
            ("rename-new", "rename-old", LineageDecision::Continue),
            ("reuse", "reuse", LineageDecision::Reject),
        ] {
            confirmation.lineage.push(LineageChoice {
                new_ordinal: ordinal(&comparison, new_key),
                old_occurrence_id: old[old_key].occurrence_id.unwrap(),
                decision,
                reason: format!("Reviewed {new_key} against {old_key}"),
            });
        }
        let action = source_action(&mut store, &input, &result, &confirmation);
        let receipt = store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        assert_eq!(
            store
                .adopt_execution(&action, &SourceAdoptionHandler)
                .unwrap(),
            receipt
        );
        let scope = store.content_scope().unwrap();
        let snapshot = scope.current_snapshot.unwrap();
        assert_ne!(snapshot, first_snapshot);
        let page = store.source_content(snapshot, 0, 100).unwrap();
        assert_eq!(page.total as u64, oracle["s2Count"].as_u64().unwrap());
        assert_eq!(page.namespace, "Example.Maintenance");
        assert_source_text(
            &page,
            &[
                ("moved", "Move me"),
                ("stable", "Hello {{name}}"),
                ("edited", "New text"),
                ("rename-new", "Rename me"),
                ("same-text-a", "Open"),
                ("same-text-b", "Open"),
                ("reuse", "Close"),
                ("added", "New one"),
                ("split-a", "Shared"),
                ("split-b", "Shared"),
                ("merge-new", "Pair"),
            ],
        );
        let new = by_key(&page);
        for key in ["stable", "moved", "same-text-a", "same-text-b"] {
            assert_eq!(new[key].unit_id, old[key].unit_id);
            assert_eq!(new[key].source_revision_id, old[key].source_revision_id);
        }
        assert_eq!(new["edited"].unit_id, old["edited"].unit_id);
        assert_ne!(
            new["edited"].source_revision_id,
            old["edited"].source_revision_id
        );
        assert_eq!(new["edited"].occurrence.text, "New text");
        assert_eq!(new["rename-new"].unit_id, old["rename-old"].unit_id);
        assert_eq!(
            new["rename-new"].source_revision_id,
            old["rename-old"].source_revision_id
        );
        assert_ne!(new["reuse"].unit_id, old["reuse"].unit_id);
        assert_eq!(new["reuse"].occurrence.text, "Close");
        assert!(!new.contains_key("removed"));
        assert_ne!(new["same-text-a"].unit_id, new["same-text-b"].unit_id);
        for key in ["split-a", "split-b", "merge-new"] {
            let unit = new[key].unit_id.unwrap();
            assert!(!old.values().any(|row| row.unit_id == Some(unit)));
        }

        let mut lineage = BTreeMap::new();
        for (key, expected_old, decision, applied) in [
            ("edited", "edited", "continue", Some("changed")),
            ("rename-new", "rename-old", "continue", Some("unchanged")),
            ("reuse", "reuse", "reject", Some("unresolved")),
        ] {
            let rows = store
                .source_lineage_evidence(snapshot, new[key].occurrence.ordinal)
                .unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].old, old[expected_old]);
            assert_eq!(rows[0].old_snapshot_id, first_snapshot);
            assert_eq!(rows[0].decision, decision);
            assert_eq!(rows[0].actor.as_deref(), Some(ACTOR));
            let reason = format!("Reviewed {key} against {expected_old}");
            assert_eq!(rows[0].reason.as_deref(), Some(reason.as_str()));
            assert_eq!(rows[0].action_id, action.action_id);
            assert_eq!(rows[0].policy, confirmation.identity_policy);
            assert_eq!(
                rows[0].relationship,
                if key == "rename-new" {
                    "same-text"
                } else {
                    "same-key"
                }
            );
            assert_eq!(rows[0].applied_relation.as_deref(), applied);
            lineage.insert(key.to_owned(), rows);
        }
        for (key, candidates) in oracle["unresolved"].as_object().unwrap() {
            let rows = store
                .source_lineage_evidence(snapshot, new[key].occurrence.ordinal)
                .unwrap();
            assert_eq!(
                rows.iter()
                    .map(|row| row.old.occurrence.key.as_str())
                    .collect::<Vec<_>>(),
                candidates
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|key| key.as_str().unwrap())
                    .collect::<Vec<_>>()
            );
            assert!(rows.iter().all(|row| row.decision == "candidate"
                && row.actor.is_none()
                && row.reason.is_none()
                && row.applied_relation.is_none()));
            assert!(rows.iter().all(|row| row.old_snapshot_id == first_snapshot
                && row.action_id == action.action_id
                && row.policy == confirmation.identity_policy));
            lineage.insert(key.clone(), rows);
        }
        for (key, (target, translations, reviews, protection)) in &before {
            let unit = old[key].unit_id.unwrap();
            assert_eq!(
                store
                    .translation_history(project, unit, LOCALE, 0, 100)
                    .unwrap(),
                *translations
            );
            assert_eq!(
                store.review_history(project, unit, LOCALE, 0, 50).unwrap(),
                *reviews
            );
            assert_eq!(store.work_protection(unit, LOCALE).unwrap(), *protection);
            let current_key = if key == "rename-old" {
                "rename-new"
            } else {
                key.as_str()
            };
            if new
                .get(current_key)
                .is_some_and(|row| row.unit_id == Some(unit))
            {
                let current = store.review_target(project, unit, LOCALE).unwrap();
                assert_eq!(current.selection_id, target.selection_id);
                assert_eq!(current.revision_id, target.revision_id);
                assert_eq!(current.translation_text, target.translation_text);
                assert!(
                    current.current_check.is_none(),
                    "S1 file QA cannot qualify S2: {key}"
                );
                if key == "edited" {
                    assert_ne!(current.basis, target.basis);
                    assert!(current.current_decision.is_none());
                } else {
                    assert_eq!(current.basis, target.basis);
                    assert_eq!(current.current_decision, target.current_decision);
                }
            }
        }
        let reused = store
            .review_target(project, new["reuse"].unit_id.unwrap(), LOCALE)
            .unwrap();
        assert!(
            reused.selection_id.is_none()
                && reused.translation_text.is_none()
                && reused.current_decision.is_none()
                && reused.current_check.is_none()
        );
        assert!(
            !store
                .work_protection(reused.unit_id, LOCALE)
                .unwrap()
                .protected
        );
        let impact = store.source_impact(snapshot, LOCALE, 0, 100).unwrap();
        let stable = impact
            .rows
            .iter()
            .find(|row| row.current.unit_id == new["stable"].unit_id)
            .unwrap();
        assert!(
            stable
                .reasons
                .iter()
                .any(|reason| reason == "qa-missing-or-stale")
        );
        assert!(
            !stable
                .reasons
                .iter()
                .any(|reason| reason == "approval-missing-or-stale")
        );
        let edited = impact
            .rows
            .iter()
            .find(|row| row.current.unit_id == new["edited"].unit_id)
            .unwrap();
        assert!(
            edited
                .reasons
                .iter()
                .any(|reason| reason == "approval-missing-or-stale")
        );
        assert!(
            !store
                .review_eligibility(project, &[LOCALE.into()])
                .unwrap()
                .ready
        );
        assert_eq!(
            store.source_content(first_snapshot, 0, 100).unwrap().rows,
            first_page.rows
        );
        assert_eq!(
            store.release_view(release_view.release_id).unwrap(),
            release_view
        );
        assert_eq!(
            store
                .release_artifact_by_path(release_view.release_id, LOCALE, "i18n/zh.json")
                .unwrap()
                .1,
            release_bytes
        );
        let source_history = store.source_history(0, 100).unwrap();
        assert_eq!(source_history.total, 2);
        assert_eq!(
            source_history
                .snapshots
                .iter()
                .filter(|snapshot| snapshot.current)
                .count(),
            1
        );
        (
            first_action,
            first_receipt,
            first_page,
            action,
            receipt,
            page,
            before,
            lineage,
            release_action,
            release_receipt,
            release_view,
            release_bytes,
            source_history,
        )
    }));

    let drained = quiesce(&mut runtime, &mut store);
    if let Err(error) = drained {
        directory.preserve();
        // Cancellation was requested, but unjoined producers still own their captures.
        // Keep their data and owners intact instead of deleting an active fixture.
        std::mem::forget(runtime);
        std::mem::forget(store);
        match outcome {
            Err(panic) => {
                eprintln!("source maintenance drain also failed: {error:?}");
                resume_unwind(panic);
            }
            Ok(_) => panic!("source maintenance producers did not drain: {error:?}"),
        }
    }
    drop(runtime);
    let closed = store.close();
    let (
        first_action,
        first_receipt,
        first_page,
        action,
        receipt,
        page,
        before,
        lineage,
        release_action,
        release_receipt,
        release_view,
        release_bytes,
        source_history,
    ) = match outcome {
        Ok(observed) => {
            closed.unwrap();
            observed
        }
        Err(panic) => {
            if let Err(error) = closed {
                eprintln!("source maintenance close also failed: {error:?}");
            }
            resume_unwind(panic);
        }
    };
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_history(0, 100).unwrap(), source_history);
    assert_eq!(
        reopened.content_scope().unwrap().current_snapshot,
        page.snapshot_id
    );
    assert_eq!(
        reopened
            .source_content(first_page.snapshot_id.unwrap(), 0, 100)
            .unwrap()
            .rows,
        first_page.rows
    );
    assert_eq!(
        reopened
            .source_content(page.snapshot_id.unwrap(), 0, 100)
            .unwrap()
            .rows,
        page.rows
    );
    assert_eq!(
        reopened.adoption_receipt(first_action.action_id).unwrap(),
        Some(first_receipt)
    );
    assert_eq!(
        reopened.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
    assert_eq!(
        reopened.adoption_receipt(release_action.action_id).unwrap(),
        Some(release_receipt)
    );
    for (key, (_, translations, reviews, protection)) in &before {
        let unit = by_key(&first_page)[key].unit_id.unwrap();
        assert_eq!(
            reopened
                .translation_history(project, unit, LOCALE, 0, 100)
                .unwrap(),
            *translations
        );
        assert_eq!(
            reopened
                .review_history(project, unit, LOCALE, 0, 50)
                .unwrap(),
            *reviews
        );
        assert_eq!(reopened.work_protection(unit, LOCALE).unwrap(), *protection);
    }
    let new = by_key(&page);
    for (key, expected) in lineage {
        assert_eq!(
            reopened
                .source_lineage_evidence(page.snapshot_id.unwrap(), new[&key].occurrence.ordinal)
                .unwrap(),
            expected
        );
    }
    assert_eq!(
        reopened.release_view(release_view.release_id).unwrap(),
        release_view
    );
    assert_eq!(
        reopened
            .release_artifact_by_path(release_view.release_id, LOCALE, "i18n/zh.json")
            .unwrap()
            .1,
        release_bytes
    );
    reopened.close().unwrap();
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
}
