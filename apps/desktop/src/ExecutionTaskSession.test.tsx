import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { TaskCancellationFeedback, useExecutionTaskSession, type CancellationTarget, type CancellationRetryIntent } from "./ExecutionTaskSession";
import type { ProjectView } from "./projectCommands";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import { ExecutionTasks, type TasksHandle } from "./ExecutionTasks";
import { executionCommands, type AttemptDetail, type ContinuationRequest, type ContinuationReceipt } from "./executionCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { validateResponseAttempt } from "./generated/execution.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...fixture.session, locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixture.session.projectId, displayName: "Tasks", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const target: CancellationTarget = { taskId: fixture.detail.taskId, attemptId: fixture.detail.attemptId, origin: "tasks" };
let owner: ReturnType<typeof useExecutionTaskSession>;
let translation: ReturnType<typeof useTranslationDraftSession>;
let sessionReads: ReturnType<typeof useSessionReads>;
function Probe() {
  const value = useExecutionTaskSession();
  const draft = useTranslationDraftSession();
  const reads = useSessionReads();
  useLayoutEffect(() => { owner = value; translation = draft; sessionReads = reads; });
  return <TaskCancellationFeedback origin="tasks" />;
}
function FailedReadProbe() {
  const reads = useSessionReads();
  const query = useSessionQuery({ key: ["cancellation-test-status"], scopes: ["execution"], enabled: true, read: () => executionCommands.status(reads.context) });
  return <output aria-label="Task read">{query.error ? "Read failed" : "Reading"}</output>;
}
function ResumedAttemptProbe() {
  const reads = useSessionReads();
  const query = useSessionQuery({ key: ["cancellation-test-resume"], scopes: ["execution"], enabled: true,
    read: () => executionCommands.task({ ...reads.context, taskId: target.taskId, after: "0", limit: 50 }) });
  return <output aria-label="Current task attempt">{query.data?.at(-1)?.attemptId ?? "Reading"}</output>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset();
  let identity = 90;
  invoke.mockImplementation(async command => {
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "cancel_execution_task") return "1";
    if (command === "read_execution_task_view") return { ...fixture.task, cancellationRevision: "0" };
    throw new Error(command);
  });
});

function applicationDetail(): AttemptDetail {
  const value: AttemptDetail = structuredClone(fixture.detail) as AttemptDetail;
  Object.assign(value.items[0].status, { execution: "succeeded", validation: "valid", cancellationRequested: false });
  value.items[0].resultId = fixture.prepare.resultIds[0];
  Object.assign(value.progress, { succeeded: 1, unknown: 0 });
  Object.assign(value.recovery.units[0], { actions: ["adopt-result"], blockedReason: null, resultIds: [...fixture.prepare.resultIds], remainingItemIds: [] });
  if (!validateResponseAttempt(value)) throw new Error("Invalid execution adoption fixture");
  return value;
}
const generalAction = () => ({ ...structuredClone(fixture.action), parameters: null });
async function confirmApplication(value = applicationDetail()) {
  await act(async () => { await owner.begin(value, value.recovery.units[0], "adopt-result", 0); });
  expect(owner.activity?.phase).toBe("confirming");
}
function installApplication() {
  invoke.mockImplementation(async command => {
    if (command === "create_execution_identity") return fixture.prepare.actionId;
    if (command === "prepare_execution_adoption") return generalAction();
    if (command === "adopt_execution" || command === "read_execution_receipt") return structuredClone(fixture.receipt);
    if (command === "cancel_execution_task") return "2";
    throw new Error(command);
  });
}

it("shares the existing translation reservation before identity and excludes same-task cancellation", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  let identify!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity"
    ? new Promise(resolve => { identify = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  act(() => { pending = owner.submit(); void owner.submit(); void owner.cancel(target); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(translation.reserveMutation()).toBeNull();
  act(() => { translation.begin({ unitId: fixtureIdentity(270), locale: "zh-CN", sourceRevisionId: fixtureIdentity(271), key: "manual", sourceText: "Source" }, null, null);
    translation.edit("New manual draft"); });
  await act(async () => { expect((await translation.save()).saved).toBe(false); });
  expect(calls("save_translation_revision")).toHaveLength(0);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(owner.canCancel(target)).toBe(false);
  expect(calls("cancel_execution_task")).toHaveLength(0);
  await act(async () => { identify(fixture.prepare.actionId); await pending; });
  expect(owner.activity?.phase).toBe("recorded");
  expect(translation.current()?.text).toBe("New manual draft");
  let token: symbol | null = null; act(() => { token = translation.reserveMutation(); }); expect(token).not.toBeNull();
  act(() => { if (token) translation.releaseMutation(token); });
});

it("does not start general adoption while that task's original cancellation is still preparing", async () => {
  render(<Probe />, project); installApplication();
  let identify!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? new Promise(resolve => { identify = resolve; }) : Promise.resolve("2"));
  let pending!: Promise<void>; act(() => { pending = owner.cancel(target); });
  const value = applicationDetail();
  await act(async () => { await owner.begin(value, value.recovery.units[0], "adopt-result", 0); await owner.submit(); });
  expect(owner.activity).toBeNull(); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("prepare_execution_adoption")).toHaveLength(0);
  await act(async () => { identify(fixtureIdentity(272)); await pending; });
  expect(owner.current(target.taskId)?.phase).toBe("recorded");
});

it("does not allocate an adoption identity while another translation write is reserved", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  let token: symbol | null = null;
  act(() => { token = translation.reserveMutation(); });
  await act(async () => { await owner.submit(); });
  expect(owner.activity).toMatchObject({ phase: "confirming", failure: "busy" });
  expect(calls("create_execution_identity")).toHaveLength(0);
  act(() => { if (token) translation.releaseMutation(token); });
  await act(async () => { await owner.submit(); });
  expect(owner.activity?.phase).toBe("recorded");
});

