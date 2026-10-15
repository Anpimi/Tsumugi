//! Explicit plugin execution grants in the existing project database.
//! Persisted consent is not sufficient without this open store's live epoch.
use super::{ProjectStore, ledger};
use crate::execution::{
    ErrorCode, ExecutionError, ExecutionId, FixedInput, PluginConsent, PluginPermit,
    plugin_authority::{PluginAuthority, PluginEpoch, plugin_grant_deadline, plugin_now_ms},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::Arc;

// A grant may be recorded before its fixed input is enqueued. Association with
// the eventual attempt is checked against the exact captured digest, not an FK
// to a row that does not yet exist.
pub(super) const TABLES: &[(&str, &str)] = &[(
    "plugin_execution_grants",
    "CREATE TABLE plugin_execution_grants (grant_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, input_digest TEXT NOT NULL CHECK(length(input_digest)=64), generation TEXT NOT NULL, expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>0), unsandboxed_execution INTEGER NOT NULL CHECK(unsandboxed_execution=1), revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), delegation BLOB CHECK(delegation IS NULL OR length(delegation) BETWEEN 1 AND 4096))",
)];

pub(super) fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        connection.execute_batch(sql)?;
    }
    Ok(())
}

fn failure(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    failure(ErrorCode::StorageFailed, "plugin-grant-storage")
}
fn denied() -> ExecutionError {
    failure(ErrorCode::Unauthorized, "plugin-grant")
}

#[derive(Debug)]
struct GrantRecord {
    grant_id: ExecutionId,
    attempt_id: ExecutionId,
    task_id: ExecutionId,
    input_digest: String,
    generation: ExecutionId,
    expires_at_ms: u64,
    unsandboxed_execution: bool,
    revoked: bool,
    delegation: Option<crate::application::WorkPlanToolDelegation>,
}
type RawRecord = (
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    Option<Vec<u8>>,
);

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawRecord> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}
fn decode(raw: RawRecord) -> Result<GrantRecord, ExecutionError> {
    let corrupt = || failure(ErrorCode::CorruptLedger, "plugin-grant-record");
    let id = |value: &str| {
        ExecutionId::parse(value)
            .ok()
            .filter(|id| id.to_string() == value)
            .ok_or_else(corrupt)
    };
    if raw.3.len() != 64
        || !raw
            .3
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || raw.5 <= 0
        || raw.6 != 1
        || ![0, 1].contains(&raw.7)
    {
        return Err(corrupt());
    }
    Ok(GrantRecord {
        grant_id: id(&raw.0)?,
        attempt_id: id(&raw.1)?,
        task_id: id(&raw.2)?,
        input_digest: raw.3,
        generation: id(&raw.4)?,
        expires_at_ms: raw.5 as u64,
        unsandboxed_execution: true,
        revoked: raw.7 == 1,
        delegation: raw
            .8
            .map(|bytes| crate::execution::codec::decode(&bytes, 4096))
            .transpose()?,
    })
}
fn for_attempt(
    connection: &Connection,
    attempt: ExecutionId,
) -> Result<Option<GrantRecord>, ExecutionError> {
    connection.query_row(
        "SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked,delegation FROM plugin_execution_grants WHERE attempt_id=?1",
        [attempt.to_string()], row,
    ).optional().map_err(sql)?.map(decode).transpose()
}
fn for_grant(
    connection: &Connection,
    grant: ExecutionId,
) -> Result<Option<GrantRecord>, ExecutionError> {
    connection.query_row(
        "SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked,delegation FROM plugin_execution_grants WHERE grant_id=?1",
        [grant.to_string()], row,
    ).optional().map_err(sql)?.map(decode).transpose()
}
fn not_cancelled(connection: &Connection, task: ExecutionId) -> Result<(), ExecutionError> {
    let cancelled: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_cancellations WHERE task_id=?1)",
            [task.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if cancelled {
        return Err(failure(ErrorCode::Cancelled, "plugin-task-cancelled"));
    }
    Ok(())
}

