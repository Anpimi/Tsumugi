//! Content decisions remain observations of the original translation, review,
//! and resource authorities. Every action opens that owner's checked reader.
use super::*;
use crate::persistence::{resources, translation};
use crate::{ReviewDecisionKind, ReviewFindingDisposition, ReviewRepairStatus, ReviewTarget};
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeMap;

fn basis(value: &impl Serialize) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(value, crate::execution::MAX_INPUT_BYTES)?))
}

fn identity(raw: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&raw)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "decision-content-identity"))
}

/// Cap membership as well as returned rows. Unvisited current units are explicit
/// partial coverage, including when the visited prefix has no pending items.
fn units_in(c: &Connection, project: ExecutionId) -> Result<(Vec<ExecutionId>, bool), ExecutionError> {
    let mut statement = c.prepare(
        "SELECT o.unit_id FROM source_occurrences o
         JOIN content_scope scope ON scope.current_snapshot=o.snapshot_id
         JOIN source_units u ON u.unit_id=o.unit_id AND u.project_id=?1
         GROUP BY o.unit_id ORDER BY MIN(o.ordinal) LIMIT ?2",
    ).map_err(super::super::ledger::sql_error)?;
    let mut units = statement.query_map(params![project.to_string(), (SOURCE_LIMIT + 1) as i64], |row| {
        row.get::<_, String>(0)
    }).map_err(super::super::ledger::sql_error)?
        .map(|row| identity(row.map_err(super::super::ledger::sql_error)?))
        .collect::<Result<Vec<_>, _>>()?;
    let complete = units.len() <= SOURCE_LIMIT;
    units.truncate(SOURCE_LIMIT);
    Ok((units, complete))
}

fn selection_action(c: &Connection, project: ExecutionId, target: &ReviewTarget) -> Result<Option<ExecutionId>, ExecutionError> {
    let Some(selection) = target.selection_id else { return Ok(None); };
    let raw: Option<String> = c.query_row(
        "SELECT action_id FROM translation_selections
         WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND event_id=?4",
        params![project.to_string(), target.unit_id.to_string(), target.locale, selection.to_string()],
        |row| row.get(0),
    ).optional().map_err(super::super::ledger::sql_error)?;
    raw.ok_or_else(|| failure(ErrorCode::CorruptLedger, "decision-selection"))
        .and_then(identity).map(Some)
}

fn candidates(c: &Connection, project: ExecutionId, locale: &str) -> Result<SourceProjection, ExecutionError> {
    let (units, mut complete) = units_in(c, project)?;
    let mut items = Vec::new();
    for units in units.chunks(100) {
        let targets = review::targets_in(c, project, units, locale)?;
        let (candidates, batch_complete) = translation::pending_candidates_in(
            c, project, locale, &targets, SOURCE_LIMIT - items.len(),
        )?;
        complete &= batch_complete;
        let targets = targets.iter().map(|target| (target.unit_id, target)).collect::<BTreeMap<_, _>>();
        for candidate in candidates {
            let target = targets.get(&candidate.unit_id)
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "decision-candidate-target"))?;
            items.push(DecisionItem {
                decision_id: format!("translation-candidate:{}:{locale}", candidate.revision_id),
                source: DecisionSource::TranslationCandidate,
                state: DecisionState::Pending,
                locale: Some(locale.into()),
                targets: vec![DecisionTarget::Entry { unit_id: candidate.unit_id }],
                targets_complete: true,
                basis: basis(&(project, locale, &target.basis, target.selection_id,
                    candidate.revision_id, candidate.ordinal,
                    candidate.decision.as_ref().map(|value| value.request.action_id)))?,
                source_action_id: Some(candidate.action_id),
                action: DecisionAction::CompareCandidate { unit_id: candidate.unit_id,
                    revision_id: candidate.revision_id, source_snapshot_id: target.source_snapshot_id,
                    source_revision_id: target.source_revision_id },
                evidence: None,
            });
        }
    }
    Ok(SourceProjection { items, complete })
}

