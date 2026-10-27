import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { aiCommands, type AiCandidateEffectView } from "../../../aiCommands";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState, Spinner } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { reviewFindingLabel, reviewRuleLabel } from "../../../reviewLabels";
import { ruleIdentity } from "../../../reviewIdentity";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { TranslationRevision } from "../../../translationCommands";
import type { CommandAvailability, WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import styles from "./CandidateEffectStatus.module.css";

export interface CandidateEffectStatusProps {
  revision: TranslationRevision;
  enabled: boolean;
  disabled: boolean;
  commands: WorkbenchCommands;
  gate: InteractionGate;
  viewId: string | null;
  parentDialogId?: string;
}
export const candidateEffectKey = (revision: TranslationRevision) => ["workbench-candidate-effect", revision.unitId, revision.locale,
  revision.revisionId, revision.sourceSnapshotId, revision.sourceRevisionId, revision.attemptId, revision.itemId, revision.resultId] as const;
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
const checkStatuses = { passed: "passed", "not-applicable": "notApplicable", findings: "findings", failed: "checkFailed", cancelled: "checkCancelled", unknown: "checkUnknown" } as const;
function checkStatus(status: string) { return Object.hasOwn(checkStatuses, status) ? checkStatuses[status as keyof typeof checkStatuses] : "qaUnavailable"; }

/** Historical evidence only. Reading this record cannot retry work or restore authority. */
export default function CandidateEffectStatus({ revision, enabled, disabled, commands, gate, viewId, parentDialogId }: CandidateEffectStatusProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), { t: legacy } = useTranslation(), reads = useSessionReads();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const key = candidateEffectKey(revision), identity = JSON.stringify(key);
  const query = useSessionQuery({ key, scopes: ["execution", "source", "translation", "review"], enabled: enabled && !disabled && !reads.retired,
    read: () => aiCommands.candidateEffect({ ...reads.context, unitId: revision.unitId, locale: revision.locale, revisionId: revision.revisionId }, revision), refetchOnMount: true });
  const record = useMemo(() => {
    const filters = { queryKey: reads.key(key), exact: true }, cache = reads.client.getQueryCache();
    return { subscribe: (notify: () => void) => cache.subscribe(event => { if (matchQuery(filters, event.query)) notify(); }),
      snapshot: () => reads.client.getQueryState<AiCandidateEffectView>(filters.queryKey) };
  }, [reads, identity]);
  const current = useSyncExternalStore(record.subscribe, record.snapshot, record.snapshot);
  const scope = { ...reads.context, area: "translation" as const };
  const loading = !reads.retired && (!current || current.fetchStatus === "fetching" || current.status === "pending"
    || current.status === "success" && (current.isInvalidated || current.data !== query.data || !query.data));
  const present = () => enabled && !disabled && !reads.retired && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const availability = (): CommandAvailability => present() && !loading ? { enabled: true } : unavailable;
  useLayoutEffect(() => {
    if (!enabled) return;
    return commands.register({ id: "translation.refresh-candidate-effect", nameKey: "workbenchV2.candidateEffectRefresh", category: "translation", scope,
      binding: null, confirmation: "none", risk: "reads-execution", availability, handler: () => { void query.refetch(); } });
  });
  if (!enabled) return null;
  const value = !reads.retired && !loading && current?.status === "success" ? query.data : null, effect = value?.effect, receipt = effect?.receipt;
  const uncertain = !!effect?.error && (effect.error.code === "outcome-unknown" || effect.error.outcome === "unknown");
  return <div className={styles.content}>
    <div className={styles.content}>{reads.retired ? <Banner>{t("candidateEffectUnavailable")}</Banner> : loading ? <LoadingState label={t("candidateEffectLoading")} />
      : current?.status === "error" ? <ErrorState title={t("candidateEffectReadFailed")} description={t("candidateEffectHelp")} /> : value ? <>
    <p className={styles.meta}>{t("candidateEffectHelp")}</p>
    {effect ? <>
      <p role="status">{t("candidateEffectPhase", { state: t(`candidateEffectStatuses.${effect.phase}`) })}</p>
      {!value.retained && receipt ? <p className={styles.meta}>{t("candidateEffectDetached")}</p> : null}
      {receipt ? <>
        {effect.phase === "selected" ? <p>{t("candidateEffectSelected")}</p> : effect.phase === "checked" ? <p>{t("candidateEffectChecked")}</p> : null}
        <p className={styles.meta}>{t("candidateEffectPolicy", { policy: legacy(`ai.plan.policies.${receipt.policy}`) })}</p>
        {receipt.blocked ? <Banner tone="warning">{t(receipt.blocked === "protected" ? "candidateEffectBlockedProtected"
          : receipt.blocked === "already-selected" ? "candidateEffectBlockedSelected" : "candidateEffectBlockedChecks")}</Banner> : null}
        <section aria-label={t("candidateEffectRules")}><ul className={styles.rules}>{receipt.rules.map(rule => <li className={styles.rule} key={ruleIdentity(rule.key)}>
          <h4>{reviewRuleLabel(legacy, rule.rule)}</h4>
          <p className={styles.meta}>{legacy(rule.mandatory ? "review.mandatoryRule" : "review.advisoryRule")}</p>
          <p>{legacy(`review.${checkStatus(rule.status)}`)}</p>
          {rule.findings.length ? <ul className={styles.findings}>{rule.findings.map(finding => <li key={finding.issueId}>
            <p>{reviewFindingLabel(legacy, rule.rule, finding.code)}</p>
            {finding.detail ? <div className={styles.detail}><TokenizedText text={finding.detail}/></div> : null}
          </li>)}</ul> : null}
        </li>)}</ul></section>
      </> : null}
      {effect.error ? <Banner tone={uncertain ? "warning" : "error"} role={uncertain ? "status" : "alert"}>
        <p>{t(uncertain ? "candidateEffectUnknown" : "candidateEffectFailed")}</p><CommandFailureDetails failure={commandFailure(effect.error)}/>
      </Banner> : null}
    </> : <EmptyState title={t("candidateEffectNoRecord")} />}
    </> : null}</div>
    <div className={styles.actions} aria-busy={loading || undefined}><Button size="sm" disabled={!present()} aria-disabled={!availability().enabled || undefined}
      icon={loading ? <Spinner/> : undefined}
      onClick={() => commands.dispatch("translation.refresh-candidate-effect", scope)}>{t("candidateEffectRefresh")}</Button></div>
  </div>;
}
