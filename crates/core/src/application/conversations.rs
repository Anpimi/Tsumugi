//! Project-local human conversation records. Messages do not authorize execution.
use crate::execution::{ExecutionId, Revision};
use serde::{Deserialize, Serialize};
mod planning;
pub use planning::*;

/// Match the existing human-readable team member name bound.
pub const MAX_CONVERSATION_TITLE_BYTES: usize = 128;
pub const MAX_CONVERSATION_MESSAGE_BYTES: usize =
    super::TeamMessageLimits::current_team().max_body_bytes as usize;
pub const MAX_CONVERSATION_PAGE_BYTES: usize = 256 * 1024;
pub const MAX_CONVERSATION_PAGE: u32 = 50;

/// An explicit null is an untitled conversation; missing fields are rejected.
pub fn required_conversation_title<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
#[cfg(feature = "wire-schema")]
pub fn conversation_title_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<String> as schemars::JsonSchema>::json_schema(generator)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CreateProjectConversation {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub conversation_id: ExecutionId,
    #[serde(deserialize_with = "required_conversation_title")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "conversation_title_schema")
    )]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AppendProjectConversationMessage {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub message_id: ExecutionId,
    pub body: String,
}

/// Stable identity independent of any WorkPlan. Later associations can refer to
/// this identity without constraining a conversation to one plan or run.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ProjectConversation {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub ordinal: Revision,
    pub title: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationAuthor {
    Human,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ProjectConversationMessage {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub message_id: ExecutionId,
    pub ordinal: Revision,
    pub author: ConversationAuthor,
    pub body: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ProjectConversationPage {
    pub project_id: ExecutionId,
    pub rows: Vec<ProjectConversation>,
    pub next_after: Option<Revision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ProjectConversationMessagePage {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub rows: Vec<ProjectConversationMessage>,
    pub next_after: Option<Revision>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationActionReplay {
    ExplicitSameRequest,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationActionOutcome<T> {
    Recorded {
        receipt: T,
    },
    /// The original action has no confirmed receipt. Replay is an explicit
    /// same-request operation, never a statement that work cannot have happened.
    Pending {
        replay: ConversationActionReplay,
    },
    Mismatch {},
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ProjectConversationCreateRecovery {
    pub request: CreateProjectConversation,
    pub outcome: ConversationActionOutcome<ProjectConversation>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ProjectConversationMessageRecovery {
    pub request: AppendProjectConversationMessage,
    pub outcome: ConversationActionOutcome<ProjectConversationMessage>,
}
