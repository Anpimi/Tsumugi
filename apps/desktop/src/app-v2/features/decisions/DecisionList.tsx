import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, BookOpen, CircleDot, MessageSquare, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import type { DecisionItem, DecisionPage, DecisionSource, DecisionTarget } from "../../../decisionCommands";
import type { DecisionCoverage, DecisionCursor } from "../../../generated/decisions.responses";
import { Button } from "../../../design-system/Button";
import { Badge } from "../../../design-system/Badge";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { languageName } from "../../../i18n/languageNames";
import styles from "./Decisions.module.css";

export interface DecisionListProps {
  page: DecisionPage | undefined; loading: boolean; refreshing: boolean; error: unknown | null;
  selectedId: string | null; disabled: boolean; hasPrevious: boolean;
  onSelect: (item: DecisionItem) => void; onNext: (cursor: DecisionCursor) => void;
  onBack: () => void; onRefresh: () => void;
}
export interface DecisionTrayProps {
  page: DecisionPage | undefined; loading: boolean; error: unknown | null; disabled: boolean; onOpen: () => void;
}
export type DecisionBadgeProps = Pick<DecisionTrayProps, "page" | "loading" | "error">;

const sources = {
  "translation-candidate": { group: "decisionsCandidates", title: "decisionsCandidateTitle", help: "decisionsCandidateHelp", open: "decisionsCandidateOpen", icon: Sparkles, ai: true },
  "resource-proposal": { group: "decisionsResources", title: "decisionsResourceTitle", help: "decisionsResourceHelp", open: "decisionsResourceOpen", icon: BookOpen, ai: false },
  "agent-question": { group: "decisionsQuestions", title: "decisionsQuestionTitle", help: "decisionsQuestionHelp", open: "decisionsQuestionOpen", icon: MessageSquare, ai: true },
  "source-mapping": { group: "decisionsMappings", title: "decisionsMappingTitle", help: "decisionsMappingHelp", open: "decisionsMappingOpen", icon: CircleDot, ai: false },
  "execution-unknown": { group: "decisionsExecution", title: "decisionsExecutionTitle", help: "decisionsExecutionHelp", open: "decisionsExecutionOpen", icon: CircleDot, ai: false },
  "local-action-recovery": { group: "decisionsLocal", title: "decisionsLocalTitle", help: "decisionsLocalHelp", open: "decisionsLocalOpen", icon: CircleDot, ai: false },
  "human-review": { group: "decisionsReviews", title: "decisionsReviewTitle", help: "decisionsReviewHelp", open: "decisionsReviewOpen", icon: ShieldCheck, ai: false },
  "review-finding": { group: "decisionsFindings", title: "decisionsFindingTitle", help: "decisionsFindingHelp", open: "decisionsFindingOpen", icon: MessageSquare, ai: false },
  "delivery-blocker": { group: "decisionsBlockers", title: "decisionsBlockerTitle", help: "decisionsBlockerHelp", open: "decisionsBlockerOpen", icon: ShieldCheck, ai: false },
  "delivery-unknown": { group: "decisionsDelivery", title: "decisionsDeliveryTitle", help: "decisionsDeliveryHelp", open: "decisionsDeliveryOpen", icon: CircleDot, ai: false },
} as const satisfies Record<DecisionSource, object>;
const targetKeys = {
  entry: "decisionsTargetEntry", project: "decisionsTargetProject", plan: "decisionsTargetPlan", conversation: "decisionsTargetConversation",
  "source-occurrence": "decisionsTargetSource", resource: "decisionsTargetResource", delivery: "decisionsTargetDelivery",
  "source-result": "decisionsTargetSourceResult", "conversation-proposal": "decisionsTargetProposal",
} as const satisfies Record<DecisionTarget["kind"], string>;
const coverageKeys = {
  "source-limit": "decisionsSourceLimit", "source-unavailable": "decisionsSourceUnavailable",
  "source-not-implemented": "decisionsSourceNotConnected", "lifecycle-unavailable": "decisionsLifecycleUnavailable",
} as const;

