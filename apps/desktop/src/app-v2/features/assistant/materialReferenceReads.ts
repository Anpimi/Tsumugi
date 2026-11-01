import type { ConversationMaterialReference, ConversationPlanningRun, ConversationReferencePage } from "../../../conversationCommands";
import type { ConversationEntryReference } from "./ConversationEntryReferences";

export function materialReferenceIdentity(row: ConversationMaterialReference) {
  return JSON.stringify([row.kind, row.unit.unitId, row.unit.locale, row.unit.sourceSnapshotId, row.unit.sourceRevisionId,
    row.kind === "term" ? row.original.revisionId : row.artifactId]);
}
export function referencesMatchPlanning(page: ConversationReferencePage, run: ConversationPlanningRun) {
  const scope = run.preview.scope;
  return page.projectId === run.preview.projectId && page.conversationId === run.preview.conversationId
    && page.attemptId === run.detail.attemptId && page.inputDigest === run.receipt.inputDigest
    && page.rows.every(row => {
      const unit = run.preview.units.find(value => value.unitId === row.unit.unitId);
      return scope.kind === "units" && scope.locale === row.unit.locale && scope.unitIds.includes(row.unit.unitId) && !!unit
        && unit.sourceSnapshotId === row.unit.sourceSnapshotId && unit.sourceRevisionId === row.unit.sourceRevisionId
        && (row.kind === "file" || unit.sharedTermRevisionIds.includes(row.original.revisionId));
    });
}
export function materialEntryReference(run: ConversationPlanningRun, row: ConversationMaterialReference): ConversationEntryReference {
  return { projectId: run.preview.projectId, conversationId: run.preview.conversationId, attemptId: run.detail.attemptId,
    ...row.unit, detailTab: "context" };
}
