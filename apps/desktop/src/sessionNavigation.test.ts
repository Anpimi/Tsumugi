import { describe, expect, it, vi } from "vitest";
import { SessionNavigation, type ExitDisposition, type SessionNavigationPorts, type WorkspaceDestination } from "./sessionNavigation";
import type { WorkspaceArea } from "./WorkbenchFrame";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  let live = true, area: WorkspaceArea = "overview";
  let states: ExitDisposition[] = [{ area: "translation", status: "ready", revision: "0" }];
  const presentation = { allowNavigate: vi.fn(async () => true), allowLeave: vi.fn(async (_current?: () => boolean) => true) };
  const ports: SessionNavigationPorts = {
    live: () => live, area: () => area, show: vi.fn((next: WorkspaceArea) => { area = next; }),
    consumer: vi.fn(async (next: WorkspaceArea) => next === "overview" ? null : presentation),
    inspect: () => states, accept: vi.fn(async (_destination: WorkspaceDestination, _current: () => boolean) => true),
    blocked: vi.fn(), busy: vi.fn(), failure: vi.fn(),
  };
  const navigation = new SessionNavigation(ports);
  return { navigation, ports, presentation, replace: () => { live = false; },
    area: () => area, setArea: (value: WorkspaceArea) => { area = value; },
    setStates: (value: ExitDisposition[]) => { states = value; } };
}

