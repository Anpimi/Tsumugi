import type { WorkbenchCommandId } from "./workbenchCommands";
import type { TranslationKey } from "./i18n/types";

export interface BindingEntry { id: WorkbenchCommandId; nameKey: TranslationKey; binding: string | null }
export const workspaceCommandCatalog = [
  { id: "workspace.open-project", nameKey: "workbenchV2.openProject", binding: "Mod+O" },
  { id: "workspace.close-project", nameKey: "workbenchV2.closeProject", binding: "Mod+Shift+W" },
  { id: "workspace.close-window", nameKey: "workbenchV2.closeWindow", binding: null },
  { id: "workspace.new-view", nameKey: "workbenchV2.newView", binding: "Mod+T" },
  { id: "workspace.close-view", nameKey: "workbenchV2.close", binding: "Mod+W" },
  { id: "workspace.pin-view", nameKey: "workbenchV2.pinView", binding: null },
  { id: "workspace.agent", nameKey: "workbenchV2.agent", binding: "Mod+L" },
  { id: "workspace.details", nameKey: "workbenchV2.detail", binding: "Mod+I" },
  { id: "workspace.decisions", nameKey: "workbenchV2.decisions", binding: null },
  { id: "workspace.delivery", nameKey: "workbenchV2.delivery", binding: null },
  { id: "workspace.strategy", nameKey: "workbenchV2.strategyOpen", binding: null },
  { id: "workspace.focus-search", nameKey: "workbenchV2.searchEntries", binding: "Mod+F" },
  { id: "workspace.search", nameKey: "workbenchV2.search", binding: null },
  { id: "workspace.refresh", nameKey: "workbenchV2.refresh", binding: null },
  { id: "workspace.commands", nameKey: "workbenchV2.commands", binding: "Mod+K" },
  { id: "workspace.settings", nameKey: "settingsWorkbench.title", binding: "Mod+," },
  { id: "workspace.extensions", nameKey: "plugins.title", binding: null },
  { id: "workspace.references", nameKey: "toolQuery.title", binding: null },
  { id: "workspace.mcp-query", nameKey: "settingsWorkbench.query", binding: null },
  { id: "workspace.mcp-share", nameKey: "settingsWorkbench.share", binding: null },
  { id: "source.import-upstream", nameKey: "sourceMaintenance.title", binding: null },
  { id: "translation.import", nameKey: "workbenchV2.importTitle", binding: null },
  { id: "translation.confirm", nameKey: "workbenchV2.editorConfirm", binding: "Mod+S" },
  { id: "translation.confirm-next", nameKey: "workbenchV2.confirmNext", binding: "Mod+Enter" },
  { id: "translation.exit-editor", nameKey: "workbenchV2.editorExit", binding: "Escape" },
  { id: "translation.focus-mode", nameKey: "workbenchV2.editorFocusMode", binding: "Mod+Shift+F" },
  { id: "translation.stage-focused-ai", nameKey: "translation.addCandidate", binding: "Mod+Shift+A" },
] as const satisfies readonly BindingEntry[];
export type WorkspaceBindingCommandId = typeof workspaceCommandCatalog[number]["id"];

/** Registrations and preferences share these defaults; handlers keep their own availability. */
export function workspaceCommandMetadata<Id extends WorkspaceBindingCommandId>(id: Id) {
  const entry = workspaceCommandCatalog.find(command => command.id === id);
  if (!entry) throw new Error("Unknown workspace command");
  return { ...entry, id };
}

export const COMMAND_BINDINGS_STORAGE_KEY = "tsumugi.commandBindings";
export type BindingResult = { kind: "saved" } | { kind: "invalid" | "reserved" | "storage" } | { kind: "conflict"; command: BindingEntry };
const reserved = new Set(["Mod+A", "Mod+C", "Mod+X", "Mod+V", "Mod+Shift+V", "Mod+Z", "Mod+Shift+Z", "Mod+Y", "Mod+Q", "Alt+F4"]);

function normalize(value: string): string | null | undefined {
  if (!value.trim()) return null;
  const parts = value.trim().split("+").map(part => part.trim().toLowerCase()), key = parts.pop();
  if (!key || parts.some(part => !["mod", "shift", "alt"].includes(part)) || new Set(parts).size !== parts.length) return undefined;
  const final = key === "," ? key : key.length === 1 && /^[a-z0-9]$/i.test(key) ? key.toUpperCase()
    : ["Enter", "Escape", ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)].find(candidate => candidate.toLowerCase() === key.toLowerCase());
  if (!final || (!parts.includes("mod") && final !== "Escape" && !/^F\d+$/.test(final))) return undefined;
  return [...["Mod", "Shift", "Alt"].filter(part => parts.includes(part.toLowerCase())), final].join("+");
}

/** Application preferences supply bindings to the original command registry.
 * Dispatch, input ownership and business permission remain with its handlers. */
export class CommandBindings {
  private overrides: Record<string, string | null> = {};
  private listeners = new Set<() => void>();
  private snapshot: { revision: number; problem: "invalid" | "storage" | null } = { revision: 0, problem: null };
  constructor(readonly catalog: readonly BindingEntry[]) {
    let raw: string | null;
    try { raw = localStorage.getItem(COMMAND_BINDINGS_STORAGE_KEY); }
    catch { this.snapshot = { revision: 0, problem: "storage" }; return; }
    if (raw === null) return;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command bindings");
      for (const [id, binding] of Object.entries(value)) {
        if (!catalog.some(command => command.id === id) || binding !== null && (typeof binding !== "string" || normalize(binding) !== binding || reserved.has(binding))) throw new Error("Invalid command binding");
        this.overrides[id] = binding;
      }
      const bindings = catalog.map(command => this.resolve(command.id, command.binding)).filter(binding => binding !== null);
      if (new Set(bindings).size !== bindings.length) throw new Error("Conflicting command bindings");
    } catch { this.overrides = {}; this.snapshot = { revision: 0, problem: "invalid" }; }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  resolve(id: WorkbenchCommandId, fallback: string | null): string | null { return Object.hasOwn(this.overrides, id) ? this.overrides[id] : fallback; }
  set(id: WorkbenchCommandId, input: string): BindingResult {
    const entry = this.catalog.find(command => command.id === id), binding = normalize(input);
    if (!entry || binding === undefined) return { kind: "invalid" };
    if (binding !== null && reserved.has(binding)) return { kind: "reserved" };
    const conflict = binding === null ? undefined : this.catalog.find(command => command.id !== id && this.resolve(command.id, command.binding) === binding);
    if (conflict) return { kind: "conflict", command: conflict };
    const next = { ...this.overrides };
    if (binding === entry.binding) delete next[id]; else next[id] = binding;
    return this.persist(next);
  }
  reset(): BindingResult { return this.persist({}); }
  private persist(next: Record<string, string | null>): BindingResult {
    try { localStorage.setItem(COMMAND_BINDINGS_STORAGE_KEY, JSON.stringify(next)); }
    catch { this.snapshot = { revision: this.snapshot.revision + 1, problem: "storage" }; this.listeners.forEach(listener => listener()); return { kind: "storage" }; }
    this.overrides = next; this.snapshot = { revision: this.snapshot.revision + 1, problem: null };
    this.listeners.forEach(listener => listener()); return { kind: "saved" };
  }
}
