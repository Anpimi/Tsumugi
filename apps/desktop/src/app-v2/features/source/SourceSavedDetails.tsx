import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Field } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { useSessionQuery } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import { sourceReads } from "../../../sourceQueries";
import { translationCommands } from "../../../translationCommands";
import type { ProjectView } from "../../../projectCommands";
import type { SourceReviewTarget } from "./sourceTypes";
import styles from "./SourceMaintenance.module.css";

export default function SourceSavedDetails({ project, snapshotId, target, visible, current, onOpenEntry }: {
  project: ProjectView; snapshotId: string; target?: Extract<SourceReviewTarget, { kind: "resolve-source-mapping" }> | null;
  visible: boolean; current: () => boolean; onOpenEntry: (unitId: string, locale: string) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" }), { t: old } = useTranslation();
  const context = executionContext(project), [after, setAfter] = useState(target?.ordinal ?? 0), [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(target?.ordinal ?? null);
  const [locale, setLocale] = useState(project.metadata.targetLocales[0] ?? "");
  const options = sourceReads.historyContent(context, snapshotId, "", after);
  const content = useSessionQuery({ ...options, enabled: visible });
  const page = content.data?.snapshotId === snapshotId && !content.error ? content.data : null;
  const row = page?.rows.find(row => row.occurrence.ordinal === selectedOrdinal
    && (!target || selectedOrdinal !== target.ordinal || row.occurrenceId === target.occurrenceId)) ?? null;
  const lineageOptions = sourceReads.lineage(context, snapshotId, selectedOrdinal ?? 0);
  const lineage = useSessionQuery({ ...lineageOptions, enabled: visible && !!row });
  const history = useSessionQuery({ key: ["source-history-translations", snapshotId, row?.unitId, locale], scopes: ["translation"], enabled: visible && !!row?.unitId && !!locale,
    read: () => { if (!row?.unitId) throw new Error("No saved source unit"); return translationCommands.history({ ...context, unitId: row.unitId, locale, afterOrdinal: "0", limit: 20 }); } });
  const scope = useSessionQuery({ ...sourceReads.scope(context), enabled: visible });
  return <section className={styles.body} aria-label={t("savedSource")}><h2>{t("savedSource")}</h2><p>{t("savedMappingHelp")}</p>
    {content.isFetching ? <LoadingState label={t("readingHistory")}/> : null}
    {content.error ? <Banner tone="error" action={<Button onClick={() => void content.refetch()}>{t("retryRead")}</Button>}>{t("historyFailed")}</Banner> : null}
    {page ? <ul>{page.rows.map(row => <li key={row.occurrenceId}><Button disabled={!current()} aria-current={selectedOrdinal === row.occurrence.ordinal ? "true" : undefined}
      onClick={() => setSelectedOrdinal(row.occurrence.ordinal)}>{row.occurrence.nativeIdentity?.display.value || row.occurrence.key || t("entry", { number: row.occurrence.ordinal + 1 })}</Button>
      <p><TokenizedText text={row.occurrence.text}/></p></li>)}</ul> : null}
    {target && page && selectedOrdinal === target.ordinal && !row ? <Banner tone="warning">{t("savedEntryMissing")}</Banner> : null}
    <div className={styles.actions}><Button disabled={!current() || after === 0 || content.isFetching} onClick={() => setAfter(0)}>{t("firstPage")}</Button>
      <Button disabled={!current() || page?.nextOrdinal === null || !page || content.isFetching} onClick={() => { if (page?.nextOrdinal != null) setAfter(page.nextOrdinal); }}>{t("nextPage")}</Button></div>
    {row ? <><h3>{t("savedEvidence")}</h3>{lineage.isFetching ? <LoadingState label={t("readingHistory")}/> : lineage.error ? <Banner tone="warning" action={<Button onClick={() => void lineage.refetch()}>{t("retryRead")}</Button>}>{t("historyFailed")}</Banner>
      : <ul>{lineage.data?.map(evidence => <li key={`${evidence.oldSnapshotId}:${evidence.old.occurrence.ordinal}:${evidence.actionId}`}>
        <strong>{evidence.old.occurrence.nativeIdentity?.display.value || evidence.old.occurrence.key}</strong><p><TokenizedText text={evidence.old.occurrence.text}/></p>
        <p>{old(evidence.decision === "continue" ? "source.evidenceDecision.continue" : evidence.decision === "reject" ? "source.evidenceDecision.reject" : "source.evidenceDecision.candidate")}</p>
        {evidence.actor ? <p>{evidence.actor}</p> : null}{evidence.reason ? <p>{evidence.reason}</p> : null}</li>)}</ul>}
      <Field label={t("historyLocale")}><select value={locale} onChange={event => setLocale(event.target.value)}>{project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}</select></Field>
      {history.isFetching ? <LoadingState label={t("readingTranslations")}/> : history.error ? <Banner tone="warning" action={<Button onClick={() => void history.refetch()}>{t("retryRead")}</Button>}>{t("translationsFailed")}</Banner>
        : history.data ? <section aria-label={t("savedTranslations")}><h3>{t("savedTranslations")}</h3><p>{t("savedTranslationsHelp")}</p>
          {history.data.rows.length ? <ul>{history.data.rows.map(revision => <li key={revision.revisionId}><p><TokenizedText text={revision.text}/></p></li>)}</ul> : <p>{t("noSavedTranslations")}</p>}
        </section> : null}
      {row.unitId && scope.data?.currentSnapshot === snapshotId && !scope.isFetching && !scope.error ? <Button disabled={!current()} onClick={() => onOpenEntry(row.unitId!, locale)}>{t("openCurrentEntry")}</Button> : null}
    </> : null}
  </section>;
}
