//! Existing Desktop resource views retain file provenance and licensing.
//! New capture origins remain Core facts and require their own product surface.
use super::*;
use tsumugi_core::*;

fn unsupported() -> ExecutionError {
    ExecutionError::new(ErrorCode::DependencyConflict, "legacy-desktop-resource-origin")
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlossaryCapture {
    pub capture_id: ExecutionId,
    pub resource_id: String,
    pub revision: String,
    pub license: String,
    pub source_locale: String,
    pub target_locale: String,
    pub digest: String,
    pub count: u32,
}
impl TryFrom<tsumugi_core::GlossaryCapture> for GlossaryCapture {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::GlossaryCapture) -> Result<Self, Self::Error> {
        let GlossaryCaptureOrigin::File { resource_id, revision, license } = value.origin else {
            return Err(unsupported());
        };
        Ok(Self {
            capture_id: value.capture_id,
            resource_id,
            revision,
            license,
            source_locale: value.source_locale,
            target_locale: value.target_locale,
            digest: value.digest,
            count: value.count,
        })
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePreview {
    pub capture: GlossaryCapture,
    pub rows: Vec<ResourcePreviewRow>,
    pub removed: Vec<TermRevision>,
}
impl TryFrom<tsumugi_core::ResourcePreview> for ResourcePreview {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ResourcePreview) -> Result<Self, Self::Error> {
        if value.correction.is_some() || value.mcp.is_some() {
            return Err(unsupported());
        }
        Ok(Self { capture: value.capture.try_into()?, rows: value.rows, removed: value.removed })
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDecisionResult {
    pub action_id: ExecutionId,
    pub decision: ResourceDecisionKind,
    pub revision: Option<TermRevision>,
}
impl From<tsumugi_core::ResourceDecisionResult> for ResourceDecisionResult {
    fn from(value: tsumugi_core::ResourceDecisionResult) -> Self {
        Self { action_id: value.action_id, decision: value.decision, revision: value.revision }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDecisionActionRead {
    pub request: ResourceDecision,
    pub receipt: ResourceDecisionResult,
}
impl From<tsumugi_core::ResourceDecisionActionRead> for ResourceDecisionActionRead {
    fn from(value: tsumugi_core::ResourceDecisionActionRead) -> Self {
        Self { request: value.request, receipt: value.receipt.into() }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceImpactKind {
    Term,
    Context,
}
impl TryFrom<tsumugi_core::ResourceImpactKind> for ResourceImpactKind {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ResourceImpactKind) -> Result<Self, Self::Error> {
        match value {
            tsumugi_core::ResourceImpactKind::Term => Ok(Self::Term),
            tsumugi_core::ResourceImpactKind::Context => Ok(Self::Context),
            tsumugi_core::ResourceImpactKind::ContextFact => Err(unsupported()),
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImpactReason {
    pub change_id: ExecutionId,
    pub kind: ResourceImpactKind,
    pub old_revision_id: Option<ExecutionId>,
    pub new_revision_id: ExecutionId,
    pub old_value: Option<String>,
    pub new_value: String,
    pub new_removed: bool,
    pub confidence: ResourceImpactConfidence,
}
impl TryFrom<tsumugi_core::ImpactReason> for ImpactReason {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ImpactReason) -> Result<Self, Self::Error> {
        Ok(Self {
            change_id: value.change_id, kind: value.kind.try_into()?,
            old_revision_id: value.old_revision_id, new_revision_id: value.new_revision_id,
            old_value: value.old_value, new_value: value.new_value,
            new_removed: value.new_removed, confidence: value.confidence,
        })
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImpactItem {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub native_key: String,
    pub source_text: String,
    pub selection_event_id: ExecutionId,
    pub translation_revision_id: ExecutionId,
    pub status: ResourceImpactStatus,
    pub reasons: Vec<ImpactReason>,
}
impl TryFrom<tsumugi_core::ImpactItem> for ImpactItem {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ImpactItem) -> Result<Self, Self::Error> {
        Ok(Self {
            unit_id: value.unit_id, locale: value.locale, source_revision_id: value.source_revision_id,
            native_key: value.native_key, source_text: value.source_text,
            selection_event_id: value.selection_event_id, translation_revision_id: value.translation_revision_id,
            status: value.status,
            reasons: value.reasons.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
        })
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImpactPage {
    pub items: Vec<ImpactItem>,
    pub total_affected: u32,
    pub next_offset: Option<u32>,
    pub coverage: String,
}
impl TryFrom<tsumugi_core::ImpactPage> for ImpactPage {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ImpactPage) -> Result<Self, Self::Error> {
        Ok(Self {
            items: value.items.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
            total_affected: value.total_affected, next_offset: value.next_offset, coverage: value.coverage,
        })
    }
}
