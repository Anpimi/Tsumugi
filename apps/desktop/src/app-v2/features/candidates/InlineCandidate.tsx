import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { useSessionReads } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { WorkbenchCommands, TranslationStageCommandPayload, CommandAvailability } from "../../../workbenchCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import { workspaceCommandMetadata } from "../../../commandBindings";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { CandidateOwners } from "./candidateTypes";
import { candidateDraftKey, candidateStagePayload, canStageCandidate, sameCandidateCapture, stageCandidate, type CandidateEvidence } from "./candidateActions";
import { candidateHistoryKey, candidateReadCurrent, candidateReadProof, useCandidateHistory } from "./candidateReads";
import styles from "./Candidates.module.css";

export interface InlineCandidateProps {
  project: ProjectView; target: ReviewTarget; drafts: TranslationDrafts; owners: CandidateOwners; commands: WorkbenchCommands;
  gate: InteractionGate; viewId: string | null; disabled: boolean; visible: boolean; focused: boolean; aiCandidateCount: number;
  onEdit: (unitId: string, locale: string) => Promise<boolean>; onInspect: (revisionId: string | null) => void;
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
/** Mounted only for the focused row. A candidate read never writes into the shared draft. */
export default function InlineCandidate({ project, target, drafts, owners, commands, gate, viewId, disabled, visible, focused, aiCandidateCount, onEdit, onInspect }: InlineCandidateProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads(), snapshot = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const active = visible && focused && aiCandidateCount > 0, history = useCandidateHistory(target, "0", active && !disabled);
  const scope = { ...executionContext(project), area: "translation" as const }, key = candidateDraftKey(scope.projectId, target);
  const identity = JSON.stringify([scope.projectId, scope.sessionToken, target.unitId, target.locale, target.sourceSnapshotId, target.sourceRevisionId, target.selectionId, target.revisionId]);
  const mounted = useRef(true), live = useRef({ active, disabled, identity, viewId });
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<{ identity: string; key: "candidateStaged" | "candidateStageBlocked" | "candidateStageUndurable" | "candidateActionFailed" } | null>(null);
  useLayoutEffect(() => { live.current = { active, disabled, identity, viewId }; });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (active && !disabled && snapshot.hydration === "ready" && !drafts.getEntry(key)) void drafts.open(key); }, [drafts, key.projectId, key.unitId, key.locale, active, disabled, snapshot.hydration]);
  const row = history.data?.rows.slice().reverse().find(candidate => candidate.originKind === "ai" && candidate.sourceRevisionId === target.sourceRevisionId
    && candidate.revisionId !== target.revisionId && candidate.candidateDecision?.request.disposition !== "rejected");
  const evidence: CandidateEvidence | null = row ? { kind: "revision", value: row } : null;
  const payload = evidence ? candidateStagePayload(drafts.getEntry(key), target, evidence) : null;
  const present = () => active && !disabled && mounted.current && gate.getSnapshot().visibleViewId === viewId && !reads.retired && !drafts.getSnapshot().retired;
  const stillPresent = () => present() && live.current.active && !live.current.disabled && live.current.identity === identity && live.current.viewId === viewId;
  const browseAvailability = (): CommandAvailability => present() && !busy && gate.canDispatch({ viewId, source: "button" }) ? { enabled: true } : unavailable;
  function availability(input: TranslationStageCommandPayload | undefined, stage = true): CommandAvailability {
    if (!present() || busy || owners.decisions.blocked() || snapshot.hydration !== "ready" || snapshot.mutationReserved
      || !gate.canDispatch({ viewId, source: "button" }) || !evidence || !sameCandidateCapture(input, payload)
      || !candidateReadCurrent(reads, candidateHistoryKey(target, "0"), history.data)) return unavailable;
    return !stage || canStageCandidate(drafts.getEntry(key), target, evidence) ? { enabled: true } : { enabled: false, reason: "no-changes" };
  }
  async function stage(input: TranslationStageCommandPayload) {
    if (!evidence) return;
    const proof = candidateReadProof(reads, candidateHistoryKey(target, "0"), history.data); setBusy(true);
    try {
      const result = await stageCandidate(drafts, key, evidence, input, () => stillPresent() && proof.current());
      if (!stillPresent()) return;
      setFeedback({ identity, key: !result.staged ? "candidateStageBlocked" : !result.durable ? "candidateStageUndurable" : "candidateStaged" });
      if (result.staged && result.durable && !await onEdit(target.unitId, target.locale) && stillPresent()) setFeedback({ identity, key: "candidateActionFailed" });
    } catch { if (stillPresent()) setFeedback({ identity, key: "candidateActionFailed" }); }
    finally { proof.dispose(); if (mounted.current) setBusy(false); }
  }
  useLayoutEffect(() => {
    if (!active) return;
    const meta = { category: "translation" as const, scope, binding: null, confirmation: "none" as const };
    const removals = [
      commands.register({ ...meta, id: "translation.inspect-focused-candidates", nameKey: "candidateDecisions.inspect", risk: "changes-view", availability: browseAvailability, handler: () => onInspect(null) }),
      commands.register({ ...meta, id: "translation.stage-inline-candidate", nameKey: "translation.addCandidate", risk: "writes-translation", payloadKind: "translation-stage", availability: input => availability(input), handler: input => { void stage(input); } }),
      commands.register({ ...meta, id: "translation.edit-inline-candidate", nameKey: "translation.openEditor", risk: "opens-translation", payloadKind: "translation-stage", availability: input => availability(input), handler: input => { void stage(input); } }),
      commands.register({ ...meta, id: "translation.inspect-inline-candidate", nameKey: "candidateDecisions.inspect", risk: "changes-view", payloadKind: "translation-stage", availability: input => availability(input, false), handler: input => { if (input.evidence.kind === "revision") onInspect(input.evidence.revisionId); } }),
      commands.register({ ...meta, ...workspaceCommandMetadata("translation.stage-focused-ai"), risk: "writes-translation",
        availability: () => (gate.getSnapshot().inputOwner === null || gate.getSnapshot().inputOwner?.ownerId === `entry-list-${viewId}`) && payload ? availability(payload) : unavailable,
        handler: () => { if (payload) void stage(payload); } }),
    ];
    return () => removals.forEach(remove => remove());
  });
  if (!active) return null;
  const more = <div className={styles.inline} onClick={event => event.stopPropagation()}><p className={styles.meta}>{t("candidateMore")}</p><div className={styles.actions}><Button size="xs" disabled={!browseAvailability().enabled} onClick={() => commands.dispatch("translation.inspect-focused-candidates", scope)}>{t("candidateTitle")}</Button></div></div>;
  if (history.isError) return <><p className={styles.meta} role="status">{t("readFailedHelp")}</p>{more}</>;
  if (!history.data) return disabled ? more : <p className={styles.meta} role="status">{t("candidateLoading")}</p>;
  if (!row) return more;
  const allowed = !!payload && availability(payload).enabled;
  return <div className={styles.inline} onClick={event => event.stopPropagation()}>
    <div className={styles.inlineText}><Sparkles aria-hidden="true" size={16} /><span>{row.text === "" ? t("editorEmptySelection") : <TokenizedText text={row.text} />}</span></div>
    <div className={styles.actions}><Button size="xs" disabled={!allowed} onClick={() => { if (payload) commands.dispatch("translation.stage-inline-candidate", scope, payload); }}>{t("candidateAdopt")}</Button><Button size="xs" disabled={!allowed} onClick={() => { if (payload) commands.dispatch("translation.edit-inline-candidate", scope, payload); }}>{t("candidateEdit")}</Button><Button size="xs" disabled={!payload || !availability(payload, false).enabled} onClick={() => { if (payload) commands.dispatch("translation.inspect-inline-candidate", scope, payload); }}>{t("candidateReject")}</Button></div>
    {feedback?.identity === identity ? <Banner tone={feedback.key === "candidateStaged" ? "success" : "warning"} role="status">{t(feedback.key)}</Banner> : null}
  </div>;
}
