use super::ProjectStore;
use crate::execution::{codec, *};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

const EXECUTION_RESULTS_TABLE: &str = "CREATE TABLE \"execution_results\" (
        result_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL, item_id TEXT NOT NULL, dispatch_token TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 2097152), digest TEXT NOT NULL CHECK(length(digest) = 64),
        FOREIGN KEY(attempt_id,item_id,dispatch_token) REFERENCES execution_items(attempt_id,item_id,dispatch_token))";
pub(super) const EXECUTION_RESULTS_TABLE_V3: &str = "CREATE TABLE execution_results (
        result_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL, item_id TEXT NOT NULL, dispatch_token TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 262144), digest TEXT NOT NULL CHECK(length(digest) = 64),
        FOREIGN KEY(attempt_id,item_id,dispatch_token) REFERENCES execution_items(attempt_id,item_id,dispatch_token))";

const TABLES: &[(&str, &str)] = &[
    ("execution_tasks", "CREATE TABLE execution_tasks (
        task_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, operation TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE CHECK(sequence > 0), UNIQUE(task_id, project_id))"),
    ("execution_attempts", "CREATE TABLE execution_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        previous_attempt_id TEXT REFERENCES execution_attempts(attempt_id),
        input BLOB NOT NULL CHECK(length(input) BETWEEN 1 AND 1048576), digest TEXT NOT NULL CHECK(length(digest) = 64),
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
    ("execution_cancellations", "CREATE TABLE execution_cancellations (
        request_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES execution_tasks(task_id),
        revision INTEGER NOT NULL CHECK(revision > 0), UNIQUE(task_id,revision))"),
    ("execution_actions", "CREATE TABLE execution_actions (
        action_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
        unit_id TEXT NOT NULL, request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 1048576),
        digest TEXT NOT NULL CHECK(length(digest) = 64), UNIQUE(action_id,attempt_id,unit_id))"),
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
    validate_schema(connection, false)
}

pub(super) fn validate_v3(connection: &Connection) -> Result<(), ExecutionError> {
    validate_schema(connection, true)
}

fn validate_schema(
    connection: &Connection,
    legacy_result_limit: bool,
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
        let expected = if legacy_result_limit && *name == "execution_results" {
            EXECUTION_RESULTS_TABLE_V3
        } else {
            *expected
        };
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
        let _ = read_attempt(connection, id, false)?;
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
        let input = load_input(connection, parse_id(attempt.clone())?)?;
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
    Ok(())
}

