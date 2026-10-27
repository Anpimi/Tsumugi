import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useSessionReads } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import { Button } from "../../../design-system/Button";
import { Banner, EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Field, TextInput, TextArea } from "../../../design-system/Field";
import { Tabs } from "../../../design-system/Tabs";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { WorkbenchCommands, TranslationStageCommandPayload, TranslationDraftCandidateCommandPayload, TranslationCandidatePendingCommandPayload, TranslationCandidateEffectCommandPayload, CommandAvailability } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { CandidateOwners } from "./candidateTypes";
import { candidateHistoryKey, candidateTmKey, candidateReadCurrent, candidateReadProof, useCandidateHistory, useCandidateTm } from "./candidateReads";
import { candidateDraftKey, candidateEvidenceId, candidateStagePayload, canStageCandidate, sameCandidateCapture, stageCandidate, type CandidateEvidence } from "./candidateActions";
import styles from "./Candidates.module.css";

const CandidateEffectStatus = lazy(() => import("./CandidateEffectStatus"));

export interface EntriesCandidatesProps {
  project: ProjectView; target: ReviewTarget; drafts: TranslationDrafts; owners: CandidateOwners; commands: WorkbenchCommands;
  gate: InteractionGate; viewId: string | null; disabled: boolean; visible: boolean; mode: "candidates" | "history";
  afterOrdinal: string; onPage: (after: string) => void; onEdit: (unitId: string, locale: string) => Promise<boolean>;
  initialRevisionId?: string | null; parentDialogId?: string;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };

