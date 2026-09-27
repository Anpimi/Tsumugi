//! Translation revision schema and checked project-local mutations.

use super::ProjectStore;
use crate::execution::{
    AdoptionAction, AdoptionHandler, AdoptionTransaction, ChangeReference, ErrorCode,
    ExecutionError, ExecutionId, FixedInput, FixedResult, MAX_INPUT_BYTES, Revision, codec,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranslationMatch {
    Unique,
    Unmatched,
    Ambiguous,
    SelectedConflict,
    SourceChanged,
    Applied,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationPreviewRow {
    pub entry: crate::content::TranslationEntry,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
    pub result_digest: String,
    pub unit_id: Option<ExecutionId>,
    pub occurrence_id: Option<ExecutionId>,
    pub source_revision_id: Option<ExecutionId>,
    pub source_text: Option<String>,
    pub current_selection: Option<TranslationSelection>,
    pub current_text: Option<String>,
    pub status: TranslationMatch,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationPreview {
    pub attempt_id: ExecutionId,
    pub bundle_id: ExecutionId,
    pub fixed_source_snapshot_id: ExecutionId,
    pub current_source_snapshot_id: ExecutionId,
    pub result_digest: String,
    pub file_digest: String,
    pub logical_path: String,
    pub declared_locale: String,
    pub target_locale: String,
    pub basis: String,
    pub total: u32,
    pub unique: u32,
    pub unmatched: u32,
    pub ambiguous: u32,
    pub selected_conflicts: u32,
    pub source_changed: u32,
    pub applied: u32,
    pub next_ordinal: Option<u32>,
    pub rows: Vec<TranslationPreviewRow>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranslationSelectionDecision {
    CandidateOnly,
    SelectIfEmpty,
    Replace,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationAdoptionConfirmation {
    pub result_digest: String,
    pub source_snapshot_id: ExecutionId,
    pub occurrence_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub target_unit_id: ExecutionId,
    pub expected_selection_id: Option<ExecutionId>,
    pub decision: TranslationSelectionDecision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveTranslationRevision {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub expected_selection_id: Option<ExecutionId>,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectTranslationRevision {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub expected_selection_id: Option<ExecutionId>,
    pub revision_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationSelection {
    pub event_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub sequence: u64,
    pub revision_id: ExecutionId,
    pub action_id: ExecutionId,
    pub previous_event_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationRevision {
    pub revision_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub ordinal: u64,
    pub text: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub origin_kind: String,
    pub action_id: ExecutionId,
    pub attempt_id: Option<ExecutionId>,
    pub result_id: Option<ExecutionId>,
    pub item_id: Option<ExecutionId>,
    pub artifact_id: Option<ExecutionId>,
    pub logical_path: Option<String>,
    pub declared_locale: Option<String>,
    pub native_key: Option<String>,
    pub file_digest: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationHistory {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub total: u64,
    pub current: Option<TranslationSelection>,
    pub current_text: Option<String>,
    pub rows: Vec<TranslationRevision>,
    pub next_ordinal: Option<u64>,
}

const TABLES: &[(&str, &str)] = &[
    (
        "translation_revisions",
        "CREATE TABLE translation_revisions (
            revision_id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL,
            unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
            locale TEXT NOT NULL,
            ordinal INTEGER NOT NULL CHECK(ordinal > 0),
            text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) <= 16384),
            source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
            source_revision_id TEXT NOT NULL,
            origin_kind TEXT NOT NULL CHECK(origin_kind IN ('import','manual')),
            action_id TEXT NOT NULL UNIQUE,
            request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
            attempt_id TEXT REFERENCES execution_attempts(attempt_id),
            result_id TEXT REFERENCES execution_results(result_id),
            item_id TEXT,
            artifact_id TEXT,
            logical_path TEXT,
            declared_locale TEXT,
            native_key TEXT,
            file_digest TEXT,
            UNIQUE(unit_id,locale,ordinal),
            UNIQUE(unit_id,locale,revision_id),
            FOREIGN KEY(unit_id,source_revision_id) REFERENCES source_revisions(unit_id,revision_id),
            CHECK((origin_kind='manual' AND attempt_id IS NULL AND result_id IS NULL AND item_id IS NULL AND artifact_id IS NULL AND logical_path IS NULL AND declared_locale IS NULL AND native_key IS NULL AND file_digest IS NULL)
               OR (origin_kind='import' AND attempt_id IS NOT NULL AND result_id IS NOT NULL AND item_id IS NOT NULL AND artifact_id IS NOT NULL AND logical_path IS NOT NULL AND declared_locale IS NOT NULL AND native_key IS NOT NULL AND file_digest IS NOT NULL)))",
    ),
    (
        "translation_selections",
        "CREATE TABLE translation_selections (
            event_id TEXT PRIMARY KEY NOT NULL,
            project_id TEXT NOT NULL,
            unit_id TEXT NOT NULL,
            locale TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK(sequence > 0),
            revision_id TEXT NOT NULL,
            action_id TEXT NOT NULL UNIQUE,
            request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
            previous_event_id TEXT REFERENCES translation_selections(event_id),
            UNIQUE(unit_id,locale,sequence),
            FOREIGN KEY(unit_id,locale,revision_id) REFERENCES translation_revisions(unit_id,locale,revision_id))",
    ),
];

pub(super) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| (*name).to_owned())
}

pub(super) fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        connection.execute_batch(sql)?;
    }
    Ok(())
}

pub(super) fn migrate_v4(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    initialize(&transaction)?;
    if transaction
        .prepare("PRAGMA foreign_key_check")?
        .exists([])?
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    transaction.pragma_update(None, "user_version", super::SCHEMA_VERSION)?;
    #[cfg(test)]
    migration_crash_hook("before-translation-migration-commit");
    transaction.commit()?;
    #[cfg(test)]
    migration_crash_hook("after-translation-migration-commit");
    Ok(())
}

#[cfg(test)]
fn migration_crash_hook(point: &str) {
    if std::env::var("TSUMUGI_MIGRATION_CRASH").as_deref() == Ok(point) {
        if let Ok(path) = std::env::var("TSUMUGI_MIGRATION_HOOK") {
            std::fs::write(path, point).unwrap();
        }
        std::process::abort();
    }
}

pub(super) fn record_input(
    connection: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    if input.envelope().operation != crate::content::TRANSLATION_OPERATION {
        return Ok(());
    }
    let bundle = crate::content::TranslationBundle::from_input(input)?;
    check_target(
        connection,
        input.envelope().project_id,
        &bundle.target_locale,
    )?;
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT s.project_id,s.attempt_id FROM source_snapshots s
             JOIN content_scope c ON c.current_snapshot=s.snapshot_id
             WHERE s.snapshot_id=?1",
            [bundle.source_snapshot_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(super::ledger::sql_error)?;
    let Some((owner, source_attempt)) = row else {
        return Err(error(ErrorCode::DependencyConflict, "translation-source"));
    };
    if owner != input.envelope().project_id.to_string() {
        return Err(error(ErrorCode::Unauthorized, "translation-project"));
    }
    let original = super::ledger::load_input(connection, id(source_attempt)?)?;
    let source = crate::content::SourceBundle::from_input(&original)?;
    if source.format_id != bundle.format_id || source.format_version != bundle.format_version {
        return Err(error(ErrorCode::DependencyConflict, "translation-format"));
    }
    Ok(())
}

pub(super) fn validate(connection: &Connection) -> rusqlite::Result<()> {
    for (name, expected) in TABLES {
        let actual: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |row| row.get(0),
        )?;
        if actual != *expected {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    if connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let project: String = connection.query_row(
        "SELECT project_id FROM project_metadata WHERE row_id=1",
        [],
        |row| row.get(0),
    )?;
    let mut revision_ordinals = std::collections::BTreeMap::<(String, String), i64>::new();
    let mut revisions = connection.prepare(
        "SELECT revision_id,project_id,unit_id,locale,ordinal,source_snapshot_id,
                source_revision_id,origin_kind,action_id,attempt_id,result_id,item_id
         FROM translation_revisions ORDER BY unit_id,locale,ordinal",
    )?;
    let rows = revisions.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
        ))
    })?;
    for row in rows {
        let (
            revision,
            owner,
            unit,
            locale,
            ordinal,
            snapshot,
            source,
            kind,
            action,
            attempt,
            result,
            item,
        ) = row?;
        let key = (unit.clone(), locale.clone());
        let previous = revision_ordinals.get(&key).copied().unwrap_or(0);
        let canonical = crate::Locale::parse(&locale).ok();
        if owner != project
            || canonical.as_ref().map(crate::Locale::as_str) != Some(locale.as_str())
            || ordinal != previous + 1
            || ExecutionId::parse(&revision).is_err()
            || ExecutionId::parse(&unit).is_err()
            || ExecutionId::parse(&snapshot).is_err()
            || ExecutionId::parse(&source).is_err()
            || ExecutionId::parse(&action).is_err()
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        revision_ordinals.insert(key, ordinal);
        let source_valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_occurrences o
             JOIN source_units u ON u.unit_id=o.unit_id
             WHERE o.snapshot_id=?1 AND o.unit_id=?2 AND o.revision_id=?3 AND u.project_id=?4)",
            params![snapshot, unit, source, project],
            |row| row.get(0),
        )?;
        if !source_valid {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let origin_valid: bool = if kind == "manual" {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM translation_selections
                 WHERE action_id=?1 AND revision_id=?2)",
                params![action, revision],
                |row| row.get(0),
            )?
        } else if kind == "import" {
            let (Some(attempt), Some(result), Some(item)) = (attempt, result, item) else {
                return Err(rusqlite::Error::InvalidQuery);
            };
            if ExecutionId::parse(&attempt).is_err()
                || ExecutionId::parse(&result).is_err()
                || ExecutionId::parse(&item).is_err()
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM adoption_receipts a
                 JOIN execution_results r ON r.result_id=?3
                 WHERE a.action_id=?1 AND a.attempt_id=?2
                   AND r.item_id=?4)",
                params![action, attempt, result, item],
                |row| row.get(0),
            )?
        } else {
            false
        };
        if !origin_valid {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    let mut previous_events = std::collections::BTreeMap::<(String, String), (i64, String)>::new();
    let mut selections = connection.prepare(
        "SELECT event_id,project_id,unit_id,locale,sequence,previous_event_id,action_id
         FROM translation_selections ORDER BY unit_id,locale,sequence",
    )?;
    let events = selections.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    for event in events {
        let (id, owner, unit, locale, sequence, previous, action) = event?;
        let key = (unit, locale);
        let (last_sequence, last_id) = previous_events
            .get(&key)
            .cloned()
            .unwrap_or((0, String::new()));
        if owner != project
            || sequence != last_sequence + 1
            || previous.as_deref() != (last_sequence > 0).then_some(last_id.as_str())
            || ExecutionId::parse(&id).is_err()
            || ExecutionId::parse(&action).is_err()
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        previous_events.insert(key, (sequence, id));
    }
    Ok(())
}

