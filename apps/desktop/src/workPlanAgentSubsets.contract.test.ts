import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/workPlanAgent.contract.json";
import tools from "../test/fixtures/workPlanAgentTools.contract.json";
import { openWorkPlanAgent, workPlanCommands } from "./workPlanCommands";
import * as validators from "./generated/ai.validators";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
async function root() {
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.scope));
  return openWorkPlanAgent(fixture.requests.open, fixture.responses.scope.scope, workPlanToolStatus.plan.tools?.entries ?? []);
}
function childAck(request: { scopeId: string; delegation: { delegationId: string; unitIds: string[]; toolHandles: string[] } }) {
  const value: unknown = { ...structuredClone(fixture.responses.child), delegation: { ...structuredClone(request.delegation), parentScopeId: request.scopeId },
    scope: structuredClone(fixture.responses.scope.scope.filter(unit => request.delegation.unitIds.includes(unit.unitId))) };
  if (!validators.validateResponseWorkPlanAgent(value) || !value.delegation) throw new Error("Invalid child scope fixture");
  return { ...value, delegation: value.delegation };
}
async function child(parent: Awaited<ReturnType<typeof root>>, ids = fixture.requests.delegate.delegation.unitIds, handles: string[] = []) {
  invoke.mockImplementationOnce(async (_command, args) => childAck(args.request));
  return parent.delegate({ unitIds: [...ids], toolHandles: [...handles] });
}
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);

it("uses the shared strict delegation and generation read wire without widening the public consumer", async () => {
  for (const [validate, value] of [
    [validators.validateRequestWorkPlanAgentDelegate, fixture.requests.delegate],
    [validators.validateRequestWorkPlanAgentGenerationAttempt, fixture.requests.generationAttempt],
    [validators.validateRequestWorkPlanAgentGenerationOutput, fixture.requests.generationOutput],
    [validators.validateResponseWorkPlanAgent, fixture.responses.child],
    [validators.validateResponseWorkPlanAgentGenerationAttempt, fixture.responses.generationAttempt],
    [validators.validateResponseWorkPlanAgentGenerationOutput, fixture.responses.generationOutput],
    [validators.validateRequestWorkPlanAgentReconcile, fixture.requests.reconcile],
    [validators.validateResponseWorkPlanAgentReconcile, fixture.responses.reconciliation],
  ] as const) expect(validate(value), validate.name).toBe(true);
  const parent = await root(), leaf = await child(parent);
  expect("delegate" in leaf).toBe(false);
  expect(Object.keys(leaf).sort()).toEqual(Object.keys(parent).filter(key => key !== "delegate").sort());
  for (const key of ["control", "authorize", "history", "open", "store", "configure"]) expect(key in leaf).toBe(false);
  const { delegation: _missing, ...withoutDelegation } = fixture.responses.scope;
  expect(validators.validateResponseWorkPlanAgent(withoutDelegation)).toBe(false);
  invoke.mockResolvedValueOnce(fixture.responses.child);
  await expect(openWorkPlanAgent(fixture.requests.open, fixture.responses.scope.scope)).rejects.toBeDefined();
});

it("keeps human reconciliation outside bounded consumers and checks every original acknowledgement identity", async () => {
  const parent = await root(), leaf = await child(parent);
  expect("reconcileAgent" in parent).toBe(false); expect("reconcileAgent" in leaf).toBe(false);
  for (const outcome of ["active", "enqueued", "not-enqueued"]) {
    invoke.mockResolvedValueOnce({ ...structuredClone(fixture.responses.reconciliation), outcome });
    expect((await workPlanCommands.reconcileAgent(fixture.requests.reconcile)).outcome).toBe(outcome);
  }
  for (const identity of [
    { ...fixture.responses.reconciliation.identity, taskId: fixture.responses.scope.parentTask },
    { ...fixture.responses.reconciliation.identity, attemptId: fixture.responses.scope.parentTask },
    { ...fixture.responses.reconciliation.identity, inputDigest: "b".repeat(64) },
    { ...fixture.responses.reconciliation.identity, lease: { ...fixture.requests.reconcile.lease, generation: "1" } },
  ]) {
    invoke.mockResolvedValueOnce({ ...structuredClone(fixture.responses.reconciliation), identity });
    await expect(workPlanCommands.reconcileAgent(fixture.requests.reconcile)).rejects.toMatchObject({ outcome: "unknown" });
  }
  let finish!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  const request = structuredClone(fixture.requests.reconcile), reading = workPlanCommands.reconcileAgent(request);
  request.attemptId = fixture.responses.scope.parentTask; finish(fixture.responses.reconciliation);
  expect((await reading).identity.attemptId).toBe(fixture.requests.reconcile.attemptId);
  expect(calls("start_work_plan_agent_generation")).toHaveLength(0);
});

