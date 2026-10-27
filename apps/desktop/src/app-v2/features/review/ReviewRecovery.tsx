import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { isHumanReviewPending } from "../../../ReviewDraftSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { Banner } from "../../../design-system/Feedback";
import { Button } from "../../../design-system/Button";
import type { CommandAvailability, WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ReviewEntryPendingPayload, ReviewOwner } from "./reviewTypes";
import { reviewBlocked, reviewHasDraft } from "./reviewState";
import styles from "./ReviewRecovery.module.css";

interface Props {
  project: ProjectView; owner: ReviewOwner; commands: WorkbenchCommands; gate: InteractionGate;
  viewId: string | null; disabled: boolean; visible: boolean;
  onOpen: (unitId: string, locale: string) => void;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };

/** Closing a view never becomes permission to replace an unfinished review. */
export default function ReviewRecovery({ project, owner, commands, gate, viewId, disabled, visible, onOpen }: Props) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const state = owner.state, scope = { ...executionContext(project), area: "translation" as const };
  const pending: ReviewEntryPendingPayload | null = state.pending && isHumanReviewPending(state.pending)
    ? { kind: "entry-review-pending", pending: state.pending } : null;
  const original = state.pending?.request ?? state.selected ?? Object.values(state.draftTargets)[0];
  const busy = owner.inFlight() || state.busyMutation || state.checkingAction || state.batchRunning;
  const region = useRef<HTMLDivElement>(null), live = useRef({ visible, disabled, viewId });
  useLayoutEffect(() => { live.current = { visible, disabled, viewId }; });
  const present = () => visible && !disabled && gate.canDispatch({ viewId, source: "button" });
  function pendingAvailability(input: ReviewEntryPendingPayload | undefined, retry = false): CommandAvailability {
    const current = owner.current();
    return present() && !!input && input.pending === current.pending && current.pendingUncertain && !owner.inFlight() && !current.busyMutation
      && !current.checkingAction && (!retry || current.retryAllowed) ? { enabled: true } : unavailable;
  }
  async function recover(input: ReviewEntryPendingPayload, retry = false) {
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
      commands.register({ ...meta, id: "review.recover-entry-check", nameKey: "workbenchV2.reviewRecoveryCheck", risk: "reads-review", payloadKind: "entry-review-pending",
        availability: input => pendingAvailability(input), handler: input => { void recover(input); } }),
      commands.register({ ...meta, id: "review.recover-entry-retry", nameKey: "workbenchV2.reviewRecoveryRetry", risk: "retries-review-action", payloadKind: "entry-review-pending",
        availability: input => pendingAvailability(input, true), handler: input => { void recover(input, true); } }),
      commands.register({ ...meta, id: "review.open-retained-entry", nameKey: "workbenchV2.reviewRecoveryOpen", risk: "changes-view",
        availability: () => present() && !!original ? { enabled: true } : unavailable,
        handler: () => { if (original) onOpen(original.unitId, original.locale); } }),
      commands.register({ ...meta, id: "review.discard-retained-inputs", nameKey: "workbenchV2.reviewRecoveryDiscard", risk: "changes-view",
        availability: () => present() && !reviewBlocked(owner) && reviewHasDraft(owner) ? { enabled: true } : unavailable,
        handler: () => owner.clear() }),
      commands.register({ ...meta, id: "review.dismiss-entry-result", nameKey: "workbenchV2.reviewRecoveryDismiss", risk: "changes-view",
        availability: () => present() && owner.current().notice === "saved" ? { enabled: true } : unavailable, handler: () => owner.setNotice(null) }),
    ];
    return () => dispose.forEach(remove => remove());
  });
  if (!visible || !reviewBlocked(owner) && !reviewHasDraft(owner) && state.notice !== "saved") return null;
  return <div ref={region} tabIndex={-1} role="group" aria-label={t("entryReviewResult")}><Banner tone={pending && !busy ? "warning" : state.notice === "saved" ? "success" : "info"} role="status" action={<div className={styles.actions}>
    {original ? <Button disabled={!present()} onClick={() => commands.dispatch("review.open-retained-entry", scope)}>{t("reviewRecoveryOpen")}</Button> : null}
    {pending ? <><Button disabled={!pendingAvailability(pending).enabled} onClick={() => commands.dispatch("review.recover-entry-check", scope, pending)}>{t("reviewRecoveryCheck")}</Button>
      {state.retryAllowed ? <Button disabled={!pendingAvailability(pending, true).enabled} onClick={() => commands.dispatch("review.recover-entry-retry", scope, pending)}>{t("reviewRecoveryRetry")}</Button> : null}</>
      : !reviewBlocked(owner) && reviewHasDraft(owner) ? <Button disabled={!present()} onClick={() => commands.dispatch("review.discard-retained-inputs", scope)}>{t("reviewRecoveryDiscard")}</Button> : null}
    {state.notice === "saved" ? <Button disabled={!present()} onClick={() => commands.dispatch("review.dismiss-entry-result", scope)}>{t("reviewRecoveryDismiss")}</Button> : null}
  </div>}>{t(state.checkingAction ? "reviewRecoveryChecking" : busy ? "reviewRecoveryBusy" : pending ? "reviewRecoveryUnknown" : state.notice === "saved" ? "reviewRecoverySaved" : "reviewRecoveryDraft")}</Banner></div>;
}
