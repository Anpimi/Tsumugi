import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Layers, MoreHorizontal, RefreshCw, Search } from "lucide-react";
import type { ProjectView } from "../../../projectCommands";
import { isCommandError } from "../../../projectCommands";
import type { DraftKey } from "../../../draftCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { Button, IconButton } from "../../../design-system/Button";
import { TextInput } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { SegmentQuery, SegmentRow } from "../../../segmentCommands";
import type { WorkspaceView } from "../../workspace/workspaceStore";
import type { InteractionGate } from "../../workspace/interactionGate";
import SegmentEditor, { type SegmentEditorProps, type SegmentEditorHandle } from "../editor/SegmentEditor";
import type { TranslationDrafts } from "../editor/translationDrafts";
import { captureEntries, entryPageKey, entrySelectionFilter, readEntryPage, readEntryQueueWindow, retainedEntryCapture, type RetainedEntryCapture } from "./entryReads";
import styles from "../../WorkbenchLayout.module.css";

type Props = {
  project: ProjectView; view: WorkspaceView; disabled: boolean;
  patch: (value: Partial<WorkspaceView>) => void;
  navigate: (value: Partial<WorkspaceView>) => Promise<boolean>;
  drafts: TranslationDrafts | null; gate: InteractionGate;
  dispatch: SegmentEditorProps["dispatch"];
  onRevealDraft: (key: DraftKey) => void;
  ref?: Ref<EntriesHandle>;
};
export interface EntriesHandle {
  refresh: () => void; focusSearch: () => void;
  confirm: (advance: boolean) => Promise<void>; exitEditor: () => Promise<void>;
  toggleFocus: () => Promise<void>; isEditing: () => boolean; canConfirm: () => boolean;
}
const noSubscription = () => () => {};
const noDraftSnapshot = () => null;

function EntryFacts({ row }: { row: SegmentRow }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  if (!row.candidateCount && !row.protection.protected && !row.terms.applicableEntryCount && row.applicability.capturedBasisCurrent !== false) return null;
  return <div className={styles.entryMeta}>
    {row.candidateCount ? <span title={t("candidateHelp")}>{t("candidateCount", { count: row.candidateCount })}</span> : null}
    {row.protection.protected ? <span title={t("protectionHelp")}>{t("protectedEntry")}</span> : null}
    {row.terms.applicableEntryCount ? <span title={t("applicableTermsHelp")}>{t("applicableTerms", { count: row.terms.applicableEntryCount })}</span> : null}
    {row.terms.conflictingEntryCount ? <span>{t("conflictingTerms", { count: row.terms.conflictingEntryCount })}</span> : null}
    {row.applicability.resourceReviewRequired ? <span>{t("resourceReviewRequired")}</span> : row.applicability.capturedBasisCurrent === false ? <span title={t("basisChangedHelp")}>{t("basisChanged")}</span> : null}
  </div>;
}

