import { checkedInvoke } from "./ipc";
import type { SegmentPageRequest, SegmentScopeRequest } from "./generated/review.requests";
import type { SegmentPage, SegmentRow, SegmentScopeCapture } from "./generated/review.responses";
import * as validators from "./generated/review.validators";

export type { SegmentPageRequest, SegmentScopeRequest, SegmentQuery, SegmentSelectionFilter } from "./generated/review.requests";
export type { SegmentPage, SegmentRow, SegmentScopeCapture } from "./generated/review.responses";

function boundedReferences(total: number, length: number, truncated: boolean) {
  return length === Math.min(total, 8) && truncated === (total > length);
}

function relatedSummary(row: SegmentRow) {
  const { content, protection, qa, terms, applicability, qualification } = row;
  const check = content.currentCheck, impact = applicability.resourceImpact;
  const selected = content.selectionId !== null;
  return protection.unitId === content.unitId && protection.locale === content.locale
    && qa.current === (check !== null)
    && (check === null
      ? qa.outcome === null && qa.mandatoryCoverageComplete === null
      : check.basis === content.basis && qa.outcome === check.outcome && qa.mandatoryCoverageComplete !== null)
    && terms.conflictingEntryCount <= terms.applicableEntryCount
    && boundedReferences(terms.revisionCount, terms.revisions.length, terms.truncated)
    && new Set(terms.revisions.map(term => JSON.stringify([term.termId, term.revisionId]))).size === terms.revisions.length
    && terms.revisions.every(term => term.termId.length > 0)
    && (terms.applicableEntryCount !== 0 || terms.revisionCount === 0)
    && (selected
      ? applicability.selectedSourceRevisionId !== null
        && applicability.sourceBasisCurrent === (applicability.selectedSourceRevisionId === content.sourceRevisionId)
        && applicability.capturedBasisCurrent !== null
        && (applicability.capturedBasisCurrent !== true || applicability.sourceBasisCurrent === true)
      : applicability.selectedSourceRevisionId === null && applicability.sourceBasisCurrent === null
        && applicability.capturedBasisCurrent === null)
    && (impact === null || (boundedReferences(impact.reasonCount, impact.changes.length, impact.truncated)
      && new Set(impact.changes.map(change => change.changeId)).size === impact.changes.length))
    && qualification.blockers.length === Math.min(qualification.blockerCount, 8)
    && qualification.exceptions.length === Math.min(qualification.exceptionCount, 8)
    && qualification.truncated === (qualification.blockerCount > qualification.blockers.length
      || qualification.exceptionCount > qualification.exceptions.length);
}

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
        && (request.query.selection !== "unselected" || content.selectionId === null))
      && page.rows.every(relatedSummary)),
  captureScope: (request: SegmentScopeRequest) => checkedInvoke("capture_segment_scope", request,
    (result): result is SegmentScopeCapture => validators.validateResponseSegmentScope(result)
      && result.projectId === request.projectId && result.queryFingerprint === request.queryFingerprint
      && result.readVersion === request.readVersion
      && result.capture.scopeId === request.scopeId && result.capture.locale === request.locale
      && new Set(result.capture.units.map(unit => unit.unitId)).size === result.capture.units.length
      && result.capture.units.every(unit => !request.excluded.includes(unit.unitId))),
};
