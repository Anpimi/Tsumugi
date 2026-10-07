#![cfg(not(feature = "execution-test-host"))]
//! Actual Core grants/runtime/SQLite with an in-process synthetic checker.
//! Installed Node workers are covered separately by plugin-host conformance.
mod support;
use std::sync::Arc;
use tsumugi_core::{
    ComputedReviewEvidence, PreparedReviewCheck, ProjectStore, ReviewCheckOrigin, ReviewCheckerKey,
    ReviewDecisionKind, ReviewWrite, SaveTranslationRevision, execution::*,
};
use tsumugi_plugin_sdk as sdk;

#[derive(Clone, Copy)]
enum Response {
    Exact,
    Finding,
    Empty,
    Missing,
    Core,
    Provider,
    Version,
    Input,
    Scope,
    Target,
    Duplicate,
    Na,
}
struct Checker {
    binding: PluginExecutionBinding,
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
        cancellation: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        assert!(!cancellation.is_requested());
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
        let input: sdk::ReviewCheckInput =
            serde_json::from_value(request.input.item(request.item_id)?.payload.clone()).unwrap();
        input.validate().unwrap();
        let mut results: Vec<_> = input
            .requirements
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
        match self.response {
            Response::Exact => {}
            Response::Finding => {
                results[0].outcome = sdk::CheckOutcome::Completed {
                    findings: vec![sdk::CheckFinding {
                        code: "missing".into(),
                        target: results[0].covered_targets[0].clone(),
                        severity: sdk::FindingSeverity::Error,
                    }],
                }
            }
            Response::Empty => results.clear(),
            Response::Missing => {
                results.pop();
            }
            Response::Core => {
                let fixed: sdk::RequiredCheckSet = serde_json::from_value(
                    request.input.envelope().settings["requiredChecks"].clone(),
                )
                .unwrap();
                results[0].key = fixed
                    .requirements
                    .iter()
                    .find(|r| matches!(r.key.implementation, sdk::CheckImplementation::Core { .. }))
                    .unwrap()
                    .key
                    .clone();
            }
            Response::Provider => {
                let sdk::CheckImplementation::Plugin { provider } =
                    &mut results[0].key.implementation
                else {
                    panic!()
                };
                provider.package_digest = "d".repeat(64);
            }
            Response::Version => results[0].key.rule.behavior_version += 1,
            Response::Input => results[0].input_digest = "d".repeat(64),
            Response::Scope => results[0].scope_digest = "d".repeat(64),
            Response::Target => results[0].covered_targets[0] = "unselected-unit".into(),
            Response::Duplicate => results.push(results[0].clone()),
            Response::Na => {
                results[0].outcome = sdk::CheckOutcome::NotApplicable {
                    basis: sdk::NotApplicableBasis {
                        code: sdk::MISSING_REVIEW_TRANSLATION.into(),
                        basis_digest: "d".repeat(64),
                    },
                }
            }
        }
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
                    outcome: sdk::InvocationOutcome::Succeeded {
                        output: sdk::EncodedPayload::capture(
                            invocation.output_schema,
                            serde_json::to_string(&results).unwrap(),
                        )
                        .unwrap(),
                    },
                },
            },
        )?)
    }
}
fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}
fn prepare(store: &ProjectStore, unit: ExecutionId, action: ExecutionId) -> PreparedReviewCheck {
    let project = project(store);
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .prepare_review_check(project, unit, "zh-CN", &target.basis, action, &[])
        .unwrap()
}
fn execution_input(prepared: &PreparedReviewCheck) -> FixedInput {
    let inputs = prepared.execution_inputs();
    assert_eq!(inputs.len(), 1, "format-only fixture has one checker input");
    inputs[0].clone()
}
fn checker_key(prepared: &PreparedReviewCheck, input: &FixedInput) -> ReviewCheckerKey {
    let key: ReviewCheckerKey =
        serde_json::from_value(input.envelope().settings["checkerKey"].clone()).unwrap();
    assert!(
        prepared
            .plan()
            .unwrap()
            .checkers()
            .iter()
            .any(|checker| checker.key == key)
    );
    key
}
fn capture_review(
    store: &ProjectStore,
    prepared: PreparedReviewCheck,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<tsumugi_core::CapturedReviewCheckExecution, ExecutionError> {
    let checker = checker_key(&prepared, input);
    store.capture_review_check_execution(
        prepared,
        &[ReviewCheckOrigin {
            checker,
            attempt_id: input.envelope().attempt_id,
            result_id: result.envelope().result_id,
        }],
    )
}
fn save(store: &mut ProjectStore, unit: ExecutionId, text: &str) {
    let project = project(store);
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
fn runtime(
    store: &ProjectStore,
    prepared: &PreparedReviewCheck,
    response: Response,
) -> ExecutionRuntime {
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime
        .register(Arc::new(Checker {
            binding: prepared.plan().unwrap().binding().checker.clone(),
            response,
        }))
        .unwrap();
    runtime
}

#[test]
fn live_exact_result_is_bound_to_the_action_and_computes_outside_sqlite_without_qa_receipt() {
    let (directory, mut store, rows) = support::source_fixture();
    let unit = rows[1].unit_id.unwrap();
    let action = ExecutionId::new();
    let prepared = prepare(&store, unit, action);
    let mut runtime = runtime(&store, &prepared, Response::Exact);
    let input = execution_input(&prepared);
    assert!(prepared.recorded_run().is_none());
    prepared.validate_execution_input(&input).unwrap();
    let mut substituted = input.envelope().clone();
    substituted.settings["actionId"] = serde_json::json!(ExecutionId::new());
    assert_eq!(
        prepared
            .validate_execution_input(&FixedInput::capture(substituted).unwrap())
            .unwrap_err()
            .stage,
        "semantic-check-input"
    );
    let mut substituted = input.envelope().clone();
    substituted.items[0].payload["targetLocale"] = serde_json::json!("ja-JP");
    assert!(
        prepared
            .validate_execution_input(&FixedInput::capture(substituted).unwrap())
            .is_err()
    );
    assert_eq!(
        input.envelope().settings["actionId"],
        serde_json::json!(action)
    );
    assert_eq!(input.envelope().operation, REVIEW_CHECK_OPERATION);
    assert_eq!(
        input.envelope().plugin.as_ref().unwrap(),
        &prepared.plan().unwrap().binding().checker
    );
    assert_eq!(
        input
            .item(input.envelope().items[0].item_id)
            .unwrap()
            .payload,
        serde_json::to_value(prepared.plan().unwrap().domain_input()).unwrap()
    );
    assert_eq!(
        runtime.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    let (_, result) = support::execute(&mut runtime, &mut store, &input);
    let path = directory.path().join("project/project.sqlite3");
    let before = std::fs::read(&path).unwrap();
    let checker = checker_key(&prepared, &input);
    let captured = capture_review(&store, prepared, &input, &result).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(
        store
            .review_target(project(&store), unit, "zh-CN")
            .unwrap()
            .current_check
            .is_none()
    );
    store.close().unwrap();
    let computed = captured.compute(&Cancellation::default()).unwrap();
    assert_eq!(computed.action_id(), action);
    assert_eq!(
        computed.checker_input(&checker).unwrap().digest(),
        input.digest()
    );
    assert_eq!(
        computed.checker_result(&checker).unwrap().digest(),
        result.digest()
    );
    assert!(computed.coverage().complete);
    assert_eq!(
        computed.results().len(),
        computed.plan().fixed_checks().set().requirements.len()
    );
    assert_eq!(computed.core_rules().len(), 2);
    assert_eq!(computed.core_rules()[0].findings[0].code, "missing");
    let reopened = ProjectStore::open(&directory.path().join("project")).unwrap();
    assert!(
        reopened
            .review_target(project(&reopened), unit, "zh-CN")
            .unwrap()
            .current_check
            .is_none()
    );
}

#[test]
fn empty_or_partial_actual_output_preserves_missing_mandatory_coverage() {
    for response in [Response::Empty, Response::Missing] {
        let (_directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "译文");
        let prepared = prepare(&store, unit, ExecutionId::new());
        let mut runtime = runtime(&store, &prepared, response);
        let input = execution_input(&prepared);
        let (_, result) = support::execute(&mut runtime, &mut store, &input);
        let computed = capture_review(&store, prepared, &input, &result)
            .unwrap()
            .compute(&Cancellation::default())
            .unwrap();
        assert!(!computed.coverage().complete);
        assert!(
            store
                .review_target(project(&store), unit, "zh-CN")
                .unwrap()
                .current_check
                .is_none()
        );
    }
}

#[test]
fn authorized_synthetic_checker_cannot_forge_core_provider_version_basis_scope_or_applicability() {
    for response in [
        Response::Core,
        Response::Provider,
        Response::Version,
        Response::Input,
        Response::Scope,
        Response::Target,
        Response::Duplicate,
        Response::Na,
    ] {
        let (_directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "译文");
        let prepared = prepare(&store, unit, ExecutionId::new());
        let mut runtime = runtime(&store, &prepared, response);
        let input = execution_input(&prepared);
        let (_, result) = support::execute(&mut runtime, &mut store, &input);
        let captured = capture_review(&store, prepared, &input, &result).unwrap();
        assert_eq!(
            captured.compute(&Cancellation::default()).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        assert!(
            store
                .review_target(project(&store), unit, "zh-CN")
                .unwrap()
                .current_check
                .is_none()
        );
    }
}

#[test]
fn another_action_or_substituted_input_cannot_supply_review_evidence() {
    for substitute in [false, true] {
        let (_directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "译文");
        let prepared = prepare(&store, unit, ExecutionId::new());
        let mut runtime = runtime(&store, &prepared, Response::Exact);
        let mut envelope = execution_input(&prepared).envelope().clone();
        if substitute {
            envelope.items[0].payload["selections"][0]["translationText"] =
                serde_json::json!("替换");
        } else {
            envelope.settings["actionId"] = serde_json::json!(ExecutionId::new());
        }
        let input = FixedInput::capture(envelope).unwrap();
        let (_, result) = support::execute(&mut runtime, &mut store, &input);
        assert_eq!(
            capture_review(&store, prepared, &input, &result)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
    }
}

#[test]
fn revoked_grant_refuses_capture_and_cancelled_owned_computation_retains_actual_domain_evidence() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "译文");
    let action = ExecutionId::new();
    let prepared = prepare(&store, unit, action);
    let mut runtime = runtime(&store, &prepared, Response::Exact);
    let input = execution_input(&prepared);
    let (grant, result) = support::execute(&mut runtime, &mut store, &input);
    let checker = checker_key(&prepared, &input);
    let captured = capture_review(&store, prepared, &input, &result).unwrap();
    runtime.revoke_plugin(&mut store, grant).unwrap();
    assert_eq!(
        capture_review(&store, prepare(&store, unit, action), &input, &result)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let cancellation = Cancellation::default();
    cancellation.request();
    let computed = captured.compute(&cancellation).unwrap();
    assert!(!computed.coverage().complete);
    assert_eq!(
        computed.checker_result(&checker).unwrap().digest(),
        result.digest()
    );
    assert!(
        computed
            .core_rules()
            .iter()
            .all(|r| r.status == "cancelled" && r.findings.is_empty())
    );
    assert!(
        computed
            .results()
            .iter()
            .filter(|r| matches!(
                r.key.implementation,
                sdk::CheckImplementation::Plugin { .. }
            ))
            .all(|r| matches!(r.outcome, sdk::CheckOutcome::Completed { .. }))
    );
}

fn compute_actual(
    store: &mut ProjectStore,
    unit: ExecutionId,
    response: Response,
) -> (ComputedReviewEvidence, ExecutionRuntime, ExecutionId) {
    let prepared = prepare(store, unit, ExecutionId::new());
    let mut runtime = runtime(store, &prepared, response);
    let input = execution_input(&prepared);
    let (grant, result) = support::execute(&mut runtime, store, &input);
    let computed = capture_review(store, prepared, &input, &result)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    (computed, runtime, grant)
}
fn approve(store: &mut ProjectStore, unit: ExecutionId) {
    let project = project(store);
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    store
        .write_review(&ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            expected_decision_id: target.current_decision.map(|r| r.decision_id),
            actor: "Synthetic reviewer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: "Accepted synthetic text".into(),
        })
        .unwrap();
}

#[test]
fn adopted_actual_union_is_current_durable_and_idempotent_after_grant_ends() {
    let (directory, mut store, rows) = support::source_fixture_with_review_rules(
        (0..3)
            .map(|n| sdk::ReviewRuleDeclaration {
                rule: sdk::ContractRef {
                    id: format!("synthetic-rule-{n}"),
                    schema_version: 1,
                    behavior_version: 1,
                },
                requires_translation: n != 0,
            })
            .collect(),
    );
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "译文");
    approve(&mut store, unit);
    let (computed, runtime, grant) = compute_actual(&mut store, unit, Response::Exact);
    let action = computed.action_id();
    let results = computed.results().to_vec();
    assert_eq!(results.len(), 5);
    let qa_basis = computed.plan().basis().to_owned();
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    assert_eq!(run.evidence.as_ref().unwrap().results, results);
    assert_eq!(run.evidence.as_ref().unwrap().qa_basis, qa_basis);
    assert_eq!(
        store
            .review_target(project(&store), unit, "zh-CN")
            .unwrap()
            .current_check,
        Some(run.clone())
    );
    let eligibility = store
        .review_eligibility(project(&store), &["zh-CN".into()])
        .unwrap();
    assert!(
        !eligibility.locales[0]
            .blockers
            .iter()
            .any(|b| b.unit_id == unit)
    );
    runtime.revoke_plugin(&mut store, grant).unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory.path().join("project")).unwrap();
    let target = reopened
        .review_target(project(&reopened), unit, "zh-CN")
        .unwrap();
    assert_eq!(target.current_check, Some(run.clone()));
    assert!(target.current_decision.is_some());
    let prepared = prepare(&reopened, unit, action);
    assert!(prepared.plan().is_none());
    assert_eq!(prepared.recorded_run(), Some(&run));
}

#[test]
fn partial_actual_union_is_saved_as_blocking_coverage_not_empty_success() {
    for response in [Response::Empty, Response::Missing] {
        let (_directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "译文");
        approve(&mut store, unit);
        let (computed, _runtime, _grant) = compute_actual(&mut store, unit, response);
        let run = store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap();
        assert!(run.rules.iter().any(|r| r.status == "missing"));
        assert_eq!(run.outcome, tsumugi_core::ReviewCheckOutcome::Failed);
        assert!(
            store
                .review_target(project(&store), unit, "zh-CN")
                .unwrap()
                .current_check
                .is_some()
        );
        let eligibility = store
            .review_eligibility(project(&store), &["zh-CN".into()])
            .unwrap();
        assert!(
            eligibility.locales[0]
                .blockers
                .iter()
                .any(|b| b.unit_id == unit && b.code == "qa-incomplete-coverage")
        );
    }
}

#[test]
fn adoption_rechecks_revocation_cancellation_selection_and_concurrent_check_without_partial_writes()
{
    for fault in ["revoke", "cancel", "selection", "cas"] {
        let (directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "译文");
        let (computed, mut runtime, grant) = compute_actual(&mut store, unit, Response::Exact);
        let cancellation = Cancellation::default();
        match fault {
            "revoke" => runtime.revoke_plugin(&mut store, grant).unwrap(),
            "cancel" => cancellation.request(),
            "selection" => save(&mut store, unit, "较新的输入"),
            "cas" => {
                let prepared = prepare(&store, unit, ExecutionId::new());
                let input = execution_input(&prepared);
                let (_, result) = support::execute(&mut runtime, &mut store, &input);
                let second = capture_review(&store, prepared, &input, &result)
                    .unwrap()
                    .compute(&Cancellation::default())
                    .unwrap();
                store
                    .commit_review_evidence(second, &Cancellation::default())
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let db =
            rusqlite::Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
        let before: i64 = db
            .query_row("SELECT COUNT(*) FROM review_checks", [], |r| r.get(0))
            .unwrap();
        let error = store
            .commit_review_evidence(computed, &cancellation)
            .unwrap_err();
        assert_eq!(
            error.code,
            match fault {
                "revoke" => ErrorCode::Unauthorized,
                "cancel" => ErrorCode::Cancelled,
                _ => ErrorCode::DependencyConflict,
            }
        );
        let after: i64 = db
            .query_row("SELECT COUNT(*) FROM review_checks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
    }
}

#[test]
fn persisted_qa_cannot_replace_actual_domain_findings() {
    let (directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "译文");
    let (computed, _runtime, _grant) = compute_actual(&mut store, unit, Response::Exact);
    store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    let db = rusqlite::Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    db.execute("UPDATE review_checks SET evidence_json=json_set(evidence_json,'$.results[2].outcome',json('{\"kind\":\"failed\"}')), rules_json=json_set(rules_json,'$[2].status','failed','$[2].reason','Check failed')", []).unwrap();
    assert!(store.review_target(project(&store), unit, "zh-CN").is_err());
    store.close().unwrap();
    assert!(ProjectStore::open(&directory.path().join("project")).is_err());
}

#[test]
fn saved_checks_without_actual_evidence_are_refused_in_current_and_historical_reads() {
    for fixed_four in [false, true] {
        let (directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "译文");
        let (computed, _runtime, _grant) = compute_actual(&mut store, unit, Response::Exact);
        store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap();
        let db =
            rusqlite::Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
        db.execute(
            "UPDATE review_checks SET evidence_json=NULL,qa_basis=NULL",
            [],
        )
        .unwrap();
        if fixed_four {
            let rules: Vec<_> = [
                "required-translation",
                "placeholders",
                "format",
                "terminology",
            ]
            .into_iter()
            .map(|rule| tsumugi_core::CheckRuleResult {
                rule: rule.into(),
                key: sdk::CheckKey {
                    rule: sdk::ContractRef {
                        id: rule.into(),
                        schema_version: 1,
                        behavior_version: 1,
                    },
                    implementation: sdk::CheckImplementation::Core {
                        validator: sdk::ContractRef {
                            id: "tsumugi.core-review".into(),
                            schema_version: 1,
                            behavior_version: 1,
                        },
                    },
                },
                mandatory: true,
                status: "passed".into(),
                reason: None,
                findings: vec![],
            })
            .collect();
            db.execute(
                "UPDATE review_checks SET validator_version='smapi-prebuild-2',rules_json=?1",
                [serde_json::to_string(&rules).unwrap()],
            )
            .unwrap();
        }
        let project = project(&store);
        assert_eq!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap_err()
                .stage,
            "review-check-evidence"
        );
        assert_eq!(
            store
                .review_history(project, unit, "zh-CN", 0, 50)
                .unwrap_err()
                .stage,
            "review-check-evidence"
        );
        assert_eq!(
            store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap_err()
                .stage,
            "review-check-evidence"
        );
        store.close().unwrap();
        assert!(ProjectStore::open(&directory.path().join("project")).is_err());
    }
}

#[test]
fn adoption_policy_keeps_term_waivers_and_domain_names_out_of_core_fallback() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    store
        .save_term(&tsumugi_core::SaveTerm {
            project_id: project(&store),
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "same".into(),
            aliases: vec![],
            target: "指定".into(),
            protected: true,
            scope_unit_id: Some(unit),
            expected_revision_id: None,
            reason: "Synthetic term".into(),
        })
        .unwrap();
    save(&mut store, unit, "译文");
    approve(&mut store, unit);
    let (computed, _runtime, _grant) = compute_actual(&mut store, unit, Response::Exact);
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    let finding = &run
        .rules
        .iter()
        .find(|r| r.rule == "terminology")
        .unwrap()
        .findings[0];
    assert!(finding.waivable);
    let target = store.review_target(project(&store), unit, "zh-CN").unwrap();
    store
        .waive_review_issue(&tsumugi_core::WaiverWrite {
            project_id: project(&store),
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            issue_id: finding.issue_id.clone(),
            grant: true,
            expected_waiver_id: None,
            actor: "Synthetic reviewer".into(),
            reason: "Explicit synthetic exception".into(),
        })
        .unwrap();
    assert_eq!(
        store
            .review_target(project(&store), unit, "zh-CN")
            .unwrap()
            .current_waivers
            .len(),
        1
    );
    assert!(
        !store
            .review_eligibility(project(&store), &["zh-CN".into()])
            .unwrap()
            .locales[0]
            .blockers
            .iter()
            .any(|b| b.unit_id == unit)
    );

    let (_directory, mut store, rows) =
        support::source_fixture_with_review_rules(vec![sdk::ReviewRuleDeclaration {
            rule: sdk::ContractRef {
                id: "required-translation".into(),
                schema_version: 1,
                behavior_version: 1,
            },
            requires_translation: false,
        }]);
    let unit = rows[0].unit_id.unwrap();
    let target = store.review_target(project(&store), unit, "zh-CN").unwrap();
    store
        .allow_source_fallback(&tsumugi_core::FallbackWrite {
            project_id: project(&store),
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            expected_basis: target.basis,
            allow: true,
            expected_fallback_id: None,
            actor: "Synthetic reviewer".into(),
            reason: "Explicit source fallback".into(),
        })
        .unwrap();
    let (computed, _runtime, _grant) = compute_actual(&mut store, unit, Response::Finding);
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    assert!(
        run.rules
            .iter()
            .find(|r| r.rule == "plugin:required-translation")
            .unwrap()
            .findings
            .iter()
            .all(|f| !f.waivable)
    );
    let eligibility = store
        .review_eligibility(project(&store), &["zh-CN".into()])
        .unwrap();
    assert!(
        eligibility.locales[0]
            .blockers
            .iter()
            .any(|b| b.unit_id == unit && b.code == "qa-issue")
    );
}

#[test]
fn adoption_policy_refresh_expires_qa_but_preserves_unchanged_manual_approval_and_history() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "译文");
    approve(&mut store, unit);
    let (computed, _review_runtime, _grant) = compute_actual(&mut store, unit, Response::Exact);
    let run = store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap();
    let before = store.review_target(project(&store), unit, "zh-CN").unwrap();
    let automatic = automatic::candidate_request(
        &mut store,
        unit,
        "候选",
        tsumugi_core::application::SelectionPolicy::ReplaceCapturedSelection,
    );
    let original_plan = store.work_plan(automatic.lease.plan_id).unwrap();
    assert_eq!(
        store.work_plan_review_binding(&original_plan).unwrap(),
        store
            .source_review_binding(before.source_snapshot_id)
            .unwrap()
    );
    let mut runtime = support::source_runtime(&store);
    let mut envelope = support::source_input(&store).envelope().clone();
    envelope.settings["review"]["declaration"]["rules"] =
        serde_json::to_value(vec![sdk::ReviewRuleDeclaration {
            rule: sdk::ContractRef {
                id: "new-domain-rule".into(),
                schema_version: 1,
                behavior_version: 2,
            },
            requires_translation: false,
        }])
        .unwrap();
    let input = FixedInput::capture(envelope).unwrap();
    let (_, result) = support::execute(&mut runtime, &mut store, &input);
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let (_, checked) = support::execute(&mut runtime, &mut store, capture.check_input());
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
    store
        .adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler)
        .unwrap();
    let after = store.review_target(project(&store), unit, "zh-CN").unwrap();
    assert_eq!(
        store.verify_work_plan(&original_plan).unwrap_err().stage,
        "work-plan-checker"
    );
    assert_eq!(
        store
            .prepare_automatic_selection(&automatic)
            .unwrap_err()
            .stage,
        "work-plan-checker"
    );
    assert_eq!(after.basis, before.basis);
    assert_eq!(after.current_decision, before.current_decision);
    assert!(after.current_check.is_none());
    let history = store
        .review_history(project(&store), unit, "zh-CN", 0, 25)
        .unwrap();
    assert!(history.checks.contains(&run));
    assert!(
        store
            .review_eligibility(project(&store), &["zh-CN".into()])
            .unwrap()
            .locales[0]
            .blockers
            .iter()
            .any(|b| b.unit_id == unit && b.code == "qa-missing-or-stale")
    );
    let scope = store.content_scope().unwrap();
    let mut repeated = support::source_input(&store).envelope().clone();
    repeated.settings["review"] = input.envelope().settings["review"].clone();
    let repeated = FixedInput::capture(repeated).unwrap();
    let (_, result) = support::execute(&mut runtime, &mut store, &repeated);
    let captured = store
        .capture_source_validation(repeated.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let (_, checked) = support::execute(&mut runtime, &mut store, captured.check_input());
    store
        .commit_source_validation(captured.prepare(checked).unwrap())
        .unwrap();
    let preview = store
        .source_preview(
            repeated.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            repeated.envelope().attempt_id,
            repeated.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler)
            .unwrap_err()
            .stage,
        "source-unchanged"
    );
    assert_eq!(store.content_scope().unwrap(), scope);
}

