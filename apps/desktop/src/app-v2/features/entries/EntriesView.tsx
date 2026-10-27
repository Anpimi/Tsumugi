import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Layers, MoreHorizontal, RefreshCw, Search } from "lucide-react";
import type { ProjectView } from "../../../projectCommands";
import { isCommandError } from "../../../projectCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { Button, IconButton } from "../../../design-system/Button";
import { TextInput } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { SegmentQuery } from "../../../segmentCommands";
import type { WorkspaceView } from "../../workspace/workspaceStore";
import { captureEntries, entryPageKey, entrySelectionFilter, readEntryPage, type EntryCapture } from "./entryReads";
import styles from "../../WorkbenchLayout.module.css";

type Props = {
  project: ProjectView; view: WorkspaceView; disabled: boolean;
  patch: (value: Partial<WorkspaceView>) => void;
  navigate: (value: { query?: string; preset?: string; focus?: string | null }) => Promise<unknown>;
  ref?: Ref<EntriesHandle>;
};
export interface EntriesHandle { refresh: () => void; focusSearch: () => void }

export default function EntriesView({ project, view, disabled, patch, navigate, ref }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads();
  const [captured, setCaptured] = useState<{ locale: string; query: SegmentQuery; scope: EntryCapture } | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const request = useRef(0), scroll = useRef<HTMLDivElement>(null), restored = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const availableLocale = project.metadata.targetLocales.includes(view.locale);
  const selection = entrySelectionFilter(view.preset);
  const query = { text: view.query, selection: selection ?? "all" as const };
  const scope = useSessionQuery({ key: ["workbench-source-scope"], scopes: ["source"], enabled: !disabled,
    refetchOnMount: false, read: () => sourceCommands.scope(reads.context) });
  // A new filter must never send the previous filter's scope before effects settle.
  const capture = captured?.locale === view.locale && captured.query.text === view.query && captured.query.selection === selection
    && captured.scope.snapshotId === scope.data?.currentSnapshot ? captured.scope : null;

  async function captureCurrent(refresh = false) {
    if (!selection) return;
    const ticket = ++request.current;
    setCapturing(true); setCaptureError(false);
    try {
      const previous = reads.client.getQueryData<EntryCapture>(reads.key(["workbench-entry-capture", view.locale, query]));
      const next = await captureEntries(reads, view.locale, query, refresh);
      if (ticket !== request.current || reads.retired) return;
      setCaptured({ locale: view.locale, query, scope: next });
      if (refresh || previous && previous.scopeId !== next.scopeId) patch({ afterOrdinal: 0, cursor: null });
      restored.current = false;
    } catch { if (ticket === request.current && !reads.retired) setCaptureError(true); }
    finally { if (ticket === request.current) setCapturing(false); }
  }

  useEffect(() => {
    setCaptured(null);
    if (availableLocale && selection && scope.data?.currentSnapshot && !disabled) void captureCurrent();
    return () => { request.current++; };
  }, [view.locale, view.query, selection, scope.data?.currentSnapshot, availableLocale, disabled]);

  const page = useSessionQuery({
    key: entryPageKey(view.locale, query, capture ?? { scopeId: "", snapshotId: "", queryFingerprint: "", readVersion: "" }, view.cursor),
    scopes: ["source", "translation", "review", "resources"],
    enabled: !disabled && availableLocale && !!selection && !!capture,
    refetchOnMount: query => query.state.isInvalidated,
    read: () => { if (!capture) throw new Error("No entry read scope"); return readEntryPage(reads, view.locale, query, capture, view.cursor); },
  });
  const currentPage = !page.error && page.data?.scopeId === capture?.scopeId ? page.data : null;
  useImperativeHandle(ref, () => ({ refresh() { void scope.refetch(); if (scope.data?.currentSnapshot) void captureCurrent(true); }, focusSearch() { searchInput.current?.focus(); } }));
  useLayoutEffect(() => {
    if (currentPage && !restored.current && scroll.current) {
      scroll.current.scrollTop = view.scroll.top; scroll.current.scrollLeft = view.scroll.left; restored.current = true;
    }
  }, [currentPage, view.scroll]);
  const empty = scope.isSuccess && !scope.data.currentSnapshot;
  const failed = scope.isError || captureError || page.isError;
  const stalePage = isCommandError(page.error) && page.error.code === "dependency-conflict";
  const loading = !failed && !empty && (scope.isPending || capturing || !!capture && page.isPending);
  const searchTooLong = new TextEncoder().encode(view.searchInput).length > 256;

  return <div className={styles.entryView}>
    <form className={styles.toolbar} aria-label={t("searchEntries")} onSubmit={event => {
      event.preventDefault();
      if (!disabled && new TextEncoder().encode(view.searchInput).length <= 256) void navigate({ query: view.searchInput, focus: null });
    }}>
      <Menu label={t("entryFilter")} trigger={<Button size="sm" disabled={disabled}>{t(selection === "selected" ? "selectedEntries" : selection === "unselected" ? "unselectedEntries" : selection === "all" ? "allEntries" : "filterMissing")}<ChevronDown /></Button>} items={(["all", "selected", "unselected"] as const).map(id => ({ id, label: t(id === "all" ? "allEntries" : id === "selected" ? "selectedEntries" : "unselectedEntries"), onSelect: () => void navigate({ preset: id, focus: null }) }))} />
      <div className={styles.toolbarSearch}><Search /><TextInput ref={searchInput} aria-label={t("searchEntries")} aria-invalid={searchTooLong || undefined} aria-describedby={searchTooLong ? "entry-search-error" : undefined} placeholder={t("searchPlaceholder")} value={view.searchInput}
        onChange={event => patch({ searchInput: event.target.value })} disabled={disabled} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); event.stopPropagation(); } }} /></div>
      <Button type="submit" size="sm" disabled={disabled || searchTooLong}>{t("search")}</Button>
      <IconButton label={t("refresh")} disabled={disabled || capturing} onClick={() => { void scope.refetch(); if (scope.data?.currentSnapshot) void captureCurrent(true); }}><RefreshCw /></IconButton>
      {currentPage ? <span className={styles.count}>{t("entryCount", { count: currentPage.total })}</span> : null}
    </form>
    {searchTooLong ? <Banner id="entry-search-error" tone="error">{t("searchTooLong")}</Banner> : null}
    <div className={styles.scroll} ref={scroll} onScroll={event => patch({ scroll: { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft } })}>
      <Banner>{t("readOnly")}</Banner>
      {!selection ? <ErrorState title={t("filterMissing")} description={t("chooseFilter")} /> : !availableLocale ? <ErrorState title={t("languageMissing")} description={t("chooseLanguage")} /> : failed ? <ErrorState title={t("readFailed")} description={t(stalePage ? "viewChanged" : "readFailedHelp")} action={<Button onClick={() => { void scope.refetch(); if (scope.data?.currentSnapshot) void captureCurrent(true); }}>{t("refresh")}</Button>} /> : empty ? <EmptyState icon={<Layers />} title={t("noSource")} description={t("noSourceHelp")} /> : loading || !currentPage ? <LoadingState label={t("loadingEntries")} /> : currentPage.rows.length === 0 ? <EmptyState icon={<Search />} title={t("noMatches")} description={t("noMatchesHelp")} /> : <div className={styles.table}>
        <div className={styles.tableHeader}><span>{t("row")}</span><span>{t("detail")}</span><span>{t("source", { locale: project.metadata.sourceLocale })}</span><span>{t("translation", { locale: view.locale })}</span></div>
        {currentPage.rows.map(({ content: row, sourceTruncated, translationTruncated }, index) => <article key={row.unitId} className={styles.entry} data-selected={view.focus === row.unitId || undefined}>
          <div className={styles.entryNumber}><Button size="xs" aria-label={t("openEntry", { key: row.nativeKey })} onClick={() => { patch({ selection: [row.unitId], dock: "details" }); void navigate({ focus: row.unitId }); }}>{view.afterOrdinal + index + 1}</Button></div>
          <div className={styles.entryStatus}><IconButton label={t("showEntryDetails", { key: row.nativeKey })} onClick={() => { patch({ dock: "details", selection: [row.unitId] }); void navigate({ focus: row.unitId }); }}><MoreHorizontal /></IconButton></div>
          <div className={styles.source}><TokenizedText text={row.sourcePreview} />{sourceTruncated ? <span title={t("textShortened")}>…</span> : null}{view.focus === row.unitId ? <div className={styles.entryMeta}><span className={styles.key}>{row.nativeKey}</span></div> : null}</div>
          <div className={styles.target}>{row.translationPreview === null ? <span className={styles.meta}>{t("noTranslation")}</span> : <><TokenizedText text={row.translationPreview} />{translationTruncated ? <span title={t("textShortened")}>…</span> : null}</>}</div>
        </article>)}
        <div className={styles.actions}>
          {view.cursor !== null ? <Button onClick={() => { restored.current = false; patch({ afterOrdinal: 0, cursor: null, scroll: { top: 0, left: 0 } }); }}>{t("firstPage")}</Button> : null}
          {currentPage.nextCursor !== null ? <Button onClick={() => { restored.current = false; patch({ afterOrdinal: view.afterOrdinal + currentPage.rows.length, cursor: currentPage.nextCursor, scroll: { top: 0, left: 0 } }); }}>{t("nextPage")}</Button> : null}
        </div>
      </div>}
    </div>
  </div>;
}
