import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sourceFixture from "../test/fixtures/sourceCommands.contract.json";
import { useSourceDraftSession } from "./SourceDraftSession";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { executionCommands, type AdoptionAction, type Receipt } from "./executionCommands";
import { sourceCommands, type ContentScope, type SourceAdoptRequest, type SourceChangePage } from "./sourceCommands";
import type { CommandError, ProjectView } from "./projectCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { sourceActionFixture, sourceAttemptFixture, sourcePageFixture, sourceRowFixture, sourceReceiptFixture } from "./testSupport/sourceFixture";
import { pluginSourceRequest, pluginSourceWorkflow } from "./testSupport/pluginSourceFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { failureReason } from "./CommandFailure";
import { sourceMaintenanceHookCommands as hookCommands, type SourceMaintenanceHookObservation } from "./sourceMaintenanceHookCommands";
import { hookObservation } from "./testSupport/sourceMaintenanceHookFixture";
import { SourceMaintenanceHookChoice, SourceMaintenanceHookStatus } from "./SourceMaintenanceHookControls";
import { sourceHookKey } from "./SourceMaintenanceHook";
import { useSessionReads } from "./SessionReadProvider";
import { i18n } from "./i18n";
import userEvent from "@testing-library/user-event";
import { validateRequestAdoptionAction, validateResponseAdoptionAction } from "./generated/source.validators";

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
    if (command === "read_plugin_execution_start") return null;
    if (command === "read_content_scope") return scope;
    if (command === "create_execution_identity") return sourceFixture.prepare.actionId;
    if (command === "select_plugin_source") return pluginSourceWorkflow.selection;
    if (command === "preflight_plugin_source") return { ...pluginSourceWorkflow.preflight, attemptId: payload.request.attemptId, sourceLanguage: project.metadata.sourceLocale };
    if (command === "start_plugin_source" || command === "start_source_check") return payload.request.attemptId;
    if (command === "prepare_source_check") return { ...pluginSourceWorkflow.checkReview, attemptId: payload.request.attemptId,
      sourceAttemptId: payload.request.sourceAttemptId, sourceResultId: payload.request.sourceResultId };
    if (command === "finish_source_check") return null;
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
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

it("clears a preparation failure when viewing current content while preserving unrelated input", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "select_plugin_source"
    ? Promise.reject({ code: "plugin-failed", outcome: "rejected" }) : original(command, payload));
  render(<Probe/>, project);
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); });
  expect(owner.current().failure).not.toBeNull();
  act(() => { owner.edit("actor", "Retained reviewer"); owner.edit("filter", "Retained search"); owner.showCurrent(); });
  expect(owner.current().failure).toBeNull();
  expect(owner.current().actor).toBe("Retained reviewer");
  expect(owner.current().filter).toBe("Retained search");
  expect(owner.current().source).toEqual(pluginSourceRequest);
  expect(invoke.mock.calls.some(([name]) => ["cancel_source_capture", "start_plugin_source", "prepare_source_adoption", "adopt_execution"].includes(name))).toBe(false);
});

it("keeps identity decisions and their failure when returning to current content is blocked", async () => {
  render(<Probe/>, project); await ready(true); editDecision(70, "Retained identity reason");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "estimate_source_update"
    ? Promise.reject({ code: "dependency-conflict", outcome: "rejected" }) : original(command, payload));
  await act(async () => { await owner.estimate(() => true); });
  const before = owner.current();
  expect(before.failure).not.toBeNull();
  act(() => owner.showCurrent());
  expect(owner.current()).toBe(before);
  expect(owner.current().lineage[70].reason).toBe("Retained identity reason");
});

it.each([false, true])("clears an earlier failure on explicit discard and retains a new cancellation failure (%s)", async fails => {
  render(<Probe/>, project);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "select_plugin_source"
    ? Promise.reject({ code: "plugin-failed", outcome: "rejected" })
    : command === "cancel_source_capture" && fails ? Promise.reject({ code: "storage-failed", outcome: "rejected" }) : original(command, payload));
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); });
  expect(owner.current().failure).not.toBeNull();
  await act(async () => { expect(await owner.discard()).toBe(!fails); });
  if (fails) expect(failureReason(owner.current().failure)).toBe("storage-failed");
  else expect(owner.current().failure).toBeNull();
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_source_capture")).toHaveLength(1);
});

