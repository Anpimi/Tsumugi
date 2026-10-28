import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands } from "../../../resourceCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { contextSourceKey, useContextSource } from "./contextResourceReads";
import styles from "./Knowledge.module.css";

/** The original impact reader covers changes across the locale, not reference counts. */
export default function ContextResourceImpact({ project, locale, visible, current }: {
  project: ProjectView; locale: string; visible: boolean; current: () => boolean;
}) {
  const { t } = useTranslation(), reads = useSessionReads();
  const [open, setOpen] = useState(false), [cursor, setCursor] = useState<{ basis: string; offset: number } | null>(null);
  const { source } = useContextSource(project, visible && open);
  const basis = JSON.stringify([locale, source.data]), offset = cursor?.basis === basis ? cursor.offset : 0;
  const key = ["resource-impact", locale, offset, 50];
  const read = useSessionQuery({ key, scopes: ["source", "translation", "resources"], enabled: visible && open && !!source.data?.currentSnapshot && !source.error && !source.isFetching,
    read: () => resourceCommands.impacts({ ...executionContext(project), locale, offset, limit: 50 }) });
  function fresh() {
    const state = reads.client.getQueryState(reads.key(key)), sourceState = reads.client.getQueryState(reads.key(contextSourceKey));
    return !read.error && !read.isFetching && !!read.data && !source.error && !source.isFetching && !!source.data?.currentSnapshot
      && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated
      && sourceState?.status === "success" && sourceState.fetchStatus === "idle" && !sourceState.isInvalidated;
  }
  function refresh() {
    if (!current()) return;
    if (offset === 0) { void source.refetch(); void read.refetch(); }
    else setCursor({ basis, offset: 0 });
  }
  const page = fresh() ? read.data : null;
  return <section aria-label={t("knowledge.contextImpactTitle")}><h3>{t("knowledge.contextImpactTitle")}</h3><p>{t("knowledge.contextImpactHelp")}</p>
    {!open ? <Button onClick={() => { if (current()) setOpen(true); }}>{t("knowledge.contextReadImpact")}</Button> : <>
      {source.error || read.error ? <ErrorState title={t("knowledge.contextImpactFailed")} action={<Button onClick={refresh}>{t("knowledge.refresh")}</Button>}/>
        : source.isSuccess && !source.data.currentSnapshot ? <Banner tone="warning">{t("knowledge.contextNoSource")}</Banner>
        : source.isFetching || read.isFetching || !page ? <LoadingState label={t("knowledge.contextReading")}/> : null}
      {page ? <><p>{t("resource.affectedCount", { count: page.totalAffected })}</p><p>{t("resource.coverage")}</p>
        {page.items.length ? <ul className={styles.history}>{page.items.map(item => <li key={item.unitId}><h4>{item.nativeKey}</h4><p>{t(`resource.impactStatus.${item.status}`)}</p>
          <ul>{item.reasons.map(reason => <li key={reason.changeId}><p>{t(`resource.reasonKind.${reason.kind}`)} · {t(`resource.confidence.${reason.confidence}`)}</p>
            <p>{reason.oldValue ?? "—"} → {reason.newRemoved ? t(reason.kind === "context-resource" ? "knowledge.contextStopped" : reason.kind === "context-fact" ? "contextFacts.excluded" : "resource.removedValue") : reason.newValue}</p></li>)}</ul></li>)}</ul>
          : <EmptyState title={t("resource.noImpacts")}/>}
        <div className={styles.actions}><Button onClick={refresh}>{t("knowledge.refresh")}</Button><Button disabled={offset === 0} onClick={() => { if (current() && fresh()) setCursor({ basis, offset: 0 }); }}>{t("execution.firstPage")}</Button>
          <Button disabled={page.nextOffset === null} onClick={() => { if (current() && fresh() && page.nextOffset !== null) setCursor({ basis, offset: page.nextOffset }); }}>{t("execution.nextPage")}</Button></div>
      </> : null}
    </>}
  </section>;
}
