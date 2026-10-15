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
    exercise_joint_review(false, false);
}

#[test]
fn actual_same_rule_providers_keep_conflicting_suggestions_and_independent_origins() {
    for reverse in [false, true] {
        exercise_joint_review(true, reverse);
    }
}

#[path = "support/scoped_package.rs"]
mod scoped_package;
fn exercise_joint_review(multiple: bool, reverse: bool) {
    exercise_joint_review_scoped(multiple, reverse, false)
}
#[test]
fn attempt_advisory_review_keeps_project_format_checks_and_independent_origins() {
    exercise_joint_review_scoped(false, false, true)
}
fn exercise_joint_review_scoped(multiple: bool, reverse: bool, attempt_advisory: bool) {
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
    let knowledge = if attempt_advisory {
        scoped_package::capture(Path::new(&knowledge_source), &knowledge_digest, |id| {
            if id == "check" {
                sdk::ComponentScope::Attempt
            } else {
                sdk::ComponentScope::Project
            }
        })
    } else {
        knowledge
    };
    let alternative = multiple.then(|| {
        let path = root.join("alternative");
        std::fs::create_dir(&path).unwrap();
        let source = std::env::var_os("TSUMUGI_TEST_SECOND_KNOWLEDGE_PACKAGE")
            .expect("explicit independent second knowledge package required");
        let digest = std::env::var("TSUMUGI_TEST_SECOND_KNOWLEDGE_DIGEST")
            .expect("exact second knowledge package digest required");
        official::installed_from(&path, Path::new(&source), &digest, "philosophy-alternative")
    });
    let mut knowledge_images = vec![&knowledge];
    if let Some(image) = &alternative {
        knowledge_images.push(image);
    }
    if reverse {
        knowledge_images.reverse();
    }
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
    let rule = text
        .declaration
        .rules
        .iter()
        .find(|rule| rule.rule.id.ends_with(".soundness"))
        .unwrap()
        .rule
        .clone();
    let mut text_checkers = Vec::new();
    let mut choices = Vec::new();
    let mut catalog = catalog::PackageCatalog::new();
    for image in &knowledge_images {
        let binding = image.text_review_declaration("text-review").unwrap();
        assert!(binding.declaration.rules.iter().any(|r| r.rule == rule));
        let runner = proxy(image, &binding.declaration.checker);
        let execution = runner
            .execution_binding(Some(binding.declaration.profile.clone()))
            .unwrap();
        choices.push(
            AdvisoryReviewCheck::capture(
                &binding,
                &execution,
                "text-review",
                image.text_review_resource_pins("text-review").unwrap(),
                vec![rule.clone()],
            )
            .unwrap(),
        );
        text_checkers.push(runner);
        let plugin = image.manifest().manifest().plugin.clone();
        catalog
            .register(
                (*image).clone(),
                catalog::PackageApproval {
                    plugin: plugin.clone(),
                    package_digest: image.package_digest().into(),
                    origin: catalog::PackageOrigin {
                        source_id: "explicit-official-test".into(),
                        publisher_id: "reviewed-public-source".into(),
                    },
                },
            )
            .unwrap();
        catalog.set_enabled(&plugin, true).unwrap();
    }
    let chosen: Vec<_> = choices
        .iter()
        .map(|choice| sdk::ProviderKey {
            plugin: choice.binding.checker.provider.plugin.clone(),
            contribution_id: choice.binding.checker.provider.contribution_id.clone(),
        })
        .collect();
    if multiple {
        assert_eq!(
            catalog
                .resolve(
                    &text.checker.declaration.contract,
                    Some(&text.declaration.profile),
                    sdk::ProviderSelection::Single,
                    &[],
                )
                .unwrap_err(),
            catalog::CatalogError::AmbiguousProvider
        );
        assert_ne!(choices[0].resource_pins, choices[1].resource_pins);
    }
    for (choice, key) in choices.iter().zip(&chosen) {
        let selected = catalog
            .resolve(
                &text.checker.declaration.contract,
                Some(&text.declaration.profile),
                sdk::ProviderSelection::Single,
                std::slice::from_ref(key),
            )
            .unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(
            selected[0].binding().provider,
            choice.binding.checker.provider
        );
    }
    let collected = catalog
        .resolve(
            &text.checker.declaration.contract,
            Some(&text.declaration.profile),
            sdk::ProviderSelection::CollectIndependent,
            &chosen,
        )
        .unwrap();
    assert_eq!(
        collected
            .iter()
            .map(|provider| provider.binding().provider.clone())
            .collect::<BTreeSet<_>>(),
        choices
            .iter()
            .map(|choice| choice.binding.checker.provider.clone())
            .collect()
    );
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    let checker_count = choices.len() + 1;
    // Queries and advisory checks consume the same independently captured
    // Resource. Conflicting editorial preferences are never ranked by loading.
    let asynchronous = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    asynchronous.block_on(async {
        for image in &knowledge_images {
            let tool = image.capability_tool("agent-query-tool").unwrap();
            let mut request = tool
                .declaration
                .query
                .as_ref()
                .unwrap()
                .input_template
                .clone();
            request["queries"][0]["text"] = serde_json::json!("sound premises é 👩🏽‍💻");
            request["queries"][0]["conceptIds"] = serde_json::json!(["soundness"]);
            let mut session = official::launch(image, "query", &staging).await;
            let payload = official::success_payload(
                official::invoke(
                    &mut session,
                    &tool.capability,
                    "explicit-reference-query",
                    &request,
                )
                .await,
            );
            let output: serde_json::Value = serde_json::from_str(&payload.utf8).unwrap();
            assert_eq!(output["results"][0]["entries"].as_array().unwrap().len(), 1);
            assert_eq!(
                output["results"][0]["entries"][0]["preferredTarget"],
                if image.manifest().manifest().plugin.id == "philosophy-alternative" {
                    "健全性"
                } else {
                    "可靠性"
                }
            );
            official::close_and_reap(&mut session).await;
        }
    });
    let path = root.join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Joint QA", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&extractor, &source_checker, &format_checker]
        .into_iter()
        .chain(text_checkers.iter())
    {
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
                SourceReviewBinding::capture(
                    &source.review,
                    &tsumugi_core::execution::PluginExecutionBinding {
                        component_scope: sdk::ComponentScope::Project,
                        capability: (&source.review).checker.clone(),
                        profile: Some((&source.review).declaration.profile.clone()),
                        environment: (*(&producer.environment)).clone().into(),
                    },
                )
                .unwrap(),
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
    assert_eq!(prepared.execution_inputs().len(), checker_count);
    assert_eq!(
        prepared
            .execution_inputs()
            .iter()
            .map(|input| input.envelope().task_id)
            .collect::<BTreeSet<_>>()
            .len(),
        checker_count
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
    assert_eq!(computed.diagnostics().len(), choices.len());
    assert!(
        computed
            .diagnostics()
            .iter()
            .all(|diagnostic| diagnostic.code == "preferred-term-missing"
                && diagnostic.location.is_some())
    );
    let suggestions = computed
        .diagnostics()
        .iter()
        .map(|diagnostic| diagnostic.suggestion.as_deref().unwrap())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        suggestions,
        if multiple {
            BTreeSet::from(["可靠性", "健全性"])
        } else {
            BTreeSet::from(["可靠性"])
        }
    );
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    assert_eq!(run.evidence.as_ref().unwrap().origins.len(), checker_count);
    assert_eq!(run.evidence.as_ref().unwrap().advisory_checks, choices);
    if multiple {
        let advisory: Vec<_> = run.rules.iter().filter(|rule| !rule.mandatory).collect();
        assert_eq!(advisory.len(), 2);
        assert_eq!(advisory[0].rule, advisory[1].rule);
        assert_ne!(advisory[0].key, advisory[1].key);
        assert_ne!(
            advisory[0].findings[0].issue_id,
            advisory[1].findings[0].issue_id
        );
    }
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
    assert_eq!(grants.len(), checker_count);
    assert_eq!(grants.iter().collect::<BTreeSet<_>>().len(), checker_count);
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
