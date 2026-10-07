#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! Two independently installed real workers share the ordinary Core QA owner.
use std::{collections::BTreeSet, path::Path, sync::Arc};
use tsumugi_core::{
    AdvisoryReviewCheck, ProjectMetadata, ProjectStore, ReviewCheckOrigin, ReviewDecisionKind,
    ReviewWrite, SaveTranslationRevision,
    application::{SelectionPolicy, SetWorkProtection},
    content::{SourceAdoptionHandler, SourceBundle, SourceReviewBinding, SourceSettings},
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "../../core/tests/support/automatic.rs"]
mod automatic;
#[path = "support/core_execution.rs"]
mod core_execution;
#[path = "support/official.rs"]
mod official;
#[path = "support/runtime.rs"]
mod runtime_fixture;

struct OwnedDirectory(tempfile::TempDir);
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        fn writable(path: &Path) {
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return;
            };
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
                for child in std::fs::read_dir(path).unwrap() {
                    writable(&child.unwrap().path());
                }
            }
        }
        // Only the synthetic Store's owned sealed directories need this for
        // TempDir teardown. Never follow links to selected package material.
        writable(self.0.path());
    }
}

#[test]
fn actual_format_and_advisory_workers_preserve_qa_history_and_atomic_selection() {
    let temp = OwnedDirectory(tempfile::tempdir().unwrap());
    let root = temp.0.path();
    let format_root = root.join("format");
    std::fs::create_dir(&format_root).unwrap();
    let format = official::installed(&format_root, "webvtt");
    let knowledge_root = root.join("knowledge");
    std::fs::create_dir(&knowledge_root).unwrap();
    let knowledge_source = std::env::var_os("TSUMUGI_TEST_KNOWLEDGE_PACKAGE")
        .expect("explicit knowledge package required");
    let knowledge_digest = std::env::var("TSUMUGI_TEST_KNOWLEDGE_DIGEST")
        .expect("exact knowledge package digest required");
    let knowledge = official::installed_from(
        &knowledge_root,
        Path::new(&knowledge_source),
        &knowledge_digest,
        "philosophy",
    );
    let source = format.source_import("source-profile").unwrap();
    let text = knowledge.text_review_declaration("text-review").unwrap();
    let staging = root.join("workers");
    std::fs::create_dir(&staging).unwrap();
    let proxy = |image: &PackageImage, contribution: &str| {
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
    let extractor = proxy(&format, &source.declaration.extractor);
    let source_checker = proxy(&format, &source.declaration.checker);
    let format_checker = proxy(&format, &source.review.declaration.checker);
    let text_checker = proxy(&knowledge, &text.declaration.checker);
    let rule = text
        .declaration
        .rules
        .iter()
        .find(|rule| rule.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
    let text_execution = text_checker
        .execution_binding(Some(text.declaration.profile.clone()))
        .unwrap();
    let advisory = AdvisoryReviewCheck::capture(
        &text,
        &text_execution.environment,
        "text-review",
        knowledge.text_review_resource_pins("text-review").unwrap(),
        vec![rule],
    )
    .unwrap();
    let choices = vec![advisory.clone()];
    let path = root.join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Joint QA", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&extractor, &source_checker, &format_checker, &text_checker] {
        runtime.register(runner.clone()).unwrap();
    }
    let producer = extractor
        .execution_binding(Some(source.declaration.profile.clone()))
        .unwrap();
    let source_input = SourceBundle::capture_declared(
        &source,
        vec![
            "WEBVTT\n\nCue\n00:01.000 --> 00:02.000\nsound premises é 👩🏽‍💻\n"
                .as_bytes()
                .to_vec(),
        ],
        "en",
    )
    .unwrap()
    .fixed_plugin_input(
        store.metadata().unwrap().project_id(),
        producer.clone(),
        SourceSettings {
            revision_policy: source.declaration.revision_policy.clone(),
            checker: Some(
                source_checker
                    .execution_binding(Some(source.declaration.profile.clone()))
                    .unwrap(),
            ),
            semantic_rules: source.declaration.semantic_rules.clone(),
            review: Some(
                SourceReviewBinding::capture(&source.review, &producer.environment).unwrap(),
            ),
        },
    )
    .unwrap();
    core_execution::authorize(&runtime, &mut store, &source_input);
    let source_result = core_execution::execute(&mut runtime, &mut store, &source_input);
    let validation = store
        .capture_source_validation(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
        )
        .unwrap();
    let check_input = validation.check_input().clone();
    core_execution::authorize(&runtime, &mut store, &check_input);
    let checked = core_execution::execute(&mut runtime, &mut store, &check_input);
    store
        .commit_source_validation(validation.prepare(checked).unwrap())
        .unwrap();
    let preview = store
        .source_preview(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
            0,
            10,
        )
        .unwrap();
    let action = store
        .prepare_adoption(
            source_input.envelope().attempt_id,
            source_input.envelope().units[0].unit_id,
            vec![source_result.envelope().result_id],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let unit = store.source_content(snapshot, 0, 10).unwrap().rows[0]
        .unit_id
        .unwrap();
    let current = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: current.source_revision_id,
            expected_selection_id: current.selection_id,
            text: "👩🏽‍💻 é 前提".into(),
        })
        .unwrap();
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    let prepared = store
        .prepare_review_check(
            project,
            unit,
            "zh-CN",
            &target.basis,
            ExecutionId::new(),
            &choices,
        )
        .unwrap();
    assert_eq!(prepared.execution_inputs().len(), 2);
    assert_eq!(
        prepared
            .execution_inputs()
            .iter()
            .map(|input| input.envelope().task_id)
            .collect::<BTreeSet<_>>()
            .len(),
        2
    );
    let mut origins = Vec::new();
    let mut grants = Vec::new();
    for (checker, input) in prepared
        .plan()
        .unwrap()
        .checkers()
        .iter()
        .zip(prepared.execution_inputs())
    {
        assert_eq!(
            runtime.submit(&mut store, input).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        grants.push(core_execution::authorize(&runtime, &mut store, input));
        let result = core_execution::execute(&mut runtime, &mut store, input);
        origins.push(ReviewCheckOrigin {
            checker: checker.key.clone(),
            attempt_id: input.envelope().attempt_id,
            result_id: result.envelope().result_id,
        });
    }
    let computed = store
        .capture_review_check_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert!(computed.coverage().complete);
    assert_eq!(computed.diagnostics().len(), 1);
    assert_eq!(computed.diagnostics()[0].code, "preferred-term-missing");
    assert!(computed.diagnostics()[0].location.is_some());
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    assert_eq!(run.evidence.as_ref().unwrap().origins.len(), 2);
    assert!(
        run.rules
            .iter()
            .any(|rule| !rule.mandatory && !rule.findings.is_empty())
    );
    assert!(
        run.rules
            .iter()
            .filter(|rule| rule.mandatory)
            .all(|rule| rule.status == "passed")
    );
    store
        .write_review(&ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            expected_decision_id: None,
            actor: "Synthetic reviewer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: "Checked exact selection".into(),
        })
        .unwrap();
    assert!(
        store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap()
            .ready
    );
    let approved = store.review_target(project, unit, "zh-CN").unwrap();
    let protection = store.work_protection(unit, "zh-CN").unwrap();
    assert!(protection.protected);
    // The synthetic reviewer explicitly releases the approved selection before
    // authorizing replacement. Advisory QA cannot bypass human protection.
    store
        .set_work_protection(&SetWorkProtection {
            action_id: ExecutionId::new(),
            project_id: project,
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: approved.source_revision_id,
            selection_id: approved.selection_id,
            expected_revision: protection.revision,
            protected: false,
            confirmed_release: true,
        })
        .unwrap();
    let request = automatic::candidate_request_with_advisory(
        &mut store,
        unit,
        "前提",
        SelectionPolicy::ReplaceCapturedSelection,
        &choices,
    );
    let prepared = store.prepare_automatic_selection(&request).unwrap();
    let check = prepared.review_check().unwrap();
    assert_eq!(check.plan().unwrap().advisory_checks(), choices);
    let mut selected_origins = Vec::new();
    for (checker, input) in check
        .plan()
        .unwrap()
        .checkers()
        .iter()
        .zip(check.execution_inputs())
    {
        core_execution::authorize(&runtime, &mut store, input);
        let result = core_execution::execute(&mut runtime, &mut store, input);
        selected_origins.push(ReviewCheckOrigin {
            checker: checker.key.clone(),
            attempt_id: input.envelope().attempt_id,
            result_id: result.envelope().result_id,
        });
    }
    let computed = store
        .capture_automatic_selection_execution(prepared, &selected_origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let receipt = store
        .commit_automatic_selection(computed, &Cancellation::default())
        .unwrap();
    assert!(receipt.blocked.is_none(), "{receipt:?}");
    let selected = store.review_target(project, unit, "zh-CN").unwrap();
    assert_eq!(selected.revision_id, Some(request.revision_id));
    assert!(selected.current_decision.is_none());
    assert!(
        selected
            .current_check
            .as_ref()
            .unwrap()
            .rules
            .iter()
            .any(|rule| !rule.mandatory && !rule.findings.is_empty())
    );
    assert_eq!(
        store
            .automatic_selection_receipt(request.action_id)
            .unwrap(),
        Some(receipt.clone())
    );
    for grant in &grants {
        runtime.revoke_plugin(&mut store, *grant).unwrap();
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .review_check_action(project, run.action_id)
            .unwrap(),
        Some(run)
    );
    assert_eq!(
        reopened.review_target(project, unit, "zh-CN").unwrap(),
        selected
    );
    assert_eq!(
        reopened
            .automatic_selection_receipt(request.action_id)
            .unwrap(),
        Some(receipt)
    );
    assert_eq!(grants.len(), 2);
    assert_ne!(grants[0], grants[1]);
    assert_eq!(
        std::str::from_utf8(
            knowledge
                .resource_bytes(
                    "terminology",
                    &sdk::ContractRef {
                        id: "org.tsumugi.examples.terminology-resource".into(),
                        schema_version: 1,
                        behavior_version: 1,
                    }
                )
                .unwrap()
        )
        .unwrap()
        .contains("unadopted-editorial-suggestion"),
        true
    );
}
