import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Folder, FileInput, Languages, BookOpen, CheckCheck, PackageCheck, Sparkles, Columns3, ListTodo } from "lucide-react";

export type WorkspaceArea = "overview" | "source" | "translation" | "resources" | "review" | "release" | "ai" | "arena" | "tasks";
interface WorkspaceView {
  area: WorkspaceArea;
  activate: (area: WorkspaceArea) => void;
  deactivate: (area: WorkspaceArea) => void;
}
const WorkspaceViewContext = createContext<WorkspaceView | null>(null);
export const WorkspaceViewProvider = WorkspaceViewContext.Provider;

export function useWorkbenchView(area: WorkspaceArea): [boolean, (open: boolean) => void] {
  const view = useContext(WorkspaceViewContext);
  if (!view) throw new Error("Workbenches require a workspace view owner");
  return [view.area === area, open => open ? view.activate(area) : view.deactivate(area)];
}

const entries = [
  { area: "overview", label: "workbench.overview", icon: Folder },
  { area: "source", label: "source.title", icon: FileInput },
  { area: "translation", label: "translation.title", icon: Languages },
  { area: "resources", label: "resource.title", icon: BookOpen },
  { area: "review", label: "review.title", icon: CheckCheck },
  { area: "release", label: "release.title", icon: PackageCheck },
  { area: "ai", label: "ai.open", icon: Sparkles },
  { area: "arena", label: "arena.open", icon: Columns3 },
  { area: "tasks", label: "execution.title", icon: ListTodo },
] as const;

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

/** Views stay mounted; changing the visible area never owns or discards business drafts. */
export function WorkbenchPanel({ open, title, description, onBack, backDisabled = false, className = "", children }: {
  open: boolean; title: string; description: string; onBack: () => void; backDisabled?: boolean; className?: string; children: ReactNode;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open) heading.current?.focus(); }, [open]);
  return <section hidden={!open} className={`workbench-panel ${className}`} aria-label={title}>
    <header className="workbench-heading">
      <div><h1 ref={heading} tabIndex={-1}>{title}</h1><p>{description}</p></div>
      <button type="button" className="text-button" onClick={onBack} disabled={backDisabled}>{t("workbench.backOverview")}</button>
    </header>
    {children}
  </section>;
}
