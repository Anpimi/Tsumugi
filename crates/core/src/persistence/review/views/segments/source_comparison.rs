//! Bounded full-text endpoints over the retained Segment membership.
use super::*;
use crate::content::SourceVersionComparison;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentSourceComparison {
    pub project_id: ExecutionId,
    pub locale: String,
    pub scope_id: ExecutionId,
    pub current_snapshot_id: ExecutionId,
    pub base_snapshot_id: Option<ExecutionId>,
    pub rows: Vec<SourceVersionComparison>,
    /// Requested identities consumed when a continuation is needed. Send the
    /// remaining identities with the same scope; no text is ever truncated.
    pub next_after: Option<u32>,
}

impl ProjectStore {
    pub fn read_segment_source_comparison(
        &self,
        project_id: ExecutionId,
        locale: &str,
        scope_id: ExecutionId,
        unit_ids: &[ExecutionId],
    ) -> Result<SegmentSourceComparison, ExecutionError> {
        let members = unit_ids.iter().copied().collect::<BTreeSet<_>>();
        if unit_ids.is_empty() || unit_ids.len() > 50 || members.len() != unit_ids.len() {
            return Err(failure(ErrorCode::InvalidInput, "segment-source-units"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "segment-read"))?;
        read_snapshot(connection, |connection| {
            let scope =
                self.retained_review_membership(connection, project_id, locale, scope_id)?;
            let context = scope
                .segment
                .as_ref()
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "segment-scope"))?;
            let (epoch, _, data_version) = stamp(self, connection)?;
            if context.epoch != epoch || context.data_version != data_version {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "segment-read-changed",
                ));
            }
            if members
                .iter()
                .any(|unit| !scope.units.iter().any(|(member, _)| member == unit))
            {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "segment-source-member",
                ));
            }
            let (base, rows) =
                crate::persistence::content::maintenance::adopted_comparison_for_units(
                    connection,
                    scope.snapshot_id,
                    unit_ids,
                )?;
            let mut page = SegmentSourceComparison {
                project_id,
                locale: locale.to_owned(),
                scope_id,
                current_snapshot_id: scope.snapshot_id,
                base_snapshot_id: base,
                rows: Vec::new(),
                next_after: None,
            };
            let mut bytes = serde_json::to_vec(&page)
                .map_err(|_| failure(ErrorCode::InvalidInput, "segment-source-page"))?
                .len()
                + 16;
            for row in rows {
                let size = serde_json::to_vec(&row)
                    .map_err(|_| failure(ErrorCode::InvalidInput, "segment-source-row"))?
                    .len()
                    + 1;
                if bytes + size > crate::content::MAX_CONTENT_PAGE_BYTES {
                    break;
                }
                bytes += size;
                page.rows.push(row);
            }
            if page.rows.is_empty() {
                return Err(failure(
                    ErrorCode::LimitExceeded,
                    "segment-source-page-bytes",
                ));
            }
            if page.rows.len() < unit_ids.len() {
                page.next_after = Some(page.rows.len() as u32);
            }
            crate::execution::codec::encode(&page, crate::content::MAX_CONTENT_PAGE_BYTES)?;
            Ok(page)
        })
    }
}
