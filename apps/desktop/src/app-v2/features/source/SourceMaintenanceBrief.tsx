import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands, type ContentScope } from "../../../sourceCommands";
import { executionContext } from "../../../executionCommands";
import { sourceReads } from "../../../sourceQueries";
import type { ProjectView } from "../../../projectCommands";
import type { SourceOwner } from "./sourceTypes";
import styles from "./SourceMaintenance.module.css";

export default function SourceMaintenanceBrief({ project, owner, visible, disabled, locale, onOpen, onSaved, onAffected }: {
  project: ProjectView; owner: Pick<SourceOwner, "state" | "hasDraft" | "hasPending">; visible: boolean; disabled: boolean; locale: string;
  onOpen: () => void; onSaved: (snapshotId: string) => void; onAffected: (snapshotId: string) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" }), { t: old } = useTranslation();
  const reads = useSessionReads(), value = owner.state, context = executionContext(project), receipt = value.receiptRef, reference = value.comparisonRef;
  const savedReference = receipt && reference?.attemptId === receipt.attemptId && reference.resultId === receipt.resultId && reference.previousSnapshotId ? reference : null;
  const scopeOptions = sourceReads.scope(context), scope = useSessionQuery({ ...scopeOptions, enabled: visible && !!receipt });
  const confirmedScope = visible && !reads.retired && !scope.isFetching && !scope.isStale && !scope.error ? scope.data : undefined;
  const currentSource = !!receipt && confirmedScope?.currentSnapshot === receipt.snapshotId;
  function currentReceipt() {
    const query = reads.client.getQueryState<ContentScope>(reads.key(scopeOptions.key));
    return !!receipt && visible && !reads.retired && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated
      && query.error === null && query.data?.currentSnapshot === receipt.snapshotId;
  }
  const savedComparison = useSessionQuery({ key: ["source-maintenance-brief", receipt?.snapshotId, receipt?.attemptId, receipt?.resultId, savedReference?.previousSnapshotId], scopes: ["source"],
    enabled: visible && !!savedReference,
    read: async () => {
      if (!savedReference || !receipt) throw new Error("No saved source comparison");
      const page = await sourceCommands.compare({ ...context, attemptId: receipt.attemptId, resultId: receipt.resultId,
        base: savedReference.previousSnapshotId, after: 0, limit: 1 });
      if (page.attemptId !== receipt.attemptId || page.resultId !== receipt.resultId || page.previousSnapshotId !== savedReference.previousSnapshotId) throw new Error("Saved source comparison changed");
      return page;
    } });
  const impactOptions = sourceReads.impact(context, receipt?.snapshotId ?? "", locale, 0);
  const impact = useSessionQuery({ ...impactOptions, enabled: visible && currentSource && !!receipt && project.metadata.targetLocales.includes(locale) });
  const comparison = savedReference && !savedComparison.error ? savedComparison.data : null;
  const draftComparison = value.comparison && (!receipt || value.comparison.attemptId !== receipt.attemptId || value.comparison.resultId !== receipt.resultId) ? value.comparison : null;
  const draftResult = !!value.attempt && (!receipt || value.attempt !== receipt.attemptId
    || !!value.preview && value.preview.resultId !== receipt.resultId || !!draftComparison);
  const hasDraft = owner.hasDraft() || draftResult;
  function counts(page: NonNullable<typeof comparison>) {
    return <dl className={styles.counts}>{(["unchanged", "moved", "changed", "added", "renameCandidate", "ambiguous", "removed"] as const).map(kind =>
      <div key={kind}><dt>{t(`counts.${kind}`)}</dt><dd>{page.counts[kind]}</dd></div>)}</dl>;
  }
  if (!owner.hasDraft() && !owner.hasPending() && !receipt && !value.attempt) return null;
  return <section className={styles.body} aria-label={t("briefTitle")}>
    <h2>{t("briefTitle")}</h2>
    {receipt ? <section className={styles.body} aria-label={t("appliedVersion")}><h3>{t("appliedVersion")}</h3>
      {scope.error ? <Banner tone="warning" action={<Button onClick={() => void scope.refetch()}>{t("retryRead")}</Button>}>{t("appliedChecking")}</Banner>
        : <p>{t(currentSource ? "applied" : confirmedScope ? "pastApplied" : "appliedChecking")}</p>}
      {comparison ? counts(comparison) : null}
      {savedReference && savedComparison.isFetching ? <LoadingState label={t("readingComparison")}/> : null}
      {savedReference && savedComparison.error ? <Banner tone="warning" action={<Button onClick={() => void savedComparison.refetch()}>{t("retryRead")}</Button>}>{t("comparisonFailed")}</Banner> : null}
    </section> : null}
    {hasDraft || !receipt ? <section className={styles.body} aria-label={t("draftVersion")}><h3>{t("draftVersion")}</h3>
      <p>{t(receipt ? "draftNotApplied" : "notApplied")}</p>{draftComparison ? counts(draftComparison) : null}</section> : null}
    {owner.hasPending() ? <Banner tone="warning">{t("recoveryPending")}</Banner> : null}
    {currentSource && impact.data ? <p>{old("source.impactSummary", { locale: impact.data.summary.locale, preserved: String(impact.data.summary.preserved),
      reassess: String(impact.data.summary.reassess), unresolved: String(impact.data.summary.unresolved), total: String(impact.data.summary.total) })}</p> : null}
    {currentSource && impact.error ? <Banner tone="warning" action={<Button onClick={() => void impact.refetch()}>{t("retryRead")}</Button>}>{t("impactFailed")}</Banner> : null}
    <div className={styles.actions}>{receipt ? <Button disabled={disabled} onClick={() => onSaved(receipt.snapshotId)}>{t("viewSaved")}</Button> : null}
      {hasDraft || owner.hasPending() || !receipt ? <Button disabled={disabled} onClick={onOpen}>{t("preview")}</Button> : null}
      {currentSource && receipt ? <Button disabled={disabled} onClick={() => { if (!disabled && currentReceipt()) onAffected(receipt.snapshotId); }}>{t("openAffected")}</Button> : null}</div>
  </section>;
}