it("captures canonical original subsets before awaiting and retries the same proposal identity after unknown", async () => {
  const parent = await root();
  let release!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(done => { release = done; }));
  const proposal = { unitIds: fixture.responses.scope.scope.map(unit => unit.unitId).reverse(), toolHandles: [tools.spec.handle] };
  const first = parent.delegate(proposal), request = structuredClone(calls("delegate_work_plan_agent_scope")[0][1].request);
  proposal.unitIds.length = 0; proposal.toolHandles.length = 0;
  release(null);
  await expect(first).rejects.toBeDefined();
  invoke.mockImplementationOnce(async (_command, args) => childAck(args.request));
  const leaf = await parent.delegate(proposal);
  expect(calls("delegate_work_plan_agent_scope")[1][1].request).toEqual(request);
  expect(request.delegation.unitIds).toEqual(fixture.responses.scope.scope.map(unit => unit.unitId).sort());
  expect(leaf.scope.delegation?.toolHandles).toEqual([tools.spec.handle]);
  const next = { unitIds: [fixture.responses.scope.scope[0].unitId], toolHandles: [] };
  await child(parent, next.unitIds);
  expect(calls("delegate_work_plan_agent_scope")[2][1].request.delegation.delegationId).not.toBe(request.delegation.delegationId);
});

it("rejects duplicate or outside subsets and mismatched child identities, source facts and parents", async () => {
  const parent = await root(), id = fixture.responses.scope.scope[0].unitId;
  for (const proposal of [{ unitIds: [], toolHandles: [] }, { unitIds: [id, id], toolHandles: [] },
    { unitIds: [fixture.responses.scope.parentTask], toolHandles: [] }, { unitIds: [id], toolHandles: [tools.spec.handle, tools.spec.handle] },
    { unitIds: [id], toolHandles: [fixture.responses.scope.parentTask] }, { unitIds: [id], toolHandles: [], config: {} }])
    await expect(parent.delegate(proposal)).rejects.toThrow("Invalid Agent subset request");
  expect(calls("delegate_work_plan_agent_scope")).toHaveLength(0);
  for (const mismatch of ["parent", "lease", "tool", "basis", "null", "root"] as const) {
    invoke.mockImplementationOnce(async (_command, args) => {
      const ack = childAck(args.request);
      if (mismatch === "parent") ack.delegation.parentScopeId = fixture.responses.scope.parentTask;
      if (mismatch === "lease") ack.lease.generation = "1";
      if (mismatch === "tool") ack.delegation.toolHandles = [tools.spec.handle];
      if (mismatch === "basis") ack.scope[0].sourceRevisionId = fixture.responses.scope.parentTask;
      if (mismatch === "null") return { ...ack, delegation: null };
      if (mismatch === "root") ack.scopeId = fixture.responses.scope.scopeId;
      return ack;
    });
    await expect(parent.delegate({ unitIds: [id], toolHandles: [] })).rejects.toBeDefined();
  }
});

