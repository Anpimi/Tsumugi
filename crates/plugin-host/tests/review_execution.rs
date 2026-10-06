#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! Complete adopted source and actual authorized Review results through Core.
//! Automatic QA, human qualification and artifact proof remain distinct gates.
use std::sync::Arc;
use tsumugi_core::{
    PluginBuildLocaleChoice, ProjectMetadata, ProjectStore, ReleaseAdoptionHandler,
    ReleaseBuildEnvironment, ReleasePlan, SaveTranslationRevision,
    content::{SourceAdoptionHandler, SourceBundle, SourceReviewBinding, SourceSettings},
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/core_execution.rs"]
mod core_execution;
#[path = "support/official.rs"]
mod package_fixture;
#[path = "support/runtime.rs"]
mod runtime_fixture;
use core_execution::{authorize, execute, execute_all};
#[path = "../../core/tests/support/automatic.rs"]
mod automatic;

fn paired_core_review(plugin: &str, caption: bool, multiple: bool) {
    let directory = tempfile::tempdir().unwrap();
    let image = package_fixture::installed(directory.path(), plugin);
    let binding = image.source_import("source-profile").unwrap();
    let staging = directory.path().join("workers");
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
    let extractor = proxy(&binding.declaration.extractor);
    let source_checker = proxy(&binding.declaration.checker);
    let review_checker = proxy(&binding.review.declaration.checker);
    let path = directory.path().join("project");
    let languages = if multiple {
        vec!["zh-CN", "de", "fr"]
    } else {
        vec!["zh-CN"]
    };
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Actual domain review", "en-US", languages.iter().copied())
            .unwrap(),
    )
    .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(extractor.clone()).unwrap();
    runtime.register(source_checker.clone()).unwrap();
    runtime.register(review_checker.clone()).unwrap();
    let original = if caption {
        vec!["\u{feff}WEBVTT\r\n\r\nCue\r\n00:01.000 --> 00:02.000\r\nOriginal é 👩🏽‍💻\r\n\r\n"]
    } else {
        vec![
            "{\"UniqueID\":\"Example.Mod\",\"Name\":\"Test\",\"Version\":\"1.0.0\",\"EntryDll\":\"Test.dll\"}",
            "\u{feff}{\r\n\"first\":\"Hi {{name}} {{name}} é 👩🏽‍💻\"\r\n}\r\n",
        ]
    };
    let bundle = SourceBundle::capture_declared(
        &binding,
        original.iter().map(|s| s.as_bytes().to_vec()).collect(),
        "en-US",
    )
    .unwrap();
    let producer = extractor
        .execution_binding(Some(binding.declaration.profile.clone()))
        .unwrap();
    let review = SourceReviewBinding::capture(&binding.review, &producer.environment).unwrap();
    assert_eq!(
        review.checker,
        review_checker
            .execution_binding(Some(binding.declaration.profile.clone()))
            .unwrap()
    );
    let input = bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            producer,
            SourceSettings {
                revision_policy: binding.declaration.revision_policy.clone(),
                checker: Some(
                    source_checker
                        .execution_binding(Some(binding.declaration.profile.clone()))
                        .unwrap(),
                ),
                semantic_rules: binding.declaration.semantic_rules.clone(),
                review: Some(review),
            },
        )
        .unwrap();
    authorize(&runtime, &mut store, &input);
    let result = execute(&mut runtime, &mut store, &input);
    let source_check = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = source_check.check_input().clone();
    authorize(&runtime, &mut store, &check_input);
    let checked = execute(&mut runtime, &mut store, &check_input);
    store
        .commit_source_validation(source_check.prepare(checked).unwrap())
        .unwrap();
    let preview = store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            100,
        )
        .unwrap();
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let unit = store.source_content(snapshot, 0, 100).unwrap().rows[0]
        .unit_id
        .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let valid = if caption {
        "译文 é 👩🏽‍💻\n第二行"
    } else {
        "你好 {{name}} {{name}} é 👩🏽‍💻"
    };
    let bad = if caption { "a\n\nb" } else { "你好 {{name}}" };
    for (text, expected) in [
        (None, None),
        (Some(valid), None),
        (
            Some(bad),
            Some(if caption {
                "invalid-payload"
            } else {
                "marker-mismatch"
            }),
        ),
    ] {
        if let Some(text) = text {
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
                })
                .unwrap();
        }
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let prepared = store
            .prepare_review_check(project, unit, "zh-CN", &target.basis, ExecutionId::new())
            .unwrap();
        let plan = prepared.plan().unwrap();
        assert_eq!(
            plan.domain_input()
                .source
                .artifacts
                .iter()
                .map(|a| a.utf8.as_str())
                .collect::<Vec<_>>(),
            original
        );
        assert_eq!(
            plan.binding().checker,
            review_checker
                .execution_binding(Some(binding.declaration.profile.clone()))
                .unwrap()
        );
        let input = prepared.domain_execution_input(ExecutionId::new()).unwrap();
        assert_eq!(
            runtime.submit(&mut store, &input).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        authorize(&runtime, &mut store, &input);
        let result = execute(&mut runtime, &mut store, &input);
        let before = std::fs::read(path.join("project.sqlite3")).unwrap();
        let computed = store
            .capture_review_check_execution(
                prepared,
                input.envelope().attempt_id,
                result.envelope().result_id,
            )
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
        assert!(computed.coverage().complete);
        assert_eq!(
            computed.results().len(),
            computed.plan().fixed_checks().set().requirements.len()
        );
        assert_eq!(computed.domain_result().digest(), result.digest());
        let domain: Vec<_> = computed
            .results()
            .iter()
            .filter(|r| {
                matches!(
                    r.key.implementation,
                    sdk::CheckImplementation::Plugin { .. }
                )
            })
            .collect();
        assert_eq!(domain.len(), binding.review.declaration.rules.len());
        if text.is_none() {
            for (result, requirement) in domain
                .iter()
                .zip(&computed.plan().domain_input().requirements)
            {
                assert_eq!(
                    result.outcome,
                    requirement
                        .not_applicable
                        .clone()
                        .map_or(sdk::CheckOutcome::Completed { findings: vec![] }, |basis| {
                            sdk::CheckOutcome::NotApplicable { basis }
                        })
                );
            }
            assert_eq!(computed.core_rules()[0].findings[0].code, "missing");
        } else {
            let findings: Vec<_> = domain
                .iter()
                .flat_map(|r| match &r.outcome {
                    sdk::CheckOutcome::Completed { findings } => findings.clone(),
                    _ => panic!("present text must complete"),
                })
                .collect();
            if let Some(expected) = expected {
                assert!(
                    findings
                        .iter()
                        .any(|f| f.code == expected && f.severity == sdk::FindingSeverity::Error)
                );
            } else {
                assert!(findings.is_empty());
            }
            assert!(computed.core_rules().iter().all(|r| r.findings.is_empty()));
        }
        // A complete actual union, even a clean one, is not a saved QA receipt.
        assert!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_check
                .is_none()
        );
        if text.is_some() {
            let target = store.review_target(project, unit, "zh-CN").unwrap();
            store
                .write_review(&tsumugi_core::ReviewWrite {
                    project_id: project,
                    action_id: ExecutionId::new(),
                    unit_id: unit,
                    locale: "zh-CN".into(),
                    expected_basis: target.basis,
                    expected_decision_id: target.current_decision.map(|d| d.decision_id),
                    actor: "Synthetic reviewer".into(),
                    kind: tsumugi_core::ReviewDecisionKind::Approve,
                    reason: "QA fixture".into(),
                })
                .unwrap();
        }
        let run = store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap();
        assert_eq!(
            run.evidence.as_ref().unwrap().result_digest,
            result.digest()
        );
        assert_eq!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_check,
            Some(run)
        );
        let eligibility = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        if text.is_some() {
            let blockers: Vec<_> = eligibility.locales[0]
                .blockers
                .iter()
                .filter(|b| b.unit_id == unit)
                .collect();
            if expected.is_some() {
                assert!(blockers.iter().any(|b| b.code == "qa-issue"));
            } else {
                assert!(blockers.is_empty());
            }
        }
    }
    // The same installed checker evaluates a saved candidate before selection.
    // Clean QA selects atomically; bad domain output leaves that selection intact.
    let mut selected_receipt = None;
    for (text, clean) in [(valid, true), (bad, false)] {
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let protection = store.work_protection(unit, "zh-CN").unwrap();
        store
            .set_work_protection(&tsumugi_core::application::SetWorkProtection {
                action_id: ExecutionId::new(),
                project_id: project,
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                selection_id: target.selection_id,
                expected_revision: protection.revision,
                protected: false,
                confirmed_release: true,
            })
            .unwrap();
        let request = automatic::candidate_request(
            &mut store,
            unit,
            text,
            tsumugi_core::application::SelectionPolicy::ReplaceCapturedSelection,
        );
        let prepared = store.prepare_automatic_selection(&request).unwrap();
        let input = prepared
            .review_check()
            .unwrap()
            .domain_execution_input(ExecutionId::new())
            .unwrap();
        authorize(&runtime, &mut store, &input);
        let result = execute(&mut runtime, &mut store, &input);
        let computed = store
            .capture_automatic_selection_execution(
                prepared,
                input.envelope().attempt_id,
                result.envelope().result_id,
            )
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        let prior = store.review_target(project, unit, "zh-CN").unwrap();
        let receipt = store
            .commit_automatic_selection(computed, &Cancellation::default())
            .unwrap();
        assert_eq!(
            receipt.evidence.as_ref().unwrap().result_digest,
            result.digest()
        );
        let current = store.review_target(project, unit, "zh-CN").unwrap();
        if clean {
            assert!(receipt.blocked.is_none());
            assert_eq!(current.revision_id, Some(request.revision_id));
            assert_eq!(
                current.current_check.as_ref().unwrap().evidence,
                receipt.evidence
            );
            assert!(current.current_decision.is_none());
            selected_receipt = Some(receipt.clone());
        } else {
            assert_eq!(
                receipt.blocked,
                Some(tsumugi_core::application::AutomaticSelectionBlock::Checks)
            );
            assert!(receipt.selection.is_none() && receipt.check_run_id.is_none());
            assert_eq!(current.selection_id, prior.selection_id);
            assert_eq!(current.current_check, prior.current_check);
        }
        assert_eq!(
            store
                .automatic_selection_receipt(request.action_id)
                .unwrap(),
            Some(receipt)
        );
    }
    // Current automatic QA does not replace human approval or artifact proof.
    let build = image.build_declaration("build-profile").unwrap();
    runtime.register(proxy(&build.declaration.builder)).unwrap();
    runtime.register(proxy(&build.declaration.checker)).unwrap();
    let environment = ReleaseBuildEnvironment::new(
        build,
        runtime_fixture::approved_runtime().descriptor().clone(),
    )
    .unwrap();
    let output = if caption {
        "translated.vtt"
    } else {
        "i18n/zh.json"
    };
    let mut expected_outputs = vec![(
        "zh-CN",
        valid,
        output,
        if caption {
            "\u{feff}WEBVTT\r\n\r\nCue\r\n00:01.000 --> 00:02.000\r\n译文 é 👩🏽‍💻\r\n第二行\r\n\r\n"
        } else {
            "{\n  \"first\": \"你好 {{name}} {{name}} é 👩🏽‍💻\"\n}\n"
        },
    )];
    if multiple {
        expected_outputs.extend(if caption {
            vec![
                ("de", "Deutsch é 👩🏽‍💻\nZweite Zeile", "translated-de.vtt", "\u{feff}WEBVTT\r\n\r\nCue\r\n00:01.000 --> 00:02.000\r\nDeutsch é 👩🏽‍💻\r\nZweite Zeile\r\n\r\n"),
                ("fr", "Français é 👩🏽‍💻\nDeuxième ligne", "translated-fr.vtt", "\u{feff}WEBVTT\r\n\r\nCue\r\n00:01.000 --> 00:02.000\r\nFrançais é 👩🏽‍💻\r\nDeuxième ligne\r\n\r\n"),
            ]
        } else {
            vec![
                ("de", "Deutsch {{name}} {{name}} é 👩🏽‍💻", "i18n/de.json", "{\n  \"first\": \"Deutsch {{name}} {{name}} é 👩🏽‍💻\"\n}\n"),
                ("fr", "Français {{name}} {{name}} é 👩🏽‍💻", "i18n/fr.json", "{\n  \"first\": \"Français {{name}} {{name}} é 👩🏽‍💻\"\n}\n"),
            ]
        });
    }
    let choices: Vec<_> = expected_outputs
        .iter()
        .map(|(locale, _, path, _)| PluginBuildLocaleChoice {
            locale: (*locale).into(),
            output_paths: vec![(*path).into()],
            configuration: vec![],
        })
        .collect();
    let languages: Vec<String> = languages.into_iter().map(str::to_owned).collect();
    let eligibility = store.review_eligibility(project, &languages).unwrap();
    assert!(!eligibility.ready);
    assert!(
        store
            .prepare_plugin_build(
                project,
                ExecutionId::new(),
                &choices,
                &eligibility.basis,
                &environment
            )
            .is_err()
    );
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .write_review(&tsumugi_core::ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            expected_decision_id: None,
            actor: "Synthetic reviewer".into(),
            kind: tsumugi_core::ReviewDecisionKind::Approve,
            reason: "Approve the exact checked translation".into(),
        })
        .unwrap();
    for (locale, text, _, _) in expected_outputs.iter().skip(1) {
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: (*locale).into(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: target.selection_id,
                text: (*text).into(),
            })
            .unwrap();
        let target = store.review_target(project, unit, locale).unwrap();
        let prepared = store
            .prepare_review_check(project, unit, locale, &target.basis, ExecutionId::new())
            .unwrap();
        let domain = prepared.domain_execution_input(ExecutionId::new()).unwrap();
        authorize(&runtime, &mut store, &domain);
        let checked = execute(&mut runtime, &mut store, &domain);
        let computed = store
            .capture_review_check_execution(
                prepared,
                domain.envelope().attempt_id,
                checked.envelope().result_id,
            )
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        assert!(computed.coverage().complete);
        store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap();
        assert!(
            !store
                .review_eligibility(project, &[(*locale).into()])
                .unwrap()
                .ready,
            "QA does not grant human approval"
        );
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .write_review(&tsumugi_core::ReviewWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: (*locale).into(),
                expected_basis: target.basis,
                expected_decision_id: None,
                actor: "Synthetic reviewer".into(),
                kind: tsumugi_core::ReviewDecisionKind::Approve,
                reason: "Approve this exact locale".into(),
            })
            .unwrap();
    }
    let eligibility = store.review_eligibility(project, &languages).unwrap();
    assert!(eligibility.ready, "{eligibility:?}");
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices,
            &eligibility.basis,
            &environment,
        )
        .unwrap();
    let frozen = ReleasePlan::from_input(&input).unwrap();
    assert_eq!(frozen.eligibility_basis(), eligibility.basis);
    assert_eq!(frozen.choices(), choices);
    for (locale, text, _, _) in &expected_outputs {
        assert_eq!(frozen.plugin_input(locale).unwrap().targets[0].text, *text);
    }
    let producer_grant = authorize(&runtime, &mut store, &input);
    let results = execute_all(&mut runtime, &mut store, &input);
    assert_eq!(results.len(), expected_outputs.len());
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
    let mut check_grants = Vec::new();
    for (index, result) in results.iter().enumerate() {
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let check_input = capture.check_input().clone();
        let grant = authorize(&runtime, &mut store, &check_input);
        assert_ne!(producer_grant, grant);
        check_grants.push(grant);
        let checked = execute(&mut runtime, &mut store, &check_input);
        store
            .commit_artifact_validation(capture.prepare(checked).unwrap())
            .unwrap();
        if index + 1 < results.len() {
            assert!(
                store
                    .adopt_execution(&action, &ReleaseAdoptionHandler)
                    .is_err(),
                "missing one locale's proof blocks the whole release"
            );
            assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
            assert!(store.list_releases(project).unwrap().is_empty());
        }
    }
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    let release = ExecutionId::parse(&receipt.changes[0].id).unwrap();
    let released = store.release_view(release).unwrap();
    assert_eq!(released.artifacts.len(), expected_outputs.len());
    for (locale, _, path, expected) in &expected_outputs {
        assert_eq!(
            store
                .release_artifact_by_path(release, locale, path)
                .unwrap()
                .1,
            expected.as_bytes()
        );
    }
    // Later edits expire current QA without changing the frozen plan or release.
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id,
            text: bad.into(),
        })
        .unwrap();
    assert!(
        store
            .review_target(project, unit, "zh-CN")
            .unwrap()
            .current_check
            .is_none()
    );
    assert!(
        store
            .prepare_plugin_build(
                project,
                ExecutionId::new(),
                &choices,
                &eligibility.basis,
                &environment,
            )
            .is_err()
    );
    let current = store.review_eligibility(project, &languages).unwrap();
    assert!(
        current
            .locales
            .iter()
            .all(|locale| locale.ready == (locale.locale != "zh-CN"))
    );
    for (locale, text, _, _) in &expected_outputs {
        assert_eq!(frozen.plugin_input(locale).unwrap().targets[0].text, *text);
    }
    assert_eq!(store.release_view(release).unwrap(), released);
    runtime.revoke_plugin(&mut store, producer_grant).unwrap();
    for grant in check_grants {
        runtime.revoke_plugin(&mut store, grant).unwrap();
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert!(
        reopened
            .review_target(project, unit, "zh-CN")
            .unwrap()
            .current_check
            .is_none()
    );
    assert_eq!(reopened.release_view(release).unwrap(), released);
    assert_eq!(
        reopened.review_eligibility(project, &languages).unwrap(),
        current
    );
    for (locale, _, path, expected) in &expected_outputs {
        assert_eq!(
            reopened
                .release_artifact_by_path(release, locale, path)
                .unwrap()
                .1,
            expected.as_bytes()
        );
    }
    assert_eq!(
        reopened
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
        receipt
    );
    let selected_receipt = selected_receipt.unwrap();
    assert_eq!(
        reopened
            .automatic_selection_receipt(selected_receipt.request.action_id)
            .unwrap(),
        Some(selected_receipt)
    );
}

#[test]
fn stardew_smapi_core_review_uses_adopted_source_live_grant_and_actual_channel() {
    paired_core_review("stardew-smapi", false, false);
}
#[test]
fn webvtt_core_review_uses_adopted_source_live_grant_and_actual_channel() {
    paired_core_review("webvtt", true, false);
}

#[test]
fn stardew_smapi_multi_locale_release_keeps_independent_qa_and_complete_artifact_proof() {
    paired_core_review("stardew-smapi", false, true);
}

#[test]
fn webvtt_multi_locale_release_keeps_independent_qa_and_complete_artifact_proof() {
    paired_core_review("webvtt", true, true);
}
