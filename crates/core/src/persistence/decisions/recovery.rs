//! Read the original source, execution and qualification owners without recovery.
use super::{
    DecisionAction, DecisionEvidence, DecisionItem, DecisionSource, DecisionState, DecisionTarget,
    SourceProjection, SOURCE_LIMIT, failure,
};
use crate::{
    execution::{codec, ErrorCode, ExecutionError, ExecutionId, ExecutionState, MAX_INPUT_BYTES},
    ProjectStore,
};
use rusqlite::{Connection, params};
use std::collections::{BTreeMap, BTreeSet};

fn id(value: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&value)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "decision-source-identity"))
}

fn basis(value: &impl serde::Serialize) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(value, MAX_INPUT_BYTES)?))
}

pub(super) fn project(
    store: &ProjectStore,
    c: &Connection,
    project: ExecutionId,
    locale: Option<&str>,
    source: DecisionSource,
    active: &impl Fn(ExecutionId) -> bool,
) -> Result<SourceProjection, ExecutionError> {
    match source {
        DecisionSource::SourceMapping => source_mapping(store, c, project),
        DecisionSource::ExecutionUnknown => execution_unknown(store, c, project, locale, active),
        DecisionSource::DeliveryBlocker => {
            let locales = if let Some(locale) = locale { vec![locale.to_owned()] } else {
                super::super::read_metadata_from(c)
                    .map_err(|_| failure(ErrorCode::CorruptLedger, "decision-project"))?
                    .target_locales().iter().map(|locale| locale.as_str().to_owned()).collect()
            };
            let mut items = Vec::new();
            for locale in locales { items.extend(delivery_blockers(store, project, &locale)?.items); }
            Ok(SourceProjection { items, complete: true })
        }
        _ => Err(failure(ErrorCode::InvalidInput, "decision-source")),
    }
}

fn source_mapping(
    store: &ProjectStore,
    c: &Connection,
    project: ExecutionId,
) -> Result<SourceProjection, ExecutionError> {
    let scope = store.content_scope()?;
    let Some(snapshot) = scope.current_snapshot else {
        return Ok(SourceProjection { items: Vec::new(), complete: true });
    };
    let unresolved = super::super::content::maintenance::unresolved_occurrences_in(c, snapshot, SOURCE_LIMIT + 1)?;
    if unresolved.is_empty() {
        return Ok(SourceProjection { items: Vec::new(), complete: true });
    }
    // This source owner verifies immutable capture, receipt and lineage evidence.
    let (_, (input, result, _, mut rows)) = super::super::content::snapshot_rows(c, snapshot, true)?;
    super::super::content::lineage_corrections::effective_rows(c,&mut rows)?;
    if input.envelope().project_id != project {
        return Err(failure(ErrorCode::CorruptLedger, "decision-source-project"));
    }
    let action: String = c.query_row(
        "SELECT action_id FROM adoption_receipts WHERE attempt_id=?1",
        [input.envelope().attempt_id.to_string()], |row| row.get(0),
    ).map_err(super::super::ledger::sql_error)?;
    let action = id(action)?;
    let complete = unresolved.len() <= SOURCE_LIMIT;
    let current = rows.into_iter().filter_map(|row| row.occurrence_id.map(|id| (id, row)))
        .collect::<BTreeMap<_, _>>();
    let mut items = Vec::new();
    for (occurrence, _) in unresolved.into_iter().take(SOURCE_LIMIT) {
        let row = current.get(&occurrence)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "decision-source-occurrence"))?;
        let unit = row.unit_id
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "decision-source-unit"))?;
        items.push(DecisionItem {
            decision_id: format!("source-mapping:{occurrence}"),
            source: DecisionSource::SourceMapping,
            state: DecisionState::Pending,
            locale: None,
            targets: vec![DecisionTarget::SourceOccurrence { snapshot_id: snapshot, occurrence_id: occurrence },
                DecisionTarget::Entry { unit_id: unit }],
            targets_complete: true,
            basis: basis(&(scope.clone(), occurrence, row.source_revision_id, result.digest(), action))?,
            source_action_id: Some(action),
            evidence: None,
            action: DecisionAction::ResolveSourceMapping { snapshot_id: snapshot, occurrence_id: occurrence, ordinal: row.occurrence.ordinal },
        });
    }
    Ok(SourceProjection { items, complete })
}

