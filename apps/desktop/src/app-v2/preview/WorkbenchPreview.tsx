import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, ArrowUpRight, BookOpen, ChevronDown, Circle, CircleDot, Command, Layers, ListFilter, MessageSquare, MoreHorizontal, PanelRight, Plus, Search, Settings, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import { Button, IconButton } from "../../design-system/Button";
import { Field, TextArea, TextInput } from "../../design-system/Field";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "../../design-system/Tabs";
import { StatusGlyph } from "../../design-system/StatusGlyph";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../design-system/Feedback";
import { ProgressBar } from "../../design-system/ProgressBar";
import { Kbd } from "../../design-system/Kbd";
import { TokenizedText } from "../../design-system/TokenizedText";
import { Sheet } from "../../design-system/Dialog";
import { CommandPalette } from "../../design-system/CommandPalette";
import { SplitView, SplitPanel, SplitHandle } from "../../design-system/SplitView";
import { sampleEntries } from "./fixtures";
import styles from "../WorkbenchLayout.module.css";

export type PreviewScreen = "entries" | "decisions" | "delivery" | "runs";
export type PreviewState = "normal" | "empty" | "loading" | "error" | "conflict" | "pending" | "unknown";
export type WorkbenchPreviewProps = { screen?: PreviewScreen; state?: PreviewState };

