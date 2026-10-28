//! A proposal reference describes provenance; only the original WorkPlan grants effects.
use super::*;
use crate::{
    ReviewCheckerKey,
    application::{AutomationEffect, WorkPlan},
    execution::{ApplicationScopeBasis, UnsignedDecimal},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalRef {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub proposal_id: ExecutionId,
    pub revision_id: ExecutionId,
}

/// Session-local evidence for the final preview, never a serializable permission.
#[derive(Clone, Debug)]
pub struct PreparedConversationProposalWorkPlan {
    pub(crate) proposal: ConversationProposalRef,
    pub(crate) plan: WorkPlan,
    pub(crate) epoch: String,
}
impl PreparedConversationProposalWorkPlan {
    pub fn proposal(&self) -> &ConversationProposalRef {
        &self.proposal
    }
    pub fn plan(&self) -> &WorkPlan {
        &self.plan
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AuthorizeConversationProposalWorkPlan {
    pub action_id: ExecutionId,
    pub proposal: ConversationProposalRef,
    pub plan_id: ExecutionId,
    pub plan_digest: String,
    pub confirmed: bool,
    pub effects: Vec<AutomationEffect>,
    pub expires_at: UnsignedDecimal,
    pub checker_executions: Vec<ReviewCheckerKey>,
    pub tool_execution: bool,
    pub application_tool_executions: Vec<ApplicationScopeBasis>,
}

/// A small immutable association. Lease and running state stay in the original ledger.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalWorkPlanLink {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub proposal_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub action_id: ExecutionId,
    pub plan_digest: String,
    pub ordinal: Revision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalWorkPlanPage {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub rows: Vec<ConversationProposalWorkPlanLink>,
    pub next_after: Option<Revision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalWorkPlanRecovery {
    pub request: AuthorizeConversationProposalWorkPlan,
    pub outcome: ConversationActionOutcome<ConversationProposalWorkPlanLink>,
}