it("allows explicit preflight capture cancellation and ignores its late result", async () => {
  render(<Probe/>, project);
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); owner.declare(true); });
  let finish!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "preflight_plugin_source" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.preflight(); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const request = invoke.mock.calls.find(([name]) => name === "preflight_plugin_source")![1].request;
  await act(async () => { expect(await owner.discard()).toBe(true); });
  await act(async () => { finish({ ...pluginSourceWorkflow.preflight, attemptId: request.attemptId, sourceLanguage: project.metadata.sourceLocale }); await pending; });
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
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); owner.declare(true); await owner.preflight(); owner.consentProducer(true); });
  view.rerender(null); view.rerender(<Probe/>);
  expect(owner.current().selection).toEqual(pluginSourceWorkflow.selection);
  expect(owner.current().declared).toBe(true); expect(owner.current().preflight).toMatchObject({ ...pluginSourceWorkflow.preflight, attemptId: sourceFixture.prepare.actionId, sourceLanguage: project.metadata.sourceLocale });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_plugin_source" ? Promise.reject({ code: "storage-failed" }) : original(command, payload));
  await act(async () => { await owner.start(); });
  const request = structuredClone(owner.current().pendingStart!);
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, sourceLocale: "fr" } });
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_content_scope" ? Promise.reject(new Error("Read unavailable")) : original(command, payload));
  await act(async () => { await owner.retryStart(); });
  expect(invoke.mock.calls.filter(([name]) => name === "start_plugin_source").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(owner.current().attempt).toBe(request.attemptId); expect(owner.current().pendingStart).toBeNull();
});

it("keeps a replaced Host selection recoverable without rebinding its preflight to the new token", async () => {
  render(<Probe/>, project);
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); owner.declare(true); await owner.preflight(); owner.consentProducer(true); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_plugin_source"
    ? Promise.reject({ code: "permission-denied", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "unauthorized-selection" }) : original(command, payload));
  await act(async () => { await owner.start(); });
  expect(owner.current().pendingStart).toBeNull();
  expect(owner.current().selection).toEqual(pluginSourceWorkflow.selection);
  expect(owner.current().preflight).toMatchObject({ ...pluginSourceWorkflow.preflight, attemptId: sourceFixture.prepare.actionId, sourceLanguage: project.metadata.sourceLocale });
  const replacement = { ...pluginSourceWorkflow.selection, selectionId: fixtureIdentity(98), folderName: "Replacement folder" };
  invoke.mockImplementation((command: string, payload: unknown) => command === "select_plugin_source" ? Promise.resolve(replacement) : original(command, payload));
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); });
  expect(owner.current().selection).toEqual(replacement);
  expect(owner.current().preflight).toBeNull(); expect(owner.current().declared).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "start_plugin_source")).toHaveLength(1);
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
  if (kind === "start") await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); owner.declare(true); await owner.preflight(); owner.consentProducer(true); });
  else await ready();
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void, fresh = true;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = kind === "start" ? owner.start(() => fresh) : kind === "apply" ? owner.apply(() => fresh) : owner.cancelTask(fixtureIdentity(90), () => fresh); });
  await waitFor(() => expect(finish).toBeTypeOf("function")); fresh = false;
  await act(async () => { finish(fixtureIdentity(95)); await pending; });
  expect(invoke.mock.calls.filter(([command]) => ["start_plugin_source", "prepare_source_adoption", "adopt_execution", "cancel_execution_task"].includes(command))).toHaveLength(0);
  expect(owner.current().pendingStart).toBeNull(); expect(owner.current().pendingApply).toBeNull(); expect(owner.inFlight()).toBe(false);
});
it("bridges Source cancellation to the shared original request without using Source mutation pending", async () => {
  const view = render(<Probe />, project);
  act(() => { owner.showAttempt(preview.attemptId); });
  const original = invoke.getMockImplementation()!;
  let cancelCount = 0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "cancel_execution_task"
    ? ++cancelCount === 1 ? Promise.reject(new Error("Disconnected")) : Promise.resolve("3") : command === "read_execution_cancellation_action" ? Promise.resolve(null) : original(command, payload));
  await act(async () => { await owner.cancelTask(fixtureIdentity(150)); });
  expect(owner.current().pendingStart).toBeNull(); expect(owner.current().pendingApply).toBeNull();
  expect(owner.current().busyMutation).toBe(false);
  expect(tasks.current(fixtureIdentity(150))?.phase).toBe("unknown");
  view.rerender(null, project); view.rerender(<Probe />, project);
  await act(async () => { await owner.cancelTask(fixtureIdentity(150)); await tasks.retry(fixtureIdentity(150)); });
  const requests = invoke.mock.calls.filter(([name]) => name === "cancel_execution_task").map(([, payload]) => payload.request);
  expect(invoke.mock.calls.filter(([name]) => name === "read_execution_cancellation_action")).toHaveLength(1);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(tasks.current(fixtureIdentity(150))).toMatchObject({ phase: "recorded", revision: "3" });
});

