//! Bounded projections of the original translation, review and resource owners.
use super::super::super::checks::SegmentQaSummary;
use super::*;
use crate::application::WorkProtection;
use crate::persistence::resources::{
    ResourceImpactConfidence, ResourceImpactKind, ResourceImpactStatus,
};
use crate::persistence::{application, translation};

const SUMMARY_REFS: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentRow {
    pub content: ReviewSummary,
    pub source_truncated: bool,
    pub translation_truncated: bool,
    pub candidate_count: u32,
    /// Saved, unselected AI revisions whose latest disposition is not rejected.
    pub ai_candidate_count: u32,
    pub protection: WorkProtection,
    pub qa: SegmentQaSummary,
    pub terms: SegmentTermSummary,
    pub applicability: SegmentApplicability,
    pub qualification: SegmentQualification,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentTermRef {
    pub term_id: String,
    pub revision_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentTermSummary {
    pub applicable_entry_count: u32,
    pub conflicting_entry_count: u32,
    pub revision_count: u32,
    pub revisions: Vec<SegmentTermRef>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentImpactChange {
    pub change_id: ExecutionId,
    pub kind: ResourceImpactKind,
    pub confidence: ResourceImpactConfidence,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentResourceImpact {
    pub status: ResourceImpactStatus,
    pub reason_count: u32,
    pub changes: Vec<SegmentImpactChange>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentApplicability {
    pub selected_source_revision_id: Option<ExecutionId>,
    pub source_basis_current: Option<bool>,
    /// The captured source and resources still match; this is not a usability verdict.
    pub captured_basis_current: Option<bool>,
    /// Recorded changes since selection can remain after a successful human recheck.
    pub resource_impact: Option<SegmentResourceImpact>,
    pub resource_review_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentReason {
    pub code: String,
    pub reference: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentQualification {
    pub blocker_count: u32,
    pub exception_count: u32,
    pub blockers: Vec<SegmentReason>,
    pub exceptions: Vec<SegmentReason>,
    pub truncated: bool,
}

fn term_summary(resolution: &resources::TermResolution) -> SegmentTermSummary {
    let refs = resolution
        .entries
        .iter()
        .flat_map(|entry| entry.selected.iter().chain(&entry.conflicting))
        .map(|term| (term.term_id.clone(), term.revision_id))
        .collect::<BTreeSet<_>>();
    SegmentTermSummary {
        applicable_entry_count: resolution.entries.len() as u32,
        conflicting_entry_count: resolution
            .entries
            .iter()
            .filter(|entry| !entry.conflicting.is_empty())
            .count() as u32,
        revision_count: refs.len() as u32,
        truncated: refs.len() > SUMMARY_REFS,
        revisions: refs
            .into_iter()
            .take(SUMMARY_REFS)
            .map(|(term_id, revision_id)| SegmentTermRef {
                term_id,
                revision_id,
            })
            .collect(),
    }
}

pub(super) fn project(
    store: &ProjectStore,
    connection: &Connection,
    project: ExecutionId,
    units: &[ExecutionId],
    locale: &str,
) -> Result<Vec<SegmentRow>, ExecutionError> {
    let (targets, terms) = queries::targets_and_terms_in(
        connection,
        project,
        units,
        locale,
        &Cancellation::default(),
    )?;
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let mut candidates = translation::candidate_summaries(connection, project, units, locale)?;
    let mut protections = application::protection_summaries(connection, project, units, locale)?;
    let mut impacts = store
        .capture_resource_impacts(project, locale, Some(units))?
        .evaluate()?
        .into_iter()
        .map(|item| (item.unit_id, item))
        .collect::<BTreeMap<_, _>>();
    let wanted = serde_json::to_string(units)
        .map_err(|_| failure(ErrorCode::InvalidInput, "segment-units"))?;
    let mut statement = connection.prepare("WITH wanted AS (SELECT value unit_id FROM json_each(?3))
        SELECT wanted.unit_id,r.source_revision_id FROM wanted
        LEFT JOIN translation_selections s ON s.unit_id=wanted.unit_id AND s.project_id=?1 AND s.locale=?2
          AND s.sequence=(SELECT MAX(t.sequence) FROM translation_selections t WHERE t.unit_id=wanted.unit_id AND t.locale=?2)
        LEFT JOIN translation_revisions r ON r.revision_id=s.revision_id AND r.project_id=s.project_id AND r.unit_id=s.unit_id AND r.locale=s.locale").map_err(sql)?;
    let sources = statement
        .query_map(params![project.to_string(), locale, wanted], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(sql)?
        .map(|row| {
            let (unit, revision) = row.map_err(sql)?;
            Ok((parse_id(unit)?, revision.map(parse_id).transpose()?))
        })
        .collect::<Result<BTreeMap<_, _>, ExecutionError>>()?;
    targets
        .into_iter()
        .map(|target| {
            let unit = target.unit_id;
            let selected_source_revision_id = sources
                .get(&unit)
                .copied()
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "segment-source-basis"))?;
            if target.selection_id.is_some() != selected_source_revision_id.is_some() {
                return Err(failure(ErrorCode::CorruptLedger, "segment-source-basis"));
            }
            let impact = impacts.remove(&unit);
            let (blockers, exceptions) = assess(&target, impact.is_some());
            let reasons = |values: &[String]| {
                values
                    .iter()
                    .take(SUMMARY_REFS)
                    .map(|value| {
                        let original = eligibility_reason(&target, value);
                        SegmentReason {
                            code: original.code,
                            reference: original.reference,
                        }
                    })
                    .collect()
            };
            let qualification = SegmentQualification {
                blocker_count: blockers.len() as u32,
                exception_count: exceptions.len() as u32,
                blockers: reasons(&blockers),
                exceptions: reasons(&exceptions),
                truncated: blockers.len() > SUMMARY_REFS || exceptions.len() > SUMMARY_REFS,
            };
            let source_basis_current =
                selected_source_revision_id.map(|revision| revision == target.source_revision_id);
            let candidate_summary = candidates
                .remove(&unit)
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "segment-candidates"))?;
            let applicability = SegmentApplicability {
                selected_source_revision_id,
                source_basis_current,
                captured_basis_current: source_basis_current
                    .map(|current| current && impact.is_none()),
                resource_review_required: blockers
                    .iter()
                    .any(|reason| reason == "resource-impact-unresolved"),
                resource_impact: impact.map(|item| SegmentResourceImpact {
                    status: item.status,
                    reason_count: item.reasons.len() as u32,
                    truncated: item.reasons.len() > SUMMARY_REFS,
                    changes: item
                        .reasons
                        .into_iter()
                        .take(SUMMARY_REFS)
                        .map(|reason| SegmentImpactChange {
                            change_id: reason.change_id,
                            kind: reason.kind,
                            confidence: reason.confidence,
                        })
                        .collect(),
                }),
            };
            Ok(SegmentRow {
                candidate_count: candidate_summary.count,
                ai_candidate_count: candidate_summary.ai_count,
                protection: protections
                    .remove(&unit)
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "segment-protection"))?,
                qa: checks::segment_check_summary(target.current_check.as_ref())?,
                terms: term_summary(
                    terms
                        .get(&unit)
                        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "segment-terms"))?,
                ),
                applicability,
                qualification,
                source_truncated: target.source_text.chars().count() > PREVIEW_CHARS,
                translation_truncated: target
                    .translation_text
                    .as_ref()
                    .is_some_and(|text| text.chars().count() > PREVIEW_CHARS),
                content: target.into(),
            })
        })
        .collect()
}
