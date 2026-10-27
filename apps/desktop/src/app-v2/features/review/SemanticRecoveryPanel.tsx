import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AiSemanticReviewView } from "../../../aiSemanticReviewCommands";
import { semanticReviewRead } from "../../../aiSemanticReviewQueries";
import { CommandFailureDetails } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { useExecutionTaskSession, type TaskActivity } from "../../../ExecutionTaskSession";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import type { SessionReads } from "../../../sessionReads";
import type { CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { EntrySemanticCancelPayload, EntrySemanticPendingPayload, EntrySemanticTaskPayload, SemanticRecoveryPanelProps } from "./semanticTypes";
import styles from "./SemanticRecoveryPanel.module.css";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };

/** All views borrow the original attempt record. Hiding one does not invalidate another observer. */
export function useSemanticAttempt(attemptId: string | null, enabled: boolean) {
  const reads = useSessionReads(), options = semanticReviewRead(reads.context, attemptId), queryKey = reads.key(options.key);
  const query = useSessionQuery({ ...options, enabled: enabled && attemptId !== null && !reads.retired });
  const observed = useMemo(() => {
    const cache = reads.client.getQueryCache(), filter = { queryKey, exact: true };
    return { subscribe: (changed: () => void) => cache.subscribe(event => {
      if ((event.type === "updated" || event.type === "removed") && matchQuery(filter, event.query)) changed();
    }), snapshot: () => cache.find(filter)?.state };
  }, [reads, attemptId]);
  const record = useSyncExternalStore(observed.subscribe, observed.snapshot, observed.snapshot);
  return { key: options.key, query, record };
}
export function semanticReadCurrent(reads: SessionReads, key: QueryKey, data: unknown) {
  const record = reads.client.getQueryCache().find({ queryKey: reads.key(key), exact: true });
  return !reads.retired && !!record && record.state.status === "success" && record.state.fetchStatus === "idle" && record.state.error === null
    && !record.state.isInvalidated && record.state.data === data;
}
export function semanticReadProof(reads: SessionReads, key: QueryKey, data: unknown, version?: number) {
  const witness = reads.watchExactQuery(key), record = witness.current(), observed = version ?? record?.state.dataUpdateCount;
  return { current: () => !!record && witness.current() === record && record.state.dataUpdateCount === observed && semanticReadCurrent(reads, key, data), dispose: witness.dispose };
}
function originalRow(activity: TaskActivity, view: AiSemanticReviewView | null | undefined) {
  const { intent } = activity, unit = intent.unit;
  if (!view || intent.operation !== "ai-semantic-review" || intent.action !== "adopt-result" || view.detail.taskId !== intent.taskId
    || view.detail.attemptId !== intent.attemptId || view.detail.operation !== intent.operation || unit.itemIds.length !== 1 || unit.resultIds.length !== 1
    || unit.scopes.length !== 1) return null;
  const row = view.rows.find(item => item.itemId === unit.itemIds[0]), item = view.detail.items.find(item => item.status.itemId === unit.itemIds[0]);
  const captured = intent.items.find(item => item.status.itemId === unit.itemIds[0]);
  const observed = view.detail.recovery.units.find(value => value.unitId === unit.unitId);
  return row?.current && row.output && !row.run && item?.resultId === unit.resultIds[0] && item.scope.kind === "review-unit"
    && row.item.source.unitId === item.scope.id && row.item.source.targetLocale === item.scope.locale
    && JSON.stringify(item) === JSON.stringify(captured) && JSON.stringify(observed) === JSON.stringify(unit) ? row : null;
}

