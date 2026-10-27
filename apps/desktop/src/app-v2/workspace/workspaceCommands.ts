import type { CommandAvailability, CommandScope, WorkbenchCommands, WorkbenchCommandDescription } from "../../workbenchCommands";
import type { TranslationKey } from "../../i18n/types";
import { InteractionGate, type CommandSource } from "./interactionGate";
import { getWorkspaceView, type WorkspaceStore } from "./workspaceStore";
import type { WorkspaceNavigation } from "./workspaceRouter";

export const workspaceCommandIds = ["workspace.open-project", "workspace.close-project", "workspace.close-window", "workspace.new-view", "workspace.close-view", "workspace.pin-view", "workspace.agent", "workspace.details", "workspace.focus-search", "workspace.search", "workspace.refresh", "workspace.commands"] as const;
export type WorkspaceCommandId = typeof workspaceCommandIds[number];
const commandIds = new Set<string>(workspaceCommandIds);

function sameScope(left: CommandScope | null, right: CommandScope): boolean {
  return left?.projectId === right.projectId && left.sessionToken === right.sessionToken && left.area === right.area;
}

export interface WorkspaceCommandActions {
  openProject?: () => void | Promise<unknown>;
  closeProject?: () => void | Promise<unknown>;
  closeWindow?: () => void | Promise<unknown>;
  refresh?: () => void | Promise<unknown>;
  focusSearch?: () => void;
  focusAgent?: () => void;
  focusDetails?: () => void;
  openCommands?: () => void;
}

/** Registers presentation actions in the existing registry; it owns no business handlers. */
export function registerWorkspaceCommands({ commands, store, gate, viewId, scope, getCurrentScope, navigation, actions, onError, defaultLocale }: {
  commands: WorkbenchCommands;
  store: WorkspaceStore;
  gate: InteractionGate;
  viewId: string | null;
  defaultLocale?: string;
  scope: CommandScope;
  getCurrentScope: () => CommandScope | null;
  navigation: WorkspaceNavigation;
  actions: WorkspaceCommandActions;
  onError: (error: unknown) => void;
}): () => void {
  const registeredScope = { ...scope };
  const view = () => getWorkspaceView(store.getState(), viewId);
  const available = (condition = true): CommandAvailability => {
    const interaction = gate.getSnapshot();
    if (!sameScope(getCurrentScope(), registeredScope) || store.getState().activeViewId !== viewId || interaction.visibleViewId !== viewId || (viewId !== null && !view())) return { enabled: false, reason: "hidden" };
    if (interaction.intentOwner || interaction.composingOwners.length > 0) return { enabled: false, reason: "busy" };
    return condition ? { enabled: true } : { enabled: false, reason: "unavailable" };
  };
  const run = (action: () => void | Promise<unknown>) => () => {
    try { const result = action(); if (result) void result.catch(onError); } catch (error) { onError(error); }
  };
  const metadata = { scope: registeredScope, category: "project" as const, risk: "changes-view" as const, confirmation: "none" as const };
  const cleanup = [
    commands.register({ ...metadata, id: "workspace.open-project", nameKey: "workbenchV2.openProject", binding: "Mod+O", availability: () => available(!!actions.openProject), handler: run(() => actions.openProject?.()) }),
    commands.register({ ...metadata, id: "workspace.close-project", nameKey: "workbenchV2.closeProject", binding: "Mod+Shift+W", availability: () => available(!!actions.closeProject), handler: run(() => actions.closeProject?.()) }),
    commands.register({ ...metadata, id: "workspace.close-window", nameKey: "workbenchV2.closeWindow", binding: null, availability: () => available(!!actions.closeWindow), handler: run(() => actions.closeWindow?.()) }),
    commands.register({ ...metadata, id: "workspace.new-view", nameKey: "workbenchV2.newView", binding: "Mod+T", availability: () => available(!!(view()?.locale ?? defaultLocale)), handler: run(() => { const locale = view()?.locale ?? defaultLocale; return locale ? navigation.open({ kind: "entries", locale }) : undefined; }) }),
    commands.register({ ...metadata, id: "workspace.close-view", nameKey: "workbenchV2.close", binding: "Mod+W", availability: () => available(!!view() && !view()?.pinned), handler: run(() => viewId ? navigation.close(viewId) : undefined) }),
    commands.register({ ...metadata, id: "workspace.pin-view", get nameKey(): TranslationKey { return view()?.pinned ? "workbenchV2.unpinView" : "workbenchV2.pinView"; }, binding: null, availability: () => available(!!view()), handler: () => { if (viewId) store.getState().pin(viewId); } }),
    commands.register({ ...metadata, id: "workspace.agent", nameKey: "workbenchV2.agent", binding: "Mod+L", availability: () => available(!!view()), handler: run(() => { if (viewId) store.getState().patch(viewId, { dock: "agent", dockOpen: true }); actions.focusAgent?.(); }) }),
    commands.register({ ...metadata, id: "workspace.details", nameKey: "workbenchV2.detail", binding: "Mod+I", availability: () => available(!!view()), handler: run(() => { if (viewId) store.getState().patch(viewId, { dock: "details", dockOpen: true }); actions.focusDetails?.(); }) }),
    commands.register({ ...metadata, id: "workspace.focus-search", nameKey: "workbenchV2.searchEntries", binding: "Mod+F", availability: () => available(view()?.kind === "entries" && !!actions.focusSearch), handler: run(() => actions.focusSearch?.()) }),
    commands.register({ ...metadata, id: "workspace.search", nameKey: "workbenchV2.search", binding: null, availability: () => available(view()?.kind === "entries"), handler: run(() => { const current = view(); return current ? navigation.update(current.id, { query: current.searchInput, afterOrdinal: 0, scroll: { top: 0, left: 0 }, focus: null, selection: [] }) : undefined; }) }),
    commands.register({ ...metadata, id: "workspace.refresh", nameKey: "workbenchV2.refresh", binding: null, availability: () => available(!!actions.refresh), handler: run(() => actions.refresh?.()) }),
    commands.register({ ...metadata, id: "workspace.commands", nameKey: "workbenchV2.commands", binding: "Mod+K", availability: () => available(!!actions.openCommands), handler: run(() => actions.openCommands?.()) }),
  ];
  return () => cleanup.forEach(remove => remove());
}

