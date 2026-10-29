//! Checked changes to the interpretation of already adopted source identities.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceLineageCorrectionDecision { Continue, Reject, Unresolved }

/// A saved binding remains addressable after another identity becomes current.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceLineageBinding {
    pub occurrence_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub predecessor_id: Option<ExecutionId>,
    pub relation: String,
}

/// References and an exact observation of saved work; no translation is moved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceLineageSavedWork {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub selection_id: Option<ExecutionId>,
    pub translation_revision_id: Option<ExecutionId>,
    pub translation_revision_ids: Vec<ExecutionId>,
    pub review_action_ids: Vec<ExecutionId>,
    pub check_action_ids: Vec<ExecutionId>,
    pub protection_revision: Option<Revision>,
    pub protected: bool,
    pub basis: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceLineageOrigin {
    pub snapshot_id: ExecutionId,
    pub occurrence_id: ExecutionId,
    pub mapping_revision: Revision,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceLineageCorrectionBasis {
    pub project_id: ExecutionId,
    pub previous_snapshot_id: ExecutionId,
    pub snapshot_id: ExecutionId,
    pub result_id: ExecutionId,
    pub result_digest: String,
    pub scope: ContentScope,
    pub mapping_revision: Revision,
    /// Current occurrence through the actual unresolved origin, inclusive.
    pub origin_chain: Vec<SourceLineageOrigin>,
    pub ordinal: u32,
    pub bindings: Vec<SourceLineageBinding>,
    pub candidates: Vec<LineageEvidence>,
    pub saved_work: Vec<SourceLineageSavedWork>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CorrectSourceLineage {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub basis: SourceLineageCorrectionBasis,
    pub old_occurrence_id: ExecutionId,
    pub decision: SourceLineageCorrectionDecision,
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceLineageCorrectionReceipt {
    pub request: CorrectSourceLineage,
    pub mapping_revision: Revision,
    pub previous_bindings: Vec<SourceLineageBinding>,
    pub current_bindings: Vec<SourceLineageBinding>,
    pub preserved_work: Vec<SourceLineageSavedWork>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceLineageCorrectionObservation {
    Recorded { receipt: SourceLineageCorrectionReceipt },
    ConfirmedNotApplied,
    ReceiptAbsent,
}
