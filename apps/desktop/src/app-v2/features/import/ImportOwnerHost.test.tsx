import { StrictMode, useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationShutdownView, AttemptDetail } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { translationAttemptFixture, translationCaptureFixture, translationCheckerFixture, translationImportChoice,
  translationPreviewFixture, translationProjectionFixture, translationSelectionFixture, translationStageAttempt } from "../../../testSupport/translationFixture";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { TranslationDrafts } from "../editor/translationDrafts";
import ImportOwnerHost from "./ImportOwnerHost";
import type { ImportOwners } from "./importTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "import-owner-session", locator: "/synthetic/import-owner", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Import fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let preview = translationPreviewFixture(), nextIdentity = 50;
let details: Map<string, AttemptDetail>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
beforeEach(() => {
  invoke.mockReset(); preview = translationPreviewFixture(); nextIdentity = 50; details = new Map();
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    const request = payload.request;
    if (command === "create_execution_identity") return fixtureIdentity(nextIdentity++);
    if (command === "select_plugin_translation") return translationSelectionFixture(preview.fixedSourceSnapshotId);
    if (command === "list_plugin_translation_files") return ["zh.json"];
    if (command === "preflight_plugin_translation") return translationCaptureFixture(String(request.attemptId), preview.fixedSourceSnapshotId, "zh-CN", String(request.fileName));
    if (command === "start_plugin_translation") {
      const id = String(request.attemptId); details.set(id, translationStageAttempt(id, "translation-extract")); return id;
    }
    if (command === "prepare_translation_check") return translationCheckerFixture(String(request.attemptId), String(request.translationAttemptId), String(request.translationResultId), preview.fixedSourceSnapshotId);
    if (command === "start_translation_check") {
      const id = String(request.attemptId); details.set(id, translationStageAttempt(id, "translation-semantic-check", "valid")); return id;
    }
    if (command === "finish_translation_check") {
      const id = String(request.translationAttemptId), producer = details.get(id);
      if (producer) details.set(id, translationStageAttempt(id, "translation-extract", "valid"));
      return null;
    }
    if (command === "prepare_translation_projection") {
      preview = { ...preview, attemptId: String(request.attemptId) };
      return translationProjectionFixture(String(request.attemptId), String(request.translationAttemptId), String(request.translationResultId), preview.fixedSourceSnapshotId);
    }
    if (command === "start_translation_projection") {
      details.set(preview.attemptId, translationAttemptFixture(preview)); return request.attemptId;
    }
    if (command === "read_execution_attempt") return details.get(String(request.attemptId)) ?? translationAttemptFixture(preview);
    if (command === "read_translation_preview") return preview;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: preview.currentSourceSnapshotId };
    if (command === "read_plugin_execution_start") return null;
    throw new Error(command);
  });
});
afterEach(cleanup);

