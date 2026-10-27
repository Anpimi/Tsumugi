import { beforeEach, expect, it, vi } from "vitest";
import rawFixture from "../test/fixtures/draftCommands.contract.json";
import { draftCommands } from "./draftCommands";
import * as validators from "./generated/draft.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

const read: unknown = rawFixture.requests.read, write: unknown = rawFixture.requests.write;
const clear: unknown = rawFixture.requests.clear, list: unknown = rawFixture.requests.list;
if (!validators.validateRequestRead(read) || !validators.validateRequestWrite(write)
  || !validators.validateRequestClear(clear) || !validators.validateRequestList(list)) throw new Error("Invalid shared draft requests");
const fixture = { requests: { read, write, clear, list }, responses: rawFixture.responses };

it("reads retained B and original pending A without submitting a business action", async () => {
  const request = fixture.requests.read;
  invoke.mockResolvedValueOnce(fixture.responses.read);
  const result = await draftCommands.read(request);
  expect(result.head.value?.text).toContain("草稿 B");
  expect(result.head.value?.pending?.kind).toBe("save");
  expect(invoke.mock.calls).toEqual([["read_local_draft", { request }]]);
});

it("round trips durable input and CAS cleanup through the shared Rust fixture", async () => {
  invoke.mockResolvedValueOnce(fixture.responses.written).mockResolvedValueOnce(fixture.responses.cleared);
  expect(await draftCommands.write(fixture.requests.write)).toEqual(fixture.responses.written);
  expect(await draftCommands.clear(fixture.requests.clear)).toEqual(fixture.responses.cleared);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["write_local_draft", "clear_local_draft"]);
});

it.each(["projectId", "unitId", "locale"] as const)("refuses a retained record from another %s", async field => {
  const value = structuredClone(fixture.responses.read);
  value.head.key[field] = field === "locale" ? "fr-FR" : fixture.responses.written.writerId;
  invoke.mockResolvedValueOnce(value);
  await expect(draftCommands.read(fixture.requests.read)).rejects.toThrow();
});

it.each([
  { kind: "unavailable", reason: "source-missing" },
  { kind: "unavailable", reason: "locale-removed" },
] as const)("preserves input when current project basis is unavailable (%s)", async current => {
  const value = { ...fixture.responses.read, current };
  invoke.mockResolvedValueOnce(value);
  expect(await draftCommands.read(fixture.requests.read)).toEqual(value);
});

it("keeps empty selected text different from no current translation", async () => {
  const value = structuredClone(fixture.responses.read);
  const basis = { ...value.current.basis, selectionId: fixture.responses.written.writerId,
    revisionId: fixture.requests.read.key.unitId, text: "" };
  invoke.mockResolvedValueOnce({ ...value, current: { ...value.current, kind: "current", basis } });
  expect((await draftCommands.read(fixture.requests.read)).current).toEqual({ ...value.current, kind: "current", basis });
  invoke.mockResolvedValueOnce({ ...value, current: { ...value.current, kind: "current", basis: { ...basis, revisionId: null } } });
  await expect(draftCommands.read(fixture.requests.read)).rejects.toThrow();
});

it("does not count an acknowledgement for older input or another writer as durable B", async () => {
  const value = structuredClone(fixture.responses.written);
  value.value.text = "Earlier A";
  invoke.mockResolvedValueOnce(value);
  await expect(draftCommands.write(fixture.requests.write)).rejects.toThrow();
  invoke.mockResolvedValueOnce({ ...fixture.responses.written, writerId: fixture.requests.read.key.unitId });
  await expect(draftCommands.write(fixture.requests.write)).rejects.toThrow();
  invoke.mockResolvedValueOnce({ ...fixture.responses.written, revision: "1" });
  await expect(draftCommands.write(fixture.requests.write)).rejects.toThrow();
});

it("refuses forged authority, imprecise sequences and unrelated pending basis", async () => {
  const value = structuredClone(fixture.responses.read);
  const invalid = [
    { ...value, head: { ...value.head, revision: 9007199254740993 } },
    { ...value, head: { ...value.head, value: { ...value.head.value, pending: {
      ...value.head.value.pending, request: { ...value.head.value.pending.request, sessionToken: "forged" },
    } } } },
    { ...value, head: { ...value.head, value: { ...value.head.value, pending: {
      ...value.head.value.pending, submittedSeq: "9007199254740994",
    } } } },
    { ...value, head: { ...value.head, value: { ...value.head.value, pending: {
      ...value.head.value.pending, request: { ...value.head.value.pending.request, expectedSelectionId: value.head.key.unitId },
    } } } },
  ];
  for (const response of invalid) {
    invoke.mockResolvedValueOnce(response);
    await expect(draftCommands.read(fixture.requests.read)).rejects.toThrow();
  }
});

it("advances through tombstone-only pages and never repeats the scan cursor", async () => {
  const request = fixture.requests.list;
  const next = fixture.requests.read.key;
  const emptyPage = { items: [], next };
  invoke.mockResolvedValueOnce(emptyPage);
  expect(await draftCommands.list(request)).toEqual(emptyPage);
  invoke.mockResolvedValueOnce(emptyPage);
  await expect(draftCommands.list({ ...request, after: next })).rejects.toThrow();
  invoke.mockResolvedValueOnce({ items: [], next: null });
  expect(await draftCommands.list({ ...request, after: next })).toEqual({ items: [], next: null });
});

it("rejects reordered or foreign summaries without treating them as no pending work", async () => {
  const item = fixture.responses.page.items[0];
  for (const items of [[item, item], [{ ...item, key: { ...item.key, projectId: fixture.responses.written.writerId } }]]) {
    invoke.mockResolvedValueOnce({ items, next: null });
    await expect(draftCommands.list(fixture.requests.list)).rejects.toThrow();
  }
  invoke.mockResolvedValueOnce(fixture.responses.page);
  expect(await draftCommands.list(fixture.requests.list)).toEqual(fixture.responses.page);
});

it("keeps a failed journal write as a failure and sends no business request", async () => {
  const failure = { code: "storage-failed", stage: "draft-storage", outcome: "rejected" };
  invoke.mockRejectedValueOnce(failure);
  await expect(draftCommands.write(fixture.requests.write)).rejects.toBe(failure);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["write_local_draft"]);
  expect(validators.validateRequestWrite(fixture.requests.write)).toBe(true);
});

it("matches Serde's omitted nullable input fields to the explicit null acknowledgement", async () => {
  const sourceRevisionId = fixture.responses.written.value.basis.sourceRevisionId;
  const request: unknown = { ...fixture.requests.write, write: { ...fixture.requests.write.write,
    value: { basis: { sourceRevisionId }, editSeq: "1", text: "" } } };
  if (!validators.validateRequestWrite(request)) throw new Error("Invalid omitted-field request");
  const response = { ...fixture.responses.written, value: { basis: { sourceRevisionId,
    selectionId: null, revisionId: null, text: null }, editSeq: "1", text: "", pending: null } };
  invoke.mockResolvedValueOnce(response);
  expect(await draftCommands.write(request)).toEqual(response);
});
