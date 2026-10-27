import { describe, expect, it, vi } from "vitest";
import { segmentCommands, type SegmentPage, type SegmentQuery, type SegmentQueueWindow } from "../../../segmentCommands";
import { SessionReads } from "../../../sessionReads";
import { captureEntries, entryPageKey, readEntryPage, readEntryQueueWindow, retainedEntryCapture } from "./entryReads";

const context = { projectId: "project", sessionToken: "session" };
const query = { text: "hello", selection: "all", status: "all" } as const satisfies SegmentQuery;
const page: SegmentPage = { projectId: "project", locale: "zh-CN", query: { ...query, status: "all" }, queryFingerprint: "query-fingerprint", epoch: "epoch", sequence: "1", scopeId: "capture", sourceSnapshotId: "snapshot", readVersion: "1", rows: [], nextCursor: null, total: 0 };
const window: SegmentQueueWindow = { projectId: "project", locale: "zh-CN", query: { ...query, status: "all" }, queryFingerprint: page.queryFingerprint,
  epoch: "epoch", sequence: "2", scopeId: "capture", sourceSnapshotId: "snapshot", rows: [], total: 0,
  firstPosition: 0, previousUnitId: null, nextUnitId: null };

describe("workbench entry reads", () => {
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
