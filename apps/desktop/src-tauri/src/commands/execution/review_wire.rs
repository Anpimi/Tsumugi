//! Projections for the existing Desktop review contract. Stored evidence and
//! qualification remain with Core; these views never grant execution rights.
use super::*;
use tsumugi_core::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewCheckOutcome {
    Completed,
    Failed,
    Cancelled,
}
impl TryFrom<tsumugi_core::ReviewCheckOutcome> for ReviewCheckOutcome {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewCheckOutcome) -> Result<Self, Self::Error> {
        match value {
            tsumugi_core::ReviewCheckOutcome::Completed => Ok(Self::Completed),
            tsumugi_core::ReviewCheckOutcome::Failed => Ok(Self::Failed),
            tsumugi_core::ReviewCheckOutcome::Cancelled => Ok(Self::Cancelled),
            tsumugi_core::ReviewCheckOutcome::Unknown => Err(ExecutionError::new(
                ErrorCode::DependencyConflict, "legacy-desktop-review-outcome",
            )),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CheckRuleResult {
    pub rule: String,
    pub status: String,
    pub reason: Option<String>,
    pub findings: Vec<CheckFinding>,
}
impl From<tsumugi_core::CheckRuleResult> for CheckRuleResult {
    fn from(value: tsumugi_core::CheckRuleResult) -> Self {
        Self {
            rule: value.rule,
            status: value.status,
            reason: value.reason,
            findings: value.findings,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CheckRun {
    pub run_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub basis: String,
    pub basis_evidence: ReviewBasis,
    pub validator_version: String,
    pub outcome: ReviewCheckOutcome,
    pub rules: Vec<CheckRuleResult>,
    pub created_at: String,
}
impl TryFrom<tsumugi_core::CheckRun> for CheckRun {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::CheckRun) -> Result<Self, Self::Error> {
        Ok(Self {
            run_id: value.run_id,
            action_id: value.action_id,
            unit_id: value.unit_id,
            locale: value.locale,
            basis: value.basis,
            basis_evidence: value.basis_evidence,
            validator_version: value.validator_version,
            outcome: value.outcome.try_into()?,
            rules: value.rules.into_iter().map(Into::into).collect(),
            created_at: value.created_at,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewTarget {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub native_key: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub source_text: String,
    pub selection_id: Option<ExecutionId>,
    pub revision_id: Option<ExecutionId>,
    pub translation_text: Option<String>,
    pub basis: String,
    pub basis_evidence: ReviewBasis,
    pub term_conflict: bool,
    pub current_decision: Option<ReviewDecision>,
    pub current_check: Option<CheckRun>,
    pub current_fallback: Option<FallbackDecision>,
    pub current_waivers: Vec<Waiver>,
}
impl TryFrom<tsumugi_core::ReviewTarget> for ReviewTarget {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewTarget) -> Result<Self, Self::Error> {
        Ok(Self {
            unit_id: value.unit_id,
            locale: value.locale,
            native_key: value.native_key,
            source_snapshot_id: value.source_snapshot_id,
            source_revision_id: value.source_revision_id,
            source_text: value.source_text,
            selection_id: value.selection_id,
            revision_id: value.revision_id,
            translation_text: value.translation_text,
            basis: value.basis,
            basis_evidence: value.basis_evidence,
            term_conflict: value.term_conflict,
            current_decision: value.current_decision,
            current_check: value.current_check.map(TryInto::try_into).transpose()?,
            current_fallback: value.current_fallback,
            current_waivers: value.current_waivers,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewPage {
    pub rows: Vec<ReviewTarget>,
    pub next_ordinal: Option<u32>,
    pub total: u32,
}
impl TryFrom<tsumugi_core::ReviewPage> for ReviewPage {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewPage) -> Result<Self, Self::Error> {
        Ok(Self {
            rows: value.rows.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
            next_ordinal: value.next_ordinal,
            total: value.total,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewHistoryPage {
    pub decisions: Vec<ReviewDecision>,
    pub checks: Vec<CheckRun>,
    pub waivers: Vec<Waiver>,
    pub fallbacks: Vec<FallbackDecision>,
    pub next_offset: Option<u32>,
}
impl TryFrom<tsumugi_core::ReviewHistoryPage> for ReviewHistoryPage {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewHistoryPage) -> Result<Self, Self::Error> {
        Ok(Self {
            decisions: value.decisions,
            checks: value.checks.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
            waivers: value.waivers,
            fallbacks: value.fallbacks,
            next_offset: value.next_offset,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewEditorSnapshot {
    pub target: ReviewTarget,
    pub translations: super::source_wire::TranslationHistory,
    pub terms: tsumugi_core::TermResolution,
    pub context: Option<tsumugi_core::ContextRevision>,
    pub read_version: String,
}
impl TryFrom<tsumugi_core::ReviewEditorSnapshot> for ReviewEditorSnapshot {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewEditorSnapshot) -> Result<Self, Self::Error> {
        Ok(Self {
            target: value.target.try_into()?,
            translations: value.translations.into(),
            terms: value.terms,
            context: value.context,
            read_version: value.read_version,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckActionRequest {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub expected_basis: String,
}
impl From<tsumugi_core::ReviewCheckActionRequest> for ReviewCheckActionRequest {
    fn from(value: tsumugi_core::ReviewCheckActionRequest) -> Self {
        Self {
            project_id: value.project_id,
            action_id: value.action_id,
            unit_id: value.unit_id,
            locale: value.locale,
            expected_basis: value.expected_basis,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckActionRead {
    pub request: ReviewCheckActionRequest,
    pub receipt: CheckRun,
}
impl TryFrom<tsumugi_core::ReviewCheckActionRead> for ReviewCheckActionRead {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewCheckActionRead) -> Result<Self, Self::Error> {
        Ok(Self {
            request: value.request.into(),
            receipt: value.receipt.try_into()?,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewSummaryCheck {
    pub run_id: ExecutionId,
    pub basis: String,
    pub outcome: ReviewCheckOutcome,
    pub has_findings: bool,
}
impl TryFrom<tsumugi_core::ReviewSummaryCheck> for ReviewSummaryCheck {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewSummaryCheck) -> Result<Self, Self::Error> {
        Ok(Self { run_id: value.run_id, basis: value.basis, outcome: value.outcome.try_into()?, has_findings: value.has_findings })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewSummary {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub native_key: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub source_preview: String,
    pub translation_preview: Option<String>,
    pub selection_id: Option<ExecutionId>,
    pub revision_id: Option<ExecutionId>,
    pub basis: String,
    pub current_decision: Option<ReviewSummaryDecision>,
    pub current_check: Option<ReviewSummaryCheck>,
}
impl TryFrom<tsumugi_core::ReviewSummary> for ReviewSummary {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewSummary) -> Result<Self, Self::Error> {
        Ok(Self {
            unit_id: value.unit_id, locale: value.locale, native_key: value.native_key,
            source_snapshot_id: value.source_snapshot_id, source_revision_id: value.source_revision_id,
            source_preview: value.source_preview, translation_preview: value.translation_preview,
            selection_id: value.selection_id, revision_id: value.revision_id, basis: value.basis,
            current_decision: value.current_decision,
            current_check: value.current_check.map(TryInto::try_into).transpose()?,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewSummaryPage {
    pub rows: Vec<ReviewSummary>,
    pub next_ordinal: Option<u32>,
    pub total: u32,
    pub scope_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub read_version: String,
}
impl TryFrom<tsumugi_core::ReviewSummaryPage> for ReviewSummaryPage {
    type Error = ExecutionError;
    fn try_from(value: tsumugi_core::ReviewSummaryPage) -> Result<Self, Self::Error> {
        Ok(Self {
            rows: value.rows.into_iter().map(TryInto::try_into).collect::<Result<_, _>>()?,
            next_ordinal: value.next_ordinal, total: value.total, scope_id: value.scope_id,
            source_snapshot_id: value.source_snapshot_id, read_version: value.read_version,
        })
    }
}

