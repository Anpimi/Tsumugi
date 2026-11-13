//! Source approval binds a separate domain-check execution to the complete
//! original proposal. Preparation is pure; persistence rechecks both results.
use super::*;
use tsumugi_plugin_sdk as sdk;

pub const SOURCE_CHECK_OPERATION: &str = "source-semantic-check";
const POLICY: &str = "core.source-adoption";
const STRUCTURE: &str = "core.source-structure";

fn reference(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn invalid() -> ExecutionError {
    ExecutionError::new(ErrorCode::OutputInvalid, "source-semantic-check")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceValidationBasis {
    pub(crate) source_attempt_id: ExecutionId,
    pub(crate) source_result_id: ExecutionId,
    pub(crate) source_input_digest: String,
    pub(crate) source_result_digest: String,
}

#[derive(Serialize)]
struct CheckerPayload<'a> {
    source: &'a sdk::SourceExtractionInput,
    proposal: &'a sdk::ContentExchange,
    requirements: &'a [sdk::CheckRequirement],
}

/// Created from a store-owned immutable source result. The checker input can be
/// submitted through the existing runtime only after separate authorization.
#[derive(Clone)]
pub struct SourceValidationCapture {
    pub(crate) source: ResultValidationCapture,
    pub(crate) check_input: FixedInput,
    pub(crate) projected: Arc<crate::content::SourceOutput>,
    checks: sdk::FixedCheckSet,
}
#[derive(Clone)]
pub struct PreparedSourceValidation {
    pub(crate) capture: SourceValidationCapture,
    pub(crate) check_result: FixedResult,
    pub(crate) proof: validation::ValidationProof,
}

/// A user-requested publication of stored results. The recovery scope is
/// captured now; it is not evidence that the old checker was bound to S1.
#[derive(Clone)]
pub struct SourceValidationPublicationCapture {
    pub(crate) capture: SourceValidationCapture,
    pub(crate) check_result: FixedResult,
    pub(crate) scope: crate::content::ContentScope,
    pub(crate) epoch: String,
    pub(crate) publication_head: Option<(ExecutionId, bool)>,
}

pub struct PreparedSourceValidationPublication {
    pub(crate) validation: PreparedSourceValidation,
    pub(crate) scope: crate::content::ContentScope,
    pub(crate) epoch: String,
    pub(crate) publication_head: Option<(ExecutionId, bool)>,
}

impl SourceValidationPublicationCapture {
    /// Reuse the original checker policy outside the publication transaction.
    pub fn prepare(self) -> Result<PreparedSourceValidationPublication, ExecutionError> {
        Ok(PreparedSourceValidationPublication {
            validation: self.capture.prepare(self.check_result)?, scope: self.scope,
            epoch: self.epoch, publication_head: self.publication_head,
        })
    }
}
impl SourceValidationCapture {
    pub(crate) fn capture(
        source: ResultValidationCapture,
        attempt: Option<ExecutionId>,
    ) -> Result<Self, ExecutionError> {
        let (bundle, settings) = crate::content::SourceBundle::from_input_with_settings(&source.input)?;
        let (mut envelope, projected, checks) = Self::reconstruct(&source, &bundle, &settings, false)?;
        envelope.attempt_id = attempt.unwrap_or(envelope.attempt_id);
        let check_input = FixedInput::capture(envelope)?;
        Ok(Self { source, check_input, projected, checks })
    }

    fn reconstruct(
        source: &ResultValidationCapture,
        bundle: &crate::content::SourceBundle,
        settings: &crate::content::SourceSettings,
        restoring: bool,
    ) -> Result<(InputEnvelope, Arc<crate::content::SourceOutput>, sdk::FixedCheckSet), ExecutionError> {
        let projected = Arc::new(crate::content::validate_output_for_bundle(
            &source.input,
            &source.result,
            bundle,
            settings.revision_policy.clone(),
        )?);
        if source.input.envelope().plugin.is_none() {
            return Err(invalid());
        }
        let binding = settings.checker.as_ref().ok_or_else(invalid)?;
        if settings.semantic_rules.is_empty() {
            return Err(invalid());
        }
        let targets = vec![projected.exchange.source_set_id.clone()];
        let requirement = |key| sdk::CheckRequirement {
            key,
            input_digest: source.input.digest().into(),
            scope_digest: source.result.digest().into(),
            targets: targets.clone(),
            mandatory: true,
            waivable: false,
            not_applicable: None,
        };
        let core = requirement(sdk::CheckKey {
            rule: reference(STRUCTURE),
            implementation: sdk::CheckImplementation::Core {
                validator: reference(STRUCTURE),
            },
        });
        let domain: Vec<_> = settings
            .semantic_rules
            .iter()
            .map(|rule| {
                requirement(sdk::CheckKey {
                    rule: rule.clone(),
                    implementation: sdk::CheckImplementation::Plugin {
                        provider: binding.capability.provider.clone(),
                    },
                })
            })
            .collect();
        let checks = sdk::capture_required_checks(reference(POLICY), vec![core], domain.clone())
            .map_err(|_| invalid())?;
        let source_material = bundle.source_input();
        let scope_id = source_material.source_set_id.clone();
        let payload = if restoring {
            // The source and proposal already passed full SDK qualification
            // together, and the fixed union checked these mandatory rules.
            // The canonical comparison also bounds the entire Core frame,
            // whose maximum is smaller than the SDK material payload limit.
            serde_json::to_value(CheckerPayload {
                source: &source_material, proposal: &projected.exchange, requirements: &domain,
            }).map_err(|_| invalid())?
        } else {
            let payload = sdk::SourceExtractionCheckInput {
                source: source_material,
                proposal: projected.exchange.clone(),
                requirements: domain,
            };
            payload.validate().map_err(|_| invalid())?;
            serde_json::to_value(payload).map_err(|_| invalid())?
        };
        let basis = SourceValidationBasis {
            source_attempt_id: source.input.envelope().attempt_id,
            source_result_id: source.result.envelope().result_id,
            source_input_digest: source.input.digest().into(),
            source_result_digest: source.result.digest().into(),
        };
        let item = InputItem::new(
            Scope {
                kind: "source-check".into(),
                id: scope_id,
                locale: None,
            },
            payload,
            vec![],
        );
        let project = source
            .input
            .envelope()
            .project_id
            .to_string()
            .parse::<ProjectId>()
            .map_err(|_| invalid())?;
        let mut envelope = InputEnvelope::new(
            project,
            SOURCE_CHECK_OPERATION,
            &binding.capability.declaration.contract.id,
            &binding.capability_version(),
            vec![item],
        )?;
        envelope.settings = serde_json::to_value(basis).map_err(|_| invalid())?;
        envelope.limits.max_result_bytes = MAX_RESULT_BYTES as u32;
        envelope.limits.timeout_ms = binding.capability.declaration.limits.timeout_ms.min(300_000);
        envelope.plugin = Some(binding.clone());
        Ok((envelope, projected, checks))
    }
    pub fn check_input(&self) -> &FixedInput {
        &self.check_input
    }
    /// Reconstruct required policy from original fixed source evidence. Saved
    /// checker identities may differ; its entire remaining input must match.
    pub(crate) fn restore(
        source: ResultValidationCapture,
        check_input: FixedInput,
    ) -> Result<Self, ExecutionError> {
        Self::restore_with_source(source, check_input, None)
    }

    pub(crate) fn restore_with_source(
        source: ResultValidationCapture,
        check_input: FixedInput,
        verified_source: Option<(&crate::content::SourceBundle, &crate::content::SourceSettings)>,
    ) -> Result<Self, ExecutionError> {
        let (envelope, projected, checks) = match verified_source {
            Some((bundle, settings)) => Self::reconstruct(&source, bundle, settings, true)?,
            None => {
                let (bundle, settings) = crate::content::SourceBundle::from_input_with_settings(&source.input)?;
                Self::reconstruct(&source, &bundle, &settings, true)?
            }
        };
        validation::restore_reconstructed_check_input(envelope, &check_input)?;
        Ok(Self { source, check_input, projected, checks })
    }

    /// A completed result can be invalid: coverage and blocking findings are
    /// checked independently. Commit requires this exact result in the ledger.
    pub fn prepare(
        self,
        check_result: FixedResult,
    ) -> Result<PreparedSourceValidation, ExecutionError> {
        check_result.validate_for_input(&self.check_input)?;
        let valid = self.validate_check_result(&check_result).is_ok();
        let proof = validation::ValidationProof {
            input_digest: self.source.input.digest().into(),
            result_digest: self.source.result.digest().into(),
            operation: crate::content::OPERATION.into(),
            valid,
        };
        Ok(PreparedSourceValidation {
            capture: self,
            check_result,
            proof,
        })
    }
    fn validate_check_result(&self, result: &FixedResult) -> Result<(), ExecutionError> {
        validation::validate_required_check_result(&self.checks, result)
    }
}