#[path = "support/automatic.rs"]
mod automatic;

fn automatic_computed(
    store: &mut ProjectStore,
    request: &tsumugi_core::application::AutomaticSelectionRequest,
    response: Response,
) -> (
    ExecutionRuntime,
    ExecutionId,
    tsumugi_core::ComputedAutomaticSelection,
) {
    let prepared = store.prepare_automatic_selection(request).unwrap();
    let check = prepared.review_check().unwrap();
    let mut runtime = runtime(store, check, response);
    let input = execution_input(check);
    let (_, result) = support::execute(&mut runtime, store, &input);
    let grant = result.envelope().plugin.as_ref().unwrap().authorization_id;
    let origin = ReviewCheckOrigin {
        checker: checker_key(check, &input),
        attempt_id: input.envelope().attempt_id,
        result_id: result.envelope().result_id,
    };
    let computed = store
        .capture_automatic_selection_execution(prepared, &[origin])
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    (runtime, grant, computed)
}

#[test]
fn automatic_candidate_uses_actual_union_and_atomically_selects_current_qa_without_human_approval()
{
    let (directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let request = automatic::candidate_request(
        &mut store,
        unit,
        "候选",
        tsumugi_core::application::SelectionPolicy::MissingOnly,
    );
    let prepared = store.prepare_automatic_selection(&request).unwrap();
    assert_eq!(
        prepared
            .compute(&Cancellation::default())
            .unwrap_err()
            .stage,
        "review-plugin-evidence-required"
    );
    let (runtime, grant, computed) = automatic_computed(&mut store, &request, Response::Exact);
    let receipt = store
        .commit_automatic_selection(computed, &Cancellation::default())
        .unwrap();
    assert!(receipt.blocked.is_none());
    let target = store
        .review_target(request.project_id, unit, "zh-CN")
        .unwrap();
    assert_eq!(target.revision_id, Some(request.revision_id));
    assert_eq!(
        target.selection_id,
        Some(receipt.selection.as_ref().unwrap().event_id)
    );
    assert_eq!(target.basis_evidence, receipt.candidate_basis);
    let check = target.current_check.unwrap();
    assert_eq!(Some(check.run_id), receipt.check_run_id);
    assert_eq!(check.evidence, receipt.evidence);
    assert!(target.current_decision.is_none());
    assert!(
        store
            .review_eligibility(request.project_id, &["zh-CN".into()])
            .unwrap()
            .locales[0]
            .blockers
            .iter()
            .any(|b| b.unit_id == unit && b.code == "approval-missing-or-stale")
    );
    runtime.revoke_plugin(&mut store, grant).unwrap();
    let cancel = Cancellation::default();
    cancel.request();
    let replay = store
        .prepare_automatic_selection(&request)
        .unwrap()
        .compute(&cancel)
        .unwrap();
    assert_eq!(
        store.commit_automatic_selection(replay, &cancel).unwrap(),
        receipt
    );
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(&directory.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .automatic_selection_receipt(request.action_id)
            .unwrap(),
        Some(receipt)
    );
    assert!(
        reopened
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap()
            .current_check
            .is_some()
    );
}

#[test]
fn automatic_empty_missing_or_domain_findings_keep_candidate_without_selection_or_current_qa() {
    for response in [Response::Empty, Response::Missing, Response::Finding] {
        let (directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        let request = automatic::candidate_request(
            &mut store,
            unit,
            "候选",
            tsumugi_core::application::SelectionPolicy::MissingOnly,
        );
        let (runtime, _, computed) = automatic_computed(&mut store, &request, response);
        let receipt = store
            .commit_automatic_selection(computed, &Cancellation::default())
            .unwrap();
        assert_eq!(
            receipt.blocked,
            Some(tsumugi_core::application::AutomaticSelectionBlock::Checks)
        );
        assert!(
            receipt.evidence.is_some()
                && receipt.selection.is_none()
                && receipt.check_run_id.is_none()
        );
        let target = store
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap();
        assert!(target.selection_id.is_none() && target.current_check.is_none());
        assert!(
            store
                .translation_history(request.project_id, unit, "zh-CN", 0, 25)
                .unwrap()
                .rows
                .iter()
                .any(|r| r.revision_id == request.revision_id)
        );
        drop(runtime);
        store.close().unwrap();
        let reopened = ProjectStore::open(&directory.path().join("project")).unwrap();
        assert_eq!(
            reopened
                .automatic_selection_receipt(request.action_id)
                .unwrap(),
            Some(receipt)
        );
    }
}

#[test]
fn automatic_grant_revocation_cancellation_and_manual_change_reject_without_partial_actions() {
    for change in 0..5 {
        let (_directory, mut store, rows) = support::source_fixture();
        let unit = rows[0].unit_id.unwrap();
        let request = automatic::candidate_request(
            &mut store,
            unit,
            "候选",
            tsumugi_core::application::SelectionPolicy::MissingOnly,
        );
        let (runtime, grant, computed) = automatic_computed(&mut store, &request, Response::Exact);
        let cancellation = Cancellation::default();
        match change {
            0 => runtime.revoke_plugin(&mut store, grant).unwrap(),
            1 => cancellation.request(),
            2 => save(&mut store, unit, "较新人工输入"),
            3 => {
                store
                    .control_work_plan(&tsumugi_core::application::ControlWorkPlan {
                        action_id: ExecutionId::new(),
                        plan_id: request.lease.plan_id,
                        expected_generation: request.lease.generation,
                        command: tsumugi_core::application::WorkPlanCommand::Stop,
                        confirmed: false,
                        expires_at: None,
                    })
                    .unwrap();
            }
            _ => {
                let target = store
                    .review_target(request.project_id, unit, "zh-CN")
                    .unwrap();
                store
                    .save_term(&tsumugi_core::SaveTerm {
                        project_id: request.project_id,
                        action_id: ExecutionId::new(),
                        term_id: None,
                        locale: "zh-CN".into(),
                        source: target.source_text,
                        aliases: vec![],
                        target: "指定".into(),
                        protected: true,
                        scope_unit_id: Some(unit),
                        expected_revision_id: None,
                        reason: "Synthetic concurrent term".into(),
                    })
                    .unwrap();
            }
        }
        let before = store
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap();
        assert!(
            store
                .commit_automatic_selection(computed, &cancellation)
                .is_err()
        );
        assert!(
            store
                .automatic_selection_receipt(request.action_id)
                .unwrap()
                .is_none()
        );
        let after = store
            .review_target(request.project_id, unit, "zh-CN")
            .unwrap();
        assert_eq!(after.selection_id, before.selection_id);
        assert_eq!(after.translation_text, before.translation_text);
        assert_eq!(after.current_check, before.current_check);
    }
}

#[test]
fn automatic_qa_insert_failure_rolls_back_the_selection_in_the_same_transaction() {
    let (directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    let request = automatic::candidate_request(
        &mut store,
        unit,
        "候选",
        tsumugi_core::application::SelectionPolicy::MissingOnly,
    );
    let (_runtime, _, computed) = automatic_computed(&mut store, &request, Response::Exact);
    let connection =
        rusqlite::Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER synthetic_qa_failure BEFORE INSERT ON review_checks BEGIN SELECT RAISE(ABORT,'synthetic-qa-failure'); END;").unwrap();
    assert!(
        store
            .commit_automatic_selection(computed, &Cancellation::default())
            .is_err()
    );
    let target = store
        .review_target(request.project_id, unit, "zh-CN")
        .unwrap();
    assert!(target.selection_id.is_none() && target.current_check.is_none());
    assert!(
        store
            .automatic_selection_receipt(request.action_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM translation_selections", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn cloned_preflight_retains_the_original_check_cas_across_replay() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "译文");
    let prepared = prepare(&store, unit, ExecutionId::new());
    let input = execution_input(&prepared);
    let mut runtime = runtime(&store, &prepared, Response::Exact);
    let (_, result) = support::execute(&mut runtime, &mut store, &input);
    let newer = prepare(&store, unit, ExecutionId::new());
    let newer_input = execution_input(&newer);
    let (_, newer_result) = support::execute(&mut runtime, &mut store, &newer_input);
    let newer = capture_review(&store, newer, &newer_input, &newer_result)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    let receipt = store
        .commit_review_evidence(newer, &Cancellation::default())
        .unwrap();
    let replay = prepared.clone();
    replay.validate_execution_input(&input).unwrap();
    let computed = capture_review(&store, replay, &input, &result)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    assert_eq!(
        store
            .commit_review_evidence(computed, &Cancellation::default())
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(
        store
            .review_target(project(&store), unit, "zh-CN")
            .unwrap()
            .current_check
            .unwrap(),
        receipt
    );
}