fn not_delegated(connection: &Connection, task: ExecutionId) -> Result<(), ExecutionError> {
    // Direct grants cannot borrow either provider-child or broker authority,
    // including a task registered after direct consent was recorded.
    let delegated: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_budgets WHERE task_id=?1 AND parent_id IS NOT NULL) OR EXISTS(SELECT 1 FROM execution_budget_ancestry WHERE task_id=?1 AND ancestor_id<>task_id) OR EXISTS(SELECT 1 FROM application_executions x JOIN execution_attempts a USING(attempt_id) WHERE a.task_id=?1 AND x.kind='tool')",
            [task.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if delegated {
        return Err(denied());
    }
    Ok(())
}
fn check_project(connection: &Connection, input: &FixedInput) -> Result<(), ExecutionError> {
    let metadata = super::read_metadata_from(connection)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "plugin-project"))?;
    if input.envelope().project_id.to_string() != metadata.project_id().to_string() {
        return Err(denied());
    }
    Ok(())
}
fn check_record(record: &GrantRecord, input: &FixedInput) -> Result<(), ExecutionError> {
    if record.attempt_id != input.envelope().attempt_id
        || record.task_id != input.envelope().task_id
        || record.input_digest != input.digest()
    {
        return Err(failure(ErrorCode::ResultMismatch, "plugin-grant-input"));
    }
    Ok(())
}

/// Historical provenance uses the original persisted grant, never a live permit.
pub(super) fn validate_result_in(
    connection: &Connection,
    input: &FixedInput,
    result: &crate::execution::FixedResult,
) -> Result<(), ExecutionError> {
    if let Some(evidence) = &result.envelope().plugin {
        let record = for_attempt(connection, input.envelope().attempt_id)?
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "plugin-result-grant"))?;
        check_record(&record, input)?;
        if evidence.authorization_id != record.grant_id {
            return Err(failure(ErrorCode::CorruptLedger, "plugin-result-grant"));
        }
    }
    Ok(())
}

/// Runs inside the caller's existing read or write transaction. A query never
/// writes the database, renews, or reconstructs a persisted authorization.
pub(super) fn check_input_in(
    connection: &Connection,
    input: &FixedInput,
    authority: &PluginAuthority,
) -> Result<Option<PluginPermit>, ExecutionError> {
    let record = for_attempt(connection, input.envelope().attempt_id)?;
    if input.envelope().plugin.is_none() {
        return if record.is_none() {
            Ok(None)
        } else {
            Err(failure(ErrorCode::ResultMismatch, "plugin-grant-input"))
        };
    }
    check_project(connection, input)?;
    let record = record.ok_or_else(denied)?;
    check_record(&record, input)?;
    authority.require_generation(record.generation)?;
    if record.revoked || !record.unsandboxed_execution || record.expires_at_ms <= plugin_now_ms()? {
        return Err(denied());
    }
    not_cancelled(connection, record.task_id)?;
    match &record.delegation {
        None => {
            if input.envelope().automation.is_some() {
                return Err(denied());
            }
            not_delegated(connection, record.task_id)?;
        }
        Some(delegation) => {
            super::application::check_tool_delegation(connection, input, delegation)?
        }
    }
    let permit = authority.permit(input)?;
    if permit.delegation() != record.delegation.as_ref() {
        return Err(denied());
    }
    if !permit.matches_record(
        input,
        record.grant_id,
        record.generation,
        record.expires_at_ms,
    ) {
        return Err(denied());
    }
    Ok(Some(permit))
}

/// Structural reopening/reconciliation validation does not grant execution.
pub(super) fn validate(connection: &Connection) -> Result<(), ExecutionError> {
    for (name, expected) in TABLES {
        let actual: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |row| row.get(0),
            )
            .map_err(sql)?;
        if actual != *expected {
            return Err(failure(ErrorCode::CorruptLedger, "plugin-grant-schema"));
        }
    }
    let mut statement = connection.prepare(
        "SELECT grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked,delegation FROM plugin_execution_grants",
    ).map_err(sql)?;
    let records = statement.query_map([], row).map_err(sql)?;
    for record in records {
        let record = decode(record.map_err(sql)?)?;
        if record.delegation.is_none() {
            not_delegated(connection, record.task_id)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "plugin-grant-delegation"))?;
        } else {
            let associated: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                    [record.attempt_id.to_string()],
                    |row| row.get(0),
                )
                .map_err(sql)?;
            if !associated {
                return Err(failure(
                    ErrorCode::CorruptLedger,
                    "plugin-grant-association",
                ));
            }
        }
    }
    Ok(())
}

