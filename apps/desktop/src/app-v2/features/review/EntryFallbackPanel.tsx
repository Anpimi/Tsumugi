import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { reviewDraftKey } from "../../../ReviewDraftSession";
import type { FallbackDecision, ReviewTarget } from "../../../reviewCommands";
import { sameReviewBasis } from "../../../reviewDiagnosticNavigation";
import { useSessionReads } from "../../../SessionReadProvider";
import type { CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { EntryFallbackPanelProps, EntryFallbackPayload } from "./fallbackTypes";
import styles from "./EntryFallbackPanel.module.css";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
function targetCapture(target: ReviewTarget) {
  return { unitId: target.unitId, locale: target.locale, basis: target.basis, sourceSnapshotId: target.sourceSnapshotId,
    sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, basisEvidence: target.basisEvidence,
    expectedFallbackId: target.currentFallback?.fallbackId ?? null };
}
function sameTarget(left: ReturnType<typeof targetCapture>, right: ReturnType<typeof targetCapture>) {
  return left.unitId === right.unitId && left.locale === right.locale && left.basis === right.basis
    && left.sourceSnapshotId === right.sourceSnapshotId && left.sourceRevisionId === right.sourceRevisionId
    && left.selectionId === right.selectionId && left.revisionId === right.revisionId && left.expectedFallbackId === right.expectedFallbackId
    && sameReviewBasis(left.basisEvidence, right.basisEvidence);
}

/** Uses the retained human-review audit and original fallback mutation boundary. */
export default function EntryFallbackPanel({ project, target, owner, drafts, commands, gate, viewId, disabled, visible, parentDialogId, read }: EntryFallbackPanelProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), { t: legacy } = useTranslation(), reads = useSessionReads();
  const state = owner.state, shared = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const queryIdentity = JSON.stringify(read.key), scope = JSON.stringify([context.projectId, context.sessionToken, target.unitId, target.locale, viewId]);
  const identity = JSON.stringify([scope, targetCapture(target)]);
  const record = useMemo(() => {
    const cache = reads.client.getQueryCache(), filters = { queryKey: reads.key(read.key), exact: true };
    return { subscribe: (notify: () => void) => cache.subscribe(event => { if (matchQuery(filters, event.query)) notify(); }), snapshot: () => cache.find(filters)?.state };
  }, [reads, queryIdentity]);
  const queryState = useSyncExternalStore(record.subscribe, record.snapshot, record.snapshot);
  const mounted = useRef(false), flight = useRef(false), bound = useRef<{ scope: string; data: unknown; version: number } | null>(null);
  const root = useRef<HTMLElement>(null), result = useRef<HTMLDivElement>(null), focus = useRef<{ scope: string; origin: HTMLButtonElement } | null>(null);
  const clicked = useRef<HTMLButtonElement | null>(null), live = useRef({ visible, disabled, scope, identity, viewId, parentDialogId });
  const [working, setWorking] = useState(false), [feedback, setFeedback] = useState<{ scope: string; kind: "recorded" | "conflict" | "failed" | "changed" } | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { visible, disabled, scope, identity, viewId, parentDialogId }; });
  function present() {
    return mounted.current && visible && !disabled && !reads.retired && !drafts.getSnapshot().retired
      && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
      && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  }
  const sameView = () => present() && live.current.visible && !live.current.disabled && live.current.scope === scope
    && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId;
  const stillPresent = () => sameView() && live.current.identity === identity;
  useLayoutEffect(() => {
    const ticket = focus.current; if (!ticket || working) return; focus.current = null;
    if (ticket.scope === scope && sameView() && (document.activeElement === document.body || document.activeElement === ticket.origin)) result.current?.focus();
  });
  function currentRead() {
    const current = reads.client.getQueryCache().find({ queryKey: reads.key(read.key), exact: true });
    return !reads.retired && !!current && current.state.status === "success" && current.state.fetchStatus === "idle" && current.state.error === null
      && !current.state.isInvalidated && current.state.data === read.data;
  }
  function readProof() {
    const witness = reads.watchExactQuery(read.key), original = witness.current(), version = original?.state.dataUpdateCount;
    return { current: () => witness.current() === original && !!original && original.state.dataUpdateCount === version && currentRead(), dispose: witness.dispose };
  }
  // No selection is required to bind the original owner. A retained reason
  // keeps its old evidence until the explicit human-review basis action.
  useEffect(() => {
    if (!present() || !project.metadata.targetLocales.includes(target.locale) || !currentRead() || !queryState) return;
    const before = owner.current(), selected = before.selected, sameEntity = selected?.unitId === target.unitId && selected.locale === target.locale;
    if (sameEntity && bound.current?.scope === scope && bound.current.data === read.data && bound.current.version === queryState.dataUpdateCount) return;
    bound.current = { scope, data: read.data, version: queryState.dataUpdateCount };
    if (before.locale !== target.locale) owner.setLocale(target.locale);
    if (!sameEntity || !selected) owner.setSelected(target);
    else owner.observeProjection(target, { unitId: selected.unitId, locale: selected.locale, basis: selected.basis, editSeq: before.editSeq[reviewDraftKey(selected)] ?? 0 });
  });
  function audit() {
    const current = owner.current(), selected = current.selected;
    if (!selected || selected.unitId !== target.unitId || selected.locale !== target.locale) return null;
    const key = reviewDraftKey(selected);
    return { ...targetCapture(selected), actor: current.actor, reason: current.drafts[key] ?? "", editSeq: current.editSeq[key] ?? 0 };
  }
  function available(payload: EntryFallbackPayload | undefined): CommandAvailability {
    const current = owner.current(), captured = audit(), shared = drafts.getSnapshot(), fallback = target.currentFallback;
    return present() && project.metadata.targetLocales.includes(target.locale) && currentRead() && !flight.current && !owner.inFlight()
      && !current.busyMutation && !current.pending && !current.batchRunning && shared.hydration === "ready" && !shared.mutationReserved
      && target.selectionId === null && target.revisionId === null && target.translationText === null && !!payload && !!captured
      && sameTarget(captured, targetCapture(target)) && sameTarget(payload, captured) && payload.actor === captured.actor && payload.reason === captured.reason && payload.editSeq === captured.editSeq
      && payload.actor.trim() !== "" && payload.reason.trim() !== "" && (payload.allow ? payload.expectedFallbackId === null
        : payload.expectedFallbackId !== null && fallback?.allow === true && fallback.unitId === target.unitId && fallback.locale === target.locale && fallback.sourceRevisionId === target.sourceRevisionId)
      ? { enabled: true } : unavailable;
  }
  async function change(payload: EntryFallbackPayload) {
    if (!available(payload).enabled) return;
    const witness = readProof(), before = owner.current().completionVersion;
    const origin = clicked.current ?? (document.activeElement instanceof HTMLButtonElement && root.current?.contains(document.activeElement) ? document.activeElement : null);
    // Audit B is editable during A. The original owner captures A before its
    // identity wait; only current external facts belong in this async proof.
    const proof = () => stillPresent() && witness.current() && project.metadata.targetLocales.includes(target.locale)
      && sameTarget(payload, targetCapture(target)) && target.selectionId === null;
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      await owner.fallback(payload.allow, proof);
      if (sameView()) {
        const after = owner.current();
        if (after.completionVersion !== before) setFeedback({ scope, kind: "recorded" });
        else if (!after.pending) setFeedback({ scope, kind: after.notice === "conflict" ? "conflict" : after.notice === "error" ? "failed" : "changed" });
      }
    } finally { witness.dispose(); flight.current = false; if (mounted.current) { if (origin) focus.current = { scope, origin }; setWorking(false); } }
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "review" as const, scope: commandScope, binding: null, confirmation: "none" as const, payloadKind: "entry-review-fallback" as const, risk: "writes-review" as const };
    const remove = [
      commands.register({ ...metadata, id: "review.entry-allow-fallback", nameKey: "workbenchV2.entryFallbackAllow", availability: payload => payload?.allow === true ? available(payload) : unavailable, handler: payload => { void change(payload); } }),
      commands.register({ ...metadata, id: "review.entry-withdraw-fallback", nameKey: "workbenchV2.entryFallbackWithdraw", availability: payload => payload?.allow === false ? available(payload) : unavailable, handler: payload => { void change(payload); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  function dispatch(button: HTMLButtonElement, payload: EntryFallbackPayload) {
    clicked.current = button;
    try { commands.dispatch(payload.allow ? "review.entry-allow-fallback" : "review.entry-withdraw-fallback", commandScope, payload); }
    finally { clicked.current = null; }
  }
  const captured = audit(), allowPayload: EntryFallbackPayload | null = captured ? { ...captured, kind: "entry-review-fallback", allow: true } : null;
  const withdrawPayload: EntryFallbackPayload | null = captured ? { ...captured, kind: "entry-review-fallback", allow: false } : null;
  const fresh = currentRead(), fallback = target.currentFallback, selected = state.selected;
  const earlier = selected?.unitId === target.unitId && selected.locale === target.locale && selected.currentFallback
    && (selected.currentFallback.fallbackId !== fallback?.fallbackId || selected.currentFallback.sourceRevisionId !== target.sourceRevisionId) ? selected.currentFallback : null;
  const changed = !!captured && !sameTarget(captured, targetCapture(target)), selectedTranslation = target.selectionId !== null;
  const validFallback = fallback?.allow === true && fallback.unitId === target.unitId && fallback.locale === target.locale && fallback.sourceRevisionId === target.sourceRevisionId;
  const pending = state.pending?.kind === "fallback" ? state.pending : null, message = feedback?.scope === scope ? feedback : null;
  function recordAudit(record: FallbackDecision) {
    return <><p className={styles.meta}>{record.actor} · <time dateTime={record.createdAt}>{record.createdAt}</time></p>
      <div className={styles.text}><TokenizedText text={record.reason}/></div>
      <details><summary>{legacy("execution.diagnostic")}</summary><p>{t("entryHistoryPolicy", { policy: record.policyVersion })}</p>
        <p>{t("entryFallbackSourceRevision")} <code>{record.sourceRevisionId}</code></p><code>{record.fallbackId}</code></details></>;
  }
  if (!visible) return null;
  return <section ref={root} className={styles.section} aria-label={t("entryFallbackTitle")}>
    <h3>{t("entryFallbackTitle")}</h3><p className={styles.meta}>{t("entryFallbackHelp", { sourceLocale: project.metadata.sourceLocale, locale: target.locale })}</p>
    {!project.metadata.targetLocales.includes(target.locale) ? <Banner tone="warning">{t("entryReviewLocaleUnavailable")}</Banner> : null}
    {!fresh ? queryState?.status === "error" ? <Banner tone="warning" role="alert"><p>{t("entryFallbackReadFailed")}</p><CommandFailureDetails failure={commandFailure(queryState.error)}/></Banner>
      : queryState?.fetchStatus === "fetching" || queryState?.status === "pending" ? <LoadingState label={t("entryFallbackLoading")}/>
        : <Banner tone="warning" role="status">{t("entryFallbackChanged")}</Banner>
      : <div className={styles.record}><p role="status">{t(selectedTranslation ? "entryFallbackSelected" : validFallback ? "entryFallbackActive" : fallback ? "entryFallbackOutdated" : "entryFallbackAbsent")}</p>
        {fallback ? recordAudit(fallback) : null}</div>}
    <p className={styles.meta}>{t("entryFallbackHistoryHelp")}</p>
    {changed ? <Banner tone="warning" role="status">{t("entryFallbackBasisChanged")}</Banner> : null}
    {earlier ? <details><summary>{t("entryFallbackEarlier")}</summary><p className={styles.meta}>{t("entryFallbackOutdated")}</p>{recordAudit(earlier)}</details> : null}
    <p className={styles.meta}>{t("entryFallbackAuditHelp")}</p>
    <div ref={result} tabIndex={-1} role="group" aria-label={t("entryFallbackResult")} className={styles.result}>
      {pending ? <Banner tone="warning" role="status"><p>{t(state.pendingUncertain ? "entryFallbackUnknown" : "entryFallbackWorking")}</p>
        <p>{t("entryReviewOriginalAudit", { actor: pending.request.actor, locale: pending.request.locale })}</p>
        <div className={styles.text}><TokenizedText text={pending.request.reason}/></div><CommandFailureDetails failure={state.reasonValue}/></Banner>
        : state.pending ? <Banner tone="warning">{t("entryFallbackOtherPending")}</Banner> : null}
      {message ? <Banner tone={message.kind === "recorded" ? "success" : message.kind === "failed" ? "error" : "warning"} role={message.kind === "failed" ? "alert" : "status"}>
        <p>{t(message.kind === "recorded" ? "entryFallbackRecorded" : message.kind === "conflict" ? "entryFallbackConflict" : message.kind === "failed" ? "entryFallbackFailed" : "entryFallbackChanged")}</p>
        {message.kind === "failed" || message.kind === "conflict" ? <CommandFailureDetails failure={state.reasonValue}/> : null}</Banner> : null}
      {!state.pending && shared.mutationReserved && !working && !state.busyMutation ? <p className={styles.meta}>{t("entryReviewSharedBusy")}</p> : null}
    </div>
    <div className={styles.actions} aria-busy={working || state.busyMutation || undefined}>
      <Button size="sm" disabled={!allowPayload || !available(allowPayload).enabled} onClick={event => { if (allowPayload) dispatch(event.currentTarget, allowPayload); }}>{t("entryFallbackAllow")}</Button>
      <Button size="sm" disabled={!withdrawPayload || !available(withdrawPayload).enabled} onClick={event => { if (withdrawPayload) dispatch(event.currentTarget, withdrawPayload); }}>{t("entryFallbackWithdraw")}</Button>
    </div>
  </section>;
}
