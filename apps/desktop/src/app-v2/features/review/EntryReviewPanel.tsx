import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { isHumanReviewPending, reviewDraftKey } from "../../../ReviewDraftSession";
import type { ReviewTarget } from "../../../reviewCommands";
import { useSessionReads } from "../../../SessionReadProvider";
import type { CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { EntryReviewPanelProps, ReviewEntryBasisPayload, ReviewEntryCapture, ReviewEntryDecisionPayload, ReviewEntryPendingPayload, ReviewEntryTarget } from "./reviewTypes";
import styles from "./EntryReviewPanel.module.css";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
function targetCapture(target: ReviewTarget): ReviewEntryTarget {
  return { unitId: target.unitId, locale: target.locale, basis: target.basis, sourceSnapshotId: target.sourceSnapshotId,
    sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId,
    expectedDecisionId: target.currentDecision?.decisionId ?? null, expectedFallbackId: target.currentFallback?.fallbackId ?? null };
}
function sameTarget(left: ReviewEntryTarget, right: ReviewEntryTarget): boolean {
  return left.unitId === right.unitId && left.locale === right.locale && left.basis === right.basis
    && left.sourceSnapshotId === right.sourceSnapshotId && left.sourceRevisionId === right.sourceRevisionId
    && left.selectionId === right.selectionId && left.revisionId === right.revisionId && left.expectedDecisionId === right.expectedDecisionId
    && left.expectedFallbackId === right.expectedFallbackId;
}
function sameAudit(left: ReviewEntryCapture, right: ReviewEntryCapture): boolean {
  return sameTarget(left, right) && left.actor === right.actor && left.reason === right.reason && left.editSeq === right.editSeq;
}

/** The project owner retains input and original actions; this view supplies current read evidence. */
export default function EntryReviewPanel({ project, target, owner, drafts, commands, gate, viewId, disabled, visible, parentDialogId, read }: EntryReviewPanelProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads();
  const state = owner.state, draftState = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const queryIdentity = JSON.stringify(read.key);
  const record = useMemo(() => {
    const cache = reads.client.getQueryCache(), filters = { queryKey: reads.key(read.key), exact: true };
    return { subscribe: (notify: () => void) => cache.subscribe(event => { if (matchQuery(filters, event.query)) notify(); }),
      snapshot: () => cache.find(filters)?.state };
  }, [reads, queryIdentity]);
  const queryState = useSyncExternalStore(record.subscribe, record.snapshot, record.snapshot);
  const scope = JSON.stringify([context.projectId, context.sessionToken, target.unitId, target.locale, viewId]);
  const identity = JSON.stringify([scope, targetCapture(target)]), inputOwner = `entry-review-${useId()}`;
  const mounted = useRef(false), flight = useRef(false), bound = useRef<{ scope: string; data: unknown; version: number } | null>(null);
  const root = useRef<HTMLElement>(null), result = useRef<HTMLDivElement>(null), focusResult = useRef<{ scope: string; origin: HTMLButtonElement } | null>(null);
  const clickedAction = useRef<HTMLButtonElement | null>(null);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ scope: string; kind: "saved" | "conflict" | "error" | "changed" } | null>(null);
  const live = useRef({ visible, disabled, identity, scope, viewId, parentDialogId });
  useLayoutEffect(() => { live.current = { visible, disabled, identity, scope, viewId, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { if (!visible) gate.releaseOwner(inputOwner); return () => gate.releaseOwner(inputOwner); }, [gate, inputOwner, visible]);

  function present() {
    return mounted.current && visible && !disabled && !reads.retired && !drafts.getSnapshot().retired
      && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
      && gate.getSnapshot().visibleViewId === viewId;
  }
  const interactionAllowed = () => gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const stillPresent = () => present() && live.current.visible && !live.current.disabled && live.current.identity === identity
    && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId && interactionAllowed();
  const sameView = () => present() && live.current.visible && !live.current.disabled && live.current.scope === scope
    && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId && interactionAllowed();
  useLayoutEffect(() => {
    const ticket = focusResult.current;
    if (!ticket) return;
    focusResult.current = null;
    if (ticket.scope === scope && sameView() && (document.activeElement === document.body || document.activeElement === ticket.origin)) result.current?.focus();
  });
  const actionFocused = () => clickedAction.current ?? (document.activeElement instanceof HTMLButtonElement && root.current?.contains(document.activeElement) ? document.activeElement : null);
  function fromButton(button: HTMLButtonElement, dispatch: () => void) {
    clickedAction.current = button;
    try { dispatch(); } finally { clickedAction.current = null; }
  }
  function inputAllowed() {
    const current = gate.getSnapshot(), topDialog = current.dialogs.at(-1);
    return present() && project.metadata.targetLocales.includes(target.locale) && !current.intentOwner && (!topDialog || topDialog === parentDialogId);
  }
  function currentRead() {
    const current = reads.client.getQueryCache().find({ queryKey: reads.key(read.key), exact: true });
    return !reads.retired && !!current && current.state.status === "success" && current.state.error === null && current.state.fetchStatus === "idle"
      && !current.state.isInvalidated && current.state.data === read.data;
  }
  function readProof() {
    const witness = reads.watchExactQuery(read.key), original = witness.current(), version = original?.state.dataUpdateCount;
    return { current: () => witness.current() === original && original !== undefined && original.state.dataUpdateCount === version && currentRead(), dispose: witness.dispose };
  }
  // New facts update the projection, while a reason keeps the evidence it was
  // written against until the reviewer explicitly adopts the current basis.
  useEffect(() => {
    if (!present() || !project.metadata.targetLocales.includes(target.locale) || !currentRead() || !queryState) return;
    const before = owner.current(), selected = before.selected;
    const sameEntity = selected?.unitId === target.unitId && selected.locale === target.locale;
    if (sameEntity && bound.current?.scope === scope && bound.current.data === read.data && bound.current.version === queryState.dataUpdateCount) return;
    bound.current = { scope, data: read.data, version: queryState.dataUpdateCount };
    if (before.locale !== target.locale) owner.setLocale(target.locale);
    if (!sameEntity) owner.setSelected(target);
    else owner.observeProjection(target, { unitId: selected.unitId, locale: selected.locale, basis: selected.basis, editSeq: before.editSeq[reviewDraftKey(selected)] ?? 0 });
  });

  function capture(): ReviewEntryCapture | null {
    const current = owner.current(), selected = current.selected;
    if (!selected || selected.unitId !== target.unitId || selected.locale !== target.locale) return null;
    const key = reviewDraftKey(selected);
    return { ...targetCapture(selected), actor: current.actor, reason: current.drafts[key] ?? "", editSeq: current.editSeq[key] ?? 0 };
  }
  function idle() {
    const current = owner.current(), shared = drafts.getSnapshot();
    return present() && project.metadata.targetLocales.includes(target.locale) && interactionAllowed() && !flight.current && !current.busyMutation && !current.pending && !current.batchRunning
      && !owner.inFlight() && shared.hydration === "ready" && !shared.mutationReserved;
  }
  function decisionAvailability(payload: ReviewEntryDecisionPayload | undefined): CommandAvailability {
    const audit = capture();
    return idle() && currentRead() && !!audit && !!payload && sameAudit(payload, audit) && sameTarget(audit, targetCapture(target))
      && target.selectionId !== null && target.revisionId !== null && target.translationText !== null && audit.actor.trim() !== ""
      && (payload.decision === "approve" || audit.reason.trim() !== "") ? { enabled: true } : unavailable;
  }
  function basisAvailability(payload: ReviewEntryBasisPayload | undefined): CommandAvailability {
    const audit = capture();
    return idle() && currentRead() && !!audit && !!payload && sameAudit(payload, audit) && sameTarget(payload.current, targetCapture(target))
      && !sameTarget(audit, payload.current) ? { enabled: true } : unavailable;
  }
  async function decide(payload: ReviewEntryDecisionPayload) {
    if (!decisionAvailability(payload).enabled) return;
    const witness = readProof(), before = owner.current().completionVersion;
    const restoreFocus = actionFocused();
    // The frozen audit is checked before dispatch. New input B is allowed while
    // identity/write A is pending and must not invalidate or replace A's audit.
    const proof = () => stillPresent() && project.metadata.targetLocales.includes(target.locale) && witness.current() && sameTarget(payload, targetCapture(target));
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      await owner.decide(payload.decision, proof);
      if (sameView()) {
        const after = owner.current();
        if (after.completionVersion !== before) setFeedback({ scope, kind: "saved" });
        else if (!after.pending) setFeedback({ scope, kind: after.notice === "conflict" ? "conflict" : after.notice === "error" ? "error" : "changed" });
      }
    } finally { witness.dispose(); flight.current = false; if (mounted.current) { if (restoreFocus) focusResult.current = { scope, origin: restoreFocus }; setWorking(false); } }
  }
  function adopt(payload: ReviewEntryBasisPayload) {
    if (!basisAvailability(payload).enabled) return;
    owner.observeProjection(target, { unitId: payload.unitId, locale: payload.locale, basis: payload.basis, editSeq: payload.editSeq });
    if (owner.adoptCurrent()) setFeedback(null);
  }
  const pending = state.pending && isHumanReviewPending(state.pending) ? state.pending : null;
  const pendingPayload: ReviewEntryPendingPayload | null = pending ? { kind: "entry-review-pending", pending } : null;
  function pendingAvailability(payload: ReviewEntryPendingPayload | undefined, retry = false): CommandAvailability {
    const current = owner.current();
    return present() && interactionAllowed() && !flight.current && !current.busyMutation && !current.checkingAction && !!payload
      && current.pending === payload.pending && current.pendingUncertain && (!retry || current.retryAllowed) ? { enabled: true } : unavailable;
  }
  async function recover(payload: ReviewEntryPendingPayload, retry: boolean) {
    if (!pendingAvailability(payload, retry).enabled) return;
    const restoreFocus = actionFocused();
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      if (retry) await owner.retryPending(); else await owner.checkPending();
      if (sameView() && !owner.current().pending) setFeedback({ scope, kind: "saved" });
    } finally { flight.current = false; if (mounted.current) { if (restoreFocus) focusResult.current = { scope, origin: restoreFocus }; setWorking(false); } }
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "review" as const, scope: commandScope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...metadata, id: "review.entry-approve", nameKey: "workbenchV2.entryReviewApprove", payloadKind: "entry-review-decision", risk: "writes-review", availability: payload => payload?.decision === "approve" ? decisionAvailability(payload) : unavailable, handler: payload => { void decide(payload); } }),
      commands.register({ ...metadata, id: "review.entry-request-changes", nameKey: "workbenchV2.entryReviewRequestChanges", payloadKind: "entry-review-decision", risk: "writes-review", availability: payload => payload?.decision === "request-changes" ? decisionAvailability(payload) : unavailable, handler: payload => { void decide(payload); } }),
      commands.register({ ...metadata, id: "review.entry-adopt-current", nameKey: "workbenchV2.entryReviewAdoptCurrent", payloadKind: "entry-review-basis", risk: "reads-review", availability: basisAvailability, handler: adopt }),
      commands.register({ ...metadata, id: "review.entry-check", nameKey: "workbenchV2.entryReviewCheck", payloadKind: "entry-review-pending", risk: "reads-review", availability: payload => pendingAvailability(payload), handler: payload => { void recover(payload, false); } }),
      commands.register({ ...metadata, id: "review.entry-retry", nameKey: "workbenchV2.entryReviewRetry", payloadKind: "entry-review-pending", risk: "retries-review-action", availability: payload => pendingAvailability(payload, true), handler: payload => { void recover(payload, true); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });

  const audit = capture(), selected = state.selected?.unitId === target.unitId && state.selected.locale === target.locale ? state.selected : null;
  const reasonTarget = selected ?? state.draftTargets[reviewDraftKey(target)] ?? target;
  const reason = state.drafts[reviewDraftKey(target)] ?? "";
  const approvePayload: ReviewEntryDecisionPayload | null = audit ? { ...audit, kind: "entry-review-decision", decision: "approve" } : null;
  const changesPayload: ReviewEntryDecisionPayload | null = audit ? { ...audit, kind: "entry-review-decision", decision: "request-changes" } : null;
  const basisPayload: ReviewEntryBasisPayload | null = audit ? { ...audit, kind: "entry-review-basis", current: targetCapture(target) } : null;
  const basisChanged = !!audit && !sameTarget(audit, targetCapture(target));
  const message = feedback?.scope === scope ? feedback : null, fresh = currentRead();
  const decision = target.currentDecision;
  const reviewStatus = !decision ? "entryReviewNotReviewed" : decision.basis !== target.basis ? "entryReviewOutdated"
    : decision.kind === "approve" ? "entryReviewApproved" : "entryReviewChangesRequested";
  const renderText = (text: string | null) => text === null ? t("editorNoSelection") : text === "" ? t("editorEmptySelection") : <TokenizedText text={text}/>;
  if (!visible) return null;
  return <section ref={root} className={styles.section} aria-label={t("entryReviewTitle")}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <h3 className={styles.title}>{t("entryReviewTitle")}</h3>
    <p className={styles.help}>{t("entryReviewHelp")}</p>
    {!project.metadata.targetLocales.includes(target.locale) ? <Banner tone="warning" role="status">{t("entryReviewLocaleUnavailable")}</Banner> : null}
    {!fresh ? <Banner tone="warning" role="status">{t("entryReviewReadChanged")}</Banner> : null}
    <div className={styles.translation}><h4>{t("entryReviewCurrentText")}</h4><div className={styles.text}>{renderText(target.translationText)}</div></div>
    {fresh ? <p className={styles.status}>{t(reviewStatus)}</p> : null}
    {target.selectionId === null || target.revisionId === null || target.translationText === null ? <p className={styles.help}>{t("entryReviewNoSelection")}</p> : null}
    {basisChanged ? <Banner tone="warning" role="status"><p>{t("entryReviewBasisChanged")}</p>
      {selected ? <div className={styles.text}>{renderText(selected.translationText)}</div> : null}
      <Button size="sm" disabled={!basisPayload || !basisAvailability(basisPayload).enabled} onClick={() => { if (basisPayload) commands.dispatch("review.entry-adopt-current", commandScope, basisPayload); }}>{t("entryReviewAdoptCurrent")}</Button>
    </Banner> : null}
    <div className={styles.fields} onFocusCapture={() => { if (inputAllowed()) gate.setInputOwner(viewId, inputOwner); }}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}>
      <Field label={t("entryReviewActor")} required description={t("entryReviewActorHelp")}>
        <TextInput autoComplete="name" value={state.actor} disabled={!inputAllowed()} onChange={event => { if (inputAllowed()) owner.setActor(event.target.value); }}/>
      </Field>
      <Field label={t("entryReviewReason")} description={t("entryReviewReasonHelp")}>
        <TextArea rows={3} value={reason} disabled={!inputAllowed()} onChange={event => { if (inputAllowed()) owner.editReason(reasonTarget, event.target.value); }}/>
      </Field>
    </div>
    <div ref={result} tabIndex={-1} role="group" aria-label={t("entryReviewResult")} className={styles.feedback}>
    {pending ? <Banner tone="warning" role="status"><p>{t(state.pendingUncertain ? "entryReviewUnknown" : "entryReviewWriting")}</p>
      <p className={styles.help}>{t("entryReviewOriginalAudit", { actor: pending.request.actor, locale: pending.request.locale })}</p>
      {pending.request.unitId !== target.unitId || pending.request.locale !== target.locale ? <p>{t("entryReviewOtherPending")}</p> : null}
      {pending.request.reason ? <div className={styles.text}><TokenizedText text={pending.request.reason}/></div> : null}
      <CommandFailureDetails failure={state.reasonValue}/>
      <div className={styles.actions}><Button size="sm" disabled={!pendingPayload || !pendingAvailability(pendingPayload).enabled} onClick={event => fromButton(event.currentTarget, () => { if (pendingPayload) commands.dispatch("review.entry-check", commandScope, pendingPayload); })}>{t("entryReviewCheck")}</Button>
        <Button size="sm" disabled={!pendingPayload || !pendingAvailability(pendingPayload, true).enabled} onClick={event => fromButton(event.currentTarget, () => { if (pendingPayload) commands.dispatch("review.entry-retry", commandScope, pendingPayload); })}>{t("entryReviewRetry")}</Button></div>
    </Banner> : state.pending ? <Banner tone="warning" role="status">{t("entryReviewOtherWork")}</Banner> : null}
    {message ? <Banner tone={message.kind === "saved" ? "success" : message.kind === "error" ? "error" : "warning"} role={message.kind === "error" ? "alert" : "status"}>
      {t(message.kind === "saved" ? "entryReviewSaved" : message.kind === "conflict" ? "entryReviewConflict" : message.kind === "error" ? "entryReviewFailed" : "entryReviewReadChanged")}
      {message.kind === "error" || message.kind === "conflict" ? <CommandFailureDetails failure={state.reasonValue}/> : null}
    </Banner> : null}
    {!state.pending && (working || state.busyMutation) ? <p role="status">{t("entryReviewWriting")}</p> : null}
    {!state.pending && draftState.mutationReserved && !working && !state.busyMutation ? <p className={styles.help}>{t("entryReviewSharedBusy")}</p> : null}
    </div>
    <div className={styles.actions} aria-busy={working || state.busyMutation || undefined}>
      <Button variant="primary" size="sm" disabled={!approvePayload || !decisionAvailability(approvePayload).enabled} onClick={event => fromButton(event.currentTarget, () => { if (approvePayload) commands.dispatch("review.entry-approve", commandScope, approvePayload); })}>{t("entryReviewApprove")}</Button>
      <Button size="sm" disabled={!changesPayload || !decisionAvailability(changesPayload).enabled} onClick={event => fromButton(event.currentTarget, () => { if (changesPayload) commands.dispatch("review.entry-request-changes", commandScope, changesPayload); })}>{t("entryReviewRequestChanges")}</Button>
    </div>
  </section>;
}
