//! The policy owner captures QA independently of the human decision basis.
//! This owned plan contains no execution grant and creates no durable check.
use super::*;
use crate::content::{SourceReviewBinding, SourceSettings};
use tsumugi_plugin_sdk as sdk;

/// Store-created policy and original source material for one current target.
/// Domain results must still come from an authorized, associated execution;
/// evaluating this plan alone does not record QA or qualify a release.
#[derive(Debug)]
pub struct ReviewCheckPlan {
    target: ReviewTarget,
    binding: SourceReviewBinding,
    input: sdk::ReviewCheckInput,
    checks: sdk::FixedCheckSet,
    terms: resources::TermResolution,
    basis: String,
}

fn reference(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn core_validator() -> sdk::ContractRef {
    reference("tsumugi.core-review")
}

fn contract_error(error: sdk::ContractError) -> ExecutionError {
    failure(
        if error.code == sdk::ContractErrorCode::LimitExceeded {
            ErrorCode::LimitExceeded
        } else {
            ErrorCode::OutputInvalid
        },
        "review-check-contract",
    )
}

impl ReviewCheckPlan {
    pub fn unit_id(&self) -> ExecutionId {
        self.target.unit_id
    }
    /// The manual decision basis deliberately excludes checker configuration.
    pub fn review_basis(&self) -> &str {
        &self.target.basis
    }
    /// Includes original bytes, selected text, resources, policy and runtime.
    pub fn basis(&self) -> &str {
        &self.basis
    }
    pub fn binding(&self) -> &SourceReviewBinding {
        &self.binding
    }
    pub fn domain_input(&self) -> &sdk::ReviewCheckInput {
        &self.input
    }
    pub fn fixed_checks(&self) -> &sdk::FixedCheckSet {
        &self.checks
    }

    /// Computes only Core-owned choice and terminology policy over owned data.
    /// No domain syntax is parsed, no database connection or worker is held.
    pub fn compute_core_checks(
        &self,
        cancellation: &Cancellation,
    ) -> Result<Vec<sdk::CheckResult>, ExecutionError> {
        self.compute_core_evidence(cancellation)
            .map(|(results, _)| results)
    }

    pub(super) fn compute_core_evidence(
        &self,
        cancellation: &Cancellation,
    ) -> Result<(Vec<sdk::CheckResult>, Vec<CheckRuleResult>), ExecutionError> {
        let (required, terminology) = crate::review::check_core_rules(
            &CheckInput {
                unit_id: self.target.unit_id,
                locale: self.target.locale.clone(),
                source_text: self.target.source_text.clone(),
                translation_text: self.target.translation_text.clone(),
            },
            &self.terms,
            &core_validator(),
        )?;
        let mut rules = vec![required, terminology];
        let results = self
            .checks
            .set()
            .requirements
            .iter()
            .filter(|r| matches!(r.key.implementation, sdk::CheckImplementation::Core { .. }))
            .map(|requirement| {
                let rule = rules
                    .iter_mut()
                    .find(|rule| rule.rule == requirement.key.rule.id)
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-core-rule"))?;
                let outcome = if cancellation.is_requested() {
                    rule.status = "cancelled".into();
                    rule.reason = Some("Cancelled before completion".into());
                    rule.findings.clear();
                    sdk::CheckOutcome::Cancelled
                } else if rule.status == "not-applicable" {
                    sdk::CheckOutcome::NotApplicable {
                        basis: requirement.not_applicable.clone().ok_or_else(|| {
                            failure(ErrorCode::ResultMismatch, "review-core-applicability")
                        })?,
                    }
                } else {
                    sdk::CheckOutcome::Completed {
                        findings: rule
                            .findings
                            .iter()
                            .map(|f| {
                                Ok(sdk::CheckFinding {
                                    // The SDK identifies a finding by (code,target).
                                    // Preserve each existing terminology cause;
                                    // never collapse distinct waiver candidates.
                                    code: if f.rule == "terminology" {
                                        format!("{}.{}", f.code, f.issue_id)
                                    } else {
                                        f.code.clone()
                                    },
                                    target: self.input.selections[0].unit_id.clone(),
                                    severity: match f.severity.as_str() {
                                        "error" => sdk::FindingSeverity::Error,
                                        "warning" => sdk::FindingSeverity::Warning,
                                        _ => {
                                            return Err(failure(
                                                ErrorCode::CorruptLedger,
                                                "review-core-severity",
                                            ));
                                        }
                                    },
                                })
                            })
                            .collect::<Result<_, ExecutionError>>()?,
                    }
                };
                Ok(sdk::CheckResult {
                    key: requirement.key.clone(),
                    input_digest: requirement.input_digest.clone(),
                    scope_digest: requirement.scope_digest.clone(),
                    covered_targets: requirement.targets.clone(),
                    outcome,
                })
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        Ok((results, rules))
    }
}

/// One validated complete source snapshot, shared by bounded current queries.
/// Per-unit policy hashing never reparses or clones the whole source exchange.
pub(in crate::persistence::review) struct ReviewMaterial {
    project_id: ExecutionId,
    binding: Option<SourceReviewBinding>,
    source: sdk::ContentExchange,
    source_digest: String,
    mappings: BTreeMap<ExecutionId, BTreeSet<(ExecutionId, String, String)>>,
    units: BTreeMap<String, (String, String)>,
}
impl ReviewMaterial {
    pub(in crate::persistence::review) fn load(
        connection: &Connection,
        project_id: ExecutionId,
        snapshot: ExecutionId,
    ) -> Result<Self, ExecutionError> {
        let (_, (source_input, _, source, rows)) =
            crate::persistence::content::snapshot_rows(connection, snapshot, true)?;
        if source_input.envelope().project_id != project_id {
            return Err(failure(ErrorCode::Unauthorized, "review-check-project"));
        }
        let binding = SourceSettings::from_input(&source_input)?.review;
        #[cfg(not(any(test, feature = "execution-test-host")))]
        if binding.is_none() {
            return Err(failure(ErrorCode::InvalidInput, "review-checker-required"));
        }
        let source_digest = digest(&("review-source-material-1", &source.exchange, &binding))?;
        let mut mappings: BTreeMap<_, BTreeSet<_>> = BTreeMap::new();
        for row in rows {
            if let Some(unit) = row.unit_id {
                mappings.entry(unit).or_default().insert((
                    row.source_revision_id.ok_or_else(|| {
                        failure(ErrorCode::CorruptLedger, "review-source-mapping")
                    })?,
                    row.occurrence.operation_unit_id,
                    row.occurrence.operation_source_revision_id,
                ));
            }
        }
        let units = source
            .exchange
            .units
            .iter()
            .map(|u| (u.id.clone(), (u.source_revision_id.clone(), u.text.clone())))
            .collect();
        Ok(Self {
            project_id,
            binding,
            source: source.exchange,
            source_digest,
            mappings,
            units,
        })
    }
    fn requirements(
        &self,
        target: &ReviewTarget,
        terms: &resources::TermResolution,
    ) -> Result<(sdk::ReviewSelection, sdk::FixedCheckSet, String), ExecutionError> {
        let binding = self
            .binding
            .as_ref()
            .ok_or_else(|| failure(ErrorCode::InvalidInput, "review-checker-required"))?;
        let mappings = self
            .mappings
            .get(&target.unit_id)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-source-mapping"))?;
        if mappings.len() != 1 {
            return Err(failure(ErrorCode::CorruptLedger, "review-source-mapping"));
        }
        let (revision, unit_id, source_revision_id) = mappings.iter().next().unwrap();
        if *revision != target.source_revision_id
            || self.units.get(unit_id)
                != Some(&(source_revision_id.clone(), target.source_text.clone()))
        {
            return Err(failure(ErrorCode::CorruptLedger, "review-source-mapping"));
        }
        let unit_id = unit_id.clone();
        let source_revision_id = source_revision_id.clone();
        let selection = sdk::ReviewSelection {
            unit_id,
            source_revision_id,
            translation_text: target.translation_text.clone(),
        };
        let input_digest = digest(&(
            "review-check-material-2",
            self.project_id,
            &self.source_digest,
            &selection,
            &target.basis_evidence,
            &target.locale,
            terms,
            POLICY_VERSION,
        ))?;
        let scope_digest = digest(&(
            self.project_id,
            target.unit_id,
            &selection.unit_id,
            &selection.source_revision_id,
            &target.locale,
        ))?;
        let missing = selection.translation_text.is_none();
        let not_applicable = || sdk::NotApplicableBasis {
            code: sdk::MISSING_REVIEW_TRANSLATION.into(),
            basis_digest: input_digest.clone(),
        };
        let requirement = |key, waivable, not_applicable| sdk::CheckRequirement {
            key,
            input_digest: input_digest.clone(),
            scope_digest: scope_digest.clone(),
            targets: vec![selection.unit_id.clone()],
            mandatory: true,
            waivable,
            not_applicable,
        };
        let core = ["required-translation", "terminology"]
            .into_iter()
            .map(|id| {
                requirement(
                    sdk::CheckKey {
                        rule: reference(id),
                        implementation: sdk::CheckImplementation::Core {
                            validator: core_validator(),
                        },
                    },
                    id == "terminology",
                    (id == "terminology" && missing).then(not_applicable),
                )
            })
            .collect();
        let domain = binding
            .declaration
            .rules
            .iter()
            .map(|r| {
                requirement(
                    sdk::CheckKey {
                        rule: r.rule.clone(),
                        implementation: sdk::CheckImplementation::Plugin {
                            provider: binding.checker.capability.provider.clone(),
                        },
                    },
                    false,
                    (r.requires_translation && missing).then(not_applicable),
                )
            })
            .collect::<Vec<_>>();
        let checks =
            sdk::capture_required_checks(reference("tsumugi.policy.balanced"), core, domain)
                .map_err(contract_error)?;
        let basis = digest(&(
            "review-check-capture-1",
            &target.basis,
            binding,
            checks.set(),
        ))?;
        Ok((selection, checks, basis))
    }
    pub(in crate::persistence::review) fn matches(
        &self,
        target: &ReviewTarget,
        terms: &resources::TermResolution,
        evidence: &ReviewCheckEvidence,
    ) -> Result<bool, ExecutionError> {
        let (_, checks, basis) = self.requirements(target, terms)?;
        Ok(basis == evidence.qa_basis && checks.set() == &evidence.required_checks)
    }
}

pub(super) fn capture_in(
    connection: &Connection,
    project_id: ExecutionId,
    target: &ReviewTarget,
    terms: &resources::TermResolution,
) -> Result<Option<ReviewCheckPlan>, ExecutionError> {
    let material = ReviewMaterial::load(connection, project_id, target.source_snapshot_id)?;
    let Some(binding) = material.binding.clone() else {
        return Ok(None);
    };
    let (selection, checks, basis) = material.requirements(target, terms)?;
    let input = sdk::ReviewCheckInput {
        source: material.source,
        target_language: target.locale.clone(),
        selections: vec![selection],
        requirements: checks
            .set()
            .requirements
            .iter()
            .filter(|r| {
                matches!(
                    r.key.implementation,
                    sdk::CheckImplementation::Plugin { .. }
                )
            })
            .cloned()
            .collect(),
    };
    sdk::ReviewBinding {
        declaration: binding.declaration.clone(),
        checker: binding.checker.capability.clone(),
    }
    .validate_input(&input)
    .map_err(contract_error)?;
    codec::encode(
        &input,
        binding
            .checker
            .capability
            .declaration
            .limits
            .max_input_bytes as usize,
    )?;
    Ok(Some(ReviewCheckPlan {
        target: target.clone(),
        binding,
        input,
        checks,
        terms: terms.clone(),
        basis,
    }))
}

impl ProjectStore {
    /// Read-only capture of the current policy and adopted domain requirements.
    /// Original proof and local-to-project identity mappings remain mandatory.
    pub fn capture_review_check_plan(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        expected_basis: &str,
    ) -> Result<ReviewCheckPlan, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?;
        queries::read_snapshot(connection, |connection| {
            let target = target_in(connection, project_id, unit_id, locale)?;
            if target.basis != expected_basis {
                return Err(failure(ErrorCode::DependencyConflict, "review-current")
                    .with_conflict(ConflictEvidence::ReviewBasis {
                        expected: expected_basis.into(),
                        current: target.basis,
                    }));
            }
            let terms = resources::resolve_terms_in(connection, project_id, unit_id, locale)?;
            capture_in(connection, project_id, &target, &terms)?
                .ok_or_else(|| failure(ErrorCode::InvalidInput, "review-checker-required"))
        })
    }
}