fn human_review(c: &Connection, project: ExecutionId, locale: &str) -> Result<SourceProjection, ExecutionError> {
    let (units, complete) = units_in(c, project)?;
    let mut items = Vec::new();
    for units in units.chunks(100) {
        for target in review::targets_in(c, project, units, locale)? {
            let (Some(selection_id), Some(revision_id)) = (target.selection_id, target.revision_id) else { continue; };
            if target.current_decision.as_ref().is_some_and(|decision| decision.kind == ReviewDecisionKind::Approve) { continue; }
            let source_action_id = match &target.current_decision {
                Some(decision) => Some(decision.action_id),
                None => selection_action(c, project, &target)?,
            };
            items.push(DecisionItem {
                decision_id: format!("human-review:{}:{locale}", target.unit_id),
                source: DecisionSource::HumanReview,
                state: DecisionState::Pending,
                locale: Some(locale.into()),
                targets: vec![DecisionTarget::Entry { unit_id: target.unit_id }],
                targets_complete: true,
                basis: basis(&(project, locale, &target.basis, selection_id, revision_id,
                    target.current_decision.as_ref().map(|decision| decision.decision_id)))?,
                source_action_id,
                action: DecisionAction::ReviewTranslation { unit_id: target.unit_id, selection_id, revision_id },
                evidence: None,
            });
        }
    }
    Ok(SourceProjection { items, complete })
}

fn resource_proposals(store: &ProjectStore, c: &Connection, project: ExecutionId, locale: &str) -> Result<SourceProjection, ExecutionError> {
    let (captures, mut complete) = resources::decision_capture_refs_in(c, project, locale, SOURCE_LIMIT)?;
    let mut items = Vec::new();
    for (capture_id, action_id) in captures {
        let preview = store.glossary_preview(project, capture_id)?;
        if preview.capture.target_locale != locale {
            return Err(failure(ErrorCode::CorruptLedger, "decision-resource-locale"));
        }
        let current = preview.correction.as_ref().map(|value| value.evidence.current)
            .or_else(|| preview.mcp.as_ref().map(|value| value.current)).unwrap_or(true);
        let state = if current { DecisionState::Pending } else { DecisionState::Stale };
        let mut proposals = preview.rows.into_iter().filter(|row| row.kind != resources::ResourceChangeKind::Unchanged)
            .map(|row| (row.entry.id, row.scope_unit_id, row.current.map(|term| term.revision_id)))
            .collect::<Vec<_>>();
        for term in preview.removed {
            let entry = term.external_entry_id.clone()
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "decision-resource-entry"))?;
            proposals.push((entry, term.scope_unit_id, Some(term.revision_id)));
        }
        for (entry_id, unit, revision) in proposals {
            if resources::entry_decision_in(c, project, capture_id, &entry_id)?.is_some() { continue; }
            if items.len() == SOURCE_LIMIT {
                complete = false;
                return Ok(SourceProjection { items, complete });
            }
            let mut targets = vec![DecisionTarget::Resource { capture_id, entry_id: entry_id.clone() }];
            if let Some(unit_id) = unit { targets.push(DecisionTarget::Entry { unit_id }); }
            items.push(DecisionItem {
                decision_id: format!("resource-proposal:{capture_id}:{entry_id}:{locale}"),
                source: DecisionSource::ResourceProposal,
                state,
                locale: Some(locale.into()),
                targets,
                targets_complete: true,
                basis: basis(&(project, locale, &preview.capture, &entry_id, revision, current))?,
                source_action_id: Some(action_id),
                action: DecisionAction::ReviewResource { capture_id, entry_id },
                evidence: None,
            });
        }
    }
    Ok(SourceProjection { items, complete })
}

fn finding_identity(unit: ExecutionId, locale: &str, purpose: crate::ai::semantic_review::ReviewRunPurpose, issue: &str) -> String {
    let purpose = match purpose {
        crate::ai::semantic_review::ReviewRunPurpose::Qa => "qa",
        crate::ai::semantic_review::ReviewRunPurpose::AiSemantic => "ai-semantic",
    };
    format!("review-finding:{purpose}:{unit}:{issue}:{locale}")
}

fn finding_item(project: ExecutionId, unit: ExecutionId, locale: &str, target_basis: &str, finding: &crate::AdvisoryFinding) -> Result<DecisionItem, ExecutionError> {
    let decision = finding.decision.as_ref();
    Ok(DecisionItem {
        decision_id: finding_identity(unit, locale, finding.purpose, &finding.finding.issue_id),
        source: DecisionSource::ReviewFinding,
        state: if decision.is_some_and(|decision| decision.request.disposition == ReviewFindingDisposition::RepairRequested) {
            DecisionState::AwaitingRecheck
        } else { DecisionState::Pending },
        locale: Some(locale.into()),
        targets: vec![DecisionTarget::Entry { unit_id: unit }],
        targets_complete: true,
        basis: basis(&(project, locale, target_basis, finding.run_id, &finding.requirement,
            &finding.finding, decision.map(|decision| decision.decision_id)))?,
        source_action_id: decision.map(|decision| decision.request.action_id),
        action: DecisionAction::ReviewFinding { unit_id: unit, run_id: finding.run_id, issue_id: finding.finding.issue_id.clone() },
        evidence: None,
    })
}

