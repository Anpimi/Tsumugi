import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHashHistory } from "@tanstack/react-router";
import { InteractionGate } from "./interactionGate";
import { createWorkspaceRouter, parseWorkspaceHref, workspaceViewHref, type WorkspaceGuard } from "./workspaceRouter";
import { createWorkspaceStore } from "./workspaceStore";

const cleanup: (() => void)[] = [];
const projectId = "project-a";
beforeEach(() => window.history.replaceState({ __TSR_index: 0 }, "", "#/"));
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); });

function setup(guard: WorkspaceGuard = async (_transition, current) => ({ current, release: () => undefined }), owner = projectId) {
  const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
  const history = createHashHistory();
  const gate = new InteractionGate();
  const onError = vi.fn();
  const workspace = createWorkspaceRouter({ projectId: owner, store, history, gate, guard, onError });
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; workspace.dispose(); history.destroy(); gate.dispose(); };
  cleanup.push(dispose);
  return { store, history, gate, onError, ...workspace, dispose };
}

describe("guarded workspace routing", () => {
  it("allows only view parameters in restored URLs and keeps search punctuation", async () => {
    window.history.replaceState({ __TSR_index: 0 }, "", "#/view/deep?projectId=project-a&kind=entries&locale=ja&query=A%3FB&focus=unit&queueScopeId=test-only&editing=true&sessionToken=test-only&grant=test-only");
    const workspace = setup();
    expect(await workspace.ready).toBe(true);
    const view = workspace.store.getState().views.deep;
    expect(view).toMatchObject({ locale: "ja", query: "A?B", searchInput: "A?B", focus: "unit", editing: true, queueAnchor: "unit", queueScopeId: null });
    expect(view).not.toHaveProperty("projectId");
    expect(workspaceViewHref(view, projectId)).not.toMatch(/sessionToken|grant|queueScopeId|editing/);
    expect(workspace.history.location.href).toContain("projectId=project-a");
    expect(workspace.history.location.href).not.toMatch(/sessionToken|grant|queueScopeId|editing/);
    expect(parseWorkspaceHref("/view/one?projectId=project-a&query=what?next", "zh-CN", projectId)).toMatchObject({ query: "what?next" });
    expect(parseWorkspaceHref("/outside?projectId=project-a", "zh-CN", projectId)).toBeUndefined();
  });

  it.each(["projectId=another-project&", ""])("does not restore a foreign or unowned address into the current project: %s", ownership => {
    expect(parseWorkspaceHref(`/view/old?${ownership}kind=entries&locale=zh-CN&focus=old-unit`, "zh-CN", projectId)).toBeUndefined();
    expect(parseWorkspaceHref(`/?${ownership}`, "zh-CN", projectId)).toBeUndefined();
  });

  it("rebuilds routing for another project with one fresh default view and no old editing target", async () => {
    const first = setup(); await first.ready;
    await first.navigation.open({ id: "old-project-view", kind: "entries", locale: "zh-CN", focus: "old-unit", editing: true, queueActive: true, queueScopeId: "old-scope" });
    const oldAddress = window.location.hash; first.dispose();
    expect(oldAddress).toContain("focus=old-unit");
    const second = setup(undefined, "project-b"); expect(await second.ready).toBe(true);
    expect(second.store.getState().viewOrder).toEqual(["one"]);
    expect(second.store.getState().views.one).toMatchObject({ focus: null, editing: false, queueActive: false, queueScopeId: null });
    expect(window.location.hash).toContain("projectId=project-b");
    expect(window.location.hash).not.toMatch(/old-unit|old-project-view|old-scope/);
    expect(first.store.getState().views["old-project-view"]).toMatchObject({ focus: "old-unit", queueScopeId: "old-scope" });
  });

  it("uses an owned address when the last view closes without serializing a project into view state", async () => {
    const workspace = setup(); await workspace.ready;
    expect(await workspace.navigation.close("one")).toBe(true);
    expect(workspace.store.getState().activeViewId).toBeNull();
    expect(workspace.history.location.href).toBe("/?projectId=project-a");
    expect(parseWorkspaceHref(workspace.history.location.href, "zh-CN", projectId)).toBeNull();
  });

  it("rejects foreign project entries on both back and forward without adopting their focused rows", async () => {
    window.history.replaceState({ __TSR_index: 0, __TSR_key: "foreign-back" }, "", "#/view/foreign-back?projectId=foreign&kind=entries&locale=zh-CN&focus=foreign-unit");
    window.history.pushState({ __TSR_index: 1, __TSR_key: "owned" }, "", "#/view/one?projectId=project-a&kind=entries&locale=zh-CN&preset=all");
    window.history.pushState({ __TSR_index: 2, __TSR_key: "foreign-forward" }, "", "#/view/foreign-forward?projectId=foreign&kind=entries&locale=zh-CN&focus=foreign-unit");
    const positioned = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
    window.history.back(); await positioned;
    const guard = vi.fn<WorkspaceGuard>(async (_transition, current) => ({ current, release: () => undefined }));
    const workspace = setup(guard); expect(await workspace.ready).toBe(true);
    const accepted = window.location.hash, calls = guard.mock.calls.length;
    let pops = 0;
    const observed = () => { pops++; }; window.addEventListener("popstate", observed); cleanup.push(() => window.removeEventListener("popstate", observed));
    for (const direction of ["back", "forward"] as const) {
      const before = pops; workspace.history[direction]();
      await vi.waitFor(() => expect(pops).toBeGreaterThan(before));
      await vi.waitFor(() => expect(window.location.hash).toBe(accepted));
      expect(workspace.store.getState().viewOrder).toEqual(["one"]);
      expect(workspace.store.getState().views.one.focus).toBeNull();
      expect(guard).toHaveBeenCalledTimes(calls);
    }
  });

  it("preserves local focus mode on a focus change while clearing a queue when language changes", async () => {
    const workspace = setup(); await workspace.ready;
    await workspace.navigation.update("one", { focus: "unit-a", editing: true, queueActive: true, queueScopeId: "read-scope", queueAnchor: "unit-a", focusMode: true });
    expect(workspace.store.getState().views.one).toMatchObject({ editing: true, queueScopeId: "read-scope", focusMode: true });
    await workspace.navigation.update("one", { locale: "ja" });
    expect(workspace.store.getState().views.one).toMatchObject({ locale: "ja", queueScopeId: null, cursor: null, editing: true, queueAnchor: "unit-a", focusMode: true });
    expect(workspace.history.location.href).not.toContain("read-scope");
  });

  it("rejects a stale permit without moving or clearing newer search input", async () => {
    let resolveLeave: ((permit: { current: () => boolean; release: () => void }) => void) | undefined;
    const release = vi.fn();
    let hold = false;
    const guard: WorkspaceGuard = async (_transition, current) => hold ? new Promise(resolve => { resolveLeave = resolve; }) : { current, release: () => undefined };
    const workspace = setup(guard); await workspace.ready;
    hold = true;
    const navigating = workspace.navigation.open({ id: "two", kind: "entries", locale: "ja" });
    await vi.waitFor(() => expect(resolveLeave).toBeDefined());
    workspace.store.getState().patch("one", { searchInput: "a newer unfinished search" });
    resolveLeave?.({ current: () => true, release });
    expect(await navigating).toBe(false);
    expect(workspace.store.getState().activeViewId).toBe("one");
    expect(workspace.store.getState().views.one.searchInput).toBe("a newer unfinished search");
    expect(workspace.history.location.href).toContain("/view/one");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses the same lifecycle guard for hash back and forward, language changes and closing", async () => {
    let allow = true;
    const releases = vi.fn();
    const guard = vi.fn<WorkspaceGuard>(async (_transition, current) => allow ? { current, release: releases } : null);
    const workspace = setup(guard); await workspace.ready;
    await workspace.navigation.open({ id: "two", kind: "entries", locale: "zh-CN" });
    await workspace.navigation.update("two", { locale: "ja", query: "letter" });
    expect(guard).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "language" }), expect.any(Function));
    const callCount = guard.mock.calls.length;
    allow = false; workspace.history.back();
    await vi.waitFor(() => expect(guard.mock.calls.length).toBeGreaterThan(callCount));
    expect(workspace.store.getState().activeViewId).toBe("two");
    await vi.waitFor(() => expect(window.location.hash).toContain("/view/two"));
    allow = true; workspace.history.back();
    await vi.waitFor(() => expect(workspace.store.getState().activeViewId).toBe("one"));
    workspace.history.forward();
    await vi.waitFor(() => expect(workspace.store.getState().activeViewId).toBe("two"));
    expect(workspace.store.getState().views.two).toMatchObject({ locale: "ja", query: "letter" });
    expect(await workspace.navigation.close("two")).toBe(true);
    expect(workspace.store.getState().activeViewId).toBe("one");
    expect(workspace.history.location.href).toContain("/view/one");
    expect(guard).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "close-view", viewId: "two" }), expect.any(Function));
    expect(releases).toHaveBeenCalled();
    expect(workspace.onError).not.toHaveBeenCalled();
  });
});
