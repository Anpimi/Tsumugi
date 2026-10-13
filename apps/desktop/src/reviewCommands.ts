import type { SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { ReviewPageRequest, ReviewTargetRequest, ReviewSummaryPageRequest, ReviewNeighborRequest, ReviewScopeRequest, ReviewHistoryRequest, ReviewCheckRequest, ReviewCheckStartRequest, ReviewCancelCheckRequest, ReviewWorkRequest, EligibilityRequest, ReviewWrite, WaiverWrite, FallbackWrite } from "./generated/review.requests";
import * as validators from "./generated/review.validators";
import { checkerIdentity, contractIdentity } from "./reviewIdentity";
import type { ReviewSummaryPage } from "./generated/review.responses";

export type { ReviewWrite, WaiverWrite, FallbackWrite, ReviewCheckRequest, ReviewCheckStartRequest } from "./generated/review.requests";
export type { ReviewCheckPreparation, ReviewPluginCheckView, ReviewDecisionKind as DecisionKind, ReviewCheckOutcome, ReviewBasis, ReviewDecision, CheckFinding, CheckRuleResult, CheckRun, Waiver, FallbackDecision, ReviewTarget, ReviewPage, ReviewSummary, ReviewSummaryDecision, ReviewSummaryCheck, ReviewSummaryPage, ReviewEditorSnapshot, ReviewNeighbor, ReviewScopeCapture, ReviewScopeUnit, ReviewHistoryPage, WorkItem, WorkPage, EligibilityReason, EligibilityLocale, Eligibility } from "./generated/review.responses";

function requireConfirmation(condition: boolean) {
  if (!condition) throw new Error("Invalid IPC acknowledgement: review action");
}
function sameAction(actual: { actionId: string; unitId: string; locale: string }, expected: { actionId: string; unitId: string; locale: string }) {
  return actual.actionId === expected.actionId && actual.unitId === expected.unitId && actual.locale === expected.locale;
}

export const reviewCommands = {
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
  prepareCheck: async (request: ReviewCheckRequest) => {
    const result = await checkedInvoke("prepare_review_checks", request, validators.validateResponsePrepareCheck);
    const captured = result.kind === "recorded" ? result.run : result.view;
    requireConfirmation(sameAction(captured, request) && captured.basis === request.expectedBasis);
    if (result.kind === "plugin") {
      const slots = result.view.checkers;
      requireConfirmation(slots.length > 0 && new Set(slots.map(slot => checkerIdentity(slot.checker))).size === slots.length
        && new Set(slots.map(slot => slot.attemptId)).size === slots.length);
      for (const slot of slots) {
        const plugin = slot.plugin;
        const capability = plugin.kind === "format" ? plugin.plugin.checker : plugin.plugin.binding.checker;
        const declaration = plugin.kind === "format" ? plugin.plugin.declaration : plugin.plugin.binding.declaration;
        requireConfirmation(checkerIdentity(slot.checker) === checkerIdentity({ provider: capability.provider, profile: declaration.profile }));
        if (plugin.kind === "advisory-text") {
          requireConfirmation(request.advisoryChecks.some(choice => choice.resourceId === plugin.plugin.resourceId
            && choice.environmentDigest === plugin.plugin.environmentDigest
            && choice.package.packageDigest === capability.provider.packageDigest
            && choice.package.plugin.publisher === capability.provider.plugin.publisher
            && choice.package.plugin.id === capability.provider.plugin.id && choice.package.plugin.version === capability.provider.plugin.version
            && JSON.stringify(choice.rules.map(contractIdentity)) === JSON.stringify(plugin.plugin.rules.map(contractIdentity))));
        }
      }
      requireConfirmation(slots.filter(slot => slot.plugin.kind === "advisory-text").length === request.advisoryChecks.length);
    }
    return result;
  },
  check: async (request: ReviewCheckStartRequest) => {
    const result = await checkedInvoke("run_review_checks", request, validators.validateResponseCheck);
    requireConfirmation(sameAction(result, request.check) && result.basis === request.check.expectedBasis);
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
