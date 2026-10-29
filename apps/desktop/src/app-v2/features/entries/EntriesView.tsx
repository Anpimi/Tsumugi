import { rememberProjectActivity } from "../../../recentProjects";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { CheckSquare, ChevronDown, Layers, RefreshCw, Search, X } from "lucide-react";
import type { ProjectView } from "../../../projectCommands";
import { isCommandError } from "../../../projectCommands";
import { sameDraftBasis } from "../../../draftCommands";
import type { EntryReviewEditorRequest } from "../review/navigationTypes";
import { readEditorNavigation } from "../review/readEditorNavigation";
import type { WorkbenchCommands } from "../../../workbenchCommands";
import type { DraftKey } from "../../../draftCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { Button, IconButton } from "../../../design-system/Button";
import { TextInput } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import type { SegmentQuery, SegmentRow } from "../../../segmentCommands";
import type { WorkspaceView } from "../../workspace/workspaceStore";
import type { InteractionGate } from "../../workspace/interactionGate";
import { type SegmentEditorProps } from "../editor/SegmentEditor";
import type { TranslationDrafts } from "../editor/translationDrafts";
import { captureEntries, captureEntrySelection, entryPageKey, entryPresets, entryQuery, entrySourceComparisonKey, readEntrySourceComparison, readEntryPage, readEntryQueueWindow, retainedEntryCapture, sameEntryQuery, type RetainedEntryCapture } from "./entryReads";
import { copyWorkspaceSelection, toggleWorkspaceSelection, workspaceSelectionIds, workspaceSelectionMatches, type WorkspaceSelection } from "../../workspace/workspaceSelection";
import EntriesTable, { type EntriesTableHandle } from "./EntriesTable";
import styles from "../../WorkbenchLayout.module.css";
import local from "./EntriesView.module.css";

type Props = {
  project: ProjectView; view: WorkspaceView; disabled: boolean; commands?: WorkbenchCommands | null;
  patch: (value: Partial<WorkspaceView>) => void;
  navigate: (value: Partial<WorkspaceView>) => Promise<boolean>;
  drafts: TranslationDrafts | null; gate: InteractionGate;
  dispatch: SegmentEditorProps["dispatch"];
  onRevealDraft: (key: DraftKey) => void;
  onImport?: () => void;
  onCandidateBatch?: (mode: "stage" | "reject" | "restore", selection: WorkspaceSelection) => void;
  candidateBatchTriggerRef?: Ref<HTMLButtonElement>;
  candidateBatchBlocked?: boolean;
  onReviewBatch?: (selection: WorkspaceSelection) => void;
  reviewBatchTriggerRef?: Ref<HTMLButtonElement>;
  renderCandidate?: (row: SegmentRow) => ReactNode;
  ref?: Ref<EntriesHandle>;
};
export interface EntriesHandle {
  refresh: () => void; focusSearch: () => void;
  confirm: (advance: boolean) => Promise<void>; exitEditor: () => Promise<void>;
  openReviewEditor: (input: EntryReviewEditorRequest, proof: () => boolean, beforeNavigate?: () => void) => Promise<boolean>;
  toggleFocus: () => Promise<void>; isEditing: () => boolean; canConfirm: () => boolean;
}
const noSubscription = () => () => {};
const noDraftSnapshot = () => null;

