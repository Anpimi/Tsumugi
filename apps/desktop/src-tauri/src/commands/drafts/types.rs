use serde::{Deserialize, Serialize};
use tsumugi_core::{
    MergeBasis, ReviewCheckerKey, SaveTranslationRevision, SelectTranslationRevision,
    ai::conversation_planning::ConversationPlanningModelOutput,
    application::{
        AppendProjectConversationMessage, AuthorizeConversationProposalWorkPlan,
        CaptureConversationProposal, CreateProjectConversation, ReadConversationPlanningAction,
        ReviseConversationProposal, WorkPlanCommand,
    },
    execution::{ApplicationScopeBasis, ExecutionId, Revision, UnsignedDecimal},
};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftKey {
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
}

/// The original editing basis, preserved even when the project later changes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftBasis {
    pub source_revision_id: ExecutionId,
    pub selection_id: Option<ExecutionId>,
    pub revision_id: Option<ExecutionId>,
    pub text: Option<String>,
}

/// Comparison provenance retained with local input; it grants no permission to
/// save, merge, or replace a project selection.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftMergeOrigin {
    pub comparison_id: ExecutionId,
    pub contributors: Vec<ExecutionId>,
    pub expected_basis: String,
}

/// A frozen original request, without any session token or execution authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DraftPending {
    Save {
        request: SaveTranslationRevision,
        submitted_seq: Revision,
    },
    Selection {
        request: SelectTranslationRevision,
        submitted_seq: Revision,
        text: String,
    },
    Merge {
        request: SaveTranslationRevision,
        merge: MergeBasis,
        submitted_seq: Revision,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftValue {
    pub basis: DraftBasis,
    pub text: String,
    pub edit_seq: Revision,
    pub pending: Option<DraftPending>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<DraftMergeOrigin>,
}

/// A tombstone retains its revision so an old writer cannot resurrect input.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftHead {
    pub key: DraftKey,
    pub revision: Revision,
    pub writer_id: Option<ExecutionId>,
    pub value: Option<DraftValue>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftWrite {
    pub key: DraftKey,
    pub expected_revision: Revision,
    pub writer_id: ExecutionId,
    pub value: DraftValue,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftClear {
    pub key: DraftKey,
    pub expected_revision: Revision,
}

/// Enumeration deliberately omits the user's text and frozen request payload.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftSummary {
    pub key: DraftKey,
    pub revision: Revision,
    pub edit_seq: Revision,
    pub source_revision_id: ExecutionId,
    pub has_pending: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftPage {
    pub items: Vec<DraftSummary>,
    /// Cursor over scanned heads, including tombstones; it need not match the
    /// last active item. An empty page with a cursor still has more to scan.
    pub next: Option<DraftKey>,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftKey {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
}

/// Frozen business requests are recovery input, never restored authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationDraftPending {
    Create {
        request: CreateProjectConversation,
        submitted_seq: Revision,
    },
    Append {
        request: AppendProjectConversationMessage,
        submitted_seq: Revision,
    },
    Planning {
        request: ReadConversationPlanningAction,
        preparation_id: ExecutionId,
        submitted_seq: Revision,
    },
    ProposalCapture {
        request: CaptureConversationProposal,
        submitted_seq: Revision,
    },
    ProposalRevision {
        request: ReviseConversationProposal,
        submitted_seq: Revision,
    },
    ProposalWorkPlan {
        request: AuthorizeConversationProposalWorkPlan,
        submitted_seq: Revision,
    },
    WorkPlanStart {
        conversation_id: ExecutionId,
        request: WorkPlanStartOriginal,
        expected_attempt_id: ExecutionId,
        submitted_seq: Revision,
    },
    WorkPlanControl {
        conversation_id: ExecutionId,
        request: WorkPlanControlOriginal,
        submitted_seq: Revision,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanStartOriginal {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub action_id: ExecutionId,
    pub expected_generation: Revision,
}

/// Host consent inputs are retained for identity, never restored as permission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanControlOriginal {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub action_id: ExecutionId,
    pub expected_generation: Revision,
    pub command: WorkPlanCommand,
    pub confirmed: bool,
    pub checker_executions: Vec<ReviewCheckerKey>,
    pub tool_execution: bool,
    pub application_tool_executions: Vec<ApplicationScopeBasis>,
    pub expires_at: Option<UnsignedDecimal>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftValue {
    pub text: String,
    pub edit_seq: Revision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_edit_seq: Option<Revision>,
    pub pending: Option<ConversationDraftPending>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposal_edits: Vec<ConversationProposalDraft>,
}

/// Local unfinished input, separate from immutable project proposal revisions.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalDraft {
    pub proposal_id: ExecutionId,
    pub expected_revision_id: ExecutionId,
    pub edit_seq: Revision,
    pub content: ConversationPlanningModelOutput,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftHead {
    pub key: ConversationDraftKey,
    pub revision: Revision,
    pub writer_id: Option<ExecutionId>,
    pub value: Option<ConversationDraftValue>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftWrite {
    pub key: ConversationDraftKey,
    pub expected_revision: Revision,
    pub writer_id: ExecutionId,
    pub value: ConversationDraftValue,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftResolve {
    pub write: ConversationDraftWrite,
    pub pending: ConversationDraftPending,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftClear {
    pub key: ConversationDraftKey,
    pub expected_revision: Revision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftSummary {
    pub key: ConversationDraftKey,
    pub revision: Revision,
    pub edit_seq: Revision,
    pub has_pending: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftPage {
    pub items: Vec<ConversationDraftSummary>,
    pub next: Option<ConversationDraftKey>,
}
