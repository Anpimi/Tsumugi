#![cfg(not(feature = "execution-test-host"))]
//! Actual Core grants/runtime/SQLite with an in-process synthetic checker.
//! Installed Node workers are covered separately by plugin-host conformance.
mod support;
use std::sync::Arc;
use tsumugi_core::{
    ComputedReviewEvidence, PreparedReviewCheck, ProjectStore, ReviewDecisionKind, ReviewWrite,
    SaveTranslationRevision, execution::*,
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
    fn plugin_environment(&self) -> Option<&sdk::RuntimeEnvironmentDescriptor> {
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
        .prepare_review_check(project, unit, "zh-CN", &target.basis, action)
        .unwrap()
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
    let input = prepared.domain_execution_input(ExecutionId::new()).unwrap();
    assert_eq!(input.envelope().task_id, action);
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
    let captured = store
        .capture_review_check_execution(
            prepared,
            input.envelope().attempt_id,
            result.envelope().result_id,
        )
        .unwrap();
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
    assert_eq!(computed.domain_input().digest(), input.digest());
    assert_eq!(computed.domain_result().digest(), result.digest());
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
        let input = prepared.domain_execution_input(ExecutionId::new()).unwrap();
        let (_, result) = support::execute(&mut runtime, &mut store, &input);
        let computed = store
            .capture_review_check_execution(
                prepared,
                input.envelope().attempt_id,
                result.envelope().result_id,
            )
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
        let input = prepared.domain_execution_input(ExecutionId::new()).unwrap();
        let (_, result) = support::execute(&mut runtime, &mut store, &input);
        let captured = store
            .capture_review_check_execution(
                prepared,
                input.envelope().attempt_id,
                result.envelope().result_id,
            )
            .unwrap();
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
        let mut envelope = prepared
            .domain_execution_input(ExecutionId::new())
            .unwrap()
            .envelope()
            .clone();
        if substitute {
            envelope.items[0].payload["selections"][0]["translationText"] =
                serde_json::json!("替换");
        } else {
            envelope.task_id = ExecutionId::new();
        }
        let input = FixedInput::capture(envelope).unwrap();
        let (_, result) = support::execute(&mut runtime, &mut store, &input);
        assert_eq!(
            store
                .capture_review_check_execution(
                    prepared,
                    input.envelope().attempt_id,
                    result.envelope().result_id
                )
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
    let input = prepared.domain_execution_input(ExecutionId::new()).unwrap();
    let (grant, result) = support::execute(&mut runtime, &mut store, &input);
    let captured = store
        .capture_review_check_execution(
            prepared,
            input.envelope().attempt_id,
            result.envelope().result_id,
        )
        .unwrap();
    runtime.revoke_plugin(&mut store, grant).unwrap();
    assert_eq!(
        store
            .capture_review_check_execution(
                prepare(&store, unit, action),
                input.envelope().attempt_id,
                result.envelope().result_id
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    let cancellation = Cancellation::default();
    cancellation.request();
    let computed = captured.compute(&cancellation).unwrap();
    assert!(!computed.coverage().complete);
    assert_eq!(computed.domain_result().digest(), result.digest());
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
    let input = prepared.domain_execution_input(ExecutionId::new()).unwrap();
    let (grant, result) = support::execute(&mut runtime, store, &input);
    let computed = store
        .capture_review_check_execution(
            prepared,
            input.envelope().attempt_id,
            result.envelope().result_id,
        )
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
    let mut reopened = ProjectStore::open(&directory.path().join("project")).unwrap();
    let target = reopened
        .review_target(project(&reopened), unit, "zh-CN")
        .unwrap();
    assert_eq!(target.current_check, Some(run.clone()));
    assert!(target.current_decision.is_some());
    let cancelled = Cancellation::default();
    cancelled.request();
    let prepared = prepare(&reopened, unit, action);
    assert!(prepared.plan().is_none());
    assert_eq!(
        reopened
            .commit_review_check(prepared.compute(&cancelled), &cancelled)
            .unwrap(),
        run
    );
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
                let input = prepared.domain_execution_input(ExecutionId::new()).unwrap();
                let (_, result) = support::execute(&mut runtime, &mut store, &input);
                let second = store
                    .capture_review_check_execution(
                        prepared,
                        input.envelope().attempt_id,
                        result.envelope().result_id,
                    )
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
fn persisted_qa_cannot_replace_actual_domain_findings_and_old_production_checks_cannot_record() {
    let (directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "译文");
    let prepared = prepare(&store, unit, ExecutionId::new());
    assert_eq!(
        store
            .commit_review_check(
                prepared.compute(&Cancellation::default()),
                &Cancellation::default()
            )
            .unwrap_err()
            .stage,
        "review-plugin-evidence-required"
    );
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
