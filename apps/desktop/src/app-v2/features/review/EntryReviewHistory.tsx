import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { matchQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { executionContext } from "../../../executionCommands";
import { capturedRuleLabel } from "../../../ReviewCheckers";
import { reviewFindingLabel } from "../../../reviewLabels";
import { ruleIdentity } from "../../../reviewIdentity";
import { reviewCommands, type CheckRun, type ReviewBasis, type ReviewTarget } from "../../../reviewCommands";
import { useSessionReads } from "../../../SessionReadProvider";
import type { ChangeScope } from "../../../sessionReads";
import type { CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { EntryReviewHistoryProps, ReviewHistoryCommandPayload } from "./historyTypes";
import styles from "./EntryReviewHistory.module.css";

const pageSize = 20;
const scopes: ChangeScope[] = ["source", "translation", "resources", "review"];
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
export const reviewHistoryKey = (target: Pick<ReviewTarget, "unitId" | "locale">, offset: number) => ["review-history", target.unitId, target.locale, offset, pageSize] as const;
function sameBasis(left: ReviewBasis, right: ReviewBasis) {
  return left.sourceSnapshotId === right.sourceSnapshotId && left.sourceRevisionId === right.sourceRevisionId
    && left.selectionId === right.selectionId && left.revisionId === right.revisionId && left.contextRevisionId === right.contextRevisionId
    && left.termRevisionIds.length === right.termRevisionIds.length && left.termRevisionIds.every((id, index) => id === right.termRevisionIds[index]);
}

/** Read the original bounded history; only the view owns its page position. */
export default function EntryReviewHistory({ project, target, commands, gate, viewId, disabled, visible, parentDialogId, offset, onOffset }: EntryReviewHistoryProps) {
  const { t } = useTranslation(), { t: w } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const entity = JSON.stringify([context.projectId, context.sessionToken, target.unitId, target.locale]);
  const identity = JSON.stringify([entity, target.basis, target.sourceSnapshotId, target.sourceRevisionId, target.selectionId, target.revisionId, viewId, parentDialogId]);
  const requestedIdentity = JSON.stringify(reviewHistoryKey(target, offset));
  const requestedRecord = useMemo(() => {
    const cache = reads.client.getQueryCache(), filters = { queryKey: reads.key(reviewHistoryKey(target, offset)), exact: true };
    let invalidated = false;
    return { subscribe: (changed: () => void) => cache.subscribe(event => {
      if (!matchQuery(filters, event.query)) return;
      if (event.type === "updated") {
        // A failed read also sets Query's isInvalidated flag. Only an actual
        // invalidation event supersedes this requested page's position.
        if (event.action.type === "invalidate") invalidated = true;
        changed();
      } else if (event.type === "removed") changed();
    }), snapshot: () => cache.find(filters)?.state, invalidated: () => invalidated };
  }, [reads, requestedIdentity]);
  useSyncExternalStore(requestedRecord.subscribe, requestedRecord.snapshot, requestedRecord.snapshot);
  const invalidatedLaterPage = offset > 0 && requestedRecord.invalidated();
  const pageOffset = invalidatedLaterPage ? 0 : offset;
  const key = reviewHistoryKey(target, pageOffset), queryKey = reads.key(key);
  const mounted = useRef(false), root = useRef<HTMLElement>(null), results = useRef<HTMLDivElement>(null);
  const focus = useRef<{ identity: string; offset: number; origin: Element | null } | null>(null);
  const live = useRef({ identity, visible, disabled, offset, onOffset });
  useLayoutEffect(() => { live.current = { identity, visible, disabled, offset, onOffset }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; focus.current = null; }; }, []);
  const contextCurrent = !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken;
  const readable = contextCurrent && project.metadata.targetLocales.includes(target.locale) && Number.isSafeInteger(pageOffset) && pageOffset >= 0;
  const query = useQuery({ queryKey, enabled: visible && readable, meta: { scopes }, queryFn: async ({ signal }) => {
    // Session invalidation may ask active observers to refetch before React has
    // committed the cursor reset. Never dispatch that obsolete offset again.
    if (pageOffset > 0 && requestedRecord.invalidated()) throw new Error("Review history page changed");
    const value = await reviewCommands.history({ ...context, unitId: target.unitId, locale: target.locale, offset: pageOffset, limit: pageSize });
    if (signal.aborted || reads.retired) throw new Error("Review history read cancelled");
    const groups = [value.decisions, value.checks, value.waivers, value.fallbacks];
    if (groups.some(rows => rows.length > pageSize || rows.some(row => row.unitId !== target.unitId || row.locale !== target.locale))
      || value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset <= pageOffset)) throw new Error("Review history does not match its page");
    return value;
  }, networkMode: "always", retry: false, staleTime: Infinity, gcTime: 60_000,
  refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: true });
  const page = query.data;

  useLayoutEffect(() => reads.subscribeChanges(affected => {
    if (!mounted.current || reads.retired || !affected.some(scope => scope === "project" || scopes.includes(scope))) return;
    if (live.current.offset > 0) live.current.onOffset(0);
  }), [reads]);
  useLayoutEffect(() => { if (invalidatedLaterPage && contextCurrent) onOffset(0); }, [invalidatedLaterPage, contextCurrent, onOffset]);
  useLayoutEffect(() => { if (!visible) focus.current = null; }, [visible]);

  function present() {
    return mounted.current && visible && !disabled && !reads.retired && contextCurrent && readable && gate.getSnapshot().visibleViewId === viewId
      && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  }
  function stillPresent() {
    return present() && live.current.identity === identity && live.current.visible && !live.current.disabled;
  }
  function currentPage() {
    const current = reads.client.getQueryCache().find({ queryKey, exact: true });
    return current?.state.status === "success" && current.state.fetchStatus === "idle" && current.state.error === null
      && !current.state.isInvalidated && current.state.data === page && page !== undefined;
  }
  function payloadMatches(payload: ReviewHistoryCommandPayload | undefined) {
    return !!payload && payload.unitId === target.unitId && payload.locale === target.locale;
  }
  function availability(payload: ReviewHistoryCommandPayload | undefined, action: "refresh" | "first" | "next"): CommandAvailability {
    const current = reads.client.getQueryState(queryKey);
    if (!present() || !payloadMatches(payload) || current?.fetchStatus === "fetching") return unavailable;
    if (action === "refresh") return payload?.offset === pageOffset ? { enabled: true } : unavailable;
    if (action === "first") return pageOffset > 0 && payload?.offset === 0 ? { enabled: true } : unavailable;
    return currentPage() && page?.nextOffset !== null && page?.nextOffset !== undefined && payload?.offset === page.nextOffset ? { enabled: true } : unavailable;
  }
  function rememberFocus(nextOffset: number) {
    const active = document.activeElement;
    focus.current = { identity, offset: nextOffset, origin: active && root.current?.contains(active) ? active : null };
  }
  async function refresh(payload: ReviewHistoryCommandPayload) {
    if (!availability(payload, "refresh").enabled) return;
    rememberFocus(pageOffset);
    await query.refetch();
    if (!stillPresent()) focus.current = null;
  }
  function move(payload: ReviewHistoryCommandPayload, action: "first" | "next") {
    if (!availability(payload, action).enabled) return;
    rememberFocus(payload.offset); onOffset(payload.offset);
  }
  useLayoutEffect(() => {
    const pending = focus.current;
    if (!pending || pending.identity !== identity || pending.offset !== pageOffset || query.isFetching) return;
    focus.current = null;
    if (stillPresent() && (document.activeElement === document.body || document.activeElement === pending.origin)) results.current?.focus();
  });
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "review" as const, scope: commandScope, binding: null, confirmation: "none" as const, risk: "reads-review" as const, payloadKind: "entry-review-history" as const };
    const remove = [
      commands.register({ ...metadata, id: "review.entry-history-refresh", nameKey: "workbenchV2.entryHistoryReload", availability: payload => availability(payload, "refresh"), handler: payload => { void refresh(payload); } }),
      commands.register({ ...metadata, id: "review.entry-history-first", nameKey: "workbenchV2.entryHistoryFirst", availability: payload => availability(payload, "first"), handler: payload => move(payload, "first") }),
      commands.register({ ...metadata, id: "review.entry-history-next", nameKey: "workbenchV2.entryHistoryNext", availability: payload => availability(payload, "next"), handler: payload => move(payload, "next") }),
    ];
    return () => remove.forEach(dispose => dispose());
  });

  function currency(current: boolean, changed: boolean) {
    const verified = !disabled && readable && !reads.retired && currentPage();
    return <><span className={styles.currency}>{w(!verified ? "entryHistoryUnverified" : current ? "entryHistoryCurrent" : "entryHistoryEarlier")}</span>
      {verified && changed ? <p className={styles.outdated}>{w("entryHistoryOutdated")}</p> : null}</>;
  }
  function ruleStatus(status: string) {
    return t(status === "passed" ? "review.passed" : status === "not-applicable" ? "review.notApplicable" : status === "findings" ? "review.findings"
      : status === "failed" ? "review.checkFailed" : status === "cancelled" ? "review.checkCancelled" : status === "unknown" ? "review.checkUnknown" : "review.qaUnavailable");
  }
  function checkCurrent(run: CheckRun) {
    const current = target.currentCheck;
    return current !== null && run.runId === current.runId && run.basis === target.basis && sameBasis(run.basisEvidence, target.basisEvidence)
      && (run.evidence?.qaBasis ?? null) === (current.evidence?.qaBasis ?? null);
  }
  function audit(item: { actor: string; reason: string; createdAt: string }) {
    return <><p className={styles.muted}>{item.actor} · <time dateTime={item.createdAt}>{item.createdAt}</time></p>
      {item.reason !== "" ? <p className={styles.text}><TokenizedText text={item.reason}/></p> : null}</>;
  }
  if (!visible) return null;
  const refreshPayload: ReviewHistoryCommandPayload = { kind: "entry-review-history", unitId: target.unitId, locale: target.locale, offset: pageOffset };
  const firstPayload: ReviewHistoryCommandPayload = { ...refreshPayload, offset: 0 };
  const nextPayload: ReviewHistoryCommandPayload | null = page?.nextOffset == null ? null : { ...refreshPayload, offset: page.nextOffset };
  const empty = page !== undefined && page.decisions.length + page.checks.length + page.waivers.length + page.fallbacks.length === 0;
  return <section className={styles.section} ref={root}>
    <h3 className={styles.title}>{w("entryHistoryTitle")}</h3>
    <div className={styles.actions}>
      <Button size="sm" disabled={!availability(refreshPayload, "refresh").enabled} onClick={() => commands.dispatch("review.entry-history-refresh", commandScope, refreshPayload)}>{w("entryHistoryReload")}</Button>
      <Button size="sm" disabled={!availability(firstPayload, "first").enabled} onClick={() => commands.dispatch("review.entry-history-first", commandScope, firstPayload)}>{w("entryHistoryFirst")}</Button>
      <Button size="sm" disabled={!availability(nextPayload ?? undefined, "next").enabled} onClick={() => { if (nextPayload) commands.dispatch("review.entry-history-next", commandScope, nextPayload); }}>{w("entryHistoryNext")}</Button>
    </div>
    <p className={styles.muted}>{w("entryHistoryPage", { page: Math.floor(pageOffset / pageSize) + 1 })}</p>
    <div className={styles.results} role="region" aria-label={w("entryHistoryTitle")} tabIndex={-1} ref={results}>
      {query.isFetching ? <p role="status" className={styles.muted}>{w("entryHistoryLoading")}</p> : null}
      {query.error ? <Banner tone="error" role="alert">{w("entryHistoryReadFailed")}</Banner> : null}
      {empty && !query.error ? <p className={styles.muted}>{w(pageOffset === 0 && page?.nextOffset === null ? "entryHistoryEmpty" : "entryHistoryPageEmpty")}</p> : null}
      {page?.decisions.length ? <section className={styles.group} aria-label={w("entryHistoryDecisions")}><h4 className={styles.heading}>{w("entryHistoryDecisions")}</h4>
        <ol className={styles.list}>{page.decisions.map(item => <li className={styles.record} key={item.decisionId}>
          <strong>{w(item.kind === "approve" ? "entryHistoryApprove" : "entryHistoryChanges")}</strong>{audit(item)}
          {currency(item.decisionId === target.currentDecision?.decisionId && item.basis === target.basis && sameBasis(item.basisEvidence, target.basisEvidence), item.basis !== target.basis || !sameBasis(item.basisEvidence, target.basisEvidence))}
        </li>)}</ol></section> : null}
      {page?.checks.length ? <section className={styles.group} aria-label={w("entryHistoryChecks")}><h4 className={styles.heading}>{w("entryHistoryChecks")}</h4>
        <ol className={styles.list}>{page.checks.map(run => <li className={styles.record} key={run.runId}>
          <div className={styles.summary}><strong>{t(run.outcome === "completed" ? "review.qaRun" : run.outcome === "failed" ? "review.checkFailed" : run.outcome === "cancelled" ? "review.checkCancelled" : "review.checkUnknown")}</strong>
            <time dateTime={run.createdAt}>{run.createdAt}</time></div>
          <p className={styles.muted}>{w("entryHistoryValidator", { version: run.validatorVersion })}</p>
          {currency(checkCurrent(run), run.basis !== target.basis || !sameBasis(run.basisEvidence, target.basisEvidence))}
          {run.rules.length === 0 ? <p className={styles.muted}>{w("entryHistoryNoRules")}</p> : <ul className={styles.rules}>{run.rules.map(rule => <li className={styles.rule} key={ruleIdentity(rule.key)}>
            <strong>{capturedRuleLabel(t, run, rule)} · {ruleStatus(rule.status)}</strong>
            <p className={styles.muted}>{w(rule.mandatory ? "entryHistoryMandatory" : "entryHistoryAdvisory")}</p>
            <p className={styles.muted}>{w("entryHistoryRuleVersion", { rule: rule.key.rule.id, schema: rule.key.rule.schemaVersion, behavior: rule.key.rule.behaviorVersion })}</p>
            {rule.key.implementation.kind === "plugin" ? <p className={styles.muted}>{rule.key.implementation.provider.plugin.publisher}/{rule.key.implementation.provider.plugin.id} {rule.key.implementation.provider.plugin.version}</p> : null}
            {rule.reason ? <p className={styles.muted}>{t(rule.status === "not-applicable" ? "review.noSelectedTranslationReason" : rule.status === "failed" ? "review.checkFailedHelp" : rule.status === "cancelled" ? "review.checkCancelledHelp" : rule.status === "unknown" ? "review.checkUnknownHelp" : "review.incompleteCoverageHelp")}</p> : null}
            {rule.findings.length ? <ul className={styles.findings}>{rule.findings.map(finding => <li key={finding.issueId}>{reviewFindingLabel(t, finding.rule, finding.code)}{finding.detail ? <p className={styles.text}><TokenizedText text={finding.detail}/></p> : null}</li>)}</ul> : null}
          </li>)}</ul>}
        </li>)}</ol></section> : null}
      {page?.waivers.length ? <section className={styles.group} aria-label={w("entryHistoryWaivers")}><h4 className={styles.heading}>{w("entryHistoryWaivers")}</h4>
        <ol className={styles.list}>{page.waivers.map(item => <li className={styles.record} key={item.waiverId}>
          <strong>{w(item.grant ? "entryHistoryWaiverGranted" : "entryHistoryWaiverRevoked")}</strong>{audit(item)}
          <p className={styles.muted}>{w("entryHistoryPolicy", { policy: item.policyVersion })}</p>
          {currency(item.grant && item.basis === target.basis && target.currentWaivers.some(waiver => waiver.waiverId === item.waiverId), item.basis !== target.basis)}
        </li>)}</ol></section> : null}
      {page?.fallbacks.length ? <section className={styles.group} aria-label={w("entryHistoryFallbacks")}><h4 className={styles.heading}>{w("entryHistoryFallbacks")}</h4>
        <ol className={styles.list}>{page.fallbacks.map(item => <li className={styles.record} key={item.fallbackId}>
          <strong>{w(item.allow ? "entryHistoryFallbackAllowed" : "entryHistoryFallbackWithdrawn")}</strong>{audit(item)}
          <p className={styles.muted}>{w("entryHistoryPolicy", { policy: item.policyVersion })}</p>
          {currency(item.allow && target.selectionId === null && item.fallbackId === target.currentFallback?.fallbackId && item.sourceRevisionId === target.sourceRevisionId, item.sourceRevisionId !== target.sourceRevisionId)}
        </li>)}</ol></section> : null}
    </div>
  </section>;
}
