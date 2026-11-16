use super::ProjectStore;
use crate::execution::{codec, *};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
mod activity;
mod frame_read_guard;
pub(super) use frame_read_guard::ReleaseEvidenceStamp;
mod input_storage;
pub use activity::{TaskActivity, TaskActivityPhase, TaskActivityRow};
pub(crate) mod provider;
pub use provider::{ProviderBudget, ReportedTokenTotal};

const EXECUTION_RESULTS_TABLE: &str = "CREATE TABLE \"execution_results\" (
        result_id TEXT PRIMARY KEY NOT NULL, attempt_id TEXT NOT NULL, item_id TEXT NOT NULL, dispatch_token TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 805306368), digest TEXT NOT NULL CHECK(length(digest) = 64),
        FOREIGN KEY(attempt_id,item_id,dispatch_token) REFERENCES execution_items(attempt_id,item_id,dispatch_token))";

pub(super) const TABLES: &[(&str, &str)] = &[
    ("execution_input_chunks", input_storage::TABLE),
    ("execution_tasks", "CREATE TABLE execution_tasks (
        task_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, operation TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE CHECK(sequence > 0), UNIQUE(task_id, project_id))"),
    ("execution_attempts", "CREATE TABLE execution_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        previous_attempt_id TEXT REFERENCES execution_attempts(attempt_id),
        input BLOB NOT NULL CHECK(typeof(input)='blob' AND length(input) BETWEEN 1 AND 1310720), digest TEXT NOT NULL CHECK(length(digest) = 64),
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
    validate_schema(
        connection,
        false,
        |connection, input, results, links| {
            validate_attempt_input(
                connection,
                input,
                |result| load_result(connection, input, result),
                |result| validate_plugin_link(connection, input, result, true).map(|_| ()),
            )?;
            results.validate_links(links, None, |_, _, _| {})
        },
    )
}

#[derive(PartialEq, Eq)]
pub(super) enum CheckedPluginLink {
    Source {
        checker_attempt: ExecutionId,
        checker_result: ExecutionId,
    },
    Artifact { build_attempt: ExecutionId },
    Translation,
}

/// Evidence validated in the current SQLite open transaction.
pub(super) struct OpenPluginProofs<'a> {
    connection: &'a Connection,
    links: BTreeMap<ExecutionId, (CheckedPluginLink, bool)>,
    pub(super) source_sets: BTreeSet<ExecutionId>,
    source_revisions: BTreeMap<ExecutionId, (u64, bool)>,
    recent_source: Option<OpenSourceSnapshot>,
}

pub(super) struct OpenSourceSnapshot {
    snapshot: ExecutionId,
    pub(super) project: ExecutionId,
    pub(super) input_digest: String,
    pub(super) result_digest: String,
    pub(super) exchange: tsumugi_plugin_sdk::ContentExchange,
}

impl OpenPluginProofs<'_> {
    pub(super) fn source_revision(
        &self, connection: &Connection, snapshot: ExecutionId, has_lineage: bool,
    ) -> Option<u64> {
        if !std::ptr::eq(self.connection, connection) || connection.is_autocommit() {
            return None;
        }
        let &(revision, lineage) = self.source_revisions.get(&snapshot)?;
        (lineage || !has_lineage).then_some(revision)
    }

    pub(super) fn source_snapshot(
        &self, connection: &Connection, snapshot: ExecutionId,
    ) -> Option<&OpenSourceSnapshot> {
        self.source_revision(connection, snapshot, true)?;
        self.recent_source.as_ref().filter(|source| source.snapshot == snapshot)
    }

    fn qualify_sources(&mut self, input: &FixedInput) -> Result<(), ExecutionError> {
        let connection = self.connection;
        let attempt = input.envelope().attempt_id;
        let mut statement = connection.prepare_cached(
            "SELECT snapshot_id FROM source_snapshots WHERE attempt_id=?1",
        ).map_err(sql_error)?;
        let snapshots = statement.query_map([attempt.to_string()], |row| row.get::<_, String>(0))
            .map_err(sql_error)?;
        let mut latest = None;
        for row in snapshots {
            let snapshot = parse_id(row.map_err(sql_error)?)?;
            let has_lineage = super::content::has_source_lineage(connection)?;
            let (revision, (input, result, output)) =
                super::content::snapshot_qualification(connection, snapshot, has_lineage)?;
            self.source_revisions.insert(snapshot, (revision, has_lineage));
            latest = Some((snapshot, input.envelope().project_id,
                input.digest().to_owned(), result.digest().to_owned(), output));
        }
        // The release scan needs the source projection, not the original
        // producer and checker frames. Read paths outside this open can
        // still qualify their own frames against the current snapshot.
        if let Some(stamp) = read_snapshot_stamp(connection)? {
            let mut cache = source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if cache.as_ref().is_some_and(|memo| {
                memo.source.input.envelope().attempt_id == attempt
                    && memo.read.as_ref().is_some_and(|read| read.stamp == stamp)
            }) {
                *cache = None;
            }
        }
        if let Some((snapshot, project, input_digest, result_digest, output)) = latest {
            // Keep only what frozen release plans compare. The occurrences and
            // diagnostics are no longer needed after qualifying this snapshot.
            let exchange = std::sync::Arc::try_unwrap(output)
                .map(|output| output.exchange)
                .unwrap_or_else(|shared| shared.exchange.clone());
            self.recent_source = Some(OpenSourceSnapshot {
                snapshot, project, input_digest, result_digest, exchange,
            });
        }
        Ok(())
    }

    pub(super) fn matches(
        &self,
        connection: &Connection,
        producer_result: ExecutionId,
        link: CheckedPluginLink,
        valid: bool,
    ) -> bool {
        std::ptr::eq(self.connection, connection)
            && !connection.is_autocommit()
            && self.links.get(&producer_result) == Some(&(link, valid))
    }
}

pub(super) fn validate_for_open<'a>(
    connection: &'a Connection,
    mut validate_associations: impl FnMut(
        &Connection,
        &FixedInput,
        &mut OpenResultReader<'_>,
        &OpenPluginProofs<'_>,
    ) -> Result<(), ExecutionError>,
) -> Result<OpenPluginProofs<'a>, ExecutionError> {
    if connection.is_autocommit() {
        return Err(error(ErrorCode::StorageFailed, "open-proof-snapshot"));
    }
    let mut proofs = OpenPluginProofs {
        connection,
        links: BTreeMap::new(),
        source_sets: BTreeSet::new(),
        source_revisions: BTreeMap::new(),
        recent_source: None,
    };
    validate_schema(
        connection,
        true,
        |connection, input, results, links| {
            validate_attempt_input(
                connection,
                input,
                |result| results.load(result),
                |result| require_open_valid_plugin_link(connection, result.envelope().result_id),
            )?;
            super::plugin_execution::validate_associated_input(connection, input, results)?;
            let source = if input.envelope().operation == crate::content::OPERATION {
                let (bundle, settings) = crate::content::SourceBundle::from_input_with_settings(input)?;
                super::content::validate_bundle_in(connection, &bundle)?;
                proofs.source_sets.insert(bundle.set_id);
                Some((bundle, settings))
            } else {
                None
            };
            results.validate_links(links, source.as_ref(), |result, link, valid| {
                proofs.links.insert(result, (link, valid));
            })?;
            let source_captured = source.is_some();
            drop(source);
            if source_captured && input.envelope().plugin.is_some() {
                proofs.qualify_sources(input)?;
            }
            validate_associations(connection, input, results, &proofs)
        },
    )?;
    Ok(proofs)
}

fn is_conversation_planning(input: &FixedInput) -> bool {
    input.envelope().operation == crate::ai::conversation_planning::OPERATION
        || input.envelope().capability_id == crate::ai::conversation_planning::CAPABILITY
}

fn check_planning_candidate_action(
    input: &FixedInput,
    parameters: &serde_json::Value,
) -> Result<(), ExecutionError> {
    if is_conversation_planning(input)
        && (!parameters.is_null()
            || input.envelope().capability_version != "4"
            || !matches!(
                crate::ai::conversation_planning::preview_from_input(input)?.scope,
                crate::application::ConversationPlanningScope::SelectedRevision { .. }
            ))
    {
        return Err(error(ErrorCode::Unauthorized, "conversation-planning-adoption"));
    }
    Ok(())
}

fn check_planning_candidate_result(input: &FixedInput, results: &[FixedResult]) -> Result<(), ExecutionError> {
    if is_conversation_planning(input) {
        let [result] = results else {
            return Err(error(ErrorCode::ResultMismatch, "selected-revision-candidate"));
        };
        crate::ai::conversation_planning::selected_revision_candidate(input, result)?;
    }
    Ok(())
}

fn validate_attempt_input(
    connection: &Connection,
    input: &FixedInput,
    load_result: impl FnMut(ExecutionId) -> Result<FixedResult, ExecutionError>,
    validate_link: impl FnMut(&FixedResult) -> Result<(), ExecutionError>,
) -> Result<(), ExecutionError> {
    let _ = read_attempt_with_results(connection, input, false, load_result, validate_link)?;
    if is_conversation_planning(input) {
        crate::ai::conversation_planning::settings(input)?;
    }
    if input.envelope().operation == crate::application::MCP_TERM_QUERY_OPERATION
        || input.envelope().capability_id == crate::application::MCP_TERM_QUERY_CAPABILITY
    {
        super::mcp::validate_ledger_input(connection, input)?;
    }
    Ok(())
}