const sourcePluginPhases = [["capture", "preflight_plugin_source"], ["prepare-check", "prepare_source_check"], ["start-check", "start_source_check"], ["finish-check", "finish_source_check"]] as const;
async function prepareSourcePluginPhase(phase: typeof sourcePluginPhases[number][0]) {
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); owner.declare(true); });
  if (phase === "capture") return () => owner.preflight();
  await act(async () => { await owner.preflight(); owner.consentProducer(true); await owner.start(); });
  const proposal = { attemptId: owner.current().attempt!, resultId: preview.resultId };
  if (phase === "prepare-check") return () => owner.prepareCheck(proposal);
  await act(async () => { await owner.prepareCheck(proposal); owner.consentChecker(true); });
  if (phase === "start-check") return () => owner.startCheck();
  await act(async () => { await owner.startCheck(); });
  return () => owner.finishCheck(fixtureIdentity(801));
}
it.each(sourcePluginPhases)("retains the complete original %s intent when an identical retry is later definitely rejected", async (phase, command) => {
  const view = render(<Probe/>, project), work = await prepareSourcePluginPhase(phase), original = invoke.getMockImplementation()!;
  let sent = 0;
  invoke.mockImplementation((name: string, args) => name === command ? Promise.reject(++sent === 1 ? new Error("ACK lost")
    : { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false }) : original(name, args));
  await act(async () => { await work(); });
  const pending = structuredClone(owner.current().pendingPlugin); expect(pending?.pendingKind).toBe(phase); expect(owner.hasPending()).toBe(true);
  view.rerender(null, { ...project, metadata: { ...project.metadata, sourceLocale: "fr" } });
  await act(async () => { await owner.retryPlugin(); });
  expect(owner.current().pendingPlugin).toEqual(pending); expect(owner.hasPending()).toBe(true);
  expect(invoke.mock.calls.filter(([name]) => name === command).slice(-2).map(([, args]) => args.request)).toEqual([pending!.request, pending!.request]);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
});
it("preserves a checked proposal without granting adoption from an unqualified producer result", async () => {
  render(<Probe/>, project); act(() => owner.showAttempt(preview.attemptId));
  const detail = sourceAttemptFixture(preview.attemptId, preview.resultId);
  detail.items[0].status.validation = "pending";
  act(() => { owner.ready(preview, detail); owner.confirm(true); });
  expect(owner.current().preview).toBe(preview); expect(owner.current().confirmed).toBe(false); expect(owner.qualified()).toBe(false);
  await act(async () => { await owner.apply(); });
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption" || name === "adopt_execution")).toHaveLength(0);
  const qualified = sourceAttemptFixture(preview.attemptId, preview.resultId);
  act(() => { owner.ready(preview, qualified); owner.confirm(true); });
  expect(owner.qualified()).toBe(true); expect(owner.current().preview).toBe(preview);
  await act(async () => { await owner.apply(); });
  expect(owner.current().receipt?.actionId).toBe(sourceFixture.prepare.actionId);
});

it("disposes a fresh Source query witness on real owner destruction before identity settles", async () => {
  const view = render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!, dispose = vi.fn(); let finish!: (value: string) => void;
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? new Promise<string>(resolve => { finish = resolve; }) : original(command, args));
  let work!: Promise<void>; act(() => { work = owner.apply(() => true, dispose); }); await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.unmount(); expect(dispose).toHaveBeenCalledTimes(1);
  await act(async () => { finish(fixtureIdentity(998)); await work; }); expect(dispose).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption" || name === "adopt_execution")).toHaveLength(0);
});