it.each(["identity", "prepare", "adopt"] as const)("continues fixed adoption after consumer unmount during %s", async stage => {
  const view = render(<Probe />, project); installApplication(); await confirmApplication();
  let finish!: (value: unknown) => void;
  const waiting = stage === "identity" ? "create_execution_identity" : stage === "prepare" ? "prepare_execution_adoption" : "adopt_execution";
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === waiting ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  await act(async () => { pending = owner.submit(); await Promise.resolve(); await Promise.resolve(); });
  expect(finish).toBeDefined(); view.rerender(null, project);
  await act(async () => { finish(stage === "identity" ? fixture.prepare.actionId : stage === "prepare" ? generalAction() : fixture.receipt); await pending; });
  view.rerender(<Probe />, project);
  expect(owner.activity).toMatchObject({ phase: "recorded", prepare: fixture.prepare, receipt: fixture.receipt });
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("prepare_execution_adoption").map(([, payload]) => payload.request)).toEqual([fixture.prepare]);
  expect(calls("adopt_execution").map(([, payload]) => payload.request)).toEqual([fixture.adopt]);
});

it.each(["identity", "prepare", "adopt"] as const)("stops late %s continuation when the real project owner is destroyed", async stage => {
  const view = render(<Probe />, project); installApplication(); await confirmApplication();
  let finish!: (value: unknown) => void;
  const waiting = stage === "identity" ? "create_execution_identity" : stage === "prepare" ? "prepare_execution_adoption" : "adopt_execution";
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === waiting ? new Promise(resolve => { finish = resolve; }) : original(command, payload));
  let pending!: Promise<void>;
  await act(async () => { pending = owner.submit(); await Promise.resolve(); await Promise.resolve(); });
  expect(finish).toBeDefined();
  view.rerender(<Probe />, { ...project, sessionToken: "session-B" });
  await act(async () => { finish(stage === "identity" ? fixture.prepare.actionId : stage === "prepare" ? generalAction() : fixture.receipt); await pending; });
  expect(owner.activity).toBeNull(); expect(owner.unresolved()).toBe(false);
  expect(calls("prepare_execution_adoption")).toHaveLength(stage === "identity" ? 0 : 1);
  expect(calls("adopt_execution")).toHaveLength(stage === "adopt" ? 1 : 0);
});

it("freezes the caller's complete unit and ordered prepare payload before identity", async () => {
  render(<Probe />, project); installApplication();
  const detail = applicationDetail(); await confirmApplication(detail);
  detail.taskId = fixtureIdentity(280); detail.attemptId = fixtureIdentity(281);
  detail.recovery.units[0].unitId = fixtureIdentity(282); detail.recovery.units[0].resultIds.reverse();
  detail.recovery.units[0].scopes[0].id = "Changed caller";
  await act(async () => { await owner.submit(); });
  expect(owner.activity?.intent.taskId).toBe(target.taskId);
  expect(owner.activity?.intent.unit.scopes[0].id).toBe("Sample A");
  expect(Object.isFrozen(owner.activity?.intent.unit.scopes[0])).toBe(true);
  expect(Object.isFrozen(owner.activity?.prepare?.resultIds)).toBe(true);
  expect(calls("prepare_execution_adoption")[0][1].request).toEqual(fixture.prepare);
});

it("rejects a shape-valid wrong preparation before adoption and revokes a missing-receipt permission", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockResolvedValueOnce({ ...generalAction(), operation: "other" });
  await act(async () => { await owner.submit(); });
  expect(owner.activity?.phase).toBe("unknown"); expect(calls("adopt_execution")).toHaveLength(0);
  invoke.mockResolvedValueOnce(null);
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.activity?.retryAllowed).toBe(true);
  invoke.mockRejectedValueOnce(new Error("Preparation acknowledgement lost again"));
  await act(async () => { await owner.retryAdoption(); });
  expect(owner.activity).toMatchObject({ phase: "unknown", retryAllowed: false, prepare: fixture.prepare });
  await act(async () => { await owner.retryAdoption(); });
  expect(calls("prepare_execution_adoption")).toHaveLength(2);
  expect(calls("adopt_execution")).toHaveLength(0);
});

it("restores lost preparation evidence using only the original prepare when its receipt already exists", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce(new Error("Lost preparation ACK"));
  await act(async () => { await owner.submit(); });
  expect(owner.activity?.proof).toBeNull();
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.activity).toMatchObject({ phase: "recorded", receipt: fixture.receipt, proof: { parameters: null } });
  expect(calls("adopt_execution")).toHaveLength(0);
  expect(calls("prepare_execution_adoption").map(([, payload]) => payload.request)).toEqual([fixture.prepare, fixture.prepare]);
  expect(calls("read_execution_receipt")[0][1].request).toEqual(fixture.adopt);
  expect(calls("read_project")).toHaveLength(0);
});

it("pins a seen receipt before failed proof restoration and never readopts after it disappears or changes", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce(new Error("Lost preparation ACK"));
  await act(async () => { await owner.submit(); });
  invoke.mockResolvedValueOnce(fixture.receipt).mockResolvedValueOnce({ ...generalAction(), parameters: {} });
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.activity).toMatchObject({ phase: "unknown", receipt: fixture.receipt, retryAllowed: false });
  invoke.mockResolvedValueOnce(null);
  await act(async () => { await owner.checkAdoption(); await owner.retryAdoption(); owner.dismiss(); });
  expect(owner.activity).toMatchObject({ phase: "unknown", receipt: fixture.receipt, retryAllowed: false });
  invoke.mockResolvedValueOnce({ ...fixture.receipt, requestDigest: "f".repeat(64) });
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.activity?.receipt).toEqual(fixture.receipt);
  expect(calls("adopt_execution")).toHaveLength(0);
  expect(calls("prepare_execution_adoption")).toHaveLength(2);
  expect(owner.unresolved()).toBe(true);
});

