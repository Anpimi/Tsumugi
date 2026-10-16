//! A fixed, minimal disclosure for one explicitly shared unit and language.
//! Capturing these facts grants no external recipient access by itself.
use crate::execution::ExecutionId;
use serde::{Deserialize, Serialize};

pub const MCP_SHARE_PREVIEW_VERSION: u32 = 1;
pub const MAX_MCP_SHARE_BYTES: usize = 65_536;
pub const MAX_MCP_SHARE_PREVIEW_BYTES: usize = 131_072;

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

#[cfg(feature = "wire-schema")]
fn nullable_id(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<ExecutionId> as schemars::JsonSchema>::json_schema(generator)
}
#[cfg(feature = "wire-schema")]
fn nullable_string(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<String> as schemars::JsonSchema>::json_schema(generator)
}
#[cfg(feature = "wire-schema")]
fn nullable_translation(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<McpSharedTranslation> as schemars::JsonSchema>::json_schema(generator)
}
#[cfg(feature = "wire-schema")]
fn nullable_terms(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<Vec<McpSharedTermEntry>> as schemars::JsonSchema>::json_schema(generator)
}
#[cfg(feature = "wire-schema")]
fn nullable_term(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<McpSharedTerm> as schemars::JsonSchema>::json_schema(generator)
}
#[cfg(feature = "wire-schema")]
fn nullable_context(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<McpSharedContext> as schemars::JsonSchema>::json_schema(generator)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareRequest {
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub share_terms: bool,
    pub share_context: bool,
}

/// Related current facts only; unrelated edits do not invalidate a disclosure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpShareBasis {
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_id"))]
    pub selection_id: Option<ExecutionId>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_id"))]
    pub translation_revision_id: Option<ExecutionId>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_string"))]
    pub terms_digest: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_id"))]
    pub context_revision_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharedSource {
    pub snapshot_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharedTranslation {
    pub selection_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharedTerm {
    pub revision_id: ExecutionId,
    pub source: String,
    pub target: String,
}

/// Preserve the resource owner's ambiguity instead of choosing a conflicting term.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharedTermEntry {
    pub source: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_term"))]
    pub selected: Option<McpSharedTerm>,
    pub conflicting: Vec<McpSharedTerm>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharedContext {
    pub revision_id: ExecutionId,
    pub text: String,
}

/// Exactly the bytes visible to an external reader: no paths, reasons, project
/// metadata, review history, extracted facts or neighboring units are included.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharedUnit {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source: McpSharedSource,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "nullable_translation")
    )]
    pub translation: Option<McpSharedTranslation>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_terms"))]
    pub terms: Option<Vec<McpSharedTermEntry>>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_context"))]
    pub manual_context: Option<McpSharedContext>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct McpSharePreview {
    pub version: u32,
    pub basis: McpShareBasis,
    pub payload: McpSharedUnit,
    pub byte_length: u32,
    pub digest: String,
}

/// Only ProjectStore can obtain this witness from a consistent read snapshot.
/// Deserializing or editing a preview cannot create an authorization capture.
#[derive(Clone, Debug)]
pub struct CapturedMcpShare {
    pub(crate) epoch: String,
    pub(crate) request: McpShareRequest,
    pub(crate) preview: McpSharePreview,
}
impl CapturedMcpShare {
    pub fn preview(&self) -> &McpSharePreview {
        &self.preview
    }
    pub fn payload(&self) -> &McpSharedUnit {
        &self.preview.payload
    }
}
