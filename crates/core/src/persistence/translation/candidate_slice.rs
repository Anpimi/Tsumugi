//! Current-source proposals over explicit or retained read membership. This is
//! an observation, never selection authority or a second candidate ledger.
use super::*;
use crate::{ReviewTarget, application::WorkProtection};
use std::collections::BTreeMap;

const RECORDS: usize = 50;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TranslationCandidateState { Available, Rejected }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationCandidateSliceNext {
    pub unit_offset: u32,
    pub after_ordinal: Revision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationCandidateSliceRow {
    pub target: ReviewTarget,
    pub selected_origin_kind: Option<TranslationOrigin>,
    pub protection: WorkProtection,
    /// Full count before the first member's continuation ordinal is applied.
    pub candidate_count: u32,
    pub revisions: Vec<TranslationRevision>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationCandidateSlice {
    pub project_id: ExecutionId,
    pub locale: String,
    pub source_snapshot_id: ExecutionId,
    pub scope_id: Option<ExecutionId>,
    pub read_version: String,
    pub rows: Vec<TranslationCandidateSliceRow>,
    pub next: Option<TranslationCandidateSliceNext>,
}

struct CandidateRef {
    unit: ExecutionId,
    revision: ExecutionId,
    ordinal: u64,
    decision: Option<CandidateDecision>,
}

fn origins_in(c: &Connection, project: ExecutionId, locale: &str, targets: &[ReviewTarget]) -> Result<BTreeMap<ExecutionId, Option<TranslationOrigin>>, ExecutionError> {
    let wanted = serde_json::to_string(&targets.iter().map(|target| (target.unit_id, target.revision_id)).collect::<Vec<_>>())
        .map_err(|_| error(ErrorCode::InvalidInput, "candidate-slice-units"))?;
    let mut statement = c.prepare("WITH wanted AS (SELECT json_extract(value,'$[0]') unit_id,json_extract(value,'$[1]') revision_id FROM json_each(?3))
        SELECT w.unit_id,w.revision_id,r.revision_id,r.origin_kind FROM wanted w
        LEFT JOIN translation_revisions r ON r.revision_id=w.revision_id AND r.project_id=?1 AND r.unit_id=w.unit_id AND r.locale=?2").map_err(super::super::ledger::sql_error)?;
    let rows = statement.query_map(params![project.to_string(), locale, wanted], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?))).map_err(super::super::ledger::sql_error)?;
    let mut result = BTreeMap::new();
    for row in rows {
        let (unit, expected, actual, origin) = row.map_err(super::super::ledger::sql_error)?;
        if expected != actual || actual.is_some() != origin.is_some() { return Err(error(ErrorCode::CorruptLedger, "candidate-slice-selection")); }
        result.insert(id(unit)?, origin.map(|raw| TranslationOrigin::from_stored(&raw)).transpose()?);
    }
    Ok(result)
}

/// Count all current proposals, but retain at most one page plus a lookahead.
/// Only latest original decision receipts are streamed; history bodies are not.
fn candidates_in(c: &Connection, project: ExecutionId, locale: &str, targets: &[ReviewTarget], state: TranslationCandidateState, after: u64, record_limit: usize)
    -> Result<(BTreeMap<ExecutionId, (u32, u32)>, Vec<CandidateRef>), ExecutionError> {
    let wanted = serde_json::to_string(&targets.iter().map(|target| (target.unit_id, target.source_revision_id, target.revision_id)).collect::<Vec<_>>())
        .map_err(|_| error(ErrorCode::InvalidInput, "candidate-slice-units"))?;
    let mut statement = c.prepare("WITH wanted AS MATERIALIZED (SELECT CAST(key AS INTEGER) position,json_extract(value,'$[0]') unit_id,json_extract(value,'$[1]') source_revision_id,json_extract(value,'$[2]') selected_revision_id FROM json_each(?3))
        SELECT w.position,r.unit_id,r.revision_id,r.source_revision_id,r.ordinal,d.action_id,
               d.revision_id,d.source_snapshot_id,d.request,d.request_digest,d.receipt,d.receipt_digest
        FROM wanted w JOIN translation_revisions r ON r.unit_id=w.unit_id AND r.project_id=?1 AND r.locale=?2
          AND r.source_revision_id=w.source_revision_id AND r.origin_kind='ai' AND r.revision_id IS NOT w.selected_revision_id
        LEFT JOIN translation_candidate_decisions d ON d.revision_id=r.revision_id
          AND d.rowid=(SELECT latest.rowid FROM translation_candidate_decisions latest WHERE latest.revision_id=r.revision_id ORDER BY latest.rowid DESC LIMIT 1)
        ORDER BY w.position,r.ordinal").map_err(super::super::ledger::sql_error)?;
    let rows = statement.query_map(params![project.to_string(), locale, wanted], |row| {
        let action = row.get::<_,Option<String>>(5)?;
        let decision = action.map(|action| candidates::StoredDecision::from_row(row, 6).map(|value| (action,value))).transpose()?;
        Ok((row.get::<_,i64>(0)?, row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,i64>(4)?,decision))
    }).map_err(super::super::ledger::sql_error)?;
    let mut counts = targets.iter().map(|target| (target.unit_id, (0u32,0u32))).collect::<BTreeMap<_,_>>();
    let mut references = Vec::new();
    for row in rows {
        let (position, unit, revision, source, ordinal, decision) = row.map_err(super::super::ledger::sql_error)?;
        let (unit, revision, source) = (id(unit)?,id(revision)?,id(source)?);
        let ordinal = u64::try_from(ordinal).ok().filter(|value| *value > 0).ok_or_else(|| error(ErrorCode::CorruptLedger,"candidate-slice-ordinal"))?;
        let decision = decision.map(|(action, raw)| raw.decode(id(action)?)).transpose()?;
        if decision.as_ref().is_some_and(|value| value.request.project_id != project || value.request.unit_id != unit
            || value.request.locale != locale || value.request.revision_id != revision || value.request.source_revision_id != source) {
            return Err(error(ErrorCode::CorruptLedger,"candidate-slice-decision"));
        }
        let rejected = decision.as_ref().is_some_and(|value| value.request.disposition == CandidateDisposition::Rejected);
        if rejected != (state == TranslationCandidateState::Rejected) { continue; }
        let (total, remaining) = counts.get_mut(&unit).ok_or_else(|| error(ErrorCode::CorruptLedger,"candidate-slice-unit"))?;
        *total = total.checked_add(1).ok_or_else(|| error(ErrorCode::LimitExceeded,"candidate-slice-count"))?;
        if position == 0 && ordinal <= after { continue; }
        *remaining = remaining.checked_add(1).ok_or_else(|| error(ErrorCode::LimitExceeded,"candidate-slice-count"))?;
        if references.len() <= record_limit { references.push(CandidateRef { unit, revision, ordinal, decision }); }
    }
    Ok((counts,references))
}

/// Lightweight references for the decision read model. The candidate owner
/// applies exactly the same current-source and latest-disposition rules as the
/// comparison slice, without loading revision bodies or changing selection.
pub(in crate::persistence) struct PendingTranslationCandidate {
    pub unit_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub ordinal: u64,
    pub action_id: ExecutionId,
    pub decision: Option<CandidateDecision>,
}

pub(in crate::persistence) fn pending_candidates_in(
    c: &Connection,
    project: ExecutionId,
    locale: &str,
    targets: &[ReviewTarget],
    limit: usize,
) -> Result<(Vec<PendingTranslationCandidate>, bool), ExecutionError> {
    let (counts, mut references) = candidates_in(
        c, project, locale, targets, TranslationCandidateState::Available, 0, limit,
    )?;
    let total: u64 = counts.values().map(|(total, _)| u64::from(*total)).sum();
    let complete = total <= limit as u64;
    references.truncate(limit);
    let wanted = serde_json::to_string(&references.iter().map(|value| value.revision).collect::<Vec<_>>())
        .map_err(|_| error(ErrorCode::InvalidInput, "candidate-decision-units"))?;
    let mut statement = c.prepare("SELECT r.revision_id,r.action_id FROM json_each(?2) w
        JOIN translation_revisions r ON r.revision_id=w.value AND r.project_id=?1")
        .map_err(super::super::ledger::sql_error)?;
    let actions = statement.query_map(params![project.to_string(), wanted], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(super::super::ledger::sql_error)?
        .map(|row| {
            let (revision, action) = row.map_err(super::super::ledger::sql_error)?;
            Ok((id(revision)?, id(action)?))
        }).collect::<Result<BTreeMap<_, _>, ExecutionError>>()?;
    let rows = references.into_iter().map(|value| {
        Ok(PendingTranslationCandidate {
            unit_id: value.unit,
            revision_id: value.revision,
            ordinal: value.ordinal,
            action_id: *actions.get(&value.revision)
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "candidate-decision-revision"))?,
            decision: value.decision,
        })
    }).collect::<Result<Vec<_>, ExecutionError>>()?;
    Ok((rows, complete))
}

fn bodies_in(c: &Connection, project: ExecutionId, references: &[CandidateRef]) -> Result<BTreeMap<ExecutionId, TranslationRevision>, ExecutionError> {
    let wanted = serde_json::to_string(&references.iter().map(|value| value.revision).collect::<Vec<_>>())
        .map_err(|_| error(ErrorCode::InvalidInput,"candidate-slice-revisions"))?;
    let mut statement = c.prepare("SELECT r.revision_id,r.unit_id,r.locale,r.ordinal,r.text,r.source_snapshot_id,r.source_revision_id,
        r.origin_kind,r.action_id,r.attempt_id,r.result_id,r.item_id,r.artifact_id,r.logical_path,r.declared_locale,r.native_key,r.file_digest
        FROM json_each(?2) w JOIN translation_revisions r ON r.revision_id=w.value AND r.project_id=?1").map_err(super::super::ledger::sql_error)?;
    let rows = statement.query_map(params![project.to_string(), &wanted], RawRevision::from_row).map_err(super::super::ledger::sql_error)?;
    let mut bodies = BTreeMap::new();
    for row in rows { let revision = row.map_err(super::super::ledger::sql_error)?.parse()?; bodies.insert(revision.revision_id, revision); }
    let mut statement = c.prepare("SELECT r.revision_id,r.parent_revision_id FROM json_each(?1) w JOIN translation_contributors r ON r.revision_id=w.value ORDER BY r.revision_id,r.ordinal").map_err(super::super::ledger::sql_error)?;
    let rows = statement.query_map([&wanted], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(super::super::ledger::sql_error)?;
    for row in rows { let (revision, parent) = row.map_err(super::super::ledger::sql_error)?; bodies.get_mut(&id(revision)?).ok_or_else(|| error(ErrorCode::CorruptLedger,"candidate-slice-contributors"))?.contributors.push(id(parent)?); }
    for reference in references {
        let body = bodies.get_mut(&reference.revision).ok_or_else(|| error(ErrorCode::CorruptLedger,"candidate-slice-revision"))?;
        if body.unit_id != reference.unit || body.ordinal != reference.ordinal || body.origin_kind != TranslationOrigin::Ai { return Err(error(ErrorCode::CorruptLedger,"candidate-slice-revision")); }
        body.candidate_decision = reference.decision.clone();
    }
    Ok(bodies)
}

impl ProjectStore {
    pub fn translation_candidate_slice(&self, project: ExecutionId, locale: &str, snapshot: ExecutionId, scope: Option<ExecutionId>,
        units: &[ExecutionId], state: TranslationCandidateState, after: u64, expected_version: Option<&str>) -> Result<TranslationCandidateSlice, ExecutionError> {
        if units.is_empty() || units.len() > RECORDS || units.iter().collect::<BTreeSet<_>>().len() != units.len() || after > i64::MAX as u64
            || expected_version.is_some_and(|value| value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())) {
            return Err(error(ErrorCode::InvalidInput,"candidate-slice-input"));
        }
        let c = self.connection().map_err(|_| error(ErrorCode::StorageFailed,"translation-read"))?;
        super::super::review::read_snapshot(c, |c| {
            let targets = super::super::review::targets_in(c, project, units, locale)?;
            if targets.iter().any(|target| target.source_snapshot_id != snapshot) { return Err(error(ErrorCode::DependencyConflict,"candidate-slice-source")); }
            if let Some(scope) = scope { self.check_review_membership(c, project, locale, scope, snapshot, units)?; }
            let changes = self.changes_since(Revision::new(0)?);
            let external: i64 = c.query_row("PRAGMA data_version", [], |row| row.get(0)).map_err(super::super::ledger::sql_error)?;
            let version = request_digest(&(project,locale,snapshot,changes.epoch,changes.sequence,external))?;
            if expected_version.is_some_and(|expected| expected != version) { return Err(error(ErrorCode::DependencyConflict,"candidate-slice-changed")); }
            let mut origins = origins_in(c, project, locale, &targets)?;
            let mut protections = super::super::application::protection_summaries(c, project, units, locale)?;
            let (counts,references) = candidates_in(c, project, locale, &targets, state, after, RECORDS)?;
            let mut bodies = bodies_in(c, project, &references)?;
            let mut page = TranslationCandidateSlice { project_id: project, locale: locale.into(), source_snapshot_id: snapshot, scope_id: scope,
                read_version: version, rows: Vec::new(), next: None };
            let cursor = |index: usize, ordinal: u64| -> Result<TranslationCandidateSliceNext, ExecutionError> {
                Ok(TranslationCandidateSliceNext { unit_offset: index as u32, after_ordinal: Revision::new(ordinal)? })
            };
            let fits = |page: &TranslationCandidateSlice| codec::encode(page, crate::content::MAX_CONTENT_PAGE_BYTES).is_ok();
            let mut records = 0usize;
            'units: for (index,target) in targets.into_iter().enumerate() {
                let unit = target.unit_id;
                let start = if index == 0 { after } else { 0 };
                if records == RECORDS { page.next = Some(cursor(index,start)?); break; }
                let (total, remaining) = counts[&unit];
                let row = TranslationCandidateSliceRow { target, selected_origin_kind: origins.remove(&unit).ok_or_else(|| error(ErrorCode::CorruptLedger,"candidate-slice-selection"))?,
                    protection: protections.remove(&unit).ok_or_else(|| error(ErrorCode::CorruptLedger,"candidate-slice-protection"))?, candidate_count: total, revisions: Vec::new() };
                page.rows.push(row);
                if remaining == 0 {
                    page.next = if index + 1 < units.len() { Some(cursor(index+1,0)?) } else { None };
                    if !fits(&page) { page.rows.pop(); page.next = Some(cursor(index,start)?); break; }
                    records += 1;
                    continue;
                }
                let mut consumed = 0u32;
                for reference in references.iter().filter(|reference| reference.unit == unit) {
                    page.rows.last_mut().unwrap().revisions.push(bodies.remove(&reference.revision).ok_or_else(|| error(ErrorCode::CorruptLedger,"candidate-slice-revision"))?);
                    let complete = consumed + 1 == remaining;
                    page.next = if complete { if index + 1 < units.len() { Some(cursor(index+1,0)?) } else { None } } else { Some(cursor(index,reference.ordinal)?) };
                    if !fits(&page) {
                        let row = page.rows.last_mut().unwrap(); row.revisions.pop();
                        let last = row.revisions.last().map(|value| value.ordinal).unwrap_or(start);
                        if row.revisions.is_empty() { page.rows.pop(); }
                        page.next = Some(cursor(index,last)?); break 'units;
                    }
                    consumed += 1; records += 1;
                    if complete { break; }
                    if records == RECORDS { break 'units; }
                }
                if consumed < remaining { break; }
            }
            if page.rows.is_empty() { return Err(error(ErrorCode::LimitExceeded,"candidate-slice-page-bytes")); }
            codec::encode(&page, crate::content::MAX_CONTENT_PAGE_BYTES)?;
            Ok(page)
        })
    }
}
