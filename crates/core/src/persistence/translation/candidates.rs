//! Human decisions on a saved AI proposal are independent of selection and approval.
use super::*;

pub(super) const TABLE: (&str, &str) = (
    "translation_candidate_decisions",
    "CREATE TABLE translation_candidate_decisions (action_id TEXT PRIMARY KEY NOT NULL, revision_id TEXT NOT NULL REFERENCES translation_revisions(revision_id), source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id), request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 1048576), request_digest TEXT NOT NULL CHECK(length(request_digest)=64), receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 1048576), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64))",
);
const REVISION_INDEX: &str = "translation_candidate_revision";
const CREATE_REVISION_INDEX: &str = "CREATE INDEX translation_candidate_revision ON translation_candidate_decisions (revision_id)";

pub(super) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    // SQLite indexes retain rowid order within each revision, so the latest
    // decision lookup needs neither a full history scan nor a temporary sort.
    c.execute_batch(CREATE_REVISION_INDEX)
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CandidateDisposition {
    Rejected,
    Restored,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateDecisionWrite {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub revision_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub expected_selection_id: Option<ExecutionId>,
    pub expected_decision_id: Option<ExecutionId>,
    pub disposition: CandidateDisposition,
    pub actor: String,
    pub reason: String,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateDecision {
    pub request: CandidateDecisionWrite,
    pub source_snapshot_id: ExecutionId,
}
fn valid(request: &CandidateDecisionWrite) -> bool {
    let locale = crate::Locale::parse(&request.locale).ok();
    locale.as_ref().map(crate::Locale::as_str) == Some(request.locale.as_str())
        && !request.actor.trim().is_empty()
        && request.actor == request.actor.trim()
        && request.actor.len() <= 512
        && !request.reason.trim().is_empty()
        && request.reason == request.reason.trim()
        && request.reason.len() <= 4096
}
pub(super) struct StoredDecision {
    revision: String,
    snapshot: String,
    request: Vec<u8>,
    request_digest: String,
    receipt: Vec<u8>,
    receipt_digest: String,
}
impl StoredDecision {
    pub(super) fn from_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Self> {
        Ok(Self {
            revision: row.get(offset)?,
            snapshot: row.get(offset + 1)?,
            request: row.get(offset + 2)?,
            request_digest: row.get(offset + 3)?,
            receipt: row.get(offset + 4)?,
            receipt_digest: row.get(offset + 5)?,
        })
    }

    pub(super) fn decode(self, action: ExecutionId) -> Result<CandidateDecision, ExecutionError> {
        let request: CandidateDecisionWrite = codec::decode(&self.request, MAX_INPUT_BYTES)?;
        let value: CandidateDecision = codec::decode(&self.receipt, MAX_INPUT_BYTES)?;
        if !valid(&request)
            || codec::digest(&self.request) != self.request_digest
            || codec::digest(&self.receipt) != self.receipt_digest
            || request.action_id != action
            || request.revision_id.to_string() != self.revision
            || value.request != request
            || value.source_snapshot_id.to_string() != self.snapshot
        {
            return Err(error(
                ErrorCode::CorruptLedger,
                "candidate-decision-receipt",
            ));
        }
        Ok(value)
    }
}
fn load(c: &Connection, action: ExecutionId) -> Result<Option<CandidateDecision>, ExecutionError> {
    c.query_row(
        "SELECT revision_id,source_snapshot_id,request,request_digest,receipt,receipt_digest FROM translation_candidate_decisions WHERE action_id=?1",
        [action.to_string()], |row| StoredDecision::from_row(row, 0),
    ).optional().map_err(super::super::ledger::sql_error)?
        .map(|raw| raw.decode(action)).transpose()
}
pub(super) fn latest(
    c: &Connection,
    revision: ExecutionId,
) -> Result<Option<CandidateDecision>, ExecutionError> {
    let action: Option<String> = c.query_row("SELECT action_id FROM translation_candidate_decisions WHERE revision_id=?1 ORDER BY rowid DESC LIMIT 1", [revision.to_string()], |r|r.get(0))
        .optional().map_err(super::super::ledger::sql_error)?;
    action
        .map(|raw| {
            load(c, id(raw)?).and_then(|v| {
                v.ok_or_else(|| error(ErrorCode::CorruptLedger, "candidate-decision"))
            })
        })
        .transpose()
}
pub(in crate::persistence) fn selectable(
    c: &Connection,
    revision: ExecutionId,
) -> Result<(), ExecutionError> {
    if rejected(c, revision)? {
        return Err(error(ErrorCode::DependencyConflict, "candidate-rejected"));
    }
    Ok(())
}
pub(in crate::persistence) fn rejected(c: &Connection, revision: ExecutionId) -> Result<bool, ExecutionError> {
    Ok(latest(c, revision)?.is_some_and(|value| is_rejected(&value)))
}
fn is_rejected(value: &CandidateDecision) -> bool {
    value.request.disposition == CandidateDisposition::Rejected
}

/// Unselected, non-rejected revisions remain candidates even after a source
/// change or an earlier selection. Applicability is a separate observation.
/// Callers keep these reads in the same snapshot as their current row facts.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(in crate::persistence) struct CandidateSummary {
    pub count: u32,
    pub ai_count: u32,
}

pub(in crate::persistence) fn summaries(
    c: &Connection,
    project: ExecutionId,
    units: &[ExecutionId],
    locale: &str,
) -> Result<std::collections::BTreeMap<ExecutionId, CandidateSummary>, ExecutionError> {
    check_target(c, project, locale)?;
    if units.iter().collect::<BTreeSet<_>>().len() != units.len() {
        return Err(error(ErrorCode::InvalidInput, "candidate-summary-units"));
    }
    let wanted = serde_json::to_string(units)
        .map_err(|_| error(ErrorCode::InvalidInput, "candidate-summary-units"))?;
    let project_key = project.to_string();
    let mut statement = c.prepare(
        "WITH wanted AS MATERIALIZED (SELECT value AS unit_id FROM json_each(?2))
         SELECT wanted.unit_id,u.unit_id,COUNT(r.revision_id),
                COALESCE(SUM(CASE WHEN r.origin_kind='ai' THEN 1 ELSE 0 END),0)
         FROM wanted
         LEFT JOIN source_units u ON u.unit_id=wanted.unit_id AND u.project_id=?1
         LEFT JOIN translation_selections s ON s.unit_id=u.unit_id AND s.locale=?3
           AND s.sequence=(SELECT MAX(t.sequence) FROM translation_selections t
                           WHERE t.unit_id=u.unit_id AND t.locale=?3)
         LEFT JOIN translation_revisions r ON r.unit_id=u.unit_id
           AND r.project_id=?1 AND r.locale=?3 AND r.revision_id IS NOT s.revision_id
         GROUP BY wanted.unit_id,u.unit_id",
    ).map_err(super::super::ledger::sql_error)?;
    let rows = statement.query_map(params![project_key, wanted, locale], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
    }).map_err(super::super::ledger::sql_error)?;
    let mut counts = std::collections::BTreeMap::new();
    for row in rows {
        let (unit, owner, count, ai_count) = row.map_err(super::super::ledger::sql_error)?;
        if owner.as_ref() != Some(&unit) {
            return Err(error(ErrorCode::Unauthorized, "candidate-summary-scope"));
        }
        let checked_count = |count| u32::try_from(count)
            .map_err(|_| error(ErrorCode::LimitExceeded, "candidate-summary-count"));
        counts.insert(id(unit)?, CandidateSummary {
            count: checked_count(count)?, ai_count: checked_count(ai_count)?,
        });
    }

    // Only the latest original decision receipts are needed. Do not fetch
    // revision bodies or turn every history row into an individual query.
    let mut statement = c.prepare(
        "WITH wanted AS MATERIALIZED (SELECT value AS unit_id FROM json_each(?2))
         SELECT r.unit_id,r.source_revision_id,r.origin_kind,d.action_id,
                d.revision_id,d.source_snapshot_id,d.request,d.request_digest,d.receipt,d.receipt_digest
         FROM wanted JOIN translation_revisions r ON r.unit_id=wanted.unit_id
           AND r.project_id=?1 AND r.locale=?3
         LEFT JOIN translation_selections s ON s.unit_id=r.unit_id AND s.locale=?3
           AND s.sequence=(SELECT MAX(t.sequence) FROM translation_selections t
                           WHERE t.unit_id=r.unit_id AND t.locale=?3)
         JOIN translation_candidate_decisions d ON d.revision_id=r.revision_id
           AND d.rowid=(SELECT latest.rowid FROM translation_candidate_decisions latest
                        WHERE latest.revision_id=r.revision_id ORDER BY latest.rowid DESC LIMIT 1)
         WHERE r.revision_id IS NOT s.revision_id",
    ).map_err(super::super::ledger::sql_error)?;
    let rows = statement.query_map(params![project_key, wanted, locale], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
            row.get::<_, String>(3)?, StoredDecision::from_row(row, 4)?))
    }).map_err(super::super::ledger::sql_error)?;
    for row in rows {
        let (unit, source, origin, action, raw) = row.map_err(super::super::ledger::sql_error)?;
        let unit = id(unit)?;
        let value = raw.decode(id(action)?)?;
        if value.request.project_id != project || value.request.unit_id != unit
            || value.request.locale != locale || value.request.source_revision_id != id(source)?
            || origin != "ai"
        {
            return Err(error(ErrorCode::CorruptLedger, "candidate-summary-decision"));
        }
        if is_rejected(&value) {
            let count = counts.get_mut(&unit)
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "candidate-summary-scope"))?;
            count.count = count.count.checked_sub(1)
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "candidate-summary-count"))?;
            count.ai_count = count.ai_count.checked_sub(1)
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "candidate-summary-count"))?;
        }
    }
    Ok(counts)
}
fn belongs(c: &Connection, request: &CandidateDecisionWrite) -> Result<bool, ExecutionError> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM translation_revisions WHERE project_id=?1 AND revision_id=?2 AND unit_id=?3 AND locale=?4 AND source_revision_id=?5 AND origin_kind='ai')",
        params![request.project_id.to_string(),request.revision_id.to_string(),request.unit_id.to_string(),request.locale,request.source_revision_id.to_string()], |r|r.get(0))
        .map_err(super::super::ledger::sql_error)
}
pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let actual: String = c.query_row(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=?1",
        [REVISION_INDEX],
        |row| row.get(0),
    ).map_err(super::super::ledger::sql_error)?;
    if actual != CREATE_REVISION_INDEX {
        return Err(error(ErrorCode::CorruptLedger, "candidate-decision-index"));
    }
    let project = super::super::read_metadata_from(c)
        .map_err(|_| error(ErrorCode::CorruptLedger, "candidate-project"))?
        .project_id()
        .to_string();
    let mut previous = std::collections::BTreeMap::<ExecutionId, CandidateDecision>::new();
    let mut statement = c
        .prepare("SELECT action_id FROM translation_candidate_decisions ORDER BY rowid")
        .map_err(super::super::ledger::sql_error)?;
    let actions = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(super::super::ledger::sql_error)?;
    for raw in actions {
        let value = load(c, id(raw.map_err(super::super::ledger::sql_error)?)?)?
            .ok_or_else(|| error(ErrorCode::CorruptLedger, "candidate-decision"))?;
        let request = &value.request;
        let prior = previous.get(&request.revision_id);
        let source_valid: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM source_binding_history WHERE snapshot_id=?1 AND unit_id=?2 AND revision_id=?3)",
            params![value.source_snapshot_id.to_string(),request.unit_id.to_string(),request.source_revision_id.to_string()], |r|r.get(0)).map_err(super::super::ledger::sql_error)?;
        if request.project_id.to_string() != project
            || !belongs(c, request)?
            || !source_valid
            || request.expected_decision_id != prior.map(|value| value.request.action_id)
            || request.disposition
                == prior.map_or(CandidateDisposition::Restored, |value| {
                    value.request.disposition
                })
        {
            return Err(error(
                ErrorCode::CorruptLedger,
                "candidate-decision-history",
            ));
        }
        if let Some(selection) = request.expected_selection_id {
            let valid: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM translation_selections WHERE event_id=?1 AND project_id=?2 AND unit_id=?3 AND locale=?4 AND revision_id<>?5)",
                params![selection.to_string(),project,request.unit_id.to_string(),request.locale,request.revision_id.to_string()],|r|r.get(0)).map_err(super::super::ledger::sql_error)?;
            if !valid {
                return Err(error(
                    ErrorCode::CorruptLedger,
                    "candidate-selection-history",
                ));
            }
        }
        previous.insert(request.revision_id, value);
    }
    for value in previous
        .values()
        .filter(|value| is_rejected(value))
    {
        if current_selection(c, value.request.unit_id, &value.request.locale)?
            .is_some_and(|s| s.revision_id == value.request.revision_id)
        {
            return Err(error(
                ErrorCode::CorruptLedger,
                "candidate-rejected-selection",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "candidates/summary_tests.rs"]
pub(super) mod summary_tests;
impl ProjectStore {
    pub fn translation_candidate_decision(
        &self,
        project: ExecutionId,
        revision: ExecutionId,
    ) -> Result<Option<CandidateDecision>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-read"))?;
        let owned: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM translation_revisions WHERE project_id=?1 AND revision_id=?2)",params![project.to_string(),revision.to_string()],|r|r.get(0)).map_err(super::super::ledger::sql_error)?;
        if !owned {
            return Err(error(ErrorCode::Unauthorized, "candidate-decision-project"));
        }
        latest(c, revision)
    }
    pub fn decide_translation_candidate(
        &mut self,
        request: &CandidateDecisionWrite,
    ) -> Result<CandidateDecision, ExecutionError> {
        if !valid(request) {
            return Err(error(ErrorCode::InvalidInput, "candidate-decision"));
        }
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "translation-session"));
        }
        let digest = request_digest(request)?;
        let changes = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(super::super::ledger::sql_error)?;
        let observer = changes.observe(&tx, super::super::ChangeScope::Translation);
        if let Some(value) = load(&tx, request.action_id)? {
            return if value.request == *request {
                Ok(value)
            } else {
                Err(error(
                    ErrorCode::ResultMismatch,
                    "candidate-decision-action",
                ))
            };
        }
        check_target(&tx, request.project_id, &request.locale)?;
        let (snapshot, source) = source_basis(&tx, request.project_id, request.unit_id)?;
        if source != request.source_revision_id || !belongs(&tx, request)? {
            return Err(error(
                ErrorCode::DependencyConflict,
                "candidate-decision-basis",
            ));
        }
        let selection = current_selection(&tx, request.unit_id, &request.locale)?;
        check_expected(&selection, request.expected_selection_id)?;
        if selection.is_some_and(|s| s.revision_id == request.revision_id) {
            return Err(error(ErrorCode::DependencyConflict, "candidate-selected"));
        }
        let prior = latest(&tx, request.revision_id)?;
        if request.expected_decision_id != prior.as_ref().map(|value| value.request.action_id)
            || request.disposition
                == prior
                    .as_ref()
                    .map_or(CandidateDisposition::Restored, |value| {
                        value.request.disposition
                    })
        {
            return Err(error(
                ErrorCode::DependencyConflict,
                "candidate-decision-basis",
            ));
        }
        let collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM translation_selections WHERE action_id=?1) OR EXISTS(SELECT 1 FROM translation_revisions WHERE action_id=?1)",[request.action_id.to_string()],|r|r.get(0)).map_err(super::super::ledger::sql_error)?;
        if collision {
            return Err(error(
                ErrorCode::ResultMismatch,
                "candidate-decision-action",
            ));
        }
        let value = CandidateDecision {
            request: request.clone(),
            source_snapshot_id: snapshot,
        };
        let bytes = codec::encode(request, MAX_INPUT_BYTES)?;
        let receipt = codec::encode(&value, MAX_INPUT_BYTES)?;
        tx.execute(
            "INSERT INTO translation_candidate_decisions VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                request.action_id.to_string(),
                request.revision_id.to_string(),
                snapshot.to_string(),
                bytes,
                digest,
                receipt,
                codec::digest(&receipt)
            ],
        )
        .map_err(super::super::ledger::sql_error)?;
        observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            error(ErrorCode::OutcomeUnknown, "candidate-decision-commit")
        })?;
        Ok(value)
    }
    pub fn translation_candidate_action(
        &mut self,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
        action: ExecutionId,
    ) -> Result<Option<CandidateDecision>, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-read"))?;
        if !super::super::content::unit_owned_by_project(connection, project, unit)? {
            return Err(error(ErrorCode::Unauthorized, "translation-project"));
        }
        let value = load(connection, action)?;
        if value.as_ref().is_some_and(|value| {
            value.request.project_id != project
                || value.request.unit_id != unit
                || value.request.locale != locale
        }) {
            return Err(error(ErrorCode::Unauthorized, "candidate-decision-action"));
        }
        if self
            .execution_unknown
            .load(std::sync::atomic::Ordering::Acquire)
        {
            self.reconcile_execution()?;
        }
        Ok(value)
    }
}
