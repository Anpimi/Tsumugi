import { describe, expect, it, vi } from "vitest";
import type { ProjectView } from "../../projectCommands";
import type { ApplicationShutdownView } from "../../executionCommands";
import { ProjectLifecycle, type LifecycleParticipant, type ProjectLifecyclePorts } from "./projectLifecycle";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("Unexpected native request"); }) }));

const first: ProjectView = { sessionToken: "session-a", locator: "/synthetic/a", reconciliationState: "settled",
  metadata: { projectId: "11111111-1111-4111-8111-111111111111", displayName: "Project A", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const second: ProjectView = { ...first, sessionToken: "session-b", locator: "/synthetic/b",
  metadata: { ...first.metadata, projectId: "22222222-2222-4222-8222-222222222222", displayName: "Project B" } };
const idle = { active: false, quiescing: false, queryCount: 0, error: null };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<ProjectLifecyclePorts> = {}) {
  const ports = {
    open: vi.fn(async () => first), read: vi.fn(async () => first), close: vi.fn(async () => ({ closed: true })),
    status: vi.fn(async () => idle), quiesce: vi.fn(async () => idle),
    stopCleanup: vi.fn(async (request: { actionId: string }): Promise<ApplicationShutdownView> => ({ ...request, state: "stopped" })),
    resumeCleanup: vi.fn(async (request: { actionId: string }): Promise<ApplicationShutdownView> => ({ ...request, state: "resumed" })),
    actionId: vi.fn(() => "33333333-3333-4333-8333-333333333333"),
    confirmStop: vi.fn(async () => true),
  };
  return { ports, controller: new ProjectLifecycle({ ...ports, ...overrides }) };
}
function owner(controller: ProjectLifecycle, status: "ready" | "dirty" | "blocked" = "ready") {
  const state = { status, revision: "A" };
  const participant: LifecycleParticipant = { id: "manual", area: "translation", scope: { kind: "project", projectId: first.metadata.projectId, sessionToken: first.sessionToken },
    inspect: () => ({ ...state }), prepareLeave: vi.fn(async () => false), reveal: vi.fn() };
  const unregister = controller.register(participant);
  return { state, participant, unregister };
}

describe("project lifecycle", () => {
  it("shares a real session read owner and blocks hidden unresolved owners before any lifecycle command", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator);
    const session = controller.getSnapshot().session!, hidden = owner(controller, "blocked");
    expect(session.reads.context).toEqual({ projectId: first.metadata.projectId, sessionToken: first.sessionToken });
    expect(await controller.open(second.locator)).toBe(false);
    expect(ports.open).toHaveBeenCalledTimes(1); expect(hidden.participant.reveal).toHaveBeenCalledOnce();
    expect(hidden.participant.prepareLeave).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session).toBe(session);
    expect(controller.getSnapshot().failure).toMatchObject({ code: "leave-blocked", ownerId: "manual" });
    controller.dispose();
  });

  it("holds one leave permit across all entry points and revokes it for new input or a replacement owner", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator);
    const original = owner(controller), permit = await controller.prepareLeave({ kind: "close-view", viewId: "left" });
    expect(permit?.current()).toBe(true);
    expect(await controller.open(second.locator)).toBe(false); expect(ports.open).toHaveBeenCalledTimes(1);
    original.state.revision = "B"; expect(permit?.current()).toBe(false); permit?.release();
    const newer = controller.register({ ...original.participant, inspect: () => ({ status: "dirty", revision: "C" }) });
    original.unregister();
    expect(await controller.prepareLeave({ kind: "language" })).toBeNull();
    newer(); controller.dispose();
  });

  it("rechecks all owners after another owner's preparation and does not commit a stale route", async () => {
    const { controller } = fixture(); await controller.open(first.locator);
    const earlier = owner(controller), later = { status: "dirty" as "ready" | "dirty", revision: "A" };
    controller.register({ id: "knowledge", area: "resources", scope: { kind: "application" }, inspect: () => ({ ...later }),
      prepareLeave: async (_intent, proof) => { expect(proof()).toBe(true); later.status = "ready"; earlier.state.status = "blocked"; return true; } });
    const commit = vi.fn();
    expect(await controller.transition({ kind: "navigate" }, () => true, commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled(); expect(earlier.participant.reveal).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("prepares captured dirty owners in one area in order without admitting newer input or registrations", async () => {
    for (const change of ["none", "input", "registration"] as const) {
      const { controller } = fixture(); await controller.open(first.locator);
      const firstOwner = owner(controller, "dirty"), firstAnswer = deferred<boolean>(), order: string[] = [];
      const imported: { status: "dirty" | "ready"; revision: string } = { status: "dirty", revision: "Import A" };
      firstOwner.participant.prepareLeave = async (_intent, proof, current) => {
        order.push("manual"); expect(proof()).toBe(true); await firstAnswer.promise;
        if (!current()) return false;
        firstOwner.state.status = "ready"; firstOwner.state.revision = "Manual A retained"; return true;
      };
      controller.register({ ...firstOwner.participant, id: "import", inspect: () => imported, prepareLeave: async (_intent, proof) => {
        expect(proof()).toBe(true); order.push("import"); imported.status = "ready"; imported.revision = "Import A retained"; return true;
      } });
      const leaving = controller.prepareLeave({ kind: "close-project" });
      await vi.waitFor(() => expect(order).toEqual(["manual"]));
      if (change === "input") imported.revision = "Import B";
      if (change === "registration") controller.register({ ...firstOwner.participant, id: "new-owner", inspect: () => ({ status: "ready", revision: "New" }) });
      firstAnswer.resolve(true); const permit = await leaving;
      if (change === "none") {
        expect(order).toEqual(["manual", "import"]); expect(permit?.current()).toBe(true);
        imported.status = "dirty"; imported.revision = "Later B";
        expect(permit?.current()).toBe(false); expect(order).toEqual(["manual", "import"]); permit?.release();
      } else {
        expect(permit).toBeNull(); expect(order).toEqual(["manual"]);
        expect(imported.status).toBe("dirty"); expect(imported.revision).toBe(change === "input" ? "Import B" : "Import A");
      }
      controller.dispose();
    }
  });

  it("settles a replacement open ACK while retaining newer input and retiring only the original reads", async () => {
    const opened = deferred<ProjectView>(), { controller, ports } = fixture();
    await controller.open(first.locator); const original = controller.getSnapshot().session!, draft = owner(controller);
    ports.open.mockImplementationOnce(() => opened.promise);
    const operation = controller.open(second.locator); await vi.waitFor(() => expect(ports.open).toHaveBeenCalledTimes(2));
    draft.state.status = "dirty"; draft.state.revision = "Newer B";
    opened.resolve(second); expect(await operation).toBe(false);
    expect(controller.getSnapshot().session?.project).toBe(second);
    expect(controller.getSnapshot().retainedSession).toBe(original);
    expect(original.reads.retired).toBe(true); expect(controller.getSnapshot().session?.reads.retired).toBe(false);
    expect(draft.state.revision).toBe("Newer B"); expect(await controller.open(first.locator)).toBe(false);
    expect(ports.open).toHaveBeenCalledTimes(2);
    expect(controller.discardRetained()).toBe(true); controller.dispose();
  });

  it("settles an already-open session ACK without replacing its read owner or clearing newer input", async () => {
    const opened = deferred<ProjectView>(), { controller, ports } = fixture();
    await controller.open(first.locator); const original = controller.getSnapshot().session!, draft = owner(controller);
    ports.open.mockImplementationOnce(() => opened.promise);
    const operation = controller.open("/synthetic/alias"); await vi.waitFor(() => expect(ports.open).toHaveBeenCalledTimes(2));
    draft.state.status = "dirty"; draft.state.revision = "B";
    opened.resolve({ ...first, metadata: { ...first.metadata, displayName: "Confirmed name", metadataRevision: "2" } });
    expect(await operation).toBe(false);
    expect(controller.getSnapshot().session?.project.metadata.displayName).toBe("Confirmed name");
    expect(controller.getSnapshot().session?.reads).toBe(original.reads); expect(original.reads.retired).toBe(false);
    expect(controller.getSnapshot().retainedSession).toBeNull(); expect(draft.state.revision).toBe("B"); controller.dispose();
  });

  it("retains the original session after a formal open rejection", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator); const session = controller.getSnapshot().session;
    ports.open.mockRejectedValueOnce({ code: "missing-project", stage: "open", outcome: "rejected", recoveryRequired: false });
    expect(await controller.open(second.locator)).toBe(false);
    expect(controller.getSnapshot().session).toBe(session); expect(controller.getSnapshot().pending).toBeNull();
    expect(session?.reads.retired).toBe(false); controller.dispose();
  });

  it("keeps an unknown open blocked after a pure original-token read without replaying open", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator);
    ports.open.mockRejectedValueOnce(new Error("Lost open ACK"));
    expect(await controller.open(second.locator)).toBe(false);
    expect(controller.getSnapshot().pending).toMatchObject({ kind: "open", locator: second.locator });
    expect(await controller.checkPending()).toBe(false);
    expect(ports.read).toHaveBeenCalledWith({ sessionToken: first.sessionToken });
    expect(controller.getSnapshot().pending?.observation).toBe("original-session-open");
    expect(await controller.open(second.locator)).toBe(false); expect(ports.open).toHaveBeenCalledTimes(2); controller.dispose();
  });

  it("settles Core close but preserves newer B and refuses application cleanup or native destruction", async () => {
    const closed = deferred<{ closed: boolean }>(), { controller, ports } = fixture();
    await controller.open(first.locator); const session = controller.getSnapshot().session!, draft = owner(controller), destroy = vi.fn(async () => {});
    ports.close.mockImplementationOnce(() => closed.promise);
    const operation = controller.closeWindow(destroy); await vi.waitFor(() => expect(ports.close).toHaveBeenCalledOnce());
    draft.state.status = "dirty"; draft.state.revision = "B"; closed.resolve({ closed: true });
    expect(await operation).toBe(false); expect(controller.getSnapshot().session).toBeNull();
    expect(controller.getSnapshot().retainedSession).toBe(session); expect(session.reads.retired).toBe(true);
    expect(ports.stopCleanup).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled(); controller.dispose();
  });

  it("does not infer a successful close from session-invalid during pure checking", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator);
    ports.close.mockRejectedValueOnce(new Error("Lost close ACK")); const destroy = vi.fn(async () => {});
    expect(await controller.closeWindow(destroy)).toBe(false);
    ports.read.mockRejectedValueOnce({ code: "session-invalid", stage: "read", outcome: "rejected", recoveryRequired: false });
    expect(await controller.checkPending()).toBe(false);
    expect(controller.getSnapshot().session?.project).toBe(first);
    expect(controller.getSnapshot().pending).toMatchObject({ kind: "close", observation: "original-session-unavailable" });
    expect(await controller.closeWindow(destroy)).toBe(false); expect(ports.close).toHaveBeenCalledOnce();
    expect(ports.stopCleanup).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled(); controller.dispose();
  });

  it("requires explicit runtime-stop consent and closes Core before actual application cleanup and destroy", async () => {
    const order: string[] = [], { controller, ports } = fixture(); await controller.open(first.locator);
    ports.status.mockImplementationOnce(async () => { order.push("status"); return { ...idle, active: true }; });
    ports.confirmStop.mockImplementationOnce(async () => { order.push("confirm"); return true; });
    ports.quiesce.mockImplementationOnce(async () => { order.push("quiesce"); return idle; });
    ports.close.mockImplementationOnce(async () => { order.push("close-core"); return { closed: true }; });
    ports.stopCleanup.mockImplementationOnce(async request => {
      order.push("cleanup"); expect(controller.getSnapshot().session).toBeNull();
      expect(controller.getSnapshot().closingSession?.project).toBe(first);
      return { ...request, state: "stopped" };
    });
    expect(await controller.closeWindow(async () => { order.push("destroy"); })).toBe(true);
    expect(order).toEqual(["status", "confirm", "quiesce", "close-core", "cleanup", "destroy"]);
    expect(controller.getSnapshot().closingSession).toBeNull(); controller.dispose();
  });

  it("does not stop active runtime or close Core when the stop decision is cancelled", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator);
    ports.status.mockResolvedValueOnce({ ...idle, active: true }); ports.confirmStop.mockResolvedValueOnce(false);
    const destroy = vi.fn(async () => {});
    expect(await controller.closeWindow(destroy)).toBe(false);
    expect(controller.getSnapshot().failure?.code).toBe("runtime-active");
    expect(ports.quiesce).not.toHaveBeenCalled(); expect(ports.close).not.toHaveBeenCalled();
    expect(ports.stopCleanup).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled(); controller.dispose();
  });

  it("purely checks unknown runtime stop and requires a new close intent after actual idle is observed", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator);
    ports.status.mockResolvedValueOnce({ ...idle, active: true }); ports.quiesce.mockRejectedValueOnce(new Error("Lost stop response"));
    expect(await controller.close()).toBe(false); expect(controller.getSnapshot().pending?.kind).toBe("runtime");
    expect(await controller.checkPending()).toBe(true); expect(controller.getSnapshot().pending).toBeNull();
    expect(ports.quiesce).toHaveBeenCalledOnce(); expect(ports.close).not.toHaveBeenCalled();
    expect(await controller.close()).toBe(true); expect(ports.close).toHaveBeenCalledOnce(); controller.dispose();
  });

  it("retains a fixed cleanup action while stopped callbacks drain and never closes Core twice", async () => {
    const { controller, ports } = fixture(); await controller.open(first.locator);
    ports.stopCleanup.mockResolvedValueOnce({ actionId: "33333333-3333-4333-8333-333333333333", state: "stopping" });
    const destroy = vi.fn(async () => {});
    expect(await controller.closeWindow(destroy)).toBe(false); expect(destroy).not.toHaveBeenCalled();
    expect(controller.getSnapshot().cleanup?.state).toBe("stopping");
    expect(await controller.closeWindow(destroy)).toBe(true);
    expect(ports.close).toHaveBeenCalledOnce(); expect(ports.actionId).toHaveBeenCalledOnce();
    expect(ports.stopCleanup.mock.calls[0][0]).toBe(ports.stopCleanup.mock.calls[1][0]); expect(destroy).toHaveBeenCalledOnce(); controller.dispose();
  });

  it("never repeats an unknown application stop or destroys on its unknown outcome", async () => {
    const { controller, ports } = fixture(); ports.stopCleanup.mockRejectedValueOnce(new Error("Lost cleanup ACK"));
    const destroy = vi.fn(async () => {});
    expect(await controller.closeWindow(destroy)).toBe(false); expect(await controller.checkPending()).toBe(false);
    expect(await controller.closeWindow(destroy)).toBe(false);
    expect(controller.getSnapshot().pending?.kind).toBe("application-stop");
    expect(ports.stopCleanup).toHaveBeenCalledOnce(); expect(destroy).not.toHaveBeenCalled(); controller.dispose();
  });
});
