import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ai from "../test/fixtures/aiCommands.contract.json";
import execution from "../test/fixtures/executionCommands.contract.json";
import { AiWorkbench } from "./AiWorkbench";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type AiCandidateCommandPayload, type AiTranslationCommandPayload } from "./workbenchCommands";
import { defaultAiConfig, type AiConfig, type AiItem, type AiPrepared, type AiView } from "./aiCommands";
import type { AdoptionAction, PrepareRequest, Receipt } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { aiAttempt, aiTask, aiViewFixture } from "./testSupport/aiFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "ai-command-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(500), displayName: "AI commands", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "ai" as const };
const item: AiItem = { unitId: fixtureIdentity(301), sourceRevisionId: fixtureIdentity(302), sourceSnapshotId: fixtureIdentity(300),
  nativeKey: "first", sourceLocale: "en", sourceText: "Hello", targetLocale: "zh-CN", terms: [], context: null,
  omissions: ["terms-not-shared", "context-not-shared"], resourceBaseline: "0" };
let owner: ReturnType<typeof useAiPreparation>, reads: ReturnType<typeof useSessionReads>, registry: ReturnType<typeof useWorkbenchCommands>;
let tasks: ReturnType<typeof useExecutionTaskSession>, prepared: AiPrepared, view: AiView, action: AdoptionAction;
const navigate = vi.fn(async () => true);
function Probe() {
  const preparation = useAiPreparation(), sessionReads = useSessionReads(), commands = useWorkbenchCommands(), taskOwner = useExecutionTaskSession();
  useLayoutEffect(() => { owner = preparation; reads = sessionReads; registry = commands; tasks = taskOwner; });
  return null;
}
function Harness({ project: current = project, mounted = true }: { project?: ProjectView; mounted?: boolean }) {
  return <AiPreparationSession initialLocale={current.metadata.targetLocales[0] ?? ""} targetLocales={current.metadata.targetLocales}>
    <Probe />{mounted ? <AiWorkbench project={current} disabled={false} onOpenTranslation={navigate} /> : null}
  </AiPreparationSession>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function payloads(command: string) { return calls(command).map(([, payload]) => payload.request); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function observeQuerySubscriptions() {
  const cache = reads.client.getQueryCache(), subscribe = cache.subscribe;
  const counts = { subscribed: 0, disposed: 0, events: 0 };
  vi.spyOn(cache, "subscribe").mockImplementation(listener => {
    counts.subscribed++;
    const unsubscribe = subscribe(event => { counts.events++; listener(event); });
    return () => { counts.disposed++; unsubscribe(); };
  });
  return counts;
}
function actionFor(request: PrepareRequest): AdoptionAction {
  return { ...execution.action, projectId: request.projectId, attemptId: request.attemptId, actionId: request.actionId, unitId: request.unitId,
    operation: "ai-translation", parameters: null, resultIds: [...request.resultIds] };
}
function receiptFor(value = action): Receipt {
  return { ...execution.receipt, projectId: value.projectId, attemptId: value.attemptId, actionId: value.actionId, unitId: value.unitId,
    changes: [{ kind: "translation-revision", id: fixtureIdentity(950), revision: "1" }] };
}
function candidatePayload(): AiCandidateCommandPayload {
  const row = view.rows[0], unit = view.detail.recovery.units.find(unit => unit.itemIds.includes(row.itemId))!;
  return { kind: "ai-candidate", attemptId: view.detail.attemptId, taskId: view.detail.taskId, itemId: row.itemId,
    resultId: row.resultId!, recoveryUnitId: unit.unitId, translationUnitId: row.item.unitId, locale: row.item.targetLocale,
    sourceRevisionId: row.item.sourceRevisionId, sourceSnapshotId: row.item.sourceSnapshotId };
}
function translationPayload(): AiTranslationCommandPayload {
  const { resultId: _result, recoveryUnitId: _recovery, ...target } = candidatePayload();
  return { ...target, kind: "ai-translation-target" };
}
function previewPayload() {
  const current = owner.current();
  return { kind: "ai-preparation" as const, editSeq: current.editSeq, locale: current.locale, unitIds: [...current.selected] };
}
function startPayload() { const current = owner.current(); return { kind: "ai-start" as const, attemptId: current.prepared!.attemptId, editSeq: current.editSeq }; }
function startPendingPayload() { const entry = owner.current().pendingStart!; return { kind: "ai-start-pending" as const, attemptId: entry.request.attemptId, editSeq: entry.editSeq }; }
function adoptionPendingPayload() {
  const entry = owner.current().pendingAdopt!;
  return { kind: "ai-adoption-pending" as const, attemptId: entry.request.attemptId, actionId: entry.request.actionId,
    recoveryUnitId: entry.request.unitId, resultId: entry.candidate.resultId };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); navigate.mockClear();
  prepared = { attemptId: aiAttempt, preview: { config: { ...defaultAiConfig, endpoint: "http://127.0.0.1:4000/v1/chat/completions", model: "test-model", credentialEnv: "" },
    recipe: "direct-translation-1", digest: ai.responses.prepared.preview.digest, items: [item] } };
  view = aiViewFixture(item, prepared.preview.config);
  let nextIdentity = 910;
  invoke.mockReset(); invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: item.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: item.sourceSnapshotId, scope: { revision: "2", currentSnapshot: item.sourceSnapshotId },
      rows: [sourceRowFixture({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId }, { key: item.nativeKey, text: item.sourceText })] });
    if (command === "preview_ai_translation") { prepared = { ...prepared, preview: { ...prepared.preview, config: payload.request.config as AiConfig } }; view = aiViewFixture(item, prepared.preview.config); return prepared; }
    if (command === "start_ai_translation") return aiAttempt;
    if (command === "read_ai_translation") return structuredClone(view);
    if (command === "create_execution_identity") return fixtureIdentity(nextIdentity++);
    if (command === "prepare_execution_adoption") { action = actionFor(payload.request as unknown as PrepareRequest); return action; }
    if (command === "adopt_execution" || command === "read_execution_receipt") return receiptFor();
    if (command === "cancel_execution_task") return "5";
    if (command === "read_execution_cancellation_action") return null;
    throw new Error(command);
  });
});
afterEach(cleanup);
async function open() {
  const user = userEvent.setup(), rendered = render(<Harness />, project);
  await user.click(screen.getByRole("button", { name: "AI translation" }));
  await screen.findByRole("checkbox", { name: "first: Hello" });
  act(() => { owner.setConfig(prepared.preview.config); owner.setSelected([item.unitId]); });
  await waitFor(() => expect(registry.describe("ai.preview", scope, previewPayload())?.availability.enabled).toBe(true));
  return { user, rendered };
}
async function prepareThroughRegistry() {
  await act(async () => { expect(registry.dispatch("ai.preview", scope, previewPayload())).toBe(true); });
  await waitFor(() => expect(owner.current().prepared).not.toBeNull());
  act(() => owner.setConsent(true));
}
async function startThroughRegistry() {
  await prepareThroughRegistry();
  await act(async () => { expect(registry.dispatch("ai.start", scope, startPayload())).toBe(true); });
  await waitFor(() => expect(registry.describe("ai.adopt-result", scope, candidatePayload())?.availability.enabled).toBe(true));
}

