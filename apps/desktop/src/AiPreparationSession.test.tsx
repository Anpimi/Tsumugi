import { useLayoutEffect } from "react";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/aiCommands.contract.json";
import execution from "../test/fixtures/executionCommands.contract.json";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import type { AiConfig, AiItem, AiPrepared, AiView } from "./aiCommands";
import type { AdoptionAction, PrepareRequest, Receipt } from "./executionCommands";
import { isCommandError, type CommandError, type ProjectView } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { validateResponsePrepared, validateResponseView } from "./generated/ai.validators";
import { aiAttempt, aiViewFixture } from "./testSupport/aiFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "ai-owner-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(500), displayName: "AI owner", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let owner: ReturnType<typeof useAiPreparation>;
let reads: ReturnType<typeof useSessionReads>;
let prepared: AiPrepared;
let action: AdoptionAction;
let items: AiItem[];
function Probe() {
  const value = useAiPreparation(), sessionReads = useSessionReads();
  useLayoutEffect(() => { owner = value; reads = sessionReads; });
  return null;
}
function Harness({ project: current = project, mounted = true }: { project?: ProjectView; mounted?: boolean }) {
  return <AiPreparationSession initialLocale={current.metadata.targetLocales[0] ?? ""} targetLocales={current.metadata.targetLocales}>
    {mounted ? <Probe /> : null}
  </AiPreparationSession>;
}
function ResultRead() {
  const value = useAiPreparation();
  const query = useSessionQuery({ key: ["aiCommands", value.attempt], scopes: ["execution"], enabled: !!value.attempt,
    read: () => value.readView(value.attempt!) });
  return <output aria-label="Generation read">{query.error ? "Result read failed" : query.data ? "Result read confirmed" : "Loading"}</output>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function payloads(command: string) { return calls(command).map(([, payload]) => payload.request); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function actionFor(request: PrepareRequest): AdoptionAction {
  return { ...execution.action, projectId: request.projectId, attemptId: request.attemptId, unitId: request.unitId, actionId: request.actionId,
    operation: "ai-translation", parameters: null, resultIds: [...request.resultIds] };
}
function startReceipt() { return {projectId:project.metadata.projectId,attemptId:prepared.attemptId,taskId:viewFor().detail.taskId,digest:prepared.preview.digest}; }
function receiptFor(value: AdoptionAction): Receipt {
  return { ...execution.receipt, projectId: value.projectId, attemptId: value.attemptId, unitId: value.unitId, actionId: value.actionId,
    changes: [{ kind: "translation-revision", id: fixtureIdentity(950), revision: "1" }] };
}
function viewFor(value = prepared): AiView {
  const view = aiViewFixture(value.preview.items[0], value.preview.config);
  view.detail.attemptId = value.attemptId; view.detail.recovery.attemptId = value.attemptId;
  const firstRow = view.rows[0], firstItem = view.detail.items[0], firstUnit = view.detail.recovery.units[0];
  value.preview.items.slice(1).forEach((item, index) => {
    const itemId = fixtureIdentity(960 + index), resultId = fixtureIdentity(970 + index), unitId = fixtureIdentity(980 + index);
    const scope = { ...firstItem.scope, id: item.unitId, locale: item.targetLocale };
    view.rows.push({ ...firstRow, itemId, resultId, item, output: { ...firstRow.output!, unitId: item.unitId, targetLocale: item.targetLocale } });
    view.detail.items.push({ ...firstItem, status: { ...firstItem.status, itemId }, resultId, scope });
    view.detail.recovery.units.push({ ...firstUnit, unitId, itemIds: [itemId], remainingItemIds: [itemId], resultIds: [resultId], scopes: [scope] });
  });
  view.detail.progress.total = value.preview.items.length; view.detail.progress.succeeded = value.preview.items.length;
  return view;
}
const busyRejected: CommandError = { code: "busy", outcome: "rejected", stage: "execution-adopt", reason: "execution-storage", recoveryRequired: false };
const startRejected: CommandError = { ...busyRejected, stage: "execution-read" };
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  expect(isCommandError(busyRejected)).toBe(true); expect(isCommandError(startRejected)).toBe(true);
  const value: unknown = structuredClone(fixture.responses.prepared);
  if (!validateResponsePrepared(value)) throw new Error("Invalid prepared fixture");
  prepared = value; prepared.attemptId = aiAttempt; items = prepared.preview.items;
  let identity = 910;
  let checkedWrites = -1, checkedStarts = -1;
  invoke.mockReset(); invoke.mockImplementation(async (command: string, payload: { request: PrepareRequest & { config: AiConfig; unitIds: string[] } }) => {
    if (command === "preview_ai_translation") {
      prepared = { attemptId: aiAttempt, preview: { ...prepared.preview, config: payload.request.config,
        items: payload.request.unitIds.map(id => items.find(item => item.unitId === id)!) } };
      return prepared;
    }
    if (command === "start_ai_translation") return prepared.attemptId;
    if (command === "read_ai_start_action") {
      const writes = calls("start_ai_translation").length;
      if (checkedStarts !== writes) { checkedStarts = writes; throw new Error("Automatic lookup unavailable"); }
      return startReceipt();
    }
    if (command === "read_ai_translation") return viewFor();
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_execution_adoption") { action = actionFor(payload.request); return action; }
    if (command === "adopt_execution" || command === "read_execution_receipt") return receiptFor(action);
    if (command === "read_execution_adoption_action") {
      const writes = calls("prepare_execution_adoption").length + calls("adopt_execution").length;
      if (checkedWrites !== writes) { checkedWrites = writes; throw new Error("Automatic lookup unavailable"); }
      return { action, receipt: receiptFor(action) };
    }
    throw new Error(command);
  });
});
afterEach(cleanup);
async function prepare() {
  act(() => { owner.setConfig(prepared.preview.config); owner.setSelected(items.map(item => item.unitId)); });
  await act(async () => { await owner.preview(); });
  act(() => { owner.setConsent(true); });
}
async function start() { await prepare(); await act(async () => { await owner.start(); }); return viewFor(); }

