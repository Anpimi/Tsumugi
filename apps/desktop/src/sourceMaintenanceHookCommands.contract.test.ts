import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/sourceCommands.contract.json";
import { sourceMaintenanceHookCommands as commands, type SourceMaintenanceHookObservation, type SourceMaintenanceHookStopRequest } from "./sourceMaintenanceHookCommands";
import { sourceCommands, confirmSourceAction, type SourceAdoptRequest } from "./sourceCommands";
import { sourceActionFixture } from "./testSupport/sourceFixture";
import { hookActivation, hookObservation } from "./testSupport/sourceMaintenanceHookFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { hasUnknownOutcome } from "./projectCommands";
const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
const read = { ...fixture.session, sourceActionId: fixture.prepare.actionId };
it("reads only the explicit session, exact original action and stable stop request through generated IPC contracts", async () => {
  const session = { policyVersion: "source-maintenance-notice-1", sessionEpoch: id(8800), defaultLifetimeMs: 300_000, maxLifetimeMs: 600_000, windowLimit: 100 };
  invoke.mockResolvedValueOnce(session); expect(await commands.session(fixture.session)).toEqual(session);
  expect(invoke).toHaveBeenLastCalledWith("read_source_maintenance_hook_session", { request: fixture.session });
  const observation = hookObservation(); invoke.mockResolvedValueOnce(observation); expect(await commands.read(read, observation.view!.activation)).toEqual(observation);
  expect(invoke).toHaveBeenLastCalledWith("read_source_maintenance_hook", { request: read });
  const stop: SourceMaintenanceHookStopRequest = { ...fixture.session, stop: { projectId: read.projectId, sourceActionId: read.sourceActionId, actionId: id(8830), activation: observation.view!.activation } };
  const notKnown = { request: stop.stop, result: { kind: "not-known" }, callbacksDrained: true };
  invoke.mockResolvedValueOnce(notKnown); expect((await commands.stop(stop)).result.kind).toBe("not-known");
  const stopped = { request: stop.stop, result: { kind: "stopped", receipt: { request: stop.stop, admissionClosed: true } }, callbacksDrained: false };
  invoke.mockResolvedValueOnce(stopped); expect(await commands.stop(stop)).toEqual(stopped);
  expect(invoke).toHaveBeenLastCalledWith("stop_source_maintenance_hook", { request: stop });
});
it("accepts identical causes and declarations regardless of object key order", async () => {
  const value = hookObservation(), cause = value.view!.outcome!.cause;
  value.view!.outcome!.cause = { contentRevision: cause.contentRevision, sourceSnapshotId: cause.sourceSnapshotId, resultDigest: cause.resultDigest,
    resultId: cause.resultId, attemptId: cause.attemptId, sourceActionId: cause.sourceActionId, projectId: cause.projectId };
  invoke.mockResolvedValueOnce(value); expect(await commands.read(read, value.view!.activation)).toEqual(value);
  const request: SourceAdoptRequest = { ...fixture.prepare, confirmation: { ...fixture.prepare.confirmation, maintenanceHook: hookActivation() } };
  const action = sourceActionFixture(request); action.parameters = Object.fromEntries(Object.entries(action.parameters as Record<string, unknown>).reverse());
  invoke.mockResolvedValueOnce(action); expect(() => confirmSourceAction(request, action.unitId, action)).not.toThrow();
  await expect(sourceCommands.prepare(request)).resolves.toEqual(action);
  const changed = sourceActionFixture(request); (changed.parameters as Record<string, unknown>).maintenanceHook = { ...request.confirmation.maintenanceHook!, expiresAtMs: request.confirmation.maintenanceHook!.expiresAtMs + 1 };
  expect(() => confirmSourceAction(request, changed.unitId, changed)).toThrow();
});
it.each(["action", "cause", "activation", "assessment", "protection", "state", "missing-error"] as const)("rejects an invalid %s observation without accepting a replacement scope", async kind => {
  const value = hookObservation(), activation = structuredClone(value.view!.activation);
  if (kind === "action") value.sourceActionId = id(8840);
  if (kind === "cause") value.view!.outcome!.cause.resultId = id(8840);
  if (kind === "activation") value.view!.activation.locale = "fr";
  if (kind === "assessment") value.view!.outcome!.assessment!.sourceSnapshotId = id(8840);
  if (kind === "protection") value.view!.outcome!.assessment!.rows[0].protection.locale = "fr";
  if (kind === "state") value.state = "action-not-known";
  if (kind === "missing-error") delete (value as Partial<SourceMaintenanceHookObservation>).error;
  invoke.mockResolvedValueOnce(value); await expect(commands.read(read, activation)).rejects.toBeDefined();
});
it("retains null as an explicitly classified unknown or disabled action, never a stop receipt", async () => {
  for (const state of ["action-not-known", "not-enabled"] as const) {
    invoke.mockResolvedValueOnce({ sourceActionId: read.sourceActionId, state, view: null, callbacksDrained: true, error: null });
    expect((await commands.read(read)).state).toBe(state);
  }
  const activation = hookActivation(), stop: SourceMaintenanceHookStopRequest = { ...fixture.session, stop: { projectId: read.projectId, sourceActionId: read.sourceActionId, actionId: id(8830), activation } };
  invoke.mockResolvedValueOnce({ request: { ...stop.stop, actionId: id(8831) }, result: { kind: "not-known" }, callbacksDrained: true });
  let failure: unknown; try { await commands.stop(stop); } catch (error) { failure = error; }
  expect(hasUnknownOutcome(failure)).toBe(true);
});
