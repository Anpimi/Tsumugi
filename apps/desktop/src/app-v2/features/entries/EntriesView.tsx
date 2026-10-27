import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Layers, MoreHorizontal, RefreshCw, Search } from "lucide-react";
import type { ProjectView } from "../../../projectCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { Button, IconButton } from "../../../design-system/Button";
import { TextInput } from "../../../design-system/Field";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { WorkspaceView } from "../../workspace/workspaceStore";
import { captureEntries, entryPageKey, readEntryPage, type EntryCapture } from "./entryReads";
import styles from "../../WorkbenchLayout.module.css";

type Props = {
  project: ProjectView; view: WorkspaceView; disabled: boolean;
  patch: (value: Partial<WorkspaceView>) => void;
  navigate: (value: { query?: string; focus?: string | null }) => Promise<unknown>;
  ref?: Ref<EntriesHandle>;
};
export interface EntriesHandle { refresh: () => void; focusSearch: () => void }

export default function EntriesView({ project, view, disabled, patch, navigate, ref }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads();
  const [capture, setCapture] = useState<EntryCapture | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const request = useRef(0), scroll = useRef<HTMLDivElement>(null), restored = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const availableLocale = project.metadata.targetLocales.includes(view.locale);
  const scope = useSessionQuery({ key: ["workbench-source-scope"], scopes: ["source"], enabled: !disabled,
    refetchOnMount: false, read: () => sourceCommands.scope(reads.context) });

  async function captureCurrent(refresh = false) {
    const ticket = ++request.current;
    setCapturing(true); setCaptureError(false);
    try {
      const previous = reads.client.getQueryData<EntryCapture>(reads.key(["workbench-entry-capture", view.locale, view.query]));
      const next = await captureEntries(reads, view.locale, view.query, refresh);
      if (ticket !== request.current || reads.retired) return;
      setCapture(next);
      if (refresh || previous && previous.scopeId !== next.scopeId) patch({ afterOrdinal: 0 });
      restored.current = false;
    } catch { if (ticket === request.current && !reads.retired) setCaptureError(true); }
    finally { if (ticket === request.current) setCapturing(false); }
  }

  useEffect(() => {
    setCapture(null);
    if (availableLocale && scope.data?.currentSnapshot && !disabled) void captureCurrent();
    return () => { request.current++; };
  }, [view.locale, view.query, scope.data?.currentSnapshot, availableLocale, disabled]);

  const page = useSessionQuery({
    key: entryPageKey(view.locale, view.query, capture?.scopeId ?? "", view.afterOrdinal),
    scopes: ["source", "translation", "review", "resources"],
    enabled: !disabled && availableLocale && !!capture,
    refetchOnMount: query => query.state.isInvalidated,
    read: () => { if (!capture) throw new Error("No entry read scope"); return readEntryPage(reads, view.locale, view.query, capture.scopeId, view.afterOrdinal); },
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
  const loading = !failed && !empty && (scope.isPending || capturing || !!capture && page.isPending);
  const searchTooLong = new TextEncoder().encode(view.searchInput).length > 256;

  return <div className={styles.entryView}>
    <form className={styles.toolbar} aria-label={t("searchEntries")} onSubmit={event => {
      event.preventDefault();
      if (!disabled && new TextEncoder().encode(view.searchInput).length <= 256) void navigate({ query: view.searchInput, focus: null });
    }}>
      <Button size="sm" disabled>{t("allEntries")}<ChevronDown /></Button>
      <div className={styles.toolbarSearch}><Search /><TextInput ref={searchInput} aria-label={t("searchEntries")} aria-invalid={searchTooLong || undefined} aria-describedby={searchTooLong ? "entry-search-error" : undefined} placeholder={t("searchPlaceholder")} value={view.searchInput}
        onChange={event => patch({ searchInput: event.target.value })} disabled={disabled} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); event.stopPropagation(); } }} /></div>
      <Button type="submit" size="sm" disabled={disabled || searchTooLong}>{t("search")}</Button>
      <IconButton label={t("refresh")} disabled={disabled || capturing} onClick={() => { void scope.refetch(); if (scope.data?.currentSnapshot) void captureCurrent(true); }}><RefreshCw /></IconButton>
      {currentPage ? <span className={styles.count}>{t("entryCount", { count: currentPage.total })}</span> : null}
    </form>
    {searchTooLong ? <Banner id="entry-search-error" tone="error">{t("searchTooLong")}</Banner> : null}
    <div className={styles.scroll} ref={scroll} onScroll={event => patch({ scroll: { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft } })}>
      <Banner>{t("readOnly")}</Banner>
      {!availableLocale ? <ErrorState title={t("languageMissing")} description={t("chooseLanguage")} /> : failed ? <ErrorState title={t("readFailed")} description={t("readFailedHelp")} action={<Button onClick={() => { void scope.refetch(); if (scope.data?.currentSnapshot) void captureCurrent(true); }}>{t("refresh")}</Button>} /> : empty ? <EmptyState icon={<Layers />} title={t("noSource")} description={t("noSourceHelp")} /> : loading || !currentPage ? <LoadingState label={t("loadingEntries")} /> : currentPage.rows.length === 0 ? <EmptyState icon={<Search />} title={t("noMatches")} description={t("noMatchesHelp")} /> : <div className={styles.table}>
        <div className={styles.tableHeader}><span>{t("row")}</span><span>{t("detail")}</span><span>{t("source", { locale: project.metadata.sourceLocale })}</span><span>{t("translation", { locale: view.locale })}</span></div>
        {currentPage.rows.map((row, index) => <article key={row.unitId} className={styles.entry} data-selected={view.focus === row.unitId || undefined}>
          <div className={styles.entryNumber}><Button size="xs" aria-label={t("openEntry", { key: row.nativeKey })} onClick={() => { patch({ selection: [row.unitId], dock: "details" }); void navigate({ focus: row.unitId }); }}>{index + 1}</Button></div>
          <div className={styles.entryStatus}><IconButton label={t("showEntryDetails", { key: row.nativeKey })} onClick={() => { patch({ dock: "details", selection: [row.unitId] }); void navigate({ focus: row.unitId }); }}><MoreHorizontal /></IconButton></div>
          <div className={styles.source}><TokenizedText text={row.sourcePreview} />{view.focus === row.unitId ? <div className={styles.entryMeta}><span className={styles.key}>{row.nativeKey}</span></div> : null}</div>
          <div className={styles.target}>{row.translationPreview === null ? <span className={styles.meta}>{t("noTranslation")}</span> : <TokenizedText text={row.translationPreview} />}</div>
        </article>)}
        <div className={styles.actions}>
          {view.afterOrdinal > 0 ? <Button onClick={() => { restored.current = false; patch({ afterOrdinal: 0, scroll: { top: 0, left: 0 } }); }}>{t("firstPage")}</Button> : null}
          {currentPage.nextOrdinal !== null ? <Button onClick={() => { restored.current = false; patch({ afterOrdinal: currentPage.nextOrdinal ?? 0, scroll: { top: 0, left: 0 } }); }}>{t("nextPage")}</Button> : null}
        </div>
      </div>}
    </div>
  </div>;
}