it("reserves generation synchronously across callers before dispatching the captured preview", async () => {
  render(<Harness />, project); await prepare();
  const response = deferred<string>(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_ai_translation" ? response.promise : original(command, payload));
  const capture = owner.current().prepared!;
  let first!: Promise<void>;
  act(() => { first = owner.start(); void owner.start(); void owner.preview(); });
  expect(owner.reserved()).toBe(true); expect(calls("start_ai_translation")).toHaveLength(1);
  expect(payloads("start_ai_translation")).toEqual([{ sessionToken: project.sessionToken, projectId: project.metadata.projectId,
    attemptId: capture.attemptId, digest: capture.preview.digest, confirmed: true }]);
  await act(async () => { response.resolve(capture.attemptId); await first; });
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(capture.attemptId); expect(owner.notice).toBe("started");
});

it("keeps the original generation acknowledgement after its consumer unmounts", async () => {
  const rendered = render(<Harness />, project); await prepare();
  const response = deferred<string>(); invoke.mockImplementation(command => command === "start_ai_translation" ? response.promise : Promise.reject(new Error(command)));
  let pending!: Promise<void>; act(() => { pending = owner.start(); });
  rendered.rerender(<Harness mounted={false} />, project);
  await act(async () => { response.resolve(aiAttempt); await pending; });
  rendered.rerender(<Harness />, project);
  expect(owner.attempt).toBe(aiAttempt); expect(owner.pendingStart).toBeNull(); expect(owner.dirty).toBe(false);
  expect(calls("start_ai_translation")).toHaveLength(1);
});

it("continues a captured candidate through consumer unmount during identity and receipt waits", async () => {
  const rendered = render(<Harness />, project), view = await start();
  const identify = deferred<string>(), receipt = deferred<Receipt>(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? identify.promise
    : command === "adopt_execution" ? receipt.promise : original(command, payload));
  const originalResult = view.rows[0].resultId!, originalUnit = view.detail.recovery.units[0].unitId;
  let pending!: Promise<void>;
  act(() => { pending = owner.adopt(view, originalResult); void owner.adopt(view, originalResult); void owner.start(); });
  expect(calls("create_execution_identity")).toHaveLength(1);
  rendered.rerender(<Harness mounted={false} />, project);
  view.rows[0].resultId = fixtureIdentity(999); view.detail.recovery.units[0].unitId = fixtureIdentity(998);
  await act(async () => { identify.resolve(fixtureIdentity(912)); await Promise.resolve(); });
  expect(payloads("prepare_execution_adoption")).toEqual([{ sessionToken: project.sessionToken, projectId: project.metadata.projectId,
    attemptId: aiAttempt, actionId: fixtureIdentity(912), unitId: originalUnit, resultIds: [originalResult] }]);
  expect(calls("adopt_execution")).toHaveLength(1);
  await act(async () => { receipt.resolve(receiptFor(action)); await pending; });
  rendered.rerender(<Harness />, project);
  expect(owner.saved[originalResult]).toEqual(receiptFor(action)); expect(owner.pendingAdopt).toBeNull();
  expect(Object.isFrozen(owner.saved[originalResult])).toBe(true);
});

it.each(["identity", "prepare", "adopt"] as const)("stops late %s continuation after the project owner is destroyed", async phase => {
  const rendered = render(<Harness />, project), view = await start();
  const response = deferred<unknown>(), original = invoke.getMockImplementation()!;
  const command = phase === "identity" ? "create_execution_identity" : phase === "prepare" ? "prepare_execution_adoption" : "adopt_execution";
  invoke.mockImplementation((name: string, payload: { request: PrepareRequest }) => {
    if (name !== command) return original(name, payload);
    if (phase === "prepare") action = actionFor(payload.request);
    return response.promise;
  });
  let pending!: Promise<void>; act(() => { pending = owner.adopt(view, view.rows[0].resultId!); });
  await act(async () => { await Promise.resolve(); });
  const retired = owner;
  const replacement = { ...project, sessionToken: "replacement" };
  rendered.rerender(<Harness project={replacement} />, replacement);
  await act(async () => { response.resolve(phase === "identity" ? fixtureIdentity(920) : phase === "prepare" ? action : receiptFor(action)); await pending; });
  expect(owner.attempt).toBeNull(); expect(owner.pendingAdopt).toBeNull(); expect(owner.saved).toEqual({});
  expect(calls("adopt_execution")).toHaveLength(phase === "adopt" ? 1 : 0);
  if (phase === "identity") expect(calls("prepare_execution_adoption")).toHaveLength(0);
  await act(async () => { await retired.adopt(view, view.rows[0].resultId!); });
  expect(calls("create_execution_identity")).toHaveLength(1);
});

it("does not write a late generation acknowledgement into a replacement project session", async () => {
  const rendered = render(<Harness />, project); await prepare(); const response = deferred<string>();
  invoke.mockImplementation(() => response.promise);
  let pending!: Promise<void>; act(() => { pending = owner.start(); });
  const replacement = { ...project, sessionToken: "replacement" };
  rendered.rerender(<Harness project={replacement} />, replacement);
  await act(async () => { response.resolve(aiAttempt); await pending; });
  expect(owner.attempt).toBeNull(); expect(owner.pendingStart).toBeNull(); expect(owner.dirty).toBe(false);
});

it("preserves newer complete selections and settings instead of restoring a late preview", async () => {
  render(<Harness />, project);
  const response = deferred<AiPrepared>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "preview_ai_translation" ? response.promise : original(command, payload));
  act(() => { owner.setConfig(prepared.preview.config); owner.setSelected([items[0].unitId]); });
  let pending!: Promise<void>; act(() => { pending = owner.preview(); });
  const newer = fixtureIdentity(930);
  act(() => { owner.setConfig(before => ({ ...before, model: "newer-model" })); owner.setSelected([newer]); });
  await act(async () => { response.resolve(prepared); await pending; });
  expect(owner.config.model).toBe("newer-model"); expect(owner.selected).toEqual([newer]);
  expect(owner.prepared).toBeNull(); expect(owner.consent).toBe(false); expect(owner.dirty).toBe(true);
});

