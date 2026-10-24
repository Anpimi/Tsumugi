import { validateRequestAdoptionAction, validateResponseAdoptionAction } from "./generated/source.validators";
import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sourceFixture from "../test/fixtures/sourceCommands.contract.json";
import { useSourceDraftSession } from "./SourceDraftSession";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useSessionReads } from "./SessionReadProvider";
import { executionCommands, type AdoptionAction, type Receipt } from "./executionCommands";
import { sourceCommands, type ContentScope, type SourceAdoptRequest, type SourceChangePage } from "./sourceCommands";
import type { CommandError, ProjectView } from "./projectCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { sourceActionFixture, sourceAttemptFixture, sourcePageFixture, sourceRowFixture, sourceReceiptFixture } from "./testSupport/sourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...sourceFixture.session, locator: "C:\\isolated\\source-owner", reconciliationState: "settled",
  metadata: { projectId: sourceFixture.session.projectId, displayName: "Fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const preview = sourcePageFixture();
const comparison: SourceChangePage = { ...sourceFixture.comparison,
  scope: { ...preview.scope, currentSnapshot: sourceFixture.content.snapshotId },
  confirmation: { ...preview.confirmation, expectedCurrentSnapshot: sourceFixture.content.snapshotId, lineageBaseSnapshot: sourceFixture.content.snapshotId },
  rows: [{ kind: "added", old: null, new: sourceRowFixture().occurrence, candidates: [] }] };
let owner: ReturnType<typeof useSourceDraftSession>;
let tasks: ReturnType<typeof useExecutionTaskSession>;
let sessionReads: ReturnType<typeof useSessionReads>;
let scope: ContentScope;
let originalRequest: SourceAdoptRequest | null;
function Probe() {
  const value = useSourceDraftSession();
  const cancellation = useExecutionTaskSession();
  const reads = useSessionReads();
  useLayoutEffect(() => { owner = value; tasks = cancellation; sessionReads = reads; });
  return <><output aria-label="Source outcome">{value.state.pendingApply ? "Unconfirmed" : value.state.receipt ? "Applied" : "Idle"}</output>
    <output aria-label="Source decisions">{Object.values(value.state.lineage).map(row => `${row.newOrdinal}: ${row.reason}`).join("; ")}</output></>;
}
beforeEach(() => {
  invoke.mockReset(); scope = preview.scope; originalRequest = null;
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return scope;
    if (command === "create_execution_identity") return sourceFixture.prepare.actionId;
    if (command === "select_source") return sourceFixture.selection;
    if (command === "preflight_source") return sourceFixture.preflight;
    if (command === "start_source_import") return payload.request.attemptId;
    if (command === "cancel_source_capture") return null;
    if (command === "read_execution_attempt") return sourceAttemptFixture(payload.request.attemptId as string, preview.resultId);
    if (command === "read_source_preview") return preview;
    if (command === "read_source_comparison") return comparison;
    if (command === "estimate_source_update") return sourceFixture.estimates;
    if (command === "prepare_source_adoption") { originalRequest = payload.request as unknown as SourceAdoptRequest; return sourceActionFixture(originalRequest); }
    if (command === "read_source_adoption_action") {
      if (!validateRequestAdoptionAction(payload.request)) throw new Error("Invalid source action lookup request");
      return { action: sourceActionFixture(payload.request.adoption, payload.request.unitId), receipt: sourceReceiptFixture(payload.request.adoption, payload.request.unitId) };
    }
    if (command === "adopt_execution" || command === "read_execution_receipt") return sourceReceiptFixture(originalRequest!);
    if (command === "read_execution_cancellation_action") return null;
    throw new Error(command);
  });
});
afterEach(cleanup);

