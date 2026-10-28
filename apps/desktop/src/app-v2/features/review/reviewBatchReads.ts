import { validContentSelection } from "../../../contentSelection";
import type { SessionRequest } from "../../../executionCommands";
import { REVIEW_BATCH_PREPARE_LIMIT } from "../../../ReviewDraftSession";
import { reviewCommands, type ReviewSummary, type ReviewTarget } from "../../../reviewCommands";
import { sourceCommands } from "../../../sourceCommands";
import { copyWorkspaceSelection, workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";

export interface ReviewBatchReadInput {
  context: SessionRequest;
  selection: WorkspaceSelection;
  expected?: readonly ReviewSummary[];
}
export interface ReviewBatchRead { selection: WorkspaceSelection; targets: ReviewTarget[] }
interface ReadPorts {
  source: typeof sourceCommands.scope;
  capture: typeof reviewCommands.captureScope;
  target: typeof reviewCommands.target;
}
const defaultPorts: ReadPorts = { source: request => sourceCommands.scope(request), capture: request => reviewCommands.captureScope(request), target: request => reviewCommands.target(request) };

/** Read the exact selected members. Capturing an existing scope verifies it;
 * it never creates a replacement scope or broadens the user's selection. */
export async function readReviewBatch(input: ReviewBatchReadInput, live: () => boolean = () => true, ports: ReadPorts = defaultPorts): Promise<ReviewBatchRead> {
  const selection = copyWorkspaceSelection(input.selection);
  if (!selection || selection.kind === "scope" && (!validContentSelection(selection.selection)
    || selection.selection.projectId !== input.context.projectId || selection.selection.sessionToken !== input.context.sessionToken)) throw new Error("Invalid review selection");
  const ids = workspaceSelectionIds(selection), members = new Set(ids);
  if (!ids.length || ids.length > REVIEW_BATCH_PREPARE_LIMIT || members.size !== ids.length || ids.some(id => !id)) throw new Error("Invalid batch approval size or members");
  const locale = selection.kind === "ids" ? selection.locale : selection.selection.capture.locale;
  const snapshot = selection.kind === "ids" ? selection.sourceSnapshotId : selection.selection.capture.sourceSnapshotId;
  if (!locale || !snapshot) throw new Error("Missing review selection language or source");
  const expected = input.expected === undefined ? null : new Map(input.expected.map(target => [target.unitId, target]));
  if (expected && (expected.size !== ids.length || input.expected!.length !== ids.length
    || input.expected!.some(target => !members.has(target.unitId) || target.locale !== locale || target.sourceSnapshotId !== snapshot))) throw new Error("The remaining review selection changed");
  const current = () => { if (!live()) throw new Error("Batch review read cancelled"); };
  current();
  const before = await ports.source(input.context);
  current();
  if (before.currentSnapshot !== snapshot) throw new Error("The selected source has changed");
  let captured: Map<string, { expectedBasis: string; expectedDecisionId: string | null }> | null = null;
  if (selection.kind === "scope") {
    const fixed = selection.selection, original = fixed.capture;
    if (original.query !== selection.query.text) throw new Error("The selected query has changed");
    const value = await ports.capture({ ...input.context, locale, scopeId: original.scopeId, excluded: [...fixed.excluded] });
    current();
    captured = new Map(original.units.filter(unit => members.has(unit.unitId)).map(unit => [unit.unitId, unit]));
    if (value.scopeId !== original.scopeId || value.sourceSnapshotId !== snapshot || value.locale !== locale || value.query !== original.query
      || value.units.length !== ids.length || new Set(value.units.map(unit => unit.unitId)).size !== ids.length
      || value.units.some(unit => !captured!.has(unit.unitId) || unit.expectedBasis !== captured!.get(unit.unitId)!.expectedBasis
        || unit.expectedDecisionId !== captured!.get(unit.unitId)!.expectedDecisionId)) throw new Error("The fixed review selection is no longer current");
  }
  const targets: ReviewTarget[] = [];
  for (let offset = 0; offset < ids.length; offset += 4) {
    current();
    const slice = ids.slice(offset, offset + 4);
    const result = await Promise.allSettled(slice.map(unitId => ports.target({ ...input.context, unitId, locale })));
    current();
    for (const [index, item] of result.entries()) {
      if (item.status === "rejected") throw item.reason;
      const target = item.value, unitId = slice[index], old = expected?.get(unitId), frozen = captured?.get(unitId);
      if (target.unitId !== unitId || target.locale !== locale || target.sourceSnapshotId !== snapshot
        || frozen && (target.basis !== frozen.expectedBasis || (target.currentDecision?.decisionId ?? null) !== frozen.expectedDecisionId)
        || old && (target.basis !== old.basis || target.sourceRevisionId !== old.sourceRevisionId || target.selectionId !== old.selectionId
          || target.revisionId !== old.revisionId || (target.currentDecision?.decisionId ?? null) !== (old.currentDecision?.decisionId ?? null))) throw new Error("A selected review entry has changed");
      targets.push(target);
    }
  }
  const after = await ports.source(input.context);
  current();
  if (after.currentSnapshot !== before.currentSnapshot || after.revision !== before.revision) throw new Error("The source changed while reading the review batch");
  return { selection, targets };
}
