use super::ProjectStore;
use crate::execution::{codec, *};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
mod activity;
mod input_storage;
pub use activity::{TaskActivity, TaskActivityPhase, TaskActivityRow};
pub(crate) mod provider;
pub use provider::ProviderBudget;

const EXECUTION_RESULTS_TABLE: &str = "CREATE TABLE \"execution_results\" (
        result_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL, item_id TEXT NOT NULL, dispatch_token TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 8388608), digest TEXT NOT NULL CHECK(length(digest) = 64),
        FOREIGN KEY(attempt_id,item_id,dispatch_token) REFERENCES execution_items(attempt_id,item_id,dispatch_token))";

pub(super) const TABLES: &[(&str, &str)] = &[
    ("execution_input_chunks", input_storage::TABLE),
    ("execution_tasks", "CREATE TABLE execution_tasks (
        task_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, operation TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE CHECK(sequence > 0), UNIQUE(task_id, project_id))"),
    ("execution_attempts", "CREATE TABLE execution_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        previous_attempt_id TEXT REFERENCES execution_attempts(attempt_id),
        input BLOB NOT NULL CHECK(typeof(input)='blob' AND length(input) BETWEEN 1 AND 18432), digest TEXT NOT NULL CHECK(length(digest) = 64),
        cancellation_revision INTEGER NOT NULL CHECK(cancellation_revision >= 0),
        sequence INTEGER NOT NULL UNIQUE CHECK(sequence > 0),
        FOREIGN KEY(task_id, project_id) REFERENCES execution_tasks(task_id, project_id))"),
    ("execution_items", "CREATE TABLE execution_items (
        attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id), item_id TEXT NOT NULL,
        execution TEXT NOT NULL CHECK(execution IN ('queued','dispatched','succeeded','failed','cancelled-before-dispatch','unknown')),
        validation TEXT NOT NULL CHECK(validation IN ('absent','pending','valid','invalid')),
        adoption TEXT NOT NULL CHECK(adoption IN ('unapplied','committed','conflict','rejected')),
        dispatch_token TEXT UNIQUE, current_result_id TEXT,
        retry_safe INTEGER NOT NULL CHECK(retry_safe IN (0,1)), diagnostic TEXT CHECK(length(diagnostic) <= 4096),
        PRIMARY KEY(attempt_id,item_id), UNIQUE(attempt_id,item_id,dispatch_token))"),
    ("execution_results", EXECUTION_RESULTS_TABLE),
    ("mcp_query_actions", "CREATE TABLE mcp_query_actions (
        action_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(attempt_id),
        input_digest TEXT NOT NULL CHECK(length(input_digest)=64))"),
    ("plugin_validation_links", "CREATE TABLE plugin_validation_links (
        producer_result_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_results(result_id),
        checker_result_id TEXT NOT NULL REFERENCES execution_results(result_id),
        valid INTEGER NOT NULL CHECK(valid IN (0,1)))"),
    ("execution_cancellations", "CREATE TABLE execution_cancellations (
        request_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES execution_tasks(task_id),
        revision INTEGER NOT NULL CHECK(revision > 0), UNIQUE(task_id,revision))"),
    ("execution_actions", "CREATE TABLE execution_actions (
        action_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
        unit_id TEXT NOT NULL, request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 1048576),
        digest TEXT NOT NULL CHECK(length(digest) = 64), UNIQUE(action_id,attempt_id,unit_id))"),
    ("execution_continuations", "CREATE TABLE execution_continuations (
        action_id TEXT PRIMARY KEY NOT NULL, source_attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
        unit_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(attempt_id),
        receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 1048576),
        digest TEXT NOT NULL CHECK(length(digest) = 64))"),
    ("adoption_receipts", "CREATE TABLE adoption_receipts (
        action_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL, unit_id TEXT NOT NULL,
        receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 1048576), digest TEXT NOT NULL CHECK(length(digest) = 64),
        UNIQUE(attempt_id,unit_id),
        FOREIGN KEY(action_id,attempt_id,unit_id) REFERENCES execution_actions(action_id,attempt_id,unit_id))"),
];

pub(super) fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        connection.execute_batch(sql)?;
    }
    Ok(())
}
pub(super) fn table_names(_connection: &Connection) -> Vec<String> {
    let mut names: Vec<_> = TABLES.iter().map(|(name, _)| name.to_string()).collect();
    names.push("project_metadata".into());
    names.extend(super::content::table_names());
    #[cfg(test)]
    if TEST_SCHEMA.with(|flag| flag.get()) {
        names.push("fixture_targets".into());
    }
    #[cfg(feature = "execution-test-host")]
    if !names.iter().any(|name|name=="fixture_targets") && _connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='fixture_targets' AND type='table')",[],|r|r.get::<_,bool>(0)).unwrap_or(false) {
        names.push("fixture_targets".into());
    }
    names.sort();
    names
}
#[cfg(test)]
thread_local! { static TEST_SCHEMA: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

pub(super) fn validate(connection: &Connection) -> Result<(), ExecutionError> {
    validate_schema(connection, |_, _| Ok(()))
}

pub(super) fn validate_for_open(
    connection: &Connection,
    mut validate_review: impl FnMut(&Connection, &FixedInput) -> Result<(), ExecutionError>,
) -> Result<(), ExecutionError> {
    validate_schema(connection, |connection, input| {
        super::plugin_execution::validate_associated_input(connection, input)?;
        validate_review(connection, input)
    })
}

fn validate_schema(
    connection: &Connection,
    mut validate_input: impl FnMut(&Connection, &FixedInput) -> Result<(), ExecutionError>,
) -> Result<(), ExecutionError> {
    #[cfg(feature = "execution-test-host")]
    if let Some(sql) = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='fixture_targets'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_error)?
    {
        if sql != crate::execution::test_support::TARGET_SCHEMA {
            return Err(error(ErrorCode::CorruptLedger, "fixture-schema"));
        }
    }
    for (name, expected) in TABLES {
        let expected = *expected;
        let actual: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if actual != expected {
            return Err(error(ErrorCode::CorruptLedger, "schema"));
        }
    }
    let foreign_keys: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .map_err(sql_error)?;
    if foreign_keys != 1
        || connection
            .prepare("PRAGMA foreign_key_check")
            .map_err(sql_error)?
            .exists([])
            .map_err(sql_error)?
    {
        return Err(error(ErrorCode::CorruptLedger, "foreign-keys"));
    }
    input_storage::validate_chunks(connection)?;
    let project = super::read_metadata_from(connection)
        .map_err(|_| error(ErrorCode::CorruptLedger, "project"))?;
    let mut statement = connection
        .prepare("SELECT attempt_id FROM execution_attempts ORDER BY sequence")
        .map_err(sql_error)?;
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?;
    for id in ids {
        let id = parse_id(id.map_err(sql_error)?)?;
        let input = load_input(connection, id)?;
        if input.envelope().project_id.to_string() != project.project_id().to_string() {
            return Err(error(ErrorCode::CorruptLedger, "project"));
        }
        let _ = read_attempt_in(connection, &input, false)?;
        if input.envelope().operation == crate::application::MCP_TERM_QUERY_OPERATION
            || input.envelope().capability_id == crate::application::MCP_TERM_QUERY_CAPABILITY
        {
            super::mcp::validate_ledger_input(connection, &input)?;
        }
        validate_input(connection, &input)?;
    }
    super::mcp::validate_action_links(connection)?;
    let mut links = connection
        .prepare("SELECT producer_result_id,valid FROM plugin_validation_links")
        .map_err(sql_error)?;
    let rows = links
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))
        .map_err(sql_error)?;
    for row in rows {
        let (result_id, valid) = row.map_err(sql_error)?;
        let attempt: String = connection
            .query_row(
                "SELECT attempt_id FROM execution_results WHERE result_id=?1",
                [&result_id],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        let input = load_input(connection, parse_id(attempt)?)?;
        let result = load_result(connection, &input, parse_id(result_id)?)?;
        validate_plugin_link(connection, &input, &result, valid)?;
    }
    let mut actions = connection
        .prepare("SELECT action_id,attempt_id,unit_id,request,digest FROM execution_actions")
        .map_err(sql_error)?;
    let rows = actions
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(sql_error)?;
    for row in rows {
        let (id, attempt, unit, bytes, digest) = row.map_err(sql_error)?;
        let action: AdoptionAction = codec::decode(&bytes, MAX_INPUT_BYTES)?;
        let input = load_input_cached(connection, parse_id(attempt.clone())?)?;
        if action.action_id.to_string() != id
            || action.attempt_id.to_string() != attempt
            || action.unit_id.to_string() != unit
            || action.request_digest(&input)? != digest
        {
            return Err(error(ErrorCode::CorruptLedger, "action"));
        }
        if let Some(receipt) = read_receipt(connection, action.action_id)? {
            if receipt.project_id != action.project_id
                || receipt.attempt_id != action.attempt_id
                || receipt.unit_id != action.unit_id
                || receipt.request_digest != digest
            {
                return Err(error(ErrorCode::CorruptLedger, "receipt-association"));
            }
        }
    }
    let mut continuations = connection
        .prepare("SELECT action_id FROM execution_continuations")
        .map_err(sql_error)?;
    let ids = continuations
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?;
    for id in ids {
        read_continuation(connection, parse_id(id.map_err(sql_error)?)?)?
            .ok_or_else(|| error(ErrorCode::CorruptLedger, "continuation-association"))?;
    }
    Ok(())
}

