use serde::{Deserialize, Serialize};
use tsumugi_core::{
    MergeBasis, ReviewCheckerKey, SaveTranslationRevision, SelectTranslationRevision,
    ai::conversation_planning::ConversationPlanningModelOutput,
    application::{
        AppendProjectConversationMessage, AuthorizeConversationProposalWorkPlan,
        CaptureConversationProposal, CreateProjectConversation, ReadConversationPlanningAction,
        ReviseConversationProposal, WorkPlanCommand, AutomationLease,
        PublishTeamDiscussion, SendHumanTeamMessage,
        TeamExecutionMember, TeamWorkKind, TeamWorkReference,
    },
    execution::{ApplicationScopeBasis, ExecutionId, Revision, UnsignedDecimal},
};
use crate::commands::execution::work_plans::recovery::{
    WorkPlanTeamRecoveryPrepareOriginal, WorkPlanTeamRecoverySettlementOriginal,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reuse_origin: Option<tsumugi_core::TranslationReuseOrigin>,
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
    TeamQuestionResponse {
        conversation_id: ExecutionId,
        request: crate::commands::execution::work_plans::questions::TeamQuestionResponseOriginal,
        question: tsumugi_core::application::TeamDiscussionPost,
        submitted_seq: Revision,
    },
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
    TeamMessage {
        conversation_id: ExecutionId,
        request: TeamMessageOriginal,
        destination: ConversationTeamDestination,
        target_name: String,
        submitted_seq: Revision,
    },
    TeamPublication {
        conversation_id: ExecutionId,
        request: TeamPublicationOriginal,
        target_name: String,
        submitted_seq: Revision,
    },
    TeamRecovery {
        conversation_id: ExecutionId,
        request: WorkPlanTeamRecoveryPrepareOriginal,
        authorization: Option<WorkPlanTeamRecoverySettlementOriginal>,
        submitted_seq: Revision,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamMessageOriginal {
    pub project_id: ExecutionId,
    pub lease: AutomationLease,
    pub message: SendHumanTeamMessage,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamPublicationOriginal {
    pub project_id: ExecutionId,
    pub lease: AutomationLease,
    pub publication: PublishTeamDiscussion,
}

/// Captured display facts for the original recipient, never restored authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamDestination {
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 128)))]
    pub name: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 8192)))]
    pub role: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 2048)))]
    pub endpoint: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 128)))]
    pub model: String,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanRevocationCommand {
    Pause,
    Stop,
    TakeOver,
}

impl From<WorkPlanRevocationCommand> for WorkPlanCommand {
    fn from(command: WorkPlanRevocationCommand) -> Self {
        match command {
            WorkPlanRevocationCommand::Pause => Self::Pause,
            WorkPlanRevocationCommand::Stop => Self::Stop,
            WorkPlanRevocationCommand::TakeOver => Self::TakeOver,
        }
    }
}

/// A complete control request that can only withdraw authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanRevocationOriginal {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub action_id: ExecutionId,
    pub expected_generation: Revision,
    pub command: WorkPlanRevocationCommand,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationDraftRevocation {
    pub request: WorkPlanRevocationOriginal,
    pub submitted_seq: Revision,
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
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
    pub revocations: Vec<ConversationDraftRevocation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proposal_edits: Vec<ConversationProposalDraft>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
    pub team_drafts: Vec<ConversationTeamDraft>,
}

/// Unfinished local team input does not restore sharing or execution permission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamDraft {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
    pub questions: Vec<ConversationTeamQuestionDraft>,
    pub plan_id: ExecutionId,
    pub plan_digest: String,
    pub guidance: Option<ConversationTeamGuidanceDraft>,
    pub publication: Option<ConversationTeamPublicationDraft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<ConversationTeamRecoveryDraft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_recorded: Option<ConversationTeamRecoveryRecorded>,
}

/// Local answer input may be incomplete and carries no execution authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamQuestionDraft {
    pub question_post_id: ExecutionId,
    pub edit_seq: Revision,
    pub mode: ConversationTeamQuestionMode,
    pub option_id: Option<ExecutionId>,
    pub body: String,
    pub dismiss_reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationTeamQuestionMode { Text, Choice }

/// Original request and descriptive receipt only; a reopened record is no permit.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamRecoveryRecorded {
    pub request: WorkPlanTeamRecoveryPrepareOriginal,
    pub authorization: WorkPlanTeamRecoverySettlementOriginal,
    pub receipt: tsumugi_core::application::TeamRecoveryReceipt,
}

/// Incomplete recovery input, with stable tool identities and no live permit.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamRecoveryDraft {
    pub edit_seq: Revision,
    pub next_key: u32,
    pub members: Vec<ConversationTeamRecoveryMemberDraft>,
    pub recipient_key: Option<u32>,
    pub unit_id: Option<ExecutionId>,
    pub kind: TeamWorkKind,
    pub instructions: String,
    pub post_ids: Vec<ExecutionId>,
    pub prior_work: Vec<TeamWorkReference>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamRecoveryMemberDraft {
    pub key: u32,
    pub original: Option<TeamExecutionMember>,
    pub display_name: String,
    pub role: String,
    pub config: tsumugi_core::ai::AiConfig,
    pub unit_ids: Vec<ExecutionId>,
    pub tool_handles: Vec<String>,
    pub kinds: Vec<TeamWorkKind>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamGuidanceDraft {
    pub edit_seq: Revision,
    pub member_id: Option<ExecutionId>,
    pub unit_id: Option<ExecutionId>,
    pub body: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTeamPublicationDraft {
    pub edit_seq: Revision,
    pub unit_id: Option<ExecutionId>,
    pub body: String,
    pub reply_to: Option<ExecutionId>,
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
    pub target: ConversationDraftResolveTarget,
    pub disposition: ConversationDraftDisposition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationDraftResolveTarget {
    Pending { pending: ConversationDraftPending },
    Revocation { revocation: ConversationDraftRevocation },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationDraftDisposition {
    Recorded,
    FencedNotApplied,
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
