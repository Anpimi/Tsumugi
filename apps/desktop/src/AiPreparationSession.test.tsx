import { useLayoutEffect } from "react";
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/aiCommands.contract.json";
import execution from "../test/fixtures/executionCommands.contract.json";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { defaultAiConfig, type AiConfig, type AiItem, type AiPrepared, type AiView } from "./aiCommands";
import type { AdoptionAction, PrepareRequest, Receipt } from "./executionCommands";
import { isCommandError, type CommandError, type ProjectView } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { validateResponsePrepared, validateResponseView } from "./generated/ai.validators";
import { aiAttempt, aiViewFixture } from "./testSupport/aiFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { i18n } from "./i18n";
import { connectionReadKey, useApplicationQueryClient } from "./ApplicationReadProvider";
import { connectionFixture } from "./testSupport/connectionFixture";
import { fixedContentSelection, type ContentSelection } from "./contentSelection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "ai-owner-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(500), displayName: "AI owner", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
function contentRange(): ContentSelection {
  return fixedContentSelection({ projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    capture: { locale: "zh-CN", query: "fixed", readVersion: "basis-view", scopeId: fixtureIdentity(800), sourceSnapshotId: fixtureIdentity(801),
      units: [1,2,3].map(index => ({ unitId: fixtureIdentity(810 + index), expectedBasis: `basis-${index}`, expectedDecisionId: null })) },
    excluded: [fixtureIdentity(812)] });
}
let owner: ReturnType<typeof useAiPreparation>;
let reads: ReturnType<typeof useSessionReads>;
let application: ReturnType<typeof useApplicationQueryClient>;
let prepared: AiPrepared;
let action: AdoptionAction;
let items: AiItem[];
function Probe() {
  const value = useAiPreparation(), sessionReads = useSessionReads(), appReads = useApplicationQueryClient();
  useLayoutEffect(() => { owner = value; reads = sessionReads; application = appReads; });
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
  invoke.mockReset(); invoke.mockImplementation(async (command: string, payload: { request: PrepareRequest & { config: AiConfig; unitIds: string[] } }) => {
    if (command === "read_context_strategy_default") return null;
    if (command === "preview_ai_translation") {
      prepared = { attemptId: aiAttempt, preview: { ...prepared.preview, config: payload.request.config,
        items: payload.request.unitIds.map(id => items.find(item => item.unitId === id)!) } };
      return prepared;
    }
    if (command === "start_ai_translation") return prepared.attemptId;
    if (command === "read_ai_translation") return viewFor();
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_execution_adoption") { action = actionFor(payload.request); return action; }
    if (command === "adopt_execution" || command === "read_execution_receipt") return receiptFor(action);
    throw new Error(command);
  });
});
afterEach(cleanup);
async function prepare() {
  act(() => { owner.setConfig(prepared.preview.config); owner.setSelected(items.map(item => item.unitId)); });
  await act(async () => { await owner.preview(); });
  act(() => { owner.setConsent(true); });
}

it("recommends adopted resources only for new drafts and explicit full resets without changing captured defaults", async () => {
  render(<Harness />, project);
  const recommendation = { ...defaultAiConfig, shareTerms: true, shareContext: true };
  expect(owner.config).toEqual(recommendation);
  expect(owner.config.sourceContext).toEqual({ extracted: false, inferred: false, neighbors: false, maxBytes: 16384, maxItems: 128 });
  expect(defaultAiConfig.shareTerms).toBe(false); expect(defaultAiConfig.shareContext).toBe(false);
  expect(owner.consent).toBe(false); expect(owner.dirty).toBe(false);
  expect(owner.canStart()).toBe(false); expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_context_strategy_default"]);

  // Loading an explicit configuration keeps its original sharing choices.
  prepared.preview.config = { ...prepared.preview.config, shareTerms: false, shareContext: false };
  items = items.map<AiItem>(item => ({ ...item, terms: [], context: null, projectContext: { kind: "not-selected" },
    omissions: ["terms-not-shared", "context-not-shared"] }));
  prepared.preview.items = items;
  await prepare();
  const captured = owner.prepared!, capturedConfig = structuredClone(captured.preview.config);
  expect(capturedConfig).toMatchObject({ shareTerms: false, shareContext: false });
  expect(captured.preview.items).toEqual(items);
  expect(captured.preview.items.every(item => item.terms.length === 0 && item.context === null && item.projectContext.kind === "not-selected")).toBe(true);
  act(() => { owner.setConfig(before => ({ ...before, model: "newer B", maxRequests: 7,
    sourceContext: { extracted: true, inferred: true, neighbors: true, maxBytes: 2048, maxItems: 17 } })); });
  expect(owner.config).toMatchObject({ shareTerms: false, shareContext: false });
  expect(owner.prepared).toBeNull(); expect(owner.consent).toBe(false);
  const count = invoke.mock.calls.length;
  act(() => { expect(owner.reset()).toBe(true); });
  expect(owner.config).toEqual(recommendation);
  expect(owner.prepared).toBeNull(); expect(owner.preparedPlan).toBeNull();
  expect(owner.selected).toEqual([]); expect(owner.consent).toBe(false); expect(owner.dirty).toBe(false);
  expect(captured.preview.config).toEqual(capturedConfig);
  expect(defaultAiConfig.shareTerms).toBe(false); expect(defaultAiConfig.shareContext).toBe(false);
  expect(invoke.mock.calls.slice(count).map(([command]) => command)).toEqual(["read_context_strategy_default"]);
});