export default function EntriesCandidates({ project, target, drafts, owners, commands, gate, viewId, disabled, visible, mode, afterOrdinal, onPage, onEdit, initialRevisionId, parentDialogId }: EntriesCandidatesProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const { t: legacy } = useTranslation();
  const reads = useSessionReads(), snapshot = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const history = useCandidateHistory(target, afterOrdinal, visible && !disabled), tm = useCandidateTm(target, visible && !disabled && mode === "candidates");
  const key = candidateDraftKey(project.metadata.projectId, target), entry = drafts.getEntry(key), state = owners.decisions.state;
  const scope = { ...executionContext(project), area: "translation" as const }, inputOwner = `candidate-audit-${useId()}`;
  const identity = JSON.stringify([scope.projectId, scope.sessionToken, target.unitId, target.locale, target.sourceSnapshotId, target.sourceRevisionId, target.selectionId, target.revisionId, afterOrdinal]);
  const [comparison, setComparison] = useState<{ identity: string; id: string } | null>(null);
  const comparisonRegion = useRef<HTMLElement>(null), comparisonButtons = useRef(new Map<string, HTMLButtonElement>());
  const comparisonFocus = useRef<{ identity: string; viewId: string | null; id: string; trigger: HTMLButtonElement | null; phase: "open" | "close" } | null>(null);
  const [audit, setAudit] = useState<{ identity: string; revisionId: string } | null>(null);
  const [effect, setEffect] = useState<{ identity: string; revisionId: string } | null>(null);
  const effectRegion = useRef<HTMLElement>(null), effectButtons = useRef(new Map<string, HTMLButtonElement>());
  const effectFocus = useRef<{ identity: string; revisionId: string; opening: boolean } | null>(null);
  const [feedback, setFeedback] = useState<{ identity: string; key: "candidateStaged" | "candidateStageBlocked" | "candidateStageUndurable" | "candidateActionFailed" } | null>(null);
  const [busy, setBusy] = useState(false), mounted = useRef(true), live = useRef({ visible, disabled, identity, viewId, parentDialogId });
  useLayoutEffect(() => { live.current = { visible, disabled, identity, viewId, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner, identity, viewId, visible]);
  useEffect(() => {
    if (visible && !disabled && snapshot.hydration === "ready" && !drafts.getEntry(key)) void drafts.open(key);
  }, [drafts, key.projectId, key.unitId, key.locale, visible, disabled, snapshot.hydration]);
  useEffect(() => { if (initialRevisionId) setAudit({ identity, revisionId: initialRevisionId }); }, [initialRevisionId, identity]);
  const revisions: CandidateEvidence[] = (history.data?.rows ?? []).map(value => ({ kind: "revision", value }));
  const memories: CandidateEvidence[] = (tm.data ?? []).map(value => ({ kind: "tm", value }));
  const evidence = [...revisions, ...memories];
  const chosen = comparison?.identity === identity ? evidence.find(item => candidateEvidenceId(item) === comparison.id) : undefined;
  const auditRevision = audit?.identity === identity ? history.data?.rows.find(row => row.revisionId === audit.revisionId) : undefined;
  const effectRevision = effect?.identity === identity ? history.data?.rows.find(row => row.revisionId === effect.revisionId) : undefined;
  const present = () => visible && !disabled && mounted.current && gate.getSnapshot().visibleViewId === viewId && !reads.retired && !drafts.getSnapshot().retired;
  const stillPresent = () => present() && live.current.visible && !live.current.disabled && live.current.identity === identity && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId;
  useLayoutEffect(() => {
    const pending = effectFocus.current;
    if (!pending) return;
    effectFocus.current = null;
    if (pending.identity !== identity || !stillPresent() || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) return;
    if (pending.opening) {
      if (effectRevision?.revisionId === pending.revisionId) effectRegion.current?.focus();
    } else effectButtons.current.get(pending.revisionId)?.focus();
  }, [effect, effectRevision, identity, viewId, visible, disabled, parentDialogId]);
  useLayoutEffect(() => {
    const pending = comparisonFocus.current;
    if (!pending) return;
    comparisonFocus.current = null;
    if (pending.identity !== identity || pending.viewId !== viewId || !stillPresent()
      || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })) return;
    if (pending.phase === "open") {
      if (!chosen || comparison?.id !== pending.id) return;
      comparisonRegion.current?.focus();
      comparisonRegion.current?.scrollIntoView?.({ block: "nearest" });
    } else {
      const trigger = comparisonButtons.current.get(pending.id);
      if (trigger === pending.trigger && trigger?.isConnected && !trigger.disabled) trigger.focus();
    }
  }, [comparison, chosen !== undefined, identity, viewId, visible, disabled]);
  const common = (): CommandAvailability => !visible ? { enabled: false, reason: "hidden" } : !present() || busy || state.busy
    || snapshot.hydration !== "ready" || snapshot.mutationReserved || !gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId }) ? unavailable : { enabled: true };
  const readKey = (item: CandidateEvidence) => item.kind === "revision" ? candidateHistoryKey(target, afterOrdinal) : candidateTmKey(target);
  const readData = (item: CandidateEvidence) => item.kind === "revision" ? history.data : tm.data;
  const effectPayload = (revision: typeof effectRevision): TranslationCandidateEffectCommandPayload | undefined => revision?.originKind === "ai" && revision.attemptId && revision.itemId && revision.resultId
    ? { kind: "translation-candidate-effect", unitId: revision.unitId, locale: revision.locale, revisionId: revision.revisionId,
      sourceRevisionId: revision.sourceRevisionId, sourceSnapshotId: revision.sourceSnapshotId,
      attemptId: revision.attemptId, itemId: revision.itemId, resultId: revision.resultId } : undefined;
  const effectReadAllowed = () => stillPresent() && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })
    && candidateReadCurrent(reads, candidateHistoryKey(target, afterOrdinal), history.data);
  const effectCloseAllowed = () => stillPresent() && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  function effectAvailability(input: TranslationCandidateEffectCommandPayload | undefined): CommandAvailability {
    const row = history.data?.rows.find(value => value.revisionId === input?.revisionId), expected = effectPayload(row);
    return input && expected && effectReadAllowed() && Object.keys(expected).every(field => Reflect.get(input, field) === Reflect.get(expected, field)) ? { enabled: true } : unavailable;
  }
  const currentEvidence = (input: TranslationStageCommandPayload | undefined) => evidence.find(item => sameCandidateCapture(input, candidateStagePayload(drafts.getEntry(key), target, item)));
  function availability(input: TranslationStageCommandPayload | undefined, action: "stage" | "compare" | "audit" = "stage"): CommandAvailability {
    const allowed = common(), item = currentEvidence(input);
    if (!allowed.enabled || !item || !candidateReadCurrent(reads, readKey(item), readData(item))) return allowed.enabled ? unavailable : allowed;
    if (action === "compare") return { enabled: true };
    if (action === "audit") return item.kind === "revision" && item.value.originKind === "ai" && item.value.sourceRevisionId === target.sourceRevisionId
      && item.value.revisionId !== target.revisionId && !owners.decisions.blocked() ? { enabled: true } : unavailable;
    return canStageCandidate(drafts.getEntry(key), target, item) ? { enabled: true } : { enabled: false, reason: "no-changes" };
  }
  async function stage(input: TranslationStageCommandPayload) {
    const item = currentEvidence(input); if (!item) return;
    const proof = candidateReadProof(reads, readKey(item), readData(item));
    setBusy(true);
    try {
      const result = await stageCandidate(drafts, key, item, input, () => stillPresent() && proof.current());
      if (!stillPresent()) return;
      setFeedback({ identity, key: !result.staged ? "candidateStageBlocked" : !result.durable ? "candidateStageUndurable" : "candidateStaged" });
      if (result.staged && result.durable && !await onEdit(target.unitId, target.locale) && stillPresent()) setFeedback({ identity, key: "candidateActionFailed" });
    } catch { if (stillPresent()) setFeedback({ identity, key: "candidateActionFailed" }); }
    finally { proof.dispose(); if (mounted.current) setBusy(false); }
  }
  const auditPayload = (): TranslationDraftCandidateCommandPayload | null => {
    if (!auditRevision) return null;
    const input = candidateStagePayload(drafts.getEntry(key), target, { kind: "revision", value: auditRevision });
    return input ? { ...input, kind: "translation-draft-candidate", disposition: auditRevision.candidateDecision?.request.disposition === "rejected" ? "restored" : "rejected",
      expectedDecisionId: auditRevision.candidateDecision?.request.actionId ?? null, actor: state.actor, reason: state.reason, decisionEditSeq: state.editSeq } : null;
  };
  function decisionAvailability(input: TranslationDraftCandidateCommandPayload | undefined): CommandAvailability {
    const expected = auditPayload();
    if (!input || !expected || JSON.stringify(input) !== JSON.stringify(expected) || !input.actor.trim() || !input.reason.trim()) return unavailable;
    return availability({ ...input, kind: "translation-stage" }, "audit");
  }
  const pendingInput = (): TranslationCandidatePendingCommandPayload | null => state.pending ? { kind: "translation-candidate-pending", request: state.pending } : null;
  const pendingAvailability = (input: TranslationCandidatePendingCommandPayload | undefined, retry = false): CommandAvailability =>
    present() && !busy && !state.busy && !!input && input.request === owners.decisions.current().pending && (!retry || state.checkedMissing)
      && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId }) ? { enabled: true } : unavailable;
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { category: "translation" as const, scope, binding: null, confirmation: "none" as const };
    const removals = [
      commands.register({ ...meta, id: "translation.stage-candidate", nameKey: "translation.addCandidate", risk: "writes-translation", payloadKind: "translation-stage", availability: input => availability(input), handler: input => { void stage(input); } }),
      commands.register({ ...meta, id: "translation.edit-candidate", nameKey: "translation.addCandidate", risk: "opens-translation", payloadKind: "translation-stage", availability: input => availability(input), handler: input => { void stage(input); } }),
      commands.register({ ...meta, id: "translation.compare-candidate", nameKey: "workbenchV2.candidateCompare", risk: "reads-review", payloadKind: "translation-stage", availability: input => availability(input, "compare"), handler: input => {
        const item = currentEvidence(input); if (!item) return;
        const id = candidateEvidenceId(item);
        comparisonFocus.current = { identity, viewId, id, trigger: comparisonButtons.current.get(id) ?? null, phase: "open" };
        setComparison({ identity, id });
      } }),
      commands.register({ ...meta, id: "translation.audit-candidate", nameKey: "candidateDecisions.reject", risk: "changes-view", payloadKind: "translation-stage", availability: input => availability(input, "audit"), handler: input => { if (input.evidence.kind === "revision") setAudit({ identity, revisionId: input.evidence.revisionId }); } }),
      commands.register({ ...meta, id: "translation.inspect-candidate-effect", nameKey: "workbenchV2.candidateEffectOpen", risk: "reads-review", payloadKind: "translation-candidate-effect", availability: effectAvailability, handler: input => {
        effectFocus.current = { identity, revisionId: input.revisionId, opening: true };
        setEffect({ identity, revisionId: input.revisionId });
      } }),
      commands.register({ ...meta, id: "translation.close-candidate-effect", nameKey: "workbenchV2.candidateEffectClose", risk: "changes-view", availability: () => effectRevision && effectCloseAllowed() ? { enabled: true } : unavailable, handler: () => {
        if (effectRevision) effectFocus.current = { identity, revisionId: effectRevision.revisionId, opening: false };
        setEffect(null);
      } }),
      commands.register({ ...meta, id: "translation.decide-draft-candidate", nameKey: "candidateDecisions.reject", risk: "writes-translation", payloadKind: "translation-draft-candidate", availability: decisionAvailability, handler: input => {
        if (!auditRevision) return;
        const proof = candidateReadProof(reads, candidateHistoryKey(target, afterOrdinal), history.data);
        void owners.decide(key, auditRevision, input.disposition, () => stillPresent() && proof.current() && owners.decisions.current().editSeq === input.decisionEditSeq).finally(proof.dispose);
      } }),
      commands.register({ ...meta, id: "translation.refresh-candidates", nameKey: "action.refresh", risk: "reads-review", availability: () => present() && !busy && !state.busy ? { enabled: true } : unavailable, handler: () => { void Promise.all([history.refetch(), ...(mode === "candidates" ? [tm.refetch()] : []), drafts.open(key)]); } }),
      commands.register({ ...meta, id: "translation.first-candidate-page", nameKey: "workbenchV2.firstPage", risk: "changes-view", availability: () => common().enabled && afterOrdinal !== "0" ? { enabled: true } : unavailable, handler: () => onPage("0") }),
      commands.register({ ...meta, id: "translation.next-candidate-page", nameKey: "workbenchV2.nextPage", risk: "changes-view", availability: () => common().enabled && history.data?.nextOrdinal != null && candidateReadCurrent(reads, candidateHistoryKey(target, afterOrdinal), history.data) ? { enabled: true } : unavailable, handler: () => { if (history.data?.nextOrdinal != null) onPage(history.data.nextOrdinal); } }),
      commands.register({ ...meta, id: "translation.close-candidate-comparison", nameKey: "action.cancel", risk: "changes-view", availability: common, handler: () => {
        if (comparison?.identity === identity) comparisonFocus.current = { identity, viewId, id: comparison.id, trigger: comparisonButtons.current.get(comparison.id) ?? null, phase: "close" };
        setComparison(null);
      } }),
      commands.register({ ...meta, id: "translation.cancel-candidate-audit", nameKey: "action.cancel", risk: "changes-view", availability: () => present() && !state.busy ? { enabled: true } : unavailable, handler: () => setAudit(null) }),
      commands.register({ ...meta, id: "translation.discard-candidate-inputs", nameKey: "action.discard", risk: "changes-view", availability: () => present() && !owners.decisions.blocked() && owners.decisions.hasDraft() ? { enabled: true } : unavailable, handler: () => { owners.decisions.discardInputs(); setAudit(null); } }),
      commands.register({ ...meta, id: "translation.check-candidate-decision", nameKey: "candidateDecisions.check", risk: "reads-review", payloadKind: "translation-candidate-pending", availability: input => pendingAvailability(input), handler: () => { void owners.decisions.check(); } }),
      commands.register({ ...meta, id: "translation.retry-candidate-decision", nameKey: "candidateDecisions.retry", risk: "writes-translation", payloadKind: "translation-candidate-pending", availability: input => pendingAvailability(input, true), handler: () => { void owners.decisions.retry(); } }),
    ];
    return () => removals.forEach(remove => remove());
  });
  const dispatch = (id: "translation.refresh-candidates" | "translation.first-candidate-page" | "translation.next-candidate-page" | "translation.close-candidate-comparison" | "translation.cancel-candidate-audit" | "translation.discard-candidate-inputs") => commands.dispatch(id, scope);
  const text = (value: string | null) => value === null ? t("editorNoSelection") : value === "" ? t("editorEmptySelection") : <TokenizedText text={value} />;
  function card(item: CandidateEvidence) {
    const revision = item.kind === "revision" ? item.value : null, memory = item.kind === "tm" ? item.value : null;
    const payload = candidateStagePayload(entry, target, item), staged = availability(payload ?? undefined).enabled, canAudit = availability(payload ?? undefined, "audit").enabled;
    const sourceCurrent = revision?.sourceRevisionId === target.sourceRevisionId;
    const selected = revision?.revisionId === target.revisionId, rejected = revision?.candidateDecision?.request.disposition === "rejected";
    const effectInput = effectPayload(revision ?? undefined), effectOpen = !!revision && effectRevision?.revisionId === revision.revisionId;
    const origin = revision?.originKind ?? memory?.originKind;
    return <li key={candidateEvidenceId(item)} className={styles.item} data-ai={origin === "ai" || undefined}>
      <header className={styles.itemHeader}><strong>{origin === "ai" ? t("candidateAi") : legacy(origin === "import" ? "resource.imported" : "resource.manual")}</strong>
        <span>{memory ? t("candidateTmMatch", { score: memory.scorePercent, matchKind: legacy(`resource.match.${memory.matchKind}`) }) : t(selected ? "candidateCurrent" : sourceCurrent ? "candidateSameSource" : "candidateOldSource")}</span></header>
      {rejected ? <p className={styles.meta}>{t("candidateRejected")}</p> : null}
      {revision?.candidateDecision ? <p className={styles.meta}>{revision.candidateDecision.request.actor}: {revision.candidateDecision.request.reason}</p> : null}
      {memory ? <><p className={styles.donor}><TokenizedText text={memory.sourceText} /></p><p className={styles.meta}>{memory.hasHumanApproval ? t("approved") : legacy("resource.noApproval")}</p></> : null}
      <div className={styles.text}>{text(revision?.text ?? memory?.translationText ?? null)}</div>
      {revision?.logicalPath ? <p className={styles.meta}>{revision.logicalPath}</p> : null}
      {revision?.attemptId ? <p className={styles.meta}>{t("candidateRun", { id: revision.attemptId })}</p> : null}
      <div className={styles.actions}>
        <Button size="sm" disabled={!payload || !staged} onClick={() => { if (payload) commands.dispatch("translation.stage-candidate", scope, payload); }}>{t("candidateAdopt")}</Button>
        <Button size="sm" disabled={!payload || !staged} onClick={() => { if (payload) commands.dispatch("translation.edit-candidate", scope, payload); }}>{t("candidateEdit")}</Button>
        <Button ref={element => { if (element) comparisonButtons.current.set(candidateEvidenceId(item), element); else comparisonButtons.current.delete(candidateEvidenceId(item)); }} size="sm" disabled={!payload || !availability(payload, "compare").enabled} onClick={() => { if (payload) commands.dispatch("translation.compare-candidate", scope, payload); }}>{t("candidateCompare")}</Button>
        {revision?.originKind === "ai" ? <Button size="sm" disabled={!payload || !canAudit} onClick={() => { if (payload) commands.dispatch("translation.audit-candidate", scope, payload); }}>{t(rejected ? "candidateRestore" : "candidateReject")}</Button> : null}
        {effectInput ? <Button size="sm" ref={element => { if (element) effectButtons.current.set(effectInput.revisionId, element); else effectButtons.current.delete(effectInput.revisionId); }}
          aria-expanded={effectOpen} disabled={!effectAvailability(effectInput).enabled} onClick={() => commands.dispatch("translation.inspect-candidate-effect", scope, effectInput)}>{t("candidateEffectOpen")}</Button> : null}
      </div>
      {effectOpen && revision ? <section ref={effectRegion} tabIndex={-1} className={styles.effect} aria-label={t("candidateEffectTitle")}>
        <header className={styles.header}><h3>{t("candidateEffectTitle")}</h3><Button size="sm" disabled={!effectCloseAllowed()} onClick={() => commands.dispatch("translation.close-candidate-effect", scope)}>{t("candidateEffectClose")}</Button></header>
        <Suspense fallback={<LoadingState label={t("candidateEffectLoading")} />}><CandidateEffectStatus revision={revision} enabled={visible && !disabled && candidateReadCurrent(reads, candidateHistoryKey(target, afterOrdinal), history.data)} disabled={disabled}
          commands={commands} gate={gate} viewId={viewId} parentDialogId={parentDialogId}/></Suspense>
      </section> : null}
    </li>;
  }
  const pending = pendingInput(), decision = auditPayload();
  const currentFeedback = feedback?.identity === identity ? feedback : null;
  return <section className={styles.panel} aria-label={t(mode === "history" ? "candidateHistory" : "candidateTitle")}>
    <header className={styles.header}><h2>{t(mode === "history" ? "candidateHistory" : "candidateTitle")}</h2><Button size="sm" disabled={!present() || busy || state.busy} onClick={() => dispatch("translation.refresh-candidates")}>{t("refresh")}</Button></header>
    {currentFeedback ? <Banner tone={currentFeedback.key === "candidateStaged" ? "success" : "warning"} role="status">{t(currentFeedback.key)}</Banner> : null}
    {entry?.value && entry.value.text !== (entry.value.basis.text ?? "") ? <Banner tone="info">{t("candidateDirty")}</Banner> : null}
    {state.recorded ? <Banner tone="success" role="status">{legacy(state.recorded === "rejected" ? "candidateDecisions.rejectedRecorded" : "candidateDecisions.restoredRecorded")}</Banner> : null}
    {state.failure ? <Banner tone="error" role="alert">{t("candidateActionFailed")}</Banner> : null}
    {pending ? <Banner tone="warning" action={<div className={styles.actions}><Button disabled={!pendingAvailability(pending).enabled} onClick={() => commands.dispatch("translation.check-candidate-decision", scope, pending)}>{t("candidateCheck")}</Button>{state.checkedMissing ? <Button disabled={!pendingAvailability(pending, true).enabled} onClick={() => commands.dispatch("translation.retry-candidate-decision", scope, pending)}>{t("candidateRetry")}</Button> : null}</div>}>{t(state.checkedMissing ? "candidateMissing" : "candidateUnknown")}</Banner> : null}
    {auditRevision ? <section className={styles.audit} aria-label={t("candidateAudit")}>
      <h3>{t(auditRevision.candidateDecision?.request.disposition === "rejected" ? "candidateRestore" : "candidateReject")}</h3><div className={styles.text}>{text(auditRevision.text)}</div>
      <Field label={t("candidateActor")} required><TextInput value={state.actor} disabled={disabled || state.busy || !!state.pending} onChange={event => owners.decisions.edit("actor", event.currentTarget.value)} onFocus={() => gate.setInputOwner(viewId, inputOwner)} onBlur={() => gate.setInputOwner(viewId, null)} onCompositionStart={() => gate.setComposing(inputOwner, true)} onCompositionEnd={() => gate.setComposing(inputOwner, false)} /></Field>
      <Field label={t("candidateReason")} required><TextArea value={state.reason} disabled={disabled || state.busy || !!state.pending} onChange={event => owners.decisions.edit("reason", event.currentTarget.value)} onFocus={() => gate.setInputOwner(viewId, inputOwner)} onBlur={() => gate.setInputOwner(viewId, null)} onCompositionStart={() => gate.setComposing(inputOwner, true)} onCompositionEnd={() => gate.setComposing(inputOwner, false)} /></Field>
      <div className={styles.actions}><Button disabled={!present() || state.busy} onClick={() => dispatch("translation.cancel-candidate-audit")}>{t("candidateCancel")}</Button><Button disabled={!present() || owners.decisions.blocked() || !owners.decisions.hasDraft()} onClick={() => dispatch("translation.discard-candidate-inputs")}>{t("candidateDiscard")}</Button><Button variant="primary" pending={state.busy} disabled={!decision || !decisionAvailability(decision).enabled} onClick={() => { if (decision) commands.dispatch("translation.decide-draft-candidate", scope, decision); }}>{t("candidateRecord")}</Button></div>
    </section> : null}
    {chosen ? <section ref={comparisonRegion} tabIndex={-1} className={styles.comparison} aria-label={t("candidateComparison")}><header className={styles.header}><h3>{t("candidateComparison")}</h3><Button size="sm" disabled={!common().enabled} onClick={() => dispatch("translation.close-candidate-comparison")}>{t("candidateCloseCompare")}</Button></header><div className={styles.compareColumns}><div><h4>{t("candidateCurrent")}</h4><div className={styles.text}>{text(target.translationText)}</div></div><div><h4>{t("candidateCompared")}</h4><div className={styles.text}>{text(chosen.kind === "revision" ? chosen.value.text : chosen.value.translationText)}</div></div></div></section> : null}
    {history.isError ? <ErrorState title={t("readFailed")} description={t("readFailedHelp")} /> : null}
    {!history.data && !history.isError ? <LoadingState label={t("candidateLoading")} /> : null}
    {history.data ? mode === "history" ? <ul className={styles.list}>{revisions.length ? revisions.map(card) : <li><EmptyState title={t("candidateEmpty")} /></li>}</ul> : <Tabs defaultValue="revisions" label={t("candidateSources")} items={[
      { value: "revisions", label: t("candidateHistory"), content: <ul className={styles.list}>{revisions.length ? revisions.map(card) : <li><EmptyState title={t("candidateEmpty")} /></li>}</ul> },
      { value: "tm", label: t("candidateTm"), content: tm.isError ? <ErrorState title={t("readFailed")} description={t("readFailedHelp")} /> : !tm.data ? <LoadingState label={t("candidateLoading")} /> : <ul className={styles.list}>{memories.length ? memories.map(card) : <li><EmptyState title={t("candidateEmpty")} /></li>}</ul> },
    ]} /> : null}
    <div className={styles.actions}>{afterOrdinal !== "0" ? <Button disabled={!common().enabled} onClick={() => dispatch("translation.first-candidate-page")}>{t("firstPage")}</Button> : null}{history.data?.nextOrdinal != null ? <Button disabled={!common().enabled || history.isFetching} onClick={() => dispatch("translation.next-candidate-page")}>{t("nextPage")}</Button> : null}</div>
  </section>;
}
