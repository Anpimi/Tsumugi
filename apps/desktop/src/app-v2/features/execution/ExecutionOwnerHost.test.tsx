import { StrictMode, useLayoutEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/executionCommands.contract.json";
import { useExecutionTaskSession } from "../../../ExecutionTaskSession";
import type { ApplicationShutdownView, AttemptDetail } from "../../../executionCommands";
import { validateResponseAttempt } from "../../../generated/execution.validators";
import type { ProjectView } from "../../../projectCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { TranslationDrafts } from "../editor/translationDrafts";
import ExecutionOwnerHost from "./ExecutionOwnerHost";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: fixture.session.sessionToken, locator: "/synthetic/execution-owner", reconciliationState: "settled",
  metadata: { projectId: fixture.session.projectId, displayName: "Task fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
type Tasks = ReturnType<typeof useExecutionTaskSession>;
const cancellation = { taskId: fixture.detail.taskId, attemptId: fixture.detail.attemptId, origin: "tasks" as const };
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
const action = () => ({ ...structuredClone(fixture.action), parameters: null });
function applicationDetail(): AttemptDetail {
  const original = structuredClone(fixture.detail);
  const value = { ...original, progress: { ...original.progress, succeeded: 1, unknown: 0 },
    items: original.items.map(item => ({ ...item, resultId: fixture.prepare.resultIds[0],
      status: { ...item.status, execution: "succeeded", validation: "valid", cancellationRequested: false } })),
    recovery: { ...original.recovery, units: original.recovery.units.map(unit => ({ ...unit,
      actions: ["adopt-result"], blockedReason: null, resultIds: [...fixture.prepare.resultIds], remainingItemIds: [] })) } };
  if (!validateResponseAttempt(value)) throw new Error("Invalid task adoption fixture");
  return value;
}
function Probe({ onOwner }: { onOwner: (value: Tasks) => void }) {
  const owner = useExecutionTaskSession();
  useLayoutEffect(() => { onOwner(owner); });
  return null;
}
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "create_execution_identity") return fixture.prepare.actionId;
    if (command === "prepare_execution_adoption") return action();
    if (command === "adopt_execution") return structuredClone(fixture.receipt);
    if (command === "read_execution_adoption_action" || command === "read_execution_cancellation_action") return null;
    if (command === "cancel_execution_task") return "1";
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
  const opened = lifecycle.getSnapshot().session;
  if (!opened) throw new Error("Project session did not open");
  const session = opened;
  const drafts = new TranslationDrafts({ context: session.reads.context, reads: session.reads, ports: { list: async () => ({ items: [], next: null }) } });
  expect(await drafts.initialize()).toBe(true);
  lifecycle.register(drafts.lifecycleParticipant());
  const owners: { left?: Tasks; right?: Tasks } = {}, onReveal = vi.fn(), register = vi.spyOn(lifecycle, "register");
  function tree(visible = true, reveal = onReveal) {
    const content = <SessionReadProvider context={session.reads.context} reads={session.reads} bridge={false}>
      <ExecutionOwnerHost project={project} drafts={drafts} lifecycle={lifecycle} onReveal={reveal}>
        <Probe onOwner={value => { owners.left = value; }}/>
        {visible ? <Probe onOwner={value => { owners.right = value; }}/> : null}
      </ExecutionOwnerHost>
    </SessionReadProvider>;
    return strict ? <StrictMode>{content}</StrictMode> : content;
  }
  const view = render(tree());
  await waitFor(() => expect(owners.left).toBeDefined());
  const participant = [...register.mock.calls].reverse().find(([value]) => value.id === "execution-tasks")?.[0];
  if (!participant) throw new Error("Task lifecycle did not register");
  return { ports, lifecycle, session, drafts, view, tree, participant, register, onReveal, owner: (side: "left" | "right" = "left") => {
    const owner = owners[side]; if (!owner) throw new Error("Task consumer is not mounted"); return owner;
  } };
}
async function confirm(h: Awaited<ReturnType<typeof harness>>) {
  const detail = applicationDetail();
  await act(async () => { await h.owner().begin(detail, detail.recovery.units[0], "adopt-result", 0); });
  expect(h.owner().currentActivity()?.phase).toBe("confirming");
}

