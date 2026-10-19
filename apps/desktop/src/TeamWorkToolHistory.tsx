import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { useSessionQuery } from "./SessionReadProvider";
import type { SessionRequest } from "./executionCommands";
import { checkedTeamToolHistoryTask, workPlanCommands, type TeamToolHistoryAttempt, type TeamWorkReference, type WorkPlanView } from "./workPlanCommands";

export type OpenTeamToolTask = (work: TeamWorkReference, row: TeamToolHistoryAttempt) => Promise<boolean>;

/** Only original persisted tool children; full results remain in the Task owner. */
export function TeamWorkToolHistory({ context, plan, work, open, current, onOpenTask }: {
  context: SessionRequest; plan: WorkPlanView; work: TeamWorkReference; open: boolean; current: boolean; onOpenTask?: OpenTeamToolTask;
}) {
  const { t } = useTranslation(), [expanded, setExpanded] = useState(false), [after, setAfter] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const read = useSessionQuery({ key: ["team-work-tools", plan.planId, work, after], scopes: ["execution", "project"], enabled: open && expanded && current,
    // Navigation witnesses belong to exact decoded rows. Do not clone them in
    // Query's structural sharing when only their execution progress changes.
    structuralSharing: false,
    read: () => workPlanCommands.teamWorkTools({ ...context, planId: plan.planId, work, after, limit: 16 }) });
  useEffect(() => { if (open && expanded && read.error) errorRef.current?.focus(); }, [open, expanded, read.error]);
  const page = !read.error ? read.data : null, fresh = open && current && expanded && !read.isFetching && !read.isStale && !read.error;
  const entryNames = new Map(plan.scope.map(unit => [unit.unitId, unit.nativeKey]));
  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t("ai.teamTools.title")}</summary>
    {expanded ? <section aria-label={t("ai.teamTools.title")}>
      <p>{t("ai.teamTools.help")}</p>
      <button type="button" className="secondary-button" disabled={!open || !current || read.isFetching} onClick={() => { void read.refetch(); }}>{t("ai.teamTools.refresh")}</button>
      {!current || read.isFetching || read.isPending ? <p role="status">{t("ai.teamTools.loading")}</p> : read.isStale ? <p role="status">{t("ai.teamTools.stale")}</p> : null}
      {read.error ? <div ref={errorRef} role="alert" tabIndex={-1}><p>{t("ai.teamTools.failed")}</p><CommandFailureDetails failure={commandFailure(read.error)}/></div> : null}
      {page ? page.attempts.length ? page.attempts.map(row => <article className="execution-unit" key={row.reference.attemptId}>
        <h6>{row.name}</h6><p>{t("ai.teamTools.entries", { entries: row.unitIds.map(id => entryNames.get(id) ?? t("ai.teamHistory.savedEntry")).join(", "), locale: plan.locale })}</p>
        <p>{t("execution.progress", { generated: row.progress.succeeded, adopted: row.progress.adopted, total: row.progress.total })}</p>
        <p>{t("execution.statusCounts", { failed: row.progress.failed, unknown: row.progress.unknown, running: row.progress.running, queued: row.progress.queued, cancelled: row.progress.cancelled })}</p>
        <p>{t("ai.teamTools.recorded", { count: row.storedResultItems })}</p><p>{t("ai.teamTools.resultHelp")}</p>
        {row.progress.unknown > 0 ? <p role="status">{t("ai.teamTools.unknown")}</p> : null}
        {onOpenTask ? <button type="button" className="secondary-button" disabled={!fresh || !checkedTeamToolHistoryTask(context, plan.planId, work, row)}
          onClick={() => { if (fresh && checkedTeamToolHistoryTask(context, plan.planId, work, row)) void onOpenTask(work, row); }}>{t("ai.teamTools.openTask", { name: row.name })}</button> : null}
        <details><summary>{t("ai.team.identityDetails")}</summary><pre className="ai-text">{JSON.stringify({ toolHandle: row.toolHandle, reference: row.reference, unitIds: row.unitIds }, null, 2)}</pre></details>
      </article>) : fresh ? <p>{t("ai.teamTools.empty")}</p> : null : null}
      <div className="execution-actions"><button type="button" className="secondary-button" disabled={!fresh || after === null} onClick={() => setAfter(null)}>{t("ai.teamTools.firstPage")}</button>
        <button type="button" className="secondary-button" disabled={!fresh || !page?.nextAfter} onClick={() => setAfter(page?.nextAfter ?? null)}>{t("ai.teamTools.nextPage")}</button></div>
    </section> : null}
  </details>;
}
