import { beforeEach, expect, it, vi } from "vitest";
import planFixture from "../test/fixtures/workPlanCommands.contract.json";
import agentFixture from "../test/fixtures/workPlanAgent.contract.json";
import fixture from "../test/fixtures/workPlanAgentTools.contract.json";
import { openWorkPlanAgent, workPlanCommands } from "./workPlanCommands";
import { validateResponseTool } from "./generated/plugins.validators";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import * as validators from "./generated/ai.validators";
import type { WorkPlanPrepareRequest } from "./generated/ai.requests";
import type { AttemptDetail, ExecutionOutputView, WorkPlanAgentToolView } from "./generated/ai.responses";
import { isCommandError } from "./projectCommands";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
const unknownAck = { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };
async function opened() {
  if (!validators.validateResponseWorkPlanAgentTool(fixture.responses.prepared)) throw new Error("Invalid shared tool fixture");
  const tools = { maxInvocations: 2, entries: [fixture.spec] };
  const captured: unknown = { ...planFixture.responses.plan, tools };
  if (!validators.validateResponseWorkPlan(captured) || !captured.tools) throw new Error("Invalid captured tool fixture");
  // The same generated schema owns the captured tool entry and strict requests.
  invoke.mockResolvedValueOnce(structuredClone(agentFixture.responses.scope));
  return openWorkPlanAgent(agentFixture.requests.open, agentFixture.responses.scope.scope, captured.tools.entries);
}

it("retains the complete captured tool execution binding and rejects legacy split fields", () => {
  expect(fixture.spec.execution).toEqual({ capability: fixture.toolView.binding.capability,
    componentScope: fixture.toolView.componentScope, applicationScope: null, profile: fixture.toolView.binding.declaration.profile,
    environment: fixture.toolView.environment });
  const plan = { ...planFixture.responses.plan, tools: { maxInvocations: 2, entries: [fixture.spec] } };
  expect(validators.validateResponseWorkPlan(plan)).toBe(true);
  const { execution, ...missingExecution } = fixture.spec;
  for (const entry of [missingExecution,
    { ...fixture.spec, componentScope: execution.componentScope },
    { ...fixture.spec, environment: execution.environment }]) {
    expect(validators.validateResponseWorkPlan({ ...plan, tools: { ...plan.tools, entries: [entry] } })).toBe(false);
  }
});

it("shares strict tool contracts and starts only an exact preparation from its original consumer", async () => {
  expect(validators.validateRequestWorkPlanAgentToolPrepare(fixture.requests.prepare)).toBe(true);
  expect(validators.validateRequestWorkPlanAgentToolStart(fixture.requests.start)).toBe(true);
  const consumer = await opened();
  const proposal = structuredClone(fixture.requests.prepare.tool);
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.prepared));
  const preparing = consumer.prepareTool(proposal);
  proposal.unitIds.length = 0;
  const prepared = await preparing;
  expect(invoke).toHaveBeenLastCalledWith("prepare_work_plan_agent_tool", { request: fixture.requests.prepare });
  prepared.inputDigest = "d".repeat(64); prepared.attemptId = agentFixture.responses.scope.parentTask;
  invoke.mockResolvedValueOnce(fixture.responses.prepared.attemptId);
  expect(await consumer.startTool(prepared)).toBe(fixture.responses.prepared.attemptId);
  expect(invoke).toHaveBeenLastCalledWith("start_work_plan_agent_tool", { request: fixture.requests.start });
  await expect(consumer.startTool(structuredClone(fixture.responses.prepared))).rejects.toThrow("not prepared");
  const other = await opened();
  await expect(other.startTool(prepared)).rejects.toThrow("not prepared");
});