function subscribeToWidth(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function WorkbenchPreview({ screen: initialScreen = "entries", state = "normal" }: WorkbenchPreviewProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchPreview" });
  const [screen, setScreen] = useState(initialScreen);
  const [dock, setDock] = useState("agent");
  const [drawer, setDrawer] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(99);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [buildSettings, setBuildSettings] = useState(false);
  const [message, setMessage] = useState("");
  const [context, setContext] = useState(true);
  const narrow = useSyncExternalStore(subscribeToWidth, () => window.innerWidth <= 1100, () => false);
  const wide = useSyncExternalStore(subscribeToWidth, () => window.innerWidth >= 1440, () => false);
  const search = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const navigate = (target: PreviewScreen) => { setScreen(target); setDrawer(false); };
  const active = sampleEntries.find((entry) => entry.id === selected) ?? sampleEntries[2];
  const visible = sampleEntries.filter((entry) =>
    (filter === "all" || (filter === "issues" ? entry.state === "blocked" || entry.state === "stale" : entry.state === "untranslated"))
    && `${entry.source} ${entry.target} ${entry.key}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const statusKeys = { untranslated: "noTranslation", draft: "draft", candidate: "candidate", translated: "translated", reviewed: "reviewed", stale: "sourceChanged", blocked: "missingPlural" } as const;
  const statusLabel = (value: typeof active.state) => t(statusKeys[value]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") { event.preventDefault(); setCommandsOpen(true); }
      if ((key === "l" || key === "i") && !commandsOpen) {
        event.preventDefault(); setDock(key === "l" ? "agent" : "detail");
        if (narrow) setDrawer(true);
        if (key === "l") requestAnimationFrame(() => composer.current?.focus());
      }
      if (key === "f" && screen === "entries" && !commandsOpen && !drawer) { event.preventDefault(); search.current?.focus(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandsOpen, drawer, narrow, screen]);

  function renderAgent() {
    return <div className={styles.agent}>
      <div className={styles.agentHeader}><span>{t("teamLead")}</span><IconButton label={t("unavailable")} disabled><MoreHorizontal /></IconButton></div>
      <div className={styles.runStrip}><Sparkles /><span>{t("runPaused")}</span><IconButton label={t("expandRun")} onClick={() => navigate("runs")}><ArrowUpRight /></IconButton></div>
      <div className={styles.messages}>
        <p className={styles.userMessage}>{t("userMessage")}</p>
        <p>{t("agentReply")}</p>
        <section className={styles.agentCard} aria-label={t("plan")}>
          <h3><Sparkles className={styles.ai} />{t("plan")}</h3>
          <p>{t("planScope")}</p><p className={styles.meta}>{t("planModel")}</p><p className={styles.meta}>{t("planBudget")}</p>
          <div className={styles.actions}><Button variant="ghost" size="sm" disabled title={t("unavailable")}>{t("adjust")}</Button><Button variant="secondary" size="sm" disabled title={t("unavailable")}>{t("authorize")}</Button></div>
        </section>
        <section className={styles.agentCard} aria-label={t("proposal")}>
          <h3><Sparkles className={styles.ai} />{t("proposal")}</h3><p>{t("proposalTerm")}</p><p className={styles.meta}>{t("proposalReason")}</p>
          <div className={styles.actions}><Button variant="ghost" size="sm" disabled>{t("reject")}</Button><Button variant="secondary" size="sm" disabled>{t("adopt")}</Button></div>
        </section>
        <p className={styles.discussion}>{t("discussion")}</p>
      </div>
      <Button variant="ghost" className={styles.tray} onClick={() => navigate("decisions")}><CircleDot />{t("tray", { count: 5 })}<ArrowUpRight /></Button>
      <div className={styles.composer}>
        {context ? <div className={styles.context}><span>{t("context")}</span><IconButton size="xs" label={t("removeContext")} onClick={() => setContext(false)}><X /></IconButton></div> : null}
        <TextArea ref={composer} aria-label={t("message")} placeholder={t("messagePlaceholder")} value={message} onChange={(event) => setMessage(event.target.value)} rows={2} />
        <div className={styles.composerFooter}><span>{t("noModel")}</span><IconButton label={t("send")} disabled title={t("noModel")}><ArrowUp /></IconButton></div>
      </div>
    </div>;
  }

  function renderDetails() {
    return <div className={styles.details}>
      <h2>{t("detail")}</h2><span className={styles.key}>{active.key}</span>
      <dl>{(["selectedVersion", "reviewFact", "qaFact", "applicabilityFact"] as const).map((label, index) => <div key={label}><dt>{t(label)}</dt><dd>{t(active.facts[index])}</dd></div>)}</dl>
      <p className={styles.meta}>{t("detailHelp")}</p><h3>{t("sourceText")}</h3><p><TokenizedText text={active.source} /></p>
      <h3>{t("translationText")}</h3><p><TokenizedText text={drafts[selected] ?? active.target} /></p>
    </div>;
  }

  function renderDock() {
    return <TabsRoot value={dock} onValueChange={setDock} className={styles.dockTabs}>
      <TabsList aria-label={t("dockTabs")}><TabsTrigger value="agent"><Sparkles />{t("agent")}</TabsTrigger><TabsTrigger value="detail">{t("detail")}</TabsTrigger></TabsList>
      <TabsContent value="agent" className={styles.dockContent}>{renderAgent()}</TabsContent>
      <TabsContent value="detail" className={styles.dockContent}>{renderDetails()}</TabsContent>
    </TabsRoot>;
  }

  function renderEntries() {
    return <div className={styles.entryView}>
      <div className={styles.toolbar} role="toolbar" aria-label={t("toolbar")}>
        <Button variant="ghost" size="sm" onClick={() => setFilter(filter === "all" ? "untranslated" : "all")} aria-label={t("filter")}><ListFilter />{t(filter === "all" ? "all" : filter === "issues" ? "hasIssues" : "untranslated")}<ChevronDown /></Button>
        <div className={styles.toolbarSearch}><Search /><TextInput ref={search} aria-label={t("search")} placeholder={t("searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <span className={styles.count}>{t("count", { count: visible.length })}</span>
      </div>
      <div className={styles.scroll}>
        {state === "conflict" || state === "unknown" || state === "pending" ? <Banner tone={state === "pending" ? "info" : "warning"}>{t(state)}</Banner> : null}
        {state === "loading" ? <LoadingState label={t("loading")} /> : state === "error" ? <ErrorState title={t("errorTitle")} description={t("errorDescription")} action={<Button disabled>{t("retry")}</Button>} /> : state === "empty" || visible.length === 0 ? <EmptyState icon={<Layers />} title={t(state === "empty" ? "emptyTitle" : "noResults")} description={t(state === "empty" ? "emptyDescription" : "noResultsDescription")} action={<Button variant="secondary" onClick={() => { setQuery(""); setFilter("all"); }}>{t("clearSearch")}</Button>} /> : <div className={styles.table}>
          <div className={styles.tableHeader}><span>{t("number")}</span><span>{t("status")}</span><span>{t("source")}</span><span>{t("target")}</span></div>
          {visible.map((entry) => <article key={entry.id} className={styles.entry} data-selected={selected === entry.id || undefined}>
            <div className={styles.entryNumber}><Button variant="ghost" size="xs" aria-label={t("selectEntry", { entry: String(entry.id) })} onClick={() => setSelected(entry.id)}>{entry.id}</Button></div>
            <div className={styles.entryStatus}><StatusGlyph state={entry.state} label={statusLabel(entry.state)} protected={entry.protected} protectedLabel={t("protected")} /></div>
            <div className={styles.source}><TokenizedText text={entry.source} />{selected === entry.id ? <div className={styles.entryMeta}><span className={styles.key}>{entry.key}</span><span>{t("speaker")}</span></div> : null}</div>
            <div className={styles.target} data-candidate={entry.state === "candidate" || undefined}>
              {selected === entry.id ? <><TextArea ref={editor} aria-label={t("editTranslation", { entry: String(entry.id) })} value={drafts[entry.id] ?? entry.target} onChange={(event) => setDrafts((current) => ({ ...current, [entry.id]: event.target.value }))} rows={3} /><div className={styles.editActions}><Button variant="primary" size="sm" disabled title={t("confirmUnavailable")} kbd="⌘↵">{t("confirmNext")}</Button></div><p className={styles.editHint}>{t("confirmUnavailable")}</p></> : <TokenizedText text={entry.target || "—"} />}
              {entry.state === "blocked" ? <span className={styles.issue}><Square />{t("missingPlural")}</span> : null}
            </div>
          </article>)}
        </div>}
      </div>
    </div>;
  }

  function renderDecisions() {
    const groups = [
      { heading: t("proposals"), title: t("proposalTerm"), text: t("proposalReason"), icon: <Sparkles className={styles.ai} />, action: t("adopt") },
      { heading: t("questions"), title: t("questionTitle"), text: t("questionText"), icon: <MessageSquare />, action: t("locate") },
      { heading: t("checks"), title: t("unknownTitle"), text: t("unknownText"), icon: <CircleDot />, action: t("verify") },
      { heading: t("blockers"), title: t("issueTitle"), text: t("issueText"), icon: <Square className={styles.danger} />, action: t("locate") },
    ];
    return <div className={styles.document}><header><h1>{t("inboxTitle")}</h1><p className={styles.meta}>{t("inboxDescription")}</p></header>
      {groups.map((group) => <section className={styles.decisionGroup} key={group.heading}><h2>{group.heading}</h2><div className={styles.decisionItem}>{group.icon}<div><h3>{group.title}</h3><p>{group.text}</p><div className={styles.actions}><Button variant="ghost" size="sm" onClick={group.action === t("locate") ? () => { setSelected(100); navigate("entries"); } : undefined} disabled={group.action !== t("locate")} title={group.action !== t("locate") ? t("unavailable") : undefined}>{group.action}<ArrowUpRight /></Button></div></div></div></section>)}
    </div>;
  }

  function renderDelivery() {
    const steps = [
      { title: t("ready"), description: t("readyText"), icon: <Square className={styles.danger} /> },
      { title: t("build"), description: t("buildText"), icon: <Circle /> },
      { title: t("validate"), description: t("validateText"), icon: <ShieldCheck /> },
      { title: t("export"), description: t("exportText"), icon: <ArrowUp /> },
      { title: t("history"), description: t("historyText"), icon: <Circle /> },
    ];
    return <div className={styles.document}><header className={styles.documentHeader}><h1>{t("deliveryTitle")}</h1><Button variant="primary" disabled title={t("unavailable")}>{t("checkDelivery")}</Button></header>
      <ol className={styles.stepper}>{steps.map((step, index) => <li key={step.title}><span className={styles.stepNumber}>{index + 1}</span><div><h2>{step.title}</h2><p>{step.icon}{step.description}</p>{index === 0 ? <Button variant="link" size="sm" onClick={() => { setFilter("issues"); navigate("entries"); }}>{t("viewIssue")}<ArrowUpRight /></Button> : null}</div></li>)}</ol>
      <div className={styles.settingsDisclosure}><Button variant="ghost" aria-expanded={buildSettings} aria-controls="build-settings" onClick={() => setBuildSettings(!buildSettings)}>{t("buildSettings")}<ChevronDown /></Button><span className={styles.meta}>{t("buildSummary")}</span></div>
      {buildSettings ? <div id="build-settings" className={styles.buildSettings}><Field id="sample-output" label={t("outputPath")}><TextInput id="sample-output" defaultValue="i18n/zh.json" /></Field><p className={styles.meta}>{t("builder")}</p></div> : null}
    </div>;
  }

  function renderRun() {
    return <div className={styles.document}><header className={styles.documentHeader}><h1>{t("runTitle")}</h1><Button variant="primary" disabled>{t("resume")}</Button></header><p>{t("runGoal")}</p>
      <section className={styles.runSection}><h2>{t("authorization")}</h2><p>{t("authorizationText")}</p></section>
      <section className={styles.runSection}><h2>{t("runPaused")}</h2><p className={styles.meta}>{t("stages")}</p><ProgressBar value={142} max={312} label={t("runProgress")} /><p className={styles.meta}>{t("runProgress")}</p></section>
      <section className={styles.runSection}><h2>{t("decisions")}</h2><p>{t("runDecisions")}</p><Button variant="ghost" onClick={() => navigate("decisions")}>{t("tray", { count: 5 })}<ArrowUpRight /></Button></section>
      <section className={styles.runSection}><h2>{t("discussions")}</h2><p>{t("discussion")}</p></section><Button variant="danger" disabled title={t("unavailable")}>{t("stop")}</Button><p className={styles.meta}>{t("stopHelp")}</p>
    </div>;
  }

  return <div className={styles.frame}>
    <header className={styles.titlebar}><span className={styles.wordmark}>紡</span><span className={styles.project}>{t("project")}</span><ChevronDown /><span className={styles.breadcrumb}>› zh-CN</span><Button variant="ghost" size="sm" className={styles.commandSearch} onClick={() => setCommandsOpen(true)}><Search />{t("command")}<Kbd>⌘K</Kbd></Button><span className={styles.previewLabel}>{t("preview")}</span><IconButton className={styles.dockToggle} label={t("showDock")} onClick={() => setDrawer(true)}><PanelRight /></IconButton></header>
    <div className={styles.body}>
      <nav className={styles.activity} aria-label={t("activity")}>
        {([{ id: "entries", icon: <Layers /> }, { id: "knowledge", icon: <BookOpen /> }, { id: "runs", icon: <Sparkles /> }, { id: "delivery", icon: <ArrowUp /> }, { id: "decisions", icon: <CircleDot /> }] as const).map(({ id, icon }) => <div key={id} className={styles.activityItem} data-active={screen === id || undefined}><IconButton label={t(id)} disabled={id === "knowledge"} onClick={() => { if (id !== "knowledge") navigate(id); }} aria-current={screen === id ? "page" : undefined}>{icon}</IconButton>{id === "decisions" ? <span className={styles.activityCount}>5</span> : null}</div>)}
        <div className={styles.activityBottom}><IconButton label={t("extensions")} disabled><Command /></IconButton><IconButton label={t("settings")} disabled><Settings /></IconButton></div>
      </nav>
      <SplitView className={styles.workspaceSplit}>
      <SplitPanel minSize={0} className={styles.mainPanel}>
      <main className={styles.main}>
        <div className={styles.viewTabs} role="navigation" aria-label={t("viewTabs")}>
          <Button variant="ghost" size="sm" data-active={screen === "entries" && filter !== "issues" || undefined} onClick={() => { setFilter("all"); navigate("entries"); }}>{t("chapter")}</Button>
          <Button variant="ghost" size="sm" data-active={filter === "issues" && screen === "entries" || undefined} onClick={() => { setFilter("issues"); navigate("entries"); }}>{t("issuesTab")}</Button>
          {screen !== "entries" ? <Button variant="ghost" size="sm" data-active>{t(screen)}</Button> : null}
          <IconButton size="xs" label={t("addView")} disabled><Plus /></IconButton>
        </div>
        {screen === "entries" ? renderEntries() : screen === "decisions" ? renderDecisions() : screen === "delivery" ? renderDelivery() : renderRun()}
      </main>
      </SplitPanel>
      {!narrow ? <><SplitHandle label={t("resizeDock")} /><SplitPanel key={wide ? "wide" : "compact"} defaultSize={wide ? 380 : 340} minSize={300} maxSize="45%"><aside className={styles.dock} aria-label={t("agent")}>{renderDock()}</aside></SplitPanel></> : null}
      </SplitView>
    </div>
    <footer className={styles.statusbar}><span><Circle />{t("sampleLocal")}</span><span className={styles.statusEnd}>{t("targetLanguage")}<span>{t("confirmed", { completed: "1,032", total: "1,284" })}</span></span></footer>
    <Sheet open={drawer} onOpenChange={setDrawer} title={t("agent")} description={t("preview")} closeLabel={t("close")}>{renderDock()}</Sheet>
    <CommandPalette open={commandsOpen} onOpenChange={setCommandsOpen} title={t("commandLabel")} placeholder={t("command")} emptyLabel={t("commandsEmpty")} closeLabel={t("close")} groups={[{ label: t("viewTabs"), commands: [
      { id: "entries", label: t("openEntries"), onSelect: () => navigate("entries") }, { id: "decisions", label: t("openDecisions"), onSelect: () => navigate("decisions") }, { id: "delivery", label: t("openDelivery"), onSelect: () => navigate("delivery") },
    ]}]} />
  </div>;
}