it("retains the original uncertainty after a formally rejected replay and can settle only checked original evidence", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockResolvedValueOnce(generalAction()).mockRejectedValueOnce(new Error("Lost adoption ACK"));
  await act(async () => { await owner.submit(); });
  const original = owner.activity?.prepare;
  invoke.mockResolvedValueOnce(null);
  await act(async () => { await owner.checkAdoption(); });
  invoke.mockRejectedValueOnce({ code: "busy", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false });
  await act(async () => { await owner.retryAdoption(); });
  expect(owner.activity).toMatchObject({ phase: "unknown", retryAllowed: false, uncertain: true });
  expect(owner.activity?.prepare).toBe(original);
  expect(translation.reserveMutation()).toBeNull();
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.activity?.phase).toBe("recorded");
  expect(calls("adopt_execution")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it("pins the first checked cancellation basis and keeps an incompatible replay unknown", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockResolvedValueOnce(generalAction()).mockRejectedValueOnce(new Error("Lost adoption ACK"));
  await act(async () => { await owner.submit(); });
  invoke.mockResolvedValueOnce(null); await act(async () => { await owner.checkAdoption(); });
  invoke.mockResolvedValueOnce({ ...generalAction(), cancellationRevision: "2" });
  await act(async () => { await owner.retryAdoption(); });
  expect(owner.activity?.phase).toBe("unknown");
  expect(owner.activity?.proof?.cancellationRevision).toBe(fixture.action.cancellationRevision);
  expect(calls("adopt_execution")).toHaveLength(1);
});

it("settles a business ACK before a subsequent pure query failure", async () => {
  const view = render(<Probe />, project); installApplication(); await confirmApplication();
  await act(async () => { await owner.submit(); });
  invoke.mockRejectedValue(new Error("Later projection failed"));
  view.rerender(<><Probe /><FailedReadProbe /></>, project);
  await screen.findByText("Read failed");
  expect(owner.activity).toMatchObject({ phase: "recorded", receipt: fixture.receipt });
  expect(owner.unresolved()).toBe(false);
});

it("does not let an already recorded cancellation conceal the same task's new unknown adoption", async () => {
  render(<Probe />, project); installApplication();
  await act(async () => { await owner.cancel(target); });
  await confirmApplication();
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce(new Error("Lost preparation ACK"));
  await act(async () => { await owner.submit(); });
  expect(owner.current(target.taskId)?.phase).toBe("recorded");
  expect(owner.activity?.phase).toBe("unknown"); expect(owner.unresolved()).toBe(true);
});

it("keeps a missing original typed recovery outcome unresolved through remount and newer projections without retrying it", async () => {
  const view = render(<Probe />, project);
  const value = applicationDetail(); value.items[0].status.execution = "failed"; value.items[0].status.validation = "absent";
  value.recovery.units[0].actions = ["retry-safe-failure"]; value.recovery.units[0].remainingItemIds = [...value.recovery.units[0].itemIds];
  await act(async () => { await owner.begin(value, value.recovery.units[0], "retry-safe-failure", 0); });
  invoke.mockResolvedValueOnce(fixtureIdentity(90)).mockRejectedValueOnce(new Error("New attempt created, ACK lost"));
  await act(async () => { await owner.submit(); });
  const request = owner.activity?.continuationRequest;
  expect(request).toEqual({ ...fixture.session, action: { actionId: fixtureIdentity(90), projectId: fixture.session.projectId,
    sourceAttemptId: value.attemptId, unitId: value.recovery.units[0].unitId, kind: "retry-safe-failure",
    expectedCancellationRevision: "0", itemIds: value.recovery.units[0].remainingItemIds } });
  view.rerender(null, project); view.rerender(<Probe />, project); await refreshWorkbenchReads();
  await act(async () => { await owner.submit(); await owner.retryAdoption(); await owner.retryContinuation(); owner.dismiss(); });
  expect(owner.activity).toMatchObject({ phase: "unknown", continuationRequest: request, retryAllowed: false });
  expect(calls("continue_execution").map(([, payload]) => payload.request)).toEqual([request]);
  expect(calls("recover_execution")).toHaveLength(0);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(owner.unresolved()).toBe(true);
});

function continuationDetail(): AttemptDetail {
  const value = structuredClone(fixture.detail) as AttemptDetail;
  Object.assign(value.items[0].status, { execution: "queued", cancellationRequested: false });
  Object.assign(value.progress, { unknown: 0, queued: 1 });
  Object.assign(value.recovery.units[0], { actions: ["resume-undispatched"], blockedReason: null });
  return value;
}
function continuationReceipt(request: ContinuationRequest): ContinuationReceipt {
  return { ...structuredClone(fixture.continuationReceipt), action: { ...request.action, itemIds: [...request.action.itemIds].sort() },
    taskId: target.taskId, operation: "sample-update", attemptId: fixtureIdentity(290), sequence: "2" };
}
async function confirmContinuation(value = continuationDetail(), offset = 0) {
  await act(async () => { await owner.begin(value, value.recovery.units[0], "resume-undispatched", offset); });
  expect(owner.activity?.phase).toBe("confirming");
}

