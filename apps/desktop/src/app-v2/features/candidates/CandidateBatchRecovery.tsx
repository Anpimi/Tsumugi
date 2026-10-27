import { useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import type { CommandAvailability, TranslationCandidateBatchCommandPayload, TranslationCandidateBatchItemCommandPayload,
  TranslationCandidateBatchPageCommandPayload, TranslationCandidateBatchPendingCommandPayload, WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { CandidateBatchSession } from "./CandidateBatchSession";
import type { CandidateOwners } from "./candidateTypes";
import styles from "./CandidateBatchPanel.module.css";

export interface CandidateBatchRecoveryProps {
  project: ProjectView; owner: CandidateBatchSession; owners: CandidateOwners; commands: WorkbenchCommands;
  gate: InteractionGate; viewId: string | null; disabled: boolean; visible: boolean; parentDialogId?: string;
  onOpen: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
}
interface ActionProps extends Omit<CandidateBatchRecoveryProps, "onOpen"> {
  onOpen?: () => void; onHide?: () => void;
  active?: () => boolean;
  contextCurrent?: () => boolean;
  onEdit?: (unitId: string, locale: string) => Promise<boolean>;
  onPage?: (offset: number) => void;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
export const candidateBatchPageSize = 50;

/** Both presentations borrow the same batch and original decision owner. Only the visible presentation registers commands. */
export function useCandidateBatchActions({ project, owner, owners, commands, gate, viewId, disabled, visible, parentDialogId,
  onOpen, onHide, onEdit, onPage, active, contextCurrent }: ActionProps) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const context = executionContext(project), scope = { ...context, area: "translation" as const };
  const identity = JSON.stringify([context.projectId, context.sessionToken, viewId, parentDialogId]);
  const mounted = useRef(true), live = useRef({ visible, disabled, identity }), flight = useRef(false);
  const [working, setWorking] = useState(false), [failed, setFailed] = useState(false);
  useLayoutEffect(() => { live.current = { visible, disabled, identity }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const present = () => visible && !disabled && mounted.current && (!active || active()) && owner.current().phase !== "retired"
    && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const canHide = () => visible && mounted.current && (!active || active()) && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const stillPresent = () => present() && live.current.visible && !live.current.disabled && live.current.identity === identity && (!contextCurrent || contextCurrent());
  const idle = () => present() && !flight.current && !working && !owners.decisions.current().busy;
  function payload(): TranslationCandidateBatchCommandPayload | null {
    const current = owner.current(), audit = owners.decisions.current();
    return current.captureId === null ? null : { kind: "translation-candidate-batch", captureId: current.captureId, revision: current.revision,
      audit: current.mode === "stage" ? null : { actor: audit.actor, reason: audit.reason, editSeq: audit.editSeq } };
  }
  function same(input: TranslationCandidateBatchCommandPayload | undefined) {
    const expected = payload();
    return !!input && !!expected && input.captureId === expected.captureId && input.revision === expected.revision
      && (input.audit === null || expected.audit === null ? input.audit === expected.audit
        : input.audit.actor === expected.audit.actor && input.audit.reason === expected.audit.reason && input.audit.editSeq === expected.audit.editSeq);
  }
  const validAudit = () => owner.current().mode === "stage" || !!owners.decisions.current().actor.trim() && !!owners.decisions.current().reason.trim();
  function canConfirm(input: TranslationCandidateBatchCommandPayload | undefined): CommandAvailability {
    const current = owner.current();
    return idle() && same(input) && current.phase === "preview" && validAudit() && !owners.decisions.blocked() && !owners.protection.blocked()
      && current.items.some(item => item.status === "ready") ? { enabled: true } : unavailable;
  }
  function canContinue(input: TranslationCandidateBatchCommandPayload | undefined): CommandAvailability {
    const current = owner.current();
    return idle() && same(input) && current.phase === "paused" && validAudit() && !owners.decisions.blocked() && !owners.protection.blocked()
      && !current.items.some(item => item.status === "pending" || item.status === "undurable" || item.status === "running")
      && current.items.some(item => item.status === "ready") ? { enabled: true } : unavailable;
  }
  function canEnd(input: TranslationCandidateBatchCommandPayload | undefined): CommandAvailability {
    const current = owner.current();
    return idle() && same(input) && !current.ended && ["preview", "paused", "complete"].includes(current.phase)
      && !current.items.some(item => item.status === "pending" || item.status === "undurable" || item.status === "running")
      ? { enabled: true } : unavailable;
  }
  function pendingPayload(itemId: string): TranslationCandidateBatchPendingCommandPayload | null {
    const current = owner.current(), item = current.items.find(row => row.id === itemId);
    return current.captureId === null || !item || item.status !== "pending" && item.status !== "undurable" ? null
      : { kind: "translation-candidate-batch-pending", captureId: current.captureId, revision: current.revision, itemId, request: item.request };
  }
  function canCheck(input: TranslationCandidateBatchPendingCommandPayload | undefined, retry = false): CommandAvailability {
    const current = owner.current(), expected = input ? pendingPayload(input.itemId) : null;
    const item = current.items.find(row => row.id === input?.itemId);
    return idle() && !!input && !!expected && current.phase === "paused" && input.captureId === expected.captureId
      && input.revision === expected.revision && input.request === expected.request
      && (item?.status === "undurable" ? !retry && input.request === null
        : !!input.request && owners.decisions.current().pending === input.request && (!retry || owner.retryAllowed(input.itemId)))
      ? { enabled: true } : unavailable;
  }
  function itemPayload(itemId: string): TranslationCandidateBatchItemCommandPayload | null {
    const current = owner.current(), item = current.items.find(row => row.id === itemId);
    return current.captureId === null || !item ? null : { kind: "translation-candidate-batch-item", captureId: current.captureId,
      revision: current.revision, itemId, unitId: item.key.unitId, locale: item.key.locale };
  }
  function canEdit(input: TranslationCandidateBatchItemCommandPayload | undefined): CommandAvailability {
    const current = owner.current(), expected = input ? itemPayload(input.itemId) : null;
    return idle() && !!onEdit && !!input && !!expected && current.phase !== "running" && current.phase !== "capturing"
      && input.captureId === expected.captureId && input.revision === expected.revision && input.unitId === expected.unitId && input.locale === expected.locale
      && current.items.some(item => item.id === input.itemId && item.status === "staged") ? { enabled: true } : unavailable;
  }
  function canPage(input: TranslationCandidateBatchPageCommandPayload | undefined): CommandAvailability {
    const current = owner.current();
    return present() && !!onPage && !!input && input.captureId === current.captureId && input.revision === current.revision
      && Number.isInteger(input.offset) && input.offset >= 0 && input.offset % candidateBatchPageSize === 0
      && input.offset < current.items.length ? { enabled: true } : unavailable;
  }
  async function run(action: () => void | Promise<unknown>) {
    if (flight.current) return;
    flight.current = true; setWorking(true); setFailed(false);
    try { await action(); } catch { if (stillPresent()) setFailed(true); }
    finally { flight.current = false; if (mounted.current) setWorking(false); }
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { category: "translation" as const, scope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...meta, id: "translation.check-candidate-batch", nameKey: "candidateDecisions.check", risk: "writes-translation", payloadKind: "translation-candidate-batch-pending", availability: input => canCheck(input),
        handler: input => { void run(() => owner.check(input.captureId, input.itemId)); } }),
      commands.register({ ...meta, id: "translation.retry-candidate-batch", nameKey: "candidateDecisions.retry", risk: "writes-translation", payloadKind: "translation-candidate-batch-pending", availability: input => canCheck(input, true),
        handler: input => { void run(() => owner.retry(input.captureId, input.itemId)); } }),
    ];
    if (onHide) remove.push(commands.register({ ...meta, id: "translation.hide-candidate-batch", nameKey: "workbenchV2.close", risk: "changes-view", availability: () => canHide() ? { enabled: true } : unavailable, handler: onHide }));
    if (onOpen) remove.push(commands.register({ ...meta, id: "translation.open-retained-candidate-batch", nameKey: "workbenchV2.candidateBatchOpen", risk: "changes-view",
      availability: () => present() && owner.current().captureId !== null ? { enabled: true } : unavailable, handler: onOpen }));
    if (onHide) {
      remove.push(commands.register({ ...meta, id: "translation.continue-candidate-batch", nameKey: "workbenchV2.candidateBatchContinue", risk: "writes-translation", payloadKind: "translation-candidate-batch", availability: canContinue,
        handler: input => { void run(() => owner.continue(input.captureId, stillPresent)); } }));
      remove.push(commands.register({ ...meta, id: "translation.confirm-candidate-batch", nameKey: "workbenchV2.candidateBatchConfirm", risk: "writes-translation", confirmation: "required", payloadKind: "translation-candidate-batch", availability: canConfirm,
        handler: input => { void run(() => owner.confirm(input.captureId, stillPresent)); } }));
      remove.push(commands.register({ ...meta, id: "translation.end-candidate-batch", nameKey: "workbenchV2.candidateBatchEnd", risk: "changes-view", payloadKind: "translation-candidate-batch", availability: canEnd,
        handler: input => { owner.end(input.captureId); } }));
    }
    if (onEdit) remove.push(commands.register({ ...meta, id: "translation.edit-candidate-batch-item", nameKey: "workbenchV2.candidateBatchEdit", risk: "opens-translation", payloadKind: "translation-candidate-batch-item", availability: canEdit,
      handler: input => { void run(async () => { if (!await onEdit(input.unitId, input.locale) && stillPresent()) setFailed(true); }); } }));
    if (onPage) remove.push(commands.register({ ...meta, id: "translation.candidate-batch-page", nameKey: "workbenchV2.nextPage", risk: "changes-view", payloadKind: "translation-candidate-batch-page", availability: canPage,
      handler: input => onPage(input.offset) }));
    return () => remove.forEach(dispose => dispose());
  });
  return { state, scope, present, canHide, stillPresent, working, failed, payload, pendingPayload, itemPayload, canConfirm, canContinue, canEnd, canCheck, canEdit, canPage,
    auditEditable: () => idle() && ["preview", "paused"].includes(owner.current().phase) && !owners.decisions.blocked() };
}

export default function CandidateBatchRecovery(props: CandidateBatchRecoveryProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const actions = useCandidateBatchActions(props), { state, scope, pendingPayload } = actions;
  const pending = state.items.find(item => item.status === "pending" || item.status === "undurable"), original = pending ? pendingPayload(pending.id) : null;
  if (!props.visible || state.captureId === null || state.phase === "retired" || state.ended) return null;
  return <div className={styles.recovery}><Banner tone={pending ? "warning" : "info"} role="status" action={<div className={styles.actions}>
    <Button ref={props.triggerRef} size="sm" disabled={!actions.present()} onClick={() => props.commands.dispatch("translation.open-retained-candidate-batch", scope)}>{t("candidateBatchOpen")}</Button>
    {original ? <><Button size="sm" disabled={!actions.canCheck(original).enabled} onClick={() => props.commands.dispatch("translation.check-candidate-batch", scope, original)}>{t(pending?.status === "undurable" ? "editorRetryPreserve" : "candidateCheck")}</Button>
      {pending?.status === "pending" && props.owner.retryAllowed(pending.id) ? <Button size="sm" disabled={!actions.canCheck(original, true).enabled} onClick={() => props.commands.dispatch("translation.retry-candidate-batch", scope, original)}>{t("candidateRetry")}</Button> : null}</> : null}
  </div>}>{t(pending?.status === "undurable" ? "candidateStageUndurable" : pending ? props.owner.retryAllowed(pending.id) ? "candidateBatchMissing" : "candidateBatchUnknown" : "candidateBatchRetained")}</Banner>
    {actions.failed || state.failure && !pending && !["unknown", "journal"].includes(state.pauseReason ?? "") ? <Banner tone="error">{t("candidateBatchActionFailed")}</Banner> : null}
    {props.disabled ? <p className={styles.meta}>{t("candidateBatchUnavailable")}</p> : null}
  </div>;
}
