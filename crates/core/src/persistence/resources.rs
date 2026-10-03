//! Project-local resource facts. SQLite remains the only authority for adoption.

use super::{ProjectStore, translation::TranslationOrigin};
use crate::execution::{ErrorCode, ExecutionError, ExecutionId, MAX_INPUT_BYTES, codec};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MAX_RESOURCE_BYTES: usize = 128 * 1024;
const MAX_ENTRIES: usize = 512;
const MAX_FIELD_BYTES: usize = 16 * 1024;

fn change_targets_source(
    unit: &str,
    text: &str,
    scope: Option<&str>,
    old_scope: Option<&str>,
    phrase: Option<&str>,
    old_phrase: Option<&str>,
) -> (bool, bool) {
    let direct = scope == Some(unit) || old_scope == Some(unit);
    let lexical = (scope.is_none() && phrase.is_some_and(|p| text.contains(p)))
        || (old_scope.is_none() && old_phrase.is_some_and(|p| text.contains(p)));
    (direct, lexical)
}
pub(super) fn revision_resources_changed(
    connection: &Connection,
    revision: ExecutionId,
    unit: ExecutionId,
    locale: &str,
    text: &str,
) -> Result<bool, ExecutionError> {
    let mut statement=connection.prepare("SELECT scope_unit_id,old_scope_unit_id,source_phrase,old_source_phrase FROM resource_changes WHERE locale=?2 AND rowid>COALESCE((SELECT last_change_rowid FROM translation_resource_baselines WHERE revision_id=?1),0)").map_err(sql)?;
    let rows = statement
        .query_map(params![revision.to_string(), locale], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(sql)?;
    let unit = unit.to_string();
    for row in rows {
        let (scope, old_scope, phrase, old_phrase) = row.map_err(sql)?;
        let (direct, lexical) = change_targets_source(
            &unit,
            text,
            scope.as_deref(),
            old_scope.as_deref(),
            phrase.as_deref(),
            old_phrase.as_deref(),
        );
        if direct || lexical {
            return Ok(true);
        }
    }
    Ok(false)
}

fn failure(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(error: rusqlite::Error) -> ExecutionError {
    super::ledger::sql_error(error)
}
fn digest<T: Serialize>(value: &T) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(value, MAX_INPUT_BYTES)?))
}
fn id(raw: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&raw).map_err(|_| failure(ErrorCode::CorruptLedger, "resource-identity"))
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlossaryFile {
    pub format: String,
    pub resource_id: String,
    pub revision: String,
    pub license: String,
    pub source_locale: String,
    pub target_locale: String,
    pub entries: Vec<GlossaryEntry>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlossaryEntry {
    pub id: String,
    pub source: String,
    pub aliases: Vec<String>,
    pub target: String,
    pub protected: bool,
    pub native_key: Option<String>,
    pub reason: String,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlossaryCapture {
    pub capture_id: ExecutionId,
    pub resource_id: String,
    pub revision: String,
    pub license: String,
    pub source_locale: String,
    pub target_locale: String,
    pub digest: String,
    pub count: u32,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TermOrigin {
    Manual,
    External,
}
impl TermOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::External => "external",
        }
    }
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TmMatchKind {
    Exact,
    Fuzzy,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceImpactKind {
    Term,
    Context,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceImpactConfidence {
    ExplicitUnit,
    LiteralPossible,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceImpactStatus {
    NeedsRevalidation,
    Unresolved,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TermRevision {
    pub revision_id: ExecutionId,
    pub term_id: String,
    pub locale: String,
    pub source: String,
    pub aliases: Vec<String>,
    pub target: String,
    pub protected: bool,
    pub scope_unit_id: Option<ExecutionId>,
    pub reason: String,
    pub origin_kind: TermOrigin,
    pub capture_id: Option<ExecutionId>,
    pub external_entry_id: Option<String>,
    pub previous_revision_id: Option<ExecutionId>,
    pub removed: bool,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceChangeKind {
    Added,
    Edited,
    Removed,
    Unchanged,
    Override,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePreviewRow {
    pub entry: GlossaryEntry,
    pub kind: ResourceChangeKind,
    pub current: Option<TermRevision>,
    pub scope_unit_id: Option<ExecutionId>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePreview {
    pub capture: GlossaryCapture,
    pub rows: Vec<ResourcePreviewRow>,
    pub removed: Vec<TermRevision>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveTerm {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub term_id: Option<String>,
    pub locale: String,
    pub source: String,
    pub aliases: Vec<String>,
    pub target: String,
    pub protected: bool,
    pub scope_unit_id: Option<ExecutionId>,
    pub expected_revision_id: Option<ExecutionId>,
    pub reason: String,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceDecisionKind {
    Adopt,
    Keep,
    Ignore,
    Override,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDecision {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub capture_id: ExecutionId,
    pub entry_id: String,
    pub expected_revision_id: Option<ExecutionId>,
    pub decision: ResourceDecisionKind,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDecisionResult {
    pub action_id: ExecutionId,
    pub decision: ResourceDecisionKind,
    pub revision: Option<TermRevision>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TermResolutionEntry {
    pub source: String,
    pub selected: Option<TermRevision>,
    pub conflicting: Vec<TermRevision>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TermResolution {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub entries: Vec<TermResolutionEntry>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveContext {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub expected_revision_id: Option<ExecutionId>,
    pub text: String,
    pub reason: String,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRevision {
    pub revision_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub text: String,
    pub reason: String,
    pub previous_revision_id: Option<ExecutionId>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureContext {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub budget_bytes: u32,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextItem {
    pub kind: String,
    pub revision_id: ExecutionId,
    pub text: String,
    pub provenance: String,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextOmission {
    pub kind: String,
    pub reference: String,
    pub reason: String,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCapture {
    pub capture_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub budget_bytes: u32,
    pub included: Vec<ContextItem>,
    pub omitted: Vec<ContextOmission>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TmSuggestion {
    pub unit_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub source_text: String,
    pub translation_revision_id: ExecutionId,
    pub translation_text: String,
    pub target_locale: String,
    pub origin_kind: TranslationOrigin,
    pub is_current_selection: bool,
    pub has_human_approval: bool,
    pub match_kind: TmMatchKind,
    pub score_percent: u8,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImpactReason {
    pub change_id: ExecutionId,
    pub kind: ResourceImpactKind,
    pub old_revision_id: Option<ExecutionId>,
    pub new_revision_id: ExecutionId,
    pub old_value: Option<String>,
    pub new_value: String,
    pub new_removed: bool,
    pub confidence: ResourceImpactConfidence,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImpactItem {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub native_key: String,
    pub source_text: String,
    pub selection_event_id: ExecutionId,
    pub translation_revision_id: ExecutionId,
    pub status: ResourceImpactStatus,
    pub reasons: Vec<ImpactReason>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImpactPage {
    pub items: Vec<ImpactItem>,
    pub total_affected: u32,
    pub next_offset: Option<u32>,
    pub coverage: String,
}

fn trigrams(text: &str) -> BTreeMap<String, usize> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut result = BTreeMap::new();
    for window in chars.windows(3) {
        let gram = window.iter().collect::<String>();
        *result.entry(gram).or_insert(0) += 1;
    }
    result
}

fn fuzzy_score(left: &str, right: &str) -> u8 {
    if left == right {
        return 100;
    }
    if left.chars().count() < 4 || right.chars().count() < 4 {
        return 0;
    }
    let a = trigrams(left);
    let b = trigrams(right);
    let common = a
        .iter()
        .map(|(gram, count)| count.min(b.get(gram).unwrap_or(&0)))
        .sum::<usize>();
    let total = a.values().sum::<usize>() + b.values().sum::<usize>();
    if total == 0 {
        0
    } else {
        ((200 * common) / total) as u8
    }
}

fn validate_text(value: &str, allow_empty: bool) -> Result<(), ExecutionError> {
    if (!allow_empty && value.trim().is_empty())
        || value.as_bytes().len() > MAX_FIELD_BYTES
        || value.contains('\0')
    {
        return Err(failure(ErrorCode::InvalidInput, "resource-field"));
    }
    Ok(())
}

impl GlossaryFile {
    pub fn parse(bytes: &[u8]) -> Result<Self, ExecutionError> {
        if bytes.is_empty() || bytes.len() > MAX_RESOURCE_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "resource-file"));
        }
        let file: Self = serde_json::from_slice(bytes)
            .map_err(|_| failure(ErrorCode::InvalidInput, "resource-format"))?;
        if file.format != "tsumugi-glossary-v1" || file.entries.is_empty() {
            return Err(failure(ErrorCode::InvalidInput, "resource-format"));
        }
        if file.entries.len() > MAX_ENTRIES {
            return Err(failure(ErrorCode::LimitExceeded, "resource-entries"));
        }
        for value in [
            &file.resource_id,
            &file.revision,
            &file.license,
            &file.source_locale,
            &file.target_locale,
        ] {
            validate_text(value, false)?;
        }
        validate_identifier(&file.resource_id)?;
        validate_identifier(&file.revision)?;
        let mut ids = BTreeSet::new();
        for entry in &file.entries {
            for value in [&entry.id, &entry.source, &entry.target, &entry.reason] {
                validate_text(value, false)?;
            }
            validate_identifier(&entry.id)?;
            if let Some(key) = &entry.native_key {
                validate_text(key, false)?;
            }
            if entry.aliases.len() > 16 {
                return Err(failure(ErrorCode::LimitExceeded, "resource-aliases"));
            }
            for alias in &entry.aliases {
                validate_text(alias, false)?;
            }
            if !ids.insert(&entry.id) {
                return Err(failure(ErrorCode::InvalidInput, "resource-duplicate"));
            }
        }
        Ok(file)
    }
}

fn validate_identifier(value: &str) -> Result<(), ExecutionError> {
    if value.len() > 128
        || value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(failure(ErrorCode::InvalidInput, "resource-identifier"));
    }
    Ok(())
}

const TABLES: &[(&str, &str)] = &[
    ("resource_captures", "CREATE TABLE resource_captures (
        capture_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_revision TEXT NOT NULL,
        source_locale TEXT NOT NULL,
        target_locale TEXT NOT NULL,
        license TEXT NOT NULL,
        digest TEXT NOT NULL CHECK(length(digest)=64),
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 131072),
        action_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        UNIQUE(project_id,resource_id,resource_revision))"),
    ("term_revisions", "CREATE TABLE term_revisions (
        revision_id TEXT PRIMARY KEY NOT NULL,
        term_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        locale TEXT NOT NULL,
        source TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        target TEXT NOT NULL,
        protected INTEGER NOT NULL CHECK(protected IN (0,1)),
        scope_unit_id TEXT REFERENCES source_units(unit_id),
        reason TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK(origin_kind IN ('manual','external')),
        capture_id TEXT REFERENCES resource_captures(capture_id),
        external_entry_id TEXT,
        previous_revision_id TEXT REFERENCES term_revisions(revision_id),
        removed INTEGER NOT NULL CHECK(removed IN (0,1)),
        action_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        CHECK((origin_kind='manual' AND capture_id IS NULL AND external_entry_id IS NULL)
           OR (origin_kind='external' AND capture_id IS NOT NULL AND external_entry_id IS NOT NULL)))"),
    ("term_current", "CREATE TABLE term_current (
        term_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        revision_id TEXT NOT NULL UNIQUE REFERENCES term_revisions(revision_id),
        PRIMARY KEY(project_id,term_id))"),
    ("resource_decisions", "CREATE TABLE resource_decisions (
        action_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        capture_id TEXT NOT NULL REFERENCES resource_captures(capture_id),
        entry_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('adopt','keep','ignore','override')),
        expected_revision_id TEXT,
        result_revision_id TEXT REFERENCES term_revisions(revision_id),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64))"),
    ("context_revisions", "CREATE TABLE context_revisions (
        revision_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=16384),
        reason TEXT NOT NULL,
        previous_revision_id TEXT REFERENCES context_revisions(revision_id),
        action_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64))"),
    ("context_current", "CREATE TABLE context_current (
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES context_revisions(revision_id),
        PRIMARY KEY(unit_id,locale))"),
    ("context_captures", "CREATE TABLE context_captures (
        capture_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB))<=32768),
        action_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64))"),
    ("resource_changes", "CREATE TABLE resource_changes (
        change_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term','context')),
        locale TEXT NOT NULL,
        scope_unit_id TEXT REFERENCES source_units(unit_id),
        old_scope_unit_id TEXT REFERENCES source_units(unit_id),
        source_phrase TEXT,
        old_source_phrase TEXT,
        old_revision_id TEXT,
        new_revision_id TEXT NOT NULL,
        action_id TEXT NOT NULL UNIQUE)"),
    ("translation_resource_baselines", "CREATE TABLE translation_resource_baselines (
        revision_id TEXT PRIMARY KEY NOT NULL REFERENCES translation_revisions(revision_id),
        last_change_rowid INTEGER NOT NULL CHECK(last_change_rowid>=0))"),
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

pub(super) fn migrate_v5(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    initialize(&transaction)?;
    if transaction
        .prepare("PRAGMA foreign_key_check")?
        .exists([])?
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    transaction.pragma_update(None, "user_version", 6)?;
    #[cfg(test)]
    super::migration_crash_hook("before-resource-migration-commit");
    transaction.commit()?;
    #[cfg(test)]
    super::migration_crash_hook("after-resource-migration-commit");
    Ok(())
}

pub(super) fn validate(connection: &Connection) -> rusqlite::Result<()> {
    for (name, _) in TABLES {
        let columns: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1)",
            [name],
            |row| row.get(0),
        )?;
        if columns == 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    if connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let inconsistent: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM term_current c JOIN term_revisions r ON r.revision_id=c.revision_id
            WHERE c.project_id<>r.project_id OR c.term_id<>r.term_id
        ) OR EXISTS(
            SELECT 1 FROM context_current c JOIN context_revisions r ON r.revision_id=c.revision_id
            WHERE c.unit_id<>r.unit_id OR c.locale<>r.locale
        ) OR EXISTS(
            SELECT 1 FROM term_revisions r JOIN term_revisions p
              ON p.revision_id=r.previous_revision_id
            WHERE r.term_id<>p.term_id OR r.project_id<>p.project_id
        ) OR EXISTS(
            SELECT 1 FROM context_revisions r JOIN context_revisions p
              ON p.revision_id=r.previous_revision_id
            WHERE r.unit_id<>p.unit_id OR r.locale<>p.locale OR r.project_id<>p.project_id
        ) OR EXISTS(
            SELECT 1 FROM resource_decisions d JOIN resource_captures c
              ON c.capture_id=d.capture_id
            WHERE d.project_id<>c.project_id
        ) OR EXISTS(
            SELECT 1 FROM resource_changes x
            WHERE (x.kind='term' AND NOT EXISTS(
                SELECT 1 FROM term_revisions r WHERE r.revision_id=x.new_revision_id
                  AND r.project_id=x.project_id AND r.locale=x.locale))
               OR (x.kind='context' AND NOT EXISTS(
                SELECT 1 FROM context_revisions r WHERE r.revision_id=x.new_revision_id
                  AND r.project_id=x.project_id AND r.locale=x.locale))
        )",
        [],
        |row| row.get(0),
    )?;
    if inconsistent {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut captures =
        connection.prepare("SELECT capture_id,project_id,digest,bytes FROM resource_captures")?;
    for row in captures.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
        ))
    })? {
        let (capture_id, project_id, stored_digest, bytes) = row?;
        if codec::digest(&bytes) != stored_digest {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let capture_id = id(capture_id).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let project_id = id(project_id).map_err(|_| rusqlite::Error::InvalidQuery)?;
        capture_by_id(connection, project_id, capture_id)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
    }
    let mut fixed = connection.prepare("SELECT input_json FROM context_captures")?;
    for json in fixed.query_map([], |row| row.get::<_, String>(0))? {
        serde_json::from_str::<ContextCapture>(&json?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn drop_for_legacy_fixture(connection: &Connection) -> rusqlite::Result<()> {
    for (name, _) in TABLES.iter().rev() {
        connection.execute(&format!("DROP TABLE {name}"), [])?;
    }
    Ok(())
}

fn check_project(
    connection: &Connection,
    project_id: ExecutionId,
    target_locale: &str,
) -> Result<String, ExecutionError> {
    let metadata = super::read_metadata_from(connection)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "resource-project"))?;
    if metadata.project_id().to_string() != project_id.to_string() {
        return Err(failure(ErrorCode::Unauthorized, "resource-project"));
    }
    let locale = crate::Locale::parse(target_locale)
        .map_err(|_| failure(ErrorCode::InvalidInput, "resource-locale"))?;
    if locale.as_str() != target_locale
        || !metadata
            .target_locales()
            .iter()
            .any(|target| target.as_str() == target_locale)
    {
        return Err(failure(ErrorCode::DependencyConflict, "resource-locale"));
    }
    Ok(metadata.source_locale().as_str().to_owned())
}

fn current_snapshot(connection: &Connection) -> Result<ExecutionId, ExecutionError> {
    let snapshot: Option<String> = connection
        .query_row(
            "SELECT current_snapshot FROM content_scope WHERE row_id=1",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    snapshot
        .map(id)
        .transpose()?
        .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-source"))
}

fn check_unit(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
) -> Result<(), ExecutionError> {
    let owner: Option<String> = connection
        .query_row(
            "SELECT u.project_id FROM source_units u
             JOIN source_occurrences o ON o.unit_id=u.unit_id
             JOIN content_scope c ON c.current_snapshot=o.snapshot_id
             WHERE u.unit_id=?1",
            [unit_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    if owner.as_deref() != Some(&project_id.to_string()) {
        return Err(failure(ErrorCode::DependencyConflict, "resource-unit"));
    }
    Ok(())
}

fn unit_for_native_key(
    connection: &Connection,
    project_id: ExecutionId,
    native_key: &str,
) -> Result<ExecutionId, ExecutionError> {
    let mut statement = connection
        .prepare(
            "SELECT o.unit_id FROM source_occurrences o
             JOIN source_units u ON u.unit_id=o.unit_id
             JOIN content_scope c ON c.current_snapshot=o.snapshot_id
             WHERE o.native_key=?1 AND u.project_id=?2 LIMIT 2",
        )
        .map_err(sql)?;
    let found = statement
        .query_map(params![native_key, project_id.to_string()], |row| {
            row.get::<_, String>(0)
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    if found.len() != 1 {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "resource-native-key",
        ));
    }
    id(found[0].clone())
}

#[derive(Debug)]
struct RawTerm {
    revision_id: String,
    term_id: String,
    locale: String,
    source: String,
    aliases_json: String,
    target: String,
    protected: i64,
    scope_unit_id: Option<String>,
    reason: String,
    origin_kind: String,
    capture_id: Option<String>,
    external_entry_id: Option<String>,
    previous_revision_id: Option<String>,
    removed: i64,
}

impl RawTerm {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            revision_id: row.get(0)?,
            term_id: row.get(1)?,
            locale: row.get(2)?,
            source: row.get(3)?,
            aliases_json: row.get(4)?,
            target: row.get(5)?,
            protected: row.get(6)?,
            scope_unit_id: row.get(7)?,
            reason: row.get(8)?,
            origin_kind: row.get(9)?,
            capture_id: row.get(10)?,
            external_entry_id: row.get(11)?,
            previous_revision_id: row.get(12)?,
            removed: row.get(13)?,
        })
    }
    fn convert(self) -> Result<TermRevision, ExecutionError> {
        Ok(TermRevision {
            revision_id: id(self.revision_id)?,
            term_id: self.term_id,
            locale: self.locale,
            source: self.source,
            aliases: serde_json::from_str(&self.aliases_json)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "resource-aliases"))?,
            target: self.target,
            protected: self.protected != 0,
            scope_unit_id: self.scope_unit_id.map(id).transpose()?,
            reason: self.reason,
            origin_kind: match self.origin_kind.as_str() {
                "manual" => TermOrigin::Manual,
                "external" => TermOrigin::External,
                _ => return Err(failure(ErrorCode::CorruptLedger, "resource-origin")),
            },
            capture_id: self.capture_id.map(id).transpose()?,
            external_entry_id: self.external_entry_id,
            previous_revision_id: self.previous_revision_id.map(id).transpose()?,
            removed: self.removed != 0,
        })
    }
}

const TERM_COLUMNS: &str = "r.revision_id,r.term_id,r.locale,r.source,r.aliases_json,
    r.target,r.protected,r.scope_unit_id,r.reason,r.origin_kind,r.capture_id,
    r.external_entry_id,r.previous_revision_id,r.removed";

fn term_by_revision(
    connection: &Connection,
    project_id: ExecutionId,
    revision_id: ExecutionId,
) -> Result<Option<TermRevision>, ExecutionError> {
    let query = format!(
        "SELECT {TERM_COLUMNS} FROM term_revisions r WHERE r.project_id=?1 AND r.revision_id=?2"
    );
    connection
        .query_row(
            &query,
            params![project_id.to_string(), revision_id.to_string()],
            RawTerm::read,
        )
        .optional()
        .map_err(sql)?
        .map(RawTerm::convert)
        .transpose()
}

fn current_term(
    connection: &Connection,
    project_id: ExecutionId,
    term_id: &str,
) -> Result<Option<TermRevision>, ExecutionError> {
    let query = format!(
        "SELECT {TERM_COLUMNS} FROM term_current c JOIN term_revisions r
         ON r.revision_id=c.revision_id WHERE c.project_id=?1 AND c.term_id=?2"
    );
    connection
        .query_row(
            &query,
            params![project_id.to_string(), term_id],
            RawTerm::read,
        )
        .optional()
        .map_err(sql)?
        .map(RawTerm::convert)
        .transpose()
}

fn capture_by_id(
    connection: &Connection,
    project_id: ExecutionId,
    capture_id: ExecutionId,
) -> Result<(GlossaryCapture, GlossaryFile), ExecutionError> {
    let row: Option<(String, String, String, String, String, String, Vec<u8>)> = connection
        .query_row(
            "SELECT resource_id,resource_revision,source_locale,target_locale,license,digest,bytes
             FROM resource_captures WHERE capture_id=?1 AND project_id=?2",
            params![capture_id.to_string(), project_id.to_string()],
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
        .map_err(sql)?;
    let Some((resource_id, revision, source_locale, target_locale, license, file_digest, bytes)) =
        row
    else {
        return Err(failure(ErrorCode::DependencyConflict, "resource-capture"));
    };
    if codec::digest(&bytes) != file_digest {
        return Err(failure(ErrorCode::CorruptLedger, "resource-capture"));
    }
    let file = GlossaryFile::parse(&bytes)?;
    if file.resource_id != resource_id
        || file.revision != revision
        || file.source_locale != source_locale
        || file.target_locale != target_locale
        || file.license != license
    {
        return Err(failure(ErrorCode::CorruptLedger, "resource-capture"));
    }
    let view = GlossaryCapture {
        capture_id,
        resource_id,
        revision,
        license,
        source_locale,
        target_locale,
        digest: file_digest,
        count: file.entries.len() as u32,
    };
    Ok((view, file))
}

fn external_term_id(resource_id: &str, entry_id: &str) -> String {
    format!("external:{resource_id}:{entry_id}")
}

fn checked_aliases(aliases: &[String]) -> Result<String, ExecutionError> {
    if aliases.len() > 16 {
        return Err(failure(ErrorCode::LimitExceeded, "resource-aliases"));
    }
    for alias in aliases {
        validate_text(alias, false)?;
    }
    serde_json::to_string(aliases).map_err(|_| failure(ErrorCode::InvalidInput, "resource-aliases"))
}

fn insert_term(
    connection: &Connection,
    project_id: ExecutionId,
    term_id: &str,
    locale: &str,
    source: &str,
    aliases: &[String],
    target: &str,
    protected: bool,
    scope_unit_id: Option<ExecutionId>,
    reason: &str,
    origin_kind: &str,
    capture_id: Option<ExecutionId>,
    external_entry_id: Option<&str>,
    previous_revision_id: Option<ExecutionId>,
    removed: bool,
    action_id: ExecutionId,
    request_digest: &str,
) -> Result<TermRevision, ExecutionError> {
    let revision_id = ExecutionId::new();
    let aliases_json = checked_aliases(aliases)?;
    connection
        .execute(
            "INSERT INTO term_revisions
             (revision_id,term_id,project_id,locale,source,aliases_json,target,protected,
              scope_unit_id,reason,origin_kind,capture_id,external_entry_id,
              previous_revision_id,removed,action_id,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            params![
                revision_id.to_string(),
                term_id,
                project_id.to_string(),
                locale,
                source,
                aliases_json,
                target,
                i64::from(protected),
                scope_unit_id.map(|v| v.to_string()),
                reason,
                origin_kind,
                capture_id.map(|v| v.to_string()),
                external_entry_id,
                previous_revision_id.map(|v| v.to_string()),
                i64::from(removed),
                action_id.to_string(),
                request_digest,
            ],
        )
        .map_err(sql)?;
    connection
        .execute(
            "INSERT INTO term_current (term_id,project_id,revision_id) VALUES (?1,?2,?3)
             ON CONFLICT(project_id,term_id) DO UPDATE SET revision_id=excluded.revision_id",
            params![term_id, project_id.to_string(), revision_id.to_string()],
        )
        .map_err(sql)?;
    term_by_revision(connection, project_id, revision_id)?
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "resource-term"))
}

fn write_change(
    connection: &Connection,
    project_id: ExecutionId,
    kind: &str,
    locale: &str,
    scope_unit_id: Option<ExecutionId>,
    old_scope_unit_id: Option<ExecutionId>,
    source_phrase: Option<&str>,
    old_source_phrase: Option<&str>,
    old_revision_id: Option<ExecutionId>,
    new_revision_id: ExecutionId,
    action_id: ExecutionId,
) -> Result<(), ExecutionError> {
    connection
        .execute(
            "INSERT INTO resource_changes
             (change_id,project_id,kind,locale,scope_unit_id,old_scope_unit_id,source_phrase,
              old_source_phrase,old_revision_id,new_revision_id,action_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                ExecutionId::new().to_string(),
                project_id.to_string(),
                kind,
                locale,
                scope_unit_id.map(|value| value.to_string()),
                old_scope_unit_id.map(|value| value.to_string()),
                source_phrase,
                old_source_phrase,
                old_revision_id.map(|value| value.to_string()),
                new_revision_id.to_string(),
                action_id.to_string(),
            ],
        )
        .map_err(sql)?;
    Ok(())
}

fn source_fact(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
) -> Result<(ExecutionId, String, String, String), ExecutionError> {
    check_unit(connection, project_id, unit_id)?;
    let row: (String, String, String, String) = connection
        .query_row(
            "SELECT o.revision_id,o.namespace,o.native_key,r.text
             FROM source_occurrences o
             JOIN source_revisions r ON r.revision_id=o.revision_id
             JOIN content_scope c ON c.current_snapshot=o.snapshot_id
             WHERE o.unit_id=?1",
            [unit_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(sql)?;
    Ok((id(row.0)?, row.1, row.2, row.3))
}

pub(super) fn current_context(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
    locale: &str,
) -> Result<Option<ContextRevision>, ExecutionError> {
    let row: Option<(String, String, String, Option<String>)> = connection
        .query_row(
            "SELECT r.revision_id,r.text,r.reason,r.previous_revision_id
             FROM context_current c JOIN context_revisions r ON r.revision_id=c.revision_id
             WHERE r.project_id=?1 AND c.unit_id=?2 AND c.locale=?3",
            params![project_id.to_string(), unit_id.to_string(), locale],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(sql)?;
    row.map(|(revision_id, text, reason, previous_revision_id)| {
        Ok(ContextRevision {
            revision_id: id(revision_id)?,
            unit_id,
            locale: locale.to_owned(),
            text,
            reason,
            previous_revision_id: previous_revision_id.map(id).transpose()?,
        })
    })
    .transpose()
}

fn capture_by_action(
    connection: &Connection,
    project_id: ExecutionId,
    action_id: ExecutionId,
) -> Result<Option<(String, ContextCapture)>, ExecutionError> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT request_digest,input_json FROM context_captures
             WHERE project_id=?1 AND action_id=?2",
            params![project_id.to_string(), action_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    row.map(|(digest, json)| {
        let capture = serde_json::from_str(&json)
            .map_err(|_| failure(ErrorCode::CorruptLedger, "context-capture"))?;
        Ok((digest, capture))
    })
    .transpose()
}

impl ProjectStore {
    pub fn resource_impacts(
        &self,
        project_id: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<ImpactPage, ExecutionError> {
        if limit == 0 || limit > 100 || offset > 2_000 {
            return Err(failure(ErrorCode::InvalidInput, "impact-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "impact-read"))?;
        check_project(connection, project_id, locale)?;
        let mut changes_statement = connection
            .prepare(
                "SELECT rowid,change_id,kind,scope_unit_id,old_scope_unit_id,source_phrase,old_source_phrase,
                        old_revision_id,new_revision_id,
                        CASE kind WHEN 'term' THEN
                            (SELECT target FROM term_revisions WHERE revision_id=old_revision_id)
                          ELSE (SELECT text FROM context_revisions WHERE revision_id=old_revision_id) END,
                        CASE kind WHEN 'term' THEN
                            (SELECT target FROM term_revisions WHERE revision_id=new_revision_id)
                          ELSE (SELECT text FROM context_revisions WHERE revision_id=new_revision_id) END,
                        CASE kind WHEN 'term' THEN
                            (SELECT removed FROM term_revisions WHERE revision_id=new_revision_id)
                          ELSE 0 END
                 FROM resource_changes WHERE project_id=?1 AND locale=?2
                 ORDER BY rowid LIMIT 10001",
            )
            .map_err(sql)?;
        let changes = changes_statement
            .query_map(params![project_id.to_string(), locale], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, bool>(11)?,
                ))
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        if changes.len() > 10_000 {
            return Err(failure(ErrorCode::LimitExceeded, "impact-history-budget"));
        }
        let mut selected_statement = connection
            .prepare(
                "SELECT o.unit_id,o.revision_id,o.native_key,r.text,s.event_id,s.revision_id,
                        COALESCE(b.last_change_rowid,0)
                 FROM source_occurrences o
                 JOIN source_units u ON u.unit_id=o.unit_id
                 JOIN source_revisions r ON r.revision_id=o.revision_id
                 JOIN content_scope c ON c.current_snapshot=o.snapshot_id
                 JOIN translation_selections s ON s.unit_id=o.unit_id
                 LEFT JOIN translation_resource_baselines b ON b.revision_id=s.revision_id
                 WHERE u.project_id=?1 AND s.locale=?2
                   AND s.sequence=(SELECT MAX(x.sequence) FROM translation_selections x
                                   WHERE x.unit_id=s.unit_id AND x.locale=s.locale)
                 ORDER BY o.unit_id LIMIT 2001",
            )
            .map_err(sql)?;
        let selections = selected_statement
            .query_map(params![project_id.to_string(), locale], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        if selections.len() > 2_000 {
            return Err(failure(ErrorCode::LimitExceeded, "impact-unit-budget"));
        }
        let mut items = Vec::new();
        for (
            unit,
            source_revision,
            native_key,
            source_text,
            selection_event,
            translation_revision,
            baseline,
        ) in selections
        {
            let mut reasons = Vec::new();
            let mut uncertain = false;
            for (
                rowid,
                change_id,
                kind,
                scope_unit,
                old_scope_unit,
                source_phrase,
                old_source_phrase,
                old_revision,
                new_revision,
                old_value,
                new_value,
                new_removed,
            ) in &changes
            {
                if *rowid <= baseline {
                    continue;
                }
                let (direct, lexical) = change_targets_source(
                    &unit,
                    &source_text,
                    scope_unit.as_deref(),
                    old_scope_unit.as_deref(),
                    source_phrase.as_deref(),
                    old_source_phrase.as_deref(),
                );
                if !direct && !lexical {
                    continue;
                }
                uncertain |= lexical;
                reasons.push(ImpactReason {
                    change_id: id(change_id.clone())?,
                    kind: match kind.as_str() {
                        "term" => ResourceImpactKind::Term,
                        "context" => ResourceImpactKind::Context,
                        _ => return Err(failure(ErrorCode::CorruptLedger, "resource-change-kind")),
                    },
                    old_revision_id: old_revision.clone().map(id).transpose()?,
                    new_revision_id: id(new_revision.clone())?,
                    old_value: old_value.clone(),
                    new_value: new_value.clone(),
                    new_removed: *new_removed,
                    confidence: if direct {
                        ResourceImpactConfidence::ExplicitUnit
                    } else {
                        ResourceImpactConfidence::LiteralPossible
                    },
                });
            }
            if !reasons.is_empty() {
                items.push(ImpactItem {
                    unit_id: id(unit)?,
                    locale: locale.to_owned(),
                    source_revision_id: id(source_revision)?,
                    native_key,
                    source_text,
                    selection_event_id: id(selection_event)?,
                    translation_revision_id: id(translation_revision)?,
                    status: if uncertain {
                        ResourceImpactStatus::Unresolved
                    } else {
                        ResourceImpactStatus::NeedsRevalidation
                    },
                    reasons,
                });
            }
        }
        let total_affected = items.len() as u32;
        let next_offset =
            ((offset as usize) + (limit as usize) < items.len()).then_some(offset + limit);
        Ok(ImpactPage {
            items: items
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect(),
            total_affected,
            next_offset,
            coverage: "current-snapshot; explicit unit and literal possible matches".into(),
        })
    }

    pub fn tm_suggestions(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<TmSuggestion>, ExecutionError> {
        if limit == 0 || limit > 20 || offset > 10_000 {
            return Err(failure(ErrorCode::InvalidInput, "tm-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "tm-read"))?;
        check_project(connection, project_id, locale)?;
        let (_, _, _, current_text) = source_fact(connection, project_id, unit_id)?;
        let mut statement = connection
            .prepare(
                "SELECT r.unit_id,r.source_revision_id,s.text,r.revision_id,r.text,
                        r.origin_kind,
                        EXISTS(SELECT 1 FROM translation_selections x
                               WHERE x.unit_id=r.unit_id AND x.locale=r.locale
                                 AND x.revision_id=r.revision_id
                                 AND x.sequence=(SELECT MAX(y.sequence)
                                   FROM translation_selections y
                                   WHERE y.unit_id=r.unit_id AND y.locale=r.locale))
                 FROM translation_revisions r
                 JOIN source_revisions s ON s.revision_id=r.source_revision_id
                 WHERE r.project_id=?1 AND r.locale=?2
                 ORDER BY r.revision_id LIMIT 10001",
            )
            .map_err(sql)?;
        let rows = statement
            .query_map(params![project_id.to_string(), locale], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, bool>(6)?,
                ))
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        if rows.len() > 10_000 {
            return Err(failure(ErrorCode::LimitExceeded, "tm-index-budget"));
        }
        let mut suggestions = Vec::new();
        for (
            unit,
            source_revision,
            source_text,
            translation_revision,
            translation_text,
            origin_kind,
            is_current_selection,
        ) in rows
        {
            let score = fuzzy_score(&current_text, &source_text);
            if score < 70 {
                continue;
            }
            suggestions.push(TmSuggestion {
                unit_id: id(unit)?,
                source_revision_id: id(source_revision)?,
                source_text,
                translation_revision_id: id(translation_revision)?,
                translation_text,
                target_locale: locale.to_owned(),
                origin_kind: TranslationOrigin::from_stored(&origin_kind)?,
                is_current_selection,
                has_human_approval: false,
                match_kind: if score == 100 {
                    TmMatchKind::Exact
                } else {
                    TmMatchKind::Fuzzy
                },
                score_percent: score,
            });
        }
        suggestions.sort_by(|left, right| {
            right
                .score_percent
                .cmp(&left.score_percent)
                .then_with(|| right.is_current_selection.cmp(&left.is_current_selection))
                .then_with(|| {
                    left.translation_revision_id
                        .cmp(&right.translation_revision_id)
                })
        });
        Ok(suggestions
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect())
    }
    pub fn context_revision(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
    ) -> Result<Option<ContextRevision>, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-read"))?;
        check_project(connection, project_id, locale)?;
        check_unit(connection, project_id, unit_id)?;
        current_context(connection, project_id, unit_id, locale)
    }

    pub fn save_context(
        &mut self,
        request: &SaveContext,
    ) -> Result<ContextRevision, ExecutionError> {
        validate_text(&request.text, true)?;
        validate_text(&request.reason, false)?;
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "context-session"));
        }
        let request_digest = digest(request)?;
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let commit_observer = change_clock.observe(&tx, super::ChangeScope::Resources);
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT revision_id,request_digest FROM context_revisions WHERE action_id=?1",
                [request.action_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if let Some((revision_id, saved_digest)) = prior {
            if saved_digest != request_digest {
                return Err(failure(ErrorCode::ResultMismatch, "context-action"));
            }
            let row: (String, String, Option<String>) = tx
                .query_row(
                    "SELECT text,reason,previous_revision_id FROM context_revisions
                     WHERE revision_id=?1 AND project_id=?2",
                    params![revision_id, request.project_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(sql)?;
            return Ok(ContextRevision {
                revision_id: id(revision_id)?,
                unit_id: request.unit_id,
                locale: request.locale.clone(),
                text: row.0,
                reason: row.1,
                previous_revision_id: row.2.map(id).transpose()?,
            });
        }
        check_project(&tx, request.project_id, &request.locale)?;
        let (source_revision_id, _, _, _) = source_fact(&tx, request.project_id, request.unit_id)?;
        if source_revision_id != request.source_revision_id {
            return Err(failure(ErrorCode::DependencyConflict, "context-source"));
        }
        let current = current_context(&tx, request.project_id, request.unit_id, &request.locale)?;
        if current.as_ref().map(|value| value.revision_id) != request.expected_revision_id {
            return Err(failure(ErrorCode::DependencyConflict, "context-current"));
        }
        let revision_id = ExecutionId::new();
        tx.execute(
            "INSERT INTO context_revisions
             (revision_id,project_id,unit_id,locale,text,reason,previous_revision_id,
              action_id,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                revision_id.to_string(),
                request.project_id.to_string(),
                request.unit_id.to_string(),
                request.locale,
                request.text,
                request.reason,
                request.expected_revision_id.map(|value| value.to_string()),
                request.action_id.to_string(),
                request_digest,
            ],
        )
        .map_err(sql)?;
        tx.execute(
            "INSERT INTO context_current (unit_id,locale,revision_id) VALUES (?1,?2,?3)
             ON CONFLICT(unit_id,locale) DO UPDATE SET revision_id=excluded.revision_id",
            params![
                request.unit_id.to_string(),
                request.locale,
                revision_id.to_string()
            ],
        )
        .map_err(sql)?;
        if current
            .as_ref()
            .is_none_or(|value| value.text != request.text)
        {
            write_change(
                &tx,
                request.project_id,
                "context",
                &request.locale,
                Some(request.unit_id),
                Some(request.unit_id),
                None,
                None,
                request.expected_revision_id,
                revision_id,
                request.action_id,
            )?;
        }
        commit_observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "context-save-commit")
        })?;
        Ok(ContextRevision {
            revision_id,
            unit_id: request.unit_id,
            locale: request.locale.clone(),
            text: request.text.clone(),
            reason: request.reason.clone(),
            previous_revision_id: request.expected_revision_id,
        })
    }

    pub fn capture_context(
        &mut self,
        request: &CaptureContext,
    ) -> Result<ContextCapture, ExecutionError> {
        if request.budget_bytes == 0 || request.budget_bytes > 16 * 1024 {
            return Err(failure(ErrorCode::LimitExceeded, "context-budget"));
        }
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "context-session"));
        }
        let request_digest = digest(request)?;
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let commit_observer = change_clock.observe(&tx, super::ChangeScope::Resources);
        if let Some((stored_digest, capture)) =
            capture_by_action(&tx, request.project_id, request.action_id)?
        {
            return if stored_digest == request_digest {
                Ok(capture)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "context-action"))
            };
        }
        let resolution =
            resolve_terms_in(&tx, request.project_id, request.unit_id, &request.locale)?;
        check_project(&tx, request.project_id, &request.locale)?;
        let (source_revision, namespace, native_key, source_text) =
            source_fact(&tx, request.project_id, request.unit_id)?;
        if source_revision != request.source_revision_id
            || resolution.source_revision_id != source_revision
        {
            return Err(failure(ErrorCode::DependencyConflict, "context-source"));
        }
        let mut included = Vec::new();
        let mut omitted = Vec::new();
        let source_item = ContextItem {
            kind: "source".into(),
            revision_id: source_revision,
            text: format!("{namespace}/{native_key}: {source_text}"),
            provenance: "extracted-current-source".into(),
        };
        let mut used = source_item.text.as_bytes().len();
        if used > request.budget_bytes as usize {
            return Err(failure(ErrorCode::LimitExceeded, "context-required-source"));
        }
        included.push(source_item);
        if let Some(manual) =
            current_context(&tx, request.project_id, request.unit_id, &request.locale)?
        {
            used += manual.text.as_bytes().len();
            if used <= request.budget_bytes as usize && included.len() < 128 {
                included.push(ContextItem {
                    kind: "manual".into(),
                    revision_id: manual.revision_id,
                    text: manual.text,
                    provenance: manual.reason,
                });
            } else {
                used -= manual.text.as_bytes().len();
                omitted.push(ContextOmission {
                    kind: "manual".into(),
                    reference: manual.revision_id.to_string(),
                    reason: if included.len() >= 128 {
                        "item-cap"
                    } else {
                        "budget"
                    }
                    .into(),
                });
            }
        }
        for item in resolution.entries {
            if let Some(term) = item.selected {
                let current = current_term(&tx, request.project_id, &term.term_id)?;
                if current.as_ref().map(|value| value.revision_id) != Some(term.revision_id) {
                    return Err(failure(ErrorCode::DependencyConflict, "context-term"));
                }
                let text = format!("{} → {}", term.source, term.target);
                if used + text.as_bytes().len() <= request.budget_bytes as usize
                    && included.len() < 128
                {
                    used += text.as_bytes().len();
                    included.push(ContextItem {
                        kind: "term".into(),
                        revision_id: term.revision_id,
                        text,
                        provenance: term.origin_kind.as_str().into(),
                    });
                } else {
                    omitted.push(ContextOmission {
                        kind: "term".into(),
                        reference: term.revision_id.to_string(),
                        reason: if included.len() >= 128 {
                            "item-cap"
                        } else {
                            "budget"
                        }
                        .into(),
                    });
                }
            } else {
                omitted.push(ContextOmission {
                    kind: "term".into(),
                    reference: item.source,
                    reason: "conflict".into(),
                });
            }
        }
        let capture = ContextCapture {
            capture_id: ExecutionId::new(),
            unit_id: request.unit_id,
            locale: request.locale.clone(),
            source_revision_id: source_revision,
            budget_bytes: request.budget_bytes,
            included,
            omitted,
        };
        let json = serde_json::to_string(&capture)
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-encode"))?;
        if json.as_bytes().len() > 32 * 1024 {
            return Err(failure(ErrorCode::LimitExceeded, "context-capture"));
        }
        tx.execute(
            "INSERT INTO context_captures
             (capture_id,project_id,unit_id,locale,source_revision_id,input_json,
              action_id,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                capture.capture_id.to_string(),
                request.project_id.to_string(),
                request.unit_id.to_string(),
                request.locale,
                source_revision.to_string(),
                json,
                request.action_id.to_string(),
                request_digest,
            ],
        )
        .map_err(sql)?;
        commit_observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "context-capture-commit")
        })?;
        Ok(capture)
    }

    pub fn read_context_capture(
        &self,
        project_id: ExecutionId,
        capture_id: ExecutionId,
    ) -> Result<ContextCapture, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "context-read"))?;
        let json: Option<String> = connection
            .query_row(
                "SELECT input_json FROM context_captures
                 WHERE project_id=?1 AND capture_id=?2",
                params![project_id.to_string(), capture_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        serde_json::from_str(
            &json.ok_or_else(|| failure(ErrorCode::DependencyConflict, "context-capture"))?,
        )
        .map_err(|_| failure(ErrorCode::CorruptLedger, "context-capture"))
    }
    pub fn capture_glossary(
        &mut self,
        project_id: ExecutionId,
        action_id: ExecutionId,
        bytes: &[u8],
    ) -> Result<GlossaryCapture, ExecutionError> {
        let file = GlossaryFile::parse(bytes)?;
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "resource-session"));
        }
        let file_digest = codec::digest(bytes);
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let commit_observer = change_clock.observe(&tx, super::ChangeScope::Resources);
        let source_locale = check_project(&tx, project_id, &file.target_locale)?;
        if source_locale != file.source_locale {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "resource-source-locale",
            ));
        }
        current_snapshot(&tx)?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT capture_id FROM resource_captures WHERE action_id=?1",
                [action_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        if let Some(prior) = prior {
            let (capture, _) = capture_by_id(&tx, project_id, id(prior)?)?;
            return if capture.digest == file_digest {
                Ok(capture)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "resource-action"))
            };
        }
        let conflicting: Option<(String, String)> = tx
            .query_row(
                "SELECT capture_id,digest FROM resource_captures
                 WHERE project_id=?1 AND resource_id=?2 AND resource_revision=?3",
                params![project_id.to_string(), file.resource_id, file.revision],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if let Some((capture_id, digest)) = conflicting {
            return if digest == file_digest {
                Ok(capture_by_id(&tx, project_id, id(capture_id)?)?.0)
            } else {
                Err(failure(ErrorCode::DependencyConflict, "resource-revision"))
            };
        }
        let capture_id = ExecutionId::new();
        let request_digest = digest(&(project_id, action_id, &file_digest))?;
        tx.execute(
            "INSERT INTO resource_captures
             (capture_id,project_id,resource_id,resource_revision,source_locale,target_locale,
              license,digest,bytes,action_id,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                capture_id.to_string(),
                project_id.to_string(),
                file.resource_id,
                file.revision,
                file.source_locale,
                file.target_locale,
                file.license,
                file_digest,
                bytes,
                action_id.to_string(),
                request_digest,
            ],
        )
        .map_err(sql)?;
        commit_observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "resource-capture-commit")
        })?;
        Ok(GlossaryCapture {
            capture_id,
            resource_id: file.resource_id,
            revision: file.revision,
            license: file.license,
            source_locale: file.source_locale,
            target_locale: file.target_locale,
            digest: file_digest,
            count: file.entries.len() as u32,
        })
    }

    pub fn list_glossary_captures(
        &self,
        project_id: ExecutionId,
        limit: u32,
    ) -> Result<Vec<GlossaryCapture>, ExecutionError> {
        if limit == 0 || limit > 100 {
            return Err(failure(ErrorCode::InvalidInput, "resource-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?;
        let project: Option<String> = connection
            .query_row(
                "SELECT project_id FROM project_metadata WHERE project_id=?1",
                [project_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql)?;
        if project.is_none() {
            return Err(failure(ErrorCode::DependencyConflict, "resource-project"));
        }
        let mut statement = connection
            .prepare(
                "SELECT capture_id,resource_id,resource_revision,license,source_locale,
                    target_locale,digest,bytes
             FROM resource_captures WHERE project_id=?1 ORDER BY rowid DESC LIMIT ?2",
            )
            .map_err(sql)?;
        statement
            .query_map(params![project_id.to_string(), i64::from(limit)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Vec<u8>>(7)?,
                ))
            })
            .map_err(sql)?
            .map(|result| {
                let (
                    capture_id,
                    resource_id,
                    revision,
                    license,
                    source_locale,
                    target_locale,
                    digest,
                    bytes,
                ) = result.map_err(sql)?;
                let count = GlossaryFile::parse(&bytes)?.entries.len() as u32;
                Ok(GlossaryCapture {
                    capture_id: id(capture_id)?,
                    resource_id,
                    revision,
                    license,
                    source_locale,
                    target_locale,
                    digest,
                    count,
                })
            })
            .collect()
    }

    pub fn glossary_preview(
        &self,
        project_id: ExecutionId,
        capture_id: ExecutionId,
    ) -> Result<ResourcePreview, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?;
        let (capture, file) = capture_by_id(connection, project_id, capture_id)?;
        check_project(connection, project_id, &file.target_locale)?;
        current_snapshot(connection)?;
        let mut incoming = BTreeSet::new();
        let mut rows = Vec::with_capacity(file.entries.len());
        for entry in file.entries {
            incoming.insert(entry.id.clone());
            let scope_unit_id = entry
                .native_key
                .as_deref()
                .map(|key| unit_for_native_key(connection, project_id, key))
                .transpose()?;
            let current = current_term(
                connection,
                project_id,
                &external_term_id(&file.resource_id, &entry.id),
            )?;
            let kind = match &current {
                None => ResourceChangeKind::Added,
                Some(value) if value.origin_kind == TermOrigin::Manual => {
                    ResourceChangeKind::Override
                }
                Some(value)
                    if value.source == entry.source
                        && value.aliases == entry.aliases
                        && value.target == entry.target
                        && value.protected == entry.protected
                        && value.scope_unit_id == scope_unit_id
                        && !value.removed =>
                {
                    ResourceChangeKind::Unchanged
                }
                _ => ResourceChangeKind::Edited,
            };
            rows.push(ResourcePreviewRow {
                entry,
                kind,
                current,
                scope_unit_id,
            });
        }
        let mut removed = Vec::new();
        let query = format!(
            "SELECT {TERM_COLUMNS} FROM term_current c JOIN term_revisions r
             ON r.revision_id=c.revision_id
             WHERE c.project_id=?1 AND r.capture_id IS NOT NULL
             AND substr(r.term_id,1,length(?2))=?2"
        );
        let prefix = format!("external:{}:", file.resource_id);
        let mut statement = connection.prepare(&query).map_err(sql)?;
        let old = statement
            .query_map(params![project_id.to_string(), prefix], RawTerm::read)
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        for raw in old {
            let value = raw.convert()?;
            if let Some(entry_id) = &value.external_entry_id {
                if !incoming.contains(entry_id) && !value.removed {
                    removed.push(value);
                }
            }
        }
        Ok(ResourcePreview {
            capture,
            rows,
            removed,
        })
    }

    pub fn save_term(&mut self, request: &SaveTerm) -> Result<TermRevision, ExecutionError> {
        for value in [&request.source, &request.target, &request.reason] {
            validate_text(value, false)?;
        }
        checked_aliases(&request.aliases)?;
        if let Some(term_id) = &request.term_id {
            validate_text(term_id, false)?;
        }
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "resource-session"));
        }
        let request_digest = digest(request)?;
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let commit_observer = change_clock.observe(&tx, super::ChangeScope::Resources);
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT revision_id,request_digest FROM term_revisions WHERE action_id=?1",
                [request.action_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if let Some((existing, saved_digest)) = existing {
            let revision = term_by_revision(&tx, request.project_id, id(existing)?)?
                .ok_or_else(|| failure(ErrorCode::ResultMismatch, "resource-action"))?;
            return if saved_digest == request_digest {
                Ok(revision)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "resource-action"))
            };
        }
        check_project(&tx, request.project_id, &request.locale)?;
        current_snapshot(&tx)?;
        if let Some(scope) = request.scope_unit_id {
            check_unit(&tx, request.project_id, scope)?;
        }
        let term_id = request
            .term_id
            .clone()
            .unwrap_or_else(|| ExecutionId::new().to_string());
        let current = current_term(&tx, request.project_id, &term_id)?;
        if request.term_id.is_some() && current.is_none() {
            return Err(failure(ErrorCode::DependencyConflict, "resource-term"));
        }
        if current
            .as_ref()
            .is_some_and(|term| term.locale != request.locale)
        {
            return Err(failure(ErrorCode::DependencyConflict, "resource-locale"));
        }
        if current.as_ref().map(|value| value.revision_id) != request.expected_revision_id {
            return Err(failure(ErrorCode::DependencyConflict, "resource-current"));
        }
        let revision = insert_term(
            &tx,
            request.project_id,
            &term_id,
            &request.locale,
            &request.source,
            &request.aliases,
            &request.target,
            request.protected,
            request.scope_unit_id,
            &request.reason,
            "manual",
            None,
            None,
            request.expected_revision_id,
            false,
            request.action_id,
            &request_digest,
        )?;
        if current.as_ref().is_none_or(|value| {
            value.source != revision.source
                || value.aliases != revision.aliases
                || value.target != revision.target
                || value.protected != revision.protected
                || value.scope_unit_id != revision.scope_unit_id
                || value.removed
        }) {
            write_change(
                &tx,
                request.project_id,
                "term",
                &request.locale,
                request.scope_unit_id,
                current.as_ref().and_then(|value| value.scope_unit_id),
                Some(&request.source),
                current.as_ref().map(|value| value.source.as_str()),
                request.expected_revision_id,
                revision.revision_id,
                request.action_id,
            )?;
        }
        commit_observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "resource-save-commit")
        })?;
        Ok(revision)
    }

    pub fn decide_glossary_entry(
        &mut self,
        request: &ResourceDecision,
    ) -> Result<ResourceDecisionResult, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "resource-session"));
        }
        let request_digest = digest(request)?;
        let change_clock = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let commit_observer = change_clock.observe(&tx, super::ChangeScope::Resources);
        let prior: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT request_digest,result_revision_id FROM resource_decisions
                 WHERE action_id=?1 AND project_id=?2",
                params![
                    request.action_id.to_string(),
                    request.project_id.to_string()
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if let Some((saved_digest, revision_id)) = prior {
            if saved_digest != request_digest {
                return Err(failure(ErrorCode::ResultMismatch, "resource-action"));
            }
            let revision = revision_id
                .map(id)
                .transpose()?
                .map(|revision_id| term_by_revision(&tx, request.project_id, revision_id))
                .transpose()?
                .flatten();
            return Ok(ResourceDecisionResult {
                action_id: request.action_id,
                decision: request.decision.clone(),
                revision,
            });
        }
        let (_, file) = capture_by_id(&tx, request.project_id, request.capture_id)?;
        check_project(&tx, request.project_id, &file.target_locale)?;
        current_snapshot(&tx)?;
        let term_id = external_term_id(&file.resource_id, &request.entry_id);
        let current = current_term(&tx, request.project_id, &term_id)?;
        if current.as_ref().map(|value| value.revision_id) != request.expected_revision_id {
            return Err(failure(ErrorCode::DependencyConflict, "resource-current"));
        }
        let incoming = file
            .entries
            .iter()
            .find(|entry| entry.id == request.entry_id);
        if incoming.is_none() && current.is_none() {
            return Err(failure(ErrorCode::DependencyConflict, "resource-entry"));
        }
        if current
            .as_ref()
            .is_some_and(|value| value.origin_kind == TermOrigin::Manual)
            && matches!(request.decision, ResourceDecisionKind::Adopt)
        {
            return Err(failure(ErrorCode::DependencyConflict, "resource-override"));
        }
        let revision = if matches!(
            request.decision,
            ResourceDecisionKind::Keep | ResourceDecisionKind::Ignore
        ) {
            current
        } else {
            let scope = if let Some(entry) = incoming {
                entry
                    .native_key
                    .as_deref()
                    .map(|key| unit_for_native_key(&tx, request.project_id, key))
                    .transpose()?
            } else {
                current.as_ref().and_then(|value| value.scope_unit_id)
            };
            let source = incoming
                .map(|entry| entry.source.as_str())
                .or_else(|| current.as_ref().map(|value| value.source.as_str()))
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-entry"))?;
            let target = incoming
                .map(|entry| entry.target.as_str())
                .or_else(|| current.as_ref().map(|value| value.target.as_str()))
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-entry"))?;
            let aliases = incoming
                .map(|entry| entry.aliases.as_slice())
                .or_else(|| current.as_ref().map(|value| value.aliases.as_slice()))
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-entry"))?;
            let reason = incoming
                .map(|entry| entry.reason.as_str())
                .unwrap_or("Removed from external resource");
            let protected = incoming
                .map(|entry| entry.protected)
                .or_else(|| current.as_ref().map(|value| value.protected))
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "resource-entry"))?;
            let changed = current.as_ref().is_none_or(|value| {
                value.source != source
                    || value.target != target
                    || value.aliases != aliases
                    || value.protected != protected
                    || value.scope_unit_id != scope
                    || value.removed != incoming.is_none()
            });
            let revision = insert_term(
                &tx,
                request.project_id,
                &term_id,
                &file.target_locale,
                source,
                aliases,
                target,
                protected,
                scope,
                reason,
                "external",
                Some(request.capture_id),
                Some(&request.entry_id),
                request.expected_revision_id,
                incoming.is_none(),
                request.action_id,
                &request_digest,
            )?;
            if changed {
                write_change(
                    &tx,
                    request.project_id,
                    "term",
                    &file.target_locale,
                    scope,
                    current.as_ref().and_then(|value| value.scope_unit_id),
                    Some(source),
                    current.as_ref().map(|value| value.source.as_str()),
                    request.expected_revision_id,
                    revision.revision_id,
                    request.action_id,
                )?;
            }
            Some(revision)
        };
        tx.execute(
            "INSERT INTO resource_decisions
             (action_id,project_id,capture_id,entry_id,decision,expected_revision_id,
              result_revision_id,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                request.action_id.to_string(),
                request.project_id.to_string(),
                request.capture_id.to_string(),
                request.entry_id,
                match request.decision {
                    ResourceDecisionKind::Adopt => "adopt",
                    ResourceDecisionKind::Keep => "keep",
                    ResourceDecisionKind::Ignore => "ignore",
                    ResourceDecisionKind::Override => "override",
                },
                request.expected_revision_id.map(|value| value.to_string()),
                revision.as_ref().map(|value| value.revision_id.to_string()),
                request_digest,
            ],
        )
        .map_err(sql)?;
        #[cfg(test)]
        super::migration_crash_hook("before-resource-decision-commit");
        commit_observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "resource-decision-commit")
        })?;
        #[cfg(test)]
        super::migration_crash_hook("after-resource-decision-commit");
        Ok(ResourceDecisionResult {
            action_id: request.action_id,
            decision: request.decision.clone(),
            revision,
        })
    }

    pub fn list_terms(
        &self,
        project_id: ExecutionId,
        locale: &str,
        after_term_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<TermRevision>, ExecutionError> {
        if limit == 0 || limit > 100 {
            return Err(failure(ErrorCode::InvalidInput, "resource-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?;
        check_project(connection, project_id, locale)?;
        let query = format!(
            "SELECT {TERM_COLUMNS} FROM term_current c JOIN term_revisions r
             ON r.revision_id=c.revision_id
             WHERE c.project_id=?1 AND r.locale=?2 AND c.term_id>?3
             ORDER BY c.term_id LIMIT ?4"
        );
        let mut statement = connection.prepare(&query).map_err(sql)?;
        statement
            .query_map(
                params![
                    project_id.to_string(),
                    locale,
                    after_term_id.unwrap_or(""),
                    i64::from(limit),
                ],
                RawTerm::read,
            )
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?
            .into_iter()
            .map(RawTerm::convert)
            .collect()
    }

    pub fn term_history(
        &self,
        project_id: ExecutionId,
        term_id: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<TermRevision>, ExecutionError> {
        if limit == 0 || limit > 100 || term_id.is_empty() {
            return Err(failure(ErrorCode::InvalidInput, "resource-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?;
        let query = format!(
            "SELECT {TERM_COLUMNS} FROM term_revisions r
             WHERE r.project_id=?1 AND r.term_id=?2
             ORDER BY r.rowid LIMIT ?3 OFFSET ?4"
        );
        let mut statement = connection.prepare(&query).map_err(sql)?;
        statement
            .query_map(
                params![
                    project_id.to_string(),
                    term_id,
                    i64::from(limit),
                    i64::from(offset)
                ],
                RawTerm::read,
            )
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?
            .into_iter()
            .map(RawTerm::convert)
            .collect()
    }

    pub fn resolve_terms(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
    ) -> Result<TermResolution, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "resource-read"))?;
        resolve_terms_in(connection, project_id, unit_id, locale)
    }
}

pub(super) fn resolve_terms_in(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
    locale: &str,
) -> Result<TermResolution, ExecutionError> {
    check_project(connection, project_id, locale)?;
    check_unit(connection, project_id, unit_id)?;
    let (source_revision, source_text): (String, String) = connection
        .query_row(
            "SELECT o.revision_id,r.text FROM source_occurrences o
                 JOIN source_revisions r ON r.revision_id=o.revision_id
                 JOIN content_scope c ON c.current_snapshot=o.snapshot_id
                 WHERE o.unit_id=?1",
            [unit_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sql)?;
    let query = format!(
        "SELECT {TERM_COLUMNS} FROM term_current c JOIN term_revisions r
             ON r.revision_id=c.revision_id
             WHERE c.project_id=?1 AND r.locale=?2 AND r.removed=0
             AND (r.scope_unit_id IS NULL OR r.scope_unit_id=?3)"
    );
    let mut statement = connection.prepare(&query).map_err(sql)?;
    let all = statement
        .query_map(
            params![project_id.to_string(), locale, unit_id.to_string()],
            RawTerm::read,
        )
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let terms = all
        .into_iter()
        .map(RawTerm::convert)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(resolve_terms_from(
        unit_id,
        locale,
        id(source_revision)?,
        &source_text,
        &terms,
    ))
}

/// Load the current terminology once for a bounded query, never its revision history.
pub(super) fn current_terms_in(
    connection: &Connection,
    project_id: ExecutionId,
    locale: &str,
) -> Result<Vec<TermRevision>, ExecutionError> {
    let query = format!(
        "SELECT {TERM_COLUMNS} FROM term_current c JOIN term_revisions r
        ON r.revision_id=c.revision_id WHERE c.project_id=?1 AND r.locale=?2 AND r.removed=0"
    );
    let mut statement = connection.prepare(&query).map_err(sql)?;
    let rows = statement
        .query_map(params![project_id.to_string(), locale], RawTerm::read)
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    rows.into_iter().map(RawTerm::convert).collect()
}

/// The same matching and precedence rules serve individual reads and summary pages.
pub(super) fn resolve_terms_from(
    unit_id: ExecutionId,
    locale: &str,
    source_revision_id: ExecutionId,
    source_text: &str,
    terms: &[TermRevision],
) -> TermResolution {
    let mut grouped: BTreeMap<String, Vec<TermRevision>> = BTreeMap::new();
    for term in terms {
        if term.scope_unit_id.is_some_and(|scope| scope != unit_id) {
            continue;
        }
        if term.scope_unit_id == Some(unit_id)
            || source_text.contains(&term.source)
            || term.aliases.iter().any(|alias| source_text.contains(alias))
        {
            grouped
                .entry(term.source.clone())
                .or_default()
                .push(term.clone());
        }
    }
    let mut entries = Vec::new();
    for (source, mut matches) in grouped {
        matches.sort_by(|left, right| left.term_id.cmp(&right.term_id));
        let specific = matches
            .iter()
            .any(|value| value.scope_unit_id == Some(unit_id));
        if specific {
            matches.retain(|value| value.scope_unit_id == Some(unit_id));
        }
        let overridden = matches.iter().any(|value| {
            value.origin_kind == TermOrigin::Manual && value.term_id.starts_with("external:")
        });
        if overridden {
            matches.retain(|value| {
                value.origin_kind == TermOrigin::Manual && value.term_id.starts_with("external:")
            });
        }
        let unique_targets = matches
            .iter()
            .map(|value| (&value.target, value.protected))
            .collect::<BTreeSet<_>>();
        let (selected, conflicting) = if unique_targets.len() == 1 {
            (matches.into_iter().next(), Vec::new())
        } else {
            (None, matches)
        };
        entries.push(TermResolutionEntry {
            source,
            selected,
            conflicting,
        });
    }
    TermResolution {
        unit_id,
        locale: locale.to_owned(),
        source_revision_id,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ProjectMetadata, SaveTranslationRevision,
        content::{SourceAdoptionHandler, SourceBundle, SourceRunner},
        execution::{ExecutionRuntime, ExecutionState},
    };
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    fn fixture_project() -> (tempfile::TempDir, ProjectStore, ExecutionId) {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(
            temp.path().join("project"),
            ProjectMetadata::create("Resources", "en", ["zh-CN", "fr-FR"]).unwrap(),
        )
        .unwrap();
        let project_id =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let bundle = SourceBundle::capture(
            include_bytes!("../../tests/fixtures/stardew-lookup/manifest.json"),
            include_bytes!("../../tests/fixtures/stardew-lookup/i18n/default.json"),
            "en",
        )
        .unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(Arc::new(SourceRunner)).unwrap();
        runtime.submit(&mut store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let result_id = loop {
            runtime.tick(&mut store).unwrap();
            if store
                .execution_attempt(input.envelope().attempt_id, true)
                .unwrap()
                .items[0]
                .execution
                == ExecutionState::Succeeded
            {
                break store
                    .execution_current_result(
                        input.envelope().attempt_id,
                        input.envelope().items[0].item_id,
                    )
                    .unwrap()
                    .unwrap();
            }
            assert!(Instant::now() < deadline, "source fixture did not finish");
            std::thread::sleep(Duration::from_millis(2));
        };
        let preview = store
            .source_preview(input.envelope().attempt_id, result_id, 0, 1)
            .unwrap();
        let action = store
            .prepare_adoption_with_id(
                ExecutionId::new(),
                input.envelope().attempt_id,
                input.envelope().units[0].unit_id,
                vec![result_id],
                serde_json::to_value(preview.confirmation).unwrap(),
            )
            .unwrap();
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        (temp, store, project_id)
    }

    fn unit(store: &ProjectStore, project_id: ExecutionId, key: &str) -> ExecutionId {
        unit_for_native_key(store.connection().unwrap(), project_id, key).unwrap()
    }

    fn selected_translation(
        store: &mut ProjectStore,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        text: &str,
    ) {
        let (source_revision_id, _, _, _) =
            source_fact(store.connection().unwrap(), project_id, unit_id).unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id,
                action_id: ExecutionId::new(),
                unit_id,
                locale: locale.into(),
                source_revision_id,
                expected_selection_id: None,
                text: text.into(),
            })
            .unwrap();
    }

    #[test]
    fn local_updates_keep_adoption_separate_and_target_only_related_work() {
        let (temp, mut store, project_id) = fixture_project();
        let g1 = include_bytes!("../../tests/fixtures/resource-updates/g1.json");
        let g2 = include_bytes!("../../tests/fixtures/resource-updates/g2.json");
        let capture_action = ExecutionId::new();
        let first = store
            .capture_glossary(project_id, capture_action, g1)
            .unwrap();
        assert_eq!(
            store
                .capture_glossary(project_id, ExecutionId::new(), g1)
                .unwrap(),
            first
        );
        assert_eq!(
            store.list_glossary_captures(project_id, 100).unwrap(),
            vec![first.clone()]
        );
        assert_eq!(
            store
                .capture_glossary(project_id, capture_action, g1)
                .unwrap(),
            first
        );
        assert_eq!(
            store
                .capture_glossary(project_id, capture_action, g2)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
        let preview = store
            .glossary_preview(project_id, first.capture_id)
            .unwrap();
        assert_eq!(preview.rows.len(), 3);
        assert!(
            preview
                .rows
                .iter()
                .all(|row| row.kind == ResourceChangeKind::Added)
        );
        for row in preview.rows {
            let request = ResourceDecision {
                project_id,
                action_id: ExecutionId::new(),
                capture_id: first.capture_id,
                entry_id: row.entry.id,
                expected_revision_id: None,
                decision: ResourceDecisionKind::Adopt,
            };
            let result = store.decide_glossary_entry(&request).unwrap();
            assert_eq!(store.decide_glossary_entry(&request).unwrap(), result);
        }
        let barrel = unit(&store, project_id, "data.item.barrel.name");
        let box_unit = unit(&store, project_id, "data.item.box.name");
        let now_unit = unit(&store, project_id, "generic.now");
        selected_translation(&mut store, project_id, barrel, "zh-CN", "桶");
        selected_translation(&mut store, project_id, box_unit, "zh-CN", "箱");
        selected_translation(&mut store, project_id, now_unit, "zh-CN", "此刻");
        selected_translation(&mut store, project_id, barrel, "fr-FR", "Tonneau");
        let second = store
            .capture_glossary(project_id, ExecutionId::new(), g2)
            .unwrap();
        let preview = store
            .glossary_preview(project_id, second.capture_id)
            .unwrap();
        let kinds = preview
            .rows
            .iter()
            .map(|row| (row.entry.id.as_str(), &row.kind))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(kinds["barrel"], &ResourceChangeKind::Edited);
        assert_eq!(kinds["box"], &ResourceChangeKind::Unchanged);
        assert_eq!(kinds["tomorrow"], &ResourceChangeKind::Added);
        assert_eq!(
            preview
                .removed
                .iter()
                .map(|term| term.external_entry_id.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("now")]
        );
        assert_eq!(
            store
                .resolve_terms(project_id, barrel, "zh-CN")
                .unwrap()
                .entries[0]
                .selected
                .as_ref()
                .unwrap()
                .target,
            "桶"
        );
        let barrel_row = preview
            .rows
            .iter()
            .find(|row| row.entry.id == "barrel")
            .unwrap();
        let decision = ResourceDecision {
            project_id,
            action_id: ExecutionId::new(),
            capture_id: second.capture_id,
            entry_id: "barrel".into(),
            expected_revision_id: barrel_row.current.as_ref().map(|term| term.revision_id),
            decision: ResourceDecisionKind::Adopt,
        };
        store.decide_glossary_entry(&decision).unwrap();
        let impacts = store.resource_impacts(project_id, "zh-CN", 0, 100).unwrap();
        let affected = impacts
            .items
            .iter()
            .map(|item| item.native_key.as_str())
            .collect::<Vec<_>>();
        assert_eq!(affected, vec!["data.item.barrel.name"]);
        assert_eq!(impacts.items[0].reasons[0].old_value.as_deref(), Some("桶"));
        assert_eq!(impacts.items[0].reasons[0].new_value, "木桶");
        let removed = preview
            .removed
            .iter()
            .find(|term| term.external_entry_id.as_deref() == Some("now"))
            .unwrap();
        store
            .decide_glossary_entry(&ResourceDecision {
                project_id,
                action_id: ExecutionId::new(),
                capture_id: second.capture_id,
                entry_id: "now".into(),
                expected_revision_id: Some(removed.revision_id),
                decision: ResourceDecisionKind::Adopt,
            })
            .unwrap();
        let changed = store.resource_impacts(project_id, "zh-CN", 0, 100).unwrap();
        let removal = changed
            .items
            .iter()
            .find(|item| item.native_key == "generic.now")
            .unwrap();
        assert!(removal.reasons[0].new_removed);
        assert_eq!(removal.reasons[0].old_value.as_deref(), Some("现在"));
        assert!(
            store
                .resource_impacts(project_id, "fr-FR", 0, 100)
                .unwrap()
                .items
                .is_empty()
        );
        assert_eq!(
            store
                .resolve_terms(project_id, barrel, "zh-CN")
                .unwrap()
                .entries[0]
                .selected
                .as_ref()
                .unwrap()
                .target,
            "木桶"
        );
        store.close().unwrap();
        let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
        assert_eq!(
            reopened
                .glossary_preview(project_id, second.capture_id)
                .unwrap()
                .capture
                .digest,
            second.digest
        );
        assert_eq!(
            reopened
                .resource_impacts(project_id, "zh-CN", 0, 100)
                .unwrap()
                .items
                .len(),
            2
        );
    }

    #[test]
    fn context_is_unit_scoped_and_memory_does_not_create_translation_identity() {
        let (temp, mut store, project_id) = fixture_project();
        let barrel = unit(&store, project_id, "data.item.barrel.description");
        let box_unit = unit(&store, project_id, "data.item.box.description");
        let context_tag = unit(&store, project_id, "condition.item-context-tag");
        let context_tags = unit(&store, project_id, "condition.item-context-tags");
        selected_translation(&mut store, project_id, barrel, "zh-CN", "桶描述");
        selected_translation(&mut store, project_id, box_unit, "zh-CN", "箱描述");
        selected_translation(
            &mut store,
            project_id,
            context_tags,
            "zh-CN",
            "复数标签描述",
        );
        let fuzzy = store
            .tm_suggestions(project_id, context_tag, "zh-CN", 0, 20)
            .unwrap();
        assert!(fuzzy.iter().any(|candidate| {
            candidate.unit_id == context_tags
                && candidate.match_kind == TmMatchKind::Fuzzy
                && candidate.score_percent >= 70
                && candidate.translation_text == "复数标签描述"
                && !candidate.has_human_approval
        }));
        assert!(
            store
                .tm_suggestions(project_id, context_tag, "fr-FR", 0, 20)
                .unwrap()
                .is_empty()
        );
        let exact = store
            .tm_suggestions(project_id, barrel, "zh-CN", 0, 20)
            .unwrap();
        assert_eq!(exact.len(), 2);
        assert!(
            exact
                .iter()
                .all(|candidate| candidate.match_kind == TmMatchKind::Exact
                    && !candidate.has_human_approval)
        );
        assert_ne!(
            exact[0].translation_revision_id,
            exact[1].translation_revision_id
        );
        assert_eq!(fuzzy_score("Barrel description", "Barrel description"), 100);
        assert!(fuzzy_score("Barrel description", "Barrel descriptions") >= 70);
        assert_eq!(fuzzy_score("now", "new"), 0);
        let (source_revision_id, _, _, _) =
            source_fact(store.connection().unwrap(), project_id, barrel).unwrap();
        let saved = store
            .save_context(&SaveContext {
                project_id,
                action_id: ExecutionId::new(),
                unit_id: barrel,
                locale: "zh-CN".into(),
                source_revision_id,
                expected_revision_id: None,
                text: "This is a barrel, not a box.".into(),
                reason: "Human project note".into(),
            })
            .unwrap();
        let capture = store
            .capture_context(&CaptureContext {
                project_id,
                action_id: ExecutionId::new(),
                unit_id: barrel,
                locale: "zh-CN".into(),
                source_revision_id,
                budget_bytes: 16 * 1024,
            })
            .unwrap();
        assert!(
            capture
                .included
                .iter()
                .any(|item| item.kind == "manual" && item.revision_id == saved.revision_id)
        );
        let source_only_budget = capture.included[0].text.len() as u32;
        let source_only = store
            .capture_context(&CaptureContext {
                project_id,
                action_id: ExecutionId::new(),
                unit_id: barrel,
                locale: "zh-CN".into(),
                source_revision_id,
                budget_bytes: source_only_budget,
            })
            .unwrap();
        assert_eq!(source_only.included.len(), 1);
        assert!(source_only.omitted.iter().any(|item| {
            item.kind == "manual"
                && item.reference == saved.revision_id.to_string()
                && item.reason == "budget"
        }));
        assert_eq!(
            store
                .capture_context(&CaptureContext {
                    project_id,
                    action_id: ExecutionId::new(),
                    unit_id: barrel,
                    locale: "zh-CN".into(),
                    source_revision_id,
                    budget_bytes: 1,
                })
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        let impacted = store.resource_impacts(project_id, "zh-CN", 0, 100).unwrap();
        assert_eq!(
            impacted
                .items
                .iter()
                .map(|item| item.native_key.as_str())
                .collect::<Vec<_>>(),
            vec!["data.item.barrel.description"]
        );
        store.close().unwrap();
        let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
        assert_eq!(
            reopened
                .read_context_capture(project_id, capture.capture_id)
                .unwrap(),
            capture
        );
        assert_eq!(
            reopened
                .context_revision(project_id, barrel, "zh-CN")
                .unwrap(),
            Some(saved)
        );
    }

    #[test]
    fn equal_authority_conflicts_require_explicit_unit_scope_and_stale_writes_fail() {
        let (_temp, mut store, project_id) = fixture_project();
        let barrel = unit(&store, project_id, "data.item.barrel.name");
        let box_unit = unit(&store, project_id, "data.item.box.name");
        let make = |source: &str, target: &str, scope_unit_id| SaveTerm {
            project_id,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: source.into(),
            aliases: vec![],
            target: target.into(),
            protected: true,
            scope_unit_id,
            expected_revision_id: None,
            reason: "Reviewed".into(),
        };
        let first = make("Barrel", "桶", None);
        let first_result = store.save_term(&first).unwrap();
        assert_eq!(store.save_term(&first).unwrap(), first_result);
        let mut changed_same_action = first.clone();
        changed_same_action.target = "Different".into();
        assert_eq!(
            store.save_term(&changed_same_action).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        let second = store.save_term(&make("Barrel", "木桶", None)).unwrap();
        let conflict = store.resolve_terms(project_id, barrel, "zh-CN").unwrap();
        let entry = conflict
            .entries
            .iter()
            .find(|entry| entry.source == "Barrel")
            .unwrap();
        assert!(entry.selected.is_none());
        assert_eq!(entry.conflicting.len(), 2);
        assert!(
            entry
                .conflicting
                .iter()
                .any(|term| term.revision_id == second.revision_id)
        );
        let specific = store
            .save_term(&make("Barrel", "酿酒桶", Some(barrel)))
            .unwrap();
        let resolved = store.resolve_terms(project_id, barrel, "zh-CN").unwrap();
        assert_eq!(
            resolved
                .entries
                .iter()
                .find(|entry| entry.source == "Barrel")
                .unwrap()
                .selected
                .as_ref()
                .unwrap()
                .revision_id,
            specific.revision_id
        );
        assert!(
            store
                .resolve_terms(project_id, box_unit, "zh-CN")
                .unwrap()
                .entries
                .iter()
                .all(|entry| entry.source != "Barrel")
        );
        let mut stale = make("Barrel", "旧值", None);
        stale.term_id = Some(first_result.term_id.clone());
        assert_eq!(
            store.save_term(&stale).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
        let wrong_scope = make("Barrel", "越界", Some(ExecutionId::new()));
        assert_eq!(
            store.save_term(&wrong_scope).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
    }

    #[test]
    fn moving_a_scoped_term_marks_both_old_and_new_units_without_other_units() {
        let (_temp, mut store, project_id) = fixture_project();
        let barrel = unit(&store, project_id, "data.item.barrel.name");
        let box_unit = unit(&store, project_id, "data.item.box.name");
        let now = unit(&store, project_id, "generic.now");
        for selected in [barrel, box_unit, now] {
            selected_translation(&mut store, project_id, selected, "zh-CN", "saved");
        }
        let mut request = SaveTerm {
            project_id,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "Barrel".into(),
            aliases: vec![],
            target: "桶".into(),
            protected: false,
            scope_unit_id: Some(barrel),
            expected_revision_id: None,
            reason: "Reviewed".into(),
        };
        let first = store.save_term(&request).unwrap();
        request.action_id = ExecutionId::new();
        request.term_id = Some(first.term_id);
        request.scope_unit_id = Some(box_unit);
        request.expected_revision_id = Some(first.revision_id);
        store.save_term(&request).unwrap();
        let impacts = store.resource_impacts(project_id, "zh-CN", 0, 100).unwrap();
        let affected = impacts
            .items
            .iter()
            .map(|item| item.unit_id)
            .collect::<BTreeSet<_>>();
        assert_eq!(affected, BTreeSet::from([barrel, box_unit]));
        assert!(
            impacts
                .items
                .iter()
                .any(|item| item.unit_id == barrel && item.reasons.len() == 2)
        );
    }

    #[test]
    fn glossary_limits_and_stale_adoption_leave_the_current_term_intact() {
        let g1 = include_bytes!("../../tests/fixtures/resource-updates/g1.json");
        let mut exact_limit = g1.to_vec();
        exact_limit.resize(MAX_RESOURCE_BYTES, b' ');
        assert!(GlossaryFile::parse(&exact_limit).is_ok());
        exact_limit.push(b' ');
        assert_eq!(
            GlossaryFile::parse(&exact_limit).unwrap_err().code,
            ErrorCode::LimitExceeded
        );
        let mut too_many = GlossaryFile::parse(g1).unwrap();
        let entry = too_many.entries[0].clone();
        too_many.entries = (0..=MAX_ENTRIES)
            .map(|index| GlossaryEntry {
                id: format!("entry-{index}"),
                ..entry.clone()
            })
            .collect();
        assert_eq!(
            GlossaryFile::parse(&serde_json::to_vec(&too_many).unwrap())
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );

        let (_temp, mut store, project_id) = fixture_project();
        let first = store
            .capture_glossary(project_id, ExecutionId::new(), g1)
            .unwrap();
        let adopt = ResourceDecision {
            project_id,
            action_id: ExecutionId::new(),
            capture_id: first.capture_id,
            entry_id: "barrel".into(),
            expected_revision_id: None,
            decision: ResourceDecisionKind::Adopt,
        };
        let old = store
            .decide_glossary_entry(&adopt)
            .unwrap()
            .revision
            .unwrap();
        let second = store
            .capture_glossary(
                project_id,
                ExecutionId::new(),
                include_bytes!("../../tests/fixtures/resource-updates/g2.json"),
            )
            .unwrap();
        let manual = store
            .save_term(&SaveTerm {
                project_id,
                action_id: ExecutionId::new(),
                term_id: Some(old.term_id.clone()),
                locale: "zh-CN".into(),
                source: old.source,
                aliases: old.aliases,
                target: "手动保留".into(),
                protected: old.protected,
                scope_unit_id: old.scope_unit_id,
                expected_revision_id: Some(old.revision_id),
                reason: "Explicit project override".into(),
            })
            .unwrap();
        let stale = ResourceDecision {
            project_id,
            action_id: ExecutionId::new(),
            capture_id: second.capture_id,
            entry_id: "barrel".into(),
            expected_revision_id: Some(old.revision_id),
            decision: ResourceDecisionKind::Adopt,
        };
        assert_eq!(
            store.decide_glossary_entry(&stale).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
        assert_eq!(
            store
                .glossary_preview(project_id, second.capture_id)
                .unwrap()
                .rows
                .into_iter()
                .find(|row| row.entry.id == "barrel")
                .unwrap()
                .current
                .unwrap()
                .revision_id,
            manual.revision_id
        );
    }

    #[test]
    fn resource_decision_crash_child() {
        let Ok(path) = std::env::var("TSUMUGI_RESOURCE_DECISION_PROJECT") else {
            return;
        };
        let capture_id =
            ExecutionId::parse(&std::env::var("TSUMUGI_RESOURCE_DECISION_CAPTURE").unwrap())
                .unwrap();
        let action_id =
            ExecutionId::parse(&std::env::var("TSUMUGI_RESOURCE_DECISION_ACTION").unwrap())
                .unwrap();
        let mut store = ProjectStore::open(path).unwrap();
        let project_id =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let _ = store.decide_glossary_entry(&ResourceDecision {
            project_id,
            action_id,
            capture_id,
            entry_id: "barrel".into(),
            expected_revision_id: None,
            decision: ResourceDecisionKind::Adopt,
        });
        panic!("resource decision crash hook did not abort");
    }

    #[test]
    fn resource_decision_is_atomic_across_process_death_and_replay() {
        use std::process::{Command, Stdio};
        for point in [
            "before-resource-decision-commit",
            "after-resource-decision-commit",
        ] {
            let (temp, mut store, project_id) = fixture_project();
            let capture = store
                .capture_glossary(
                    project_id,
                    ExecutionId::new(),
                    include_bytes!("../../tests/fixtures/resource-updates/g1.json"),
                )
                .unwrap();
            let request = ResourceDecision {
                project_id,
                action_id: ExecutionId::new(),
                capture_id: capture.capture_id,
                entry_id: "barrel".into(),
                expected_revision_id: None,
                decision: ResourceDecisionKind::Adopt,
            };
            store.close().unwrap();
            let project_path = temp.path().join("project");
            let hook = temp.path().join("decision-hook");
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "persistence::resources::tests::resource_decision_crash_child",
                    "--nocapture",
                ])
                .env("TSUMUGI_RESOURCE_DECISION_PROJECT", &project_path)
                .env(
                    "TSUMUGI_RESOURCE_DECISION_CAPTURE",
                    capture.capture_id.to_string(),
                )
                .env(
                    "TSUMUGI_RESOURCE_DECISION_ACTION",
                    request.action_id.to_string(),
                )
                .env("TSUMUGI_MIGRATION_CRASH", point)
                .env("TSUMUGI_MIGRATION_HOOK", &hook)
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
                    panic!("owned resource decision crash helper timed out");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(std::fs::read_to_string(&hook).unwrap(), point);
            let mut reopened = ProjectStore::open(&project_path).unwrap();
            let connection = reopened.connection().unwrap();
            let revision_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM term_revisions WHERE action_id=?1",
                    params![request.action_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            let receipt_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM resource_decisions WHERE action_id=?1",
                    params![request.action_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            let expected = i64::from(point == "after-resource-decision-commit");
            assert_eq!((revision_count, receipt_count), (expected, expected));
            let result = reopened.decide_glossary_entry(&request).unwrap();
            assert_eq!(reopened.decide_glossary_entry(&request).unwrap(), result);
            assert_eq!(
                reopened
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT COUNT(*) FROM term_revisions WHERE action_id=?1",
                        params![request.action_id.to_string()],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1
            );
        }
    }
}
