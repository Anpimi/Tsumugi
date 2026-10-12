import { reviewReasonKey } from "./reviewLabels";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "./projectCommands";
import { executionContext } from "./executionCommands";
import { reviewCommands } from "./reviewCommands";
import { sourceReads } from "./sourceQueries";
import { confirmReleaseDelivery, releaseCommands } from "./releaseCommands";
import { useReleaseDraftSession } from "./ReleaseDraftSession";
import { useSessionQuery } from "./SessionReadProvider";

const errorReasons = {
  "destination-conflict": "release.errorDestination", "dependency-conflict": "release.errorDependency",
  "invalid-input": "release.errorInput", "permission-denied": "release.errorPermission",
  "session-invalid": "release.errorSession", "limit-exceeded": "release.errorLimit", "outcome-unknown": "release.errorOutcomeUnknown",
} as const;
export interface ReleaseHandle { allowLeave: (current?: () => boolean) => Promise<boolean>; allowNavigate: () => Promise<boolean> }
export function ReleaseWorkbench({ project, disabled, ref, onOpenTranslation }: { project: ProjectView; disabled: boolean; ref?: Ref<ReleaseHandle>; onOpenTranslation?: (target: import("./TranslationWorkbench").EditorTarget, locale: string) => boolean | Promise<boolean> }) {
  const { t } = useTranslation(), session = executionContext(project), owner = useReleaseDraftSession();
  const [open, setOpen] = useWorkbenchView("release"), [leaving, setLeaving] = useState(false);
  const { languages, names, integration, eligibility, chosen, selection, preview, overwrite, attempt, result, pending, busy, exportMissing } = owner;
  const leaveProof = useRef<(() => boolean) | null>(null);
  const leaveResolve = useRef<((value: boolean) => void) | null>(null), errorRegion = useRef<HTMLDivElement>(null), mounted = useRef(false), viewVersion = useRef(0);
  const releasesRead = useSessionQuery({ key: ["release-list"], scopes: ["release", "execution"], enabled: open,
    read: () => releaseCommands.releases(session) });
  const integrationRead = useSessionQuery({ ...sourceReads.integration(session, "stardew-smapi"), enabled: open });
  const deliveriesRead = useSessionQuery({ key: ["release-deliveries", chosen?.releaseId], scopes: ["release"], enabled: open && !!chosen,
    read: async () => {
      const rows = await releaseCommands.deliveries({ ...session, releaseId: chosen!.releaseId });
      rows.forEach(row => confirmReleaseDelivery(row, row, chosen!.artifacts.map(file => ({ ...file, expectedSha256: file.sha256 }))));
      return rows;
    } });
  const releases = releasesRead.data ?? [], deliveries = deliveriesRead.data ?? [], historyError = !!deliveriesRead.error;
  const errorValue = owner.failure ?? (integrationRead.error || releasesRead.error ? commandFailure(integrationRead.error ?? releasesRead.error, "storage-failed") : null);
  const error = typeof errorValue === "string" ? errorValue : errorValue?.code ?? null;
  const vtt = integration?.id === "webvtt", locked = disabled || busy || !!pending;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; leaveResolve.current?.(false); }; }, []);
  useLayoutEffect(() => { viewVersion.current++; }, [open, project.sessionToken]);
  useEffect(() => { if (integrationRead.data) owner.observeIntegration(integrationRead.data); }, [integrationRead.data]);
  useEffect(() => { if (error || historyError) { errorRegion.current?.focus(); errorRegion.current?.scrollIntoView({ block: "nearest" }); } }, [error, historyError]);
  function allowLeave(current: () => boolean = () => true): Promise<boolean> {
    leaveProof.current = current;
    viewVersion.current++;
    if (owner.reserved()) { setOpen(true); owner.reportFailure("outcome-unknown"); return Promise.resolve(false); }
    if (!owner.current().buildDirty && !owner.current().deliveryDirty) return Promise.resolve(true);
    setOpen(true); setLeaving(true);
    return new Promise(resolve => { leaveResolve.current?.(false); leaveResolve.current = resolve; });
  }
  function settleLeave(value: boolean) {
    if (value && leaveProof.current && !leaveProof.current()) value = false;
    setLeaving(false);
    if (value && !owner.reset()) value = false;
    leaveResolve.current?.(value); leaveResolve.current = null; leaveProof.current = null;
  }
  // Ordinary workspace navigation keeps the project session owner alive.
  useImperativeHandle(ref, () => ({ allowLeave, allowNavigate: () => Promise.resolve(true) }));
  async function openBlocker(unitId: string, locale: string) {
    const ticket = ++viewVersion.current;
    try {
      const target = await reviewCommands.target({ ...session, unitId, locale });
      if (mounted.current && ticket === viewVersion.current) await onOpenTranslation?.({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, locale);
    } catch (failure) { if (mounted.current && ticket === viewVersion.current) owner.reportFailure(commandFailure(failure, "storage-failed")); }
  }
  const mappingReady = owner.available() && languages.every(locale => names[locale]?.trim());
  const hasConflict = preview?.files.some(file => file.state === "conflict") ?? false;
  return <><WorkbenchPanel open={open} title={t("release.title")} description={t(vtt ? "release.webvttDescription" : "release.description")} className="source-dialog release-dialog" onBack={() => setOpen(false)} backDisabled={disabled}>
      <div className="execution-content" aria-busy={busy}>
        {error || historyError ? <div className="release-alert" role="alert" ref={errorRegion} tabIndex={-1}>
          {error ? <p>{t("release.error", { reason: t(errorReasons[error as keyof typeof errorReasons] ?? "release.errorUnknown") })}</p> : null}
          <CommandFailureDetails failure={errorValue} />
          {integrationRead.isError || releasesRead.isError ? <button disabled={disabled || integrationRead.isFetching || releasesRead.isFetching} onClick={() => void Promise.all([integrationRead.refetch(), releasesRead.refetch()])}>{t("release.retryReads")}</button> : null}
          {historyError ? <><p>{t("release.historyFailed")}</p>{chosen ? <button disabled={disabled || deliveriesRead.isFetching} onClick={() => void deliveriesRead.refetch()}>{t("release.refreshDeliveries")}</button> : null}</> : null}
        </div> : null}
        {pending?.kind === "build" ? <section role="status"><p>{t(pending.retryAllowed ? "release.buildMissing" : "release.buildUnknown")}</p>
          <button disabled={disabled || busy} onClick={() => void owner.checkBuild()}>{t("release.checkBuild")}</button>
          {pending.retryAllowed ? <button disabled={disabled || busy} onClick={() => void owner.retryBuild()}>{t("release.retryBuild")}</button> : null}
        </section> : null}
        {pending && pending.kind !== "build" ? <section role="status"><p>{t("release.exportUnknown")}</p><button disabled={disabled || busy} onClick={() => void owner.checkExport()}>{t("release.checkExport")}</button><button disabled={disabled || busy} onClick={() => void owner.chooseFolder(true)}>{t("release.reauthorizeFolder")}</button>{pending.recoverySelection ? <p>{t("release.reauthorizationLimit")}</p> : null}</section> : null}
        {exportMissing ? <p role="status">{t("release.exportMissing")}</p> : null}
        <section><h3>{t("release.prepare")}</h3><p>{t(vtt ? "release.webvttScope" : "release.scope")}</p>
          <fieldset><legend>{t("release.languages")}</legend>{project.metadata.targetLocales.map(locale => <label key={locale} className="release-locale"><input type="checkbox" checked={languages.includes(locale)} disabled={disabled} onChange={event => owner.setLanguage(locale, event.target.checked)} />{locale}</label>)}</fieldset>
          {languages.map(locale => <label className="release-mapping" key={locale}>{t(vtt ? "release.webvttFileName" : "release.fileName", { locale })}<span>{vtt ? "" : "i18n/"}</span><input aria-label={t(vtt ? "release.webvttFileName" : "release.fileName", { locale })} value={names[locale] ?? ""} disabled={disabled || !integration} onChange={event => owner.setName(locale, event.target.value)} placeholder={vtt ? "zh-CN.vtt" : "zh.json"} /></label>)}
          {languages.filter(locale => !project.metadata.targetLocales.includes(locale)).map(locale => <p role="status" key={locale}>{t("release.removedLocale", { locale })} <button disabled={disabled} onClick={() => owner.setLanguage(locale, false)}>{t("release.removeLocale", { locale })}</button></p>)}
          {owner.stale ? <p role="status">{t("release.readinessStale")}</p> : null}
          {integrationRead.isPending ? <p role="status">{t("release.loading")}</p> : integration && !integration.available ? <p role="status">{t("release.integrationUnavailable")}</p> : null}
          <p>{t("release.policy")}</p>
          <div className="form-actions"><button className="secondary-button" disabled={locked || !mappingReady || !integration?.available || integrationRead.isError} onClick={() => void owner.assess()}>{t("release.check")}</button><button className="primary-button" disabled={locked || !mappingReady || !eligibility?.ready || !integration?.available || integrationRead.isError} onClick={() => void owner.build()}>{t("release.build")}</button></div>
          {eligibility ? <div role="status"><p>{t(eligibility.ready ? "release.ready" : "release.blocked", { count: eligibility.locales.reduce((sum, item) => sum + item.blockerCount, 0) })}</p><p>{t("release.source", { id: eligibility.sourceSnapshotId })} · {eligibility.policyVersion}</p>
            {eligibility.locales.map(item => <div key={item.locale}><strong>{item.locale}</strong>: {t("release.coverage", { count: item.checkedUnits })}{item.blockers.map((reason, index) => <div className="release-blocker" key={`${reason.unitId}:${index}`}>{reason.nativeKey}: {t(reviewReasonKey(reason.code))} {onOpenTranslation ? <button type="button" className="text-button" disabled={locked} onClick={() => void openBlocker(reason.unitId, item.locale)}>{t("translation.openEditor")}</button> : null}<details><summary>{t("execution.diagnostic")}</summary>{reason.code}</details></div>)}{item.exceptions.map((reason, index) => <p key={`exception:${reason.unitId}:${index}`}>{t("release.exception", { key: reason.nativeKey, reason: reason.code })}</p>)}</div>)}
          </div> : null}
          {attempt ? <p role="status">{t("release.started", { id: attempt })}</p> : null}{owner.earlierBuild ? <p role="status">{t("release.earlierBuild")}</p> : null}
        </section>
        <section><div className="execution-actions"><h3>{t("release.history")}</h3><button className="secondary-button" disabled={disabled || releasesRead.isFetching} onClick={() => void releasesRead.refetch()}>{t("release.refresh")}</button></div>
          {releasesRead.isPending ? <p>{t("release.loading")}</p> : releases.length === 0 ? releasesRead.isError ? null : <p>{t("release.empty")}</p> : <ul>{releases.map(item => <li key={item.releaseId}><button className="text-button" disabled={locked} onClick={() => owner.chooseRelease(item)}>{item.createdAt} · {item.artifacts.map(file => file.locale).join(", ")}</button></li>)}</ul>}
          {chosen ? <div><h4>{t("release.selected")}</h4><p>{t("release.source", { id: chosen.sourceSnapshotId })} · {chosen.policyVersion}</p><ul>{chosen.artifacts.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.locale} → {file.fileName} · {file.entryCount} · <code>{file.sha256}</code></li>)}</ul>
            <details><summary>{t("release.evidence")}</summary>
              <p>{t("release.manifestDigest", { digest: chosen.manifestSha256 })}</p>
              <p>{t("release.toolVersions", { builder: chosen.builderVersion, validator: chosen.validatorVersion })}</p>
              <p>{t("release.eligibilityBasis", { basis: chosen.eligibilityBasis })}</p>
              <ul>{chosen.sourceFiles.map(file => <li key={file.logicalPath}>{file.logicalPath} · <code>{file.sha256}</code></li>)}</ul>
              <h5>{t("release.exceptions")}</h5>{chosen.exceptions.length === 0 ? <p>{t("release.noExceptions")}</p> : <ul>{chosen.exceptions.map((item, index) => <li key={`${item.locale}:${item.nativeKey}:${index}`}>{item.locale} · {item.nativeKey} · {t(`release.exceptionKind.${item.kind}`)}</li>)}</ul>}
            </details>
            <div className="form-actions"><button className="secondary-button" disabled={locked} onClick={() => void owner.chooseFolder()}>{t("release.chooseFolder")}</button>{selection ? <button className="secondary-button" disabled={locked} onClick={() => void owner.previewFolder()}>{t("release.preview")}</button> : null}</div>
            {selection ? <p>{t("release.savedDestination", { name: selection.folderName })}</p> : null}
            {preview ? <div><h4>{t("release.previewTitle")}</h4><p>{t("release.savedDestination", { name: preview.folderName })}</p><ul>{preview.files.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.fileName} · {t(`release.fileState.${file.state}`)} · <code>{file.expectedSha256}</code></li>)}</ul>
              {hasConflict ? <label><input type="checkbox" checked={overwrite} disabled={locked} onChange={event => owner.setOverwrite(event.target.checked)} />{t("release.overwrite")}</label> : null}
              <div className="form-actions"><button className="primary-button" disabled={locked || (hasConflict && !overwrite)} onClick={() => void owner.exportFiles()}>{t("release.export")}</button></div></div> : null}
            {result ? <div role="status"><p>{t(`release.deliveryState.${result.state}`)}</p>{(result.state === "pending" || result.state === "unknown") && selection ? <button disabled={disabled || busy} onClick={() => void owner.reconcile(result)}>{t("release.checkPending")}</button> : null}</div> : null}
            <h4>{t("release.deliveries")}</h4>{deliveriesRead.isPending ? <p>{t("release.loading")}</p> : deliveries.length === 0 ? historyError ? null : <p>{t("release.noDeliveries")}</p> : <ul>{deliveries.map(delivery => <li key={delivery.deliveryId}>{delivery.createdAt} · {t(`release.deliveryState.${delivery.state}`)} · {delivery.directory} · {t(delivery.overwriteConflicts ? "release.overwriteAllowed" : "release.overwriteNotAllowed")}{(delivery.state === "pending" || delivery.state === "unknown") && selection && delivery.actionId !== result?.actionId ? <button className="secondary-button" disabled={locked} onClick={() => void owner.reconcile(delivery)}>{t("release.checkPending")}</button> : null}<ul>{delivery.files.map(file => <li key={`${file.locale}:${file.fileName}`}>{file.fileName}: {t(`release.deliveryState.${file.state}`)}{file.actualSha256 ? <> · <code>{file.actualSha256}</code></> : null}</li>)}</ul></li>)}</ul>}
          </div> : null}
        </section>
      </div>
    </WorkbenchPanel>
    <Dialog.Root open={leaving} onOpenChange={next => { if (!next) settleLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop"/><Dialog.Content className="confirm-dialog execution-confirm-dialog"><Dialog.Title>{t("release.unsaved")}</Dialog.Title><Dialog.Description>{t("release.unsavedHelp")}</Dialog.Description><button onClick={() => settleLeave(false)}>{t("release.stay")}</button><button onClick={() => settleLeave(true)}>{t("release.discard")}</button></Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
