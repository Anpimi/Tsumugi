import { describe, expect, it, vi } from "vitest";
import { WorkbenchCommands, type CommandScope } from "../../workbenchCommands";
import { InteractionGate } from "./interactionGate";
import { createWorkspaceCommandDispatcher, registerWorkspaceCommands, type WorkspaceCommandContext } from "./workspaceCommands";
import { createWorkspaceStore } from "./workspaceStore";

const scope: CommandScope = { projectId: "project-a", sessionToken: "session-a", area: "translation" };
const navigation = () => ({ open: vi.fn(async () => true), activate: vi.fn(async () => true), close: vi.fn(async () => true), update: vi.fn(async () => true) });

describe("workspace commands in the existing registry", () => {
  it("rechecks the captured view, live session, availability and IME before dispatch", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }, { id: "two", kind: "entries", locale: "ja" }] });
    const gate = new InteractionGate(); gate.setVisibleOwner("one");
    const commands = new WorkbenchCommands(), ports = navigation(), onError = vi.fn();
    let liveScope = scope;
    let context: WorkspaceCommandContext | null = { viewId: "one", scope, commands };
    const cleanup = registerWorkspaceCommands({ commands, store, gate, viewId: "one", scope, getCurrentScope: () => liveScope, navigation: ports, actions: {}, onError });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => context, modifier: "meta" });
    expect(dispatcher.dispatch("workspace.close-window", { viewId: "one", source: "native-menu" })).toBe(false);
    gate.setComposing("search", true);
    expect(dispatcher.dispatch("workspace.new-view", { viewId: "one", source: "button" })).toBe(false);
    gate.setComposing("search", false);
    expect(dispatcher.dispatch("workspace.new-view", { viewId: "one", source: "button" })).toBe(true);
    expect(ports.open).toHaveBeenCalledWith({ kind: "entries", locale: "zh-CN" });
    store.getState().pin("one");
    expect(commands.describe("workspace.pin-view", scope)?.nameKey).toBe("workbenchV2.unpinView");
    expect(dispatcher.dispatch("workspace.close-view", { viewId: "one", source: "button" })).toBe(false);
    liveScope = { ...scope, sessionToken: "session-b" };
    expect(dispatcher.dispatch("workspace.new-view", { viewId: "one", source: "button" })).toBe(false);
    context = { viewId: "two", scope: liveScope, commands: new WorkbenchCommands() }; gate.setVisibleOwner("two");
    expect(dispatcher.dispatch("workspace.new-view", { viewId: "one", source: "menu" })).toBe(false);
    expect(ports.open).toHaveBeenCalledTimes(1);
    cleanup(); expect(commands.list(scope)).toEqual([]);
  });

  it("keeps real project commands available with no tabs and uses one keyboard dispatcher", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] });
    const gate = new InteractionGate(), commands = new WorkbenchCommands(), ports = navigation(), closeWindow = vi.fn();
    registerWorkspaceCommands({ commands, store, gate, viewId: null, scope, getCurrentScope: () => scope, defaultLocale: "zh-CN", navigation: ports, actions: { closeWindow }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: null, scope, commands }), modifier: "meta" });
    expect(dispatcher.dispatch("workspace.close-window", { viewId: null, source: "native-menu" })).toBe(true);
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch("workspace.close-view", { viewId: null, source: "button" })).toBe(false);
    const event = new KeyboardEvent("keydown", { key: "t", metaKey: true, cancelable: true });
    expect(dispatcher.handleKeyDown(event, null)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(ports.open).toHaveBeenCalledTimes(1);
    expect(dispatcher.handleKeyDown(new KeyboardEvent("keydown", { key: "t", metaKey: true, isComposing: true }), null)).toBe(false);
  });
});