fn validate_schema(
    connection: &Connection,
    opening: bool,
    mut validate_input: impl FnMut(
        &Connection,
        &FixedInput,
        &mut OpenResultReader<'_>,
        Vec<(ExecutionId, bool)>,
    ) -> Result<(), ExecutionError>,
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
        let actual: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if actual != *expected {
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
    if !opening {
        input_storage::validate_chunks(connection, false)?;
    }
    let project = super::read_metadata_from(connection)
        .map_err(|_| error(ErrorCode::CorruptLedger, "project"))?;
    // Index only link identities. The producer scan can then use its exact
    // input and bounded result reader for every link, including historical or
    // negative links that the current execution items do not point to.
    let mut links_by_attempt = BTreeMap::<ExecutionId, Vec<(ExecutionId, bool)>>::new();
    {
        let mut links = connection
            .prepare(
                "SELECT r.attempt_id,l.producer_result_id,l.valid FROM plugin_validation_links l
                 LEFT JOIN execution_results r ON r.result_id=l.producer_result_id",
            )
            .map_err(sql_error)?;
        let rows = links
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(sql_error)?;
        for row in rows {
            let (attempt, result, valid) = row.map_err(sql_error)?;
            links_by_attempt
                .entry(parse_id(attempt)?)
                .or_default()
                .push((parse_id(result)?, valid));
        }
    }
    let mut checker = opening.then(OpenCheckerFrames::default);
    let mut statement = connection
        .prepare("SELECT a.attempt_id,t.operation FROM execution_attempts a
                  JOIN execution_tasks t ON t.task_id=a.task_id ORDER BY a.sequence")
        .map_err(sql_error)?;
    let ids = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(sql_error)?
        .map(|row| {
            let (id, operation) = row.map_err(sql_error)?;
            Ok::<_, ExecutionError>((parse_id(id)?, operation))
        });
    let mut ids = ids.peekable();
    while let Some(id) = ids.next() {
        let (id, operation) = id?;
        if let Some(slot) = &mut checker {
            slot.next_attempt = ids.peek().and_then(|next| next.as_ref().ok()).map(|(id, _)| *id);
        }
        let (mut input, verified) = match checker.as_mut().and_then(|slot| slot.take_for(id)) {
            // The link reader qualified both original frames on this pinned
            // connection. The item, grant and association checks below still run.
            Some(ResultValidationCapture { input, result }) => (input, Some(result)),
            None => (load_input(connection, id)?, None),
        };
        if input.envelope().project_id.to_string() != project.project_id().to_string()
            || input.envelope().operation != operation
        {
            return Err(error(ErrorCode::CorruptLedger, "project"));
        }
        if is_derived_check(&operation)
            && !checker.as_ref().is_some_and(|frames| frames.qualified.contains(&id))
        {
            derive_check_input(connection, &input, false)?;
        }
        if opening && operation == crate::content::BUILD_OPERATION && links_by_attempt.contains_key(&id) {
            input.cache_open_build_plan()?;
        }
        let mut results = OpenResultReader::new(connection, &input);
        results.verified = verified;
        results.checker = checker.as_mut();
        validate_input(connection, &input, &mut results, links_by_attempt.remove(&id).unwrap_or_default())?;
    }
    drop(checker);
    if !links_by_attempt.is_empty() {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-link"));
    }
    if opening {
        // Every referenced chunk has already been checked while restoring its
        // attempt under the same open snapshot.
        input_storage::validate_chunks(connection, true)?;
    }
    super::mcp::validate_action_links(connection)?;
    let mut actions = connection
        .prepare("SELECT e.action_id,e.attempt_id,e.unit_id,e.request,e.digest,a.digest
                  FROM execution_actions e LEFT JOIN execution_attempts a ON a.attempt_id=e.attempt_id")
        .map_err(sql_error)?;
    let rows = actions
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(sql_error)?;
    for row in rows {
        let (id, attempt, unit, bytes, digest, input_digest) = row.map_err(sql_error)?;
        let action: AdoptionAction = codec::decode(&bytes, MAX_INPUT_BYTES)?;
        // Opening has verified every attempt in this same transaction.
        // Reconciliation still restores the input under its ordinary read path.
        let request_digest = if opening {
            let input_digest = input_digest
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "action-input"))?;
            action.request_digest_for_input(&input_digest)?
        } else {
            let input = load_input_cached(connection, parse_id(attempt.clone())?)?;
            action.request_digest(&input)?
        };
        if action.action_id.to_string() != id
            || action.attempt_id.to_string() != attempt
            || action.unit_id.to_string() != unit
            || request_digest != digest
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
    super::application::conversations::planning::history::record_input(tx, input)?;
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
    let stored = read_stored_input(connection, attempt)?;
    let input = FixedInput::restore_hashed(stored.bytes, stored.frame_digest, &stored.digest)?;
    check_input_association(&input, attempt, &stored.task, &stored.project, stored.previous.as_deref())?;
    super::resources::verify_input_fact_decisions(connection, &input)?;
    Ok(input)
}

pub(super) fn register_input_reader(connection: &Connection) -> rusqlite::Result<()> {
    input_storage::register(connection)?;
    let identity = ExecutionId::new().to_string();
    frame_read_guard::register(connection, &identity)?;
    connection.create_scalar_function(
        "tsumugi_connection_identity", 0,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_DIRECTONLY,
        move |_| Ok(identity.clone()),
    )?;
    connection.create_scalar_function(
        "tsumugi_lower", 1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |context| Ok(context.get::<String>(0)?.to_lowercase()),
    )
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

struct StoredInputFrame {
    bytes: Vec<u8>,
    frame_digest: String,
    digest: String,
    task: String,
    project: String,
    previous: Option<String>,
}

fn read_stored_input(
    connection: &Connection,
    attempt: ExecutionId,
) -> Result<StoredInputFrame, ExecutionError> {
    with_stored_input(connection, attempt, |manifest, row| {
        let (bytes, frame_digest) = input_storage::read_frame(connection, manifest)?;
        Ok(StoredInputFrame {
            bytes,
            frame_digest,
            digest: row.get(1).map_err(sql_error)?,
            task: row.get(2).map_err(sql_error)?,
            project: row.get(3).map_err(sql_error)?,
            previous: row.get(4).map_err(sql_error)?,
        })
    })
}

fn with_stored_input<T>(
    connection: &Connection,
    attempt: ExecutionId,
    read: impl FnOnce(&[u8], &rusqlite::Row<'_>) -> Result<T, ExecutionError>,
) -> Result<T, ExecutionError> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {},a.digest,a.task_id,a.project_id,a.previous_attempt_id
         FROM execution_attempts a WHERE a.attempt_id=?1",
        input_storage::metadata_sql(),
    )).map_err(sql_error)?;
    let mut rows = statement.query([attempt.to_string()]).map_err(sql_error)?;
    let row = rows.next().map_err(sql_error)?.ok_or_else(|| sql_error(rusqlite::Error::QueryReturnedNoRows))?;
    let manifest = row.get_ref(0).map_err(sql_error)?.as_blob().map_err(|_| error(ErrorCode::CorruptLedger, "input-storage"))?;
    read(manifest, row)
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
    if connection.is_autocommit() {
        return super::review::read_snapshot(connection, |connection| load_input_cached(connection, attempt));
    }
    use frame_read_guard::{FrameReadGuard, ReadObservation};
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<Option<(ExecutionId, String, FixedInput, Option<FrameReadGuard>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let cached = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref().filter(|(id, _, _, _)| *id == attempt)
        .map(|(_, digest, input, guard)| (digest.clone(), input.clone(), guard.clone()));
    let current = match &cached {
        Some((_, _, Some(guard))) => guard.current(connection)?,
        _ => false,
    };
    let input = if current {
        cached.as_ref().unwrap().1.clone()
    } else {
        let observed = ReadObservation::begin(connection)?;
        let stored = read_stored_input(connection, attempt)?;
        let bytes = stored.bytes;
        let input = if let Some((_, input, _)) = cached.filter(|(digest, _, _)| digest == &stored.digest) {
            if bytes != input.bytes() { return Err(error(ErrorCode::CorruptLedger, "input-bytes")); }
            input
        } else { FixedInput::restore_hashed(bytes, stored.frame_digest, &stored.digest)? };
        check_input_association(&input, attempt, &stored.task, &stored.project, stored.previous.as_deref())?;
        let guard = observed.map(|observed| observed.finish(connection, &[&input], &[])).transpose()?.flatten();
        *cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((attempt, stored.digest, input.clone(), guard));
        input
    };
    // Decision/currentness reads are never cached with the immutable frame.
    super::resources::verify_input_fact_decisions(connection, &input)?;
    if connection.transaction_state(Some(rusqlite::MAIN_DB)).map_err(sql_error)? == rusqlite::TransactionState::Read {
        // Runtime reads this input before opening its dispatch writer. Prime
        // only immutable projection qualification here; writes still check
        // current items, grants, cancellation and validation links below.
        check_translation_projection(connection, &input, None)?;
    }
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
    load_result_with_verified(connection, input, result, None)
}

// Only the open-time attempt owner can supply this already received frame.
// Every call still reads the original bounded row and checks provenance.
fn load_result_with_verified(
    connection: &Connection,
    input: &FixedInput,
    result: ExecutionId,
    verified: Option<&FixedResult>,
) -> Result<FixedResult, ExecutionError> {
    let reused = input
        .envelope()
        .reused_results
        .iter()
        .find(|r| r.result_id == result);
    let result_input = result_input(connection, input, result)?;
    let result_value = super::review::read_snapshot(connection, |connection| {
        let row = stored_result(
            connection, result_input.envelope().attempt_id, result,
            result_input.envelope().limits.max_result_bytes as usize,
        )?;
        let token = ExecutionId::parse(&row.token)?;
        let bytes = row.open_bytes(connection)?;
        if let Some(verified) = verified
            && verified.envelope().result_id == result
            && verified.envelope().attempt_id == result_input.envelope().attempt_id
            && verified.envelope().dispatch_token == token
            && verified.envelope().item_id.to_string() == row.item
            && verified.digest() == row.digest
            && super::blob_matches(&bytes, verified.bytes()).map_err(sql_error)?
        {
            super::plugin_execution::validate_result_in(connection, &result_input, verified)?;
            return Ok(verified.clone());
        }
        // Read and hash bounded slices of the original BLOB. Decode only after
        // releasing the SQLite reader and verifying the complete frame.
        const READ_BYTES: usize = 1024 * 1024;
        let mut frame = vec![0; bytes.len()];
        let mut digest = aws_lc_rs::digest::Context::new(&aws_lc_rs::digest::SHA256);
        for (index, block) in frame.chunks_mut(READ_BYTES).enumerate() {
            bytes.read_at_exact(block, index * READ_BYTES).map_err(sql_error)?;
            digest.update(block);
        }
        drop(bytes);
        let fixed = FixedResult::restore_hashed(frame, codec::digest_hex(digest.finish()), &row.digest, &result_input, token)?;
        if fixed.envelope().item_id.to_string() != row.item || fixed.envelope().result_id != result {
            return Err(error(ErrorCode::CorruptLedger, "result-association"));
        }
        super::plugin_execution::validate_result_in(connection, &result_input, &fixed)?;
        Ok(fixed)
    })?;
    if reused.is_some_and(|reference| {
        reference.item_id != result_value.envelope().item_id
            || result_value.envelope().outcome != ExecutionState::Succeeded
    }) {
        return Err(error(ErrorCode::CorruptLedger, "reused-result"));
    }
    Ok(result_value)
}

/// Hold at most one source or artifact checker pair until its attempt is scanned.
/// The slot belongs to the open transaction and never carries execution authority.
#[derive(Default)]
struct OpenCheckerFrames {
    next_attempt: Option<ExecutionId>,
    capture: Option<ResultValidationCapture>,
    qualified: BTreeSet<ExecutionId>,
}

impl OpenCheckerFrames {
    fn take_for(&mut self, attempt: ExecutionId) -> Option<ResultValidationCapture> {
        if self.capture.as_ref().is_some_and(|capture| capture.input.envelope().attempt_id == attempt) {
            return self.capture.take();
        }
        None
    }

    fn remember(&mut self, input: &FixedInput, result: &FixedResult) {
        self.qualified.insert(input.envelope().attempt_id);
        const MAX_DEFERRED_FRAME_BYTES: usize = 16 * 1024 * 1024;
        let attempt = input.envelope().attempt_id;
        // An adjacent checker never overlaps the next producer's large
        // frames. Keep the small bound when a checker is further away.
        if attempt == result.envelope().attempt_id
            && (self.next_attempt == Some(attempt)
                || input.bytes().len() + result.bytes().len() <= MAX_DEFERRED_FRAME_BYTES)
        {
            self.capture = Some(ResultValidationCapture { input: input.clone(), result: result.clone() });
        }
    }
}

/// Borrow the original build plan and one decoded output during one attempt scan.
pub(super) struct OpenBuildEvidence {
    pub(super) plan: std::sync::Arc<crate::ReleasePlan>,
    pub(super) artifact: Option<OpenBuildArtifact>,
}

pub(super) struct OpenBuildArtifact {
    result: FixedResult,
    pub(super) output: tsumugi_plugin_sdk::ArtifactSet,
}

impl OpenBuildArtifact {
    pub(super) fn matches(&self, result: &FixedResult) -> bool {
        self.result.envelope().result_id == result.envelope().result_id
            && self.result.digest() == result.digest()
            && self.result.bytes() == result.bytes()
    }
}

struct OpenLinkValidation<'a> {
    checker: &'a mut OpenCheckerFrames,
    build: &'a mut Option<OpenBuildEvidence>,
    source: Option<&'a (crate::content::SourceBundle, crate::content::SourceSettings)>,
}

/// One strictly received result for the exact input in the current open snapshot.
/// A different result replaces the slot; the entire slot dies with this attempt.
/// The original rows and grants cannot change inside this pinned transaction.
pub(super) struct OpenResultReader<'a> {
    connection: &'a Connection,
    input: &'a FixedInput,
    verified: Option<FixedResult>,
    checker: Option<&'a mut OpenCheckerFrames>,
    build: Option<OpenBuildEvidence>,
}

impl<'a> OpenResultReader<'a> {
    fn new(connection: &'a Connection, input: &'a FixedInput) -> Self {
        Self {
            connection,
            input,
            verified: None,
            checker: None,
            build: None,
        }
    }

