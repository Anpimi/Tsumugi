import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { useSessionInfiniteQuery, useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type TermRevision } from "../../../resourceCommands";
import type { KnowledgeOwner } from "./knowledgeTypes";
import { knowledgeBlocked } from "./knowledgeState";
import { knowledgeCurrentKey, useKnowledgeCurrent, useKnowledgeScope } from "./knowledgeReads";
import styles from "./Knowledge.module.css";

export default function KnowledgeDetails({ project, owner, visible, disabled, current }: {
  project: ProjectView; owner: KnowledgeOwner; visible: boolean; disabled: boolean; current: () => boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const term = owner.state.selectedTerm, locale = owner.state.locale, session = executionContext(project), reads = useSessionReads();
  const currentTerm = useKnowledgeCurrent(project, locale, term?.termId ?? null, visible);
  const saved = currentTerm.data;
  const fresh = currentTerm.isSuccess && !currentTerm.isFetching && !currentTerm.error;
  const changed = fresh && !!saved && saved.revisionId !== term?.revisionId;
  const history = useSessionInfiniteQuery<TermRevision[], number>({ key: ["knowledge-term-history", term?.termId, 100], scopes: ["resources"], enabled: visible && !!term,
    initialPageParam: 0, nextPage: (last, _pages, offset) => last.length === 100 ? offset + 100 : undefined,
    read: async offset => {
      if (!term) throw new Error("A term is required");
      const rows = await resourceCommands.termHistory({ ...session, termId: term.termId, offset, limit: 100 });
      if (rows.length > 100 || rows.some(row => row.termId !== term.termId || row.locale !== locale)) throw new Error("Invalid term history association");
      return rows;
    } });
  const scope = useKnowledgeScope(project, locale, term?.scopeUnitId ?? null, visible && !!term);
  const [origin, setOrigin] = useState<{ termId: string; captureId: string } | null>(null);
  const captureId = origin && term && origin.termId === term.termId ? origin.captureId : term?.captureId;
  const provenance = useSessionQuery({ key: ["knowledge-term-origin", captureId], scopes: ["resources"], enabled: visible && !!captureId,
    read: () => {
      if (!captureId) throw new Error("A saved source is required");
      return resourceCommands.preview({ ...session, captureId });
    } });
  function adoptBasis() {
    const state = reads.client.getQueryState(reads.key(knowledgeCurrentKey(term?.termId ?? null, locale)));
    if (!term || !saved || !current() || disabled || knowledgeBlocked(owner) || !fresh || state?.isInvalidated || state?.fetchStatus !== "idle") return;
    owner.adoptTerm(saved, term.revisionId, owner.state.termSeq);
  }
  if (!term) return <EmptyState title={t("chooseTerm")} description={t("detailsHelp")}/>;
  const original = provenance.data?.capture.origin;
  return <section className={styles.details} aria-label={t("termDetails")}>
    <h2>{term.source}</h2><p className={styles.meta}>{t("savedBasis")}</p>
    <dl><dt>{t("targetTerm")}</dt><dd>{term.target}</dd><dt>{t("aliases")}</dt><dd>{term.aliases.length ? term.aliases.join(", ") : t("none")}</dd>
      <dt>{t("scope")}</dt><dd>{term.scopeUnitId ? scope.data && !scope.error && !scope.isFetching ? scope.data.nativeKey : t("entryScope") : t("projectScope")}</dd>
      <dt>{t("source")}</dt><dd>{t(term.originKind === "manual" ? "manual" : "imported")}</dd><dt>{t("reason")}</dt><dd>{term.reason}</dd>
      <dt>{t("protected")}</dt><dd>{t(term.protected ? "yes" : "no")}</dd><dt>{t("references")}</dt><dd>{t("unknownCount")}</dd></dl>
    <p className={styles.meta}>{t("referencesUnknown")}</p>
    {term.scopeUnitId && scope.error ? <Banner tone="warning" action={<Button onClick={() => void scope.refetch()}>{t("refresh")}</Button>}>{t("scopeUnavailable")}</Banner> : null}
    {currentTerm.error ? <Banner tone="warning" action={<Button onClick={() => void currentTerm.refetch()}>{t("refresh")}</Button>}>{t("currentFailed")}</Banner> : null}
    {fresh && saved === null ? <Banner tone="warning">{t("currentMissing")}</Banner> : null}
    {changed ? <section className={styles.compare} aria-label={t("comparison")}><h3>{t("changed")}</h3><p>{t("sourceTerm")}: {saved.source}</p><p>{t("newSavedValue")}: {saved.target}</p><p>{t("aliases")}: {saved.aliases.length ? saved.aliases.join(", ") : t("none")}</p><p>{t("reason")}: {saved.reason}</p>
      <p>{t("newScope")}: {t(saved.scopeUnitId ? "entryScope" : "projectScope")}</p>
      <p>{t("protected")}: {t(saved.protected ? "yes" : "no")}</p>
      {saved.removed ? <Banner tone="warning">{t("removed")}</Banner> : <><p>{t("rebaseHelp")}</p><Button disabled={disabled || knowledgeBlocked(owner)} onClick={adoptBasis}>{t("keepEdits")}</Button></>}
    </section> : null}
    {captureId ? <section><h3>{t("originalSource")}</h3>{provenance.isFetching ? <LoadingState label={t("readingSource")}/> : provenance.error ? <ErrorState title={t("originFailed")} action={<Button onClick={() => void provenance.refetch()}>{t("refresh")}</Button>}/>
      : original ? <>{original.kind === "file" ? <dl><dt>{t("source")}</dt><dd>{original.resourceId}</dd><dt>{t("sourceVersion")}</dt><dd>{original.revision}</dd><dt>{t("license")}</dt><dd>{original.license}</dd></dl>
        : <p>{t(original.kind === "correction" ? "correctionOrigin" : "mcpOrigin")}</p>}</> : null}</section> : null}
    <section><h3>{t("history")}</h3><p className={styles.meta}>{t("historyHelp")}</p>
      {history.isFetching && !history.data ? <LoadingState label={t("readingHistory")}/> : history.error ? <ErrorState title={t("historyFailed")} action={<Button onClick={() => void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())}>{t("refresh")}</Button>}/> : null}
      <ol className={styles.history}>{history.data?.pages.flat().map((revision, index) => <li key={revision.revisionId}><h3>{t("historyEntry", { number: index + 1 })}</h3><p>{revision.source} → {revision.target}</p><p>{revision.reason}</p><p className={styles.meta}>{t(revision.originKind === "manual" ? "manual" : "imported")} · {t(revision.scopeUnitId ? "entryScope" : "projectScope")}{revision.removed ? ` · ${t("stopped")}` : ""}</p>
        {revision.captureId ? <Button onClick={() => setOrigin({ termId: term.termId, captureId: revision.captureId! })}>{t("viewSource")}</Button> : null}</li>)}</ol>
      {history.hasNextPage ? <Button disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>{t("moreHistory")}</Button> : null}
    </section>
  </section>;
}
