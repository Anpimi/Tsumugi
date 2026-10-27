import { describe, expect, it, vi } from "vitest";
import { segmentCommands, type SegmentPage, type SegmentQuery } from "../../../segmentCommands";
import { SessionReads } from "../../../sessionReads";
import { captureEntries, entryPageKey, readEntryPage } from "./entryReads";

const context = { projectId: "project", sessionToken: "session" };
const query: SegmentQuery = { text: "hello", selection: "all" };
const page: SegmentPage = { projectId: "project", locale: "zh-CN", query, queryFingerprint: "query-fingerprint", epoch: "epoch", sequence: "1", scopeId: "capture", sourceSnapshotId: "snapshot", readVersion: "1", rows: [], nextCursor: null, total: 0 };

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
});
