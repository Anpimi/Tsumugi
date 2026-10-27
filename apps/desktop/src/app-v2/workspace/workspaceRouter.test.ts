import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHashHistory } from "@tanstack/react-router";
import { InteractionGate } from "./interactionGate";
import { createWorkspaceRouter, parseWorkspaceHref, workspaceViewHref, type WorkspaceGuard } from "./workspaceRouter";
import { createWorkspaceStore } from "./workspaceStore";

const cleanup: (() => void)[] = [];
beforeEach(() => window.history.replaceState({ __TSR_index: 0 }, "", "#/"));
afterEach(() => { cleanup.splice(0).reverse().forEach(dispose => dispose()); });

function setup(guard: WorkspaceGuard = async (_transition, current) => ({ current, release: () => undefined })) {
  const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
  const history = createHashHistory();
  const gate = new InteractionGate();
  const onError = vi.fn();
  const workspace = createWorkspaceRouter({ store, history, gate, guard, onError });
  cleanup.push(() => { workspace.dispose(); history.destroy(); gate.dispose(); });
  return { store, history, gate, onError, ...workspace };
}

describe("guarded workspace routing", () => {
  it("allows only view parameters in restored URLs and keeps search punctuation", async () => {
    window.history.replaceState({ __TSR_index: 0 }, "", "#/view/deep?kind=entries&locale=ja&query=A%3FB&focus=unit&queueScopeId=test-only&editing=true&sessionToken=test-only&grant=test-only");
    const workspace = setup();
    expect(await workspace.ready).toBe(true);
    const view = workspace.store.getState().views.deep;
    expect(view).toMatchObject({ locale: "ja", query: "A?B", searchInput: "A?B", focus: "unit", editing: true, queueAnchor: "unit", queueScopeId: null });
    expect(workspaceViewHref(view)).not.toMatch(/sessionToken|grant|queueScopeId|editing/);
    expect(workspace.history.location.href).not.toMatch(/sessionToken|grant|queueScopeId|editing/);
    expect(parseWorkspaceHref("/view/one?query=what?next", "zh-CN")).toMatchObject({ query: "what?next" });
    expect(parseWorkspaceHref("/outside", "zh-CN")).toBeUndefined();
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