it("freezes a legitimate zero continuation basis before a delayed identity and preserves it after consumer remount", async () => {
  const view = render(<Probe />, project); const detail = continuationDetail(); await confirmContinuation(detail);
  let identify!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: ContinuationRequest }) => {
    if (command === "create_execution_identity") return new Promise(resolve => { identify = resolve; });
    if (command === "continue_execution") return Promise.resolve(continuationReceipt(payload.request));
    if (command === "read_execution_task_view") return Promise.resolve({ ...fixture.task, cancellationRevision: "9" });
    return original(command, payload);
  });
  let pending!: Promise<void>;
  act(() => { pending = owner.submit(); void owner.submit(); void owner.cancel(target); });
  expect(owner.canCancel(target)).toBe(false);
  detail.recovery.units[0].remainingItemIds.length = 0; detail.recovery.units[0].scopes[0].id = "Changed caller";
  view.rerender(null, project); await refreshWorkbenchReads();
  await act(async () => { identify(fixtureIdentity(291)); await pending; });
  view.rerender(<Probe />, project);
  const request: ContinuationRequest = { ...fixture.session, action: { actionId: fixtureIdentity(291), projectId: fixture.session.projectId,
    sourceAttemptId: target.attemptId, unitId: fixture.detail.recovery.units[0].unitId, kind: "resume-undispatched",
    expectedCancellationRevision: "0", itemIds: fixture.detail.recovery.units[0].remainingItemIds } };
  expect(owner.activity).toMatchObject({ phase: "recorded", continuationRequest: request, continuation: continuationReceipt(request) });
  expect(owner.activity?.intent.unit.scopes[0].id).toBe("Sample A");
  expect(Object.isFrozen(owner.activity?.continuationRequest?.action.itemIds)).toBe(true);
  expect(calls("read_execution_task_view")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("continue_execution").map(([, payload]) => payload.request)).toEqual([request]);
  expect(calls("cancel_execution_task")).toHaveLength(0); expect(calls("recover_execution")).toHaveLength(0);
  expect(owner.unresolved()).toBe(false);
});

it.each(["retired", "replaced"] as const)("stops a late typed continuation identity when the original owner is %s", async boundary => {
  const view = render(<Probe />, project); await confirmContinuation();
  let identify!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? new Promise(resolve => { identify = resolve; }) : Promise.reject(new Error(command)));
  const originalOwner = owner;
  let pending!: Promise<void>; act(() => { pending = originalOwner.submit(); });
  const captured = originalOwner.currentActivity();
  if (boundary === "retired") act(() => sessionReads.retire());
  else view.rerender(<Probe />, { ...project, sessionToken: "replacement-session" });
  await act(async () => { identify(fixtureIdentity(292)); await pending; await originalOwner.submit(); await originalOwner.retryContinuation(); });
  expect(originalOwner.currentActivity()).toBe(captured);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("continue_execution")).toHaveLength(0);
  expect(calls("recover_execution")).toHaveLength(0);
  if (boundary === "replaced") expect(owner.activity).toBeNull();
});

it.each(["task", "project", "operation", "revision"] as const)("rejects invalid continuation %s evidence before identity allocation", async field => {
  render(<Probe />, project);
  const task = { ...fixture.task, cancellationRevision: "0" };
  if (field === "task") task.taskId = fixtureIdentity(293);
  if (field === "project") task.projectId = fixtureIdentity(294);
  if (field === "operation") task.operation = "another-operation";
  if (field === "revision") task.cancellationRevision = "01";
  invoke.mockResolvedValueOnce(task);
  const value = continuationDetail();
  await act(async () => { await owner.begin(value, value.recovery.units[0], "resume-undispatched", 0); await owner.submit(); });
  expect(owner.activity?.phase).toBe("rejected");
  expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("continue_execution")).toHaveLength(0);
});

it("requires exact absence after every uncertain continuation and never refreshes the original cancellation basis", async () => {
  const view = render(<Probe />, project); await confirmContinuation();
  invoke.mockResolvedValueOnce(fixtureIdentity(295)).mockRejectedValueOnce(new Error("First continuation ACK lost"));
  await act(async () => { await owner.submit(); });
  const request = owner.activity!.continuationRequest!;
  invoke.mockResolvedValueOnce({ ...continuationReceipt(request), operation: "another-operation" });
  await act(async () => { await owner.checkContinuation(); await owner.retryContinuation(); });
  expect(owner.activity).toMatchObject({ phase: "unknown", retryAllowed: false, uncertain: true, continuationRequest: request });
  expect(calls("continue_execution")).toHaveLength(1);
  invoke.mockResolvedValueOnce(null); await act(async () => { await owner.checkContinuation(); });
  expect(owner.activity?.retryAllowed).toBe(true);
  view.rerender(null, project); view.rerender(<Probe />, project);
  invoke.mockRejectedValueOnce({ code: "cancelled", outcome: "rejected", stage: "execution-recover", recoveryRequired: false, reason: "continuation-cancellation-basis" });
  await act(async () => { await owner.retryContinuation(); await owner.retryContinuation(); owner.dismiss(); });
  expect(owner.activity).toMatchObject({ phase: "unknown", retryAllowed: false, uncertain: true, continuationRequest: request });
  invoke.mockResolvedValueOnce(null); await act(async () => { await owner.checkContinuation(); });
  invoke.mockRejectedValueOnce(new Error("Second continuation ACK lost"));
  await act(async () => { await owner.retryContinuation(); await owner.retryContinuation(); });
  expect(owner.activity?.retryAllowed).toBe(false); expect(owner.unresolved()).toBe(true);
  invoke.mockResolvedValueOnce(continuationReceipt(request)); await act(async () => { await owner.checkContinuation(); });
  expect(owner.activity).toMatchObject({ phase: "recorded", continuationRequest: request, continuation: continuationReceipt(request) });
  expect(calls("continue_execution").map(([, payload]) => payload.request)).toEqual([request, request, request]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("read_execution_task_view")).toHaveLength(1);
  expect(calls("read_execution_continuation").map(([, payload]) => payload.request)).toEqual(Array(4).fill({ ...fixture.session, actionId: request.action.actionId }));
});

