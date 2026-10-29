//! Project-local memory is a read projection of the original translation history.
use super::*;
use crate::{ReviewDecision, ReviewDecisionKind, ReviewTarget};

const MAX_PAGE_BYTES: usize = 1024 * 1024;
const MAX_ORIGIN_BYTES: usize = 4096;

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranslationMemorySelection { All, Current, Historical }

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationMemoryFilter {
    pub source_locale: String,
    pub target_locale: String,
    pub source_text: Option<String>,
    pub translation_text: Option<String>,
    pub origin: Option<TranslationOrigin>,
    pub selection: TranslationMemorySelection,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationMemoryQuality {
    /// Latest decision on this exact donor revision, including request-changes.
    pub latest_decision: Option<ReviewDecision>,
    /// A historical approval does not grant current applicability or target approval.
    pub past_approval: Option<ReviewDecision>,
    /// Present only when the original review owner still admits this exact basis.
    pub current_approval: Option<ReviewDecision>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationMemorySourceLabel {
    /// Representative first occurrence in the donor revision's original snapshot.
    pub namespace: String,
    pub native_key: String,
    pub occurrence_count: u32,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationMemoryEntry {
    pub project_id: ExecutionId,
    /// Identity and immutable content only; changing review/selection is independent.
    pub basis: String,
    pub source_locale: String,
    pub source_text: String,
    pub source_label: TranslationMemorySourceLabel,
    pub is_current_source: bool,
    pub revision: TranslationRevision,
    pub is_current_selection: bool,
    pub quality: TranslationMemoryQuality,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationMemoryPage {
    pub project_id: ExecutionId,
    pub filter: TranslationMemoryFilter,
    pub basis: String,
    pub rows: Vec<TranslationMemoryEntry>,
    pub next_cursor: Option<String>,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareTranslationMemoryReuse {
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub expected_selection_id: Option<ExecutionId>,
    pub donor_unit_id: ExecutionId,
    pub donor_revision_id: ExecutionId,
    pub donor_basis: String,
}

/// Reuse is provenance, not a selection, approval, or dependency on future donor edits.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationReuseOrigin {
    pub target_source_snapshot_id: ExecutionId,
    pub target_unit_id: ExecutionId,
    pub target_source_revision_id: ExecutionId,
    pub target_selection_id: Option<ExecutionId>,
    pub donor_unit_id: ExecutionId,
    pub donor_source_revision_id: ExecutionId,
    pub donor_translation_revision_id: ExecutionId,
    pub donor_basis: String,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationMemoryReusePreview {
    pub target: ReviewTarget,
    pub donor: TranslationMemoryEntry,
    pub reuse_origin: TranslationReuseOrigin,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor { basis: String, after: i64 }

fn checked_project(c: &Connection, project: ExecutionId, locale: &str) -> Result<String, ExecutionError> {
    check_target(c, project, locale)?;
    Ok(super::super::read_metadata_from(c)
        .map_err(|_| error(ErrorCode::CorruptLedger, "tm-project"))?
        .source_locale().as_str().to_owned())
}

fn check_filter(c: &Connection, project: ExecutionId, filter: &TranslationMemoryFilter) -> Result<(), ExecutionError> {
    if checked_project(c, project, &filter.target_locale)? != filter.source_locale {
        return Err(error(ErrorCode::InvalidInput, "tm-source-locale"));
    }
    for value in [&filter.source_text, &filter.translation_text].into_iter().flatten() {
        if value.len() > 512 || value.is_empty() || value.contains('\0') {
            return Err(error(ErrorCode::InvalidInput, "tm-filter"));
        }
    }
    Ok(())
}

fn donor_content(c: &Connection, project: ExecutionId, unit: ExecutionId, locale: &str,
    revision: ExecutionId) -> Result<(TranslationRevision, String, String), ExecutionError> {
    let metadata = super::super::read_metadata_from(c)
        .map_err(|_| error(ErrorCode::CorruptLedger, "tm-project"))?;
    if metadata.project_id().to_string() != project.to_string() {
        return Err(error(ErrorCode::Unauthorized, "tm-project"));
    }
    if crate::Locale::parse(locale).ok().as_ref().map(crate::Locale::as_str) != Some(locale) {
        return Err(error(ErrorCode::InvalidInput, "tm-locale"));
    }
    let source_locale = metadata.source_locale().as_str().to_owned();
    let belongs: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM translation_revisions
        WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND revision_id=?4)",
        params![project.to_string(),unit.to_string(),locale,revision.to_string()], |r| r.get(0))
        .map_err(super::super::ledger::sql_error)?;
    if !belongs { return Err(error(ErrorCode::DependencyConflict, "tm-donor-scope")); }
    let revision = revision_view_in(c, revision_in(c, project, revision)?)?;
    if revision.unit_id != unit || revision.locale != locale {
        return Err(error(ErrorCode::DependencyConflict, "tm-donor-scope"));
    }
    let source: String = c.query_row("SELECT text FROM source_revisions WHERE unit_id=?1 AND revision_id=?2",
        params![unit.to_string(), revision.source_revision_id.to_string()], |r| r.get(0))
        .map_err(super::super::ledger::sql_error)?;
    Ok((revision, source, source_locale))
}

fn donor_basis(project: ExecutionId, revision: &TranslationRevision, source_locale: &str,
    source: &str) -> Result<String, ExecutionError> {
    // Mutable candidate/review/selection projections never redefine donor identity.
    // The original row's immutable reuse origin is included without following a chain.
    request_digest(&(project, revision.revision_id, revision.unit_id, &revision.locale,
        revision.source_snapshot_id, revision.source_revision_id, &revision.text,
        revision.origin_kind, &revision.reuse_origin, source_locale, source))
}

fn historical_decision(c: &Connection, project: ExecutionId, revision: ExecutionId,
    approved_only: bool) -> Result<Option<ReviewDecision>, ExecutionError> {
    let action: Option<String> = c.query_row(
        "SELECT action_id FROM review_decisions WHERE project_id=?1 AND revision_id=?2
         AND (?3=0 OR kind='approve') ORDER BY rowid DESC LIMIT 1",
        params![project.to_string(), revision.to_string(), approved_only], |r| r.get(0))
        .optional().map_err(super::super::ledger::sql_error)?;
    action.map(|value| {
        super::super::review::decision_by_action(c, project, id(value)?)?
            .map(|(value, _)| value)
            .ok_or_else(|| error(ErrorCode::CorruptLedger, "tm-review-decision"))
    }).transpose()
}

pub(in crate::persistence) fn quality_in(c: &Connection, project: ExecutionId,
    revision: &TranslationRevision) -> Result<TranslationMemoryQuality, ExecutionError> {
    let latest_decision = historical_decision(c, project, revision.revision_id, false)?;
    let past_approval = historical_decision(c, project, revision.revision_id, true)?;
    let is_current = current_selection(c, revision.unit_id, &revision.locale)?
        .is_some_and(|s| s.revision_id == revision.revision_id);
    let present: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM source_effective_occurrences o
        JOIN content_scope s ON s.current_snapshot=o.snapshot_id WHERE s.row_id=1 AND o.unit_id=?1)",
        [revision.unit_id.to_string()], |r| r.get(0)).map_err(super::super::ledger::sql_error)?;
    let active_locale = super::super::read_metadata_from(c)
        .map_err(|_| error(ErrorCode::CorruptLedger, "tm-project"))?
        .target_locales().iter().any(|l| l.as_str() == revision.locale);
    let current_approval = if is_current && present && active_locale {
        super::super::review::target_in(c, project, revision.unit_id, &revision.locale)?
            .current_decision.filter(|d| d.kind == ReviewDecisionKind::Approve
                && d.revision_id == revision.revision_id && d.source_revision_id == revision.source_revision_id)
    } else { None };
    Ok(TranslationMemoryQuality { latest_decision, past_approval, current_approval })
}

fn entry_in(c: &Connection, project: ExecutionId, unit: ExecutionId, locale: &str,
    revision: ExecutionId) -> Result<TranslationMemoryEntry, ExecutionError> {
    let (revision, source_text, source_locale) = donor_content(c, project, unit, locale, revision)?;
    let quality = quality_in(c, project, &revision)?;
    let (namespace, native_key, count): (String, String, i64) = c.query_row(
        "SELECT namespace,native_key,(SELECT COUNT(*) FROM source_binding_history p
             WHERE p.snapshot_id=o.snapshot_id AND p.unit_id=o.unit_id AND p.revision_id=o.revision_id)
         FROM source_binding_history o WHERE snapshot_id=?1 AND unit_id=?2 AND revision_id=?3 ORDER BY ordinal LIMIT 1",
        params![revision.source_snapshot_id.to_string(),unit.to_string(),revision.source_revision_id.to_string()],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(super::super::ledger::sql_error)?;
    let source_label = TranslationMemorySourceLabel { namespace, native_key,
        occurrence_count: u32::try_from(count).map_err(|_| error(ErrorCode::CorruptLedger, "tm-occurrences"))? };
    let is_current_source: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM source_effective_occurrences o
        JOIN content_scope s ON s.current_snapshot=o.snapshot_id WHERE s.row_id=1 AND o.unit_id=?1 AND o.revision_id=?2)",
        params![unit.to_string(),revision.source_revision_id.to_string()], |r| r.get(0))
        .map_err(super::super::ledger::sql_error)?;
    let is_current_selection = current_selection(c, unit, locale)?
        .is_some_and(|s| s.revision_id == revision.revision_id);
    Ok(TranslationMemoryEntry {
        project_id: project,
        basis: donor_basis(project, &revision, &source_locale, &source_text)?,
        source_locale, source_text, source_label, is_current_source, revision, is_current_selection, quality,
    })
}

