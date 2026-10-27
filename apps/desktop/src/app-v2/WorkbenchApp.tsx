import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { useStore } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { ArrowUp, BookOpen, ChevronDown, Circle, CircleDot, Command, Layers, PanelRight, Pin, Plus, Search, Settings, Sparkles, X } from "lucide-react";
import { ApplicationReadProvider } from "../ApplicationReadProvider";
import { SessionReadProvider } from "../SessionReadProvider";
import { executionContext } from "../executionCommands";
import { readRecentProjects, recentProjectName, rememberProject, type RecentProject } from "../recentProjects";
import { Button, IconButton } from "../design-system/Button";
import { Field, TextInput } from "../design-system/Field";
import { Banner, EmptyState, ErrorState, LoadingState } from "../design-system/Feedback";
import { Dialog, Sheet } from "../design-system/Dialog";
import { Menu } from "../design-system/Menu";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "../design-system/Tabs";
import { SplitView, SplitPanel, SplitHandle } from "../design-system/SplitView";
import { CommandPalette } from "../design-system/CommandPalette";
import { ProjectLifecycle, type ProjectSession } from "./platform/projectLifecycle";
import { useNativeProjectClose, useProjectLifecycle } from "./platform/useProjectLifecycle";
import { createWorkspaceStore, type WorkspaceView } from "./workspace/workspaceStore";
import { createWorkspaceRouter } from "./workspace/workspaceRouter";
import { InteractionGate } from "./workspace/interactionGate";
import { registerWorkspaceCommands, createWorkspaceCommandDispatcher, workspaceCommandIds, type WorkspaceCommandId } from "./workspace/workspaceCommands";
import type { WorkbenchCommands } from "../workbenchCommands";
import type { EntriesHandle } from "./features/entries/EntriesView";
import { installWorkspaceMenu } from "./nativeMenu";
import { FeatureBoundary } from "./FeatureBoundary";
import styles from "./WorkbenchLayout.module.css";
import appStyles from "./WorkbenchApp.module.css";

const EntriesView = lazy(() => import("./features/entries/EntriesView"));
const EntryDetails = lazy(() => import("./features/entries/EntryDetails"));
type Runtime = ReturnType<typeof createWorkspaceRouter>;
type SessionContext = { session: ProjectSession; lifecycle: ProjectLifecycle; runtime: Runtime; store: ReturnType<typeof createWorkspaceStore>; gate: InteractionGate; readOnly: boolean; requestOpen: () => void };
const WorkspaceContext = createContext<SessionContext | null>(null);
function useWorkspaceContext() { const value = useContext(WorkspaceContext); if (!value) throw new Error("A project workspace is required"); return value; }
function subscribeWidth(listener: () => void) { window.addEventListener("resize", listener); return () => window.removeEventListener("resize", listener); }

function ProjectWorkspace({ session, lifecycle, gate, readOnly, requestOpen }: { session: ProjectSession; lifecycle: ProjectLifecycle; gate: InteractionGate; readOnly: boolean; requestOpen: () => void }) {
  const [store] = useState(() => createWorkspaceStore({ initialLocale: session.project.metadata.targetLocales[0] ?? "" }));
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [navigationFailed, setNavigationFailed] = useState(false);
  useEffect(() => lifecycle.register({ id: "workspace-composition", area: "translation", scope: { kind: "project", ...executionContext(session.project) },
    inspect: () => ({ status: gate.getSnapshot().composingOwners.length ? "blocked" : "ready", revision: JSON.stringify(gate.getSnapshot().composingOwners) }), prepareLeave: async () => false,
  }), [gate, lifecycle, session.project.sessionToken]);
  useEffect(() => {
    let alive = true, next: Runtime | undefined;
    // Let participant registration and StrictMode cleanup settle before acquiring a leave permit.
    queueMicrotask(() => {
      if (!alive) return;
      next = createWorkspaceRouter({ store, gate, guard: (intent, current) => lifecycle.prepareLeave(intent, current), component: WorkspaceShell, onError: () => { if (alive) setNavigationFailed(true); } });
      setRuntime(next);
      void next.ready.then(accepted => { if (alive && !accepted) setNavigationFailed(true); }).catch(() => { if (alive) setNavigationFailed(true); });
    });
    return () => { alive = false; next?.dispose(); };
  }, [store, gate, lifecycle]);
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  if (!runtime) return <LoadingState label={t("loadingEntries")} />;
  return <WorkspaceContext.Provider value={{ session, lifecycle, runtime, store, gate, readOnly, requestOpen }}>
    {navigationFailed ? <Banner tone="error">{t("leaveChanged")}</Banner> : null}
    <RouterProvider router={runtime.router} />
  </WorkspaceContext.Provider>;
}

