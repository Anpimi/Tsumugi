//! Synthetic SDK source/check fixture through public Core grants and proof APIs.
//! No domain parser, installed package, external worker or native Host is invoked.
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{
    ProjectMetadata, ProjectStore,
    content::{ContentRow, SourceAdoptionHandler, SourceBundle, SourceSettings},
    execution::*,
};
use tsumugi_plugin_sdk as sdk;

fn reference(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn declaration() -> sdk::SourceImportBinding {
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../../plugin-sdk/tests/fixtures/source-import.manifest.json"
    ))
    .unwrap();
    sdk::parse_source_import_declaration(include_bytes!(
        "../../../plugin-sdk/tests/fixtures/source-import.declaration.json"
    ))
    .unwrap()
    .bind(
        &manifest,
        &"a".repeat(64),
        &sdk::parse_review_declaration(include_bytes!(
            "../../../plugin-sdk/tests/fixtures/source-import.review.json"
        ))
        .unwrap(),
    )
    .unwrap()
}
fn selected(capability: sdk::CapabilityBinding) -> PluginExecutionBinding {
    PluginExecutionBinding {
        capability,
        profile: Some(declaration().declaration.profile),
        environment: sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: sdk::RuntimePlatform {
                operating_system: sdk::RuntimeOperatingSystem::Macos,
                architecture: sdk::RuntimeArchitecture::Aarch64,
            },
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: "b".repeat(64),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: "c".repeat(64),
                entrypoint: "dist/main.js".into(),
            },
        },
    }
}
pub fn source_input(store: &ProjectStore) -> FixedInput {
    let binding = declaration();
    let bundle = SourceBundle::capture_declared(
        &binding,
        vec![b"same\nsame".to_vec(), b"opaque companion".to_vec()],
        "en",
    )
    .unwrap();
    bundle
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            selected(binding.extractor),
            SourceSettings {
                revision_policy: binding.declaration.revision_policy,
                checker: Some(selected(binding.checker)),
                semantic_rules: binding.declaration.semantic_rules,
                review: Some(
                    tsumugi_core::content::SourceReviewBinding::capture(
                        &binding.review,
                        &selected(binding.review.checker.clone()).environment,
                    )
                    .unwrap(),
                ),
            },
        )
        .unwrap()
}
fn proposal(source: &sdk::SourceExtractionInput) -> sdk::ContentExchange {
    assert_eq!(source.artifacts[0].utf8, "same\nsame");
    assert_eq!(source.artifacts[1].utf8, "opaque companion");
    let units = [("first", 0, 4), ("second", 5, 9)]
        .into_iter()
        .map(|(key, start, end)| sdk::ContentUnit {
            id: format!("unit-{key}"),
            source_revision_id: format!("source-{key}"),
            text: "same".into(),
            occurrences: vec![sdk::ContentOccurrence {
                id: format!("occurrence-{key}"),
                source: sdk::SourceReference {
                    artifact_id: source.artifacts[0].id.clone(),
                    range: sdk::TextRange {
                        encoding: sdk::TextEncoding::Utf8Byte,
                        start,
                        end,
                    },
                },
                native_identity: Some(sdk::NativeIdentityEvidence {
                    namespace: "Synthetic.Source".into(),
                    value: key.into(),
                    policy: reference("example.case-sensitive-key"),
                    display: sdk::NativeIdentityDisplay {
                        value: key.into(),
                        source: None,
                    },
                }),
            }],
            protected_fragments: vec![],
        })
        .collect();
    sdk::ContentExchange {
        profile: source.profile.clone(),
        source_set_id: source.source_set_id.clone(),
        source_language: source.source_language.clone(),
        artifacts: source.artifacts.clone(),
        units,
        order: vec!["occurrence-first".into(), "occurrence-second".into()],
        relations: vec![],
        domain_blocks: vec![],
    }
}
struct FixtureRunner(PluginExecutionBinding);
impl Runner for FixtureRunner {
    fn capability_id(&self) -> &str {
        &self.0.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.0.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::RuntimeEnvironmentDescriptor> {
        Some(&self.0.environment)
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        assert!(!cancellation.is_requested());
        let permit = request.plugin_permit().unwrap();
        assert!(permit.matches(&request.input) && permit.is_authorized());
        let selected = &self.0.capability.provider;
        let channel = sdk::ProviderBinding {
            plugin: selected.plugin.clone(),
            component_id: selected.component_id.clone(),
            contribution_id: selected.contribution_id.clone(),
            package_digest: selected.package_digest.clone(),
            instance_id: ExecutionId::new().to_string(),
            activation_generation: 1,
        };
        let invocation =
            request
                .input
                .plugin_request(request.item_id, request.dispatch_token, &channel)?;
        let output = if request.input.envelope().operation == tsumugi_core::content::OPERATION {
            serde_json::to_value(proposal(
                &SourceBundle::from_input(&request.input)?.source_input(),
            ))
            .unwrap()
        } else {
            let check: sdk::SourceExtractionCheckInput =
                serde_json::from_value(request.input.item(request.item_id)?.payload.clone())
                    .unwrap();
            check.validate().unwrap();
            assert_eq!(check.proposal, proposal(&check.source));
            let checks: Vec<_> = check
                .requirements
                .into_iter()
                .map(|r| sdk::CheckResult {
                    key: r.key,
                    input_digest: r.input_digest,
                    scope_digest: r.scope_digest,
                    covered_targets: r.targets,
                    outcome: sdk::CheckOutcome::Completed { findings: vec![] },
                })
                .collect();
            serde_json::to_value(checks).unwrap()
        };
        results.send(FixedResult::capture_plugin(
            &request.input,
            request.item_id,
            request.dispatch_token,
            PluginResultEvidence {
                authorization_id: permit.grant_id(),
                channel: channel.clone(),
                result: sdk::InvocationResult {
                    context: invocation.context,
                    provider: channel,
                    capability: invocation.capability,
                    profile: invocation.profile,
                    result_id: ExecutionId::new().to_string(),
                    outcome: sdk::InvocationOutcome::Succeeded {
                        output: sdk::EncodedPayload::capture(
                            invocation.output_schema,
                            serde_json::to_string(&output).unwrap(),
                        )
                        .unwrap(),
                    },
                },
            },
        )?)
    }
}
fn execute(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> (ExecutionId, FixedResult) {
    let grant = ExecutionId::new();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    runtime
        .authorize_plugin(
            store,
            grant,
            input,
            expires,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(input.envelope().attempt_id) {
            let id = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
            let result = store
                .execution_result(input.envelope().attempt_id, id)
                .unwrap();
            assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
            return (grant, result);
        }
        assert!(
            Instant::now() < deadline,
            "synthetic source/check completion deadline"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
pub fn source_fixture() -> (tempfile::TempDir, ProjectStore, Vec<ContentRow>) {
    let (directory, store, rows, _, _) = source_fixture_with_receipt();
    (directory, store, rows)
}
pub fn source_fixture_with_receipt() -> (
    tempfile::TempDir,
    ProjectStore,
    Vec<ContentRow>,
    AdoptionAction,
    AdoptionReceipt,
) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Production content", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut runtime = source_runtime(&store);
    let input = source_input(&store);
    let (producer_grant, result) = execute(&mut runtime, &mut store, &input);
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    assert!(
        runtime.submit(&mut store, &check_input).is_err(),
        "checker needs independent authorization"
    );
    let (checker_grant, checked) = execute(&mut runtime, &mut store, &check_input);
    store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let preview = store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(preview.confirmation).unwrap(),
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
    runtime.revoke_plugin(&mut store, producer_grant).unwrap();
    runtime.revoke_plugin(&mut store, checker_grant).unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let rows = store.source_content(snapshot, 0, 10).unwrap().rows;
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0].unit_id, rows[1].unit_id);
    (directory, store, rows, action, receipt)
}

pub fn source_runtime(store: &ProjectStore) -> ExecutionRuntime {
    let binding = declaration();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    for capability in [binding.extractor, binding.checker] {
        runtime
            .register_read_only(Arc::new(FixtureRunner(selected(capability))))
            .unwrap();
    }
    runtime
}
