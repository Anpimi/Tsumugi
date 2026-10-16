import type { CheckRun, CheckRuleResult, TextReviewDiagnostic } from "./generated/review.responses";
import type { ReviewTarget, ReviewBasis, ReviewEditorSnapshot, ReviewDiagnosticLocation } from "./reviewCommands";
import { ruleIdentity } from "./reviewIdentity";

/** View inputs for returning to the same queue, never a captured write scope. */
export interface ReviewEditorReturn {
  projectId: string; sessionToken: string; locale: string; unitId: string;
  tab: "review" | "work"; summaryScope: { locale: string; scopeId: string } | null;
  pageAfter: number; workOffset: number;
}
export interface ReviewEditorHandoff {
  returnTo: ReviewEditorReturn;
  diagnostic?: { runId: string; diagnostic: TextReviewDiagnostic; basis: string; basisEvidence: ReviewBasis; translationText: string | null };
}
export interface ReviewDiagnosticAnchor {
  projectId: string; sessionToken: string; value: ReviewDiagnosticLocation; sourceText: string; translationText: string | null; editSeq: number;
}
export function sameReviewBasis(left: ReviewBasis, right: ReviewBasis) {
  return left.sourceSnapshotId === right.sourceSnapshotId && left.sourceRevisionId === right.sourceRevisionId
    && left.selectionId === right.selectionId && left.revisionId === right.revisionId && left.contextRevisionId === right.contextRevisionId
    && left.termRevisionIds.length === right.termRevisionIds.length && left.termRevisionIds.every((id, index) => id === right.termRevisionIds[index]);
}
export function diagnosticMatchesTarget(value: ReviewDiagnosticLocation, target: ReviewTarget) {
  return !!target.currentCheck && value.unitId === target.unitId && value.locale === target.locale && value.basis === target.basis
    && value.runId === target.currentCheck.runId && sameReviewBasis(value.basisEvidence, target.basisEvidence)
    && currentDiagnosticRun(target, target.currentCheck);
}
export function diagnosticMatchesEditor(anchor: ReviewDiagnosticAnchor, snapshot: ReviewEditorSnapshot) {
  const selection = snapshot.translations.current;
  return diagnosticMatchesTarget(anchor.value, snapshot.target) && snapshot.target.sourceText === anchor.sourceText
    && snapshot.target.translationText === anchor.translationText && snapshot.translations.currentText === anchor.translationText
    && (selection?.eventId ?? null) === anchor.value.basisEvidence.selectionId && (selection?.revisionId ?? null) === anchor.value.basisEvidence.revisionId;
}
/** Host owns encoding conversion. DOM selection still requires this exact string and scalar boundaries. */
export function validDiagnosticSelection(text: string, range: ReviewDiagnosticLocation["location"]["range"]) {
  const boundary = (offset: number) => offset === 0 || offset === text.length
    || !(text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
  return range.encoding === "utf16" && Number.isInteger(range.start) && Number.isInteger(range.end)
    && range.start >= 0 && range.start <= range.end && range.end <= text.length && boundary(range.start) && boundary(range.end);
}

/** HTML textarea exposes CRLF and CR as LF. This projection never changes the draft. */
export function textareaDisplayText(text: string) { return text.replace(/\r\n?/g, "\n"); }

export function diagnosticTextareaSelection(text: string, range: ReviewDiagnosticLocation["location"]["range"]) {
  if (!validDiagnosticSelection(text, range)) return null;
  function offset(original: number) {
    let removed = 0;
    for (let index = text.indexOf("\r\n"); index !== -1 && index < original; index = text.indexOf("\r\n", index + 2)) {
      if (original === index + 1) return null;
      removed++;
    }
    return original - removed;
  }
  const start = offset(range.start), end = offset(range.end);
  return start === null || end === null ? null : { text: textareaDisplayText(text), start, end };
}

/** SDK target identities are separate from the owning Core translation unit. */
export function reviewDiagnostics(run: CheckRun, rule: CheckRuleResult, code: string) {
  const identity = ruleIdentity(rule.key);
  const targets = new Set(run.evidence?.requiredChecks.requirements.find(requirement => ruleIdentity(requirement.key) === identity)?.targets ?? []);
  return run.evidence?.diagnostics.filter(diagnostic => ruleIdentity(diagnostic.key) === identity
    && diagnostic.code === code && targets.has(diagnostic.target)) ?? [];
}

export function currentDiagnosticRun(target: ReviewTarget, run: CheckRun) {
  return target.currentCheck?.runId === run.runId && target.currentCheck.evidence?.qaBasis === run.evidence?.qaBasis
    && run.unitId === target.unitId && run.locale === target.locale && run.basis === target.basis
    && run.basisEvidence.sourceSnapshotId === target.sourceSnapshotId && run.basisEvidence.sourceRevisionId === target.sourceRevisionId
    && run.basisEvidence.selectionId === target.selectionId && run.basisEvidence.revisionId === target.revisionId
    && sameReviewBasis(run.basisEvidence, target.basisEvidence);
}
