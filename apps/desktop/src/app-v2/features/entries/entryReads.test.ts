import { describe, expect, it, vi } from "vitest";
import { reviewCommands, type ReviewSummaryPage } from "../../../reviewCommands";
import { SessionReads } from "../../../sessionReads";
import { captureEntries, entryPageKey, readEntryPage } from "./entryReads";

const context = { projectId: "project", sessionToken: "session" };
const page: ReviewSummaryPage = { scopeId: "capture", sourceSnapshotId: "snapshot", readVersion: "1", rows: [], nextOrdinal: null, total: 0 };

describe("workbench entry reads", () => {
  it("shares a captured page between views and rereads the original scope without recapturing", async () => {
    const reads = new SessionReads(context);
    const summary = vi.spyOn(reviewCommands, "summaryPage").mockResolvedValue(page);
    const [first, second] = await Promise.all([captureEntries(reads, "zh-CN", "hello"), captureEntries(reads, "zh-CN", "hello")]);
    expect(first).toEqual(second);
    expect(summary).toHaveBeenCalledTimes(1);
    expect(reads.client.getQueryData(reads.key(entryPageKey("zh-CN", "hello", "capture", 0)))).toEqual(page);
    await readEntryPage(reads, "zh-CN", "hello", first.scopeId, 50);
    expect(summary).toHaveBeenLastCalledWith({ ...context, locale: "zh-CN", query: "hello", scopeId: "capture", afterOrdinal: 50, limit: 50 });
    reads.retire();
  });

  it("does not publish a capture that returns after its project session ends", async () => {
    const reads = new SessionReads(context);
    let resolve!: (value: ReviewSummaryPage) => void;
    vi.spyOn(reviewCommands, "summaryPage").mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = captureEntries(reads, "zh-CN", "");
    const result = expect(pending).rejects.toBeDefined();
    reads.retire(); resolve(page);
    await result;
    expect(reads.client.getQueryCache().getAll()).toHaveLength(0);
  });
});