it.each(["start", "adopt"] as const)("keeps edits B when original %s A is acknowledged", async phase => {
  render(<Harness />, project);
  const view = phase === "adopt" ? await start() : (await prepare(), viewFor());
  const response = deferred<unknown>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === (phase === "start" ? "start_ai_translation" : "adopt_execution")
    ? response.promise : original(command, payload));
  let pending!: Promise<void>; act(() => { pending = phase === "start" ? owner.start() : owner.adopt(view, view.rows[0].resultId!); });
  await act(async () => { await Promise.resolve(); });
  act(() => { owner.setConfig(before => ({ ...before, model: "model-B" })); owner.setPresetName("local"); owner.setSelected([fixtureIdentity(931)]); });
  await act(async () => { response.resolve(phase === "start" ? aiAttempt : receiptFor(action)); await pending; });
  expect(owner.config.model).toBe("model-B"); expect(owner.presetName).toBe("local"); expect(owner.selected).toEqual([fixtureIdentity(931)]);
  expect(owner.dirty).toBe(true); expect(owner.notice).toBe("newer"); expect(owner.pendingStart).toBeNull(); expect(owner.pendingAdopt).toBeNull();
  if (phase === "adopt") expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
});

it.each(["edit", "locale"] as const)("blocks fresh candidate dispatch when its business basis changes during identity: %s", async change => {
  const rendered = render(<Harness />, project), view = await start(); const response = deferred<string>();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "create_execution_identity" ? response.promise : original(command, payload));
  let pending!: Promise<void>; act(() => { pending = owner.adopt(view, view.rows[0].resultId!); });
  if (change === "edit") act(() => { owner.setConfig(before => ({ ...before, model: "new-basis" })); });
  else rendered.rerender(<Harness project={{ ...project, metadata: { ...project.metadata, targetLocales: [] } }} />, project);
  await act(async () => { response.resolve(fixtureIdentity(932)); await pending; });
  expect(calls("prepare_execution_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
  expect(owner.pendingAdopt).toBeNull();
});

it("keeps the prepared original action for recovery when the basis changes before adoption dispatch", async () => {
  render(<Harness />, project); const view = await start(); const response = deferred<AdoptionAction>();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: PrepareRequest }) => {
    if (command !== "prepare_execution_adoption") return original(command, payload);
    action = actionFor(payload.request); return response.promise;
  });
  let pending!: Promise<void>; act(() => { pending = owner.adopt(view, view.rows[0].resultId!); });
  await act(async () => { await Promise.resolve(); });
  act(() => { reads.invalidate(["source"]); });
  await act(async () => { response.resolve(action); await pending; });
  expect(calls("adopt_execution")).toHaveLength(0);
  expect(owner.pendingAdopt).toMatchObject({ uncertain: true, action, retryAllowed: false });
});

