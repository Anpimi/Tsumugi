#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! Complete translation evidence reaches the actual Core ledger and independent
//! Host checker. This does not stand in for per-entry or desktop adoption.
use std::{path::PathBuf, sync::Arc};
use tsumugi_core::{
    ProjectMetadata, ProjectStore, TranslationAdoptionHandler,
    content::{
        PluginTranslationSettings, SourceAdoptionHandler, SourceBundle, SourceSettings,
        TRANSLATION_EXTRACTION_OPERATION, validate_plugin_translation_output,
    },
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/core_execution.rs"]
mod core_execution;
#[path = "support/runtime.rs"]
mod runtime_fixture;
use core_execution::{authorize, execute};

struct CannotApprove;
impl ResultValidator for CannotApprove {
    fn operation(&self) -> &str {
        TRANSLATION_EXTRACTION_OPERATION
    }
    fn validate(&self, _: &FixedInput, _: &FixedResult) -> Result<(), ExecutionError> {
        panic!("generic validation must not approve plugin translation semantics")
    }
}

#[test]
fn complete_translation_requires_current_scope_independent_grants_and_saved_check_proof() {
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
        ProjectMetadata::create("Complete translation proof", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = store.metadata().unwrap().project_id();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for runner in [&source_producer, &source_checker, &producer, &checker] {
        runtime.register(runner.clone()).unwrap();
    }
    let source_bundle = SourceBundle::capture_declared(
        &source_resource,
        vec![
            br#"{"UniqueID":"Example.Mod","Name":"Test","Version":"1.0.0","EntryDll":"Test.dll"}"#
                .to_vec(),
            br#"{"MiXA":"same","Different":"same","Empty":""}"#.to_vec(),
        ],
        "en-US",
    )
    .unwrap();
    let profile = resource.declaration.profile.clone();
    let source_input = source_bundle
        .fixed_plugin_input(
            project,
            source_producer
                .execution_binding(Some(profile.clone()))
                .unwrap(),
            SourceSettings {
                revision_policy: source_resource.declaration.revision_policy.clone(),
                checker: Some(
                    source_checker
                        .execution_binding(Some(profile.clone()))
                        .unwrap(),
                ),
                semantic_rules: source_resource.declaration.semantic_rules.clone(),
            },
        )
        .unwrap();
    authorize(&runtime, &mut store, &source_input);
    let source_result = execute(&mut runtime, &mut store, &source_input);
    let source_capture = store
        .capture_source_validation(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
        )
        .unwrap();
    let check_input = source_capture.check_input().clone();
    authorize(&runtime, &mut store, &check_input);
    let checked = execute(&mut runtime, &mut store, &check_input);
    store
        .commit_source_validation(source_capture.prepare(checked).unwrap())
        .unwrap();
    let confirmation = store
        .source_preview(
            source_input.envelope().attempt_id,
            source_result.envelope().result_id,
            0,
            100,
        )
        .unwrap()
        .confirmation;
    let adoption = store
        .prepare_adoption(
            source_input.envelope().attempt_id,
            source_input.envelope().units[0].unit_id,
            vec![source_result.envelope().result_id],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&adoption, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let source = store.source_content(snapshot, 0, 100).unwrap();
    let native = source.rows[0].occurrence.native_identity.as_ref().unwrap();
    let raw = "\u{feff}{\r\n // original 中文 👩🏽‍💻\r\n \"mIxA\": \"你好 é\",\r\n \"Different\": \"你好 é\",\r\n \"Empty\": \"\",\r\n \"Unmatched\": \"未匹配\",\r\n}\r\n";
    let material = sdk::TranslationExtractionInput {
        profile: profile.clone(),
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
    let settings = PluginTranslationSettings {
        declaration: resource.declaration.clone(),
        checker: checker.execution_binding(Some(profile.clone())).unwrap(),
    };
    let producer_binding = producer.execution_binding(Some(profile.clone())).unwrap();
    assert_eq!(producer_binding.capability, resource.extractor);
    assert_eq!(settings.checker.capability, resource.checker);
    let fixed = |material| {
        settings
            .fixed_input(project, material, producer_binding.clone())
            .unwrap()
    };
    // These requests reach the actual mutation owner, after an explicit grant.
    // A valid SDK shape cannot invent current project scope or a target locale.
    for (field, expected_stage) in [
        ("locale", "translation-locale"),
        ("set", "translation-source-set"),
        ("snapshot", "translation-source"),
        ("namespace", "translation-native-scope"),
        ("policy", "translation-native-policy"),
    ] {
        let mut wrong = material.clone();
        match field {
            "locale" => wrong.target_language = "fr-FR".into(),
            "set" => wrong.source_set_id = ExecutionId::new().to_string(),
            "snapshot" => wrong.source_snapshot_id = ExecutionId::new().to_string(),
            "namespace" => wrong.native_scope.namespace = "Other.Mod".into(),
            "policy" => wrong.native_scope.policy.id = "other.native-policy".into(),
            _ => unreachable!(),
        }
        let wrong = fixed(wrong);
        authorize(&runtime, &mut store, &wrong);
        let error = runtime.submit(&mut store, &wrong).unwrap_err();
        assert_eq!(error.stage, expected_stage);
        assert!(store.execution_input(wrong.envelope().attempt_id).is_err());
    }
    let mut wrong_settings = settings.clone();
    wrong_settings.checker = source_checker.execution_binding(Some(profile)).unwrap();
    assert!(
        wrong_settings
            .fixed_input(project, material.clone(), producer_binding.clone())
            .is_err()
    );
    let input = fixed(material.clone());
    assert!(
        runtime.submit(&mut store, &input).is_err(),
        "data-only language evidence grants no execution"
    );
    authorize(&runtime, &mut store, &input);
    let result = execute(&mut runtime, &mut store, &input);
    let proposal = validate_plugin_translation_output(&input, &result).unwrap();
    assert_eq!(proposal.artifacts, material.artifacts);
    assert_eq!(proposal.entries.len(), 4);
    assert_eq!(
        proposal
            .entries
            .iter()
            .map(|e| e.text.as_str())
            .collect::<Vec<_>>(),
        ["你好 é", "你好 é", "", "未匹配"]
    );
    assert_eq!(proposal.entries[0].native_identity.value, "mixa");
    assert_eq!(proposal.entries[0].native_identity.display.value, "mIxA");
    assert_ne!(proposal.entries[0].id, proposal.entries[1].id);
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Pending
    );
    assert_eq!(
        store
            .capture_result_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap()
            .prepare(&CannotApprove)
            .err()
            .unwrap()
            .code,
        ErrorCode::Unauthorized
    );
    let capture = store
        .capture_translation_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let checker_input = capture.check_input().clone();
    assert!(
        runtime.submit(&mut store, &checker_input).is_err(),
        "producer consent cannot authorize its checker"
    );
    let checker_grant = authorize(&runtime, &mut store, &checker_input);
    let checked = execute(&mut runtime, &mut store, &checker_input);
    let prepared = capture.prepare(checked).unwrap();
    runtime.revoke_plugin(&mut store, checker_grant).unwrap();
    assert_eq!(
        store
            .commit_translation_validation(prepared)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Pending
    );
    let capture = store
        .capture_result_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap()
        .prepare_translation_check(ExecutionId::new())
        .unwrap();
    let checker_input = capture.check_input().clone();
    let typed: sdk::TranslationExtractionCheckInput =
        serde_json::from_value(checker_input.envelope().items[0].payload.clone()).unwrap();
    assert_eq!(typed.input, material);
    assert_eq!(typed.proposal, proposal);
    assert!(typed.requirements.iter().all(|r| r.mandatory
        && !r.waivable
        && r.targets == [proposal.import_id.clone()]
        && r.input_digest == input.digest()
        && r.scope_digest == result.digest()));
    authorize(&runtime, &mut store, &checker_input);
    let checked = execute(&mut runtime, &mut store, &checker_input);
    store
        .commit_translation_validation(capture.prepare(checked).unwrap())
        .unwrap();
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Valid
    );
    // The complete-file result does not masquerade as one per-entry import unit.
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::Value::Null,
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&action, &TranslationAdoptionHandler)
            .is_err()
    );
    assert!(
        store
            .translation_preview(input.envelope().attempt_id, 0, 100, None)
            .is_err()
    );
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    drop(store);
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Valid
    );
    let saved = reopened
        .execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(
        validate_plugin_translation_output(
            &reopened
                .execution_input(input.envelope().attempt_id)
                .unwrap(),
            &saved
        )
        .unwrap(),
        proposal
    );
    assert!(
        reopened
            .capture_translation_validation(
                input.envelope().attempt_id,
                result.envelope().result_id
            )
            .is_err(),
        "historical proof cannot reconstruct a live grant"
    );
    assert_eq!(
        reopened.content_scope().unwrap().current_snapshot,
        Some(snapshot)
    );
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
}
