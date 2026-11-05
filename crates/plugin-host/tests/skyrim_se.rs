#![cfg(all(unix, feature = "core-adapter"))]
//! A prebuilt Skyrim SE package, real format subprocess and normal Core ledger.
//! Synthetic fixtures are explicit external inputs; no domain source is linked.
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tsumugi_core::{
    PluginBuildLocaleChoice, ProjectMetadata, ProjectStore, ReleaseAdoptionHandler,
    ReleaseBuildEnvironment, ReviewDecisionKind, ReviewWrite, SaveTranslationRevision,
    content::{SourceAdoptionHandler, SourceBundle, SourceReviewBinding, SourceSettings},
    execution::*,
};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/core_execution.rs"]
mod core_execution;
use core_execution::{authorize, execute};

#[path = "support/official.rs"]
mod official;

fn runtime() -> CapturedNativeRuntime {
    let approval = CapturedNativeRuntime::inspect_current().unwrap();
    println!(
        "skyrim_native_environment={}",
        json!({"descriptor":&approval,"digest":approval.digest().unwrap()})
    );
    CapturedNativeRuntime::capture(&approval).unwrap()
}
fn installed(root: &std::path::Path) -> PackageImage {
    official::installed(root, "skyrim-se")
}
fn fixture(directory: &str, localized: bool, mcm: bool) -> sdk::SourceExtractionInput {
    let root = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_SKYRIM_FIXTURES")
            .expect("explicit synthetic format fixtures required"),
    )
    .join(directory);
    let mut paths = vec![("FormatProbe.esp".to_owned(), "plugin")];
    if localized {
        for extension in ["STRINGS", "DLSTRINGS", "ILSTRINGS"] {
            paths.push((
                format!("Strings/FormatProbe_English.{extension}"),
                "strings",
            ));
        }
    }
    let mut artifacts = paths
        .into_iter()
        .enumerate()
        .map(|(index, (path, role))| {
            sdk::CapturedArtifact::from_bytes(
                format!("capture-{index}"),
                path.clone(),
                role.into(),
                &std::fs::read(root.join(path)).unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    if mcm {
        let bytes: Vec<_> = [
            vec![0xff, 0xfe],
            "$TITLE\tStar {$BASE}\r\n$KEEP\tOriginal\r\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        ]
        .concat();
        artifacts.push(
            sdk::CapturedArtifact::from_bytes(
                "mcm".into(),
                "Interface/Translations/Example_english.txt".into(),
                "mcm".into(),
                &bytes,
            )
            .unwrap(),
        );
    }
    sdk::SourceExtractionInput {
        profile: sdk::ContractRef {
            id: "skyrim-se-mod".into(),
            schema_version: 1,
            behavior_version: 1,
        },
        source_set_id: "captured-mod".into(),
        source_language: "en-US".into(),
        artifacts,
    }
}
fn configuration(binding: &sdk::BuildBinding) -> Vec<sdk::EncodedPayload> {
    binding
        .declaration
        .capture_configuration(&[sdk::BuildConfigurationSelection {
            schema: binding.declaration.configuration.as_ref().unwrap()[0]
                .schema
                .clone(),
            selections: vec![sdk::BuildOptionSelection {
                id: "loading-language".into(),
                value: "selected".into(),
            }],
        }])
        .unwrap()
}
fn requirement(
    rule: sdk::ContractRef,
    binding: &sdk::CapabilityBinding,
    targets: Vec<String>,
) -> sdk::CheckRequirement {
    sdk::CheckRequirement {
        key: sdk::CheckKey {
            rule,
            implementation: sdk::CheckImplementation::Plugin {
                provider: binding.provider.clone(),
            },
        },
        input_digest: sdk::payload_digest("independently fixed material"),
        scope_digest: sdk::payload_digest("independently fixed targets"),
        targets,
        mandatory: true,
        waivable: false,
        not_applicable: None,
    }
}
fn request(
    session: &ProcessSession,
    binding: &sdk::CapabilityBinding,
    payload: serde_json::Value,
) -> sdk::InvocationRequest {
    let input = sdk::EncodedPayload::capture(
        binding.declaration.input_schema.clone(),
        payload.to_string(),
    )
    .unwrap();
    sdk::InvocationRequest {
        context: sdk::InvocationContext {
            project_id: "project".into(),
            operation_id: "catalog-operation".into(),
            attempt_id: "attempt".into(),
            item_id: "item".into(),
            dispatch_id: "dispatch".into(),
            scope_id: "project".into(),
            input_digest: input.sha256.clone(),
            scope_digest: sdk::payload_digest("captured scope"),
            environment_digest: session.environment_digest().unwrap().into(),
            configuration_digest: sdk::payload_digest("no configuration"),
        },
        provider: session
            .channel()
            .provider(&binding.provider.contribution_id)
            .unwrap(),
        capability: binding.declaration.contract.clone(),
        profile: Some(binding.declaration.profiles[0].clone()),
        input,
        output_schema: binding.declaration.output_schema.clone(),
        error_schema: binding.declaration.error_schema.clone(),
        // The declaration bounds unescaped payload bytes; this allowance is
        // for the complete quoted JSON result, as in Core's existing adapter.
        max_result_bytes: binding.declaration.limits.max_output_bytes * 2 + 32 * 1024,
    }
}
async fn launch(
    image: &PackageImage,
    binding: &sdk::CapabilityBinding,
    stage: &std::path::Path,
    runtime: &CapturedNativeRuntime,
) -> ProcessSession {
    ProcessSession::launch(
        image,
        &binding.provider.contribution_id,
        stage,
        &RuntimeLauncher::NativeCore {
            runtime: runtime.clone(),
        },
        LaunchOptions {
            scope: tsumugi_plugin_host::SessionScope::Bound(ScopeBinding {
                project_id: "project".into(),
                scope_id: "project".into(),
            }),
            allow_unsandboxed_execution: true,
            limits: HostLimits::default(),
        },
        || true,
    )
    .await
    .unwrap()
}
async fn call(
    image: &PackageImage,
    binding: &sdk::CapabilityBinding,
    payload: serde_json::Value,
    runtime: &CapturedNativeRuntime,
) -> sdk::InvocationOutcome {
    let stage = tempfile::tempdir().unwrap();
    let mut session = launch(image, binding, stage.path(), runtime).await;
    let request = request(&session, binding, payload);
    let received = session
        .invoke(&request, || false, || true)
        .await
        .unwrap_or_else(|error| {
            panic!(
                "{} ({} input bytes): {error:?}",
                binding.provider.contribution_id,
                request.input.utf8.len()
            )
        });
    assert_eq!(received.result().context, request.context);
    assert_eq!(
        received.result().provider,
        session
            .channel()
            .provider(&binding.provider.contribution_id)
            .unwrap()
    );
    assert_eq!(received.channel().provider.selection(), binding.provider);
    assert!(received.channel().child_pid > 0);
    session.heartbeat().await.unwrap();
    let closed = session.close().await;
    assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    received.result().outcome.clone()
}
fn success(outcome: sdk::InvocationOutcome) -> sdk::EncodedPayload {
    let sdk::InvocationOutcome::Succeeded { output } = outcome else {
        panic!("expected independent domain success: {outcome:?}")
    };
    output
}
fn capture_summary(content: &sdk::ContentExchange) -> sdk::SourceCaptureSummary {
    let block = content
        .domain_blocks
        .iter()
        .find(|block| block.schema == sdk::source_capture_summary_contract())
        .expect("the installed worker must emit the shared summary");
    sdk::parse_source_capture_summary_block(block, &content.artifacts).unwrap()
}
fn assert_capture_page(
    page: &tsumugi_core::content::ContentPage,
    summary: &sdk::SourceCaptureSummary,
) {
    assert_eq!(page.capture_summary.as_ref(), Some(summary));
    assert_eq!(page.coverage.len(), 1);
    assert_eq!(summary.materials.len(), 1);
    assert_eq!(page.coverage[0].logical_path, "FormatProbe.esp");
    assert_eq!(
        summary.materials[0].source.artifact_id,
        page.coverage[0].artifact_id.to_string()
    );
}
fn check_output(
    payload: sdk::EncodedPayload,
    required: &[sdk::CheckRequirement],
    expected_findings: usize,
) {
    assert_eq!(payload.schema, sdk::check_results_contract());
    let results = sdk::parse_check_results(payload.utf8.as_bytes()).unwrap();
    assert_eq!(results.len(), required.len());
    let mut findings = 0;
    for result in results {
        let fixed = required.iter().find(|r| r.key == result.key).unwrap();
        assert_eq!(result.input_digest, fixed.input_digest);
        assert_eq!(result.scope_digest, fixed.scope_digest);
        assert_eq!(result.covered_targets, fixed.targets);
        let sdk::CheckOutcome::Completed { findings: actual } = result.outcome else {
            panic!("checker must complete")
        };
        assert!(
            actual
                .iter()
                .all(|finding| finding.severity == sdk::FindingSeverity::Error)
        );
        findings += actual.len();
    }
    assert_eq!(findings, expected_findings);
}

#[tokio::test]
#[ignore = "requires an inspected prebuilt Skyrim SE package and synthetic fixtures"]
async fn installed_skyrim_package_runs_mixed_and_capacity_material_through_all_five_operations() {
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let environment = runtime();
    let source_binding = image.source_import("source-profile").unwrap();
    let build_binding = image.build_declaration("build-profile").unwrap();
    for (directory, localized, mcm, units) in [
        ("coverage-shared", true, true, 12),
        ("capacity-238-escaped", false, false, 476),
    ] {
        let captured = fixture(directory, localized, mcm);
        let extracted = success(
            call(
                &image,
                &source_binding.extractor,
                json!(captured),
                &environment,
            )
            .await,
        );
        let content = sdk::parse_content_exchange(extracted.utf8.as_bytes()).unwrap();
        sdk::validate_source_extraction(&captured, &content).unwrap();
        assert_eq!(content.units.len(), units);
        let summary = capture_summary(&content);
        assert_eq!(summary.materials.len(), if mcm { 2 } else { 1 });
        for material in &summary.materials {
            let source = captured
                .artifacts
                .iter()
                .find(|artifact| artifact.id() == material.source.artifact_id)
                .unwrap();
            assert_eq!(material.source.range.encoding, sdk::SourceEncoding::RawByte);
            assert_eq!(material.source.range.start, 0);
            assert_eq!(
                material.source.range.end as usize,
                source.validated_bytes().unwrap().len()
            );
            if source.role() == "mcm" {
                assert_eq!(
                    material.counts,
                    sdk::SourceCaptureCounts {
                        items: 2,
                        items_with_fields: 2,
                        declared_fields: 2,
                        non_empty_fields: 2,
                    }
                );
            }
        }
        let required = vec![requirement(
            source_binding.declaration.semantic_rules[0].clone(),
            &source_binding.checker,
            vec![captured.source_set_id.clone()],
        )];
        let check = sdk::SourceExtractionCheckInput {
            source: captured.clone(),
            proposal: content.clone(),
            requirements: required.clone(),
        };
        check_output(
            success(call(&image, &source_binding.checker, json!(check), &environment).await),
            &required,
            0,
        );
        let targets: Vec<_> = content
            .units
            .iter()
            .map(|unit| sdk::BuildTarget {
                unit_id: unit.id.clone(),
                source_revision_id: unit.source_revision_id.clone(),
                text: unit
                    .text
                    .replace("Chapter", "章节 — é")
                    .replace("Shared name — 星", "共享名称 — é")
                    .replace("A story — 星", "新故事 — é 👩🏽‍💻")
                    .replace("Étoile — 星 👩🏽‍💻", "新故事 — é 👩🏽‍💻")
                    .replace("Star {$BASE}", "星 {$BASE}"),
            })
            .collect();
        let review_required: Vec<_> = source_binding
            .review
            .declaration
            .rules
            .iter()
            .map(|rule| {
                requirement(
                    rule.rule.clone(),
                    &source_binding.review.checker,
                    targets
                        .iter()
                        .map(|target| target.unit_id.clone())
                        .collect(),
                )
            })
            .collect();
        let review = sdk::ReviewCheckInput {
            source: content.clone(),
            target_language: "zh-CN".into(),
            selections: targets
                .iter()
                .map(|target| sdk::ReviewSelection {
                    unit_id: target.unit_id.clone(),
                    source_revision_id: target.source_revision_id.clone(),
                    translation_text: Some(target.text.clone()),
                })
                .collect(),
            requirements: review_required.clone(),
        };
        check_output(
            success(
                call(
                    &image,
                    &source_binding.review.checker,
                    json!(review),
                    &environment,
                )
                .await,
            ),
            &review_required,
            0,
        );
        let input = sdk::BuildInput {
            source: content,
            target_language: "zh-CN".into(),
            targets,
            output_paths: captured
                .artifacts
                .iter()
                .map(|artifact| artifact.logical_path().to_owned())
                .collect(),
            configuration: configuration(&build_binding),
            output_limits: build_binding.declaration.output_limits.clone(),
        };
        build_binding.validate_input(&input).unwrap();
        let built = success(call(&image, &build_binding.builder, json!(input), &environment).await);
        let output = sdk::parse_artifact_set(built.utf8.as_bytes()).unwrap();
        build_binding.validate_artifacts(&input, &output).unwrap();
        let required = vec![requirement(
            build_binding.declaration.artifact_rules[0].clone(),
            &build_binding.checker,
            output
                .artifacts
                .iter()
                .map(|artifact| artifact.id().to_owned())
                .collect(),
        )];
        let check = sdk::ArtifactCheckInput {
            input: input.clone(),
            output: output.clone(),
            requirements: required.clone(),
        };
        let bytes = serde_json::to_vec(&check).unwrap().len();
        if !localized {
            assert!(bytes > 8 * 1024 * 1024);
        }
        check_output(
            success(call(&image, &build_binding.checker, json!(check), &environment).await),
            &required,
            0,
        );
        let mut rebuilt = captured.clone();
        rebuilt.artifacts = output.artifacts.clone();
        let reread = sdk::parse_content_exchange(
            success(
                call(
                    &image,
                    &source_binding.extractor,
                    json!(rebuilt),
                    &environment,
                )
                .await,
            )
            .utf8
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(reread.units.len(), units);
        for target in &input.targets {
            assert_eq!(
                reread
                    .units
                    .iter()
                    .find(|unit| unit.id == target.unit_id)
                    .unwrap()
                    .text,
                target.text
            );
        }
        if localized {
            let mut missing = captured;
            missing
                .artifacts
                .retain(|artifact| !artifact.logical_path().ends_with(".DLSTRINGS"));
            let sdk::InvocationOutcome::Failed { error } = call(
                &image,
                &source_binding.extractor,
                json!(missing),
                &environment,
            )
            .await
            else {
                panic!("missing required Strings table accepted")
            };
            let error = sdk::parse_source_extraction_error(error.utf8.as_bytes()).unwrap();
            assert_eq!(error.code, sdk::SourceExtractionErrorCode::InvalidSource);
            assert!(error.detail.contains("DLSTRINGS") && error.detail.contains("Capture"));
        } else {
            let mut tampered = check;
            let artifact = &output.artifacts[0];
            tampered.output.artifacts[0] = sdk::CapturedArtifact::from_bytes(
                artifact.id().into(),
                artifact.logical_path().into(),
                artifact.role().into(),
                &captured.artifacts[0].validated_bytes().unwrap(),
            )
            .unwrap();
            check_output(
                success(
                    call(
                        &image,
                        &build_binding.checker,
                        json!(tampered),
                        &environment,
                    )
                    .await,
                ),
                &required,
                1,
            );
        }
        println!(
            "skyrim_installed_capacity={}",
            json!({"fixture":directory,"fields":units,"artifactCheckInputBytes":bytes})
        );
    }
}

fn fixed_source(
    store: &ProjectStore,
    source_binding: &sdk::SourceImportBinding,
    extractor: &RunnerProxy,
    checker: &RunnerProxy,
    bytes: Vec<u8>,
) -> FixedInput {
    let producer = extractor
        .execution_binding(Some(source_binding.declaration.profile.clone()))
        .unwrap();
    let bundle = SourceBundle::capture_selected(
        source_binding,
        &[sdk::SourceFileSetSelection {
            id: "plugin".into(),
            logical_paths: vec!["FormatProbe.esp".into()],
        }],
        vec![bytes],
        "en-US",
    )
    .unwrap();
    bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            producer.clone(),
            SourceSettings {
                native_start: None,
                revision_policy: source_binding.declaration.revision_policy.clone(),
                checker: Some(
                    checker
                        .execution_binding(Some(source_binding.declaration.profile.clone()))
                        .unwrap(),
                ),
                semantic_rules: source_binding.declaration.semantic_rules.clone(),
                review: Some(
                    SourceReviewBinding::capture(
                        &source_binding.review,
                        &tsumugi_core::execution::PluginExecutionBinding {
                            component_scope: sdk::ComponentScope::Project,
                            application_scope: None,
                            capability: (&source_binding.review).checker.clone(),
                            profile: Some((&source_binding.review).declaration.profile.clone()),
                            environment: (*(&producer.environment)).clone().into(),
                        },
                    )
                    .unwrap(),
                ),
            },
        )
        .unwrap()
}

struct AdoptedSource {
    snapshot: ExecutionId,
    grants: Vec<ExecutionId>,
    extracted: FixedResult,
    check_input_bytes: usize,
    preview_summary: sdk::SourceCaptureSummary,
}
fn adopt_source(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    input: &FixedInput,
) -> AdoptedSource {
    assert_eq!(
        runtime.submit(store, input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let mut grants = vec![authorize(runtime, store, input)];
    let extracted = execute(runtime, store, input);
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Pending
    );
    let preview = store
        .source_preview(
            input.envelope().attempt_id,
            extracted.envelope().result_id,
            0,
            100,
        )
        .unwrap();
    let preview_summary = preview
        .capture_summary
        .clone()
        .expect("Core must project the captured worker summary before adoption");
    assert_capture_page(&preview, &preview_summary);
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![extracted.envelope().result_id],
            json!(preview.confirmation),
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .is_err()
    );
    assert!(store.content_scope().unwrap().current_snapshot.is_none());
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, extracted.envelope().result_id)
        .unwrap();
    let check = capture.check_input().clone();
    let check_input_bytes = check.bytes().len();
    grants.push(authorize(runtime, store, &check));
    let checked = execute(runtime, store, &check);
    store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    AdoptedSource {
        snapshot,
        grants,
        extracted,
        check_input_bytes,
        preview_summary,
    }
}

#[test]
#[ignore = "requires an explicitly reviewed prebuilt Skyrim SE package and synthetic fixtures"]
fn skyrim_normal_core_keeps_binary_source_review_release_and_reopen_evidence() {
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let environment = runtime();
    let source_binding = image.source_import("source-profile").unwrap();
    let build_binding = image.build_declaration("build-profile").unwrap();
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
    let extractor = proxy(&source_binding.declaration.extractor);
    let checker = proxy(&source_binding.declaration.checker);
    let review_checker = proxy(&source_binding.review.declaration.checker);
    let builder = proxy(&build_binding.declaration.builder);
    let artifact_checker = proxy(&build_binding.declaration.checker);
    let path = root.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create("Synthetic Skyrim SE package", "en-US", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for proxy in [
        &extractor,
        &checker,
        &review_checker,
        &builder,
        &artifact_checker,
    ] {
        runtime.register(proxy.clone()).unwrap();
    }
    let captured = fixture("source", false, false);
    let original = captured.artifacts[0]
        .validated_bytes()
        .unwrap()
        .into_owned();
    let external = root.path().join("selected-original.esp");
    std::fs::write(&external, &original).unwrap();
    let input = fixed_source(
        &store,
        &source_binding,
        &extractor,
        &checker,
        std::fs::read(&external).unwrap(),
    );
    std::fs::write(&external, b"changed outside the captured snapshot").unwrap();
    let AdoptedSource {
        snapshot,
        mut grants,
        extracted,
        preview_summary,
        ..
    } = adopt_source(&mut store, &mut runtime, &input);
    let sdk::InvocationOutcome::Succeeded { output } =
        &extracted.envelope().plugin.as_ref().unwrap().result.outcome
    else {
        panic!("expected captured domain content")
    };
    let content = sdk::parse_content_exchange(output.utf8.as_bytes()).unwrap();
    let summary = capture_summary(&content);
    assert_eq!(preview_summary, summary);
    assert_eq!(
        summary.materials[0].counts,
        sdk::SourceCaptureCounts {
            items: 1,
            items_with_fields: 1,
            declared_fields: 1,
            non_empty_fields: 1,
        }
    );
    assert_eq!(summary.materials[0].source.range.end as usize, original.len());
    let page = store.source_content(snapshot, 0, 100).unwrap();
    assert_capture_page(&page, &summary);
    let coverage = page.coverage;
    let rows = page.rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].occurrence.text, "Original token");
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    for row in &rows {
        let text = "译名 — é 👩🏽‍💻";
        let unit = row.unit_id.unwrap();
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
        let inputs = prepared.execution_inputs();
        assert_eq!(inputs.len(), 1, "format-only review has one checker input");
        let input = inputs[0].clone();
        prepared.validate_execution_input(&input).unwrap();
        grants.push(authorize(&runtime, &mut store, &input));
        let result = execute(&mut runtime, &mut store, &input);
        let origin = tsumugi_core::ReviewCheckOrigin {
            checker: prepared.plan().unwrap().checkers()[0].key.clone(),
            attempt_id: input.envelope().attempt_id,
            result_id: result.envelope().result_id,
        };
        assert_eq!(
            store
                .capture_review_check_execution(prepared.clone(), &[])
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch,
            "every selected checker requires its actual origin"
        );
        let computed = store
            .capture_review_check_execution(prepared, &[origin])
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        assert!(computed.coverage().complete);
        assert!(computed.core_rules().iter().all(|r| r.findings.is_empty()));
        assert!(computed.results().iter().all(|r| matches!(&r.outcome, sdk::CheckOutcome::Completed { findings } if findings.is_empty())));
        store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap();
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready,
            "QA does not grant human approval"
        );
        let target = store.review_target(project, unit, "zh-CN").unwrap();
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
                reason: "Approve the exact independently checked target".into(),
            })
            .unwrap();
    }
    let eligibility = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap();
    assert!(eligibility.ready);
    let release_environment = ReleaseBuildEnvironment::new(
        build_binding.clone(),
        builder
            .execution_binding(Some(build_binding.declaration.profile.clone()))
            .unwrap(),
        artifact_checker
            .execution_binding(Some(build_binding.declaration.profile.clone()))
            .unwrap(),
    )
    .unwrap();
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &[PluginBuildLocaleChoice {
                locale: "zh-CN".into(),
                output_paths: vec!["FormatProbe.esp".into()],
                configuration: configuration(&build_binding),
            }],
            &eligibility.basis,
            &release_environment,
        )
        .unwrap();
    grants.push(authorize(&runtime, &mut store, &input));
    let built = execute(&mut runtime, &mut store, &input);
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
            .is_err()
    );
    assert!(store.list_releases(project).unwrap().is_empty());
    let capture = store
        .capture_artifact_validation(input.envelope().attempt_id, built.envelope().result_id)
        .unwrap();
    let check = capture.check_input().clone();
    grants.push(authorize(&runtime, &mut store, &check));
    let checked = execute(&mut runtime, &mut store, &check);
    let result_id = checked.envelope().result_id;
    let attempt = check.envelope().attempt_id;
    let original_result = checked.bytes().to_vec();
    store
        .commit_artifact_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    let release = ExecutionId::parse(&receipt.changes[0].id).unwrap();
    let released = store.release_view(release).unwrap();
    let released_bytes = store
        .release_artifact_by_path(release, "zh-CN", "FormatProbe.esp")
        .unwrap()
        .1;
    assert_ne!(released_bytes, original);
    assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    for grant in grants {
        runtime.revoke_plugin(&mut store, grant).unwrap();
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    let source_page = reopened.source_content(snapshot, 0, 100).unwrap();
    assert_capture_page(&source_page, &summary);
    assert_eq!(source_page.coverage, coverage);
    assert_eq!(source_page.rows, rows);
    assert_eq!(reopened.release_view(release).unwrap(), released);
    assert_eq!(
        reopened
            .release_artifact_by_path(release, "zh-CN", "FormatProbe.esp")
            .unwrap()
            .1,
        released_bytes
    );
    assert_eq!(
        reopened
            .execution_result(attempt, result_id)
            .unwrap()
            .bytes(),
        original_result
    );
    assert_eq!(
        reopened
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
        receipt
    );
    let mut rebuilt = captured;
    rebuilt.artifacts = vec![
        sdk::CapturedArtifact::from_bytes(
            "release-plugin".into(),
            "FormatProbe.esp".into(),
            "plugin".into(),
            &released_bytes,
        )
        .unwrap(),
    ];
    let reread = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(call(
            &image,
            &source_binding.extractor,
            json!(rebuilt),
            &environment,
        ));
    let content = sdk::parse_content_exchange(success(reread).utf8.as_bytes()).unwrap();
    assert_eq!(content.units.len(), 1);
    assert_eq!(content.units[0].text, "译名 — é 👩🏽‍💻");
}

