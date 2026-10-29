import { beforeEach, describe, expect, it, vi } from "vitest";
import { workPlanCommands } from "./workPlanCommands";
import { historyPageAfter, historyRowAt, workPlanHistoryFixture } from "./testSupport/workPlanHistoryFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import type { WorkPlanHistoryPage } from "./generated/ai.responses";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });

describe("original plan action history bridge", () => {
  it("keeps grants, controls, recovery and exact starts in bounded generation order", async () => {
    const h = workPlanHistoryFixture(19), request = { ...h.context, planId: h.link.planId, after: "0", baseline: null, limit: 16 };
    invoke.mockResolvedValueOnce(h.first);
    expect(await workPlanCommands.history(request)).toEqual(h.first);
    expect(h.first.rows).toHaveLength(16); expect(h.first.nextAfter).toBe("16");
    const next = historyPageAfter(h.page, "16"); invoke.mockResolvedValueOnce(next);
    expect(await workPlanCommands.history({ ...request, after: "16", baseline: h.first.baseline })).toEqual(next);
    expect(next.rows.map(row => row.lease.generation)).toEqual(["17", "18", "19"]);
    expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_history")).toBe(true);
  });

  it("freezes an in-flight request and keeps missing enqueue evidence distinct from authorization", async () => {
    const h = workPlanHistoryFixture(1), row = h.first.rows[0];
    if (!row) throw new Error("Missing synthetic grant"); row.start = null; h.first.baseline.lastStart = null;
    const request = { ...h.context, planId: h.link.planId, after: "0", baseline: null, limit: 16 }, original = structuredClone(request);
    let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = workPlanCommands.history(request); request.planId = id(67900); answer(h.first);
    const page = await reading;
    expect(historyRowAt(page, 0).input).not.toBeNull(); expect(historyRowAt(page, 0).start).toBeNull();
    expect(invoke.mock.calls).toEqual([["read_work_plan_history", { request: original }]]);
  });

  it("accepts a byte-bounded short page only with a cursor after its last whole record", async () => {
    const h = workPlanHistoryFixture(19), short = historyPageAfter(h.page, "0", 2);
    invoke.mockResolvedValueOnce(short);
    const page = await workPlanCommands.history({ ...h.context, planId: h.link.planId, after: "0", baseline: null, limit: 16 });
    expect(page.rows).toHaveLength(2); expect(page.nextAfter).toBe("2");
  });

  it.each([
    (page: WorkPlanHistoryPage) => { page.projectId = id(67901); },
    (page: WorkPlanHistoryPage) => { page.rows.reverse(); },
    (page: WorkPlanHistoryPage) => { historyRowAt(page, 1).lease.generation = "3"; },
    (page: WorkPlanHistoryPage) => { historyRowAt(page, 0).actionId = id(67902); },
    (page: WorkPlanHistoryPage) => { const start = historyRowAt(page, 2).start; if (start) start.taskId = id(67903); },
    (page: WorkPlanHistoryPage) => { page.nextAfter = "3"; },
    (page: WorkPlanHistoryPage) => { page.baseline.lastStart = null; },
  ])("rejects mismatched, reordered or invented history", async mutate => {
    const h = workPlanHistoryFixture(), page = structuredClone(h.first); mutate(page); invoke.mockResolvedValueOnce(page);
    await expect(workPlanCommands.history({ ...h.context, planId: h.link.planId, after: "0", baseline: null, limit: 16 })).rejects.toThrow();
  });

  it("rejects a cursor with no baseline before IPC and preserves baseline conflicts", async () => {
    const h = workPlanHistoryFixture();
    await expect(workPlanCommands.history({ ...h.context, planId: h.link.planId, after: "1", baseline: null, limit: 16 })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    const conflict = { code: "dependency-conflict", stage: "execution-read", outcome: "not-applied", reason: "work-plan-history-changed" };
    invoke.mockRejectedValueOnce(conflict);
    await expect(workPlanCommands.history({ ...h.context, planId: h.link.planId, after: "1", baseline: h.first.baseline, limit: 16 })).rejects.toBe(conflict);
  });
});
