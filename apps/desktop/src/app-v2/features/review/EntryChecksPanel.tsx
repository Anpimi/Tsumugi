import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { ReviewCheckerDetails, capturedRuleLabel, checkerIdentity, ruleIdentity } from "../../../ReviewCheckers";
import { isHumanReviewPending, reviewDraftKey } from "../../../ReviewDraftSession";
import type { CheckRuleResult, ReviewTarget } from "../../../reviewCommands";
import { reviewFindingLabel } from "../../../reviewLabels";
import { useSessionReads } from "../../../SessionReadProvider";
import { TextReviewSelections, type TextReviewDiscoveryState, type TextReviewSelectionsHandle } from "../../../TextReviewSelections";
import type { CommandAvailability } from "../../../workbenchCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { EntryChecksCapture, EntryChecksConsentPayload, EntryChecksDiscoveryPayload, EntryChecksPanelProps, EntryChecksPendingPayload,
  EntryChecksPreparation, EntryChecksPreparePayload, EntryChecksRemovePayload, EntryChecksRunPayload } from "./checksTypes";
import styles from "./EntryChecksPanel.module.css";
import buttonStyles from "../../../design-system/Button.module.css";

const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
type FeedbackKind = "prepared" | "saved" | "failed" | "cancelled" | "unknown" | "conflict" | "changed" | "cancelRequested";
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const targetCapture = (target: ReviewTarget) => ({ unitId: target.unitId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId,
  sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, basis: target.basis,
  currentRunId: target.currentCheck?.runId ?? null });
function sameBasis(left: ReturnType<typeof targetCapture>, right: ReturnType<typeof targetCapture>) {
  return left.unitId === right.unitId && left.locale === right.locale && left.sourceSnapshotId === right.sourceSnapshotId
    && left.sourceRevisionId === right.sourceRevisionId && left.selectionId === right.selectionId && left.revisionId === right.revisionId
    && left.basis === right.basis;
}
const sameTarget = (left: ReturnType<typeof targetCapture>, right: ReturnType<typeof targetCapture>) => sameBasis(left, right) && left.currentRunId === right.currentRunId;
const statuses = { passed: "passed", "not-applicable": "notApplicable", findings: "findings", failed: "checkFailed", cancelled: "checkCancelled", unknown: "checkUnknown" } as const;
function ruleStatus(status: string) { return Object.hasOwn(statuses, status) ? statuses[status as keyof typeof statuses] : "qaUnavailable"; }