export interface WorkspaceCommandContext {
  viewId: string | null;
  scope: CommandScope;
  commands: WorkbenchCommands;
}

export interface WorkspaceDispatchRequest {
  viewId: string | null;
  source: CommandSource;
  inputOwner?: string;
  dialogId?: string;
}

function matchesBinding(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, binding: string, modifier: "meta" | "ctrl"): boolean {
  const parts = binding.split("+");
  return (modifier === "meta" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    && event.shiftKey === parts.includes("Shift") && !event.altKey && event.key.toLowerCase() === parts.at(-1)?.toLowerCase();
}

/** Each entry point captures a view ID; dispatch cannot silently retarget a stale menu. */
export function createWorkspaceCommandDispatcher({ gate, getContext, modifier }: {
  gate: InteractionGate;
  getContext: () => WorkspaceCommandContext | null;
  modifier: "meta" | "ctrl";
}) {
  function list({ source = "palette", dialogId }: { source?: CommandSource; dialogId?: string } = {}): WorkbenchCommandDescription[] {
    const context = getContext();
    if (!context) return [];
    const allowed = gate.canDispatch({ viewId: context.viewId, source, dialogId });
    return context.commands.list(context.scope).filter(command => commandIds.has(command.id)).map((command): WorkbenchCommandDescription => ({ ...command, availability: allowed ? command.availability : { enabled: false, reason: "busy" } }));
  }

  function dispatch(id: WorkspaceCommandId, request: WorkspaceDispatchRequest): boolean {
    const context = getContext();
    if (!context || context.viewId !== request.viewId || !gate.canDispatch(request)) return false;
    return context.commands.dispatch(id, context.scope);
  }

  function handleKeyDown(event: KeyboardEvent, viewId: string | null, inputOwner?: string): boolean {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return false;
    const command = list({ source: "keyboard" }).find(candidate => candidate.binding && matchesBinding(event, candidate.binding, modifier));
    if (!command || !commandIds.has(command.id)) return false;
    const id = workspaceCommandIds.find(value => value === command.id);
    if (!id || !dispatch(id, { viewId, source: "keyboard", inputOwner })) return false;
    event.preventDefault();
    return true;
  }

  return { list, dispatch, handleKeyDown };
}
