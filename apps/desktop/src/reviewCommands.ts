import type { SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { ReviewPageRequest, ReviewTargetRequest, ReviewSummaryPageRequest, ReviewNeighborRequest, ReviewScopeRequest, ReviewHistoryRequest, ReviewCheckRequest, ReviewCancelCheckRequest, ReviewWorkRequest, EligibilityRequest, ReviewWrite, WaiverWrite, FallbackWrite } from "./generated/review.requests";
import * as validators from "./generated/review.validators";
import type { ReviewSummaryPage } from "./generated/review.responses";

export type { ReviewWrite, WaiverWrite, FallbackWrite } from "./generated/review.requests";
export type { ReviewDecisionKind as DecisionKind, ReviewCheckOutcome, ReviewBasis, ReviewDecision, CheckFinding, CheckRuleResult, CheckRun, Waiver, FallbackDecision, ReviewTarget, ReviewPage, ReviewSummary, ReviewSummaryDecision, ReviewSummaryCheck, ReviewSummaryPage, ReviewEditorSnapshot, ReviewNeighbor, ReviewScopeCapture, ReviewScopeUnit, ReviewHistoryPage, WorkItem, WorkPage, EligibilityReason, EligibilityLocale, Eligibility } from "./generated/review.responses";

function requireConfirmation(condition: boolean) {
  if (!condition) throw new Error("Invalid IPC acknowledgement: review action");
}
function sameAction(actual: { actionId: string; unitId: string; locale: string }, expected: { actionId: string; unitId: string; locale: string }) {
  return actual.actionId === expected.actionId && actual.unitId === expected.unitId && actual.locale === expected.locale;
}

function sameOriginal(actual: object, expected: object) {
  const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
  return Object.keys(a).every(key => JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null))
    && Object.keys(b).every(key => Object.hasOwn(a, key));
}

export const reviewCommands = {
  checkAction: async (request: ReviewCheckRequest) => {
    const value = await checkedInvoke("read_review_check_action", request, validators.validateResponseCheckAction);
    if (value === null) return null;
    const { sessionToken: _sessionToken, ...original } = request;
    requireConfirmation(sameOriginal(value.request, original)
      && sameAction(value.receipt, request) && value.receipt.basis === request.expectedBasis);
    return value.receipt;
  },
  fallbackAction: async (session: SessionRequest, fallback: FallbackWrite) => {
    const value = await checkedInvoke("read_review_fallback_action", { ...session, fallback }, validators.validateResponseFallbackAction);
    if (value === null) return null;
    requireConfirmation(sameOriginal(value.request, fallback));
    const result = value.receipt;
    requireConfirmation(sameAction(result, fallback) && result.allow === fallback.allow
      && result.previousFallbackId === (fallback.expectedFallbackId ?? null) && result.actor === fallback.actor && result.reason === fallback.reason);
    return result;
  },

  waiverAction: async (session: SessionRequest, waiver: WaiverWrite) => {
    const value = await checkedInvoke("read_review_waiver_action", { ...session, waiver }, validators.validateResponseWaiverAction);
    if (value === null) return null;
    requireConfirmation(sameOriginal(value.request, waiver));
    const result = value.receipt;
    requireConfirmation(sameAction(result, waiver) && result.basis === waiver.expectedBasis && result.issueId === waiver.issueId
      && result.grant === waiver.grant && result.previousWaiverId === (waiver.expectedWaiverId ?? null)
      && result.actor === waiver.actor && result.reason === waiver.reason);
    return result;
  },

  decisionAction: async (session: SessionRequest, decision: ReviewWrite) => {
    const value = await checkedInvoke("read_review_decision_action", { ...session, decision }, validators.validateResponseDecisionAction);
    if (value === null) return null;
    requireConfirmation(sameOriginal(value.request, decision));
    const result = value.receipt;
    requireConfirmation(sameAction(result, decision) && result.basis === decision.expectedBasis
      && result.actor === decision.actor && result.kind === decision.kind && result.reason === decision.reason
      && result.selectionId === result.basisEvidence.selectionId && result.revisionId === result.basisEvidence.revisionId
      && result.sourceRevisionId === result.basisEvidence.sourceRevisionId);
    return result;
  },

  // A captured list is one source snapshot. Keep response correlation at the
  // transport boundary alongside the generated shape validator.
  summaryPage: (request: ReviewSummaryPageRequest) => checkedInvoke("read_review_summary_page", request,
    (page): page is ReviewSummaryPage => validators.validateResponseSummary(page)
      && (request.scopeId == null || page.scopeId === request.scopeId)
      && page.rows.every(row => row.locale === request.locale && row.sourceSnapshotId === page.sourceSnapshotId)),
  editorSnapshot: (request: ReviewTargetRequest) => checkedInvoke("read_review_editor_snapshot", request, validators.validateResponseEditor),
  neighbor: (request: ReviewNeighborRequest) => checkedInvoke("read_review_neighbor", request, validators.validateResponseNeighbor),
  captureScope: (request: ReviewScopeRequest) => checkedInvoke("capture_review_scope", request, validators.validateResponseScope),
  page: (request: ReviewPageRequest) => checkedInvoke("read_review_page", request, validators.validateResponsePage),
  target: (request: ReviewTargetRequest) => checkedInvoke("read_review_target", request, validators.validateResponseTarget),
  history: (request: ReviewHistoryRequest) => checkedInvoke("read_review_history", request, validators.validateResponseHistory),
  decide: async (session: SessionRequest, decision: ReviewWrite) => {
    const result = await checkedInvoke("write_review_decision", { ...session, decision }, validators.validateResponseDecision);
    requireConfirmation(sameAction(result, decision) && result.basis === decision.expectedBasis
      && result.kind === decision.kind && result.actor === decision.actor && result.reason === decision.reason
      && result.selectionId === result.basisEvidence.selectionId && result.revisionId === result.basisEvidence.revisionId
      && result.sourceRevisionId === result.basisEvidence.sourceRevisionId);
    return result;
  },
  check: async (request: ReviewCheckRequest) => {
    const result = await checkedInvoke("run_review_checks", request, validators.validateResponseCheck);
    requireConfirmation(sameAction(result, request) && result.basis === request.expectedBasis);
    return result;
  },
  cancelCheck: (request: ReviewCancelCheckRequest) => checkedInvoke("cancel_review_checks", request, validators.validateResponseCancelCheck),
  waive: async (session: SessionRequest, waiver: WaiverWrite) => {
    const result = await checkedInvoke("waive_review_issue", { ...session, waiver }, validators.validateResponseWaiver);
    requireConfirmation(sameAction(result, waiver) && result.basis === waiver.expectedBasis && result.issueId === waiver.issueId
      && result.grant === waiver.grant && result.previousWaiverId === (waiver.expectedWaiverId ?? null)
      && result.actor === waiver.actor && result.reason === waiver.reason);
    return result;
  },
  fallback: async (session: SessionRequest, fallback: FallbackWrite) => {
    const result = await checkedInvoke("allow_source_fallback", { ...session, fallback }, validators.validateResponseFallback);
    requireConfirmation(sameAction(result, fallback) && result.allow === fallback.allow
      && result.previousFallbackId === (fallback.expectedFallbackId ?? null)
      && result.actor === fallback.actor && result.reason === fallback.reason);
    return result;
  },
  work: (request: ReviewWorkRequest) => checkedInvoke("read_review_work", request, validators.validateResponseWork),
  eligibility: (request: EligibilityRequest) => checkedInvoke("read_review_eligibility", request, validators.validateResponseEligibility),
};