it("rejects caller identity, execution consent, raw text and expanded material before IPC", async () => {
  const consumer = await opened();
  for (const field of ["payload", "text", "caller", "confirmed", "grantId", "unsandboxedExecution", "expiresAtMs", "binding", "target", "selections", "lease"])
    await expect(consumer.prepareTool({ ...fixture.requests.prepare.tool, [field]: true })).rejects.toThrow("Invalid Agent tool request");
  for (const proposal of [null, [], {}, { ...fixture.requests.prepare.tool, toolHandle: agentFixture.responses.scope.parentTask },
    { ...fixture.requests.prepare.tool, unitIds: [] }, { ...fixture.requests.prepare.tool, unitIds: [fixture.requests.prepare.tool.unitIds[0], fixture.requests.prepare.tool.unitIds[0]] },
    { ...fixture.requests.prepare.tool, unitIds: ["60000000-0000-4000-8000-000000000099"] }])
    await expect(consumer.prepareTool(proposal)).rejects.toThrow("Invalid Agent tool request");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects changed source basis, root, tool handle, identities and unknown start acknowledgements without resending", async () => {
  for (const change of [
    { scopeId: agentFixture.responses.scope.parentTask }, { parentTask: fixture.responses.prepared.taskId },
    { taskId: agentFixture.responses.scope.parentTask }, { attemptId: agentFixture.responses.scope.parentTask },
    { toolHandle: agentFixture.responses.scope.parentTask }, { scope: [] }, { inputDigest: "invalid" },
    { scope: [{ ...fixture.responses.prepared.scope[0], sourceRevisionId: fixture.responses.prepared.taskId }] },
  ]) {
    const consumer = await opened();
    invoke.mockResolvedValueOnce({ ...fixture.responses.prepared, ...change });
    await expect(consumer.prepareTool(fixture.requests.prepare.tool)).rejects.toMatchObject(unknownAck);
  }
  const consumer = await opened();
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.prepared));
  const prepared = await consumer.prepareTool(fixture.requests.prepare.tool);
  const before = invoke.mock.calls.length;
  invoke.mockResolvedValueOnce(null);
  await expect(consumer.startTool(prepared)).rejects.toMatchObject(unknownAck);
  expect(invoke).toHaveBeenCalledTimes(before + 1);
});

it("pins complete captured tool metadata and options in work-plan preparation acknowledgements", async () => {
  const view: unknown = structuredClone(fixture.toolView);
  if (!validateResponseTool(view)) throw new Error("Invalid captured environment fixture");
  const request: WorkPlanPrepareRequest = { ...planFixture.requests.prepare,
    config: workPlanToolStatus.plan.preview?.config ?? null, options: workPlanToolStatus.plan.options,
    unitIds: workPlanToolStatus.plan.scope.map(unit => unit.unitId),
    toolSelection: { maxInvocations: 2, entries: [{ handle: fixture.spec.handle, tool: {
      package: { plugin: view.binding.capability.provider.plugin, packageDigest: view.binding.capability.provider.packageDigest },
      resourceId: view.resourceId, environmentDigest: view.environmentDigest,
    }, target: fixture.spec.target, selections: fixture.spec.selections }] },
  };
  expect(validators.validateRequestWorkPlanPrepare(request)).toBe(true);
  invoke.mockResolvedValueOnce(structuredClone(workPlanToolStatus.plan));
  expect(await workPlanCommands.prepare(request, [view])).toEqual(workPlanToolStatus.plan);
  for (const change of [
    { handle: fixture.responses.prepared.taskId }, { target: "other-target" }, { selections: [] },
    { settingsRevision: "2" }, { packageOrigin: { different: true } }, { runtimeOrigin: { different: true } },
    { binding: { ...fixture.spec.binding, capability: { ...fixture.spec.binding.capability, provider: { ...fixture.spec.binding.capability.provider, packageDigest: "f".repeat(64) } } } },
    { execution: { ...fixture.spec.execution, environment: { ...fixture.spec.execution.environment, toolVersion: "changed" } } },
    { execution: { ...fixture.spec.execution, componentScope: "attempt" } },
  ]) {
    const changed = structuredClone(workPlanToolStatus.plan);
    if (!changed.tools) throw new Error("Missing tool fixture");
    Object.assign(changed.tools.entries[0], change);
    invoke.mockResolvedValueOnce(changed);
    await expect(workPlanCommands.prepare(request, [view])).rejects.toMatchObject({ outcome: "unknown" });
  }
});

async function preparedTool() {
  const consumer = await opened();
  invoke.mockResolvedValueOnce(structuredClone(fixture.responses.prepared));
  const prepared = await consumer.prepareTool(fixture.requests.prepare.tool);
  return { consumer, prepared };
}
function attemptFixture(): AttemptDetail {
  const value: unknown = structuredClone(fixture.responses.attempt);
  if (!validators.validateResponseWorkPlanAgentToolAttempt(value)) throw new Error("Invalid scoped attempt fixture");
  return value;
}
function outputFixture(): ExecutionOutputView {
  const value: unknown = structuredClone(fixture.responses.output);
  if (!validators.validateResponseWorkPlanAgentToolOutput(value)) throw new Error("Invalid scoped output fixture");
  return value;
}