fn error(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}

fn id(raw: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&raw).map_err(|_| error(ErrorCode::CorruptLedger, "translation-identity"))
}

fn optional_id(raw: Option<String>) -> Result<Option<ExecutionId>, ExecutionError> {
    raw.map(id).transpose()
}

fn request_digest<T: Serialize>(request: &T) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(request, MAX_INPUT_BYTES)?))
}

fn source_basis(
    connection: &Connection,
    project: ExecutionId,
    unit: ExecutionId,
) -> Result<(ExecutionId, ExecutionId), ExecutionError> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT o.snapshot_id,o.revision_id,u.project_id
             FROM source_occurrences o
             JOIN source_units u ON u.unit_id=o.unit_id
             JOIN content_scope c ON c.current_snapshot=o.snapshot_id
             WHERE o.unit_id=?1",
            [unit.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(super::ledger::sql_error)?;
    let Some((snapshot, revision, owner)) = row else {
        return Err(error(ErrorCode::DependencyConflict, "translation-source"));
    };
    if owner != project.to_string() {
        return Err(error(ErrorCode::Unauthorized, "translation-project"));
    }
    Ok((id(snapshot)?, id(revision)?))
}

fn check_target(
    connection: &Connection,
    project: ExecutionId,
    locale: &str,
) -> Result<(), ExecutionError> {
    let metadata = super::read_metadata_from(connection)
        .map_err(|_| error(ErrorCode::CorruptLedger, "translation-project"))?;
    if metadata.project_id().to_string() != project.to_string() {
        return Err(error(ErrorCode::Unauthorized, "translation-project"));
    }
    let parsed = crate::Locale::parse(locale)
        .map_err(|_| error(ErrorCode::InvalidInput, "translation-locale"))?;
    if parsed.as_str() != locale
        || !metadata
            .target_locales()
            .iter()
            .any(|target| target.as_str() == locale)
    {
        return Err(error(ErrorCode::DependencyConflict, "translation-locale"));
    }
    Ok(())
}

