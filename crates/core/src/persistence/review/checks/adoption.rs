//! Durable QA uses the captured policy union and the original ledger channel.
//! Receiving an IPC projection does not authorize creating this evidence.
use super::*;
use crate::execution::{FixedInput, FixedResult};
use tsumugi_plugin_sdk as sdk;

pub(super) const CHECK_VERSION: &str = "tsumugi.core-review:1:1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckEvidence {
    pub qa_basis: String,
    pub required_checks: sdk::RequiredCheckSet,
    pub results: Vec<sdk::CheckResult>,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub result_id: ExecutionId,
    pub result_digest: String,
}

fn corrupt() -> ExecutionError {
    failure(ErrorCode::CorruptLedger, "review-check-evidence")
}
fn fixed(set: &sdk::RequiredCheckSet) -> Result<sdk::FixedCheckSet, ExecutionError> {
    let (core, domain) = set
        .requirements
        .iter()
        .cloned()
        .partition(|r| matches!(r.key.implementation, sdk::CheckImplementation::Core { .. }));
    let fixed =
        sdk::capture_required_checks(set.policy.clone(), core, domain).map_err(|_| corrupt())?;
    let core: Vec<_> = fixed
        .set()
        .requirements
        .iter()
        .filter(|r| matches!(r.key.implementation, sdk::CheckImplementation::Core { .. }))
        .collect();
    if core.len() != 2 || core.iter().any(|r| {
        r.key.rule.schema_version != 1 || r.key.rule.behavior_version != 1
        || !matches!(&r.key.implementation, sdk::CheckImplementation::Core { validator }
            if validator.id == "tsumugi.core-review" && validator.schema_version == 1 && validator.behavior_version == 1)
        || !matches!(r.key.rule.id.as_str(), "required-translation" | "terminology")
        || r.waivable != (r.key.rule.id == "terminology")
    }) {
        return Err(corrupt());
    }
    Ok(fixed)
}

pub(in crate::persistence::review) fn coverage_complete(run: &CheckRun) -> bool {
    // Read owners validate the projection first. A malformed direct assessment
    // is also closed to qualification rather than treating it as empty success.
    run.evidence.as_ref().is_some_and(|e| {
        fixed(&e.required_checks)
            .and_then(|s| s.evaluate(&e.results).map_err(|_| corrupt()))
            .is_ok_and(|coverage| coverage.complete)
    })
}

fn project_rules(
    evidence: &ReviewCheckEvidence,
    core_rules: &[CheckRuleResult],
) -> Result<Vec<CheckRuleResult>, ExecutionError> {
    let fixed = fixed(&evidence.required_checks)?;
    fixed.evaluate(&evidence.results).map_err(|_| corrupt())?;
    let mut rules = Vec::new();
    for requirement in &evidence.required_checks.requirements {
        let result = evidence.results.iter().find(|r| r.key == requirement.key);
        let (status, reason, findings) = match result.map(|r| &r.outcome) {
            Some(sdk::CheckOutcome::Completed { findings }) => (
                if findings.is_empty() {
                    "passed"
                } else {
                    "findings"
                },
                None,
                findings.as_slice(),
            ),
            Some(sdk::CheckOutcome::NotApplicable { .. }) => ("not-applicable", None, &[][..]),
            Some(sdk::CheckOutcome::Failed) => ("failed", Some("Check failed"), &[][..]),
            Some(sdk::CheckOutcome::Cancelled) => ("cancelled", Some("Check cancelled"), &[][..]),
            Some(sdk::CheckOutcome::Unavailable) => {
                ("unavailable", Some("Check unavailable"), &[][..])
            }
            None => ("missing", Some("Required check result missing"), &[][..]),
        };
        if matches!(
            requirement.key.implementation,
            sdk::CheckImplementation::Core { .. }
        ) {
            let rule = core_rules
                .iter()
                .find(|r| r.rule == requirement.key.rule.id)
                .ok_or_else(corrupt)?;
            if rule.status != status
                || rule.findings.len() != findings.len()
                || rule.findings.iter().zip(findings).any(|(rich, original)| {
                    let code = if rich.rule == "terminology" {
                        format!("{}.{}", rich.code, rich.issue_id)
                    } else {
                        rich.code.clone()
                    };
                    code != original.code
                        || rich.rule != rule.rule
                        || rich.severity
                            != match original.severity {
                                sdk::FindingSeverity::Error => "error",
                                sdk::FindingSeverity::Warning => "warning",
                            }
                        || (rich.waivable && !requirement.waivable)
                })
            {
                return Err(corrupt());
            }
            rules.push(rule.clone());
        } else {
            // Domain names never impersonate Core fallback or waiver policies.
            let rule = format!("plugin:{}", requirement.key.rule.id);
            rules.push(CheckRuleResult {
                rule: rule.clone(),
                status: status.into(),
                reason: reason.map(str::to_owned),
                findings: findings
                    .iter()
                    .map(|finding| {
                        Ok(CheckFinding {
                            issue_id: digest(&(
                                "domain-review-issue-1",
                                &requirement.key,
                                &requirement.input_digest,
                                &requirement.scope_digest,
                                finding,
                            ))?,
                            rule: rule.clone(),
                            code: finding.code.clone(),
                            detail: finding.code.clone(),
                            severity: match finding.severity {
                                sdk::FindingSeverity::Error => "error",
                                sdk::FindingSeverity::Warning => "warning",
                            }
                            .into(),
                            waivable: false,
                        })
                    })
                    .collect::<Result<_, ExecutionError>>()?,
            });
        }
    }
    if core_rules.len() != 2 {
        return Err(corrupt());
    }
    Ok(rules)
}

