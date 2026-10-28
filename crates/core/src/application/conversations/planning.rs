//! Read-only planning material. Neither a preview nor its capture grants execution.
use super::ProjectConversationMessage;
use crate::{
    ai::{AiConfig, AiPreview},
    application::WorkProtection,
    execution::ExecutionId,
};
use serde::{Deserialize, Serialize};

pub const CONVERSATION_PLANNING_PREVIEW_VERSION: u32 = 1;
pub const MAX_CONVERSATION_PLANNING_MESSAGES: usize = 16;
pub const MAX_CONVERSATION_PLANNING_PREVIEW_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationPlanningScope {
    /// Explanation or clarification without a fabricated content unit or WorkPlan.
    ConversationOnly {},
    Units {
        locale: String,
        unit_ids: Vec<ExecutionId>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PrepareConversationPlanning {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub selected_message_ids: Vec<ExecutionId>,
    pub scope: ConversationPlanningScope,
    pub config: AiConfig,
}

fn required_nullable<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ExecutionId>, D::Error> {
    Option::deserialize(deserializer)
}
#[cfg(feature = "wire-schema")]
fn nullable_id(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<ExecutionId> as schemars::JsonSchema>::json_schema(generator)
}

/// Local current facts needed before a later proposal can become actionable.
/// These identities are shown to the caller and are never copied into the prompt.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningUnitBasis {
    pub unit_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_id"))]
    pub selection_id: Option<ExecutionId>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_id"))]
    pub translation_revision_id: Option<ExecutionId>,
    pub protection: WorkProtection,
    pub shared_term_revision_ids: Vec<ExecutionId>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_id"))]
    pub shared_context_revision_id: Option<ExecutionId>,
}

/// Counts are derived from the exact JSON input, including repeated per-unit
/// resource projections, rather than from requested sharing toggles.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningBrief {
    pub messages: u32,
    pub units: u32,
    pub source_texts: u32,
    pub terms: u32,
    pub manual_contexts: u32,
    pub manual_context_facts: u32,
    pub source_context_facts: u32,
    pub source_context_neighbors: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningPreview {
    pub version: u32,
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub config: AiConfig,
    pub scope: ConversationPlanningScope,
    pub selected_messages: Vec<ProjectConversationMessage>,
    pub units: Vec<ConversationPlanningUnitBasis>,
    pub system: String,
    pub input: String,
    /// UTF-8 bytes of JSON {"system": system, "input": input}, including escaping.
    pub byte_length: u32,
    pub brief: ConversationPlanningBrief,
}

/// Only an opened Store can construct this snapshot witness. A deserialized
/// preview is display data and cannot recreate it or authorize a model request.
#[derive(Clone, Debug)]
pub struct CapturedConversationPlanning {
    pub(crate) epoch: String,
    pub(crate) request: PrepareConversationPlanning,
    pub(crate) preview: ConversationPlanningPreview,
    pub(crate) ai_preview: Option<AiPreview>,
}
impl CapturedConversationPlanning {
    pub fn preview(&self) -> &ConversationPlanningPreview {
        &self.preview
    }
}
