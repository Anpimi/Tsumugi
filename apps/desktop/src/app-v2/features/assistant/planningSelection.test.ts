import { expect, it, vi } from "vitest";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import type { reviewCommands } from "../../../reviewCommands";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import { checkPlanningSelection, planningSelectionScope } from "./planningSelection";

const context = { projectId: id(18000), sessionToken: "fixed-planning-selection" }, snapshot = id(18001);
function selection(): Extract<WorkspaceSelection, { kind: "scope" }> {
  return { kind: "scope", query: { text: "fixed query", selection: "all", status: "untranslated" }, selection: { ...context, excluded: [id(18011)],
    capture: { scopeId: id(18002), sourceSnapshotId: snapshot, locale: "zh-CN", query: "fixed query", readVersion: "a".repeat(64),
      units: [10, 11, 12].map(offset => ({ unitId: id(18000 + offset), expectedBasis: "b".repeat(64), expectedDecisionId: null })) } } };
}
function captureFor(value: ReturnType<typeof selection>) {
  return { ...value.selection.capture, units: value.selection.capture.units.filter(unit => !value.selection.excluded.includes(unit.unitId)) };
}
it("checks every frozen member across the original scope with exclusions and no replacement query", async () => {
  const value = selection(), capture = vi.fn<typeof reviewCommands.captureScope>().mockResolvedValue(captureFor(value));
  const scope = await checkPlanningSelection(context, value, () => true, capture);
  expect(scope).toEqual({ kind: "units", locale: "zh-CN", unitIds: [id(18010), id(18012)] });
  expect(capture).toHaveBeenCalledExactlyOnceWith({ ...context, locale: "zh-CN", scopeId: id(18002), excluded: [id(18011)] });
});
it.each(["missing", "extra", "basis", "decision", "language", "snapshot"] as const)("rejects a changed %s instead of broadening or recapturing the scope", async kind => {
  const value = selection(), response = structuredClone(captureFor(value));
  if (kind === "missing") response.units.pop();
  if (kind === "extra") response.units.push({ unitId: id(18999), expectedBasis: "c".repeat(64), expectedDecisionId: null });
  if (kind === "basis") response.units[0].expectedBasis = "d".repeat(64);
  if (kind === "decision") response.units[0].expectedDecisionId = id(18100);
  if (kind === "language") response.locale = "ja-JP";
  if (kind === "snapshot") response.sourceSnapshotId = id(18101);
  const capture = vi.fn<typeof reviewCommands.captureScope>().mockResolvedValue(response);
  await expect(checkPlanningSelection(context, value, () => true, capture)).rejects.toThrow("fixed planning selection has changed");
  expect(capture).toHaveBeenCalledOnce();
});
it.each(["empty", "duplicate", "too-many", "session"] as const)("rejects %s before reading or truncating the selected members", async kind => {
  const value: WorkspaceSelection = kind === "session" ? selection() : { kind: "ids", locale: "zh-CN", sourceSnapshotId: snapshot,
    unitIds: kind === "empty" ? [] : kind === "duplicate" ? [id(18010), id(18010)] : Array.from({ length: 101 }, (_, index) => id(18200 + index)) };
  if (value.kind === "scope") value.selection.sessionToken = "another-session";
  const capture = vi.fn<typeof reviewCommands.captureScope>();
  await expect(checkPlanningSelection(context, value, () => true, capture)).rejects.toThrow("Invalid planning selection");
  expect(capture).not.toHaveBeenCalled();
  if (kind === "too-many" && value.kind === "ids") expect(value.unitIds).toHaveLength(101);
});
it("keeps a direct identity selection separate from review scopes and checks cancellation after a read", async () => {
  const value = selection(), capture = vi.fn<typeof reviewCommands.captureScope>().mockResolvedValue(captureFor(value));
  expect(planningSelectionScope(context, null)).toEqual({ kind: "conversation-only" });
  const direct: WorkspaceSelection = { kind: "ids", locale: "ja-JP", sourceSnapshotId: snapshot, unitIds: [id(18010)] };
  expect(await checkPlanningSelection(context, direct, () => true, capture)).toEqual({ kind: "units", locale: "ja-JP", unitIds: [id(18010)] });
  expect(capture).not.toHaveBeenCalled();
  let current = true;
  capture.mockImplementationOnce(async () => { current = false; return captureFor(value); });
  await expect(checkPlanningSelection(context, value, () => current, capture)).rejects.toThrow("cancelled");
});