export default function EntriesView({ project, view, disabled, patch, navigate, drafts, gate, dispatch, onRevealDraft, onImport, onCandidateBatch, candidateBatchTriggerRef, candidateBatchBlocked = false, onReviewBatch, reviewBatchTriggerRef, renderCandidate, commands, ref }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads();
  useSyncExternalStore(drafts?.subscribe ?? noSubscription, drafts?.getSnapshot ?? noDraftSnapshot, drafts?.getSnapshot ?? noDraftSnapshot);
  const [captured, setCaptured] = useState<RetainedEntryCapture | null>(null);
  const [captureError, setCaptureError] = useState(false), [capturing, setCapturing] = useState(false), [queueEnd, setQueueEnd] = useState(false);
  const request = useRef(0), selectionRequest = useRef(0);
  const openingReview = useRef(false), reviewSerial = useRef(0), diagnosticTicket = useRef<{ id: string; valid: boolean } | null>(null);
  const [reviewNotice, setReviewNotice] = useState<"reviewEditorReading" | "reviewEditorChanged" | "reviewEditorFailed" | "reviewEditorReturnBlocked" | null>(null);
  const [selecting, setSelecting] = useState(false), [selectionFailed, setSelectionFailed] = useState(false), [rowFocus, setRowFocus] = useState<string | null>(null);
  const table = useRef<EntriesTableHandle>(null);
  const searchInput = useRef<HTMLInputElement>(null), live = useRef(view), mounted = useRef(false), advanceRevision = useRef(0);
  const presentation = JSON.stringify([view.id, view.locale, view.query, view.preset, view.focus, view.editing, view.queueActive, view.queueScopeId, view.queueAnchor, view.focusMode]);
  const lastPresentation = useRef(presentation);
  if (lastPresentation.current !== presentation) { lastPresentation.current = presentation; advanceRevision.current++; }
  live.current = view;
  useLayoutEffect(() => { mounted.current = true; const release = gate.subscribe(() => { advanceRevision.current++; });
    return () => { mounted.current = false; release(); }; }, [gate]);
  const searchOwner = `entry-search-${view.id}`;
  const availableLocale = project.metadata.targetLocales.includes(view.locale);
  const configuredQuery = entryQuery(view.preset, view.query);
  const query: SegmentQuery = configuredQuery ?? { text: view.query, selection: "all", status: "all" };
  const queryIdentity = JSON.stringify(query);
  const scope = useSessionQuery({ key: ["workbench-source-scope"], scopes: ["source"], enabled: !disabled,
    refetchOnMount: false, read: () => sourceCommands.scope(reads.context) });
  // A fixed queue survives our own confirmations. A changed source is rejected
  // by its owner instead of silently recapturing a different set of entries.
  const capture = captured?.locale === view.locale && sameEntryQuery(captured.query, query)
    && (view.queueActive || captured.scope.snapshotId === scope.data?.currentSnapshot) ? captured.scope : null;

  async function captureCurrent(refresh = false) {
    if (!configuredQuery) return;
    const ticket = ++request.current;
    setCapturing(true); setCaptureError(false);
    try {
      const retained = !refresh && view.queueActive && view.queueScopeId ? retainedEntryCapture(reads, view.queueScopeId) : null;
      if (!refresh && view.queueActive && view.queueScopeId && (!retained || retained.locale !== view.locale
        || !sameEntryQuery(retained.query, query))) throw new Error("Fixed queue is no longer available");
      const next = retained?.scope ?? await captureEntries(reads, view.locale, query, refresh);
      if (ticket !== request.current || reads.retired || live.current.id !== view.id || live.current.locale !== view.locale
        || live.current.query !== view.query || live.current.preset !== view.preset) return;
      setCaptured({ locale: view.locale, query, scope: next });
      if (live.current.queueActive && live.current.queueScopeId !== next.scopeId) patch({ queueScopeId: next.scopeId });
      if (refresh) patch({ afterOrdinal: 0, cursor: null });
    } catch { if (ticket === request.current && !reads.retired) setCaptureError(true); }
    finally { if (ticket === request.current) setCapturing(false); }
  }
  useEffect(() => {
    setCaptured(null); setQueueEnd(false);
    if (availableLocale && configuredQuery && !disabled && (scope.data?.currentSnapshot || view.queueActive && view.queueScopeId)) void captureCurrent();
    return () => { request.current++; };
  }, [view.locale, queryIdentity, view.queueActive, view.queueScopeId, scope.data?.currentSnapshot, availableLocale, disabled]);
  useEffect(() => () => { gate.releaseOwner(searchOwner); }, [gate, searchOwner]);
  useEffect(() => { selectionRequest.current++; setSelecting(false); setSelectionFailed(false); }, [view.id, view.locale, view.preset, view.query]);

  const emptyCapture = { scopeId: "", snapshotId: "", queryFingerprint: "", readVersion: "" };
  const enabled = !disabled && availableLocale && !!configuredQuery && !!capture;
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
  const comparison = useSessionQuery({ key: entrySourceComparisonKey(view.locale, capture ?? emptyCapture, current?.rows ?? []),
    scopes: ["source"], enabled: enabled && view.compareSource && !!current?.rows.length,
    refetchOnMount: query => query.state.isInvalidated,
    read: () => {
      if (!capture || !current) throw new Error("No source comparison scope");
      return readEntrySourceComparison(reads, view.locale, capture, current.rows);
    } });
  const recentEntry = current?.rows.find(row => row.content.unitId === view.focus)?.content;
  useEffect(() => {
    if (!recentEntry || reads.retired) return;
    const position = { unitId: recentEntry.unitId, locale: view.locale, nativeKey: recentEntry.nativeKey };
    rememberProjectActivity(project.locator, position);
    return () => rememberProjectActivity(project.locator, position);
  }, [project.locator, reads, recentEntry?.unitId, recentEntry?.nativeKey, view.locale]);
  const currentComparison = view.compareSource && !comparison.error && comparison.data && capture
    && comparison.data.scopeId === capture.scopeId && comparison.data.currentSnapshotId === capture.snapshotId ? comparison.data : null;
  const key: DraftKey | null = view.focus ? { projectId: reads.context.projectId, unitId: view.focus, locale: view.locale } : null;
  const isEditing = () => view.editing && key !== null;
  const canConfirm = () => {
    const entry = drafts && key ? drafts.getEntry(key) : null, state = drafts?.getSnapshot();
    return !disabled && isEditing() && state?.hydration === "ready" && !state.retired && !state.mutationReserved
      && !!entry?.value && entry.basisCurrent && !entry.value.pending && !entry.busy && !entry.currentFailure
      && !(entry.value.merge && entry.failure?.kind === "basis-conflict") && entry.failure?.kind !== "journal" && entry.failure?.kind !== "journal-conflict";
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
    await navigate({ focus: next, editing: true, queueAnchor: rows[index + 1] ? now.queueAnchor : next });
  }
  async function openReviewEditor(input: EntryReviewEditorRequest, proof: () => boolean, beforeNavigate?: () => void) {
    if (!drafts || disabled || openingReview.current || !capture || !current || !proof() || input.target.unitId !== view.focus
      || input.target.locale !== view.locale || !current.rows.some(row => row.content.unitId === input.target.unitId)) return false;
    const from = live.current, generation = advanceRevision.current, scopeId = capture.scopeId, focusOrigin = document.activeElement, inputVersion = drafts.inputVersion();
    let invalidated = false;
    const stop = reads.subscribeChanges(scopes => { if (scopes.some(scope => ["project", "source", "translation", "review", "resources", "execution"].includes(scope))) invalidated = true; });
    const valid = () => mounted.current && !disabled && !reads.retired && !invalidated && live.current === from
      && advanceRevision.current === generation && drafts.inputVersion() === inputVersion && document.activeElement === focusOrigin && proof() && project.metadata.targetLocales.includes(input.target.locale);
    openingReview.current = true; setReviewNotice("reviewEditorReading");
    try {
      const snapshot = await readEditorNavigation(reads, input, valid);
      if (!snapshot || !valid() || snapshot.target.sourceSnapshotId !== capture.snapshotId) { setReviewNotice("reviewEditorChanged"); return false; }
      const draftKey = { projectId: reads.context.projectId, unitId: input.target.unitId, locale: input.target.locale };
      const entry = await drafts.open(draftKey);
      if (!entry || !valid()) { setReviewNotice("reviewEditorChanged"); return false; }
      const target = snapshot.target, diagnostic = input.diagnostic;
      const basis = { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText };
      if (diagnostic && (!entry.value || entry.current.kind !== "current" || entry.currentFailure || !entry.basisCurrent
        || !sameDraftBasis(entry.current.basis, basis) || !sameDraftBasis(entry.value.basis, basis) || entry.current.sourceText !== target.sourceText
        || entry.value.pending || entry.value.merge || entry.busy || diagnostic.location.location.field === "translation" && entry.value.text !== target.translationText)) {
        setReviewNotice("reviewEditorChanged"); return false;
      }
      const origin = from.reviewNavigation?.returnTo ?? { focus: from.focus, locale: from.locale, preset: from.preset, query: from.query, searchInput: from.searchInput,
        scroll: { ...from.scroll }, selection: copyWorkspaceSelection(from.selection), queueActive: true, queueScopeId: scopeId,
        queueAnchor: from.queueActive ? from.queueAnchor : current.rows[0]?.content.unitId ?? from.focus,
        afterOrdinal: from.afterOrdinal, cursor: from.cursor, detailTab: "issues" as const, dock: "details" as const, dockOpen: from.dockOpen };
      const id = `${from.id}-diagnostic-${++reviewSerial.current}`;
      const focus = diagnostic && entry.value ? { id, unitId: target.unitId, locale: target.locale, sourceText: target.sourceText,
        translationText: target.translationText, basis, editSeq: entry.value.editSeq, location: diagnostic.location.location, status: "pending" as const } : null;
      diagnosticTicket.current = focus ? { id, valid: true } : null;
      // Closing our own Sheet is the last presentation step before the guarded
      // route. Its unmount must not revoke the already checked read evidence.
      beforeNavigate?.();
      const accepted = await navigate({ editing: true, focusMode: false, queueActive: true, queueScopeId: scopeId,
        queueAnchor: from.queueActive ? from.queueAnchor : from.focus, reviewNavigation: { returnTo: origin, focus } });
      if (mounted.current) setReviewNotice(accepted ? null : "reviewEditorReturnBlocked");
      if (!accepted) diagnosticTicket.current = null;
      return accepted;
    } catch { if (mounted.current) setReviewNotice("reviewEditorFailed"); return false; }
    finally { stop(); openingReview.current = false; }
  }
  async function returnReview() {
    const navigation = live.current.reviewNavigation;
    if (!navigation || disabled || openingReview.current) return;
    const accepted = await navigate({ ...navigation.returnTo, editing: false, focusMode: false, reviewNavigation: null });
    if (mounted.current) { setReviewNotice(accepted ? null : "reviewEditorReturnBlocked"); if (accepted) setRowFocus(navigation.returnTo.focus); }
  }
  useLayoutEffect(() => reads.subscribeChanges(scopes => {
    if (!scopes.some(scope => ["project", "source", "translation", "review", "resources", "execution"].includes(scope)) || !diagnosticTicket.current) return;
    diagnosticTicket.current.valid = false;
    const navigation = live.current.reviewNavigation;
    if (navigation?.focus && navigation.focus.status !== "stale") patch({ reviewNavigation: { ...navigation, focus: { ...navigation.focus, status: "stale" } } });
  }), [reads]);
  useLayoutEffect(() => {
    if (!commands) return;
    return commands.register({ id: "review.entry-return-to-queue", nameKey: "workbenchV2.reviewEditorReturn", scope: { ...reads.context, area: "translation" },
      category: "review", binding: null, risk: "changes-view", confirmation: "none", availability: () => ({ enabled: !disabled && !openingReview.current
        && !!live.current.reviewNavigation && gate.canDispatch({ viewId: view.id, source: "button" }) }), handler: () => { void returnReview(); } });
  });
  async function exitEditor() {
    if (view.reviewNavigation) { await returnReview(); return; }
    if (drafts && key && !await drafts.flush(key)) return;
    await navigate({ editing: false, focusMode: false });
  }
  async function toggleFocus() {
    if (isEditing() && await navigate({ focusMode: !view.focusMode })) requestAnimationFrame(() => {
      if (mounted.current && live.current.id === view.id && live.current.focus === view.focus && live.current.editing) table.current?.focusEditor();
    });
  }
  useImperativeHandle(ref, () => ({ refresh: () => { void refresh(); }, focusSearch: () => { if (view.focusMode) void navigate({ focusMode: false }).then(ok => { if (ok) searchInput.current?.focus(); }); else searchInput.current?.focus(); }, confirm, exitEditor, toggleFocus, isEditing, canConfirm, openReviewEditor }));
  useLayoutEffect(() => {
    if (rowFocus && current?.rows.some(row => row.content.unitId === rowFocus) && !view.editing && view.focus === rowFocus) {
      table.current?.focusRow(rowFocus); setRowFocus(null);
    }
  }, [rowFocus, current, view.editing, view.focus]);
  const empty = scope.isSuccess && !scope.data.currentSnapshot && !view.queueActive;
  const failed = scope.isError || captureError || result.isError;
  const stalePage = isCommandError(result.error) && result.error.code === "dependency-conflict";
  const loading = !failed && !empty && (scope.isPending || capturing || !!capture && result.isPending);
  const searchTooLong = new TextEncoder().encode(view.searchInput).length > 256;
  function openEditor(unitId: string) {
    setQueueEnd(false);
    void navigate({ focus: unitId, editing: true, queueActive: true,
      queueScopeId: capture?.scopeId ?? null, queueAnchor: view.queueActive ? view.queueAnchor : unitId });
  }
  async function moveRow(direction: 1 | -1, fromUnitId: string) {
    if (disabled || !current || !capture) return;
    const from = live.current, generation = advanceRevision.current;
    const index = current.rows.findIndex(row => row.content.unitId === fromUnitId);
    if (index < 0) return;
    let next: string | undefined = current.rows[index + direction]?.content.unitId;
    let anchor = view.queueActive ? view.queueAnchor : current.rows[0]?.content.unitId ?? null;
    if (!next) {
      if (view.queueActive) next = (direction > 0 ? queue.data?.nextUnitId : queue.data?.previousUnitId) ?? undefined;
      else {
        try {
          const window = await reads.client.fetchQuery({ queryKey: reads.key(["workbench-entry-queue", view.locale, capture.scopeId, fromUnitId]),
            staleTime: 0, retry: false, meta: { scopes: ["source", "translation", "review", "resources"] },
            queryFn: () => readEntryQueueWindow(reads, view.locale, query, capture, fromUnitId) });
          next = direction > 0 ? window.rows[1]?.content.unitId ?? window.nextUnitId ?? undefined : window.previousUnitId ?? undefined;
        } catch { setCaptureError(true); return; }
      }
      anchor = next ?? anchor;
    }
    if (!next || reads.retired || live.current !== from || advanceRevision.current !== generation) return;
    if (await navigate({ focus: next, editing: false, focusMode: false, queueActive: true, queueScopeId: capture.scopeId, queueAnchor: anchor })) setRowFocus(next);
  }
  const selectedIds = workspaceSelectionIds(view.selection);
  const selectionMatches = workspaceSelectionMatches(view.selection, view.locale, scope.data?.currentSnapshot);
  const scopeMembers = view.selection?.kind === "scope" ? new Set(view.selection.selection.capture.units.map(unit => unit.unitId)) : null;
  const canSelect = (unitId: string) => !disabled && !selecting && !!current && selectionMatches && (!scopeMembers || scopeMembers.has(unitId));
  function chooseRows(unitIds: readonly string[], selected: boolean) {
    const snapshotId = scope.data?.currentSnapshot;
    if (!snapshotId || !selectionMatches || disabled || selecting) return;
    patch({ selection: toggleWorkspaceSelection(view.selection, view.locale, snapshotId, unitIds.filter(canSelect), selected) });
  }
  function choosePage() {
    const ids = current?.rows.map(row => row.content.unitId).filter(canSelect) ?? [];
    const selected = new Set(selectedIds);
    chooseRows(ids, !ids.every(id => selected.has(id)));
  }
  async function chooseMatches() {
    if (!capture || !current || disabled || selecting || !configuredQuery) return;
    const ticket = ++selectionRequest.current, from = live.current;
    setSelecting(true); setSelectionFailed(false);
    try {
      const selected = await captureEntrySelection(reads, view.locale, query, capture);
      const now = live.current;
      if (ticket === selectionRequest.current && mounted.current && !reads.retired && now.id === from.id && now.locale === from.locale
        && now.preset === from.preset && now.query === from.query && now.selection === from.selection) patch({ selection: selected });
    } catch { if (ticket === selectionRequest.current && mounted.current && !reads.retired) setSelectionFailed(true); }
    finally { if (ticket === selectionRequest.current && mounted.current) setSelecting(false); }
  }
  const presetNames = { all: "allEntries", selected: "selectedEntries", unselected: "unselectedEntries", untranslated: "entryPresetUntranslated",
    "needs-review": "entryPresetReview", issues: "entryPresetIssues", affected: "entryPresetAffected", blocking: "entryPresetBlocking", "ai-pending": "entryPresetAi" } as const;
  const selectedPreset = entryPresets.find(value => value === view.preset);
  const footer = <div className={styles.actions}>
    {view.queueActive ? <>
      {queue.data?.previousUnitId ? <Button disabled={disabled} onClick={() => { void navigate({ queueAnchor: null, focus: null, editing: false, focusMode: false, scroll: { top: 0, left: 0 } }); }}>{t("firstPage")}</Button> : null}
      {queue.data?.nextUnitId ? <Button disabled={disabled} onClick={() => { const next = queue.data?.nextUnitId; if (next) void navigate({ queueAnchor: next, focus: next, editing: false, scroll: { top: 0, left: 0 } }).then(ok => { if (ok) setRowFocus(next); }); }}>{t("nextPage")}</Button> : null}
    </> : <>
      {view.cursor !== null ? <Button disabled={disabled} onClick={() => { void navigate({ afterOrdinal: 0, cursor: null, focus: null, scroll: { top: 0, left: 0 } }); }}>{t("firstPage")}</Button> : null}
      {page.data?.nextCursor != null ? <Button disabled={disabled} onClick={() => { void navigate({ afterOrdinal: view.afterOrdinal + (current?.rows.length ?? 0), cursor: page.data?.nextCursor ?? null, focus: null, scroll: { top: 0, left: 0 } }); }}>{t("nextPage")}</Button> : null}
    </>}
  </div>;

  return <div className={styles.entryView}>
    <form className={`${styles.toolbar} ${local.toolbar}`} aria-label={t("searchEntries")} onSubmit={event => {
      event.preventDefault();
      if (!disabled && !searchTooLong) void navigate({ query: view.searchInput, focus: null, editing: false, focusMode: false });
    }}>
      <Menu label={t("entryFilter")} trigger={<Button size="sm" disabled={disabled}>{t(selectedPreset ? presetNames[selectedPreset] : "filterMissing")}<ChevronDown /></Button>}
        items={entryPresets.map(id => ({ id, label: t(presetNames[id]), onSelect: () => void navigate({ preset: id, focus: null, editing: false, focusMode: false }) }))} />
      <div className={styles.toolbarSearch}><Search /><TextInput ref={searchInput} aria-label={t("searchEntries")} aria-invalid={searchTooLong || undefined} aria-describedby={searchTooLong ? `entry-search-error-${view.id}` : undefined} placeholder={t("searchPlaceholder")} value={view.searchInput}
        onChange={event => patch({ searchInput: event.target.value })} disabled={disabled}
        onFocus={() => gate.setInputOwner(view.id, searchOwner)} onBlur={() => gate.releaseOwner(searchOwner)}
        onCompositionStart={() => gate.setComposing(searchOwner, true)} onCompositionEnd={() => gate.setComposing(searchOwner, false)}
        onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); event.stopPropagation(); } }} /></div>
      <Button type="submit" size="sm" disabled={disabled || searchTooLong}>{t("search")}</Button>
      <IconButton label={t("refresh")} disabled={disabled || capturing} onClick={() => { void refresh(); }}><RefreshCw /></IconButton>
      <Menu label={t("entrySelectionMenu")} trigger={<IconButton size="sm" label={t("entrySelectionMenu")} disabled={disabled || !current || selecting}><CheckSquare /></IconButton>} items={[
        { id: "page", label: t("entrySelectPage"), onSelect: choosePage, disabled: !selectionMatches || selecting },
        { id: "matches", label: t("entrySelectMatches"), onSelect: () => { void chooseMatches(); }, disabled: !current?.total || selecting },
        { id: "clear", label: t("entryClearSelection"), onSelect: () => patch({ selection: null }), disabled: !view.selection },
      ]} />
      <Button size="sm" disabled={disabled} aria-pressed={view.entryPageMode} onClick={() => patch({ entryPageMode: !view.entryPageMode })}>{t(view.entryPageMode ? "entryWindowDisplay" : "entryFullPage")}</Button>
      <Button size="sm" disabled={disabled || !availableLocale} aria-pressed={view.compareSource} onClick={() => patch({ compareSource: !view.compareSource })}>{t("sourceComparisonToggle")}</Button>
      {onImport ? <Button size="sm" disabled={disabled || !drafts || drafts.getSnapshot().hydration !== "ready" || drafts.getSnapshot().retired} onClick={onImport}>{t("importTitle")}</Button> : null}
      {current ? <span className={styles.count} title={view.queueActive ? t("fixedQueueHelp") : undefined}>{t(view.queueActive ? "fixedQueue" : "entryCount", { count: current.total })}</span> : null}
      {isEditing() ? <Button size="sm" onClick={() => { void toggleFocus(); }}>{t(view.focusMode ? "editorTableMode" : "editorFocusMode")}</Button> : null}
    </form>
    {!view.focusMode && (view.query || view.selection) ? <div className={local.scopeBar}>
      {view.query ? <Button size="sm" disabled={disabled} onClick={() => { void navigate({ query: "", searchInput: "", focus: null, editing: false, focusMode: false }); }} aria-label={t("entryClearQuery")}><span>{t("entryQueryChip", { query: view.query })}</span><X /></Button> : null}
      {view.selection ? <><span>{t("entrySelectedCount", { count: selectedIds.length })}</span>{view.selection.kind === "scope" ? <span>{t("entryFixedSelection", { total: String(view.selection.selection.capture.units.length), excluded: String(view.selection.selection.excluded.length) })}</span> : null}
        {onCandidateBatch ? <Menu label={t("candidateBatchMenu")} trigger={<Button ref={candidateBatchTriggerRef} size="sm" disabled={disabled || candidateBatchBlocked || !selectionMatches || !selectedIds.length} title={candidateBatchBlocked ? t("candidateBatchRetained") : undefined}>{t("candidateBatchMenu")}<ChevronDown /></Button>}
          items={(["stage", "reject", "restore"] as const).map(mode => ({ id: mode, label: t(mode === "stage" ? "candidateBatchStage" : mode === "reject" ? "candidateBatchReject" : "candidateBatchRestore"),
            onSelect: () => { const selection = copyWorkspaceSelection(view.selection); if (selection) onCandidateBatch(mode, selection); }, disabled: disabled || candidateBatchBlocked || !selectionMatches || !selectedIds.length }))}/> : null}
        {onReviewBatch ? <Button ref={reviewBatchTriggerRef} size="sm" disabled={disabled || !selectionMatches || !selectedIds.length}
          onClick={() => { const selection = copyWorkspaceSelection(view.selection); if (selection) onReviewBatch(selection); }}>{t("reviewBatchTitle")}</Button> : null}
        <Button size="sm" onClick={() => patch({ selection: null })}>{t("entryClearSelection")}</Button></> : null}
    </div> : null}
    {!selectionMatches ? <Banner tone="warning">{t("entrySelectionChanged")}</Banner> : null}
    {selecting ? <Banner>{t("entryCapturingSelection")}</Banner> : null}
    {selectionFailed ? <Banner tone="error" action={<Button disabled={!current || selecting || disabled} onClick={() => { void chooseMatches(); }}>{t("entrySelectMatches")}</Button>}>{t("entrySelectionFailed")}</Banner> : null}
    {view.focusMode ? <div className={styles.actions}><Button size="sm" onClick={() => { void toggleFocus(); }}>{t("editorTableMode")}</Button></div> : null}
    {searchTooLong ? <Banner id={`entry-search-error-${view.id}`} tone="error">{t("searchTooLong")}</Banner> : null}
    {reviewNotice ? <Banner tone={reviewNotice === "reviewEditorFailed" ? "error" : "info"} role="status">{t(reviewNotice)}</Banner> : null}
    {view.reviewNavigation ? <Banner action={<Button size="sm" disabled={!commands || disabled || openingReview.current || !gate.canDispatch({ viewId: view.id, source: "button" })}
      onClick={() => commands?.dispatch("review.entry-return-to-queue", { ...reads.context, area: "translation" })}>{t("reviewEditorReturn")}</Button>}>
      {t(view.reviewNavigation.focus?.status === "stale" ? "reviewEditorLocationChanged" : "reviewEditorReturnHelp")}</Banner> : null}
    {queueEnd ? <Banner>{t("queueEnd")}</Banner> : null}
    {view.compareSource && current?.rows.length ? comparison.isError ? <Banner tone="error" role="alert" action={<Button disabled={disabled || comparison.isFetching} onClick={() => { void comparison.refetch(); }}>{t("sourceComparisonRetry")}</Button>}>{t("sourceComparisonFailed")}</Banner>
      : comparison.isPending || comparison.isFetching ? <Banner role="status">{t("sourceComparisonLoading")}</Banner>
        : currentComparison?.baseSnapshotId === null ? <Banner role="status">{t("sourceComparisonFirstVersion")}</Banner> : null : null}
    {!configuredQuery ? <ErrorState title={t("filterMissing")} description={t("chooseFilter")} /> : !availableLocale ? <ErrorState title={t("languageMissing")} description={t("chooseLanguage")} action={key ? <Button onClick={() => onRevealDraft(key)}>{t("draftRecoveryOpen")}</Button> : undefined} /> : failed ? <ErrorState title={t("readFailed")} description={t(stalePage ? "viewChanged" : "readFailedHelp")} action={<div className={styles.actions}><Button onClick={() => { void refresh(); }}>{t("refresh")}</Button>{key ? <Button onClick={() => onRevealDraft(key)}>{t("draftRecoveryOpen")}</Button> : null}</div>} /> : empty ? <EmptyState icon={<Layers />} title={t("noSource")} description={t("noSourceHelp")} /> : loading || !current ? <LoadingState label={t("loadingEntries")} /> : current.rows.length === 0 ? <EmptyState icon={<Search />} title={t("noMatches")} description={t("noMatchesHelp")} /> : <EntriesTable ref={table} rows={current.rows} firstPosition={view.queueActive ? queue.data?.firstPosition ?? 0 : view.afterOrdinal} total={current.total}
      projectId={reads.context.projectId} sourceLocale={project.metadata.sourceLocale} view={view} drafts={drafts} gate={gate} disabled={disabled} dispatch={dispatch} scroll={view.scroll}
      selectedIds={selectionMatches ? selectedIds : []} canSelect={canSelect} onScroll={position => patch({ scroll: position })} onEdit={openEditor}
      sourceComparison={currentComparison} renderCandidate={renderCandidate}
      diagnosticFocus={view.reviewNavigation?.focus} diagnosticCurrent={() => !!diagnosticTicket.current && diagnosticTicket.current.id === view.reviewNavigation?.focus?.id && diagnosticTicket.current.valid}
      onDiagnosticFocus={(id, applied) => { const current = live.current.reviewNavigation; if (current?.focus?.id === id && current.focus.status === "pending") patch({ reviewNavigation: { ...current, focus: { ...current.focus, status: applied ? "applied" : "stale" } } }); }}
      onDetails={unitId => { void navigate({ focus: unitId, dock: "details", ...(view.editing ? { queueAnchor: unitId } : {}) }); }}
      onMove={(direction, unitId) => { void moveRow(direction, unitId); }} onSelection={(unitId, selected) => chooseRows([unitId], selected)} footer={footer} />}
  </div>;
}