#[test]
#[ignore = "requires an inspected prebuilt Skyrim SE package and capacity fixtures"]
fn skyrim_normal_core_adopts_maximum_escaped_capture_and_reopens_every_field() {
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let environment = runtime();
    let source_binding = image.source_import("source-profile").unwrap();
    let build_binding = image.build_declaration("build-profile").unwrap();
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
    let extractor = proxy(&source_binding.declaration.extractor);
    let checker = proxy(&source_binding.declaration.checker);
    let review_checker = proxy(&source_binding.review.declaration.checker);
    let builder = proxy(&build_binding.declaration.builder);
    let artifact_checker = proxy(&build_binding.declaration.checker);
    let path = root.path().join("project");
    let mut store = ProjectStore::create(
        &path,
        ProjectMetadata::create(
            "Synthetic full-capacity Skyrim SE package",
            "en-US",
            ["zh-CN"],
        )
        .unwrap(),
    )
    .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    for proxy in [
        &extractor,
        &checker,
        &review_checker,
        &builder,
        &artifact_checker,
    ] {
        runtime.register(proxy.clone()).unwrap();
    }
    let captured = fixture("capacity-238-escaped", false, false);
    let original = captured.artifacts[0]
        .validated_bytes()
        .unwrap()
        .into_owned();
    assert_eq!(original.len(), 1977864);
    let input = fixed_source(
        &store,
        &source_binding,
        &extractor,
        &checker,
        original.clone(),
    );
    assert!(input.bytes().len() > 2 * 1024 * 1024);
    eprintln!(
        "capacity Core adoption started: {} input bytes",
        input.bytes().len()
    );
    let started = std::time::Instant::now();
    let AdoptedSource {
        snapshot,
        grants,
        extracted,
        check_input_bytes,
        preview_summary,
    } = adopt_source(&mut store, &mut runtime, &input);
    eprintln!("capacity Core adoption returned in {:?}", started.elapsed());
    assert!(extracted.bytes().len() > 8 * 1024 * 1024);
    assert!(check_input_bytes > 4 * 1024 * 1024);
    let sdk::InvocationOutcome::Succeeded { output } =
        &extracted.envelope().plugin.as_ref().unwrap().result.outcome
    else {
        panic!("expected captured domain content")
    };
    let expected = sdk::parse_content_exchange(output.utf8.as_bytes()).unwrap();
    assert_eq!(expected.units.len(), 476);
    let summary = capture_summary(&expected);
    assert_eq!(preview_summary, summary);
    assert_eq!(
        summary.materials[0].counts,
        sdk::SourceCaptureCounts {
            items: 238,
            items_with_fields: 238,
            declared_fields: 476,
            non_empty_fields: 476,
        }
    );
    assert_eq!(summary.materials[0].source.range.end as usize, original.len());
    assert_eq!(
        summary.materials[0]
            .properties
            .iter()
            .find(|property| property.label == "Required masters")
            .unwrap()
            .values,
        Vec::<String>::new()
    );
    assert_eq!(
        summary.materials[0]
            .groups
            .iter()
            .map(|group| group.counts.declared_fields)
            .sum::<u32>(),
        476
    );
    let saved_result = extracted.bytes().to_vec();
    let read_rows = |store: &ProjectStore| {
        let mut rows = Vec::new();
        let mut after = 0;
        loop {
            let page = store.source_content(snapshot, after, 100).unwrap();
            assert_eq!(page.total, 476);
            assert_capture_page(&page, &summary);
            rows.extend(page.rows);
            match page.next_ordinal {
                Some(next) => {
                    assert!(next > after);
                    after = next;
                }
                None => break,
            }
        }
        assert_eq!(rows.len(), 476);
        for (row, occurrence_id) in rows.iter().zip(&expected.order) {
            let unit = expected
                .units
                .iter()
                .find(|unit| {
                    unit.occurrences
                        .iter()
                        .any(|occurrence| &occurrence.id == occurrence_id)
                })
                .unwrap();
            let occurrence = unit
                .occurrences
                .iter()
                .find(|occurrence| &occurrence.id == occurrence_id)
                .unwrap();
            assert_eq!(row.occurrence.operation_unit_id, unit.id);
            assert_eq!(row.occurrence.text, unit.text);
            assert_eq!(row.occurrence.native_identity, occurrence.native_identity);
            assert_eq!(row.occurrence.source, occurrence.source);
        }
        rows
    };
    let rows = read_rows(&store);
    assert_eq!(
        rows.iter()
            .filter(|row| row.occurrence.text.len() == 8192)
            .count(),
        238
    );
    assert_eq!(
        store
            .source_bundle(snapshot)
            .unwrap()
            .source_input()
            .artifacts[0]
            .validated_bytes()
            .unwrap()
            .into_owned(),
        original
    );
    assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    for grant in grants {
        runtime.revoke_plugin(&mut store, grant).unwrap();
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(read_rows(&reopened), rows);
    assert_eq!(
        reopened
            .source_bundle(snapshot)
            .unwrap()
            .source_input()
            .artifacts[0]
            .validated_bytes()
            .unwrap()
            .into_owned(),
        original
    );
    assert_eq!(
        reopened
            .execution_result(input.envelope().attempt_id, extracted.envelope().result_id)
            .unwrap()
            .bytes(),
        saved_result
    );
    eprintln!(
        "capacity Core capture/adopt/read/reopen completed in {:?}",
        started.elapsed()
    );
}