pub(in crate::persistence::review) fn validate_projection(
    run: &CheckRun,
) -> Result<(), ExecutionError> {
    let Some(evidence) = &run.evidence else {
        return Ok(());
    };
    let core: Vec<_> = run
        .rules
        .iter()
        .filter(|r| matches!(r.rule.as_str(), "required-translation" | "terminology"))
        .cloned()
        .collect();
    if run.validator_version != CHECK_VERSION
        || evidence.qa_basis.len() != 64
        || project_rules(evidence, &core)? != run.rules
    {
        return Err(corrupt());
    }
    Ok(())
}

pub(in crate::persistence::review) fn validate_saved(
    connection: &Connection,
    project: ExecutionId,
    run: &CheckRun,
    request_digest: &str,
) -> Result<(), ExecutionError> {
    validate_projection(run)?;
    let Some(evidence) = &run.evidence else {
        return Ok(());
    };
    // Historical evidence retains its original authority; reading it never
    // requires a still-live grant or restores permission to execute again.
    let input = super::super::super::ledger::load_input(connection, evidence.attempt_id)?;
    let result = super::super::super::ledger::load_result(connection, &input, evidence.result_id)?;
    validate_saved_frames(project, run, request_digest, &input, &result)
}

pub(in crate::persistence::review) fn validate_saved_frames(
    project: ExecutionId,
    run: &CheckRun,
    request_digest: &str,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    validate_projection(run)?;
    let evidence = run.evidence.as_ref().ok_or_else(corrupt)?;
    let envelope = input.envelope();
    let item = envelope.items.first().ok_or_else(corrupt)?;
    let origin = result.envelope().plugin.as_ref().ok_or_else(corrupt)?;
    if input.digest() != evidence.input_digest
        || result.digest() != evidence.result_digest
        || envelope.project_id != project
        || envelope.task_id != run.action_id
        || envelope.operation != crate::execution::REVIEW_CHECK_OPERATION
        || envelope.items.len() != 1
        || item.scope.id != run.unit_id.to_string()
        || item.scope.locale.as_deref() != Some(run.locale.as_str())
        || envelope.settings["requestDigest"] != request_digest
        || envelope.settings["reviewBasis"] != run.basis
        || envelope.settings["qaBasis"] != evidence.qa_basis
        || envelope.settings["requiredChecks"]
            != serde_json::to_value(&evidence.required_checks).map_err(|_| corrupt())?
    {
        return Err(corrupt());
    }
    let sdk::InvocationOutcome::Succeeded { output } = &origin.result.outcome else {
        return Err(corrupt());
    };
    if output.schema != sdk::check_results_contract() {
        return Err(corrupt());
    }
    let original = sdk::parse_check_results(output.utf8.as_bytes()).map_err(|_| corrupt())?;
    let saved: Vec<_> = evidence
        .results
        .iter()
        .filter(|r| {
            matches!(
                r.key.implementation,
                sdk::CheckImplementation::Plugin { .. }
            )
        })
        .cloned()
        .collect();
    if original != saved
        || saved.iter().any(|r| {
            !matches!(&r.key.implementation, sdk::CheckImplementation::Plugin { provider }
            if *provider == origin.channel.selection())
        })
    {
        return Err(corrupt());
    }
    Ok(())
}

