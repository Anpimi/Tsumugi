//! Immutable proposal history. Saving or reading a revision grants no execution.
use super::{ConversationActionOutcome, ExecutionId, Revision};
use crate::ai::conversation_planning::ConversationPlanningModelOutput;
use serde::{Deserialize, Serialize};
mod work_plans;
pub use work_plans::*;

fn required_previous<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ExecutionId>, D::Error> {
    Option::deserialize(deserializer)
}
#[cfg(feature = "wire-schema")]
fn previous_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<ExecutionId> as schemars::JsonSchema>::json_schema(generator)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CaptureConversationProposal {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub proposal_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviseConversationProposal {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub proposal_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub expected_revision_id: ExecutionId,
    pub content: ConversationPlanningModelOutput,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalOrigin {
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
    pub input_digest: String,
    pub result_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalRevision {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub proposal_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub revision: Revision,
    pub ordinal: Revision,
    #[serde(deserialize_with = "required_previous")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "previous_schema"))]
    pub previous_revision_id: Option<ExecutionId>,
    pub origin: ConversationProposalOrigin,
    pub content: ConversationPlanningModelOutput,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalPage {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub rows: Vec<ConversationProposalRevision>,
    pub next_after: Option<Revision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalCaptureRecovery {
    pub request: CaptureConversationProposal,
    pub outcome: ConversationActionOutcome<ConversationProposalRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationProposalRevisionRecovery {
    pub request: ReviseConversationProposal,
    pub outcome: ConversationActionOutcome<ConversationProposalRevision>,
}
