use serde::{Deserialize, Serialize};
use tsumugi_core::{
    SaveTranslationRevision, SelectTranslationRevision,
    execution::{ExecutionId, Revision},
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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftValue {
    pub basis: DraftBasis,
    pub text: String,
    pub edit_seq: Revision,
    pub pending: Option<DraftPending>,
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
