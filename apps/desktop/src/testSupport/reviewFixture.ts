import type { ReviewTarget, ReviewBasis, ReviewSummary, ReviewSummaryPage, ReviewDecision, CheckRun, ReviewCheckOutcome, ReviewWrite } from "../reviewCommands";
import { fixtureIdentity } from "./executionFixture";

export function reviewBasisFor(target: Pick<ReviewTarget, "sourceSnapshotId" | "sourceRevisionId" | "selectionId" | "revisionId">): ReviewBasis {
  return { sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, contextRevisionId: null, termRevisionIds: [] };
}
export function reviewTargetFixture(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
  const target = {
    unitId: fixtureIdentity(601), locale: "zh-CN", nativeKey: "first", sourceSnapshotId: fixtureIdentity(600), sourceRevisionId: fixtureIdentity(602),
    sourceText: "Hello", selectionId: fixtureIdentity(603), revisionId: fixtureIdentity(604), translationText: "你好", basis: "basis-first", termConflict: false,
    currentDecision: null, currentCheck: null, currentFallback: null, currentWaivers: [], ...overrides,
  };
  return { ...target, basisEvidence: overrides.basisEvidence ?? reviewBasisFor(target) };
}
export function reviewSummaryFor(target: ReviewTarget): ReviewSummary {
  return { unitId: target.unitId, locale: target.locale, nativeKey: target.nativeKey, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId,
    sourcePreview: target.sourceText, translationPreview: target.translationText, selectionId: target.selectionId, revisionId: target.revisionId, basis: target.basis,
    currentDecision: target.currentDecision ? { decisionId: target.currentDecision.decisionId, basis: target.currentDecision.basis, kind: target.currentDecision.kind } : null,
    currentCheck: target.currentCheck ? { runId: target.currentCheck.runId, basis: target.currentCheck.basis, outcome: target.currentCheck.outcome, hasFindings: target.currentCheck.rules.some(rule => rule.status === "findings") } : null };
}
export function reviewSummaryPageFixture(rows: ReviewSummary[], overrides: Partial<ReviewSummaryPage> = {}): ReviewSummaryPage {
  return { rows, nextOrdinal: null, total: rows.length, scopeId: fixtureIdentity(609), sourceSnapshotId: rows[0]?.sourceSnapshotId ?? fixtureIdentity(600), readVersion: "view", ...overrides };
}
export function reviewDecisionFixture(request: ReviewWrite, target: ReviewTarget): ReviewDecision {
  if (!target.selectionId || !target.revisionId) throw new Error("Decision fixture requires a selected revision");
  return { decisionId: fixtureIdentity(610), actionId: request.actionId, unitId: request.unitId, locale: request.locale, basis: request.expectedBasis,
    basisEvidence: target.basisEvidence, selectionId: target.selectionId, revisionId: target.revisionId, sourceRevisionId: target.sourceRevisionId,
    actor: request.actor, kind: request.kind, reason: request.reason, createdAt: "2026-10-03T00:00:00Z" };
}
export function reviewCheckFixture(target: ReviewTarget, actionId: string, outcome: ReviewCheckOutcome = "completed", overrides: Partial<CheckRun> = {}): CheckRun {
  return { runId: fixtureIdentity(620), actionId, unitId: target.unitId, locale: target.locale, basis: target.basis, basisEvidence: target.basisEvidence,
    validatorVersion: "smapi-prebuild-2", outcome, rules: [], createdAt: "2026-10-03T00:00:00Z", ...overrides };
}