    pub(super) fn input(&self) -> &'a FixedInput {
        self.input
    }

    pub(super) fn take_build_evidence(&mut self) -> Option<OpenBuildEvidence> {
        self.build.take()
    }

    fn validate_links(
        &mut self,
        links: Vec<(ExecutionId, bool)>,
        source: Option<&(crate::content::SourceBundle, crate::content::SourceSettings)>,
        mut checked: impl FnMut(ExecutionId, CheckedPluginLink, bool),
    ) -> Result<(), ExecutionError> {
        for (id, valid) in links {
            let result = self.load(id)?;
            let open = self.checker.as_deref_mut().map(|checker| OpenLinkValidation {
                checker,
                build: &mut self.build,
                source,
            });
            let link = validate_plugin_link_with_open_evidence(
                self.connection,
                self.input,
                &result,
                valid,
                open,
                None,
            )?;
            checked(id, link, valid);
        }
        Ok(())
    }

    pub(super) fn load(&mut self, result: ExecutionId) -> Result<FixedResult, ExecutionError> {
        let previous = self.verified.take();
        // Reused results retain their original input and permission owner. Do
        // not reuse qualification under the retry attempt's different input.
        if self
            .input
            .envelope()
            .reused_results
            .iter()
            .any(|reference| reference.result_id == result)
        {
            return load_result(self.connection, self.input, result);
        }
        let previous = previous.filter(|fixed| fixed.envelope().result_id == result);
        let fixed = match previous {
            Some(verified) if self.connection.transaction_state(Some(rusqlite::MAIN_DB))
                .map_err(sql_error)? == rusqlite::TransactionState::Read => verified,
            previous => load_result_with_verified(self.connection, self.input, result, previous.as_ref())?,
        };
        self.verified = Some(fixed.clone());
        Ok(fixed)
    }
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
        .query_map(params![wanted, MAX_PLUGIN_RESULT_BYTES as i64], |r| {
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
        let fixed = FixedResult::restore_owned(result_bytes, &result_digest, &input, parse_id(token)?)?;
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
    let attempt = input.envelope().attempt_id;
    with_stored_input(connection, attempt, |manifest, row| {
        let digest: String = row.get(1).map_err(sql_error)?;
        if digest != input.digest() {
            return Err(error(ErrorCode::CorruptLedger, "input-bytes"));
        }
        input_storage::check_frame(connection, manifest, input.bytes())?;
        let task: String = row.get(2).map_err(sql_error)?;
        let project: String = row.get(3).map_err(sql_error)?;
        let previous: Option<String> = row.get(4).map_err(sql_error)?;
        check_input_association(input, attempt, &task, &project, previous.as_deref())
    })
}
struct StoredResult {
    row_id: i64,
    size: u32,
    digest: String,
    item: String,
    token: String,
}
impl StoredResult {
    fn open_bytes<'a>(&self, connection: &'a Connection) -> Result<rusqlite::blob::Blob<'a>, ExecutionError> {
        let bytes = connection.blob_open(rusqlite::MAIN_DB, "execution_results", "bytes", self.row_id, true)
            .map_err(sql_error)?;
        if bytes.len() != self.size as usize {
            return Err(error(ErrorCode::CorruptLedger, "result-bytes"));
        }
        Ok(bytes)
    }
}

fn stored_result(
    connection: &Connection,
    attempt: ExecutionId,
    result: ExecutionId,
    max_bytes: usize,
) -> Result<StoredResult, ExecutionError> {
    let row = connection.prepare_cached(
        "SELECT rowid,CASE WHEN typeof(bytes)='blob' AND length(bytes) BETWEEN 1 AND ?3 THEN length(bytes) END,
                digest,item_id,dispatch_token
         FROM execution_results WHERE result_id=?1 AND attempt_id=?2",
    ).map_err(sql_error)?
        .query_row(params![result.to_string(), attempt.to_string(), max_bytes as i64], |row| {
            Ok(StoredResult {
                row_id: row.get(0)?,
                size: row.get(1)?,
                digest: row.get(2)?,
                item: row.get(3)?,
                token: row.get(4)?,
            })
        }).map_err(sql_error)?;
    Ok(row)
}

fn check_stored_result(
    connection: &Connection,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    let expected = result.envelope();
    super::review::read_snapshot(connection, |connection| {
        let row = stored_result(connection, expected.attempt_id, expected.result_id, MAX_PLUGIN_RESULT_BYTES)?;
        if row.digest != result.digest()
            || row.item != expected.item_id.to_string()
            || row.token != expected.dispatch_token.to_string()
            || !super::blob_matches(&row.open_bytes(connection)?, result.bytes()).map_err(sql_error)?
        {
            return Err(error(ErrorCode::CorruptLedger, "result-bytes"));
        }
        Ok(())
    })
}
fn read_attempt(
    connection: &Connection,
    attempt: ExecutionId,
    active: bool,
) -> Result<AttemptView, ExecutionError> {
    let input = load_input(connection, attempt)?;
    read_attempt_in(connection, &input, active)
}

// Reuse the caller's exact input capture while ordinary reads still receive
// every result independently. Open supplies its own attempt-local result reader.
fn read_attempt_in(
    connection: &Connection,
    input: &FixedInput,
    active: bool,
) -> Result<AttemptView, ExecutionError> {
    read_attempt_with_results(
        connection,
        input,
        active,
        |result| load_result(connection, input, result),
        |result| validate_plugin_link(connection, input, result, true).map(|_| ()),
    )
}

