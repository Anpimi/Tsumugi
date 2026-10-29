import { beforeEach, describe, expect, it, vi } from "vitest";
import executionFixture from "../../../../test/fixtures/executionCommands.contract.json";
import { historyPageAfter, historyRowAt, workPlanHistoryFixture } from "../../../testSupport/workPlanHistoryFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { readConversationRunHistory, readConversationRunHistoryAttempt } from "./planHistoryReads";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });
type Fixture = ReturnType<typeof workPlanHistoryFixture>;
function serve(h: Fixture) {
  invoke.mockImplementation(async (command: string, { request }: { request: { after?: string; attemptId?: string } }) => {
    if (command === "read_conversation_proposal_work_plan") return structuredClone(h.link);
    if (command === "read_work_plan_history") return historyPageAfter(h.page, request.after ?? "0");
    if (command === "read_execution_attempt") {
      const row = h.page.rows.find(row => row.input?.attemptId === request.attemptId), input = row?.input;
      if (!input) throw new Error("Unknown synthetic attempt");
      return { ...structuredClone(executionFixture.detail), attemptId: input.attemptId, taskId: input.taskId, operation: "ai-team-work", nextOffset: null,
        progress: { total: 1, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 1, cancelled: 0, adopted: 0 },
        recovery: { attemptId: input.attemptId, units: [] }, items: [{ ...structuredClone(executionFixture.detail.items[0]),
          status: { ...executionFixture.detail.items[0].status, execution: "unknown", validation: "absent" } }] };
    }
    throw new Error(`Unexpected mutation or external request: ${command}`);
  });
}

describe("conversation original history reads", () => {
  it("checks the complete saved conversation tuple before reading one bounded page", async () => {
    const h = workPlanHistoryFixture(19); serve(h);
    const page = await readConversationRunHistory(h.context, h.link);
    expect(page.rows).toHaveLength(16); expect(page.nextAfter).toBe("16");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_conversation_proposal_work_plan", "read_work_plan_history"]);
    expect(invoke.mock.calls[1][1].request).toEqual({ ...h.context, planId: h.link.planId, after: "0", baseline: null, limit: 16 });
  });

  it.each(["projectId", "conversationId", "proposalId", "revisionId", "actionId", "planId", "planDigest", "ordinal"] as const)("rejects a changed %s in the original link before history IPC", async key => {
    const h = workPlanHistoryFixture(), wrong = structuredClone(h.link);
    wrong[key] = key === "planDigest" ? "f".repeat(64) : key === "ordinal" ? "2" : id(67801);
    invoke.mockResolvedValueOnce(wrong);
    await expect(readConversationRunHistory(h.context, h.link)).rejects.toThrow();
    expect(invoke.mock.calls).toHaveLength(1);
  });

  it("does not let caller edits change the original scope while the link read is pending", async () => {
    const h = workPlanHistoryFixture(), context = structuredClone(h.context), link = structuredClone(h.link);
    let answer!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; })).mockResolvedValueOnce(h.first);
    const reading = readConversationRunHistory(context, link); context.projectId = id(67802); link.planId = id(67803);
    answer(h.link); expect(await reading).toEqual(h.first);
    expect(invoke.mock.calls[1][1].request.projectId).toBe(h.context.projectId); expect(invoke.mock.calls[1][1].request.planId).toBe(h.link.planId);
  });

  it("rejects a recovery target outside the frozen plan and keeps read failures", async () => {
    const h = workPlanHistoryFixture(), row = historyRowAt(h.page, 2);
    if (row.action.kind !== "team-recovery") throw new Error("Expected synthetic recovery");
    row.action.work.target.sourceRevisionId = id(67804); serve(h);
    await expect(readConversationRunHistory(h.context, h.link)).rejects.toThrow();
    const failure = new Error("Synthetic storage read failed"); invoke.mockRejectedValueOnce(failure);
    await expect(readConversationRunHistory(h.context, h.link)).rejects.toBe(failure);
  });

  it("revalidates the exact generation and then reads the original unknown attempt without retrying", async () => {
    const h = workPlanHistoryFixture(), row = historyRowAt(h.first, 0); serve(h);
    const detail = await readConversationRunHistoryAttempt(h.context, h.link, h.first, row);
    expect(detail.attemptId).toBe(row.input?.attemptId); expect(detail.progress.unknown).toBe(1);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_conversation_proposal_work_plan", "read_work_plan_history", "read_execution_attempt"]);
    expect(invoke.mock.calls[2][1].request).toEqual({ ...h.context, attemptId: row.input?.attemptId, offset: 0, limit: 16 });
  });

  it("rejects a different generation record before reading an attempt", async () => {
    const h = workPlanHistoryFixture(), row = structuredClone(historyRowAt(h.first, 0)); row.actionId = id(67805); serve(h);
    await expect(readConversationRunHistoryAttempt(h.context, h.link, h.first, row)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