async function harness(strict = false) {
  const ports = { open: vi.fn(async () => project), read: vi.fn(async () => project), close: vi.fn(async () => ({ closed: true })),
    status: vi.fn(async () => ({ active: false, quiescing: false, queryCount: 0, error: null })),
    stopCleanup: vi.fn(async (request: { actionId: string }): Promise<ApplicationShutdownView> => ({ ...request, state: "stopped" })),
    actionId: () => fixtureIdentity(950) };
  const lifecycle = new ProjectLifecycle(ports); expect(await lifecycle.open(project.locator)).toBe(true);
  const session = lifecycle.getSnapshot().session!;
  const drafts = new TranslationDrafts({ context: session.reads.context, reads: session.reads, ports: { list: async () => ({ items: [], next: null }) } });
  expect(await drafts.initialize()).toBe(true);
  let current: ImportOwners | null = null;
  const onOwners = vi.fn((value: ImportOwners | null) => { current = value; }), onReveal = vi.fn(), register = vi.spyOn(lifecycle, "register");
  const content = <SessionReadProvider context={session.reads.context} reads={session.reads} bridge={false}>
    <FeedbackHarness drafts={drafts} lifecycle={lifecycle} onOwners={onOwners} onReveal={onReveal}/>
  </SessionReadProvider>;
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content);
  await waitFor(() => expect(current).not.toBeNull());
  const participant = register.mock.calls[0][0];
  return { ports, lifecycle, session, drafts, view, participant, onOwners, onReveal, owners: () => {
    if (!current) throw new Error("Import owner is not mounted"); return current;
  } };
}
function FeedbackHarness(props: { drafts: TranslationDrafts; lifecycle: ProjectLifecycle; onOwners: (value: ImportOwners | null) => void; onReveal: () => void }) {
  const [, retain] = useState<ImportOwners | null>(null);
  return <ImportOwnerHost project={project} drafts={props.drafts} lifecycle={props.lifecycle} onReveal={props.onReveal}
    onOwners={value => { retain(value); props.onOwners(value); }}/>;
}
async function startProducer(h: Awaited<ReturnType<typeof harness>>) {
  await act(async () => {
    const owner = h.owners().imports;
    await owner.chooseFolder(translationImportChoice(preview.fixedSourceSnapshotId)); owner.setFile("zh.json"); owner.confirmLanguage(true);
    await owner.preflight(); owner.consentProducer(true); owner.confirmLanguage(true); await owner.start();
  });
  const id = h.owners().imports.current().extractionAttempt;
  if (!id) throw new Error("Producer did not start");
  await waitFor(() => expect(h.session.reads.client.getQueryData(h.session.reads.key(["translation-plugin-producer", id]))).toBeDefined());
  return id;
}

