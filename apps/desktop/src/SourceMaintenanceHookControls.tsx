import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails } from "./CommandFailure";
import { useSourceDraftSession } from "./SourceDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { sourceHookKey } from "./SourceMaintenanceHook";
import type { SourceMaintenanceHookObservation } from "./sourceMaintenanceHookCommands";
import type { ProjectView } from "./projectCommands";

export function SourceMaintenanceHookChoice({ project, disabled }: { project: ProjectView; disabled: boolean }) {
  const { t, i18n } = useTranslation(), owner = useSourceDraftSession().hook, { state } = owner;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!state.enabled || !state.activation) return;
    const timer = window.setTimeout(() => { setNow(Date.now()); owner.refreshDeadline(); }, Math.max(1, state.activation.expiresAtMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.enabled, state.activation]);
  const expired = !!state.activation && state.activation.expiresAtMs <= now;
  return <fieldset disabled={disabled}>
    <legend>{t("sourceHook.choiceTitle")}</legend><p>{t("sourceHook.choiceHelp")}</p>
    <label className="source-field">{t("sourceHook.locale")}<select value={state.locale} onChange={event => owner.editLocale(event.target.value)}>
      <option value="">{t("sourceHook.chooseLocale")}</option>
      {state.locale && !project.metadata.targetLocales.includes(state.locale) ? <option value={state.locale} disabled>{state.locale}</option> : null}
      {project.metadata.targetLocales.map(locale => <option key={locale} value={locale}>{locale}</option>)}
    </select></label>
    <label className="source-check"><input type="checkbox" checked={state.enabled} disabled={!project.metadata.targetLocales.includes(state.locale)}
      onChange={event => { void owner.enable(event.target.checked); }} />{t("sourceHook.consent")}</label>
    {state.preparing ? <p role="status">{t("sourceHook.preparing")}</p> : null}
    {state.activation ? <p>{t("sourceHook.expiry", { expiry: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "medium" }).format(state.activation.expiresAtMs) })}</p> : null}
    {state.preparationFailure ? <div role="alert"><p>{t("sourceHook.prepareFailed")}</p><CommandFailureDetails failure={state.preparationFailure} /></div> : null}
    {expired ? <p role="alert">{t("sourceHook.expiredChoice")}</p> : null}
    {state.enabled && (state.preparing || state.preparationFailure || expired) ? <button type="button" className="secondary-button"
      onClick={() => { void owner.enable(true); }}>{t(state.preparing ? "sourceHook.retryDeclarationWait" : "sourceHook.reconfirm")}</button> : null}
  </fieldset>;
}

