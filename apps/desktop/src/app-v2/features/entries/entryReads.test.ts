import { describe, expect, it, vi } from "vitest";
import { segmentCommands, type SegmentPage, type SegmentQuery, type SegmentQueueWindow, type SegmentRow, type SegmentSourceComparison } from "../../../segmentCommands";
import fixture from "../../../../test/fixtures/segmentCommands.contract.json";
import { validateResponseSegmentPage } from "../../../generated/review.validators";
import { SessionReads } from "../../../sessionReads";
import { captureEntries, entryPageKey, entrySourceComparisonKey, readEntrySourceComparison, readEntryPage, readEntryQueueWindow, retainedEntryCapture } from "./entryReads";

const context = { projectId: "project", sessionToken: "session" };
const query = { text: "hello", selection: "all", status: "all" } as const satisfies SegmentQuery;
const page: SegmentPage = { projectId: "project", locale: "zh-CN", query: { ...query, status: "all" }, queryFingerprint: "query-fingerprint", epoch: "epoch", sequence: "1", scopeId: "capture", sourceSnapshotId: "snapshot", readVersion: "1", rows: [], nextCursor: null, total: 0 };
const window: SegmentQueueWindow = { projectId: "project", locale: "zh-CN", query: { ...query, status: "all" }, queryFingerprint: page.queryFingerprint,
  epoch: "epoch", sequence: "2", scopeId: "capture", sourceSnapshotId: "snapshot", rows: [], total: 0,
  firstPosition: 0, previousUnitId: null, nextUnitId: null };
const capture = { scopeId: "capture", snapshotId: "snapshot", queryFingerprint: "query-fingerprint", readVersion: "1" };
function sourceRows(ids: string[]): SegmentRow[] {
  const value: unknown = structuredClone(fixture.responses.segmentPage);
  if (!validateResponseSegmentPage(value)) throw new Error("Invalid Segment fixture");
  return ids.map(unitId => ({ ...value.rows[0], content: { ...value.rows[0].content, unitId,
    locale: "zh-CN", sourceSnapshotId: "snapshot", sourceRevisionId: "source-revision" } }));
}
function sourceComparison(ids: string[], nextAfter: number | null = null): SegmentSourceComparison {
  return { projectId: "project", locale: "zh-CN", scopeId: "capture", currentSnapshotId: "snapshot", baseSnapshotId: "base", nextAfter,
    rows: ids.map(unitId => ({ unitId, changeKind: "changed", old: { sourceRevisionId: "old-revision", text: `Old ${unitId} é 👩🏽‍💻` },
      current: { sourceRevisionId: "source-revision", text: `Current ${unitId} {{name}}\r\n日本語` } })) };
}