it.each(["projectId", "attemptId", "digest", "taskId", "extra"] as const)("refuses an unrelated immutable original-start receipt: %s", async mismatch => {
  render(<Harness />, project); await prepare(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_ai_translation" ? Promise.reject(new Error("Disconnected")) : original(command, payload));
  await act(async () => { await owner.start(); }); const request = owner.pendingStart!.request;
  const wrong: Record<string,unknown> = {...startReceipt()};
  wrong[mismatch] = mismatch === "digest" ? "wrong-digest" : mismatch === "taskId" ? "invalid" : fixtureIdentity(933);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_start_action" ? Promise.resolve(wrong) : original(command,payload));
  await act(async () => { await owner.checkStart(); await owner.retryStart(); });
  expect(owner.pendingStart).toMatchObject({request,uncertain:true,retryAllowed:false,checking:false});
  expect(owner.attempt).toBeNull(); expect(owner.reserved()).toBe(true);
  invoke.mockImplementation(original); await act(async () => { await owner.checkStart(); });
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(aiAttempt);
  expect(payloads("read_ai_start_action")).toEqual([request,request,request]);
  expect(calls("read_ai_translation")).toHaveLength(0); expect(calls("start_ai_translation")).toHaveLength(1);
});

it("keeps unknown generation after a rejected original replay and settles only the same checked attempt", async () => {
  render(<Harness />, project); await prepare(); let count = 0;
  invoke.mockImplementation(async command => {
    if (command === "start_ai_translation") { if (++count === 1) throw new Error("Disconnected"); if (count === 2) throw startRejected; return aiAttempt; }
    if (command === "read_ai_start_action") return null;
    throw new Error(command);
  });
  await act(async () => { await owner.start(); }); const request = owner.pendingStart!.request;
  await act(async () => { await owner.retryStart(); });
  expect(owner.pendingStart).toMatchObject({ request, uncertain: true });
  await act(async () => { await owner.start(); await owner.preview(); });
  expect(calls("start_ai_translation")).toHaveLength(2); expect(calls("preview_ai_translation")).toHaveLength(1);
  await act(async () => { await owner.retryStart(); });
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(aiAttempt);
  expect(payloads("start_ai_translation")).toEqual([request, request, request]); expect(calls("create_execution_identity")).toHaveLength(0);
});

it("releases a fresh rejected generation while preserving its preview and consent", async () => {
  render(<Harness />, project); await prepare(); const original = invoke.getMockImplementation()!;
  invoke.mockRejectedValueOnce(startRejected);
  await act(async () => { await owner.start(); });
  expect(owner.pendingStart).toBeNull(); expect(owner.reserved()).toBe(false); expect(owner.prepared).not.toBeNull(); expect(owner.consent).toBe(true);
  invoke.mockImplementation(original); await act(async () => { await owner.start(); });
  expect(owner.attempt).toBe(aiAttempt); expect(calls("start_ai_translation")).toHaveLength(2);
});

it("never shrinks a complete cross-page selection to a smaller prepared or recovered scope", async () => {
  render(<Harness />, project);
  const second = { ...items[0], unitId: fixtureIdentity(940), sourceRevisionId: fixtureIdentity(941), nativeKey: "second" };
  items = [items[0], second]; act(() => { owner.setConfig(prepared.preview.config); owner.setSelected(items.map(item => item.unitId)); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "preview_ai_translation" ? Promise.resolve(prepared) : original(command, payload));
  await act(async () => { await owner.preview(); });
  expect(owner.prepared).toBeNull(); expect(owner.selected).toEqual(items.map(item => item.unitId));
  invoke.mockImplementation(original); await act(async () => { await owner.preview(); }); act(() => { owner.setConsent(true); });
  expect(owner.prepared!.preview.items.map(item => item.unitId)).toEqual(owner.selected);
  invoke.mockRejectedValueOnce(new Error("Disconnected")); await act(async () => { await owner.start(); });
  const partial = viewFor(); partial.rows.pop(); partial.detail.items.pop(); partial.detail.progress.total = 1; partial.detail.progress.succeeded = 1;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_start_action" ? Promise.resolve(startReceipt()) : command === "read_ai_translation" ? Promise.resolve(partial) : original(command,payload));
  await act(async () => { await owner.checkStart(); }); expect(owner.pendingStart).toBeNull();
  await expect(owner.readView(aiAttempt)).rejects.toThrow("Invalid AI business acknowledgement");
  invoke.mockImplementation(original); await act(async () => { await owner.readView(aiAttempt); });
  expect(payloads("preview_ai_translation").map(request => request.unitIds)).toEqual([owner.selected, owner.selected]);
});

it("prepares the full legal 100-item scope and rejects limits above Core's maximum before dispatch", async () => {
  render(<Harness />, project);
  items = Array.from({length:100}, (_,index) => ({...items[0],unitId:fixtureIdentity(2000+index),sourceRevisionId:fixtureIdentity(2200+index),
    nativeKey:`key-${index}`,terms:[],context:null,omissions:["terms-not-shared","context-not-shared"],resourceBaseline:"0"}));
  act(() => { owner.setConfig({...prepared.preview.config,maxItems:100,shareTerms:false,shareContext:false}); owner.setSelected(items.map(item => item.unitId)); });
  await act(async () => { await owner.preview(); });
  expect(owner.prepared?.preview.items.map(item => item.unitId)).toEqual(items.map(item => item.unitId));
  expect(payloads("preview_ai_translation")[0].unitIds).toHaveLength(100);
  act(() => { owner.setConfig(before => ({...before,maxItems:101})); });
  await act(async () => { await owner.preview(); });
  expect(owner.failure).toBe("ai-limits"); expect(owner.prepared).toBeNull(); expect(owner.selected).toHaveLength(100);
  expect(calls("preview_ai_translation")).toHaveLength(1);
});

it.each(["project", "attempt", "action", "unit", "result", "operation", "parameters"] as const)("refuses an unrelated adoption preparation: %s", async mismatch => {
  render(<Harness />, project); const view = await start(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: PrepareRequest }) => {
    if (command !== "prepare_execution_adoption") return original(command, payload);
    action = actionFor(payload.request); const wrong = structuredClone(action);
    if (mismatch === "project") wrong.projectId = fixtureIdentity(942);
    if (mismatch === "attempt") wrong.attemptId = fixtureIdentity(942);
    if (mismatch === "action") wrong.actionId = fixtureIdentity(942);
    if (mismatch === "unit") wrong.unitId = fixtureIdentity(942);
    if (mismatch === "result") wrong.resultIds = [fixtureIdentity(942)];
    if (mismatch === "operation") wrong.operation = "sample-update";
    if (mismatch === "parameters") wrong.parameters = { text: "unrelated" };
    return Promise.resolve(wrong);
  });
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); });
  expect(owner.pendingAdopt?.uncertain).toBe(true); expect(calls("adopt_execution")).toHaveLength(0);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_execution_adoption_action" ? Promise.resolve({action,receipt:receiptFor(action)}) : original(command, payload));
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toBeNull(); expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
  expect(calls("prepare_execution_adoption")).toHaveLength(1);
  expect(calls("adopt_execution")).toHaveLength(0);
});