export function SourceMaintenanceHookStatus({ active, onOpenMaintenance }: { active: boolean;
  onOpenMaintenance?: (sourceActionId: string, sourceEditSeq: number) => Promise<boolean> }) {
  const { t } = useTranslation(), source = useSourceDraftSession(), owner = source.hook, { state } = owner, reads = useSessionReads();
  const [visible, setVisible] = useState(document.visibilityState !== "hidden"), heading = useRef<HTMLHeadingElement>(null), pollCount = useRef(0);
  const id = state.sourceActionId;
  const snapshot = useCallback(() => id ? reads.client.getQueryData<SourceMaintenanceHookObservation>(reads.key(sourceHookKey(id))) : undefined, [reads, id]);
  const subscribe = useCallback((notify: () => void) => reads.client.getQueryCache().subscribe(notify), [reads]);
  const observation = useSyncExternalStore(subscribe, snapshot), view = observation?.view;
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== "hidden"); document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed); }, []);
  useEffect(() => { if (active && id && observation === undefined && !state.readFailure) void owner.read(); }, [active, id]);
  useEffect(() => { pollCount.current = 0; }, [id]);
  useEffect(() => {
    if (!active || !visible || !id || state.reading || state.readFailure || observation?.error || reads.retired || pollCount.current >= 360
      || !(view?.phase === "pending" || view?.phase === "running" || state.closed && !state.drained)) return;
    const timer = window.setTimeout(() => { pollCount.current++; void owner.read(); }, 1000); return () => window.clearTimeout(timer);
  }, [active, visible, id, state.reading, state.readFailure, state.closed, state.drained, view?.phase, observation?.error, reads]);
  useEffect(() => { if (active && id) heading.current?.focus({ preventScroll: true }); }, [active, id]);
  if (!id) return null;
  return <section aria-labelledby="source-hook-status-heading">
    <h3 id="source-hook-status-heading" tabIndex={-1} ref={heading}>{t("sourceHook.statusTitle")}</h3>
    <p>{t("sourceHook.separateOutcome")}</p><p>{t("sourceHook.coverage")}</p>
    {state.reading ? <p role="status">{t("sourceHook.reading")}</p> : null}
    {state.readFailure ? <div role="alert"><p>{t("sourceHook.readFailed")}</p><CommandFailureDetails failure={state.readFailure} /></div> : null}
    {observation ? <p role="status">{t(`sourceHook.readStates.${observation.state}`)}</p> : null}
    {observation?.error ? <div role="alert"><p>{t("sourceHook.observationFailed")}</p><CommandFailureDetails failure={observation.error} /></div> : null}
    {view ? <><p role="status">{t("sourceHook.phase", { phase: t(`sourceHook.phases.${view.phase}`), locale: view.activation.locale })}</p>
      {view.outcome?.assessment ? <p>{t("sourceHook.observedCount", { count: view.outcome.assessment.rows.length })}</p> : null}
      {view.outcome?.error ? <div role="alert"><p>{t("sourceHook.observationFailed")}</p><details><summary>{t("execution.diagnostic")}</summary><p>{view.outcome.error.code} · {view.outcome.error.stage}</p></details></div> : null}
      {view.cause ? <details><summary>{t("sourceHook.cause")}</summary><p>{view.cause.sourceActionId}</p><p>{view.cause.sourceSnapshotId} · {view.cause.contentRevision}</p>
        <p>{view.cause.attemptId} · {view.cause.resultId}</p><code>{view.cause.resultDigest}</code></details> : null}
    </> : null}
    {state.stopping ? <p role="status">{t("sourceHook.stopping")}</p> : null}
    {state.stop?.unknown ? <p role="status">{t("sourceHook.stopUnknown")}</p> : null}
    {state.stop?.notKnown ? <p role="status">{t("sourceHook.stopNotKnown")}</p> : null}
    {state.waitEnded ? <p role="status">{t("sourceHook.waitEnded")}</p> : null}
    {state.stopFailure ? <div role="alert"><p>{t("sourceHook.stopFailed")}</p><CommandFailureDetails failure={state.stopFailure} /></div> : null}
    {state.closed ? <p role="status">{t(state.drained ? "sourceHook.closed" : "sourceHook.draining")}</p> : null}
    <div className="execution-actions">
      <button type="button" className="secondary-button" onClick={() => { void (state.reading ? owner.retryRead() : owner.read()); }}>{t(state.reading ? "sourceHook.replaceReadWait" : "sourceHook.read")}</button>
      <button type="button" className="secondary-button" disabled={!owner.canStop()}
        onClick={() => { void (state.stopping ? owner.retryStop() : owner.stop()); }}>{t(state.stopping ? "sourceHook.replaceStopWait" : state.stop?.unknown || state.stop?.notKnown ? "sourceHook.retryStop" : "sourceHook.stop")}</button>
      {owner.canEndWait() ? <button type="button" className="secondary-button" onClick={() => owner.endWait()}>{t("sourceHook.endWait")}</button> : null}
      {onOpenMaintenance ? <button type="button" className="secondary-button" disabled={!view?.outcome?.assessment || view.phase !== "observed" || source.hasPending() || source.inFlight() || state.reading || !!state.readFailure}
        onClick={() => { if (view?.outcome?.assessment && view.phase === "observed") void onOpenMaintenance(id, source.current().editSeq); }}>{t("sourceHook.openImpact")}</button> : null}
    </div><p>{t("sourceHook.waitHelp")}</p>
  </section>;
}
