import { validateRequestResourceRead, validateRequestResourceWrite, validateRequestResourceResolve, validateRequestResourceClear, validateResponseResourceRead } from "../generated/draft.validators";
import { resourceDraftCommands, type ResourceDraftHead } from "../resourceDraftCommands";
import { jsonIdentity } from "../pluginToolChoices";
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";

/** A bounded synthetic application journal. It never performs a business action. */
export function resourceDraftFixture(next: (command: string, payload: Parameters<typeof invoke>[1]) => unknown) {
  const heads = new Map<string, ResourceDraftHead>();
  const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
  function head(projectId: string): ResourceDraftHead { return heads.get(projectId) ?? { key: { projectId }, revision: "0", writerId: null, value: null }; }
  function response(value: unknown): ResourceDraftHead {
    if (!validateResponseResourceRead(value)) throw new Error("Invalid synthetic resource head");
    return structuredClone(value);
  }
  return async (command: string, payload: Parameters<typeof invoke>[1]): Promise<unknown> => {
    if (!command.endsWith("_local_resource_draft")) return next(command, payload);
    if (typeof payload !== "object" || payload === null || !("request" in payload)) throw new Error("Expected resource journal request");
    const request = payload.request;
    if (command === "read_local_resource_draft") {
      if (!validateRequestResourceRead(request)) throw new Error("Invalid synthetic resource read");
      return structuredClone(head(request.key.projectId));
    }
    if (command === "clear_local_resource_draft") {
      if (!validateRequestResourceClear(request)) throw new Error("Invalid synthetic resource clear");
      const before = head(request.clear.key.projectId);
      if (before.revision !== request.clear.expectedRevision || before.value?.pending || before.value?.factPending) throw { code: "dependency-conflict", outcome: "rejected", reason: "drafts-current" };
      const result: ResourceDraftHead = { key: before.key, revision: (BigInt(before.revision) + 1n).toString(), writerId: null, value: null };
      heads.set(result.key.projectId, result); return structuredClone(result);
    }
    if (command === "write_local_resource_draft") {
      if (!validateRequestResourceWrite(request)) throw new Error("Invalid synthetic resource write");
      const write = request.write, before = head(write.key.projectId);
      if (before.revision !== write.expectedRevision) throw { code: "dependency-conflict", outcome: "rejected", reason: "drafts-current" };
      if (before.value?.pending && !same(before.value.pending, write.value.pending) || before.value?.factPending && !same(before.value.factPending, write.value.factPending)) throw new Error("An ordinary write cannot remove an original request");
      const result = response({ key: write.key, revision: (BigInt(before.revision) + 1n).toString(), writerId: write.writerId, value: write.value });
      heads.set(result.key.projectId, result); return structuredClone(result);
    }
    if (command === "resolve_local_resource_draft") {
      if (!validateRequestResourceResolve(request)) throw new Error("Invalid synthetic resource resolve");
      const { write, target } = request.resolve, before = head(write.key.projectId);
      const pending = target.kind === "primary" ? before.value?.pending : before.value?.factPending;
      if (before.revision !== write.expectedRevision || !same(pending, target.pending)) throw { code: "dependency-conflict", outcome: "rejected", reason: "drafts-current" };
      const result = response({ key: write.key, revision: (BigInt(before.revision) + 1n).toString(), writerId: write.writerId, value: write.value });
      heads.set(result.key.projectId, result); return structuredClone(result);
    }
    throw new Error(`Unexpected resource journal command: ${command}`);
  };
}

const installed = new WeakSet<object>();
/** Attach once to an existing synthetic IPC harness, keeping its domain behavior. */
export function installResourceDraftFixture() {
  const mock = vi.mocked(invoke), next = mock.getMockImplementation();
  if (!next) throw new Error("Resource journal fixtures require an existing synthetic IPC harness");
  if (installed.has(next)) return;
  const wrapped = resourceDraftFixture((command, payload) => next(command, payload));
  installed.add(wrapped); mock.mockImplementation(wrapped);
}

/** UI assembly tests which already replace typed ports can use the same journal. */
export function createResourceDraftPortsFixture(): typeof resourceDraftCommands {
  const handler = resourceDraftFixture(command => { throw new Error(`Unexpected synthetic resource command: ${command}`); });
  async function read(command: string, request: unknown) {
    const value = await handler(command, { request });
    if (!validateResponseResourceRead(value)) throw new Error("Expected a complete synthetic resource head");
    return value;
  }
  return { read: request => read("read_local_resource_draft", request), write: request => read("write_local_resource_draft", request),
    resolve: request => read("resolve_local_resource_draft", request), clear: request => read("clear_local_resource_draft", request) };
}
export function installResourceDraftPortsFixture() {
  const ports = createResourceDraftPortsFixture();
  vi.spyOn(resourceDraftCommands, "read").mockImplementation(ports.read);
  vi.spyOn(resourceDraftCommands, "write").mockImplementation(ports.write);
  vi.spyOn(resourceDraftCommands, "resolve").mockImplementation(ports.resolve);
  vi.spyOn(resourceDraftCommands, "clear").mockImplementation(ports.clear);
}
