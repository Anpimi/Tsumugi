import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure, failureReason, type CommandFailure } from "../../../CommandFailure";
import { executionContext } from "../../../executionCommands";
import { jsonIdentity } from "../../../pluginToolChoices";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type CorrectionTermEvidence } from "../../../resourceCommands";
import { ResourceDraftRecovery } from "../../../ResourceDraftRecovery";
import type { ReviewEditorSnapshot, ReviewTarget } from "../../../reviewCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { sourceCommands } from "../../../sourceCommands";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import type { InteractionGate } from "../../workspace/interactionGate";
import { candidateReadCurrent, candidateReadProof } from "../candidates/candidateReads";
import type { DraftEntry, TranslationDrafts } from "../editor/translationDrafts";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import styles from "./EntryCorrectionTerm.module.css";

export interface EntryCorrectionTermProps {
  project: ProjectView; target: ReviewTarget; owner: KnowledgeOwner; drafts: TranslationDrafts;
  gate: InteractionGate; viewId: string; disabled: boolean; visible: boolean; parentDialogId?: string;
  read: { key: readonly unknown[]; data: ReviewEditorSnapshot };
  onOpenCapture?: (captureId: string) => Promise<boolean>;
}
const sourceKey = ["resource-source-scope"] as const;
const correctionKey = (evidence: CorrectionTermEvidence) => ["resource-correction-basis", evidence.basis.unitId, evidence.basis.locale, evidence.basis.after.selectionId] as const;
const bytes = (text: string) => new TextEncoder().encode(text).length;
function sameEvidence(left: CorrectionTermEvidence, right: CorrectionTermEvidence) {
  return jsonIdentity(left.basis) === jsonIdentity(right.basis) && left.sourceText === right.sourceText
    && left.beforeText === right.beforeText && left.afterText === right.afterText
    && left.beforeSourceSnapshotId === right.beforeSourceSnapshotId && left.beforeSourceRevisionId === right.beforeSourceRevisionId;
}
function savedManual(read: ReviewEditorSnapshot, target: ReviewTarget) {
  const selection = read.translations.current;
  return jsonIdentity(read.target) === jsonIdentity(target) && !!selection && selection.previousEventId !== null
    && selection.unitId === target.unitId && selection.locale === target.locale && selection.eventId === target.selectionId
    && selection.revisionId === target.revisionId && read.translations.currentText === target.translationText
    && read.translations.rows.some(row => row.revisionId === target.revisionId && row.unitId === target.unitId && row.locale === target.locale
      && row.originKind === "manual" && row.actionId === selection.actionId && row.text === target.translationText
      && row.sourceSnapshotId === target.sourceSnapshotId && row.sourceRevisionId === target.sourceRevisionId);
}
function inputCurrent(entry: DraftEntry | undefined, target: ReviewTarget) {
  return !!entry && entry.current.kind === "current" && !entry.currentFailure && entry.basisCurrent && !entry.busy && !entry.checking
    && !entry.failure && !entry.journalPending && !entry.value?.pending && entry.current.sourceText === target.sourceText
    && entry.current.basis.sourceRevisionId === target.sourceRevisionId && entry.current.basis.selectionId === target.selectionId
    && entry.current.basis.revisionId === target.revisionId && entry.current.basis.text === target.translationText
    && (!entry.value || entry.value.basis.sourceRevisionId === target.sourceRevisionId && entry.value.basis.selectionId === target.selectionId
      && entry.value.basis.revisionId === target.revisionId && entry.value.basis.text === target.translationText);
}

