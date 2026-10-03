//! Owned application-stage values. Database authority stays in ProjectStore.
use super::*;

/// Captured by the store in one read snapshot. No transaction crosses this value.
#[derive(Debug)]
pub struct AdoptionCapture {
    pub(crate) action: AdoptionAction,
    pub(crate) input: FixedInput,
    pub(crate) results: Vec<FixedResult>,
    pub(crate) digest: String,
    pub(crate) receipt: Option<AdoptionReceipt>,
}

/// A store-bound preparation; scope, fixed evidence and action cannot be replaced
/// by an IPC caller or an external producer.
pub struct PreparedAdoption {
    pub(crate) capture: AdoptionCapture,
    pub(crate) mutation: Option<PreparedMutation>,
}

impl AdoptionCapture {
    pub fn prepare(
        self,
        handler: &dyn AdoptionHandler,
    ) -> Result<PreparedAdoption, ExecutionError> {
        let mutation = if self.receipt.is_some() {
            None
        } else {
            if handler.operation() != self.action.operation {
                return Err(ExecutionError::new(ErrorCode::Unauthorized, "handler"));
            }
            Some(handler.prepare(&self.input, &self.action, &self.results)?)
        };
        Ok(PreparedAdoption {
            capture: self,
            mutation,
        })
    }
}
