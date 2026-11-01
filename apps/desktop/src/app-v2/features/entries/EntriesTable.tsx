import { memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "../../../design-system/Button";
import { Field, TextArea } from "../../../design-system/Field";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { diagnosticTextareaSelection, textareaDisplayText } from "../../../reviewDiagnosticNavigation";
import type { SegmentRow, SegmentSourceComparison, SourceVersionComparison } from "../../../segmentCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { WorkspaceView } from "../../workspace/workspaceStore";
import SegmentEditor, { diagnosticDraftCurrent, type SegmentEditorHandle, type SegmentEditorProps } from "../editor/SegmentEditor";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { EntryDiagnosticFocus } from "../review/navigationTypes";
import EntryStatus from "./EntryStatus";
import styles from "./EntriesTable.module.css";

export interface EntriesTableHandle {
  focusEditor: () => void;
  focusRow: (unitId: string) => void;
}
export interface EntriesTableProps {
  rows: readonly SegmentRow[];
  firstPosition: number;
  total: number;
  projectId: string;
  sourceLocale: string;
  view: WorkspaceView;
  drafts: TranslationDrafts | null;
  gate: InteractionGate;
  disabled: boolean;
  dispatch: SegmentEditorProps["dispatch"];
  scroll: { top: number; left: number };
  selectedIds: readonly string[];
  onScroll: (position: { top: number; left: number }) => void;
  onEdit: (unitId: string) => void;
  onDetails: (unitId: string) => void;
  onMove: (direction: 1 | -1, fromUnitId: string) => void;
  onSelection: (unitId: string, checked: boolean) => void;
  canSelect: (unitId: string) => boolean;
  sourceComparison?: SegmentSourceComparison | null;
  diagnosticFocus?: EntryDiagnosticFocus | null;
  diagnosticCurrent?: () => boolean;
  onDiagnosticFocus?: (id: string, applied: boolean) => void;
  renderCandidate?: (row: SegmentRow) => ReactNode;
  footer?: ReactNode;
  ref?: Ref<EntriesTableHandle>;
}
const noSubscription = () => () => {};
const noSnapshot = () => null;
const estimatedRowHeight = 112;

function EntrySource({ summary, active, drafts, projectId, locale, comparison, diagnosticFocus, diagnosticCurrent, onDiagnosticFocus, gate, viewId, disabled }: {
  summary: SegmentRow; active: boolean; drafts: TranslationDrafts | null; projectId: string; locale: string; comparison: SourceVersionComparison | undefined;
  diagnosticFocus?: EntryDiagnosticFocus | null; diagnosticCurrent?: () => boolean; onDiagnosticFocus?: (id: string, applied: boolean) => void;
  gate: InteractionGate; viewId: string; disabled: boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  useSyncExternalStore(active && drafts ? drafts.subscribe : noSubscription, active && drafts ? drafts.getSnapshot : noSnapshot, noSnapshot);
  useSyncExternalStore(active ? gate.subscribe : noSubscription, active ? gate.getSnapshot : noSnapshot, noSnapshot);
  const field = useRef<HTMLTextAreaElement>(null), consumed = useRef(new Set<string>()), ownerId = `entry-source-${useId()}`;
  const sourceFocus = diagnosticFocus?.unitId === summary.content.unitId && diagnosticFocus.locale === locale && diagnosticFocus.location.field === "source" ? diagnosticFocus : null;
  const current = active ? drafts?.getEntry({ projectId, unitId: summary.content.unitId, locale })?.current : null;
  const complete = current?.kind === "current";
  function reject() {
    if (!sourceFocus || sourceFocus.status !== "pending" || consumed.current.has(sourceFocus.id)) return;
    consumed.current.add(sourceFocus.id); onDiagnosticFocus?.(sourceFocus.id, false);
  }
  useEffect(() => {
    if (!sourceFocus || sourceFocus.status !== "pending" || consumed.current.has(sourceFocus.id)) return;
    const moved = (event: FocusEvent) => { if (event.target !== field.current) reject(); };
    document.addEventListener("focusin", moved);
    return () => document.removeEventListener("focusin", moved);
  }, [sourceFocus, onDiagnosticFocus]);
  useLayoutEffect(() => () => gate.releaseOwner(ownerId), [gate, ownerId, viewId]);
  useLayoutEffect(() => {
    const focus = sourceFocus; if (!focus || focus.status !== "pending" || consumed.current.has(focus.id)) return;
    const control = field.current;
    const permitted = () => active && !disabled && gate.canDispatch({ viewId, source: "button" })
      && (gate.getSnapshot().inputOwner === null || gate.getSnapshot().inputOwner?.ownerId === ownerId) && (diagnosticCurrent?.() ?? true);
    if (!permitted() || document.activeElement !== document.body && document.activeElement !== control) { reject(); return; }
    if (!drafts || !current) return;
    consumed.current.add(focus.id);
    const key = { projectId, unitId: summary.content.unitId, locale }, selection = diagnosticTextareaSelection(focus.sourceText, focus.location.range);
    if (!control || !selection || !control.isConnected || control.closest("[hidden], [inert]") || control.value !== selection.text
      || !diagnosticDraftCurrent(drafts, key, focus, true)) { onDiagnosticFocus?.(focus.id, false); return; }
    control.focus({ preventScroll: true });
    if (!permitted() || document.activeElement !== control || !control.isConnected || !diagnosticDraftCurrent(drafts, key, focus, true)) { onDiagnosticFocus?.(focus.id, false); return; }
    control.setSelectionRange(selection.start, selection.end); onDiagnosticFocus?.(focus.id, true);
  });
  if (sourceFocus && active && complete) return <Field label={t("editorDiagnosticSourceLabel", { key: summary.content.nativeKey })} description={t("editorDiagnosticSourceHelp")}>
    <TextArea ref={field} rows={4} readOnly value={textareaDisplayText(current.sourceText)}
      onFocus={() => gate.setInputOwner(viewId, ownerId)} onBlur={() => { reject(); gate.releaseOwner(ownerId); }}
      onCompositionStart={() => { reject(); gate.setComposing(ownerId, true); }} onCompositionEnd={() => gate.setComposing(ownerId, false)}/>
  </Field>;
  if (comparison) return <div className={styles.sourceVersions}>
    <div className={styles.previousVersion} data-source-version="previous">
      <span className={styles.versionLabel}>{t("sourceComparisonPrevious")}</span>
      {comparison.old === null ? <span className={styles.meta}>{t("sourceComparisonNoPrevious")}</span>
        : <><TokenizedText text={comparison.old.text} />{comparison.old.text === "" ? <span className={styles.meta}>{t("sourceComparisonEmptyText")}</span> : null}</>}
    </div>
    <div data-source-version="current">
      <span className={styles.versionLabel}>{t("sourceComparisonCurrent")}</span>
      <TokenizedText text={comparison.current.text} />{comparison.current.text === "" ? <span className={styles.meta}>{t("sourceComparisonEmptyText")}</span> : null}
    </div>
  </div>;
  return <><TokenizedText text={complete ? current.sourceText : summary.content.sourcePreview} />{summary.sourceTruncated && !complete ? <span title={t("textShortened")}>…</span> : null}</>;
}

const EntryContent = memo(function EntryContent({ summary, active, focused, projectId, sourceLocale, locale, viewId, drafts, gate, disabled, dispatch, editorRef, comparison, renderCandidate, onDetails, diagnosticFocus, diagnosticCurrent, onDiagnosticFocus }: {
  summary: SegmentRow; active: boolean; focused: boolean; projectId: string; sourceLocale: string; locale: string; viewId: string;
  drafts: TranslationDrafts | null; gate: InteractionGate; disabled: boolean; dispatch: SegmentEditorProps["dispatch"]; editorRef: Ref<SegmentEditorHandle>;
  comparison: SourceVersionComparison | undefined; renderCandidate: EntriesTableProps["renderCandidate"]; onDetails: EntriesTableProps["onDetails"];
  diagnosticFocus?: EntryDiagnosticFocus | null; diagnosticCurrent?: () => boolean; onDiagnosticFocus?: (id: string, applied: boolean) => void;
}) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const row = summary.content;
  const [copyResult, setCopyResult] = useState<{ key: string; result: "copied" | "failed" } | null>(null);
  const copySequence = useRef(0);
  useEffect(() => () => { copySequence.current++; }, [row.nativeKey]);
  async function copyKey() {
    if (disabled || !gate.canDispatch({ viewId, source: "button" })) return;
    const key = row.nativeKey, ticket = ++copySequence.current;
    setCopyResult(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(key);
      if (copySequence.current === ticket) setCopyResult({ key, result: "copied" });
    } catch {
      if (copySequence.current === ticket) setCopyResult({ key, result: "failed" });
    }
  }
  return <>
    <div className={styles.source} lang={sourceLocale}><EntrySource summary={summary} active={active} drafts={drafts} projectId={projectId} locale={locale} comparison={comparison}
      diagnosticFocus={active && focused ? diagnosticFocus : null} diagnosticCurrent={diagnosticCurrent} onDiagnosticFocus={onDiagnosticFocus} gate={gate} viewId={viewId} disabled={disabled}/>
      <div className={styles.sourceActions}>{focused ? <Button size="xs" className={styles.key} disabled={disabled}
        aria-label={t("copyEntryKey", { key: row.nativeKey })} title={t("copyEntryKey", { key: row.nativeKey })} lang={i18n.resolvedLanguage}
        onClick={() => { void copyKey(); }}><span lang={sourceLocale}>{row.nativeKey}</span></Button> : null}
        <IconButton size="xs" label={t("showEntryDetails", { key: row.nativeKey })} onClick={() => onDetails(row.unitId)}><MoreHorizontal /></IconButton>
      </div>
      {focused && copyResult?.key === row.nativeKey ? <p className={styles.copyResult} role="status" lang={i18n.resolvedLanguage}>{t(copyResult.result === "copied" ? "entryKeyCopied" : "entryKeyCopyFailed")}</p> : null}
    </div>
    <div className={styles.target} lang={locale}>{active && drafts
      ? <SegmentEditor ref={editorRef} drafts={drafts} draftKey={{ projectId, unitId: row.unitId, locale }} viewId={viewId} gate={gate} disabled={disabled} nativeKey={row.nativeKey} dispatch={dispatch}
        autoFocus={!diagnosticFocus} diagnosticFocus={diagnosticFocus} diagnosticCurrent={diagnosticCurrent} onDiagnosticFocus={onDiagnosticFocus}/>
      : row.translationPreview === null ? <span className={styles.meta}>{t("noTranslation")}</span>
        : <><TokenizedText text={row.translationPreview} />{summary.translationTruncated ? <span title={t("textShortened")}>…</span> : null}</>}
      {focused && renderCandidate ? renderCandidate(summary) : null}
    </div>
  </>;
});

/** Backend pages bound the data; this viewport bounds the mounted row DOM. */
export default function EntriesTable({ rows, firstPosition, total, projectId, sourceLocale, view, drafts, gate, disabled, dispatch, scroll, selectedIds, onScroll, onEdit, onDetails, onMove, onSelection, canSelect, sourceComparison, diagnosticFocus, diagnosticCurrent, onDiagnosticFocus, renderCandidate, footer, ref }: EntriesTableProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const rangeId = useId(), listOwner = `entry-list-${view.id}`;
  const viewport = useRef<HTMLDivElement>(null), activeEditor = useRef<SegmentEditorHandle>(null);
  const rowElements = useRef(new Map<string, HTMLElement>()), pendingFocus = useRef<string | null>(null);
  const composing = useRef(new Set<string>()), measuredHeights = useRef(new Map<string, number>());
  const [focusedId, setFocusedId] = useState<string | null>(null), [compositionRevision, setCompositionRevision] = useState(0);
  const activeId = view.editing ? view.focus : null;
  const sourceByUnit = useMemo(() => new Map(sourceComparison?.rows.map(row => [row.unitId, row])), [sourceComparison]);
  const activeIndex = rows.findIndex(row => row.content.unitId === activeId);
  const focusedIndex = rows.findIndex(row => row.content.unitId === focusedId);
  const getItemKey = useCallback((index: number) => rows[index].content.unitId, [rows]);
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(view.focusMode ? [] : defaultRangeExtractor(range));
    if (activeIndex >= 0) indexes.add(activeIndex);
    if (focusedIndex >= 0) indexes.add(focusedIndex);
    rows.forEach((row, index) => { if (composing.current.has(row.content.unitId)) indexes.add(index); });
    return [...indexes].sort((a, b) => a - b);
  }, [rows, activeIndex, focusedIndex, view.focusMode, compositionRevision]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length, getScrollElement: () => viewport.current, getItemKey,
    estimateSize: () => estimatedRowHeight, overscan: 3, rangeExtractor, initialOffset: scroll.top, enabled: !view.entryPageMode,
    // Hidden focus-mode siblings keep their last measurement until shown again.
    measureElement: (element, entry) => {
      const unitId = element.dataset.unitId ?? "";
      if (element.hidden) return measuredHeights.current.get(unitId) ?? estimatedRowHeight;
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
      if (height > 0) measuredHeights.current.set(unitId, height);
      return height > 0 ? height : measuredHeights.current.get(unitId) ?? estimatedRowHeight;
    },
  });
  const restoration = JSON.stringify([view.id, view.focusMode, view.entryPageMode, scroll.top, scroll.left]);
  const restoredPosition = useRef(restoration), restoringPosition = useRef(true);
  if (restoredPosition.current !== restoration) {
    restoredPosition.current = restoration; restoringPosition.current = true;
  }
  // Let the initial visible range finish measuring before enabling ordinary
  // height anchoring, so estimates cannot move an explicitly restored offset.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = restoringPosition.current ? () => false : undefined;
  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  // A zero-size viewport can occur before layout or while its workspace is hidden.
  // Keep only the initial/pinned rows available until an actual range is measured.
  const fallbackIndexes = new Set<number>();
  if (!virtualItems.length && rows.length) {
    fallbackIndexes.add(0);
    if (activeIndex >= 0) fallbackIndexes.add(activeIndex);
    if (focusedIndex >= 0) fallbackIndexes.add(focusedIndex);
    rows.forEach((row, index) => { if (composing.current.has(row.content.unitId)) fallbackIndexes.add(index); });
  }
  const items = view.entryPageMode ? rows.map((_, index) => ({ index, start: 0 }))
    : virtualItems.length ? virtualItems : [...fallbackIndexes].sort((a, b) => a - b).map(index => virtualizer.measurementsCache[index]);
  const selected = new Set(selectedIds);
  const firstVisible = view.focusMode && activeIndex >= 0 ? activeIndex : view.entryPageMode ? 0 : virtualizer.range?.startIndex ?? 0;
  const lastVisible = view.focusMode && activeIndex >= 0 ? activeIndex : view.entryPageMode ? rows.length - 1 : virtualizer.range?.endIndex ?? 0;
  const focusSize = activeIndex >= 0 ? virtualizer.measurementsCache[activeIndex]?.size ?? estimatedRowHeight : 0;

  const focusPendingRow = useCallback(() => {
    const unitId = pendingFocus.current;
    if (unitId === null || view.focusMode && unitId !== activeId) return;
    const index = rows.findIndex(row => row.content.unitId === unitId);
    if (index < 0) return;
    if (!view.entryPageMode) virtualizer.scrollToIndex(index, { align: "auto" });
    const element = rowElements.current.get(unitId);
    if (element) {
      pendingFocus.current = null;
      if (view.entryPageMode) element.scrollIntoView({ block: "nearest", inline: "nearest" });
      element.focus({ preventScroll: true });
    }
  }, [rows, virtualizer, view.focusMode, view.entryPageMode, activeId]);
  useImperativeHandle(ref, () => ({
    focusEditor: () => activeEditor.current?.focus(),
    focusRow: unitId => {
      restoringPosition.current = false; virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
      pendingFocus.current = unitId; setFocusedId(unitId); focusPendingRow();
    },
  }), [focusPendingRow]);
  useLayoutEffect(focusPendingRow, [focusPendingRow, focusedId]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !restoringPosition.current) return;
    element.scrollTop = view.focusMode ? 0 : scroll.top;
    element.scrollLeft = view.focusMode ? 0 : scroll.left;
    const frame = requestAnimationFrame(() => {
      restoringPosition.current = false; virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [view.focusMode, scroll.top, scroll.left, restoration, totalSize, virtualizer]);
  useEffect(() => () => gate.releaseOwner(listOwner), [gate, listOwner]);

  function navigateRow(event: KeyboardEvent<HTMLElement>, unitId: string) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target !== event.currentTarget && !target.hasAttribute("data-entry-navigation")) return;
    if (disabled || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || composing.current.size
      || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || window.getSelection()?.isCollapsed === false
      || !gate.canDispatch({ viewId: view.id, source: "keyboard", inputOwner: listOwner })) return;
    const direction = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (direction) { event.preventDefault(); onMove(direction, unitId); }
    else if (event.key === "Enter" && drafts) { event.preventDefault(); onEdit(unitId); }
  }

  return <div className={styles.table}>
    <div className={styles.tableHeader} aria-hidden="true"><span>{t("row")}</span><span>{t("entryStatusColumn")}</span><span>{t(view.compareSource ? "sourceComparisonColumn" : "source", { locale: sourceLocale })}</span><span>{t("translation", { locale: view.locale })}</span></div>
    <div className={styles.scroll} ref={viewport} role="region" aria-label={t("entriesTableLabel")} aria-describedby={rangeId}
    onScroll={event => { if (!view.focusMode) onScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }); }}>
    <p className={styles.range} id={rangeId}>{t("entriesVisibleRange", { first: String(rows.length ? firstPosition + firstVisible + 1 : 0), last: String(rows.length ? firstPosition + lastVisible + 1 : 0), total: String(total) })}</p>
    <div className={styles.rows} data-page-mode={view.entryPageMode || undefined} role="list" aria-label={t("entriesTableLabel")} aria-describedby={rangeId} style={{ height: view.entryPageMode ? undefined : view.focusMode ? focusSize : totalSize }}>
      {items.map(item => {
        const summary = rows[item.index], row = summary.content, active = row.unitId === activeId;
        return <article key={row.unitId} ref={element => {
          if (element) { rowElements.current.set(row.unitId, element); if (!view.entryPageMode) virtualizer.measureElement(element); }
          else { rowElements.current.delete(row.unitId); virtualizer.measureElement(null); }
        }} role="listitem" aria-label={row.nativeKey} aria-posinset={firstPosition + item.index + 1} aria-setsize={total}
          aria-current={view.focus === row.unitId ? "true" : undefined} tabIndex={view.focus === row.unitId || view.focus === null && item.index === 0 ? 0 : -1}
          data-index={item.index} data-unit-id={row.unitId} data-selected={view.focus === row.unitId || undefined}
          hidden={view.focusMode && !active} className={styles.entry} style={{ transform: view.entryPageMode ? undefined : `translateY(${view.focusMode ? 0 : item.start}px)` }}
          onFocusCapture={event => {
            setFocusedId(row.unitId);
            if (event.target === event.currentTarget || event.target instanceof HTMLElement && event.target.hasAttribute("data-entry-navigation")) gate.setInputOwner(view.id, listOwner);
          }}
          onBlurCapture={event => {
            if (composing.current.delete(row.unitId)) setCompositionRevision(revision => revision + 1);
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setFocusedId(current => current === row.unitId ? null : current);
            gate.releaseOwner(listOwner);
          }}
          onCompositionStartCapture={() => { composing.current.add(row.unitId); setCompositionRevision(revision => revision + 1); }}
          onCompositionEndCapture={() => { composing.current.delete(row.unitId); setCompositionRevision(revision => revision + 1); }}
          onKeyDown={event => navigateRow(event, row.unitId)}>
          <div className={styles.entryNumber}>
            <Button size="xs" data-entry-navigation aria-label={t("entryEdit", { key: row.nativeKey })} disabled={disabled || !drafts} onClick={() => onEdit(row.unitId)}>{firstPosition + item.index + 1}</Button>
            <label className={styles.selection}><input type="checkbox" checked={selected.has(row.unitId)} disabled={disabled || !canSelect(row.unitId)} onChange={event => onSelection(row.unitId, event.currentTarget.checked)} /><span className={styles.range}>{t("entrySelect", { key: row.nativeKey })}</span></label>
          </div>
          <div className={styles.entryStatus}><EntryStatus row={summary} projectId={projectId} drafts={drafts} /></div>
          <EntryContent summary={summary} active={active} focused={view.focus === row.unitId} projectId={projectId} sourceLocale={sourceLocale} locale={view.locale} viewId={view.id}
            drafts={drafts} gate={gate} disabled={disabled} dispatch={dispatch} editorRef={activeEditor}
            comparison={view.compareSource ? sourceByUnit.get(row.unitId) : undefined} renderCandidate={renderCandidate} onDetails={onDetails}
            diagnosticFocus={active && diagnosticFocus?.unitId === row.unitId && diagnosticFocus.locale === view.locale ? diagnosticFocus : null}
            diagnosticCurrent={diagnosticCurrent} onDiagnosticFocus={onDiagnosticFocus}/>
        </article>;
      })}
    </div>
    {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  </div>;
}
