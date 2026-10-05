//! Trusted semantic checks run on captured values outside project transactions.
use super::*;
use tsumugi_plugin_sdk as sdk;

pub(crate) fn requires_semantic_check(input: &FixedInput) -> bool {
    input.envelope().plugin.is_some()
        && matches!(
            input.envelope().operation.as_str(),
            crate::content::OPERATION
                | crate::content::BUILD_OPERATION
                | crate::content::TRANSLATION_EXTRACTION_OPERATION
        )
}

/// Normalize only generated identities; every policy, payload, scope and
/// selected environment must still equal the independently reconstructed input.
pub(super) fn restore_check_input(
    expected: &FixedInput,
    actual: &FixedInput,
) -> Result<(), ExecutionError> {
    let captured = actual.envelope();
    if captured.items.len() != 1 || captured.units.len() != 1 {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "semantic-check-input",
        ));
    }
    let mut rebuilt = expected.envelope().clone();
    rebuilt.task_id = captured.task_id;
    rebuilt.attempt_id = captured.attempt_id;
    rebuilt.items[0].item_id = captured.items[0].item_id;
    rebuilt.units[0].unit_id = captured.units[0].unit_id;
    rebuilt.units[0].item_ids = vec![captured.items[0].item_id];
    if FixedInput::capture(rebuilt)?.digest() != actual.digest() {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "semantic-check-input",
        ));
    }
    Ok(())
}

/// Domain output cannot assert Core checks or another provider's coverage. Core
/// appends only the generic checks already established by the capture owner.
pub(super) fn validate_required_check_result(
    checks: &sdk::FixedCheckSet,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    let invalid = || ExecutionError::new(ErrorCode::OutputInvalid, "required-semantic-check");
    let evidence = result.envelope().plugin.as_ref().ok_or_else(invalid)?;
    let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
        return Err(invalid());
    };
    if output.schema != sdk::check_results_contract() {
        return Err(invalid());
    }
    let mut results = sdk::parse_check_results(output.utf8.as_bytes()).map_err(|_| invalid())?;
    if results.iter().any(|r| match &r.key.implementation {
        sdk::CheckImplementation::Plugin { provider } => *provider != evidence.channel.selection(),
        sdk::CheckImplementation::Core { .. } => true,
    }) {
        return Err(invalid());
    }
    for core in checks
        .set()
        .requirements
        .iter()
        .filter(|r| matches!(r.key.implementation, sdk::CheckImplementation::Core { .. }))
    {
        results.push(sdk::CheckResult {
            key: core.key.clone(),
            input_digest: core.input_digest.clone(),
            scope_digest: core.scope_digest.clone(),
            covered_targets: core.targets.clone(),
            outcome: sdk::CheckOutcome::Completed { findings: vec![] },
        });
    }
    let coverage = checks.evaluate(&results).map_err(|_| invalid())?;
    if !coverage.complete
        || results.iter().any(|r| match &r.outcome {
            sdk::CheckOutcome::Completed { findings } => findings
                .iter()
                .any(|f| f.severity == sdk::FindingSeverity::Error),
            _ => true,
        })
    {
        return Err(invalid());
    }
    Ok(())
}

/// Registered by the trusted application, never selected by a producer result.
/// Implementations inspect bounded captured data without project writes or IO.
pub trait ResultValidator: Send + Sync + 'static {
    fn operation(&self) -> &str;
    fn validate(&self, input: &FixedInput, result: &FixedResult) -> Result<(), ExecutionError>;
}

#[derive(Clone, Debug)]
pub(crate) struct ValidationProof {
    pub(crate) input_digest: String,
    pub(crate) result_digest: String,
    pub(crate) operation: String,
    pub(crate) valid: bool,
}
impl ValidationProof {
    pub(crate) fn matches(&self, input: &FixedInput, result: &FixedResult) -> bool {
        self.input_digest == input.digest()
            && self.result_digest == result.digest()
            && self.operation == input.envelope().operation
    }
}

/// Store-owned immutable snapshot; preparation does not retain the store.
#[derive(Clone)]
pub struct ResultValidationCapture {
    pub(crate) input: FixedInput,
    pub(crate) result: FixedResult,
}
pub struct PreparedResultValidation {
    pub(crate) capture: ResultValidationCapture,
    pub(crate) proof: ValidationProof,
}
impl ResultValidationCapture {
    pub fn prepare_translation_check(
        self,
        attempt: ExecutionId,
    ) -> Result<TranslationValidationCapture, ExecutionError> {
        let mut capture = TranslationValidationCapture::capture(self)?;
        let mut envelope = capture.check_input().envelope().clone();
        envelope.attempt_id = attempt;
        capture.set_check_input(FixedInput::capture(envelope)?);
        Ok(capture)
    }
    /// Capture actual artifacts and the independently fixed checker policy on a
    /// computation worker. Submission still requires a separate current grant.
    pub fn prepare_artifact_check(
        self,
        attempt: ExecutionId,
    ) -> Result<ArtifactValidationCapture, ExecutionError> {
        let mut capture = ArtifactValidationCapture::capture(self)?;
        let mut envelope = capture.check_input().envelope().clone();
        envelope.attempt_id = attempt;
        capture.set_check_input(FixedInput::capture(envelope)?);
        Ok(capture)
    }
    /// Build the mandatory source checker input from store-owned evidence on a
    /// computation worker, without retaining a project connection or write.
    pub fn prepare_source_check(
        self,
        attempt: ExecutionId,
    ) -> Result<SourceValidationCapture, ExecutionError> {
        let mut capture = SourceValidationCapture::capture(self)?;
        let mut envelope = capture.check_input().envelope().clone();
        envelope.attempt_id = attempt;
        capture.set_check_input(FixedInput::capture(envelope)?);
        Ok(capture)
    }

    pub fn input(&self) -> &FixedInput {
        &self.input
    }
    pub fn prepare(
        self,
        validator: &dyn ResultValidator,
    ) -> Result<PreparedResultValidation, ExecutionError> {
        if requires_semantic_check(&self.input) {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                match self.input.envelope().operation.as_str() {
                    crate::content::OPERATION => "source-semantic-check-required",
                    crate::content::TRANSLATION_EXTRACTION_OPERATION => {
                        "translation-semantic-check-required"
                    }
                    _ => "artifact-semantic-check-required",
                },
            ));
        }
        if validator.operation() != self.input.envelope().operation
            || self.result.envelope().outcome != ExecutionState::Succeeded
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "result-validator",
            ));
        }
        let proof = ValidationProof {
            input_digest: self.input.digest().into(),
            result_digest: self.result.digest().into(),
            operation: validator.operation().into(),
            valid: validator.validate(&self.input, &self.result).is_ok(),
        };
        Ok(PreparedResultValidation {
            capture: self,
            proof,
        })
    }
}
