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
    pub source_binding: crate::content::SourceReviewBinding,
    pub advisory_checks: Vec<AdvisoryReviewCheck>,
    pub origins: Vec<ReviewCheckOriginEvidence>,
    pub diagnostics: Vec<sdk::TextReviewDiagnostic>,
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
    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    {
        Ok(crate::review::CHECK_VERSION)
    }
    #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
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
        !r.mandatory ||
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
        #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
        {
            return crate::review::complete_rules(&run.rules);
        }
        #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
        {
            return false;
        }
    };
    fixed(&e.required_checks)
        .and_then(|s| s.evaluate(&e.results).map_err(|_| corrupt()))
        .is_ok_and(|coverage| coverage.complete)
}

fn finding_issue_id(
    requirement: &sdk::CheckRequirement,
    finding: &sdk::CheckFinding,
    diagnostics: &[sdk::TextReviewDiagnostic],
) -> Result<String, ExecutionError> {
    if requirement.mandatory {
        // Mechanical identities and their existing waiver basis are unchanged.
        return digest(&(
            "domain-review-issue-1",
            &requirement.key,
            &requirement.input_digest,
            &requirement.scope_digest,
            finding,
        ));
    }
    // Diagnostic presentation is optional in the actual report. Its explicit
    // absence is distinct from later evidence containing a suggestion/range.
    // Match the full contributing key and exact target, not merely its code.
    let mut diagnostic_bytes = diagnostics
        .iter()
        .filter(|d| {
            d.key == requirement.key
                && d.code == finding.code
                && d.target == finding.target
                && requirement.targets.contains(&d.target)
        })
        .map(|d| codec::encode(d, MAX_INPUT_BYTES))
        .collect::<Result<Vec<_>, _>>()?;
    diagnostic_bytes.sort();
    digest(&(
        "advisory-review-issue-2",
        &requirement.key,
        &requirement.input_digest,
        &requirement.scope_digest,
        finding,
        diagnostic_bytes,
    ))
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
            None => {
                let origin = evidence.origins.iter().find(|o| matches!(&requirement.key.implementation, sdk::CheckImplementation::Plugin { provider } if provider == &o.checker.provider) && (o.checker == ReviewChecker::format(&evidence.source_binding).key || evidence.advisory_checks.iter().any(|c| c.checker().key == o.checker && c.rules.contains(&requirement.key.rule))));
                match origin.map(|o| o.outcome) {
                    Some(ReviewInvocationOutcome::Failed) => (
                        "failed",
                        Some("Invocation failed; no check result"),
                        &[][..],
                    ),
                    Some(ReviewInvocationOutcome::Unknown) => (
                        "unknown",
                        Some("Invocation outcome unknown; no check result"),
                        &[][..],
                    ),
                    _ => ("missing", Some("Check result missing"), &[][..]),
                }
            }
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
            let mut projected = rule.clone();
            projected.key = requirement.key.clone();
            projected.mandatory = requirement.mandatory;
            rules.push(projected);
        } else {
            // Domain names never impersonate Core fallback or waiver policies.
            let rule = format!("plugin:{}", requirement.key.rule.id);
            rules.push(CheckRuleResult {
                rule: rule.clone(),
                key: requirement.key.clone(),
                mandatory: requirement.mandatory,
                status: status.into(),
                reason: reason.map(str::to_owned),
                findings: findings
                    .iter()
                    .map(|finding| {
                        Ok(CheckFinding {
                            issue_id: finding_issue_id(
                                requirement,
                                finding,
                                &evidence.diagnostics,
                            )?,
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
        && rules.len() == evidence.required_checks.requirements.len()
        && rules
            .iter()
            .zip(&evidence.required_checks.requirements)
            .filter(|(_, requirement)| requirement.mandatory)
            .all(|(rule, _)| {
                matches!(rule.status.as_str(), "passed" | "not-applicable")
                    && rule.findings.is_empty()
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
    validate_choices(&evidence.advisory_checks).map_err(|_| corrupt())?;
    evidence
        .source_binding
        .checker
        .validate()
        .map_err(|_| corrupt())?;
    sdk::ReviewBinding {
        declaration: evidence.source_binding.declaration.clone(),
        checker: evidence.source_binding.checker.capability.clone(),
    }
    .validate()
    .map_err(|_| corrupt())?;
    let format = ReviewChecker::format(&evidence.source_binding);
    let expected_keys: BTreeSet<_> = std::iter::once(format.key.clone())
        .chain(evidence.advisory_checks.iter().map(|c| c.checker().key))
        .collect();
    if expected_keys.len() != evidence.advisory_checks.len() + 1
        || evidence.origins.len() != expected_keys.len()
        || evidence
            .origins
            .iter()
            .map(|o| o.checker.clone())
            .collect::<BTreeSet<_>>()
            != expected_keys
        || evidence
            .origins
            .iter()
            .map(|o| (o.attempt_id, o.result_id))
            .collect::<BTreeSet<_>>()
            .len()
            != evidence.origins.len()
    {
        return Err(corrupt());
    }
    let format_requirements: Vec<_> = evidence.required_checks.requirements.iter().filter(|r| matches!(&r.key.implementation, sdk::CheckImplementation::Plugin { provider } if provider == &format.key.provider) && evidence.source_binding.declaration.rules.iter().any(|d| d.rule == r.key.rule)).collect();
    if format_requirements.len() != evidence.source_binding.declaration.rules.len()
        || format_requirements.iter().any(|r| {
            !r.mandatory
                || r.waivable
                || !evidence
                    .source_binding
                    .declaration
                    .rules
                    .iter()
                    .any(|d| d.rule == r.key.rule)
        })
    {
        return Err(corrupt());
    }
    for choice in &evidence.advisory_checks {
        let selected: Vec<_> = evidence.required_checks.requirements.iter().filter(|r| matches!(&r.key.implementation, sdk::CheckImplementation::Plugin { provider } if provider == &choice.binding.checker.provider) && choice.rules.contains(&r.key.rule)).collect();
        if selected.len() != choice.rules.len()
            || selected.iter().any(|r| r.mandatory || r.waivable)
        {
            return Err(corrupt());
        }
    }
    let allowed: BTreeSet<_> = format_requirements
        .iter()
        .map(|r| r.key.clone())
        .chain(evidence.advisory_checks.iter().flat_map(|c| {
            c.rules.iter().map(|rule| sdk::CheckKey {
                rule: rule.clone(),
                implementation: sdk::CheckImplementation::Plugin {
                    provider: c.binding.checker.provider.clone(),
                },
            })
        }))
        .collect();
    if evidence.required_checks.requirements.iter().any(|r| {
        matches!(
            r.key.implementation,
            sdk::CheckImplementation::Plugin { .. }
        ) && !allowed.contains(&r.key)
    }) {
        return Err(corrupt());
    }
    if run.validator_version != CHECK_VERSION
        || sdk::validate_package_digest(&evidence.qa_basis).is_err()
        || run.outcome != check_outcome(&run.rules)
        || project_rules(evidence, &core)? != run.rules
    {
        return Err(corrupt());
    }
    Ok(())
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub(in crate::persistence::review) fn validate_legacy_source(
    connection: &Connection,
    project: ExecutionId,
    run: &CheckRun,
) -> Result<(), ExecutionError> {
    let attempt: String = connection.query_row(
        "SELECT attempt_id FROM source_snapshots WHERE snapshot_id=?1 AND project_id=?2",
        params![run.basis_evidence.source_snapshot_id.to_string(), project.to_string()],
        |row| row.get(0),
    ).map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => corrupt(),
        other => sql(other),
    })?;
    let input = super::super::super::ledger::load_input(
        connection, parse_id(attempt).map_err(|_| corrupt())?,
    ).map_err(|error| match error.code {
        ErrorCode::StorageFailed | ErrorCode::Busy | ErrorCode::OutcomeUnknown => error,
        _ => corrupt(),
    })?;
    let settings = crate::content::SourceSettings::from_input(&input).map_err(|_| corrupt())?;
    if input.envelope().project_id != project || settings.review.is_some() {
        return Err(corrupt());
    }
    if input.envelope().plugin.is_some() {
        // Generic source-mapping unit fixtures intentionally omit domain Review
        // while retaining their real SDK source checker. This is not a
        // production legacy route or a substitute for plugin Review evidence.
        #[cfg(test)]
        if settings.checker.is_none() {
            return Err(corrupt());
        }
        #[cfg(not(test))]
        return Err(corrupt());
    }
    // Obsolete validators remain readable history, but queries only qualify the
    // current version. Check the original capability/profile without reparsing
    // domain source text or granting execution permission.
    crate::content::SourceBundle::from_input(&input).map_err(|_| corrupt())?;
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
        #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
        return validate_legacy_source(connection, project, run);
        #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
        return Err(corrupt());
    };
    // Historical reads restore every original frame without live permission.
    for origin in &evidence.origins {
        let input = super::super::super::ledger::load_input(connection, origin.attempt_id)?;
        let result =
            super::super::super::ledger::load_result(connection, &input, origin.result_id)?;
        validate_saved_frames(project, run, request_digest, origin, &input, &result)?;
    }
    Ok(())
}

pub(in crate::persistence::review) fn validate_saved_frames(
    project: ExecutionId,
    run: &CheckRun,
    request_digest: &str,
    saved: &ReviewCheckOriginEvidence,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    validate_projection(run)?;
    let evidence = run.evidence.as_ref().ok_or_else(corrupt)?;
    let envelope = input.envelope();
    let item = envelope.items.first().ok_or_else(corrupt)?;
    if envelope.attempt_id != saved.attempt_id
        || result.envelope().result_id != saved.result_id
        || input.digest() != saved.input_digest
        || result.digest() != saved.result_digest
        || envelope.project_id != project
        || envelope.operation != crate::execution::REVIEW_CHECK_OPERATION
        || envelope.items.len() != 1
        || envelope.units.len() != 1
        || item.scope.kind != "review-check"
        || item.scope.id != run.unit_id.to_string()
        || item.scope.locale.as_deref() != Some(run.locale.as_str())
        || envelope.settings["unitId"] != run.unit_id.to_string()
        || envelope.settings["version"] != 2
        || envelope.settings["actionId"] != run.action_id.to_string()
        || envelope.settings["requestDigest"] != request_digest
        || envelope.settings["reviewBasis"] != run.basis
        || envelope.settings["qaBasis"] != evidence.qa_basis
        || envelope.settings["requiredChecks"]
            != serde_json::to_value(&evidence.required_checks).map_err(|_| corrupt())?
        || envelope.settings["sourceBinding"]
            != serde_json::to_value(&evidence.source_binding).map_err(|_| corrupt())?
        || envelope.settings["advisoryChecks"]
            != serde_json::to_value(&evidence.advisory_checks).map_err(|_| corrupt())?
        || envelope.settings["checkerKey"]
            != serde_json::to_value(&saved.checker).map_err(|_| corrupt())?
    {
        return Err(corrupt());
    }
    let expected_request = choices::request_digest(
        project,
        run.unit_id,
        &run.locale,
        &run.basis,
        run.action_id,
        &evidence.advisory_checks,
    )?;
    if expected_request != request_digest {
        return Err(corrupt());
    }
    let keys: BTreeSet<sdk::CheckKey>;
    let received;
    if saved.checker == ReviewChecker::format(&evidence.source_binding).key {
        if envelope.plugin.as_ref() != Some(&evidence.source_binding.checker) {
            return Err(corrupt());
        }
        let captured = execution::ValidatedFormatInput::capture(input, &evidence.source_binding)
            .map_err(|_| corrupt())?;
        keys = captured
            .requirements()
            .iter()
            .map(|r| r.key.clone())
            .collect();
        if captured
            .requirements()
            .iter()
            .any(|r| !evidence.required_checks.requirements.contains(r))
        {
            return Err(corrupt());
        }
        received = captured.receive_result(result)?;
    } else {
        let choice = evidence
            .advisory_checks
            .iter()
            .find(|c| c.checker().key == saved.checker)
            .ok_or_else(corrupt)?;
        if envelope.plugin.as_ref() != Some(&choice.checker().binding) {
            return Err(corrupt());
        }
        let captured: sdk::TextReviewCheckInput =
            serde_json::from_value(item.payload.clone()).map_err(|_| corrupt())?;
        choice
            .binding
            .validate_input(&captured)
            .map_err(|_| corrupt())?;
        keys = captured
            .requirements
            .iter()
            .map(|r| r.key.clone())
            .collect();
        if captured.resources != choice.resource_pins
            || captured
                .requirements
                .iter()
                .map(|r| &r.key.rule)
                .collect::<BTreeSet<_>>()
                != choice.rules.iter().collect()
            || captured
                .requirements
                .iter()
                .any(|r| !evidence.required_checks.requirements.contains(r))
        {
            return Err(corrupt());
        }
        received = execution::receive_checker(
            &evidence.source_binding,
            &evidence.advisory_checks,
            &saved.checker,
            input,
            result,
        )?;
    }
    let (outcome, results, diagnostics) = received;
    let projected: Vec<_> = evidence
        .results
        .iter()
        .filter(|r| keys.contains(&r.key))
        .cloned()
        .collect();
    let rich: Vec<_> = evidence
        .diagnostics
        .iter()
        .filter(|d| keys.contains(&d.key))
        .cloned()
        .collect();
    if outcome != saved.outcome || results != projected || diagnostics != rich {
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
            source_binding: computed.plan.binding().clone(),
            advisory_checks: computed.plan.advisory_checks().to_vec(),
            origins: computed
                .origins
                .iter()
                .map(|o| ReviewCheckOriginEvidence {
                    checker: o.key.clone(),
                    attempt_id: o.input.envelope().attempt_id,
                    input_digest: o.input.digest().into(),
                    result_id: o.result.envelope().result_id,
                    result_digest: o.result.digest().into(),
                    outcome: o.outcome,
                })
                .collect(),
            diagnostics: computed.diagnostics.clone(),
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
        for origin in &self.computed.origins {
            super::super::super::ledger::recheck_current_review_result_in(
                connection,
                authority,
                &origin.input,
                &origin.result,
            )?;
        }
        Ok(())
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
        let current = capture::capture_in(
            connection,
            computed.project_id,
            &target,
            &terms,
            computed.plan.advisory_checks(),
        )?
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
             validator_version,rules_json,qa_basis,evidence_json,request_digest,purpose)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'qa')",
            params![ExecutionId::new().to_string(),computed.action_id.to_string(),computed.project_id.to_string(),
                target.unit_id.to_string(),target.locale,target.basis,basis_json,CHECK_VERSION,
                self.rules_json,self.evidence.qa_basis,self.evidence_json,computed.request_digest],
        ).map_err(sql)?;
        check_by_action(connection, computed.project_id, computed.action_id)?
            .map(|r| r.0)
            .ok_or_else(corrupt)
    }
}

/// Check-only and blocked policy actions keep actual candidate QA without
/// claiming a current CheckRun. This transient projection validates the original
/// frames; it never inserts a run or relaxes current-target selection pairing.
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
    let request = choices::request_digest(
        project,
        unit,
        locale,
        &basis,
        action,
        &evidence.advisory_checks,
    )?;
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

#[cfg(test)]
mod finding_identity_tests {
    use super::*;
    fn values() -> (
        sdk::CheckRequirement,
        sdk::CheckFinding,
        sdk::TextReviewDiagnostic,
    ) {
        let contract = |id: &str| sdk::ContractRef {
            id: id.into(),
            schema_version: 1,
            behavior_version: 1,
        };
        let key = sdk::CheckKey {
            rule: contract("synthetic-rule"),
            implementation: sdk::CheckImplementation::Core {
                validator: contract("synthetic-validator"),
            },
        };
        let requirement = sdk::CheckRequirement {
            key: key.clone(),
            input_digest: "a".repeat(64),
            scope_digest: "b".repeat(64),
            targets: vec!["target-a".into()],
            mandatory: false,
            waivable: false,
            not_applicable: None,
        };
        let finding = sdk::CheckFinding {
            code: "same-code".into(),
            target: "target-a".into(),
            severity: sdk::FindingSeverity::Warning,
        };
        let diagnostic = sdk::TextReviewDiagnostic {
            key,
            code: "same-code".into(),
            target: "target-a".into(),
            location: None,
            detail: Some("Actual report detail".into()),
            suggestion: Some("First suggestion".into()),
            resource_entry: None,
        };
        (requirement, finding, diagnostic)
    }
    #[test]
    fn advisory_identity_includes_exact_rich_evidence_without_folding_other_sources() {
        let (requirement, finding, diagnostic) = values();
        let original =
            finding_issue_id(&requirement, &finding, std::slice::from_ref(&diagnostic)).unwrap();
        assert_eq!(
            original,
            finding_issue_id(&requirement, &finding, std::slice::from_ref(&diagnostic)).unwrap()
        );
        let mut changed = diagnostic.clone();
        changed.suggestion = Some("New suggestion".into());
        assert_ne!(
            original,
            finding_issue_id(&requirement, &finding, &[changed]).unwrap()
        );
        let mut changed = diagnostic.clone();
        changed.location = Some(sdk::TextReviewLocation {
            field: sdk::TextReviewField::Translation,
            range: sdk::TextRange {
                encoding: sdk::TextEncoding::Utf16,
                start: 0,
                end: 1,
            },
        });
        assert_ne!(
            original,
            finding_issue_id(&requirement, &finding, &[changed]).unwrap()
        );
        assert_ne!(
            original,
            finding_issue_id(&requirement, &finding, &[]).unwrap()
        );
        let mut other = diagnostic.clone();
        other.target = "other-target".into();
        assert_eq!(
            original,
            finding_issue_id(&requirement, &finding, &[diagnostic.clone(), other]).unwrap()
        );
        let mut other = diagnostic.clone();
        other.key.rule.id = "other-contribution".into();
        assert_eq!(
            original,
            finding_issue_id(&requirement, &finding, &[diagnostic.clone(), other]).unwrap()
        );
        let mut other = diagnostic.clone();
        other.code = "other-code".into();
        assert_eq!(
            original,
            finding_issue_id(&requirement, &finding, &[diagnostic, other]).unwrap()
        );
    }
    #[test]
    fn mandatory_identity_retains_the_original_algorithm() {
        let (mut requirement, finding, diagnostic) = values();
        requirement.mandatory = true;
        let expected = digest(&(
            "domain-review-issue-1",
            &requirement.key,
            &requirement.input_digest,
            &requirement.scope_digest,
            &finding,
        ))
        .unwrap();
        assert_eq!(
            finding_issue_id(&requirement, &finding, &[diagnostic]).unwrap(),
            expected
        );
    }
}
