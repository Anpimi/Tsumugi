#![cfg(all(unix, feature = "core-adapter", feature = "javascript-conformance"))]
//! Maximum complete translation transport uses the actual captured Host and
//! checker. Per-entry ledger execution and desktop acceptance are separate.
use std::{path::PathBuf, sync::Arc};
use tsumugi_core::{
    ProjectMetadata, ProjectStore,
    content::{PluginTranslationSettings, SourceAdoptionHandler, SourceBundle, SourceSettings},
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/core_execution.rs"]
mod core_execution;
#[path = "support/runtime.rs"]
mod runtime_fixture;
use core_execution::{authorize, execute};

#[test]
fn maximum_complete_translation_transport_preserves_sdk_bytes_and_fixed_budgets() {
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
                review: Some(
                    tsumugi_core::content::SourceReviewBinding::capture(
                        &source_resource.review,
                        &source_producer
                            .execution_binding(Some(source_resource.declaration.profile.clone()))
                            .unwrap()
                            .environment,
                    )
                    .unwrap(),
                ),
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

    for key_length in [6, 48] {
        let mut pairs = vec![
            "\"MiXA\":\"\"".to_owned(),
            "\"Different\":\"\"".to_owned(),
            "\"Empty\":\"\"".to_owned(),
        ];
        pairs.extend((3..2000).map(|n| format!("\"k{n:04}{}\":\"\"", "x".repeat(key_length - 5))));
        let mut raw = format!("{{{}}}", pairs.join(","));
        raw.push_str(&" ".repeat(128 * 1024 - raw.len()));
        assert_eq!(raw.len(), 128 * 1024);
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
                sha256: sdk::payload_digest(&raw),
                utf8: raw,
            }],
        };
        let settings = PluginTranslationSettings {
            declaration: resource.declaration.clone(),
            checker: checker.execution_binding(Some(profile.clone())).unwrap(),
        };
        let input = settings
            .fixed_input(
                project,
                material.clone(),
                producer.execution_binding(Some(profile.clone())).unwrap(),
            )
            .unwrap();
        assert!(input.bytes().len() <= 1024 * 1024);
        authorize(&runtime, &mut store, &input);
        let result = execute(&mut runtime, &mut store, &input);
        let proposal =
            tsumugi_core::content::validate_plugin_translation_output(&input, &result).unwrap();
        assert_eq!(proposal.entries.len(), 2000);
        assert_eq!(proposal.artifacts, material.artifacts);
        assert_eq!(
            result
                .envelope()
                .output
                .as_ref()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(result.bytes().len() <= 2 * 1024 * 1024);
        let capture = store
            .capture_translation_validation(
                input.envelope().attempt_id,
                result.envelope().result_id,
            )
            .unwrap();
        let check_input = capture.check_input().clone();
        let expanded = translation_check_payload(&check_input).unwrap();
        assert_eq!(expanded.input, material);
        assert_eq!(expanded.proposal, proposal);
        assert!(check_input.bytes().len() <= 1024 * 1024);
        let mut absent_display = check_input.envelope().clone();
        absent_display.items[0].payload["entries"][0][5] = serde_json::Value::Null;
        absent_display.items[0].payload["entries"][0][2][1] = "utf16".into();
        let restored =
            translation_check_payload(&FixedInput::capture(absent_display).unwrap()).unwrap();
        assert_eq!(
            restored.proposal.entries[0].native_identity.display.source,
            None
        );
        assert_eq!(
            restored.proposal.entries[0].source.range.encoding,
            sdk::TextEncoding::Utf16
        );
        // Changing the version or dropping an entry never creates a complete
        // checker payload, even when the enclosing digest is recaptured.
        for field in ["version", "coverage"] {
            let mut invalid = check_input.envelope().clone();
            if field == "version" {
                invalid.items[0].payload["version"] = 2.into();
            } else {
                invalid.items[0].payload["entries"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            assert!(translation_check_payload(&FixedInput::capture(invalid).unwrap()).is_err());
        }
        let original = {
            let evidence = result.envelope().plugin.as_ref().unwrap();
            let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
                panic!("successful proposal required")
            };
            output.utf8.clone()
        };
        authorize(&runtime, &mut store, &check_input);
        let checked = execute(&mut runtime, &mut store, &check_input);
        // SDK request hashing covers the reconstructed complete contract on the
        // actual independent checker channel.
        let evidence = checked.envelope().plugin.as_ref().unwrap();
        let request = check_input
            .plugin_request(
                check_input.envelope().items[0].item_id,
                checked.envelope().dispatch_token,
                &evidence.channel,
            )
            .unwrap();
        assert_eq!(
            sdk::parse_translation_extraction_check_input(request.input.utf8.as_bytes()).unwrap(),
            expanded
        );
        assert_eq!(
            request.context.input_digest,
            sdk::payload_digest(&request.input.utf8)
        );
        let checker_bytes = checked.bytes().len();
        store
            .commit_translation_validation(capture.prepare(checked).unwrap())
            .unwrap();
        let projection = store
            .capture_translation_projection(
                input.envelope().attempt_id,
                result.envelope().result_id,
            )
            .unwrap();
        assert_eq!(projection.envelope().items.len(), 2000);
        assert_eq!(projection.envelope().units.len(), 2000);
        assert!(projection.bytes().len() <= 1024 * 1024);
        store.enqueue_read_only_execution(&projection).unwrap();
        assert_eq!(
            store
                .execution_attempt(projection.envelope().attempt_id, false)
                .unwrap()
                .items
                .len(),
            2000
        );
        assert!(
            store
                .translation_preview(projection.envelope().attempt_id, 0, 100, None)
                .is_err(),
            "queued entries cannot masquerade as a completed file"
        );
        let saved = store
            .execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let sdk::InvocationOutcome::Succeeded { output } =
            &saved.envelope().plugin.as_ref().unwrap().result.outcome
        else {
            panic!("original proposal required")
        };
        assert_eq!(output.utf8, original);
        let mut substituted = result.envelope().clone();
        substituted.output = Some(serde_json::json!([output.schema, "0".repeat(64)]));
        assert!(
            FixedResult::capture(substituted, &input, result.envelope().dispatch_token).is_err()
        );
        println!(
            "maximum key={key_length} raw=131072 entries=2000 producer_input={} sdk_proposal={} ledger_result={} check_input={} sdk_check={} checker_result={} projection_input={}",
            input.bytes().len(),
            original.len(),
            result.bytes().len(),
            check_input.bytes().len(),
            request.input.utf8.len(),
            checker_bytes,
            projection.bytes().len()
        );
        store
            .cancel_execution(projection.envelope().task_id, ExecutionId::new())
            .unwrap();
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
}
