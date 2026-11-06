//! Status presets consume the same current projections as the returned rows.
use super::*;

impl SegmentStatusFilter {
    fn matches(self, row: &SegmentRow) -> bool {
        match self {
            Self::All => true,
            Self::Untranslated => row.content.selection_id.is_none(),
            Self::NeedsReview => {
                row.content.selection_id.is_some()
                    && !matches!(
                        row.content.current_decision.as_ref().map(|item| item.kind),
                        Some(ReviewDecisionKind::Approve)
                    )
            }
            Self::Issues => {
                matches!(
                    row.content.current_decision.as_ref().map(|item| item.kind),
                    Some(ReviewDecisionKind::RequestChanges)
                ) || row.terms.conflicting_entry_count > 0
                    || row.content.current_check.as_ref().is_some_and(|check| {
                        check.has_findings
                            || check.has_incomplete
                            || check.outcome != ReviewCheckOutcome::Completed
                    })
                    || row.qa.mandatory_coverage_complete == Some(false)
            }
            // Resource history remains visible after a successful recheck. The
            // delivery preset separately applies the original eligibility policy.
            Self::Affected => {
                row.applicability.source_basis_current == Some(false)
                    || row.applicability.resource_impact.is_some()
            }
            Self::Blocking => row.qualification.blocker_count > 0,
            Self::AiPending => row.ai_candidate_count > 0,
        }
    }
}

pub(super) fn retain(
    store: &ProjectStore,
    read: &mut queries::TargetRead<'_>,
    project: ExecutionId,
    locale: &str,
    query: &SegmentQuery,
    units: &mut Vec<(ExecutionId, u32)>,
) -> Result<(), ExecutionError> {
    let connection = read.connection();
    // These presets require absent/present selection before other evidence can
    // matter. Reuse the same authority as the explicit selection filter.
    let required_selection = match query.status {
        SegmentStatusFilter::Untranslated => Some(false),
        SegmentStatusFilter::NeedsReview => Some(true),
        _ => None,
    };
    if query.selection != SegmentSelectionFilter::All || required_selection.is_some() {
        let mut statement = connection.prepare(
            "SELECT DISTINCT unit_id FROM translation_selections WHERE project_id=?1 AND locale=?2",
        ).map_err(sql)?;
        let selected = statement.query_map(params![project.to_string(), locale], |row| row.get::<_, String>(0))
            .map_err(sql)?.map(|row| row.map_err(sql).and_then(parse_id))
            .collect::<Result<BTreeSet<_>, _>>()?;
        units.retain(|(unit, _)| {
            let selected = selected.contains(unit);
            (query.selection == SegmentSelectionFilter::All || selected == (query.selection == SegmentSelectionFilter::Selected))
                && required_selection.is_none_or(|required| selected == required)
        });
    }
    if matches!(query.status, SegmentStatusFilter::All | SegmentStatusFilter::Untranslated) {
        return Ok(());
    }
    let mut matching = BTreeSet::new();
    // The scope is already bounded by the review owner. Keep projection memory
    // bounded as well, without individual row reads or browser-side membership.
    for batch in units.chunks(100) {
        let wanted = batch.iter().map(|(unit, _)| *unit).collect::<Vec<_>>();
        for row in rows::project(store, read, project, &wanted, locale)? {
            if query.status.matches(&row) {
                matching.insert(row.content.unit_id);
            }
        }
    }
    units.retain(|(unit, _)| matching.contains(unit));
    Ok(())
}