function deferredHook<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function mockHook() {
  vi.spyOn(hookCommands, "session").mockResolvedValue({ policyVersion: "source-maintenance-notice-1", sessionEpoch: fixtureIdentity(8800), defaultLifetimeMs: 300_000, maxLifetimeMs: 600_000, windowLimit: 100 });
  vi.spyOn(hookCommands, "read").mockImplementation(async request => hookObservation(request.sourceActionId, owner.hook.current().originalActivation ?? undefined));
  vi.spyOn(hookCommands, "stop").mockImplementation(async request => ({ request: request.stop, result: { kind: "stopped", receipt: { request: request.stop, admissionClosed: true } }, callbacksDrained: true }));
}
async function enableHook() { act(() => owner.hook.editLocale("zh-CN")); await act(async () => { await owner.hook.enable(true); }); }
let hookReads: ReturnType<typeof useSessionReads>;
function HookProbe() { const reads = useSessionReads(); useLayoutEffect(() => { hookReads = reads; }); return <Probe/>; }

it("keeps notice opt-in off and performs no notice IPC until the explicit locale and consent", async () => {
  mockHook(); render(<><Probe/><SourceMaintenanceHookChoice project={project} disabled={false}/></>, project);
  expect(owner.hook.current().enabled).toBe(false); expect(hookCommands.session).not.toHaveBeenCalled(); expect(hookCommands.read).not.toHaveBeenCalled();
  const user = userEvent.setup(); await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("sourceHook.locale") }), "zh-CN");
  expect(hookCommands.session).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox", { name: i18n.t("sourceHook.consent") }));
  await waitFor(() => expect(owner.hook.current().activation).not.toBeNull());
  expect(owner.hook.current().activation).toMatchObject({ locale: "zh-CN", after: 0, limit: 100, sessionEpoch: fixtureIdentity(8800) });
  expect(hookCommands.read).not.toHaveBeenCalled(); expect(hookCommands.stop).not.toHaveBeenCalled();
});

it("freezes the original declaration through unknown adoption and preserves newer source input B", async () => {
  mockHook(); render(<Probe/>, project); await ready(); await enableHook(); act(() => owner.confirm(true));
  const activation = structuredClone(owner.hook.current().activation), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "adopt_execution" ? Promise.reject(new Error("Synthetic disconnected source acknowledgement")) : original(command, args));
  failFirstAdoptionRead();
  await act(async () => { await owner.apply(); });
  const request = owner.current().pendingApply!; expect(request.confirmation.maintenanceHook).toEqual(activation);
  act(() => { owner.edit("actor", "Newer source B"); owner.hook.editLocale("zh-CN"); });
  await act(async () => { await owner.hook.enable(true); });
  const newer = owner.hook.current().activation;
  invoke.mockImplementation(original); await act(async () => { await owner.checkReceipt(); });
  expect(owner.current().pendingApply).toBeNull(); expect(owner.current().receipt?.actionId).toBe(request.actionId); expect(owner.current().actor).toBe("Newer source B");
  expect(owner.hook.current().activation).toBe(newer); expect(owner.hook.current().originalActivation).toEqual(activation);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption").every(([, args]) => JSON.stringify(args.request.confirmation.maintenanceHook) === JSON.stringify(activation))).toBe(true);
  expect(hookCommands.stop).not.toHaveBeenCalled();
});

it("can stop independently while source prepare is waiting and never treats not-known as stopped", async () => {
  mockHook(); render(<Probe/>, project); await ready(); await enableHook(); act(() => owner.confirm(true));
  const pendingPrepare = deferredHook<AdoptionAction>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "prepare_source_adoption" ? (originalRequest = args.request as SourceAdoptRequest, pendingPrepare.promise) : original(command, args));
  vi.mocked(hookCommands.stop).mockImplementationOnce(async request => ({ request: request.stop, result: { kind: "not-known" }, callbacksDrained: true }));
  vi.mocked(hookCommands.read).mockImplementationOnce(async request => ({ sourceActionId: request.sourceActionId, state: "action-not-known", view: null, callbacksDrained: true, error: null }));
  let adoption!: Promise<void>; act(() => { adoption = owner.apply(); }); await waitFor(() => expect(originalRequest).not.toBeNull());
  const pending = owner.current().pendingApply!; expect(owner.inFlight()).toBe(true);
  await act(async () => { await owner.hook.stop(); });
  expect(owner.hook.current().stop?.notKnown).toBe(true); expect(owner.hook.current().closed).toBe(false); expect(owner.current().pendingApply).toBe(pending);
  const stop = vi.mocked(hookCommands.stop).mock.calls[0][0]; await act(async () => { await owner.hook.stop(); });
  expect(vi.mocked(hookCommands.stop).mock.calls[1][0]).toBe(stop); expect(owner.hook.current().closed).toBe(true); expect(owner.current().pendingApply).toBe(pending);
  vi.mocked(hookCommands.read).mockImplementation(async request => ({ ...hookObservation(request.sourceActionId, stop.stop.activation, "stopped"), view: { ...hookObservation(request.sourceActionId, stop.stop.activation, "stopped").view!, stop: { request: stop.stop, admissionClosed: true } } }));
  await act(async () => { pendingPrepare.resolve(sourceActionFixture(pending)); await adoption; });
  expect(owner.current().receipt?.actionId).toBe(pending.actionId); expect(owner.current().pendingApply).toBeNull(); expect(owner.hook.current().closed).toBe(true);
});

