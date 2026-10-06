//! Durable QA uses the captured policy union and the original ledger channel.
//! Receiving an IPC projection does not authorize creating this evidence.
use super::*;
use crate::execution::{FixedInput, FixedResult};
use tsumugi_plugin_sdk as sdk;

pub(in crate::persistence) const CHECK_VERSION: &str = "tsumugi.core-review:1:1";

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
pub(in crate::persistence) fn validator_version(
    evidence: Option<&ReviewCheckEvidence>,
) -> Result<&'static str, ExecutionError> {
    if evidence.is_some() {
        return Ok(CHECK_VERSION);
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    {
        Ok(crate::review::CHECK_VERSION)
    }
    #[cfg(not(any(test, feature = "execution-test-host")))]
    {
        Err(corrupt())
    }
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
    let Some(e) = &run.evidence else {
        #[cfg(any(test, feature = "execution-test-host"))]
        {
            return crate::review::complete_rules(&run.rules);
        }
        #[cfg(not(any(test, feature = "execution-test-host")))]
        {
            return false;
        }
    };
    fixed(&e.required_checks)
        .and_then(|s| s.evaluate(&e.results).map_err(|_| corrupt()))
        .is_ok_and(|coverage| coverage.complete)
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

pub(in crate::persistence) fn candidate_checks_clean(
    rules: &[CheckRuleResult],
    evidence: &ReviewCheckEvidence,
) -> bool {
    fixed(&evidence.required_checks)
        .and_then(|fixed| fixed.evaluate(&evidence.results).map_err(|_| corrupt()))
        .is_ok_and(|coverage| coverage.complete)
        && rules.iter().all(|rule| {
            matches!(rule.status.as_str(), "passed" | "not-applicable") && rule.findings.is_empty()
        })
}

pub(in crate::persistence::review) fn validate_projection(
    run: &CheckRun,
) -> Result<(), ExecutionError> {
    let Some(evidence) = &run.evidence else {
        return validator_version(None).map(|_| ());
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

/// Encoding and projection are prepared before either ordinary or automatic
/// selection enters its write transaction. Only owned computation supplies it.
#[derive(Debug)]
pub(in crate::persistence) struct PreparedReviewAdoption {
    computed: ComputedReviewEvidence,
    evidence: ReviewCheckEvidence,
    rules: Vec<CheckRuleResult>,
    evidence_json: String,
    rules_json: String,
}
impl PreparedReviewAdoption {
    pub(in crate::persistence) fn new(
        computed: ComputedReviewEvidence,
    ) -> Result<Self, ExecutionError> {
        let evidence = ReviewCheckEvidence {
            qa_basis: computed.plan.basis().into(),
            required_checks: computed.plan.fixed_checks().set().clone(),
            results: computed.results.clone(),
            attempt_id: computed.input.envelope().attempt_id,
            input_digest: computed.input.digest().into(),
            result_id: computed.result.envelope().result_id,
            result_digest: computed.result.digest().into(),
        };
        let rules = project_rules(&evidence, &computed.core_rules)?;
        let evidence_json = String::from_utf8(codec::encode(
            &evidence,
            crate::execution::MAX_RESULT_BYTES,
        )?)
        .map_err(|_| corrupt())?;
        let rules_json = serde_json::to_string(&rules).map_err(|_| corrupt())?;
        if rules_json.len() > crate::execution::MAX_RESULT_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "review-check-encode"));
        }
        Ok(Self {
            computed,
            evidence,
            rules,
            evidence_json,
            rules_json,
        })
    }
    pub(in crate::persistence) fn rules(&self) -> &[CheckRuleResult] {
        &self.rules
    }
    pub(in crate::persistence) fn evidence(&self) -> &ReviewCheckEvidence {
        &self.evidence
    }
    pub(in crate::persistence) fn candidate_basis(&self) -> &ReviewBasis {
        &self.computed.plan.target.basis_evidence
    }
    pub(in crate::persistence) fn recheck_authority_in(
        &self,
        connection: &Connection,
        authority: &crate::execution::plugin_authority::PluginAuthority,
        cancellation: &Cancellation,
    ) -> Result<(), ExecutionError> {
        if cancellation.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "review-check-adoption"));
        }
        super::super::super::ledger::recheck_current_plugin_result_in(
            connection,
            authority,
            &self.computed.input,
            &self.computed.result,
        )
    }
    pub(in crate::persistence) fn save_in(
        &self,
        connection: &Connection,
        authority: &crate::execution::plugin_authority::PluginAuthority,
        cancellation: &Cancellation,
    ) -> Result<CheckRun, ExecutionError> {
        let computed = &self.computed;
        if let Some((run, request)) =
            check_by_action(connection, computed.project_id, computed.action_id)?
        {
            return if request == computed.request_digest {
                Ok(run)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-check-action"))
            };
        }
        self.recheck_authority_in(connection, authority, cancellation)?;
        let target = target_in(
            connection,
            computed.project_id,
            computed.plan.unit_id(),
            &computed.plan.domain_input().target_language,
        )?;
        let terms = resources::resolve_terms_in(
            connection,
            computed.project_id,
            target.unit_id,
            &target.locale,
        )?;
        let current = capture::capture_in(connection, computed.project_id, &target, &terms)?
            .ok_or_else(corrupt)?;
        if current.basis() != computed.plan.basis() {
            return Err(failure(ErrorCode::DependencyConflict, "review-qa-current"));
        }
        let current_check = target.current_check.as_ref().map(|r| r.run_id);
        if current_check != computed.expected_check_id {
            return Err(
                failure(ErrorCode::DependencyConflict, "review-check-current").with_conflict(
                    ConflictEvidence::ReviewCheck {
                        expected: computed.expected_check_id,
                        current: current_check,
                    },
                ),
            );
        }
        let basis_json = serde_json::to_string(&target.basis_evidence).map_err(|_| corrupt())?;
        if cancellation.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "review-check-adoption"));
        }
        connection.execute(
            "INSERT INTO review_checks (run_id,action_id,project_id,unit_id,locale,basis,basis_json,
             validator_version,rules_json,qa_basis,evidence_json,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![ExecutionId::new().to_string(),computed.action_id.to_string(),computed.project_id.to_string(),
                target.unit_id.to_string(),target.locale,target.basis,basis_json,CHECK_VERSION,
                self.rules_json,self.evidence.qa_basis,self.evidence_json,computed.request_digest],
        ).map_err(sql)?;
        check_by_action(connection, computed.project_id, computed.action_id)?
            .map(|r| r.0)
            .ok_or_else(corrupt)
    }
}