fn enqueue_input(
    tx: &Connection,
    input: &FixedInput,
    policy: RecoveryPolicy,
    parent: Option<ExecutionId>,
    prepared_input: &input_storage::PreparedInput<'_>,
    fresh_delegation: bool,
) -> Result<bool, ExecutionError> {
    let envelope = input.envelope();
    super::resources::verify_input_fact_decisions(tx, input)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT digest FROM execution_attempts WHERE attempt_id=?1",
            [envelope.attempt_id.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    if let Some(digest) = existing {
        if fresh_delegation {
            return Err(error(ErrorCode::ResultMismatch, "work-plan-tool-attempt"));
        }
        return if digest == input.digest()
            && provider::recovery_policy(tx, envelope.attempt_id)? == policy
            && provider::matches_parent(tx, envelope.task_id, parent)?
        {
            check_stored_input(tx, input)?;
            Ok(false)
        } else {
            Err(error(ErrorCode::ResultMismatch, "attempt-identity"))
        };
    }
    super::resources::strategy::verify_admission(tx, input)?;
    let task: Option<(String, String)> = tx
        .query_row(
            "SELECT project_id,operation FROM execution_tasks WHERE task_id=?1",
            [envelope.task_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql_error)?;
    if let Some((project, operation)) = task {
        if project != envelope.project_id.to_string()
            || operation != envelope.operation
            || envelope.previous_attempt_id.is_none()
        {
            return Err(error(ErrorCode::ResultMismatch, "task-identity"));
        }
    } else {
        if envelope.previous_attempt_id.is_some() {
            return Err(error(ErrorCode::InvalidInput, "previous-attempt"));
        }
        tx.execute("INSERT INTO execution_tasks VALUES (?1,?2,?3,(SELECT COALESCE(MAX(sequence),0)+1 FROM execution_tasks))", params![envelope.task_id.to_string(),envelope.project_id.to_string(),envelope.operation]).map_err(sql_error)?;
    }
    if let Some(previous) = envelope.previous_attempt_id {
        let old = load_input(tx, previous)?;
        if provider::recovery_policy(tx, previous)? != policy || !policy.allows_replay() {
            return Err(error(ErrorCode::Unauthorized, "effect-policy"));
        }
        if old.envelope().task_id != envelope.task_id {
            return Err(error(ErrorCode::ResultMismatch, "previous-attempt"));
        }
        if envelope
            .units
            .iter()
            .any(|unit| !old.envelope().units.contains(unit))
        {
            return Err(error(ErrorCode::Unauthorized, "retry-unit"));
        }
        let state = read_attempt(tx, previous, false)?;
        for item in &envelope.items {
            let newer: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_items i JOIN execution_attempts a ON a.attempt_id=i.attempt_id WHERE a.task_id=?1 AND i.item_id=?2 AND a.sequence>(SELECT sequence FROM execution_attempts WHERE attempt_id=?3))",params![envelope.task_id.to_string(),item.item_id.to_string(),previous.to_string()],|r|r.get(0)).map_err(sql_error)?;
            if newer {
                return Err(error(ErrorCode::Unauthorized, "retry-already-created"));
            }
            let status = state
                .items
                .iter()
                .find(|old| old.item_id == item.item_id)
                .ok_or_else(|| error(ErrorCode::InvalidInput, "retry-item"))?;
            if let Some(reference) = envelope
                .reused_results
                .iter()
                .find(|reference| reference.item_id == item.item_id)
            {
                let current:Option<String>=tx.query_row("SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",params![previous.to_string(),item.item_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
                let output = load_result(tx, &old, reference.result_id)?;
                load_result(tx, input, reference.result_id)?;
                if status.adoption == AdoptionState::Committed
                    || status.validation != ValidationState::Valid
                    || status.execution != ExecutionState::Succeeded
                    || current != Some(reference.result_id.to_string())
                    || output.envelope().attempt_id != reference.source_attempt_id
                    || old.item(item.item_id)? != item
                {
                    return Err(error(ErrorCode::Unauthorized, "reuse-eligibility"));
                }
                continue;
            }
            if status.adoption == AdoptionState::Committed
                || !matches!(
                    status.execution,
                    ExecutionState::Queued
                        | ExecutionState::CancelledBeforeDispatch
                        | ExecutionState::Failed
                )
                || status.validation == ValidationState::Invalid
                || (status.execution == ExecutionState::Failed && !status.retry_safe)
            {
                return Err(error(ErrorCode::Unauthorized, "retry-eligibility"));
            }
            tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic='continued-in-new-attempt' WHERE attempt_id=?1 AND item_id=?2 AND execution='queued'",params![previous.to_string(),item.item_id.to_string()]).map_err(sql_error)?;
        }
    }
    let cancelled = cancel_revision(tx, envelope.task_id)?;
    let stored_input = prepared_input.insert(tx)?;
    tx.execute("INSERT INTO execution_attempts VALUES (?1,?2,?3,?4,?5,?6,?7,(SELECT COALESCE(MAX(sequence),0)+1 FROM execution_attempts))", params![envelope.attempt_id.to_string(),envelope.task_id.to_string(),envelope.project_id.to_string(),envelope.previous_attempt_id.map(|id|id.to_string()),stored_input,input.digest(),cancelled.get() as i64]).map_err(sql_error)?;
    for item in &envelope.items {
        if let Some(reference) = envelope
            .reused_results
            .iter()
            .find(|reference| reference.item_id == item.item_id)
        {
            tx.execute("INSERT INTO execution_items VALUES (?1,?2,'succeeded','valid','unapplied',NULL,?3,0,NULL)",params![envelope.attempt_id.to_string(),item.item_id.to_string(),reference.result_id.to_string()]).map_err(sql_error)?;
        } else {
            tx.execute("INSERT INTO execution_items VALUES (?1,?2,'queued','absent','unapplied',NULL,NULL,0,NULL)",params![envelope.attempt_id.to_string(),item.item_id.to_string()]).map_err(sql_error)?;
        }
    }
    provider::record_input(tx, input, policy, parent)?;
    super::mcp::record_input(tx, input)?;
    super::content::record_input(tx, input)?;
    super::translation::record_input(tx, input)?;
    Ok(true)
}

fn read_continuation(
    connection: &Connection,
    action_id: ExecutionId,
) -> Result<Option<ContinuationReceipt>, ExecutionError> {
    let row: Option<(String, String, String, Vec<u8>, String)> = connection.query_row(
        "SELECT source_attempt_id,unit_id,attempt_id,receipt,digest FROM execution_continuations WHERE action_id=?1",
        [action_id.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))
        .optional().map_err(sql_error)?;
    let Some((source, unit, attempt, bytes, digest)) = row else {
        return Ok(None);
    };
    let receipt: ContinuationReceipt = codec::decode(&bytes, MAX_INPUT_BYTES)
        .map_err(|_| error(ErrorCode::CorruptLedger, "continuation-receipt"))?;
    let original = load_input(connection, parse_id(source.clone())?)?;
    let next = load_input(connection, parse_id(attempt.clone())?)?;
    let action = &receipt.action;
    let expected_digest = action
        .request_digest(&original)
        .map_err(|_| error(ErrorCode::CorruptLedger, "continuation-request"))?;
    let expected_unit = original
        .envelope()
        .units
        .iter()
        .find(|u| u.unit_id == action.unit_id)
        .ok_or_else(|| error(ErrorCode::CorruptLedger, "continuation-unit"))?;
    let dispatched: std::collections::BTreeSet<_> = next
        .envelope()
        .items
        .iter()
        .filter(|i| {
            !next
                .envelope()
                .reused_results
                .iter()
                .any(|r| r.item_id == i.item_id)
        })
        .map(|i| i.item_id)
        .collect();
    let (captured, sequence): (i64, i64) = connection
        .query_row(
            "SELECT cancellation_revision,sequence FROM execution_attempts WHERE attempt_id=?1",
            [attempt.clone()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql_error)?;
    let mut expected = original.envelope().clone();
    expected.previous_attempt_id = Some(expected.attempt_id);
    expected.attempt_id = receipt.attempt_id;
    expected.units = vec![expected_unit.clone()];
    expected
        .items
        .retain(|item| expected_unit.item_ids.contains(&item.item_id));
    expected.reused_results = next.envelope().reused_results.clone();
    let reconstructed = FixedInput::capture(expected)
        .map_err(|_| error(ErrorCode::CorruptLedger, "continuation-input"))?;
    if action.action_id != action_id
        || action.source_attempt_id.to_string() != source
        || action.unit_id.to_string() != unit
        || receipt.attempt_id.to_string() != attempt
        || action
            .canonical()
            .map_err(|_| error(ErrorCode::CorruptLedger, "continuation-request"))?
            != *action
        || receipt.request_digest != expected_digest
        || receipt.request_digest != digest
        || receipt.source_input_digest != original.digest()
        || receipt.input_digest != next.digest()
        || reconstructed.digest() != next.digest()
        || receipt.task_id != original.envelope().task_id
        || receipt.operation != original.envelope().operation
        || dispatched != action.item_ids.iter().copied().collect()
        || sequence < 1
        || receipt.sequence.get() != sequence as u64
        || captured < 0
        || captured as u64 != action.expected_cancellation_revision.get()
        || provider::recovery_policy(connection, action.source_attempt_id)?
            != provider::recovery_policy(connection, receipt.attempt_id)?
        || !provider::recovery_policy(connection, receipt.attempt_id)?.allows_replay()
        || connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM execution_actions WHERE action_id=?1)",
                [action_id.to_string()],
                |r| r.get::<_, bool>(0),
            )
            .map_err(sql_error)?
    {
        return Err(error(ErrorCode::CorruptLedger, "continuation-association"));
    }
    for reference in &next.envelope().reused_results {
        let result = load_result(connection, &next, reference.result_id)?;
        if result.envelope().outcome != ExecutionState::Succeeded {
            return Err(error(ErrorCode::CorruptLedger, "continuation-reuse"));
        }
    }
    Ok(Some(receipt))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TaskView {
    pub task_id: ExecutionId,
    pub project_id: ExecutionId,
    pub operation: String,
    pub sequence: Revision,
    pub cancellation_revision: Revision,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptView {
    pub attempt_id: ExecutionId,
    pub task_id: ExecutionId,
    pub operation: String,
    pub cancellation_revision: Revision,
    pub items: Vec<ItemStatus>,
    pub progress: Progress,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct RecoveryUnit {
    pub unit_id: ExecutionId,
    pub item_ids: Vec<ExecutionId>,
    pub scopes: Vec<Scope>,
    pub remaining_item_ids: Vec<ExecutionId>,
    pub result_ids: Vec<ExecutionId>,
    pub actions: Vec<RecoveryAction>,
    pub blocked_reason: Option<String>,
    pub receipt_id: Option<ExecutionId>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct RecoveryPlan {
    pub attempt_id: ExecutionId,
    pub units: Vec<RecoveryUnit>,
}

fn error(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
pub(super) fn sql_error(error: rusqlite::Error) -> ExecutionError {
    let code = match error {
        rusqlite::Error::QueryReturnedNoRows => ErrorCode::InvalidInput,
        rusqlite::Error::SqliteFailure(ref e, _)
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            ErrorCode::Busy
        }
        _ => ErrorCode::StorageFailed,
    };
    self::error(code, "execution-storage")
}
fn parse_id(value: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&value).map_err(|_| error(ErrorCode::CorruptLedger, "identity"))
}
fn encode_enum<T: Serialize>(value: T) -> Result<String, ExecutionError> {
    match serde_json::to_value(value).map_err(|_| error(ErrorCode::InvalidInput, "state"))? {
        serde_json::Value::String(value) => Ok(value),
        _ => Err(error(ErrorCode::InvalidInput, "state")),
    }
}
fn decode_enum<T: serde::de::DeserializeOwned>(value: String) -> Result<T, ExecutionError> {
    serde_json::from_value(serde_json::Value::String(value))
        .map_err(|_| error(ErrorCode::CorruptLedger, "state"))
}
pub(super) fn cancel_revision(
    connection: &Connection,
    task: ExecutionId,
) -> Result<Revision, ExecutionError> {
    let revision: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(revision),0) FROM execution_cancellations WHERE task_id=?1",
            [task.to_string()],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    Revision::new(revision as u64)
}
pub(super) fn load_input(
    connection: &Connection,
    attempt: ExecutionId,
) -> Result<FixedInput, ExecutionError> {
    let input = read_stored_input(connection, attempt)?.restore(attempt)?;
    super::resources::verify_input_fact_decisions(connection, &input)?;
    Ok(input)
}

pub(super) fn register_input_reader(connection: &Connection) -> rusqlite::Result<()> {
    input_storage::register(connection)
}

#[cfg(test)]
pub(super) fn replace_test_input(
    connection: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    // Failure-injection fixtures change a complete raw frame, not just its
    // storage reference. Keep the same actual storage encoder and constraints.
    let prepared = input_storage::PreparedInput::capture(input)?;
    let stored = prepared.insert(connection)?;
    connection
        .execute(
            "UPDATE execution_attempts SET input=?2,digest=?3 WHERE attempt_id=?1",
            params![
                input.envelope().attempt_id.to_string(),
                stored,
                input.digest()
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}

pub(super) struct StoredInputRow {
    metadata: Option<Vec<u8>>,
    bytes: Option<Vec<u8>>,
    digest: String,
    task: String,
    project: String,
    previous: Option<String>,
}

impl StoredInputRow {
    pub(super) fn from_row(row: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<Self> {
        Ok(Self {
            metadata: row.get(start)?,
            bytes: row.get(start + 1)?,
            digest: row.get(start + 2)?,
            task: row.get(start + 3)?,
            project: row.get(start + 4)?,
            previous: row.get(start + 5)?,
        })
    }
    pub(super) fn restore(self, attempt: ExecutionId) -> Result<FixedInput, ExecutionError> {
        let input = input_storage::restore(self.metadata, self.bytes, &self.digest)?;
        check_input_association(
            &input,
            attempt,
            &self.task,
            &self.project,
            self.previous.as_deref(),
        )?;
        Ok(input)
    }
}

/// Six bounded input columns for a caller's existing statement and snapshot.
/// The execution_attempts table must use alias `a`; restoration owns integrity.
pub(super) fn input_columns_sql() -> String {
    format!(
        "{},{},a.digest,a.task_id,a.project_id,a.previous_attempt_id",
        input_storage::metadata_sql(),
        input_storage::reconstruct_sql()
    )
}

fn read_stored_input(
    connection: &Connection,
    attempt: ExecutionId,
) -> Result<StoredInputRow, ExecutionError> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM execution_attempts a WHERE a.attempt_id=?1",
                input_columns_sql()
            ),
            [attempt.to_string()],
            |r| StoredInputRow::from_row(r, 0),
        )
        .map_err(sql_error)
}

fn check_input_association(
    input: &FixedInput,
    attempt: ExecutionId,
    task: &str,
    project: &str,
    previous: Option<&str>,
) -> Result<(), ExecutionError> {
    let envelope = input.envelope();
    if envelope.attempt_id != attempt
        || envelope.task_id.to_string() != task
        || envelope.project_id.to_string() != project
        || envelope
            .previous_attempt_id
            .map(|id| id.to_string())
            .as_deref()
            != previous
    {
        return Err(error(ErrorCode::CorruptLedger, "input-association"));
    }
    Ok(())
}

pub(super) fn load_input_cached(
    connection: &Connection,
    attempt: ExecutionId,
) -> Result<FixedInput, ExecutionError> {
    use std::sync::{Mutex, OnceLock};
    // Reuse decoding, never the database's assertion of immutability. Each hit
    // compares the complete stored bytes and row association with the already
    // verified capture. A changed blob with an unchanged digest is still corrupt.
    static CACHE: OnceLock<Mutex<Option<(ExecutionId, String, FixedInput)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let stored = read_stored_input(connection, attempt)?;
    let bytes = input_storage::reconstructed_bytes(stored.metadata, stored.bytes)?;
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(id, hash, _)| *id == attempt && hash == &stored.digest)
        .map(|(_, _, input)| input.clone());
    let input = if let Some(input) = cached {
        if bytes != input.bytes() {
            return Err(error(ErrorCode::CorruptLedger, "input-bytes"));
        }
        input
    } else {
        let input = FixedInput::restore(&bytes, &stored.digest)?;
        *cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((attempt, stored.digest.clone(), input.clone()));
        input
    };
    check_input_association(
        &input,
        attempt,
        &stored.task,
        &stored.project,
        stored.previous.as_deref(),
    )?;
    super::resources::verify_input_fact_decisions(connection, &input)?;
    Ok(input)
}
/// A reused result remains bound to its original fixed input and permission.
fn result_input<'a>(
    connection: &Connection,
    input: &'a FixedInput,
    result: ExecutionId,
) -> Result<std::borrow::Cow<'a, FixedInput>, ExecutionError> {
    let reused = input
        .envelope()
        .reused_results
        .iter()
        .find(|reference| reference.result_id == result);
    if let Some(reference) = reused {
        let source = load_input(connection, reference.source_attempt_id)?;
        if source.envelope().task_id != input.envelope().task_id
            || source.envelope().project_id != input.envelope().project_id
            || source.envelope().operation != input.envelope().operation
            || source.envelope().capability_id != input.envelope().capability_id
            || source.envelope().capability_version != input.envelope().capability_version
            || source.envelope().settings != input.envelope().settings
            || source.envelope().plugin != input.envelope().plugin
            || source.item(reference.item_id)? != input.item(reference.item_id)?
        {
            return Err(error(ErrorCode::CorruptLedger, "reused-input"));
        }
        Ok(std::borrow::Cow::Owned(source))
    } else {
        Ok(std::borrow::Cow::Borrowed(input))
    }
}

pub(super) fn load_result(
    connection: &Connection,
    input: &FixedInput,
    result: ExecutionId,
) -> Result<FixedResult, ExecutionError> {
    let reused = input
        .envelope()
        .reused_results
        .iter()
        .find(|r| r.result_id == result);
    let result_input = result_input(connection, input, result)?;
    let (bytes,digest,item,token): (Vec<u8>,String,String,String) = connection.query_row(
        "SELECT CASE WHEN length(bytes)<=?3 THEN bytes END,digest,item_id,dispatch_token FROM execution_results WHERE result_id=?1 AND attempt_id=?2",
        params![result.to_string(),result_input.envelope().attempt_id.to_string(),i64::from(result_input.envelope().limits.max_result_bytes)], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
    let result_value = FixedResult::restore(&bytes, &digest, &result_input, parse_id(token)?)?;
    if reused.is_some_and(|reference| {
        reference.item_id != result_value.envelope().item_id
            || result_value.envelope().outcome != ExecutionState::Succeeded
    }) {
        return Err(error(ErrorCode::CorruptLedger, "reused-result"));
    }
    if result_value.envelope().result_id != result
        || result_value.envelope().item_id.to_string() != item
    {
        return Err(error(ErrorCode::CorruptLedger, "result-association"));
    }
    super::plugin_execution::validate_result_in(connection, &result_input, &result_value)?;
    Ok(result_value)
}

/// Restores associated immutable result pairs in one bounded history read.
/// Each full frame is released before the next row rather than retaining the
/// product of scope size and complete plugin input size. Historical reads issue
/// no grant; a failed visit discards the caller's read projection.
pub(super) fn visit_result_pairs(
    connection: &Connection,
    pairs: &[(ExecutionId, ExecutionId)],
    mut visit: impl FnMut(ResultValidationCapture) -> Result<(), ExecutionError>,
) -> Result<(), ExecutionError> {
    if pairs.is_empty() {
        return Ok(());
    }
    if pairs.len() > 10_000 {
        return Err(error(ErrorCode::LimitExceeded, "result-pairs"));
    }
    let wanted =
        serde_json::to_string(pairs).map_err(|_| error(ErrorCode::InvalidInput, "result-pairs"))?;
    let mut statement = connection.prepare(&format!(
        "WITH wanted AS (SELECT json_extract(value,'$[0]') attempt,json_extract(value,'$[1]') result FROM json_each(?1))
         SELECT a.attempt_id,{},a.digest,a.task_id,a.project_id,
                a.previous_attempt_id,r.result_id,CASE WHEN length(r.bytes)<=?2 THEN r.bytes END,r.digest,r.item_id,r.dispatch_token,{}
         FROM wanted w JOIN execution_attempts a ON a.attempt_id=w.attempt
         JOIN execution_results r ON r.attempt_id=a.attempt_id AND r.result_id=w.result",
         input_storage::reconstruct_sql(), input_storage::metadata_sql()
    )).map_err(sql_error)?;
    let rows = statement
        .query_map(params![wanted, MAX_RESULT_BYTES as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<Vec<u8>>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Vec<u8>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, Option<Vec<u8>>>(11)?,
            ))
        })
        .map_err(sql_error)?;
    let mut restored = 0;
    for row in rows {
        let (
            attempt,
            bytes,
            digest,
            task,
            project,
            previous,
            result,
            result_bytes,
            result_digest,
            item,
            token,
            metadata,
        ) = row.map_err(sql_error)?;
        let input = input_storage::restore(metadata, bytes, &digest)?;
        check_input_association(
            &input,
            parse_id(attempt)?,
            &task,
            &project,
            previous.as_deref(),
        )?;
        let fixed = FixedResult::restore(&result_bytes, &result_digest, &input, parse_id(token)?)?;
        if fixed.envelope().result_id.to_string() != result
            || fixed.envelope().item_id.to_string() != item
        {
            return Err(error(ErrorCode::CorruptLedger, "result-association"));
        }
        visit(ResultValidationCapture {
            input,
            result: fixed,
        })?;
        restored += 1;
    }
    if restored != pairs.len() {
        return Err(error(ErrorCode::CorruptLedger, "result-pairs"));
    }
    Ok(())
}
// Comparing with a verified immutable frame is as strong as restoring its
// digest again, while avoiding repeated SDK decoding/structural qualification.
fn check_stored_input(connection: &Connection, input: &FixedInput) -> Result<(), ExecutionError> {
    let stored = read_stored_input(connection, input.envelope().attempt_id)?;
    let bytes = input_storage::reconstructed_bytes(stored.metadata, stored.bytes)?;
    if stored.digest != input.digest() || bytes != input.bytes() {
        return Err(error(ErrorCode::CorruptLedger, "input-bytes"));
    }
    check_input_association(
        input,
        input.envelope().attempt_id,
        &stored.task,
        &stored.project,
        stored.previous.as_deref(),
    )
}
fn check_stored_result(
    connection: &Connection,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    let expected = result.envelope();
    let (bytes,digest,item,token): (Vec<u8>,String,String,String) = connection.query_row(
        "SELECT CASE WHEN length(bytes)<=?3 THEN bytes END,digest,item_id,dispatch_token FROM execution_results WHERE result_id=?1 AND attempt_id=?2",
        params![expected.result_id.to_string(),expected.attempt_id.to_string(),MAX_RESULT_BYTES as i64],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
    if digest != result.digest()
        || bytes != result.bytes()
        || item != expected.item_id.to_string()
        || token != expected.dispatch_token.to_string()
    {
        return Err(error(ErrorCode::CorruptLedger, "result-bytes"));
    }
    Ok(())
}
fn read_attempt(
    connection: &Connection,
    attempt: ExecutionId,
    active: bool,
) -> Result<AttemptView, ExecutionError> {
    let input = load_input(connection, attempt)?;
    read_attempt_in(connection, &input, active)
}

// Opening has already restored this exact frame in its read snapshot. Reuse
// that capture rather than decoding the complete input a second time.
fn read_attempt_in(
    connection: &Connection,
    input: &FixedInput,
    active: bool,
) -> Result<AttemptView, ExecutionError> {
    let attempt = input.envelope().attempt_id;
    check_translation_projection(connection, input, None)?;
    let envelope = input.envelope();
    let cancellation_revision = cancel_revision(connection, envelope.task_id)?;
    let captured: i64 = connection
        .query_row(
            "SELECT cancellation_revision FROM execution_attempts WHERE attempt_id=?1",
            [attempt.to_string()],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    let mut statement = connection.prepare("SELECT item_id,execution,validation,adoption,retry_safe,diagnostic,dispatch_token,current_result_id FROM execution_items WHERE attempt_id=?1 ORDER BY item_id").map_err(sql_error)?;
    let rows = statement
        .query_map([attempt.to_string()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(sql_error)?;
    let mut items = Vec::new();
    for row in rows {
        let (id, execution, validation, adoption, retry_safe, diagnostic, token, result) =
            row.map_err(sql_error)?;
        let item_id = parse_id(id)?;
        input.item(item_id)?;
        let mut state: ExecutionState = decode_enum(execution)?;
        let mut validation: ValidationState = decode_enum(validation)?;
        let adoption: AdoptionState = decode_enum(adoption)?;
        let reused = envelope
            .reused_results
            .iter()
            .find(|reference| reference.item_id == item_id);
        if reused.is_some()
            && (token.is_some()
                || state != ExecutionState::Succeeded
                || reused.map(|reference| reference.result_id.to_string()) != result)
        {
            return Err(error(ErrorCode::CorruptLedger, "reused-state"));
        }
        if reused.is_none()
            && matches!(
                state,
                ExecutionState::Queued | ExecutionState::CancelledBeforeDispatch
            ) != token.is_none()
        {
            return Err(error(ErrorCode::CorruptLedger, "dispatch-association"));
        }
        if !active && state == ExecutionState::Dispatched {
            state = ExecutionState::Unknown;
        }
        if let Some(result) = result {
            match load_result(connection, input, parse_id(result)?) {
                Ok(output)
                    if output.envelope().item_id == item_id
                        && output.envelope().outcome == state
                        && output
                            .envelope()
                            .diagnostic
                            .as_ref()
                            .is_some_and(|value| value.retry_safe)
                            == retry_safe =>
                {
                    if validation == ValidationState::Valid && requires_semantic_check(input) {
                        validate_plugin_link(connection, input, &output, true)?;
                    }
                }
                _ => validation = ValidationState::Invalid,
            }
        } else if validation != ValidationState::Absent || state == ExecutionState::Succeeded {
            return Err(error(ErrorCode::CorruptLedger, "result-missing"));
        }
        if adoption == AdoptionState::Committed {
            if state != ExecutionState::Succeeded || validation != ValidationState::Valid {
                return Err(error(ErrorCode::CorruptLedger, "committed-result-state"));
            }
            let unit = envelope
                .units
                .iter()
                .find(|unit| unit.item_ids.contains(&item_id))
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "unit"))?;
            let has_receipt:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM adoption_receipts WHERE attempt_id=?1 AND unit_id=?2)",params![attempt.to_string(),unit.unit_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
            if !has_receipt {
                return Err(error(ErrorCode::CorruptLedger, "missing-receipt"));
            }
        }
        items.push(ItemStatus {
            item_id,
            execution: state,
            validation,
            adoption,
            retry_safe,
            diagnostic,
            cancellation_requested: cancellation_revision.get() > captured as u64,
        });
    }
    if items.len() != envelope.items.len() {
        return Err(error(ErrorCode::CorruptLedger, "item-coverage"));
    }
    let progress = Progress::from_items(&items);
    Ok(AttemptView {
        attempt_id: attempt,
        task_id: envelope.task_id,
        operation: envelope.operation.clone(),
        cancellation_revision,
        items,
        progress,
    })
}

fn load_check_link(
    connection: &Connection,
    result: &FixedResult,
) -> Result<(FixedInput, FixedResult, bool), ExecutionError> {
    let (checker_id, saved_valid): (String, bool) = connection.query_row(
        "SELECT checker_result_id,valid FROM plugin_validation_links WHERE producer_result_id=?1",
        [result.envelope().result_id.to_string()], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| error(ErrorCode::CorruptLedger, "semantic-validation-link"))?;
    let (check_input, check_result) = load_check_frames(connection, &checker_id)?;
    Ok((check_input, check_result, saved_valid))
}

fn load_check_frames(
    connection: &Connection,
    checker_id: &str,
) -> Result<(FixedInput, FixedResult), ExecutionError> {
    let checker_attempt: String = connection
        .query_row(
            "SELECT attempt_id FROM execution_results WHERE result_id=?1",
            [checker_id],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    let check_input = load_input(connection, parse_id(checker_attempt)?)?;
    let check_result = load_result(connection, &check_input, parse_id(checker_id.to_owned())?)?;
    Ok((check_input, check_result))
}

pub(super) fn artifact_check_proof_in(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<Option<super::release::SavedArtifactCheckProof>, ExecutionError> {
    let original = result_input(connection, input, result.envelope().result_id)?;
    let plan = crate::ReleasePlan::from_input(original.as_ref())?;
    plan.validate_source_reference(connection)?;
    let link: Option<(String, bool)> = connection.query_row(
        "SELECT checker_result_id,valid FROM plugin_validation_links WHERE producer_result_id=?1",
        [result.envelope().result_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(sql_error)?;
    let Some((checker_id, saved_valid)) = link else {
        return Ok(None);
    };
    let (check_input, check_result) = load_check_frames(connection, &checker_id)?;
    let prepared = ArtifactValidationCapture::restore(
        ResultValidationCapture {
            input: original.as_ref().clone(),
            result: result.clone(),
        },
        check_input.clone(),
    )?
    .prepare(check_result.clone())?;
    if prepared.valid() != saved_valid {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
    }
    let checker = check_input
        .envelope()
        .plugin
        .clone()
        .ok_or_else(|| error(ErrorCode::CorruptLedger, "artifact-check-provider"))?;
    // A negative proof can intentionally retain a failed or malformed report.
    // None describes unavailable report data, never an empty passing check set.
    let checks = match check_result
        .envelope()
        .plugin
        .as_ref()
        .map(|p| &p.result.outcome)
    {
        Some(tsumugi_plugin_sdk::InvocationOutcome::Succeeded { output }) => {
            match tsumugi_plugin_sdk::parse_check_results(output.utf8.as_bytes()) {
                Ok(checks) => Some(checks),
                Err(_) if !saved_valid => None,
                Err(_) => return Err(error(ErrorCode::CorruptLedger, "artifact-check-report")),
            }
        }
        _ if !saved_valid => None,
        _ => return Err(error(ErrorCode::CorruptLedger, "artifact-check-report")),
    };
    Ok(Some(super::release::SavedArtifactCheckProof {
        checker_attempt_id: check_input.envelope().attempt_id,
        checker_input_digest: check_input.digest().into(),
        checker_result_id: check_result.envelope().result_id,
        checker_result_digest: check_result.digest().into(),
        checker,
        valid: saved_valid,
        checks,
    }))
}

pub(super) fn validate_source_link(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    expected_valid: bool,
) -> Result<PreparedSourceValidation, ExecutionError> {
    use std::sync::{Mutex, OnceLock};
    // Memoize only pure immutable source qualification, bounded to one proof.
    // Each reuse checks all four original frames and row associations, plus
    // the current proof link. Execution grants/currentness are never cached.
    static CACHE: OnceLock<Mutex<Option<PreparedSourceValidation>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let (checker_id, saved_valid): (String, bool) = connection.query_row(
        "SELECT checker_result_id,valid FROM plugin_validation_links WHERE producer_result_id=?1",
        [result.envelope().result_id.to_string()], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| error(ErrorCode::CorruptLedger, "semantic-validation-link"))?;
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|prepared| {
            prepared.capture.source.result.envelope().result_id == result.envelope().result_id
                && prepared.check_result.envelope().result_id.to_string() == checker_id
        })
        .cloned();
    if let Some(prepared) = cached {
        let source = &prepared.capture.source;
        if source.input.digest() != input.digest()
            || source.input.bytes() != input.bytes()
            || source.result.digest() != result.digest()
            || source.result.bytes() != result.bytes()
            || saved_valid != expected_valid
            || prepared.proof.valid != saved_valid
        {
            return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
        }
        check_stored_input(connection, &source.input)?;
        check_stored_result(connection, &source.result)?;
        check_stored_input(connection, &prepared.capture.check_input)?;
        check_stored_result(connection, &prepared.check_result)?;
        return Ok(prepared);
    }
    let (check_input, check_result) = load_check_frames(connection, &checker_id)?;
    let prepared = SourceValidationCapture::restore(
        ResultValidationCapture {
            input: input.clone(),
            result: result.clone(),
        },
        check_input,
    )?
    .prepare(check_result)?;
    if saved_valid != expected_valid || prepared.proof.valid != saved_valid {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
    }
    *cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(prepared.clone());
    Ok(prepared)
}

pub(super) fn validate_plugin_link(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    expected_valid: bool,
) -> Result<(), ExecutionError> {
    let original = result_input(connection, input, result.envelope().result_id)?;
    let input = original.as_ref();
    if input.envelope().operation == crate::content::OPERATION {
        validate_source_link(connection, input, result, expected_valid)?;
        return Ok(());
    }
    if input.envelope().operation == crate::content::TRANSLATION_EXTRACTION_OPERATION {
        validate_translation_link(connection, input, result, expected_valid)?;
        return Ok(());
    }
    if input.envelope().plugin.is_none()
        || input.envelope().operation != crate::content::BUILD_OPERATION
    {
        return Err(error(
            ErrorCode::CorruptLedger,
            "semantic-validation-operation",
        ));
    }
    let (check_input, check_result, saved_valid) = load_check_link(connection, result)?;
    let prepared = ArtifactValidationCapture::restore(
        ResultValidationCapture {
            input: input.clone(),
            result: result.clone(),
        },
        check_input,
    )?
    .prepare(check_result)?;
    if saved_valid != expected_valid || prepared.proof.valid != saved_valid {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
    }
    Ok(())
}

pub(super) fn validate_translation_link(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    expected_valid: bool,
) -> Result<PreparedTranslationValidation, ExecutionError> {
    let (check_input, check_result, saved_valid) = load_check_link(connection, result)?;
    let prepared = TranslationValidationCapture::restore(
        ResultValidationCapture {
            input: input.clone(),
            result: result.clone(),
        },
        check_input,
    )?
    .prepare(check_result)?;
    if saved_valid != expected_valid || prepared.proof.valid != saved_valid {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
    }
    Ok(prepared)
}

/// Restore immutable qualification independently of mutable current check links.
/// Historical reads preserve exact original proof; new writes also require the
/// current producer/checker results, link and both live execution grants.
pub(super) fn check_translation_projection(
    connection: &Connection,
    input: &FixedInput,
    authority: Option<&crate::execution::plugin_authority::PluginAuthority>,
) -> Result<(), ExecutionError> {
    if !crate::content::is_translation_projection(input) {
        return Ok(());
    }
    let projection = crate::content::TranslationProjection::from_input(input)?;
    let origin = &projection.origin;
    use std::sync::{Mutex, OnceLock};
    type Frames = (FixedInput, FixedResult, FixedInput, FixedResult);
    // Bounded memoization of pure qualification. All four persisted byte frames
    // and row associations are compared on every reuse; no permission, current
    // result, link or cancellation state is cached.
    static CACHE: OnceLock<Mutex<Option<(String, Frames)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(digest, _)| digest == input.digest())
        .map(|(_, frames)| frames.clone());
    let (producer, result, checker, checked) = if let Some(frames) = cached {
        check_stored_input(connection, &frames.0)?;
        check_stored_result(connection, &frames.1)?;
        check_stored_input(connection, &frames.2)?;
        check_stored_result(connection, &frames.3)?;
        frames
    } else {
        let producer = load_input(connection, origin.producer_attempt)?;
        let result = load_result(connection, &producer, origin.producer_result)?;
        let checker = load_input(connection, origin.checker_attempt)?;
        let checked = load_result(connection, &checker, origin.checker_result)?;
        if producer.envelope().project_id != input.envelope().project_id
            || checker.envelope().project_id != input.envelope().project_id
        {
            return Err(error(
                ErrorCode::Unauthorized,
                "translation-projection-project",
            ));
        }
        let rebuilt = crate::content::TranslationProjection::capture(
            &producer,
            &result,
            &checker,
            &checked,
            projection.bundle_id,
            projection.file.artifact_id,
        )?;
        if rebuilt != *projection {
            return Err(error(
                ErrorCode::ResultMismatch,
                "translation-projection-origin",
            ));
        }
        let prepared = TranslationValidationCapture::restore(
            ResultValidationCapture {
                input: producer.clone(),
                result: result.clone(),
            },
            checker.clone(),
        )?
        .prepare(checked.clone())?;
        if !prepared.proof.valid {
            return Err(error(
                ErrorCode::OutputInvalid,
                "translation-projection-proof",
            ));
        }
        let frames = (producer, result, checker, checked);
        *cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((input.digest().into(), frames.clone()));
        frames
    };
    if let Some(authority) = authority {
        for (input, result) in [(&producer, &result), (&checker, &checked)] {
            require_current_result(connection, input, result)?;
            let permit = super::plugin_execution::check_input_in(connection, input, authority)?;
            if permit.as_ref().map(PluginPermit::grant_id)
                != result
                    .envelope()
                    .plugin
                    .as_ref()
                    .map(|e| e.authorization_id)
            {
                return Err(error(
                    ErrorCode::Unauthorized,
                    "translation-projection-grant",
                ));
            }
            let captured_cancel: i64 = connection
                .query_row(
                    "SELECT cancellation_revision FROM execution_attempts WHERE attempt_id=?1",
                    [input.envelope().attempt_id.to_string()],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if cancel_revision(connection, input.envelope().task_id)?.get()
                != captured_cancel as u64
            {
                return Err(error(ErrorCode::Cancelled, "translation-projection-origin"));
            }
        }
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_validation_links l JOIN execution_items i ON i.current_result_id=l.producer_result_id
             WHERE l.producer_result_id=?1 AND l.checker_result_id=?2 AND l.valid=1 AND i.validation='valid')",
            params![origin.producer_result.to_string(), origin.checker_result.to_string()], |row| row.get(0),
        ).map_err(sql_error)?;
        if !valid {
            return Err(error(
                ErrorCode::DependencyConflict,
                "translation-projection-current-proof",
            ));
        }
    }
    Ok(())
}

/// Complete Core projection coverage, with bounded decoding reuse. Every call
/// reads all current row states, dispatch associations and complete result bytes;
/// cached pure output validation is usable only for identical immutable frames.
fn complete_translation_projection(
    connection: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    use std::sync::{Arc, Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<Option<(String, Arc<Vec<FixedResult>>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(digest, _)| digest == input.digest())
        .map(|(_, results)| results.clone());
    let units: std::collections::BTreeMap<_, _> = input
        .envelope()
        .units
        .iter()
        .flat_map(|unit| unit.item_ids.iter().map(move |item| (*item, unit.unit_id)))
        .collect();
    let mut statement = connection
        .prepare("SELECT unit_id FROM adoption_receipts WHERE attempt_id=?1 LIMIT ?2")
        .map_err(sql_error)?;
    let receipts = statement
        .query_map(
            params![
                input.envelope().attempt_id.to_string(),
                (input.envelope().units.len() + 1) as i64
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(sql_error)?
        .map(|row| parse_id(row.map_err(sql_error)?))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    if receipts.len() > input.envelope().units.len() {
        return Err(error(ErrorCode::CorruptLedger, "receipt-coverage"));
    }
    let mut statement=connection.prepare(
        "SELECT i.item_id,i.current_result_id,i.execution,i.validation,r.dispatch_token,r.digest,
         CASE WHEN length(r.bytes)<=?2 THEN r.bytes END,i.retry_safe,i.adoption FROM execution_items i
         LEFT JOIN execution_results r ON r.result_id=i.current_result_id AND r.attempt_id=i.attempt_id
            AND r.item_id=i.item_id AND r.dispatch_token=i.dispatch_token
         WHERE i.attempt_id=?1 ORDER BY i.item_id").map_err(sql_error)?;
    let mut rows = statement
        .query(params![
            input.envelope().attempt_id.to_string(),
            i64::from(input.envelope().limits.max_result_bytes)
        ])
        .map_err(sql_error)?;
    let mut results = Vec::with_capacity(input.envelope().items.len());
    let mut total = 0usize;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let item: String = row.get(0).map_err(sql_error)?;
        if input
            .envelope()
            .items
            .get(results.len())
            .is_none_or(|expected| expected.item_id.to_string() != item)
        {
            return Err(error(ErrorCode::CorruptLedger, "translation-coverage"));
        }
        let execution: String = row.get(2).map_err(sql_error)?;
        let validation: String = row.get(3).map_err(sql_error)?;
        if execution != "succeeded" || validation != "valid" {
            return Err(error(
                ErrorCode::DependencyConflict,
                "translation-incomplete",
            ));
        }
        let id: String = row.get(1).map_err(sql_error)?;
        let token: String = row.get(4).map_err(sql_error)?;
        let digest: String = row.get(5).map_err(sql_error)?;
        let bytes: Vec<u8> = row.get(6).map_err(sql_error)?;
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| error(ErrorCode::LimitExceeded, "translation-results"))?;
        if total > input.envelope().limits.max_attempt_result_bytes as usize {
            return Err(error(ErrorCode::LimitExceeded, "translation-results"));
        }
        let previous = cached.as_ref().and_then(|values| values.get(results.len()));
        let result = if let Some(previous) = previous.filter(|previous| {
            previous.envelope().result_id.to_string() == id
                && previous.digest() == digest
                && previous.envelope().dispatch_token.to_string() == token
        }) {
            if bytes != previous.bytes() {
                return Err(error(ErrorCode::CorruptLedger, "translation-result-bytes"));
            }
            previous.clone()
        } else {
            let result = FixedResult::restore(&bytes, &digest, input, parse_id(token)?)?;
            if result.envelope().result_id.to_string() != id
                || result.envelope().item_id.to_string() != item
            {
                return Err(error(
                    ErrorCode::CorruptLedger,
                    "translation-result-association",
                ));
            }
            crate::content::validate_translation_output(input, &result)?;
            result
        };
        let retry_safe: bool = row.get(7).map_err(sql_error)?;
        if result
            .envelope()
            .diagnostic
            .as_ref()
            .is_some_and(|diagnostic| diagnostic.retry_safe)
            != retry_safe
        {
            return Err(error(ErrorCode::CorruptLedger, "result-state"));
        }
        let adoption: AdoptionState = decode_enum(row.get(8).map_err(sql_error)?)?;
        if adoption == AdoptionState::Committed
            && units
                .get(&result.envelope().item_id)
                .is_none_or(|unit| !receipts.contains(unit))
        {
            return Err(error(ErrorCode::CorruptLedger, "missing-receipt"));
        }
        results.push(result);
    }
    if results.len() != input.envelope().items.len() {
        return Err(error(ErrorCode::CorruptLedger, "translation-coverage"));
    }
    *cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((input.digest().into(), Arc::new(results)));
    Ok(())
}

impl ProjectStore {
    /// Keep the caller's original projection attempt across uncertain submission
    /// outcomes. Existing inputs must retain the exact producer/result origin;
    /// reading them never renews either plugin grant.
    pub fn capture_translation_projection_with_id(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
        projection_attempt: ExecutionId,
    ) -> Result<FixedInput, ExecutionError> {
        match self.execution_input(projection_attempt) {
            Ok(input) => {
                let projection = crate::content::TranslationProjection::from_input(&input)?;
                if projection.origin.producer_attempt != attempt
                    || projection.origin.producer_result != result
                {
                    return Err(error(
                        ErrorCode::ResultMismatch,
                        "translation-projection-origin",
                    ));
                }
                let connection = self.execution_connection()?;
                check_translation_projection(connection, &input, Some(&self.plugin_authority))?;
                let producer = load_input(connection, attempt)?;
                super::translation::record_input(connection, &producer)?;
                Ok(input)
            }
            Err(error) if error.code == ErrorCode::InvalidInput => {
                let input = self.capture_translation_projection(attempt, result)?;
                let mut envelope = input.envelope().clone();
                envelope.attempt_id = projection_attempt;
                FixedInput::capture(envelope)
            }
            Err(error) => Err(error),
        }
    }

    /// Capture once and reuse this exact input for retries. It retains one whole
    /// file and one compact entry set; each EX item only references its ordinal.
    pub fn capture_translation_projection(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<FixedInput, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-projection"))?;
        let producer = load_input(connection, attempt)?;
        let result = load_result(connection, &producer, result)?;
        require_current_result(connection, &producer, &result)?;
        let validation: String = connection
            .query_row(
                "SELECT validation FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![attempt.to_string(), result.envelope().item_id.to_string()],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        match decode_enum::<ValidationState>(validation)? {
            ValidationState::Pending => {
                return Err(error(
                    ErrorCode::DependencyConflict,
                    "translation-check-incomplete",
                ));
            }
            ValidationState::Invalid => {
                return Err(error(ErrorCode::OutputInvalid, "translation-check-invalid"));
            }
            ValidationState::Absent => {
                return Err(error(ErrorCode::CorruptLedger, "result-state"));
            }
            ValidationState::Valid => {}
        }
        // Only qualified results promise a durable proof link. Missing proof
        // after successful qualification remains corruption, not a pending check.
        let prepared = validate_translation_link(connection, &producer, &result, true)?;
        let projection = crate::content::TranslationProjection::capture(
            &producer,
            &result,
            &prepared.capture.check_input,
            &prepared.check_result,
            ExecutionId::new(),
            ExecutionId::new(),
        )?;
        let project: crate::ProjectId = producer
            .envelope()
            .project_id
            .to_string()
            .parse()
            .map_err(|_| error(ErrorCode::InvalidInput, "translation-project"))?;
        let input = projection.fixed_input(project)?;
        check_translation_projection(connection, &input, Some(&self.plugin_authority))?;
        super::translation::record_input(connection, &producer)?;
        Ok(input)
    }
    #[cfg(feature = "execution-test-host")]
    pub fn install_execution_fixture(&mut self, ids: &[String]) -> Result<(), ExecutionError> {
        let tx = self.execution_write()?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='fixture_targets')",
                [],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if !exists {
            tx.execute_batch(crate::execution::test_support::TARGET_SCHEMA)
                .map_err(sql_error)?;
        }
        for id in ids {
            tx.execute("INSERT INTO fixture_targets VALUES (?1,1,'original')", [id])
                .map_err(sql_error)?;
        }
        commit(tx)
    }
    pub fn execution_current_result(
        &self,
        attempt: ExecutionId,
        item: ExecutionId,
    ) -> Result<Option<ExecutionId>, ExecutionError> {
        let id: Option<String> = self
            .execution_connection()?
            .query_row(
                "SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![attempt.to_string(), item.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        id.map(parse_id).transpose()
    }
    pub fn execution_recovery(
        &self,
        attempt: ExecutionId,
        active: bool,
    ) -> Result<RecoveryPlan, ExecutionError> {
        let input = self.execution_input(attempt)?;
        let view = self.execution_attempt(attempt, active)?;
        let connection = self.execution_connection()?;
        let metadata = self
            .metadata()
            .map_err(|_| error(ErrorCode::CorruptLedger, "project"))?;
        let mut units = Vec::new();
        for unit in &input.envelope().units {
            let statuses = unit
                .item_ids
                .iter()
                .map(|id| {
                    view.items
                        .iter()
                        .find(|item| item.item_id == *id)
                        .ok_or_else(|| error(ErrorCode::CorruptLedger, "unit"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut entry = RecoveryUnit {
                unit_id: unit.unit_id,
                item_ids: unit.item_ids.clone(),
                scopes: unit
                    .item_ids
                    .iter()
                    .map(|id| input.item(*id).map(|item| item.scope.clone()))
                    .collect::<Result<Vec<_>, _>>()?,
                remaining_item_ids: Vec::new(),
                result_ids: Vec::new(),
                actions: Vec::new(),
                blocked_reason: None,
                receipt_id: None,
            };
            for item in &statuses {
                if let Some(id) = self.execution_current_result(attempt, item.item_id)? {
                    entry.result_ids.push(id);
                }
            }
            let receipt: Option<String> = connection
                .query_row(
                    "SELECT action_id FROM adoption_receipts WHERE attempt_id=?1 AND unit_id=?2",
                    params![attempt.to_string(), unit.unit_id.to_string()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(sql_error)?;
            if let Some(receipt) = receipt {
                entry.receipt_id = Some(parse_id(receipt)?);
                entry.actions.push(RecoveryAction::ViewReceipt);
                units.push(entry);
                continue;
            }
            let mut newer = false;
            for id in &unit.item_ids {
                let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM execution_items i JOIN execution_attempts a ON i.attempt_id=a.attempt_id WHERE a.task_id=?1 AND i.item_id=?2 AND a.sequence>(SELECT sequence FROM execution_attempts WHERE attempt_id=?3))",params![input.envelope().task_id.to_string(),id.to_string(),attempt.to_string()],|r|r.get(0)).map_err(sql_error)?;
                newer |= exists;
            }
            if newer {
                entry.blocked_reason = Some("continued-in-new-attempt".into());
            } else if unit.item_ids.iter().any(|id| {
                input
                    .item(*id)
                    .ok()
                    .and_then(|item| item.scope.locale.as_ref())
                    .is_some_and(|locale| {
                        !metadata
                            .target_locales()
                            .iter()
                            .any(|target| target.as_str() == locale)
                    })
            }) {
                entry.blocked_reason = Some("scope-removed".into());
            } else if statuses
                .iter()
                .any(|item| item.execution == ExecutionState::Dispatched)
            {
                entry.blocked_reason = Some("still-running".into());
            } else if statuses
                .iter()
                .any(|item| item.execution == ExecutionState::Unknown)
            {
                entry.actions.push(RecoveryAction::QueryOutcome);
                entry.remaining_item_ids = statuses
                    .iter()
                    .filter(|item| item.execution == ExecutionState::Unknown)
                    .map(|item| item.item_id)
                    .collect();
                entry.blocked_reason = Some("outcome-unknown".into());
            } else if statuses
                .iter()
                .any(|item| item.validation == ValidationState::Invalid)
            {
                entry.blocked_reason = Some("output-invalid".into());
            } else if statuses
                .iter()
                .any(|item| item.validation == ValidationState::Pending)
            {
                if input.envelope().plugin.is_some() {
                    // Plugin output requires its independently authorized
                    // semantic checker. The generic mutation refuses it.
                    entry.blocked_reason = Some("external-new-consent".into());
                } else {
                    entry.actions.push(RecoveryAction::ValidateOutput);
                }
                entry.remaining_item_ids = statuses
                    .iter()
                    .filter(|item| item.validation == ValidationState::Pending)
                    .map(|item| item.item_id)
                    .collect();
            } else if statuses.iter().all(|item| {
                item.execution == ExecutionState::Succeeded
                    && item.validation == ValidationState::Valid
            }) {
                entry.actions.push(RecoveryAction::AdoptResult);
            } else {
                let remaining: Vec<_> = statuses
                    .iter()
                    .filter(|item| item.execution != ExecutionState::Succeeded)
                    .collect();
                if remaining.iter().all(|item| {
                    matches!(
                        item.execution,
                        ExecutionState::Queued | ExecutionState::CancelledBeforeDispatch
                    ) || (item.execution == ExecutionState::Failed && item.retry_safe)
                }) {
                    entry.remaining_item_ids = remaining.iter().map(|item| item.item_id).collect();
                    entry.actions.push(
                        if remaining
                            .iter()
                            .any(|item| item.execution == ExecutionState::Failed)
                        {
                            RecoveryAction::RetrySafeFailure
                        } else {
                            RecoveryAction::ResumeUndispatched
                        },
                    );
                } else {
                    entry.blocked_reason = Some("retry-not-safe".into());
                }
            }
            if !provider::recovery_policy(connection, attempt)?.allows_replay() {
                if entry.actions.iter().any(|a| {
                    matches!(
                        a,
                        RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure
                    )
                }) {
                    entry.blocked_reason = Some("external-new-consent".into());
                }
                entry.actions.retain(|a| {
                    !matches!(
                        a,
                        RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure
                    )
                });
            }
            units.push(entry);
        }
        Ok(RecoveryPlan {
            attempt_id: attempt,
            units,
        })
    }
    /// Builds a new immutable attempt, preserving successful members of selected
    /// consistency units as verified references instead of dispatching them again.
    pub fn execution_retry_input(
        &self,
        attempt: ExecutionId,
        item_ids: &[ExecutionId],
    ) -> Result<FixedInput, ExecutionError> {
        let input = self.execution_input(attempt)?;
        let plan = self.execution_recovery(attempt, false)?;
        let selected: std::collections::BTreeSet<_> = item_ids.iter().copied().collect();
        if selected.is_empty() || selected.len() != item_ids.len() {
            return Err(error(ErrorCode::InvalidInput, "retry-scope"));
        }
        let mut covered = std::collections::BTreeSet::new();
        let mut reused = Vec::new();
        for unit in &plan.units {
            if !unit.item_ids.iter().any(|id| selected.contains(id)) {
                continue;
            }
            if !unit.actions.iter().any(|action| {
                matches!(
                    action,
                    RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure
                )
            }) || !unit
                .remaining_item_ids
                .iter()
                .all(|id| selected.contains(id))
                || unit
                    .item_ids
                    .iter()
                    .any(|id| selected.contains(id) && !unit.remaining_item_ids.contains(id))
            {
                return Err(error(ErrorCode::Unauthorized, "retry-eligibility"));
            }
            for id in &unit.remaining_item_ids {
                covered.insert(*id);
            }
            for id in &unit.item_ids {
                if !selected.contains(id) {
                    let result_id = self
                        .execution_current_result(attempt, *id)?
                        .ok_or_else(|| error(ErrorCode::OutputInvalid, "reused-result"))?;
                    let result = self.execution_result(attempt, result_id)?;
                    reused.push(ReusedResult {
                        item_id: *id,
                        source_attempt_id: result.envelope().attempt_id,
                        result_id,
                    });
                }
            }
        }
        if covered != selected {
            return Err(error(ErrorCode::InvalidInput, "retry-scope"));
        }
        input.retry_with_reused(item_ids, reused)
    }
    pub fn execution_sequence(&self) -> Result<Revision, ExecutionError> {
        let sequence: i64 = self
            .execution_connection()?
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM execution_attempts",
                [],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        Revision::new(sequence as u64)
    }
    /// Only attempts submitted during this runtime's lifetime are scheduled.
    /// Older work requires an explicit recovery request creating a new attempt.
    pub fn queued_execution_attempts(
        &self,
        after: Revision,
    ) -> Result<Vec<ExecutionId>, ExecutionError> {
        let mut statement=self.execution_connection()?.prepare("SELECT a.attempt_id FROM execution_attempts a WHERE a.sequence>?1 AND EXISTS(SELECT 1 FROM execution_items i WHERE i.attempt_id=a.attempt_id AND i.execution='queued') ORDER BY a.sequence LIMIT 128").map_err(sql_error)?;
        statement
            .query_map([after.get() as i64], |r| r.get::<_, String>(0))
            .map_err(sql_error)?
            .map(|row| parse_id(row.map_err(sql_error)?))
            .collect()
    }
    pub(crate) fn queued_execution_item_count(
        &self,
        after: Revision,
    ) -> Result<usize, ExecutionError> {
        self.execution_connection()?.query_row("SELECT COUNT(*) FROM execution_items i JOIN execution_attempts a USING(attempt_id) WHERE a.sequence>?1 AND i.execution='queued'",[after.get() as i64],|r|r.get::<_,u32>(0)).map(|n|n as usize).map_err(sql_error)
    }
    pub(crate) fn next_queued_execution_item(
        &self,
        attempt: ExecutionId,
    ) -> Result<Option<ExecutionId>, ExecutionError> {
        self.execution_connection()?
            .query_row(
                "SELECT item_id FROM execution_items WHERE attempt_id=?1
                 AND execution='queued' ORDER BY rowid LIMIT 1",
                [attempt.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error)?
            .map(parse_id)
            .transpose()
    }
    pub fn execution_dispatch(
        &self,
        attempt: ExecutionId,
        item: ExecutionId,
    ) -> Result<DispatchRequest, ExecutionError> {
        let input = self.execution_input(attempt)?;
        let token: Option<String> = self
            .execution_connection()?
            .query_row(
                "SELECT dispatch_token FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![attempt.to_string(), item.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        let plugin_permit = if input.envelope().plugin.is_some() {
            Some(self.plugin_permit(&input)?)
        } else {
            None
        };
        Ok(DispatchRequest {
            provider: None,
            plugin_permit,
            service_origin: None,
            original_deadline: None,
            input,
            item_id: item,
            dispatch_token: parse_id(
                token.ok_or_else(|| error(ErrorCode::InvalidInput, "dispatch-token"))?,
            )?,
        })
    }
    pub fn note_execution_unknown(
        &mut self,
        attempt: ExecutionId,
        item: ExecutionId,
        reason: &str,
    ) -> Result<(), ExecutionError> {
        if reason.len() > 128 || reason.chars().any(char::is_control) {
            return Err(error(ErrorCode::InvalidInput, "diagnostic"));
        }
        let tx = self.execution_write()?;
        let changed=tx.execute("UPDATE execution_items SET execution='unknown',diagnostic=?3 WHERE attempt_id=?1 AND item_id=?2 AND execution='dispatched'",params![attempt.to_string(),item.to_string(),reason]).map_err(sql_error)?;
        if changed == 0 {
            load_input_cached(&tx, attempt)?.item(item)?;
        }
        commit(tx)
    }
    fn execution_connection(&self) -> Result<&Connection, ExecutionError> {
        self.connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "session"))
    }
    pub(super) fn execution_write(&self) -> Result<ExecutionTransaction<'_>, ExecutionError> {
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "session"));
        }
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = rusqlite::Transaction::new_unchecked(
            self.execution_connection()?,
            TransactionBehavior::Immediate,
        )
        .map_err(sql_error)?;
        let observer = change_clock.observe(&tx, super::ChangeScope::Execution);
        Ok(ExecutionTransaction {
            tx,
            unknown,
            observer,
        })
    }

    pub fn reconcile_execution(&self) -> Result<(), ExecutionError> {
        let connection = self.execution_connection()?;
        if !connection.is_autocommit() {
            return Err(error(ErrorCode::OutcomeUnknown, "reconcile"));
        }
        validate(connection)?;
        super::content::validate(connection)?;
        super::translation::validate(connection)
            .map_err(|_| error(ErrorCode::CorruptLedger, "translation"))?;
        super::release::validate(connection)
            .map_err(|_| error(ErrorCode::CorruptLedger, "release"))?;
        super::application::validate(connection)?;
        self.execution_unknown
            .store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    pub fn enqueue_execution(&mut self, input: &FixedInput) -> Result<(), ExecutionError> {
        self.enqueue_execution_with_policy(input, RecoveryPolicy::ExternalUnknown, None)
    }
    /// Core-only operation with a reviewed read-only execution effect.
    pub fn enqueue_read_only_execution(
        &mut self,
        input: &FixedInput,
    ) -> Result<(), ExecutionError> {
        self.enqueue_execution_with_policy(input, RecoveryPolicy::ReadOnly, None)
    }
    pub(crate) fn enqueue_execution_with_policy(
        &mut self,
        input: &FixedInput,
        policy: RecoveryPolicy,
        parent: Option<ExecutionId>,
    ) -> Result<(), ExecutionError> {
        self.enqueue_execution_with_authority(input, policy, parent, None, None, None, None, None)
    }

    pub(crate) fn enqueue_work_plan_agent_generation(
        &mut self,
        prepared: &crate::application::PreparedWorkPlanAgentGeneration,
        policy: RecoveryPolicy,
    ) -> Result<(), ExecutionError> {
        self.check_prepared_agent_session(prepared)?;
        self.enqueue_execution_with_authority(
            prepared.input(),
            policy,
            Some(prepared.scope.parent_task()),
            None,
            None,
            Some(prepared),
            None,
            None,
        )
    }

    pub(crate) fn enqueue_work_plan_tool(
        &mut self,
        prepared: &crate::application::PreparedWorkPlanTool,
        consent: &crate::application::WorkPlanToolConsent,
        grant_id: ExecutionId,
        generation: ExecutionId,
        policy: RecoveryPolicy,
    ) -> Result<(), ExecutionError> {
        self.check_work_plan_tool_proposal(prepared, consent, generation)?;
        self.enqueue_execution_with_authority(
            &prepared.input,
            policy,
            None,
            Some((prepared, consent, grant_id, generation)),
            None,
            None,
            None,
            None,
        )
    }

    pub(crate) fn enqueue_work_plan_service_generation(
        &mut self,
        prepared: &crate::application::PreparedWorkPlanServiceGeneration,
        policy: RecoveryPolicy,
    ) -> Result<(), ExecutionError> {
        self.enqueue_execution_with_authority(
            prepared.input(),
            policy,
            Some(prepared.parent_task()),
            None,
            Some(prepared),
            None,
            None,
            None,
        )
    }

    pub(crate) fn enqueue_work_plan_service_tool(
        &mut self,
        prepared: &crate::application::PreparedWorkPlanServiceTool,
        consent: &crate::application::WorkPlanToolConsent,
        grant_id: ExecutionId,
        generation: ExecutionId,
        policy: RecoveryPolicy,
    ) -> Result<(), ExecutionError> {
        self.check_work_plan_tool_proposal(&prepared.prepared, consent, generation)?;
        self.enqueue_execution_with_authority(
            prepared.input(),
            policy,
            None,
            Some((&prepared.prepared, consent, grant_id, generation)),
            None,
            None,
            None,
            Some(prepared),
        )
    }

    pub(crate) fn enqueue_mcp_term_query(
        &mut self,
        prepared: &crate::application::PreparedMcpTermQuery,
        permit: &crate::application::McpTermQueryPermit,
    ) -> Result<(), ExecutionError> {
        self.check_mcp_term_query(prepared)?;
        permit.check_input(prepared.input())?;
        if permit.epoch != prepared.epoch {
            return Err(error(ErrorCode::Unauthorized, "mcp-query-session"));
        }
        self.enqueue_execution_with_authority(
            prepared.input(),
            RecoveryPolicy::ExternalUnknown,
            None,
            None,
            None,
            None,
            Some((prepared, permit)),
            None,
        )
    }

    fn enqueue_execution_with_authority(
        &mut self,
        input: &FixedInput,
        policy: RecoveryPolicy,
        parent: Option<ExecutionId>,
        tool: Option<(
            &crate::application::PreparedWorkPlanTool,
            &crate::application::WorkPlanToolConsent,
            ExecutionId,
            ExecutionId,
        )>,
        service: Option<&crate::application::PreparedWorkPlanServiceGeneration>,
        agent: Option<&crate::application::PreparedWorkPlanAgentGeneration>,
        mcp: Option<(
            &crate::application::PreparedMcpTermQuery,
            &crate::application::McpTermQueryPermit,
        )>,
        service_tool: Option<&crate::application::PreparedWorkPlanServiceTool>,
    ) -> Result<(), ExecutionError> {
        if (input.envelope().operation == crate::application::MCP_TERM_QUERY_OPERATION
            || input.envelope().capability_id == crate::application::MCP_TERM_QUERY_CAPABILITY)
            && mcp.is_none()
        {
            return Err(error(ErrorCode::Unauthorized, "mcp-query-admission"));
        }
        // Serialized provenance is data. Only the opaque Core preparation may
        // admit a new Agent input through the existing transaction below.
        if agent.is_none() && super::application::agent_binding(input)?.is_some() {
            return Err(error(ErrorCode::Unauthorized, "work-plan-agent-admission"));
        }
        let project = self
            .metadata()
            .map_err(|_| error(ErrorCode::CorruptLedger, "project"))?;
        let envelope = input.envelope();
        if envelope.project_id.to_string() != project.project_id().to_string() {
            return Err(error(ErrorCode::Unauthorized, "project"));
        }
        let prepared_build = super::release::prepare_input(self, input)?;
        let prepared_input = input_storage::PreparedInput::capture(input)?;
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        if let Some((prepared, permit)) = mcp {
            if agent.is_some()
                || service.is_some()
                || tool.is_some()
                || service_tool.is_some()
                || parent.is_some()
                || input.bytes() != prepared.input().bytes()
                || policy != RecoveryPolicy::ExternalUnknown
            {
                return Err(error(ErrorCode::Unauthorized, "mcp-query-admission"));
            }
            permit.check_input(input)?;
            super::mcp::check_prepared_in(&tx, prepared)?;
        }
        let verified_build =
            super::release::verify_prepared_input(&tx, input, prepared_build.as_ref())?;
        if let Some(prepared) = agent {
            if service.is_some()
                || tool.is_some()
                || service_tool.is_some()
                || input.bytes() != prepared.input().bytes()
                || parent != Some(prepared.scope.parent_task())
            {
                return Err(error(ErrorCode::Unauthorized, "work-plan-agent-admission"));
            }
            super::application::check_prepared_agent(&tx, prepared)?;
        }
        if let Some(prepared) = service {
            if tool.is_some()
                || service_tool.is_some()
                || prepared.input().bytes() != input.bytes()
                || parent != Some(prepared.parent_task())
            {
                return Err(error(ErrorCode::Unauthorized, "service-child-enqueue"));
            }
            super::application::check_prepared_service(&tx, prepared, &authority)?;
        }
        if let Some(prepared) = service_tool {
            if tool.is_none() || prepared.input().bytes() != input.bytes() || parent.is_some() {
                return Err(error(ErrorCode::Unauthorized, "service-tool-enqueue"));
            }
            super::application::check_prepared_service_tool(&tx, prepared, &authority)?;
            if tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                    [input.envelope().attempt_id.to_string()],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(sql_error)?
            {
                return Err(error(ErrorCode::ResultMismatch, "service-child-enqueued"));
            }
        }
        if input.envelope().plugin.is_some() && parent.is_some() {
            return Err(error(ErrorCode::Unauthorized, "plugin-delegation"));
        }
        let delegated = if let Some((prepared, consent, grant, generation)) = tool {
            let delegation = super::application::check_prepared_tool(&tx, prepared, consent)?;
            let fresh = super::plugin_execution::record_delegated_grant_in(
                &tx,
                &authority,
                generation,
                grant,
                input,
                consent.expires_at_ms,
                &delegation,
            )?;
            Some((delegation, fresh))
        } else {
            super::plugin_execution::check_input_in(&tx, input, &authority)?;
            super::application::check_enqueue(&tx, input, parent)?;
            None
        };
        super::application::check_service_input(&tx, input, &authority)?;
        check_translation_projection(&tx, input, Some(&authority))?;
        if !enqueue_input(
            &tx,
            input,
            policy,
            parent,
            &prepared_input,
            delegated.as_ref().is_some_and(|(_, fresh)| *fresh),
        )? {
            return Ok(());
        }
        super::release::record_input(&tx, input, verified_build.as_ref())?;
        if let Some((delegation, _)) = &delegated {
            super::application::record_tool_input(&tx, input, delegation)?;
            super::application::validate_tool_input(&tx, input, delegation)?;
        } else {
            super::application::record_input(&tx, input)?;
        }
        if let Some(prepared) = service {
            super::application::record_service_call(&tx, prepared)?;
        }
        if let Some(prepared) = service_tool {
            super::application::record_service_tool_call(&tx, prepared)?;
        }
        #[cfg(test)]
        crash_hook("before-enqueue-commit");
        commit(tx)?;
        if let Some(prepared) = service {
            super::application::activate_service_origin(&authority, prepared)
                .map_err(|_| error(ErrorCode::OutcomeUnknown, "service-origin-activation"))?;
        }
        if let Some(prepared) = service_tool {
            super::application::activate_service_tool_origin(&authority, prepared)
                .map_err(|_| error(ErrorCode::OutcomeUnknown, "service-origin-activation"))?;
        }
        #[cfg(test)]
        crash_hook("after-enqueue");
        #[cfg(any(test, feature = "execution-test-host"))]
        if delegated.is_some() {
            crash_hook("after-tool-enqueue-commit");
        }
        if let (Some((_, consent, grant, generation)), Some((delegation, true))) = (tool, delegated)
        {
            authority
                .activate_with_delegation(
                    generation,
                    grant,
                    input,
                    consent.expires_at_ms,
                    consent.deadline,
                    false,
                    Some(delegation),
                    None,
                )
                .map_err(|_| error(ErrorCode::OutcomeUnknown, "work-plan-tool-activation"))?;
        }
        Ok(())
    }
    pub fn execution_continuation(
        &self,
        action_id: ExecutionId,
    ) -> Result<Option<ContinuationReceipt>, ExecutionError> {
        read_continuation(self.execution_connection()?, action_id)
    }
    pub fn execution_continuation_page(
        &self,
        source: ExecutionId,
        after: Revision,
        limit: u32,
    ) -> Result<Vec<ContinuationReceipt>, ExecutionError> {
        if !(1..=50).contains(&limit) {
            return Err(error(ErrorCode::LimitExceeded, "continuation-page"));
        }
        let connection = self.execution_connection()?;
        load_input(connection, source)?;
        let mut statement = connection.prepare("SELECT c.action_id FROM execution_continuations c JOIN execution_attempts a ON a.attempt_id=c.attempt_id WHERE c.source_attempt_id=?1 AND a.sequence>?2 ORDER BY a.sequence LIMIT ?3").map_err(sql_error)?;
        let ids = statement
            .query_map(
                params![source.to_string(), after.get() as i64, limit],
                |r| r.get::<_, String>(0),
            )
            .map_err(sql_error)?;
        ids.map(|id| {
            read_continuation(connection, parse_id(id.map_err(sql_error)?)?)?
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "continuation-association"))
        })
        .collect()
    }
    pub(crate) fn enqueue_continuation(
        &mut self,
        action: &ContinuationAction,
        input: &FixedInput,
        policy: RecoveryPolicy,
    ) -> Result<ContinuationReceipt, ExecutionError> {
        let action = action.canonical()?;
        if let Some(receipt) = self.execution_continuation(action.action_id)? {
            return if receipt.action == action {
                Ok(receipt)
            } else {
                Err(error(ErrorCode::ResultMismatch, "continuation-identity"))
            };
        }
        let prepared_build = super::release::prepare_input(self, input)?;
        let prepared_input = input_storage::PreparedInput::capture(input)?;
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        if let Some(receipt) = read_continuation(&tx, action.action_id)? {
            return if receipt.action == action {
                Ok(receipt)
            } else {
                Err(error(ErrorCode::ResultMismatch, "continuation-identity"))
            };
        }
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM execution_actions WHERE action_id=?1)",
                [action.action_id.to_string()],
                |r| r.get::<_, bool>(0),
            )
            .map_err(sql_error)?
        {
            return Err(error(ErrorCode::ResultMismatch, "action-identity"));
        }
        let original = load_input(&tx, action.source_attempt_id)?;
        let request_digest = action.request_digest(&original)?;
        let metadata = super::read_metadata_from(&tx)
            .map_err(|_| error(ErrorCode::CorruptLedger, "project"))?;
        if action.project_id.to_string() != metadata.project_id().to_string() {
            return Err(error(ErrorCode::Unauthorized, "project"));
        }
        if cancel_revision(&tx, original.envelope().task_id)?
            != action.expected_cancellation_revision
        {
            return Err(error(
                ErrorCode::Cancelled,
                "continuation-cancellation-basis",
            ));
        }
        let unit = original
            .envelope()
            .units
            .iter()
            .find(|u| u.unit_id == action.unit_id)
            .ok_or_else(|| error(ErrorCode::InvalidInput, "continuation-unit"))?;
        let next = input.envelope();
        let selected: std::collections::BTreeSet<_> = action.item_ids.iter().copied().collect();
        let remaining: std::collections::BTreeSet<_> = next
            .items
            .iter()
            .filter(|item| {
                !next
                    .reused_results
                    .iter()
                    .any(|r| r.item_id == item.item_id)
            })
            .map(|item| item.item_id)
            .collect();
        if next.previous_attempt_id != Some(action.source_attempt_id)
            || next.units != vec![unit.clone()]
            || selected != remaining
        {
            return Err(error(ErrorCode::ResultMismatch, "continuation-input"));
        }
        let mut expected = original.envelope().clone();
        expected.previous_attempt_id = Some(expected.attempt_id);
        expected.attempt_id = next.attempt_id;
        expected.units = vec![unit.clone()];
        expected
            .items
            .retain(|item| unit.item_ids.contains(&item.item_id));
        expected.reused_results = next.reused_results.clone();
        if FixedInput::capture(expected)?.digest() != input.digest() {
            return Err(error(ErrorCode::ResultMismatch, "continuation-input"));
        }
        if next
            .items
            .iter()
            .filter_map(|item| item.scope.locale.as_ref())
            .any(|locale| {
                !metadata
                    .target_locales()
                    .iter()
                    .any(|target| target.as_str() == locale)
            })
        {
            return Err(error(ErrorCode::Unauthorized, "locale-scope"));
        }
        let state = read_attempt(&tx, action.source_attempt_id, false)?;
        let has_failure = state.items.iter().any(|item| {
            selected.contains(&item.item_id) && item.execution == ExecutionState::Failed
        });
        if has_failure != (action.kind == ContinuationKind::RetrySafeFailure) {
            return Err(error(ErrorCode::Unauthorized, "continuation-action"));
        }
        // Existing enqueue checks scope, current results, cancellation, effect policy,
        // ancestor budget and domain records inside this same writer transaction.
        let verified_build =
            super::release::verify_prepared_input(&tx, input, prepared_build.as_ref())?;
        super::plugin_execution::check_input_in(&tx, input, &authority)?;
        super::application::check_enqueue(&tx, input, None)?;
        super::application::check_service_input(&tx, input, &authority)?;
        check_translation_projection(&tx, input, Some(&authority))?;
        if !enqueue_input(&tx, input, policy, None, &prepared_input, false)? {
            return Err(error(
                ErrorCode::ResultMismatch,
                "continuation-attempt-identity",
            ));
        }
        super::release::record_input(&tx, input, verified_build.as_ref())?;
        super::application::record_input(&tx, input)?;
        let sequence: i64 = tx
            .query_row(
                "SELECT sequence FROM execution_attempts WHERE attempt_id=?1",
                [next.attempt_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        let receipt = ContinuationReceipt {
            sequence: Revision::new(sequence as u64)?,
            action,
            request_digest,
            source_input_digest: original.digest().to_owned(),
            attempt_id: next.attempt_id,
            input_digest: input.digest().to_owned(),
            task_id: original.envelope().task_id,
            operation: original.envelope().operation.clone(),
        };
        tx.execute(
            "INSERT INTO execution_continuations VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                receipt.action.action_id.to_string(),
                receipt.action.source_attempt_id.to_string(),
                receipt.action.unit_id.to_string(),
                receipt.attempt_id.to_string(),
                codec::encode(&receipt, MAX_INPUT_BYTES)?,
                receipt.request_digest
            ],
        )
        .map_err(sql_error)?;
        #[cfg(test)]
        crash_hook("before-continuation-commit");
        commit(tx)?;
        #[cfg(test)]
        crash_hook("after-continuation-commit");
        Ok(receipt)
    }
    pub fn execution_task(&self, task_id: ExecutionId) -> Result<TaskView, ExecutionError> {
        let connection = self.execution_connection()?;
        let (project, operation, sequence): (String, String, i64) = connection
            .query_row(
                "SELECT project_id,operation,sequence FROM execution_tasks WHERE task_id=?1",
                [task_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql_error)?;
        Ok(TaskView {
            task_id,
            project_id: parse_id(project)?,
            operation,
            sequence: Revision::new(sequence as u64)?,
            cancellation_revision: cancel_revision(connection, task_id)?,
        })
    }
    pub fn execution_input(&self, attempt: ExecutionId) -> Result<FixedInput, ExecutionError> {
        load_input(self.execution_connection()?, attempt)
    }
    pub(crate) fn execution_input_if_present(
        &self,
        attempt: ExecutionId,
    ) -> Result<Option<FixedInput>, ExecutionError> {
        let connection = self.execution_connection()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                [attempt.to_string()],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if exists {
            load_input(connection, attempt).map(Some)
        } else {
            Ok(None)
        }
    }
    pub(crate) fn execution_input_cached(
        &self,
        attempt: ExecutionId,
    ) -> Result<FixedInput, ExecutionError> {
        load_input_cached(self.execution_connection()?, attempt)
    }
    pub fn execution_attempt(
        &self,
        attempt: ExecutionId,
        active: bool,
    ) -> Result<AttemptView, ExecutionError> {
        read_attempt(self.execution_connection()?, attempt, active)
    }
    /// A bounded page from one snapshot; this projection never advances runtime
    /// work or turns its recovery descriptions into execution authority.
    pub fn execution_attempt_detail(
        &self,
        attempt_id: ExecutionId,
        active: bool,
        offset: u32,
        limit: u32,
    ) -> Result<AttemptDetail, ExecutionError> {
        let connection = self.execution_connection()?;
        super::review::read_snapshot(connection, |_| {
            if limit == 0 || limit > 100 {
                return Err(error(ErrorCode::LimitExceeded, "execution-page-limit"));
            }
            let view = self.execution_attempt(attempt_id, active)?;
            let input = self.execution_input(attempt_id)?;
            let total = view.items.len();
            if offset as usize > total {
                return Err(error(ErrorCode::InvalidInput, "offset"));
            }
            let items = view
                .items
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .map(|status| {
                    Ok(ItemView {
                        scope: input.item(status.item_id)?.scope.clone(),
                        result_id: self.execution_current_result(attempt_id, status.item_id)?,
                        status,
                    })
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?;
            let mut recovery = self.execution_recovery(attempt_id, active)?;
            // A unit can span pages. Return it on each page containing a member so its
            // full scope remains explicit before an action is requested.
            recovery.units.retain(|unit| {
                items
                    .iter()
                    .any(|item| unit.item_ids.contains(&item.status.item_id))
            });
            if view.operation == crate::ai::OPERATION {
                for unit in &mut recovery.units {
                    unit.actions.retain(|a| {
                        !matches!(
                            a,
                            RecoveryAction::ResumeUndispatched | RecoveryAction::RetrySafeFailure
                        )
                    });
                }
            }
            let end = offset + items.len() as u32;
            Ok(AttemptDetail {
                attempt_id: view.attempt_id,
                task_id: view.task_id,
                operation: view.operation,
                progress: view.progress,
                items,
                recovery,
                next_offset: ((end as usize) < total).then_some(end),
            })
        })
    }
    pub fn execution_tasks(
        &self,
        after: Revision,
        limit: u32,
    ) -> Result<Vec<TaskView>, ExecutionError> {
        if limit == 0 || limit > 50 {
            return Err(error(ErrorCode::LimitExceeded, "page"));
        }
        let connection = self.execution_connection()?;
        let mut statement = connection.prepare("SELECT task_id,project_id,operation,sequence FROM execution_tasks WHERE sequence>?1 ORDER BY sequence LIMIT ?2").map_err(sql_error)?;
        let rows = statement
            .query_map(params![after.get() as i64, limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(sql_error)?;
        rows.map(|row| {
            let (task, project, operation, sequence) = row.map_err(sql_error)?;
            let task_id = parse_id(task)?;
            Ok(TaskView {
                task_id,
                project_id: parse_id(project)?,
                operation,
                sequence: Revision::new(sequence as u64)?,
                cancellation_revision: cancel_revision(connection, task_id)?,
            })
        })
        .collect()
    }
    pub fn execution_attempt_ids(
        &self,
        task: ExecutionId,
    ) -> Result<Vec<ExecutionId>, ExecutionError> {
        let mut statement = self
            .execution_connection()?
            .prepare("SELECT attempt_id FROM execution_attempts WHERE task_id=?1 ORDER BY sequence")
            .map_err(sql_error)?;
        statement
            .query_map([task.to_string()], |r| r.get::<_, String>(0))
            .map_err(sql_error)?
            .map(|r| parse_id(r.map_err(sql_error)?))
            .collect()
    }

    pub fn execution_attempt_page(
        &self,
        task: ExecutionId,
        after: Revision,
        limit: u32,
    ) -> Result<Vec<(ExecutionId, Revision)>, ExecutionError> {
        if !(1..=100).contains(&limit) {
            return Err(error(ErrorCode::LimitExceeded, "attempt-page"));
        }
        let mut statement=self.execution_connection()?.prepare("SELECT attempt_id,sequence FROM execution_attempts WHERE task_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3").map_err(sql_error)?;
        statement
            .query_map(params![task.to_string(), after.get() as i64, limit], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(sql_error)?
            .map(|row| {
                let (id, sequence) = row.map_err(sql_error)?;
                Ok((parse_id(id)?, Revision::new(sequence as u64)?))
            })
            .collect()
    }

    pub fn dispatch_execution_item(
        &mut self,
        attempt: ExecutionId,
        item: ExecutionId,
    ) -> Result<DispatchRequest, ExecutionError> {
        let started = std::time::Instant::now();
        let started_at_ms = crate::execution::plugin_authority::plugin_now_ms()?;
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        let input = load_input_cached(&tx, attempt)?;
        let plugin_permit = match super::plugin_execution::check_input_in(&tx, &input, &authority) {
            Ok(permit) => permit,
            Err(failure)
                if matches!(failure.code, ErrorCode::Unauthorized | ErrorCode::Cancelled) =>
            {
                if input.envelope().automation.is_some() {
                    authority.revoke_task(input.envelope().task_id)?;
                    tx.execute(
                        "UPDATE plugin_execution_grants SET revoked=1 WHERE attempt_id=?1",
                        [attempt.to_string()],
                    )
                    .map_err(sql_error)?;
                }
                let diagnostic = if failure.stage == "work-plan-tool-source" {
                    "work-plan-tool-source"
                } else {
                    "plugin-authority"
                };
                tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic=?2 WHERE attempt_id=?1 AND execution='queued'", params![attempt.to_string(), diagnostic]).map_err(sql_error)?;
                commit(tx)?;
                return Err(failure);
            }
            Err(failure) => return Err(failure),
        };
        if let Err(error) = super::application::check_input(&tx, &input)
            .and_then(|_| super::application::check_service_input(&tx, &input, &authority))
        {
            if matches!(error.code, ErrorCode::Cancelled | ErrorCode::Unauthorized) {
                tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic='work-plan-control' WHERE attempt_id=?1 AND execution='queued'", [attempt.to_string()]).map_err(sql_error)?;
                commit(tx)?;
            }
            return Err(error);
        }
        let captured: i64 = tx
            .query_row(
                "SELECT cancellation_revision FROM execution_attempts WHERE attempt_id=?1",
                [attempt.to_string()],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if cancel_revision(&tx, input.envelope().task_id)?.get() > captured as u64 {
            return Err(error(ErrorCode::Cancelled, "dispatch"));
        }
        let execution: String = tx
            .query_row(
                "SELECT execution FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![attempt.to_string(), item.to_string()],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if execution != "queued" {
            return Err(error(ErrorCode::OutcomeUnknown, "dispatch"));
        }
        if let Some(locale) = &input.item(item)?.scope.locale {
            let metadata = super::read_metadata_from(&tx)
                .map_err(|_| error(ErrorCode::CorruptLedger, "scope"))?;
            if !metadata
                .target_locales()
                .iter()
                .any(|target| target.as_str() == locale)
            {
                tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic='scope-removed' WHERE attempt_id=?1 AND item_id=?2", params![attempt.to_string(),item.to_string()]).map_err(sql_error)?;
                commit(tx)?;
                return Err(error(ErrorCode::Unauthorized, "locale-scope"));
            }
        }
        let token = ExecutionId::new();
        tx.execute("UPDATE execution_items SET execution='dispatched',dispatch_token=?3 WHERE attempt_id=?1 AND item_id=?2",params![attempt.to_string(),item.to_string(),token.to_string()]).map_err(sql_error)?;
        commit(tx)?;
        #[cfg(test)]
        crash_hook("after-dispatch-intent");
        let timeout = std::time::Duration::from_millis(input.envelope().limits.timeout_ms.into());
        let original_deadline = crate::execution::DispatchDeadline {
            instant: started
                .checked_add(timeout)
                .ok_or_else(|| error(ErrorCode::InvalidInput, "dispatch-deadline"))?,
            expires_at_ms: started_at_ms
                .checked_add(input.envelope().limits.timeout_ms.into())
                .ok_or_else(|| error(ErrorCode::InvalidInput, "dispatch-deadline"))?,
        };
        Ok(DispatchRequest {
            provider: None,
            plugin_permit,
            service_origin: authority.service_origin(attempt)?,
            original_deadline: Some(original_deadline),
            input,
            item_id: item,
            dispatch_token: token,
        })
    }

    pub fn save_execution_result(&mut self, result: &FixedResult) -> Result<bool, ExecutionError> {
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        let envelope = result.envelope();
        let input = load_input_cached(&tx, envelope.attempt_id)?;
        let (token,current,adoption):(Option<String>,Option<String>,String)=tx.query_row("SELECT dispatch_token,current_result_id,adoption FROM execution_items WHERE attempt_id=?1 AND item_id=?2",params![envelope.attempt_id.to_string(),envelope.item_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql_error)?;
        let token = parse_id(
            token.ok_or_else(|| error(ErrorCode::ResultMismatch, "undispatched-result"))?,
        )?;
        let checked = FixedResult::receive(result.bytes(), &input, token)?;
        let existing: Option<Vec<u8>> = tx
            .query_row(
                "SELECT bytes FROM execution_results WHERE result_id=?1",
                [envelope.result_id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        if let Some(bytes) = existing {
            return if bytes == result.bytes() {
                Ok(false)
            } else {
                Err(error(ErrorCode::ResultMismatch, "result-identity"))
            };
        }
        let permit = super::plugin_execution::check_input_in(&tx, &input, &authority)?;
        if let Some(evidence) = &envelope.plugin {
            if permit.as_ref().map(PluginPermit::grant_id) != Some(evidence.authorization_id) {
                return Err(error(ErrorCode::Unauthorized, "plugin-result-grant"));
            }
        }
        if let Some(current) = &current {
            if envelope.supersedes.map(|id| id.to_string()).as_ref() != Some(current)
                || adoption == "committed"
            {
                return Err(error(ErrorCode::ResultMismatch, "result-replacement"));
            }
        } else if envelope.supersedes.is_some() {
            return Err(error(ErrorCode::ResultMismatch, "result-replacement"));
        }
        let used: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(length(bytes)),0) FROM execution_results WHERE attempt_id=?1",
                [envelope.attempt_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        let reused_bytes =
            input
                .envelope()
                .reused_results
                .iter()
                .try_fold(0usize, |total, reference| {
                    load_result(&tx, &input, reference.result_id)
                        .map(|result| total + result.bytes().len())
                })?;
        if used as usize + reused_bytes + result.bytes().len()
            > input.envelope().limits.max_attempt_result_bytes as usize
        {
            return Err(error(ErrorCode::LimitExceeded, "attempt-output"));
        }
        let validation = if envelope.output.is_some() && requires_semantic_check(&input) {
            "pending"
        } else if envelope.output.is_some() {
            match result.semantic_validation.as_ref() {
                Some(proof) if proof.matches(&input, &checked) => {
                    if proof.valid {
                        "valid"
                    } else {
                        "invalid"
                    }
                }
                _ => "pending",
            }
        } else {
            "absent"
        };
        tx.execute(
            "INSERT INTO execution_results VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                envelope.result_id.to_string(),
                envelope.attempt_id.to_string(),
                envelope.item_id.to_string(),
                token.to_string(),
                checked.bytes(),
                checked.digest()
            ],
        )
        .map_err(sql_error)?;
        tx.execute("UPDATE execution_items SET execution=?3,validation=?4,current_result_id=?5,retry_safe=?6,diagnostic=?7,adoption='unapplied' WHERE attempt_id=?1 AND item_id=?2",
            params![envelope.attempt_id.to_string(),envelope.item_id.to_string(),encode_enum(envelope.outcome)?,validation,envelope.result_id.to_string(),envelope.diagnostic.as_ref().is_some_and(|d|d.retry_safe),envelope.diagnostic.as_ref().map(|d|d.code.clone())]).map_err(sql_error)?;
        commit(tx)?;
        #[cfg(test)]
        crash_hook("after-output");
        Ok(true)
    }
    pub fn validate_execution_result(
        &mut self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        let input = load_input_cached(&tx, attempt)?;
        check_translation_projection(&tx, &input, Some(&authority))?;
        if input.envelope().plugin.is_some() {
            return Err(error(ErrorCode::Unauthorized, "plugin-semantic-validation"));
        }
        let output = load_result(&tx, &input, result)?;
        if output.envelope().outcome != ExecutionState::Succeeded {
            return Err(error(ErrorCode::OutputInvalid, "validation"));
        }
        #[cfg(any(test, feature = "execution-test-host"))]
        if input.envelope().operation == crate::content::OPERATION {
            if let Err(failure) = crate::content::validate_builtin_output(&input, &output) {
                tx.execute("UPDATE execution_items SET validation='invalid' WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3",params![attempt.to_string(),output.envelope().item_id.to_string(),result.to_string()]).map_err(sql_error)?;
                commit(tx)?;
                return Err(failure);
            }
        }
        if input.envelope().operation == crate::content::TRANSLATION_OPERATION {
            if let Err(failure) = crate::content::validate_translation_output(&input, &output) {
                tx.execute("UPDATE execution_items SET validation='invalid' WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3",params![attempt.to_string(),output.envelope().item_id.to_string(),result.to_string()]).map_err(sql_error)?;
                commit(tx)?;
                return Err(failure);
            }
        }
        if input.envelope().operation == crate::application::MCP_TERM_QUERY_OPERATION {
            if let Err(failure) = super::mcp::validate_query_output(&input, &output) {
                tx.execute("UPDATE execution_items SET validation='invalid' WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3",params![attempt.to_string(),output.envelope().item_id.to_string(),result.to_string()]).map_err(sql_error)?;
                commit(tx)?;
                return Err(failure);
            }
        }
        let changed=tx.execute("UPDATE execution_items SET validation='valid' WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3",params![attempt.to_string(),output.envelope().item_id.to_string(),result.to_string()]).map_err(sql_error)?;
        if changed != 1 {
            return Err(error(ErrorCode::ResultMismatch, "validation"));
        }
        commit(tx)?;
        #[cfg(test)]
        crash_hook("after-validation");
        Ok(())
    }
    pub fn capture_result_validation(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<ResultValidationCapture, ExecutionError> {
        let input = self.execution_input(attempt)?;
        self.check_plugin_input(&input)?;
        let result = self.execution_result(attempt, result)?;
        Ok(ResultValidationCapture { input, result })
    }
    /// Capture every actual locale result in one read snapshot. A requested
    /// batch is complete or rejected; no caller-supplied payload is retained.
    pub fn capture_artifact_check_workflow(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        input_digest: &str,
        results: &[ArtifactCheckBuildResultRef],
    ) -> Result<Vec<ResultValidationCapture>, ExecutionError> {
        let connection = self.execution_connection()?;
        super::review::read_snapshot(connection, |connection| {
            let input = load_input_cached(connection, attempt)?;
            let plan = crate::ReleasePlan::from_input(&input)?;
            plan.validate_source_reference(connection)?;
            if input.envelope().project_id != project || input.digest() != input_digest {
                return Err(error(ErrorCode::ResultMismatch, "artifact-workflow-build"));
            }
            super::plugin_execution::check_input_in(connection, &input, &self.plugin_authority)?;
            if results.is_empty()
                || results.len() > 16
                || results.len() != input.envelope().items.len()
                || results
                    .iter()
                    .map(|r| r.item_id)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != results.len()
                || results
                    .iter()
                    .map(|r| r.result_id)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != results.len()
            {
                return Err(error(ErrorCode::InvalidInput, "artifact-workflow-coverage"));
            }
            input.envelope().items.iter().map(|item| {
                let reference = results.iter().find(|r| r.item_id == item.item_id)
                    .ok_or_else(|| error(ErrorCode::ResultMismatch, "artifact-workflow-item"))?;
                let current: Option<String> = connection.query_row(
                    "SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                    params![attempt.to_string(), item.item_id.to_string()], |r| r.get(0),
                ).map_err(sql_error)?;
                if current.as_deref() != Some(reference.result_id.to_string().as_str()) {
                    return Err(error(ErrorCode::DependencyConflict, "artifact-workflow-current"));
                }
                let result = load_result(connection, &input, reference.result_id)?;
                if result.envelope().item_id != item.item_id
                    || result.envelope().outcome != ExecutionState::Succeeded
                {
                    return Err(error(ErrorCode::ResultMismatch, "artifact-workflow-result"));
                }
                let original = result_input(connection, &input, reference.result_id)?;
                super::plugin_execution::check_input_in(connection, original.as_ref(), &self.plugin_authority)?;
                Ok(ResultValidationCapture { input: original.as_ref().clone(), result })
            }).collect()
        })
    }

    /// Historical association only. The original input and artifact basis,
    /// rather than a caller's descriptor, identify this checker and producer.
    pub fn verify_artifact_check_association(
        &self,
        project: ExecutionId,
        build_attempt: ExecutionId,
        build_digest: &str,
        reference: &ArtifactCheckBuildResultRef,
        checker: &FixedInput,
    ) -> Result<(ExecutionId, String), ExecutionError> {
        let connection = self.execution_connection()?;
        super::review::read_snapshot(connection, |connection| {
            let input = load_input_cached(connection, build_attempt)?;
            let plan = crate::ReleasePlan::from_input(&input)?;
            plan.validate_source_reference(connection)?;
            let result = load_result(connection, &input, reference.result_id)?;
            if input.envelope().project_id != project
                || input.digest() != build_digest
                || result.envelope().item_id != reference.item_id
                || checker.envelope().project_id != project
            {
                return Err(error(
                    ErrorCode::ResultMismatch,
                    "artifact-workflow-association",
                ));
            }
            let original = result_input(connection, &input, reference.result_id)?;
            ArtifactValidationCapture::restore(
                ResultValidationCapture {
                    input: original.as_ref().clone(),
                    result,
                },
                checker.clone(),
            )?;
            Ok((original.envelope().attempt_id, original.digest().into()))
        })
    }

    /// Pure historical proof lookup, including revoked and reopened inputs.
    pub fn read_artifact_check_proof(
        &self,
        project: ExecutionId,
        build_attempt: ExecutionId,
        build_result: ExecutionId,
    ) -> Result<Option<super::release::SavedArtifactCheckProof>, ExecutionError> {
        let connection = self.execution_connection()?;
        super::review::read_snapshot(connection, |connection| {
            let input = load_input_cached(connection, build_attempt)?;
            if input.envelope().project_id != project {
                return Err(error(ErrorCode::Unauthorized, "artifact-workflow-project"));
            }
            let result = load_result(connection, &input, build_result)?;
            artifact_check_proof_in(connection, &input, &result)
        })
    }
    pub fn commit_result_validation(
        &mut self,
        prepared: PreparedResultValidation,
    ) -> Result<(), ExecutionError> {
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        let expected = &prepared.capture.result;
        let input = load_input_cached(&tx, expected.envelope().attempt_id)?;
        let output = load_result(&tx, &input, expected.envelope().result_id)?;
        if requires_semantic_check(&input) {
            return Err(error(
                ErrorCode::Unauthorized,
                "independent-semantic-check-required",
            ));
        }
        super::plugin_execution::check_input_in(&tx, &input, &authority)?;
        check_translation_projection(&tx, &input, Some(&authority))?;
        if crate::content::is_translation_projection(&input) {
            crate::content::validate_translation_output(&input, &output)?;
        }
        if !prepared.proof.matches(&input, &output)
            || input.digest() != prepared.capture.input.digest()
        {
            return Err(error(ErrorCode::ResultMismatch, "validation-preparation"));
        }
        let changed = tx.execute("UPDATE execution_items SET validation=?4 WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3 AND execution='succeeded' AND adoption<>'committed'", params![input.envelope().attempt_id.to_string(), output.envelope().item_id.to_string(), output.envelope().result_id.to_string(), if prepared.proof.valid { "valid" } else { "invalid" }]).map_err(sql_error)?;
        if changed != 1 {
            return Err(error(
                ErrorCode::ResultMismatch,
                "validation-current-result",
            ));
        }
        commit(tx)
    }
    /// Capture outside any write transaction. Running the returned checker input
    /// uses the ordinary runtime, independent permission and exact Host binding.
    pub fn capture_source_validation(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<SourceValidationCapture, ExecutionError> {
        SourceValidationCapture::capture(self.capture_result_validation(attempt, result)?)
    }
    pub fn commit_source_validation(
        &mut self,
        prepared: PreparedSourceValidation,
    ) -> Result<(), ExecutionError> {
        self.commit_semantic_validation(
            prepared.capture.source,
            prepared.capture.check_input,
            prepared.check_result,
            prepared.proof,
        )
    }
    pub fn capture_artifact_validation(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<ArtifactValidationCapture, ExecutionError> {
        ArtifactValidationCapture::capture(self.capture_result_validation(attempt, result)?)
    }
    pub fn capture_translation_validation(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<TranslationValidationCapture, ExecutionError> {
        TranslationValidationCapture::capture(self.capture_result_validation(attempt, result)?)
    }
    pub fn commit_translation_validation(
        &mut self,
        prepared: PreparedTranslationValidation,
    ) -> Result<(), ExecutionError> {
        self.commit_semantic_validation(
            prepared.capture.producer,
            prepared.capture.check_input,
            prepared.check_result,
            prepared.proof,
        )
    }
    pub fn commit_artifact_validation(
        &mut self,
        prepared: PreparedArtifactValidation,
    ) -> Result<(), ExecutionError> {
        self.commit_semantic_validation(
            prepared.capture.build,
            prepared.capture.check_input,
            prepared.check_result,
            prepared.proof,
        )
    }
    /// All producer/checker flows use one durable link and the same mutation
    /// boundary. Expensive reconstruction runs before this short write phase.
    fn commit_semantic_validation(
        &mut self,
        captured: ResultValidationCapture,
        captured_check: FixedInput,
        expected_check: FixedResult,
        proof: ValidationProof,
    ) -> Result<(), ExecutionError> {
        let authority = self.plugin_authority.clone();
        let tx = self.execution_write()?;
        let producer_input = load_input_cached(&tx, captured.input.envelope().attempt_id)?;
        let producer_result =
            load_result(&tx, &producer_input, captured.result.envelope().result_id)?;
        let check_input = load_input_cached(&tx, captured_check.envelope().attempt_id)?;
        let check_result = load_result(&tx, &check_input, expected_check.envelope().result_id)?;
        for input in [&producer_input, &check_input] {
            super::plugin_execution::check_input_in(&tx, input, &authority)?;
        }
        if !proof.matches(&producer_input, &producer_result)
            || producer_input.digest() != captured.input.digest()
            || check_input.digest() != captured_check.digest()
            || check_result.digest() != expected_check.digest()
        {
            return Err(error(
                ErrorCode::ResultMismatch,
                "semantic-validation-preparation",
            ));
        }
        let current_check: Option<String> = tx
            .query_row(
                "SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![
                    check_input.envelope().attempt_id.to_string(),
                    check_result.envelope().item_id.to_string()
                ],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if current_check.as_deref() != Some(&check_result.envelope().result_id.to_string()) {
            return Err(error(
                ErrorCode::ResultMismatch,
                "semantic-check-current-result",
            ));
        }
        let changed = tx.execute("UPDATE execution_items SET validation=?4 WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3 AND execution='succeeded' AND adoption<>'committed'", params![producer_input.envelope().attempt_id.to_string(), producer_result.envelope().item_id.to_string(), producer_result.envelope().result_id.to_string(), if proof.valid { "valid" } else { "invalid" }]).map_err(sql_error)?;
        if changed != 1 {
            return Err(error(
                ErrorCode::ResultMismatch,
                "semantic-validation-current-result",
            ));
        }
        tx.execute("INSERT INTO plugin_validation_links VALUES (?1,?2,?3) ON CONFLICT(producer_result_id) DO UPDATE SET checker_result_id=excluded.checker_result_id,valid=excluded.valid", params![producer_result.envelope().result_id.to_string(), check_result.envelope().result_id.to_string(), proof.valid]).map_err(sql_error)?;
        commit(tx)
    }
    pub fn execution_result(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<FixedResult, ExecutionError> {
        let connection = self.execution_connection()?;
        let input = load_input_cached(connection, attempt)?;
        load_result(connection, &input, result)
    }
    pub fn finish_execution_attempt(&mut self, attempt: ExecutionId) -> Result<(), ExecutionError> {
        let tx = self.execution_write()?;
        load_input(&tx, attempt)?;
        tx.execute("UPDATE execution_items SET execution='unknown',diagnostic='result-missing' WHERE attempt_id=?1 AND execution='dispatched'",[attempt.to_string()]).map_err(sql_error)?;
        commit(tx)
    }
    pub fn cancel_execution(
        &mut self,
        task: ExecutionId,
        request: ExecutionId,
    ) -> Result<Revision, ExecutionError> {
        let authority = self.plugin_authority.clone();
        let mut tx = self.execution_write()?;
        let existing: Option<(String, i64)> = tx
            .query_row(
                "SELECT task_id,revision FROM execution_cancellations WHERE request_id=?1",
                [request.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql_error)?;
        if let Some((owner, revision)) = existing {
            return if owner == task.to_string() {
                Revision::new(revision as u64)
            } else {
                Err(error(ErrorCode::ResultMismatch, "cancel-identity"))
            };
        }
        if super::application::stop_execution_plan_in(&tx, task, request)? {
            tx.observer.add_scope(super::ChangeScope::Project);
        }
        let revision = cancel_revision(&tx, task)?.next()?;
        authority.revoke_task(task)?;
        tx.execute(
            "INSERT INTO execution_cancellations VALUES (?1,?2,?3)",
            params![request.to_string(), task.to_string(), revision.get() as i64],
        )
        .map_err(sql_error)?;
        tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch' WHERE execution='queued' AND attempt_id IN (SELECT attempt_id FROM execution_attempts WHERE task_id=?1)",[task.to_string()]).map_err(sql_error)?;
        let descendants = {
            let mut stmt = tx.prepare("SELECT task_id FROM execution_budget_ancestry WHERE ancestor_id=?1 AND task_id<>?1 UNION SELECT a.task_id FROM application_executions x JOIN execution_attempts a USING(attempt_id) WHERE x.kind='tool' AND x.root_task=?1 AND a.task_id<>?1").map_err(sql_error)?;
            stmt.query_map([task.to_string()], |r| r.get::<_, String>(0))
                .map_err(sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)?
        };
        for child in descendants {
            authority.revoke_task(parse_id(child.clone())?)?;
            tx.execute(
                "UPDATE plugin_execution_grants SET revoked=1 WHERE task_id=?1",
                [&child],
            )
            .map_err(sql_error)?;
            let child_revision = cancel_revision(&tx, parse_id(child.clone())?)?.next()?;
            tx.execute(
                "INSERT INTO execution_cancellations VALUES (?1,?2,?3)",
                params![
                    ExecutionId::new().to_string(),
                    child,
                    child_revision.get() as i64
                ],
            )
            .map_err(sql_error)?;
            tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic='parent-cancelled' WHERE execution='queued' AND attempt_id IN (SELECT attempt_id FROM execution_attempts WHERE task_id=?1)",[child]).map_err(sql_error)?;
        }
        commit(tx)?;
        Ok(revision)
    }

    /// This explicit action preparation captures current cancellation authority.
    /// Re-sending the returned identity can never grant newer authority.
    pub fn prepare_adoption(
        &mut self,
        attempt: ExecutionId,
        unit: ExecutionId,
        result_ids: Vec<ExecutionId>,
        parameters: serde_json::Value,
    ) -> Result<AdoptionAction, ExecutionError> {
        self.prepare_adoption_with_id(ExecutionId::new(), attempt, unit, result_ids, parameters)
    }
    pub fn adoption_action(&self, action: ExecutionId) -> Result<AdoptionAction, ExecutionError> {
        let bytes: Vec<u8> = self
            .execution_connection()?
            .query_row(
                "SELECT request FROM execution_actions WHERE action_id=?1",
                [action.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        codec::decode(&bytes, MAX_INPUT_BYTES)
    }
    pub fn prepare_adoption_with_id(
        &mut self,
        action_id: ExecutionId,
        attempt: ExecutionId,
        unit: ExecutionId,
        mut result_ids: Vec<ExecutionId>,
        parameters: serde_json::Value,
    ) -> Result<AdoptionAction, ExecutionError> {
        let epoch = self.changes_since(Revision::new(0)?).epoch;
        let hook_slots = self.source_hook_deadlines.len() < 128;
        let tx = self.execution_write()?;
        if read_continuation(&tx, action_id)?.is_some() {
            return Err(error(ErrorCode::ResultMismatch, "action-identity"));
        }
        let input = load_input_cached(&tx, attempt)?;
        result_ids.sort();
        let existing: Option<Vec<u8>> = tx
            .query_row(
                "SELECT request FROM execution_actions WHERE action_id=?1",
                [action_id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        if let Some(bytes) = existing {
            let existing: AdoptionAction = codec::decode(&bytes, MAX_INPUT_BYTES)?;
            if existing.attempt_id != attempt
                || existing.unit_id != unit
                || existing.result_ids != result_ids
                || existing.parameters != parameters
            {
                return Err(error(ErrorCode::ResultMismatch, "action-identity"));
            }
            return Ok(existing);
        }
        let action = AdoptionAction {
            project_id: input.envelope().project_id,
            attempt_id: attempt,
            action_id,
            unit_id: unit,
            operation: input.envelope().operation.clone(),
            result_ids,
            cancellation_revision: cancel_revision(&tx, input.envelope().task_id)?,
            parameters,
        };
        let results = action
            .result_ids
            .iter()
            .map(|id| load_result(&tx, &input, *id))
            .collect::<Result<Vec<_>, _>>()?;
        let digest = action.digest(&input, &results)?;
        tx.execute(
            "INSERT INTO execution_actions VALUES (?1,?2,?3,?4,?5)",
            params![
                action.action_id.to_string(),
                attempt.to_string(),
                unit.to_string(),
                codec::encode(&action, MAX_INPUT_BYTES)?,
                digest
            ],
        )
        .map_err(sql_error)?;
        let hook_deadline =
            super::content::maintenance_hook::prepare_deadline(&tx, &action, &epoch)?;
        if hook_deadline.is_some() && !hook_slots {
            return Err(error(ErrorCode::LimitExceeded, "source-hook-preparations"));
        }
        commit(tx)?;
        if let Some(deadline) = hook_deadline {
            self.source_hook_deadlines.insert(action_id, deadline);
        }
        Ok(action)
    }
    pub fn adoption_receipt(
        &self,
        action: ExecutionId,
    ) -> Result<Option<AdoptionReceipt>, ExecutionError> {
        read_receipt(self.execution_connection()?, action)
    }
    pub fn capture_execution_adoption(
        &self,
        action: &AdoptionAction,
    ) -> Result<AdoptionCapture, ExecutionError> {
        let connection = self.execution_connection()?;
        if !connection.is_autocommit() {
            return Err(error(ErrorCode::DependencyConflict, "adoption-transaction"));
        }
        let transaction = connection.unchecked_transaction().map_err(sql_error)?;
        let capture = capture_adoption_in(&transaction, action, &self.plugin_authority)?;
        transaction.commit().map_err(sql_error)?;
        Ok(capture)
    }

    pub fn adopt_execution(
        &mut self,
        action: &AdoptionAction,
        handler: &dyn AdoptionHandler,
    ) -> Result<AdoptionReceipt, ExecutionError> {
        let prepared = self.capture_execution_adoption(action)?.prepare(handler)?;
        self.commit_execution_adoption(prepared)
    }

    pub fn commit_execution_adoption(
        &mut self,
        prepared: PreparedAdoption,
    ) -> Result<AdoptionReceipt, ExecutionError> {
        let authority = self.plugin_authority.clone();
        let store_epoch = self.changes_since(Revision::new(0)?).epoch;
        let mut tx = self.execution_write()?;
        let action = &prepared.capture.action;
        let current = capture_adoption_in(&tx, action, &authority)?;
        if let Some(receipt) = current.receipt {
            return Ok(receipt);
        }
        if current.digest != prepared.capture.digest
            || current.input.digest() != prepared.capture.input.digest()
            || current
                .results
                .iter()
                .map(|result| result.digest())
                .collect::<Vec<_>>()
                != prepared
                    .capture
                    .results
                    .iter()
                    .map(|result| result.digest())
                    .collect::<Vec<_>>()
        {
            return Err(error(ErrorCode::ResultMismatch, "adoption-preparation"));
        }
        let mutation = prepared
            .mutation
            .ok_or_else(|| error(ErrorCode::CorruptLedger, "receipt"))?;
        let changes = mutation(&AdoptionTransaction::new(&tx, &store_epoch))?;
        let receipt = AdoptionReceipt {
            project_id: action.project_id,
            attempt_id: action.attempt_id,
            action_id: action.action_id,
            unit_id: action.unit_id,
            request_digest: current.digest,
            changes,
        };
        for change in &receipt.changes {
            tx.observer
                .add_scope(super::ChangeScope::for_fact(&change.kind));
        }
        let bytes = codec::encode(&receipt, MAX_INPUT_BYTES)?;
        tx.execute(
            "INSERT INTO adoption_receipts VALUES (?1,?2,?3,?4,?5)",
            params![
                action.action_id.to_string(),
                action.attempt_id.to_string(),
                action.unit_id.to_string(),
                bytes,
                codec::digest(&bytes)
            ],
        )
        .map_err(sql_error)?;
        for result in &current.results {
            tx.execute("UPDATE execution_items SET adoption='committed' WHERE attempt_id=?1 AND item_id=?2",params![action.attempt_id.to_string(),result.envelope().item_id.to_string()]).map_err(sql_error)?;
        }
        #[cfg(test)]
        crash_hook("before-adoption-commit");
        commit(tx)?;
        #[cfg(test)]
        crash_hook("after-adoption-commit");
        Ok(receipt)
    }
}

fn require_current_result(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    let (current, execution): (Option<String>, String) = connection.query_row(
        "SELECT current_result_id,execution FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
        params![input.envelope().attempt_id.to_string(), result.envelope().item_id.to_string()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(sql_error)?;
    if current.as_deref() != Some(result.envelope().result_id.to_string().as_str())
        || execution != "succeeded"
    {
        return Err(error(
            ErrorCode::ResultMismatch,
            "semantic-check-current-result",
        ));
    }
    Ok(())
}

fn require_unsuperseded_result(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    let newer: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM execution_items i JOIN execution_attempts a ON i.attempt_id=a.attempt_id
         WHERE a.task_id=?1 AND i.item_id=?2 AND a.sequence>(SELECT sequence FROM execution_attempts WHERE attempt_id=?3))",
        params![input.envelope().task_id.to_string(), result.envelope().item_id.to_string(), input.envelope().attempt_id.to_string()],
        |row| row.get(0),
    ).map_err(sql_error)?;
    if newer {
        return Err(error(ErrorCode::Unauthorized, "continued-in-new-attempt"));
    }
    Ok(())
}

/// Review alone may preserve a real terminal error as advisory evidence. The
/// generic adoption guard remains succeeded-only for every other operation.
fn require_current_review_result(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    if input.envelope().operation != crate::execution::REVIEW_CHECK_OPERATION
        || input.envelope().items.len() != 1
        || !matches!(
            result.envelope().outcome,
            ExecutionState::Succeeded | ExecutionState::Failed | ExecutionState::Unknown
        )
        || result.envelope().plugin.is_none()
    {
        return Err(error(ErrorCode::ResultMismatch, "review-terminal-result"));
    }
    let (current, execution): (Option<String>, String) = connection.query_row(
        "SELECT current_result_id,execution FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
        params![input.envelope().attempt_id.to_string(), result.envelope().item_id.to_string()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(sql_error)?;
    if current.as_deref() != Some(result.envelope().result_id.to_string().as_str())
        || execution != encode_enum(result.envelope().outcome)?
    {
        return Err(error(
            ErrorCode::ResultMismatch,
            "review-terminal-current-result",
        ));
    }
    Ok(())
}

pub(super) fn capture_current_review_result_in(
    connection: &Connection,
    authority: &crate::execution::plugin_authority::PluginAuthority,
    attempt: ExecutionId,
    result: ExecutionId,
) -> Result<ResultValidationCapture, ExecutionError> {
    let input = load_input_cached(connection, attempt)?;
    let result = load_result(connection, &input, result)?;
    recheck_current_review_result_in(connection, authority, &input, &result)?;
    Ok(ResultValidationCapture { input, result })
}

/// Exact stored frames and the original live grant are required even when the
/// actual worker returned Failed/Unknown. A caller envelope supplies no proof.
pub(super) fn recheck_current_review_result_in(
    connection: &Connection,
    authority: &crate::execution::plugin_authority::PluginAuthority,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    check_stored_input(connection, input)?;
    check_stored_result(connection, result)?;
    let permit = super::plugin_execution::check_input_in(connection, input, authority)?
        .ok_or_else(|| error(ErrorCode::Unauthorized, "review-result-grant"))?;
    require_current_review_result(connection, input, result)?;
    require_unsuperseded_result(connection, input, result)?;
    if result
        .envelope()
        .plugin
        .as_ref()
        .map(|e| e.authorization_id)
        != Some(permit.grant_id())
    {
        return Err(error(ErrorCode::Unauthorized, "review-result-grant"));
    }
    Ok(())
}

fn capture_adoption_in(
    connection: &Connection,
    action: &AdoptionAction,
    authority: &crate::execution::plugin_authority::PluginAuthority,
) -> Result<AdoptionCapture, ExecutionError> {
    let input = load_input_cached(connection, action.attempt_id)?;
    let digest = action.request_digest(&input)?;
    let persisted: (Vec<u8>, String) = connection
            .query_row(
                "SELECT CASE WHEN length(request)<=1048576 THEN request END,digest FROM execution_actions WHERE action_id=?1",
                [action.action_id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql_error)?;
    let stored: AdoptionAction = codec::decode(&persisted.0, MAX_INPUT_BYTES)?;
    if stored != *action || persisted.1 != digest {
        return Err(error(ErrorCode::ResultMismatch, "action-identity"));
    }
    if let Some(receipt) = read_receipt(connection, action.action_id)? {
        return if receipt.request_digest == digest {
            Ok(AdoptionCapture {
                action: action.clone(),
                input,
                results: Vec::new(),
                digest,
                receipt: Some(receipt),
            })
        } else {
            Err(error(ErrorCode::CorruptLedger, "receipt"))
        };
    }
    if crate::content::is_translation_projection(&input) {
        complete_translation_projection(connection, &input)?;
    }
    super::application::check_input(connection, &input)?;
    super::application::check_service_input(connection, &input, authority)?;
    check_translation_projection(connection, &input, Some(authority))?;
    if input.envelope().plugin.is_some()
        && input.envelope().operation == crate::content::BUILD_OPERATION
    {
        super::release::ReleasePlan::from_input(&input)?.validate_source_reference(connection)?;
    }
    let permit = super::plugin_execution::check_input_in(connection, &input, authority)?;
    let results = action
        .result_ids
        .iter()
        .map(|id| load_result(connection, &input, *id))
        .collect::<Result<Vec<_>, _>>()?;
    action.validate(&input, &results)?;
    for result in &results {
        let original = result_input(connection, &input, result.envelope().result_id)?;
        let result_permit = if original.envelope().attempt_id == input.envelope().attempt_id {
            permit.clone()
        } else {
            require_current_result(connection, &original, result)?;
            super::plugin_execution::check_input_in(connection, &original, authority)?
        };
        if result.envelope().plugin.as_ref().is_some_and(|origin| {
            result_permit.as_ref().map(PluginPermit::grant_id) != Some(origin.authorization_id)
        }) {
            return Err(error(ErrorCode::Unauthorized, "plugin-adoption-grant"));
        }
    }
    if cancel_revision(connection, input.envelope().task_id)? != action.cancellation_revision {
        return Err(error(ErrorCode::Cancelled, "adoption"));
    }
    let state = if crate::content::is_translation_projection(&input) {
        None
    } else {
        Some(read_attempt(connection, action.attempt_id, true)?)
    };
    for result in &results {
        require_unsuperseded_result(connection, &input, result)?;
        let (current,validation,adoption):(String,String,String)=connection.query_row(
            "SELECT current_result_id,validation,adoption FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
            params![action.attempt_id.to_string(),result.envelope().item_id.to_string()],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(sql_error)?;
        let validation: ValidationState = decode_enum(validation)?;
        let adoption: AdoptionState = decode_enum(adoption)?;
        if let Some(state) = &state {
            let item = state
                .items
                .iter()
                .find(|item| item.item_id == result.envelope().item_id)
                .ok_or_else(|| error(ErrorCode::ResultMismatch, "item"))?;
            if item.validation != validation || item.adoption != adoption {
                return Err(error(ErrorCode::CorruptLedger, "adoption-state"));
            }
        }
        if current != result.envelope().result_id.to_string()
            || validation != ValidationState::Valid
            || adoption == AdoptionState::Committed
        {
            return Err(error(ErrorCode::ResultMismatch, "adoption-result"));
        }
        if requires_semantic_check(&input) {
            // Historical proof remains readable. New adoption also requires
            // the exact checker's live grant and unsuperseded result, both at
            // capture and again in the short commit transaction.
            let (check_input, check_result, _) = load_check_link(connection, result)?;
            require_current_result(connection, &check_input, &check_result)?;
            let permit =
                super::plugin_execution::check_input_in(connection, &check_input, authority)?;
            if permit.as_ref().map(PluginPermit::grant_id)
                != check_result
                    .envelope()
                    .plugin
                    .as_ref()
                    .map(|e| e.authorization_id)
            {
                return Err(error(
                    ErrorCode::Unauthorized,
                    "semantic-check-adoption-grant",
                ));
            }
        }
        let scope = &input.item(result.envelope().item_id)?.scope;
        if let Some(locale) = &scope.locale {
            let metadata = super::read_metadata_from(connection)
                .map_err(|_| error(ErrorCode::CorruptLedger, "scope"))?;
            if !metadata
                .target_locales()
                .iter()
                .any(|target| target.as_str() == locale)
            {
                return Err(error(ErrorCode::Unauthorized, "locale-scope"));
            }
        }
    }
    Ok(AdoptionCapture {
        action: action.clone(),
        input,
        results,
        digest,
        receipt: None,
    })
}

pub(super) fn read_receipt(
    connection: &Connection,
    action: ExecutionId,
) -> Result<Option<AdoptionReceipt>, ExecutionError> {
    let row: Option<(Vec<u8>, String)> = connection
        .query_row(
            "SELECT CASE WHEN length(receipt)<=1048576 THEN receipt END,digest FROM adoption_receipts WHERE action_id=?1",
            [action.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql_error)?;
    row.map(|(bytes, digest)| {
        if codec::digest(&bytes) != digest {
            return Err(error(ErrorCode::CorruptLedger, "receipt-digest"));
        }
        let receipt: AdoptionReceipt = codec::decode(&bytes, MAX_INPUT_BYTES)?;
        if receipt.action_id != action {
            return Err(error(ErrorCode::CorruptLedger, "receipt-identity"));
        }
        Ok(receipt)
    })
    .transpose()
}
pub(super) struct ExecutionTransaction<'a> {
    tx: rusqlite::Transaction<'a>,
    unknown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(super) observer: super::changes::CommitObserver,
}
impl<'a> std::ops::Deref for ExecutionTransaction<'a> {
    type Target = rusqlite::Transaction<'a>;
    fn deref(&self) -> &Self::Target {
        &self.tx
    }
}
pub(super) fn commit(transaction: ExecutionTransaction<'_>) -> Result<(), ExecutionError> {
    transaction.observer.commit(transaction.tx).map_err(|_| {
        transaction
            .unknown
            .store(true, std::sync::atomic::Ordering::Release);
        error(ErrorCode::OutcomeUnknown, "execution-commit")
    })
}
#[cfg(any(test, feature = "execution-test-host"))]
pub(in crate::persistence) fn crash_hook(point: &str) {
    if std::env::var("TSUMUGI_EXECUTION_CRASH").as_deref() == Ok(point) {
        if let Ok(path) = std::env::var("TSUMUGI_EXECUTION_HOOK") {
            std::fs::write(path, point).unwrap();
        }
        std::process::abort();
    }
}

#[cfg(test)]
mod tests;
