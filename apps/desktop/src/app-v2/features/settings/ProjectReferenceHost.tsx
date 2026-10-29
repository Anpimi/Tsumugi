import { useId, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { PluginToolQueries, type ToolQueryHandle } from "../../../PluginToolQueries";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "../../../workbenchCommands";
import { ExecutionTaskHandleProvider } from "../../../ExecutionTaskSession";
import { McpRetrievalQueries } from "../../../McpRetrievalQueries";
import { McpSharingPanel } from "../../../McpSharingPanel";
import { McpSharingProvider, useMcpSharing } from "../../../McpSharingSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { reviewCommands } from "../../../reviewCommands";
import type { GlossaryCapture } from "../../../resourceCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceReads } from "../../../sourceQueries";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner, EmptyState, LoadingState } from "../../../design-system/Feedback";
import type { LifecycleParticipant, ProjectLifecycle } from "../../platform/projectLifecycle";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import TermProposalPanel from "../knowledge/TermProposalPanel";
import styles from "./ProjectReferenceHost.module.css";

export interface ProjectReferenceHandle {
  open: (kind: "reference" | "query" | "share", returnTo?: HTMLElement, fallbackReturnTo?: HTMLElement) => void;
  /** Reveal only the query retained by the existing knowledge owner. */
  revealQuery: () => boolean;
}
export interface ProjectReferenceProps {
  project: ProjectView;
  lifecycle: ProjectLifecycle;
  gate: InteractionGate;
  drafts: TranslationDrafts;
  knowledgeOwner: KnowledgeOwner | null;
  onParticipant?: (participant: LifecycleParticipant | null) => void;
  ref?: Ref<ProjectReferenceHandle>;
}

function ProjectMcpSurface({ project, lifecycle, gate, drafts, knowledgeOwner, onParticipant, ref }: ProjectReferenceProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "mcpWorkbench" });
  const sharing = useMcpSharing(), reads = useSessionReads(), context = executionContext(project);
  const lifecycleState = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const draftState = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const [kind, setKind] = useState<"reference" | "query" | "share">("query"), [open, setOpen] = useState(false);
  const [commands] = useState(() => new WorkbenchCommands());
  const pluginQuery = useRef<ToolQueryHandle>(null);
  const [pluginLeave, setPluginLeave] = useState(false), [switchBlocked, setSwitchBlocked] = useState(false);
  const pluginDialogId = useId();
  const [cursor, setCursor] = useState({ snapshotId: "", revision: "", after: 0 });
  const [search, setSearch] = useState(""), [unitId, setUnitId] = useState(""), [locale, setLocale] = useState(project.metadata.targetLocales[0] ?? "");
  const [discardSequence, setDiscardSequence] = useState<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), returnFocus = useRef<HTMLElement | null>(null), mounted = useRef(false);
  const sharingOwner = useRef(sharing), returnFallback = useRef<HTMLElement | null>(null);
  const inputId = useId(), discardDialogId = useId(), titleId = useId();
  const currentValues = useRef({ open, kind, knowledgeOwner });
  useLayoutEffect(() => { currentValues.current = { open, kind, knowledgeOwner }; sharingOwner.current = sharing; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; gate.releaseOwner(inputId); }; }, [gate, inputId]);
  const disabled = reads.retired || draftState.retired || lifecycleState.phase !== "idle" || lifecycleState.pending !== null;
  const dispatchable = (dialogId?: string) => mounted.current && !reads.retired && !drafts.getSnapshot().retired
    && lifecycle.getSnapshot().phase === "idle" && lifecycle.getSnapshot().pending === null
    && gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button", dialogId });
  const present = (dialogId?: string) => currentValues.current.open && dispatchable(dialogId);

  function reveal(nextKind: "reference" | "query" | "share", trigger?: HTMLElement, fallback?: HTMLElement) {
    if (trigger || !currentValues.current.open) {
      returnFocus.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); returnFallback.current = fallback ?? null;
    }
    const tool = currentValues.current.knowledgeOwner?.tool, mode = nextKind === "query" ? "mcp" : "plugin";
    if (nextKind !== "share" && tool && tool.current().mode !== mode) {
      if (tool.blocked() || tool.hasDraft() || !tool.setMode(mode)) {
        setSwitchBlocked(true); setKind(tool.current().mode === "mcp" ? "query" : "reference"); setOpen(true); return;
      }
    }
    setSwitchBlocked(false); setKind(nextKind); setOpen(true);
  }
  useImperativeHandle(ref, () => ({ open: reveal, revealQuery() {
    const tool = currentValues.current.knowledgeOwner?.tool;
    if (!tool || !tool.blocked() && !tool.hasDraft() && !tool.mcp.current().capture) return false;
    reveal(tool.current().mode === "mcp" ? "query" : "reference"); return true;
  } }));
  useLayoutEffect(() => {
    if (open && kind !== "share" && knowledgeOwner && knowledgeOwner.tool.current().mode !== (kind === "query" ? "mcp" : "plugin")) reveal(kind);
  }, [open, kind, knowledgeOwner]);
  useLayoutEffect(() => { if (open) heading.current?.focus({ preventScroll: true }); }, [open, kind]);
  useLayoutEffect(() => pluginLeave ? gate.pushDialog(pluginDialogId) : undefined, [pluginLeave, gate, pluginDialogId]);
  useLayoutEffect(() => discardSequence !== null ? gate.pushDialog(discardDialogId) : undefined, [discardSequence, gate, discardDialogId]);
  useLayoutEffect(() => {
    const participant: LifecycleParticipant = { id: "project-mcp-sharing", area: "resources", scope: { kind: "project", ...context },
      inspect: intent => ["create-project", "open-project", "close-project", "close-window"].includes(intent.kind)
        ? { status: sharingOwner.current.blocked() ? "blocked" : "ready", revision: JSON.stringify(sharingOwner.current.revision()) }
        : { status: "ready", revision: "retained-mcp-sharing" },
      prepareLeave: async (_intent, proof, current) => proof() && current() && !sharingOwner.current.blocked(),
      reveal: () => { if (mounted.current) reveal("share"); } };
    if (onParticipant) { onParticipant(participant); return () => onParticipant(null); }
    return lifecycle.register(participant);
  }, [lifecycle, context.projectId, context.sessionToken, onParticipant]);
  // Owner methods read their stable session refs. No extra sharing owner is created by hiding this surface.
  function close() {
    if (gate.getSnapshot().composingOwners.length || gate.getSnapshot().dialogs.length) return;
    setOpen(false); gate.releaseOwner(inputId);
    const target = returnFocus.current?.isConnected ? returnFocus.current : returnFallback.current; returnFocus.current = null; returnFallback.current = null;
    if (target?.isConnected && !target.matches(":disabled") && !target.closest("[hidden]")) target.focus();
  }

  const scopeOptions = sourceReads.scope(context), scopeRead = useSessionQuery({ ...scopeOptions, enabled: open && !reads.retired });
  const scope = scopeRead.data, snapshotId = scope?.currentSnapshot ?? "";
  const after = cursor.snapshotId === snapshotId && cursor.revision === scope?.revision ? cursor.after : 0;
  const contentOptions = sourceReads.content(context, snapshotId, after, scope);
  const contentRead = useSessionQuery({ ...contentOptions, enabled: open && !reads.retired && !!snapshotId && !scopeRead.error });
  const sourcePage = !scopeRead.error && !contentRead.error ? contentRead.data ?? null : null;
  function fresh(key: readonly unknown[], data: unknown) {
    const value = reads.client.getQueryState(reads.key(key));
    return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated && value.error === null && value.data === data;
  }
  function sourceCurrent() {
    return present() && !!scope && !!sourcePage && fresh(scopeOptions.key, scope) && fresh(contentOptions.key, sourcePage)
      && scope.currentSnapshot === sourcePage.snapshotId && scope.revision === sourcePage.scope.revision
      && sourcePage.scope.currentSnapshot === sourcePage.snapshotId;
  }
  function pageAt(next: number) {
    if (!present() || !scope?.currentSnapshot) return;
    if (after === next) void contentRead.refetch();
    else setCursor({ snapshotId: scope.currentSnapshot, revision: scope.revision, after: next });
  }
  async function refreshEntries() {
    if (!present()) return;
    const latest = await scopeRead.refetch();
    if (!present() || latest.error || !latest.data?.currentSnapshot) return;
    if (latest.data.currentSnapshot === snapshotId && latest.data.revision === scope?.revision) await contentRead.refetch();
  }
  const selected = sourcePage?.rows.find(row => row.unitId === unitId && row.sourceRevisionId);
  const editorKey = ["mcp-sharing-editor", snapshotId, scope?.revision, selected?.unitId ?? null, selected?.sourceRevisionId ?? null, locale];
  const editor = useSessionQuery({ key: editorKey, scopes: ["source", "translation", "resources", "review"],
    enabled: open && kind === "share" && !sharing.state.target && !!selected && project.metadata.targetLocales.includes(locale) && !reads.retired,
    read: async () => {
      if (!selected?.unitId || !selected.sourceRevisionId) throw new Error("Sharing requires an exact saved entry");
      const value = await reviewCommands.editorSnapshot({ ...context, unitId: selected.unitId, locale });
      if (value.target.unitId !== selected.unitId || value.target.locale !== locale || value.target.sourceSnapshotId !== snapshotId
        || value.target.sourceRevisionId !== selected.sourceRevisionId || value.target.sourceText !== selected.occurrence.text
        || value.translations.unitId !== selected.unitId || value.translations.locale !== locale
        || value.terms.unitId !== selected.unitId || value.terms.locale !== locale || value.terms.sourceRevisionId !== selected.sourceRevisionId
        || value.context && (value.context.unitId !== selected.unitId || value.context.locale !== locale)) throw new Error("Sharing entry basis changed");
      return value;
    } });
  const canBegin = !disabled && sourceCurrent() && !!selected && !!editor.data && fresh(editorKey, editor.data) && project.metadata.targetLocales.includes(locale);
  function beginSharing() {
    if (!canBegin || !present() || !editor.data) return;
    const target = editor.data.target;
    sharing.begin({ unitId: target.unitId, locale: target.locale, key: target.nativeKey, sourceRevisionId: target.sourceRevisionId,
      sourceSnapshotId: target.sourceSnapshotId, selectionId: target.selectionId, translationRevisionId: target.revisionId });
  }
  async function openCapture(capture: GlossaryCapture) {
    const owner = currentValues.current.knowledgeOwner;
    if (!owner || !present() || currentValues.current.kind !== "query" || !owner.canReceiveMcp(capture)) return false;
    const before = owner.current();
    return owner.openMcpPreview(capture, before, () => present() && currentValues.current.kind === "query" && currentValues.current.knowledgeOwner === owner);
  }
  const rows = [...new Map(sourcePage?.rows.filter(row => row.unitId && row.sourceRevisionId).map(row => [row.unitId, row])).values()];
  const matches = rows.filter(row => !search || `${row.occurrence.key}\n${row.occurrence.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const queryAvailable = !!knowledgeOwner && knowledgeOwner.tool.state.mode === "mcp";
  const queryDirty = queryAvailable && knowledgeOwner.tool.hasDraft();

  return <>
    <aside hidden={!open} className={styles.surface} aria-labelledby={titleId} onKeyDown={event => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && event.keyCode !== 229 && !gate.getSnapshot().composingOwners.length && !gate.getSnapshot().dialogs.length) {
        event.preventDefault(); event.stopPropagation(); close();
      }
    }} onFocusCapture={event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) gate.setInputOwner(gate.getSnapshot().visibleViewId, inputId);
    }} onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputId); }}
      onCompositionStart={() => gate.setComposing(inputId, true)} onCompositionEnd={() => gate.setComposing(inputId, false)}>
      <header className={styles.header}><h2 id={titleId} ref={heading} tabIndex={-1}>{t(kind === "query" ? "queryTitle" : kind === "reference" ? "referenceTitle" : "shareTitle")}</h2>
        <Button disabled={interaction.composingOwners.length > 0 || interaction.dialogs.length > 0} onClick={close}>{t("close")}</Button></header>
      <div className={styles.body} onClickCapture={event => {
        if (event.target instanceof Element && event.currentTarget.contains(event.target) && event.target.closest("button") && !present()) { event.preventDefault(); event.stopPropagation(); }
      }}>
        <p>{t("temporaryConnection")}</p>
        <div className={styles.actions}><Button aria-pressed={kind === "reference"} disabled={!dispatchable()} onClick={() => reveal("reference")}>{t("referenceTitle")}</Button><Button aria-pressed={kind === "query"} disabled={!dispatchable()} onClick={() => reveal("query")}>{t("queryTitle")}</Button>
          <Button aria-pressed={kind === "share"} disabled={!dispatchable()} onClick={() => reveal("share")}>{t("shareTitle")}</Button></div>
        {switchBlocked ? <Banner tone="warning" role="status">{t("switchBlocked")}</Banner> : null}
        {reads.retired ? <Banner tone="warning">{t("sessionRetired")}</Banner> : null}
        {scopeRead.isFetching || contentRead.isFetching ? <LoadingState label={t("loadingEntries")}/> : null}
        {scopeRead.error || contentRead.error ? <Banner tone="error" role="alert" action={<Button disabled={!dispatchable()} onClick={() => {
          void refreshEntries();
        }}>{t("retryRead")}</Button>}>{t("entriesFailed")}<CommandFailureDetails failure={commandFailure(scopeRead.error ?? contentRead.error)}/></Banner> : null}
        {scopeRead.isSuccess && !scopeRead.isFetching && !snapshotId ? <EmptyState title={t("noEntries")}/> : null}
        <section hidden={kind !== "reference"} className={styles.section}>
          {knowledgeOwner && knowledgeOwner.tool.state.mode === "plugin" ? <WorkbenchCommandsProvider commands={commands}>
            <ExecutionTaskHandleProvider value={knowledgeOwner.tool.tasks}>
              <PluginToolQueries ref={pluginQuery} project={project} session={knowledgeOwner.tool} open={open && kind === "reference"} disabled={disabled}
                canInteract={() => present() && currentValues.current.kind === "reference"}
                onLeaveDialogChange={setPluginLeave} onState={() => {}} onAttention={() => reveal("reference")}/>
              {knowledgeOwner.tool.hasDraft() ? <Button disabled={disabled || knowledgeOwner.tool.blocked() || !dispatchable()} onClick={() => {
                void pluginQuery.current?.allowLeave(() => present(pluginDialogId) && currentValues.current.kind === "reference", () => mounted.current && !reads.retired && lifecycle.getSnapshot().phase === "idle");
              }}>{t("discardReference")}</Button> : null}
            </ExecutionTaskHandleProvider>
          </WorkbenchCommandsProvider> : <LoadingState label={t("loadingReference")}/>}
        </section>
        <section hidden={kind !== "query"} className={styles.section}>
          {!queryAvailable ? knowledgeOwner ? <Banner tone="warning">{t("queryUnavailable")}</Banner> : <LoadingState label={t("loadingReference")}/> : <>
            <McpRetrievalQueries project={project} session={knowledgeOwner.tool} open={open && kind === "query"} disabled={disabled}
              sourcePage={sourcePage} sourceCurrent={sourceCurrent} onSourcePage={pageAt} onOpenCapture={openCapture}/>
            {queryDirty ? <Button disabled={disabled || knowledgeOwner.tool.blocked() || !dispatchable()} onClick={() => setDiscardSequence(knowledgeOwner.tool.draftSequence.current)}>{t("discardQuery")}</Button> : null}
            {knowledgeOwner.state.previewCapture?.origin.kind === "mcp" ? <TermProposalPanel project={project} owner={knowledgeOwner}
              disabled={disabled || !open || kind !== "query"} current={dialog => present(dialog) && currentValues.current.kind === "query"} gate={gate} viewId={interaction.visibleViewId}/> : null}
          </>}
        </section>
        <section hidden={kind !== "share"} className={styles.section}>
          {!sharing.state.target ? <>
            <p>{t("chooseSavedEntry")}</p>
            <Field label={t("searchEntries")} description={t("searchPageHelp")}><TextInput value={search} disabled={disabled} onChange={event => setSearch(event.target.value)}/></Field>
            <Field label={t("savedEntry")}><select value={unitId} disabled={disabled || !sourceCurrent()} onChange={event => setUnitId(event.target.value)}>
              <option value="">{t("chooseEntry")}</option>{selected && !matches.includes(selected) ? <option value={unitId}>{selected.occurrence.key}</option> : null}
              {matches.map(row => <option key={row.unitId} value={row.unitId ?? ""}>{row.occurrence.key}</option>)}
            </select></Field>
            {sourcePage && !matches.length ? <p role="status">{t("noMatches")}</p> : null}
            <div className={styles.actions}><Button disabled={disabled || after === 0 || !dispatchable()} onClick={() => pageAt(0)}>{t("firstPage")}</Button>
              <Button disabled={disabled || sourcePage?.nextOrdinal == null || !dispatchable()} onClick={() => { if (sourcePage?.nextOrdinal != null) pageAt(sourcePage.nextOrdinal); }}>{t("nextPage")}</Button></div>
            <Field label={t("targetLocale")}><select value={locale} disabled={disabled} onChange={event => setLocale(event.target.value)}>
              <option value="">{t("chooseLocale")}</option>{project.metadata.targetLocales.map(value => <option key={value} value={value}>{value}</option>)}
            </select></Field>
            {editor.isFetching ? <LoadingState label={t("loadingSnapshot")}/> : null}
            {editor.error ? <Banner tone="error" role="alert" action={<Button disabled={!dispatchable()} onClick={() => void editor.refetch()}>{t("retryRead")}</Button>}>{t("snapshotFailed")}<CommandFailureDetails failure={commandFailure(editor.error)}/></Banner> : null}
            <Button variant="primary" disabled={!canBegin} onClick={beginSharing}>{t("beginShare")}</Button>
          </> : null}
          <McpSharingPanel embedded visible={open && kind === "share"} disabled={disabled} onDraftClosed={() => {
            if (currentValues.current.open && currentValues.current.kind === "share") heading.current?.focus({ preventScroll: true });
          }}/>
        </section>
        <p className={styles.note}>{t("closeKeepsWork")}</p>
      </div>
    </aside>
    <Dialog open={discardSequence !== null} onOpenChange={value => { if (!value) setDiscardSequence(null); }} title={t("discardTitle")}
      description={t("discardHelp")} closeLabel={t("keepQuery")} footer={<><Button onClick={() => setDiscardSequence(null)}>{t("keepQuery")}</Button>
        <Button variant="danger" disabled={!knowledgeOwner || !dispatchable(discardDialogId) || knowledgeOwner.tool.blocked() || knowledgeOwner.tool.draftSequence.current !== discardSequence}
          onClick={() => {
            if (!knowledgeOwner || !present(discardDialogId) || knowledgeOwner.tool.draftSequence.current !== discardSequence || knowledgeOwner.tool.blocked() || !knowledgeOwner.tool.clearMcpDraft()) return;
            knowledgeOwner.tool.setRows([{ id: knowledgeOwner.tool.nextRow.current++, text: "" }]); knowledgeOwner.tool.edit(); setDiscardSequence(null);
          }}>{t("discardQuery")}</Button></>}>{t("discardHelp")}</Dialog>
  </>;
}

/** Mounted once for the project; hiding either work surface retains its original action owner. */
export default function ProjectReferenceHost(props: ProjectReferenceProps) {
  const snapshot = useSyncExternalStore(props.drafts.subscribe, props.drafts.getSnapshot, props.drafts.getSnapshot);
  return <McpSharingProvider project={props.project} draftRevision={snapshot.revision}><ProjectMcpSurface {...props}/></McpSharingProvider>;
}