it.each(["project", "attempt", "action", "unit", "zero-revision", "wrong-change", "malformed"] as const)("does not settle an unverified adoption receipt: %s", async mismatch => {
  render(<Harness />, project); const view = await start(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command !== "adopt_execution") return original(command, payload);
    const wrong = structuredClone(receiptFor(action));
    if (mismatch === "project") wrong.projectId = fixtureIdentity(943);
    if (mismatch === "attempt") wrong.attemptId = fixtureIdentity(943);
    if (mismatch === "action") wrong.actionId = fixtureIdentity(943);
    if (mismatch === "unit") wrong.unitId = fixtureIdentity(943);
    if (mismatch === "zero-revision") wrong.changes[0].revision = "0";
    if (mismatch === "wrong-change") wrong.changes[0].kind = "translation-selection";
    return Promise.resolve(mismatch === "malformed" ? { actionId: action.actionId } : wrong);
  });
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); });
  expect(owner.pendingAdopt?.uncertain).toBe(true); expect(owner.saved).toEqual({});
  invoke.mockImplementation(original); await act(async () => { await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toBeNull(); expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
  expect(calls("adopt_execution")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

it.each(["prepare", "adopt"] as const)("retains unknown adoption after a Busy %s replay, revokes retry permission, and reuses every original identity", async boundary => {
  render(<Harness />, project); const view = await start(); const original = invoke.getMockImplementation()!; let count = 0, prepares = 0;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command === "prepare_execution_adoption" && ++prepares === 2 && boundary === "prepare") return Promise.reject(busyRejected);
    if (command === "adopt_execution") { count++; return count === 1 ? Promise.reject(new Error("Disconnected")) : count === 2 && boundary === "adopt" ? Promise.reject(busyRejected) : original(command, payload); }
    if (command === "read_execution_adoption_action") return Promise.resolve(null);
    return original(command, payload);
  });
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); }); const request = owner.pendingAdopt!.request;
  expect(Object.isFrozen(request.resultIds)).toBe(true);
  await act(async () => { await owner.checkAdoption(); }); expect(owner.pendingAdopt?.retryAllowed).toBe(true);
  await act(async () => { await owner.retryAdoption(); }); expect(owner.pendingAdopt).toMatchObject({ request, uncertain: true, retryAllowed: false });
  await act(async () => { await owner.retryAdoption(); await owner.adopt(view, view.rows[0].resultId!); await owner.start(); });
  expect(owner.showAttempt(fixtureIdentity(944))).toBe(false); expect(calls("adopt_execution")).toHaveLength(boundary === "prepare" ? 1 : 2); expect(calls("create_execution_identity")).toHaveLength(1);
  await act(async () => { await owner.checkAdoption(); await owner.retryAdoption(); });
  expect(owner.pendingAdopt).toBeNull(); expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
  expect(payloads("prepare_execution_adoption")).toEqual([request, request, request]);
  expect(payloads("adopt_execution")).toEqual(Array.from({length:boundary === "prepare" ? 2 : 3}, () => ({ sessionToken: project.sessionToken, projectId: project.metadata.projectId, actionId: request.actionId })));
});

it.each(["prepare_execution_adoption", "adopt_execution"])("releases a fresh rejected %s and permits a new identity", async boundary => {
  render(<Harness />, project); const view = await start(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === boundary ? Promise.reject(busyRejected) : original(command, payload));
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); });
  expect(owner.pendingAdopt).toBeNull(); expect(owner.reserved()).toBe(false);
  expect(calls("read_execution_adoption_action")).toHaveLength(0);
  invoke.mockImplementation(original); await act(async () => { await owner.adopt(view, view.rows[0].resultId!); });
  expect(calls("create_execution_identity")).toHaveLength(2); expect(payloads("prepare_execution_adoption")[0].actionId).not.toBe(payloads("prepare_execution_adoption")[1].actionId);
});

it.each(["prepare_execution_adoption","adopt_execution"] as const)("automatically confirms lost %s from one complete original read without another write",async boundary=>{
  render(<Harness/>,project);const view=await start(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,payload:unknown)=>{
    if(command===boundary){await original(command,payload);throw new Error("Lost ACK");}
    if(command==="read_execution_adoption_action")return {action,receipt:receiptFor(action)};
    return original(command,payload);
  });
  await act(async()=>{await owner.adopt(view,view.rows[0].resultId!);});
  expect(owner.pendingAdopt).toBeNull();expect(owner.failure).toBeNull();expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
  expect(calls("prepare_execution_adoption")).toHaveLength(1);expect(calls("adopt_execution")).toHaveLength(boundary==="adopt_execution"?1:0);
  expect(payloads("read_execution_adoption_action")).toEqual(payloads("prepare_execution_adoption"));expect(calls("create_execution_identity")).toHaveLength(1);
});

