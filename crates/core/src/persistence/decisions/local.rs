//! Host journal observations supplement project facts; they grant no authority.
use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionJournalKey {
    Translation { unit_id: ExecutionId, locale: String },
    Conversation { conversation_id: ExecutionId },
    Resource,
    Source,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionJournalSlot { Primary, Revocation, ResourceFact, SourceHookStop }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionClientAction {
    pub key: DecisionJournalKey,
    pub slot: DecisionJournalSlot,
    pub action_id: ExecutionId,
    pub submitted_seq: Revision,
}

/// Captured from the original live Session owners. Consumers discard a response
/// if these observations have changed; these are not permissions or receipts.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionClientActivity {
    pub owner_id: ExecutionId,
    pub revision: Revision,
    pub actions: Vec<DecisionClientAction>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionLocalRequestKind {
    SourceLineageCorrection,
    Save, Selection, Merge, Create, Append, Planning, ProposalCapture,
    ProposalRevision, ProposalWorkPlan, WorkPlanStart, WorkPlanControl, TeamMessage, TeamPublication,
    ResourceTypedContextSave, ResourceTypedContextWithdraw, ResourceKnowledgeDecision,
    ResourceCorrection, ResourceTerm, ResourceContext, ResourceDecision, ResourceCapture, ResourceFact,
    SourceCapture, SourceStart, SourcePrepareCheck, SourceStartCheck, SourceFinishCheck, SourceAdopt, SourceHookStop,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionLocalRequestRef {
    pub action: DecisionClientAction,
    pub request_kind: DecisionLocalRequestKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DecisionLocalOutcome { Recorded, FencedNotApplied, ReceiptAbsent, InFlight, Mismatch, Unavailable }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionLocalObservation {
    pub reference: DecisionLocalRequestRef,
    pub head_revision: Revision,
    pub writer_id: ExecutionId,
    pub outcome: DecisionLocalOutcome,
    pub error_code: Option<ErrorCode>,
}

/// This journal snapshot and the Core snapshot are separate observations.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecisionLocalBasis {
    pub journal_basis: String,
    pub journal_complete: bool,
    pub activity: Option<Vec<DecisionClientActivity>>,
    pub observations: Vec<DecisionLocalObservation>,
}

/// Built by the Host using the original journal and pure Core receipt readers.
/// The callback runs within the same Core snapshot as the other sources.
pub struct DecisionLocalProjection {
    pub items: Vec<DecisionItem>,
    pub basis: DecisionLocalBasis,
    pub complete: bool,
    pub reason: Option<DecisionCoverageReason>,
    pub error_code: Option<ErrorCode>,
}
