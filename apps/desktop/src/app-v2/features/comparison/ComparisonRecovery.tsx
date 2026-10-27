import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ComparisonView } from "../../../arenaCommands";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import type { ArenaOpenComparisonCommandPayload, ArenaPendingCommandPayload, CommandAvailability, WorkbenchCommands } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import { candidateReadCurrent } from "../candidates/candidateReads";
import { comparisonPendingPayload, sameComparisonPending } from "./comparisonActions";
import { ComparisonSession, comparisonReadKey } from "./ComparisonSession";
import styles from "./Comparison.module.css";

export interface ComparisonRecoveryProps {
  project: ProjectView; owner: ComparisonSession; commands: WorkbenchCommands; gate: InteractionGate; viewId: string | null;
  disabled: boolean; visible: boolean; parentDialogId?: string; variant?: "panel" | "global";
  onOpenComparison?: (view: ComparisonView) => Promise<boolean>;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
export default function ComparisonRecovery({ project, owner, commands, gate, viewId, disabled, visible, parentDialogId, variant = "global", onOpenComparison }: ComparisonRecoveryProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" }), reads = useSessionReads();
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const mounted = useRef(true), live = useRef({ visible, disabled, viewId, parentDialogId });
  useLayoutEffect(() => { live.current = { visible, disabled, viewId, parentDialogId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [opening, setOpening] = useState(false), [failed, setFailed] = useState(false);
  const present = () => visible && !disabled && mounted.current && !reads.retired && !state.retired
    && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const stillPresent = () => present() && live.current.visible && !live.current.disabled && live.current.viewId === viewId && live.current.parentDialogId === parentDialogId;
  const scope = { ...executionContext(project), area: "translation" as const }, pending = comparisonPendingPayload(state.pending);
  const id = state.pending?.kind === "compare" ? state.pending.request.actionId
    : state.pending?.kind === "reveal" ? state.pending.request.comparisonId : state.comparisonId;
  const saved = useSessionQuery({ key: comparisonReadKey(id ?? ""), scopes: ["arena", "source", "translation", "resources"],
    enabled: variant === "global" && visible && !disabled && !!onOpenComparison && !!id && !state.busy,
    read: () => { if (!id) throw new Error("No comparison target"); return owner.read(id); }, refetchOnMount: true });
  const value = id && saved.data?.comparisonId === id ? saved.data : null;
  const open: ArenaOpenComparisonCommandPayload | null = value ? { kind: "arena-open-comparison", comparisonId: id!, nativeKey: value.nativeKey, locale: value.locale } : null;
  const checkId = variant === "panel" ? "arena.check-saved-comparison" : "arena.recover-saved-check";
  const retryId = variant === "panel" ? "arena.retry-saved-comparison" : "arena.recover-saved-retry";
  function availability(input: ArenaPendingCommandPayload | undefined, retry = false): CommandAvailability {
    return present() && !state.busy && sameComparisonPending(input, owner.current().pending)
      && (!retry || owner.current().retryAllowed) ? { enabled: true } : unavailable;
  }
  function openAvailability(input: ArenaOpenComparisonCommandPayload | undefined): CommandAvailability {
    return present() && !opening && !!onOpenComparison && !!input && !!open && input.comparisonId === open.comparisonId
      && input.nativeKey === open.nativeKey && input.locale === open.locale && candidateReadCurrent(reads, comparisonReadKey(input.comparisonId), value)
      ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    if (!visible) return;
    const metadata = { category: "translation" as const, scope, binding: null, confirmation: "none" as const };
    const removals = [
      commands.register({ ...metadata, id: checkId, nameKey: "candidateDecisions.check", risk: "reads-arena", payloadKind: "arena-pending", availability: input => availability(input), handler: () => { void owner.check(); } }),
      commands.register({ ...metadata, id: retryId, nameKey: "ai.retrySame", risk: "retries-execution-action", payloadKind: "arena-pending", availability: input => availability(input, true), handler: () => { void owner.retry(); } }),
    ];
    if (variant === "global") removals.push(commands.register({ ...metadata, id: "arena.open-saved", nameKey: "arena.reopen", risk: "reads-arena", payloadKind: "arena-open-comparison", availability: openAvailability,
      handler: () => { if (!value || !onOpenComparison) return; setOpening(true); setFailed(false);
        void onOpenComparison(value).then(accepted => { if (!accepted && stillPresent()) setFailed(true); }).catch(() => { if (stillPresent()) setFailed(true); })
          .finally(() => { if (mounted.current) setOpening(false); }); } }));
    return () => removals.forEach(dispose => dispose());
  });
  if (!visible || !pending && !open) return null;
  return <div className={styles.recovery}>
    {pending ? <Banner tone="warning" action={<div className={styles.actions}>
      <Button disabled={!availability(pending).enabled} onClick={() => commands.dispatch(checkId, scope, pending)}>{t("candidateCheck")}</Button>
      {state.retryAllowed ? <Button disabled={!availability(pending, true).enabled} onClick={() => commands.dispatch(retryId, scope, pending)}>{t("candidateRetry")}</Button> : null}
    </div>}>{t(state.targetMissing ? "comparisonTargetMissing" : state.retryAllowed ? "comparisonMissing" : "comparisonUnknown")}</Banner> : null}
    {state.failure || failed ? <Banner tone="error">{t("comparisonActionFailed")}</Banner> : null}
    {variant === "global" && open ? <Button disabled={!openAvailability(open).enabled} pending={opening} onClick={() => commands.dispatch("arena.open-saved", scope, open)}>{t("comparisonOpenRecovered")}</Button> : null}
  </div>;
}
