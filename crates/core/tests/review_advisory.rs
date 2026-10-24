#![cfg(not(feature = "execution-test-host"))]
//! Actual grants, immutable ledger frames and Core QA with synthetic SDK workers.
//! Installed package execution is covered by the Host joint-review conformance.
mod support;
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{
    AdvisoryReviewCheck, CheckRun, PreparedReviewCheck, ProjectStore, ReviewCheckOrigin,
    ReviewCheckOutcome, ReviewCheckerKind, ReviewDecisionKind, ReviewInvocationOutcome,
    ReviewWrite, SaveTranslationRevision, application::*, execution::*,
};
use tsumugi_plugin_sdk as sdk;

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}
fn choice(store: &ProjectStore, unit: ExecutionId, all: bool) -> AdvisoryReviewCheck {
    let target = store.review_target(project(store), unit, "zh-CN").unwrap();
    let format = store
        .capture_review_check_plan(project(store), unit, "zh-CN", &target.basis, &[])
        .unwrap();
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../plugin-sdk/tests/fixtures/text-review.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_text_review_declaration(include_bytes!(
        "../../plugin-sdk/tests/fixtures/text-review.declaration.json"
    ))
    .unwrap();
    let binding = declaration.bind(&manifest, &"d".repeat(64)).unwrap();
    let pins = binding
        .resources
        .iter()
        .map(|r| sdk::TextReviewResourcePin {
            contribution_id: r.contribution_id.clone(),
            schema: r.schema.clone(),
            sha256: "e".repeat(64),
        })
        .collect();
    let rules = binding
        .declaration
        .rules
        .iter()
        .take(if all { 2 } else { 1 })
        .map(|r| r.rule.clone())
        .collect();
    AdvisoryReviewCheck::capture(
        &binding,
        &tsumugi_core::execution::PluginExecutionBinding {
            component_scope: sdk::ComponentScope::Project,
            application_scope: None,
            capability: binding.checker.clone(),
            profile: Some(binding.declaration.profile.clone()),
            environment: format.binding().checker.environment.clone(),
        },
        "text-review-profile",
        pins,
        rules,
    )
    .unwrap()
}
fn save(store: &mut ProjectStore, unit: ExecutionId, text: &str) {
    let p = project(store);
    let target = store.review_target(p, unit, "zh-CN").unwrap();
    store
        .save_translation_revision(&SaveTranslationRevision {
            project_id: p,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: target.selection_id,
            text: text.into(),
        })
        .unwrap();
}
fn prepare(
    store: &ProjectStore,
    unit: ExecutionId,
    action: ExecutionId,
    choices: &[AdvisoryReviewCheck],
) -> PreparedReviewCheck {
    let p = project(store);
    let target = store.review_target(p, unit, "zh-CN").unwrap();
    store
        .prepare_review_check(p, unit, "zh-CN", &target.basis, action, choices)
        .unwrap()
}
#[derive(Clone, Copy)]
enum Response {
    Exact,
    Finding,
    Unavailable,
    Failed,
    Unknown,
    BadRange,
    Diagnostic(sdk::TextReviewField, sdk::TextRange),
    ForeignProvider,
    MissingResult,
    MissingFormat,
}
struct Checker {
    binding: PluginExecutionBinding,
    text: bool,
    response: Response,
}
impl Runner for Checker {
    fn capability_id(&self) -> &str {
        &self.binding.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.binding.environment)
    }
    fn run(
        &self,
        request: DispatchRequest,
        _cancel: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        let permit = request.plugin_permit().unwrap();
        assert!(permit.matches(&request.input) && permit.is_authorized());
        let selected = &self.binding.capability.provider;
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
        let payload = &request.input.item(request.item_id)?.payload;
        let requirements: Vec<sdk::CheckRequirement> =
            serde_json::from_value(payload["requirements"].clone()).unwrap();
        let mut results: Vec<_> = requirements
            .iter()
            .map(|r| sdk::CheckResult {
                key: r.key.clone(),
                input_digest: r.input_digest.clone(),
                scope_digest: r.scope_digest.clone(),
                covered_targets: r.targets.clone(),
                outcome: r
                    .not_applicable
                    .clone()
                    .map_or(sdk::CheckOutcome::Completed { findings: vec![] }, |basis| {
                        sdk::CheckOutcome::NotApplicable { basis }
                    }),
            })
            .collect();
        let outcome = if self.text && matches!(self.response, Response::Failed | Response::Unknown)
        {
            let error = sdk::EncodedPayload::capture(
                invocation.error_schema.clone(),
                serde_json::to_string(&sdk::ReviewCheckError {
                    code: sdk::ReviewCheckErrorCode::InvalidTranslation,
                    unit_id: None,
                    detail: "Synthetic terminal error".into(),
                })
                .unwrap(),
            )
            .unwrap();
            if matches!(self.response, Response::Failed) {
                sdk::InvocationOutcome::Failed { error }
            } else {
                sdk::InvocationOutcome::Unknown { error }
            }
        } else {
            let mut diagnostics = Vec::new();
            if self.text {
                let input: sdk::TextReviewCheckInput =
                    serde_json::from_value(payload.clone()).unwrap();
                input.validate().unwrap();
                if matches!(
                    self.response,
                    Response::Finding | Response::BadRange | Response::Diagnostic(..)
                ) && input.selections[0].translation_text.is_some()
                {
                    let result = &mut results[0];
                    let target = result.covered_targets[0].clone();
                    result.outcome = sdk::CheckOutcome::Completed {
                        findings: vec![sdk::CheckFinding {
                            code: "preferred-form".into(),
                            target: target.clone(),
                            severity: sdk::FindingSeverity::Warning,
                        }],
                    };
                    diagnostics.push(sdk::TextReviewDiagnostic {
                        key: result.key.clone(),
                        code: "preferred-form".into(),
                        target,
                        location: Some(match self.response {
                            Response::Diagnostic(field, range) => {
                                sdk::TextReviewLocation { field, range }
                            }
                            _ => sdk::TextReviewLocation {
                                field: sdk::TextReviewField::Translation,
                                range: sdk::TextRange {
                                    encoding: sdk::TextEncoding::Utf16,
                                    start: if matches!(self.response, Response::BadRange) {
                                        1
                                    } else {
                                        2
                                    },
                                    end: 6,
                                },
                            },
                        }),
                        detail: Some("Synthetic editorial suggestion".into()),
                        suggestion: Some("preferred".into()),
                        resource_entry: Some(sdk::TextReviewResourceEntry {
                            contribution_id: input.resources[0].contribution_id.clone(),
                            entry_id: "entry-1".into(),
                        }),
                    });
                }
                if matches!(self.response, Response::Unavailable) {
                    results[0].outcome = sdk::CheckOutcome::Unavailable;
                }
                if matches!(self.response, Response::ForeignProvider) {
                    if let sdk::CheckImplementation::Plugin { provider } =
                        &mut results[0].key.implementation
                    {
                        provider.package_digest = "f".repeat(64);
                    }
                }
                if matches!(self.response, Response::MissingResult) {
                    results.clear();
                }
                let report = sdk::TextReviewCheckReport {
                    results,
                    diagnostics,
                };
                sdk::InvocationOutcome::Succeeded {
                    output: sdk::EncodedPayload::capture(
                        invocation.output_schema.clone(),
                        serde_json::to_string(&report).unwrap(),
                    )
                    .unwrap(),
                }
            } else {
                if matches!(self.response, Response::MissingFormat) {
                    results.pop();
                }
                sdk::InvocationOutcome::Succeeded {
                    output: sdk::EncodedPayload::capture(
                        invocation.output_schema.clone(),
                        serde_json::to_string(&results).unwrap(),
                    )
                    .unwrap(),
                }
            }
        };
        sender.send(FixedResult::capture_plugin(
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
                    outcome,
                },
            },
        )?)
    }
}
fn joint_runtime(
    store: &ProjectStore,
    prepared: &PreparedReviewCheck,
    response: Response,
) -> ExecutionRuntime {
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    for checker in prepared.plan().unwrap().checkers() {
        runtime
            .register_read_only(Arc::new(Checker {
                binding: checker.binding.clone(),
                text: checker.kind == ReviewCheckerKind::AdvisoryText,
                response,
            }))
            .unwrap();
    }
    runtime
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
                application_execution: false,
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
            return (
                grant,
                store
                    .execution_result(input.envelope().attempt_id, id)
                    .unwrap(),
            );
        }
        assert!(
            Instant::now() < deadline,
            "joint synthetic completion deadline"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn execute_all(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    prepared: &PreparedReviewCheck,
) -> (Vec<ExecutionId>, Vec<ReviewCheckOrigin>) {
    let mut grants = Vec::new();
    let mut origins = Vec::new();
    for (checker, input) in prepared
        .plan()
        .unwrap()
        .checkers()
        .iter()
        .zip(prepared.execution_inputs())
    {
        let (grant, result) = execute(runtime, store, input);
        grants.push(grant);
        origins.push(ReviewCheckOrigin {
            checker: checker.key.clone(),
            attempt_id: input.envelope().attempt_id,
            result_id: result.envelope().result_id,
        });
    }
    (grants, origins)
}
fn approve(store: &mut ProjectStore, unit: ExecutionId) {
    let p = project(store);
    let target = store.review_target(p, unit, "zh-CN").unwrap();
    store
        .write_review(&ReviewWrite {
            project_id: p,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            expected_decision_id: target.current_decision.as_ref().map(|d| d.decision_id),
            actor: "Synthetic reviewer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: String::new(),
        })
        .unwrap();
}
fn no_unit_blockers(store: &ProjectStore, unit: ExecutionId) {
    let eligibility = store
        .review_eligibility(project(store), &["zh-CN".into()])
        .unwrap();
    assert!(
        !eligibility.locales[0]
            .blockers
            .iter()
            .any(|b| b.unit_id == unit),
        "{:?}",
        eligibility.locales[0].blockers
    );
}
fn check_evidence(run: &CheckRun, choice: &AdvisoryReviewCheck) {
    let evidence = run.evidence.as_ref().unwrap();
    assert_eq!(evidence.advisory_checks, [choice.clone()]);
    assert_eq!(evidence.origins.len(), 2);
    assert!(
        run.rules
            .iter()
            .zip(&evidence.required_checks.requirements)
            .all(|(rule, req)| rule.key == req.key && rule.mandatory == req.mandatory)
    );
}

#[test]
fn explicit_subset_pins_and_exact_checker_identities_are_captured_without_changing_manual_basis() {
    let (_dir, store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let c = choice(&store, unit, false);
    let action = ExecutionId::new();
    let prepared = prepare(&store, unit, action, &[c.clone()]);
    let plan = prepared.plan().unwrap();
    assert_eq!(plan.checkers().len(), 2);
    assert_eq!(prepared.execution_inputs().len(), 2);
    assert_ne!(
        prepared.execution_inputs()[0].envelope().task_id,
        prepared.execution_inputs()[1].envelope().task_id
    );
    for input in prepared.execution_inputs() {
        assert_ne!(input.envelope().task_id, action);
        assert_eq!(input.envelope().settings["actionId"], action.to_string());
        prepared.validate_execution_input(input).unwrap();
    }
    let text: sdk::TextReviewCheckInput = serde_json::from_value(
        prepared.execution_inputs()[1].envelope().items[0]
            .payload
            .clone(),
    )
    .unwrap();
    assert_eq!(text.requirements.len(), 1);
    assert_eq!(text.resources, c.resource_pins);
    assert!(
        text.requirements
            .iter()
            .all(|r| !r.mandatory && !r.waivable)
    );
    assert!(
        plan.domain_input()
            .requirements
            .iter()
            .all(|r| r.mandatory && !r.waivable)
    );
    let other = prepare(&store, unit, action, &[choice(&store, unit, true)]);
    assert_eq!(plan.review_basis(), other.plan().unwrap().review_basis());
    assert_ne!(plan.basis(), other.plan().unwrap().basis());
    assert!(
        other
            .validate_execution_input(&prepared.execution_inputs()[1])
            .is_err()
    );
    for field in ["actionId", "checkerKey", "advisoryChecks"] {
        let mut forged = prepared.execution_inputs()[1].envelope().clone();
        forged.settings[field] = serde_json::Value::Null;
        assert!(
            prepared
                .validate_execution_input(&FixedInput::capture(forged).unwrap())
                .is_err()
        );
    }
    for variant in 0..7 {
        let mut invalid = c.clone();
        match variant {
            0 => invalid.resource_pins[0].sha256 = "E".repeat(64),
            1 => invalid.resource_pins[0].sha256 = "0".repeat(63),
            2 => invalid.resource_pins[0].schema.behavior_version += 1,
            3 => invalid.binding.checker.provider.package_digest = "0".repeat(63),
            4 => invalid.rules.clear(),
            5 => invalid.declaration_resource_id = "UPPER".into(),
            _ => invalid.resource_pins[0].contribution_id = "other-resource".into(),
        }
        assert!(invalid.validate().is_err(), "variant {variant}");
    }
    let mut bounded = c.clone();
    bounded.binding.checker.declaration.limits.max_input_bytes = 64;
    assert!(
        bounded.validate().is_err(),
        "changing a declaration alone cannot replace the captured execution binding"
    );
    bounded.execution.capability = bounded.binding.checker.clone();
    bounded.validate().unwrap();
    let target = store.review_target(project(&store), unit, "zh-CN").unwrap();
    assert_eq!(
        store
            .capture_review_check_plan(project(&store), unit, "zh-CN", &target.basis, &[bounded])
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let mut with_owner_name = c.clone();
    with_owner_name.declaration_resource_id = "review/text-profile".into();
    with_owner_name.validate().unwrap();
    assert!(
        store
            .prepare_review_check(
                project(&store),
                unit,
                "zh-CN",
                plan.review_basis(),
                action,
                &[c.clone(), c]
            )
            .is_err()
    );
}

#[test]
fn advisory_warning_retains_utf16_diagnostics_and_all_original_frames_without_blocking_qualification()
 {
    let (dir, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "😀same");
    let c = choice(&store, unit, false);
    let action = ExecutionId::new();
    let prepared = prepare(&store, unit, action, &[c.clone()]);
    let mut runtime = joint_runtime(&store, &prepared, Response::Finding);
    let (grants, origins) = execute_all(&mut runtime, &mut store, &prepared);
    let computed = store
        .capture_review_check_execution(prepared.clone(), &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert!(computed.coverage().complete);
    assert_eq!(
        computed.diagnostics()[0]
            .location
            .as_ref()
            .unwrap()
            .range
            .end,
        6
    );
    for origin in &origins {
        assert_eq!(
            computed
                .checker_result(&origin.checker)
                .unwrap()
                .envelope()
                .result_id,
            origin.result_id
        );
        assert_eq!(
            computed
                .checker_input(&origin.checker)
                .unwrap()
                .envelope()
                .attempt_id,
            origin.attempt_id
        );
    }
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    check_evidence(&run, &c);
    assert_eq!(run.outcome, ReviewCheckOutcome::Completed);
    let advisory = run.rules.iter().find(|r| !r.mandatory).unwrap();
    assert_eq!(advisory.status, "findings");
    assert!(!advisory.findings[0].waivable);
    approve(&mut store, unit);
    no_unit_blockers(&store, unit);
    for grant in grants {
        runtime.revoke_plugin(&mut store, grant).unwrap();
    }
    assert_eq!(
        store.review_check_action(project(&store), action).unwrap(),
        Some(run.clone())
    );
    assert_eq!(
        prepare(&store, unit, action, &[c.clone()]).recorded_run(),
        Some(&run)
    );
    assert!(
        store
            .prepare_review_check(
                project(&store),
                unit,
                "zh-CN",
                &run.basis,
                action,
                &[choice(&store, unit, true)]
            )
            .is_err()
    );
    store.close().unwrap();
    let reopened = ProjectStore::open(&dir.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .review_check_action(project(&reopened), action)
            .unwrap(),
        Some(run.clone())
    );
    assert_eq!(
        reopened
            .review_target(project(&reopened), unit, "zh-CN")
            .unwrap()
            .current_check,
        Some(run)
    );
    no_unit_blockers(&reopened, unit);
}

#[test]
fn real_terminal_advisory_failures_and_unknowns_are_preserved_without_fabricated_results() {
    for (response, outcome, invocation, status) in [
        (
            Response::Failed,
            ReviewCheckOutcome::Failed,
            ReviewInvocationOutcome::Failed,
            "failed",
        ),
        (
            Response::Unknown,
            ReviewCheckOutcome::Unknown,
            ReviewInvocationOutcome::Unknown,
            "unknown",
        ),
        (
            Response::Unavailable,
            ReviewCheckOutcome::Failed,
            ReviewInvocationOutcome::Succeeded,
            "unavailable",
        ),
    ] {
        let (_dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "same");
        let c = choice(&store, unit, false);
        let prepared = prepare(&store, unit, ExecutionId::new(), &[c.clone()]);
        let mut runtime = joint_runtime(&store, &prepared, response);
        let (_, origins) = execute_all(&mut runtime, &mut store, &prepared);
        let computed = store
            .capture_review_check_execution(prepared, &origins)
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        assert!(computed.coverage().complete);
        let run = store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap();
        check_evidence(&run, &c);
        assert_eq!(run.outcome, outcome);
        let evidence = run.evidence.as_ref().unwrap();
        assert_eq!(
            evidence
                .origins
                .iter()
                .find(|o| o.checker == c.checker().key)
                .unwrap()
                .outcome,
            invocation
        );
        assert_eq!(
            run.rules.iter().find(|r| !r.mandatory).unwrap().status,
            status
        );
        if invocation != ReviewInvocationOutcome::Succeeded {
            assert!(!evidence.results.iter().any(|r| r.key.implementation
                == (sdk::CheckImplementation::Plugin {
                    provider: c.binding.checker.provider.clone()
                })));
        }
        approve(&mut store, unit);
        no_unit_blockers(&store, unit);
    }
}

#[test]
fn malformed_advisory_reports_and_misattributed_origins_never_create_qa() {
    for response in [
        Response::BadRange,
        Response::ForeignProvider,
        Response::MissingResult,
    ] {
        let (_dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "😀same");
        let c = choice(&store, unit, false);
        let action = ExecutionId::new();
        let prepared = prepare(&store, unit, action, &[c]);
        let mut runtime = joint_runtime(&store, &prepared, response);
        let (_, origins) = execute_all(&mut runtime, &mut store, &prepared);
        assert!(
            store
                .capture_review_check_execution(prepared, &origins)
                .unwrap()
                .compute(&Cancellation::default())
                .is_err()
        );
        assert!(
            store
                .review_check_action(project(&store), action)
                .unwrap()
                .is_none()
        );
    }
    let (_dir, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "same");
    let c = choice(&store, unit, false);
    let prepared = prepare(&store, unit, ExecutionId::new(), &[c]);
    let mut runtime = joint_runtime(&store, &prepared, Response::Exact);
    let (_, origins) = execute_all(&mut runtime, &mut store, &prepared);
    assert!(
        store
            .capture_review_check_execution(prepared.clone(), &origins[..1])
            .is_err()
    );
    let mut duplicated = origins.clone();
    duplicated[1] = duplicated[0].clone();
    assert!(
        store
            .capture_review_check_execution(prepared.clone(), &duplicated)
            .is_err()
    );
    let mut swapped = origins.clone();
    let key = swapped[0].checker.clone();
    swapped[0].checker = swapped[1].checker.clone();
    swapped[1].checker = key;
    assert!(
        store
            .capture_review_check_execution(prepared, &swapped)
            .is_err()
    );
}

#[test]
fn mandatory_format_coverage_remains_required_and_missing_translation_differs_from_empty() {
    let (_dir, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let c = choice(&store, unit, true);
    let missing = prepare(&store, unit, ExecutionId::new(), &[c.clone()]);
    let text: sdk::TextReviewCheckInput = serde_json::from_value(
        missing.execution_inputs()[1].envelope().items[0]
            .payload
            .clone(),
    )
    .unwrap();
    assert!(text.selections[0].translation_text.is_none());
    assert!(
        text.requirements
            .iter()
            .find(|r| r.key.rule == c.rules[0])
            .unwrap()
            .not_applicable
            .is_some()
    );
    assert!(
        text.requirements
            .iter()
            .find(|r| r.key.rule == c.rules[1])
            .unwrap()
            .not_applicable
            .is_none()
    );
    let mut runtime = joint_runtime(&store, &missing, Response::Exact);
    let (_, origins) = execute_all(&mut runtime, &mut store, &missing);
    let computed = store
        .capture_review_check_execution(missing, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert!(computed.results().iter().any(|r| r.key.rule == c.rules[0]
        && matches!(r.outcome, sdk::CheckOutcome::NotApplicable { .. })));
    save(&mut store, unit, "");
    let empty = prepare(&store, unit, ExecutionId::new(), &[c.clone()]);
    let text: sdk::TextReviewCheckInput = serde_json::from_value(
        empty.execution_inputs()[1].envelope().items[0]
            .payload
            .clone(),
    )
    .unwrap();
    assert_eq!(text.selections[0].translation_text.as_deref(), Some(""));
    assert!(text.requirements.iter().all(|r| r.not_applicable.is_none()));
    let mut runtime = joint_runtime(&store, &empty, Response::MissingFormat);
    let (_, origins) = execute_all(&mut runtime, &mut store, &empty);
    let computed = store
        .capture_review_check_execution(empty, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert!(!computed.coverage().complete);
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    assert_eq!(run.outcome, ReviewCheckOutcome::Failed);
    assert!(
        run.rules
            .iter()
            .any(|r| r.mandatory && r.status == "missing")
    );
}

#[test]
fn every_live_grant_cancellation_and_original_check_cas_are_rechecked_atomically() {
    for revoke in [false, true] {
        let (_dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "same");
        let c = choice(&store, unit, false);
        let action = ExecutionId::new();
        let prepared = prepare(&store, unit, action, &[c]);
        let mut runtime = joint_runtime(&store, &prepared, Response::Exact);
        let (grants, origins) = execute_all(&mut runtime, &mut store, &prepared);
        let computed = store
            .capture_review_check_execution(prepared.clone(), &origins)
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        if revoke {
            runtime.revoke_plugin(&mut store, grants[1]).unwrap();
        } else {
            runtime
                .cancel(
                    &mut store,
                    prepared.execution_inputs()[1].envelope().task_id,
                    ExecutionId::new(),
                )
                .unwrap();
        }
        assert!(
            store
                .commit_review_evidence(computed, &Cancellation::default())
                .is_err()
        );
        assert!(
            store
                .review_check_action(project(&store), action)
                .unwrap()
                .is_none()
        );
    }
    let (_dir, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "same");
    let c = choice(&store, unit, false);
    let action = ExecutionId::new();
    let old = prepare(&store, unit, action, &[c]);
    let mut runtime = joint_runtime(&store, &old, Response::Exact);
    let (_, old_origins) = execute_all(&mut runtime, &mut store, &old);
    let old = store
        .capture_review_check_execution(old, &old_origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let newer = prepare(&store, unit, ExecutionId::new(), &[]);
    let (_, newer_origins) = execute_all(&mut runtime, &mut store, &newer);
    let newer = store
        .capture_review_check_execution(newer, &newer_origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let run = store
        .commit_review_evidence(newer, &Cancellation::default())
        .unwrap();
    assert_eq!(
        store
            .commit_review_evidence(old, &Cancellation::default())
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(
        store
            .review_target(project(&store), unit, "zh-CN")
            .unwrap()
            .current_check,
        Some(run)
    );
}

#[test]
fn work_plan_captures_choices_in_its_original_digest_and_exposes_exact_fixed_slots() {
    let (_dir, store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let c = choice(&store, unit, false);
    let mut options = PlanOptions::default();
    options.stages.iter_mut().for_each(|s| {
        s.mode = if s.stage == WorkStage::Checks {
            StageMode::Assisted
        } else {
            StageMode::Manual
        }
    });
    options.advisory_checks = vec![c.clone()];
    let plan = store
        .prepare_work_plan(None, "zh-CN", &[unit], options)
        .unwrap();
    store.verify_work_plan(&plan).unwrap();
    let slots = store.work_plan_review_checkers(&plan).unwrap();
    assert_eq!(slots.len(), 2);
    assert_eq!(slots[0].kind, ReviewCheckerKind::Format);
    assert_eq!(slots[1].key, c.checker().key);
    let mut changed = plan.clone();
    changed.options.advisory_checks[0].resource_pins[0].sha256 = "f".repeat(64);
    assert!(changed.validate().is_err());
    let mut changed = plan.clone();
    changed.options.advisory_checks.clear();
    assert!(changed.validate().is_err());
}

#[test]
fn stored_mandatory_identity_and_any_original_frame_cannot_be_forged_by_projection() {
    for alter_requirement in [false, true] {
        let (dir, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "same");
        let c = choice(&store, unit, false);
        let prepared = prepare(&store, unit, ExecutionId::new(), &[c]);
        let action = prepared.execution_inputs()[0].envelope().settings["actionId"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut runtime = joint_runtime(&store, &prepared, Response::Exact);
        let (_, origins) = execute_all(&mut runtime, &mut store, &prepared);
        let computed = store
            .capture_review_check_execution(prepared, &origins)
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap();
        let connection =
            rusqlite::Connection::open(dir.path().join("project/project.sqlite3")).unwrap();
        let column = if alter_requirement {
            "evidence_json"
        } else {
            "rules_json"
        };
        let raw: String = connection
            .query_row(
                &format!("SELECT {column} FROM review_checks WHERE action_id=?1"),
                [&action],
                |r| r.get(0),
            )
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if alter_requirement {
            let required = value["requiredChecks"]["requirements"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| r["mandatory"] == true && r["key"]["implementation"]["kind"] == "plugin")
                .unwrap();
            required["mandatory"] = serde_json::json!(false);
        } else {
            let required = value
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| r["mandatory"] == true)
                .unwrap();
            required["mandatory"] = serde_json::json!(false);
        }
        connection
            .execute(
                &format!("UPDATE review_checks SET {column}=?1 WHERE action_id=?2"),
                rusqlite::params![value.to_string(), action],
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            store
                .review_target(project(&store), unit, "zh-CN")
                .unwrap_err()
                .code,
            ErrorCode::CorruptLedger
        );
    }
}

#[test]
fn distinct_text_providers_keep_independent_keys_and_origins_when_rule_labels_match() {
    let (_dir, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "😀same");
    let first = choice(&store, unit, false);
    let mut second = first.clone();
    second.binding.checker.provider.package_digest = "f".repeat(64);
    assert!(
        second.validate().is_err(),
        "a provider substitution must not retain the original execution binding"
    );
    second.execution.capability = second.binding.checker.clone();
    second.validate().unwrap();
    let prepared = prepare(&store, unit, ExecutionId::new(), &[first, second]);
    assert_eq!(prepared.plan().unwrap().checkers().len(), 3);
    assert_eq!(
        prepared
            .execution_inputs()
            .iter()
            .map(|i| i.envelope().task_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
    let mut runtime = joint_runtime(&store, &prepared, Response::Finding);
    let (_, origins) = execute_all(&mut runtime, &mut store, &prepared);
    let computed = store
        .capture_review_check_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    let advisory: Vec<_> = run.rules.iter().filter(|r| !r.mandatory).collect();
    assert_eq!(advisory.len(), 2);
    assert_eq!(advisory[0].rule, advisory[1].rule);
    assert_ne!(advisory[0].key, advisory[1].key);
    assert_ne!(
        advisory[0].findings[0].issue_id,
        advisory[1].findings[0].issue_id
    );
    assert_eq!(run.evidence.as_ref().unwrap().origins.len(), 3);
    assert_eq!(run.evidence.as_ref().unwrap().diagnostics.len(), 2);
    assert_eq!(
        store
            .review_target(project(&store), unit, "zh-CN")
            .unwrap()
            .current_check,
        Some(run)
    );
}

#[path = "support/automatic.rs"]
mod automatic;
#[test]
fn automatic_selection_uses_saved_plan_choices_and_atomically_adopts_the_full_union() {
    let (_dir, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let c = choice(&store, unit, false);
    let request = automatic::candidate_request_with_advisory(
        &mut store,
        unit,
        "😀same",
        SelectionPolicy::MissingOnly,
        &[c.clone()],
    );
    let prepared = store.prepare_automatic_selection(&request).unwrap();
    let check = prepared.review_check().unwrap();
    assert_eq!(check.plan().unwrap().advisory_checks(), &[c.clone()]);
    let mut runtime = joint_runtime(&store, check, Response::Finding);
    let (_, origins) = execute_all(&mut runtime, &mut store, check);
    let computed = store
        .capture_automatic_selection_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let receipt = store
        .commit_automatic_selection(computed, &Cancellation::default())
        .unwrap();
    assert!(receipt.blocked.is_none());
    let target = store
        .review_target(request.project_id, unit, "zh-CN")
        .unwrap();
    assert_eq!(target.revision_id, Some(request.revision_id));
    let run = target.current_check.unwrap();
    check_evidence(&run, &c);
    assert_eq!(receipt.check_run_id, Some(run.run_id));
    assert_eq!(receipt.evidence, run.evidence);
    assert_eq!(
        store
            .automatic_selection_receipt(request.action_id)
            .unwrap(),
        Some(receipt)
    );
}

#[test]
fn advisory_review_captures_execution_scope_without_changing_required_policy() {
    let (_directory, store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let original = choice(&store, unit, true);
    let mut attempt = original.clone();
    attempt.execution.component_scope = sdk::ComponentScope::Attempt;
    attempt.validate().unwrap();
    assert_eq!(attempt.binding, original.binding);
    assert_eq!(attempt.rules, original.rules);
    assert_eq!(attempt.resource_pins, original.resource_pins);
    assert_eq!(attempt.checker().binding, attempt.execution);
    let mut missing = serde_json::to_value(&attempt).unwrap();
    missing.as_object_mut().unwrap().remove("execution");
    assert!(serde_json::from_value::<AdvisoryReviewCheck>(missing).is_err());
    let mut wrong = attempt.clone();
    wrong.execution.capability = store
        .capture_review_check_plan(
            project(&store),
            unit,
            "zh-CN",
            &store
                .review_target(project(&store), unit, "zh-CN")
                .unwrap()
                .basis,
            &[],
        )
        .unwrap()
        .binding()
        .checker
        .capability
        .clone();
    assert!(wrong.validate().is_err());
    wrong = attempt;
    wrong.execution.component_scope = sdk::ComponentScope::Application;
    assert!(wrong.validate().is_err());
}

#[path = "review_advisory/candidate_checks.rs"]
mod candidate_checks;

#[path = "review_advisory/diagnostic_location.rs"]
mod diagnostic_location;
#[path = "review_advisory/semantic_review.rs"]
mod semantic_review;
