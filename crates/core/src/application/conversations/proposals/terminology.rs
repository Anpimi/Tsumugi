//! Model terminology remains an immutable proposal until a human resource decision.
use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTermEntry {
    pub unit_id: ExecutionId,
    pub source: String,
    pub aliases: Vec<String>,
    pub target: String,
    pub protected: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTermPreview {
    pub proposal: ConversationProposalRef,
    pub model_origin: ConversationProposalOrigin,
    pub current: bool,
}