it("retires a hung notice read explicitly and ignores its late result after the exact recheck", async () => {
  mockHook(); render(<HookProbe/>, project); await ready(); await enableHook(); act(() => owner.confirm(true));
  const first = deferredHook<SourceMaintenanceHookObservation>(); vi.mocked(hookCommands.read).mockImplementationOnce(() => first.promise);
  await act(async () => { await owner.apply(); }); await waitFor(() => expect(owner.hook.current().reading).toBe(true));
  const id = owner.hook.current().sourceActionId!, activation = owner.hook.current().originalActivation!;
  const closed = hookObservation(id, activation, "stopped"); vi.mocked(hookCommands.read).mockResolvedValueOnce(closed);
  await act(async () => { await owner.hook.retryRead(); }); expect(owner.hook.current().closed).toBe(true);
  await act(async () => { first.resolve(hookObservation(id, activation, "running")); await first.promise; });
  expect(owner.hook.current().closed).toBe(true); expect(hookReads.client.getQueryData(hookReads.key(sourceHookKey(id)))).toEqual(closed);
  expect(hookCommands.session).toHaveBeenCalledTimes(1); expect(hookCommands.stop).not.toHaveBeenCalled();
});

it("retains the exact unknown stop while source acknowledgement is pending and accepts only its late receipt", async () => {
  mockHook(); render(<Probe/>, project); await ready(); await enableHook(); act(() => owner.confirm(true));
  const sourceAck = deferredHook<Receipt>(), stopAck = deferredHook<Awaited<ReturnType<typeof hookCommands.stop>>>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "adopt_execution" ? sourceAck.promise : original(command, args));
  let adoption!: Promise<void>; act(() => { adoption = owner.apply(); }); await waitFor(() => expect(owner.current().preparedAction).not.toBeNull());
  vi.mocked(hookCommands.stop).mockImplementationOnce(() => stopAck.promise); let stopping!: Promise<void>; act(() => { stopping = owner.hook.stop(); });
  await waitFor(() => expect(owner.hook.current().stop?.pending).toBe(true)); const request = owner.hook.current().stop!.request;
  await act(async () => { await owner.hook.retryStop(); }); expect(owner.hook.current().closed).toBe(true);
  expect(vi.mocked(hookCommands.stop).mock.calls[1][0]).toBe(request);
  await act(async () => { stopAck.resolve({ request: request.stop, result: { kind: "not-known" }, callbacksDrained: true }); await stopping; });
  expect(owner.hook.current().closed).toBe(true); expect(owner.hook.current().stop?.notKnown).toBe(false); expect(owner.current().pendingApply).not.toBeNull();
  await act(async () => { sourceAck.resolve(sourceReceiptFixture(owner.current().pendingApply!)); await adoption; });
  expect(owner.current().receipt).not.toBeNull();
});

it("discovers only history on reopen and keeps original notice status across consumer unmount", async () => {
  mockHook(); const view = render(<><Probe/><SourceMaintenanceHookStatus active/></>, project);
  const id = fixtureIdentity(8899); vi.mocked(hookCommands.read).mockResolvedValueOnce(hookObservation(id, undefined, "interrupted"));
  await act(async () => { expect(await owner.hook.select(id)).toBe(true); });
  await waitFor(() => expect(owner.hook.status()?.view?.phase).toBe("interrupted"));
  expect(hookCommands.session).not.toHaveBeenCalled(); expect(hookCommands.stop).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([command]) => command === "prepare_source_adoption" || command === "adopt_execution")).toBe(false);
  view.rerender(<Probe/>); expect(owner.hook.current().sourceActionId).toBe(id);
  view.rerender(<><Probe/><SourceMaintenanceHookStatus active/></>);
  await screen.findByText(i18n.t("sourceHook.phase", { locale: "zh-CN", phase: i18n.t("sourceHook.phases.interrupted") }));
});

