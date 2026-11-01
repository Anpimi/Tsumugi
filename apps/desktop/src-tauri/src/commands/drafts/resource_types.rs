//! Local resource input and exact original requests, without execution authority.
use serde::{Deserialize, Serialize};
use tsumugi_core::{
    CaptureContext, CaptureCorrectionTerm, ContextFactDisposition, ContextFactWrite, ContextResourceKind,
    ContextResourceRevision, ContextResourceScope, ContextRevision, CorrectionTermEvidence,
    ResourceDecision, SaveContext, SaveContextResource, SaveTerm, SourceFactBasis, TermRevision,
    WithdrawContextResource,
    application::{ConversationKnowledgeEntry, ConversationKnowledgeDecision,
        ConversationProposalRef, DecideConversationKnowledgeProposal},
    content::ContentScope,
    execution::{ExecutionId, Revision},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceDraftKey { pub project_id: ExecutionId }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceTermInput {
    pub source: String, pub aliases: Vec<String>, pub target: String, pub protected: bool,
    pub scope_unit_id: Option<ExecutionId>, pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceContextOccurrence { pub key: String, pub text: String }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceContextTarget {
    pub unit_id: ExecutionId, pub source_revision_id: ExecutionId,
    pub occurrence: ResourceContextOccurrence,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceCorrectionDraft {
    pub evidence: CorrectionTermEvidence, pub source: String, pub target: String,
    pub protected: bool, pub reason: String, pub edit_seq: Revision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceFactDraft {
    pub basis: SourceFactBasis, pub key: String, pub expected_decision_id: Option<ExecutionId>,
    pub disposition: ContextFactDisposition, pub actor: String, pub reason: String, pub edit_seq: Revision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceContextResourceDraft {
    pub key: String, pub context_id: Option<ExecutionId>, pub subject_id: Option<ExecutionId>,
    pub kind: ContextResourceKind, pub locale: String, pub base: Option<ContextResourceRevision>,
    pub source_basis: ContentScope, pub scope: ContextResourceScope, pub name: String,
    pub text: String, pub actor: String, pub reason: String, pub edit_seq: Revision, pub restoring: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ResourceKnowledgeDestination { New, Update, Variant }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceKnowledgeProposalDraft {
    pub key: String, pub proposal: ConversationProposalRef, pub entry_index: u32,
    pub entry: ConversationKnowledgeEntry, pub locale: String,
    pub destination: Option<ResourceKnowledgeDestination>, pub target: Option<ContextResourceRevision>,
    pub scope: Option<ContextResourceScope>, pub name: String, pub text: String, pub actor: String,
    pub reason: String,
    pub edit_seq: Revision, pub receipt: Option<ConversationKnowledgeDecision>, pub recorded_fields: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ResourceDraftPending {
    TypedContextSave { request: SaveContextResource, draft_key: String, submitted_seq: Revision },
    TypedContextWithdraw { request: WithdrawContextResource, draft_key: String, submitted_seq: Revision },
    KnowledgeDecision { request: DecideConversationKnowledgeProposal, draft_key: String,
        submitted_seq: Revision, submitted_fields: String },
    Correction { request: CaptureCorrectionTerm, submitted_seq: Revision },
    Term { request: SaveTerm, submitted_seq: Revision, alias_input: String },
    Context { request: SaveContext, submitted_seq: Revision },
    Decision { request: ResourceDecision, locale: String, submitted_seq: Revision },
    Capture { request: CaptureContext, submitted_seq: Revision },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceFactPending { pub request: ContextFactWrite, pub submitted_seq: Revision }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceProposalEditDraft {
    pub capture_id: ExecutionId, pub entry_id: String, pub locale: String,
    pub expected_revision_id: Option<ExecutionId>, pub source: String,
    pub current_target: Option<String>, pub original_target: String, pub target: String,
    pub edit_seq: Revision,
}

/// Input only. Removed source/locale and incomplete fields remain recoverable.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceDraftValue {
    pub edit_seq: Revision, pub locale: String,
    pub selected_term: Option<TermRevision>, pub term_draft: ResourceTermInput,
    pub alias_input: String, pub term_seq: Revision, pub newer_term: bool,
    pub selected_unit: Option<ResourceContextTarget>, pub context_revision: Option<ContextRevision>,
    pub context_draft: String, pub context_reason: String, pub context_seq: Revision, pub newer_context: bool,
    pub correction_draft: Option<ResourceCorrectionDraft>, pub fact_draft: Option<ResourceFactDraft>,
    pub typed_drafts: Vec<ResourceContextResourceDraft>, pub typed_active_key: Option<String>,
    pub knowledge_drafts: Vec<ResourceKnowledgeProposalDraft>, pub knowledge_active_key: Option<String>,
    pub preview_capture_id: Option<ExecutionId>, pub fixed_context_id: Option<ExecutionId>,
    /// A native picker has no exact replayable original request.
    pub picker_unknown: bool,
    pub pending: Option<ResourceDraftPending>, pub fact_pending: Option<ResourceFactPending>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_edit_draft: Option<ResourceProposalEditDraft>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceDraftHead {
    pub key: ResourceDraftKey, pub revision: Revision, pub writer_id: Option<ExecutionId>,
    pub value: Option<ResourceDraftValue>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceDraftWrite {
    pub key: ResourceDraftKey, pub expected_revision: Revision, pub writer_id: ExecutionId,
    pub value: ResourceDraftValue,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceDraftClear { pub key: ResourceDraftKey, pub expected_revision: Revision }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ResourceDraftResolveTarget {
    Primary { pending: ResourceDraftPending },
    Fact { pending: ResourceFactPending },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ResourceDraftDisposition { Recorded, ConfirmedNotApplied }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ResourceDraftResolve {
    pub write: ResourceDraftWrite, pub target: ResourceDraftResolveTarget,
    pub disposition: ResourceDraftDisposition,
}

impl ResourceDraftPending {
    pub fn action_id(&self) -> ExecutionId {
        match self {
            Self::TypedContextSave{request,..} => request.action_id,
            Self::TypedContextWithdraw{request,..} => request.action_id,
            Self::KnowledgeDecision{request,..} => request.action_id,
            Self::Correction{request,..} => request.action_id,
            Self::Term{request,..} => request.action_id,
            Self::Context{request,..} => request.action_id,
            Self::Decision{request,..} => request.action_id,
            Self::Capture{request,..} => request.action_id,
        }
    }
    pub fn submitted_seq(&self) -> Revision {
        match self {
            Self::TypedContextSave{submitted_seq,..}|Self::TypedContextWithdraw{submitted_seq,..}
            |Self::KnowledgeDecision{submitted_seq,..}|Self::Correction{submitted_seq,..}
            |Self::Term{submitted_seq,..}|Self::Context{submitted_seq,..}
            |Self::Decision{submitted_seq,..}|Self::Capture{submitted_seq,..} => *submitted_seq,
        }
    }
}
