//! Comparison and contribution records reference the ordinary project history.
use super::{ProjectStore, translation::SaveTranslationRevision};
use crate::{
    ai::{arena::*, error},
    execution::*,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const TABLES: &[(&str, &str)] = &[
    (
        "arena_comparisons",
        "CREATE TABLE arena_comparisons (comparison_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, unit_id TEXT NOT NULL REFERENCES source_units(unit_id), locale TEXT NOT NULL, blind INTEGER NOT NULL CHECK(blind IN (0,1)), request_digest TEXT NOT NULL CHECK(length(request_digest)=64))",
    ),
    (
        "arena_entries",
        "CREATE TABLE arena_entries (comparison_id TEXT NOT NULL REFERENCES arena_comparisons(comparison_id), ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 3), revision_id TEXT NOT NULL REFERENCES translation_revisions(revision_id), PRIMARY KEY(comparison_id,ordinal), UNIQUE(comparison_id,revision_id))",
    ),
    (
        "arena_reveals",
        "CREATE TABLE arena_reveals (comparison_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL CHECK(length(request_digest)=64))",
    ),
    (
        "translation_contributors",
        "CREATE TABLE translation_contributors (revision_id TEXT NOT NULL REFERENCES translation_revisions(revision_id), parent_revision_id TEXT NOT NULL REFERENCES translation_revisions(revision_id), ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 3), PRIMARY KEY(revision_id,parent_revision_id), UNIQUE(revision_id,ordinal), CHECK(revision_id<>parent_revision_id))",
    ),
];
pub(super) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(n, _)| n.to_string())
}
pub(super) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        c.execute_batch(sql)?;
    }
    Ok(())
}
pub(super) fn migrate(c: &mut Connection) -> rusqlite::Result<()> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    initialize(&tx)?;
    if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    tx.pragma_update(None, "user_version", 11)?;
    #[cfg(test)]
    super::migration_crash_hook("before-arena-migration-commit");
    tx.commit()?;
    #[cfg(test)]
    super::migration_crash_hook("after-arena-migration-commit");
    Ok(())
}
#[cfg(test)]
pub(super) fn drop_for_legacy_fixture(c: &Connection) -> rusqlite::Result<()> {
    for (name, _) in TABLES.iter().rev() {
        c.execute_batch(&format!("DROP TABLE IF EXISTS {name}"))?;
    }
    Ok(())
}
pub(super) fn validate(c: &Connection) -> rusqlite::Result<()> {
    for (name, expected) in TABLES {
        let actual: String =
            c.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [name], |r| {
                r.get(0)
            })?;
        if actual != *expected {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    if c.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let invalid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM arena_entries e JOIN arena_comparisons a USING(comparison_id) JOIN translation_revisions r USING(revision_id) WHERE r.project_id<>a.project_id OR r.unit_id<>a.unit_id OR r.locale<>a.locale) OR EXISTS(SELECT 1 FROM translation_contributors e JOIN translation_revisions r ON r.revision_id=e.revision_id JOIN translation_revisions p ON p.revision_id=e.parent_revision_id WHERE r.project_id<>p.project_id OR r.unit_id<>p.unit_id OR r.locale<>p.locale OR r.source_revision_id<>p.source_revision_id OR r.ordinal<=p.ordinal) OR EXISTS(SELECT 1 FROM arena_comparisons a WHERE (SELECT COUNT(*) FROM arena_entries e WHERE e.comparison_id=a.comparison_id) NOT BETWEEN 2 AND 4)",[],|r|r.get(0))?;
    if invalid {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let bad:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM arena_comparisons a JOIN source_units u USING(unit_id) WHERE a.project_id<>u.project_id OR a.project_id<>(SELECT project_id FROM project_metadata)) OR EXISTS(SELECT 1 FROM arena_comparisons a WHERE (SELECT MIN(ordinal) FROM arena_entries e WHERE e.comparison_id=a.comparison_id)<>0 OR (SELECT MAX(ordinal)+1 FROM arena_entries e WHERE e.comparison_id=a.comparison_id)<>(SELECT COUNT(*) FROM arena_entries e WHERE e.comparison_id=a.comparison_id)) OR EXISTS(SELECT 1 FROM translation_contributors e JOIN translation_revisions r ON r.revision_id=e.revision_id WHERE r.origin_kind<>'manual' OR (SELECT COUNT(*) FROM translation_contributors x WHERE x.revision_id=e.revision_id) NOT BETWEEN 2 AND 4 OR (SELECT MIN(ordinal) FROM translation_contributors x WHERE x.revision_id=e.revision_id)<>0 OR (SELECT MAX(ordinal)+1 FROM translation_contributors x WHERE x.revision_id=e.revision_id)<>(SELECT COUNT(*) FROM translation_contributors x WHERE x.revision_id=e.revision_id))",[],|r|r.get(0))?;
    if bad {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut reveals = c.prepare("SELECT comparison_id,project_id,action_id FROM arena_reveals")?;
    for row in reveals.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (comparison, project, action) = row?;
        for value in [&comparison, &project, &action] {
            if ExecutionId::parse(value).is_err() {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        let found:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM arena_comparisons WHERE comparison_id=?1 AND project_id=?2)",params![comparison,project],|r|r.get(0))?;
        if !found {
            let input = super::ledger::load_input(
                c,
                ExecutionId::parse(&comparison).map_err(|_| rusqlite::Error::InvalidQuery)?,
            )
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
            settings(&input).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if input.envelope().project_id.to_string() != project {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
    }
    Ok(())
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeBasis {
    pub contributors: Vec<ExecutionId>,
    pub expected_basis: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparisonRequest {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub revision_ids: Vec<ExecutionId>,
    pub blind: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonEntry {
    pub revision_id: ExecutionId,
    pub text: String,
    pub source_revision_id: ExecutionId,
    pub origin_kind: String,
    pub contributors: Vec<ExecutionId>,
    pub model: Option<String>,
    pub recipe: Option<String>,
    pub basis_current: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonView {
    pub comparison_id: Option<ExecutionId>,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub source_text: String,
    pub native_key: String,
    pub selection_id: Option<ExecutionId>,
    pub selected_revision_id: Option<ExecutionId>,
    pub basis: String,
    pub blind: bool,
    pub revealed: bool,
    pub rows: Vec<ComparisonEntry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonSummary {
    pub comparison_id: ExecutionId,
    pub native_key: String,
    pub locale: String,
}
fn sql(e: rusqlite::Error) -> ExecutionError {
    super::ledger::sql_error(e)
}
fn id(s: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&s)
}
fn checked_ids(ids: &[ExecutionId]) -> Result<(), ExecutionError> {
    if !(2..=4).contains(&ids.len()) || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        Err(error(ErrorCode::InvalidInput, "arena-candidates"))
    } else {
        Ok(())
    }
}
pub(super) fn contributors(
    c: &Connection,
    revision: ExecutionId,
) -> Result<Vec<ExecutionId>, ExecutionError> {
    c.prepare("SELECT parent_revision_id FROM translation_contributors WHERE revision_id=?1 ORDER BY ordinal").map_err(sql)?.query_map([revision.to_string()],|r|r.get::<_,String>(0)).map_err(sql)?.map(|r|id(r.map_err(sql)?)).collect()
}
pub(super) fn check_merge(
    c: &Connection,
    request: &SaveTranslationRevision,
    merge: &MergeBasis,
) -> Result<(), ExecutionError> {
    checked_ids(&merge.contributors)?;
    let target = super::review::target_in(c, request.project_id, request.unit_id, &request.locale)?;
    if target.basis != merge.expected_basis {
        return Err(error(ErrorCode::DependencyConflict, "arena-basis"));
    }
    for parent in &merge.contributors {
        let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM translation_revisions WHERE revision_id=?1 AND project_id=?2 AND unit_id=?3 AND locale=?4 AND source_revision_id=?5)",params![parent.to_string(),request.project_id.to_string(),request.unit_id.to_string(),request.locale,request.source_revision_id.to_string()],|r|r.get(0)).map_err(sql)?;
        if !valid {
            return Err(error(ErrorCode::DependencyConflict, "arena-contributor"));
        }
    }
    Ok(())
}
impl ProjectStore {
    pub fn preview_arena(
        &self,
        config: ArenaConfig,
        locale: &str,
        units: &[ExecutionId],
    ) -> Result<ArenaPreview, ExecutionError> {
        config.validate(units.len())?;
        if let Some(parent) = config.parent_attempt_id {
            let input = self.execution_input(parent)?;
            settings(&input)?;
            let p = self.execution_attempt(parent, true)?.progress;
            if p.queued > 0 || p.running > 0 {
                return Err(error(ErrorCode::Busy, "arena-parent"));
            }
        }
        let previews = config
            .variants
            .iter()
            .enumerate()
            .map(|(slot, _)| self.preview_ai(config.request_config(slot)?, locale, units))
            .collect::<Result<Vec<_>, _>>()?;
        let mut items = Vec::new();
        for (order, _) in units.iter().enumerate() {
            for (slot, p) in previews.iter().enumerate() {
                items.push(ArenaItem {
                    slot,
                    source_order: order,
                    item: p.items[order].clone(),
                });
            }
        }
        let digest = digest(&config, &items)?;
        Ok(ArenaPreview {
            config,
            items,
            digest,
        })
    }
    pub fn arena_revealed(
        &self,
        project: ExecutionId,
        comparison: ExecutionId,
    ) -> Result<bool, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "arena-read"))?;
        c.query_row(
            "SELECT EXISTS(SELECT 1 FROM arena_reveals WHERE comparison_id=?1 AND project_id=?2)",
            params![comparison.to_string(), project.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)
    }
    pub fn reveal_arena(
        &mut self,
        project: ExecutionId,
        comparison: ExecutionId,
        action: ExecutionId,
    ) -> Result<(), ExecutionError> {
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "arena-session"));
        }
        let digest = codec::digest(&codec::encode(
            &(project, comparison, action),
            MAX_INPUT_BYTES,
        )?);
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "arena-read"))?;
        let owner: Option<String> = c
            .query_row(
                "SELECT project_id FROM arena_comparisons WHERE comparison_id=?1",
                [comparison.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        if let Some(owner) = owner {
            if owner != project.to_string() {
                return Err(error(ErrorCode::Unauthorized, "arena-project"));
            }
        } else {
            let input = self.execution_input(comparison)?;
            settings(&input)?;
            if input.envelope().project_id != project {
                return Err(error(ErrorCode::Unauthorized, "arena-project"));
            }
        }
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| error(ErrorCode::StorageFailed, "arena-write"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        if let Some(saved) = tx
            .query_row(
                "SELECT request_digest FROM arena_reveals WHERE action_id=?1",
                [action.to_string()],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(sql)?
        {
            if saved != digest {
                return Err(error(ErrorCode::ResultMismatch, "arena-action"));
            }
            return Ok(());
        }
        tx.execute("INSERT INTO arena_reveals (comparison_id,project_id,action_id,request_digest) VALUES (?1,?2,?3,?4) ON CONFLICT(comparison_id) DO NOTHING",params![comparison.to_string(),project.to_string(),action.to_string(),digest]).map_err(sql)?;
        tx.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            error(ErrorCode::OutcomeUnknown, "arena-commit")
        })
    }
    pub fn preview_comparison(
        &self,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
        revisions: &[ExecutionId],
    ) -> Result<ComparisonView, ExecutionError> {
        checked_ids(revisions)?;
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "arena-read"))?;
        let target = super::review::target_in(c, project, unit, locale)?;
        let mut rows = Vec::new();
        for revision in revisions {
            let raw:(String,String,String,Option<String>,Option<String>)=c.query_row("SELECT text,source_revision_id,origin_kind,attempt_id,item_id FROM translation_revisions WHERE revision_id=?1 AND project_id=?2 AND unit_id=?3 AND locale=?4",params![revision.to_string(),project.to_string(),unit.to_string(),locale],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(sql)?;
            let (text, source, origin, attempt, item) = raw;
            let (model, recipe) = if let (Some(attempt), Some(item)) = (attempt, item) {
                let input = self.execution_input(id(attempt)?)?;
                if input.envelope().operation == OPERATION {
                    let s = settings(&input)?;
                    let p = item_payload(&input, id(item)?)?;
                    (
                        Some(s.config.variants[p.slot].model.clone()),
                        Some(s.recipe),
                    )
                } else if input.envelope().operation == crate::ai::OPERATION {
                    let s = crate::ai::settings(&input)?;
                    (Some(s.config.model), Some(s.recipe))
                } else {
                    (None, None)
                }
            } else {
                (None, None)
            };
            let source_id = id(source)?;
            let changed = super::resources::revision_resources_changed(
                c,
                *revision,
                unit,
                locale,
                &target.source_text,
            )?;
            rows.push(ComparisonEntry {
                revision_id: *revision,
                text,
                source_revision_id: source_id,
                origin_kind: origin,
                contributors: contributors(c, *revision)?,
                model,
                recipe,
                basis_current: source_id == target.source_revision_id && !changed,
            });
        }
        Ok(ComparisonView {
            comparison_id: None,
            unit_id: unit,
            locale: locale.into(),
            source_revision_id: target.source_revision_id,
            source_text: target.source_text,
            native_key: target.native_key,
            selection_id: target.selection_id,
            selected_revision_id: target.revision_id,
            basis: target.basis,
            blind: false,
            revealed: true,
            rows,
        })
    }
    pub fn create_comparison(
        &mut self,
        request: &ComparisonRequest,
    ) -> Result<ComparisonView, ExecutionError> {
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "arena-session"));
        }
        let digest = codec::digest(&codec::encode(request, MAX_INPUT_BYTES)?);
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "arena-read"))?;
        let saved: Option<String> = c
            .query_row(
                "SELECT request_digest FROM arena_comparisons WHERE comparison_id=?1",
                [request.action_id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        if let Some(saved) = saved {
            if saved != digest {
                return Err(error(ErrorCode::ResultMismatch, "arena-action"));
            }
            return self.read_comparison(request.project_id, request.action_id);
        }
        self.preview_comparison(
            request.project_id,
            request.unit_id,
            &request.locale,
            &request.revision_ids,
        )?;
        let order = shuffled_order(request.revision_ids.len(), request.blind);
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| error(ErrorCode::StorageFailed, "arena-write"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        tx.execute(
            "INSERT INTO arena_comparisons VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                request.action_id.to_string(),
                request.project_id.to_string(),
                request.unit_id.to_string(),
                request.locale,
                request.blind,
                digest
            ],
        )
        .map_err(sql)?;
        for (ordinal, index) in order.iter().enumerate() {
            tx.execute(
                "INSERT INTO arena_entries VALUES (?1,?2,?3)",
                params![
                    request.action_id.to_string(),
                    ordinal as i64,
                    request.revision_ids[*index].to_string()
                ],
            )
            .map_err(sql)?;
        }
        tx.commit().map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            error(ErrorCode::OutcomeUnknown, "arena-commit")
        })?;
        self.read_comparison(request.project_id, request.action_id)
    }
    pub fn read_comparison(
        &self,
        project: ExecutionId,
        comparison: ExecutionId,
    ) -> Result<ComparisonView, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "arena-read"))?;
        let (unit,locale,blind):(String,String,bool)=c.query_row("SELECT unit_id,locale,blind FROM arena_comparisons WHERE comparison_id=?1 AND project_id=?2",params![comparison.to_string(),project.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
        let refs = c
            .prepare(
                "SELECT revision_id FROM arena_entries WHERE comparison_id=?1 ORDER BY ordinal",
            )
            .map_err(sql)?
            .query_map([comparison.to_string()], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .map(|r| id(r.map_err(sql)?))
            .collect::<Result<Vec<_>, _>>()?;
        let mut view = self.preview_comparison(project, id(unit)?, &locale, &refs)?;
        view.comparison_id = Some(comparison);
        view.blind = blind;
        view.revealed = !blind || self.arena_revealed(project, comparison)?;
        if !view.revealed {
            for row in &mut view.rows {
                row.model = None;
                row.recipe = None;
            }
        }
        Ok(view)
    }
    pub fn list_comparisons(
        &self,
        project: ExecutionId,
    ) -> Result<Vec<ComparisonSummary>, ExecutionError> {
        // Listing history must not require every historical unit to be currently editable.
        self.connection().map_err(|_| error(ErrorCode::StorageFailed, "arena-read"))?
            .prepare("SELECT a.comparison_id,o.native_key,a.locale FROM arena_comparisons a JOIN source_occurrences o ON o.unit_id=a.unit_id AND o.rowid=(SELECT MAX(rowid) FROM source_occurrences WHERE unit_id=a.unit_id) WHERE a.project_id=?1 ORDER BY a.rowid DESC LIMIT 100")
            .map_err(sql)?.query_map([project.to_string()], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))
            .map_err(sql)?.map(|r| {let (comparison, native_key, locale)=r.map_err(sql)?;Ok(ComparisonSummary {comparison_id:id(comparison)?,native_key,locale})}).collect()
    }
}
