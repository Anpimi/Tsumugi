import { useTranslation } from "react-i18next";
import type { DecisionPage } from "../../../decisionCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState, ProgressBar } from "../../../design-system/Feedback";
import { executionContext } from "../../../executionCommands";
import { languageName } from "../../../i18n/languageNames";
import type { ProjectView } from "../../../projectCommands";
import type { RecentWorkspacePosition } from "../../../recentProjects";
import { reviewCommands } from "../../../reviewCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceReads } from "../../../sourceQueries";
import styles from "./ProjectBrief.module.css";

export interface ProjectBriefProps {
  project: ProjectView;
  visible: boolean;
  disabled: boolean;
  briefEligible: boolean;
  previousPosition?: RecentWorkspacePosition | null;
  decisions: { page: DecisionPage | undefined; loading: boolean; error: unknown | null };
  onContinue: (position: RecentWorkspacePosition) => void;
  onEntries: (locale: string, preset: string) => void;
  onImport: () => void;
  onDecisions: () => void;
}

/** Counts are observations of existing read owners, never execution or review authority. */
export default function ProjectBrief({ project, visible, disabled, briefEligible, previousPosition, decisions,
  onContinue, onEntries, onImport, onDecisions }: ProjectBriefProps) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "projectBrief" }), reads = useSessionReads();
  const context = executionContext(project), locales = project.metadata.targetLocales;
  const active = visible && briefEligible && !reads.retired && context.projectId === reads.context.projectId
    && context.sessionToken === reads.context.sessionToken;
  const source = useSessionQuery({ ...sourceReads.scope(context), enabled: active });
  const snapshot = !source.error && !source.isFetching ? source.data?.currentSnapshot : undefined;
  const progress = useSessionQuery({ key: ["project-brief-progress", locales, source.data?.revision, snapshot],
    scopes: ["source", "translation", "review", "resources"], enabled: active && !!snapshot && locales.length > 0,
    // One canonical observation supplies all counts without creating retained
    // segment scopes that could evict the user's fixed editing queue.
    read: () => reviewCommands.eligibility({ ...context, locales: [...locales] }) });
  if (!visible || !briefEligible) return null;
  const current = active && !disabled;
  const report = !source.error && !source.isFetching && !progress.error && !progress.isFetching
    && progress.data?.sourceSnapshotId === snapshot ? progress.data : undefined;
  const empty = snapshot === null || !!report && locales.length > 0 && locales.every(locale => report.locales.find(value => value.locale === locale)?.checkedUnits === 0);
  const incomplete = !!source.error || !!progress.error || !!snapshot && !progress.isPending && !progress.isFetching
    && (!report || locales.some(locale => !report.locales.some(value => value.locale === locale)));
  const position = previousPosition && locales.includes(previousPosition.locale) ? previousPosition : null;
  const page = decisions.page?.projectId === context.projectId ? decisions.page : undefined;
  const decisionCount = decisions.loading ? t("decisionsLoading") : decisions.error !== null ? t("decisionsFailed")
    : !page || page.total === null && page.knownCount === 0 ? t("decisionsUnknown")
      : page.total === null ? t("decisionsPartial", { count: page.knownCount }) : t("decisions", { count: page.total });
  return <section className={styles.brief} aria-label={t("title")}>
    <h3>{t("title")}</h3><p className={styles.help}>{t("help")}</p>
    {source.isFetching || snapshot && progress.isFetching ? <LoadingState label={t("loading")}/> : null}
    {empty ? <p>{t("empty")}</p> : <>
      {!locales.length ? <p>{t("noLanguages")}</p> : <ul className={styles.languages}>{locales.map(locale => {
        const value = report?.locales.find(item => item.locale === locale), name = languageName(locale, i18n.resolvedLanguage ?? i18n.language);
        return <li key={locale}>
          <h4>{name}</h4>
          <p>{value ? t("progress", { selected: value.selectedUnits, total: value.checkedUnits }) : t("progressUnknown")}</p>
          {value && value.checkedUnits > 0
            ? <ProgressBar label={t("progressLabel", { locale: name })} value={value.selectedUnits} max={value.checkedUnits}/> : null}
          <p className={styles.help}>{value ? t("blocking", { count: value.blockingUnits }) : t("blockingUnknown")}</p>
        </li>;
      })}</ul>}
      <p>{decisionCount}</p><p className={styles.help}>{t("reviewSeparate")}</p>
    </>}
    {incomplete ? <Banner tone="warning" action={<Button size="sm" disabled={!current || source.isFetching || progress.isFetching} onClick={() => {
      if (!current) return;
      if (source.error) void source.refetch(); else void progress.refetch();
    }}>{t("refresh")}</Button>}>{t("partial")}</Banner> : null}
    <div className={styles.actions}>
      {empty ? <Button size="sm" variant="secondary" disabled={!current} onClick={() => { if (current) onImport(); }}>{t("import")}</Button> : <>
        {position ? <Button size="sm" variant="secondary" disabled={!current} onClick={() => { if (current) onContinue(position); }}>{t("continue", { entry: position.nativeKey, locale: position.locale })}</Button> : null}
        {locales[0] ? <Button size="sm" disabled={!current} onClick={() => { if (current) onEntries(locales[0], "all"); }}>{t("entries")}</Button>
          : <Button size="sm" disabled={!current} onClick={() => { if (current) onImport(); }}>{t("import")}</Button>}
        <Button size="sm" disabled={!current} onClick={() => { if (current) onDecisions(); }}>{t("openDecisions")}</Button>
      </>}
    </div>
  </section>;
}