function DecisionRow({ item, selected, disabled, onSelect }: {
  item: DecisionItem; selected: boolean; disabled: boolean; onSelect: (item: DecisionItem) => void;
}) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const description = useId(), source = sources[item.source], Icon = source.icon;
  const targets = [...new Set(item.targets.map(target => target.kind))];
  const locales = item.evidence?.kind === "delivery-outcome" ? item.evidence.locales : item.locale ? [item.locale] : [];
  return <li className={styles.row} data-selected={selected || undefined}>
    <Icon className={source.ai ? styles.aiIcon : styles.icon} aria-hidden="true"/>
    <div className={styles.rowBody}>
      <div className={styles.rowHeading}><h3>{t(item.action.kind === "clarify-conversation-proposal" ? "decisionsProposalQuestionTitle" : source.title)}</h3>
        {item.state !== "pending" ? <Badge tone="warning">{t(item.state === "stale" ? "decisionsStale" : "decisionsAwaitingRecheck")}</Badge> : null}
      </div>
      <p id={description}>{item.evidence?.kind === "delivery" ? t("decisionsBlockerCount", { count: item.evidence.blockerCount }) : t(source.help)}</p>
      <div className={styles.meta}>
        {targets.map(kind => <span key={kind}>{t(targetKeys[kind])}</span>)}
        {locales.map(locale => <span key={locale} lang={i18n.resolvedLanguage}>{languageName(locale, i18n.resolvedLanguage ?? i18n.language)}</span>)}
        {!item.targetsComplete ? <span>{t("decisionsPartialTargets")}</span> : null}
      </div>
      {item.evidence?.kind === "delivery-outcome" ? <p className={styles.fileSummary}>
        {t(item.evidence.unknownFileCount > 0 ? "decisionsDeliveryUnknownFiles" : "decisionsDeliveryFiles",
          { count: item.evidence.unknownFileCount > 0 ? item.evidence.unknownFileCount : item.evidence.fileCount })}
      </p> : null}
      {item.evidence?.kind === "proposal-questions" ? <p className={styles.fileSummary}>
        {t("decisionsProposalQuestions", { count: item.evidence.questionCount })}
      </p> : null}
      {item.evidence?.kind === "source-comparison" ? <p className={styles.fileSummary}>
        {t("decisionsSourceMatches", { ambiguous: item.evidence.ambiguousCount, renamed: item.evidence.renameCandidateCount })}
      </p> : null}
      <div className={styles.rowActions}><Button size="sm" disabled={disabled} aria-current={selected ? "true" : undefined}
        aria-describedby={description} onClick={() => onSelect(item)}>{t(source.open)}<ArrowUpRight aria-hidden="true"/></Button></div>
    </div>
  </li>;
}

function IncompleteSources({ coverage }: { coverage: DecisionCoverage[] }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  return <Banner tone="warning"><p className={styles.partialHelp}>{t("decisionsPartial")}</p>
    <dl className={styles.coverage}>{coverage.filter(source => source.state !== "complete").map(source => <div key={source.source}>
      <dt>{t(sources[source.source].group)}</dt><dd>{t(source.source === "agent-question" && source.state === "partial" && source.reason === "source-not-implemented"
        ? "decisionsTeamQuestionsIncomplete" : source.reason ? coverageKeys[source.reason] : "decisionsSourceUnavailable")}</dd>
    </div>)}</dl>
  </Banner>;
}

