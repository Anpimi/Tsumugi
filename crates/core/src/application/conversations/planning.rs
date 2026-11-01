//! Read-only planning material. Neither a preview nor its capture grants execution.
use super::ProjectConversationMessage;
use crate::{
    ai::{AiConfig, AiPreview},
    application::WorkProtection,
    execution::{ErrorCode, ExecutionError, ExecutionId, FixedInput, codec},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

pub const CONVERSATION_PLANNING_PREVIEW_VERSION: u32 = 2;
pub const MAX_CONVERSATION_PLANNING_MESSAGES: usize = 16;
pub const MAX_CONVERSATION_PLANNING_PREVIEW_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationPlanningPurpose { Knowledge }

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<ConversationPlanningPurpose>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_resources: Option<crate::ContextResourceCapture>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<ConversationPlanningPurpose>,
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
    pub fn preview_digest(&self) -> Result<String, ExecutionError> {
        Ok(codec::digest(&codec::encode(
            &self.preview,
            MAX_CONVERSATION_PLANNING_PREVIEW_BYTES,
        )?))
    }
}

/// The trusted human command confirms one exact preview and one finite request.
/// The action identity is also the attempt identity in the original ledger.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningConsent {
    pub action_id: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub preview_digest: String,
    pub expires_at_ms: crate::execution::UnsignedDecimal,
    pub share_messages: bool,
    pub share_units: bool,
}

#[derive(Clone, Debug)]
pub struct PreparedConversationPlanning {
    pub(crate) capture: CapturedConversationPlanning,
    pub(crate) consent: ConversationPlanningConsent,
    pub(crate) input: FixedInput,
    pub(crate) permit: ConversationPlanningPermit,
}
impl PreparedConversationPlanning {
    pub fn input(&self) -> &FixedInput {
        &self.input
    }
    pub fn preview(&self) -> &ConversationPlanningPreview {
        self.capture.preview()
    }
    pub fn consent(&self) -> &ConversationPlanningConsent {
        &self.consent
    }
}

/// Session-local authority, never reconstructed from descriptive fixed bytes.
#[derive(Clone, Debug)]
pub struct ConversationPlanningPermit {
    pub(crate) capture: CapturedConversationPlanning,
    pub(crate) input: FixedInput,
    pub(crate) deadline: Instant,
    pub(crate) expires_at_ms: u64,
    pub(crate) active: Arc<AtomicBool>,
    pub(crate) store_live: Arc<AtomicBool>,
    pub(crate) store_unknown: Arc<AtomicBool>,
    pub(crate) authority_revision: Arc<std::sync::atomic::AtomicU64>,
    pub(crate) issued_revision: u64,
    pub(crate) runtime: Arc<OnceLock<(ExecutionId, Arc<AtomicBool>)>>,
}
impl ConversationPlanningPermit {
    pub(crate) fn check_input(&self, input: &FixedInput) -> Result<(), ExecutionError> {
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|value| u64::try_from(value.as_millis()).ok());
        if !self.active.load(Ordering::Acquire)
            || !self.store_live.load(Ordering::Acquire)
            || self.store_unknown.load(Ordering::Acquire)
            || self.authority_revision.load(Ordering::Acquire) != self.issued_revision
            || Instant::now() >= self.deadline
            || wall.is_none_or(|now| now >= self.expires_at_ms)
            || self
                .runtime
                .get()
                .is_some_and(|(_, live)| !live.load(Ordering::Acquire))
        {
            self.revoke();
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "conversation-planning-permit",
            ));
        }
        if input.bytes() != self.input.bytes() {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "conversation-planning-permit",
            ));
        }
        Ok(())
    }
    pub(crate) fn check_dispatch(&self, input: &FixedInput) -> Result<(), ExecutionError> {
        self.check_input(input)?;
        if self.runtime.get().is_none() {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "conversation-planning-runtime",
            ));
        }
        Ok(())
    }
    pub(crate) fn bind_runtime(
        &self,
        generation: ExecutionId,
        live: &Arc<AtomicBool>,
    ) -> Result<(), ExecutionError> {
        self.check_input(&self.input)?;
        let (original, original_live) = self.runtime.get_or_init(|| (generation, live.clone()));
        if *original != generation
            || !Arc::ptr_eq(original_live, live)
            || !live.load(Ordering::Acquire)
        {
            self.revoke();
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "conversation-planning-runtime",
            ));
        }
        Ok(())
    }
    pub(crate) fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }
    pub(crate) fn deadline(&self) -> Instant {
        self.deadline
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReadConversationPlanningAction {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub consent: ConversationPlanningConsent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningReceipt {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub consent: ConversationPlanningConsent,
    pub input_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningRecovery {
    pub request: ReadConversationPlanningAction,
    pub outcome: super::ConversationActionOutcome<ConversationPlanningReceipt>,
}

/// A small locator for an original submitted attempt, including attempts whose
/// output was never captured as a proposal. Details remain in the execution ledger.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningAttempt {
    pub sequence: crate::execution::Revision,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationPlanningAttemptPage {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub rows: Vec<ConversationPlanningAttempt>,
    pub next_after: Option<crate::execution::Revision>,
}

/// A local navigation target in the immutable planning material, never permission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationReferenceUnit {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationTermReferenceValue {
    pub term_id: String,
    pub revision_id: ExecutionId,
    pub source: String,
    pub target: String,
    pub protected: bool,
    pub origin_kind: crate::TermOrigin,
    pub removed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationMaterialReference {
    Term {
        unit: ConversationReferenceUnit,
        original: ConversationTermReferenceValue,
        current: Option<ConversationTermReferenceValue>,
    },
    File {
        unit: ConversationReferenceUnit,
        artifact_id: ExecutionId,
        logical_path: String,
        role: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ConversationReferencePage {
    pub project_id: ExecutionId,
    pub conversation_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub current_snapshot_id: Option<ExecutionId>,
    pub after: u32,
    pub total: u32,
    pub next_after: Option<u32>,
    pub rows: Vec<ConversationMaterialReference>,
}