it.each(["source-import", "translation-import", "ai-translation", "arena-translation"])("keeps %s adoption on its dedicated confirmation route", async operation => {
  render(<Probe />, project); installApplication();
  const value = applicationDetail(); value.operation = operation;
  await act(async () => { await owner.begin(value, value.recovery.units[0], "adopt-result", 0); await owner.submit(); });
  expect(owner.activity).toBeNull(); expect(invoke).not.toHaveBeenCalled();
});

function spanningDetail() {
  const value = applicationDetail(), first = structuredClone(value.items[0]);
  const items = Array.from({ length: 101 }, (_, index) => ({ ...structuredClone(first),
    status: { ...first.status, itemId: index === 0 ? first.status.itemId : fixtureIdentity(400 + index) },
    resultId: index === 0 ? first.resultId : fixtureIdentity(600 + index),
    scope: { ...first.scope, id: index === 0 ? first.scope.id : `Item ${index}` } }));
  const unit = { ...structuredClone(value.recovery.units[0]), itemIds: [items[0].status.itemId, items[100].status.itemId],
    scopes: [items[0].scope, items[100].scope], resultIds: [items[100].resultId!, items[0].resultId!] };
  const page = (offset: number): AttemptDetail => ({ ...structuredClone(value), progress: { ...value.progress, total: 101, succeeded: 101 },
    items: items.slice(offset, offset + 100), nextOffset: offset === 0 ? 100 : null,
    recovery: { attemptId: value.attemptId, units: [structuredClone(unit)] } });
  return { page, items, unit };
}

it("captures a complete cross-page continuation group and preserves its original remaining-item order on replay", async () => {
  render(<Probe />, project);
  const { page: applicationPage, unit: applicationUnit } = spanningDetail();
  const unit = { ...applicationUnit, actions: ["resume-undispatched" as const], resultIds: [], remainingItemIds: [...applicationUnit.itemIds].reverse() };
  const page = (offset: number): AttemptDetail => {
    const value = applicationPage(offset);
    return { ...value, progress: { ...value.progress, succeeded: 0, queued: 101 },
      items: value.items.map(item => ({ ...item, resultId: null, status: { ...item.status, execution: "queued" as const, validation: "absent" as const } })),
      recovery: { ...value.recovery, units: [unit] } };
  };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: { offset?: number } }) => command === "read_execution_attempt"
    ? Promise.resolve(page(payload.request.offset!)) : original(command, payload));
  await confirmContinuation(page(100), 100);
  expect(owner.activity?.intent.items.map(item => item.scope.id)).toEqual(["Sample A", "Item 100"]);
  expect(calls("read_execution_attempt").map(([, payload]) => payload.request)).toEqual([{ ...fixture.session, attemptId: target.attemptId, offset: 0, limit: 100 }]);
  invoke.mockResolvedValueOnce(fixtureIdentity(296)).mockRejectedValueOnce(new Error("Continuation ACK lost"));
  await act(async () => { await owner.submit(); });
  const request = owner.activity!.continuationRequest!;
  expect(request.action.itemIds).toEqual(unit.remainingItemIds);
  invoke.mockResolvedValueOnce(null); await act(async () => { await owner.checkContinuation(); });
  invoke.mockResolvedValueOnce(continuationReceipt(request)); await act(async () => { await owner.retryContinuation(); });
  expect(owner.activity?.phase).toBe("recorded");
  expect(calls("continue_execution").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("read_execution_task_view")).toHaveLength(1);
});

it("captures a complete cross-page unit from a later page and preserves reverse-order requests on every replay", async () => {
  render(<Probe />, project); installApplication();
  const { page, unit } = spanningDetail();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: { offset?: number } }) => command === "read_execution_attempt"
    ? Promise.resolve(page(payload.request.offset!)) : original(command, payload));
  await act(async () => { await owner.begin(page(100), unit, "adopt-result", 100); });
  expect(owner.activity?.intent.items.map(item => item.scope.id)).toEqual(["Sample A", "Item 100"]);
  expect(calls("read_execution_attempt").map(([, payload]) => payload.request)).toEqual([{ ...fixture.session, attemptId: target.attemptId, offset: 0, limit: 100 }]);
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockResolvedValueOnce({ ...generalAction(), resultIds: [...unit.resultIds].sort() }).mockRejectedValueOnce(new Error("Lost adoption ACK"));
  await act(async () => { await owner.submit(); });
  const prepare = { ...fixture.prepare, resultIds: [...unit.resultIds] };
  expect(owner.activity?.prepare).toEqual(prepare);
  invoke.mockResolvedValueOnce(null); await act(async () => { await owner.checkAdoption(); });
  invoke.mockResolvedValueOnce({ ...generalAction(), resultIds: [...unit.resultIds].sort() }).mockResolvedValueOnce(fixture.receipt);
  await act(async () => { await owner.retryAdoption(); });
  expect(owner.activity?.phase).toBe("recorded");
  expect(calls("prepare_execution_adoption").map(([, payload]) => payload.request)).toEqual([prepare, prepare]);
  expect(calls("adopt_execution").map(([, payload]) => payload.request)).toEqual([fixture.adopt, fixture.adopt]);
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["duplicate", "missing", "offset", "scope"] as const)("rejects %s cross-page evidence without allocating an identity", async problem => {
  render(<Probe />, project); installApplication(); const { page, unit } = spanningDetail();
  const first = page(0), last = page(100);
  if (problem === "duplicate") last.items[0] = structuredClone(first.items[0]);
  if (problem === "missing") last.items[0].status.itemId = fixtureIdentity(999);
  if (problem === "offset") first.nextOffset = 99;
  if (problem === "scope") last.items[0].scope.id = "Another scope";
  invoke.mockResolvedValueOnce(first);
  await act(async () => { await owner.begin(last, unit, "adopt-result", 100); });
  expect(owner.activity?.phase).toBe("rejected");
  expect(calls("create_execution_identity")).toHaveLength(0);
  expect(calls("prepare_execution_adoption")).toHaveLength(0);
});

