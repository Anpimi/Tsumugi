import { checkedInvoke } from "./ipc";
import type { SegmentSourceComparisonRequest as SourceComparisonWireRequest, SegmentPageRequest, SegmentScopeRequest, SegmentQueueWindowRequest } from "./generated/review.requests";
import type { SegmentSourceComparison, SegmentPage, SegmentRow, SegmentScopeCapture, SegmentQueueWindow } from "./generated/review.responses";
import * as validators from "./generated/review.validators";

export type { SegmentPageRequest, SegmentScopeRequest, SegmentQuery, SegmentSelectionFilter, SegmentStatusFilter } from "./generated/review.requests";
export type { SegmentSourceComparison, SourceVersionComparison, SourceVersionEndpoint, SegmentPage, SegmentRow, SegmentScopeCapture, SegmentQueueWindow } from "./generated/review.responses";
export type SegmentSourceComparisonRequest = Omit<SourceComparisonWireRequest, "unitIds"> & { unitIds: string[] };

function boundedReferences(total: number, length: number, truncated: boolean) {
  return length === Math.min(total, 8) && truncated === (total > length);
}

function relatedSummary(row: SegmentRow) {
  const { content, protection, qa, terms, applicability, qualification } = row;
  const check = content.currentCheck, impact = applicability.resourceImpact;
  const selected = content.selectionId !== null;
  return row.aiCandidateCount <= row.candidateCount
    && protection.unitId === content.unitId && protection.locale === content.locale
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
  sourceComparison: (request: SegmentSourceComparisonRequest) => checkedInvoke("read_segment_source_comparison", request,
    (page): page is SegmentSourceComparison => validators.validateResponseSourceComparison(page)
      && page.projectId === request.projectId && page.locale === request.locale && page.scopeId === request.scopeId
      && page.baseSnapshotId !== page.currentSnapshotId
      && request.unitIds.length > 0 && request.unitIds.length <= 50
      && new Set(request.unitIds).size === request.unitIds.length
      && page.rows.length > 0 && page.rows.length <= request.unitIds.length
      && (page.nextAfter === null ? page.rows.length === request.unitIds.length
        : page.nextAfter === page.rows.length && page.rows.length < request.unitIds.length)
      && page.rows.every((row, index) => row.unitId === request.unitIds[index]
        && (row.old === null ? row.changeKind === "added"
          : page.baseSnapshotId !== null && ["unchanged", "moved", "changed"].includes(row.changeKind))
        && (row.changeKind !== "unchanged" && row.changeKind !== "moved"
          || row.old?.sourceRevisionId === row.current.sourceRevisionId && row.old?.text === row.current.text))),
  queueWindow: (request: SegmentQueueWindowRequest) => checkedInvoke("read_segment_queue_window", request,
    (window): window is SegmentQueueWindow => validators.validateResponseQueueWindow(window)
      && window.projectId === request.projectId && window.locale === request.locale && window.scopeId === request.scopeId
      && window.queryFingerprint.length > 0 && window.epoch.length > 0
      && window.rows.length <= request.limit && window.firstPosition + window.rows.length <= window.total
      && (window.total === 0 ? window.rows.length === 0 && window.firstPosition === 0
        : window.rows.length > 0)
      && (request.anchorUnitId == null || window.rows[0]?.content.unitId === request.anchorUnitId)
      && (window.previousUnitId !== null) === (window.firstPosition > 0)
      && (window.nextUnitId !== null) === (window.firstPosition + window.rows.length < window.total)
      && (window.previousUnitId === null || window.previousUnitId !== window.nextUnitId)
      && new Set(window.rows.map(row => row.content.unitId)).size === window.rows.length
      && window.rows.every(row => row.content.locale === request.locale && row.content.sourceSnapshotId === window.sourceSnapshotId
        && row.content.unitId !== window.previousUnitId && row.content.unitId !== window.nextUnitId && relatedSummary(row))),
  page: (request: SegmentPageRequest) => checkedInvoke("read_segment_page", request,
    (page): page is SegmentPage => validators.validateResponseSegmentPage(page)
      && page.projectId === request.projectId && page.locale === request.locale
      && page.query.text === request.query.text && page.query.selection === request.query.selection
      && (page.query.status ?? "all") === (request.query.status ?? "all")
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