async function ready(update = false) {
  const page = update ? comparison : preview;
  scope = page.scope;
  act(() => { owner.showAttempt(page.attemptId); });
  const detail = await executionCommands.attempt({ ...sourceFixture.session, attemptId: page.attemptId, offset: 0, limit: 100 });
  const read = update ? await sourceCommands.compare({ ...sourceFixture.preview, base: comparison.previousSnapshotId }) : await sourceCommands.preview(sourceFixture.preview);
  act(() => { owner.ready(read, detail); });
  if (update) await act(async () => { await owner.estimate(() => true); });
  act(() => { owner.confirm(true); });
}
function editDecision(ordinal: number, reason: string) {
  act(() => { owner.edit("actor", "Reviewer"); owner.edit("lineage", before => ({ ...before,
    [ordinal]: { newOrdinal: ordinal, oldOccurrenceId: fixtureIdentity(ordinal + 300), decision: "continue", reason } })); });
}
function failFirstAdoptionRead() {
  const original = invoke.getMockImplementation()!; let reads = 0;
  invoke.mockImplementation((command: string, payload) => command === "read_source_adoption_action" && reads++ === 0
    ? Promise.reject(new Error("Original source action read temporarily unavailable")) : original(command, payload));
}
function deferredAction<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const lostSource: CommandError = { code: "outcome-unknown", stage: "execution-adopt", outcome: "unknown", recoveryRequired: true,
  reason: "source-adoption", diagnosticId: fixtureIdentity(990) };

it.each(["prepare", "adopt"] as const)("checks one original lost %s acknowledgement inside its reservation and preserves B after consumer removal", async boundary => {
  const view = render(<Probe/>, project); await ready(true); editDecision(70, "Submitted reason");
  await act(async () => { await owner.estimate(() => true); }); act(() => owner.confirm(true));
  const native = invoke.getMockImplementation()!, write = deferredAction<unknown>(), lookup = deferredAction<Awaited<ReturnType<typeof sourceCommands.adoptionAction>>>();
  invoke.mockImplementation((command: string, payload: { request: SourceAdoptRequest }) => {
    if (command === "prepare_source_adoption" && boundary === "prepare") { originalRequest = payload.request; return write.promise; }
    if (command === "adopt_execution" && boundary === "adopt") return write.promise;
    if (command === "read_source_adoption_action") return lookup.promise;
    return native(command, payload);
  });
  const identities = invoke.mock.calls.filter(([command]) => command === "create_execution_identity").length;
  let running!: Promise<void>; act(() => { running = owner.apply(); void owner.apply(); });
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === (boundary === "prepare" ? "prepare_source_adoption" : "adopt_execution"))).toHaveLength(1));
  expect(owner.current().checkingReceipt).toBe(false);
  const request = owner.current().pendingApply!, unitId = owner.current().pendingApplyUnitId!;
  await act(async () => { write.reject(lostSource); });
  await waitFor(() => expect(owner.current().checkingReceipt).toBe(true));
  expect(owner.current()).toMatchObject({ busyMutation: true, failure: null, receiptChecked: false });
  expect(owner.inFlight()).toBe(true); editDecision(70, "Newer reason B");
  await act(async () => { await owner.checkReceipt(); await owner.retryApply(); owner.keepOutput(); });
  view.rerender(null);
  await act(async () => { lookup.resolve({ action: sourceActionFixture(request, unitId), receipt: sourceReceiptFixture(request, unitId) }); await running; });
  view.rerender(<Probe/>);
  expect(owner.current()).toMatchObject({ pendingApply: null, pendingApplyUnitId: null, checkingReceipt: false, busyMutation: false, failure: null, stale: true });
  expect(screen.getByLabelText("Source decisions")).toHaveTextContent("70: Newer reason B");
  expect(request.confirmation.lineage?.[0].reason).toBe("Submitted reason");
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_adoption_action").map(([, args]) => args.request)).toEqual([{ adoption: request, unitId }]);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(boundary === "prepare" ? 0 : 1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(identities + 1);
  expect(invoke.mock.calls.some(([command]) => command === "read_execution_receipt" || command === "read_source_content")).toBe(false);
});

