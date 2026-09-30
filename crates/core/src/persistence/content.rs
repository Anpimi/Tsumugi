use super::{
    ProjectStore,
    ledger::{load_input, load_result, read_receipt, sql_error},
};
use crate::{
    content::*,
    execution::{codec, *},
};
use rusqlite::{Connection, params};
mod maintenance;

const TABLES:&[(&str,&str)]=&[
    ("source_sets","CREATE TABLE source_sets (
        set_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
        payload BLOB NOT NULL CHECK(length(payload) BETWEEN 1 AND 1048576), digest TEXT NOT NULL CHECK(length(digest)=64),
        UNIQUE(set_id,project_id))"),
    ("source_files","CREATE TABLE source_files (
        artifact_id TEXT PRIMARY KEY NOT NULL, set_id TEXT NOT NULL REFERENCES source_sets(set_id),
        logical_path TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('source','companion')),
        bytes BLOB NOT NULL CHECK(length(bytes)<=131072), digest TEXT NOT NULL CHECK(length(digest)=64),
        UNIQUE(set_id,logical_path), UNIQUE(set_id,artifact_id))"),
    ("source_snapshots","CREATE TABLE source_snapshots (
        snapshot_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, set_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id), result_id TEXT NOT NULL REFERENCES execution_results(result_id),
        source_language TEXT NOT NULL, identity_policy TEXT NOT NULL,
        FOREIGN KEY(set_id,project_id) REFERENCES source_sets(set_id,project_id))"),
    ("source_units","CREATE TABLE source_units (
        unit_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL)"),
    ("source_revisions","CREATE TABLE source_revisions (
        revision_id TEXT PRIMARY KEY NOT NULL, unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        revision INTEGER NOT NULL CHECK(revision>0), text TEXT NOT NULL,
        UNIQUE(unit_id,revision), UNIQUE(unit_id,revision_id))"),
    ("source_occurrences","CREATE TABLE source_occurrences (
        occurrence_id TEXT PRIMARY KEY NOT NULL, snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
        ordinal INTEGER NOT NULL CHECK(ordinal>=0), artifact_id TEXT NOT NULL REFERENCES source_files(artifact_id),
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id), revision_id TEXT NOT NULL,
        namespace TEXT NOT NULL, native_key TEXT NOT NULL, comparison_key TEXT NOT NULL,
        key_start INTEGER NOT NULL CHECK(key_start>=0), key_end INTEGER NOT NULL CHECK(key_end>key_start),
        value_start INTEGER NOT NULL CHECK(value_start>=key_end), value_end INTEGER NOT NULL CHECK(value_end>value_start),
        UNIQUE(snapshot_id,ordinal), UNIQUE(snapshot_id,namespace,comparison_key),
        FOREIGN KEY(unit_id,revision_id) REFERENCES source_revisions(unit_id,revision_id))"),
    ("source_identity","CREATE TABLE source_identity (
        occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES source_occurrences(occurrence_id),
        policy TEXT NOT NULL, basis TEXT NOT NULL)"),
    ("content_scope","CREATE TABLE content_scope (
        row_id INTEGER PRIMARY KEY CHECK(row_id=1), revision INTEGER NOT NULL CHECK(revision>0),
        current_snapshot TEXT REFERENCES source_snapshots(snapshot_id))"),
];
const LINEAGE_TABLE: &str = "CREATE TABLE source_lineage (
        occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES source_occurrences(occurrence_id),
        predecessor_id TEXT REFERENCES source_occurrences(occurrence_id),
        relation TEXT NOT NULL CHECK(relation IN ('initial','unchanged','changed','new','unresolved')),
        CHECK((relation IN ('initial','new') AND predecessor_id IS NULL)
          OR (relation IN ('unchanged','changed','unresolved') AND predecessor_id IS NOT NULL)))";
const LINEAGE_EVIDENCE_TABLE: &str = "CREATE TABLE source_lineage_evidence (
        new_occurrence_id TEXT NOT NULL REFERENCES source_occurrences(occurrence_id),
        old_occurrence_id TEXT NOT NULL REFERENCES source_occurrences(occurrence_id),
        relationship TEXT NOT NULL CHECK(relationship IN ('same-key','same-text','manual')),
        decision TEXT NOT NULL CHECK(decision IN ('candidate','continue','reject')),
        actor TEXT, reason TEXT,
        action_id TEXT NOT NULL REFERENCES execution_actions(action_id),
        policy TEXT NOT NULL,
        PRIMARY KEY(new_occurrence_id,old_occurrence_id),
        CHECK((decision='candidate' AND actor IS NULL AND reason IS NULL)
          OR (decision!='candidate' AND actor IS NOT NULL AND reason IS NOT NULL)))";