/// Reuse the original open-time input scan without restoring execution authority.
/// Delegated grants still require their recorded tool association, and every
/// saved result retains the strict integrity check used before scan sharing.
pub(super) fn validate_associated_input(
    connection: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    if let Some(record) = for_attempt(connection, input.envelope().attempt_id)? {
        check_record(&record, input)?;
        check_project(connection, input)?;
        if input.envelope().plugin.is_none() {
            return Err(failure(ErrorCode::CorruptLedger, "plugin-grant-input"));
        }
        match &record.delegation {
            Some(delegation) => {
                super::application::validate_tool_input(connection, input, delegation)?
            }
            None if input.envelope().automation.is_some() => {
                return Err(failure(ErrorCode::CorruptLedger, "plugin-grant-input"));
            }
            None => {}
        }
        let mut results = connection
            .prepare("SELECT result_id FROM execution_results WHERE attempt_id=?1")
            .map_err(sql)?;
        let ids = results
            .query_map([record.attempt_id.to_string()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(sql)?;
        for id in ids {
            let id = ExecutionId::parse(&id.map_err(sql)?)?;
            ledger::load_result(connection, input, id)?;
        }
    }
    Ok(())
}

impl ProjectStore {
    pub(crate) fn check_plugin_epoch_owner(
        &self,
        expected: &Arc<PluginEpoch>,
    ) -> Result<(), ExecutionError> {
        self.connection().map_err(|_| denied())?;
        if !self.plugin_authority.owns_epoch(expected)? {
            return Err(denied());
        }
        Ok(())
    }
    pub(crate) fn rotate_plugin_epoch(
        &self,
        expected: &Arc<PluginEpoch>,
        generation: ExecutionId,
    ) -> Result<Arc<PluginEpoch>, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "plugin-session"));
        }
        self.connection().map_err(|_| denied())?;
        self.plugin_authority.rotate_epoch(expected, generation)
    }
    pub(crate) fn begin_plugin_epoch(
        &self,
        generation: ExecutionId,
    ) -> Result<Arc<PluginEpoch>, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "plugin-session"));
        }
        self.connection().map_err(|_| denied())?;
        self.plugin_authority.begin_epoch(generation)
    }

    pub(crate) fn authorize_plugin_input(
        &mut self,
        generation: ExecutionId,
        grant_id: ExecutionId,
        input: &FixedInput,
        expires_at_ms: u64,
        consent: PluginConsent,
    ) -> Result<(), ExecutionError> {
        if !consent.allows(input) {
            return Err(denied());
        }
        let authority = Arc::clone(&self.plugin_authority);
        authority.require_generation(generation)?;
        // Capture the monotonic limit before the transaction. A wall-clock
        // rollback during commit cannot extend the consent's original duration.
        let deadline = plugin_grant_deadline(expires_at_ms)?;
        let tx = self.execution_write()?;
        check_project(&tx, input)?;
        not_cancelled(&tx, input.envelope().task_id)?;
        not_delegated(&tx, input.envelope().task_id)?;
        let existing = for_grant(&tx, grant_id)?;
        let attempt = for_attempt(&tx, input.envelope().attempt_id)?;
        if existing.is_some() || attempt.is_some() {
            let record = existing.ok_or_else(denied)?;
            if attempt.as_ref().map(|record| record.grant_id) != Some(grant_id)
                || record.generation != generation
                || record.expires_at_ms != expires_at_ms
                || !record.unsandboxed_execution
                || record.delegation.is_some()
            {
                return Err(failure(ErrorCode::ResultMismatch, "plugin-grant-identity"));
            }
            check_record(&record, input)?;
            // Exact retries are idempotent only while the original live grant
            // remains valid. They never arm a new permit after close or failure.
            return check_input_in(&tx, input, &authority).map(|_| ());
        }
        authority.check_new_grant(generation)?;
        // If an attempt already exists, consent must bind its original bytes.
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT digest,task_id FROM execution_attempts WHERE attempt_id=?1",
                [input.envelope().attempt_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if prior.is_some_and(|(digest, task)| {
            digest != input.digest() || task != input.envelope().task_id.to_string()
        }) {
            return Err(failure(ErrorCode::ResultMismatch, "plugin-grant-input"));
        }
        tx.execute(
            "INSERT INTO plugin_execution_grants (grant_id,attempt_id,task_id,input_digest,generation,expires_at_ms,unsandboxed_execution,revoked) VALUES (?1,?2,?3,?4,?5,?6,1,0)",
            params![grant_id.to_string(), input.envelope().attempt_id.to_string(), input.envelope().task_id.to_string(), input.digest(), generation.to_string(), expires_at_ms as i64],
        ).map_err(sql)?;
        ledger::commit(tx)?;
        authority.activate(generation, grant_id, input, expires_at_ms, deadline)?;
        Ok(())
    }

    pub(crate) fn plugin_permit(&self, input: &FixedInput) -> Result<PluginPermit, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "plugin-session"));
        }
        let connection = self.connection().map_err(|_| denied())?;
        check_input_in(connection, input, &self.plugin_authority)?.ok_or_else(denied)
    }

    pub(crate) fn check_plugin_input(&self, input: &FixedInput) -> Result<(), ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "plugin-session"));
        }
        let connection = self.connection().map_err(|_| denied())?;
        check_input_in(connection, input, &self.plugin_authority).map(|_| ())
    }

    pub(crate) fn revoke_plugin_grant(
        &mut self,
        generation: ExecutionId,
        grant_id: ExecutionId,
    ) -> Result<(), ExecutionError> {
        self.revoke_plugin_grants(generation, &[grant_id])
    }
    pub(crate) fn revoke_plugin_grants(
        &mut self,
        generation: ExecutionId,
        grant_ids: &[ExecutionId],
    ) -> Result<(), ExecutionError> {
        let authority = Arc::clone(&self.plugin_authority);
        authority.require_generation(generation)?;
        if grant_ids.len() > 128 {
            return Err(failure(ErrorCode::LimitExceeded, "plugin-grants"));
        }
        if grant_ids.is_empty() {
            return Ok(());
        }
        let tx = self.execution_write()?;
        let mut already_revoked = true;
        for grant_id in grant_ids {
            let record = for_grant(&tx, *grant_id)?.ok_or_else(denied)?;
            if record.generation != generation {
                return Err(denied());
            }
            already_revoked &= record.revoked;
        }
        // Revocation is one-way even if COMMIT fails or its result is unknown.
        // Only an explicit new attempt can obtain another grant.
        for grant_id in grant_ids {
            authority.revoke_grant(generation, *grant_id)?;
        }
        if already_revoked {
            return Ok(());
        }
        for grant_id in grant_ids {
            tx.execute(
                "UPDATE plugin_execution_grants SET revoked=1 WHERE grant_id=?1 AND generation=?2",
                [grant_id.to_string(), generation.to_string()],
            )
            .map_err(sql)?;
        }
        ledger::commit(tx)
    }
}