it("releases the shared write reservation only after a verified first rejection", async () => {
  render(<Probe />, project); installApplication(); await confirmApplication();
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce({ code: "busy", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false });
  await act(async () => { await owner.submit(); });
  expect(owner.activity?.phase).toBe("rejected"); expect(owner.unresolved()).toBe(false);
  let token: symbol | null = null; act(() => { token = translation.reserveMutation(); });
  expect(token).not.toBeNull(); act(() => { if (token) translation.releaseMutation(token); });
});
afterEach(cleanup);

it("reserves synchronously across consumers and keeps different tasks independent", async () => {
  render(<Probe />, project);
  let identify!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" && calls(command).length === 1
    ? new Promise(resolve => { identify = resolve; }) : original(command, payload));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = owner.cancel(target);
    void owner.cancel({ ...target, origin: "ai" });
    void owner.cancel({ ...target, attemptId: fixtureIdentity(110), origin: "arena" });
    second = owner.cancel({ ...target, taskId: fixtureIdentity(111), origin: "source" });
  });
  expect(calls("create_execution_identity")).toHaveLength(2);
  await act(async () => { await second; identify(fixtureIdentity(112)); await first; });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request.taskId)).toEqual([fixtureIdentity(111), target.taskId]);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "1", request: { taskId: target.taskId, requestId: fixtureIdentity(112) } });
});

it("continues the captured cancellation when the consumer unmounts during identity preparation", async () => {
  const view = render(<Probe />, project);
  let identify!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? new Promise(resolve => { identify = resolve; }) : Promise.resolve("7"));
  let pending!: Promise<void>;
  act(() => { pending = owner.cancel(target); });
  view.rerender(null, project);
  await act(async () => { identify(fixtureIdentity(113)); await pending; });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(calls("cancel_execution_task")[0][1].request).toEqual({ ...fixture.session, taskId: target.taskId, requestId: fixtureIdentity(113) });
  view.rerender(<Probe />, project);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "7" });
  expect(screen.getByText(/Cancellation request recorded/)).toBeInTheDocument();
});
it("captures a mutable caller's original target before identity and protects its original request", async () => {
  render(<Probe />, project);
  let identify!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? new Promise(resolve => { identify = resolve; })
    : Promise.reject(new Error("Disconnected")));
  const projection = { ...target };
  let pending!: Promise<void>;
  act(() => { pending = owner.cancel(projection); });
  projection.taskId = fixtureIdentity(130); projection.attemptId = fixtureIdentity(131);
  await act(async () => { identify(fixtureIdentity(132)); await pending; });
  const original = owner.current(target.taskId)?.request;
  expect(original).toMatchObject({ taskId: target.taskId, requestId: fixtureIdentity(132) });
  expect(Object.isFrozen(original)).toBe(true);
  expect(owner.current(projection.taskId)).toBeUndefined();
  invoke.mockResolvedValueOnce("4");
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([original, original]);
});

it("retains unknown original identity across remount, new attempts and pure reads", async () => {
  const view = render(<Probe />, project);
  let replay = false;
  invoke.mockImplementation(async command => {
    if (command === "create_execution_identity") return fixtureIdentity(114);
    if (command === "cancel_execution_task") { if (replay) return "8"; throw new Error("Transport disconnected"); }
    if (command === "read_execution_task") return [{ ...fixture.summary, attemptId: fixtureIdentity(115), sequence: "2" }];
    throw new Error(command);
  });
  await act(async () => { await owner.cancel(target); });
  const request = owner.current(target.taskId)?.request;
  expect(owner.current(target.taskId)?.phase).toBe("unknown");
  view.rerender(null, project);
  await refreshWorkbenchReads();
  view.rerender(<><Probe /><ResumedAttemptProbe /></>, project);
  await screen.findByText(fixtureIdentity(115));
  expect(calls("read_execution_task")[0][1].request).toEqual({ ...fixture.session, taskId: target.taskId, after: "0", limit: 50 });
  await act(async () => { await owner.cancel({ ...target, attemptId: fixtureIdentity(115), origin: "arena" }); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(owner.current(target.taskId)?.request).toEqual(request);
  expect(screen.getByRole("button", { name: "Retry the original cancellation" })).toBeEnabled();
  replay = true;
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([request, request]);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "8", target });
});

it("settles a late checked ACK after consumer unmount without depending on later reads", async () => {
  const view = render(<Probe />, project);
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(command => command === "create_execution_identity" ? Promise.resolve(fixtureIdentity(116))
    : new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = owner.cancel(target); await Promise.resolve(); });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  view.rerender(null, project);
  await act(async () => { finish("9007199254740993"); await pending; });
  invoke.mockRejectedValue(new Error("Later task read failed"));
  view.rerender(<><Probe /><FailedReadProbe /></>, project);
  await screen.findByText("Read failed");
  expect(calls("execution_status")).toHaveLength(1);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "9007199254740993" });
  expect(screen.queryByRole("button", { name: "Retry the original cancellation" })).not.toBeInTheDocument();
});