it("reads only the captured tool attempt and exact item result while preserving empty output and channel evidence", async () => {
  expect(validators.validateRequestWorkPlanAgentToolAttempt(fixture.requests.attempt)).toBe(true);
  expect(validators.validateRequestWorkPlanAgentToolOutput(fixture.requests.output)).toBe(true);
  const { consumer, prepared } = await preparedTool(), detail = attemptFixture(), output = outputFixture();
  invoke.mockResolvedValueOnce(detail);
  expect(await consumer.readToolAttempt(prepared, { offset: 0, limit: 100 })).toEqual(detail);
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_agent_tool_attempt", { request: fixture.requests.attempt });
  invoke.mockResolvedValueOnce(output);
  const result = await consumer.readToolOutput(prepared, { itemId: output.itemId, resultId: output.resultId });
  expect(result).toEqual(output);
  expect(result.output).toEqual({});
  expect(result.plugin).toEqual(output.plugin);
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_agent_tool_output", { request: fixture.requests.output });
  expect(invoke.mock.calls.every(([command]) => ["open_work_plan_agent_scope", "prepare_work_plan_agent_tool",
    "read_work_plan_agent_tool_attempt", "read_work_plan_agent_tool_output"].includes(command))).toBe(true);
});

it("refuses cloned, foreign and rewritten preparation DTOs before a scoped read", async () => {
  const { consumer, prepared } = await preparedTool();
  const other = await opened(), before = invoke.mock.calls.length;
  const page = { offset: 0, limit: 100 }, output = { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId };
  await expect(consumer.readToolAttempt(structuredClone(prepared), page)).rejects.toThrow("not prepared");
  await expect(other.readToolAttempt(prepared, page)).rejects.toThrow("not prepared");
  await expect(consumer.readToolOutput(structuredClone(prepared), output)).rejects.toThrow("not prepared");
  await expect(other.readToolOutput(prepared, output)).rejects.toThrow("not prepared");
  prepared.scope[0].nativeKey = "edited presentation is not an original preparation";
  await expect(consumer.readToolAttempt(prepared, page)).rejects.toThrow("preparation changed");
  await expect(consumer.readToolOutput(prepared, output)).rejects.toThrow("preparation changed");
  expect(invoke).toHaveBeenCalledTimes(before);
});

it("bounds pagination and refuses caller authority or extra result fields without invoking", async () => {
  const { consumer, prepared } = await preparedTool(), before = invoke.mock.calls.length;
  for (const page of [{ offset: -1, limit: 1 }, { offset: 0.5, limit: 1 }, { offset: 2, limit: 1 },
    { offset: 0, limit: 0 }, { offset: 0, limit: 101 }, { offset: 0, limit: 1.5 },
    { offset: 0, limit: 1, scopeId: prepared.scopeId }, { offset: 0, limit: 1, confirmed: true }]) {
    await expect(consumer.readToolAttempt(prepared, page)).rejects.toThrow("Invalid Agent tool read request");
  }
  for (const result of [{ itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId, scopeId: prepared.scopeId },
    { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId, inputDigest: prepared.inputDigest },
    { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId, projectId: fixture.requests.output.projectId },
    { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId, allowAdopt: true }]) {
    await expect(consumer.readToolOutput(prepared, result)).rejects.toThrow("Invalid Agent tool read request");
  }
  expect(invoke).toHaveBeenCalledTimes(before);
});

it("keeps the original captured request fixed when caller page or result options change while awaiting", async () => {
  const { consumer, prepared } = await preparedTool();
  let finishAttempt!: (value: AttemptDetail) => void;
  invoke.mockImplementationOnce(() => new Promise<AttemptDetail>(resolve => { finishAttempt = resolve; }));
  const page = { offset: 0, limit: 100 }, reading = consumer.readToolAttempt(prepared, page);
  page.offset = 1; page.limit = 1;
  finishAttempt(attemptFixture());
  expect(await reading).toEqual(attemptFixture());
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_agent_tool_attempt", { request: fixture.requests.attempt });
  let finishOutput!: (value: ExecutionOutputView) => void;
  invoke.mockImplementationOnce(() => new Promise<ExecutionOutputView>(resolve => { finishOutput = resolve; }));
  const result = { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId };
  const output = consumer.readToolOutput(prepared, result);
  result.resultId = prepared.taskId;
  finishOutput(outputFixture());
  expect(await output).toEqual(outputFixture());
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_agent_tool_output", { request: fixture.requests.output });
});