it("registers the scoped AI commands and routes preview, confirmed start, and exact editor navigation through them", async () => {
  const { user } = await open(), dispatch = vi.spyOn(registry, "dispatch");
  expect(registry.list(scope).filter(command => command.category === "ai").map(command => command.id).sort()).toEqual([
    "ai.adopt-result", "ai.cancel-task", "ai.check-cancellation", "ai.open-translation", "ai.preview", "ai.reconcile-adoption", "ai.reconcile-start",
    "ai.retry-adoption", "ai.retry-cancellation", "ai.retry-start", "ai.start",
  ]);
  expect(registry.list(scope).filter(command => command.category === "ai").every(command => command.binding === null)).toBe(true);
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await waitFor(() => expect(owner.current().prepared).not.toBeNull());
  expect(registry.describe("ai.start", scope, startPayload())).toMatchObject({ confirmation: "required", availability: { enabled: false } });
  act(() => owner.setConsent(true));
  await user.click(screen.getByRole("button", { name: "Send and generate candidates" }));
  await waitFor(() => expect(registry.describe("ai.open-translation", scope, translationPayload())?.availability.enabled).toBe(true));
  expect(registry.dispatch("ai.open-translation", scope, { ...translationPayload(), sourceRevisionId: fixtureIdentity(998) })).toBe(false);
  expect(registry.dispatch("ai.open-translation", { ...scope, sessionToken: "another-session" }, translationPayload())).toBe(false);
  await user.click(screen.getByRole("button", { name: "Compare and select in editor" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText }, item.targetLocale));
  expect(dispatch.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(["ai.preview", "ai.start", "ai.open-translation"]));
  expect(payloads("preview_ai_translation")[0].unitIds).toEqual([item.unitId]);
  expect(payloads("start_ai_translation")).toEqual([{ ...reads.context, attemptId: aiAttempt, digest: prepared.preview.digest, confirmed: true }]);
});