/// A blocked automatic selection keeps its actual candidate QA without claiming
/// a selected revision or a current CheckRun. Historical reads verify the ledger.
pub(in crate::persistence) fn validate_candidate_evidence(
    connection: &Connection,
    project: ExecutionId,
    action: ExecutionId,
    unit: ExecutionId,
    locale: &str,
    basis_evidence: &ReviewBasis,
    rules: &[CheckRuleResult],
    evidence: &ReviewCheckEvidence,
) -> Result<(), ExecutionError> {
    let basis = basis_digest(basis_evidence)?;
    let request = digest(&(project, unit, locale, basis.as_str(), action))?;
    let run = CheckRun {
        run_id: action,
        action_id: action,
        unit_id: unit,
        locale: locale.into(),
        basis,
        basis_evidence: basis_evidence.clone(),
        validator_version: CHECK_VERSION.into(),
        outcome: check_outcome(rules),
        rules: rules.to_vec(),
        evidence: Some(evidence.clone()),
        created_at: String::new(),
    };
    validate_saved(connection, project, &run, &request)
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
        let prepared = PreparedReviewAdoption::new(computed)?;
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let authority = self.plugin_authority.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let observer = change_clock.observe(&transaction, super::super::super::ChangeScope::Review);
        let run = prepared.save_in(&transaction, &authority, cancellation)?;
        observer.commit(transaction).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-check-commit")
        })?;
        Ok(run)
    }
}