pub(super) fn maintenance_table_names() -> Vec<String> {
    vec!["source_lineage".into(), "source_lineage_evidence".into()]
}
pub(super) fn table_names() -> Vec<String> {
    TABLES.iter().map(|(name, _)| name.to_string()).collect()
}
pub(super) fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        connection.execute_batch(sql)?;
    }
    connection.execute("INSERT INTO content_scope VALUES (1,1,NULL)", [])?;
    connection.execute_batch(LINEAGE_TABLE)?;
    connection.execute_batch(LINEAGE_EVIDENCE_TABLE)?;
    Ok(())
}
pub(super) fn migrate_v8(connection: &mut Connection) -> rusqlite::Result<()> {
    let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch(LINEAGE_TABLE)?;
    tx.execute_batch(LINEAGE_EVIDENCE_TABLE)?;
    tx.execute(
        "INSERT INTO source_lineage(occurrence_id,relation)
                SELECT occurrence_id,'initial' FROM source_occurrences",
        [],
    )?;
    if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    tx.pragma_update(None, "user_version", 9)?;
    #[cfg(test)]
    super::migration_crash_hook("before-maintenance-migration-commit");
    tx.commit()?;
    #[cfg(test)]
    super::migration_crash_hook("after-maintenance-migration-commit");
    Ok(())
}
fn corrupt() -> ExecutionError {
    failure(ErrorCode::CorruptLedger, "source-corrupt")
}
fn id(raw: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&raw).map_err(|_| corrupt())
}
fn scope(connection: &Connection) -> Result<ContentScope, ExecutionError> {
    let (revision, current): (i64, Option<String>) = connection
        .query_row(
            "SELECT revision,current_snapshot FROM content_scope WHERE row_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql_error)?;
    let snapshots: i64 = connection
        .query_row("SELECT COUNT(*) FROM source_snapshots", [], |r| r.get(0))
        .map_err(sql_error)?;
    let referenced: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM source_snapshots WHERE snapshot_id=?1",
            [&current],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    if snapshots != revision - 1
        || referenced != i64::from(current.is_some())
        || (snapshots == 0) != current.is_none()
    {
        return Err(corrupt());
    }
    Ok(ContentScope {
        revision: Revision::new(revision as u64)?,
        current_snapshot: current.map(id).transpose()?,
    })
}
pub(super) fn read_bundle(
    connection: &Connection,
    set: ExecutionId,
) -> Result<SourceBundle, ExecutionError> {
    let (project,payload,digest):(String,Vec<u8>,String)=connection.query_row("SELECT project_id,CASE WHEN length(payload)<=1048576 THEN payload END,digest FROM source_sets WHERE set_id=?1",[set.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql_error)?;
    if codec::digest(&payload) != digest {
        return Err(corrupt());
    }
    let bundle: SourceBundle = codec::decode(&payload, MAX_INPUT_BYTES)?;
    bundle.validate()?;
    if bundle.set_id != set
        || super::read_metadata_from(connection)
            .map_err(|_| corrupt())?
            .project_id()
            .to_string()
            != project
    {
        return Err(corrupt());
    }
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM source_files WHERE set_id=?1",
            [set.to_string()],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    if count as usize != bundle.files.len() {
        return Err(corrupt());
    }
    for file in &bundle.files {
        let (path,role,bytes,digest):(String,String,Vec<u8>,String)=connection.query_row("SELECT logical_path,role,CASE WHEN length(bytes)<=131072 THEN bytes END,digest FROM source_files WHERE set_id=?1 AND artifact_id=?2",params![set.to_string(),file.artifact_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
        if path != file.logical_path
            || role != file.role
            || bytes != file.utf8.as_bytes()
            || digest != file.sha256
        {
            return Err(corrupt());
        }
    }
    Ok(bundle)
}
pub(super) fn record_input(
    connection: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    if input.envelope().operation != OPERATION {
        return Ok(());
    }
    let bundle = SourceBundle::from_input(input)?;
    let metadata = super::read_metadata_from(connection).map_err(|_| corrupt())?;
    if bundle.source_language != metadata.source_locale().as_str() {
        return Err(failure(ErrorCode::DependencyConflict, "language-conflict"));
    }
    let _ = scope(connection)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM source_sets WHERE set_id=?1)",
            [bundle.set_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    if exists {
        if read_bundle(connection, bundle.set_id)? != bundle {
            return Err(failure(ErrorCode::ResultMismatch, "capture-identity"));
        }
        return Ok(());
    }
    let payload = codec::encode(&bundle, MAX_INPUT_BYTES)?;
    connection
        .execute(
            "INSERT INTO source_sets VALUES (?1,?2,?3,?4)",
            params![
                bundle.set_id.to_string(),
                input.envelope().project_id.to_string(),
                payload,
                codec::digest(&payload)
            ],
        )
        .map_err(sql_error)?;
    for f in &bundle.files {
        connection
            .execute(
                "INSERT INTO source_files VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    f.artifact_id.to_string(),
                    bundle.set_id.to_string(),
                    f.logical_path,
                    f.role,
                    f.utf8.as_bytes(),
                    f.sha256
                ],
            )
            .map_err(sql_error)?;
    }
    Ok(())
}
pub(super) fn validate(connection: &Connection) -> Result<(), ExecutionError> {
    for (name, sql) in TABLES {
        let actual: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if actual != *sql {
            return Err(corrupt());
        }
    }
    let mut sets = connection
        .prepare("SELECT set_id FROM source_sets")
        .map_err(sql_error)?;
    for set in sets
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?
    {
        let _ = read_bundle(connection, id(set.map_err(sql_error)?)?)?;
    }
    let mut referenced_sets = std::collections::BTreeSet::new();
    let mut attempts=connection.prepare("SELECT attempt_id FROM execution_attempts a JOIN execution_tasks t ON t.task_id=a.task_id WHERE t.operation=?1").map_err(sql_error)?;
    for attempt in attempts
        .query_map([OPERATION], |r| r.get::<_, String>(0))
        .map_err(sql_error)?
    {
        let input = load_input(connection, id(attempt.map_err(sql_error)?)?)?;
        let bundle = SourceBundle::from_input(&input)?;
        referenced_sets.insert(bundle.set_id);
        if bundle != read_bundle(connection, bundle.set_id)? {
            return Err(corrupt());
        }
    }
    let set_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM source_sets", [], |r| r.get(0))
        .map_err(sql_error)?;
    if set_count as usize != referenced_sets.len() {
        return Err(corrupt());
    }
    let state = scope(connection)?;
    let snapshots: i64 = connection
        .query_row("SELECT COUNT(*) FROM source_snapshots", [], |r| r.get(0))
        .map_err(sql_error)?;
    if snapshots != state.revision.get() as i64 - 1
        || (snapshots == 0) != state.current_snapshot.is_none()
    {
        return Err(corrupt());
    }
    let has_lineage: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_lineage')", [], |r| r.get(0)).map_err(sql_error)?;
    if has_lineage {
        let actual: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='source_lineage'",
                [],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if actual != LINEAGE_TABLE {
            return Err(corrupt());
        }
        let actual: String = connection.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='source_lineage_evidence'", [], |r| r.get(0)).map_err(sql_error)?;
        if actual != LINEAGE_EVIDENCE_TABLE {
            return Err(corrupt());
        }
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM source_lineage", [], |r| r.get(0))
            .map_err(sql_error)?;
        let occurrences: i64 = connection
            .query_row("SELECT COUNT(*) FROM source_occurrences", [], |r| r.get(0))
            .map_err(sql_error)?;
        if count != occurrences {
            return Err(corrupt());
        }
    }
    let mut snapshots_to_check = connection
        .prepare("SELECT snapshot_id FROM source_snapshots")
        .map_err(sql_error)?;
    let mut revisions = std::collections::BTreeSet::new();
    let mut snapshot_revisions = std::collections::BTreeMap::new();
    for raw in snapshots_to_check
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?
    {
        let snapshot = id(raw.map_err(sql_error)?)?;
        let (receipt_revision, _) = snapshot_rows(connection, snapshot, has_lineage)?;
        if !revisions.insert(receipt_revision) {
            return Err(corrupt());
        }
        snapshot_revisions.insert(snapshot, receipt_revision);
    }
    if revisions != (2..=state.revision.get()).collect() {
        return Err(corrupt());
    }
    if let Some(snapshot) = state.current_snapshot {
        let (receipt_revision, _) = snapshot_rows(connection, snapshot, has_lineage)?;
        if receipt_revision != state.revision.get() {
            return Err(corrupt());
        }
    }
    if has_lineage {
        let mut statement = connection.prepare(
            "SELECT n.snapshot_id,o.snapshot_id,n.namespace,o.namespace,n.unit_id,o.unit_id,n.revision_id,o.revision_id,nr.text,orv.text,l.relation,ni.basis,oi.basis
             FROM source_lineage l JOIN source_occurrences n ON n.occurrence_id=l.occurrence_id
             JOIN source_occurrences o ON o.occurrence_id=l.predecessor_id
             JOIN source_revisions nr ON nr.revision_id=n.revision_id
             JOIN source_revisions orv ON orv.revision_id=o.revision_id JOIN source_identity ni ON ni.occurrence_id=n.occurrence_id JOIN source_identity oi ON oi.occurrence_id=o.occurrence_id"
        ).map_err(sql_error)?;
        for row in statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, String>(11)?,
                    r.get::<_, String>(12)?,
                ))
            })
            .map_err(sql_error)?
        {
            let (
                next,
                old,
                namespace,
                old_namespace,
                unit,
                old_unit,
                revision,
                old_revision,
                text,
                old_text,
                relation,
                basis,
                old_basis,
            ) = row.map_err(sql_error)?;
            if !matches!((snapshot_revisions.get(&id(old)?),snapshot_revisions.get(&id(next)?)), (Some(old),Some(next)) if old < next)
                || namespace != old_namespace
                || (relation == "unchanged"
                    && (unit != old_unit
                        || revision != old_revision
                        || text != old_text
                        || basis != old_basis))
                || (relation == "changed"
                    && (unit != old_unit
                        || revision == old_revision
                        || (text == old_text && basis == old_basis)))
                || (relation == "unresolved" && unit == old_unit)
            {
                return Err(corrupt());
            }
        }
        let mut statement = connection.prepare(
            "SELECT n.snapshot_id,o.snapshot_id,n.namespace,o.namespace,n.unit_id,o.unit_id,e.decision,e.policy
             FROM source_lineage_evidence e
             JOIN source_occurrences n ON n.occurrence_id=e.new_occurrence_id
             JOIN source_occurrences o ON o.occurrence_id=e.old_occurrence_id"
        ).map_err(sql_error)?;
        for edge in statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })
            .map_err(sql_error)?
        {
            let (next, old, next_namespace, old_namespace, next_unit, old_unit, decision, policy) =
                edge.map_err(sql_error)?;
            let next = id(next)?;
            let old = id(old)?;
            if !matches!((snapshot_revisions.get(&old), snapshot_revisions.get(&next)), (Some(old), Some(next)) if old < next)
                || next_namespace != old_namespace
                || !supported_identity_policy(&policy)
                || (decision == "continue" && next_unit != old_unit)
                || (decision == "reject" && next_unit == old_unit)
            {
                return Err(corrupt());
            }
        }
    }
    // Reject orphaned units/revisions/identity evidence, not only dangling FKs.
    let orphan:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM source_units u WHERE NOT EXISTS(SELECT 1 FROM source_occurrences o WHERE o.unit_id=u.unit_id)) OR EXISTS(SELECT 1 FROM source_revisions r WHERE NOT EXISTS(SELECT 1 FROM source_occurrences o WHERE o.revision_id=r.revision_id))",[],|r|r.get(0)).map_err(sql_error)?;
    if orphan {
        return Err(corrupt());
    }
    Ok(())
}

