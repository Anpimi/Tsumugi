import { expect, it, vi } from "vitest";
import type { ReviewScopeCapture, ReviewTarget } from "../../../reviewCommands";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewSummaryFor, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import type { WorkspaceSelection } from "../../workspace/workspaceSelection";
import { readReviewBatch } from "./reviewBatchReads";

const context = { projectId: fixtureIdentity(12000), sessionToken: "fixed-batch-read" };
function targets(count: number) {
  return Array.from({ length: count }, (_, index) => reviewTargetFixture({ unitId: fixtureIdentity(12100 + index),
    sourceRevisionId: fixtureIdentity(12300 + index), selectionId: fixtureIdentity(12500 + index), revisionId: fixtureIdentity(12700 + index),
    nativeKey: `entry.${index}`, basis: "a".repeat(64) }));
}
function idsSelection(values: ReviewTarget[]): WorkspaceSelection {
  return { kind: "ids", locale: values[0]?.locale ?? "zh-CN", sourceSnapshotId: values[0]?.sourceSnapshotId ?? fixtureIdentity(600), unitIds: values.map(target => target.unitId) };
}
function scopeSelection(values: ReviewTarget[], excluded: string[] = []): Extract<WorkspaceSelection, { kind: "scope" }> {
  return { kind: "scope", query: { text: "fixed query", selection: "all", status: "all" }, selection: { ...context, excluded,
    capture: { scopeId: fixtureIdentity(12001), locale: "zh-CN", sourceSnapshotId: values[0].sourceSnapshotId, query: "fixed query", readVersion: "d".repeat(64),
      units: values.map(target => ({ unitId: target.unitId, expectedBasis: target.basis, expectedDecisionId: target.currentDecision?.decisionId ?? null })) } } };
}
function ports(values: ReviewTarget[], scope?: Extract<WorkspaceSelection, { kind: "scope" }>) {
  let active = 0, peak = 0;
  return {
    source: vi.fn(async () => ({ currentSnapshot: values[0]?.sourceSnapshotId ?? fixtureIdentity(600), revision: "1" })),
    capture: vi.fn(async (): Promise<ReviewScopeCapture> => {
      if (!scope) throw new Error("Unexpected scope capture");
      return { ...structuredClone(scope.selection.capture), readVersion: "e".repeat(64), units: scope.selection.capture.units.filter(unit => !scope.selection.excluded.includes(unit.unitId)) };
    }),
    target: vi.fn(async (request: { unitId: string }) => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve(); active--;
      const target = values.find(target => target.unitId === request.unitId);
      if (!target) throw new Error("Missing synthetic target");
      return structuredClone(target);
    }),
    peak: () => peak,
  };
}

it("reads every selected ID in the original order with bounded parallelism and complete text", async () => {
  const values = targets(70), selection = idsSelection(values), read = ports(values);
  values[69].sourceText = "Full source é 👩🏽‍💻 ".repeat(100);
  const result = await readReviewBatch({ context, selection }, undefined, read);
  expect(result.targets.map(target => target.unitId)).toEqual(values.map(target => target.unitId));
  expect(result.targets[69].sourceText).toBe(values[69].sourceText);
  expect(read.target).toHaveBeenCalledTimes(70); expect(read.source).toHaveBeenCalledTimes(2); expect(read.capture).not.toHaveBeenCalled();
  expect(read.peak()).toBe(4); expect(result.selection).not.toBe(selection);
});

it("verifies the same retained scope and exclusions without treating a page version as a global version", async () => {
  const values = targets(3), selection = scopeSelection(values, [values[1].unitId]), read = ports(values, selection);
  const result = await readReviewBatch({ context, selection }, undefined, read);
  expect(result.targets.map(target => target.unitId)).toEqual([values[0].unitId, values[2].unitId]);
  expect(read.capture).toHaveBeenCalledExactlyOnceWith({ ...context, locale: "zh-CN", scopeId: selection.selection.capture.scopeId, excluded: [values[1].unitId] });
  expect(read.target).toHaveBeenCalledTimes(2);
});

it.each(["missing", "extra", "changed"] as const)("rejects %s retained members without reading a replacement set", async kind => {
  const values = targets(2), selection = scopeSelection(values), read = ports(values, selection);
  const capture = structuredClone(selection.selection.capture);
  if (kind === "missing") capture.units.pop();
  else if (kind === "extra") capture.units.push({ unitId: fixtureIdentity(12999), expectedBasis: "a".repeat(64), expectedDecisionId: null });
  else capture.units[0].expectedBasis = "b".repeat(64);
  read.capture.mockResolvedValue(capture);
  await expect(readReviewBatch({ context, selection }, undefined, read)).rejects.toThrow("fixed review selection");
  expect(read.capture).toHaveBeenCalledOnce(); expect(read.target).not.toHaveBeenCalled();
});

it("keeps an expired retained scope as an error rather than recapturing the current filter", async () => {
  const values = targets(2), selection = scopeSelection(values), read = ports(values, selection);
  const expired = new Error("Synthetic retained scope expired"); read.capture.mockRejectedValue(expired);
  await expect(readReviewBatch({ context, selection }, undefined, read)).rejects.toBe(expired);
  expect(read.capture).toHaveBeenCalledOnce(); expect(read.target).not.toHaveBeenCalled();
});

it("rejects content that changes between scope verification and the complete target read", async () => {
  const values = targets(2), selection = scopeSelection(values), read = ports(values, selection);
  values[1].basis = "b".repeat(64);
  await expect(readReviewBatch({ context, selection }, undefined, read)).rejects.toThrow("review entry has changed");
});

it("rechecks the original remaining selection instead of silently adopting a newer review basis", async () => {
  const values = targets(2), selection = idsSelection(values), expected = values.map(reviewSummaryFor), read = ports(values);
  values[0].basis = "b".repeat(64);
  await expect(readReviewBatch({ context, selection, expected }, undefined, read)).rejects.toThrow("review entry has changed");
});

it("rejects a source revision change even when the final snapshot ID is unchanged", async () => {
  const values = targets(2), selection = idsSelection(values), read = ports(values);
  read.source.mockResolvedValueOnce({ currentSnapshot: values[0].sourceSnapshotId, revision: "1" })
    .mockResolvedValueOnce({ currentSnapshot: values[0].sourceSnapshotId, revision: "2" });
  await expect(readReviewBatch({ context, selection }, undefined, read)).rejects.toThrow("source changed while reading");
});

it.each(["empty", "over-limit", "duplicate"] as const)("rejects an %s request before IO without truncating it", async kind => {
  const values = targets(kind === "over-limit" ? 101 : 2), selection = idsSelection(kind === "empty" ? [] : values), read = ports(values);
  if (kind === "duplicate" && selection.kind === "ids") selection.unitIds = [values[0].unitId, values[0].unitId];
  await expect(readReviewBatch({ context, selection }, undefined, read)).rejects.toThrow("batch approval size or members");
  expect(read.source).not.toHaveBeenCalled(); expect(read.capture).not.toHaveBeenCalled(); expect(read.target).not.toHaveBeenCalled();
});