function WorkspaceShell() {
  const { session, lifecycle, runtime, store, gate, readOnly, requestOpen } = useWorkspaceContext();
  const { t, i18n } = useTranslation();
  const message = useTranslation(undefined, { keyPrefix: "workbenchV2" }).t;
  const state = useStore(store), view = state.activeViewId ? state.views[state.activeViewId] : null;
  const lifecycleState = useProjectLifecycle(lifecycle);
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const narrow = useSyncExternalStore(subscribeWidth, () => innerWidth <= 1100, () => false);
  const wide = useSyncExternalStore(subscribeWidth, () => innerWidth >= 1440, () => false);
  const [registries, setRegistries] = useState<Map<string | null, WorkbenchCommands>>(new Map());
  const [palette, setPalette] = useState(false), [drawer, setDrawer] = useState(false);
  const paletteRelease = useRef<(() => void) | null>(null), drawerRelease = useRef<(() => void) | null>(null);
  const [commandFailed, setCommandFailed] = useState(false);
  const entries = useRef<EntriesHandle>(null), dock = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null), splitHandle = useRef<HTMLDivElement>(null);
  const currentId = state.activeViewId;
  const disabled = readOnly || lifecycleState.phase !== "idle" || !!lifecycleState.pending;
  const currentScope = () => {
    const current = lifecycle.getSnapshot();
    return !readOnly && current.phase === "idle" && !current.pending && current.session?.project.sessionToken === session.project.sessionToken
      ? { ...executionContext(session.project), area: "translation" as const } : null;
  };
  function closePalette() { paletteRelease.current?.(); paletteRelease.current = null; setPalette(false); }
  function openPalette() { if (paletteRelease.current) return; paletteRelease.current = gate.pushDialog("workspace-palette"); setPalette(true); }
  function closeDrawer() { drawerRelease.current?.(); drawerRelease.current = null; setDrawer(false); }
  function showDock() {
    if (narrow && !drawerRelease.current) { drawerRelease.current = gate.pushDialog("workspace-dock"); setDrawer(true); }
    else requestAnimationFrame(() => dock.current?.focus());
  }
  const ids = state.viewOrder.join("|");
  useEffect(() => {
    let alive = true;
    void import("../workbenchCommands").then(({ WorkbenchCommands: Owner }) => {
      if (!alive) return;
      setRegistries(previous => {
        const next = new Map(previous);
        for (const id of [...store.getState().viewOrder, null]) if (!next.has(id)) next.set(id, new Owner());
        for (const id of next.keys()) if (id !== null && !store.getState().views[id]) next.delete(id);
        return next;
      });
    }).catch(() => { if (alive) setCommandFailed(true); });
    return () => { alive = false; };
  }, [ids, store]);
  const commands = registries.get(currentId);
  const scope = useMemo(() => ({ ...executionContext(session.project), area: "translation" as const }), [session.project.sessionToken, session.project.metadata.projectId]);
  const actions = useRef({ requestOpen, close: () => lifecycle.close(), refresh: () => { void lifecycle.refresh(); entries.current?.refresh(); } });
  actions.current = { requestOpen, close: () => lifecycle.close(), refresh: () => { void lifecycle.refresh(); entries.current?.refresh(); } };
  useEffect(() => {
    if (!commands) return;
    return registerWorkspaceCommands({ commands, store, gate, viewId: currentId, defaultLocale: session.project.metadata.targetLocales[0], scope, getCurrentScope: currentScope, navigation: runtime.navigation,
      actions: { openProject: () => actions.current.requestOpen(), closeProject: () => actions.current.close(), closeWindow: async () => {
        if (isTauri()) { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await lifecycle.closeWindow(() => getCurrentWindow().destroy()); }
      }, refresh: () => actions.current.refresh(), focusSearch: () => entries.current?.focusSearch(), focusAgent: showDock, focusDetails: showDock, openCommands: openPalette }, onError: () => setCommandFailed(true) });
  }, [commands, currentId, gate, store, runtime, lifecycle, scope, narrow, readOnly]);
  const dispatcher = useMemo(() => createWorkspaceCommandDispatcher({ gate, modifier: navigator.platform.includes("Mac") ? "meta" : "ctrl", getContext: () => {
    const id = store.getState().activeViewId, owner = registries.get(id), actualScope = currentScope();
    return owner && actualScope ? { viewId: id, scope: actualScope, commands: owner } : null;
  } }), [gate, store, registries, scope, readOnly]);
  const dispatch = (id: WorkspaceCommandId) => dispatcher.dispatch(id, { source: "button", viewId: currentId });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key) && gate.canDispatch({ viewId: currentId, source: "keyboard" })) {
        const id = store.getState().viewOrder[Number(event.key) - 1];
        if (id) { event.preventDefault(); void runtime.navigation.activate(id); } return;
      }
      dispatcher.handleKeyDown(event, currentId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatcher, currentId, gate, store, runtime]);
  useEffect(() => {
    if (!isTauri() || !commands) return;
    return installWorkspaceMenu(dispatcher.list({ source: "native-menu" }), key => t(key), id => dispatcher.dispatch(id, { source: "native-menu", viewId: currentId }), () => setCommandFailed(true));
  }, [dispatcher, commands, currentId, i18n.resolvedLanguage, disabled, interaction.intentOwner]);
  useEffect(() => () => { paletteRelease.current?.(); drawerRelease.current?.(); }, [gate]);
  const activeLocale = view?.locale ?? session.project.metadata.targetLocales[0] ?? "";
  function panel() {
    return <TabsRoot value={view?.dock ?? "agent"} onValueChange={value => { if (view && (value === "agent" || value === "details")) store.getState().patch(view.id, { dock: value }); }} className={styles.dockTabs}>
      <TabsList aria-label={message("dockTabs")}><TabsTrigger value="agent"><Sparkles />{message("agent")}</TabsTrigger><TabsTrigger value="details">{message("detail")}</TabsTrigger></TabsList>
      <TabsContent value="agent" className={styles.dockContent}><EmptyState icon={<Sparkles />} title={message("agent")} description={message("agentHelp")} /></TabsContent>
      <TabsContent value="details" className={styles.dockContent}><FeatureBoundary key={currentId} fallback={<ErrorState title={message("featureFailed")} description={message("featureFailedHelp")} />}><Suspense fallback={<LoadingState label={message("loadingDetails")} />}><EntryDetails unitId={view?.focus ?? null} locale={activeLocale} disabled={disabled} /></Suspense></FeatureBoundary></TabsContent>
    </TabsRoot>;
  }
  return <div className={styles.frame} onCompositionStartCapture={() => gate.setComposing("workspace", true)} onCompositionEndCapture={() => gate.setComposing("workspace", false)}>
    <header className={styles.titlebar} data-tauri-drag-region>
      <span className={styles.wordmark}>紡</span><Menu label={message("projectCommands")} trigger={<Button size="sm"><span className={styles.project}>{session.project.metadata.displayName}</span><ChevronDown /></Button>} items={[
        { id: "open", label: message("openProject"), onSelect: () => dispatch("workspace.open-project"), disabled: disabled || !commands }, { id: "close", label: message("closeProject"), onSelect: () => dispatch("workspace.close-project"), disabled: disabled || !commands },
      ]} />
      <span className={styles.breadcrumb}>›</span><Menu label={message("language")} trigger={<Button size="sm" disabled={disabled}>{activeLocale}<ChevronDown /></Button>} items={session.project.metadata.targetLocales.map(locale => ({ id: locale, label: locale, onSelect: () => { if (view) void runtime.navigation.update(view.id, { locale }); } }))} />
      <Button className={styles.commandSearch} size="sm" disabled={!commands || disabled} onClick={() => dispatch("workspace.commands")}><Search />{message("commandPlaceholder")}</Button>
      <IconButton className={styles.dockToggle} label={message("openAgent")} onClick={() => dispatch("workspace.agent")}><PanelRight /></IconButton>
    </header>
    {commandFailed ? <Banner tone="error">{message("actionFailed")}</Banner> : null}
    <div className={styles.body}>
      <nav className={styles.activity} aria-label={message("activity")}>
        {[{ id: "entries", icon: <Layers /> }, { id: "knowledge", icon: <BookOpen /> }, { id: "runs", icon: <Sparkles /> }, { id: "delivery", icon: <ArrowUp /> }, { id: "decisions", icon: <CircleDot /> }].map(({ id, icon }) => <div key={id} className={styles.activityItem} data-active={view?.kind === id || undefined}><IconButton label={message(id === "entries" ? "entries" : id === "knowledge" ? "knowledge" : id === "runs" ? "runs" : id === "delivery" ? "delivery" : "decisions")} disabled={id !== "entries" || disabled} title={id !== "entries" ? message("comingLater") : undefined} onClick={event => {
          const existing = store.getState().viewOrder.find(key => store.getState().views[key].kind === "entries");
          if (!(event.metaKey || event.ctrlKey) && existing) void runtime.navigation.activate(existing); else dispatch("workspace.new-view");
        }}>{icon}</IconButton></div>)}
        <div className={styles.activityBottom}><IconButton label={message("extensions")} disabled title={message("comingLater")}><Command /></IconButton><IconButton label={message("settings")} disabled title={message("comingLater")}><Settings /></IconButton></div>
      </nav>
      <SplitView key={currentId} className={styles.workspaceSplit} elementRef={split} disabled={disabled} onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction || !view || narrow) return;
        const available = (split.current?.clientWidth ?? 0) - (splitHandle.current?.getBoundingClientRect().width ?? 0);
        const percentage = (meta.requestedLayout ?? layout)["workspace-dock"];
        if (available > 0 && percentage !== undefined) {
          const pixels = Math.round(percentage / 100 * available);
          if (pixels !== view.dockSize) store.getState().patch(view.id, { dockSize: pixels });
        }
      }}>
        <SplitPanel minSize={0} className={styles.mainPanel}><main className={styles.main}>
          <div className={styles.viewTabs} aria-label={message("views")} role="navigation">{state.viewOrder.map(id => {
            const item = state.views[id], name = message("viewName", { locale: item.locale });
            return <div key={id} className={appStyles.viewTab} data-active={id === currentId || undefined}>
              <Button size="sm" aria-current={id === currentId ? "page" : undefined} onClick={() => { if (!disabled) void runtime.navigation.activate(id); }}>{item.pinned ? <Pin /> : null}{name}</Button>
              {!item.pinned ? <IconButton size="xs" label={message("closeView", { name })} disabled={disabled} onClick={() => void runtime.navigation.close(id)}><X /></IconButton> : null}
            </div>;
          })}<IconButton size="xs" label={message("newView")} disabled={disabled || !commands} onClick={() => dispatch("workspace.new-view")}><Plus /></IconButton>
            {view ? <IconButton size="xs" label={message(view.pinned ? "unpinView" : "pinView")} disabled={disabled} onClick={() => dispatch("workspace.pin-view")}><Pin /></IconButton> : null}
          </div>
          {view ? view.kind === "entries" ? <FeatureBoundary key={view.id} fallback={<ErrorState title={message("featureFailed")} description={message("featureFailedHelp")} />}><Suspense fallback={<LoadingState label={message("loadingEntries")} />}><EntriesView ref={entries} project={session.project} view={view} disabled={readOnly || !!lifecycleState.pending} patch={patch => store.getState().patch(view.id, patch)} navigate={async patch => {
            const accepted = await runtime.navigation.update(view.id, patch);
            if (accepted && patch.focus && narrow) showDock();
            return accepted;
          }} /></Suspense></FeatureBoundary> : <EmptyState title={message(view.kind)} description={message("comingLater")} /> : <EmptyState icon={<Layers />} title={message("noViews")} action={<Button onClick={() => dispatch("workspace.new-view")}>{message("openEntries")}</Button>} />}
        </main></SplitPanel>
        {!narrow ? <><SplitHandle label={message("resizeDock")} elementRef={splitHandle} /><SplitPanel id="workspace-dock" key={wide ? "wide" : "compact"} groupResizeBehavior="preserve-pixel-size" defaultSize={view?.dockSize ?? (wide ? 380 : 340)} minSize={300} maxSize="45%"><aside className={styles.dock} ref={dock} tabIndex={-1} aria-label={message("agent")}>{panel()}</aside></SplitPanel></> : null}
      </SplitView>
    </div>
    <footer className={styles.statusbar}><span><Circle />{message(readOnly ? "retired" : "liveProject")}</span><span className={styles.statusEnd}>{message("language")} · {activeLocale}</span></footer>
    <Sheet open={drawer && narrow} onOpenChange={open => { if (!open) closeDrawer(); }} title={message("agent")} description={session.project.metadata.displayName} closeLabel={message("close")}>{panel()}</Sheet>
    <CommandPalette open={palette} onOpenChange={open => { if (!open) closePalette(); }} title={message("commands")} placeholder={message("commandPlaceholder")} emptyLabel={message("noCommands")} closeLabel={message("close")} groups={[{ label: message("viewCommands"), commands: dispatcher.list({ source: "palette", dialogId: "workspace-palette" }).flatMap(command => {
      const id = workspaceCommandIds.find(value => value === command.id);
      return id ? [{ id, label: t(command.nameKey), disabled: !command.availability.enabled, kbd: command.binding?.replace("Mod", navigator.platform.includes("Mac") ? "⌘" : "Ctrl"), onSelect: () => { closePalette(); dispatcher.dispatch(id, { source: "palette", viewId: currentId }); } }] : [];
    }) }]} />
  </div>;
}

