import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { ConnectionDraftProvider, connectionDirty, useConnectionDraft } from "../../../ConnectionDraftSession";
import { ConnectionManager } from "../../../ConnectionManager";
import { PluginManager, type PluginManagerHandle } from "../../../PluginManager";
import { CommandBindings, type BindingResult } from "../../../commandBindings";
import { localeOptions, isLocale } from "../../../i18n";
import { Button } from "../../../design-system/Button";
import { Sheet } from "../../../design-system/Dialog";
import { Field, TextInput, Select } from "../../../design-system/Field";
import { Banner } from "../../../design-system/Feedback";
import fieldStyles from "../../../design-system/Field.module.css";
import type { SessionExitPermit } from "../../../sessionNavigation";
import type { ProjectLifecycle } from "../../platform/projectLifecycle";
import { workspaceCommandCatalog } from "../../workspace/workspaceCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ProjectReferenceHandle } from "./ProjectReferenceHost";
import styles from "./ApplicationSettings.module.css";

type Section = "general" | "appearance" | "connections" | "shortcuts" | "about";
const sections: Section[] = ["general", "appearance", "connections", "shortcuts", "about"];
const editorFontSizes = [14, 15, 16, 17, 18, 19, 20];
const editorFontSizeStorageKey = "tsumugi.editorFontSize";
function readEditorFontSize() {
  try {
    const size = Number(localStorage.getItem(editorFontSizeStorageKey));
    return { size: editorFontSizes.includes(size) ? size : 15, problem: false };
  } catch { return { size: 15, problem: true }; }
}
interface SettingsContext {
  open: (section?: Section, returnTo?: HTMLElement) => void;
  openExtensions: (returnTo?: HTMLElement) => void;
  openReferences?: (returnTo?: HTMLElement, fallbackReturnTo?: HTMLElement) => void;
  openMcpQuery?: (returnTo?: HTMLElement, fallbackReturnTo?: HTMLElement) => void;
  openMcpShare?: (returnTo?: HTMLElement, fallbackReturnTo?: HTMLElement) => void;
  bindings: CommandBindings;
  bindingsRevision: number;
  registerMcp: (handle: ProjectReferenceHandle) => () => void;
}
const Context = createContext<SettingsContext | null>(null);
export function useApplicationSettings() { const value = useContext(Context); if (!value) throw new Error("ApplicationSettingsProvider is required"); return value; }

export function ApplicationSettingsProvider(props: { lifecycle: ProjectLifecycle; gate: InteractionGate; native: boolean; children: ReactNode }) {
  return <ConnectionDraftProvider><ApplicationSettingsOwner {...props}/></ConnectionDraftProvider>;
}

