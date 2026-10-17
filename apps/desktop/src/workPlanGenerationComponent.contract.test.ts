import { expect, it, vi } from "vitest";
import rawFixture from "../test/fixtures/workPlanGenerationComponent.contract.json";
import type { WorkPlanGenerationPrepareRequest, WorkPlanGenerationStartRequest, WorkPlanGenerationDiscardRequest } from "./generated/ai.requests";
import type { WorkPlanGenerationPreflight, WorkPlanAgentView } from "./generated/ai.responses";
const fixture = rawFixture as unknown as {
  prepare: WorkPlanGenerationPrepareRequest; start: WorkPlanGenerationStartRequest;
  discard: WorkPlanGenerationDiscardRequest; preflight: WorkPlanGenerationPreflight; scope: WorkPlanAgentView;
};
import { workPlanGenerationCommands } from "./workPlanGenerationCommands";
import * as validators from "./generated/ai.validators";
import { generationToolFixture } from "./testSupport/generationToolFixture";
import { applicationWorkPlanTool, workPlanToolStatus } from "./testSupport/workPlanToolFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("uses the generated strict human boundary and excludes plan or model overrides", () => {
  expect(validators.validateRequestWorkPlanGenerationPrepare(fixture.prepare)).toBe(true);
  expect(validators.validateRequestWorkPlanGenerationStart(fixture.start)).toBe(true);
  expect(validators.validateResponseWorkPlanGenerationPreflight(fixture.preflight)).toBe(true);
  expect(validators.validateRequestWorkPlanGenerationDiscard(fixture.discard)).toBe(true);
  expect(validators.validateRequestWorkPlanGenerationPrepare({ ...fixture.prepare, toolQueries: undefined })).toBe(false);
  expect(validators.validateResponseWorkPlanGenerationPreflight({ ...fixture.preflight, preparedTools: undefined })).toBe(false);
  for (const field of ["parentTask", "lease", "model", "budget", "confirmed", "effects", "payload", "input"]) {
    expect(validators.validateRequestWorkPlanGenerationPrepare({ ...fixture.prepare, [field]: true })).toBe(false);
    expect(validators.validateRequestWorkPlanGenerationPrepare({ ...fixture.prepare, generation: { ...fixture.prepare.generation, [field]: true } })).toBe(false);
  }
});
function toolPreparation() {
  const component = structuredClone(fixture.preflight.component);
  component.binding.declaration.inputSchema.id = "tsumugi.generation-component-input";
  component.binding.declaration.permissions.push({ kind: "project-service", contract: structuredClone(workPlanToolStatus.plan.tools!.entries[0].binding.capability.declaration.contract) });
  const query = { taskId: fixtureIdentity(810), attemptId: fixtureIdentity(811),
    toolHandle: workPlanToolStatus.plan.tools!.entries[0].handle, unitIds: [fixture.prepare.generation.unitIds[0]] as [string] };
  const request = { ...structuredClone(fixture.prepare), toolQueries: [query] } satisfies WorkPlanGenerationPrepareRequest;
  const preflight = { ...structuredClone(fixture.preflight), component, preparedTools: [generationToolFixture(query)] };
  return { component, query, request, preflight, tools: workPlanToolStatus.plan.tools!.entries };
}
it.each(["project", "attempt"] as const)("keeps a %s caller's exact tool identities and frozen Host input without accepting payloads", async scope => {
  const { request, component, preflight, tools } = toolPreparation(), original = structuredClone(request);
  component.componentScope = scope;
  invoke.mockResolvedValueOnce(structuredClone(preflight));
  const pending = workPlanGenerationCommands.prepare(request, fixture.scope, component, tools);
  request.toolQueries[0].unitIds[0] = fixtureIdentity(999);
  const prepared = await pending;
  expect(invoke).toHaveBeenLastCalledWith("prepare_work_plan_generation_component", { request: original });
  expect(prepared.preparedTools[0].input).toEqual(preflight.preparedTools[0].input);
  expect(validators.validateRequestWorkPlanGenerationPrepare({ ...original, toolQueries: [{ ...original.toolQueries[0], input: preflight.preparedTools[0].input }] })).toBe(false);
  expect(validators.validateRequestWorkPlanGenerationPrepare({ ...original, toolQueries: [{ ...original.toolQueries[0], payload: {} }] })).toBe(false);
});

