//! Original manual-action recovery over the existing translation ledger.

use super::{
    ErrorCode, ExecutionError, ProjectStore, SaveTranslationRevision, SelectTranslationRevision,
    TranslationSaveReceipt, TranslationSelection,
};
use serde::{Deserialize, Serialize};

/// Replay safety is not admission, fresh authority, or proof that an action never ran.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranslationActionReplay {
    ExplicitSameRequest,
    Blocked,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TranslationActionOutcome<T> {
    Recorded {
        receipt: T,
    },
    /// No receipt was found. This does not assert that work is still running or
    /// that the original action cannot subsequently be submitted.
    Pending {
        replay: TranslationActionReplay,
    },
    Mismatch {},
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationSaveRecovery {
    /// The complete queried business request, without a Host session token.
    pub request: SaveTranslationRevision,
    pub outcome: TranslationActionOutcome<TranslationSaveReceipt>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationSelectionRecovery {
    pub request: SelectTranslationRevision,
    pub outcome: TranslationActionOutcome<TranslationSelection>,
}

fn outcome<T>(
    store: &ProjectStore,
    result: Result<Option<T>, ExecutionError>,
) -> Result<TranslationActionOutcome<T>, ExecutionError> {
    match result {
        Ok(Some(receipt)) => Ok(TranslationActionOutcome::Recorded { receipt }),
        Ok(None) => Ok(TranslationActionOutcome::Pending {
            replay: if store.is_reconciling() {
                TranslationActionReplay::Blocked
            } else {
                TranslationActionReplay::ExplicitSameRequest
            },
        }),
        Err(failure)
            if failure.code == ErrorCode::ResultMismatch
                && failure.stage == "translation-action" =>
        {
            Ok(TranslationActionOutcome::Mismatch {})
        }
        Err(failure) => Err(failure),
    }
}

impl ProjectStore {
    /// Explicitly inspect an original save and reconcile uncertain local commit
    /// state. A write's internal duplicate check must not use this recovery path
    /// to clear uncertainty and then continue with a new mutation.
    pub fn recover_translation_save(
        &self,
        request: &SaveTranslationRevision,
    ) -> Result<TranslationSaveRecovery, ExecutionError> {
        let result = self.translation_save_receipt_by_request(request);
        Ok(TranslationSaveRecovery {
            request: request.clone(),
            outcome: outcome(self, result)?,
        })
    }

    /// Inspect the original selection without recapturing its source or current
    /// selection basis and without renewing execution authority.
    pub fn recover_translation_selection(
        &self,
        request: &SelectTranslationRevision,
    ) -> Result<TranslationSelectionRecovery, ExecutionError> {
        let result = self.translation_selection_by_request(request);
        Ok(TranslationSelectionRecovery {
            request: request.clone(),
            outcome: outcome(self, result)?,
        })
    }
}

#[cfg(test)]
mod tests;
