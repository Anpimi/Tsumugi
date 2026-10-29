import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/resourceDraftCommands.contract.json";
import { resourceDraftCommands } from "./resourceDraftCommands";
import { resourceCommands } from "./resourceCommands";
import { validateRequestResourceWrite, validateRequestResourceResolve } from "./generated/draft.validators";
import { validateRequestObserveTermAction, validateRequestObserveContextAction, validateRequestObserveContextCaptureAction,
  validateRequestObserveCorrectionAction, validateRequestObserveDecisionAction } from "./generated/resource.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });
const copy = <T>(value: T): T => structuredClone(value);
function wire<T>(value: unknown, validate: (input: unknown) => input is T): T {
  const result = copy(value);
  if (!validate(result)) throw new Error("A valid synthetic wire request is required");
  return result;
}
function writeRequest() {
  const value: unknown = copy(fixture.requests.write);
  if (!validateRequestResourceWrite(value)) throw new Error("A valid synthetic resource write is required");
  return value;
}
function resolveRequest() {
  const value: unknown = copy(fixture.requests.resolve);
  if (!validateRequestResourceResolve(value)) throw new Error("A valid synthetic resource resolution is required");
  return value;
}

it("reads newer Unicode input with the original pending action and no stored session token", async () => {
  invoke.mockResolvedValue(copy(fixture.responses.read));
  const head = await resourceDraftCommands.read(fixture.requests.read);
  expect(head.value?.termDraft.target).toBe("Newer B 👩🏽‍💻\r\né");
  expect(head.value?.pending).toMatchObject({ kind: "term", request: { target: "木桶 👩🏽‍💻 é" }, submittedSeq: "1" });
  expect(JSON.stringify(head.value)).not.toContain("sessionToken");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("read_local_resource_draft", { request: fixture.requests.read });
});

it("keeps the exact pending A and newer B in a write acknowledgement", async () => {
  invoke.mockResolvedValue(copy(fixture.responses.written));
  const head = await resourceDraftCommands.write(writeRequest());
  expect(head.value).toEqual(fixture.responses.written.value);
  expect(invoke.mock.calls[0][0]).toBe("write_local_resource_draft");
});

it("checks the exact resolution value and never resubmits the business request", async () => {
  invoke.mockResolvedValue(copy(fixture.responses.resolved));
  const head = await resourceDraftCommands.resolve(resolveRequest());
  expect(head.value?.pending).toBeNull();
  expect(head.value?.termDraft.target).toBe(fixture.responses.written.value.termDraft.target);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("resolve_local_resource_draft", { request: fixture.requests.resolve });
});

it("accepts the expected resource tombstone", async () => {
  invoke.mockResolvedValue(copy(fixture.responses.cleared));
  expect((await resourceDraftCommands.clear(fixture.requests.clear)).value).toBeNull();
});

it.each(["project", "writer", "old-input", "original-request", "submitted-sequence", "missing-pending", "unsafe-sequence"] as const)(
  "rejects a write acknowledgement with mismatched %s", async change => {
    const head = copy(fixture.responses.written);
    if (change === "project") head.key.projectId = "30000000-0000-4000-8000-000000000099";
    if (change === "writer") head.writerId = "30000000-0000-4000-8000-000000000099";
    if (change === "old-input") head.value.termDraft.target = head.value.pending.request.target;
    if (change === "original-request") head.value.pending.request.reason = "A different request";
    if (change === "submitted-sequence") head.value.pending.submittedSeq = "11";
    if (change === "missing-pending") Reflect.set(head.value, "pending", null);
    if (change === "unsafe-sequence") head.value.editSeq = "9007199254740992";
    invoke.mockResolvedValue(head);
    await expect(resourceDraftCommands.write(writeRequest())).rejects.toThrow();
  });

it("rejects a retained pending slot presented as a completed journal resolution", async () => {
  const head = copy(fixture.responses.resolved); Reflect.set(head.value, "pending", copy(fixture.responses.written.value.pending));
  invoke.mockResolvedValue(head);
  await expect(resourceDraftCommands.resolve(resolveRequest())).rejects.toThrow();
});

it("does not mistake a nonempty resource head for a clear acknowledgement", async () => {
  invoke.mockResolvedValue(copy(fixture.responses.written));
  await expect(resourceDraftCommands.clear(fixture.requests.clear)).rejects.toThrow();
});

it("pins the snapshot before a caller continues editing", async () => {
  let release!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const request = writeRequest(), pending = resourceDraftCommands.write(request);
  request.write.value.termDraft.target = "Later C";
  release(copy(fixture.responses.written));
  expect((await pending).value?.termDraft.target).toBe(fixture.responses.written.value.termDraft.target);
  expect(invoke.mock.calls[0][1].request.write.value.termDraft.target).toBe(fixture.responses.written.value.termDraft.target);
});

it("allows user text that mentions a protocol field without treating it as stored authority", async () => {
  const request = writeRequest(); request.write.value.termDraft.reason = "The text contains sessionToken as a code example.";
  const head = copy(fixture.responses.written); head.value.termDraft.reason = request.write.value.termDraft.reason;
  invoke.mockResolvedValue(head);
  expect((await resourceDraftCommands.write(request)).value?.termDraft.reason).toBe(request.write.value.termDraft.reason);
});

it("bounds serialized resource heads by UTF-8 bytes", async () => {
  const head = copy(fixture.responses.read); head.value.contextDraft = "界".repeat(2 * 1024 * 1024);
  invoke.mockResolvedValue(head);
  await expect(resourceDraftCommands.read(fixture.requests.read)).rejects.toThrow();
});

it.each(["term", "context", "capture", "correction", "decision"] as const)("observes %s using its complete original request", async kind => {
  const value = fixture.observations[kind]; invoke.mockResolvedValue(copy(value.response));
  const observers = {
    term: () => resourceCommands.observeTermAction(wire(fixture.observations.term.request, validateRequestObserveTermAction)),
    context: () => resourceCommands.observeContextAction(wire(fixture.observations.context.request, validateRequestObserveContextAction)),
    capture: () => resourceCommands.observeContextCaptureAction(wire(fixture.observations.capture.request, validateRequestObserveContextCaptureAction)),
    correction: () => resourceCommands.observeCorrectionAction(wire(fixture.observations.correction.request, validateRequestObserveCorrectionAction)),
    decision: () => resourceCommands.observeDecisionAction(wire(fixture.observations.decision.request, validateRequestObserveDecisionAction)),
  };
  const result = await observers[kind]();
  expect(result).toEqual(value.response);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][0]).toMatch(/^observe_/);
});

it("does not accept a different original request in a pure observation", async () => {
  const value = copy(fixture.observations.term.response); value.request.reason = "Different original";
  invoke.mockResolvedValue(value);
  await expect(resourceCommands.observeTermAction(fixture.observations.term.request)).rejects.toThrow();
});
