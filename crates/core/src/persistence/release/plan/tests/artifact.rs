//! Synthetic SDK results exercise the real ledger, independent grants and
//! required proof. No installed component or child process executes here.
use super::*;
use crate::execution::*;

mod release;
mod workflow;

#[test]
fn saved_build_projection_is_read_only_and_preserves_unchecked_results_after_revoke_and_reopen() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN", "fr-FR"]);
    let project = input.envelope().project_id;
    let attempt = input.envelope().attempt_id;
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    let before = store.connection().unwrap().total_changes();
    let sequence = store.execution_sequence().unwrap();
    let saved = store
        .read_saved_plugin_build(project, attempt, false)
        .unwrap();
    assert_eq!(saved.attempt_id, attempt);
    assert_eq!(saved.task_id, input.envelope().task_id);
    assert_eq!(saved.input_digest, input.digest());
    assert_eq!(saved.locales.len(), 2);
    assert!(saved.locales.iter().all(|locale| locale.target_count == 2));
    let available = saved
        .locales
        .iter()
        .find(|locale| locale.item_id == result.envelope().item_id)
        .unwrap();
    assert_eq!(available.status.validation, ValidationState::Pending);
    let output = available.result.as_ref().unwrap();
    assert_eq!(output.result_id, result.envelope().result_id);
    assert_eq!(output.result_digest, result.digest());
    assert_eq!(output.artifacts.len(), 2);
    let plan = ReleasePlan::from_input(&input).unwrap();
    let actual = plan.artifact_set(&result).unwrap();
    for (summary, artifact) in output.artifacts.iter().zip(&actual.artifacts) {
        assert_eq!(summary.logical_path, artifact.logical_path);
        assert_eq!(summary.role, artifact.role);
        assert_eq!(summary.sha256, artifact.sha256);
        assert_eq!(summary.byte_length as usize, artifact.utf8.len());
    }
    assert!(saved.locales.iter().any(|locale| locale.result.is_none()));
    let recovery = store.execution_recovery(attempt, false).unwrap();
    assert_eq!(
        recovery.units[0].blocked_reason.as_deref(),
        Some("external-new-consent")
    );
    assert!(
        !recovery.units[0]
            .actions
            .contains(&RecoveryAction::ValidateOutput)
    );
    assert_eq!(
        store
            .validate_execution_result(attempt, result.envelope().result_id)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        store
            .read_saved_plugin_build(ExecutionId::new(), attempt, false)
            .is_err()
    );
    assert!(
        store
            .read_saved_plugin_build(project, ExecutionId::new(), false)
            .is_err()
    );
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    assert_eq!(store.connection().unwrap().total_changes(), before);
    // Removing a current target changes new-build eligibility, not the saved
    // plan's historical language or immutable source/result references.
    let revision = store.metadata().unwrap().metadata_revision();
    store
        .set_target_locales(revision, &["fr-FR".into()])
        .unwrap();
    let before = store.connection().unwrap().total_changes();
    assert_eq!(
        store
            .read_saved_plugin_build(project, attempt, false)
            .unwrap(),
        saved
    );
    assert_eq!(store.connection().unwrap().total_changes(), before);
    store
        .revoke_plugin_grant(
            generation,
            result.envelope().plugin.as_ref().unwrap().authorization_id,
        )
        .unwrap();
    assert_eq!(
        store
            .read_saved_plugin_build(project, attempt, false)
            .unwrap(),
        saved
    );
    assert!(
        store
            .capture_artifact_validation(attempt, result.envelope().result_id)
            .is_err()
    );
    let directory = store.directory().to_owned();
    drop(store);
    let reopened = ProjectStore::open(directory).unwrap();
    let before = reopened.connection().unwrap().total_changes();
    assert_eq!(
        reopened
            .read_saved_plugin_build(project, attempt, false)
            .unwrap(),
        saved
    );
    assert!(reopened.check_plugin_input(&input).is_err());
    assert_eq!(
        reopened.execution_input(attempt).unwrap().bytes(),
        input.bytes()
    );
    assert_eq!(
        reopened
            .execution_result(attempt, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
    assert_eq!(reopened.connection().unwrap().total_changes(), before);
}

#[test]
fn saved_build_projection_refuses_an_associated_but_wrong_locale_artifact_set() {
    let (_directory, mut store, _generation, input) = fixture_build(&["zh-CN"]);
    let request = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let plan = ReleasePlan::from_input(&input).unwrap();
    let fixed = plan.plugin_input("zh-CN").unwrap();
    let output = sdk::ArtifactSet {
        profile: fixed.source.profile,
        source_set_id: fixed.source.source_set_id,
        target_language: "fr-FR".into(),
        artifacts: fixed
            .output_paths
            .into_iter()
            .enumerate()
            .map(|(index, logical_path)| {
                let utf8 = "Saved wrong-language bytes".to_owned();
                sdk::CapturedTextArtifact {
                    id: format!("output-{index}"),
                    logical_path,
                    role: "deliverable".into(),
                    sha256: codec::digest(utf8.as_bytes()),
                    utf8,
                }
            })
            .collect(),
    };
    let result = sdk_result(&request, serde_json::to_value(output).unwrap());
    store.save_execution_result(&result).unwrap();
    let before = store.connection().unwrap().total_changes();
    assert!(
        store
            .read_saved_plugin_build(
                input.envelope().project_id,
                input.envelope().attempt_id,
                false
            )
            .is_err()
    );
    assert_eq!(store.connection().unwrap().total_changes(), before);
    assert_eq!(
        store
            .execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
}

#[test]
fn saved_build_projection_preserves_a_failed_result_without_successful_artifacts() {
    let (_directory, mut store, _generation, input) = fixture_build(&["zh-CN"]);
    let request = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let result = sdk_result_with_outcome(&request, |invocation| sdk::InvocationOutcome::Failed {
        error: sdk::EncodedPayload::capture(
            invocation.error_schema.clone(),
            "{\"code\":\"synthetic-build-failed\"}".into(),
        )
        .unwrap(),
    });
    store.save_execution_result(&result).unwrap();
    let before = store.connection().unwrap().total_changes();
    let saved = store
        .read_saved_plugin_build(
            input.envelope().project_id,
            input.envelope().attempt_id,
            false,
        )
        .unwrap();
    let locale = &saved.locales[0];
    assert_eq!(locale.status.execution, ExecutionState::Failed);
    let summary = locale.result.as_ref().unwrap();
    assert_eq!(summary.result_id, result.envelope().result_id);
    assert_eq!(summary.result_digest, result.digest());
    assert_eq!(summary.outcome, ExecutionState::Failed);
    assert!(summary.artifacts.is_empty());
    assert_eq!(store.connection().unwrap().total_changes(), before);
}

#[test]
fn saved_build_projection_reads_reused_result_associations_without_restoring_original_authority() {
    // This existing trusted fixture permits replay of pure computation. The
    // historical read itself never selects a new policy or authorizes a retry.
    let (_directory, mut store, generation, input) =
        fixture_build_policy(&["zh-CN", "fr-FR"], 131072, RecoveryPolicy::ReadOnly);
    let first = input.envelope().items[0].item_id;
    let second = input.envelope().items[1].item_id;
    let result = builder_result(&mut store, &input, first);
    let capture = store
        .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let checked = passing_results(&capture);
    let (checked, checker_grant) = checker_result(&mut store, generation, &capture, checked);
    store
        .commit_artifact_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let original = store
        .read_saved_plugin_build(
            input.envelope().project_id,
            input.envelope().attempt_id,
            false,
        )
        .unwrap();
    let retry = store
        .execution_retry_input(input.envelope().attempt_id, &[second])
        .unwrap();
    assert_eq!(retry.envelope().reused_results.len(), 1);
    let reference = &retry.envelope().reused_results[0];
    assert_eq!(reference.source_attempt_id, input.envelope().attempt_id);
    assert_eq!(reference.result_id, result.envelope().result_id);
    let retry_grant = authorize_policy(&mut store, generation, &retry, RecoveryPolicy::ReadOnly);
    let before = store.connection().unwrap().total_changes();
    let sequence = store.execution_sequence().unwrap();
    let saved = store
        .read_saved_plugin_build(
            input.envelope().project_id,
            retry.envelope().attempt_id,
            false,
        )
        .unwrap();
    assert_ne!(saved.attempt_id, original.attempt_id);
    assert_eq!(saved.attempt_id, retry.envelope().attempt_id);
    assert_eq!(saved.task_id, original.task_id);
    assert_eq!(saved.input_digest, retry.digest());
    let reused = saved
        .locales
        .iter()
        .find(|locale| locale.item_id == first)
        .unwrap();
    assert_eq!(reused.status.validation, ValidationState::Valid);
    assert_eq!(
        reused.result,
        original
            .locales
            .iter()
            .find(|locale| locale.item_id == first)
            .unwrap()
            .result
    );
    let raw = store
        .execution_result(retry.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(raw.envelope().attempt_id, original.attempt_id);
    assert_eq!(raw.bytes(), result.bytes());
    assert!(
        saved
            .locales
            .iter()
            .find(|locale| locale.item_id == second)
            .unwrap()
            .result
            .is_none()
    );
    assert_eq!(
        store
            .execution_attempt(retry.envelope().attempt_id, false)
            .unwrap()
            .progress
            .queued,
        1
    );
    assert!(
        store
            .execution_dispatch(retry.envelope().attempt_id, first)
            .is_err()
    );
    assert!(
        store
            .list_releases(input.envelope().project_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    assert_eq!(store.connection().unwrap().total_changes(), before);
    for grant in [
        result.envelope().plugin.as_ref().unwrap().authorization_id,
        checker_grant,
        retry_grant,
    ] {
        store.revoke_plugin_grant(generation, grant).unwrap();
    }
    let before = store.connection().unwrap().total_changes();
    assert_eq!(
        store
            .read_saved_plugin_build(
                input.envelope().project_id,
                retry.envelope().attempt_id,
                false
            )
            .unwrap(),
        saved
    );
    assert!(
        store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .is_err()
    );
    assert!(
        store
            .capture_artifact_validation(retry.envelope().attempt_id, result.envelope().result_id)
            .is_err()
    );
    assert!(store.check_plugin_input(&retry).is_err());
    assert_eq!(store.connection().unwrap().total_changes(), before);
    let directory = store.directory().to_owned();
    drop(store);
    let reopened = ProjectStore::open(directory).unwrap();
    let before = reopened.connection().unwrap().total_changes();
    assert_eq!(
        reopened
            .read_saved_plugin_build(
                input.envelope().project_id,
                retry.envelope().attempt_id,
                false
            )
            .unwrap(),
        saved
    );
    assert!(reopened.check_plugin_input(&retry).is_err());
    assert_eq!(
        reopened
            .execution_result(retry.envelope().attempt_id, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
    assert_eq!(reopened.connection().unwrap().total_changes(), before);
}

fn fixture_build(locales: &[&str]) -> (tempfile::TempDir, ProjectStore, ExecutionId, FixedInput) {
    fixture_build_limit(locales, 131072)
}
fn fixture_build_limit(
    locales: &[&str],
    bytes: u32,
) -> (tempfile::TempDir, ProjectStore, ExecutionId, FixedInput) {
    fixture_build_policy(locales, bytes, RecoveryPolicy::ExternalUnknown)
}
fn fixture_build_policy(
    locales: &[&str],
    bytes: u32,
    policy: RecoveryPolicy,
) -> (tempfile::TempDir, ProjectStore, ExecutionId, FixedInput) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Artifact proof", "en", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    crate::content::tests::adopt_shared_source_fixture(&mut store);
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let units: Vec<_> = store
        .review_page(project, "zh-CN", 0, 100)
        .unwrap()
        .rows
        .iter()
        .map(|r| r.unit_id)
        .collect();
    for locale in locales {
        ready(&mut store, project, &units, locale);
    }
    let languages: Vec<_> = locales.iter().map(|l| (*l).into()).collect();
    let basis = store.review_eligibility(project, &languages).unwrap().basis;
    let choices: Vec<_> = locales
        .iter()
        .map(|locale| PluginBuildLocaleChoice {
            locale: (*locale).into(),
            output_paths: vec![format!("{locale}/main.txt"), format!("{locale}/second.txt")],
            configuration: vec![],
        })
        .collect();
    let mut build = environment(&store);
    build.binding.declaration.output_limits.max_total_bytes = bytes;
    build
        .binding
        .declaration
        .artifact_rules
        .push(sdk::ContractRef {
            id: "example.artifact-completeness".into(),
            schema_version: 1,
            behavior_version: 1,
        });
    let input = store
        .prepare_plugin_build(project, ExecutionId::new(), &choices, &basis, &build)
        .unwrap();
    let generation = ExecutionId::new();
    store.begin_plugin_epoch(generation).unwrap();
    authorize_policy(&mut store, generation, &input, policy);
    (directory, store, generation, input)
}
fn authorize(store: &mut ProjectStore, generation: ExecutionId, input: &FixedInput) -> ExecutionId {
    authorize_policy(store, generation, input, RecoveryPolicy::ExternalUnknown)
}
fn authorize_policy(
    store: &mut ProjectStore,
    generation: ExecutionId,
    input: &FixedInput,
    policy: RecoveryPolicy,
) -> ExecutionId {
    let grant = ExecutionId::new();
    store
        .authorize_plugin_input(
            generation,
            grant,
            input,
            crate::execution::plugin_authority::plugin_now_ms().unwrap() + 60_000,
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: false,
            },
            None,
        )
        .unwrap();
    store
        .enqueue_execution_with_policy(input, policy, None)
        .unwrap();
    grant
}
fn sdk_result(request: &DispatchRequest, value: serde_json::Value) -> FixedResult {
    sdk_result_with_outcome(request, |invocation| sdk::InvocationOutcome::Succeeded {
        output: sdk::EncodedPayload::capture(
            invocation.output_schema.clone(),
            serde_json::to_string(&value).unwrap(),
        )
        .unwrap(),
    })
}
fn sdk_result_with_outcome(
    request: &DispatchRequest,
    outcome: impl FnOnce(&sdk::InvocationRequest) -> sdk::InvocationOutcome,
) -> FixedResult {
    let binding = request.input.envelope().plugin.as_ref().unwrap();
    let selection = &binding.capability.provider;
    let channel = sdk::ProviderBinding {
        plugin: selection.plugin.clone(),
        component_id: selection.component_id.clone(),
        contribution_id: selection.contribution_id.clone(),
        package_digest: selection.package_digest.clone(),
        instance_id: "synthetic-artifact-channel".into(),
        activation_generation: 1,
    };
    let invocation = request
        .input
        .plugin_request(request.item_id, request.dispatch_token, &channel)
        .unwrap();
    let outcome = outcome(&invocation);
    FixedResult::capture_plugin(
        &request.input,
        request.item_id,
        request.dispatch_token,
        PluginResultEvidence {
            authorization_id: request.plugin_permit().unwrap().grant_id(),
            channel: channel.clone(),
            result: sdk::InvocationResult {
                context: invocation.context,
                provider: channel,
                capability: invocation.capability,
                profile: invocation.profile,
                result_id: ExecutionId::new().to_string(),
                outcome,
            },
        },
    )
    .unwrap()
}
fn builder_result(store: &mut ProjectStore, input: &FixedInput, item: ExecutionId) -> FixedResult {
    let request = store
        .dispatch_execution_item(input.envelope().attempt_id, item)
        .unwrap();
    let build: sdk::BuildInput =
        serde_json::from_value(input.item(item).unwrap().payload.clone()).unwrap();
    let artifacts = build
        .output_paths
        .iter()
        .enumerate()
        .map(|(i, path)| {
            let utf8 = format!(
                "\u{feff}Synthetic result {i}: {}\r\n",
                build.targets[0].text
            );
            sdk::CapturedTextArtifact {
                id: format!("artifact-{i}"),
                logical_path: path.clone(),
                role: "locale".into(),
                sha256: codec::digest(utf8.as_bytes()),
                utf8,
            }
        })
        .collect();
    let output = sdk::ArtifactSet {
        profile: build.source.profile,
        source_set_id: build.source.source_set_id,
        target_language: build.target_language,
        artifacts,
    };
    let result = sdk_result(&request, serde_json::to_value(output).unwrap());
    store.save_execution_result(&result).unwrap();
    result
}
fn passing_results(capture: &ArtifactValidationCapture) -> Vec<sdk::CheckResult> {
    let payload: sdk::ArtifactCheckInput =
        serde_json::from_value(capture.check_input().envelope().items[0].payload.clone()).unwrap();
    payload
        .requirements
        .into_iter()
        .map(|r| sdk::CheckResult {
            key: r.key,
            input_digest: r.input_digest,
            scope_digest: r.scope_digest,
            covered_targets: r.targets,
            outcome: sdk::CheckOutcome::Completed { findings: vec![] },
        })
        .collect()
}
fn checker_result(
    store: &mut ProjectStore,
    generation: ExecutionId,
    capture: &ArtifactValidationCapture,
    checked: Vec<sdk::CheckResult>,
) -> (FixedResult, ExecutionId) {
    let input = capture.check_input();
    let grant = authorize(store, generation, input);
    let request = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let result = sdk_result(&request, serde_json::to_value(checked).unwrap());
    store.save_execution_result(&result).unwrap();
    (result, grant)
}
fn state(store: &ProjectStore, input: &FixedInput, item: ExecutionId) -> ValidationState {
    store
        .execution_attempt(input.envelope().attempt_id, false)
        .unwrap()
        .items
        .into_iter()
        .find(|i| i.item_id == item)
        .unwrap()
        .validation
}

#[test]
fn actual_artifacts_freeze_full_scope_and_need_separate_current_checker_grants() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let item = input.envelope().items[0].item_id;
    let result = builder_result(&mut store, &input, item);
    let changes = store.connection().unwrap().total_changes();
    let capture = store
        .capture_result_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap()
        .prepare_artifact_check(ExecutionId::new())
        .unwrap();
    assert_eq!(store.connection().unwrap().total_changes(), changes);
    let check_input = capture.check_input();
    assert_eq!(check_input.envelope().operation, ARTIFACT_CHECK_OPERATION);
    assert!(
        store.enqueue_execution(check_input).is_err(),
        "producer consent cannot authorize its checker"
    );
    let payload: sdk::ArtifactCheckInput =
        serde_json::from_value(check_input.envelope().items[0].payload.clone()).unwrap();
    assert_eq!(payload.output.artifacts.len(), 2);
    assert_eq!(
        payload.input.source,
        ReleasePlan::from_input(&input).unwrap().source
    );
    assert_eq!(
        payload
            .input
            .source
            .units
            .iter()
            .map(|u| u.occurrences.len())
            .sum::<usize>(),
        3
    );
    assert!(payload.output.artifacts[0].utf8.starts_with('\u{feff}'));
    assert!(payload.output.artifacts[0].utf8.ends_with("\r\n"));
    assert_eq!(payload.requirements.len(), 2);
    for r in &payload.requirements {
        assert_eq!(r.input_digest, input.digest());
        assert_eq!(r.scope_digest, result.digest());
        assert_eq!(r.targets, ["artifact-0", "artifact-1"]);
        assert!(r.mandatory && !r.waivable && r.not_applicable.is_none());
    }
    let checked = passing_results(&capture);
    let (checked, _) = checker_result(&mut store, generation, &capture, checked);
    let evidence = checked.envelope().plugin.as_ref().unwrap();
    assert_ne!(
        evidence.channel.selection(),
        input
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .capability
            .provider
    );
    let invocation = check_input
        .plugin_request(
            check_input.envelope().items[0].item_id,
            checked.envelope().dispatch_token,
            &evidence.channel,
        )
        .unwrap();
    assert_eq!(
        sdk::parse_artifact_check_input(invocation.input.utf8.as_bytes()).unwrap(),
        payload
    );
    let prepared = capture.prepare(checked).unwrap();
    assert!(prepared.proof.valid);
    store.commit_artifact_validation(prepared).unwrap();
    assert_eq!(state(&store, &input, item), ValidationState::Valid);
    assert!(
        store
            .list_releases(input.envelope().project_id)
            .unwrap()
            .is_empty(),
        "proof does not publish a release"
    );
}

struct ApprovesAnyData;
impl ResultValidator for ApprovesAnyData {
    fn operation(&self) -> &str {
        crate::content::BUILD_OPERATION
    }
    fn validate(&self, _: &FixedInput, _: &FixedResult) -> Result<(), ExecutionError> {
        Ok(())
    }
}
#[test]
fn generic_validator_and_corrupt_artifact_data_cannot_bypass_required_proof() {
    let (_directory, mut store, _generation, input) = fixture_build(&["zh-CN"]);
    let item = input.envelope().items[0].item_id;
    let result = builder_result(&mut store, &input, item);
    assert_eq!(state(&store, &input, item), ValidationState::Pending);
    let capture = store
        .capture_result_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(
        capture.prepare(&ApprovesAnyData).err().unwrap().stage,
        "artifact-semantic-check-required"
    );
    assert!(
        store
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .is_err()
    );
    let mut envelope = result.envelope().clone();
    let evidence = envelope.plugin.as_mut().unwrap();
    let sdk::InvocationOutcome::Succeeded { output } = &mut evidence.result.outcome else {
        unreachable!()
    };
    let mut artifacts: sdk::ArtifactSet = serde_json::from_str(&output.utf8).unwrap();
    artifacts.artifacts[0].utf8.push_str("changed");
    *output = sdk::EncodedPayload::capture(
        sdk::artifact_set_contract(),
        serde_json::to_string(&artifacts).unwrap(),
    )
    .unwrap();
    envelope.output = Some(serde_json::to_value(artifacts).unwrap());
    let forged = FixedResult::capture(envelope, &input, result.envelope().dispatch_token).unwrap();
    assert!(
        ArtifactValidationCapture::capture(ResultValidationCapture {
            input: input.clone(),
            result: forged
        })
        .is_err()
    );
}

#[test]
fn omitted_rules_targets_basis_provider_or_blocking_outcomes_remain_invalid() {
    for variant in 0..13 {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let item = input.envelope().items[0].item_id;
        let result = builder_result(&mut store, &input, item);
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let mut checked = passing_results(&capture);
        match variant {
            0 => {
                checked.pop();
            }
            1 => {
                checked[0].covered_targets.pop();
            }
            2 => checked[0].input_digest = "d".repeat(64),
            3 => checked[0].scope_digest = "d".repeat(64),
            4 => {
                let duplicate = checked[0].clone();
                checked.push(duplicate);
            }
            5 => {
                checked[0].key.implementation = sdk::CheckImplementation::Plugin {
                    provider: input
                        .envelope()
                        .plugin
                        .as_ref()
                        .unwrap()
                        .capability
                        .provider
                        .clone(),
                }
            }
            6 => {
                checked[0].key.implementation = sdk::CheckImplementation::Core {
                    validator: checked[0].key.rule.clone(),
                }
            }
            7 => {
                checked[0].outcome = sdk::CheckOutcome::Completed {
                    findings: vec![sdk::CheckFinding {
                        code: "synthetic-invalid-output".into(),
                        target: "artifact-0".into(),
                        severity: sdk::FindingSeverity::Error,
                    }],
                }
            }
            8 => checked[0].outcome = sdk::CheckOutcome::Unavailable,
            9 => {
                checked.clear();
            }
            10 => {
                checked[0].outcome = sdk::CheckOutcome::NotApplicable {
                    basis: sdk::NotApplicableBasis {
                        code: "synthetic-skip".into(),
                        basis_digest: result.digest().into(),
                    },
                }
            }
            11 => checked[0].outcome = sdk::CheckOutcome::Failed,
            12 => checked[0].outcome = sdk::CheckOutcome::Cancelled,
            _ => unreachable!(),
        }
        let (checked, _) = checker_result(&mut store, generation, &capture, checked);
        let prepared = capture.prepare(checked).unwrap();
        assert!(!prepared.proof.valid, "variant {variant}");
        store.commit_artifact_validation(prepared).unwrap();
        assert_eq!(state(&store, &input, item), ValidationState::Invalid);
        let path = store.directory().to_owned();
        drop(store);
        let reopened = ProjectStore::open(path).unwrap();
        assert_eq!(state(&reopened, &input, item), ValidationState::Invalid);
    }
}

#[test]
fn late_checker_revocation_and_cancellation_refuse_commit_without_erasing_proposal() {
    for (cancel, producer) in [(false, false), (true, false), (false, true), (true, true)] {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let item = input.envelope().items[0].item_id;
        let result = builder_result(&mut store, &input, item);
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let check_input = capture.check_input().clone();
        let checked = passing_results(&capture);
        let (checked, grant) = checker_result(&mut store, generation, &capture, checked);
        let prepared = capture.prepare(checked).unwrap();
        let task = if producer {
            input.envelope().task_id
        } else {
            check_input.envelope().task_id
        };
        let grant = if producer {
            result.envelope().plugin.as_ref().unwrap().authorization_id
        } else {
            grant
        };
        if cancel {
            store.cancel_execution(task, ExecutionId::new()).unwrap();
        } else {
            store.revoke_plugin_grant(generation, grant).unwrap();
        }
        let failure = store.commit_artifact_validation(prepared).unwrap_err();
        assert_eq!(
            failure.code,
            if cancel {
                ErrorCode::Cancelled
            } else {
                ErrorCode::Unauthorized
            }
        );
        assert_eq!(state(&store, &input, item), ValidationState::Pending);
        assert_eq!(
            store
                .execution_result(input.envelope().attempt_id, result.envelope().result_id)
                .unwrap()
                .bytes(),
            result.bytes()
        );
    }
}

#[test]
fn replaced_producer_or_checker_result_refuses_an_earlier_prepared_proof() {
    for producer in [false, true] {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let item = input.envelope().items[0].item_id;
        let result = builder_result(&mut store, &input, item);
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let check_input = capture.check_input().clone();
        let checked = passing_results(&capture);
        let (checked, _) = checker_result(&mut store, generation, &capture, checked);
        let (replaced_input, replaced_result) = if producer {
            (&input, &result)
        } else {
            (&check_input, &checked)
        };
        let mut envelope = replaced_result.envelope().clone();
        envelope.result_id = ExecutionId::new();
        envelope.supersedes = Some(replaced_result.envelope().result_id);
        envelope.plugin.as_mut().unwrap().result.result_id = ExecutionId::new().to_string();
        let replacement = FixedResult::capture(
            envelope,
            replaced_input,
            replaced_result.envelope().dispatch_token,
        )
        .unwrap();
        let prepared = capture.prepare(checked).unwrap();
        store.save_execution_result(&replacement).unwrap();
        assert_eq!(
            store.commit_artifact_validation(prepared).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        assert_eq!(state(&store, &input, item), ValidationState::Pending);
        assert_eq!(
            store
                .execution_result(input.envelope().attempt_id, result.envelope().result_id)
                .unwrap()
                .bytes(),
            result.bytes()
        );
    }
}

#[test]
fn each_locale_needs_its_own_artifact_proof_and_reopening_does_not_restore_authority() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN", "fr-FR"]);
    assert_eq!(input.envelope().units.len(), 1);
    let items: Vec<_> = input.envelope().items.iter().map(|i| i.item_id).collect();
    let results: Vec<_> = items
        .iter()
        .map(|i| builder_result(&mut store, &input, *i))
        .collect();
    for (index, result) in results.iter().enumerate() {
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let checked = passing_results(&capture);
        let (checked, _) = checker_result(&mut store, generation, &capture, checked);
        store
            .commit_artifact_validation(capture.prepare(checked).unwrap())
            .unwrap();
        assert_eq!(state(&store, &input, items[index]), ValidationState::Valid);
        if index == 0 {
            assert_eq!(state(&store, &input, items[1]), ValidationState::Pending);
        }
    }
    let path = store.directory().to_owned();
    drop(store);
    let mut reopened = ProjectStore::open(path).unwrap();
    assert!(reopened.check_plugin_input(&input).is_err());
    assert_eq!(
        reopened
            .execution_input(input.envelope().attempt_id)
            .unwrap()
            .bytes(),
        input.bytes()
    );
    for item in items {
        assert_eq!(state(&reopened, &input, item), ValidationState::Valid);
    }
    let target = reopened
        .review_page(input.envelope().project_id, "zh-CN", 0, 100)
        .unwrap()
        .rows[0]
        .unit_id;
    translate(
        &mut reopened,
        input.envelope().project_id,
        target,
        "zh-CN",
        "new user edit",
    );
    assert_eq!(
        reopened
            .execution_result(input.envelope().attempt_id, results[0].envelope().result_id)
            .unwrap()
            .bytes(),
        results[0].bytes()
    );
}

#[test]
fn saved_checker_input_substitution_and_missing_proof_are_rejected_on_reopen() {
    for tamper_input in [false, true] {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let item = input.envelope().items[0].item_id;
        let result = builder_result(&mut store, &input, item);
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let checked = passing_results(&capture);
        let (checked, _) = checker_result(&mut store, generation, &capture, checked);
        store
            .commit_artifact_validation(capture.prepare(checked).unwrap())
            .unwrap();
        let path = store.directory().to_owned();
        if tamper_input {
            let capture = store
                .capture_artifact_validation(
                    input.envelope().attempt_id,
                    result.envelope().result_id,
                )
                .unwrap();
            let mut envelope = capture.check_input().envelope().clone();
            envelope.settings["buildResultDigest"] = serde_json::Value::String("d".repeat(64));
            let different = FixedInput::capture(envelope).unwrap();
            assert!(
                ArtifactValidationCapture::restore(
                    ResultValidationCapture {
                        input: input.clone(),
                        result: result.clone()
                    },
                    different
                )
                .is_err()
            );
            let source_result: String = store
                .connection()
                .unwrap()
                .query_row("SELECT result_id FROM source_snapshots LIMIT 1", [], |r| {
                    r.get(0)
                })
                .unwrap();
            store.connection().unwrap().execute("UPDATE plugin_validation_links SET checker_result_id=?2 WHERE producer_result_id=?1", params![result.envelope().result_id.to_string(), source_result]).unwrap();
        } else {
            store
                .connection()
                .unwrap()
                .execute(
                    "DELETE FROM plugin_validation_links WHERE producer_result_id=?1",
                    [result.envelope().result_id.to_string()],
                )
                .unwrap();
        }
        assert!(
            store
                .execution_attempt(input.envelope().attempt_id, false)
                .is_err()
        );
        drop(store);
        let before = std::fs::read(path.join("project.sqlite3")).unwrap();
        assert!(ProjectStore::open(&path).is_err());
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
    }
}
