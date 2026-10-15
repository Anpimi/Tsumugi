import { useTranslation } from "react-i18next";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { executionCommands, executionContext, type TaskActivity, type TaskActivityRow } from "./executionCommands";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import type { ProjectView } from "./projectCommands";
import "./TaskDock.css";

const phases = ["active", "attention", "saved"] as const;
export function TaskDock({ project, disabled, onOpen }: {
  project: ProjectView; disabled: boolean; onOpen: (row?: TaskActivityRow) => void;
}) {
  const { t } = useTranslation(), reads = useSessionReads();
  const activity = useSessionQuery<TaskActivity>({ key: ["task-activity", 12], scopes: ["execution"],
    enabled: !reads.retired,
    read: () => executionCommands.activity({ ...executionContext(project), limit: 12 }),
  });
  const value = !activity.error ? activity.data : undefined;
  const unavailable = disabled || reads.retired || activity.isFetching || activity.isStale;
  return <aside className="task-dock" aria-label={t("execution.dock.title")}>
    <details>
      <summary>{t("execution.dock.title")}
        <span>{activity.error ? t("execution.dock.unavailable") : !value || activity.isFetching ? t("execution.loading")
          : value.total === "0" ? t("execution.dock.empty")
          : t("execution.dock.counts", { active: value.active, attention: value.attention, saved: value.saved })}</span>
      </summary>
      <div className="task-dock-content">
        {activity.error ? <div role="alert"><p>{t("execution.dock.readFailed")}</p>
          <CommandFailureDetails failure={commandFailure(activity.error)} />
          <button type="button" className="secondary-button" disabled={activity.isFetching || reads.retired} onClick={() => void activity.refetch()}>{t("execution.refresh")}</button>
        </div> : value ? <>
          <p>{t("execution.dock.scope", { shown: value.rows.length, total: value.total })}</p>
          <div className="task-dock-groups">{phases.map(phase => {
            const rows = value.rows.filter(row => row.phase === phase);
            return rows.length ? <section key={phase} aria-label={t(`execution.dock.${phase}`)}>
              <h2>{t(`execution.dock.${phase}`)}</h2><ul>{rows.map(row => <li key={row.taskId}>
                <button type="button" className="text-button" disabled={unavailable}
                  onClick={() => { if (!unavailable) onOpen(row); }}>
                  {t(row.operation === "source-import" ? "source.title" : row.operation === "translation-import" ? "translation.title"
                    : row.operation === "ai-translation" ? "ai.title" : row.operation === "locale-build" ? "release.title" : "execution.operation")}
                  {" · "}{t("execution.taskNumber", { number: row.sequence })}
                </button>
                <p>{t("execution.dock.progress", { running: row.progress.running, queued: row.progress.queued,
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