it("rejects a late read if its original prepared DTO changes during the IPC wait", async () => {
  for (const kind of ["attempt", "output"] as const) {
    const { consumer, prepared } = await preparedTool();
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = kind === "attempt" ? consumer.readToolAttempt(prepared, { offset: 0, limit: 100 })
      : consumer.readToolOutput(prepared, { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId });
    prepared.inputDigest = "e".repeat(64);
    finish(kind === "attempt" ? attemptFixture() : outputFixture());
    await expect(reading).rejects.toThrow("preparation changed");
  }
});

it("retains bounded ledger pagination without assuming item order matches the captured unit order", async () => {
  const consumer = await opened(), scope = structuredClone(agentFixture.responses.scope.scope);
  const response: WorkPlanAgentToolView = { ...fixture.responses.prepared, scope };
  invoke.mockResolvedValueOnce(response);
  const prepared = await consumer.prepareTool({ ...fixture.requests.prepare.tool, unitIds: scope.map(unit => unit.unitId) });
  const first = attemptFixture(), item = first.items[0];
  first.progress = { ...first.progress, total: 2, succeeded: 2 };
  first.items = [{ ...item, scope: { ...item.scope, id: scope[1].unitId } }];
  first.nextOffset = 1;
  invoke.mockResolvedValueOnce(first);
  expect(await consumer.readToolAttempt(prepared, { offset: 0, limit: 1 })).toEqual(first);
  // The same item cannot be silently projected at another position.
  invoke.mockResolvedValueOnce({ ...first, nextOffset: null });
  await expect(consumer.readToolAttempt(prepared, { offset: 1, limit: 1 })).rejects.toMatchObject(unknownAck);
  const second: AttemptDetail = { ...first, nextOffset: null,
    items: [{ ...item, scope: { ...item.scope, id: scope[0].unitId }, status: { ...item.status, itemId: "60000000-0000-4000-8000-000000000026" }, resultId: "60000000-0000-4000-8000-000000000027" }] };
  invoke.mockResolvedValueOnce(second);
  expect(await consumer.readToolAttempt(prepared, { offset: 1, limit: 1 })).toEqual(second);
  invoke.mockResolvedValueOnce({ ...second, items: [...second.items, ...first.items] });
  await expect(consumer.readToolAttempt(prepared, { offset: 0, limit: 2 })).rejects.toMatchObject(unknownAck);
  invoke.mockResolvedValueOnce({ ...second, items: [...first.items, ...first.items] });
  await expect(consumer.readToolAttempt(prepared, { offset: 0, limit: 2 })).rejects.toMatchObject(unknownAck);
  invoke.mockResolvedValueOnce({ ...second, items: [], nextOffset: null });
  expect((await consumer.readToolAttempt(prepared, { offset: 2, limit: 1 })).items).toEqual([]);
  const changedLocale = { ...second, items: second.items.map(item => ({ ...item, scope: { ...item.scope, locale: "ja" } })) };
  invoke.mockResolvedValueOnce(changedLocale);
  await expect(consumer.readToolAttempt(prepared, { offset: 1, limit: 1 })).rejects.toMatchObject(unknownAck);
});