it.each(["missing", "prepared"] as const)("keeps the exact %s action after an empty read and does not read again after an explicit retry is rejected", async absence => {
  render(<Probe/>, project); await ready();
  const native = invoke.getMockImplementation()!, rejected: CommandError = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
  let prepares = 0;
  invoke.mockImplementation((command: string, payload) => {
    if (command === "prepare_source_adoption" && ++prepares > 1) return Promise.reject(rejected);
    if (command === "adopt_execution") return Promise.reject(lostSource);
    if (command === "read_source_adoption_action") return Promise.resolve(absence === "missing" ? null : { action: sourceActionFixture(payload.request.adoption, payload.request.unitId), receipt: null });
    return native(command, payload);
  });
  await act(async () => { await owner.apply(); });
  const request = owner.current().pendingApply!, unitId = owner.current().pendingApplyUnitId;
  expect(owner.current()).toMatchObject({ receiptChecked: true, failure: lostSource, checkingReceipt: false });
  expect(owner.current().failure).toBe(lostSource);
  await act(async () => { await owner.retryApply(); });
  expect(owner.current()).toMatchObject({ pendingApply: request, pendingApplyUnitId: unitId, receiptChecked: false, failure: rejected });
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_adoption_action")).toHaveLength(1);
  await act(async () => { await owner.retryApply(); owner.keepOutput(); });
  expect(prepares).toBe(2); expect(owner.current().pendingApply).toBe(request);
  invoke.mockImplementation(native);
  await act(async () => { await owner.checkReceipt(); });
  expect(owner.current()).toMatchObject({ pendingApply: null, pendingApplyUnitId: null, receiptChecked: false, failure: null });
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption").map(([, args]) => args.request)).toEqual([request, request]);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
});

it.each(["prepare", "adopt"] as const)("does not read after a fresh %s action is formally rejected", async boundary => {
  render(<Probe/>, project); await ready();
  const native = invoke.getMockImplementation()!, rejected: CommandError = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
  invoke.mockImplementation((command, payload) => command === (boundary === "prepare" ? "prepare_source_adoption" : "adopt_execution") ? Promise.reject(rejected) : native(command, payload));
  await act(async () => { await owner.apply(); });
  expect(owner.current()).toMatchObject({ pendingApply: null, pendingApplyUnitId: null, checkingReceipt: false, failure: rejected });
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_adoption_action")).toHaveLength(0);
});

it.each(["operation", "unit", "parameters", "result", "cancellation", "undefined", "missing-receipt", "read-error"] as const)("does not authorize a retry from a %s action lookup and later confirms only the original proof", async field => {
  render(<Probe/>, project); await ready();
  const native = invoke.getMockImplementation()!;
  const readFailure: CommandError = { code: "storage-failed", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "source-action-read" };
  invoke.mockImplementation((command, payload) => {
    if (command === "adopt_execution") return Promise.reject(lostSource);
    if (command !== "read_source_adoption_action") return native(command, payload);
    if (field === "undefined") return Promise.resolve(undefined);
    if (field === "read-error") return Promise.reject(readFailure);
    const request = payload.request.adoption as SourceAdoptRequest, action = sourceActionFixture(request, payload.request.unitId);
    if (field === "missing-receipt") return Promise.resolve({ action });
    if (field === "operation") action.operation = "sample-update";
    if (field === "unit") action.unitId = fixtureIdentity(90);
    if (field === "parameters") action.parameters = { ...request.confirmation, sourceLanguage: "fr" };
    if (field === "result") action.resultIds = [fixtureIdentity(90)];
    if (field === "cancellation") action.cancellationRevision = "9";
    const value = { action, receipt: null }; expect(validateResponseAdoptionAction(value)).toBe(true); return Promise.resolve(value);
  });
  await act(async () => { await owner.apply(); });
  const request = owner.current().pendingApply!, unitId = owner.current().pendingApplyUnitId;
  expect(request).toBeTruthy(); expect(owner.current().receiptChecked).toBe(false);
  if (field === "read-error") expect(owner.current().failure).toBe(readFailure);
  await act(async () => { await owner.retryApply(); owner.keepOutput(); });
  expect(owner.current().pendingApply).toBe(request);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption")).toHaveLength(1);
  invoke.mockImplementation(native); await act(async () => { await owner.checkReceipt(); });
  expect(owner.current()).toMatchObject({ pendingApply: null, pendingApplyUnitId: null, receiptChecked: false, failure: null });
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_adoption_action").map(([, args]) => args.request)).toEqual([{ adoption: request, unitId }, { adoption: request, unitId }]);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
});

