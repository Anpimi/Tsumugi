import { beforeEach, describe, expect, it, vi } from "vitest";
import { workPlanCommands } from "./workPlanCommands";
import type { WorkPlanStatusRequest } from "./generated/ai.requests";
import type { ProviderBudget, WorkPlanRunView } from "./generated/ai.responses";
import { validateRequestWorkPlanRun, validateResponseWorkPlanRun } from "./generated/ai.validators";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const request: WorkPlanStatusRequest = { projectId: fixtureIdentity(37000), planId: fixtureIdentity(37001), sessionToken: "fixture-session" };
const rootTaskId = fixtureIdentity(37002);
function started(overrides: Partial<NonNullable<WorkPlanRunView["lastStart"]>> = {}): NonNullable<WorkPlanRunView["lastStart"]> {
  return { projectId: request.projectId, planId: request.planId, actionId: fixtureIdentity(37003), expectedGeneration: "1",
    attemptId: fixtureIdentity(37004), taskId: fixtureIdentity(37005), ...overrides };
}
function budget(): ProviderBudget {
  return { limit: 12, dispatched: 4, legacyHeld: 1, unresolved: 2, usageUnknown: 3,
    promptTokens: "9007199254740993", completionTokens: "18446744073709551615",
    cacheRead: { tokens: "0", unknownRequests: 3 }, cacheWrite: { tokens: "9007199254740995", unknownRequests: 2 }, reasoning: { tokens: "42", unknownRequests: 1 } };
}
function run(overrides: Partial<WorkPlanRunView> = {}): WorkPlanRunView {
  const value: unknown = { projectId: request.projectId, planId: request.planId, planDigest: "a".repeat(64),
    lease: { planId: request.planId, generation: "1" }, state: "active", lastStart: null, budgetRootTaskId: null, budget: null, ...overrides };
  if (!validateResponseWorkPlanRun(value)) throw new Error("Invalid synthetic work-plan run"); return structuredClone(value);
}
beforeEach(() => { invoke.mockReset(); });