describe("ImportOwnerHost", () => {
  it("publishes current owners again after StrictMode effect replay", async () => {
    const h = await harness(true);
    expect(h.onOwners).toHaveBeenCalledWith(null); expect(h.onOwners).toHaveBeenLastCalledWith(h.owners());
    act(() => { h.owners().imports.setFile("retained-after-replay.json"); });
    expect(h.owners().imports.current().fileName).toBe("retained-after-replay.json");
    h.view.unmount(); expect(h.onOwners).toHaveBeenLastCalledWith(null); h.lifecycle.dispose();
  });
  it("publishes stable owners without a feedback render loop and closes an idle project", async () => {
    const h = await harness(); expect(h.onOwners).toHaveBeenCalledTimes(1);
    expect(h.participant.inspect({ kind: "close-project" }).status).toBe("ready");
    await act(async () => { expect(await h.lifecycle.close()).toBe(true); });
    expect(h.ports.close).toHaveBeenCalledOnce(); expect(h.lifecycle.getSnapshot().retainedSession).toBeNull();
    h.view.unmount(); expect(h.onOwners).toHaveBeenLastCalledWith(null); h.lifecycle.dispose();
  });

  it("keeps producer, checker and projection reads alive without a visible consumer and opens the checked first preview", async () => {
    const h = await harness(), producerId = await startProducer(h);
    await act(async () => { await h.owners().imports.prepareCheck(fixtureIdentity(800)); h.owners().imports.consentChecker(true); await h.owners().imports.startCheck(); });
    const checkerId = h.owners().imports.current().checkAttempt;
    await waitFor(() => expect(h.session.reads.client.getQueryData(h.session.reads.key(["translation-plugin-checker", checkerId]))).toBeDefined());
    await act(async () => { await h.owners().imports.finishCheck(fixtureIdentity(800)); });
    await act(async () => { await h.owners().imports.prepareProjection(fixtureIdentity(800)); await h.owners().imports.startProjection(); });
    await waitFor(() => expect(h.owners().imports.current().preview?.attemptId).toBe(preview.attemptId));
    expect(h.session.reads.client.getQueryData(h.session.reads.key(["translation-plugin-producer", producerId]))).toBeDefined();
    expect(h.session.reads.client.getQueryData(h.session.reads.key(["translation-plugin-projection", preview.attemptId]))).toBeDefined();
    expect(h.session.reads.client.getQueryData(h.session.reads.key(["translation-import-preview", preview.attemptId, 0, 50, null]))).toEqual(preview);
    expect(h.owners().imports.hasActive()).toBe(false); h.lifecycle.dispose();
  });

  it("blocks project exit for hidden activity while allowing presentation navigation and observes its terminal update", async () => {
    const h = await harness(), native = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, payload) => {
      const value = await native(command, payload);
      if (command === "start_plugin_translation") {
        const detail = details.get(String(value))!;
        details.set(String(value), { ...detail, progress: { ...detail.progress, succeeded: 0, queued: 1 },
          items: detail.items.map(item => ({ ...item, resultId: null, status: { ...item.status, execution: "queued" } })) });
      }
      return value;
    });
    const id = await startProducer(h);
    for (const kind of ["navigate", "language", "close-view", "restore"] as const) expect(h.participant.inspect({ kind }).status).toBe("ready");
    await act(async () => { expect(await h.lifecycle.close()).toBe(false); });
    expect(h.ports.close).not.toHaveBeenCalled(); expect(h.onReveal).toHaveBeenCalled();
    details.set(id, translationStageAttempt(id, "translation-extract"));
    await act(async () => { h.session.reads.invalidate(["execution"]); });
    await waitFor(() => expect(h.owners().imports.hasActive()).toBe(false));
    await act(async () => { expect(await h.lifecycle.close()).toBe(true); });
    expect(h.ports.close).toHaveBeenCalledOnce(); h.lifecycle.dispose();
  });

  it("keeps settled task facts stable after Core close clears reads while application cleanup is pending", async () => {
    const h = await harness(); await startProducer(h);
    await waitFor(() => expect(h.owners().imports.hasActive()).toBe(false));
    const before = h.participant.inspect({ kind: "close-window" }), stopped = deferred<ApplicationShutdownView>();
    h.ports.stopCleanup.mockImplementationOnce(() => stopped.promise);
    const destroy = vi.fn(async () => {}); let closing!: Promise<boolean>;
    act(() => { closing = h.lifecycle.closeWindow(destroy); });
    await waitFor(() => expect(h.ports.stopCleanup).toHaveBeenCalledOnce());
    expect(h.session.reads.retired).toBe(true); expect(h.owners().imports.hasActive()).toBe(true);
    expect(h.participant.inspect({ kind: "close-window" })).toEqual(before);
    await act(async () => { stopped.resolve({ actionId: fixtureIdentity(950), state: "stopped" }); expect(await closing).toBe(true); });
    expect(destroy).toHaveBeenCalledOnce(); expect(h.lifecycle.getSnapshot().retainedSession).toBeNull(); h.lifecycle.dispose();
  });

  it("still revokes the close permit for new import input before the late Core acknowledgement", async () => {
    const h = await harness(), closed = deferred<{ closed: boolean }>(); h.ports.close.mockImplementationOnce(() => closed.promise);
    const destroy = vi.fn(async () => {}); let closing!: Promise<boolean>;
    act(() => { closing = h.lifecycle.closeWindow(destroy); });
    await waitFor(() => expect(h.ports.close).toHaveBeenCalledOnce());
    act(() => { h.owners().imports.setStrategy(true); });
    await act(async () => { closed.resolve({ closed: true }); expect(await closing).toBe(false); });
    expect(h.lifecycle.getSnapshot().retainedSession).toBe(h.session);
    expect(h.ports.stopCleanup).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
    expect(h.owners().imports.current().selectIfEmpty).toBe(true); h.lifecycle.dispose();
  });

  it("preserves an unknown original start and blocks project or window exit without replaying it", async () => {
    const h = await harness(), native = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, payload) => command === "start_plugin_translation" ? Promise.reject(new Error("Lost start ACK"))
      : command === "read_plugin_execution_start" ? Promise.reject(new Error("Lookup unavailable")) : native(command, payload));
    await act(async () => {
      const owner = h.owners().imports;
      await owner.chooseFolder(translationImportChoice(preview.fixedSourceSnapshotId)); owner.setFile("zh.json"); owner.confirmLanguage(true);
      await owner.preflight(); owner.consentProducer(true); owner.confirmLanguage(true); await owner.start();
    });
    const pending = structuredClone(h.owners().imports.current().pendingStart);
    expect(pending).not.toBeNull(); expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
    await act(async () => { expect(await h.lifecycle.close()).toBe(false); expect(await h.lifecycle.open("/synthetic/other")).toBe(false);
      expect(await h.lifecycle.closeWindow(async () => {})).toBe(false); });
    expect(h.onReveal).toHaveBeenCalled(); expect(h.ports.close).not.toHaveBeenCalled(); expect(h.ports.open).toHaveBeenCalledOnce();
    expect(calls("start_plugin_translation")).toHaveLength(1); expect(h.owners().imports.current().pendingStart).toEqual(pending);
    h.lifecycle.dispose(); expect(h.participant.inspect({ kind: "close-project" }).status).toBe("blocked");
  });

  it("keeps the task owner's original unknown cancellation blocked after read retirement", async () => {
    const h = await harness(), native = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, payload) => command === "cancel_execution_task" ? Promise.reject(new Error("Lost cancellation ACK"))
      : command === "read_execution_cancellation_action" ? Promise.resolve(null) : native(command, payload));
    const target = { taskId: fixtureIdentity(960), attemptId: preview.attemptId, origin: "tasks" as const };
    await act(async () => { await h.owners().tasks.cancel(target); });
    const pending = structuredClone(h.owners().tasks.current(target.taskId));
    expect(pending?.phase).toBe("unknown"); expect(h.owners().imports.hasPending()).toBe(false);
    await act(async () => { expect(await h.lifecycle.close()).toBe(false); });
    expect(h.ports.close).not.toHaveBeenCalled(); expect(h.onReveal).toHaveBeenCalled();
    const before = h.participant.inspect({ kind: "close-window" });
    await act(async () => { h.session.reads.retire(); });
    expect(h.participant.inspect({ kind: "close-window" })).toEqual(before);
    await act(async () => { await h.owners().tasks.retry(target.taskId); await h.owners().tasks.cancel({ ...target, taskId: fixtureIdentity(961) }); });
    expect(calls("cancel_execution_task")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
    expect(h.owners().tasks.current(target.taskId)).toEqual(pending); h.lifecycle.dispose();
  });

  it("publishes actual read failures and explicitly retries those reads without dispatching a mutation", async () => {
    const h = await harness(), native = invoke.getMockImplementation()!; let attemptReads = 0, previewReads = 0;
    invoke.mockImplementation((command: string, payload) => command === "read_execution_attempt" && ++attemptReads === 1 ? Promise.reject(new Error("Attempt read unavailable"))
      : command === "read_translation_preview" && ++previewReads === 1 ? Promise.reject(new Error("Preview read unavailable")) : native(command, payload));
    act(() => { h.owners().imports.showAttempt(preview.attemptId); });
    await waitFor(() => expect(h.owners().observation.failure).toMatchObject({ message: "Attempt read unavailable" }));
    act(() => { h.owners().observation.retry(); });
    await waitFor(() => expect(h.owners().observation.failure).toMatchObject({ message: "Preview read unavailable" }));
    act(() => { h.owners().observation.retry(); });
    await waitFor(() => expect(h.owners().imports.current().preview).toEqual(preview));
    expect(h.owners().observation.failure).toBeNull(); expect(h.owners().observation.loading).toBe(false);
    expect(calls("create_execution_identity")).toHaveLength(0); expect(calls("start_translation_projection")).toHaveLength(0);
    expect(calls("read_translation_preview")).toHaveLength(2); h.lifecycle.dispose();
  });

  it("cleans up publication and lifecycle registration before a late read settles", async () => {
    const h = await harness(), attempt = deferred<AttemptDetail>(), native = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, payload) => command === "read_execution_attempt" ? attempt.promise : native(command, payload));
    act(() => { h.owners().imports.showAttempt(preview.attemptId); });
    await waitFor(() => expect(calls("read_execution_attempt")).toHaveLength(1));
    h.view.unmount(); expect(h.onOwners).toHaveBeenLastCalledWith(null);
    const publications = h.onOwners.mock.calls.length;
    await act(async () => { attempt.resolve(translationAttemptFixture(preview)); });
    expect(h.onOwners).toHaveBeenCalledTimes(publications); expect(calls("read_translation_preview")).toHaveLength(0);
    expect(await h.lifecycle.close()).toBe(true); h.lifecycle.dispose();
  });
});
