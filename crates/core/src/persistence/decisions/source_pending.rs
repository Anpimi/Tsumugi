//! Pending source comparisons keep their operation-local result identity.
use super::*;
#[cfg(test)]
mod tests;

pub(super) fn project(store: &ProjectStore, c: &Connection, project: ExecutionId) -> Result<SourceProjection, ExecutionError> {
    let (groups, complete) = super::super::content::decision_mappings::pending_in(store, c, project, SOURCE_LIMIT)?;
    let mut items = Vec::new();
    for group in groups {
        let basis = codec::digest(&codec::encode(&(project, group.task_id, group.attempt_id, group.item_id,
            group.result_id, &group.scope, group.previous_snapshot_id, &group.result_digest,
            group.ambiguous_count, group.rename_candidate_count, group.cancellation_revision,
            group.cancellation_requested, group.authorization_current), crate::execution::MAX_INPUT_BYTES)?);
        items.push(DecisionItem {
            decision_id: format!("source-mapping:result:{}", group.result_id),
            source: DecisionSource::SourceMapping,
            state: if group.authorization_current { DecisionState::Pending } else { DecisionState::Stale },
            locale: None,
            targets: vec![DecisionTarget::SourceResult { attempt_id: group.attempt_id, result_id: group.result_id }],
            targets_complete: true,
            basis,
            source_action_id: None,
            action: DecisionAction::CompareSourceMapping { attempt_id: group.attempt_id, result_id: group.result_id,
                previous_snapshot_id: group.previous_snapshot_id, expected_content_revision: group.scope.revision },
            evidence: Some(DecisionEvidence::SourceComparison { ambiguous_count: group.ambiguous_count,
                rename_candidate_count: group.rename_candidate_count }),
        });
    }
    Ok(SourceProjection { items, complete })
}
