use super::{
    ProjectStore,
    ledger::{load_input, load_result, read_receipt, sql_error},
};
use crate::{
    content::*,
    execution::{codec, *},
};
use rusqlite::{Connection, params};

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
pub(super) fn table_names() -> Vec<String> {
    TABLES.iter().map(|(name, _)| name.to_string()).collect()
}
pub(super) fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        connection.execute_batch(sql)?;
    }
    connection.execute("INSERT INTO content_scope VALUES (1,1,NULL)", [])?;
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
    if snapshots != i64::from(current.is_some())
        || referenced != snapshots
        || revision != if snapshots == 0 { 1 } else { 2 }
    {
        return Err(corrupt());
    }
    Ok(ContentScope {
        revision: Revision::new(revision as u64)?,
        current_snapshot: current.map(id).transpose()?,
    })
}
fn read_bundle(connection: &Connection, set: ExecutionId) -> Result<SourceBundle, ExecutionError> {
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
    if count != 2 {
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
    if scope(connection)?.current_snapshot.is_some() {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "source-already-present",
        ));
    }
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
    if snapshots != i64::from(state.current_snapshot.is_some())
        || state.revision.get() != if snapshots == 0 { 1 } else { 2 }
    {
        return Err(corrupt());
    }
    if let Some(snapshot) = state.current_snapshot {
        let _ = snapshot_rows(connection, snapshot)?;
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
) -> Result<(FixedInput, FixedResult, SourceOutput, Vec<ContentRow>), ExecutionError> {
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
            || row.13 != IDENTITY_POLICY
            || row.14 != expected.identity_basis
            || row.15 != 1
            || row.16 != row.1
            || !units.insert(row.1.clone())
        {
            return Err(corrupt());
        }
        rows.push(ContentRow {
            occurrence_id: Some(id(row.0)?),
            unit_id: Some(id(row.1)?),
            source_revision_id: Some(id(row.2)?),
            occurrence: expected.clone(),
        });
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
        || receipt.changes[0].revision.get() != 2
    {
        return Err(corrupt());
    }
    Ok((input, result, output, rows))
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
            identity_policy: IDENTITY_POLICY.into(),
            expected_content_revision: scope.revision,
            source_language: output.source_language.clone(),
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
impl ProjectStore {
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
        let (input, result, output, rows) = snapshot_rows(connection, snapshot)?;
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
            || confirmation.identity_policy != IDENTITY_POLICY
            || confirmation.source_language != output.source_language
        {
            return Err(failure(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let (revision, current): (i64, Option<String>) = tx.query_row(
            "SELECT revision,current_snapshot FROM content_scope WHERE row_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if current.is_some() {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "source-already-present",
            ));
        }
        let snapshots: i64 =
            tx.query_row("SELECT COUNT(*) FROM source_snapshots", [], |r| r.get(0))?;
        if snapshots != 0 || revision != 1 {
            return Err(corrupt());
        }
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
        if file_count != 2 {
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
                IDENTITY_POLICY
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
                params![occurrence.to_string(), IDENTITY_POLICY, row.identity_basis],
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