export default function EntriesView({ project, view, disabled, patch, navigate, drafts, gate, dispatch, onRevealDraft, ref }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads();
  useSyncExternalStore(drafts?.subscribe ?? noSubscription, drafts?.getSnapshot ?? noDraftSnapshot, drafts?.getSnapshot ?? noDraftSnapshot);
  const [captured, setCaptured] = useState<RetainedEntryCapture | null>(null);
  const [captureError, setCaptureError] = useState(false), [capturing, setCapturing] = useState(false), [queueEnd, setQueueEnd] = useState(false);
  const request = useRef(0), scroll = useRef<HTMLDivElement>(null), restored = useRef(false);
  const activeEditor = useRef<SegmentEditorHandle>(null);
  const searchInput = useRef<HTMLInputElement>(null), live = useRef(view), mounted = useRef(false), advanceRevision = useRef(0);
  const presentation = JSON.stringify([view.id, view.locale, view.query, view.preset, view.focus, view.editing, view.queueActive, view.queueScopeId, view.queueAnchor, view.focusMode]);
  const lastPresentation = useRef(presentation);
  if (lastPresentation.current !== presentation) { lastPresentation.current = presentation; advanceRevision.current++; }
  live.current = view;
  useLayoutEffect(() => { mounted.current = true; const release = gate.subscribe(() => { advanceRevision.current++; });
    return () => { mounted.current = false; release(); }; }, [gate]);
  const searchOwner = `entry-search-${view.id}`, listOwner = `entry-list-${view.id}`;
  const availableLocale = project.metadata.targetLocales.includes(view.locale);
  const selection = entrySelectionFilter(view.preset);
  const query: SegmentQuery = { text: view.query, selection: selection ?? "all" };
  const scope = useSessionQuery({ key: ["workbench-source-scope"], scopes: ["source"], enabled: !disabled,
    refetchOnMount: false, read: () => sourceCommands.scope(reads.context) });
  // A fixed queue survives our own confirmations. A changed source is rejected
  // by its owner instead of silently recapturing a different set of entries.
  const capture = captured?.locale === view.locale && captured.query.text === view.query && captured.query.selection === selection
    && (view.queueActive || captured.scope.snapshotId === scope.data?.currentSnapshot) ? captured.scope : null;

  async function captureCurrent(refresh = false) {
    if (!selection) return;
    const ticket = ++request.current;
    setCapturing(true); setCaptureError(false);
    try {
      const retained = !refresh && view.queueActive && view.queueScopeId ? retainedEntryCapture(reads, view.queueScopeId) : null;
      if (!refresh && view.queueActive && view.queueScopeId && (!retained || retained.locale !== view.locale
        || retained.query.text !== query.text || retained.query.selection !== query.selection)) throw new Error("Fixed queue is no longer available");
      const next = retained?.scope ?? await captureEntries(reads, view.locale, query, refresh);
      if (ticket !== request.current || reads.retired || live.current.id !== view.id || live.current.locale !== view.locale
        || live.current.query !== view.query || live.current.preset !== view.preset) return;
      setCaptured({ locale: view.locale, query, scope: next });
      if (live.current.queueActive && live.current.queueScopeId !== next.scopeId) patch({ queueScopeId: next.scopeId });
      if (refresh) patch({ afterOrdinal: 0, cursor: null });
      restored.current = false;
    } catch { if (ticket === request.current && !reads.retired) setCaptureError(true); }
    finally { if (ticket === request.current) setCapturing(false); }
  }
  useEffect(() => {
    setCaptured(null); setQueueEnd(false);
    if (availableLocale && selection && !disabled && (scope.data?.currentSnapshot || view.queueActive && view.queueScopeId)) void captureCurrent();
    return () => { request.current++; };
  }, [view.locale, view.query, selection, view.queueActive, view.queueScopeId, scope.data?.currentSnapshot, availableLocale, disabled]);
  useEffect(() => () => { gate.releaseOwner(searchOwner); gate.releaseOwner(listOwner); }, [gate, searchOwner, listOwner]);

  const emptyCapture = { scopeId: "", snapshotId: "", queryFingerprint: "", readVersion: "" };
  const enabled = !disabled && availableLocale && !!selection && !!capture;
  const page = useSessionQuery({ key: entryPageKey(view.locale, query, capture ?? emptyCapture, view.cursor),
    scopes: ["source", "translation", "review", "resources"], enabled: enabled && !view.queueActive,
    refetchOnMount: query => query.state.isInvalidated,
    read: () => { if (!capture) throw new Error("No entry read scope"); return readEntryPage(reads, view.locale, query, capture, view.cursor); } });
  const queue = useSessionQuery({ key: ["workbench-entry-queue", view.locale, capture?.scopeId ?? "", view.queueAnchor],
    scopes: ["source", "translation", "review", "resources"], enabled: enabled && view.queueActive,
    refetchOnMount: true,
    read: () => { if (!capture) throw new Error("No fixed entry queue"); return readEntryQueueWindow(reads, view.locale, query, capture, view.queueAnchor); } });
  const result = view.queueActive ? queue : page;
  const current = !result.error && result.data?.scopeId === capture?.scopeId ? result.data : null;
  const key: DraftKey | null = view.focus ? { projectId: reads.context.projectId, unitId: view.focus, locale: view.locale } : null;
  const isEditing = () => view.editing && key !== null;
  const canConfirm = () => {
    const entry = drafts && key ? drafts.getEntry(key) : null, state = drafts?.getSnapshot();
    return !disabled && isEditing() && state?.hydration === "ready" && !state.retired && !state.mutationReserved
      && !!entry?.value && entry.basisCurrent && !entry.value.pending && !entry.busy && !entry.currentFailure
      && entry.failure?.kind !== "journal" && entry.failure?.kind !== "journal-conflict";
  };
  async function refresh() {
    if (disabled || !await navigate({ focus: null, editing: false, focusMode: false, queueActive: false, queueAnchor: null, queueScopeId: null, cursor: null, afterOrdinal: 0 })) return;
    const source = await scope.refetch();
    if (source.data?.currentSnapshot && !reads.retired) await captureCurrent(true);
  }
  async function confirm(advance: boolean) {
    if (!drafts || !key || !canConfirm()) return;
    const before = drafts.getEntry(key)?.value, from = view, scopeId = capture?.scopeId, generation = advanceRevision.current;
    const outcome = await drafts.confirm(key);
    const now = live.current, interaction = gate.getSnapshot(), entry = drafts.getEntry(key);
    if (!mounted.current || advanceRevision.current !== generation || !advance || !outcome.confirmed || !outcome.savedCurrent || reads.retired || !before
      || now.id !== from.id || now.focus !== from.focus || now.locale !== from.locale || now.query !== from.query || now.preset !== from.preset
      || now.queueScopeId !== scopeId || now.queueAnchor !== from.queueAnchor || !now.editing || interaction.visibleViewId !== from.id
      || interaction.intentOwner || interaction.composingOwners.length || interaction.dialogs.length
      || entry?.newerInputAfterConfirmation || entry?.value && entry.value.editSeq !== before.editSeq) return;
    const rows = queue.data?.rows, index = rows?.findIndex(row => row.content.unitId === key.unitId) ?? -1;
    if (!rows || index < 0 || queue.data?.scopeId !== scopeId) return;
    const next = rows[index + 1]?.content.unitId ?? queue.data.nextUnitId;
    if (!next) { setQueueEnd(true); return; }
    await navigate({ focus: next, selection: [next], editing: true, queueAnchor: rows[index + 1] ? now.queueAnchor : next });
  }
  async function exitEditor() {
    if (drafts && key && !await drafts.flush(key)) return;
    await navigate({ editing: false, focusMode: false });
  }
  async function toggleFocus() {
    if (isEditing() && await navigate({ focusMode: !view.focusMode })) requestAnimationFrame(() => {
      if (mounted.current && live.current.id === view.id && live.current.focus === view.focus && live.current.editing) activeEditor.current?.focus();
    });
  }
  useImperativeHandle(ref, () => ({ refresh: () => { void refresh(); }, focusSearch: () => { if (view.focusMode) void navigate({ focusMode: false }).then(ok => { if (ok) searchInput.current?.focus(); }); else searchInput.current?.focus(); }, confirm, exitEditor, toggleFocus, isEditing, canConfirm }));
  useLayoutEffect(() => {
    if (current && !restored.current && scroll.current) {
      scroll.current.scrollTop = view.scroll.top; scroll.current.scrollLeft = view.scroll.left; restored.current = true;
    }
  }, [current, view.scroll]);
  const empty = scope.isSuccess && !scope.data.currentSnapshot && !view.queueActive;
  const failed = scope.isError || captureError || result.isError;
  const stalePage = isCommandError(result.error) && result.error.code === "dependency-conflict";
  const loading = !failed && !empty && (scope.isPending || capturing || !!capture && result.isPending);
  const searchTooLong = new TextEncoder().encode(view.searchInput).length > 256;
  function openEditor(unitId: string) {
    setQueueEnd(false);
    void navigate({ focus: unitId, selection: [unitId], editing: true, queueActive: true,
      queueScopeId: capture?.scopeId ?? null, queueAnchor: view.queueActive ? view.queueAnchor : unitId });
  }
  function moveRow(event: KeyboardEvent) {
    const interaction = gate.getSnapshot();
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
      || interaction.inputOwner?.ownerId !== listOwner || !gate.canDispatch({ viewId: view.id, source: "keyboard", inputOwner: listOwner })) return;
    const direction = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (!direction || !current) return;
    const index = current.rows.findIndex(row => row.content.unitId === view.focus);
    const next = current.rows[index < 0 ? 0 : index + direction];
    if (next) { event.preventDefault(); openEditor(next.content.unitId); }
  }

  return <div className={styles.entryView}>
    <form className={styles.toolbar} aria-label={t("searchEntries")} onSubmit={event => {
      event.preventDefault();
      if (!disabled && !searchTooLong) void navigate({ query: view.searchInput, focus: null, editing: false, focusMode: false });
    }}>
      <Menu label={t("entryFilter")} trigger={<Button size="sm" disabled={disabled}>{t(selection === "selected" ? "selectedEntries" : selection === "unselected" ? "unselectedEntries" : selection === "all" ? "allEntries" : "filterMissing")}<ChevronDown /></Button>} items={(["all", "selected", "unselected"] as const).map(id => ({ id, label: t(id === "all" ? "allEntries" : id === "selected" ? "selectedEntries" : "unselectedEntries"), onSelect: () => void navigate({ preset: id, focus: null, editing: false, focusMode: false }) }))} />
      <div className={styles.toolbarSearch}><Search /><TextInput ref={searchInput} aria-label={t("searchEntries")} aria-invalid={searchTooLong || undefined} aria-describedby={searchTooLong ? `entry-search-error-${view.id}` : undefined} placeholder={t("searchPlaceholder")} value={view.searchInput}
        onChange={event => patch({ searchInput: event.target.value })} disabled={disabled}
        onFocus={() => gate.setInputOwner(view.id, searchOwner)} onBlur={() => gate.releaseOwner(searchOwner)}
        onCompositionStart={() => gate.setComposing(searchOwner, true)} onCompositionEnd={() => gate.setComposing(searchOwner, false)}
        onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); event.stopPropagation(); } }} /></div>
      <Button type="submit" size="sm" disabled={disabled || searchTooLong}>{t("search")}</Button>
      <IconButton label={t("refresh")} disabled={disabled || capturing} onClick={() => { void refresh(); }}><RefreshCw /></IconButton>
      {current ? <span className={styles.count} title={view.queueActive ? t("fixedQueueHelp") : undefined}>{t(view.queueActive ? "fixedQueue" : "entryCount", { count: current.total })}</span> : null}
      {isEditing() ? <Button size="sm" onClick={() => { void toggleFocus(); }}>{t(view.focusMode ? "editorTableMode" : "editorFocusMode")}</Button> : null}
    </form>
    {view.focusMode ? <div className={styles.actions}><Button size="sm" onClick={() => { void toggleFocus(); }}>{t("editorTableMode")}</Button></div> : null}
    {searchTooLong ? <Banner id={`entry-search-error-${view.id}`} tone="error">{t("searchTooLong")}</Banner> : null}
    {queueEnd ? <Banner>{t("queueEnd")}</Banner> : null}
    <div className={styles.scroll} ref={scroll} onScroll={event => patch({ scroll: { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft } })}>
      {!selection ? <ErrorState title={t("filterMissing")} description={t("chooseFilter")} /> : !availableLocale ? <ErrorState title={t("languageMissing")} description={t("chooseLanguage")} action={key ? <Button onClick={() => onRevealDraft(key)}>{t("draftRecoveryOpen")}</Button> : undefined} /> : failed ? <ErrorState title={t("readFailed")} description={t(stalePage ? "viewChanged" : "readFailedHelp")} action={<div className={styles.actions}><Button onClick={() => { void refresh(); }}>{t("refresh")}</Button>{key ? <Button onClick={() => onRevealDraft(key)}>{t("draftRecoveryOpen")}</Button> : null}</div>} /> : empty ? <EmptyState icon={<Layers />} title={t("noSource")} description={t("noSourceHelp")} /> : loading || !current ? <LoadingState label={t("loadingEntries")} /> : current.rows.length === 0 ? <EmptyState icon={<Search />} title={t("noMatches")} description={t("noMatchesHelp")} /> : <div className={styles.table} onKeyDown={moveRow}>
        <div className={styles.tableHeader}><span>{t("row")}</span><span>{t("detail")}</span><span>{t("source", { locale: project.metadata.sourceLocale })}</span><span>{t("translation", { locale: view.locale })}</span></div>
        {current.rows.map((summary, index) => { const { content: row, sourceTruncated, translationTruncated } = summary;
          const active = view.editing && view.focus === row.unitId;
          const draftKey = { projectId: reads.context.projectId, unitId: row.unitId, locale: view.locale };
          const entry = drafts?.getEntry(draftKey);
          return <article key={row.unitId} hidden={view.focusMode && view.focus !== row.unitId} className={styles.entry} data-selected={view.focus === row.unitId || undefined}>
          <div className={styles.entryNumber}><Button size="xs" aria-label={t("entryEdit", { key: row.nativeKey })} disabled={disabled || !drafts}
            onFocus={() => gate.setInputOwner(view.id, listOwner)} onBlur={() => gate.releaseOwner(listOwner)} onClick={() => openEditor(row.unitId)}>{(view.queueActive ? queue.data?.firstPosition ?? 0 : view.afterOrdinal) + index + 1}</Button></div>
          <div className={styles.entryStatus}><IconButton label={t("showEntryDetails", { key: row.nativeKey })} onClick={() => { void navigate({ focus: row.unitId, dock: "details", selection: [row.unitId], ...(view.editing ? { queueAnchor: row.unitId } : {}) }); }}><MoreHorizontal /></IconButton></div>
          <div className={styles.source}><TokenizedText text={active && entry?.current.kind === "current" ? entry.current.sourceText : row.sourcePreview} />{sourceTruncated && !(active && entry?.current.kind === "current") ? <span title={t("textShortened")}>…</span> : null}{view.focus === row.unitId ? <div className={styles.entryMeta}><span className={styles.key}>{row.nativeKey}</span></div> : null}</div>
          <div className={styles.target}>{active && drafts ? <SegmentEditor ref={activeEditor} drafts={drafts} draftKey={draftKey} viewId={view.id} gate={gate} disabled={disabled} nativeKey={row.nativeKey} dispatch={dispatch} />
            : row.translationPreview === null ? <span className={styles.meta}>{t("noTranslation")}</span> : <><TokenizedText text={row.translationPreview} />{translationTruncated ? <span title={t("textShortened")}>…</span> : null}</>}<EntryFacts row={summary} /></div>
        </article>; })}
        <div className={styles.actions}>
          {view.queueActive ? <>
            {queue.data?.previousUnitId ? <Button onClick={() => { void navigate({ queueAnchor: null, focus: null, editing: false, focusMode: false, scroll: { top: 0, left: 0 } }); }}>{t("firstPage")}</Button> : null}
            {queue.data?.nextUnitId ? <Button onClick={() => { void navigate({ queueAnchor: queue.data?.nextUnitId ?? null, focus: queue.data?.nextUnitId ?? null, editing: true, scroll: { top: 0, left: 0 } }); }}>{t("nextPage")}</Button> : null}
          </> : <>
            {view.cursor !== null ? <Button onClick={() => { void navigate({ afterOrdinal: 0, cursor: null, scroll: { top: 0, left: 0 } }); }}>{t("firstPage")}</Button> : null}
            {page.data?.nextCursor != null ? <Button onClick={() => { void navigate({ afterOrdinal: view.afterOrdinal + current.rows.length, cursor: page.data?.nextCursor ?? null, scroll: { top: 0, left: 0 } }); }}>{t("nextPage")}</Button> : null}
          </>}
        </div>
      </div>}
    </div>
  </div>;
}
