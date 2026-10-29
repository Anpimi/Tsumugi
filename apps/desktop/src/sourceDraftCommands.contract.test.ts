import { beforeEach, expect, it, vi } from "vitest";
import { sourceDraftCommands, canonicalSourceDraft, type SourceDraftValue, type SourceDraftPending } from "./sourceDraftCommands";
import { sourceCommands, validateResponseNativeDropEvent, confirmSourceAction, confirmSourceReceipt } from "./sourceCommands";
import { pluginSourceRequest, pluginSourceWorkflow } from "./testSupport/pluginSourceFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { sourceActionFixture, sourceReceiptFixture } from "./testSupport/sourceFixture";
import source from "../test/fixtures/sourceCommands.contract.json";
import * as validators from "./generated/draft.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
const projectId = source.session.projectId, sessionToken = "current-session", key = { projectId }, writerId = id(700);
const capture = { projectId, attemptId: id(701), selectionId: id(702), sourceLanguage: "en-US" };
function pending(): SourceDraftPending { return { kind: "capture", request: { ...capture }, submittedSeq: "1", submittedMappingSeq: "1" }; }
function value(): SourceDraftValue {
  return canonicalSourceDraft({ editSeq: "2", mappingSeq: "2", domain: "synthetic-domain", source: pluginSourceRequest,
    sourceLanguage: "en-US", declared: true, selectionLabel: "Synthetic source", updating: true,
    attemptId: null, checkAttemptId: null, captureRequest: capture, checkPrepareRequest: null,
    comparisonRef: null, lineage: [], actor: "Retained newer B 👩🏽‍💻 é", filter: "", appliedFilter: "",
    manualOrdinal: null, historicalQuery: "", previewAfter: 0, comparisonAfter: 0, historicalSearch: null,
    receiptRef: null, pickerUncertain: false, hook: { locale: "zh-CN", enabledIntent: true, sourceActionId: null },
    pending: pending(), hookStop: null });
}

it("retains an exact original request and newer human input without a session credential in the stored value", async () => {
  const write = { key, expectedRevision: "0", writerId, value: value() };
  const head = { key, revision: "1", writerId, value: value() };
  expect(validators.validateRequestSourceWrite({ sessionToken, write })).toBe(true);
  expect(validators.validateResponseSourceRead(head)).toBe(true);
  expect(JSON.stringify(write.value)).not.toContain("sessionToken");
  invoke.mockResolvedValueOnce(head);
  expect(await sourceDraftCommands.write({ sessionToken, write })).toEqual(head);
  expect(invoke).toHaveBeenLastCalledWith("write_local_source_draft", { request: { sessionToken, write } });
  const injected = structuredClone(write);
  Object.assign(injected.value.pending!.request, { sessionToken: "retired-session" });
  expect(validators.validateRequestSourceWrite({ sessionToken, write: injected })).toBe(false);
});

it.each(["other-project", "unsafe-sequence", "pending-project", "missing-writer"])("rejects a schema-valid but unrelated saved source head: %s", async mismatch => {
  const head = { key, revision: "1", writerId: writerId as string | null, value: value() };
  if (mismatch === "other-project") head.key = { projectId: id(703) };
  if (mismatch === "unsafe-sequence") head.value.editSeq = "9007199254740992";
  if (mismatch === "pending-project") head.value.pending!.request.projectId = id(703);
  if (mismatch === "missing-writer") head.writerId = null;
  invoke.mockResolvedValueOnce(head);
  await expect(sourceDraftCommands.read({ sessionToken, key })).rejects.toThrow("Invalid IPC response");
});

it("observes expired preparation without resolving, dispatching or renewing the original request", async () => {
  const target = { kind: "primary" as const, pending: pending() };
  const observed = { target, observation: { kind: "preparation-expired" as const } };
  invoke.mockResolvedValueOnce(observed);
  expect(await sourceDraftCommands.observe({ sessionToken, key, target })).toEqual(observed);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["observe_local_source_action"]);
  const wrong = structuredClone(observed);
  if (wrong.target.pending.kind === "capture") wrong.target.pending.request.selectionId = id(704);
  invoke.mockResolvedValueOnce(wrong);
  await expect(sourceDraftCommands.observe({ sessionToken, key, target })).rejects.toThrow("Invalid IPC response");
});