fn page_basis(c: &Connection, epoch: &str, sequence: Revision, project: ExecutionId,
    filter: &TranslationMemoryFilter) -> Result<String, ExecutionError> {
    let clocks: (i64, i64, i64, i64, i64, i64, i64) = c.query_row(
        "SELECT (SELECT COALESCE(MAX(rowid),0) FROM translation_revisions),
         (SELECT COALESCE(MAX(rowid),0) FROM translation_selections),
         (SELECT COALESCE(MAX(rowid),0) FROM translation_candidate_decisions),
         (SELECT COALESCE(MAX(rowid),0) FROM review_decisions),
         (SELECT COALESCE(MAX(rowid),0) FROM resource_changes),
         (SELECT revision FROM content_scope WHERE row_id=1),
         (SELECT metadata_revision FROM project_metadata WHERE row_id=1)", [],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))
        .map_err(super::super::ledger::sql_error)?;
    let version: i64 = c.query_row("PRAGMA data_version", [], |r| r.get(0))
        .map_err(super::super::ledger::sql_error)?;
    request_digest(&(epoch, sequence, project, filter, clocks, version))
}

impl ProjectStore {
    pub fn list_translation_memory(&self, project: ExecutionId, filter: &TranslationMemoryFilter,
        cursor: Option<&str>, limit: u32) -> Result<TranslationMemoryPage, ExecutionError> {
        if !(1..=100).contains(&limit) || cursor.is_some_and(|v| v.len() > 1024) {
            return Err(error(ErrorCode::InvalidInput, "tm-page"));
        }
        let observation = self.changes_since(Revision::new(0)?);
        let c = self.connection().map_err(|_| error(ErrorCode::StorageFailed, "tm-read"))?;
        super::super::review::read_snapshot(c, |c| {
            check_filter(c, project, filter)?;
            let basis = page_basis(c, &observation.epoch, observation.sequence, project, filter)?;
            let after = match cursor {
                None => 0,
                Some(value) => {
                    let value: Cursor = serde_json::from_str(value)
                        .map_err(|_| error(ErrorCode::InvalidInput, "tm-cursor"))?;
                    if value.after <= 0 || value.basis != basis {
                        return Err(error(ErrorCode::DependencyConflict, "tm-page-basis"));
                    }
                    value.after
                }
            };
            let origin = filter.origin.map(|o| match o {
                TranslationOrigin::Import => "import", TranslationOrigin::Manual => "manual",
                TranslationOrigin::Ai => "ai",
            });
            let selection = match filter.selection {
                TranslationMemorySelection::All => 0, TranslationMemorySelection::Current => 1,
                TranslationMemorySelection::Historical => 2,
            };
            // Keyset traversal examines only a bounded returned slice. Scores and
            // target-dependent suggestion limits never determine library membership.
            let mut statement = c.prepare("SELECT r.rowid,r.unit_id,r.revision_id FROM translation_revisions r
                JOIN source_revisions s ON s.unit_id=r.unit_id AND s.revision_id=r.source_revision_id
                WHERE r.project_id=?1 AND r.locale=?2 AND r.rowid>?3
                AND (?4 IS NULL OR instr(s.text,?4)>0) AND (?5 IS NULL OR instr(r.text,?5)>0)
                AND (?6 IS NULL OR r.origin_kind=?6)
                AND (?7=0 OR (?7=1)=EXISTS(SELECT 1 FROM translation_selections x
                    WHERE x.unit_id=r.unit_id AND x.locale=r.locale AND x.revision_id=r.revision_id
                    AND x.sequence=(SELECT MAX(y.sequence) FROM translation_selections y
                        WHERE y.unit_id=r.unit_id AND y.locale=r.locale)))
                ORDER BY r.rowid LIMIT ?8").map_err(super::super::ledger::sql_error)?;
            let ids = statement.query_map(params![project.to_string(),filter.target_locale,after,
                filter.source_text,filter.translation_text,origin,selection,i64::from(limit)+1],
                |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))
                .map_err(super::super::ledger::sql_error)?
                .collect::<Result<Vec<_>,_>>().map_err(super::super::ledger::sql_error)?;
            let mut page = TranslationMemoryPage { project_id: project, filter: filter.clone(),
                basis: basis.clone(), rows: Vec::new(), next_cursor: None };
            let available = ids.len();
            let mut last = after;
            for (rowid, unit, revision) in ids.into_iter().take(limit as usize) {
                let entry = entry_in(c, project, id(unit)?, &filter.target_locale, id(revision)?)?;
                page.rows.push(entry);
                page.next_cursor = Some(serde_json::to_string(&Cursor { basis: basis.clone(), after: rowid })
                    .map_err(|_| error(ErrorCode::InvalidInput, "tm-cursor"))?);
                if codec::encode(&page, MAX_PAGE_BYTES).is_err() {
                    page.rows.pop();
                    if page.rows.is_empty() { return Err(error(ErrorCode::LimitExceeded, "tm-entry-budget")); }
                    break;
                }
                last = rowid;
            }
            page.next_cursor = if page.rows.len() < available {
                Some(serde_json::to_string(&Cursor { basis, after: last })
                    .map_err(|_| error(ErrorCode::InvalidInput, "tm-cursor"))?)
            } else { None };
            codec::encode(&page, MAX_PAGE_BYTES)?;
            Ok(page)
        })
    }

    /// Exact historical evidence remains readable even after a donor is rejected.
    pub fn translation_memory_entry(&self, project: ExecutionId, donor_unit: ExecutionId,
        locale: &str, donor_revision: ExecutionId) -> Result<TranslationMemoryEntry, ExecutionError> {
        let c = self.connection().map_err(|_| error(ErrorCode::StorageFailed, "tm-read"))?;
        super::super::review::read_snapshot(c, |c| {
            let value = entry_in(c, project, donor_unit, locale, donor_revision)?;
            codec::encode(&value, MAX_PAGE_BYTES)?;
            Ok(value)
        })
    }

    /// Observation only: it grants no write or adoption authority.
    pub fn prepare_translation_memory_reuse(&self, r: &PrepareTranslationMemoryReuse)
        -> Result<TranslationMemoryReusePreview, ExecutionError> {
        let c = self.connection().map_err(|_| error(ErrorCode::StorageFailed, "tm-read"))?;
        super::super::review::read_snapshot(c, |c| {
            check_target(c, r.project_id, &r.locale)?;
            let target = super::super::review::target_in(c, r.project_id, r.unit_id, &r.locale)?;
            if target.source_revision_id != r.source_revision_id || target.selection_id != r.expected_selection_id {
                return Err(error(ErrorCode::DependencyConflict, "tm-target-basis"));
            }
            let donor = entry_in(c, r.project_id, r.donor_unit_id, &r.locale, r.donor_revision_id)?;
            if donor.basis != r.donor_basis {
                return Err(error(ErrorCode::DependencyConflict, "tm-donor-basis"));
            }
            if candidate_rejected(c, r.donor_revision_id)? {
                return Err(error(ErrorCode::DependencyConflict, "tm-donor-rejected"));
            }
            let reuse_origin = TranslationReuseOrigin {
                target_source_snapshot_id: target.source_snapshot_id,
                target_unit_id: r.unit_id, target_source_revision_id: r.source_revision_id,
                target_selection_id: r.expected_selection_id, donor_unit_id: r.donor_unit_id,
                donor_source_revision_id: donor.revision.source_revision_id,
                donor_translation_revision_id: r.donor_revision_id, donor_basis: donor.basis.clone(),
            };
            let value = TranslationMemoryReusePreview { target, donor, reuse_origin };
            codec::encode(&value, MAX_PAGE_BYTES)?;
            Ok(value)
        })
    }
}

/// Historical validation intentionally does not require a donor still be usable.
pub(super) fn validate_origin(c: &Connection, project: ExecutionId, locale: &str,
    origin: &TranslationReuseOrigin) -> Result<(), ExecutionError> {
    codec::encode(origin, MAX_ORIGIN_BYTES)?;
    if origin.donor_basis.len() != 64 {
        return Err(error(ErrorCode::InvalidInput, "tm-donor-basis"));
    }
    let (revision, source, source_locale) = donor_content(c, project, origin.donor_unit_id, locale,
        origin.donor_translation_revision_id)?;
    if revision.source_revision_id != origin.donor_source_revision_id
        || donor_basis(project, &revision, &source_locale, &source)? != origin.donor_basis {
        return Err(error(ErrorCode::DependencyConflict, "tm-donor-basis"));
    }
    Ok(())
}

pub(super) fn inherited_origin(c: &Connection, previous: Option<ExecutionId>)
    -> Result<Option<TranslationReuseOrigin>, ExecutionError> {
    let Some(previous) = previous else { return Ok(None); };
    let revision: String = c.query_row("SELECT revision_id FROM translation_selections WHERE event_id=?1",
        [previous.to_string()], |r| r.get(0)).map_err(super::super::ledger::sql_error)?;
    read_origin(c, id(revision)?)
}

pub(super) fn expected_origin(c: &Connection, r: &SaveTranslationRevision)
    -> Result<Option<TranslationReuseOrigin>, ExecutionError> {
    Ok(r.reuse_origin.clone().or(inherited_origin(c, r.expected_selection_id)?))
}

pub(super) fn merge_origin_admitted(c: &Connection, r: &SaveTranslationRevision)
    -> Result<bool, ExecutionError> {
    Ok(r.reuse_origin.is_none()
        || r.reuse_origin == inherited_origin(c, r.expected_selection_id)?)
}

pub(super) fn admit_reuse(c: &Connection, r: &SaveTranslationRevision, snapshot: ExecutionId)
    -> Result<Option<TranslationReuseOrigin>, ExecutionError> {
    let inherited = inherited_origin(c, r.expected_selection_id)?;
    let Some(origin) = &r.reuse_origin else { return Ok(inherited); };
    if inherited.as_ref() == Some(origin) {
        return Ok(inherited);
    }
    if origin.target_unit_id != r.unit_id || origin.target_source_revision_id != r.source_revision_id
        || origin.target_selection_id != r.expected_selection_id || origin.target_source_snapshot_id != snapshot {
        return Err(error(ErrorCode::DependencyConflict, "tm-target-basis"));
    }
    validate_origin(c, r.project_id, &r.locale, origin)?;
    if candidate_rejected(c, origin.donor_translation_revision_id)? {
        return Err(error(ErrorCode::DependencyConflict, "tm-donor-rejected"));
    }
    Ok(Some(origin.clone()))
}

pub(super) fn read_origin(c: &Connection, revision: ExecutionId) -> Result<Option<TranslationReuseOrigin>, ExecutionError> {
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(super::super::ledger::sql_error)?;
    if version < 68 { return Ok(None); }
    let raw: Option<String> = c.query_row("SELECT reuse_origin_json FROM translation_revisions WHERE revision_id=?1",
        [revision.to_string()], |r| r.get(0)).map_err(super::super::ledger::sql_error)?;
    raw.map(|raw| codec::decode(raw.as_bytes(), MAX_ORIGIN_BYTES)
        .map_err(|_| error(ErrorCode::CorruptLedger, "tm-reuse-origin"))).transpose()
}

pub(super) fn validate_storage(c: &Connection) -> Result<(), ExecutionError> {
    let mut statement = c.prepare("SELECT r.revision_id,r.project_id,r.unit_id,r.locale,r.text,
        r.source_snapshot_id,r.source_revision_id,r.origin_kind,r.action_id,r.request_digest,s.previous_event_id,
        s.request_digest,r.rowid FROM translation_revisions r
        LEFT JOIN translation_selections s ON s.action_id=r.action_id AND s.revision_id=r.revision_id
        WHERE r.reuse_origin_json IS NOT NULL ORDER BY r.rowid").map_err(super::super::ledger::sql_error)?;
    let mut rows = statement.query([]).map_err(super::super::ledger::sql_error)?;
    while let Some(row) = rows.next().map_err(super::super::ledger::sql_error)? {
        let raw: String = row.get(0).map_err(super::super::ledger::sql_error)?;
        let revision_id = id(raw)?;
        let origin = read_origin(c, revision_id)?.ok_or_else(|| error(ErrorCode::CorruptLedger, "tm-reuse-origin"))?;
        let project = id(row.get(1).map_err(super::super::ledger::sql_error)?)?;
        let unit = id(row.get(2).map_err(super::super::ledger::sql_error)?)?;
        let locale: String = row.get(3).map_err(super::super::ledger::sql_error)?;
        let text: String = row.get(4).map_err(super::super::ledger::sql_error)?;
        let snapshot = id(row.get(5).map_err(super::super::ledger::sql_error)?)?;
        let source = id(row.get(6).map_err(super::super::ledger::sql_error)?)?;
        let kind: String = row.get(7).map_err(super::super::ledger::sql_error)?;
        let action = id(row.get(8).map_err(super::super::ledger::sql_error)?)?;
        let digest: String = row.get(9).map_err(super::super::ledger::sql_error)?;
        let previous: Option<String> = row.get(10).map_err(super::super::ledger::sql_error)?;
        let previous = optional_id(previous)?;
        let selection_digest: Option<String> = row.get(11).map_err(super::super::ledger::sql_error)?;
        let rowid: i64 = row.get(12).map_err(super::super::ledger::sql_error)?;
        let donor_rowid: i64 = c.query_row("SELECT rowid FROM translation_revisions WHERE revision_id=?1",
            [origin.donor_translation_revision_id.to_string()], |r| r.get(0)).map_err(super::super::ledger::sql_error)?;
        let inherited = inherited_origin(c, previous)?;
        let is_inherited = inherited.as_ref() == Some(&origin);
        if kind != "manual" || origin.target_unit_id != unit || donor_rowid >= rowid
            || selection_digest.as_deref() != Some(digest.as_str())
            || (!is_inherited && (origin.target_source_snapshot_id != snapshot
                || origin.target_source_revision_id != source || origin.target_selection_id != previous)) {
            return Err(error(ErrorCode::CorruptLedger, "tm-reuse-association"));
        }
        validate_origin(c, project, &locale, &origin)?;
        // Ordinary manual receipts bind the exact original optional request.
        // Merges instead bind their existing merge basis; an origin can only
        // reach those rows by the already-proved previous-selection inheritance.
        let contributors: i64 = c.query_row("SELECT COUNT(*) FROM translation_contributors WHERE revision_id=?1",
            [revision_id.to_string()], |r| r.get(0)).map_err(super::super::ledger::sql_error)?;
        if contributors > 0 {
            if !is_inherited { return Err(error(ErrorCode::CorruptLedger, "tm-merge-origin")); }
        } else {
            let mut request = SaveTranslationRevision { project_id: project, action_id: action, unit_id: unit,
                locale, source_revision_id: source, expected_selection_id: previous, text,
                reuse_origin: Some(origin) };
            if request_digest(&request)? != digest {
                request.reuse_origin = None;
                if !is_inherited || request_digest(&request)? != digest {
                    return Err(error(ErrorCode::CorruptLedger, "tm-reuse-request"));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
