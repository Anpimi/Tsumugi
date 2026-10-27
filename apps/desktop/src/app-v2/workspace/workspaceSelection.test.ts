import { describe, expect, it } from "vitest";
import { contentSelectionIds } from "../../contentSelection";
import { copyWorkspaceSelection, toggleWorkspaceSelection, workspaceSelectionIds, workspaceSelectionMatches, type WorkspaceSelection } from "./workspaceSelection";

const fixed: WorkspaceSelection = { kind: "scope", query: { text: "hello", selection: "all", status: "issues" }, selection: {
  projectId: "project", sessionToken: "session", excluded: [], capture: { scopeId: "scope", sourceSnapshotId: "snapshot", locale: "zh-CN", query: "hello", readVersion: "original",
    units: ["a", "b", "c"].map(unitId => ({ unitId, expectedBasis: "basis", expectedDecisionId: null })) },
} };

describe("explicit workspace selection", () => {
  it("selects separate pages without including an unseen member", () => {
    const first = toggleWorkspaceSelection(null, "zh-CN", "snapshot", ["a", "b"], true);
    const second = toggleWorkspaceSelection(first, "zh-CN", "snapshot", ["c"], true);
    expect(workspaceSelectionIds(second)).toEqual(["a", "b", "c"]);
    expect(workspaceSelectionIds(first)).toEqual(["a", "b"]);
    expect(workspaceSelectionIds(toggleWorkspaceSelection(second, "zh-CN", "snapshot", ["b"], false))).toEqual(["a", "c"]);
  });
  it("keeps fixed membership and bases when excluding or reselecting a row", () => {
    const original = copyWorkspaceSelection(fixed);
    const excluded = toggleWorkspaceSelection(original, "zh-CN", "snapshot", ["b", "outside-original-query"], false);
    const restored = toggleWorkspaceSelection(excluded, "zh-CN", "snapshot", ["b", "outside-original-query"], true);
    expect(workspaceSelectionIds(excluded)).toEqual(["a", "c"]);
    expect(workspaceSelectionIds(restored)).toEqual(["a", "b", "c"]);
    expect(original).toEqual(fixed);
    if (restored?.kind !== "scope") throw new Error("Expected the original frozen scope");
    expect(restored.selection.capture).toEqual(fixed.selection.capture);
    expect(contentSelectionIds(restored.selection)).not.toContain("outside-original-query");
  });
  it("retains an old selection but refuses to modify it under a new language or source", () => {
    expect(workspaceSelectionMatches(fixed, "ja", "snapshot")).toBe(false);
    expect(workspaceSelectionMatches(fixed, "zh-CN", "new-snapshot")).toBe(false);
    expect(toggleWorkspaceSelection(fixed, "ja", "snapshot", ["a"], false)).toBe(fixed);
    expect(toggleWorkspaceSelection(fixed, "zh-CN", "new-snapshot", ["a"], false)).toBe(fixed);
  });
});