fn read_attempt_with_results(
    connection: &Connection,
    input: &FixedInput,
    active: bool,
    mut load_result: impl FnMut(ExecutionId) -> Result<FixedResult, ExecutionError>,
    mut validate_link: impl FnMut(&FixedResult) -> Result<(), ExecutionError>,
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
            match load_result(parse_id(result)?) {
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
                        validate_link(&output)?;
                    }
                    if validation == ValidationState::Valid
                        && input.envelope().operation == crate::ai::conversation_planning::OPERATION {
                        crate::ai::conversation_planning::validate_output(input, &output)?;
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

// The open scan verifies every link in the same snapshot as the attempts.
// A result already marked valid still requires its positive link.
fn require_open_valid_plugin_link(
    connection: &Connection,
    result: ExecutionId,
) -> Result<(), ExecutionError> {
    let valid: bool = connection
        .query_row(
            "SELECT valid FROM plugin_validation_links WHERE producer_result_id=?1",
            [result.to_string()],
            |row| row.get(0),
        )
        .map_err(|_| error(ErrorCode::CorruptLedger, "semantic-validation-link"))?;
    if !valid {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
    }
    Ok(())
}

fn stored_check_link(
    connection: &Connection,
    result: &FixedResult,
) -> Result<(String, bool), ExecutionError> {
    connection.query_row(
        "SELECT checker_result_id,valid FROM plugin_validation_links WHERE producer_result_id=?1",
        [result.envelope().result_id.to_string()], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| error(ErrorCode::CorruptLedger, "semantic-validation-link"))
}

fn load_check_link(
    connection: &Connection,
    result: &FixedResult,
) -> Result<(FixedInput, FixedResult, bool), ExecutionError> {
    let (checker_id, saved_valid) = stored_check_link(connection, result)?;
    let check_input = load_check_input(connection, &checker_id)?;
    let check_result = load_check_result(connection, &check_input, &checker_id)?;
    Ok((check_input, check_result, saved_valid))
}

fn load_check_input(connection: &Connection, checker_id: &str) -> Result<FixedInput, ExecutionError> {
    let checker_attempt: String = connection
        .query_row(
            "SELECT attempt_id FROM execution_results WHERE result_id=?1",
            [checker_id],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    load_input(connection, parse_id(checker_attempt)?)
}

/// The saved checker frame binds these typed inputs and the exact SDK request
/// digest. Only dispatch needs to materialize the SDK request body.
fn derive_check_input(
    connection: &Connection,
    checker: &FixedInput,
    materialize: bool,
) -> Result<FixedInput, ExecutionError> {
    let envelope = checker.envelope();
    let (attempt, result, operation) = match envelope.operation.as_str() {
        SOURCE_CHECK_OPERATION => {
            let basis = SourceValidationBasis::deserialize(&envelope.settings)
                .map_err(|_| error(ErrorCode::CorruptLedger, "source-check-basis"))?;
            (basis.source_attempt_id, basis.source_result_id, crate::content::OPERATION)
        }
        ARTIFACT_CHECK_OPERATION => {
            let basis = ArtifactValidationBasis::deserialize(&envelope.settings)
                .map_err(|_| error(ErrorCode::CorruptLedger, "artifact-check-basis"))?;
            (basis.build_attempt_id, basis.build_result_id, crate::content::BUILD_OPERATION)
        }
        _ => return Err(error(ErrorCode::InvalidInput, "semantic-check-operation")),
    };
    let input = load_input(connection, attempt)?;
    if input.envelope().operation != operation {
        return Err(error(ErrorCode::CorruptLedger, "semantic-check-producer"));
    }
    let result = load_result(connection, &input, result)?;
    let capture = ResultValidationCapture { input, result };
    if operation == crate::content::OPERATION {
        SourceValidationCapture::derive_input(capture, checker, materialize)
    } else {
        ArtifactValidationCapture::derive_input(capture, checker, materialize)
    }
}

fn load_check_result(
    connection: &Connection,
    check_input: &FixedInput,
    checker_id: &str,
) -> Result<FixedResult, ExecutionError> {
    load_result(connection, check_input, parse_id(checker_id.to_owned())?)
        .map_err(|failure| {
            // This is a saved proof frame, not a fresh worker response.
            if failure.stage == "result-digest" {
                error(ErrorCode::CorruptLedger, "result-bytes")
            } else {
                failure
            }
        })
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
    let check_input = load_check_input(connection, &checker_id)?;
    let (capture, _) = ArtifactValidationCapture::restore_with_plan(
        ResultValidationCapture {
            input: original.as_ref().clone(),
            result: result.clone(),
        },
        check_input,
        &plan,
    )?;
    let check_result = load_check_result(connection, &capture.check_input, &checker_id)?;
    let prepared = capture.prepare(check_result)?;
    let check_input = &prepared.capture.check_input;
    let check_result = &prepared.check_result;
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ReadSnapshotStamp {
    connection: String,
    data_version: i64,
    schema_version: i64,
    temp_schema_version: i64,
    total_changes: u64,
}

fn pin_snapshot(connection: &Connection) -> Result<(), ExecutionError> {
    connection.query_row("SELECT count(*) FROM main.sqlite_schema", [], |_| Ok(()))
        .map_err(sql_error)
}

pub(super) fn snapshot_stamp(connection: &Connection) -> Result<ReadSnapshotStamp, ExecutionError> {
    Ok(ReadSnapshotStamp {
        connection: connection.query_row("SELECT tsumugi_connection_identity()", [], |r| r.get(0)).map_err(sql_error)?,
        data_version: connection.query_row("PRAGMA main.data_version", [], |r| r.get(0)).map_err(sql_error)?,
        schema_version: connection.query_row("PRAGMA main.schema_version", [], |r| r.get(0)).map_err(sql_error)?,
        temp_schema_version: connection.query_row("PRAGMA temp.schema_version", [], |r| r.get(0)).map_err(sql_error)?,
        total_changes: connection.total_changes(),
    })
}

pub(super) fn read_snapshot_stamp(connection: &Connection) -> Result<Option<ReadSnapshotStamp>, ExecutionError> {
    if connection.is_autocommit() {
        return Ok(None);
    }
    // Pin the database before observing its version. A write transaction may
    // roll back without decrementing total_changes, so it cannot qualify reuse.
    pin_snapshot(connection)?;
    if connection.transaction_state(Some(rusqlite::MAIN_DB)).map_err(sql_error)?
        != rusqlite::TransactionState::Read
    {
        return Ok(None);
    }
    snapshot_stamp(connection).map(Some)
}

// Retain only UI projections, never the underlying large frames or permits.
#[derive(Debug, Default)]
pub(super) struct AttemptDetailCache {
    stamp: Option<ReadSnapshotStamp>,
    pages: std::collections::VecDeque<(AttemptDetailKey, AttemptDetail)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AttemptDetailKey {
    attempt_id: ExecutionId,
    active: bool,
    offset: u32,
    limit: u32,
}

impl AttemptDetailCache {
    fn use_stamp(&mut self, stamp: &ReadSnapshotStamp) {
        if self.stamp.as_ref() != Some(stamp) {
            self.pages.clear();
            self.stamp = Some(stamp.clone());
        }
    }

    fn insert(&mut self, key: AttemptDetailKey, detail: AttemptDetail) {
        if self.pages.len() == 4 {
            self.pages.pop_front();
        }
        self.pages.push_back((key, detail));
    }
}

struct SourceReadValidation {
    stamp: ReadSnapshotStamp,
    semantic_valid: bool,
    bundle: bool,
    snapshot: Option<(ExecutionId, bool, u64)>,
    summary: Option<Option<tsumugi_plugin_sdk::SourceCaptureSummary>>,
}
struct SourceValidationMemo {
    source: ResultValidationCapture,
    projected: std::sync::Arc<crate::content::SourceOutput>,
    prepared: Option<PreparedSourceValidation>,
    read: Option<SourceReadValidation>,
}
fn source_validation_cache() -> &'static std::sync::Mutex<Option<SourceValidationMemo>> {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<Option<SourceValidationMemo>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub(super) fn remember_source_validation(prepared: PreparedSourceValidation) {
    *source_validation_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(SourceValidationMemo {
            source: prepared.capture.source.clone(), projected: prepared.capture.projected.clone(),
            prepared: Some(prepared), read: None,
        });
}

/// Only immutable capture/mapping checks share this memo. Callers still read
/// current content clocks and execution authority inside their own transaction.
pub(super) fn source_read_validation(
    connection: &Connection,
    result: ExecutionId,
) -> Result<Option<(bool, Option<(ExecutionId, bool, u64)>)>, ExecutionError> {
    let Some(stamp) = read_snapshot_stamp(connection)? else { return Ok(None); };
    Ok(source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref().filter(|memo| memo.source.result.envelope().result_id == result)
        .and_then(|memo| memo.read.as_ref())
        .filter(|read| read.stamp == stamp)
        .map(|read| (read.bundle, read.snapshot)))
}

pub(super) fn remember_source_read_validation(
    connection: &Connection,
    result: ExecutionId,
    snapshot: Option<(ExecutionId, bool, u64)>,
) -> Result<(), ExecutionError> {
    let Some(stamp) = read_snapshot_stamp(connection)? else { return Ok(()); };
    let mut cache = source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(memo) = cache.as_mut().filter(|memo| memo.source.result.envelope().result_id == result) {
        if let Some(read) = memo.read.as_mut().filter(|read| read.stamp == stamp) {
            read.bundle = true;
            if snapshot.is_some() { read.snapshot = snapshot; }
        }
    }
    Ok(())
}

pub(super) fn source_capture_summary(
    connection: &Connection,
    result: ExecutionId,
    output: &crate::content::SourceOutput,
) -> Result<Option<tsumugi_plugin_sdk::SourceCaptureSummary>, ExecutionError> {
    let stamp = read_snapshot_stamp(connection)?;
    let cached = source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref().filter(|memo| memo.source.result.envelope().result_id == result)
        .and_then(|memo| memo.read.as_ref()).filter(|read| Some(&read.stamp) == stamp.as_ref())
        .and_then(|read| read.summary.clone());
    if let Some(summary) = cached { return Ok(summary); }
    let summary = output.capture_summary()?;
    let mut cache = source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(read) = cache.as_mut()
        .filter(|memo| memo.source.result.envelope().result_id == result)
        .and_then(|memo| memo.read.as_mut()).filter(|read| Some(&read.stamp) == stamp.as_ref())
    {
        read.summary = Some(summary.clone());
    }
    Ok(summary)
}

/// Reuse the existing single-proof qualification, never a claim that stored
/// frames or their provenance are immutable. A read token covers only the exact
/// connection snapshot; content separately qualifies its bundle and mappings.
pub(super) fn load_qualified_source(
    connection: &Connection,
    attempt: ExecutionId,
    result: ExecutionId,
) -> Result<(FixedInput, FixedResult, std::sync::Arc<crate::content::SourceOutput>), ExecutionError> {
    load_source_projection(connection, attempt, result, true)
}

/// Structural preview does not confer semantic approval. Both variants share
/// one immutable capture, and qualification still requires the original checker.
pub(super) fn load_source_projection(
    connection: &Connection,
    attempt: ExecutionId,
    result: ExecutionId,
    require_semantic: bool,
) -> Result<(FixedInput, FixedResult, std::sync::Arc<crate::content::SourceOutput>), ExecutionError> {
    let stamp = read_snapshot_stamp(connection)?;
    let verified = source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref().filter(|memo| {
            let source = &memo.source;
            source.input.envelope().attempt_id == attempt
                && source.result.envelope().result_id == result
                && memo.read.as_ref().is_some_and(|read| {
                    Some(&read.stamp) == stamp.as_ref()
                        && (!require_semantic || source.input.envelope().plugin.is_none()
                            || read.semantic_valid)
                })
        }).map(|memo| (memo.source.clone(), memo.projected.clone()));
    if let Some((source, projected)) = verified {
        return Ok((source.input, source.result, projected));
    }
    let cached = source_validation_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|memo| {
            let source = &memo.source;
            source.input.envelope().attempt_id == attempt
                && source.result.envelope().attempt_id == attempt
                && source.result.envelope().result_id == result
        })
        .map(|memo| memo.source.clone());
    let (input, result) = if let Some(source) = cached {
        // Recheck before using the capture even if another reader evicts the
        // single memo before validate_source_link performs its own lookup.
        check_stored_input(connection, &source.input)?;
        check_stored_result(connection, &source.result)?;
        super::resources::verify_input_fact_decisions(connection, &source.input)?;
        super::plugin_execution::validate_result_in(connection, &source.input, &source.result)?;
        (source.input, source.result)
    } else {
        let input = load_input(connection, attempt)?;
        let result = load_result(connection, &input, result)?;
        (input, result)
    };
    let (output, prepared) = if require_semantic && input.envelope().plugin.is_some() {
        // Persisted snapshots require the original mandatory semantic proof.
        // Its restored projection belongs to exactly these rechecked frames.
        let prepared = validate_source_link(connection, &input, &result, true)?;
        (prepared.capture.projected.clone(), Some(prepared))
    } else {
        (std::sync::Arc::new(crate::content::validate_output(&input, &result)?), None)
    };
    if let Some(stamp) = stamp {
        let mut cache = source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // A proposed capture is the second side of a comparison. Keep the
        // adopted side's qualified proof warm across pages without retaining
        // both complete captures in the cache.
        let keeps_adopted_proof = !require_semantic && cache.as_ref().is_some_and(|memo| {
            memo.read.as_ref().is_some_and(|read| read.stamp == stamp && read.semantic_valid)
        });
        if !keeps_adopted_proof {
            let semantic_valid = prepared.as_ref().is_some_and(|prepared| prepared.proof.valid);
            *cache = Some(SourceValidationMemo {
                source: ResultValidationCapture { input: input.clone(), result: result.clone() },
                projected: output.clone(), prepared,
                read: Some(SourceReadValidation { stamp, semantic_valid, bundle: false, snapshot: None, summary: None }),
            });
        }
    }
    Ok((input, result, output))
}

pub(super) fn validate_source_link(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    expected_valid: bool,
) -> Result<PreparedSourceValidation, ExecutionError> {
    validate_source_link_with_bundle(connection, input, result, expected_valid, None)
}

fn validate_source_link_with_bundle(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    expected_valid: bool,
    source: Option<&(crate::content::SourceBundle, crate::content::SourceSettings)>,
) -> Result<PreparedSourceValidation, ExecutionError> {
    // Memoize only pure immutable source qualification, bounded to one proof.
    // Each reuse checks all four original frames and row associations, plus
    // the current proof link. Execution grants/currentness are never cached.
    let cache = source_validation_cache();
    let (checker_id, saved_valid) = stored_check_link(connection, result)?;
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(|memo| memo.prepared.as_ref())
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
        check_cached_source_validation(connection, &prepared)?;
        return Ok(prepared);
    }
    let capture = SourceValidationCapture::restore_with_source(
        ResultValidationCapture {
            input: input.clone(),
            result: result.clone(),
        },
        source.map(|(bundle, settings)| (bundle, settings)),
        || load_check_input(connection, &checker_id),
    )?;
    let check_result = load_check_result(connection, &capture.check_input, &checker_id)?;
    let prepared = capture.prepare(check_result)?;
    if saved_valid != expected_valid || prepared.proof.valid != saved_valid {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
    }
    remember_source_validation(prepared.clone());
    Ok(prepared)
}

/// A publication can reuse the same qualified frames after its write commits.
/// The row bytes, grants and the exact publication are still checked separately.
pub(super) fn read_cached_source_publication(
    connection: &Connection,
    project: ExecutionId,
    checker_attempt: ExecutionId,
    checker_result: ExecutionId,
    producer_result: ExecutionId,
    valid: bool,
) -> Result<bool, ExecutionError> {
    let prepared = source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref().and_then(|memo| memo.prepared.as_ref()).filter(|proof| {
            proof.capture.source.input.envelope().project_id == project
                && proof.capture.source.result.envelope().result_id == producer_result
                && proof.capture.check_input.envelope().attempt_id == checker_attempt
                && proof.check_result.envelope().result_id == checker_result
        }).cloned();
    let Some(prepared) = prepared else { return Ok(false); };
    if prepared.proof.valid != valid {
        return Err(error(ErrorCode::CorruptLedger, "source-check-publication"));
    }
    check_cached_source_validation(connection, &prepared)?;
    Ok(true)
}

fn check_cached_source_validation(connection: &Connection, prepared: &PreparedSourceValidation) -> Result<(), ExecutionError> {
    let source = &prepared.capture.source;
    for (input, result) in [(&source.input, &source.result), (&prepared.capture.check_input, &prepared.check_result)] {
        check_stored_input(connection, input)?;
        check_stored_result(connection, result)?;
        super::resources::verify_input_fact_decisions(connection, input)?;
        super::plugin_execution::validate_result_in(connection, input, result)?;
    }
    Ok(())
}

pub(super) fn validate_plugin_link(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    expected_valid: bool,
) -> Result<CheckedPluginLink, ExecutionError> {
    validate_plugin_link_with_open_evidence(connection, input, result, expected_valid, None, None)
}

fn validate_plugin_link_with_open_evidence(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    expected_valid: bool,
    mut open: Option<OpenLinkValidation<'_>>,
    live_artifact_authority: Option<(&crate::execution::plugin_authority::PluginAuthority, &mut Vec<PluginPermit>)>,
) -> Result<CheckedPluginLink, ExecutionError> {
    let original = result_input(connection, input, result.envelope().result_id)?;
    let same_attempt = std::ptr::eq(input, original.as_ref());
    let input = original.as_ref();
    if input.envelope().operation == crate::content::OPERATION {
        let source = open.as_ref().filter(|_| same_attempt).and_then(|open| open.source);
        let proof = validate_source_link_with_bundle(connection, input, result, expected_valid, source)?;
        if let Some(open) = open {
            open.checker.remember(&proof.capture.check_input, &proof.check_result);
            if same_attempt && let Some(stamp) = read_snapshot_stamp(connection)? {
                // The source association, bundle and checker all passed in
                // this transaction. Keep the projection for the snapshot owner
                // without pinning the checker frames through later build scans.
                *source_validation_cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some(SourceValidationMemo {
                        source: proof.capture.source.clone(),
                        projected: proof.capture.projected.clone(),
                        prepared: None,
                        read: Some(SourceReadValidation {
                            stamp, semantic_valid: proof.proof.valid, bundle: true, snapshot: None, summary: None,
                        }),
                    });
            }
        }
        return Ok(CheckedPluginLink::Source {
            checker_attempt: proof.check_result.envelope().attempt_id,
            checker_result: proof.check_result.envelope().result_id,
        });
    }
    if input.envelope().operation == crate::content::TRANSLATION_EXTRACTION_OPERATION {
        validate_translation_link(connection, input, result, expected_valid)?;
        return Ok(CheckedPluginLink::Translation);
    }
    if input.envelope().plugin.is_none()
        || input.envelope().operation != crate::content::BUILD_OPERATION
    {
        return Err(error(
            ErrorCode::CorruptLedger,
            "semantic-validation-operation",
        ));
    }
    let (checker_id, saved_valid) = stored_check_link(connection, result)?;
    let check_input = load_check_input(connection, &checker_id)?;
    let build_result = ResultValidationCapture {
        input: input.clone(),
        result: result.clone(),
    };
    let build = open.as_mut().filter(|_| same_attempt).map(|open| &mut *open.build);
    let (capture, artifact) = if let Some(build) = build {
        let evidence = match build {
            Some(evidence) => evidence,
            None => build.insert(OpenBuildEvidence {
                plan: match input.open_build_plan() {
                    Some(plan) => plan.clone(),
                    None => std::sync::Arc::new(crate::ReleasePlan::from_input(input)?),
                },
                artifact: None,
            }),
        };
        let (capture, output) = ArtifactValidationCapture::restore_with_plan(
            build_result,
            check_input,
            &evidence.plan,
        )?;
        (capture, Some((&mut evidence.artifact, output)))
    } else {
        (ArtifactValidationCapture::restore(build_result, check_input)?, None)
    };
    let check_result = load_check_result(connection, &capture.check_input, &checker_id)?;
    let prepared = capture.prepare(check_result)?;
    if saved_valid != expected_valid || prepared.proof.valid != saved_valid {
        return Err(error(ErrorCode::CorruptLedger, "semantic-validation-proof"));
    }
    if let Some((authority, permits)) = live_artifact_authority {
        permits.push(require_live_checker(
            connection,
            &prepared.capture.check_input,
            &prepared.check_result,
            authority,
        )?);
    }
    if let Some((slot, output)) = artifact.filter(|_| saved_valid) {
        *slot = Some(OpenBuildArtifact { result: result.clone(), output });
    }
    if let Some(open) = open {
        open.checker.remember(&prepared.capture.check_input, &prepared.check_result);
    }
    Ok(CheckedPluginLink::Artifact {
        build_attempt: input.envelope().attempt_id,
    })
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
    if connection.is_autocommit() {
        return super::review::read_snapshot(connection, |connection| check_translation_projection(connection, input, authority));
    }
    use frame_read_guard::{FrameReadGuard, ReadObservation};
    let projection = crate::content::TranslationProjection::from_input(input)?;
    let origin = &projection.origin;
    use std::sync::{Mutex, OnceLock};
    type Frames = (FixedInput, FixedResult, FixedInput, FixedResult);
    // Pure qualification is reused only while all of its verified storage
    // dependencies remain unchanged. Mutable authority is checked on every call.
    static CACHE: OnceLock<Mutex<Option<(String, Frames, Option<FrameReadGuard>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(digest, _, _)| digest == input.digest())
        .map(|(_, frames, guard)| (frames.clone(), guard.clone()));
    let current = match &cached {
        Some((_, Some(guard))) => guard.current(connection)?,
        _ => false,
    };
    let observed = if current { None } else { ReadObservation::begin(connection)? };
    let (producer, result, checker, checked) = if let Some((frames, _)) = cached {
        if !current {
            check_stored_input(connection, &frames.0)?;
            check_stored_result(connection, &frames.1)?;
            check_stored_input(connection, &frames.2)?;
            check_stored_result(connection, &frames.3)?;
        }
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
            Some(&projection.files().iter().map(|file| file.artifact_id).collect::<Vec<_>>()),
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
        (producer, result, checker, checked)
    };
    if !current {
        let guard = observed.map(|observed| observed.finish(connection,
            &[&producer, &checker], &[&result, &checked])).transpose()?.flatten();
        *cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((input.digest().into(),
            (producer.clone(), result.clone(), checker.clone(), checked.clone()), guard));
    }
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
    /// Read original enqueue evidence without current scope, plugin grants or a runtime.
    /// Only a complete successful read reconciles the in-memory recovery guard.
    pub fn translation_projection_start_action_read(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        digest: &str,
    ) -> Result<Option<crate::content::TranslationProjectionStartRead>, ExecutionError> {
        let found = super::review::read_snapshot(self.execution_connection()?, |connection| {
            if super::read_metadata_from(connection)
                .map_err(|_| error(ErrorCode::CorruptLedger, "translation-projection-project"))?
                .project_id()
                .to_string()
                != project.to_string()
            {
                return Err(error(
                    ErrorCode::ResultMismatch,
                    "translation-projection-project",
                ));
            }
            if tsumugi_plugin_sdk::validate_package_digest(digest).is_err() {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "translation-projection-digest",
                ));
            }
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                    [attempt.to_string()],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if !exists {
                return Ok(None);
            }
            let input = load_input(connection, attempt)?;
            let envelope = input.envelope();
            if envelope.project_id != project
                || envelope.attempt_id != attempt
                || input.digest() != digest
                || envelope.plugin.is_some()
                || envelope.automation.is_some()
                || envelope.previous_attempt_id.is_some()
            {
                return Err(error(
                    ErrorCode::ResultMismatch,
                    "translation-projection-request",
                ));
            }
            let projection = crate::content::TranslationProjection::from_input(&input)?;
            check_translation_projection(connection, &input, None)?;
            Ok(Some(crate::content::TranslationProjectionStartRead {
                project_id: project,
                task_id: envelope.task_id,
                attempt_id: attempt,
                input_digest: input.digest().into(),
                translation_attempt_id: projection.origin.producer_attempt,
                translation_result_id: projection.origin.producer_result,
            }))
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
    }
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
            None,
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
        let connection = self.execution_connection()?;
        super::review::read_snapshot(connection, |connection| {
            let input = load_input(connection, attempt)?;
            let view = read_attempt_in(connection, &input, active)?;
            self.execution_recovery_in(connection, &input, &view)
        })
    }

    fn execution_recovery_in(
        &self,
        connection: &Connection,
        input: &FixedInput,
        view: &AttemptView,
    ) -> Result<RecoveryPlan, ExecutionError> {
        let attempt = view.attempt_id;
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
            // Planning never offers execution replay. A validated typed revision
            // can be saved as an unselected candidate through the original result.
            if is_conversation_planning(input) {
                if input.envelope().capability_version == "4"
                    && let [result_id] = entry.result_ids.as_slice()
                    && let [status] = statuses.as_slice()
                    && status.execution == ExecutionState::Succeeded
                    && status.validation == ValidationState::Valid
                {
                    let result = load_result(connection, input, *result_id)?;
                    if matches!(
                        crate::ai::conversation_planning::validate_output(input, &result)?.model,
                        crate::ai::conversation_planning::ConversationPlanningModelOutput::Revision { .. }
                    ) {
                        if let Some(receipt) = read_receipt(connection, *result_id)? {
                            if receipt.attempt_id != attempt || receipt.unit_id != unit.unit_id {
                                return Err(error(ErrorCode::CorruptLedger, "selected-revision-receipt"));
                            }
                            entry.receipt_id = Some(*result_id);
                            entry.actions.push(RecoveryAction::ViewReceipt);
                        } else if !status.cancellation_requested && status.adoption == AdoptionState::Unapplied {
                            entry.actions.push(RecoveryAction::AdoptResult);
                        }
                        if !entry.actions.is_empty() {
                            units.push(entry);
                            continue;
                        }
                    }
                }
                let reason = if statuses
                    .iter()
                    .any(|item| item.execution == ExecutionState::Dispatched)
                {
                    "still-running"
                } else if statuses
                    .iter()
                    .any(|item| item.execution == ExecutionState::Unknown)
                {
                    "outcome-unknown"
                } else if statuses
                    .iter()
                    .any(|item| item.validation == ValidationState::Invalid)
                {
                    "output-invalid"
                } else {
                    "conversation-planning-read-only"
                };
                entry.blocked_reason = Some(reason.into());
                units.push(entry);
                continue;
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
        if is_conversation_planning(&input) {
            return Err(error(ErrorCode::Unauthorized, "conversation-planning-recovery"));
        }
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
        self.queued_execution_attempt_page(after, 128)
            .map(|rows| rows.into_iter().map(|(attempt, _)| attempt).collect())
    }
    pub(crate) fn queued_execution_attempt_page(
        &self,
        after: Revision,
        limit: usize,
    ) -> Result<Vec<(ExecutionId, Revision)>, ExecutionError> {
        if !(1..=128).contains(&limit) {
            return Err(error(ErrorCode::LimitExceeded, "execution-queue-page"));
        }
        let mut statement=self.execution_connection()?.prepare("SELECT a.attempt_id,a.sequence FROM execution_attempts a WHERE a.sequence>?1 AND EXISTS(SELECT 1 FROM execution_items i WHERE i.attempt_id=a.attempt_id AND i.execution='queued') ORDER BY a.sequence LIMIT ?2").map_err(sql_error)?;
        statement
            .query_map(params![after.get() as i64, limit as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(sql_error)?
            .map(|row| {
                let (attempt, sequence) = row.map_err(sql_error)?;
                Ok((
                    parse_id(attempt)?,
                    Revision::new(
                        u64::try_from(sequence)
                            .map_err(|_| error(ErrorCode::CorruptLedger, "execution-sequence"))?,
                    )?,
                ))
            })
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
        super::review::read_snapshot(self.execution_connection()?, |connection| {
            let input = load_input(connection, attempt)?;
            let token: Option<String> = connection.query_row(
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
            let input = if is_derived_check(&input.envelope().operation) {
                derive_check_input(connection, &input, true)?
            } else {
                input
            };
            Ok(DispatchRequest {
                provider: None,
                plugin_permit,
                service_origin: None,
                planning_permit: None,
                original_deadline: None,
                input,
                item_id: item,
                dispatch_token: parse_id(
                    token.ok_or_else(|| error(ErrorCode::InvalidInput, "dispatch-token"))?,
                )?,
            })
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
        self.execution_write_scoped(super::ChangeScope::Execution)
    }
    pub(super) fn execution_write_scoped(&self, scope: super::ChangeScope) -> Result<ExecutionTransaction<'_>, ExecutionError> {
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
        let observer = change_clock.observe(&tx, scope);
        Ok(ExecutionTransaction {
            tx,
            unknown,
            observer,
        })
    }

    pub fn reconcile_execution(&self) -> Result<(), ExecutionError> {
        if self.is_reconciling() {
            // Reconciliation verifies history. Clearing the shared unknown flag
            // must never revive a planning permit that no worker observed yet.
            // The revision also invalidates a sealed permission not yet enqueued.
            self.planning_authority_revision.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            for permit in self.conversation_planning_permits.values() {
                permit.revoke();
            }
        }
        let connection = self.execution_connection()?;
        if !connection.is_autocommit() {
            return Err(error(ErrorCode::OutcomeUnknown, "reconcile"));
        }
        validate(connection)?;
        super::content::validate(connection, None)?;
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
        self.enqueue_execution_with_authority(
            input, policy, parent, None, None, None, None, None, None,
            None,
        )
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
            None,
            None,
        )
    }
    pub(crate) fn enqueue_team_work(
        &mut self,
        prepared: &crate::application::PreparedTeamWork,
        policy: RecoveryPolicy,
    ) -> Result<(), ExecutionError> {
        if let Some(scope) = &prepared.scope {
            self.check_work_plan_agent_scope(scope)?;
        }
        let settings = crate::ai::team::settings(prepared.input())?;
        let parent = if settings.binding.is_root() {
            None
        } else {
            Some(settings.binding.scope().root_task)
        };
        self.enqueue_execution_with_authority(
            prepared.input(),
            policy,
            parent,
            None,
            None,
            None,
            None,
            None,
            Some(prepared),
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
            None,
            None,
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
            Some((prepared, permit, None)),
            None,
            None,
            None,
        )
    }

    pub(crate) fn enqueue_member_mcp_term_query(
        &mut self,
        sealed: &crate::application::PreparedMemberMcpTermQuery,
    ) -> Result<(), ExecutionError> {
        self.check_prepared_member_mcp_term_query(sealed)?;
        self.enqueue_execution_with_authority(
            sealed.prepared().input(), RecoveryPolicy::ExternalUnknown, None, None,
            None, None, Some((sealed.prepared(), sealed.permit(), Some(sealed))), None, None,
            None,
        )
    }

    pub(crate) fn enqueue_conversation_planning(
        &mut self,
        prepared: &crate::application::PreparedConversationPlanning,
    ) -> Result<(), ExecutionError> {
        self.check_prepared_conversation_planning(prepared)?;
        self.enqueue_execution_with_authority(
            prepared.input(), RecoveryPolicy::ExternalUnknown, None, None, None,
            None, None, None, None, Some(prepared),
        )?;
        self.install_conversation_planning(prepared).map_err(|mut error| {
            prepared.permit.revoke();
            error.code = ErrorCode::OutcomeUnknown;
            error
        })
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
            Option<&crate::application::PreparedMemberMcpTermQuery>,
        )>,
        service_tool: Option<&crate::application::PreparedWorkPlanServiceTool>,
        team_work: Option<&crate::application::PreparedTeamWork>,
        planning: Option<&crate::application::PreparedConversationPlanning>,
    ) -> Result<(), ExecutionError> {
        if (input.envelope().operation == crate::ai::conversation_planning::OPERATION
            || input.envelope().capability_id == crate::ai::conversation_planning::CAPABILITY)
            && planning.is_none() {
            return Err(error(ErrorCode::Unauthorized, "conversation-planning-admission"));
        }
        if let Some(prepared) = planning {
            if parent.is_some() || tool.is_some() || service.is_some() || agent.is_some()
                || mcp.is_some() || service_tool.is_some() || team_work.is_some()
                || policy != RecoveryPolicy::ExternalUnknown || prepared.input().bytes() != input.bytes() {
                return Err(error(ErrorCode::Unauthorized, "conversation-planning-admission"));
            }
            self.check_prepared_conversation_planning(prepared)?;
        }
        if (input.envelope().operation == crate::application::MCP_TERM_QUERY_OPERATION
            || input.envelope().capability_id == crate::application::MCP_TERM_QUERY_CAPABILITY)
            && mcp.is_none()
        {
            return Err(error(ErrorCode::Unauthorized, "mcp-query-admission"));
        }
        if input.envelope().operation == crate::ai::team::OPERATION && team_work.is_none() {
            return Err(error(ErrorCode::Unauthorized, "team-work-admission"));
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
        if let Some(prepared) = planning {
            self.check_prepared_conversation_planning(prepared)?;
        }
        if let Some((prepared, permit, member)) = mcp {
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
            match member {
                Some(sealed) => super::application::member_mcp::check_prepared(&tx, sealed)?,
                None if prepared.member_binding.get().is_some() => {
                    return Err(error(ErrorCode::Unauthorized, "mcp-query-member-bound"));
                }
                None => {}
            }
        }
        let verified_build =
            super::release::verify_prepared_input(&tx, input, prepared_build.as_ref())?;
        if let Some(prepared) = team_work {
            if tool.is_some()
                || service.is_some()
                || service_tool.is_some()
                || agent.is_some()
                || mcp.is_some()
                || policy != RecoveryPolicy::ExternalUnknown
                || input.bytes() != prepared.input().bytes()
            {
                return Err(error(ErrorCode::Unauthorized, "team-work-admission"));
            }
            super::application::coordination::check_prepared(&tx, prepared)?;
        }
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
                consent.application_lease(&prepared.tool)?,
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
        if let Some((_, _, Some(sealed))) = mcp {
            super::application::member_mcp::record_input(&tx, sealed)?;
        }
        if let Some(prepared) = team_work {
            super::application::coordination::record_work(&tx, prepared)?;
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
        if let (Some((prepared, consent, grant, generation)), Some((delegation, true))) =
            (tool, delegated)
        {
            let application_lease = consent
                .application_lease(&prepared.tool)
                .map_err(|_| error(ErrorCode::OutcomeUnknown, "work-plan-tool-activation"))?
                .cloned();
            authority
                .activate_with_delegation(
                    generation,
                    grant,
                    input,
                    consent.expires_at_ms,
                    consent.deadline,
                    application_lease.is_some(),
                    Some(delegation),
                    application_lease,
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
    /// Explicit result confirmation may reconcile an uncertain commit. Internal
    /// write admission continues to use the raw idempotence lookup above.
    pub fn read_execution_continuation(
        &self,
        action_id: ExecutionId,
    ) -> Result<Option<ContinuationReceipt>, ExecutionError> {
        let found = super::review::read_snapshot(self.execution_connection()?, |connection| {
            read_continuation(connection, action_id)
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
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
        if is_conversation_planning(&original) || is_conversation_planning(input) {
            return Err(error(ErrorCode::Unauthorized, "conversation-planning-recovery"));
        }
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
    /// Read the original immutable input, distinguishing a proven missing
    /// attempt from storage or ledger validation failures.
    pub fn execution_input_if_present(
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
    /// Confirm an exact ordinary plugin submission without preparing or loading
    /// a runtime. Only a successfully validated read clears the recovery guard.
    pub fn plugin_start_action_read(
        &self,
        project: ExecutionId,
        task: ExecutionId,
        attempt: ExecutionId,
        operation: &str,
        digest: &str,
    ) -> Result<Option<PluginStartActionRead>, ExecutionError> {
        self.plugin_start_input_read(project, Some(task), attempt, operation, digest)
    }
    /// A captured full input digest also binds its original task when a producer
    /// preview does not expose that task before enqueueing.
    pub fn plugin_input_start_action_read(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        operation: &str,
        digest: &str,
    ) -> Result<Option<PluginStartActionRead>, ExecutionError> {
        self.plugin_start_input_read(project, None, attempt, operation, digest)
    }
    fn plugin_start_input_read(
        &self,
        project: ExecutionId,
        expected_task: Option<ExecutionId>,
        attempt: ExecutionId,
        operation: &str,
        digest: &str,
    ) -> Result<Option<PluginStartActionRead>, ExecutionError> {
        let found = self.plugin_start_input_observation(project, expected_task, attempt, operation, digest)?;
        if self.is_reconciling() { self.reconcile_execution()?; }
        Ok(found)
    }

    fn plugin_start_input_observation(
        &self,
        project: ExecutionId,
        expected_task: Option<ExecutionId>,
        attempt: ExecutionId,
        operation: &str,
        digest: &str,
    ) -> Result<Option<PluginStartActionRead>, ExecutionError> {
        let found = super::review::read_snapshot(self.execution_connection()?, |c| {
            if super::read_metadata_from(c)
                .map_err(|_| error(ErrorCode::CorruptLedger, "plugin-start-project"))?
                .project_id()
                .to_string()
                != project.to_string()
            {
                return Err(error(ErrorCode::ResultMismatch, "plugin-start-project"));
            }
            if tsumugi_plugin_sdk::validate_package_digest(digest).is_err() {
                return Err(error(ErrorCode::InvalidInput, "plugin-start-digest"));
            }
            let exists: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                    [attempt.to_string()],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if !exists {
                return Ok(None);
            }
            let input = load_input(c, attempt)?;
            let envelope = input.envelope();
            if envelope.project_id != project
                || expected_task.is_some_and(|task| envelope.task_id != task)
                || envelope.operation != operation
                || input.digest() != digest
                || envelope.plugin.is_none()
                || envelope.automation.is_some()
                || envelope.previous_attempt_id.is_some()
            {
                return Err(error(ErrorCode::ResultMismatch, "plugin-start-request"));
            }
            Ok(Some(PluginStartActionRead {
                project_id: project,
                task_id: envelope.task_id,
                attempt_id: attempt,
                operation: envelope.operation.clone(),
                input_digest: input.digest().into(),
            }))
        })?;
        Ok(found)
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
        self.attempt_detail_in(attempt_id, active, offset, limit, None)
    }

    /// The current checker review already owns the complete fixed input.
    /// Verify the stored chunks and associations before reusing it to read
    /// progress, without reconstructing another large immutable input.
    pub fn artifact_checker_attempt_detail(
        &self,
        input: &FixedInput,
        active: bool,
        offset: u32,
        limit: u32,
    ) -> Result<AttemptDetail, ExecutionError> {
        if input.envelope().operation != ARTIFACT_CHECK_OPERATION {
            return Err(error(ErrorCode::InvalidInput, "artifact-check-attempt"));
        }
        self.attempt_detail_in(input.envelope().attempt_id, active, offset, limit, Some(input))
    }

    fn attempt_detail_in(
        &self,
        attempt_id: ExecutionId,
        active: bool,
        offset: u32,
        limit: u32,
        captured: Option<&FixedInput>,
    ) -> Result<AttemptDetail, ExecutionError> {
        let connection = self.execution_connection()?;
        super::review::read_snapshot(connection, |connection| {
            if limit == 0 || limit > 100 {
                return Err(error(ErrorCode::LimitExceeded, "execution-page-limit"));
            }
            let key = AttemptDetailKey { attempt_id, active, offset, limit };
            let stamp = read_snapshot_stamp(connection)?;
            if let Some(stamp) = &stamp {
                let mut cache = self.attempt_details.borrow_mut();
                cache.use_stamp(stamp);
                if let Some(page) = cache.pages.iter().find(|(saved, _)| *saved == key) {
                    return Ok(page.1.clone());
                }
            }
            let input = match captured {
                Some(input) => {
                    check_stored_input(connection, input)?;
                    super::resources::verify_input_fact_decisions(connection, input)?;
                    input.clone()
                }
                None => load_input(connection, attempt_id)?,
            };
            let view = read_attempt_in(connection, &input, active)?;
            let detail = self.project_attempt_detail(connection, &input, view, offset, limit)?;
            if stamp.is_some() {
                self.attempt_details.borrow_mut().insert(key, detail.clone());
            }
            Ok(detail)
        })
    }

    fn project_attempt_detail(
        &self,
        connection: &Connection,
        input: &FixedInput,
        mut view: AttemptView,
        offset: u32,
        limit: u32,
    ) -> Result<AttemptDetail, ExecutionError> {
        let attempt_id = view.attempt_id;
        let total = view.items.len();
        if offset as usize > total {
            return Err(error(ErrorCode::InvalidInput, "offset"));
        }
        let mut recovery = self.execution_recovery_in(connection, input, &view)?;
        let items = std::mem::take(&mut view.items)
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
        // A unit can span pages. Return it on each page containing a member so its
        // full scope remains explicit before an action is requested.
        recovery.units.retain(|unit| {
            items
                .iter()
                .any(|item| unit.item_ids.contains(&item.status.item_id))
        });
        if view.operation == crate::ai::OPERATION
            || view.operation == crate::ai::team::OPERATION
        {
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
        let connection = self.execution_connection()?;
        let derived: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_attempts a JOIN execution_tasks t USING(task_id)
             WHERE a.attempt_id=?1 AND t.operation IN (?2,?3))",
            params![attempt.to_string(), SOURCE_CHECK_OPERATION, ARTIFACT_CHECK_OPERATION],
            |row| row.get(0),
        ).map_err(sql_error)?;
        let prepared = if derived {
            super::review::read_snapshot(connection, |connection| {
                let input = load_input(connection, attempt)?;
                // Preserve the ordinary cancellation path for expired grants.
                if super::plugin_execution::check_input_in(connection, &input, &authority).is_err() {
                    return Ok(None);
                }
                let stamp = snapshot_stamp(connection)?;
                Ok(Some((derive_check_input(connection, &input, true)?, stamp)))
            })?
        } else {
            None
        };
        let tx = self.execution_write()?;
        let ready = prepared.is_some();
        let input = match prepared {
            Some((input, stamp)) => {
                // The bytes were reconstructed against one read snapshot
                // outside the write transaction. No durable claim may change
                // between that snapshot and recording dispatch.
                if snapshot_stamp(&tx)? != stamp {
                    return Err(error(ErrorCode::DependencyConflict, "semantic-check-dispatch-snapshot"));
                }
                input
            }
            None => load_input_cached(&tx, attempt)?,
        };
        let planning_permit = match self.conversation_planning_permit(&input) {
            Ok(permit) => permit,
            Err(failure) => {
                tx.execute("UPDATE execution_items SET execution='cancelled-before-dispatch',diagnostic='planning-authority' WHERE attempt_id=?1 AND execution='queued'", [attempt.to_string()]).map_err(sql_error)?;
                commit(tx)?;
                return Err(failure);
            }
        };
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
        if is_derived_check(&input.envelope().operation) && !ready {
            return Err(error(ErrorCode::DependencyConflict, "semantic-check-dispatch-snapshot"));
        }
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
        let mut original_deadline = crate::execution::DispatchDeadline {
            instant: started
                .checked_add(timeout)
                .ok_or_else(|| error(ErrorCode::InvalidInput, "dispatch-deadline"))?,
            expires_at_ms: started_at_ms
                .checked_add(input.envelope().limits.timeout_ms.into())
                .ok_or_else(|| error(ErrorCode::InvalidInput, "dispatch-deadline"))?,
        };
        if let Some(permit) = &planning_permit {
            original_deadline.instant = original_deadline.instant.min(permit.deadline());
            original_deadline.expires_at_ms = original_deadline.expires_at_ms.min(permit.expires_at_ms);
        }
        Ok(DispatchRequest {
            provider: None,
            plugin_permit,
            service_origin: authority.service_origin(attempt)?,
            planning_permit,
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
        if envelope.outcome == ExecutionState::Succeeded {
            self.check_conversation_planning_input(&input)?;
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
        if input.envelope().operation == crate::ai::team::OPERATION {
            if let Err(failure) = super::application::coordination::validate_result(&tx, &input, &output) {
                tx.execute("UPDATE execution_items SET validation='invalid' WHERE attempt_id=?1 AND item_id=?2 AND current_result_id=?3",params![attempt.to_string(),output.envelope().item_id.to_string(),result.to_string()]).map_err(sql_error)?;
                commit(tx)?;
                return Err(failure);
            }
        }
        #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
        if input.envelope().operation == crate::content::OPERATION && input.envelope().plugin.is_none() {
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
        if input.envelope().operation == crate::ai::conversation_planning::OPERATION {
            if let Err(failure) = crate::ai::conversation_planning::validate_output(&input, &output) {
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
        SourceValidationCapture::capture(self.capture_result_validation(attempt, result)?, None, true)
    }
    pub fn commit_source_validation(
        &mut self,
        prepared: PreparedSourceValidation,
    ) -> Result<(), ExecutionError> {
        if let Some(valid) = self.source_check_finish_request_observation(
            prepared.capture.source.input.envelope().project_id,
            prepared.capture.check_input.envelope().attempt_id,
            prepared.check_result.envelope().result_id,
        )? {
            if valid != prepared.proof.valid {
                return Err(error(ErrorCode::ResultMismatch, "source-check-publication"));
            }
            return Ok(());
        }
        self.commit_semantic_validation(
            prepared.capture.source.clone(),
            prepared.capture.check_input.clone(),
            prepared.check_result.clone(),
            prepared.proof.clone(),
        )?;
        if prepared.proof.valid {
            remember_source_validation(prepared);
        }
        Ok(())
    }
    pub fn capture_artifact_validation(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<ArtifactValidationCapture, ExecutionError> {
        ArtifactValidationCapture::capture(self.capture_result_validation(attempt, result)?, None)
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
        let (producer_input, producer_result, check_input, check_result) =
            Self::semantic_publication_frames_in(&tx, &captured, &captured_check, &expected_check, &proof)?;
        if producer_input.envelope().operation == crate::content::OPERATION {
            if let Some(valid) = super::content::validation_history::observe_in(&tx,
                producer_input.envelope().project_id, check_input.envelope().attempt_id,
                check_result.envelope().result_id)? {
                if valid != proof.valid {
                    return Err(error(ErrorCode::ResultMismatch, "source-check-publication"));
                }
                return Ok(());
            }
        }
        for input in [&producer_input, &check_input] {
            super::plugin_execution::check_input_in(&tx, input, &authority)?;
        }
        Self::publish_semantic_frames_in(&tx, &producer_input, &producer_result, &check_input, &check_result, &proof)?;
        // This commit already qualified the original frames, grants and link.
        // A single-item build can immediately supply the usual detail page.
        // Publish that small view only after the write is durably committed.
        let detail = if producer_input.envelope().operation == crate::content::BUILD_OPERATION
            && producer_input.envelope().items.len() == 1
        {
            let view = read_attempt_with_results(
                &tx, &producer_input, false,
                |id| {
                    if id == producer_result.envelope().result_id {
                        Ok(producer_result.clone())
                    } else {
                        Err(error(ErrorCode::CorruptLedger, "semantic-validation-current-result"))
                    }
                },
                |_| Ok(()),
            )?;
            Some((
                snapshot_stamp(&tx)?,
                self.project_attempt_detail(&tx, &producer_input, view, 0, 100)?,
            ))
        } else {
            None
        };
        commit(tx)?;
        if let Some((stamp, detail)) = detail {
            let key = AttemptDetailKey { attempt_id: detail.attempt_id, active: false, offset: 0, limit: 100 };
            let mut cache = self.attempt_details.borrow_mut();
            cache.use_stamp(&stamp);
            cache.insert(key, detail);
        }
        Ok(())
    }

    pub(super) fn semantic_publication_frames_in(
        c: &Connection,
        captured: &ResultValidationCapture,
        captured_check: &FixedInput,
        expected_check: &FixedResult,
        proof: &ValidationProof,
    ) -> Result<(FixedInput, FixedResult, FixedInput, FixedResult), ExecutionError> {
        if !proof.matches(&captured.input, &captured.result) {
            return Err(error(
                ErrorCode::ResultMismatch,
                "semantic-validation-preparation",
            ));
        }
        // Prepared evidence has already received both typed results. Compare
        // the original persisted bytes and associations in the write snapshot
        // before reusing them; do not decode and rebuild both requests again.
        for (input, result) in [(&captured.input, &captured.result), (captured_check, expected_check)] {
            result.validate_for_input(input)?;
            check_stored_input(c, input)?;
            check_stored_result(c, result)?;
            super::resources::verify_input_fact_decisions(c, input)?;
            super::plugin_execution::validate_result_in(c, input, result)?;
        }
        Ok((captured.input.clone(), captured.result.clone(), captured_check.clone(), expected_check.clone()))
    }

    pub(super) fn publish_semantic_frames_in(
        tx: &ExecutionTransaction<'_>,
        producer_input: &FixedInput,
        producer_result: &FixedResult,
        check_input: &FixedInput,
        check_result: &FixedResult,
        proof: &ValidationProof,
    ) -> Result<(), ExecutionError> {
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
        if producer_input.envelope().operation == crate::content::OPERATION {
            super::content::validation_history::record_in(&tx, producer_result.envelope().result_id,
                check_input.envelope().attempt_id, check_result.envelope().result_id, proof.valid)?;
        }
        tx.execute("INSERT INTO plugin_validation_links VALUES (?1,?2,?3) ON CONFLICT(producer_result_id) DO UPDATE SET checker_result_id=excluded.checker_result_id,valid=excluded.valid", params![producer_result.envelope().result_id.to_string(), check_result.envelope().result_id.to_string(), proof.valid]).map_err(sql_error)?;
        Ok(())
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
    /// Read only the exact cancellation request, never the latest task revision.
    pub fn cancellation_action_read(
        &self,
        project: ExecutionId,
        task: ExecutionId,
        request: ExecutionId,
    ) -> Result<Option<CancellationReceipt>, ExecutionError> {
        let found = super::review::read_snapshot(self.execution_connection()?, |connection| {
            let row: Option<(String, i64, Option<String>)> = connection
                .query_row(
                    "SELECT c.task_id,c.revision,t.project_id FROM execution_cancellations c
                 LEFT JOIN execution_tasks t ON t.task_id=c.task_id WHERE c.request_id=?1",
                    [request.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(sql_error)?;
            let Some((saved_task, revision, saved_project)) = row else {
                return Ok(None);
            };
            let saved_project = saved_project
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "cancellation-task"))?;
            let saved_task = parse_id(saved_task)?;
            let saved_project = parse_id(saved_project)?;
            if revision <= 0 {
                return Err(error(ErrorCode::CorruptLedger, "cancellation-revision"));
            }
            if saved_task != task || saved_project != project {
                return Err(error(ErrorCode::ResultMismatch, "cancellation-request"));
            }
            let revision = Revision::new(revision as u64)
                .map_err(|_| error(ErrorCode::CorruptLedger, "cancellation-revision"))?;
            Ok(Some(CancellationReceipt {
                project_id: saved_project,
                task_id: saved_task,
                request_id: request,
                revision,
            }))
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
    }
    pub fn cancel_execution(
        &mut self,
        task: ExecutionId,
        request: ExecutionId,
    ) -> Result<Revision, ExecutionError> {
        let prior_owner: Option<String> = self.execution_connection()?.query_row(
            "SELECT task_id FROM execution_cancellations WHERE request_id=?1",
            [request.to_string()], |row| row.get(0),
        ).optional().map_err(sql_error)?;
        if prior_owner.is_some_and(|owner| owner != task.to_string()) {
            return Err(error(ErrorCode::ResultMismatch, "cancel-identity"));
        }
        // Revoke before the durable write: an unknown cancellation commit cannot
        // leave a worker authorized to issue another physical request.
        self.revoke_conversation_planning(Some(task));
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

    /// Confirm the original generic preparation without refreshing its authority.
    pub fn execution_adoption_action_read(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        action: ExecutionId,
        unit: ExecutionId,
        result_ids: &[ExecutionId],
    ) -> Result<Option<AdoptionActionRead>, ExecutionError> {
        let mut results = result_ids.to_vec();
        results.sort();
        if results.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(error(ErrorCode::InvalidInput, "adoption-action-results"));
        }
        let found = super::review::read_snapshot(self.execution_connection()?, |connection| {
            let Some((read, _)) = read_adoption_action_in(connection, action)? else {
                return Ok(None);
            };
            let original = &read.action;
            if original.project_id != project
                || original.attempt_id != attempt
                || original.unit_id != unit
                || original.result_ids != results
                || !original.parameters.is_null()
            {
                return Err(error(ErrorCode::ResultMismatch, "adoption-action-request"));
            }
            Ok(Some(read))
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
    }

    /// Confirm a historical source action against its original request and frozen input.
    pub fn source_adoption_action_read(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        action: ExecutionId,
        unit: ExecutionId,
        result: ExecutionId,
        confirmation: &crate::content::SourceConfirmation,
    ) -> Result<Option<AdoptionActionRead>, ExecutionError> {
        let found = self.source_adoption_request_observation(project, attempt, action, unit, result, confirmation)?;
        if self.is_reconciling() { self.reconcile_execution()?; }
        Ok(found)
    }
    pub fn source_adoption_request_observation(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        action: ExecutionId,
        unit: ExecutionId,
        result: ExecutionId,
        confirmation: &crate::content::SourceConfirmation,
    ) -> Result<Option<AdoptionActionRead>, ExecutionError> {
        let parameters = serde_json::to_value(confirmation)
            .map_err(|_| error(ErrorCode::InvalidInput, "source-action-confirmation"))?;
        let found = super::review::read_snapshot(self.execution_connection()?, |connection| {
            if super::read_metadata_from(connection).map_err(|_| error(ErrorCode::CorruptLedger, "project"))?
                .project_id().to_string() != project.to_string() {
                return Err(error(ErrorCode::Unauthorized, "source-action-project"));
            }
            let Some((read, _)) = read_adoption_action_in(connection, action)? else {
                return Ok(None);
            };
            let original = &read.action;
            if original.project_id != project
                || original.attempt_id != attempt
                || original.unit_id != unit
                || original.operation != crate::content::OPERATION
                || original.result_ids != [result]
                || original.parameters != parameters
            {
                return Err(error(ErrorCode::ResultMismatch, "source-action-request"));
            }
            Ok(Some(read))
        })?;
        Ok(found)
    }

    /// Only a recorded matching receipt settles success. Otherwise check the
    /// original adoption's monotonic content-scope admission in the same read.
    pub fn source_adoption_request_settlement_observation(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        action: ExecutionId,
        unit: ExecutionId,
        result: ExecutionId,
        confirmation: &crate::content::SourceConfirmation,
    ) -> Result<Option<AdoptionActionRead>, ExecutionError> {
        super::review::read_snapshot(self.execution_connection()?, |c| {
            let found = self.source_adoption_request_observation(project, attempt, action, unit, result, confirmation)?;
            if found.as_ref().is_some_and(|value| value.receipt.is_some()) { return Ok(found); }
            let input = load_input(c, attempt)?;
            if input.envelope().project_id != project || input.envelope().operation != crate::content::OPERATION
                || input.envelope().units.len() != 1 || input.envelope().units[0].unit_id != unit {
                return Err(error(ErrorCode::ResultMismatch, "source-action-request"));
            }
            let fixed = load_result(c, &input, result)?;
            let output = crate::content::validate_output(&input, &fixed)?;
            if fixed.digest() != confirmation.result_digest || output.identity_policy != confirmation.identity_policy
                || output.source_language != confirmation.source_language {
                return Err(error(ErrorCode::ResultMismatch, "source-action-confirmation"));
            }
            super::content::check_adoption_scope(c, project, confirmation)?;
            Ok(found)
        })
    }

    /// The import item-to-unit association comes only from its original frozen input.
    pub fn translation_adoption_action_read(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        action: ExecutionId,
        unit: ExecutionId,
        item: ExecutionId,
        result: ExecutionId,
        confirmation: &super::translation::TranslationAdoptionConfirmation,
    ) -> Result<Option<AdoptionActionRead>, ExecutionError> {
        let parameters = serde_json::to_value(confirmation)
            .map_err(|_| error(ErrorCode::InvalidInput, "translation-action-confirmation"))?;
        let found = super::review::read_snapshot(self.execution_connection()?, |connection| {
            let Some((read, input)) = read_adoption_action_in(connection, action)? else {
                return Ok(None);
            };
            let original = &read.action;
            if original.project_id != project
                || original.attempt_id != attempt
                || original.unit_id != unit
                || original.operation != crate::content::TRANSLATION_OPERATION
                || original.result_ids != [result]
                || original.parameters != parameters
                || !input
                    .envelope()
                    .units
                    .iter()
                    .any(|value| value.unit_id == unit && value.item_ids == [item])
            {
                return Err(error(
                    ErrorCode::ResultMismatch,
                    "translation-action-request",
                ));
            }
            Ok(Some(read))
        })?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
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
        check_planning_candidate_action(&input, &parameters)?;
        if is_conversation_planning(&input) && result_ids.as_slice() != [action_id] {
            return Err(error(ErrorCode::ResultMismatch, "selected-revision-action"));
        }
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
        check_planning_candidate_result(&input, &results)?;
        if is_conversation_planning(&input) && action.cancellation_revision.get() != 0 {
            return Err(error(ErrorCode::Cancelled, "selected-revision-action"));
        }
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
        let release_reads = self.release_reads.borrow().clone();
        let mut tx = self.execution_write()?;
        let action = &prepared.capture.action;
        let rechecked;
        let current = match &prepared.capture.release_proof {
            Some(proof) if proof.current(&tx)? => &prepared.capture,
            _ => {
                rechecked = capture_adoption_in(&tx, action, &authority)?;
                &rechecked
            }
        };
        if let Some(receipt) = current.receipt.clone() {
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
        let adoption = AdoptionTransaction::new(&tx, &store_epoch);
        let changes = mutation(&adoption)?;
        let release = adoption.into_release();
        let receipt = AdoptionReceipt {
            project_id: action.project_id,
            attempt_id: action.attempt_id,
            action_id: action.action_id,
            unit_id: action.unit_id,
            request_digest: current.digest.clone(),
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
        let release = release.and_then(|release| release_reads.after_adoption(&tx, release));
        #[cfg(test)]
        crash_hook("before-adoption-commit");
        commit(tx)?;
        if let Some(release) = release {
            *self.release_reads.borrow_mut() = release;
        }
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

fn require_live_checker(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
    authority: &crate::execution::plugin_authority::PluginAuthority,
) -> Result<PluginPermit, ExecutionError> {
    require_current_result(connection, input, result)?;
    let permit = super::plugin_execution::check_input_in(connection, input, authority)?
        .ok_or_else(|| error(ErrorCode::Unauthorized, "semantic-check-adoption-grant"))?;
    if Some(permit.grant_id())
        != result.envelope().plugin.as_ref().map(|e| e.authorization_id)
    {
        return Err(error(ErrorCode::Unauthorized, "semantic-check-adoption-grant"));
    }
    Ok(permit)
}

#[derive(Debug)]
pub(crate) struct ReleaseAdoptionProof {
    snapshot: ReadSnapshotStamp,
    permits: Vec<PluginPermit>,
}
impl ReleaseAdoptionProof {
    fn current(&self, connection: &Connection) -> Result<bool, ExecutionError> {
        pin_snapshot(connection)?;
        Ok(self.snapshot == snapshot_stamp(connection)?
            && self.permits.iter().all(PluginPermit::is_authorized))
    }
}

fn capture_adoption_in(
    connection: &Connection,
    action: &AdoptionAction,
    authority: &crate::execution::plugin_authority::PluginAuthority,
) -> Result<AdoptionCapture, ExecutionError> {
    let mut input = load_input_cached(connection, action.attempt_id)?;
    check_planning_candidate_action(&input, &action.parameters)?;
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
                release_proof: None,
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
    let plugin_build = input.envelope().plugin.is_some()
        && input.envelope().operation == crate::content::BUILD_OPERATION;
    let release_snapshot = if plugin_build
        && input.envelope().automation.is_none()
        && input.envelope().reused_results.is_empty()
    {
        read_snapshot_stamp(connection)?
    } else {
        None
    };
    if plugin_build {
        input.cache_open_build_plan()?;
        input.open_build_plan().expect("cached build plan").validate_source_reference(connection)?;
    }
    // Explicit Source adoption publishes completed evidence. It does not start
    // a worker, so process permit expiry or a new store epoch is immaterial.
    let publish_source = input.envelope().operation == crate::content::OPERATION
        && input.envelope().plugin.is_some()
        && input.envelope().automation.is_none();
    let permit = if publish_source {
        None
    } else {
        super::plugin_execution::check_input_in(connection, &input, authority)?
    };
    let results = action
        .result_ids
        .iter()
        .map(|id| load_result(connection, &input, *id))
        .collect::<Result<Vec<_>, _>>()?;
    action.validate(&input, &results)?;
    check_planning_candidate_result(&input, &results)?;
    for result in &results {
        let original = result_input(connection, &input, result.envelope().result_id)?;
        if publish_source {
            // Keep currentness, cancellation, revocation and grant provenance
            // independent of the runtime deadline and process generation.
            require_current_result(connection, &original, result)?;
            super::plugin_execution::check_source_publication_provenance_in(
                connection, &original, result,
            )?;
            continue;
        }
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
    let mut checked_build_results = BTreeSet::new();
    let mut live_checkers = Vec::new();
    let state = if crate::content::is_translation_projection(&input) {
        None
    } else {
        Some(read_attempt_with_results(
            connection,
            &input,
            true,
            |id| match results.iter().find(|result| result.envelope().result_id == id) {
                Some(result) => Ok(result.clone()),
                None => load_result(connection, &input, id),
            },
            |result| {
                if publish_source {
                    let prepared = validate_source_link(connection, &input, result, true)?;
                    let checker_input = &prepared.capture.check_input;
                    let checker_result = &prepared.check_result;
                    require_current_result(connection, checker_input, checker_result)?;
                    require_unsuperseded_result(connection, checker_input, checker_result)?;
                    super::plugin_execution::check_source_publication_provenance_in(
                        connection, checker_input, checker_result,
                    )
                } else if plugin_build && action.result_ids.contains(&result.envelope().result_id) {
                    validate_plugin_link_with_open_evidence(
                        connection, &input, result, true, None, Some((authority, &mut live_checkers)),
                    )?;
                    checked_build_results.insert(result.envelope().result_id);
                    Ok(())
                } else {
                    validate_plugin_link(connection, &input, result, true).map(|_| ())
                }
            },
        )?)
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
        if requires_semantic_check(&input)
            && !publish_source
            && !checked_build_results.contains(&result.envelope().result_id)
        {
            // Other plugin operations retain their original live-grant gate.
            let (check_input, check_result, _) = load_check_link(connection, result)?;
            require_live_checker(connection, &check_input, &check_result, authority)?;
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
    let release_proof = match (release_snapshot, permit) {
        (Some(snapshot), Some(build_permit)) if checked_build_results.len() == results.len() => {
            live_checkers.push(build_permit);
            Some(ReleaseAdoptionProof { snapshot, permits: live_checkers })
        }
        _ => None,
    };
    Ok(AdoptionCapture {
        action: action.clone(),
        input,
        results,
        digest,
        receipt: None,
        release_proof,
    })
}

/// Restore one historical action and optional receipt inside the caller's read snapshot.
/// Stored bytes, frozen input and row associations are evidence, never new eligibility.
pub(in crate::persistence) fn read_adoption_action_in(
    connection: &Connection,
    action: ExecutionId,
) -> Result<Option<(AdoptionActionRead, FixedInput)>, ExecutionError> {
    let row: Option<(String, String, Vec<u8>, String)> = connection
        .query_row(
            "SELECT attempt_id,unit_id,CASE WHEN length(request)<=1048576 THEN request END,digest FROM execution_actions WHERE action_id=?1",
            [action.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(sql_error)?;
    let Some((saved_attempt, saved_unit, bytes, saved_digest)) = row else {
        if read_receipt(connection, action)?.is_some() {
            return Err(error(ErrorCode::CorruptLedger, "adoption-action-orphan"));
        }
        if connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM execution_continuations WHERE action_id=?1)",
                [action.to_string()],
                |row| row.get::<_, bool>(0),
            )
            .map_err(sql_error)?
        {
            return Err(error(ErrorCode::ResultMismatch, "adoption-action-kind"));
        }
        return Ok(None);
    };
    let original: AdoptionAction = codec::decode(&bytes, MAX_INPUT_BYTES)
        .map_err(|_| error(ErrorCode::CorruptLedger, "adoption-action-bytes"))?;
    let input = load_input_cached(connection, original.attempt_id)?;
    let digest = original
        .request_digest(&input)
        .map_err(|_| error(ErrorCode::CorruptLedger, "adoption-action-digest"))?;
    if original.action_id != action
        || saved_attempt != original.attempt_id.to_string()
        || saved_unit != original.unit_id.to_string()
        || original.project_id != input.envelope().project_id
        || original.operation != input.envelope().operation
        || !input
            .envelope()
            .units
            .iter()
            .any(|unit| unit.unit_id == original.unit_id)
        || original
            .result_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || saved_digest != digest
    {
        return Err(error(
            ErrorCode::CorruptLedger,
            "adoption-action-association",
        ));
    }
    let receipt = read_receipt(connection, action)?;
    if receipt.is_some() {
        let (receipt_attempt, receipt_unit): (String, String) = connection
            .query_row(
                "SELECT attempt_id,unit_id FROM adoption_receipts WHERE action_id=?1",
                [action.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(sql_error)?;
        if receipt_attempt != saved_attempt || receipt_unit != saved_unit {
            return Err(error(
                ErrorCode::CorruptLedger,
                "adoption-receipt-association",
            ));
        }
    }
    if receipt.as_ref().is_some_and(|value| {
        value.project_id != original.project_id
            || value.attempt_id != original.attempt_id
            || value.action_id != action
            || value.unit_id != original.unit_id
            || value.request_digest != digest
    }) {
        return Err(error(ErrorCode::CorruptLedger, "adoption-action-receipt"));
    }
    Ok(Some((
        AdoptionActionRead {
            action: original,
            receipt,
        },
        input,
    )))
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