it("keeps a typed lost write detail when automatic lookup is missing, but never grants retry for invalid proof",async()=>{
  render(<Harness/>,project);const view=await start(),original=invoke.getMockImplementation()!;
  const failure:CommandError={...busyRejected,code:"outcome-unknown",outcome:"unknown",recoveryRequired:true};
  invoke.mockImplementation((command:string,payload:unknown)=>command==="adopt_execution"?Promise.reject(failure)
    :command==="read_execution_adoption_action"?Promise.resolve(null):original(command,payload));
  await act(async()=>{await owner.adopt(view,view.rows[0].resultId!);});
  expect(owner.pendingAdopt).toMatchObject({uncertain:true,retryAllowed:true,checking:false});expect(owner.failure).toEqual(failure);
  const request=owner.pendingAdopt!.request;
  for(const result of [undefined,{action:{...action,cancellationRevision:"9"},receipt:receiptFor(action)}]){
    invoke.mockImplementation((command:string,payload:unknown)=>command==="read_execution_adoption_action"?Promise.resolve(result):original(command,payload));
    await act(async()=>{await owner.checkAdoption();await owner.retryAdoption();});
    expect(owner.pendingAdopt?.request).toBe(request);expect(owner.pendingAdopt?.retryAllowed).toBe(false);
  }
  expect(calls("adopt_execution")).toHaveLength(1);expect(calls("prepare_execution_adoption")).toHaveLength(1);
});

it("keeps a checked start when its first result read fails", async () => {
  render(<AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe /><ResultRead /></AiPreparationSession>, project);
  await prepare(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_translation" ? Promise.reject(new Error("Read disconnected")) : original(command, payload));
  await act(async () => { await owner.start(); }); await screen.findByText("Result read failed");
  expect(owner.pendingStart).toBeNull(); expect(owner.reserved()).toBe(false); expect(owner.attempt).toBe(aiAttempt); expect(owner.notice).toBe("started");
  expect(calls("start_ai_translation")).toHaveLength(1);
});

it("binds later original attempt reads to the first checked task identity", async () => {
  render(<Harness />, project); await start(); let first!: AiView;
  await act(async () => { first = await owner.readView(aiAttempt); });
  expect(owner.started?.taskId).toBe(first.detail.taskId);
  const wrong = structuredClone(first!); wrong.detail.taskId = fixtureIdentity(945);
  invoke.mockResolvedValueOnce(wrong);
  await act(async () => { await expect(owner.readView(aiAttempt)).rejects.toThrow("Invalid AI business acknowledgement"); });
  expect(owner.started?.taskId).toBe(first!.detail.taskId); expect(owner.pendingStart).toBeNull(); expect(owner.reserved()).toBe(false);
});

it("keeps a seen original receipt while a mismatched action proof is unresolved without repeating adoption", async () => {
  render(<Harness />, project); const view = await start(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: { request: PrepareRequest }) => {
    if (command === "prepare_execution_adoption") { action = actionFor(payload.request); return Promise.reject(new Error("Lost prepare ACK")); }
    if (command === "read_execution_adoption_action") return Promise.resolve({action:{...action,parameters:{}},receipt:receiptFor(action)});
    return original(command, payload);
  });
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); }); const request = owner.pendingAdopt!.request;
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toMatchObject({ request, action: null, receipt: receiptFor(action), uncertain: true, retryAllowed: false });
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_execution_adoption_action" ? Promise.resolve(null) : original(command, payload));
  await act(async () => { await owner.checkAdoption(); }); expect(owner.pendingAdopt?.retryAllowed).toBe(false);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_execution_adoption_action" ? Promise.resolve({action,receipt:receiptFor(action)}) : original(command,payload));
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toBeNull(); expect(calls("adopt_execution")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(payloads("prepare_execution_adoption")).toEqual([request]);
});

it("revokes an earlier missing-receipt permission when its next receipt check is unknown", async () => {
  render(<Harness />, project); const view = await start(), original = invoke.getMockImplementation()!; let readsCount = 0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Disconnected"))
    : command === "read_execution_adoption_action" ? ++readsCount <= 2 ? Promise.resolve(null) : Promise.reject(new Error("Read disconnected")) : original(command, payload));
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); await owner.checkAdoption(); });
  expect(owner.pendingAdopt?.retryAllowed).toBe(true);
  await act(async () => { await owner.checkAdoption(); await owner.retryAdoption(); });
  expect(owner.pendingAdopt?.retryAllowed).toBe(false); expect(calls("adopt_execution")).toHaveLength(1);
});

it("settles checked receipts before independent result reads fail, without reopening unknown actions", async () => {
  render(<AiPreparationSession initialLocale="zh-CN" targetLocales={project.metadata.targetLocales}><Probe /><ResultRead /></AiPreparationSession>, project);
  const view = await start(); await screen.findByText("Result read confirmed"); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_translation" ? Promise.reject(new Error("Read disconnected")) : original(command, payload));
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); });
  await screen.findByText("Result read failed");
  expect(owner.pendingStart).toBeNull(); expect(owner.pendingAdopt).toBeNull(); expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
  expect(owner.reserved()).toBe(false); expect(calls("adopt_execution")).toHaveLength(1);
});

