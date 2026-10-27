//! Current facts over retained identities; this never refreshes the original filter.
use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentQueueWindow {
    pub project_id: ExecutionId,
    pub locale: String,
    pub scope_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub query: SegmentQuery,
    pub query_fingerprint: String,
    #[cfg_attr(feature = "wire-schema", schemars(with = "ExecutionId"))]
    pub epoch: String,
    pub sequence: Revision,
    pub rows: Vec<SegmentRow>,
    pub first_position: u32,
    pub total: u32,
    pub previous_unit_id: Option<ExecutionId>,
    pub next_unit_id: Option<ExecutionId>,
}

impl ProjectStore {
    /// Read current row facts in original member order after local edits.
    /// The original query describes membership, not a filter on these current facts.
    /// This observation grants no mutation or frozen batch authority.
    pub fn read_segment_queue_window(
        &self,
        project_id: ExecutionId,
        locale: &str,
        scope_id: ExecutionId,
        anchor_unit_id: Option<ExecutionId>,
        limit: u32,
    ) -> Result<SegmentQueueWindow, ExecutionError> {
        if limit == 0 || limit > 100 {
            return Err(failure(ErrorCode::InvalidInput, "segment-queue-limit"));
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
            // The membership owner establishes the SQLite snapshot first. Same-connection
            // commits may advance sequence, but external commits invalidate its provenance.
            let (epoch, sequence, data_version) = stamp(self, connection)?;
            if context.epoch != epoch || context.data_version != data_version {
                return Err(failure(
                    ErrorCode::DependencyConflict,
                    "segment-read-changed",
                ));
            }
            let offset = match anchor_unit_id {
                None => 0,
                Some(anchor) => scope
                    .units
                    .iter()
                    .position(|(unit, _)| *unit == anchor)
                    .ok_or_else(|| {
                        failure(ErrorCode::DependencyConflict, "segment-queue-anchor")
                    })?,
            };
            let units = scope
                .units
                .iter()
                .skip(offset)
                .take(limit as usize)
                .map(|(unit, _)| *unit)
                .collect::<Vec<_>>();
            let rows = rows::project(self, connection, project_id, &units, locale)?;
            let mut window = SegmentQueueWindow {
                project_id,
                locale: locale.to_owned(),
                scope_id,
                source_snapshot_id: scope.snapshot_id,
                query: context.query.clone(),
                query_fingerprint: context.fingerprint.clone(),
                epoch,
                sequence,
                rows: Vec::new(),
                first_position: offset as u32,
                total: scope.units.len() as u32,
                previous_unit_id: offset
                    .checked_sub(1)
                    .and_then(|position| scope.units.get(position))
                    .map(|(unit, _)| *unit),
                next_unit_id: None,
            };
            // Reserve the next identity and separators before appending bounded projections.
            let mut bytes = serde_json::to_vec(&window)
                .map_err(|_| failure(ErrorCode::InvalidInput, "segment-queue-window"))?
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
                window.rows.push(row);
            }
            if window.rows.is_empty() && !units.is_empty() {
                return Err(failure(
                    ErrorCode::LimitExceeded,
                    "segment-queue-window-bytes",
                ));
            }
            window.next_unit_id = scope
                .units
                .get(offset + window.rows.len())
                .map(|(unit, _)| *unit);
            crate::execution::codec::encode(&window, crate::content::MAX_CONTENT_PAGE_BYTES)?;
            Ok(window)
        })
    }
}