it("refuses mismatched attempts, pages, unit scopes and exact item result acknowledgements", async () => {
  for (const change of [{ attemptId: fixture.responses.prepared.taskId }, { taskId: fixture.responses.prepared.attemptId },
    { operation: "ai-translation" }, { recovery: { ...attemptFixture().recovery, attemptId: fixture.responses.prepared.taskId } },
    { progress: { ...attemptFixture().progress, total: 2 } }, { nextOffset: 1 }, { items: [] },
    { items: attemptFixture().items.map(item => ({ ...item, scope: { ...item.scope, id: fixture.responses.prepared.taskId } })) },
    { items: attemptFixture().items.map(item => ({ ...item, scope: { ...item.scope, kind: "project" } })) }]) {
    const { consumer, prepared } = await preparedTool();
    invoke.mockResolvedValueOnce({ ...attemptFixture(), ...change });
    await expect(consumer.readToolAttempt(prepared, { offset: 0, limit: 100 })).rejects.toMatchObject(unknownAck);
  }
  for (const change of [{ projectId: fixture.responses.prepared.taskId }, { attemptId: fixture.responses.prepared.taskId },
    { itemId: fixture.responses.prepared.taskId }, { resultId: fixture.responses.prepared.taskId }, { plugin: null }]) {
    const { consumer, prepared } = await preparedTool();
    invoke.mockResolvedValueOnce({ ...outputFixture(), ...change });
    await expect(consumer.readToolOutput(prepared, { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId })).rejects.toMatchObject(unknownAck);
  }
});

it("keeps a late response bound to its own preparation even when another query is prepared", async () => {
  const { consumer, prepared } = await preparedTool();
  let finish!: (value: AttemptDetail) => void;
  invoke.mockImplementationOnce(() => new Promise<AttemptDetail>(resolve => { finish = resolve; }));
  const earlier = consumer.readToolAttempt(prepared, { offset: 0, limit: 100 });
  const proposal = { ...fixture.requests.prepare.tool, taskId: "60000000-0000-4000-8000-000000000028", attemptId: "60000000-0000-4000-8000-000000000029" };
  invoke.mockResolvedValueOnce({ ...fixture.responses.prepared, taskId: proposal.taskId, attemptId: proposal.attemptId });
  const next = await consumer.prepareTool(proposal);
  const otherDetail = { ...attemptFixture(), taskId: next.taskId, attemptId: next.attemptId,
    recovery: { ...attemptFixture().recovery, attemptId: next.attemptId } };
  finish(otherDetail);
  await expect(earlier).rejects.toMatchObject(unknownAck);
  invoke.mockResolvedValueOnce(otherDetail);
  expect((await consumer.readToolAttempt(next, { offset: 0, limit: 100 })).attemptId).toBe(next.attemptId);
});

it("distinguishes not-enqueued, running, failed and inactive-scope reads without starting or falling back to human history", async () => {
  const { consumer, prepared } = await preparedTool(), before = invoke.mock.calls.length;
  const notEnqueued = { code: "dependency-conflict", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "work-plan-tool-not-enqueued" };
  expect(isCommandError(notEnqueued)).toBe(true);
  invoke.mockRejectedValueOnce(notEnqueued);
  await expect(consumer.readToolAttempt(prepared, { offset: 0, limit: 100 })).rejects.toEqual(notEnqueued);
  const queued = attemptFixture(); queued.progress = { ...queued.progress, succeeded: 0, queued: 1 };
  queued.items = queued.items.map(item => ({ ...item, resultId: null, status: { ...item.status, execution: "queued", validation: "absent" } }));
  invoke.mockResolvedValueOnce(queued);
  expect((await consumer.readToolAttempt(prepared, { offset: 0, limit: 100 })).items[0].resultId).toBeNull();
  const failed = outputFixture();
  if (!failed.plugin || failed.plugin.result.outcome.kind !== "succeeded") throw new Error("Missing structured tool fixture");
  failed.outcome = "failed"; failed.output = null; failed.diagnostic = { code: "declared-tool-failure", retrySafe: false };
  failed.plugin.result.outcome = { kind: "failed", error: { ...failed.plugin.result.outcome.output,
    schema: fixture.spec.execution.capability.declaration.errorSchema } };
  invoke.mockResolvedValueOnce(failed);
  expect((await consumer.readToolOutput(prepared, { itemId: failed.itemId, resultId: failed.resultId })).outcome).toBe("failed");
  const inactive = { code: "permission-denied", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "work-plan-agent-scope" };
  expect(isCommandError(inactive)).toBe(true);
  invoke.mockRejectedValueOnce(inactive);
  await expect(consumer.readToolOutput(prepared, { itemId: fixture.requests.output.itemId, resultId: fixture.requests.output.resultId })).rejects.toEqual(inactive);
  expect(invoke.mock.calls.slice(before).map(([command]) => command)).toEqual([
    "read_work_plan_agent_tool_attempt", "read_work_plan_agent_tool_attempt", "read_work_plan_agent_tool_output", "read_work_plan_agent_tool_output",
  ]);
});