it("retains original unknown proof through locale removal and source changes while blocking new work", async () => {
  const rendered = render(<Harness />, project); const view = await start(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Disconnected")) : original(command, payload));
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); }); const capture = owner.pendingAdopt!;
  const changed = { ...project, metadata: { ...project.metadata, targetLocales: [] } };
  rendered.rerender(<Harness project={changed} />, changed);
  act(() => { reads.invalidate(["source", "resources"]); owner.setConfig(before => ({ ...before, model: "newer-model" })); });
  expect(owner.pendingAdopt?.request).toBe(capture.request); expect(owner.pendingAdopt?.candidate).toBe(capture.candidate);
  expect(owner.canAdopt(view, view.rows[0].resultId!)).toBe(false);
  await act(async () => { await owner.preview(); await owner.start(); await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toBeNull(); expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
  expect(owner.config.model).toBe("newer-model"); expect(owner.dirty).toBe(true); expect(owner.notice).toBe("newer");
  expect(calls("start_ai_translation")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(1);
});

function addSecondSelectedItem() {
  items = [items[0], {...items[0],unitId:fixtureIdentity(1100),sourceRevisionId:fixtureIdentity(1101),nativeKey:"second",sourceText:"Second source",
    context:null,omissions:["context-missing"]}];
}

it.each(["checked-start", "unknown-start"] as const)("accepts item-identity read order for %s without changing the original selected or preview order", async origin => {
  render(<Harness />, project); addSecondSelectedItem(); await prepare();
  const capture = owner.prepared!, selection = [...owner.selected], original = invoke.getMockImplementation()!;
  const reversed = structuredClone(viewFor());
  reversed.rows.reverse(); reversed.detail.items.reverse(); reversed.detail.recovery.units.reverse();
  expect(validateResponseView(reversed)).toBe(true);
  expect(reversed.rows.map(row => row.item.unitId)).toEqual([...selection].reverse());
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command === "read_ai_translation") return Promise.resolve(reversed);
    if (command === "start_ai_translation" && origin === "unknown-start") return Promise.reject(new Error("Lost start ACK"));
    return original(command, payload);
  });
  await act(async () => { await owner.start(); });
  const request = payloads("start_ai_translation")[0];
  if (origin === "unknown-start") {
    expect(owner.pendingStart?.request).toEqual(request);
    await act(async () => { await owner.checkStart(); });
  }
  let read!: AiView; await act(async () => { read = await owner.readView(aiAttempt); });
  if (origin === "unknown-start") {
    // The receipt is a business fact, not a mutable Query projection.
    expect(reads.client.getQueryState(reads.key(["aiCommands", aiAttempt]))).toBeUndefined();
  }
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(aiAttempt);
  expect(owner.selected).toEqual(selection);
  expect(owner.started?.prepared).toBe(capture);
  expect(capture.preview.items.map(item => item.unitId)).toEqual(selection);
  expect(payloads("preview_ai_translation")[0].unitIds).toEqual(selection);
  expect(payloads("start_ai_translation")).toEqual([{sessionToken:project.sessionToken,projectId:project.metadata.projectId,
    attemptId:capture.attemptId,digest:capture.preview.digest,confirmed:true}]);
  expect(read.rows.map(row => row.item.unitId)).toEqual([...selection].reverse());
  expect(read.detail.items.every(item => item.scope.kind === "translation-unit")).toBe(true);
  expect(read.detail.recovery.units.every(unit => unit.scopes.every(scope => scope.kind === "translation-unit"))).toBe(true);
  for (const row of read.rows) expect(owner.canAdopt(read,row.resultId!)).toBe(true);
  const row = read.rows[0], unit = read.detail.recovery.units.find(value => value.itemIds.includes(row.itemId))!;
  await act(async () => { await owner.adopt(read,row.resultId!); });
  expect(payloads("prepare_execution_adoption")[0]).toMatchObject({attemptId:capture.attemptId,unitId:unit.unitId,resultIds:[row.resultId]});
  expect(owner.saved[row.resultId!]).toEqual(receiptFor(action));
  expect(owner.selected).toEqual(selection); expect(capture.preview.items.map(item => item.unitId)).toEqual(selection);
});