it("recommends checks only in a new draft and preserves an explicit manual choice through consumer remount and newer input", () => {
  const rendered = render(<Harness />, project);
  expect(owner.options.selectionPolicy).toBe("candidates-only");
  expect(owner.options.stages.filter(choice => choice.stage === "generation" || choice.stage === "checks")
    .every(choice => choice.mode === "assisted")).toBe(true);
  expect(owner.consent).toBe(false);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_context_strategy_default"]);
  act(() => {
    owner.setOptions(before => ({ ...before, stages: before.stages.map(choice => choice.stage === "checks" ? { ...choice, mode: "manual" } : choice) }));
    owner.setConfig(before => ({ ...before, model: "manual-checks-newer-B" }));
  });
  const original = owner.current();
  rendered.rerender(<Harness mounted={false} />);
  rendered.rerender(<Harness />);
  expect(owner.options).toEqual(original.options);
  expect(owner.config.model).toBe("manual-checks-newer-B");
  expect(owner.dirty).toBe(true);
  expect(owner.consent).toBe(false);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_context_strategy_default"]);
});

it("transfers exact fixed content members without execution, preserving configuration and invalidating the old preview and consent", async () => {
  render(<Harness />, project); await prepare();
  const before = owner.current(), selection = contentRange(), count = invoke.mock.calls.length;
  act(() => { expect(owner.receiveContentSelection(selection, before.editSeq)).toBe(true); });
  expect(owner.selected).toEqual([fixtureIdentity(811), fixtureIdentity(813)]);
  expect(owner.config).toEqual(before.config); expect(owner.options).toEqual(before.options); expect(owner.planId).toBe(before.planId);
  expect(owner.prepared).toBeNull(); expect(owner.preparedPlan).toBeNull(); expect(owner.consent).toBe(false);
  expect(owner.canStart()).toBe(false); expect(owner.dirty).toBe(true); expect(invoke.mock.calls).toHaveLength(count);
  expect(Object.isFrozen(selection.capture.units)).toBe(true);
});

it.each(["storeId", "profileId", "revision", "digest"] as const)("refuses a prepared profile with mismatched %s even when defaults match", async field => {
  render(<Harness />, project);
  const reference = { storeId: fixtureIdentity(700), profileId: fixtureIdentity(701), revision: "1", digest: "a".repeat(64) };
  act(() => { const config = { ...prepared.preview.config, connectionProfile: reference }; application.setQueryData(connectionReadKey, connectionFixture([config])); owner.setConfig(config); owner.setSelected(items.map(item => item.unitId)); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, payload: unknown) => {
    const result = await original(command, payload);
    if (command !== "preview_ai_translation") return result;
    const wrong = structuredClone(result);
    wrong.preview.config.connectionProfile[field] = field === "revision" ? "2" : field === "digest" ? "b".repeat(64) : fixtureIdentity(702);
    return wrong;
  });
  await act(async () => { await owner.preview(); });
  expect(owner.prepared).toBeNull(); expect(owner.consent).toBe(false); expect(owner.canStart()).toBe(false);
  expect(owner.current().config.connectionProfile).toEqual(reference); expect(owner.failure).not.toBeNull(); expect(calls("start_ai_translation")).toHaveLength(0);
});

