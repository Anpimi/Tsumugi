import { useTranslation } from "react-i18next";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { executionCommands, executionContext, type TaskActivity, type TaskActivityRow } from "./executionCommands";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import type { ProjectView } from "./projectCommands";
import { enUS } from "./i18n/en-US";
import { useImperativeHandle, useRef, type Ref } from "react";
import "./TaskDock.css";

const phases = ["active", "attention", "saved"] as const;
export interface TaskDockHandle { reveal: () => boolean }
export function TaskDock({ project, disabled, onOpen, ref }: {
  project: ProjectView; disabled: boolean; onOpen: (row?: TaskActivityRow) => void; ref?: Ref<TaskDockHandle>;
}) {
  const { t } = useTranslation(), reads = useSessionReads();
  const details = useRef<HTMLDetailsElement>(null), summary = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => ({ reveal() {
    const container = details.current, trigger = summary.current;
    if (disabled || reads.retired || !container?.isConnected || !trigger?.isConnected) return false;
    container.open = true;
    trigger.focus({ preventScroll: true }); trigger.scrollIntoView({ block: "nearest" });
    return true;
  } }), [disabled, reads]);
  const activity = useSessionQuery<TaskActivity>({ key: ["task-activity", 12], scopes: ["execution"],
    enabled: !reads.retired,
    read: () => executionCommands.activity({ ...executionContext(project), limit: 12 }),
  });
  const value = !activity.error ? activity.data : undefined;
  const unavailable = disabled || reads.retired || activity.isFetching || activity.isStale;
  return <aside className="task-dock" aria-label={t("execution.dock.title")}>
    <details ref={details}>
      <summary ref={summary}>{t("execution.dock.title")}
        <span>{activity.error ? t("execution.dock.unavailable") : !value || activity.isFetching ? t("execution.loading")
          : value.total === "0" ? t("execution.dock.empty")
          : t("execution.dock.counts", { active: value.active, attention: value.attention, saved: value.saved })}</span>
      </summary>
      <div className="task-dock-content">
        {activity.error ? <div role="alert"><p>{t("execution.dock.readFailed")}</p>
          <CommandFailureDetails failure={commandFailure(activity.error)} />
          <button type="button" className="secondary-button" disabled={activity.isFetching || reads.retired} onClick={() => void activity.refetch()}>{t("execution.refresh")}</button>
        </div> : value ? <>
          <p>{t("execution.dock.scope", { defaultValue: enUS.execution.dock.scope, shown: value.rows.length, total: value.total })}</p>
          <div className="task-dock-groups">{phases.map(phase => {
            const rows = value.rows.filter(row => row.phase === phase);
            return rows.length ? <section key={phase} aria-label={t(`execution.dock.${phase}`)}>
              <h2>{t(`execution.dock.${phase}`)}</h2><ul>{rows.map(row => <li key={row.taskId}>
                <button type="button" className="text-button" disabled={unavailable}
                  onClick={() => { if (!unavailable) onOpen(row); }}>
                  {t(row.operation === "source-import" ? "source.title" : row.operation === "translation-import" ? "translation.title"
                    : row.operation === "ai-translation" ? "ai.title" : row.operation === "ai-semantic-review" ? "semanticReview.title" : row.operation === "locale-build" ? "release.title" : "execution.operation")}
                  {" · "}{t("execution.taskNumber", { number: row.sequence })}
                </button>
                <p>{t("execution.dock.progress", { defaultValue: enUS.execution.dock.progress, running: row.progress.running, queued: row.progress.queued,
                  saved: row.progress.succeeded, total: row.progress.total, applied: row.progress.adopted,
                  failed: row.progress.failed, unknown: row.progress.unknown, cancelled: row.progress.cancelled })}</p>
              </li>)}</ul>
            </section> : null;
          })}</div><p>{t("execution.dock.meaning")}</p>
        </> : <p role="status">{t("execution.loading")}</p>}
        <button type="button" className="secondary-button" disabled={disabled || reads.retired}
          onClick={() => { if (!disabled && !reads.retired) onOpen(); }}>{t("execution.allTasks")}</button>
      </div>
    </details>
  </aside>;
}