fn review_findings(store: &ProjectStore, c: &Connection, project: ExecutionId, locale: &str) -> Result<SourceProjection, ExecutionError> {
    let (units, mut complete) = units_in(c, project)?;
    let mut items = BTreeMap::new();
    let mut visited = 0usize;
    for (unit_index, unit) in units.iter().copied().enumerate() {
        let mut offset = 0;
        loop {
            let limit = (SOURCE_LIMIT - visited).min(50) as u32;
            let page = store.review_findings(project, unit, locale, offset, limit)?;
            visited += page.findings.len().max(page.history.len());
            for finding in &page.findings {
                if finding.decision.as_ref().is_some_and(|decision| decision.request.disposition == ReviewFindingDisposition::Rejected) { continue; }
                let mut item = finding_item(project, unit, locale, &page.basis, finding)?;
                if item.source_action_id.is_none() {
                    let raw: String = c.query_row("SELECT action_id FROM review_checks WHERE project_id=?1 AND run_id=?2",
                        params![project.to_string(), finding.run_id.to_string()], |row| row.get(0))
                        .map_err(super::super::ledger::sql_error)?;
                    item.source_action_id = Some(identity(raw)?);
                }
                items.insert(item.decision_id.clone(), item);
            }
            for repair in page.repairs {
                let decision = &repair.decision;
                let key = finding_identity(unit, locale, decision.purpose, &decision.request.issue_id);
                match repair.status {
                    ReviewRepairStatus::CurrentRuleClear | ReviewRepairStatus::Superseded => continue,
                    ReviewRepairStatus::AwaitingCurrentRecheck | ReviewRepairStatus::CurrentRuleFindings => {}
                }
                let item = DecisionItem {
                    decision_id: key.clone(), source: DecisionSource::ReviewFinding,
                    state: if repair.status == ReviewRepairStatus::AwaitingCurrentRecheck { DecisionState::AwaitingRecheck } else { DecisionState::Pending },
                    locale: Some(locale.into()), targets: vec![DecisionTarget::Entry { unit_id: unit }], targets_complete: true,
                    basis: basis(&(project, locale, &page.basis, decision.decision_id, &repair.status, repair.recheck_run_id))?,
                    source_action_id: Some(decision.request.action_id),
                    action: DecisionAction::ReviewFinding { unit_id: unit, run_id: repair.recheck_run_id.unwrap_or(decision.request.run_id), issue_id: decision.request.issue_id.clone() },
                    evidence: None,
                };
                items.insert(key, item);
            }
            if items.len() > SOURCE_LIMIT || visited >= SOURCE_LIMIT && (page.next_offset.is_some() || unit_index + 1 < units.len()) {
                complete = false;
                let items = items.into_values().take(SOURCE_LIMIT).collect();
                return Ok(SourceProjection { items, complete });
            }
            match page.next_offset { Some(next) => offset = next, None => break }
        }
    }
    Ok(SourceProjection { items: items.into_values().collect(), complete })
}

#[cfg(test)]
mod tests;

pub(super) fn project(store: &ProjectStore, c: &Connection, project: ExecutionId, locale: &str, source: DecisionSource) -> Result<SourceProjection, ExecutionError> {
    let metadata = super::super::read_metadata_from(c)
        .map_err(|_| failure(ErrorCode::StorageFailed, "decision-content-project"))?;
    if metadata.project_id().to_string() != project.to_string()
        || !metadata.target_locales().iter().any(|target| target.as_str() == locale) {
        return Err(failure(ErrorCode::DependencyConflict, "decision-content-locale"));
    }
    match source {
        DecisionSource::TranslationCandidate => candidates(c, project, locale),
        DecisionSource::ResourceProposal => resource_proposals(store, c, project, locale),
        DecisionSource::HumanReview => human_review(c, project, locale),
        DecisionSource::ReviewFinding => review_findings(store, c, project, locale),
        _ => Err(failure(ErrorCode::InvalidInput, "decision-content-source")),
    }
}
