//! Original delivery decoding and file-basis validation. Reads inspect only
//! persisted SQLite facts, never the destination directory or live permission.
use super::*;
use rusqlite::OptionalExtension;

const COLUMNS: &str = "delivery_id,action_id,release_id,directory,overwrite_conflicts,state,expected_json,results_json,created_at";

struct StoredDelivery {
    delivery: String,
    action: String,
    release: String,
    directory: String,
    overwrite_conflicts: bool,
    state: String,
    expected: String,
    results: Option<String>,
    created_at: String,
}

impl StoredDelivery {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self { delivery: row.get(0)?, action: row.get(1)?, release: row.get(2)?,
            directory: row.get(3)?, overwrite_conflicts: row.get(4)?, state: row.get(5)?,
            expected: row.get(6)?, results: row.get(7)?, created_at: row.get(8)? })
    }

    fn decode(self, c: &Connection) -> Result<DeliveryView, ExecutionError> {
        let invalid = || failure(ErrorCode::CorruptLedger, "delivery-files");
        let delivery_id = parse_id(self.delivery)?;
        let action_id = parse_id(self.action)?;
        let release_id = parse_id(self.release)?;
        let state = DeliveryState::from_stored(&self.state)?;
        if self.directory.is_empty() || self.directory.len() > 4096 { return Err(invalid()); }
        let expected: Vec<DeliveryFile> = serde_json::from_str(&self.expected).map_err(|_| invalid())?;
        let mut statement = c.prepare("SELECT locale,file_name,sha256 FROM release_artifacts
            WHERE release_id=?1 ORDER BY locale,file_name").map_err(sql)?;
        let artifacts = statement.query_map([release_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }).map_err(sql)?.collect::<Result<Vec<_>, _>>().map_err(sql)?;
        if expected.is_empty() || expected.len() != artifacts.len()
            || expected.iter().zip(&artifacts).any(|(file, artifact)| file.locale != artifact.0
                || file.file_name != artifact.1 || file.expected_sha256 != artifact.2
                || file.actual_sha256.is_some() || file.state != DeliveryFileState::Pending) {
            return Err(invalid());
        }
        let files = match self.results {
            None if state == DeliveryState::Pending => expected,
            Some(encoded) if state != DeliveryState::Pending => {
                let files: Vec<DeliveryFile> = serde_json::from_str(&encoded).map_err(|_| invalid())?;
                if files.len() != expected.len() || files.iter().zip(&expected).any(|(file, prior)| {
                    file.locale != prior.locale || file.file_name != prior.file_name
                        || file.expected_sha256 != prior.expected_sha256
                        || !matches!(file.state, DeliveryFileState::Succeeded | DeliveryFileState::Failed | DeliveryFileState::Unknown)
                        || file.state == DeliveryFileState::Succeeded
                            && file.actual_sha256.as_deref() != Some(&file.expected_sha256)
                }) { return Err(invalid()); }
                let success = files.iter().filter(|file| file.state == DeliveryFileState::Succeeded).count();
                let actual = if success == files.len() { DeliveryState::Succeeded }
                    else if files.iter().any(|file| file.state == DeliveryFileState::Unknown) { DeliveryState::Unknown }
                    else if success > 0 { DeliveryState::Partial } else { DeliveryState::Failed };
                if state != actual { return Err(invalid()); }
                files
            }
            _ => return Err(invalid()),
        };
        Ok(DeliveryView { delivery_id, action_id, release_id, directory: self.directory,
            overwrite_conflicts: self.overwrite_conflicts, state, files, created_at: self.created_at })
    }
}

pub(super) fn by_action_in(c: &Connection, action: ExecutionId) -> Result<Option<DeliveryView>, ExecutionError> {
    c.query_row(&format!("SELECT {COLUMNS} FROM release_deliveries WHERE action_id=?1"),
        [action.to_string()], StoredDelivery::from_row).optional().map_err(sql)?
        .map(|stored| stored.decode(c)).transpose()
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let mut statement = c.prepare(&format!("SELECT {COLUMNS} FROM release_deliveries")).map_err(sql)?;
    let rows = statement.query_map([], StoredDelivery::from_row).map_err(sql)?;
    for row in rows { row.map_err(sql)?.decode(c)?; }
    Ok(())
}

pub(in crate::persistence) struct DeliveryObservationPage {
    pub rows: Vec<DeliveryView>,
    pub next: Option<ExecutionId>,
}

/// Seek across every release belonging to this project. The continuation and
/// sentinel distinguish a bounded prefix from a completely observed source.
pub(in crate::persistence) fn project_observations_in(
    c: &Connection, project: ExecutionId, after: Option<ExecutionId>, limit: usize,
) -> Result<DeliveryObservationPage, ExecutionError> {
    if limit == 0 || limit > 1_000 { return Err(failure(ErrorCode::InvalidInput, "delivery-page")); }
    let metadata = super::super::read_metadata_from(c)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "delivery-project"))?;
    if metadata.project_id().to_string() != project.to_string() {
        return Err(failure(ErrorCode::Unauthorized, "delivery-project"));
    }
    let mut statement = c.prepare("SELECT d.delivery_id,d.action_id,d.release_id FROM release_deliveries d
        JOIN release_records r ON r.release_id=d.release_id AND r.project_id=?1
        WHERE (?2 IS NULL OR d.delivery_id>?2) ORDER BY d.delivery_id LIMIT ?3").map_err(sql)?;
    let mut references = statement.query_map(params![project.to_string(), after.map(|id| id.to_string()), (limit + 1) as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    }).map_err(sql)?.collect::<Result<Vec<_>, _>>().map_err(sql)?;
    let more = references.len() > limit;
    references.truncate(limit);
    let mut rows = Vec::with_capacity(references.len());
    let mut verified = BTreeSet::new();
    for (delivery, action, release) in references {
        let delivery = parse_id(delivery)?;
        let release = parse_id(release)?;
        if verified.insert(release) { record::load(c, release)?; }
        let value = by_action_in(c, parse_id(action)?)?
            .filter(|value| value.delivery_id == delivery && value.release_id == release)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "delivery-identity"))?;
        rows.push(value);
    }
    let next = if more { rows.last().map(|value| value.delivery_id) } else { None };
    Ok(DeliveryObservationPage { rows, next })
}