it.each(["before", "during"] as const)("does not dispatch or settle a lookup after its owner retires %s the read", async moment => {
  render(<Probe/>, project); await ready();
  const native = invoke.getMockImplementation()!, write = deferredAction<Receipt>(), lookup = deferredAction<Awaited<ReturnType<typeof sourceCommands.adoptionAction>>>();
  invoke.mockImplementation((command, payload) => command === "adopt_execution" ? write.promise : command === "read_source_adoption_action" ? lookup.promise : native(command, payload));
  let running!: Promise<void>; act(() => { running = owner.apply(); });
  await waitFor(() => expect(originalRequest).not.toBeNull());
  if (moment === "during") { await act(async () => { write.reject(lostSource); }); await waitFor(() => expect(owner.current().checkingReceipt).toBe(true)); }
  const before = owner.current(), request = before.pendingApply!, unitId = before.pendingApplyUnitId!; act(() => sessionReads.retire());
  await act(async () => { if (moment === "before") write.reject(lostSource); else lookup.resolve({ action: sourceActionFixture(request, unitId), receipt: sourceReceiptFixture(request, unitId) }); await running; });
  expect(owner.current()).toBe(before);
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_adoption_action")).toHaveLength(moment === "before" ? 0 : 1);
});

it("reserves a fresh action synchronously and settles its ACK after the consumer unmounts", async () => {
  const view = render(<Probe/>, project);
  await ready();
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.apply(); void owner.apply(); });
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1));
  view.rerender(null);
  await act(async () => { finish(sourceReceiptFixture(originalRequest!)); await pending; });
  expect(owner.current().pendingApply).toBeNull();
  expect(invoke.mock.calls.filter(([name]) => name === "read_source_content")).toHaveLength(0);
  view.rerender(<Probe/>);
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
});

it("settles an original pending application after unrelated current reads and metadata fail or change", async () => {
  const view = render(<Probe/>, project);
  await ready();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Disconnected")) : original(command, payload));
  failFirstAdoptionRead();
  await act(async () => { await owner.apply(); });
  const request = owner.current().pendingApply!;
  const changed = { ...project, metadata: { ...project.metadata, sourceLocale: "fr", targetLocales: [] } };
  view.rerender(<Probe/>, changed);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_content_scope" ? Promise.reject(new Error("Read unavailable"))
    : original(command, payload));
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
  expect(invoke).toHaveBeenCalledWith("read_source_adoption_action", { request: { adoption: request, unitId: sourceActionFixture(request).unitId } });
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});

it("retries the exact original request despite stale scope and revokes a previous no-receipt result on a new unknown", async () => {
  const view = render(<Probe/>, project);
  await ready(true); editDecision(70, "Original reason");
  await act(async () => { await owner.estimate(() => true); });
  act(() => owner.confirm(true));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject({ code: "storage-failed" })
    : command === "read_source_adoption_action" ? Promise.resolve(null) : original(command, payload));
  await act(async () => { await owner.apply(); });
  const request = structuredClone(owner.current().pendingApply!);
  await act(async () => { await owner.checkReceipt(); });
  expect(owner.current().receiptChecked).toBe(true);
  editDecision(70, "Newer reason");
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, sourceLocale: "fr", targetLocales: [] } });
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_content_scope" ? Promise.reject(new Error("Read unavailable"))
    : command === "adopt_execution" ? Promise.reject(new Error("Disconnected again"))
    : command === "read_source_adoption_action" ? Promise.reject(new Error("Original action lookup unavailable again")) : original(command, payload));
  await act(async () => { await owner.retryApply(); });
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(owner.current().pendingApply).toEqual(request);
  expect(owner.current().receiptChecked).toBe(false);
  await act(async () => { await owner.retryApply(); owner.keepOutput(); });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(2);
  expect(owner.current().pendingApply).toEqual(request);
  expect(screen.getByLabelText("Source decisions")).toHaveTextContent("70: Newer reason");
});

