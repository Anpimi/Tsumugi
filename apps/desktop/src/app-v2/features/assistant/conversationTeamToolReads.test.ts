import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/workPlanAgentTools.contract.json";
import { executionCommands, type AttemptDetail, type ExecutionOutputView } from "../../../executionCommands";
import { workPlanCommands } from "../../../workPlanCommands";
import { teamToolHistoryFixture } from "../../../testSupport/teamToolHistoryFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { readConversationTeamToolResults } from "./conversationTeamReads";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixture.responses.output.projectId, sessionToken: "synthetic-recorded-tool" };
const planId = fixtureIdentity(70001), work = { taskId: fixtureIdentity(70002), attemptId: fixtureIdentity(70003), inputDigest: "e".repeat(64) };
beforeEach(() => invoke.mockReset());
afterEach(() => vi.restoreAllMocks());
async function saved(count = 1) {
  const history = teamToolHistoryFixture({ ...context, planId, work, after: null });
  const first = history.attempts[0], detail = structuredClone(fixture.responses.attempt) as AttemptDetail, output = structuredClone(fixture.responses.output) as ExecutionOutputView;
  if (!first) throw new Error("Missing saved history");
  if (count > 1) {
    const item = detail.items[0];
    detail.items = Array.from({ length: Math.min(16, count) }, (_, index) => ({ ...structuredClone(item), resultId: index === 0 ? item.resultId : null,
      scope: { ...item.scope, id: fixtureIdentity(70100 + index) }, status: { ...item.status, itemId: index === 0 ? item.status.itemId : fixtureIdentity(70200 + index) } }));
    detail.progress = { ...detail.progress, total: count, succeeded: count }; detail.nextOffset = count > 16 ? 16 : null;
  }
  first.reference = { taskId: detail.taskId, attemptId: detail.attemptId, inputDigest: fixture.requests.output.inputDigest };
  first.unitIds = count > 1 ? Array.from({ length: count }, (_, index) => fixtureIdentity(70100 + index)) : detail.items.map(item => item.scope.id); first.progress = detail.progress;
  invoke.mockResolvedValueOnce(history);
  const page = await workPlanCommands.teamWorkTools({ ...context, planId, work, after: null, limit: 16 }), row = page.attempts[0];
  if (!row) throw new Error("Missing decoded row");
  const proof = vi.spyOn(executionCommands, "pluginStartAction").mockResolvedValue({ ...row.reference, projectId: context.projectId, operation: "plugin-tool-query" });
  const attempt = vi.spyOn(executionCommands, "attempt").mockResolvedValue(detail), result = vi.spyOn(executionCommands, "output").mockResolvedValue(output);
  return { row, detail, output, proof, attempt, result };
}
it("reads exact original task and item outputs without preparing a scope, tool or execution", async () => {
  const h = await saved(), result = await readConversationTeamToolResults(context, planId, work, h.row, h.detail.items[0].scope.locale!, 0, () => true);
  expect(result.outputs[0].output).toEqual({});
  expect(h.proof).toHaveBeenCalledWith(expect.objectContaining({ attemptId: h.row.reference.attemptId, inputDigest: h.row.reference.inputDigest, operation: "plugin-tool-query" }));
  expect(h.attempt).toHaveBeenCalledWith({ ...context, attemptId: h.row.reference.attemptId, offset: 0, limit: 16 });
  expect(h.result).toHaveBeenCalledWith({ ...context, attemptId: h.row.reference.attemptId, resultId: h.output.resultId });
  expect(invoke).toHaveBeenCalledTimes(1);
});
it.each(["cloned-row", "changed-tool", "wrong-work", "out-of-range"])("rejects %s before any task read", async change => {
  const h = await saved();
  const row = change === "cloned-row" ? structuredClone(h.row) : h.row;
  if (change === "changed-tool") row.toolHandle = fixtureIdentity(70009);
  await expect(readConversationTeamToolResults(context, planId, change === "wrong-work" ? { ...work, inputDigest: "a".repeat(64) } : work,
    row, h.detail.items[0].scope.locale!, change === "out-of-range" ? 100 : 0, () => true)).rejects.toThrow();
  expect(h.proof).not.toHaveBeenCalled(); expect(h.attempt).not.toHaveBeenCalled(); expect(h.result).not.toHaveBeenCalled();
});
it.each(["other-unit", "other-result", "late-parent"])("withholds output on %s", async change => {
  const h = await saved(); let current = true;
  if (change === "other-unit") h.detail.items[0].scope.id = fixtureIdentity(70011);
  if (change === "other-result") h.output.resultId = fixtureIdentity(70012);
  if (change === "late-parent") h.result.mockImplementationOnce(async () => { current = false; return h.output; });
  await expect(readConversationTeamToolResults(context, planId, work, h.row, h.detail.items[0].scope.locale!, 0, () => current)).rejects.toThrow();
});

it("advances only the bounded result page for the same recorded task and language", async () => {
  const h = await saved(17), locale = h.detail.items[0].scope.locale!;
  const first = await readConversationTeamToolResults(context, planId, work, h.row, locale, 0, () => true);
  expect(first.detail.items).toHaveLength(16); expect(first.detail.nextOffset).toBe(16);
  const last = structuredClone(h.detail); last.items = [{ ...structuredClone(last.items[0]), resultId: null,
    scope: { ...last.items[0].scope, id: h.row.unitIds[16] }, status: { ...last.items[0].status, itemId: fixtureIdentity(70300) } }]; last.nextOffset = null;
  h.attempt.mockResolvedValueOnce(last);
  const next = await readConversationTeamToolResults(context, planId, work, h.row, locale, 16, () => true);
  expect(next.detail.items).toHaveLength(1); expect(next.outputs).toEqual([]);
  expect(h.attempt).toHaveBeenLastCalledWith({ ...context, attemptId: h.row.reference.attemptId, offset: 16, limit: 16 });
  await expect(readConversationTeamToolResults(context, planId, work, h.row, "other-locale", 0, () => true)).rejects.toThrow();
});
