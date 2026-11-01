import type { TranslationRevision } from "../../../translationCommands";

/** An original saved result association; it grants no write or execution authority. */
export interface CandidateRevisionTarget {
  unitId: string; locale: string; sourceSnapshotId: string; sourceRevisionId: string; revisionId: string;
  attemptId: string; itemId: string; resultId: string;
}
export interface ExactCandidateBatchScope {
  projectId: string; locale: string; sourceSnapshotId: string;
  candidates: readonly CandidateRevisionTarget[];
}
export function candidateRevisionMatches(target: CandidateRevisionTarget, revision: TranslationRevision) {
  return revision.originKind === "ai" && revision.unitId === target.unitId && revision.locale === target.locale
    && revision.sourceSnapshotId === target.sourceSnapshotId && revision.sourceRevisionId === target.sourceRevisionId
    && revision.revisionId === target.revisionId && revision.attemptId === target.attemptId
    && revision.itemId === target.itemId && revision.resultId === target.resultId;
}
