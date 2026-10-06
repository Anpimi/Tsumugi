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

/// Created from a store-owned immutable source result. The checker input can be
/// submitted through the existing runtime only after separate authorization.
#[derive(Clone)]
pub struct SourceValidationCapture {
    pub(crate) source: ResultValidationCapture,
    pub(crate) check_input: FixedInput,
    checks: sdk::FixedCheckSet,
}
#[derive(Clone)]
pub struct PreparedSourceValidation {
    pub(crate) capture: SourceValidationCapture,
    pub(crate) check_result: FixedResult,
    pub(crate) proof: validation::ValidationProof,
}
impl SourceValidationCapture {
    pub(crate) fn capture(source: ResultValidationCapture) -> Result<Self, ExecutionError> {
        let projected = crate::content::validate_output(&source.input, &source.result)?;
        let settings = crate::content::SourceSettings::from_input(&source.input)?;
        if source.input.envelope().plugin.is_none() {
            return Err(invalid());
        }
        let binding = settings.checker.ok_or_else(invalid)?;
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
            .into_iter()
            .map(|rule| {
                requirement(sdk::CheckKey {
                    rule,
                    implementation: sdk::CheckImplementation::Plugin {
                        provider: binding.capability.provider.clone(),
                    },
                })
            })
            .collect();
        let checks = sdk::capture_required_checks(reference(POLICY), vec![core], domain.clone())
            .map_err(|_| invalid())?;
        let payload = sdk::SourceExtractionCheckInput {
            source: crate::content::SourceBundle::from_input(&source.input)?.source_input(),
            proposal: projected.exchange,
            requirements: domain,
        };
        payload.validate().map_err(|_| invalid())?;
        let basis = SourceValidationBasis {
            source_attempt_id: source.input.envelope().attempt_id,
            source_result_id: source.result.envelope().result_id,
            source_input_digest: source.input.digest().into(),
            source_result_digest: source.result.digest().into(),
        };
        let item = InputItem::new(
            Scope {
                kind: "source-check".into(),
                id: payload.source.source_set_id.clone(),
                locale: None,
            },
            serde_json::to_value(payload).map_err(|_| invalid())?,
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
        envelope.limits.timeout_ms = envelope
            .limits
            .timeout_ms
            .min(binding.capability.declaration.limits.timeout_ms);
        envelope.plugin = Some(binding);
        let check_input = FixedInput::capture(envelope)?;
        Ok(Self {
            source,
            check_input,
            checks,
        })
    }
    pub fn check_input(&self) -> &FixedInput {
        &self.check_input
    }
    pub(super) fn set_check_input(&mut self, input: FixedInput) {
        self.check_input = input;
    }
    /// Reconstruct required policy from original fixed source evidence. Saved
    /// checker identities may differ; its entire remaining input must match.
    pub(crate) fn restore(
        source: ResultValidationCapture,
        check_input: FixedInput,
    ) -> Result<Self, ExecutionError> {
        let mut capture = Self::capture(source)?;
        validation::restore_check_input(&capture.check_input, &check_input)?;
        capture.check_input = check_input;
        Ok(capture)
    }

    /// A completed result can be invalid: coverage and blocking findings are
    /// checked independently. Commit requires this exact result in the ledger.
    pub fn prepare(
        self,
        check_result: FixedResult,
    ) -> Result<PreparedSourceValidation, ExecutionError> {
        FixedResult::restore(
            check_result.bytes(),
            check_result.digest(),
            &self.check_input,
            check_result.envelope().dispatch_token,
        )?;
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