function ApplicationSettingsOwner({ lifecycle, gate, native, children }: { lifecycle: ProjectLifecycle; gate: InteractionGate; native: boolean; children: ReactNode }) {
  const { t, i18n } = useTranslation(), owner = useConnectionDraft();
  const [bindings] = useState(() => new CommandBindings(workspaceCommandCatalog));
  const bindingState = useSyncExternalStore(bindings.subscribe, bindings.getSnapshot, bindings.getSnapshot);
  const lifecycleState = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const [open, setOpen] = useState(false), [section, setSection] = useState<Section>("general"), [extensionsOpen, setExtensionsOpen] = useState(false);
  const [editorFont, setEditorFont] = useState(readEditorFontSize);
  const [shortcutInputs, setShortcutInputs] = useState<Record<string, string>>({}), [shortcutError, setShortcutError] = useState<Record<string, Exclude<BindingResult, { kind: "saved" }>>>({});
  const [shortcutNotice, setShortcutNotice] = useState<"saved" | "restored" | "storage" | null>(null), [shortcutExit, setShortcutExit] = useState(false);
  const [mcp, setMcp] = useState<ProjectReferenceHandle | null>(null), currentMcp = useRef<ProjectReferenceHandle | null>(null);
  const [version, setVersion] = useState<{ kind: "idle" | "reading" | "failed" } | { kind: "ready"; value: string }>({ kind: "idle" });
  const [, setPluginBusy] = useState(false);
  const [versionAttempt, setVersionAttempt] = useState(0), [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const plugins = useRef<PluginManagerHandle>(null), exitPermit = useRef<SessionExitPermit | null>(null);
  const origin = useRef<HTMLElement | null>(null), handoff = useRef<{ target: ProjectReferenceHandle; kind: "reference" | "query" | "share" } | "extensions" | null>(null);
  const settingsDialog = useId(), extensionsDialog = useId(), compositionOwner = useId();
  const current = useRef({ owner, shortcutInputs, open });
  useLayoutEffect(() => { current.current = { owner, shortcutInputs, open }; });
  const registerMcp = useCallback((handle: ProjectReferenceHandle) => {
    currentMcp.current = handle; setMcp(handle);
    return () => { if (currentMcp.current === handle) { currentMcp.current = null; setMcp(null); } };
  }, []);
  const reveal = useCallback((next: Section = "general", returnTo?: HTMLElement) => {
    if (returnTo) origin.current = returnTo;
    else if (!current.current.open) origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSection(next); setOpen(true);
  }, [settingsDialog]);
  const show = useCallback((next: Section = "general", returnTo?: HTMLElement) => {
    if (lifecycle.getSnapshot().phase !== "idle" || !gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button" })) return;
    reveal(next, returnTo);
  }, [gate, lifecycle, reveal]);
  const openExtensions = useCallback((returnTo?: HTMLElement) => {
    if (lifecycle.getSnapshot().phase !== "idle" || !gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button" })) return;
    plugins.current?.open(returnTo);
  }, [gate, lifecycle]);
  useLayoutEffect(() => open ? gate.pushDialog(settingsDialog) : undefined, [open, gate, settingsDialog]);
  useLayoutEffect(() => extensionsOpen ? gate.pushDialog(extensionsDialog) : undefined, [extensionsOpen, gate, extensionsDialog]);
  useLayoutEffect(() => () => { gate.releaseOwner(compositionOwner); exitPermit.current?.release(); }, [gate, compositionOwner]);
  useLayoutEffect(() => {
    if (lifecycleState.phase === "idle" && exitPermit.current) { const held = exitPermit.current; exitPermit.current = null; held.release(); }
  }, [lifecycleState.phase]);
  useLayoutEffect(() => lifecycle.register({ id: "application-connections", area: "overview", scope: { kind: "application" },
    inspect: intent => {
      if (intent.kind !== "close-window") return { status: "ready", revision: "retained-application-connections" };
      const state = current.current.owner.current();
      return { status: exitPermit.current?.current() ? "ready" : state.busy || state.pending ? "blocked" : connectionDirty(state.editor) ? "dirty" : "ready",
        revision: JSON.stringify([state.editor.seq, state.busy, state.pending]) };
    },
    prepareLeave: async (_intent, proof, intentCurrent) => {
      if (!proof() || !intentCurrent()) return false;
      reveal("connections");
      const permit = await current.current.owner.prepareExit(intentCurrent);
      if (!permit || !permit.current()) { permit?.release(); return false; }
      exitPermit.current = permit; return true;
    }, reveal: () => reveal("connections"),
  }), [lifecycle, reveal]);
  useLayoutEffect(() => lifecycle.register({ id: "application-shortcuts", area: "overview", scope: { kind: "application" },
    inspect: intent => intent.kind === "close-window" ? { status: Object.keys(current.current.shortcutInputs).length ? "blocked" : "ready", revision: JSON.stringify(current.current.shortcutInputs) }
      : { status: "ready", revision: "retained-application-shortcuts" },
    prepareLeave: async () => false, reveal: () => { setShortcutExit(true); reveal("shortcuts"); },
  }), [lifecycle, reveal]);
  useLayoutEffect(() => lifecycle.register({ id: "application-extensions", area: "overview", scope: { kind: "application" },
    inspect: intent => ["close-window", "open-project", "create-project", "close-project"].includes(intent.kind)
      ? { status: plugins.current?.exitState().blocked ? "blocked" : "ready", revision: plugins.current?.exitState().revision ?? "0" }
      : { status: "ready", revision: "retained-application-extensions" },
    prepareLeave: async () => false, reveal: () => plugins.current?.open(),
  }), [lifecycle]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)"), changed = () => setDark(media.matches);
    media.addEventListener("change", changed); return () => media.removeEventListener("change", changed);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement, previous = root.style.getPropertyValue("--editor-font-size");
    root.style.setProperty("--editor-font-size", `${editorFont.size}px`);
    return () => { if (previous) root.style.setProperty("--editor-font-size", previous); else root.style.removeProperty("--editor-font-size"); };
  }, [editorFont.size]);
  useEffect(() => {
    if (!open || section !== "about" || !native || !isTauri()) return;
    let alive = true; setVersion({ kind: "reading" });
    void import("@tauri-apps/api/app").then(app => app.getVersion()).then(value => { if (alive) setVersion({ kind: "ready", value }); }, () => { if (alive) setVersion({ kind: "failed" }); });
    return () => { alive = false; };
  }, [open, section, native, versionAttempt]);
  const composing = interaction.composingOwners.includes(compositionOwner), exitReview = owner.state.exitPrompt || owner.state.exitHeld;
  const closeDisabled = composing || exitReview;
  function close() { if (!closeDisabled) setOpen(false); }
  function saveEditorFontSize(size: number) {
    try { localStorage.setItem(editorFontSizeStorageKey, String(size)); setEditorFont({ size, problem: false }); }
    catch { setEditorFont({ size, problem: true }); }
  }
  function shortcutMessage(result: Exclude<BindingResult, { kind: "saved" }> | undefined) {
    return result ? result.kind === "conflict" ? t("settingsWorkbench.conflict", { command: t(result.command.nameKey) }) : t(`settingsWorkbench.${result.kind}`) : undefined;
  }
  function applyShortcut(id: typeof workspaceCommandCatalog[number]["id"]) {
    if (gate.getSnapshot().composingOwners.length || shortcutInputs[id] === undefined) return;
    const result = bindings.set(id, shortcutInputs[id]);
    if (result.kind !== "saved") {
      setShortcutError(before => ({ ...before, [id]: result })); return;
    }
    setShortcutInputs(before => { const next = { ...before }; delete next[id]; return next; });
    setShortcutError(before => { const next = { ...before }; delete next[id]; return next; }); setShortcutNotice("saved");
  }
  function handOff(target: "extensions" | "reference" | "query" | "share") {
    if (closeDisabled || lifecycle.getSnapshot().phase !== "idle") return;
    if (target === "extensions") handoff.current = "extensions";
    else if (currentMcp.current) handoff.current = { target: currentMcp.current, kind: target }; else return;
    setOpen(false);
  }
  const openReferences = useCallback((returnTo?: HTMLElement, fallbackReturnTo?: HTMLElement) => {
    if (lifecycle.getSnapshot().phase === "idle" && gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button" })) currentMcp.current?.open("reference", returnTo, fallbackReturnTo);
  }, [lifecycle, gate]);
  const openMcpQuery = useCallback((returnTo?: HTMLElement, fallbackReturnTo?: HTMLElement) => {
    if (lifecycle.getSnapshot().phase === "idle" && gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button" })) currentMcp.current?.open("query", returnTo, fallbackReturnTo);
  }, [lifecycle, gate]);
  const openMcpShare = useCallback((returnTo?: HTMLElement, fallbackReturnTo?: HTMLElement) => {
    if (lifecycle.getSnapshot().phase === "idle" && gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button" })) currentMcp.current?.open("share", returnTo, fallbackReturnTo);
  }, [lifecycle, gate]);
  const value = useMemo<SettingsContext>(() => ({ open: show, openExtensions, bindings, bindingsRevision: bindingState.revision, registerMcp, openReferences: mcp ? openReferences : undefined, openMcpQuery: mcp ? openMcpQuery : undefined, openMcpShare: mcp ? openMcpShare : undefined }), [show, openExtensions, bindings, bindingState.revision, registerMcp, mcp, openReferences, openMcpQuery, openMcpShare]);
  return <Context.Provider value={value}><div className={styles.scope} onCompositionStartCapture={event => { if (event.target instanceof Element && event.target.closest('[role="dialog"]')) gate.setComposing(compositionOwner, true); }} onCompositionEndCapture={() => gate.setComposing(compositionOwner, false)}>{children}
    <Sheet open={open} onOpenChange={next => { if (!next) close(); }} title={t("settingsWorkbench.title")} description={t("settingsWorkbench.description")} closeLabel={t("settingsWorkbench.close")} closeDisabled={closeDisabled} className={styles.sheet}
      onEscapeKeyDown={event => { if (closeDisabled) event.preventDefault(); }} onInteractOutside={event => { if (closeDisabled) event.preventDefault(); }}
      onCloseAutoFocus={event => {
        event.preventDefault(); const pending = handoff.current; handoff.current = null;
        if (pending === "extensions") plugins.current?.open(origin.current ?? undefined);
        else if (pending && currentMcp.current === pending.target) pending.target.open(pending.kind, origin.current ?? undefined);
        else if (origin.current?.isConnected) origin.current.focus();
      }}>
      <div className={styles.layout} data-application-settings={settingsDialog}>
        <nav className={styles.navigation} aria-label={t("settingsWorkbench.sections")}>{sections.map(name => <Button key={name} aria-current={section === name ? "page" : undefined} disabled={exitReview || composing} onClick={() => setSection(name)}>{t(`settingsWorkbench.${name}`)}</Button>)}</nav>
        <div className={styles.content}>
          {section === "general" ? <section className={styles.section}><h2>{t("settingsWorkbench.general")}</h2>
            <Field label={t("settingsWorkbench.language")} description={t("settingsWorkbench.languageHelp")}><Select className={fieldStyles.input} value={i18n.resolvedLanguage} onChange={event => { if (isLocale(event.target.value)) void i18n.changeLanguage(event.target.value); }}>{localeOptions.map(locale => <option key={locale.value} value={locale.value}>{t(locale.labelKey)}</option>)}</Select></Field>
            <h2>{t("settingsWorkbench.extensions")}</h2><p>{t("settingsWorkbench.extensionsHelp")}</p><div className={styles.actions}><Button variant="secondary" onClick={() => handOff("extensions")}>{t("settingsWorkbench.extensions")}</Button></div>
            <h2>{t("toolQuery.title")}</h2><p>{t("toolQuery.help")}</p><div className={styles.actions}><Button disabled={!mcp || !lifecycleState.session} onClick={() => handOff("reference")}>{t("toolQuery.title")}</Button></div>
            <h2>{t("settingsWorkbench.mcp")}</h2><p>{t("settingsWorkbench.mcpHelp")}</p><p>{!lifecycleState.session ? t("settingsWorkbench.needsProject") : !mcp ? t("settingsWorkbench.projectLoading") : null}</p>
            <div className={styles.actions}><Button disabled={!mcp || !lifecycleState.session} onClick={() => handOff("query")}>{t("settingsWorkbench.query")}</Button><Button disabled={!mcp || !lifecycleState.session} onClick={() => handOff("share")}>{t("settingsWorkbench.share")}</Button></div>
          </section> : null}
          {section === "appearance" ? <section className={styles.section}><h2>{t("settingsWorkbench.systemAppearance")}</h2><p>{t("settingsWorkbench.appearanceHelp")}</p><p role="status">{t(dark ? "settingsWorkbench.dark" : "settingsWorkbench.light")}</p>
            <Field label={t("settingsWorkbench.editorFontSize")} description={t("settingsWorkbench.editorFontSizeHelp")}><Select value={editorFont.size} onChange={event => { const size = Number(event.target.value); if (editorFontSizes.includes(size)) saveEditorFontSize(size); }}>{editorFontSizes.map(size => <option key={size} value={size}>{t("settingsWorkbench.fontSizeOption", { size })}</option>)}</Select></Field>
            {editorFont.problem ? <Banner tone="warning" role="alert" action={<Button onClick={() => saveEditorFontSize(editorFont.size)}>{t("settingsWorkbench.retryFontSize")}</Button>}>{t("settingsWorkbench.fontSizeStorageFailed")}</Banner> : null}
          </section> : null}
          <div hidden={section !== "connections"}><ConnectionManager hideTrigger presentation="embedded" visible={open && section === "connections"} disabled={!native || lifecycleState.phase !== "idle" || !!lifecycleState.pending || !!lifecycleState.cleanup} onReveal={() => reveal("connections")}/></div>
          {section === "shortcuts" ? <section className={styles.section}><h2>{t("settingsWorkbench.shortcuts")}</h2><p>{t("settingsWorkbench.shortcutHelp")}</p>
            {shortcutExit && Object.keys(shortcutInputs).length ? <Banner tone="warning" role="alert" action={<Button onClick={() => { setShortcutInputs({}); setShortcutError({}); setShortcutExit(false); }}>{t("settingsWorkbench.discardShortcuts")}</Button>}>{t("settingsWorkbench.unapplied")}</Banner> : null}
            {bindingState.problem ? <Banner tone="error" role="alert">{t(bindingState.problem === "invalid" ? "settingsWorkbench.invalidStored" : "settingsWorkbench.storage")}</Banner> : null}
            {shortcutNotice ? <Banner tone={shortcutNotice === "storage" ? "error" : "success"} role="status">{t(`settingsWorkbench.${shortcutNotice}`)}</Banner> : null}
            {workspaceCommandCatalog.map(command => <form className={styles.shortcut} key={command.id} aria-label={t("settingsWorkbench.shortcutLabel", { command: t(command.nameKey) })} onSubmit={event => { event.preventDefault(); applyShortcut(command.id); }}><Field label={t("settingsWorkbench.shortcutLabel", { command: t(command.nameKey) })} error={shortcutMessage(shortcutError[command.id])}><TextInput value={shortcutInputs[command.id] ?? bindings.resolve(command.id, command.binding) ?? ""} spellCheck={false} onChange={event => {
              const input = event.target.value; setShortcutNotice(null); setShortcutError(before => { const next = { ...before }; delete next[command.id]; return next; });
              setShortcutInputs(before => { const next = { ...before }; if (input === (bindings.resolve(command.id, command.binding) ?? "")) delete next[command.id]; else next[command.id] = input; return next; });
            }}/></Field><Button type="submit" variant="secondary" disabled={composing || shortcutInputs[command.id] === undefined}>{t("settingsWorkbench.apply")}</Button></form>)}
            <div className={styles.actions}><Button disabled={composing} onClick={() => { const result = bindings.reset(); if (result.kind === "saved") { setShortcutInputs({}); setShortcutError({}); setShortcutNotice("restored"); } else setShortcutNotice("storage"); }}>{t("settingsWorkbench.restore")}</Button></div>
          </section> : null}
          {section === "about" ? <section className={styles.section}><h2>Tsumugi</h2>{!native || !isTauri() ? <p>{t("settingsWorkbench.desktopVersion")}</p> : version.kind === "ready" ? <p>{t("settingsWorkbench.version", { version: version.value })}</p> : version.kind === "failed" ? <Banner tone="error" action={<Button onClick={() => setVersionAttempt(value => value + 1)}>{t("settingsWorkbench.retryVersion")}</Button>}>{t("settingsWorkbench.versionFailed")}</Banner> : <p role="status">{t("settingsWorkbench.versionLoading")}</p>}</section> : null}
        </div>
      </div>
    </Sheet>
    <PluginManager ref={plugins} hideTrigger presentation="workbench" disabled={!native || lifecycleState.phase !== "idle" || !!lifecycleState.pending || !!lifecycleState.cleanup} onBusyChange={setPluginBusy} onOpenChange={setExtensionsOpen}/>
  </div></Context.Provider>;
}
