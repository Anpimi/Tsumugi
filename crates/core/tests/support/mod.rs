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
        }
        .into(),
    }
}
pub fn source_input(store: &ProjectStore) -> FixedInput {
    source_input_with_count(store, 2)
}
fn source_input_with_count(store: &ProjectStore, count: usize) -> FixedInput {
    assert!((1..=2000).contains(&count));
    source_input_with_texts(store, &vec!["same"; count])
}
#[allow(dead_code)]
pub fn source_input_with_texts(store: &ProjectStore, texts: &[&str]) -> FixedInput {
    assert!((1..=2000).contains(&texts.len()));
    assert!(texts.iter().all(|text| !text.contains('\n')));
    let raw = texts.join("\n");
    let binding = declaration();
    let bundle = SourceBundle::capture_declared(
        &binding,
        vec![raw.into_bytes(), b"opaque companion".to_vec()],
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
    assert_eq!(source.artifacts[1].utf8, "opaque companion");
    let lines: Vec<_> = source.artifacts[0].utf8.split('\n').collect();
    let count = lines.len();
    let mut order = Vec::with_capacity(count);
    let mut start = 0;
    let units = (0..count)
        .map(|index| {
            let key = if count == 2 {
                ["first", "second"][index].to_owned()
            } else {
                format!("item-{index:04}")
            };
            order.push(format!("occurrence-{key}"));
            let end = start + lines[index].len() as u32;
            let range_start = start;
            start = end + 1;
            sdk::ContentUnit {
                id: format!("unit-{key}"),
                source_revision_id: format!("source-{key}"),
                text: lines[index].into(),
                occurrences: vec![sdk::ContentOccurrence {
                    id: format!("occurrence-{key}"),
                    source: sdk::SourceReference {
                        artifact_id: source.artifacts[0].id.clone(),
                        range: sdk::TextRange {
                            encoding: sdk::TextEncoding::Utf8Byte,
                            start: range_start,
                            end,
                        },
                    },
                    native_identity: Some(sdk::NativeIdentityEvidence {
                        namespace: "Synthetic.Source".into(),
                        value: key.clone(),
                        policy: reference("example.case-sensitive-key"),
                        display: sdk::NativeIdentityDisplay {
                            value: key.clone(),
                            source: None,
                        },
                    }),
                }],
                protected_fragments: vec![],
            }
        })
        .collect();
    sdk::ContentExchange {
        profile: source.profile.clone(),
        source_set_id: source.source_set_id.clone(),
        source_language: source.source_language.clone(),
        artifacts: source.artifacts.clone(),
        units,
        order,
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
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
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
        let output = if request.input.envelope().operation == REVIEW_CHECK_OPERATION {
            let input: sdk::ReviewCheckInput =
                serde_json::from_value(request.input.item(request.item_id)?.payload.clone())
                    .unwrap();
            input.validate().unwrap();
            let checks: Vec<_> = input
                .requirements
                .into_iter()
                .map(|r| sdk::CheckResult {
                    key: r.key,
                    input_digest: r.input_digest,
                    scope_digest: r.scope_digest,
                    covered_targets: r.targets,
                    outcome: r
                        .not_applicable
                        .map_or(sdk::CheckOutcome::Completed { findings: vec![] }, |basis| {
                            sdk::CheckOutcome::NotApplicable { basis }
                        }),
                })
                .collect();
            serde_json::to_value(checks).unwrap()
        } else if request.input.envelope().operation == tsumugi_core::content::OPERATION {
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
#[allow(dead_code)]
pub fn execute(
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
            "synthetic plugin completion deadline"
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
    source_fixture_with_rules(None)
}

#[allow(dead_code)]
pub fn source_fixture_with_review_rules(
    rules: Vec<sdk::ReviewRuleDeclaration>,
) -> (tempfile::TempDir, ProjectStore, Vec<ContentRow>) {
    let (directory, store, rows, _, _) = source_fixture_with_rules(Some(rules));
    (directory, store, rows)
}

fn source_fixture_with_rules(
    rules: Option<Vec<sdk::ReviewRuleDeclaration>>,
) -> (
    tempfile::TempDir,
    ProjectStore,
    Vec<ContentRow>,
    AdoptionAction,
    AdoptionReceipt,
) {
    source_fixture_config(rules, 2, &["zh-CN"])
}

#[allow(dead_code)]
pub fn source_fixture_with_scope(
    count: usize,
    locales: &[&str],
) -> (tempfile::TempDir, ProjectStore, Vec<ContentRow>) {
    let (directory, store, rows, _, _) = source_fixture_config(None, count, locales);
    (directory, store, rows)
}

fn source_fixture_config(
    rules: Option<Vec<sdk::ReviewRuleDeclaration>>,
    count: usize,
    locales: &[&str],
) -> (
    tempfile::TempDir,
    ProjectStore,
    Vec<ContentRow>,
    AdoptionAction,
    AdoptionReceipt,
) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Production content", "en", locales.iter().copied()).unwrap(),
    )
    .unwrap();
    let mut runtime = source_runtime(&store);
    let mut input = if count == 2 {
        source_input(&store)
    } else {
        source_input_with_count(&store, count)
    };
    if let Some(rules) = rules {
        let mut envelope = input.envelope().clone();
        envelope.settings["review"]["declaration"]["rules"] = serde_json::to_value(rules).unwrap();
        input = FixedInput::capture(envelope).unwrap();
    }
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
    let mut rows = Vec::with_capacity(count);
    let mut after = 0;
    loop {
        let page = store.source_content(snapshot, after, 100).unwrap();
        rows.extend(page.rows);
        match page.next_ordinal {
            Some(next) => {
                assert!(next > after);
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(rows.len(), count);
    let identities: std::collections::BTreeSet<_> =
        rows.iter().map(|r| r.unit_id.unwrap()).collect();
    assert_eq!(identities.len(), count);
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

#[allow(dead_code)]
pub fn review_runtime(
    store: &ProjectStore,
    prepared: &tsumugi_core::PreparedReviewCheck,
) -> ExecutionRuntime {
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime
        .register_read_only(Arc::new(FixtureRunner(
            prepared.plan().unwrap().binding().checker.clone(),
        )))
        .unwrap();
    runtime
}

#[allow(dead_code)]
pub fn review_check(
    store: &mut ProjectStore,
    runtime: &mut ExecutionRuntime,
    unit: ExecutionId,
    locale: &str,
) -> tsumugi_core::CheckRun {
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let target = store.review_target(project, unit, locale).unwrap();
    let prepared = store
        .prepare_review_check(
            project,
            unit,
            locale,
            &target.basis,
            ExecutionId::new(),
            &[],
        )
        .unwrap();
    let inputs = prepared.execution_inputs();
    assert_eq!(inputs.len(), 1, "format-only fixture has one checker input");
    let input = inputs[0].clone();
    let (grant, result) = execute(runtime, store, &input);
    let checker = prepared.plan().unwrap().checkers()[0].key.clone();
    let captured = store
        .capture_review_check_execution(
            prepared,
            &[tsumugi_core::ReviewCheckOrigin {
                checker,
                attempt_id: input.envelope().attempt_id,
                result_id: result.envelope().result_id,
            }],
        )
        .unwrap();
    let computed = captured.compute(&Cancellation::default()).unwrap();
    assert!(computed.coverage().complete);
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    runtime.revoke_plugin(store, grant).unwrap();
    run
}
