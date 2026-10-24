import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Folder, FileInput, Languages, BookOpen, CheckCheck, PackageCheck, Sparkles, Columns3, ListTodo } from "lucide-react";
import { useSessionReads } from "./SessionReadProvider";
import type { ChangeScope } from "./sessionReads";
import { languageName } from "./i18n/languageNames";

export interface AttemptWorkbenchHandle {
  allowLeave: (current?: () => boolean, intentCurrent?: () => boolean) => Promise<boolean>;
  showAttempt: (id: string) => void;
}

export type WorkspaceArea = "overview" | "source" | "translation" | "resources" | "review" | "release" | "ai" | "arena" | "tasks";
export type WorkbenchContextScope =
  | { kind: "project" | "unselected" | "task" }
  | { kind: "entry" | "term" | "file" | "release"; name: string }
  | { kind: "selection" | "preparation" | "languages" | "assessment"; count: number }
  | { kind: "entrySelection"; name: string; count: number };
/** A scoped presentation of existing owners, never a selection or execution authority. */
export interface WorkbenchContextPresentation {
  projectId: string;
  sessionToken: string;
  metadataRevision: string;
  area: WorkspaceArea;
  targetKind: "project" | "working" | "release";
  locales: readonly string[];
  scope: WorkbenchContextScope;
}
/** Project-scoped view inputs only. Query results and business drafts keep their existing owners. */
export class WorkspaceViewMemory {
  private inputs = new Map<string, unknown>();
  private listeners = new Map<string, Set<() => void>>();
  read<T>(area: WorkspaceArea, key: string): T | undefined { return this.inputs.get(`${area}:${key}`) as T | undefined; }
  write<T>(area: WorkspaceArea, key: string, value: T) {
    const identity = `${area}:${key}`;
    if (this.inputs.has(identity) && Object.is(this.inputs.get(identity), value)) return;
    this.inputs.set(identity, value); this.listeners.get(identity)?.forEach(notify => notify());
  }
  subscribe(area: WorkspaceArea, key: string, notify: () => void) {
    const identity = `${area}:${key}`, listeners = this.listeners.get(identity) ?? new Set<() => void>();
    this.listeners.set(identity, listeners); listeners.add(notify);
    return () => { listeners.delete(notify); if (!listeners.size) this.listeners.delete(identity); };
  }
  clear() { this.inputs.clear(); this.listeners.forEach(listeners => listeners.forEach(notify => notify())); }
  observeChanges(scopes: readonly ChangeScope[]) {
    if (scopes.includes("review") || scopes.includes("project")) {
      const cursor = this.read<{ unitId: string; locale: string; offset: number }>("review", "historyCursor");
      if (cursor && cursor.offset !== 0) this.write("review", "historyCursor", { ...cursor, offset: 0 });
    }
    if (scopes.includes("source")) {
      for (const key of ["history.offset", "historyOffset"]) {
        const cursor = this.read<number | null>("source", key);
        if (cursor != null && cursor !== 0) this.write("source", key, 0);
      }
    }
  }
}
interface WorkspaceView {
  area: WorkspaceArea;
  activate: (area: WorkspaceArea) => void;
  deactivate: (area: WorkspaceArea) => void;
  memory: WorkspaceViewMemory;
}
const WorkspaceViewContext = createContext<WorkspaceView | null>(null);
export const WorkspaceViewProvider = WorkspaceViewContext.Provider;

export function useWorkspaceView() {
  const view = useContext(WorkspaceViewContext);
  if (!view) throw new Error("Workbenches require a workspace view owner");
  return view;
}

/** Observe a retained view input without initializing or changing it. */
export function useWorkbenchValue<T>(area: WorkspaceArea, key: string): T | undefined {
  const { memory } = useWorkspaceView();
  const snapshot = useCallback(() => memory.read<T>(area, key), [memory, area, key]);
  const subscribe = useCallback((notify: () => void) => memory.subscribe(area, key, notify), [memory, area, key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Semantic cursor changes survive consumer unmount; Query facts remain in SessionReads. */
export function useWorkspaceViewChanges() {
  const { memory } = useWorkspaceView(), reads = useSessionReads();
  useEffect(() => reads.subscribeChanges(scopes => memory.observeChanges(scopes)), [reads, memory]);
}

export function useWorkbenchState<T>(area: WorkspaceArea, key: string, initial: T | (() => T)): [T, (value: SetStateAction<T>) => void] {
  const { memory } = useWorkspaceView();
  const [initialValue] = useState<T>(() => {
    const retained = memory.read<T>(area, key);
    return retained === undefined ? typeof initial === "function" ? (initial as () => T)() : initial : retained;
  });
  const snapshot = useCallback(() => {
    const retained = memory.read<T>(area, key); return retained === undefined ? initialValue : retained;
  }, [memory, area, key, initialValue]);
  const subscribe = useCallback((notify: () => void) => memory.subscribe(area, key, notify), [memory, area, key]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot), alive = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { memory.write(area, key, value); }, [memory, area, key, value]);
  const update = useCallback((next: SetStateAction<T>) => {
    if (!alive.current) return;
    const result = typeof next === "function" ? (next as (before: T) => T)(snapshot()) : next;
    memory.write(area, key, result);
  }, [memory, area, key, snapshot]);
  return [value, update];
}

/** Retain request cursors/tokens without retaining the read snapshots they address. */
export function useWorkbenchRef<T>(area: WorkspaceArea, key: string, initial: T): { current: T } {
  const { memory } = useWorkspaceView();
  const local = useRef(initial), alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    if (memory.read<T>(area, key) === undefined) memory.write(area, key, local.current);
    return () => { alive.current = false; };
  }, [memory, area, key]);
  return useMemo(() => ({
    get current() { const retained = memory.read<T>(area, key); return retained === undefined ? local.current : retained; },
    set current(value: T) { if (alive.current) { local.current = value; memory.write(area, key, value); } },
  }), [memory, area, key]);
}