it("keeps a zero acknowledgement unknown until an exact explicit replay returns a positive revision", async () => {
  render(<Probe />, project);
  invoke.mockResolvedValueOnce(fixtureIdentity(117)).mockResolvedValueOnce("0");
  await act(async () => { await owner.cancel(target); });
  expect(owner.current(target.taskId)?.phase).toBe("unknown");
  const original = owner.current(target.taskId)?.request;
  invoke.mockResolvedValueOnce("2");
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "2" });
});
it("shows original cancellation recovery and checked confirmation in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");
  render(<Probe />, project);
  invoke.mockResolvedValueOnce(fixtureIdentity(133)).mockResolvedValueOnce("0");
  await act(async () => { await owner.cancel(target); });
  expect(screen.getByRole("button", { name: "重试原取消请求" })).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveFocus();
  expect(screen.getByText(/仅凭任务进度无法确认这个请求/)).toBeInTheDocument();
  invoke.mockResolvedValueOnce("4");
  await act(async () => { await owner.retry(target.taskId); });
  expect(screen.getByText(/取消请求已记录/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试原取消请求" })).not.toBeInTheDocument();
});

it("releases only a verified rejection and preserves it through read invalidation", async () => {
  render(<Probe />, project);
  const error = { code: "busy", outcome: "rejected", stage: "execution-cancel", recoveryRequired: false };
  invoke.mockResolvedValueOnce(fixtureIdentity(118)).mockRejectedValueOnce(error);
  await act(async () => { await owner.cancel(target); });
  expect(owner.current(target.taskId)).toMatchObject({ phase: "rejected", failure: error });
  await refreshWorkbenchReads();
  expect(owner.current(target.taskId)?.phase).toBe("rejected");
  await act(async () => { await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  await act(async () => { await owner.cancel(target); });
  expect(calls("create_execution_identity")).toHaveLength(2);
  expect(calls("cancel_execution_task")).toHaveLength(2);
});
it("retains original uncertainty when a replay is formally rejected and blocks fresh requests until a positive ACK", async () => {
  render(<Probe />, project);
  invoke.mockResolvedValueOnce(fixtureIdentity(134)).mockRejectedValueOnce(new Error("Disconnected after recording"));
  await act(async () => { await owner.cancel(target); });
  const original = owner.current(target.taskId)?.request;
  expect(original).toEqual({ ...fixture.session, taskId: target.taskId, requestId: fixtureIdentity(134) });
  expect(owner.current(target.taskId)?.phase).toBe("unknown");
  const rejectedReplay = { code: "busy", outcome: "rejected", stage: "execution-cancel", recoveryRequired: false };
  invoke.mockRejectedValueOnce(rejectedReplay);
  await act(async () => { await owner.retry(target.taskId); });
  expect(owner.current(target.taskId)).toMatchObject({ phase: "unknown", failure: rejectedReplay });
  expect(owner.current(target.taskId)?.request).toBe(original);
  expect(owner.unresolved()).toBe(true);
  expect(screen.getByRole("button", { name: "Retry the original cancellation" })).toBeEnabled();
  const resumed = { ...target, attemptId: fixtureIdentity(135) };
  expect(owner.canCancel(target)).toBe(false); expect(owner.canCancel(resumed)).toBe(false);
  await act(async () => { await owner.cancel(target); await owner.cancel(resumed); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("cancel_execution_task")).toHaveLength(2);
  invoke.mockResolvedValueOnce("6");
  await act(async () => { await owner.retry(target.taskId); });
  expect(owner.current(target.taskId)).toMatchObject({ phase: "recorded", revision: "6", target, request: original });
  expect(owner.unresolved()).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("cancel_execution_task").map(([, payload]) => payload.request)).toEqual([original, original, original]);
});

it("deduplicates recorded clicks for the captured attempt and creates a fresh request only for a new attempt", async () => {
  render(<Probe />, project);
  await act(async () => { await owner.cancel(target); await owner.cancel(target); await owner.retry(target.taskId); });
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(calls("create_execution_identity")).toHaveLength(1);
  await act(async () => { await owner.cancel({ ...target, attemptId: fixtureIdentity(119) }); });
  expect(calls("cancel_execution_task")).toHaveLength(2);
  const requests = calls("cancel_execution_task").map(([, payload]) => payload.request);
  expect(requests[0].taskId).toBe(requests[1].taskId);
  expect(requests[0].requestId).not.toBe(requests[1].requestId);
  expect(requests.every(request => !Object.hasOwn(request, "attemptId"))).toBe(true);
});
it("keeps the existing Tasks project-leave guard active for another workspace's unresolved cancellation", async () => {
  const view = render(<Probe />, project), ref = createRef<TasksHandle>();
  invoke.mockResolvedValueOnce(fixtureIdentity(123)).mockRejectedValueOnce(new Error("Disconnected"));
  await act(async () => { await owner.cancel({ ...target, origin: "ai" }); });
  invoke.mockImplementation(async command => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [];
    if (command === "cancel_execution_task") return "5";
    throw new Error(command);
  });
  view.rerender(<ExecutionTasks ref={ref} project={project} disabled={false} />);
  await act(async () => { expect(await ref.current!.allowLeave()).toBe(false); });
  expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry the original cancellation" })).toBeEnabled();
  await act(async () => { await owner.retry(target.taskId); });
  expect(await ref.current!.allowLeave()).toBe(true);
});

it("checks original project, session, task, attempt and explicit business proof before dispatch", async () => {
  const view = render(<Probe />, project);
  await act(async () => {
    await owner.cancel({ ...target, taskId: "bad-task" });
    await owner.cancel({ ...target, attemptId: "bad-attempt" });
    await owner.cancel(target, () => false);
  });
  expect(invoke).not.toHaveBeenCalled();
  let identify!: (value: unknown) => void, proof = true;
  invoke.mockImplementation(() => new Promise(resolve => { identify = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = owner.cancel(target, () => proof); });
  proof = false;
  await act(async () => { identify(fixtureIdentity(120)); await pending; });
  expect(calls("cancel_execution_task")).toHaveLength(0);
  expect(owner.current(target.taskId)).toBeUndefined();
  view.rerender(<Probe />, { ...project, metadata: { ...project.metadata, projectId: "bad-project" } });
  await act(async () => { await owner.cancel(target); });
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["identity", "ack"] as const)("ignores late %s after the actual session owner is destroyed", async stage => {
  const view = render(<Probe />, project);
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(command => stage === "identity" || command === "cancel_execution_task"
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(fixtureIdentity(121)));
  let pending!: Promise<void>;
  await act(async () => { pending = owner.cancel(target); await Promise.resolve(); });
  const previous = owner;
  view.rerender(<Probe />, { ...project, sessionToken: "replacement-session" });
  await act(async () => { finish(stage === "identity" ? fixtureIdentity(122) : "3"); await pending; });
  expect(calls("cancel_execution_task")).toHaveLength(stage === "identity" ? 0 : 1);
  expect(owner.current(target.taskId)).toBeUndefined();
  expect(previous).not.toBe(owner);
  expect(owner.unresolved()).toBe(false);
});


it("routes cancellation recovery using the original origin and request through the current command bridge", async () => {
  const available = vi.fn(() => false), dispatch = vi.fn();
  function CommandFeedbackProbe() {
    const value = useExecutionTaskSession();
    useLayoutEffect(() => { owner = value; });
    return <TaskCancellationFeedback origin="ai" retryCommand={{ available, dispatch }} />;
  }
  const view = render(<CommandFeedbackProbe />, project);
  const original = { ...target, origin: "source" as const };
  // Preserve a known identity before the uncertain native cancellation.
  invoke.mockImplementation(command => command === "create_execution_identity" ? Promise.resolve(fixtureIdentity(899))
    : command === "cancel_execution_task" ? Promise.reject(new Error("Transport disconnected")) : Promise.reject(new Error(command)));
  await act(async () => { await owner.cancel(original); });
  const value = owner.current(original.taskId);
  expect(value?.phase).toBe("unknown");
  if (!value?.request) throw new Error("Original cancellation request is missing");
  const intent: CancellationRetryIntent = { ...original, requestId: value.request.requestId };
  expect(available).toHaveBeenCalledWith(intent);
  const button = screen.getByRole("button", { name: "Retry the original cancellation" });
  expect(button).toBeDisabled();
  await act(async () => { button.click(); });
  expect(dispatch).not.toHaveBeenCalled();
  available.mockReturnValue(true); view.rerender(<CommandFeedbackProbe />, project);
  expect(button).toBeEnabled(); await act(async () => { button.click(); });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(intent);
  expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(owner.current(original.taskId)?.request).toBe(value.request);
});

it("binds the full-page consumer capture to its latest exact Query and releases a removed failed replacement before confirmation", async () => {
  render(<Probe />, project);
  const base = applicationDetail(), items = Array.from({length:101},(_,index) => ({ ...structuredClone(base.items[0]), resultId:fixtureIdentity(1100+index),
    status:{...base.items[0].status,itemId:fixtureIdentity(900+index)},scope:{...base.items[0].scope,id:`Scope ${index}`} }));
  const unit = {...structuredClone(base.recovery.units[0]),itemIds:items.map(item=>item.status.itemId),scopes:items.map(item=>item.scope),resultIds:items.map(item=>item.resultId!)};
  const detail:AttemptDetail={...base,items:items.slice(0,100),nextOffset:100,progress:{...base.progress,total:101,succeeded:101},recovery:{...base.recovery,units:[unit]}};
  const key=["task-capture-proof",detail.taskId,detail.attemptId,0],fullKey=sessionReads.key(key);
  sessionReads.client.setQueryData(fullKey,{detail});
  let resolve!: (page:AttemptDetail)=>void;
  const response=new Promise<AttemptDetail>(done=>{resolve=done;});
  invoke.mockImplementation(async(command:string)=>{if(command==="read_execution_attempt")return response;throw new Error(command);});
  const subscribe=sessionReads.client.getQueryCache().subscribe,disposed=vi.fn();
  vi.spyOn(sessionReads.client.getQueryCache(),"subscribe").mockImplementation(listener=>{const stop=subscribe(listener);return()=>{disposed();stop();};});
  let pending!:Promise<void>;
  act(()=>{pending=owner.beginFromQuery(key,detail,unit,"adopt-result",0);void owner.beginFromQuery(key,detail,unit,"adopt-result",0);});
  expect(owner.currentActivity()?.phase).toBe("capturing");expect(calls("read_execution_attempt")).toHaveLength(1);
  act(()=>{
    sessionReads.client.removeQueries({queryKey:fullKey,exact:true});sessionReads.client.setQueryData(fullKey,{detail});
    sessionReads.client.getQueryCache().find({queryKey:fullKey,exact:true})!.setState({status:"error",error:new Error("Replacement capture read failed")});
    sessionReads.client.removeQueries({queryKey:fullKey,exact:true});
  });
  await act(async()=>{resolve({...detail,items:items.slice(100),nextOffset:null});await pending;});
  expect(owner.currentActivity()?.phase).toBe("rejected");expect(owner.canSubmit()).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(0);expect(disposed).toHaveBeenCalledTimes(1);
});