impl ProjectStore {
    /// Adopts only owned actual computation, with current dependencies and
    /// authority rechecked atomically. Missing coverage remains a blocking run.
    pub fn commit_review_evidence(
        &mut self,
        computed: ComputedReviewEvidence,
        cancellation: &Cancellation,
    ) -> Result<CheckRun, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        let ComputedReviewEvidence {
            project_id: project,
            action_id: action,
            request_digest: request,
            plan,
            input,
            result,
            core_rules: core,
            results,
            expected_check_id: expected_check,
            ..
        } = computed;
        let evidence = ReviewCheckEvidence {
            qa_basis: plan.basis().into(),
            required_checks: plan.fixed_checks().set().clone(),
            results,
            attempt_id: input.envelope().attempt_id,
            input_digest: input.digest().into(),
            result_id: result.envelope().result_id,
            result_digest: result.digest().into(),
        };
        let rules = project_rules(&evidence, &core)?;
        let evidence_json = codec::encode(&evidence, crate::execution::MAX_RESULT_BYTES)?;
        let evidence_json = String::from_utf8(evidence_json).map_err(|_| corrupt())?;
        let rules_json = serde_json::to_string(&rules).map_err(|_| corrupt())?;
        if rules_json.len() > crate::execution::MAX_RESULT_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "review-check-encode"));
        }
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let authority = self.plugin_authority.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let observer = change_clock.observe(&transaction, super::super::super::ChangeScope::Review);
        if let Some((run, digest)) = check_by_action(&transaction, project, action)? {
            return if digest == request {
                Ok(run)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-check-action"))
            };
        }
        if cancellation.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "review-check-adoption"));
        }
        super::super::super::ledger::recheck_current_plugin_result_in(
            &transaction,
            &authority,
            &input,
            &result,
        )?;
        let target = target_in(
            &transaction,
            project,
            plan.unit_id(),
            &plan.domain_input().target_language,
        )?;
        let terms =
            resources::resolve_terms_in(&transaction, project, target.unit_id, &target.locale)?;
        let current =
            capture::capture_in(&transaction, project, &target, &terms)?.ok_or_else(corrupt)?;
        if current.basis() != plan.basis() {
            return Err(failure(ErrorCode::DependencyConflict, "review-qa-current"));
        }
        let current_check = target.current_check.as_ref().map(|r| r.run_id);
        if current_check != expected_check {
            return Err(
                failure(ErrorCode::DependencyConflict, "review-check-current").with_conflict(
                    ConflictEvidence::ReviewCheck {
                        expected: expected_check,
                        current: current_check,
                    },
                ),
            );
        }
        let basis_json = serde_json::to_string(&target.basis_evidence).map_err(|_| corrupt())?;
        if cancellation.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "review-check-adoption"));
        }
        transaction.execute(
            "INSERT INTO review_checks (run_id,action_id,project_id,unit_id,locale,basis,basis_json,
             validator_version,rules_json,qa_basis,evidence_json,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![ExecutionId::new().to_string(),action.to_string(),project.to_string(),
                target.unit_id.to_string(),target.locale,target.basis,basis_json,CHECK_VERSION,
                rules_json,evidence.qa_basis,evidence_json,request],
        ).map_err(sql)?;
        observer.commit(transaction).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-check-commit")
        })?;
        check_by_action(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?,
            project,
            action,
        )?
        .map(|r| r.0)
        .ok_or_else(corrupt)
    }
}
