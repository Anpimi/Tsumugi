import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { executionCommands, executionContext } from "../../../executionCommands";
import { sourceCommands, type SourceChangePage } from "../../../sourceCommands";
import { sourceKeys, sourceReads } from "../../../sourceQueries";
import type { ProjectView } from "../../../projectCommands";
import type { SourceOwner, SourceReviewTarget } from "./sourceTypes";
import SourceMappingTable from "./SourceMappingTable";
import styles from "./SourceMaintenance.module.css";

export default function SourceMappingPanel({ project, owner, visible, disabled, current, onApplied, target }: {
  project: ProjectView; owner: SourceOwner; visible: boolean; disabled: boolean; current: () => boolean; onApplied: (snapshotId: string) => void;
  target?: Extract<SourceReviewTarget, { kind: "compare-source-mapping" }> | null;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" }), { t: original } = useTranslation();
  const reads = useSessionReads(), context = executionContext(project), value = owner.state, basis = value.comparison ?? value.preview;
  const [reading, setReading] = useState(false), [failure, setFailure] = useState<unknown>(null), [changed, setChanged] = useState(false);
  const [details, setDetails] = useState<SourceChangePage["rows"][number] | null>(null), ticket = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ticket.current++; }; }, []);
  useEffect(() => { ticket.current++; setReading(false); setFailure(null); setDetails(null); }, [project.sessionToken, project.metadata.projectId]);
  const comparisonOptions = sourceReads.comparison(context, value.comparison, value.appliedFilter, value.comparisonAfter);
  const comparison = useSessionQuery({ ...comparisonOptions, enabled: visible && !!value.comparison });
  const previewOptions = sourceReads.preview(context, value.preview, value.previewAfter);
  const preview = useSessionQuery({ ...previewOptions, enabled: visible && !!value.preview && value.previewAfter > 0 });
  const page = value.comparison ? comparison.data ?? (value.comparisonAfter === 0 && value.appliedFilter === "" ? value.comparison : null) : null;
  const input = value.historicalSearch;
  const historyOptions = sourceReads.historyContent(context, input?.snapshotId ?? "", input?.query ?? "", input?.after ?? 0);
  const matches = useSessionQuery({ ...historyOptions, enabled: visible && !!input && value.manualOrdinal === input.newOrdinal
    && value.comparison?.previousSnapshotId === input.snapshotId });
  function fresh(key: readonly unknown[]) {
    const query = reads.client.getQueryState(reads.key(key));
    return query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null;
  }
  function proof() { return visible && !disabled && current() && !reads.retired && !reading && !owner.current().stale
    && owner.current().comparison === value.comparison && owner.current().preview === value.preview
    && (!value.comparison || fresh(comparisonOptions.key)); }
  async function readProposal() {
    if (!current() || disabled || owner.inFlight() || owner.hasPending() || !owner.current().attempt) return;
    const before = owner.current(), id = ++ticket.current, attemptId = before.attempt!, sequence = before.editSeq;
    setReading(true); setFailure(null); setChanged(false);
    const present = () => alive.current && id === ticket.current && current() && !reads.retired
      && owner.current().attempt === attemptId && owner.current().editSeq === sequence;
    try {
      const detail = await reads.client.fetchQuery({ queryKey: reads.key(["source-attempt", attemptId, 0, 100]), staleTime: 0,
        queryFn: () => executionCommands.attempt({ ...context, attemptId, offset: 0, limit: 100 }) });
      if (!present()) { setChanged(true); return; }
      const item = detail.operation === "source-import" && detail.items.length === 1 ? detail.items[0] : null;
      if (!item?.resultId) throw new Error("Source result is not available");
      const scope = await sourceCommands.scope(context);
      if (!present()) { setChanged(true); return; }
      if (target && (scope.revision !== target.expectedContentRevision || scope.currentSnapshot !== target.previousSnapshotId)) { setChanged(true); return; }
      if (target && target.attemptId === attemptId && item.resultId !== target.resultId) throw new Error("Source result changed");
      const previous = target?.attemptId === attemptId ? target.previousSnapshotId : before.comparison?.previousSnapshotId ?? before.comparisonRef?.previousSnapshotId;
      const next = scope.currentSnapshot ? await sourceCommands.compare({ ...context, attemptId, resultId: item.resultId,
        base: previous ?? scope.currentSnapshot, filter: "", after: 0, limit: 50 }) : await sourceCommands.preview({ ...context, attemptId, resultId: item.resultId, after: 0, limit: 50 });
      if (!present() || next.scope.revision !== scope.revision || next.scope.currentSnapshot !== scope.currentSnapshot) { setChanged(true); return; }
      if (before.comparison) owner.page(next, "", true); else owner.ready(next, detail);
      const accepted = owner.current().comparison ?? owner.current().preview;
      if (accepted !== next) { setChanged(true); return; }
      if ("previousSnapshotId" in next) reads.client.setQueryData(reads.key(sourceKeys.comparison(next, "", 0)), next);
      else reads.client.setQueryData(reads.key(sourceKeys.preview(next, 0)), next);
    } catch (error) { if (present()) setFailure(error); }
    finally { if (alive.current && id === ticket.current) setReading(false); }
  }
  const editAllowed = visible && !disabled && !owner.journal.retired;
  const auditValid = Object.values(value.lineage).every(choice => !!choice.reason.trim() && new TextEncoder().encode(choice.reason).length <= 4096)
    && (!Object.keys(value.lineage).length || !!value.actor.trim());
  function choose(ordinal: number, choice: SourceChangePage["confirmation"]["lineage"][number] | null) {
    if (!editAllowed) return;
    owner.edit("lineage", before => { const next = { ...before }; if (choice) next[ordinal] = choice; else delete next[ordinal]; return next; });
  }
  return <section className={styles.body} aria-label={t("mappingTitle")}>
    <div className={styles.actions}><h2>{t("mappingTitle")}</h2><Button disabled={!current() || disabled || reading || owner.hasPending() || !value.attempt}
      onClick={() => { void readProposal(); }}>{t(basis ? "refreshComparison" : "preview")}</Button></div>
    <p>{t("mappingHelp")}</p>
    {reading ? <LoadingState label={t("readingComparison")}/> : null}
    {failure ? <Banner tone="error">{t("comparisonFailed")}<CommandFailureDetails failure={commandFailure(failure)}/></Banner> : null}
    {changed || value.stale ? <Banner tone="warning">{t("comparisonChanged")}</Banner> : null}
    {value.comparison ? <>
      <p>{t("notApplied")}</p><p>{t("mappingInitialCount", { count: value.comparison.mappingReviewRequired })}</p>
      <dl className={styles.counts}>{(["unchanged", "moved", "changed", "added", "renameCandidate", "ambiguous", "removed"] as const).map(kind => <div key={kind}><dt>{t(`counts.${kind}`)}</dt><dd>{value.comparison!.counts[kind]}</dd></div>)}</dl>
      <form className={styles.actions} onSubmit={event => { event.preventDefault(); if (proof()) owner.pageIntent(0, owner.current().filter); }}>
        <Field label={t("filter")}><TextInput readOnly={!editAllowed} value={value.filter} onChange={event => owner.edit("filter", event.target.value)}/></Field>
        <Button type="submit" disabled={!proof() || owner.hasPending()}>{t("search")}</Button>
      </form>
      {comparison.error ? <Banner tone="error" action={<Button onClick={() => { void comparison.refetch(); }}>{t("retryRead")}</Button>}>{t("comparisonFailed")}</Banner> : null}
      {page && !comparison.error ? <SourceMappingTable page={page} choices={value.lineage} disabled={!editAllowed || !fresh(comparisonOptions.key)}
        onChoice={choose} onHistorical={ordinal => owner.edit("manualOrdinal", ordinal)} onDetails={setDetails}/> : null}
      <div className={styles.actions}><Button disabled={!proof() || value.comparisonAfter === 0 || owner.hasPending()} onClick={() => owner.pageIntent(0)}>{t("firstPage")}</Button>
        <Button disabled={!proof() || !page || page.nextOrdinal === null || owner.hasPending()} onClick={() => { if (page?.nextOrdinal !== null && page?.nextOrdinal !== undefined) owner.pageIntent(page.nextOrdinal); }}>{t("nextPage")}</Button></div>
      {value.manualOrdinal !== null ? <section className={styles.body} aria-label={t("historySearch")}>
        <Field label={t("historySearch")}><TextInput readOnly={!editAllowed} value={value.historicalQuery} onChange={event => owner.edit("historicalQuery", event.target.value)}/></Field>
        <Button disabled={!proof() || owner.hasPending()} onClick={() => owner.historyIntent(owner.current().historicalQuery, 0)}>{t("search")}</Button>
        {matches.isFetching ? <LoadingState label={t("readingHistory")}/> : matches.error ? <Banner tone="error" action={<Button onClick={() => void matches.refetch()}>{t("retryRead")}</Button>}>{t("historyFailed")}</Banner> : null}
        {matches.data && !matches.error ? <><ul>{matches.data.rows.map(row => <li key={row.occurrenceId}><strong>{row.occurrence.nativeIdentity?.display.value || row.occurrence.key}</strong><p><TokenizedText text={row.occurrence.text}/></p>
          <div className={styles.actions}>{(["continue", "reject"] as const).map(decision => <Button key={decision} disabled={!current() || !editAllowed || !fresh(historyOptions.key) || !row.occurrenceId}
            onClick={() => { if (row.occurrenceId && owner.current().manualOrdinal !== null) choose(owner.current().manualOrdinal!, { newOrdinal: owner.current().manualOrdinal!, oldOccurrenceId: row.occurrenceId, decision, reason: "" }); }}>
            {t(decision, { entry: row.occurrence.nativeIdentity?.display.value || row.occurrence.key })}</Button>)}</div></li>)}</ul>
          {matches.data.nextOrdinal !== null ? <Button disabled={!current() || !fresh(historyOptions.key)} onClick={() => owner.historyIntent(value.historicalQuery, matches.data.nextOrdinal!)}>{t("nextPage")}</Button> : null}</> : null}
      </section> : null}
      <Field label={t("actor")} required={!!Object.keys(value.lineage).length}><TextInput readOnly={!editAllowed} value={value.actor} onChange={event => owner.edit("actor", event.target.value)}/></Field>
      <Button disabled={!proof() || !auditValid || owner.inFlight() || owner.hasPending()} onClick={() => { void owner.estimate(proof); }}>{t("reviewImpact")}</Button>
      {value.estimate?.map(summary => <p key={summary.locale}>{original("source.impactSummary", { locale: summary.locale, preserved: String(summary.preserved), reassess: String(summary.reassess), unresolved: String(summary.unresolved), total: String(summary.total) })}</p>)}
    </> : value.preview ? <><p>{t("notApplied")}</p><p>{t("initialEntries", { count: value.preview.total })}</p>
      {(value.previewAfter === 0 ? value.preview : preview.data)?.rows.map(row => <div key={row.occurrence.operationOccurrenceId}><strong>{row.occurrence.nativeIdentity?.display.value || row.occurrence.key}</strong><p><TokenizedText text={row.occurrence.text}/></p></div>)}</> : null}
    {basis ? <><Field label={t("confirmApply", { count: basis.total })}><input type="checkbox" checked={value.confirmed} disabled={!proof() || !owner.qualified() || !!value.comparison && !value.estimate || owner.hasPending()}
      onChange={event => { if (current()) owner.confirm(event.target.checked); }}/></Field><p>{t("applyHelp")}</p>
      <Button variant="primary" disabled={!proof() || !auditValid || !value.confirmed || owner.inFlight() || owner.hasPending()} onClick={() => { void owner.apply(proof); }}>{t("apply")}</Button></> : null}
    {value.receiptRef ? <Banner tone="success" action={<Button disabled={!current()} onClick={() => onApplied(value.receiptRef!.snapshotId)}>{t("openAffected")}</Button>}>{t("applied")}</Banner> : null}
    {details ? <section className={styles.body} aria-label={t("details")}><h3>{details.new?.nativeIdentity?.display.value || details.new?.key || details.old?.occurrence.key}</h3>
      <Field label={t("previous")}><TextArea readOnly value={details.old?.occurrence.text ?? ""}/></Field><Field label={t("next")}><TextArea readOnly value={details.new?.text ?? ""}/></Field>
      <Button onClick={() => setDetails(null)}>{t("closeDetails")}</Button></section> : null}
  </section>;
}