it.each(["operation", "unit", "parameters", "result"])("keeps a schema-valid wrong prepare %s unconfirmed and never adopts it", async field => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: SourceAdoptRequest }) => {
    if (command !== "prepare_source_adoption") return original(command, payload);
    const action = sourceActionFixture(payload.request);
    const patch: Partial<AdoptionAction> = field === "operation" ? { operation: "sample-update" } : field === "unit" ? { unitId: fixtureIdentity(90) }
      : field === "result" ? { resultIds: [fixtureIdentity(90)] } : { parameters: { ...payload.request.confirmation, sourceLanguage: "fr" } };
    return Promise.resolve({ ...action, ...patch });
  });
  failFirstAdoptionRead();
  await act(async () => { await owner.apply(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Unconfirmed");
  expect(owner.current().receiptChecked).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
  const request = owner.current().pendingApply!;
  invoke.mockImplementation(original);
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
  expect(invoke.mock.calls.filter(([name]) => name === "read_source_adoption_action").at(-1)![1].request.adoption).toBe(request);
});

it.each(["unit", "revision", "changes"])("keeps a wrong receipt %s unknown until the original receipt is verified", async field => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command !== "adopt_execution" && command !== "read_source_adoption_action") return original(command, payload);
    const receipt = sourceReceiptFixture(originalRequest!);
    const patch: Partial<Receipt> = field === "unit" ? { unitId: fixtureIdentity(90) }
      : field === "revision" ? { changes: [{ ...receipt.changes[0], revision: preview.scope.revision }] }
        : { changes: [...receipt.changes, { ...receipt.changes[0], id: fixtureIdentity(91) }] };
    return Promise.resolve(command === "adopt_execution" ? { ...receipt, ...patch } : { action: sourceActionFixture(originalRequest!), receipt: { ...receipt, ...patch } });
  });
  await act(async () => { await owner.apply(); await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Unconfirmed");
  expect(owner.current().receiptChecked).toBe(false);
  invoke.mockImplementation(original);
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
});

it("requires the exact original action proof from a pure read before settling a receipt without a checked action", async () => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  let valid = false;
  invoke.mockImplementation((command: string, payload: { request: SourceAdoptRequest }) => {
    if (command === "prepare_source_adoption") {
      originalRequest = payload.request;
      return Promise.resolve(valid ? sourceActionFixture(payload.request)
        : { ...sourceActionFixture(payload.request), parameters: { ...payload.request.confirmation, sourceLanguage: "fr" } });
    }
    if (command === "read_source_adoption_action") return Promise.resolve({ action: valid ? sourceActionFixture(originalRequest!)
      : { ...sourceActionFixture(originalRequest!), parameters: { ...originalRequest!.confirmation, sourceLanguage: "fr" } }, receipt: sourceReceiptFixture(originalRequest!) });
    return original(command, payload);
  });
  await act(async () => { await owner.apply(); await owner.checkReceipt(); });
  const request = owner.current().pendingApply!;
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Unconfirmed");
  expect(owner.current().receiptChecked).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
  valid = true;
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption").map(([, payload]) => payload.request)).toEqual([request]);
  expect(invoke.mock.calls.filter(([name]) => name === "read_source_adoption_action")).toHaveLength(3);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
});

it.each(["digest", "snapshot", "missing", "prepared"])("rejects a matching receipt's later %s change while its prepare ACK is still unconfirmed", async field => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  let validAction = false, changedReceipt = false;
  invoke.mockImplementation((command: string, payload: { request: SourceAdoptRequest }) => {
    if (command === "prepare_source_adoption") {
      originalRequest = payload.request;
      return Promise.resolve(validAction ? sourceActionFixture(payload.request) : { ...sourceActionFixture(payload.request), operation: "sample-update" });
    }
    if (command === "read_source_adoption_action") {
      const receipt = sourceReceiptFixture(originalRequest!);
      if (changedReceipt && field === "missing") return Promise.resolve(null);
      if (changedReceipt && field === "prepared") return Promise.resolve({ action: sourceActionFixture(originalRequest!), receipt: null });
      return Promise.resolve({ action: validAction ? sourceActionFixture(originalRequest!) : { ...sourceActionFixture(originalRequest!), operation: "sample-update" },
        receipt: changedReceipt ? field === "digest" ? { ...receipt, requestDigest: "b".repeat(64) }
          : { ...receipt, changes: [{ ...receipt.changes[0], id: fixtureIdentity(92) }] } : receipt });
    }
    return original(command, payload);
  });
  await act(async () => { await owner.apply(); await owner.checkReceipt(); });
  validAction = true; changedReceipt = true;
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Unconfirmed");
  expect(owner.current().receiptChecked).toBe(false);
  changedReceipt = false;
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
});