describe("project session navigation", () => {
  it("finds a hidden dirty owner and rechecks business state after its dialog", async () => {
    const test = setup();
    test.setStates([{ area: "resources", status: "dirty", revision: "input-A" }]);
    test.presentation.allowLeave.mockImplementation(async current => {
      expect(current?.()).toBe(true);
      test.setStates([{ area: "resources", status: "ready", revision: "discarded-A" }]);
      return true;
    });
    const permit = await test.navigation.prepareExit();
    expect(test.ports.show).toHaveBeenCalledWith("resources");
    expect(test.presentation.allowLeave).toHaveBeenCalledOnce();
    expect(permit?.current()).toBe(true);
    test.setStates([{ area: "resources", status: "dirty", revision: "input-B" }]);
    expect(permit?.current()).toBe(false);
    permit?.release();
    expect(test.ports.busy).toHaveBeenLastCalledWith(false);
  });
  it("opens recovery for a hidden unknown owner without accepting a dialog or replaying anything", async () => {
    const test = setup(); test.setStates([{ area: "tasks", status: "blocked", revision: "original-action" }]);
    expect(await test.navigation.prepareExit()).toBeNull();
    expect(test.ports.blocked).toHaveBeenCalledWith("tasks");
    expect(test.area()).toBe("tasks");
    expect(test.presentation.allowLeave).not.toHaveBeenCalled();
    expect(test.ports.accept).not.toHaveBeenCalled();
    expect(test.ports.busy).toHaveBeenLastCalledWith(false);
  });
  it("does not exit after saving A when a newer B invalidated the dialog capture", async () => {
    const test = setup(); test.setStates([{ area: "translation", status: "dirty", revision: "A" }]);
    const answer = deferred<boolean>(); let proof: (() => boolean) | undefined;
    test.presentation.allowLeave.mockImplementation(async current => { proof = current; return answer.promise; });
    const exit = test.navigation.prepareExit();
    await Promise.resolve(); await Promise.resolve();
    test.setStates([{ area: "translation", status: "dirty", revision: "B" }]);
    expect(proof?.()).toBe(false);
    answer.resolve(false);
    expect(await exit).toBeNull();
    expect(test.ports.busy).toHaveBeenLastCalledWith(false);
  });
  it("holds one synchronous intent through confirmation and through the caller lifecycle command", async () => {
    const test = setup(); test.setStates([{ area: "translation", status: "dirty", revision: "A" }]);
    const answer = deferred<boolean>(); test.presentation.allowLeave.mockImplementation(() => answer.promise);
    const exit = test.navigation.prepareExit();
    expect(await test.navigation.prepareExit()).toBeNull();
    expect(await test.navigation.navigate({ kind: "area", area: "ai" })).toBe(false);
    test.setStates([{ area: "translation", status: "ready", revision: "saved-A" }]); answer.resolve(true);
    const permit = await exit; expect(permit?.current()).toBe(true);
    expect(await test.navigation.navigate({ kind: "area", area: "ai" })).toBe(false);
    permit?.release(); expect(await test.navigation.navigate({ kind: "area", area: "ai" })).toBe(true);
  });
  it.each(["A", "B"])("stops when confirmation leaves unresolved input %s instead of prompting again", async revision => {
    const test = setup(); test.setStates([{ area: "translation", status: "dirty", revision: "A" }]);
    test.presentation.allowLeave.mockImplementation(async () => {
      test.setStates([{ area: "translation", status: "dirty", revision }]);
      return true;
    });
    expect(await test.navigation.prepareExit()).toBeNull();
    expect(test.presentation.allowLeave).toHaveBeenCalledOnce();
    expect(test.ports.failure).toHaveBeenCalledWith("navigation-edited");
    expect(test.ports.busy).toHaveBeenLastCalledWith(false);
    expect(await test.navigation.navigate({ kind: "area", area: "translation" })).toBe(true);
  });
  it("fixes a cross-area target before waiting and accepts it before displaying its consumer", async () => {
    const test = setup(); test.setArea("tasks"); const gate = deferred<boolean>();
    test.presentation.allowNavigate.mockImplementation(() => gate.promise);
    const target = { unitId: "unit", sourceRevisionId: "source", key: "original", sourceText: "source text" };
    const opened = test.navigation.navigate({ kind: "translation", target, locale: "zh-CN" });
    target.key = "newer";
    expect(test.ports.show).not.toHaveBeenCalled(); gate.resolve(true);
    expect(await opened).toBe(true);
    expect(test.ports.accept).toHaveBeenCalledWith({ kind: "translation", target: { ...target, key: "original" }, locale: "zh-CN" }, expect.any(Function));
    expect(vi.mocked(test.ports.accept).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(test.ports.show).mock.invocationCallOrder[0]);
  });
  it("rejects late target reads after the original project session is replaced", async () => {
    const test = setup(); const response = deferred<boolean>();
    test.ports.accept = vi.fn(() => response.promise);
    const opened = test.navigation.navigate({ kind: "attempt", area: "source", attemptId: "original-attempt" });
    await Promise.resolve(); await Promise.resolve();
    test.replace(); response.resolve(true);
    expect(await opened).toBe(false); expect(test.ports.show).not.toHaveBeenCalled();
  });
  it("does not trust one ready owner when an earlier owner changed during another confirmation", async () => {
    const test = setup();
    test.setStates([{ area: "release", status: "ready", revision: "0" }, { area: "resources", status: "dirty", revision: "A" }]);
    let prompts = 0;
    test.presentation.allowLeave.mockImplementation(async () => {
      prompts++;
      if (prompts === 1) { test.setStates([{ area: "release", status: "blocked", revision: "unknown" }, { area: "resources", status: "ready", revision: "discarded" }]); return true; }
      return false;
    });
    expect(await test.navigation.prepareExit()).toBeNull();
    expect(test.ports.show).toHaveBeenLastCalledWith("release");
    expect(test.presentation.allowLeave).toHaveBeenCalledOnce();
  });
  it("preserves the current area when the existing local navigation guard refuses", async () => {
    const test = setup(); test.setArea("source"); test.presentation.allowNavigate.mockResolvedValue(false);
    expect(await test.navigation.navigate({ kind: "area", area: "review" })).toBe(false);
    expect(test.area()).toBe("source"); expect(test.ports.accept).not.toHaveBeenCalled();
  });
  it("freezes the exact saved build before waiting for the current consumer", async () => {
    const test = setup(), wait = deferred<null>(); test.setArea("tasks");
    vi.mocked(test.ports.consumer).mockImplementationOnce(() => wait.promise);
    const destination: Extract<WorkspaceDestination, { kind: "saved-build" }> = { kind: "saved-build", attemptId: "original-build" };
    const opened = test.navigation.navigate(destination); destination.attemptId = "later-build"; wait.resolve(null);
    expect(await opened).toBe(true);
    expect(test.ports.accept).toHaveBeenCalledWith({ kind: "saved-build", attemptId: "original-build" }, expect.any(Function));
    expect(test.area()).toBe("release");
    expect(test.ports.busy).toHaveBeenLastCalledWith(false);
  });
  it("keeps the copied tool text fixed while navigation waits", async () => {
    const test = setup(), wait = deferred<null>(); test.setArea("translation");
    vi.mocked(test.ports.consumer).mockImplementationOnce(() => wait.promise);
    const destination: Extract<WorkspaceDestination, { kind: "tool-query" }> = { kind: "tool-query", text: "Original source text" };
    const opened = test.navigation.navigate(destination); destination.text = "Later edited text"; wait.resolve(null);
    expect(await opened).toBe(true);
    expect(test.ports.accept).toHaveBeenCalledWith({ kind: "tool-query", text: "Original source text" }, expect.any(Function));
    expect(test.area()).toBe("resources");
  });
  it.each([
    { kind: "saved-build", attemptId: "original-build" },
    { kind: "tool-query", text: "Original source text" },
  ] satisfies WorkspaceDestination[])("keeps the current view when the destination owner rejects $kind", async destination => {
    const test = setup(); test.setArea("translation"); vi.mocked(test.ports.accept).mockResolvedValueOnce(false);
    expect(await test.navigation.navigate(destination)).toBe(false);
    expect(test.area()).toBe("translation"); expect(test.ports.show).not.toHaveBeenCalled();
    expect(test.ports.busy).toHaveBeenLastCalledWith(false);
  });

});
