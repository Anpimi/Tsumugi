import { describe, expect, it, vi } from "vitest";
import { WorkbenchCommands, type CommandScope } from "../../workbenchCommands";
import { InteractionGate } from "./interactionGate";
import { createWorkspaceCommandDispatcher, registerWorkspaceCommands, type WorkspaceCommandContext } from "./workspaceCommands";
import { createWorkspaceStore } from "./workspaceStore";

const scope: CommandScope = { projectId: "project-a", sessionToken: "session-a", area: "translation" };
const navigation = () => ({ open: vi.fn(async () => true), activate: vi.fn(async () => true), close: vi.fn(async () => true), update: vi.fn(async () => true) });

describe("workspace commands in the existing registry", () => {
  it("uses one import command for toolbar, palette and native menu including an empty workspace", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] });
    const gate = new InteractionGate(), commands = new WorkbenchCommands(), openImport = vi.fn(); let ready = false;
    let liveScope = scope;
    registerWorkspaceCommands({ commands, store, gate, viewId: null, scope, getCurrentScope: () => liveScope, navigation: navigation(),
      actions: { openImport, canOpenImport: () => ready }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: null, scope, commands }), modifier: "meta" });
    expect(dispatcher.dispatch("translation.import", { viewId: null, source: "button" })).toBe(false);
    ready = true;
    for (const source of ["button", "palette", "native-menu"] as const) {
      expect(dispatcher.list({ source }).find(value => value.id === "translation.import")).toMatchObject({ binding: null, availability: { enabled: true } });
      expect(dispatcher.dispatch("translation.import", { viewId: null, source })).toBe(true);
    }
    expect(openImport).toHaveBeenCalledTimes(3);
    gate.setComposing("import-field", true); expect(dispatcher.dispatch("translation.import", { viewId: null, source: "native-menu" })).toBe(false);
    gate.setComposing("import-field", false); liveScope = { ...scope, sessionToken: "different" };
    expect(dispatcher.dispatch("translation.import", { viewId: null, source: "palette" })).toBe(false);
    expect(openImport).toHaveBeenCalledTimes(3);
  });

  it("disables table search commands while the retained import presentation is active", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN", entryMode: "import" }] });
    const gate = new InteractionGate(); gate.setVisibleOwner("one"); const commands = new WorkbenchCommands(), search = vi.fn();
    registerWorkspaceCommands({ commands, store, gate, viewId: "one", scope, getCurrentScope: () => scope, navigation: navigation(), actions: { focusSearch: search }, onError: vi.fn() });
    expect(commands.describe("workspace.search", scope)?.availability.enabled).toBe(false);
    expect(commands.describe("workspace.focus-search", scope)?.availability.enabled).toBe(false); expect(search).not.toHaveBeenCalled();
  });
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

  it("confirms only the current editor's keyboard intent and keeps recovery inside its top dialog", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN", focus: "unit-a" }] });
    const gate = new InteractionGate(); gate.setVisibleOwner("one");
    const commands = new WorkbenchCommands(), confirm = vi.fn(), exitEditor = vi.fn(), toggleFocus = vi.fn();
    let canConfirm = true;
    registerWorkspaceCommands({ commands, store, gate, viewId: "one", scope, getCurrentScope: () => scope, navigation: navigation(),
      actions: { confirm, exitEditor, toggleFocus, isEditing: () => true, canConfirm: () => canConfirm }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: "one", scope, commands }), modifier: "meta" });
    const enter = () => new KeyboardEvent("keydown", { key: "Enter", metaKey: true, cancelable: true });
    gate.setInputOwner("one", "entry-search-one");
    expect(dispatcher.handleKeyDown(enter(), "one", "entry-search-one")).toBe(false);
    gate.setInputOwner("one", "segment-editor-one");
    expect(dispatcher.handleKeyDown(enter(), "one")).toBe(false);
    expect(dispatcher.handleKeyDown(enter(), "one", "segment-editor-stale")).toBe(false);
    expect(dispatcher.handleKeyDown(enter(), "one", "segment-editor-one")).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(true);
    expect(dispatcher.handleKeyDown(new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }), "one", "segment-editor-one")).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(false);
    expect(dispatcher.handleKeyDown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }), "one", "segment-editor-one")).toBe(true);
    expect(exitEditor).toHaveBeenCalledTimes(1);
    expect(dispatcher.handleKeyDown(new KeyboardEvent("keydown", { key: "f", metaKey: true, shiftKey: true, cancelable: true }), "one", "segment-editor-one")).toBe(true);
    expect(toggleFocus).toHaveBeenCalledTimes(1);
    const closeRecovery = gate.pushDialog("draft-recovery");
    expect(dispatcher.handleKeyDown(enter(), "one", "segment-editor-one")).toBe(false);
    expect(dispatcher.handleKeyDown(enter(), "one", "segment-editor-one", "draft-recovery")).toBe(false);
    expect(dispatcher.dispatch("workspace.new-view", { source: "keyboard", viewId: "one", inputOwner: "segment-editor-one", dialogId: "draft-recovery" })).toBe(false);
    const closeAnother = gate.pushDialog("another-dialog");
    expect(dispatcher.handleKeyDown(enter(), "one", "segment-editor-one", "draft-recovery")).toBe(false);
    closeAnother(); closeRecovery();
    gate.setComposing("segment-editor-one", true);
    expect(dispatcher.handleKeyDown(enter(), "one", "segment-editor-one")).toBe(false);
    gate.setComposing("segment-editor-one", false);
    expect(dispatcher.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, repeat: true }), "one", "segment-editor-one")).toBe(false);
    const ime = enter(); Object.defineProperty(ime, "keyCode", { value: 229 });
    expect(dispatcher.handleKeyDown(ime, "one", "segment-editor-one")).toBe(false);
    canConfirm = false;
    expect(dispatcher.dispatch("translation.confirm", { source: "button", viewId: "one" })).toBe(false);
    canConfirm = true; gate.setInputOwner("one", null);
    expect(dispatcher.dispatch("translation.confirm", { source: "button", viewId: "one" })).toBe(true);
  });

  it("keeps confirm available while the recovery sheet disables advancing through keyboard, palette and registry", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN", focus: "unit-a" }] });
    const gate = new InteractionGate(); gate.setVisibleOwner("one"); gate.setInputOwner("one", "segment-editor-recovery");
    const commands = new WorkbenchCommands(), confirm = vi.fn();
    let recovery = false;
    registerWorkspaceCommands({ commands, store, gate, viewId: "one", scope, getCurrentScope: () => scope, navigation: navigation(),
      actions: { confirm, isEditing: () => true, canConfirm: () => true, canAdvance: () => !recovery }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: "one", scope, commands }), modifier: "meta" });
    expect(commands.describe("translation.confirm-next", scope)?.availability.enabled).toBe(true);
    recovery = true;
    const close = gate.pushDialog("draft-recovery");
    expect(commands.describe("translation.confirm-next", scope)?.availability.enabled).toBe(false);
    expect(commands.dispatch("translation.confirm-next", scope)).toBe(false);
    expect(dispatcher.list({ source: "palette", dialogId: "draft-recovery" }).find(command => command.id === "translation.confirm-next")?.availability.enabled).toBe(false);
    expect(dispatcher.dispatch("translation.confirm-next", { source: "palette", viewId: "one", dialogId: "draft-recovery" })).toBe(false);
    expect(dispatcher.handleKeyDown(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }), "one", "segment-editor-recovery", "draft-recovery")).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(dispatcher.dispatch("translation.confirm", { source: "button", viewId: "one", dialogId: "draft-recovery" })).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(false);
    close(); recovery = false;
    expect(commands.describe("translation.confirm-next", scope)?.availability.enabled).toBe(true);
  });
});
