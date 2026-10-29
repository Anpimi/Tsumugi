import type { SourceLineageCorrectionBasis, SourceLineageCorrectionReceipt, SourceLineageCorrectionRequest } from "../sourceCommands";
import { sourceRowFixture } from "./sourceFixture";
import { fixtureIdentity as id } from "./executionFixture";

export function sourceCorrectionBasisFixture(projectId: string): SourceLineageCorrectionBasis {
  const snapshotId = id(2100), oldSnapshotId = id(2101);
  const current = sourceRowFixture({ occurrenceId: id(2102), unitId: id(2103), sourceRevisionId: id(2104) }, { key: "current", text: "Changed source" });
  const old = sourceRowFixture({ occurrenceId: id(2105), unitId: id(2106), sourceRevisionId: id(2107) }, { key: "earlier", text: "Earlier source" });
  return { projectId, previousSnapshotId: oldSnapshotId, snapshotId, resultId: id(2108), resultDigest: "a".repeat(64),
    scope: { revision: "4", currentSnapshot: snapshotId }, mappingRevision: "0", ordinal: current.occurrence.ordinal,
    originChain: [{ snapshotId, occurrenceId: current.occurrenceId!, mappingRevision: "0" }],
    bindings: [{ occurrenceId: current.occurrenceId!, unitId: current.unitId!, sourceRevisionId: current.sourceRevisionId!, predecessorId: null, relation: "new" }],
    candidates: [{ old, oldSnapshotId, relationship: "same-text", decision: "candidate", actor: null, reason: null,
      actionId: id(2109), policy: "synthetic-policy", appliedRelation: null }],
    savedWork: [current.unitId!, old.unitId!].map(unitId => ({ unitId, locale: "zh-CN", selectionId: null,
      translationRevisionId: null, translationRevisionIds: [], reviewActionIds: [], checkActionIds: [],
      protectionRevision: null, protected: false, basis: "b".repeat(64) })) };
}

export function sourceCorrectionReceiptFixture(request: SourceLineageCorrectionRequest): SourceLineageCorrectionReceipt {
  const basis = request.correction.basis, previous = basis.bindings;
  const old = basis.candidates.find(value => value.old.occurrenceId === request.correction.oldOccurrenceId)!.old;
  return { request: structuredClone(request.correction), mappingRevision: String(BigInt(basis.mappingRevision) + 1n),
    previousBindings: structuredClone(previous), currentBindings: previous.map(binding => ({ ...binding,
      unitId: request.correction.decision === "continue" ? old.unitId! : binding.unitId,
      sourceRevisionId: id(2110), predecessorId: request.correction.decision === "continue" ? old.occurrenceId : null,
      relation: request.correction.decision === "continue" ? "changed" : "unresolved" })), preservedWork: structuredClone(basis.savedWork) };
}
