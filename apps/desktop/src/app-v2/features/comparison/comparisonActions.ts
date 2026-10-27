import type { ComparisonView } from "../../../arenaCommands";
import { sameDraftBasis } from "../../../draftCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import type { ArenaPendingCommandPayload, TranslationMergeStageCommandPayload, TranslationStageCommandPayload } from "../../../workbenchCommands";
import type { DraftEntry } from "../editor/translationDrafts";
import { candidateEntryCurrent } from "../candidates/candidateActions";
import type { ComparisonPending } from "./ComparisonSession";

export const comparisonRevisionKey = (view: ComparisonView | null) => ["workbench-comparison-revisions", view?.comparisonId ?? null,
  view?.unitId ?? null, view?.locale ?? null, view?.rows.map(row => row.revisionId) ?? []] as const;
export function comparisonTargetCurrent(view: ComparisonView, target: ReviewTarget) {
  return view.unitId === target.unitId && view.locale === target.locale && view.sourceRevisionId === target.sourceRevisionId
    && view.sourceText === target.sourceText && view.selectionId === target.selectionId && view.selectedRevisionId === target.revisionId
    && view.selectedText === target.translationText && view.basis === target.basis;
}
export function comparisonDraftReady(entry: DraftEntry | undefined, target: ReviewTarget) {
  return candidateEntryCurrent(entry, target) && !!entry?.value && !entry.busy && !entry.value.pending && !entry.value.merge
    && entry.value.text === (entry.value.basis.text ?? "") && entry.failure === null;
}
export function mergeStagePayload(base: TranslationStageCommandPayload | null, view: ComparisonView, initialRevisionId: string): TranslationMergeStageCommandPayload | null {
  if (!base || !view.comparisonId) return null;
  const { kind: _kind, evidence: _evidence, ...target } = base;
  return { ...target, kind: "translation-merge-stage", comparisonId: view.comparisonId,
    contributors: view.rows.map(row => row.revisionId), expectedBasis: view.basis, initialRevisionId };
}
export function sameMergeStage(input: TranslationMergeStageCommandPayload | undefined, expected: TranslationMergeStageCommandPayload | null) {
  return !!input && !!expected && input.unitId === expected.unitId && input.locale === expected.locale
    && input.sourceSnapshotId === expected.sourceSnapshotId && input.sourceRevisionId === expected.sourceRevisionId
    && input.expectedSelectionId === expected.expectedSelectionId && input.expectedRevisionId === expected.expectedRevisionId
    && input.draftEditSeq === expected.draftEditSeq && sameDraftBasis(input.draftBasis, expected.draftBasis)
    && input.comparisonId === expected.comparisonId && input.expectedBasis === expected.expectedBasis && input.initialRevisionId === expected.initialRevisionId
    && input.contributors.length === expected.contributors.length && input.contributors.every((id, index) => id === expected.contributors[index]);
}
export function comparisonPendingPayload(pending: ComparisonPending | null): ArenaPendingCommandPayload | null {
  if (!pending) return null;
  return pending.kind === "compare" ? { kind: "arena-pending", pendingKind: "compare", actionId: pending.request.actionId,
    unitId: pending.request.unitId, locale: pending.request.locale } : { kind: "arena-pending", pendingKind: "reveal", actionId: pending.request.actionId,
    targetKind: "comparison", targetId: pending.request.comparisonId };
}
export function sameComparisonPending(input: ArenaPendingCommandPayload | undefined, pending: ComparisonPending | null) {
  const expected = comparisonPendingPayload(pending);
  return !!input && !!expected && (input.pendingKind === "compare" && expected.pendingKind === "compare"
    ? input.actionId === expected.actionId && input.unitId === expected.unitId && input.locale === expected.locale
    : input.pendingKind === "reveal" && expected.pendingKind === "reveal" && input.actionId === expected.actionId
      && input.targetKind === expected.targetKind && input.targetId === expected.targetId);
}
