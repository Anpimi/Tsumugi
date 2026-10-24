//! The existing two-domain Desktop contract is a display/capture projection.
//! Core retains original SDK evidence and is the sole mutation authority.
use super::*;
use tsumugi_core::*;
use tsumugi_core::content::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContentPage {
    pub snapshot_id: Option<ExecutionId>,
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
    pub scope: ContentScope,
    pub confirmation: SourceConfirmation,
    pub namespace: String,
    pub coverage: Vec<FileCoverage>,
    pub total: u32,
    pub next_ordinal: Option<u32>,
    pub diagnostics: Vec<String>,
    pub rows: Vec<ContentRow>,
}
impl TryFrom<tsumugi_core::content::ContentPage> for ContentPage {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::ContentPage) -> Result<Self, Self::Error> {
        Ok(Self {
            snapshot_id: value.snapshot_id,
            attempt_id: value.attempt_id,
            result_id: value.result_id,
            scope: value.scope,
            confirmation: value.confirmation.into(),
            namespace: value.namespace,
            coverage: value.coverage,
            total: value.total,
            next_ordinal: value.next_ordinal,
            diagnostics: value.diagnostics,
            rows: value.rows.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContentRow {
    pub occurrence_id: Option<ExecutionId>,
    pub unit_id: Option<ExecutionId>,
    pub source_revision_id: Option<ExecutionId>,
    pub occurrence: SourceOccurrence,
}
impl TryFrom<tsumugi_core::content::ContentRow> for ContentRow {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::ContentRow) -> Result<Self, Self::Error> {
        Ok(Self {
            occurrence_id: value.occurrence_id,
            unit_id: value.unit_id,
            source_revision_id: value.source_revision_id,
            occurrence: value.occurrence.try_into()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct LineageEvidence {
    pub old: ContentRow,
    pub old_snapshot_id: ExecutionId,
    pub relationship: String,
    pub decision: String,
    pub actor: Option<String>,
    pub reason: Option<String>,
    pub action_id: ExecutionId,
    pub policy: String,
    pub applied_relation: Option<String>,
}
impl TryFrom<tsumugi_core::content::LineageEvidence> for LineageEvidence {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::LineageEvidence) -> Result<Self, Self::Error> {
        Ok(Self {
            old: value.old.try_into()?,
            old_snapshot_id: value.old_snapshot_id,
            relationship: value.relationship,
            decision: value.decision,
            actor: value.actor,
            reason: value.reason,
            action_id: value.action_id,
            policy: value.policy,
            applied_relation: value.applied_relation,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceChange {
    pub kind: SourceChangeKind,
    pub old: Option<ContentRow>,
    pub new: Option<SourceOccurrence>,
    pub candidates: Vec<ContentRow>,
}
impl TryFrom<tsumugi_core::content::SourceChange> for SourceChange {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::SourceChange) -> Result<Self, Self::Error> {
        Ok(Self {
            kind: value.kind,
            old: value.old.map(TryInto::try_into).transpose()?,
            new: value.new.map(TryInto::try_into).transpose()?,
            candidates: value.candidates.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceChangePage {
    pub scope: ContentScope,
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
    pub previous_snapshot_id: ExecutionId,
    pub confirmation: SourceConfirmation,
    pub total: u32,
    pub filtered_total: u32,
    pub unchanged: u32,
    pub moved: u32,
    pub changed: u32,
    pub added: u32,
    pub ambiguous: u32,
    pub removed: u32,
    pub next_ordinal: Option<u32>,
    pub rows: Vec<SourceChange>,
}
impl TryFrom<tsumugi_core::content::SourceChangePage> for SourceChangePage {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::SourceChangePage) -> Result<Self, Self::Error> {
        Ok(Self {
            scope: value.scope,
            attempt_id: value.attempt_id,
            result_id: value.result_id,
            previous_snapshot_id: value.previous_snapshot_id,
            confirmation: value.confirmation.into(),
            total: value.total,
            filtered_total: value.filtered_total,
            unchanged: value.unchanged,
            moved: value.moved,
            changed: value.changed,
            added: value.added,
            ambiguous: value.ambiguous,
            removed: value.removed,
            next_ordinal: value.next_ordinal,
            rows: value.rows.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceConfirmation {
    pub result_digest: String,
    pub identity_policy: String,
    pub expected_content_revision: Revision,
    pub source_language: String,
    #[serde(default)]
    pub expected_current_snapshot: Option<ExecutionId>,
    #[serde(default)]
    pub lineage: Vec<LineageChoice>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub lineage_base_snapshot: Option<ExecutionId>,
}
impl From<tsumugi_core::content::SourceConfirmation> for SourceConfirmation {
    fn from(value: tsumugi_core::content::SourceConfirmation) -> Self {
        Self {
            result_digest: value.result_digest,
            identity_policy: value.identity_policy,
            expected_content_revision: value.expected_content_revision,
            source_language: value.source_language,
            expected_current_snapshot: value.expected_current_snapshot,
            lineage: value.lineage,
            actor: value.actor,
            lineage_base_snapshot: value.lineage_base_snapshot,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImpactPage {
    pub snapshot_id: ExecutionId,
    pub summary: SourceImpactSummary,
    pub next_ordinal: Option<u32>,
    pub rows: Vec<SourceImpactRow>,
}
impl TryFrom<tsumugi_core::content::SourceImpactPage> for SourceImpactPage {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::SourceImpactPage) -> Result<Self, Self::Error> {
        Ok(Self {
            snapshot_id: value.snapshot_id,
            summary: value.summary,
            next_ordinal: value.next_ordinal,
            rows: value.rows.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImpactRow {
    pub current: ContentRow,
    pub previous: Option<ContentRow>,
    pub previous_bases: Vec<SourceImpactBasis>,
    pub locale: String,
    pub status: SourceImpactStatus,
    pub reasons: Vec<String>,
    pub selection_id: Option<ExecutionId>,
    pub translation_revision_id: Option<ExecutionId>,
    pub review_basis: String,
    pub lineage: Vec<LineageEvidence>,
}
impl TryFrom<tsumugi_core::content::SourceImpactRow> for SourceImpactRow {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::SourceImpactRow) -> Result<Self, Self::Error> {
        Ok(Self {
            current: value.current.try_into()?,
            previous: value.previous.map(TryInto::try_into).transpose()?,
            previous_bases: value.previous_bases,
            locale: value.locale,
            status: value.status,
            reasons: value.reasons,
            selection_id: value.selection_id,
            translation_revision_id: value.translation_revision_id,
            review_basis: value.review_basis,
            lineage: value.lineage.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceOccurrence {
    pub ordinal: u32,
    pub artifact_id: ExecutionId,
    pub namespace: String,
    pub key: String,
    pub text: String,
    /// Half-open UTF-8 byte offsets into the captured artifact, using its format profile.
    pub key_byte_range: [u32; 2],
    /// Half-open UTF-8 byte offsets into the original artifact, not the decoded text.
    pub value_byte_range: [u32; 2],
    pub identity_basis: String,
}
impl TryFrom<tsumugi_core::content::SourceOccurrence> for SourceOccurrence {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::SourceOccurrence) -> Result<Self, Self::Error> {
        Ok(Self {
            ordinal: value.ordinal,
            artifact_id: value.artifact_id,
            namespace: value.namespace,
            key: value.key,
            text: value.text,
            key_byte_range: value.key_byte_range.ok_or_else(|| ExecutionError::new(ErrorCode::DependencyConflict, "legacy-desktop-coordinate"))?,
            value_byte_range: value.value_byte_range,
            identity_basis: value.identity_basis,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationEntry {
    pub ordinal: u32,
    pub artifact_id: ExecutionId,
    pub native_key: String,
    pub text: String,
    /// Half-open UTF-8 byte offsets in the captured file, including JSON quotes.
    pub key_byte_range: [u32; 2],
    /// Half-open UTF-8 byte offsets before escape decoding or text normalization.
    pub value_byte_range: [u32; 2],
}
impl TryFrom<tsumugi_core::content::TranslationEntry> for TranslationEntry {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::content::TranslationEntry) -> Result<Self, Self::Error> {
        Ok(Self {
            ordinal: value.ordinal,
            artifact_id: value.artifact_id,
            native_key: value.native_key,
            text: value.text,
            key_byte_range: value.key_byte_range.ok_or_else(|| ExecutionError::new(ErrorCode::DependencyConflict, "legacy-desktop-coordinate"))?,
            value_byte_range: value.value_byte_range,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationHistory {
    pub unit_id: ExecutionId,
    pub locale: String,
    #[serde(with = "tsumugi_core::execution::revision_wire")]
    #[cfg_attr(feature = "wire-schema", schemars(with = "Revision"))]
    pub total: u64,
    pub current: Option<TranslationSelection>,
    pub current_text: Option<String>,
    pub rows: Vec<TranslationRevision>,
    #[serde(with = "tsumugi_core::execution::revision_wire::optional")]
    #[cfg_attr(feature = "wire-schema", schemars(with = "Option<Revision>"))]
    pub next_ordinal: Option<u64>,
}
impl From<tsumugi_core::TranslationHistory> for TranslationHistory {
    fn from(value: tsumugi_core::TranslationHistory) -> Self {
        Self {
            unit_id: value.unit_id,
            locale: value.locale,
            total: value.total,
            current: value.current,
            current_text: value.current_text,
            rows: value.rows.into_iter().map(Into::into).collect(),
            next_ordinal: value.next_ordinal,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationPreview {
    pub attempt_id: ExecutionId,
    pub bundle_id: ExecutionId,
    pub fixed_source_snapshot_id: ExecutionId,
    pub current_source_snapshot_id: ExecutionId,
    pub result_digest: String,
    pub file_digest: String,
    pub logical_path: String,
    pub declared_locale: String,
    pub target_locale: String,
    pub basis: String,
    pub total: u32,
    pub unique: u32,
    pub unmatched: u32,
    pub ambiguous: u32,
    pub selected_conflicts: u32,
    pub source_changed: u32,
    pub applied: u32,
    pub next_ordinal: Option<u32>,
    pub rows: Vec<TranslationPreviewRow>,
}
impl TryFrom<tsumugi_core::TranslationPreview> for TranslationPreview {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::TranslationPreview) -> Result<Self, Self::Error> {
        Ok(Self {
            attempt_id: value.attempt_id,
            bundle_id: value.bundle_id,
            fixed_source_snapshot_id: value.fixed_source_snapshot_id,
            current_source_snapshot_id: value.current_source_snapshot_id,
            result_digest: value.result_digest,
            file_digest: value.file_digest,
            logical_path: value.logical_path,
            declared_locale: value.declared_locale,
            target_locale: value.target_locale,
            basis: value.basis,
            total: value.total,
            unique: value.unique,
            unmatched: value.unmatched,
            ambiguous: value.ambiguous,
            selected_conflicts: value.selected_conflicts,
            source_changed: value.source_changed,
            applied: value.applied,
            next_ordinal: value.next_ordinal,
            rows: value.rows.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationPreviewRow {
    pub entry: TranslationEntry,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
    pub result_digest: String,
    pub unit_id: Option<ExecutionId>,
    pub occurrence_id: Option<ExecutionId>,
    pub source_revision_id: Option<ExecutionId>,
    pub source_text: Option<String>,
    pub current_selection: Option<TranslationSelection>,
    pub current_text: Option<String>,
    pub status: TranslationMatch,
}
impl TryFrom<tsumugi_core::TranslationPreviewRow> for TranslationPreviewRow {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::TranslationPreviewRow) -> Result<Self, Self::Error> {
        Ok(Self {
            entry: value.entry.try_into()?,
            item_id: value.item_id,
            result_id: value.result_id,
            result_digest: value.result_digest,
            unit_id: value.unit_id,
            occurrence_id: value.occurrence_id,
            source_revision_id: value.source_revision_id,
            source_text: value.source_text,
            current_selection: value.current_selection,
            current_text: value.current_text,
            status: value.status,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationRevision {
    pub revision_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    #[serde(with = "tsumugi_core::execution::revision_wire")]
    #[cfg_attr(feature = "wire-schema", schemars(with = "Revision"))]
    pub ordinal: u64,
    pub text: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub origin_kind: TranslationOrigin,
    pub action_id: ExecutionId,
    pub attempt_id: Option<ExecutionId>,
    pub result_id: Option<ExecutionId>,
    pub item_id: Option<ExecutionId>,
    pub artifact_id: Option<ExecutionId>,
    pub logical_path: Option<String>,
    pub declared_locale: Option<String>,
    pub native_key: Option<String>,
    pub file_digest: Option<String>,
    pub contributors: Vec<ExecutionId>,
}
impl From<tsumugi_core::TranslationRevision> for TranslationRevision {
    fn from(value: tsumugi_core::TranslationRevision) -> Self {
        Self {
            revision_id: value.revision_id,
            unit_id: value.unit_id,
            locale: value.locale,
            ordinal: value.ordinal,
            text: value.text,
            source_snapshot_id: value.source_snapshot_id,
            source_revision_id: value.source_revision_id,
            origin_kind: value.origin_kind,
            action_id: value.action_id,
            attempt_id: value.attempt_id,
            result_id: value.result_id,
            item_id: value.item_id,
            artifact_id: value.artifact_id,
            logical_path: value.logical_path,
            declared_locale: value.declared_locale,
            native_key: value.native_key,
            file_digest: value.file_digest,
            contributors: value.contributors,
        }
    }
}

/// Immutable confirmation of one save, including the basis for the next edit.
/// The selection sequence is scoped to this unit and locale.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationSaveReceipt {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub basis: TranslationEditBasis,
    pub selection: TranslationSelection,
    pub revision: TranslationRevision,
}
impl From<tsumugi_core::TranslationSaveReceipt> for TranslationSaveReceipt {
    fn from(value: tsumugi_core::TranslationSaveReceipt) -> Self {
        Self {
            project_id: value.project_id,
            action_id: value.action_id,
            basis: value.basis,
            selection: value.selection,
            revision: value.revision.into(),
        }
    }
}

impl From<SourceConfirmation> for tsumugi_core::content::SourceConfirmation {
    fn from(value: SourceConfirmation) -> Self {
        Self {
            maintenance_hook: None,
            result_digest: value.result_digest,
            identity_policy: value.identity_policy,
            expected_content_revision: value.expected_content_revision,
            source_language: value.source_language,
            expected_current_snapshot: value.expected_current_snapshot,
            lineage: value.lineage,
            actor: value.actor,
            lineage_base_snapshot: value.lineage_base_snapshot,
        }
    }
}

/// The stored action keeps the current Core parameters. The existing Desktop
/// displays only its explicit no-hook capture and later adopts by action ID.
pub(super) fn project_source_action(mut action: AdoptionAction) -> Result<AdoptionAction, ExecutionError> {
    if action.operation != tsumugi_core::content::OPERATION {
        return Err(ExecutionError::new(ErrorCode::ResultMismatch, "legacy-source-action"));
    }
    let confirmation: tsumugi_core::content::SourceConfirmation =
        serde_json::from_value(action.parameters).map_err(|_| ExecutionError::new(ErrorCode::ResultMismatch, "legacy-source-confirmation"))?;
    if confirmation.maintenance_hook.is_some() {
        return Err(ExecutionError::new(ErrorCode::DependencyConflict, "legacy-source-hook"));
    }
    action.parameters = serde_json::to_value(SourceConfirmation::from(confirmation))
        .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "legacy-source-confirmation"))?;
    Ok(action)
}

pub(super) fn project_source_action_read(mut value: AdoptionActionRead) -> Result<AdoptionActionRead, ExecutionError> {
    value.action = project_source_action(value.action)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_coordinate_projection_preserves_real_capture_and_refuses_missing_evidence() {
        let bundle = tsumugi_core::content::SourceBundle::capture(
            br#"{"UniqueID":"Projection.Test","Name":"Projection","Version":"1.0.0","EntryDll":"Projection.dll"}"#,
            br#"{"hello":"Hello"}"#,
            "en-US",
        ).unwrap();
        let mut output = tsumugi_core::content::extract(&bundle, &Cancellation::default()).unwrap();
        let occurrence = output.occurrences.remove(0);
        let projected = SourceOccurrence::try_from(occurrence.clone()).unwrap();
        assert_eq!(Some(projected.key_byte_range), occurrence.key_byte_range);
        assert_eq!(projected.value_byte_range, occurrence.value_byte_range);
        assert_eq!(projected.identity_basis, occurrence.identity_basis);
        let mut missing = occurrence;
        missing.key_byte_range = None;
        let error = SourceOccurrence::try_from(missing).unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict);
        assert_eq!(error.stage, "legacy-desktop-coordinate");
    }
}