it("keeps source success separate from a failed notice read and requires an explicit read retry", async () => {
  mockHook(); render(<><Probe/><SourceMaintenanceHookStatus active/></>, project); await ready(); await enableHook(); act(() => owner.confirm(true));
  vi.mocked(hookCommands.read).mockRejectedValueOnce(new Error("Synthetic notice read failure"));
  await act(async () => { await owner.apply(); }); await screen.findByText(i18n.t("sourceHook.readFailed"));
  expect(owner.current().receipt).not.toBeNull(); expect(owner.current().failure).toBeNull(); expect(owner.current().pendingApply).toBeNull();
  expect(hookCommands.read).toHaveBeenCalledTimes(1); expect(hookCommands.stop).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("sourceHook.read") }));
  await waitFor(() => expect(owner.hook.status()?.view?.phase).toBe("observed")); expect(hookCommands.read).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
});

it("does not renew a declaration at expiry or let a retired declaration read overwrite newer choices", async () => {
  mockHook(); render(<Probe/>, project); await ready();
  const wait = deferredHook<Awaited<ReturnType<typeof hookCommands.session>>>(); vi.mocked(hookCommands.session).mockImplementationOnce(() => wait.promise);
  act(() => owner.hook.editLocale("zh-CN")); let first!: Promise<void>; act(() => { first = owner.hook.enable(true); });
  await waitFor(() => expect(hookCommands.session).toHaveBeenCalledTimes(1));
  await act(async () => { await owner.hook.enable(true); }); const current = owner.hook.current().activation!;
  await act(async () => { wait.resolve({ policyVersion: "source-maintenance-notice-1", sessionEpoch: fixtureIdentity(8891), defaultLifetimeMs: 300_000, maxLifetimeMs: 600_000, windowLimit: 100 }); await first; });
  expect(owner.hook.current().activation).toBe(current); vi.spyOn(Date, "now").mockReturnValue(current.expiresAtMs + 1);
  expect(owner.hook.canPrepare()).toBe(false); act(() => owner.confirm(true)); await act(async () => { await owner.apply(); });
  expect(invoke.mock.calls.some(([command]) => command === "prepare_source_adoption")).toBe(false); expect(hookCommands.session).toHaveBeenCalledTimes(2);
  expect(owner.hook.current().activation).toBe(current);
});

it("keeps only the latest explicitly selected history identity while an older selection retires its read", async () => {
  mockHook(); render(<Probe/>, project); const first = fixtureIdentity(8897), second = fixtureIdentity(8898);
  let a!: Promise<boolean>, b!: Promise<boolean>; act(() => { a = owner.hook.select(first); b = owner.hook.select(second); });
  await act(async () => { await Promise.all([a, b]); }); await waitFor(() => expect(owner.hook.status()?.sourceActionId).toBe(second));
  expect(owner.hook.current().sourceActionId).toBe(second); expect(hookCommands.session).not.toHaveBeenCalled();
});

it.each(["observed", "expired"] as const)("can replay the exact unknown stop after the notice naturally becomes %s", async phase => {
  mockHook(); render(<Probe/>, project); await ready(); await enableHook(); act(() => owner.confirm(true));
  const ack = deferredHook<Receipt>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "adopt_execution" ? ack.promise : original(command, args));
  let applying!: Promise<void>; act(() => { applying = owner.apply(); }); await waitFor(() => expect(owner.current().pendingApply).not.toBeNull());
  vi.mocked(hookCommands.stop).mockRejectedValueOnce(new Error("Synthetic lost stop acknowledgement")); await act(async () => { await owner.hook.stop(); });
  const request = owner.hook.current().stop!.request, value = hookObservation(request.stop.sourceActionId, request.stop.activation, phase);
  value.view!.admissionClosed = true; vi.mocked(hookCommands.read).mockResolvedValueOnce(value);
  await act(async () => { await owner.hook.read(); });
  expect(owner.hook.current().closed).toBe(true); expect(owner.hook.blocked()).toBe(true); expect(owner.hook.canStop()).toBe(true);
  vi.mocked(hookCommands.read).mockResolvedValueOnce({ ...value, view: { ...value.view!, stop: { request: request.stop, admissionClosed: true } } });
  await act(async () => { await owner.hook.stop(); });
  expect(vi.mocked(hookCommands.stop).mock.calls[1][0]).toBe(request); expect(owner.hook.blocked()).toBe(false); expect(owner.hook.current().stop?.unknown).toBe(false);
  await act(async () => { ack.resolve(sourceReceiptFixture(owner.current().pendingApply!)); await applying; });
  expect(owner.current().receipt).not.toBeNull();
});

