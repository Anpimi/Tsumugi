use super::{
    ProjectStore,
    ledger::{load_input, load_result, read_receipt, sql_error, validate_source_link},
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
        logical_path TEXT NOT NULL, role TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes)<=1048576), digest TEXT NOT NULL CHECK(length(digest)=64),
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
        namespace TEXT NOT NULL, native_key TEXT NOT NULL, comparison_key TEXT,
        key_start INTEGER, key_end INTEGER,
        value_start INTEGER NOT NULL CHECK(value_start>=0), value_end INTEGER NOT NULL CHECK(value_end>=value_start),
        local_unit_id TEXT NOT NULL, local_occurrence_id TEXT NOT NULL, local_revision_id TEXT NOT NULL,
        projection BLOB NOT NULL CHECK(length(projection) BETWEEN 1 AND 1048576),
        CHECK((key_start IS NULL AND key_end IS NULL)
          OR (key_start IS NOT NULL AND key_end IS NOT NULL AND key_start>=0 AND key_end>=key_start)),
        UNIQUE(snapshot_id,ordinal), UNIQUE(snapshot_id,local_occurrence_id),
        FOREIGN KEY(unit_id,revision_id) REFERENCES source_revisions(unit_id,revision_id))"),
    ("source_identity","CREATE TABLE source_identity (
        occurrence_id TEXT PRIMARY KEY NOT NULL REFERENCES source_occurrences(occurrence_id),
        policy TEXT NOT NULL, basis TEXT NOT NULL)"),
    ("source_unit_mappings","CREATE TABLE source_unit_mappings (
        snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
        local_unit_id TEXT NOT NULL, local_revision_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id), revision_id TEXT NOT NULL,
        basis_digest TEXT NOT NULL CHECK(length(basis_digest)=64),
        PRIMARY KEY(snapshot_id,local_unit_id), UNIQUE(snapshot_id,unit_id),
        FOREIGN KEY(unit_id,revision_id) REFERENCES source_revisions(unit_id,revision_id))"),
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