describe("work-plan run observation boundary", () => {
  it("reads an unstarted plan through the generated contract without creating execution or budget facts", async () => {
    expect(validateRequestWorkPlanRun(request)).toBe(true);
    const value = run(); invoke.mockResolvedValueOnce(value);
    const observed = await workPlanCommands.run(request);
    expect(observed).toEqual(value); expect(observed.lastStart).toBeNull(); expect(observed.budget).toBeNull();
    expect(invoke.mock.calls).toEqual([["read_work_plan_run", { request }]]);
  });

  it("keeps a model root with no start and no budget as an explicit unknown observation", async () => {
    const value = run({ budgetRootTaskId: rootTaskId }); invoke.mockResolvedValueOnce(value);
    const observed = await workPlanCommands.run(request);
    expect(observed.budgetRootTaskId).toBe(rootTaskId); expect(observed.lastStart).toBeNull(); expect(observed.budget).toBeNull();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("accepts a supplied root budget independently from the presence of a recorded start", async () => {
    const value = run({ budgetRootTaskId: rootTaskId, budget: budget() }); invoke.mockResolvedValueOnce(value);
    expect(await workPlanCommands.run(request)).toEqual(value);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_work_plan_run"]);
  });

  it.each(["active", "paused", "taken-over", "stopped"] as const)("keeps the last enqueued start through a later %s lease without promoting the latest plan generation", async state => {
    const lastStart = started({ expectedGeneration: "3" }), value = run({ state, lease: { planId: request.planId, generation: "5" },
      lastStart, budgetRootTaskId: rootTaskId, budget: budget() });
    invoke.mockResolvedValueOnce(value);
    const observed = await workPlanCommands.run(request);
    expect(observed.lastStart).toEqual(lastStart); expect(observed.lease.generation).toBe("5"); expect(observed.budgetRootTaskId).toBe(rootTaskId);
    expect(invoke.mock.calls).toEqual([["read_work_plan_run", { request }]]);
  });

  it("keeps an absent budget unknown after a recorded start instead of filling in zero usage", async () => {
    const value = run({ lastStart: started(), budgetRootTaskId: rootTaskId }); invoke.mockResolvedValueOnce(value);
    expect((await workPlanCommands.run(request)).budget).toBeNull();
  });

  it("preserves generations beyond JavaScript integer precision and cumulative token strings with unknown usage", async () => {
    const value = run({ lease: { planId: request.planId, generation: "9223372036854775807" },
      lastStart: started({ expectedGeneration: "9007199254740993" }), budgetRootTaskId: rootTaskId, budget: budget() });
    invoke.mockResolvedValueOnce(value);
    const observed = await workPlanCommands.run(request);
    expect(observed).toEqual(value); expect(observed.budget?.promptTokens).toBe("9007199254740993");
    expect(observed.budget?.completionTokens).toBe("18446744073709551615");
    expect(observed.budget?.cacheRead).toEqual({ tokens: "0", unknownRequests: 3 });
    expect(observed.budget?.cacheWrite).toEqual({ tokens: "9007199254740995", unknownRequests: 2 });
  });

  it("freezes the original request before invoking and binds the delayed result to that original scope", async () => {
    const input = structuredClone(request), original = structuredClone(input), value = run();
    let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = workPlanCommands.run(input);
    input.projectId = fixtureIdentity(37006); input.planId = fixtureIdentity(37007); input.sessionToken = "another-fixture-session";
    answer(value);
    expect(await reading).toEqual(value); expect(invoke.mock.calls).toEqual([["read_work_plan_run", { request: original }]]);
  });

  it("does not let later caller edits retarget an in-flight result", async () => {
    const input = structuredClone(request);
    let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = workPlanCommands.run(input);
    input.projectId = fixtureIdentity(37006); input.planId = fixtureIdentity(37007);
    answer(run({ projectId: input.projectId, planId: input.planId, lease: { planId: input.planId, generation: "1" } }));
    await expect(reading).rejects.toMatchObject({ outcome: "unknown", reason: "invalid-work-plan-acknowledgement" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects malformed wire types or extra request fields before IPC instead of opening an execution path", async () => {
    const malformed: unknown[] = [{ ...request, projectId: 42 }, { ...request, planId: null },
      { ...request, actionId: fixtureIdentity(37003) }, { ...request, expectedGeneration: "1" }, { ...request, permit: "not-permission" },
      { projectId: request.projectId, planId: request.planId }, { ...request, sessionToken: 42 }];
    for (const value of malformed) {
      expect(validateRequestWorkPlanRun(value)).toBe(false);
      await expect(workPlanCommands.run(value as WorkPlanStatusRequest)).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  const mismatches: [string, (value: WorkPlanRunView) => WorkPlanRunView][] = [
    ["project", value => ({ ...value, projectId: fixtureIdentity(37006), lastStart: started({ projectId: fixtureIdentity(37006) }) })],
    ["plan", value => ({ ...value, planId: fixtureIdentity(37007), lease: { ...value.lease, planId: fixtureIdentity(37007) }, lastStart: started({ planId: fixtureIdentity(37007) }) })],
    ["lease plan", value => ({ ...value, lease: { ...value.lease, planId: fixtureIdentity(37007) } })],
    ["zero lease generation", value => ({ ...value, lease: { ...value.lease, generation: "0" } })],
    ["start project", value => ({ ...value, lastStart: started({ projectId: fixtureIdentity(37006) }) })],
    ["start plan", value => ({ ...value, lastStart: started({ planId: fixtureIdentity(37007) }) })],
    ["zero start generation", value => ({ ...value, lastStart: started({ expectedGeneration: "0" }) })],
    ["future start generation", value => ({ ...value, lastStart: started({ expectedGeneration: "6" }) })],
    ["future start above JavaScript integer precision", value => ({ ...value, lease: { ...value.lease, generation: "9007199254740992" }, lastStart: started({ expectedGeneration: "9007199254740993" }) })],
    ["start without budget root", value => ({ ...value, budgetRootTaskId: null, budget: null })],
    ["budget without root", value => ({ ...value, lastStart: null, budgetRootTaskId: null })],
  ];
  it.each(mismatches)("rejects a %s association without retry, fallback or mutation", async (_name, change) => {
    const value = change(run({ lease: { planId: request.planId, generation: "5" }, lastStart: started(), budgetRootTaskId: rootTaskId, budget: budget() }));
    expect(validateResponseWorkPlanRun(value)).toBe(true);
    invoke.mockResolvedValueOnce(value);
    await expect(workPlanCommands.run(request)).rejects.toMatchObject({ outcome: "unknown", reason: "invalid-work-plan-acknowledgement" });
    expect(invoke.mock.calls).toEqual([["read_work_plan_run", { request }]]);
  });

  it.each([["uppercase", "A".repeat(64)], ["nonhex", "g".repeat(64)], ["short", "a".repeat(63)], ["long", "a".repeat(65)]])("rejects a %s plan digest", async (_name, planDigest) => {
    invoke.mockResolvedValueOnce({ ...run(), planDigest });
    await expect(workPlanCommands.run(request)).rejects.toThrow();
    expect(invoke.mock.calls).toEqual([["read_work_plan_run", { request }]]);
  });

  it("uses the generated response validator for missing fields, invalid wire types and unexpected request material", async () => {
    const value = run({ lastStart: started(), budgetRootTaskId: rootTaskId, budget: budget() });
    const malformed: unknown[] = [null, undefined, {}, { ...value, budget: undefined }, { ...value, sessionToken: "not-response-material" },
      { ...value, lease: { ...value.lease, generation: 1 } }, { ...value, budgetRootTaskId: "invalid-identity" },
      { ...value, lastStart: { ...value.lastStart, attemptId: null } }, { ...value, lastStart: { ...value.lastStart, taskId: null } },
      { ...value, lastStart: { ...value.lastStart, sessionToken: "not-response-material" } },
      { ...value, budget: { ...value.budget, dispatched: "4" } }, { ...value, budget: { ...value.budget, promptTokens: 42 } }];
    for (const response of malformed) {
      expect(validateResponseWorkPlanRun(response)).toBe(false); invoke.mockResolvedValueOnce(response);
      await expect(workPlanCommands.run(request)).rejects.toThrow();
    }
    expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_run")).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(malformed.length);
  });

  it("preserves a failed read without automatically retrying or submitting any business action", async () => {
    const failure = new Error("Run observation unavailable"); invoke.mockRejectedValueOnce(failure);
    await expect(workPlanCommands.run(request)).rejects.toBe(failure);
    expect(invoke.mock.calls).toEqual([["read_work_plan_run", { request }]]);
  });
});
