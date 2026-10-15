#![cfg(all(unix, feature = "core-adapter"))]
//! A prebuilt independent Rust domain plugin, never linked domain source.
//! Run the same test file as an external consumer with Core features=[] to
//! distinguish normal source/review/release behavior from legacy test fixtures.
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tsumugi_core::{
    PluginBuildLocaleChoice, ProjectMetadata, ProjectStore, ReleaseAdoptionHandler,
    ReleaseBuildEnvironment, ReviewDecisionKind, ReviewWrite, SaveTranslationRevision,
    content::{SourceAdoptionHandler, SourceBundle, SourceReviewBinding, SourceSettings},
    execution::*,
};
use tsumugi_plugin_host::{catalog::*, core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;
#[path = "support/core_execution.rs"]
mod core_execution;
use core_execution::{authorize, execute};

const SOURCE: &str = "\u{feff}{\r\n\"z\":\"世界 👩🏽‍💻 é {name} {name}\",\r\n\"\\u0061\":\"Line\\n\\\"quoted\\\" 😀\"\r\n}\r\n";
const EXPECTED: &str =
    "\u{feff}{\n  \"a\": \"行\\n\\\"引用\\\" 😀\",\n  \"z\": \"你好 {name} 👩🏽‍💻 {name}\"\n}\n";

fn installed(root: &std::path::Path) -> PackageImage {
    let path = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_NATIVE_PACKAGE")
            .expect("explicit prebuilt Rust catalog package required"),
    );
    let digest = std::env::var("TSUMUGI_TEST_NATIVE_DIGEST")
        .expect("independently inspected package digest required");
    let image = PackageImage::capture_directory(&path, &digest, || true).unwrap();
    let plugin = image.manifest().manifest().plugin.clone();
    assert_eq!(plugin.id, "flat-json");
    assert_eq!(plugin.publisher, "org.tsumugi.examples");
    let approval = PackageApproval {
        plugin: plugin.clone(),
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "explicit-native-conformance".into(),
            publisher_id: "reviewed-independent-source".into(),
        },
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    let directory = root.join("packages");
    std::fs::create_dir(&directory).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    {
        let mut store = PackageStore::open_existing(&directory).unwrap();
        store
            .install(
                "00000000-0000-4000-8000-000000000048",
                catalog.registered(&plugin).unwrap(),
                || true,
            )
            .unwrap();
    }
    drop(catalog);
    let store = PackageStore::open_existing(&directory).unwrap();
    let installed = store.load(&approval, || true).unwrap();
    assert_eq!(
        installed.receipt().package_digest(),
        approval.package_digest
    );
    installed.image().clone()
}
fn runtime() -> CapturedNativeRuntime {
    let approval = CapturedNativeRuntime::inspect_current().unwrap();
    println!(
        "native_catalog_environment={}",
        json!({"descriptor":&approval,"digest":approval.digest().unwrap()})
    );
    CapturedNativeRuntime::capture(&approval).unwrap()
}
fn source(profile: sdk::ContractRef, text: &str) -> sdk::SourceExtractionInput {
    sdk::SourceExtractionInput {
        profile,
        source_set_id: "synthetic-source".into(),
        source_language: "en-US".into(),
        artifacts: vec![sdk::CapturedTextArtifact {
            id: "catalog-capture".into(),
            logical_path: "source.json".into(),
            role: "source".into(),
            sha256: sdk::payload_digest(text),
            utf8: text.into(),
        }],
    }
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
        provider: session.channel().provider,
        capability: binding.declaration.contract.clone(),
        profile: Some(binding.declaration.profiles[0].clone()),
        input,
        output_schema: binding.declaration.output_schema.clone(),
        error_schema: binding.declaration.error_schema.clone(),
        max_result_bytes: binding.declaration.limits.max_output_bytes,
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
    let received = session.invoke(&request, || false, || true).await.unwrap();
    assert_eq!(received.result().context, request.context);
    assert_eq!(received.result().provider, session.channel().provider);
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
#[ignore = "requires an explicitly reviewed prebuilt Rust catalog package"]
async fn native_catalog_actual_package_checks_semantics_and_returns_finite_errors() {
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let runtime = runtime();
    let source_binding = image.source_import("source-profile").unwrap();
    let build_binding = image.build_declaration("build-profile").unwrap();
    let input = source(source_binding.declaration.profile.clone(), SOURCE);
    let extracted = success(call(&image, &source_binding.extractor, json!(input), &runtime).await);
    let content: sdk::ContentExchange = serde_json::from_str(&extracted.utf8).unwrap();
    sdk::validate_source_extraction(&input, &content).unwrap();
    assert_eq!(content.units.len(), 2);
    assert_eq!(content.units[0].text, "世界 👩🏽‍💻 é {name} {name}");
    assert_eq!(content.units[1].text, "Line\n\"quoted\" 😀");
    for unit in &content.units {
        let range = unit.occurrences[0].source.range;
        assert_eq!(range.encoding, sdk::TextEncoding::Utf8Byte);
        let literal = &SOURCE[range.start as usize..range.end as usize];
        assert_eq!(serde_json::from_str::<String>(literal).unwrap(), unit.text);
    }
    let checks = vec![requirement(
        source_binding.declaration.semantic_rules[0].clone(),
        &source_binding.checker,
        vec![input.source_set_id.clone()],
    )];
    let checked = sdk::SourceExtractionCheckInput {
        source: input.clone(),
        proposal: content.clone(),
        requirements: checks.clone(),
    };
    check_output(
        success(call(&image, &source_binding.checker, json!(checked), &runtime).await),
        &checks,
        0,
    );
    let mut forged = checked;
    forged.proposal.units[1].text = "Other\n\"quoted\" 😀".into();
    forged.validate().unwrap();
    check_output(
        success(call(&image, &source_binding.checker, json!(forged), &runtime).await),
        &checks,
        1,
    );
    let targets: Vec<_> = content
        .units
        .iter()
        .zip(["你好 {name} 👩🏽‍💻 {name}", "行\n\"引用\" 😀"])
        .map(|(unit, text)| sdk::BuildTarget {
            unit_id: unit.id.clone(),
            source_revision_id: unit.source_revision_id.clone(),
            text: text.into(),
        })
        .collect();
    let build = sdk::BuildInput {
        source: content.clone(),
        target_language: "zh-CN".into(),
        targets,
        configuration: vec![],
        output_paths: vec!["locales/zh-CN.json".into()],
        output_limits: build_binding.declaration.output_limits.clone(),
    };
    build_binding.validate_input(&build).unwrap();
    let built = success(call(&image, &build_binding.builder, json!(build), &runtime).await);
    let output = sdk::parse_artifact_set(built.utf8.as_bytes()).unwrap();
    build_binding.validate_artifacts(&build, &output).unwrap();
    assert_eq!(output.artifacts[0].utf8, EXPECTED);
    let required = vec![requirement(
        build_binding.declaration.artifact_rules[0].clone(),
        &build_binding.checker,
        vec![output.artifacts[0].id.clone()],
    )];
    let check = sdk::ArtifactCheckInput {
        input: build.clone(),
        output,
        requirements: required.clone(),
    };
    check_output(
        success(call(&image, &build_binding.checker, json!(check), &runtime).await),
        &required,
        0,
    );
    let mut tampered = check;
    tampered.output.artifacts[0].utf8 = EXPECTED.replace("你好", "错误");
    tampered.output.artifacts[0].sha256 = sdk::payload_digest(&tampered.output.artifacts[0].utf8);
    tampered.validate().unwrap();
    check_output(
        success(call(&image, &build_binding.checker, json!(tampered), &runtime).await),
        &required,
        1,
    );
    let selections: Vec<_> = build
        .targets
        .iter()
        .map(|target| sdk::ReviewSelection {
            unit_id: target.unit_id.clone(),
            source_revision_id: target.source_revision_id.clone(),
            translation_text: Some(target.text.clone()),
        })
        .collect();
    let required: Vec<_> = source_binding
        .review
        .declaration
        .rules
        .iter()
        .map(|rule| {
            requirement(
                rule.rule.clone(),
                &source_binding.review.checker,
                selections.iter().map(|s| s.unit_id.clone()).collect(),
            )
        })
        .collect();
    let mut review = sdk::ReviewCheckInput {
        source: content,
        target_language: "zh-CN".into(),
        selections,
        requirements: required.clone(),
    };
    check_output(
        success(
            call(
                &image,
                &source_binding.review.checker,
                json!(review),
                &runtime,
            )
            .await,
        ),
        &required,
        0,
    );
    review.selections[0].translation_text = Some("你好 {name}".into());
    check_output(
        success(
            call(
                &image,
                &source_binding.review.checker,
                json!(review),
                &runtime,
            )
            .await,
        ),
        &required,
        1,
    );
    let invalid = source(input.profile.clone(), r#"{"a":"x","\u0061":"y"}"#);
    let sdk::InvocationOutcome::Failed { error } =
        call(&image, &source_binding.extractor, json!(invalid), &runtime).await
    else {
        panic!("decoded duplicate must fail")
    };
    assert_eq!(
        sdk::parse_source_extraction_error(error.utf8.as_bytes())
            .unwrap()
            .code,
        sdk::SourceExtractionErrorCode::InvalidSource
    );
    let mut bad = build;
    bad.targets[0].text = "missing tokens".into();
    let sdk::InvocationOutcome::Failed { error } =
        call(&image, &build_binding.builder, json!(bad), &runtime).await
    else {
        panic!("missing placeholders must fail")
    };
    assert_eq!(
        sdk::parse_build_error(error.utf8.as_bytes()).unwrap().code,
        sdk::BuildErrorCode::InvalidTarget
    );
}

#[tokio::test]
#[ignore = "requires an explicitly reviewed prebuilt Rust catalog package"]
async fn native_catalog_channel_rejects_forged_environment_and_reaps_cancelled_or_revoked_workers()
{
    let root = tempfile::tempdir().unwrap();
    let image = installed(root.path());
    let runtime = runtime();
    let binding = image.source_import("source-profile").unwrap().extractor;
    for cancellation in [true, false] {
        let stage = tempfile::tempdir().unwrap();
        let mut session = launch(&image, &binding, stage.path(), &runtime).await;
        let request = request(
            &session,
            &binding,
            json!(source(binding.declaration.profiles[0].clone(), SOURCE)),
        );
        let mut forged = request.clone();
        forged.context.environment_digest = sdk::payload_digest("forged environment");
        assert_eq!(
            session
                .invoke(&forged, || false, || true)
                .await
                .unwrap_err(),
            HostError::RequestMismatch
        );
        let received = session.invoke(&request, || false, || true).await.unwrap();
        assert!(matches!(
            received.result().outcome,
            sdk::InvocationOutcome::Succeeded { .. }
        ));
        let mut stopped = request;
        stopped.context.dispatch_id = "stopped-dispatch".into();
        assert_eq!(
            session
                .invoke(&stopped, || cancellation, || cancellation)
                .await
                .unwrap_err(),
            if cancellation {
                HostError::Cancelled
            } else {
                HostError::AuthorityRevoked
            }
        );
        assert!(session.termination_receipt().unwrap().direct_child_reaped);
        assert!(!session.is_accepting());
        assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    }
}

#[test]
#[ignore = "requires an explicitly reviewed prebuilt Rust catalog package"]
fn native_catalog_normal_core_requires_source_qa_human_and_artifact_proofs_and_keeps_release_on_reopen()
 {
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
        ProjectMetadata::create("Synthetic independent Rust catalog", "en-US", ["zh-CN"]).unwrap(),
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
    let producer = extractor
        .execution_binding(Some(source_binding.declaration.profile.clone()))
        .unwrap();
    let bundle =
        SourceBundle::capture_declared(&source_binding, vec![SOURCE.as_bytes().to_vec()], "en-US")
            .unwrap();
    let input = bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            producer.clone(),
            SourceSettings {
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
        .unwrap();
    assert_eq!(
        runtime.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let mut grants = vec![authorize(&runtime, &mut store, &input)];
    let extracted = execute(&mut runtime, &mut store, &input);
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
    grants.push(authorize(&runtime, &mut store, &check));
    let checked = execute(&mut runtime, &mut store, &check);
    store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let rows = store.source_content(snapshot, 0, 100).unwrap().rows;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].occurrence.native_identity.as_ref().unwrap().value,
        "z"
    );
    assert_eq!(
        rows[1].occurrence.native_identity.as_ref().unwrap().value,
        "a"
    );
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    for (row, text) in rows
        .iter()
        .zip(["你好 {name} 👩🏽‍💻 {name}", "行\n\"引用\" 😀"])
    {
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
                output_paths: vec!["locales/zh-CN.json".into()],
                configuration: vec![],
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
    assert_eq!(
        store
            .release_artifact_by_path(release, "zh-CN", "locales/zh-CN.json")
            .unwrap()
            .1,
        EXPECTED.as_bytes()
    );
    assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    for grant in grants {
        runtime.revoke_plugin(&mut store, grant).unwrap();
    }
    runtime.begin_quiesce(&mut store).unwrap();
    runtime.finish_quiesce(&mut store).unwrap();
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.release_view(release).unwrap(), released);
    assert_eq!(
        reopened
            .release_artifact_by_path(release, "zh-CN", "locales/zh-CN.json")
            .unwrap()
            .1,
        EXPECTED.as_bytes()
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
}