it.each(["source", "decision", "language"])("does not dispatch a fresh action when %s changes while identity is pending", async change => {
  const view = render(<Probe/>, project); await ready();
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.apply(); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  if (change === "source") await refreshWorkbenchReads(["source"]);
  else if (change === "decision") editDecision(70, "Newer decision");
  else view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, sourceLocale: "fr" } });
  await act(async () => { finish(sourceFixture.prepare.actionId); await pending; });
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption")).toHaveLength(0);
  expect(owner.current().pendingApply).toBeNull();
  expect(owner.current().confirmed).toBe(false);
});

it("rejects discard during a reserved fresh identity instead of dispatching capture cancellation", async () => {
  render(<Probe/>, project); await ready();
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.apply(); });
  await act(async () => { expect(await owner.discard()).toBe(false); });
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_source_capture")).toHaveLength(0);
  await act(async () => { finish(sourceFixture.prepare.actionId); await pending; });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
});

it("allows explicit preflight capture cancellation and ignores its late result", async () => {
  render(<Probe/>, project);
  await act(async () => { await owner.select(); owner.declare(true); });
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "preflight_source" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.preflight(); });
  await act(async () => { expect(await owner.discard()).toBe(true); });
  await act(async () => { finish(sourceFixture.preflight); await pending; });
  expect(owner.current().selection).toBeNull(); expect(owner.current().preflight).toBeNull(); expect(owner.current().busyMutation).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_source_capture")).toHaveLength(1);
});

it("ignores a pure estimate after its consumer leaves without changing retained decisions", async () => {
  const view = render(<Probe/>, project); await ready(true); editDecision(70, "Retained reason");
  let finish!: (value: unknown) => void, visible = true;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "estimate_source_update" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.estimate(() => visible); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  visible = false; view.rerender(null);
  await act(async () => { finish(sourceFixture.estimates); await pending; });
  view.rerender(<Probe/>);
  expect(owner.current().estimate).toBeNull(); expect(owner.current().confirmed).toBe(false);
  expect(screen.getByLabelText("Source decisions")).toHaveTextContent("70: Retained reason");
});

it("allows a Source action after unrelated display-name and target-language changes", async () => {
  const view = render(<Probe/>, project); await ready();
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.apply(); });
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, displayName: "Renamed", targetLocales: [], metadataRevision: "2" } });
  await refreshWorkbenchReads(["project"]);
  await act(async () => { finish(sourceFixture.prepare.actionId); await pending; });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
});

it.each(["identity", "prepare"])("stops late %s continuation when the project owner is destroyed", async boundary => {
  const view = render(<Probe/>, project); await ready();
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: SourceAdoptRequest }) => {
    if (command === (boundary === "identity" ? "create_execution_identity" : "prepare_source_adoption")) {
      if (boundary === "prepare") originalRequest = payload.request;
      return new Promise(resolve => { finish = resolve; });
    }
    return original(command, payload);
  });
  let pending!: Promise<void>;
  act(() => { pending = owner.apply(); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.unmount();
  await act(async () => { finish(boundary === "identity" ? sourceFixture.prepare.actionId : sourceActionFixture(originalRequest!)); await pending; });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
  if (boundary === "identity") expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption")).toHaveLength(0);
});

it("does not write a late adoption ACK into a replacement project owner", async () => {
  const view = render(<Probe/>, project); await ready();
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.apply(); });
  await waitFor(() => expect(originalRequest).not.toBeNull());
  const request = originalRequest!;
  view.rerender(<Probe/>, { ...project, sessionToken: "replacement-session", metadata: { ...project.metadata, projectId: fixtureIdentity(99) } });
  await act(async () => { finish(sourceReceiptFixture(request)); await pending; });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Idle");
  expect(owner.current().receipt).toBeNull();
});

