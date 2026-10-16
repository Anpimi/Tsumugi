import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { useWorkbenchState } from "./WorkbenchFrame";
import { useSourceDraftSession } from "./SourceDraftSession";
import { useAiPreparation } from "./AiPreparationSession";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { sourceHookKey } from "./SourceMaintenanceHook";
import { sourceMaintenanceHookCommands } from "./sourceMaintenanceHookCommands";
import { executionContext } from "./executionCommands";
import { sourceReads } from "./sourceQueries";
import { workPlanCommands, type MaintenanceAssessment } from "./workPlanCommands";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import { reviewReasonKey } from "./reviewLabels";
import type { MaintenanceNoticeTarget } from "./sessionNavigation";
import type { ProjectView } from "./projectCommands";

/** The reference is navigation only. Both original owners authorize a handoff. */
export function MaintenanceNoticePanel({ project, active, disabled }: { project: ProjectView; active: boolean; disabled: boolean }) {
  const [target, setTarget] = useWorkbenchState<MaintenanceNoticeTarget | null>("ai", "maintenanceNotice", null);
  return target ? <Notice key={target.sourceActionId} project={project} active={active} disabled={disabled} target={target} close={() => setTarget(null)} /> : null;
}
function Notice({ project, active, disabled, target, close }: { project: ProjectView; active: boolean; disabled: boolean;
  target: MaintenanceNoticeTarget; close: () => void }) {
  const { t } = useTranslation(), reads = useSessionReads(), source = useSourceDraftSession(), ai = useAiPreparation(), context = executionContext(project);
  const heading = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLButtonElement | null>(null), returnHeading = useRef<HTMLElement | null>(null);
  const [replacement, setReplacement] = useState<{ assessment: MaintenanceAssessment; sourceSeq: number; aiSeq: number; dirty: boolean } | null>(null);
  const [blocked, setBlocked] = useState(false);
  const key = sourceHookKey(target.sourceActionId);
  const notice = useSessionQuery({ key, scopes: ["source", "execution"], enabled: active,
    read: () => sourceMaintenanceHookCommands.read({ ...context, sourceActionId: target.sourceActionId }) });
  const saved = notice.data?.view?.phase === "observed" ? notice.data.view.outcome?.assessment ?? null : null;
  const scopeOptions = sourceReads.scope(context), scope = useSessionQuery({ ...scopeOptions, enabled: active });
  const locale = saved?.locale ?? "", snapshot = scope.data?.currentSnapshot;
  const currentKey = ["maintenance-assessment", snapshot, locale, 0, 100];
  const assessment = useSessionQuery({ key: currentKey, scopes: ["project", "source", "translation", "resources", "review"],
    enabled: active && !!saved && !!snapshot && project.metadata.targetLocales.includes(locale),
    read: () => workPlanCommands.maintenance({ ...context, snapshotId: snapshot!, locale, after: 0, limit: 100 }) });
  useEffect(() => { if (active) { returnHeading.current = heading.current?.closest(".workbench-panel")?.querySelector<HTMLElement>("h1[tabindex]") ?? null;
    heading.current?.focus({ preventScroll: true }); } }, [active, target.sourceActionId]);
  function currentAssessment() {
    const fresh = (queryKey: readonly unknown[], data: unknown) => { const value = reads.client.getQueryState(reads.key(queryKey));
      return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated && value.error === null && value.data === data; };
    return active && !reads.retired && saved && fresh(key, notice.data) && fresh(scopeOptions.key, scope.data) && fresh(currentKey, assessment.data)
      && notice.data?.state === "adopted" && notice.data.view?.phase === "observed" && scope.data?.currentSnapshot === saved.sourceSnapshotId
      && assessment.data?.digest === saved.digest && assessment.data.locale === saved.locale && project.metadata.targetLocales.includes(saved.locale) ? assessment.data : null;
  }
  function sourceReady(expectedSeq: number) {
    const value = source.current();
    return value.editSeq === expectedSeq && !source.hasPending() && !source.inFlight() && !value.selection
      && Object.keys(value.lineage).length === 0 && value.actor.trim() === "" && !source.hook.hasDraft();
  }
  function canCapture(value: MaintenanceAssessment, sourceSeq: number, aiSeq: number, dirty: boolean) {
    return !disabled && sourceReady(sourceSeq) && sourceSeq === target.sourceEditSeq && aiSeq === target.aiEditSeq
      && ai.current().editSeq === aiSeq && ai.current().dirty === dirty && ai.canReceiveContentSelection() && currentAssessment() === value;
  }
  function returnFocus(closing = false) {
    const destination = !closing && trigger.current?.isConnected ? trigger.current : returnHeading.current;
    destination?.focus({ preventScroll: true });
  }
  function finish(value: MaintenanceAssessment, sourceSeq: number, aiSeq: number, dirty: boolean, confirmed: boolean) {
    const valid = () => canCapture(value, sourceSeq, aiSeq, dirty);
    if (!valid() || !ai.captureMaintenance(value, aiSeq, valid, { expectedDirty: dirty, confirmed })) { setBlocked(true); return; }
    setReplacement(null); trigger.current = null; returnFocus(true); close();
  }
  const current = currentAssessment(), dirty = ai.current().dirty;
  const ready = !!current && canCapture(current, source.current().editSeq, ai.current().editSeq, dirty);
  return <section aria-labelledby="maintenance-notice-heading">
    <h3 id="maintenance-notice-heading" ref={heading} tabIndex={-1}>{t("sourceHook.impactTitle")}</h3>
    <p>{t("sourceHook.impactHelp")}</p><p>{t("sourceHook.coverage")}</p>
    {notice.isFetching || scope.isFetching || assessment.isFetching ? <p role="status">{t("sourceHook.reading")}</p> : null}
    {notice.error || scope.error || assessment.error ? <div role="alert"><p>{t("sourceHook.currentFailed")}</p><CommandFailureDetails failure={commandFailure(notice.error ?? scope.error ?? assessment.error)} /></div> : null}
    {notice.data?.error ? <div role="alert"><p>{t("sourceHook.observationFailed")}</p><CommandFailureDetails failure={notice.data.error} /></div> : null}
    {saved && !current ? <p role="status">{t("sourceHook.staleImpact")}</p> : null}
    {!saved && !notice.isFetching ? <p role="status">{t("sourceHook.unknownImpact")}</p> : null}
    {blocked || saved && !ready ? <p role="status">{t("sourceHook.captureBlocked")}</p> : null}
    {saved ? <><p>{t("sourceHook.phase", { locale: saved.locale, phase: t("sourceHook.phases.observed") })}</p>
      <p>{t("sourceHook.observedCount", { count: saved.rows.length })}</p>
      {saved.rows.length === 0 ? <p>{t("ai.maintenance.empty")}</p> : null}
      {saved.rows.map(row => <article key={row.unitId}><h4>{row.nativeKey}</h4><pre>{row.sourceText}</pre><p>{row.translationText ?? t("review.missingTranslation")}</p>
        <ul>{row.reasons.map(reason => <li key={reason}>{t(reason === "source-changed" ? "ai.maintenance.sourceChanged" : reason === "correspondence-unresolved" ? "ai.maintenance.mapping" : reviewReasonKey(reason))}</li>)}</ul>
        {row.protection.protected ? <p>{t("ai.maintenance.protected")}</p> : null}</article>)}</> : null}
    <div className="execution-actions">
      <button type="button" className="secondary-button" disabled={disabled || notice.isFetching || scope.isFetching || assessment.isFetching}
        onClick={() => { setBlocked(false); void notice.refetch(); void scope.refetch(); if (saved && snapshot) void assessment.refetch(); }}>{t("sourceHook.currentImpact")}</button>
      <button type="button" disabled={!ready} onClick={event => { const value = currentAssessment(); if (!value) { setBlocked(true); return; }
        trigger.current = event.currentTarget; const sourceSeq = source.current().editSeq, aiSeq = ai.current().editSeq, dirty = ai.current().dirty;
        if (!canCapture(value, sourceSeq, aiSeq, dirty)) { setBlocked(true); return; }
        if (dirty) setReplacement({ assessment: value, sourceSeq, aiSeq, dirty }); else finish(value, sourceSeq, aiSeq, dirty, false);
      }}>{t(dirty ? "sourceHook.replaceDraft" : "sourceHook.createDraft")}</button>
      <button type="button" className="secondary-button" onClick={() => { trigger.current = null; returnFocus(true); close(); }}>{t("sourceHook.closeImpact")}</button>
    </div>
    <Dialog.Root open={replacement !== null} onOpenChange={open => { if (!open) setReplacement(null); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
        <Dialog.Title>{t("sourceHook.replaceTitle")}</Dialog.Title><Dialog.Description>{t("sourceHook.replaceHelp")}</Dialog.Description>
        {replacement && !canCapture(replacement.assessment, replacement.sourceSeq, replacement.aiSeq, replacement.dirty) ? <p role="alert">{t("sourceHook.captureBlocked")}</p> : null}
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setReplacement(null)}>{t("sourceHook.stay")}</button>
          <button type="button" disabled={!replacement || !canCapture(replacement.assessment, replacement.sourceSeq, replacement.aiSeq, replacement.dirty)}
            onClick={() => { if (replacement) finish(replacement.assessment, replacement.sourceSeq, replacement.aiSeq, replacement.dirty, true); }}>{t("sourceHook.replaceConfirm")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </section>;
}
