//! Strict pages share the existing review scope and committed change clock.
use super::*;
use crate::execution::Revision;
mod filters;
mod queue;
mod rows;
#[cfg(test)]
mod tests;
pub use queue::SegmentQueueWindow;
pub use rows::{SegmentApplicability, SegmentImpactChange, SegmentQualification, SegmentReason, SegmentResourceImpact, SegmentRow, SegmentTermRef, SegmentTermSummary};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SegmentSelectionFilter {
    All,
    Selected,
    Unselected,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SegmentStatusFilter {
    #[default]
    All,
    /// No current selection; a selected empty string does not match.
    Untranslated,
    /// Selected text without a current approval, including requested changes.
    NeedsReview,
    /// Current review changes, term conflicts, QA findings or incomplete QA.
    Issues,
    /// An older selected source basis or recorded resource impact history.
    Affected,
    /// At least one blocker from the current delivery eligibility policy.
    Blocking,
    /// A saved, unselected AI candidate whose latest disposition is not rejected.
    AiPending,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentQuery {
    pub text: String,
    pub selection: SegmentSelectionFilter,
    #[serde(default)]
    pub status: SegmentStatusFilter,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentPage {
    pub project_id: ExecutionId,
    pub locale: String,
    pub query: SegmentQuery,
    pub source_snapshot_id: ExecutionId,
    pub scope_id: ExecutionId,
    pub query_fingerprint: String,
    pub read_version: String,
    #[cfg_attr(feature = "wire-schema", schemars(with = "ExecutionId"))]
    pub epoch: String,
    pub sequence: Revision,
    pub rows: Vec<SegmentRow>,
    pub next_cursor: Option<ExecutionId>,
    pub total: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentScopeCapture {
    pub project_id: ExecutionId,
    pub query_fingerprint: String,
    pub read_version: String,
    pub capture: ReviewScopeCapture,
}

#[derive(Clone, Debug)]
pub(super) struct SegmentReadContext {
    query: SegmentQuery,
    fingerprint: String,
    read_version: String,
    epoch: String,
    sequence: Revision,
    data_version: i64,
    // At most one opaque token per page boundary in this bounded scope.
    cursors: BTreeMap<usize, ExecutionId>,
}

fn stamp(
    store: &ProjectStore,
    connection: &Connection,
) -> Result<(String, Revision, i64), ExecutionError> {
    let changes = store.changes_since(Revision::new(0)?);
    let external = connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(sql)?;
    Ok((changes.epoch, changes.sequence, external))
}

pub(super) fn check_read_basis(
    store: &ProjectStore,
    connection: &Connection,
    context: &SegmentReadContext,
) -> Result<(), ExecutionError> {
    let (epoch, sequence, data_version) = stamp(store, connection)?;
    if context.epoch != epoch
        || context.sequence != sequence
        || context.data_version != data_version
    {
        return Err(failure(
            ErrorCode::DependencyConflict,
            "segment-read-changed",
        ));
    }
    Ok(())
}

impl ProjectStore {
    fn segment_scope(
        &self,
        connection: &Connection,
        project_id: ExecutionId,
        locale: &str,
        scope_id: ExecutionId,
    ) -> Result<ReadScope, ExecutionError> {
        let scope = self.retained_review_scope(connection, project_id, locale, scope_id)?;
        if scope.segment.is_none() {
            return Err(failure(ErrorCode::DependencyConflict, "segment-scope"));
        }
        Ok(scope)
    }

    /// These are session-local observations, not project revisions or action authority.
    pub fn read_segment_page(
        &self,
        project_id: ExecutionId,
        locale: &str,
        query: &SegmentQuery,
        scope_id: Option<ExecutionId>,
        cursor: Option<ExecutionId>,
        limit: u32,
    ) -> Result<SegmentPage, ExecutionError> {
        if limit == 0 || limit > 100 || scope_id.is_none() && cursor.is_some() {
            return Err(failure(ErrorCode::InvalidInput, "segment-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "segment-read"))?;
        read_snapshot(connection, |connection| {
            let fingerprint = digest(&(project_id, locale, query, "source-order-1"))?;
            let mut scope = if let Some(id) = scope_id {
                self.segment_scope(connection, project_id, locale, id)?
            } else {
                // This establishes the SQLite read snapshot before sampling its clock.
                let mut scope =
                    self.capture_review_read_scope(connection, project_id, locale, &query.text)?;
                if query.selection != SegmentSelectionFilter::All {
                    let mut statement = connection.prepare("SELECT DISTINCT unit_id FROM translation_selections WHERE project_id=?1 AND locale=?2").map_err(sql)?;
                    let selected = statement
                        .query_map(params![project_id.to_string(), locale], |row| {
                            row.get::<_, String>(0)
                        })
                        .map_err(sql)?
                        .map(|row| row.map_err(sql).and_then(parse_id))
                        .collect::<Result<BTreeSet<_>, _>>()?;
                    scope.units.retain(|(unit, _)| {
                        selected.contains(unit)
                            == (query.selection == SegmentSelectionFilter::Selected)
                    });
                }
                filters::retain(self, connection, project_id, locale, query.status, &mut scope.units)?;
                let (epoch, sequence, data_version) = stamp(self, connection)?;
                let read_version = digest(&(
                    &fingerprint,
                    scope.snapshot_id,
                    &epoch,
                    sequence,
                    data_version,
                ))?;
                scope.segment = Some(SegmentReadContext {
                    query: query.clone(),
                    fingerprint: fingerprint.clone(),
                    read_version,
                    epoch,
                    sequence,
                    data_version,
                    cursors: BTreeMap::new(),
                });
                scope
            };
            let context = scope
                .segment
                .as_mut()
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "segment-scope"))?;
            if context.query != *query || context.fingerprint != fingerprint {
                return Err(failure(ErrorCode::DependencyConflict, "segment-query"));
            }
            let offset = match cursor {
                None => 0,
                Some(cursor) => context
                    .cursors
                    .iter()
                    .find_map(|(offset, token)| (*token == cursor).then_some(*offset))
                    .ok_or_else(|| failure(ErrorCode::DependencyConflict, "segment-cursor"))?,
            };
            let units = scope
                .units
                .iter()
                .skip(offset)
                .take(limit as usize)
                .map(|(unit, _)| *unit)
                .collect::<Vec<_>>();
            let rows = rows::project(self, connection, project_id, &units, locale)?;
            let mut page = SegmentPage {
                project_id,
                locale: locale.to_owned(),
                query: query.clone(),
                source_snapshot_id: scope.snapshot_id,
                scope_id: scope.id,
                query_fingerprint: context.fingerprint.clone(),
                read_version: context.read_version.clone(),
                epoch: context.epoch.clone(),
                sequence: context.sequence,
                rows: Vec::new(),
                next_cursor: None,
                total: scope.units.len() as u32,
            };
            // Reserve the cursor and array separators, then enforce the exact encoded envelope.
            let mut bytes = serde_json::to_vec(&page)
                .map_err(|_| failure(ErrorCode::InvalidInput, "segment-page"))?
                .len()
                + 64;
            for row in rows {
                let size = serde_json::to_vec(&row)
                    .map_err(|_| failure(ErrorCode::InvalidInput, "segment-row"))?
                    .len()
                    + 1;
                if bytes + size > crate::content::MAX_CONTENT_PAGE_BYTES {
                    break;
                }
                bytes += size;
                page.rows.push(row);
            }
            if page.rows.is_empty() && offset < scope.units.len() {
                return Err(failure(ErrorCode::LimitExceeded, "segment-page-bytes"));
            }
            let next = offset + page.rows.len();
            if next < scope.units.len() {
                page.next_cursor =
                    Some(*context.cursors.entry(next).or_insert_with(ExecutionId::new));
            }
            crate::execution::codec::encode(&page, crate::content::MAX_CONTENT_PAGE_BYTES)?;
            // Retain the same membership and cursor identities; a refresh creates a new scope.
            let mut retained = self.review_scopes.0.borrow_mut();
            let original = retained
                .iter_mut()
                .find(|item| item.id == scope.id)
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "segment-scope-expired"))?;
            *original = scope;
            Ok(page)
        })
    }

    /// Freeze the complete captured filter through the original review/action basis owner.
    pub fn capture_segment_scope(
        &self,
        project_id: ExecutionId,
        locale: &str,
        scope_id: ExecutionId,
        query_fingerprint: &str,
        read_version: &str,
        excluded: &[ExecutionId],
    ) -> Result<SegmentScopeCapture, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "segment-read"))?;
        read_snapshot(connection, |connection| {
            let scope = self.segment_scope(connection, project_id, locale, scope_id)?;
            let context = scope
                .segment
                .as_ref()
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "segment-scope"))?;
            if context.fingerprint != query_fingerprint || context.read_version != read_version {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "segment-scope-basis",
                ));
            }
            let capture = self.review_scope_capture(project_id, locale, scope_id, excluded)?;
            Ok(SegmentScopeCapture {
                project_id,
                query_fingerprint: context.fingerprint.clone(),
                read_version: context.read_version.clone(),
                capture,
            })
        })
    }
}
