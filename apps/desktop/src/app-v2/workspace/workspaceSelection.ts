import { contentSelectionIds, fixedContentSelection, type ContentSelection } from "../../contentSelection";
import type { SegmentQuery } from "../../segmentCommands";

/** Explicit view intent; a frozen scope keeps its original action bases. */
export type WorkspaceSelection =
  | { kind: "ids"; locale: string; sourceSnapshotId: string; unitIds: readonly string[] }
  | { kind: "scope"; selection: ContentSelection; query: SegmentQuery };

export function copyWorkspaceSelection(value: WorkspaceSelection | null): WorkspaceSelection | null {
  if (!value) return null;
  return value.kind === "ids"
    ? Object.freeze({ ...value, unitIds: Object.freeze([...value.unitIds]) })
    : Object.freeze({ ...value, selection: fixedContentSelection(value.selection), query: Object.freeze({ ...value.query }) });
}

export function workspaceSelectionIds(value: WorkspaceSelection | null): readonly string[] {
  return !value ? [] : value.kind === "ids" ? value.unitIds : contentSelectionIds(value.selection);
}

export function workspaceSelectionMatches(value: WorkspaceSelection | null, locale: string, sourceSnapshotId: string | null | undefined): boolean {
  return !value || (value.kind === "ids" ? value.locale === locale && value.sourceSnapshotId === sourceSnapshotId
    : value.selection.capture.locale === locale && value.selection.capture.sourceSnapshotId === sourceSnapshotId);
}

export function toggleWorkspaceSelection(value: WorkspaceSelection | null, locale: string, sourceSnapshotId: string, unitIds: readonly string[], selected: boolean): WorkspaceSelection | null {
  if (!workspaceSelectionMatches(value, locale, sourceSnapshotId)) return value;
  if (value?.kind === "scope") {
    const members = new Set(value.selection.capture.units.map(unit => unit.unitId)), excluded = new Set(value.selection.excluded);
    for (const id of unitIds) if (members.has(id)) { if (selected) excluded.delete(id); else excluded.add(id); }
    return { ...value, selection: fixedContentSelection({ ...value.selection, excluded: [...excluded] }) };
  }
  const ids = new Set(value?.unitIds ?? []);
  for (const id of unitIds) { if (selected) ids.add(id); else ids.delete(id); }
  return ids.size ? { kind: "ids", locale, sourceSnapshotId, unitIds: [...ids] } : null;
}