export function useWorkbenchView(area: WorkspaceArea): [boolean, (open: boolean) => void] {
  const view = useContext(WorkspaceViewContext);
  if (!view) throw new Error("Workbenches require a workspace view owner");
  return [view.area === area, open => open ? view.activate(area) : view.deactivate(area)];
}

const entries = [
  { area: "overview", label: "workbench.overview", icon: Folder },
  { area: "ai", label: "ai.open", icon: Sparkles },
  { area: "source", label: "source.title", icon: FileInput },
  { area: "translation", label: "translation.title", icon: Languages },
  { area: "resources", label: "resource.title", icon: BookOpen },
  { area: "review", label: "review.title", icon: CheckCheck },
  { area: "release", label: "release.title", icon: PackageCheck },
  { area: "arena", label: "arena.open", icon: Columns3 },
  { area: "tasks", label: "execution.title", icon: ListTodo },
] as const;

const contextScopeLabels = {
  project: "workbench.context.projectScope", unselected: "workbench.context.unselectedScope",
  task: "workbench.context.taskScope", entry: "workbench.context.entryScope", term: "workbench.context.termScope",
  file: "workbench.context.fileScope", release: "workbench.context.releaseScope",
  selection: "workbench.context.selectionScope", preparation: "workbench.context.preparationScope",
  languages: "workbench.context.languagesScope", assessment: "workbench.context.assessmentScope",
  entrySelection: "workbench.context.entrySelectionScope",
} as const;

export function WorkbenchContext({ area, targetLocales, presentation }: {
  area: WorkspaceArea; targetLocales: readonly string[]; presentation: WorkbenchContextPresentation | null;
}) {
  const { t, i18n } = useTranslation();
  const targetKind = presentation?.targetKind ?? "project", locales = presentation?.locales ?? targetLocales;
  const scope = presentation?.scope ?? { kind: area === "overview" || area === "source" ? "project" as const : "unselected" as const };
  const languageList = new Intl.ListFormat(i18n.resolvedLanguage ?? i18n.language, { style: "short", type: "conjunction" });
  const targets = locales.length ? languageList.format(locales.map(locale => {
    const name = t("workbench.context.locale", { name: languageName(locale, i18n.resolvedLanguage ?? i18n.language), locale });
    return targetKind !== "project" && !targetLocales.includes(locale) ? t("workbench.context.removedLocale", { locale: name }) : name;
  })) : t("workbench.context.noTarget");
  let scopeText: string;
  switch (scope.kind) {
    case "entry": case "term": case "file": case "release":
      scopeText = t(contextScopeLabels[scope.kind], { name: scope.name }); break;
    case "selection": case "preparation": case "languages": case "assessment":
      scopeText = t(contextScopeLabels[scope.kind], { count: scope.count }); break;
    case "entrySelection":
      scopeText = t(contextScopeLabels[scope.kind], { name: scope.name, count: scope.count }); break;
    default: scopeText = t(contextScopeLabels[scope.kind]);
  }
  return <div className="workspace-context" role="group" aria-label={t("workbench.context.label")}>
    <dl>
      <div><dt>{t("workbench.context.area")}</dt><dd>{t(entries.find(entry => entry.area === area)!.label)}</dd></div>
      <div><dt>{t(targetKind === "project" ? "workbench.context.projectTargets" : targetKind === "release" ? "workbench.context.releaseTargets" : "workbench.context.workingTargets")}</dt><dd title={targets}>{targets}</dd></div>
      <div><dt>{t("workbench.context.scope")}</dt><dd title={scopeText}>{scopeText}</dd></div>
    </dl>
  </div>;
}

export function WorkbenchNavigation({ area, onNavigate, disabled, hasProject }: {
  area: WorkspaceArea; onNavigate: (area: WorkspaceArea) => void; disabled: boolean; hasProject: boolean;
}) {
  const { t } = useTranslation();
  const overview = useRef<HTMLButtonElement>(null);
  const previousArea = useRef(area);
  useEffect(() => {
    if (area === "overview" && previousArea.current !== area) overview.current?.focus();
    previousArea.current = area;
  }, [area]);
  return <nav className="navigation" aria-label={t("nav.workspace")}>
    {entries.filter(entry => hasProject || entry.area === "overview").map(entry => <button
      key={entry.area} ref={entry.area === "overview" ? overview : undefined} type="button" className="navigation-item" disabled={disabled}
      aria-current={area === entry.area ? "page" : undefined} onClick={() => onNavigate(entry.area)}>
      <entry.icon size={17} aria-hidden="true" /><span>{t(entry.label)}</span>
    </button>)}
  </nav>;
}

/** Panel visibility never owns or discards business drafts. */
export function WorkbenchPanel({ open, title, description, onBack, backDisabled = false, className = "", descriptionDisclosure = false, children }: {
  open: boolean; title: string; description: string; onBack: () => void; backDisabled?: boolean; className?: string; descriptionDisclosure?: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open) heading.current?.focus(); }, [open]);
  return <section hidden={!open} className={`workbench-panel ${className}`} aria-label={title}>
    <header className="workbench-heading">
      <div><h1 ref={heading} tabIndex={-1}>{title}</h1>{descriptionDisclosure ? <details className="workbench-help"><summary>{t("workbench.aboutWorkspace")}</summary><p>{description}</p></details> : <p>{description}</p>}</div>
      <button type="button" className="text-button" onClick={onBack} disabled={backDisabled}>{t("workbench.backOverview")}</button>
    </header>
    {children}
  </section>;
}
