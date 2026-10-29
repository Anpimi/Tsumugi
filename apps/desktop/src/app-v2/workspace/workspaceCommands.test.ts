import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCommands, type CommandScope } from "../../workbenchCommands";
import { CommandBindings, COMMAND_BINDINGS_STORAGE_KEY, workspaceCommandMetadata } from "../../commandBindings";
import { InteractionGate } from "./interactionGate";
import { createWorkspaceCommandDispatcher, registerWorkspaceCommands, workspaceCommandCatalog, type WorkspaceCommandContext } from "./workspaceCommands";
import { createWorkspaceStore } from "./workspaceStore";
import { i18n } from "../../i18n";

const scope: CommandScope = { projectId: "project-a", sessionToken: "session-a", area: "translation" };
const navigation = () => ({ open: vi.fn(async () => true), activate: vi.fn(async () => true), close: vi.fn(async () => true), update: vi.fn(async () => true) });
beforeEach(() => { localStorage.removeItem(COMMAND_BINDINGS_STORAGE_KEY); });
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(COMMAND_BINDINGS_STORAGE_KEY); });

describe("workspace commands in the existing registry", () => {
  it("opens work plans from the same button, palette and native command without bypassing an active dialog", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] }), gate = new InteractionGate(), commands = new WorkbenchCommands(), openRuns = vi.fn();
    registerWorkspaceCommands({ commands, store, gate, viewId: null, scope, getCurrentScope: () => scope,
      navigation: navigation(), actions: { openRuns }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: null, scope, commands }), modifier: "meta" });
    for (const source of ["button", "palette", "native-menu"] as const) expect(dispatcher.dispatch("workspace.runs", { viewId: null, source })).toBe(true);
    const release = gate.pushDialog("synthetic-dialog");
    expect(dispatcher.dispatch("workspace.runs", { viewId: null, source: "palette" })).toBe(false);
    release(); expect(openRuns).toHaveBeenCalledTimes(3);
  });
  it("opens context experiments through the existing workspace command", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] }), gate = new InteractionGate(), commands = new WorkbenchCommands(), openStrategy = vi.fn();
    registerWorkspaceCommands({ commands, store, gate, viewId: null, scope, getCurrentScope: () => scope,
      navigation: navigation(), actions: { openStrategy }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: null, scope, commands }), modifier: "meta" });
    expect(dispatcher.list({ source: "palette" }).find(command => command.id === "workspace.strategy")).toMatchObject({ nameKey: "workbenchV2.strategyOpen", binding: null });
    expect(dispatcher.dispatch("workspace.strategy", { viewId: null, source: "palette" })).toBe(true);
    expect(openStrategy).toHaveBeenCalledOnce();
  });

  it("opens delivery through one command and rejects an outdated session, composing input and a modal", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] });
    const gate = new InteractionGate(), commands = new WorkbenchCommands(), openDelivery = vi.fn();
    let liveScope = scope;
    registerWorkspaceCommands({ commands, store, gate, viewId: null, scope, getCurrentScope: () => liveScope,
      navigation: navigation(), actions: { openDelivery }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: null, scope, commands }), modifier: "meta" });
    for (const source of ["button", "palette", "native-menu"] as const) {
      expect(dispatcher.list({ source }).find(command => command.id === "workspace.delivery")).toMatchObject({ nameKey: "workbenchV2.delivery", binding: null });
      expect(dispatcher.dispatch("workspace.delivery", { viewId: null, source })).toBe(true);
    }
    gate.setComposing("synthetic-input", true);
    expect(dispatcher.dispatch("workspace.delivery", { viewId: null, source: "button" })).toBe(false);
    gate.setComposing("synthetic-input", false);
    const release = gate.pushDialog("synthetic-dialog");
    expect(dispatcher.dispatch("workspace.delivery", { viewId: null, source: "palette" })).toBe(false); release();
    liveScope = { ...scope, sessionToken: "different-session" };
    expect(dispatcher.dispatch("workspace.delivery", { viewId: null, source: "native-menu" })).toBe(false);
    expect(openDelivery).toHaveBeenCalledTimes(3);
  });
  it("stages focused AI only from the current list and respects input, IME and modal ownership", () => {
    const gate = new InteractionGate(), commands = new WorkbenchCommands(), stage = vi.fn(); gate.setVisibleOwner("one");
    commands.register({ ...workspaceCommandMetadata("translation.stage-focused-ai"), category: "translation", risk: "writes-translation", confirmation: "none", scope,
      availability: () => ({ enabled: true }), handler: stage });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: "one", scope, commands }), modifier: "meta" });
    const key = () => new KeyboardEvent("keydown", { key: "A", metaKey: true, shiftKey: true, cancelable: true });
    expect(dispatcher.handleKeyDown(key(), "one")).toBe(true);
    for (const owner of ["entry-search-one", "candidate-audit-one", "segment-editor-one", "entry-list-two"]) {
      gate.setInputOwner("one", owner); expect(dispatcher.handleKeyDown(key(), "one", owner)).toBe(false);
    }
    gate.setInputOwner("one", "entry-list-one"); expect(dispatcher.handleKeyDown(key(), "one", "entry-list-one")).toBe(true);
    gate.setComposing("entry-list-one", true); expect(dispatcher.handleKeyDown(key(), "one", "entry-list-one")).toBe(false);
    gate.setComposing("entry-list-one", false); const close = gate.pushDialog("other");
    expect(dispatcher.handleKeyDown(key(), "one", "entry-list-one")).toBe(false); close();
    expect(stage).toHaveBeenCalledTimes(2);
  });
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

