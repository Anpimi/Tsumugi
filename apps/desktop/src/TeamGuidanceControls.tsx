import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { CommandFailureDetails } from "./CommandFailure";
import { jsonIdentity } from "./pluginToolChoices";
import { teamGuidanceActive, type TeamGuidanceSession } from "./TeamGuidanceSession";
import type { SessionRequest } from "./executionCommands";
import type { TeamExecutionView, WorkPlanStatusView } from "./workPlanCommands";
import { useWorkbenchCommands, type AiTeamGuidanceCommandPayload, type CommandAvailability } from "./workbenchCommands";

export function TeamGuidanceControls({ context, status, view, current, open, writable, session }: {
  context: SessionRequest; status: WorkPlanStatusView; view: TeamExecutionView | null; current: boolean;
  open: boolean; writable: boolean; session: TeamGuidanceSession;
}) {
  const { t } = useTranslation(), registry = useWorkbenchCommands(), helpId = useId(), errorRef = useRef<HTMLDivElement>(null);
  const [deadlineTick, setDeadlineTick] = useState(0), planId = status.plan.planId, state = session.current(planId), { draft, pending } = state;
  useEffect(() => {
    if (!open) return;
    const remaining = BigInt(status.expiresAt) * 1000n - BigInt(Date.now()) + 1n;
    if (remaining <= 0n) return;
    const timer = window.setTimeout(() => setDeadlineTick(value => value + 1), Number(remaining > 2147483647n ? 2147483647n : remaining));
    return () => window.clearTimeout(timer);
  }, [open, status.expiresAt, deadlineTick]);
  useEffect(() => { if (open && state.failure) errorRef.current?.focus(); }, [open, state.failure]);
  const member = view?.roster.find(value => value.memberId === draft.memberId);
  const targets = status.plan.scope.filter(unit => member?.unitIds.includes(unit.unitId)), target = targets.find(unit => unit.unitId === draft.unitId);
  const maxBodyBytes = view?.messageLimits.maxBodyBytes, bytes = new TextEncoder().encode(draft.body).length;
  const tooLarge = maxBodyBytes !== undefined && bytes > maxBodyBytes;
  const active = !!view && current && writable && teamGuidanceActive(status, view), scope = { ...context, area: "ai" as const };
  const draftPayload = (): AiTeamGuidanceCommandPayload => ({ kind: "ai-team-guidance", planId, editSeq: draft.editSeq, messageId: null });
  const pendingPayload = (): AiTeamGuidanceCommandPayload | undefined => pending ? { kind: "ai-team-guidance", planId, editSeq: pending.editSeq, messageId: pending.request.message.messageId } : undefined;
  const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
  function sendAvailable(payload?: AiTeamGuidanceCommandPayload): CommandAvailability {
    return open && active && session.canMutate() && !state.creating && !pending && !!member && !!target && !!draft.body.trim() && !tooLarge
      && jsonIdentity(payload) === jsonIdentity(draftPayload()) ? { enabled: true } : unavailable;
  }
  function checkAvailable(payload?: AiTeamGuidanceCommandPayload): CommandAvailability {
    return open && pending?.phase === "unknown" && jsonIdentity(payload) === jsonIdentity(pendingPayload()) ? { enabled: true } : unavailable;
  }
  function retryAvailable(payload?: AiTeamGuidanceCommandPayload): CommandAvailability {
    return checkAvailable(payload).enabled && session.retryAllowed(planId) ? { enabled: true } : unavailable;
  }
  useLayoutEffect(() => {
    const metadata = { category: "ai" as const, scope, binding: null, confirmation: "none" as const, payloadKind: "ai-team-guidance" as const };
    const remove = [registry.register({ ...metadata, id: "ai.team-guidance.send", nameKey: "ai.guidance.send", risk: "writes-execution", availability: sendAvailable,
      handler: value => { if (view) void session.send(status, view, active, value.editSeq); } }),
    registry.register({ ...metadata, id: "ai.team-guidance.check", nameKey: "ai.guidance.check", risk: "reads-execution", availability: checkAvailable,
      handler: () => { void session.check(planId); } }),
    registry.register({ ...metadata, id: "ai.team-guidance.retry", nameKey: "ai.guidance.retry", risk: "retries-execution-action", availability: retryAvailable,
      handler: () => { void session.retry(planId); } })];
    return () => remove.forEach(dispose => dispose());
  });
  return <section aria-label={t("ai.guidance.title")}>
    <h4>{t("ai.guidance.title")}</h4><p>{t("ai.guidance.help")}</p>
    {!active || !session.canMutate() ? <p role="status">{t("ai.guidance.unavailable")}</p> : null}
    <form onSubmit={event => { event.preventDefault(); registry.dispatch("ai.team-guidance.send", scope, draftPayload()); }}>
      <label className="field">{t("ai.guidance.recipient")}<select value={draft.memberId} onChange={event => session.edit(planId, { memberId: event.target.value, unitId: "" })}>
        <option value="">{t("ai.guidance.chooseRecipient")}</option>
        {draft.memberId && !member ? <option value={draft.memberId}>{t("ai.guidance.previousRecipient")}</option> : null}
        {view?.roster.map(value => <option key={value.memberId} value={value.memberId}>{value.displayName}</option>)}
      </select></label>
      {member ? <><pre className="ai-text">{member.role}</pre><p>{t("ai.discussions.destination", { endpoint: member.config.endpoint, model: member.config.model })}</p></> : null}
      <label className="field">{t("ai.guidance.target")}<select value={draft.unitId} onChange={event => session.edit(planId, { unitId: event.target.value })}>
        <option value="">{t("ai.guidance.chooseTarget")}</option>
        {draft.unitId && !target ? <option value={draft.unitId}>{t("ai.guidance.previousTarget")}</option> : null}
        {targets.map(unit => <option key={unit.unitId} value={unit.unitId}>{unit.nativeKey} · {status.plan.locale}</option>)}
      </select></label>
      <label className="field">{t("ai.guidance.body")}<textarea value={draft.body} aria-describedby={helpId} aria-invalid={tooLarge || undefined}
        onChange={event => session.edit(planId, { body: event.target.value })}/></label>
      <p id={helpId}>{tooLarge ? t("ai.guidance.tooLarge") : maxBodyBytes === undefined ? t("ai.guidance.limitsUnavailable")
        : t("ai.guidance.limit", { bytes: maxBodyBytes, defaultValue: enUS.ai.guidance.limit })}</p>
      {member && target ? <p>{t("ai.guidance.share", { member: member.displayName, entry: target.nativeKey, locale: status.plan.locale, endpoint: member.config.endpoint, model: member.config.model })}</p> : null}
      <button type="submit" className="primary-button" disabled={!sendAvailable(draftPayload()).enabled}>{t("ai.guidance.send")}</button>
    </form>
    {state.creating || pending?.phase === "sending" || pending?.phase === "checking" ? <p role="status">{t("ai.guidance.pending")}</p> : null}
    {pending?.phase === "unknown" ? <div><p role="status">{t("ai.guidance.unknown")}</p>
      <details><summary>{t("ai.guidance.original")}</summary><p>{pending.destination.name}</p><pre className="ai-text">{pending.destination.role}</pre>
        <p>{t("ai.discussions.destination", { endpoint: pending.destination.endpoint, model: pending.destination.model })}</p>
        <p>{status.plan.scope.find(unit => unit.unitId === pending.request.message.target.unitId)?.nativeKey} · {pending.request.message.target.locale}</p>
        <pre className="ai-text">{pending.request.message.body}</pre></details>
      <button type="button" className="secondary-button" disabled={!checkAvailable(pendingPayload()).enabled} onClick={() => { const payload = pendingPayload(); if (payload) registry.dispatch("ai.team-guidance.check", scope, payload); }}>{t("ai.guidance.check")}</button>
      <button type="button" className="secondary-button" disabled={!retryAvailable(pendingPayload()).enabled} onClick={() => { const payload = pendingPayload(); if (payload) registry.dispatch("ai.team-guidance.retry", scope, payload); }}>{t("ai.guidance.retry")}</button>
    </div> : null}
    {state.failure ? <div role="alert" tabIndex={-1} ref={errorRef}><p>{t("ai.guidance.failed")}</p><CommandFailureDetails failure={state.failure}/></div> : null}
    {state.notice ? <p role="status">{t(`ai.guidance.${state.notice}`)}</p> : null}
  </section>;
}