export default function DecisionList({ page, loading, refreshing, error, selectedId, disabled, hasPrevious, onSelect, onNext, onBack, onRefresh }: DecisionListProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), heading = useId();
  const busy = loading || refreshing, failed = error !== null, blocked = disabled || busy || failed;
  const incomplete = page?.total === null;
  const groups = new Map<string, DecisionItem[]>();
  for (const item of page?.items ?? []) {
    const rows = groups.get(item.source);
    if (rows) rows.push(item); else groups.set(item.source, [item]);
  }
  const next = page?.next;
  const count = !page ? t("decisionsUnknownCount") : page.total !== null
    ? t(busy || failed ? "decisionsPreviousExactCount" : "decisionsExactCount", { count: page.total })
    : page.knownCount > 0 ? t(busy || failed ? "decisionsPreviousAtLeastCount" : "decisionsAtLeastCount", { count: page.knownCount }) : t("decisionsUnknownCount");
  return <section className={styles.document} aria-labelledby={heading} aria-busy={busy || undefined}>
    <header className={styles.header}><div><h1 id={heading}>{t("decisionsTitle")}</h1><p>{t("decisionsHelp")}</p></div>
      <Button size="sm" icon={<RefreshCw/>} pending={busy} disabled={disabled} onClick={onRefresh}>{t("decisionsRefresh")}</Button>
    </header>
    <p className={styles.count}>{count}</p>
    {!page ? busy ? <LoadingState label={t("decisionsLoading")}/> : failed
      ? <div role="alert"><ErrorState title={t("decisionsReadFailed")} description={t("decisionsReadFailedHelp")}/></div>
      : <EmptyState title={t("decisionsNotRead")} description={t("decisionsNotReadHelp")}/> : <>
      {failed ? <Banner tone="error" role="alert">{t("decisionsRefreshFailed")}</Banner> : null}
      {busy ? <p className={styles.refreshing} role="status">{t("decisionsRefreshing")}</p> : null}
      {incomplete ? <IncompleteSources coverage={page.coverage}/> : null}
      {page.items.length === 0 ? page.knownCount > 0
        ? <EmptyState title={t("decisionsPageEmpty")} description={t("decisionsPageEmptyHelp")}/>
        : incomplete ? <EmptyState title={t("decisionsPartialEmpty")} description={t("decisionsPartialEmptyHelp")}/>
          : <EmptyState title={t(busy || failed ? "decisionsPreviousEmpty" : "decisionsEmpty")}
            description={t(busy || failed ? "decisionsPreviousEmptyHelp" : "decisionsEmptyHelp")}/>
        : <><p className={styles.pageHelp}>{t("decisionsPageHelp")}</p>
          {Object.entries(sources).map(([source, labels]) => {
            const rows = groups.get(source);
            return rows ? <section className={styles.group} key={source} aria-label={t(labels.group)}>
              <h2>{t(labels.group)}</h2><ul className={styles.rows}>{rows.map(item => <DecisionRow key={item.decisionId}
                item={item} selected={item.decisionId === selectedId} disabled={blocked} onSelect={onSelect}/>)}</ul>
            </section> : null;
          })}</>}
      <nav className={styles.pagination} aria-label={t("decisionsPagination")}>
        <Button size="sm" disabled={blocked || !hasPrevious} onClick={onBack}>{t("decisionsPrevious")}</Button>
        <Button size="sm" disabled={blocked || !next} onClick={() => { if (next) onNext(next); }}>{t("decisionsNext")}</Button>
      </nav>
    </>}
  </section>;
}

export function DecisionTray({ page, loading, error, disabled, onOpen }: DecisionTrayProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const label = loading ? t("decisionsTrayLoading") : error !== null ? t("decisionsTrayError")
    : !page || page.total === null && page.knownCount === 0 ? t("decisionsTrayUnknown")
      : page.total === null ? t("decisionsTrayPartial", { count: page.knownCount }) : t("decisionsTrayExact", { count: page.total });
  return <Button variant="ghost" className={styles.tray} disabled={disabled} onClick={onOpen} aria-label={label}>
    <CircleDot aria-hidden="true"/><span>{label}</span><ArrowUpRight aria-hidden="true"/>
  </Button>;
}

export function DecisionBadge({ page, loading, error }: DecisionBadgeProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  let label: string, text: string;
  if (loading) { label = t("decisionsBadgeLoading"); text = "…"; }
  else if (error !== null) { label = t("decisionsBadgeError"); text = "?"; }
  else if (!page) { label = t("decisionsBadgeUnread"); text = "?"; }
  else if (page.total !== null) { label = t("decisionsBadgeExact", { count: page.total }); text = t("decisionsBadgeNumber", { count: page.total }); }
  else if (page.knownCount > 0) { label = t("decisionsBadgePartial", { count: page.knownCount }); text = t("decisionsBadgePartialNumber", { count: page.knownCount }); }
  else { label = t("decisionsBadgeUnknown"); text = "?"; }
  return <Badge kind="count" tone={page?.total === null || error !== null ? "warning" : "ai"}
    className={styles.badge} aria-label={label}>{text}</Badge>;
}
