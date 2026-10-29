import { useTranslation } from "react-i18next";
import { AiProviderBudget } from "../../../AiUsage";
import { commandFailure, CommandFailureDetails } from "../../../CommandFailure";
import { executionCommands, type SessionRequest } from "../../../executionCommands";
import { useSessionQuery } from "../../../SessionReadProvider";
import { workPlanCommands, type WorkPlanRunView, type WorkPlanStatusView } from "../../../workPlanCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import type { ConversationPlanLink } from "./conversationRun";
import type { OpenConversationRunCandidate } from "./conversationRunResultReads";
import { ConversationRunResults } from "./ConversationRunResults";
import { ConversationTeamProgress } from "./ConversationTeamProgress";
import type { OpenConversationTeamCandidate } from "./conversationTeamReads";
import type { ConversationTeamProgressProps } from "./ConversationTeamProgress";
import styles from "./ConversationRunPanel.module.css";

interface Props {
  context: SessionRequest; link: ConversationPlanLink; status: WorkPlanStatusView | null;
  visible: boolean; canRead: () => boolean; onOpenCandidate?: OpenConversationRunCandidate;
  onOpenTeamCandidate?: OpenConversationTeamCandidate;
  teamActions?: ConversationTeamProgressProps["actions"];
  onTeamReply?: ConversationTeamProgressProps["onReply"];
}

function RunAttempt({ context, run, visible, canRead }: Pick<Props, "context" | "visible" | "canRead"> & { run: WorkPlanRunView }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const start = run.lastStart;
  const attempt = useSessionQuery({
    key: ["work-plan-run-attempt", run.planId, start?.taskId, start?.attemptId], scopes: ["project", "execution"], enabled: visible && !!start,
    read: async () => {
      if (!start) throw new Error("Missing work-plan start record");
      const detail = await executionCommands.attempt({ ...context, attemptId: start.attemptId, offset: 0, limit: 1 });
      const progress = detail.progress;
      if (detail.attemptId !== start.attemptId || detail.taskId !== start.taskId || detail.recovery.attemptId !== start.attemptId
        || detail.items.length > 1 || detail.items.length > progress.total || progress.adopted > progress.total
        || progress.total !== progress.succeeded + progress.failed + progress.unknown + progress.queued + progress.running + progress.cancelled)
        throw new Error("Invalid work-plan attempt association");
      return detail;
    },
  });
  if (!start) return <p>{t("runNotStarted")}</p>;
  const detail = !attempt.error ? attempt.data : null;
  return <section className={styles.material} aria-label={t("runProgressTitle")}>
    <h5>{t("runProgressTitle")}</h5>
    {BigInt(start.expectedGeneration) < BigInt(run.lease.generation) ? <p>{t("runEarlierStart")}</p> : null}
    {attempt.isPending ? <LoadingState label={t("runProgressLoading")}/> : null}
    {attempt.error ? <Banner tone="error"><p>{t("runProgressFailed")}</p><CommandFailureDetails failure={commandFailure(attempt.error)}/></Banner> : null}
    {detail ? <><p role="status">{t("runProgressCounts", { ...detail.progress })}</p><p>{t("runProgressResultHelp")}</p></> : null}
    <Button size="sm" pending={attempt.isFetching} disabled={!canRead()} onClick={() => { if (canRead()) void attempt.refetch(); }}>{t("runRefreshProgress")}</Button>
  </section>;
}

/** Read the original plan's start proof before asking the execution ledger for progress. */
export function ConversationRunProgress({ context, link, status, visible, canRead, onOpenCandidate, onOpenTeamCandidate, teamActions, onTeamReply }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const read = useSessionQuery({ key: ["work-plan-run", link.planId], scopes: ["project", "execution"], enabled: visible,
    read: async () => {
      const run = await workPlanCommands.run({ ...context, planId: link.planId });
      if (run.planDigest !== link.planDigest) throw new Error("Work-plan run does not match the saved proposal plan");
      return run;
    } });
  const run = !read.error ? read.data : null;
  const sameStatus = !!run && !!status && run.lease.planId === status.lease.planId
    && run.lease.generation === status.lease.generation && run.state === status.state;
  return <div className={styles.observation}>
    {read.isPending ? <LoadingState label={t("runRecordLoading")}/> : null}
    {read.error ? <Banner tone="error"><p>{t("runRecordFailed")}</p><CommandFailureDetails failure={commandFailure(read.error)}/></Banner> : null}
    {read.error || run && !sameStatus ? <Button size="sm" pending={read.isFetching} disabled={!canRead()} onClick={() => {
      if (canRead()) void read.refetch();
    }}>{t("runRefreshRecord")}</Button> : null}
    {run ? <>
      {!sameStatus ? <p role="status">{t("runRecordChanged")}</p>
        : status?.plan.options.teamExecution ? <ConversationTeamProgress context={context} link={link} status={status}
          visible={visible} canRead={canRead} onOpenCandidate={onOpenTeamCandidate} actions={teamActions} onReply={onTeamReply}/>
          : <RunAttempt key={`${run.lastStart?.attemptId ?? "none"}`} context={context} run={run} visible={visible} canRead={canRead}/>}
      <section className={styles.material} aria-label={t("runBudgetTitle")}><h5>{t("runBudgetTitle")}</h5>
        {run.budget ? <AiProviderBudget budget={run.budget}/> : <p>{t(run.budgetRootTaskId ? "runBudgetMissing" : "runNoModelBudget")}</p>}
      </section>
      {sameStatus && status?.plan.preview && !status.plan.options.teamExecution && !status.plan.options.mcpTermQuery && run.lastStart
        ? <ConversationRunResults context={context} link={link} plan={status.plan} start={run.lastStart}
          visible={visible} canRead={canRead} onOpenCandidate={onOpenCandidate}/> : null}
    </> : null}
  </div>;
}