/// Stage a delegated grant in the caller's enqueue transaction. No live handle
/// exists before this transaction commits; only the opaque broker path calls it.
pub(super) fn record_delegated_grant_in(
    c: &Connection,
    authority: &PluginAuthority,
    generation: ExecutionId,
    grant_id: ExecutionId,
    input: &FixedInput,
    expires_at_ms: u64,
    delegation: &crate::application::WorkPlanToolDelegation,
) -> Result<bool, ExecutionError> {
    authority.require_generation(generation)?;
    check_project(c, input)?;
    not_cancelled(c, input.envelope().task_id)?;
    let existing = for_grant(c, grant_id)?;
    let attempt = for_attempt(c, input.envelope().attempt_id)?;
    if existing.is_some() || attempt.is_some() {
        let record = existing.ok_or_else(denied)?;
        if attempt.as_ref().map(|record| record.grant_id) != Some(grant_id)
            || record.generation != generation
            || record.expires_at_ms != expires_at_ms
            || record.delegation.as_ref() != Some(delegation)
            || record.revoked
        {
            return Err(failure(ErrorCode::ResultMismatch, "plugin-grant-identity"));
        }
        check_record(&record, input)?;
        check_input_in(c, input, authority)?;
        return Ok(false);
    }
    authority.check_new_grant(generation)?;
    let reused_task: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_execution_grants WHERE task_id=?1)",
            [input.envelope().task_id.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if reused_task {
        return Err(failure(ErrorCode::ResultMismatch, "plugin-grant-task"));
    }
    c.execute(
        "INSERT INTO plugin_execution_grants VALUES (?1,?2,?3,?4,?5,?6,1,0,?7)",
        params![
            grant_id.to_string(),
            input.envelope().attempt_id.to_string(),
            input.envelope().task_id.to_string(),
            input.digest(),
            generation.to_string(),
            expires_at_ms as i64,
            crate::execution::codec::encode(delegation, 4096)?
        ],
    )
    .map_err(sql)?;
    Ok(true)
}
