#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! Actual captured builder/checker processes reach Core release persistence.
//! Domain byte expectations are literal; desktop interaction is a separate gate.
use std::{path::PathBuf, sync::Arc};
use tsumugi_core::{
    FallbackWrite, PluginBuildLocaleChoice, ProjectMetadata, ProjectStore, ReleaseAdoptionHandler,
    ReleaseBuildEnvironment, ReviewDecisionKind, ReviewWrite, SaveTranslationRevision,
    content::{SourceAdoptionHandler, SourceBundle, SourceSettings},
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
#[path = "support/core_execution.rs"]
mod core_execution;
#[path = "support/runtime.rs"]
mod runtime_fixture;
use core_execution::{authorize, execute, execute_all};

#[test]
fn captured_builders_need_each_locale_proof_and_preserve_original_release_after_reopen() {
    let selected = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
            .expect("explicit prebuilt package required"),
    );
    let digest =
        std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST").expect("independent fingerprint required");
    let image = PackageImage::capture_directory(&selected, &digest, || true).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let staging = directory.path().join("workers");
    std::fs::create_dir(&staging).unwrap();
    let environment = runtime_fixture::approved_runtime();
    let proxy = |name: &str| {
        Arc::new(
            RunnerProxy::new(
                image.clone(),
                name,
                environment.clone(),
                &staging,
                HostLimits::default(),
            )
            .unwrap(),
        )
    };
    let source = image.source_import("source-profile").unwrap();
    let build = image.build_declaration("build-profile").unwrap();
    let source_producer = proxy(&source.declaration.extractor);
    let source_checker = proxy(&source.declaration.checker);
    let builder = proxy(&build.declaration.builder);
    let checker = proxy(&build.declaration.checker);
    let path = directory.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Production release", "en-US", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&source_producer, &source_checker, &builder, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    let bundle = SourceBundle::capture_declared(
        &source,
        vec![
            br#"{"UniqueID":"Example.Mod","Name":"Test","Version":"1.0.0","EntryDll":"Test.dll"}"#
                .to_vec(),
            br#"{"MiXA":"same","Empty":""}"#.to_vec(),
        ],
        "en-US",
    )
    .unwrap();
    let profile = source.declaration.profile.clone();
    let input = bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            source_producer
                .execution_binding(Some(profile.clone()))
                .unwrap(),
            SourceSettings {
                revision_policy: source.declaration.revision_policy.clone(),
                checker: Some(source_checker.execution_binding(Some(profile)).unwrap()),
                semantic_rules: source.declaration.semantic_rules.clone(),
            },
        )
        .unwrap();
    authorize(&runtime, &mut store, &input);
    let result = execute(&mut runtime, &mut store, &input);
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    authorize(&runtime, &mut store, &check_input);
    let checked = execute(&mut runtime, &mut store, &check_input);
    store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let confirmation = store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap()
        .confirmation;
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    // Existing manual edit/review owners qualify exact current project text.
    // This is not an independent plugin translation-QA acceptance claim.
    for (locale, translated) in [
        ("zh-CN", "译文 👩🏽‍💻 e\u{301}"),
        ("fr-FR", "Traduit 👩🏽‍💻 e\u{301}"),
    ] {
        for row in store.review_page(project, locale, 0, 10).unwrap().rows {
            if row.native_key == "Empty" {
                // Empty source output is deliberate, through the current explicit
                // fallback policy. It must not silently waive empty-target QA.
                let target = store.review_target(project, row.unit_id, locale).unwrap();
                store
                    .allow_source_fallback(&FallbackWrite {
                        project_id: project,
                        action_id: ExecutionId::new(),
                        unit_id: row.unit_id,
                        locale: locale.into(),
                        expected_basis: target.basis,
                        allow: true,
                        expected_fallback_id: None,
                        actor: "Synthetic reviewer".into(),
                        reason: "Explicitly preserve this empty source value".into(),
                    })
                    .unwrap();
                let target = store.review_target(project, row.unit_id, locale).unwrap();
                store
                    .run_review_checks(
                        project,
                        row.unit_id,
                        locale,
                        &target.basis,
                        ExecutionId::new(),
                    )
                    .unwrap();
                continue;
            }
            let text = translated;
            store
                .save_translation_edit(&SaveTranslationRevision {
                    project_id: project,
                    action_id: ExecutionId::new(),
                    unit_id: row.unit_id,
                    locale: locale.into(),
                    source_revision_id: row.source_revision_id,
                    expected_selection_id: row.selection_id,
                    text: text.into(),
                })
                .unwrap();
            let target = store.review_target(project, row.unit_id, locale).unwrap();
            store
                .run_review_checks(
                    project,
                    row.unit_id,
                    locale,
                    &target.basis,
                    ExecutionId::new(),
                )
                .unwrap();
            let target = store.review_target(project, row.unit_id, locale).unwrap();
            store
                .write_review(&ReviewWrite {
                    project_id: project,
                    action_id: ExecutionId::new(),
                    unit_id: row.unit_id,
                    locale: locale.into(),
                    expected_basis: target.basis,
                    expected_decision_id: None,
                    actor: "Synthetic reviewer".into(),
                    kind: ReviewDecisionKind::Approve,
                    reason: String::new(),
                })
                .unwrap();
        }
    }
    let eligibility = store
        .review_eligibility(project, &["zh-CN".into(), "fr-FR".into()])
        .unwrap();
    assert!(eligibility.ready, "{eligibility:?}");
    let choices = vec![
        PluginBuildLocaleChoice {
            locale: "zh-CN".into(),
            output_paths: vec!["i18n/zh.json".into()],
            configuration: vec![],
        },
        PluginBuildLocaleChoice {
            locale: "fr-FR".into(),
            output_paths: vec!["i18n/fr.json".into()],
            configuration: vec![],
        },
    ];
    let build_environment =
        ReleaseBuildEnvironment::new(build, environment.descriptor().clone()).unwrap();
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices,
            &eligibility.basis,
            &build_environment,
        )
        .unwrap();
    let producer_grant = authorize(&runtime, &mut store, &input);
    let results = execute_all(&mut runtime, &mut store, &input);
    let ids = results
        .iter()
        .map(|r| r.envelope().result_id)
        .collect::<Vec<_>>();
    let unit = input.envelope().units[0].unit_id;
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            unit,
            ids,
            serde_json::json!({}),
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .is_err()
    );
    assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
    assert!(
        store
            .list_releases(input.envelope().project_id)
            .unwrap()
            .is_empty()
    );
    let mut check_grants = Vec::new();
    for (index, result) in results.iter().enumerate() {
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let check_input = capture.check_input().clone();
        let grant = authorize(&runtime, &mut store, &check_input);
        assert_ne!(grant, producer_grant);
        let checked = execute(&mut runtime, &mut store, &check_input);
        store
            .commit_artifact_validation(capture.prepare(checked).unwrap())
            .unwrap();
        check_grants.push(grant);
        if index == 0 {
            assert!(
                store
                    .adopt_execution(&action, &ReleaseAdoptionHandler)
                    .is_err()
            );
            assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
            assert!(
                store
                    .list_releases(input.envelope().project_id)
                    .unwrap()
                    .is_empty()
            );
        }
    }
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    assert_eq!(receipt.changes.len(), 1);
    let release = ExecutionId::parse(&receipt.changes[0].id).unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
        receipt
    );
    let original = store.release_view(release).unwrap();
    assert_eq!(original.artifacts.len(), 2);
    assert_eq!(original.exceptions.len(), 2);
    assert!(
        original
            .exceptions
            .iter()
            .all(|e| e.kind == tsumugi_core::ReleaseExceptionKind::SourceFallback)
    );
    let expected = [
        (
            "zh-CN",
            "i18n/zh.json",
            "{\n  \"MiXA\": \"译文 👩🏽‍💻 e\u{301}\",\n  \"Empty\": \"\"\n}\n",
        ),
        (
            "fr-FR",
            "i18n/fr.json",
            "{\n  \"MiXA\": \"Traduit 👩🏽‍💻 e\u{301}\",\n  \"Empty\": \"\"\n}\n",
        ),
    ];
    for (locale, name, expected) in expected {
        let (metadata, bytes) = store
            .release_artifact_by_path(release, locale, name)
            .unwrap();
        assert_eq!(bytes, expected.as_bytes());
        assert_eq!(
            metadata.sha256,
            tsumugi_plugin_sdk::payload_digest(expected)
        );
    }
    let row = store
        .review_page(project, "zh-CN", 0, 10)
        .unwrap()
        .rows
        .remove(0);
    store
        .save_translation_edit(&SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: row.unit_id,
            locale: "zh-CN".into(),
            source_revision_id: row.source_revision_id,
            expected_selection_id: row.selection_id,
            text: "Later project edit".into(),
        })
        .unwrap();
    assert_eq!(store.release_view(release).unwrap(), original);
    runtime.revoke_plugin(&mut store, producer_grant).unwrap();
    for grant in check_grants {
        runtime.revoke_plugin(&mut store, grant).unwrap();
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.release_view(release).unwrap(), original);
    assert_eq!(
        reopened
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
        receipt
    );
    for (locale, name, expected) in expected {
        assert_eq!(
            reopened
                .release_artifact_by_path(release, locale, name)
                .unwrap()
                .1,
            expected.as_bytes()
        );
    }
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
}
