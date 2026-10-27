import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { Banner } from "../../../design-system/Feedback";
import { Button } from "../../../design-system/Button";
import type { CommandAvailability, WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { RetainedReviewPendingPayload, ReviewOwner } from "./reviewTypes";
import { reviewBlocked, reviewHasDraft, reviewHasHumanDraft } from "./reviewState";
import SemanticRecoveryPanel from "./SemanticRecoveryPanel";
import styles from "./ReviewRecovery.module.css";

interface Props {
  project: ProjectView; owner: ReviewOwner; commands: WorkbenchCommands; gate: InteractionGate;
  viewId: string | null; disabled: boolean; visible: boolean; semanticVisible: boolean;
  onOpen: (unitId: string, locale: string) => void;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };

/** Closing a view never becomes permission to replace an unfinished review. */
export default function ReviewRecovery({ project, owner, commands, gate, viewId, disabled, visible, semanticVisible, onOpen }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const state = owner.state, scope = { ...executionContext(project), area: "translation" as const };
  const pending: RetainedReviewPendingPayload | null = state.pending ? { kind: "retained-review-pending", pending: state.pending } : null;
  const hasResult = ["saved", "checkFailed", "checkCancelled", "checkUnknown"].includes(state.notice ?? "");
  const semanticSource = owner.semantic.state.pending?.preparation.value.preview.items[0]?.source;
  const original = state.pending?.request ?? (semanticSource ? { unitId: semanticSource.unitId, locale: semanticSource.targetLocale } : state.selected ?? Object.values(state.draftTargets)[0]);
  const busy = state.busyMutation || state.checkingAction || state.batchRunning;
  const cancelFlight = useRef(false), region = useRef<HTMLDivElement>(null), live = useRef({ visible, disabled, viewId });
  useLayoutEffect(() => { live.current = { visible, disabled, viewId }; });
  const present = () => visible && !disabled && gate.canDispatch({ viewId, source: "button" });
  function pendingAvailability(input: RetainedReviewPendingPayload | undefined, retry = false): CommandAvailability {
    const current = owner.current();
    return present() && !!input && input.pending === current.pending && current.pendingUncertain && !owner.inFlight() && !current.busyMutation
      && !current.checkingAction && (!retry || current.retryAllowed) ? { enabled: true } : unavailable;
  }
  function cancelAvailability(input: RetainedReviewPendingPayload | undefined): CommandAvailability {
    return present() && !cancelFlight.current && !!input && input.pending === owner.current().pending && input.pending.kind === "check" ? { enabled: true } : unavailable;
  }
  async function recover(input: RetainedReviewPendingPayload, retry = false) {
    if (!pendingAvailability(input, retry).enabled) return;
    const origin = document.activeElement instanceof HTMLButtonElement && region.current?.contains(document.activeElement) ? document.activeElement : null;
    if (retry) await owner.retryPending(); else await owner.checkPending();
    if (origin && live.current.visible && !live.current.disabled && live.current.viewId === viewId) {
      if (present() && (document.activeElement === document.body || document.activeElement === origin)) region.current?.focus();
    }
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { scope, binding: null, confirmation: "none" as const, category: "review" as const };
    const dispose = [
      commands.register({ ...meta, id: "review.recover-entry-check", nameKey: "workbenchV2.reviewRecoveryCheck", risk: "reads-review", payloadKind: "retained-review-pending",
        availability: input => pendingAvailability(input), handler: input => { void recover(input); } }),
      commands.register({ ...meta, id: "review.recover-entry-retry", nameKey: "workbenchV2.reviewRecoveryRetry", risk: "retries-review-action", payloadKind: "retained-review-pending",
        availability: input => pendingAvailability(input, true), handler: input => { void recover(input, true); } }),
      commands.register({ ...meta, id: "review.recover-entry-cancel", nameKey: "workbenchV2.reviewRecoveryCancel", risk: "cancels-review-checks", payloadKind: "retained-review-pending",
        availability: cancelAvailability, handler: input => { if (cancelAvailability(input).enabled) { cancelFlight.current = true; void owner.cancelCheck().finally(() => { cancelFlight.current = false; }); } } }),
      commands.register({ ...meta, id: "review.open-retained-entry", nameKey: "workbenchV2.reviewRecoveryOpen", risk: "changes-view",
        availability: () => present() && !!original ? { enabled: true } : unavailable,
        handler: () => { if (original) onOpen(original.unitId, original.locale); } }),
      commands.register({ ...meta, id: "review.discard-retained-inputs", nameKey: "workbenchV2.reviewRecoveryDiscard", risk: "changes-view",
        availability: () => present() && !reviewBlocked(owner) && reviewHasDraft(owner) ? { enabled: true } : unavailable,
        handler: () => owner.clear() }),
      commands.register({ ...meta, id: "review.dismiss-entry-result", nameKey: "workbenchV2.reviewRecoveryDismiss", risk: "changes-view",
        availability: () => present() && ["saved", "checkFailed", "checkCancelled", "checkUnknown"].includes(owner.current().notice ?? "") ? { enabled: true } : unavailable, handler: () => owner.setNotice(null) }),
    ];
    return () => dispose.forEach(remove => remove());
  });
  const showSummary = visible && (busy || !!state.pending || reviewHasHumanDraft(owner) || hasResult || !owner.semantic.reserved() && owner.semantic.dirty());
  return <><div className={styles.semantic}><SemanticRecoveryPanel project={project} owner={owner} commands={commands} gate={gate} viewId={viewId} disabled={disabled} visible={semanticVisible}/></div>
    {showSummary ? <div ref={region} tabIndex={-1} role="group" aria-label={t("entryReviewResult")}><Banner tone={pending && !busy ? "warning" : state.notice === "saved" ? "success" : "info"} role="status" action={<div className={styles.actions}>
    {original ? <Button disabled={!present()} onClick={() => commands.dispatch("review.open-retained-entry", scope)}>{t("reviewRecoveryOpen")}</Button> : null}
    {pending ? <><Button disabled={!pendingAvailability(pending).enabled} onClick={() => commands.dispatch("review.recover-entry-check", scope, pending)}>{t("reviewRecoveryCheck")}</Button>
      {state.retryAllowed ? <Button disabled={!pendingAvailability(pending, true).enabled} onClick={() => commands.dispatch("review.recover-entry-retry", scope, pending)}>{t("reviewRecoveryRetry")}</Button> : null}</>
      : !reviewBlocked(owner) && reviewHasDraft(owner) ? <Button disabled={!present()} onClick={() => commands.dispatch("review.discard-retained-inputs", scope)}>{t("reviewRecoveryDiscard")}</Button> : null}
    {pending?.pending.kind === "check" ? <Button disabled={!cancelAvailability(pending).enabled} onClick={() => commands.dispatch("review.recover-entry-cancel", scope, pending)}>{t("reviewRecoveryCancel")}</Button> : null}
    {hasResult ? <Button disabled={!present()} onClick={() => commands.dispatch("review.dismiss-entry-result", scope)}>{t("reviewRecoveryDismiss")}</Button> : null}
  </div>}>{t(state.notice === "cancelRequested" ? "reviewRecoveryCancelRequested" : state.checkingAction ? "reviewRecoveryChecking" : busy ? "reviewRecoveryBusy" : pending ? "reviewRecoveryUnknown" : state.notice === "saved" ? "reviewRecoverySaved" : state.notice === "checkFailed" ? "reviewRecoveryCheckFailed" : state.notice === "checkCancelled" ? "reviewRecoveryCancelled" : state.notice === "checkUnknown" ? "reviewRecoveryCheckUnknown" : "reviewRecoveryDraft")}</Banner></div> : null}</>;
}
