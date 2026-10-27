import { checkedInvoke } from "./ipc";
import type { SegmentPageRequest, SegmentScopeRequest } from "./generated/review.requests";
import type { SegmentPage, SegmentScopeCapture } from "./generated/review.responses";
import * as validators from "./generated/review.validators";

export type { SegmentPageRequest, SegmentScopeRequest, SegmentQuery, SegmentSelectionFilter } from "./generated/review.requests";
export type { SegmentPage, SegmentRow, SegmentScopeCapture } from "./generated/review.responses";

export const segmentCommands = {
  page: (request: SegmentPageRequest) => checkedInvoke("read_segment_page", request,
    (page): page is SegmentPage => validators.validateResponseSegmentPage(page)
      && page.projectId === request.projectId && page.locale === request.locale
      && page.query.text === request.query.text && page.query.selection === request.query.selection
      && (request.scopeId == null || page.scopeId === request.scopeId)
      && page.queryFingerprint.length > 0 && page.readVersion.length > 0 && page.epoch.length > 0
      && page.rows.length <= request.limit && page.total >= page.rows.length
      && (page.nextCursor === null || (page.rows.length > 0 && page.nextCursor !== request.cursor))
      && new Set(page.rows.map(row => row.content.unitId)).size === page.rows.length
      && page.rows.every(({ content }) => content.locale === request.locale
        && content.sourceSnapshotId === page.sourceSnapshotId
        && (request.query.selection !== "selected" || content.selectionId !== null)
        && (request.query.selection !== "unselected" || content.selectionId === null))),
  captureScope: (request: SegmentScopeRequest) => checkedInvoke("capture_segment_scope", request,
    (result): result is SegmentScopeCapture => validators.validateResponseSegmentScope(result)
      && result.projectId === request.projectId && result.queryFingerprint === request.queryFingerprint
      && result.readVersion === request.readVersion
      && result.capture.scopeId === request.scopeId && result.capture.locale === request.locale
      && new Set(result.capture.units.map(unit => unit.unitId)).size === result.capture.units.length
      && result.capture.units.every(unit => !request.excluded.includes(unit.unitId))),
};