/// Durable ownership remains valid when a unit leaves the current source scope.
pub(super) fn unit_owned_by_project(
    connection: &Connection,
    project: ExecutionId,
    unit: ExecutionId,
) -> Result<bool, ExecutionError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM source_units WHERE unit_id=?1 AND project_id=?2
             AND project_id=(SELECT project_id FROM project_metadata WHERE row_id=1))",
            params![unit.to_string(), project.to_string()],
            |row| row.get(0),
        )
        .map_err(sql_error)
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
) -> Result<tsumugi_plugin_sdk::SourceExtractionInput, ExecutionError> {
    let (project,payload,digest):(String,Vec<u8>,String)=connection.query_row(
        "SELECT project_id,CASE WHEN length(payload)<=1048576 THEN payload END,digest FROM source_sets WHERE set_id=?1",
        [set.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql_error)?;
    if codec::digest(&payload) != digest {
        return Err(corrupt());
    }
    let source: tsumugi_plugin_sdk::SourceExtractionInput =
        codec::decode(&payload, MAX_CAPTURED_SOURCE_INPUT_BYTES)?;
    source.validate().map_err(|_| corrupt())?;
    if source.source_set_id != set.to_string()
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
    if count as usize != source.artifacts.len() {
        return Err(corrupt());
    }
    for file in &source.artifacts {
        let (path,role,bytes,digest):(String,String,Vec<u8>,String)=connection.query_row(
            "SELECT logical_path,role,CASE WHEN length(bytes)<=1048576 THEN bytes END,digest FROM source_files WHERE set_id=?1 AND artifact_id=?2",
            params![set.to_string(),file.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
        if path != file.logical_path
            || role != file.role
            || bytes != file.utf8.as_bytes()
            || digest != file.sha256
        {
            return Err(corrupt());
        }
    }
    Ok(source)
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
        if read_bundle(connection, bundle.set_id)? != bundle.source_input() {
            return Err(failure(ErrorCode::ResultMismatch, "capture-identity"));
        }
        return Ok(());
    }
    let payload = codec::encode(&bundle.source_input(), MAX_CAPTURED_SOURCE_INPUT_BYTES)?;
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
        if bundle.source_input() != read_bundle(connection, bundle.set_id)? {
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
            "SELECT n.snapshot_id,o.snapshot_id,n.namespace,o.namespace,n.unit_id,o.unit_id,e.decision,e.policy,s.identity_policy
             FROM source_lineage_evidence e
             JOIN source_occurrences n ON n.occurrence_id=e.new_occurrence_id
             JOIN source_occurrences o ON o.occurrence_id=e.old_occurrence_id
             JOIN source_snapshots s ON s.snapshot_id=n.snapshot_id"
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
                    r.get::<_, String>(8)?,
                ))
            })
            .map_err(sql_error)?
        {
            let (
                next,
                old,
                next_namespace,
                old_namespace,
                next_unit,
                old_unit,
                decision,
                policy,
                captured_policy,
            ) = edge.map_err(sql_error)?;
            let next = id(next)?;
            let old = id(old)?;
            if !matches!((snapshot_revisions.get(&old), snapshot_revisions.get(&next)), (Some(old), Some(next)) if old < next)
                || next_namespace != old_namespace
                || policy != captured_policy
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

pub(super) fn snapshot_rows(
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
    if input.envelope().plugin.is_some() {
        // A persisted snapshot requires its mandatory semantic proof even if
        // an external change downgraded the item's validation state.
        validate_source_link(connection, &input, &result, true)?;
    }
    let output = validate_output(&input, &result)?;
    if project != input.envelope().project_id.to_string()
        || set != output.set_id.to_string()
        || language != output.source_language
        || policy != output.identity_policy
    {
        return Err(corrupt());
    }
    let bundle = SourceBundle::from_input(&input)?;
    if read_bundle(connection, bundle.set_id)? != bundle.source_input() {
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
    let mut predecessors = std::collections::BTreeMap::new();
    let lineage_fields = if has_lineage {
        "l.predecessor_id,l.relation"
    } else {
        "NULL,NULL"
    };
    let lineage_join = if has_lineage {
        "LEFT JOIN source_lineage l ON l.occurrence_id=o.occurrence_id"
    } else {
        ""
    };
    let query = format!("SELECT o.occurrence_id,o.unit_id,o.revision_id,
        CASE WHEN length(o.projection)<=1048576 THEN o.projection END,r.text,u.project_id,o.ordinal,
        o.namespace,o.native_key,o.comparison_key,o.key_start,o.key_end,o.value_start,o.value_end,
        i.policy,i.basis,r.revision,r.unit_id,o.local_unit_id,o.local_occurrence_id,o.local_revision_id,{lineage_fields},o.artifact_id
        FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id
        JOIN source_units u ON u.unit_id=o.unit_id JOIN source_identity i ON i.occurrence_id=o.occurrence_id
        {lineage_join} WHERE o.snapshot_id=?1 ORDER BY o.ordinal");
    struct StoredOccurrence {
        occurrence: String,
        unit: String,
        revision: String,
        projection: Vec<u8>,
        text: String,
        project: String,
        ordinal: u32,
        namespace: String,
        key: String,
        comparison: Option<String>,
        key_start: Option<u32>,
        key_end: Option<u32>,
        value_start: u32,
        value_end: u32,
        policy: String,
        basis: String,
        revision_number: i64,
        revision_unit: String,
        local_unit: String,
        local_occurrence: String,
        local_revision: String,
        predecessor: Option<String>,
        relation: Option<String>,
        artifact: String,
    }
    let mut statement = connection.prepare(&query).map_err(sql_error)?;
    let stored = statement
        .query_map([snapshot.to_string()], |r| {
            Ok(StoredOccurrence {
                occurrence: r.get(0)?,
                unit: r.get(1)?,
                revision: r.get(2)?,
                projection: r.get(3)?,
                text: r.get(4)?,
                project: r.get(5)?,
                ordinal: r.get(6)?,
                namespace: r.get(7)?,
                key: r.get(8)?,
                comparison: r.get(9)?,
                key_start: r.get(10)?,
                key_end: r.get(11)?,
                value_start: r.get(12)?,
                value_end: r.get(13)?,
                policy: r.get(14)?,
                basis: r.get(15)?,
                revision_number: r.get(16)?,
                revision_unit: r.get(17)?,
                local_unit: r.get(18)?,
                local_occurrence: r.get(19)?,
                local_revision: r.get(20)?,
                predecessor: r.get(21)?,
                relation: r.get(22)?,
                artifact: r.get(23)?,
            })
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;
    if stored.len() != output.occurrences.len() {
        return Err(corrupt());
    }
    let mut unit_mappings = std::collections::BTreeMap::new();
    for (expected, row) in output.occurrences.iter().zip(stored) {
        let projected: SourceOccurrence = codec::decode(&row.projection, MAX_INPUT_BYTES)?;
        if projected != *expected
            || row.ordinal != expected.ordinal
            || row.project != project
            || row.artifact != expected.artifact_id.to_string()
            || row.namespace != expected.namespace
            || row.key != expected.key
            || row.comparison != expected.comparison_key()?
            || row.text != expected.text
            || row.key_start != expected.key_byte_range.map(|range| range[0])
            || row.key_end != expected.key_byte_range.map(|range| range[1])
            || [row.value_start, row.value_end] != expected.value_byte_range
            || row.policy != output.identity_policy
            || row.basis != expected.identity_basis
            || row.revision_number < 1
            || row.revision_unit != row.unit
            || row.local_unit != expected.operation_unit_id
            || row.local_occurrence != expected.operation_occurrence_id
            || row.local_revision != expected.operation_source_revision_id
        {
            return Err(corrupt());
        }
        let mapping = (
            row.unit.clone(),
            row.revision.clone(),
            expected.operation_source_revision_id.clone(),
            expected.identity_basis.clone(),
        );
        if let Some(previous) =
            unit_mappings.insert(expected.operation_unit_id.clone(), mapping.clone())
        {
            if previous != mapping {
                return Err(corrupt());
            }
        }
        rows.push(ContentRow {
            occurrence_id: Some(id(row.occurrence.clone())?),
            unit_id: Some(id(row.unit)?),
            source_revision_id: Some(id(row.revision)?),
            occurrence: expected.clone(),
        });
        if has_lineage {
            let relation = row.relation.ok_or_else(corrupt)?;
            if (row.predecessor.is_none() && !matches!(relation.as_str(), "initial" | "new"))
                || (row.predecessor.is_some()
                    && !matches!(relation.as_str(), "unchanged" | "changed" | "unresolved"))
            {
                return Err(corrupt());
            }
            predecessors.insert(row.occurrence, row.predecessor);
        }
    }
    let mut statement = connection
        .prepare(
            "SELECT local_unit_id,unit_id,revision_id,local_revision_id,basis_digest
         FROM source_unit_mappings WHERE snapshot_id=?1",
        )
        .map_err(sql_error)?;
    let saved_mappings = statement
        .query_map([snapshot.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ),
            ))
        })
        .map_err(sql_error)?
        .collect::<Result<std::collections::BTreeMap<_, _>, _>>()
        .map_err(sql_error)?;
    if unit_mappings.len() != output.exchange.units.len() || saved_mappings != unit_mappings {
        return Err(corrupt());
    }
    let mut authority_units = std::collections::BTreeSet::new();
    for (unit, _, _, _) in unit_mappings.into_values() {
        if !authority_units.insert(unit) {
            return Err(corrupt());
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
            let mut old_query=connection.prepare("SELECT occurrence_id,CASE WHEN length(projection)<=1048576 THEN projection END FROM source_occurrences WHERE snapshot_id=?1 ORDER BY ordinal").map_err(sql_error)?;
            let old_rows = old_query
                .query_map([base.to_string()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })
                .map_err(sql_error)?
                .map(|raw| {
                    let (id, bytes) = raw.map_err(sql_error)?;
                    Ok((
                        id,
                        codec::decode::<SourceOccurrence>(&bytes, MAX_INPUT_BYTES)?,
                    ))
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?;
            let keys: std::collections::BTreeSet<_> = output
                .occurrences
                .iter()
                .map(SourceOccurrence::comparison_key)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect();
            let mut edge_statement = connection
                .prepare(
                    "SELECT e.new_occurrence_id,e.old_occurrence_id FROM source_lineage_evidence e
                 JOIN source_occurrences o ON o.occurrence_id=e.new_occurrence_id
                 WHERE o.snapshot_id=?1",
                )
                .map_err(sql_error)?;
            let mut actual_edges: std::collections::BTreeMap<
                String,
                std::collections::BTreeSet<String>,
            > = Default::default();
            for edge in edge_statement
                .query_map([snapshot.to_string()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(sql_error)?
            {
                let (new, old) = edge.map_err(sql_error)?;
                actual_edges.entry(new).or_default().insert(old);
            }
            for row in &rows {
                let mut expected = std::collections::BTreeSet::new();
                for (id, old) in &old_rows {
                    if identity_family(old, &row.occurrence)
                        && (row.occurrence.same_identity(old)
                            || (old.text == row.occurrence.text
                                && old.comparison_key()?.is_none_or(|key| !keys.contains(&key))))
                    {
                        expected.insert(id.clone());
                    }
                }
                if let Some(choice) = confirmation
                    .lineage
                    .iter()
                    .find(|choice| choice.new_ordinal == row.occurrence.ordinal)
                {
                    expected.insert(choice.old_occurrence_id.to_string());
                }
                let occurrence = row.occurrence_id.unwrap().to_string();
                if let Some(Some(predecessor)) = predecessors.get(&occurrence) {
                    expected.insert(predecessor.clone());
                }
                let actual = actual_edges.remove(&occurrence).unwrap_or_default();
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
    let removed: Vec<_> = old
        .iter()
        .filter(|old| !new.iter().any(|new| new.same_identity(&old.occurrence)))
        .collect();
    let mut changes = Vec::with_capacity(old.len() + new.len());
    for row in new {
        let previous: Vec<_> = old
            .iter()
            .filter(|old| row.same_identity(&old.occurrence))
            .collect();
        let unique_unit = previous
            .first()
            .and_then(|old| old.unit_id)
            .is_some_and(|unit| previous.iter().all(|old| old.unit_id == Some(unit)));
        let (kind, candidate, candidates) = match previous.as_slice() {
            [old, ..]
                if unique_unit
                    && old.occurrence.text == row.text
                    && old.occurrence.identity_basis == row.identity_basis =>
            {
                (
                    if old.occurrence.ordinal == row.ordinal {
                        SourceChangeKind::Unchanged
                    } else {
                        SourceChangeKind::Moved
                    },
                    Some((*old).clone()),
                    previous.iter().map(|old| (**old).clone()).collect(),
                )
            }
            [old, ..] if unique_unit => (
                SourceChangeKind::Changed,
                Some((*old).clone()),
                previous.iter().map(|old| (**old).clone()).collect(),
            ),
            [] => {
                let matches: Vec<_> = removed
                    .iter()
                    .filter(|old| {
                        identity_family(&old.occurrence, row) && old.occurrence.text == row.text
                    })
                    .map(|old| (**old).clone())
                    .collect();
                let successors = new
                    .iter()
                    .filter(|next| {
                        identity_family(next, row)
                            && next.text == row.text
                            && !old.iter().any(|old| next.same_identity(&old.occurrence))
                    })
                    .count();
                if matches.len() == 1 && successors == 1 {
                    (
                        SourceChangeKind::RenameCandidate,
                        matches.first().cloned(),
                        matches,
                    )
                } else if !matches.is_empty() {
                    (SourceChangeKind::Ambiguous, None, matches)
                } else {
                    (SourceChangeKind::Added, None, vec![])
                }
            }
            _ => (
                SourceChangeKind::Ambiguous,
                None,
                previous.into_iter().cloned().collect(),
            ),
        };
        changes.push(SourceChange {
            kind,
            old: candidate,
            new: Some(row.clone()),
            candidates,
        });
    }
    for old in removed {
        changes.push(SourceChange {
            kind: SourceChangeKind::Removed,
            old: Some(old.clone()),
            new: None,
            candidates: vec![],
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
    /// Read the domain QA selection from the source's original immutable input.
    /// Snapshot/proof validation uses the same owner as all source readers.
    /// Installed-package availability and a current execution grant are separate.
    pub fn source_review_binding(
        &self,
        snapshot: ExecutionId,
    ) -> Result<Option<SourceReviewBinding>, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let (_, (input, _, _, _)) = snapshot_rows(connection, snapshot, true)?;
        Ok(SourceSettings::from_input(&input)?.review)
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
        let validation: String = connection
            .query_row(
                "SELECT validation FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![attempt.to_string(), result.envelope().item_id.to_string()],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if validation == "invalid" {
            return Err(invalid("source-invalid"));
        }
        let output = validate_output(&input, &result)?;
        let bundle = SourceBundle::from_input(&input)?;
        if read_bundle(connection, bundle.set_id)? != bundle.source_input() {
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
                .filter(|row| {
                    row.kind == SourceChangeKind::Unchanged || row.kind == SourceChangeKind::Moved
                })
                .count() as u32,
            moved: rows
                .iter()
                .filter(|row| row.kind == SourceChangeKind::Moved)
                .count() as u32,
            changed: rows
                .iter()
                .filter(|row| row.kind == SourceChangeKind::Changed)
                .count() as u32,
            added: rows
                .iter()
                .filter(|row| {
                    row.kind == SourceChangeKind::Added
                        || row.kind == SourceChangeKind::RenameCandidate
                        || row.kind == SourceChangeKind::Ambiguous
                })
                .count() as u32,
            ambiguous: rows
                .iter()
                .filter(|row| row.kind == SourceChangeKind::Ambiguous)
                .count() as u32,
            removed: rows
                .iter()
                .filter(|row| row.kind == SourceChangeKind::Removed)
                .count() as u32,
            next_ordinal: None,
            rows: Vec::new(),
        };
        let filter = filter.to_lowercase();
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|row| {
                filter.is_empty()
                    || row.kind.as_str().contains(&filter)
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

#[derive(Clone)]
struct SourcePredecessor {
    occurrence_id: String,
    unit_id: String,
    revision_id: String,
    occurrence: SourceOccurrence,
    comparison_key: Option<String>,
}
fn predecessor_rows(
    tx: &AdoptionTransaction<'_>,
    snapshot: ExecutionId,
) -> Result<Vec<SourcePredecessor>, ExecutionError> {
    tx.query_rows("SELECT o.occurrence_id,o.unit_id,o.revision_id,CASE WHEN length(o.projection)<=1048576 THEN o.projection END FROM source_occurrences o WHERE snapshot_id=?1 ORDER BY ordinal",
        [snapshot.to_string()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Vec<u8>>(3)?)))?
        .into_iter().map(|(occurrence_id,unit_id,revision_id,projection)|Ok(SourcePredecessor {
            occurrence_id,unit_id,revision_id,comparison_key: {
                let projected:SourceOccurrence=codec::decode(&projection,MAX_INPUT_BYTES)?;
                projected.comparison_key()?
            },occurrence:codec::decode(&projection,MAX_INPUT_BYTES)? })).collect()
}
fn identity_family(a: &SourceOccurrence, b: &SourceOccurrence) -> bool {
    match (a.matching_identity(), b.matching_identity()) {
        (Some((namespace, policy, _)), Some((other, other_policy, _))) => {
            namespace == other && policy == other_policy
        }
        (None, None) => true,
        _ => false,
    }
}
fn insert_mapping(
    tx: &AdoptionTransaction<'_>,
    snapshot: ExecutionId,
    row: &SourceOccurrence,
    unit: ExecutionId,
    revision: ExecutionId,
) -> Result<(), ExecutionError> {
    tx.execute(
        "INSERT INTO source_unit_mappings VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            snapshot.to_string(),
            row.operation_unit_id,
            row.operation_source_revision_id,
            unit.to_string(),
            revision.to_string(),
            row.identity_basis
        ],
    )?;
    Ok(())
}
fn insert_occurrence(
    tx: &AdoptionTransaction<'_>,
    snapshot: ExecutionId,
    row: &SourceOccurrence,
    unit: ExecutionId,
    revision: ExecutionId,
    policy: &str,
) -> Result<ExecutionId, ExecutionError> {
    let occurrence = ExecutionId::new();
    tx.execute("INSERT INTO source_occurrences VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![occurrence.to_string(),snapshot.to_string(),row.ordinal,row.artifact_id.to_string(),unit.to_string(),revision.to_string(),
            row.namespace,row.key,row.comparison_key()?,row.key_byte_range.map(|r|r[0]),row.key_byte_range.map(|r|r[1]),
            row.value_byte_range[0],row.value_byte_range[1],row.operation_unit_id,row.operation_occurrence_id,row.operation_source_revision_id,
            codec::encode(row,MAX_INPUT_BYTES)?])?;
    tx.execute(
        "INSERT INTO source_identity VALUES (?1,?2,?3)",
        params![occurrence.to_string(), policy, row.identity_basis],
    )?;
    Ok(occurrence)
}
fn adoption_crash_hook() {
    #[cfg(test)]
    if std::env::var("TSUMUGI_SOURCE_CRASH").as_deref() == Ok("during-source-adoption") {
        if let Ok(path) = std::env::var("TSUMUGI_EXECUTION_HOOK") {
            std::fs::write(path, "during-source-adoption").unwrap();
        }
        std::process::abort();
    }
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
    if confirmation.expected_current_snapshot != Some(previous) {
        return Err(
            failure(ErrorCode::DependencyConflict, "stale-preview").with_conflict(
                ConflictEvidence::SourceSnapshot {
                    expected: confirmation.expected_current_snapshot,
                    current: Some(previous),
                },
            ),
        );
    }
    if confirmation.expected_content_revision.get() != current_revision as u64 {
        return Err(
            failure(ErrorCode::DependencyConflict, "stale-preview").with_conflict(
                ConflictEvidence::ContentRevision {
                    expected: confirmation.expected_content_revision,
                    current: Revision::new(
                        u64::try_from(current_revision)
                            .map_err(|_| failure(ErrorCode::CorruptLedger, "content-scope"))?,
                    )?,
                },
            ),
        );
    }
    let old_set: String = tx.query_row(
        "SELECT set_id FROM source_snapshots WHERE snapshot_id=?1",
        [previous.to_string()],
        |r| r.get(0),
    )?;
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
        // Identical material can carry a newly adopted checker/profile. Keep
        // source revision identity stable while recording its new QA authority.
        // This is bounded generic metadata validation, never a domain parser.
        let (stored, attempt) = tx.query_row(
            &format!(
                "SELECT {},a.attempt_id
             FROM source_snapshots s JOIN execution_attempts a ON a.attempt_id=s.attempt_id
             WHERE s.snapshot_id=?1",
                super::ledger::input_columns_sql()
            ),
            [previous.to_string()],
            |r| {
                Ok((
                    super::ledger::StoredInputRow::from_row(r, 0)?,
                    r.get::<_, String>(6)?,
                ))
            },
        )?;
        let original = stored.restore(
            ExecutionId::parse(&attempt)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "source-review-binding"))?,
        )?;
        if original.envelope().project_id != input.envelope().project_id {
            return Err(failure(ErrorCode::CorruptLedger, "source-review-binding"));
        }
        if SourceSettings::from_input(&original)?.review
            == SourceSettings::from_input(input)?.review
        {
            return Err(failure(ErrorCode::DependencyConflict, "source-unchanged"));
        }
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
    let previous_rows = predecessor_rows(tx, previous)?;
    let base_rows = if base == previous {
        previous_rows.clone()
    } else {
        predecessor_rows(tx, base)?
    };
    let new_keys: std::collections::BTreeSet<_> = output
        .occurrences
        .iter()
        .map(SourceOccurrence::comparison_key)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();
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
    let mut used_units = std::collections::BTreeMap::<String, String>::new();
    for sdk_unit in &output.exchange.units {
        let group: Vec<_> = output
            .occurrences
            .iter()
            .filter(|row| row.operation_unit_id == sdk_unit.id)
            .collect();
        let first = *group.first().ok_or_else(corrupt)?;
        let mut selected_units = std::collections::BTreeMap::<String, SourcePredecessor>::new();
        let mut rejected_units = std::collections::BTreeSet::new();
        let mut predecessors = std::collections::BTreeMap::<u32, SourcePredecessor>::new();
        for row in &group {
            let matches: Vec<_> = previous_rows
                .iter()
                .filter(|old| row.same_identity(&old.occurrence))
                .collect();
            if let Some(choice) = choices.get(&row.ordinal) {
                let old = base_rows
                    .iter()
                    .find(|old| old.occurrence_id == choice.old_occurrence_id.to_string())
                    .ok_or_else(|| failure(ErrorCode::DependencyConflict, "lineage-choice"))?;
                if !identity_family(row, &old.occurrence) {
                    return Err(failure(ErrorCode::DependencyConflict, "source-namespace"));
                }
                predecessors.insert(row.ordinal, old.clone());
                if choice.decision == LineageDecision::Continue {
                    selected_units.insert(old.unit_id.clone(), old.clone());
                } else {
                    rejected_units.insert(old.unit_id.clone());
                }
            } else if matches
                .iter()
                .map(|old| &old.unit_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == 1
            {
                // Several equivalent occurrences can reference one authoritative
                // unit. Only competing units make native matching ambiguous;
                // all occurrence-level alternatives remain in lineage evidence.
                let old = matches[0];
                predecessors.insert(row.ordinal, old.clone());
                if old.occurrence.text == row.text
                    && old.occurrence.identity_basis == row.identity_basis
                {
                    selected_units.insert(old.unit_id.clone(), old.clone());
                }
            }
        }
        if selected_units.len() > 1
            || selected_units
                .keys()
                .any(|unit| rejected_units.contains(unit))
        {
            return Err(failure(ErrorCode::DependencyConflict, "lineage-merge"));
        }
        let (unit, revision) =
            if let Some((old_unit, representative)) = selected_units.into_iter().next() {
                if used_units
                    .insert(old_unit.clone(), sdk_unit.id.clone())
                    .is_some()
                {
                    return Err(failure(ErrorCode::DependencyConflict, "lineage-split"));
                }
                let unit = id(old_unit)?;
                let same_content = representative.occurrence.text == first.text
                    && representative.occurrence.identity_basis == first.identity_basis;
                let revision = if same_content {
                    id(representative.revision_id)?
                } else if let Some(current) = previous_rows.iter().find(|row| {
                    row.unit_id == unit.to_string()
                        && row.occurrence.text == first.text
                        && row.occurrence.identity_basis == first.identity_basis
                }) {
                    id(current.revision_id.clone())?
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
                        params![revision.to_string(), unit.to_string(), next, first.text],
                    )?;
                    revision
                };
                (unit, revision)
            } else {
                let unit = ExecutionId::new();
                let revision = ExecutionId::new();
                tx.execute(
                    "INSERT INTO source_units VALUES (?1,?2)",
                    params![unit.to_string(), project],
                )?;
                tx.execute(
                    "INSERT INTO source_revisions VALUES (?1,?2,1,?3)",
                    params![revision.to_string(), unit.to_string(), first.text],
                )?;
                (unit, revision)
            };
        insert_mapping(tx, snapshot, first, unit, revision)?;
        for row in group {
            let predecessor = predecessors.get(&row.ordinal);
            let relation = match predecessor {
                Some(old) if old.unit_id == unit.to_string() => {
                    if old.occurrence.text == row.text
                        && old.occurrence.identity_basis == row.identity_basis
                    {
                        "unchanged"
                    } else {
                        "changed"
                    }
                }
                Some(_) => "unresolved",
                None => "new",
            };
            let occurrence =
                insert_occurrence(tx, snapshot, row, unit, revision, &output.identity_policy)?;
            tx.execute(
                "INSERT INTO source_lineage VALUES (?1,?2,?3)",
                params![
                    occurrence.to_string(),
                    predecessor.map(|old| old.occurrence_id.as_str()),
                    relation
                ],
            )?;
            let mut candidates: std::collections::BTreeMap<String, String> = base_rows
                .iter()
                .filter(|old| identity_family(row, &old.occurrence))
                .filter_map(|old| {
                    if row.same_identity(&old.occurrence) {
                        Some((old.occurrence_id.clone(), "same-key".into()))
                    } else if old.occurrence.text == row.text
                        && old
                            .comparison_key
                            .as_ref()
                            .is_none_or(|key| !new_keys.contains(key))
                    {
                        Some((old.occurrence_id.clone(), "same-text".into()))
                    } else {
                        None
                    }
                })
                .collect();
            let choice = choices.get(&row.ordinal).copied();
            if let Some(choice) = choice {
                candidates
                    .entry(choice.old_occurrence_id.to_string())
                    .or_insert_with(|| "manual".into());
            }
            if let Some(old) = predecessor {
                candidates
                    .entry(old.occurrence_id.clone())
                    .or_insert_with(|| "same-key".into());
            }
            for (old, relationship) in candidates {
                let selected = choice.filter(|choice| choice.old_occurrence_id.to_string() == old);
                let decision = match selected.map(|choice| &choice.decision) {
                    Some(LineageDecision::Continue) => "continue",
                    Some(LineageDecision::Reject) => "reject",
                    None => "candidate",
                };
                tx.execute(
                    "INSERT INTO source_lineage_evidence VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        occurrence.to_string(),
                        old,
                        relationship,
                        decision,
                        selected.and(actor),
                        selected.map(|choice| choice.reason.as_str()),
                        action_id.to_string(),
                        output.identity_policy
                    ],
                )?;
            }
            adoption_crash_hook();
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
    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
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
        let bundle = SourceBundle::from_input(input)?;
        let input = input.clone();
        let action = action.clone();
        let result = result.clone();
        Ok(Box::new(move |tx| {
            let input = &input;
            let action = &action;
            let result = &result;
            let (revision, current): (i64, Option<String>) = tx.query_row(
                "SELECT revision,current_snapshot FROM content_scope WHERE row_id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if revision as u64 != confirmation.expected_content_revision.get() {
                return Err(
                    failure(ErrorCode::DependencyConflict, "stale-preview").with_conflict(
                        ConflictEvidence::ContentRevision {
                            expected: confirmation.expected_content_revision,
                            current: Revision::new(u64::try_from(revision).map_err(|_| {
                                failure(ErrorCode::CorruptLedger, "content-scope")
                            })?)?,
                        },
                    ),
                );
            }
            let (project, language): (String, String) = tx.query_row(
                "SELECT project_id,source_locale FROM project_metadata WHERE row_id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if project != action.project_id.to_string() || language != output.source_language {
                return Err(failure(ErrorCode::DependencyConflict, "language-conflict"));
            }
            let (stored_project,stored,digest):(String,Vec<u8>,String)=tx.query_row("SELECT project_id,CASE WHEN length(payload)<=1048576 THEN payload END,digest FROM source_sets WHERE set_id=?1",[bundle.set_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
            if stored_project != project
                || codec::digest(&stored) != digest
                || codec::decode::<tsumugi_plugin_sdk::SourceExtractionInput>(
                    &stored,
                    MAX_INPUT_BYTES,
                )? != bundle.source_input()
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
                let (path,role,bytes,digest):(String,String,Vec<u8>,String)=tx.query_row("SELECT logical_path,role,CASE WHEN length(bytes)<=1048576 THEN bytes END,digest FROM source_files WHERE set_id=?1 AND artifact_id=?2",params![bundle.set_id.to_string(),f.artifact_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
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
            if confirmation.expected_current_snapshot.is_some() {
                return Err(
                    failure(ErrorCode::DependencyConflict, "stale-preview").with_conflict(
                        ConflictEvidence::SourceSnapshot {
                            expected: confirmation.expected_current_snapshot,
                            current: None,
                        },
                    ),
                );
            }
            if !confirmation.lineage.is_empty() {
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
            for sdk_unit in &output.exchange.units {
                let group: Vec<_> = output
                    .occurrences
                    .iter()
                    .filter(|row| row.operation_unit_id == sdk_unit.id)
                    .collect();
                let first = *group.first().ok_or_else(corrupt)?;
                let unit = ExecutionId::new();
                let revision = ExecutionId::new();
                tx.execute(
                    "INSERT INTO source_units VALUES (?1,?2)",
                    params![unit.to_string(), project],
                )?;
                tx.execute(
                    "INSERT INTO source_revisions VALUES (?1,?2,1,?3)",
                    params![revision.to_string(), unit.to_string(), first.text],
                )?;
                insert_mapping(tx, snapshot, first, unit, revision)?;
                for row in group {
                    let occurrence = insert_occurrence(
                        tx,
                        snapshot,
                        row,
                        unit,
                        revision,
                        &output.identity_policy,
                    )?;
                    tx.execute(
                        "INSERT INTO source_lineage(occurrence_id,relation) VALUES (?1,'initial')",
                        [occurrence.to_string()],
                    )?;
                    adoption_crash_hook();
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
        }))
    }
}
