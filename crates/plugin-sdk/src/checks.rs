use crate::{
    validation::{count, digest, name, opaque_id, reference, unique},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum CheckImplementation {
    Core { validator: ContractRef },
    Plugin { provider: ProviderSelectionBinding },
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CheckKey {
    pub rule: ContractRef,
    pub implementation: CheckImplementation,
}
impl CheckKey {
    fn validate(&self) -> Result<(), ContractError> {
        reference(&self.rule, "checks.rule")?;
        match &self.implementation {
            CheckImplementation::Core { validator } => reference(validator, "checks.validator"),
            CheckImplementation::Plugin { provider } => provider.validate(),
        }
    }
}

/// A trusted capture of an allowed reason and its exact scope basis, not a
/// plugin's claim that it is safe to skip a required check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct NotApplicableBasis {
    pub code: String,
    pub basis_digest: String,
}
impl NotApplicableBasis {
    fn validate(&self) -> Result<(), ContractError> {
        name(&self.code, "checks.notApplicable.code")?;
        digest(&self.basis_digest, "checks.notApplicable.basisDigest")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CheckRequirement {
    pub key: CheckKey,
    pub input_digest: String,
    pub scope_digest: String,
    pub targets: Vec<String>,
    pub mandatory: bool,
    pub waivable: bool,
    pub not_applicable: Option<NotApplicableBasis>,
}
fn targets(values: &[String]) -> Result<(), ContractError> {
    if values.is_empty() || values.len() > MAX_CONTENT_ITEMS {
        return Err(ContractError::at(
            ContractErrorCode::InvalidCoverage,
            "checks.targets",
        ));
    }
    unique(values.iter(), "checks.targets")?;
    for value in values {
        opaque_id(value, "checks.targets")?;
    }
    Ok(())
}
impl CheckRequirement {
    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        self.key.validate()?;
        digest(&self.input_digest, "checks.inputDigest")?;
        digest(&self.scope_digest, "checks.scopeDigest")?;
        targets(&self.targets)?;
        if let Some(basis) = &self.not_applicable {
            basis.validate()?;
        }
        Ok(())
    }
}

/// Wire projection of the host's captured union. Receiving this from a plugin
/// does not make it a trusted policy or permit it to replace the expected set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct RequiredCheckSet {
    pub policy: ContractRef,
    pub requirements: Vec<CheckRequirement>,
}
impl RequiredCheckSet {
    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        reference(&self.policy, "checks.policy")?;
        count(self.requirements.len(), "checks.requirements")?;
        if self.requirements.is_empty()
            || !self.requirements.iter().any(|r| {
                r.mandatory && matches!(r.key.implementation, CheckImplementation::Core { .. })
            })
        {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "checks.core",
            ));
        }
        if self.requirements.iter().any(|r| {
            !r.mandatory && matches!(r.key.implementation, CheckImplementation::Core { .. })
        }) {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "checks.core",
            ));
        }
        unique(
            self.requirements.iter().map(|r| &r.key),
            "checks.requirements",
        )?;
        for requirement in &self.requirements {
            requirement.validate()?;
        }
        Ok(())
    }
}

