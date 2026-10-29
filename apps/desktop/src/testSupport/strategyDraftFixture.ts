import { vi, expect } from "vitest";
import type { CommandError } from "../projectCommands";
import { strategyDraftCommands, strategyPendingActionId, type StrategyDraftHead } from "../strategyDraftCommands";
import type { Requests } from "../generated/draft.requests";
import { validateResponseStrategyAction, validateResponseStrategyWritten } from "../generated/draft.validators";

export function strategyDraftHeadFixture(value: unknown): StrategyDraftHead {
  if (!validateResponseStrategyWritten(value)) throw new Error("Invalid strategy draft head fixture");
  return value;
}
export function strategyDraftActionFixture(value: unknown) {
  if (!validateResponseStrategyAction(value)) throw new Error("Invalid strategy draft action fixture");
  return value;
}

/** One isolated shared-journal CAS fake; it never dispatches a strategy action. */
export function installStrategyDraftFixture() {
  const heads = new Map<string, StrategyDraftHead>();
  type Proof = { disposition: "recorded" | "prepared" | "confirmed-not-applied" | "rejected"; rejection?: CommandError };
  const proven = new Map<string, Proof>();
  let nextProof: Proof | null = null;
  const key = (projectId: string) => heads.get(projectId) ?? { key: { projectId }, revision: "0", writerId: null, value: null };
  const commit = (write: Parameters<typeof strategyDraftCommands.write>[0]["write"]) => {
    const before = key(write.key.projectId);
    expect(write.expectedRevision).toBe(before.revision);
    const head = strategyDraftHeadFixture({ key: write.key, revision: String(BigInt(before.revision) + 1n), writerId: write.writerId, value: structuredClone(write.value) });
    heads.set(write.key.projectId, head); return structuredClone(head);
  };
  vi.spyOn(strategyDraftCommands, "read").mockImplementation(async request => structuredClone(key(request.key.projectId)));
  vi.spyOn(strategyDraftCommands, "write").mockImplementation(async request => {
    const pending = key(request.write.key.projectId).value?.pending;
    if (pending) expect(request.write.value.pending).toEqual(pending);
    return commit(request.write);
  });
  vi.spyOn(strategyDraftCommands, "resolve").mockImplementation(async request => {
    expect(request.resolve.pending).toEqual(key(request.resolve.write.key.projectId).value?.pending);
    expect(request.resolve.write.value.pending).toBeNull(); return commit(request.resolve.write);
  });
  const observe = async (request: Requests["strategyAction"]) => {
    const response = strategyDraftActionFixture({ pending: structuredClone(request.pending), disposition: null });
    const id = strategyPendingActionId(response.pending), proof = proven.get(id) ?? nextProof;
    if (nextProof) { proven.set(id, nextProof); nextProof = null; }
    return strategyDraftActionFixture({ pending: response.pending, ...(proof ?? { disposition: null }) });
  };
  vi.spyOn(strategyDraftCommands, "action").mockImplementation(observe);
  vi.spyOn(strategyDraftCommands, "close").mockImplementation(observe);
  return { heads,
    prove(actionId: string, disposition: "recorded" | "prepared" | "confirmed-not-applied") { proven.set(actionId, { disposition }); },
    rejectNext(rejection: CommandError) { nextProof = { disposition: "rejected", rejection }; },
    proveNext(disposition: "recorded" | "prepared" | "confirmed-not-applied") { nextProof = { disposition }; },
  };
}