it("refuses foreign sessions, obsolete AI edits, duplicate or excluded foreign members and over-limit transfers", () => {
  render(<Harness />, project); const selection = contentRange(), before = owner.current();
  const invalidCases: [ContentSelection, number][] = [
    [{ ...selection, projectId: fixtureIdentity(999) }, before.editSeq],
    [{ ...selection, sessionToken: "foreign" }, before.editSeq],
    [selection, before.editSeq + 1],
    [{ ...selection, capture: { ...selection.capture, locale: "fr" } }, before.editSeq],
    [{ ...selection, excluded: [fixtureIdentity(999)] }, before.editSeq],
    [{ ...selection, capture: { ...selection.capture, units: [...selection.capture.units, selection.capture.units[0]] } }, before.editSeq],
    [{ ...selection, excluded: [], capture: { ...selection.capture, units: Array.from({ length: 101 }, (_, index) => ({ unitId: fixtureIdentity(1000 + index), expectedBasis: "basis", expectedDecisionId: null })) } }, before.editSeq],
  ];
  for (const [value, sequence] of invalidCases) {
    act(() => { expect(owner.receiveContentSelection(value, sequence)).toBe(false); });
    expect(owner.current()).toBe(before);
  }
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_context_strategy_default"]);
});

it("keeps the original pending generation request when content transfer arrives during its reservation", async () => {
  render(<Harness />, project); await prepare(); const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_ai_translation" ? response.promise : original(command, payload));
  let pending!: Promise<void>; act(() => { pending = owner.start(); });
  const before = owner.current();
  act(() => { expect(owner.receiveContentSelection(contentRange(), before.editSeq)).toBe(false); });
  expect(owner.current()).toBe(before); expect(owner.pendingStart?.request).toEqual(before.pendingStart?.request);
  await act(async () => { response.resolve(prepared.attemptId); await pending; });
});

it("blocks transfer after start acknowledgement until the original task has a checked, idle and finished result", async () => {
  render(<Harness />, project); await prepare(); await act(async () => { await owner.start(); });
  const before = owner.current();
  expect(owner.canReceiveContentSelection()).toBe(false);
  expect(owner.contentRangeAvailable).toBe(false);
  act(() => { expect(owner.receiveContentSelection(contentRange(), before.editSeq)).toBe(false); });
  expect(owner.current()).toBe(before);
  let view!: AiView; await act(async () => { view = await owner.readView(prepared.attemptId); });
  act(() => { reads.client.setQueryData(reads.key(["aiCommands",prepared.attemptId]), view); });
  expect(owner.canReceiveContentSelection()).toBe(true);
  expect(owner.contentRangeAvailable).toBe(true);
  act(() => { reads.client.setQueryData(reads.key(["aiCommands",prepared.attemptId]), { ...view, detail: { ...view.detail, progress: { ...view.detail.progress, running: 1 } } }); });
  expect(owner.canReceiveContentSelection()).toBe(false);
  expect(owner.contentRangeAvailable).toBe(false);
  act(() => { reads.client.setQueryData(reads.key(["aiCommands",prepared.attemptId]), view); void reads.client.invalidateQueries({ queryKey: reads.key(["aiCommands",prepared.attemptId]), exact: true, refetchType: "none" }); });
  expect(owner.canReceiveContentSelection()).toBe(false);
});
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

it.each(["config", "scope", "missing-item", "partial-page", "wrong-attempt"] as const)("refuses an unrelated original-start read proof: %s", async mismatch => {
  render(<Harness />, project); await prepare(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "start_ai_translation" ? Promise.reject(new Error("Disconnected")) : original(command, payload));
  await act(async () => { await owner.start(); }); const request = owner.pendingStart!.request;
  const wrong = structuredClone(viewFor());
  if (mismatch === "config") wrong.config.model = "another-model";
  if (mismatch === "scope") { wrong.rows[0].item.sourceRevisionId = fixtureIdentity(933); }
  if (mismatch === "missing-item") { wrong.rows = []; wrong.detail.items = []; wrong.detail.progress.total = 0; }
  if (mismatch === "partial-page") wrong.detail.nextOffset = 1;
  if (mismatch === "wrong-attempt") wrong.detail.attemptId = fixtureIdentity(934);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_translation" ? Promise.resolve(wrong) : original(command, payload));
  await act(async () => { await owner.checkStart(); });
  expect(owner.pendingStart).toMatchObject({ request, uncertain: true }); expect(owner.attempt).toBeNull(); expect(owner.reserved()).toBe(true);
  invoke.mockImplementation(original);
  await act(async () => { await owner.checkStart(); });
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(aiAttempt);
  expect(payloads("read_ai_translation")).toEqual([0, 1].map(() => ({ sessionToken: project.sessionToken, projectId: project.metadata.projectId, attemptId: request.attemptId })));
  expect(calls("start_ai_translation")).toHaveLength(1);
});