fn snapshot_rows(
    connection: &Connection,
    snapshot: ExecutionId,
    has_lineage: bool,
) -> Result<
    (
        u64,
        (FixedInput, FixedResult, SourceOutput, Vec<ContentRow>),
    ),
    ExecutionError,
> {
    let (project,set,attempt,result,language,policy):(String,String,String,String,String,String)=connection.query_row("SELECT project_id,set_id,attempt_id,result_id,source_language,identity_policy FROM source_snapshots WHERE snapshot_id=?1",[snapshot.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(sql_error)?;
    let input = load_input(connection, id(attempt)?)?;
    let result = load_result(connection, &input, id(result)?)?;
    let output = validate_output(&input, &result)?;
    if project != input.envelope().project_id.to_string()
        || set != output.set_id.to_string()
        || language != output.source_language
        || policy != output.identity_policy
    {
        return Err(corrupt());
    }
    let bundle = SourceBundle::from_input(&input)?;
    if read_bundle(connection, bundle.set_id)? != bundle {
        return Err(corrupt());
    }
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM source_occurrences WHERE snapshot_id=?1",
            [snapshot.to_string()],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    if count as usize != output.occurrences.len() {
        return Err(corrupt());
    }
    let mut rows = Vec::new();
    let mut units = std::collections::BTreeSet::new();
    for expected in &output.occurrences {
        let row:(String,String,String,String,String,String,String,String,String,i64,i64,i64,i64,String,String,i64,String)=connection.query_row(
            "SELECT o.occurrence_id,o.unit_id,o.revision_id,o.artifact_id,o.namespace,o.native_key,o.comparison_key,r.text,u.project_id,o.key_start,o.key_end,o.value_start,o.value_end,i.policy,i.basis,r.revision,r.unit_id FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id JOIN source_units u ON u.unit_id=o.unit_id JOIN source_identity i ON i.occurrence_id=o.occurrence_id WHERE o.snapshot_id=?1 AND o.ordinal=?2",
            params![snapshot.to_string(),expected.ordinal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?,r.get(12)?,r.get(13)?,r.get(14)?,r.get(15)?,r.get(16)?))).map_err(sql_error)?;
        if row.3 != expected.artifact_id.to_string()
            || row.4 != expected.namespace
            || row.5 != expected.key
            || row.6 != expected.key.to_ascii_lowercase()
            || row.7 != expected.text
            || row.8 != project
            || [row.9, row.10] != expected.key_byte_range.map(i64::from)
            || [row.11, row.12] != expected.value_byte_range.map(i64::from)
            || row.13 != output.identity_policy
            || row.14 != expected.identity_basis
            || row.15 < 1
            || row.16 != row.1
            || !units.insert(row.1.clone())
        {
            return Err(corrupt());
        }
        rows.push(ContentRow {
            occurrence_id: Some(id(row.0.clone())?),
            unit_id: Some(id(row.1)?),
            source_revision_id: Some(id(row.2)?),
            occurrence: expected.clone(),
        });
        if has_lineage {
            let (predecessor, relation): (Option<String>, String) = connection
                .query_row(
                    "SELECT predecessor_id,relation FROM source_lineage WHERE occurrence_id=?1",
                    [&row.0],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(sql_error)?;
            if (predecessor.is_none() && !matches!(relation.as_str(), "initial" | "new"))
                || (predecessor.is_some()
                    && !matches!(relation.as_str(), "unchanged" | "changed" | "unresolved"))
            {
                return Err(corrupt());
            }
        }
    }
    let action: String = connection
        .query_row(
            "SELECT action_id FROM adoption_receipts WHERE attempt_id=?1",
            [input.envelope().attempt_id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    let receipt = read_receipt(connection, id(action)?)?.ok_or_else(corrupt)?;
    if receipt.changes.len() != 1
        || receipt.changes[0].kind != "source-snapshot"
        || receipt.changes[0].id != snapshot.to_string()
        || receipt.changes[0].revision.get() < 2
    {
        return Err(corrupt());
    }
    if has_lineage {
        let action_bytes: Vec<u8> = connection
            .query_row(
                "SELECT request FROM execution_actions WHERE action_id=?1",
                [receipt.action_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        let action: AdoptionAction = codec::decode(&action_bytes, MAX_INPUT_BYTES)?;
        let confirmation: SourceConfirmation = from_value(&action.parameters)?;
        if confirmation.result_digest != result.digest()
            || confirmation.identity_policy != policy
            || confirmation.source_language != language
            || confirmation.expected_content_revision.get().checked_add(1)
                != Some(receipt.changes[0].revision.get())
        {
            return Err(corrupt());
        }
        let mut explicit = std::collections::BTreeSet::new();
        let mut statement = connection.prepare("SELECT n.ordinal,e.old_occurrence_id,e.decision,e.actor,e.reason,e.action_id FROM source_lineage_evidence e JOIN source_occurrences n ON n.occurrence_id=e.new_occurrence_id WHERE n.snapshot_id=?1").map_err(sql_error)?;
        for row in statement
            .query_map([snapshot.to_string()], |r| {
                Ok((
                    r.get::<_, u32>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(sql_error)?
        {
            let (ordinal, old, decision, actor, reason, evidence_action) =
                row.map_err(sql_error)?;
            if evidence_action != receipt.action_id.to_string() {
                return Err(corrupt());
            }
            if decision != "candidate" {
                let choice = confirmation
                    .lineage
                    .iter()
                    .find(|choice| {
                        choice.new_ordinal == ordinal && choice.old_occurrence_id.to_string() == old
                    })
                    .ok_or_else(corrupt)?;
                let expected = if choice.decision == LineageDecision::Continue {
                    "continue"
                } else {
                    "reject"
                };
                if decision != expected
                    || actor != confirmation.actor
                    || reason.as_deref() != Some(choice.reason.as_str())
                    || !explicit.insert(ordinal)
                {
                    return Err(corrupt());
                }
            }
        }
        if explicit.len() != confirmation.lineage.len() {
            return Err(corrupt());
        }
        // Completeness is part of the immutable evidence contract. Missing
        // candidate edges must not turn ambiguity into an empty history.
        if let Some(current) = confirmation.expected_current_snapshot {
            let base = confirmation.lineage_base_snapshot.unwrap_or(current);
            let mut old_query = connection.prepare("SELECT o.occurrence_id,o.comparison_key,r.text FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id WHERE o.snapshot_id=?1").map_err(sql_error)?;
            let old_rows = old_query
                .query_map([base.to_string()], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(sql_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_error)?;
            let keys: std::collections::BTreeSet<_> = output
                .occurrences
                .iter()
                .map(|row| row.key.to_ascii_lowercase())
                .collect();
            for row in &rows {
                let mut expected: std::collections::BTreeSet<String> = old_rows
                    .iter()
                    .filter(|(_, key, text)| {
                        key == &row.occurrence.key.to_ascii_lowercase()
                            || (text == &row.occurrence.text && !keys.contains(key))
                    })
                    .map(|(id, _, _)| id.clone())
                    .collect();
                if let Some(choice) = confirmation
                    .lineage
                    .iter()
                    .find(|choice| choice.new_ordinal == row.occurrence.ordinal)
                {
                    expected.insert(choice.old_occurrence_id.to_string());
                }
                let predecessor: Option<String> = connection
                    .query_row(
                        "SELECT predecessor_id FROM source_lineage WHERE occurrence_id=?1",
                        [row.occurrence_id.unwrap().to_string()],
                        |r| r.get(0),
                    )
                    .map_err(sql_error)?;
                if let Some(predecessor) = predecessor {
                    expected.insert(predecessor);
                }
                let mut edges = connection.prepare("SELECT old_occurrence_id FROM source_lineage_evidence WHERE new_occurrence_id=?1").map_err(sql_error)?;
                let actual = edges
                    .query_map([row.occurrence_id.unwrap().to_string()], |r| {
                        r.get::<_, String>(0)
                    })
                    .map_err(sql_error)?
                    .collect::<Result<std::collections::BTreeSet<_>, _>>()
                    .map_err(sql_error)?;
                if actual != expected {
                    return Err(corrupt());
                }
            }
        }
    }
    Ok((
        receipt.changes[0].revision.get(),
        (input, result, output, rows),
    ))
}

fn page(
    snapshot: Option<ExecutionId>,
    input: &FixedInput,
    result: &FixedResult,
    output: SourceOutput,
    scope: ContentScope,
    rows: Vec<ContentRow>,
    after: u32,
    limit: u32,
) -> Result<ContentPage, ExecutionError> {
    if limit == 0 || limit > 100 || after as usize > rows.len() {
        return Err(failure(ErrorCode::InvalidInput, "page"));
    }
    let mut page = ContentPage {
        snapshot_id: snapshot,
        attempt_id: input.envelope().attempt_id,
        result_id: result.envelope().result_id,
        confirmation: SourceConfirmation {
            result_digest: result.digest().into(),
            identity_policy: output.identity_policy.clone(),
            expected_content_revision: scope.revision,
            source_language: output.source_language.clone(),
            expected_current_snapshot: scope.current_snapshot,
            lineage: Vec::new(),
            actor: None,
            lineage_base_snapshot: None,
        },
        scope,
        namespace: output.namespace,
        coverage: output.coverage,
        total: rows.len() as u32,
        next_ordinal: None,
        diagnostics: output.diagnostics,
        rows: Vec::new(),
    };
    for row in rows.into_iter().skip(after as usize).take(limit as usize) {
        page.rows.push(row);
        if codec::encode(&page, MAX_CONTENT_PAGE_BYTES).is_err() {
            page.rows.pop();
            break;
        }
    }
    let next = after + page.rows.len() as u32;
    if next < page.total {
        page.next_ordinal = Some(next);
    }
    if page.rows.is_empty() && next < page.total {
        return Err(failure(ErrorCode::LimitExceeded, "page"));
    }
    // nextOrdinal can add bytes; keep a small fixed margin in the page budget.
    while codec::encode(&page, MAX_CONTENT_PAGE_BYTES).is_err() {
        page.rows
            .pop()
            .ok_or_else(|| failure(ErrorCode::LimitExceeded, "page"))?;
        page.next_ordinal = Some(after + page.rows.len() as u32);
    }
    Ok(page)
}
fn compare_rows(old: &[ContentRow], new: &[SourceOccurrence]) -> Vec<SourceChange> {
    let by_key: std::collections::BTreeMap<_, _> = old
        .iter()
        .map(|row| (row.occurrence.key.to_ascii_lowercase(), row))
        .collect();
    let new_keys: std::collections::BTreeSet<_> =
        new.iter().map(|row| row.key.to_ascii_lowercase()).collect();
    let removed: Vec<_> = old
        .iter()
        .filter(|row| !new_keys.contains(&row.occurrence.key.to_ascii_lowercase()))
        .collect();
    let mut changes = Vec::with_capacity(old.len() + new.len());
    for row in new {
        let previous = by_key.get(&row.key.to_ascii_lowercase()).copied();
        let (kind, candidate, candidates) = match previous {
            Some(old)
                if old.occurrence.text == row.text
                    && old.occurrence.identity_basis == row.identity_basis
                    && old.occurrence.ordinal == row.ordinal =>
            {
                ("unchanged", Some(old), vec![old.clone()])
            }
            Some(old)
                if old.occurrence.text == row.text
                    && old.occurrence.identity_basis == row.identity_basis =>
            {
                ("moved", Some(old), vec![old.clone()])
            }
            Some(old) => ("changed", Some(old), vec![old.clone()]),
            None => {
                let matches: Vec<ContentRow> = removed
                    .iter()
                    .filter(|old| old.occurrence.text == row.text)
                    .map(|old| (*old).clone())
                    .collect();
                let successors = new
                    .iter()
                    .filter(|next| {
                        next.text == row.text
                            && !by_key.contains_key(&next.key.to_ascii_lowercase())
                    })
                    .count();
                if matches.len() == 1 && successors == 1 {
                    (
                        "rename-candidate",
                        Some(
                            *removed
                                .iter()
                                .find(|old| old.occurrence.text == row.text)
                                .unwrap(),
                        ),
                        matches,
                    )
                } else if !matches.is_empty() {
                    ("ambiguous", None, matches)
                } else {
                    ("added", None, matches)
                }
            }
        };
        changes.push(SourceChange {
            kind: kind.into(),
            old: candidate.cloned(),
            new: Some(row.clone()),
            candidates,
        });
    }
    for old in removed {
        changes.push(SourceChange {
            kind: "removed".into(),
            old: Some(old.clone()),
            new: None,
            candidates: Vec::new(),
        });
    }
    changes
}
impl ProjectStore {
    pub fn source_bundle(&self, snapshot: ExecutionId) -> Result<SourceBundle, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let (_, (input, _, _, _)) = snapshot_rows(connection, snapshot, true)?;
        SourceBundle::from_input(&input)
    }
    pub fn content_scope(&self) -> Result<ContentScope, ExecutionError> {
        scope(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?,
        )
    }
    pub fn source_preview(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
        after: u32,
        limit: u32,
    ) -> Result<ContentPage, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let input = self.execution_input(attempt)?;
        let result = self.execution_result(attempt, result)?;
        let output = validate_output(&input, &result)?;
        let bundle = SourceBundle::from_input(&input)?;
        if read_bundle(connection, bundle.set_id)? != bundle {
            return Err(corrupt());
        }
        let rows = output
            .occurrences
            .iter()
            .cloned()
            .map(|occurrence| ContentRow {
                occurrence_id: None,
                unit_id: None,
                source_revision_id: None,
                occurrence,
            })
            .collect();
        page(
            None,
            &input,
            &result,
            output,
            scope(connection)?,
            rows,
            after,
            limit,
        )
    }
    pub fn source_content(
        &self,
        snapshot: ExecutionId,
        after: u32,
        limit: u32,
    ) -> Result<ContentPage, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let (_, (input, result, output, rows)) = snapshot_rows(connection, snapshot, true)?;
        page(
            Some(snapshot),
            &input,
            &result,
            output,
            scope(connection)?,
            rows,
            after,
            limit,
        )
    }
    pub fn source_comparison(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
        after: u32,
        limit: u32,
    ) -> Result<SourceChangePage, ExecutionError> {
        self.source_comparison_filtered(attempt, result, None, "", after, limit)
    }
    pub fn source_comparison_filtered(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
        base: Option<ExecutionId>,
        filter: &str,
        after: u32,
        limit: u32,
    ) -> Result<SourceChangePage, ExecutionError> {
        if filter.len() > 256 {
            return Err(failure(ErrorCode::InvalidInput, "page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let scope = scope(connection)?;
        let current = scope
            .current_snapshot
            .ok_or_else(|| failure(ErrorCode::DependencyConflict, "source-missing"))?;
        let previous = base.unwrap_or(current);
        let (_, (old_input, _, old_output, old_rows)) = snapshot_rows(connection, previous, true)?;
        let input = self.execution_input(attempt)?;
        let result = self.execution_result(attempt, result)?;
        let output = validate_output(&input, &result)?;
        if old_input.envelope().project_id != input.envelope().project_id
            || old_output.namespace != output.namespace
            || old_output.source_language != output.source_language
            || old_output.identity_policy != output.identity_policy
        {
            return Err(failure(ErrorCode::DependencyConflict, "source-namespace"));
        }
        let rows = compare_rows(&old_rows, &output.occurrences);
        if limit == 0 || limit > 100 {
            return Err(failure(ErrorCode::InvalidInput, "page"));
        }
        let mut page = SourceChangePage {
            scope: scope.clone(),
            attempt_id: attempt,
            result_id: result.envelope().result_id,
            previous_snapshot_id: previous,
            confirmation: SourceConfirmation {
                result_digest: result.digest().into(),
                identity_policy: output.identity_policy.clone(),
                expected_content_revision: scope.revision,
                source_language: output.source_language,
                expected_current_snapshot: Some(current),
                lineage: Vec::new(),
                actor: None,
                lineage_base_snapshot: Some(previous),
            },
            total: rows.len() as u32,
            filtered_total: 0,
            unchanged: rows
                .iter()
                .filter(|row| row.kind == "unchanged" || row.kind == "moved")
                .count() as u32,
            moved: rows.iter().filter(|row| row.kind == "moved").count() as u32,
            changed: rows.iter().filter(|row| row.kind == "changed").count() as u32,
            added: rows
                .iter()
                .filter(|row| {
                    row.kind == "added" || row.kind == "rename-candidate" || row.kind == "ambiguous"
                })
                .count() as u32,
            ambiguous: rows.iter().filter(|row| row.kind == "ambiguous").count() as u32,
            removed: rows.iter().filter(|row| row.kind == "removed").count() as u32,
            next_ordinal: None,
            rows: Vec::new(),
        };
        let filter = filter.to_lowercase();
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|row| {
                filter.is_empty()
                    || row.kind.contains(&filter)
                    || row.new.as_ref().is_some_and(|r| {
                        r.key.to_lowercase().contains(&filter)
                            || r.text.to_lowercase().contains(&filter)
                    })
                    || row.old.as_ref().is_some_and(|r| {
                        r.occurrence.key.to_lowercase().contains(&filter)
                            || r.occurrence.text.to_lowercase().contains(&filter)
                    })
            })
            .collect();
        page.filtered_total = rows.len() as u32;
        if after > page.filtered_total {
            return Err(failure(ErrorCode::InvalidInput, "page"));
        }
        for row in rows.into_iter().skip(after as usize).take(limit as usize) {
            page.rows.push(row);
            if codec::encode(&page, MAX_CONTENT_PAGE_BYTES).is_err() {
                page.rows.pop();
                break;
            }
        }
        let next = after + page.rows.len() as u32;
        if next < page.filtered_total {
            page.next_ordinal = Some(next);
        }
        if page.rows.is_empty() && next < page.filtered_total {
            return Err(failure(ErrorCode::LimitExceeded, "page"));
        }
        while codec::encode(&page, MAX_CONTENT_PAGE_BYTES).is_err() {
            page.rows
                .pop()
                .ok_or_else(|| failure(ErrorCode::LimitExceeded, "page"))?;
            page.next_ordinal = Some(after + page.rows.len() as u32);
        }
        Ok(page)
    }
}

fn semantic_basis(
    tx: &AdoptionTransaction<'_>,
    old: &str,
    row: &SourceOccurrence,
) -> Result<bool, ExecutionError> {
    let basis: String = tx.query_row(
        "SELECT basis FROM source_identity WHERE occurrence_id=?1",
        [old],
        |r| r.get(0),
    )?;
    Ok(basis == row.identity_basis)
}
fn apply_update(
    tx: &AdoptionTransaction<'_>,
    input: &FixedInput,
    result: &FixedResult,
    output: &SourceOutput,
    confirmation: &SourceConfirmation,
    previous: ExecutionId,
    current_revision: i64,
    project: &str,
    bundle: &SourceBundle,
    action_id: ExecutionId,
) -> Result<Vec<ChangeReference>, ExecutionError> {
    if confirmation.expected_current_snapshot != Some(previous)
        || confirmation.expected_content_revision.get() != current_revision as u64
    {
        return Err(failure(ErrorCode::DependencyConflict, "stale-preview"));
    }
    let (old_namespace, old_set): (String, String) = tx.query_row(
        "SELECT o.namespace,s.set_id FROM source_occurrences o JOIN source_snapshots s ON s.snapshot_id=o.snapshot_id WHERE o.snapshot_id=?1 ORDER BY o.ordinal LIMIT 1",
        [previous.to_string()], |r| Ok((r.get(0)?,r.get(1)?)))?;
    if old_namespace != output.namespace {
        return Err(failure(ErrorCode::DependencyConflict, "source-namespace"));
    }
    let base = confirmation.lineage_base_snapshot.unwrap_or(previous);
    let valid_base: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_snapshots WHERE snapshot_id=?1 AND project_id=?2 AND source_language=?3 AND identity_policy=?4)",
        params![base.to_string(),project,output.source_language,output.identity_policy], |r| r.get(0))?;
    if !valid_base {
        return Err(failure(ErrorCode::DependencyConflict, "lineage-choice"));
    }
    let previous_files: std::collections::BTreeMap<String, String> = tx
        .query_rows(
            "SELECT logical_path,digest FROM source_files WHERE set_id=?1",
            [old_set],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?
        .into_iter()
        .collect();
    let new_files: std::collections::BTreeMap<String, String> = bundle
        .files
        .iter()
        .map(|f| (f.logical_path.clone(), f.sha256.clone()))
        .collect();
    if previous_files == new_files && confirmation.lineage.is_empty() {
        return Err(failure(ErrorCode::DependencyConflict, "source-unchanged"));
    }
    let mut choices = std::collections::BTreeMap::new();
    let actor = confirmation.actor.as_deref();
    if !confirmation.lineage.is_empty()
        && !actor.is_some_and(|value| {
            value.trim() == value
                && !value.is_empty()
                && value.len() <= 128
                && !value.contains('\0')
        })
    {
        return Err(failure(ErrorCode::InvalidInput, "lineage-actor"));
    }
    for choice in &confirmation.lineage {
        if choice.new_ordinal as usize >= output.occurrences.len()
            || choices.insert(choice.new_ordinal, choice).is_some()
            || choice.reason.trim().is_empty()
            || choice.reason.len() > 4096
            || choice.reason.contains('\0')
        {
            return Err(failure(ErrorCode::InvalidInput, "lineage-choice"));
        }
    }
    let new_keys: std::collections::BTreeSet<_> = output
        .occurrences
        .iter()
        .map(|row| row.key.to_ascii_lowercase())
        .collect();
    let mut used_predecessors = std::collections::BTreeSet::new();
    let snapshot = ExecutionId::new();
    tx.execute(
        "INSERT INTO source_snapshots VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            snapshot.to_string(),
            project,
            bundle.set_id.to_string(),
            input.envelope().attempt_id.to_string(),
            result.envelope().result_id.to_string(),
            output.source_language,
            output.identity_policy
        ],
    )?;
    for row in &output.occurrences {
        let same_key: (Option<String>,Option<String>,Option<String>,Option<String>,Option<i64>) = tx.query_row(
            "SELECT o.occurrence_id,o.unit_id,o.revision_id,r.text,r.revision
             FROM (SELECT 1) seed LEFT JOIN source_occurrences o ON o.snapshot_id=?1 AND o.namespace=?2 AND o.comparison_key=?3
             LEFT JOIN source_revisions r ON r.revision_id=o.revision_id",
            params![previous.to_string(),row.namespace,row.key.to_ascii_lowercase()],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
        let choice = choices.get(&row.ordinal).copied();
        let mut candidates: Vec<(String, String)> = tx
            .query_rows(
                "SELECT o.occurrence_id,o.comparison_key,r.text FROM source_occurrences o
             JOIN source_revisions r ON r.revision_id=o.revision_id
             WHERE o.snapshot_id=?1 AND (o.comparison_key=?2 OR r.text=?3)",
                params![base.to_string(), row.key.to_ascii_lowercase(), row.text],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )?
            .into_iter()
            .filter_map(|(old_id, old_key, old_text)| {
                if old_key == row.key.to_ascii_lowercase() {
                    Some((old_id, "same-key".into()))
                } else if old_text == row.text && !new_keys.contains(&old_key) {
                    Some((old_id, "same-text".into()))
                } else {
                    None
                }
            })
            .collect();
        let chosen_old = if let Some(choice) = choice {
            let candidate: (String, String, String, String, i64, String) = tx.query_row(
                "SELECT o.occurrence_id,o.unit_id,o.revision_id,r.text,r.revision,o.namespace
                 FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id
                 WHERE o.snapshot_id=?1 AND o.occurrence_id=?2",
                params![base.to_string(), choice.old_occurrence_id.to_string()],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;
            if candidate.5 != row.namespace {
                return Err(failure(ErrorCode::DependencyConflict, "source-namespace"));
            }
            Some((
                candidate.0,
                candidate.1,
                candidate.2,
                candidate.3,
                candidate.4,
            ))
        } else {
            None
        };
        let automatic = match &same_key.0 {
            Some(id) => {
                semantic_basis(tx, id, row)? && same_key.3.as_deref() == Some(row.text.as_str())
            }
            None => false,
        };
        let carry = match choice {
            Some(choice) if choice.decision == LineageDecision::Continue => chosen_old.clone(),
            Some(_) => None,
            None if automatic => Some((
                same_key.0.clone().unwrap(),
                same_key.1.clone().unwrap(),
                same_key.2.clone().unwrap(),
                same_key.3.clone().unwrap(),
                same_key.4.unwrap(),
            )),
            None => None,
        };
        let (unit, revision, predecessor, relation) =
            if let Some((old_id, old_unit, old_revision, old_text, _)) = carry {
                if !used_predecessors.insert(old_unit.clone()) {
                    return Err(failure(ErrorCode::DependencyConflict, "lineage-split"));
                }
                let unit = id(old_unit)?;
                let same_content = old_text == row.text && semantic_basis(tx, &old_id, row)?;
                let source_revision = if same_content {
                    id(old_revision)?
                } else if same_key.1.as_deref() == Some(unit.to_string().as_str())
                    && same_key.3.as_deref() == Some(row.text.as_str())
                    && semantic_basis(tx, same_key.0.as_ref().ok_or_else(corrupt)?, row)?
                {
                    id(same_key.2.clone().ok_or_else(corrupt)?)?
                } else {
                    let latest: i64 = tx.query_row(
                        "SELECT MAX(revision) FROM source_revisions WHERE unit_id=?1",
                        [unit.to_string()],
                        |r| r.get(0),
                    )?;
                    let next = latest.checked_add(1).ok_or_else(corrupt)?;
                    let revision = ExecutionId::new();
                    tx.execute(
                        "INSERT INTO source_revisions VALUES (?1,?2,?3,?4)",
                        params![revision.to_string(), unit.to_string(), next, row.text],
                    )?;
                    revision
                };
                let relation = if same_content { "unchanged" } else { "changed" };
                (unit, source_revision, Some(old_id), relation)
            } else {
                let unit = ExecutionId::new();
                let revision = ExecutionId::new();
                tx.execute(
                    "INSERT INTO source_units VALUES (?1,?2)",
                    params![unit.to_string(), project],
                )?;
                tx.execute(
                    "INSERT INTO source_revisions VALUES (?1,?2,1,?3)",
                    params![revision.to_string(), unit.to_string(), row.text],
                )?;
                let predecessor = chosen_old.map(|old| old.0).or(same_key.0);
                let relation = if predecessor.is_some() {
                    "unresolved"
                } else {
                    "new"
                };
                (unit, revision, predecessor, relation)
            };
        let occurrence = ExecutionId::new();
        tx.execute(
            "INSERT INTO source_occurrences VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                occurrence.to_string(),
                snapshot.to_string(),
                row.ordinal,
                row.artifact_id.to_string(),
                unit.to_string(),
                revision.to_string(),
                row.namespace,
                row.key,
                row.key.to_ascii_lowercase(),
                row.key_byte_range[0],
                row.key_byte_range[1],
                row.value_byte_range[0],
                row.value_byte_range[1]
            ],
        )?;
        tx.execute(
            "INSERT INTO source_identity VALUES (?1,?2,?3)",
            params![
                occurrence.to_string(),
                output.identity_policy,
                row.identity_basis
            ],
        )?;
        tx.execute(
            "INSERT INTO source_lineage VALUES (?1,?2,?3)",
            params![occurrence.to_string(), predecessor, relation],
        )?;
        if let Some(choice) = choice {
            if !candidates
                .iter()
                .any(|(old_id, _)| old_id == &choice.old_occurrence_id.to_string())
            {
                candidates.push((choice.old_occurrence_id.to_string(), "manual".into()));
            }
        }
        if let Some(old_id) = &predecessor {
            if !candidates.iter().any(|(candidate, _)| candidate == old_id) {
                candidates.push((old_id.clone(), "same-key".into()));
            }
        }
        for (old_id, relationship) in candidates {
            let selected = choice.filter(|choice| choice.old_occurrence_id.to_string() == old_id);
            let decision = match selected.map(|choice| &choice.decision) {
                Some(LineageDecision::Continue) => "continue",
                Some(LineageDecision::Reject) => "reject",
                None => "candidate",
            };
            tx.execute(
                "INSERT INTO source_lineage_evidence VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    occurrence.to_string(),
                    old_id,
                    relationship,
                    decision,
                    selected.and(actor),
                    selected.map(|choice| choice.reason.as_str()),
                    action_id.to_string(),
                    output.identity_policy
                ],
            )?;
        }
        #[cfg(test)]
        if std::env::var("TSUMUGI_SOURCE_CRASH").as_deref() == Ok("during-source-adoption") {
            if let Ok(path) = std::env::var("TSUMUGI_EXECUTION_HOOK") {
                std::fs::write(path, "during-source-adoption").unwrap();
            }
            std::process::abort();
        }
    }
    let next = confirmation.expected_content_revision.next()?;
    tx.execute(
        "UPDATE content_scope SET current_snapshot=?1,revision=?2 WHERE row_id=1",
        params![snapshot.to_string(), next.get() as i64],
    )?;
    Ok(vec![ChangeReference {
        kind: "source-snapshot".into(),
        id: snapshot.to_string(),
        revision: next,
    }])
}

pub struct SourceAdoptionHandler;
impl AdoptionHandler for SourceAdoptionHandler {
    fn operation(&self) -> &str {
        OPERATION
    }
    fn apply(
        &self,
        tx: &AdoptionTransaction<'_>,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<Vec<ChangeReference>, ExecutionError> {
        if results.len() != 1 {
            return Err(invalid("invalid-structure"));
        }
        let result = &results[0];
        let output = validate_output(input, result)?;
        let confirmation: SourceConfirmation = from_value(&action.parameters)?;
        if confirmation.result_digest != result.digest()
            || confirmation.identity_policy != output.identity_policy
            || confirmation.source_language != output.source_language
        {
            return Err(failure(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let (revision, current): (i64, Option<String>) = tx.query_row(
            "SELECT revision,current_snapshot FROM content_scope WHERE row_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if revision as u64 != confirmation.expected_content_revision.get() {
            return Err(failure(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let (project, language): (String, String) = tx.query_row(
            "SELECT project_id,source_locale FROM project_metadata WHERE row_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if project != action.project_id.to_string() || language != output.source_language {
            return Err(failure(ErrorCode::DependencyConflict, "language-conflict"));
        }
        let bundle = SourceBundle::from_input(input)?;
        let (stored_project,stored,digest):(String,Vec<u8>,String)=tx.query_row("SELECT project_id,CASE WHEN length(payload)<=1048576 THEN payload END,digest FROM source_sets WHERE set_id=?1",[bundle.set_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if stored_project != project
            || codec::digest(&stored) != digest
            || codec::decode::<SourceBundle>(&stored, MAX_INPUT_BYTES)? != bundle
        {
            return Err(corrupt());
        }
        let file_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM source_files WHERE set_id=?1",
            [bundle.set_id.to_string()],
            |r| r.get(0),
        )?;
        if file_count as usize != bundle.files.len() {
            return Err(corrupt());
        }
        for f in &bundle.files {
            let (path,role,bytes,digest):(String,String,Vec<u8>,String)=tx.query_row("SELECT logical_path,role,CASE WHEN length(bytes)<=131072 THEN bytes END,digest FROM source_files WHERE set_id=?1 AND artifact_id=?2",params![bundle.set_id.to_string(),f.artifact_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            if path != f.logical_path
                || role != f.role
                || bytes != f.utf8.as_bytes()
                || digest != f.sha256
            {
                return Err(corrupt());
            }
        }
        if let Some(previous) = current {
            return apply_update(
                tx,
                input,
                result,
                &output,
                &confirmation,
                id(previous)?,
                revision,
                &project,
                &bundle,
                action.action_id,
            );
        }
        if confirmation.expected_current_snapshot.is_some() || !confirmation.lineage.is_empty() {
            return Err(failure(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let snapshots: i64 =
            tx.query_row("SELECT COUNT(*) FROM source_snapshots", [], |r| r.get(0))?;
        if snapshots != 0 || revision != 1 {
            return Err(corrupt());
        }
        let snapshot = ExecutionId::new();
        tx.execute(
            "INSERT INTO source_snapshots VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                snapshot.to_string(),
                project,
                bundle.set_id.to_string(),
                input.envelope().attempt_id.to_string(),
                result.envelope().result_id.to_string(),
                output.source_language,
                output.identity_policy
            ],
        )?;
        for row in &output.occurrences {
            let unit = ExecutionId::new();
            let revision = ExecutionId::new();
            let occurrence = ExecutionId::new();
            tx.execute(
                "INSERT INTO source_units VALUES (?1,?2)",
                params![unit.to_string(), project],
            )?;
            tx.execute(
                "INSERT INTO source_revisions VALUES (?1,?2,1,?3)",
                params![revision.to_string(), unit.to_string(), row.text],
            )?;
            tx.execute("INSERT INTO source_occurrences VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![occurrence.to_string(),snapshot.to_string(),row.ordinal,row.artifact_id.to_string(),unit.to_string(),revision.to_string(),row.namespace,row.key,row.key.to_ascii_lowercase(),row.key_byte_range[0],row.key_byte_range[1],row.value_byte_range[0],row.value_byte_range[1]])?;
            tx.execute(
                "INSERT INTO source_identity VALUES (?1,?2,?3)",
                params![
                    occurrence.to_string(),
                    output.identity_policy,
                    row.identity_basis
                ],
            )?;
            tx.execute(
                "INSERT INTO source_lineage(occurrence_id,relation) VALUES (?1,'initial')",
                [occurrence.to_string()],
            )?;
            #[cfg(test)]
            if std::env::var("TSUMUGI_SOURCE_CRASH").as_deref() == Ok("during-source-adoption") {
                if let Ok(path) = std::env::var("TSUMUGI_EXECUTION_HOOK") {
                    std::fs::write(path, "during-source-adoption").unwrap();
                }
                std::process::abort();
            }
        }
        let next = confirmation.expected_content_revision.next()?;
        tx.execute(
            "UPDATE content_scope SET current_snapshot=?1,revision=?2 WHERE row_id=1",
            params![snapshot.to_string(), next.get() as i64],
        )?;
        Ok(vec![ChangeReference {
            kind: "source-snapshot".into(),
            id: snapshot.to_string(),
            revision: next,
        }])
    }
}