/** Preparation and execution remain explicit actions owned by the retained review session. */
export default function EntryChecksPanel({ project, target, owner, drafts, commands, gate, viewId, disabled, visible, parentDialogId, read }: EntryChecksPanelProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), { t: legacy } = useTranslation(), reads = useSessionReads();
  const state = owner.state, shared = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
  const scope = JSON.stringify([context.projectId, context.sessionToken, target.unitId, target.locale, viewId]);
  const identity = JSON.stringify([scope, targetCapture(target)]), queryIdentity = JSON.stringify(read.key);
  const record = useMemo(() => {
    const cache = reads.client.getQueryCache(), filters = { queryKey: reads.key(read.key), exact: true };
    return { subscribe: (notify: () => void) => cache.subscribe(event => { if (matchQuery(filters, event.query)) notify(); }), snapshot: () => cache.find(filters)?.state };
  }, [reads, queryIdentity]);
  const queryState = useSyncExternalStore(record.subscribe, record.snapshot, record.snapshot);
  const root = useRef<HTMLElement>(null), result = useRef<HTMLDivElement>(null), focusResult = useRef<string | null>(null);
  const mounted = useRef(false), flight = useRef(false), cancelling = useRef(false), discoveryActions = useRef<TextReviewSelectionsHandle>(null);
  const bound = useRef<{ scope: string; data: unknown; version: number } | null>(null);
  const [discovery, setDiscovery] = useState<TextReviewDiscoveryState>({ kind: "loading", scopeKey: scope });
  const discoveryRef = useRef(discovery), [working, setWorking] = useState(false), [cancelBusy, setCancelBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ scope: string; kind: FeedbackKind } | null>(null);
  const live = useRef({ visible, disabled, scope, identity, viewId, parentDialogId });
  useLayoutEffect(() => { live.current = { visible, disabled, scope, identity, viewId, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function present() {
    return mounted.current && visible && !disabled && !reads.retired && !drafts.getSnapshot().retired
      && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken && gate.getSnapshot().visibleViewId === viewId;
  }
  const interactionAllowed = () => gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const sameView = () => present() && live.current.visible && !live.current.disabled && live.current.scope === scope
    && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId && interactionAllowed();
  const stillPresent = () => sameView() && live.current.identity === identity;
  useLayoutEffect(() => {
    const ticket = focusResult.current; if (!ticket) return; focusResult.current = null;
    if (ticket === scope && sameView() && document.activeElement === document.body) result.current?.focus();
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
  useEffect(() => {
    if (!present() || !project.metadata.targetLocales.includes(target.locale) || !currentRead() || !queryState) return;
    const before = owner.current(), selected = before.selected, sameEntity = selected?.unitId === target.unitId && selected.locale === target.locale;
    if (sameEntity && bound.current?.scope === scope && bound.current.data === read.data && bound.current.version === queryState.dataUpdateCount) return;
    bound.current = { scope, data: read.data, version: queryState.dataUpdateCount };
    if (before.locale !== target.locale) owner.setLocale(target.locale);
    if (!sameEntity || !selected) owner.setSelected(target);
    else owner.observeProjection(target, { unitId: selected.unitId, locale: selected.locale, basis: selected.basis, editSeq: before.editSeq[reviewDraftKey(selected)] ?? 0 });
  });
  function observeDiscovery(value: TextReviewDiscoveryState) {
    if (!mounted.current || value.scopeKey !== scope || live.current.scope !== scope) return;
    discoveryRef.current = value; setDiscovery(value);
    if (value.kind === "ready") owner.observeSettingsRevision(value.settingsRevision);
    else {
      setFeedback(before => before?.kind === "prepared" ? null : before);
      const prepared = owner.current().checkReview;
      if (prepared) for (const slot of prepared.view.checkers) owner.setCheckerConsent(slot.attemptId, slot.inputDigest, false);
    }
  }
  useEffect(() => {
    if (!present() || discovery.kind !== "ready" || discovery.scopeKey !== scope) return;
    // Discovery can finish before an older preparation returns. Let the
    // original owner invalidate any slots from that earlier settings revision.
    owner.observeSettingsRevision(discovery.settingsRevision);
  }, [state.checkReview, discovery, scope, visible]);
  function configureAllowed() {
    const current = owner.current();
    return present() && project.metadata.targetLocales.includes(target.locale) && interactionAllowed() && !flight.current
      && !current.busyMutation && !current.pending && !current.batchRunning && !owner.inFlight();
  }
  function capture(): EntryChecksCapture | null {
    const current = owner.current(), evidence = discoveryRef.current, selected = current.selected;
    if (evidence.kind !== "ready" || evidence.scopeKey !== scope || !selected || !sameBasis(targetCapture(selected), targetCapture(target))) return null;
    return { ...targetCapture(target), advisoryChecks: structuredClone(current.advisoryChecks), settingsRevision: evidence.settingsRevision };
  }
  function matches(captured: EntryChecksCapture) {
    const current = capture(); return !!current && sameTarget(current, captured) && current.settingsRevision === captured.settingsRevision && same(current.advisoryChecks, captured.advisoryChecks);
  }
  function idle() { const current = drafts.getSnapshot(); return configureAllowed() && current.hydration === "ready" && !current.mutationReserved; }
  function preparedCurrent(preparation: EntryChecksPreparation, captured: EntryChecksCapture) {
    return owner.current().checkReview === preparation && preparation.request.unitId === captured.unitId && preparation.request.locale === captured.locale
      && preparation.request.expectedBasis === captured.basis && same(preparation.request.advisoryChecks, captured.advisoryChecks)
      && preparation.view.checkers.every(slot => slot.plugin.plugin.settingsRevision === captured.settingsRevision);
  }
  function prepareAvailability(payload: EntryChecksPreparePayload | undefined): CommandAvailability {
    return idle() && currentRead() && !!payload && matches(payload) ? { enabled: true } : unavailable;
  }
  function runAvailability(payload: EntryChecksRunPayload | undefined): CommandAvailability {
    return idle() && currentRead() && !!payload && matches(payload) && preparedCurrent(payload.preparation, payload)
      && same(payload.consent, owner.current().checkConsent) && owner.checkersConfirmed() ? { enabled: true } : unavailable;
  }
  function consentAvailability(payload: EntryChecksConsentPayload | undefined): CommandAvailability {
    return idle() && currentRead() && !!payload && matches(payload) && preparedCurrent(payload.preparation, payload)
      && payload.preparation.view.checkers.some(slot => slot.attemptId === payload.attemptId && slot.inputDigest === payload.inputDigest) ? { enabled: true } : unavailable;
  }
  function feedbackAfter(before: number): FeedbackKind | null {
    const after = owner.current();
    if (after.checkReview) return "prepared";
    if (after.pending) return null;
    if (after.notice === "checkFailed") return "failed";
    if (after.notice === "checkCancelled") return "cancelled";
    if (after.notice === "checkUnknown") return "unknown";
    if (after.completionVersion !== before) return "saved";
    return after.notice === "conflict" ? "conflict" : after.notice === "error" ? "failed" : "changed";
  }
  async function perform(payload: EntryChecksPreparePayload | EntryChecksRunPayload) {
    if (!(payload.kind === "entry-checks-run" ? runAvailability(payload) : prepareAvailability(payload)).enabled) return;
    const witness = readProof(), before = owner.current().completionVersion;
    const actionFocused = document.activeElement instanceof HTMLButtonElement && root.current?.contains(document.activeElement);
    const proof = () => stillPresent() && currentRead() && witness.current() && project.metadata.targetLocales.includes(target.locale) && matches(payload)
      && (payload.kind !== "entry-checks-run" || preparedCurrent(payload.preparation, payload) && same(payload.consent, owner.current().checkConsent));
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      if (payload.kind === "entry-checks-run") await owner.check(proof); else await owner.prepareCheck(proof);
      if (sameView()) {
        const kind = feedbackAfter(before), prepared = owner.current().checkReview;
        if (kind) setFeedback({ scope, kind: kind === "prepared" && (!proof() || !prepared || !preparedCurrent(prepared, payload)) ? "changed" : kind });
      }
    } finally { witness.dispose(); flight.current = false; if (mounted.current) { if (actionFocused) focusResult.current = scope; setWorking(false); } }
  }
  const original = state.pending && !isHumanReviewPending(state.pending) ? state.pending : null;
  const pendingPayload: EntryChecksPendingPayload | null = original ? { kind: "entry-checks-pending", pending: original } : null;
  function pendingAvailability(payload: EntryChecksPendingPayload | undefined, retry = false): CommandAvailability {
    const current = owner.current();
    return present() && interactionAllowed() && !flight.current && !current.busyMutation && !current.checkingAction && !!payload && current.pending === payload.pending
      && current.pendingUncertain && (!retry || current.retryAllowed) ? { enabled: true } : unavailable;
  }
  function cancelAvailability(payload: EntryChecksPendingPayload | undefined): CommandAvailability {
    const current = owner.current();
    return present() && interactionAllowed() && !cancelling.current && !!payload && payload.pending.kind === "check" && current.pending === payload.pending
      ? { enabled: true } : unavailable;
  }
  async function recover(payload: EntryChecksPendingPayload, retry: boolean) {
    if (!pendingAvailability(payload, retry).enabled) return;
    const before = owner.current().completionVersion, actionFocused = document.activeElement instanceof HTMLButtonElement && root.current?.contains(document.activeElement);
    flight.current = true; setWorking(true); setFeedback(null);
    try {
      if (retry) await owner.retryPending(); else await owner.checkPending();
      if (sameView()) { const kind = feedbackAfter(before); if (kind) setFeedback({ scope, kind }); }
    } finally { flight.current = false; if (mounted.current) { if (actionFocused) focusResult.current = scope; setWorking(false); } }
  }
  async function cancel(payload: EntryChecksPendingPayload) {
    if (!cancelAvailability(payload).enabled) return;
    cancelling.current = true; setCancelBusy(true);
    try { await owner.cancelCheck(); if (sameView() && owner.current().notice === "cancelRequested") setFeedback({ scope, kind: "cancelRequested" }); }
    finally { cancelling.current = false; if (mounted.current) setCancelBusy(false); }
  }
  function discoveryAvailability(payload: EntryChecksDiscoveryPayload | undefined): CommandAvailability {
    return configureAllowed() && !!payload && payload.scopeKey === scope && discoveryActions.current?.scopeKey === scope ? { enabled: true } : unavailable;
  }
  function removeAvailability(payload: EntryChecksRemovePayload | undefined): CommandAvailability {
    return configureAllowed() && !!payload && payload.scopeKey === scope && discoveryActions.current?.scopeKey === scope
      && owner.current().advisoryChecks.some(choice => same(choice, payload.choice)) ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "review" as const, scope: commandScope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...metadata, id: "review.entry-prepare-checks", nameKey: "workbenchV2.entryChecksPrepare", payloadKind: "entry-checks-prepare", risk: "runs-review-checks", availability: prepareAvailability, handler: payload => { void perform(payload); } }),
      commands.register({ ...metadata, id: "review.entry-run-checks", nameKey: "workbenchV2.entryChecksRun", payloadKind: "entry-checks-run", risk: "runs-review-checks", availability: runAvailability, handler: payload => { void perform(payload); } }),
      commands.register({ ...metadata, id: "review.entry-checker-consent", nameKey: "review.checkConsent", payloadKind: "entry-checks-consent", risk: "changes-view", availability: consentAvailability, handler: payload => owner.setCheckerConsent(payload.attemptId, payload.inputDigest, payload.approved) }),
      commands.register({ ...metadata, id: "review.entry-cancel-checks", nameKey: "workbenchV2.entryChecksCancel", payloadKind: "entry-checks-pending", risk: "cancels-review-checks", availability: cancelAvailability, handler: payload => { void cancel(payload); } }),
      commands.register({ ...metadata, id: "review.entry-check-checks", nameKey: "workbenchV2.entryChecksCheck", payloadKind: "entry-checks-pending", risk: "reads-review", availability: payload => pendingAvailability(payload), handler: payload => { void recover(payload, false); } }),
      commands.register({ ...metadata, id: "review.entry-retry-checks", nameKey: "workbenchV2.entryChecksRetry", payloadKind: "entry-checks-pending", risk: "retries-review-action", availability: payload => pendingAvailability(payload, true), handler: payload => { void recover(payload, true); } }),
      commands.register({ ...metadata, id: "review.entry-refresh-checkers", nameKey: "review.refreshCheckers", payloadKind: "entry-checks-discovery", risk: "reads-review", availability: discoveryAvailability, handler: () => { discoveryActions.current?.refresh(); } }),
      commands.register({ ...metadata, id: "review.entry-remove-checker", nameKey: "review.removeAdvisoryCheck", payloadKind: "entry-checks-remove-advisory", risk: "changes-view", availability: removeAvailability, handler: payload => { discoveryActions.current?.remove(payload.choice); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });

  const captured = capture(), preparation = state.checkReview;
  const preparePayload: EntryChecksPreparePayload | null = captured ? { ...captured, kind: "entry-checks-prepare" } : null;
  const runPayload: EntryChecksRunPayload | null = captured && preparation ? { ...captured, kind: "entry-checks-run", preparation, consent: [...state.checkConsent] } : null;
  const selected = state.selected, basisChanged = !!selected && !sameBasis(targetCapture(selected), targetCapture(target));
  const fresh = currentRead(), run = fresh ? target.currentCheck : null, currentRun = run?.basis === target.basis;
  const message = feedback?.scope === scope ? feedback : null;
  const feedbackKeys = { prepared: "entryChecksPrepared", saved: "entryChecksSaved", failed: "entryChecksFailed", cancelled: "entryChecksCancelled", unknown: "entryChecksRunUnknown",
    conflict: "entryChecksConflict", changed: "entryChecksChanged", cancelRequested: "entryChecksCancelRequested" } as const;
  const renderRule = (rule: CheckRuleResult) => run ? <li className={styles.rule} key={ruleIdentity(rule.key)}>
    <h5>{capturedRuleLabel(legacy, run, rule)}</h5><p>{legacy(`review.${ruleStatus(rule.status)}`)}</p>
    {rule.reason ? <p className={styles.meta}>{legacy(rule.status === "not-applicable" ? "review.noSelectedTranslationReason" : rule.status === "failed" ? "review.checkFailedHelp"
      : rule.status === "cancelled" ? "review.checkCancelledHelp" : rule.status === "unknown" ? "review.checkUnknownHelp" : "review.incompleteCoverageHelp")}</p> : null}
    {rule.findings.length ? <ul>{rule.findings.map(finding => <li key={finding.issueId}><p>{reviewFindingLabel(legacy, finding.rule, finding.code)}</p>
      {finding.detail ? <div className={styles.text}><TokenizedText text={finding.detail}/></div> : null}
      </li>)}</ul> : null}
  </li> : null;
  if (!visible) return null;
  return <section ref={root} className={styles.section} aria-label={t("entryChecksTitle")}>
    <h3>{t("entryChecksTitle")}</h3><p className={styles.meta}>{t("entryChecksHelp")}</p>
    {!project.metadata.targetLocales.includes(target.locale) ? <Banner tone="warning">{t("entryReviewLocaleUnavailable")}</Banner> : null}
    {!fresh ? <Banner tone="warning" role="status">{t("entryChecksChanged")}</Banner> : null}
    {basisChanged ? <Banner tone="warning" role="status">{t("entryChecksBasisChanged")}</Banner> : null}
    <section aria-label={t("entryChecksCurrent")} className={styles.current}>
      <h4>{t("entryChecksCurrent")}</h4>
      {!run ? <p>{t("entryChecksMissing")}</p> : <>
        <p>{t(currentRun ? "entryChecksCurrentRecord" : "entryChecksOutdated")}</p>
        <p>{t(run.outcome === "completed" ? "entryChecksCompleted" : run.outcome === "failed" ? "entryChecksFailed" : run.outcome === "cancelled" ? "entryChecksCancelled" : "entryChecksRunUnknown")}</p>
        <section aria-label={t("entryChecksMandatory")}><h4>{t("entryChecksMandatory")}</h4><ul className={styles.rules}>{run.rules.filter(rule => rule.mandatory).map(renderRule)}</ul></section>
        <section aria-label={t("entryChecksAdvisory")}><h4>{t("entryChecksAdvisory")}</h4>{run.rules.some(rule => !rule.mandatory)
          ? <ul className={styles.rules}>{run.rules.filter(rule => !rule.mandatory).map(renderRule)}</ul> : <p className={styles.meta}>{t("entryChecksNoAdvisoryResult")}</p>}</section>
      </>}
    </section>
    <TextReviewSelections buttonClassName={buttonStyles.button} value={state.advisoryChecks} active={visible && !reads.retired && project.metadata.targetLocales.includes(target.locale)} scopeKey={scope}
      disabled={!configureAllowed()} onChange={value => { if (configureAllowed()) owner.setAdvisoryChecks(value); }} onDiscoveryState={observeDiscovery}
      actionBridge={{ ref: discoveryActions, onRefresh: () => commands.dispatch("review.entry-refresh-checkers", commandScope, { kind: "entry-checks-discovery", scopeKey: scope }),
        onRemove: choice => commands.dispatch("review.entry-remove-checker", commandScope, { kind: "entry-checks-remove-advisory", scopeKey: scope, choice }) }}/>
    {discovery.kind !== "ready" || discovery.scopeKey !== scope ? <p className={styles.meta}>{t("entryChecksDiscoveryRequired")}</p> : null}
    {preparation ? <section className={styles.preparation} aria-label={t("entryChecksPermissions")}><h4>{t("entryChecksPermissions")}</h4><p className={styles.meta}>{t("entryChecksPermissionHelp")}</p>
      {preparation.view.checkers.map(slot => {
        const payload: EntryChecksConsentPayload | null = captured ? { ...captured, kind: "entry-checks-consent", preparation, attemptId: slot.attemptId, inputDigest: slot.inputDigest,
          approved: !state.checkConsent.includes(owner.slotConsentKey(slot)) } : null;
        return <fieldset key={checkerIdentity(slot.checker)}><legend>{legacy("review.checkerConsentScope", { plugin: `${slot.checker.provider.plugin.publisher}/${slot.checker.provider.plugin.id} ${slot.checker.provider.plugin.version}`, profile: slot.checker.profile.id })}</legend>
          <ReviewCheckerDetails view={slot.plugin}/><label className={styles.consent}><input type="checkbox" checked={state.checkConsent.includes(owner.slotConsentKey(slot))}
            disabled={!payload || !consentAvailability(payload).enabled} onChange={event => { if (payload) commands.dispatch("review.entry-checker-consent", commandScope, { ...payload, approved: event.target.checked }); }}/>{legacy("review.checkConsent")}</label>
        </fieldset>;
      })}
    </section> : null}
    <div ref={result} tabIndex={-1} role="group" aria-label={t("entryChecksResult")} className={styles.result}>
      {original ? <Banner tone="warning" role="status"><p>{t(state.pendingUncertain ? "entryChecksUnknown" : "entryChecksWorking")}</p>
        {original.request.unitId !== target.unitId || original.request.locale !== target.locale ? <p>{t("entryChecksOtherPending")}</p> : null}
        <CommandFailureDetails failure={state.reasonValue}/><div className={styles.actions}>
          <Button size="sm" disabled={!pendingPayload || !pendingAvailability(pendingPayload).enabled} onClick={() => { if (pendingPayload) commands.dispatch("review.entry-check-checks", commandScope, pendingPayload); }}>{t("entryChecksCheck")}</Button>
          <Button size="sm" disabled={!pendingPayload || !pendingAvailability(pendingPayload, true).enabled} onClick={() => { if (pendingPayload) commands.dispatch("review.entry-retry-checks", commandScope, pendingPayload); }}>{t("entryChecksRetry")}</Button>
        </div></Banner> : state.pending ? <Banner tone="warning">{t("entryChecksOtherWork")}</Banner> : null}
      {message ? <Banner tone={message.kind === "failed" ? "error" : ["saved", "prepared"].includes(message.kind) ? "info" : "warning"} role={message.kind === "failed" ? "alert" : "status"}>
        <p>{t(feedbackKeys[message.kind])}</p>{message.kind === "failed" || message.kind === "conflict" ? <CommandFailureDetails failure={state.reasonValue}/> : null}
      </Banner> : null}
      {!state.pending && shared.mutationReserved && !working ? <p className={styles.meta}>{t("entryReviewSharedBusy")}</p> : null}
    </div>
    <div className={styles.actions} aria-busy={working || state.busyMutation || undefined}>
      <Button size="sm" disabled={!preparePayload || !prepareAvailability(preparePayload).enabled} onClick={() => { if (preparePayload) commands.dispatch("review.entry-prepare-checks", commandScope, preparePayload); }}>{t("entryChecksPrepare")}</Button>
      {preparation ? <Button size="sm" variant="primary" disabled={!runPayload || !runAvailability(runPayload).enabled} onClick={() => { if (runPayload) commands.dispatch("review.entry-run-checks", commandScope, runPayload); }}>{t("entryChecksRun")}</Button> : null}
      {pendingPayload?.pending.kind === "check" ? <Button size="sm" disabled={cancelBusy || !cancelAvailability(pendingPayload).enabled} onClick={() => commands.dispatch("review.entry-cancel-checks", commandScope, pendingPayload)}>{t("entryChecksCancel")}</Button> : null}
    </div>
  </section>;
}
