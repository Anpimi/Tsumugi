import { useTranslation } from "react-i18next";
import type { DecisionPage } from "../../../decisionCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState, ProgressBar } from "../../../design-system/Feedback";
import { executionContext } from "../../../executionCommands";
import { languageName } from "../../../i18n/languageNames";
import type { ProjectView } from "../../../projectCommands";
import type { RecentWorkspacePosition } from "../../../recentProjects";
import { segmentCommands, type SegmentPage, type SegmentQuery } from "../../../segmentCommands";
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

interface LocaleProgress {
  locale: string;
  total: number | null;
  selected: number | null;
  blocking: number | null;
  incomplete: boolean;
}
const all: SegmentQuery = { text: "", selection: "all", status: "all" };
const selected: SegmentQuery = { text: "", selection: "selected", status: "all" };
const blocking: SegmentQuery = { text: "", selection: "all", status: "blocking" };
const sameObservation = (left: SegmentPage, right: SegmentPage) => left.sourceSnapshotId === right.sourceSnapshotId
  && left.epoch === right.epoch && left.sequence === right.sequence;

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
    scopes: ["source", "translation", "review", "resources"], enabled: active && !!snapshot,
    read: async () => Promise.all(locales.map(async (locale): Promise<LocaleProgress> => {
      const unknown: LocaleProgress = { locale, total: null, selected: null, blocking: null, incomplete: true };
      const read = (query: SegmentQuery) => segmentCommands.page({ ...context, locale, query, scopeId: null, cursor: null, limit: 1 });
      let base: SegmentPage;
      try { base = await read(all); } catch { return unknown; }
      if (reads.retired || base.sourceSnapshotId !== snapshot) return unknown;
      // A segment scope is bound to its complete query. Each filter therefore
      // owns a scope; only counts from the same committed observation combine.
      const results = await Promise.allSettled([read(selected), read(blocking)]);
      const count = (result: PromiseSettledResult<SegmentPage>) => result.status === "fulfilled"
        && sameObservation(base, result.value) && result.value.total <= base.total ? result.value.total : null;
      const selectedCount = count(results[0]), blockingCount = count(results[1]);
      return { locale, total: base.total, selected: selectedCount, blocking: blockingCount,
        incomplete: selectedCount === null || blockingCount === null };
    })) });
  if (!visible || !briefEligible) return null;
  const current = active && !disabled;
  const values = !source.error && !source.isFetching && !progress.error && !progress.isFetching ? progress.data : undefined;
  const empty = snapshot === null || !!values?.length && values.every(value => value.total === 0);
  const incomplete = !!source.error || !!progress.error || values?.some(value => value.incomplete);
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
        const value = values?.find(item => item.locale === locale), name = languageName(locale, i18n.resolvedLanguage ?? i18n.language);
        return <li key={locale}>
          <h4>{name}</h4>
          <p>{value?.total === undefined || value.total === null ? t("progressUnknown") : value.selected === null
            ? t("selectionUnknown", { total: value.total }) : t("progress", { selected: value.selected, total: value.total })}</p>
          {value?.selected != null && value.total !== null && value.total > 0
            ? <ProgressBar label={t("progressLabel", { locale: name })} value={value.selected} max={value.total}/> : null}
          <p className={styles.help}>{value?.blocking == null ? t("blockingUnknown") : t("blocking", { count: value.blocking })}</p>
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