describe("workbench entry reads", () => {
  it("reads only one bounded source comparison per loaded page and keeps complete Unicode", async () => {
    const reads = new SessionReads(context), rows = sourceRows(["a", "b"]);
    const read = vi.spyOn(segmentCommands, "sourceComparison").mockResolvedValue(sourceComparison(["a", "b"]));
    const result = await readEntrySourceComparison(reads, "zh-CN", capture, rows);
    expect(read).toHaveBeenCalledExactlyOnceWith({ ...context, locale: "zh-CN", scopeId: "capture", unitIds: ["a", "b"] });
    expect(result.rows[0].current.text).toBe("Current a {{name}}\r\n日本語");
    expect(result.rows[0].old!.text).toBe("Old a é 👩🏽‍💻");
    expect(entrySourceComparisonKey("zh-CN", capture, rows)).not.toEqual(entrySourceComparisonKey("fr-FR", capture, rows));
    expect(entrySourceComparisonKey("zh-CN", capture, rows)).not.toEqual(entrySourceComparisonKey("zh-CN", { ...capture, snapshotId: "other" }, rows));
    reads.retire();
  });

  it("accumulates precise complete-row continuations using only remaining page members", async () => {
    const reads = new SessionReads(context), rows = sourceRows(["a", "b", "c"]);
    const read = vi.spyOn(segmentCommands, "sourceComparison")
      .mockResolvedValueOnce(sourceComparison(["a"], 1))
      .mockResolvedValueOnce(sourceComparison(["b"], 1))
      .mockResolvedValueOnce(sourceComparison(["c"]));
    const result = await readEntrySourceComparison(reads, "zh-CN", capture, rows);
    expect(read.mock.calls.map(([request]) => request.unitIds)).toEqual([["a", "b", "c"], ["b", "c"], ["c"]]);
    expect(result.rows.map(row => row.unitId)).toEqual(["a", "b", "c"]); expect(result.nextAfter).toBeNull();
    reads.retire();
  });

  it.each(["project", "locale", "scope", "current", "base", "order", "repeat", "revision", "next", "empty", "partial-end"])(
    "rejects a source continuation that changes its page association: %s", async kind => {
      const reads = new SessionReads(context), rows = sourceRows(["a", "b", "c"]);
      const second = sourceComparison(["b", "c"]);
      if (kind === "project") second.projectId = "other";
      if (kind === "locale") second.locale = "fr-FR";
      if (kind === "scope") second.scopeId = "other";
      if (kind === "current") second.currentSnapshotId = "other";
      if (kind === "base") second.baseSnapshotId = "other";
      if (kind === "order") second.rows.reverse();
      if (kind === "repeat") second.rows[0].unitId = "a";
      if (kind === "revision") second.rows[0].current.sourceRevisionId = "other";
      if (kind === "next") second.nextAfter = 0;
      if (kind === "empty") { second.rows = []; second.nextAfter = 0; }
      if (kind === "partial-end") second.rows.pop();
      const read = vi.spyOn(segmentCommands, "sourceComparison").mockResolvedValueOnce(sourceComparison(["a"], 1)).mockResolvedValueOnce(second);
      await expect(readEntrySourceComparison(reads, "zh-CN", capture, rows)).rejects.toThrow("captured page");
      expect(read).toHaveBeenCalledTimes(2); reads.retire();
    },
  );

  it("rejects duplicate or oversized pages before dispatch and stops continuations when the session retires", async () => {
    const reads = new SessionReads(context), read = vi.spyOn(segmentCommands, "sourceComparison");
    await expect(readEntrySourceComparison(reads, "zh-CN", capture, sourceRows(["a", "a"]))).rejects.toThrow("members");
    await expect(readEntrySourceComparison(reads, "zh-CN", capture, sourceRows(Array.from({ length: 51 }, (_, index) => String(index))))).rejects.toThrow("members");
    expect(read).not.toHaveBeenCalled();
    let resolve!: (value: SegmentSourceComparison) => void;
    read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = readEntrySourceComparison(reads, "zh-CN", capture, sourceRows(["a", "b"]));
    const rejected = expect(pending).rejects.toBeDefined();
    reads.retire(); resolve(sourceComparison(["a"], 1)); await rejected;
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares a captured page between views and rereads the original scope without recapturing", async () => {
    const reads = new SessionReads(context);
    const summary = vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
    const [first, second] = await Promise.all([captureEntries(reads, "zh-CN", query), captureEntries(reads, "zh-CN", query)]);
    expect(first).toEqual(second);
    expect(summary).toHaveBeenCalledTimes(1);
    expect(reads.client.getQueryData(reads.key(entryPageKey("zh-CN", query, first, null)))).toEqual(page);
    await readEntryPage(reads, "zh-CN", query, first, "opaque-next");
    expect(summary).toHaveBeenLastCalledWith({ ...context, locale: "zh-CN", query, scopeId: "capture", cursor: "opaque-next", limit: 50 });
    reads.retire();
  });

  it("does not publish a capture that returns after its project session ends", async () => {
    const reads = new SessionReads(context);
    let resolve!: (value: SegmentPage) => void;
    vi.spyOn(segmentCommands, "page").mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = captureEntries(reads, "zh-CN", query);
    const result = expect(pending).rejects.toBeDefined();
    reads.retire(); resolve(page);
    await result;
    expect(reads.client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("refuses a later page from a different read basis", async () => {
    const reads = new SessionReads(context);
    const read = vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
    const capture = await captureEntries(reads, "zh-CN", query);
    read.mockResolvedValue({ ...page, readVersion: "newer-basis" });
    await expect(readEntryPage(reads, "zh-CN", query, capture, "opaque-next")).rejects.toThrow("captured read basis");
    expect(reads.client.getQueryData(reads.key(entryPageKey("zh-CN", query, capture, null)))).toEqual(page);
    reads.retire();
  });

  it("retains the original fixed scope across fact invalidation and an explicit fresh capture", async () => {
    const reads = new SessionReads(context), otherSession = new SessionReads({ ...context, sessionToken: "another-session" });
    const read = vi.spyOn(segmentCommands, "page").mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, scopeId: "new-capture", readVersion: "2" });
    const original = await captureEntries(reads, "zh-CN", query);
    reads.invalidate(["translation", "review"], false);
    expect(retainedEntryCapture(reads, original.scopeId)).toEqual({ locale: "zh-CN", query, scope: original });
    expect(retainedEntryCapture(otherSession, original.scopeId)).toBeUndefined();
    const refreshed = await captureEntries(reads, "zh-CN", query, true);
    expect(refreshed.scopeId).toBe("new-capture"); expect(read).toHaveBeenCalledTimes(2);
    expect(retainedEntryCapture(reads, original.scopeId)?.scope).toEqual(original);
    expect(retainedEntryCapture(reads, refreshed.scopeId)?.scope).toEqual(refreshed);
    reads.retire(); otherSession.retire();
  });

  it("reads a queue window from its retained scope and anchor after translation facts change", async () => {
    const reads = new SessionReads(context);
    vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
    const queue = vi.spyOn(segmentCommands, "queueWindow").mockResolvedValue(window);
    const capture = await captureEntries(reads, "zh-CN", query);
    reads.invalidate(["translation"], false);
    expect(await readEntryQueueWindow(reads, "zh-CN", query, capture, "anchor-unit")).toEqual(window);
    expect(queue).toHaveBeenCalledWith({ ...context, locale: "zh-CN", scopeId: capture.scopeId, anchorUnitId: "anchor-unit", limit: 50 });
    expect(retainedEntryCapture(reads, capture.scopeId)?.scope).toEqual(capture);
    reads.retire();
  });

  it.each([
    { sourceSnapshotId: "different-source" }, { queryFingerprint: "different-query" },
    { query: { ...query, text: "different search" } }, { query: { ...query, selection: "selected" as const } },
    { query: { ...query, status: "issues" as const } },
  ])("rejects a queue window whose captured scope changed: %j", async changed => {
    const reads = new SessionReads(context);
    vi.spyOn(segmentCommands, "page").mockResolvedValue(page);
    vi.spyOn(segmentCommands, "queueWindow").mockResolvedValue({ ...window, ...changed });
    const capture = await captureEntries(reads, "zh-CN", query);
    await expect(readEntryQueueWindow(reads, "zh-CN", query, capture, null)).rejects.toThrow("fixed queue");
    expect(retainedEntryCapture(reads, capture.scopeId)?.scope).toEqual(capture);
    reads.retire();
  });
});
