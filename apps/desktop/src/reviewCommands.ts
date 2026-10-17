import type { SessionRequest } from "./executionCommands";
import { checkedInvoke } from "./ipc";
import type { Requests, ReviewFindingWrite, ReviewFindingActionRequest, ReviewPageRequest, ReviewTargetRequest, ReviewSummaryPageRequest, ReviewNeighborRequest, ReviewScopeRequest, ReviewHistoryRequest, ReviewCheckRequest, ReviewCheckStartRequest, ReviewCancelCheckRequest, ReviewWorkRequest, EligibilityRequest, ReviewWrite, WaiverWrite, FallbackWrite } from "./generated/review.requests";
import * as validators from "./generated/review.validators";
import { checkerIdentity, contractIdentity, ruleIdentity } from "./reviewIdentity";
import type { Responses, AdvisoryFinding, ReviewBasis, ReviewFindingDecision, ReviewFindingView, ReviewSummaryPage, ReviewScopeCapture } from "./generated/review.responses";
export type ReviewDiagnosticLocation = Responses["diagnosticLocation"];

export type { ReviewFindingWrite, ReviewWrite, WaiverWrite, FallbackWrite, ReviewCheckRequest, ReviewCheckStartRequest } from "./generated/review.requests";
export type { ReviewFindingDecision, ReviewFindingDisposition, ReviewFindingView, ReviewFindingRepair, ReviewRepairStatus, AdvisoryFinding, ReviewCheckPreparation, ReviewPluginCheckView, ReviewDecisionKind as DecisionKind, ReviewCheckOutcome, ReviewBasis, ReviewDecision, CheckFinding, CheckRuleResult, CheckRun, Waiver, FallbackDecision, ReviewTarget, ReviewPage, ReviewSummary, ReviewSummaryDecision, ReviewSummaryCheck, ReviewSummaryPage, ReviewEditorSnapshot, ReviewNeighbor, ReviewScopeCapture, ReviewScopeUnit, ReviewHistoryPage, WorkItem, WorkPage, EligibilityReason, EligibilityLocale, Eligibility } from "./generated/review.responses";

function requireConfirmation(condition: boolean) {
  if (!condition) throw new Error("Invalid IPC acknowledgement: review action");
}
function sameAction(actual: { actionId: string; unitId: string; locale: string }, expected: { actionId: string; unitId: string; locale: string }) {
  return actual.actionId === expected.actionId && actual.unitId === expected.unitId && actual.locale === expected.locale;
}

export function confirmReviewFinding(receipt: ReviewFindingDecision, request: ReviewFindingWrite) {
  const actual = receipt.request;
  if (actual.projectId !== request.projectId || !sameAction(actual, request)
    || actual.expectedBasis !== request.expectedBasis || actual.runId !== request.runId || actual.issueId !== request.issueId
    || actual.expectedDecisionId !== request.expectedDecisionId || actual.disposition !== request.disposition
    || actual.actor !== request.actor || actual.reason !== request.reason || receipt.finding.issueId !== request.issueId
    || receipt.requirement.mandatory || receipt.requirement.waivable) {
    throw invalidFindingReceipt();
  }
  return receipt;
}

function invalidFindingReceipt() {
  return Object.assign(new Error("Invalid review finding acknowledgement"), { outcome: "unknown", reason: "invalid-review-finding-receipt" });
}
export function confirmReviewFindingBasis(receipt: ReviewFindingDecision, expected: ReviewBasis) {
  const actual = receipt.basisEvidence;
  if (actual.sourceSnapshotId !== expected.sourceSnapshotId || actual.sourceRevisionId !== expected.sourceRevisionId
    || actual.selectionId !== expected.selectionId || actual.revisionId !== expected.revisionId
    || actual.contextRevisionId !== expected.contextRevisionId || actual.termRevisionIds.length !== expected.termRevisionIds.length
    || actual.termRevisionIds.some((id, index) => id !== expected.termRevisionIds[index])) throw invalidFindingReceipt();
}

