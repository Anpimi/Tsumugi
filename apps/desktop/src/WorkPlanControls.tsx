import { useEffect, useState } from "react";
import { PluginPermissions } from "./PluginManager";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { useTranslation } from "react-i18next";
import { aiCommands } from "./aiCommands";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome } from "./projectCommands";
import type { WorkPlanAuthorizeRequest, WorkPlanControlRequest, WorkPlanStartRequest, AutomationEffect } from "./generated/ai.requests";
import { workPlanCommands, type WorkPlanView, type WorkPlanReceiptView, type WorkPlanStatusView, type WorkPlanCommand } from "./workPlanCommands";
import type { EditorTarget } from "./TranslationWorkbench";

type Pending = { kind: "authorize"; request: WorkPlanAuthorizeRequest }
  | { kind: "control"; request: WorkPlanControlRequest }
  | { kind: "start"; request: WorkPlanStartRequest; attemptId: string };

export function WorkPlanControls({ context, prepared, status, busy, disabled, consent, refresh,
  run, onPlan, onStarted, onBlockedChange, onOpenTranslation }: {
  context: SessionRequest;
  prepared: WorkPlanView | null;
  status: WorkPlanStatusView | null;
  busy: boolean;
  disabled: boolean;
  consent: boolean;
  refresh: (planId: string, current: () => boolean) => Promise<WorkPlanStatusView>;
  run: (work: (current: () => boolean) => Promise<void>) => Promise<void>;
  onPlan: (id: string) => void;
  onStarted: (id: string, planId: string) => void;
  onBlockedChange: (blocked: boolean) => void;
  onOpenTranslation: (target: EditorTarget, locale: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [minutes, setMinutes] = useState(60);
  const [renewConsent, setRenewConsent] = useState(false);
  const [checkerConsent, setCheckerConsent] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [ready, setReady] = useState<WorkPlanReceiptView | null>(null);
  const [missing, setMissing] = useState(false);
  // This synchronizes the enclosing workbench's navigation guard, not query facts.
  useEffect(() => { onBlockedChange(Boolean(pending || ready)); }, [pending, ready, onBlockedChange]);
  const validMinutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const plan = status?.plan ?? prepared;
  const checkerRequired = Boolean(plan?.preview && plan.options.stages.some(choice => choice.stage === "checks" && choice.mode === "assisted"));
  const checkerKey = plan?.checker?.kind === "ready" ? JSON.stringify([context.sessionToken, context.projectId, plan.planId, plan.digest, status?.lease.generation ?? "prepared", plan.checker.plugin]) : null;
  const checkerConfirmed = !checkerRequired || (checkerKey !== null && checkerConsent === checkerKey);
  const blocked = busy || disabled || Boolean(pending);

  function expiry() {
    if (!validMinutes) throw { reason: "work-plan-expiry", outcome: "rejected" };
    return (BigInt(Math.floor(Date.now() / 1000)) + BigInt(minutes * 60)).toString();
  }

  async function accept(receipt: WorkPlanReceiptView, current: () => boolean) {
    if (!current()) return false;
    onPlan(receipt.lease.planId);
    const latest = await refresh(receipt.lease.planId, current);
    if (!current()) return false;
    // A replayed receipt is historical. It must never restore older authority.
    const mayStart = latest.state === "active" && receipt.attemptId !== null
      && latest.lease.generation === receipt.lease.generation;
    setPending(null); setMissing(false); setReady(mayStart ? receipt : null); setRenewConsent(false);
    return mayStart;
  }

  async function start(receipt: WorkPlanReceiptView, current: () => boolean) {
    if (!receipt.attemptId) return;
    const request = { ...context, planId: receipt.lease.planId, actionId: receipt.actionId,
      expectedGeneration: receipt.lease.generation };
    setPending({ kind: "start", request, attemptId: receipt.attemptId });
    try {
      const id = await workPlanCommands.start(request, receipt.attemptId);
      if (current()) { setReady(null); setPending(null); onStarted(id, receipt.lease.planId); }
    } catch (error) {
      if (current() && !hasUnknownOutcome(error)) setPending(null);
      throw error;
    }
  }

  async function mutate(action: Exclude<Pending, { kind: "start" }>, current: () => boolean, enqueue: boolean) {
    setPending(action); setMissing(false);
    let committed = false;
    try {
      const receipt = action.kind === "authorize"
        ? await workPlanCommands.authorize(action.request) : await workPlanCommands.control(action.request);
      committed = true;
      if (await accept(receipt, current) && enqueue) await start(receipt, current);
    } catch (error) {
      // Once the action has committed, a failed read must be reconciled using the
      // same receipt. A later start failure is handled by start's own pending state.
      if (current() && !committed && !hasUnknownOutcome(error)) setPending(null);
      throw error;
    }
  }

  async function control(command: WorkPlanCommand, current: () => boolean) {
    if (!status) return;
    const expiresAt = command === "continue" ? expiry() : null;
    const actionId = await executionCommands.identity(context);
    if (!current()) return;
    await mutate({ kind: "control", request: { ...context, planId: status.lease.planId, actionId,
      expectedGeneration: status.lease.generation, command, confirmed: command === "continue" && renewConsent,
      checkerExecution: command === "continue" && checkerRequired && checkerConfirmed,
      expiresAt } }, current, command === "continue");
  }

  async function reconcile(current: () => boolean) {
    if (!pending) return;
    if (pending.kind === "start") {
      // Reading the fixed attempt proves enqueue happened; it sends no provider request.
      await aiCommands.read({ ...context, attemptId: pending.attemptId });
      if (current()) { onStarted(pending.attemptId, pending.request.planId); setPending(null); setReady(null); }
      await refresh(pending.request.planId, current);
    } else {
      const receipt = await workPlanCommands.action({ ...context, actionId: pending.request.actionId });
      if (receipt) await accept(receipt, current);
      else if (current()) setMissing(true);
    }
  }

  const duration = <label className="field">{t("ai.plan.duration")}<input type="number" min={1} max={1440}
    aria-label={t("ai.plan.duration")}
    value={Number.isFinite(minutes) ? minutes : ""} disabled={blocked || Boolean(ready)}
    aria-invalid={!validMinutes || undefined} onChange={event => setMinutes(event.target.valueAsNumber)} />
    {!validMinutes ? <span className="field-error">{t("ai.errors.work-plan-expiry")}</span> : null}</label>;

  return <section aria-label={t("ai.plan.controls")}>
    {plan ? <>
      <h3>{t("ai.plan.title")}</h3>
      <ul>{plan.options.stages.map(choice => <li key={choice.stage}>{t(`ai.plan.stages.${choice.stage}`)}: {t(choice.stage === "checks" && choice.mode === "assisted" ? "ai.plan.mechanicalChecks" : `ai.plan.modes.${choice.mode}`)}</li>)}</ul>
      {plan.preview ? <p>{t(plan.options.selectionPolicy === "candidates-only" ? "ai.plan.candidatesOnly" : "ai.plan.checkedSelection")}</p> : null}
      {plan.preview ? <p>{t(`ai.plan.policies.${plan.options.selectionPolicy}`)}</p> : null}
      <details open={!plan.preview}><summary>{t("ai.plan.scope", { count: plan.scope.length, locale: plan.locale })}</summary>
        <ul>{plan.scope.map(unit => <li key={unit.unitId}>{unit.nativeKey} <button className="text-button"
          disabled={blocked || Boolean(ready)} onClick={() => onOpenTranslation({ unitId: unit.unitId,
            sourceRevisionId: unit.sourceRevisionId, key: unit.nativeKey, sourceText: plan.preview?.items.find(item => item.unitId === unit.unitId)?.sourceText ?? "" }, plan.locale)}>{t("ai.plan.edit")}</button></li>)}</ul>
      </details>
      {!plan.preview ? <p>{t("ai.plan.manualHelp")}</p> : null}
      {checkerRequired && plan.checker?.kind === "ready" ? <section aria-label={t("sourcePlugin.executionReview")}>
        <p>{t("review.qaRun")} · {plan.checker.plugin.checker.provider.plugin.id} {plan.checker.plugin.checker.provider.plugin.version}</p>
        <p>{t("sourcePlugin.runtimeDetails", { version: plan.checker.plugin.environment.toolVersion,
          system: plan.checker.plugin.environment.platform.operatingSystem, architecture: plan.checker.plugin.environment.platform.architecture })}</p>
        <PluginPermissions permissions={plan.checker.plugin.checker.declaration.permissions} />
        <p>{t("sourcePlugin.unsandboxed")}</p>
        {!status || status.state === "paused" || status.state === "taken-over" ? <label className="source-check">
          <input type="checkbox" checked={checkerKey !== null && checkerConsent === checkerKey} disabled={blocked || Boolean(ready)}
            onChange={event => setCheckerConsent(event.target.checked ? checkerKey : null)} />{t("ai.plan.checkerConsent")}
        </label> : null}
      </section> : checkerRequired ? <div role="alert"><p>{t("ai.plan.checkerUnavailable")}</p>
        {plan.checker?.kind === "unavailable" ? <CommandFailureDetails failure={commandFailure(plan.checker.error)} /> : null}</div> : null}
    </> : null}
    {prepared?.preview && !status && !ready && !pending ? <>
      {duration}
      <button className="primary-button" disabled={blocked || !consent || !checkerConfirmed || !validMinutes} onClick={() => void run(async current => {
        const expiresAt = expiry();
        const actionId = await executionCommands.identity(context);
        if (!current()) return;
        await mutate({ kind: "authorize", request: { ...context, planId: prepared.planId, digest: prepared.digest,
          actionId, confirmed: consent, checkerExecution: checkerRequired && checkerConfirmed, effects: (prepared.options.selectionPolicy === "candidates-only" ? ["save-candidate"] : ["save-candidate", "run-checks", prepared.options.selectionPolicy === "missing-only" ? "select-missing" : "replace-captured-selection"]) satisfies AutomationEffect[], expiresAt } }, current, true);
      })}>{t("ai.generate")}</button>
    </> : null}
    {status ? <>
      <p role="status">{t(`ai.plan.states.${status.state}`)}</p>
      <p>{t("ai.plan.expires", { time: new Date(Number(status.expiresAt) * 1000).toLocaleString(i18n.resolvedLanguage) })}</p>
      <p>{t("ai.plan.stopHelp")}</p>
      {status.state === "active" ? <button className="secondary-button" disabled={blocked}
        onClick={() => void run(current => control("pause", current))}>{t("ai.plan.pause")}</button> : null}
      {status.state !== "stopped" ? <>
        <button className="secondary-button" disabled={blocked} onClick={() => void run(current => control("stop", current))}>{t("ai.plan.stop")}</button>
        {status.state !== "taken-over" ? <button className="secondary-button" disabled={blocked}
          onClick={() => void run(current => control("take-over", current))}>{t("ai.plan.takeOver")}</button> : null}
      </> : null}
      {status.state === "paused" || status.state === "taken-over" ? <>
        <p>{t("ai.plan.continueHelp")}</p>{duration}
        <label className="source-check"><input type="checkbox" checked={renewConsent} disabled={blocked || Boolean(ready)}
          onChange={event => setRenewConsent(event.target.checked)} />{t("ai.plan.renewConsent")}</label>
        <button className="primary-button" disabled={blocked || Boolean(ready) || !renewConsent || !checkerConfirmed || !validMinutes}
          onClick={() => void run(current => control("continue", current))}>{t("ai.plan.continue")}</button>
      </> : null}
      <button className="secondary-button" disabled={blocked} onClick={() => void run(async current => {
        await refresh(status.lease.planId, current);
      })}>{t("ai.plan.refresh")}</button>
    </> : null}
    {ready && !pending ? <div role="status"><p>{t("ai.plan.ready")}</p><button className="primary-button" disabled={busy || disabled}
      onClick={() => void run(current => start(ready, current))}>{t("ai.plan.startAuthorized")}</button></div> : null}
    {pending ? <div role="status"><p>{t(busy ? "ai.plan.pending" : pending.kind === "start" ? "ai.startUnknown" : "ai.plan.actionUnknown")}</p>
      <button className="secondary-button" disabled={busy} onClick={() => void run(reconcile)}>{t("ai.reconcile")}</button>
      {missing || pending.kind === "start" ? <button className="secondary-button" disabled={busy || disabled}
        onClick={() => void run(async current => {
          if (pending.kind === "start") {
            const id = await workPlanCommands.start(pending.request, pending.attemptId);
            if (current()) { onStarted(id, pending.request.planId); setPending(null); setReady(null); }
          } else await mutate(pending, current, false);
        })}>{t("ai.retrySame")}</button> : null}
    </div> : null}
  </section>;
}
