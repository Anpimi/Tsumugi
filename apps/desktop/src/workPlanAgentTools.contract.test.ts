import { beforeEach, expect, it, vi } from "vitest";
import planFixture from "../test/fixtures/workPlanCommands.contract.json";
import agentFixture from "../test/fixtures/workPlanAgent.contract.json";
import fixture from "../test/fixtures/workPlanAgentTools.contract.json";
import { openWorkPlanAgent, workPlanCommands } from "./workPlanCommands";
import { validateResponseTool } from "./generated/plugins.validators";
import { workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import * as validators from "./generated/ai.validators";
import type { WorkPlanPrepareRequest } from "./generated/ai.requests";

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