pub(super) fn migrate_v3_result_limit(connection: &mut Connection) -> rusqlite::Result<()> {
    let foreign_keys: bool =
        connection.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    if !foreign_keys {
        return Err(rusqlite::Error::InvalidQuery);
    }
    connection.pragma_update(None, "foreign_keys", false)?;

    let migration = (|| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let create_sql = EXECUTION_RESULTS_TABLE.replacen(
            "\"execution_results\"",
            "\"execution_results_v4\"",
            1,
        );
        transaction.execute_batch(&create_sql)?;
        transaction.execute(
            "INSERT INTO execution_results_v4 (result_id,attempt_id,item_id,dispatch_token,bytes,digest)
             SELECT result_id,attempt_id,item_id,dispatch_token,bytes,digest FROM execution_results",
            [],
        )?;
        transaction.execute_batch(
            "DROP TABLE execution_results;
             ALTER TABLE execution_results_v4 RENAME TO execution_results;",
        )?;
        if transaction
            .prepare("PRAGMA foreign_key_check")?
            .exists([])?
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        transaction.pragma_update(None, "user_version", 4)?;
        #[cfg(test)]
        super::migration_crash_hook("before-v3-migration-commit");
        transaction.commit()?;
        #[cfg(test)]
        super::migration_crash_hook("after-v3-migration-commit");
        Ok(())
    })();
    let restore_foreign_keys = connection.pragma_update(None, "foreign_keys", true);
    match migration {
        Err(error) => {
            restore_foreign_keys?;
            Err(error)
        }
        Ok(()) => {
            restore_foreign_keys?;
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
fn cancel_revision(connection: &Connection, task: ExecutionId) -> Result<Revision, ExecutionError> {
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
    let (bytes,digest,task,project,previous): (Vec<u8>,String,String,String,Option<String>) = connection.query_row(
        "SELECT CASE WHEN length(input)<=1048576 THEN input END,digest,task_id,project_id,previous_attempt_id FROM execution_attempts WHERE attempt_id=?1", [attempt.to_string()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(sql_error)?;
    let input = FixedInput::restore(&bytes, &digest)?;
    check_input_association(&input, attempt, &task, &project, previous.as_deref())?;
    Ok(input)
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

fn load_input_cached(
    connection: &Connection,
    attempt: ExecutionId,
) -> Result<FixedInput, ExecutionError> {
    use std::sync::{Mutex, OnceLock};
    // Only the live execution path reuses decoded immutable inputs. Full ledger
    // reads, reconciliation and reopen validation always verify persisted bytes.
    static CACHE: OnceLock<Mutex<Option<(ExecutionId, String, FixedInput)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let (digest,task,project,previous): (String,String,String,Option<String>) = connection.query_row(
        "SELECT digest,task_id,project_id,previous_attempt_id FROM execution_attempts WHERE attempt_id=?1", [attempt.to_string()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(id, hash, _)| *id == attempt && hash == &digest)
        .map(|(_, _, input)| input.clone());
    let input = if let Some(input) = cached {
        input
    } else {
        let input = load_input(connection, attempt)?;
        *cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((attempt, digest.clone(), input.clone()));
        input
    };
    check_input_association(&input, attempt, &task, &project, previous.as_deref())?;
    Ok(input)
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
        .find(|reference| reference.result_id == result);
    let source = if let Some(reference) = reused {
        let source = load_input(connection, reference.source_attempt_id)?;
        if source.envelope().task_id != input.envelope().task_id
            || source.envelope().project_id != input.envelope().project_id
            || source.envelope().operation != input.envelope().operation
            || source.envelope().capability_id != input.envelope().capability_id
            || source.envelope().capability_version != input.envelope().capability_version
            || source.envelope().settings != input.envelope().settings
            || source.item(reference.item_id)? != input.item(reference.item_id)?
        {
            return Err(error(ErrorCode::CorruptLedger, "reused-input"));
        }
        Some(source)
    } else {
        None
    };
    let result_input = source.as_ref().unwrap_or(input);
    let (bytes,digest,item,token): (Vec<u8>,String,String,String) = connection.query_row(
        "SELECT CASE WHEN length(bytes)<=?3 THEN bytes END,digest,item_id,dispatch_token FROM execution_results WHERE result_id=?1 AND attempt_id=?2",
        params![result.to_string(),result_input.envelope().attempt_id.to_string(),i64::from(result_input.envelope().limits.max_result_bytes)], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
    let result_value = FixedResult::restore(&bytes, &digest, result_input, parse_id(token)?)?;
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
    Ok(result_value)
}
fn read_attempt(
    connection: &Connection,
    attempt: ExecutionId,
    active: bool,
) -> Result<AttemptView, ExecutionError> {
    let input = load_input(connection, attempt)?;
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
            match load_result(connection, &input, parse_id(result)?) {
                Ok(output)
                    if output.envelope().item_id == item_id
                        && output.envelope().outcome == state
                        && output
                            .envelope()
                            .diagnostic
                            .as_ref()
                            .is_some_and(|value| value.retry_safe)
                            == retry_safe => {}
                _ => validation = ValidationState::Invalid,
            }
        } else if validation != ValidationState::Absent || state == ExecutionState::Succeeded {
            return Err(error(ErrorCode::CorruptLedger, "result-missing"));
        }
        if adoption == AdoptionState::Committed {
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

impl ProjectStore {
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
                entry.actions.push(RecoveryAction::ValidateOutput);
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
            if input.envelope().operation == crate::ai::OPERATION {
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
        let mut statement=self.execution_connection()?.prepare("SELECT a.attempt_id FROM execution_attempts a WHERE a.sequence>?1 AND EXISTS(SELECT 1 FROM execution_items i WHERE i.attempt_id=a.attempt_id AND i.execution='queued') ORDER BY a.sequence LIMIT 32").map_err(sql_error)?;
        statement
            .query_map([after.get() as i64], |r| r.get::<_, String>(0))
            .map_err(sql_error)?
            .map(|row| parse_id(row.map_err(sql_error)?))
            .collect()
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
        Ok(DispatchRequest {
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
            load_input(&tx, attempt)?.item(item)?;
        }
        commit(tx)
    }
    fn execution_connection(&self) -> Result<&Connection, ExecutionError> {
        self.connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "session"))
    }
    fn execution_write(&mut self) -> Result<ExecutionTransaction<'_>, ExecutionError> {
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "session"));
        }
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| error(ErrorCode::StorageFailed, "session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        Ok(ExecutionTransaction { tx, unknown })
    }

    pub fn reconcile_execution(&mut self) -> Result<(), ExecutionError> {
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
        self.execution_unknown
            .store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    pub fn enqueue_execution(&mut self, input: &FixedInput) -> Result<(), ExecutionError> {
        let project = self
            .metadata()
            .map_err(|_| error(ErrorCode::CorruptLedger, "project"))?;
        let envelope = input.envelope();
        if envelope.project_id.to_string() != project.project_id().to_string() {
            return Err(error(ErrorCode::Unauthorized, "project"));
        }
        let tx = self.execution_write()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT digest FROM execution_attempts WHERE attempt_id=?1",
                [envelope.attempt_id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        if let Some(digest) = existing {
            return if digest == input.digest() {
                Ok(())
            } else {
                Err(error(ErrorCode::ResultMismatch, "attempt-identity"))
            };
        }
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
            let old = load_input(&tx, previous)?;
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
            let state = read_attempt(&tx, previous, false)?;
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
                    let output = load_result(&tx, &old, reference.result_id)?;
                    load_result(&tx, input, reference.result_id)?;
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
        let cancelled = cancel_revision(&tx, envelope.task_id)?;
        tx.execute("INSERT INTO execution_attempts VALUES (?1,?2,?3,?4,?5,?6,?7,(SELECT COALESCE(MAX(sequence),0)+1 FROM execution_attempts))", params![envelope.attempt_id.to_string(),envelope.task_id.to_string(),envelope.project_id.to_string(),envelope.previous_attempt_id.map(|id|id.to_string()),input.bytes(),input.digest(),cancelled.get() as i64]).map_err(sql_error)?;
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
        super::content::record_input(&tx, input)?;
        super::translation::record_input(&tx, input)?;
        super::release::record_input(&tx, input)?;
        #[cfg(test)]
        crash_hook("before-enqueue-commit");
        commit(tx)?;
        #[cfg(test)]
        crash_hook("after-enqueue");
        Ok(())
    }
    pub fn execution_input(&self, attempt: ExecutionId) -> Result<FixedInput, ExecutionError> {
        load_input(self.execution_connection()?, attempt)
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
        let tx = self.execution_write()?;
        let input = load_input_cached(&tx, attempt)?;
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
        Ok(DispatchRequest {
            input,
            item_id: item,
            dispatch_token: token,
        })
    }

    pub fn save_execution_result(&mut self, result: &FixedResult) -> Result<bool, ExecutionError> {
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
            params![envelope.attempt_id.to_string(),envelope.item_id.to_string(),encode_enum(envelope.outcome)?,if envelope.output.is_some(){"pending"}else{"absent"},envelope.result_id.to_string(),envelope.diagnostic.as_ref().is_some_and(|d|d.retry_safe),envelope.diagnostic.as_ref().map(|d|d.code.clone())]).map_err(sql_error)?;
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
        let tx = self.execution_write()?;
        let input = load_input_cached(&tx, attempt)?;
        let output = load_result(&tx, &input, result)?;
        if output.envelope().outcome != ExecutionState::Succeeded {
            return Err(error(ErrorCode::OutputInvalid, "validation"));
        }
        if input.envelope().operation == crate::content::OPERATION {
            if let Err(failure) = crate::content::validate_output(&input, &output) {
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
        let changed=tx.execute("UPDATE execution_items SET validation='valid' WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3",params![attempt.to_string(),output.envelope().item_id.to_string(),result.to_string()]).map_err(sql_error)?;
        if changed != 1 {
            return Err(error(ErrorCode::ResultMismatch, "validation"));
        }
        commit(tx)?;
        #[cfg(test)]
        crash_hook("after-validation");
        Ok(())
    }
    pub fn execution_result(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<FixedResult, ExecutionError> {
        let input = self.execution_input(attempt)?;
        load_result(self.execution_connection()?, &input, result)
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
        let tx = self.execution_write()?;
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
        let revision = cancel_revision(&tx, task)?.next()?;
        tx.execute(
            "INSERT INTO execution_cancellations VALUES (?1,?2,?3)",
            params![request.to_string(), task.to_string(), revision.get() as i64],
        )
        .map_err(sql_error)?;
        tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch' WHERE execution='queued' AND attempt_id IN (SELECT attempt_id FROM execution_attempts WHERE task_id=?1)",[task.to_string()]).map_err(sql_error)?;
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
        let tx = self.execution_write()?;
        let input = load_input(&tx, attempt)?;
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
        commit(tx)?;
        Ok(action)
    }
    pub fn adoption_receipt(
        &self,
        action: ExecutionId,
    ) -> Result<Option<AdoptionReceipt>, ExecutionError> {
        read_receipt(self.execution_connection()?, action)
    }
    pub fn adopt_execution(
        &mut self,
        action: &AdoptionAction,
        handler: &dyn AdoptionHandler,
    ) -> Result<AdoptionReceipt, ExecutionError> {
        let tx = self.execution_write()?;
        let input = load_input(&tx, action.attempt_id)?;
        let digest = action.request_digest(&input)?;
        let persisted: (Vec<u8>, String) = tx
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
        if let Some(receipt) = read_receipt(&tx, action.action_id)? {
            return if receipt.request_digest == digest {
                Ok(receipt)
            } else {
                Err(error(ErrorCode::CorruptLedger, "receipt"))
            };
        }
        if handler.operation() != action.operation {
            return Err(error(ErrorCode::Unauthorized, "handler"));
        }
        let results = action
            .result_ids
            .iter()
            .map(|id| load_result(&tx, &input, *id))
            .collect::<Result<Vec<_>, _>>()?;
        action.validate(&input, &results)?;
        if cancel_revision(&tx, input.envelope().task_id)? != action.cancellation_revision {
            return Err(error(ErrorCode::Cancelled, "adoption"));
        }
        let state = read_attempt(&tx, action.attempt_id, true)?;
        for result in &results {
            let newer:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_items i JOIN execution_attempts a ON i.attempt_id=a.attempt_id WHERE a.task_id=?1 AND i.item_id=?2 AND a.sequence>(SELECT sequence FROM execution_attempts WHERE attempt_id=?3))",params![input.envelope().task_id.to_string(),result.envelope().item_id.to_string(),action.attempt_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
            if newer {
                return Err(error(ErrorCode::Unauthorized, "continued-in-new-attempt"));
            }
            let item = state
                .items
                .iter()
                .find(|item| item.item_id == result.envelope().item_id)
                .ok_or_else(|| error(ErrorCode::ResultMismatch, "item"))?;
            let current:String=tx.query_row("SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",params![action.attempt_id.to_string(),item.item_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
            if current != result.envelope().result_id.to_string()
                || item.validation != ValidationState::Valid
                || item.adoption == AdoptionState::Committed
            {
                return Err(error(ErrorCode::ResultMismatch, "adoption-result"));
            }
            let scope = &input.item(item.item_id)?.scope;
            if let Some(locale) = &scope.locale {
                let metadata = super::read_metadata_from(&tx)
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
        let changes = handler.apply(&AdoptionTransaction::new(&tx), &input, action, &results)?;
        let receipt = AdoptionReceipt {
            project_id: action.project_id,
            attempt_id: action.attempt_id,
            action_id: action.action_id,
            unit_id: action.unit_id,
            request_digest: digest,
            changes,
        };
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
        for result in &results {
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
struct ExecutionTransaction<'a> {
    tx: rusqlite::Transaction<'a>,
    unknown: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl<'a> std::ops::Deref for ExecutionTransaction<'a> {
    type Target = rusqlite::Transaction<'a>;
    fn deref(&self) -> &Self::Target {
        &self.tx
    }
}
fn commit(transaction: ExecutionTransaction<'_>) -> Result<(), ExecutionError> {
    transaction.tx.commit().map_err(|_| {
        transaction
            .unknown
            .store(true, std::sync::atomic::Ordering::Release);
        error(ErrorCode::OutcomeUnknown, "execution-commit")
    })
}
#[cfg(test)]
fn crash_hook(point: &str) {
    if std::env::var("TSUMUGI_EXECUTION_CRASH").as_deref() == Ok(point) {
        if let Ok(path) = std::env::var("TSUMUGI_EXECUTION_HOOK") {
            std::fs::write(path, point).unwrap();
        }
        std::process::abort();
    }
}

#[cfg(test)]
mod tests;