it("explicitly ends only the local unknown stop wait after another lifecycle stop is closed and drained", async () => {
  mockHook(); render(<><Probe/><SourceMaintenanceHookStatus active/></>, project); await ready(); await enableHook(); act(() => owner.confirm(true));
  vi.mocked(hookCommands.read).mockImplementation(async request => hookObservation(request.sourceActionId, owner.hook.current().originalActivation ?? undefined, "prepared"));
  const ack = deferredHook<Receipt>(), stopAck = deferredHook<Awaited<ReturnType<typeof hookCommands.stop>>>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "adopt_execution" ? ack.promise : original(command, args));
  let applying!: Promise<void>; act(() => { applying = owner.apply(); }); await waitFor(() => expect(owner.current().pendingApply).not.toBeNull());
  vi.mocked(hookCommands.stop).mockImplementationOnce(() => stopAck.promise); let stopping!: Promise<void>; act(() => { stopping = owner.hook.stop(); });
  await waitFor(() => expect(owner.hook.current().stop).not.toBeNull()); const request = owner.hook.current().stop!.request, pending = owner.current().pendingApply;
  const closed = hookObservation(request.stop.sourceActionId, request.stop.activation, "stopped");
  closed.view!.stop = { request: { ...request.stop, actionId: fixtureIdentity(8894) }, admissionClosed: true }; closed.callbacksDrained = false;
  vi.mocked(hookCommands.read).mockResolvedValueOnce(closed); await act(async () => { await owner.hook.read(); });
  expect(owner.hook.canEndWait()).toBe(false); expect(owner.hook.endWait()).toBe(false); expect(owner.hook.blocked()).toBe(true);
  vi.mocked(hookCommands.read).mockResolvedValueOnce({ ...closed, callbacksDrained: true }); await act(async () => { await owner.hook.read(); });
  expect(owner.hook.canEndWait()).toBe(true);
  await userEvent.setup().click(screen.getByRole("button", { name: i18n.t("sourceHook.endWait") }));
  expect(owner.hook.blocked()).toBe(false); expect(owner.hook.current().waitEnded).toBe(true); expect(owner.hook.current().stop?.ended).toBe(true);
  expect(owner.current().pendingApply).toBe(pending); expect(screen.getByText(i18n.t("sourceHook.waitEnded"))).toBeInTheDocument();
  await act(async () => { stopAck.resolve({ request: request.stop, result: { kind: "not-known" }, callbacksDrained: false }); await stopping; });
  expect(owner.hook.current().waitEnded).toBe(true); expect(owner.hook.current().stop?.notKnown).toBe(false);
  vi.mocked(hookCommands.read).mockResolvedValue({ ...closed, callbacksDrained: true });
  await act(async () => { ack.resolve(sourceReceiptFixture(pending!)); await applying; }); expect(owner.current().receipt).not.toBeNull();
});