it("preserves every ordinal, actor and reason across filtered pages and source invalidation", async () => {
  const view = render(<Probe/>, project); await ready(true);
  editDecision(0, "First-page reason"); editDecision(70, "Later-page reason");
  act(() => { owner.edit("filter", "hello"); owner.edit("manualOrdinal", 70); owner.edit("historicalQuery", "Earlier text");
    owner.page({ ...comparison, rows: [], filteredTotal: 0 }, "hello"); });
  view.rerender(null); view.rerender(<Probe/>);
  expect(owner.current().filter).toBe("hello"); expect(owner.current().appliedFilter).toBe("hello");
  expect(owner.current().manualOrdinal).toBe(70); expect(owner.current().historicalQuery).toBe("Earlier text");
  await act(async () => { await owner.estimate(() => true); });
  act(() => owner.confirm(true));
  await refreshWorkbenchReads(["source"]);
  expect(owner.current().estimate).toBeNull(); expect(owner.current().confirmed).toBe(false);
  expect(owner.current().comparison?.scope).toEqual(comparison.scope);
  expect(screen.getByLabelText("Source decisions")).toHaveTextContent("0: First-page reason; 70: Later-page reason");
  act(() => owner.page({ ...comparison, previousSnapshotId: fixtureIdentity(95), scope: { revision: "9007199254740994", currentSnapshot: fixtureIdentity(95) },
    confirmation: { ...comparison.confirmation, expectedContentRevision: "9007199254740994", expectedCurrentSnapshot: fixtureIdentity(95), lineageBaseSnapshot: fixtureIdentity(95) } }, "", true));
  expect(owner.current().comparison?.previousSnapshotId).toBe(comparison.previousSnapshotId);
  expect(owner.current().actor).toBe("Reviewer");
});

it("keeps newer decisions when an original delayed adoption is confirmed", async () => {
  render(<Probe/>, project); await ready(true); editDecision(70, "Submitted reason");
  await act(async () => { await owner.estimate(() => true); }); act(() => owner.confirm(true));
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.apply(); });
  await waitFor(() => expect(originalRequest).not.toBeNull());
  const request = structuredClone(originalRequest!);
  editDecision(70, "Newer reason");
  await act(async () => { finish(sourceReceiptFixture(request)); await pending; });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
  expect(screen.getByLabelText("Source decisions")).toHaveTextContent("70: Newer reason");
  expect(request.confirmation.lineage?.[0].reason).toBe("Submitted reason");
  expect(owner.current().comparison).not.toBeNull(); expect(owner.current().stale).toBe(true);
  expect(owner.current().confirmed).toBe(false);
});

it("retains preparation and exact unknown start requests across view remounts", async () => {
  const view = render(<Probe/>, project);
  await act(async () => { await owner.select(); owner.declare(true); await owner.preflight(); });
  view.rerender(null); view.rerender(<Probe/>);
  expect(owner.current().selection).toEqual(sourceFixture.selection);
  expect(owner.current().declared).toBe(true); expect(owner.current().preflight).toEqual(sourceFixture.preflight);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_source_import" ? Promise.reject({ code: "storage-failed" }) : original(command, payload));
  await act(async () => { await owner.start(); });
  const request = structuredClone(owner.current().pendingStart!);
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, sourceLocale: "fr" } });
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_content_scope" ? Promise.reject(new Error("Read unavailable")) : original(command, payload));
  await act(async () => { await owner.retryStart(); });
  expect(invoke.mock.calls.filter(([name]) => name === "start_source_import").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(owner.current().attempt).toBe(request.attemptId); expect(owner.current().pendingStart).toBeNull();
});

