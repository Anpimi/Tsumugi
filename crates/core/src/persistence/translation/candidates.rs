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
fn load(c: &Connection, action: ExecutionId) -> Result<Option<CandidateDecision>, ExecutionError> {
    let raw: Option<(String, String, Vec<u8>, String, Vec<u8>, String)> = c.query_row(
        "SELECT revision_id,source_snapshot_id,request,request_digest,receipt,receipt_digest FROM translation_candidate_decisions WHERE action_id=?1",
        [action.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)),
    ).optional().map_err(super::super::ledger::sql_error)?;
    let Some((revision, snapshot, bytes, digest, receipt, receipt_digest)) = raw else {
        return Ok(None);
    };
    let request: CandidateDecisionWrite = codec::decode(&bytes, MAX_INPUT_BYTES)?;
    let value: CandidateDecision = codec::decode(&receipt, MAX_INPUT_BYTES)?;
    if !valid(&request)
        || codec::digest(&bytes) != digest
        || codec::digest(&receipt) != receipt_digest
        || request.action_id != action
        || request.revision_id.to_string() != revision
        || value.request != request
        || value.source_snapshot_id.to_string() != snapshot
    {
        return Err(error(
            ErrorCode::CorruptLedger,
            "candidate-decision-receipt",
        ));
    }
    Ok(Some(value))
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
    Ok(latest(c, revision)?.is_some_and(|value| value.request.disposition == CandidateDisposition::Rejected))
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
        let source_valid: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM source_occurrences WHERE snapshot_id=?1 AND unit_id=?2 AND revision_id=?3)",
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
        .filter(|value| value.request.disposition == CandidateDisposition::Rejected)
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
