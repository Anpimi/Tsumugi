import { sameDraftBasis, type DraftKey } from "../../../draftCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import type { TmSuggestion } from "../../../resourceCommands";
import type { TranslationRevision } from "../../../translationCommands";
import type { TranslationStageCommandPayload } from "../../../workbenchCommands";
import type { DraftEntry, TranslationDrafts } from "../editor/translationDrafts";

export type CandidateEvidence = { kind: "revision"; value: TranslationRevision } | { kind: "tm"; value: TmSuggestion };
export const candidateEvidenceId = (evidence: CandidateEvidence) => evidence.kind === "revision" ? `revision:${evidence.value.revisionId}` : `tm:${evidence.value.unitId}:${evidence.value.translationRevisionId}`;
export const candidateDraftKey = (projectId: string, target: ReviewTarget): DraftKey => ({ projectId, unitId: target.unitId, locale: target.locale });
export function candidateEntryCurrent(entry: DraftEntry | undefined, target: ReviewTarget) {
  return !!entry?.value && entry.current.kind === "current" && entry.currentFailure === null && entry.basisCurrent
    && entry.value.basis.sourceRevisionId === target.sourceRevisionId && entry.value.basis.selectionId === target.selectionId
    && entry.value.basis.revisionId === target.revisionId && entry.value.basis.text === target.translationText;
}
export function candidateStagePayload(entry: DraftEntry | undefined, target: ReviewTarget, evidence: CandidateEvidence): TranslationStageCommandPayload | null {
  if (!candidateEntryCurrent(entry, target) || !entry?.value) return null;
  return { kind: "translation-stage", unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId,
    sourceSnapshotId: target.sourceSnapshotId, expectedSelectionId: target.selectionId, expectedRevisionId: target.revisionId,
    draftEditSeq: entry.value.editSeq, draftBasis: { ...entry.value.basis }, evidence: evidence.kind === "revision"
      ? { kind: "revision", revisionId: evidence.value.revisionId, actionId: evidence.value.actionId, ordinal: evidence.value.ordinal,
        sourceRevisionId: evidence.value.sourceRevisionId, sourceSnapshotId: evidence.value.sourceSnapshotId, decisionId: evidence.value.candidateDecision?.request.actionId ?? null }
      : { kind: "tm", donorUnitId: evidence.value.unitId, translationRevisionId: evidence.value.translationRevisionId, sourceRevisionId: evidence.value.sourceRevisionId } };
}
export function sameCandidateCapture(input: TranslationStageCommandPayload | undefined, current: TranslationStageCommandPayload | null) {
  return !!input && !!current && input.unitId === current.unitId && input.locale === current.locale
    && input.sourceRevisionId === current.sourceRevisionId && input.sourceSnapshotId === current.sourceSnapshotId
    && input.expectedSelectionId === current.expectedSelectionId && input.expectedRevisionId === current.expectedRevisionId
    && input.draftEditSeq === current.draftEditSeq && sameDraftBasis(input.draftBasis, current.draftBasis)
    && JSON.stringify(input.evidence) === JSON.stringify(current.evidence);
}
export function canStageCandidate(entry: DraftEntry | undefined, target: ReviewTarget, evidence: CandidateEvidence) {
  return candidateEntryCurrent(entry, target) && !!entry?.value && !entry.busy && !entry.value.pending
    && !entry.value.merge && entry.value.text === (entry.value.basis.text ?? "") && entry.failure === null
    && (evidence.kind === "tm" ? evidence.value.targetLocale === target.locale
      : evidence.value.sourceRevisionId === target.sourceRevisionId && evidence.value.revisionId !== target.revisionId
        && evidence.value.candidateDecision?.request.disposition !== "rejected");
}
export function stageCandidate(drafts: TranslationDrafts, key: DraftKey, evidence: CandidateEvidence, input: TranslationStageCommandPayload, proof: () => boolean) {
  const expected = { editSeq: input.draftEditSeq, basis: input.draftBasis };
  return evidence.kind === "revision" ? drafts.stageRevision(key, evidence.value, expected, proof) : drafts.stageSuggestion(key, evidence.value, expected, proof);
}
