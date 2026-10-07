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
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("uses the generated strict human boundary and excludes plan or model overrides", () => {
  expect(validators.validateRequestWorkPlanGenerationPrepare(fixture.prepare)).toBe(true);
  expect(validators.validateRequestWorkPlanGenerationStart(fixture.start)).toBe(true);
  expect(validators.validateResponseWorkPlanGenerationPreflight(fixture.preflight)).toBe(true);
  expect(validators.validateRequestWorkPlanGenerationDiscard(fixture.discard)).toBe(true);
  for (const field of ["parentTask", "lease", "model", "budget", "confirmed", "effects"]) {
    expect(validators.validateRequestWorkPlanGenerationPrepare({ ...fixture.prepare, [field]: true })).toBe(false);
    expect(validators.validateRequestWorkPlanGenerationPrepare({ ...fixture.prepare, generation: { ...fixture.prepare.generation, [field]: true } })).toBe(false);
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
