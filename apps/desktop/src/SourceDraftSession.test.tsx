import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sourceFixture from "../test/fixtures/sourceCommands.contract.json";
import { useSourceDraftSession } from "./SourceDraftSession";
import { executionCommands, type AdoptionAction, type Receipt } from "./executionCommands";
import { sourceCommands, type ContentScope, type SourceAdoptRequest, type SourceChangePage } from "./sourceCommands";
import type { ProjectView } from "./projectCommands";
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
let scope: ContentScope;
let originalRequest: SourceAdoptRequest | null;
function Probe() {
  const value = useSourceDraftSession();
  useLayoutEffect(() => { owner = value; });
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
    if (command === "adopt_execution" || command === "read_execution_receipt") return sourceReceiptFixture(originalRequest!);
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
  await act(async () => { await owner.apply(); });
  const request = owner.current().pendingApply!;
  const changed = { ...project, metadata: { ...project.metadata, sourceLocale: "fr", targetLocales: [] } };
  view.rerender(<Probe/>, changed);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_content_scope" ? Promise.reject(new Error("Read unavailable"))
    : command === "read_execution_receipt" ? Promise.resolve(sourceReceiptFixture(request)) : original(command, payload));
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
  expect(invoke).toHaveBeenCalledWith("read_execution_receipt", { request: { ...sourceFixture.session, actionId: request.actionId } });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});

it("retries the exact original request despite stale scope and revokes a previous no-receipt result on a new unknown", async () => {
  const view = render(<Probe/>, project);
  await ready(true); editDecision(70, "Original reason");
  await act(async () => { await owner.estimate(() => true); });
  act(() => owner.confirm(true));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject({ code: "storage-failed" })
    : command === "read_execution_receipt" ? Promise.resolve(null) : original(command, payload));
  await act(async () => { await owner.apply(); });
  const request = structuredClone(owner.current().pendingApply!);
  await act(async () => { await owner.checkReceipt(); });
  expect(owner.current().receiptChecked).toBe(true);
  editDecision(70, "Newer reason");
  view.rerender(<Probe/>, { ...project, metadata: { ...project.metadata, sourceLocale: "fr", targetLocales: [] } });
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_content_scope" ? Promise.reject(new Error("Read unavailable"))
    : command === "adopt_execution" ? Promise.reject(new Error("Disconnected again")) : original(command, payload));
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
  await act(async () => { await owner.apply(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Unconfirmed");
  expect(owner.current().receiptChecked).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
  const request = owner.current().pendingApply!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_execution_receipt" ? Promise.resolve(sourceReceiptFixture(request)) : original(command, payload));
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
});

it.each(["unit", "revision", "changes"])("keeps a wrong receipt %s unknown until the original receipt is verified", async field => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command !== "adopt_execution" && command !== "read_execution_receipt") return original(command, payload);
    const receipt = sourceReceiptFixture(originalRequest!);
    const patch: Partial<Receipt> = field === "unit" ? { unitId: fixtureIdentity(90) }
      : field === "revision" ? { changes: [{ ...receipt.changes[0], revision: preview.scope.revision }] }
        : { changes: [...receipt.changes, { ...receipt.changes[0], id: fixtureIdentity(91) }] };
    return Promise.resolve({ ...receipt, ...patch });
  });
  await act(async () => { await owner.apply(); await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Unconfirmed");
  expect(owner.current().receiptChecked).toBe(false);
  invoke.mockImplementation(original);
  await act(async () => { await owner.checkReceipt(); });
  expect(screen.getByLabelText("Source outcome")).toHaveTextContent("Applied");
});

it("requires the exact original recovered prepare ACK before settling a receipt without a checked action", async () => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  let valid = false;
  invoke.mockImplementation((command: string, payload: { request: SourceAdoptRequest }) => {
    if (command === "prepare_source_adoption") {
      originalRequest = payload.request;
      return Promise.resolve(valid ? sourceActionFixture(payload.request)
        : { ...sourceActionFixture(payload.request), parameters: { ...payload.request.confirmation, sourceLanguage: "fr" } });
    }
    if (command === "read_execution_receipt") return Promise.resolve(sourceReceiptFixture(originalRequest!));
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
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption").map(([, payload]) => payload.request)).toEqual([request, request, request]);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
});

it.each(["digest", "snapshot"])("pins the first matching receipt's %s while its prepare ACK is still unconfirmed", async field => {
  render(<Probe/>, project); await ready();
  const original = invoke.getMockImplementation()!;
  let validAction = false, changedReceipt = false;
  invoke.mockImplementation((command: string, payload: { request: SourceAdoptRequest }) => {
    if (command === "prepare_source_adoption") {
      originalRequest = payload.request;
      return Promise.resolve(validAction ? sourceActionFixture(payload.request) : { ...sourceActionFixture(payload.request), operation: "sample-update" });
    }
    if (command === "read_execution_receipt") {
      const receipt = sourceReceiptFixture(originalRequest!);
      return Promise.resolve(changedReceipt ? field === "digest" ? { ...receipt, requestDigest: "b".repeat(64) }
        : { ...receipt, changes: [{ ...receipt.changes[0], id: fixtureIdentity(92) }] } : receipt);
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
