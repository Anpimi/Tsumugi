use super::{
    ProjectStore,
    ledger::{load_input, load_qualified_source, load_result, read_receipt, sql_error},
};
use crate::{
    content::*,
    execution::{codec, *},
};
use rusqlite::{Connection, params};
pub(in crate::persistence) mod decision_mappings;
#[cfg(test)]
mod hook_observation_tests;
pub(in crate::persistence) mod lineage_corrections;
pub(in crate::persistence) mod maintenance;
pub(in crate::persistence) mod maintenance_hook;
#[cfg(test)]
mod observation_tests;
mod publication;
#[cfg(test)]
mod start_fence_tests;
pub(in crate::persistence) mod validation_history;

/// Canonical effective occurrence positions established by the current read.
#[derive(Clone, Copy)]
pub(super) struct SourcePositions<'a> {
    pub snapshot_id: ExecutionId,
    pub members: &'a [(ExecutionId, u32)],
}

impl SourcePositions<'_> {
    pub(super) const FIRST_OCCURRENCES: &str = "first_occurrences AS MATERIALIZED (
        SELECT ?4 AS snapshot_id,json_extract(value,'$[0]') AS unit_id,
               json_extract(value,'$[1]') AS ordinal
        FROM json_each(?3))";

    pub(super) fn encode(self) -> Result<String, ExecutionError> {
        serde_json::to_string(self.members)
            .map_err(|_| failure(ErrorCode::InvalidInput, "source-positions"))
    }

    pub(super) fn units(self) -> Vec<ExecutionId> {
        self.members.iter().map(|(unit, _)| *unit).collect()
    }
}

pub(super) const TABLES:&[(&str,&str)]=&[
    ("source_sets","CREATE TABLE source_sets (
        set_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
        payload BLOB NOT NULL CHECK(length(payload) BETWEEN 1 AND 402653184), digest TEXT NOT NULL CHECK(length(digest)=64),
        UNIQUE(set_id,project_id))"),
    ("source_files","CREATE TABLE source_files (
        artifact_id TEXT PRIMARY KEY NOT NULL, set_id TEXT NOT NULL REFERENCES source_sets(set_id),
        logical_path TEXT NOT NULL, role TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes)<=134217728), digest TEXT NOT NULL CHECK(length(digest)=64),
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
    let mut names = vec!["source_lineage".into(), "source_lineage_evidence".into()];
    names.push(validation_history::TABLE.into());
    names.extend(
        lineage_corrections::TABLES
            .iter()
            .map(|(name, _)| name.to_string()),
    );
    names.extend(
        maintenance_hook::TABLES
            .iter()
            .map(|(name, _)| name.to_string()),
    );
    names
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
    validation_history::initialize(connection)?;
    lineage_corrections::initialize(connection)?;
    for (_, sql) in maintenance_hook::TABLES {
        connection.execute_batch(sql)?;
    }
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
pub(super) fn scope(connection: &Connection) -> Result<ContentScope, ExecutionError> {
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
    let input_limit = MAX_CAPTURED_SOURCE_INPUT_BYTES;
    let (project,payload,digest):(String,Vec<u8>,String)=connection.query_row(
        "SELECT project_id,CASE WHEN length(payload)<=?2 THEN payload END,digest FROM source_sets WHERE set_id=?1",
        params![set.to_string(),input_limit as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql_error)?;
    if codec::digest(&payload) != digest {
        return Err(corrupt());
    }
    let source: tsumugi_plugin_sdk::SourceExtractionInput = codec::decode(&payload, input_limit)?;
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
    validate_bundle_files(connection, set, &source)?;
    Ok(source)
}

fn validate_bundle_files(
    connection: &Connection,
    set: ExecutionId,
    source: &tsumugi_plugin_sdk::SourceExtractionInput,
) -> Result<(), ExecutionError> {
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
    let mut file_row = connection.prepare_cached(
        "SELECT rowid,logical_path,role,digest,typeof(bytes)
         FROM source_files WHERE set_id=?1 AND artifact_id=?2",
    ).map_err(sql_error)?;
    for file in &source.artifacts {
        let (rowid, path, role, digest, storage): (i64, String, String, String, String) = file_row
            .query_row(params![set.to_string(), file.id()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
            .map_err(sql_error)?;
        if path != file.logical_path() || role != file.role() || digest != file.sha256()
            || storage != "blob"
        {
            return Err(corrupt());
        }
        let blob = connection.blob_open(rusqlite::MAIN_DB, "source_files", "bytes", rowid, true)
            .map_err(sql_error)?;
        if !super::blob_matches(&blob, file.bytes().map_err(|_| corrupt())?.as_ref()).map_err(sql_error)? {
            return Err(corrupt());
        }
    }
    Ok(())
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
                    f.bytes()?.as_ref(),
                    f.sha256
                ],
            )
            .map_err(sql_error)?;
    }
    Ok(())
}
pub(super) fn validate(
    connection: &Connection,
    open_proofs: Option<&super::ledger::OpenPluginProofs<'_>>,
) -> Result<(), ExecutionError> {
    super::review::read_snapshot(connection, |connection| validate_in(connection, open_proofs))
}