/** Recovery retains the original requests and never requires the currently displayed entry. */
export default function SemanticRecoveryPanel({ project, owner, commands, gate, viewId, disabled, visible, parentDialogId }: SemanticRecoveryPanelProps) {
  const { t } = useTranslation(), { t: w } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads(), tasks = useExecutionTaskSession();
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const semantic = owner.semantic, state = semantic.state, context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const activity = tasks.activity?.intent.operation === "ai-semantic-review" && tasks.activity.intent.action === "adopt-result" ? tasks.activity : null;
  // Keep the same read active while submit changes its own phase, so hiding this
  // observer cannot invalidate the evidence that submit is still checking.
  const original = useSemanticAttempt(activity?.intent.attemptId ?? null, visible && activity !== null);
  const mounted = useRef(false), working = useRef(false), root = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false), focus = useRef<{ scope: string; origin: Element | null } | null>(null);
  const scope = JSON.stringify([context.projectId, context.sessionToken, viewId, parentDialogId]);
  const live = useRef({ scope, visible, disabled });
  useLayoutEffect(() => { live.current = { scope, visible, disabled }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function present() {
    return mounted.current && visible && !disabled && !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
      && gate.getSnapshot().visibleViewId === viewId && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  }
  function stillPresent() { return present() && live.current.scope === scope && live.current.visible && !live.current.disabled; }
  useLayoutEffect(() => {
    const ticket = focus.current;
    if (!ticket || busy) return;
    focus.current = null;
    if (ticket.scope === scope && stillPresent() && (document.activeElement === document.body || document.activeElement === ticket.origin)) root.current?.focus();
  });
  async function run(work: () => Promise<unknown> | void) {
    if (!present() || working.current) return;
    const active = document.activeElement;
    const origin = active && root.current?.contains(active) ? active : null;
    working.current = true; setBusy(true);
    try { await work(); }
    finally { working.current = false; if (mounted.current) { focus.current = { scope, origin }; setBusy(false); } }
  }
  function pendingAvailability(payload: EntrySemanticPendingPayload | undefined, action: "check" | "retry" | "discard"): CommandAvailability {
    const pending = semantic.current().pending;
    if (!present() || working.current || semantic.current().busy || !payload || !pending || pending !== payload.pending) return unavailable;
    return action === "check" || pending.absent && (action === "discard" || semantic.preparationCurrent(pending.preparation)) ? { enabled: true } : unavailable;
  }
  function ownActivity(payload: EntrySemanticTaskPayload | undefined) {
    const current = tasks.currentActivity();
    return !!payload && current === payload.activity && current.intent.operation === "ai-semantic-review" && current.intent.action === "adopt-result";
  }
  function taskAvailability(payload: EntrySemanticTaskPayload | undefined, action: "confirm" | "check" | "retry" | "dismiss" | "refresh"): CommandAvailability {
    if (!present() || working.current || !ownActivity(payload) || !payload) return unavailable;
    const current = payload.activity;
    if (action === "confirm") return current.phase === "confirming" && tasks.canSubmit() && payload.queryVersion !== null
      && original.record?.dataUpdateCount === payload.queryVersion && semanticReadCurrent(reads, original.key, original.query.data)
      && originalRow(current, original.query.data) ? { enabled: true } : unavailable;
    if (action === "refresh") return current.phase === "confirming" && !original.query.isFetching ? { enabled: true } : unavailable;
    if (action === "dismiss") return !tasks.busy && current.phase !== "unknown" ? { enabled: true } : unavailable;
    return current.phase === "unknown" && !tasks.busy && !!current.prepare && (action === "check" || current.retryAllowed) ? { enabled: true } : unavailable;
  }
  async function confirm(payload: EntrySemanticTaskPayload) {
    if (!taskAvailability(payload, "confirm").enabled) return;
    const witness = semanticReadProof(reads, original.key, original.query.data, payload.queryVersion ?? undefined), intent = payload.activity.intent;
    const proof = () => stillPresent() && witness.current() && tasks.currentActivity()?.intent === intent && !!originalRow(payload.activity, original.query.data);
    try { await run(() => tasks.submit(proof)); } finally { witness.dispose(); }
  }
  const cancellations = Object.values(tasks.state).filter(value => semantic.current().attempts.includes(value.target.attemptId)
    && value.phase !== "recorded");
  function cancelAvailability(payload: EntrySemanticCancelPayload | undefined, retry: boolean): CommandAvailability {
    if (!present() || working.current || !payload) return unavailable;
    const current = tasks.current(payload.taskId), task = tasks.currentActivity();
    if (current?.phase !== "unknown" || current.target.attemptId !== payload.attemptId || current.request.requestId !== payload.requestId
      || !semantic.current().attempts.includes(payload.attemptId)) return unavailable;
    return !retry || current.retryAllowed && !(task?.intent.taskId === payload.taskId && !["confirming", "recorded", "rejected"].includes(task.phase)) ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { category: "review" as const, scope: commandScope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...meta, id: "review.entry-semantic-check-start", nameKey: "semanticReview.check", payloadKind: "entry-semantic-pending", risk: "reads-review", availability: value => pendingAvailability(value, "check"), handler: value => { if (pendingAvailability(value, "check").enabled) void run(() => semantic.check()); } }),
      commands.register({ ...meta, id: "review.entry-semantic-retry-start", nameKey: "semanticReview.retry", payloadKind: "entry-semantic-pending", risk: "retries-review-action", availability: value => pendingAvailability(value, "retry"), handler: value => { if (pendingAvailability(value, "retry").enabled) void run(() => semantic.retry()); } }),
      commands.register({ ...meta, id: "review.entry-semantic-discard-start", nameKey: "semanticReview.discardAbsent", payloadKind: "entry-semantic-pending", risk: "changes-view", availability: value => pendingAvailability(value, "discard"), handler: value => { if (pendingAvailability(value, "discard").enabled) semantic.discardAbsent(); } }),
      commands.register({ ...meta, id: "review.entry-semantic-confirm-record", nameKey: "semanticReview.confirmRecord", payloadKind: "entry-semantic-task", risk: "writes-execution", availability: value => taskAvailability(value, "confirm"), handler: value => { void confirm(value); } }),
      commands.register({ ...meta, id: "review.entry-semantic-check-record", nameKey: "semanticReview.checkRecord", payloadKind: "entry-semantic-task", risk: "reconciles-execution-action", availability: value => taskAvailability(value, "check"), handler: value => { if (taskAvailability(value, "check").enabled) void run(() => tasks.checkAdoption()); } }),
      commands.register({ ...meta, id: "review.entry-semantic-retry-record", nameKey: "semanticReview.retryRecord", payloadKind: "entry-semantic-task", risk: "retries-execution-action", availability: value => taskAvailability(value, "retry"), handler: value => { if (taskAvailability(value, "retry").enabled) void run(() => tasks.retryAdoption()); } }),
      commands.register({ ...meta, id: "review.entry-semantic-dismiss-record", nameKey: "semanticReview.closeRecord", payloadKind: "entry-semantic-task", risk: "changes-view", availability: value => taskAvailability(value, "dismiss"), handler: value => { if (taskAvailability(value, "dismiss").enabled) tasks.dismiss(); } }),
      commands.register({ ...meta, id: "review.entry-semantic-refresh-record", nameKey: "workbenchV2.entrySemanticRefreshOriginal", payloadKind: "entry-semantic-task", risk: "reads-review", availability: value => taskAvailability(value, "refresh"), handler: value => { if (taskAvailability(value, "refresh").enabled) void run(() => original.query.refetch()); } }),
      commands.register({ ...meta, id: "review.entry-semantic-check-cancel", nameKey: "workbenchV2.entrySemanticCheckStop", payloadKind: "entry-semantic-cancel", risk: "reads-execution", availability: value => cancelAvailability(value, false), handler: value => { if (cancelAvailability(value, false).enabled) void run(() => tasks.checkCancellation(value.taskId)); } }),
      commands.register({ ...meta, id: "review.entry-semantic-retry-cancel", nameKey: "workbenchV2.entrySemanticRetryStop", payloadKind: "entry-semantic-cancel", risk: "cancels-execution-task", availability: value => cancelAvailability(value, true), handler: value => { if (cancelAvailability(value, true).enabled) void run(() => tasks.retry(value.taskId)); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  const pending = state.pending, pendingPayload: EntrySemanticPendingPayload | null = pending ? { kind: "entry-semantic-pending", pending } : null;
  const taskPayload: EntrySemanticTaskPayload | null = activity ? { kind: "entry-semantic-task", activity, queryVersion: original.record?.dataUpdateCount ?? null } : null;
  const row = activity ? originalRow(activity, original.query.data) : null;
  const notice = state.notice === "stale" || state.notice === "newer" || state.notice === "started" ? state.notice : null;
  if (!visible || !pending && !activity && cancellations.length === 0 && !state.busy && !state.failure && !notice) return null;
  return <section className={styles.section} ref={root} tabIndex={-1} aria-label={w("entrySemanticRecovery")}>
    {state.busy ? <p role="status">{t(`semanticReview.busy.${state.busy}`)}</p> : null}
    {!pending && state.failure ? <Banner tone="error" role="alert">{w("entrySemanticFailed")}<CommandFailureDetails failure={state.failure}/></Banner> : null}
    {!pending && notice ? <Banner tone={notice === "started" ? "success" : "warning"} role="status">{notice === "started" ? w("entrySemanticStarted") : t(`semanticReview.notice.${notice}`)}</Banner> : null}
    {pending && pendingPayload ? <section className={styles.original} aria-label={t("semanticReview.original")}>
      <h4>{t("semanticReview.original")}</h4><Banner tone="warning" role="status">{w(pending.absent ? "entrySemanticStartAbsent" : "entrySemanticStartUnknown")}</Banner>
      <p className={styles.meta}>{pending.preparation.value.preview.config.model} · {pending.preparation.value.preview.config.endpoint}</p>
      <div className={styles.actions}>
        <Button size="sm" disabled={!pendingAvailability(pendingPayload, "check").enabled} onClick={() => commands.dispatch("review.entry-semantic-check-start", commandScope, pendingPayload)}>{t("semanticReview.check")}</Button>
        {pending.absent ? <><Button size="sm" disabled={!pendingAvailability(pendingPayload, "retry").enabled} onClick={() => commands.dispatch("review.entry-semantic-retry-start", commandScope, pendingPayload)}>{t("semanticReview.retry")}</Button>
          <Button size="sm" disabled={!pendingAvailability(pendingPayload, "discard").enabled} onClick={() => commands.dispatch("review.entry-semantic-discard-start", commandScope, pendingPayload)}>{t("semanticReview.discardAbsent")}</Button></> : null}
      </div>
    </section> : null}
    {activity && taskPayload ? <section className={styles.original} aria-label={t("semanticReview.recordTitle")}>
      <h4>{t("semanticReview.recordTitle")}</h4><p>{w("entrySemanticRecordHelp")}</p>
      {activity.phase === "confirming" ? <>
        {original.query.isFetching ? <p role="status">{t("semanticReview.reading")}</p> : null}
        {original.query.error || !original.query.isFetching && !row ? <Banner tone="warning" role="status">{w("entrySemanticOriginalChanged")}</Banner> : null}
        {row ? <><p>{row.item.source.nativeKey} → {row.item.source.targetLocale}</p><div className={styles.text}><TokenizedText text={row.item.source.sourceText}/></div>
          <div className={styles.text}>{row.item.translationText === "" ? w("editorEmptySelection") : <TokenizedText text={row.item.translationText}/>}</div>
          {row.output?.rules.map(rule => <section key={rule.rule}><h4>{t(`semanticReview.rule.${rule.rule}`)}</h4>
            {rule.findings.length ? rule.findings.map((finding, index) => <div className={styles.text} key={`${finding.code}:${index}`}><p><TokenizedText text={finding.detail}/></p>
              {finding.suggestion ? <p><TokenizedText text={finding.suggestion}/></p> : null}</div>) : <p>{t("semanticReview.noFindings")}</p>}</section>)}</> : null}
        <div className={styles.actions}><Button size="sm" variant="primary" disabled={!taskAvailability(taskPayload, "confirm").enabled} onClick={() => commands.dispatch("review.entry-semantic-confirm-record", commandScope, taskPayload)}>{t("semanticReview.confirmRecord")}</Button>
          <Button size="sm" disabled={!taskAvailability(taskPayload, "refresh").enabled} onClick={() => commands.dispatch("review.entry-semantic-refresh-record", commandScope, taskPayload)}>{w("entrySemanticRefreshOriginal")}</Button></div>
      </> : activity.phase === "unknown" ? <><Banner tone="warning" role="status">{t("semanticReview.recordUnknown")}</Banner>
        <div className={styles.actions}><Button size="sm" disabled={!taskAvailability(taskPayload, "check").enabled} onClick={() => commands.dispatch("review.entry-semantic-check-record", commandScope, taskPayload)}>{t("semanticReview.checkRecord")}</Button>
          {activity.retryAllowed ? <Button size="sm" disabled={!taskAvailability(taskPayload, "retry").enabled} onClick={() => commands.dispatch("review.entry-semantic-retry-record", commandScope, taskPayload)}>{t("semanticReview.retryRecord")}</Button> : null}</div>
      </> : activity.phase === "recorded" ? <Banner tone="success" role="status">{w("entrySemanticRecorded")}</Banner>
        : activity.phase === "rejected" ? <Banner tone="error" role="alert">{w("entrySemanticRecordFailed")}<CommandFailureDetails failure={activity.failure}/></Banner>
          : <p role="status">{t("semanticReview.recording")}</p>}
      {!tasks.busy && activity.phase !== "unknown" ? <Button size="sm" disabled={!taskAvailability(taskPayload, "dismiss").enabled} onClick={() => commands.dispatch("review.entry-semantic-dismiss-record", commandScope, taskPayload)}>{t("semanticReview.closeRecord")}</Button> : null}
    </section> : null}
    {cancellations.map(value => {
      const payload: EntrySemanticCancelPayload = { kind: "entry-semantic-cancel", taskId: value.target.taskId, attemptId: value.target.attemptId,
        requestId: value.request?.requestId ?? null, queryVersion: null };
      return <section className={styles.original} key={value.target.taskId} aria-label={w("entrySemanticStopStatus")}>
        <Banner tone={value.phase === "rejected" ? "error" : "warning"} role={value.phase === "rejected" ? "alert" : "status"}>{w(value.phase === "unknown" ? "entrySemanticStopUnknown" : value.phase === "rejected" ? "entrySemanticStopFailed" : "entrySemanticStopping")}</Banner>
        {value.phase === "unknown" ? <div className={styles.actions}><Button size="sm" disabled={!cancelAvailability(payload, false).enabled} onClick={() => commands.dispatch("review.entry-semantic-check-cancel", commandScope, payload)}>{w("entrySemanticCheckStop")}</Button>
          {value.retryAllowed ? <Button size="sm" disabled={!cancelAvailability(payload, true).enabled} onClick={() => commands.dispatch("review.entry-semantic-retry-cancel", commandScope, payload)}>{w("entrySemanticRetryStop")}</Button> : null}</div> : null}
      </section>;
    })}
  </section>;
}