/** An explicit read hands saved evidence to the existing resource draft owner. */
export default function EntryCorrectionTerm({ project, target, owner, drafts, gate, viewId, disabled, visible, parentDialogId, read, onOpenCapture }: EntryCorrectionTermProps) {
  const { t } = useTranslation(), reads = useSessionReads(), context = executionContext(project);
  const snapshot = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  const eligible = savedManual(read.data, target);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const key = { projectId: context.projectId, unitId: target.unitId, locale: target.locale };
  const identity = jsonIdentity([context.projectId, context.sessionToken, viewId, target, read.data.readVersion]);
  const live = useRef({ identity, visible, disabled, parentDialogId }), mounted = useRef(false), flight = useRef(false);
  const openingCleanup = useRef<(() => void) | null>(null);
  const [opening, setOpening] = useState(false), [feedback, setFeedback] = useState<{ identity: typeof identity; kind: "changed" | "readFailed" | "unavailable"; failure?: CommandFailure } | null>(null);
  useLayoutEffect(() => { live.current = { identity, visible, disabled, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; openingCleanup.current?.(); }; }, []);
  useEffect(() => {
    if (eligible && visible && !disabled && snapshot.hydration === "ready" && !drafts.getEntry(key)) void drafts.open(key);
  }, [drafts, context.projectId, target.unitId, target.locale, eligible, visible, disabled, snapshot.hydration]);
  const present = (retained = true) => !reads.retired && !drafts.getSnapshot().retired && visible && !disabled
    && (!retained || mounted.current && live.current.visible && !live.current.disabled && live.current.identity === identity && live.current.parentDialogId === parentDialogId)
    && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
    && project.metadata.targetLocales.includes(target.locale) && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const readCurrent = () => candidateReadCurrent(reads, read.key, read.data) && savedManual(read.data, target);
  const canOpen = (retained = true) => present(retained) && readCurrent() && !flight.current && !drafts.getSnapshot().mutationReserved
    && inputCurrent(drafts.getEntry(key), target) && owner.canReceiveCorrection(target.locale);
  async function open() {
    if (!canOpen() || !target.selectionId) return;
    const afterSelectionId = target.selectionId;
    const before = owner.current(), input = drafts.getEntry(key), sequence = input?.value?.editSeq;
    const proof = candidateReadProof(reads, read.key, read.data);
    const basisKey = ["resource-correction-basis", target.unitId, target.locale, target.selectionId];
    let changed = false;
    const keys = [reads.key(sourceKey), reads.key(basisKey)];
    const unsubscribe = reads.client.getQueryCache().subscribe(event => {
      if (keys.some(queryKey => matchQuery({ queryKey, exact: true }, event.query))
        && (event.type === "removed" || event.type === "updated" && event.action.type === "invalidate")) changed = true;
    });
    const unchange = reads.subscribeChanges(scopes => { if (scopes.some(scope => ["project", "source", "translation"].includes(scope))) changed = true; });
    const cleanup = () => { proof.dispose(); unsubscribe(); unchange(); };
    openingCleanup.current = cleanup;
    flight.current = true; setOpening(true); setFeedback(null);
    try {
      const [source, evidence] = await Promise.all([
        reads.client.fetchQuery({ queryKey: reads.key(sourceKey), staleTime: 0, meta: { scopes: ["source"] }, queryFn: () => sourceCommands.scope(context) }),
        reads.client.fetchQuery({ queryKey: reads.key(basisKey), staleTime: 0, meta: { scopes: ["source", "translation", "project"] },
          queryFn: () => resourceCommands.correctionBasis({ ...context, unitId: target.unitId, locale: target.locale, afterSelectionId }) }),
      ]);
      const fresh = () => present() && !changed && proof.current() && readCurrent() && !drafts.getSnapshot().mutationReserved
        && inputCurrent(drafts.getEntry(key), target) && drafts.getEntry(key)?.value?.editSeq === sequence
        && candidateReadCurrent(reads, sourceKey, source) && candidateReadCurrent(reads, basisKey, evidence)
        && source.currentSnapshot === target.sourceSnapshotId && evidence.current && evidence.basis.projectId === context.projectId
        && evidence.basis.unitId === target.unitId && evidence.basis.locale === target.locale
        && evidence.basis.sourceSnapshotId === target.sourceSnapshotId && evidence.basis.sourceRevisionId === target.sourceRevisionId
        && evidence.basis.after.selectionId === target.selectionId && evidence.basis.after.revisionId === target.revisionId
        && evidence.basis.before.selectionId === read.data.translations.current?.previousEventId
        && evidence.sourceText === target.sourceText && evidence.afterText === target.translationText && evidence.beforeText !== evidence.afterText;
      if (!fresh() || !owner.receiveCorrection(evidence, before, fresh)) {
        if (present()) setFeedback({ identity, kind: changed || !proof.current() ? "changed" : "unavailable" });
      }
    } catch (error) {
      if (present()) setFeedback({ identity, kind: changed ? "changed" : "readFailed", failure: commandFailure(error) });
    } finally {
      cleanup(); openingCleanup.current = null; flight.current = false;
      if (mounted.current) setOpening(false);
    }
  }
  const draft = owner.state.correctionDraft, receipt = owner.state.correctionReceipt;
  const ownDraft = draft?.evidence.basis.unitId === target.unitId && draft.evidence.basis.locale === target.locale;
  const ownReceipt = receipt?.request.basis.unitId === target.unitId && receipt.request.basis.locale === target.locale;
  if (!eligible && !ownDraft && !ownReceipt) return null;
  return <div className={styles.panel}>
    {eligible && !ownDraft ? <><p>{t("correctionFeedback.entryHelp")}</p><Button disabled={!canOpen(false)} pending={opening} onClick={() => { void open(); }}>{t("correctionFeedback.open")}</Button>
      {!owner.canReceiveCorrection(target.locale) ? <p role="status">{t("correctionFeedback.blocked")}</p> : null}</> : null}
    {feedback && feedback.identity === identity ? <Banner tone="warning" role="alert"><p>{t(`correctionFeedback.${feedback.kind}`)}</p><CommandFailureDetails failure={feedback.failure ?? null}/></Banner> : null}
    {ownDraft || ownReceipt ? <CorrectionTermDraftForm project={project} owner={owner} gate={gate} viewId={viewId} disabled={disabled} visible={visible}
      current={present} writeCurrent={() => candidateReadCurrent(reads, read.key, read.data)} parentDialogId={parentDialogId} unitLabel={target.nativeKey} onOpenCapture={onOpenCapture}/> : null}
  </div>;
}