describe("configured workspace keyboard dispatch", () => {
  function setup(modifier: "meta" | "ctrl" = "meta") {
    const bindings = new CommandBindings(workspaceCommandCatalog), commands = new WorkbenchCommands(bindings);
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [{ id: "one", kind: "entries", locale: "zh-CN" }] });
    const gate = new InteractionGate(); gate.setVisibleOwner("one");
    const openProject = vi.fn(), openSettings = vi.fn(), openExtensions = vi.fn(), confirm = vi.fn();
    registerWorkspaceCommands({ commands, store, gate, viewId: "one", scope, getCurrentScope: () => scope, navigation: navigation(),
      actions: { openProject, openSettings, openExtensions, confirm, canConfirm: () => true }, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: "one", scope, commands }), modifier });
    return { bindings, commands, gate, dispatcher, openProject, openSettings, openExtensions, confirm };
  }
  const key = (value: string, modifiers: KeyboardEventInit = { metaKey: true }) => new KeyboardEvent("keydown", { key: value, cancelable: true, ...modifiers });

  it.each(["en-US", "zh-CN"])("uses the rebound shortcut immediately and retires the old key in %s", async locale => {
    await i18n.changeLanguage(locale);
    const { bindings, dispatcher, openProject } = setup();
    expect(dispatcher.handleKeyDown(key("o"), "one")).toBe(true);
    expect(bindings.set("workspace.open-project", "Alt+Mod+P")).toEqual({ kind: "saved" });
    const oldKey = key("o"), wrongModifiers = key("p"), rebound = key("p", { metaKey: true, altKey: true });
    expect(dispatcher.handleKeyDown(oldKey, "one")).toBe(false);
    expect(oldKey.defaultPrevented).toBe(false);
    expect(dispatcher.handleKeyDown(wrongModifiers, "one")).toBe(false);
    expect(dispatcher.handleKeyDown(rebound, "one")).toBe(true);
    expect(rebound.defaultPrevented).toBe(true);
    const described = dispatcher.list().find(command => i18n.t(command.nameKey) === i18n.t("workbenchV2.openProject"));
    expect(described).toMatchObject({ id: "workspace.open-project", binding: "Mod+Alt+P" });
    expect(openProject).toHaveBeenCalledTimes(2);
  });

  it("keeps old dispatch after conflicts or storage failures and permits explicit unbinding", () => {
    const { bindings, dispatcher, openProject } = setup();
    expect(bindings.set("workspace.open-project", "Mod+K").kind).toBe("conflict");
    expect(dispatcher.handleKeyDown(key("o"), "one")).toBe(true);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Synthetic storage unavailable"); });
    expect(bindings.set("workspace.open-project", "Mod+P")).toEqual({ kind: "storage" });
    expect(dispatcher.handleKeyDown(key("p"), "one")).toBe(false);
    expect(dispatcher.handleKeyDown(key("o"), "one")).toBe(true);
    write.mockRestore();
    expect(bindings.set("workspace.open-project", "")).toEqual({ kind: "saved" });
    expect(dispatcher.handleKeyDown(key("o"), "one")).toBe(false);
    expect(dispatcher.list().find(command => command.id === "workspace.open-project")?.binding).toBeNull();
    expect(dispatcher.dispatch("workspace.open-project", { viewId: "one", source: "native-menu" })).toBe(true);
    expect(openProject).toHaveBeenCalledTimes(3);
  });

  it.each(["meta", "ctrl"] as const)("opens settings through the default comma with %s and keeps extensions in the same registry", modifier => {
    const { dispatcher, openSettings, openExtensions } = setup(modifier);
    expect(dispatcher.handleKeyDown(key(",", { metaKey: modifier === "meta", ctrlKey: modifier === "ctrl" }), "one")).toBe(true);
    expect(dispatcher.handleKeyDown(key(",", { metaKey: modifier !== "meta", ctrlKey: modifier !== "ctrl" }), "one")).toBe(false);
    expect(dispatcher.list().find(command => command.id === "workspace.settings")).toMatchObject({ nameKey: "settingsWorkbench.title", binding: "Mod+,", availability: { enabled: true } });
    expect(dispatcher.list().find(command => command.id === "workspace.extensions")).toMatchObject({ nameKey: "plugins.title", binding: null, availability: { enabled: true } });
    expect(dispatcher.dispatch("workspace.extensions", { viewId: "one", source: "palette" })).toBe(true);
    expect(openSettings).toHaveBeenCalledTimes(1); expect(openExtensions).toHaveBeenCalledTimes(1);
  });

  it("leaves settings and extension actions unavailable when the host does not supply them", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] }), gate = new InteractionGate(), commands = new WorkbenchCommands();
    registerWorkspaceCommands({ commands, store, gate, viewId: null, scope, getCurrentScope: () => scope, navigation: navigation(), actions: {}, onError: vi.fn() });
    expect(commands.describe("workspace.settings", scope)?.availability.enabled).toBe(false);
    expect(commands.describe("workspace.extensions", scope)?.availability.enabled).toBe(false);
    expect(commands.dispatch("workspace.settings", scope)).toBe(false);
    expect(commands.dispatch("workspace.extensions", scope)).toBe(false);
  });

  it("retains editor ownership, composition, modal and intent gates after rebinding", () => {
    const { bindings, gate, dispatcher, confirm } = setup();
    expect(bindings.set("translation.confirm", "Mod+Alt+S")).toEqual({ kind: "saved" });
    const event = () => key("s", { metaKey: true, altKey: true });
    gate.setInputOwner("one", "entry-search-one");
    expect(dispatcher.handleKeyDown(event(), "one", "entry-search-one")).toBe(false);
    gate.setInputOwner("one", "segment-editor-one");
    expect(dispatcher.handleKeyDown(key("s"), "one", "segment-editor-one")).toBe(false);
    expect(dispatcher.handleKeyDown(event(), "one", "segment-editor-stale")).toBe(false);
    expect(dispatcher.handleKeyDown(event(), "one", "segment-editor-one")).toBe(true);
    gate.setComposing("segment-editor-one", true);
    expect(dispatcher.handleKeyDown(event(), "one", "segment-editor-one")).toBe(false);
    gate.setComposing("segment-editor-one", false);
    expect(dispatcher.handleKeyDown(key("s", { metaKey: true, altKey: true, isComposing: true }), "one", "segment-editor-one")).toBe(false);
    const ime = event(); Object.defineProperty(ime, "keyCode", { value: 229 });
    expect(dispatcher.handleKeyDown(ime, "one", "segment-editor-one")).toBe(false);
    const close = gate.pushDialog("settings");
    expect(dispatcher.handleKeyDown(event(), "one", "segment-editor-one")).toBe(false); close();
    const intent = gate.acquireIntent("switch-project"); expect(intent).not.toBeNull();
    expect(dispatcher.handleKeyDown(event(), "one", "segment-editor-one")).toBe(false); intent?.release();
    expect(confirm).toHaveBeenCalledTimes(1); expect(confirm).toHaveBeenLastCalledWith(false);
  });

  it("rebinds the actual focused-AI command without broadening list ownership or its availability", () => {
    const { bindings, commands, gate, dispatcher } = setup(), stage = vi.fn();
    let available = true;
    commands.register({ ...workspaceCommandMetadata("translation.stage-focused-ai"), category: "translation", risk: "writes-translation", confirmation: "none", scope,
      availability: () => ({ enabled: available }), handler: stage });
    expect(bindings.set("translation.stage-focused-ai", "Mod+Alt+A")).toEqual({ kind: "saved" });
    const event = () => key("a", { metaKey: true, altKey: true });
    expect(dispatcher.handleKeyDown(key("a", { metaKey: true, shiftKey: true }), "one")).toBe(false);
    gate.setInputOwner("one", "segment-editor-one");
    expect(dispatcher.handleKeyDown(event(), "one", "segment-editor-one")).toBe(false);
    gate.setInputOwner("one", "entry-list-one");
    expect(dispatcher.handleKeyDown(event(), "one", "entry-list-one")).toBe(true);
    available = false;
    expect(dispatcher.handleKeyDown(event(), "one", "entry-list-one")).toBe(false);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it("routes MCP actions through the same registry only when the host supplies their real capabilities", () => {
    const store = createWorkspaceStore({ initialLocale: "zh-CN", initialViews: [] }), gate = new InteractionGate(), commands = new WorkbenchCommands();
    const openMcpQuery = vi.fn(), openMcpShare = vi.fn();
    const register = (available: boolean) => registerWorkspaceCommands({ commands, store, gate, viewId: null, scope, getCurrentScope: () => scope, navigation: navigation(),
      actions: available ? { openMcpQuery, openMcpShare } : {}, onError: vi.fn() });
    const dispatcher = createWorkspaceCommandDispatcher({ gate, getContext: () => ({ viewId: null, scope, commands }), modifier: "meta" });
    const removeUnavailable = register(false);
    expect(dispatcher.dispatch("workspace.mcp-query", { viewId: null, source: "palette" })).toBe(false);
    expect(dispatcher.dispatch("workspace.mcp-share", { viewId: null, source: "native-menu" })).toBe(false);
    register(true); removeUnavailable();
    expect(dispatcher.list().find(command => command.id === "workspace.mcp-query")).toMatchObject({ nameKey: "settingsWorkbench.query", binding: null, availability: { enabled: true } });
    expect(dispatcher.list().find(command => command.id === "workspace.mcp-share")).toMatchObject({ nameKey: "settingsWorkbench.share", binding: null, availability: { enabled: true } });
    expect(dispatcher.dispatch("workspace.mcp-query", { viewId: null, source: "palette" })).toBe(true);
    expect(dispatcher.dispatch("workspace.mcp-share", { viewId: null, source: "native-menu" })).toBe(true);
    expect(openMcpQuery).toHaveBeenCalledTimes(1); expect(openMcpShare).toHaveBeenCalledTimes(1);
  });
});