/// Immutable union constructed by the trusted policy owner. There is no method
/// that replaces it from response data, waives findings or approves a release.
#[derive(Clone, Debug)]
pub struct FixedCheckSet(RequiredCheckSet);
pub fn capture_required_checks(
    policy: ContractRef,
    core: Vec<CheckRequirement>,
    domain: Vec<CheckRequirement>,
) -> Result<FixedCheckSet, ContractError> {
    if core.is_empty()
        || core.iter().any(|r| {
            !r.mandatory || !matches!(r.key.implementation, CheckImplementation::Core { .. })
        })
        || domain
            .iter()
            .any(|r| !matches!(r.key.implementation, CheckImplementation::Plugin { .. }))
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidCoverage,
            "checks.core",
        ));
    }
    let set = RequiredCheckSet {
        policy,
        requirements: core.into_iter().chain(domain).collect(),
    };
    set.validate()?;
    Ok(FixedCheckSet(set))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum FindingSeverity {
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CheckFinding {
    pub code: String,
    pub target: String,
    pub severity: FindingSeverity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum CheckOutcome {
    Completed { findings: Vec<CheckFinding> },
    NotApplicable { basis: NotApplicableBasis },
    Failed,
    Cancelled,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CheckResult {
    pub key: CheckKey,
    pub input_digest: String,
    pub scope_digest: String,
    pub covered_targets: Vec<String>,
    pub outcome: CheckOutcome,
}
pub(crate) fn validate_check_results(results: &[CheckResult]) -> Result<(), ContractError> {
    count(results.len(), "checks.results")?;
    unique(results.iter().map(|r| &r.key), "checks.results")?;
    for result in results {
        result.key.validate()?;
        digest(&result.input_digest, "checks.inputDigest")?;
        digest(&result.scope_digest, "checks.scopeDigest")?;
        targets(&result.covered_targets)?;
        match &result.outcome {
            CheckOutcome::Completed { findings } => {
                if findings.len() > MAX_CONTENT_ITEMS {
                    return Err(ContractError::at(
                        ContractErrorCode::LimitExceeded,
                        "checks.findings",
                    ));
                }
                unique(
                    findings.iter().map(|f| (&f.code, &f.target)),
                    "checks.findings",
                )?;
                for finding in findings {
                    name(&finding.code, "checks.findings.code")?;
                    if !result.covered_targets.contains(&finding.target) {
                        return Err(ContractError::at(
                            ContractErrorCode::InvalidCoverage,
                            "checks.findings.target",
                        ));
                    }
                }
            }
            CheckOutcome::NotApplicable { basis } => basis.validate()?,
            _ => {}
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoverageState {
    Completed { findings: Vec<CheckFinding> },
    NotApplicable { basis: NotApplicableBasis },
    Missing,
    Failed,
    Cancelled,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckCoverage {
    /// Complete coverage includes findings and an explicitly allowed N/A; it
    /// does not mean no blockers, human approval or release eligibility.
    pub complete: bool,
    pub entries: Vec<(CheckKey, CoverageState)>,
}
impl FixedCheckSet {
    pub fn set(&self) -> &RequiredCheckSet {
        &self.0
    }

    /// Results must already have been bound to their actual producer by the
    /// host. This checks current captured identities, bases and exact coverage.
    pub fn evaluate(&self, results: &[CheckResult]) -> Result<CheckCoverage, ContractError> {
        validate_check_results(results)?;
        for result in results {
            let expected = self
                .0
                .requirements
                .iter()
                .find(|r| r.key == result.key)
                .ok_or_else(|| {
                    ContractError::at(ContractErrorCode::InvalidCoverage, "checks.result.key")
                })?;
            if result.input_digest != expected.input_digest
                || result.scope_digest != expected.scope_digest
                || result.covered_targets.iter().collect::<BTreeSet<_>>()
                    != expected.targets.iter().collect()
            {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidCoverage,
                    "checks.result.basis",
                ));
            }
            if let CheckOutcome::NotApplicable { basis } = &result.outcome {
                if expected.not_applicable.as_ref() != Some(basis) {
                    return Err(ContractError::at(
                        ContractErrorCode::InvalidCoverage,
                        "checks.result.notApplicable",
                    ));
                }
            }
        }
        let mut complete = true;
        let entries = self
            .0
            .requirements
            .iter()
            .map(|requirement| {
                let state = match results
                    .iter()
                    .find(|r| r.key == requirement.key)
                    .map(|r| &r.outcome)
                {
                    Some(CheckOutcome::Completed { findings }) => CoverageState::Completed {
                        findings: findings.clone(),
                    },
                    Some(CheckOutcome::NotApplicable { basis }) => CoverageState::NotApplicable {
                        basis: basis.clone(),
                    },
                    Some(CheckOutcome::Failed) => CoverageState::Failed,
                    Some(CheckOutcome::Cancelled) => CoverageState::Cancelled,
                    Some(CheckOutcome::Unavailable) => CoverageState::Unavailable,
                    None => CoverageState::Missing,
                };
                if requirement.mandatory
                    && !matches!(
                        state,
                        CoverageState::Completed { .. } | CoverageState::NotApplicable { .. }
                    )
                {
                    complete = false;
                }
                (requirement.key.clone(), state)
            })
            .collect();
        Ok(CheckCoverage { complete, entries })
    }
}
