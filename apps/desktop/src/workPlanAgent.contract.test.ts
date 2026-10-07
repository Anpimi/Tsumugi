import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/workPlanAgent.contract.json";
import { openWorkPlanAgent } from "./workPlanCommands";
import * as validators from "./generated/ai.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
async function opened() {
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.scope));
  return openWorkPlanAgent(fixture.requests.open, fixture.responses.scope.scope);
}
const unknownAck = { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };

it("shares strict Rust contracts and exposes only bounded preparation and start", async () => {
  for (const [validate, value] of [
    [validators.validateRequestWorkPlanAgentOpen, fixture.requests.open],
    [validators.validateRequestWorkPlanAgentPrepare, fixture.requests.prepare],
    [validators.validateRequestWorkPlanAgentStart, fixture.requests.start],
    [validators.validateResponseWorkPlanAgent, fixture.responses.scope],
    [validators.validateResponseWorkPlanAgentGeneration, fixture.responses.generation],
  ] as const) expect(validate(value), validate.name).toBe(true);
  const agent = await opened();
  expect(Object.keys(agent).sort()).toEqual(["prepare", "start"]);
  expect(invoke).toHaveBeenLastCalledWith("open_work_plan_agent_scope", { request: fixture.requests.open });
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.generation));
  const prepared = await agent.prepare(fixture.requests.prepare.generation);
  expect(invoke).toHaveBeenLastCalledWith("prepare_work_plan_agent_generation", { request: fixture.requests.prepare });
  invoke.mockResolvedValueOnce(prepared.attemptId);
  expect(await agent.start(prepared)).toBe(prepared.attemptId);
  expect(invoke).toHaveBeenLastCalledWith("start_work_plan_agent_generation", { request: fixture.requests.start });
});

it("rejects model authority, configuration and out-of-scope inputs before invoking", async () => {
  const agent = await opened();
  for (const field of ["confirmed", "effects", "config", "payload", "lease", "parentTask", "scopeId"]) {
    const generation = { ...fixture.requests.prepare.generation, [field]: true };
    await expect(agent.prepare(generation)).rejects.toThrow("Invalid Agent generation request");
    expect(validators.validateRequestWorkPlanAgentPrepare({ ...fixture.requests.prepare, generation })).toBe(false);
    expect(validators.validateRequestWorkPlanAgentStart({ ...fixture.requests.start, [field]: true })).toBe(false);
  }
  const unit = fixture.requests.prepare.generation.unitIds[0];
  for (const ids of [[], [unit, unit], Array(101).fill(unit), ["60000000-0000-4000-8000-000000000099"]])
    await expect(agent.prepare({ ...fixture.requests.prepare.generation, unitIds: ids })).rejects.toThrow("Invalid Agent generation request");
  for (const malformed of [null, "generate", 0, [], {}])
    await expect(agent.prepare(malformed)).rejects.toThrow("Invalid Agent generation request");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("keeps captured requests fixed across caller edits and scopes preparations to their consumer", async () => {
  const request = structuredClone(fixture.requests.open);
  const basis = structuredClone(fixture.responses.scope.scope);
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.scope));
  const opening = openWorkPlanAgent(request, basis);
  request.sessionToken = "another-session";
  basis[0].nativeKey = "changed";
  const agent = await opening;
  const generation = structuredClone(fixture.requests.prepare.generation);
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.generation));
  const preparing = agent.prepare(generation);
  generation.unitIds.length = 0;
  generation.taskId = fixture.responses.scope.parentTask;
  const prepared = await preparing;
  prepared.attemptId = fixture.responses.scope.parentTask;
  prepared.inputDigest = "b".repeat(64);
  invoke.mockResolvedValueOnce(fixture.requests.start.generation.attemptId);
  expect(await agent.start(prepared)).toBe(fixture.requests.start.generation.attemptId);
  expect(invoke).toHaveBeenLastCalledWith("start_work_plan_agent_generation", { request: fixture.requests.start });
  await expect(agent.start(structuredClone(fixture.responses.generation))).rejects.toThrow("not prepared");
  const other = await opened();
  await expect(other.start(prepared)).rejects.toThrow("not prepared");
});

it("rejects mismatched scope, parent, identities and every captured source basis in acknowledgements", async () => {
  for (const change of [
    { scopeId: fixture.responses.scope.parentTask },
    { parentTask: fixture.responses.scope.scopeId },
    { taskId: fixture.responses.scope.parentTask },
    { attemptId: fixture.responses.scope.parentTask },
    { scope: [] },
    { scope: fixture.responses.scope.scope },
    ...["sourceSnapshotId", "sourceRevisionId", "selectionId"].map(field => ({
      scope: [{ ...fixture.responses.generation.scope[0], [field]: fixture.responses.scope.parentTask }],
    })),
    { scope: [{ ...fixture.responses.generation.scope[0], nativeKey: "changed" }] },
    { inputDigest: "invalid" },
    { budget: { ...fixture.responses.generation.budget, promptTokens: 1 } },
  ]) {
    const agent = await opened();
    invoke.mockResolvedValueOnce({ ...fixture.responses.generation, ...change });
    await expect(agent.prepare(fixture.requests.prepare.generation)).rejects.toMatchObject(unknownAck);
  }
  for (const response of [
    { ...fixture.responses.scope, lease: { ...fixture.responses.scope.lease, generation: "1" } },
    { ...fixture.responses.scope, scope: [] },
  ]) {
    invoke.mockResolvedValueOnce(response);
    await expect(openWorkPlanAgent(fixture.requests.open, fixture.responses.scope.scope)).rejects.toMatchObject(unknownAck);
  }
});

it("reports unknown start acknowledgements without retrying or granting control", async () => {
  const agent = await opened();
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.generation));
  const prepared = await agent.prepare(fixture.requests.prepare.generation);
  for (const ack of [fixture.responses.scope.parentTask, {}, null]) {
    const before = invoke.mock.calls.length;
    invoke.mockResolvedValueOnce(ack);
    await expect(agent.start(prepared)).rejects.toMatchObject(unknownAck);
    expect(invoke).toHaveBeenCalledTimes(before + 1);
  }
});