fn execution_unknown(
    store: &ProjectStore,
    c: &Connection,
    project: ExecutionId,
    locale: Option<&str>,
    active: &impl Fn(ExecutionId) -> bool,
) -> Result<SourceProjection, ExecutionError> {
    // Include dispatched records: the original detail projects them to unknown
    // only when the actual Host runtime no longer owns an active worker.
    let mut statement = c.prepare(
        "SELECT a.attempt_id,i.item_id FROM execution_attempts a
         JOIN execution_tasks t ON t.task_id=a.task_id
         JOIN execution_items i ON i.attempt_id=a.attempt_id
         WHERE t.project_id=?1 AND i.execution IN ('unknown','dispatched')
         ORDER BY a.sequence,i.item_id LIMIT ?2",
    ).map_err(super::super::ledger::sql_error)?;
    let candidates = statement.query_map(params![project.to_string(), (SOURCE_LIMIT + 1) as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(super::super::ledger::sql_error)?
        .map(|row| { let (attempt, item) = row.map_err(super::super::ledger::sql_error)?;
            Ok((id(attempt)?, id(item)?)) })
        .collect::<Result<Vec<_>, ExecutionError>>()?;
    let complete = candidates.len() <= SOURCE_LIMIT;
    let mut attempts: BTreeMap<ExecutionId, BTreeSet<ExecutionId>> = BTreeMap::new();
    for (attempt, item) in candidates.into_iter().take(SOURCE_LIMIT) {
        attempts.entry(attempt).or_default().insert(item);
    }
    let mut items = Vec::new();
    for (attempt, mut wanted) in attempts {
        let input = store.execution_input(attempt)?;
        if input.envelope().project_id != project {
            return Err(failure(ErrorCode::CorruptLedger, "decision-execution-project"));
        }
        let running = active(attempt);
        let mut offset = 0;
        loop {
            let detail = store.execution_attempt_detail(attempt, running, offset, 100)?;
            for row in detail.items {
                if !wanted.remove(&row.status.item_id)
                    || row.status.execution != ExecutionState::Unknown
                    || locale.is_some_and(|locale| row.scope.locale.as_deref()
                        .is_some_and(|value| value != locale)) {
                    continue;
                }
                let mut targets = Vec::new();
                if row.scope.kind == "translation-unit" {
                    let unit = id(row.scope.id.clone())?;
                    if !super::super::content::unit_owned_by_project(c, project, unit)? {
                        return Err(failure(ErrorCode::CorruptLedger, "decision-execution-unit"));
                    }
                    targets.push(DecisionTarget::Entry { unit_id: unit });
                }
                if let Some(lease) = input.envelope().automation {
                    targets.push(DecisionTarget::Plan { plan_id: lease.plan_id });
                }
                if targets.is_empty() { targets.push(DecisionTarget::Project); }
                let recovery = detail.recovery.units.iter()
                    .find(|unit| unit.item_ids.contains(&row.status.item_id))
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "decision-execution-recovery"))?;
                items.push(DecisionItem {
                    decision_id: format!("execution-unknown:{attempt}:{}", row.status.item_id),
                    source: DecisionSource::ExecutionUnknown,
                    state: DecisionState::AwaitingRecheck,
                    locale: row.scope.locale.clone(),
                    targets,
                    targets_complete: true,
                    basis: basis(&(input.digest(), running, &row, recovery))?,
                    source_action_id: None,
                    evidence: None,
                    action: DecisionAction::InspectExecution { task_id: detail.task_id,
                        attempt_id: attempt, item_id: row.status.item_id },
                });
            }
            if wanted.is_empty() { break; }
            match detail.next_offset { Some(next) => offset = next, None => break }
        }
    }
    Ok(SourceProjection { items, complete })
}

fn delivery_blockers(
    store: &ProjectStore,
    project: ExecutionId,
    locale: &str,
) -> Result<SourceProjection, ExecutionError> {
    let eligibility = store.review_eligibility(project, &[locale.to_owned()])?;
    let current = eligibility.locales.iter().find(|value| value.locale == locale)
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "decision-eligibility-locale"))?;
    if current.ready {
        return Ok(SourceProjection { items: Vec::new(), complete: true });
    }
    let units = current.blockers.iter().map(|reason| reason.unit_id).collect::<BTreeSet<_>>();
    let mut targets = vec![DecisionTarget::Project];
    targets.extend(units.into_iter().map(|unit_id| DecisionTarget::Entry { unit_id }));
    Ok(SourceProjection { items: vec![DecisionItem {
        decision_id: format!("delivery-blocker:{project}:{locale}"),
        source: DecisionSource::DeliveryBlocker,
        state: DecisionState::Pending,
        locale: Some(locale.to_owned()),
        targets,
        targets_complete: current.blockers.len() == current.blocker_count as usize,
        basis: basis(&(eligibility.policy_version.as_str(), eligibility.source_snapshot_id,
            eligibility.basis.as_str(), current))?,
        source_action_id: None,
        evidence: Some(DecisionEvidence::Delivery { blocker_count: current.blocker_count,
            reasons: current.blockers.clone(),
            reasons_complete: current.blockers.len() == current.blocker_count as usize }),
        action: DecisionAction::InspectDelivery { locale: locale.to_owned() },
    }], complete: true })
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
