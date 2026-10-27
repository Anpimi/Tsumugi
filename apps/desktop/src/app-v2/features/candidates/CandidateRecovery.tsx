import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import type { WorkbenchCommands, TranslationCandidatePendingCommandPayload, TranslationProtectionPendingCommandPayload, CommandAvailability } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { CandidateOwners } from "./candidateTypes";
import styles from "./Candidates.module.css";

export interface CandidateRecoveryProps {
  project: ProjectView; owners: CandidateOwners; commands: WorkbenchCommands; gate: InteractionGate;
  viewId: string | null; disabled: boolean; visible: boolean; onOpen?: (unitId: string, locale: string) => void;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
/** Original requests remain operable with no tab and while the owner's mutation reservation is held. */
export default function CandidateRecovery({ project, owners, commands, gate, viewId, disabled, visible, onOpen }: CandidateRecoveryProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const { decisions, protection } = owners, state = decisions.state, protectedState = protection.state;
  const scope = { ...executionContext(project), area: "translation" as const };
  const mounted = useRef(true), live = useRef({ visible, disabled, viewId });
  useLayoutEffect(() => { live.current = { visible, disabled, viewId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const present = () => visible && !disabled && mounted.current && gate.canDispatch({ viewId, source: "button" });
  const stillPresent = () => present() && live.current.visible && !live.current.disabled && live.current.viewId === viewId;
  const candidate: TranslationCandidatePendingCommandPayload | null = state.pending ? { kind: "translation-candidate-pending", request: state.pending } : null;
  const work: TranslationProtectionPendingCommandPayload | null = protectedState.pending ? { kind: "translation-protection-pending", request: protectedState.pending.request, key: protectedState.pending.key } : null;
  function candidateAvailability(input: TranslationCandidatePendingCommandPayload | undefined, retry = false): CommandAvailability {
    return present() && !state.busy && !!input && input.request === decisions.current().pending && (!retry || state.checkedMissing) ? { enabled: true } : unavailable;
  }
  function workAvailability(input: TranslationProtectionPendingCommandPayload | undefined): CommandAvailability {
    const pending = protection.current().pending;
    return present() && !protectedState.busy && !!input && pending?.phase === "unknown" && input.request === pending.request && input.key === pending.key ? { enabled: true } : unavailable;
  }
  const originalTarget = state.pending?.decision ?? protectedState.pending?.request;
  useLayoutEffect(() => {
    if (!visible) return;
    const meta = { category: "translation" as const, scope, binding: null, confirmation: "none" as const };
    const remove = [
      commands.register({ ...meta, id: "translation.recover-candidate-check", nameKey: "candidateDecisions.check", risk: "reads-review", payloadKind: "translation-candidate-pending", availability: input => candidateAvailability(input), handler: () => { void decisions.check(); } }),
      commands.register({ ...meta, id: "translation.recover-candidate-retry", nameKey: "candidateDecisions.retry", risk: "writes-translation", payloadKind: "translation-candidate-pending", availability: input => candidateAvailability(input, true), handler: () => { void decisions.retry(); } }),
      commands.register({ ...meta, id: "translation.recover-protection", nameKey: "workbenchV2.candidateProtectionRetry", risk: "writes-translation", payloadKind: "translation-protection-pending", availability: workAvailability, handler: input => { void protection.retry(() => stillPresent() && protection.current().pending?.request === input.request).catch(() => undefined); } }),
      commands.register({ ...meta, id: "translation.discard-retained-candidate-inputs", nameKey: "candidateDecisions.discard", risk: "changes-view", availability: () => present() && !decisions.blocked() && decisions.hasDraft() ? { enabled: true } : unavailable, handler: () => { decisions.discardInputs(); } }),
      commands.register({ ...meta, id: "translation.open-retained-candidate", nameKey: "candidateDecisions.inspect", risk: "changes-view", availability: () => present() && !!onOpen && !!originalTarget ? { enabled: true } : unavailable, handler: () => { if (originalTarget) onOpen?.(originalTarget.unitId, originalTarget.locale); } }),
    ];
    return () => remove.forEach(dispose => dispose());
  });
  if (!visible || !candidate && !work && !decisions.hasDraft()) return null;
  return <div className={styles.recovery}>
    {candidate ? <Banner tone="warning" action={<div className={styles.actions}><Button disabled={!candidateAvailability(candidate).enabled} onClick={() => commands.dispatch("translation.recover-candidate-check", scope, candidate)}>{t("candidateCheck")}</Button>{state.checkedMissing ? <Button disabled={!candidateAvailability(candidate, true).enabled} onClick={() => commands.dispatch("translation.recover-candidate-retry", scope, candidate)}>{t("candidateRetry")}</Button> : null}</div>}>{t(state.checkedMissing ? "candidateMissing" : "candidateUnknown")}</Banner> : null}
    {work ? <Banner tone="warning" action={<Button disabled={!workAvailability(work).enabled} onClick={() => commands.dispatch("translation.recover-protection", scope, work)}>{t("candidateProtectionRetry")}</Button>}>{t("candidateProtectionUnknown")}</Banner> : null}
    {state.failure || protectedState.failure ? <Banner tone="error">{t("candidateActionFailed")}</Banner> : null}
    {decisions.hasDraft() && !candidate ? <Banner tone="info" action={<Button disabled={!present() || decisions.blocked()} onClick={() => commands.dispatch("translation.discard-retained-candidate-inputs", scope)}>{t("candidateDiscard")}</Button>}>{t("candidateRetained")}</Banner> : null}
    {onOpen && originalTarget ? <Button disabled={!present()} onClick={() => commands.dispatch("translation.open-retained-candidate", scope)}>{t("candidateOpen")}</Button> : null}
    {disabled ? <p className={styles.meta}>{t("candidateRecoveryBlocked")}</p> : null}
  </div>;
}
