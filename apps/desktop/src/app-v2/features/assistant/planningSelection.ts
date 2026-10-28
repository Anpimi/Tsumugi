import { validContentSelection } from "../../../contentSelection";
import type { PreparedConversationPlanning } from "../../../conversationCommands";
import type { SessionRequest } from "../../../executionCommands";
import { reviewCommands } from "../../../reviewCommands";
import { workspaceSelectionIds, type WorkspaceSelection } from "../../workspace/workspaceSelection";

export function planningSelectionScope(context: SessionRequest, selection: WorkspaceSelection | null) {
  if (!selection) return { kind: "conversation-only" as const };
  if (selection.kind === "scope" && (!validContentSelection(selection.selection)
    || selection.selection.projectId !== context.projectId || selection.selection.sessionToken !== context.sessionToken
    || selection.query.text !== selection.selection.capture.query)) throw new Error("Invalid planning selection");
  const unitIds = [...workspaceSelectionIds(selection)];
  const locale = selection.kind === "ids" ? selection.locale : selection.selection.capture.locale;
  const snapshot = selection.kind === "ids" ? selection.sourceSnapshotId : selection.selection.capture.sourceSnapshotId;
  if (!locale || !snapshot || !unitIds.length || unitIds.length > 100 || new Set(unitIds).size !== unitIds.length || unitIds.some(id => !id)) throw new Error("Invalid planning selection size or members");
  return { kind: "units" as const, locale, unitIds };
}

/** Verify the original fixed scope, including exclusions; never rerun its query. */
export async function checkPlanningSelection(context: SessionRequest, selection: WorkspaceSelection | null, current: () => boolean,
  capture: typeof reviewCommands.captureScope = reviewCommands.captureScope) {
  const scope = planningSelectionScope(context, selection);
  if (!current()) throw new Error("Planning selection read cancelled");
  if (selection?.kind !== "scope") return scope;
  const { capture: original, excluded } = selection.selection;
  const checked = await capture({ ...context, locale: original.locale, scopeId: original.scopeId, excluded: [...excluded] });
  if (!current()) throw new Error("Planning selection read cancelled");
  const members = new Map(original.units.filter(unit => !excluded.includes(unit.unitId)).map(unit => [unit.unitId, unit]));
  if (checked.scopeId !== original.scopeId || checked.locale !== original.locale || checked.sourceSnapshotId !== original.sourceSnapshotId
    || checked.query !== original.query || checked.units.length !== members.size || new Set(checked.units.map(unit => unit.unitId)).size !== members.size
    || checked.units.some(unit => { const expected = members.get(unit.unitId); return !expected || unit.expectedBasis !== expected.expectedBasis || unit.expectedDecisionId !== expected.expectedDecisionId; }))
    throw new Error("The fixed planning selection has changed");
  return scope;
}

export function planningSelectionMatchesPreview(selection: WorkspaceSelection | null, prepared: PreparedConversationPlanning) {
  if (!selection) return prepared.preview.scope.kind === "conversation-only" && prepared.preview.units.length === 0;
  const scope = prepared.preview.scope, ids = workspaceSelectionIds(selection);
  const locale = selection.kind === "ids" ? selection.locale : selection.selection.capture.locale;
  const snapshot = selection.kind === "ids" ? selection.sourceSnapshotId : selection.selection.capture.sourceSnapshotId;
  return scope.kind === "units" && scope.locale === locale && scope.unitIds.length === ids.length && scope.unitIds.every((id, index) => id === ids[index])
    && prepared.preview.units.length === ids.length && prepared.preview.units.every((unit, index) => unit.unitId === ids[index] && unit.sourceSnapshotId === snapshot && unit.protection.locale === locale);
}