fn current_selection(
    connection: &Connection,
    unit: ExecutionId,
    locale: &str,
) -> Result<Option<TranslationSelection>, ExecutionError> {
    let row: Option<(String, i64, String, String, Option<String>)> = connection
        .query_row(
            "SELECT event_id,sequence,revision_id,action_id,previous_event_id
             FROM translation_selections WHERE unit_id=?1 AND locale=?2
             ORDER BY sequence DESC LIMIT 1",
            params![unit.to_string(), locale],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(super::ledger::sql_error)?;
    row.map(|(event, sequence, revision, action, previous)| {
        Ok(TranslationSelection {
            event_id: id(event)?,
            unit_id: unit,
            locale: locale.to_owned(),
            sequence: u64::try_from(sequence)
                .map_err(|_| error(ErrorCode::CorruptLedger, "translation-selection"))?,
            revision_id: id(revision)?,
            action_id: id(action)?,
            previous_event_id: optional_id(previous)?,
        })
    })
    .transpose()
}

fn selection_by_action(
    connection: &Connection,
    action: ExecutionId,
) -> Result<Option<(TranslationSelection, String)>, ExecutionError> {
    let row: Option<(String, String, String, i64, String, Option<String>, String)> = connection
        .query_row(
            "SELECT event_id,unit_id,locale,sequence,revision_id,previous_event_id,request_digest
             FROM translation_selections WHERE action_id=?1",
            [action.to_string()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(super::ledger::sql_error)?;
    row.map(
        |(event, unit, locale, sequence, revision, previous, digest)| {
            Ok((
                TranslationSelection {
                    event_id: id(event)?,
                    unit_id: id(unit)?,
                    locale,
                    sequence: u64::try_from(sequence)
                        .map_err(|_| error(ErrorCode::CorruptLedger, "translation-selection"))?,
                    revision_id: id(revision)?,
                    action_id: action,
                    previous_event_id: optional_id(previous)?,
                },
                digest,
            ))
        },
    )
    .transpose()
}

fn check_expected(
    current: &Option<TranslationSelection>,
    expected: Option<ExecutionId>,
) -> Result<u64, ExecutionError> {
    if current.as_ref().map(|selection| selection.event_id) != expected {
        return Err(error(
            ErrorCode::DependencyConflict,
            "translation-selection",
        ));
    }
    current.as_ref().map_or(Ok(1), |selection| {
        selection
            .sequence
            .checked_add(1)
            .ok_or_else(|| error(ErrorCode::LimitExceeded, "translation-selection"))
    })
}

fn insert_selection(
    connection: &Connection,
    project: ExecutionId,
    unit: ExecutionId,
    locale: &str,
    revision: ExecutionId,
    action: ExecutionId,
    digest: &str,
    current: Option<TranslationSelection>,
    sequence: u64,
) -> Result<TranslationSelection, ExecutionError> {
    let event = ExecutionId::new();
    connection
        .execute(
            "INSERT INTO translation_selections
             (event_id,project_id,unit_id,locale,sequence,revision_id,action_id,request_digest,previous_event_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                event.to_string(),
                project.to_string(),
                unit.to_string(),
                locale,
                sequence as i64,
                revision.to_string(),
                action.to_string(),
                digest,
                current.as_ref().map(|selection| selection.event_id.to_string()),
            ],
        )
        .map_err(super::ledger::sql_error)?;
    Ok(TranslationSelection {
        event_id: event,
        unit_id: unit,
        locale: locale.to_owned(),
        sequence,
        revision_id: revision,
        action_id: action,
        previous_event_id: current.map(|selection| selection.event_id),
    })
}

pub struct TranslationAdoptionHandler;

impl AdoptionHandler for TranslationAdoptionHandler {
    fn operation(&self) -> &str {
        crate::content::TRANSLATION_OPERATION
    }

    fn apply(
        &self,
        tx: &AdoptionTransaction<'_>,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<Vec<ChangeReference>, ExecutionError> {
        if results.len() != 1 {
            return Err(error(ErrorCode::ResultMismatch, "translation-result"));
        }
        let result = &results[0];
        let output = crate::content::validate_translation_output(input, result)?;
        let entry = output
            .entry
            .ok_or_else(|| error(ErrorCode::InvalidInput, "translation-empty"))?;
        let bundle = crate::content::TranslationBundle::from_input(input)?;
        let confirmation: TranslationAdoptionConfirmation =
            crate::content::from_value(&action.parameters)?;
        if confirmation.result_digest != result.digest()
            || action.project_id != input.envelope().project_id
        {
            return Err(error(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let complete: (i64, i64) = tx.query_row(
            "SELECT COUNT(*), COALESCE(SUM(execution='succeeded' AND validation='valid'
                AND current_result_id IS NOT NULL),0)
             FROM execution_items WHERE attempt_id=?1",
            [action.attempt_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if complete.0 != input.envelope().items.len() as i64 || complete.0 != complete.1 {
            return Err(error(
                ErrorCode::DependencyConflict,
                "translation-incomplete",
            ));
        }
        let (project, locales): (String, String) = tx.query_row(
            "SELECT project_id,target_locales_json FROM project_metadata WHERE row_id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let targets: Vec<String> = serde_json::from_str(&locales)
            .map_err(|_| error(ErrorCode::CorruptLedger, "translation-project"))?;
        if project != action.project_id.to_string()
            || !targets.iter().any(|locale| locale == &bundle.target_locale)
        {
            return Err(error(ErrorCode::DependencyConflict, "translation-locale"));
        }
        let current: Option<String> = tx.query_row(
            "SELECT current_snapshot FROM content_scope WHERE row_id=1",
            [],
            |row| row.get(0),
        )?;
        if current.as_deref() != Some(&bundle.source_snapshot_id.to_string())
            || confirmation.source_snapshot_id != bundle.source_snapshot_id
        {
            return Err(error(ErrorCode::DependencyConflict, "translation-source"));
        }
        let (unit, revision, native_key, namespace): (String, String, String, String) = tx
            .query_row(
                "SELECT unit_id,revision_id,native_key,namespace FROM source_occurrences
                 WHERE occurrence_id=?1 AND snapshot_id=?2",
                rusqlite::params![
                    confirmation.occurrence_id.to_string(),
                    bundle.source_snapshot_id.to_string()
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        if unit != confirmation.target_unit_id.to_string()
            || revision != confirmation.source_revision_id.to_string()
            || !native_key.eq_ignore_ascii_case(&entry.native_key)
        {
            return Err(error(ErrorCode::DependencyConflict, "translation-match"));
        }
        let matches: i64 = tx.query_row(
            "SELECT COUNT(*) FROM source_occurrences
             WHERE snapshot_id=?1 AND namespace=?2 AND comparison_key=?3",
            rusqlite::params![
                bundle.source_snapshot_id.to_string(),
                namespace,
                entry.native_key.to_ascii_lowercase()
            ],
            |row| row.get(0),
        )?;
        if matches != 1 {
            return Err(error(
                ErrorCode::DependencyConflict,
                "translation-ambiguous",
            ));
        }
        let selected: (Option<String>, Option<i64>) = tx.query_row(
            "SELECT
               (SELECT event_id FROM translation_selections WHERE unit_id=?1 AND locale=?2
                ORDER BY sequence DESC LIMIT 1),
               (SELECT sequence FROM translation_selections WHERE unit_id=?1 AND locale=?2
                ORDER BY sequence DESC LIMIT 1)",
            rusqlite::params![unit, bundle.target_locale],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if selected.0.as_deref()
            != confirmation
                .expected_selection_id
                .map(|id| id.to_string())
                .as_deref()
            || matches!(
                confirmation.decision,
                TranslationSelectionDecision::SelectIfEmpty
            ) && selected.0.is_some()
            || matches!(confirmation.decision, TranslationSelectionDecision::Replace)
                && selected.0.is_none()
        {
            return Err(error(
                ErrorCode::DependencyConflict,
                "translation-selection",
            ));
        }
        let ordinal: i64 = tx.query_row(
            "SELECT COALESCE(MAX(ordinal),0)+1 FROM translation_revisions
             WHERE unit_id=?1 AND locale=?2",
            rusqlite::params![unit, bundle.target_locale],
            |row| row.get(0),
        )?;
        let ordinal = u64::try_from(ordinal)
            .map_err(|_| error(ErrorCode::CorruptLedger, "translation-ordinal"))?;
        let revision_id = ExecutionId::new();
        let digest = action.request_digest(input)?;
        tx.execute(
            "INSERT INTO translation_revisions
             (revision_id,project_id,unit_id,locale,ordinal,text,source_snapshot_id,
              source_revision_id,origin_kind,action_id,request_digest,attempt_id,result_id,
              item_id,artifact_id,logical_path,declared_locale,native_key,file_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'import',?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            rusqlite::params![
                revision_id.to_string(),
                project,
                unit,
                bundle.target_locale,
                ordinal as i64,
                entry.text,
                bundle.source_snapshot_id.to_string(),
                revision,
                action.action_id.to_string(),
                digest,
                action.attempt_id.to_string(),
                result.envelope().result_id.to_string(),
                result.envelope().item_id.to_string(),
                entry.artifact_id.to_string(),
                bundle.file.logical_path,
                bundle.declared_locale,
                entry.native_key,
                bundle.file.sha256,
            ],
        )?;
        let mut changes = vec![ChangeReference {
            kind: "translation-revision".into(),
            id: revision_id.to_string(),
            revision: Revision::new(ordinal)?,
        }];
        if confirmation.decision != TranslationSelectionDecision::CandidateOnly {
            let sequence = selected
                .1
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| error(ErrorCode::LimitExceeded, "translation-selection"))?;
            let event = ExecutionId::new();
            tx.execute(
                "INSERT INTO translation_selections
                 (event_id,project_id,unit_id,locale,sequence,revision_id,action_id,
                  request_digest,previous_event_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    event.to_string(),
                    project,
                    unit,
                    bundle.target_locale,
                    sequence,
                    revision_id.to_string(),
                    action.action_id.to_string(),
                    digest,
                    selected.0,
                ],
            )?;
            changes.push(ChangeReference {
                kind: "translation-selection".into(),
                id: event.to_string(),
                revision: Revision::new(sequence as u64)?,
            });
        }
        Ok(changes)
    }
}

impl ProjectStore {
    pub fn translation_preview(
        &self,
        attempt: ExecutionId,
        after: u32,
        limit: u32,
        expected_basis: Option<&str>,
    ) -> Result<TranslationPreview, ExecutionError> {
        use crate::content::{TranslationBundle, TranslationOutput, extract_translation};
        use crate::execution::ExecutionState;
        use std::collections::BTreeMap;

        if limit == 0 || limit > 100 {
            return Err(error(ErrorCode::InvalidInput, "translation-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-read"))?;
        let input = super::ledger::load_input(connection, attempt)?;
        let bundle = TranslationBundle::from_input(&input)?;
        check_target(
            connection,
            input.envelope().project_id,
            &bundle.target_locale,
        )?;
        let entries = extract_translation(&bundle, &crate::execution::Cancellation::default())?;
        if after as usize > entries.len() {
            return Err(error(ErrorCode::InvalidInput, "translation-page"));
        }
        let current = self
            .content_scope()?
            .current_snapshot
            .ok_or_else(|| error(ErrorCode::DependencyConflict, "translation-source"))?;
        let source = self.source_content(current, 0, 1)?;
        let mut matches: BTreeMap<String, Vec<(ExecutionId, ExecutionId, ExecutionId, String)>> =
            BTreeMap::new();
        let mut statement = connection
            .prepare(
                "SELECT o.occurrence_id,o.unit_id,o.revision_id,o.comparison_key,r.text
                 FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id
                 WHERE o.snapshot_id=?1 AND o.namespace=?2 ORDER BY o.ordinal",
            )
            .map_err(super::ledger::sql_error)?;
        let source_rows = statement
            .query_map(params![current.to_string(), source.namespace], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(super::ledger::sql_error)?;
        for row in source_rows {
            let (occurrence, unit, revision, key, text) = row.map_err(super::ledger::sql_error)?;
            matches
                .entry(key)
                .or_default()
                .push((id(occurrence)?, id(unit)?, id(revision)?, text));
        }

        let mut rows = Vec::with_capacity(entries.len());
        let mut result_evidence = Vec::with_capacity(input.envelope().items.len());
        let mut selection_evidence = Vec::new();
        for item in &input.envelope().items {
            let persisted: (Option<String>, String, String, String) = connection
                .query_row(
                    "SELECT current_result_id,validation,execution,adoption FROM execution_items
                     WHERE attempt_id=?1 AND item_id=?2",
                    params![attempt.to_string(), item.item_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(super::ledger::sql_error)?;
            if persisted.1 != "valid" || persisted.2 != "succeeded" {
                return Err(error(
                    ErrorCode::DependencyConflict,
                    "translation-incomplete",
                ));
            }
            let result_id = id(persisted
                .0
                .ok_or_else(|| error(ErrorCode::CorruptLedger, "translation-result"))?)?;
            let result = super::ledger::load_result(connection, &input, result_id)?;
            if result.envelope().item_id != item.item_id
                || result.envelope().outcome != ExecutionState::Succeeded
            {
                return Err(error(ErrorCode::CorruptLedger, "translation-result"));
            }
            let ordinal: Option<u32> = crate::content::from_value(&item.payload)?;
            let expected = TranslationOutput {
                version: 1,
                bundle_id: bundle.bundle_id,
                manifest_digest: bundle.manifest_digest.clone(),
                file_digest: bundle.file.sha256.clone(),
                entry_count: entries.len() as u32,
                entry: ordinal.map(|n| entries[n as usize].clone()),
            };
            let actual: TranslationOutput = crate::content::from_value(
                result
                    .envelope()
                    .output
                    .as_ref()
                    .ok_or_else(|| error(ErrorCode::CorruptLedger, "translation-result"))?,
            )?;
            if actual != expected {
                return Err(error(ErrorCode::CorruptLedger, "translation-result"));
            }
            result_evidence.push((result_id.to_string(), result.digest().to_owned()));
            let Some(entry) = expected.entry else {
                continue;
            };
            let candidates = matches.get(&entry.native_key.to_ascii_lowercase());
            let only = candidates.and_then(|rows| (rows.len() == 1).then(|| &rows[0]));
            let (selection, selected_text) =
                if let Some((_, unit, _, _)) = only {
                    let selection = current_selection(connection, *unit, &bundle.target_locale)?;
                    let text =
                        if let Some(selected) = &selection {
                            Some(connection.query_row(
                        "SELECT text FROM translation_revisions WHERE revision_id=?1",
                        [selected.revision_id.to_string()],
                        |row| row.get(0),
                    ).map_err(super::ledger::sql_error)?)
                        } else {
                            None
                        };
                    (selection, text)
                } else {
                    (None, None)
                };
            selection_evidence.push((
                entry.ordinal,
                selection.as_ref().map(|s| s.event_id.to_string()),
                persisted.3.clone(),
            ));
            let status = if persisted.3 == "committed" {
                TranslationMatch::Applied
            } else if current != bundle.source_snapshot_id {
                TranslationMatch::SourceChanged
            } else if candidates.is_none() {
                TranslationMatch::Unmatched
            } else if only.is_none() {
                TranslationMatch::Ambiguous
            } else if selection.is_some() {
                TranslationMatch::SelectedConflict
            } else {
                TranslationMatch::Unique
            };
            rows.push(TranslationPreviewRow {
                entry,
                item_id: item.item_id,
                result_id,
                result_digest: result.digest().into(),
                unit_id: only.map(|row| row.1),
                occurrence_id: only.map(|row| row.0),
                source_revision_id: only.map(|row| row.2),
                source_text: only.map(|row| row.3.clone()),
                current_selection: selection,
                current_text: selected_text,
                status,
            });
        }
        rows.sort_by_key(|row| row.entry.ordinal);
        let result_digest = request_digest(&result_evidence)?;
        let basis = request_digest(&(current, &result_evidence, &selection_evidence))?;
        if after != 0 && expected_basis != Some(basis.as_str())
            || expected_basis.is_some_and(|value| value != basis)
        {
            return Err(error(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let mut page = TranslationPreview {
            attempt_id: attempt,
            bundle_id: bundle.bundle_id,
            fixed_source_snapshot_id: bundle.source_snapshot_id,
            current_source_snapshot_id: current,
            result_digest,
            file_digest: bundle.file.sha256,
            logical_path: bundle.file.logical_path,
            declared_locale: bundle.declared_locale,
            target_locale: bundle.target_locale,
            basis,
            total: rows.len() as u32,
            unique: rows
                .iter()
                .filter(|row| row.status == TranslationMatch::Unique)
                .count() as u32,
            unmatched: rows
                .iter()
                .filter(|row| row.status == TranslationMatch::Unmatched)
                .count() as u32,
            ambiguous: rows
                .iter()
                .filter(|row| row.status == TranslationMatch::Ambiguous)
                .count() as u32,
            selected_conflicts: rows
                .iter()
                .filter(|row| row.status == TranslationMatch::SelectedConflict)
                .count() as u32,
            source_changed: if current != bundle.source_snapshot_id {
                rows.len() as u32
            } else {
                0
            },
            applied: rows
                .iter()
                .filter(|row| row.status == TranslationMatch::Applied)
                .count() as u32,
            next_ordinal: None,
            rows: Vec::new(),
        };
        for row in rows.into_iter().skip(after as usize).take(limit as usize) {
            page.rows.push(row);
            if codec::encode(&page, crate::content::MAX_CONTENT_PAGE_BYTES).is_err() {
                page.rows.pop();
                break;
            }
        }
        let next = after + page.rows.len() as u32;
        if next < page.total {
            page.next_ordinal = Some(next);
        }
        if page.rows.is_empty() && next < page.total
            || codec::encode(&page, crate::content::MAX_CONTENT_PAGE_BYTES).is_err()
        {
            return Err(error(ErrorCode::LimitExceeded, "translation-page"));
        }
        Ok(page)
    }

    pub fn translation_history(
        &self,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
        after_ordinal: u64,
        limit: u32,
    ) -> Result<TranslationHistory, ExecutionError> {
        if limit == 0 || limit > 100 || after_ordinal > i64::MAX as u64 {
            return Err(error(ErrorCode::InvalidInput, "translation-page"));
        }
        let parsed = crate::Locale::parse(locale)
            .map_err(|_| error(ErrorCode::InvalidInput, "translation-locale"))?;
        if parsed.as_str() != locale {
            return Err(error(ErrorCode::InvalidInput, "translation-locale"));
        }
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-read"))?;
        let _ = source_basis(connection, project, unit)?;
        let total: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM translation_revisions
                 WHERE project_id=?1 AND unit_id=?2 AND locale=?3",
                params![project.to_string(), unit.to_string(), locale],
                |row| row.get(0),
            )
            .map_err(super::ledger::sql_error)?;
        let current = current_selection(connection, unit, locale)?;
        let current_text = current
            .as_ref()
            .map(|selection| {
                connection
                    .query_row(
                        "SELECT text FROM translation_revisions WHERE revision_id=?1",
                        [selection.revision_id.to_string()],
                        |row| row.get(0),
                    )
                    .map_err(super::ledger::sql_error)
            })
            .transpose()?;
        let mut statement = connection
            .prepare(
                "SELECT revision_id,unit_id,locale,ordinal,text,source_snapshot_id,source_revision_id,
                        origin_kind,action_id,attempt_id,result_id,item_id,artifact_id,
                        logical_path,declared_locale,native_key,file_digest
                 FROM translation_revisions
                 WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND ordinal>?4
                 ORDER BY ordinal LIMIT ?5",
            )
            .map_err(super::ledger::sql_error)?;
        let mut rows = statement
            .query(params![
                project.to_string(),
                unit.to_string(),
                locale,
                after_ordinal as i64,
                i64::from(limit) + 1
            ])
            .map_err(super::ledger::sql_error)?;
        let mut history = TranslationHistory {
            unit_id: unit,
            locale: locale.to_owned(),
            total: u64::try_from(total)
                .map_err(|_| error(ErrorCode::CorruptLedger, "translation-total"))?,
            current,
            current_text,
            rows: Vec::new(),
            next_ordinal: None,
        };
        while let Some(row) = rows.next().map_err(super::ledger::sql_error)? {
            if history.rows.len() == limit as usize {
                history.next_ordinal = history.rows.last().map(|revision| revision.ordinal);
                break;
            }
            let raw = RawRevision::from_row(row).map_err(super::ledger::sql_error)?;
            let revision = raw.parse()?;
            if revision.unit_id != unit || revision.locale != locale {
                return Err(error(ErrorCode::CorruptLedger, "translation-scope"));
            }
            history.rows.push(revision);
            if serde_json::to_vec(&history)
                .map_err(|_| error(ErrorCode::CorruptLedger, "translation-page"))?
                .len()
                > crate::content::MAX_CONTENT_PAGE_BYTES
            {
                history.rows.pop();
                history.next_ordinal = history.rows.last().map(|revision| revision.ordinal);
                if history.rows.is_empty() {
                    return Err(error(ErrorCode::LimitExceeded, "translation-page"));
                }
                break;
            }
        }
        Ok(history)
    }

    pub fn save_translation_revision(
        &mut self,
        request: &SaveTranslationRevision,
    ) -> Result<TranslationSelection, ExecutionError> {
        if request.text.len() > 16 * 1024 {
            return Err(error(ErrorCode::LimitExceeded, "translation-text"));
        }
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "translation-session"));
        }
        let digest = request_digest(request)?;
        let unknown = self.execution_unknown.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(super::ledger::sql_error)?;
        if let Some((selection, saved_digest)) =
            selection_by_action(&transaction, request.action_id)?
        {
            return if saved_digest == digest {
                Ok(selection)
            } else {
                Err(error(ErrorCode::ResultMismatch, "translation-action"))
            };
        }
        check_target(&transaction, request.project_id, &request.locale)?;
        let (snapshot, current_source) =
            source_basis(&transaction, request.project_id, request.unit_id)?;
        if current_source != request.source_revision_id {
            return Err(error(ErrorCode::DependencyConflict, "translation-source"));
        }
        let current = current_selection(&transaction, request.unit_id, &request.locale)?;
        let next_sequence = check_expected(&current, request.expected_selection_id)?;
        let ordinal: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(ordinal),0)+1 FROM translation_revisions
                 WHERE unit_id=?1 AND locale=?2",
                params![request.unit_id.to_string(), request.locale],
                |row| row.get(0),
            )
            .map_err(super::ledger::sql_error)?;
        let revision = ExecutionId::new();
        transaction
            .execute(
                "INSERT INTO translation_revisions
                 (revision_id,project_id,unit_id,locale,ordinal,text,source_snapshot_id,source_revision_id,origin_kind,action_id,request_digest)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'manual',?9,?10)",
                params![
                    revision.to_string(),
                    request.project_id.to_string(),
                    request.unit_id.to_string(),
                    request.locale,
                    ordinal,
                    request.text,
                    snapshot.to_string(),
                    current_source.to_string(),
                    request.action_id.to_string(),
                    digest,
                ],
            )
            .map_err(super::ledger::sql_error)?;
        let selection = insert_selection(
            &transaction,
            request.project_id,
            request.unit_id,
            &request.locale,
            revision,
            request.action_id,
            &digest,
            current,
            next_sequence,
        )?;
        transaction.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            error(ErrorCode::OutcomeUnknown, "translation-commit")
        })?;
        Ok(selection)
    }

    pub fn select_translation_revision(
        &mut self,
        request: &SelectTranslationRevision,
    ) -> Result<TranslationSelection, ExecutionError> {
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "translation-session"));
        }
        let digest = request_digest(request)?;
        let unknown = self.execution_unknown.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| error(ErrorCode::StorageFailed, "translation-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(super::ledger::sql_error)?;
        if let Some((selection, saved_digest)) =
            selection_by_action(&transaction, request.action_id)?
        {
            return if saved_digest == digest {
                Ok(selection)
            } else {
                Err(error(ErrorCode::ResultMismatch, "translation-action"))
            };
        }
        check_target(&transaction, request.project_id, &request.locale)?;
        let (_, current_source) = source_basis(&transaction, request.project_id, request.unit_id)?;
        if current_source != request.source_revision_id {
            return Err(error(ErrorCode::DependencyConflict, "translation-source"));
        }
        let target: Option<String> = transaction
            .query_row(
                "SELECT project_id FROM translation_revisions
                 WHERE revision_id=?1 AND unit_id=?2 AND locale=?3",
                params![
                    request.revision_id.to_string(),
                    request.unit_id.to_string(),
                    request.locale
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(super::ledger::sql_error)?;
        if target.as_deref() != Some(&request.project_id.to_string()) {
            return Err(error(ErrorCode::DependencyConflict, "translation-revision"));
        }
        let current = current_selection(&transaction, request.unit_id, &request.locale)?;
        let next_sequence = check_expected(&current, request.expected_selection_id)?;
        let selection = insert_selection(
            &transaction,
            request.project_id,
            request.unit_id,
            &request.locale,
            request.revision_id,
            request.action_id,
            &digest,
            current,
            next_sequence,
        )?;
        transaction.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            error(ErrorCode::OutcomeUnknown, "translation-commit")
        })?;
        Ok(selection)
    }
}

struct RawRevision {
    revision_id: String,
    unit_id: String,
    locale: String,
    ordinal: i64,
    text: String,
    source_snapshot_id: String,
    source_revision_id: String,
    origin_kind: String,
    action_id: String,
    attempt_id: Option<String>,
    result_id: Option<String>,
    item_id: Option<String>,
    artifact_id: Option<String>,
    logical_path: Option<String>,
    declared_locale: Option<String>,
    native_key: Option<String>,
    file_digest: Option<String>,
}

impl RawRevision {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            revision_id: row.get(0)?,
            unit_id: row.get(1)?,
            locale: row.get(2)?,
            ordinal: row.get(3)?,
            text: row.get(4)?,
            source_snapshot_id: row.get(5)?,
            source_revision_id: row.get(6)?,
            origin_kind: row.get(7)?,
            action_id: row.get(8)?,
            attempt_id: row.get(9)?,
            result_id: row.get(10)?,
            item_id: row.get(11)?,
            artifact_id: row.get(12)?,
            logical_path: row.get(13)?,
            declared_locale: row.get(14)?,
            native_key: row.get(15)?,
            file_digest: row.get(16)?,
        })
    }

    fn parse(self) -> Result<TranslationRevision, ExecutionError> {
        Ok(TranslationRevision {
            revision_id: id(self.revision_id)?,
            unit_id: id(self.unit_id)?,
            locale: self.locale,
            ordinal: u64::try_from(self.ordinal)
                .map_err(|_| error(ErrorCode::CorruptLedger, "translation-ordinal"))?,
            text: self.text,
            source_snapshot_id: id(self.source_snapshot_id)?,
            source_revision_id: id(self.source_revision_id)?,
            origin_kind: self.origin_kind,
            action_id: id(self.action_id)?,
            attempt_id: optional_id(self.attempt_id)?,
            result_id: optional_id(self.result_id)?,
            item_id: optional_id(self.item_id)?,
            artifact_id: optional_id(self.artifact_id)?,
            logical_path: self.logical_path,
            declared_locale: self.declared_locale,
            native_key: self.native_key,
            file_digest: self.file_digest,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ProjectMetadata,
        content::{
            SourceAdoptionHandler, SourceBundle, SourceRunner, TranslationBundle,
            TranslationRunner, validate_translation_output,
        },
        execution::{ExecutionRuntime, ExecutionState},
    };
    use std::{
        process::{Command, Stdio},
        sync::Arc,
        time::{Duration, Instant},
    };

    fn project_with_source() -> (
        tempfile::TempDir,
        ProjectStore,
        Vec<crate::content::ContentRow>,
    ) {
        project_with_source_bytes(
            br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
            br#"{"first":"same","second":"same"}"#,
        )
    }

    fn project_with_source_bytes(
        manifest: &[u8],
        source: &[u8],
    ) -> (
        tempfile::TempDir,
        ProjectStore,
        Vec<crate::content::ContentRow>,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(
            temp.path().join("project"),
            ProjectMetadata::create("Translations", "en", ["ja", "zh-CN"]).unwrap(),
        )
        .unwrap();
        let bundle = SourceBundle::capture(manifest, source, "en").unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(Arc::new(SourceRunner)).unwrap();
        runtime.submit(&mut store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let result_id = loop {
            runtime.tick(&mut store).unwrap();
            let status = store
                .execution_attempt(input.envelope().attempt_id, true)
                .unwrap();
            if status.items[0].execution == ExecutionState::Succeeded {
                break store
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id,
                    )
                    .unwrap()
                    .unwrap();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        };
        let page = store
            .source_preview(input.envelope().attempt_id, result_id, 0, 10)
            .unwrap();
        let action = store
            .prepare_adoption_with_id(
                ExecutionId::new(),
                input.envelope().attempt_id,
                input.envelope().units[0].unit_id,
                vec![result_id],
                serde_json::to_value(page.confirmation).unwrap(),
            )
            .unwrap();
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        let rows = store.source_content(snapshot, 0, 10).unwrap().rows;
        (temp, store, rows)
    }

    #[test]
    fn manual_revisions_and_selection_are_immutable_idempotent_and_reopen() {
        let (temp, mut store, rows) = project_with_source();
        let project_id =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let unit = rows[0].unit_id.unwrap();
        let source = rows[0].source_revision_id.unwrap();
        let first = SaveTranslationRevision {
            project_id,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: source,
            expected_selection_id: None,
            text: String::new(),
        };
        let selected_empty = store.save_translation_revision(&first).unwrap();
        assert_eq!(
            store.save_translation_revision(&first).unwrap(),
            selected_empty
        );
        assert_eq!(
            store
                .translation_history(project_id, unit, "zh-CN", 0, 10)
                .unwrap()
                .rows[0]
                .text,
            ""
        );
        let mut reused_id = first.clone();
        reused_id.text = "other".into();
        assert_eq!(
            store
                .save_translation_revision(&reused_id)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        let second = SaveTranslationRevision {
            action_id: ExecutionId::new(),
            expected_selection_id: Some(selected_empty.event_id),
            text: "第二版".into(),
            ..first.clone()
        };
        let selected_second = store.save_translation_revision(&second).unwrap();
        let stale = SaveTranslationRevision {
            action_id: ExecutionId::new(),
            ..first.clone()
        };
        assert_eq!(
            store.save_translation_revision(&stale).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
        let history = store
            .translation_history(project_id, unit, "zh-CN", 0, 1)
            .unwrap();
        assert_eq!(history.total, 2);
        assert_eq!(history.current, Some(selected_second.clone()));
        assert_eq!(history.next_ordinal, Some(1));
        let old = history.rows[0].revision_id;
        let back = SelectTranslationRevision {
            project_id,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: source,
            expected_selection_id: Some(selected_second.event_id),
            revision_id: old,
        };
        let restored = store.select_translation_revision(&back).unwrap();
        assert_eq!(store.select_translation_revision(&back).unwrap(), restored);
        assert_eq!(restored.revision_id, old);
        assert_eq!(restored.sequence, 3);
        assert_eq!(
            store
                .translation_history(project_id, rows[1].unit_id.unwrap(), "zh-CN", 0, 10)
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            store
                .translation_history(project_id, unit, "ja", 0, 10)
                .unwrap()
                .total,
            0
        );
        store.close().unwrap();
        let store = ProjectStore::open(temp.path().join("project")).unwrap();
        let history = store
            .translation_history(project_id, unit, "zh-CN", 0, 10)
            .unwrap();
        assert_eq!(history.total, 2);
        assert_eq!(history.current, Some(restored));
        assert_eq!(
            history
                .rows
                .iter()
                .map(|row| row.text.as_str())
                .collect::<Vec<_>>(),
            vec!["", "第二版"]
        );
    }

    #[test]
    fn unrelated_edits_do_not_block_a_checked_save_and_corrupt_scope_is_rejected() {
        let (temp, mut store, rows) = project_with_source();
        let project_id =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let unit = rows[0].unit_id.unwrap();
        let source = rows[0].source_revision_id.unwrap();
        let first = SaveTranslationRevision {
            project_id,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: source,
            expected_selection_id: None,
            text: "A".into(),
        };
        let selected = store.save_translation_revision(&first).unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                action_id: ExecutionId::new(),
                unit_id: rows[1].unit_id.unwrap(),
                source_revision_id: rows[1].source_revision_id.unwrap(),
                ..first.clone()
            })
            .unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                action_id: ExecutionId::new(),
                locale: "ja".into(),
                ..first.clone()
            })
            .unwrap();
        let next = store
            .save_translation_revision(&SaveTranslationRevision {
                action_id: ExecutionId::new(),
                expected_selection_id: Some(selected.event_id),
                text: "B".into(),
                ..first
            })
            .unwrap();
        assert_eq!(next.sequence, 2);
        store.close().unwrap();

        let database = temp
            .path()
            .join("project")
            .join(super::super::DATABASE_FILENAME);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE translation_revisions SET project_id='wrong' WHERE unit_id=?1",
                [unit.to_string()],
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            ProjectStore::open(temp.path().join("project"))
                .unwrap_err()
                .code(),
            super::super::PersistenceErrorCode::CorruptProject
        );
    }

    #[test]
    fn translation_attempt_uses_fixed_bytes_and_reopens_without_the_external_file() {
        let (temp, mut store, _) = project_with_source();
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        let external = temp.path().join("zh.json");
        std::fs::write(
            &external,
            r#"{"FIRST":"你好","second":"","missing":"same"}"#.as_bytes(),
        )
        .unwrap();
        let captured = std::fs::read(&external).unwrap();
        let bundle =
            TranslationBundle::capture("i18n/zh.json", &captured, "zh-CN", snapshot).unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(Arc::new(TranslationRunner)).unwrap();
        runtime.submit(&mut store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            runtime.tick(&mut store).unwrap();
            let view = store
                .execution_attempt(input.envelope().attempt_id, true)
                .unwrap();
            if view
                .items
                .iter()
                .all(|item| item.execution == ExecutionState::Succeeded)
            {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        std::fs::write(&external, b"changed").unwrap();
        for item in &input.envelope().items {
            let result_id = store
                .execution_current_result(input.envelope().attempt_id, item.item_id)
                .unwrap()
                .unwrap();
            let result = store
                .execution_result(input.envelope().attempt_id, result_id)
                .unwrap();
            let output = validate_translation_output(&input, &result).unwrap();
            assert_eq!(output.entry_count, 3);
        }
        let writes_before = store.connection().unwrap().total_changes();
        let first = store
            .translation_preview(input.envelope().attempt_id, 0, 1, None)
            .unwrap();
        assert_eq!((first.total, first.unique, first.unmatched), (3, 2, 1));
        assert_eq!(first.rows[0].entry.text, "你好");
        assert_eq!(first.rows[0].source_text.as_deref(), Some("same"));
        assert_eq!(first.next_ordinal, Some(1));
        let second = store
            .translation_preview(input.envelope().attempt_id, 1, 1, Some(&first.basis))
            .unwrap();
        assert_eq!(second.rows[0].entry.text, "");
        assert_eq!(second.rows[0].status, TranslationMatch::Unique);
        let third = store
            .translation_preview(input.envelope().attempt_id, 2, 1, Some(&first.basis))
            .unwrap();
        assert_eq!(third.rows[0].status, TranslationMatch::Unmatched);
        assert!(third.rows[0].unit_id.is_none());
        assert_eq!(store.connection().unwrap().total_changes(), writes_before);
        let project_id =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id,
                action_id: ExecutionId::new(),
                unit_id: first.rows[0].unit_id.unwrap(),
                locale: "zh-CN".into(),
                source_revision_id: first.rows[0].source_revision_id.unwrap(),
                expected_selection_id: None,
                text: "existing".into(),
            })
            .unwrap();
        assert_eq!(
            store
                .translation_preview(input.envelope().attempt_id, 1, 1, Some(&first.basis))
                .unwrap_err()
                .stage,
            "stale-preview"
        );
        let changed = store
            .translation_preview(input.envelope().attempt_id, 0, 3, None)
            .unwrap();
        assert_eq!(changed.selected_conflicts, 1);
        assert_eq!(changed.rows[0].current_text.as_deref(), Some("existing"));
        let adopt = |store: &mut ProjectStore,
                     input: &FixedInput,
                     row: &TranslationPreviewRow,
                     decision: TranslationSelectionDecision| {
            let unit = input
                .envelope()
                .units
                .iter()
                .find(|unit| unit.item_ids == vec![row.item_id])
                .unwrap();
            let result = store
                .execution_result(input.envelope().attempt_id, row.result_id)
                .unwrap();
            store
                .prepare_adoption_with_id(
                    ExecutionId::new(),
                    input.envelope().attempt_id,
                    unit.unit_id,
                    vec![row.result_id],
                    serde_json::to_value(TranslationAdoptionConfirmation {
                        result_digest: result.digest().into(),
                        source_snapshot_id: snapshot,
                        occurrence_id: row.occurrence_id.unwrap(),
                        source_revision_id: row.source_revision_id.unwrap(),
                        target_unit_id: row.unit_id.unwrap(),
                        expected_selection_id: row.current_selection.as_ref().map(|s| s.event_id),
                        decision,
                    })
                    .unwrap(),
                )
                .unwrap()
        };
        let conflict = adopt(
            &mut store,
            &input,
            &changed.rows[0],
            TranslationSelectionDecision::SelectIfEmpty,
        );
        assert_eq!(
            store
                .adopt_execution(&conflict, &TranslationAdoptionHandler)
                .unwrap_err()
                .stage,
            "translation-selection"
        );
        let candidate = adopt(
            &mut store,
            &input,
            &changed.rows[0],
            TranslationSelectionDecision::CandidateOnly,
        );
        let candidate_receipt = store
            .adopt_execution(&candidate, &TranslationAdoptionHandler)
            .unwrap();
        assert_eq!(candidate_receipt.changes.len(), 1);
        assert_eq!(
            store
                .adopt_execution(&candidate, &TranslationAdoptionHandler)
                .unwrap(),
            candidate_receipt
        );
        let selected = adopt(
            &mut store,
            &input,
            &changed.rows[1],
            TranslationSelectionDecision::SelectIfEmpty,
        );
        let selected_receipt = store
            .adopt_execution(&selected, &TranslationAdoptionHandler)
            .unwrap();
        assert_eq!(selected_receipt.changes.len(), 2);
        assert_eq!(
            store
                .adopt_execution(&selected, &TranslationAdoptionHandler)
                .unwrap(),
            selected_receipt
        );
        let history = store
            .translation_history(project_id, changed.rows[1].unit_id.unwrap(), "zh-CN", 0, 10)
            .unwrap();
        assert_eq!(history.rows[0].text, "");
        assert_eq!(history.rows[0].origin_kind, "import");
        assert_eq!(history.rows[0].native_key.as_deref(), Some("second"));
        assert!(history.current.is_some());
        let changed = store
            .translation_preview(input.envelope().attempt_id, 0, 3, None)
            .unwrap();
        assert_eq!(changed.applied, 2);
        let replacement =
            TranslationBundle::capture("i18n/zh.json", &captured, "zh-CN", snapshot).unwrap();
        let replacement_input = replacement
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        runtime.submit(&mut store, &replacement_input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            runtime.tick(&mut store).unwrap();
            let view = store
                .execution_attempt(replacement_input.envelope().attempt_id, true)
                .unwrap();
            if view
                .items
                .iter()
                .all(|item| item.execution == ExecutionState::Succeeded)
            {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let replacement_page = store
            .translation_preview(replacement_input.envelope().attempt_id, 0, 3, None)
            .unwrap();
        assert_eq!(replacement_page.selected_conflicts, 2);
        let replace = adopt(
            &mut store,
            &replacement_input,
            &replacement_page.rows[1],
            TranslationSelectionDecision::Replace,
        );
        let replace_receipt = store
            .adopt_execution(&replace, &TranslationAdoptionHandler)
            .unwrap();
        assert_eq!(replace_receipt.changes.len(), 2);
        assert_eq!(
            store
                .adopt_execution(&replace, &TranslationAdoptionHandler)
                .unwrap(),
            replace_receipt
        );
        let replaced_history = store
            .translation_history(project_id, changed.rows[1].unit_id.unwrap(), "zh-CN", 0, 10)
            .unwrap();
        assert_eq!(replaced_history.total, 2);
        assert_eq!(replaced_history.current.unwrap().sequence, 2);
        let after_replace = store
            .translation_preview(input.envelope().attempt_id, 0, 3, None)
            .unwrap()
            .rows;
        store.close().unwrap();
        std::fs::remove_file(&external).unwrap();
        let store = ProjectStore::open(temp.path().join("project")).unwrap();
        let saved = store.execution_input(input.envelope().attempt_id).unwrap();
        assert_eq!(TranslationBundle::from_input(&saved).unwrap(), bundle);
        for item in &saved.envelope().items {
            let result_id = store
                .execution_current_result(saved.envelope().attempt_id, item.item_id)
                .unwrap()
                .unwrap();
            let result = store
                .execution_result(saved.envelope().attempt_id, result_id)
                .unwrap();
            assert_eq!(
                validate_translation_output(&saved, &result)
                    .unwrap()
                    .entry_count,
                3
            );
        }
        assert_eq!(
            store
                .translation_preview(input.envelope().attempt_id, 0, 3, None)
                .unwrap()
                .rows,
            after_replace
        );
    }

    #[test]
    fn real_translation_attempt_validates_every_saved_entry() {
        let (_temp, mut store, _) = project_with_source_bytes(
            include_bytes!("../../tests/fixtures/stardew-lookup/manifest.json"),
            include_bytes!("../../tests/fixtures/stardew-lookup/i18n/default.json"),
        );
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        let bytes = include_bytes!("../../tests/fixtures/stardew-lookup/i18n/zh.json");
        let bundle = TranslationBundle::capture("i18n/zh.json", bytes, "zh-CN", snapshot).unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(Arc::new(TranslationRunner)).unwrap();
        runtime.submit(&mut store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            runtime.tick(&mut store).unwrap();
            let valid: i64 = store.connection().unwrap().query_row(
                "SELECT COUNT(*) FROM execution_items WHERE attempt_id=?1 AND validation='valid'",
                [input.envelope().attempt_id.to_string()],
                |row| row.get(0),
            ).unwrap();
            if valid == 532 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "real translation did not complete: {valid}/532"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            store
                .execution_attempt(input.envelope().attempt_id, true)
                .unwrap()
                .items
                .len(),
            532
        );
        let preview = store
            .translation_preview(input.envelope().attempt_id, 0, 100, None)
            .unwrap();
        assert_eq!(preview.total, 532);
        assert_eq!(preview.unique, 532);
        assert_eq!(preview.unmatched, 0);
        assert_eq!(preview.rows.len(), 100);
        assert_eq!(preview.next_ordinal, Some(100));
        let oracle: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/stardew-lookup/translation-oracle.json"
        ))
        .unwrap();
        let expected = oracle["entries"].as_array().unwrap();
        let mut source_rows = Vec::new();
        let mut source_after = 0;
        loop {
            let page = store.source_content(snapshot, source_after, 100).unwrap();
            source_rows.extend(page.rows);
            if let Some(next) = page.next_ordinal {
                source_after = next;
            } else {
                break;
            }
        }
        let mut page = preview;
        let mut actual = Vec::new();
        loop {
            actual.extend(page.rows);
            if let Some(next) = page.next_ordinal {
                page = store
                    .translation_preview(input.envelope().attempt_id, next, 100, Some(&page.basis))
                    .unwrap();
            } else {
                break;
            }
        }
        assert_eq!(actual.len(), expected.len());
        for (row, expected) in actual.iter().zip(expected) {
            let source = &source_rows[expected["sourceOrdinal"].as_u64().unwrap() as usize];
            assert_eq!(row.status, TranslationMatch::Unique);
            assert_eq!(
                row.entry.ordinal as u64,
                expected["ordinal"].as_u64().unwrap()
            );
            assert_eq!(row.entry.native_key, expected["key"].as_str().unwrap());
            assert_eq!(row.entry.text, expected["text"].as_str().unwrap());
            assert_eq!(row.occurrence_id, source.occurrence_id);
            assert_eq!(row.unit_id, source.unit_id);
            assert_eq!(row.source_revision_id, source.source_revision_id);
        }
    }

    #[test]
    fn translation_adoption_crash_child() {
        let Ok(project) = std::env::var("TSUMUGI_TRANSLATION_CRASH_PROJECT") else {
            return;
        };
        let action =
            ExecutionId::parse(&std::env::var("TSUMUGI_TRANSLATION_CRASH_ACTION").unwrap())
                .unwrap();
        let mut store = ProjectStore::open(project).unwrap();
        let prepared = store.adoption_action(action).unwrap();
        let _ = store.adopt_execution(&prepared, &TranslationAdoptionHandler);
        panic!("translation crash hook did not abort");
    }

    #[test]
    fn translation_adoption_reopens_across_process_commit_boundaries() {
        for point in ["before-adoption-commit", "after-adoption-commit"] {
            let (temp, mut store, _) = project_with_source();
            let project = temp.path().join("project");
            let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
            let project_id = store.metadata().unwrap().project_id();
            let bundle = TranslationBundle::capture(
                "i18n/zh.json",
                r#"{"first":"你好"}"#.as_bytes(),
                "zh-CN",
                snapshot,
            )
            .unwrap();
            let input = bundle.fixed_input(project_id).unwrap();
            let mut runtime = ExecutionRuntime::new(&store).unwrap();
            runtime.register(Arc::new(TranslationRunner)).unwrap();
            runtime.submit(&mut store, &input).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                runtime.tick(&mut store).unwrap();
                let view = store
                    .execution_attempt(input.envelope().attempt_id, true)
                    .unwrap();
                if view.items[0].execution == ExecutionState::Succeeded {
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            let page = store
                .translation_preview(input.envelope().attempt_id, 0, 1, None)
                .unwrap();
            let row = &page.rows[0];
            let action_id = ExecutionId::new();
            store
                .prepare_adoption_with_id(
                    action_id,
                    input.envelope().attempt_id,
                    input.envelope().units[0].unit_id,
                    vec![row.result_id],
                    serde_json::to_value(TranslationAdoptionConfirmation {
                        result_digest: row.result_digest.clone(),
                        source_snapshot_id: snapshot,
                        occurrence_id: row.occurrence_id.unwrap(),
                        source_revision_id: row.source_revision_id.unwrap(),
                        target_unit_id: row.unit_id.unwrap(),
                        expected_selection_id: None,
                        decision: TranslationSelectionDecision::SelectIfEmpty,
                    })
                    .unwrap(),
                )
                .unwrap();
            store.close().unwrap();
            let hook = temp.path().join("crash-hook");
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "persistence::translation::tests::translation_adoption_crash_child",
                    "--nocapture",
                ])
                .env("TSUMUGI_TRANSLATION_CRASH_PROJECT", &project)
                .env("TSUMUGI_TRANSLATION_CRASH_ACTION", action_id.to_string())
                .env("TSUMUGI_EXECUTION_CRASH", point)
                .env("TSUMUGI_EXECUTION_HOOK", &hook)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(!status.success());
                    break;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("owned translation crash helper timed out");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(std::fs::read_to_string(&hook).unwrap(), point);
            let mut reopened = ProjectStore::open(&project).unwrap();
            let before_retry = reopened
                .translation_history(
                    ExecutionId::parse(&project_id.to_string()).unwrap(),
                    row.unit_id.unwrap(),
                    "zh-CN",
                    0,
                    10,
                )
                .unwrap();
            assert_eq!(
                before_retry.total,
                if point == "after-adoption-commit" {
                    1
                } else {
                    0
                }
            );
            assert_eq!(
                before_retry.current.is_some(),
                point == "after-adoption-commit"
            );
            assert_eq!(
                reopened.adoption_receipt(action_id).unwrap().is_some(),
                point == "after-adoption-commit"
            );
            let receipt = reopened
                .adopt_execution(
                    &reopened.adoption_action(action_id).unwrap(),
                    &TranslationAdoptionHandler,
                )
                .unwrap();
            assert_eq!(receipt.changes.len(), 2);
            let after_retry = reopened
                .translation_history(
                    ExecutionId::parse(&project_id.to_string()).unwrap(),
                    row.unit_id.unwrap(),
                    "zh-CN",
                    0,
                    10,
                )
                .unwrap();
            assert_eq!(after_retry.total, 1);
            assert_eq!(after_retry.current.unwrap().sequence, 1);
            reopened.close().unwrap();
        }
    }
}
