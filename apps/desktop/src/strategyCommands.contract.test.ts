import { beforeEach, expect, it, vi } from "vitest";
import { strategyCommands } from "./strategyCommands";
import * as validators from "./generated/strategy.validators";
import execution from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { hasUnknownOutcome } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const session = { projectId: fixtureIdentity(3700), sessionToken: "original-strategy-session" };
const start = { ...session, evaluationId: fixtureIdentity(3701), attemptId: fixtureIdentity(3702), digest: "a".repeat(64), confirmed: false };
const saved = { ...session, evaluationId: start.evaluationId, actionId: fixtureIdentity(3703), itemId: fixtureIdentity(3704), resultId: fixtureIdentity(3705) };
function saveProof() {
  const unitId = fixtureIdentity(3706);
  return { request: { projectId: saved.projectId, evaluationId: saved.evaluationId, actionId: saved.actionId, itemId: saved.itemId, resultId: saved.resultId },
    adoption: { action: { ...execution.action, projectId: saved.projectId, actionId: saved.actionId, attemptId: start.attemptId, unitId,
      resultIds: [saved.resultId], parameters: null, operation: "arena-translation" },
    receipt: { ...execution.receipt, projectId: saved.projectId, actionId: saved.actionId, attemptId: start.attemptId, unitId,
      changes: [{ kind: "translation-revision", id: fixtureIdentity(3707), revision: "1" }] } } };
}
beforeEach(() => invoke.mockReset());

it("reads original start scope without renewing temporary consent", async () => {
  const value = { projectId: start.projectId, evaluationId: start.evaluationId, attemptId: start.attemptId, taskId: fixtureIdentity(3708), digest: start.digest };
  invoke.mockResolvedValueOnce(value); expect(await strategyCommands.startAction(start)).toEqual(value);
  expect(invoke).toHaveBeenLastCalledWith("read_strategy_evaluation_start_action", { request: start });
  invoke.mockResolvedValueOnce(null); expect(await strategyCommands.startAction(start)).toBeNull();
  for (const field of ["projectId", "evaluationId", "attemptId", "digest"] as const) {
    invoke.mockResolvedValueOnce({ ...value, [field]: field === "digest" ? "b".repeat(64) : fixtureIdentity(3799) });
    await expect(strategyCommands.startAction(start)).rejects.toSatisfy(hasUnknownOutcome);
  }
  invoke.mockResolvedValueOnce({ ...value, confirmed: true }); await expect(strategyCommands.startAction(start)).rejects.toSatisfy(hasUnknownOutcome);
});

it("correlates complete saved candidate intent with original adoption without preparing again", async () => {
  const value = saveProof(); expect(validators.validateResponseSaveAction(value)).toBe(true);
  invoke.mockResolvedValueOnce(value); expect(await strategyCommands.saveAction(saved)).toEqual(value);
  expect(invoke).toHaveBeenLastCalledWith("read_strategy_candidate_save_action", { request: saved });
  invoke.mockResolvedValueOnce(null); expect(await strategyCommands.saveAction(saved)).toBeNull();
  invoke.mockResolvedValueOnce({ ...value, adoption: { ...value.adoption, receipt: null } });
  expect((await strategyCommands.saveAction(saved))?.adoption.receipt).toBeNull();
  for (const field of ["projectId", "evaluationId", "actionId", "itemId", "resultId"] as const) {
    invoke.mockResolvedValueOnce({ ...value, request: { ...value.request, [field]: fixtureIdentity(3799) } });
    await expect(strategyCommands.saveAction(saved)).rejects.toSatisfy(hasUnknownOutcome);
  }
  for (const fields of [{ resultIds: [] }, { parameters: {} }, { operation: "direct-ai-translation" }, { actionId: fixtureIdentity(3799) }]) {
    invoke.mockResolvedValueOnce({ ...value, adoption: { ...value.adoption, action: { ...value.adoption.action, ...fields } } });
    await expect(strategyCommands.saveAction(saved)).rejects.toSatisfy(hasUnknownOutcome);
  }
  const missing = { ...value, adoption: { action: value.adoption.action } };
  expect(validators.validateResponseSaveAction(missing)).toBe(false);
  invoke.mockResolvedValueOnce(missing); await expect(strategyCommands.saveAction(saved)).rejects.toSatisfy(hasUnknownOutcome);
});