pub(super) fn validate_input_bundle(
    connection: &Connection,
    input: &FixedInput,
) -> Result<ExecutionId, ExecutionError> {
    let bundle = SourceBundle::from_input(input)?;
    validate_bundle_in(connection, &bundle)?;
    Ok(bundle.set_id)
}

pub(super) fn validate_bundle_in(
    connection: &Connection,
    bundle: &SourceBundle,
) -> Result<(), ExecutionError> {
    super::review::read_snapshot(connection, |connection| validate_bundle_snapshot(connection, bundle))
}

fn validate_bundle_snapshot(connection: &Connection, bundle: &SourceBundle) -> Result<(), ExecutionError> {
    let expected = bundle.source_input();
    let project = super::read_metadata_from(connection).map_err(|_| corrupt())?.project_id().to_string();
    let (rowid, stored_project, digest, storage): (i64, String, String, String) = connection
        .query_row("SELECT rowid,project_id,digest,typeof(payload) FROM source_sets WHERE set_id=?1",
            [bundle.set_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .map_err(sql_error)?;
    if stored_project != project || storage != "blob" {
        return Err(corrupt());
    }
    // The fixed input has qualified this source payload already. Check the
    // stored representation and digest without owning another complete BLOB.
    let payload = connection.blob_open(rusqlite::MAIN_DB, "source_sets", "payload", rowid, true)
        .map_err(sql_error)?;
    if payload.len() > MAX_CAPTURED_SOURCE_INPUT_BYTES
        || !codec::matches_stored_encoding(&expected, MAX_CAPTURED_SOURCE_INPUT_BYTES, payload, &digest)?
    {
        return Err(corrupt());
    }
    validate_bundle_files(connection, bundle.set_id, &expected)
}

fn validate_in(
    connection: &Connection,
    open_proofs: Option<&super::ledger::OpenPluginProofs<'_>>,
) -> Result<(), ExecutionError> {
    maintenance_hook::validate(connection)?;
    validation_history::validate(connection, open_proofs)?;
    lineage_corrections::validate(connection)?;
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
    let referenced_set_count = if let Some(proofs) = open_proofs {
        proofs.source_sets.len()
    } else {
        let mut referenced_sets = std::collections::BTreeSet::new();
        let mut attempts = connection.prepare("SELECT attempt_id FROM execution_attempts a JOIN execution_tasks t ON t.task_id=a.task_id WHERE t.operation=?1").map_err(sql_error)?;
        for attempt in attempts.query_map([OPERATION], |r| r.get::<_, String>(0)).map_err(sql_error)? {
            let input = load_input(connection, id(attempt.map_err(sql_error)?)?)?;
            referenced_sets.insert(validate_input_bundle(connection, &input)?);
        }
        referenced_sets.len()
    };
    // Each referenced ID has a validated primary-key row in this snapshot.
    // Matching the table count rules out any unvisited source sets.
    let set_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM source_sets", [], |r| r.get(0))
        .map_err(sql_error)?;
    if set_count as usize != referenced_set_count {
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
        let (receipt_revision, _) = snapshot_qualification(connection, snapshot, has_lineage)?;
        if !revisions.insert(receipt_revision) {
            return Err(corrupt());
        }
        snapshot_revisions.insert(snapshot, receipt_revision);
    }
    if revisions != (2..=state.revision.get()).collect() {
        return Err(corrupt());
    }
    if let Some(snapshot) = state.current_snapshot
        && snapshot_revisions.get(&snapshot).copied() != Some(state.revision.get())
    {
        return Err(corrupt());
    }
    if has_lineage {
        let mut statement = connection.prepare(
            "SELECT n.snapshot_id,o.snapshot_id,n.namespace,o.namespace,n.unit_id,o.unit_id,n.revision_id,o.revision_id,nr.text,orv.text,l.relation,ni.basis,oi.basis,o.occurrence_id
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
                    r.get::<_, String>(13)?,
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
                _stored_old_unit,
                revision,
                _stored_old_revision,
                text,
                old_text,
                relation,
                basis,
                old_basis,
                old_occurrence,
            ) = row.map_err(sql_error)?;
            let frozen = lineage_corrections::frozen_predecessor(
                connection,
                id(next.clone())?,
                id(old_occurrence)?,
            )?;
            let old_unit = frozen.0.to_string();
            let old_revision = frozen.1.to_string();
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
            "SELECT n.snapshot_id,o.snapshot_id,n.namespace,o.namespace,n.unit_id,o.unit_id,e.decision,e.policy,s.identity_policy,o.occurrence_id
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
                    r.get::<_, String>(9)?,
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
                _stored_old_unit,
                decision,
                policy,
                captured_policy,
                old_occurrence,
            ) = edge.map_err(sql_error)?;
            let next = id(next)?;
            let old = id(old)?;
            let old_unit =
                lineage_corrections::frozen_predecessor(connection, next, id(old_occurrence)?)?
                    .0
                    .to_string();
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
    let orphan:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM source_units u WHERE NOT EXISTS(SELECT 1 FROM source_binding_history o WHERE o.unit_id=u.unit_id)) OR EXISTS(SELECT 1 FROM source_revisions r WHERE NOT EXISTS(SELECT 1 FROM source_binding_history o WHERE o.revision_id=r.revision_id))",[],|r|r.get(0)).map_err(sql_error)?;
    if orphan {
        return Err(corrupt());
    }
    Ok(())
}

/// A reference must retain the adopted source's original result and unit mapping.
pub(super) fn check_result_reference(
    connection: &Connection,
    project: ExecutionId,
    snapshot: ExecutionId,
    attempt: ExecutionId,
    result_id: ExecutionId,
    unit: ExecutionId,
    revision: ExecutionId,
) -> Result<(), ExecutionError> {
    let (_, (input, result, _, _)) = snapshot_rows(connection, snapshot, true)?;
    let present:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM source_binding_history WHERE snapshot_id=?1 AND unit_id=?2 AND revision_id=?3)",params![snapshot.to_string(),unit.to_string(),revision.to_string()],|r|r.get(0)).map_err(sql_error)?;
    if input.envelope().project_id != project
        || input.envelope().attempt_id != attempt
        || result.envelope().result_id != result_id
        || !present
    {
        return Err(failure(ErrorCode::Unauthorized, "source-result-reference"));
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
        (FixedInput, FixedResult, std::sync::Arc<SourceOutput>, Vec<ContentRow>),
    ),
    ExecutionError,
> {
    super::review::read_snapshot(connection, |connection| {
        let (revision, (input, result, output)) = snapshot_qualification(connection, snapshot, has_lineage)?;
        let (_, rows) = read_snapshot_rows(connection, snapshot, &output, "", 0, u32::MAX)?;
        Ok((revision, (input, result, output, rows)))
    })
}

fn check_source_bundle(
    connection: &Connection,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    if super::ledger::source_read_validation(connection, result.envelope().result_id)?
        .is_some_and(|(bundle, _)| bundle)
    {
        return Ok(());
    }
    validate_input_bundle(connection, input)?;
    super::ledger::remember_source_read_validation(connection, result.envelope().result_id, None)
}

pub(super) fn snapshot_qualification(
    connection: &Connection,
    snapshot: ExecutionId,
    has_lineage: bool,
) -> Result<(u64, (FixedInput, FixedResult, std::sync::Arc<SourceOutput>)), ExecutionError> {
    let (project,set,attempt,result,language,policy):(String,String,String,String,String,String)=connection.query_row("SELECT project_id,set_id,attempt_id,result_id,source_language,identity_policy FROM source_snapshots WHERE snapshot_id=?1",[snapshot.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(sql_error)?;
    let (input, result, output) = load_qualified_source(connection, id(attempt)?, id(result)?)?;
    if project != input.envelope().project_id.to_string()
        || set != output.set_id.to_string()
        || language != output.source_language
        || policy != output.identity_policy
    {
        return Err(corrupt());
    }
    if let Some((true, Some((verified, lineage, revision)))) =
        super::ledger::source_read_validation(connection, result.envelope().result_id)?
    {
        if verified == snapshot && (lineage || !has_lineage) {
            return Ok((revision, (input, result, output)));
        }
    }
    check_source_bundle(connection, &input, &result)?;
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
    let mut occurrence_ids = Vec::with_capacity(output.occurrences.len());
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
        .map_err(sql_error)?;
    let mut unit_mappings = std::collections::BTreeMap::new();
    for (ordinal, row) in stored.enumerate() {
        let row = row.map_err(sql_error)?;
        let expected = output.occurrences.get(ordinal).ok_or_else(corrupt)?;
        // The expected typed row was reconstructed from the verified source
        // result. Its exact encoding also rules out duplicate or extra fields.
        if !codec::matches_encoding(expected, MAX_INPUT_BYTES, &row.projection)?
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
        occurrence_ids.push(id(row.occurrence.clone())?);
        id(row.unit)?;
        id(row.revision)?;
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
    if occurrence_ids.len() != output.occurrences.len() {
        return Err(corrupt());
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
        let mut explicit_choices = std::collections::BTreeMap::new();
        for choice in &confirmation.lineage {
            explicit_choices.entry((choice.new_ordinal, choice.old_occurrence_id.to_string())).or_insert(choice);
        }
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
                let choice = explicit_choices.get(&(ordinal, old))
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
            let mut old_by_identity = std::collections::BTreeMap::new();
            let mut old_by_family_text = std::collections::BTreeMap::new();
            for (id, old) in &old_rows {
                if let Some(identity) = old.matching_identity() {
                    old_by_identity.entry(identity).or_insert_with(Vec::new).push(id);
                }
                if old.comparison_key()?.is_none_or(|key| !keys.contains(&key)) {
                    old_by_family_text.entry((identity_family_key(old), old.text.as_str()))
                        .or_insert_with(Vec::new).push(id);
                }
            }
            let mut choices = std::collections::BTreeMap::new();
            for choice in &confirmation.lineage {
                choices.entry(choice.new_ordinal).or_insert(choice);
            }
            for (occurrence, row) in occurrence_ids.iter().zip(&output.occurrences) {
                let mut expected = std::collections::BTreeSet::new();
                if let Some(previous) = row.matching_identity().and_then(|identity| old_by_identity.get(&identity)) {
                    expected.extend(previous.iter().map(|id| (*id).clone()));
                }
                if let Some(previous) = old_by_family_text.get(&(identity_family_key(row), row.text.as_str())) {
                    expected.extend(previous.iter().map(|id| (*id).clone()));
                }
                if let Some(choice) = choices.get(&row.ordinal) {
                    expected.insert(choice.old_occurrence_id.to_string());
                }
                let occurrence = occurrence.to_string();
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
    if has_lineage && scope(connection)?.current_snapshot == Some(snapshot) {
        // Current pages formerly decoded every effective binding. Retain that
        // page-external integrity check when qualifying the snapshot, even
        // though only requested rows are materialized for the response.
        let mut statement = connection.prepare(
            "SELECT unit_id,revision_id FROM source_effective_occurrences WHERE snapshot_id=?1",
        ).map_err(sql_error)?;
        let mut count = 0;
        for row in statement.query_map([snapshot.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(sql_error)? {
            let (unit, revision) = row.map_err(sql_error)?;
            id(unit)?;
            id(revision)?;
            count += 1;
        }
        if count != output.occurrences.len() { return Err(corrupt()); }
    }
    super::ledger::remember_source_read_validation(connection, result.envelope().result_id,
        Some((snapshot, has_lineage, receipt.changes[0].revision.get())))?;
    Ok((
        receipt.changes[0].revision.get(),
        (input, result, output),
    ))
}

fn read_snapshot_rows(
    connection: &Connection,
    snapshot: ExecutionId,
    output: &SourceOutput,
    query: &str,
    after: u32,
    limit: u32,
) -> Result<(u32, Vec<ContentRow>), ExecutionError> {
    let query = query.to_lowercase();
    let total = if query.is_empty() {
        output.occurrences.len() as u32
    } else {
        connection.query_row(
            "SELECT count(*) FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id
             WHERE o.snapshot_id=?1 AND (instr(tsumugi_lower(o.native_key),?2)>0 OR instr(tsumugi_lower(r.text),?2)>0)",
            params![snapshot.to_string(), query], |row| row.get(0),
        ).map_err(sql_error)?
    };
    if after > total { return Err(failure(ErrorCode::InvalidInput, "page")); }
    let mut statement = connection.prepare(
        "SELECT o.occurrence_id,o.unit_id,o.revision_id,o.ordinal FROM source_occurrences o
         JOIN source_revisions r ON r.revision_id=o.revision_id WHERE o.snapshot_id=?1
         AND (?2='' OR instr(tsumugi_lower(o.native_key),?2)>0 OR instr(tsumugi_lower(r.text),?2)>0)
         ORDER BY o.ordinal LIMIT ?3 OFFSET ?4",
    ).map_err(sql_error)?;
    let rows = statement.query_map(params![snapshot.to_string(), query, limit, after], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, u32>(3)?))
    }).map_err(sql_error)?.map(|row| {
        let (occurrence, unit, revision, ordinal) = row.map_err(sql_error)?;
        Ok(ContentRow {
            occurrence_id: Some(id(occurrence)?), unit_id: Some(id(unit)?), source_revision_id: Some(id(revision)?),
            occurrence: output.occurrences.get(ordinal as usize).ok_or_else(corrupt)?.clone(),
        })
    }).collect::<Result<Vec<_>, ExecutionError>>()?;
    Ok((total, rows))
}

fn page(
    connection: &Connection,
    snapshot: Option<ExecutionId>,
    input: &FixedInput,
    result: &FixedResult,
    output: &SourceOutput,
    scope: ContentScope,
    total: u32,
    rows: Vec<ContentRow>,
    mapping_revision: Option<Revision>,
    after: u32,
    limit: u32,
) -> Result<ContentPage, ExecutionError> {
    if limit == 0 || limit > 100 || after > total {
        return Err(failure(ErrorCode::InvalidInput, "page"));
    }
    let mut page = ContentPage {
        capture_summary: super::ledger::source_capture_summary(connection, result.envelope().result_id, output)?,
        snapshot_id: snapshot,
        attempt_id: input.envelope().attempt_id,
        result_id: result.envelope().result_id,
        confirmation: SourceConfirmation {
            expected_mapping_revision: mapping_revision,
            maintenance_hook: None,
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
        namespace: output.namespace.clone(),
        coverage: output.coverage.clone(),
        total,
        next_ordinal: None,
        diagnostics: output.diagnostics.clone(),
        rows: Vec::new(),
    };
    for row in rows.into_iter().take(limit as usize) {
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
fn visit_comparison(
    old: &[ContentRow],
    new: &[SourceOccurrence],
    mut visit: impl FnMut(SourceChangeKind, Option<&ContentRow>, Option<&SourceOccurrence>, &[&ContentRow]),
) -> SourceChangeCounts {
    let new_identities: std::collections::BTreeSet<_> = new
        .iter()
        .filter_map(SourceOccurrence::matching_identity)
        .collect();
    let mut previous_by_identity = std::collections::BTreeMap::new();
    for row in old {
        if let Some(identity) = row.occurrence.matching_identity() {
            let (rows, unit) = previous_by_identity
                .entry(identity)
                .or_insert_with(|| (Vec::new(), row.unit_id));
            if *unit != row.unit_id {
                *unit = None;
            }
            rows.push(row);
        }
    }
    let removed: Vec<_> = old
        .iter()
        .filter(|old| {
            old.occurrence
                .matching_identity()
                .is_none_or(|identity| !new_identities.contains(&identity))
        })
        .collect();
    let mut removed_by_family_text = std::collections::BTreeMap::new();
    for row in &removed {
        removed_by_family_text
            .entry((identity_family_key(&row.occurrence), row.occurrence.text.as_str()))
            .or_insert_with(Vec::new)
            .push(*row);
    }
    let mut successors_by_family_text = std::collections::BTreeMap::new();
    for row in new {
        if row
            .matching_identity()
            .is_none_or(|identity| !previous_by_identity.contains_key(&identity))
        {
            *successors_by_family_text
                .entry((identity_family_key(row), row.text.as_str()))
                .or_insert(0usize) += 1;
        }
    }
    let mut counts = SourceChangeCounts::default();
    for row in new {
        let previous_group = row
            .matching_identity()
            .and_then(|identity| previous_by_identity.get(&identity));
        let previous = previous_group.map_or(&[][..], |(rows, _)| rows.as_slice());
        let unique_unit = previous_group.is_some_and(|(_, unit)| unit.is_some());
        let (kind, candidate, candidates) = match previous {
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
                    Some(*old),
                    previous,
                )
            }
            [old, ..] if unique_unit => (
                SourceChangeKind::Changed,
                Some(*old),
                previous,
            ),
            [] => {
                let family_text = (identity_family_key(row), row.text.as_str());
                let matches = removed_by_family_text
                    .get(&family_text)
                    .map_or(&[][..], Vec::as_slice);
                let successors = successors_by_family_text
                    .get(&family_text)
                    .copied()
                    .unwrap_or(0);
                if matches.len() == 1 && successors == 1 {
                    (
                        SourceChangeKind::RenameCandidate,
                        matches.first().copied(),
                        matches,
                    )
                } else if !matches.is_empty() {
                    (SourceChangeKind::Ambiguous, None, matches)
                } else {
                    (SourceChangeKind::Added, None, &[][..])
                }
            }
            _ => (
                SourceChangeKind::Ambiguous,
                None,
                previous,
            ),
        };
        counts.record(kind);
        visit(kind, candidate, Some(row), candidates);
    }
    for old in removed {
        counts.record(SourceChangeKind::Removed);
        visit(SourceChangeKind::Removed, Some(old), None, &[]);
    }
    counts
}
impl ProjectStore {
    pub fn source_import_start_action_read(
        &self,
        request: &SourceImportStart,
    ) -> Result<Option<SourceImportStartRead>, ExecutionError> {
        let found = self.source_import_start_request_observation(request)?;
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
    }
    pub fn source_import_start_request_observation(
        &self,
        request: &SourceImportStart,
    ) -> Result<Option<SourceImportStartRead>, ExecutionError> {
        request.validate()?;
        let found = super::review::read_snapshot(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "source-start-read"))?,
            |connection| {
                if super::read_metadata_from(connection)
                    .map_err(|_| corrupt())?
                    .project_id()
                    .to_string()
                    != request.project_id.to_string()
                {
                    return Err(failure(ErrorCode::Unauthorized, "source-start-project"));
                }
                let exists: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
                        [request.attempt_id.to_string()],
                        |row| row.get(0),
                    )
                    .map_err(sql_error)?;
                if !exists {
                    return Ok(None);
                }
                let input = load_input(connection, request.attempt_id)?;
                let saved = SourceImportStart::from_input(&input)?;
                if saved != *request {
                    return Err(failure(ErrorCode::ResultMismatch, "source-start-request"));
                }
                let bundle = SourceBundle::from_input(&input)?;
                if read_bundle(connection, bundle.set_id)? != bundle.source_input() {
                    return Err(corrupt());
                }
                Ok(Some(SourceImportStartRead {
                    request: saved,
                    task_id: input.envelope().task_id,
                    input_digest: input.digest().into(),
                }))
            },
        )?;
        Ok(found)
    }
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
        if limit == 0 || limit > 100 { return Err(failure(ErrorCode::InvalidInput, "page")); }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        super::review::read_snapshot(connection, |connection| {
            let qualified: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_items i
                     JOIN execution_results r ON r.attempt_id=i.attempt_id AND r.item_id=i.item_id
                         AND r.result_id=i.current_result_id
                     WHERE i.attempt_id=?1 AND r.result_id=?2 AND i.validation='valid')",
                    params![attempt.to_string(), result.to_string()],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            // Pending or historical results still use the structural preview.
            let (input, result, output) =
                super::ledger::load_source_projection(connection, attempt, result, qualified)?;
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
            check_source_bundle(connection, &input, &result)?;
            let rows = output
                .occurrences
                .iter()
                .skip(after as usize)
                .take(limit as usize)
                .cloned()
                .map(|occurrence| ContentRow {
                    occurrence_id: None,
                    unit_id: None,
                    source_revision_id: None,
                    occurrence,
                })
                .collect();
            let scope = scope(connection)?;
            let mapping_revision = scope.current_snapshot
                .map(|snapshot| lineage_corrections::mapping_revision(connection, snapshot))
                .transpose()?;
            page(
                connection, None, &input, &result, &output, scope, output.occurrences.len() as u32,
                rows, mapping_revision, after, limit,
            )
        })
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
        if limit == 0 || limit > 100 { return Err(failure(ErrorCode::InvalidInput, "page")); }
        super::review::read_snapshot(connection, |connection| {
            let (_, (input, result, output)) = snapshot_qualification(connection, snapshot, true)?;
            let (total, mut rows) = read_snapshot_rows(connection, snapshot, &output, "", after, limit)?;
            let scope = scope(connection)?;
            if scope.current_snapshot == Some(snapshot) {
                lineage_corrections::effective_rows(connection, &mut rows)?;
            }
            let mapping_revision = scope.current_snapshot
                .map(|snapshot| lineage_corrections::mapping_revision(connection, snapshot)).transpose()?;
            page(connection, Some(snapshot), &input, &result, &output, scope, total, rows,
                mapping_revision, after, limit)
        })
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
        if filter.len() > 256 || limit == 0 || limit > 100 {
            return Err(failure(ErrorCode::InvalidInput, "page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        super::review::read_snapshot(connection, |connection| {
            let scope = scope(connection)?;
            let current = scope
                .current_snapshot
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "source-missing"))?;
            let previous = base.unwrap_or(current);
            let (_, (old_input, _, old_output, mut old_rows)) =
                snapshot_rows(connection, previous, true)?;
            lineage_corrections::effective_rows(connection, &mut old_rows)?;
            let (input, result, output) = super::ledger::load_source_projection(connection, attempt, result, false)?;
            if old_input.envelope().project_id != input.envelope().project_id
                || old_output.namespace != output.namespace
                || old_output.source_language != output.source_language
                || old_output.identity_policy != output.identity_policy
            {
                return Err(failure(ErrorCode::DependencyConflict, "source-namespace"));
            }
            let mut page = SourceChangePage {
                capture_summary: super::ledger::source_capture_summary(connection, result.envelope().result_id, &output)?,
                coverage: output.coverage.clone(),
                scope: scope.clone(),
                attempt_id: attempt,
                result_id: result.envelope().result_id,
                previous_snapshot_id: previous,
                confirmation: SourceConfirmation {
                    expected_mapping_revision: Some(lineage_corrections::mapping_revision(
                        connection, current,
                    )?),
                    maintenance_hook: None,
                    result_digest: result.digest().into(),
                    identity_policy: output.identity_policy.clone(),
                    expected_content_revision: scope.revision,
                    source_language: output.source_language.clone(),
                    expected_current_snapshot: Some(current),
                    lineage: Vec::new(),
                    actor: None,
                    lineage_base_snapshot: Some(previous),
                },
                total: 0,
                filtered_total: 0,
                counts: SourceChangeCounts::default(),
                mapping_review_required: 0,
                next_ordinal: None,
                rows: Vec::new(),
            };
            let filter = filter.to_lowercase();
            let mut full = false;
            let counts = visit_comparison(&old_rows, &output.occurrences, |kind, old, new, candidates| {
                page.total += 1;
                let matches = filter.is_empty()
                        || kind.as_str().contains(&filter)
                        || new.is_some_and(|r| {
                            r.key.to_lowercase().contains(&filter)
                                || r.text.to_lowercase().contains(&filter)
                        })
                        || old.is_some_and(|r| {
                            r.occurrence.key.to_lowercase().contains(&filter)
                                || r.occurrence.text.to_lowercase().contains(&filter)
                        });
                if !matches { return; }
                let ordinal = page.filtered_total;
                page.filtered_total += 1;
                if ordinal < after || full || page.rows.len() == limit as usize { return; }
                page.rows.push(SourceChange {
                    kind, old: old.cloned(), new: new.cloned(),
                    candidates: candidates.iter().map(|row| (**row).clone()).collect(),
                });
                if codec::encode(&page, MAX_CONTENT_PAGE_BYTES).is_err() {
                    page.rows.pop();
                    full = true;
                }
            });
            page.counts = counts;
            page.mapping_review_required = counts.mapping_review_required();
            if after > page.filtered_total {
                return Err(failure(ErrorCode::InvalidInput, "page"));
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
        })
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

/// The same monotonic scope admission is used by actual adoption and by a
/// receipt-first settlement read. A missing receipt alone proves nothing.
pub(in crate::persistence) fn check_adoption_scope(
    c: &Connection,
    project: ExecutionId,
    confirmation: &SourceConfirmation,
) -> Result<(i64, Option<String>), ExecutionError> {
    let (revision, current): (i64, Option<String>) = c
        .query_row(
            "SELECT revision,current_snapshot FROM content_scope WHERE row_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql_error)?;
    if revision as u64 != confirmation.expected_content_revision.get() {
        return Err(
            failure(ErrorCode::DependencyConflict, "stale-preview").with_conflict(
                ConflictEvidence::ContentRevision {
                    expected: confirmation.expected_content_revision,
                    current: Revision::new(u64::try_from(revision).map_err(|_| corrupt())?)?,
                },
            ),
        );
    }
    let actual = current
        .as_deref()
        .map(|value| id(value.to_owned()))
        .transpose()?;
    if actual != confirmation.expected_current_snapshot {
        return Err(
            failure(ErrorCode::DependencyConflict, "stale-preview").with_conflict(
                ConflictEvidence::SourceSnapshot {
                    expected: confirmation.expected_current_snapshot,
                    current: actual,
                },
            ),
        );
    }
    let mapping = actual
        .map(|snapshot| lineage_corrections::mapping_revision(c, snapshot))
        .transpose()?
        .map_or(0, Revision::get);
    if confirmation
        .expected_mapping_revision
        .map_or(0, Revision::get)
        != mapping
    {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "source-mapping-stale",
        ));
    }
    let (saved_project, language): (String, String) = c
        .query_row(
            "SELECT project_id,source_locale FROM project_metadata WHERE row_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql_error)?;
    if saved_project != project.to_string() || language != confirmation.source_language {
        return Err(failure(ErrorCode::DependencyConflict, "language-conflict"));
    }
    Ok((revision, current))
}
fn predecessor_rows(
    tx: &AdoptionTransaction<'_>,
    snapshot: ExecutionId,
) -> Result<Vec<SourcePredecessor>, ExecutionError> {
    tx.query_rows("SELECT o.occurrence_id,o.unit_id,o.revision_id,CASE WHEN length(o.projection)<=1048576 THEN o.projection END FROM source_effective_occurrences o WHERE snapshot_id=?1 ORDER BY ordinal",
        [snapshot.to_string()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Vec<u8>>(3)?)))?
        .into_iter().map(|(occurrence_id,unit_id,revision_id,projection)|Ok(SourcePredecessor {
            occurrence_id,unit_id,revision_id,comparison_key: {
                let projected:SourceOccurrence=codec::decode(&projection,MAX_INPUT_BYTES)?;
                projected.comparison_key()?
            },occurrence:codec::decode(&projection,MAX_INPUT_BYTES)? })).collect()
}
fn identity_family(a: &SourceOccurrence, b: &SourceOccurrence) -> bool {
    identity_family_key(a) == identity_family_key(b)
}
fn identity_family_key(
    row: &SourceOccurrence,
) -> Option<(&str, &tsumugi_plugin_sdk::ContractRef)> {
    row.matching_identity().map(|(namespace, policy, _)| (namespace, policy))
}
fn unit_occurrences(
    rows: &[SourceOccurrence],
) -> std::collections::BTreeMap<&str, Vec<&SourceOccurrence>> {
    let mut groups = std::collections::BTreeMap::new();
    // Preserve source order within each unit, independently of SDK unit order.
    for row in rows {
        groups
            .entry(row.operation_unit_id.as_str())
            .or_insert_with(Vec::new)
            .push(row);
    }
    groups
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
    let groups = unit_occurrences(&output.occurrences);
    let mut previous_by_identity = std::collections::BTreeMap::new();
    let mut previous_by_content = std::collections::BTreeMap::new();
    // Missing identities never auto-match. Each bucket keeps the same first
    // predecessor as the original ordinal-ordered scan.
    for old in &previous_rows {
        if let Some(identity) = old.occurrence.matching_identity() {
            let (rows, unit) = previous_by_identity
                .entry(identity)
                .or_insert_with(|| (Vec::new(), Some(old.unit_id.as_str())));
            if *unit != Some(old.unit_id.as_str()) { *unit = None; }
            rows.push(old);
        }
        previous_by_content
            .entry((
                old.unit_id.as_str(),
                old.occurrence.text.as_str(),
                old.occurrence.identity_basis.as_str(),
            ))
            .or_insert(old);
    }
    let mut base_by_id = std::collections::BTreeMap::new();
    let mut base_by_identity = std::collections::BTreeMap::new();
    let mut base_by_family_text = std::collections::BTreeMap::new();
    for old in &base_rows {
        base_by_id.entry(old.occurrence_id.as_str()).or_insert(old);
        let identity = old.occurrence.matching_identity();
        if let Some(identity) = identity {
            base_by_identity
                .entry(identity)
                .or_insert_with(Vec::new)
                .push(old);
        }
        base_by_family_text
            .entry((
                identity.map(|(namespace, policy, _)| (namespace, policy)),
                old.occurrence.text.as_str(),
            ))
            .or_insert_with(Vec::new)
            .push(old);
    }
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
    for predecessor in std::collections::BTreeSet::from([previous, base]) {
        let mapping = lineage_corrections::mapping_revision(tx.connection(), predecessor)?;
        tx.execute(
            "INSERT INTO source_snapshot_mapping_bases VALUES(?1,?2,?3)",
            params![
                snapshot.to_string(),
                predecessor.to_string(),
                mapping.get() as i64
            ],
        )?;
    }
    for sdk_unit in &output.exchange.units {
        let group = groups.get(sdk_unit.id.as_str()).ok_or_else(corrupt)?;
        let first = *group.first().ok_or_else(corrupt)?;
        let mut selected_units = std::collections::BTreeMap::<String, SourcePredecessor>::new();
        let mut rejected_units = std::collections::BTreeSet::new();
        let mut predecessors = std::collections::BTreeMap::<u32, SourcePredecessor>::new();
        for row in group {
            let previous_group = row
                .matching_identity()
                .and_then(|identity| previous_by_identity.get(&identity));
            let matches = previous_group.map_or(&[][..], |(rows, _)| rows.as_slice());
            if let Some(choice) = choices.get(&row.ordinal) {
                let old = *base_by_id
                    .get(choice.old_occurrence_id.to_string().as_str())
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
            } else if previous_group.is_some_and(|(_, unit)| unit.is_some()) {
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
                } else if let Some(current) = previous_by_content.get(&(
                    unit.to_string().as_str(),
                    first.text.as_str(),
                    first.identity_basis.as_str(),
                )) {
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
            let identity = row.matching_identity();
            let mut candidates: std::collections::BTreeMap<String, String> = identity
                .and_then(|identity| base_by_identity.get(&identity))
                .into_iter()
                .flatten()
                .map(|old| (old.occurrence_id.clone(), "same-key".into()))
                .collect();
            let family = identity.map(|(namespace, policy, _)| (namespace, policy));
            for old in base_by_family_text
                .get(&(family, row.text.as_str()))
                .into_iter()
                .flatten()
            {
                if old.comparison_key.as_ref().is_none_or(|key| !new_keys.contains(key)) {
                    candidates
                        .entry(old.occurrence_id.clone())
                        .or_insert_with(|| "same-text".into());
                }
            }
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
        if let Some(a) = &confirmation.maintenance_hook {
            maintenance_hook::check_shape(a)?;
        }
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
            let (revision, current) =
                check_adoption_scope(tx.connection(), action.project_id, &confirmation)?;
            let project = action.project_id.to_string();
            maintenance_hook::check_available(tx, &confirmation)?;
            if read_bundle(tx.connection(), bundle.set_id)? != bundle.source_input() {
                return Err(corrupt());
            }
            if let Some(previous) = current {
                let changes = apply_update(
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
                )?;
                maintenance_hook::record(tx, action, &confirmation, &changes[0])?;
                return Ok(changes);
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
            let groups = unit_occurrences(&output.occurrences);
            for sdk_unit in &output.exchange.units {
                let group = groups.get(sdk_unit.id.as_str()).ok_or_else(corrupt)?;
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
            let changes = vec![ChangeReference {
                kind: "source-snapshot".into(),
                id: snapshot.to_string(),
                revision: next,
            }];
            maintenance_hook::record(tx, action, &confirmation, &changes[0])?;
            Ok(changes)
        }))
    }
}