it("keeps a replaced Host selection recoverable without rebinding its preflight to the new token", async () => {
  render(<Probe/>, project);
  await act(async () => { await owner.select(); owner.declare(true); await owner.preflight(); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_source_import"
    ? Promise.reject({ code: "permission-denied", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "unauthorized-selection" }) : original(command, payload));
  await act(async () => { await owner.start(); });
  expect(owner.current().pendingStart).toBeNull();
  expect(owner.current().selection).toEqual(sourceFixture.selection);
  expect(owner.current().preflight).toEqual(sourceFixture.preflight);
  const replacement = { ...sourceFixture.selection, selectionId: fixtureIdentity(98), folderName: "Replacement folder" };
  invoke.mockImplementation((command: string, payload: unknown) => command === "select_source" ? Promise.resolve(replacement) : original(command, payload));
  await act(async () => { await owner.select(); });
  expect(owner.current().selection).toEqual(replacement);
  expect(owner.current().preflight).toBeNull(); expect(owner.current().declared).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "start_source_import")).toHaveLength(1);
});

it("keeps page and historical search intent separate from the fixed comparison and all decisions", async () => {
  const view = render(<Probe/>, project); await ready(true); editDecision(0, "First reason"); editDecision(70, "Later reason");
  const fixed = owner.current().comparison;
  act(() => { owner.edit("manualOrdinal", 70); owner.edit("historicalQuery", "Typing B"); owner.pageIntent(50, "Applied A"); owner.historyIntent("Historical A", 1); });
  expect(owner.current().comparison).toBe(fixed); expect(owner.current().comparisonAfter).toBe(50); expect(owner.current().appliedFilter).toBe("Applied A");
  expect(owner.current().historicalSearch).toEqual({ snapshotId: fixed!.previousSnapshotId, query: "Historical A", after: 1, newOrdinal: 70 });
  view.rerender(null); view.rerender(<Probe/>);
  expect(owner.current().historicalQuery).toBe("Typing B"); expect(owner.current().actor).toBe("Reviewer");
  expect(screen.getByLabelText("Source decisions")).toHaveTextContent("0: First reason; 70: Later reason");
  await refreshWorkbenchReads(["source"]);
  expect(owner.current().comparison).toBe(fixed); expect(owner.current().comparisonAfter).toBe(50); expect(owner.current().historicalSearch?.after).toBe(1);
});

it.each(["start", "apply", "cancel"] as const)("does not dispatch fresh %s when its view/query proof changes during identity preparation", async kind => {
  render(<Probe/>, project);
  if (kind === "start") await act(async () => { await owner.select(); owner.declare(true); await owner.preflight(); });
  else await ready();
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void, fresh = true;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = kind === "start" ? owner.start(() => fresh) : kind === "apply" ? owner.apply(() => fresh) : owner.cancelTask(fixtureIdentity(90), () => fresh); });
  await waitFor(() => expect(finish).toBeTypeOf("function")); fresh = false;
  await act(async () => { finish(fixtureIdentity(95)); await pending; });
  expect(invoke.mock.calls.filter(([command]) => ["start_source_import", "prepare_source_adoption", "adopt_execution", "cancel_execution_task"].includes(command))).toHaveLength(0);
  expect(owner.current().pendingStart).toBeNull(); expect(owner.current().pendingApply).toBeNull(); expect(owner.inFlight()).toBe(false);
});
it("bridges Source cancellation to the shared original request without using Source mutation pending", async () => {
  const view = render(<Probe />, project);
  act(() => { owner.showAttempt(preview.attemptId); });
  const original = invoke.getMockImplementation()!;
  let cancelCount = 0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "cancel_execution_task"
    ? ++cancelCount === 1 ? Promise.reject(new Error("Disconnected")) : Promise.resolve("3") : original(command, payload));
  await act(async () => { await owner.cancelTask(fixtureIdentity(150)); });
  expect(owner.current().pendingStart).toBeNull(); expect(owner.current().pendingApply).toBeNull();
  expect(owner.current().busyMutation).toBe(false);
  expect(tasks.current(fixtureIdentity(150))?.phase).toBe("unknown");
  view.rerender(null, project); view.rerender(<Probe />, project);
  await act(async () => { await owner.cancelTask(fixtureIdentity(150)); await tasks.retry(fixtureIdentity(150)); });
  const requests = invoke.mock.calls.filter(([name]) => name === "cancel_execution_task").map(([, payload]) => payload.request);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(tasks.current(fixtureIdentity(150))).toMatchObject({ phase: "recorded", revision: "3" });
});