it("keeps unknown generation after a rejected original replay and settles only the same checked attempt", async () => {
  render(<Harness />, project); await prepare(); let count = 0;
  invoke.mockImplementation(async command => {
    if (command === "start_ai_translation") { if (++count === 1) throw new Error("Disconnected"); if (count === 2) throw startRejected; return aiAttempt; }
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
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_translation" ? Promise.resolve(partial) : original(command, payload));
  await act(async () => { await owner.checkStart(); }); expect(owner.pendingStart?.uncertain).toBe(true);
  invoke.mockImplementation(original); await act(async () => { await owner.checkStart(); }); expect(owner.pendingStart).toBeNull();
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
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_execution_receipt" ? Promise.resolve(receiptFor(action)) : original(command, payload));
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toBeNull(); expect(owner.saved[view.rows[0].resultId!]).toEqual(receiptFor(action));
  expect(payloads("prepare_execution_adoption")[1]).toEqual(payloads("prepare_execution_adoption")[0]);
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
    if (command === "read_execution_receipt") return Promise.resolve(null);
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
  invoke.mockImplementation(original); await act(async () => { await owner.adopt(view, view.rows[0].resultId!); });
  expect(calls("create_execution_identity")).toHaveLength(2); expect(payloads("prepare_execution_adoption")[0].actionId).not.toBe(payloads("prepare_execution_adoption")[1].actionId);
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

it("keeps a seen original receipt while restoring its missing action proof without repeating adoption", async () => {
  render(<Harness />, project); const view = await start(), original = invoke.getMockImplementation()!; let prepares = 0;
  invoke.mockImplementation((command: string, payload: { request: PrepareRequest }) => {
    if (command === "prepare_execution_adoption") { action = actionFor(payload.request); return ++prepares === 1 ? Promise.reject(new Error("Lost prepare ACK")) : Promise.reject(busyRejected); }
    return original(command, payload);
  });
  await act(async () => { await owner.adopt(view, view.rows[0].resultId!); }); const request = owner.pendingAdopt!.request;
  await act(async () => { await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toMatchObject({ request, action: null, receipt: receiptFor(action), uncertain: true, retryAllowed: false });
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_execution_receipt" ? Promise.resolve(null) : original(command, payload));
  await act(async () => { await owner.checkAdoption(); }); expect(owner.pendingAdopt?.retryAllowed).toBe(false);
  invoke.mockImplementation(original); await act(async () => { await owner.checkAdoption(); });
  expect(owner.pendingAdopt).toBeNull(); expect(calls("adopt_execution")).toHaveLength(0); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(payloads("prepare_execution_adoption")).toEqual([request, request, request]);
});

it("revokes an earlier missing-receipt permission when its next receipt check is unknown", async () => {
  render(<Harness />, project); const view = await start(), original = invoke.getMockImplementation()!; let readsCount = 0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Disconnected"))
    : command === "read_execution_receipt" ? ++readsCount === 1 ? Promise.resolve(null) : Promise.reject(new Error("Read disconnected")) : original(command, payload));
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
    // Recovery invalidates the inactive cache. This newly checked owner read
    // still supplies the fixed original evidence without changing UI freshness.
    expect(reads.client.getQueryState(reads.key(["aiCommands", aiAttempt]))).toMatchObject({ status: "success", isInvalidated: true });
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

it.each(["duplicate-unit", "missing-unit", "extra-unit", "substituted-unit", "wrong-full-proof", "source-context", "legacy-item-scope"] as const)("retains the original unknown start when a shape-valid whole scope has %s", async mismatch => {
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
  if (mismatch === "source-context") {
    const item = wrong.rows[1].item;
    item.sourceContext = {kind:"selected",value:{
      scope:{projectId:project.metadata.projectId,sourceSnapshotId:item.sourceSnapshotId,unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,locale:item.targetLocale},
      contentRevision:"9007199254740993",sourceAttemptId:fixtureIdentity(1110),sourceResultId:fixtureIdentity(1111),sourceResultDigest:"a".repeat(64),sourceLocale:item.sourceLocale,localUnitId:"local",
      selection:{extracted:true,inferred:false,neighbors:false,maxBytes:16384,maxItems:128},facts:[],neighbors:[],
      observations:{missingBlocks:true,knownBlocks:0,knownFacts:0,emptyBlocks:0,unknownBlocks:0,unknownRequiredBlocks:0,neighborOccurrences:0,unknownSamples:[]},
      omissions:{extracted:0,inferred:0,neighbors:0,notSelected:0,byteBudget:0,itemLimit:0,samples:[]}
    }};
  }
  if (mismatch === "legacy-item-scope") wrong.detail.items[1].scope.kind = "translation";
  expect(validateResponseView(wrong)).toBe(true);
  expect(wrong.rows).toHaveLength(wrong.detail.items.length); expect(wrong.rows).toHaveLength(wrong.detail.progress.total);
  if (["duplicate-unit","substituted-unit","wrong-full-proof","legacy-item-scope"].includes(mismatch)) expect(wrong.rows).toHaveLength(capture.preview.items.length);
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_ai_translation" ? Promise.resolve(wrong) : original(command,payload));
  await act(async () => { await owner.checkStart(); });
  expect(owner.pendingStart).toMatchObject({request,prepared:capture,uncertain:true}); expect(owner.pendingStart!.request).toBe(request);
  expect(owner.attempt).toBeNull(); expect(owner.selected).toEqual(selection); expect(owner.reserved()).toBe(true);
  expect(capture.preview.items.map(item => item.unitId)).toEqual(selection);
  invoke.mockImplementation(original); await act(async () => { await owner.checkStart(); });
  expect(owner.pendingStart).toBeNull(); expect(owner.attempt).toBe(aiAttempt);
  expect(payloads("start_ai_translation")).toEqual([request]);
  expect(owner.selected).toEqual(selection); expect(owner.started?.prepared).toBe(capture);
});

function savedConnection() {
  return { ...prepared.preview.config, endpoint:"https://saved.example.test/v1/chat/completions", model:"Saved model", credentialEnv:"SYNTHETIC_REFERENCE", tokenField:"max_completion_tokens",
    connectionProfile:{storeId:fixtureIdentity(700),profileId:fixtureIdentity(701),revision:"1",digest:"a".repeat(64)} };
}
function selectSaved() {
  const config=savedConnection(),view=connectionFixture([config]);
  act(()=>{application.setQueryData(connectionReadKey,view);expect(owner.selectConnection(view,config.connectionProfile.profileId,owner.editSeq)).toBe(true);});return view;
}
it.each([true,false])("copies only saved defaults and exact identity while retaining terms opt-out, context choice %s, and invocation limits",sharing=>{
  const rendered=render(<Harness/>,project);act(()=>{owner.setConfig({...prepared.preview.config,maxRequests:4,maxOutputTokens:37,shareTerms:false,shareContext:sharing});owner.setPresetName("openai");owner.setSelected([items[0].unitId]);});
  const before=owner.current(),view=selectSaved();expect(owner.config).toMatchObject({...view.snapshot.profiles[0].connection,connectionProfile:view.references[0],maxRequests:4,maxOutputTokens:37,shareTerms:false,shareContext:sharing});
  expect(owner.presetName).toBe("custom");expect(owner.selected).toEqual(before.selected);expect(owner.locale).toBe(before.locale);expect(owner.consent).toBe(false);expect(calls("preview_ai_translation")).toHaveLength(0);
  act(()=>owner.setConfig({...owner.config,maxRequests:3}));expect(owner.config.connectionProfile).toEqual(view.references[0]);
  act(()=>owner.setConfig({...owner.config,endpoint:"https://edited.example.test/v1"}));expect(owner.config.connectionProfile).toBeNull();expect(application.getQueryData(connectionReadKey)).toEqual(view);
  const edited=owner.config;
  rendered.rerender(<Harness mounted={false}/>);rendered.rerender(<Harness/>);
  expect(owner.config).toEqual(edited);expect(owner.config).toMatchObject({shareTerms:false,shareContext:sharing});
});
it("refuses an old picker selection after newer input or an unconfirmed current read",()=>{
  render(<Harness/>,project);const config=savedConnection(),view=connectionFixture([config]);act(()=>application.setQueryData(connectionReadKey,view));const seq=owner.editSeq;
  act(()=>owner.setConfig({...prepared.preview.config,model:"Newer B"}));act(()=>expect(owner.selectConnection(view,config.connectionProfile.profileId,seq)).toBe(false));expect(owner.config.model).toBe("Newer B");
  act(()=>{void application.invalidateQueries({queryKey:connectionReadKey,exact:true,refetchType:"none"});});
  act(()=>expect(owner.selectConnection(view,config.connectionProfile.profileId,owner.editSeq)).toBe(false));expect(owner.config.model).toBe("Newer B");
});
it("keeps consent through an unchanged reread but revokes it for a changed selected reference without replacing defaults",async()=>{
  render(<Harness/>,project);const view=selectSaved();act(()=>owner.setSelected([items[0].unitId]));await act(async()=>owner.preview());act(()=>owner.setConsent(true));expect(owner.canStart()).toBe(true);
  const captured=owner.prepared,config=owner.config;act(()=>{void application.invalidateQueries({queryKey:connectionReadKey,exact:true,refetchType:"none"});});expect(owner.canStart()).toBe(false);expect(owner.consent).toBe(true);
  await act(async()=>{await application.fetchQuery({queryKey:connectionReadKey,staleTime:0,retry:false,queryFn:async()=>structuredClone(view)});});expect(owner.canStart()).toBe(true);expect(owner.prepared).toEqual(captured);
  const newer=structuredClone(view);newer.snapshot.revision="2";newer.basis.revision="2";newer.snapshot.profiles[0].revision="2";newer.references[0].revision="2";newer.references[0].digest="b".repeat(64);
  act(()=>application.setQueryData(connectionReadKey,newer));expect(owner.prepared).toBeNull();expect(owner.consent).toBe(false);expect(owner.config).toEqual(config);expect(owner.staleReason).toBe("connection");
});
it("retains an original unknown start through saved-profile changes without renewing or recapturing it",async()=>{
  const rendered=render(<Harness/>,project);act(()=>owner.setConfig(before=>({...before,shareTerms:false,shareContext:false})));const view=selectSaved();act(()=>owner.setSelected([items[0].unitId]));await act(async()=>owner.preview());act(()=>owner.setConsent(true));
  const response=deferred<unknown>(),original=invoke.getMockImplementation()!;invoke.mockImplementation((command:string,args:unknown)=>command==="start_ai_translation"?response.promise:original(command,args));
  let start!:Promise<void>;act(()=>{start=owner.start();});const request=structuredClone(owner.pendingStart!.request),capture=owner.pendingStart!.prepared;
  act(()=>owner.setConfig(before=>({...before,model:"newer B"})));const newer=owner.config;
  rendered.rerender(<Harness mounted={false}/>);
  const changed=structuredClone(view);changed.snapshot.profiles[0].archived=true;changed.references=[];act(()=>application.setQueryData(connectionReadKey,changed));
  await act(async()=>{response.reject(new Error("Lost original ACK"));await start;});
  rendered.rerender(<Harness/>);
  expect(owner.pendingStart?.request).toEqual(request);expect(owner.pendingStart?.prepared).toEqual(capture);expect(owner.pendingStart?.uncertain).toBe(true);expect(calls("start_ai_translation")).toHaveLength(1);
  expect(owner.config).toEqual(newer);expect(owner.config).toMatchObject({model:"newer B",shareTerms:false,shareContext:false});
  expect(capture.preview.config).toMatchObject({shareTerms:false,shareContext:false});
  act(()=>expect(owner.reset()).toBe(false));
  await act(async()=>owner.checkStart());
  expect(owner.pendingStart).toBeNull();expect(owner.started?.prepared).toEqual(capture);
  expect(owner.config).toEqual(newer);expect(owner.dirty).toBe(true);expect(owner.consent).toBe(false);
  expect(calls("start_ai_translation")).toHaveLength(1);
});

it.each([["extracted",true],["inferred",true],["neighbors",true],["maxBytes",2048],["maxItems",4]] as const)("revokes preparation and consent when source context %s changes", async (key,value) => {
  render(<Harness />, project); await prepare();
  const before = owner.current();
  expect(before.prepared).not.toBeNull(); expect(before.consent).toBe(true);
  act(() => { owner.setConfig({...before.config, sourceContext:{...before.config.sourceContext,[key]:value}}); });
  expect(owner.prepared).toBeNull(); expect(owner.consent).toBe(false); expect(owner.canStart()).toBe(false);
  expect(owner.config.sourceContext[key]).toBe(value);
  expect(owner.config.maxRequests).toBe(before.config.maxRequests);
  expect(calls("start_ai_translation")).toHaveLength(0);
});
