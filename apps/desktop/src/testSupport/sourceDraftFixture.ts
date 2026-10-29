import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { validateRequestSourceRead, validateRequestSourceWrite, validateRequestSourceResolve, validateRequestSourceClear, validateResponseSourceRead } from "../generated/draft.validators";
import { canonicalSourceDraft, sourceDraftCommands, type SourceDraftHead } from "../sourceDraftCommands";
import { jsonIdentity } from "../pluginToolChoices";
import { inheritResourceDraftFixture, installResourceDraftFixture } from "./resourceDraftFixture";

/** Only the local journal protocol; source actions and observations stay in the calling fixture. */
export function sourceDraftFixture(next: (command: string, payload: Parameters<typeof invoke>[1]) => unknown) {
  const heads = new Map<string, SourceDraftHead>();
  const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
  const head = (projectId: string): SourceDraftHead => heads.get(projectId) ?? { key: { projectId }, revision: "0", writerId: null, value: null };
  function response(value: unknown): SourceDraftHead {
    if (!validateResponseSourceRead(value)) throw new Error("Invalid synthetic source draft head");
    return structuredClone(value);
  }
  return async (command: string, payload: Parameters<typeof invoke>[1]): Promise<unknown> => {
    if (!["read_local_source_draft", "write_local_source_draft", "resolve_local_source_draft", "clear_local_source_draft"].includes(command)) return next(command, payload);
    if (typeof payload !== "object" || payload === null || !("request" in payload)) throw new Error("Expected a source journal request");
    const request = payload.request;
    if (command === "read_local_source_draft") {
      if (!validateRequestSourceRead(request)) throw new Error("Invalid synthetic source draft read");
      return response(head(request.key.projectId));
    }
    if (command === "clear_local_source_draft") {
      if (!validateRequestSourceClear(request)) throw new Error("Invalid synthetic source draft clear");
      const before = head(request.clear.key.projectId);
      if (before.revision !== request.clear.expectedRevision || before.value?.pending || before.value?.hookStop) throw { code: "dependency-conflict", outcome: "rejected", reason: "drafts-current" };
      const result: SourceDraftHead = { key: before.key, revision: String(BigInt(before.revision) + 1n), writerId: null, value: null };
      heads.set(result.key.projectId, result); return response(result);
    }
    if (command === "write_local_source_draft") {
      if (!validateRequestSourceWrite(request)) throw new Error("Invalid synthetic source draft write");
      const write = request.write, before = head(write.key.projectId), value = canonicalSourceDraft(write.value);
      if (before.revision !== write.expectedRevision) throw { code: "dependency-conflict", outcome: "rejected", reason: "drafts-current" };
      if (before.value?.pending && !same(before.value.pending, value.pending) || before.value?.hookStop && !same(before.value.hookStop, value.hookStop)) throw new Error("An ordinary write cannot remove an original source request");
      const result = response({ key: write.key, revision: String(BigInt(before.revision) + 1n), writerId: write.writerId, value });
      heads.set(result.key.projectId, result); return result;
    }
    if (!validateRequestSourceResolve(request)) throw new Error("Invalid synthetic source draft resolution");
    const { write, target } = request.resolve, before = head(write.key.projectId);
    const actual = target.kind === "primary" ? before.value?.pending : before.value?.hookStop;
    if (before.revision !== write.expectedRevision || !same(actual, target.pending)) throw { code: "dependency-conflict", outcome: "rejected", reason: "drafts-current" };
    const value = canonicalSourceDraft(write.value);
    if (target.kind === "primary" ? value.pending !== null : value.hookStop !== null) throw new Error("The exact source request must be resolved");
    const result = response({ key: write.key, revision: String(BigInt(before.revision) + 1n), writerId: write.writerId, value });
    heads.set(result.key.projectId, result); return result;
  };
}
const installed = new WeakSet<object>();
export function installSourceDraftFixture() {
  installResourceDraftFixture();
  const mock = vi.mocked(invoke), next = mock.getMockImplementation();
  if (!next) throw new Error("Source journal fixtures require a synthetic IPC harness");
  if (installed.has(next)) return;
  const wrapped = sourceDraftFixture((command, payload) => next(command, payload));
  installed.add(wrapped); inheritResourceDraftFixture(wrapped); mock.mockImplementation(wrapped);
}
export function installSourceDraftPortsFixture() {
  const handle = sourceDraftFixture(command => { throw new Error(`Unexpected synthetic source command: ${command}`); });
  async function read(command: string, request: unknown) {
    const value = await handle(command, { request });
    if (!validateResponseSourceRead(value)) throw new Error("Expected a complete source draft head");
    return value;
  }
  vi.spyOn(sourceDraftCommands, "read").mockImplementation(request => read("read_local_source_draft", request));
  vi.spyOn(sourceDraftCommands, "write").mockImplementation(request => read("write_local_source_draft", request));
  vi.spyOn(sourceDraftCommands, "resolve").mockImplementation(request => read("resolve_local_source_draft", request));
  vi.spyOn(sourceDraftCommands, "clear").mockImplementation(request => read("clear_local_source_draft", request));
}