interface DraftFormProps {
  project: ProjectView; owner: KnowledgeOwner; gate: InteractionGate; viewId: string | null; disabled: boolean; visible: boolean;
  current: () => boolean; writeCurrent?: () => boolean; unitLabel?: string; parentDialogId?: string; onOpenCapture?: (captureId: string) => Promise<boolean>;
}
/** Shared continuation surface; the resource session and its journal retain every editable field. */
export function CorrectionTermDraftForm({ project, owner, gate, viewId, disabled, visible, current, writeCurrent = current, unitLabel, parentDialogId, onOpenCapture }: DraftFormProps) {
  const { t } = useTranslation(), reads = useSessionReads(), context = executionContext(project), inputOwner = `correction-term-${useId()}`;
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const state = owner.state, draft = state.correctionDraft, evidence = draft?.evidence, receipt = state.correctionReceipt;
  const identity = jsonIdentity(evidence?.basis ?? receipt?.request.basis ?? null);
  const mounted = useRef(false), live = useRef({ current, writeCurrent, visible, disabled, identity, viewId }), first = useRef<HTMLInputElement>(null);
  const captureCleanup = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { live.current = { current, writeCurrent, visible, disabled, identity, viewId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; captureCleanup.current?.(); gate.releaseOwner(inputOwner); }; }, [gate, inputOwner]);
  useLayoutEffect(() => { if (!visible) gate.releaseOwner(inputOwner); }, [gate, inputOwner, visible]);
  const basisKey = evidence ? correctionKey(evidence) : ["resource-correction-basis", "absent"];
  const basis = useSessionQuery({ key: basisKey, scopes: ["source", "translation", "project"], enabled: visible && !disabled && !!evidence && !reads.retired,
    refetchOnMount: true, read: () => { if (!evidence) throw new Error("Missing saved correction evidence");
      return resourceCommands.correctionBasis({ ...context, unitId: evidence.basis.unitId, locale: evidence.basis.locale, afterSelectionId: evidence.basis.after.selectionId }); } });
  const source = useSessionQuery({ key: sourceKey, scopes: ["source"], enabled: visible && !disabled && !!evidence && !reads.retired,
    refetchOnMount: true, read: () => sourceCommands.scope(context) });
  useEffect(() => { if (visible && !disabled && current() && evidence) first.current?.focus(); }, [identity, visible, disabled]);
  // Render from the current props. Event and asynchronous proofs additionally
  // compare the last committed scope; layout ref updates do not cause renders.
  const viewCurrent = (retained = true) => !reads.retired && visible && !disabled
    && (!retained || mounted.current && live.current.visible && !live.current.disabled && live.current.identity === identity && live.current.viewId === viewId)
    && gate.getSnapshot().visibleViewId === viewId
    && (!gate.getSnapshot().dialogs.length || gate.getSnapshot().dialogs.at(-1) === parentDialogId)
    && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken;
  const present = (retained = true) => viewCurrent(retained) && (retained ? live.current.current() : current());
  // Editing remains possible during submission and IME composition. Only a
  // conflicting operation is blocked; the original owner preserves newer B.
  const editable = (retained = true) => viewCurrent(retained) && owner.journal.hydration === "ready" && !owner.journal.retired && !owner.journal.conflict && !owner.journal.failure;
  const upToDate = () => !!evidence && !!basis.data && !!source.data && candidateReadCurrent(reads, basisKey, basis.data)
    && candidateReadCurrent(reads, sourceKey, source.data) && sameEvidence(evidence, basis.data) && basis.data.current
    && evidence.basis.projectId === context.projectId && source.data.currentSnapshot === evidence.basis.sourceSnapshotId
    && evidence.beforeText !== evidence.afterText && owner.localeAvailable(evidence.basis.locale);
  const invalidSource = !!draft?.source && (!draft.source.trim() || !draft.evidence.sourceText.includes(draft.source));
  const invalidTarget = !!draft?.target && (!draft.target.trim() || !draft.evidence.afterText.includes(draft.target));
  const tooLarge = !!draft && [draft.source, draft.target, draft.reason].some(value => bytes(value) > 16384);
  const valid = !!draft && [draft.source, draft.target, draft.reason].every(value => !!value.trim() && bytes(value) <= 16384) && !invalidSource && !invalidTarget;
  const canCapture = (retained = true) => editable(retained) && present(retained) && (retained ? live.current.writeCurrent() : writeCurrent()) && upToDate() && valid && !owner.blocked() && !owner.inFlight()
    && !owner.termDirty() && !owner.contextDirty() && !owner.factDirty() && !owner.tool.hasDraft();
  async function openSaved(captureId: string) {
    if (!present() || owner.current().pending || owner.inFlight()) return;
    if (owner.current().previewCaptureId === captureId && owner.current().previewNeedsRefresh) await owner.retryPreview(present);
    if (present() && onOpenCapture && owner.current().previewCaptureId === captureId && !owner.current().pending) await onOpenCapture(captureId);
  }
  async function complete(operation: () => Promise<void>) {
    const previous = owner.current().correctionReceipt;
    await operation();
    const saved = owner.current().correctionReceipt;
    if (present() && saved && saved !== previous && !owner.current().pending) await openSaved(saved.capture.captureId);
  }
  async function capture() {
    if (!canCapture()) return;
    const checkedBasis = candidateReadProof(reads, basisKey, basis.data), checkedSource = candidateReadProof(reads, sourceKey, source.data);
    const cleanup = () => { checkedBasis.dispose(); checkedSource.dispose(); };
    captureCleanup.current = cleanup;
    try { await complete(() => owner.captureCorrection(() => present() && live.current.writeCurrent() && checkedBasis.current() && checkedSource.current() && upToDate())); }
    finally { cleanup(); captureCleanup.current = null; }
  }
  const pending = state.pending?.kind === "correction" ? state.pending : null;
  const recoverable = (retained = true) => present(retained) && owner.current().pending === pending && !owner.inFlight() && !owner.current().busyMutation && !owner.current().checkingAction;
  if (!draft && !receipt && !pending) return null;
  return <section className={styles.panel} aria-label={t("correctionFeedback.title")}>
    <header><h3>{t("correctionFeedback.title")}</h3><p>{t("correctionFeedback.help")}</p></header>
    {owner.journal.hydration !== "ready" || owner.journal.failure || owner.journal.conflict ? <ResourceDraftRecovery owner={owner} disabled={!present(false)}/> : null}
    {draft ? <>
      <p>{t("correctionFeedback.scope", { unit: unitLabel ?? t("knowledge.proposalScopeEntry"), locale: draft.evidence.basis.locale })}</p>
      <p role="status">{t(upToDate() ? "correctionFeedback.current" : "correctionFeedback.stale")}</p>
      {basis.isFetching || source.isFetching ? <LoadingState label={t("correctionFeedback.checking")}/> : null}
      {basis.error || source.error ? <Banner tone="error" role="alert"><p>{t("correctionFeedback.readFailed")}</p><CommandFailureDetails failure={commandFailure(basis.error ?? source.error)}/></Banner> : null}
      <Button size="sm" disabled={!present(false) || basis.isFetching || source.isFetching} onClick={() => { if (present()) void Promise.all([basis.refetch(), source.refetch()]); }}>{t("resource.retryRead")}</Button>
      <Disclosure title={t("correctionFeedback.evidence")} className={styles.evidence}>
        <Field label={t("correctionFeedback.sourceText")}><TextArea readOnly rows={3} value={draft.evidence.sourceText}/></Field>
        <Field label={t("correctionFeedback.before")}><TextArea readOnly rows={3} value={draft.evidence.beforeText}/></Field>
        <Field label={t("correctionFeedback.after")}><TextArea readOnly rows={3} value={draft.evidence.afterText}/></Field>
        <p>{t("correctionFeedback.savedSources")}</p><dl className={styles.sources}>
          <div><dt>{t("correctionFeedback.before")}</dt><dd>{draft.evidence.beforeSourceSnapshotId} / {draft.evidence.beforeSourceRevisionId}</dd></div>
          <div><dt>{t("correctionFeedback.after")}</dt><dd>{draft.evidence.basis.sourceSnapshotId} / {draft.evidence.basis.sourceRevisionId}</dd></div>
        </dl>
      </Disclosure>
      <div className={styles.fields} onCompositionStart={() => gate.setComposing(inputOwner, true)} onCompositionEnd={() => gate.setComposing(inputOwner, false)}>
        <Field label={t("correctionFeedback.sourceTerm")} required error={invalidSource ? t("correctionFeedback.sourceMismatch") : undefined}>
          <TextInput ref={first} readOnly={!editable(false)} value={draft.source} onChange={event => { if (editable()) owner.editCorrection({ source: event.target.value }); }}/></Field>
        <Field label={t("correctionFeedback.targetTerm")} required error={invalidTarget ? t("correctionFeedback.targetMismatch") : undefined}>
          <TextInput readOnly={!editable(false)} value={draft.target} onChange={event => { if (editable()) owner.editCorrection({ target: event.target.value }); }}/></Field>
        <Field label={t("correctionFeedback.reason")} required><TextArea readOnly={!editable(false)} rows={3} value={draft.reason}
          onChange={event => { if (editable()) owner.editCorrection({ reason: event.target.value }); }}/></Field>
        <label className={styles.check}><input type="checkbox" disabled={!editable(false)} checked={draft.protected}
          onChange={event => { if (editable()) owner.editCorrection({ protected: event.target.checked }); }}/>{t("resource.protected")}</label>
      </div>
      {tooLarge ? <p role="alert">{t("correctionFeedback.fieldLimit")}</p> : null}<p className={styles.help}>{t("correctionFeedback.literalHelp")}</p>
      <div className={styles.actions}><Button variant="primary" disabled={!canCapture(false)} pending={!!pending && state.busyMutation} onClick={() => { void capture(); }}>{t("correctionFeedback.capture")}</Button>
        <Button disabled={!present(false) || owner.blocked() || owner.inFlight()} onClick={() => { if (present() && !owner.blocked() && !owner.inFlight()) owner.discardCorrection(); }}>{t("resource.discardDraft")}</Button></div>
    </> : null}
    {receipt && state.previewCaptureId === receipt.capture.captureId && !state.preview?.correction?.decision && state.notice !== "decisionSaved"
      ? <Banner tone="success" role="status">{t(draft ? "correctionFeedback.savedNewer" : "correctionFeedback.saved")}</Banner> : null}
    {receipt ? <Button disabled={!present(false) || owner.blocked() || owner.inFlight()} onClick={() => { void openSaved(receipt.capture.captureId); }}>{t("correctionFeedback.viewCandidate")}</Button> : null}
    {pending ? <Banner tone="warning" role="status" action={<div className={styles.actions}>
      <Button disabled={!recoverable(false)} onClick={() => { if (recoverable()) void complete(() => owner.checkPending()); }}>{t("correctionFeedback.check")}</Button>
      {state.pendingCheckedMissing ? <Button disabled={!recoverable(false)} onClick={() => { if (recoverable()) void complete(() => owner.retryPending()); }}>{t("resource.retry")}</Button> : null}
    </div>}>{t(state.checkingAction ? "resource.checkingAction" : state.pendingCheckedMissing ? "correctionFeedback.missing" : "correctionFeedback.unknown")}</Banner> : null}
    {state.failure ? <Banner tone="error" role="alert"><p>{failureReason(state.failure) === "correction-existing" ? t("correctionFeedback.existing")
      : t("resource.error", { reason: t(`resource.errors.${failureReason(state.failure)}`, { defaultValue: failureReason(state.failure) ?? "" }) })}</p><CommandFailureDetails failure={state.failure}/></Banner> : null}
  </section>;
}
