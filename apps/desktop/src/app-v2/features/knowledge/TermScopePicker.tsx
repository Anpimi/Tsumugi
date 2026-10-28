import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextInput } from "../../../design-system/Field";
import { EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import { segmentCommands, type SegmentPage } from "../../../segmentCommands";
import { sourceCommands } from "../../../sourceCommands";
import type { ProjectView } from "../../../projectCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import styles from "./Knowledge.module.css";

export default function TermScopePicker({ project, locale, disabled, gate, current, onSelect }: {
  project: ProjectView; locale: string; disabled: boolean; gate: InteractionGate;
  current: (dialogId?: string) => boolean; onSelect: (unitId: string) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const [open, setOpen] = useState(false), [input, setInput] = useState(""), [search, setSearch] = useState("");
  const [page, setPage] = useState<{ scope: SegmentPage; cursor: string } | null>(null);
  const dialogId = useId(), session = executionContext(project), reads = useSessionReads();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  useLayoutEffect(() => open ? gate.pushDialog(dialogId) : undefined, [open, gate, dialogId]);
  useEffect(() => { if (!open) gate.releaseOwner(dialogId); return () => gate.releaseOwner(dialogId); }, [open, gate, dialogId]);
  const query = { text: search, selection: "all" as const, status: "all" as const };
  const firstKey = ["knowledge-scope-search", locale, search], nextKey = ["knowledge-scope-search-page", locale, search, page?.scope.scopeId, page?.cursor];
  const sourceKey = ["resource-source-scope"];
  const source = useSessionQuery({ key: sourceKey, scopes: ["source"], enabled: open && !disabled, read: () => sourceCommands.scope(session) });
  const first = useSessionQuery({ key: firstKey, scopes: ["source", "translation", "review", "resources"], enabled: open && !disabled,
    read: () => segmentCommands.page({ ...session, locale, query, scopeId: null, cursor: null, limit: 50 }) });
  const next = useSessionQuery({ key: nextKey, scopes: ["source", "translation", "review", "resources"], enabled: open && !disabled && !!page,
    read: async () => {
      if (!page) throw new Error("A fixed entry page is required");
      const result = await segmentCommands.page({ ...session, locale, query, scopeId: page.scope.scopeId, cursor: page.cursor, limit: 50 });
      if (result.readVersion !== page.scope.readVersion || result.queryFingerprint !== page.scope.queryFingerprint || result.sourceSnapshotId !== page.scope.sourceSnapshotId) throw new Error("Entry scope changed");
      return result;
    } });
  const read = page ? next : first, data = read.data;
  const matches = !!data && data.projectId === session.projectId && data.locale === locale && data.query.text === search && data.query.selection === "all" && (data.query.status ?? "all") === "all"
    && data.sourceSnapshotId === source.data?.currentSnapshot && (!page || data.scopeId === page.scope.scopeId && data.readVersion === page.scope.readVersion && data.queryFingerprint === page.scope.queryFingerprint
      && first.data?.readVersion === page.scope.readVersion && first.data?.queryFingerprint === page.scope.queryFingerprint && first.data?.sourceSnapshotId === page.scope.sourceSnapshotId);
  function available() {
    const fresh = (key: readonly unknown[]) => { const state = reads.client.getQueryState(reads.key(key)); return state?.status === "success" && !state.isInvalidated && state.fetchStatus === "idle"; };
    return !disabled && current(dialogId) && input === search && matches && !read.isStale && !first.isStale && !source.isStale && fresh(page ? nextKey : firstKey) && fresh(firstKey) && fresh(sourceKey);
  }
  function refresh() { if (disabled || !current(dialogId)) return; setPage(null); void Promise.all([first.refetch(), source.refetch()]); }
  return <>
    <Button disabled={disabled} onClick={() => { if (current()) { setPage(null); setOpen(true); } }}>{t("chooseEntry")}</Button>
    <Dialog open={open} onOpenChange={next => { if (next || gate.getSnapshot().composingOwners.length === 0) setOpen(next); }} title={t("chooseEntry")} description={t("scopePickerHelp")} closeLabel={t("close")}>
      <div onFocusCapture={() => gate.setInputOwner(gate.getSnapshot().visibleViewId, dialogId)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.setInputOwner(gate.getSnapshot().visibleViewId, null); }}
        onCompositionStartCapture={() => gate.setComposing(dialogId, true)} onCompositionEndCapture={() => gate.setComposing(dialogId, false)}>
      <form className={styles.actions} onSubmit={event => { event.preventDefault(); if (disabled || !current(dialogId)) return; if (input === search) refresh(); else { setPage(null); setSearch(input); } }}>
        <Field label={t("searchEntries")}><TextInput value={input} disabled={disabled} onChange={event => setInput(event.target.value)}/></Field>
        <Button type="submit" disabled={disabled}>{t("search")}</Button>
      </form>
      {read.isFetching || first.isFetching || source.isFetching ? <LoadingState label={t("readingEntries")}/> : read.error || first.error || source.error || data && !matches ? <ErrorState title={t("entriesFailed")} action={<Button onClick={refresh}>{t("refresh")}</Button>}/>
        : read.isStale || first.isStale || source.isStale ? <ErrorState title={t("entriesChanged")} action={<Button onClick={refresh}>{t("refresh")}</Button>}/>
        : data ? <><p>{t("entryMatches", { count: data.total })}</p><ul className={styles.scopeResults}>{data.rows.map(row => <li key={row.content.unitId}>
          <Button className={styles.scopeChoice} disabled={!available()} onClick={() => { if (available()) { onSelect(row.content.unitId); setOpen(false); } }}>
            <span>{row.content.nativeKey}</span><span className={styles.sourceText}>{row.content.sourcePreview}</span>
          </Button>
        </li>)}</ul>{data.rows.length === 0 ? <EmptyState title={t("noEntries")}/> : null}
          <div className={styles.actions}>{page ? <Button onClick={refresh}>{t("firstPage")}</Button> : null}
            {data.nextCursor ? <Button disabled={!available()} onClick={() => { if (available()) setPage({ scope: page?.scope ?? data, cursor: data.nextCursor! }); }}>{t("nextEntries")}</Button> : null}</div></> : null}
      </div>
    </Dialog>
  </>;
}