it("delivers generation pages and exact outputs only through the original leaf and unchanged preparation", async () => {
  const parent = await root(), leaf = await child(parent), sibling = await child(parent);
  invoke.mockResolvedValueOnce({ ...structuredClone(fixture.responses.generation), scopeId: leaf.scope.scopeId });
  const prepared = await leaf.prepare(fixture.requests.prepare.generation);
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.generationAttempt));
  expect(await leaf.readGenerationAttempt(prepared, { offset: 0, limit: 100 })).toEqual(fixture.responses.generationAttempt);
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_agent_generation_attempt", { request: { ...fixture.requests.generationAttempt, scopeId: leaf.scope.scopeId } });
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.generationOutput));
  expect(await leaf.readGenerationOutput(prepared, fixture.requests.generationOutput.itemId, fixture.requests.generationOutput.resultId)).toEqual(fixture.responses.generationOutput);
  const before = invoke.mock.calls.length;
  for (const other of [parent, sibling]) {
    await expect(other.readGenerationAttempt(prepared, { offset: 0, limit: 1 })).rejects.toThrow("not prepared");
    await expect(other.readGenerationOutput(prepared, fixture.requests.generationOutput.itemId, fixture.requests.generationOutput.resultId)).rejects.toThrow("not prepared");
  }
  await expect(leaf.readGenerationAttempt(structuredClone(prepared), { offset: 0, limit: 1 })).rejects.toThrow("not prepared");
  prepared.scope[0].nativeKey = "newer caller text";
  await expect(leaf.readGenerationAttempt(prepared, { offset: 0, limit: 1 })).rejects.toThrow("changed");
  expect(invoke).toHaveBeenCalledTimes(before);
  expect(calls("read_execution_output")).toHaveLength(0);
});

it("keeps tool preparation and guidance inside the exact child rather than a same-plan root or sibling", async () => {
  const parent = await root(), leaf = await child(parent, undefined, [tools.spec.handle]), sibling = await child(parent, undefined, [tools.spec.handle]);
  invoke.mockResolvedValueOnce({ ...structuredClone(tools.responses.prepared), scopeId: leaf.scope.scopeId });
  const prepared = await leaf.prepareTool(tools.requests.prepare.tool);
  for (const other of [parent, sibling]) await expect(other.readToolAttempt(prepared, { offset: 0, limit: 1 })).rejects.toThrow("not prepared");
  invoke.mockResolvedValueOnce({ scopeId: leaf.scope.scopeId, parentTask: leaf.scope.parentTask, tools: [tools.spec] });
  expect((await leaf.readGuidance()).tools).toEqual([tools.spec]);
  const empty = await child(parent);
  await expect(empty.prepareTool(tools.requests.prepare.tool)).rejects.toThrow("Invalid Agent tool request");
  await expect(empty.readSkill(tools.spec.handle)).rejects.toThrow("outside");
  invoke.mockResolvedValueOnce({ scopeId: empty.scope.scopeId, parentTask: empty.scope.parentTask, tools: [] });
  expect((await empty.readGuidance()).tools).toEqual([]);
});

it("rejects generation page or output mismatches and late changes without falling back to human history", async () => {
  const parent = await root(), leaf = await child(parent);
  invoke.mockResolvedValueOnce({ ...structuredClone(fixture.responses.generation), scopeId: leaf.scope.scopeId });
  const prepared = await leaf.prepare(fixture.requests.prepare.generation);
  for (const page of [{ offset: -1, limit: 1 }, { offset: 0, limit: 101 }, { offset: 2, limit: 1 }, { offset: 0, limit: 1, confirmed: true }])
    await expect(leaf.readGenerationAttempt(prepared, page)).rejects.toThrow("Invalid Agent");
  for (const change of [{ taskId: fixture.responses.scope.parentTask }, { nextOffset: 1 }, { items: [] },
    { items: [{ ...fixture.responses.generationAttempt.items[0], scope: { kind: "unit", id: fixture.responses.scope.parentTask, locale: "zh-CN" } }] }]) {
    invoke.mockResolvedValueOnce({ ...structuredClone(fixture.responses.generationAttempt), ...change });
    await expect(leaf.readGenerationAttempt(prepared, { offset: 0, limit: 1 })).rejects.toBeDefined();
  }
  for (const key of ["projectId", "attemptId", "itemId", "resultId"] as const) {
    invoke.mockResolvedValueOnce({ ...structuredClone(fixture.responses.generationOutput), [key]: fixture.responses.scope.parentTask });
    await expect(leaf.readGenerationOutput(prepared, fixture.requests.generationOutput.itemId, fixture.requests.generationOutput.resultId)).rejects.toBeDefined();
  }
  let finish!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  const reading = leaf.readGenerationAttempt(prepared, { offset: 0, limit: 1 });
  prepared.inputDigest = "b".repeat(64); finish(fixture.responses.generationAttempt);
  await expect(reading).rejects.toThrow("changed");
  expect(calls("read_execution_attempt")).toHaveLength(0); expect(calls("read_execution_output")).toHaveLength(0);
});
