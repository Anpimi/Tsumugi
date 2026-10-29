import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Field, Select } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { useSessionQuery } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import { sourceReads } from "../../../sourceQueries";
import { translationCommands } from "../../../translationCommands";
import { sourceCommands } from "../../../sourceCommands";
import type { SourceSession } from "../../../SourceDraftSession";
import SourceCorrectionPanel from "./SourceCorrectionPanel";
import type { ProjectView } from "../../../projectCommands";
import type { SourceReviewTarget } from "./sourceTypes";
import styles from "./SourceMaintenance.module.css";

export default function SourceSavedDetails({ project, owner, snapshotId, target, initialOrdinal, visible, disabled = false, current, onOpenEntry, onRevealCorrection }: {
  project: ProjectView; snapshotId: string; target?: Extract<SourceReviewTarget, { kind: "resolve-source-mapping" }> | null;
  owner: SourceSession; initialOrdinal?: number; onRevealCorrection: (snapshotId: string, ordinal: number) => void;
  visible: boolean; disabled?: boolean; current: () => boolean; onOpenEntry: (unitId: string, locale: string) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" }), { t: old } = useTranslation();
  const context = executionContext(project), [after, setAfter] = useState(initialOrdinal ?? target?.ordinal ?? 0), [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(initialOrdinal ?? target?.ordinal ?? null);
  const requestedOrdinal = initialOrdinal ?? target?.ordinal;
  useEffect(() => {
    if (requestedOrdinal !== undefined) { setAfter(requestedOrdinal); setSelectedOrdinal(requestedOrdinal); }
  }, [snapshotId, requestedOrdinal]);
  const [locale, setLocale] = useState(project.metadata.targetLocales[0] ?? "");
  const options = sourceReads.historyContent(context, snapshotId, "", after);
  const content = useSessionQuery({ ...options, enabled: visible });
  const page = content.data?.snapshotId === snapshotId ? content.data : null;
  const row = page?.rows.find(row => row.occurrence.ordinal === selectedOrdinal
    && (!target || selectedOrdinal !== target.ordinal || row.occurrenceId === target.occurrenceId)) ?? null;
  const lineageOptions = sourceReads.lineage(context, snapshotId, selectedOrdinal ?? 0);
  const lineage = useSessionQuery({ ...lineageOptions, enabled: visible && !!row });
  const history = useSessionQuery({ key: ["source-history-translations", snapshotId, row?.unitId, locale], scopes: ["translation"], enabled: visible && !!row?.unitId && !!locale,
    read: () => { if (!row?.unitId) throw new Error("No saved source unit"); return translationCommands.history({ ...context, unitId: row.unitId, locale, afterOrdinal: "0", limit: 20 }); } });
  const scope = useSessionQuery({ ...sourceReads.scope(context), enabled: visible });
  const currentBinding = useSessionQuery({ key: ["source-current-binding", snapshotId, selectedOrdinal], scopes: ["source"],
    enabled: visible && !!row && scope.data?.currentSnapshot === snapshotId && !scope.error,
    read: () => sourceCommands.content({ ...context, snapshotId, after: selectedOrdinal!, limit: 1 }) });
  const effective = currentBinding.data?.snapshotId === snapshotId && !currentBinding.error && !currentBinding.isFetching
    ? currentBinding.data.rows.find(value => value.occurrenceId === row?.occurrenceId) : null;
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
        <p>{evidence.decision === "unresolved" ? t("unresolved") : old(evidence.decision === "continue" ? "source.evidenceDecision.continue" : evidence.decision === "reject" ? "source.evidenceDecision.reject" : "source.evidenceDecision.candidate")}</p>
        {evidence.actor ? <p>{evidence.actor}</p> : null}{evidence.reason ? <p>{evidence.reason}</p> : null}</li>)}</ul>}
      <Field label={t("historyLocale")}><Select value={locale} onChange={event => setLocale(event.target.value)}>{project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}</Select></Field>
      {history.isFetching ? <LoadingState label={t("readingTranslations")}/> : history.error ? <Banner tone="warning" action={<Button onClick={() => void history.refetch()}>{t("retryRead")}</Button>}>{t("translationsFailed")}</Banner>
        : history.data ? <section aria-label={t("savedTranslations")}><h3>{t("savedTranslations")}</h3><p>{t("savedTranslationsHelp")}</p>
          {history.data.rows.length ? <ul>{history.data.rows.map(revision => <li key={revision.revisionId}><p><TokenizedText text={revision.text}/></p></li>)}</ul> : <p>{t("noSavedTranslations")}</p>}
        </section> : null}
      {effective?.unitId && scope.data?.currentSnapshot === snapshotId && !scope.isFetching && !scope.error ? <Button disabled={!current() || currentBinding.isStale}
        onClick={() => { if (current() && !currentBinding.isStale) onOpenEntry(effective.unitId!, locale); }}>{t("openCurrentEntry")}</Button> : null}
      {scope.data?.currentSnapshot === snapshotId && !scope.error && !scope.isFetching
        || owner.state.correctionDraft?.snapshotId === snapshotId && owner.state.correctionDraft.ordinal === row.occurrence.ordinal
        ? <SourceCorrectionPanel project={project} owner={owner} snapshotId={snapshotId} row={row} visible={visible} disabled={disabled} current={current} onRevealCorrection={onRevealCorrection}/> : null}
    </> : null}
  </section>;
}