async function ordinarySourceStart(checker: boolean) {
  if (checker) return prepareSourcePluginPhase("start-check");
  await act(async () => { owner.setSource(pluginSourceRequest); await owner.select(); owner.declare(true); await owner.preflight(); owner.consentProducer(true); });
  return () => owner.start();
}
it.each([false, true])("settles the exact original Source start from one automatic proof (checker=%s)", async checker => {
  const view = render(<Probe/>, project), work = await ordinarySourceStart(checker), original = invoke.getMockImplementation()!;
  const command = checker ? "start_source_check" : "start_plugin_source";
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>(done => { resolve = done; });
  invoke.mockImplementation((name, args) => name === command ? Promise.resolve(fixtureIdentity(999))
    : name === "read_plugin_execution_start" ? response : original(name,args));
  let running!: Promise<void>; act(() => { running = work(); });
  await waitFor(() => expect(owner.current().checkingStart).toBe(true));
  const pending = owner.current().pendingPlugin;
  if (checker && pending?.pendingKind !== "start-check") throw new Error("Expected original source checker start");
  const request = checker && pending?.pendingKind === "start-check" ? pending.request : owner.current().pendingStart!;
  const read = invoke.mock.calls.filter(([name]) => name === "read_plugin_execution_start").at(-1)![1].request;
  expect(read).toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, attemptId: request.attemptId,
    inputDigest: request.inputDigest, operation: checker ? "source-semantic-check" : "source-import" });
  act(() => { owner.edit("actor", "Newer B"); owner.edit("lineage", { 70: { newOrdinal: 70, oldOccurrenceId: fixtureIdentity(370), decision: "continue", reason: "Newer reason" } }); });
  view.rerender(null, { ...project, metadata: { ...project.metadata, sourceLocale: "fr" } });
  await act(async () => { await owner.checkStart(); await owner.checkPluginStart(); await owner.retryStart(); await owner.retryPlugin(); });
  expect(invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1);
  await act(async () => { resolve({ projectId: read.projectId, taskId: fixtureIdentity(888), attemptId: read.attemptId, operation: read.operation, inputDigest: read.inputDigest }); await running; });
  view.rerender(<Probe/>);
  expect(owner.current().pendingStart).toBeNull(); expect(owner.current().pendingPlugin).toBeNull();
  expect(checker ? owner.current().checkAttempt : owner.current().attempt).toBe(request.attemptId);
  expect(owner.current().actor).toBe("Newer B"); expect(owner.current().lineage[70].reason).toBe("Newer reason");
  expect(owner.current().confirmed).toBe(false); if (!checker) expect(owner.current().stale).toBe(true);
  expect(invoke.mock.calls.filter(([name]) => name === "read_plugin_execution_start")).toHaveLength(1);
});
it.each([false, true])("blocks Source replay after a bad proof, checks absence, and retains the original grant on explicit retry (checker=%s)", async checker => {
  render(<Probe/>, project); const work = await ordinarySourceStart(checker), original = invoke.getMockImplementation()!;
  const command = checker ? "start_source_check" : "start_plugin_source";
  let reads = 0, sends = 0;
  invoke.mockImplementation((name,args) => {
    if (name === command) return Promise.reject(++sends === 1 ? new Error("Lost ACK") : { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false });
    if (name === "read_plugin_execution_start") return Promise.resolve(++reads === 1 ? { ...args.request, taskId: fixtureIdentity(888), inputDigest: "b".repeat(64) }
      : reads === 2 ? null : { projectId: args.request.projectId, taskId: fixtureIdentity(888), attemptId: args.request.attemptId, operation: args.request.operation, inputDigest: args.request.inputDigest });
    return original(name,args);
  });
  await act(async () => { await work(); });
  const pending = checker ? owner.current().pendingPlugin : owner.current().pendingStart;
  expect(pending).not.toBeNull(); expect(owner.current().startRetryAllowed).toBe(false);
  await act(async () => { await owner.retryStart(); await owner.retryPlugin(); }); expect(sends).toBe(1); expect(reads).toBe(1);
  await act(async () => { if (checker) await owner.checkPluginStart(); else await owner.checkStart(); });
  expect(owner.current().startRetryAllowed).toBe(true); expect(sends).toBe(1);
  await act(async () => { if (checker) await owner.retryPlugin(); else await owner.retryStart(); });
  expect(sends).toBe(2); expect(reads).toBe(3);
  expect(owner.current().pendingStart).toBeNull(); expect(owner.current().pendingPlugin).toBeNull();
  const sent = invoke.mock.calls.filter(([name]) => name === command).map(([,args]) => args.request); expect(sent[1]).toEqual(sent[0]);
});

it.each([false,true])("ignores a late original Source proof after session replacement (checker=%s)", async checker => {
  const view = render(<Probe/>,project), work = await ordinarySourceStart(checker), original = invoke.getMockImplementation()!;
  let resolve!: (value:unknown)=>void;const response=new Promise<unknown>(done=>{resolve=done;});
  invoke.mockImplementation((name,args)=>name===(checker?"start_source_check":"start_plugin_source")?Promise.reject(new Error("Lost ACK"))
    :name==="read_plugin_execution_start"?response:original(name,args));
  let running!:Promise<void>;act(()=>{running=work();});await waitFor(()=>expect(owner.current().checkingStart).toBe(true));
  const old=owner,read=invoke.mock.calls.find(([name])=>name==="read_plugin_execution_start")![1].request;
  view.rerender(<Probe/>,{...project,sessionToken:"replacement-session"});
  await act(async()=>{resolve({projectId:read.projectId,taskId:fixtureIdentity(888),attemptId:read.attemptId,operation:read.operation,inputDigest:read.inputDigest});await running;});
  expect(owner.current().attempt).toBeNull();expect(owner.current().checkAttempt).toBeNull();expect(owner.hasPending()).toBe(false);
  expect(checker?old.current().pendingPlugin:old.current().pendingStart).not.toBeNull();
});
