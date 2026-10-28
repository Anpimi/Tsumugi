//! Human decisions refer to immutable model proposals, never model write permissions.
use super::*;
use crate::{
    ContextResourceKind, ContextResourceRevision, ContextResourceScope, content::ContentScope,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationKnowledgeEntry {
    pub kind: ContextResourceKind,
    pub name: String,
    pub text: String,
    pub unit_ids: Vec<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceProposalOrigin {
    pub proposal: ConversationProposalRef,
    pub entry_index: u32,
    pub model_origin: ConversationProposalOrigin,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PrepareConversationKnowledgeAdoption {
    pub proposal: ConversationProposalRef,
    pub entry_index: u32,
    pub context_id: Option<ExecutionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<ExecutionId>,
    pub scope: ContextResourceScope,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationKnowledgeAdoptionPreview {
    pub proposal: ConversationProposalRef,
    pub entry_index: u32,
    pub entry: ConversationKnowledgeEntry,
    pub current: Option<ContextResourceRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<ContextResourceRevision>,
    pub scope: ContextResourceScope,
    pub source_basis: ContentScope,
    pub basis: String,
    pub requires_wider_confirmation: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationKnowledgeAdoption {
    pub context_id: Option<ExecutionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<ExecutionId>,
    pub expected_revision_id: Option<ExecutionId>,
    pub scope: ContextResourceScope,
    pub source_basis: ContentScope,
    pub name: String,
    pub text: String,
    pub comparison_basis: String,
    pub confirm_wider_scope: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationKnowledgeDecisionKind {
    Adopt,
    Keep,
    Reject,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DecideConversationKnowledgeProposal {
    pub action_id: ExecutionId,
    pub proposal: ConversationProposalRef,
    pub entry_index: u32,
    pub decision: ConversationKnowledgeDecisionKind,
    pub actor: String,
    pub reason: String,
    pub adoption: Option<ConversationKnowledgeAdoption>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationKnowledgeDecision {
    pub action_id: ExecutionId,
    pub proposal: ConversationProposalRef,
    pub entry_index: u32,
    pub decision: ConversationKnowledgeDecisionKind,
    pub actor: String,
    pub reason: String,
    pub resource: Option<ContextResourceRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationKnowledgeDecisionRecovery {
    pub request: DecideConversationKnowledgeProposal,
    pub outcome: ConversationActionOutcome<ConversationKnowledgeDecision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextResourceProposalAction {
    pub action_id: ExecutionId,
    pub proposal: ConversationProposalRef,
    pub entry_index: u32,
}
