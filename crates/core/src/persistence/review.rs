//! Project-local review and pre-build evidence. All current views are derived from
//! immutable decisions, checks, and the existing translation/resource authorities.

use super::{ProjectStore, resources};
use crate::execution::{
    Cancellation, ErrorCode, ExecutionError, ExecutionId, MAX_INPUT_BYTES, codec,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const CHECK_VERSION: &str = "smapi-prebuild-2";
const POLICY_VERSION: &str = "balanced-1";
const MAX_SCOPE: usize = 10_000;

#[cfg(test)]
thread_local! {
    static CHECK_FAIL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CHECK_BARRIER: std::cell::RefCell<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>> = const { std::cell::RefCell::new(None) };
}

fn failure(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(error: rusqlite::Error) -> ExecutionError {
    super::ledger::sql_error(error)
}
fn parse_id(raw: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&raw).map_err(|_| failure(ErrorCode::CorruptLedger, "review-identity"))
}
fn digest<T: Serialize>(value: &T) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(value, MAX_INPUT_BYTES)?))
}
fn basis_digest(value: &ReviewBasis) -> Result<String, ExecutionError> {
    // A new snapshot may leave this unit unchanged. Scope identity is retained for
    // history, while applicability depends on the unit's actual source revision.
    digest(&(
        value.source_revision_id,
        value.selection_id,
        value.revision_id,
        value.context_revision_id,
        &value.term_revision_ids,
    ))
}
fn checked_note(value: &str, required: bool) -> Result<(), ExecutionError> {
    if value.len() > 4_096
        || value.chars().any(|ch| ch == '\0')
        || (required && value.trim().is_empty())
    {
        return Err(failure(ErrorCode::InvalidInput, "review-note"));
    }
    Ok(())
}
fn checked_actor(value: &str) -> Result<(), ExecutionError> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > 128
        || value.chars().any(char::is_control)
    {
        return Err(failure(ErrorCode::InvalidInput, "review-actor"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewDecisionKind {
    Approve,
    RequestChanges,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewBasis {
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub selection_id: Option<ExecutionId>,
    pub revision_id: Option<ExecutionId>,
    pub context_revision_id: Option<ExecutionId>,
    pub term_revision_ids: Vec<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewWrite {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub expected_basis: String,
    pub expected_decision_id: Option<ExecutionId>,
    pub actor: String,
    pub kind: ReviewDecisionKind,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewDecision {
    pub decision_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub basis: String,
    pub basis_evidence: ReviewBasis,
    pub selection_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub actor: String,
    pub kind: ReviewDecisionKind,
    pub reason: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckFinding {
    pub issue_id: String,
    pub rule: String,
    pub code: String,
    pub detail: String,
    pub severity: String,
    pub waivable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckRuleResult {
    pub rule: String,
    pub status: String,
    pub reason: Option<String>,
    pub findings: Vec<CheckFinding>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckRun {
    pub run_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub basis: String,
    pub basis_evidence: ReviewBasis,
    pub validator_version: String,
    pub outcome: String,
    pub rules: Vec<CheckRuleResult>,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaiverWrite {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub expected_basis: String,
    pub issue_id: String,
    pub grant: bool,
    pub expected_waiver_id: Option<ExecutionId>,
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Waiver {
    pub waiver_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub basis: String,
    pub issue_id: String,
    pub grant: bool,
    pub previous_waiver_id: Option<ExecutionId>,
    pub policy_version: String,
    pub actor: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FallbackDecision {
    pub fallback_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub allow: bool,
    pub previous_fallback_id: Option<ExecutionId>,
    pub policy_version: String,
    pub actor: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FallbackWrite {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub expected_basis: String,
    pub allow: bool,
    pub expected_fallback_id: Option<ExecutionId>,
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewTarget {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub native_key: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub source_text: String,
    pub selection_id: Option<ExecutionId>,
    pub revision_id: Option<ExecutionId>,
    pub translation_text: Option<String>,
    pub basis: String,
    pub basis_evidence: ReviewBasis,
    pub term_conflict: bool,
    pub current_decision: Option<ReviewDecision>,
    pub current_check: Option<CheckRun>,
    pub current_fallback: Option<FallbackDecision>,
    pub current_waivers: Vec<Waiver>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewPage {
    pub rows: Vec<ReviewTarget>,
    pub next_ordinal: Option<u32>,
    pub total: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EligibilityReason {
    pub unit_id: ExecutionId,
    pub native_key: String,
    pub code: String,
    pub reference: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EligibilityLocale {
    pub locale: String,
    pub ready: bool,
    pub blockers: Vec<EligibilityReason>,
    pub exceptions: Vec<EligibilityReason>,
    pub checked_units: u32,
    pub blocker_count: u32,
    pub exception_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Eligibility {
    pub policy_version: String,
    pub source_snapshot_id: ExecutionId,
    pub basis: String,
    pub ready: bool,
    pub locales: Vec<EligibilityLocale>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItem {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub native_key: String,
    pub reasons: Vec<String>,
    pub basis: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPage {
    pub items: Vec<WorkItem>,
    pub total: u32,
    pub next_offset: Option<u32>,
    pub coverage: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewHistoryPage {
    pub decisions: Vec<ReviewDecision>,
    pub checks: Vec<CheckRun>,
    pub waivers: Vec<Waiver>,
    pub fallbacks: Vec<FallbackDecision>,
    pub next_offset: Option<u32>,
}

const TABLES: &[(&str, &str)] = &[
    (
        "review_decisions",
        "CREATE TABLE review_decisions (
        decision_id TEXT PRIMARY KEY NOT NULL,
        action_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        basis TEXT NOT NULL CHECK(length(basis)=64),
        basis_json TEXT NOT NULL,
        selection_id TEXT NOT NULL REFERENCES translation_selections(event_id),
        revision_id TEXT NOT NULL REFERENCES translation_revisions(revision_id),
        source_revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id),
        actor TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('approve','request-changes')),
        reason TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    ),
    (
        "review_checks",
        "CREATE TABLE review_checks (
        run_id TEXT PRIMARY KEY NOT NULL,
        action_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        basis TEXT NOT NULL CHECK(length(basis)=64),
        basis_json TEXT NOT NULL,
        validator_version TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    ),
    (
        "review_waivers",
        "CREATE TABLE review_waivers (
        waiver_id TEXT PRIMARY KEY NOT NULL,
        action_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        basis TEXT NOT NULL CHECK(length(basis)=64),
        issue_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('grant','revoke')),
        previous_waiver_id TEXT REFERENCES review_waivers(waiver_id),
        policy_version TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    ),
    (
        "review_fallbacks",
        "CREATE TABLE review_fallbacks (
        fallback_id TEXT PRIMARY KEY NOT NULL,
        action_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        source_revision_id TEXT NOT NULL REFERENCES source_revisions(revision_id),
        kind TEXT NOT NULL CHECK(kind IN ('allow','withdraw')),
        previous_fallback_id TEXT REFERENCES review_fallbacks(fallback_id),
        policy_version TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    ),
];

pub(super) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| (*name).to_owned())
}
pub(super) fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    for (_, definition) in TABLES {
        connection.execute_batch(definition)?;
    }
    Ok(())
}
#[cfg(test)]
pub(super) fn drop_for_legacy_fixture(connection: &Connection) -> rusqlite::Result<()> {
    for (name, _) in TABLES.iter().rev() {
        connection.execute_batch(&format!("DROP TABLE {name}"))?;
    }
    Ok(())
}
pub(super) fn migrate_v6(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    initialize(&transaction)?;
    if transaction
        .prepare("PRAGMA foreign_key_check")?
        .exists([])?
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    transaction.pragma_update(None, "user_version", 7)?;
    #[cfg(test)]
    super::migration_crash_hook("before-review-migration-commit");
    transaction.commit()?;
    #[cfg(test)]
    super::migration_crash_hook("after-review-migration-commit");
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
    for table in ["review_decisions", "review_checks"] {
        let mut statement = connection.prepare(&format!("SELECT basis,basis_json FROM {table}"))?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (saved, json) = row?;
            let evidence: ReviewBasis =
                serde_json::from_str(&json).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if basis_digest(&evidence).map_err(|_| rusqlite::Error::InvalidQuery)? != saved {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
    }
    let mut statement = connection.prepare("SELECT rules_json FROM review_checks")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        let rules: Vec<CheckRuleResult> =
            serde_json::from_str(&row?).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if rules.is_empty() {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    Ok(())
}

fn check_project(
    connection: &Connection,
    project_id: ExecutionId,
    locale: &str,
) -> Result<(), ExecutionError> {
    let metadata = super::read_metadata_from(connection)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "review-project"))?;
    if metadata.project_id().to_string() != project_id.to_string() {
        return Err(failure(ErrorCode::Unauthorized, "review-project"));
    }
    let parsed = crate::Locale::parse(locale)
        .map_err(|_| failure(ErrorCode::InvalidInput, "review-locale"))?;
    if parsed.as_str() != locale
        || !metadata
            .target_locales()
            .iter()
            .any(|item| item.as_str() == locale)
    {
        return Err(failure(ErrorCode::DependencyConflict, "review-locale"));
    }
    Ok(())
}

fn decision_by_action(
    connection: &Connection,
    project_id: ExecutionId,
    action_id: ExecutionId,
) -> Result<Option<(ReviewDecision, String)>, ExecutionError> {
    let row = connection.query_row(
        "SELECT decision_id,action_id,unit_id,locale,basis,basis_json,selection_id,revision_id,source_revision_id,
                actor,kind,reason,created_at,request_digest FROM review_decisions
         WHERE project_id=?1 AND action_id=?2",
        params![project_id.to_string(), action_id.to_string()],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                  row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                  row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
                  row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?,
                  row.get::<_, String>(12)?, row.get::<_, String>(13)?)),
    ).optional().map_err(sql)?;
    row.map(
        |(
            decision_id,
            action_id,
            unit_id,
            locale,
            basis,
            basis_json,
            selection_id,
            revision_id,
            source_revision_id,
            actor,
            kind,
            reason,
            created_at,
            request_digest,
        )| {
            let basis_evidence: ReviewBasis = serde_json::from_str(&basis_json)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "review-basis"))?;
            if basis_digest(&basis_evidence)? != basis {
                return Err(failure(ErrorCode::CorruptLedger, "review-basis"));
            }
            Ok((
                ReviewDecision {
                    decision_id: parse_id(decision_id)?,
                    action_id: parse_id(action_id)?,
                    unit_id: parse_id(unit_id)?,
                    locale,
                    basis,
                    basis_evidence,
                    selection_id: parse_id(selection_id)?,
                    revision_id: parse_id(revision_id)?,
                    source_revision_id: parse_id(source_revision_id)?,
                    actor,
                    kind: match kind.as_str() {
                        "approve" => ReviewDecisionKind::Approve,
                        "request-changes" => ReviewDecisionKind::RequestChanges,
                        _ => return Err(failure(ErrorCode::CorruptLedger, "review-kind")),
                    },
                    reason,
                    created_at,
                },
                request_digest,
            ))
        },
    )
    .transpose()
}

fn latest_decision(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
    locale: &str,
    basis: &str,
) -> Result<Option<ReviewDecision>, ExecutionError> {
    let action: Option<String> = connection.query_row(
        "SELECT action_id FROM review_decisions WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND basis=?4
         ORDER BY rowid DESC LIMIT 1",
        params![project_id.to_string(), unit_id.to_string(), locale, basis], |row| row.get(0)
    ).optional().map_err(sql)?;
    action
        .map(|value| {
            decision_by_action(connection, project_id, parse_id(value)?)
                .map(|row| row.map(|item| item.0))
        })
        .transpose()
        .map(Option::flatten)
}

fn check_by_action(
    connection: &Connection,
    project_id: ExecutionId,
    action_id: ExecutionId,
) -> Result<Option<(CheckRun, String)>, ExecutionError> {
    let row: Option<(String,String,String,String,String,String,String,String,String,String)> = connection.query_row(
        "SELECT run_id,action_id,unit_id,locale,basis,basis_json,validator_version,rules_json,created_at,request_digest
         FROM review_checks WHERE project_id=?1 AND action_id=?2",
        params![project_id.to_string(), action_id.to_string()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                  row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
    ).optional().map_err(sql)?;
    row.map(
        |(
            run_id,
            action_id,
            unit_id,
            locale,
            basis,
            basis_json,
            validator_version,
            rules_json,
            created_at,
            request_digest,
        )| {
            let basis_evidence: ReviewBasis = serde_json::from_str(&basis_json)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "review-basis"))?;
            if basis_digest(&basis_evidence)? != basis {
                return Err(failure(ErrorCode::CorruptLedger, "review-basis"));
            }
            let rules: Vec<CheckRuleResult> = serde_json::from_str(&rules_json)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "review-checks"))?;
            let outcome = if rules
                .iter()
                .all(|rule: &CheckRuleResult| rule.status == "cancelled")
            {
                "cancelled"
            } else if rules
                .iter()
                .all(|rule: &CheckRuleResult| rule.status == "failed")
            {
                "failed"
            } else {
                "completed"
            };
            Ok((
                CheckRun {
                    run_id: parse_id(run_id)?,
                    action_id: parse_id(action_id)?,
                    unit_id: parse_id(unit_id)?,
                    locale,
                    basis,
                    basis_evidence,
                    validator_version,
                    outcome: outcome.to_owned(),
                    rules,
                    created_at,
                },
                request_digest,
            ))
        },
    )
    .transpose()
}

fn latest_check(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
    locale: &str,
    basis: &str,
) -> Result<Option<CheckRun>, ExecutionError> {
    let action: Option<String> = connection
        .query_row(
            "SELECT action_id FROM review_checks WHERE project_id=?1 AND unit_id=?2 AND locale=?3
         AND basis=?4 AND validator_version=?5 ORDER BY rowid DESC LIMIT 1",
            params![
                project_id.to_string(),
                unit_id.to_string(),
                locale,
                basis,
                CHECK_VERSION
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    action
        .map(|value| {
            check_by_action(connection, project_id, parse_id(value)?)
                .map(|row| row.map(|item| item.0))
        })
        .transpose()
        .map(Option::flatten)
}

fn current_fallback(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
    locale: &str,
    source_revision_id: ExecutionId,
) -> Result<Option<FallbackDecision>, ExecutionError> {
    let row: Option<(String,String,String,String,String,String,Option<String>)> = connection.query_row(
        "SELECT fallback_id,action_id,actor,reason,created_at,kind,previous_fallback_id FROM review_fallbacks
         WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND source_revision_id=?4
           AND policy_version=?5 ORDER BY rowid DESC LIMIT 1",
        params![project_id.to_string(), unit_id.to_string(), locale, source_revision_id.to_string(), POLICY_VERSION],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional().map_err(sql)?;
    row.map(
        |(fallback_id, action_id, actor, reason, created_at, kind, previous)| {
            Ok(FallbackDecision {
                fallback_id: parse_id(fallback_id)?,
                action_id: parse_id(action_id)?,
                unit_id,
                locale: locale.to_owned(),
                source_revision_id,
                allow: kind == "allow",
                previous_fallback_id: previous.map(parse_id).transpose()?,
                policy_version: POLICY_VERSION.to_owned(),
                actor,
                reason,
                created_at,
            })
        },
    )
    .transpose()
    .map(|item| item.filter(|value| value.allow))
}

fn current_waivers(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
    locale: &str,
    basis: &str,
) -> Result<Vec<Waiver>, ExecutionError> {
    let mut statement = connection.prepare(
        "SELECT waiver_id,action_id,issue_id,actor,reason,created_at,kind,previous_waiver_id FROM review_waivers
         WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND basis=?4 AND policy_version=?5 ORDER BY rowid"
    ).map_err(sql)?;
    let rows = statement
        .query_map(
            params![
                project_id.to_string(),
                unit_id.to_string(),
                locale,
                basis,
                POLICY_VERSION
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .map_err(sql)?;
    let mut current = BTreeMap::new();
    for row in rows {
        let (waiver_id, action_id, issue_id, actor, reason, created_at, kind, previous) =
            row.map_err(sql)?;
        let waiver = Waiver {
            waiver_id: parse_id(waiver_id)?,
            action_id: parse_id(action_id)?,
            unit_id,
            locale: locale.to_owned(),
            basis: basis.to_owned(),
            issue_id: issue_id.clone(),
            grant: kind == "grant",
            previous_waiver_id: previous.map(parse_id).transpose()?,
            policy_version: POLICY_VERSION.to_owned(),
            actor,
            reason,
            created_at,
        };
        if waiver.grant {
            current.insert(issue_id, waiver);
        } else {
            current.remove(&issue_id);
        }
    }
    Ok(current.into_values().collect())
}

fn target_in(
    connection: &Connection,
    project_id: ExecutionId,
    unit_id: ExecutionId,
    locale: &str,
) -> Result<ReviewTarget, ExecutionError> {
    check_project(connection, project_id, locale)?;
    let row: Option<(String,String,String,String,Option<String>,Option<String>,Option<String>)> = connection.query_row(
        "SELECT o.snapshot_id,o.revision_id,o.native_key,r.text,s.event_id,s.revision_id,tr.text
         FROM source_occurrences o
         JOIN source_units u ON u.unit_id=o.unit_id
         JOIN source_revisions r ON r.revision_id=o.revision_id
         JOIN content_scope c ON c.current_snapshot=o.snapshot_id
         LEFT JOIN translation_selections s ON s.unit_id=o.unit_id AND s.locale=?3
           AND s.sequence=(SELECT MAX(t.sequence) FROM translation_selections t WHERE t.unit_id=o.unit_id AND t.locale=?3)
         LEFT JOIN translation_revisions tr ON tr.revision_id=s.revision_id
         WHERE u.project_id=?1 AND o.unit_id=?2",
        params![project_id.to_string(), unit_id.to_string(), locale],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional().map_err(sql)?;
    let Some((snapshot, source_revision, native_key, source_text, selection, revision, text)) = row
    else {
        return Err(failure(ErrorCode::DependencyConflict, "review-unit"));
    };
    let source_snapshot_id = parse_id(snapshot)?;
    let source_revision_id = parse_id(source_revision)?;
    let selection_id = selection.map(parse_id).transpose()?;
    let revision_id = revision.map(parse_id).transpose()?;
    if selection_id.is_some() != revision_id.is_some() || revision_id.is_some() != text.is_some() {
        return Err(failure(ErrorCode::CorruptLedger, "review-selection"));
    }
    let terms = resources::resolve_terms_in(connection, project_id, unit_id, locale)?;
    let context = resources::current_context(connection, project_id, unit_id, locale)?;
    let term_conflict = terms
        .entries
        .iter()
        .any(|item| !item.conflicting.is_empty());
    let mut term_revision_ids: Vec<ExecutionId> = terms
        .entries
        .iter()
        .flat_map(|entry| {
            entry
                .selected
                .iter()
                .chain(entry.conflicting.iter())
                .map(|term| term.revision_id)
        })
        .collect();
    term_revision_ids.sort();
    term_revision_ids.dedup();
    let basis_evidence = ReviewBasis {
        source_snapshot_id,
        source_revision_id,
        selection_id,
        revision_id,
        context_revision_id: context.as_ref().map(|item| item.revision_id),
        term_revision_ids,
    };
    let basis = basis_digest(&basis_evidence)?;
    let current_decision = latest_decision(connection, project_id, unit_id, locale, &basis)?;
    let current_check = latest_check(connection, project_id, unit_id, locale, &basis)?;
    let current_fallback = if selection_id.is_none() {
        current_fallback(connection, project_id, unit_id, locale, source_revision_id)?
    } else {
        None
    };
    let waivers = current_waivers(connection, project_id, unit_id, locale, &basis)?;
    let current_waivers = if let Some(check) = &current_check {
        let current_issues: BTreeSet<&str> = check
            .rules
            .iter()
            .flat_map(|rule| &rule.findings)
            .filter(|finding| finding.waivable)
            .map(|finding| finding.issue_id.as_str())
            .collect();
        waivers
            .into_iter()
            .filter(|waiver| current_issues.contains(waiver.issue_id.as_str()))
            .collect()
    } else {
        Vec::new()
    };
    Ok(ReviewTarget {
        unit_id,
        locale: locale.to_owned(),
        native_key,
        source_snapshot_id,
        source_revision_id,
        source_text,
        selection_id,
        revision_id,
        translation_text: text,
        basis,
        basis_evidence,
        term_conflict,
        current_decision,
        current_check,
        current_fallback,
        current_waivers,
    })
}

impl ProjectStore {
    pub fn review_target(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
    ) -> Result<ReviewTarget, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        target_in(connection, project_id, unit_id, locale)
    }

    pub fn review_page(
        &self,
        project_id: ExecutionId,
        locale: &str,
        after_ordinal: u32,
        limit: u32,
    ) -> Result<ReviewPage, ExecutionError> {
        if limit == 0 || limit > 100 || after_ordinal > MAX_SCOPE as u32 {
            return Err(failure(ErrorCode::InvalidInput, "review-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        check_project(connection, project_id, locale)?;
        let snapshot: Option<String> = connection
            .query_row(
                "SELECT current_snapshot FROM content_scope WHERE row_id=1",
                [],
                |row| row.get(0),
            )
            .map_err(sql)?;
        let Some(snapshot) = snapshot else {
            return Err(failure(ErrorCode::DependencyConflict, "review-source"));
        };
        let total: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM source_occurrences WHERE snapshot_id=?1",
                [&snapshot],
                |row| row.get(0),
            )
            .map_err(sql)?;
        if total > MAX_SCOPE as i64 {
            return Err(failure(ErrorCode::LimitExceeded, "review-scope"));
        }
        let mut statement = connection.prepare(
            "SELECT unit_id,ordinal FROM source_occurrences WHERE snapshot_id=?1 AND ordinal>=?2
             ORDER BY ordinal LIMIT ?3"
        ).map_err(sql)?;
        let items = statement
            .query_map(params![snapshot, after_ordinal, limit + 1], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        let next_ordinal = (items.len() > limit as usize).then(|| items[limit as usize].1);
        let rows = items
            .into_iter()
            .take(limit as usize)
            .map(|(unit, _)| target_in(connection, project_id, parse_id(unit)?, locale))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ReviewPage {
            rows,
            next_ordinal,
            total: total as u32,
        })
    }

    pub fn review_history(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<ReviewHistoryPage, ExecutionError> {
        if limit == 0 || limit > 50 || offset > MAX_SCOPE as u32 {
            return Err(failure(ErrorCode::InvalidInput, "review-history-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        let _ = target_in(connection, project_id, unit_id, locale)?;
        let read_actions = |table: &str| -> Result<Vec<ExecutionId>, ExecutionError> {
            // Table names come only from this fixed list, never request data.
            let query = format!(
                "SELECT action_id FROM {table} WHERE project_id=?1 AND unit_id=?2 AND locale=?3 ORDER BY rowid DESC LIMIT ?4 OFFSET ?5"
            );
            let mut statement = connection.prepare(&query).map_err(sql)?;
            statement
                .query_map(
                    params![
                        project_id.to_string(),
                        unit_id.to_string(),
                        locale,
                        limit + 1,
                        offset
                    ],
                    |row| row.get::<_, String>(0),
                )
                .map_err(sql)?
                .map(|row| parse_id(row.map_err(sql)?))
                .collect()
        };
        let mut decision_ids = read_actions("review_decisions")?;
        let mut check_ids = read_actions("review_checks")?;
        let mut waiver_ids = read_actions("review_waivers")?;
        let mut fallback_ids = read_actions("review_fallbacks")?;
        let next_offset = [
            decision_ids.len(),
            check_ids.len(),
            waiver_ids.len(),
            fallback_ids.len(),
        ]
        .into_iter()
        .any(|count| count > limit as usize)
        .then_some(offset + limit);
        decision_ids.truncate(limit as usize);
        check_ids.truncate(limit as usize);
        waiver_ids.truncate(limit as usize);
        fallback_ids.truncate(limit as usize);
        let decisions = decision_ids
            .into_iter()
            .map(|id| {
                decision_by_action(connection, project_id, id)?
                    .map(|value| value.0)
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-history"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let checks = check_ids
            .into_iter()
            .map(|id| {
                check_by_action(connection, project_id, id)?
                    .map(|value| value.0)
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-history"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let waivers = waiver_ids
            .into_iter()
            .map(|id| {
                waiver_by_action(connection, project_id, id)?
                    .map(|value| value.0)
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-history"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let fallbacks = fallback_ids
            .into_iter()
            .map(|id| {
                fallback_by_action(connection, project_id, id)?
                    .map(|value| value.0)
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-history"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ReviewHistoryPage {
            decisions,
            checks,
            waivers,
            fallbacks,
            next_offset,
        })
    }

    pub fn write_review(
        &mut self,
        request: &ReviewWrite,
    ) -> Result<ReviewDecision, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        checked_actor(&request.actor)?;
        checked_note(
            &request.reason,
            matches!(request.kind, ReviewDecisionKind::RequestChanges),
        )?;
        let request_digest = digest(request)?;
        let unknown = self.execution_unknown.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        if let Some((decision, prior_digest)) =
            decision_by_action(&transaction, request.project_id, request.action_id)?
        {
            return if prior_digest == request_digest {
                Ok(decision)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-action"))
            };
        }
        let target = target_in(
            &transaction,
            request.project_id,
            request.unit_id,
            &request.locale,
        )?;
        if target.basis != request.expected_basis {
            return Err(failure(ErrorCode::DependencyConflict, "review-current"));
        }
        if target
            .current_decision
            .as_ref()
            .map(|item| item.decision_id)
            != request.expected_decision_id
        {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "review-decision-current",
            ));
        }
        let (Some(selection_id), Some(revision_id)) = (target.selection_id, target.revision_id)
        else {
            return Err(failure(ErrorCode::DependencyConflict, "review-translation"));
        };
        let decision_id = ExecutionId::new();
        let basis_json = serde_json::to_string(&target.basis_evidence)
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-basis"))?;
        transaction.execute(
            "INSERT INTO review_decisions
             (decision_id,action_id,project_id,unit_id,locale,basis,basis_json,selection_id,revision_id,
              source_revision_id,actor,kind,reason,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![decision_id.to_string(), request.action_id.to_string(), request.project_id.to_string(),
                request.unit_id.to_string(), request.locale, request.expected_basis, basis_json,
                selection_id.to_string(), revision_id.to_string(), target.source_revision_id.to_string(),
                request.actor, match request.kind { ReviewDecisionKind::Approve => "approve",
                    ReviewDecisionKind::RequestChanges => "request-changes" }, request.reason, request_digest],
        ).map_err(sql)?;
        #[cfg(test)]
        super::migration_crash_hook("before-review-decision-commit");
        transaction.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-commit")
        })?;
        #[cfg(test)]
        super::migration_crash_hook("after-review-decision-commit");
        decision_by_action(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?,
            request.project_id,
            request.action_id,
        )?
        .map(|item| item.0)
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-receipt"))
    }

    pub fn run_review_checks(
        &mut self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        expected_basis: &str,
        action_id: ExecutionId,
    ) -> Result<CheckRun, ExecutionError> {
        self.run_review_checks_with_cancel(
            project_id,
            unit_id,
            locale,
            expected_basis,
            action_id,
            &Cancellation::default(),
        )
    }

    pub fn run_review_checks_with_cancel(
        &mut self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
        expected_basis: &str,
        action_id: ExecutionId,
        cancellation: &Cancellation,
    ) -> Result<CheckRun, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        let request_digest = digest(&(project_id, unit_id, locale, expected_basis, action_id))?;
        let unknown = self.execution_unknown.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        if let Some((run, prior_digest)) = check_by_action(&transaction, project_id, action_id)? {
            return if prior_digest == request_digest {
                Ok(run)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-check-action"))
            };
        }
        let target = target_in(&transaction, project_id, unit_id, locale)?;
        if target.basis != expected_basis {
            return Err(failure(ErrorCode::DependencyConflict, "review-current"));
        }
        let rules = if cancellation.is_requested() {
            interrupted_rules("cancelled", "Cancelled before completion")
        } else {
            match resources::resolve_terms_in(&transaction, project_id, unit_id, locale)
                .and_then(|terms| check_rules(&target, &terms))
            {
                Ok(rules) => rules,
                Err(error) => interrupted_rules("failed", &error.stage),
            }
        };
        let rules = if cancellation.is_requested() {
            interrupted_rules("cancelled", "Cancelled before completion")
        } else {
            rules
        };
        let run_id = ExecutionId::new();
        let mut rules_json = serde_json::to_string(&rules)
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-check-encode"))?;
        if rules_json.len() > 65_536 {
            rules_json = serde_json::to_string(&interrupted_rules("failed", "limit-exceeded"))
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-check-encode"))?;
        }
        let basis_json = serde_json::to_string(&target.basis_evidence)
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-basis"))?;
        if cancellation.is_requested() {
            rules_json = serde_json::to_string(&interrupted_rules(
                "cancelled",
                "Cancelled before completion",
            ))
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-check-encode"))?;
        }
        transaction.execute(
            "INSERT INTO review_checks
             (run_id,action_id,project_id,unit_id,locale,basis,basis_json,validator_version,rules_json,request_digest)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![run_id.to_string(), action_id.to_string(), project_id.to_string(), unit_id.to_string(),
                locale, expected_basis, basis_json, CHECK_VERSION, rules_json, request_digest],
        ).map_err(sql)?;
        transaction.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-check-commit")
        })?;
        check_by_action(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?,
            project_id,
            action_id,
        )?
        .map(|item| item.0)
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-check-receipt"))
    }
}

fn finding(
    target: &ReviewTarget,
    rule: &str,
    code: &str,
    detail: &str,
    severity: &str,
    waivable: bool,
) -> Result<CheckFinding, ExecutionError> {
    Ok(CheckFinding {
        issue_id: digest(&(
            CHECK_VERSION,
            target.unit_id,
            &target.locale,
            rule,
            code,
            detail,
        ))?,
        rule: rule.to_owned(),
        code: code.to_owned(),
        detail: detail.to_owned(),
        severity: severity.to_owned(),
        waivable,
    })
}
fn result(rule: &str, findings: Vec<CheckFinding>, reason: Option<&str>) -> CheckRuleResult {
    CheckRuleResult {
        rule: rule.to_owned(),
        status: if reason.is_some() {
            "not-applicable"
        } else if findings.is_empty() {
            "passed"
        } else {
            "findings"
        }
        .to_owned(),
        reason: reason.map(str::to_owned),
        findings,
    }
}

fn interrupted_rules(status: &str, reason: &str) -> Vec<CheckRuleResult> {
    [
        "required-translation",
        "placeholders",
        "format",
        "terminology",
    ]
    .into_iter()
    .map(|rule| CheckRuleResult {
        rule: rule.to_owned(),
        status: status.to_owned(),
        reason: Some(reason.to_owned()),
        findings: Vec::new(),
    })
    .collect()
}

/// The first bundled format uses named `{{token}}` markers. A malformed marker
/// is a format finding; a valid marker inventory is compared including counts.
fn markers(value: &str) -> Result<BTreeMap<String, u32>, ()> {
    let mut found = BTreeMap::new();
    let mut rest = value;
    while !rest.is_empty() {
        let open = rest.find("{{");
        let close = rest.find("}}");
        if close.is_some_and(|position| open.is_none_or(|start| position < start)) {
            return Err(());
        }
        let Some(start) = open else {
            break;
        };
        rest = &rest[start + 2..];
        let Some(end) = rest.find("}}") else {
            return Err(());
        };
        if rest[..end].contains("{{") {
            return Err(());
        }
        let name = &rest[..end];
        if name.is_empty()
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return Err(());
        }
        *found.entry(name.to_owned()).or_default() += 1;
        rest = &rest[end + 2..];
    }
    Ok(found)
}

fn check_rules(
    target: &ReviewTarget,
    terms: &resources::TermResolution,
) -> Result<Vec<CheckRuleResult>, ExecutionError> {
    #[cfg(test)]
    if CHECK_FAIL.with(|flag| flag.get()) {
        return Err(failure(
            ErrorCode::StorageFailed,
            "review-check-injected-failure",
        ));
    }
    #[cfg(test)]
    CHECK_BARRIER.with(|barrier| {
        if let Some((reached, release)) = barrier.borrow_mut().take() {
            reached.send(()).unwrap();
            release
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        }
    });
    let source_markers = markers(&target.source_text);
    let mut format = Vec::new();
    if source_markers.is_err() {
        format.push(finding(
            target,
            "format",
            "source-marker",
            "Source marker syntax is unsupported",
            "error",
            false,
        )?);
    }
    if target
        .source_text
        .chars()
        .any(|ch| ch == '\0' || (ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t'))
    {
        format.push(finding(
            target,
            "format",
            "source-control-character",
            "Source contains a control character",
            "error",
            false,
        )?);
    }
    let Some(text) = target.translation_text.as_deref() else {
        return Ok(vec![
            result(
                "required-translation",
                vec![finding(
                    target,
                    "required-translation",
                    "missing",
                    "No selected translation",
                    "error",
                    false,
                )?],
                None,
            ),
            result("placeholders", Vec::new(), Some("No selected translation")),
            result("format", format, None),
            result("terminology", Vec::new(), Some("No selected translation")),
        ]);
    };
    let mut required = Vec::new();
    if text.is_empty() {
        required.push(finding(
            target,
            "required-translation",
            "empty",
            "Selected translation is empty",
            "error",
            false,
        )?);
    }
    let target_markers = markers(text);
    if target_markers.is_err() {
        format.push(finding(
            target,
            "format",
            "translation-marker",
            "Translation marker syntax is malformed",
            "error",
            false,
        )?);
    }
    if text
        .chars()
        .any(|ch| ch == '\0' || (ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t'))
    {
        format.push(finding(
            target,
            "format",
            "control-character",
            "Translation contains a control character",
            "error",
            false,
        )?);
    }
    let mut placeholders = Vec::new();
    if let (Ok(source), Ok(translation)) = (&source_markers, &target_markers) {
        if source != translation {
            placeholders.push(finding(
                target,
                "placeholders",
                "marker-mismatch",
                "Named marker names or counts differ from source",
                "error",
                false,
            )?);
        }
    }
    let mut terminology = Vec::new();
    for entry in &terms.entries {
        if !entry.conflicting.is_empty() {
            terminology.push(finding(
                target,
                "terminology",
                "conflict",
                &entry.source,
                "error",
                false,
            )?);
        } else if let Some(term) = &entry.selected {
            if term.protected
                && (target.source_text.contains(&entry.source)
                    || term
                        .aliases
                        .iter()
                        .any(|alias| target.source_text.contains(alias)))
                && !text.contains(&term.target)
            {
                terminology.push(finding(
                    target,
                    "terminology",
                    "protected-form",
                    &entry.source,
                    "warning",
                    true,
                )?);
            }
        }
    }
    let placeholder_result = if source_markers.is_err() || target_markers.is_err() {
        CheckRuleResult {
            rule: "placeholders".into(),
            status: "unavailable".into(),
            reason: Some("Marker syntax is unsupported or malformed".into()),
            findings: placeholders,
        }
    } else {
        result("placeholders", placeholders, None)
    };
    Ok(vec![
        result("required-translation", required, None),
        placeholder_result,
        result("format", format, None),
        result("terminology", terminology, None),
    ])
}

fn waiver_by_action(
    connection: &Connection,
    project_id: ExecutionId,
    action_id: ExecutionId,
) -> Result<Option<(Waiver, String)>, ExecutionError> {
    let row: Option<(String,String,String,String,String,String,String,String,String,Option<String>,String,String)> = connection.query_row(
        "SELECT waiver_id,unit_id,locale,basis,issue_id,actor,reason,created_at,kind,previous_waiver_id,policy_version,request_digest
         FROM review_waivers WHERE project_id=?1 AND action_id=?2",
        params![project_id.to_string(), action_id.to_string()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                  row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?)),
    ).optional().map_err(sql)?;
    row.map(
        |(
            waiver_id,
            unit_id,
            locale,
            basis,
            issue_id,
            actor,
            reason,
            created_at,
            kind,
            previous,
            policy_version,
            request_digest,
        )| {
            Ok((
                Waiver {
                    waiver_id: parse_id(waiver_id)?,
                    action_id,
                    unit_id: parse_id(unit_id)?,
                    locale,
                    basis,
                    issue_id,
                    grant: kind == "grant",
                    previous_waiver_id: previous.map(parse_id).transpose()?,
                    policy_version,
                    actor,
                    reason,
                    created_at,
                },
                request_digest,
            ))
        },
    )
    .transpose()
}
fn fallback_by_action(
    connection: &Connection,
    project_id: ExecutionId,
    action_id: ExecutionId,
) -> Result<Option<(FallbackDecision, String)>, ExecutionError> {
    let row: Option<(String,String,String,String,String,String,String,String,Option<String>,String,String)> = connection.query_row(
        "SELECT fallback_id,unit_id,locale,source_revision_id,actor,reason,created_at,kind,previous_fallback_id,policy_version,request_digest
         FROM review_fallbacks WHERE project_id=?1 AND action_id=?2",
        params![project_id.to_string(), action_id.to_string()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?)),
    ).optional().map_err(sql)?;
    row.map(
        |(
            fallback_id,
            unit_id,
            locale,
            source_revision_id,
            actor,
            reason,
            created_at,
            kind,
            previous,
            policy_version,
            request_digest,
        )| {
            Ok((
                FallbackDecision {
                    fallback_id: parse_id(fallback_id)?,
                    action_id,
                    unit_id: parse_id(unit_id)?,
                    locale,
                    source_revision_id: parse_id(source_revision_id)?,
                    allow: kind == "allow",
                    previous_fallback_id: previous.map(parse_id).transpose()?,
                    policy_version,
                    actor,
                    reason,
                    created_at,
                },
                request_digest,
            ))
        },
    )
    .transpose()
}

impl ProjectStore {
    pub fn waive_review_issue(&mut self, request: &WaiverWrite) -> Result<Waiver, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        checked_actor(&request.actor)?;
        checked_note(&request.reason, true)?;
        if request.issue_id.len() != 64 {
            return Err(failure(ErrorCode::InvalidInput, "review-issue"));
        }
        let request_digest = digest(request)?;
        let unknown = self.execution_unknown.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        if let Some((waiver, prior_digest)) =
            waiver_by_action(&transaction, request.project_id, request.action_id)?
        {
            return if prior_digest == request_digest {
                Ok(waiver)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-waiver-action"))
            };
        }
        let target = target_in(
            &transaction,
            request.project_id,
            request.unit_id,
            &request.locale,
        )?;
        if target.basis != request.expected_basis {
            return Err(failure(ErrorCode::DependencyConflict, "review-current"));
        }
        let active = target
            .current_waivers
            .iter()
            .find(|item| item.issue_id == request.issue_id);
        if active.map(|item| item.waiver_id) != request.expected_waiver_id {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "review-waiver-current",
            ));
        }
        if request.grant {
            if active.is_some() {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "review-waiver-current",
                ));
            }
            let current = target
                .current_check
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-check-missing"))?;
            if !current
                .rules
                .iter()
                .flat_map(|rule| &rule.findings)
                .any(|finding| finding.issue_id == request.issue_id && finding.waivable)
            {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "review-issue-not-waivable",
                ));
            }
        } else if active.is_none() {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "review-waiver-current",
            ));
        }
        let waiver_id = ExecutionId::new();
        transaction.execute(
            "INSERT INTO review_waivers
             (waiver_id,action_id,project_id,unit_id,locale,basis,issue_id,kind,previous_waiver_id,
              policy_version,actor,reason,request_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![waiver_id.to_string(), request.action_id.to_string(), request.project_id.to_string(),
                request.unit_id.to_string(), request.locale, request.expected_basis, request.issue_id,
                if request.grant { "grant" } else { "revoke" },
                request.expected_waiver_id.map(|id| id.to_string()), POLICY_VERSION,
                request.actor, request.reason, request_digest],
        ).map_err(sql)?;
        transaction.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-waiver-commit")
        })?;
        waiver_by_action(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?,
            request.project_id,
            request.action_id,
        )?
        .map(|item| item.0)
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-waiver-receipt"))
    }

    pub fn allow_source_fallback(
        &mut self,
        request: &FallbackWrite,
    ) -> Result<FallbackDecision, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        checked_actor(&request.actor)?;
        checked_note(&request.reason, true)?;
        let request_digest = digest(request)?;
        let unknown = self.execution_unknown.clone();
        let transaction = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        if let Some((fallback, prior_digest)) =
            fallback_by_action(&transaction, request.project_id, request.action_id)?
        {
            return if prior_digest == request_digest {
                Ok(fallback)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-fallback-action"))
            };
        }
        let target = target_in(
            &transaction,
            request.project_id,
            request.unit_id,
            &request.locale,
        )?;
        if target.basis != request.expected_basis || target.selection_id.is_some() {
            return Err(failure(ErrorCode::DependencyConflict, "review-current"));
        }
        if target
            .current_fallback
            .as_ref()
            .map(|item| item.fallback_id)
            != request.expected_fallback_id
            || request.allow == target.current_fallback.is_some()
        {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "review-fallback-current",
            ));
        }
        let fallback_id = ExecutionId::new();
        transaction.execute(
            "INSERT INTO review_fallbacks
             (fallback_id,action_id,project_id,unit_id,locale,source_revision_id,kind,previous_fallback_id,
              policy_version,actor,reason,request_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![fallback_id.to_string(), request.action_id.to_string(), request.project_id.to_string(),
                request.unit_id.to_string(), request.locale, target.source_revision_id.to_string(),
                if request.allow { "allow" } else { "withdraw" },
                request.expected_fallback_id.map(|id| id.to_string()),
                POLICY_VERSION, request.actor, request.reason, request_digest],
        ).map_err(sql)?;
        transaction.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-fallback-commit")
        })?;
        fallback_by_action(
            self.connection()
                .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?,
            request.project_id,
            request.action_id,
        )?
        .map(|item| item.0)
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-fallback-receipt"))
    }
}

fn all_units(
    connection: &Connection,
    project_id: ExecutionId,
) -> Result<(ExecutionId, Vec<ExecutionId>), ExecutionError> {
    let snapshot: Option<String> = connection
        .query_row(
            "SELECT current_snapshot FROM content_scope WHERE row_id=1",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let Some(snapshot) = snapshot else {
        return Err(failure(ErrorCode::DependencyConflict, "review-source"));
    };
    let snapshot_id = parse_id(snapshot.clone())?;
    let mut statement = connection
        .prepare(
            "SELECT o.unit_id FROM source_occurrences o JOIN source_units u ON u.unit_id=o.unit_id
         WHERE o.snapshot_id=?1 AND u.project_id=?2 ORDER BY o.ordinal LIMIT 10001",
        )
        .map_err(sql)?;
    let units = statement
        .query_map(params![snapshot, project_id.to_string()], |row| {
            row.get::<_, String>(0)
        })
        .map_err(sql)?
        .map(|row| parse_id(row.map_err(sql)?))
        .collect::<Result<Vec<_>, _>>()?;
    if units.is_empty() || units.len() > MAX_SCOPE {
        return Err(failure(ErrorCode::LimitExceeded, "review-scope"));
    }
    Ok((snapshot_id, units))
}

fn assess(target: &ReviewTarget, impacted: bool) -> (Vec<String>, Vec<String>) {
    let mut blockers = Vec::new();
    let mut exceptions = Vec::new();
    if target.selection_id.is_none() {
        if let Some(fallback) = &target.current_fallback {
            exceptions.push(format!("source-fallback:{}", fallback.fallback_id));
        } else {
            blockers.push("translation-missing".to_owned());
        }
    } else {
        match target.current_decision.as_ref().map(|item| item.kind) {
            Some(ReviewDecisionKind::Approve) => {}
            Some(ReviewDecisionKind::RequestChanges) => {
                blockers.push("changes-requested".to_owned())
            }
            None => blockers.push("approval-missing-or-stale".to_owned()),
        }
    }
    if target.term_conflict {
        blockers.push("term-conflict".to_owned());
    }
    match &target.current_check {
        None => blockers.push("qa-missing-or-stale".to_owned()),
        Some(check) => {
            let rules: BTreeSet<&str> = check.rules.iter().map(|rule| rule.rule.as_str()).collect();
            if rules
                != BTreeSet::from([
                    "required-translation",
                    "placeholders",
                    "format",
                    "terminology",
                ])
                || check.rules.len() != 4
            {
                blockers.push("qa-incomplete-coverage".to_owned());
            }
            let waivers: BTreeSet<&str> = target
                .current_waivers
                .iter()
                .map(|item| item.issue_id.as_str())
                .collect();
            for rule in &check.rules {
                if rule.status != "passed"
                    && rule.status != "findings"
                    && rule.status != "not-applicable"
                {
                    blockers.push(format!("qa-unavailable:{}", rule.rule));
                }
                for finding in &rule.findings {
                    if finding.rule == "required-translation"
                        && finding.code == "missing"
                        && target.current_fallback.is_some()
                    {
                        continue;
                    }
                    if finding.waivable && waivers.contains(finding.issue_id.as_str()) {
                        exceptions.push(format!("issue-waiver:{}", finding.issue_id));
                    } else {
                        blockers.push(format!("qa-issue:{}", finding.issue_id));
                    }
                }
            }
        }
    }
    if impacted
        && target.selection_id.is_some()
        && !(matches!(
            target.current_decision.as_ref().map(|item| item.kind),
            Some(ReviewDecisionKind::Approve)
        ) && target.current_check.is_some())
    {
        blockers.push("resource-impact-unresolved".to_owned());
    }
    (blockers, exceptions)
}

fn eligibility_reason(target: &ReviewTarget, reason: &str) -> EligibilityReason {
    let (code, reference) = reason
        .split_once(':')
        .map_or((reason, None), |(code, reference)| {
            (code, Some(reference.to_owned()))
        });
    EligibilityReason {
        unit_id: target.unit_id,
        native_key: target.native_key.clone(),
        code: code.to_owned(),
        reference,
    }
}

impl ProjectStore {
    fn impact_map(
        &self,
        project_id: ExecutionId,
        locale: &str,
    ) -> Result<BTreeMap<ExecutionId, Vec<ExecutionId>>, ExecutionError> {
        let mut offset = 0;
        let mut map: BTreeMap<ExecutionId, Vec<ExecutionId>> = BTreeMap::new();
        loop {
            let page = self.resource_impacts(project_id, locale, offset, 100)?;
            for item in page.items {
                map.entry(item.unit_id)
                    .or_default()
                    .extend(item.reasons.into_iter().map(|reason| reason.change_id));
            }
            match page.next_offset {
                Some(next) if next <= MAX_SCOPE as u32 => offset = next,
                Some(_) => return Err(failure(ErrorCode::LimitExceeded, "review-impact-coverage")),
                None => break,
            }
        }
        Ok(map)
    }

    pub fn review_work_page(
        &self,
        project_id: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<WorkPage, ExecutionError> {
        if limit == 0 || limit > 100 || offset > MAX_SCOPE as u32 {
            return Err(failure(ErrorCode::InvalidInput, "review-work-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        check_project(connection, project_id, locale)?;
        let (_, units) = all_units(connection, project_id)?;
        let impacts = self.impact_map(project_id, locale)?;
        let mut items = Vec::new();
        for unit_id in units {
            let target = target_in(connection, project_id, unit_id, locale)?;
            let (mut reasons, _) = assess(&target, impacts.contains_key(&unit_id));
            if let Some(changes) = impacts.get(&unit_id) {
                if reasons
                    .iter()
                    .any(|reason| reason == "resource-impact-unresolved")
                {
                    reasons.extend(changes.iter().map(|id| format!("resource-change:{id}")));
                }
            }
            if !reasons.is_empty() {
                items.push(WorkItem {
                    unit_id,
                    locale: locale.to_owned(),
                    native_key: target.native_key,
                    reasons,
                    basis: target.basis,
                });
            }
        }
        let total = items.len() as u32;
        let next_offset = (offset + limit < total).then_some(offset + limit);
        Ok(WorkPage {
            items: items
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect(),
            total,
            next_offset,
            coverage: "current-source; full bounded scope".to_owned(),
        })
    }

    pub fn review_eligibility(
        &self,
        project_id: ExecutionId,
        locales: &[String],
    ) -> Result<Eligibility, ExecutionError> {
        if locales.is_empty()
            || locales.len() > 16
            || locales.iter().collect::<BTreeSet<_>>().len() != locales.len()
        {
            return Err(failure(ErrorCode::InvalidInput, "review-locales"));
        }
        let mut requested = locales.to_vec();
        requested.sort();
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        for locale in &requested {
            check_project(connection, project_id, locale)?;
        }
        let (source_snapshot_id, units) = all_units(connection, project_id)?;
        let mut outcomes = Vec::new();
        let mut bases = Vec::new();
        for locale in &requested {
            let impacts = self.impact_map(project_id, locale)?;
            let mut blockers = Vec::new();
            let mut exceptions = Vec::new();
            let mut blocker_count = 0u32;
            let mut exception_count = 0u32;
            for unit_id in &units {
                let target = target_in(connection, project_id, *unit_id, locale)?;
                let (unit_blockers, unit_exceptions) =
                    assess(&target, impacts.contains_key(unit_id));
                blocker_count += unit_blockers.len() as u32;
                exception_count += unit_exceptions.len() as u32;
                let decision_id = target
                    .current_decision
                    .as_ref()
                    .map(|value| value.decision_id);
                let check_id = target.current_check.as_ref().map(|value| value.run_id);
                let fallback_id = target
                    .current_fallback
                    .as_ref()
                    .map(|value| value.fallback_id);
                let waiver_ids: Vec<_> = target
                    .current_waivers
                    .iter()
                    .map(|value| value.waiver_id)
                    .collect();
                let impact_ids = impacts.get(unit_id).cloned();
                bases.push((
                    locale.clone(),
                    *unit_id,
                    target.basis.clone(),
                    decision_id,
                    check_id,
                    fallback_id,
                    waiver_ids,
                    impact_ids,
                    unit_blockers.clone(),
                    unit_exceptions.clone(),
                ));
                for reason in unit_blockers {
                    if blockers.len() < 100 {
                        blockers.push(eligibility_reason(&target, &reason));
                    }
                }
                for reason in unit_exceptions {
                    if exceptions.len() < 100 {
                        exceptions.push(eligibility_reason(&target, &reason));
                    }
                }
            }
            outcomes.push(EligibilityLocale {
                locale: locale.clone(),
                ready: blocker_count == 0,
                blockers,
                exceptions,
                checked_units: units.len() as u32,
                blocker_count,
                exception_count,
            });
        }
        let ready = outcomes.iter().all(|item| item.ready);
        Ok(Eligibility {
            policy_version: POLICY_VERSION.to_owned(),
            source_snapshot_id,
            basis: digest(&(POLICY_VERSION, source_snapshot_id, &bases))?,
            ready,
            locales: outcomes,
        })
    }

    pub fn review_eligibility_if_basis(
        &self,
        project_id: ExecutionId,
        locales: &[String],
        expected_basis: &str,
    ) -> Result<Eligibility, ExecutionError> {
        let current = self.review_eligibility(project_id, locales)?;
        if current.basis != expected_basis {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "review-eligibility-stale",
            ));
        }
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ProjectMetadata, SaveContext, SaveTerm, SaveTranslationRevision, SelectTranslationRevision,
        TranslationAdoptionConfirmation, TranslationAdoptionHandler, TranslationSelectionDecision,
        content::{
            SourceAdoptionHandler, SourceBundle, SourceRunner, TranslationBundle, TranslationRunner,
        },
        execution::{ExecutionRuntime, ExecutionState},
    };
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    fn adopt_source_files(store: &mut ProjectStore, manifest: &[u8], bytes: &[u8]) {
        let bundle = SourceBundle::capture(manifest, bytes, "en").unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(store).unwrap();
        runtime.register(Arc::new(SourceRunner)).unwrap();
        runtime.submit(store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = loop {
            runtime.tick(store).unwrap();
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
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        };
        let preview = store
            .source_preview(input.envelope().attempt_id, result, 0, 50)
            .unwrap();
        let action = store
            .prepare_adoption_with_id(
                ExecutionId::new(),
                input.envelope().attempt_id,
                input.envelope().units[0].unit_id,
                vec![result],
                serde_json::to_value(preview.confirmation).unwrap(),
            )
            .unwrap();
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
    }

    fn adopt_source(store: &mut ProjectStore, bytes: &[u8]) {
        adopt_source_files(
            store,
            br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#,
            bytes,
        );
    }

    fn adopt_translation_files(store: &mut ProjectStore, bytes: &[u8]) {
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        let bundle = TranslationBundle::capture("i18n/zh.json", bytes, "zh-CN", snapshot).unwrap();
        let input = bundle
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        let mut runtime = ExecutionRuntime::new(store).unwrap();
        runtime.register(Arc::new(TranslationRunner)).unwrap();
        runtime.submit(store, &input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            runtime.tick(store).unwrap();
            let valid: i64 = store
                .connection()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM execution_items WHERE attempt_id=?1 AND validation='valid'",
                    [input.envelope().attempt_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            if valid == 532 {
                break;
            }
            assert!(Instant::now() < deadline, "translation import: {valid}/532");
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut rows = Vec::new();
        let mut offset = 0;
        let mut basis = None;
        loop {
            let page = store
                .translation_preview(input.envelope().attempt_id, offset, 100, basis.as_deref())
                .unwrap();
            assert_eq!((page.total, page.unique, page.unmatched), (532, 532, 0));
            rows.extend(page.rows);
            if let Some(next) = page.next_ordinal {
                offset = next;
                basis = Some(page.basis);
            } else {
                break;
            }
        }
        assert_eq!(rows.len(), 532);
        for row in rows {
            let unit = input
                .envelope()
                .units
                .iter()
                .find(|unit| unit.item_ids == vec![row.item_id])
                .unwrap();
            let action = store
                .prepare_adoption_with_id(
                    ExecutionId::new(),
                    input.envelope().attempt_id,
                    unit.unit_id,
                    vec![row.result_id],
                    serde_json::to_value(TranslationAdoptionConfirmation {
                        result_digest: row.result_digest,
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
            store
                .adopt_execution(&action, &TranslationAdoptionHandler)
                .unwrap();
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        ProjectStore,
        ExecutionId,
        Vec<ExecutionId>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(
            directory.path().join("project"),
            ProjectMetadata::create("Review", "en", ["zh-CN", "fr-FR"]).unwrap(),
        )
        .unwrap();
        let project = parse_id(store.metadata().unwrap().project_id().to_string()).unwrap();
        adopt_source(&mut store, br#"{"hello":"Hello {{name}}","plain":"Plain"}"#);
        let page = store.review_page(project, "zh-CN", 0, 10).unwrap();
        (
            directory,
            store,
            project,
            page.rows.iter().map(|row| row.unit_id).collect(),
        )
    }
    fn translate(
        store: &mut ProjectStore,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
        text: &str,
    ) {
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: locale.into(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: target.selection_id,
                text: text.into(),
            })
            .unwrap();
    }
    fn approve(
        store: &mut ProjectStore,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
    ) -> ReviewDecision {
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .write_review(&ReviewWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: locale.into(),
                expected_basis: target.basis,
                expected_decision_id: target.current_decision.map(|value| value.decision_id),
                actor: "Reviewer A".into(),
                kind: ReviewDecisionKind::Approve,
                reason: String::new(),
            })
            .unwrap()
    }
    fn check(
        store: &mut ProjectStore,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
    ) -> CheckRun {
        let target = store.review_target(project, unit, locale).unwrap();
        store
            .run_review_checks(project, unit, locale, &target.basis, ExecutionId::new())
            .unwrap()
    }

    #[test]
    fn real_lookup_source_and_translation_oracle_cover_the_full_review_scope() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(
            directory.path().join("project"),
            ProjectMetadata::create("Lookup review", "en", ["zh-CN"]).unwrap(),
        )
        .unwrap();
        let project = parse_id(store.metadata().unwrap().project_id().to_string()).unwrap();
        adopt_source_files(
            &mut store,
            include_bytes!("../../tests/fixtures/stardew-lookup/manifest.json"),
            include_bytes!("../../tests/fixtures/stardew-lookup/i18n/default.json"),
        );
        let source_oracle: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../tests/fixtures/stardew-lookup/oracle.json"
        ))
        .unwrap();
        let translation_oracle: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../tests/fixtures/stardew-lookup/translation-oracle.json"
        ))
        .unwrap();
        assert_eq!(source_oracle["count"].as_u64(), Some(532));
        assert_eq!(translation_oracle["count"].as_u64(), Some(532));

        let page = store.review_page(project, "zh-CN", 0, 100).unwrap();
        assert_eq!(page.total, 532);
        assert_eq!(page.next_ordinal, Some(100));
        for (target, expected) in page.rows.iter().zip(
            source_oracle["occurrences"]
                .as_array()
                .unwrap()
                .iter()
                .take(100),
        ) {
            assert_eq!(target.native_key, expected["key"].as_str().unwrap());
            assert_eq!(target.source_text, expected["text"].as_str().unwrap());
        }
        adopt_translation_files(
            &mut store,
            include_bytes!("../../tests/fixtures/stardew-lookup/i18n/zh.json"),
        );
        let expected_translations = translation_oracle["entries"].as_array().unwrap();
        let mut offset = 0;
        let mut observed = 0;
        loop {
            let translated_page = store.review_page(project, "zh-CN", offset, 100).unwrap();
            for target in translated_page.rows {
                let expected = expected_translations
                    .iter()
                    .find(|entry| entry["key"] == target.native_key)
                    .unwrap();
                assert_eq!(
                    target.translation_text.as_deref(),
                    expected["text"].as_str()
                );
                assert!(target.selection_id.is_some());
                observed += 1;
            }
            if let Some(next) = translated_page.next_ordinal {
                offset = next;
            } else {
                break;
            }
        }
        assert_eq!(observed, 532);
        for key in ["generic.percent", "generic.percent-chance-of"] {
            let target = page
                .rows
                .iter()
                .find(|target| target.native_key == key)
                .unwrap();
            let expected = translation_oracle["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["key"] == key)
                .unwrap();
            assert_eq!(
                store
                    .review_target(project, target.unit_id, "zh-CN")
                    .unwrap()
                    .translation_text
                    .as_deref(),
                expected["text"].as_str()
            );
            let run = check(&mut store, project, target.unit_id, "zh-CN");
            assert_eq!(run.validator_version, CHECK_VERSION);
            assert_eq!(run.rules.len(), 4);
            assert!(run.rules.iter().all(|rule| rule.findings.is_empty()));
            approve(&mut store, project, target.unit_id, "zh-CN");
        }

        let work = store.review_work_page(project, "zh-CN", 0, 100).unwrap();
        assert_eq!(work.total, 530);
        assert_eq!(work.items.len(), 100);
        assert_eq!(work.next_offset, Some(100));
        let eligibility = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        assert!(!eligibility.ready);
        assert_eq!(eligibility.locales[0].checked_units, 532);
        assert_eq!(eligibility.locales[0].blocker_count, 1_060);
        assert_eq!(eligibility.locales[0].exception_count, 0);

        let affected = page
            .rows
            .iter()
            .find(|target| target.native_key == "generic.percent")
            .unwrap()
            .unit_id;
        store
            .save_term(&SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: "percent".into(),
                aliases: vec![],
                target: "百分比".into(),
                protected: true,
                scope_unit_id: Some(affected),
                expected_revision_id: None,
                reason: "Review changed terminology for this source entry".into(),
            })
            .unwrap();
        let changed = store.review_target(project, affected, "zh-CN").unwrap();
        assert!(changed.current_decision.is_none() && changed.current_check.is_none());
        let updated_work = store.review_work_page(project, "zh-CN", 0, 100).unwrap();
        assert_eq!(updated_work.total, 531);
        assert!(updated_work.items.iter().any(|item| {
            item.unit_id == affected
                && item
                    .reasons
                    .iter()
                    .any(|reason| reason.starts_with("resource-change:"))
        }));
    }

    #[test]
    fn selected_revision_and_resource_guidance_gate_current_evidence() {
        let (_directory, mut store, project, units) = fixture();
        translate(&mut store, project, units[0], "zh-CN", "你好 {{name}}");
        translate(&mut store, project, units[1], "zh-CN", "普通");
        for unit in &units {
            check(&mut store, project, *unit, "zh-CN");
            approve(&mut store, project, *unit, "zh-CN");
        }
        let ready = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        assert!(ready.ready);
        translate(&mut store, project, units[0], "fr-FR", "Bonjour {{name}}");
        assert_eq!(
            store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .basis,
            ready.basis
        );
        store
            .save_term(&SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: "Hello".into(),
                aliases: vec![],
                target: "欢迎".into(),
                protected: true,
                scope_unit_id: Some(units[0]),
                expected_revision_id: None,
                reason: "Preferred term".into(),
            })
            .unwrap();
        let changed = store.review_target(project, units[0], "zh-CN").unwrap();
        assert!(changed.current_check.is_none() && changed.current_decision.is_none());
        let work = store.review_work_page(project, "zh-CN", 0, 10).unwrap();
        let impacted = work
            .items
            .iter()
            .find(|item| item.unit_id == units[0])
            .unwrap();
        assert!(
            impacted
                .reasons
                .iter()
                .any(|reason| reason.starts_with("resource-change:"))
        );
        assert!(!work.items.iter().any(|item| item.unit_id == units[1]));
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
        let run = check(&mut store, project, units[0], "zh-CN");
        let term = run
            .rules
            .iter()
            .flat_map(|rule| &rule.findings)
            .find(|item| item.code == "protected-form")
            .unwrap();
        let waiver = store
            .waive_review_issue(&WaiverWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: units[0],
                locale: "zh-CN".into(),
                expected_basis: changed.basis.clone(),
                issue_id: term.issue_id.clone(),
                grant: true,
                expected_waiver_id: None,
                actor: "Reviewer A".into(),
                reason: "Accepted in this entry".into(),
            })
            .unwrap();
        assert_eq!(waiver.policy_version, POLICY_VERSION);
        approve(&mut store, project, units[0], "zh-CN");
        let after = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        assert!(after.ready);
        assert_eq!(after.locales[0].exception_count, 1);
        store
            .waive_review_issue(&WaiverWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: units[0],
                locale: "zh-CN".into(),
                expected_basis: changed.basis.clone(),
                issue_id: term.issue_id.clone(),
                grant: false,
                expected_waiver_id: Some(waiver.waiver_id),
                actor: "Reviewer A".into(),
                reason: "Exception withdrawn".into(),
            })
            .unwrap();
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
        let history = store
            .review_history(project, units[0], "zh-CN", 0, 10)
            .unwrap();
        assert_eq!(history.waivers.len(), 2);
        assert!(!history.waivers[0].grant && history.waivers[1].grant);
        assert_eq!(
            store
                .review_eligibility_if_basis(project, &["zh-CN".into()], &ready.basis)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
    }

    #[test]
    fn decisions_are_idempotent_checked_and_survive_reopen() {
        let (directory, mut store, project, units) = fixture();
        translate(&mut store, project, units[0], "zh-CN", "你好 {{name}}");
        let target = store.review_target(project, units[0], "zh-CN").unwrap();
        let request = ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: units[0],
            locale: "zh-CN".into(),
            expected_basis: target.basis.clone(),
            expected_decision_id: None,
            actor: "Reviewer A".into(),
            kind: ReviewDecisionKind::Approve,
            reason: String::new(),
        };
        let first = store.write_review(&request).unwrap();
        assert_eq!(store.write_review(&request).unwrap(), first);
        let mut changed = request.clone();
        changed.reason = "different".into();
        assert_eq!(
            store.write_review(&changed).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
        drop(store);
        let mut store = ProjectStore::open(directory.path().join("project")).unwrap();
        let mut competing = request.clone();
        competing.action_id = ExecutionId::new();
        competing.actor = "Reviewer B".into();
        competing.kind = ReviewDecisionKind::RequestChanges;
        competing.reason = "Needs work".into();
        assert_eq!(
            store.write_review(&competing).unwrap_err().code,
            ErrorCode::DependencyConflict
        );
        competing.expected_decision_id = Some(first.decision_id);
        let second = store.write_review(&competing).unwrap();
        assert_eq!(second.kind, ReviewDecisionKind::RequestChanges);
        drop(store);
        let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
        assert_eq!(
            reopened
                .review_target(project, units[0], "zh-CN")
                .unwrap()
                .current_decision
                .unwrap(),
            second
        );
    }

    #[test]
    fn decision_crash_child() {
        let Ok(path) = std::env::var("TSUMUGI_M06_DECISION_PROJECT") else {
            return;
        };
        let request: ReviewWrite =
            serde_json::from_str(&std::env::var("TSUMUGI_M06_DECISION_REQUEST").unwrap()).unwrap();
        let mut store = ProjectStore::open(path).unwrap();
        let _ = store.write_review(&request);
        panic!("review decision crash hook did not abort");
    }

    #[test]
    fn review_decision_reconciles_after_process_death_on_each_side_of_commit() {
        for (point, committed) in [
            ("before-review-decision-commit", false),
            ("after-review-decision-commit", true),
        ] {
            let (directory, mut store, project, units) = fixture();
            let unit = units[0];
            translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
            let target = store.review_target(project, unit, "zh-CN").unwrap();
            let request = ReviewWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                expected_decision_id: None,
                actor: "Reviewer A".into(),
                kind: ReviewDecisionKind::Approve,
                reason: String::new(),
            };
            drop(store);

            let path = directory.path().join("project");
            let hook = directory.path().join("review-decision-hook");
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "persistence::review::tests::decision_crash_child",
                ])
                .env("TSUMUGI_M06_DECISION_PROJECT", &path)
                .env(
                    "TSUMUGI_M06_DECISION_REQUEST",
                    serde_json::to_string(&request).unwrap(),
                )
                .env("TSUMUGI_MIGRATION_CRASH", point)
                .env("TSUMUGI_MIGRATION_HOOK", &hook)
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
                    panic!("review decision crash child timed out");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(std::fs::read_to_string(hook).unwrap(), point);

            let mut reopened = ProjectStore::open(path).unwrap();
            let before = reopened
                .review_history(project, unit, "zh-CN", 0, 10)
                .unwrap();
            assert_eq!(before.decisions.len(), usize::from(committed));
            let receipt = reopened.write_review(&request).unwrap();
            if committed {
                assert_eq!(receipt, before.decisions[0]);
            }
            assert_eq!(
                reopened
                    .review_history(project, unit, "zh-CN", 0, 10)
                    .unwrap()
                    .decisions
                    .len(),
                1
            );
        }
    }

    #[test]
    fn explicit_fallback_needs_a_current_check_and_is_scoped_per_unit() {
        let (_directory, mut store, project, units) = fixture();
        for unit in &units {
            let target = store.review_target(project, *unit, "zh-CN").unwrap();
            let request = FallbackWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: *unit,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                allow: true,
                expected_fallback_id: None,
                actor: "Reviewer A".into(),
                reason: "Source text is intentionally shared".into(),
            };
            store.allow_source_fallback(&request).unwrap();
            assert_eq!(
                store.allow_source_fallback(&request).unwrap().unit_id,
                *unit
            );
        }
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
        for unit in &units {
            check(&mut store, project, *unit, "zh-CN");
        }
        let ready = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        assert!(ready.ready);
        assert_eq!(ready.locales[0].exception_count, 2);
        let current = store.review_target(project, units[0], "zh-CN").unwrap();
        store
            .allow_source_fallback(&FallbackWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: units[0],
                locale: "zh-CN".into(),
                expected_basis: current.basis,
                allow: false,
                expected_fallback_id: current.current_fallback.map(|value| value.fallback_id),
                actor: "Reviewer A".into(),
                reason: "Use a translation instead".into(),
            })
            .unwrap();
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
        assert!(
            !store
                .review_eligibility(project, &["fr-FR".into()])
                .unwrap()
                .ready
        );
    }

    #[test]
    fn old_policy_exceptions_remain_history_but_no_longer_apply() {
        let (_directory, mut store, project, units) = fixture();
        let unit = units[0];
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let fallback = store
            .allow_source_fallback(&FallbackWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                allow: true,
                expected_fallback_id: None,
                actor: "Reviewer A".into(),
                reason: "Intentional source text".into(),
            })
            .unwrap();
        store
            .connection_mut()
            .unwrap()
            .execute(
                "UPDATE review_fallbacks SET policy_version='old-policy' WHERE fallback_id=?1",
                [fallback.fallback_id.to_string()],
            )
            .unwrap();
        assert!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_fallback
                .is_none()
        );
        let history = store.review_history(project, unit, "zh-CN", 0, 10).unwrap();
        assert_eq!(history.fallbacks[0].policy_version, "old-policy");
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
    }

    #[test]
    fn old_validator_waiver_cannot_clear_a_new_check_of_the_same_warning() {
        let (_directory, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
        store
            .save_term(&SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: "Hello".into(),
                aliases: vec![],
                target: "欢迎".into(),
                protected: true,
                scope_unit_id: Some(unit),
                expected_revision_id: None,
                reason: "Preferred term".into(),
            })
            .unwrap();
        let run = check(&mut store, project, unit, "zh-CN");
        let finding = run
            .rules
            .iter()
            .flat_map(|rule| &rule.findings)
            .find(|finding| finding.code == "protected-form")
            .unwrap();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let waiver = store
            .waive_review_issue(&WaiverWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                issue_id: finding.issue_id.clone(),
                grant: true,
                expected_waiver_id: None,
                actor: "Reviewer A".into(),
                reason: "Accepted for this evidence".into(),
            })
            .unwrap();
        assert_eq!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_waivers
                .len(),
            1
        );
        assert!(
            store
                .review_target(project, unit, "fr-FR")
                .unwrap()
                .current_waivers
                .is_empty()
        );

        // Simulate evidence written by the previous validator revision. Its
        // warning text and unit are identical, but its identity predates the
        // validator component of the issue digest.
        let legacy_issue = digest(&(
            unit,
            "zh-CN",
            finding.rule.as_str(),
            finding.code.as_str(),
            finding.detail.as_str(),
        ))
        .unwrap();
        assert_ne!(finding.issue_id, legacy_issue);
        let connection = store.connection_mut().unwrap();
        connection
            .execute(
                "UPDATE review_checks SET validator_version='smapi-prebuild-1',
                 rules_json=replace(rules_json, ?1, ?2) WHERE run_id=?3",
                params![finding.issue_id, legacy_issue, run.run_id.to_string()],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE review_waivers SET issue_id=?1 WHERE waiver_id=?2",
                params![legacy_issue, waiver.waiver_id.to_string()],
            )
            .unwrap();
        let stale = store.review_target(project, unit, "zh-CN").unwrap();
        assert!(stale.current_check.is_none() && stale.current_waivers.is_empty());
        let rerun = check(&mut store, project, unit, "zh-CN");
        assert_eq!(rerun.validator_version, CHECK_VERSION);
        let current = store.review_target(project, unit, "zh-CN").unwrap();
        assert!(current.current_waivers.is_empty());
        assert!(
            store
                .review_work_page(project, "zh-CN", 0, 10)
                .unwrap()
                .items
                .iter()
                .any(|item| item.unit_id == unit
                    && item
                        .reasons
                        .iter()
                        .any(|reason| reason.starts_with("qa-issue:")))
        );
        assert_eq!(
            store
                .review_history(project, unit, "zh-CN", 0, 10)
                .unwrap()
                .waivers
                .len(),
            1
        );
    }

    #[test]
    fn waiver_stays_with_its_language_policy_and_content_basis() {
        let (_directory, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
        store
            .save_term(&SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: "Hello".into(),
                aliases: vec![],
                target: "欢迎".into(),
                protected: true,
                scope_unit_id: Some(unit),
                expected_revision_id: None,
                reason: "Preferred term".into(),
            })
            .unwrap();
        let first = check(&mut store, project, unit, "zh-CN");
        let issue = first
            .rules
            .iter()
            .flat_map(|rule| &rule.findings)
            .find(|finding| finding.code == "protected-form")
            .unwrap()
            .issue_id
            .clone();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let waiver = store
            .waive_review_issue(&WaiverWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                issue_id: issue.clone(),
                grant: true,
                expected_waiver_id: None,
                actor: "Reviewer A".into(),
                reason: "Accepted for this translation".into(),
            })
            .unwrap();
        assert_eq!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_waivers
                .len(),
            1
        );
        assert!(
            store
                .review_target(project, unit, "fr-FR")
                .unwrap()
                .current_waivers
                .is_empty()
        );

        store
            .connection_mut()
            .unwrap()
            .execute(
                "UPDATE review_waivers SET policy_version='previous-policy' WHERE waiver_id=?1",
                [waiver.waiver_id.to_string()],
            )
            .unwrap();
        assert!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_waivers
                .is_empty()
        );
        assert!(
            store
                .review_work_page(project, "zh-CN", 0, 10)
                .unwrap()
                .items
                .iter()
                .any(|item| item.unit_id == unit
                    && item
                        .reasons
                        .iter()
                        .any(|reason| reason.starts_with("qa-issue:")))
        );
        store
            .connection_mut()
            .unwrap()
            .execute(
                "UPDATE review_waivers SET policy_version=?1 WHERE waiver_id=?2",
                params![POLICY_VERSION, waiver.waiver_id.to_string()],
            )
            .unwrap();

        translate(&mut store, project, unit, "zh-CN", "再见 {{name}}");
        let changed = store.review_target(project, unit, "zh-CN").unwrap();
        assert!(changed.current_check.is_none() && changed.current_waivers.is_empty());
        let repeated = check(&mut store, project, unit, "zh-CN");
        assert!(
            repeated
                .rules
                .iter()
                .flat_map(|rule| &rule.findings)
                .any(|finding| finding.issue_id == issue)
        );
        assert!(
            store
                .review_target(project, unit, "zh-CN")
                .unwrap()
                .current_waivers
                .is_empty()
        );
        assert_eq!(
            store
                .review_history(project, unit, "zh-CN", 0, 10)
                .unwrap()
                .waivers
                .len(),
            1
        );
    }

    #[test]
    fn source_fallback_still_blocks_an_invalid_source_marker() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = ProjectStore::create(
            directory.path().join("project"),
            ProjectMetadata::create("Review", "en", ["zh-CN"]).unwrap(),
        )
        .unwrap();
        let project = parse_id(store.metadata().unwrap().project_id().to_string()).unwrap();
        adopt_source(&mut store, br#"{"broken":"Hello {{"}"#);
        let target = store
            .review_page(project, "zh-CN", 0, 10)
            .unwrap()
            .rows
            .remove(0);
        store
            .allow_source_fallback(&FallbackWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: target.unit_id,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                allow: true,
                expected_fallback_id: None,
                actor: "Reviewer A".into(),
                reason: "Intentional source text".into(),
            })
            .unwrap();
        let run = check(&mut store, project, target.unit_id, "zh-CN");
        assert!(
            run.rules
                .iter()
                .flat_map(|rule| &rule.findings)
                .any(|finding| finding.code == "source-marker")
        );
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
    }

    #[test]
    fn schema_six_migration_keeps_a_recoverable_backup() {
        let (directory, mut store, project, _) = fixture();
        let connection = store.connection_mut().unwrap();
        for (name, _) in TABLES.iter().rev() {
            connection
                .execute_batch(&format!("DROP TABLE {name}"))
                .unwrap();
        }
        connection.pragma_update(None, "user_version", 6).unwrap();
        drop(store);
        let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
        assert_eq!(
            reopened.review_page(project, "zh-CN", 0, 10).unwrap().total,
            2
        );
        let backups: Vec<_> = std::fs::read_dir(directory.path().join("project"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("pre-v6"))
            .collect();
        assert_eq!(backups.len(), 1);
        let backup = Connection::open_with_flags(
            backups[0].path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            6
        );
    }

    #[test]
    fn schema_six_crash_child() {
        let Ok(path) = std::env::var("TSUMUGI_M06_CRASH_PROJECT") else {
            return;
        };
        let _ = ProjectStore::open(path);
        panic!("migration crash hook did not run");
    }

    #[test]
    fn schema_six_migration_recovers_across_process_commit_boundaries() {
        for (point, expected) in [
            ("before-review-migration-commit", 6),
            ("after-review-migration-commit", 7),
        ] {
            let (directory, mut store, project, _) = fixture();
            let path = directory.path().join("project");
            let connection = store.connection_mut().unwrap();
            for (name, _) in TABLES.iter().rev() {
                connection
                    .execute_batch(&format!("DROP TABLE {name}"))
                    .unwrap();
            }
            connection.pragma_update(None, "user_version", 6).unwrap();
            drop(store);
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "persistence::review::tests::schema_six_crash_child",
                ])
                .env("TSUMUGI_M06_CRASH_PROJECT", &path)
                .env("TSUMUGI_MIGRATION_CRASH", point)
                .output()
                .unwrap();
            assert!(!child.status.success());
            let database = Connection::open(path.join("project.sqlite3")).unwrap();
            assert_eq!(
                database
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                expected
            );
            drop(database);
            let reopened = ProjectStore::open(&path).unwrap();
            assert_eq!(
                reopened.review_page(project, "zh-CN", 0, 10).unwrap().total,
                2
            );
            assert_eq!(
                std::fs::read_dir(&path)
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_name().to_string_lossy().contains("pre-v6"))
                    .count(),
                if expected == 6 { 2 } else { 1 }
            );
        }
    }

    #[test]
    fn fixed_qa_findings_resolve_and_recur_without_reusing_old_waivers() {
        let (_directory, mut store, project, units) = fixture();
        translate(&mut store, project, units[0], "zh-CN", "你好");
        let first = check(&mut store, project, units[0], "zh-CN");
        let mismatch = first
            .rules
            .iter()
            .flat_map(|item| &item.findings)
            .find(|item| item.code == "marker-mismatch")
            .unwrap()
            .issue_id
            .clone();
        assert!(
            !first
                .rules
                .iter()
                .flat_map(|item| &item.findings)
                .find(|item| item.issue_id == mismatch)
                .unwrap()
                .waivable
        );
        translate(&mut store, project, units[0], "zh-CN", "你好 {{name}}");
        assert!(
            store
                .review_target(project, units[0], "zh-CN")
                .unwrap()
                .current_check
                .is_none()
        );
        let fixed = check(&mut store, project, units[0], "zh-CN");
        assert!(fixed.rules.iter().all(|item| item.findings.is_empty()));
        translate(&mut store, project, units[0], "zh-CN", "再见");
        let again = check(&mut store, project, units[0], "zh-CN");
        assert_eq!(
            again
                .rules
                .iter()
                .flat_map(|item| &item.findings)
                .find(|item| item.code == "marker-mismatch")
                .unwrap()
                .issue_id,
            mismatch
        );
        let history = store
            .review_history(project, units[0], "zh-CN", 0, 10)
            .unwrap();
        assert_eq!(history.checks.len(), 3);
        assert_eq!(history.checks[1].run_id, fixed.run_id);
    }

    #[test]
    fn reselecting_an_old_revision_and_missing_validator_version_cannot_reuse_approval() {
        let (_directory, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
        let first = store.review_target(project, unit, "zh-CN").unwrap();
        let run = check(&mut store, project, unit, "zh-CN");
        approve(&mut store, project, unit, "zh-CN");
        store
            .connection_mut()
            .unwrap()
            .execute(
                "UPDATE review_checks SET validator_version='obsolete' WHERE run_id=?1",
                [run.run_id.to_string()],
            )
            .unwrap();
        let missing = store.review_target(project, unit, "zh-CN").unwrap();
        assert!(missing.current_check.is_none());
        assert!(
            store
                .review_work_page(project, "zh-CN", 0, 10)
                .unwrap()
                .items
                .iter()
                .any(|item| item.unit_id == unit
                    && item.reasons.contains(&"qa-missing-or-stale".to_owned()))
        );
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );

        translate(&mut store, project, unit, "zh-CN", "再见 {{name}}");
        let second = store.review_target(project, unit, "zh-CN").unwrap();
        store
            .select_translation_revision(&SelectTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: second.source_revision_id,
                expected_selection_id: second.selection_id,
                revision_id: first.revision_id.unwrap(),
            })
            .unwrap();
        let restored = store.review_target(project, unit, "zh-CN").unwrap();
        assert_eq!(restored.revision_id, first.revision_id);
        assert_ne!(restored.selection_id, first.selection_id);
        assert!(restored.current_decision.is_none() && restored.current_check.is_none());
        assert_eq!(
            store
                .review_history(project, unit, "zh-CN", 0, 10)
                .unwrap()
                .decisions
                .len(),
            1
        );
    }

    #[test]
    fn deterministic_rules_cover_named_marker_counts_and_malformed_input() {
        let (_directory, mut store, project, units) = fixture();
        let unit = units[0];
        let missing = check(&mut store, project, unit, "zh-CN");
        assert_eq!(
            missing
                .rules
                .iter()
                .map(|rule| (rule.rule.as_str(), rule.status.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("required-translation", "findings"),
                ("placeholders", "not-applicable"),
                ("format", "passed"),
                ("terminology", "not-applicable"),
            ]
        );
        for (text, expected_code, expected_status) in [
            ("你好 {{name}}", None, "passed"),
            ("你好", Some("marker-mismatch"), "findings"),
            (
                "你好 {{name}} {{name}}",
                Some("marker-mismatch"),
                "findings",
            ),
            ("你好 {{other}}", Some("marker-mismatch"), "findings"),
            ("你好 {{name", Some("translation-marker"), "unavailable"),
            ("你好 {{name}}\u{0007}", Some("control-character"), "passed"),
        ] {
            translate(&mut store, project, unit, "zh-CN", text);
            let run = check(&mut store, project, unit, "zh-CN");
            let repeat = check(&mut store, project, unit, "zh-CN");
            assert_eq!(
                run.rules, repeat.rules,
                "check must be deterministic for {text:?}"
            );
            let codes: Vec<_> = run
                .rules
                .iter()
                .flat_map(|rule| rule.findings.iter().map(|finding| finding.code.as_str()))
                .collect();
            assert_eq!(codes.first().copied(), expected_code, "{text:?}");
            assert_eq!(
                run.rules
                    .iter()
                    .find(|rule| rule.rule == "placeholders")
                    .unwrap()
                    .status,
                expected_status,
                "{text:?}"
            );
        }
    }

    #[test]
    fn failed_and_cancelled_checks_remain_distinct_nonpassing_evidence_after_reopen() {
        let (directory, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
        let basis = store.review_target(project, unit, "zh-CN").unwrap().basis;
        let failed_action = ExecutionId::new();
        CHECK_FAIL.with(|flag| flag.set(true));
        let failed = store
            .run_review_checks(project, unit, "zh-CN", &basis, failed_action)
            .unwrap();
        CHECK_FAIL.with(|flag| flag.set(false));
        assert_eq!(failed.outcome, "failed");
        assert!(failed.rules.iter().all(|rule| rule.status == "failed"));
        assert_eq!(
            store
                .run_review_checks(project, unit, "zh-CN", &basis, failed_action)
                .unwrap(),
            failed
        );

        let cancellation = Cancellation::default();
        let (reached, waiting) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        CHECK_BARRIER.with(|barrier| *barrier.borrow_mut() = Some((reached, resume)));
        let signal = cancellation.clone();
        let canceller = std::thread::spawn(move || {
            waiting.recv_timeout(Duration::from_secs(5)).unwrap();
            signal.request();
            release.send(()).unwrap();
        });
        let cancelled = store
            .run_review_checks_with_cancel(
                project,
                unit,
                "zh-CN",
                &basis,
                ExecutionId::new(),
                &cancellation,
            )
            .unwrap();
        canceller.join().unwrap();
        assert_eq!(cancelled.outcome, "cancelled");
        assert!(
            cancelled
                .rules
                .iter()
                .all(|rule| rule.status == "cancelled")
        );
        let work = store.review_work_page(project, "zh-CN", 0, 10).unwrap();
        assert!(work.items.iter().any(|item| {
            item.unit_id == unit
                && item
                    .reasons
                    .iter()
                    .any(|reason| reason == "qa-unavailable:required-translation")
        }));
        drop(store);

        let mut store = ProjectStore::open(directory.path().join("project")).unwrap();
        let current = store.review_target(project, unit, "zh-CN").unwrap();
        assert_eq!(current.current_check.unwrap().outcome, "cancelled");
        let history = store.review_history(project, unit, "zh-CN", 0, 10).unwrap();
        assert_eq!(history.checks.len(), 2);
        assert_eq!(history.checks[0].outcome, "cancelled");
        assert_eq!(history.checks[1].outcome, "failed");
        let passed = check(&mut store, project, unit, "zh-CN");
        assert_eq!(passed.outcome, "completed");
        assert!(passed.rules.iter().all(|rule| rule.status == "passed"));
    }

    #[test]
    fn issue_identity_keeps_distinct_causes_with_the_same_display_text() {
        let (_directory, store, project, units) = fixture();
        let target = store.review_target(project, units[0], "zh-CN").unwrap();
        let a = finding(
            &target,
            "format",
            "unsupported",
            "Same message",
            "error",
            false,
        )
        .unwrap();
        let repeated = finding(
            &target,
            "format",
            "unsupported",
            "Same message",
            "error",
            false,
        )
        .unwrap();
        let other_rule = finding(
            &target,
            "placeholders",
            "unsupported",
            "Same message",
            "error",
            false,
        )
        .unwrap();
        let other_code =
            finding(&target, "format", "invalid", "Same message", "error", false).unwrap();
        assert_eq!(a.issue_id, repeated.issue_id);
        assert_ne!(a.issue_id, other_rule.issue_id);
        assert_ne!(a.issue_id, other_code.issue_id);
        assert_ne!(
            a.issue_id,
            finding(
                &store.review_target(project, units[0], "fr-FR").unwrap(),
                "format",
                "unsupported",
                "Same message",
                "error",
                false,
            )
            .unwrap()
            .issue_id
        );
    }

    #[test]
    fn locale_eligibility_matrix_preserves_partial_and_exception_results() {
        let (_directory, mut store, project, units) = fixture();
        let initial = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        assert!(!initial.ready);
        assert_eq!(initial.locales[0].checked_units, 2);
        for (unit, text) in [(units[0], "你好 {{name}}"), (units[1], "普通")] {
            translate(&mut store, project, unit, "zh-CN", text);
            check(&mut store, project, unit, "zh-CN");
            approve(&mut store, project, unit, "zh-CN");
        }
        let zh_ready = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        assert!(zh_ready.ready);
        assert!(
            !store
                .review_eligibility(project, &["fr-FR".into()])
                .unwrap()
                .ready
        );
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into(), "fr-FR".into()])
                .unwrap()
                .ready
        );

        for unit in &units {
            let target = store.review_target(project, *unit, "fr-FR").unwrap();
            store
                .allow_source_fallback(&FallbackWrite {
                    project_id: project,
                    action_id: ExecutionId::new(),
                    unit_id: *unit,
                    locale: "fr-FR".into(),
                    expected_basis: target.basis,
                    allow: true,
                    expected_fallback_id: None,
                    actor: "Reviewer A".into(),
                    reason: "Source text is accepted for this unit".into(),
                })
                .unwrap();
            check(&mut store, project, *unit, "fr-FR");
        }
        let both = store
            .review_eligibility(project, &["zh-CN".into(), "fr-FR".into()])
            .unwrap();
        assert!(both.ready);
        assert_eq!(both.locales[0].locale, "fr-FR");
        assert_eq!(both.locales[0].exception_count, 2);
        assert_eq!(both.locales[1].exception_count, 0);

        translate(&mut store, project, units[0], "zh-CN", "你好");
        let after_edit = store
            .review_eligibility(project, &["zh-CN".into(), "fr-FR".into()])
            .unwrap();
        assert!(!after_edit.ready);
        assert!(after_edit.locales[0].ready);
        assert!(!after_edit.locales[1].ready);
        assert_eq!(
            store
                .review_eligibility_if_basis(
                    project,
                    &["zh-CN".into(), "fr-FR".into()],
                    &both.basis,
                )
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
    }

    #[test]
    fn work_projection_is_repeatable_and_does_not_hide_unknown_impact_coverage() {
        let (directory, store, project, _) = fixture();
        let before = store.review_work_page(project, "zh-CN", 0, 1).unwrap();
        assert_eq!(before.total, 2);
        assert_eq!(before.items.len(), 1);
        assert_eq!(before.next_offset, Some(1));
        assert_eq!(
            before,
            store.review_work_page(project, "zh-CN", 0, 1).unwrap()
        );
        assert_eq!(
            store
                .review_work_page(project, "zh-CN", 0, 101)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        drop(store);
        let mut store = ProjectStore::open(directory.path().join("project")).unwrap();
        assert_eq!(
            before,
            store.review_work_page(project, "zh-CN", 0, 1).unwrap()
        );
        store
            .connection_mut()
            .unwrap()
            .execute("DROP TABLE resource_changes", [])
            .unwrap();
        assert!(store.review_work_page(project, "zh-CN", 0, 10).is_err());
        assert!(
            store
                .review_eligibility(project, &["zh-CN".into()])
                .is_err()
        );
    }

    #[test]
    fn work_projection_deduplicates_a_unit_and_preserves_distinct_m05_causes() {
        let (directory, mut store, project, units) = fixture();
        let unit = units[0];
        translate(&mut store, project, unit, "zh-CN", "你好 {{name}}");
        check(&mut store, project, unit, "zh-CN");
        approve(&mut store, project, unit, "zh-CN");
        let source_revision_id = store
            .review_target(project, unit, "zh-CN")
            .unwrap()
            .source_revision_id;
        store
            .save_context(&SaveContext {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id,
                expected_revision_id: None,
                text: "Greeting shown to the player".into(),
                reason: "Review context".into(),
            })
            .unwrap();
        store
            .save_term(&SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: "Hello".into(),
                aliases: vec![],
                target: "欢迎".into(),
                protected: true,
                scope_unit_id: Some(unit),
                expected_revision_id: None,
                reason: "Review terminology".into(),
            })
            .unwrap();

        let impacts = store.resource_impacts(project, "zh-CN", 0, 100).unwrap();
        let impact = impacts
            .items
            .iter()
            .find(|item| item.unit_id == unit)
            .unwrap();
        assert_eq!(impact.reasons.len(), 2);
        let expected: BTreeSet<_> = impact
            .reasons
            .iter()
            .map(|reason| format!("resource-change:{}", reason.change_id))
            .collect();
        assert_eq!(expected.len(), 2);

        let work = store.review_work_page(project, "zh-CN", 0, 100).unwrap();
        let matching: Vec<_> = work
            .items
            .iter()
            .filter(|item| item.unit_id == unit)
            .collect();
        assert_eq!(matching.len(), 1);
        let actual: BTreeSet<_> = matching[0]
            .reasons
            .iter()
            .filter(|reason| reason.starts_with("resource-change:"))
            .cloned()
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(
            work,
            store.review_work_page(project, "zh-CN", 0, 100).unwrap()
        );
        drop(store);
        let store = ProjectStore::open(directory.path().join("project")).unwrap();
        assert_eq!(
            work,
            store.review_work_page(project, "zh-CN", 0, 100).unwrap()
        );
    }

    #[test]
    fn oversized_current_source_is_not_reported_as_empty_work_or_ready() {
        let (_directory, mut store, project, _) = fixture();
        let connection = store.connection_mut().unwrap();
        let (snapshot, artifact): (String, String) = connection
            .query_row(
                "SELECT snapshot_id,artifact_id FROM source_occurrences LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        for ordinal in 2..=MAX_SCOPE {
            let unit = ExecutionId::new().to_string();
            let revision = ExecutionId::new().to_string();
            let occurrence = ExecutionId::new().to_string();
            let key = format!("generated-{ordinal}");
            transaction
                .execute(
                    "INSERT INTO source_units(unit_id,project_id) VALUES (?1,?2)",
                    params![unit, project.to_string()],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO source_revisions(revision_id,unit_id,revision,text) VALUES (?1,?2,1,'Value')",
                    params![revision, unit],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO source_occurrences(occurrence_id,snapshot_id,ordinal,artifact_id,unit_id,revision_id,namespace,native_key,comparison_key,key_start,key_end,value_start,value_end)
                     VALUES (?1,?2,?3,?4,?5,?6,'default',?7,?7,0,1,1,2)",
                    params![occurrence, snapshot, ordinal as i64, artifact, unit, revision, key],
                )
                .unwrap();
            if ordinal == MAX_SCOPE - 1 {
                assert_eq!(all_units(&transaction, project).unwrap().1.len(), MAX_SCOPE);
            }
        }
        transaction.commit().unwrap();
        assert_eq!(
            store.review_page(project, "zh-CN", 0, 50).unwrap_err().code,
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            store
                .review_work_page(project, "zh-CN", 0, 50)
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn exceeded_m05_selection_coverage_is_not_reported_as_empty_work_or_ready() {
        let (_directory, mut store, project, _) = fixture();
        let connection = store.connection_mut().unwrap();
        let (snapshot, artifact): (String, String) = connection
            .query_row(
                "SELECT snapshot_id,artifact_id FROM source_occurrences LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        for ordinal in 2..=2_002 {
            let unit = ExecutionId::new().to_string();
            let source_revision = ExecutionId::new().to_string();
            let translation_revision = ExecutionId::new().to_string();
            let key = format!("selected-{ordinal}");
            transaction
                .execute(
                    "INSERT INTO source_units(unit_id,project_id) VALUES (?1,?2)",
                    params![unit, project.to_string()],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO source_revisions(revision_id,unit_id,revision,text) VALUES (?1,?2,1,'Value')",
                    params![source_revision, unit],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO source_occurrences(occurrence_id,snapshot_id,ordinal,artifact_id,unit_id,revision_id,namespace,native_key,comparison_key,key_start,key_end,value_start,value_end)
                     VALUES (?1,?2,?3,?4,?5,?6,'default',?7,?7,0,1,1,2)",
                    params![ExecutionId::new().to_string(), snapshot, ordinal, artifact, unit, source_revision, key],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO translation_revisions(revision_id,project_id,unit_id,locale,ordinal,text,source_snapshot_id,source_revision_id,origin_kind,action_id,request_digest)
                     VALUES (?1,?2,?3,'zh-CN',1,'译文',?4,?5,'manual',?6,?7)",
                    params![translation_revision, project.to_string(), unit, snapshot, source_revision, ExecutionId::new().to_string(), "0".repeat(64)],
                )
                .unwrap();
            transaction
                .execute(
                    "INSERT INTO translation_selections(event_id,project_id,unit_id,locale,sequence,revision_id,action_id,request_digest)
                     VALUES (?1,?2,?3,'zh-CN',1,?4,?5,?6)",
                    params![ExecutionId::new().to_string(), project.to_string(), unit, translation_revision, ExecutionId::new().to_string(), "0".repeat(64)],
                )
                .unwrap();
        }
        transaction.commit().unwrap();

        assert_eq!(
            store
                .resource_impacts(project, "zh-CN", 0, 100)
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            store
                .review_work_page(project, "zh-CN", 0, 100)
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn current_views_do_not_write_project_state() {
        let (_directory, mut store, project, units) = fixture();
        let before: i64 = store
            .connection_mut()
            .unwrap()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap();
        let _ = store.review_page(project, "zh-CN", 0, 10).unwrap();
        let _ = store.review_target(project, units[0], "zh-CN").unwrap();
        let _ = store
            .review_history(project, units[0], "zh-CN", 0, 10)
            .unwrap();
        let _ = store.review_work_page(project, "zh-CN", 0, 10).unwrap();
        let _ = store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap();
        let after: i64 = store
            .connection_mut()
            .unwrap()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn eligibility_locale_set_has_one_canonical_basis() {
        let (_directory, store, project, _) = fixture();
        let a = store
            .review_eligibility(project, &["zh-CN".into(), "fr-FR".into()])
            .unwrap();
        let b = store
            .review_eligibility(project, &["fr-FR".into(), "zh-CN".into()])
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(a.locales.len(), 2);
        assert!(!a.ready);
    }
}