describe("ExecutionOwnerHost", () => {
  it("shares one task instance and the real draft reservation across retained consumers and StrictMode replay", async () => {
    const h = await harness(true);
    expect(h.owner("left")).toBe(h.owner("right"));
    await confirm(h);
    expect(h.owner("right").currentActivity()).toBe(h.owner("left").currentActivity());
    const token = h.drafts.reserveMutation();
    if (!token) throw new Error("Draft reservation did not start");
    await act(async () => { await h.owner("right").submit(); });
    expect(h.owner().currentActivity()?.failure).toBe("busy");
    expect(calls("create_execution_identity")).toHaveLength(0);
    h.drafts.releaseMutation(token);
    const registered = h.register.mock.calls.length, latestReveal = vi.fn();
    h.view.rerender(h.tree(true, latestReveal));
    expect(h.register).toHaveBeenCalledTimes(registered);
    h.participant.reveal?.();
    expect(latestReveal).toHaveBeenCalledWith(fixture.detail.operation); expect(h.onReveal).not.toHaveBeenCalled();
    await act(async () => { await h.owner().submit(); });
    expect(h.owner("right").currentActivity()?.phase).toBe("recorded");
    expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
    expect(h.participant.inspect({ kind: "close-project" }).status).toBe("ready");
    expect(calls("adopt_execution")).toHaveLength(1);
    h.view.unmount(); expect(await h.lifecycle.close()).toBe(true); h.lifecycle.dispose();
  });

  it("retains unknown adoption across consumer removal and preserves the real draft coordinator's exclusive navigation guard", async () => {
    const h = await harness(), native = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, payload) => command === "adopt_execution" ? Promise.reject(new Error("Lost adoption ACK")) : native(command, payload));
    await confirm(h);
    await act(async () => { await h.owner().submit(); });
    const original = structuredClone(h.owner().currentActivity());
    expect(original?.phase).toBe("unknown"); expect(h.owner().unresolved()).toBe(true);
    expect(h.drafts.getSnapshot().mutationReserved).toBe(true); expect(h.drafts.reserveMutation()).toBeNull();
    h.view.rerender(h.tree(false));
    for (const kind of ["navigate", "language", "close-view", "restore"] as const) expect(h.participant.inspect({ kind }).status).toBe("ready");
    // The shared Task provider preserves its original exclusive reservation.
    // A ready Task bridge cannot override the real draft owner's independent guard.
    for (const kind of ["navigate", "language", "close-view"] as const) expect(await h.lifecycle.prepareLeave({ kind })).toBeNull();
    const restore = await h.lifecycle.prepareLeave({ kind: "restore" }); expect(restore).not.toBeNull(); restore?.release();
    for (const kind of ["open-project", "close-project", "close-window"] as const) expect(h.participant.inspect({ kind }).status).toBe("blocked");
    await act(async () => { expect(await h.lifecycle.close()).toBe(false); expect(await h.lifecycle.open("/synthetic/other")).toBe(false);
      expect(await h.lifecycle.closeWindow(async () => {})).toBe(false); });
    expect(h.ports.close).not.toHaveBeenCalled(); expect(h.ports.open).toHaveBeenCalledOnce();
    // The joint guard can stop at the draft owner before reaching this bridge.
    h.participant.reveal?.();
    expect(h.onReveal).toHaveBeenCalledWith(fixture.detail.operation);
    expect(h.owner().currentActivity()).toEqual(original);
    expect(calls("adopt_execution")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
    invoke.mockImplementation((command: string, payload) => command === "read_execution_adoption_action"
      ? Promise.resolve({ action: action(), receipt: structuredClone(fixture.receipt) }) : native(command, payload));
    await act(async () => { await h.owner().checkAdoption(); });
    expect(h.owner().currentActivity()?.phase).toBe("recorded"); expect(h.owner().currentActivity()?.prepare).toEqual(original?.prepare);
    expect(h.drafts.getSnapshot().mutationReserved).toBe(false); expect(calls("adopt_execution")).toHaveLength(1);
    await act(async () => { expect(await h.lifecycle.close()).toBe(true); }); h.lifecycle.dispose();
  });

  it("keeps unknown cancellation facts blocked after read retirement and reveals the null-operation recovery route", async () => {
    const h = await harness(), native = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, payload) => command === "cancel_execution_task" ? Promise.reject(new Error("Lost cancellation ACK")) : native(command, payload));
    await act(async () => { await h.owner("right").cancel(cancellation); });
    const original = structuredClone(h.owner().current(cancellation.taskId));
    expect(original?.phase).toBe("unknown"); expect(h.owner().currentActivity()).toBeNull();
    const before = h.participant.inspect({ kind: "close-window" }); expect(before.status).toBe("blocked");
    for (const kind of ["navigate", "language", "close-view", "restore"] as const) {
      expect(h.participant.inspect({ kind }).status).toBe("ready");
      const permit = await h.lifecycle.prepareLeave({ kind }); expect(permit).not.toBeNull(); permit?.release();
    }
    await act(async () => { expect(await h.lifecycle.close()).toBe(false); });
    expect(h.onReveal).toHaveBeenCalledWith(null); expect(h.ports.close).not.toHaveBeenCalled();
    await act(async () => { h.session.reads.retire(); });
    expect(h.participant.inspect({ kind: "close-window" })).toEqual(before);
    await act(async () => { await h.owner().retry(cancellation.taskId); await h.owner().cancel({ ...cancellation, taskId: fixtureIdentity(951) }); });
    expect(calls("cancel_execution_task")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
    expect(h.owner().current(cancellation.taskId)).toEqual(original); h.lifecycle.dispose();
  });
});
