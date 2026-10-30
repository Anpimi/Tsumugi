import type { CommandAvailability, CommandScope, WorkbenchCommands, WorkbenchCommandDescription } from "../../workbenchCommands";
import type { TranslationKey } from "../../i18n/types";
import { workspaceCommandCatalog, workspaceCommandMetadata, type WorkspaceBindingCommandId } from "../../commandBindings";
import { InteractionGate, type CommandSource } from "./interactionGate";
import { getWorkspaceView, type WorkspaceStore } from "./workspaceStore";
import type { WorkspaceNavigation } from "./workspaceRouter";

export { workspaceCommandCatalog } from "../../commandBindings";
export type WorkspaceCommandId = WorkspaceBindingCommandId;
export const workspaceCommandIds: readonly WorkspaceCommandId[] = workspaceCommandCatalog.map(command => command.id);
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
  openSettings?: () => void | Promise<unknown>;
  openExtensions?: () => void | Promise<unknown>;
  openReferences?: () => void | Promise<unknown>;
  openMcpQuery?: () => void | Promise<unknown>;
  openMcpShare?: () => void | Promise<unknown>;
  openDecisions?: () => void | Promise<unknown>;
  openDelivery?: () => void | Promise<unknown>;
  openStrategy?: () => void | Promise<unknown>;
  openProjectMetadata?: () => void | Promise<unknown>;
  openRuns?: () => void | Promise<unknown>;
  openImport?: () => void | Promise<unknown>;
  canOpenImport?: () => boolean;
  openSource?: () => void;
  confirm?: (advance: boolean) => void | Promise<unknown>;
  exitEditor?: () => void | Promise<unknown>;
  toggleFocus?: () => void | Promise<unknown>;
  isEditing?: () => boolean;
  canConfirm?: () => boolean;
  canAdvance?: () => boolean;
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
  const pinMetadata = workspaceCommandMetadata("workspace.pin-view");
  const cleanup = [
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.open-project"), availability: () => available(!!actions.openProject), handler: run(() => actions.openProject?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.close-project"), availability: () => available(!!actions.closeProject), handler: run(() => actions.closeProject?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.close-window"), availability: () => available(!!actions.closeWindow), handler: run(() => actions.closeWindow?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.new-view"), availability: () => available(!!(view()?.locale ?? defaultLocale)), handler: run(() => { const locale = view()?.locale ?? defaultLocale; return locale ? navigation.open({ kind: "entries", locale }) : undefined; }) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.close-view"), availability: () => available(!!view() && !view()?.pinned), handler: run(() => viewId ? navigation.close(viewId) : undefined) }),
    commands.register({ ...metadata, ...pinMetadata, get nameKey(): TranslationKey { return view()?.pinned ? "workbenchV2.unpinView" : pinMetadata.nameKey; }, availability: () => available(!!view()), handler: () => { if (viewId) store.getState().pin(viewId); } }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.agent"), availability: () => available(!!view()), handler: run(() => { if (viewId) store.getState().patch(viewId, { dock: "agent", dockOpen: true }); actions.focusAgent?.(); }) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.details"), availability: () => available(!!view()), handler: run(() => { if (viewId) store.getState().patch(viewId, { dock: "details", dockOpen: true }); actions.focusDetails?.(); }) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.decisions"), availability: () => available(!!actions.openDecisions), handler: run(() => actions.openDecisions?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.delivery"), availability: () => available(!!actions.openDelivery), handler: run(() => actions.openDelivery?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.strategy"), availability: () => available(!!actions.openStrategy), handler: run(() => actions.openStrategy?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.project-settings"), availability: () => available(!!actions.openProjectMetadata), handler: run(() => actions.openProjectMetadata?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.runs"), availability: () => available(!!actions.openRuns), handler: run(() => actions.openRuns?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.focus-search"), availability: () => available(view()?.kind === "entries" && view()?.entryMode !== "import" && !!actions.focusSearch), handler: run(() => actions.focusSearch?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.search"), availability: () => available(view()?.kind === "entries" && view()?.entryMode !== "import"), handler: run(() => { const current = view(); return current ? navigation.update(current.id, { query: current.searchInput, afterOrdinal: 0, cursor: null, scroll: { top: 0, left: 0 }, focus: null }) : undefined; }) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.refresh"), availability: () => available(!!actions.refresh), handler: run(() => actions.refresh?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.commands"), availability: () => available(!!actions.openCommands), handler: run(() => actions.openCommands?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.settings"), availability: () => available(!!actions.openSettings), handler: run(() => actions.openSettings?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.extensions"), availability: () => available(!!actions.openExtensions), handler: run(() => actions.openExtensions?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.references"), availability: () => available(!!actions.openReferences), handler: run(() => actions.openReferences?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.mcp-query"), availability: () => available(!!actions.openMcpQuery), handler: run(() => actions.openMcpQuery?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("workspace.mcp-share"), availability: () => available(!!actions.openMcpShare), handler: run(() => actions.openMcpShare?.()) }),
    commands.register({ ...metadata, category: "translation", ...workspaceCommandMetadata("translation.import"), availability: () => available(!!actions.openImport && (actions.canOpenImport?.() ?? true)), handler: run(() => actions.openImport?.()) }),
    commands.register({ ...metadata, category: "source", ...workspaceCommandMetadata("source.import-upstream"), availability: () => available(!!actions.openSource), handler: run(() => actions.openSource?.()) }),
    commands.register({ ...metadata, category: "translation", risk: "writes-translation", ...workspaceCommandMetadata("translation.confirm"), availability: () => available(!!actions.confirm && !!actions.canConfirm?.()), handler: run(() => actions.confirm?.(false)) }),
    commands.register({ ...metadata, category: "translation", risk: "writes-translation", ...workspaceCommandMetadata("translation.confirm-next"), availability: () => available(!!actions.confirm && !!actions.canConfirm?.() && (actions.canAdvance?.() ?? true)), handler: run(() => actions.confirm?.(true)) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("translation.exit-editor"), availability: () => available(!!actions.exitEditor && !!actions.isEditing?.()), handler: run(() => actions.exitEditor?.()) }),
    commands.register({ ...metadata, ...workspaceCommandMetadata("translation.focus-mode"), availability: () => available(!!actions.toggleFocus && !!actions.isEditing?.()), handler: run(() => actions.toggleFocus?.()) }),
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
  return (parts.includes("Mod") ? modifier === "meta" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey : !event.metaKey && !event.ctrlKey)
    && event.shiftKey === parts.includes("Shift") && event.altKey === parts.includes("Alt") && event.key.toLowerCase() === parts.at(-1)?.toLowerCase();
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
    if (request.dialogId === "draft-recovery" && !id.startsWith("translation.")) return false;
    if (request.dialogId === "draft-recovery" && id === "translation.confirm-next") return false;
    if (request.dialogId === "workspace-dock" && id !== "conversation.new-thread") return false;
    if (request.source === "keyboard" && id.startsWith("translation.")) {
      const actual = gate.getSnapshot().inputOwner?.ownerId;
      if (id === "translation.stage-focused-ai") {
        if (actual !== undefined && (actual !== `entry-list-${request.viewId}` || actual !== request.inputOwner)) return false;
      } else if (!request.inputOwner?.startsWith("segment-editor-") || actual !== request.inputOwner) return false;
    }
    return context.commands.dispatch(id, context.scope);
  }

  function handleKeyDown(event: KeyboardEvent, viewId: string | null, inputOwner?: string, dialogId?: string): boolean {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return false;
    const command = list({ source: "keyboard", dialogId }).find(candidate => candidate.binding && matchesBinding(event, candidate.binding, modifier));
    if (!command || !commandIds.has(command.id)) return false;
    const id = workspaceCommandIds.find(value => value === command.id);
    if (!id || !dispatch(id, { viewId, source: "keyboard", inputOwner, dialogId })) return false;
    event.preventDefault();
    return true;
  }

  return { list, dispatch, handleKeyDown };
}