export default function WorkbenchApp({ controller: suppliedController, native = isTauri() }: { controller?: ProjectLifecycle; native?: boolean } = {}) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const [stop, setStop] = useState<{ resolve: (allow: boolean) => void; current: () => boolean } | null>(null);
  const [gate] = useState(() => new InteractionGate());
  const [controller] = useState(() => suppliedController ?? new ProjectLifecycle({ confirmStop: (_project, _status, current) => new Promise(resolve => setStop({ resolve, current })) }));
  const state = useProjectLifecycle(controller), nativeClose = useNativeProjectClose(controller, native);
  const [locator, setLocator] = useState(""), [openPanel, setOpenPanel] = useState(false), [discard, setDiscard] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>(readRecentProjects), [pickerFailed, setPickerFailed] = useState(false);
  const [closeActionFailed, setCloseActionFailed] = useState(false);
  const busy = state.phase !== "idle", blocked = busy || !!state.pending || !!state.retainedSession || !!state.cleanup;
  const presentation = state.retainedSession ?? state.closingSession ?? state.session;
  const pathSequence = useRef(0);
  useLayoutEffect(() => openPanel ? gate.pushDialog("project-open") : undefined, [gate, openPanel]);
  useLayoutEffect(() => stop ? gate.pushDialog("stop-running") : undefined, [gate, stop]);
  useLayoutEffect(() => discard ? gate.pushDialog("discard-workspace") : undefined, [gate, discard]);
  useEffect(() => controller.register({ id: "application-input", area: "overview", scope: { kind: "application" },
    inspect: intent => ({ status: gate.getSnapshot().composingOwners.length || discard || openPanel && intent.kind !== "open-project" ? "blocked" : "ready", revision: `${pathSequence.current}:${discard}:${openPanel}:${gate.getSnapshot().composingOwners.join(",")}` }),
    prepareLeave: async () => false,
  }), [controller, gate, discard, openPanel]);
  async function open(path: string) {
    const sequence = pathSequence.current;
    const success = await controller.open(path);
    const project = controller.getSnapshot().session?.project;
    if (project) setRecent(rememberProject(project));
    if (success && sequence === pathSequence.current) setOpenPanel(false);
    else if (project && sequence !== pathSequence.current) setOpenPanel(true);
  }
  async function chooseFolder() {
    try { const chosen = await pickDirectory({ directory: true, multiple: false }); if (typeof chosen === "string") { pathSequence.current++; setLocator(chosen); setPickerFailed(false); } }
    catch { setPickerFailed(true); }
  }
  async function continueClosing() {
    const original = controller.getSnapshot().cleanup?.request;
    if (!original || controller.getSnapshot().cleanup?.state !== "stopping") return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const current = controller.getSnapshot();
    if (current.cleanup?.request !== original || current.cleanup.state !== "stopping" || current.pending) return;
    await controller.closeWindow(() => getCurrentWindow().destroy());
  }
  const openForm = <form className={appStyles.openForm} onSubmit={event => { event.preventDefault(); if (!blocked && native) void open(locator); }}>
    <Field id="workbench-project-folder" label={t("projectFolder")}><TextInput id="workbench-project-folder" placeholder={t("folderPlaceholder")} value={locator} onChange={event => { pathSequence.current++; setLocator(event.target.value); }} /></Field>
    <div className={styles.actions}><Button disabled={!native || blocked} onClick={() => void chooseFolder()}>{t("chooseFolder")}</Button><Button variant="primary" type="submit" pending={busy} disabled={!native || blocked || !locator.trim()}>{t("openProject")}</Button></div>
  </form>;
  const error = state.failure;
  const errorText = error?.code === "unknown-lifecycle" || error?.code === "recovery-unavailable" ? t("unknown") : error?.code === "leave-blocked" ? t("leaveBlocked") : error?.code === "leave-changed" ? t("leaveChanged")
    : error?.code === "application-stopping" || error?.code === "application-unknown" || error?.code === "runtime-pending" ? t("cleanupPending") : error?.code === "read-failed" ? t("readFailed") : error?.code === "destroy-failed" ? t("windowCloseFailed") : t("actionFailed");
  return <ApplicationReadProvider>
    <div className={appStyles.app}>
      {!native ? <Banner>{t("desktopRequired")}</Banner> : null}
      {nativeClose.state === "failed" ? <Banner tone="error">{t("nativeCloseFailed")}</Banner> : null}
      {pickerFailed ? <Banner tone="error">{t("pickFailed")}</Banner> : null}
      {closeActionFailed ? <Banner tone="error">{t("actionFailed")}</Banner> : null}
      {state.cleanup?.state === "stopped" ? <Banner action={<Button disabled={busy || !!state.pending || !!state.retainedSession} onClick={() => void controller.resumeApplication()}>{t("resumeWork")}</Button>}>{t("workStopped")}</Banner> : null}
      {state.cleanup?.state === "stopping" ? <Banner action={<Button disabled={busy || !!state.pending || !!state.retainedSession || !native} onClick={() => void continueClosing().catch(() => setCloseActionFailed(true))}>{t("continueClosing")}</Button>}>{t("cleanupPending")}</Banner> : null}
      {error ? <Banner tone="error" action={state.pending?.kind === "runtime" || state.pending?.session && (state.pending.kind === "open" || state.pending.kind === "close") ? <Button disabled={busy} onClick={() => void controller.checkPending()}>{t("checkResult")}</Button> : undefined}>{errorText}</Banner> : null}
      {state.retainedSession ? <Banner tone="warning" action={<Button onClick={() => setDiscard(true)}>{t("discardRetained")}</Button>}>{t("retained")}</Banner> : null}
      {presentation ? <SessionReadProvider key={`${presentation.project.metadata.projectId}:${presentation.project.sessionToken}`} context={executionContext(presentation.project)} reads={presentation.reads} bridge={!presentation.reads.retired}>
        <ProjectWorkspace session={presentation} lifecycle={controller} gate={gate} readOnly={presentation !== state.session || !!state.retainedSession} requestOpen={() => setOpenPanel(true)} />
      </SessionReadProvider> : <main className={appStyles.welcome}><span className={appStyles.brand}>紡 Tsumugi</span><h1>{t("welcome")}</h1><p>{t("welcomeHelp")}</p>{openForm}
        {recent.length ? <section className={appStyles.recent}><h2>{t("recent")}</h2>{recent.map(item => <Button key={item.locator} disabled={!native || blocked} onClick={() => void open(item.locator)}>{recentProjectName(item.locator)}</Button>)}</section> : null}
      </main>}
      <Dialog open={openPanel && !!presentation} onOpenChange={setOpenPanel} title={t("openProject")} description={t("welcomeHelp")} closeLabel={t("close")}>{openForm}</Dialog>
      <Dialog open={!!stop} onOpenChange={value => { if (!value && stop) { stop.resolve(false); setStop(null); } }} title={t("stopTitle")} description={t("stopHelp")} closeLabel={t("stay")} footer={<><Button onClick={() => { stop?.resolve(false); setStop(null); }}>{t("stay")}</Button><Button variant="danger" onClick={() => { if (stop) stop.resolve(stop.current()); setStop(null); }}>{t("stopAndLeave")}</Button></>}>{t("stopHelp")}</Dialog>
      <Dialog open={discard} onOpenChange={setDiscard} title={t("discardRetained")} description={t("discardHelp")} closeLabel={t("stay")} footer={<><Button onClick={() => setDiscard(false)}>{t("stay")}</Button><Button variant="danger" onClick={() => { controller.discardRetained(); setDiscard(false); }}>{t("discardRetained")}</Button></>}>{t("discardHelp")}</Dialog>
    </div>
  </ApplicationReadProvider>;
}