it.each([["project", false], ["project", true], ["attempt", false], ["attempt", true]] as const)("pins the %s caller's Application service and full roster (Native: %s)", async (scope, native) => {
  const { request, component, preflight } = toolPreparation(), tool = applicationWorkPlanTool(undefined, native);
  component.componentScope = scope;
  preflight.preparedTools[0].tool = structuredClone(tool);
  invoke.mockResolvedValueOnce(structuredClone(preflight));
  expect((await workPlanGenerationCommands.prepare(request, fixture.scope, component, [tool])).preparedTools[0].tool).toEqual(tool);
  for (const change of [
    { execution: { ...tool.execution, applicationScope: { ...tool.execution.applicationScope!, activationGeneration: 2 } } },
    { applicationCapabilities: [] },
    { applicationCapabilities: [...tool.applicationCapabilities, { ...tool.applicationCapabilities[0], contributionId: "unreviewed.call" }] },
  ]) {
    invoke.mockResolvedValueOnce({ ...preflight, preparedTools: [{ ...preflight.preparedTools[0], tool: { ...tool, ...change } }] });
    await expect(workPlanGenerationCommands.prepare(request, fixture.scope, component, [tool])).rejects.toThrow("acknowledgement");
  }
  const before = invoke.mock.calls.length;
  const invalid = { ...tool, applicationCapabilities: [] };
  await expect(workPlanGenerationCommands.prepare(request, fixture.scope, component, [invalid])).rejects.toThrow("reference selection");
  expect(invoke.mock.calls.length).toBe(before);
});
it("rejects legacy tool queries, duplicate tools or identities and units outside the generation subset before invoking Host", async () => {
  const { request, component, tools } = toolPreparation();
  const before = invoke.mock.calls.length;
  await expect(workPlanGenerationCommands.prepare(request, fixture.scope, fixture.preflight.component, tools)).rejects.toThrow("reference selection");
  const invalidQueries: WorkPlanGenerationPrepareRequest["toolQueries"][] = [
    [{ ...request.toolQueries[0], unitIds: [fixtureIdentity(999)] as [string] }],
    [{ ...request.toolQueries[0], unitIds: [...fixture.prepare.generation.unitIds, fixtureIdentity(999)] as [string, ...string[]] }],
    [{ ...request.toolQueries[0], taskId: fixture.scope.parentTask }],
    [request.toolQueries[0], { ...request.toolQueries[0], taskId: fixtureIdentity(812), attemptId: fixtureIdentity(813) }],
  ];
  for (const toolQueries of invalidQueries) await expect(workPlanGenerationCommands.prepare({ ...request, toolQueries }, fixture.scope, component, tools)).rejects.toThrow("reference selection");
  await expect(workPlanGenerationCommands.prepare(request, fixture.scope, component, [])).rejects.toThrow("reference selection");
  expect(invoke.mock.calls.length).toBe(before);
});
it("refuses an Application caller or Attempt tool before invoking Host", async () => {
  const { request, component, tools } = toolPreparation(), before = invoke.mock.calls.length;
  await expect(workPlanGenerationCommands.prepare(request, fixture.scope, { ...component, componentScope: "application" }, tools)).rejects.toThrow("reference selection");
  const attemptTool = structuredClone(tools[0]); attemptTool.execution.componentScope = "attempt";
  await expect(workPlanGenerationCommands.prepare(request, fixture.scope, component, [attemptTool])).rejects.toThrow("reference selection");
  expect(invoke.mock.calls.length).toBe(before);
});
it("rejects substituted tool preflights even when each response separately matches the generated schema", async () => {
  const { request, component, preflight, tools } = toolPreparation(), originalTool = preflight.preparedTools[0];
  const replacements = [
    [],
    [{ ...originalTool, query: { ...originalTool.query, unitIds: [fixtureIdentity(999)] } }],
    [{ ...originalTool, callId: fixtureIdentity(999) }],
    [{ ...originalTool, tool: { ...originalTool.tool, settingsRevision: "2" } }],
    [{ ...originalTool, input: { ...originalTool.input, schema: { ...originalTool.input.schema, behaviorVersion: 2 } } }],
  ];
  for (const preparedTools of replacements) {
    const response = { ...preflight, preparedTools };
    expect(validators.validateResponseWorkPlanGenerationPreflight(response)).toBe(true);
    invoke.mockResolvedValueOnce(response);
    await expect(workPlanGenerationCommands.prepare(request, fixture.scope, component, tools)).rejects.toThrow("acknowledgement");
  }
});
it("pins preparation and human consent across caller edits, unknown replies and explicit reconciliation", async () => {
  const request = structuredClone(fixture.prepare);
  invoke.mockResolvedValueOnce(structuredClone(fixture.preflight));
  const pending = workPlanGenerationCommands.prepare(request, fixture.scope, fixture.preflight.component);
  request.generation.unitIds.length = 0;
  const prepared = await pending;
  expect(invoke).toHaveBeenLastCalledWith("prepare_work_plan_generation_component", { request: fixture.prepare });
  prepared.attemptId = fixture.prepare.generation.attemptId;
  prepared.inputDigest = "d".repeat(64);
  const consent = { grantId: fixture.start.grantId, expiresAtMs: fixture.start.expiresAtMs, unsandboxedExecution: true };
  invoke.mockRejectedValueOnce({ code: "outcome-unknown", outcome: "unknown" });
  await expect(workPlanGenerationCommands.start(prepared, consent)).rejects.toMatchObject({ code: "outcome-unknown" });
  expect(invoke).toHaveBeenLastCalledWith("start_work_plan_generation_component", { request: fixture.start });
  const calls = invoke.mock.calls.length;
  await expect(workPlanGenerationCommands.start(prepared, { ...consent, grantId: fixture.prepare.generation.taskId })).rejects.toThrow("original consent");
  expect(invoke.mock.calls.length).toBe(calls);
  invoke.mockResolvedValueOnce(fixture.start.attemptId);
  await expect(workPlanGenerationCommands.start(prepared, consent)).resolves.toBe(fixture.start.attemptId);
  await expect(workPlanGenerationCommands.start(structuredClone(prepared), consent)).rejects.toThrow("not prepared");
});
it("rejects stale but plausible scope, source, installation and child identities", async () => {
  const replacements = [
    { scopeId: fixture.prepare.generation.taskId }, { parentTask: fixture.prepare.generation.taskId },
    { attemptId: fixture.prepare.generation.attemptId },
    { generation: { ...fixture.preflight.generation, attemptId: fixture.start.attemptId } },
    { component: { ...fixture.preflight.component, settingsRevision: "2" } },
    { component: { ...fixture.preflight.component, componentScope: "attempt" } },
    { scope: fixture.preflight.scope.map(unit => ({ ...unit, sourceRevisionId: fixture.start.attemptId })) },
  ];
  for (const replacement of replacements) {
    const response = { ...fixture.preflight, ...replacement };
    expect(validators.validateResponseWorkPlanGenerationPreflight(response)).toBe(true);
    invoke.mockResolvedValueOnce(response);
    await expect(workPlanGenerationCommands.prepare(fixture.prepare, fixture.scope, fixture.preflight.component)).rejects.toThrow("acknowledgement");
  }
  invoke.mockResolvedValueOnce(structuredClone(fixture.preflight));
  const prepared = await workPlanGenerationCommands.prepare(fixture.prepare, fixture.scope, fixture.preflight.component);
  invoke.mockResolvedValueOnce(fixture.prepare.generation.attemptId);
  await expect(workPlanGenerationCommands.start(prepared, fixture.start)).rejects.toThrow("acknowledgement");
  invoke.mockResolvedValueOnce(false);
  await expect(workPlanGenerationCommands.discard(fixture.discard)).resolves.toBe(false);
});