it("reads a completed preparation by its original reference without manufacturing a pending sequence", async () => {
  const reference = { kind: "capture" as const, request: capture };
  const observation = { kind: "capture" as const, view: { ...pluginSourceWorkflow.preflight,
    attemptId: capture.attemptId, sourceLanguage: capture.sourceLanguage } };
  invoke.mockResolvedValueOnce({ reference, observation });
  expect(await sourceDraftCommands.preparation({ sessionToken, key, reference })).toEqual({ reference, observation });
  expect(invoke).toHaveBeenLastCalledWith("read_local_source_preparation", { request: { sessionToken, key, reference } });
  invoke.mockResolvedValueOnce({ reference, observation: { ...observation, view: { ...observation.view, attemptId: id(704) } } });
  await expect(sourceDraftCommands.preparation({ sessionToken, key, reference })).rejects.toThrow("Invalid IPC response");
});

it("keeps a published negative checker proof distinct from missing or permanently closed publication", async () => {
  const target = { kind: "primary" as const, pending: { kind: "finish-check" as const,
    request: { projectId, attemptId: id(705), resultId: id(706) }, submittedSeq: "1", submittedMappingSeq: "1" } };
  invoke.mockResolvedValueOnce({ target, observation: { kind: "check-finished", valid: false } });
  expect((await sourceDraftCommands.observe({ sessionToken, key, target })).observation).toEqual({ kind: "check-finished", valid: false });
  invoke.mockResolvedValueOnce({ target, observation: { kind: "pending" } });
  expect((await sourceDraftCommands.observe({ sessionToken, key, target })).observation).toEqual({ kind: "pending" });
  invoke.mockResolvedValueOnce({ target, observation: { kind: "confirmed-not-applied" } });
  expect((await sourceDraftCommands.observe({ sessionToken, key, target })).observation).toEqual({ kind: "confirmed-not-applied" });
});

it("preserves bounded adoption evidence for the original owner's receipt-first association checks", async () => {
  const { sessionToken: _retired, ...request } = source.prepare;
  const action = sourceActionFixture(source.prepare), receipt = sourceReceiptFixture(source.prepare);
  const target = { kind: "primary" as const, pending: { kind: "adopt" as const, request,
    unitId: action.unitId, submittedSeq: "1", submittedMappingSeq: "1" } };
  invoke.mockResolvedValueOnce({ target, observation: { kind: "adoption-prepared", value: { action, receipt: null } } });
  expect((await sourceDraftCommands.observe({ sessionToken, key, target })).observation.kind).toBe("adoption-prepared");
  invoke.mockResolvedValueOnce({ target, observation: { kind: "adopted", value: { action, receipt } } });
  expect((await sourceDraftCommands.observe({ sessionToken, key, target })).observation.kind).toBe("adopted");
  const wrongAction = { ...action, operation: "unrelated-operation" };
  invoke.mockResolvedValueOnce({ target, observation: { kind: "adopted", value: { action: wrongAction, receipt } } });
  const conflicting = (await sourceDraftCommands.observe({ sessionToken, key, target })).observation;
  if (conflicting.kind !== "adopted" || conflicting.value.receipt === null) throw new Error("Expected the original adoption evidence");
  expect(confirmSourceReceipt({ ...request, sessionToken }, action.unitId, conflicting.value.receipt)).toBeTruthy();
  expect(() => confirmSourceAction({ ...request, sessionToken }, action.unitId, conflicting.value.action)).toThrow();
  invoke.mockResolvedValueOnce({ target, observation: { kind: "adopted", value: { action, receipt: { ...receipt, actionId: id(707) } } } });
  const wrongReceipt = (await sourceDraftCommands.observe({ sessionToken, key, target })).observation;
  if (wrongReceipt.kind !== "adopted" || wrongReceipt.value.receipt === null) throw new Error("Expected the original adoption evidence");
  expect(() => confirmSourceReceipt({ ...request, sessionToken }, action.unitId, wrongReceipt.value.receipt!)).toThrow();
});

it("uses an opaque native ticket and rejects a selection for another declared source", async () => {
  const request = { sessionToken, projectId, dropTicket: id(708), source: pluginSourceRequest };
  expect(validateResponseNativeDropEvent({ kind: "ready", sessionToken, projectId, dropTicket: request.dropTicket, folderName: "Synthetic" })).toBe(true);
  expect(validateResponseNativeDropEvent({ kind: "ready", sessionToken, projectId, dropTicket: request.dropTicket, folderName: "Synthetic", paths: ["/untrusted/path"] })).toBe(false);
  invoke.mockResolvedValueOnce(pluginSourceWorkflow.selection);
  expect(await sourceCommands.selectDropped(request)).toEqual(pluginSourceWorkflow.selection);
  expect(invoke).toHaveBeenLastCalledWith("select_dropped_plugin_source", { request });
  invoke.mockResolvedValueOnce({ ...pluginSourceWorkflow.selection, source: { ...pluginSourceWorkflow.selection.source, environmentDigest: "a".repeat(64) } });
  await expect(sourceCommands.selectDropped(request)).rejects.toThrow("Invalid IPC response");
});
