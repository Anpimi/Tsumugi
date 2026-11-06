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
    connection: &Connection,
    project: ExecutionId,
    locale: &str,
    query: &SegmentQuery,
    units: &mut Vec<(ExecutionId, u32)>,
) -> Result<(), ExecutionError> {
    // Untranslated uses the same selection authority as the explicit selection
    // filter. Evidence for excluded rows is not needed to establish membership.
    if query.selection != SegmentSelectionFilter::All || query.status == SegmentStatusFilter::Untranslated {
        let mut statement = connection.prepare(
            "SELECT DISTINCT unit_id FROM translation_selections WHERE project_id=?1 AND locale=?2",
        ).map_err(sql)?;
        let selected = statement.query_map(params![project.to_string(), locale], |row| row.get::<_, String>(0))
            .map_err(sql)?.map(|row| row.map_err(sql).and_then(parse_id))
            .collect::<Result<BTreeSet<_>, _>>()?;
        units.retain(|(unit, _)| {
            let selected = selected.contains(unit);
            (query.selection == SegmentSelectionFilter::All || selected == (query.selection == SegmentSelectionFilter::Selected))
                && (query.status != SegmentStatusFilter::Untranslated || !selected)
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
        for row in rows::project(store, connection, project, &wanted, locale)? {
            if query.status.matches(&row) {
                matching.insert(row.content.unit_id);
            }
        }
    }
    units.retain(|(unit, _)| matching.contains(unit));
    Ok(())
}
