//! Trusted semantic checks run on captured values outside project transactions.
use super::*;

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
pub struct ResultValidationCapture {
    pub(crate) input: FixedInput,
    pub(crate) result: FixedResult,
}
pub struct PreparedResultValidation {
    pub(crate) capture: ResultValidationCapture,
    pub(crate) proof: ValidationProof,
}
impl ResultValidationCapture {
    pub fn prepare(
        self,
        validator: &dyn ResultValidator,
    ) -> Result<PreparedResultValidation, ExecutionError> {
        if self.input.envelope().plugin.is_some()
            && self.input.envelope().operation == crate::content::OPERATION
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "source-semantic-check-required",
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
