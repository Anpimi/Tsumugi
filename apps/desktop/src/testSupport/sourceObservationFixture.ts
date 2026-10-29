import type { Requests } from "../generated/draft.requests";
import { expect, type Mock } from "vitest";
import { validateRequestSourceObserve } from "../generated/draft.validators";
import type { SourceAdoptRequest, StartRequest } from "../sourceCommands";

export function expectedSourceAdoptionObservation(request: SourceAdoptRequest, unitId: string) {
  const { sessionToken, ...original } = request, confirmation = request.confirmation;
  return { sessionToken, key: { projectId: request.projectId }, target: { kind: "primary", pending: { kind: "adopt", unitId,
    request: { ...original, confirmation: { ...confirmation, actor: confirmation.actor ?? null, lineage: confirmation.lineage ?? [],
      lineageBaseSnapshot: confirmation.lineageBaseSnapshot ?? null, expectedCurrentSnapshot: confirmation.expectedCurrentSnapshot ?? null, maintenanceHook: confirmation.maintenanceHook ?? null } },
    submittedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/), submittedMappingSeq: expect.stringMatching(/^(0|[1-9]\d*)$/) } } };
}
export function expectedSourceStartObservation(request: StartRequest, checker = false) {
  const { sessionToken, ...original } = request;
  return { sessionToken, key: { projectId: request.projectId }, target: { kind: "primary", pending: { kind: checker ? "start-check" : "start", request: original,
    submittedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/), submittedMappingSeq: expect.stringMatching(/^(0|[1-9]\d*)$/) } } };
}

type FixtureHandler = (...args: Parameters<Mock>) => unknown;
/** Records the real RPC once; the supplied handler only constructs its proof. */
export function withSourceObservations(handler: FixtureHandler) {
  return async (command: string, payload: unknown) => {
    if (command !== "observe_local_source_action") return handler(command, payload);
    if (typeof payload !== "object" || payload === null || !("request" in payload) || !validateRequestSourceObserve(payload.request)) {
      throw new Error("Expected the complete original Source observation target");
    }
    return sourceObservationFixture(payload.request, async (command, payload) => handler(command, payload));
  };
}

/** Adapts explicit original-read fixtures to the unified pure observation response. */
export async function sourceObservationFixture(request: Requests["sourceObserve"], read: (command: string, payload: { request: unknown }) => Promise<unknown>) {
  const target = request.target;
  if (target.kind === "hook-stop") return { target, observation: { kind: "pending" } };
  const pending = target.pending, original = pending.request;
  if (pending.kind === "adopt") {
    const value = await read("read_source_adoption_action", { request: { adoption: { ...pending.request, sessionToken: request.sessionToken }, unitId: pending.unitId } });
    if (value === null) return { target, observation: { kind: "pending" } };
    if (typeof value !== "object" || value === null || !("receipt" in value)) return value;
    return { target, observation: { kind: value.receipt === null ? "adoption-prepared" : "adopted", value } };
  }
  if (pending.kind === "start" || pending.kind === "start-check") {
    const value = await read("read_plugin_execution_start", { request: { sessionToken: request.sessionToken, projectId: original.projectId,
      attemptId: pending.request.attemptId, inputDigest: pending.request.inputDigest, operation: pending.kind === "start" ? "source-import" : "source-semantic-check" } });
    return value === null ? { target, observation: { kind: "pending" } } : { target, observation: { kind: "started", view: value } };
  }
  // Preparation and finish evidence must be supplied explicitly by the fixture;
  // never call the corresponding mutation to manufacture a read result.
  return read("observe_local_source_action", { request });
}