it("rejects stale preparation and start captures without hiding the owner's configuration validation feedback", async () => {
  const { user } = await open(), originalPreview = previewPayload();
  act(() => owner.setConfig(config => ({ ...config, maxRequests: 0 })));
  expect(registry.dispatch("ai.preview", scope, originalPreview)).toBe(false);
  await user.click(screen.getByRole("button", { name: "Preview what will be sent" }));
  await waitFor(() => expect(owner.failure).toBe("ai-limits"));
  expect(calls("preview_ai_translation")).toHaveLength(0);
  act(() => owner.setConfig(prepared.preview.config)); await prepareThroughRegistry();
  const captured = startPayload();
  act(() => owner.setConfig(config => ({ ...config, model: "newer-model" })));
  expect(owner.prepared).toBeNull(); expect(owner.consent).toBe(false);
  expect(registry.dispatch("ai.start", scope, captured)).toBe(false); expect(calls("start_ai_translation")).toHaveLength(0);
});

it("keeps the complete ordered selection rather than shrinking preparation to the current content page", async () => {
  await open();
  const second = { ...item, unitId: fixtureIdentity(303), sourceRevisionId: fixtureIdentity(304), nativeKey: "second", sourceText: "Second source" };
  act(() => owner.setSelected([second.unitId, item.unitId]));
  const payload = previewPayload(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, request: { request: { config: AiConfig } }) => command === "preview_ai_translation"
    ? Promise.resolve({ ...prepared, preview: { ...prepared.preview, config: request.request.config, items: [second, item] } }) : original(command, request));
  expect(registry.dispatch("ai.preview", scope, { ...payload, unitIds: [...payload.unitIds].reverse() })).toBe(false);
  await act(async () => { expect(registry.dispatch("ai.preview", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner.prepared?.preview.items.map(row => row.unitId)).toEqual(payload.unitIds));
  expect(payloads("preview_ai_translation")[0].unitIds).toEqual([second.unitId, item.unitId]);
  expect(owner.selected).toEqual(payload.unitIds);
});

it("restores preview presentation from the current locale props without requiring an unrelated Query refresh", async () => {
  const { rendered } = await open();
  const original = previewPayload(), contentReads = calls("read_source_content").length;
  const removed = { ...project, metadata: { ...project.metadata, targetLocales: [], metadataRevision: "2" } };
  rendered.rerender(<Harness project={removed} />, removed);
  expect(screen.getByRole("button", { name: "Preview what will be sent" })).toBeDisabled();
  expect(registry.describe("ai.preview", scope, original)?.availability.enabled).toBe(false);
  rendered.rerender(<Harness project={project} />, project);
  expect(screen.getByRole("button", { name: "Preview what will be sent" })).toBeEnabled();
  expect(registry.describe("ai.preview", scope, original)?.availability.enabled).toBe(true);
  expect(owner.config.model).toBe("test-model"); expect(owner.selected).toEqual(original.unitIds);
  expect(calls("read_source_content")).toHaveLength(contentReads);
  expect(calls("preview_ai_translation")).toHaveLength(0); expect(calls("start_ai_translation")).toHaveLength(0);
});

it.each(["loading", "error", "invalidated"] as const)("does not authorize a cached candidate or navigation while its exact Query is %s", async phase => {
  await open(); await startThroughRegistry();
  const payload = candidatePayload(), queryKey = reads.key(["aiCommands", aiAttempt]), original = invoke.getMockImplementation()!;
  const response = deferred<AiView>();
  invoke.mockImplementation((command: string, request: unknown) => command === "read_ai_translation"
    ? phase === "error" ? Promise.reject(new Error("Result read failed")) : response.promise : original(command, request));
  if (phase === "invalidated") act(() => { void reads.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" }); });
  else {
    act(() => { void reads.client.refetchQueries({ queryKey, exact: true }); });
    await waitFor(() => expect(reads.client.getQueryState(queryKey)?.[phase === "loading" ? "fetchStatus" : "status"]).toBe(phase === "loading" ? "fetching" : "error"));
  }
  expect(registry.describe("ai.adopt-result", scope, payload)?.availability.enabled).toBe(false);
  expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(false);
  expect(registry.dispatch("ai.open-translation", scope, translationPayload())).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(0); expect(navigate).not.toHaveBeenCalled();
  if (phase === "loading") await act(async () => { response.resolve(view); });
});

it.each(["hidden", "unmounted"] as const)("reserves adoption before identity and continues its fixed capture after the consumer is %s", async phase => {
  const { user, rendered } = await open(); await startThroughRegistry();
  const payload = candidatePayload(), response = deferred<string>(), original = invoke.getMockImplementation()!;
  for (const field of ["attemptId", "taskId", "itemId", "resultId", "recoveryUnitId", "translationUnitId", "sourceRevisionId", "sourceSnapshotId"] as const)
    expect(registry.dispatch("ai.adopt-result", scope, { ...payload, [field]: fixtureIdentity(999) })).toBe(false);
  invoke.mockImplementation((command: string, request: unknown) => command === "create_execution_identity" ? response.promise : original(command, request));
  act(() => {
    expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(true);
    expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(false);
  });
  expect(calls("create_execution_identity")).toHaveLength(1);
  if (phase === "hidden") {
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    expect(reads.client.getQueryState(reads.key(["aiCommands", aiAttempt]))?.isInvalidated).toBe(true);
  } else rendered.rerender(<Harness mounted={false} />, project);
  expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(false);
  await act(async () => { response.resolve(fixtureIdentity(930)); });
  await waitFor(() => expect(owner.current().saved[payload.resultId]).toEqual(receiptFor()));
  rendered.rerender(<Harness />, project);
  expect(owner.pendingAdopt).toBeNull(); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(payloads("prepare_execution_adoption")).toEqual([{ ...reads.context, attemptId: payload.attemptId,
    actionId: fixtureIdentity(930), unitId: payload.recoveryUnitId, resultIds: [payload.resultId] }]);
  expect(calls("adopt_execution")).toHaveLength(1);
});

it.each(["before-dispatch", "during-identity"] as const)("honors the shared task cancellation reservation %s without waiting for a consumer render", async phase => {
  await open(); await startThroughRegistry();
  const payload = candidatePayload(), response = deferred<string>(), cancellation = deferred<string>(), original = invoke.getMockImplementation()!;
  let identifying = 0;
  invoke.mockImplementation((command: string, request: unknown) => command === "cancel_execution_task" ? cancellation.promise
    : command === "create_execution_identity" && ++identifying === 1 ? response.promise : original(command, request));
  if (phase === "before-dispatch") act(() => {
    void tasks.cancel({ taskId: aiTask, attemptId: aiAttempt, origin: "tasks" });
    expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(false);
  });
  else act(() => {
    expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(true);
    void tasks.cancel({ taskId: aiTask, attemptId: aiAttempt, origin: "tasks" });
  });
  await act(async () => { response.resolve(fixtureIdentity(932)); });
  expect(calls("prepare_execution_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
  await act(async () => { cancellation.resolve("5"); });
});

it.each(["changed-candidate", "read-error", "semantic-source", "retired", "replacement"] as const)("blocks adoption continuation after %s during identity", async phase => {
  const { rendered } = await open(); await startThroughRegistry();
  const payload = candidatePayload(), response = deferred<string>(), original = invoke.getMockImplementation()!, originalReads = reads;
  invoke.mockImplementation((command: string, request: unknown) => command === "create_execution_identity" ? response.promise
    : command === "read_ai_translation" && phase === "read-error" ? Promise.reject(new Error("Result read failed")) : original(command, request));
  act(() => { expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(true); });
  if (phase === "changed-candidate") {
    const changed = structuredClone(view), nextResult = fixtureIdentity(999);
    changed.rows[0].resultId = nextResult; changed.detail.items[0].resultId = nextResult; changed.detail.recovery.units[0].resultIds = [nextResult];
    act(() => reads.client.setQueryData(reads.key(["aiCommands", aiAttempt]), changed));
  } else if (phase === "read-error") {
    await act(async () => { await reads.client.refetchQueries({ queryKey: reads.key(["aiCommands", aiAttempt]), exact: true }); });
    await waitFor(() => expect(reads.client.getQueryState(reads.key(["aiCommands", aiAttempt]))?.status).toBe("error"));
  } else if (phase === "semantic-source") act(() => reads.invalidate(["source"]));
  else if (phase === "retired") act(() => reads.retire());
  else { const replacement = { ...project, sessionToken: "replacement" }; rendered.rerender(<Harness project={replacement} />, replacement); }
  await act(async () => { response.resolve(fixtureIdentity(931)); });
  expect(calls("prepare_execution_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
  expect(owner.current().saved).toEqual({});
  if (phase === "replacement") expect(originalReads).not.toBe(reads);
});

it.each([
  ["identity", "failure"], ["identity", "contradiction"],
  ["prepare", "failure"], ["prepare", "contradiction"],
] as const)("does not revive Q1 after a replacement Query supplies %s-wait evidence (%s) and is removed", async (phase, evidence) => {
  const { rendered } = await open(); await startThroughRegistry();
  const payload = candidatePayload(), cache = reads.client.getQueryCache(), queryKey = reads.key(["aiCommands", aiAttempt]);
  const first = cache.find({ queryKey, exact: true }), counts = observeQuerySubscriptions();
  const response = deferred<string | AdoptionAction>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, request: { request: PrepareRequest }) => {
    if (phase === "identity" && command === "create_execution_identity") return response.promise;
    if (phase === "prepare" && command === "prepare_execution_adoption") { action = actionFor(request.request); return response.promise; }
    return original(command, request);
  });
  act(() => { expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(true); });
  if (phase === "prepare") await waitFor(() => expect(calls("prepare_execution_adoption")).toHaveLength(1));
  expect(counts.subscribed).toBe(1); expect(counts.disposed).toBe(0);
  rendered.rerender(<Harness mounted={false} />, project);
  act(() => reads.client.removeQueries({ queryKey, exact: true }));
  expect(cache.find({ queryKey, exact: true })).toBeUndefined();
  if (evidence === "failure") {
    await act(async () => {
      await expect(reads.client.fetchQuery<AiView>({ queryKey, retry: false, queryFn: () => Promise.reject(new Error("Replacement result read failed")) }))
        .rejects.toThrow("Replacement result read failed");
    });
  } else {
    const contradictory = structuredClone(view), otherResult = fixtureIdentity(997);
    contradictory.rows[0].resultId = otherResult; contradictory.detail.items[0].resultId = otherResult;
    contradictory.detail.recovery.units[0].resultIds = [otherResult];
    await act(async () => { await reads.client.fetchQuery({ queryKey, retry: false, queryFn: async () => contradictory }); });
  }
  const replacement = cache.find({ queryKey, exact: true });
  expect(replacement).toBeDefined(); expect(replacement).not.toBe(first);
  expect(replacement?.state.status).toBe(evidence === "failure" ? "error" : "success");
  act(() => reads.client.removeQueries({ queryKey, exact: true }));
  expect(cache.find({ queryKey, exact: true })).toBeUndefined();
  await act(async () => { response.resolve(phase === "identity" ? fixtureIdentity(934) : action); });
  await waitFor(() => expect(owner.current().busy).toBe(false));
  expect(calls("adopt_execution")).toHaveLength(0);
  expect(calls("prepare_execution_adoption")).toHaveLength(phase === "identity" ? 0 : 1);
  if (phase === "prepare") expect(owner.pendingAdopt).toMatchObject({ uncertain: true, action, retryAllowed: false });
  else expect(owner.pendingAdopt).toBeNull();
  expect(counts.disposed).toBe(1);
  const delivered = counts.events;
  act(() => reads.client.setQueryData(queryKey, view));
  expect(counts.events).toBe(delivered);
});

it("continues a checked capture through ordinary eviction, ignores a different exact key, and releases its temporary witness", async () => {
  const { rendered } = await open(); await startThroughRegistry();
  const payload = candidatePayload(), queryKey = reads.key(["aiCommands", aiAttempt]), counts = observeQuerySubscriptions();
  const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, request: unknown) => command === "create_execution_identity" ? response.promise : original(command, request));
  act(() => { expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(true); });
  expect(counts.subscribed).toBe(1);
  rendered.rerender(<Harness mounted={false} />, project);
  act(() => {
    reads.client.removeQueries({ queryKey, exact: true });
    // A longer key shares the original prefix, but is not this exact witness.
    reads.client.setQueryData([...queryKey, "other-view"], { unrelated: true });
  });
  await act(async () => { response.resolve(fixtureIdentity(935)); });
  await waitFor(() => expect(owner.saved[payload.resultId]).toEqual(receiptFor()));
  expect(calls("prepare_execution_adoption")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(1);
  expect(counts.disposed).toBe(1);
  const delivered = counts.events;
  act(() => reads.client.setQueryData(queryKey, view));
  expect(counts.events).toBe(delivered);
});

it("releases the flight witness immediately when its owner is destroyed, before the identity wait ends", async () => {
  const { rendered } = await open(); await startThroughRegistry();
  const payload = candidatePayload(), queryKey = reads.key(["aiCommands", aiAttempt]), originalReads = reads, counts = observeQuerySubscriptions();
  const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, request: unknown) => command === "create_execution_identity" ? response.promise : original(command, request));
  act(() => { expect(registry.dispatch("ai.adopt-result", scope, payload)).toBe(true); });
  expect(counts.subscribed).toBe(1);
  rendered.unmount();
  expect(counts.disposed).toBe(1);
  const delivered = counts.events;
  act(() => originalReads.client.setQueryData(queryKey, view));
  expect(counts.events).toBe(delivered);
  await act(async () => { response.resolve(fixtureIdentity(936)); });
  expect(calls("prepare_execution_adoption")).toHaveLength(0); expect(calls("adopt_execution")).toHaveLength(0);
  expect(counts.disposed).toBe(1);
});

it("retains an unknown start and uses the exact Registry recovery request after rejected replay and locale removal", async () => {
  const { rendered } = await open(); await prepareThroughRegistry();
  const original = invoke.getMockImplementation()!; let starts = 0, lookups = 0;
  invoke.mockImplementation((command: string, request: unknown) => command === "read_ai_start_action"
    ? Promise.resolve(++lookups <= 2 ? null : {projectId:project.metadata.projectId,attemptId:prepared.attemptId,taskId:view.detail.taskId,digest:prepared.preview.digest})
    : command === "start_ai_translation"
    ? Promise.reject(++starts === 1 ? new Error("Lost start acknowledgement") : { code: "busy", outcome: "rejected", stage: "execution-read", reason: "execution-storage", recoveryRequired: false }) : original(command, request));
  await act(async () => { expect(registry.dispatch("ai.start", scope, startPayload())).toBe(true); });
  await waitFor(() => expect(owner.pendingStart?.uncertain).toBe(true));
  const request = owner.pendingStart!.request, payload = startPendingPayload(), removed = { ...project, metadata: { ...project.metadata, targetLocales: [] } };
  rendered.rerender(<Harness project={removed} />, removed);
  expect(registry.dispatch("ai.retry-start", scope, { ...payload, attemptId: fixtureIdentity(999) })).toBe(false);
  await act(async () => { expect(registry.dispatch("ai.retry-start", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner.pendingStart?.uncertain).toBe(true));
  expect(owner.pendingStart!.request).toBe(request);
  await act(async () => { expect(registry.dispatch("ai.reconcile-start", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner.pendingStart).toBeNull());
  expect(owner.attempt).toBe(request.attemptId); expect(payloads("start_ai_translation")).toEqual([request, request]);
  expect(calls("create_execution_identity")).toHaveLength(0);
});

it("settles a Registry adoption A without replacing newer B even when the subsequent result read fails", async () => {
  const { user } = await open(); await startThroughRegistry();
  const response = deferred<Receipt>(), original = invoke.getMockImplementation()!;
  let acknowledged = false;
  invoke.mockImplementation((command: string, request: unknown) => command === "adopt_execution" ? response.promise
    : command === "read_ai_translation" && acknowledged ? Promise.reject(new Error("Saved result read failed")) : original(command, request));
  await user.click(screen.getByRole("button", { name: "Save candidate" }));
  await waitFor(() => expect(calls("adopt_execution")).toHaveLength(1));
  const request = owner.pendingAdopt!.request, resultId = candidatePayload().resultId;
  act(() => { owner.setConfig(config => ({ ...config, model: "model-B" })); owner.setSelected([fixtureIdentity(933)]); owner.setPresetName("local"); });
  await act(async () => { acknowledged = true; response.resolve(receiptFor()); });
  await waitFor(() => expect(reads.client.getQueryState(reads.key(["aiCommands", aiAttempt]))?.status).toBe("error"));
  expect(owner.saved[resultId]).toEqual(receiptFor()); expect(owner.pendingAdopt).toBeNull();
  expect(owner.config.model).toBe("model-B"); expect(owner.presetName).toBe("local"); expect(owner.selected).toEqual([fixtureIdentity(933)]);
  expect(owner.dirty).toBe(true); expect(owner.notice).toBe("newer");
  expect(payloads("prepare_execution_adoption")).toEqual([request]); expect(calls("adopt_execution")).toHaveLength(1);
});

it("requires an exact absent receipt before Registry adoption retry", async () => {
  await open(); await startThroughRegistry();
  const original = invoke.getMockImplementation()!; let adoptions = 0,lookups = 0;
  invoke.mockImplementation((command: string, request: unknown) => command === "adopt_execution"
    ? (++adoptions === 1 ? Promise.reject(new Error("Lost adoption acknowledgement")) : original(command, request))
    : command === "read_execution_adoption_action" ? ++lookups === 1 ? Promise.reject(new Error("Automatic lookup unavailable")) : Promise.resolve(null) : original(command, request));
  await act(async () => { expect(registry.dispatch("ai.adopt-result", scope, candidatePayload())).toBe(true); });
  await waitFor(() => expect(owner.pendingAdopt?.uncertain).toBe(true));
  const payload = adoptionPendingPayload(), request = owner.pendingAdopt!.request;
  expect(registry.dispatch("ai.retry-adoption", scope, payload)).toBe(false);
  expect(registry.dispatch("ai.reconcile-adoption", scope, { ...payload, actionId: fixtureIdentity(999) })).toBe(false);
  await act(async () => { expect(registry.dispatch("ai.reconcile-adoption", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner.pendingAdopt?.retryAllowed).toBe(true));
  await act(async () => { expect(registry.dispatch("ai.retry-adoption", scope, payload)).toBe(true); });
  await waitFor(() => expect(owner.pendingAdopt).toBeNull());
  expect(payloads("prepare_execution_adoption")).toEqual([request, request]); expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("adopt_execution")).toHaveLength(2);
});

it("reconciles a checked Registry receipt without dispatching adoption again", async () => {
  await open(); await startThroughRegistry();
  const original = invoke.getMockImplementation()!; let lookups = 0;
  invoke.mockImplementation((command: string, request: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Lost adoption acknowledgement"))
    : command === "read_execution_adoption_action" ? ++lookups === 1 ? Promise.reject(new Error("Automatic lookup unavailable")) : Promise.resolve({action,receipt:receiptFor()}) : original(command, request));
  await act(async () => { expect(registry.dispatch("ai.adopt-result", scope, candidatePayload())).toBe(true); });
  await waitFor(() => expect(owner.pendingAdopt?.uncertain).toBe(true));
  await act(async () => { expect(registry.dispatch("ai.reconcile-adoption", scope, adoptionPendingPayload())).toBe(true); });
  await waitFor(() => expect(owner.pendingAdopt).toBeNull());
  expect(calls("adopt_execution")).toHaveLength(1); expect(owner.saved[candidatePayload().resultId]).toEqual(receiptFor());
});

it.each(["button", "registry"] as const)("keeps exact original Task cancellation available through %s during a deferred invalidated view refetch", async route => {
  const { user } = await open(); await startThroughRegistry();
  view = { ...view, detail: { ...view.detail, progress: { ...view.detail.progress, queued: 1, succeeded: 0 } } };
  const queryKey = reads.key(["aiCommands", aiAttempt]);
  await act(async () => { await reads.client.refetchQueries({ queryKey, exact: true }); });
  const button = await screen.findByRole("button", { name: "Cancel remaining work" });
  expect(button).toBeEnabled(); expect(owner.started?.taskId).toBe(aiTask);
  const response = deferred<AiView>(), original = invoke.getMockImplementation()!, dispatch = vi.spyOn(registry, "dispatch");
  invoke.mockImplementation((command: string, request: unknown) => command === "read_ai_translation" ? response.promise : original(command, request));
  act(() => { void reads.client.refetchQueries({ queryKey, exact: true }); });
  await waitFor(() => expect(reads.client.getQueryState(queryKey)?.fetchStatus).toBe("fetching"));
  act(() => { void reads.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" }); });
  const payload = { kind: "execution-cancellation" as const, taskId: aiTask, attemptId: aiAttempt, origin: "ai" as const };
  expect(reads.client.getQueryState(queryKey)?.isInvalidated).toBe(true);
  expect(button).toBeEnabled();
  expect(registry.describe("ai.cancel-task", scope, payload)?.availability.enabled).toBe(true);
  expect(registry.dispatch("ai.cancel-task", scope, { ...payload, taskId: fixtureIdentity(998) })).toBe(false);
  expect(registry.dispatch("ai.cancel-task", scope, { ...payload, attemptId: fixtureIdentity(999) })).toBe(false);
  expect(registry.dispatch("ai.cancel-task", scope, { ...payload, origin: "arena" })).toBe(false);
  expect(registry.dispatch("ai.cancel-task", { ...scope, area: "arena" }, payload)).toBe(false);
  expect(registry.dispatch("ai.cancel-task", { ...scope, sessionToken: "other-session" }, payload)).toBe(false);
  expect(registry.dispatch("ai.adopt-result", scope, candidatePayload())).toBe(false);
  expect(registry.dispatch("ai.open-translation", scope, translationPayload())).toBe(false);
  expect(calls("create_execution_identity")).toHaveLength(0);
  if (route === "button") await user.click(button);
  else await act(async () => { expect(registry.dispatch("ai.cancel-task", scope, payload)).toBe(true); });
  await waitFor(() => expect(tasks.current(aiTask)?.phase).toBe("recorded"));
  expect(dispatch.mock.calls).toContainEqual(["ai.cancel-task", scope, payload]);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(payloads("cancel_execution_task")).toEqual([{ ...reads.context, taskId: aiTask, requestId: fixtureIdentity(910) }]);
  expect(reads.client.getQueryState(queryKey)?.fetchStatus).toBe("fetching");
  await act(async () => { response.resolve(view); });
  expect(calls("cancel_execution_task")).toHaveLength(1);
});

it("routes fresh cancellation and original feedback retry through Registry while retaining another origin's exact request", async () => {
  const { user } = await open(); await startThroughRegistry();
  const original = invoke.getMockImplementation()!, dispatch = vi.spyOn(registry, "dispatch"); let cancellations = 0,lookups = 0;
  view = { ...view, detail: { ...view.detail, progress: { ...view.detail.progress, queued: 1, succeeded: 0 } } };
  invoke.mockImplementation((command: string, request: unknown) => command === "cancel_execution_task"
    ? (++cancellations === 1 ? Promise.reject(new Error("Lost cancellation acknowledgement")) : Promise.resolve("5"))
    : command === "read_execution_cancellation_action" ? ++lookups === 1 ? Promise.reject(new Error("Automatic lookup unavailable")) : Promise.resolve(null) : original(command, request));
  await act(async () => { await reads.client.refetchQueries({ queryKey: reads.key(["aiCommands", aiAttempt]), exact: true }); });
  await user.click(await screen.findByRole("button", { name: "Cancel remaining work" }));
  await waitFor(() => expect(tasks.current(aiTask)?.phase).toBe("unknown"));
  const captured = tasks.current(aiTask)!;
  if (captured.phase !== "unknown") throw new Error("Expected original cancellation");
  const pending={kind:"execution-cancellation-retry" as const,...captured.target,requestId:captured.request.requestId};
  expect(registry.dispatch("ai.retry-cancellation",scope,pending)).toBe(false);
  expect(registry.dispatch("ai.check-cancellation",scope,{...pending,requestId:fixtureIdentity(999)})).toBe(false);
  await user.click(screen.getByRole("button",{name:i18n.t("execution.checkCancellation")}));
  await waitFor(()=>expect(tasks.current(aiTask)).toMatchObject({phase:"unknown",retryAllowed:true}));
  expect(dispatch).toHaveBeenCalledWith("ai.check-cancellation",scope,pending);expect(calls("cancel_execution_task")).toHaveLength(1);
  expect(registry.dispatch("ai.retry-cancellation", scope, { kind: "execution-cancellation-retry", ...captured.target, requestId: fixtureIdentity(999) })).toBe(false);
  await user.click(screen.getByRole("button", { name: "Retry the original cancellation" }));
  await waitFor(() => expect(tasks.current(aiTask)?.phase).toBe("recorded"));
  expect(payloads("cancel_execution_task")).toEqual([captured.request, captured.request]);
  expect(dispatch.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(["ai.cancel-task", "ai.retry-cancellation"]));

  const other = { taskId: fixtureIdentity(940), attemptId: fixtureIdentity(941), origin: "arena" as const };
  invoke.mockImplementation((command: string, request: unknown) => command === "cancel_execution_task"
    ? (++cancellations === 3 ? Promise.reject(new Error("Lost other cancellation")) : Promise.resolve("6")) : original(command, request));
  await act(async () => { await tasks.cancel(other); });
  await waitFor(() => expect(tasks.current(other.taskId)?.phase).toBe("unknown"));
  await user.click(screen.getByRole("button", { name: "Retry the original cancellation" }));
  await waitFor(() => expect(tasks.current(other.taskId)?.phase).toBe("recorded"));
  expect(dispatch.mock.calls).toContainEqual(["ai.retry-cancellation", scope, { kind: "execution-cancellation-retry", ...other, requestId: payloads("cancel_execution_task")[2].requestId }]);
  expect(payloads("cancel_execution_task")[3]).toEqual(payloads("cancel_execution_task")[2]);
});

beforeEach(() => {
  const original = invoke.getMockImplementation()!; let checked = -1;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command !== "read_ai_start_action") return original(command,payload);
    const writes = invoke.mock.calls.filter(([name]) => name === "start_ai_translation").length;
    if (checked !== writes) { checked = writes; return Promise.reject(new Error("Automatic start lookup unavailable")); }
    return Promise.resolve({projectId:project.metadata.projectId,attemptId:prepared.attemptId,
      taskId:view.detail.taskId,digest:prepared.preview.digest});
  });
});