it.each(["item", "recovery"] as const)("refuses the old generic translation %s scope for candidate adoption", async boundary => {
  render(<Harness />, project); const view = await start();
  expect(view.detail.items[0].scope).toEqual({kind:"translation-unit",id:view.rows[0].item.unitId,locale:view.rows[0].item.targetLocale});
  expect(view.detail.recovery.units[0].scopes[0]).toEqual(view.detail.items[0].scope);
  expect(owner.canAdopt(view,view.rows[0].resultId!)).toBe(true);
  const wrong = structuredClone(view);
  if (boundary === "item") wrong.detail.items[0].scope.kind = "translation";
  else wrong.detail.recovery.units[0].scopes[0].kind = "translation";
  expect(validateResponseView(wrong)).toBe(true);
  expect(owner.canAdopt(wrong,wrong.rows[0].resultId!)).toBe(false);
  await act(async () => { await owner.adopt(wrong,wrong.rows[0].resultId!); });
  expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("prepare_execution_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
});

it.each(["duplicate-unit", "missing-unit", "extra-unit", "substituted-unit", "wrong-full-proof", "legacy-item-scope"] as const)("rejects a mutable result view whose shape-valid whole scope has %s", async mismatch => {
  render(<Harness />, project); addSecondSelectedItem(); await prepare();
  const capture = owner.prepared!, selection = [...owner.selected], original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_ai_translation" ? Promise.reject(new Error("Lost start ACK")) : original(command,payload));
  await act(async () => { await owner.start(); }); const request = owner.pendingStart!.request;
  const extra = {...items[1],unitId:fixtureIdentity(1102),sourceRevisionId:fixtureIdentity(1103),nativeKey:"extra",sourceText:"Extra source"};
  const wrong = structuredClone(mismatch === "extra-unit" ? viewFor({...prepared,preview:{...prepared.preview,items:[...items,extra]}}) : viewFor());
  if (mismatch === "duplicate-unit") {
    wrong.rows[1].item = structuredClone(wrong.rows[0].item);
    wrong.rows[1].output!.unitId = wrong.rows[0].item.unitId;
    wrong.detail.items[1].scope = {...wrong.detail.items[0].scope};
    wrong.detail.recovery.units[1].scopes = [{...wrong.detail.items[0].scope}];
  }
  if (mismatch === "missing-unit") {
    wrong.rows.pop(); wrong.detail.items.pop(); wrong.detail.recovery.units.pop();
    wrong.detail.progress.total = 1; wrong.detail.progress.succeeded = 1;
  }
  if (mismatch === "substituted-unit") {
    wrong.rows[1].item = extra; wrong.rows[1].output!.unitId = extra.unitId;
    wrong.detail.items[1].scope = {kind:"translation-unit",id:extra.unitId,locale:extra.targetLocale};
    wrong.detail.recovery.units[1].scopes = [{...wrong.detail.items[1].scope}];
  }
  if (mismatch === "wrong-full-proof") wrong.rows[1].item.sourceText = "Changed immutable source";
  if (mismatch === "legacy-item-scope") wrong.detail.items[1].scope.kind = "translation";
  expect(validateResponseView(wrong)).toBe(true);
  expect(wrong.rows).toHaveLength(wrong.detail.items.length); expect(wrong.rows).toHaveLength(wrong.detail.progress.total);
  if (["duplicate-unit","substituted-unit","wrong-full-proof","legacy-item-scope"].includes(mismatch)) expect(wrong.rows).toHaveLength(capture.preview.items.length);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_translation" ? Promise.resolve(wrong) : original(command,payload));
  await act(async () => { await owner.checkStart(); });
  expect(owner.pendingStart).toBeNull(); expect(owner.started?.prepared).toBe(capture);
  await expect(owner.readView(aiAttempt)).rejects.toThrow("Invalid AI business acknowledgement");
  expect(owner.attempt).toBe(aiAttempt); expect(owner.selected).toEqual(selection); expect(owner.reserved()).toBe(false);
  expect(capture.preview.items.map(item => item.unitId)).toEqual(selection);
  invoke.mockImplementation(original); await act(async () => { await owner.readView(aiAttempt); });
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(aiAttempt);
  expect(payloads("start_ai_translation")).toEqual([request]);
  expect(owner.selected).toEqual(selection); expect(owner.started?.prepared).toBe(capture);
});

it("checks a lost AI start once without result projection, preserves newer input and ignores a retired lookup", async () => {
  const rendered = render(<Harness />, project); await prepare();
  const response = deferred<ReturnType<typeof startReceipt>>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_ai_translation" ? Promise.reject(new Error("Lost ACK"))
    : command === "read_ai_start_action" ? response.promise : command === "read_ai_translation" ? Promise.reject(new Error("No runtime")) : original(command,payload));
  let pending!: Promise<void>; act(() => { pending = owner.start(); });
  await act(async () => { await Promise.resolve(); });
  expect(owner.pendingStart).toMatchObject({checking:true,uncertain:true,retryAllowed:false});
  expect(owner.busy).toBe(true); expect(calls("read_ai_start_action")).toHaveLength(1);
  act(() => { owner.setConfig(config => ({...config,model:"newer-B"})); reads.invalidate(["source"]); });
  await act(async () => { await owner.retryStart(); await owner.checkStart(); });
  expect(calls("start_ai_translation")).toHaveLength(1); expect(calls("read_ai_start_action")).toHaveLength(1);
  rendered.unmount();
  await act(async () => { response.resolve(startReceipt()); await pending; });
  expect(owner.attempt).toBeNull(); expect(owner.config.model).toBe("newer-B");
  expect(calls("read_ai_translation")).toHaveLength(0);
});

it("settles an automatic immutable AI receipt despite removed locale and newer draft without another generation", async () => {
  const rendered = render(<Harness />, project); await prepare();
  const response = deferred<ReturnType<typeof startReceipt>>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_ai_translation" ? Promise.reject(new Error("Lost ACK"))
    : command === "read_ai_start_action" ? response.promise : original(command,payload));
  let pending!: Promise<void>; act(() => { pending = owner.start(); });
  await act(async () => { await Promise.resolve(); });
  const request = owner.pendingStart!.request;
  act(() => { owner.setConfig(config => ({...config,model:"newer-B"})); });
  const removed = {...project,metadata:{...project.metadata,targetLocales:[]}};
  rendered.rerender(<Harness project={removed}/>,removed);
  await act(async () => { response.resolve(startReceipt()); await pending; });
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(request.attemptId);
  expect(owner.started?.taskId).toBe(viewFor().detail.taskId); expect(owner.config.model).toBe("newer-B");
  expect(owner.dirty).toBe(true); expect(owner.consent).toBe(false); expect(owner.notice).toBe("newer");
  expect(payloads("read_ai_start_action")).toEqual([request]); expect(calls("start_ai_translation")).toHaveLength(1);
  expect(calls("read_ai_translation")).toHaveLength(0);
});
