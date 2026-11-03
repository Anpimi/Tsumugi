import { useLayoutEffect, useRef } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import type { ConversationPlanningRun } from "../../../conversationCommands";
import { confirmExecutionAction, confirmExecutionReceipt, executionCommands, type PrepareRequest } from "../../../executionCommands";
import { useOptionalExecutionTaskSession } from "../../../ExecutionTaskSession";
import { reviewCommands } from "../../../reviewCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { translationCommands, type TranslationRevision } from "../../../translationCommands";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Banner } from "../../../design-system/Feedback";
import styles from "./ConversationPanel.module.css";

export type OpenConversationRevisionCandidate = (revision: TranslationRevision, current: () => boolean) => Promise<boolean>;

export function ConversationRevisionCandidate({ run, basis, runKey, visible, current, onOpen }: {
  run: ConversationPlanningRun;
  basis: Extract<ConversationPlanningRun["preview"]["scope"], { kind: "selected-revision" }>["basis"];
  runKey: QueryKey;
  visible: boolean;
  current: () => boolean;
  onOpen?: OpenConversationRevisionCandidate;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const reads = useSessionReads(), tasks = useOptionalExecutionTaskSession(), { detail, resultId } = run;
  const model = run.output?.model;
  const unit = detail.recovery.units.find(value => value.unitId === run.receipt.consent.actionId && value.resultIds[0] === resultId);
  const request: PrepareRequest | null = unit && resultId ? { ...reads.context, attemptId: detail.attemptId, unitId: unit.unitId,
    actionId: resultId, resultIds: [resultId] } : null;
  const target = useSessionQuery({ key: ["conversation-revision-target", basis.unitId, basis.locale],
    scopes: ["project", "source", "translation"], enabled: visible, read: () => reviewCommands.target({ ...reads.context, unitId: basis.unitId, locale: basis.locale }) });
  const saved = useSessionQuery({ key: ["execution-adoption", detail.attemptId, resultId], scopes: ["project", "execution", "translation"],
    enabled: visible && !!request && !!unit?.actions.length, read: async () => {
      if (!request || model?.kind !== "revision") return null;
      const record = await executionCommands.adoptionAction(request);
      if (!record) return null;
      confirmExecutionAction(request, detail.operation, record.action);
      if (!record.receipt) return { revision: null };
      const receipt = confirmExecutionReceipt(request, record.receipt);
      const [change] = receipt.changes;
      if (receipt.changes.length !== 1 || change.kind !== "translation-revision") throw new Error("Invalid revision candidate receipt");
      const revision = await translationCommands.revision({ ...reads.context, unitId: basis.unitId, locale: basis.locale, revisionId: change.id });
      if (revision.originKind !== "ai" || revision.ordinal !== change.revision || revision.attemptId !== detail.attemptId
        || revision.itemId !== run.receipt.consent.actionId || revision.resultId !== resultId
        || revision.sourceSnapshotId !== basis.sourceSnapshotId || revision.sourceRevisionId !== basis.sourceRevisionId
        || revision.text !== model.text) throw new Error("Invalid saved revision candidate");
      return { revision };
    } });
  const activity = tasks?.activity?.intent.attemptId === detail.attemptId
    && tasks.activity.intent.operation === detail.operation && tasks.activity.intent.action === "adopt-result"
    && tasks.activity.intent.unit.resultIds[0] === resultId ? tasks.activity : null;
  const candidate = saved.isError ? null : saved.data?.revision;
  const observed = target.isError ? null : target.data;
  const historical = candidate && target.isError
    ? (JSON.parse(run.preview.input) as { selectedTranslation: string }).selectedTranslation : null;
  const stale = observed && (observed.sourceSnapshotId !== basis.sourceSnapshotId || observed.sourceRevisionId !== basis.sourceRevisionId
    || observed.selectionId !== basis.selectionId || observed.revisionId !== basis.translationRevisionId);
  const canSave = !!unit?.actions.includes("adopt-result") && saved.isSuccess && !saved.isFetching && !candidate;
  const live = useRef<(() => boolean) | null>(null);
  useLayoutEffect(() => {
    live.current = () => visible && !reads.retired && current();
    return () => { live.current = null; };
  }, [current, reads, visible]);
  const active = () => live.current?.() === true;
  return <section aria-label={t("revisionCandidate")}>
    {stale && observed.revisionId !== candidate?.revisionId ? <Banner tone="warning">{t("revisionCandidateStale")}</Banner> : null}
    {target.isError ? <Banner tone="warning" action={<Button size="sm" disabled={target.isFetching}
      onClick={() => void target.refetch()}>{t("retryRead")}</Button>}>{t("revisionBasisUnavailable")}</Banner> : null}
    {saved.isError ? <Banner tone="warning" action={<Button size="sm" onClick={() => void saved.refetch()}>{t("retryRead")}</Button>}>
      <p>{t("revisionCandidateReadFailed")}</p><CommandFailureDetails failure={commandFailure(saved.error)}/>
    </Banner> : null}
    {candidate ? <div className={styles.actions}><p role="status">{t("revisionCandidateSaved")}</p>
      {onOpen && observed ? <Button size="sm" disabled={!active() || saved.isFetching} onClick={() => {
        if (!active()) return;
        const witness = reads.watchExactQuery(["execution-adoption", detail.attemptId, resultId]);
        const original = witness.current(), version = original?.state.dataUpdateCount;
        void onOpen(candidate, () => active() && !!original && witness.current() === original && original.state.dataUpdateCount === version
          && !original.state.isInvalidated && original.state.fetchStatus === "idle").finally(witness.dispose);
      }}>{t("revisionCandidateCompare")}</Button> : null}</div> : null}
    {candidate && historical !== null ? <Disclosure title={t("revisionHistoricalCompare")}>
      <div className={styles.revisionComparison}>
        <div><h4>{t("revisionOriginalTranslation")}</h4><p className={styles.text} lang={basis.locale}>{historical}</p></div>
        <div><h4>{t("revisionCandidate")}</h4><p className={styles.text} lang={basis.locale}>{candidate.text}</p></div>
      </div>
    </Disclosure> : null}
    {!candidate && activity?.phase === "recorded" ? <Button size="sm" disabled={saved.isFetching} onClick={() => void saved.refetch()}>{t("revisionCandidateCheck")}</Button> : null}
    {!activity && canSave && tasks && unit ? <Button size="sm" disabled={!active() || !tasks.canBegin(detail.taskId)} onClick={() => {
      if (active()) void tasks.beginFromQuery(runKey, detail, unit, "adopt-result", 0);
    }}>{t(saved.data ? "revisionCandidateResume" : "revisionCandidateSave")}</Button> : null}
    {activity?.phase === "confirming" && tasks ? <div className={styles.actions}>
      <Button variant="primary" size="sm" disabled={!active() || !canSave || !tasks.canSubmit()} onClick={() => {
        if (active()) void tasks.submit(active);
      }}>{t("revisionCandidateConfirm")}</Button>
      <Button size="sm" onClick={tasks.dismiss}>{t("askClose")}</Button>
    </div> : null}
    {activity?.phase === "unknown" && tasks ? <Banner tone="warning"><p>{t("revisionCandidateUnknown")}</p>
      <div className={styles.actions}><Button size="sm" disabled={!active() || tasks.busy} onClick={() => void tasks.checkAdoption()}>{t("revisionCandidateCheck")}</Button>
        {activity.retryAllowed ? <Button size="sm" disabled={!active() || tasks.busy} onClick={() => void tasks.retryAdoption()}>{t("retryOriginal")}</Button> : null}</div>
    </Banner> : null}
    {activity?.phase === "rejected" && tasks ? <Banner tone="warning"><CommandFailureDetails failure={activity.failure}/>
      <Button size="sm" onClick={tasks.dismiss}>{t("askClose")}</Button></Banner> : null}
    {activity && tasks?.busy ? <p role="status">{t("revisionCandidateSaving")}</p> : null}
  </section>;
}