export function sameAiOrigin(left: AdvisoryFinding["aiOrigin"], right: AdvisoryFinding["aiOrigin"]) {
  if (left === null || right === null) return left === right;
  return left.endpoint === right.endpoint && left.model === right.model && left.recipe === right.recipe
    && left.attemptId === right.attemptId && left.itemId === right.itemId && left.inputDigest === right.inputDigest
    && left.resultId === right.resultId && left.resultDigest === right.resultDigest
    && left.semanticInputDigest === right.semanticInputDigest && left.scopeDigest === right.scopeDigest;
}
export function confirmReviewFindingEvidence(receipt: ReviewFindingDecision, expected: Pick<AdvisoryFinding, "requirement" | "finding" | "runId" | "purpose" | "aiOrigin">) {
  const requirement = receipt.requirement, finding = receipt.finding;
  if (receipt.request.runId !== expected.runId || receipt.purpose !== expected.purpose || !sameAiOrigin(receipt.aiOrigin, expected.aiOrigin)
    || ruleIdentity(requirement.key) !== ruleIdentity(expected.requirement.key)
    || requirement.inputDigest !== expected.requirement.inputDigest || requirement.scopeDigest !== expected.requirement.scopeDigest
    || requirement.mandatory || requirement.waivable || requirement.notApplicable !== null
    || requirement.targets.length !== expected.requirement.targets.length
    || requirement.targets.some((target, index) => target !== expected.requirement.targets[index])
    || finding.issueId !== expected.finding.issueId || finding.rule !== expected.finding.rule || finding.code !== expected.finding.code
    || finding.detail !== expected.finding.detail || finding.severity !== expected.finding.severity || finding.waivable !== expected.finding.waivable) throw invalidFindingReceipt();
}

export const reviewCommands = {
  diagnosticLocation: (request: Requests["diagnosticLocation"]) => checkedInvoke("read_review_diagnostic_location", request,
    (value): value is ReviewDiagnosticLocation => validators.validateResponseDiagnosticLocation(value)
      && value.unitId === request.unitId && value.locale === request.locale && value.runId === request.runId
      && value.location.field === request.diagnostic.location?.field && value.location.range.encoding === "utf16"),
  findings: (request: ReviewHistoryRequest) => checkedInvoke("read_review_findings", request,
    (value): value is ReviewFindingView => validators.validateResponseFindings(value)
      && value.unitId === request.unitId && value.locale === request.locale
      && value.findings.every(item => item.runId === (item.purpose === "qa" ? value.runId : value.semanticRunId)
        && (item.purpose === "qa" ? item.aiOrigin === null : item.aiOrigin !== null)
        && !item.requirement.mandatory && !item.requirement.waivable && item.requirement.notApplicable === null)
      && value.history.every(item => item.request.projectId === request.projectId && item.request.unitId === request.unitId && item.request.locale === request.locale)),
  findingAction: (request: ReviewFindingActionRequest) => checkedInvoke("read_review_finding_action", request,
    (value): value is ReviewFindingDecision | null => validators.validateResponseFindingAction(value)
      && (value === null || (value.request.projectId === request.projectId && value.request.actionId === request.actionId))),
  finding: async (session: SessionRequest, finding: ReviewFindingWrite) => confirmReviewFinding(
    await checkedInvoke("write_review_finding", { ...session, finding }, validators.validateResponseFinding), finding),
  // A captured list is one source snapshot. Keep response correlation at the
  // transport boundary alongside the generated shape validator.
  summaryPage: (request: ReviewSummaryPageRequest) => checkedInvoke("read_review_summary_page", request,
    (page): page is ReviewSummaryPage => validators.validateResponseSummary(page)
      && (request.scopeId == null || page.scopeId === request.scopeId)
      && page.rows.every(row => row.locale === request.locale && row.sourceSnapshotId === page.sourceSnapshotId)),
  editorSnapshot: (request: ReviewTargetRequest) => checkedInvoke("read_review_editor_snapshot", request, validators.validateResponseEditor),
  neighbor: (request: ReviewNeighborRequest) => checkedInvoke("read_review_neighbor", request, validators.validateResponseNeighbor),
  captureScope: (request: ReviewScopeRequest) => checkedInvoke("capture_review_scope", request,
    (capture): capture is ReviewScopeCapture => validators.validateResponseScope(capture)
      && capture.scopeId === request.scopeId && capture.locale === request.locale
      && new Set(capture.units.map(unit => unit.unitId)).size === capture.units.length
      && capture.units.every(unit => !request.excluded.includes(unit.unitId))),
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
